/**
 * OpenAI Codex CLI adapter: one `codex exec --json` process per turn.
 *
 * The codex binary is optional at runtime and is not on PATH in the
 * environment this adapter was written in. Flag/stdin behavior and event tag
 * names were checked only against a local npm-global codex-cli 0.121.0
 * (`--version`/`--help`; no model turn was ever run); see docs/CODEX.md for
 * the exact argv, event shapes, evidence status and version caveats. Prompt
 * text always goes to stdin:
 *
 *   codex exec --json --skip-git-repo-check -C <cwd> [-m M]
 *         [-c model_reasoning_effort="E"] [...extraArgs]          < stdin
 *   codex exec resume --json [-m M] [-c ...] [...extraArgs] <sessionId> -
 *                                                                 < stdin
 *
 * `resume` only reads stdin when the PROMPT positional is `-`, hence the
 * trailing `-` on resumed turns. Reply text is the concatenation of
 * `agent_message` items and `thread.started.thread_id` is the resume id.
 *
 * @module @caelricluo/dsh-peer/adapters/codex
 */

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
export const HARNESS = 'codex'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Escape a value so it survives as a TOML string in `-c key=value`. */
function tomlString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * Build the argv for one codex turn (command excluded).
 *
 * Pure and deterministic. Pinned keys: `model`, `effort`, `cwd`, `resume`,
 * `extraArgs`; `reasoningEffort` and a `context` object (`cwd`/`resume`/
 * `model`/`reasoning_effort`) are accepted as aliases.
 * @param {{model?: string, effort?: string, reasoningEffort?: string, cwd?: string,
 *          resume?: string, extraArgs?: string[], context?: Record<string, any>}} [input]
 * @returns {string[]} argument vector (prompt is not included; it goes to stdin)
 */
export function buildCodexArgs(input = {}) {
  const { model, effort, reasoningEffort, cwd, resume, extraArgs } = input
  const context = isObject(input.context) ? input.context : {}
  const extras = Array.isArray(extraArgs) ? extraArgs.map(String) : []
  const modelId = firstString(model, context.model)
  const effortLevel = firstString(
    effort,
    reasoningEffort,
    context.reasoning_effort,
    context.reasoningEffort,
  )
  const resumeId = firstString(resume, context.resume, context.resumeSessionId)
  if (resumeId) {
    const args = ['exec', 'resume', '--json']
    if (modelId) args.push('-m', modelId)
    if (effortLevel) args.push('-c', 'model_reasoning_effort=' + tomlString(effortLevel))
    args.push(...extras)
    // Positionals last: session id, then '-' so the prompt is read from stdin.
    args.push(resumeId, '-')
    return args
  }
  const args = ['exec', '--json', '--skip-git-repo-check']
  const workingDirectory = firstString(cwd, context.cwd)
  if (workingDirectory) args.push('-C', workingDirectory)
  if (modelId) args.push('-m', modelId)
  if (effortLevel) args.push('-c', 'model_reasoning_effort=' + tomlString(effortLevel))
  args.push(...extras)
  return args
}

/** Fold a text-bearing value (string, content array, or object) into text. */
function collectText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join('')
  if (isObject(value)) {
    if (typeof value.text === 'string') return value.text
    if (typeof value.message === 'string') return value.message
    if (typeof value.content === 'string') return value.content
    if (value.content !== undefined) return collectText(value.content)
  }
  return ''
}

/**
 * Extract assistant text from one event, covering today's schema and legacy
 * shapes (see docs/CODEX.md).
 * @param {unknown} event parsed event
 * @returns {string} assistant text contributed by this event
 */
function assistantTextFromEvent(event) {
  if (!isObject(event)) return ''
  const type = typeof event.type === 'string' ? event.type : ''

  // Legacy 0.x shape: {"id":"1","msg":{"type":"agent_message","message":"..."}}
  if (isObject(event.msg)) {
    const innerType = typeof event.msg.type === 'string' ? event.msg.type : ''
    if (innerType === 'agent_message' || innerType === 'assistant_message') {
      return collectText(event.msg.message ?? event.msg.text ?? event.msg.content)
    }
  }

  // Current shape: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
  if (type === 'item.completed' && isObject(event.item)) {
    const itemType = typeof event.item.type === 'string' ? event.item.type : ''
    if (itemType === 'agent_message' || itemType === 'assistant_message') {
      return collectText(event.item.text ?? event.item.content ?? event.item.message)
    }
    // Tolerant: app-server style message items with an assistant role.
    if (itemType === 'message' && (event.item.role === undefined || event.item.role === 'assistant')) {
      return collectText(event.item.content ?? event.item.text ?? event.item.message)
    }
  }

  // Tolerant top-level variants used by some releases/wrappers.
  if (type === 'agent_message' || type === 'assistant_message') {
    return collectText(event.text ?? event.message ?? event.content ?? event.msg)
  }
  return ''
}

/** Extract a thread/session id carried by an event. */
function threadIdFromEvent(event) {
  if (!isObject(event)) return null
  const type = typeof event.type === 'string' ? event.type : ''
  if (
    type === 'thread.started' ||
    type === 'thread.created' ||
    type === 'session.created' ||
    type === 'session.started'
  ) {
    return (
      firstString(
        event.thread_id,
        event.threadId,
        event.session_id,
        event.sessionId,
        event.id,
        event.thread && isObject(event.thread) ? event.thread.id : undefined,
      ) ?? null
    )
  }
  if (isObject(event.msg) && (event.msg.type === 'session_configured' || event.msg.type === 'session_created')) {
    return firstString(event.msg.session_id, event.msg.sessionId, event.msg.id) ?? null
  }
  // Current versions also repeat thread_id on item/turn events.
  return firstString(event.thread_id, event.threadId) ?? null
}

/** Extract token usage carried by an event. */
function usageFromEvent(event) {
  if (!isObject(event)) return null
  if (isObject(event.usage)) return event.usage
  if (isObject(event.msg) && isObject(event.msg.usage)) return event.msg.usage
  if (isObject(event.info) && isObject(event.info.total_token_usage)) {
    return event.info.total_token_usage
  }
  if (isObject(event.msg) && isObject(event.msg.info) && isObject(event.msg.info.total_token_usage)) {
    return event.msg.info.total_token_usage
  }
  return null
}

/**
 * Find a failure reported in the event stream (turn.failed / error).
 * @param {Array<Record<string, any>>} events parsed events
 * @returns {string|null} failure message, or null
 */
function failureFromEvents(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isObject(event)) continue
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'turn.failed') {
      const message = firstString(event.error?.message, event.message, event.error)
      return message ?? 'codex reported a failed turn'
    }
    if (type === 'error') {
      const message = firstString(event.message, event.error?.message, event.error)
      return message ?? 'codex reported an error'
    }
    if (isObject(event.item) && event.item.type === 'error') {
      return firstString(event.item.message, event.item.text) ?? 'codex reported an error item'
    }
    if (isObject(event.msg) && event.msg.type === 'error') {
      return firstString(event.msg.message) ?? 'codex reported an error'
    }
  }
  return null
}

/**
 * Parse `codex exec --json` newline-delimited JSON.
 *
 * Tolerant by design (the Codex event schema evolves): every parsed object is
 * kept in `events`; assistant text is concatenated from current
 * `item.completed / item.type=agent_message` events, legacy
 * `msg.type=agent_message` events and a few plausible future shapes. When no
 * JSON at all is emitted, `text` falls back to the trimmed raw stdout.
 *
 * @param {string} stdout captured stdout
 * @returns {{text: string, sessionId: string|null, events: Array<Record<string, any>>,
 *            usage: Record<string, any>|null}}
 */
export function parseCodexEvents(stdout) {
  const raw = typeof stdout === 'string' ? stdout : String(stdout ?? '')
  const events = []
  const texts = []
  let sessionId = null
  let usage = null
  for (const line of raw.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate || !candidate.startsWith('{')) continue
    let event
    try {
      event = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!isObject(event)) continue
    events.push(event)
    const id = threadIdFromEvent(event)
    if (id) sessionId = id
    const text = assistantTextFromEvent(event)
    if (text.trim() !== '') texts.push(text.trim())
    const eventUsage = usageFromEvent(event)
    if (eventUsage) usage = eventUsage
  }
  let text = texts.join('\n\n')
  if (text === '' && events.length === 0) {
    const plain = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join('\n')
    text = (plain || raw).trim()
  }
  return { text, sessionId, events, usage }
}

/**
 * Create the Codex adapter.
 * @param {{config?: Record<string, any>, logger?: any}} [deps] adapter deps
 * @returns {{harness: string, describe: Function, openThread: Function,
 *            runTurn: Function, closeThread: Function}}
 */
export function createCodexAdapter({ config, logger } = {}) {
  const cfg = resolveAdapterConfig(config, HARNESS, { command: 'codex' })
  let probePromise = null

  function probe() {
    if (!probePromise) {
      probePromise = (async () => {
        const commandPath = await whichCommand(cfg.command)
        if (!commandPath) return { found: false, path: null, version: null }
        let version = null
        try {
          const outcome = await runProcess({
            command: commandPath,
            args: ['--version'],
            input: '',
            timeoutMs: cfg.versionProbeTimeoutMs,
          })
          const text = (outcome.stdout + '\n' + outcome.stderr).trim()
          const match = text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
          if (match) version = match[0]
        } catch {
          /* diagnostic only */
        }
        return { found: true, path: commandPath, version }
      })().catch((error) => {
        probePromise = null
        logger?.debug?.('dsh-peer: codex probe failed: ' + (error?.message ?? error))
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
          models: cfg.models ?? [],
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
        }
        info.command = cli.path ?? cfg.command
        if (cli.version) info.version = cli.version
        if (!cli.found) {
          info.notes =
            'codex CLI not found (looked for "' +
            cfg.command +
            '"); install @openai/codex and set config.adapters.codex.command to its path'
        } else {
          info.notes =
            'codex exec --json is parsed tolerantly; see docs/CODEX.md for the target event schema and its evidence caveats (codex-cli 0.121.0, no live turn verified)'
        }
        return info
      } catch (error) {
        return {
          harness: HARNESS,
          available: false,
          notes: 'codex adapter probe failed: ' + (error?.message ?? String(error)),
        }
      }
    },

    /** Codex keeps session state on disk; resume is per turn. */
    async openThread() {},

    /**
     * Run one Codex turn.
     * @param {{thread?: any, userText?: string, message?: any, context?: any,
     *          signal?: AbortSignal, onDelta?: Function}} input turn input
     * @returns {Promise<{text: string, meta: Record<string, any>, remoteSessionId: string|null}>}
     */
    async runTurn(input = {}) {
      const started = Date.now()
      const { thread = {}, message, context: callContext, signal } = input
      if (signal && signal.aborted) throw abortedError()
      const context = mergeTurnContext(thread.context, message?.context, callContext)
      const userText =
        typeof input.userText === 'string'
          ? input.userText
          : typeof message?.text === 'string'
            ? message.text
            : ''
      const model = resolveTurnModel({ thread, message, context, fallback: cfg.defaultModel })
      const effort = resolveTurnEffort({ thread, message, context, fallback: cfg.defaultEffort })
      const resume = firstString(context.resume, thread.remoteSessionId)
      const cli = await probe()
      if (!cli.found || !cli.path) {
        throw new BridgeError(
          'adapter-unavailable',
          'codex CLI is not available (looked for "' +
            cfg.command +
            '"); install @openai/codex and set config.adapters.codex.command',
          { command: cfg.command },
        )
      }
      const prompt = await composePrompt({ text: userText, context })
      const args = buildCodexArgs({
        model,
        effort,
        cwd: context.cwd,
        resume,
        extraArgs: cfg.extraArgs,
      })
      const outcome = await runProcess({
        command: cli.path,
        args,
        input: prompt,
        cwd: context.cwd,
        signal,
        timeoutMs: cfg.turnTimeoutMs,
      })
      if (outcome.aborted) throw abortedError()
      if (outcome.timedOut) {
        throw timeoutError('codex turn timed out after ' + cfg.turnTimeoutMs + 'ms')
      }
      if (outcome.error) {
        const code = outcome.error.code === 'ENOENT' ? 'adapter-unavailable' : 'adapter-failed'
        throw new BridgeError(code, 'could not start codex: ' + outcome.error.message, {
          command: cli.path,
        })
      }
      const parsed = parseCodexEvents(outcome.stdout)
      const failure = failureFromEvents(parsed.events)
      if (failure) {
        throw new BridgeError('adapter-failed', failure, { exitCode: outcome.code })
      }
      if (outcome.code !== 0 && parsed.text.trim() === '') {
        const stderr = outcome.stderr.trim().slice(0, 2000)
        throw new BridgeError(
          'adapter-failed',
          'codex exited with code ' + outcome.code + (stderr ? ': ' + stderr : ''),
          { exitCode: outcome.code, stderr },
        )
      }
      if (parsed.sessionId) thread.remoteSessionId = parsed.sessionId
      const remoteSessionId = parsed.sessionId ?? firstString(thread.remoteSessionId) ?? null
      const meta = {
        model: model ?? null,
        reasoning_effort: effort ?? null,
        durationMs: Date.now() - started,
        exitCode: outcome.code,
        sessionId: remoteSessionId,
        truncated:
          (parsed.events.length === 0 && parsed.text !== '') || outcome.stdoutTruncated === true,
      }
      if (parsed.usage) meta.usage = parsed.usage
      return { text: parsed.text, meta, remoteSessionId }
    },

    /** Nothing to tear down: each turn is one short-lived process. */
    async closeThread() {},
  }
}

export default createCodexAdapter
