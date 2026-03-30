/**
 * pi-claude-code — Skill.ts
 *
 * Registers the `Skill` tool that mirrors Claude Code's built-in Skill tool,
 * allowing Claude Code agents and skills to run in pi without modification.
 *
 * Implementation:
 *   Parses the session system prompt's <available_skills> block (built by pi's
 *   package manager at startup) to discover all available skills. This is the
 *   authoritative post-resolution skill registry — the same list already injected
 *   into context — so it correctly includes skills from all installed packages.
 *
 *   {baseDir} placeholders in skill content are resolved to the skill's
 *   actual directory path before returning, matching pi's own convention.
 *
 *   If `arguments` are provided they are appended to the skill content,
 *   matching pi's `/skill:name <args>` behaviour.
 *
 * Name matching:
 *   Exact match first, then prefix/suffix match for common patterns like
 *   "fractary-faber-workflow-run-verifier" matching "workflow-run-verifier".
 *
 * On Claude Code update: verify Skill parameter schema at
 *   https://docs.anthropic.com/en/docs/claude-code/tools-reference
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const SkillParams = Type.Object({
	name: Type.String({
		description: "Name of the skill to execute (must match a discovered skill name)",
	}),
	arguments: Type.Optional(Type.String({
		description: "Optional arguments or context to pass to the skill",
	})),
});

interface SkillDetails {
	name: string;
	resolvedSkill: string | null;
	filePath: string | null;
	error?: string;
}

// ─── Skill map (populated from system prompt at session_start) ────────────────

interface SkillEntry {
	name: string;
	filePath: string;
	baseDir: string;
}

/** Parse the <available_skills> block from the system prompt into name→entry map. */
function parseSkillsFromSystemPrompt(systemPrompt: string): Map<string, SkillEntry> {
	const map = new Map<string, SkillEntry>();
	const skillPattern = /<skill>\s*<name>([^<]+)<\/name>\s*<description>[^<]*<\/description>\s*<location>([^<]+)<\/location>\s*<\/skill>/gs;
	for (const m of systemPrompt.matchAll(skillPattern)) {
		const name = m[1].trim();
		const filePath = m[2].trim();
		map.set(name, { name, filePath, baseDir: dirname(filePath) });
	}
	return map;
}

/** Find best-matching skill: exact → suffix → contains. */
function resolveFromMap(name: string, map: Map<string, SkillEntry>): SkillEntry | null {
	// 1. Exact match
	const exact = map.get(name);
	if (exact) return exact;

	// 2. Suffix match — "workflow-runner" matches "fractary-faber-workflow-runner"
	for (const [k, v] of map) {
		if (k.endsWith(`-${name}`) || k.endsWith(name)) return v;
	}

	// 3. Contains match
	for (const [k, v] of map) {
		if (k.includes(name) || name.includes(k)) return v;
	}

	return null;
}

/** Substitute {baseDir} and {name} placeholders in skill content. */
function resolveSkillContent(content: string, skill: SkillEntry): string {
	return content
		.replace(/\{baseDir\}/g, skill.baseDir)
		.replace(/\{name\}/g, skill.name);
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Skill map populated once per session from the already-resolved system prompt.
	// This avoids re-running package manager discovery and correctly reflects all
	// skills contributed by installed packages and project manifests.
	let skillMap = new Map<string, SkillEntry>();

	pi.on("session_start", (_event, ctx) => {
		skillMap = parseSkillsFromSystemPrompt(ctx.getSystemPrompt());
	});

	pi.registerTool({
		name: "Skill",
		label: "Skill",
		description:
			"Execute a skill within the main conversation. Mirrors Claude Code's Skill tool. " +
			"Loads the skill's SKILL.md content and returns it so the model can follow its instructions.",
		parameters: SkillParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Ensure map is populated (handles edge case where session_start
			// hasn't fired yet, e.g. first tool call in a new session)
			if (skillMap.size === 0) {
				skillMap = parseSkillsFromSystemPrompt(ctx.getSystemPrompt());
			}

			const skill = resolveFromMap(params.name, skillMap);

			if (!skill) {
				const available = [...skillMap.keys()].map((k) => `  • ${k}`).join("\n") || "  (none found)";
				return {
					content: [{
						type: "text",
						text:
							`Skill not found: "${params.name}"\n\n` +
							`Available skills:\n${available}`,
					}],
					details: {
						name: params.name,
						resolvedSkill: null,
						filePath: null,
						error: `No skill matched "${params.name}"`,
					} as SkillDetails,
				};
			}

			let content: string;
			try {
				content = readFileSync(skill.filePath, "utf-8");
			} catch (error: any) {
				return {
					content: [{
						type: "text",
						text: `Failed to read skill "${skill.name}": ${error.message}`,
					}],
					details: {
						name: params.name,
						resolvedSkill: skill.name,
						filePath: skill.filePath,
						error: error.message,
					} as SkillDetails,
				};
			}

			// Resolve {baseDir} and other placeholders
			content = resolveSkillContent(content, skill);

			// Append user arguments if provided, matching /skill:name <args> behaviour
			if (params.arguments?.trim()) {
				content += `\n\nUser: ${params.arguments.trim()}`;
			}

			return {
				content: [{ type: "text", text: content }],
				details: {
					name: params.name,
					resolvedSkill: skill.name,
					filePath: skill.filePath,
				} as SkillDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("Skill ")) + theme.fg("accent", args.name);
			if (args.arguments) {
				text += theme.fg("dim", ` "${args.arguments.slice(0, 50)}${args.arguments.length > 50 ? "…" : ""}"`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _state, theme) {
			const details = result.details as SkillDetails | undefined;
			if (details?.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			if (details?.resolvedSkill) {
				const text = result.content[0];
				const lines = (text?.type === "text" ? text.text : "").split("\n").filter(Boolean).length;
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("accent", details.resolvedSkill) +
						theme.fg("muted", ` — ${lines} line(s)`),
					0,
					0,
				);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? theme.fg("muted", text.text.slice(0, 80)) : "", 0, 0);
		},
	});
}
