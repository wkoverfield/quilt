// Magical onboarding: detect the agent orchestrator in a repo and wire Quilt in
// as the shared MCP server, plus drop a coordination snippet into CLAUDE.md.
//
// Everything here is idempotent and non-destructive: existing config is parsed
// and merged, never clobbered. If a file can't be safely merged (e.g. malformed
// JSON), we leave it alone and tell the user what to add by hand.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The MCP server entry every agent in the fleet shares. */
export const QUILT_SERVER = { command: "quilt", args: ["mcp"] } as const;

/** Marker so the CLAUDE.md snippet is added at most once. */
export const COORDINATION_MARKER = "<!-- quilt:coordination -->";

/** The coordination instructions appended to CLAUDE.md. */
export const COORDINATION_BLOCK = `${COORDINATION_MARKER}
## Coordinating with other agents (Quilt)

You share this checkout with other agents. Coordinate through Quilt:

- Pick a stable id for yourself — your role or task name (e.g. \`auth-agent\`).
  Use that exact id as \`actor\` on every Quilt call.
- Before you edit a file, \`claim\` what you're about to change
  (\`path#symbol\`, e.g. \`src/auth.ts#login\`). If it's denied, someone else holds
  it — edit something else or coordinate.
- The claim response may include \`dependencyWarnings\`: a function you depend on
  is being changed by another agent. Account for it.
- When your change is ready, \`commit_mine\` with your id. It commits only your
  lines and leaves everyone else's work untouched.`;

export interface Detected {
  mcpJsonPath: string;
  claudeMdPath: string;
  hasMcpJson: boolean;
  hasClaudeMd: boolean;
  /** Signals a Claude Code / Cursor / generic agent setup is in use. */
  orchestrator: string | null;
  quiltWired: boolean;
  coordinationPresent: boolean;
}

/** Inspect a repo root for orchestrator config and whether Quilt is wired in. */
export function detect(root: string): Detected {
  const mcpJsonPath = join(root, ".mcp.json");
  const claudeMdPath = join(root, "CLAUDE.md");
  const hasMcpJson = existsSync(mcpJsonPath);
  const hasClaudeMd = existsSync(claudeMdPath);
  const hasClaudeDir = existsSync(join(root, ".claude"));
  const hasCursorDir = existsSync(join(root, ".cursor"));
  const hasAgentsMd = existsSync(join(root, "AGENTS.md"));

  const orchestrator =
    hasClaudeDir || hasClaudeMd || hasMcpJson
      ? "Claude Code"
      : hasCursorDir
        ? "Cursor"
        : hasAgentsMd
          ? "agents (AGENTS.md)"
          : null;

  const quiltWired = hasMcpJson && mcpServersHasQuilt(safeRead(mcpJsonPath));
  const coordinationPresent =
    hasClaudeMd && (safeRead(claudeMdPath) ?? "").includes(COORDINATION_MARKER);

  return {
    mcpJsonPath,
    claudeMdPath,
    hasMcpJson,
    hasClaudeMd,
    orchestrator,
    quiltWired,
    coordinationPresent,
  };
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function mcpServersHasQuilt(content: string | null): boolean {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content);
    return Boolean(parsed?.mcpServers?.quilt);
  } catch {
    return false;
  }
}

export interface MergeResult {
  content: string;
  changed: boolean;
  /** Set when the existing file couldn't be merged safely; content is unchanged. */
  error?: string;
}

/**
 * Add the `quilt` server to an `.mcp.json`. Creates the file content if absent
 * (existing === null), no-ops if quilt is already present, and refuses to touch
 * a file that isn't valid JSON (returns an error instead of clobbering it).
 */
export function mergeMcpServers(existing: string | null): MergeResult {
  if (existing === null || existing.trim() === "") {
    return {
      content: JSON.stringify({ mcpServers: { quilt: QUILT_SERVER } }, null, 2) + "\n",
      changed: true,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { content: existing, changed: false, error: "not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { content: existing, changed: false, error: "not a JSON object" };
  }
  const obj = parsed as { mcpServers?: Record<string, unknown> };
  obj.mcpServers ??= {};
  if (obj.mcpServers.quilt) return { content: existing, changed: false };
  obj.mcpServers.quilt = { ...QUILT_SERVER };
  return { content: JSON.stringify(obj, null, 2) + "\n", changed: true };
}

/**
 * Append the coordination snippet to CLAUDE.md. No-ops if the marker is already
 * present; otherwise appends with a blank-line separator.
 */
export function appendCoordination(existing: string | null): MergeResult {
  const base = existing ?? "";
  if (base.includes(COORDINATION_MARKER)) return { content: base, changed: false };
  const sep = base === "" ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return { content: base + sep + COORDINATION_BLOCK + "\n", changed: true };
}

export interface SetupStep {
  file: string;
  action: "create" | "update" | "skip";
  detail: string;
  content?: string; // present when action !== skip
  path: string;
}

/** Compute the setup plan for a repo without writing anything. */
export function planSetup(root: string): SetupStep[] {
  const d = detect(root);
  const steps: SetupStep[] = [];

  const mcpExisting = d.hasMcpJson ? safeRead(d.mcpJsonPath) : null;
  const mcp = mergeMcpServers(mcpExisting);
  if (mcp.error) {
    steps.push({
      file: ".mcp.json",
      action: "skip",
      detail: `left untouched (${mcp.error}) — add the "quilt" server by hand`,
      path: d.mcpJsonPath,
    });
  } else if (!mcp.changed) {
    steps.push({ file: ".mcp.json", action: "skip", detail: "quilt server already present", path: d.mcpJsonPath });
  } else {
    steps.push({
      file: ".mcp.json",
      action: d.hasMcpJson ? "update" : "create",
      detail: d.hasMcpJson ? "add the quilt MCP server" : "create with the quilt MCP server",
      content: mcp.content,
      path: d.mcpJsonPath,
    });
  }

  const mdExisting = d.hasClaudeMd ? safeRead(d.claudeMdPath) : null;
  const md = appendCoordination(mdExisting);
  if (!md.changed) {
    steps.push({ file: "CLAUDE.md", action: "skip", detail: "coordination snippet already present", path: d.claudeMdPath });
  } else {
    steps.push({
      file: "CLAUDE.md",
      action: d.hasClaudeMd ? "update" : "create",
      detail: d.hasClaudeMd ? "append the coordination snippet" : "create with the coordination snippet",
      content: md.content,
      path: d.claudeMdPath,
    });
  }

  return steps;
}

/** Apply a plan's create/update steps to disk. Returns the steps actually written. */
export function applySetup(steps: SetupStep[]): SetupStep[] {
  const written: SetupStep[] = [];
  for (const step of steps) {
    if (step.action === "skip" || step.content === undefined) continue;
    writeFileSync(step.path, step.content);
    written.push(step);
  }
  return written;
}
