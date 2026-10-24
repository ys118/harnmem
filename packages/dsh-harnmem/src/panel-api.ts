/**
 * Host-side, read-only HTTP API for the HarnMem memory browser panel.
 *
 * The browser half (`./client/*`) is served by the DSH web shell and cannot
 * touch the filesystem, so it consumes memory state through these routes. The
 * registration mechanism mirrors `.tmp/dsh-auto-memory/src/memory-api.ts`:
 * `ctx.get("connection")` is *opportunistic* — headless profiles and unit-test
 * hosts without a `connection` service must mount normally, simply without the
 * panel API. That is why `connection` is deliberately NOT listed in `inject`.
 * The provider of `connection` applies asynchronously (it waits for
 * `webServer`), so a one-shot lookup at `apply()` time is not enough: when the
 * service is not there yet, a Cordis dynamic `ctx.inject(["connection"], …)`
 * installs the routes the moment it appears.
 *
 * Contract (all routes are `GET`, JSON envelope `{ok:true,data}` / `{ok:false,
 * error}`):
 *
 * | Path                              | Data                |
 * | --------------------------------- | ------------------- |
 * | `/api/harnmem/overview.get`       | `InspectOverview`   |
 * | `/api/harnmem/memories.list`      | `InspectList`       |
 * | `/api/harnmem/memory.read`        | `InspectMemory|null`|
 * | `/api/harnmem/context.preview`    | `InspectContext`    |
 * | `/api/harnmem/index.read`         | `InspectIndexText`  |
 * | `/api/harnmem/projects.list`      | `InspectProject[]`  |
 *
 * Everything here is read-only: the inspector never writes, creates the home
 * directory, or opens the memory engine (see `@harnmem/core` `inspect.ts`).
 */

import { MemoryInspector } from "@harnmem/core";
import type {
  InspectContext,
  InspectIndexText,
  InspectList,
  InspectMemory,
  InspectOverview,
  InspectProject,
} from "@harnmem/core";
import type { EffectiveSettings } from "./config.js";
import type { HostContext } from "./host.js";
import type { Logger } from "./log.js";
import type { SessionManager } from "./sessions.js";
import { errorMessage } from "./snapshot.js";

/** Route prefix. The leading `/api` is required by the host gateway. */
export const PANEL_API_PREFIX = "/api/harnmem";

/** Paths of the six routes, in registration order (also the panel contract). */
export const PANEL_ROUTE_PATHS = [
  `${PANEL_API_PREFIX}/overview.get`,
  `${PANEL_API_PREFIX}/memories.list`,
  `${PANEL_API_PREFIX}/memory.read`,
  `${PANEL_API_PREFIX}/context.preview`,
  `${PANEL_API_PREFIX}/index.read`,
  `${PANEL_API_PREFIX}/projects.list`,
] as const;

/** Shape of the registered host-side fetch route. */
interface PanelFetchRoute {
  path: string;
  methods: string[];
  requestBody: "buffered";
  fetch: (request: Request) => Promise<Response>;
}

/**
 * Structural view of the DSH `connection` service. Kept local (no peer import):
 * the published rc typings are not resolvable in this workspace and the plugin
 * only needs the one `fetch.register` entry point.
 */
interface ConnectionService {
  fetch: {
    register: (route: PanelFetchRoute) => unknown;
  };
}

/** Narrow a (possibly late, possibly absent) service to {@link ConnectionService}. */
function isConnectionService(candidate: unknown): candidate is ConnectionService {
  if (typeof candidate !== "object" || candidate === null) return false;
  const fetch = (candidate as { fetch?: unknown }).fetch;
  if (typeof fetch !== "object" || fetch === null) return false;
  return typeof (fetch as { register?: unknown }).register === "function";
}

/** Options accepted by {@link registerPanelApi}. */
export interface PanelApiOptions {
  ctx: HostContext;
  sessions: SessionManager;
  log: Logger;
  settings: EffectiveSettings;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function ok(data: unknown): Response {
  return jsonResponse({ ok: true, data }, 200);
}

function fail(error: string, status: number): Response {
  return jsonResponse({ ok: false, error }, status);
}

/** Thrown for malformed query parameters; mapped to a 400 by {@link QueryHandler}. */
class BadRequest extends Error {}

function optionalString(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  return raw.trim();
}

function parsePositiveInt(url: URL, name: string): number | undefined {
  const raw = optionalString(url, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/u.test(raw)) throw new BadRequest(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new BadRequest(`${name} must be a positive integer`);
  return value;
}

function parseFlag(url: URL, name: string): boolean | undefined {
  const raw = optionalString(url, name);
  if (raw === undefined) return undefined;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new BadRequest(`${name} must be 0 or 1`);
}

/**
 * Peer into `SessionManager`'s in-memory states to recover the most relevant
 * working directory when the client omits `cwd`.
 *
 * `SessionManager` intentionally exposes no iteration API (the plugin only ever
 * addresses one session at a time), so this module reads the private `states`
 * map structurally — a compile-time cast, no monkey-patching. Scoring mirrors
 * the browser's `activeCwd` helper: a live (not closed) session wins over any
 * closed one, then the larger turn count, then the later start timestamp.
 */
interface PeeredSessionState {
  cwd?: unknown;
  turns?: unknown;
  updatedAt?: unknown;
  startedAt?: unknown;
  closed?: unknown;
}

interface PeeredSessionManager {
  readonly states?: Map<string, PeeredSessionState>;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function recentSessionCwd(sessions: SessionManager): string | undefined {
  const states = (sessions as unknown as PeeredSessionManager).states;
  if (!(states instanceof Map) || states.size === 0) return undefined;
  let best: { cwd: string; score: [number, number, number] } | undefined;
  for (const state of states.values()) {
    if (typeof state?.cwd !== "string" || state.cwd === "") continue;
    const score: [number, number, number] = [
      state.closed === true ? 0 : 1,
      finiteOr(state.turns, 0),
      Math.max(finiteOr(state.updatedAt, 0), finiteOr(state.startedAt, 0)),
    ];
    if (best === undefined || compareScore(score, best.score) > 0) best = { cwd: state.cwd, score };
  }
  return best?.cwd;
}

function compareScore(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

type QueryHandler = (url: URL) => Promise<unknown>;

/** Wrap one query handler: GET-only, envelope-encoded, never throws to the route. */
function routeHandler(target: string, handle: QueryHandler, log: Logger): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return fail("method not allowed", 405);
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return fail("invalid request url", 400);
    }
    try {
      return ok(await handle(url));
    } catch (error) {
      if (error instanceof BadRequest) return fail(error.message, 400);
      log.warn("panel.api.failed", { route: target, error: errorMessage(error) });
      return fail(errorMessage(error), 500);
    }
  };
}

/** Resolve the working directory: explicit query parameter first, session fallback second. */
function resolveCwd(url: URL, sessions: SessionManager): string | undefined {
  return optionalString(url, "cwd") ?? recentSessionCwd(sessions);
}

/**
 * Register the six read-only panel routes on `ctx.connection.fetch`.
 *
 * The `connection` service may not exist at `apply()` time: its module applies
 * asynchronously and only exposes `fetch` after the web host is up. So this
 * function installs immediately when the service is already reachable (unit
 * tests, profiles where the module mounted first), and otherwise waits through
 * `ctx.inject(["connection"], …)`. `connection` must never join the plugin's
 * static `inject` list: in a tree without the web host that dependency would
 * stay pending and block the entire plugin (headless deployments depend on the
 * plugin mounting anyway).
 *
 * Each `register()` result is retained as a disposer and called on unload, in
 * addition to the host's own `owner.effect` cleanup: `registerFetchRoute` in
 * DSH `rpc-host.ts` (lines ~234-251) scopes removal to the owner fiber, but the
 * owner here may not be this plugin's fiber, so explicit unregistration is the
 * safe path.
 *
 * The returned dispose function is idempotent: it unregisters routes, drops the
 * lazily opened inspector, and turns a late injection callback into a no-op.
 * Without a `connection` service this is a silent no-op.
 */
export function registerPanelApi(options: PanelApiOptions): () => Promise<void> {
  const { ctx, sessions, log, settings } = options;

  let installed = false;
  let disposed = false;
  const unregister: Array<() => unknown> = [];

  // The inspector is opened lazily so a profile that never opens the panel does
  // not pay for it. `cacheTtlMs: 0` disables the parsed-shard cache: in
  // `@harnmem/core` `inspect.ts:344` the option keeps `0` distinct from the
  // default 250 ms (`?? DEFAULT_CACHE_TTL_MS`), and `inspect.ts:382` only serves
  // a cached shard when `this.cacheTtlMs > 0`. So the panel always reflects
  // memories written earlier in the same process (`harnmem_write`) instead of a
  // stale snapshot. (`projects.json` keeps a 1000 ms floor, `inspect.ts:371` —
  // the registry changes rarely, so that is fine and not a correctness issue.)
  let opening: Promise<MemoryInspector> | undefined;
  const inspector = (): Promise<MemoryInspector> => {
    if (opening === undefined) {
      opening = MemoryInspector.open({ home: settings.home, cacheTtlMs: 0 }).catch((error: unknown) => {
        opening = undefined;
        throw error;
      });
    }
    return opening;
  };

  const routes: PanelFetchRoute[] = [
    {
      path: `${PANEL_API_PREFIX}/overview.get`,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: routeHandler(
        "overview",
        async (url): Promise<InspectOverview> => {
          const cwd = resolveCwd(url, sessions);
          return (await inspector()).overview({ cwd });
        },
        log,
      ),
    },
    {
      path: `${PANEL_API_PREFIX}/memories.list`,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: routeHandler(
        "memories.list",
        async (url): Promise<InspectList> => {
          const shard = optionalString(url, "shard") ?? "all";
          const includeInactive = parseFlag(url, "includeInactive");
          return (await inspector()).list({ shard, includeInactive });
        },
        log,
      ),
    },
    {
      path: `${PANEL_API_PREFIX}/memory.read`,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: routeHandler(
        "memory.read",
        async (url): Promise<InspectMemory | null> => {
          const id = optionalString(url, "id");
          if (id === undefined) throw new BadRequest("id is required");
          const history = parseFlag(url, "history") ?? false;
          return (await inspector()).read({ id, history });
        },
        log,
      ),
    },
    {
      path: `${PANEL_API_PREFIX}/context.preview`,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: routeHandler(
        "context.preview",
        async (url): Promise<InspectContext> => {
          const cwd = resolveCwd(url, sessions);
          const budgetTokens = parsePositiveInt(url, "budgetTokens") ?? settings.injectMaxTokens;
          const hotEntries = parsePositiveInt(url, "hotEntries") ?? settings.hotEntries;
          return (await inspector()).context({ cwd, budgetTokens, hotEntries });
        },
        log,
      ),
    },
    {
      path: `${PANEL_API_PREFIX}/index.read`,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: routeHandler(
        "index.read",
        async (url): Promise<InspectIndexText> => {
          const shard = optionalString(url, "shard") ?? "all";
          return (await inspector()).indexText({ shard });
        },
        log,
      ),
    },
    {
      path: `${PANEL_API_PREFIX}/projects.list`,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: routeHandler(
        "projects.list",
        async (): Promise<InspectProject[]> => (await inspector()).projects(),
        log,
      ),
    },
  ];

  /**
   * Install the routes against whichever context exposes the service. Called
   * either immediately (fast path) or later by the dynamic injection callback;
   * idempotent and inert after unload.
   */
  const install = (scope: HostContext): void => {
    if (installed || disposed) return;
    let service: unknown;
    try {
      service = scope.get("connection");
    } catch (error) {
      log.warn("panel.api.lookupFailed", { error: errorMessage(error) });
      return;
    }
    if (!isConnectionService(service)) {
      // Headless/test host: the panel simply does not exist. Not a warning.
      log.debug("panel.api.unavailable", { reason: "no connection.fetch service" });
      return;
    }
    installed = true;
    const register = service.fetch.register.bind(service.fetch);
    let registered = 0;
    for (const route of routes) {
      try {
        const disposer = register(route);
        if (typeof disposer === "function") unregister.push(disposer as () => unknown);
        registered += 1;
      } catch (error) {
        // One bad route must not take the rest of the panel down.
        log.warn("panel.api.routeFailed", { path: route.path, error: errorMessage(error) });
      }
    }
    log.debug("panel.api.ready", { routes: registered, prefix: PANEL_API_PREFIX, home: settings.home });
  };

  // Fast path first: the service is reachable already. When it is not, wait for
  // it through dynamic injection instead of polling or blocking `apply()`.
  let immediate: unknown;
  let lookupFailed = false;
  try {
    immediate = ctx.get("connection");
  } catch (error) {
    lookupFailed = true;
    log.warn("panel.api.lookupFailed", { error: errorMessage(error) });
  }
  if (lookupFailed) {
    // `ctx.get` itself is broken; injection would be built on the same lookup.
  } else if (isConnectionService(immediate)) {
    install(ctx);
  } else if (immediate !== undefined) {
    // Present but unusable: injection would hand us the same object.
    log.debug("panel.api.unavailable", { reason: "no connection.fetch service" });
  } else if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["connection"], (scope) => install(scope));
    } catch (error) {
      log.warn("panel.api.injectFailed", { error: errorMessage(error) });
    }
  } else {
    // No injection support on this host: the panel is absent, plugin is fine.
    log.debug("panel.api.unavailable", { reason: "no connection.inject support" });
  }

  return async () => {
    disposed = true;
    while (unregister.length > 0) {
      const disposeRoute = unregister.pop();
      if (disposeRoute === undefined) continue;
      try {
        await disposeRoute();
      } catch (error) {
        log.debug("panel.api.unregisterFailed", { error: errorMessage(error) });
      }
    }
    const pending = opening;
    opening = undefined;
    if (pending === undefined) return;
    try {
      const instance = await pending;
      await instance.close();
    } catch (error) {
      log.debug("panel.api.closeFailed", { error: errorMessage(error) });
    }
  };
}
