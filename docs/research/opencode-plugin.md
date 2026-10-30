# opencode 插件调研：opencode-harnmem 落地路径（2026-10-28）

> 结论先行：**可行，且是四个 harness 里形态最干净的一个**。opencode v2（本机二进制 v2.1.4 实测）的域式插件契约在**插件进程内**原生覆盖适配器契约的全部四层：`session.hook("context")` 注入 system、`tool.transform` 注册原生 5 工具、`session.hook("prompt")` 生命周期、`ctx.session.context({sessionID})` RPC 直接拿 transcript——**不需要解析任何落盘文件/数据库，不需要 MCP 子进程，不需要 detached 抽取进程**。唯一没走通的是 `ctx.mcp.transform` 动态注册 MCP（不需要，原生工具注册已通）；唯一待真机补验的是 TUI/server 模式下"会话结束"类钩子（idle 等）是否触发——本文给了不依赖它的抽取兜底设计。零运行时依赖成立：工具 args 接受纯 JSON Schema，不需要 zod。

## 1. 端到端实证（探针全链路，本调研最有价值的结果）

探针位于 `.tmp/oc-probe/`（独立 git root，`opencode run --standalone` + 模型 `opencode-go/glm-5.3-flash`）。复现方式见附录。

### 1.1 插件加载 ✅
- 目录扫描：`<project>/.opencode/plugins/*.{ts,js}`（**不认 `.mjs`**）；也支持 `opencode.json` 的 `"plugin": ["./pkg-harnmem"]` 引用本地包（package.json + main）——实测 26 域 ctx 交付成功；npm 包名引用同一入口（`opencode plugin add` 已真机验证，见 §8）。
- 文件插件 **必须** `export default { id, setup(ctx) | effect(ctx) }`。v1 风格函数导出与 `{id, server}` 均被拒，报错原文：
  `PluginModule.LoadError: Plugin must export a default definition with an id and an effect or setup function. (cause: SchemaError(Missing key at ["default"]["effect"]/setup))`
- `opencode run` 测试需要 `--standalone`（私有 server）且探针目录自己做 git root，否则 project/plugin 目录解析错位。
- `effect` 变体是 Effect-TS 签名；`setup` 接受普通 async 函数——**用 `setup`**。

### 1.2 system 注入 ✅（MANGOJUICE-77 端到端）
`ctx.session.hook("context", (inp) => { inp.system.push({type:"text", text}) })`：
- 回调载荷：`{sessionID, model:{id,providerID,variant}, system:[{type:"text",text}...]}`。
- **每个 LLM 请求触发一次**（一回合实测 5 次）；`system` 数组每请求从 4 个基础 part 重建，mutate-in-place 生效。
- 模型明确复述 marker 出现在它的 system prompt 里（注入成功）。
- KV-cache 含义：per-session 缓存注入字节，每请求 push **同一字符串** → 前缀稳定；base part 数稳定（实测恒为 4）。

### 1.3 原生工具注册 ✅（CONTENT-OK-42 端到端）
`ctx.tool.transform(reg => reg.add({name, description, args, execute}))`：
- registry 门面：`{list, get, namespace, add, update, remove}`；注册后 `ctx.tool.list()` 可见。
- **`execute` 必须返回 Promise**：同步函数返回字符串报 `t(o).then is not a function`（工具执行失败）。
- 返回形状：`{title, content:[{type:"text",text}], metadata}`。**不能带 `output` 字段**（报 `Tool result declared output without an output schema`）；`content` 数组才是模型读到的内容。
- `args` 接受**纯 JSON Schema 形状**（`{query:{type:"string",description:...}}`），参数照常送达（`ARGS-RECEIVED: "test"`）——零 zod 依赖成立。
- ToolContext：`{sessionID, agent, messageID, id, progress, signal}`。
- 坑：一次回归中 `reg.add` 少传 `name` 报 `TypeError: undefined is not an object (evaluating 'e.name.replace')`。

### 1.4 transcript / 会话元数据 RPC ✅（免解析抽取输入）
- `ctx.session.context({sessionID})` → **完整消息数组**：`[{id, time:{created,streamed,completed}, type:"user"|"assistant", text, files, agent, model:{id,providerID,variant}, content:[{type:"reasoning"|"text",text}...]}...]`。这就是抽取的 transcript 源——v2 已把会话迁进 SQLite（`~/.local/share/opencode/opencode.db`，WAL，运行中加锁，schema 内部），**插件根本不需要碰数据库**。
- `ctx.session.get({sessionID})` → `{id, projectID, model, cost, tokens{input,output,reasoning,cache}, time, location:{directory,...}}`——**每会话 cwd** 在这里（注入/抽取按会话目录解析项目配置用）。注意参数是对象 `{sessionID}`，传字符串报 `SchemaError(Expected object)`。

### 1.5 LLM 通道（可选，抽取用）✅（带保留）
`ctx.generate.text({prompt})` 是 harness 内 LLM 调用（与 `session.context` 同形 RPC 客户端）。调用形状可达，本 workspace 被 provider 隐私设置挡住（`Generate.UnavailableError: This Go model trains on request data. Allow paid endpoints that train on request data in your workspace's Privacy settings...`）——环境限制，非接口问题。**v0.1 不依赖它**：与 claude/codex 一致，openEngine 不注入 llm → 抽取返回 `no_llm`（journal 照写）；v0.2 可把它注入 openEngine 的 llm 位，失败降级 no_llm。

## 2. opencode 插件体系规格（本机二进制 v2.1.4 实测 + npm 现状）

- **三代契约并存，二进制 > 已发布类型 > 官方文档**：
  - npm `@opencode-ai/plugin` / `opencode-ai` latest = **1.19.5**（v1 契约：`export const X: Plugin = (input) => Hooks`，Hooks 全集含 `experimental.chat.system.transform` / `tool.*` / `event` / `chat.*` 等）。
  - npm 无 2.x 正式版；dev dist-tag = `0.0.0-dev-202610280534`，其**顶层导出仍是 v1 契约**；v2 只在 `v2/promise|effect` 子路径，且只有创作面（agent/catalog/command/integration/reference/skill 的 transform 注册），**没有 chat/tool/注入面**。
  - 本机二进制 v2.1.4 的 `setup(ctx)` 有 **26 个域**，远超已发布类型。官方 plugins 文档页还在写 v1。→ **本包以二进制实测契约为准，包内自写 JSDoc 类型**。
- `setup(ctx)` 26 域（关键项）：`app{name,version,channel}`（版本门）、`location{directory,workspaceID,project}`、`options`、`session{hook,list,create,get,remove,…,context}`、`tool{reload,list,transform,hook}`、`event{subscribe}`、`generate{text}`、`mcp{list,transform,reload}`、`storage{get,set,remove,scan}`、`permission`、`aisdk{hook}`、`shell{hook}`、`model/provider/agent/command/skill/reference/integration{…transform}`、`credential{activate}`、`rpc(fn)`、`vcs/websearch/worktree/experimental{…}`。
- **hook(name, cb) 是命名钩子且名字不校验**（乱名也注册成功）；实测触发：`session:prompt`、`session:context`、`tool:execute.before`、`tool:execute.after`。注册成功但 `run --standalone` 全程未触发：`session:idle/message/finish/end/close/stop/complete/response`、`event.subscribe`（零事件送达）。
- `tool:execute.after` 载荷含 `{tool, sessionID, agent, messageID, id, input, status, result:{output{exit,truncated,output,status}, content[], metadata}}`——如果将来需要逐工具 journal 增量，这是备用信号源。
- MCP 动态注册：`ctx.mcp.transform(draft => draft.add({name, type:"stdio", command, args, enabled}))` 接受但服务器未连接（工具没出现在目录）。不需要追——原生工具注册已通；若要 MCP 兜底，走 `opencode.json` 的 `"mcp"` 配置（文档化路径）。

## 3. 会话数据面（抽取的输入）

- v2 会话落盘 = SQLite（本机 `opencode.db`，`session_v2/session_message/event` 等表，WAL）；**运行中加锁、schema 无稳定性承诺 → 明确不解析**。
- 抽取输入改走插件内 RPC：`session.context({sessionID})` 拿消息数组 → 喂 `eng.sessionEnd({sessionId, cwd, reason, messages})`；core 侧 journal 总是落盘，无 llm 时返回 `no_llm`（与 claude/codex 完全同构）。消息按 core 惯例截断（≈4000 字符/条、≤400 条）。
- 每会话 cwd 从 `session.get().location.directory` 取，不用进程 cwd（多 worktree 场景安全）。

## 4. 与 claude-harnmem / codex-harnmem 的形态对照

| 维度 | claude | codex | opencode v2（本调研） |
|---|---|---|---|
| 安装 | settings/marketplace | `marketplace add` | **`opencode plugin add opencode-harnmem`**（v2 自带插件管理；或 `opencode.json` 写 `"plugins"`/`"plugin"`，或丢 `.opencode/plugins/*.js`） |
| 插件契约 | hooks 脚本 (JSON stdin/stdout) | hooks + MCP + skill | 进程内 `default {id, setup(ctx)}` 域式 API |
| 注入 | SessionStart hook `additionalContext` | hooks `additional_context`（developer message） | `session.hook("context")` push system part（每请求，字节可稳定） |
| 工具 | MCP stdio 子进程 | MCP stdio 子进程 | **原生 `tool.transform` 注册，零子进程** |
| 生命周期 | SessionStart/SessionEnd | SessionEnd（1–3s 超时→detached 抽取） | `session:prompt/context` 实测；idle 类未证实（见 §6） |
| transcript | 解析 `~/.claude/projects/*.jsonl` | 解析 rollout jsonl | **`session.context` RPC，免解析** |
| 抽取 LLM | 无（no_llm） | 无（no_llm） | **`ctx.generate.text` 可选注入** |
| 抽取触发 | SessionEnd + detached 子进程 | 同左（超时规避） | 逐轮 journal + 下次会话补抽取 + exit flush（见 §5） |

## 5. opencode-harnmem 架构建议（四层映射）

包：`packages/opencode-harnmem/`，pnpm workspace，零运行时依赖，`scripts/vendor.mjs` 模式 vendor `packages/core/dist`（与 claude/codex 相同）。

**直接复用**（从 claude-harnmem 拷贝改名）：`lib/engine.mjs`（`openEngine(settings, {sessionId, cwd, readOnly})`，harness id 传 `"opencode"`；SCHEMA_NEWER → 只读重开）、`lib/settings.mjs`（env `HARNMEM_*` > `~/.harnmem/config.json` > `<project>/.harnmem.json`）、`lib/format.mjs`（5 工具结果格式化）。

**新写**：单文件插件入口 `index.js`，`export default { id: "opencode-harnmem", setup(ctx) }`：

1. **Injection**：`session.hook("context")`。per-sessionID 状态机：新 session → `eng.sessionStart()`；首请求 → `eng.ensureContext("session_start")` 拿字节并**缓存**（同 session 内每请求 push 同一字节串；reason 固定，避免版本字节漂移毁 KV）。守约：`HARNMEM_INJECT=0` / 只读 / SCHEMA_NEWER → 不 push。
2. **Tools**：`tool.transform` 注册 `memory_write/search/read/forget/status`，args 纯 JSON Schema（含 description；importance/confidence 用 number + description 说明范围，engine 侧已有防御性 clamp），execute → `eng.<op>` → `format`；eng 为 null（disabled）时返回友好 content。5 个 name 与其它 harness 严格一致（注入字节稳定的前提）。
3. **Lifecycle/Journal**：
   - `session.hook("prompt")`：记录 sessionID 活跃 + `session.get` 取 cwd；顺带做**补抽取**（读 core journal 里 pending 会话——兜底 run 模式没有"会话结束"钩子）。
   - `session.hook("context")`：每请求（或节流到每 prompt）`ctx.session.context({sessionID})` → 截断 → `eng.sessionEnd({sessionId, cwd, reason:"turn", messages})` 追加 journal（no_llm 则只 journal）。失败静默不阻塞会话（契约：提取有界不阻塞）。
   - 收集每个注册返回的 `{dispose}`（暂不返回给宿主——v2 setup 返回值语义未探明）；`process.once("exit")` 里 close 全部引擎。注意：exit 事件只跑同步代码，core `close()` 的异步 usage flush 在 exit 阶段必丢——无实害（journal/记忆都在操作时即时落盘，close 只刷 advisory 计数），该 handler 是尽力而为姿态，不是持久化机制（评审更正，见 §7.2 m1）。
4. **抽取 LLM（v0.2 可选）**：`llm: async (prompt) => (await ctx.generate.text({prompt})).text`（形状以实现期实测为准）注入 openEngine；try/catch → 降级 `no_llm`。
5. **版本门**：`ctx.app.version` < 2 → 不注册任何东西并 console 提示（v1 契约完全不同，不做双形态兼容——两套 hooks 实现维护翻倍，README 声明需要 opencode ≥ 2.x）。
6. **不做**：transcript 文件解析器、MCP 服务器文件、detached 抽取子进程、mcp.transform。

实现期验收（对齐 adapter-authoring 清单）：注入字节稳定（两轮 run 的 system diff 为空）、5 工具全通、SCHEMA_NEWER 降级只读、`HARNMEM_DISABLED=1` 全静默、journal 在 no_llm 下仍落盘、崩溃/kill 后下次会话能补抽取。

## 6. 风险与现状

- **TUI/server 模式的"会话结束"钩子仍未验证**（调研与实现期都用 `run --standalone`：idle/message/finish 未触发、event 零送达）。用户日常是 TUI——v0.2 第一件事在真机 TUI 里验证 idle 类钩子；现状兜底 = 逐轮 journal（末轮缺口见 §7.1）。
- **npm 包加载路径**（`"plugin": ["opencode-harnmem"]` 走 Npm resolution）未实测；本地包路径已真机通过，同一入口，低风险。
- **契约无类型可依赖**：v2 域式 API 超前于 `@opencode-ai/plugin` dev 快照的发布类型；包内自写 JSDoc + 全部 `?.`/try-catch 防御 + hook 名常量集中一处，跟 dev 通道（dev tag 每日出快照）。
- **`session:context` 每请求触发**：注入文本按 sessionID 缓存（字节稳定），journal 按 transcript 签名去重，均不受多次触发影响（真机 trace 证实）。
- **generate.text 的坑**：workspace 级隐私设置可能挡默认模型（本机已遇）；v0.2 前不依赖，且必须可降级。
- opencode 版本碎片化（npm latest 1.19.5 vs 二进制 2.x）：版本门 + README 写清要求，低版本不加载。

## 7. 实现期真机验收记录（2026-10-28，opencode v2.1.4，`packages/opencode-harnmem` v0.1.0）

单测 12/12（`pnpm --filter opencode-harnmem test`；评审后从 11 增至 12，见 §7.2）。真机跑法：探针目录 `.tmp/oc-probe/`（独立 git root + `opencode.json` 指向 `./pkg-harnmem` 副本），`opencode run --standalone -m opencode-go/glm-5.3-flash`。

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 插件加载（`default {id,setup}`） | ✅ | trace: `setup.done {"disposers":3,"version":"2.1.4"}` |
| 版本门 | ✅ | mock 1.19.5 → stderr 一行 "not loaded"，零注册 |
| 注入（空 store） | ✅ 零字节 | `session-start {"bytes":0}`，模型只能从工具描述认出 harnmem |
| 注入（真实数据） | ✅ | 未设 HARNMEM_HOME 时回落真实 `~/.harnmem`，模型逐条复述真实置顶记忆（SSOT/时区/决策风格/TypeSafe…） |
| 写→注入跨回合成环 | ✅ | turn 1 `memory_write` NEW → turn 2 `session-start {"bytes":259,"ids":1}` |
| 工具真机调用 | ✅ | memory_write / memory_search / memory_status 均被模型调用并返回结构化结果 |
| 错误兜底文案 | ✅ | 缺 description → `memory_write failed: memory_write requires a description`（文本，不炸会话） |
| 逐轮 journal | ✅ | 多回合：`sessions/<date>/opencode_<ses>.jsonl` 592–608B，role/text/ts 正确；no_llm 下照写 |
| 空回合跳过 | ✅ | 首 prompt 时 `messages:0` → core `status:"skipped"` |
| store 布局 | ✅ | `memories/user/MEMORY.md + mem_*.md`，与其它 harness 同构 |
| 子会话只读 | 单测 ✅ | 真机未单独构造 subagent（parentID 路径与 TUI 相关） |

### 7.1 实现期发现（与探针期结论的差异/补充）

- **prompt 钩子载荷**（实测）：`{sessionID, messageID, prompt:{text,files}, metadata, delivery}`，argc=1，单参数；`sessionID` 是字符串。context 钩子 a0 keys：`[sessionID, model, system, messages, options, agent, tools]`。
- **单回合 CLI 会话不产 journal**：prompt 钩子在当轮消息落库**之前**触发，"journal 上一轮"设计在单轮 run 里永远捕到 0 条 → core 跳过。多回合（`--continue` 同 session）才逐轮落盘。**已知缺口：每个会话的最后一轮永远不会被 prompt 钩子 journal**（无可靠 end/idle 钩子，见 §6）；TUI 长会话损失有限（只有末轮），跨 session 不补。
- **opencode 吞掉插件进程的 stderr**：`HARNMEM_DEBUG=1` 的 `[harnmem:debug]` 行不可见（TUI 静默化）。诊断期用"debug 镜像写文件"定位（`.tmp/oc-probe/.opencode/harnmem-trace.log`）；正式包只走 stderr，需要诊断时用环境变量 + 外部 file 重定向或临时 patch。
- **`~` 展开修复**（codex 评审 M2 同款）：`resolveSettings` 对 `HARNMEM_HOME`/config `home` 先做 `~` → `os.homedir()` 再 `path.resolve`，否则 `~/x` 被解析成 `<cwd>\~\x`。opencode 版已修（lib/settings.mjs `expandHome`），claude/codex 同源代码待同步。
- 工具入参裸值（非 object）确实出现 → `normalizeArgs` 把标量包到单必需键、数组丢弃，真机无碍。

### 7.2 发布前 code review（2026-10-28，两名独立 reviewer 交叉）

结论：**0 BLOCKER；MAJOR 3 条（全部已修）；MINOR 16 条（2 条当场修，其余记录在案延后）**。单测 11 → **12/12**（新增注入瞬时失败重试用例 + 子会话/主会话引擎隔离回归用例）。

已修的 MAJOR（均为评审实证后修复）：

| # | 问题 | 修法 |
| --- | --- | --- |
| M1 | engines Map 只按 cwd 键控：子会话（parentID）先调任一 memory 工具 → 只读引擎按 cwd 缓存 → 主会话 `memory_write` 拿到只读引擎整进程报错（反向：主会话先开可写，子会话就能写） | 引擎键改为 `` `${ro\|rw}:${cwd}#${sessionId}` ``，每会话独立引擎；顺带修好 provenance 串扰与 `modelWrites/extracted` 跨会话泄漏（原 M2'），MAX_ENGINES 4→8，命中重插 = 真 LRU，open promise 去重防并发双开 |
| M2 | `sess.injectText=""` 在引擎打开**之前**赋值：首请求 openEngine 瞬时失败（文件锁/竞态）→ 空串永久缓存，该会话注入从此静默消失 | 引擎路径只在成功后赋值；失败留在 `undefined` → 下次请求自动重试（新增回归测试） |
| M3 | `Number(x)\|\|0` clamp：模型发 `null`/"abc" 时 importance/confidence 静默归 0，覆盖 core 默认值（5/0.7） | clamp-and-drop：非有限数值一律删除字段，让 core 默认生效（新增断言） |

当场修的 MINOR：`CATEGORIES` 漏 `"preference"`（core MemoryCategory 合法值，HarnMem 自身记忆就在用）；`corePromise` 失败被永久缓存 → 失败即清除允许重试；`format.mjs` shards 加 `Array.isArray` 守卫（对齐 codex 版）；vendor.mjs 补拷 `prompts/` + `data/` 进 `vendor/core`（否则 npm 安装形态 `findAssetRoot` 落空 → 抽取提示词退化 + 同义词表退化到 6 组内置默认，中英召回静默下降；已实证 `findAssetRoot()` → `vendor/core`、synonyms 2 份可达）；config 文件布尔字符串矫正（`"enabled":"false"` 现在真的禁用）+ config `maxInjectTokens` 数值校验；package.json 加 `prepublishOnly` 门禁；mock `sessionEnd` 返回值对齐 core 真实形状（`skipped/auto_extract_off`）。

记录在案、延后处理的 MINOR：sessions Map 进程级无淘汰（条目小）；disposers 收集但不对宿主返回（setup 返回值语义未探明，热重载场景才相关）；SCHEMA_NEWER 降级为前向兼容死代码（当前 core 无此错误码）；缺 `time.created` 的消息在 journal 里会以 `Date.now()` 逐轮取新值导致重复追加（probed 契约下 opencode 恒带 time.created，不触发）；settings 进程级缓存不响应运行中翻转（合理约定，已注释）；setup 测试读开发者真实 `~/.harnmem/config.json`/env（仅影响该用例，无生产影响）。

另：两名 reviewer 独立收敛到同一组结论（引擎键控、exit handler 语义、FIFO 伪 LRU、single-flight 缺失、prepublishOnly 缺失），交叉可信度高。

## 8. 遗留待办

- v0.2：`ctx.generate.text` 注入抽取 LLM（形状已探明，等隐私策略问题有结论）；exit flush / 末轮 journal 兜底（等 session 域 end/idle 钩子稳定后接入）。
- claude-harnmem / codex-harnmem 同源同步（评审发现的同款问题）：`~` 展开修复、vendor 补拷 prompts/data、exit handler 注释更正、config 布尔矫正、format shards 守卫、engines 键控评审（claude 每调用开新引擎天然无此问题，codex 需核对）。
- npm 包名安装路径（`"plugin":["opencode-harnmem"]`）待 opencode 2.x 发上 npm 后实测。
- 7.2 记录在案的 MINOR 随下个版本处理。

**已关闭**：npm 包名安装路径已真机验证（2026-10-30，opencode 0.1.0 发布后）。正确姿势是 **`opencode plugin add opencode-harnmem`**——v2.1.4 自带插件管理命令（`plugin add/list/check/update/remove`，文档页完全没写），add 会安装 npm 包并把 `"plugins": ["opencode-harnmem"]` 写进**全局** `~/.config/opencode/opencode.json`。两个此前未知的细节：① 全局配置的键是**复数** `plugins`，项目级探针用的单数 `"plugin"`，二进制两者都认；② 装完全局插件后任何目录的会话都会加载（含隔离 HARNMEM_HOME 的全新目录，实测 `memory_status` 真实调用返回 "1 shard, currently empty"，npm 包内 vendor/prompts/data 完整）。

## 附录：探针产物与可复现命令

- 目录：`.tmp/oc-probe/`（独立 git root）：`.opencode/plugins/probe-v11.js`（最终探针：注入+工具+args）、`opencode.json`（`"plugin": ["./pkg-harnmem"]` 安装路径验证）、`pkg-harnmem/`（本地包形态）、`mcp-echo.mjs`（最小 stdio MCP）、`probe-log.jsonl`（全部实证日志）。
- 复现：`cd .tmp/oc-probe && opencode run --standalone -m <model> "<让模型调用探针工具的指令>"`，读 `probe-log.jsonl`。
- 教训清单：`.mjs` 后缀不加载；`run` 必须 `--standalone` + 探针目录自带 git root；验证注入必须让 secret 不落盘（PINEAPPLE-42 假阳性教训，MANGOJUICE-77 才是干净实证）；工具 `execute` 必须 async；结果不能带 `output` 字段；`session.get` 参数是对象。
