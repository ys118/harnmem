/**
 * Fake DSH host context for node:test suites.
 *
 * Mirrors the documented surface in docs/design/08-dsh-adapter.md §3–§6: cordis
 * `ctx.on` event handlers, `ctx.systemPrompt.section`, `ctx.tools.register`,
 * `ctx.get(service)` and `ctx.effect`. No real host packages are needed.
 */

export function createFakeContext() {
  /** @type {Map<string, Array<(...args: unknown[]) => unknown>>} */
  const handlers = new Map();
  const sections = [];
  const tools = [];
  const logs = [];
  const effects = [];
  const services = new Map();

  const push = (level) => (message, data) => logs.push({ level, message, data });

  const ctx = {
    logger: { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    get(name) {
      return services.get(name);
    },
    effect(factory) {
      effects.push(factory);
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition);
      },
    },
    tools: {
      register(definition) {
        tools.push(definition);
      },
    },
  };

  return {
    ctx,
    handlers,
    sections,
    tools,
    logs,
    effects,
    provide(name, value) {
      services.set(name, value);
    },
    /** Invoke every handler for an event; awaits async handlers. */
    async emit(event, ...args) {
      const list = handlers.get(event) ?? [];
      const results = [];
      for (const handler of list) results.push(await handler(...args));
      return results;
    },
    has(event) {
      return (handlers.get(event) ?? []).length > 0;
    },
    /** Current injection text for an agent (the section callback is synchronous). */
    sectionText(agent) {
      const section = sections.find((candidate) => candidate.name === "harnmem:hot-index");
      if (!section) throw new Error("harnmem:hot-index section not registered");
      return typeof section.text === "function" ? section.text({ agent }) : section.text;
    },
    tool(name) {
      const definition = tools.find((candidate) => candidate.name === name);
      if (!definition) throw new Error(`tool ${name} not registered`);
      return definition;
    },
    effectCleanups() {
      const cleanups = [];
      for (const factory of effects) {
        const iterator = factory();
        let step = iterator.next();
        while (!step.done) {
          cleanups.push(step.value);
          step = iterator.next();
        }
      }
      return cleanups;
    },
    logsWith(prefix) {
      return logs.filter((entry) => String(entry.message).includes(prefix));
    },
  };
}

export function fakeAgent({
  sessionId = "session-1",
  cwd = process.cwd(),
  depth = 0,
  parentSession,
  provider,
  model,
} = {}) {
  const header = { cwd };
  if (depth > 0) header.delegationDepth = depth;
  if (parentSession) header.parentSession = parentSession;
  return { session: { id: sessionId, header }, options: { provider, model, subagentDepth: depth } };
}

export async function waitForLog(host, needle, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const found = host.logs.find((entry) => String(entry.message).includes(needle));
    if (found) return found;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for log ${needle}; saw: ${host.logs.map((entry) => entry.message).join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
