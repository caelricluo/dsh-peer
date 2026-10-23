/**
 * CONTRACT sections 3 + 7 + 10.4: arg parsing, discovery order, exit codes
 * (2 unreachable, 3 unauthorized), ask text/json output against the real
 * bridge, and skill CLI parity with bin/peer.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { runCli, parseArgs } from '../lib/cli.js'
import { createStore } from '../lib/store.js'
import { peerHome, tempDir, captureStream } from './helpers/tmp.mjs'
import { openBridge } from './helpers/bridge.mjs'

const TOKEN = 'cli-token'
const HARNESS_IDS = ['dsh', 'claude', 'codex']

function fakeAdapters(runTurn = async ({ userText }) => ({ text: 'canned:' + userText, meta: { model: 'fake' } })) {
  const make = (harness) => ({
    harness,
    async describe() {
      return { harness, available: true, models: ['fake-model'], defaultModel: 'fake-model' }
    },
    async runTurn(args) { return runTurn(args) },
  })
  return {
    async all() { return HARNESS_IDS.map(make) },
    async get(harness) {
      if (!HARNESS_IDS.includes(harness)) throw new Error('unknown harness: ' + harness)
      return make(harness)
    },
  }
}

async function run(argv, env) {
  const stdout = captureStream()
  const stderr = captureStream()
  const code = await runCli(argv, { env, cwd: process.cwd(), stdout, stderr })
  return { code, out: stdout.text, err: stderr.text }
}

function baseEnv(home, extra = {}) {
  return { HOME: home, USERPROFILE: home, DSH_PEER_HOME: home, PATH: process.env.PATH, ...extra }
}

test('cli: parseArgs splits command, options and positional', () => {
  const ask = parseArgs(['ask', '--to', 'claude', '--model', 'opus', 'hello', 'world'])
  assert.equal(ask.command, 'ask')
  assert.equal(ask.options.to, 'claude')
  assert.equal(ask.options.model, 'opus')
  assert.deepEqual(ask.positional, ['hello', 'world'])

  const read = parseArgs(['read', '--thread', 'thr_0123456789ab', '--after', '2', '--wait', '5'])
  assert.equal(read.command, 'read')
  assert.equal(read.options.thread, 'thr_0123456789ab')
  assert.equal(String(read.options.after), '2')
  assert.equal(String(read.options.wait), '5')

  const json = parseArgs(['status', '--json'])
  assert.equal(json.command, 'status')
  assert.equal(json.options.json, true)

  const stdin = parseArgs(['ask', '--to', 'codex', '-'])
  assert.deepEqual(stdin.positional, ['-'])
})

test('cli: exit code 2 when the bridge is unreachable', async (t) => {
  const home = await peerHome(t)
  const out = await run(['status'], baseEnv(home, {
    PEER_BRIDGE_URL: 'http://127.0.0.1:1',
    PEER_BRIDGE_TOKEN: TOKEN,
  }))
  assert.equal(out.code, 2, 'stderr: ' + out.err)
  assert.ok(out.err.length > 0, 'expected a diagnostic on stderr')
})

test('cli: usage error returns 1', async (t) => {
  const home = await peerHome(t)
  const out = await run(['definitely-not-a-command'], baseEnv(home))
  assert.equal(out.code, 1, 'stderr: ' + out.err)
  assert.ok(out.err.length > 0)
})

test('cli: --help prints usage and exits 0', async (t) => {
  const home = await peerHome(t)
  const out = await run(['--help'], baseEnv(home))
  assert.equal(out.code, 0, 'stderr: ' + out.err)
  assert.match(out.out, /ask/)
  assert.match(out.out, /--to/)
})

test('cli against a live bridge', { timeout: 45000 }, async (t) => {
  const home = await peerHome(t)
  const store = createStore({ home })
  await store.init()
  t.after(async () => { await store.close?.() })
  const { url } = await openBridge({
    store,
    adapters: fakeAdapters(),
    inbound: async (args) => ({ text: 'inbound:' + args.message.text, sessionId: 'sess-inbound' }),
    config: { host: '127.0.0.1', port: 0, token: TOKEN, turnTimeoutMs: 5000, packageVersion: '0.1.0' },
    sessions: () => [{ id: 'session-1', title: 'Live', status: 'idle' }],
  }, t)
  const env = (extra = {}) => baseEnv(home, { PEER_BRIDGE_URL: url, PEER_BRIDGE_TOKEN: TOKEN, ...extra })

  await t.test('status --json reports health + adapters + sessions', async () => {
    const out = await run(['status', '--json'], env())
    assert.equal(out.code, 0, 'stderr: ' + out.err)
    const parsed = JSON.parse(out.out)
    assert.equal(parsed.ok ?? parsed.health?.ok, true)
    const adapters = parsed.adapters ?? parsed.health?.adapters
    assert.equal(adapters.length, 3)
    const sessions = parsed.sessions ?? parsed.host?.sessions ?? parsed.health?.host?.sessions
    assert.deepEqual(sessions, [{ id: 'session-1', title: 'Live', status: 'idle' }])
  })

  await t.test('ask text mode prints exactly the reply and a newline', async () => {
    const out = await run(['ask', '--to', 'claude', 'hello world'], env())
    assert.equal(out.code, 0, 'stderr: ' + out.err)
    assert.equal(out.out, 'canned:hello world\n')
  })

  await t.test('ask --json emits the documented JSON envelope', async () => {
    const out = await run(['ask', '--to', 'claude', '--json', 'hello json'], env())
    assert.equal(out.code, 0, 'stderr: ' + out.err)
    const parsed = JSON.parse(out.out)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.text, 'canned:hello json')
    assert.equal(parsed.reply.text, 'canned:hello json')
    assert.equal(parsed.thread.harness, 'claude')
    assert.equal(typeof parsed.session, 'object')
  })

  await t.test('exit code 3 on a refused token', async () => {
    const out = await run(['status'], env({ PEER_BRIDGE_TOKEN: 'wrong-token' }))
    assert.equal(out.code, 3, 'stderr: ' + out.err)
    assert.match(out.err, /token|unauthorized/i)
  })

  await t.test('discovery: PEER_BRIDGE_URL/TOKEN beat a stale bridge.json', async () => {
    await writeFile(join(home, 'bridge.json'), JSON.stringify({ version: 1, url: 'http://127.0.0.1:1', token: 'stale' }), { mode: 0o600 })
    await chmod(join(home, 'bridge.json'), 0o600)
    const out = await run(['status', '--json'], env())
    assert.equal(out.code, 0, 'stderr: ' + out.err)
  })

  await t.test('discovery: --url/--token beat environment values', async () => {
    const out = await run(['status', '--json', '--url', url, '--token', TOKEN], env({
      PEER_BRIDGE_URL: 'http://127.0.0.1:1',
      PEER_BRIDGE_TOKEN: 'wrong-token',
    }))
    assert.equal(out.code, 0, 'stderr: ' + out.err)
  })

  await t.test('discovery: falls back to $DSH_PEER_HOME/bridge.json', async () => {
    await writeFile(join(home, 'bridge.json'), JSON.stringify({ version: 1, url, token: TOKEN }), { mode: 0o600 })
    const out = await run(['status', '--json'], baseEnv(home))
    assert.equal(out.code, 0, 'stderr: ' + out.err)
  })
})

test('cli: skills/cross-harness-peer/scripts/peer.mjs parity with bin/peer.mjs', async (t) => {
  const binPath = new URL('../bin/peer.mjs', import.meta.url)
  const skillPath = new URL('../skills/cross-harness-peer/scripts/peer.mjs', import.meta.url)
  let binSource
  try {
    binSource = await readFile(binPath)
  } catch (error) {
    t.skip('bin/peer.mjs not written yet: ' + error.message)
    return
  }
  let skillSource
  try {
    skillSource = await readFile(skillPath)
  } catch (error) {
    t.skip('skill copy not installed yet (scripts/install-skill.mjs): ' + error.message)
    return
  }
  assert.deepEqual(skillSource, binSource, 'skill copy must be byte-identical to bin/peer.mjs')
  assert.match(binSource.toString('utf8'), /^#!\/usr\/bin\/env node/)
})
