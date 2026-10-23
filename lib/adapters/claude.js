/**
 * Claude Code CLI adapter: one `claude -p --output-format json` process per turn.
 *
 * Prompt text is written to stdin; `shell: false` is enforced by runner.js.
 * Model, effort, resume id, system prompts and add-dirs map to documented CLI
 * flags (verified against Claude Code 2.1.224 `claude --help`):
 *
 *   claude -p --output-format json [--model M] [--effort E] [--resume S]
 *          [--system-prompt T] [--append-system-prompt T] [--add-dir D]...
 *
 * File context is rendered into the stdin prompt (contents, not just paths).
 *
 * @module @caelricluo/dsh-peer/adapters/claude
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
export const HARNESS = 'claude'

/** Model aliases shown in AdapterInfo; override with config.models. */
const DEFAULT_MODELS = Object.freeze(['sonnet', 'opus', 'haiku'])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Build the argv for one `claude -p` turn (command excluded).
 *
 * Pure and deterministic: the same input always yields the same array.
 * Pinned keys are `model`, `effort`, `resume`, `appendSystemPrompt`,
 * `addDirs`, `system`; `reasoningEffort` and a `context` object
 * (`system`/`append_system`/`add_dirs`/`resume`/`model`) are accepted as
 * aliases so either call style works.
 * @param {{model?: string, effort?: string, reasoningEffort?: string, resume?: string,
 *          appendSystemPrompt?: string, addDirs?: string[], system?: string,
 *          context?: Record<string, any>}} [input]
 * @returns {string[]} argument vector
 */
export function buildClaudeArgs(input = {}) {
  const { model, effort, reasoningEffort, resume, appendSystemPrompt, addDirs, system } = input
  const context = isObject(input.context) ? input.context : {}
  const args = ['-p', '--output-format', 'json']
  const modelId = firstString(model, context.model)
  if (modelId) args.push('--model', modelId)
  const effortLevel = firstString(
    effort,
    reasoningEffort,
    context.reasoning_effort,
    context.reasoningEffort,
  )
  if (effortLevel) args.push('--effort', effortLevel)
  const resumeId = firstString(resume, context.resume, context.resumeSessionId)
  if (resumeId) args.push('--resume', resumeId)
  const systemPrompt = firstString(system, context.system)
  if (systemPrompt) args.push('--system-prompt', systemPrompt)
  const appended = firstString(appendSystemPrompt, context.append_system, context.appendSystemPrompt)
  if (appended) args.push('--append-system-prompt', appended)
  const directories = Array.isArray(addDirs)
    ? addDirs
    : Array.isArray(context.add_dirs)
      ? context.add_dirs
      : Array.isArray(context.addDirs)
        ? context.addDirs
        : []
  for (const dir of directories) {
    const value = firstString(dir)
    if (value) args.push('--add-dir', value)
  }
  return args
}

/**
 * Extract the final result object from a `--output-format json` stdout blob.
 * @param {unknown} value parsed JSON value
 * @returns {{text: string, sessionId: string|null, isError: boolean, subtype: string|null}|null}
 */
function resultFromValue(value) {
  if (!isObject(value)) return null
  const looksLikeResult =
    value.type === 'result' || 'result' in value || 'is_error' in value || 'session_id' in value
  if (!looksLikeResult) return null
  let text = ''
  if (typeof value.result === 'string') text = value.result
  else if (value.result !== undefined && value.result !== null) text = safeStringify(value.result)
  else if (typeof value.message === 'string') text = value.message
  return {
    text,
    sessionId: firstString(value.session_id, value.sessionId) ?? null,
    isError: value.is_error === true,
    subtype: typeof value.subtype === 'string' ? value.subtype : null,
  }
}

/**
 * Extract assistant text from `--output-format stream-json` assistant events.
 * @param {unknown} value one parsed NDJSON event
 * @returns {string} concatenated text
 */
function streamAssistantText(value) {
  if (!isObject(value) || value.type !== 'assistant') return ''
  const content = value.message?.content ?? value.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isObject(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/**
 * Parse the output of `claude -p --output-format json`.
 *
 * Handles: one JSON result object, a JSON array of events (last result wins),
 * newline-delimited stream-json (last result wins), and raw non-JSON output.
 * On a non-JSON fallback the raw stdout becomes `text` and `raw` is set so the
 * adapter can flag `meta.truncated`; `raw` is null when parsing succeeded.
 *
 * @param {string} stdout captured stdout
 * @returns {{text: string, sessionId: string|null, isError: boolean,
 *            subtype: string|null, raw: string|null}}
 */
export function parseClaudeResult(stdout) {
  const raw = typeof stdout === 'string' ? stdout : String(stdout ?? '')
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { text: '', sessionId: null, isError: false, subtype: null, raw: null }
  }

  // 1) One JSON document (object or array).
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      for (let index = parsed.length - 1; index >= 0; index -= 1) {
        const result = resultFromValue(parsed[index])
        if (result) return { ...result, raw: null }
      }
      // An array of stream events without a result event: fold assistant text.
      const text = parsed.map(streamAssistantText).join('')
      if (text) {
        const sessionId = firstString(
          ...parsed.map((event) => (isObject(event) ? event.session_id : undefined)),
        )
        return { text, sessionId: sessionId ?? null, isError: false, subtype: null, raw: null }
      }
      return { text: trimmed, sessionId: null, isError: false, subtype: null, raw: trimmed }
    }
    const result = resultFromValue(parsed)
    if (result) return { ...result, raw: null }
  } catch {
    /* fall through to NDJSON */
  }

  // 2) Newline-delimited JSON.
  const events = []
  for (const line of raw.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate.startsWith('{')) continue
    try {
      events.push(JSON.parse(candidate))
    } catch {
      /* not JSON; ignore this line */
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const result = resultFromValue(events[index])
    if (result) return { ...result, raw: null }
  }
  const streamed = events.map(streamAssistantText).join('')
  if (streamed) {
    const sessionId = firstString(
      ...events.map((event) => (isObject(event) ? event.session_id : undefined)),
    )
    return { text: streamed, sessionId: sessionId ?? null, isError: false, subtype: null, raw: null }
  }

  // 3) Raw fallback.
  return { text: trimmed, sessionId: null, isError: false, subtype: null, raw: trimmed }
}

/**
 * Create the Claude Code adapter.
 * @param {{config?: Record<string, any>, logger?: any}} [deps] adapter deps
 * @returns {{harness: string, describe: Function, openThread: Function,
 *            runTurn: Function, closeThread: Function}}
 */
export function createClaudeAdapter({ config, logger } = {}) {
  const cfg = resolveAdapterConfig(config, HARNESS, { command: 'claude' })
  let probePromise = null

  /** Probe the CLI once and cache the result (successful or not). */
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
          /* a version probe is diagnostic only */
        }
        return { found: true, path: commandPath, version }
      })().catch((error) => {
        probePromise = null
        logger?.debug?.('dsh-peer: claude probe failed: ' + (error?.message ?? error))
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
            addDirs: true,
          },
        }
        info.command = cli.path ?? cfg.command
        if (cli.version) info.version = cli.version
        if (!cli.found) {
          info.notes =
            'claude CLI not found (looked for "' +
            cfg.command +
            '"); install Claude Code or set config.adapters.claude.command'
        }
        return info
      } catch (error) {
        return {
          harness: HARNESS,
          available: false,
          notes: 'claude adapter probe failed: ' + (error?.message ?? String(error)),
        }
      }
    },

    /** Claude Code has no separate thread setup; session resume is per turn. */
    async openThread() {},

    /**
     * Run one Claude Code turn.
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
          'claude CLI is not available (looked for "' +
            cfg.command +
            '"); install Claude Code or set config.adapters.claude.command',
          { command: cfg.command },
        )
      }
      const prompt = await composePrompt({ text: userText, context: { files: context.files, cwd: context.cwd } })
      const args = [
        ...buildClaudeArgs({
          model,
          effort,
          resume,
          appendSystemPrompt: context.append_system,
          addDirs: context.add_dirs,
          system: context.system,
        }),
        ...cfg.extraArgs,
      ]
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
        throw timeoutError('claude turn timed out after ' + cfg.turnTimeoutMs + 'ms')
      }
      if (outcome.error) {
        const code = outcome.error.code === 'ENOENT' ? 'adapter-unavailable' : 'adapter-failed'
        throw new BridgeError(code, 'could not start claude: ' + outcome.error.message, {
          command: cli.path,
        })
      }
      const parsed = parseClaudeResult(outcome.stdout)
      if (parsed.isError) {
        throw new BridgeError(
          'adapter-failed',
          parsed.text || 'claude reported ' + (parsed.subtype ?? 'an error'),
          { subtype: parsed.subtype, exitCode: outcome.code },
        )
      }
      if (outcome.code !== 0 && parsed.text.trim() === '') {
        const stderr = outcome.stderr.trim().slice(0, 2000)
        throw new BridgeError(
          'adapter-failed',
          'claude exited with code ' + outcome.code + (stderr ? ': ' + stderr : ''),
          { exitCode: outcome.code, stderr },
        )
      }
      if (parsed.sessionId) thread.remoteSessionId = parsed.sessionId
      const remoteSessionId = parsed.sessionId ?? firstString(thread.remoteSessionId) ?? null
      return {
        text: parsed.text,
        meta: {
          model: model ?? null,
          reasoning_effort: effort ?? null,
          durationMs: Date.now() - started,
          exitCode: outcome.code,
          sessionId: remoteSessionId,
          truncated: parsed.raw !== null || outcome.stdoutTruncated,
        },
        remoteSessionId,
      }
    },

    /** Nothing to tear down: each turn is one short-lived process. */
    async closeThread() {},
  }
}

export default createClaudeAdapter
