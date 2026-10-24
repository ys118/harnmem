/**
 * Structural types for the DSH host objects this plugin touches.
 *
 * The real `@deepseek-ai/*` packages are shipped inside DSH's `app.asar` and are
 * not installable into this workspace, so the runtime imports them as bare peer
 * specifiers and these local interfaces describe only the shapes actually used.
 * Evidence baseline: DSH 0.2.1-rc.2 asar string probe + source checkout
 * 0.1.3-alpha.1 (see `docs/design/08-dsh-adapter.md` §3 and
 * `docs/research/dsh-impl-notes.md`). Facts marked in that design as `[verified]`
 * are reflected here; the rest stays structurally tolerant on purpose: a shape
 * mismatch degrades the feature instead of crashing the host.
 */

export type UnknownRecord = Record<string, unknown>;

/** Host logger. Cordis provides `ctx.logger` with these levels. */
export interface HostLogger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

/** `agent.session.header` (source checkout `runtime-types.ts`); `cwd` basename only for evidence. */
export interface HostSessionHeader {
  cwd?: string;
  delegationDepth?: number;
  parentSession?: string;
}

export interface HostSession {
  id: string;
  header?: HostSessionHeader;
}

export interface HostAgentOptions {
  /** Provider/model used by the LLM bridge; both must be present for extraction. */
  provider?: unknown;
  model?: unknown;
  /** Child agent depth when launched as a subagent. */
  subagentDepth?: number;
}

export interface HostAgent {
  session: HostSession;
  options?: HostAgentOptions;
}

/** Context passed to a `systemPrompt.section` text callback each step. */
export interface PromptSectionContext {
  agent?: HostAgent;
}

export interface PromptSection {
  name: string;
  /** Ascending; the AGENTS.md/CLAUDE.md instruction chain uses lower orders. */
  order: number;
  /** Re-evaluated synchronously on every step; must be pure/in-memory. */
  text: string | ((context: PromptSectionContext) => string);
}

export interface SystemPromptService {
  section(definition: PromptSection): unknown;
}

export interface ToolsService {
  register(definition: unknown): unknown;
}

/**
 * Subset of the cordis `Context` this plugin uses. `get("llm")` is optional:
 * a profile without a provider simply has no service.
 */
export interface HostContext {
  logger: HostLogger;
  on(event: string, handler: (...args: unknown[]) => unknown): unknown;
  get(service: string): unknown;
  systemPrompt?: SystemPromptService;
  tools?: ToolsService;
  /** Cordis effect API: used to close engines when the plugin unloads. */
  effect?(factory: () => Generator<() => Promise<unknown>>): unknown;
  /**
   * Cordis dynamic injection: invokes `callback` with a scoped context once all
   * `deps` services are available. Needed for services whose provider applies
   * asynchronously (the DSH `connection` service only exposes `fetch` after the
   * web host booted), and deliberately preferred over listing such a service in
   * the plugin-level `inject` array — that would block mounting entirely when
   * the service does not exist (headless profile, unit tests). If the dep never
   * appears, the callback simply never runs; that is the desired no-op.
   */
  inject?(deps: string[], callback: (scope: HostContext) => void): unknown;
}

/** Second argument of a tool's `execute(args, exec)`. */
export interface ToolExec {
  agent?: HostAgent;
  session?: HostSession;
  [key: string]: unknown;
}

/** Custom parameter descriptor used by `defineTool` (not JSON Schema). */
export interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  enum?: readonly string[];
  required?: boolean;
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  additionalProperties?: boolean;
}

/** Shape of a tool definition handed to `ctx.tools.register`. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, ToolParameter>;
  output?: unknown;
  execute(args: UnknownRecord, exec: ToolExec): Promise<unknown>;
  presentCall?(args: UnknownRecord): unknown;
}
