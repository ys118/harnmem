/**
 * Host-side panel API tests: six read-only routes registered on
 * `ctx.connection.fetch` (fake host context), the no-connection /
 * malformed-service degradation paths, and the late-mount path real DSH uses
 * (`connection` appears only after `apply()` via `ctx.inject`).
 *
 * Run after `pnpm --filter dsh-harnmem build` (imports ../dist and @harnmem/core).
 * The memory home is seeded through the public engine API so records, indexes
 * and MEMORY.md are byte-for-byte what production writes — the panel is a pure
 * projection over those files and must not mutate them.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { HarnMem } from "@harnmem/core";
import { apply } from "../dist/index.js";
import { PANEL_API_PREFIX, PANEL_ROUTE_PATHS } from "../dist/panel-api.js";
import { createFakeContext, fakeAgent, waitForLog } from "./fake-dsh.mjs";

const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  delete process.env["HARNMEM_HOME"];
});

/** Route path builder: `panelPath("overview.get")` → `/api/harnmem/overview.get`. */
function panelPath(suffix) {
  return `${PANEL_API_PREFIX}/${suffix}`;
}

/** Every panel route is a GET; the contract table and client use dotted tails. */
const ROUTE_SUFFIXES = [
  "overview.get",
  "memories.list",
  "memory.read",
  "context.preview",
  "index.read",
  "projects.list",
];

function fakeConnection(routes, { throwOnRegister = false, disposers = [] } = {}) {
  return {
    fetch: {
      register(route) {
        if (throwOnRegister) throw new Error("register boom");
        routes.push(route);
        // Real hosts return a disposer; the panel keeps it and calls it on
        // unload as a belt-and-braces complement to the owner-fiber cleanup.
        return () => {
          disposers.push(route.path);
        };
      },
    },
  };
}

/**
 * Boot the plugin against a fake host. `HARNMEM_HOME` must be set before
 * `apply()` because settings are resolved once at mount time.
 */
async function bootPanel(home, { connection = "ok", config = { log: "off" } } = {}) {
  process.env["HARNMEM_HOME"] = home;
  const host = createFakeContext();
  const routes = [];
  if (connection === "ok") host.provide("connection", fakeConnection(routes));
  else if (connection !== "none" && connection !== undefined) host.provide("connection", connection);
  await apply(host.ctx, config);
  return { host, routes };
}

/** Run the plugin's unload effect (the single cleanup registered by apply). */
async function dispose(host) {
  for (const cleanup of host.effectCleanups()) await cleanup();
}

/**
 * Boot against a host where `connection` mounts *after* `apply()` — the real
 * DSH ordering (`@deepseek-ai/dsh-client-connection` waits for `webServer`).
 * `ctx.get("connection")` stays undefined; the captured injection callback must
 * be invoked by the test with a scoped context exposing the late service.
 */
async function bootLateConnection(home) {
  process.env["HARNMEM_HOME"] = home;
  const host = createFakeContext();
  const injections = [];
  host.ctx.inject = (deps, callback) => {
    injections.push({ deps, callback });
  };
  await apply(host.ctx, { log: "off" });

  const routes = [];
  const disposers = [];
  const connection = fakeConnection(routes, { disposers });
  const scope = {
    get: (name) => (name === "connection" ? connection : host.ctx.get(name)),
  };
  return { host, routes, disposers, injections, connection, scope };
}

/** Seed one user memory + one project memory through the real engine API. */
async function seededHome() {
  const root = await mkdtemp(join(tmpdir(), "dsh-harnmem-panel-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });

  const engine = await HarnMem.open({ harness: "dsh", cwd, home, autoExtract: false });
  try {
    const user = await engine.write({
      type: "user",
      title: "Codename",
      description: "The user codename is BLUE-FALCON-77",
      content: "The user codename is BLUE-FALCON-77. Use it when the user asks for their codename.",
      pinned: true,
    });
    const project = await engine.write({
      type: "project",
      title: "Release process",
      description: "Tag the release branch before publishing",
      content: "Tag the release branch before publishing to npm.",
      tags: ["release"],
    });
    // `info().project` is only populated when the engine auto-detected + registered
    // the project under `cwd`, which is also how the panel resolves the project.
    const projectId = engine.info().project ?? null;
    assert.ok(projectId, "engine registered a project for the seeded cwd");
    // Search flushes the persisted shard indexes (`index/<shard>.json`) that the
    // inspector reads for the overview health + hot-context projection.
    await engine.search({ query: "Codename", limit: 3 });
    return { root, home, cwd, user, project, projectId };
  } finally {
    await engine.close();
  }
}

/** Invoke a registered route with a real `Request` (method + query params). */
async function callRoute(routes, suffix, { query = "", method = "GET" } = {}) {
  const path = panelPath(suffix);
  const route = routes.find((candidate) => candidate.path === path);
  assert.ok(route, `route ${path} is registered`);
  const response = await route.fetch(new Request(`http://127.0.0.1${path}${query}`, { method }));
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: JSON.parse(text) };
}

/** Call every route once (used by the read-only and 405 tests). */
async function callAllRoutes(routes, query = "") {
  const calls = ROUTE_SUFFIXES.map((suffix) => {
    const route = routes.find((candidate) => candidate.path === panelPath(suffix));
    const withQuery = suffix === "memory.read" ? undefined : query;
    return { route, withQuery };
  });
  const results = [];
  for (const { route } of calls) {
    assert.ok(route);
  }
  results.push(await callRoute(routes, "overview.get", { query }));
  results.push(await callRoute(routes, "memories.list", { query }));
  results.push(await callRoute(routes, "context.preview", { query }));
  results.push(await callRoute(routes, "index.read", { query }));
  results.push(await callRoute(routes, "projects.list"));
  return results;
}

/** Relative file listing (directories get a trailing slash) for byte-stability checks. */
async function listFilesRecursive(dir, prefix = "") {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(`${rel}/`, ...(await listFilesRecursive(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

let seeded;

before(async () => {
  seeded = await seededHome();
});

test("six GET routes are registered on connection.fetch with the dotted contract", async () => {
  const { host, routes } = await bootPanel(seeded.home);

  assert.equal(routes.length, ROUTE_SUFFIXES.length);
  assert.deepEqual(
    routes.map((route) => route.path),
    ROUTE_SUFFIXES.map((suffix) => panelPath(suffix)),
  );
  assert.deepEqual([...PANEL_ROUTE_PATHS], ROUTE_SUFFIXES.map((suffix) => panelPath(suffix)));
  assert.equal(PANEL_ROUTE_PATHS[0], "/api/harnmem/overview.get");

  for (const route of routes) {
    assert.ok(route.path.startsWith("/api/harnmem/"), `${route.path} keeps the /api prefix`);
    assert.match(route.path, /^\/api\/harnmem\/[a-z]+\.[a-z]+$/u, "route tail is dotted");
    assert.deepEqual(route.methods, ["GET"]);
    assert.equal(route.requestBody, "buffered");
    assert.equal(typeof route.fetch, "function");
  }

  await dispose(host);
  assert.equal(host.logs.filter((entry) => entry.level === "error").length, 0);
});

test("overview.get projects totals, types, index health and the project", async () => {
  const { host, routes } = await bootPanel(seeded.home);
  const { status, headers, body } = await callRoute(routes, "overview.get", {
    query: `?cwd=${encodeURIComponent(seeded.cwd)}`,
  });

  assert.equal(status, 200);
  assert.match(headers.get("content-type") ?? "", /application\/json/u);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(body.ok, true);
  assert.equal(body.data.version, 1);
  assert.equal(body.data.home, seeded.home);
  assert.equal(body.data.totals.records, 2);
  assert.equal(body.data.totals.active, 2);
  assert.equal(body.data.totals.pinned, 1);
  assert.equal(body.data.totals.shards, 2);
  assert.equal(body.data.byType.user, 1);
  assert.equal(body.data.byType.project, 1);
  assert.equal(body.data.project, seeded.projectId);
  assert.deepEqual(body.data.fileErrors, []);
  assert.deepEqual(
    body.data.index.files.map((file) => file.shard).sort(),
    ["user", seeded.projectId].sort(),
  );
  assert.ok(body.data.index.files.every((file) => file.exists && file.bytes > 0), "index health is per shard");
  assert.ok(!body.data.issues.some((issue) => issue.code === "empty_home"));

  // No session and no cwd → the panel must not invent a project.
  const resolved = await callRoute(routes, "overview.get");
  assert.equal(resolved.body.data.project, null);

  await dispose(host);
});

test("memories.list filters by shard and validates includeInactive", async () => {
  const { host, routes } = await bootPanel(seeded.home);

  const all = await callRoute(routes, "memories.list");
  assert.equal(all.status, 200);
  assert.equal(all.body.data.shard, "all");
  assert.equal(all.body.data.total, 2);
  assert.deepEqual(
    all.body.data.rows.map((row) => row.id).sort(),
    [seeded.user.id, seeded.project.id].sort(),
  );
  const userRow = all.body.data.rows.find((row) => row.id === seeded.user.id);
  assert.equal(userRow.title, "Codename");
  assert.equal(userRow.pinned, true);
  assert.equal(userRow.status, "active");

  const userOnly = await callRoute(routes, "memories.list", { query: "?shard=user" });
  assert.equal(userOnly.body.data.total, 1);
  assert.equal(userOnly.body.data.rows[0].id, seeded.user.id);

  const missing = await callRoute(routes, "memories.list", { query: "?shard=does-not-exist" });
  assert.equal(missing.body.data.total, 0);

  const inactive = await callRoute(routes, "memories.list", { query: "?includeInactive=1" });
  assert.equal(inactive.status, 200);
  assert.equal(inactive.body.data.total, 2);

  const bad = await callRoute(routes, "memories.list", { query: "?includeInactive=maybe" });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { ok: false, error: "includeInactive must be 0 or 1" });

  await dispose(host);
});

test("memory.read returns one record (and 400 without id)", async () => {
  const { host, routes } = await bootPanel(seeded.home);

  const read = await callRoute(routes, "memory.read", { query: `?id=${encodeURIComponent(seeded.user.id)}` });
  assert.equal(read.status, 200);
  assert.equal(read.body.data.id, seeded.user.id);
  assert.match(read.body.data.content, /BLUE-FALCON-77/u);
  assert.match(read.body.data.raw, /^---\n/u);
  assert.equal(read.body.data.frontmatter.id, seeded.user.id);
  assert.ok(read.body.data.filePath.includes(seeded.user.id));
  assert.deepEqual(read.body.data.backlinks, []);
  assert.equal(read.body.data.history, undefined);

  const project = await callRoute(routes, "memory.read", {
    query: `?id=${encodeURIComponent(seeded.project.id)}&history=1`,
  });
  assert.equal(project.body.data.tags.includes("release"), true);
  assert.ok(Array.isArray(project.body.data.history));
  assert.equal(project.body.data.project, seeded.projectId);

  const unknown = await callRoute(routes, "memory.read", { query: "?id=mem_missing" });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.data, null);

  const noId = await callRoute(routes, "memory.read");
  assert.equal(noId.status, 400);
  assert.deepEqual(noId.body, { ok: false, error: "id is required" });

  const badHistory = await callRoute(routes, "memory.read", { query: `?id=${seeded.user.id}&history=yes` });
  assert.equal(badHistory.status, 400);
  assert.deepEqual(badHistory.body, { ok: false, error: "history must be 0 or 1" });

  await dispose(host);
});

test("context.preview renders non-empty hot context and validates budgets", async () => {
  const { host, routes } = await bootPanel(seeded.home);

  const preview = await callRoute(routes, "context.preview", {
    query: `?cwd=${encodeURIComponent(seeded.cwd)}`,
  });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.data.text.length > 0, "hot context text is not empty");
  assert.match(preview.body.data.text, /Codename/u);
  assert.equal(preview.body.data.projectId, seeded.projectId);
  assert.ok(preview.body.data.ids.includes(seeded.user.id));
  assert.ok(preview.body.data.budgetTokens > 0);
  assert.ok(preview.body.data.hotEntries > 0);
  assert.equal(typeof preview.body.data.atBudget, "boolean");

  const custom = await callRoute(routes, "context.preview", {
    query: `?cwd=${encodeURIComponent(seeded.cwd)}&budgetTokens=400&hotEntries=4`,
  });
  assert.equal(custom.status, 200);
  assert.equal(custom.body.data.budgetTokens, 400);
  assert.equal(custom.body.data.hotEntries, 4);

  for (const query of ["?budgetTokens=abc", "?budgetTokens=0", "?hotEntries=0", "?hotEntries=-3"]) {
    const bad = await callRoute(routes, "context.preview", { query });
    assert.equal(bad.status, 400, `${query} is rejected`);
    assert.equal(bad.body.ok, false);
  }

  await dispose(host);
});

test("index.read returns MEMORY.md text per shard", async () => {
  const { host, routes } = await bootPanel(seeded.home);

  const all = await callRoute(routes, "index.read");
  assert.equal(all.status, 200);
  assert.ok(all.body.data.text.length > 0);
  assert.match(all.body.data.text, /Codename/u);
  assert.deepEqual(all.body.data.parts.map((part) => part.shard).sort(), ["user", seeded.projectId].sort());
  assert.ok(all.body.data.parts.every((part) => part.bytes > 0 && part.path.endsWith("MEMORY.md")));

  const user = await callRoute(routes, "index.read", { query: "?shard=user" });
  assert.match(user.body.data.text, /Codename/u);

  const missing = await callRoute(routes, "index.read", { query: "?shard=does-not-exist" });
  assert.equal(missing.status, 200);
  assert.equal(missing.body.data.text, "");
  assert.deepEqual(missing.body.data.parts, []);

  await dispose(host);
});

test("projects.list exposes the projects.json registry", async () => {
  const { host, routes } = await bootPanel(seeded.home);

  const { status, body } = await callRoute(routes, "projects.list");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.data));
  const project = body.data.find((entry) => entry.id === seeded.projectId);
  assert.ok(project, "seeded project is listed");
  assert.equal(project.registered, true);
  assert.ok(project.paths.length > 0);
  assert.ok(project.total >= 1);
  assert.equal(typeof project.name, "string");

  await dispose(host);
});

test("all six routes are read-only: the home directory is byte-stable", async () => {
  const { host, routes } = await bootPanel(seeded.home);
  const before = await listFilesRecursive(seeded.home);
  if (before.length === 0) throw new Error("seeded home must not be empty");

  const query = `?cwd=${encodeURIComponent(seeded.cwd)}`;
  const results = await callAllRoutes(routes, query);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
  }
  await callRoute(routes, "memory.read", { query: `?id=${seeded.user.id}&history=1` });

  const after = await listFilesRecursive(seeded.home);
  assert.deepEqual(after, before, "GET routes never create/delete files");
  assert.equal(host.logsWith("panel.api.failed").length, 0);

  await dispose(host);
});

test("POST is rejected with 405 on every route", async () => {
  const { host, routes } = await bootPanel(seeded.home);
  for (const suffix of ROUTE_SUFFIXES) {
    const result = await callRoute(routes, suffix, { method: "POST" });
    assert.equal(result.status, 405, `${suffix} rejects POST`);
    assert.deepEqual(result.body, { ok: false, error: "method not allowed" });
  }
  await dispose(host);
});

test("cwd falls back to the most recently active session", async () => {
  const { host, routes } = await bootPanel(seeded.home);
  try {
    const agent = fakeAgent({ sessionId: `panel-${seeded.root}`, cwd: seeded.cwd });
    await host.emit("agent/created", { agent });
    await waitForLog(host, "session.started");

    const overview = await callRoute(routes, "overview.get");
    assert.equal(overview.body.data.project, seeded.projectId, "session cwd is used when the query omits cwd");

    const preview = await callRoute(routes, "context.preview");
    assert.equal(preview.body.data.cwd, seeded.cwd);
    assert.equal(preview.body.data.projectId, seeded.projectId);

    // An explicit cwd always wins over the session fallback.
    const explicit = await callRoute(routes, "overview.get", {
      query: `?cwd=${encodeURIComponent(join(seeded.root, "elsewhere"))}`,
    });
    assert.equal(explicit.body.data.project, null);
  } finally {
    await dispose(host);
  }
});

test("no connection service: plugin mounts normally and the panel is silently absent", async () => {
  const { host } = await bootPanel(seeded.home, { connection: "none" });

  const unavailable = host.logsWith("panel.api.unavailable");
  assert.equal(unavailable.length, 1);
  // No `inject` on this host and no service: nothing to wait for, nothing to log
  // above debug level.
  assert.equal(unavailable[0].data.reason, "no connection.inject support");
  assert.equal(host.logsWith("panel.api.ready").length, 0);
  assert.equal(host.logs.filter((entry) => entry.level === "warn").length, 0);
  assert.ok(host.tools.length > 0, "tools still register without the panel API");
  assert.ok(host.sectionText(fakeAgent({ sessionId: "probe", cwd: seeded.cwd })) !== undefined);

  await dispose(host);
});

test("malformed connection services degrade instead of failing apply", async () => {
  for (const broken of [{}, { fetch: null }, { fetch: {} }]) {
    const { host } = await bootPanel(seeded.home, { connection: broken });
    const unavailable = host.logsWith("panel.api.unavailable");
    assert.equal(unavailable.length, 1);
    // A present-but-unusable service is not retried through injection.
    assert.equal(unavailable[0].data.reason, "no connection.fetch service");
    await dispose(host);
  }

  // A throwing register is caught per route: apply resolves, the rest survives.
  const { host } = await bootPanel(seeded.home, {
    connection: { fetch: { register: () => { throw new Error("register boom"); } } },
  });
  assert.equal(host.logsWith("panel.api.routeFailed").length, ROUTE_SUFFIXES.length);
  assert.equal(host.logsWith("panel.api.ready").length, 1);
  assert.equal(host.logs.filter((entry) => entry.level === "error").length, 0);
  await dispose(host);
});

test("late connection: routes install through ctx.inject once the service appears", async () => {
  const { host, routes, injections, scope } = await bootLateConnection(seeded.home);

  // Nothing is registered while the connection module is still booting.
  assert.equal(routes.length, 0);
  assert.equal(injections.length, 1, "exactly one dynamic injection is requested");
  assert.deepEqual(injections[0].deps, ["connection"]);
  assert.equal(host.logsWith("panel.api.ready").length, 0);
  assert.equal(host.logsWith("panel.api.unavailable").length, 0, "waiting is not a failure");
  assert.equal(host.logs.filter((entry) => entry.level === "warn").length, 0);

  // The host calls the callback with a scope that now exposes the service.
  injections[0].callback(scope);
  assert.equal(routes.length, ROUTE_SUFFIXES.length);
  assert.deepEqual(
    routes.map((route) => route.path),
    ROUTE_SUFFIXES.map((suffix) => panelPath(suffix)),
  );
  const ready = host.logsWith("panel.api.ready");
  assert.equal(ready.length, 1);
  assert.equal(ready[0].data.routes, ROUTE_SUFFIXES.length);

  // Replaying the injection does not duplicate the routes.
  injections[0].callback(scope);
  assert.equal(routes.length, ROUTE_SUFFIXES.length);
  assert.equal(host.logsWith("panel.api.ready").length, 1);

  // Late-installed routes serve requests like the immediate path.
  const overview = await callRoute(routes, "overview.get", {
    query: `?cwd=${encodeURIComponent(seeded.cwd)}`,
  });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.data.totals.records, 2);
  assert.equal(overview.body.data.project, seeded.projectId);

  await dispose(host);
});

test("unload before the late connection arrives: the injection callback is inert", async () => {
  const { host, routes, injections, scope } = await bootLateConnection(seeded.home);

  await dispose(host);
  injections[0].callback(scope);

  assert.equal(routes.length, 0, "no routes are registered after unload");
  assert.equal(host.logsWith("panel.api.ready").length, 0);
});

test("route disposers returned by connection.fetch.register are called on unload", async () => {
  const routes = [];
  const disposers = [];
  const { host } = await bootPanel(seeded.home, {
    connection: fakeConnection(routes, { disposers }),
  });
  assert.equal(routes.length, ROUTE_SUFFIXES.length);
  assert.equal(disposers.length, 0);

  await dispose(host);
  assert.deepEqual(
    [...disposers].sort(),
    ROUTE_SUFFIXES.map((suffix) => panelPath(suffix)).sort(),
  );

  // Unload is idempotent: a second cleanup pass does not call disposers twice.
  await dispose(host);
  assert.equal(disposers.length, ROUTE_SUFFIXES.length);
});

test("a throwing ctx.inject degrades to a warning instead of failing the mount", async () => {
  process.env["HARNMEM_HOME"] = seeded.home;
  const host = createFakeContext();
  host.ctx.inject = () => {
    throw new Error("inject boom");
  };

  await apply(host.ctx, { log: "off" });

  assert.equal(host.logsWith("panel.api.injectFailed").length, 1);
  assert.equal(host.logs.filter((entry) => entry.level === "error").length, 0);
  assert.ok(host.tools.length > 0, "tools still register");

  await dispose(host);
});

test("a malformed immediate connection is not retried through injection", async () => {
  process.env["HARNMEM_HOME"] = seeded.home;
  const host = createFakeContext();
  const injections = [];
  host.ctx.inject = (deps, callback) => {
    injections.push({ deps, callback });
  };
  host.provide("connection", {});

  await apply(host.ctx, { log: "off" });

  assert.equal(injections.length, 0);
  assert.equal(host.logsWith("panel.api.unavailable")[0]?.data.reason, "no connection.fetch service");
  await dispose(host);
});
