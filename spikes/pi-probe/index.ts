/**
 * HarnMem spike: minimal pi (v1.3.0) extension.
 *
 * Proves three things needed by the memory plugin:
 *  1. tool registration (probe_memory tool)
 *  2. event hooks (session_start, before_agent_start, before_provider_request, turn_end)
 *  3. system-prompt injection from before_agent_start
 *
 * Run headless:
 *   pi -p --no-session -e ./index.ts "Reply with exactly PROBE_DONE"
 * Evidence is written to ./probe.log next to this file.
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROBE_DIR = dirname(fileURLToPath(import.meta.url));
const LOG = join(PROBE_DIR, "probe.log");
const MARKER = `PI_PROBE_OK_${process.pid}_${Date.now()}`;

function log(msg: string): void {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		/* never break the host */
	}
}

export default function piProbe(pi: ExtensionAPI) {
	log(`factory loaded (cwd=${process.cwd()}, pi=${process.env.PI_VERSION ?? "?"})`);

	pi.on("session_start", async (event, ctx) => {
		const sm = ctx.sessionManager;
		log(
			`event session_start reason=${(event as { reason?: string }).reason ?? "?"} cwd=${ctx.cwd} ` +
			`sessionId=${sm.getSessionId()} file=${sm.getSessionFile() ?? "ephemeral"} entries=${sm.getEntries().length}`,
		);
		if (ctx.hasUI) ctx.ui.setStatus("pi-probe", "probe active");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const len = event.systemPrompt.length;
		log(`event before_agent_start systemPromptLen=${len} model=${(ctx as { model?: { id?: string } }).model?.id ?? "?"}`);
		return {
			systemPrompt:
				`${event.systemPrompt}\n\n## PI-PROBE INJECTED CONTEXT\n` +
				`- marker: ${MARKER}\n- cwd: ${ctx.cwd}\n- injectedBy: pi-probe v0\n`,
		};
	});

	pi.on("before_provider_request", async (event, _ctx) => {
		const payload = JSON.stringify(event.payload ?? {});
		log(`event before_provider_request payloadLen=${payload.length} hasMarker=${payload.includes(MARKER)}`);
	});

	pi.on("turn_end", async (event, _ctx) => {
		const e = event as { message?: { stopReason?: string } };
		log(`event turn_end stopReason=${e.message?.stopReason ?? "?"}`);
	});

	pi.registerTool({
		name: "probe_memory",
		label: "Probe Memory",
		description: "HarnMem spike tool: echo text back to prove custom tool registration works.",
		parameters: Type.Object({
			text: Type.String({ description: "Text to echo" }),
			limit: Type.Optional(Type.Number({ description: "Optional numeric limit" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			log(`tool execute probe_memory params=${JSON.stringify(params)} cwd=${ctx.cwd}`);
			return {
				content: [{ type: "text", text: `probe:${params.text}:${params.limit ?? 0}` }],
				details: { echo: params.text, limit: params.limit ?? 0 },
			};
		},
	});

	pi.registerCommand("probe-status", {
		description: "Show pi-probe status (spike extension)",
		handler: async (_args, ctx) => {
			log("command probe-status invoked");
			if (ctx.hasUI) ctx.ui.notify("pi-probe: loaded", "info");
		},
	});

	log("factory done: 1 tool + 3 events + 1 command registered");
}
