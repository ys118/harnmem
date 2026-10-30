# Cursor 插件调研：cursor-harnmem 落地路径（2026-10-29 调研 / 2026-10-30 真机修订）

> 调研性质：第一轮为**网络调研**（2026-10-29，hooks / MCP+rules+扩展 API / CLI+数据面+生态 三路并行）；
> 第二轮为**本机第一手真机探针**（2026-10-30，Cursor desktop **3.27.22**，Windows 11；GUI 经 cua-driver 驱动，
> 探针工作区 `D:\projects\harnmem\.tmp\cursor-probe\ws`，用户级 `~/.cursor/hooks.json` + `~/.cursor/mcp.json`，
> 对话模型 `cursor-grok-4.6-medium`）。证据分级：【V】=官方文档/changelog/官方员工论坛回帖；【S】=半官方
> （员工发言）；【B】=第三方用户实测/bug 报告；【U】=第三方一致但无官方确认；**【M】=本机第一手实测
> （2026-10-30，Cursor 3.27.22 desktop，Windows 11）**。文中"原结论（2026-10-29）"均指第一轮网络调研结论，
> 保留对照便于理解演进。

结论先行：**cursor-harnmem 技术路线仍可行；此前判为"最大短板"的抽取层已真机闭环，但注入通道与分发形态
被实测显著修正**：

1. **注入层：`sessionStart` 的 `additional_context` 在 3.27.22 仍被丢弃；实际可用的是未文档化的
   `beforeSubmitPrompt` 扁平 `additional_context`【M】**。官方把 `{continue, user_message}` 列为该
   事件的输出 schema；适配器实现为**每个 conversation 首条 prompt 注入一次**（KV-cache 友好），
   `afterAgentResponse` 确认成功、失败重试时重新注入，并保留 `.cursor/rules/*.mdc`
   （`alwaysApply:true`）100% 生效的兜底【M】。
2. **抽取层：IDE transcript 与 CLI 同构，`sessionEnd` 触发时 `transcript_path` 有值，可直接解析【M】**。
   路径为 `%USERPROFILE%\.cursor\projects\<encoded-cwd>\agent-transcripts\<conversation-uuid>\<conversation-uuid>.jsonl`，
   行格式已知（无 tool_use/tool_result/thinking）；`sessionEnd` + detached 子进程即可覆盖事后抽取，
   sqlite 路线维持放弃。
3. **分发形态被修正：插件主要承担 rules + mcp.json 载体，hooks 由安装脚本写入用户级配置【M】**。
   可靠 hooks 通道 = 用户级 `~/.cursor/hooks.json`（保存即热重载【M】）与项目级 `.cursor/hooks.json`
   （需 trusted workspace）；**完整重启后本地插件 `hooks/hooks.json` 也可能以 `claude-plugin
   config` 身份被调度**，与用户级 hooks 同时执行（§2.7），因此必须做 exclusive claim 去重。
   分发 = 插件（rules + MCP）+ 安装脚本读-合并-写用户级 hooks.json。

**探针资产（可复现）**：脚本 `D:\projects\harnmem\.tmp\cursor-probe\hook.mjs` / `hook-v3.mjs` /
`hook-v4.mjs`（记录载荷、按事件注入标记串）；事件日志 `%TEMP%\harnmem-cursor-probe\events.jsonl`；
Cursor hooks 日志 `%APPDATA%\Cursor\logs\<ts>\window*/output_*/cursor.hooks.workspaceId-*.log`
（含 INPUT/OUTPUT JSON 与退出码）【M】。标记串：`S1-HMP-AAA`（sessionStart 注入）、
`S2-HMB-BBB`（beforeSubmitPrompt 注入）、`HMR-2B8D-11`（rules 注入）。

生态现状：Cursor 上的第三方记忆产品（mem0/OpenMemory、Supermemory、basic-memory、Cognee、mimir、memex）
**清一色 MCP-only（judgment-gated，靠 agent 自觉调用）**；Cursor 内建 Memories 已随 2.1.x 移除（无官方公告）。
"hooks 确定性注入 + 捕获"仍是市场空白带，正是 harnmem 的差异化位置。

---

## 1. Cursor 扩展面全景（与 Claude Code / Codex 对照）

| 维度 | Claude Code | Codex | Cursor（2026-10-30 真机修订） |
|---|---|---|---|
| 插件体系 | marketplace→plugin | marketplace→plugin（.agents/plugins） | `.cursor-plugin/` 目录 + marketplace【V】；**desktop 3.27.22 本地插件只加载 rules 与 mcp.json，hooks/hooks.json 不进入 hooks 引擎**【M】（推翻，见 §2.5）；CLI `--plugin-dir` 可加载插件 hooks【B，本轮未复核】 |
| 注入通道 | SessionStart command hook→additionalContext | SessionStart mcp_tool hook→developer message | **`beforeSubmitPrompt` 返回扁平 `{additional_context}`，每轮注入生效（未文档化）**【M】；`sessionStart` 触发但 additional_context 被丢弃【M】（推翻，见 §2.2）；兜底 `.cursor/rules/*.mdc` alwaysApply 100% 生效【M】 |
| 抽取通道 | SessionEnd detached 子进程 | 同（1s/3s 超时内 spawn） | `sessionEnd` fire-and-forget（无注入），输入 `transcript_path` 实测有值【M】；IDE transcript 与 CLI 同构【M】（见 §4.1）；sqlite 逆向仍不依赖 |
| 工具面 | 插件 .mcp.json（stdio） | .mcp.json（env_vars 白名单） | 插件 `mcp.json` 注册为 `plugin-<plugin>-<server>`、`${CURSOR_PLUGIN_ROOT}` 展开【M】；用户级 `~/.cursor/mcp.json` 热加载可用【M】；**项目级 `.cursor/mcp.json` 对本版本 agent 不可用（server_not_found）**【M】（推翻，见 §5） |
| 规则面 | CLAUDE.md/skills | AGENTS.md/skills | `.cursor/rules/*.mdc`（必须 .mdc 后缀）+ AGENTS.md 嵌套【V】；本轮补：工作区与插件 `rules/` 的 alwaysApply 均 100% 可见、每轮带上【M】 |
| 安装 | `/plugin marketplace add` | `codex plugin marketplace add` | marketplace / `~/.cursor/plugins/local/<name>` + Reload Window【V+M】；hooks 需安装脚本合并 `~/.cursor/hooks.json`【M】；deeplink（MCP）/ 项目级三件套兜底 |
| 会话锚定 | session_id | threadId | 全部 hook 事件 `session_id` 与 `conversation_id` 同值【M】；transcript 路径含 conversation uuid【M】 |

## 2. Hooks 机制（注入层核心）

### 2.1 体系与事件

- 官方一等公民【V】：agent 生命周期事件→派生进程，stdio 双向 JSON；`hooks.json` 保存热重载。
  1.7（2025-09）beta → 2.0 企业云分发 → 2.1（2025-11）项目级；现行文档无 beta 标注。
- 事件 21 个，harnmem 相关【V】：`sessionStart`、`sessionEnd`、`preToolUse`、`postToolUse`、
  `subagentStart/Stop`、`beforeSubmitPrompt`（**仅交互 TUI，headless `-p` 跳过**【B】deja-vu 实测）、
  `preCompact`（观察 only）、`stop`/`subagentStop`（`followup_message` 非空即自动续跑，`loop_limit`
  默认 5）、`afterAgentResponse/Thought`、`workspaceOpen`、`beforeMCPExecution/afterMCPExecution`
  （matcher 写 `MCP:<tool_name>`）。命名小写驼峰（区别于 Claude 的 `SessionStart`）。
- 配置四级优先【V】：Enterprise MDM（Windows `C:\ProgramData\Cursor\hooks.json`）→ Team 云分发 →
  项目 `.cursor/hooks.json`（需 trusted workspace）→ 用户 `~/.cursor/hooks.json`。
  - **实测（M）**：用户级 hooks.json 保存即生效、无需重启；日志每个窗口打印
    `Loaded N user hook(s) for steps: ...`，执行记录带来源（`from user config` / `from claude-plugin
    config`），**没有任何本地插件来源**——这是判断插件 hooks 是否被加载的现场证据（见 §2.5）。
  - 文档第五来源"插件自带 hooks/hooks.json"【V】：desktop 3.27.22 实测不加载，见 §2.5。
  - 兼容加载 Claude Code `~/.claude/settings*.json` hooks、按精确命令字符串去重【B】：本轮未探。
- **Windows（M 复核）**：hook 经 PowerShell 运行、JSON 从 stdin 管入；`node` 在 PATH 上可直接用；
  用户级 hook 的运行目录实测为 `%USERPROFILE%\.cursor`（日志 `Running script in directory: ...`），
  脚本内不要依赖相对路径。缺 `.ps1/.bat/.cmd` 后缀自动补 `.ps1`【V】。
- 每脚本选项：`timeout`（秒）、`matcher`（正则）、`loop_limit`、`failClosed`（默认 false）。

### 2.2 输出语义（2026-10-30 实测修订）

- 退出码 0=解析 stdout JSON；2=block（Claude 兼容）；其它 fail-open（除非 `failClosed:true`）【V】。
- **`sessionStart`：注入通道被实测推翻【M】**。
  - 文档语义【V】：fire-and-forget；输出 `{env, additional_context}`，additional_context 进"会话初始
    系统上下文"；无官方大小上限【U】。
  - **实测（M，3.27.22 desktop，新会话两轮）**：事件确实触发；载荷为精简会话标识（`session_id`、
    `conversation_id`、`cwd`、`cursor_version`、`composer_mode` 等，`transcript_path` 为 `null`），
    不含可注入字段；hook 返回 `{"additional_context":"…S1-HMP-AAA…"}` 被日志记为有效响应
    （`Merged 1 valid response(s)`），但模型的 thought 与最终回答**都看不到该标记**——注入被丢弃。
  - > **原结论（2026-10-29）**：该通道 2026-04 被官方确认时序 bug 丢弃，但第三方在 3.8.11 回归
    > PROVEN，故"3.8.x 起大概率可用 + rules 兜底"；**实测修正（M）**：3.27.22 desktop 上仍丢注入，
    > "已恢复"不成立于本版本。结论：sessionStart 只可用于会话开始锚定/探针日志，**不可作注入通道**。
- **`postToolUse` 的 additional_context 不可依赖**【S+B】：官方员工确认非 MCP 工具 fire-and-forget
  丢弃响应；论坛 10 形态探针测到 3.10.17（2026-07）仍不达模型（forum/raw/155689）。仅 CLI
  v2026.10.17 起匹配 Task 工具的 postToolUse 在子代理结束时触发且 additional_context 达主 agent
  （官方 CLI changelog）。IDE 端同等修复未见公告【U】。**本轮未探（M-pending），列为下一轮探针项**。
- `sessionEnd`【V+M】：`reason: completed|aborted|error|window_close|user_close`；响应仅记日志，无注入。
  实测（M）：触发，`reason=user_close`、`final_status=completed`、`duration_ms` 有值、
  **`transcript_path` 有值**——抽取入口确认（见 §8）。
- `stop`【V+M】：`status: completed|aborted|error`、`loop_count`、usage、`transcript_path`；实测每轮触发，
  可作后续增量 journal 的挂点。
- `preToolUse`【V】：`permission: allow|deny`（`ask` schema 接受但未生效）+ `updated_input`（可改写
  工具入参）。可阻止事件还有 `beforeShellExecution`/`beforeMCPExecution`（allow|deny|ask）、
  `beforeReadFile`（输入含文件全文）、`beforeSubmitPrompt`（`continue:false`）；`preCompact` 不可阻止。

### 2.3 beforeSubmitPrompt：实际可用的注入通道（M）

- 定位：每次提交 prompt 前触发，等价 Claude Code 的 `UserPromptSubmit`（`continue:false` 可拦截）。
- 实测载荷（M）：`conversation_id`、`generation_id`、`model`、`model_id`、`model_params`、
  `composer_mode: "agent"`、`prompt`、`attachments: []`、`session_id`、`hook_event_name`、
  `cursor_version`、`workspace_roots`、`transcript_path: null`（提交时 transcript 尚不存在）、
  `user_email`（PII，禁止落盘）。`transcript_path` 为 null 时 transcript 路径从 env
  `CURSOR_TRANSCRIPT_PATH` 或 sessionEnd 载荷取（§4.1）。
- 实测输出（M）：返回**扁平** JSON `{"additional_context":"Injected context. Token S2-HMB-BBB."}`，
  **同一轮**的模型 thought 与最终回答中都出现了该 token（v4 隔离跑，多轮复现）；即每轮提交都可注入。
- 与官方 schema 的偏差【V+M】：官方只把 `{continue, user_message}` 列为该事件输出，`additional_context`
  **未文档化**——可用但无兼容承诺，属灰度面；实现必须配 rules 兜底与版本回归探针。
- 限制：headless `-p` 会跳过 beforeSubmitPrompt【B】，CI 场景不能依赖本通道；是否需同时返回
  `continue: true` 未验证（探针只返回 additional_context 即生效）；大小上限未知（见 §10 I5）。

### 2.4 探针实测事件载荷一览（M）

除特别标注外，均为用户级 `~/.cursor/hooks.json` 命令 hook 收到的真实载荷（2026-10-30）。

| 事件 | 实测载荷要点 | 适配器用途 |
|---|---|---|
| `sessionStart` | 会话标识 + `cursor_version`；`transcript_path: null`；additional_context 被丢弃 | 会话锚定、探针日志（**不做注入**） |
| `beforeSubmitPrompt` | 见 §2.3；`transcript_path: null` | **注入主通道** |
| `preToolUse` | `tool_name`（`Read`/`Grep`/`Shell` 等；MCP 调用为 `MCP:<tool>`）、`tool_input`、`tool_use_id`（可能含换行，解析需容错） | 工具审计 |
| `postToolUse` | 同 preToolUse 的 id 字段 + `tool_output`（JSON 字符串；`Read` 只给 `content_length`，`Grep` 给 `{pattern, success}`）、`duration` | 审计 |
| `beforeReadFile` | `file_path` + 文件全文 `content` + `attachments` | 注意体积与 PII |
| `afterAgentResponse` | `text`（最终回答）+ token 用量字段 | 备选抽取 |
| `afterAgentThought` | `text`（聚合 thinking）+ `duration_ms`；**同一 thought 触发两次**（其中一次 `generation_id` 带 `-0-xxxx` 后缀），需按 (`generation_id`, `text`) 去重 | 备选，避免重复 |
| `stop` | `status`、`loop_count`、usage、`transcript_path` | 增量抽取备选 |
| `sessionEnd` | `reason`、`duration_ms`、`is_background_agent`、`final_status`、`transcript_path`（**有值**） | **抽取主入口** |
| `workspaceOpen` | 每窗口/文件夹切换触发一次 | 会话锚定 |
| 未触发（本轮） | `preCompact`、`subagentStart/Stop`、`before/afterShellExecution`、`before/afterMCPExecution`、`afterFileEdit` | 事件存在性与载荷待专项探针 |

补记（M）：所有事件 `session_id` 与 `conversation_id` 同值，可作会话关联键；`afterAgentThought`
重复触发必须去重，否则 journal 会重复记账。

### 2.5 插件 hooks 的真实加载机制（源码 + 日志双证，M）

- `~/.cursor/plugins/local/<name>` 本地插件**只加载 rules 与 mcp.json**；`hooks/hooks.json` 不进入
  hooks 引擎——native Cursor 格式与 `.claude-plugin` 格式都一样【M】。现场证据：hooks 日志列出
  `Loaded N user hook(s) for steps: ...`、执行记录只有 `from user config` 与 `from claude-plugin
  config` 两种来源，无 `local`/插件来源；插件 rules 标记串可见，而插件 hooks 标记串从未出现。
- workbench 源码路径（M，解包观察）：`loadPluginHooks()` 先判 `isClaudeCodeHooksEnabled()` 与实验开关
  `enable_cc_plugin_import`，再取 `pluginsProviderService.getPluginHooks()`（extension-host RPC，
  只覆盖 provider 认识的已安装插件）——本地插件不在其中，因此 hooks 不被调度。
- 已安装的 **Claude 格式插件**（`%USERPROFILE%\.claude\plugins\cache\...`）的 hooks 会以
  source `claude-plugin` 执行：实测 `sessionStart` 与 `sessionEnd` 均命中
  （日志 `Executing hook 2/2 from claude-plugin config`，命令指向该插件的 `hooks/hook.mjs`）。
  即 Cursor 的 Claude 插件导入通道会运行第三方插件 hooks，但该通道受实验开关门控、且只对
  Claude 插件生态的安装形态生效，**不是 `.cursor-plugin` 插件能力**，不宜作为 cursor-harnmem
  主分发路径（可作兼容/实验选项，见 §9）。
- > **原结论（2026-10-29）**：插件自带 `hooks/hooks.json` 属四级配置末级来源；`cursor-agent
  > --plugin-dir` 实测可加载插件 hooks（2026.09.02【B】）。**实测修正（M）**：desktop 3.27.22 下本地
  > 插件 hooks 不加载（`--plugin-dir` 是 CLI 侧另一条加载路径，本轮未复核，不能互相外推）。
- **结论（M）**：desktop 3.27.22 可靠 hooks 通道 = 用户级 `~/.cursor/hooks.json`（保存即热重载）
  + 项目级 `.cursor/hooks.json`（需 trusted workspace，见 §2.6）。插件只带 rules + MCP；
  hooks 由安装脚本读-合并-写进用户级 hooks.json（§9）。**注意：完整重启 Cursor 后，本地插件的
  `hooks/hooks.json` 也可能以 `claude-plugin config` 身份被调度**（§2.7 验收补充），因此同一事件
  可能有两条 hook 记录，适配器必须按事件做独占去重。
- 容错（M）：Claude 插件 hook 在无 shell exec 上下文时会抛 `Error: MainThreadShellExec not
  initialized`（实测 sessionEnd 在某窗口复现，该次 hook 未执行）——安装脚本与适配器必须容错
  （重试/降级到 rules），不能假定每个窗口、每次会话结束都能跑 hooks。

### 2.7 cursor-harnmem 真机验收补充（2026-10-30，M）

实现落地后在同一台机器（Cursor desktop 3.27.22，Windows 11，真实 `~/.harnmem` store）做了两次
端到端验收，补充/修正如下：

- **插件 hooks 的可执行性取决于启动方式**：仅 *Developer: Reload Window* 时本地插件 hooks 不被
  调度；**完整重启 Cursor 后** hooks 日志出现 `Found 2 hook(s)` / `Executing hook 2/2 from
  claude-plugin config`，命令指向 `~/.cursor/plugins/local/harnmem/hooks/hook.mjs`
  （`${CURSOR_PLUGIN_ROOT}` 展开）。即用户级 hooks.json 与插件 hooks 会**同时**执行同一事件，
  响应被 `Merged 2 valid response(s)` 合并 → 适配器必须以 `conversation_id + generation_id`
  做独占占位（exclusive claim），否则会重复注入/重复 journal（pre-fix 实测 session journal
  6 行 = 3 条消息各重复两次）。
- **注入确认通道**：`afterAgentResponse` 载荷带 `conversation_id`/`generation_id`/`text`/usage，
  可用于给"注入成功"打标（marker 从 `pending` 转 `confirmed`）。模型首轮失败（如
  `Model unavailable on Free`）时不会触发 afterAgentResponse，重试（新 generation）可重新注入；
  这修正了"写一次 marker 就不再注入"导致的失败后无上下文问题。
- **注入落点与体积**：首条 prompt 时 `beforeSubmitPrompt` 注入真实生效（模型在 thought 中引用
  注入的记忆标记串，并继续调用 `memory_status`）；实测快照 5.9–6.0KB / 22 条记忆仍可注入。
- **MCP**：插件 `mcp.json` 注册名 `plugin-harnmem-harnmem`，模型以
  `GetDynamicTools({namespace, toolName})` 调用五个 memory 工具，无需人工批准，结果正常回灌。
- **journal（抽取产物）**：`~/.harnmem/sessions/<YYYYMMDD>/cursor_<conversation-id>.jsonl`
  （detached 子进程写），去重后一条消息一行；会话关闭后 1–2 秒内出现。
- **安装器**：读-合并-写 `~/.cursor/hooks.json`（写前 `.bak-<ts>` 备份），三事件
  `beforeSubmitPrompt`(timeout 20) / `afterAgentResponse`(10) / `sessionEnd`(10)，`failClosed:false`；
  `--dry-run`/`--uninstall`/`--mcp-user` 可选；真实文件带 UTF-8 BOM，读取时必须 strip。

### 2.6 计划门控 / 信任 / 超时

- 无 Pro/Business 门控说明（1.7 起面向所有用户；免费档未明示【U】）。Enterprise 专属：云分发、
  MDM、"Block until hooks are ready"。
- **Workspace Trust 默认关闭**【V】：官方安全文档原话 trust disabled by default
  （`"security.workspace.trust.enabled": true` 才开启，MDM 键 `WorkspaceTrustEnabled`）→ 默认配置下
  克隆仓库的项目 hooks 无提示即可运行（便利也是安全考量）。CLI headless 在不受信工作区直接失败需
  `--trust`/`--force`。无 per-hook 首次批准机制。
- 超时【V+M】：`timeout` 单位秒、缺省 platform default 未公布；社区观测 IDE 默认约 1 分钟；CLI
  Windows 调过低会让 deny hook 静默失效。**建议显式设 15–30s**（实测 `timeout: 20` 在日志中呈现
  `Running hook 1 with timeout 20000ms`，单位确认为秒）。

## 3. CLI（cursor-agent / `agent`）

- **Windows 安装**【V】：`irm 'https://cursor.com/install?win32=true' | iex`；验证 `agent --version`；
  更新 `agent update`（默认自动更新）。**无官方 npm 包**（第三方安全分析明确）。官方文档二进制名
  `agent`，社区实测 `cursor-agent` 并存。当前 v2026.10.x 日期版本号。
- **Headless**【V+B】：`agent -p`（print，CI/脚本）；`--output-format json|text|stream-json`；
  `--mode=plan|ask`、`--force`；`--resume <thread id>`/`agent ls`。**`-p` 下 sessionStart hook
  照常触发**（entireio 2026-10-22 实测）——CI 化探针可行；但 beforeSubmitPrompt 在 `-p` 下被跳过
  【B】，CI 注入需另寻（rules 或 postToolUse，均待验证）。
- **认证**【V+B】：`agent login`（OAuth，`NO_OPEN_BROWSER=1` 只打 URL）或 **`CURSOR_API_KEY`**
  （Dashboard 生成；**Free Plan 即可用于 headless**，GitGuardian 文档，权威性较高）。探针验证无需付费。
- **开发回路**【B】：`cursor-agent --plugin-dir` 实测加载插件 hooks（sessionStart/preToolUse/
  postToolUse/sessionEnd 全到达，2026.09.02）——**即改即用，优于 codex 侧**。
  - 注意（M）：这与 desktop 本地插件 hooks 不加载是**两条不同的加载路径**，desktop 结论不能外推到
    `--plugin-dir`，反之亦然；cursor-harnmem 若同时支持 CLI，需各做一次插件 hooks 探针。
- `agent acp`：以 ACP server 运行（stdio JSON-RPC）【V】。
- 本轮真机探针只覆盖 desktop GUI，CLI 未复核；§3 其余结论沿用 2026-10-29 调研。

## 4. 会话数据面（抽取层输入）

### 4.1 会话 transcript（IDE 与 CLI 同构，推荐主通道）

- 路径【B 旧 → M 实测确认】：`%USERPROFILE%\.cursor\projects\<encoded-cwd>\agent-transcripts\
  <conversation-uuid>\<conversation-uuid>.jsonl`。IDE 与 CLI 同构。
- cwd 编码（M）：绝对路径小写、盘符冒号去掉、路径分隔符与路径中的点号折算为单个 `-`。实测样例：
  `D:\projects\harnmem\.tmp\cursor-probe\ws` → `d-projects-harnmem-tmp-cursor-probe-ws`
  （注意 `.tmp` 的 `.` 不保留）。构造路径只作兜底，优先用 hook 给的 `transcript_path`。
- 获取路径优先级（M）：`sessionEnd`/`stop` 等 hook 输入的 `transcript_path`（有值）→ env
  `CURSOR_TRANSCRIPT_PATH`（与 payload 同值，payload 为 null 时仍可能可用）→ 按 encoded-cwd +
  conversation_id 构造（实现期按真实样本回归）。
- 行格式（M，实测三种行）：
  ```json
  {"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Friday, Oct 30, 2026, 4:22 PM (UTC+8)</timestamp>\n<user_query>\n…\n</user_query>"}]}}
  {"role":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
  {"type":"turn_ended","status":"success"}
  ```
  解析要求（M）：user 文本必须剥离 `<timestamp>…</timestamp>` 与 `<user_query>…</user_query>` 包裹；
  忽略 `turn_ended` 控制行；`content[]` 按数组通用处理；**无 `tool_use`/tool result/thinking/
  独立 timestamp 字段**——抽取只基于对话文本，必要时提示模型用 `memory_write` 补写（与 codex 侧
  SessionEnd 缺位时的降级策略一致）；未知行类型忽略不报错。
- subagent（B，沿用 CLI 结论，本轮未探）：`…/<parent>/subagents/<child>.jsonl`，目录表父子关系。
  工具名映射【B】：`path` 而非 file_path、`Shell` 而非 Bash、`StrReplace`、`Write.contents`；
  IDE transcript 实测无工具块，该映射仅在 CLI JSONL 出现工具块时使用。
- 第二存储【B】：`~/.cursor/chats/<md5(cwd)>/<chat-uuid>/meta.json`（含 cwd）+ `store.db`
  （表 `blobs(id,data)` 内容寻址 protobuf，tool result 只在那里有）。两布局同版本并行写入。
- 官方推荐实时捕获 = `agent -p --output-format stream-json` + hooks【V】。
- > **原结论（2026-10-29）**：transcript_path 仅在 CLI 侧确认，IDE 端行为未验证、是"第一验收项"；
  > **实测修正（M）**：IDE 端路径、行格式、`sessionEnd` 取值全部实证，抽取层不再是最大短板。

### 4.2 IDE 本地存储（保持不推荐）

- 现代（Cursor 3.x）集中单库【B·txcript 逆向，3.16/3.17.8 实测 2026-09】：
  `%APPDATA%\Cursor\User\globalStorage\state.vscdb`（SQLite）。表：`composerHeaders`（会话索引：
  composerId/workspaceId/createdAt/value JSON 含 name、workspaceIdentifier.uri.fsPath）、
  `cursorDiskKV`（`composerData:<id>` `_v17` 含 `fullConversationHeadersOnly`；`bubbleId:<cid>:<bid>`
  `_v3`：type 1=user/2=assistant、text、toolFormerData（工具结果）、tokenCount）、`ItemTable`。
  聊天文本明文；`agentKv:blob:*` 与附件加密不可解。workspace 反查 `workspaceStorage\<hash>\workspace.json`。
  实测旁证（M）：项目级 MCP 注册信息只在这个库里记 `mcpService.knownServerIds`；agent catalog 走
  `~/.cursor/projects/<encoded-cwd>/agent-tools/<uuid>.txt`、`…/mcps/<server>/tools/<tool>.json`
  + `SERVER_METADATA.json`。
- **脆弱性高，勿作主通道**：无公开规范；`_v` 递增；**三种存储 regime 并存演化**（社区三份实测互相
  矛盾：bridge 2026-05 云归档 / moollm 2026-08 Agent 会话 JSONL-only / txcript 2026-09 全在单库）；
  官方 UI 导出自 2026-01 起摘要化（thinking/工具块有意排除，官方确认 no ETA）。社区工具
  （cursor-chat-browser、deja-vu、txcript、CursorDump、moollm、cursor-chats-bridge 等十余个）全部
  处于持续跟版状态。
- 2026-10-30 实测：transcript JSONL 已可直接解析，本轮完全没有走 sqlite；**"勿作主通道"结论不变**。
- 稳定面排序：**hooks（schema 公开）> CLI stream-json > JSONL transcript 路径约定 > SQLite 逆向**。

## 5. MCP 配置面（工具层）

- 配置【V】：项目 `<project>/.cursor/mcp.json`、全局 `~/.cursor/mcp.json`；顶层 `mcpServers`；
  stdio `{type:"stdio", command, args, env, envFile}`；remote `{url, headers}`。3 种 transport
  （stdio/SSE/Streamable HTTP）。**变量插值**：`${env:NAME}`、`${userHome}`、`${workspaceFolder}`、
  `${pathSeparator}`——`command` 可写 `node "${env:HARNMEM_HOME}\..."` 类路径。
- **实测（M，3.27.22）三形态结论：项目级不可用 / 用户级可用 / 插件级可用**：
  - 项目级 `<ws>/.cursor/mcp.json`：**对 agent 不可用**。写入后 Cursor 只在 `state.vscdb` 记
    `mcpService.knownServerIds = ["project-0-ws-harnmem-probe"]`，agent 的 MCP 目录里没有该 server，
    模型调用报 `server_not_found` / `MCP server does not exist`；hooks 仍能看到调用尝试（`MCP:<tool>`）。
  - 用户级 `~/.cursor/mcp.json`：**可用**。写入后约 4 秒生效（无需重启），stdio 调用成功、
    **无审批弹窗**；工具目录出现 `user-<server>`。
  - 插件 `mcp.json`：**可用**。注册为 `plugin-<plugin>-<server>`（实测 catalog 出现
    `plugin-harnmem-harnmem`，即已装 Claude 插件 harnmem 的 MCP 被加载）；`${CURSOR_PLUGIN_ROOT}`
    与 `${CLAUDE_PLUGIN_ROOT}` 在 `command`/`args`/`env`/`cwd` 中展开，Agent Plugins 标准的
    `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` 不展开。
  - > **原结论（2026-10-29）**：项目级 mcp.json 可用但需用户弹窗点 enable；**实测修正（M）**：本版本
    > 即使写入注册也不可达，cursor-harnmem 不要依赖项目级 MCP。
- **审批**【V+M】：文档称默认所有 MCP 工具调用前需用户批准、1.7.2 起 MCP auto-run；实测用户级
  stdio server 调用**无弹窗**直接成功（M）——旧"默认需批准"结论不适用于本版本的 stdio 用户级场景；
  Enterprise allowlist/auto-run 设置差异仍在【V】。CLI 批准 `cursor-agent mcp enable`，逐会话
  `--skip` 不持久。
- **工具数上限**【S/B/U】：口径演变 25（2025-02 员工）→40（2025-03 员工引 docs）→80（2025-11 员工
  Dean Rie）；现行官方文档不写明。**按 ≤25 设计最安全**。分页 tools/list 只注册第一页的 bug 至
  2026-09 未修——**服务器须一次性返回全部工具**。
- 工具呈现【V+M】：hooks matcher 官方语法 `MCP:<tool_name>` 暗示命名；失败按服务器隔离，不拖垮会话；
  实测 MCP 调用在 preToolUse/postToolUse 的 `tool_name` 中即以 `MCP:<tool>` 出现。
- 分发辅助【V】：deeplink 一键安装 `cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64`；
  Enterprise Dashboard 团队分发。插件安装后本地插件目录为 `~/.cursor/plugins/local/<name>`（§9）。

## 6. Rules / AGENTS.md / 扩展 API / 子代理

- **Rules**【V】：四类——Project Rules（`.cursor/rules/`，**必须 `.mdc` 后缀，纯 `.md` 被忽略**）、
  User Rules（全局）、Team Rules（1.7 dashboard）、AGENTS.md（根+子目录嵌套，更具体者优先合并）。
  `.mdc` frontmatter：`alwaysApply:true` 总是注入（globs/description 被忽略）；`false`+`globs` 文件
  匹配附加；`false`+`description` agent 按描述智能拉取；皆无仅 @-mention。**注入时机：模型上下文
  开头，每个 agent turn 都带上**。单条建议 <500 行。优先级 Team→Project→User 合并、靠前优先；
  账号级 rules 云存储与本地 `~/.cursor/rules` 是两套【S】。legacy `.cursorrules` deprecated 仍在读。
- **实测（M）**：工作区 `.cursor/rules/*.mdc`（`alwaysApply:true`）与插件 `rules/` 的标记串
  `HMR-2B8D-11` 在模型 thought 与最终回答中 100% 可见、多轮稳定——这是 hooks 失效时的最终兜底，
  也是 cursor-harnmem 插件必须携带 rules 的原因。
- **扩展 API 只有两口**【V】（docs/extension-api，TS d.ts 实测）：`vscode.cursor.mcp.registerServer`
  / `unregisterServer`；`vscode.cursor.plugins.registerPath`/`unregisterPath`（运行时注册插件目录，
  自动发现 `rules/`、`skills/`、`agents/`、`commands/`、`mcp.json`、`hooks/hooks.json`）。**无读
  transcript、无通用上下文注入的扩展 API**（与 §2.5 实测的"插件 hooks 需 provider 认领"一致）。
- **子代理**【V】：`.cursor/agents/*.md`（兼容 `.claude/agents/`、`.codex/agents/`，同名 .cursor
  优先）；frontmatter name/description/model/readonly/is_background；子代理继承父代理全部工具含
  MCP。自定义命令 `.cursor/commands/[command].md`（1.6 起）。Custom Modes 已移除（2.1）。
- 内建 Memories 已随 2.1.x 移除（约 2025-11，无官方公告；docs 页 301 到 Rules）——**当前版本零
  原生竞争，"rules 是唯一原生持久化"**【U·多源一致】。

## 7. 生态与差异化

- **MCP-only 是行业默认**【B·各产品官方文档】：mem0/OpenMemory、Supermemory、basic-memory、Cognee、
  mimir、memex 在 Cursor 上全部只注册 MCP 工具，注入时机 judgment-gated（靠 agent 自觉）。
- **Memory Bank 模式**（rules 指示 agent 读记忆文件）在 Cursor 上本质 judgment-gated + 静态全量
  注入：`alwaysApply` 不保证 agent 执行读取动作；规则过长遵守率下降。【B·多源】
- **无任何第三方产品在 Cursor 上实现无 hooks 的动态会话记忆注入**；hooks 确定性注入是少数派
  （core-memory-kit、deja-vu、claude-mem）——**harnmem 的注入层恰是市场空白带**。
- 实测后的差异化微调（M）：确定性注入在 desktop 上并非"插件即插即用"，需要安装脚本写用户级
  `hooks.json`（§9）——这既是门槛（竞品少走这一步），也是安装 UX 成本（需向用户解释一次配置合并）。
  插件形态能自带的是 rules 静态兜底 + MCP 工具，动态注入仍靠 installer。
- 前车之鉴：claude-mem 的 Cursor installer 曾**整文件覆盖 hooks.json**——安装/卸载必须读-合并-写。
- 官方动向利好【V】：Dynamic Context Discovery（转录/命令输出落盘可搜索文件，2026-01）、
  Conversation search（跨会话索引 transcripts）、Team MCP servers（2026-10）——数据面在官方化。

## 8. cursor-harnmem 四层架构建议（2026-10-30 修订）

沿用 `docs/design/07-adapter-contract.md` 四层契约。相对 2026-10-29 版本的主要修订：
注入主通道换为 `beforeSubmitPrompt`、插件退化为 rules+MCP 载体、hooks 走安装脚本。

1. **Injection（注入）**：
   - **主通道（M）**：`beforeSubmitPrompt` command hook（`node "<install-dir>/hook.mjs" inject`）→
     stdout 扁平 `{"additional_context": <快照>}`（探针形态）。每轮触发；首轮注入完整快照，其后按
     字节稳定规则（start/resume/compact/write/day-rollover 重建）返回快照或 `{}`（0 字节规则：
     返回 `{}` 即本轮不注入）。
   - **不用的通道（M）**：`sessionStart` 只做会话开始锚定/日志，注入被丢弃，不再作为注入来源。
   - **兜底（M）**：`.cursor/rules/harnmem.mdc`（`alwaysApply: true`）——工具存在性 + 使用时机 +
     "若会话开头没有看到 HarnMem 记忆索引，先调 `memory_search` 补拉"；必须 `.mdc` 后缀、
     单条 <500 行；插件 `rules/` 同样被加载（M）。
   - **探针**：hook 把标记串写日志 + README 提供"问模型可见 token"验证法；rules token 也留探针。
     每个 Cursor 版本回归一次（I2 通道未文档化，可能变化）。
   - **预算**：注入大小上限未知（U），先按与 claude/codex 同量级的快照注入，实现期做 5k/10k/20k
     梯度验证（§10 I5）。
2. **Tools（工具）**：复用 claude-harnmem 零依赖 stdio MCP 形态（`mcp/mcp.mjs` + vendor core），
   5 工具 `memory_write/search/read/forget/status`。**主通道 = 插件 `mcp.json`**（实测加载，
   `${CURSOR_PLUGIN_ROOT}` 展开【M】）；**手动兜底 = 用户级 `~/.cursor/mcp.json`**（实测可用、
   无审批弹窗【M】）；**项目级不可用**（M，不要写）。`env` 显式传 `HARNMEM_HOME/HARNMEM_DISABLED/
   HARNMEM_READONLY`（Cursor 无 env 白名单机制，直接 env 字段 + `${env:...}` 插值）。工具总数
   5 ≪ 25 上限；MCP 调用在 hooks 中呈现 `MCP:<tool>`，可用于审计。
3. **Lifecycle（生命周期）**：
   - `sessionEnd` hook：无注入通道，spawn **detached** 抽取子进程后 hook 体立即退出（fire-and-forget）；
     输入含 `transcript_path`（实测有值）/`session_id`/`reason`/`final_status`/`duration_ms`（M）。
   - 抽取器解析 transcript JSONL（§4.1）：剥离 `<timestamp>/<user_query>` 包裹、忽略 `turn_ended`；
     无 tool_use/tool_result/thinking → 抽取仅基于对话文本，必要时提示模型用 `memory_write` 补写
     （同 codex 侧降级策略）。hook 失败/transcript 缺失时跳过并记日志，**不得阻塞或拖慢会话结束**。
   - 路径兜底链（M）：hook 输入 `transcript_path` → env `CURSOR_TRANSCRIPT_PATH` → encoded-cwd +
     conversation_id 构造。
   - `stop`（每轮触发，M）：后续可做增量 journal；`preCompact` 本轮未触发（U），若触发只记录
     "注入块需重建"标记。
   - 容错（M）：偶发 `MainThreadShellExec not initialized` 导致 hook 不执行 → 重试/降级 + rules 兜底。
4. **Config（配置）**：与 claude 侧同源——env > `~/.harnmem/config.json` > 项目 `.harnmem.json`；
   hook 进程由 Cursor 经 PowerShell 拉起、env 继承用户环境（无 codex 式白名单问题）；MCP 进程 env
   走 `mcp.json` 显式声明；hooks 载体只能是用户级/项目级 `hooks.json`（插件 hooks 不加载，M）。
   - **PII（M）**：hook 载荷含 `user_email`、`workspace_roots`、`prompt` 全文，transcript 含用户
     文本——探针日志、fixtures、文档示例一律脱敏（`<user>` 占位、`%USERPROFILE%` 代替真实 home
     路径），永不把真实邮箱/用户名/记忆内容写进仓库。

## 9. 打包与分发（2026-10-30 修订）

- `packages/cursor-harnmem/` 建议布局（修订版）：
  ```
  packages/cursor-harnmem/
  ├── .cursor-plugin/plugin.json   # name(必填)/description/version/author/license/keywords/logo/variables
  ├── rules/harnmem.mdc            # alwaysApply 兜底（实测 100% 生效；必须 .mdc）
  ├── mcp.json                     # mcpServers.harnmem → ${CURSOR_PLUGIN_ROOT}/mcp/mcp.mjs（实测展开）
  ├── hooks/hook.mjs               # 注入 + sessionEnd detached（安装脚本以绝对路径写入用户级 hooks.json）
  ├── hooks/hooks.json             # 仅作元数据/参考；desktop 3.27.22 不加载（M），不要指望它生效
  ├── lib/{engine,format,settings,transcript}.mjs   # engine/format/settings 近原样；transcript 重写
  ├── mcp/mcp.mjs
  ├── vendor/core/...
  └── scripts/vendor.mjs / install.mjs
  ```
- 插件目录规范【V】：`.cursor-plugin/plugin.json` 只有 `name` 必填；自动发现 `rules/`（`.md`/`.mdc`/
  `.markdown`）、`skills/<name>/SKILL.md`、`agents/`、`commands/`、`hooks/hooks.json`、`mcp.json`、
  根 `SKILL.md`。**实测（M）：自动发现里 rules 与 mcp.json 生效，hooks/hooks.json 不生效。**
- 多插件仓库：根 `.cursor-plugin/marketplace.json`（`name`、`owner`、`plugins[]` 的 `source`；
  解析找 `<source>/.cursor-plugin/plugin.json`）；marketplace 安装的插件优先于同名本地副本【V】。
  公开市场提交入口 cursor.com/marketplace/publish（人工审核、开源）【V】。
- 本地安装【V+M】：`~/.cursor/plugins/local/<name>`（真实目录；符号链接解析到插件目录外会被忽略）
  → 重启 Cursor 或 **Developer: Reload Window** → 在 **Customize** 确认；受企业开关
  "Allow Local Plugin Imports"（默认开）控制。安装后实测插件 rules + MCP 生效、hooks 不生效。
- **hooks 的唯一可靠通路 = 安装脚本（M）**。用户级 `~/.cursor/hooks.json` 形态（保存即生效）：
  ```json
  {
    "version": 1,
    "hooks": {
      "beforeSubmitPrompt": [{ "command": "node \"C:\\Users\\<user>\\.harnmem\\cursor\\hook.mjs\" inject", "timeout": 10 }],
      "sessionEnd":         [{ "command": "node \"C:\\Users\\<user>\\.harnmem\\cursor\\hook.mjs\" extract", "timeout": 10 }]
    }
  }
  ```
  要点（M）：命令用**安装期展开的绝对路径**（`${CURSOR_PLUGIN_ROOT}` 只在插件 mcp.json 中确认展开，
  用户级 hooks.json 中不保证，勿赌）；`timeout` 单位秒；用户级 hook 的 cwd 是 `%USERPROFILE%\.cursor`；
  脚本不要依赖相对路径；Windows 经 PowerShell、JSON 从 stdin 读。
- 三条安装路径（修订后）：
  1. **插件（主）**：marketplace 或 `~/.cursor/plugins/local/harnmem` + Reload Window → 带 rules +
     MCP；再由 `install.mjs` 合并写入用户级 `~/.cursor/hooks.json`（hooks 部分）。
  2. **install.mjs（独立兜底）**：写 `~/.cursor/hooks.json`（**读-合并-写**，保留用户既有 hooks，
     同命令 marker 幂等，写前备份；claude-mem 覆盖翻车之鉴）+ `~/.cursor/mcp.json`（同样合并）+
     `~/.cursor/rules/harnmem.mdc`（或项目 `.cursor/rules/`）。
  3. **项目级"repo 内置记忆"选项**：`.cursor/hooks.json` + `.cursor/rules/harnmem.mdc`（受
     trusted workspace 影响；MCP 仍需用户级或插件，项目级不可用【M】）。
  4. **deeplink 补 MCP 安装**：`cursor://anysphere.cursor-deeplink/mcp/install?...`（无插件时的
     用户级 MCP 兜底）。
- 备选/实验通道（M，不建议主用）：按 **Claude 格式插件**分发时，已安装插件的 hooks 会以 source
  `claude-plugin` 执行（实测 sessionStart/sessionEnd 命中）；但受 `isClaudeCodeHooksEnabled()` /
  `enable_cc_plugin_import` 实验开关门控、且绑在 Claude 插件生态的安装面上，行为随版本/开关变化，
  只适合作兼容实验，不能当 cursor-harnmem 的正式分发形态。
- > **原结论（2026-10-29）**：插件目录自带 `hooks.json`，`${CURSOR_PLUGIN_ROOT}` 是否可用留待实现期
  > 验证，安装脚本是兜底；**实测修正（M）**：插件 hooks 不加载，安装脚本从兜底升为 hooks 唯一可靠
  > 通路；`${CURSOR_PLUGIN_ROOT}` 只在插件 `mcp.json` 中确认展开。

## 10. 实测结论、仍存风险与验收动作

### 10.1 结论 / 风险 / 验收表

| # | 项目 | 实测结论（2026-10-30） | 仍存风险 | 验收动作 | 等级 |
|---|---|---|---|---|---|
| I1 | 注入：sessionStart `additional_context` | 新会话触发，但注入被丢弃；标记串只在 hook 输出日志、模型不可见 | 官方未来可能修复后又变；时序不稳 | 每版本用标记串探针复核；注入不依赖本通道 | 【M】 |
| I2 | 注入：beforeSubmitPrompt `additional_context` | 扁平 additional_context **每轮生效**，同轮 thought 与最终回答可见 | 未文档化，官方 schema 仅 `{continue,user_message}`，未来可能收紧/移除 | 每轮注入标记串回归；首轮快照 + rules 兜底 | 【M】 |
| I3 | 注入：rules `alwaysApply` | 工作区与插件 `rules/*.mdc` 标记串 100% 可见 | 占用上下文；长规则遵守率下降；必须 `.mdc` 后缀 | 标记串探针；rules <500 行；体积预算测试 | 【M】 |
| I4 | 注入：postToolUse additional_context | 本轮未探 | 官方员工称非 MCP 工具丢弃；IDE 端修复未见公告 | 下一轮专项探针（v2 备选通道） | 【U】 |
| I5 | 注入体积上限 | 未知 | 过长注入可能被截断或拖慢首字 | 5k/10k/20k 梯度注入 | 【U】 |
| I6 | 注入确认 / 重试 | `afterAgentResponse` 带 conversation_id，可确认注入成功；首轮 model 失败后重试（新 generation）会重新注入（`pending` → `attempts+1`） | 事件顺序变化时确认可能迟到/缺失（marker 停在 pending，不影响再次注入） | marker 状态机单测 + 真机首轮失败重放 | 【M】 |
| D1 | transcript 路径 | IDE 与 CLI 同构；encoded-cwd 编码规则实测；hook 输入/ env 可取到 | 版本升级可能改布局/编码 | 解析器优先用 hook 的 transcript_path；构造路径仅兜底并做版本回归 | 【M】 |
| D2 | transcript 行格式 | `{role,message.content[]}` + `turn_ended`；user 文本被 timestamp/user_query 包裹；无 tool/thinking/独立 timestamp | 未知行类型容错；tool 数据缺失影响抽取质量 | fixture 单测覆盖三种行 + 未知行忽略；抽取仅基于对话文本 | 【M】 |
| D3 | 抽取：sessionEnd | 触发；reason/duration_ms/final_status/transcript_path 有值 | fire-and-forget 无回传；窗口关闭时进程可能被杀；偶发 hook 执行失败（MainThreadShellExec） | detached 子进程 + 立即退出 + 重试/降级；日志确认抽取产物 | 【M】 |
| D4 | 抽取：stop / 增量 | stop 每轮触发，含 status/loop_count/usage/transcript_path | 高频触发成本；增量协议未设计 | 后续评估增量 journal，不阻塞 MVP | 【M】 |
| D5 | preCompact / 子代理 hooks | 本轮未触发（未压缩、未跑子代理） | 事件存在性/载荷未知 | 专项探针 | 【U】 |
| M1 | MCP：项目级 `.cursor/mcp.json` | 对本版本 agent **不可用**（state.vscdb 仅记 knownServerIds；调用报 server_not_found） | 未来版本可能修复，行为再变 | 不作依赖；每版本回归一次 | 【M】 |
| M2 | MCP：用户级 `~/.cursor/mcp.json` | 写后约 4s 生效、stdio 调用成功、无审批弹窗 | 企业 allowlist/auto-run 策略差异；版本差异 | README 注明重载；企业场景单独验收 | 【M】 |
| M3 | MCP：插件 `mcp.json` | 注册为 `plugin-<plugin>-<server>`；`${CURSOR_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_ROOT}` 展开 | 与 Claude 插件导入共享命名空间，可能同名冲突 | 安装后 catalog 核对；server 键名唯一 | 【M】 |
| M4 | MCP 审批 | 用户级 stdio 调用无弹窗；旧"默认需批准"结论不适用本版本 | 企业 allowlist / 设置差异 | 文档注明；检查 auto-run 设置 | 【M】 |
| P1 | 插件 hooks 可加载性 | desktop 3.27.22 不加载本地插件 hooks（native 与 .claude-plugin 格式皆然）；已装 Claude 插件 hooks 以 source `claude-plugin` 执行 | 实验开关/版本变化可能改变行为 | 每版本看 hooks 日志来源；插件 hooks 不作依赖 | 【M】 |
| P2 | 插件 rules + MCP | 加载并生效 | 需 Reload Window；企业 "Allow Local Plugin Imports" | 安装后核对 Customize + 规则标记串 | 【M】 |
| P3 | 分发/安装 | 安装脚本读-合并-写 `~/.cursor/hooks.json` 保存即生效；插件带 rules+MCP | JSON 合并冲突、覆盖用户配置（claude-mem 前车之鉴）；升级需重写绝对路径 | 备份 + 幂等 marker + 只删自家条目；install/uninstall 单测 | 【M】 |
| P4 | marketplace 多插件分发 | 文档形态（`.cursor-plugin/marketplace.json`）本轮未实测安装 | 第三方开放范围/审核节奏不明 | 发布路径前做一次真机安装 | 【V】 |
| P5 | 双通道 hooks 重复执行 | 完整重启后用户级 hooks 与插件 hooks 同时执行同一事件（日志 Found 2 hook(s)，响应合并）；exclusive claim 去重后 journal 无重复 | 未来版本可能只启用其中一条通道；claim 文件残留 | 每版本 hooks 日志核对 Found N hook(s)；claim TTL 清理 + 幂等单测 | 【M】 |
| W1 | Windows 执行环境 | hook 经 PowerShell、JSON stdin；用户级 command cwd=`%USERPROFILE%\.cursor`；timeout 单位秒 | `node` PATH、UTF-8 编码、超时 | Windows 真机冒烟 + CI（node 22/24） | 【M】 |
| W2 | Claude 插件 hook 容错 | 偶发 `Error: MainThreadShellExec not initialized`，该次 hook 未执行 | 个别窗口抽取消失 | 重试 + 降级 + rules 兜底；日志告警 | 【M】 |
| S1 | PII / 安全 | hook 载荷含 `user_email`、`workspace_roots`、prompt 全文；transcript 含用户文本 | 探针日志/fixtures 泄露 PII 进仓库 | 探针日志脱敏；fixtures 不含真实 home 路径/用户名；提交前 grep 校验 | 【M】 |

### 10.2 总评与实现顺序

**总评**：可行性高，路线已按真机结论收敛并**实现落地**（`packages/cursor-harnmem`，
v0.1.0，35 个测试、全仓 gate 通过，2026-10-30 两次真机验收通过）。注入主通道是未文档化的
`beforeSubmitPrompt` 扁平 `additional_context`（可用、无兼容承诺），插件承担 rules + MCP 载体，
hooks 由安装脚本写入用户级配置；`afterAgentResponse` 提供注入确认，exclusive claim 解决双通道
重复执行。工具层、抽取层、Windows 运行时均已真机闭环。主要残余不确定性集中在
I2（未文档化通道稳定性）、I5（注入体积）、D5（preCompact/子代理事件未触发）与 P4（marketplace
分发未验证）。实现细节与偏差项见 `docs/design/11-cursor-adapter.md`。

**实现状态（2026-10-30）**：
1. 已实现：`beforeSubmitPrompt` 注入（一会话一次 + `afterAgentResponse` 确认 + 失败重试再注入）
   + `.cursor/rules/harnmem.mdc` 兜底；
2. 已实现：插件 `mcp.json` + 五个 memory 工具（真机调用通过）；
3. 已实现：`sessionEnd` detached 抽取 + `parseCursorTranscript`（fixture 覆盖包裹标签/异常行/截断）；
4. 已实现：`scripts/install.mjs` 读-合并-写/备份/幂等 claim/卸载 + Windows 冒烟（真实 BOM 文件）；
5. 未完成：marketplace 发布与安装路径（P4）、企业开关场景（Allow Local Plugin Imports）另行验收。

## 附录：主要引用源

- 官方：https://cursor.com/docs/hooks · /docs/reference/third-party-hooks · /docs/context/mcp ·
  /docs/context/rules · /docs/extension-api · /docs/agent/subagents · /docs/agent/security ·
  /docs/cli/installation · /docs/cli/using · /docs/cli/changelog · /docs/cli/reference/authentication ·
  /docs/deeplinks · cursor.com/changelog（1-0/1-2/1-6/1-7/2-0/2-1 及当前页）· /blog/hooks-partners
- 论坛（官方员工）：forum.cursor.com/t/…/158452（sessionStart bug 确认）· /raw/155689（postToolUse
  探针）· /t/174713/5（超时）· /t/169942（CLI Windows 超时）· /t/46900、/t/69194、/t/143887（工具
  上限 25→40→80）· /t/132123、/t/62182、/t/171696（MCP enable）· /t/165213（分页 bug）· /t/174724
  （账号 rules 云存储）
- 社区实测：github.com/LazyIsEfficient/agentic-os（3.8.11 PROVEN）· vectorize-io/hindsight（兜底
  模式）· vshulcz/deja-vu（双端解析器+hooks 实测）· skillsynchq/txcript（state.vscdb 逆向）·
  SimHacker/moollm（JSONL/store.db 实测）· entireio/cli（headless hooks 触发面）·
  jherard-fr/cursor-chats-bridge · lpalbou/CursorDump · vanzan01/cursor-memory-bank ·
  core-memory-kit（生态盘点）
- 本机探针（2026-10-30，Cursor 3.27.22 desktop，Windows 11，模型 `cursor-grok-4.6-medium`）：
  findings `D:\projects\harnmem\.tmp\cursor-probe\findings.md`；事件日志
  `%TEMP%\harnmem-cursor-probe\events.jsonl`；Cursor hooks 日志
  `%APPDATA%\Cursor\logs\<ts>\window*/output_*/cursor.hooks.workspaceId-*.log`；脚本
  `hook.mjs` / `hook-v3.mjs` / `hook-v4.mjs`；探针工作区
  `D:\projects\harnmem\.tmp\cursor-probe\ws`（含 `.cursor/rules` 探针规则）。
