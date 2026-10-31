# omp（oh-my-pi）插件调研：omp-harnmem 落地路径（2026-10-31）

> 结论先行：**可行，且是所有已调研 harness 里对 pi-harnmem 移植成本最低的一个**。omp 是 pi（badlogic/pi-mono）的深度 fork（MIT，Bun 运行时，本机 v18.14.1 与 GitHub `main` 完全一致），保留了 pi 1.x 扩展模型的几乎全部事件面与 API 形状，并内置一层显式的 legacy-pi 兼容机制：`@mariozechner/*`、`@earendil-works/*`、`@sinclair/typebox` 的 import 会被宿主 loader 自动重写到宿主捆绑副本（`pi-ai/compat` → `pi-ai` 根，`complete()` 在 `packages/ai/src/stream.ts:1054`）。本机探针端到端验证：链接插件加载 ✅、快照注入进 system 消息末尾 ✅、`completeSimple` 从插件内可用 ✅、TypeBox/鉴权门面可用 ✅。需要适配的点集中在四处：**`session_shutdown` 只有 2 秒并发预算**（pi-harnmem 8 秒自限时必须砍）、**`session_start/shutdown` 事件无 reason 字段**（resume/quit 需改从会话内容推断；omp 另有 pi 没有的 `session_switch`/`session_branch` 事件，切换语义反而更精确）、**`ctx.sessionManager.buildContextEntries()` 已删除**（pi-harnmem 未直接依赖，无碍）、**内置记忆是硬编码五选一、无第三方 backend 注册 API**（omp-harnmem 定位为普通插件，与默认 `memory.backend: off` 共存无冲突）。建议实现为 `packages/omp-harnmem` 独立包，manifest 键 `"omp":{"extensions":[...]}`，经 `omp plugin install`（npm/git/link）分发。

## 1. 目标与实证方法

- 调研问题：为 omp 开发 harnmem 记忆插件（omp-harnmem）需要什么适配？pi-harnmem@0.4.4 的架构（Adapter + Snapshot 注入 + Journal + 工具 + LLM 抽取桥）能保留多少？
- 本机实证：omp 18.14.1（`C:\Users\15652\AppData\Local\omp\omp.exe`，242MB Bun 单文件）；探针脚本 `%TEMP%\omp-probe\*.ts`（`omp -p --no-session --no-skills --no-rules --no-context-files -e <file> "<prompt>"`）+ 链接插件 `%TEMP%\omp-test-plugin\`；宿主日志 `~/.omp/logs/omp.<date>.<pid>.log`。
- 文档实证：GitHub `can1357/oh-my-pi` `main` 分支 docs/（70+ 文件）与 `packages/coding-agent/src/` 源码，全部缓存于 `%TEMP%\omp-docs\`（子代理逐文件核对源码行号）。
- 冲突裁决：子代理源码结论与本机二进制运行时探针全部互证一致；仅一处形状差异见 §8（runtime 原型上存在 `buildSessionContext`，但类型层 `ReadonlySessionManager` 的 `Pick` 不含 `buildContextEntries`）。

## 2. omp 是什么（一句话档案）

- **oh-my-pi** = pi coding agent 的深度 fork，Stencil Labs 维护，MIT，~37.2k stars，https://omp.sh；npm 包名 `@oh-my-pi/pi-coding-agent`，二进制 `omp`；repo `main` == 分发二进制（catalog 锁定同版本）。
- monorepo：`packages/{ai, catalog, coding-agent, mnemopi, natives, omptype, snapcompact, tui, utils, wire, agent, ...}` + `crates/`（Rust 编辑引擎，编译进 `packages/natives`）+ `docs/` + `sdk/`。运行时 **Bun**（插件安装也用内嵌 Bun，不需要系统 bun）。
- 版本是自有线（v16.x…v18.x），**无 pi-1.x ↔ omp-x 官方映射**；但 `legacy-pi-compat.ts`（110KB）、`legacy-pi-coding-agent-shim.ts`（65KB）、`legacy-pi-ai-shim.ts` 明确以 pi 0.84.2–1.x 时代的扩展为兼容目标。
- 保留 `PI_*` 环境变量（`PI_CODING_AGENT_DIR` 默认 `~/.omp/agent`、`PI_PACKAGE_DIR`、`PI_SMOL/SLOW/PLAN_MODEL`、`PI_NO_PTY`）；`--profile <n>` 隔离到 `~/.omp/profiles/<n>/agent/`。

## 3. 端到端实证（本机探针全链路 ✅）

### 3.1 插件发现与加载 ✅

- 链接本地包：`omp plugin link <path>` → `~/.omp/plugins/node_modules/<name>` Junction + `omp-plugins.lock.json`（`enabled:true`）；`omp plugin list` 归类 "npm Plugins:"。
- 首跑未加载，报错藏在宿主日志：`Failed to parse extension source for dependency rewriting: ...index.js: Unexpected token, expected "," (6:17)`——**测试插件的 `.js` 文件里写了 TS 注解**。教训两条：①loader 会对模块整树 parse 做依赖重写，`.js` 不得含 TS 语法（`.ts` 可以）；②**插件加载失败是静默降级 + 宿主日志 error 行**，排障先看 `~/.omp/logs/`。
- 修复后全链路 ✅：`plugin module loaded; import.meta.url=file:///...?mtime=<ts>`（mtime 缓存穿透；Windows 下 file:// specifier 的 query 被 Bun 忽略，同进程重载不保证，POSIX 可以）→ 工厂被调用 → 事件触发。

### 3.2 legacy import 重写 ✅（pi-harnmem LLM 桥的生死线）

- 模块体内**字面量** import `@earendil-works/pi-ai/compat` → 宿主 onLoad hook 重写解析，`completeSimple=function` 可用 ✅；`pi.typebox={Type,default}`、`modelRegistry.getApiKeyAndHeaders` 存在 ✅。
- **例外：handler 运行期用变量做 `await import(spec)` 不触发重写**（探针 #5 全部 `Cannot find package`）。规则：重写基于源码 parse，spec 必须是字面量。
- 源码确认重写表（`src/extensibility/plugins/legacy-pi-compat.ts`）：`@mariozechner/*`、`@earendil-works/*`、`@oh-my-pi/*` 的 `pi-agent-core|pi-ai|pi-catalog|pi-coding-agent|pi-natives|pi-tui|pi-utils` → `@oh-my-pi/<pkg>`（宿主捆绑单例）；子路径 `pi-ai/utils/oauth`→`pi-ai/oauth`、**`pi-ai/compat`→`pi-ai` 根**（`complete()` 在 `packages/ai/src/stream.ts:1054`，barrel `export * from "./stream"`）；裸 `@sinclair/typebox` → omptype TypeBox 门面（**`@sinclair/typebox/compiler` 子路径不重写**，需要就得 vendor）。

### 3.3 快照注入 ✅（字节级实证）

- `before_agent_start` 事件 keys=`[reason, prompt, images, systemPrompt]`（`reason:"prompt"`）；事件到达时 `systemPrompt` 长度仅 2（完整系统提示此时尚未组装）。
- **mutation `event.systemPrompt=...` 与 return `{systemPrompt}` 都生效**：两个 marker 都出现在最终 provider payload 的 `messages[0]`（role=system）**末尾**（payload len=10997，marker@10988）——追加语义，与 pi-harnmem 的快照注入模式吻合。payload 为 OpenAI 形状 `{model, messages, stream, stream_options, tools, max_completion_tokens, reasoning_effort}`，无顶层 `system` 字段。
- 源码确认返回契约：`before_agent_start` handler 返回 `{message?, systemPrompt?: string[]}`（`types.ts:1733-1737`），"Replace policy for the next request and its continuations"；handlers 从当前 base system prompt 链式覆盖，base 变更触发重试（最多 3 次）。
- **实现期修正（omp-harnmem e2e，2026-10-31）**：运行时 `event.systemPrompt` 实际是 **string**（"长度仅 2" 即 2 字符字符串）；按类型声明返回 `{systemPrompt: string[]}` 会被**静默丢弃**（provider payload 与无注入基线字节一致），原地 mutation 数组同样无效。只有返回 `{systemPrompt: <string>}`（base + `"\n\n"` + block）才落 payload——omp-harnmem 按字符串语义实现并经 `before_provider_request` 字节断言验证（`injected:true`，sha 与注入日志一致，同会话多 turn 字节稳定）。类型与运行时不一致是 omp 18.14.1 自身缺陷。
- TUI 下无 provider/shortcut/composer/file-fallback 的扩展**延迟加载**（composer 接受输入后才 bind，`session_start` 补发，首条消息等待加载）→ **注入必须锚在 `before_agent_start`，不能锚 `session_start`**。resume/`--tools`/未知 flag 启动则全量预载。

### 3.4 事件面 ✅（注册全部成功，顺序实测）

`session_start → before_agent_start → agent_start → context(messages) → turn_start → message_start/update/end → tool_call → tool_execution_start → tool_result → tool_execution_end → turn_end → agent_end → session_shutdown`；`compaction` 事件可注册（短会话未实测触发）。

omp 相对 pi 1.3.0 的**新增**事件（pi-harnmem 可直接受益）：

| 事件 | 用途 |
| --- | --- |
| `session_before_switch` / `session_switch` | 会话切换（before 可 cancel）——pi-harnmem 靠 start() 推断的 session_switch 路径有了显式事件 |
| `session_before_branch` / `session_branch`（reason="branch"\|"fork"\|"btw"） | 分支/分叉后快照需重建 |
| `session_before_compact`（可 cancel+compaction）/ `session.compacting`（可返回 {context?, prompt?, preserveData?}）/ `session_compact` | 压缩前刷新快照（pi-harnmem 已有对应逻辑） |
| `session_before_tree` / `session_tree` | 树导航 |
| `session_stop` | Claude-Code 式 stop 钩子（`{continue}`≤8 次 / `{decision:"block"}`；**task/subagent 会话不触发**） |
| `assistant_message` | 每条最终 assistant 消息 await，可改写文本（块数/序/位不变） |
| `before_subagent_spawn` | 每 child 一次，可改 model/block |
| `cache_warming_decision` | prompt-cache 预热决策（见 §3.6 坑） |

**语义坑（探针实证）**：`session_start` / `session_shutdown` 的 payload 只有 `{"type":...}`，**无 reason 字段**（fresh 与 `-c` 续跑均实证）。`before_agent_start` 有 `reason` 但仅 `"prompt"` / `"revive"`。

### 3.5 LLM 通道与鉴权 ✅

- `completeSimple`（`@earendil-works/pi-ai/compat`，字面量 import）从插件内可用 ✅ → pi-harnmem `src/llm.ts` 的抽取桥**原样保留**。
- `modelRegistry`：`getApiKeyAndHeaders` 存在（探针实证）；源码另确认 `getApiKey(model, sessionId?, {signal}?)` 为 async 返回 `Promise<string|undefined>`（`model-registry.ts:3348`）。pi-harnmem 已 await `getApiKeyAndHeaders`，保留即可，外面包一层 typeof 守卫。
- 备选一次性通道：`ctx.runEphemeralTurn({promptText, tools:false, maxTokens, maxContextBytes, signal, ...}) → {replyText}`（/btw 管线，不进会话历史；**`dedupeReply` 默认 true 会折叠 3+ 重复行并截断 4KiB**——做抽取兜底时传 `dedupeReply:false`；递归防护仅限 context/before_provider_request/after_provider_response 钩子内）。

### 3.6 其它实测行为

- **预算**：handler 大多 30s；`tool_call` fail-closed 30s（`extensionHandlers.toolCallTimeoutMs`，UI 对话框时暂停计时）；**`session_shutdown` 并发执行、仅 2 秒预算**。
- **后台工作必须用 `ctx.setInterval/ctx.setTimeout/clearTimer`**（隔离异常、unref、shutdown 自动清）；裸 `setInterval`/`setTimeout` 回调抛错 = 进程级 uncaughtException = **整个会话被拆掉**。
- `ctx.memory = {status(), search(query, args?), save(content|{content,...})}`：反映活动 backend；off 时 `{backend:"off", active:false, writable:false, searchable:false}`，search 正常降级返回 `{backend, query, count:0, items, message}`。
- `ctx.agent = {kind:"main", id:"Main", name:"main", depth:0}` → **子代理判定用 `depth>0`**（比 pi-harnmem 的环境变量继承去重干净）。
- print/headless 模式 `ctx.ui.hasUI=false`（`ctx.ui.setStatus` 等仍在，TUI 才可见）。
- provider payload 形状 OpenAI-completions；omp 自带 user 消息 `<system-reminder>Today: <date>; current working directory: '<cwd>'...`。

## 4. 插件体系规格（分发与安装）

- **manifest**：`package.json` → `"omp": {"extensions": [...]}`，legacy `"pi": {...}` 兼容（omp 键优先）；条目 `.ts/.js/.mjs/.cjs` 或目录（目录按自身 manifest → index → 单层扫描，TS 优先）。factory 契约与 pi 相同：默认导出函数（或模块本身是函数），可 async。
- **发现根**：项目 `<cwd>/.omp/extensions`、用户 `~/.omp/agent/extensions`、settings.json `#extensions`（cwd-only，无祖先目录遍历；**legacy `~/.pi/*` 不扫描**）→ hooks（`.omp/hooks/pre|post/`）→ 已安装插件 manifest 条目 → 显式 `-e/--extension`（`--hook` 是 `--extension` 别名）。
- **安装**：`omp plugin install <npm-spec|github:user/repo[#ref]|local-path|name@marketplace>`；用户根 `~/.omp/plugins/{package.json, node_modules/, omp-plugins.lock.json(0600)}`；项目根 `<anchor>/.omp/plugins/`（anchor=最近 `.omp/` 否则 `.git`），项目包 shadow 同名用户包。内嵌 Bun 跑 `bun install --no-cache`。**不是 pi 的 `~/.pi/agent/npm`**（`keywords: pi-package` 那套被本插件系统替代）。
- **features**：manifest `features: {name: {description, default}}`，spec 括号选择（`pkg[a,b]`），`omp plugin features <pkg> --enable/--disable` 持久化进 lockfile；feature 可贡献额外 extension/tool/hook/command 路径。
- **doctor**：`omp plugin doctor [--fix]` 校验安装；install 时每个 manifest extension 条目被真实 import + 用一次性 surface 初始化测试，失败回滚。
- **marketplace**：Claude-Code 兼容目录（`.omp-plugin/marketplace.json` 或 `.claude-plugin/`），`omp plugin marketplace add <owner/repo|url|path>`；状态在 `~/.omp/marketplaces.json` + `~/.omp/plugins/{installed_plugins.json, cache/}`。**文档无默认/官方 marketplace**；二进制 strings 里有 `skills.omp.sh`（Skillshare 技能市场，文档未载，未验证是否即插件注册表）。marketplace 来源的 npm spec 会被拒（"npm plugin sources are not yet supported"）；直接 npm 安装不受影响。
- **禁用**：`--no-extensions`（显式 `-e` 仍加载）、`disabledExtensions: ["extension-module:<derivedName>"]`（derivedName=路径 basename）、`--trusted-extension <abs>` 白名单模式（不能与 -e/--hook 同用）。
- 发布形态建议：**omp-harnmem 走 npm 包 + `omp plugin install omp-harnmem`**，开发期 `omp plugin link`；manifest 用 `"omp"` 键（不再依赖 legacy pi 键，语义清晰）。

## 5. 内置记忆系统与 omp-harnmem 定位

- `memory.backend`（`~/.omp/agent/config.yml` 或 `/settings`）**五选一，全部内置**：`off`（默认）/ `local`（项目级两阶段流水线：Phase1 逐会话提取 role=default，Phase2 汇总 role=smol 降级链；产出 MEMORY.md/memory_summary.md/skills/，session start 注入 "Memory Guidance" 块，`memories.summaryInjectionTokenLimit=5000`）/ `hindsight`（远程 http://localhost:8888，18 个 HINDSIGHT_* env 覆盖；首 turn 自动 recall 结果存 session file，每 3 个 user turn 自动 retain）/ `mnemopi`（本地 SQLite 图+事实+向量+时序融合召回，`packages/mnemopi`）/ `sharpshooter`（architecture/product/style 三个决策文件注入 system prompt，`sharpshooter.injectionTokenLimit=15000`）。
- **无第三方 backend 注册 API**：`src/memory-backend/resolve.ts` 是硬编码 dynamic-import switch；二进制 register* 全集中无 `registerMemoryBackend` → **omp-harnmem 不可能以 backend 身份接入，定位 = 普通插件**（system-prompt 注入 + 工具 + 命令）。
- 共存策略：默认 `off` → 无冲突；文档建议启用 harnmem 的用户保持 `off` 避免双重注入。互操作面：`ctx.memory.save` 对所有扩展可用，mnemopi 把扩展写入排为 "stated" veracity（最高权重）——未来可做 harnmem→omp 内置记忆的单向导出（非必需）。
- 相关配置命名空间：`memories.* / mnemopi.* / hindsight.* / sharpshooter.* / autolearn.*`（`autolearn.enabled` 开 `learn` 工具，写 managed-skills 下 learned.md）；记忆工作负载用 `modelRoles.memory`（默认本地小模型 lfm2-1.2b，`omp tiny-models` 可换）。

## 6. 会话数据面

- `ctx.sessionManager` 是 `ReadonlySessionManager`（`session-manager.ts:726` 的 `Pick`）：`getCwd/getRecordedCwd/getSessionDir/getSessionId/getSessionFile/getSessionName/getArtifactsDir/getEntry/getLabel/getBranch/getHeader/getEntries/getTree/getUsageStatistics/putBlob/...`。**`buildContextEntries` 已不在类型面**（运行时原型实测存在 `buildSessionContext`，见 §8）；需要消息投影时用 legacy shim 的 `sessionEntryToContextMessages(entry)`。
- 实测：sessionId=uuidv7；header=`{"type":"session","version":3,id,timestamp,cwd}`；getEntries/getBranch/getHeader 可用。
- **entry `message.role` 是 camelCase**（`toolResult` 而非 `tool_result`）——手写投影时 snake_case 会被静默丢弃。
- 插件状态持久化：`pi.appendEntry(customType, data)`（reverse-domain customType）写入 session file，resume 时可重建状态；`Command context` 另有 `waitForIdle/newSession/switchSession/branch/navigateTree/reload`。
- Command context 之外 omp 还有 `context` 事件（收会话消息、可返回 `{messages}` 改出站请求、不重写持久历史）——harnmem 不需要，留作参考。

## 7. pi-harnmem → omp-harnmem 移植清单（逐条裁决）

pi-harnmem@0.4.4 结构：`src/{index,command,config,context,format,journal,llm,log,state,subagent,tools}.ts`；构建 tsdown + `scripts/vendor-assets.mjs`；manifest `"pi":{"extensions":["./pi-harnmem.js"]}`。

| # | pi-harnmem 现状 | omp 适配 | 裁决 |
| --- | --- | --- | --- |
| 1 | `session_start` 带 `event.reason`（"session_start"\|"resume"） | payload 无 reason | **改**：resume = `session_start` 时 `sessionManager.getBranch().length > 0`（或 entries>0）推断 |
| 2 | `before_agent_start` 返回 `{systemPrompt}` | 同名同形状（`systemPrompt?: string[]`，实测字符串也接受） | **保留**，注入锚点不变；不锚 session_start（TUI 延迟加载时序不同） |
| 3 | `message_end` → journal.add | 同名（detached 快照） | **保留** |
| 4 | `session_before_compact` → refresh | 同名 + 可加 `session.compacting` | **保留 + 增强** |
| 5 | 会话切换靠 `adapter.start()` 推断 | 显式 `session_before_switch`/`session_switch`/`session_branch` | **改用显式事件**：switch→flushJournal(prev,"session_switch")，branch→快照重建 |
| 6 | `session_shutdown`：仅 reason==="quit" 才抽取，自限时 8s | 无 quit reason；预算 2s（并发） | **改**：自限时砍到 ~1.5s；抽取主路径移到 `session.compacting` + `session_before_switch`；shutdown 仅 best-effort flush+close（非正常退出丢最后一程 journal，与 pi quit≠quit 行为同源，可接受并在文档注明） |
| 7 | `before_provider_request` 做 debug 注入断言 | 同名；注意 `cache_warming_decision` 预热重放要求替换 payload 字节一致 | **保留**（只读断言安全，不改 payload 就不破坏预热） |
| 8 | 子代理检测：环境变量继承去重（`src/subagent.ts`） | `ctx.agent.depth>0` / `kind!=="main"` | **换**，更干净；`before_subagent_spawn` 可选用于子代理标签 |
| 9 | LLM 桥 `completeSimple` + `getApiKeyAndHeaders` | 字面量 import 被重写；鉴权门面在 | **保留**；`getApiKeyAndHeaders` 外包 typeof 守卫，fallback `ctx.runEphemeralTurn({dedupeReply:false})`；LLM 失败降级 log.warn 不炸会话（既有行为） |
| 10 | TypeBox schema（peerDep `typebox` ^1.3.27） | 裸 `@sinclair/typebox` 会被重写；**`typebox`（v1）裸名不会**；宿主给 `pi.typebox` | **换**：工具 schema 用 `pi.typebox.Type` 构建（工厂内惰性构建）；若 omptype 门面 API 不兼容再 vendor（.js 不含 TS 语法的约束同时满足） |
| 11 | `ctx.ui.setStatus("harnmem", ...)` 状态条 | 同签名 | **保留**；print 模式 hasUI=false 自动降级 |
| 12 | journal 状态机（`src/state.ts` Adapter，SHUTDOWN_EXTRACT_TIMEOUT_MS=8000） | 全部适用 | **保留**，仅 #1/#6 两处参数与触发面调整 |
| 13 | 打包 tsdown + vendor-assets | omp 用内嵌 Bun 加载插件 | **保留**（bundle 自含即可）；manifest 换 `"omp":{"extensions":["./omp-harnmem.js"]}`；peerDeps 可减（pi-ai 走重写、schema 走 pi.typebox；typecheck 期 devDep `@oh-my-pi/pi-ai` + `@oh-my-pi/pi-coding-agent` 取类型，实现时验证） |
| 14 | 分发 `pi install`（pi package 目录） | `omp plugin install`（`~/.omp/plugins/`） | **换**，见 §4 |

工程裁决：**独立包 `packages/omp-harnmem`**（与 dsh/claude/codex 等 provider 同模式），复用 `@harnmem/core`；不与 pi-harnmem 共包——运行时差异（#1/#5/#6/#8/#10）足以让双键共包变成条件分支沼泽。零运行时依赖红线不变（core 已满足）。

## 8. 未验证 / 待实现期确认

- `skills.omp.sh`（二进制 strings + 官网）是否为官方插件/技能注册表——文档只写 marketplace 机制，无默认 registry。
- 运行时 sessionManager 原型实测有 `buildSessionContext`（70+ 方法），类型层 `ReadonlySessionManager` 却是不含 `buildContextEntries` 的窄 `Pick`——以类型面为准做投影（shim 的 `sessionEntryToContextMessages`），不要依赖类型外方法。
- `getApiKeyAndHeaders` 在 omp 的精确签名（存在性已实证，参数形状未对照源码）。
- Windows 下 `?mtime` 缓存穿透在同进程热重载时不保证（POSIX 可以）——开发期建议每次冷启动 omp。
- mnemopi/hindsight/sharpshooter 三后端内部行为仅文档级；harnmem 与启用中的内置记忆并存的注入冲突未实测（建议文档直接要求 off）。
- omp TUI/RPC/ACP 模式下 `before_agent_start` 注入与 print 模式是否字节一致——本调研全部在 `-p` print 模式实证；TUI 待真机补验（风险低：注入语义在源码层是同一 policy 管线）。

## 9. 与其它 harness 形态对照（omp 在已调研序列中的位置)

| harness | 注入点 | 工具注册 | LLM 通道 | 插件形态 | 移植成本（相对 pi-harnmem） |
| --- | --- | --- | --- | --- | --- |
| **omp 18.14.1** | before_agent_start systemPrompt（追加语义，实证） | registerTool（TypeBox/宿主 schema） | pi-ai 重写直用 + runEphemeralTurn | omp manifest + plugin install（Bun 加载） | **最低**：同源 fork + 显式兼容层 |
| pi 1.3.0 | 同上（本源） | 同上 | completeSimple | pi extensions | 0（基准） |
| opencode v2 | session.hook("context") push system | tool.transform registry | ctx.generate.text | 域式插件（进程内） | 中（事件面重映射） |
| claude code | hooks AdditionalContext | MCP server | 无宿主通道（自带 API key） | plugin + MCP | 中高 |
| codex | hooks additional_context | MCP | 自带 | TOML 插件 | 中高 |
| cursor | hooks+rules 双通道 | MCP | 自带 | .cursor-plugin | 中高 |
| grok / hermes / dsh | 各自 hooks/扩展面 | 各异 | 各异 | 各异 | 高（已各自落地） |

## 附录 A：探针复现

- 探针目录：`%TEMP%\omp-probe\{index,index2,index3,index4,index5}.ts` + 日志 `probe*.log`；链接插件：`%TEMP%\omp-test-plugin\{package.json,index.js}`（`"pi":{"extensions":["./index.js"]}` + 默认导出工厂）。
- 复现命令：`omp -p --no-skills --no-rules --no-context-files -e <probe> "<prompt>"`；插件链路：`omp plugin link %TEMP%\omp-test-plugin` 后 `omp -p --no-skills --no-rules --no-context-files "PLUGIN_RUN3"`；卸载 `omp plugin uninstall omp-test-plugin`。
- 排障：插件加载失败静默降级，看 `~/.omp/logs/omp.<date>.<pid>.log` 的 `error` 行（"Failed to load extension / Failed to parse extension source for dependency rewriting"）。

## 附录 B：来源

- 运行时实证：本机 omp 18.14.1（`C:\Users\15652\AppData\Local\omp\omp.exe`），探针见附录 A。
- 仓库：https://github.com/can1357/oh-my-pi （`main` == v18.14.1，MIT）· release https://github.com/can1357/oh-my-pi/releases/tag/v18.14.1
- 文档（raw.githubusercontent.com/can1357/oh-my-pi/main/docs/）：extension-loading.md · extensions.md · memory.md · mnemosyne-memory-backend.md · plugin-manager-installer-plumbing.md · marketplace.md · custom-tools.md · user-facing-packages.md · hooks.md · sdk.md · settings.md · skills.md · cli-reference.md
- 关键源码（packages/coding-agent/src/）：`extensibility/plugins/legacy-pi-compat.ts` · `extensibility/legacy-pi-ai-shim.ts` · `extensibility/legacy-pi-coding-agent-shim.ts` · `extensibility/extensions/types.ts`（registerTool :1898 / before_agent_start 返回 :1733-1737 / RegisteredCommand :1769 / ui.notify :354 / setStatus :377 / ExtensionContext :746-897）· `memory-backend/{types(:79-83),resolve,runtime,off-backend}.ts` · `session/session-manager.ts(:726)` · `config/model-registry.ts(:3348)`；`packages/ai/src/stream.ts(:1054 complete)` · `packages/ai/src/index.ts`
- 本地缓存：`%TEMP%\omp-docs\`（文档 + `packages__` 前缀源码，可离线复查）。
