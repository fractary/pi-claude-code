# pi-claude-code

Pi extensions that shim Claude Code's tool API, letting agents, skills, and prompts built for Claude Code run in [pi](https://shittycodingagent.ai) without modification.

## What it does

Claude Code and pi expose different tool sets to the model. If you have agents or workflows written for Claude Code, this package registers the Claude Code tools as pi extensions so they work as-is — no changes to your prompts or agent files required.

### Tools provided

| Tool | Extension | Type | Description |
|------|-----------|------|-------------|
| `Grep` | `filesystem.ts` | CC shim | Pattern search → ripgrep / grep fallback |
| `Glob` | `filesystem.ts` | CC shim | File pattern matching → rg --files / find fallback |
| `LS` | `filesystem.ts` | CC shim | Directory listing → ls -la |
| `AskUserQuestion` | `interaction.ts` | CC shim | Choice picker with free-text fallback |
| `question` | `interaction.ts` | pi-native | Single question with label+description options |
| `questionnaire` | `interaction.ts` | pi-native | Multi-question sequential picker |
| `todo` | `tasks.ts` | pi-native | Native pi task list (add/toggle/list/clear) |
| `TodoWrite` | `tasks.ts` | CC shim | Replace entire task list atomically |
| `TodoRead` | `tasks.ts` | CC shim | Read task list in CC JSON format |
| `TaskCreate` | `tasks.ts` | CC shim | Create task, returns `{ taskId }` |
| `TaskUpdate` | `tasks.ts` | CC shim | Update task status/subject by taskId |
| `TaskList` | `tasks.ts` | CC shim | List all tasks as `Array<{ id, subject, status, metadata }>` |
| `TaskGet` | `tasks.ts` | CC shim | Get full details for one task |
| `TaskStop` | `tasks.ts` | CC shim | Stop/cancel a task |
| `Agent` | `agent.ts` | CC shim | Delegate to a pi agent by name (requires pi-subagents) |

**Slash commands:** `/todos`, `/tasks` — TUI task list viewer

All task tools (`todo`, `TodoWrite`, `TodoRead`, `Task*`) share the same in-memory state and session persistence, so they all see the same list regardless of which tool created the tasks.

## Install

```bash
# Install globally (available in all projects)
pi install git:github.com/fractary/pi-claude-code

# Install for current project only
pi install -l git:github.com/fractary/pi-claude-code
```

Once published to npm:

```bash
pi install npm:pi-claude-code
```

### Agent() shim — additional dependency

The `Agent` tool requires [pi-subagents](https://github.com/nicobailon/pi-subagents):

```bash
pi install npm:pi-subagents
```

If `pi-subagents` is not installed, `agent.ts` still loads cleanly — it just returns a helpful error message when `Agent()` is called.

## Selective loading

Use pi's [package filtering](https://docs.anthropic.com/en/docs/pi/packages#package-filtering) in `settings.json` to load only what you need:

**Exclude the Agent() shim** (if you don't use pi-subagents):
```json
{
  "packages": [{
    "source": "git:github.com/fractary/pi-claude-code",
    "extensions": ["!extensions/agent.ts"]
  }]
}
```

**Task management only** (FABER-style workflow commands):
```json
{
  "packages": [{
    "source": "git:github.com/fractary/pi-claude-code",
    "extensions": ["extensions/tasks.ts"]
  }]
}
```

**Filesystem + interaction tools only** (no task state):
```json
{
  "packages": [{
    "source": "git:github.com/fractary/pi-claude-code",
    "extensions": [
      "extensions/filesystem.ts",
      "extensions/interaction.ts"
    ]
  }]
}
```

## Compatibility notes

### TodoWrite vs TaskCreate

Claude Code uses `TodoWrite`/`TodoRead` in non-interactive (headless) mode and `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` in interactive mode. Both sets are shimmed here and share the same underlying task list — you can mix and match freely.

### Agent() name resolution

The `description` parameter is normalised to kebab-case and matched against pi's discovered agents:

1. Exact name match
2. Substring match (e.g. `"forge-skill"` matches `"fractary-forge-skill-creator"`)
3. Error with list of available agents

### Filesystem tools (Grep / Glob / LS)

pi already has built-in `Read`, `Bash`, `Edit`, and `Write` tools. `Grep`, `Glob`, and `LS` are additional tools that Claude Code exposes as first-class tools (not via Bash). These shims let agents that call `Grep(...)` directly work without rewriting them to use `Bash({ command: "rg ..." })`.

## Versioning

This package follows [semver](https://semver.org/). New Claude Code tools are added as minor bumps. Old tools are never removed — agents in the wild still reference them.

**Staying in sync:**
- Claude Code tool schemas: [tools-reference](https://docs.anthropic.com/en/docs/claude-code/tools-reference)
- pi API changes: each extension file has a `Derived from:` comment with the pi version it was verified against

## Contributing

PRs welcome. When adding a new Claude Code tool shim:

1. Add it to the appropriate extension file (or create a new one if it's a new logical group)
2. Match the exact parameter schema from the Claude Code tools reference
3. Store a full state snapshot in `details{}` for any stateful tools (see `tasks.ts` for the pattern)
4. Add to the tool table in this README
5. Bump the minor version in `package.json` and add a CHANGELOG entry

## License

MIT
