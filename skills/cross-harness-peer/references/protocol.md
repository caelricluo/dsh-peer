# dsh-peer protocol summary

Companion to `CONTRACT.md` (the source of truth) and the `peer` CLI. Zero
dependencies, Node >= 20, ESM. All paths below are relative to the dsh-peer
package.

## Discovery

```
PEER_HOME = $DSH_PEER_HOME || ~/.dsh-peer
```

`$PEER_HOME/bridge.json` is written by the DSH plugin at startup, mode 0600:

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

Client discovery order:

- URL: `--url` flag > `PEER_BRIDGE_URL` env > `$PEER_HOME/bridge.json` >
  `http://127.0.0.1:45710`.
- Token: `--token` flag > `PEER_BRIDGE_TOKEN` env > `bridge.json`.

No token, or a refused token, exits `3`. An unreachable bridge exits `2`.

## Transport rules

- Bind `127.0.0.1` only; never `0.0.0.0`.
- All requests `POST`/`GET` with JSON bodies, `Authorization: Bearer <token>`.
- Max body 1 MiB. Every response is JSON.
- Errors: `{"error":{"code":"...","message":"..."}}` with 4xx/5xx.
- Error codes: `unauthorized`, `not-found`, `bad-request`,
  `adapter-unavailable`, `adapter-failed`, `timeout`, `thread-closed`,
  `inbound-unavailable`, `internal`.

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET /v1/health` | `{ok, version, packageVersion, uptimeMs, host, adapters}` |
| `GET /v1/adapters` | `{adapters:[AdapterInfo]}` |
| `POST /v1/threads` | create thread -> `201 {thread}` |
| `GET /v1/threads?status=open&limit=50` | `{threads:[Thread]}` |
| `GET /v1/threads/:id?after=0&wait_seconds=0` | `{thread, messages, next_cursor}` |
| `POST /v1/threads/:id/messages` | append + run turn -> `{message, reply, thread}` |
| `POST /v1/threads/:id/close` | `{status:"closed"}` -> `{thread}` (idempotent) |
| `POST /v1/inbound` | one-shot shortcut: create + send + await |
| `GET /v1/events?after=<seq>` | optional SSE stream (CLI ignores it in v1) |

`wait_seconds` long-polls for a newer message; the protocol caps it at 300.

### Create thread (POST /v1/threads)

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

`harness:"dsh"` targets this DSH host (in-process). `claude`/`codex` target a
CLI process the plugin spawns.

### Thread

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

### Message

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

### Send message (POST /v1/threads/:id/messages)

```json
{
  "text": "the user message",
  "from": { "harness": "claude", "name": "optional" },
  "await": true,
  "wait_seconds": 300,
  "model": "optional per-message override",
  "reasoning_effort": "optional per-message override",
  "context": { "optional per-message override" }
}
```

The user message is appended first, then the remote turn runs. `await:true`
returns the `assistant` (or `error`) message; `await:false` returns after the
append. A closed thread serves history but rejects messages with
`thread-closed`.

### AdapterInfo (GET /v1/adapters)

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

Use this to decide whether `--model`, `--effort`, and context flags are
supported by a specific harness before passing them.

## CLI details

Exit codes: `0` ok, `1` usage/other, `2` bridge unreachable,
`3` unauthorized, `4` remote turn failed.

`peer ask` text mode writes only the reply text + newline to stdout;
diagnostics go to stderr. With `--json`:

```json
{ "ok": true, "thread": {}, "reply": {}, "text": "...", "session": {} }
```

`peer read` prints the thread's messages. `--after N` returns messages after
cursor N (`0` = from the start; the `next_cursor` from a previous read is the
right value to pass); `--wait SECONDS` long-polls (max 300); `--follow` keeps
polling.

`peer send` targets an existing thread. `--wait 0` is fire-and-forget; the
bridge appends the message and runs the turn in the background.

`peer status` reports health, adapters, and live DSH sessions (`host.sessions`).
`peer doctor` reports discovery (home, bridge.json, URL source), token presence,
and adapter availability without exposing the token.

## Defaults worth knowing

- Turn timeout: `turnTimeoutMs` = 600000 ms (10 min) from plugin config.
- Wait cap per HTTP request: 300 s.
- Max retained threads: 200 by default; oldest closed threads are pruned.
- Harnesses: `dsh`, `claude`, `codex`.
- Effort values: `low | medium | high | xhigh | max`.
