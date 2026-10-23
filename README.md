# dsh-peer — cross-harness peer bridge for DeepSeek Harness

[English](#english) · [中文](#中文)

Let DeepSeek Harness (DSH), Claude Code, OpenAI Codex CLI, and Codex Desktop
agents talk to each other in either direction — with explicit control over the
peer's **model**, **reasoning effort**, and **context**.

Two halves ship together:

1. **DSH plugin** `@caelricluo/dsh-peer` — runs inside the DSH host process,
   exposes five model-facing `peer_*` tools, and drives `claude` /
   `codex` / `codex app-server` for outbound turns.
2. **Skill** `cross-harness-peer` plus a zero-dependency `peer` CLI —
   teaches Claude Code and Codex to call the bridge, ask DSH a question, and
   continue a conversation.

Every conversation is a **thread** with an ordered message log that both sides
read and write, so either side can speak first.

---

## English

### Features

- **Bidirectional** — DSH → Claude Code / Codex CLI / Codex Desktop, and
  Claude Code / Codex → DSH (including a live DSH session).
- **Threads** — append-only logs with cursors, long-poll waits, resume, and
  close; transcripts survive restarts.
- **Explicit routing knobs** — `model`, `reasoning_effort`, and rich
  `context` (cwd, system/append prompt, files, resume id, extra dirs).
- **Zero runtime dependencies** — the plugin, bridge, store, adapters, and CLI
  use Node built-ins only.
- **Loopback + bearer token** — binds `127.0.0.1` only; token lives in
  `~/.dsh-peer/bridge.json` with mode `0600`.
- **Tested** — `node --test` suite covering the store, HTTP bridge, CLI,
  adapters, and the Cordis plugin lifecycle.

### Architecture

```
┌────────────────────────── DSH app (Web or Desktop) ──────────────────────────┐
│  DSH agent session                                                          │
│    ├─ tools: peer_status peer_ask peer_send peer_wait peer_thread           │
│    └─ dsh-peer plugin                                                       │
│         ├─ thread store   ~/.dsh-peer/threads/index.json + <id>.jsonl       │
│         ├─ loopback bridge http://127.0.0.1:45710 (bearer token, 127.0.0.1) │
│         └─ adapters: claude | codex (exec) | codex-desktop (app-server)     │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │ HTTP + token, loopback only
                        ┌───────────┴────────────┐
                        │  peer CLI (plain Node) │
                        └──────┬───────────┬─────┘
                               │           │
                      Claude Code       Codex / Codex Desktop
                      ~/.claude/skills  ~/.codex/skills
```

DSH → external harness does not go through the CLI: the plugin spawns the child
CLI directly (`claude -p`, `codex exec`, or `codex app-server`),
prompt on stdin, `shell:false`.

### What runs where

| Piece | Runs in | Needs |
|---|---|---|
| dsh-peer plugin + bridge | DSH host process | DSH Web/Desktop, Node >= 20 |
| Thread store | `~/.dsh-peer/` (override `DSH_PEER_HOME`) | writable home |
| `peer` CLI | any shell (Claude Code / Codex Bash tool) | plain `node` >= 20, no npm deps |
| `cross-harness-peer` skill | `~/.claude/skills`, `~/.codex/skills` | Claude Code and/or Codex |
| Claude Code adapter | child `claude` process | `claude` available and logged in |
| Codex adapter | child `codex exec` process | `codex` available and logged in |
| Codex Desktop adapter | child `codex app-server` (JSON-RPC over stdio) | a `codex` binary; shares the desktop thread store |
| DSH adapter | in-process DSH child agent | the DSH host it runs in |

### Requirements

- Node.js **>= 20**
- DeepSeek Harness (Web or Desktop app) booting the profile you install into
- Optional: `claude`, `codex`, and/or the Codex Desktop app if you want
  those directions

### Install

From the repository root:

```sh
bash install.sh --profile desktop     # use your booted profile name
```

It installs, in order:

1. the `peer` CLI → `~/lib/dsh-peer/` + launcher `~/bin/peer`
   (and a `~/.local/bin/peer` symlink when that directory exists),
2. the `cross-harness-peer` skill → `~/.claude/skills/` and
   `~/.codex/skills/`,
3. the plugin bundle → `dsh plugin --profile <name> add "link:$PWD"`.

Then **quit and reopen DSH**, start Claude Code / Codex once so they load the
skill, and verify:

```sh
peer doctor
peer status --json
```

Manual steps, troubleshooting, and uninstall: [INSTALL.md](INSTALL.md).

### Quickstart: DSH → another harness

```jsonc
peer_ask {
  "harness": "codex-desktop",   // dsh | claude | codex | codex-desktop
  "prompt": "Review lib/bridge.js for auth bypasses. Findings only.",
  "model": "gpt-6-astra",       // optional, harness-specific
  "reasoning_effort": "high",   // low | medium | high | xhigh | max
  "context": {
    "cwd": "/path/to/project",
    "files": ["lib/bridge.js"],
    "append_system": "Be terse."
  },
  "timeout_seconds": 600
}
```

Continue the same conversation:

```jsonc
peer_ask   { "harness": "codex-desktop", "thread_id": "thr_…", "prompt": "Now fix finding 2." }
peer_send  { "thread_id": "thr_…", "text": "Run the tests." }
peer_wait  { "thread_id": "thr_…", "after": 2, "wait_seconds": 300 }
peer_thread{ "action": "list" }
```

### Quickstart: Claude Code / Codex → DSH

After the install, the skill lets those agents run:

```sh
peer ask --to dsh --effort high --cwd "$PWD" --file lib/store.js \
  "Is the retry policy safe? Cite lines."
```

Talk to a **live** DSH session (the message is delivered as a user turn and the
answer comes back):

```sh
peer status --json                       # find host.sessions[].id
peer ask --to dsh --session session-… --effort low "Reply with exactly OK."
```

Continue a conversation (capture the thread id with `--json`):

```sh
peer ask --to dsh --json "…" > /tmp/peer.json
peer send --thread thr_… --wait 300 "Now propose the patch."
peer read   --thread thr_… --wait 300
```

To talk to an existing **Codex Desktop** thread, pass its app-server UUID:

```sh
peer ask --to codex-desktop --resume 01a16633-… "Continue that plan."
```

### DSH tools

| Tool | Args | Result |
|---|---|---|
| `peer_status` | – | host, adapters (availability/models/efforts), recent threads |
| `peer_ask` | harness, prompt, model?, reasoning_effort?, context?, thread_id?, timeout_seconds? | thread id + reply text |
| `peer_send` | thread_id, text | appended message |
| `peer_wait` | thread_id, after?, wait_seconds? | new messages + cursor |
| `peer_thread` | action: list \| get \| close, thread_id? | threads or thread + messages |

### CLI reference

```
peer status [--json]
peer ask    --to <harness> [options] <prompt>|-
            --model M  --effort E  --cwd DIR
            --system TEXT|@FILE  --append-system TEXT|@FILE
            --file PATH (repeatable)
            --session S      # dsh only: live DSH session
            --thread T       # continue a dsh-peer thread
            --resume ID      # remote session id (codex-desktop UUID, claude/codex session)
            --wait SECONDS   # default 300; 0 = fire and forget
peer send   --thread T [--wait SECONDS] <prompt>|-
peer read   --thread T [--after N] [--wait SECONDS] [--follow]
peer threads [--json]
peer close  --thread T
peer doctor [--json]
peer help
```

Exit codes: `0` ok, `1` usage/other, `2` bridge unreachable,
`3` unauthorized, `4` remote turn failed. `peer doctor` uses
`0` healthy / `2` unreachable-unhealthy / `3` missing-refused token.

### Model, effort, and context

| Knob | CLI | DSH tool | Notes |
|---|---|---|---|
| harness | `--to dsh\|claude\|codex\|codex-desktop` | `harness` | required to start a thread |
| model | `--model M` | `model` | harness-specific; discover with `peer status --json` |
| reasoning effort | `--effort E` | `reasoning_effort` | `low\|medium\|high\|xhigh\|max`; support varies |
| cwd | `--cwd DIR` | `context.cwd` | peer's project root |
| system prompt | `--system TEXT\|@FILE` | `context.system` | **replaces** the peer's system prompt |
| append prompt | `--append-system …` | `context.append_system` | preferred over `--system` |
| files | `--file PATH` | `context.files` | file contents are prepended to the prompt |
| remote resume | `--resume ID` | `context.resume` | continue a remote session id |
| live DSH session | `--session S` (dsh) | – | deliver into a running DSH session |
| extra dirs | – | `context.add_dirs` | Claude Code `--add-dir` |

Guidance: omit model/effort unless needed; read `peer status --json` first;
prefer `--append-system`; pass the minimum context the peer needs.

### Configuration

Plugin config lives in the DSH profile patch. Defaults:

```yaml
- id: dsh-peer
  name: '@caelricluo/dsh-peer'
  config:
    enabled: true
    host: 127.0.0.1        # fixed; anything else is rejected
    port: 45710            # 0 = OS-assigned
    peerHome: ''           # default $DSH_PEER_HOME || ~/.dsh-peer
    token: ''              # default: reuse or generate in bridge.json
    turnTimeoutMs: 600000
    maxThreads: 200
    guidance: true
    adapters:
      claude:          { command: claude, defaultModel: '', defaultEffort: '', extraArgs: [] }
      codex:           { command: codex,  defaultModel: '', defaultEffort: '', extraArgs: [] }
      codex-desktop:   { command: codex,  originator: 'Codex Desktop', defaultEffort: '' }
      dsh:             { defaultEffort: 'high', ephemeral: true }
```

If a Codex binary is not on `PATH` (for example inside
`/Applications/ChatGPT.app/`), point both Codex adapters at it:

```yaml
- id: dsh-peer
  name: '@caelricluo/dsh-peer'
  config:
    adapters:
      codex:
        command: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
      codex-desktop:
        command: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
```

### Codex Desktop notes

- `codex-desktop` speaks the same app-server protocol the desktop app uses,
  so threads live in the shared Codex thread store.
- Bridge-created threads record originator `Codex Desktop` and get a
  prompt-derived title, so the app treats them as its own. The app only re-reads
  its thread list on (re)connect: quit and reopen Codex Desktop to see new
  threads in **Recents**. Threads created before this behavior keep their old
  originator and stay hidden.
- Streams are not forwarded in v1; the final assistant message is returned.
  Server-to-client requests (approval/user-input prompts) are rejected.

### Verified cross-talk (2026-10-23)

| Direction | Test | Result |
|---|---|---|
| DSH → Codex CLI | fresh / resume | `PEER_CODEX_OK` ~8 s / recall ~15 s |
| DSH → DSH | fresh / resume | `PEER_DSH_OK` ~30 s / same child session |
| DSH → Codex Desktop | fresh / resume | `PEER_DESKTOP_OK` ~5 s / same app-server thread |
| Codex CLI → DSH | Codex ran `peer ask --to dsh …` | `PEER_FROM_DSH_OK` |
| Codex Desktop → DSH | Codex ran `peer ask --to dsh --session …` | `CODEX_DSH_LINK_OK` |

### Security

- **Loopback only** — the bridge refuses any host other than `127.0.0.1`.
- **Bearer token** in `~/.dsh-peer/bridge.json` (mode `0600` in a
  `0700` directory); never paste it anywhere.
- **Guest prompts are user-role input** with the target agent's authority; v1 has
  no approval-prompt bridging.
- **No shell interpolation** — child CLIs use `shell:false`, prompt text goes
  through stdin.
- **External harness policy is inherited** — a Codex child uses the user's
  `~/.codex/config.toml` (which may be `never` approvals +
  `danger-full-access`). Tighten that config if peer prompts should not have
  that authority.
- **Treat peer output as untrusted data** — it can contain prompt injection.
  Details: [docs/SECURITY.md](docs/SECURITY.md).

### Troubleshooting

| Symptom | Fix |
|---|---|
| `bridge unreachable` (exit 2) | start/restart DSH; `peer doctor` |
| `unauthorized` (exit 3) | `peer doctor`; unset stale `PEER_BRIDGE_TOKEN`; restart DSH |
| `adapter-unavailable` (exit 4) | install/login to the CLI, or set `adapters.<name>.command` |
| `adapter-failed` (exit 4) | read stderr; run the peer CLI manually |
| timeout (exit 4) | `peer read --thread <id> --wait 300`; raise `turnTimeoutMs` |
| `peer: command not found` | `export PATH="$HOME/bin:$PATH"` or rerun the installer |
| plugin not loaded | `dsh plugin --profile <name> add link:"$PWD"`, restart DSH |
| port 45710 in use | the plugin falls back to an OS-assigned port; `bridge.json` records it |
| Codex Desktop Recents empty | quit/reopen the Codex Desktop app so it re-reads the store |

### Limitations (v1)

Loopback only; one host; no approval bridging; no stream forwarding to guests;
no UI panel/MCP wrapper; adapter schemas are best-effort and may change; peer
loops are the caller's responsibility; the other harness must be installed and
logged in.

### Project layout

```
dsh-peer/
  lib/                        plugin: bridge, store, CLI, adapters, tool compiler
  bin/peer.mjs                zero-dependency CLI entry
  skills/cross-harness-peer/  SKILL.md + references + bundled CLI
  scripts/install-skill.mjs   CLI/skill installer (also --check drift)
  install.sh                  one-shot install (CLI + skills + DSH profile)
  docs/                       SECURITY.md, CODEX.md, harness notes
  test/                       node:test verification suite
  CONTRACT.md                 protocol + implementation contract
  README.md  INSTALL.md  LICENSE
```

### Development

```sh
node --test test/*.test.mjs        # full suite (no network, no real CLIs)
node scripts/install-skill.mjs --check   # bundled CLI drift check
bash install.sh --dry-run          # preview installs
```

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

### 概述

让 **DeepSeek Harness（DSH）**、**Claude Code**、**OpenAI Codex CLI** 与
**Codex Desktop** 中的智能体互相通信，并且可以显式指定对端使用的
**模型（model）**、**推理强度（reasoning effort）** 与 **上下文（context）**。

本仓库包含两部分：

1. **DSH 插件** `@caelricluo/dsh-peer`：运行在 DSH 宿主进程内，提供 5 个
   模型可调用的 `peer_*` 工具，并在需要时直接拉起 `claude`、
   `codex exec` 或 `codex app-server`。
2. **技能** `cross-harness-peer` 与零依赖 `peer` CLI：让 Claude Code
   与 Codex 能调用本桥接、向 DSH 提问，并持续同一段对话。

每一段对话都是一个 **thread（线程）**，消息按顺序追加，双方读写同一份记录，
因此任意一方都可以先开口。

### 功能特性

- **双向通信**：DSH → Claude Code / Codex CLI / Codex Desktop；
  Claude Code / Codex → DSH（包括注入正在运行的 DSH 会话）。
- **线程化**：追加式消息日志，支持游标、长轮询等待、续聊与关闭，重启不丢。
- **显式控制**：`model`、`reasoning_effort`，以及丰富的
  `context`（工作目录、system/append 提示词、文件、resume 会话、额外目录）。
- **零运行时依赖**：插件、桥接、存储、适配器与 CLI 全部只用 Node 内置模块。
- **仅回环 + Bearer Token**：只绑定 `127.0.0.1`，
  `~/.dsh-peer/bridge.json`（权限 `0600`）。
- **有测试**：`node --test` 覆盖存储、HTTP 桥接、CLI、适配器与 Cordis 插件
  生命周期。

### 安装

在仓库根目录执行（`desktop` 换成你实际启动的 profile 名）：

```sh
bash install.sh --profile desktop
```

它会依次完成：

1. 安装 `peer` CLI 到 `~/lib/dsh-peer/`，启动器 `~/bin/peer`
   （若存在 `~/.local/bin` 还会创建软链接）；
2. 将 `cross-harness-peer` 技能安装到 `~/.claude/skills/` 与
   `~/.codex/skills/`；
3. 用 `dsh plugin --profile <name> add "link:$PWD"` 把插件加入 DSH profile。

之后 **退出并重新打开 DSH**，启动一次 Claude Code / Codex 让其加载技能，然后验证：

```sh
peer doctor
peer status --json
```

手动安装、卸载与排错见 [INSTALL.md](INSTALL.md)。

### 快速开始：DSH → 其他 harness

```jsonc
peer_ask {
  "harness": "codex-desktop",   // dsh | claude | codex | codex-desktop
  "prompt": "检查 lib/bridge.js 的鉴权问题，只给结论。",
  "model": "gpt-6-astra",       // 可选，因 harness 而异
  "reasoning_effort": "high",   // low | medium | high | xhigh | max
  "context": { "cwd": "/path/to/project", "files": ["lib/bridge.js"] },
  "timeout_seconds": 600
}
```

继续同一段对话：

```jsonc
peer_ask   { "harness": "codex-desktop", "thread_id": "thr_…", "prompt": "只修第 2 个问题。" }
peer_send  { "thread_id": "thr_…", "text": "跑一下测试。" }
peer_wait  { "thread_id": "thr_…", "after": 2, "wait_seconds": 300 }
```

### 快速开始：Claude Code / Codex → DSH

安装完成后，在 Claude Code 或 Codex 里让智能体执行：

```sh
peer ask --to dsh --effort high --cwd "$PWD" --file lib/store.js \
  "重试策略安全吗？请引用行号。"
```

与**正在运行的 DSH 会话**对话（消息会作为用户输入注入并等待回复）：

```sh
peer status --json                       # 找到 host.sessions[].id
peer ask --to dsh --session session-… --effort low "只回复 OK。"
```

续聊（先用 `--json` 取 thread id）：

```sh
peer ask --to dsh --json "…" > /tmp/peer.json
peer send --thread thr_… --wait 300 "给出最小补丁。"
peer read   --thread thr_… --wait 300
```

与已有的 **Codex Desktop** 线程对话，可传它的 app-server UUID：

```sh
peer ask --to codex-desktop --resume 01a16633-… "继续那个方案。"
```

### DSH 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `peer_status` | 无 | 宿主信息、适配器可用性/模型/推理强度、最近线程 |
| `peer_ask` | harness, prompt, model?, reasoning_effort?, context?, thread_id?, timeout_seconds? | 线程 id 与回复文本 |
| `peer_send` | thread_id, text | 已追加的消息 |
| `peer_wait` | thread_id, after?, wait_seconds? | 新消息与游标 |
| `peer_thread` | action: list / get / close, thread_id? | 线程列表或线程详情 |

### CLI 参考

```
peer status [--json]
peer ask    --to <harness> [options] <prompt>|-
            --model M  --effort E  --cwd DIR
            --system TEXT|@FILE  --append-system TEXT|@FILE
            --file PATH (可重复)
            --session S      # 仅 dsh：注入运行中的 DSH 会话
            --thread T       # 继续 dsh-peer 线程
            --resume ID      # 远端会话 id（codex-desktop UUID / claude / codex）
            --wait SECONDS   # 默认 300；0 表示不等待
peer send   --thread T [--wait SECONDS] <prompt>|-
peer read   --thread T [--after N] [--wait SECONDS] [--follow]
peer threads [--json]
peer close  --thread T
peer doctor [--json]
peer help
```

退出码：`0` 成功，`1` 用法/其他错误，`2` 无法连接桥接，
`3` 未授权，`4` 远端回合失败。`peer doctor` 使用
`0` 健康 / `2` 不可达 / `3` token 缺失或被拒。

### 模型、推理强度与上下文

| 参数 | CLI | DSH 工具 | 说明 |
|---|---|---|---|
| harness | `--to dsh\|claude\|codex\|codex-desktop` | `harness` | 新建线程时必填 |
| 模型 | `--model M` | `model` | 因 harness 而异，用 `peer status --json` 查询 |
| 推理强度 | `--effort E` | `reasoning_effort` | `low\|medium\|high\|xhigh\|max`，支持度因适配器而异 |
| 工作目录 | `--cwd DIR` | `context.cwd` | 对端的项目根目录 |
| 替换 system | `--system TEXT\|@FILE` | `context.system` | **替换**对端系统提示词 |
| 追加 system | `--append-system …` | `context.append_system` | 优先使用这种方式 |
| 文件 | `--file PATH` | `context.files` | 文件内容会拼到提示词前 |
| 远端续聊 | `--resume ID` | `context.resume` | 继续远端会话 id |
| 运行中的 DSH 会话 | `--session S`（dsh） | – | 注入正在运行的 DSH 会话 |
| 额外目录 | – | `context.add_dirs` | Claude Code `--add-dir` |

建议：非必要不指定模型/推理强度；先看 `peer status --json`；优先
`--append-system`；只传对端真正需要的上下文。

### 配置

插件配置在 DSH profile patch 中，默认值如下：

```yaml
- id: dsh-peer
  name: '@caelricluo/dsh-peer'
  config:
    enabled: true
    host: 127.0.0.1        # 固定值，其他地址会被拒绝
    port: 45710            # 0 表示由系统分配
    peerHome: ''           # 默认 $DSH_PEER_HOME || ~/.dsh-peer
    token: ''              # 默认复用或生成 bridge.json 中的 token
    turnTimeoutMs: 600000
    maxThreads: 200
    guidance: true
    adapters:
      claude:          { command: claude, defaultModel: '', defaultEffort: '', extraArgs: [] }
      codex:           { command: codex,  defaultModel: '', defaultEffort: '', extraArgs: [] }
      codex-desktop:   { command: codex,  originator: 'Codex Desktop', defaultEffort: '' }
      dsh:             { defaultEffort: 'high', ephemeral: true }
```

若 `codex` 不在 `PATH`（例如随 ChatGPT.app 分发），把两个 Codex
适配器指向绝对路径即可：

```yaml
- id: dsh-peer
  name: '@caelricluo/dsh-peer'
  config:
    adapters:
      codex:
        command: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
      codex-desktop:
        command: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
```

### Codex Desktop 说明

- `codex-desktop` 使用与桌面版相同的 app-server 协议，线程存放在共享的
  Codex 线程库中。
- 通过桥接创建的线程会记录 originator `Codex Desktop`，并用提示词首行
  生成标题，因此桌面版会把它们当作自己的线程。桌面版只在重新连接时刷新列表：
  **退出并重新打开 Codex Desktop** 后即可在 Recents 看到新线程；修复前创建的
  旧线程仍保持原 originator，不会显示。
- v1 不转发流式输出，只返回最终助手消息；服务端发来的
  审批/用户输入请求会被拒绝。

### 已验证的互通（2026-10-23）

| 方向 | 测试 | 结果 |
|---|---|---|
| DSH → Codex CLI | 新建 / 续聊 | `PEER_CODEX_OK` 约 8 秒 / 约 15 秒回忆成功 |
| DSH → DSH | 新建 / 续聊 | `PEER_DSH_OK` 约 30 秒 / 同一子会话 |
| DSH → Codex Desktop | 新建 / 续聊 | `PEER_DESKTOP_OK` 约 5 秒 / 同一 app-server 线程 |
| Codex CLI → DSH | Codex 执行 `peer ask --to dsh …` | `PEER_FROM_DSH_OK` |
| Codex Desktop → DSH | Codex 执行 `peer ask --to dsh --session …` | `CODEX_DSH_LINK_OK` |

### 安全

- **仅回环**：桥接拒绝除 `127.0.0.1` 外的任何地址。
- **Bearer Token** 位于 `~/.dsh-peer/bridge.json`（`0600`，目录
  `0700`），不要外泄。
- **访客消息以用户输入注入**，拥有目标智能体的权限；v1 不做审批桥接。
- **不做 shell 拼接**：子进程使用 `shell:false`，提示词走 stdin。
- **外部 harness 策略会被继承**：Codex 子进程使用 `~/.codex/config.toml`，
  可能是 `never` 审批 + `danger-full-access`。若不想让对端拥有该权限，
  请收紧 Codex 自身配置。
- **把对端输出当作不可信数据**，可能包含提示词注入。详见
  [docs/SECURITY.md](docs/SECURITY.md)。

### 排错

| 现象 | 处理 |
|---|---|
| `bridge unreachable`（退出码 2） | 启动/重启 DSH；`peer doctor` |
| `unauthorized`（退出码 3） | `peer doctor`；清除过期 `PEER_BRIDGE_TOKEN`；重启 DSH |
| `adapter-unavailable`（退出码 4） | 安装/登录对应 CLI，或设置 `adapters.<name>.command` |
| `adapter-failed`（退出码 4） | 查看 stderr，手动运行对端 CLI 定位 |
| 超时（退出码 4） | `peer read --thread <id> --wait 300`；调大 `turnTimeoutMs` |
| `peer: command not found` | `export PATH="$HOME/bin:$PATH"` 或重跑安装器 |
| 插件未加载 | `dsh plugin --profile <name> add link:"$PWD"` 后重启 DSH |
| 45710 端口被占用 | 插件会自动回退到系统分配端口，`bridge.json` 会记录真实地址 |
| Codex Desktop Recents 看不到 | 退出并重开 Codex Desktop 以重新读取线程库 |

### 限制（v1）

仅回环、单机；无审批桥接；不向访客转发流式输出；无 GUI 面板 / MCP 封装；
适配器依赖的对端事件格式可能变化，解析失败会回退为原始输出；不要让对端再回调
自己形成递归循环；对端 CLI 需自行安装并登录。

### 目录结构

```
dsh-peer/
  lib/                        插件：桥接、存储、CLI、适配器、工具编译器
  bin/peer.mjs                零依赖 CLI 入口
  skills/cross-harness-peer/  SKILL.md、参考文档与内置 CLI
  scripts/install-skill.mjs   CLI/技能安装器（--check 检查漂移）
  install.sh                  一键安装（CLI + 技能 + DSH profile）
  docs/                       SECURITY.md、CODEX.md 等
  test/                       node:test 测试套件
  CONTRACT.md                 协议与实现契约
  README.md  INSTALL.md  LICENSE
```

### 开发

```sh
node --test test/*.test.mjs              # 全量测试（无需网络与真实 CLI）
node scripts/install-skill.mjs --check   # 内置 CLI 副本漂移检查
bash install.sh --dry-run                # 预览安装动作
```

### 许可证

MIT，见 [LICENSE](LICENSE)。
