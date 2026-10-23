/**
 * In-process DSH adapter.
 *
 * This is a thin, dependency-free wrapper over an injected host object. The
 * plugin host (lib/index.js) supplies `host.runAgentTurn`; tests can supply a
 * fake. No @deepseek-ai/* module is imported here, so the file is importable
 * by plain `node`.
 *
 * Contract call (docs/CONTRACT.md section 6):
 *   host.runAgentTurn({ prompt, model, reasoningEffort, cwd, system,
 *                       resumeSessionId, files, signal })
 *     -> { text, sessionId, resumed }
 * The extra `text`/`context` fields are also sent for host implementations
 * that compose the prompt themselves (the shipped host does).
 *
 * @module @caelricluo/dsh-peer/adapters/dsh
 */

import { BridgeError, REASONING_EFFORTS } from '../protocol.js'
import {
  abortedError,
  firstString,
  mergeTurnContext,
  resolveAdapterConfig,
  resolveTurnEffort,
  resolveTurnModel,
} from './runner.js'

/** Harness id reported by this adapter. */
export const HARNESS = 'dsh'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Create the in-process DSH adapter.
 * @param {{config?: Record<string, any>, logger?: any, host?: any}} [deps]
 * @returns {{harness: string, describe: Function, openThread: Function,
 *            runTurn: Function, closeThread: Function}}
 */
export function createDshAdapter({ config, logger, host } = {}) {
  const cfg = resolveAdapterConfig(config, HARNESS, { command: 'dsh' })

  function hostAvailable() {
    return isObject(host) && typeof host.runAgentTurn === 'function'
  }

  return {
    harness: HARNESS,

    /** @returns {Promise<Record<string, any>>} AdapterInfo; never throws */
    async describe() {
      try {
        const available = hostAvailable()
        const info = {
          harness: HARNESS,
          available,
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
        if (!available) {
          info.notes =
            'in-process DSH host is not available (standalone mode: no host.runAgentTurn injected)'
        } else {
          info.notes = 'in-process turn via host.runAgentTurn (never a subprocess)'
        }
        return info
      } catch (error) {
        return {
          harness: HARNESS,
          available: false,
          notes: 'dsh adapter describe failed: ' + (error?.message ?? String(error)),
        }
      }
    },

    /** There is no remote setup for an in-process turn. */
    async openThread() {},

    /**
     * Run one in-process DSH turn.
     * @param {{thread?: any, userText?: string, message?: any, context?: any,
     *          signal?: AbortSignal, onDelta?: Function}} input turn input
     * @returns {Promise<{text: string, meta: Record<string, any>, remoteSessionId: string|null}>}
     */
    async runTurn(input = {}) {
      const started = Date.now()
      if (!hostAvailable()) {
        throw new BridgeError(
          'adapter-unavailable',
          'the in-process DSH host is not available in this process (standalone mode)',
        )
      }
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
      const resumeSessionId = firstString(context.resume, thread.remoteSessionId)
      const turnContext = {
        cwd: firstString(context.cwd),
        system: typeof context.system === 'string' ? context.system : undefined,
        append_system: typeof context.append_system === 'string' ? context.append_system : undefined,
        files: Array.isArray(context.files) ? context.files.map(String) : undefined,
        resume: resumeSessionId,
      }
      let outcome
      try {
        outcome = await host.runAgentTurn({
          // CONTRACT section 6 shape
          prompt: userText,
          model,
          reasoningEffort: effort,
          cwd: turnContext.cwd,
          system: turnContext.system,
          resumeSessionId,
          files: turnContext.files,
          signal,
          // Tolerated extras for hosts that compose the prompt internally
          text: userText,
          context: turnContext,
        })
      } catch (error) {
        if ((signal && signal.aborted) || error?.name === 'AbortError') throw abortedError()
        if (error instanceof BridgeError) throw error
        logger?.warn?.('dsh-peer: in-process turn failed: ' + (error?.message ?? error))
        throw new BridgeError(
          'adapter-failed',
          'the in-process DSH turn failed: ' + (error?.message ?? String(error)),
        )
      }
      if (signal && signal.aborted) throw abortedError()
      if (!isObject(outcome)) {
        throw new BridgeError('adapter-failed', 'host.runAgentTurn returned no result object')
      }
      const text =
        typeof outcome.text === 'string'
          ? outcome.text
          : outcome.text === undefined || outcome.text === null
            ? ''
            : String(outcome.text)
      const sessionId = firstString(outcome.sessionId)
      if (sessionId) thread.remoteSessionId = sessionId
      return {
        text,
        meta: {
          model: model ?? null,
          reasoning_effort: effort ?? null,
          durationMs: Date.now() - started,
          sessionId: sessionId ?? null,
          resumed: outcome.resumed === true,
          truncated: false,
        },
        remoteSessionId: sessionId ?? resumeSessionId ?? null,
      }
    },

    /** Ephemeral host agents are disposed by the host; nothing to close here. */
    async closeThread() {},
  }
}

export default createDshAdapter
