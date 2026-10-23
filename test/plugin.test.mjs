/**
 * CONTRACT sections 8 + 9 + 10.5: lib/index.js exports a factory that
 * registers exactly five tools, rejects a non-loopback host, and wires
 * inbound delivery into a fake live DSH agent. Also covers lib/tool.js, the
 * local defineTool compiler (zero @deepseek-ai imports).
 *
 * The plugin module statically imports lib/store.js, lib/bridge.js and
 * lib/adapters/index.js; while those are still being written the import fails
 * and every plugin test skips with the reason instead of erroring the runner.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { defineTool, compileParameters, validateValue, ToolArgsError } from '../lib/tool.js'
import { peerHome } from './helpers/tmp.mjs'

let lib = null
let libImportError = null
try {
  lib = await import('../lib/index.js')
} catch (error) {
  libImportError = error
}

/** @returns {any|null} loaded module, or null after marking the test skipped */
function requireLib(t) {
  if (lib) return lib
  t.skip('lib/index.js is not importable yet (waiting on lib/store.js, lib/bridge.js, lib/adapters/index.js): ' + libImportError.message)
  return null
}

const EXPECTED_TOOLS = ['peer_status', 'peer_ask', 'peer_send', 'peer_wait', 'peer_thread']

function makeFakeAgent({ id = 'session-fake-1', reply = 'live reply', running = false } = {}) {
  const events = []
  const sent = []
  let status = running ? 'running' : 'idle'
  const session = {
    id,
    seq: 0,
    header: { title: 'Fake session' },
    eventAt(seq) { return events[seq] },
  }
  function runTurn() {
    events.push({ type: 'turn/start', data: { turnId: 'turn-1' } })
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } })
    events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    session.seq = events.length
    status = 'idle'
  }
  return {
    id,
    session,
    sent,
    get status() { return status },
    async whenIdle() {},
    followup(message) { sent.push({ kind: 'followup', message }); runTurn() },
    steer(message) { sent.push({ kind: 'steer', message }); runTurn() },
    async cancel() {},
  }
}

function makeFakeCtx(agent) {
  const registered = []
  const sections = []
  const effects = []
  const ctx = {
    tools: { register(definition) { registered.push(definition) } },
    on() {},
    get(service) {
      if (service === 'agents') {
        return {
          list: () => (agent ? [agent] : []),
          get: (id) => (agent && (agent.id === id || agent.session?.id === id) ? agent : undefined),
        }
      }
      if (service === 'systemPrompt') {
        return { section(section) { sections.push(section) } }
      }
      return undefined
    },
    effect(callback) { effects.push(callback) },
    logger: undefined,
  }
  return { ctx, registered, sections, effects }
}

function fakeBridge(overrides = {}) {
  return {
    async health() {
      return { host: { harness: 'dsh', pid: 1, sessions: [] }, adapters: [] }
    },
    async createThread(input) {
      return { thread: { id: 'thr_created', harness: input?.harness ?? 'claude', status: 'open' } }
    },
    async sendMessage(args) {
      return {
        message: { seq: 0, id: 'msg_x', threadId: args.threadId, role: 'user', text: args.text },
        reply: { seq: 1, id: 'msg_y', threadId: args.threadId, role: 'assistant', text: 'reply' },
        thread: { id: args.threadId, status: 'open' },
      }
    },
    ...overrides,
  }
}

function fakeStore(overrides = {}) {
  return {
    async listThreads() { return [] },
    async getThread() { return undefined },
    async readMessages() { return [] },
    async closeThread(id) { return { id, status: 'closed' } },
    ...overrides,
  }
}

test('tool: defineTool compiles the compact DSL into raw JSON Schema', () => {
  const definition = defineTool({
    name: 'demo_tool',
    description: 'A demo tool used by the dsh-peer test suite.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to send.' },
      mode: { type: 'string', enum: ['fast', 'slow'] },
      count: { type: 'integer' },
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: () => [] },
    async execute(args) { return args },
  })
  assert.equal(definition.name, 'demo_tool')
  assert.deepEqual(definition.parameters, {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to send.' },
      mode: { type: 'string', enum: ['fast', 'slow'] },
      count: { type: 'integer' },
    },
    required: ['text'],
  })
  assert.deepEqual(definition.parameters.properties.mode.enum, ['fast', 'slow'])
  assert.equal(typeof definition.execute, 'function')
  assert.equal(typeof definition.output.render, 'function')
  assert.deepEqual(compileParameters({}), { type: 'object', properties: {} })
})

test('tool: defineTool validates arguments and throws ToolArgsError', async () => {
  const definition = defineTool({
    name: 'strict_tool',
    description: 'A strict demo tool used by the dsh-peer test suite.',
    parameters: { n: { type: 'integer', required: true }, mode: { type: 'string', enum: ['a', 'b'] } },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute(args) { return args },
  })
  await assert.rejects(() => definition.execute({}, {}), (error) => error instanceof ToolArgsError && error.name === 'ToolArgsError')
  await assert.rejects(() => definition.execute({ n: 'nope' }, {}), ToolArgsError)
  await assert.rejects(() => definition.execute({ n: 1, mode: 'c' }, {}), ToolArgsError)
  assert.deepEqual(await definition.execute({ n: 3, mode: 'b' }, {}), { n: 3, mode: 'b' })
  assert.deepEqual(validateValue({ type: 'string', enum: ['x'] }, 'y'), ['arguments: must be one of "x"'])

  // JSON "number" covers integral values too (a tool arg like timeout_seconds: 180).
  const numeric = defineTool({
    name: 'numeric_tool',
    description: 'Numeric schema regression tool used by the dsh-peer test suite.',
    parameters: { n: { type: 'number', required: true }, whole: { type: 'integer' } },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute(args) { return args },
  })
  assert.deepEqual(await numeric.execute({ n: 180 }, {}), { n: 180 })
  assert.deepEqual(await numeric.execute({ n: 1.5, whole: 2 }, {}), { n: 1.5, whole: 2 })
  await assert.rejects(() => numeric.execute({ n: 1, whole: 1.5 }, {}), ToolArgsError)
})

test('plugin: TOOL_NAMES is exactly the five contract tools in order', (t) => {
  const api = requireLib(t); if (!api) return
  assert.deepEqual([...api.TOOL_NAMES], EXPECTED_TOOLS)
  assert.equal(api.name, 'dsh-peer')
  assert.deepEqual([...api.inject], ['tools'])
})

test('plugin: normalizeConfig defaults and loopback-only validation', (t) => {
  const api = requireLib(t); if (!api) return
  const config = api.normalizeConfig()
  assert.equal(config.enabled, true)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 45710)
  assert.equal(config.turnTimeoutMs, 600000)
  assert.equal(config.maxThreads, 200)
  assert.equal(config.guidance, true)
  assert.equal(config.adapters.claude.command, 'claude')
  assert.equal(config.adapters.codex.command, 'codex')
  assert.equal(config.adapters.dsh.ephemeral, true)

  assert.throws(() => api.normalizeConfig({ host: '0.0.0.0' }), (error) => error.code === 'bad-request')
  assert.throws(() => api.normalizeConfig({ host: 'localhost' }), (error) => error.code === 'bad-request')
  assert.throws(() => api.normalizeConfig({ port: 70000 }), (error) => error.code === 'bad-request')
})

test('plugin: resolvePeerHome precedence', (t) => {
  const api = requireLib(t); if (!api) return
  assert.equal(api.resolvePeerHome(api.normalizeConfig({ peerHome: '/tmp/peer-home-config' }), {}), '/tmp/peer-home-config')
  assert.equal(api.resolvePeerHome(api.normalizeConfig(), { DSH_PEER_HOME: '/tmp/peer-home-env' }), '/tmp/peer-home-env')
  assert.ok(api.resolvePeerHome(api.normalizeConfig(), {}).endsWith('.dsh-peer'))
})

test('plugin: createPeerPlugin exposes name/inject/apply with optional deps', (t) => {
  const api = requireLib(t); if (!api) return
  const plugin = api.createPeerPlugin()
  assert.equal(plugin.name, 'dsh-peer')
  assert.ok(Array.isArray(plugin.inject))
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof api.default.createPeerPlugin, 'function')
})

test('plugin: buildToolDefinitions registers exactly five well-formed tools', (t) => {
  const api = requireLib(t); if (!api) return
  const definitions = api.buildToolDefinitions({
    deps: {},
    bridge: fakeBridge(),
    store: fakeStore(),
    config: api.normalizeConfig(),
    host: {},
  })
  assert.equal(definitions.length, 5)
  assert.deepEqual(definitions.map((definition) => definition.name), EXPECTED_TOOLS)
  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 20)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.parameters.properties, 'object')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(definition.output.schema.type, 'object')
  }
  const ask = definitions[1]
  assert.match(ask.description, /minute/i)
  assert.match(ask.description, /timeout_seconds/)
  assert.deepEqual(ask.parameters.properties.harness.enum, ['dsh', 'claude', 'codex', 'codex-desktop'])
  assert.ok(ask.parameters.required.includes('harness'))
  assert.ok(ask.parameters.required.includes('prompt'))

  // Output schemas must stay open: a thread carries null for unset
  // model/effort/remoteSessionId/lastError and the host validates the value.
  for (const definition of definitions) {
    const schema = definition.output.schema
    assert.equal(schema.type, 'object')
    if (definition.name !== 'peer_ask' && definition.name !== 'peer_status' && definition.name !== 'peer_wait' && definition.name !== 'peer_send') continue
    const properties = schema.properties ?? {}
    for (const key of ['thread', 'reply', 'messages']) {
      if (properties[key] === undefined) continue
      const child = properties[key]
      const target = child.items ?? child
      assert.equal(Object.keys(target.properties ?? {}).length, 0, key + ' schema must stay open')
    }
  }
})

test('plugin: tool executions use the bridge/store wiring', async (t) => {
  const api = requireLib(t); if (!api) return
  const turns = []
  const threads = [{ id: 'thr_1', harness: 'claude', status: 'open' }]
  const definitions = api.buildToolDefinitions({
    deps: {},
    bridge: fakeBridge({
      async sendMessage(args) {
        turns.push(args)
        return { message: { seq: 0, id: 'msg_a', role: 'user', text: args.text }, reply: { seq: 1, id: 'msg_b', role: 'assistant', text: 'pong' }, thread: threads[0] }
      },
    }),
    store: fakeStore({
      async listThreads() { return threads },
      async getThread(id) { return threads.find((thread) => thread.id === id) },
      async readMessages() { return [{ seq: 1, id: 'msg_b', role: 'assistant', text: 'pong' }] },
      async closeThread(id) { return { ...threads[0], id, status: 'closed' } },
    }),
    config: api.normalizeConfig(),
    host: {},
  })
  const [status, ask, send, wait, thread] = definitions

  const signal = new AbortController().signal
  const statusOut = await status.execute({}, { signal })
  assert.deepEqual(statusOut.threads, threads)
  assert.deepEqual(statusOut.host.sessions, [])

  const askOut = await ask.execute({ harness: 'claude', prompt: 'ping', thread_id: 'thr_1' }, { signal })
  assert.equal(askOut.thread_id, 'thr_1')
  assert.equal(askOut.text, 'pong')
  assert.equal(turns[0].await, true)
  assert.equal(turns[0].text, 'ping')

  const sendOut = await send.execute({ thread_id: 'thr_1', text: 'again' })
  assert.equal(sendOut.message.text, 'again')
  assert.equal(sendOut.thread.id, 'thr_1')

  const waitOut = await wait.execute({ thread_id: 'thr_1', after: 0 }, { signal })
  assert.equal(waitOut.next_cursor, 2)
  assert.equal(waitOut.messages.length, 1)

  const listOut = await thread.execute({ action: 'list' })
  assert.deepEqual(listOut.threads, threads)
  const closeOut = await thread.execute({ action: 'close', thread_id: 'thr_1' })
  assert.equal(closeOut.thread.status, 'closed')
})

test('plugin: createHost lists sessions and delivers to a fake live agent', async (t) => {
  const api = requireLib(t); if (!api) return
  const home = await peerHome(t)
  const agent = makeFakeAgent()
  const { ctx } = makeFakeCtx(agent)
  const config = api.normalizeConfig({ peerHome: home })
  const host = api.createHost(ctx, config, { SessionSeq: (n) => n }, { logger: api.createLogger() })

  assert.deepEqual(await host.listSessions(), [{ id: agent.id, title: 'Fake session', status: 'idle' }])

  const result = await host.deliverToSession({ sessionId: agent.id, text: 'hi there' })
  assert.equal(result.text, 'live reply')
  assert.equal(result.sessionId, agent.id)
  assert.equal(agent.sent.length, 1)
  assert.equal(agent.sent[0].kind, 'followup')
  assert.match(agent.sent[0].message.content[0].text, /hi there/)

  await assert.rejects(
    () => host.deliverToSession({ sessionId: 'session-nope', text: 'x' }),
    (error) => error.code === 'inbound-unavailable' && Array.isArray(error.details?.sessions),
  )

  const runningAgent = makeFakeAgent({ id: 'session-running', reply: 'steered', running: true })
  const { ctx: runningCtx } = makeFakeCtx(runningAgent)
  const runningHost = api.createHost(runningCtx, config, { SessionSeq: (n) => n }, { logger: api.createLogger() })
  const runningResult = await runningHost.deliverToSession({ sessionId: runningAgent.id, text: 'correction' })
  assert.equal(runningResult.text, 'steered')
  assert.equal(runningAgent.sent[0].kind, 'steer')
})

test('plugin: createHost inherits the caller model route and cwd for in-process turns', async (t) => {
  const api = requireLib(t); if (!api) return
  const headerEvent = {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } } },
  }
  const caller = {
    id: 'session-caller',
    status: 'running',
    session: {
      id: 'session-caller',
      seq: 2,
      header: { cwd: '/repo/root' },
      eventAt(seq) { return seq === 1 ? headerEvent : undefined },
    },
  }
  const captured = []
  const child = {
    id: 'session-child',
    status: 'idle',
    async whenIdle() {},
    async cancel() {},
    followup() {
      child.session.events.push({ type: 'turn/start' })
      child.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'child reply' }] } } })
      child.session.events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      child.session.seq = child.session.events.length
    },
  }
  child.session = {
    id: 'session-child',
    seq: 0,
    header: {},
    events: [],
    eventAt(seq) { return this.events[seq] },
  }
  const handle = { agent: child, async dispose() {} }
  const ctx = {
    get(service) {
      if (service === 'agents') {
        return {
          list: () => [caller],
          get: () => undefined,
          async create(options) { captured.push(options); return handle },
          async resume() { return handle },
        }
      }
      if (service === 'sessions') return { async flush() {} }
      if (service === 'subagents') return { async waitForChildren() { return false } }
      if (service === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-default' }) }
      return undefined
    },
  }
  const host = api.createHost(ctx, api.normalizeConfig(), { SessionSeq: (n) => n }, { logger: api.createLogger() })
  const result = await host.runAgentTurn({ text: 'hello', callerSessionId: 'session-caller' })
  assert.equal(captured.length, 1)
  // The deployment default names the credential-less deepseek-official route;
  // the child must instead reuse the signed-in caller's recorded route.
  assert.equal(captured[0].agentOptions.provider, 'deepseek-account')
  assert.equal(captured[0].agentOptions.model, 'deepseek-flash')
  assert.equal(captured[0].agentOptions.reasoningEffort, 'high')
  assert.deepEqual(captured[0].meta, { cwd: '/repo/root' })
  assert.equal(result.text, 'child reply')
  assert.equal(result.sessionId, 'session-child')
})

test('plugin: createInboundHandler routes live sessions and fresh turns', async (t) => {
  const api = requireLib(t); if (!api) return
  const calls = []
  const host = {
    async deliverToSession(input) { calls.push({ kind: 'deliver', input }); return { text: 'delivered', sessionId: input.sessionId, resumed: true } },
    async runAgentTurn(input) { calls.push({ kind: 'turn', input }); return { text: 'turned', sessionId: 'sess-new', resumed: false } },
  }
  const inbound = api.createInboundHandler({ host })

  const delivered = await inbound({
    thread: { context: { cwd: '/tmp/cwd' }, model: 'opus', reasoning_effort: 'high' },
    message: { text: 'hello live' },
    request: { to: { session_id: 'session-live-1' } },
  })
  assert.equal(delivered.text, 'delivered')
  assert.equal(calls[0].kind, 'deliver')
  assert.equal(calls[0].input.sessionId, 'session-live-1')

  const turned = await inbound({
    thread: { context: { cwd: '/tmp/cwd', resume: 'sess-remote' }, model: 'sonnet', reasoning_effort: 'low' },
    message: { text: 'hello child' },
    request: {},
  })
  assert.equal(turned.text, 'turned')
  assert.equal(calls[1].kind, 'turn')
  assert.equal(calls[1].input.cwd, '/tmp/cwd')
  assert.equal(calls[1].input.resumeSessionId, 'sess-remote')
  assert.equal(calls[1].input.model, 'sonnet')
  assert.equal(calls[1].input.reasoningEffort, 'low')

  await assert.rejects(() => inbound({ thread: {}, message: {}, request: {} }), (error) => error.code === 'bad-request')
})

test('plugin: inbound continues a dsh thread through the recorded remote session', async (t) => {
  const api = requireLib(t); if (!api) return
  const calls = []
  const host = {
    async deliverToSession() { throw new Error('unexpected deliverToSession call') },
    async runAgentTurn(input) { calls.push(input); return { text: 'ok', sessionId: 'session-child-1', resumed: false } },
  }
  const inbound = api.createInboundHandler({ host })

  // First turn: no child session has been recorded on the thread yet.
  await inbound({ thread: { harness: 'dsh', context: {} }, message: { text: 'first turn' }, request: {} })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].resumeSessionId, undefined)

  // Second turn: the bridge stored the child session on the thread, so the
  // inbound handler must continue that exact session instead of starting over.
  await inbound({ thread: { harness: 'dsh', context: {}, remoteSessionId: 'session-child-1' }, message: { text: 'second turn' }, request: {} })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].resumeSessionId, 'session-child-1')

  // An explicit request.context.resume wins over the recorded thread session.
  await inbound({
    thread: { harness: 'dsh', context: {}, remoteSessionId: 'session-child-1' },
    message: { text: 'third turn' },
    request: { context: { resume: 'session-explicit-2' } },
  })
  assert.equal(calls.length, 3)
  assert.equal(calls[2].resumeSessionId, 'session-explicit-2')
})

test('plugin: apply registers five tools, writes bridge.json, delivers inbound, shuts down', { timeout: 30000 }, async (t) => {
  const api = requireLib(t); if (!api) return
  const home = await peerHome(t)
  const agent = makeFakeAgent({ id: 'session-e2e', reply: 'e2e reply' })
  const { ctx, registered, sections, effects } = makeFakeCtx(agent)
  const plugin = api.createPeerPlugin()
  const rawConfig = {
    peerHome: home,
    port: 0,
    token: 'plugin-token',
    adapters: {
      claude: { command: '/nonexistent/claude-xyz' },
      codex: { command: '/nonexistent/codex-xyz' },
      dsh: { defaultEffort: 'high', ephemeral: true },
    },
    guidance: true,
  }

  const handle = await plugin.apply(ctx, rawConfig)
  t.after(async () => { if (handle && typeof handle.shutdown === 'function') await handle.shutdown() })

  assert.equal(registered.length, 5)
  assert.deepEqual(registered.map((definition) => definition.name), EXPECTED_TOOLS)
  assert.equal(handle.config.host, '127.0.0.1')
  assert.equal(handle.peerHome, home)
  assert.match(handle.bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(effects.length >= 1, 'apply should register a dispose effect')
  assert.ok(sections.some((section) => section.name === 'tool:dsh-peer'), 'guidance section registered')

  const { readFile, stat } = await import('node:fs/promises')
  const bridgeFile = JSON.parse(await readFile(home + '/bridge.json', 'utf8'))
  assert.equal(bridgeFile.token, 'plugin-token')
  assert.equal(bridgeFile.url, handle.bridge.url)
  assert.deepEqual(bridgeFile.harnesses, ['dsh', 'claude', 'codex', 'codex-desktop'])

  const res = await fetch(handle.bridge.url + '/v1/inbound', {
    method: 'POST',
    headers: { authorization: 'Bearer plugin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ harness: 'dsh', text: 'hello live agent', to: { session_id: agent.id } }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.text, 'e2e reply')
  assert.equal(agent.sent.length, 1)
  assert.match(agent.sent[0].message.content[0].text, /hello live agent/)

  await handle.shutdown()
  await assert.rejects(() => stat(home + '/bridge.json'), (error) => error.code === 'ENOENT')
})

test('plugin: apply rejects a non-loopback host and respects enabled:false', async (t) => {
  const api = requireLib(t); if (!api) return
  const home = await peerHome(t)
  const plugin = api.createPeerPlugin()
  const { ctx, registered } = makeFakeCtx(undefined)
  await assert.rejects(() => plugin.apply(ctx, { host: '0.0.0.0', peerHome: home }), /loopback|127\.0\.0\.1/i)
  assert.equal(registered.length, 0)

  const disabled = await plugin.apply(ctx, { enabled: false, peerHome: home })
  assert.equal(disabled, undefined)
  assert.equal(registered.length, 0)
})

test('plugin: module-level cordis apply resolves undefined and mounts the bridge', { timeout: 30000 }, async (t) => {
  const api = requireLib(t); if (!api) return
  const home = await peerHome(t)
  const { ctx, registered, effects } = makeFakeCtx(undefined)
  // Cordis treats the return value as an effect; a non-disposer value makes the
  // loader throw "Invalid effect" and unload the plugin (the real 0.1.0 bug).
  const value = await api.apply(ctx, { peerHome: home, port: 0, token: 'cordis-token' })
  assert.equal(value, undefined, 'cordis apply must not return the control handle')
  assert.equal(registered.length, 5)
  const { readFile } = await import('node:fs/promises')
  const bridgeFile = JSON.parse(await readFile(home + '/bridge.json', 'utf8'))
  assert.match(bridgeFile.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(bridgeFile.token, 'cordis-token')
  // Run the registered effects (the plugin's shutdown disposer) to release the port.
  for (const effect of effects) {
    const dispose = effect()
    if (typeof dispose === 'function') await dispose()
  }
  await assert.rejects(() => readFile(home + '/bridge.json', 'utf8'), (error) => error.code === 'ENOENT')
})

test('plugin: waitForQuiet settles immediately when no children are running', { timeout: 5000 }, async (t) => {
  const api = requireLib(t); if (!api) return
  const agent = makeFakeAgent()
  const ctx = {
    get(service) {
      // The real subagent service reports "no children" as a falsy value; the
      // 0.1.0 bug treated that as "keep looping" and froze the host event loop.
      return service === 'subagents' ? { async waitForChildren() { return false } } : undefined
    },
  }
  const started = Date.now()
  await api.waitForQuiet(ctx, agent)
  assert.ok(Date.now() - started < 2000, 'waitForQuiet must not spin')
})

test('plugin: waitForQuiet waits out busy children then settles', { timeout: 5000 }, async (t) => {
  const api = requireLib(t); if (!api) return
  const agent = makeFakeAgent()
  let calls = 0
  const ctx = {
    get(service) {
      return service === 'subagents'
        ? { async waitForChildren() { calls += 1; return calls < 2 } }
        : undefined
    },
  }
  await api.waitForQuiet(ctx, agent)
  assert.ok(calls >= 2, 'must poll until the subagent service reports no children')
})

test('plugin: waitForQuiet times out instead of spinning forever', { timeout: 5000 }, async (t) => {
  const api = requireLib(t); if (!api) return
  let cancellations = 0
  const agent = {
    id: 'session-stuck',
    session: { id: 'session-stuck', seq: 0, eventAt() {} },
    status: 'running',
    async whenIdle() {},
    async cancel() { cancellations += 1 },
  }
  const ctx = { get(service) { return service === 'subagents' ? { async waitForChildren() { return false } } : undefined } }
  const started = Date.now()
  await assert.rejects(
    () => api.waitForQuiet(ctx, agent, { timeoutMs: 120 }),
    (error) => error && error.code === 'timeout',
  )
  assert.ok(Date.now() - started < 2500, 'bounded wait must end near the deadline')
})
