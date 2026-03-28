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

## Agents — the bridge pattern

Pi itself has no native agents concept. Agent support is provided by the `pi-subagents` extension, which discovers agents from fixed directories:

| Scope | Directory |
|-------|-----------|
| User (global) | `~/.pi/agent/agents/` |
| Project | Nearest `.pi/agents/` walking up from CWD |
| Builtin | Inside `pi-subagents` package |

Since there's no `pi.agents` key in `package.json`, there's no direct way to declare agents in a pi package manifest. The solution is to ship a **setup extension** that symlinks your agent files into the user agents directory on session start.

### The setup-agents.ts pattern

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

### Why symlinks instead of copies

Symlinks mean updates to your package (via `pi update`) are immediately reflected without re-linking. If a file moves (e.g. after a git pull), the setup extension detects the stale symlink and replaces it. The check `if (!stat.isSymbolicLink()) continue` ensures the extension never overwrites a real file with the same name that the user may have created themselves.

### Multi-plugin monorepo with setup-agents

For a monorepo with multiple plugin directories, you can either write one setup extension per plugin or loop over multiple source directories:

```typescript
const PLUGIN_DIRS = ["plugin-a/agents", "plugin-b/agents"].map(rel =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", rel)
);
```

### Project-scoped agents (alternative)

If you want agents to only be available when working in a specific project rather than globally, skip the symlink extension and put your agent files in `.pi/agents/` in the project root:

```
my-project/
└── .pi/
    └── agents/
        ├── my-agent.md
        └── another-agent.md
```

`pi-subagents` automatically discovers `.pi/agents/` by walking up from the CWD. These are "project-scoped" agents and only visible when you're inside that project directory. No extension needed.

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
├── extensions/
│   └── setup-agents.ts        # new — symlinks agents to ~/.pi/agent/agents/
├── skills/
│   └── my-skill/SKILL.md      # unchanged
├── commands/
│   └── do-thing.md            # unchanged
└── package.json               # pi section added
```

`package.json`:
```json
{
  "name": "my-plugin",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills":     ["./skills"],
    "prompts":    ["./commands"]
  }
}
```

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
