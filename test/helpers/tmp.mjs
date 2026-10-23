/**
 * Test helpers: temp dirs, fake executables, stream capture, polling.
 * Zero dependencies; Node >= 20 ESM.
 */
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Create a temp dir removed automatically when the test finishes. */
export async function tempDir(t, prefix = 'dsh-peer-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

/** Create a temp PEER_HOME with an existing threads/ dir. */
export async function peerHome(t, prefix = 'dsh-peer-home-') {
  const dir = await tempDir(t, prefix)
  await mkdir(join(dir, 'threads'), { recursive: true })
  return dir
}

/** Write a file and mark it 0755. */
export async function writeExecutable(filePath, content) {
  await writeFile(filePath, content, { mode: 0o755 })
  await chmod(filePath, 0o755)
  return filePath
}

/**
 * Create a fake CLI executable in dir. Body may use node builtins; it is
 * prefixed with a node shebang. Returns the absolute path.
 */
export async function fakeCli(dir, name, body) {
  const path = join(dir, name)
  const source = '#!/usr/bin/env node\n' + body.trimStart() + '\n'
  await writeExecutable(path, source)
  return path
}

/** In-memory writable stream that captures everything written to it. */
export function captureStream() {
  const chunks = []
  return {
    write(chunk) { chunks.push(String(chunk)); return true },
    get text() { return chunks.join('') },
    get chunks() { return chunks.slice() },
  }
}

/** Resolve after ms milliseconds. */
export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

/** Poll fn until it returns a truthy value, or throw after timeoutMs. */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** Absolute path to the package root (dsh-peer/), from this helper file. */
export const packageRoot = new URL('../../', import.meta.url).pathname
