/**
 * pi-claude-code — AskUserQuestion.ts
 *
 * Registers the `AskUserQuestion` tool that mirrors Claude Code's built-in
 * AskUserQuestion tool, allowing Claude Code agents and skills to run in pi
 * without modification.
 *
 * Renders a custom TUI option picker with a free-text "Type something" fallback.
 * In non-interactive (headless) mode, returns an error — matching Claude Code's
 * own behaviour where AskUserQuestion is unavailable in non-interactive sessions.
 *
 * Derived from: @mariozechner/pi-coding-agent examples/extensions
 * On pi update: check ExtensionAPI / pi-tui imports for breaking changes.
 * On Claude Code update: verify AskUserQuestion parameter schema at
 *   https://docs.anthropic.com/en/docs/claude-code/tools-reference
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const AskUserQuestionParams = Type.Object({
	question: Type.String({
		description: "The question to present to the user",
	}),
	options: Type.Array(Type.String(), {
		description: "Predefined options for the user to choose from. User can also type a custom response.",
	}),
});

interface AskUserQuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom: boolean;
}

interface PickResult {
	answer: string;
	wasCustom: boolean;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "AskUserQuestion",
		label: "AskUserQuestion",
		description:
			"Ask the user a question and wait for their response. Use when you need clarification or a decision before proceeding. Mirrors Claude Code's AskUserQuestion tool.",
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						question: params.question,
						options: params.options,
						answer: null,
						wasCustom: false,
					} as AskUserQuestionDetails,
				};
			}

			const allOptions = [...params.options, "__other__"];

			const result = await ctx.ui.custom<PickResult | null>((tui, theme, _kb, done) => {
				let optionIndex = 0;
				let editMode = false;
				let cachedLines: string[] | undefined;

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				editor.onSubmit = (value: string) => {
					const trimmed = value.trim();
					if (trimmed) {
						done({ answer: trimmed, wasCustom: true });
					} else {
						editMode = false;
						editor.setText("");
						invalidate();
					}
				};

				function invalidate() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function handleInput(data: string) {
					if (editMode) {
						if (matchesKey(data, Key.escape)) {
							editMode = false;
							editor.setText("");
							invalidate();
							return;
						}
						editor.handleInput(data);
						invalidate();
						return;
					}

					if (matchesKey(data, Key.up))    { optionIndex = Math.max(0, optionIndex - 1); invalidate(); return; }
					if (matchesKey(data, Key.down))  { optionIndex = Math.min(allOptions.length - 1, optionIndex + 1); invalidate(); return; }
					if (matchesKey(data, Key.escape)){ done(null); return; }

					if (matchesKey(data, Key.enter)) {
						const selected = allOptions[optionIndex];
						if (selected === "__other__") {
							editMode = true;
							invalidate();
						} else {
							done({ answer: selected, wasCustom: false });
						}
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					add(theme.fg("accent", "─".repeat(width)));
					add(theme.fg("text", ` ${params.question}`));
					lines.push("");

					for (let i = 0; i < allOptions.length; i++) {
						const opt = allOptions[i];
						const isOther = opt === "__other__";
						const label = isOther ? "Type something." : opt;
						const selected = i === optionIndex;
						const prefix = selected ? theme.fg("accent", "> ") : "  ";

						if (isOther && editMode) {
							add(prefix + theme.fg("accent", `${i + 1}. ${label} ✎`));
						} else if (selected) {
							add(prefix + theme.fg("accent", `${i + 1}. ${label}`));
						} else {
							add(`  ${theme.fg("text", `${i + 1}. ${label}`)}`);
						}
					}

					if (editMode) {
						lines.push("");
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(width - 2)) add(` ${line}`);
					}

					lines.push("");
					add(theme.fg("dim", editMode
						? " Enter to submit • Esc to go back"
						: " ↑↓ navigate • Enter to select • Esc to cancel",
					));
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return { render, handleInput, invalidate };
			});

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled" }],
					details: {
						question: params.question,
						options: params.options,
						answer: null,
						wasCustom: false,
					} as AskUserQuestionDetails,
				};
			}

			return {
				content: [{
					type: "text",
					text: result.wasCustom
						? `User wrote: ${result.answer}`
						: `User selected: ${result.answer}`,
				}],
				details: {
					question: params.question,
					options: params.options,
					answer: result.answer,
					wasCustom: result.wasCustom,
				} as AskUserQuestionDetails,
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("AskUserQuestion ")) + theme.fg("muted", args.question),
				0,
				0,
			);
		},

		renderResult(result, _state, theme) {
			const details = result.details as AskUserQuestionDetails | undefined;
			if (!details?.answer) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const prefix = details.wasCustom ? theme.fg("muted", "(wrote) ") : "";
			return new Text(theme.fg("success", "✓ ") + prefix + theme.fg("accent", details.answer), 0, 0);
		},
	});
}
