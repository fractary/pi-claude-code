# Plan Mode: EnterPlanMode and ExitPlanMode

Claude Code has a built-in plan mode where the model analyzes a codebase in a read-only context, proposes a numbered plan, and waits for user approval before making any changes. Pi doesn't ship plan mode by default — but it ships an official example extension that implements it, and this package builds on that to shim Claude Code's `EnterPlanMode` and `ExitPlanMode` tools.

## How plan mode works

When in plan mode:

- The model can only use **read-only tools**: `read`, `bash` (safe commands only), `grep`, `find`, `ls`, `Grep`, `Glob`, `LS`, `WebFetch`, `WebSearch`, `Skill`
- `edit`, `write`, and destructive bash commands are blocked
- The model is prompted to output a numbered plan under a `Plan:` header
- When the model calls `ExitPlanMode`, the user sees an approval dialog
- If approved, full tools are restored and the plan steps are tracked during execution

## Entering plan mode

### From the model (Claude Code API)

```javascript
await EnterPlanMode()
// Model receives: "Plan mode activated. Available tools: read, bash (safe only), ..."
// Model analyzes codebase, produces plan...
await ExitPlanMode({ plan: "1. Fetch the issue\n2. Create a branch\n3. ..." })
// User sees approval dialog
```

### From the user (pi-native)

- Type `/plan` in the pi editor to toggle plan mode on/off
- Press `Ctrl+Alt+P` as a keyboard shortcut

When enabled, a `⏸ plan` status indicator appears in the pi footer.

### From the CLI

Start pi in plan mode immediately:

```bash
pi --plan
```

## The approval workflow

When the model calls `ExitPlanMode`, a TUI dialog appears:

```
Plan ready for review — approve to proceed?
  > ✓ Approve — execute the plan
    ✗ Reject — stay in plan mode
    ✎ Refine — request changes
```

**Approve**: Full tools are restored. If the plan contained numbered steps under a `Plan:` header, execution mode activates — a widget shows step progress and the model uses `[DONE:n]` markers to tick off completed steps.

**Reject**: The model stays in plan mode. The model is told to revise the plan and call `ExitPlanMode` again.

**Refine**: An editor opens for you to write what you want changed. Your refinement is injected as a user message while the model stays in plan mode.

## Plan step tracking

During execution (after approval), the model marks completed steps with `[DONE:n]` tags:

```
I've fetched the issue. [DONE:1]

Now creating the branch... [DONE:2]
```

A widget in the TUI footer tracks progress: `📋 2/5`. When all steps are complete, a "Plan Complete! ✓" message is shown and execution mode exits.

## Differences from Claude Code

| Behaviour | Claude Code | This package |
|-----------|-------------|--------------|
| `EnterPlanMode` parameters | None | None |
| `ExitPlanMode` parameters | Plan text (implicit) | Optional `plan` string |
| User approval UI | Native Claude UI | Pi TUI select dialog |
| Rejection | User clicks reject | `/plan` toggle or Reject option |
| Refinement | Native refinement flow | Editor opens, input sent as user message |
| Step tracking | Native CC progress | `[DONE:n]` markers + TUI widget |
| Headless mode | Works silently | Auto-approves in non-interactive mode |
| Session persistence | Cloud-synced | Stored in session entries, survives reload |
| User toggle | Not available | `/plan` command + `Ctrl+Alt+P` |

### The key difference: who controls plan mode

In Claude Code, plan mode is **model-driven** — the model decides when to enter and exit it. In pi, plan mode can also be **user-driven** via the `/plan` command. This is actually more flexible: you can put pi in plan mode before asking a question and the model will analyze without making changes, even if the model wasn't planning to enter plan mode on its own.

The `EnterPlanMode` and `ExitPlanMode` tool shims bridge the model-driven flow so agents written for Claude Code behave identically in pi.

## Tool set in plan mode

The following tools are available when plan mode is active:

| Tool | Source |
|------|--------|
| `read` | Pi built-in |
| `bash` | Pi built-in (safe commands only — see below) |
| `grep` | Pi built-in |
| `find` | Pi built-in |
| `ls` | Pi built-in |
| `Grep` | pi-claude-code shim |
| `Glob` | pi-claude-code shim |
| `LS` | pi-claude-code shim |
| `AskUserQuestion` | pi-claude-code shim |
| `WebFetch` | pi-claude-code shim |
| `WebSearch` | pi-claude-code shim |
| `Skill` | pi-claude-code shim |

`edit` and `write` are not available.

### Safe bash commands in plan mode

Bash is restricted to a safe allowlist. Commands like `cat`, `head`, `tail`, `grep`, `find`, `ls`, `git status`, `git log`, `git diff`, `curl`, `jq`, and common inspection tools are permitted. Destructive commands (`rm`, `mv`, `cp`, `mkdir`, `git commit`, `git push`, `sudo`, etc.) are blocked and return an error message.

## Tips

**Write plans with explicit numbered steps** for best tracking:

```
Plan:
1. Fetch the issue details
2. Analyze the existing codebase structure
3. Create a feature branch
4. Implement the changes
5. Run tests and verify
```

The step extractor looks for a `Plan:` header followed by numbered items. Steps are cleaned up (markdown removed, truncated to 50 chars for display).

**Use `/plan` for exploratory analysis** even when not using Claude Code-style agents. Put pi in plan mode, ask a question about your codebase, and you'll get a thorough analysis with a proposed plan — no accidental file changes possible.

**The `--plan` CLI flag** is useful for scripted or CI contexts where you want to enforce read-only exploration before any execution.
