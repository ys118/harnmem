/**
 * Browser-half regression tests for `dist/client.js` (the DSH web plugin bundle).
 *
 * The DSH web runtime loads plugin clients as a CommonJS closure factory:
 *
 *   window.__ModuleLoader__.load({ id: "dsh-harnmem", factory: (require) => {…} })
 *
 * These tests execute the *real* bundle inside a `node:vm` sandbox (fake module
 * loader, fake DOM and stub `fetch`), then:
 *
 *  1. assert the loader/plugin registration contract the host layout depends on;
 *  2. drive the face through all six `/api/harnmem/*` routes and the error paths;
 *  3. server-render the panel and its main views with the real
 *     `react`/`react-dom` instances — a crash in the first render (the
 *     white-screen failure mode) therefore fails the suite;
 *  4. seed the error boundary and assert its fallback markup instead of a throw.
 *
 * Run after `pnpm --filter dsh-harnmem build:client`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const React = require("react");
const jsxRuntime = require("react/jsx-runtime");
const { renderToString } = require("react-dom/server");

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_FILE = join(HERE, "..", "dist", "client.js");
const ORIGIN = "http://127.0.0.1:60919";
const NS = "harnmem";
const PANEL_ID = "harnmem";
const STYLE_ID = "dsh-harnmem-panel";

/** Fixed clock keeps byte-stable snapshots and `data-language` output stable. */
const NOW = Date.UTC(2026, 9, 24, 8, 0, 0);

/** Modules the DSH loader injects; any other `require` is a build/integration bug. */
const REQUIREMENTS = new Map([
  ["react", React],
  ["react/jsx-runtime", jsxRuntime],
]);

const SOURCE = await readFile(DIST_FILE, "utf8");

/* ------------------------------------------------------------------ fixtures */

function row(overrides = {}) {
  return {
    id: "mem-user-1",
    type: "user",
    category: "preference",
    scope: "user",
    project: null,
    projectName: null,
    title: "用户偏好",
    description: "偏好 pnpm",
    preview: "在仓库中统一使用 pnpm。",
    tags: ["tooling"],
    entities: ["pnpm"],
    importance: 8,
    confidence: 0.9,
    pinned: true,
    status: "active",
    created: NOW - 86_400_000,
    updated: NOW - 3_600_000,
    lastUsed: NOW - 1_800_000,
    usedCount: 4,
    validFrom: NOW - 86_400_000,
    validTo: null,
    supersededBy: null,
    links: [],
    supersedes: [],
    evidence: 2,
    bytes: 512,
    tokens: 128,
    harness: "pi",
    ...overrides,
  };
}

function shard(overrides = {}) {
  return {
    name: "user",
    scope: "user",
    project: null,
    projectName: null,
    label: "用户",
    total: 2,
    active: 2,
    superseded: 0,
    archived: 0,
    pinned: 1,
    bytes: 2048,
    tokens: 512,
    indexBytes: 1024,
    lastUpdated: NOW - 3_600_000,
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    id: "demo-project",
    slug: "demo-project",
    name: "Demo",
    paths: ["C:\\work\\demo"],
    harnesses: ["pi"],
    registered: true,
    shards: ["demo-project"],
    total: 1,
    pinned: 0,
    lastUpdated: NOW - 7_200_000,
    ...overrides,
  };
}

function indexStatus(overrides = {}) {
  return {
    manifest: { seq: 41, builtAt: NOW - 600_000, bytes: 4096, shards: [{ name: "user", docs: 2 }] },
    seq: 43,
    stale: true,
    files: [
      { shard: "user", path: "state/index/user.json", bytes: 2048, exists: true, docs: 2, records: 2 },
      { shard: "demo-project", path: "state/index/demo-project.json", bytes: 1024, exists: false, docs: null, records: 0 },
    ],
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    cwd: "C:\\work\\demo",
    projectId: "demo-project",
    projectName: "Demo",
    shards: ["user", "demo-project"],
    text: "<harnmem>\n- mem-user-1 用户偏好\n</harnmem>",
    ids: ["mem-user-1"],
    tokensEstimate: 120,
    bytes: 480,
    budgetTokens: 1200,
    hotEntries: 24,
    atBudget: false,
    ...overrides,
  };
}

function overview(overrides = {}) {
  return {
    version: 1,
    home: "C:\\Users\\demo\\.harnmem",
    generatedAt: NOW - 300_000,
    project: "demo-project",
    projectName: "Demo",
    totals: {
      records: 2,
      active: 2,
      superseded: 0,
      archived: 0,
      pinned: 1,
      bytes: 5120,
      tokens: 1024,
      shards: 2,
      projects: 1,
      trash: 0,
      digests: 1,
    },
    byType: { user: 1, feedback: 1 },
    byStatus: { active: 2 },
    byHarness: { pi: 2 },
    budget: { injectTokens: 1200, hotEntries: 24, maxPinned: 8 },
    context: context(),
    shards: [shard(), shard({ name: "demo-project", project: "demo-project", projectName: "Demo", label: "Demo", total: 1, active: 1, pinned: 0, indexBytes: 512 })],
    projects: [project()],
    index: indexStatus(),
    issues: [{ level: "warn", code: "index-stale", message: "索引落后 3 个序列" }],
    fileErrors: [{ file: "records/demo-project/mem-broken.md", message: "无法解析 frontmatter" }],
    health: { overBudget: false, duplicateCandidates: 1, orphans: 2, lastConsolidate: NOW - 86_400_000 },
    extraction: { pending: 1, failed: 0, skipReasons: { trivial: 2 } },
    ...overrides,
  };
}

function listResult(overrides = {}) {
  return {
    shard: "all",
    label: "全部",
    total: 2,
    rows: [
      row(),
      row({
        id: "mem-feedback-2",
        type: "feedback",
        category: "lesson",
        title: "提交格式",
        status: "superseded",
        pinned: false,
        harness: "deepseek-harness",
        project: "demo-project",
        projectName: "Demo",
        scope: "project",
        supersededBy: "mem-feedback-3",
      }),
    ],
    generatedAt: NOW - 300_000,
    ...overrides,
  };
}

function memory(overrides = {}) {
  const base = row();
  return {
    ...base,
    content: "## 决策\n\n统一使用 **pnpm**，不要使用 `npm`。\n\n- 安装：`pnpm i`\n- 运行：`pnpm test`\n\n> 已确认\n\n| 列 | 值 |\n| --- | --- |\n| 包管理器 | pnpm |\n\n[[demo-project]]",
    frontmatter: {
      id: base.id,
      type: "user",
      title: "用户偏好",
      description: "偏好 pnpm",
      importance: 8,
      pinned: true,
    },
    raw: "---\nid: mem-user-1\ntype: user\ntitle: 用户偏好\n---\n\n## 决策\n\n统一使用 **pnpm**。\n",
    filePath: "records/user/mem-user-1.md",
    backlinks: ["mem-feedback-2"],
    history: [row({ id: "mem-user-1", status: "active", updated: NOW - 86_400_000 })],
    ...overrides,
  };
}

function indexText(overrides = {}) {
  return {
    text: "# MEMORY.md\n\n- [用户偏好](records/user/mem-user-1.md)\n",
    bytes: 58,
    parts: [
      { shard: "user", label: "用户", path: "state/index/user.md", text: "# user\n", bytes: 2048 },
      { shard: "demo-project", label: "Demo", path: "state/index/demo-project.md", text: "# demo\n", bytes: 512 },
    ],
    generatedAt: NOW - 300_000,
    ...overrides,
  };
}

/** Samples for the six panel routes; `memory.read` may intentionally be null. */
function routeSamples() {
  return {
    "overview.get": overview(),
    "memories.list": listResult(),
    "memory.read": memory(),
    "context.preview": context(),
    "index.read": indexText(),
    "projects.list": [project()],
  };
}

const ROUTE_PATHS = [
  "overview.get",
  "memories.list",
  "memory.read",
  "context.preview",
  "index.read",
  "projects.list",
];

/** Stub host transport: records URLs and serves the fixture per route. */
function createRouteFetch(samples = routeSamples()) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push({ url });
    const parsed = new URL(url);
    const route = parsed.pathname.replace(/^\/api\/harnmem\//, "");
    if (!(route in samples)) {
      return { ok: false, status: 404, async json() { return { ok: false, error: `no route ${route}` }; } };
    }
    const data = samples[route];
    return { ok: true, status: 200, async json() { return { ok: true, data }; } };
  };
  return { fetchImpl, calls };
}

/* ------------------------------------------------------------------- helpers */

/**
 * Executes the built bundle in a fresh VM context with a fake module loader.
 * @param {{ fetchImpl?: Function, withDocument?: boolean }} options
 */
function loadClient({ fetchImpl, withDocument = true } = {}) {
  const styles = [];
  const stylesById = new Map();
  const documentStub = {
    head: {
      appendChild(node) {
        styles.push(node);
        stylesById.set(node.dataset.pluginCss, node);
      },
    },
    querySelector(selector) {
      const match = /data-plugin-css="([^"]+)"/.exec(selector);
      return match ? stylesById.get(match[1]) ?? null : null;
    },
    createElement(tagName) {
      return { tagName, dataset: {}, textContent: "" };
    },
  };

  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: { location: { origin: ORIGIN } },
  };
  if (fetchImpl) sandbox.fetch = fetchImpl;
  if (withDocument) sandbox.document = documentStub;

  const records = [];
  sandbox.window.__ModuleLoader__ = {
    load(record) {
      records.push(record);
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "dist/client.js" });

  assert.equal(records.length, 1, "bundle must register exactly one module");
  const record = records[0];
  assert.equal(record.id, "dsh-harnmem");
  assert.equal(typeof record.factory, "function");

  const module = record.factory((id) => {
    const stub = REQUIREMENTS.get(id);
    if (!stub) throw new Error(`bundle required unexpected module: ${id}`);
    return stub;
  });

  return { module, records, sandbox, styles, stylesById };
}

/** Minimal cordis client context: slots, locale, effect and a sessions store. */
function createFakeHost({ cwd = "C:\\work\\demo", sessions } = {}) {
  const state = {
    registrations: [],
    injections: [],
    cleanups: [],
    dictionaries: new Map(),
    binds: [],
    translators: new Map(),
  };

  const translateFor = (namespace) => (key, params) => {
    const dictionaries = state.dictionaries.get(namespace);
    const template = dictionaries?.zh?.[key] ?? dictionaries?.en?.[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
  };

  const ctx = {
    slots: {
      inject(name, callback) {
        state.injections.push(name);
        callback();
      },
      register(options, component) {
        state.registrations.push({ options, component });
        return () => {};
      },
    },
    locale: {
      register(namespace, dictionaries) {
        state.dictionaries.set(namespace, dictionaries);
        return undefined;
      },
      bind(namespace) {
        state.binds.push(namespace);
        const translate = translateFor(namespace);
        state.translators.set(namespace, translate);
        return translate;
      },
    },
    effect(factory, label) {
      state.cleanups.push({ label, dispose: factory() });
    },
    get(name) {
      if (name !== "sessions") return undefined;
      return {
        list: {
          getSnapshot() {
            return sessions ?? { byId: { session1: { id: "session1", cwd, updatedAt: NOW } } };
          },
        },
      };
    },
  };

  return { ctx, state };
}

/** Applies the plugin to a fake host and exposes both slot registrations. */
function applyBundle(client, host = createFakeHost()) {
  client.module.apply(host.ctx);
  const find = (name) => host.state.registrations.find((entry) => entry.options.name === name);
  const main = find("main");
  const icon = find("sidebar.panellist");
  assert.ok(main, "expected a `main` slot registration");
  assert.ok(icon, "expected a `sidebar.panellist` slot registration");
  return { host, main, icon };
}

function mainProps(client, host, extra = {}) {
  const { face } = host.state.registrations.find((entry) => entry.options.name === "main").options.inject();
  return { face, t: host.state.translators.get(NS), ...extra };
}

/** Applies the bundle once and returns the real zh translator from the locale dict. */
function createTranslator(client) {
  const host = createFakeHost();
  applyBundle(client, host);
  return host.state.translators.get(NS);
}

/* ------------------------------------------------------- bundle & registration */

test("bundle is a browser-safe module-loader factory for `dsh-harnmem`", () => {
  const client = loadClient();

  assert.equal(client.module.name, "dsh-harnmem");
  assert.deepEqual([...client.module.inject], ["slots", "locale", "sessions"]);
  assert.equal(typeof client.module.apply, "function");

  // Boolean checks (instead of match/diff assertions) keep failure output small:
  // the bundle is ~93 KB and a diff against it would bury the actual problem.
  assert.equal(SOURCE.includes("window.__ModuleLoader__.load({"), true, "bundle uses the DSH module-loader wrapper");
  assert.equal(SOURCE.includes('id: "dsh-harnmem"'), true, "bundle declares the dsh-harnmem module id");
  const forbidden = [
    [/require\(["']node:/, "node builtin imports"],
    [/require\(["']@harnmem\/core["']\)/, "@harnmem/core imports"],
    [/dangerouslySetInnerHTML\s*[:=]/, "dangerouslySetInnerHTML"],
    [/require\(["']fs["']\)|require\(["']path["']\)/, "fs/path access"],
  ];
  for (const [pattern, label] of forbidden) {
    assert.equal(pattern.test(SOURCE), false, `browser bundle must not contain ${label}`);
  }
});

test("apply registers both slot halves under the shared `harnmem` panel id", () => {
  const client = loadClient();
  const host = createFakeHost();
  const { main, icon } = applyBundle(client, host);

  // Late-bound injections: main slot first, then the sidebar row.
  assert.deepEqual(host.state.injections, ["main", "sidebar.panellist"]);

  assert.equal(main.options.key, PANEL_ID);
  assert.equal(main.options.locale, NS);
  assert.equal(typeof main.component, "function");

  // Row id MUST equal the main slot key, or selecting the row throws host-side.
  assert.equal(icon.options.id, PANEL_ID);
  assert.equal(icon.options.order, 60);
  assert.equal(icon.options.locale, NS);
  assert.equal(typeof icon.component, "function");
  assert.equal(icon.options.label(), "记忆");

  // Locale dictionary registration ran through `ctx.effect` and zh is bound.
  assert.deepEqual(host.state.binds, [NS]);
  assert.equal(host.state.dictionaries.get(NS).zh.title, "记忆浏览器");
  assert.equal(host.state.dictionaries.get(NS).en.title, "Memory Browser");
  assert.equal(host.state.cleanups.length, 1);
  assert.equal(host.state.cleanups[0].label, "dsh-harnmem: locale");

  // The stylesheet is injected exactly once, even across re-applies.
  assert.equal(client.styles.length, 1);
  assert.equal(client.styles[0].dataset.plugin, "dsh-harnmem");
  assert.equal(client.styles[0].dataset.pluginCss, STYLE_ID);
  assert.match(client.styles[0].textContent, /\.dshh-panel\s*\{/);
  client.module.apply(host.ctx);
  assert.equal(client.styles.length, 1);

  // The injected face is the host bridge and resolves the session cwd.
  const { face } = main.options.inject();
  assert.equal(typeof face.request, "function");
  assert.equal(face.cwd(), "C:\\work\\demo");
});

test("bootstrap works without a DOM (loader-time safety)", () => {
  const client = loadClient({ withDocument: false });
  assert.equal(client.styles.length, 0);
  const { main, icon } = applyBundle(client);
  assert.equal(typeof main.component, "function");
  assert.equal(typeof icon.component, "function");
});

/* --------------------------------------------------------------------- face */

test("face bridges the six /api/harnmem routes with cwd and unwraps the envelope", async () => {
  const samples = routeSamples();
  const { fetchImpl, calls } = createRouteFetch(samples);
  const client = loadClient({ fetchImpl });
  const { host, main } = applyBundle(client);
  const { face } = main.options.inject();
  assert.equal(face.cwd(), "C:\\work\\demo");

  for (const route of ROUTE_PATHS) {
    const data = await face.request(route);
    assert.deepEqual(data, samples[route], `${route} data`);
  }

  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ROUTE_PATHS.map((route) => `/api/harnmem/${route}`),
  );
  for (const call of calls) {
    const parsed = new URL(call.url);
    assert.equal(parsed.origin, ORIGIN);
    assert.equal(parsed.searchParams.get("cwd"), "C:\\work\\demo");
  }
  assert.equal(new URL(calls[0].url).pathname, "/api/harnmem/overview.get");

  // Query params are appended; undefined/empty values are dropped.
  await face.request("memories.list", { shard: "all", limit: 5, missing: undefined, blank: "" });
  const last = new URL(calls.at(-1).url);
  assert.equal(last.searchParams.get("shard"), "all");
  assert.equal(last.searchParams.get("limit"), "5");
  assert.equal(last.searchParams.has("missing"), false);
  assert.equal(last.searchParams.has("blank"), false);

  // `memory.read` for an unknown id is HTTP 200 with `data: null`, not an error.
  const nullable = createRouteFetch({ ...samples, "memory.read": null });
  const nullableClient = loadClient({ fetchImpl: nullable.fetchImpl });
  const nullableHost = createFakeHost();
  const nullableMain = applyBundle(nullableClient, nullableHost).main;
  const nullableFace = nullableMain.options.inject().face;
  assert.equal(await nullableFace.request("memory.read", { id: "missing" }), null);
});

test("face surfaces envelope and transport failures as MemoryApiError", async () => {
  const envelopeClient = loadClient({
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async json() {
        return { ok: false, error: "host exploded" };
      },
    }),
  });
  const envelopeFace = applyBundle(envelopeClient).main.options.inject().face;
  await assert.rejects(
    () => envelopeFace.request("overview.get"),
    (error) => {
      assert.equal(error.name, "MemoryApiError");
      assert.equal(error.message, "host exploded");
      assert.equal(error.status, 500);
      return true;
    },
  );

  const transportClient = loadClient({
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  const transportFace = applyBundle(transportClient).main.options.inject().face;
  await assert.rejects(() => transportFace.request("index.read"), /network down/);
});

/* ------------------------------------------------------------- SSR rendering */

test("main slot SSR-renders the panel shell: no request, no crash, no error pane", () => {
  const { fetchImpl, calls } = createRouteFetch();
  const client = loadClient({ fetchImpl });
  const host = createFakeHost();
  const { main } = applyBundle(client, host);

  const html = renderToString(React.createElement(main.component, mainProps(client, host)));

  assert.ok(html.length > 200, "panel must render a non-empty shell");
  assert.match(html, /class="dshh-panel"/);
  assert.match(html, /记忆浏览器/);
  assert.match(html, /只读视图/);
  assert.match(html, /概览/);
  assert.match(html, /注入预览/);
  assert.match(html, /加载中…/, "initial render is the loading skeleton");
  assert.match(html, /C:\\work\\demo/);
  assert.doesNotMatch(html, /面板渲染失败/);
  assert.doesNotMatch(html, /error boundary/i);
  assert.doesNotMatch(html, /MemoryApiError/);

  // First render is side-effect free: effects (and thus requests) run only in a
  // live DOM, never during SSR.
  assert.equal(calls.length, 0);
});

test("main slot renders without a face (degraded host) instead of throwing", () => {
  const client = loadClient();
  const host = createFakeHost();
  const { main } = applyBundle(client, host);
  const html = renderToString(React.createElement(main.component, { t: host.state.translators.get(NS) }));
  assert.match(html, /class="dshh-panel"/);
  assert.match(html, /加载中…/);
});

test("sidebar icon renders its svg memory card", () => {
  const client = loadClient();
  const { icon } = applyBundle(client);
  const html = renderToString(React.createElement(icon.component, { size: 18, active: true }));
  assert.match(html, /<svg/);
  assert.match(html, /viewBox="0 0 24 24"/);
  assert.match(html, /aria-hidden="true"/);
});

test("error boundary renders the captured message instead of crashing the tree", () => {
  const client = loadClient();
  const { PanelErrorBoundary, PanelErrorFallback } = client.module;
  assert.equal(typeof PanelErrorBoundary, "function");
  assert.equal(typeof PanelErrorFallback, "function");
  // React 19's server renderer does not run error boundaries (a throwing child
  // rethrows from renderToString), so the boundary's capture path is asserted
  // through `getDerivedStateFromError` + a seeded `initialError`, which is the
  // same state the browser reconciler would reach.
  const captured = PanelErrorBoundary.getDerivedStateFromError(new Error("face exploded"));
  assert.equal(captured.error.message, "face exploded");

  const html = renderToString(
    React.createElement(PanelErrorBoundary, {
      title: "面板渲染失败",
      retryLabel: "重试",
      initialError: new Error("face exploded"),
    }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /面板渲染失败/);
  assert.match(html, /face exploded/);
  assert.match(html, /重试/);
  assert.doesNotMatch(html, /加载中…/);

  // Healthy children pass straight through.
  const healthy = renderToString(
    React.createElement(PanelErrorBoundary, null, React.createElement("span", null, "ok")),
  );
  assert.equal(healthy, "<span>ok</span>");
});

/** Convenience: an `ApiResult` shape for the pure views. */
function apiResult(state) {
  return { status: "ready", data: undefined, error: undefined, reload: () => {}, ...state };
}

test("overview view SSR-renders a populated snapshot", () => {
  const client = loadClient();
  const { OverviewView } = client.module;
  const t = createTranslator(client);

  const html = renderToString(
    React.createElement(OverviewView, {
      t,
      overview: apiResult({ data: overview() }),
      onOpenShard() {},
      onOpenMemory() {},
      onOpenIndex() {},
      onOpenContext() {},
    }),
  );

  assert.ok(html.length > 500);
  assert.match(html, /总量/);
  assert.match(html, /注入预算/);
  assert.match(html, /索引健康/);
  assert.match(html, /分片明细/);
  assert.match(html, /告警/);
  assert.match(html, /索引落后/);
  assert.match(html, /索引落后 3 个序列/);
  assert.match(html, /无法解析 frontmatter/);
  assert.match(html, /重复候选/);
  assert.match(html, /待处理/);
  assert.match(html, /Demo/);
});

test("overview view renders error and empty states instead of throwing", () => {
  const client = loadClient();
  const { OverviewView } = client.module;
  const t = createTranslator(client);
  const baseProps = {
    t,
    onOpenShard() {},
    onOpenMemory() {},
    onOpenIndex() {},
    onOpenContext() {},
  };

  const errorHtml = renderToString(
    React.createElement(OverviewView, {
      ...baseProps,
      overview: apiResult({ status: "error", data: undefined, error: "face exploded" }),
    }),
  );
  assert.match(errorHtml, /加载失败/);
  assert.match(errorHtml, /face exploded/);

  const emptyHtml = renderToString(
    React.createElement(OverviewView, { ...baseProps, overview: apiResult({ status: "ready", data: undefined }) }),
  );
  assert.match(emptyHtml, /没有记忆/);

  const loadingHtml = renderToString(
    React.createElement(OverviewView, { ...baseProps, overview: apiResult({ status: "loading" }) }),
  );
  assert.match(loadingHtml, /加载中…/);
});

test("every tab view survives its first (loading) render — no white-screen path", () => {
  const client = loadClient();
  const { MemoriesView, DetailView, IndexView, ContextView, OverviewView } = client.module;
  const t = createTranslator(client);
  // Never resolves: the first render must not depend on response data at all.
  const face = { cwd: () => "C:\\work\\demo", request: () => new Promise(() => {}) };
  const base = { face, t, refreshToken: 0 };
  const views = [
    ["overview", OverviewView, { t, overview: apiResult({ status: "loading" }) }],
    [
      "memories",
      MemoriesView,
      { ...base, shard: "all", onShardChange() {}, shards: undefined, onOpenMemory() {} },
    ],
    ["detail", DetailView, { ...base, id: "mem-user-1", onBack() {}, onOpenMemory() {} }],
    ["index", IndexView, { ...base, shard: "user", onShardChange() {}, shards: undefined }],
    ["context", ContextView, { ...base, onOpenMemory() {} }],
  ];

  for (const [name, View, props] of views) {
    const html = renderToString(React.createElement(View, props));
    assert.ok(html.length > 100, `${name} view renders a skeleton`);
    assert.match(html, /加载中…/, `${name} view shows the loading state`);
    assert.doesNotMatch(html, /面板渲染失败/, `${name} view did not throw`);
  }
});

test("markdown renderer emits React nodes and escapes raw HTML", () => {
  const { Markdown } = loadClient().module;
  const source = [
    "## 标题",
    "",
    "- 列表 `code`",
    "",
    "```ts",
    "const x = 1",
    "```",
    "",
    "| 列 | 值 |",
    "| --- | --- |",
    "| a | b |",
    "",
    "> 引用 [[wiki-link]]",
    "",
    "**加粗** *斜体* [安全](https://example.com) [危险](javascript:alert(1))",
    "",
    "<script>alert('xss')</script><img src=x onerror=alert(1)>",
  ].join("\n");

  const html = renderToString(React.createElement(Markdown, { text: source }));

  assert.match(html, /<h2 class="dshh-md-heading">/);
  assert.match(html, /<ul class="dshh-md-list">/);
  assert.match(html, /<pre class="dshh-md-pre" data-language="ts">/);
  assert.match(html, /<table class="dshh-md-table">/);
  assert.match(html, /<blockquote class="dshh-md-quote">/);
  assert.match(html, /dshh-md-wikilink/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.doesNotMatch(html, /javascript:/, "unsafe link protocols are rendered as text");
  assert.doesNotMatch(html, /<script>/, "raw HTML is escaped");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;/);
});
