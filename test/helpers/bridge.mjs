/**
 * Shared bridge fixture: start the real HTTP bridge on an ephemeral loopback
 * port and tear it down when the test finishes.
 */
import { createBridge } from '../../lib/bridge.js'
import { waitFor } from './tmp.mjs'

function portOf(bridge) {
  if (typeof bridge.port === 'number') return bridge.port
  if (typeof bridge.address === 'function') {
    const address = bridge.address()
    if (address && typeof address === 'object') return address.port
  }
  const address = bridge.server?.address?.()
  return address && typeof address === 'object' ? address.port : undefined
}

/**
 * @param {{store: unknown, adapters: unknown, inbound?: Function, config: object, logger?: unknown, sessions?: Function}} deps
 * @returns {Promise<{bridge: any, url: string, port: number, token: string}>}
 */
export async function openBridge(deps, t) {
  const token = deps.config?.token
  const bridge = await createBridge(deps)
  let url = bridge.url
  if (!url) {
    const start = bridge.listen ?? bridge.start
    if (typeof start === 'function') {
      const returned = await start.call(bridge)
      if (typeof returned === 'string') url = returned
    }
  }
  const port = portOf(bridge)
  if (!url) url = `http://127.0.0.1:${port}`
  if (!url || url.includes('undefined')) {
    throw new Error('bridge did not expose a url/port after createBridge()/listen()')
  }
  url = url.replace(/\/$/, '')
  await waitFor(async () => {
    try {
      const res = await fetch(`${url}/v1/health`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
      return res.ok
    } catch {
      return false
    }
  }, { label: 'GET /v1/health', timeoutMs: 5000 })
  t.after(async () => {
    const stop = bridge.close ?? bridge.stop
    if (typeof stop === 'function') await stop.call(bridge)
  })
  return { bridge, url, port: portOf(bridge) ?? port, token }
}
