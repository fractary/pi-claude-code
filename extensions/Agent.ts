/**
 * pi-claude-code — Agent.ts
 *
 * Registers the `Agent` tool that mirrors Claude Code v2.1.63+'s Agent() tool
 * (which replaced Task() while remaining backward compatible).
 *
 * Maps Agent({ description, prompt }) → pi subagent execution via pi-subagents.
 *
 * Agent name resolution:
 *   1. `description` normalised to kebab-case and matched against discovered agents
 *   2. Prefix/substring match as fallback
 *   3. If no match, returns a clear error listing available agents
 *
 * Requires: pi-subagents (optional peer dependency)
 *   pi install npm:pi-subagents
 *
 * Graceful degradation: if pi-subagents is not installed, the tool loads
 * successfully but returns a helpful error message on first invocation instead
 * of failing at extension load time.
 *
 * Derived from: pi-subagents@0.11.11 execution/agents/artifacts APIs
 * On pi-subagents update: verify runSync / discoverAgents / getArtifactsDir signatures.
 * On Claude Code update: verify Agent() parameter schema at
 *   https://docs.anthropic.com/en/docs/claude-code/tools-reference
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Lazy pi-subagents loader (graceful degradation) ─────────────────────────

interface PiSubagentsAPI {
	runSync: Function;
	discoverAgents: Function;
	getArtifactsDir: Function;
	ensureArtifactsDir: Function;
}

let _api: PiSubagentsAPI | null = null;
let _loadError: string | null = null;
let _loaded = false;

async function loadPiSubagents(): Promise<PiSubagentsAPI | null> {
	if (_loaded) return _api;
	_loaded = true;

	try {
		const [execMod, agentsMod, artifactsMod] = await Promise.all([
			import("pi-subagents/execution.ts" as string),
			import("pi-subagents/agents.ts" as string),
			import("pi-subagents/artifacts.ts" as string),
		]);
		_api = {
			runSync:            execMod.runSync,
			discoverAgents:     agentsMod.discoverAgents,
			getArtifactsDir:    artifactsMod.getArtifactsDir,
			ensureArtifactsDir: artifactsMod.ensureArtifactsDir,
		};
	} catch (e: any) {
		_loadError =
			`Agent() shim requires pi-subagents — install it with:\n` +
			`  pi install npm:pi-subagents\n` +
			`(Error: ${e.message})`;
	}

	return _api;
}

// ─── Parameter schema (Claude Code Agent() format) ───────────────────────────

const AgentParams = Type.Object({
	description: Type.String({
		description: "Name or short description of the agent to invoke (matched to a pi agent by name)",
	}),
	prompt: Type.String({
		description: "The full task or instructions to pass to the agent",
	}),
});

interface AgentDetails {
	description: string;
	resolvedAgent: string | null;
	prompt: string;
	error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise a Claude Code description to a pi agent name (kebab-case, lowercase) */
function normaliseToAgentName(description: string): string {
	return description
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Find best matching agent: exact → substring → normalised */
function resolveAgent(description: string, agents: any[]): string | null {
	if (agents.length === 0) return null;
	const normalised = normaliseToAgentName(description);

	const exact = agents.find((a) => a.name === description || a.name === normalised);
	if (exact) return exact.name;

	const partial = agents.find((a) => a.name.includes(normalised) || normalised.includes(a.name));
	if (partial) return partial.name;

	return null;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description:
			"Invoke a named agent with a task. Mirrors Claude Code's Agent() tool (formerly Task()). " +
			"The description field is matched to a pi agent by name. " +
			"Requires pi-subagents to be installed: pi install npm:pi-subagents",
		parameters: AgentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const api = await loadPiSubagents();
			if (!api) {
				return {
					content: [{ type: "text", text: _loadError ?? "pi-subagents not available" }],
					details: {
						description: params.description,
						resolvedAgent: null,
						prompt: params.prompt,
						error: _loadError ?? "pi-subagents not available",
					} as AgentDetails,
				};
			}

			const { agents } = api.discoverAgents(ctx.cwd, "both");
			const resolvedAgent = resolveAgent(params.description, agents);

			if (!resolvedAgent) {
				const available = agents.map((a: any) => `  • ${a.name}`).join("\n") || "  (none found)";
				return {
					content: [{
						type: "text",
						text:
							`Agent not found: "${params.description}" (normalised: "${normaliseToAgentName(params.description)}")\n\n` +
							`Available agents:\n${available}`,
					}],
					details: {
						description: params.description,
						resolvedAgent: null,
						prompt: params.prompt,
						error: `No agent matched "${params.description}"`,
					} as AgentDetails,
				};
			}

			const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
			const artifactsDir = sessionFile
				? api.getArtifactsDir(sessionFile)
				: mkdtempSync(join(tmpdir(), "pi-agent-shim-"));
			api.ensureArtifactsDir(artifactsDir);

			const runId = randomUUID();

			try {
				const result = await api.runSync(ctx.cwd, agents, resolvedAgent, params.prompt, {
					cwd: ctx.cwd,
					signal,
					onUpdate,
					runId,
					artifactsDir,
					index: 0,
				});

				const output = result.output ?? result.error ?? "(no output)";
				return {
					content: [{ type: "text", text: output }],
					details: {
						description: params.description,
						resolvedAgent,
						prompt: params.prompt,
					} as AgentDetails,
				};
			} catch (error: any) {
				return {
					content: [{ type: "text", text: `Agent execution error: ${error.message}` }],
					details: {
						description: params.description,
						resolvedAgent,
						prompt: params.prompt,
						error: error.message,
					} as AgentDetails,
				};
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("Agent ")) +
					theme.fg("accent", args.description) +
					theme.fg("dim", ` — "${args.prompt?.slice(0, 60)}${(args.prompt?.length ?? 0) > 60 ? "…" : ""}"`),
				0,
				0,
			);
		},

		renderResult(result, _state, theme) {
			const details = result.details as AgentDetails | undefined;
			if (details?.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			if (details?.resolvedAgent) {
				const text = result.content[0];
				const lines = (text?.type === "text" ? text.text : "").split("\n").filter(Boolean).length;
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("accent", details.resolvedAgent) +
						theme.fg("muted", ` — ${lines} line(s)`),
					0,
					0,
				);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? theme.fg("muted", text.text) : "", 0, 0);
		},
	});
}
