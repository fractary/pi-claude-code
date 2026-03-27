/**
 * pi-claude-code — WebSearch.ts
 *
 * Registers the `WebSearch` tool that mirrors Claude Code's built-in WebSearch
 * tool, allowing Claude Code agents and skills to run in pi without modification.
 *
 * Implementation: Brave Search API (https://api.search.brave.com)
 *
 * Requires: BRAVE_API_KEY environment variable
 *   1. Create a free account at https://api-dashboard.search.brave.com/register
 *   2. Create a "Free AI" subscription (no charge)
 *   3. Generate an API key
 *   4. Add to your shell profile: export BRAVE_API_KEY="your-key"
 *
 * Graceful degradation: if BRAVE_API_KEY is not set, the tool loads cleanly
 * but returns a setup instruction on first use.
 *
 * On Claude Code update: verify WebSearch parameter schema at
 *   https://docs.anthropic.com/en/docs/claude-code/tools-reference
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;

const WebSearchParams = Type.Object({
	query: Type.String({
		description: "The search query",
	}),
	count: Type.Optional(Type.Number({
		description: `Number of results to return (default: ${DEFAULT_COUNT}, max: ${MAX_COUNT})`,
	})),
});

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	age?: string;
}

interface WebSearchDetails {
	query: string;
	count: number;
	results: SearchResult[];
	error?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "WebSearch",
		label: "WebSearch",
		description:
			"Perform a web search and return results. Mirrors Claude Code's WebSearch tool. " +
			"Uses Brave Search API — requires BRAVE_API_KEY environment variable.",
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const apiKey = process.env.BRAVE_API_KEY;

			if (!apiKey) {
				const errText =
					"WebSearch requires a Brave Search API key.\n\n" +
					"Setup:\n" +
					"  1. Create a free account at https://api-dashboard.search.brave.com/register\n" +
					"  2. Create a 'Free AI' subscription\n" +
					"  3. Generate an API key\n" +
					"  4. Add to your shell profile: export BRAVE_API_KEY=\"your-key\"";
				return {
					content: [{ type: "text", text: errText }],
					details: { query: params.query, count: 0, results: [], error: "BRAVE_API_KEY not set" } as WebSearchDetails,
				};
			}

			const count = Math.min(params.count ?? DEFAULT_COUNT, MAX_COUNT);

			const searchParams = new URLSearchParams({
				q: params.query,
				count: count.toString(),
			});

			try {
				const response = await fetch(`${BRAVE_API_URL}?${searchParams}`, {
					headers: {
						"Accept": "application/json",
						"Accept-Encoding": "gzip",
						"X-Subscription-Token": apiKey,
					},
					signal,
				});

				if (!response.ok) {
					const body = await response.text().catch(() => "");
					const errText = `WebSearch failed: HTTP ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`;
					return {
						content: [{ type: "text", text: errText }],
						details: { query: params.query, count, results: [], error: errText } as WebSearchDetails,
					};
				}

				const data = await response.json() as any;
				const results: SearchResult[] = [];

				if (data.web?.results) {
					for (const r of data.web.results) {
						if (results.length >= count) break;
						results.push({
							title:   r.title       ?? "",
							url:     r.url         ?? "",
							snippet: r.description ?? "",
							age:     r.age ?? r.page_age ?? undefined,
						});
					}
				}

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: `No results found for: ${params.query}` }],
						details: { query: params.query, count, results: [] } as WebSearchDetails,
					};
				}

				// Format results as readable text matching Claude Code's output style
				const formatted = results.map((r, i) => {
					const parts = [`${i + 1}. **${r.title}**`, `   ${r.url}`];
					if (r.snippet) parts.push(`   ${r.snippet}`);
					if (r.age)     parts.push(`   ${r.age}`);
					return parts.join("\n");
				}).join("\n\n");

				return {
					content: [{ type: "text", text: formatted }],
					details: { query: params.query, count, results } as WebSearchDetails,
				};
			} catch (error: any) {
				const errText = `WebSearch error: ${error.message}`;
				return {
					content: [{ type: "text", text: errText }],
					details: { query: params.query, count, results: [], error: error.message } as WebSearchDetails,
				};
			}
		},

		renderCall(args, theme) {
			const displayQuery = args.query.length > 60
				? args.query.slice(0, 57) + "…"
				: args.query;
			return new Text(
				theme.fg("toolTitle", theme.bold("WebSearch ")) + theme.fg("accent", `"${displayQuery}"`),
				0,
				0,
			);
		},

		renderResult(result, _state, theme) {
			const details = result.details as WebSearchDetails | undefined;
			if (details?.error) {
				// Show setup hint prominently if it's a missing API key
				if (details.error === "BRAVE_API_KEY not set") {
					return new Text(theme.fg("warning", "⚠ BRAVE_API_KEY not set — see tool output for setup instructions"), 0, 0);
				}
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			if (details) {
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("muted", `${details.results.length} result(s) for `) +
						theme.fg("accent", `"${details.query}"`),
					0,
					0,
				);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? theme.fg("muted", text.text.slice(0, 80)) : "", 0, 0);
		},
	});
}
