// Magical onboarding: detect the agent orchestrator in a repo and wire Quilt in
// as the shared MCP server, plus drop a coordination snippet into CLAUDE.md.
//
// Everything here is idempotent and non-destructive: existing config is parsed
// and merged, never clobbered. If a file can't be safely merged (e.g. malformed
// JSON), we leave it alone and tell the user what to add by hand.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The MCP server entry every agent in the fleet shares. */
export const QUILT_SERVER = { command: "quilt", args: ["mcp"] } as const;

/** The native Edit/Write/MultiEdit tools the capture hooks intercept. */
export const HOOK_MATCHER = "Edit|Write|MultiEdit";
export const HOOK_PRE_COMMAND = "quilt hook-pre";
export const HOOK_POST_COMMAND = "quilt hook-post";

/** Marker so the CLAUDE.md snippet is added at most once. */
export const COORDINATION_MARKER = "<!-- quilt:coordination -->";

/** The coordination instructions appended to CLAUDE.md. */
export const COORDINATION_BLOCK = `${COORDINATION_MARKER}
## Coordinating with other agents (Quilt)

You share this checkout with other agents. Coordinate through Quilt:

- Pick a stable id for yourself — your role or task name (e.g. \`auth-agent\`).
  Use that exact id as \`actor\` on every Quilt call.
- Before you edit a file, \`claim\` what you're about to change
  (\`path#symbol\`, e.g. \`src/auth.ts#login\`). Pass a short
  intent too — the why (your ticket/task) — which is shown to anyone you block.
- If your claim is denied, another agent holds that code and is mid-change. The
  response carries their holderIntent (what they are doing). Use it instead of
  forcing your change through: if they are already doing your change, drop yours;
  if it is compatible, adapt around it; if your goals are genuinely opposed (you
  each need the same line to be different things), do NOT overwrite them —
  escalate the target with a reason naming both intents, and move on. A human
  decides.
- When you reconcile a clash yourself (merge both intents, or adapt), resolve the
  target with a short note so the decision is recorded.
- The claim response may include \`dependencyWarnings\`: a function you depend on
  is being changed by another agent. Account for it.
- When your change is ready, \`commit_mine\` with your id. It commits only your
  lines and leaves everyone else's work untouched.`;

export interface Detected {
  mcpJsonPath: string;
  claudeMdPath: string;
  settingsPath: string;
  hasMcpJson: boolean;
  hasClaudeMd: boolean;
  hasSettings: boolean;
  /** Signals a Claude Code / Cursor / generic agent setup is in use. */
  orchestrator: string | null;
  quiltWired: boolean;
  coordinationPresent: boolean;
  hooksWired: boolean;
}

/** Inspect a repo root for orchestrator config and whether Quilt is wired in. */
export function detect(root: string): Detected {
  const mcpJsonPath = join(root, ".mcp.json");
  const claudeMdPath = join(root, "CLAUDE.md");
  const settingsPath = join(root, ".claude", "settings.json");
  const hasMcpJson = existsSync(mcpJsonPath);
  const hasClaudeMd = existsSync(claudeMdPath);
  const hasSettings = existsSync(settingsPath);
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
  const hooksWired = hasSettings && settingsHasQuiltHooks(safeRead(settingsPath));

  return {
    mcpJsonPath,
    claudeMdPath,
    settingsPath,
    hasMcpJson,
    hasClaudeMd,
    hasSettings,
    orchestrator,
    quiltWired,
    coordinationPresent,
    hooksWired,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

/** Does a hook event's array already contain a group running `command`? */
function hookGroupHas(list: unknown, command: string): boolean {
  if (!Array.isArray(list)) return false;
  for (const group of list) {
    const hooks = isPlainObject(group) ? group.hooks : undefined;
    if (Array.isArray(hooks)) {
      for (const h of hooks) if (isPlainObject(h) && h.command === command) return true;
    }
  }
  return false;
}

function settingsHasQuiltHooks(content: string | null): boolean {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content);
    const hooks = isPlainObject(parsed) ? parsed.hooks : undefined;
    if (!isPlainObject(hooks)) return false;
    return hookGroupHas(hooks.PreToolUse, HOOK_PRE_COMMAND) && hookGroupHas(hooks.PostToolUse, HOOK_POST_COMMAND);
  } catch {
    return false;
  }
}

/** Ensure a hook event array holds a group running `command`; returns true if it added one. */
function ensureHookGroup(hooks: Record<string, unknown>, event: string, command: string): boolean {
  if (hookGroupHas(hooks[event], command)) return false;
  const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  arr.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command }] });
  hooks[event] = arr;
  return true;
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
  if (!isPlainObject(parsed)) {
    return { content: existing, changed: false, error: "not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const servers = obj.mcpServers;
  // Refuse to touch a file whose mcpServers isn't an object — assigning to a
  // string/number throws, and an array would silently drop our entry.
  if (servers !== undefined && !isPlainObject(servers)) {
    return { content: existing, changed: false, error: "mcpServers is not an object" };
  }
  const map = (servers as Record<string, unknown> | undefined) ?? {};
  if (map.quilt) return { content: existing, changed: false };
  map.quilt = { ...QUILT_SERVER };
  obj.mcpServers = map;
  return { content: JSON.stringify(obj, null, 2) + "\n", changed: true };
}

/**
 * Add the Quilt capture hooks (PreToolUse + PostToolUse on Edit/Write/MultiEdit)
 * to a `.claude/settings.json`. Creates the content if absent, no-ops if both
 * hooks are already present, and refuses to touch a file that isn't valid JSON
 * or whose `hooks` shape can't be safely merged (returns an error, unchanged).
 */
export function mergeHookSettings(existing: string | null): MergeResult {
  let parsed: unknown = {};
  if (existing !== null && existing.trim() !== "") {
    try {
      parsed = JSON.parse(existing);
    } catch {
      return { content: existing, changed: false, error: "not valid JSON" };
    }
    if (!isPlainObject(parsed)) {
      return { content: existing, changed: false, error: "not a JSON object" };
    }
  }
  const obj = parsed as Record<string, unknown>;
  const hooks = obj.hooks;
  if (hooks !== undefined && !isPlainObject(hooks)) {
    return { content: existing ?? "", changed: false, error: "hooks is not an object" };
  }
  const hooksObj = (hooks as Record<string, unknown> | undefined) ?? {};
  // A pre-existing event value that isn't an array can't be merged safely.
  for (const event of ["PreToolUse", "PostToolUse"]) {
    if (hooksObj[event] !== undefined && !Array.isArray(hooksObj[event])) {
      return { content: existing ?? "", changed: false, error: `hooks.${event} is not an array` };
    }
  }
  let changed = ensureHookGroup(hooksObj, "PreToolUse", HOOK_PRE_COMMAND);
  changed = ensureHookGroup(hooksObj, "PostToolUse", HOOK_POST_COMMAND) || changed;
  if (!changed) return { content: existing ?? "", changed: false };
  obj.hooks = hooksObj;
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

  const settingsExisting = d.hasSettings ? safeRead(d.settingsPath) : null;
  const hooks = mergeHookSettings(settingsExisting);
  if (hooks.error) {
    steps.push({
      file: ".claude/settings.json",
      action: "skip",
      detail: `left untouched (${hooks.error}) — add the quilt hooks by hand`,
      path: d.settingsPath,
    });
  } else if (!hooks.changed) {
    steps.push({ file: ".claude/settings.json", action: "skip", detail: "capture hooks already present", path: d.settingsPath });
  } else {
    steps.push({
      file: ".claude/settings.json",
      action: d.hasSettings ? "update" : "create",
      detail: d.hasSettings ? "add the Edit/Write capture hooks" : "create with the Edit/Write capture hooks",
      content: hooks.content,
      path: d.settingsPath,
    });
  }

  return steps;
}

/** Apply a plan's create/update steps to disk. Returns the steps actually written. */
export function applySetup(steps: SetupStep[]): SetupStep[] {
  const written: SetupStep[] = [];
  for (const step of steps) {
    if (step.action === "skip" || step.content === undefined) continue;
    mkdirSync(dirname(step.path), { recursive: true }); // .claude/ may not exist yet
    writeFileSync(step.path, step.content);
    written.push(step);
  }
  return written;
}
