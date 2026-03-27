# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
