#!/usr/bin/env node
/**
 * peer — executable entry point for the dsh-peer cross-harness bridge CLI.
 *
 * Thin wrapper: all behavior lives in lib/cli.js so it can be imported and
 * tested without spawning a process. Never imports DSH or npm packages.
 */

import { runCli } from '../lib/cli.js'

try {
  process.exitCode = await runCli(process.argv.slice(2))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write('peer: ' + message + '\n')
  process.exitCode = 1
}
