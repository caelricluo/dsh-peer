# CONTRACT — dsh-peer cross-harness bridge (v1)

Single source of truth for parallel implementation. **Do not change this file**;
if something here is wrong or impossible, report it to the Lead instead of
silently diverging.

## 0. What we are building

Two halves of one product:

1. **DSH plugin** `@caelricluo/dsh-peer` (this package). It runs inside the DSH host
   process (Web or Desktop app), where credentials, models, tools and live
   sessions exist. It opens a loopback HTTP **bridge**, registers model-facing
   tools, and can drive external harness CLIs.
2. **Skill** `cross-harness-peer` for **Claude Code** and **OpenAI Codex**.
   It teaches those agents to call the bridge through a zero-dependency CLI
   (`peer`), so they can start conversations with a DSH agent and reply back.

Direction map:

| From \ To | DSH session | Claude Code | Codex |
|---|---|---|---|
| DSH agent (tool) | in-process child agent | spawn `claude -p` | spawn `codex exec` |
| Claude Code / Codex (CLI) | HTTP bridge -> in-process turn or live-session steer | — | — |

Every conversation is a **thread** with an ordered **message log**. Both sides
read the same thread through the bridge, so either side can talk first.

Parameters that a caller can always define per thread and per message:
`model`, `reasoning_effort`, and `context` (cwd, files, system/append prompt,
resume id). Missing values fall back to adapter/plugin defaults.

## 1. File ownership (disjoint write scopes)

| Path | Owner |
|---|---|
| `dsh-peer/CONTRACT.md` | Lead (read-only for everyone else) |
| `dsh-peer/lib/index.js` | Lead |
| `dsh-peer/lib/protocol.js` | Lead |
| `dsh-peer/package.json`, `dsh-peer/cordis.patch.yml` | Lead |
| `dsh-peer/lib/store.js` | bridge-dev |
| `dsh-peer/lib/bridge.js` | bridge-dev |
| `dsh-peer/lib/cli.js`, `dsh-peer/bin/peer.mjs` | bridge-dev |
| `dsh-peer/lib/adapters/**` | adapter-dev |
| `dsh-peer/skills/**`, `dsh-peer/scripts/install-skill.mjs` | skill-dev |
| `dsh-peer/README.md`, `INSTALL.md`, `docs/**` (except this file) | skill-dev |
| `dsh-peer/test/**` | verifier |

Never edit a file owned by someone else. Write only inside your scope.

## 2. Module graph

```
lib/index.js (Lead)
  ├─ lib/protocol.js           shared constants + helpers (Lead)
  ├─ lib/store.js              thread store (bridge-dev)
  ├─ lib/bridge.js             HTTP bridge server (bridge-dev)
  └─ lib/adapters/index.js     adapter registry (adapter-dev)
         ├─ adapters/dsh.js    in-process DSH agent (adapter-dev)
         ├─ adapters/claude.js claude CLI (adapter-dev)
         ├─ adapters/codex.js  codex CLI (adapter-dev)
         └─ adapters/runner.js child-process plumbing (adapter-dev)

bin/peer.mjs  ->  lib/cli.js  (bridge-dev), pure client, ZERO dsh imports
```

Hard rules:

- **`bin/peer.mjs`, `lib/cli.js`, `lib/store.js`, `lib/bridge.js` must be
  importable by plain `node`** with no DSH/Electron packages and no npm
  dependencies. Only `node:*` builtins. This is what the skill ships and what
  the verifier runs.
- `lib/index.js` and `lib/adapters/dsh.js` are the only modules allowed to touch
  DSH services. They must **not** statically import `@deepseek-ai/*`.
  Resolve them lazily (dynamic `import()` inside `apply()`) or accept them as
  injected dependencies, so tests can run outside the app.
- Node >= 20. ESM only. ``"type":"module"``.

## 3. Peer home + discovery

```
PEER_HOME = $DSH_PEER_HOME || ~/.dsh-peer
```

Layout:

```
$PEER_HOME/
  bridge.json          # written by the plugin at startup, mode 0600
  threads/index.json   # thread metadata, written atomically
  threads/<id>.jsonl   # append-only message log, one JSON object per line
  logs/bridge.log      # optional diagnostics
```

`bridge.json`:

```json
{
  "version": 1,
  "url": "http://127.0.0.1:45710",
  "token": "<64 hex chars>",
  "pid": 12345,
  "startedAt": "2026-10-22T13:00:00.000Z",
  "harnesses": ["dsh", "claude", "codex"],
  "package": "@caelricluo/dsh-peer",
  "packageVersion": "0.1.0"
}
```

Client discovery order for URL: `--url` flag > `PEER_BRIDGE_URL` env >
`$PEER_HOME/bridge.json` > `http://127.0.0.1:45710`.
Token order: `--token` flag > `PEER_BRIDGE_TOKEN` env > `bridge.json`.
If no token is found or the bridge refuses it, exit code 3 with a clear message.

## 4. HTTP protocol

All requests: `POST`/`GET`, JSON bodies, `Authorization: Bearer <token>`.
Bind to `127.0.0.1` only (never `0.0.0.0`). Max body 1 MiB. Every response is
JSON; errors are `{"error":{"code":"...","message":"..."}}` with a 4xx/5xx status.

Codes: `unauthorized`, `not-found`, `bad-request`, `adapter-unavailable`,
`adapter-failed`, `timeout`, `thread-closed`, `inbound-unavailable`,
`internal`.

### 4.1 GET /v1/health

```json
{
  "ok": true,
  "version": 1,
  "packageVersion": "0.1.0",
  "uptimeMs": 1234,
  "host": { "harness": "dsh", "pid": 42, "sessions": [
    { "id": "session-...", "title": "optional", "status": "idle|running" }
  ] },
  "adapters": [ <AdapterInfo> ]
}
```

`AdapterInfo`:

```json
{
  "harness": "claude",
  "available": true,
  "version": "2.1.224",
  "command": "/Users/x/.local/bin/claude",
  "models": ["opus", "sonnet", "haiku"],
  "defaultModel": "sonnet",
  "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"],
  "defaultReasoningEffort": null,
  "context": { "cwd": true, "systemPrompt": true, "appendSystemPrompt": true,
               "files": true, "resume": true, "addDirs": true },
  "notes": "optional human-readable diagnostic"
}
```

### 4.2 GET /v1/adapters

```json
{ "adapters": [ <AdapterInfo> ] }
```

### 4.3 POST /v1/threads

Request:

```json
{
  "harness": "dsh|claude|codex|codex-desktop",
  "title": "optional",
  "model": "optional",
  "reasoning_effort": "optional",
  "context": {
    "cwd": "optional absolute path",
    "system": "optional complete replacement system prompt",
    "append_system": "optional appended system prompt",
    "files": ["optional/absolute/or/relative/path"],
    "resume": "optional remote session id to continue",
    "add_dirs": ["optional extra directories the peer may read"]
  },
  "createdBy": { "harness": "dsh", "name": "optional" }
}
```

Response `201`:

```json
{ "thread": <Thread> }
```

`Thread`:

```json
{
  "id": "thr_<12 hex>",
  "harness": "claude",
  "title": "string",
  "model": "string|null",
  "reasoning_effort": "string|null",
  "context": { "...": "normalized copy of what was accepted" },
  "status": "open|closed|failed",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "createdBy": { "harness": "dsh" },
  "remoteSessionId": "string|null",
  "messageCount": 2,
  "lastError": "string|null"
}
```

A thread with `harness:"dsh"` targets **this** DSH host. A thread with
`harness:"claude"` or `"codex"` targets a CLI process the plugin spawns.

### 4.4 GET /v1/threads?status=open&limit=50

```json
{ "threads": [ <Thread> ] }
```

### 4.5 GET /v1/threads/:id?after=0&wait_seconds=0

```json
{ "thread": <Thread>, "messages": [ <Message> ], "next_cursor": 3 }
```

`after` is a message ordinal (0 = from the start). `wait_seconds` > 0
long-polls until a newer message exists or the timeout expires (cap 300).

`Message`:

```json
{
  "seq": 0,
  "id": "msg_<12 hex>",
  "threadId": "thr_...",
  "role": "user|assistant|system|error",
  "text": "string",
  "createdAt": "ISO",
  "from": { "harness": "dsh|claude|codex|codex-desktop|user", "name": "optional" },
  "meta": { "model": "...", "reasoning_effort": "...", "durationMs": 1,
            "exitCode": 0, "sessionId": "...", "truncated": false }
}
```

### 4.6 POST /v1/threads/:id/messages

Request:

```json
{
  "text": "the user message",
  "from": { "harness": "claude", "name": "optional" },
  "await": true,
  "wait_seconds": 300,
  "model": "optional per-message override",
  "reasoning_effort": "optional per-message override",
  "context": { "optional per-message override of the thread context" }
}
```

Behavior:

1. Append a `role:"user"` message immediately (so the thread is a real
   transcript even if the peer dies), then run one remote turn.
2. `await:true` waits for the turn and returns the `assistant` message (or
   `error` message) once settled. `await:false` (default) returns right after
   the user message is appended; the turn runs in the background.
3. For `harness:"dsh"` the bridge routes to the **inbound handler** (section 5).
4. The reply is appended as `role:"assistant"` (or `role:"error"` on failure).

Response `200`:

```json
{ "message": <Message>, "reply": <Message|null>, "thread": <Thread> }
```

### 4.7 POST /v1/threads/:id/close

`{ "status": "closed" }` -> `{ "thread": <Thread> }`. Closing is idempotent; a
closed thread still serves its message history but rejects new messages with
`thread-closed`.

### 4.8 POST /v1/inbound  (guest shortcut used by the CLI)

One-shot convenience for an external agent that does not want to manage a
thread. It creates a thread, sends one message, awaits the reply, and returns:

```json
{
  "thread": <Thread>,
  "reply": <Message>,
  "text": "reply text",
  "session": { "id": "session-...", "resumed": false }
}
```

Request: same fields as 4.3 + `text`, plus optional
`to.session_id` — when present the message is delivered into that **live DSH
session** instead of a fresh child agent.

### 4.9 GET /v1/events?after=<seq> (Server-Sent Events)

Optional live stream of `{"type":"message","threadId":...,"message":...}` and
`{"type":"thread","thread":...}`. The CLI may ignore it in v1; it exists so a
future client can subscribe. Keep it simple: `text/event-stream`, heartbeat
comment every 15 s, closes when the bridge stops.

## 5. Inbound handler contract (Lead's `lib/index.js` owns it)

```js
// supplied to the bridge at construction time
inbound = async ({ thread, message, request, signal }) => {
  // returns { text, meta?, sessionId?, resumed? }
  // throws BridgeError('inbound-unavailable' | 'adapter-failed' | 'timeout')
}
```

Rules:

- If `request.to?.session_id` names a **live** DSH agent, deliver with
  `agent.followup(createUserMessage(...))` (or `steer` when the session is
  running and the message is a correction), await quiescence, and fold the new
  `assistant/message` text from the session log.
- Otherwise create a fresh in-process DSH agent (or resume
  `context.resume`) with the requested `model`/`reasoning_effort`, run one
  turn, fold the answer, dispose ephemeral agents.
- Never let a guest message target a session in a different process or an
  unknown id: return `inbound-unavailable` with the list of live session ids
  in `details`.

## 6. Adapter interface (`lib/adapters/*`)

Each adapter module default-exports a factory:

```js
export default function createAdapter(deps) {
  // deps: { config, logger, peerHome, getHostSessions? }  (dsh adapter gets more)
  return {
    harness: 'claude',
    async describe(): Promise<AdapterInfo>,          // section 4.1
    async openThread({ thread, context }): Promise<void>,   // optional setup
    async runTurn({ thread, userText, message, context, signal, onDelta }):
      Promise<{ text, meta, remoteSessionId? }>,
    async closeThread({ thread }): Promise<void>,     // optional teardown
  }
}
```

`lib/adapters/index.js`:

```js
export function createAdapters({ config, logger, host }) {
  // host = { listSessions(), runInbound(...) } provided by lib/index.js; may be
  // undefined in standalone mode (CLI/tests) - the dsh adapter then reports
  // available:false with a note.
  return {
    async all(): Promise<Adapter[]>,          // ['dsh','claude','codex'] order
    async get(harness): Promise<Adapter>,     // throws missing-harness
  }
}
```

Rules:

- `describe()` must never throw: catch probe failures and return
  `available:false` + `notes`.
- `runTurn()` must respect `signal` (AbortSignal) and kill child processes.
- All child processes: `spawn` with `shell:false`, pass the prompt on
  **stdin** when the CLI supports it, otherwise as an argv element (never
  through a shell, never string concatenation of user text into a command).
- Timeouts default from config (`turnTimeoutMs`, default 600000).
- Return `text` as the final assistant answer only. If the CLI emits JSON,
  parse the documented shape and fall back to raw stdout as `text` +
  `meta.truncated` when parsing fails.

### Adapter defaults

`claude`:

```
claude -p --output-format json [--model M] [--effort E] [--resume S]
       [--append-system-prompt T] [--add-dir D]... <prompt on stdin>
```

Parse the single JSON result object; `result` is the text, `session_id` the
resume id. `--tools ""` is NOT set by default (peer may need tools); keep it
configurable through `adapters.claude.extraArgs`.

`codex`:

```
codex exec --json --skip-git-repo-check -C <cwd> [-m M]
      [-c model_reasoning_effort="E"] <prompt on stdin>
codex exec resume --json <remoteSessionId> <prompt on stdin>
```

Parse newline-delimited JSON; the final agent message item is the text and
`thread.started.thread_id` is the resume id. Include a tolerant parser because
the Codex event schema evolves; document the parser in a comment.

`dsh`:

In-process (section 5), never a subprocess in the normal plugin case.
Accept an injected `host` from `lib/index.js`:
`host.runAgentTurn({ prompt, model, reasoningEffort, cwd, system, resumeSessionId, files, signal })`
-> `{ text, sessionId, resumed }`. The dsh adapter is a thin wrapper that maps
thread/context to that call, so it is testable with a fake host.

## 7. CLI (`bin/peer.mjs` -> `lib/cli.js`)

Zero dependencies, Node >= 20. `--help` with examples, `--json` on every
command for machine-readable output. Exit codes: `0` ok, `1` usage/other,
`2` bridge unreachable, `3` unauthorized, `4` remote turn failed.

Commands:

```
peer status [--json]                     health + adapters + live DSH sessions
peer ask    --to <harness> [options] <prompt>|-   one-shot question, prints reply
            --model M  --effort E  --cwd DIR  --system TEXT|@FILE
            --append-system TEXT|@FILE  --file PATH (repeatable)
            --session S (dsh only: target a live DSH session id)
            --thread T (continue an existing dsh-peer thread)
            --resume ID (remote session id: codex-desktop app-server thread, claude/codex session)
            --wait SECONDS (default 300; 0 = fire and forget)
peer send   --thread T [--wait SECONDS] <prompt>|-  fire into an existing thread
peer read   --thread T [--after N] [--wait SECONDS] [--follow]  print messages
peer threads [--json]                    list threads
peer close  --thread T                   close a thread
peer doctor [--json]                     discovery + token + adapter diagnosis
peer help
```

Output format for `ask` (text mode): the reply text followed by a newline,
nothing else on stdout (diagnostics go to stderr). With `--json`:
`{"ok":true,"thread":{...},"reply":{...},"text":"...","session":{...}}`.

## 8. Plugin config (`lib/index.js` Config)

```yaml
- id: dsh-peer
  name: '@caelricluo/dsh-peer'
  config:
    enabled: true                 # bridge on/off
    host: 127.0.0.1               # fixed; anything else is rejected
    port: 45710                   # 0 = random free port
    peerHome: ''                  # default $DSH_PEER_HOME || ~/.dsh-peer
    token: ''                     # default: reuse/generate $PEER_HOME/bridge.json
    autoApprove: false            # reserved; approval integration is v2
    turnTimeoutMs: 600000
    maxThreads: 200
    guidance: true                # register a short system-prompt section
    adapters:
      claude: { command: claude, defaultModel: '', defaultEffort: '',
                extraArgs: [] }
      codex:  { command: codex,  defaultModel: '', defaultEffort: '',
                extraArgs: [] }
      dsh:    { defaultModel: '', defaultEffort: 'high',
                ephemeral: true }
```

## 9. DSH tools (registered by `lib/index.js`)

Exactly these five names, all returning compact JSON:

| Tool | Args | Result |
|---|---|---|
| `peer_status` | `{}` | `{host, adapters, threads}` |
| `peer_ask` | `{harness, prompt, model?, reasoning_effort?, context?, thread_id?, timeout_seconds?}` | `{thread_id, text, reply, thread, session?}` |
| `peer_send` | `{thread_id, text}` | `{message, thread}` |
| `peer_wait` | `{thread_id, after?, wait_seconds?}` | `{messages, next_cursor, thread}` |
| `peer_thread` | `{action:"list"|"get"|"close", thread_id?}` | `{threads}` or `{thread}` |

`peer_ask` runs the turn synchronously (awaits the reply) because the model
needs the answer in the same tool call. Its description must state that it can
take minutes and that `timeout_seconds` caps it.

## 10. Testing contract (verifier)

- `node --test test/*.test.mjs` must pass with plain Node, cwd = `dsh-peer/`.
- Tests must not need network, DSH, Claude or Codex. Fake CLIs are shell/node
  scripts created in a temp dir (`fake-claude`, `fake-codex`) that emit the
  documented JSON shapes.
- Required coverage:
  1. `store`: append/read/atomic index, long-poll wakeup, concurrent appends.
  2. `bridge`: auth rejection, thread CRUD, await + async turns, closed
     thread, long-poll, inbound routing with a fake host, SSE endpoint opens.
  3. `adapters`: claude arg building + JSON parsing, codex arg building +
     JSONL parsing (tolerant), dsh adapter against a fake host, abort kills
     child.
  4. `cli`: arg parsing, discovery order, exit codes (2 unreachable, 3
     unauthorized), `ask` text/json output, `skills/.../scripts/peer.mjs`
     parity with `bin/peer.mjs`.
  5. `plugin`: `lib/index.js` exported factory registers exactly five tools,
     rejects a non-loopback host, and wires inbound to a fake host.

## 11. Non-goals for v1

- No cross-machine networking (loopback only).
- No DSH UI panels.
- No MCP server wrapper.
- No approval prompt bridging (documented as v2).

## 12. Implementation decisions recorded during the build (Lead)

These refine, not replace, the sections above.

1. **Zero `@deepseek-ai` imports anywhere.** The harness bundles its packages
   inside `app.asar`; a profile plugin cannot resolve them (the shipped
   community plugin `dshmarket` imports none). The plugin therefore ships
   `lib/tool.js`, a local `defineTool` that compiles the same compact DSL into
   the raw JSON Schema the tool registry consumes, and validates arguments
   itself. `ctx.tools.register` only requires
   `{name, description, parameters, output:{schema,render}, execute}`, which the
   local compiler produces. `inject = ['tools']`; every optional service is
   read with `ctx.get()`.
2. **User messages are built locally.** `createUserMessage` is effectively
   `deepFreeze({...input, id: randomUUID(), role:'user'})`; `lib/index.js`
   produces the same shape when no injected helper is present.
3. **Session folding** copies the shipped headless runner: iterate
   `session.eventAt(seq)` from the pre-send sequence, keep the last non-empty
   `assistant/message` text, and read the terminal `turn/end` reason.
4. **Live-session delivery** uses `ctx.agents.get(id)` plus
   `followup()` (idle) or `steer()` (running), then `whenIdle()` including
   `subagents.waitForChildren()` when composed. Unknown or non-live ids fail
   with `inbound-unavailable` and list the live ids.
5. **Discovery file is the contract for the CLI.** `$PEER_HOME/bridge.json`
   carries `url`, `token`, `pid`; `/v1/health` does not repeat the URL.
6. **Tool layer extras.** `lib/bridge.js` exposes the in-process methods the
   tools call (`listen/close/health/describeAdapters/createThread/sendMessage`)
   in addition to the HTTP endpoints, so tool execution never loops through
   HTTP.


7. **Caller route inheritance.** An in-process DSH child inherits the provider,
   model, reasoning effort and cwd recorded in the calling session's latest
   `request/header` (falling back to a running session, then
   `agentDefaultModel`). Without this the child used the deployment default
   `deepseek-official` API-key route and failed with `MISSING_CREDENTIAL` in an
   OAuth-signed-in app.
8. **Tool output schemas stay open.** The host validates a tool's returned value
   against its declared output schema; threads legitimately carry `null`
   model/effort/remoteSessionId/lastError, so those output schemas are open
   objects (`additionalProperties: true`) rather than typed property maps.
9. **Bounded settle.** `waitForQuiet()` follows the headless runner's loop
   (idle, drain children, require an unchanged sequence), always yields to the
   event loop, and is bounded by `turnTimeoutMs`; a spin here froze the host.

