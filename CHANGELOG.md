# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-03-27

### Added

- `extensions/Agent.ts` — `pi.agents` package scanning: reads `pi.agents` from every installed package's `package.json` on `session_start` and symlinks declared agent `.md` files into the correct pi-subagents discovery directory (`~/.pi/agent/agents/` for user-scope, `.pi/agents/` for project-scope). Also scans the current project's own `package.json`, enabling `.claude/agents/` to be exposed to pi with a single manifest entry.
- `extensions/Agent.ts` — `setupAgents(pi, importMetaUrl, relativePath?)` named export for packages that need explicit agent registration without `package.json` declarations (Option 2)
- `extensions/Agent.ts` — `syncAgentsFromDir(sourceDir, targetDir)` named export for low-level agent linking
- `extensions/Plugin.ts` — self-contained agent setup template (not auto-loaded; copy-and-modify for packages that need zero external dependencies)

### Changed

- `extensions/Agent.ts` — unified both the `Agent()` tool shim and package agent discovery into one extension; the two concerns belong together since both are about making Claude agents work in pi
- `docs/converting-claude-plugins.md` — updated agents section to document `pi.agents` as the primary mechanism; legacy `setup-agents.ts` pattern replaced by `Plugin.ts` reference
- `forge/package.json` — migrated from `setup-agents.ts` extension to `"pi": { "agents": ["plugins/forge/agents"] }`

## [1.0.0] - 2026-03-27

### Added

- `extensions/Grep.ts` — `Grep` shim → ripgrep / grep fallback
- `extensions/Glob.ts` — `Glob` shim → rg --files / find fallback
- `extensions/LS.ts` — `LS` shim → ls -la
- `extensions/AskUserQuestion.ts` — `AskUserQuestion` shim with TUI option picker and free-text fallback
- `extensions/Task.ts` — `todo` (pi-native), `TodoWrite`, `TodoRead`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `TaskStop` shims; `/todos` and `/tasks` slash commands
- `extensions/WebFetch.ts` — `WebFetch` shim fetching any URL as clean markdown via Jina Reader (no API key required)
- `extensions/WebSearch.ts` — `WebSearch` shim via Brave Search API (requires `BRAVE_API_KEY`; graceful degradation when not set)
- `extensions/Skill.ts` — `Skill` shim: discovers pi skills via `loadSkills()`, reads SKILL.md, resolves `{baseDir}`, returns content to model
- `extensions/PlanMode.ts` — `EnterPlanMode` and `ExitPlanMode` shims built on the official pi plan-mode example; includes `/plan` command, `Ctrl+Alt+P` shortcut, step tracking, and session persistence
- `extensions/Agent.ts` — `Agent` shim mapping Claude Code's Agent() tool to pi-subagents execution (graceful degradation when pi-subagents is not installed)
