/**
 * Shared protocol constants and helpers for the dsh-peer bridge.
 *
 * Zero dependencies, Node >= 20, ESM only. This module is imported by both the
 * DSH plugin host half and the standalone CLI, so it must never import from
 * @deepseek-ai/* or from Electron APIs.
 *
 * @module @caelricluo/dsh-peer/protocol
 */

import { randomBytes } from 'node:crypto'

/** Wire protocol version. Bump only on a breaking change. */
export const PROTOCOL_VERSION = 1

/** Package identity reported over the wire. */
export const PACKAGE_NAME = '@caelricluo/dsh-peer'
export const PACKAGE_VERSION = '0.1.0'

/** Default loopback port. Port 0 asks the OS for a free port. */
export const DEFAULT_PORT = 45710

/** The only host the bridge may bind to. */
export const LOOPBACK_HOST = '127.0.0.1'

/** Default maximum time a single remote turn may take. */
export const DEFAULT_TURN_TIMEOUT_MS = 600_000

/** Maximum time a single HTTP request may wait for new messages. */
export const MAX_WAIT_SECONDS = 300

/** Maximum accepted request body size. */
export const MAX_BODY_BYTES = 1024 * 1024

/** Maximum number of threads retained before the oldest closed ones are pruned. */
export const DEFAULT_MAX_THREADS = 200

/** Harness ids the protocol knows about, in canonical display order. */
export const HARNESSES = Object.freeze(['dsh', 'claude', 'codex', 'codex-desktop'])

/** Reasoning effort levels understood by the adapters. */
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

/** Thread lifecycle states. */
export const THREAD_STATUSES = Object.freeze(['open', 'closed', 'failed'])

/** Message roles. */
export const MESSAGE_ROLES = Object.freeze(['user', 'assistant', 'system', 'error'])

/** Stable machine-readable error codes. */
export const ERROR_CODES = Object.freeze([
  'unauthorized',
  'not-found',
  'bad-request',
  'adapter-unavailable',
  'adapter-failed',
  'timeout',
  'thread-closed',
  'inbound-unavailable',
  'internal',
])

/**
 * Error carrying a stable protocol code and optional structured details.
 * Adapters and the bridge throw this; the HTTP layer maps it to a JSON body.
 */
export class BridgeError extends Error {
  /**
   * @param {string} code one of {@link ERROR_CODES}
   * @param {string} message human-readable explanation
   * @param {Record<string, unknown>} [details] structured, JSON-safe context
   * @param {number} [status] explicit HTTP status override
   */
  constructor(code, message, details, status) {
    super(message)
    this.name = 'BridgeError'
    this.code = ERROR_CODES.includes(code) ? code : 'internal'
    this.details = details
    this.status = status ?? statusForCode(this.code)
  }
}

/**
 * Map a protocol code to its default HTTP status.
 * @param {string} code protocol error code
 * @returns {number} HTTP status
 */
export function statusForCode(code) {
  switch (code) {
    case 'unauthorized': return 401
    case 'not-found': return 404
    case 'bad-request': return 400
    case 'thread-closed': return 409
    case 'adapter-unavailable': return 503
    case 'inbound-unavailable': return 503
    case 'timeout': return 504
    case 'adapter-failed': return 502
    default: return 500
  }
}

/** @returns {string} a 12-hex-character opaque id suffix */
export function shortId() {
  return randomBytes(6).toString('hex')
}

/** @returns {string} a new thread id */
export function newThreadId() {
  return `thr_${shortId()}`
}

/** @returns {string} a new message id */
export function newMessageId() {
  return `msg_${shortId()}`
}

/** @returns {string} a 32-byte hex bearer token */
export function newToken() {
  return randomBytes(32).toString('hex')
}

/**
 * Convert any thrown value into a BridgeError without losing the message.
 * @param {unknown} error thrown value
 * @param {string} [fallbackCode] code used when the value carries none
 * @returns {BridgeError}
 */
export function toBridgeError(error, fallbackCode = 'internal') {
  if (error instanceof BridgeError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = fallbackCode && ERROR_CODES.includes(fallbackCode) ? fallbackCode : 'internal'
  return new BridgeError(code, message)
}

/** @returns {number} current epoch milliseconds */
export function nowMs() {
  return Date.now()
}

/** @returns {string} current time as an ISO-8601 string */
export function nowIso() {
  return new Date(nowMs()).toISOString()
}

/**
 * Clamp a requested wait duration.
 * @param {unknown} seconds caller-supplied seconds
 * @param {number} [fallback] value used when absent or invalid
 * @returns {number} clamped seconds in [0, MAX_WAIT_SECONDS]
 */
export function clampWaitSeconds(seconds, fallback = 0) {
  const value = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : fallback
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(value)))
}

/**
 * Assert a value is a non-empty string.
 * @param {unknown} value candidate
 * @param {string} field field name for the error message
 * @returns {string}
 */
export function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeError('bad-request', `"${field}" must be a non-empty string`)
  }
  return value
}

/**
 * Read an optional string field, returning undefined for absent blanks.
 * @param {unknown} value candidate
 * @returns {string|undefined}
 */
export function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Assert one of a fixed set of values.
 * @template T
 * @param {unknown} value candidate
 * @param {readonly T[]} allowed allowed values
 * @param {string} field field name for the error message
 * @returns {T}
 */
export function requireEnum(value, allowed, field) {
  if (!allowed.includes(/** @type {T} */ (value))) {
    throw new BridgeError('bad-request', `"${field}" must be one of: ${allowed.join(', ')}`)
  }
  return /** @type {T} */ (value)
}

/**
 * Deep-copy a JSON-safe value.
 * @template T
 * @param {T} value source
 * @returns {T}
 */
export function cloneJson(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

/**
 * Heuristic check that a harness command exists on PATH without spawning it.
 * Adapters that need the resolved absolute path should still run `which`/probe.
 * @param {string} name executable base name
 * @returns {boolean} whether it looks like a path or a bare command name
 */
export function looksLikeCommand(name) {
  return typeof name === 'string' && name.trim() !== ''
}
