# pi-claude-code

Pi extensions that shim Claude Code's tool API, letting agents, skills, and commands built for Claude Code run inside [pi](https://shittycodingagent.ai) without modification.

## Background

I had invested a lot of time building agents, skills, and workflow commands inside Claude Code. When I discovered [pi](https://shittycodingagent.ai) and its advantages as an agent harness — better session management, branching, extensibility, multi-provider support — I wanted to switch. But I didn't want to throw away everything I had built.

The good news: the two systems are structurally very similar. Both have the concept of agents, skills, and commands. Skills are essentially a 1:1 mapping. The main friction point was the **tool API** — Claude Code exposes a specific set of named tools (`Grep`, `Glob`, `TaskCreate`, `WebFetch`, etc.) and my agents called those by name. Pi has equivalent capabilities but uses different tool names or different conventions.

Rather than rewriting all my agents to call pi's tools, I shimmed Claude Code's tool names as pi extensions. With those shims in place, every agent, skill, and command I had built continued to work unchanged — they still called `Grep(...)` and `TaskCreate(...)` and `WebFetch(...)`, and pi now knew what to do with those calls.

**The goal was not to replicate Claude Code inside pi.** It was to make the tools that Claude Code agents expect to exist actually exist in pi, so the agents could run without modification. A thin compatibility layer, not a full reimplementation.

This package is the result of that work, extracted and generalized so others can do the same thing.

## What's included

| Tool | Extension | Description |
|------|-----------|-------------|
| `Grep` | `Grep.ts` | Pattern search in files → ripgrep / grep fallback |
| `Glob` | `Glob.ts` | Find files by glob pattern → rg --files / find fallback |
| `LS` | `LS.ts` | List directory contents → ls -la |
| `AskUserQuestion` | `AskUserQuestion.ts` | Interactive choice picker with free-text fallback |
| `todo` | `Task.ts` | pi-native task list (add / toggle / list / clear) |
| `TodoWrite` | `Task.ts` | Replace entire task list (CC non-interactive mode) |
| `TodoRead` | `Task.ts` | Read task list in CC JSON format |
| `TaskCreate` | `Task.ts` | Create a task, returns `{ taskId }` |
| `TaskUpdate` | `Task.ts` | Update task status / subject by taskId |
| `TaskList` | `Task.ts` | List all tasks as `Array<{ id, subject, status, metadata }>` |
| `TaskGet` | `Task.ts` | Get full details for one task |
| `TaskStop` | `Task.ts` | Stop/cancel a task |
| `WebFetch` | `WebFetch.ts` | Fetch URL as clean markdown (Jina Reader, no API key needed) |
| `WebSearch` | `WebSearch.ts` | Web search via Brave Search API (requires `BRAVE_API_KEY`) |
| `Skill` | `Skill.ts` | Execute a pi skill by name — loads SKILL.md, returns content |
| `EnterPlanMode` | `PlanMode.ts` | Enter read-only analysis mode |
| `ExitPlanMode` | `PlanMode.ts` | Present plan for user approval, restore full tools |
| `Agent` | `Agent.ts` | Delegate to a pi agent by name (requires `pi-subagents`) |

**Slash commands:** `/todos`, `/tasks` (task list viewer) · `/plan` (toggle plan mode)  
**Keyboard:** `Ctrl+Alt+P` toggles plan mode

## Install

```bash
# Global install — available in all projects
pi install npm:@fractary/pi-claude-code

# Project-only install
pi install -l npm:@fractary/pi-claude-code
```

Or pin to a specific version:

```bash
pi install npm:@fractary/pi-claude-code@1.0.0
```

### Optional dependencies

**`WebSearch`** requires a Brave Search API key (free tier):
```bash
export BRAVE_API_KEY="your-key-here"   # add to ~/.profile or ~/.zprofile
```

**`Agent`** requires [pi-subagents](https://github.com/nicobailon/pi-subagents):
```bash
pi install npm:pi-subagents
```

Both tools load and register cleanly without their dependencies — they only return a setup message when actually invoked.

## Selective loading

Each extension is a separate file, so you can load only what you need using pi's [package filtering](https://shittycodingagent.ai/docs/packages#package-filtering):

```json
{
  "packages": [{
    "source": "npm:@fractary/pi-claude-code",
    "extensions": ["!extensions/Agent.ts"]
  }]
}
```

Common patterns:

| Goal | Filter |
|------|--------|
| Everything except Agent shim | `["!extensions/Agent.ts"]` |
| Task management only | `["extensions/Task.ts"]` |
| Filesystem tools only | `["extensions/Grep.ts", "extensions/Glob.ts", "extensions/LS.ts"]` |
| Plan mode only | `["extensions/PlanMode.ts"]` |

## Documentation

- **[Converting Claude Code plugins to pi packages](docs/converting-claude-plugins.md)** — how to add a `pi` section to `package.json`, map skills/commands/extensions, and bridge agents via the setup-agents pattern; covers single plugins and monorepos
- **[Migrating from Claude Code](docs/migrating-from-claude-code.md)** — how to structure agents, skills, and commands so they work in both harnesses; naming conventions and the namespace problem
- **[Filesystem tools](docs/filesystem-tools.md)** — Grep, Glob, LS vs pi's built-in grep / find / ls; differences and tips
- **[Task management](docs/task-management.md)** — TodoWrite vs TaskCreate; how shared state works; the /todos and /tasks commands
- **[Web tools](docs/web-tools.md)** — WebFetch via Jina Reader; WebSearch via Brave API; setup and differences from Claude Code
- **[Plan mode](docs/plan-mode.md)** — EnterPlanMode / ExitPlanMode tools; /plan command; differences from Claude Code's plan mode

## Contributing

When adding a new Claude Code tool shim:

1. Create `extensions/ToolName.ts` — file name must match the Claude Code tool name exactly
2. Match the parameter schema from the [Claude Code tools reference](https://docs.anthropic.com/en/docs/claude-code/tools-reference)
3. Store a full state snapshot in `details{}` for stateful tools (see `Task.ts` for the pattern)
4. Add the file to `pi.extensions` in `package.json`
5. Add a row to the tools table in this README
6. Bump the minor version and add a CHANGELOG entry

**Staying in sync:** Each extension file has a `Derived from:` and `On Claude Code update:` header comment pointing to the relevant schema source. When Claude Code updates a tool signature, update the corresponding extension and bump the version.

## License

MIT
