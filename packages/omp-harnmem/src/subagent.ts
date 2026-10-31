/**
 * Subagent-session detection for oh-my-pi.
 *
 * omp exposes the agent identity on every ExtensionContext as
 * `ctx.agent = { kind, id, name, depth }`; the main session reports
 * `{ kind: "main", id: "Main", name: "main", depth: 0 }` and nested
 * task/subagent sessions run with `depth > 0` (verified against omp
 * 18.14.1 at runtime). When we cannot prove we are a root session we
 * behave read-only (no writes, no extraction) so a child can never
 * duplicate the parent's memories.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export interface ChildDetection {
  isChild: boolean;
  evidence: string;
}

interface AgentIdentity {
  kind?: unknown;
  depth?: unknown;
}

export function detectChildSession(ctx: ExtensionContext): ChildDetection {
  const agent = (ctx as { agent?: AgentIdentity }).agent;
  if (!agent || typeof agent !== "object") {
    return { isChild: false, evidence: "no-agent-identity" };
  }
  const depth = typeof agent.depth === "number" ? agent.depth : 0;
  const kind = typeof agent.kind === "string" && agent.kind.length > 0 ? agent.kind : "main";
  const isChild = depth > 0 || kind !== "main";
  return { isChild, evidence: `kind=${kind} depth=${depth}` };
}
