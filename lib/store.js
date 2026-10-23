/**
 * Thread and message persistence for the dsh-peer bridge.
 *
 * Design (CONTRACT section 3):
 * - `$PEER_HOME/threads/index.json` holds thread metadata and is rewritten
 *   atomically (temp file + fsync + rename) so a crash never leaves a torn
 *   index.
 * - `$PEER_HOME/threads/<threadId>.jsonl` is the append-only message log,
 *   one Message JSON object per line. It is the durable transcript; the index
 *   is a cache that can be rebuilt from the logs.
 * - Appends for one thread are serialized through a per-thread promise queue,
 *   so concurrent callers always get strictly increasing `seq` values.
 * - `readMessages({ waitSeconds })` long-polls through an in-memory waiters
 *   map that is resolved by `appendMessage()`.
 *
 * Zero dependencies, Node >= 20, ESM only. Safe to import from plain Node.
 *
 * @module @caelricluo/dsh-peer/store
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  BridgeError,
  DEFAULT_MAX_THREADS,
  HARNESSES,
  MESSAGE_ROLES,
  THREAD_STATUSES,
  cloneJson,
  clampWaitSeconds,
  newMessageId,
  newThreadId,
  nowIso,
  optionalString,
} from './protocol.js'

/** Fields in a normalized thread context object (CONTRACT 4.3). */
const CONTEXT_KEYS = Object.freeze(['cwd', 'system', 'append_system', 'files', 'resume', 'add_dirs'])

/**
 * @typedef {{ id: string, title?: string }} Actor
 * @typedef {Record<string, unknown>} ThreadContext
 *
 * @typedef {object} Message
 * @property {number} seq
 * @property {string} id
 * @property {string} threadId
 * @property {'user'|'assistant'|'system'|'error'} role
 * @property {string} text
 * @property {string} createdAt
 * @property {Actor} from
 * @property {Record<string, unknown>} meta
 *
 * @typedef {object} Thread
 * @property {string} id
 * @property {string} harness
 * @property {string} title
 * @property {string|null} model
 * @property {string|null} reasoning_effort
 * @property {ThreadContext} context
 * @property {'open'|'closed'|'failed'} status
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {Actor} createdBy
 * @property {string|null} remoteSessionId
 * @property {number} messageCount
 * @property {string|null} lastError
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function textOr(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/**
 * Normalize an actor reference (message.from / thread.createdBy).
 * @param {unknown} value candidate
 * @param {string} fallbackHarness harness used when the candidate is absent
 * @returns {Actor}
 */
function sanitizeActor(value, fallbackHarness) {
  const harness = isPlainObject(value) ? optionalString(value.harness) ?? fallbackHarness : fallbackHarness
  const actor = { harness }
  const name = isPlainObject(value) ? optionalString(value.name) : undefined
  if (name) actor.name = name
  return actor
}

/**
 * Normalize a thread context object, dropping unknown keys and non-strings.
 * @param {unknown} value candidate context
 * @returns {ThreadContext}
 */
function sanitizeContext(value) {
  if (!isPlainObject(value)) return {}
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
 * Build a logger facade. Logging must never break the store.
 * @param {any} logger optional logger
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
function createLogger(logger) {
  const call = (level) => (...args) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](...args)
    } catch {
      /* ignore logger failures */
    }
  }
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') }
}

/**
 * Create the file-backed thread store.
 *
 * @param {object} [options]
 * @param {string} [options.home] peer home directory (defaults to `$DSH_PEER_HOME` or `~/.dsh-peer`)
 * @param {number} [options.maxThreads] retention target for {@link Store.prune}
 * @param {any} [options.logger] optional logger ({debug,info,warn,error})
 * @param {Record<string, string|undefined>} [options.env] environment source
 * @returns {Store} store instance (call {@link Store.init} before use)
 */
export function createStore(options = {}) {
  const env = options.env ?? process.env
  const home = resolveHome(options, env)
  const threadsDir = join(home, 'threads')
  const indexFile = join(threadsDir, 'index.json')
  const logger = createLogger(options.logger)
  const maxThreads = normalizeMaxThreads(options.maxThreads, DEFAULT_MAX_THREADS)

  /** @type {Map<string, Thread>} */
  const threads = new Map()
  /** @type {Map<string, Message[]>} */
  const messages = new Map()
  /** @type {Map<string, Set<{after: number, finish: (list: Message[]) => void}>>} */
  const waiters = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const appendQueues = new Map()
  /** @type {Set<(event: any) => void>} */
  const listeners = new Set()

  /** @type {Promise<void>|null} */
  let initPromise = null
  /** Serializes index.json rewrites so the last writer wins cleanly. */
  let indexQueue = Promise.resolve()
  let closed = false

  function messageFile(threadId) {
    return join(threadsDir, threadId + '.jsonl')
  }

  /**
   * @param {string|undefined} id thread id
   * @returns {Thread} thread metadata
   */
  function requireThreadSync(id) {
    const thread = threads.get(String(id ?? ''))
    if (!thread) throw new BridgeError('not-found', 'no peer thread named "' + String(id) + '"')
    return thread
  }

  /**
   * Snapshot messages with `seq >= after`, detached from the in-memory log.
   * @param {string} threadId thread id
   * @param {number} after inclusive lower bound
   * @returns {Message[]}
   */
  function messagesAfter(threadId, after) {
    const list = messages.get(threadId) ?? []
    if (after <= 0) return list.map((message) => cloneJson(message))
    const out = []
    for (const message of list) {
      if (message.seq >= after) out.push(cloneJson(message))
    }
    return out
  }

  /**
   * @param {any} event event payload
   */
  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        logger.warn('store: subscriber failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  /**
   * Resolve every waiter blocked on one thread with its current transcript.
   * @param {string} threadId thread id
   */
  function wakeWaiters(threadId) {
    const set = waiters.get(threadId)
    if (!set) return
    for (const waiter of [...set]) {
      waiter.finish(messagesAfter(threadId, waiter.after))
    }
  }

  /**
   * @param {string} threadId thread id
   * @param {Message} message appended message
   */
  function notifyWaiters(threadId, message) {
    const set = waiters.get(threadId)
    if (!set) return
    for (const waiter of [...set]) {
      if (message.seq >= waiter.after) waiter.finish(messagesAfter(threadId, waiter.after))
    }
  }

  /**
   * Wait for the next append on a thread (long-poll primitive).
   * @param {string} threadId thread id
   * @param {number} after inclusive lower bound
   * @param {number} waitSeconds clamped wait duration
   * @param {AbortSignal} [signal] optional cancellation
   * @returns {Promise<Message[]>}
   */
  function waitForAppend(threadId, after, waitSeconds, signal) {
    if (closed || signal?.aborted) return Promise.resolve([])
    return new Promise((resolve) => {
      /** @type {{after: number, finish: (list: Message[]) => void}} */
      const waiter = { after, finish: () => {} }
      let settled = false
      let timer = null
      const onAbort = () => finish([])
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        const set = waiters.get(threadId)
        set?.delete(waiter)
        if (set && set.size === 0) waiters.delete(threadId)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      const finish = (list) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(list)
      }
      waiter.finish = finish
      timer = setTimeout(() => finish([]), Math.max(0, waitSeconds) * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      let set = waiters.get(threadId)
      if (!set) {
        set = new Set()
        waiters.set(threadId, set)
      }
      set.add(waiter)
    })
  }

  /**
   * Serialize one append task behind previous appends for the same thread.
   * @param {string} threadId thread id
   * @param {() => Promise<Message>} task task to run
   * @returns {Promise<Message>}
   */
  function enqueueAppend(threadId, task) {
    const previous = appendQueues.get(threadId) ?? Promise.resolve()
    const run = previous.then(task, task)
    appendQueues.set(threadId, run.then(() => undefined, () => undefined))
    return run
  }

  /**
   * Serialize and apply an index.json rewrite.
   * @returns {Promise<void>}
   */
  function persistIndex() {
    const payload = JSON.stringify(
      { version: 1, updatedAt: nowIso(), threads: [...threads.values()].map((thread) => cloneJson(thread)) },
      null,
      2,
    ) + '\n'
    const run = indexQueue.then(() => writeFileAtomic(indexFile, payload))
    indexQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Load `index.json`. A missing or corrupt file is not fatal: the store
   * rebuilds thread metadata from the per-thread JSONL logs.
   * @returns {Promise<Thread[]>}
   */
  async function loadIndex() {
    let raw
    try {
      raw = await fs.readFile(indexFile, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn('store: could not read index.json: ' + error.message)
      return []
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.threads) ? parsed.threads : []
      return list.filter((thread) => isPlainObject(thread) && typeof thread.id === 'string')
    } catch (error) {
      logger.warn('store: index.json is corrupt (' + error.message + '); rebuilding from message logs')
      return []
    }
  }

  /**
   * Load one append-only JSONL message log, skipping corrupt lines.
   * @param {string} threadId thread id
   * @returns {Promise<Message[]>}
   */
  async function loadMessages(threadId) {
    let raw
    try {
      raw = await fs.readFile(messageFile(threadId), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn('store: could not read ' + threadId + '.jsonl: ' + error.message)
      return []
    }
    const list = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed)
        if (!isPlainObject(parsed) || typeof parsed.text !== 'string' || typeof parsed.role !== 'string') continue
        list.push(normalizeMessage(parsed, threadId, list.length))
      } catch {
        logger.warn('store: skipping a corrupt JSONL line in ' + threadId + '.jsonl')
      }
    }
    list.sort((a, b) => a.seq - b.seq)
    return list.map((message, index) => (message.seq === index ? message : { ...message, seq: index }))
  }

  /**
   * Ensure a thread's JSONL file exists without truncating it.
   * @param {string} threadId thread id
   * @returns {Promise<void>}
   */
  async function touchMessageFile(threadId) {
    const handle = await fs.open(messageFile(threadId), 'a', 0o600)
    await handle.close()
  }

  /**
   * Initialize the store: create directories, load the index, load logs and
   * recover threads whose log exists but whose index entry is missing.
   * Idempotent.
   * @returns {Promise<void>}
   */
  async function init() {
    if (initPromise) return initPromise
    initPromise = (async () => {
      await fs.mkdir(threadsDir, { recursive: true, mode: 0o700 })
      for (const stored of await loadIndex()) {
        threads.set(stored.id, normalizeThread(stored))
      }
      let entries = []
      try {
        entries = await fs.readdir(threadsDir)
      } catch (error) {
        logger.warn('store: could not list ' + threadsDir + ': ' + error.message)
      }
      const discovered = []
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue
        const threadId = name.slice(0, -'.jsonl'.length)
        if (!/^thr_[A-Za-z0-9_-]+$/.test(threadId)) continue
        const list = await loadMessages(threadId)
        messages.set(threadId, list)
        if (!threads.has(threadId)) {
          const first = list[0]
          discovered.push(threadId)
          threads.set(threadId, normalizeThread({
            id: threadId,
            harness: first?.from?.harness && HARNESSES.includes(first.from.harness) ? first.from.harness : 'dsh',
            title: 'Recovered thread',
            context: {},
            status: 'open',
            createdAt: first?.createdAt ?? nowIso(),
            updatedAt: list.at(-1)?.createdAt ?? first?.createdAt ?? nowIso(),
            createdBy: { harness: 'user' },
            messageCount: list.length,
          }))
        }
      }
      let recovered = false
      for (const [threadId, thread] of threads) {
        if (!messages.has(threadId)) messages.set(threadId, await loadMessages(threadId))
        const list = messages.get(threadId)
        if (thread.messageCount !== list.length) {
          thread.messageCount = list.length
          recovered = true
        }
        await touchMessageFile(threadId)
      }
      if (discovered.length > 0 || recovered) {
        await persistIndex().catch((error) => {
          logger.warn('store: rewriting a recovered index.json failed: ' + error.message)
        })
      }
    })()
    return initPromise
  }

  /**
   * Create a new thread.
   * @param {Partial<Thread> & {harness?: string, title?: string}} input thread fields
   * @returns {Promise<Thread>} the created thread
   */
  async function createThread(input = {}) {
    await init()
    const now = nowIso()
    let id = newThreadId()
    while (threads.has(id)) id = newThreadId()
    const harness = optionalString(input.harness) ?? 'dsh'
    const thread = normalizeThread({
      id,
      harness,
      title: optionalString(input.title) ?? 'peer thread',
      model: optionalString(input.model) ?? null,
      reasoning_effort: optionalString(input.reasoning_effort) ?? null,
      context: sanitizeContext(input.context),
      status: 'open',
      createdAt: now,
      updatedAt: now,
      createdBy: sanitizeActor(input.createdBy, 'user'),
      remoteSessionId: optionalString(input.remoteSessionId) ?? null,
      messageCount: 0,
      lastError: null,
    })
    threads.set(id, thread)
    messages.set(id, [])
    await touchMessageFile(id)
    await persistIndex()
    const copy = cloneJson(thread)
    emit({ type: 'thread', thread: copy })
    return copy
  }

  /**
   * @param {string} id thread id
   * @returns {Promise<Thread|undefined>} detached thread metadata
   */
  async function getThread(id) {
    await init()
    const thread = threads.get(String(id ?? ''))
    return thread ? cloneJson(thread) : undefined
  }

  /**
   * List threads, newest first (by createdAt).
   * @param {{status?: string, limit?: number}} [filter] optional filter
   * @returns {Promise<Thread[]>} detached thread metadata
   */
  async function listThreads(filter = {}) {
    await init()
    const status = optionalString(filter.status)
    if (status !== undefined && !THREAD_STATUSES.includes(status)) {
      throw new BridgeError('bad-request', '"status" must be one of: ' + THREAD_STATUSES.join(', '))
    }
    let limit
    if (filter.limit !== undefined) {
      if (!Number.isInteger(filter.limit) || filter.limit < 1) {
        throw new BridgeError('bad-request', '"limit" must be a positive integer')
      }
      limit = filter.limit
    }
    let list = [...threads.values()]
    if (status !== undefined) list = list.filter((thread) => thread.status === status)
    list.sort((a, b) => {
      const created = b.createdAt.localeCompare(a.createdAt)
      return created !== 0 ? created : b.updatedAt.localeCompare(a.updatedAt)
    })
    if (limit !== undefined) list = list.slice(0, limit)
    return list.map((thread) => cloneJson(thread))
  }

  /**
   * Merge a patch into thread metadata and persist it.
   * @param {string} id thread id
   * @param {Partial<Thread>} patch fields to change (context is merged shallowly)
   * @returns {Promise<Thread>} detached updated metadata
   */
  async function updateThread(id, patch = {}) {
    await init()
    const thread = requireThreadSync(id)
    const next = { ...(isPlainObject(patch) ? patch : {}) }
    if (next.title !== undefined) thread.title = textOr(next.title, thread.title)
    if (next.model !== undefined) thread.model = optionalString(next.model) ?? null
    if (next.reasoning_effort !== undefined) thread.reasoning_effort = optionalString(next.reasoning_effort) ?? null
    if (next.remoteSessionId !== undefined) thread.remoteSessionId = optionalString(next.remoteSessionId) ?? null
    if (next.lastError !== undefined) thread.lastError = optionalString(next.lastError) ?? null
    if (next.status !== undefined) {
      if (!THREAD_STATUSES.includes(next.status)) {
        throw new BridgeError('bad-request', '"status" must be one of: ' + THREAD_STATUSES.join(', '))
      }
      thread.status = next.status
    }
    if (next.context !== undefined) {
      thread.context = { ...thread.context, ...sanitizeContext(next.context) }
    }
    if (next.createdBy !== undefined) thread.createdBy = sanitizeActor(next.createdBy, thread.createdBy.harness)
    thread.updatedAt = nowIso()
    await persistIndex()
    const copy = cloneJson(thread)
    emit({ type: 'thread', thread: copy })
    return copy
  }

  /**
   * Append one message to a thread. Appends for a single thread are
   * serialized, so concurrent callers get strictly increasing sequence
   * numbers.
   * @param {string} threadId thread id
   * @param {{role: string, text: string, from?: Actor, meta?: Record<string, unknown>, createdAt?: string, id?: string}} message message fields
   * @returns {Promise<Message>} the appended message
   */
  async function appendMessage(threadId, message = {}) {
    await init()
    const thread = requireThreadSync(threadId)
    if (thread.status === 'closed') {
      throw new BridgeError('thread-closed', 'peer thread "' + thread.id + '" is closed')
    }
    if (!isPlainObject(message) || typeof message.role !== 'string' || !MESSAGE_ROLES.includes(message.role)) {
      throw new BridgeError('bad-request', '"role" must be one of: ' + MESSAGE_ROLES.join(', '))
    }
    const role = message.role
    return enqueueAppend(thread.id, async () => {
      const list = messages.get(thread.id) ?? []
      const createdAt = optionalString(message.createdAt) ?? nowIso()
      /** @type {Message} */
      const full = {
        seq: list.length,
        id: optionalString(message.id) ?? newMessageId(),
        threadId: thread.id,
        role,
        text: typeof message.text === 'string' ? message.text : String(message.text ?? ''),
        createdAt,
        from: sanitizeActor(message.from, 'user'),
        meta: isPlainObject(message.meta) ? cloneJson(message.meta) : {},
      }
      const line = JSON.stringify(full) + '\n'
      const handle = await fs.open(messageFile(thread.id), 'a', 0o600)
      try {
        await handle.write(line, null, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      list.push(full)
      messages.set(thread.id, list)
      thread.messageCount = list.length
      thread.updatedAt = nowIso()
      if (full.role === 'error') thread.lastError = full.text
      await persistIndex()
      const copy = cloneJson(full)
      notifyWaiters(thread.id, copy)
      emit({ type: 'message', threadId: thread.id, message: copy })
      return copy
    })
  }

  /**
   * Read messages with `seq >= after`, optionally long-polling until a new
   * message arrives or the wait expires.
   * @param {string} threadId thread id
   * @param {{after?: number, waitSeconds?: number, signal?: AbortSignal}} [options] read options
   * @returns {Promise<Message[]>} detached messages (empty on itimeout)
   */
  async function readMessages(threadId, options = {}) {
    await init()
    const thread = requireThreadSync(threadId)
    const after = Number.isFinite(options.after) ? Math.max(0, Math.floor(options.after)) : 0
    const waitSeconds = clampWaitSeconds(options.waitSeconds, 0)
    const immediate = messagesAfter(thread.id, after)
    // A closed thread can never grow again: never long-poll it, just return the
    // current tail so clients can observe the closure instead of hanging.
    if (immediate.length > 0 || waitSeconds <= 0 || thread.status === 'closed' || closed) return immediate
    return waitForAppend(thread.id, after, waitSeconds, options.signal)
  }

  /**
   * Close a thread. Idempotent; history stays readable.
   * @param {string} id thread id
   * @returns {Promise<Thread>} detached metadata
   */
  async function closeThread(id) {
    await init()
    const thread = requireThreadSync(id)
    if (thread.status !== 'closed') {
      thread.status = 'closed'
      thread.updatedAt = nowIso()
      await persistIndex()
      emit({ type: 'thread', thread: cloneJson(thread) })
      wakeWaiters(thread.id)
    }
    return cloneJson(thread)
  }

  /**
   * Register a listener for thread/message events.
   * @param {(event: any) => void} listener event listener
   * @returns {() => void} unsubscribe
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new BridgeError('bad-request', 'subscribe() requires a function')
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /**
   * Delete the oldest closed threads until at most `limit` threads remain.
   * Open threads are never pruned.
   * @param {number} [limit] retention target (defaults to the store option)
   * @returns {Promise<string[]>} ids of removed threads
   */
  async function prune(limit = maxThreads) {
    await init()
    const target = normalizeMaxThreads(limit, maxThreads)
    let overflow = threads.size - target
    if (overflow <= 0) return []
    const closed = [...threads.values()]
      .filter((thread) => thread.status === 'closed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const removed = []
    for (const thread of closed) {
      if (overflow <= 0) break
      threads.delete(thread.id)
      messages.delete(thread.id)
      appendQueues.delete(thread.id)
      wakeWaiters(thread.id)
      waiters.delete(thread.id)
      removed.push(thread.id)
      overflow -= 1
    }
    if (removed.length === 0) return []
    for (const threadId of removed) {
      await fs.rm(messageFile(threadId), { force: true }).catch(() => {})
    }
    await persistIndex()
    return removed
  }

  /**
   * Flush pending index writes and release long-poll waiters.
   * @returns {Promise<void>}
   */
  async function close() {
    if (closed) return
    closed = true
    for (const threadId of [...waiters.keys()]) wakeWaiters(threadId)
    waiters.clear()
    listeners.clear()
    await indexQueue.catch(() => {})
  }

  return {
    home,
    threadsDir,
    indexFile,
    messageFile,
    init,
    createThread,
    getThread,
    listThreads,
    updateThread,
    appendMessage,
    readMessages,
    closeThread,
    subscribe,
    prune,
    close,
  }
}

/**
 * Rebuild a complete thread record from a possibly partial index entry.
 * @param {Partial<Thread>} value raw thread
 * @returns {Thread} normalized thread
 */
function normalizeThread(value) {
  const now = nowIso()
  const status = THREAD_STATUSES.includes(value.status) ? value.status : 'open'
  const harness = optionalString(value.harness) ?? 'dsh'
  return {
    id: String(value.id ?? ''),
    harness,
    title: optionalString(value.title) ?? 'peer thread',
    model: optionalString(value.model) ?? null,
    reasoning_effort: optionalString(value.reasoning_effort) ?? null,
    context: sanitizeContext(value.context),
    status,
    createdAt: optionalString(value.createdAt) ?? now,
    updatedAt: optionalString(value.updatedAt) ?? optionalString(value.createdAt) ?? now,
    createdBy: sanitizeActor(value.createdBy, 'user'),
    remoteSessionId: optionalString(value.remoteSessionId) ?? null,
    messageCount: Number.isInteger(value.messageCount) && value.messageCount >= 0 ? value.messageCount : 0,
    lastError: optionalString(value.lastError) ?? null,
  }
}

/**
 * Rebuild a complete message record from a JSONL line.
 * @param {Record<string, any>} value raw message
 * @param {string} threadId owning thread id
 * @param {number} fallbackSeq ordinal used when seq is missing/invalid
 * @returns {Message} normalized message
 */
function normalizeMessage(value, threadId, fallbackSeq) {
  const role = MESSAGE_ROLES.includes(value.role) ? value.role : 'system'
  return {
    seq: Number.isInteger(value.seq) && value.seq >= 0 ? value.seq : fallbackSeq,
    id: optionalString(value.id) ?? newMessageId(),
    threadId: optionalString(value.threadId) ?? threadId,
    role,
    text: typeof value.text === 'string' ? value.text : String(value.text ?? ''),
    createdAt: optionalString(value.createdAt) ?? nowIso(),
    from: sanitizeActor(value.from, 'user'),
    meta: isPlainObject(value.meta) ? cloneJson(value.meta) : {},
  }
}

/**
 * Resolve the peer home directory.
 * @param {{home?: string, peerHome?: string}} options store options
 * @param {Record<string, string|undefined>} env environment source
 * @returns {string} absolute peer home
 */
function resolveHome(options, env) {
  const explicit = optionalString(options.home) ?? optionalString(options.peerHome)
  if (explicit) return explicit
  const fromEnv = optionalString(env.DSH_PEER_HOME)
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh-peer')
}

/**
 * Clamp a retention target to a positive integer.
 * @param {unknown} value candidate
 * @param {number} fallback default
 * @returns {number} positive integer
 */
function normalizeMaxThreads(value, fallback) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return numeric >= 1 ? numeric : fallback
}

/**
 * Write a file atomically: same-directory temp file, fsync, rename.
 * @param {string} file destination
 * @param {string} contents UTF-8 contents
 * @returns {Promise<void>}
 */
async function writeFileAtomic(file, contents) {
  const tmp = join(dirname(file), '.' + basename(file) + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp')
  const handle = await fs.open(tmp, 'wx', 0o600)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true })
    throw error
  }
}

export default createStore
