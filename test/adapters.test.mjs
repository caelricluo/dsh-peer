/**
 * CONTRACT sections 6 + 10.3: claude arg building + JSON parsing, codex arg
 * building + tolerant JSONL parsing, dsh adapter against a fake host, and
 * abort killing the child process. Fake CLIs are node scripts in temp dirs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createClaudeAdapter, buildClaudeArgs, parseClaudeResult } from '../lib/adapters/claude.js'
import { createCodexAdapter, buildCodexArgs, parseCodexEvents } from '../lib/adapters/codex.js'
import {
  createCodexDesktopAdapter,
  buildCodexDesktopArgs,
  parseAppServerLine,
  agentTextFromNotification,
} from '../lib/adapters/codex-desktop.js'
import { createDshAdapter } from '../lib/adapters/dsh.js'
import { runProcess } from '../lib/adapters/runner.js'
import { createAdapters } from '../lib/adapters/index.js'
import { tempDir, fakeCli, sleep, waitFor } from './helpers/tmp.mjs'

function pair(args, flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args.slice(index, index + 2)
}

/** Build a fake claude executable body. mode: json | raw | error */
function claudeBody({ argvLog, stdinLog, pidLog, cwdLog, mode = 'json', delayMs = 0 }) {
  const emit = mode === 'json'
    ? "process.stdout.write(JSON.stringify({ result: 'claude says: ' + input.trim(), session_id: 'sess-claude-1', is_error: false, subtype: 'success' }) + '\\n')"
    : mode === 'error'
      ? "process.stdout.write(JSON.stringify({ result: 'boom', session_id: 'sess-claude-1', is_error: true }) + '\\n')"
      : "process.stdout.write('RAW OUTPUT: ' + input.trim() + '\\n')"
  return [
    "import { writeFileSync } from 'node:fs'",
    'writeFileSync(' + JSON.stringify(pidLog) + ', String(process.pid))',
    'writeFileSync(' + JSON.stringify(cwdLog) + ', process.cwd())',
    "let input = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (chunk) => { input += chunk })",
    "process.stdin.on('end', () => {",
    '  writeFileSync(' + JSON.stringify(argvLog) + ', JSON.stringify(process.argv.slice(2)))',
    '  writeFileSync(' + JSON.stringify(stdinLog) + ', input)',
    '  const emit = () => { ' + emit + ' }',
    '  if (' + delayMs + ' > 0) setTimeout(emit, ' + delayMs + '); else emit()',
    '})',
  ].join('\n')
}

function codexBody({ argvLog, stdinLog, cwdLog }) {
  return [
    "import { writeFileSync } from 'node:fs'",
    'writeFileSync(' + JSON.stringify(cwdLog) + ', process.cwd())',
    "let input = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (chunk) => { input += chunk })",
    "process.stdin.on('end', () => {",
    '  writeFileSync(' + JSON.stringify(argvLog) + ', JSON.stringify(process.argv.slice(2)))',
    '  writeFileSync(' + JSON.stringify(stdinLog) + ', input)',
    "  const events = [",
    "    { type: 'thread.started', thread_id: 'sess-codex-1' },",
    "    { type: 'turn.started' },",
    "    { type: 'future.unknown.event', payload: { ok: true } },",
    "    { type: 'item.completed', item: { type: 'agent_message', text: 'codex says: ' + input.trim() } },",
    "    { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } },",
    '  ]',
    "  for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n')",
    '})',
  ].join('\n')
}

async function claudeFixture(t, mode = 'json') {
  const dir = await tempDir(t)
  const logs = {
    argvLog: join(dir, 'argv.json'),
    stdinLog: join(dir, 'stdin.txt'),
    pidLog: join(dir, 'pid.txt'),
    cwdLog: join(dir, 'cwd.txt'),
  }
  const command = await fakeCli(dir, 'fake-claude', claudeBody({ ...logs, mode }))
  return { dir, command, logs }
}

async function codexFixture(t) {
  const dir = await tempDir(t)
  const logs = { argvLog: join(dir, 'argv.json'), stdinLog: join(dir, 'stdin.txt'), cwdLog: join(dir, 'cwd.txt') }
  const command = await fakeCli(dir, 'fake-codex', codexBody(logs))
  return { dir, command, logs }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('adapters: buildClaudeArgs matches the documented command line', () => {
  const args = buildClaudeArgs({
    model: 'opus',
    effort: 'high',
    resume: 'sess-remote-1',
    appendSystemPrompt: 'APPEND',
    addDirs: ['/tmp/extra-dir', '/tmp/other-dir'],
  })
  assert.ok(Array.isArray(args))
  assert.ok(args.includes('-p'))
  assert.deepEqual(pair(args, '--output-format'), ['--output-format', 'json'])
  assert.deepEqual(pair(args, '--model'), ['--model', 'opus'])
  assert.deepEqual(pair(args, '--effort'), ['--effort', 'high'])
  assert.deepEqual(pair(args, '--resume'), ['--resume', 'sess-remote-1'])
  assert.deepEqual(pair(args, '--append-system-prompt'), ['--append-system-prompt', 'APPEND'])
  assert.deepEqual(pair(args, '--add-dir'), ['--add-dir', '/tmp/extra-dir'])
  assert.equal(args.filter((arg) => arg === '/tmp/other-dir').length, 1)
  // "--tools \"\" is NOT set by default"
  assert.ok(!args.includes('--tools'))

  const minimal = buildClaudeArgs({})
  assert.ok(minimal.includes('-p'))
  assert.ok(!minimal.includes('--model'))
  assert.ok(!minimal.includes('--effort'))
  assert.ok(!minimal.includes('--resume'))
})

test('adapters: parseClaudeResult parses the JSON result object', () => {
  const parsed = parseClaudeResult(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'the answer',
    session_id: 'sess-1',
    duration_ms: 42,
  }))
  assert.equal(parsed.text, 'the answer')
  assert.equal(parsed.sessionId, 'sess-1')
  assert.equal(parsed.isError, false)
  assert.equal(parsed.subtype, 'success')

  const errored = parseClaudeResult(JSON.stringify({ result: 'bad', is_error: true, session_id: 'sess-2' }))
  assert.equal(errored.text, 'bad')
  assert.equal(errored.isError, true)
})

test('adapters: claude adapter runs the fake CLI, builds args, reads stdin', async (t) => {
  const { command, logs, dir } = await claudeFixture(t)
  const adapter = createClaudeAdapter({ config: { command }, logger: silentLogger() })
  const thread = {
    id: 'thr_claude00001',
    harness: 'claude',
    model: 'opus',
    reasoning_effort: 'high',
    context: { cwd: dir, resume: 'sess-remote-1', append_system: 'APPEND', add_dirs: ['/tmp/extra-dir'] },
  }
  const result = await adapter.runTurn({
    thread,
    userText: 'hello world',
    message: { text: 'hello world' },
    context: thread.context,
  })
  assert.equal(result.text, 'claude says: hello world')
  assert.equal(result.remoteSessionId, 'sess-claude-1')
  const argv = await readJson(logs.argvLog)
  assert.ok(argv.includes('-p'))
  assert.deepEqual(pair(argv, '--output-format'), ['--output-format', 'json'])
  assert.deepEqual(pair(argv, '--model'), ['--model', 'opus'])
  assert.deepEqual(pair(argv, '--effort'), ['--effort', 'high'])
  assert.deepEqual(pair(argv, '--resume'), ['--resume', 'sess-remote-1'])
  assert.deepEqual(pair(argv, '--append-system-prompt'), ['--append-system-prompt', 'APPEND'])
  assert.deepEqual(pair(argv, '--add-dir'), ['--add-dir', '/tmp/extra-dir'])
  assert.equal((await readFile(logs.stdinLog, 'utf8')), 'hello world')
  assert.equal(await realpath(await readFile(logs.cwdLog, 'utf8')), await realpath(dir))
})

test('adapters: claude adapter appends config.extraArgs', async (t) => {
  const { command, logs } = await claudeFixture(t)
  const adapter = createClaudeAdapter({ config: { command, extraArgs: ['--tools', ''] }, logger: silentLogger() })
  await adapter.runTurn({ thread: { id: 'thr_x', harness: 'claude', context: {} }, userText: 'hi', message: { text: 'hi' }, context: {} })
  const argv = await readJson(logs.argvLog)
  assert.deepEqual(pair(argv, '--tools'), ['--tools', ''])
})

test('adapters: claude adapter falls back to raw stdout when JSON parsing fails', async (t) => {
  const { command } = await claudeFixture(t, 'raw')
  const adapter = createClaudeAdapter({ config: { command }, logger: silentLogger() })
  const result = await adapter.runTurn({ thread: { id: 'thr_raw', harness: 'claude', context: {} }, userText: 'hello', message: { text: 'hello' }, context: {} })
  assert.match(result.text, /RAW OUTPUT: hello/)
  assert.equal(result.meta?.truncated, true)
})

test('adapters: claude describe() never throws and reports unavailable command', async () => {
  const adapter = createClaudeAdapter({ config: { command: '/nonexistent/definitely-not-claude-xyz' }, logger: silentLogger() })
  const info = await adapter.describe()
  assert.equal(info.harness, 'claude')
  assert.equal(info.available, false)
  assert.equal(typeof info.notes, 'string')
})

test('adapters: buildCodexArgs matches the documented command line', () => {
  const args = buildCodexArgs({ model: 'gpt-5', effort: 'high', cwd: '/tmp/workdir' })
  assert.equal(args[0], 'exec')
  assert.ok(args.includes('--json'))
  assert.ok(args.includes('--skip-git-repo-check'))
  assert.deepEqual(pair(args, '-C'), ['-C', '/tmp/workdir'])
  assert.deepEqual(pair(args, '-m'), ['-m', 'gpt-5'])
  assert.ok(args.includes('-c'))
  assert.ok(args.includes('model_reasoning_effort="high"'))

  const resumed = buildCodexArgs({ resume: 'sess-codex-1' })
  assert.equal(resumed[0], 'exec')
  assert.equal(resumed[1], 'resume')
  assert.ok(resumed.includes('--json'))
  assert.ok(resumed.includes('sess-codex-1'))
})

test('adapters: parseCodexEvents is tolerant of unknown events and bad lines', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'sess-codex-1' }),
    'this line is not json at all',
    JSON.stringify({ type: 'future.unknown.event', payload: {} }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }),
    '',
  ].join('\n')
  const parsed = parseCodexEvents(stdout)
  assert.equal(parsed.text, 'final answer')
  assert.equal(parsed.sessionId, 'sess-codex-1')
  assert.ok(Array.isArray(parsed.events))
  assert.ok(parsed.events.length >= 2)
})

test('adapters: codex adapter runs the fake CLI and parses NDJSON', async (t) => {
  const { command, logs, dir } = await codexFixture(t)
  const adapter = createCodexAdapter({ config: { command }, logger: silentLogger() })
  const context = { cwd: dir }
  const result = await adapter.runTurn({
    thread: { id: 'thr_codex00001', harness: 'codex', model: 'gpt-5', reasoning_effort: 'high', context },
    userText: 'hello codex',
    message: { text: 'hello codex' },
    context,
  })
  assert.equal(result.text, 'codex says: hello codex')
  assert.equal(result.remoteSessionId, 'sess-codex-1')
  const argv = await readJson(logs.argvLog)
  assert.equal(argv[0], 'exec')
  assert.ok(argv.includes('--json'))
  assert.deepEqual(pair(argv, '-C'), ['-C', dir])
  assert.equal((await readFile(logs.stdinLog, 'utf8')), 'hello codex')
})

test('adapters: codex resume passes the remote session id', async (t) => {
  const { command, logs } = await codexFixture(t)
  const adapter = createCodexAdapter({ config: { command }, logger: silentLogger() })
  await adapter.runTurn({
    thread: { id: 'thr_x', harness: 'codex', context: { resume: 'sess-remote-9' } },
    userText: 'again',
    message: { text: 'again' },
    context: { resume: 'sess-remote-9' },
  })
  const argv = await readJson(logs.argvLog)
  assert.equal(argv[0], 'exec')
  assert.equal(argv[1], 'resume')
  assert.ok(argv.includes('sess-remote-9'))
})

test('adapters: dsh adapter maps to host.runAgentTurn', async () => {
  const calls = []
  const host = {
    async runAgentTurn(request) {
      calls.push(request)
      return { text: 'dsh answer: ' + request.prompt, sessionId: 'sess-dsh-1', resumed: false }
    },
  }
  const adapter = createDshAdapter({ config: { defaultModel: 'm', defaultEffort: 'high', ephemeral: true }, host, logger: silentLogger() })
  const result = await adapter.runTurn({
    thread: { id: 'thr_dsh00001', harness: 'dsh', model: null, reasoning_effort: null, context: { cwd: '/tmp/dsh-cwd' } },
    userText: 'hi dsh',
    message: { text: 'hi dsh' },
    context: { cwd: '/tmp/dsh-cwd' },
  })
  assert.equal(result.text, 'dsh answer: hi dsh')
  assert.equal(result.remoteSessionId, 'sess-dsh-1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, 'hi dsh')
  assert.equal(calls[0].cwd, '/tmp/dsh-cwd')
})

test('adapters: dsh adapter reports available:false without a host', async () => {
  const adapter = createDshAdapter({ config: {}, logger: silentLogger() })
  const info = await adapter.describe()
  assert.equal(info.harness, 'dsh')
  assert.equal(info.available, false)
  assert.equal(typeof info.notes, 'string')
})

/** Build a fake `codex app-server`: JSONL over stdio, one turn, optional delay. */
function codexDesktopBody({ delayMs = 30, recordPath, namePath } = {}) {
  return [
    "if (process.argv.includes('--version')) { console.log('codex-cli 9.9.9-fake'); process.exit(0) }",
    "import { writeFileSync } from 'node:fs'",
    "let buf = ''",
    "let resumed = false",
    "const RECORD = " + JSON.stringify(recordPath ?? null),
    "const NAME_LOG = " + JSON.stringify(namePath ?? null),
    "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (chunk) => {",
    "  buf += chunk",
    "  let i",
    "  while ((i = buf.indexOf('\\n')) >= 0) {",
    "    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)",
    "    if (!line) continue",
    "    let m; try { m = JSON.parse(line) } catch { continue }",
    "    if (m.method === 'initialize') { if (RECORD) writeFileSync(RECORD, JSON.stringify({ clientInfo: m.params.clientInfo })); send({ jsonrpc: '2.0', id: m.id, result: { userAgent: 'fake-app-server' } }); continue }",
    "    if (m.method === 'initialized') continue",
    "    if (m.method === 'thread/start') { send({ jsonrpc: '2.0', id: m.id, result: { thread: { id: 'thr_desktop_fake' }, model: 'fake-model', modelProvider: 'fake-provider' } }); continue }",
    "    if (m.method === 'thread/resume') { resumed = true; send({ jsonrpc: '2.0', id: m.id, result: { thread: { id: m.params.threadId } } }); continue }",
    "    if (m.method === 'thread/name/set') { if (NAME_LOG) writeFileSync(NAME_LOG, JSON.stringify({ name: m.params.name })); send({ jsonrpc: '2.0', id: m.id, result: {} }); continue }",
    "    if (m.method === 'turn/start') {",
    "      send({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'turn_fake' } } })",
    "      setTimeout(() => {",
    "        send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: m.params.threadId, item: { id: 'msg_1', type: 'agentMessage', text: resumed ? 'resumed reply' : 'fresh reply' } } })",
    "        send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: 'turn_fake', usage: { input_tokens: 3, output_tokens: 2 } } } })",
    "      }, " + delayMs + ")",
    "      continue",
    "    }",
    "  }",
    "})",
  ].join('\n')
}

test('adapters: codex-desktop helper argv and parser', () => {
  assert.deepEqual(buildCodexDesktopArgs({}), ['app-server'])
  assert.deepEqual(buildCodexDesktopArgs({ extraArgs: ['-c', 'x=1'] }), ['app-server', '-c', 'x=1'])
  assert.deepEqual(parseAppServerLine('{"jsonrpc":"2.0","id":1,"result":{}}'), { jsonrpc: '2.0', id: 1, result: {} })
  assert.equal(parseAppServerLine('not json'), null)
  assert.equal(
    agentTextFromNotification({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'hi' } } }),
    'hi',
  )
  assert.equal(agentTextFromNotification({ method: 'item/completed', params: { item: { type: 'reasoning', text: 'hi' } } }), '')
})

test('adapters: codex-desktop runs a fresh app-server turn and resumes by thread id', async (t) => {
  const dir = await tempDir(t)
  const recordPath = join(dir, 'client.json')
  const namePath = join(dir, 'name.json')
  const command = await fakeCli(dir, 'fake-codex-appserver', codexDesktopBody({ recordPath, namePath }))
  const adapter = createCodexDesktopAdapter({ config: { command }, logger: silentLogger() })
  const info = await adapter.describe()
  assert.equal(info.available, true)
  assert.equal(info.version, '9.9.9-fake')
  assert.match(info.notes, /app-server/i)

  const fresh = await adapter.runTurn({ thread: { harness: 'codex-desktop', context: {} }, userText: 'hello Recents title' })
  const recorded = JSON.parse(await readFile(recordPath, 'utf8'))
  assert.equal(recorded.clientInfo.name, 'Codex Desktop')
  const named = JSON.parse(await readFile(namePath, 'utf8'))
  assert.equal(named.name, 'hello Recents title')
  assert.equal(fresh.text, 'fresh reply')
  assert.equal(fresh.remoteSessionId, 'thr_desktop_fake')
  assert.equal(fresh.meta.model, 'fake-model')
  assert.equal(fresh.meta.provider, 'fake-provider')
  assert.deepEqual(fresh.meta.usage, { input_tokens: 3, output_tokens: 2 })

  const resumed = await adapter.runTurn({
    thread: { harness: 'codex-desktop', context: {}, remoteSessionId: 'thr_desktop_old' },
    userText: 'continue',
  })
  assert.equal(resumed.text, 'resumed reply')
  assert.equal(resumed.remoteSessionId, 'thr_desktop_old')
})

test('adapters: codex-desktop turn timeout is bounded', { timeout: 15000 }, async (t) => {
  const dir = await tempDir(t)
  const command = await fakeCli(dir, 'fake-codex-appserver-slow', codexDesktopBody({ delayMs: 8000 }))
  const adapter = createCodexDesktopAdapter({ config: { command, turnTimeoutMs: 400 }, logger: silentLogger() })
  const started = Date.now()
  await assert.rejects(
    () => adapter.runTurn({ thread: { harness: 'codex-desktop', context: {} }, userText: 'slow' }),
    (error) => error.code === 'timeout',
  )
  assert.ok(Date.now() - started < 5000, 'timeout must end near its bound')
})

test('adapters: registry returns dsh, claude, codex in order and rejects unknown', async (t) => {
  const { command: claudeCommand } = await claudeFixture(t)
  const { command: codexCommand } = await codexFixture(t)
  const registry = createAdapters({
    config: {
      claude: { command: claudeCommand },
      codex: { command: codexCommand },
      dsh: { defaultEffort: 'high' },
    },
    logger: silentLogger(),
    host: { async runAgentTurn() { return { text: 'ok', sessionId: 's' } } },
  })
  const all = await registry.all()
  assert.deepEqual(all.map((adapter) => adapter.harness), ['dsh', 'claude', 'codex', 'codex-desktop'])
  assert.equal((await registry.get('claude')).harness, 'claude')
  await assert.rejects(() => registry.get('bogus'))
})

test('adapters: abort signal kills the claude child process', async (t) => {
  const dir = await tempDir(t)
  const logs = {
    argvLog: join(dir, 'argv.json'),
    stdinLog: join(dir, 'stdin.txt'),
    pidLog: join(dir, 'pid.txt'),
    cwdLog: join(dir, 'cwd.txt'),
  }
  const command = await fakeCli(dir, 'fake-claude-slow', claudeBody({ ...logs, delayMs: 10000 }))
  const adapter = createClaudeAdapter({ config: { command }, logger: silentLogger() })
  const controller = new AbortController()
  const started = Date.now()
  const pending = adapter.runTurn({
    thread: { id: 'thr_abort', harness: 'claude', context: {} },
    userText: 'sleep',
    message: { text: 'sleep' },
    context: {},
    signal: controller.signal,
  })
  const pid = Number(await waitFor(async () => {
    try { return (await readFile(logs.pidLog, 'utf8')).trim() || false } catch { return false }
  }, { label: 'child pid file', timeoutMs: 5000 }))
  setTimeout(() => controller.abort(), 100)
  let error
  try {
    await pending
  } catch (caught) {
    error = caught
  }
  assert.ok(error, 'runTurn must reject when the signal aborts')
  assert.ok(Date.now() - started < 5000, 'abort should reject promptly')
  await sleep(1500)
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'child process should be killed on abort')
})

test('adapters: an already-aborted signal rejects without hanging', async (t) => {
  const { command } = await claudeFixture(t)
  const adapter = createClaudeAdapter({ config: { command }, logger: silentLogger() })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => adapter.runTurn({
    thread: { id: 'thr_preabort', harness: 'claude', context: {} },
    userText: 'never',
    message: { text: 'never' },
    context: {},
    signal: controller.signal,
  }))
})

test('runner: timeout resolves even when a descendant holds the stdio pipes', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t)
  const pidFile = join(dir, 'grandchild.pid')
  // The direct child ignores SIGTERM and leaves a detached grandchild holding
  // the inherited stdout/stderr pipes, so the child's 'close' event never fires
  // until the grandchild exits (60s). runProcess must still settle via its
  // bounded post-kill deadline instead of hanging forever.
  const command = await fakeCli(dir, 'fake-runner-pipes', [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "process.on('SIGTERM', () => {})",
    "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit', detached: true })",
    "writeFileSync(" + JSON.stringify(pidFile) + ", String(grandchild.pid))",
    'grandchild.unref()',
    'setTimeout(() => {}, 60000)',
  ].join('\n'))

  let grandchildPid = null
  const killGrandchild = () => {
    if (!Number.isFinite(grandchildPid) || grandchildPid <= 0) return
    try { process.kill(grandchildPid, 'SIGKILL') } catch { /* already gone */ }
  }
  t.after(async () => {
    if (grandchildPid === null) {
      try { grandchildPid = Number(await readFile(pidFile, 'utf8')) } catch { return }
    }
    killGrandchild()
  })

  let failureTimer
  const hung = new Promise((_resolve, reject) => {
    failureTimer = setTimeout(() => reject(new Error('runProcess hung: the descendant kept the stdio pipes open past the settle grace')), 3000)
  })
  const started = Date.now()
  let outcome
  try {
    outcome = await Promise.race([
      runProcess({ command, args: [], input: '', timeoutMs: 300, killGraceMs: 100, settleGraceMs: 100 }),
      hung,
    ])
  } finally {
    clearTimeout(failureTimer)
    try { grandchildPid = Number(await readFile(pidFile, 'utf8')) } catch { /* no grandchild */ }
  }
  const elapsed = Date.now() - started
  assert.equal(outcome.timedOut, true)
  assert.equal(outcome.aborted, false)
  assert.ok(elapsed < 3000, 'expected runProcess to settle in < 3000ms, took ' + elapsed + 'ms')
  killGrandchild()
})

function silentLogger() {
  const noop = () => {}
  return { debug: noop, info: noop, warn: noop, error: noop }
}
