/**
 * pi-claude-code — PlanMode.ts
 *
 * Registers EnterPlanMode and ExitPlanMode tools that mirror Claude Code's
 * plan mode tools, AND provides a full pi-native plan mode implementation
 * based on the official pi plan-mode example extension.
 *
 * Plan mode overview:
 *   - Read-only exploration mode for safe codebase analysis
 *   - Model can only use read-only tools (no edit/write)
 *   - Model calls EnterPlanMode() to begin, ExitPlanMode(plan) to propose
 *   - User approves/rejects/refines the plan via TUI prompt
 *   - On approval: full tool access is restored
 *
 * Also available via:
 *   /plan command     — user-initiated toggle
 *   Ctrl+Alt+P        — keyboard shortcut
 *
 * Plan step tracking:
 *   The model outputs numbered steps under a "Plan:" header.
 *   Progress is tracked via [DONE:n] markers during execution.
 *   A widget shows live step progress in the TUI footer.
 *
 * Tool sets:
 *   Plan mode:   read, bash(read-only), grep, find, ls, Grep, Glob, LS,
 *                AskUserQuestion, WebFetch, WebSearch
 *   Normal mode: read, bash, edit, write (pi defaults)
 *
 * Derived from: @mariozechner/pi-coding-agent examples/extensions/plan-mode/
 * On pi update: diff against updated example and re-apply changes.
 * On Claude Code update: verify EnterPlanMode/ExitPlanMode schemas at
 *   https://docs.anthropic.com/en/docs/claude-code/tools-reference
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Plan mode tool sets ──────────────────────────────────────────────────────

// Read-only tools available in plan mode (pi built-ins + pi-claude-code shims)
// NOTE: Do NOT include both a lowercase pi built-in and its CC-cased shim equivalent.
// Under Anthropic OAuth, pi's anthropic.js provider normalizes lowercase built-in
// names to CC canonical casing (e.g. grep → Grep), causing duplicates at the API
// level when the CC-shim extension is also present. Use CC-shims where available.
const PLAN_MODE_TOOLS = [
	"read", "bash", "find",      // pi built-ins (no CC-shim equivalent)
	"Grep", "Glob", "LS",        // CC-shims (cover grep, ls; avoid lowercase duplicates)
	"AskUserQuestion", "WebFetch", "WebSearch",
];

// Full tool set restored after plan approval.
// All pi built-ins + all CC-shims + pi-subagents tools.
// IMPORTANT: Do NOT include both a lowercase built-in and its CC-shim equivalent —
// under Anthropic OAuth, toClaudeCodeName() renames lowercase built-ins to CC casing
// (e.g. grep → Grep), producing duplicates at the API level.
// Rule: where a CC-shim exists (Grep, LS), omit the lowercase built-in (grep, ls).
const NORMAL_MODE_TOOLS = [
	// pi built-ins (only those without a CC-shim equivalent)
	"read", "bash", "edit", "write", "find",
	// CC-shims from @fractary/pi-claude-code (cover grep/ls without lowercase clash)
	"Grep", "Glob", "LS",
	"AskUserQuestion",
	"WebFetch", "WebSearch",
	"Skill",
	"Agent",
	"todo", "TodoWrite", "TodoRead",
	"TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop",
	"EnterPlanMode", "ExitPlanMode",
	// pi-subagents built-in tools
	"subagent", "subagent_status",
];

// ─── Utils (inlined from plan-mode example utils.ts) ─────────────────────────

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
	/\bchmod\b/i, /\bchown\b/i, /\bchgrp\b/i, /\bln\b/i, /\btee\b/i,
	/\btruncate\b/i, /\bdd\b/i, /\bshred\b/i,
	/(^|[^<])>(?!>)/, />>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
	/\breboot\b/i, /\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
	/^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/,
	/^\s*printf\b/, /^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/,
	/^\s*file\b/, /^\s*stat\b/, /^\s*du\b/, /^\s*df\b/, /^\s*tree\b/,
	/^\s*which\b/, /^\s*whereis\b/, /^\s*type\b/, /^\s*env\b/, /^\s*printenv\b/,
	/^\s*uname\b/, /^\s*whoami\b/, /^\s*id\b/, /^\s*date\b/, /^\s*cal\b/,
	/^\s*uptime\b/, /^\s*ps\b/, /^\s*top\b/, /^\s*htop\b/, /^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i, /^\s*python\s+--version/i,
	/^\s*curl\s/i, /^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/, /^\s*sed\s+-n/i, /^\s*awk\b/, /^\s*rg\b/, /^\s*fd\b/,
	/^\s*bat\b/, /^\s*exa\b/,
];

function isSafeCommand(command: string): boolean {
	return !DESTRUCTIVE_PATTERNS.some((p) => p.test(command)) &&
		SAFE_PATTERNS.some((p) => p.test(command));
}

interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	if (cleaned.length > 50) cleaned = `${cleaned.slice(0, 47)}...`;
	return cleaned;
}

function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2].trim().replace(/\*{1,2}$/, "").trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	}
	return items;
}

function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}

// ─── Type guards ──────────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// ─── Tool parameter schemas ───────────────────────────────────────────────────

const EnterPlanModeParams = Type.Object({});

const ExitPlanModeParams = Type.Object({
	plan: Type.Optional(Type.String({
		description: "The plan to present to the user for approval. If omitted, the plan is extracted from the conversation.",
	})),
});

// ─── Extension ───────────────────────────────────────────────────────────────

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];

	// ── State helpers ─────────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) =>
				item.completed
					? ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					: `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`,
			);
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function activatePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = true;
		executionMode = false;
		todoItems = [];
		pi.setActiveTools(PLAN_MODE_TOOLS);
		updateStatus(ctx);
	}

	function deactivatePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = false;
		executionMode = false;
		todoItems = [];
		pi.setActiveTools(NORMAL_MODE_TOOLS);
		updateStatus(ctx);
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			deactivatePlanMode(ctx);
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		} else {
			activatePlanMode(ctx);
			ctx.ui.notify(`Plan mode enabled. Tools restricted to read-only.`);
		}
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
		});
	}

	// ── EnterPlanMode tool ────────────────────────────────────────────────────

	pi.registerTool({
		name: "EnterPlanMode",
		label: "EnterPlanMode",
		description:
			"Switch to plan mode for safe read-only codebase analysis. Mirrors Claude Code's EnterPlanMode tool. " +
			"Restricts available tools to read-only operations. Call ExitPlanMode when done planning.",
		parameters: EnterPlanModeParams,

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (planModeEnabled) {
				return {
					content: [{ type: "text", text: "Already in plan mode. Analyze the codebase and call ExitPlanMode with your plan when ready." }],
				};
			}

			activatePlanMode(ctx);

			return {
				content: [{
					type: "text",
					text:
						"Plan mode activated.\n\n" +
						"Available tools (read-only): read, bash (safe commands only), grep, find, ls, Grep, Glob, LS, WebFetch, WebSearch, Skill.\n\n" +
						"Analyze the codebase thoroughly. When you have a complete plan, call ExitPlanMode with your proposed plan for user approval.",
				}],
			};
		},

		renderCall(_args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("EnterPlanMode")) +
					theme.fg("warning", " ⏸"),
				0,
				0,
			);
		},

		renderResult(result, _state, theme) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			if (msg.startsWith("Already")) {
				return new Text(theme.fg("dim", "Already in plan mode"), 0, 0);
			}
			return new Text(theme.fg("warning", "⏸ Plan mode active — read-only tools only"), 0, 0);
		},
	});

	// ── ExitPlanMode tool ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "ExitPlanMode",
		label: "ExitPlanMode",
		description:
			"Present a plan for user approval and exit plan mode. Mirrors Claude Code's ExitPlanMode tool. " +
			"Requires user approval — the user can approve, reject, or request refinement.",
		parameters: ExitPlanModeParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planModeEnabled) {
				return {
					content: [{ type: "text", text: "Not currently in plan mode. Call EnterPlanMode first." }],
				};
			}

			if (!ctx.hasUI) {
				// Non-interactive: auto-approve
				deactivatePlanMode(ctx);
				return {
					content: [{ type: "text", text: "Plan mode exited (non-interactive — auto-approved). Full tool access restored." }],
				};
			}

			const planText = params.plan?.trim() ?? "(No plan text provided — see conversation above)";

			// Show plan and ask for user decision
			const choice = await ctx.ui.select(
				`Plan ready for review — approve to proceed?`,
				[
					"✓ Approve — execute the plan",
					"✗ Reject — stay in plan mode",
					"✎ Refine — request changes",
				],
			);

			if (!choice || choice.startsWith("✗")) {
				return {
					content: [{ type: "text", text: "Plan not approved. Remain in plan mode and revise the plan, then call ExitPlanMode again." }],
				};
			}

			if (choice.startsWith("✎")) {
				const refinement = await ctx.ui.editor("What changes would you like to the plan?", "");
				if (refinement?.trim()) {
					// Send refinement as user message but stay in plan mode
					pi.sendUserMessage(refinement.trim());
					return {
						content: [{ type: "text", text: `Plan refinement requested: "${refinement.trim()}". Please update the plan accordingly and call ExitPlanMode again.` }],
					};
				}
				return {
					content: [{ type: "text", text: "No refinement provided. Please update the plan and call ExitPlanMode again." }],
				};
			}

			// Approved — extract todo items from plan text, restore full tools
			if (planText && planText !== "(No plan text provided — see conversation above)") {
				const extracted = extractTodoItems(`Plan:\n${planText}`);
				if (extracted.length > 0) todoItems = extracted;
			}

			const hadSteps = todoItems.length > 0;
			deactivatePlanMode(ctx);

			if (hadSteps) {
				executionMode = true;
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				updateStatus(ctx);
			}

			persistState();

			return {
				content: [{
					type: "text",
					text:
						"Plan approved. Exiting plan mode — full tool access restored.\n\n" +
						(hadSteps
							? `Executing ${todoItems.length} step(s). Mark each completed step with [DONE:n] in your response.`
							: "Proceed with implementation."),
				}],
			};
		},

		renderCall(args, theme) {
			const preview = args.plan
				? theme.fg("dim", ` — "${args.plan.slice(0, 50)}${args.plan.length > 50 ? "…" : ""}"`)
				: "";
			return new Text(
				theme.fg("toolTitle", theme.bold("ExitPlanMode")) +
					theme.fg("success", " ▶") +
					preview,
				0,
				0,
			);
		},

		renderResult(result, _state, theme) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			if (msg.startsWith("Plan approved")) {
				return new Text(theme.fg("success", "✓ Plan approved — full access restored"), 0, 0);
			}
			if (msg.startsWith("Plan not approved") || msg.startsWith("Plan refinement")) {
				return new Text(theme.fg("warning", "⏸ " + msg.split(".")[0]), 0, 0);
			}
			if (msg.startsWith("Not currently")) {
				return new Text(theme.fg("error", "✗ Not in plan mode"), 0, 0);
			}
			return new Text(theme.fg("muted", msg.slice(0, 80)), 0, 0);
		},
	});

	// ── /plan command and keyboard shortcut ───────────────────────────────────

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// ── Block destructive bash in plan mode ───────────────────────────────────

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;
		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not read-only). Use /plan to exit plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// ── Filter stale plan-mode context when not active ────────────────────────

	pi.on("context", async (event) => {
		if (planModeEnabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;
				const content = msg.content;
				if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
				if (Array.isArray(content)) {
					return !content.some((c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"));
				}
				return true;
			}),
		};
	});

	// ── Inject plan/execution context before agent starts ─────────────────────

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content:
						"[PLAN MODE ACTIVE]\n" +
						"You are in read-only plan mode. You may use read, bash (safe commands only), grep, find, ls, Grep, Glob, LS, WebFetch, WebSearch, and Skill.\n" +
						"You CANNOT use edit or write.\n\n" +
						"Analyze the codebase thoroughly, then present a detailed numbered plan under a 'Plan:' header:\n\n" +
						"Plan:\n1. First step\n2. Second step\n...\n\n" +
						"When ready, call ExitPlanMode with your plan for user approval.",
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content:
						"[EXECUTING PLAN — full tool access enabled]\n\n" +
						`Remaining steps:\n${todoList}\n\n` +
						"Execute each step in order. After completing a step, include [DONE:n] in your response.",
					display: false,
				},
			};
		}
	});

	// ── Track [DONE:n] progress markers ──────────────────────────────────────

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;
		if (markCompletedSteps(getTextContent(event.message), todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// ── Handle plan completion ────────────────────────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0 && todoItems.every((t) => t.completed)) {
			const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
			pi.sendMessage(
				{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
				{ triggerTurn: false },
			);
			executionMode = false;
			todoItems = [];
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			updateStatus(ctx);
			persistState();
		}
	});

	// ── Restore state on session start/resume ─────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) planModeEnabled = true;

		const entries = ctx.sessionManager.getEntries();
		const planEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean } } | undefined;

		if (planEntry?.data) {
			planModeEnabled = planEntry.data.enabled ?? planModeEnabled;
			todoItems      = planEntry.data.todos    ?? todoItems;
			executionMode  = planEntry.data.executing ?? executionMode;
		}

		// Rebuild completion state after resume
		if (planEntry && executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if ((entries[i] as { customType?: string }).customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			markCompletedSteps(messages.map(getTextContent).join("\n"), todoItems);
		}

		if (planModeEnabled) pi.setActiveTools(PLAN_MODE_TOOLS);
		updateStatus(ctx);
	});
}
