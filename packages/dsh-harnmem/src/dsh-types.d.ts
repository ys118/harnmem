/**
 * Ambient declarations for DSH host packages that cannot be installed here.
 *
 * DSH's `@deepseek-ai/*` runtime packages ship inside `app.asar`; the profile
 * `node_modules/@deepseek-ai/*` entries on this machine are dead junctions.
 * The published rc versions do not match the running 0.2.1-rc.2 surface, so
 * hand-written structural declarations are the safe baseline. Every symbol
 * below is imported at runtime as a bare peer specifier and resolved by the
 * host process; when it is absent (unit tests, non-DSH CI) the adapters fall
 * back — see `src/config.ts`, `src/tools.ts`, `src/llm.ts`.
 *
 * Evidence: docs/design/08-dsh-adapter.md §3–§6 and docs/research/dsh-impl-notes.md.
 * `[verified]` = found in the 0.2.1 asar probe or the 0.1.3-alpha.1 checkout.
 */

declare module "@deepseek-ai/cordis" {
  /** Minimal structural view of a cordis context (see `src/host.ts` for the used subset). */
  export interface Context {
    logger: {
      debug?(message: string, ...args: unknown[]): void;
      info?(message: string, ...args: unknown[]): void;
      warn?(message: string, ...args: unknown[]): void;
      error?(message: string, ...args: unknown[]): void;
    };
    on(event: string, handler: (...args: unknown[]) => unknown): unknown;
    get(service: string): unknown;
    effect?(factory: () => Generator<() => Promise<unknown>>): unknown;
  }
}

declare module "@deepseek-ai/dsh-agent" {
  /**
   * `[verified]` (checkout `runtime-types.ts:204/213`): agents are created and
   * disposed by the host; the session id, header and options are stable.
   */
  export interface SessionHeader {
    cwd?: string;
    delegationDepth?: number;
    parentSession?: string;
  }
  export interface Session {
    id: string;
    header?: SessionHeader;
  }
  export interface AgentOptions {
    provider?: unknown;
    model?: unknown;
    subagentDepth?: number;
  }
  export interface Agent {
    session: Session;
    options?: AgentOptions;
  }
}

declare module "@deepseek-ai/dsh-session" {
  export interface Session {
    id: string;
    header?: { cwd?: string; delegationDepth?: number; parentSession?: string };
  }
}

declare module "@deepseek-ai/dsh-system-prompt" {
  export interface SectionContext {
    agent?: { session: { id: string } };
  }
  export interface Section {
    name: string;
    order: number;
    text: string | ((context: SectionContext) => string);
  }
  export interface SystemPromptService {
    section(definition: Section): unknown;
  }
}

declare module "@deepseek-ai/dsh-tools" {
  /**
   * `[verified]` exported by the host's tools package (asar probe: `defineTool`,
   * `tools.register`); the parameter descriptor shape is the custom one used by
   * DSH, not JSON Schema.
   */
  export interface ToolDefinition {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
    output?: unknown;
    execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>;
    presentCall?(args: Record<string, unknown>): unknown;
  }
  export function defineTool<T extends ToolDefinition>(definition: T): T;
}

declare module "@deepseek-ai/dsh-llm" {
  /**
   * `[inferred]` from dsh-auto-memory's imports (`lib/index.js:1831-1835`):
   * `BlockAssembler` accumulates streaming chunks; `finish.kind` has at least
   * `error`/`aborted`, the success variant is unverified → the bridge treats a
   * non-empty `blocks()` text as success (`docs/design/08-dsh-adapter.md` R5).
   */
  export interface TextBlock {
    type: string;
    text?: string;
  }
  export interface FinishState {
    kind: string;
    error?: unknown;
  }
  export class BlockAssembler {
    push(chunk: unknown): void;
    blocks(): TextBlock[];
    readonly finish: FinishState;
  }
  export interface UserMessageInput {
    content: Array<{ type: "text"; text: string }>;
    source?: unknown;
  }
  export function createUserMessage(input: UserMessageInput): unknown;
}

declare module "@deepseek-ai/dsh-atomic-write" {
  /** `[verified]` package exists in the profile; used by the host, not by this plugin. */
  export function writeFileAtomic(path: string, data: string): Promise<void>;
}

declare module "@deepseek-ai/dsh-home-paths" {
  /** `[verified]` resolved home paths; this plugin deliberately uses its own `~/.harnmem` home. */
  export function dshHome(): string;
}
