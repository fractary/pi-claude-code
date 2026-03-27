/**
 * pi-claude-code — Task.ts
 *
 * Unified task/todo management — shared state for all task tools so that
 * pi-native agents and Claude Code-style agents see the same list.
 *
 * Registers:
 *   todo          — pi-native task list tool (add / toggle / list / clear)
 *   TodoWrite     — CC non-interactive shim: replaces entire list atomically
 *   TodoRead      — CC non-interactive shim: reads list in CC JSON format
 *   TaskCreate    — CC interactive shim: creates a task, returns { taskId }
 *   TaskUpdate    — CC interactive shim: updates status / subject by taskId
 *   TaskList      — CC interactive shim: lists tasks as Array<{ id, subject, ... }>
 *   TaskGet       — CC interactive shim: retrieves full details for one task
 *   TaskStop      — CC interactive shim: stops/cancels a task
 *   /todos        — slash command: TUI task list viewer
 *   /tasks        — slash command: alias for /todos
 *
 * State contract:
 *   All tools share one in-memory todos[] array.
 *   Every tool result stores a full snapshot in details{} so session
 *   reconstruction (branch switch, fork, reload) is always correct.
 *
 * Task ID generation:
 *   Task*-created todos get ccId = "task-{n}" (n = pi integer id).
 *   TodoWrite-created todos keep whatever id string came from the input.
 *   TaskList[].id === TaskCreate return .taskId for correct round-trips.
 *
 * Derived from: @mariozechner/pi-coding-agent examples/extensions/todo.ts
 * On pi update: diff against updated example and re-apply shim additions.
 * On Claude Code update: verify TodoWrite/Task* schemas at
 *   https://docs.anthropic.com/en/docs/claude-code/tools-reference
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Shared data model ────────────────────────────────────────────────────────

interface Todo {
	id: number;
	text: string;   // subject / display label
	done: boolean;

	// Claude Code shared fields (TodoWrite + Task*)
	ccId?: string;
	priority?: "high" | "medium" | "low";
	ccStatus?: "pending" | "in_progress" | "completed";

	// Task*-specific fields
	description?: string;  // longer description (separate from subject)
	activeForm?: string;   // "in progress" label stored per task
	metadata?: Record<string, unknown>;  // arbitrary bag, e.g. { faberKey: "frame:core-fetch-issue" }
}

// ─── Details types (stored in tool results for session reconstruction) ────────

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

// Snapshot stored in TodoWrite/TodoRead tool results
interface CcDetails {
	tool: "TodoWrite" | "TodoRead";
	todos: Todo[];
	nextId: number;
}

// Snapshot stored in Task* tool results
interface TaskShimDetails {
	tool: "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet" | "TaskStop";
	todos: Todo[];
	nextId: number;
	taskId?: string;  // TaskCreate only — echoed here for renderResult
}

// ─── Parameter schemas ────────────────────────────────────────────────────────

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

// Claude Code TodoWrite schema
const CcTodoItem = Type.Object({
	id: Type.String({ description: "Unique identifier for the todo item" }),
	content: Type.String({ description: "The todo item text content" }),
	status: StringEnum(["pending", "in_progress", "completed"] as const),
	priority: StringEnum(["high", "medium", "low"] as const),
});

const TodoWriteParams = Type.Object({
	todos: Type.Array(CcTodoItem, { description: "The complete updated todo list to replace the current list" }),
});

const TodoReadParams = Type.Object({});

// Claude Code Task* schemas
const TaskCreateParams = Type.Object({
	subject: Type.String({ description: "Task title / subject line" }),
	description: Type.Optional(Type.String({ description: "Detailed description of the task" })),
	activeForm: Type.Optional(Type.String({ description: "Label shown while the task is in progress" })),
	metadata: Type.Optional(Type.Object({}, { description: "Arbitrary metadata bag (e.g. { faberKey: 'phase:step-id' })", additionalProperties: true })),
});

const TaskUpdateParams = Type.Object({
	taskId: Type.String({ description: "Task ID returned by TaskCreate" }),
	status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const, { description: "New status" })),
	subject: Type.Optional(Type.String({ description: "Updated subject/title" })),
	description: Type.Optional(Type.String({ description: "Updated description" })),
});

const TaskListParams = Type.Object({});

const TaskGetParams = Type.Object({
	taskId: Type.String({ description: "Task ID to retrieve full details for" }),
});

const TaskStopParams = Type.Object({
	taskId: Type.String({ description: "Task ID to stop/cancel" }),
});

// ─── UI component (shared by /todos and /tasks commands) ─────────────────────

class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Tasks ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks yet. Ask the agent to add some!")}`, width));
		} else {
			const done = this.todos.filter((t) => t.done).length;
			const inProgress = this.todos.filter((t) => t.ccStatus === "in_progress").length;
			const total = this.todos.length;

			let summary = `  ${th.fg("muted", `${done}/${total} completed`)}`;
			if (inProgress > 0) summary += th.fg("muted", ` · ${th.fg("warning", `${inProgress} in progress`)}`);
			lines.push(truncateToWidth(summary, width));
			lines.push("");

			for (const todo of this.todos) {
				// Three-state indicator: ▶ in_progress, ✓ completed, ○ pending
				const check =
					todo.ccStatus === "in_progress"
						? th.fg("warning", "▶")
						: todo.done
							? th.fg("success", "✓")
							: th.fg("dim", "○");

				const id = th.fg("accent", `#${todo.id}`);
				const ccIdLabel = todo.ccId ? th.fg("dim", ` [${todo.ccId}]`) : "";

				// Show priority badge for CC-originated todos
				const priorityBadge = todo.priority
					? th.fg(
						todo.priority === "high" ? "error" : todo.priority === "medium" ? "warning" : "dim",
						`[${todo.priority}] `,
					)
					: "";

				const textColour =
					todo.ccStatus === "in_progress"
						? "text"
						: todo.done
							? "dim"
							: "text";
				const text = th.fg(textColour, todo.text);

				// Show activeForm when in_progress and different from subject
				const activeSuffix =
					todo.ccStatus === "in_progress" && todo.activeForm && todo.activeForm !== todo.text
						? th.fg("dim", ` — ${todo.activeForm}`)
						: "";

				lines.push(truncateToWidth(`  ${check} ${id}${ccIdLabel} ${priorityBadge}${text}${activeSuffix}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve a todo by its string task ID (ccId) */
function findByTaskId(todos: Todo[], taskId: string): Todo | undefined {
	return todos.find((t) => t.ccId === taskId);
}

/** Map a Todo to the Task* list/get wire format */
function toTaskObject(t: Todo): {
	id: string;
	subject: string;
	description: string;
	status: string;
	activeForm?: string;
	metadata: Record<string, unknown>;
} {
	return {
		id: t.ccId ?? String(t.id),
		subject: t.text,
		description: t.description ?? t.text,
		status: t.ccStatus ?? (t.done ? "completed" : "pending"),
		...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
		metadata: t.metadata ?? {},
	};
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = 1;

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for all known task tools and applies snapshots in order.
	 * The last mutating tool result wins.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult") continue;

			if (msg.toolName === "todo") {
				const details = msg.details as TodoDetails | undefined;
				if (details) {
					todos = details.todos;
					nextId = details.nextId;
				}
			} else if (msg.toolName === "TodoWrite" || msg.toolName === "TodoRead") {
				const details = msg.details as CcDetails | undefined;
				if (details) {
					todos = details.todos;
					nextId = details.nextId;
				}
			} else if (
				msg.toolName === "TaskCreate" ||
				msg.toolName === "TaskUpdate" ||
				msg.toolName === "TaskList"  ||
				msg.toolName === "TaskGet"   ||
				msg.toolName === "TaskStop"
			) {
				const details = msg.details as TaskShimDetails | undefined;
				if (details) {
					todos = details.todos;
					nextId = details.nextId;
				}
			}
		}
	};

	// Reconstruct state on session events
	pi.on("session_start",  async (_event, ctx) => reconstructState(ctx));
	pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_fork",   async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree",   async (_event, ctx) => reconstructState(ctx));

	// ─── pi-native todo tool ──────────────────────────────────────────────────

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextId++, text: params.text, done: false };
					todos.push(newTodo);
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: { action: "toggle", todos: [...todos], nextId, error: `#${params.id} not found` } as TodoDetails,
						};
					}
					todo.done = !todo.done;
					// Keep ccStatus in sync
					if (todo.ccStatus !== undefined) {
						todo.ccStatus = todo.done ? "completed" : "pending";
					}
					return {
						content: [{ type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }],
						details: { action: "toggle", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: { action: "list", todos: [...todos], nextId, error: `unknown action: ${params.action}` } as TodoDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}

				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	// ─── Claude Code shim: TodoWrite ─────────────────────────────────────────

	pi.registerTool({
		name: "TodoWrite",
		label: "TodoWrite",
		description: "Replace the entire todo list. Mirrors Claude Code's TodoWrite tool.",
		parameters: TodoWriteParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Replace entire list, mapping Claude Code format → internal format
			todos = params.todos.map((item, index) => ({
				id: index + 1,
				text: item.content,
				done: item.status === "completed",
				ccId: item.id,
				priority: item.priority,
				ccStatus: item.status,
			}));
			nextId = todos.length + 1;

			const summary = `${todos.length} todo(s): ${todos.filter((t) => !t.done).length} pending, ${todos.filter((t) => t.done).length} completed`;
			return {
				content: [{ type: "text", text: summary }],
				details: { tool: "TodoWrite", todos: [...todos], nextId } as CcDetails,
			};
		},

		renderCall(args, theme, _context) {
			const count = args.todos?.length ?? 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("TodoWrite ")) + theme.fg("muted", `${count} item(s)`),
				0,
				0,
			);
		},

		renderResult(result, _state, theme, _context) {
			const details = result.details as CcDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const pending = details.todos.filter((t) => !t.done).length;
			const done = details.todos.filter((t) => t.done).length;
			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg("muted", `${details.todos.length} todos — `) +
					theme.fg("text", `${pending} pending`) +
					theme.fg("muted", ", ") +
					theme.fg("dim", `${done} done`),
				0,
				0,
			);
		},
	});

	// ─── Claude Code shim: TodoRead ──────────────────────────────────────────

	pi.registerTool({
		name: "TodoRead",
		label: "TodoRead",
		description: "Read the current todo list. Mirrors Claude Code's TodoRead tool.",
		parameters: TodoReadParams,

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			// Map internal format → Claude Code format
			const ccTodos = todos.map((t) => ({
				id: t.ccId ?? String(t.id),
				content: t.text,
				status: t.ccStatus ?? (t.done ? "completed" : "pending"),
				priority: t.priority ?? "medium",
			}));

			return {
				content: [
					{
						type: "text",
						text: ccTodos.length ? JSON.stringify(ccTodos, null, 2) : "[]",
					},
				],
				// Store snapshot so reconstruction knows the state at this point
				details: { tool: "TodoRead", todos: [...todos], nextId } as CcDetails,
			};
		},

		renderCall(_args, theme, _context) {
			return new Text(theme.fg("toolTitle", theme.bold("TodoRead")), 0, 0);
		},

		renderResult(result, _state, theme, _context) {
			const details = result.details as CcDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.todos.length === 0) {
				return new Text(theme.fg("dim", "No todos"), 0, 0);
			}
			const pending = details.todos.filter((t) => !t.done).length;
			const done = details.todos.filter((t) => t.done).length;
			return new Text(
				theme.fg("muted", `${details.todos.length} todos — `) +
					theme.fg("text", `${pending} pending`) +
					theme.fg("muted", ", ") +
					theme.fg("dim", `${done} done`),
				0,
				0,
			);
		},
	});

	// ─── Claude Code shim: TaskCreate ────────────────────────────────────────

	pi.registerTool({
		name: "TaskCreate",
		label: "TaskCreate",
		description:
			"Creates a new task in the task list. Mirrors Claude Code's TaskCreate tool. " +
			"Returns { taskId } which callers store for subsequent TaskUpdate calls.",
		parameters: TaskCreateParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const newTodo: Todo = {
				id: nextId++,
				text: params.subject,
				done: false,
				ccStatus: "pending",
				description: params.description,
				activeForm: params.activeForm,
				metadata: params.metadata as Record<string, unknown> | undefined,
			};
			// Auto-generate stable string ID: "task-{n}"
			newTodo.ccId = `task-${newTodo.id}`;
			todos.push(newTodo);

			const taskId = newTodo.ccId;
			return {
				content: [{ type: "text", text: JSON.stringify({ taskId }) }],
				details: { tool: "TaskCreate", todos: [...todos], nextId, taskId } as TaskShimDetails,
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("TaskCreate ")) +
					theme.fg("dim", "⊕ ") +
					theme.fg("muted", `"${args.subject}"`),
				0,
				0,
			);
		},

		renderResult(result, _state, theme, _context) {
			const details = result.details as TaskShimDetails | undefined;
			if (!details?.taskId) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			// Find the task we just created to show its subject
			const task = findByTaskId(details.todos, details.taskId);
			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg("accent", `[${details.taskId}]`) +
					" " +
					theme.fg("muted", task ? `"${task.text}"` : details.taskId),
				0,
				0,
			);
		},
	});

	// ─── Claude Code shim: TaskUpdate ────────────────────────────────────────

	pi.registerTool({
		name: "TaskUpdate",
		label: "TaskUpdate",
		description:
			"Updates task status, subject, or description. Mirrors Claude Code's TaskUpdate tool. " +
			"Status values: pending | in_progress | completed.",
		parameters: TaskUpdateParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const todo = findByTaskId(todos, params.taskId);
			if (!todo) {
				return {
					content: [{ type: "text", text: `Task not found: ${params.taskId}` }],
					details: { tool: "TaskUpdate", todos: [...todos], nextId } as TaskShimDetails,
				};
			}

			if (params.status !== undefined) {
				todo.ccStatus = params.status;
				todo.done = params.status === "completed";
			}
			if (params.subject !== undefined) {
				todo.text = params.subject;
			}
			if (params.description !== undefined) {
				todo.description = params.description;
			}

			const statusLabel = params.status ?? "unchanged";
			return {
				content: [{ type: "text", text: `Updated ${params.taskId}: status → ${statusLabel}` }],
				details: { tool: "TaskUpdate", todos: [...todos], nextId } as TaskShimDetails,
			};
		},

		renderCall(args, theme, _context) {
			const statusColour =
				args.status === "completed"   ? "success" :
				args.status === "in_progress" ? "warning" :
				args.status === "pending"     ? "dim"     : "muted";
			const statusLabel =
				args.status === "in_progress" ? "▶ in_progress" :
				args.status === "completed"   ? "✓ completed"   :
				args.status === "pending"     ? "○ pending"     :
				"update";
			return new Text(
				theme.fg("toolTitle", theme.bold("TaskUpdate ")) +
					theme.fg(statusColour, statusLabel) +
					theme.fg("dim", ` → ${args.taskId}`),
				0,
				0,
			);
		},

		renderResult(result, _state, theme, _context) {
			const details = result.details as TaskShimDetails | undefined;
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";

			// Show error case
			if (msg.startsWith("Task not found")) {
				return new Text(theme.fg("error", `✗ ${msg}`), 0, 0);
			}

			// Find the updated task for richer display
			if (details) {
				const taskIdMatch = msg.match(/Updated (task-\d+)/);
				const taskId = taskIdMatch?.[1];
				const task = taskId ? findByTaskId(details.todos, taskId) : undefined;
				if (task) {
					const check =
						task.ccStatus === "in_progress" ? theme.fg("warning", "▶") :
						task.ccStatus === "completed"   ? theme.fg("success", "✓") :
						theme.fg("dim", "○");
					return new Text(
						check +
							" " +
							theme.fg("accent", `[${taskId}]`) +
							" " +
							theme.fg("muted", `"${task.text}"`),
						0,
						0,
					);
				}
			}

			return new Text(theme.fg("muted", msg), 0, 0);
		},
	});

	// ─── Claude Code shim: TaskList ──────────────────────────────────────────

	pi.registerTool({
		name: "TaskList",
		label: "TaskList",
		description:
			"Lists all tasks with their current status. Mirrors Claude Code's TaskList tool. " +
			"Returns Array<{ id, subject, description, status, metadata }>. " +
			"Note: items use .id (same value as the taskId from TaskCreate).",
		parameters: TaskListParams,

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const taskList = todos.map(toTaskObject);
			return {
				content: [{ type: "text", text: JSON.stringify(taskList, null, 2) }],
				details: { tool: "TaskList", todos: [...todos], nextId } as TaskShimDetails,
			};
		},

		renderCall(_args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("TaskList")) +
					theme.fg("dim", " ≡"),
				0,
				0,
			);
		},

		renderResult(result, _state, theme, _context) {
			const details = result.details as TaskShimDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const total      = details.todos.length;
			const pending    = details.todos.filter((t) => t.ccStatus === "pending"     || (!t.ccStatus && !t.done)).length;
			const inProgress = details.todos.filter((t) => t.ccStatus === "in_progress").length;
			const completed  = details.todos.filter((t) => t.ccStatus === "completed"   || t.done).length;

			if (total === 0) {
				return new Text(theme.fg("dim", "No tasks"), 0, 0);
			}
			return new Text(
				theme.fg("muted", `${total} task(s) — `) +
					theme.fg("dim",     `${pending} pending`) +
					theme.fg("muted",   ", ") +
					theme.fg("warning", `${inProgress} in progress`) +
					theme.fg("muted",   ", ") +
					theme.fg("success", `${completed} completed`),
				0,
				0,
			);
		},
	});

	// ─── Claude Code shim: TaskGet ───────────────────────────────────────────

	pi.registerTool({
		name: "TaskGet",
		label: "TaskGet",
		description:
			"Retrieves full details for a specific task by taskId. Mirrors Claude Code's TaskGet tool.",
		parameters: TaskGetParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const todo = findByTaskId(todos, params.taskId);
			if (!todo) {
				return {
					content: [{ type: "text", text: JSON.stringify({ error: `Task not found: ${params.taskId}` }) }],
					details: { tool: "TaskGet", todos: [...todos], nextId } as TaskShimDetails,
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(toTaskObject(todo), null, 2) }],
				details: { tool: "TaskGet", todos: [...todos], nextId } as TaskShimDetails,
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("TaskGet ")) +
					theme.fg("accent", args.taskId),
				0,
				0,
			);
		},

		renderResult(result, _state, theme, _context) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			try {
				const task = JSON.parse(msg);
				if (task.error) {
					return new Text(theme.fg("error", `✗ ${task.error}`), 0, 0);
				}
				const statusIcon =
					task.status === "in_progress" ? theme.fg("warning", "▶") :
					task.status === "completed"   ? theme.fg("success", "✓") :
					theme.fg("dim", "○");
				return new Text(
					statusIcon +
						" " +
						theme.fg("accent", `[${task.id}]`) +
						" " +
						theme.fg("muted", `"${task.subject}"`) +
						theme.fg("dim", ` (${task.status})`),
					0,
					0,
				);
			} catch {
				return new Text(theme.fg("muted", msg), 0, 0);
			}
		},
	});

	// ─── Claude Code shim: TaskStop ──────────────────────────────────────────

	pi.registerTool({
		name: "TaskStop",
		label: "TaskStop",
		description:
			"Stops/cancels a running task by ID. Mirrors Claude Code's TaskStop tool. " +
			"In pi, this marks the task as completed (no background process to kill).",
		parameters: TaskStopParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const todo = findByTaskId(todos, params.taskId);
			if (!todo) {
				return {
					content: [{ type: "text", text: `Task not found: ${params.taskId}` }],
					details: { tool: "TaskStop", todos: [...todos], nextId } as TaskShimDetails,
				};
			}
			todo.done = true;
			todo.ccStatus = "completed";
			return {
				content: [{ type: "text", text: `Stopped task ${params.taskId}` }],
				details: { tool: "TaskStop", todos: [...todos], nextId } as TaskShimDetails,
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("TaskStop ")) +
					theme.fg("accent", args.taskId),
				0,
				0,
			);
		},

		renderResult(result, _state, theme, _context) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			if (msg.startsWith("Task not found")) {
				return new Text(theme.fg("error", `✗ ${msg}`), 0, 0);
			}
			return new Text(theme.fg("muted", `■ ${msg}`), 0, 0);
		},
	});

	// ─── /todos and /tasks commands ───────────────────────────────────────────

	const showTasksUI = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("This command requires interactive mode", "error");
			return;
		}
		await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
			return new TodoListComponent(todos, theme, () => done());
		});
	};

	pi.registerCommand("todos", {
		description: "Show all todos/tasks on the current branch",
		handler: async (_args, ctx) => showTasksUI(ctx),
	});

	pi.registerCommand("tasks", {
		description: "Show all tasks on the current branch (alias for /todos)",
		handler: async (_args, ctx) => showTasksUI(ctx),
	});
}
