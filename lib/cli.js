/**
 * Zero-dependency CLI client for the dsh-peer loopback bridge.
 *
 * Implements CONTRACT section 7 exactly:
 *
 *   peer status [--json]
 *   peer ask    --to <harness> [options] <prompt>|-
 *   peer send   --thread T [--wait SECONDS] <prompt>|-
 *   peer read   --thread T [--after N] [--wait SECONDS] [--follow]
 *   peer threads [--json]
 *   peer close  --thread T
 *   peer doctor [--json]
 *   peer help
 *
 * Discovery precedence (CONTRACT section 3):
 *   URL:   --url > PEER_BRIDGE_URL > $PEER_HOME/bridge.json > http://127.0.0.1:45710
 *   Token: --token > PEER_BRIDGE_TOKEN > $PEER_HOME/bridge.json
 *
 * Exit codes: 0 ok, 1 usage/other, 2 bridge unreachable, 3 unauthorized,
 * 4 remote turn failed. Text mode for ask/send prints only the reply text on
 * stdout; diagnostics go to stderr.
 *
 * Only node builtins and ./protocol.js are imported, so this module (and
 * bin/peer.mjs) run outside the DSH app with plain node.
 *
 * @module @caelricluo/dsh-peer/cli
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  DEFAULT_PORT,
  HARNESSES,
  LOOPBACK_HOST,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  optionalString,
} from './protocol.js'

/** Default seconds an ask/send waits for the remote answer. */
const DEFAULT_WAIT_SECONDS = 300

/** Long-poll slice used by peer read --follow. */
const FOLLOW_WAIT_SECONDS = 2

/** Default timeout for simple metadata requests. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Commands implemented by this CLI. */
const COMMANDS = Object.freeze(['status', 'ask', 'send', 'read', 'threads', 'close', 'doctor'])

/** Flag table: CLI name -> option key and value kind. */
const FLAGS = Object.freeze({
  '--json': { key: 'json', kind: 'boolean' },
  '--to': { key: 'to', kind: 'string' },
  '--model': { key: 'model', kind: 'string' },
  '--effort': { key: 'effort', kind: 'string' },
  '--cwd': { key: 'cwd', kind: 'string' },
  '--system': { key: 'system', kind: 'string' },
  '--append-system': { key: 'appendSystem', kind: 'string' },
  '--file': { key: 'files', kind: 'list' },
  '--session': { key: 'session', kind: 'string' },
  '--resume': { key: 'resume', kind: 'string' },
  '--thread': { key: 'thread', kind: 'string' },
  '--wait': { key: 'wait', kind: 'number' },
  '--after': { key: 'after', kind: 'number' },
  '--follow': { key: 'follow', kind: 'boolean' },
  '--url': { key: 'url', kind: 'string' },
  '--token': { key: 'token', kind: 'string' },
  '--help': { key: 'help', kind: 'boolean' },
  '-h': { key: 'help', kind: 'boolean' },
  '--version': { key: 'version', kind: 'boolean' },
})

/** Usage help printed by peer help / --help. */
const HELP_TEXT = [
  'peer - cross-harness bridge client (DSH <-> Claude Code / Codex)',
  '',
  'Usage:',
  '  peer status [--json]                    bridge health, adapters, live DSH sessions',
  '  peer ask --to <harness> [options] <prompt>|-',
  '                                          one-shot question, prints the reply',
  '  peer send --thread <id> [--wait N] <prompt>|-',
  '                                          send into an existing thread',
  '  peer read --thread <id> [--after N] [--wait N] [--follow]',
  '                                          print thread messages',
  '  peer threads [--json]                   list threads',
  '  peer close --thread <id>                close a thread',
  '  peer doctor [--json]                    discovery + token + adapter diagnosis',
  '  peer help                               this help',
  '',
  'Ask/send options:',
  '  --to <harness>            dsh | claude | codex | codex-desktop (required for ask)',
  '  --model <id>              peer model override',
  '  --effort <level>          low | medium | high | xhigh | max',
  '  --cwd <dir>               working directory for the peer turn',
  '  --system <text|@file>     complete replacement system prompt',
  '  --append-system <text|@file>  appended system prompt',
  '  --file <path>             context file (repeatable)',
  '  --session <id>            dsh only: deliver into a live DSH session',
  '  --resume <id>             remote session id (codex-desktop thread, claude/codex session)',
  '  --thread <id>             continue an existing thread instead',
  '  --wait <seconds>          wait cap, default 300; 0 = fire and forget',
  '  --after <n>               (read) first message ordinate to print',
  '  --follow                  (read) keep polling for new messages',
  '  --json                    machine-readable output',
  '',
  'Discovery:',
  '  URL:   --url > PEER_BRIDGE_URL > $PEER_HOME/bridge.json > http://' + LOOPBACK_HOST + ':' + DEFAULT_PORT,
  '  Token: --token > PEER_BRIDGE_TOKEN > $PEER_HOME/bridge.json',
  '  PEER_HOME = $DSH_PEER_HOME || ~/.dsh-peer',
  '',
  'Exit codes: 0 ok, 1 usage/other, 2 bridge unreachable, 3 unauthorized,',
  '            4 remote turn failed',
  '',
  'Examples:',
  '  peer status --json',
  '  peer ask --to dsh "Summarize the current plan"',
  '  echo "review this diff" | peer ask --to claude -',
  '  peer ask --to dsh --session session-abc --file src/app.ts "Review this file"',
  '  peer ask --to codex --model gpt-5-codex --effort high --cwd ~/proj "Explain the build"',
  '  peer ask --to codex-desktop --effort low "What is the next step?"',
  '  peer ask --to codex-desktop --resume <app-server-thread-id> "Continue that plan"',
  '  peer send --thread thr_123 --wait 60 "follow up"',
  '  peer read --thread thr_123 --after 4 --wait 30',
  '  peer read --thread thr_123 --follow',
  '',
].join('\n')

/**
 * Error carrying an exit code and a stable kind.
 */
export class CliError extends Error {
  /**
   * @param {string} message human-readable message
   * @param {number} [exitCode] process exit code (default 1)
   * @param {string} [code] stable kind (usage, unauthorized, unreachable, timeout, aborted, ...)
   */
  constructor(message, exitCode = 1, code = 'error') {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.code = code
  }
}

/** Usage error: always exit code 1. */
export class UsageError extends CliError {
  /** @param {string} message human-readable message */
  constructor(message) {
    super(message, 1, 'usage')
    this.name = 'UsageError'
  }
}

/**
 * Parse CLI arguments into { command, options, positional }.
 *
 * Supports --flag value, --flag=value, repeatable --file, '-' as the prompt
 * placeholder, and flags before or after the command. Never touches the
 * network or the filesystem.
 *
 * @param {string[]} [argv] argument list (without node/script)
 * @returns {{command: string|null, options: Record<string, any>, positional: string[]}} parsed argv
 * @throws {UsageError} on unknown flags, missing values, or invalid numbers
 */
export function parseArgs(argv = []) {
  /** @type {Record<string, any>} */
  const options = {}
  /** @type {string[]} */
  const tokens = []
  let index = 0
  while (index < argv.length) {
    const raw = String(argv[index])
    if (raw === '--') {
      for (let rest = index + 1; rest < argv.length; rest += 1) tokens.push(String(argv[rest]))
      break
    }
    if (raw === '-') {
      tokens.push(raw)
      index += 1
      continue
    }
    if (raw.startsWith('--') || raw === '-h') {
      let name = raw
      /** @type {string|undefined} */
      let inline
      if (raw.startsWith('--')) {
        const equals = raw.indexOf('=')
        if (equals !== -1) {
          name = raw.slice(0, equals)
          inline = raw.slice(equals + 1)
        }
      }
      const spec = FLAGS[name]
      if (!spec) throw new UsageError('unknown option "' + name + '"')
      if (spec.kind === 'boolean') {
        if (inline !== undefined) throw new UsageError(name + ' does not take a value')
        options[spec.key] = true
        index += 1
        continue
      }
      /** @type {string|undefined} */
      let value = inline
      if (value === undefined) {
        const next = argv[index + 1]
        if (next === undefined) throw new UsageError(name + ' requires a value')
        value = String(next)
        index += 2
      } else {
        index += 1
      }
      if (spec.kind === 'number') {
        const numeric = Number(value)
        if (!Number.isFinite(numeric) || numeric < 0) {
          throw new UsageError(name + ' must be a non-negative number')
        }
        options[spec.key] = numeric
      } else if (spec.kind === 'list') {
        if (!Array.isArray(options[spec.key])) options[spec.key] = []
        options[spec.key].push(value)
      } else {
        options[spec.key] = value
      }
      continue
    }
    if (raw.startsWith('-')) throw new UsageError('unknown option "' + raw + '"')
    tokens.push(raw)
    index += 1
  }
  const command = tokens.length > 0 ? tokens[0] : null
  const positional = tokens.length > 0 ? tokens.slice(1) : []
  return { command, options, positional }
}

/**
 * Run the CLI.
 *
 * @param {string[]} [argv] argument list (process.argv.slice(2))
 * @param {object} [runtime] injectable runtime (tests use this)
 * @param {Record<string, string|undefined>} [runtime.env] environment source
 * @param {string} [runtime.cwd] working directory
 * @param {any} [runtime.stdout] writable stream (write(string))
 * @param {any} [runtime.stderr] writable stream
 * @param {any} [runtime.stdin] readable stream or string
 * @param {Function} [runtime.fetch] fetch implementation
 * @param {AbortSignal} [runtime.signal] cancellation signal (mainly for --follow)
 * @returns {Promise<number>} process exit code
 */
export async function runCli(argv = [], runtime = {}) {
  const context = {
    env: runtime.env ?? process.env,
    cwd: runtime.cwd ?? process.cwd(),
    stdout: runtime.stdout ?? process.stdout,
    stderr: runtime.stderr ?? process.stderr,
    stdin: runtime.stdin ?? process.stdin,
    fetchImpl: runtime.fetch ?? globalThis.fetch,
    signal: runtime.signal,
    options: {},
    positional: [],
  }
  if (typeof context.fetchImpl !== 'function') {
    writeLine(context.stderr, 'peer: this Node runtime has no global fetch (Node >= 20 is required)')
    return 1
  }
  /** @type {{command: string|null, options: Record<string, any>, positional: string[]}} */
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    return reportFailure(context.stderr, error)
  }
  context.options = parsed.options
  context.positional = parsed.positional
  if (parsed.options.version) {
    writeLine(context.stdout, PACKAGE_NAME + ' ' + PACKAGE_VERSION)
    return 0
  }
  if (parsed.options.help || parsed.command === null || parsed.command === 'help') {
    write(context.stdout, HELP_TEXT)
    return 0
  }
  if (!COMMANDS.includes(parsed.command)) {
    return reportFailure(context.stderr, new UsageError('unknown command "' + parsed.command + '"; run "peer help"'))
  }
  try {
    switch (parsed.command) {
      case 'status':
        return await commandStatus(context)
      case 'ask':
        return await commandAsk(context)
      case 'send':
        return await commandSend(context)
      case 'read':
        return await commandRead(context)
      case 'threads':
        return await commandThreads(context)
      case 'close':
        return await commandClose(context)
      case 'doctor':
        return await commandDoctor(context)
      default:
        return await commandHelp(context)
    }
  } catch (error) {
    return reportFailure(context.stderr, error)
  }
}

/** @param {any} context CLI context @returns {Promise<number>} exit code */
async function commandHelp(context) {
  write(context.stdout, HELP_TEXT)
  return 0
}

/** @param {any} context CLI context @returns {Promise<number>} exit code */
async function commandStatus(context) {
  const client = bridgeFor(context)
  const health = await httpJson(client, 'GET', '/v1/health', undefined, { timeoutMs: 15_000 })
  if (context.options.json) {
    writeLine(context.stdout, JSON.stringify(health))
    return 0
  }
  const lines = []
  lines.push('bridge    ' + client.url + '  (' + (health.packageVersion ?? PACKAGE_VERSION) + ', up ' + formatUptime(health.uptimeMs) + ')')
  const host = health.host ?? {}
  lines.push('host      ' + (host.harness ?? 'dsh') + '  pid ' + (host.pid ?? '?'))
  const sessions = Array.isArray(host.sessions) ? host.sessions : []
  lines.push('sessions  ' + sessions.length)
  for (const session of sessions) {
    lines.push('  ' + String(session.id ?? '?') + '  ' + String(session.status ?? 'unknown') + (session.title ? '  ' + session.title : ''))
  }
  const adapters = Array.isArray(health.adapters) ? health.adapters : []
  lines.push('adapters')
  for (const adapter of adapters) {
    const available = adapter.available !== false
    const detail = available
      ? [adapter.version, adapter.command].filter((item) => typeof item === 'string' && item !== '').join('  ')
      : optionalString(adapter.notes) ?? 'not available'
    lines.push('  ' + String(adapter.harness ?? '?').padEnd(7) + (available ? 'available  ' : 'unavailable  ') + detail)
  }
  write(context.stdout, lines.join('\n') + '\n')
  return 0
}

/** @param {any} context CLI context @returns {Promise<number>} exit code */
async function commandAsk(context) {
  const { options, cwd } = context
  const wait = options.wait === undefined ? DEFAULT_WAIT_SECONDS : Math.floor(options.wait)
  const prompt = await resolvePrompt(context)
  const target = optionalString(options.to) ?? (optionalString(options.session) !== undefined ? 'dsh' : undefined)
  if (!target && optionalString(options.thread) === undefined) {
    throw new UsageError('ask requires --to <dsh|claude|codex|codex-desktop> (or --thread <id>)')
  }
  if (target !== undefined && !HARNESSES.includes(target)) {
    throw new UsageError('--to must be one of: ' + HARNESSES.join(', '))
  }
  if (optionalString(options.session) !== undefined && target !== 'dsh') {
    throw new UsageError('--session is only valid with --to dsh')
  }
  const overrides = messageOverrides(context)

  if (optionalString(options.thread) !== undefined) {
    const threadId = requireOption(options.thread, '--thread')
    const body = { text: prompt, from: { harness: 'user' }, await: wait > 0, ...overrides }
    const result = await httpJson(
      bridgeFor(context),
      'POST',
      '/v1/threads/' + encodeURIComponent(threadId) + '/messages',
      body,
      { timeoutMs: requestTimeoutMs(wait), timeoutExitCode: 4 },
    )
    return renderTurnResult(context, result)
  }

  if (wait === 0) {
    const created = await httpJson(bridgeFor(context), 'POST', '/v1/threads', inboundThreadBody(target, prompt, overrides), {
      timeoutMs: 30_000,
    })
    const threadId = created.thread?.id
    const result = await httpJson(
      bridgeFor(context),
      'POST',
      '/v1/threads/' + encodeURIComponent(String(threadId)) + '/messages',
      { text: prompt, from: { harness: 'user' }, await: false },
      { timeoutMs: 30_000 },
    )
    writeLine(context.stderr, 'peer: message queued in thread ' + threadId + ' (--wait 0)')
    if (options.json) {
      writeLine(context.stdout, JSON.stringify({ ok: true, thread: result.thread, message: result.message, reply: null, text: '', session: null }))
    }
    return 0
  }

  const body = inboundThreadBody(target, prompt, overrides)
  if (optionalString(options.session) !== undefined) body.to = { session_id: options.session }
  const result = await httpJson(bridgeFor(context), 'POST', '/v1/inbound', body, {
    timeoutMs: requestTimeoutMs(wait),
    timeoutExitCode: 4,
  })
  if (options.json) {
    writeLine(context.stdout, JSON.stringify({
      ok: true,
      thread: result.thread,
      reply: result.reply,
      text: result.text ?? '',
      session: result.session ?? null,
    }))
  } else if (result.reply) {
    write(context.stdout, ensureNewline(result.text ?? result.reply.text ?? ''))
  }
  if (result.reply?.role === 'error') return 4
  return 0
}

/** @param {any} context CLI context @returns {Promise<number>} exit code */
async function commandSend(context) {
  const { options } = context
  const threadId = requireOption(options.thread, '--thread')
  const wait = options.wait === undefined ? DEFAULT_WAIT_SECONDS : Math.floor(options.wait)
  const prompt = await resolvePrompt(context)
  const body = {
    text: prompt,
    from: { harness: 'user' },
    await: wait > 0,
    ...messageOverrides(context),
  }
  const result = await httpJson(
    bridgeFor(context),
    'POST',
    '/v1/threads/' + encodeURIComponent(threadId) + '/messages',
    body,
    { timeoutMs: requestTimeoutMs(wait), timeoutExitCode: 4 },
  )
  if (options.json) {
    writeLine(context.stdout, JSON.stringify({
      ok: true,
      thread: result.thread,
      message: result.message,
      reply: result.reply,
      text: result.reply?.text ?? '',
    }))
  } else if (result.reply) {
    write(context.stdout, ensureNewline(result.reply.text ?? ''))
  } else {
    writeLine(context.stderr, 'peer: message queued in thread ' + threadId)
  }
  if (result.reply?.role === 'error') return 4
  return 0
}

/** @param {any} context CLI context @returns {Promise<number>} exit code */
async function commandRead(context) {
  const { options } = context
  const threadId = requireOption(options.thread, '--thread')
  const after = options.after === undefined ? 0 : Math.floor(options.after)
  const wait = options.wait === undefined ? 0 : Math.floor(options.wait)
  const client = bridgeFor(context)
  if (options.follow) {
    let cursor = after
    const followWait = wait > 0 ? Math.min(wait, 30) : FOLLOW_WAIT_SECONDS
    for (;;) {
      let result
      try {
        result = await httpJson(
          client,
          'GET',
          '/v1/threads/' + encodeURIComponent(threadId) + '?after=' + cursor + '&wait_seconds=' + followWait,
          undefined,
          { timeoutMs: requestTimeoutMs(followWait) },
        )
      } catch (error) {
        if (error instanceof CliError && error.code === 'aborted') return 0
        throw error
      }
      for (const message of result.messages ?? []) {
        if (options.json) writeLine(context.stdout, JSON.stringify({ ok: true, type: 'message', threadId, message }))
        else writeLine(context.stdout, formatMessage(message))
      }
      if (options.json && (result.messages ?? []).length > 0) {
        writeLine(context.stdout, JSON.stringify({ ok: true, thread: result.thread, messages: result.messages, next_cursor: result.next_cursor }))
      }
      cursor = Number.isInteger(result.next_cursor) ? result.next_cursor : cursor
      if (context.signal?.aborted) return 0
      if (result.thread?.status === 'closed') return 0
      if ((result.messages ?? []).length === 0) await sleep(250)
    }
  }
  const result = await httpJson(
    client,
    'GET',
    '/v1/threads/' + encodeURIComponent(threadId) + '?after=' + after + '&wait_seconds=' + wait,
    undefined,
    { timeoutMs: requestTimeoutMs(wait) },
  )
  if (options.json) {
    writeLine(context.stdout, JSON.stringify({
      ok: true,
      thread: result.thread,
      messages: result.messages ?? [],
      next_cursor: result.next_cursor ?? after,
    }))
    return 0
  }
  for (const message of result.messages ?? []) writeLine(context.stdout, formatMessage(message))
  return 0
}

/** @param {any} context CLI context @returns {Promise<number>} exit code */
async function commandThreads(context) {
  const result = await httpJson(bridgeFor(context), 'GET', '/v1/threads', undefined, { timeoutMs: 15_000 })
  const threads = Array.isArray(result.threads) ? result.threads : []
  if (context.options.json) {
    writeLine(context.stdout, JSON.stringify({ ok: true, threads }))
    return 0
  }
  for (const thread of threads) {
    const stamp = String(thread.updatedAt ?? thread.createdAt ?? '').replace('T', ' ').slice(0, 19)
    writeLine(
      context.stdout,
      [
        String(thread.id ?? '?'),
        String(thread.harness ?? '?').padEnd(6),
        String(thread.status ?? '?').padEnd(6),
        String(thread.messageCount ?? 0).padStart(3) + ' msg',
        stamp,
        String(thread.title ?? ''),
      ].join('  '),
    )
  }
  return 0
}

/** @param {any} context CLI context @returns {Promise<number>} exit code */
async function commandClose(context) {
  const threadId = requireOption(context.options.thread, '--thread')
  const result = await httpJson(
    bridgeFor(context),
    'POST',
    '/v1/threads/' + encodeURIComponent(threadId) + '/close',
    {},
    { timeoutMs: 15_000 },
  )
  if (context.options.json) writeLine(context.stdout, JSON.stringify({ ok: true, thread: result.thread }))
  else writeLine(context.stdout, 'closed ' + (result.thread?.id ?? threadId))
  return 0
}

/** @param {any} context CLI context @returns {Promise<number>} exit code */
async function commandDoctor(context) {
  const discovery = resolveBridge(context)
  const record = discovery.record
  const fileInfo = {
    path: discovery.bridgeFile,
    exists: record !== null,
    ...(record === null
      ? {}
      : {
          pid: record.pid,
          alive: isProcessAlive(record.pid),
          url: record.url,
          packageVersion: record.packageVersion,
          harnesses: record.harnesses,
        }),
    ...(discovery.recordError === null ? {} : { error: discovery.recordError }),
  }
  const tokenInfo = {
    found: Boolean(discovery.token),
    source: discovery.tokenSource,
    ...(discovery.token ? { fingerprint: createHash('sha256').update(discovery.token).digest('hex').slice(0, 12) } : {}),
  }
  const client = {
    url: discovery.url,
    token: discovery.token,
    fetchImpl: context.fetchImpl,
    signal: context.signal,
  }
  let health = null
  /** @type {CliError|null} */
  let failure = null
  try {
    health = await httpJson(client, 'GET', '/v1/health', undefined, { timeoutMs: 5_000 })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    failure = error
  }
  if (context.options.json) {
    writeLine(context.stdout, JSON.stringify({
      ok: health !== null,
      peerHome: discovery.peerHome,
      bridgeFile: fileInfo,
      url: discovery.url,
      urlSource: discovery.urlSource,
      token: tokenInfo,
      ...(health === null ? {} : { health }),
      ...(failure === null ? {} : { error: { code: failure.code, message: failure.message } }),
    }))
  } else {
    const lines = [
      'peer home    ' + discovery.peerHome,
      'bridge.json  ' + (fileInfo.exists
        ? 'found (' + fileInfo.path + ')' +
          (fileInfo.pid === undefined ? '' : ', pid ' + fileInfo.pid + (fileInfo.alive ? ' alive' : ' not running'))
        : 'not found (' + discovery.bridgeFile + ')'),
      'url          ' + discovery.url + '  [' + discovery.urlSource + ']',
      'token        ' + (tokenInfo.found ? 'found [' + tokenInfo.source + '], sha256:' + tokenInfo.fingerprint : 'MISSING'),
    ]
    if (health !== null) {
      lines.push('bridge       ok  ' + PACKAGE_NAME + ' ' + (health.packageVersion ?? '?') + '  up ' + formatUptime(health.uptimeMs))
      for (const adapter of health.adapters ?? []) {
        lines.push('  adapter ' + String(adapter.harness ?? '?').padEnd(7) + (adapter.available === false ? 'unavailable  ' + (optionalString(adapter.notes) ?? '') : 'available'))
      }
      lines.push('sessions     ' + ((health.host?.sessions ?? []).length) + ' live DSH session(s)')
    } else {
      lines.push('bridge       ' + (failure === null ? 'unreachable' : failure.code + ': ' + failure.message))
    }
    write(context.stdout, lines.join('\n') + '\n')
  }
  if (health !== null) return 0
  return failure === null ? 2 : failure.exitCode
}

// ---- bridge discovery ----------------------------------------------------

/**
 * Resolve the peer home directory.
 * @param {Record<string, string|undefined>} env environment
 * @param {string} cwd working directory
 * @returns {string} absolute peer home
 */
function resolvePeerHome(env, cwd) {
  const configured = optionalString(env.DSH_PEER_HOME)
  if (configured !== undefined) return expandPath(configured, cwd)
  return join(homedir(), '.dsh-peer')
}

/**
 * Resolve bridge URL and token using CONTRACT section 3 precedence.
 * @param {any} context CLI context
 * @returns {{url: string, urlSource: string, token: string, tokenSource: string, peerHome: string, bridgeFile: string, record: any, recordError: string|null}} discovery
 */
function resolveBridge(context) {
  const { env, cwd, options } = context
  const peerHome = resolvePeerHome(env, cwd)
  const bridgeFile = join(peerHome, 'bridge.json')
  let record = null
  let recordError = null
  try {
    record = JSON.parse(readFileSync(bridgeFile, 'utf8'))
  } catch (error) {
    recordError = error?.code === 'ENOENT' ? 'missing' : error instanceof Error ? error.message : String(error)
  }
  if (record !== null && (typeof record !== 'object' || Array.isArray(record))) record = null
  const flagUrl = optionalString(options.url)
  const envUrl = optionalString(env.PEER_BRIDGE_URL)
  const fileUrl = record !== null ? optionalString(record.url) : undefined
  const rawUrl = flagUrl ?? envUrl ?? fileUrl ?? 'http://' + LOOPBACK_HOST + ':' + DEFAULT_PORT
  const urlSource = flagUrl !== undefined ? 'flag' : envUrl !== undefined ? 'env' : fileUrl !== undefined ? 'bridge.json' : 'default'
  const flagToken = optionalString(options.token)
  const envToken = optionalString(env.PEER_BRIDGE_TOKEN)
  const fileToken = record !== null ? optionalString(record.token) : undefined
  const token = flagToken ?? envToken ?? fileToken ?? ''
  const tokenSource = flagToken !== undefined ? 'flag' : envToken !== undefined ? 'env' : fileToken !== undefined ? 'bridge.json' : 'none'
  return {
    url: normalizeBridgeUrl(rawUrl),
    urlSource,
    token,
    tokenSource,
    peerHome,
    bridgeFile,
    record,
    recordError,
  }
}

/**
 * Build an authenticated client, requiring a token.
 * @param {any} context CLI context
 * @returns {{url: string, token: string, fetchImpl: Function, signal?: AbortSignal}} client
 */
function bridgeFor(context) {
  const discovery = resolveBridge(context)
  if (discovery.token === '') {
    throw new CliError(
      'no bridge token found (checked --token, PEER_BRIDGE_TOKEN and ' + discovery.bridgeFile +
        '); start the DSH peer plugin or pass --token',
      3,
      'unauthorized',
    )
  }
  return { url: discovery.url, token: discovery.token, fetchImpl: context.fetchImpl, signal: context.signal }
}

/**
 * Normalize a bridge URL: default scheme, no trailing slash, http(s) only.
 * @param {string} raw user-supplied URL
 * @returns {string} normalized base URL
 */
function normalizeBridgeUrl(raw) {
  let value = String(raw).trim()
  if (value === '') throw new UsageError('bridge URL is empty')
  if (!value.includes('://')) value = 'http://' + value
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new UsageError('invalid bridge URL "' + raw + '"')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError('bridge URL must use http or https: ' + raw)
  }
  return (parsed.origin + parsed.pathname).replace(/\/+$/, '')
}

// ---- HTTP client ---------------------------------------------------------

/**
 * Perform one JSON request against the bridge, mapping failures to exit codes.
 * @param {{url: string, token: string, fetchImpl: Function, signal?: AbortSignal}} client bridge client
 * @param {string} method HTTP method
 * @param {string} pathname path + query
 * @param {any} [body] JSON body (undefined for GET)
 * @param {{timeoutMs?: number, timeoutExitCode?: number}} [options] request options
 * @returns {Promise<any>} parsed JSON payload
 */
async function httpJson(client, method, pathname, body, options = {}) {
  const headers = { accept: 'application/json' }
  if (client.token) headers.authorization = 'Bearer ' + client.token
  /** @type {Record<string, any>} */
  const init = { method, headers }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  init.signal = combineSignals([timeoutSignal, client.signal])
  let response
  try {
    response = await client.fetchImpl(client.url + pathname, init)
  } catch (error) {
    if (client.signal?.aborted) throw new CliError('aborted', 1, 'aborted')
    const name = error?.name
    if (name === 'TimeoutError' || name === 'AbortError' || timeoutSignal.aborted) {
      throw new CliError(
        'timed out after ' + Math.round(timeoutMs / 1000) + 's waiting for the bridge',
        options.timeoutExitCode ?? 2,
        'timeout',
      )
    }
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error)
    throw new CliError('bridge unreachable at ' + client.url + ' (' + cause + ')', 2, 'unreachable')
  }
  const raw = await response.text()
  let payload = null
  if (raw !== '') {
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = null
    }
  }
  if (!response.ok) {
    const code = optionalString(payload?.error?.code)
    const message = optionalString(payload?.error?.message) ?? (raw !== '' ? raw : response.statusText || 'HTTP ' + response.status)
    if (response.status === 401 || response.status === 403 || code === 'unauthorized') {
      throw new CliError('unauthorized: ' + message + ' (check --token / PEER_BRIDGE_TOKEN / ' + client.url + ')', 3, 'unauthorized')
    }
    if (code === 'adapter-failed' || code === 'timeout' || code === 'adapter-unavailable' || code === 'inbound-unavailable') {
      throw new CliError(message, 4, code)
    }
    throw new CliError(code === undefined ? message : code + ': ' + message, 1, code ?? 'http')
  }
  return payload
}

/**
 * Combine optional AbortSignals (Node >= 20.3 has AbortSignal.any).
 * @param {Array<AbortSignal|undefined>} signals signals to combine
 * @returns {AbortSignal|undefined} combined signal
 */
function combineSignals(signals) {
  const defined = signals.filter((signal) => signal !== undefined && signal !== null)
  if (defined.length === 0) return undefined
  if (defined.length === 1) return defined[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(defined)
  const controller = new AbortController()
  for (const signal of defined) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

// ---- command helpers -----------------------------------------------------

/**
 * Build the POST /v1/inbound body shared by ask.
 * @param {string} harness target harness
 * @param {string} prompt message text
 * @param {Record<string, any>} overrides model/effort/context overrides
 * @returns {Record<string, any>} request body
 */
function inboundThreadBody(harness, prompt, overrides) {
  return {
    harness,
    text: prompt,
    from: { harness: 'user' },
    createdBy: { harness: 'user' },
    ...overrides,
  }
}

/**
 * Build per-message model/effort/context overrides from CLI flags.
 * @param {any} context CLI context
 * @returns {Record<string, any>} overrides
 */
function messageOverrides(context) {
  const { options, cwd } = context
  /** @type {Record<string, any>} */
  const overrides = {}
  const model = optionalString(options.model)
  if (model !== undefined) overrides.model = model
  const effort = optionalString(options.effort)
  if (effort !== undefined) overrides.reasoning_effort = effort
  const contextFields = contextFromFlags(options, cwd)
  if (Object.keys(contextFields).length > 0) overrides.context = contextFields
  return overrides
}

/**
 * Build a wire context object from CLI flags (cwd/system/files).
 * @param {Record<string, any>} options parsed flags
 * @param {string} cwd working directory
 * @returns {Record<string, any>} wire context
 */
function contextFromFlags(options, cwd) {
  /** @type {Record<string, any>} */
  const context = {}
  const workdir = optionalString(options.cwd)
  if (workdir !== undefined) context.cwd = expandPath(workdir, cwd)
  const system = readTextOption(options.system, cwd, '--system')
  if (system !== undefined) context.system = system
  const appendSystem = readTextOption(options.appendSystem, cwd, '--append-system')
  if (appendSystem !== undefined) context.append_system = appendSystem
  if (Array.isArray(options.files) && options.files.length > 0) {
    context.files = options.files.map((file) => expandPath(file, cwd))
  }
  const resume = optionalString(options.resume)
  if (resume !== undefined) context.resume = resume
  return context
}

/**
 * Read a literal text flag or an @file reference.
 * @param {unknown} value flag value
 * @param {string} cwd working directory
 * @param {string} flag flag name for diagnostics
 * @returns {string|undefined} resolved text
 */
function readTextOption(value, cwd, flag) {
  const text = optionalString(value)
  if (text === undefined) return undefined
  if (!text.startsWith('@')) return text
  const file = expandPath(text.slice(1), cwd)
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    throw new CliError('cannot read ' + flag + ' file ' + file + ': ' + (error instanceof Error ? error.message : String(error)), 1, 'usage')
  }
}

/**
 * Read the prompt from positionals, or from stdin when it is exactly "-".
 * @param {any} context CLI context
 * @returns {Promise<string>} prompt text
 */
async function resolvePrompt(context) {
  if (context.positional.length === 0) {
    throw new UsageError('missing prompt (pass text, or "-" to read stdin)')
  }
  if (context.positional.length === 1 && context.positional[0] === '-') {
    const text = await readAllStdin(context.stdin)
    return text.replace(/\r?\n+$/, '')
  }
  return context.positional.join(' ')
}

/**
 * Read all of stdin.
 * @param {any} stdin readable stream, string, or undefined
 * @returns {Promise<string>} stdin contents
 */
async function readAllStdin(stdin) {
  if (typeof stdin === 'string') return stdin
  if (stdin === undefined || stdin === null) return ''
  if (typeof stdin[Symbol.asyncIterator] === 'function') {
    const chunks = []
    for await (const chunk of stdin) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    }
    return chunks.join('')
  }
  if (typeof stdin.read === 'function') {
    const chunks = []
    let chunk = stdin.read()
    while (chunk !== null) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      chunk = stdin.read()
    }
    return chunks.join('')
  }
  return ''
}

/**
 * @param {any} context CLI context
 * @param {{message: any, reply: any, thread: any}} result bridge message response
 * @returns {number} exit code
 */
function renderTurnResult(context, result) {
  const reply = result.reply ?? null
  if (context.options.json) {
    writeLine(context.stdout, JSON.stringify({
      ok: true,
      thread: result.thread,
      message: result.message,
      reply,
      text: reply?.text ?? '',
      session: null,
    }))
  } else if (reply) {
    write(context.stdout, ensureNewline(reply.text ?? ''))
  } else {
    writeLine(context.stderr, 'peer: message queued in thread ' + String(result.thread?.id ?? ''))
  }
  if (reply?.role === 'error') return 4
  return 0
}

/**
 * @param {any} message wire message
 * @returns {string} one-line rendering for peer read
 */
function formatMessage(message) {
  const who = optionalString(message?.from?.name) ?? optionalString(message?.from?.harness)
  return '[' + String(message?.seq ?? '?') + '] ' + String(message?.role ?? '?') +
    (who === undefined ? '' : ' (' + who + ')') + ': ' + String(message?.text ?? '')
}

/**
 * @param {number} waitSeconds expected wait cap
 * @returns {number} HTTP timeout in milliseconds
 */
function requestTimeoutMs(waitSeconds) {
  return Math.max(DEFAULT_TIMEOUT_MS, (Math.max(0, waitSeconds) + 15) * 1000)
}

/**
 * @param {unknown} value option value
 * @param {string} name option name for the error message
 * @returns {string} the required non-empty option
 */
function requireOption(value, name) {
  const text = optionalString(value)
  if (text === undefined) throw new UsageError(name + ' is required')
  return text
}

/**
 * Expand ~ and resolve relative paths against the working directory.
 * @param {string} value path
 * @param {string} cwd working directory
 * @returns {string} absolute path
 */
function expandPath(value, cwd) {
  let text = String(value)
  if (text === '~') text = homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = join(homedir(), text.slice(2))
  return isAbsolute(text) ? text : resolve(cwd, text)
}

/**
 * @param {unknown} value duration
 * @returns {string} human duration
 */
function formatUptime(value) {
  const ms = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  if (ms < 1000) return Math.round(ms) + 'ms'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm' + (seconds % 60) + 's'
  const hours = Math.floor(minutes / 60)
  return hours + 'h' + (minutes % 60) + 'm'
}

/**
 * @param {any} pid process id
 * @returns {boolean} whether the process exists
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * @param {string} text reply text
 * @returns {string} text guaranteed to end with exactly one newline
 */
function ensureNewline(text) {
  const value = String(text ?? '')
  return value.endsWith('\n') ? value : value + '\n'
}

/**
 * Write a string to an injected stream without throwing.
 * @param {any} stream writable
 * @param {string} text payload
 */
function write(stream, text) {
  try {
    stream.write(text)
  } catch {
    /* stdout may be closed */
  }
}

/**
 * @param {any} stream writable
 * @param {string} text line payload
 */
function writeLine(stream, text) {
  write(stream, text + '\n')
}

/**
 * Render a failure to stderr and return its exit code.
 * @param {any} stderr writable
 * @param {unknown} error thrown value
 * @returns {number} exit code
 */
function reportFailure(stderr, error) {
  if (error instanceof CliError) {
    writeLine(stderr, 'peer: ' + error.message)
    if (error.code === 'usage') writeLine(stderr, 'run "peer help" for usage')
    return error.exitCode
  }
  const message = error instanceof Error ? error.message : String(error)
  writeLine(stderr, 'peer: ' + message)
  return 1
}

/**
 * Resolve after n milliseconds.
 * @param {number} ms milliseconds
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

export default runCli
