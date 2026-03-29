/**
 * pi-claude-code — Agent.ts
 *
 * Two responsibilities:
 *
 * 1. Agent() tool shim
 *    Registers the `Agent` tool that mirrors Claude Code v2.1.63+'s Agent() tool
 *    (which replaced Task() while remaining backward compatible).
 *    Maps Agent({ description, prompt }) → pi subagent execution via pi-subagents.
 *    Requires pi-subagents (optional); degrades gracefully when absent.
 *
 * 2. Package agent discovery  (pi.agents support)
 *    Pi's package manifest supports extensions/skills/prompts/themes but has no
 *    native "agents" concept — agent support comes from pi-subagents, which
 *    discovers agents from fixed directories only (~/.pi/agent/agents/, .pi/agents/).
 *
 *    This extension bridges that gap: on session_start it reads every installed
 *    package's package.json, looks for a `pi.agents` array, and symlinks the
 *    declared agent .md files into the appropriate pi-subagents discovery directory:
 *
 *      ~/.pi/agent/agents/  ← user-scope packages (global settings)
 *      .pi/agents/          ← project-scope packages + current project package.json
 *
 *    Plugin authors only need to add this to their package.json — no extension needed:
 *
 *      "pi": {
 *        "agents":  ["./agents"],
 *        "skills":  ["./skills"],
 *        "prompts": ["./commands"]
 *      }
 *
 *    The current project's package.json is also scanned, enabling the common pattern
 *    of pointing pi at a project's existing .claude/agents/ directory:
 *
 *      "pi": { "agents": [".claude/agents"] }
 *
 * 3. setupAgents() utility export  (Option 2)
 *    For packages that need explicit control over which directory is linked,
 *    a setupAgents() utility is exported. Import it into a minimal extension:
 *
 *      import { setupAgents } from "@fractary/pi-claude-code/extensions/Agent.ts";
 *      export default (pi) => setupAgents(pi, import.meta.url, "../my-agents");
 *
 * Derived from: pi-subagents@0.11.11 execution/agents/artifacts APIs
 * On pi-subagents update: verify runSync / discoverAgents / getArtifactsDir signatures.
 * On Claude Code update: verify Agent() parameter schema at
 *   https://docs.anthropic.com/en/docs/claude-code/tools-reference
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// ─── Constants ────────────────────────────────────────────────────────────────

const HOME        = homedir();
const PI_AGENT_DIR = join(HOME, ".pi", "agent");
const USER_AGENTS_DIR = join(PI_AGENT_DIR, "agents");

/** .pi directory name — matches pi's CONFIG_DIR_NAME */
const PI_DIR = ".pi";

// ─── npm global root (cached) ─────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __extdir   = dirname(__filename);  // .../extensions/

/**
 * Find the npm global node_modules root.
 *
 * Fast path: if this file is inside a node_modules directory (i.e. installed
 * via npm), walk up to find the node_modules root. This avoids spawning npm.
 *
 * Fallback: spawn `npm root -g` once and cache the result.
 */
let _npmRoot: string | null | undefined;
function getNpmGlobalRoot(): string | null {
	if (_npmRoot !== undefined) return _npmRoot;

	// Fast path — find node_modules in our own path
	const normalized = __extdir.split(sep).join("/");
	const marker = "/node_modules/";
	const idx = normalized.indexOf(marker);
	if (idx !== -1) {
		// Reconstruct using original separator
		const parts = __extdir.split(sep);
		const nmParts = normalized.slice(0, idx).split("/").length;
		_npmRoot = parts.slice(0, nmParts + 1).join(sep); // include "node_modules"
		return _npmRoot;
	}

	// Fallback — run npm root -g (sync, happens once)
	try {
		_npmRoot = execFileSync("npm", ["root", "-g"], {
			encoding: "utf-8",
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() || null;
	} catch {
		_npmRoot = null;
	}
	return _npmRoot;
}

// ─── Package spec parsing ─────────────────────────────────────────────────────

type PkgEntry = string | { source: string; [k: string]: unknown };

function entrySource(e: PkgEntry): string {
	return typeof e === "string" ? e : e.source;
}

/** Extract npm package name from spec, stripping version. Handles scoped packages. */
function parseNpmName(spec: string): string | null {
	// spec may be "@scope/pkg@1.2.3" or "pkg@1.2.3" or "pkg"
	const m = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/);
	return m?.[1] ?? null;
}

/** Parse a git package source into { host, repoPath } */
function parseGitSource(source: string): { host: string; repoPath: string } | null {
	let s = source
		.replace(/^git:/, "")
		.replace(/^https?:\/\//, "")
		.replace(/^ssh:\/\//, "")
		.replace(/^git@/, "");

	// Strip @ref suffix (e.g. @v1, @abc123) — careful: don't strip scoped npm @scope
	// In git context there's no scoped path, so any trailing @xxx is a ref
	s = s.replace(/@[^/@]*$/, "");

	// git@host:path → host/path
	s = s.replace(/^([^/:]+):/, "$1/");

	const slash = s.indexOf("/");
	if (slash === -1) return null;

	return {
		host: s.slice(0, slash),
		repoPath: s.slice(slash + 1).replace(/\.git$/, ""),
	};
}

/**
 * Resolve an installed package root directory from its settings source string.
 * Returns null if the path cannot be determined or doesn't exist.
 */
function resolvePackageRoot(
	source: string,
	scope: "user" | "project",
	cwd: string,
): string | null {
	const s = source.trim();

	// npm package
	if (s.startsWith("npm:")) {
		const name = parseNpmName(s.slice(4));
		if (!name) return null;

		if (scope === "user") {
			const npmRoot = getNpmGlobalRoot();
			if (!npmRoot) return null;
			return join(npmRoot, name);
		}
		// project-scope: .pi/npm/node_modules/name
		return join(cwd, PI_DIR, "npm", "node_modules", name);
	}

	// git package (git:, https://, http://, ssh://)
	const isGit =
		s.startsWith("git:") ||
		s.startsWith("https://") ||
		s.startsWith("http://") ||
		s.startsWith("ssh://");

	if (isGit) {
		const parsed = parseGitSource(s);
		if (!parsed) return null;

		if (scope === "user") {
			return join(PI_AGENT_DIR, "git", parsed.host, parsed.repoPath);
		}
		return join(cwd, PI_DIR, "git", parsed.host, parsed.repoPath);
	}

	// local path — resolve relative to the appropriate base
	const base =
		scope === "user"
			? PI_AGENT_DIR
			: join(cwd, PI_DIR);

	const expanded = s === "~"
		? HOME
		: s.startsWith("~/")
			? join(HOME, s.slice(2))
			: s;

	return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

// ─── Symlink utilities ────────────────────────────────────────────────────────

function symlinkOne(src: string, dst: string): "linked" | "replaced" | "skipped" {
	if (existsSync(dst) || (function () {
		try { lstatSync(dst); return true; } catch { return false; }
	})()) {
		try {
			const st = lstatSync(dst);
			if (st.isSymbolicLink()) {
				if (readlinkSync(dst) === src) return "skipped"; // already correct
				unlinkSync(dst); // stale — replace
			} else {
				return "skipped"; // real file, don't touch
			}
		} catch {
			try { unlinkSync(dst); } catch { return "skipped"; }
		}
	}
	try {
		symlinkSync(src, dst);
		return "linked";
	} catch {
		return "skipped";
	}
}

/** Remove symlinks in targetDir whose targets no longer exist. */
function pruneDeadSymlinks(targetDir: string): void {
	if (!existsSync(targetDir)) return;
	try {
		for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
			if (!entry.isSymbolicLink()) continue;
			const full = join(targetDir, entry.name);
			try {
				const target = readlinkSync(full);
				if (!existsSync(target)) unlinkSync(full);
			} catch {
				try { unlinkSync(full); } catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }
}

/**
 * Sync all .md files from sourceDir into targetDir using symlinks.
 * Returns the number of new links created.
 *
 * Exported for use by setupAgents() and direct callers.
 */
export function syncAgentsFromDir(sourceDir: string, targetDir: string): number {
	if (!existsSync(sourceDir)) return 0;

	let linked = 0;
	mkdirSync(targetDir, { recursive: true });

	try {
		for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
			if (!entry.name.endsWith(".md")) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;

			const src = join(sourceDir, entry.name);
			const dst = join(targetDir, entry.name);
			if (symlinkOne(src, dst) === "linked") linked++;
		}
	} catch { /* non-fatal */ }

	return linked;
}

// ─── Package agent scanning ───────────────────────────────────────────────────

/**
 * Read the pi.agents array from a package.json at pkgRoot.
 * Returns resolved absolute paths (files or directories).
 */
function readAgentPaths(pkgRoot: string): string[] {
	const pkgJson = join(pkgRoot, "package.json");
	if (!existsSync(pkgJson)) return [];
	try {
		const pkg = JSON.parse(readFileSync(pkgJson, "utf-8")) as {
			pi?: { agents?: string[] };
		};
		const entries = pkg?.pi?.agents;
		if (!Array.isArray(entries) || entries.length === 0) return [];
		return entries
			.map((e) => resolve(pkgRoot, e))
			.filter((p) => existsSync(p));
	} catch {
		return [];
	}
}

/**
 * Sync all agents declared in pkgRoot's package.json into targetDir.
 * Each entry in pi.agents can be a directory (all .md files inside)
 * or a single .md file.
 */
function syncAgentsFromPackage(pkgRoot: string, targetDir: string): number {
	const paths = readAgentPaths(pkgRoot);
	if (paths.length === 0) return 0;

	let total = 0;
	mkdirSync(targetDir, { recursive: true });

	for (const agentPath of paths) {
		try {
			const st = statSync(agentPath);
			if (st.isDirectory()) {
				total += syncAgentsFromDir(agentPath, targetDir);
			} else if (agentPath.endsWith(".md")) {
				const dst = join(targetDir, basename(agentPath));
				if (symlinkOne(agentPath, dst) === "linked") total++;
			}
		} catch { /* skip inaccessible paths */ }
	}

	return total;
}

/** Read a settings.json and return the packages array. */
function readSettingsPackages(settingsPath: string): PkgEntry[] {
	if (!existsSync(settingsPath)) return [];
	try {
		const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			packages?: PkgEntry[];
		};
		return Array.isArray(s.packages) ? s.packages : [];
	} catch {
		return [];
	}
}

/**
 * Main scanning entry point.
 *
 * Scans three sources for pi.agents declarations:
 *
 *   1. Current project's package.json  → agents go to .pi/agents/ (project scope)
 *   2. Project settings packages       → agents go to .pi/agents/ (project scope)
 *   3. Global settings packages        → agents go to ~/.pi/agent/agents/ (user scope)
 */
function scanAndRegisterAgents(cwd: string): {
	linked: number;
	sources: string[];
} {
	let linked = 0;
	const sources: string[] = [];

	const projectAgentsDir = join(cwd, PI_DIR, "agents");

	// 1. Current project's own package.json
	const projectPkgJson = join(cwd, "package.json");
	if (existsSync(projectPkgJson)) {
		const n = syncAgentsFromPackage(cwd, projectAgentsDir);
		if (n > 0) { linked += n; sources.push("project package.json"); }
	}

	// 2. Project-scoped installed packages
	const projectSettings = join(cwd, PI_DIR, "settings.json");
	for (const entry of readSettingsPackages(projectSettings)) {
		const src = entrySource(entry);
		const pkgRoot = resolvePackageRoot(src, "project", cwd);
		if (pkgRoot && existsSync(pkgRoot)) {
			const n = syncAgentsFromPackage(pkgRoot, projectAgentsDir);
			if (n > 0) { linked += n; sources.push(src); }
		}
	}

	// 3. Global/user-scoped installed packages
	const globalSettings = join(PI_AGENT_DIR, "settings.json");
	for (const entry of readSettingsPackages(globalSettings)) {
		const src = entrySource(entry);
		const pkgRoot = resolvePackageRoot(src, "user", cwd);
		if (pkgRoot && existsSync(pkgRoot)) {
			const n = syncAgentsFromPackage(pkgRoot, USER_AGENTS_DIR);
			if (n > 0) { linked += n; sources.push(src); }
		}
	}

	// Prune dead symlinks from both target directories
	pruneDeadSymlinks(USER_AGENTS_DIR);
	pruneDeadSymlinks(projectAgentsDir);

	return { linked, sources };
}

// ─── Option 2: setupAgents() utility export ───────────────────────────────────

/**
 * Utility for packages that want explicit control over which directory is linked,
 * rather than declaring pi.agents in package.json.
 *
 * Call this from a minimal extension in your package:
 *
 *   // extensions/setup.ts
 *   import { setupAgents } from "@fractary/pi-claude-code/extensions/Agent.ts";
 *   export default (pi) => setupAgents(pi, import.meta.url);
 *
 * By default, links ../agents relative to the calling extension file.
 * Pass a custom relative path to override:
 *
 *   setupAgents(pi, import.meta.url, "../my-agents");
 *   setupAgents(pi, import.meta.url, "../../plugins/my-plugin/agents");
 *
 * Agent files are symlinked to ~/.pi/agent/agents/ (user scope) so they are
 * available in all projects.
 */
export function setupAgents(
	pi: ExtensionAPI,
	callerImportMetaUrl: string,
	agentsRelativePath = "../agents",
): void {
	const callerDir = dirname(fileURLToPath(callerImportMetaUrl));
	const sourceDir = resolve(callerDir, agentsRelativePath);

	pi.on("session_start", async (_event, ctx) => {
		try {
			const n = syncAgentsFromDir(sourceDir, USER_AGENTS_DIR);
			pruneDeadSymlinks(USER_AGENTS_DIR);
			if (n > 0) {
				ctx.ui.notify(`Linked ${n} agent(s) from ${sourceDir}`, "info");
			}
		} catch (err: any) {
			ctx.ui.notify(`setupAgents: ${err.message}`, "warning");
		}
	});
}

// ─── Lazy pi-subagents loader (graceful degradation) ─────────────────────────

interface PiSubagentsAPI {
	runSync: Function;
	discoverAgents: Function;
	getArtifactsDir: Function;
	ensureArtifactsDir: Function;
}

let _api: PiSubagentsAPI | null = null;
let _loadError: string | null = null;
let _loaded = false;

async function loadPiSubagents(): Promise<PiSubagentsAPI | null> {
	if (_loaded) return _api;
	_loaded = true;
	try {
		const [execMod, agentsMod, artifactsMod] = await Promise.all([
			import("pi-subagents/execution.ts" as string),
			import("pi-subagents/agents.ts" as string),
			import("pi-subagents/artifacts.ts" as string),
		]);
		_api = {
			runSync:            execMod.runSync,
			discoverAgents:     agentsMod.discoverAgents,
			getArtifactsDir:    artifactsMod.getArtifactsDir,
			ensureArtifactsDir: artifactsMod.ensureArtifactsDir,
		};
	} catch (e: any) {
		_loadError =
			`Agent() shim requires pi-subagents — install it with:\n` +
			`  pi install npm:pi-subagents\n` +
			`(Error: ${e.message})`;
	}
	return _api;
}

// ─── Agent tool parameter schema ──────────────────────────────────────────────

const AgentParams = Type.Object({
	description: Type.String({
		description: "Name or short description of the agent to invoke (matched to a pi agent by name)",
	}),
	prompt: Type.String({
		description: "The full task or instructions to pass to the agent",
	}),
});

interface AgentDetails {
	description: string;
	resolvedAgent: string | null;
	prompt: string;
	error?: string;
}

// ─── Agent name resolution helpers ───────────────────────────────────────────

function normaliseToAgentName(description: string): string {
	return description.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveAgentByName(description: string, agents: any[]): string | null {
	if (agents.length === 0) return null;
	const normalised = normaliseToAgentName(description);

	// 1. Exact match
	const exact = agents.find((a) => a.name === description || a.name === normalised);
	if (exact) return exact.name;

	// 2. Substring match — but only when the description looks like a short keyword,
	// not when it already looks like a full kebab-case agent name.
	// Guard: if normalised contains >= 3 segments (e.g. "fractary-faber-workflow-planner"),
	// it is almost certainly an exact name that simply wasn't found — don't fall back
	// to a shorter partial match like "planner", which would silently run the wrong agent.
	const segments = normalised.split("-").filter(Boolean).length;
	if (segments < 3) {
		const partial = agents.find((a) => a.name.includes(normalised) || normalised.includes(a.name));
		if (partial) return partial.name;
	}

	return null;
}

// ─── Extension default export ─────────────────────────────────────────────────

export default function AgentExtension(pi: ExtensionAPI): void {

	// ── 1. Package agent scanning on session start ────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		try {
			const { linked, sources } = scanAndRegisterAgents(ctx.cwd);
			if (linked > 0) {
				const detail = sources.length === 1
					? sources[0]
					: `${sources.length} package(s)`;
				ctx.ui.notify(
					`pi-claude-code: linked ${linked} agent(s) from ${detail}`,
					"info",
				);
			}
		} catch (err: any) {
			// Non-fatal — don't crash pi startup
			ctx.ui.notify(
				`pi-claude-code: agent scanning failed — ${err.message}`,
				"warning",
			);
		}
	});

	// ── 2. Agent() tool shim ──────────────────────────────────────────────────

	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description:
			"Invoke a named agent with a task. Mirrors Claude Code's Agent() tool (formerly Task()). " +
			"The description field is matched to a pi agent by name. " +
			"Requires pi-subagents: pi install npm:pi-subagents",
		parameters: AgentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const api = await loadPiSubagents();
			if (!api) {
				return {
					content: [{ type: "text", text: _loadError ?? "pi-subagents not available" }],
					details: {
						description: params.description,
						resolvedAgent: null,
						prompt: params.prompt,
						error: _loadError ?? "pi-subagents not available",
					} as AgentDetails,
				};
			}

			const { agents } = api.discoverAgents(ctx.cwd, "both");
			const resolvedAgent = resolveAgentByName(params.description, agents);

			if (!resolvedAgent) {
				const available = agents.map((a: any) => `  • ${a.name}`).join("\n") || "  (none found)";
				return {
					content: [{
						type: "text",
						text:
							`Agent not found: "${params.description}" ` +
							`(normalised: "${normaliseToAgentName(params.description)}")\n\n` +
							`Available agents:\n${available}`,
					}],
					details: {
						description: params.description,
						resolvedAgent: null,
						prompt: params.prompt,
						error: `No agent matched "${params.description}"`,
					} as AgentDetails,
				};
			}

			const sessionFile = (ctx.sessionManager as any)?.getSessionFile?.() ?? null;
			const artifactsDir = sessionFile
				? api.getArtifactsDir(sessionFile)
				: mkdtempSync(join(tmpdir(), "pi-agent-shim-"));
			api.ensureArtifactsDir(artifactsDir);

			const runId = randomUUID();

			try {
				const result = await api.runSync(ctx.cwd, agents, resolvedAgent, params.prompt, {
					cwd: ctx.cwd,
					signal,
					onUpdate,
					runId,
					artifactsDir,
					index: 0,
				});

				return {
					content: [{ type: "text", text: result.output ?? result.error ?? "(no output)" }],
					details: { description: params.description, resolvedAgent, prompt: params.prompt } as AgentDetails,
				};
			} catch (error: any) {
				return {
					content: [{ type: "text", text: `Agent execution error: ${error.message}` }],
					details: {
						description: params.description,
						resolvedAgent,
						prompt: params.prompt,
						error: error.message,
					} as AgentDetails,
				};
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("Agent ")) +
					theme.fg("accent", args.description) +
					theme.fg("dim", ` — "${args.prompt?.slice(0, 60)}${(args.prompt?.length ?? 0) > 60 ? "…" : ""}"`),
				0,
				0,
			);
		},

		renderResult(result, _state, theme) {
			const details = result.details as AgentDetails | undefined;
			if (details?.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			if (details?.resolvedAgent) {
				const text = result.content[0];
				const lines = (text?.type === "text" ? text.text : "").split("\n").filter(Boolean).length;
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("accent", details.resolvedAgent) +
						theme.fg("muted", ` — ${lines} line(s)`),
					0,
					0,
				);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? theme.fg("muted", text.text) : "", 0, 0);
		},
	});
}
