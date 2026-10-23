/**
 * Adapter registry.
 *
 * Creates one adapter per known harness. `all()` returns adapter instances in
 * canonical order (dsh, claude, codex); each `describe()` resolves to AdapterInfo
 * and never throws, reporting `available:false` plus `notes` when a CLI or the
 * in-process host is missing.
 *
 * @module @caelricluo/dsh-peer/adapters
 */

import { BridgeError, HARNESSES } from '../protocol.js'
import { createClaudeAdapter } from './claude.js'
import { createCodexAdapter } from './codex.js'
import { createCodexDesktopAdapter } from './codex-desktop.js'
import { createDshAdapter } from './dsh.js'

export { createClaudeAdapter } from './claude.js'
export { createCodexAdapter } from './codex.js'
export { createCodexDesktopAdapter } from './codex-desktop.js'
export { createDshAdapter } from './dsh.js'

/**
 * Build the adapter registry.
 * @param {{config?: Record<string, any>, logger?: any, host?: any}} [deps]
 *   config is the normalized plugin config (or an adapter-scoped config);
 *   host is the in-process DSH host from lib/index.js (optional in standalone).
 * @returns {{all: () => Promise<Array<any>>, get: (harness: string) => Promise<any>}}
 */
export function createAdapters({ config, logger, host } = {}) {
  const pluginConfig = config && typeof config === 'object' ? config : {}
  const deps = { config: pluginConfig, logger, host }
  /** @type {Record<string, any>} */
  const adapters = {
    dsh: createDshAdapter(deps),
    claude: createClaudeAdapter(deps),
    codex: createCodexAdapter(deps),
    'codex-desktop': createCodexDesktopAdapter(deps),
  }

  return {
    /** @returns {Promise<Array<any>>} one adapter per harness, canonical order */
    async all() {
      return HARNESSES.map((harness) => adapters[harness])
    },

    /**
     * Resolve one adapter by harness id.
     * @param {string} harness harness id
     * @returns {Promise<any>} the adapter
     * @throws {BridgeError} 'not-found' for an unknown harness
     */
    async get(harness) {
      if (typeof harness !== 'string' || !Object.hasOwn(adapters, harness)) {
        throw new BridgeError('not-found', 'unknown harness "' + String(harness) + '"', {
          harness,
          harnesses: [...HARNESSES],
        })
      }
      return adapters[harness]
    },
  }
}

export default createAdapters
