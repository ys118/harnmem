# Codex 插件调研：codex-harnmem 落地路径（2026-10-28）

第一手实测环境：Codex 桌面版 **26.1021.31345**（内嵌 CLI `codex-cli 0.164.0-alpha.11.1`，位于 `C:\Users\<user>\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe`），Windows 11，PowerShell 5.1，`CODEX_HOME=C:\Users\<user>\.codex`，ChatGPT 账号登录。

结论先行：**codex-harnmem 技术路线全部实证可行**。Codex 有一套与 Claude Code 高度同构的原生插件体系（marketplace → plugin → MCP + hooks + skills），我们用最小探针插件真实跑通了全链路：插件 MCP 服务器在会话中启动 ✓，SessionStart hook 触发并调用 MCP 工具 ✓，**hook 工具返回值以 developer message 注入模型上下文（`hooks.additional_context`）✓**，插件 skill 命名空间注册 ✓。注入层（harnmem 的命门）有官方一等通道，无任何 hack。

---

## 1. 端到端实证（探针全链路，本调研最有价值的结果）

在 `D:\projects\harnmem\.tmp\codex-probe\`（已保留作参考实现）搭了最小 marketplace + 插件，真实执行：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 注册市场 | `codex plugin marketplace add <本地路径> --json` | ✓ 返回 `{marketplaceName, installedRoot, alreadyAdded}` |
| 安装插件 | `codex plugin add harnmem-probe@harnmem-probe-market --json` | ✓ 整目录拷贝到 `~\.codex\plugins\cache\<market>\<plugin>\<version>` |
| 真会话 | `codex exec --skip-git-repo-check --sandbox read-only -m <model> "Reply with exactly: ok"` | ✓ 模型回复 ok（~17k tokens）；rollout 写入 `~\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl` |

三项关键机制实测：

### 1.1 插件 MCP 服务器在会话中启动 ✅

会话初始化日志（`RUST_LOG=info` 可见）显示 `mcp_servers="probe, codex_apps, cua_repl, node_repl"`——插件声明的 MCP 服务器与 config.toml 服务器**同一进程组启动**。握手协议：`codex-mcp-client` / protocol `2025-06-18`，newline-delimited JSON-RPC（与 Claude MCP stdio 相同，claude-harnmem 的 `mcp.mjs` 几乎可以直接复用）。

失败语义：服务器崩溃只产生 WARN（`MCP server startup failed server_name="probe" error=handshaking ...`），会话继续运行。**不会拖死用户会话，但开发期首连必须成功**（与 claude 侧"失败缓存 15 分钟"同类风险，Codex 侧表现为本次会话无工具）。

### 1.2 SessionStart hook → mcp_tool 调用 → additional_context 注入 ✅

plugin.json 声明 hook（`type: "mcp_tool"`，`server`+`tool`+`input` 模板），实测：

- hook 在 turn 开始时触发（比进程启动晚 ~16s，即随首个 turn 走）；
- 模板变量全部解析：`hook_event_name="SessionStart"`、`session_id=<threadId>`、`cwd=<真实 cwd>`；
- **工具返回文本进入模型上下文**——rollout 中出现 developer message：

```json
{"type":"message","role":"developer","content":[{"type":"input_text","text":"event recorded"}],
 "internal_chat_message_metadata_passthrough":{"content_item_kinds":["hooks.additional_context"],
 "content_item_metadata":[{"provenance":{"type":"tool","namespace":"mcp__probe"}}]}}
```

这正是 harnmem 注入层需要的官方通道，等价于 Claude 的 `additionalContext`，且**不需要单发 hook 脚本进程**（直接调自家 MCP 工具，模板传参）。

### 1.3 插件 skill 注册 ✅

rollout 的 `skills_instructions` 出现 `harnmem-probe:harnmem-probe`（命名空间 `plugin_name:skill_name`，路径指向 cache 内 `SKILL.md`）。harnmem 用 skill 承载"怎么用记忆工具"的说明即可被模型按需展开。

---

## 2. Codex 插件体系规格（0.164.0-alpha.11.1 实测）

```
<repo-root>/                                # marketplace = 任意含此清单的目录/git 仓
└── .agents/plugins/marketplace.json        # {name, interface.displayName, plugins:[...]}
    plugins/<name>/
    ├── .codex-plugin/plugin.json           # 插件清单（见下）
    ├── .mcp.json                           # MCP 服务器声明（Claude 格式超集）
    ├── skills/<skill>/SKILL.md             # 标准 Agent Skills frontmatter
    └── ...                                 # 其余文件原样拷贝进 cache
```

**plugin.json**（实测字段）：`name, version, description, author, license, keywords`；`mcpServers: "./.mcp.json"`；`skills: "./skills/"`；`hooks: { hooks: { <Event>: [ { hooks: [ { type: "mcp_tool", server, tool, input: {模板} } ] } ] } }`；`interface`（桌面 UI 元数据：displayName/icon——icon 路径含 `..` 会 WARN 且被忽略，必须落在插件 `assets/` 下）。

**.mcp.json**（Claude 兼容超集）：`mcpServers.<name> { command, args, cwd: "."（相对插件 cache 根）, enabled, env_vars: [白名单], startup_timeout_sec, tool_timeout_sec, default_tools_approval_mode, tools.<t>.approval_mode }`。**env_vars 是显式白名单**——只有列出的环境变量传给服务器进程（实测 PATH/SYSTEMROOT 传入，其余被剥离）。harnmem 的 `HARNMEM_HOME/HARNMEM_DISABLED/HARNMEM_READONLY` 必须逐个列入 env_vars。

**marketplace.json**：`plugins[].source { source: "local", path: "./plugins/<name>" }`；`policy { installation, authentication: ON_INSTALL }`。

安装/更新/卸载语义（全部实测）：

- `plugin add` **重装即刷新 cache**（同版本号也重新拷贝）——本地市场发版用版本号目录区分，更新 = bump version + `plugin add`；`plugin remove` / `marketplace remove` 干净卸载（config.toml 与 cache 全部还原，实测与安装前逐字节一致）。
- config.toml 落两个条目：`[marketplaces.<m>] {source_type="local", source="\\?\<path>"}` 与 `[plugins."<p>@<m>"] enabled=true`。
- `marketplace add` 接受本地路径 / `owner/repo[@ref]` / Git URL，支持 `--ref` 与 `--sparse <PATH>`（可重复）→ **harnmem 公开后一条命令**：`codex plugin marketplace add ys118/harnmem --sparse packages/codex-harnmem`，无需独立市场仓库（比 claude 侧还干净）。

## 3. Hooks 系统

- 事件全集（二进制枚举，14 个）：`PreModelRequest, PostModelRequest, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt`——覆盖 harnmem 四层契约全部需求（对比：bundled 插件只用 Stop/SubagentStop/Interrupt；官方文档记载 12 个，二进制更多，实现期以真机逐事件验证为准）。`features`：`hooks=stable true`，`plugin_hooks=removed`（并入 hooks），内建 `memories=stable false`（生态真空期，正是进入时机）。
- 信任模型：CLI 有 `--dangerously-bypass-hook-trust`（跳过持久化信任审查）；**实测本地 marketplace + `authentication: ON_INSTALL` 安装后，exec 不带任何 bypass 旗标 hook 照常触发**。真实用户装 ys118/harnmem 后预期有一次信任确认（桌面 UI 或首会话提示），实现期验证。
- hook 元数据（二进制 `HooksListEntry`）：`eventName, timeoutSec, statusMessage, additionalContextLimit, pluginId, trustStatus, ...`——hook 有独立超时与上下文长度上限（注入钳制沿用 claude 侧 10k 字符经验值即可）。
- **SessionEnd 超时仅 1s/3s（官方文档），不能做抽取主通道**——但 claude-harnmem 已验证"hook 内 spawn detached 子进程立即返回"模式，子进程生命周期不受 hook 超时约束，Codex 侧照搬即可。
- 模板变量：`${hook_event_name}/${session_id}/${turn_id}/${agent_id}/${cwd}`（browser 插件实例）+ `${PLUGIN_ROOT}/${PLUGIN_DATA}`（插件路径变量）。`session_id` 实测 = threadId（rollout 同名），可作为会话关联键。

## 4. 会话数据面（抽取的输入）

- rollout：`~\.codex\sessions\YYYY\MM\DD\rollout-<ts>-<threadId>.jsonl`，行类型 `session_meta`（含 cwd、originator、cli_version、base_instructions 全文）/`event_msg`/`response_item`/`turn_context`/`token_usage_record`/`world_state`。**`codex exec` 无头会话同样写 rollout**（实测）。
- 桌面版线程元数据在 `~\.codex\thread_history_1.sqlite`（thread_turns/thread_items 等表）；`session_index.jsonl` 当前为空。
- 抽取器（claude-harnmem 的 `transcript.mjs` 模式）需要适配 rollout 的行格式；threadId 可从 hook 模板变量直接拿到，无需解析 sqlite。

## 5. 与 claude-harnmem 的形态对照

| 维度 | Claude Code | Codex（实测） |
|---|---|---|
| 插件清单 | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` |
| MCP 声明 | 根 `.mcp.json`（stdio/http） | `.mcp.json`（+ env_vars 白名单/approval 策略） |
| 注入通道 | SessionStart command hook → `additionalContext` | SessionStart mcp_tool hook → `hooks.additional_context`（developer message） |
| 抽取通道 | SessionEnd detached 子进程 | 同模式（SessionEnd 1s/3s 只够 spawn-and-exit） |
| 工具前缀 | `mcp__plugin_<名>_<server>__<tool>` | provenance 命名空间 `mcp__<server>`（模型侧同名风险见 §7） |
| 安装 | `/plugin marketplace add owner/repo` | `codex plugin marketplace add owner/repo --sparse <path>` |
| 开发回路 | `--plugin-dir` 即改即生效 | **无等价物**：必须走 add（重装刷新 cache） |
| 路径变量 | `${CLAUDE_PLUGIN_ROOT}` | `${PLUGIN_ROOT}`（args/cwd 相对 cache 根） |

## 6. codex-harnmem 架构建议（四层映射）

沿用 `docs/adapter-authoring.md` 四层契约，全部有实证落点：

1. **Injection**：SessionStart hook（mcp_tool → `memory_context` 工具，返回字节稳定的注入块）+ UserPromptSubmit hook（可选，做 resume/compact 后的补注入，实现期逐事件验证）。字节稳定规则照旧：只在 start/resume/compact/write/day-rollover 重建。
2. **Tools**：复用 claude-harnmem 的零依赖 stdio MCP server 形态（`mcp/` 直接抽公共包或 vendor），5 工具 `memory_write/search/read/forget/status`；`env_vars` 白名单显式携带 `HARNMEM_HOME/HARNMEM_DISABLED/HARNMEM_READONLY/PATH/SYSTEMROOT`。
3. **Lifecycle**：PreCompact/PostCompact hook 做压缩感知（替代 claude 的 compact hook）；SessionEnd spawn detached 抽取子进程（1s/3s 限制内安全）；day-rollover 由 core 引擎负责（不变）。
4. **Config**：与 claude 侧同源——env > `~\.harnmem\config.json` > 项目 `.harnmem.json`；注意 env 只能经 env_vars 白名单进 MCP 进程，hook 模板无法传任意 env。

打包：`packages/codex-harnmem/`，`@harnmem/core` vendor 进包（同 claude 侧），根放 `.agents/plugins/marketplace.json`（source 指向 `./packages/codex-harnmem`…注意 marketplace 清单必须在**市场根**，harnmem 仓库根即是市场根，`plugins[].source.path` 指向 `packages/codex-harnmem`——与 claude 侧 marketplace.json 并存，互不冲突）。

**工具名冲突注意**：Codex 实测 provenance 命名空间为 `mcp__<server>`（不带插件名前缀，`non_prefixed_mcp_tool_names` 尚在 under development）。server 键名取 `harnmem`（专用性足够，与用户自配 `[mcp_servers.harnmem]` 冲突概率低，但 README 要提示勿用同名）。

## 7. 风险与待办

- ~~桌面版真机验证~~ **已完成（2026-10-29，见 §9）**：desktop 与 CLI 共享 `~/.codex`，信任写入 config.toml 后 desktop 零操作吃到，新会话 hook 注入实证通过。
- 逐事件验证 `UserPromptSubmit/PreCompact/PostCompact/Stop` 的 mcp_tool 触发与注入表现（机制已由 SessionStart 证实，事件语义需各跑一次探针）——见 N16。
- 版本升级 UX：`plugin add` 重装即刷新（实测），但官方 upgrade 语义（`marketplace upgrade` 后插件是否自动跟进新版本）未验证。
- `codex exec` 两个坑已排掉并复用价值高：**必须从存在的工作目录运行**（cwd 不存在时报可执行文件 ENOENT，误导性极强）；模型名必须用账号可用列表（`~\.codex\models_cache.json`，本机为 gpt-6-luna/gpt-5.6-terra/gpt-5.6-luna，二进制内 slug 是内部代号不可用）。
- Windows：codex 的 shell 工具用 powershell.exe；MCP 服务器经 PATH 找 `node`（本机 PATH 命中 nvm 的 Node 26）；`.mjs` 必须 ESM（`require` 直接崩，探针踩过）。

## 8. 实现期真机验收记录（2026-10-28，codex-harnmem 0.1.0）

实现后用同一机制复测，全部通过；以下为**新发现**（探针阶段不可见）：

- **SessionEnd mcp_tool hook 不支持**：启动即 WARN `skipping MCP tool hook … SessionEnd MCP hooks are not supported`，hook 被跳过。插件保留声明（forward-compatible，未来支持即零改动生效）；当前抽取主通道缺位，记忆经模型显式 `memory_write` 或其它适配器入store（已写入包 README 与 ROADMAP N16）。
- **hook trust 未持久化时 exec 静默跳过 SessionStart**：不带 `--dangerously-bypass-hook-trust` 时无任何派发日志（静默）；带上后 `hook: SessionStart … Completed` 正常。探针阶段"无需 bypass"的结论修正为：**本地市场 + ON_INSTALL 免安装仪式，但 exec 下 trust 未持久化仍会跳过**（探针当时可能已被首跑 bypass 持久化）。
- **注入时序**：SessionStart hook 在 turn dispatch 之前完成（实测 ~2.3 s 内），注入以 developer message（`content kind: hooks.additional_context`）落在 user prompt 之前。
- **project 作用域 × cwd**：注入快照只含 user 作用域 + 与 cwd 匹配 project shard 的记录——种子脚本 cwd 与 exec cwd 不同导致快照为空，属 core 正确语义。适配器文档已注明「exec cwd 决定 project shard」。
- **MCP 写工具审批**：exec 默认 approval policy 下模型调 `memory_write` 被拒（`Unable to write: MCP approval is disabled.`）；无人值守需 `--dangerously-bypass-approvals-and-sandbox`，交互模式批准即可。
- **session 锚定实证**：hook 模板带入真实 threadId 后，模型写回记录 `source = {harness:"codex", session:"<threadId>"}`——callTool 首个非空 session_id 锚定引擎的方案真机有效。
- **模型可见性实证**：注入快照后模型正确回答 `PM=pnpm`（仅注入文本含该事实）。
- 验收命令与产物：备份 `.tmp/codex-config-backup-pre-n15.toml`（安装前后 SHA256 `F38D526F…` 一致）；安装 `codex plugin marketplace add D:\projects\harnmem && codex plugin add harnmem@harnmem-marketplace`。

## 9. Desktop 与 hook 信任流真机验证（2026-10-29）

- **信任仪式在 CLI TUI，不在 desktop**：desktop（ChatGPT.exe，MSIX `OpenAI.Codex 26.1023.6123.0`，壳内引擎 0.165.0-alpha.1.2）对未信任 hook **静默跳过且无任何 UI 提示**——新会话 rollout 无 `hooks.additional_context`，设置→编码→钩子页显示"未找到钩子"（刷新无效），插件详情页可看钩子声明但无信任入口。CLI 裸 TUI（0.165 需 `--no-daemon`）启动即弹 **"Hooks need review — 1 hook is new or changed"**，三选项 Review hooks / Trust all and continue / Continue without trusting；Review 视图给出事件矩阵（8 事件 × Installed/Active/Review 列）并再次警告 SessionEnd mcp_tool 不支持；详情页显示 `MCP Server harnmem / MCP Tool memory_context / Timeout 600s / Trust: Trusted`（**Timeout 默认 600s**）。
- **信任持久化 = config.toml 的 `[hooks.state]` 表**（CLI/desktop 共享同一 CODEX_HOME）：

  ```toml
  [hooks.state."harnmem@harnmem-marketplace:plugin.json#hooks[0]:session_start:0:0"]
  trusted_hash = "sha256:478a…"
  trusted_content_hash = "sha256:905a…"
  ```

  键形 `<plugin>@<marketplace>:plugin.json#hooks[<i>]:<event>:<n>:<n>`，双 sha256 基线（声明结构 + 内容）。
- **信任后的行为（决定性验证）**：`codex exec` 不带 bypass 旗标 → stderr `hook: SessionStart … Completed`，rollout 注入 marker ✓；**desktop 无需重启**，新会话（originator `Codex Desktop`，cwd `~/Documents/Codex/<date>/…`）SessionStart hook 执行、developer message 注入用户级 pinned 快照 ✓。注入不含 project 作用域记录属正确语义（cwd 不同 shard）。
- 0.165 事件矩阵全集：`PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit`（TUI Review 视图展示；此前二进制枚举的 14 个含 Subagent*/Stop/Interrupt，TUI 未列出）。
- 驱动 desktop UI 的坑（自动化参考）：UIA 后台 invoke 全部无效（必须 foreground）；composer 对合成输入极不友好——剪贴板粘贴只落首字符、type_text 需逐字符且慢，回车发送可靠；TUI alt-screen 使行缓冲终端无法读屏（验证一律走 rollout 数据面）。
- 版本注意：桌面自动更新会**删除旧引擎目录**（0.164 的 bin 路径一夜失效），脚本一律引用全路径并容忍 hash 目录名变化。

## 附录：探针产物与可复现命令

- 探针（保留）：`.tmp/codex-probe/`（marketplace.json + plugin：`.codex-plugin/plugin.json`、`.mcp.json`、`server.mjs`（零依赖 ESM MCP stdio，含 probe-log.jsonl 证据日志）、`skills/harnmem-probe/SKILL.md`）。
- 安装前 config 备份：`.tmp/codex-config-backup-20261028.toml`；探针已卸载，config.toml 实测还原一致。
- 复现：

```powershell
codex plugin marketplace add D:\projects\harnmem\.tmp\codex-probe
codex plugin add harnmem-probe@harnmem-probe-market
codex exec --skip-git-repo-check --sandbox read-only -m gpt-5.6-terra "Reply with exactly: ok"
# 证据：cache 内 probe-log.jsonl（MCP 握手+hook 调用）；rollout 内 hooks.additional_context
codex plugin remove harnmem-probe@harnmem-probe-market
codex plugin marketplace remove harnmem-probe-market
```

## 10. N16 收尾：UserPromptSubmit 探针与 backfill 抽取通道（2026-10-29，v0.2.0）

- **`UserPromptSubmit` mcp_tool hook 完全支持**（0.165 探针真机实证）：每次用户提交 prompt 都会调用工具，threadId 与 SessionStart 相同；同一 turn 内注入顺序 = SessionStart 探针 → harnmem 快照 → UserPromptSubmit 探针（rollout 出现多条 `hooks.additional_context` developer message），派发顺序 SessionStart → UserPromptSubmit → turn。**但设计上不用于注入**：工具返回文本每 turn 累积注入，破坏字节稳定与 KV 缓存。v0.2 插件未声明该事件。
- **抽取通道方案 A（SessionStart 延迟补录，backfill）**：因 SessionEnd mcp_tool 在 0.164/0.165 均被跳过，插件在每次 `memory_context` 开头扫 `~/.codex/sessions`（今/昨/前天）找比游标新的 rollout（`findRecentRollouts`，排除当前 thread），逐个写 payload spawn detached worker；worker 以 `reason:"backfill"` 调 `sessionEnd` 写 journal，并推进持久游标 `<home>/state/codex-backfill-marker.json`（`{lastFile,ts}`，rollout 文件名字典序比较，只前进）。效果：上一会话的 transcript 总会被补录；`autoExtract` 默认关时仅 journal（审计+数据面就位），开启后 core 的 LLM 抽取在 journal 上运行。
- **真机验证**（用户真实 store `~/.harnmem`）：一次 memory_context 将队列中 5 个历史 rollout（含 desktop 会话与 CLI exec 会话）全部补录为 `sessions/<YYYYMMDD>/codex_<threadId>.jsonl`；二次调用零新增（幂等），marker 收敛到最新 rollout 且只前进；detached worker 全部消费 payload（无残留）。
- **实现要点**：`payload.harnmemHome` 显式 pin store home——detached worker 不一定继承服务器 env（`HARNMEM_HOME` 可能丢失），session cwd 也可能解析到别的项目配置；disabled-skip 与 backfill 成功路径都要推进游标，否则每个新会话都重复排队同一批 rollout。
- **信任基线含插件内容**：修改插件源文件后 `trusted_content_hash` 失配，hook 回到未信任状态被静默跳过，需在 TUI 重新信任（本地 marketplace 源目录形态开发时尤其注意）。
