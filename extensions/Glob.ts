/**
 * pi-claude-code — Glob.ts
 *
 * Registers the `Glob` tool that mirrors Claude Code's built-in Glob tool,
 * allowing Claude Code agents and skills to run in pi without modification.
 *
 * Implementation: rg --files with find fallback
 *
 * Derived from: @mariozechner/pi-coding-agent examples/extensions
 * On pi update: check ExtensionAPI / pi-tui imports for breaking changes.
 * On Claude Code update: verify Glob parameter schema at
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

function truncateLines(files: string[]): string {
	if (files.length > MAX_LINES) {
		return (
			files.slice(0, MAX_LINES).join("\n") +
			`\n\n[Glob: showing first ${MAX_LINES} of ${files.length} results. Refine your pattern to narrow results.]`
		);
	}
	return files.join("\n");
}

function truncateChars(output: string): string {
	if (output.length > MAX_OUTPUT_CHARS) {
		return output.slice(0, MAX_OUTPUT_CHARS) + `\n\n[Glob: output truncated at 50KB]`;
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

const GlobParams = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files (e.g. **/*.ts, src/**/*.json)",
	}),
	path: Type.Optional(Type.String({
		description: "Directory to search within. Defaults to current working directory.",
	})),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "Glob",
		label: "Glob",
		description:
			"Find files matching a glob pattern. Returns a list of matching file paths sorted by modification time (newest first).",
		parameters: GlobParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = resolve(ctx.cwd, params.path ?? ".");

			try {
				let files: string[];

				if (await hasRipgrep()) {
					const result = await execFileAsync(
						"rg",
						["--files", "--color=never", "--glob", params.pattern, searchPath],
						{ cwd: ctx.cwd, maxBuffer: MAX_OUTPUT_CHARS * 2, signal },
					);
					files = result.stdout.trim().split("\n").filter(Boolean);
				} else {
					// find fallback — convert **/*.ext → -name "*.ext"
					const basename = params.pattern.replace(/^(\*\*\/)+/, "");
					const result = await execFileAsync(
						"find",
						[searchPath, "-type", "f", "-name", basename],
						{ cwd: ctx.cwd, maxBuffer: MAX_OUTPUT_CHARS * 2, signal },
					);
					files = result.stdout.trim().split("\n").filter(Boolean);
				}

				if (files.length === 0) {
					return { content: [{ type: "text", text: "No files found" }] };
				}

				return {
					content: [{ type: "text", text: truncateChars(truncateLines(files)) }],
					details: { fileCount: files.length },
				};
			} catch (error: any) {
				if (error.code === 1) {
					return { content: [{ type: "text", text: "No files found" }] };
				}
				return { content: [{ type: "text", text: `Glob error: ${error.message}` }] };
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("Glob ")) + theme.fg("accent", args.pattern);
			if (args.path) text += theme.fg("muted", ` in ${args.path}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _state, theme) {
			const details = result.details as { fileCount?: number } | undefined;
			if (details?.fileCount !== undefined) {
				return new Text(
					details.fileCount > MAX_LINES
						? theme.fg("warning", `${details.fileCount} files (truncated to ${MAX_LINES})`)
						: theme.fg("muted", `${details.fileCount} file(s)`),
					0,
					0,
				);
			}
			const text = result.content[0];
			const output = text?.type === "text" ? text.text : "";
			return new Text(theme.fg("dim", output === "No files found" ? "No files found" : output), 0, 0);
		},
	});
}
