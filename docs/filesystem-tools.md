# Filesystem Tools: Grep, Glob, LS

Claude Code exposes `Grep`, `Glob`, and `LS` as first-class tools the model can call directly. Pi has equivalent built-in tools but with different names and conventions. This package provides the PascalCase shims so Claude Code agents work unchanged.

## The name mismatch

| Claude Code | Pi built-in | This package |
|-------------|-------------|--------------|
| `Grep` | `grep` | `Grep.ts` — PascalCase shim |
| `Glob` | `find` | `Glob.ts` — PascalCase shim + rg --files |
| `LS` | `ls` | `LS.ts` — PascalCase shim |

Pi's built-in tools are lowercase. Claude Code's are PascalCase. The shims in this package register the PascalCase names so agents that call `Grep(...)` or `Glob(...)` find what they expect. Internally, they call the same underlying binaries.

One additional difference: pi's built-in is named `find` (matching the Unix command), while Claude Code's is `Glob` (emphasizing the glob pattern matching). The shim wraps `rg --files --glob <pattern>` (ripgrep) with a `find` fallback.

## Tool parameters

### Grep

```
Grep({ pattern, path?, include? })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Regex pattern to search for |
| `path` | string? | Directory or file to search. Defaults to cwd |
| `include` | string? | Glob pattern to filter files — e.g. `*.ts`, `**/*.md` |

Returns matching lines in `file:line:content` format (same as `rg -n --no-heading`). Returns `"No matches found"` if nothing matches — exit code 1 from rg/grep is treated as no-match, not an error.

**Implementation**: ripgrep (`rg`) if available, `grep -r` fallback. Ripgrep is bundled with pi, so it will almost always be available.

### Glob

```
Glob({ pattern, path? })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Glob pattern — e.g. `**/*.ts`, `src/**/*.json` |
| `path` | string? | Directory to search within. Defaults to cwd |

Returns one file path per line. Paths are returned in the order ripgrep finds them (roughly by directory, not sorted by modification time despite what Claude Code's docs say — the shim uses rg, not a modified-time sort).

**Implementation**: `rg --files --glob <pattern>` if ripgrep is available. The `find` fallback extracts the basename from the glob and uses `-name "*.ext"` — it handles simple patterns but not complex multi-level globs. Install ripgrep for full glob support.

### LS

```
LS({ path })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Directory path to list |

Returns the output of `ls -la` — long format including hidden files, permissions, sizes, and modification times.

## Output limits

All three tools truncate output to prevent overwhelming the context:

- Maximum **500 lines** — if truncated, the result notes how many total matches exist
- Maximum **50KB** — hard character limit with a truncation notice

If you're hitting these limits, narrow your search with a more specific pattern or `include` filter.

## Differences from Claude Code's versions

| Behaviour | Claude Code | This shim |
|-----------|-------------|-----------|
| Grep engine | Proprietary | ripgrep / grep |
| Glob sort order | Newest files first | ripgrep order (directory traversal) |
| LS format | Varies | Always `ls -la` |
| Error on no match | Returns empty | Returns `"No matches found"` |
| Output truncation | 50KB | 500 lines or 50KB |

The functional behaviour is equivalent for all practical agent uses. The sort order difference in `Glob` only matters if your agent assumes the first result is the most recently modified file.

## Tips for writing agents that use these tools

**Prefer `Grep` over `Bash({ command: "rg ..." })`** — it works in pi plan mode (where bash is restricted) and produces consistent output format regardless of which grep implementation is available.

**Use `include` to narrow Grep searches** — searching with a file type filter is significantly faster and produces cleaner output:
```
Grep({ pattern: "TaskCreate", include: "*.md" })
```

**Use `Glob` to discover files before reading them** — rather than hardcoding paths, let `Glob` find relevant files first:
```
Glob({ pattern: "**/*.md", path: "plugins" })
```

**`LS` is for directory inspection, not file finding** — if you need to check what's in a specific directory, `LS` is the right tool. If you need to find files matching a pattern across a directory tree, use `Glob`.
