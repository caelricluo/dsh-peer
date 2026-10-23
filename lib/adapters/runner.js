/**
 * Child-process plumbing and shared context helpers for harness adapters.
 *
 * Zero dependencies, Node >= 20, ESM only. Everything here runs with plain
 * `node`; no DSH or Electron packages are imported. Child processes are always
 * spawned with `shell: false` so user text can never reach a shell.
 *
 * @module @caelricluo/dsh-peer/adapters/runner
 */

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { BridgeError, DEFAULT_TURN_TIMEOUT_MS } from '../protocol.js'

/** Hard cap on captured stdout/stderr bytes (per stream) before truncation. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** Grace period between SIGTERM and SIGKILL when a turn is aborted or times out. */
export const DEFAULT_KILL_GRACE_MS = 1000

/**
 * After SIGKILL, how long to wait for the child's 'close' event before settling
 * anyway. CLI harnesses can spawn descendants that inherit the stdio pipes and
 * keep 'close' from ever firing; the promise must still resolve on time.
 */
export const DEFAULT_SETTLE_GRACE_MS = 250

/** Budget for file contents prepended to a prompt. */
export const DEFAULT_FILE_CONTEXT_BYTES = 128 * 1024

/** How long a describe() version probe may take. */
export const DEFAULT_VERSION_PROBE_MS = 3000

/** @param {unknown} value @returns {boolean} whether value is a plain object */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Return the first non-blank string in the argument list.
 * @param {...unknown} values candidates, in priority order
 * @returns {string|undefined} the first usable value
 */
export function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Normalize adapter config from either an adapter-scoped object or the whole
 * plugin config (`config.adapters.<harness>`).
 * @param {Record<string, any>|undefined} config adapter or plugin config
 * @param {string} harness harness id ('claude' | 'codex' | 'dsh')
 * @param {{command?: string}} [defaults] fallback values
 * @returns {Record<string, any>} normalized adapter settings
 */
export function resolveAdapterConfig(config, harness, defaults = {}) {
  const root = isObject(config) ? config : {}
  // Accepted shapes: { adapters: { claude: {...} } } (normalized plugin config),
  // { claude: {...}, codex: {...} } (per-harness map), or a single adapter object.
  const perHarness = ['dsh', 'claude', 'codex'].some((id) => isObject(root[id]))
  const table = isObject(root.adapters) ? root.adapters : perHarness ? root : null
  const scoped = table && isObject(table[harness]) ? table[harness] : null
  const source = scoped ?? root
  const turnTimeoutMs =
    Number.isFinite(root.turnTimeoutMs) && root.turnTimeoutMs > 0
      ? root.turnTimeoutMs
      : Number.isFinite(source.turnTimeoutMs) && source.turnTimeoutMs > 0
        ? source.turnTimeoutMs
        : DEFAULT_TURN_TIMEOUT_MS
  return {
    command: firstString(source.command) ?? defaults.command ?? harness,
    defaultModel: firstString(source.defaultModel) ?? '',
    defaultEffort: firstString(source.defaultEffort) ?? '',
    extraArgs: Array.isArray(source.extraArgs) ? source.extraArgs.map(String) : [],
    models: Array.isArray(source.models) ? source.models.map(String) : null,
    turnTimeoutMs,
    versionProbeTimeoutMs:
      Number.isFinite(source.versionProbeTimeoutMs) && source.versionProbeTimeoutMs > 0
        ? source.versionProbeTimeoutMs
        : DEFAULT_VERSION_PROBE_MS,
  }
}

/** Context key aliases so snake_case and camelCase callers both work. */
const CONTEXT_ALIASES = Object.freeze({
  appendSystemPrompt: 'append_system',
  systemPrompt: 'system',
  addDirs: 'add_dirs',
  resumeSessionId: 'resume',
  reasoningEffort: 'reasoning_effort',
})

/**
 * Merge context layers left-to-right (later wins), normalizing known aliases.
 * @param {...(Record<string, any>|undefined)} sources context layers
 * @returns {Record<string, any>} merged context
 */
export function mergeTurnContext(...sources) {
  const merged = {}
  for (const source of sources) {
    if (!isObject(source)) continue
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null) continue
      merged[CONTEXT_ALIASES[key] ?? key] = value
    }
  }
  return merged
}

/**
 * Resolve the effective model for one turn.
 * @param {{thread?: any, message?: any, context?: any, fallback?: string}} input
 * @returns {string|undefined}
 */
export function resolveTurnModel({ thread, message, context, fallback } = {}) {
  return firstString(
    message?.model,
    message?.meta?.model,
    context?.model,
    thread?.model,
    fallback,
  )
}

/**
 * Resolve the effective reasoning effort for one turn.
 * @param {{thread?: any, message?: any, context?: any, fallback?: string}} input
 * @returns {string|undefined}
 */
export function resolveTurnEffort({ thread, message, context, fallback } = {}) {
  return firstString(
    message?.reasoning_effort,
    message?.meta?.reasoning_effort,
    context?.reasoning_effort,
    thread?.reasoning_effort,
    fallback,
  )
}

/**
 * Build an aborted-turn error. It stays a BridgeError for HTTP mapping but
 * carries `name = 'AbortError'` so callers/tests can distinguish cancellation.
 * @param {string} [message] human-readable explanation
 * @returns {BridgeError}
 */
export function abortedError(message = 'the peer turn was aborted') {
  const error = new BridgeError('timeout', message, { aborted: true })
  error.name = 'AbortError'
  return error
}

/**
 * Build a timed-out-turn error.
 * @param {string} [message] human-readable explanation
 * @returns {BridgeError}
 */
export function timeoutError(message = 'the peer turn timed out') {
  const error = new BridgeError('timeout', message, { timedOut: true })
  error.name = 'TimeoutError'
  return error
}

/**
 * Resolve an executable without a shell: absolute/relative paths are checked
 * directly, bare names are looked up on PATH.
 * @param {string} name command name or path
 * @returns {Promise<string|null>} absolute executable path, or null
 */
export async function whichCommand(name) {
  const candidate = firstString(name)
  if (!candidate) return null
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  const isExecutable = async (filePath) => {
    try {
      await access(filePath, fsConstants.X_OK)
      return filePath
    } catch {
      return null
    }
  }
  if (isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')) {
    return isExecutable(candidate)
  }
  const pathValue = process.env.PATH ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const found = await isExecutable(resolve(dir, candidate + extension))
      if (found) return found
    }
  }
  return null
}

/**
 * Collect a byte-capped text stream and optionally split it into lines.
 * @param {number} limit byte cap
 * @param {(line: string) => void} [onLine] line listener
 * @returns {{push: (text: string) => void, finish: () => void, text: () => string, truncated: () => boolean}}
 */
function createCollector(limit, onLine) {
  const chunks = []
  let bytes = 0
  let truncated = false
  let partial = ''
  const emit = (line) => {
    if (typeof onLine !== 'function') return
    try {
      onLine(line)
    } catch {
      /* a listener must never break the child process */
    }
  }
  return {
    push(text) {
      const chunk = String(text ?? '')
      if (bytes < limit) {
        chunks.push(chunk)
        bytes += Buffer.byteLength(chunk, 'utf8')
        if (bytes > limit) truncated = true
      } else {
        truncated = true
      }
      if (typeof onLine !== 'function') return
      partial += chunk
      if (partial.length > limit) {
        emit(partial)
        partial = ''
        return
      }
      let index = partial.indexOf('\n')
      while (index >= 0) {
        const line = partial.slice(0, index)
        partial = partial.slice(index + 1)
        emit(line.endsWith('\r') ? line.slice(0, -1) : line)
        index = partial.indexOf('\n')
      }
    },
    finish() {
      if (typeof onLine !== 'function' || partial === '') return
      emit(partial.endsWith('\r') ? partial.slice(0, -1) : partial)
      partial = ''
    },
    text() {
      let joined = chunks.join('')
      if (Buffer.byteLength(joined, 'utf8') > limit) {
        joined = Buffer.from(joined, 'utf8').subarray(0, limit).toString('utf8')
      }
      return joined
    },
    truncated() {
      return truncated
    },
  }
}

/**
 * Run one child process to completion.
 *
 * The prompt is written to stdin and stdin is closed; children must read EOF.
 * Timeouts and AbortSignal both terminate the child (SIGTERM, then SIGKILL
 * after `killGraceMs`), and the promise always resolves with an outcome object
 * (it only rejects if spawn throws synchronously, which normally cannot happen).
 *
 * @param {{
 *   command: string,
 *   args?: string[],
 *   input?: string|Buffer,
 *   cwd?: string,
 *   env?: Record<string, string|undefined>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   onStdoutLine?: (line: string) => void,
 *   onStderrLine?: (line: string) => void,
 *   maxBytes?: number,
 *   killGraceMs?: number,
 *   settleGraceMs?: number,
 * }} options process options
 * @returns {Promise<{
 *   code: number|null, signal: string|null, stdout: string, stderr: string,
 *   timedOut: boolean, aborted: boolean, stdoutTruncated: boolean,
 *   stderrTruncated: boolean, error?: Error,
 * }>} outcome
 */
export function runProcess(options = {}) {
  const opts = isObject(options) ? options : {}
  const command = firstString(opts.command)
  const args = Array.isArray(opts.args) ? opts.args.map(String) : []
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES
  const killGraceMs =
    Number.isFinite(opts.killGraceMs) && opts.killGraceMs >= 0 ? opts.killGraceMs : DEFAULT_KILL_GRACE_MS
  const settleGraceMs =
    Number.isFinite(opts.settleGraceMs) && opts.settleGraceMs >= 0
      ? opts.settleGraceMs
      : DEFAULT_SETTLE_GRACE_MS
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 0
  const signal = opts.signal
  const empty = () => ({
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  })

  return new Promise((resolvePromise) => {
    if (!command) {
      resolvePromise({ ...empty(), error: new Error('runProcess requires a command') })
      return
    }
    if (signal && signal.aborted) {
      resolvePromise({ ...empty(), aborted: true })
      return
    }

    const stdout = createCollector(maxBytes, opts.onStdoutLine)
    const stderr = createCollector(maxBytes, opts.onStderrLine)
    let settled = false
    let exited = false
    let timedOut = false
    let aborted = false
    let spawnError = null
    let timeoutTimer = null
    let graceTimer = null
    let settleTimer = null
    let terminating = false

    let child
    try {
      child = spawn(command, args, {
        cwd: firstString(opts.cwd),
        env: isObject(opts.env) ? { ...process.env, ...opts.env } : process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolvePromise({ ...empty(), error })
      return
    }

    const scheduleSettle = (delayMs) => {
      if (settled || settleTimer) return
      settleTimer = setTimeout(() => {
        settleTimer = null
        finalize(null, null, true)
      }, Math.max(0, delayMs))
      if (typeof settleTimer.unref === 'function') settleTimer.unref()
    }

    const terminate = () => {
      if (!child || exited || terminating) return
      terminating = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* the child may already be gone */
      }
      graceTimer = setTimeout(() => {
        if (exited) return
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, killGraceMs)
      if (typeof graceTimer.unref === 'function') graceTimer.unref()
      // Harness CLIs can spawn descendants that inherit stdout/stderr, so
      // SIGTERM/SIGKILL to the direct child may never produce 'close'. Settle
      // with the captured output shortly after the SIGKILL instead of hanging.
      scheduleSettle(killGraceMs + settleGraceMs)
    }

    const onAbort = () => {
      if (settled) return
      aborted = true
      terminate()
    }

    /**
     * Settle the run. `forced` means we stopped waiting for 'close' (timeout,
     * abort or spawn error): captured stdout/stderr are still returned and the
     * pipes are destroyed so lingering descendants cannot keep the event loop
     * alive. Idempotent: the eventual 'close' event becomes a no-op.
     */
    const finalize = (code, exitSignal, forced = false) => {
      if (settled) return
      settled = true
      exited = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (graceTimer) clearTimeout(graceTimer)
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = null
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      if (forced && child) {
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try {
            if (stream && typeof stream.destroy === 'function') stream.destroy()
          } catch {
            /* ignore */
          }
        }
        try {
          if (typeof child.unref === 'function') child.unref()
        } catch {
          /* ignore */
        }
      }
      stdout.finish()
      stderr.finish()
      const outcome = {
        ...empty(),
        code: typeof code === 'number' ? code : null,
        signal: typeof exitSignal === 'string' ? exitSignal : null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        aborted,
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
      }
      if (spawnError) outcome.error = spawnError
      resolvePromise(outcome)
    }

    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (text) => stdout.push(text))
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (text) => stderr.push(text))
    }
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* EPIPE when the child exits before reading all input */
      })
      const input = opts.input === undefined || opts.input === null ? '' : opts.input
      try {
        child.stdin.end(input)
      } catch {
        try {
          child.stdin.destroy()
        } catch {
          /* ignore */
        }
      }
    }

    child.on('error', (error) => {
      spawnError = error
      // Spawn failures normally emit 'close' immediately; do not rely on it.
      scheduleSettle(settleGraceMs)
    })
    child.on('close', (code, exitSignal) => finalize(code, exitSignal))

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        terminate()
      }, timeoutMs)
      if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Render file contents into a prompt preamble, mirroring the in-process DSH
 * host so CLI and DSH turns see context in the same shape.
 * @param {string[]|undefined} files file paths (absolute or relative to cwd)
 * @param {string|undefined} cwd base directory
 * @param {number} [maxBytes] total content budget
 * @returns {Promise<string>} preamble text ('' when there are no files)
 */
export async function renderFiles(files, cwd, maxBytes = DEFAULT_FILE_CONTEXT_BYTES) {
  if (!Array.isArray(files)) return ''
  const list = files.filter((file) => typeof file === 'string' && file.trim() !== '')
  if (list.length === 0) return ''
  const parts = []
  let budget = maxBytes
  for (const file of list.slice(0, 32)) {
    const target = isAbsolute(file) ? file : resolve(firstString(cwd) ?? process.cwd(), file)
    try {
      const raw = await readFile(target, 'utf8')
      const slice = budget > 0 ? raw.slice(0, budget) : ''
      budget -= slice.length
      parts.push('### file: ' + target + '\n' + slice)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      parts.push('### file: ' + target + '\n(unreadable: ' + message + ')')
    }
  }
  return parts.length === 0 ? '' : 'Context files supplied by the peer caller:\n\n' + parts.join('\n\n')
}

/**
 * Compose the prompt written to a CLI's stdin: optional system/append text,
 * then file contents, then the user's message.
 * @param {{text?: string, context?: Record<string, any>, maxFileBytes?: number}} input
 * @returns {Promise<string>} prompt text
 */
export async function composePrompt({ text = '', context = {}, maxFileBytes } = {}) {
  const ctx = isObject(context) ? context : {}
  const sections = []
  if (typeof ctx.system === 'string' && ctx.system.trim() !== '') sections.push(ctx.system)
  if (typeof ctx.append_system === 'string' && ctx.append_system.trim() !== '') sections.push(ctx.append_system)
  const files = await renderFiles(ctx.files, ctx.cwd, maxFileBytes)
  if (files) sections.push(files)
  sections.push(String(text ?? ''))
  return sections.join('\n\n')
}
