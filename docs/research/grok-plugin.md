# Grok 插件调研：grok-harnmem 落地路径（2026-10-30）

调研性质：本机已装 Grok CLI **1.0.70 (f50904eaee6c)**（Windows 11，PowerShell 5.1，`GROK_HOME=C:\Users\<user>\.grok`；本调研全程用隔离 `GROK_HOME` 探针，真实 `~/.grok` 未写入）。依据分三级：**【S】** 官方 `docs/user-guide/` 行号可复核（grok 1.0.70 自带 27 章）；**【P】** 本机真机探针实测（证据在 `.tmp/grok-probe/`，索引见附录 A）；**【U】** 未确认。

结论先行：**grok-harnmem 技术路线可行，但不能照搬 Claude Code 的 SessionStart 注入。** Grok 1.0.70 的 `SessionStart` 是 observe-only：`hookSpecificOutput.additionalContext` 与纯文本 stdout 都被丢弃，`systemMessage` 只进客户端注解（`updates.jsonl` 的 `hook_annotation`），且 system prompt 在 hook 完成前约 263 ms 就已渲染——同一 session 不可能靠 SessionStart 注入。四层契约因此重新落点：

1. **注入层**：MCP `initialize.instructions`。实测它在首轮前以 `<system-reminder>\nMCP servers connected: …` 进入模型上下文，是唯一可用的"会话开始一次"注入通道；但会被截断（2 个 server 时聚合 4,293 字符），注入索引必须压到 ~2–3 KB。
2. **工具层**：零依赖 stdio MCP server，5 个 canonical 工具 + `memory_context`（完整快照拉取）。注意 Grok 不把 MCP 工具直接放进 tool definitions，模型经 `search_tool`/`use_tool` 触达。
3. **生命周期/抽取层**：`SessionEnd` command hook → 写临时 payload → detached respawn 子进程；解析会话目录里的 `chat_history.jsonl`（`updates.jsonl` 兜底）。
4. **命令/技能层**：`commands/memory.md` → `/grok-harnmem:memory`；可选 `skills/harnmem-recall/SKILL.md` 做拉取提示。

形态上走 **Claude 兼容插件 + Grok matcher**：`.claude-plugin/plugin.json` 与 `.grok-plugin/plugin.json` 双清单（两者 Grok 都接受，`grok plugin validate` 实测通过），marketplace 索引用 `.grok-plugin/marketplace.json`，与仓库现有的 `.claude-plugin/`、`.agents/plugins/` 并存。

---

## 1. 端到端实证（探针矩阵）

隔离方法：`GROK_HOME=<probe>\grokhome` + `USERPROFILE`/`HOME` 重定向。**只重定向 `GROK_HOME` 不够**——hook 发现仍会扫真实的 `~/.claude/settings.json`、`~/.cursor/hooks.json` 与 `~/.claude/plugins/cache`（P#3）；三者一起指向探针目录后才是干净环境。真实 `~/.harnmem` 未写入（`HARNMEM_HOME` 临时 store + `HARNMEM_READONLY=1`）。

| # | 探针 | 结果 | 关键证据 |
|---|---|---|---|
| P1 | headless `grok -p … --output-format json` 基线 | **PASS** | `{"text":"PONG",…,"usage":{"input_tokens":13231,"output_tokens":4}}`（10.6 s） |
| P2 | `GROK_HOME` 隔离配置 | **PASS** | 探针 home 自建 `config.toml`/`installed-plugins/`，真实 `~/.grok` 无新文件 |
| P3 | `GROK_HOME` 单独是否够隔离 | **PASS w/ caveat** | hooks.log 仍列 `ClaudeSettings(C:\Users\…\.claude\settings.json)`、`CursorHooksFile(…)`；加 `USERPROFILE`/`HOME` 重定向后消失 |
| P4 | 本地目录安装插件 | **PASS** | `grok plugin install <abs path> --trust` → `Installed 1 plugin(s) …`，复制到 `$GROK_HOME/installed-plugins/<repo_key>` |
| P5 | Claude 格式插件（`.claude-plugin/plugin.json` + `hooks/hooks.json` + `.mcp.json`）被接受 | **PASS** | `grok plugin validate` → `Plugin manifest is valid … components: hooks, MCP servers` |
| P6 | 清单可省略（只有 hooks/ 与 .mcp.json） | **PASS** | validate → `No plugin.json found. Grok discovers skills, agents, and hooks automatically …`，exit 0 |
| P7 | headless `-p` 下插件 hook 照常触发（即使 folder 未信任） | **PASS** | `plugin/min-probe/hooks:session_start[0].hooks[0]` 执行；`inspect --json` `projectTrusted=false` |
| P8 | SessionStart matcher 只认 `new`/`load`（Claude 的 `startup|resume|clear|compact` 永不匹配） | **PASS** | 探针 matcher `new|load` 触发；harnmem 的 `startup|resume|clear|compact|fork` 从未触发（[S] 10-hooks.md:96） |
| P9 | SessionStart `hookSpecificOutput.additionalContext` 进模型上下文 | **FAIL（丢弃）** | 三个 marker 在 `system_prompt.txt`/`chat_history.jsonl` 均为 0；hooks.log 显示 `stdout_bytes=125` 读过即弃 |
| P10 | SessionStart `systemMessage` 进模型上下文 | **FAIL（仅客户端注解）** | `updates.jsonl` → `{"sessionUpdate":"hook_annotation","message":"MARKER_SYSMSG"}`；不在 prompt/transcript |
| P11 | SessionStart 纯文本 stdout 成上下文 | **FAIL（丢弃）** | 同上 |
| P12 | SessionStart hook 能影响**同一** session 的 prompt（时序） | **FAIL（时序不对）** | prompt 先渲染，hook 约 263 ms 后完成；hook 写入 `$GROK_HOME/rules/*.md`，同 run `system_prompt.txt` 无该 marker |
| P13 | hook 写的 rules 文件下一 session 被加载（对照） | **FAIL/UNRESOLVED** | 第二次 run 仍 0 命中，`grok inspect --json` 无该 rule 条目 |
| P14 | `$GROK_HOME/rules/*.md`、`~/.grok/rules/*.md` 作为 rules 注入 | **UNRESOLVED** | 无命中；实际只观察到 workspace `AGENTS.md`（`<always_applied_workspace_rule>`，需 `--trust`）与来源不明的 `<user_rules>` |
| P15 | PreToolUse `additionalContext` 模型可见 | **PASS** | `chat_history.jsonl`：`<system-reminder>\nContext from PreToolUse hook 'plugin/min-probe/hooks:pre_tool_use[0].hooks[0]':\nMARKER_PRETOOL_CONTEXT\n</system-reminder>`，`synthetic_reason:"system_reminder"` |
| P16 | Stop `{"decision":"block","reason":…}` 给模型反馈并续轮 | **PASS** | `chat_history`：`"Stop hook feedback:\n…"`（`synthetic_reason:"stop_hook_feedback"`），`num_turns=2` |
| P17 | 插件 `.mcp.json` server 自动启动 | **PASS** | `grok inspect --json` 列出 `mcpServers`；chat 提示 `MCP servers connected: - harnmem (5 tools) - minprobe (1 tool)` |
| P18 | `${CLAUDE_PLUGIN_ROOT}`、`${GROK_PLUGIN_ROOT}` 在 `.mcp.json` args 里展开 | **PASS（两者都行）** | 两个 server 都启动；子进程环境里这两个变量均为 **unset**（展开发生在 spawn 前） |
| P19 | MCP `initialize.instructions` 进模型上下文 | **PASS，但被截断** | 6,042 字符 instructions → `<system-reminder>` 聚合 4,293 字符，结尾 `…[truncated]`，模型 reasoning 明确说看到 `"[truncated]"`，END marker 缺失 |
| P20 | hook 环境变量全集 | **PASS** | `GROK_PLUGIN_ROOT`/`GROK_PLUGIN_DATA`（`CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` 同值）、`GROK_HOOK_EVENT`、`GROK_HOOK_NAME`、`GROK_SESSION_ID`（UUIDv7）、`GROK_WORKSPACE_ROOT`、`CLAUDE_PROJECT_DIR` |
| P21 | 未改动的 `packages/claude-harnmem` 0.4.3 在 Grok 中加载 | **PASS（加载）/ FAIL（注入）** | validate/install/enable 全过，MCP 起 5 工具；SessionStart 因 matcher 从未触发；**SessionEnd 正常触发**并遵守 `HARNMEM_HOME`（临时 store 被创建） |
| P22 | hook 默认 5 s 超时、失败 fail-open | **PASS** | 8 s sleeper 无 timeout → `hook_failure=timed out after 5000ms`，run 仍 exit 0 |
| P23 | Windows 兼容细节 | **PASS** | 插件 hook JSON 必须 **无 BOM**（PS 5.1 `Set-Content -Encoding utf8` 会写 BOM → `failed to parse hook file … expected value at line 1 column 1`，静默 0 hook）；`node` 在 PATH 直接可用，无需 `cmd /c`；带空格/反斜杠的路径加引号可用 |
| P24 | 插件数据目录自动创建 | **PASS** | `$GROK_HOME/plugin-data/user/<hash>/<plugin-name>` |
| P25 | headless 无交互信任提示；`--trust` 写 `trusted_folders.toml` | **PASS** | `[folders.'D:\projects\harnmem'] trusted=true` |
| P26 | UserPromptSubmit `additionalContext`/stdout 是否可见 | **UNRESOLVED（文档说 FAIL）** | 未实测；[S] 10-hooks.md:119 "stdout of an allowing hook is discarded (no `additionalContext`)" |
| P27 | MCP instructions 截断是"每条消息"还是"每 server" | **UNRESOLVED** | 只测到 2 server 聚合 4,293 字符，单 server 阈值未标定 |

本轮追加的两项实证：

- **原生清单通过**：`grok plugin validate` 对一个 `.grok-plugin/plugin.json` + `hooks/hooks.json` + `.mcp.json` + `commands/memory.md` 的骨架返回
  `Plugin manifest is valid. name: grok-harnmem … components: 0 skill dir(s), 1 command dir(s), 0 agent dir(s), hooks, MCP servers`——双清单路线可直接落地。
- **Stop hook stdin 真值**（与 SessionEnd 同族，用于抽取设计）：

  ```json
  {"hookEventName":"stop","sessionId":"01a18c00-…","cwd":"D:\\…\\evidence\\ws",
   "workspaceRoot":"D:\\projects\\harnmem","timestamp":"…","transcriptPath":"…\\sessions\\D%3A%5C…\\<uuid>\\updates.jsonl",
   "promptId":"…","permissionMode":"default","reason":"end_turn","stopHookActive":false,
   "lastAssistantMessage":"OK","backgroundTasks":[],"sessionCrons":[],
   "hook_event_name":"Stop","session_id":"…","transcript_path":"…\\updates.jsonl",
   "permission_mode":"default","stop_hook_active":false,"last_assistant_message":"OK"}
  ```

  即：`transcriptPath` 指向 `updates.jsonl`；`reason=end_turn`；`cwd` 是 workspace 子目录而 `workspaceRoot` 是仓库根。SessionEnd 在探针里实测派发过两次（`plugin/harnmem/hooks:session_end[0].hooks[0]`，exit_code=0，elapsed 307–886 ms），但第二个探针插件的 SessionEnd 声明未派发（疑似同 command 去重，见 §7 R6），因此 SessionEnd payload 的确切形状按 Stop 同族推定，列为 T2。

## 2. Grok 1.0.70 插件体系规格

### 2.1 插件形状

```
<plugin-dir>/
├── .grok-plugin/plugin.json      # 原生清单（可选；也接受 .claude-plugin/plugin.json）
├── .claude-plugin/plugin.json    # Claude 兼容清单（Grok 默认 compat.claude 会读）
├── hooks/hooks.json              # 单文件，Claude 形状
├── .mcp.json                     # { "mcpServers": { … } }
├── commands/*.md                 # 平铺 md，文件名即命令名；插件命令带 /<plugin>: 前缀
├── skills/<name>/SKILL.md        # 标准 Agent Skills
├── agents/、.lsp.json
└── 任意辅助脚本（插件只交付文件，不交付运行时；不会安装任何程序到机器上）
```

- 清单字段（实测 validate 接受）：`name`、`version`、`description`、`author`、`license`、`keywords`；可覆盖组件路径、追加元数据。
- 清单可省略：没有 `plugin.json` 时 Grok 从标准目录自动发现 skills/agents/hooks（P6）。
- 发布前门禁：`grok plugin validate [<path>]`（exit 0 + 组件清单）。

### 2.2 安装、位置、信任、启用

- 安装：`grok plugin install <owner/repo | owner/repo@ref | owner/repo@sha | git URL | local path> [--trust]`；不带 `--trust` 会先展示来源与警告再停。
- 落盘：`$GROK_HOME/installed-plugins/<repo_key>/` + `registry.json`；`config.toml` 的 `[plugins] enabled/disabled` 记录启用状态。
- 位置优先级（[S] 09-plugins.md:417-427）：`_meta.pluginDirs`（ACP `session/new`，仅本会话）> `--plugin-dir`（仅 `grok agent … stdio`，进程级，leader 模式忽略）> `<repo>/.grok/plugins/`（项目，需信任）> `~/.grok/plugins/`（用户，所有项目，自动信任）> `[plugins].paths` 自定义目录。
- **插件默认关闭**：启用后仍需信任，才会加载 skills/commands/agents/hooks/MCP/LSP；`~/.grok/plugins/` 自动信任，项目插件需显式信任（`--trust`、`/plugins` 或 `/hooks-trust`）。headless 无交互信任提示（P25）。
- 插件环境变量：`GROK_PLUGIN_ROOT`（安装后绝对路径）、`GROK_PLUGIN_DATA`（可写数据目录），并同步提供 `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`（P20）；hook 与 `.mcp.json` 参数里都可展开（P18）；handler `env` 不能覆盖这些保留变量。
- `grok plugin list [--json]`、`details`、`enable/disable`、`uninstall [--confirm] [--keep-data]`、`inspect --json`（含 plugin 来源、hook load errors）。

### 2.3 marketplace

- 索引：[S] 09-plugins.md:185——"Grok reads the index from `.grok-plugin/marketplace.json`. It also accepts `.grok-plugin/plugin.json` and the `.claude-plugin/` equivalents."；条目形状 `{name, description, owner, plugins:[{name, description, category, source:{source:"local", path:"./plugins/x"} | {source:"url", url, sha} | "相对路径"}]}`。
- 命令：`grok plugin marketplace add <owner/repo | git URL | local folder>`、`list`、`update [name]`、`remove <url>`；`config.toml` 里也可写 `[[marketplace.sources]]`，或 `settings.json` 的 `extraKnownMarketplaces`。
- 本仓现状：根已有 `.claude-plugin/marketplace.json`（Claude）与 `.agents/plugins/marketplace.json`（Codex）；Grok 侧新增 `.grok-plugin/marketplace.json` 即可，条目 `source: ./packages/grok-harnmem`。
- 旁证：本机 `~/.grok/marketplace-cache/` 已有一份 `ys118/harnmem` 克隆（用户此前加过该市场），说明 Claude 格式市场能被 Grok 直接读取；发布后 `grok plugin marketplace add ys118/harnmem` 一条命令即可。

### 2.4 与 Claude 插件自动兼容是双刃剑

Grok 默认 `compat.claude` 开启，会加载 Claude 插件（P21：未改动的 claude-harnmem 被 validate/install/enable 并启动 MCP）。这带来两个后果：

- **好处**：形态可以复用 Claude 兼容清单与 hooks 形状，迁移成本低。
- **风险**：若用户同时装了 `claude-harnmem`，Grok 里会出现两个 `harnmem` MCP server 名、两个 SessionEnd 抽取进程、以及 `/memory` 撞 Grok 原生 `/memory` 命令。README 必须写明共存策略（建议在 Grok 中禁用 Claude 版，或把 Grok 侧 server 键改成 `harnmem` 之外的别名）；同名/去重语义列入实现期 T3。

## 3. Hooks 系统与注入通道

### 3.1 事件与时机

- 会话级：`SessionStart`（仅 `new`/`load`；**compaction 不触发**，只触发 `PreCompact`/`PostCompact`）、`SessionEnd`（子会话结束带 `subagentType`）。
- 轮级：`UserPromptSubmit`、`Stop`、`StopFailure`。
- 工具级：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`。
- 其他：`Notification`、`StopCancelled`、`SubagentStart`、`SubagentStop`、`PermissionDenied`、`PreCompact`、`PostCompact`。
- **时序**（P12）：system prompt 先渲染，`SessionStart` hook 约 263 ms 后才完成；同一 session 改不了 prompt，下一 session 也读不到 hook 写的 rules 文件（P13/P14 未决）。
- **超时**（P22 + [S] 10-hooks.md:648-652）：observe hook 默认 5,000 ms，失败 fail-open；`Stop`/`SubagentStop`/`PostToolUse` 600 s；`SessionEnd` 每 hook 默认 1.5 s（`GROK_SESSION_END_HOOKS_TIMEOUT_MS` 可调，上限 60 s），**插件的 SessionEnd hook 无论写多少 timeout 都按该默认值截断**——抽取必须 spawn-detach。

### 3.2 输入/输出协议

- stdin 一行 JSON；**双命名**：`hookEventName`（camelCase key，值为 grok snake_case，如 `session_start`）+ `hook_event_name`（snake_case key，值为 Claude PascalCase，如 `SessionStart`）；Claude 字段同时有 camel 主键与 snake 别名（`transcriptPath`/`transcript_path` 等，§1 的 Stop 真值即实例）。
- 子代理身份字段是 `subagentType`（不是 Claude 的 `agent_type`）。
- 输出：只有 `PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`Stop`/`SubagentStop` 会读 `hookSpecificOutput.additionalContext`（≤10,000 字符）；其余事件 observe-only，只读顶层 `systemMessage`，且 `SessionStart` 的 `systemMessage` 仅作客户端注解（P10）。exit 2 的语义按事件不同（PreToolUse deny、Stop block、UserPromptSubmit block）。

### 3.3 注入通道对比（模型可见性实测）

| 通道 | 时机 | 实测结果 | 适合做什么 |
|---|---|---|---|
| SessionStart `additionalContext` | 会话开始 | **FAIL 丢弃**（P9） | 不可用 |
| SessionStart `systemMessage` | 会话开始 | **FAIL 仅客户端注解**（P10） | 不可用 |
| SessionStart 纯文本 stdout | 会话开始 | **FAIL 丢弃**（P11） | 不可用 |
| UserPromptSubmit `additionalContext` | 每次提交 | [S] 明确丢弃（10-hooks.md:119），未实测（T4） | 不可用（按现状） |
| PreToolUse `additionalContext` | 每个工具批次 | **PASS**，`<system-reminder>` 包裹、≤10,000 字符（P15） | 中途刷新 / 首次工具调用补全 |
| PostToolUse `additionalContext`/`updatedToolOutput` | 每个工具后 | 文档支持，未实测 | 写后刷新 |
| Stop `decision:block` | 每轮结束 | **PASS**，以用户消息反馈并续轮（P16） | consolidate/抽取提示 |
| **MCP `initialize.instructions`** | MCP server 握手（每会话） | **PASS**，首轮前以 `<system-reminder>\nMCP servers connected: …` 进入上下文；聚合截断（P19） | **主注入通道（memory index）** |
| `$GROK_HOME/rules/`、`~/.grok/rules/` | 会话开始 | **UNRESOLVED**，探针 0 命中（P13/P14） | 不作为依赖（T5） |
| Grok 原生 memory（`[memory_v2]`） | 会话开始 | 存在且默认关闭；与 harnmem 语义重叠 | 不接管，README 提示不要双开 |

### 3.4 为什么选 MCP `initialize.instructions` 做主注入

- 每次 MCP server 启动（新会话、`--resume`、`--continue`）都会重新 `initialize`，天然"会话开始一次"；同一会话内文本字节稳定，对 prompt cache 友好（与 harnmem 的 byte-stable 注入契约一致）。
- 局限一：**聚合截断**。P19 实测 2 个 server 时 reminder 总长 4,293 字符，模型看到 `[truncated]`；用户若还有别的 MCP server，预算更紧。所以注入索引要小（建议 2,500–3,000 B）并自带按行截断与明确尾注。
- 局限二：**中途不刷新**。`memory_write` 后本轮注入不会变；需要时用 PreToolUse/工具返回值补（v0.2 可选）。
- 实现点很小：claude-harnmem 的 `mcp/mcp.mjs` `initialize` 返回里加 `instructions` 字段；文本来自 core 的 `sessionStart()` 快照（`ensureContext` 已保证同日/同 store 状态字节稳定）。

## 4. 会话数据面（抽取输入）

### 4.1 sessions 目录

`~/.grok/sessions/<urlencoded-cwd>/<uuidv7>/`（本机实测 `D%3A%5Cprojects%5Charnmem…`：`:`→`%3A`、`\`→`%5C`，点保留）。目录内容（[S] 17-sessions.md + 实测）：

| 文件 | 内容 |
|---|---|---|
| `summary.json` | 会话元数据：`info`、`session_summary`、`generated_title`、`title_is_manual`、`created_at`、`updated_at`、`num_messages`、`num_chat_messages`、`current_model_id`、`parent_session_id`、`agent_name`、`agent_profile`、`last_turn_summary`、`last_recap` |
| `updates.jsonl` | 追加式 ACP session update 流，`/resume` 与 `grok sessions search`（SQLite FTS5）的数据源 |
| `chat_history.jsonl` | "raw chat messages sent to the model"（最适合抽取） |
| `system_prompt.txt` | 本会话实际发给模型的 system prompt |
| `prompt_context.json` | 渲染 system prompt 的输入 |
| `tool_definitions.json` | 最近一次模型调用的 function tools（**不含** MCP `server__tool` 条目） |
| `plan.json`、`rewind_points.jsonl`、`signals.json`、`feedback.jsonl`、`compaction_checkpoints/`、`subagents/` | 计划/回滚/信号/反馈/压缩检查点/子代理 |

`transcriptPath`（Stop/SessionEnd payload）= 本会话的 `updates.jsonl`（[S] 25-status-line.md:91）。daemon route 上可能**不**提供 `transcript_path`（[S] 25-status-line.md:61，T6），实现时用 payload 的 `cwd` + `sessionId` 反推目录。

### 4.2 两种记录形状（实测）

`updates.jsonl` 行：

```json
{"timestamp":1793349486,"method":"session/update","params":{"sessionId":"01a18bf5-…",
 "update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"…"}}}}
```

`sessionUpdate` 值含 `user_message_chunk`、`agent_message_chunk`、`agent_thought_chunk`、`hook_execution`、`turn_completed`（带 `prompt_id`/`stop_reason`/`usage.inputTokens`/`usage.outputTokens`）等——chunk 化，抽取需拼接。

`chat_history.jsonl` 行：

| type | 形状 | 说明 |
|---|---|---|
| `system` | `{type, content: "<字符串>"}` | system prompt（探针 5,146 字符） |
| `user` | `{type, content:[{type:"text",text}], prompt_index? , synthetic_reason?}` | 真实用户消息带 `prompt_index`；注入 reminder 带 `synthetic_reason`（如 `system_reminder`、`stop_hook_feedback`）；workspace rules/skills 提示也走 `user` |
| `assistant` | `{type, content:"<字符串>", model_id}` | 整段回复 |
| `reasoning` | `{type, summary:[{type:"summary_text",text}]}` | 思维链摘要 |

**抽取首选 `chat_history.jsonl`**：角色与边界完整、`prompt_index` 可区分真实输入与注入 reminder；`updates.jsonl` 作为兜底（缺 `chat_history.jsonl` 时拼 chunk）。

### 4.3 抽取链路（沿用 claude-harnmem 模式）

1. `SessionEnd` hook 读 stdin JSON（`sessionId`、`cwd`、`transcriptPath`、`reason`、`subagentType`）。
2. `subagentType` 存在 → 子会话，只读跳过；否则写 `os.tmpdir()/harnmem-grok/session-end-<safeId>-<ts>.json`。
3. detached spawn `node hook.mjs --extract-phase <payload>`（`stdio:"ignore"` + `unref()`），hook 立即 exit 0（SessionEnd 1.5 s 上限内安全）。
4. 子进程解析 `chat_history.jsonl`：保留 `type:"user"` 且带 `prompt_index` 的消息、`type:"assistant"` 的 content 字符串；丢弃 `system`、`synthetic_reason` reminder、`reasoning`。
5. `eng.sessionEnd({sessionId, cwd, reason, messages})` 落库（harness 标记 `grok`）；清理 1 h 前的旧 payload。

## 5. 与 claude-harnmem / codex-harnmem 的形态对照

| 维度 | Claude Code (claude-harnmem) | Codex (codex-harnmem) | **Grok（本调研）** |
|---|---|---|---|
| 插件清单 | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` | `.grok-plugin/plugin.json`（或 `.claude-plugin/` 兼容） |
| MCP 声明 | 根 `.mcp.json` | `.mcp.json`（env_vars 白名单） | `.mcp.json`（`${GROK_PLUGIN_ROOT}` 可展开） |
| 注入通道 | SessionStart hook → `additionalContext` | SessionStart `mcp_tool` hook → `hooks.additional_context` | **MCP `initialize.instructions`**（SessionStart 全通道 FAIL） |
| 工具形态 | 5 工具，模型直接可见 | 5+2 工具，直接可见 | 5+1 工具；模型经 `search_tool`/`use_tool` 触达 |
| 生命周期 | SessionStart/SessionEnd | SessionStart（SessionEnd MCP hook 不支持→回填） | SessionEnd command hook（实测触发）+ detached 抽取 |
| 抽取输入 | Claude transcript JSONL | Codex rollout JSONL | `chat_history.jsonl`（`updates.jsonl` 兜底） |
| 安装 | `/plugin marketplace add <repo>` | `codex plugin marketplace add <repo> --sparse <path>` | `grok plugin marketplace add <repo>` → TUI `/plugins` → Marketplace 安装（或 git 子目录直装，§6.7） |
| 开发回路 | `--plugin-dir` / marketplace | 无等价物（重装刷新 cache） | `grok plugin install <本地路径> --trust`（即改即生效需重装）；`validate` 先跑 |
| 命令 | `/harnmem:memory` | skills | `/grok-harnmem:memory` |

## 6. grok-harnmem 架构建议（四层映射）

### 6.1 包结构

独立包 `packages/grok-harnmem/`（**不依赖 claude-harnmem、不用 committed symlink**；沿用 opencode/codex 的"复制中性 glue"先例）：

```
packages/grok-harnmem/
├── .grok-plugin/plugin.json        # 原生清单（validate 实测通过）
├── .claude-plugin/plugin.json      # 兼容清单（Claude/Grok 双读，防旧加载器）
├── .mcp.json                       # harnmem server → ${GROK_PLUGIN_ROOT}/mcp/mcp.mjs
├── hooks/hooks.json                # SessionEnd（不需要 matcher）
├── hooks/hook.mjs                  # 抽取入口 + detached worker
├── mcp/mcp.mjs                     # MCP server；initialize 带 instructions
├── commands/memory.md              # /grok-harnmem:memory
├── skills/harnmem-recall/SKILL.md  # 可选：pull 提示（description 常驻）
├── lib/{engine,format,settings,transcript}.mjs
├── scripts/vendor.mjs
├── vendor/core/**                  # @harnmem/core dist（构建时 vendor）
├── test/{manifest,hook,transcript,mcp}.test.mjs
├── README.md
└── LICENSE
```

- **REUSE**（从 claude-harnmem 直接搬）：`mcp/mcp.mjs` 底座、`lib/{engine,format,settings}.mjs`、`scripts/vendor.mjs`、`vendor/core/**`、`test/{settings,format,vendor}`、`LICENSE`。
- **ADAPT**：`package.json`（name `grok-harnmem`、0.1.0、零依赖、devDep `@harnmem/core` workspace:*、build `node scripts/vendor.mjs`、engines node>=22.15）、`.mcp.json`（`${GROK_PLUGIN_ROOT}`）、`mcp/mcp.mjs`（instructions + 第 6 个工具 + 预算截断）、`hooks/hook.mjs`（`hookEventName` 双命名、`subagentType`、chat_history 解析）、`commands/memory.md`。
- **NEW**：`.grok-plugin/plugin.json`、`.grok-plugin/marketplace.json`、`hooks/hooks.json`、`skills/harnmem-recall/`、`lib/transcript.mjs`、tests、`docs/design/11-grok-adapter.md`、根 `.grok-plugin/marketplace.json`。
- 零依赖不变：`mcp.mjs`/`hook.mjs` 只用 `node:` 内建（与 claude-harnmem 一致）。

### 6.2 注入层（MCP instructions）

- `mcp.mjs` 的 `initialize` 处理：`resolveSettings(cwd, env)` → `openEngine({harness:"grok", cwd})` → `eng.sessionStart({cwd})` → `block.text` → 规范化（去尾空白、按行）→ 截断到 `HARNMEM_MAX_INSTRUCT_BYTES`（默认 2,500 B）→ 作为 `instructions` 返回。
- 截断必须"按行 + UTF-8 安全"：只切整行、尾注 `… (index truncated; call harnmem__memory_context for the full snapshot)`；空快照返回空串（不输出空 reminder 噪声）。
- 审计：`sessionStart()` 会写 `state/audit.jsonl` 的 inject 事件（bytes/tokens/ids），与其它 adapter 口径一致；MCP 子进程拿不到 grok `sessionId`，用合成 id，README 注明（会话关联靠 cwd + 时间）。
- 预算依据：P19 的 4,293 字符是 2 server 聚合值（含头尾固定文案与"Call `search_tool`…"尾注），用户再挂几个 MCP server 就更紧；默认 2,500 B 给他人留余量，T1 校准单 server 上限。

### 6.3 工具层

- 6 个工具：`memory_search`、`memory_read`、`memory_write`、`memory_forget`、`memory_status` + `memory_context`（返回完整快照文本，弥补 instructions 被截断的部分）。
- Grok 侧工具命名 `<server>__<tool>`（`harnmem__memory_search`）；**MCP 工具不在 tool definitions 里**，模型按 reminder 尾注先 `search_tool` 再 `use_tool`——README 与工具 description 都要写"先 search 再 use"。
- tool result 截断沿用 12,000 字符（claude-harnmem `MAX_TOOL_RESULT_CHARS`）；Grok 侧 MCP 输出上限默认 20,000 B（`[mcp].max_output_bytes`）。
- 写工具无额外审批：权限走 grok `permissionMode`；写后调用 `eng.noteModelWrite()`（同 claude 侧语义，注入快照标记 dirty）。

### 6.4 生命周期/抽取层

- `hooks/hooks.json` 只注册 `SessionEnd`（无 matcher）：`{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"node","args":["${GROK_PLUGIN_ROOT}/hooks/hook.mjs"],"timeout":10}]}]}}`。
- SessionStart 不再注册：没有可用注入通道，注册只会浪费 5 s 级 hook 预算。
- 抽取触发可靠性：实测 SessionEnd 派发成功（P21，exit 0）；但第二个探针插件的 SessionEnd 未派发（疑似"同 command 去重"，R6/T2）——实现期先用假 GROK_HOME 的 hook dump 确认 payload 形状，再决定是否需要"下次启动回填"（codex 式，v0.2 兜底）。
- 抽取输入定位：优先 `dirname(transcriptPath)/chat_history.jsonl`；缺失时用 `cwd`+`sessionId` 反推 `sessions/<urlencode(cwd)>/<uuid>/`；再缺则回退 `updates.jsonl` chunk 拼接。
- 会话结束时 Grok 还有一次 observe-only `Stop`（`reason=channel_closed|shutdown`），不能当作 SessionEnd 的替代（[S] 10-hooks.md:569）；`filter reason=="end_turn"` 只处理真正结束的轮次。

### 6.5 命令/技能层

- `commands/memory.md` → `/grok-harnmem:memory`（插件命令带插件名前缀；validate 实测认 `1 command dir(s)`）；内容 mirror claude-harnmem 的 `/memory`（status/搜索/最近写入说明）。
- `skills/harnmem-recall/SKILL.md`（可选）：description 常驻系统提示，body 按需展开，教模型"回答前先 search、写入后用 write"；不承担注入职责（避免与 instructions 重复）。

### 6.6 配置与共存

- 配置沿用 core 优先级：env > `~/.harnmem/config.json` > 项目 `.harnmem.json`；新增 `HARNMEM_MAX_INSTRUCT_BYTES`（默认 2,500）。
- 与 claude-harnmem 共存（§2.4）：README 给"在 Grok 里禁用 Claude 版"的建议；实现期验证同名 server/同名插件行为（T3）。
- 与 Grok 原生 memory：不接管、不同步；README 提示两者语义重叠，不要同时开启（原生 memory 会占 system prompt 预算）。
- 多 MCP server 的 instructions 预算竞争：README 提示"保留一点余量"，并提供 `HARNMEM_MAX_INSTRUCT_BYTES` 调节。
- 沙箱：Grok 的 workspace/read-only/strict profile 可能让 `~/.harnmem` 不可写；README 给 custom `read_write` 或 `HARNMEM_HOME` 方案（与 grok-arch.md 的沙箱结论一致）。
- Windows：插件内 JSON 一律无 BOM（P23）；npm 包 `files` 覆盖 `.grok-plugin/`、`.claude-plugin/`、`hooks/`、`mcp/`、`commands/`、`skills/`、`vendor/`。

### 6.7 marketplace 与安装

- 根新增 `.grok-plugin/marketplace.json`：

  ```json
  {"name":"harnmem-marketplace","owner":{"name":"ys118"},
   "plugins":[{"name":"grok-harnmem","description":"Cross-harness persistent memory for Grok …",
               "category":"memory","source":{"source":"local","path":"./packages/grok-harnmem"}}]}
  ```

  与现有 `.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json` 三份索引并存、互不冲突。
- 安装：`grok plugin marketplace add ys118/harnmem` 后从 TUI `/plugins` → Marketplace 安装该条目；或按文档的 git 子目录直装形式 `grok plugin install ys118/harnmem#packages/grok-harnmem --trust`（与市场路径等价，待 M4 真机确认其一）。本地开发：`grok plugin validate packages/grok-harnmem` + `grok plugin install <abs path> --trust`（已实测）。
- 发布：npm 包 `grok-harnmem` 与其它 adapter 一致；版本/CHANGELOG 仍只在 release PR 动。

### 6.8 测试策略

- `node:test` 确定性（无网络、无 LLM，注入假 GROK_HOME）：
  1. manifest 不变量：双清单字段、组件目录存在、`grok plugin validate` 形状（可断言 JSON 结构）；
  2. hook 契约：假 stdin → exit 0、tmp payload 写入、detached 分支被触发（`HARNMEM_EXTRACT_SYNC=1` 测试缝沿用 claude 侧）；
  3. transcript 解析：`chat_history.jsonl` 与 `updates.jsonl` 两种 fixture，验证只取真实 user/assistant、丢弃 reminder/reasoning；
  4. MCP 往返：initialize（含 instructions、预算截断、空快照）、tools/list（6 个）、tools/call（write→search→read）；
  5. 注入预算：超长快照 → 按行截断、UTF-8 完整、尾注存在。
- 真机验收（M4）：validate → install --trust → TUI 与 headless 各一次：`chat_history.jsonl` 出现 instructions、模型能引用种子记忆、`memory_write` 落盘 `source.harness="grok"`、SessionEnd 抽取恰好一次、store 无重复。

## 7. 风险与未决项

| ID | 风险/未决 | 影响 | 计划 |
|---|---|---|---|
| T1 | MCP instructions 截断阈值未标定（仅 2 server 聚合 4,293 字符） | 注入预算 | 实现期单 server 1–8 KB 扫描，定 `HARNMEM_MAX_INSTRUCT_BYTES` 默认值 |
| T2 | SessionEnd payload 确切形状与可靠性（headless vs TUI；探针第二插件未派发） | 抽取主通道 | 实现期 dump payload；必要时 v0.2 加"下次启动回填" |
| T3 | 与 claude-harnmem 共存（Grok 自动加载 Claude 插件） | 双 server/双抽取/命令撞名 | 实现期显式测试并写 README 推荐配置 |
| T4 | UserPromptSubmit `additionalContext`/纯 stdout 是否可用 | 备选注入面 | **已测（§10）：hook 触发但两种输出均不到模型，确认不可用** |
| T5 | `$GROK_HOME/rules` / `[paths] extra_rule_dirs` 是否加载 | 被动通道 | **已测（§10）：两者均加载；早期 P13/P14 为测量假阴性；因作用域为全局而不采用** |
| T6 | daemon route 无 `transcript_path`（[S] 25-status-line.md:61） | 抽取定位 | 已设计 `cwd`+`sessionId` 反推兜底 |
| T7 | 交互 TUI 是否同样注入 MCP instructions（只在 `-p` 实测） | 首轮注入 | M1 真机验 |
| T8 | Grok 版本升级导致 hook/MCP 语义漂移 | 长期维护 | 探针可重跑（附录 A），版本门在 README 标注"1.0.70 实测" |
| T9 | Windows BOM、路径长度 260 字符 | 打包/安装 | 生成文件统一无 BOM；`files` 收窄 |
| T10 | prompt cache 影响 | 成本 | instructions 只注入一次且字节稳定，对前缀缓存友好；截断规则确定 |

## 8. 实现计划（M1–M4）

- **M1 骨架（0.1.0）**：包结构 + 双清单 + 根 `.grok-plugin/marketplace.json`；`grok plugin validate` / `install --trust` / `inspect` 通过。
- **M2 注入 + 工具**：`initialize.instructions`（预算截断、空快照、审计）+ 6 工具；离线测试 + 真机 headless 验证模型引用种子记忆。
- **M3 抽取 + 命令/技能**：SessionEnd 抽取 worker + chat_history 解析 + `/grok-harnmem:memory` + 可选 skill；真机写读回环。
- **M4 验收与发布**：TUI/headless 双模式验收、README、`docs/design/11-grok-adapter.md`、ROADMAP 勾选、release PR（版本/CHANGELOG 只在 release PR）。

## 9. 追加实证：插件 id 与同名 MCP server 的仲裁（2026-10-30 追补）

初版实现（PR #17）之后曾把 Grok 插件 id 改成 `harnmem`，用“同名插件高优先级覆盖”躲开 Claude Code 插件被 Grok 自动加载的问题。追补探针表明**不需要改名**：决定 `harnmem` MCP server 归属的是 `[plugins] enabled` 显式启用项，而 `grok plugin install` 会自动写入该条目。

| 状态（隔离 `GROK_HOME` + 模拟/真实 `~/.claude` 缓存） | 结果 |
|---|---|
| 两个插件都被发现，无 `[plugins]` 配置 | Claude 版赢得 `harnmem` MCP server（5 工具、无注入） |
| `enabled = ["grok-harnmem"]`（install 自动写入） | grok 版赢得（6 工具 + instructions），3/3 次复现 |
| 先装 grok 版、之后 Claude 插件才出现 | grok 版保持胜出；6 工具，`hook_count=2` |
| 再加 `disabled = ["harnmem"]` | 自动加载的 Claude 副本被卸载：6 工具、`hook_count=1`，审计仅 grok 的 inject/extract |
| 未装 Claude 插件 + `disabled = ["harnmem"]` | 无告警；6 工具、`hook_count=1` |

结论与落地：插件 id 保持 `grok-harnmem`（`/grok-harnmem:memory` 不变），安装命令唯一、无需 pin；README/design 记录“安装即赢得同名 server”的机制，并把 `disabled = ["harnmem"]` 作为可选的一步（只为去掉重复的 SessionEnd hook）。不生效的控制项：`grok plugin disable harnmem`（Claude 发现的插件不在 grok 安装列表里）、Claude 侧 `enabledPlugins: false`（不影响 Grok 发现）、把 enabled/disabled 写进第二个 `[plugins]` 表（TOML 重复键会让整段配置被忽略）。

复现要点：用 `grok inspect --json`（`mcpServers[].source.path` 指向 `installed-plugins/` 还是 `~/.claude/plugins/cache/`）与 debug 日志 `hooks.dispatch{hook_event=session_end hook_count=N}` 判定；`grok plugin list --json` 只列 marketplace 安装的插件（Claude 自动发现的不在列表内）。仲裁规则属实测行为（1.0.70），Grok 升级后需复验（N22）。

## 10. 追加实证：TUI、UserPromptSubmit、rules 通道与发布（2026-10-30 收尾）

初版实现与 P0 验收之后，四项早期未决/待办在本轮补测（Grok CLI 1.0.70；隔离 `GROK_HOME`，TUI 验收保留真实 `~/.claude` 插件缓存以验证共存）：

| 项 | 结果 | 证据 |
|---|---|---|
| TUI 注入与抽取 | **PASS** | TUI 会话 `01a18d19-947d-7383-9c1a-a43f696dcc0b` 的模型 thinking 中出现注入的种子记忆并回答 `GROKMEM-TUI-8D31`；审计 `{"kind":"inject","harness":"grok","bytes":345,"tokens":82,"reason":"session_start"}`；`chat_history.jsonl` 含 `MCP server connected … 6 tools`；`SessionEnd` 仅派发一次（`plugin/grok-harnmem/hooks:session_end[0]`，`elapsed_ms=376`）并写入 journal |
| UserPromptSubmit `additionalContext`/纯 stdout（T4/P26） | **FAIL（确认不可用）** | 探针插件的两个 handler 在 headless `-p` 中均被派发（stdin 已落盘，含 `prompt`、`promptId`）；`hookSpecificOutput.additionalContext` 与纯文本 stdout 在 `chat_history.jsonl` 均为 0 命中 |
| `$GROK_HOME/rules/*.md` 与 `[paths] extra_rule_dirs`（T5/P13/P14） | **PASS（但未采用）** | 新会话 `chat_history.jsonl` 首条 user 消息含 `<rules><user_rules>…T5MARK_RULES_GROKHOME…` 与 `…T5MARK_RULES_EXTRA_DIR…`；`grok inspect --json` 的 `projectInstructions` 列出两个文件（`scope: global`）。该通道作用于整个 `GROK_HOME`（所有项目共享），写项目级快照会跨仓库泄漏，因此仍以 MCP `initialize.instructions` 为主注入 |
| 远端 marketplace 干净机器安装 | **PASS** | 全新 `GROK_HOME` + 干净 profile：`grok plugin marketplace add ys118/harnmem` 1.4 s（`Added marketplace source: harnmem (https://github.com/ys118/harnmem.git)`）；`grok plugin install grok-harnmem --trust` 4.6 s（`Installed 1 plugin(s) from harnmem: grok-harnmem`）；插件取自 GitHub clone 的 `packages/grok-harnmem` |
| npm 发布 | **DONE** | `grok-harnmem@0.1.0` 已发布（CI 未配置 `NPM_TOKEN`，按 CONTRIBUTING 的本地发布回退手动执行） |

**对 §1 矩阵的修正**：P13/P14 的 "FAIL/UNRESOLVED" 是测量假阴性——当时只 grep 了 `system_prompt.txt`（rules 实际注入在会话首条 user 消息里，且未用 `grok inspect --json` 的 `projectInstructions` 核对）。P26（UserPromptSubmit）由 UNRESOLVED 更新为 **FAIL**。P12（同 session 时序）结论不变：SessionStart hook 仍在 prompt 渲染之后完成，rules 文件只对下一次会话生效。

## 附录 A：探针产物与可复现命令

探针根：`D:\projects\harnmem\.tmp\grok-probe\`（隔离 `GROK_HOME` 在 `grokhome/`；证据在 `evidence/out/`；未提交仓库）。

```powershell
$env:GROK_HOME="D:\projects\harnmem\.tmp\grok-probe\grokhome"
$env:USERPROFILE=$env:GROK_HOME; $env:HOME=$env:GROK_HOME
grok --version                                   # grok 1.0.70 (f50904eaee6c)
grok plugin --help
grok plugin validate <plugin-dir>
grok plugin install  <plugin-dir> --trust
grok plugin list --json
grok inspect --json
grok -p "Reply with exactly OK." --output-format json --no-auto-update
```

关键证据文件：

- `evidence/out/sessionstart-env.json` — SessionStart 的完整 stdin 真值与环境变量
- `evidence/out/env-*.json` — SessionStart 三种输出形状（additionalContext/systemMessage/plaintext）
- `evidence/out/mcp-marker.log`、`mcp-marker2.log` — 两个 `${…_PLUGIN_ROOT}` 展开后的 MCP 启动记录
- `evidence/out/inspect-mcp.json` — `grok inspect --json`（plugins/hooks/mcpServers）
- `evidence/out/debug-harnmem.log`、`grokhome/logs/hooks.log` — SessionEnd 派发与 exit code/timeout 记录
- `.tmp/grok-research/{grok-arch.md,harnmem-adapters.md,live-probe.md}` — 架构/适配器/探针三份原始工作笔记

实跑限制：headless `grok -p` 用本机 `opencode-go/deepseek-v4.1-flash` 模型（约 13k input tokens/次）；所有探针不写真实 `~/.grok`、不写真实 `~/.harnmem`。

## 附录 B：关键来源与代码索引

- 官方文档（`C:\Users\<user>\.grok\docs\user-guide\`）：
  - `09-plugins.md:185`（marketplace 索引等价物）、`:417-427`（插件位置优先级）
  - `10-hooks.md:96`（SessionStart 语义）、`:110`（SessionEnd）、`:119`（UserPromptSubmit 丢弃）、`:181`（SessionEnd matcher）、`:528/:713`（observe-only 只读 systemMessage）、`:569`（session 末额外 Stop）、`:648-652`（SessionEnd 超时/插件 hook 上限）
  - `13-memory.md`（原生 memory 竞争面）、`17-sessions.md`（会话存储）、`25-status-line.md:61/:91`（transcript_path 语义）
  - `12-project-rules.md:172`（`--rules` 系统提示注入）、`15-agent-mode.md:211-212`（ACP `_meta.rules`/`systemPromptOverride`）
- 本仓代码：`packages/claude-harnmem/mcp/mcp.mjs`（initialize/tools 骨架）、`packages/claude-harnmem/lib/engine.mjs`（openEngine/预算）、`packages/claude-harnmem/hooks/hook.mjs`（SessionEnd detached 抽取）、`packages/core/src/harnmem.ts:166`（`sessionStart`/`ensureContext` 字节稳定语义）。
