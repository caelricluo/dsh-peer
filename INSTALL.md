# INSTALL - dsh-peer

Copy-paste steps to install the DSH plugin, the `peer` CLI, and the
`cross-harness-peer` skill for Claude Code and Codex.

**Prerequisites**

- Node.js **>= 20** on `PATH` (`node --version`).
- DeepSeek Harness (Web or Desktop app) that boots the profile you use.
- Optional: `claude` and/or `codex` CLI, installed and logged in, if you want
  those directions. Check with `claude --version` / `codex --version`.
- This repository checked out, with `dsh-peer/` inside it.

All commands below assume you are in the `dsh-peer` directory:

```sh
cd path/to/repo/dsh-peer
```

## One-command install

`install.sh` does sections 1-3 below in one pass (CLI + both skills + the DSH
profile bundle) and verifies each result. Run it in a normal Terminal - the DSH
agent cannot run it for you because its file sandbox is workspace-only and the
profile install needs your package manager.

```sh
bash install.sh                    # profile "desktop" (override with --profile <name>)
bash install.sh --dry-run          # show every write first
bash install.sh --skip-plugin      # CLI + skills only
```

Then quit and reopen the DeepSeek Harness app, start Claude Code / Codex once,
and run `peer doctor`.

## 1. Add the plugin to your DSH profile

The plugin is installed into a DSH profile. Use the profile name you boot
(`web` in the examples; substitute `tui` or your own profile name).

```sh
dsh plugin --profile web add link:"$PWD"
```

This runs pnpm in the profile and registers the package. The package's
`cordis.patch.yml` mounts the bridge and the five peer tools when the profile
boots.

Notes:

- `link:"$PWD"` installs the working copy in place, which is what you want for
  development. For a registry install later, use the published package name.
- Do not run this against a profile you do not boot; nothing will start.

## 2. Restart DSH

Quit and reopen the DSH app (or restart the profile). At startup the plugin:

- starts the bridge on `127.0.0.1:45710` (or `port` from config);
- writes `~/.dsh-peer/bridge.json` (mode 0600);
- registers `peer_status`, `peer_ask`, `peer_send`, `peer_wait`,
  `peer_thread`.

Check the file exists without printing the token:

```sh
ls -l ~/.dsh-peer/bridge.json
node -e 'const j=require(require("node:path").join(require("node:os").homedir(),".dsh-peer/bridge.json")); console.log(j.url, j.packageVersion, j.harnesses.join(","))'
```

The bridge is up if that prints a loopback URL. The DSH log also contains
`dsh-peer: bridge listening at http://127.0.0.1:...`.

## 3. Install the CLI and the skill

Preview first (writes nothing):

```sh
node scripts/install-skill.mjs --dry-run
```

Then install:

```sh
node scripts/install-skill.mjs
```

Default destinations (`--home` can change the install root):

| What | Destination |
|---|---|
| `peer` launcher | `~/bin/peer` (mode 0755) |
| CLI modules | `~/lib/dsh-peer/bin/peer.mjs`, `~/lib/dsh-peer/lib/cli.js`, `~/lib/dsh-peer/lib/protocol.js` |
| Claude Code skill | `~/.claude/skills/cross-harness-peer/` |
| Codex skill | `~/.codex/skills/cross-harness-peer/` |

The launcher runs the byte-copied CLI with `node`. The CLI is kept under
`~/lib/dsh-peer/` so its relative `../lib/cli.js` import resolves; the skill
directory carries its own byte-identical copy (`scripts/peer.mjs` +
`lib/cli.js` + `lib/protocol.js`) and is self-contained.

A harness is selected automatically only when its skills parent directory
already exists (for example `~/.claude/skills`). Force one or both and create
missing parents with explicit flags:

```sh
node scripts/install-skill.mjs --claude            # Claude only, creates parent
node scripts/install-skill.mjs --codex --force     # Codex, creates parent
node scripts/install-skill.mjs --cli-only          # CLI only, no skill
node scripts/install-skill.mjs --skill-only        # skill only, no CLI
node scripts/install-skill.mjs --check             # verify bundled CLI copies
```

The installer never overwrites files that differ from the packaged copy unless
you pass `--force`; it prints every action and a summary. If it reports
conflicts, inspect the file (you may have edited the installed skill), then
either keep it or re-run with `--force`.

`--check` compares the bundled copies under
`skills/cross-harness-peer/{scripts,lib}/` with `bin/peer.mjs`, `lib/cli.js`
and `lib/protocol.js`; it exits 1 on drift and is meant for CI.

Make the CLI reachable:

```sh
export PATH="$HOME/bin:$PATH"
# persist it in your shell profile, e.g. ~/.zshrc:
# echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
```

## 4. Verify

```sh
command -v peer          # -> /Users/<you>/bin/peer
peer --help              # usage and commands
peer doctor              # discovery + token presence + adapters
peer status              # bridge health + adapters + live DSH sessions
peer status --json       # machine-readable; read adapters[].available
```

Expected: `peer doctor` finds the peer home and `bridge.json`, the token is
present, and `dsh` is available (it is the host itself). `claude` / `codex`
appear as `available:true` only if their CLIs are installed and runnable.

CLI exit codes: `0` ok, `1` usage/other, `2` bridge unreachable,
`3` unauthorized, `4` remote turn failed. `peer doctor` uses `0` healthy,
`2` bridge unreachable or unhealthy, and `3` missing or refused token, so
scripts can branch on it. The bridge exists only while the DSH app (or profile)
with the dsh-peer plugin is running; once DSH stops, bridge commands exit `2`
(or `3` if no token can be found).

End-to-end check (asks the DSH host a trivial question):

```sh
peer ask --to dsh "Reply with exactly: peer-ok"
```

Then check each external harness direction:

```sh
peer ask --to claude "Reply with exactly: claude-ok"
peer ask --to codex  "Reply with exactly: codex-ok"
```

These spawn a real CLI turn. Skip the ones you did not install; an unavailable
adapter returns `adapter-unavailable` (exit 4).

### Verify the skill in Claude Code

Start `claude` in any directory and ask:

> What is the cross-harness-peer skill for, and what command checks the bridge?

The skill should appear in the agent's skill list and the answer should mention
`peer doctor` / `peer status` and the loopback bridge.

### Verify the skill in Codex

Start `codex` and ask the same question, or run a one-shot:

```sh
codex exec "Use the cross-harness-peer skill to run peer doctor and summarize the result."
```

If a harness's sandbox blocks loopback networking, run the CLI in a
network-enabled/approval mode; the bridge itself is local-only.

## Configuration (optional)

The plugin is configured in your DSH profile. Common overrides:

```yaml
- id: dsh-peer
  name: '@caelricluo/dsh-peer'
  config:
    port: 0                 # OS-assigned port; CLI rediscovers from bridge.json
    peerHome: /custom/home  # default $DSH_PEER_HOME || ~/.dsh-peer
    turnTimeoutMs: 1200000  # 20 minutes
    adapters:
      claude: { command: /opt/homebrew/bin/claude, defaultEffort: high }
      codex:  { command: codex }
```

Environment variables understood by the CLI:

| Variable | Meaning |
|---|---|
| `DSH_PEER_HOME` | peer home (both plugin and CLI); default `~/.dsh-peer` |
| `PEER_BRIDGE_URL` | override the bridge URL |
| `PEER_BRIDGE_TOKEN` | override the bearer token (avoid in shells you share) |

Discovery order: URL `--url` > `PEER_BRIDGE_URL` > `bridge.json` > default;
token `--token` > `PEER_BRIDGE_TOKEN` > `bridge.json`. No token exits 3.

## Uninstall

Remove the skill and CLI:

```sh
rm -rf ~/.claude/skills/cross-harness-peer
rm -rf ~/.codex/skills/cross-harness-peer
rm -f  ~/bin/peer
rm -rf ~/lib/dsh-peer
```

Remove the plugin from the profile (then restart DSH):

```sh
dsh plugin --profile web remove @caelricluo/dsh-peer
```

Remove local state (threads, discovery file, token):

```sh
rm -rf ~/.dsh-peer
```

`rm -rf` is destructive; check the paths above before running it, and use
`trash` instead of `rm -rf` if you want to keep a copy.

## Troubleshooting

- **`dsh: command not found`** - install/open DeepSeek Harness first; the `dsh`
  launcher is part of the app.
- **`dsh plugin ... add` fails** - check the spec path: `"$PWD"` must be the
  `dsh-peer` package directory (contains `package.json` with
  `name: "@caelricluo/dsh-peer"`).
- **`bridge.json` never appears** - plugin not enabled/mounted in the booted
  profile, or DSH did not restart. Check the profile's plugin list and logs.
- **exit 3 `unauthorized`** - stale `PEER_BRIDGE_TOKEN` in the shell, or a
  `bridge.json` from a dead process. Unset the env var and restart DSH.
- **exit 2 `bridge unreachable`** - DSH is not running, or the plugin bound a
  different port. Run `peer doctor`.
- **Skill not picked up** - confirm the directory name and frontmatter:
  `~/.claude/skills/cross-harness-peer/SKILL.md` with `name:
  cross-harness-peer`. Restart the harness; it reads skills at startup.
- **`peer` fails with `ERR_MODULE_NOT_FOUND`** - the CLI bundle under
  `~/lib/dsh-peer/` is incomplete or was moved. Re-run
  `node scripts/install-skill.mjs` (or `--force` if it reports conflicts).
- **`--check` exits 1 after pulling the repo** - the committed copies in
  `skills/cross-harness-peer/` are stale. Refresh them from `bin/peer.mjs`,
  `lib/cli.js`, and `lib/protocol.js` as byte copies.
- **Bridge port already in use** - the plugin logs a warning and falls back to
  an OS-assigned port instead of failing. `~/.dsh-peer/bridge.json` always
  records the real URL, so `peer` follows automatically; no manual port change
  is needed. If you run two DSH surfaces at once (Desktop + Web) and need to
  address both, give each its own `DSH_PEER_HOME`: the discovery file is per
  peer home and points at the most recently started bridge, so a shared peer
  home would hide the older one.

More: [README.md](README.md), [docs/SECURITY.md](docs/SECURITY.md), and the
skill's own references under
`skills/cross-harness-peer/references/`.
