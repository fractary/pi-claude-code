# Task Management: TodoWrite, TodoRead, and Task*

Claude Code has two task management APIs depending on context. This package shims both, and they share a single underlying task list.

## Claude Code's two APIs

Claude Code splits task management across two tool sets depending on how it's being run:

**Non-interactive / headless mode** — uses `TodoWrite` and `TodoRead`:
- `TodoWrite` replaces the entire task list atomically with a new array of items
- `TodoRead` reads the current list and returns it as JSON

**Interactive mode** — uses `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `TaskStop`:
- `TaskCreate` adds a single task and returns its `taskId`
- `TaskUpdate` mutates one task's status or subject by `taskId`
- `TaskList` returns all tasks as a structured array
- `TaskGet` returns full details for one task by `taskId`
- `TaskStop` cancels a task

In this package, **both APIs are shimmed and share the same task list**. A `TaskCreate` call and a `TodoWrite` call both modify the same in-memory array. `TaskList` will show tasks created by either API.

## Tool reference

### TodoWrite

```javascript
TodoWrite({
  todos: [
    { id: "unique-string", content: "Task description", status: "pending", priority: "high" }
  ]
})
```

Replaces the **entire** task list with the provided array. All existing tasks are discarded. Use this when you have a complete picture of the task list upfront (typically at the start of a workflow).

`status` values: `"pending"` | `"in_progress"` | `"completed"`  
`priority` values: `"high"` | `"medium"` | `"low"`

### TodoRead

```javascript
const tasks = await TodoRead()
// Returns JSON array in the same format as TodoWrite input
```

Returns the current task list as a JSON string in Claude Code's format. If the list is empty, returns `"[]"`.

### TaskCreate

```javascript
const task = await TaskCreate({
  subject: "Check for existing plan",
  description: "Longer description of what this task involves",
  activeForm: "Checking for existing plan...",   // shown while in_progress
  metadata: { faberKey: "frame:core-fetch-issue" }  // arbitrary bag
})
const taskId = task.taskId   // e.g. "task-5"
```

Creates a new task with `status: "pending"` and returns `{ taskId }`. Store the `taskId` to update the task later.

The `metadata` field is particularly useful for **rebuilding task maps after context compaction**. If you store a unique key in metadata (e.g. `{ faberKey: "phase:step-id" }`), you can call `TaskList()` after compaction and reconstruct your `taskId` map by scanning `task.metadata.faberKey`.

### TaskUpdate

```javascript
await TaskUpdate({ taskId: "task-5", status: "in_progress" })
await TaskUpdate({ taskId: "task-5", status: "completed" })
await TaskUpdate({ taskId: "task-5", status: "completed", subject: "Updated subject" })
```

Updates a task's status and optionally its subject. `taskId` must match the value returned by `TaskCreate`.

### TaskList

```javascript
const tasks = await TaskList()
// Returns array of:
// { id: "task-5", subject: "...", description: "...", status: "pending"|"in_progress"|"completed", metadata: {} }
```

Returns all tasks. Note that items use `.id` (not `.taskId`) — the same value that `TaskCreate` returned as `.taskId`. This is intentional: you create with `taskId`, you find with `id`.

### TaskGet

```javascript
const task = await TaskGet({ taskId: "task-5" })
// Returns: { id, subject, description, status, activeForm, metadata }
```

### TaskStop

```javascript
await TaskStop({ taskId: "task-5" })
```

In Claude Code, `TaskStop` kills a running background task. In pi there are no background tasks, so this marks the task as `completed`. Use it for cleanup or cancellation flows.

## Differences from Claude Code

| Behaviour | Claude Code | This shim |
|-----------|-------------|-----------|
| `TaskCreate` return | `{ taskId: string }` | `{ taskId: string }` ✓ |
| `TaskList` item id field | `.id` | `.id` ✓ |
| Task persistence | Cloud-synced, survives session | Session-scoped, reconstructed from session history |
| Background tasks | Real async execution | No-op — `TaskStop` just marks completed |
| `TaskOutput` (deprecated) | Reads background task output | Not implemented (deprecated in CC too) |
| Shared API | `TodoWrite` and `Task*` see different lists | Shared — both APIs see the same list |

## Session persistence and compaction

This is the most important difference from Claude Code's native task management.

Pi's task state is stored in **tool result `details`** in the session history, not in a separate datastore. Every task tool call stores a full snapshot of the complete task list. When pi reloads a session, branches, or forks, it replays the session history and applies the last task snapshot — giving you the correct state for that point in history.

This means tasks **survive context compaction** — after compaction, the model can call `TaskList()` and get the full current state, even if the original `TaskCreate` calls were compacted away. The snapshot in the last task tool result is always preserved.

However, if you need to **rebuild a taskId map after compaction** (e.g. you had a `stepTaskIds` map that got compacted), the `metadata.faberKey` pattern is your friend:

```javascript
// When creating tasks, store a key in metadata:
const task = await TaskCreate({
  subject: "[frame] Fetch issue",
  metadata: { faberKey: "frame:fetch-issue" }
})
stepTaskIds["frame:fetch-issue"] = task.taskId

// After compaction, rebuild the map:
const allTasks = await TaskList()
for (const task of allTasks) {
  if (task.metadata?.faberKey) {
    stepTaskIds[task.metadata.faberKey] = task.id
  }
}
```

## Slash commands

This package registers two TUI commands for viewing the task list:

- `/todos` — opens a TUI viewer showing all tasks with status indicators
- `/tasks` — identical to `/todos`, just an alias with a more intuitive name for task-heavy workflows

In the viewer:
- `▶` — task is `in_progress` (shown in amber)
- `✓` — task is `completed` (shown in green)
- `○` — task is `pending` (shown in dim)

The `activeForm` label (if set during `TaskCreate`) is shown inline next to `in_progress` tasks when it differs from the subject.

Press `Escape` to close the viewer.
