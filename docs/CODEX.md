# Codex CLI adapter — argv and event contract

This document records exactly what `lib/adapters/codex.js` assumes about the
OpenAI Codex CLI. The codex binary is **not required** for the DSH plugin or the
test suite: unit tests use a fake executable that emits the JSON below. These
notes exist so the assumptions can be re-verified when Codex changes.

## Version and evidence status

- **Target contract:** the `codex exec --json` event stream described by the
  openai/codex repository. Upstream references (identified through web search;
  direct page fetches were blocked in this environment, so these are citations,
  not quoted content):
  - `https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs`
    (`thread.started`, `turn.started`, `item.*`, `turn.completed`,
    `turn.failed`, `error`)
  - `https://github.com/openai/codex/blob/main/docs/exec.md`
- **Verified end-to-end (2026-10-23)** against a real Codex CLI bundled with
  the ChatGPT desktop app:
  `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`
  (`codex-cli 0.163.0-alpha.11.1`, authenticated through `~/.codex/auth.json`).
  `codex` is **not on PATH** on this machine, so the plugin's DSH profile patch
  sets `adapters.codex.command` to that absolute path; without it the adapter
  correctly reports `available:false`.
  Observed events for a fresh turn:
  `{"type":"thread.started","thread_id":"…"}` → `{"type":"turn.started"}` →
  `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}` →
  `{"type":"turn.completed","usage":{…}}`. A resumed turn
  (`codex exec resume <thread_id> -`) recalled the earlier answer, and the
  DSH→Codex direction returned its text through the plugin in ~8 s (fresh) and
  ~15 s (resume). A Codex→DSH reverse call through the installed `peer` CLI
  also succeeded. The prompt warning “Reading prompt from stdin...” goes to
  stderr, not stdout.
- **Earlier local install (kept for history):** `@openai/codex@0.121.0` at
  `/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js`; only
  `--version`/`exec --help`/`exec resume --help` and argv replays were run
  against it. Its `~/.codex/config.toml` load failed in that build
  (`service_tier = "default"`), which is why the newer bundled binary was used.
- **Caveat:** `codex exec --json` is documented as an evolving event stream.
  The parser is intentionally tolerant (see “Parser rules”) and falls back to
  raw stdout when it cannot find structured assistant text. If a future release
  renames events, expect degraded output rather than a hard failure; update
  `parseCodexEvents` and this file together.
- **Caveat:** `codex exec --json` is documented as an evolving event stream.
  The parser is intentionally tolerant (see “Parser rules”) and falls back to
  raw stdout when it cannot find structured assistant text. If a future release
  renames events, expect degraded output rather than a hard failure; update
  `parseCodexEvents` and this file together.

## Codex Desktop (app-server protocol)

`harness: "codex-desktop"` talks to Codex through the protocol Codex Desktop
itself uses, instead of one-shot `codex exec`:

```sh
codex app-server        # JSON-RPC over stdio, one JSON object per line
```

Verified against `codex-cli 0.163.0-alpha.11.1` on 2026-10-23:

| Step | Request | Result |
|---|---|---|
| handshake | `initialize {clientInfo}` then `initialized` | server facts (`userAgent`, `codexHome`) |
| new thread | `thread/start {cwd?, model?}` | `{thread:{id}, model, modelProvider}` |
| resume | `thread/resume {threadId, excludeTurns?}` | the existing thread |
| turn | `turn/start {threadId, input:[{type:"text",text}], model?, effort?}` | `{turn:{id}}` |
| reply | notifications `item/completed` (`item.type === "agentMessage"`, `item.text`) | final assistant text |
| end | notification `turn/completed {threadId, turn}` | turn settled |

The adapter spawns one `codex app-server` per turn, so it cannot deadlock the
host, and reuses the durable thread id as the remote session for continuation.

**Same thread store as the app.** A fresh app-server lists and resumes the
threads Codex Desktop shows (verified: the desktop's own titles appeared in
`thread/list`, and a thread created by this adapter appeared at the top of that
list). To continue a desktop conversation, pass its thread id as
`context.resume` (CLI: `--resume <app-server-id>`).

**Recents visibility.** The desktop app's Recents view is not a live disk scan:
it is maintained by the app's own app-server connection and its local state
(`projectless-thread-ids` / project assignments in
`~/.codex/.codex-global-state.json`). A thread created by a *separate*
app-server process cannot push into the running app. To make bridge-created
threads look like the app's own, the adapter:

- initializes with `clientInfo.name = "Codex Desktop"`, which the app records as
  the thread's `originator` (this is the value its UI filters on), and
- sets the thread title with `thread/name/set` from the prompt's first line.

Verified record after the fix:
`{"originator":"Codex Desktop","name":"In one short sentence: …"}`. The app only
re-reads its list when it (re)connects, so quit and reopen Codex Desktop after
creating bridge threads; they then appear in Recents. Threads created before
this fix keep their old `originator` and stay out of Recents.

**Limitations:** server-to-client requests (approval prompts, user-input
requests) are rejected with `-32601`; run Codex with an approval policy that
does not need them, or expect the turn to fail. Streaming deltas are ignored in
v1 (the final message is used).

**Limitations:** server-to-client requests (approval prompts, user-input
requests) are rejected with `-32601`; run Codex with an approval policy that
does not need them, or expect the turn to fail. Streaming deltas are ignored in
v1 (the final message is used).

## Exact argv

Prompt text is **always** written to stdin and stdin is closed. No user text is
ever placed in argv or a shell command; `runner.js` spawns with
`shell: false`.

### New thread

```
codex exec --json --skip-git-repo-check -C <cwd> [-m <model>] \
      [-c model_reasoning_effort="<effort>"] [...extraArgs]
# stdin: the prompt; no PROMPT positional is passed
```

The local 0.121.0 help text states: *“If not provided as an argument (or if `-` is used),
instructions are read from stdin.”*

### Resumed thread

```
codex exec resume --json [-m <model>] [-c model_reasoning_effort="<effort>"] \
      [...extraArgs] <remoteSessionId> -
# stdin: the prompt; the trailing '-' is required
```

The 0.121.0 resume help states the PROMPT positional is read from stdin **only
if `-` is used**, hence the trailing `-`. This is the one place where the
adapter adds an argv element not spelled out in `CONTRACT.md`; the prompt is
still delivered on stdin as required.

### Notes on flags

- `--json` emits newline-delimited JSON (JSONL) on stdout. Prompt-composition
  warnings may appear on stderr; they are captured, not parsed.
- `-c model_reasoning_effort="<effort>"`: the value is parsed as TOML, so the
  quotes are part of the argv element (there is no shell to strip them).
  Quotes/backslashes in the effort string are escaped.
- `-m/--model` is passed only when a model is configured or requested.
- `-C/--cd` is passed on **new** turns only. `codex exec resume --help`
  (0.121.0) has no `-C` flag, so a resumed turn runs in the recorded/current
  directory. `context.cwd` still becomes the child process cwd when spawning.
- `--skip-git-repo-check` is passed on new turns (CONTRACT section 6). It is
  also accepted by `exec resume` in 0.121.0 but is omitted there to match the
  contract; add it through `adapters.codex.extraArgs` if a resumed turn must
  run outside a git repository.
- `--add-dir` exists on `exec` (not on `exec resume` in 0.121.0). The adapter
  reports `context.addDirs: false` for codex and does not map
  `context.add_dirs`; it can be added manually via `extraArgs` on new turns.
- `extraArgs` from `adapters.codex.extraArgs` are appended after the built
  flags and before any positional (`<sessionId> -` on resume).
- `context.system` / `context.append_system` have no native codex flag; they
  are prepended to the stdin prompt as instructions. `context.files` contents
  are prepended in the same preamble format the in-process DSH host uses.

## Event shapes accepted by `parseCodexEvents`

The parser reads one JSON object per line and returns
`{ text, sessionId, events, usage }`.

### Current shape (0.121.0)

```json
{"type":"thread.started","thread_id":"0199..."}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"agent_message","text":""}}
{"type":"item.updated","item":{"id":"item_0","type":"agent_message","text":"Hel"}}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello"}}
{"type":"turn.completed","usage":{"input_tokens":123,"cached_input_tokens":45,"output_tokens":67,"reasoning_output_tokens":8}}
```

- `text` — concatenation (joined with `\n\n`) of every
  `item.completed` item whose `item.type` is `agent_message`
  (also accepted: `assistant_message`, or `message` with an assistant/absent
  role, and nested `content` arrays). `reasoning`, `command_execution` and
  other item types are ignored.
- `sessionId` — last `thread_id` seen on `thread.started` (also accepted:
  `thread.created`, `session.created`, `session.started`, and a repeated
  top-level `thread_id`). Used as the resume id on later turns.
- `usage` — last `usage` object seen (normally from `turn.completed`); fields
  observed: `input_tokens`, `cached_input_tokens`, `output_tokens`,
  `reasoning_output_tokens`. Kept verbatim in the parser result and copied to
  `message.meta.usage` by the adapter.
- `events` — every parsed object, unmodified, so callers can inspect
  `turn.failed` / `error` / future item types.

### Legacy / tolerant shapes

The adapter also accepts older pre-#4525 event envelopes and plausible wrapper
variants, because the CLI schema has changed more than once:

```json
{"id":"1","msg":{"type":"session_configured","session_id":"..."}}
{"id":"2","msg":{"type":"agent_message","message":"legacy text"}}
{"id":"3","msg":{"type":"token_count","info":{"total_token_usage":{...}}}}
{"type":"error","message":"..."}
{"type":"msg","message":"..."}
```

Plus top-level `{"type":"agent_message","message":"..."}` /
`{"type":"assistant_message","text":"..."}`.

### Fallback

- No JSON line parsed at all → `text` is the trimmed raw stdout,
  `events: []`, `sessionId: null`, `usage: null`; the adapter marks
  `meta.truncated: true`.
- JSON parsed but no `agent_message` found (e.g. only reasoning/tool items) →
  `text: ''`; the adapter keeps the structured outcome and does not invent a
  message.
- `turn.failed` / `error` events (or a non-zero exit code with empty text)
  make `runTurn` reject with `BridgeError('adapter-failed')`.

## Version probe and discovery

`describe()` runs `whichCommand(config.adapters.codex.command)` (default
`codex`) over `PATH`, then `<command> --version` with a 3 s cap to extract a
semantic version. Both steps are cached per adapter instance. Probe failures are
swallowed: `describe()` always resolves with `available:false` and a `notes`
string when the CLI is missing.

If the CLI is installed but not on `PATH` (common for npm global installs
launched from a GUI app), point the config at the executable:

```yaml
- id: dsh-peer
  config:
    adapters:
      codex:
        # npm global entry point; it execs the platform binary
        command: /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js
        defaultModel: ''
        defaultEffort: ''
        extraArgs: []
```

Config is the normalized plugin config, so `turnTimeoutMs` (default 600000) and
per-adapter `command`, `defaultModel`, `defaultEffort`, `extraArgs`, and
optional `models` are honored.

## Runtime behavior

- One short-lived codex process per turn; timeout and `AbortSignal` from the
  bridge are forwarded to `runProcess`, which sends `SIGTERM` and then
  `SIGKILL` after a 1 s grace period. Because codex (and its node wrapper) can
  spawn descendants that inherit the stdio pipes, `runProcess` also enforces a
  bounded settle deadline (`settleGraceMs`, default 250 ms after SIGKILL): it
  resolves with the captured output and `timedOut`/`aborted` set (code may be
  `null`) instead of waiting forever for `close`. Forced settles destroy the
  pipe streams and unref the child so lingering descendants cannot keep the
  host event loop alive. Aborted turns reject with
  `BridgeError` code `timeout` / `name: 'AbortError'` and
  `details.aborted === true`; timed-out turns use `name: 'TimeoutError'`.
- stdin is closed immediately after the prompt is written; the child must read
  EOF (codex does, for both `exec` and `resume -`).
- stdout/stderr are captured with an 8 MiB per-stream cap; exceeding it sets
  `stdoutTruncated` and is surfaced as `meta.truncated`.
- Credentials/config stay in the user's codex environment (`~/.codex`);
  the plugin does not read auth files, pass secrets, or start network calls.
- `onDelta` is accepted but not emitted in v1: `--json` is an event stream,
  not token streaming, and the bridge appends the final text only.

## Test harness contract

Tests never run a real codex turn. A fake executable is created in a temp dir
(e.g. a `#!/usr/bin/env node` script), `config.adapters.codex.command` points at
it, it reads stdin to EOF and prints the JSONL above. The same fake is used to
assert the exact argv, the resume id flow, exit-code handling, timeout and abort
behavior.
