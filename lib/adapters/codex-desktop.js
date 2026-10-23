/**
 * Codex Desktop adapter — talks to Codex through its **app-server** protocol.
 *
 * Codex Desktop (the ChatGPT app) embeds `codex app-server`, a JSON-RPC server
 * over stdio. Its threads are the same durable store the app shows, so a turn
 * started here persists into the desktop history, and an existing desktop
 * thread can be resumed by id and given another turn.
 *
 * Codex Desktop's Recents list is keyed to threads recorded with the desktop
 * originator ("Codex Desktop") plus a title. This adapter initializes with that
 * clientInfo name and names each new thread from its prompt, so turns created
 * through the bridge appear in the app like its own conversations (after the
 * app reloads its thread list).
 *
 * Protocol verified against `codex-cli 0.163.0-alpha.11.1` on 2026-10-23:
 *   initialize {clientInfo} -> server facts
 *   thread/start {cwd?, model?} -> {thread:{id}, model, modelProvider}
 *   thread/resume {threadId, excludeTurns?} -> thread
 *   turn/start {threadId, input:[{type:"text",text}], effort?, model?} -> {turn:{id}}
 *   notifications: item/completed {item:{type:"agentMessage",text}},
 *                  turn/completed {threadId, turn:{...}}
 * One JSON object per line on both pipes.
 *
 * @module @caelricluo/dsh-peer/adapters/codex-desktop
 */

import { spawn } from 'node:child_process'
import { BridgeError, REASONING_EFFORTS } from '../protocol.js'
import {
  abortedError,
  composePrompt,
  firstString,
  mergeTurnContext,
  resolveAdapterConfig,
  resolveTurnEffort,
  resolveTurnModel,
  runProcess,
  timeoutError,
  whichCommand,
} from './runner.js'

/** Harness id reported by this adapter. */
export const HARNESS = 'codex-desktop'

/** Default models shown in AdapterInfo until thread/start reports the real one. */
const DEFAULT_MODELS = Object.freeze(['gpt-6-astra'])

/**
 * Build the argv used to start the app-server child process.
 * @param {{extraArgs?: string[]}} [input] adapter config overrides
 * @returns {string[]} argv (command excluded)
 */
export function buildCodexDesktopArgs({ extraArgs } = {}) {
  return ['app-server', ...(Array.isArray(extraArgs) ? extraArgs.map(String) : [])]
}

/**
 * Parse one line of the app-server stream.
 * @param {string} line raw line
 * @returns {any|null} parsed JSON-RPC object or null for non-JSON lines
 */
export function parseAppServerLine(line) {
  const text = String(line ?? '').trim()
  if (text === '' || text[0] !== '{') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Extract the assistant text carried by one `item/completed` notification.
 * @param {any} notification parsed notification
 * @returns {string} agent message text, or ''
 */
export function agentTextFromNotification(notification) {
  if (notification?.method !== 'item/completed') return ''
  const item = notification.params?.item
  if (item?.type !== 'agentMessage') return ''
  return typeof item.text === 'string' ? item.text : ''
}

/**
 * Create the Codex Desktop adapter.
 * @param {{config?: Record<string, any>, logger?: any}} [deps] adapter deps
 * @returns {{harness: string, describe: Function, openThread: Function, runTurn: Function, closeThread: Function}}
 */
export function createCodexDesktopAdapter({ config, logger } = {}) {
  const cfg = resolveAdapterConfig(config, HARNESS, { command: 'codex' })
  let probePromise = null

  /** Probe once: binary present plus its version string. */
  function probe() {
    if (!probePromise) {
      probePromise = (async () => {
        const commandPath = await whichCommand(cfg.command)
        if (!commandPath) return { found: false, path: null, version: null }
        let version = null
        try {
          const outcome = await runProcess({ command: commandPath, args: ['--version'], input: '', timeoutMs: cfg.versionProbeTimeoutMs })
          const match = (outcome.stdout + '\n' + outcome.stderr).match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
          if (match) version = match[0]
        } catch {
          /* version is diagnostic only */
        }
        return { found: true, path: commandPath, version }
      })().catch((error) => {
        probePromise = null
        logger?.debug?.('dsh-peer: codex-desktop probe failed: ' + (error?.message ?? error))
        return { found: false, path: null, version: null }
      })
    }
    return probePromise
  }

  return {
    harness: HARNESS,

    /** @returns {Promise<Record<string, any>>} AdapterInfo; never throws */
    async describe() {
      try {
        const cli = await probe()
        const info = {
          harness: HARNESS,
          available: cli.found,
          models: cfg.models ?? [...DEFAULT_MODELS],
          defaultModel: cfg.defaultModel || null,
          reasoningEfforts: [...REASONING_EFFORTS],
          defaultReasoningEffort: cfg.defaultEffort || null,
          context: {
            cwd: true,
            systemPrompt: true,
            appendSystemPrompt: true,
            files: true,
            resume: true,
            addDirs: false,
          },
          notes: 'Codex app-server protocol (same thread store and originator as Codex Desktop); a resumed thread id is an app-server thread id',
        }
        if (cli.path) info.command = cli.path
        if (cli.version) info.version = cli.version
        if (!cli.found) {
          info.notes = 'codex CLI not found (looked for "' + cfg.command + '"); install Codex or set config.adapters["codex-desktop"].command'
        }
        return info
      } catch (error) {
        return { harness: HARNESS, available: false, notes: 'codex-desktop probe failed: ' + (error?.message ?? String(error)) }
      }
    },

    /** The app-server creates or resumes the thread inside runTurn. */
    async openThread() {},

    /**
     * Run one turn through a fresh `codex app-server` child.
     * @param {{thread?: any, userText?: string, message?: any, context?: any,
     *          signal?: AbortSignal, onDelta?: Function}} input turn input
     * @returns {Promise<{text: string, meta: Record<string, any>, remoteSessionId: string}>}
     */
    async runTurn(input = {}) {
      const started = Date.now()
      const { thread = {}, message, context: callContext, signal } = input
      if (signal?.aborted) throw abortedError()
      const context = mergeTurnContext(thread.context, message?.context, callContext)
      const userText = typeof input.userText === 'string' ? input.userText : typeof message?.text === 'string' ? message.text : ''
      const model = resolveTurnModel({ thread, message, context, fallback: cfg.defaultModel })
      const effort = resolveTurnEffort({ thread, message, context, fallback: cfg.defaultEffort })
      const resumeId = firstString(context.resume, thread.remoteSessionId)
      const cli = await probe()
      if (!cli.found || !cli.path) {
        throw new BridgeError(
          'adapter-unavailable',
          'codex CLI is not available (looked for "' + cfg.command + '"); install Codex or set config.adapters["codex-desktop"].command',
          { command: cfg.command },
        )
      }
      const prompt = await composePrompt({ text: userText, context: { files: context.files, cwd: context.cwd } })
      const client = await startClient(cli.path, cfg, context.cwd, logger)
      try {
        let threadId = resumeId
        let route = null
        if (resumeId) {
          await client.request('thread/resume', { threadId: resumeId, excludeTurns: true }, { timeoutMs: cfg.turnTimeoutMs })
        } else {
          const startedThread = await client.request('thread/start', {
            cwd: context.cwd ?? undefined,
            model: model ?? undefined,
          }, { timeoutMs: cfg.turnTimeoutMs })
          threadId = startedThread?.thread?.id
          route = { model: startedThread?.model, provider: startedThread?.modelProvider }
          if (typeof threadId !== 'string' || threadId === '') {
            throw new BridgeError('adapter-failed', 'codex app-server thread/start returned no thread id')
          }
          // Name the thread so Codex Desktop's Recents entry is readable.
          try {
            await client.request('thread/name/set', { threadId, name: threadTitle(prompt) }, { timeoutMs: 10000 })
          } catch (error) {
            logger?.debug?.('dsh-peer: codex-desktop thread/name/set failed (non-fatal): ' + (error?.message ?? error))
          }
        }
        const outcome = await client.runTurn({
          threadId,
          text: prompt,
          model: model ?? undefined,
          effort: effort ?? undefined,
          timeoutMs: cfg.turnTimeoutMs,
          signal,
        })
        if (signal?.aborted) throw abortedError()
        return {
          text: outcome.text,
          meta: {
            model: route?.model ?? model ?? null,
            reasoning_effort: effort ?? null,
            provider: route?.provider ?? null,
            durationMs: Date.now() - started,
            sessionId: threadId,
            turnId: outcome.turnId,
            usage: outcome.usage ?? null,
            truncated: false,
          },
          remoteSessionId: threadId,
        }
      } finally {
        await client.close()
      }
    },

    /** Each turn owns its app-server child; nothing to tear down. */
    async closeThread() {},
  }
}

/**
 * Start one app-server child and complete the initialize handshake.
 * @param {string} command resolved codex binary
 * @param {any} cfg adapter config
 * @param {string|undefined} cwd working directory for the child
 * @param {any} logger logger facade
 * @returns {Promise<any>} client
 */
async function startClient(command, cfg, cwd, logger) {
  let child
  try {
    child = spawn(command, buildCodexDesktopArgs({ extraArgs: cfg.extraArgs }), {
      cwd: firstString(cwd) ?? undefined,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
  } catch (error) {
    throw new BridgeError('adapter-unavailable', 'could not start codex app-server: ' + (error?.message ?? String(error)))
  }
  const client = createClient(child, logger)
  await client.initialize({
    clientInfo: {
      // Codex Desktop records its threads with this originator; using the same
      // value is what lets them appear in the app's Recents list.
      name: firstString(cfg.originator) ?? 'Codex Desktop',
      title: 'Codex Desktop',
      version: firstString(cfg.clientVersion) ?? '0.1.0',
    },
  }, cfg.versionProbeTimeoutMs)
  return client
}

/** @param {string} prompt full prompt @returns {string} short thread title */
function threadTitle(prompt) {
  const firstLine = String(prompt ?? '').split(String.fromCharCode(10)).find((candidate) => candidate.trim() !== '') ?? 'dsh-peer turn'
  const text = firstLine.trim()
  return text.length > 80 ? text.slice(0, 77) + '...' : text
}

/**
 * Minimal JSON-RPC client over the app-server stdio pipes.
 * @param {import('node:child_process').ChildProcess} child app-server process
 * @param {any} logger logger facade
 * @returns {any} client
 */
function createClient(child, logger) {
  let buffer = ''
  let nextId = 1
  let closed = false
  let exitInfo = null
  let stderrTail = ''
  const pending = new Map()
  const listeners = new Set()
  const exitWaiters = new Set()

  const rejectAll = (error) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  const onLine = (line) => {
    const message = parseAppServerLine(line)
    if (message === null) return
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new BridgeError('adapter-failed', 'codex app-server error: ' + JSON.stringify(message.error).slice(0, 400)))
      else entry.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method !== undefined) {
      // Server-to-client request (approval, user input). This client does not
      // implement them: fail it explicitly so the turn errors instead of hanging.
      logger?.warn?.('dsh-peer: codex-desktop does not implement server request "' + message.method + '"; rejecting it')
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'client method not implemented by dsh-peer' } })
      return
    }
    for (const listener of listeners) {
      try {
        listener(message)
      } catch {
        /* a listener must not break parsing */
      }
    }
  }

  if (child.stdout) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        onLine(line)
      }
    })
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000)
      logger?.debug?.('dsh-peer: codex app-server stderr: ' + String(chunk).trim())
    })
  }
  child.on('error', (error) => {
    exitInfo = { code: null, signal: null, message: error?.message ?? String(error) }
    rejectAll(new BridgeError('adapter-failed', 'codex app-server process error: ' + exitInfo.message))
  })
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal, message: null }
    rejectAll(new BridgeError('adapter-failed', 'codex app-server exited (code ' + String(code) + (stderrTail ? '): ' + stderrTail.trim().slice(0, 300) : ')')))
    for (const waiter of exitWaiters) waiter(exitInfo)
    exitWaiters.clear()
  })

  function send(payload) {
    if (closed) return
    try {
      child.stdin.write(JSON.stringify(payload) + '\n')
    } catch (error) {
      throw new BridgeError('adapter-failed', 'could not write to codex app-server: ' + (error?.message ?? String(error)))
    }
  }

  function request(method, params, options = {}) {
    const id = nextId++
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120000
    const signal = options.signal
    if (signal?.aborted) throw abortedError()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(timeoutError('codex app-server ' + method + ' timed out after ' + timeoutMs + 'ms'))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      const onAbort = () => {
        pending.delete(id)
        clearTimeout(timer)
        reject(abortedError())
        close()
      }
      if (signal?.addEventListener) signal.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        resolve: (value) => {
          if (signal?.removeEventListener) signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          if (signal?.removeEventListener) signal.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      send({ jsonrpc: '2.0', id, method, params })
    })
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params })
  }

  async function initialize(input = {}, timeoutMs) {
    const clientInfo = input.clientInfo ?? { name: 'dsh-peer', title: 'DeepSeek Harness peer bridge', version: '0.1.0' }
    await request('initialize', { clientInfo }, { timeoutMs: timeoutMs || 15000 })
    notify('initialized', {})
  }

  /**
   * Start one turn and wait for the matching turn/completed notification.
   * @param {{threadId: string, text: string, model?: string, effort?: string,
   *          timeoutMs?: number, signal?: AbortSignal}} input turn input
   * @returns {Promise<{text: string, turnId: string|null, usage: any}>} outcome
   */
  function runTurn(input) {
    let text = ''
    let turnId = null
    let usage = null
    return new Promise((resolve, reject) => {
      const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 600000
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (signal?.removeEventListener) signal.removeEventListener('abort', onAbort)
        listeners.delete(listener)
        exitWaiters.delete(onExit)
        if (error) reject(error)
        else resolve(value)
      }
      const signal = input.signal
      if (signal?.aborted) {
        finish(abortedError())
        return
      }
      const onAbort = () => {
        try {
          send({ jsonrpc: '2.0', method: 'turn/interrupt', params: { threadId: input.threadId } })
        } catch {
          /* the child may already be gone */
        }
        finish(abortedError())
        close()
      }
      if (signal?.addEventListener) signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        finish(timeoutError('codex-desktop turn timed out after ' + timeoutMs + 'ms'))
        close()
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      const listener = (message) => {
        if (message.method === 'item/completed') {
          const next = agentTextFromNotification(message)
          if (next !== '') text = next
          return
        }
        if (message.method !== 'turn/completed') return
        const completed = message.params?.turn
        if (turnId !== null && completed?.id !== undefined && completed.id !== turnId) return
        usage = completed?.usage ?? message.params?.usage ?? null
        finish(null, { text, turnId, usage })
      }
      const onExit = (info) => finish(new BridgeError('adapter-failed', 'codex app-server exited before the turn completed' + (info?.message ? ': ' + info.message : '')))
      listeners.add(listener)
      exitWaiters.add(onExit)
      request('turn/start', {
        threadId: input.threadId,
        input: [{ type: 'text', text: input.text }],
        ...input.model === undefined ? {} : { model: input.model },
        ...input.effort === undefined ? {} : { effort: input.effort },
      }, { timeoutMs: Math.min(timeoutMs, 120000), signal })
        .then((response) => {
          turnId = response?.turn?.id ?? null
        })
        .catch((error) => finish(error))
    })
  }

  async function close() {
    if (closed) return
    closed = true
    rejectAll(new BridgeError('adapter-failed', 'codex app-server client closed'))
    try {
      child.stdin.end()
    } catch {
      /* ignore */
    }
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      child.once('exit', finish)
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        finish()
      }, 2000)
    })
  }

  return { initialize, request, notify, runTurn, close }
}
