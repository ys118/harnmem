# Claude Code 插件调研：harnmem 适配器落地路径（2026-10-26）

第一手实测环境：Claude Code **2.1.310**（`c:\users\15652\.local\bin\claude.exe`），Windows 11，PowerShell 5.1。
结论先行：**docs/design/09-claude-adapter.md 的技术路线（hooks + MCP stdio）全部实证可行，且落地形态应从"手工写 settings.json + mcp add"升级为"原生插件包"**——这是官方一等公民形态，安装一条命令、卸载干净、可进官方市场。

---

## 1. 两项端到端实证（本调研最有价值的结果）

在临时目录搭了一个最小骨架插件并真实跑通：

### 1.1 SessionStart hook → additionalContext 注入到模型 ✅

骨架：`hooks/hooks.json` 注册 SessionStart command hook（`node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"`），
脚本读 stdin、输出 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"...HARNMEM_TEST_MARKER_12345..."}}`。

```
claude --plugin-dir <dir> -p "Do you see HARNMEM_TEST_MARKER..."
→ YES HARNMEM_TEST_MARKER_12345: user prefers pnpm over npm.
```

**注入链路 完整可用**。这直接验证了 09 设计的核心机制。

### 1.2 插件内 .mcp.json → stdio MCP server → 工具调用 ✅

骨架：根 `.mcp.json` 声明 `{"harnmem2":{"type":"stdio","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/mcp/mcp.mjs"]}}`，
mcp.mjs 是 ~50 行零依赖 JSON-RPC stdio server（initialize/tools/list/tools/call）。
模型成功调用工具并返回 `harnmem MCP TEST OK — store reachable`。

两个坑：
- **MCP 连接失败会被缓存 15 分钟**（"Skipping connection (recent failure cached…)"）。首次失败（当时 mcp.mjs 还没写）后，即使补上文件也不会重连。开发期换 server 名可绕开；发版前必须保证首连成功。
- 插件内 MCP server 的全名带前缀：报错显示 `plugin:harnmem-test:harnmem`，即 `plugin:<插件名>:<server键>`。09 设计里"工具名模型侧为 mcp__harnmem__<tool>"在**插件场景**应为 `mcp__plugin_<插件名>_<server>__<tool>` 形态（下划线化）。对模型侧无实际影响（按描述找工具），但文档要更新。

### 1.3 会话验证命令（可复用）

```powershell
claude --plugin-dir <插件目录> -p "..."
claude plugin validate <插件目录>     # 结构校验，含目录收录子集检查
```

---

## 2. Claude Code 插件体系（2.1.310 实测结构）

```
<plugin>/
├── .claude-plugin/plugin.json   # 最小 {name, description, author}；可选 version/license/keywords/repository 等
├── hooks/hooks.json             # 默认路径自动发现——plugin.json 无需声明 hooks 字段（hookify 实例）
├── hooks/*.mjs                  # hook 脚本，${CLAUDE_PLUGIN_ROOT} 由宿主展开
├── .mcp.json                    # 根目录，MCP servers（stdio/http）
├── commands/*.md  skills/*/SKILL.md  agents/*.md   # 可选组件
├── README.md                    # 目录收录要求 ≥40 词
├── LICENSE                      # 或 plugin.json 的 license SPDX 字段
└── .claude-plugin/icon.png      # 可选：方形 512–2048px <2MB，SVG/WebP 不收
```

要点：
- **hooks/hooks.json 是默认路径**，不写进 plugin.json 也会加载（hookify 佐证）。
- `${CLAUDE_PLUGIN_ROOT}` 在 hooks 与 .mcp.json 的 args 里都会展开 → **适配器包可以自带 dist 产物，用绝对路径引用自己**，符合 09"装后用绝对路径、不用 npx"的决策。
- `claude plugin validate`：任何 JSON 带 **UTF-8 BOM 直接拒载**（plugin.json 坏 = 整个插件加载失败）。README <40 词、缺 LICENSE 会在目录检查报 warning（不阻断本地加载）。
- **开发回路**：`claude --plugin-dir <path>`（可重复、支持 .zip）单会话加载，无需安装。修改即生效（每次 claude 启动重读）。
- **安装**：`/plugin install <name> --marketplace <owner>/<repo>`（2.1.275+），marketplace 即一个含 `.claude-plugin/marketplace.json` 的 git 仓库：
  ```json
  { "name": "ys118", "owner": {"name": "ys118"},
    "plugins": [{ "name": "harnmem", "description": "...", "source": {"source": "git-subdir", "url": "https://github.com/ys118/harnmem.git", "path": "packages/claude-harnmem"} }] }
  ```
  官方市场 claude-plugins-official（本地有 clone，315 个插件）就是这个 schema；`source.path` 支持指向 monorepo 子目录 → **harnmem 主仓可以同时是插件市场**。
- `claude plugin init <name>` 会脚手架到 `~/.claude/skills/<name>/`（以 skills-dir 形态自动加载）——适合试验，不适合正式产物。

### Windows / 工具链坑（实测踩到）

1. **PowerShell 5 `Set-Content -Encoding UTF8` 默认写 BOM** → plugin.json/hooks.json/.mcp.json 全部拒载。必须 `[IO.File]::WriteAllText($f, $c, (New-Object System.Text.UTF8Encoding($false)))`。发插件时用 node/CI 写文件，或提交前跑 validate。
2. PowerShell 5 `ConvertFrom-Json` 遇到仅大小写不同的重复键直接报错（官方 marketplace.json 就触发）——解析这类文件用 node。
3. claude.exe 在 PATH（`~/.local/bin`），hook command 里直接写 `node ...` 即可。

---

## 3. remember 插件（Digital-Process-Tools/claude-remember）先例解剖

官方市场在列（v0.44.1），Python+bash 实现，**与 harnmem 完全同构**：SessionStart 注入 + SessionEnd 抽取 + UserPromptSubmit/PostToolUse 参与。它踩过的坑是 09 设计未覆盖的实战盲区：

### 3.1 #561：插件 hook 的 timeout 声明不生效

hooks.json 里写 `"timeout": 10`，官方市场审核仍看到每次退出都 "Hook cancelled"。remember 的解法：**SessionEnd hook 一进来把真实工作 respawn 成 detached 的自身副本，然后立即 exit 0**：

```bash
nohup bash "${BASH_SOURCE[0]}" </dev/null >/dev/null 2>&1 &
disown; exit 0
```

Node 等价（claude-harnmem 应采用）：
```js
// hook.mjs 入口（SessionEnd）：立即分离真实工作
if (!process.env.HARNMEM_EXTRACT_PHASE) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--phase=extract", stdinSnapshotPath], {
    detached: true, stdio: "ignore", env: { ...process.env, HARNMEM_EXTRACT_PHASE: "1" },
  });
  child.unref();
  process.exit(0);   // 绝不等抽取完成
}
```
09 设计的"spawn detached 子进程跑 sessionEnd"由此从"应该这么做"升级为"唯一可行做法"——同步抽取哪怕 800ms 也可能被宿主取消并计入审核指标。

### 3.2 #646：后台子进程继承 hook 的 stdout 管道 → SessionStart 卡 98 秒

hook 后台化的子进程若持有 stdout 写端，宿主读管道到 EOF 会一直等到子进程结束（实测 98.62s，触发 VS Code 60s 子进程上限）。修复：重定向 + 关闭多余 fd（`</dev/null >/dev/null 2>&1 3>&- & disown`）。
Node 版只要 `stdio: "ignore"`（三通道全 ignore）+ `detached: true` + `unref()` 天然安全。**claude-harnmem 所有 spawn 必须过这条**，并加回归测试（hook 进程退出后管道立刻 EOF）。

### 3.3 #342：SessionStart source 高频重复

`compact` source 50 会话触发 82 次（对比 startup 180 次）——mid-session 压缩也会走 SessionStart。harnmem 的抽取触发/ consolidation 触发必须按 source 门控（`startup|resume|clear|fork` 触发，`compact` 只重建快照不触发抽取），09 的 matcher 设计与此一致，但要在实现里显式断言。

### 3.4 其他可直接吸收的做法

- **渲染缓存**（#668）：注入块渲染结果落盘缓存，只在 memory 写入/consolidation 后失效——与 harnmem 的 KV-cache 字节稳定原则同构，harnmem 的 ensureContext 已内置，无需额外层。
- **字节预算**：注入体截断上限 `_REMEMBER_SESSION_START_MAX_BYTES`，与 09 的 1,200 token/10,000 字符双上限一致。
- **会话级文件命名**：跨并发会话共享路径会被 last-writer-wins 覆盖（#738），落盘文件一律带 `.<session_id>` 后缀；清理用"transcript 是否存在 + mtime > 5min 宽限"三态判断（#393：transcript 缺失 ≠ 会话已死，SessionStart 先于 transcript 创建）。
- **输出通道互斥**：`additionalContext`（进模型）与 `systemMessage`（进人眼）可以共存于一个 JSON 输出；纯文本 stdout 是第三种形态（整个当 additionalContext）。remember 只在 SessionStart 用 systemMessage（营销位），因为 per-turn 通道会"偶尔变常态"。
- remember 的 hook 是 bash 单文件 28.7KB（还有 120KiB 上限的内部预算规则）+ 依赖 python3/jq，Windows Git Bash 上每个子进程 50–200ms。**harnmem 用 node + @harnmem/core（零依赖、单进程）在启动成本和跨平台上都严格更优**。

---

## 4. 对照 09 设计：证实 / 修正 / 新增

| 项 | 状态 | 说明 |
|---|---|---|
| hooks + MCP stdio 双扩展点路线 | ✅ 证实 | 两链路端到端跑通（§1） |
| SessionStart 注入 additionalContext | ✅ 证实 | 含 JSON 输出形态 |
| SessionEnd detached 抽取 | ✅ 升级 | #561：timeout 不生效，respawn+exit0 是唯一解（§3.1） |
| compact 门控 / 注入字节稳定 | ✅ 证实 | #342/#668 独立殊途同归 |
| 安装方式（手写 settings.json + claude mcp add） | 🔄 修正 | 改为原生插件包 + marketplace；09 的安装章节整体替换 |
| hooks 写 ~/.claude/settings.json | 🔄 修正 | 插件形态下 hooks/hooks.json 自带，无需动用户 settings |
| MCP 工具名 `mcp__harnmem__<tool>` | 🔄 修正 | 插件场景前缀为 `mcp__plugin_<plugin>_<server>__<tool>` |
| 新包名 @harnmem/mcp（bins harnmem-mcp/hook） | 🔄 修正 | 建议包名 `claude-harnmem`（仓库惯例 `<harness>-harnmem`，pi-harnmem/dsh-harnmem 同型），bin 不再必需 |
| BOM / 失败缓存 / README/LICENSE/ icon | ➕ 新增 | §1.2、§2 坑清单，进 CI 与发布 checklist |
| PreCompact/PostToolUse/UserPromptSubmit 细节 | ⏳ 待验证 | 09 已对官方文档验证；本轮未实测（优先级低） |

### 建议包结构（packages/claude-harnmem）

```
packages/claude-harnmem/
├── .claude-plugin/plugin.json        # name "harnmem"，description，author，license "MIT"
├── hooks/hooks.json                  # SessionStart(matcher startup|resume|clear|compact|fork) + SessionEnd + PreCompact
├── hooks/hook.mjs                    # 读 stdin → core.open → ensureContext → JSON 输出；SessionEnd 分离抽取（§3.1）
├── .mcp.json                         # stdio: node ${CLAUDE_PLUGIN_ROOT}/mcp/mcp.mjs
├── mcp/mcp.mjs                       # 5 工具 harnmem_search/read/write/forget/status（语义对齐 07 契约）
├── README.md LICENSE.md .claude-plugin/icon.png
└── test/                             # fake 驱动（参照 packages/dsh-harnmem/test/fake-dsh.mjs 模式）
```

marketplace 侧：主仓根加 `.claude-plugin/marketplace.json`（或独立 harnmem-marketplace 仓），`source: git-subdir + path: packages/claude-harnmem`。发布前跑 `claude plugin validate` 进 CI。

---

## 5. 遗留待验证（2026-10-27 复核：1/4/6 已关闭，其余降级为低优先级观测项）

1. **子代理语义 — ✅ 已关闭（2.1.310 实测）**：Task 子代理**完全不触发** SessionStart/SessionEnd hook（沙箱库 audit.jsonl 只有主会话的 1 次 inject + 1 次 extract，子代理回复 SUBAGENT-OK-42 期间零 hook 事件）。只读契约天然成立；`agent_type`/`isSidechain` 守卫保留为未来版本安全网。子代理 transcript 以 sidechain 形式并在主会话内，解析层已跳过。
2. **PreCompact 输入/输出实测**：v1 不注册 PreCompact（compact 后重发 SessionStart(source=compact) 已重建快照），关闭此观测项的必要性随之消失。
3. **UserPromptSubmit recall 的成本**：默认关闭（HARNMEM_CLAUDE_RECALL=off）的决策保持，待有真实需求再实测。
4. **MCP 25k token 输出上限 — ✅ 已关闭（防御实现）**：`lib/format.mjs` 每个 formatter 输出 clip 在 12k 字符（与 pi 完全对齐），`mcp/mcp.mjs` 的 `textResult` 对错误路径再兜底同一上限；12k 字符 ≈ 3–12k token，即使 CJK 满载也远低于 25k-token 客户端上限。回归测试 `test/format.test.mjs`（50 个 64KB 命中、64KB 单条、400 分片 stats 均不越界）。
5. **resume 重放 additionalContext** 的 staleness 表现（09 已设计免责行，实测确认渲染位置）。
6. **monorepo marketplace 的 GitHub 拉取 — ✅ 已关闭（真机验证）**：`claude plugin marketplace add ys118/harnmem` → HTTPS clone → 校验根 `.claude-plugin/marketplace.json` → `plugin install harnmem@harnmem-marketplace` 全绿。前置条件：仓库已推送（未推送时 clone 为空目录，报 "Marketplace file not found"）。验证后已还原本地 path marketplace（live checkout 开发模式）。

## 6. 实现（packages/claude-harnmem，2026-10-26 落地）

§4 建议的包结构已按原样实现并全部真机验证（Claude Code 2.1.310，Windows 11）。差异与最终事实：

- **PreCompact 未注册**（推翻 §2 结构里的初稿）：Claude Code 压缩后保留 transcript 文件并重发 `SessionStart(source=compact)`，快照自然重建，无需 cursor 交接；per-turn hook 均缓普适性差，UserPromptSubmit recall 同样推迟（`HARNMEM_CLAUDE_RECALL` 预留）。
- **SessionEnd 抽取链**：hook 写 payload 到 `%TMP%/harnmem-claude/session-end-<sid>-<ts>.json` → `spawn(process.execPath,[self,"--extract-phase",payload],{detached:true,stdio:"ignore"})` + `unref` + 立即 exit 0（§3.1/#646 双保险）；extract 阶段解析 transcript（跳过 `isSidechain`、取尾部 400 条、单条截 4000 字符）→ core `sessionEnd`；`HARNMEM_EXTRACT_SYNC=1` 为确定性测试缝。子代理（`agent_type` 非空）连 journal 都不写。
- **MCP server**：`mcp/mcp.mjs` 零依赖 JSON-RPC 2.0 ndjson；工具 `memory_search/read/write/forget/status`，模型侧全名 `mcp__plugin_harnmem_harnmem__memory_*`。**协议坑**：响应必须带 `{jsonrpc:"2.0",id,...}` 信封（初版裸返回导致 id 配对失败，任何标准客户端都会超时）——测试按 id 配对直接暴露了它。
- **`/memory` 命令实际是 `/harnmem:memory`**：插件命令带 `<plugin>:<command>` 命名空间；frontmatter 用 `allowed-tools` 白名单五个 MCP 工具，`$ARGUMENTS` 路由 search/read/write/forget/status。裸 `-p "/memory ..."` 会得到 "isn't available in this environment"。
- **测试**：8 个确定性测试（`node --test packages/claude-harnmem/test/*.test.mjs`）——空库 0 字节注入、跨进程字节稳定、10k 字符上限、disabled、SessionEnd SYNC 缝 + journal 落盘 + payload 清扫、子代理只读、畸形 stdin exit 0、MCP e2e（initialize/tools list/中文写入+bigram 搜索/status/-32601）。根 `pnpm test` 已串入。
- **vendor**：`scripts/vendor.mjs` 把 `@harnmem/core/dist` 拷进 `vendor/core/`（72 文件），marketplace git-subdir 安装即自包含。动态 import 必须 `pathToFileURL`（Windows `d:\` 盘符不是合法 ESM URL）。
- **真机 e2e 三连（全 √）**：① `claude --plugin-dir ... -p` 下 SessionStart 注入 marker，模型原样复述 `MARKER-8842-OK`；② 模型调用 `memory_write` 返回 `stored mem_01M5WBB64XXMYNBPV89H (NEW)` 且记录落盘 `<home>/memories/projects/.../<id>.md`；③ `/harnmem:memory search` 命中表格输出。`claude plugin validate` √（仅 icon 可选 warning）。

## 7. 参考

- 本机实测：`%TEMP%\harnmem-cc-plugin-test`（骨架插件，validate √ + 两项 e2e √）
- remember 源码：github.com/Digital-Process-Tools/claude-remember（浅克隆至 %TEMP%\claude-remember-src；#561/#646/#342/#668/#738 均为其仓库 issue/PR 编号，见源码内注释）
- 官方市场 clone：`~/.claude/plugins/marketplaces/claude-plugins-official`（marketplace.json schema 实例）
- 既有设计：docs/design/09-claude-adapter.md、docs/design/07-adapter-contract.md、docs/adapter-authoring.md
