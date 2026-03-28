# Converting Claude Code Plugins to Pi Packages

A Claude Code plugin is a directory with agents, skills, commands, and optionally extensions. Pi has an equivalent package system — you declare what a package contains in the `pi` section of `package.json`, and pi loads the declared resources automatically when the package is installed.

The conversion is mostly a matter of adding the right `pi` section to your `package.json` and pointing it at your existing directories. Skills and commands (prompts) map directly with no file changes required. Agents need a small bridge because pi itself doesn't have a native agent concept — that comes from the `pi-subagents` extension.

## The `pi` section in `package.json`

Pi reads four resource types from the `pi` section:

```json
{
  "name": "my-plugin",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills":     ["./skills"],
    "prompts":    ["./commands"],
    "themes":     ["./themes"]
  }
}
```

Each value is an array of paths relative to the package root. Paths can point to directories (pi discovers all valid files inside) or individual files. Glob patterns and `!exclusions` are supported.

### What each key covers

| Key | Claude Code equivalent | What goes here |
|-----|------------------------|----------------|
| `skills` | Skills (`~/.claude/skills/`, `.claude/skills/`) | Directories containing `SKILL.md` folders |
| `prompts` | Commands (`~/.claude/commands/`, `.claude/commands/`) | `.md` files that are prompt templates / slash commands |
| `extensions` | N/A | TypeScript extension files that register pi tools, commands, events |
| `themes` | N/A | JSON theme files |

**There is no `agents` key.** Pi itself has no native agent concept. Agent support comes from `pi-subagents` (see below).

## Single-plugin repo

If your repo is a single Claude plugin, the structure typically looks like:

```
my-plugin/
├── agents/
│   ├── my-agent.md
│   └── another-agent.md
├── commands/
│   ├── do-thing.md
│   └── other-thing.md
├── skills/
│   ├── my-skill/
│   │   └── SKILL.md
│   └── other-skill/
│       └── SKILL.md
└── package.json
```

Add the `pi` section pointing at each directory:

```json
{
  "name": "my-plugin",
  "keywords": ["pi-package"],
  "pi": {
    "skills":  ["./skills"],
    "prompts": ["./commands"]
  }
}
```

Skills and commands are now available immediately when the package is installed. No file changes needed.

## Monorepo / marketplace structure

If your repo contains multiple plugins (a common pattern for plugin marketplaces or monorepos), include paths from all of them:

```
my-repo/
├── plugins/
│   ├── plugin-a/
│   │   ├── agents/
│   │   ├── commands/
│   │   └── skills/
│   └── plugin-b/
│       ├── agents/
│       ├── commands/
│       └── skills/
└── package.json
```

```json
{
  "name": "my-repo",
  "keywords": ["pi-package"],
  "pi": {
    "skills":  ["plugins/plugin-a/skills",  "plugins/plugin-b/skills"],
    "prompts": ["plugins/plugin-a/commands", "plugins/plugin-b/commands"]
  }
}
```

This is exactly the pattern used in the Fractary Forge monorepo, which has a single `plugins/forge/` directory containing all forge resources:

```json
{
  "pi": {
    "extensions": ["plugins/forge/extensions"],
    "skills":     ["plugins/forge/skills"],
    "prompts":    ["plugins/forge/commands"],
    "themes":     ["plugins/forge/themes"]
  }
}
```

## Agents — `pi.agents` in package.json

Pi itself has no native agents concept. Agent support is provided by the `pi-subagents` extension, which discovers agents from fixed directories:

| Scope | Directory |
|-------|-----------|
| User (global) | `~/.pi/agent/agents/` |
| Project | Nearest `.pi/agents/` walking up from CWD |
| Builtin | Inside `pi-subagents` package |

`@fractary/pi-claude-code`'s `Agent.ts` extension bridges this gap. It reads `pi.agents` from every installed package's `package.json` on session start and symlinks the declared agent files into the appropriate discovery directory. This means you declare agents exactly like skills and prompts — no extension required:

```json
{
  "pi": {
    "agents":  ["./agents"],
    "skills":  ["./skills"],
    "prompts": ["./commands"]
  }
}
```

**Scope rules:**
- Packages in global settings (`~/.pi/agent/settings.json`) → agents land in `~/.pi/agent/agents/` (available everywhere)
- Packages in project settings (`.pi/settings.json`) → agents land in `.pi/agents/` (this project only)

### Current project's own agents

The current project's `package.json` is also scanned, enabling a common pattern: expose a project's existing `.claude/agents/` to pi without moving any files:

```json
{
  "pi": { "agents": [".claude/agents"] }
}
```

`Agent.ts` detects this on session start and symlinks the agents into `.pi/agents/` automatically.

### Multi-plugin monorepo

List all agent directories:

```json
{
  "pi": {
    "agents": ["plugins/plugin-a/agents", "plugins/plugin-b/agents"]
  }
}
```

### Option 2: explicit extension (for packages without pi-claude-code)

If you need agents registered even without `@fractary/pi-claude-code` installed — or want custom logic — use one of these approaches:

**Using the exported utility** (if pi-claude-code is available as a dependency):
```typescript
// extensions/setup.ts
import { setupAgents } from "@fractary/pi-claude-code/extensions/Agent.ts";
export default (pi) => setupAgents(pi, import.meta.url, "../agents");
```

**Self-contained** (no dependency): copy `extensions/Plugin.ts` from the pi-claude-code repo into your project and adjust `AGENTS_RELATIVE_PATH`. It's a standalone ~60-line extension with no external imports.

### The setup-agents.ts pattern (legacy reference)

> **Prefer `pi.agents` in package.json** — if `@fractary/pi-claude-code` is installed, you don't need this at all. This pattern is documented for reference and for cases where the dependency isn't available.

Create an extension that runs on `session_start` and symlinks your agents into `~/.pi/agent/agents/`:

```typescript
// extensions/setup-agents.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS_SOURCE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "agents"   // adjust to your agents directory relative to this extension file
);

const AGENTS_TARGET_DIR = path.join(os.homedir(), ".pi", "agent", "agents");

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      fs.mkdirSync(AGENTS_TARGET_DIR, { recursive: true });
      if (!fs.existsSync(AGENTS_SOURCE_DIR)) return;

      const agentFiles = fs.readdirSync(AGENTS_SOURCE_DIR, { withFileTypes: true })
        .filter(e => e.name.endsWith(".md") && (e.isFile() || e.isSymbolicLink()));

      let linked = 0;
      for (const entry of agentFiles) {
        const src = path.join(AGENTS_SOURCE_DIR, entry.name);
        const dst = path.join(AGENTS_TARGET_DIR, entry.name);

        if (fs.existsSync(dst)) {
          const stat = fs.lstatSync(dst);
          if (stat.isSymbolicLink() && fs.readlinkSync(dst) === src) continue; // already correct
          if (!stat.isSymbolicLink()) continue; // real file — don't touch
          fs.unlinkSync(dst); // stale symlink — replace
        }

        fs.symlinkSync(src, dst);
        linked++;
      }

      if (linked > 0) ctx.ui.notify(`Linked ${linked} agent(s)`, "info");
    } catch (err) {
      ctx.ui.notify(`Failed to link agents: ${(err as Error).message}`, "warning");
    }
  });
}
```

Add this extension to your `pi.extensions` declaration:

```json
{
  "pi": {
    "extensions": ["./extensions/setup-agents.ts", "./extensions"],
    "skills":     ["./skills"],
    "prompts":    ["./commands"]
  }
}
```

Now when anyone installs your package and starts pi, their `~/.pi/agent/agents/` will contain symlinks to your agents. They'll be discovered by `pi-subagents` as user-scoped agents and available to the `Agent()` tool, chains, and the `/agents` command.

Agent.ts handles all of this automatically when you use `pi.agents` in package.json. Symlinks are idempotent, stale links are replaced, and dead links are pruned on every session start.

## Agent file format for pi-subagents

Agent files are markdown with YAML frontmatter. The fields recognized by pi-subagents are:

```markdown
---
name: my-plugin-my-agent
description: What this agent does and when to invoke it
tools: read, write, bash, Grep, Glob
model: anthropic/claude-sonnet-4-5
thinking: medium
skills: my-skill, other-skill
output: result.md
defaultReads: context.md
defaultProgress: true
---

You are an agent that...
```

Fields that Claude Code uses but pi-subagents **ignores** (stored as `extraFields` but not acted on):
- `color`
- `memory`
- `hooks`
- `permissions`
- `mcpServers`

Fields that differ from Claude Code:
- `tools`: use pi tool names. Pi built-ins are lowercase (`read`, `write`, `edit`, `bash`). If you're using `pi-claude-code`, you can also list the CC-name shims (`Grep`, `TaskCreate`, etc.)
- `model`: use `provider/model` format (`anthropic/claude-sonnet-4-5`, not just `claude-sonnet-4-5`)

Unknown frontmatter fields are preserved harmlessly — so Claude Code-specific fields won't break anything, they just won't do anything.

## Full example: converting a Claude plugin

**Before** (Claude Code plugin structure):

```
my-plugin/
├── .claude/
│   └── agents/
│       └── my-agent.md        # Claude Code agent
├── skills/
│   └── my-skill/SKILL.md
└── commands/
    └── do-thing.md
```

**After** (pi-compatible):

```
my-plugin/
├── agents/
│   └── my-agent.md            # same file, updated model field
├── skills/
│   └── my-skill/SKILL.md      # unchanged
├── commands/
│   └── do-thing.md            # unchanged
└── package.json               # pi section added — that's it
```

`package.json`:
```json
{
  "name": "my-plugin",
  "keywords": ["pi-package"],
  "pi": {
    "agents":  ["./agents"],
    "skills":  ["./skills"],
    "prompts": ["./commands"]
  }
}
```

No setup extension needed. `@fractary/pi-claude-code`'s `Agent.ts` handles agent discovery automatically when installed.

`agents/my-agent.md` — only the `model` field needs updating:
```yaml
---
name: my-plugin-my-agent
description: Does a thing
tools: read, bash, Grep
model: anthropic/claude-sonnet-4-5   # was: claude-sonnet-4-5
---
```

Install and verify:
```bash
pi install ./my-plugin     # or git:github.com/you/my-plugin
pi list                    # confirm package appears
```

On next pi startup, your skills and commands are available, and your agents are symlinked into `~/.pi/agent/agents/`.

## Installing the package

```bash
# From local path (development)
pi install /path/to/my-plugin

# From git (recommended for sharing)
pi install git:github.com/you/my-plugin

# From npm (if published)
pi install npm:my-plugin

# Project-only install (team sharing via .pi/settings.json)
pi install -l git:github.com/you/my-plugin
```

When installed via git, pi clones to `~/.pi/agent/git/github.com/you/my-plugin/` and runs `npm install` if `package.json` exists. `pi update` pulls the latest changes.

## Required dependencies

If your agents use `pi-claude-code` shims (Grep, TaskCreate, WebFetch, etc.) or the `Agent()` tool, those packages need to be installed separately — your plugin doesn't pull them in automatically:

```bash
pi install npm:@fractary/pi-claude-code
pi install npm:pi-subagents   # required for Agent() delegation
```

Document these as prerequisites in your plugin's README.
