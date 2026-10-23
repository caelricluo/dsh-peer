/**
 * CONTRACT section 10.1: store append/read/atomic index, long-poll wakeup,
 * concurrent appends. Pinned to the Lead's authoritative store API:
 *   createStore({ home, maxThreads, logger }) ->
 *     init, createThread, getThread, listThreads, updateThread, appendMessage,
 *     readMessages({ after, waitSeconds, signal }) -> Message[], closeThread,
 *     subscribe(listener) -> unsubscribe, close
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { peerHome, sleep } from './helpers/tmp.mjs'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

async function openStore(t) {
  const home = await peerHome(t)
  const store = createStore({ home })
  await store.init()
  t.after(async () => { if (typeof store.close === 'function') await store.close() })
  return { store, home }
}

test('store: init + createThread defaults and ids', async (t) => {
  const { store } = await openStore(t)
  const thread = await store.createThread({
    harness: 'claude',
    title: 'hello thread',
    model: 'opus',
    reasoning_effort: 'high',
    context: { cwd: '/tmp/example' },
    createdBy: { harness: 'dsh' },
  })
  assert.match(thread.id, /^thr_[0-9a-f]{12}$/)
  assert.equal(thread.harness, 'claude')
  assert.equal(thread.title, 'hello thread')
  assert.equal(thread.model, 'opus')
  assert.equal(thread.reasoning_effort, 'high')
  assert.equal(thread.context.cwd, '/tmp/example')
  assert.equal(thread.status, 'open')
  assert.match(thread.createdAt, ISO)
  assert.match(thread.updatedAt, ISO)
  assert.deepEqual(thread.createdBy, { harness: 'dsh' })
  assert.equal(thread.remoteSessionId, null)
  assert.equal(thread.messageCount, 0)
  assert.equal(thread.lastError, null)
})

test('store: getThread unknown id resolves undefined', async (t) => {
  const { store } = await openStore(t)
  assert.equal(await store.getThread('thr_000000000000'), undefined)
})

test('store: append/read ordering, ids and counters', async (t) => {
  const { store } = await openStore(t)
  const thread = await store.createThread({ harness: 'claude' })
  const first = await store.appendMessage(thread.id, { role: 'user', text: 'one', from: { harness: 'user' } })
  const second = await store.appendMessage(thread.id, { role: 'assistant', text: 'two', meta: { model: 'fake' } })
  assert.equal(first.seq, 0)
  assert.equal(second.seq, 1)
  assert.match(first.id, /^msg_[0-9a-f]{12}$/)
  assert.equal(first.threadId, thread.id)
  assert.equal(first.role, 'user')
  assert.equal(first.text, 'one')
  assert.match(first.createdAt, ISO)
  assert.deepEqual(first.from, { harness: 'user' })
  assert.equal(second.meta.model, 'fake')

  const all = await store.readMessages(thread.id, { after: 0 })
  assert.deepEqual(all.map((m) => m.seq), [0, 1])
  const tail = await store.readMessages(thread.id, { after: 1 })
  assert.deepEqual(tail.map((m) => m.seq), [1])
  assert.deepEqual(await store.readMessages(thread.id, { after: 99 }), [])

  const updated = await store.getThread(thread.id)
  assert.equal(updated.messageCount, 2)
  assert.ok(Date.parse(updated.updatedAt) >= Date.parse(thread.updatedAt))
})

test('store: listThreads newest first, status filter, limit', async (t) => {
  const { store } = await openStore(t)
  const a = await store.createThread({ harness: 'claude', title: 'a' })
  await sleep(5)
  const b = await store.createThread({ harness: 'codex', title: 'b' })
  await sleep(5)
  const c = await store.createThread({ harness: 'dsh', title: 'c' })
  await store.closeThread(b.id)

  const all = await store.listThreads()
  assert.equal(all.length, 3)
  assert.deepEqual(all.map((th) => th.id), [c.id, b.id, a.id])

  const open = await store.listThreads({ status: 'open' })
  assert.deepEqual(open.map((th) => th.id).sort(), [a.id, c.id].sort())

  assert.equal((await store.listThreads({ limit: 2 })).length, 2)
})

test('store: closeThread is idempotent', async (t) => {
  const { store } = await openStore(t)
  const thread = await store.createThread({ harness: 'claude' })
  const closed = await store.closeThread(thread.id)
  assert.equal(closed.status, 'closed')
  const again = await store.closeThread(thread.id)
  assert.equal(again.status, 'closed')
  assert.equal((await store.getThread(thread.id)).status, 'closed')
})

test('store: updateThread merges patch', async (t) => {
  const { store } = await openStore(t)
  const thread = await store.createThread({ harness: 'claude' })
  const updated = await store.updateThread(thread.id, { remoteSessionId: 'sess-1', title: 'renamed' })
  assert.equal(updated.remoteSessionId, 'sess-1')
  assert.equal(updated.title, 'renamed')
  assert.equal(updated.status, 'open')
  assert.equal((await store.getThread(thread.id)).remoteSessionId, 'sess-1')
})

test('store: index.json is valid JSON, has no leftover temp files', async (t) => {
  const { store, home } = await openStore(t)
  const thread = await store.createThread({ harness: 'claude' })
  await store.appendMessage(thread.id, { role: 'user', text: 'x' })
  const indexPath = join(home, 'threads', 'index.json')
  const raw = await readFile(indexPath, 'utf8')
  const parsed = JSON.parse(raw)
  assert.ok(raw.includes(thread.id), 'index.json should reference the thread id')
  assert.ok(parsed !== null && typeof parsed === 'object')
  const entries = await readdir(join(home, 'threads'))
  assert.deepEqual(entries.filter((name) => /\.(tmp|new|part)$/.test(name)), [])
  assert.ok(entries.some((name) => name === thread.id + '.jsonl'), 'per-thread jsonl log exists')
})

test('store: message log is append-only JSONL', async (t) => {
  const { store, home } = await openStore(t)
  const thread = await store.createThread({ harness: 'claude' })
  await store.appendMessage(thread.id, { role: 'user', text: 'line one' })
  await store.appendMessage(thread.id, { role: 'assistant', text: 'line two' })
  const raw = await readFile(join(home, 'threads', thread.id + '.jsonl'), 'utf8')
  const lines = raw.trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).text, 'line one')
  assert.equal(JSON.parse(lines[1]).text, 'line two')
})

test('store: readMessages long-poll wakes on append', async (t) => {
  const { store } = await openStore(t)
  const thread = await store.createThread({ harness: 'claude' })
  await store.appendMessage(thread.id, { role: 'user', text: 'first' })

  const started = Date.now()
  const pending = store.readMessages(thread.id, { after: 1, waitSeconds: 5 })
  await sleep(120)
  await store.appendMessage(thread.id, { role: 'assistant', text: 'woke' })
  const messages = await pending
  const elapsed = Date.now() - started
  assert.ok(elapsed < 4000, `long-poll returned after ${elapsed}ms, expected a wakeup`)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].seq, 1)
  assert.equal(messages[0].text, 'woke')
})

test('store: readMessages long-poll returns [] on timeout', async (t) => {
  const { store } = await openStore(t)
  const thread = await store.createThread({ harness: 'claude' })
  const started = Date.now()
  const messages = await store.readMessages(thread.id, { after: 0, waitSeconds: 1 })
  const elapsed = Date.now() - started
  assert.deepEqual(messages, [])
  assert.ok(elapsed >= 700, `timeout poll returned after ${elapsed}ms, expected ~1000ms`)
})

test('store: concurrent appends stay ordered and complete', async (t) => {
  const { store, home } = await openStore(t)
  const thread = await store.createThread({ harness: 'claude' })
  const total = 25
  await Promise.all(
    Array.from({ length: total }, (_, i) => store.appendMessage(thread.id, { role: 'user', text: 'm' + i })),
  )
  const messages = await store.readMessages(thread.id, { after: 0 })
  assert.equal(messages.length, total)
  assert.deepEqual(messages.map((m) => m.seq), Array.from({ length: total }, (_, i) => i))
  assert.equal((await store.getThread(thread.id)).messageCount, total)
  // index stays valid JSON after concurrent writes and no temp files linger
  JSON.parse(await readFile(join(home, 'threads', 'index.json'), 'utf8'))
  const entries = await readdir(join(home, 'threads'))
  assert.deepEqual(entries.filter((name) => /\.(tmp|new|part)$/.test(name)), [])
})

test('store: subscribe emits message/thread events and unsubscribes', async (t) => {
  const { store } = await openStore(t)
  const events = []
  const unsubscribe = store.subscribe((event) => events.push(event))
  assert.equal(typeof unsubscribe, 'function')
  const thread = await store.createThread({ harness: 'claude' })
  const message = await store.appendMessage(thread.id, { role: 'user', text: 'evt' })
  await sleep(20)
  const messageEvent = events.find((e) => e.type === 'message')
  assert.ok(messageEvent, 'expected a message event')
  assert.equal(messageEvent.threadId, thread.id)
  assert.equal(messageEvent.message.seq, message.seq)
  unsubscribe()
  const before = events.length
  await store.appendMessage(thread.id, { role: 'assistant', text: 'after unsubscribe' })
  await sleep(20)
  assert.equal(events.length, before)
})
