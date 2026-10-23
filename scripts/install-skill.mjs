#!/usr/bin/env node
/**
 * install-skill.mjs - install the cross-harness-peer skill and the peer CLI.
 *
 * Zero dependencies, Node >= 20, ESM. Run with plain `node`, no npm install:
 *
 *   node scripts/install-skill.mjs --dry-run
 *   node scripts/install-skill.mjs
 *   node scripts/install-skill.mjs --home /tmp/peer-home --claude --codex --force
 *   node scripts/install-skill.mjs --check     # CI: bundled copies vs package
 *
 * What it does:
 *   1. installs the CLI under <home>/lib/dsh-peer/ as byte copies of
 *      bin/peer.mjs, lib/cli.js and lib/protocol.js (so the wrapper's relative
 *      import '../lib/cli.js' keeps working), and writes a tiny launcher at
 *      <home>/bin/peer;
 *   2. copies skills/cross-harness-peer/ (SKILL.md, references/, and the
 *      byte-identical bundled CLI + its lib/) to
 *      <home>/.claude/skills/cross-harness-peer/ and/or
 *      <home>/.codex/skills/cross-harness-peer/.
 *
 * <home> defaults to the OS home directory, so `--home` is both the install
 * root and a safe sandbox for testing. A harness is selected automatically only
 * when its skills parent already exists; an explicit --claude/--codex or
 * --force creates it. Existing files are never overwritten unless their content
 * is identical or --force is given.
 *
 * Exit codes: 0 success (or dry run), 1 usage/IO error or unresolved conflicts.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..')
const SKILL_NAME = 'cross-harness-peer'

/** Files installed for the CLI; relative to the package root and to <home>. */
const CLI_FILES = [
  { pkg: join('bin', 'peer.mjs'), dest: join('lib', 'dsh-peer', 'bin', 'peer.mjs'), mode: 0o755 },
  { pkg: join('lib', 'cli.js'), dest: join('lib', 'dsh-peer', 'lib', 'cli.js'), mode: 0o644 },
  { pkg: join('lib', 'protocol.js'), dest: join('lib', 'dsh-peer', 'lib', 'protocol.js'), mode: 0o644 },
]

/** Bundled-copy pairs checked by --check: [skill-relative, package-relative]. */
const BUNDLED_COPIES = [
  [join('skills', SKILL_NAME, 'scripts', 'peer.mjs'), join('bin', 'peer.mjs')],
  [join('skills', SKILL_NAME, 'lib', 'cli.js'), join('lib', 'cli.js')],
  [join('skills', SKILL_NAME, 'lib', 'protocol.js'), join('lib', 'protocol.js')],
]

/** Files the skill must contain; the bundled CLI needs both lib modules. */
const SKILL_REQUIRED = [
  'SKILL.md',
  join('scripts', 'peer.mjs'),
  join('lib', 'cli.js'),
  join('lib', 'protocol.js'),
  join('lib', 'package.json'),
]

const USAGE = `${SKILL_NAME} installer

Usage:
  node scripts/install-skill.mjs [options]

Options:
  --dry-run        show what would change; write nothing
  --force          overwrite modified files and create missing skill parents
  --home <dir>     install root (default: your home directory)
  --claude         install only the Claude Code skill
  --codex          install only the Codex skill
  --cli-only       install the peer CLI only; leave skills untouched
  --skill-only     install the skill only; leave the CLI untouched
  --check          verify the skill's bundled CLI copies match bin/ and lib/;
                   exit 1 on drift (CI-friendly; writes nothing)
  -h, --help       show this help

Layout:
  <home>/bin/peer                                   launcher (0755)
  <home>/lib/dsh-peer/bin/peer.mjs                  byte copy of bin/peer.mjs
  <home>/lib/dsh-peer/lib/cli.js                    byte copy of lib/cli.js
  <home>/lib/dsh-peer/lib/protocol.js               byte copy of lib/protocol.js
  <home>/.claude/skills/${SKILL_NAME}/
  <home>/.codex/skills/${SKILL_NAME}/

The skill directory is self-contained: scripts/peer.mjs resolves ../lib/cli.js
inside the skill. A harness is installed automatically when its skills parent
directory exists. Pass --claude / --codex to force one harness, or --force to
create parents. Existing files are only written when identical or --force is
given.
`

/** @param {string} message */
function fail(message) {
  process.stderr.write(`install-skill: ${message}\n`)
  process.exit(1)
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{dryRun:boolean, force:boolean, home:string|null, claude:boolean, codex:boolean, cliOnly:boolean, skillOnly:boolean, check:boolean, help:boolean}} */
  const opts = {
    dryRun: false,
    force: false,
    home: null,
    claude: false,
    codex: false,
    cliOnly: false,
    skillOnly: false,
    check: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--force' || arg === '-f') opts.force = true
    else if (arg === '--claude') opts.claude = true
    else if (arg === '--codex') opts.codex = true
    else if (arg === '--cli-only') opts.cliOnly = true
    else if (arg === '--skill-only') opts.skillOnly = true
    else if (arg === '--check') opts.check = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--home') {
      const value = argv[i + 1]
      if (!value) fail('--home requires a directory')
      opts.home = value
      i += 1
    } else if (arg.startsWith('--home=')) {
      const value = arg.slice('--home='.length)
      if (!value) fail('--home requires a directory')
      opts.home = value
    } else {
      fail(`unknown argument: ${arg}\n\n${USAGE}`)
    }
  }
  if (opts.cliOnly && opts.skillOnly) fail('--cli-only and --skill-only are mutually exclusive')
  return opts
}

/** Expand a leading ~ (the shell normally does this; --home may be quoted). */
function expandHome(input) {
  const value = String(input)
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~' + sep)) {
    return join(homedir(), value.slice(2))
  }
  return value
}

/** @param {string} p */
function isFile(p) {
  try {
    return lstatSync(p).isFile()
  } catch {
    return false
  }
}

/** @param {string} p */
function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** @param {string} p */
function lstatOrNull(p) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** Recursively list regular files as paths relative to root. */
function walkFiles(root) {
  /** @type {string[]} */
  const out = []
  /** @param {string} dir @param {string} rel */
  const walk = (dir, rel) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue
      const childRel = rel ? join(rel, entry.name) : entry.name
      const childAbs = join(dir, entry.name)
      if (entry.isDirectory()) walk(childAbs, childRel)
      else if (entry.isFile()) out.push(childRel)
      else {
        process.stderr.write(`install-skill: skipping non-regular file ${childAbs}\n`)
      }
    }
  }
  walk(root, '')
  return out
}

/**
 * Decide what to do with one byte-for-byte file copy.
 * @param {string} src
 * @param {string} dest
 * @param {boolean} force
 * @param {number} mode target mode for the installed file
 */
function planFile(src, dest, force, mode) {
  const destStat = lstatOrNull(dest)
  if (!destStat) return { kind: 'write', src, dest, mode, reason: 'new' }
  if (!destStat.isFile()) {
    return { kind: 'conflict', dest, reason: 'destination is not a regular file' }
  }
  if (readFileSync(src).equals(readFileSync(dest))) {
    if ((destStat.mode & 0o777) !== mode) return { kind: 'chmod', dest, mode, reason: 'mode' }
    return { kind: 'skip', dest, reason: 'up to date' }
  }
  if (force) return { kind: 'write', src, dest, mode, reason: 'forced overwrite' }
  return { kind: 'conflict', dest, reason: 'modified locally; use --force' }
}

/**
 * Decide what to do with one generated (non-copied) file, such as the launcher.
 * @param {string} dest
 * @param {string} content generated contents
 * @param {boolean} force
 * @param {number} mode target mode
 */
function planGeneratedFile(dest, content, force, mode) {
  const destStat = lstatOrNull(dest)
  if (!destStat) return { kind: 'write', dest, content, mode, reason: 'new' }
  if (!destStat.isFile()) {
    return { kind: 'conflict', dest, reason: 'destination is not a regular file' }
  }
  if (readFileSync(dest, 'utf8') === content) {
    if ((destStat.mode & 0o777) !== mode) return { kind: 'chmod', dest, mode, reason: 'mode' }
    return { kind: 'skip', dest, reason: 'up to date' }
  }
  if (force) return { kind: 'write', dest, content, mode, reason: 'forced overwrite' }
  return { kind: 'conflict', dest, reason: 'modified locally; use --force' }
}

/**
 * Plan one directory copy. If any file conflicts, no file in this directory
 * target is written (no half-upgraded skill); pass --force to overwrite.
 */
function planCopyDir(srcDir, destDir, force) {
  /** @type {any[]} */
  const actions = []
  if (existsSync(destDir) && !isDir(destDir)) {
    actions.push({ kind: 'conflict', dest: destDir, reason: 'destination is not a directory' })
    return actions
  }
  const files = walkFiles(srcDir)
  let conflicts = false
  for (const rel of files) {
    const mode = rel.endsWith('.mjs') ? 0o755 : 0o644
    const action = planFile(join(srcDir, rel), join(destDir, rel), force, mode)
    if (action.kind === 'conflict') conflicts = true
    actions.push(action)
  }
  if (conflicts) {
    return actions.map((action) =>
      action.kind === 'write' || action.kind === 'chmod' || action.kind === 'skip'
        ? { ...action, kind: 'blocked-by-conflict' }
        : action,
    )
  }
  return withMissingDirs(actions, [destDir])
}

/**
 * Prepend mkdir actions (deepest last, dirs are created recursively) for the
 * parents of planned files, without duplicates.
 * @param {any[]} actions planned file actions
 * @param {string[]} wantedDirs directories that must exist for these files
 */
function withMissingDirs(actions, wantedDirs) {
  /** @type {string[]} */
  const dirs = []
  const seen = new Set()
  for (const dir of wantedDirs) {
    let current = dir
    /** @type {string[]} */
    const chain = []
    while (!isDir(current) && !seen.has(current)) {
      chain.push(current)
      seen.add(current)
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    dirs.push(...chain.reverse())
  }
  dirs.sort((a, b) => a.split(sep).length - b.split(sep).length)
  return [...dirs.map((dir) => ({ kind: 'mkdir', dest: dir })), ...actions]
}

/** Shell-quote one absolute path for the generated #!/bin/sh launcher. */
function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'"
}

/** Render the launcher that runs the bundled CLI with plain node. */
function launcherContent(peerModule) {
  return (
    '#!/bin/sh\n' +
    '# Generated by dsh-peer install-skill.mjs; runs the bundled CLI with node.\n' +
    'exec node ' + shellQuote(peerModule) + ' "$@"\n'
  )
}

/** @param {string} p @returns {string} */
function makeDisplay(home) {
  return (p) => {
    const rel = relative(home, p)
    if (rel === '') return '~'
    if (!rel.startsWith('..') && !isAbsolute(rel)) return '~/' + rel.split(sep).join('/')
    return p
  }
}

/** @param {string} kind @param {string} path */
function label(kind, path) {
  const prefix =
    kind === 'write' ? (existsSync(path) ? 'overwrite' : 'create')
    : kind === 'mkdir' ? 'mkdir'
    : kind === 'chmod' ? 'chmod'
    : kind === 'skip' ? 'up to date'
    : kind === 'blocked-by-conflict' ? 'blocked'
    : kind
  return prefix
}

/**
 * Compare the skill's bundled CLI copies with the package sources.
 * @returns {{ok:boolean, lines:string[], drift:string[]}} check result
 */
function inspectBundledCopies() {
  const lines = []
  /** @type {string[]} */
  const drift = []
  for (const [bundledRel, pkgRel] of BUNDLED_COPIES) {
    const bundled = join(PACKAGE_ROOT, bundledRel)
    const pkg = join(PACKAGE_ROOT, pkgRel)
    const shown = bundledRel.split(sep).join('/')
    if (!isFile(bundled)) {
      lines.push('  missing  ' + shown + '  (expected byte copy of ' + pkgRel + ')')
      drift.push(shown)
      continue
    }
    if (!isFile(pkg)) {
      lines.push('  missing  ' + pkgRel + '  (package source needed by ' + shown + ')')
      drift.push(shown)
      continue
    }
    if (readFileSync(bundled).equals(readFileSync(pkg))) {
      lines.push('  ok       ' + shown + '  == ' + pkgRel)
    } else {
      lines.push('  DRIFT    ' + shown + '  != ' + pkgRel)
      drift.push(shown)
    }
  }
  return { ok: drift.length === 0, lines, drift }
}

/**
 * Check mode: fail when the skill bundle has drifted from bin/ and lib/.
 * @returns {number} exit code
 */
function runCheck() {
  const result = inspectBundledCopies()
  const out = ['cross-harness-peer bundled CLI check']
  out.push(...result.lines)
  out.push('')
  out.push(
    result.ok
      ? 'OK: bundled CLI copies match the package.'
      : 'DRIFT: update skills/' + SKILL_NAME + '/ with byte copies of bin/peer.mjs, lib/cli.js and lib/protocol.js.',
  )
  process.stdout.write(out.join('\n') + '\n')
  return result.ok ? 0 : 1
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(USAGE)
    return
  }
  if (opts.check) {
    process.exitCode = runCheck()
    return
  }

  const home = resolve(expandHome(opts.home ?? homedir()))
  const wantCli = !opts.skillOnly
  const wantSkill = !opts.cliOnly

  const cliSources = CLI_FILES.map((item) => join(PACKAGE_ROOT, item.pkg))
  const peerSource = cliSources[0]
  const skillSource = join(PACKAGE_ROOT, 'skills', SKILL_NAME)
  if (wantCli) {
    for (const item of CLI_FILES) {
      if (!isFile(join(PACKAGE_ROOT, item.pkg))) {
        fail(`CLI file not found: ${join(PACKAGE_ROOT, item.pkg)}. Install the package first.`)
      }
    }
  }
  if (wantSkill) {
    if (!isDir(skillSource)) fail(`skill directory not found: ${skillSource}`)
    for (const rel of SKILL_REQUIRED) {
      if (!isFile(join(skillSource, rel))) {
        fail(`skill bundle is incomplete: missing skills/${SKILL_NAME}/${rel}`)
      }
    }
    const bundled = inspectBundledCopies()
    if (!bundled.ok) {
      process.stderr.write(
        'install-skill: warning: the skill bundle differs from bin/ and lib/; run --check for details\n',
      )
    }
  }

  // Which harnesses to target. Explicit flags win; otherwise auto-detect.
  const explicitClaude = opts.claude
  const explicitCodex = opts.codex
  const anyExplicit = explicitClaude || explicitCodex
  /** @type {{name:string, skillRoot:string, selected:boolean, reason:string}[]} */
  const harnesses = [
    { name: 'claude', skillRoot: join(home, '.claude', 'skills'), selected: false, reason: '' },
    { name: 'codex', skillRoot: join(home, '.codex', 'skills'), selected: false, reason: '' },
  ]
  if (!wantSkill) {
    for (const harness of harnesses) harness.reason = 'skipped (--cli-only)'
  } else {
    for (const harness of harnesses) {
      const explicit = harness.name === 'claude' ? explicitClaude : explicitCodex
      const parentExists = isDir(harness.skillRoot)
      if (anyExplicit && !explicit) {
        harness.reason = 'not selected'
        continue
      }
      if (explicit || parentExists) {
        harness.selected = true
        harness.reason = parentExists ? 'parent exists' : 'explicit/forced'
      } else if (opts.force) {
        harness.selected = true
        harness.reason = '--force creates parent'
      } else {
        harness.reason = `skipped (no ${harness.skillRoot}; use --${harness.name} or --force)`
      }
    }
  }

  // Plan the CLI: bundled modules under lib/dsh-peer/ plus a generated launcher.
  // All-or-nothing: a CLI without its lib modules cannot run.
  /** @type {any[]} */
  let cliActions = []
  if (wantCli) {
    const peerModule = join(home, CLI_FILES[0].dest)
    for (const item of CLI_FILES) {
      const dest = join(home, item.dest)
      const parent = dirname(dest)
      if (existsSync(parent) && !isDir(parent)) {
        cliActions.push({ kind: 'conflict', dest, reason: 'parent is not a directory' })
        continue
      }
      cliActions.push(planFile(join(PACKAGE_ROOT, item.pkg), dest, opts.force, item.mode))
    }
    // Mark the bundle directory as ESM: without this, node reparses every
    // .js file as CommonJS first and prints MODULE_TYPELESS_PACKAGE_JSON.
    cliActions.push(
      planGeneratedFile(
        join(home, 'lib', 'dsh-peer', 'package.json'),
        JSON.stringify({ name: 'dsh-peer-cli', private: true, type: 'module' }, null, 2) + '\n',
        opts.force,
        0o644,
      ),
    )
    const launcherDest = join(home, 'bin', 'peer')
    const launcherParent = dirname(launcherDest)
    if (existsSync(launcherParent) && !isDir(launcherParent)) {
      cliActions.push({ kind: 'conflict', dest: launcherDest, reason: 'parent is not a directory' })
    } else {
      cliActions.push(planGeneratedFile(launcherDest, launcherContent(peerModule), opts.force, 0o755))
    }
    const cliConflict = cliActions.some((action) => action.kind === 'conflict')
    if (cliConflict) {
      cliActions = cliActions.map((action) =>
        action.kind === 'write' || action.kind === 'chmod' || action.kind === 'skip'
          ? { ...action, kind: 'blocked-by-conflict' }
          : action,
      )
    } else {
      cliActions = withMissingDirs(
        cliActions,
        cliActions.filter((action) => action.dest !== undefined).map((action) => dirname(action.dest)),
      )
    }
  }
  const cliConflict = cliActions.some((action) => action.kind === 'conflict')

  /** @type {Map<string, any[]>} */
  const skillPlans = new Map()
  for (const harness of harnesses) {
    if (!harness.selected) continue
    const destDir = join(harness.skillRoot, SKILL_NAME)
    skillPlans.set(harness.name, planCopyDir(skillSource, destDir, opts.force))
  }

  // Report.
  const show = makeDisplay(home)
  const out = []
  const summary = { write: 0, chmod: 0, skip: 0, conflict: 0, mkdir: 0 }
  const count = (action) => {
    if (action.kind === 'write') summary.write += 1
    else if (action.kind === 'chmod') summary.chmod += 1
    else if (action.kind === 'skip') summary.skip += 1
    else if (action.kind === 'conflict') summary.conflict += 1
    else if (action.kind === 'mkdir') summary.mkdir += 1
  }

  out.push(`${SKILL_NAME} installer${opts.dryRun ? ' (dry run, nothing written)' : ''}`)
  out.push(`${'home'.padEnd(12)} ${show(home)}`)
  if (wantCli) out.push(`${'cli source'.padEnd(12)} ${show(peerSource)}`)
  out.push(`${'skill source'.padEnd(12)} ${show(skillSource)}`)
  out.push('')
  out.push('peer CLI')
  if (!wantCli) {
    out.push('  skipped (--skill-only)')
  } else {
    for (const action of cliActions) {
      count(action)
      const suffix = action.kind === 'conflict' ? `  [${action.reason}]` : ''
      const modeText =
        action.kind === 'write' || action.kind === 'chmod' ? `  (0${action.mode.toString(8)})` : ''
      out.push(`  ${label(action.kind, action.dest).padEnd(12)} ${show(action.dest)}${modeText}${suffix}`)
    }
  }
  out.push('')
  out.push('Skills')
  if (!wantSkill) {
    out.push('  skipped (--cli-only)')
  } else {
    for (const harness of harnesses) {
      const plans = skillPlans.get(harness.name)
      if (!plans) {
        out.push(`  ${harness.name.padEnd(8)} ${harness.reason}`)
        continue
      }
      out.push(`  ${harness.name.padEnd(8)} -> ${show(join(harness.skillRoot, SKILL_NAME))}`)
      for (const action of plans) {
        count(action)
        const suffix = action.kind === 'conflict' ? `  [${action.reason}]` : ''
        out.push(`    ${label(action.kind, action.dest).padEnd(12)} ${show(action.dest)}${suffix}`)
      }
    }
  }
  out.push('')
  out.push(
    `Summary: ${summary.write} to write, ${summary.chmod} chmod, ${summary.skip} up to date, ` +
      `${summary.conflict} conflict(s), ${summary.mkdir} dir(s).`,
  )

  const conflicts =
    cliConflict ||
    [...skillPlans.values()].some((plans) => plans.some((action) => action.kind === 'conflict'))
  if (conflicts) {
    out.push('')
    out.push('Some files differ from the installed copy. Re-run with --force to overwrite them.')
  } else if (!opts.dryRun) {
    out.push('')
    out.push('Next steps:')
    if (wantCli) out.push('  1. Add ~/bin to PATH if it is not already: export PATH="$HOME/bin:$PATH"')
    if (wantSkill) {
      out.push(`  ${wantCli ? '2' : '1'}. Restart Claude Code / Codex, then run: peer doctor`)
    } else {
      out.push('  Run: peer doctor')
    }
  }

  process.stdout.write(out.join('\n') + '\n')
  if (!opts.dryRun) execPlans(cliActions, skillPlans)
  if (opts.dryRun || conflicts) {
    if (conflicts) process.exitCode = 1
    return
  }
}

/**
 * Apply planned actions. Conflicts and blocked actions were filtered by the
 * planner, so this only creates directories, writes files and fixes modes.
 * @param {any[]} cliActions
 * @param {Map<string, any[]>} skillPlans
 */
function execPlans(cliActions, skillPlans) {
  const apply = (action, defaultMode) => {
    if (action.kind === 'mkdir') mkdirSync(action.dest, { recursive: true })
    else if (action.kind === 'write') {
      mkdirSync(dirname(action.dest), { recursive: true })
      if (typeof action.content === 'string') writeFileSync(action.dest, action.content)
      else writeFileSync(action.dest, readFileSync(action.src))
      chmodSync(action.dest, action.mode ?? defaultMode)
    } else if (action.kind === 'chmod') chmodSync(action.dest, action.mode ?? defaultMode)
  }
  for (const action of cliActions) apply(action, 0o755)
  for (const plans of skillPlans.values()) {
    for (const action of plans) apply(action, 0o644)
  }
}

try {
  main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
