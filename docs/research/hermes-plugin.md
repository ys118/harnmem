# Hermes 插件调研：hermes-harnmem 落地路径（2026-10-29）

> 调研性质：本机已装 Hermes Agent v0.22.5 stable（git 安装；源码 `C:\Users\<user>\AppData\Local\hermes\hermes-agent`，
> 可执行 `C:\Users\<user>\AppData\Local\hermes\bin\hermes.exe`）。直读本地源码 + 官方文档源（`website/docs/`），
> 另有两路子代理并行（web 生态/分发；本地辅助文档 A 会话存储/B ctx.llm/C 子代理/D MCP+注入面）。
> 证据分级：【S】=本地源码/官方文档源直读（本仓 file:line 可复核）；【W】=官方站点/GitHub web 调研；【U】=未确认或文档自相矛盾。
>
> 结论先行：**hermes-harnmem 技术路线可行，且 Hermes 是 harnmem 目前调研过的宿主中插件契约最完整的一个**
> ——它是唯一提供一等公民 MemoryProvider ABC 的宿主，harnmem 四层契约几乎逐条有官方落点。但有三个结构性差异：

1. **宿主是 Python，harnmem 是 Node**：hermes-harnmem 是纯 Python 插件，通过 subprocess 包装
   `harnmem` CLI（仓库内 byterover 内置 provider 就是这个范式：包装 `brv` CLI，带 PATH 解析/超时/环境剥离）。
   `@harnmem/cli` 0.4.0 现有子命令 `stats/search/read/write/forget/restore/consolidate/rebuild/index/export/import/synonyms`
   【S，packages/cli/src/main.ts:181-207】**缺注入面与抽取面**——需新增 `harnmem context`（ensureContext 快照 → stdout）
   与 `harnmem extract --transcript <jsonl>`（会话抽取）两个子命令。用户前置：Node ≥22.15 + `npm i -g @harnmem/cli`。
2. **注入语义与 harnmem 完全同构，且是官方立场**：Hermes 明确"system prompt 必须逐字节稳定以保 prompt cache"，
   一切动态召回走 `MemoryProvider.prefetch()` → 本轮 user message 的 `api_content` 侧车，**ephemeral、不落历史库、
   每轮重注**【S，turn_context.py:909-957】。压缩天然免疫（每轮重注），这正是 harnmem ensureContext 想要的语义；
   `register_system_prompt_section` 只是每会话一次性冻结的静态段，不做每轮刷新（官方防缓存失效，明确拒绝该需求）。
3. **分发必须走官方 plugin catalog**：`plugins/memory/` 内树对新 provider **已关闭**（May 2026，byterover/retaindb
   随后移出）【S，plugins/AGENTS.md:19-27】。第三方记忆 provider 一律独立目录 + catalog PR 上架
   （一 YAML 一条目、40-hex SHA pin 强制、CI 对 pin 点跑 `hermes plugins validate`）【S，plugins/AGENTS.md:57-74】。
   记忆类先例已有一串：Honcho、Supermemory、Hindsight、Mem0、OpenViking、Kumiho、memory-shield、Memoria【W】。

---

## 1. Hermes 扩展面全景（与其他宿主对照）

| 维度 | Claude Code | Codex | Cursor | **Hermes v0.22.5** |
|---|---|---|---|---|
| 插件体系 | marketplace plugin | `.agents/plugins` | `.cursor-plugin/` 目录 | **Python 插件目录 + 官方 catalog**（600 条目、SHA pin、审核制）【W】 |
| 注入通道 | SessionStart hook→additionalContext | SessionStart→developer message | sessionStart→additional_context | **MemoryProvider.prefetch()→本轮 user message 侧车**（每轮、ephemeral）+ 静态 system_prompt_section |
| 抽取通道 | SessionEnd detached 子进程 | 同 | fire-and-forget + transcript_path | **on_session_end(messages) 直接收消息列表** + state.db 只读回捞 |
| 工具面 | `.mcp.json`（MCP-only） | `.mcp.json` | mcp.json | **provider 自带 function-calling 工具**（get_tool_schemas，与 MCP 工具同列注册表）；MCP 仍可选 |
| 会话数据 | `~/.claude` JSONL | rollout JSONL | CLI transcript JSONL | **state.db（SQLite/WAL/FTS5，schema v31）**+ `SessionDB` Python API + `hermes sessions export` |
| 子代理 | Task tool | — | subagentStart/Stop hook | delegate_task + **`agent_context` kwarg**（primary/subagent/cron/flush）|
| 记忆 API | 无（hooks 拼装） | 无 | 无 | **MemoryProvider ABC 全家桶**（prefetch/sync_turn/on_session_end/on_pre_compress/工具/配置）|

生态现状：Hermes 自带 `memory` 内置工具（MEMORY.md/USER.md，会话开始冻结快照注入，2,200/1,375 字符上限）
【S/W，user-guide/features/memory.md:17-20】与内置 context engine；第三方记忆产品走 provider 插件 + catalog。
"harnmem = 治理化记忆库（检索/蒸馏/台账）" 与内建 MEMORY.md（单文件快照）定位不同，共存即可（工具名错开）。

## 2. MemoryProvider 插件 API（核心机制）

### 2.1 发现与激活【S】

- 发现顺序：bundled `plugins/memory/<name>` → `$HERMES_HOME/plugins/<name>` → `./.hermes/plugins/`
  （opt-in `HERMES_ENABLE_PROJECT_PLUGINS`，gateway 不加载项目插件）→ pip entry point 组
  `hermes_agent.memory_providers`【S，plugins/AGENTS.md:81】。**bundled-first、先到先得**（与通用插件 later-wins
  相反），因为 provider 按 `memory.provider: <name>` 名字激活，防止用户目录遮蔽同名内置——harnmem 无同名冲突。
- 发现只枚举不导入；激活后 `register(ctx)`（`__init__.py`）内 `ctx.register_memory_provider(HarnmemProvider())`
  【S，byterover `__init__.py:283-285`】：**每次注册新实例、禁单例**（管理器拒绝共享实例
  `memory_provider_instance_shared`，网关一进程多 profile 并发）。外部 provider **同时只激活一个**。
- 目录形态（bundled 参考实现实测）：`plugin.yaml` + `__init__.py` + `README.md`；文档化可选面
  `cli.py`（`register_cli(subparser)` → `hermes <provider> …` 子命令，**仅激活时**由
  `discover_plugin_cli_commands()` 接线）、`config_schema.py`（Desktop 设置面板）【S，AGENTS.md:81；
  memory-provider-plugin.md】。
- `plugin.yaml` 要点：`name/version/description`；`external_dependencies` 列外部 CLI
  （byterover 例：`[{name: brv, install: "curl …", check: "brv --version"}]`）；`python_dependencies`
  会并入 Hermes venv——**hermes-harnmem 目标零 Python 依赖（纯 stdlib），wrapper 无依赖面则不进 venv 并集**，
  `$HERMES_HOME/plugins/**` 在 `hermes update`/venv 重建中存活。

### 2.2 MemoryProvider ABC 全表【S，agent/memory_provider.py，全 225 行】

| 方法 | 语义 |
|---|---|
| `name` (property) | provider 名（= `memory.provider` 值） |
| `is_available()` / `unavailable_reason()` | 只查配置/依赖，**禁网络**；harnmem 在此查 node+harnmem CLI |
| `initialize(session_id, **kwargs)` | kwargs 恒含 `hermes_home`+`platform`；可含 `agent_context`（'primary'/'subagent'/'cron'/'flush'，**非 primary 跳过写**）、`agent_identity`、`agent_workspace`、`parent_session_id`、`user_id` |
| `system_prompt_block()` | 静态文本（'' 跳过）；**召回不许走这里** |
| `prefetch(query, *, session_id)` | 每轮 API 调用前召回注入；**必须快**（后台预热+返回缓存） |
| `queue_prefetch` | 每轮结束后预热下一轮 |
| `recall_status()` | → RecallStatus(provider_label, count, glyph='🧠')，状态栏确定性召回指示 |
| `sync_turn(user, assistant, *, session_id, messages, turn_author)` | 每轮持久化，**非阻塞**（后台线程） |
| `get_tool_schemas()` | → OpenAI function-calling `[{name,description,parameters}]`，无则 [] |
| `handle_tool_call(tool_name, args, **kwargs)` | → **JSON 字符串**；另收 `hermes_home/agent_identity/caller_gsk` |
| `shutdown()` / `on_session_end(messages)` | 真实会话边界收**完整消息列表** |
| `on_turn_start(turn_number, message, **kwargs)` | 含 remaining_tokens/model/platform/tool_count/作者三元组 |
| `on_session_switch(new_session_id, *, parent_session_id, reset, rewound)` | /resume /branch /reset /new 与压缩重绑 |
| `on_pre_compress(messages)` | → str 进压缩摘要 prompt；检查点契约 v2（`pre_compress_checkpoint_api_version=2`，失败 raise；用户开 `compression.checkpoint_required: true` 后压缩 fail-closed） |
| `on_delegation(task, result, *, child_session_id)` | **父侧**观察（子代理无 provider session） |
| `on_memory_write(action, target, content, metadata)` | 被镜像的内建 memory 写通知（action add/replace/remove × memory/user） |
| `get_config_schema()/save_config/on…` | `hermes memory setup` 四表面之一（见 §10） |
| `identity_signature()` | 网关 agent 缓存 bust |

模块级事实：`CORE_MEMORY_PROVIDER_SENTINELS={'','default','builtin','built-in','none'}`；`is_trivial_prompt`
（空/斜杠/寒暄）跳过召回；`PRE_COMPRESS_CHECKPOINT_API_VERSION=2`。

### 2.3 调用点与线程契约【S】

- 每轮：`turn_context.py:909-937` `on_turn_start → prefetch_all(query, session_id) → describe_recall →
  _emit_status`；`turn_context.py:940-957` `_stamp_api_content_sidecar`：`compose_user_api_content(原文,
  ext_prefetch_cache, plugin_user_context)` 盖到 `message['api_content']`——**注入是本轮 user message 的
  api_content 侧车，transcript 持久化保持干净原文**。
- 每完成轮：`run_agent.py:894-921` `sync_all(user, response) + queue_prefetch_all(user)`。
- 会话边界：`run_agent.py:871-889` `shutdown_memory_provider(messages) → memory_manager.on_session_end(messages or [])`；
  `hermes_cli/cli_shutdown.py:102-124` 真实边界转发 transcript。drain 有超时保护（`_SYNC_DRAIN_TIMEOUT_S`）。
- provider 工具并入模型工具表：`tools/mcp_tool_agent.py:330` 与 `agent/memory_manager_tools.py:86`（与 MCP schema 同列）。
- **线程契约（网关安全）**：后台线程必须 `agent.memory_provider.spawn_context_thread`（contextvars 载
  HERMES_HOME 覆盖 + secret scope）；裸线程丢 profile、写错租户、`get_secret` fail-closed。
  生命周期钩在** owning profile scope** 下由调用方绑定触发（eviction/shutdown/cron 完成也会触发）；
  **禁止把 `initialize()` 的 `hermes_home` 缓存成"唯一的 home"**——按 `hermes_home_key()` 每次调用的实参键控；
  **禁读 `os.environ` 取凭据**（`agent.secret_scope.get_secret`）【S，plugins/AGENTS.md:98-108】。

## 3. 注入层：四条通道对比与选型

| 通道 | 时机/持久性 | 上限 | 评价 |
|---|---|---|---|
| **`prefetch()`（选它）** | 每轮 API 前；ephemeral，不落历史 | 默认全量返回，至 10×`hooks.output_spill.max_chars`（≥100K 字符）才 spill；`memory.prefetch_spill_enabled: true` 收紧到 10K | 唯一"每轮刷新 + 不污染历史 + 压缩免疫"的官方通道 |
| `system_prompt_block()` | 每会话静态 | — | 放一句"harnmem 记忆工具可用"级别静态说明 |
| `ctx.register_system_prompt_section(id, fn, position="after_memory")` | 每新会话渲染一次、冻结于压缩、恢复自持久化 prompt | 单段 ≤4,000、合计 ≤8,000/32 段 | 官方**拒绝**每轮刷新（防缓存失效）；仅静态标语的备选 |
| 通用 `pre_llm_call` hook | 每轮，返回 `{"context": …}` 追加进 user message | 每钩 10,000 字符，超出 spill 到 `$HERMES_HOME/hook_outputs/<session_id>/<uuid>.txt`（首尾各 500 字符预览） | 非provider 路线的注入面（Route B）；与 prefetch 二选一即可 |

设计理由（官方原文立场）：system prompt 逐字节稳定保 prompt cache（官方称省 75%+ 输入 token）；注入 ephemeral
（历史不变异、不落 session DB）【W/S，developer-guide/plugins/index.md:1539-1648】。

**hermes-harnmem 选型**：`prefetch()` 返回**缓存的 ensureContext 快照**（Python 侧持有字符串）；
失效时机 = `on_memory_write` 镜像通知 / `harnmem_write`·`harnmem_forget` 工具调用 / `consolidate`（后台重建）。
失效才 spawn `harnmem context` 重建——避免每轮 Windows spawn（~100-300ms）。快照失败/超时返回 None（首轮也无害，
Hermes 对 None 只观察）。`system_prompt_block()` 返回一行静态说明。

## 4. 抽取层：会话数据面

- **`on_session_end(messages)`（provider 接口）是正确抽取点**：只在真实会话边界 fire 且直收消息列表。
  ⚠区分同名通用 hook：`on_session_end` hook **每个 turn 结束都触发**且 payload 无 transcript
  【S/W，hooks.md:471,971】；一次性 teardown 用 `on_session_finalize`（/new、CLI 退出）——两者都拿不到消息体。
- 转写存储：`<HERMES_HOME>/state.db`（SQLite/WAL，schema v31）。messages 表含 role/content/tool_calls/
  `api_content`（注入侧车）/`message_uid`/`compacted`；sessions 表含 source/parent_session_id/end_reason/
  `user_id`（subagent/cron 会话为空）。只读访问三条官方通道：`SessionDB.get_messages_as_conversation(id)`、
  `hermes sessions export <out> --session-id <id>`（JSONL）、直接 sqlite 只读（busy 等待 5s）。
  **gateway 是 canonical 唯一写者，插件不直写**【S/W，session-storage.md:3-12,237-269,383-385,393-441】。
- **LLM 归属**：harnmem 的抽取 LLM 在 Node 侧自持（`@harnmem/core` LlmFn → HARNMEM 自己的 env/config），
  **不需要 Hermes 的 `ctx.llm`**——零 trust-gate 配置、零 Hermes 侧 secret。ctx.llm 备忘（若将来要用）：
  `complete/complete_structured` 默认走用户当前模型；`provider=/model=/profile=/task=` 覆盖是 fail-closed
  trust gate（`plugins.entries.<id>.llm.*` 放行）；单次调用、无 streaming、无 tool loop【S/W，plugin-llm-access.md】。
- **detached 要求**：`on_session_end` 处于 shutdown drain 窗口（`_SYNC_DRAIN_TIMEOUT_S` 兜底），而 harnmem
  抽取可含 LLM 调用（秒级到分钟级）→ 写临时 transcript JSONL + **detached node 子进程立即返回**
  （claude/codex adapter 同型），幂等键 (session_id, transcript digest)。`sync_turn` 逐轮 append journal
  （`<hermes_home>/harnmem/journals/<session_id>.jsonl`）兜底崩溃恢复——下次 initialize 时按 digest 补抽取。

## 5. 工具面

- provider 工具经 `get_tool_schemas()` 进与 MCP 同一张工具注册表，模型正常调用【S，§2.3】。
- **命名带 `harnmem_` 前缀**：内置单工具叫 `memory`（`tools/memory_tool.py:374`，action add/replace/remove ×
  target memory|user → MEMORY.md/USER.md），byterover 用 `brv_*`、retaindb 用 `rdb_*`——前缀防撞是既定惯例。
  定五个工具：`harnmem_write / harnmem_search / harnmem_read / harnmem_forget / harnmem_status`。
- 内置 memory 工具**默认共存**（选外部 provider 不摘除内建工具/工具集）；双轨重叠用文档说明定位差异，
  不劫持内置名。写侧双向镜像已有官方钩：内建写 → `on_memory_write` 通知 provider【S，inline_tool_executors.py:152-154】。
- 通用插件路线也可 `ctx.register_tool`（原名注册，重名需 override+capability），但 provider 路线自带工具面，不需要。
- MCP 路线备忘：`mcp_servers.<name>` stdio/HTTP 均可，工具名 `mcp_<server>_<tool>`（单下划线；
  toolsets-reference.md:136 的双下划线是遗留笔误）；`trust: untrusted` 时无 readOnlyHint 注解的写工具逐次审批。
  claude-harnmem 的 `mcp/mcp.mjs` 理论上可直接挂——但**拿不到注入**，仅作"只要工具"用户的快速通道备注。

## 6. 生命周期与压缩

- `/resume /branch /reset /new`、压缩重绑 → `on_session_switch(new_session_id, parent_session_id, reset, rewound)`：
  重绑 journal/快照缓存键。
- 压缩：`post_compaction(session_id, old_session_id, kind, reason, before/after_tokens, messages_removed)`
  通用 hook 可观察全部压缩路径。**harnmem 注入对压缩免疫**（ephemeral 每轮重注），无需在压缩里抢救注入；
  `on_pre_compress(messages)`（检查点契约 v2）可选：把"压缩即将发生、相关记忆指针"喂进摘要 prompt（v1 可返回空串）。
  开 `compression.checkpoint_required: true` 后 v2 检查点失败会阻断压缩（fail-closed）——**v1 不声明检查点即不受此约束**。
- 快照失效与 day-change：harnmem ensureContext 的日期语义在 `harnmem context` 内部处理，provider 每轮重拉缓存即可。

## 7. 子代理

- `delegate_task` 起隔离子会话（fresh conversation、独立 terminal、仅 final summary 回父）。
  provider `initialize()` 收 `agent_context='subagent'`（还有 'cron'/'flush'），官方指引**非 primary 跳过自动写**。
  官方默认封锁集：所有子代理禁 `memory`/`clarify`/`send_message`/`cronjob`，leaf 禁 `delegate_task`
  （orchestrator 受 `delegation.max_spawn_depth`，默认 1）——即**官方"子代理只读"模式现成**。
- hermes-harnmem 策略：`agent_context != 'primary'` → sync_turn/on_session_end 跳过写与抽取；
  工具 schema 裁剪为只读集（search/read/status）。父侧观察用 `on_delegation(task, result, child_session_id)`。
- observer hooks（`subagent_start`/`subagent_stop`）给 metadata-only 遥测（tool_call_history 只有名字/字节数，
  无原始内容）——harnmem 不依赖。

## 8. 生态与同类（catalog 现状）

- catalog 自 v0.22.0（2026-10-13，"Threshold Release"，SemVer stable 渠道）上线：600 个插件、每个 pin 到
  审核过的 commit；准入规则禁止 patch Hermes 内部、禁止不可扫描的二进制【W，releases+catalog-submission】。
  今日 stable = **v0.22.5（2026-10-22）**【W】。
- 记忆类 catalog 先例：Honcho（cli.py 13 子命令 + --target-profile）、Supermemory（向导只问 API key，其余进
  supermemory.json）、Hindsight、Mem0、OpenViking、Kumiho Memory、memory-shield、Memoria【W】；
  内树 byterover/retaindb 按计划移出（`hermes_cli/memory_provider_migration.py` 自动迁移存量配置）
  【S，plugins/AGENTS.md:19-27】。差异位：同类多为"云端 API 包装"，harnmem 是**本地治理化记忆库 + CLI 外部依赖**，
  与 byterover（brv CLI）同构、定位无冲突。

## 9. hermes-harnmem 四层架构建议

| 契约层（docs/design/07-adapter-contract.md） | Hermes 落点 | 机制 |
|---|---|---|
| 注入（ensureContext 字节稳定） | `prefetch()` | Python 缓存快照字符串；写后失效、失效才 spawn `harnmem context`；注入本轮 user message 侧车（api_content），历史零污染 |
| 工具（write/search/read/forget/status） | `get_tool_schemas()`+`handle_tool_call()` | `harnmem_*` 五工具；subprocess 调 `harnmem <cmd> --json`，10s 查询超时、120s 写超时（byterover 参数基线） |
| 生命周期（sessionEnd 抽取 + 失效重建） | `sync_turn`→journal；`on_session_end(messages)`→detached extract；`on_memory_write`→快照失效 | journal `<hermes_home>/harnmem/journals/<session_id>.jsonl`；抽取幂等 (session_id, digest)；崩溃恢复在下次 initialize 补跑 |
| 配置（HARNMEM_HOME/env） | `memory.harnmem` 配置块 + `hermes memory setup` | `get_config_schema()/save_config(→<hermes_home>/harnmem.json)/post_setup(探测 node+harnmem)/get_status_config` |

数据流（一轮）：`on_turn_start` → prefetch：缓存快照 or spawn `harnmem context` → 注入 api_content 侧车 →
模型调 `harnmem_write` → `handle_tool_call` spawn `harnmem write` → 快照标脏 → 下轮重建。
会话结束：`on_session_end(messages)` → 写 transcript JSONL → detached `harnmem extract --transcript …` → 立即返回。

**@harnmem/cli 需新增**（0.4.0 → 0.5.0）：
- `harnmem context [--home <dir>] [--format text|json]`：sessionStart 快照 → stdout，与 claude/pi adapter 注入字节一致；
- `harnmem extract --transcript <file.jsonl> [--session-id] [--home <dir>]`：`SessionEndInput` 抽取（幂等）；
- 复核既有 `search/read/write/forget/status` 的机器可读输出（统一 `--json`，Output formatter 已有基础）。

目录蓝图（monorepo 新包，纯 Python 文本、零 pip 依赖）：

```
packages/hermes-harnmem/
  plugin.yaml          # name: harnmem; external_dependencies: node≥22.15 + @harnmem/cli
  __init__.py          # HarnmemProvider(MemoryProvider) + register(ctx)
  cli.py               # register_cli(subparser) → hermes harnmem status/search/read/write
  config_schema.py     # hermes memory setup 面板
  README.md  tests/
```

关键实现决策（含理由）：
1. 快照缓存+失效重建，不每轮 spawn（prefetch 必须快；Windows spawn 成本）。
2. 抽取 detached + 幂等（drain 窗口 ≠ LLM 时长；claude/codex 同型）。
3. journal 按 `initialize()` 传入的 `hermes_home` 键控（profile 隔离原则），记忆库本身用全局 `~/.harnmem`
   （跨宿主共享是 harnmem 卖点；HARNMEM 的 LLM 配置自持，秘密不过 Hermes 进程/env——天然满足
   "禁读 os.environ 取凭据"）。
4. 后台一律 `spawn_context_thread`；无模块/类级 profile 态（网关一进程多 profile）。
5. 非 primary `agent_context` 只读：工具 schema 裁剪 + 跳过 sync/extract。
6. 子进程 env 构建参考 byterover `_brv_child_env`（multiplex 时 strip 启动 profile 残留；harnmem 只需
   PATH + 可选 HARNMEM_HOME，无 BRV 式云密钥）。

轻量替代路线（记录备查，不推荐为主形态）：通用插件（`pre_llm_call` 注入 10K 上限 + `ctx.register_tool`
工具 + 直读 state.db 抽取）——注入上限低一档、无 sync/on_memory_write 官方镜像，仅当 provider 路线被
catalog 审核卡住时的过渡。

## 10. 打包与分发

- 用户安装：`hermes plugins install ys118/harnmem packages/hermes-harnmem --enable --ref <40位SHA>`
  （`owner/repo/<子目录>` 形态 + SHA pin）【W】；或手动拷贝目录到
  `$HERMES_HOME/plugins/harnmem/`（Windows = `%LOCALAPPDATA%\hermes\plugins\`，实测本机已有该目录；
  POSIX = `~/.hermes/plugins/`）【S，hermes_constants.py:51-58】。`hermes plugins validate <dir>` /
  `hermes plugins doctor <path-or-id> --ci` 本地自检【W】。
- **catalog 上架是唯一正式分发**：向 NousResearch/hermes-agent 的 `plugin-catalog/` 提 PR 增
  `harnmem.yaml`（40-hex SHA pin 强制，CI 在 pin 点克隆并跑 validate；removed.yaml 是黑名单）
  【S，plugins/AGENTS.md:57-74】。仓库根 `.hermes-catalog.json` 仅供 Desktop 展示、Python 不信任。
- setup 面：`hermes memory setup` → provider 目录驱动四表面：`get_config_schema()`（字段 key/description/
  secret→.env/required/env_var/url/default/choices/type）+ `save_config(values, hermes_home)` +
  `post_setup(hermes_home, config)` + `get_status_config()`。**不要做平行顶层命令**（PR #5295 先例：
  硬编码 honcho argparse 被 95 行删除）【S，AGENTS.md:7-15】。
- `cli.py` 的 `register_cli(subparser)` 只对激活 provider 接线：`hermes harnmem status/search/read/write`。
- 兼容契约：**无 PLUGIN_API_VERSION**，行为式兼容（payload 关键字字段、回调签名检查、`**kwargs` 全量、
  ctx 方法只增不减、废弃 ≥2 minor 窗口）；内部 import 路径不是 API（2026-09 PR #102117 移除旧路径先例）
  → **catalog pin SHA + 只对 stable 渠道验证**【S，AGENTS.md:137-162；W】。
- 隔离：`plugins.isolation: host` 模式下 provider 经 host 进程 RemotePluginContext 代理（ABC 子类照常注册）
  ——实现时保持纯 ABC 面、不碰 HOST_UNSUPPORTED_CTX_METHODS（live gateway 对象）【S，AGENTS.md:110-135】。

## 11. 风险清单与实现期验收

风险：
- R1 API 无版本契约、内部路径会移（#102117 先例）→ pin SHA + stable 渠道 + 每次升级重跑探针。
- R2 prefetch 每轮 spawn 延迟 → 快照缓存 + 失效重建；spawn 失败返回 None 不阻塞。
- R3 抽取长于 drain 窗口 → detached + 幂等；journal 兜崩溃。
- R4 与内置 memory/MEMORY.md 双轨重叠 → 前缀命名 + 文档定位；不劫持内置工具名。
- R5 单 provider 规则：与 mem0/supermemory 等互斥 → catalog 描述显式声明。
- R6 用户前置 Node ≥22.15 + harnmem CLI → `external_dependencies` + `is_available()/unavailable_reason()`。
- R7 catalog 审核（禁不可扫描二进制）→ 插件目录纯 Python 文本；node 依赖走外部 CLI（byterover 范式）。
- R8 网关长驻一进程多 profile → `hermes_home_key()` 键控、`spawn_context_thread`、无全局态。

实现期验收（真机探针计划，全部应过）：
1. `hermes plugins validate` + `hermes plugins doctor harnmem --ci` 通过。
2. `memory.provider: harnmem` 激活：首轮快照注入 user message；state.db 中 `content` 保持原文、
   `api_content` 含快照（注入不落历史）。
3. 字节稳定：连续两轮无写，两轮注入 diff 为空。
4. `harnmem_write` → 下一轮快照包含新记忆（失效重建生效）。
5. 五工具全通（返回 JSON 字符串）；内置 `memory` 工具共存无冲突。
6. `delegate_task` 子代理：journal/store 零写入；只读工具可用。
7. 会话结束（/new、CLI 退出）：detached extract 启动、store 增量、CLI 不挂起。
8. resume/reset 后（`on_session_switch`）快照与 journal 键正确。
9. 手动/自动压缩后下一轮快照照常注入（压缩免疫）。
10. 多 profile（`hermes --profile work`）：journal 各自 `<hermes_home>/harnmem/`，共享库不串写。
11. Windows（`%LOCALAPPDATA%\hermes`）与 POSIX（`~/.hermes`）双跑。
12. `hermes memory setup` 向导：schema 渲染、保存 `harnmem.json`、post_setup 探测 node/harnmem。
13. `hermes update` 后插件仍加载（venv 重建存活、目录仍在）。

## 附录：主要引用源

本地源码（v0.22.5，`C:\Users\<user>\AppData\Local\hermes\hermes-agent\`）：
`agent/memory_provider.py`（ABC 全文）；`agent/memory_manager.py`；`turn_context.py:909-957`；
`run_agent.py:871-921`；`hermes_cli/cli_shutdown.py:102-124`；`hermes_constants.py:51-58`；
`plugins/AGENTS.md`（内树政策/catalog/线程与 profile 契约/兼容契约）；`plugins/memory/byterover/{plugin.yaml,__init__.py}`；
`tools/memory_tool.py:374`；`agent_init.py:1300-1326`；`tools/inline_tool_executors.py:152-154`。

本地文档源（`website/docs/`）：developer-guide/{plugins/index.md, memory-provider-plugin.md,
plugin-llm-access.md, session-storage.md}；user-guide/features/{hooks.md, memory.md, mcp.md, delegation.md}；
user-guide/{subagent-lifecycle-api.md, observer-hooks.md}；reference/{mcp-config-reference.md,
cli-commands.md, toolsets-reference.md}；prompt-assembly.md。

Web（【W】）：hermes-agent.nousresearch.com/docs（plugins、hooks、memory-provider-plugin、mcp、
session-storage、delegation、plugin-llm-access、environment-variables）；
github.com/NousResearch/hermes-agent/releases（v0.22.5 stable、catalog 上线）。

harnmem 侧：`docs/design/07-adapter-contract.md`（四层契约与 §8 验收清单）；
`packages/cli/src/main.ts:181-207`（现有子命令）；`packages/core/src/index.ts`（HarnMem/SessionStartInput/
SessionEndInput/ExtractResult/TranscriptMessage 公共面）；对照 docs/research/cursor-plugin.md（模板与先例）。
