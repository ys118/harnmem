/**
 * Conservative subagent-session detection.
 *
 * pi-subagents runs child sessions in the same process/extension runtime for
 * background children (and separate processes for foreground ones). Child
 * processes carry marker environment variables. When we cannot prove we are a
 * root session we behave read-only (no writes, no extraction) so a background
 * child can never duplicate the parent's memories.
 *
 * Markers verified against pi-subagents 0.79.1 dist:
 *   PI_SUBAGENT_CHILD, PI_SUBAGENT_PARENT_SESSION, PI_SUBAGENT_RUNNER_CONFIG
 */

export interface ChildDetection {
  isChild: boolean;
  evidence: string;
}

const CHILD_MARKERS = [
  "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_PARENT_SESSION",
  "PI_SUBAGENT_RUNNER_CONFIG",
  "PI_SUBAGENTS_CHILD",
] as const;

function isEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return !(v === "" || v === "0" || v === "false" || v === "no");
}

export function detectChildSession(env: NodeJS.ProcessEnv = process.env): ChildDetection {
  for (const marker of CHILD_MARKERS) {
    if (isEnabled(env[marker])) return { isChild: true, evidence: marker };
  }
  return { isChild: false, evidence: "none" };
}
