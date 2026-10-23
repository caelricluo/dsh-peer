/**
 * CONTRACT sections 4 + 10.2: auth rejection, thread CRUD, await + async
 * turns, closed thread, long-poll, inbound routing with a fake host, SSE.
 * Runs the real HTTP bridge against a real file-backed store.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../lib/store.js'
import { peerHome, sleep, waitFor } from './helpers/tmp.mjs'
import { openBridge } from './helpers/bridge.mjs'

const TOKEN = 'test-token'
const HARNESS_IDS = ['dsh', 'claude', 'codex']

function fakeAdapter(harness, turnCalls) {
  return {
    harness,
    async describe() {
      return {
        harness,
        available: true,
        version: '9.9.9',
        command: '/fake/' + harness,
        models: ['fake-model'],
        defaultModel: 'fake-model',
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: null,
        context: { cwd: true, systemPrompt: true, appendSystemPrompt: true, files: true, resume: true, addDirs: true },
      }
    },
    async openThread() {},
    async runTurn(args) {
      turnCalls.push(args)
      return { text: 'canned:' + args.userText, meta: { model: 'fake-model', durationMs: 1 }, remoteSessionId: 'remote-' + harness }
    },
    async closeThread() {},
  }
}

function fakeAdapters(turnCalls) {
  return {
    async all() { return HARNESS_IDS.map((harness) => fakeAdapter(harness, turnCalls)) },
    async get(harness) {
      if (!HARNESS_IDS.includes(harness)) {
        const error = new Error('unknown harness: ' + harness)
        error.code = 'missing-harness'
        throw error
      }
      return fakeAdapter(harness, turnCalls)
    },
  }
}

test('bridge HTTP surface', { timeout: 45000 }, async (t) => {
  const home = await peerHome(t)
  const store = createStore({ home })
  await store.init()
  t.after(async () => { await store.close?.() })

  const turnCalls = []
  const inboundCalls = []
  const sessions = () => [{ id: 'session-live-1', title: 'Live', status: 'idle' }]

  const { url } = await openBridge({
    store,
    adapters: fakeAdapters(turnCalls),
    inbound: async (args) => {
      inboundCalls.push(args)
      return { text: 'inbound:' + args.message.text, sessionId: 'sess-inbound-1', resumed: false }
    },
    config: { host: '127.0.0.1', port: 0, token: TOKEN, turnTimeoutMs: 5000, packageVersion: '0.1.0' },
    sessions,
  }, t)

  const req = async (path, { method = 'GET', body, token = TOKEN, signal } = {}) => {
    const headers = {}
    if (token !== null) headers.authorization = 'Bearer ' + token
    let payload
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = typeof body === 'string' ? body : JSON.stringify(body)
    }
    const res = await fetch(url + path, { method, headers, body: payload, signal })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = undefined }
    return { res, status: res.status, json, text, headers: res.headers }
  }

  const createThread = async (body) => {
    const out = await req('/v1/threads', { method: 'POST', body: { harness: 'claude', ...body } })
    assert.equal(out.status, 201, 'create thread: ' + out.text)
    return out.json.thread
  }

  await t.test('GET /v1/health reports protocol, host sessions and adapters', async () => {
    const out = await req('/v1/health')
    assert.equal(out.status, 200)
    assert.equal(out.json.ok, true)
    assert.equal(out.json.version, 1)
    assert.equal(out.json.packageVersion, '0.1.0')
    assert.equal(typeof out.json.uptimeMs, 'number')
    assert.equal(out.json.host.harness, 'dsh')
    assert.equal(typeof out.json.host.pid, 'number')
    assert.deepEqual(out.json.host.sessions, [{ id: 'session-live-1', title: 'Live', status: 'idle' }])
    assert.equal(out.json.adapters.length, 3)
    assert.deepEqual(out.json.adapters.map((a) => a.harness), HARNESS_IDS)
  })

  await t.test('GET /v1/adapters lists AdapterInfo', async () => {
    const out = await req('/v1/adapters')
    assert.equal(out.status, 200)
    assert.equal(out.json.adapters.length, 3)
    const claude = out.json.adapters.find((a) => a.harness === 'claude')
    assert.equal(claude.available, true)
    assert.equal(claude.defaultModel, 'fake-model')
  })

  await t.test('auth: missing token -> 401 unauthorized, wrong token -> 401', async () => {
    const missing = await req('/v1/health', { token: null })
    assert.equal(missing.status, 401)
    assert.equal(missing.json.error.code, 'unauthorized')
    const wrong = await req('/v1/threads?status=open', { token: 'not-the-token' })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.json.error.code, 'unauthorized')
  })

  await t.test('bad bodies -> 400 bad-request', async () => {
    const badJson = await req('/v1/threads', { method: 'POST', body: '{not json' })
    assert.equal(badJson.status, 400)
    assert.equal(badJson.json.error.code, 'bad-request')
    const badHarness = await req('/v1/threads', { method: 'POST', body: { harness: 'bogus' } })
    assert.equal(badHarness.status, 400)
    assert.equal(badHarness.json.error.code, 'bad-request')
    const noHarness = await req('/v1/threads', { method: 'POST', body: {} })
    assert.equal(noHarness.status, 400)
  })

  await t.test('oversized body (>1 MiB) is rejected with a JSON 4xx', async () => {
    const out = await req('/v1/threads', { method: 'POST', body: { harness: 'claude', title: 'x'.repeat(1024 * 1024 + 10) } })
    assert.ok(out.status >= 400 && out.status < 500, 'expected 4xx, got ' + out.status)
    assert.ok(out.json?.error?.code, 'expected a JSON error body')
  })

  await t.test('thread create/get/list/close lifecycle', async () => {
    const thread = await createThread({
      title: 'lifecycle',
      model: 'opus',
      reasoning_effort: 'high',
      context: { cwd: '/tmp/peer-cwd' },
      createdBy: { harness: 'dsh' },
    })
    assert.match(thread.id, /^thr_[0-9a-f]{12}$/)
    assert.equal(thread.harness, 'claude')
    assert.equal(thread.title, 'lifecycle')
    assert.equal(thread.model, 'opus')
    assert.equal(thread.reasoning_effort, 'high')
    assert.equal(thread.context.cwd, '/tmp/peer-cwd')
    assert.equal(thread.status, 'open')
    assert.match(thread.createdAt, /^\d{4}-\d{2}-\d{2}T/)

    const got = await req('/v1/threads/' + thread.id)
    assert.equal(got.status, 200)
    assert.equal(got.json.thread.id, thread.id)
    assert.deepEqual(got.json.messages, [])
    assert.equal(got.json.next_cursor, 0)

    const listed = await req('/v1/threads?status=open&limit=50')
    assert.equal(listed.status, 200)
    assert.ok(listed.json.threads.some((th) => th.id === thread.id))

    const closed = await req('/v1/threads/' + thread.id + '/close', { method: 'POST', body: {} })
    assert.equal(closed.status, 200)
    assert.equal(closed.json.thread.status, 'closed')
    const closedAgain = await req('/v1/threads/' + thread.id + '/close', { method: 'POST', body: {} })
    assert.equal(closedAgain.status, 200)
    assert.equal(closedAgain.json.thread.status, 'closed')
  })

  await t.test('await:true returns the canned reply synchronously', async () => {
    const thread = await createThread({})
    const out = await req('/v1/threads/' + thread.id + '/messages', {
      method: 'POST',
      body: { text: 'hello', await: true },
    })
    assert.equal(out.status, 200, out.text)
    assert.equal(out.json.message.role, 'user')
    assert.equal(out.json.message.seq, 0)
    assert.equal(out.json.message.text, 'hello')
    assert.equal(out.json.reply.role, 'assistant')
    assert.equal(out.json.reply.text, 'canned:hello')
    assert.equal(out.json.thread.messageCount, 2)
    assert.ok(turnCalls.some((call) => call.userText === 'hello'))
  })

  await t.test('await:false returns early; reply appears via long-poll', async () => {
    const thread = await createThread({})
    const out = await req('/v1/threads/' + thread.id + '/messages', {
      method: 'POST',
      body: { text: 'later', await: false },
    })
    assert.equal(out.status, 200, out.text)
    assert.equal(out.json.message.text, 'later')
    assert.equal(out.json.reply, null)

    const polled = await waitFor(async () => {
      const r = await req('/v1/threads/' + thread.id + '?after=1&wait_seconds=5', { signal: AbortSignal.timeout(10000) })
      return r.json.messages.some((m) => m.role === 'assistant' && m.text === 'canned:later') ? r : false
    }, { label: 'background reply', timeoutMs: 8000 })
    const messages = polled.json.messages
    assert.equal(messages[0].seq, 1)
    assert.equal(polled.json.next_cursor, 2)
  })

  await t.test('long-poll wakes up when another message is appended', async () => {
    const thread = await createThread({})
    const first = await req('/v1/threads/' + thread.id + '/messages', { method: 'POST', body: { text: 'first', await: false } })
    assert.equal(first.status, 200)
    await waitFor(async () => {
      const r = await req('/v1/threads/' + thread.id + '?after=2')
      return r.json.messages.length === 0
    }, { label: 'reply settled' })

    const started = Date.now()
    const pending = req('/v1/threads/' + thread.id + '?after=2&wait_seconds=10', { signal: AbortSignal.timeout(9000) })
    await sleep(150)
    await req('/v1/threads/' + thread.id + '/messages', { method: 'POST', body: { text: 'second', await: false } })
    const out = await pending
    const elapsed = Date.now() - started
    assert.equal(out.status, 200)
    assert.ok(out.json.messages.length >= 1, 'long-poll should return the new message')
    assert.equal(out.json.messages[0].text, 'second')
    assert.ok(elapsed < 6000, 'long-poll returned after ' + elapsed + 'ms')
  })

  await t.test('closed thread rejects new messages with 409 thread-closed', async () => {
    const thread = await createThread({})
    await req('/v1/threads/' + thread.id + '/close', { method: 'POST', body: {} })
    const out = await req('/v1/threads/' + thread.id + '/messages', { method: 'POST', body: { text: 'nope', await: true } })
    assert.equal(out.status, 409)
    assert.equal(out.json.error.code, 'thread-closed')
  })

  await t.test('dsh threads route through the injected inbound handler', async () => {
    const thread = await createThread({ harness: 'dsh' })
    const out = await req('/v1/threads/' + thread.id + '/messages', { method: 'POST', body: { text: 'ping', await: true } })
    assert.equal(out.status, 200, out.text)
    assert.equal(out.json.reply.text, 'inbound:ping')
    assert.equal(inboundCalls.length, 1)
    assert.equal(inboundCalls[0].thread.id, thread.id)
    assert.equal(inboundCalls[0].message.text, 'ping')
    assert.ok(!turnCalls.some((call) => call.userText === 'ping'), 'dsh turns must not hit the adapter registry')
  })

  await t.test('unknown route -> 404 not-found JSON', async () => {
    const out = await req('/v1/definitely-not-a-route')
    assert.equal(out.status, 404)
    assert.equal(out.json.error.code, 'not-found')
  })

  await t.test('GET /v1/events opens an SSE stream', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(url + '/v1/events', {
        headers: { authorization: 'Bearer ' + TOKEN },
        signal: controller.signal,
      })
      assert.equal(res.status, 200)
      assert.ok(
        (res.headers.get('content-type') ?? '').startsWith('text/event-stream'),
        'content-type was ' + res.headers.get('content-type'),
      )
      await res.body?.cancel().catch(() => {})
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    const unauthorized = await req('/v1/events', { token: null })
    assert.equal(unauthorized.status, 401)
  })

  await t.test('bridge object API: health(), describeAdapters(), createThread(), sendMessage()', async () => {
    const bridge = (await openBridge({
      store: createStore({ home: await peerHome(t) }),
      adapters: fakeAdapters(turnCalls),
      inbound: async (args) => ({ text: 'inbound:' + args.message.text }),
      config: { host: '127.0.0.1', port: 0, token: TOKEN, turnTimeoutMs: 5000, packageVersion: '0.1.0' },
      sessions,
    }, t)).bridge
    await bridge.listen?.()
    const health = await bridge.health()
    assert.equal(health.ok, true)
    assert.equal((await bridge.describeAdapters()).length, 3)
    const created = await bridge.createThread({ harness: 'claude', title: 'direct' })
    assert.match(created.thread.id, /^thr_/)
    const sent = await bridge.sendMessage({ threadId: created.thread.id, text: 'direct-call', await: true })
    assert.equal(sent.reply.text, 'canned:direct-call')
  })
})
