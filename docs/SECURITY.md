# Security model - dsh-peer

Scope: the v1 cross-harness bridge in this repository. Read
[CONTRACT.md](../CONTRACT.md) for the wire protocol and
[README.md](../README.md) for the architecture.

## Summary

dsh-peer lets a **guest agent** (Claude Code, Codex, or another process using
the `peer` CLI) send a prompt to a **DSH agent** and read its answer. The
bridge is loopback-only and token-authenticated, and guest prompts run as
ordinary user-role prompts in the DSH agent. That means:

- The boundary is **"same local user"**. The token protects against other
  users, remote machines, and casual web-page requests - not against malicious
  processes running as you.
- A guest turn gets the **same tool authority as the DSH agent it reaches**.
  There is no approval bridging in v1: the guest does not see your approval
  prompts and cannot be granted narrower permissions than the target agent.
- Peer output is **untrusted data** on both sides. Treat it like content fetched
  from the web.

If those properties are not acceptable for a task, do not enable the plugin (or
do not add the guest), instead of relying on the bridge as a sandbox.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Bearer token | `$PEER_HOME/bridge.json` (mode 0600) | Full API access while the bridge runs |
| Thread transcripts | `$PEER_HOME/threads/*.jsonl` | Contain everything sent to/from peers |
| DSH agent authority | the running DSH host | Tools, files, shell, whatever the agent can do |
| External harness credentials | `claude` / `codex` own config | Pulled by those CLIs, never by dsh-peer |

`PEER_HOME` is `$DSH_PEER_HOME` or `~/.dsh-peer`. The plugin creates it with
mode `0700` and writes `bridge.json` with mode `0600` (best effort on
filesystems without POSIX modes).

## Trust boundaries

1. **Remote network -> bridge: denied.** The server binds `127.0.0.1` only;
   the plugin rejects any other configured host. HTTP is plaintext, but traffic
   never leaves the loopback interface.
2. **Other local users -> bridge: denied by filesystem permissions + token.**
   `bridge.json` is user-only. A different OS user cannot read the token
   (assuming normal home-directory permissions).
3. **Same-user local processes -> bridge: allowed.** Any process running as you
   can read `bridge.json` and call the API. Sandboxing guests from each other
   is not a v1 feature. Do not run the bridge on a shared account, and do not
   hand the token to an agent you would not let use your DSH tools.
4. **Guest prompt -> DSH agent: user-role input.** The bridge composes the
   message (optional system/append text, context files, and the prompt prefixed
   `[dsh-peer]`) and delivers it as a user message to a fresh in-process agent
   by default, or into a live session when `--session`/`to.session_id` is
   used.
5. **Peer reply -> your agent: untrusted content.** A Claude Code/Codex reply
   can contain prompt injection aimed at the DSH agent, and a DSH reply can
   contain injection aimed at the guest. Neither side should execute
   instructions from a reply without independent verification and, for
   consequential actions, user confirmation.
6. **External harness policy is inherited, not bridged.** A Claude Code or Codex
   child process uses that CLI's own settings: on this machine Codex runs with
   `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` from
   `~/.codex/config.toml`, so a peer prompt can make Codex act with full user
   authority without an approval prompt. The bridge adds no approval layer of
   its own (v1 limitation). Tighten the CLI's own config, or only ask peers
   questions that do not require tool use, when that authority is not intended.

## Token lifecycle

- Format: 32 random bytes hex-encoded (64 hex chars), generated with
  `crypto.randomBytes`.
- Persistence: the plugin reuses the token already in `bridge.json` across
  restarts unless `config.token` is set; otherwise it generates a new one.
- The CLI reads the token on every invocation (flag > `PEER_BRIDGE_TOKEN` >
  `bridge.json`), so rotating the file is enough once the process restarts.
- **Never** commit, paste, or log the token. It is a bearer credential: anyone
  who has it can use the API while the bridge runs.

### Rotate the token

```sh
# 1. Stop the bridge: quit the DSH app, or disable the plugin (enabled: false)
rm ~/.dsh-peer/bridge.json
# 2. Start DSH again; the plugin generates a fresh token and rewrites bridge.json
peer doctor          # confirm a token is found and the bridge answers
```

If the token was exposed (screen share, log, chat), also:

- unset/refresh `PEER_BRIDGE_TOKEN` in any shell or CI environment that had it;
- inspect `~/.dsh-peer/threads/*.jsonl` for messages you did not expect;
- inspect the DSH session history for turns you did not start;
- check the DSH logs for unexpected `dsh-peer` calls.

Setting an explicit `config.token` is supported but discouraged: it tends to
end up in profile files and dotfiles. If you must, keep that profile file
owner-only.

### Revoke access

- **Pause:** set `enabled: false` in the plugin config (or quit DSH). No bridge,
  no guest turns. `bridge.json` may remain; the plugin removes it on clean
  shutdown when it still describes this bridge.
- **Permanent:** disable the plugin and `rm -rf ~/.dsh-peer` (threads + token),
  and remove the skill from `~/.claude/skills` / `~/.codex/skills` plus
  `~/bin/peer`.
- A closed bridge cannot read old threads, but the transcripts remain on disk
  until you delete the peer home.

## Prompt injection and data handling

- Treat all peer text as untrusted: it may include instructions, fake tool
  results, or requests to reveal secrets. Do not forward secrets, credentials,
  private keys, or `.env` contents to a peer unless the user explicitly asked.
- Context files are prepended to the prompt by the DSH host and passed as paths
  or flags to external CLIs. Only pass files the peer is allowed to read; the
  peer may read more from the same filesystem with its own tools.
- `--system` replaces the peer's system prompt and `--session` steers a live
  user session. Both are user-authorized actions, not routine conveniences;
  prefer `--append-system` and fresh threads.
- Transcripts are plaintext JSONL in `$PEER_HOME/threads/`. Do not send
  secrets through the bridge; they will be stored there.
- Avoid recursive peer loops (A asks B asks A). They amplify prompt injection
  and cost. The bridge does not rate-limit or detect loops in v1.

## Command execution

- External harness CLIs are spawned with `shell:false`, with the prompt passed
  on stdin or as an argv element - never interpolated into a shell command.
- Prompt content is data, not shell syntax. Still, a peer CLI with tools can run
  commands itself, as your user, under its own permission model.
- Spawned CLIs run as your user and inherit the environment of the DSH process.
  Do not put long-lived secrets in that environment if you do not want child
  harnesses to see them.
- The bridge never downloads or installs anything and has zero npm
  dependencies.

## Network exposure

- `127.0.0.1` only, HTTP, no TLS. Traffic on loopback can be observed by root
  or processes with packet-capture privileges; that is out of scope.
- Do not reverse-proxy, port-forward, or bind a LAN address. The plugin rejects
  non-loopback `host` values on purpose.
- Browser pages cannot read `bridge.json`. Requests without the bearer token
  are rejected with `401 unauthorized`. The token is not stored in browser
  storage by this project.

## What v1 does not protect

- No per-guest identity, scopes, or rate limits. Every guest with the token can
  do anything the API allows.
- No approval prompt bridging, so a guest can trigger an agent turn while you
  are away from the keyboard.
- No encryption at rest for transcripts or tokens.
- No protection against a compromised `claude`/`codex` binary, a malicious
  DSH plugin, or malware running as your user.
- No audit trail beyond the thread transcripts and ordinary DSH logs.

## Hardening checklist

```sh
chmod 700 ~/.dsh-peer
chmod 600 ~/.dsh-peer/bridge.json
```

- Keep the default `enabled: true` only while you need cross-harness work; use
  `enabled: false` for long idle periods.
- Install the skill and CLI only for harnesses you actually use.
- Prefer fresh threads and `--append-system`; use `--session` deliberately.
- Review `~/.dsh-peer/threads/` periodically and delete old conversations.
- Keep DSH, Claude Code, Codex, and this package updated.

Report security issues through the project's issue tracker, without including
tokens, transcripts, or other private data.
