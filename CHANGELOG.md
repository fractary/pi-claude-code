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
- `extensions/Agent.ts` — `Agent` shim mapping Claude Code's Agent() tool to pi-subagents execution (graceful degradation when pi-subagents is not installed)
