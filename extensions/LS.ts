/**
 * pi-claude-code — LS.ts
 *
 * Registers the `LS` tool that mirrors Claude Code's built-in LS tool,
 * allowing Claude Code agents and skills to run in pi without modification.
 *
 * Implementation: ls -la
 *
 * Derived from: @mariozechner/pi-coding-agent examples/extensions
 * On pi update: check ExtensionAPI / pi-tui imports for breaking changes.
 * On Claude Code update: verify LS parameter schema at
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

function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

const LsParams = Type.Object({
	path: Type.String({
		description: "Directory path to list",
	}),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "LS",
		label: "LS",
		description: "List the contents of a directory, including hidden files.",
		parameters: LsParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const targetPath = resolve(ctx.cwd, params.path);

			try {
				const { stdout } = await execFileAsync("ls", ["-la", targetPath], {
					cwd: ctx.cwd,
					maxBuffer: MAX_OUTPUT_CHARS * 2,
					signal,
				});

				let output = stdout.trim();
				if (output.length > MAX_OUTPUT_CHARS) {
					output = output.slice(0, MAX_OUTPUT_CHARS) + "\n\n[LS: output truncated at 50KB]";
				}

				return { content: [{ type: "text", text: output }] };
			} catch (error: any) {
				return { content: [{ type: "text", text: `LS error: ${error.message}` }] };
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("LS ")) + theme.fg("accent", shellQuote(args.path)),
				0,
				0,
			);
		},

		renderResult(result, _state, theme) {
			const text = result.content[0];
			const output = text?.type === "text" ? text.text : "";
			const items = output.split("\n").filter((l) => l && !l.startsWith("total"));
			return new Text(theme.fg("muted", `${items.length} item(s)`), 0, 0);
		},
	});
}
