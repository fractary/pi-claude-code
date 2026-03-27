/**
 * pi-claude-code — WebFetch.ts
 *
 * Registers the `WebFetch` tool that mirrors Claude Code's built-in WebFetch
 * tool, allowing Claude Code agents and skills to run in pi without modification.
 *
 * Implementation: Jina Reader (r.jina.ai) — prepend to any URL to get clean
 * markdown extraction. No API key or dependencies required.
 *
 * Jina Reader automatically:
 *   - Strips navigation, ads, and boilerplate
 *   - Returns clean markdown suitable for LLM consumption
 *   - Handles paywalled content where possible
 *   - Supports most public URLs including docs, articles, GitHub, etc.
 *
 * On Claude Code update: verify WebFetch parameter schema at
 *   https://docs.anthropic.com/en/docs/claude-code/tools-reference
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const MAX_OUTPUT_CHARS = 50_000;

const JINA_BASE = "https://r.jina.ai/";

const WebFetchParams = Type.Object({
	url: Type.String({
		description: "The URL to fetch content from",
	}),
	prompt: Type.Optional(Type.String({
		description: "Optional hint about what information to extract (noted in result header, model uses it for focus)",
	})),
});

interface WebFetchDetails {
	url: string;
	jinaUrl: string;
	prompt?: string;
	contentLength: number;
	truncated: boolean;
	error?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "WebFetch",
		label: "WebFetch",
		description:
			"Fetch content from a URL and return it as clean markdown. Mirrors Claude Code's WebFetch tool. " +
			"Uses Jina Reader (r.jina.ai) for clean extraction — no API key required.",
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const jinaUrl = JINA_BASE + params.url;

			try {
				const response = await fetch(jinaUrl, {
					headers: {
						"Accept": "text/plain, text/markdown, */*",
						"X-Return-Format": "markdown",
					},
					signal,
				});

				if (!response.ok) {
					const errText = `WebFetch failed: HTTP ${response.status} ${response.statusText} for ${params.url}`;
					return {
						content: [{ type: "text", text: errText }],
						details: {
							url: params.url,
							jinaUrl,
							prompt: params.prompt,
							contentLength: 0,
							truncated: false,
							error: errText,
						} as WebFetchDetails,
					};
				}

				let content = await response.text();
				const originalLength = content.length;
				let truncated = false;

				if (content.length > MAX_OUTPUT_CHARS) {
					content = content.slice(0, MAX_OUTPUT_CHARS) +
						`\n\n[WebFetch: content truncated at 50KB (original: ${Math.round(originalLength / 1024)}KB)]`;
					truncated = true;
				}

				// Prepend prompt context if provided so the model knows what to look for
				const header = params.prompt
					? `<!-- WebFetch: ${params.url} | Focus: ${params.prompt} -->\n\n`
					: `<!-- WebFetch: ${params.url} -->\n\n`;

				return {
					content: [{ type: "text", text: header + content }],
					details: {
						url: params.url,
						jinaUrl,
						prompt: params.prompt,
						contentLength: originalLength,
						truncated,
					} as WebFetchDetails,
				};
			} catch (error: any) {
				const errText = `WebFetch error: ${error.message}`;
				return {
					content: [{ type: "text", text: errText }],
					details: {
						url: params.url,
						jinaUrl,
						prompt: params.prompt,
						contentLength: 0,
						truncated: false,
						error: error.message,
					} as WebFetchDetails,
				};
			}
		},

		renderCall(args, theme) {
			// Trim URL for display
			const displayUrl = args.url.length > 60
				? args.url.slice(0, 57) + "…"
				: args.url;
			let text = theme.fg("toolTitle", theme.bold("WebFetch ")) + theme.fg("accent", displayUrl);
			if (args.prompt) text += theme.fg("dim", ` — "${args.prompt.slice(0, 40)}${args.prompt.length > 40 ? "…" : ""}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _state, theme) {
			const details = result.details as WebFetchDetails | undefined;
			if (details?.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			if (details) {
				const sizeKb = Math.round(details.contentLength / 1024);
				const truncFlag = details.truncated ? theme.fg("warning", " (truncated)") : "";
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("muted", `${sizeKb}KB fetched`) +
						truncFlag,
					0,
					0,
				);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? theme.fg("muted", text.text.slice(0, 80)) : "", 0, 0);
		},
	});
}
