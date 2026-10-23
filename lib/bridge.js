/**
 * Loopback HTTP bridge for the dsh-peer plugin.
 *
 * The bridge is a small, dependency-free HTTP server (node:http only) that
 * exposes the wire protocol from CONTRACT section 4 and dispatches turns to
 * injected collaborators:
 *
 * - `store`     the file-backed thread store (lib/store.js)
 * - `adapters`  registry with `all()` and `get(harness)` (lib/adapters/index.js)
 * - `inbound`   host handler used for harness "dsh" (lib/index.js)
 * - `sessions`  host live-session lister used by GET /v1/health
 *
 * Binding is hard-coded to 127.0.0.1. Every /v1 route requires a bearer token
 * compared in constant time. Request bodies are capped at 1 MiB and parsed as
 * JSON. Errors are always JSON `{error:{code,message,details?}}` with the
 * status mapped from the protocol code.
 *
 * @module @caelricluo/dsh-peer/bridge
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'

import {
  BridgeError,
  DEFAULT_PORT,
  DEFAULT_TURN_TIMEOUT_MS,
  HARNESSES,
  LOOPBACK_HOST,
  MAX_BODY_BYTES,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  REASONING_EFFORTS,
  THREAD_STATUSES,
  clampWaitSeconds,
  cloneJson,
  newToken,
  nowMs,
  optionalString,
  requireEnum,
  requireString,
  statusForCode,
  toBridgeError,
} from './protocol.js'

/** Server-sent-events heartbeat interval. */
const SSE_HEARTBEAT_MS = 15_000

/** Number of events replayed to a new SSE subscriber. */
const SSE_BUFFER_SIZE = 500

/** Fields accepted inside a thread context object. */
const CONTEXT_KEYS = Object.freeze(['cwd', 'system', 'append_system', 'files', 'resume', 'add_dirs'])

/**
 * Match a route pattern (`/v1/threads/:id`) against a pathname.
 *
 * @param {string} pattern route pattern with `:param` segments
 * @param {string} pathname request pathname
 * @returns {Record<string, string>|null} decoded params or null when no match
 */
export function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/').filter((part) => part !== '')
  const pathParts = pathname.split('/').filter((part) => part !== '')
  if (patternParts.length !== pathParts.length) return null
  /** @type {Record<string, string>} */
  const params = {}
  for (let index = 0; index < patternParts.length; index += 1) {
    const part = patternParts[index]
    if (part.startsWith(':')) {
      try {
        params[part.slice(1)] = decodeURIComponent(pathParts[index])
      } catch {
        params[part.slice(1)] = pathParts[index]
      }
    } else if (part !== pathParts[index]) {
      return null
    }
  }
  return params
}

/**
 * Create a tiny method+path router. Deliberately small so it is easy to
 * unit-test in isolation from the HTTP server.
 *
 * @returns {{add: Function, match: Function, routes: Function}} router
 */
export function createRouter() {
  /** @type {Array<{method: string, pattern: string, handler: Function}>} */
  const routes = []
  return {
    /**
     * @param {string} method HTTP method (or "*")
     * @param {string} pattern route pattern
     * @param {Function} handler request handler
     * @returns {any} router (chainable)
     */
    add(method, pattern, handler) {
      routes.push({ method: method.toUpperCase(), pattern, handler })
      return this
    },
    /**
     * @param {string} method HTTP method
     * @param {string} pathname request pathname
     * @returns {{handler: Function, params: Record<string, string>}|null} match
     */
    match(method, pathname) {
      const upper = method.toUpperCase()
      for (const route of routes) {
        const params = matchRoute(route.pattern, pathname)
        if (params === null) continue
        if (route.method === upper || route.method === '*') return { handler: route.handler, params }
      }
      return null
    },
    /** @returns {Array<any>} copy of the registered routes */
    routes() {
      return routes.slice()
    },
  }
}

/**
 * Create the HTTP bridge.
 *
 * @param {object} options
 * @param {any} options.store thread store (createStore instance)
 * @param {any} [options.adapters] adapter registry ({ all(), get(harness) })
 * @param {Function} [options.inbound] inbound handler for harness "dsh"
 * @param {object} [options.config] { host, port, token, turnTimeoutMs, packageVersion }
 * @param {any} [options.logger] optional logger
 * @param {Function} [options.sessions] live DSH session lister
 * @returns {Bridge} bridge instance (call {@link Bridge.listen} to bind)
 */
export function createBridge(options = {}) {
  const { store } = options
  if (!store) throw new BridgeError('internal', 'createBridge() requires a thread store')

  const config = options.config ?? {}
  const host = optionalString(config.host) ?? LOOPBACK_HOST
  if (host !== LOOPBACK_HOST) {
    throw new BridgeError('bad-request', 'the peer bridge may only bind to ' + LOOPBACK_HOST + ' (loopback only)')
  }
  const requestedPort = Number.isInteger(config.port) ? config.port : DEFAULT_PORT
  if (requestedPort < 0 || requestedPort > 65535) {
    throw new BridgeError('bad-request', '"port" must be an integer between 0 and 65535')
  }
  const token = optionalString(config.token) ?? newToken()
  const packageVersion = optionalString(config.packageVersion) ?? PACKAGE_VERSION
  const turnTimeoutMs =
    typeof config.turnTimeoutMs === 'number' && Number.isFinite(config.turnTimeoutMs) && config.turnTimeoutMs > 0
      ? Math.floor(config.turnTimeoutMs)
      : DEFAULT_TURN_TIMEOUT_MS
  const adapters = options.adapters
  const inbound = options.inbound
  const sessionsFn = options.sessions ?? config.sessions ?? null
  const logger = createLogger(options.logger ?? config.logger)

  const startedAt = nowMs()
  const tokenDigest = digest(token)
  const router = createRouter()
  const server = http.createServer((req, res) => {
    void handle(req, res)
  })
  // Long polls (up to MAX_WAIT_SECONDS) must not be cut off by the default
  // 5 minute request timeout.
  server.requestTimeout = 0
  server.keepAliveTimeout = 65_000

  /** @type {Set<{res: import('node:http').ServerResponse, write: (chunk: string) => void}>} */
  const sseClients = new Set()
  /** @type {Array<{seq: number, event: any}>} */
  const eventBuffer = []
  /** @type {Set<AbortController>} */
  const activeTurns = new Set()

  let eventSeq = 0
  let url = ''
  let boundPort = requestedPort
  let listenPromise = null
  let closed = false

  const unsubscribeStore =
    typeof store.subscribe === 'function'
      ? store.subscribe((event) => {
          broadcast(event)
        })
      : () => {}

  /**
   * @param {unknown} error thrown value
   * @returns {string} message
   */
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * Constant-time bearer-token comparison.
   * @param {unknown} header Authorization header value
   * @returns {boolean} whether the header carries the bridge token
   */
  function authorized(header) {
    const value = typeof header === 'string' ? header.trim() : ''
    const match = /^Bearer\s+(.+)$/i.exec(value)
    if (!match) {
      // Burn a comparison anyway to keep timing uniform.
      safeEqual(digest(''), tokenDigest)
      return false
    }
    return safeEqual(digest(match[1].trim()), tokenDigest)
  }

  /** @param {import('node:http').ServerResponse} res @param {number} status @param {any} payload */
  function sendJson(res, status, payload) {
    if (res.destroyed || res.writableEnded) return
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  /**
   * @param {import('node:http').ServerResponse} res response
   * @param {unknown} error thrown value
   */
  function sendError(res, error) {
    const bridgeError = toBridgeError(error, 'internal')
    if (!(error instanceof BridgeError)) {
      logger.error('bridge: request failed: ' + errorMessage(error))
    }
    if (res.headersSent) {
      try {
        res.end()
      } catch {
        /* connection already gone */
      }
      return
    }
    sendJson(res, bridgeError.status ?? statusForCode(bridgeError.code), {
      error: {
        code: bridgeError.code,
        message: bridgeError.message,
        ...(bridgeError.details === undefined ? {} : { details: bridgeError.details }),
      },
    })
  }

  /**
   * Read and parse a JSON request body with a hard size cap.
   * @param {import('node:http').IncomingMessage} req request
   * @returns {Promise<Record<string, any>>} parsed object (empty object for empty bodies)
   */
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
      const chunks = []
      let size = 0
      let tooLarge = false
      let done = false
      const fail = (error) => {
        if (done) return
        done = true
        reject(error)
      }
      req.on('data', (chunk) => {
        if (done) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          tooLarge = true
          chunks.length = 0
          return
        }
        if (!tooLarge) chunks.push(chunk)
      })
      req.on('error', (error) => fail(new BridgeError('bad-request', 'could not read request body: ' + errorMessage(error))))
      req.on('end', () => {
        if (done) return
        done = true
        if (tooLarge) {
          reject(new BridgeError('bad-request', 'request body exceeds ' + MAX_BODY_BYTES + ' bytes', undefined, 413))
          return
        }
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (raw === '') {
          resolve({})
          return
        }
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch (error) {
          reject(new BridgeError('bad-request', 'invalid JSON body: ' + errorMessage(error)))
          return
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new BridgeError('bad-request', 'request body must be a JSON object'))
          return
        }
        resolve(parsed)
      })
    })
  }

  /**
   * Core request dispatcher. Exposed on the bridge for in-process tests.
   * @param {import('node:http').IncomingMessage} req request
   * @param {import('node:http').ServerResponse} res response
   * @returns {Promise<void>}
   */
  async function handle(req, res) {
    try {
      const pathname = requestPath(req.url)
      if (!authorized(req.headers.authorization)) {
        req.resume()
        throw new BridgeError('unauthorized', 'missing or invalid bearer token; read the token from $PEER_HOME/bridge.json')
      }
      const matched = router.match(req.method ?? 'GET', pathname)
      if (!matched) throw new BridgeError('not-found', 'no route for ' + req.method + ' ' + pathname)
      const query = parseQuery(req.url)
      const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readJsonBody(req)
      /** @type {AbortController} */
      const controller = new AbortController()
      const onClose = () => controller.abort()
      res.on('close', onClose)
      try {
        await matched.handler({ req, res, body, query, params: matched.params, signal: controller.signal })
      } finally {
        res.off('close', onClose)
      }
    } catch (error) {
      sendError(res, error)
    }
  }

  // ---- thread helpers -----------------------------------------------------

  /**
   * @param {Record<string, any>} input raw thread input
   * @returns {Record<string, any>} validated store input
   */
  function normalizeThreadInput(input = {}) {
    const harness = requireEnum(optionalString(input.harness), HARNESSES, 'harness')
    const normalized = { harness, context: normalizeContext(input.context) }
    const title = optionalString(input.title)
    if (title !== undefined) normalized.title = title
    const model = optionalString(input.model)
    if (model !== undefined) normalized.model = model
    const effort = optionalString(input.reasoning_effort)
    if (effort !== undefined) normalized.reasoning_effort = requireEnum(effort, REASONING_EFFORTS, 'reasoning_effort')
    normalized.createdBy = sanitizeActor(input.createdBy, 'user')
    return normalized
  }

  /**
   * Validate and normalize a wire context object (CONTRACT 4.3).
   * @param {unknown} value candidate context
   * @returns {Record<string, any>} detached context
   */
  function normalizeContext(value) {
    if (value === undefined || value === null) return {}
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BridgeError('bad-request', '"context" must be an object')
    }
    /** @type {Record<string, any>} */
    const context = {}
    for (const key of CONTEXT_KEYS) {
      const entry = value[key]
      if (key === 'files' || key === 'add_dirs') {
        if (Array.isArray(entry)) {
          const list = entry.filter((item) => typeof item === 'string' && item !== '')
          if (list.length > 0) context[key] = list.slice()
        }
        continue
      }
      const text = optionalString(entry)
      if (text !== undefined) context[key] = text
    }
    return context
  }

  /**
   * Merge a request's per-message overrides onto a thread snapshot.
   * @param {any} thread thread snapshot
   * @param {Record<string, any>} input per-message overrides
   * @returns {any} effective thread passed to the adapter/host
   */
  function applyOverrides(thread, input) {
    const effective = cloneJson(thread)
    const model = optionalString(input.model)
    if (model !== undefined) effective.model = model
    const effort = optionalString(input.reasoning_effort)
    if (effort !== undefined) effective.reasoning_effort = requireEnum(effort, REASONING_EFFORTS, 'reasoning_effort')
    if (input.context !== undefined) {
      effective.context = { ...effective.context, ...normalizeContext(input.context) }
    }
    return effective
  }

  /**
   * Ask the adapter registry for a harness adapter.
   * @param {string} harness harness id
   * @returns {Promise<any>} adapter
   */
  async function getAdapter(harness) {
    if (!adapters || typeof adapters.get !== 'function') {
      throw new BridgeError('adapter-unavailable', 'no adapter registry is configured for harness "' + harness + '"')
    }
    let adapter
    try {
      adapter = await adapters.get(harness)
    } catch (error) {
      if (error instanceof BridgeError) throw error
      throw new BridgeError(
        'adapter-unavailable',
        'harness "' + harness + '" is not available: ' + errorMessage(error),
      )
    }
    if (!adapter) throw new BridgeError('adapter-unavailable', 'harness "' + harness + '" has no adapter')
    return adapter
  }

  /**
   * Reject a turn when the adapter reports itself unavailable.
   * @param {any} adapter adapter
   * @param {string} harness harness id
   * @returns {Promise<void>}
   */
  async function ensureAdapterAvailable(adapter, harness) {
    if (typeof adapter.describe !== 'function') return
    let info
    try {
      info = await adapter.describe()
    } catch (error) {
      throw new BridgeError(
        'adapter-unavailable',
        'harness "' + harness + '" could not describe itself: ' + errorMessage(error),
      )
    }
    if (info && info.available === false) {
      throw new BridgeError(
        'adapter-unavailable',
        optionalString(info.notes) ?? 'harness "' + harness + '" is not available',
        { harness },
      )
    }
  }

  /**
   * Best-effort adapter setup hook when a thread is created.
   * @param {any} thread created thread
   * @returns {Promise<void>}
   */
  async function openAdapterThread(thread) {
    if (thread.harness === 'dsh') return
    let adapter
    try {
      adapter = await getAdapter(thread.harness)
    } catch (error) {
      logger.warn('bridge: cannot open thread ' + thread.id + ': ' + errorMessage(error))
      return
    }
    if (typeof adapter.openThread !== 'function') return
    try {
      await adapter.openThread({ thread: cloneJson(thread), context: cloneJson(thread.context) })
    } catch (error) {
      logger.warn('bridge: adapter openThread failed for ' + thread.id + ': ' + errorMessage(error))
      await store.updateThread(thread.id, { lastError: errorMessage(error) }).catch(() => {})
    }
  }

  /**
   * Best-effort adapter teardown hook when a thread is closed.
   * @param {any} thread thread being closed
   * @returns {Promise<void>}
   */
  async function closeAdapterThread(thread) {
    if (thread.harness === 'dsh') return
    let adapter
    try {
      adapter = await getAdapter(thread.harness)
    } catch {
      return
    }
    if (typeof adapter.closeThread !== 'function') return
    try {
      await adapter.closeThread({ thread: cloneJson(thread) })
    } catch (error) {
      logger.warn('bridge: adapter closeThread failed for ' + thread.id + ': ' + errorMessage(error))
    }
  }

  /**
   * Create an abort controller for one remote turn: bridge shutdown and the
   * caller's signal abort it, and it always expires after turnTimeoutMs.
   * @param {AbortSignal} [external] caller signal
   * @returns {{signal: AbortSignal, reason: () => any, dispose: () => void}} turn signal
   */
  function createTurnSignal(external) {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new BridgeError('timeout', 'peer turn exceeded ' + turnTimeoutMs + 'ms', { turnTimeoutMs }))
    }, turnTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const forward = () => controller.abort(external.reason)
    if (external) {
      if (external.aborted) forward()
      else external.addEventListener('abort', forward, { once: true })
    }
    activeTurns.add(controller)
    return {
      signal: controller.signal,
      reason: () => controller.signal.reason,
      dispose() {
        clearTimeout(timer)
        activeTurns.delete(controller)
        if (external) external.removeEventListener('abort', forward)
      },
    }
  }

  /**
   * Run one remote turn, append the assistant (or error) message, and return
   * the reply. Never throws without first persisting an error message.
   *
   * @param {{thread: any, userMessage: any, request: Record<string, any>, signal?: AbortSignal}} input turn input
   * @returns {Promise<{reply: any, session: {id: string|null, resumed: boolean}}>} reply + session info
   */
  async function runTurnAndAppend({ thread, userMessage, request, signal }) {
    const turnSignal = createTurnSignal(signal)
    const startedAt = nowMs()
    try {
      if (thread.harness === 'dsh') {
        if (typeof inbound !== 'function') {
          throw new BridgeError('inbound-unavailable', 'this DSH host has no inbound handler configured')
        }
        const outcome = await inbound({
          thread: cloneJson(thread),
          message: cloneJson(userMessage),
          request: { ...request, thread_id: thread.id },
          signal: turnSignal.signal,
        })
        const text = typeof outcome?.text === 'string' ? outcome.text : ''
        const sessionId = optionalString(outcome?.sessionId) ?? optionalString(request?.to?.session_id)
        const meta = {
          ...(isPlainObject(outcome?.meta) ? cloneJson(outcome.meta) : {}),
          durationMs: nowMs() - startedAt,
        }
        if (sessionId) meta.sessionId = sessionId
        const reply = await store.appendMessage(thread.id, {
          role: 'assistant',
          text,
          from: { harness: 'dsh' },
          meta,
        })
        if (sessionId) await store.updateThread(thread.id, { remoteSessionId: sessionId })
        return { reply, session: { id: sessionId ?? null, resumed: Boolean(outcome?.resumed) } }
      }

      const adapter = await getAdapter(thread.harness)
      await ensureAdapterAvailable(adapter, thread.harness)
      const outcome = await adapter.runTurn({
        thread: cloneJson(thread),
        userText: userMessage.text,
        message: cloneJson(userMessage),
        context: cloneJson(thread.context),
        signal: turnSignal.signal,
        onDelta: () => {},
      })
      const text = typeof outcome?.text === 'string' ? outcome.text : ''
      const meta = {
        ...(isPlainObject(outcome?.meta) ? cloneJson(outcome.meta) : {}),
        durationMs: typeof outcome?.meta?.durationMs === 'number' ? outcome.meta.durationMs : nowMs() - startedAt,
      }
      const remoteSessionId = optionalString(outcome?.remoteSessionId)
      if (remoteSessionId) meta.sessionId = remoteSessionId
      const reply = await store.appendMessage(thread.id, {
        role: 'assistant',
        text,
        from: { harness: thread.harness },
        meta,
      })
      if (remoteSessionId) await store.updateThread(thread.id, { remoteSessionId })
      return { reply, session: { id: remoteSessionId ?? null, resumed: Boolean(remoteSessionId) } }
    } catch (error) {
      const mapped = mapTurnError(error, turnSignal)
      try {
        await store.appendMessage(thread.id, {
          role: 'error',
          text: mapped.message,
          from: { harness: thread.harness },
          meta: { code: mapped.code },
        })
      } catch (appendError) {
        logger.warn('bridge: could not record a failed turn: ' + errorMessage(appendError))
      }
      await store.updateThread(thread.id, { lastError: mapped.message }).catch(() => {})
      throw mapped
    } finally {
      turnSignal.dispose()
    }
  }

  /**
   * @param {unknown} error thrown turn error
   * @param {{reason: () => any}} turnSignal turn signal handle
   * @returns {BridgeError} protocol error
   */
  function mapTurnError(error, turnSignal) {
    const reason = turnSignal.reason()
    if (reason instanceof BridgeError) return reason
    if (error instanceof BridgeError) return error
    if (error?.name === 'AbortError' || (reason && reason.name === 'AbortError')) {
      return new BridgeError('timeout', 'peer turn was aborted or timed out')
    }
    return toBridgeError(error, 'adapter-failed')
  }

  /**
   * Wait for a turn, but give up waiting after waitSeconds (the turn keeps
   * running in the background and its reply still lands in the thread).
   * @param {Promise<any>} promise turn promise
   * @param {number} waitSeconds seconds to wait
   * @returns {Promise<{settled: boolean, ok?: boolean, value?: any, error?: any}>} race result
   */
  function raceTurn(promise, waitSeconds) {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ settled: false })
      }, waitSeconds * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      promise.then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ settled: true, ok: true, value })
        },
        (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ settled: true, ok: false, error })
        },
      )
    })
  }

  /**
   * Append a user message and run one turn, optionally awaiting the reply.
   * Programmatic API used by the plugin's tools and the HTTP handlers.
   *
   * @param {{threadId: string, text: string, from?: any, await?: boolean, model?: string, reasoning_effort?: string, context?: any, signal?: AbortSignal, waitSeconds?: number, to?: any}} input send input
   * @returns {Promise<{message: any, reply: any, thread: any}>} append + reply result
   */
  async function sendMessage(input = {}) {
    const threadId = requireString(input.threadId, 'threadId')
    const text = requireString(input.text, 'text')
    const existing = await store.getThread(threadId)
    if (!existing) throw new BridgeError('not-found', 'no peer thread named "' + threadId + '"')
    if (existing.status === 'closed') {
      throw new BridgeError('thread-closed', 'peer thread "' + threadId + '" is closed')
    }
    const message = await store.appendMessage(threadId, {
      role: 'user',
      text,
      from: sanitizeActor(input.from, 'user'),
    })
    const thread = applyOverrides(existing, input)
    const request = {
      model: optionalString(input.model),
      reasoning_effort: optionalString(input.reasoning_effort),
      context: input.context === undefined ? {} : normalizeContext(input.context),
      ...(input.to === undefined ? {} : { to: input.to }),
    }
    const turn = runTurnAndAppend({ thread, userMessage: message, request, signal: input.signal })
    if (input.await !== true) {
      turn.catch((error) => logger.warn('bridge: background turn failed: ' + errorMessage(error)))
      return { message, reply: null, thread: (await store.getThread(threadId)) ?? existing }
    }
    const waitSeconds =
      typeof input.waitSeconds === 'number' && Number.isFinite(input.waitSeconds)
        ? clampWaitSeconds(input.waitSeconds, 0)
        : 0
    if (waitSeconds > 0) {
      const raced = await raceTurn(turn, waitSeconds)
      if (!raced.settled) {
        turn.catch((error) => logger.warn('bridge: background turn failed: ' + errorMessage(error)))
        return { message, reply: null, thread: (await store.getThread(threadId)) ?? existing }
      }
      if (!raced.ok) throw raced.error
      return { message, reply: raced.value.reply, thread: (await store.getThread(threadId)) ?? existing }
    }
    const outcome = await turn
    return { message, reply: outcome.reply, thread: (await store.getThread(threadId)) ?? existing }
  }

  /**
   * Create a thread and run the adapter setup hook.
   * @param {Record<string, any>} [input] thread input
   * @returns {Promise<{thread: any}>} created thread
   */
  async function createThread(input = {}) {
    const normalized = normalizeThreadInput(input)
    const thread = await store.createThread(normalized)
    await openAdapterThread(thread)
    return { thread: (await store.getThread(thread.id)) ?? thread }
  }

  /**
   * List adapters and their AdapterInfo (CONTRACT 4.1).
   * @returns {Promise<Array<Record<string, any>>>} adapter info, in registry order
   */
  async function describeAdapters() {
    if (!adapters || typeof adapters.all !== 'function') return []
    let list
    try {
      list = await adapters.all()
    } catch (error) {
      logger.warn('bridge: listing adapters failed: ' + errorMessage(error))
      return []
    }
    if (!Array.isArray(list)) return []
    return Promise.all(
      list.map(async (adapter) => {
        const harness = optionalString(adapter?.harness) ?? 'unknown'
        try {
          const info = typeof adapter?.describe === 'function' ? await adapter.describe() : null
          const normalized = isPlainObject(info) ? cloneJson(info) : { harness, available: true }
          if (optionalString(normalized.harness) === undefined) normalized.harness = harness
          if (typeof normalized.available !== 'boolean') normalized.available = true
          return normalized
        } catch (error) {
          return { harness, available: false, notes: 'describe() failed: ' + errorMessage(error) }
        }
      }),
    )
  }

  /**
   * List live DSH sessions through the injected callback.
   * @returns {Promise<Array<{id: string, title?: string, status?: string}>>} live sessions
   */
  async function readSessions() {
    if (typeof sessionsFn !== 'function') return []
    try {
      const sessions = await sessionsFn()
      return Array.isArray(sessions) ? cloneJson(sessions) : []
    } catch (error) {
      logger.warn('bridge: listing host sessions failed: ' + errorMessage(error))
      return []
    }
  }

  /**
   * Build the GET /v1/health payload.
   * @returns {Promise<Record<string, any>>} health payload
   */
  async function health() {
    return {
      ok: true,
      version: PROTOCOL_VERSION,
      packageVersion,
      uptimeMs: nowMs() - startedAt,
      host: { harness: 'dsh', pid: process.pid, sessions: await readSessions() },
      adapters: await describeAdapters(),
    }
  }

  // ---- SSE ---------------------------------------------------------------

  /**
   * Assign a global event sequence and fan out to SSE subscribers.
   * @param {any} event store event ({type:'message'|'thread'})
   */
  function broadcast(event) {
    const seq = (eventSeq += 1)
    const payload = { ...cloneJson(event), seq }
    eventBuffer.push({ seq, event: payload })
    if (eventBuffer.length > SSE_BUFFER_SIZE) eventBuffer.shift()
    for (const client of sseClients) {
      writeEvent(client, payload)
    }
  }

  /**
   * @param {{res: import('node:http').ServerResponse, write: (chunk: string) => void}} client SSE client
   * @param {any} payload event payload
   */
  function writeEvent(client, payload) {
    if (client.res.destroyed || client.res.writableEnded) {
      sseClients.delete(client)
      return
    }
    try {
      client.write('id: ' + payload.seq + '\ndata: ' + JSON.stringify(payload) + '\n\n')
    } catch (error) {
      logger.warn('bridge: SSE write failed: ' + errorMessage(error))
      sseClients.delete(client)
    }
  }

  // ---- HTTP handlers -----------------------------------------------------

  /** @param {{res: any}} ctx request context */
  async function handleHealth(ctx) {
    sendJson(ctx.res, 200, await health())
  }

  /** @param {{res: any}} ctx request context */
  async function handleAdapters(ctx) {
    sendJson(ctx.res, 200, { adapters: await describeAdapters() })
  }

  /** @param {{res: any, body: any}} ctx request context */
  async function handleCreateThread(ctx) {
    const created = await createThread(ctx.body)
    sendJson(ctx.res, 201, created)
  }

  /** @param {{res: any, query: Record<string, string>}} ctx request context */
  async function handleListThreads(ctx) {
    /** @type {{status?: string, limit?: number}} */
    const filter = {}
    const status = optionalString(ctx.query.status)
    if (status !== undefined) filter.status = requireEnum(status, THREAD_STATUSES, 'status')
    if (optionalString(ctx.query.limit) !== undefined) {
      const limit = Number(ctx.query.limit)
      if (!Number.isInteger(limit) || limit < 1) throw new BridgeError('bad-request', '"limit" must be a positive integer')
      filter.limit = limit
    }
    sendJson(ctx.res, 200, { threads: await store.listThreads(filter) })
  }

  /** @param {{res: any, params: Record<string, string>, query: Record<string, string>, signal: AbortSignal}} ctx request context */
  async function handleGetThread(ctx) {
    const threadId = ctx.params.id
    const thread = await store.getThread(threadId)
    if (!thread) throw new BridgeError('not-found', 'no peer thread named "' + threadId + '"')
    const after = nonNegativeInt(ctx.query.after, 0)
    const waitSeconds = clampWaitSeconds(Number(ctx.query.wait_seconds ?? 0), 0)
    const messages = await store.readMessages(threadId, { after, waitSeconds, signal: ctx.signal })
    const latest = (await store.getThread(threadId)) ?? thread
    sendJson(ctx.res, 200, {
      thread: latest,
      messages,
      next_cursor: messages.length === 0 ? after : messages[messages.length - 1].seq + 1,
    })
  }

  /** @param {{res: any, params: Record<string, string>, body: any}} ctx request context */
  async function handlePostMessage(ctx) {
    const threadId = ctx.params.id
    const existing = await store.getThread(threadId)
    if (!existing) throw new BridgeError('not-found', 'no peer thread named "' + threadId + '"')
    const body = ctx.body
    const awaitTurn = body.await === true
    const waitSeconds =
      awaitTurn && body.wait_seconds !== undefined
        ? clampWaitSeconds(body.wait_seconds, 0)
        : 0
    const result = await sendMessage({
      threadId,
      text: body.text,
      from: body.from,
      await: awaitTurn,
      model: body.model,
      reasoning_effort: body.reasoning_effort,
      context: body.context,
      waitSeconds,
    })
    sendJson(ctx.res, 200, result)
  }

  /** @param {{res: any, params: Record<string, string>, body: any}} ctx request context */
  async function handleCloseThread(ctx) {
    const threadId = ctx.params.id
    const thread = await store.getThread(threadId)
    if (!thread) throw new BridgeError('not-found', 'no peer thread named "' + threadId + '"')
    const status = optionalString(ctx.body.status) ?? 'closed'
    if (status !== 'closed') throw new BridgeError('bad-request', '"status" must be "closed"')
    await closeAdapterThread(thread)
    sendJson(ctx.res, 200, { thread: await store.closeThread(threadId) })
  }

  /** @param {{res: any, body: any}} ctx request context */
  async function handleInbound(ctx) {
    const body = ctx.body
    const defaultHarness = optionalString(body.to?.session_id) !== undefined ? 'dsh' : undefined
    const harness = requireEnum(optionalString(body.harness) ?? defaultHarness, HARNESSES, 'harness')
    const text = requireString(body.text, 'text')
    const created = await createThread({
      harness,
      title: optionalString(body.title) ?? titleFromText(text),
      model: body.model,
      reasoning_effort: body.reasoning_effort,
      context: body.context,
      createdBy: body.createdBy,
    })
    const threadId = created.thread.id
    let result
    try {
      result = await sendMessage({
        threadId,
        text,
        from: sanitizeActor(body.from, 'user'),
        await: true,
        model: body.model,
        reasoning_effort: body.reasoning_effort,
        context: body.context,
        to: body.to,
        waitSeconds: body.wait_seconds === undefined ? 0 : clampWaitSeconds(body.wait_seconds, 0),
      })
    } catch (error) {
      const mapped = toBridgeError(error, 'adapter-failed')
      if (mapped.details === undefined) mapped.details = { threadId }
      throw mapped
    }
    const reply = result.reply
    const thread = result.thread
    const sessionId =
      optionalString(reply?.meta?.sessionId) ??
      optionalString(body.to?.session_id) ??
      optionalString(thread?.remoteSessionId)
    const resumed = Boolean(optionalString(body.to?.session_id) ?? optionalString(thread?.context?.resume))
    sendJson(ctx.res, 200, {
      thread,
      reply,
      text: typeof reply?.text === 'string' ? reply.text : '',
      session: { id: sessionId ?? null, resumed },
    })
  }

  /** @param {{req: any, res: any, query: Record<string, string>}} ctx request context */
  async function handleEvents(ctx) {
    const after = nonNegativeInt(ctx.query.after, 0)
    const { req, res } = ctx
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    /** @type {{res: any, write: (chunk: string) => void}} */
    const client = {
      res,
      write(chunk) {
        res.write(chunk)
      },
    }
    res.write(': connected\n\n')
    for (const entry of eventBuffer) {
      if (entry.seq > after) writeEvent(client, entry.event)
    }
    sseClients.add(client)
    const heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) return
      res.write(': ping\n\n')
    }, SSE_HEARTBEAT_MS)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
    const cleanup = () => {
      clearInterval(heartbeat)
      sseClients.delete(client)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  router
    .add('GET', '/v1/health', handleHealth)
    .add('GET', '/v1/adapters', handleAdapters)
    .add('GET', '/v1/events', handleEvents)
    .add('POST', '/v1/threads', handleCreateThread)
    .add('GET', '/v1/threads', handleListThreads)
    .add('POST', '/v1/inbound', handleInbound)
    .add('GET', '/v1/threads/:id', handleGetThread)
    .add('POST', '/v1/threads/:id/messages', handlePostMessage)
    .add('POST', '/v1/threads/:id/close', handleCloseThread)

  /**
   * Bind the loopback HTTP server. Safe to call more than once; the returned
   * promise resolves with the base URL.
   * @returns {Promise<string>} bridge base URL
   */
  function listen() {
    if (listenPromise) return listenPromise
    if (closed) return Promise.reject(new BridgeError('internal', 'the bridge is closed'))
    listenPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        listenPromise = null
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        const address = server.address()
        boundPort = address && typeof address === 'object' ? address.port : requestedPort
        url = 'http://' + host + ':' + boundPort
        resolve(url)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(requestedPort, host)
    })
    return listenPromise
  }

  /**
   * Stop the bridge: end SSE clients, abort in-flight turns, close connections
   * and wait for the server to shut down. Idempotent.
   * @returns {Promise<void>}
   */
  async function close() {
    if (closed) return
    closed = true
    try {
      unsubscribeStore()
    } catch {
      /* ignore */
    }
    for (const controller of [...activeTurns]) {
      try {
        controller.abort(new BridgeError('timeout', 'the peer bridge is shutting down'))
      } catch {
        /* ignore */
      }
    }
    activeTurns.clear()
    for (const client of [...sseClients]) {
      try {
        client.res.end()
      } catch {
        /* ignore */
      }
    }
    sseClients.clear()
    await new Promise((resolve) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
      server.closeIdleConnections?.()
      const timer = setTimeout(() => {
        try {
          server.closeAllConnections?.()
        } catch {
          /* ignore */
        }
      }, 50)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  return {
    server,
    router,
    token,
    handle,
    listen,
    start: listen,
    close,
    stop: close,
    health,
    describeAdapters,
    sessions: readSessions,
    createThread,
    sendMessage,
    /** @returns {string} base URL ('' before listen()) */
    get url() {
      return url
    },
    /** @returns {number} requested or bound port */
    get port() {
      return boundPort
    },
    /** @returns {import('node:net').AddressInfo|string|null} raw server address */
    address() {
      return server.address()
    },
    /** @returns {Record<string, any>} effective bridge config */
    get config() {
      return { host, port: boundPort, token, turnTimeoutMs, packageVersion }
    },
  }
}

/**
 * Parse a request URL's pathname without throwing on malformed input.
 * @param {string|undefined} raw request URL
 * @returns {string} pathname
 */
function requestPath(raw) {
  try {
    return new URL(raw ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

/**
 * Parse a request URL's query into a plain object.
 * @param {string|undefined} raw request URL
 * @returns {Record<string, string>} query parameters (last value wins)
 */
function parseQuery(raw) {
  /** @type {Record<string, string>} */
  const query = {}
  try {
    const search = new URL(raw ?? '/', 'http://127.0.0.1').searchParams
    for (const [key, value] of search.entries()) query[key] = value
  } catch {
    /* malformed URL: no query */
  }
  return query
}

/**
 * @param {unknown} value candidate
 * @param {number} fallback default
 * @returns {number} non-negative integer
 */
function nonNegativeInt(value, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return fallback
  return Math.floor(numeric)
}

/** @param {unknown} value candidate @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} value candidate actor
 * @param {string} fallbackHarness default harness
 * @returns {{harness: string, name?: string}} normalized actor
 */
function sanitizeActor(value, fallbackHarness) {
  const harness = isPlainObject(value) ? optionalString(value.harness) ?? fallbackHarness : fallbackHarness
  const actor = { harness }
  const name = isPlainObject(value) ? optionalString(value.name) : undefined
  if (name) actor.name = name
  return actor
}

/**
 * Derive a short thread title from a prompt.
 * @param {string} text prompt text
 * @returns {string} title
 */
function titleFromText(text) {
  const line = String(text).split('\n')[0].trim()
  if (line === '') return 'peer thread'
  return line.length > 120 ? line.slice(0, 117) + '...' : line
}

/** @param {string} value text to hash @returns {Buffer} sha256 digest */
function digest(value) {
  return createHash('sha256').update(String(value)).digest()
}

/**
 * Constant-time buffer comparison that also tolerates different lengths.
 * @param {Buffer} left first digest
 * @param {Buffer} right second digest
 * @returns {boolean} equality
 */
function safeEqual(left, right) {
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * @param {any} logger optional logger
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}} logger facade
 */
function createLogger(logger) {
  const call = (level) => (...args) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](...args)
    } catch {
      /* logging must never break the bridge */
    }
  }
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') }
}

export default createBridge
