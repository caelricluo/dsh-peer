# Harness notes: Claude Code vs. OpenAI Codex

One `SKILL.md` serves both. The installer writes the same directory to both
locations; only the parent directory differs.

## Install locations (user level)

| Harness | Skill path |
|---|---|
| Claude Code | `~/.claude/skills/cross-harness-peer/` |
| OpenAI Codex | `~/.codex/skills/cross-harness-peer/` |

Claude Code also supports project-level skills under `.claude/skills/`; this
installer only manages the user-level location. If a project already has its own
skills directory, copy the skill there yourself or ask the user which location to
use.

The skill directory is self-contained:

```
cross-harness-peer/
  SKILL.md
  references/protocol.md
  references/examples.md
  references/harness-notes.md
  scripts/peer.mjs          # byte copy of dsh-peer bin/peer.mjs
  lib/cli.js                # byte copy of dsh-peer lib/cli.js (import target)
  lib/protocol.js           # byte copy of dsh-peer lib/protocol.js
```

The bundled `scripts/peer.mjs` imports `../lib/cli.js`, which imports
`./protocol.js`; keeping those three files in this exact relative layout makes
the skill runnable with plain `node` and no build step. `node
scripts/install-skill.mjs --check` (from the dsh-peer package) fails if they
drift.

## How each harness finds the skill

Both harnesses discover skills by name + description in the `SKILL.md` YAML
frontmatter. The `description` is the trigger text: it is loaded into the model's
context so the agent can decide when to invoke the skill. Keep it accurate when
you fork this skill, and mention the harness names (`Claude Code`, `Codex`,
`DSH`, `DeepSeek Harness`) plus the user-facing verbs (`ask`, `consult`,
`delegate`, `peer`).

Frontmatter stays minimal (`name`, `description`) so it parses under both
harnesses' loaders; do not add harness-specific fields that the other side may
reject. `name` must match the directory name: `cross-harness-peer`.

## Running the CLI from inside a harness

- Both harnesses call shell commands through their own tool layer, so `peer`
  must be on `PATH`. The installer puts it at `~/bin/peer`; add
  `export PATH="$HOME/bin:$PATH"` to your shell profile if it is not there.
- A harness may ask for permission before running `peer`. That prompt is the
  harness's, not the bridge's. Do not try to bypass it.
- Some harness sandboxes restrict network syscalls; `127.0.0.1` is still a
  network connection. If `peer` cannot reach the bridge from inside a sandbox,
  the user must run the command in a network-enabled/approval mode. This is
  harness policy: the bridge itself never leaves loopback.
- Codex may run with a read-only or workspace-write sandbox. Reading
  `bridge.json` requires read access to `$PEER_HOME` (`~/.dsh-peer` by default).
- Do not hardcode a machine-specific path to `peer` in prompts; `command -v
  peer` is the portable check.

## Practical differences

- **Naming**: users say "Claude" / "Claude Code" and "Codex" / "OpenAI Codex".
  The bridge harness ids are exactly `claude`, `codex` (the Codex CLI) and
  `codex-desktop` (Codex Desktop's app-server protocol).
- **Codex vs Codex Desktop**: `codex` spawns one `codex exec` per turn;
  `codex-desktop` starts `codex app-server` and speaks JSON-RPC, so it shares the
  desktop app's durable thread store. Use `codex-desktop` when the user refers to
  their Codex Desktop conversation; its thread ids are app-server UUIDs that the
  desktop app also lists.
- **Models**: model identifiers are harness-specific and can change. Always
  read `peer status --json` -> `adapters[].models` instead of assuming.
- **Reasoning effort**: supported values differ per adapter; the bridge reports
  them in `adapters[].reasoningEfforts`, and not every harness maps all five
  levels. Check before passing `--effort`.
- **Context support**: `adapters[].context` is a capability map. If
  `files:false` or `systemPrompt:false` for a harness, do not rely on
  `--file`/`--system` for it.
- **Skill invocation**: one harness may auto-invoke the skill from its
  description while the other may require the user to name it (`use the
  cross-harness-peer skill`). The skill body should therefore work when read
  literally as instructions, not as a menu.
