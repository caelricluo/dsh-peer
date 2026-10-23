# Copy-pasteable transcripts

Illustrative output; ids, model names, and timings vary per machine. Every
command below uses only flags defined in `CONTRACT.md` §7. `$ ` marks a shell
prompt; output lines are indented without it.

## Direction 1: DSH agent -> Claude Code (DSH tool)

Inside a DSH session the plugin registers five tools. The model calls
`peer_ask`; `peer_ask` runs the remote turn synchronously.

```
peer_status {}
```

```json
{
  "host": { "harness": "dsh", "pid": 4242, "sessions": [
    { "id": "session-9f2", "status": "idle" } ] },
  "adapters": [
    { "harness": "claude", "available": true, "models": ["opus","sonnet","haiku"] },
    { "harness": "codex", "available": true, "models": ["gpt-5-codex"] }
  ],
  "threads": []
}
```

```
peer_ask {
  "harness": "claude",
  "prompt": "Review lib/bridge.js for auth bypasses. Reply with findings only.",
  "model": "opus",
  "reasoning_effort": "high",
  "context": { "cwd": "/Users/me/project/dsh-peer", "files": ["lib/bridge.js"] },
  "timeout_seconds": 600
}
```

```json
{
  "thread_id": "thr_0123456789ab",
  "text": "1. ...\n2. ...",
  "reply": {
    "seq": 1, "role": "assistant", "text": "1. ...\n2. ...",
    "from": { "harness": "claude" },
    "meta": { "model": "opus", "reasoning_effort": "high", "durationMs": 41200 }
  },
  "thread": { "id": "thr_0123456789ab", "harness": "claude", "status": "open" }
}
```

Then continue the same conversation from DSH:

```
peer_send { "thread_id": "thr_0123456789ab", "text": "Fix finding 2 only." }
peer_wait { "thread_id": "thr_0123456789ab", "after": 2, "wait_seconds": 300 }
```

## Direction 2: Claude Code -> DSH (peer CLI)

The Claude Code agent runs shell commands; `peer` is on `PATH` from
`scripts/install-skill.mjs`.

```sh
$ peer doctor
peer home    /Users/me/.dsh-peer
bridge.json  found (/Users/me/.dsh-peer/bridge.json, pid 4242 alive)
url          http://127.0.0.1:45710  [bridge.json]
token        found [bridge.json], sha256:1a2b3c4d5e6f
bridge       ok  @caelricluo/dsh-peer 0.1.0  up 3m4s
  adapter dsh     available
  adapter claude  available
  adapter codex   available
sessions     1 live DSH session(s)
```

```sh
$ peer ask --to dsh --effort high --cwd "$PWD" --file lib/bridge.js \
    "You have the bridge file in context. Which body-size limit is enforced?"
Review the file context; the bridge enforces a 1 MiB request body cap and
rejects anything larger before routing.
```

Text mode prints only the reply. To keep the thread id, use `--json`:

```sh
$ peer ask --to dsh --json --effort high "Explain the retry policy in one line." > /tmp/reply.json
$ node -e 'const j=JSON.parse(require("node:fs").readFileSync("/tmp/reply.json","utf8")); console.log(j.thread.id)'
thr_0123456789ab
```

## Direction 3: Claude Code -> DSH, reply into the thread

```sh
$ peer send --thread thr_0123456789ab --wait 0 \
    "Now list the two riskiest failure modes, with file references."
$ peer read --thread thr_0123456789ab --after 2 --wait 300
[2] user (user): Now list the two riskiest failure modes, with file references.
[3] assistant (dsh): The two riskiest failure modes are: (1) ... lib/bridge.js:...; (2) ...
```

Read the full history later:

```sh
$ peer read --thread thr_0123456789ab --after 0
[0] user (user): Explain the retry policy in one line.
[1] assistant (dsh): The bridge retries ...
[2] user (user): Now list the two riskiest failure modes, with file references.
[3] assistant (dsh): The two riskiest failure modes are: ...
```

(`peer read` output formatting is the CLI's; treat the labels above as
illustrative.)

## Direction 4: Codex -> DSH (peer CLI)

Codex uses the same CLI and skill bundle; only the harness that spawns it
differs.

```sh
$ peer ask --to dsh --json --cwd "$PWD" --append-system @AGENTS.md \
    --file src/index.ts --effort medium \
    "In one paragraph, what changed in the last commit?"
{"ok":true,"thread":{"id":"thr_ba9876543210","harness":"dsh","status":"open"},"reply":{"seq":1,"role":"assistant","text":"The last commit ..."},"text":"The last commit ...","session":{"id":"session-abc","resumed":false}}
```

Continue:

```sh
$ peer send --thread thr_ba9876543210 --wait 300 "Which of those changes is risky?"
```

## Direction 5: DSH agent -> Codex (DSH tool)

```
peer_ask {
  "harness": "codex",
  "prompt": "Implement the failing test in test/store.test.mjs, then summarize the diff.",
  "reasoning_effort": "high",
  "context": { "cwd": "/Users/me/project/dsh-peer" },
  "timeout_seconds": 600
}
```

```json
{
  "thread_id": "thr_feedface1234",
  "reply": {
    "seq": 1, "role": "assistant",
    "text": "Changed lib/store.js: ...\nTests: node --test test/store.test.mjs passes.",
    "from": { "harness": "codex" },
    "meta": { "model": "gpt-5-codex", "reasoning_effort": "high", "durationMs": 95400 }
  }
}
```

## Direction 6: target a live DSH session (user-authorized)

```sh
$ peer status --json
{"ok":true,"host":{"harness":"dsh",...,"sessions":[{"id":"session-9f2","status":"idle"}]},...}

$ peer ask --to dsh --session session-9f2 "Continue the refactor you started."
```

## Failure: bridge not running

```sh
$ peer ask --to dsh "ping"
peer: bridge unreachable at http://127.0.0.1:45710 (fetch failed)
$ echo $?
2
# Start DSH with the dsh-peer plugin enabled, then retry; peer doctor shows why.
```

## Failure: token missing or stale

```sh
$ peer status
peer: no bridge token found (checked --token, PEER_BRIDGE_TOKEN and /Users/me/.dsh-peer/bridge.json); start the DSH peer plugin or pass --token
$ echo $?
3
# A stale token fails differently: "peer: unauthorized: ... (check --token / PEER_BRIDGE_TOKEN / <url>)".
```

## Failure: adapter missing

```sh
$ peer status --json
{"ok":true,"adapters":[{"harness":"codex","available":false,"notes":"codex not found on PATH"},...]}

$ peer ask --to codex "hello"
peer: harness "codex" is not available: codex not found on PATH
$ echo $?
4
# The CLI prints the bridge's message; the code "adapter-unavailable" is in the HTTP JSON.
```

## Failure: peer turn failed

```sh
$ peer ask --to claude "fix it"
peer: the peer turn failed: claude exited with code 1: <first line of stderr>
$ echo $?
4
```

## Failure: thread closed

```sh
$ peer close --thread thr_0123456789ab
$ peer send --thread thr_0123456789ab "one more thing"
peer: thread-closed: thread thr_0123456789ab is closed
$ echo $?
1
```

Start a new `peer ask` for a new conversation instead of reopening.
