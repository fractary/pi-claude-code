/**
 * pi-claude-code — Grep.ts
 *
 * Registers the `Grep` tool that mirrors Claude Code's built-in Grep tool,
 * allowing Claude Code agents and skills to run in pi without modification.
 *
 * Implementation: rg (ripgrep) with grep -r fallback
 *
 * Derived from: @mariozechner/pi-coding-agent examples/extensions
 * On pi update: check ExtensionAPI / pi-tui imports for breaking changes.
 * On Claude Code update: verify Grep parameter schema at
 *   https://docs.anthropic.com/en/docs/claude-code/tools-reference
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 50_000;
const MAX_LINES = 500;

function truncateLines(lines: string[]): string {
	if (lines.length > MAX_LINES) {
		return (
			lines.slice(0, MAX_LINES).join("\n") +
			`\n\n[Grep: showing first ${MAX_LINES} of ${lines.length} results. Refine your pattern to narrow results.]`
		);
	}
	return lines.join("\n");
}

function truncateChars(output: string): string {
	if (output.length > MAX_OUTPUT_CHARS) {
		return output.slice(0, MAX_OUTPUT_CHARS) + `\n\n[Grep: output truncated at 50KB]`;
	}
	return output;
}

let rgAvailable: boolean | undefined;
async function hasRipgrep(): Promise<boolean> {
	if (rgAvailable !== undefined) return rgAvailable;
	try {
		await execFileAsync("rg", ["--version"]);
		rgAvailable = true;
	} catch {
		rgAvailable = false;
	}
	return rgAvailable;
}

const GrepParams = Type.Object({
	pattern: Type.String({
		description: "Regex pattern to search for in file contents",
	}),
	path: Type.Optional(Type.String({
		description: "Directory or file to search. Defaults to current working directory.",
	})),
	include: Type.Optional(Type.String({
		description: "Glob pattern to filter which files are searched (e.g. *.ts, **/*.md)",
	})),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "Grep",
		label: "Grep",
		description:
			"Search for a regex pattern in file contents. Returns matching lines with file path and line number. Use the include parameter to filter by file type.",
		parameters: GrepParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = resolve(ctx.cwd, params.path ?? ".");

			try {
				let stdout: string;

				if (await hasRipgrep()) {
					const args = ["rg", "-n", "--no-heading", "--color=never"];
					if (params.include) args.push("--glob", params.include);
					args.push(params.pattern, searchPath);

					const result = await execFileAsync(args[0], args.slice(1), {
						cwd: ctx.cwd,
						maxBuffer: MAX_OUTPUT_CHARS * 2,
						signal,
					});
					stdout = result.stdout;
				} else {
					const args = ["grep", "-r", "-n", "--color=never"];
					if (params.include) args.push(`--include=${params.include}`);
					args.push(params.pattern, searchPath);

					const result = await execFileAsync(args[0], args.slice(1), {
						cwd: ctx.cwd,
						maxBuffer: MAX_OUTPUT_CHARS * 2,
						signal,
					});
					stdout = result.stdout;
				}

				const lines = stdout.trim().split("\n").filter(Boolean);
				if (lines.length === 0) {
					return { content: [{ type: "text", text: "No matches found" }] };
				}

				return {
					content: [{ type: "text", text: truncateChars(truncateLines(lines)) }],
					details: { matchCount: lines.length },
				};
			} catch (error: any) {
				if (error.code === 1) {
					return { content: [{ type: "text", text: "No matches found" }] };
				}
				return { content: [{ type: "text", text: `Grep error: ${error.message}` }] };
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("Grep ")) + theme.fg("accent", `"${args.pattern}"`);
			if (args.path) text += theme.fg("muted", ` in ${args.path}`);
			if (args.include) text += theme.fg("dim", ` [${args.include}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _state, theme) {
			const details = result.details as { matchCount?: number } | undefined;
			if (details?.matchCount !== undefined) {
				return new Text(
					details.matchCount > MAX_LINES
						? theme.fg("warning", `${details.matchCount} matches (truncated to ${MAX_LINES})`)
						: theme.fg("muted", `${details.matchCount} match(es)`),
					0,
					0,
				);
			}
			const text = result.content[0];
			const output = text?.type === "text" ? text.text : "";
			return new Text(theme.fg("dim", output === "No matches found" ? "No matches" : output), 0, 0);
		},
	});
}
