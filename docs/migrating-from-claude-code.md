# Migrating from Claude Code

This guide covers what you need to know when moving agents, skills, and commands from Claude Code to pi. The short version: most things work as-is once `pi-claude-code` is installed. The exceptions are mostly about naming.

## The structural mapping

Claude Code and pi share the same fundamental concepts under different names:

| Claude Code | Pi equivalent | Notes |
|-------------|---------------|-------|
| Agents (`.claude/agents/`) | Agents (`.pi/agents/` or `~/.pi/agent/agents/`) | YAML frontmatter + markdown body |
| Skills (`.claude/skills/`) | Skills (`.pi/skills/` etc.) | Nearly identical format |
| Commands (`.claude/commands/`) | Commands / Prompts (`.pi/commands/`) | Markdown prompt templates |
| Plugins | Pi packages | Git or npm installable |
| `settings.json` | `.pi/settings.json` | Similar structure |
| `CLAUDE.md` | `AGENTS.md` | Auto-loaded context file |

Skills require essentially zero changes — pi implements the [Agent Skills standard](https://agentskills.io/specification) and loads them from the same `SKILL.md` format. You can point pi at your existing Claude Code skill directories and they will just work:

```json
{
  "skills": ["~/.claude/skills", ".claude/skills"]
}
```

Agents and commands need minor adjustments, covered below.

## The namespace problem

This is the most important thing to understand when writing agents and commands that need to work in both Claude Code and pi.

Claude Code has a **plugin namespace** system. When you reference an agent from another agent, you can write:

```
subagent_type: "my-plugin:my-agent"
```

Pi has **no namespace syntax** for cross-referencing. Agents, skills, and commands are identified by name only. When the model calls `Agent("my-plugin:my-agent")`, pi looks for an agent literally named `my-plugin:my-agent` — which doesn't exist.

### The solution: unique names, no namespace references

Design your names to be globally unique without relying on a namespace prefix at call time. The pattern that works in both systems:

**Embed the "namespace" in the name itself.**

Instead of:
```
# Agent named: my-agent
# Referenced as: my-plugin:my-agent
```

Do:
```
# Agent named: my-plugin-my-agent
# Referenced as: my-plugin-my-agent   (same in both systems)
```

Your Claude Code agents, skills, and commands should use the full prefixed name in both the file name and any cross-references. If you do this consistently, the same reference works in both Claude Code (where the name just happens to be unique) and pi (where it's the only way to reference it).

### Practical example

Suppose you have a plugin called `faber` with agents `workflow-planner`, `workflow-runner`, and `workflow-verifier`. The names to use:

| What not to do | What to do |
|----------------|------------|
| Agent named `workflow-planner`, referenced as `faber:workflow-planner` | Agent named `fractary-faber-workflow-planner`, referenced by that full name |
| Skill named `issue-fetch`, referenced as `fractary-work:issue-fetch` | Skill named `fractary-work-issue-fetch` |
| Command calling `Task(faber:workflow-runner)` | Command calling `Agent(fractary-faber-workflow-runner)` |

This does mean longer names everywhere, but it also means the names are self-documenting — you know where an agent came from just by reading its name.

> **Note:** This is exactly the rename we had to do when migrating our own workflow suite. Every agent, skill, and command had plugin-namespaced references internally. We had to do a pass through all files to replace `faber:workflow-planner` with `fractary-faber-workflow-planner` throughout. A one-time cost, but worth doing cleanly rather than working around it.

## Agent frontmatter differences

Claude Code agent frontmatter:

```yaml
---
name: my-agent
description: What this agent does
tools: Read, Write, Bash, Grep
model: claude-sonnet-4-5
---
```

Pi agent frontmatter:

```yaml
---
name: my-agent
description: What this agent does
tools: read, write, bash, Grep, Glob, LS
model: anthropic/claude-sonnet-4-5
---
```

Key differences:
- **Tool names**: pi's built-in tools are lowercase (`read`, `write`, `edit`, `bash`). Claude Code's built-ins are PascalCase (`Read`, `Write`, `Edit`, `Bash`). `pi-claude-code` provides PascalCase shims for `Grep`, `Glob`, `LS`, and the others — but not for the four core tools. In practice the model adapts, but if you want to be explicit in `allowed-tools`, use the lowercase names for core tools.
- **Model names**: pi uses provider-prefixed model names (`anthropic/claude-sonnet-4-5`). Claude Code uses short names (`claude-sonnet-4-5`). If your agent frontmatter specifies a model, update it.
- **`subagent_type`**: Claude Code uses this field; pi uses it too but as `name`. Both support the `Agent(name)` tool-based invocation pattern.

## Command differences

Claude Code commands are markdown files in `.claude/commands/`. Pi commands are markdown files in `.pi/commands/` (or `commands/` in a package). Both use YAML frontmatter and a markdown body that becomes the prompt.

The main difference is **how agents are invoked from commands**:

| Claude Code | Pi |
|-------------|-----|
| `Task(agent-name)` | `Agent(agent-name)` or `subagent(agent-name)` |
| `subagent_type: "plugin:agent"` | `Agent("plugin-agent")` (full prefixed name) |

`pi-claude-code`'s `Agent.ts` shim handles the `Agent(name)` call, so if you've already updated your commands to use `Agent(...)` instead of `Task(...)` (as Claude Code itself did in v2.1.63+), they will work in pi.

## What doesn't map

A few Claude Code concepts don't have direct pi equivalents:

- **`CronCreate`/`CronList`/`CronDelete`**: Session-scoped scheduled tasks. No pi equivalent.
- **`EnterWorktree`/`ExitWorktree`**: Claude Code manages git worktrees as a first-class feature. Pi doesn't — use git worktrees manually.
- **`LSP`**: Language server integration is a Claude Code plugin ecosystem feature.
- **`NotebookEdit`**: Jupyter notebook editing. No pi equivalent.
- **`PowerShell`**: Windows-only. Pi uses `bash` on all platforms.

For the FABER workflow suite and most real-world agent workflows, none of these are needed — they're specialty tools.

## Quick checklist

When moving an agent/skill/command from Claude Code to pi:

- [ ] Skills: point pi at your skill directories in settings — done
- [ ] Agents: rename any that use plugin namespace references in their names or cross-references
- [ ] Commands: update `Task(...)` calls to `Agent(...)` if you haven't already
- [ ] Commands/agents that reference other agents/skills: replace `plugin:name` syntax with `plugin-name`
- [ ] Model names: update to `provider/model` format if explicitly set in frontmatter
- [ ] `CLAUDE.md`: copy/rename to `AGENTS.md` for pi's auto-loading
- [ ] Install `@fractary/pi-claude-code`: `pi install npm:@fractary/pi-claude-code` — this provides tool shims AND automatic `pi.agents` discovery
- [ ] Add `"pi": { "agents": ["./path/to/agents"] }` to each plugin's `package.json` so agents are discovered when the package is installed
- [ ] Install `pi-subagents` if you use `Agent(...)` delegation
