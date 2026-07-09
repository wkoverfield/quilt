// Magical onboarding: detect the agent orchestrator in a repo and wire Quilt in
// as the shared MCP server, plus drop a coordination snippet into CLAUDE.md.
//
// Everything here is idempotent and non-destructive: existing config is parsed
// and merged, never clobbered. If a file can't be safely merged (e.g. malformed
// JSON), we leave it alone and tell the user what to add by hand.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The MCP server entry every agent in the fleet shares. */
export const QUILT_SERVER = { command: "quilt", args: ["mcp"] } as const;

/** The native Edit/Write/MultiEdit tools the capture hooks intercept. */
export const HOOK_MATCHER = "Edit|Write|MultiEdit";
export const HOOK_PRE_COMMAND = "quilt hook-pre";
export const HOOK_POST_COMMAND = "quilt hook-post";
/** Codex CLI's edit tool — one matcher, since every Codex edit is a patch. */
export const CODEX_HOOK_MATCHER = "apply_patch";

/** Codex's config directory (global — Codex hooks are per-user, not per-repo).
 * Overridable for tests so they never touch a real ~/.codex. */
export function codexDir(): string {
  return process.env.QUILT_CODEX_DIR || join(homedir(), ".codex");
}
export function codexHooksPath(): string {
  return join(codexDir(), "hooks.json");
}

/**
 * Versioned marker so the CLAUDE.md snippet is added at most once AND can be
 * refreshed in place when its content changes. The version bump is load-bearing:
 * a presence-only (unversioned) check meant a repo onboarded under an older
 * Quilt could never receive a rewritten snippet — `quilt setup` silently
 * no-opped forever, freezing whatever framing it first shipped with.
 * Bump the version whenever COORDINATION_BLOCK's content changes.
 */
export const COORDINATION_VERSION = 2;
export const COORDINATION_MARKER = `<!-- quilt:coordination v${COORDINATION_VERSION} -->`;
/** Closes the block so a future refresh can replace exactly the marked region. */
export const COORDINATION_END_MARKER = "<!-- /quilt:coordination -->";
/** Any generation of the start marker: legacy unversioned, or any vN. */
const COORDINATION_MARKER_ANY = /<!--\s*quilt:coordination(?:\s+v\d+)?\s*-->/;

/** The coordination instructions appended to CLAUDE.md.
 *
 * The automatic, zero-approval path (hooks + CLI) leads; the MCP claim tools
 * are framed as the optional prevention layer they are. The first external
 * fleet read the old MCP-first framing, found no quilt tools in their sessions
 * (the server was never approved), and concluded Quilt was unusable while the
 * hooks were capturing and protecting every edit underneath. */
export const COORDINATION_BLOCK = `${COORDINATION_MARKER}
## Coordinating with other agents (Quilt)

You share this checkout with other agents. Quilt protects your work
automatically:

- Your edits are captured and protected by the quilt hooks: nothing to
  approve, nothing to call. Identity is automatic (each session gets its own
  id), and every line you edit is attributed to you as you write it.
- To commit only your lines, run \`quilt commit --mine -m "<message>"\` from
  the shell. It works with or without the MCP server, and it leaves everyone
  else's uncommitted work untouched. \`quilt status\` shows who owns what.
- The quilt MCP tools (claim, commit_mine, get_status, ...) are an optional
  prevention layer, available when the quilt MCP server is connected and
  approved in your client. If the quilt tools are NOT in your MCP list you
  are still protected: capture and attribution run in the hooks. Just commit
  with the CLI.

Optional, when the quilt MCP tools are connected (CLI equivalents in
parentheses):

- Identity is automatic, but if you are one of SEVERAL subagents sharing one
  process or MCP connection, pick a stable id, your role or task name (e.g.
  \`auth-agent\`), and pass it as \`actor\` on every quilt call, since a
  shared connection cannot tell you apart automatically.
- CLAIM before editing when either applies: (a) you are editing via bash,
  scripts, or codegen (nothing captures those; a whole-file claim placed
  BEFORE the edit is what binds them to you, and attribution is edit-time,
  never retroactive), or (b) you want the code protected from other actors
  while you work. Claim WHOLE FILES (\`src/auth.ts\`) or a directory for
  codegen (\`convex/_generated/\`); use \`path#symbol\` only to share one
  file with another actor (pass \`creating: true\` if the symbol does not
  exist yet). Always pass a short intent, the why (your ticket/task); it is
  shown to anyone you block. (CLI: \`quilt claim <target> --intent "..."\`.)
- If your claim is denied, another agent holds that code and is mid-change. The
  response carries their holderIntent (what they are doing) and when their
  claim lapses. Use it instead of forcing your change through: if they are
  already doing your change, drop yours; if it is compatible, adapt around it
  (pass \`queue: true\` on the claim to be AUTO-GRANTED it when they release;
  don't block, keep working, and it lands in your next get_status; or \`wait\`
  to block until they release, then re-read and layer on top); if your goals
  are genuinely opposed (you each need the same line to be different things),
  do NOT overwrite them: escalate the target with a reason naming both
  intents, and move on. A human decides.
- When you reconcile a clash yourself (merge both intents, or adapt), resolve the
  target with a short note so the decision is recorded.
- The claim response may include \`dependencyWarnings\`: a function you depend on
  is being changed by another agent. Account for it.
- \`commit_mine\` (CLI: \`quilt commit --mine\`) commits only your lines,
  leaves everyone else's work untouched, and AUTO-RELEASES your claims on the
  committed files; no separate release call is needed.
- Repo-wide proof gates (tsc, tests) can fail mid-wave because of OTHER
  agents' in-flight work. Verify your own hunks' independence, or let the
  orchestrator run proof at wave end. Keep tooling artifacts (test snapshots,
  scratch output) gitignored: quilt follows git's view of the tree.
${COORDINATION_END_MARKER}`;

export interface Detected {
  mcpJsonPath: string;
  claudeMdPath: string;
  settingsPath: string;
  cursorMcpPath: string;
  agentsMdPath: string;
  hasMcpJson: boolean;
  hasClaudeMd: boolean;
  hasSettings: boolean;
  /** A `.cursor/` directory — wire Cursor's own MCP config too. */
  hasCursorDir: boolean;
  /** An `AGENTS.md` — Cursor/Codex-family agents read it, so the coordination
   * snippet goes there as well as CLAUDE.md. */
  hasAgentsMd: boolean;
  /** Signals a Claude Code / Cursor / generic agent setup is in use. */
  orchestrator: string | null;
  quiltWired: boolean;
  /** the CURRENT version of the coordination snippet is present. */
  coordinationPresent: boolean;
  /** a coordination snippet from an OLDER Quilt is present (refresh available). */
  coordinationStale: boolean;
  hooksWired: boolean;
  /** Codex CLI is installed on this machine (user-global ~/.codex exists). */
  codexPresent: boolean;
  /** the quilt apply_patch hooks are in ~/.codex/hooks.json. */
  codexWired: boolean;
}

/** Inspect a repo root for orchestrator config and whether Quilt is wired in. */
export function detect(root: string): Detected {
  const mcpJsonPath = join(root, ".mcp.json");
  const claudeMdPath = join(root, "CLAUDE.md");
  const settingsPath = join(root, ".claude", "settings.json");
  const cursorMcpPath = join(root, ".cursor", "mcp.json");
  const agentsMdPath = join(root, "AGENTS.md");
  const hasMcpJson = existsSync(mcpJsonPath);
  const hasClaudeMd = existsSync(claudeMdPath);
  const hasSettings = existsSync(settingsPath);
  const hasClaudeDir = existsSync(join(root, ".claude"));
  const hasCursorDir = existsSync(join(root, ".cursor"));
  const hasAgentsMd = existsSync(agentsMdPath);

  const orchestrator =
    hasClaudeDir || hasClaudeMd || hasMcpJson
      ? "Claude Code"
      : hasCursorDir
        ? "Cursor"
        : hasAgentsMd
          ? "agents (AGENTS.md)"
          : null;

  const quiltWired = hasMcpJson && mcpServersHasQuilt(safeRead(mcpJsonPath));
  const claudeMdContent = hasClaudeMd ? (safeRead(claudeMdPath) ?? "") : "";
  const coordinationPresent = claudeMdContent.includes(COORDINATION_MARKER);
  const coordinationStale = coordinationIsStale(claudeMdContent);
  const hooksWired = hasSettings && settingsHasQuiltHooks(safeRead(settingsPath));
  const codexPresent = existsSync(codexDir());
  const codexWired = codexPresent && codexHooksWiredIn(safeRead(codexHooksPath()));

  return {
    mcpJsonPath,
    claudeMdPath,
    settingsPath,
    cursorMcpPath,
    agentsMdPath,
    hasMcpJson,
    hasClaudeMd,
    hasSettings,
    hasCursorDir,
    hasAgentsMd,
    orchestrator,
    quiltWired,
    coordinationPresent,
    coordinationStale,
    hooksWired,
    codexPresent,
    codexWired,
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

/** Is the Codex hooks file already carrying both quilt capture hooks? */
function codexHooksWiredIn(content: string | null): boolean {
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
function ensureHookGroup(
  hooks: Record<string, unknown>,
  event: string,
  command: string,
  matcher: string = HOOK_MATCHER,
): boolean {
  if (hookGroupHas(hooks[event], command)) return false;
  const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  arr.push({ matcher, hooks: [{ type: "command", command }] });
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
 * Add the Quilt capture hooks to Codex's GLOBAL `~/.codex/hooks.json`
 * (matcher `apply_patch` on PreToolUse/PostToolUse). This file is shared with
 * whatever other hooks the user runs, so the merge is strictly additive and
 * refuses anything it can't merge safely — identical discipline to
 * mergeHookSettings, different matcher and file.
 *
 * Codex trust caveat (the honest part): Codex persists per-hook trust in
 * `~/.codex/config.toml` and SILENTLY SKIPS a newly added hook until the user
 * approves it in an interactive Codex session. Setup output and doctor both
 * say so — wired-but-unapproved must never read as working.
 */
export function mergeCodexHooks(existing: string | null): MergeResult {
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
  for (const event of ["PreToolUse", "PostToolUse"]) {
    if (hooksObj[event] !== undefined && !Array.isArray(hooksObj[event])) {
      return { content: existing ?? "", changed: false, error: `hooks.${event} is not an array` };
    }
  }
  let changed = ensureHookGroup(hooksObj, "PreToolUse", HOOK_PRE_COMMAND, CODEX_HOOK_MATCHER);
  changed = ensureHookGroup(hooksObj, "PostToolUse", HOOK_POST_COMMAND, CODEX_HOOK_MATCHER) || changed;
  if (!changed) return { content: existing ?? "", changed: false };
  obj.hooks = hooksObj;
  return { content: JSON.stringify(obj, null, 2) + "\n", changed: true };
}

/** Codex hook-trust state, read from `~/.codex/config.toml`: Codex records a
 * `[hooks.state."<file>:<event>:<group>:<hook>"]` entry per approved hook.
 * We locate our group's index in hooks.json and check for its entry. Returns
 * null when the wiring itself is absent (nothing to be trusted yet). */
export function codexHooksTrusted(): boolean | null {
  const hooksRaw = safeRead(codexHooksPath());
  if (!hooksRaw) return null;
  let parsed: { hooks?: Record<string, unknown> };
  try {
    parsed = JSON.parse(hooksRaw);
  } catch {
    return null;
  }
  const configRaw = safeRead(join(codexDir(), "config.toml")) ?? "";
  const eventKey: Record<string, string> = { PreToolUse: "pre_tool_use", PostToolUse: "post_tool_use" };
  for (const [event, key] of Object.entries(eventKey)) {
    const list = parsed.hooks?.[event];
    if (!Array.isArray(list)) return null;
    const idx = list.findIndex(
      (g) =>
        isPlainObject(g) &&
        Array.isArray(g.hooks) &&
        g.hooks.some((h) => isPlainObject(h) && (h.command === HOOK_PRE_COMMAND || h.command === HOOK_POST_COMMAND)),
    );
    if (idx === -1) return null; // not wired
    if (!configRaw.includes(`hooks.json:${key}:${idx}:`)) return false;
  }
  return true;
}

/**
 * Add or refresh the coordination snippet in CLAUDE.md. No-op when the CURRENT
 * version's marker is present; a block from an older Quilt (legacy unversioned
 * marker, or an older vN) is replaced in place, everything around it preserved.
 */
export function appendCoordination(existing: string | null): MergeResult {
  const base = existing ?? "";
  if (base.includes(COORDINATION_MARKER)) return { content: base, changed: false };
  const stale = base.match(COORDINATION_MARKER_ANY);
  if (stale && stale.index !== undefined) {
    const end = coordinationBlockEnd(base, stale.index);
    const tail = base.slice(end).replace(/^\n+/, "");
    const content = base.slice(0, stale.index) + COORDINATION_BLOCK + "\n" + (tail ? "\n" + tail : "");
    return { content, changed: true };
  }
  const sep = base === "" ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return { content: base + sep + COORDINATION_BLOCK + "\n", changed: true };
}

/** True when the file carries a coordination block from an OLDER Quilt. */
export function coordinationIsStale(content: string): boolean {
  return !content.includes(COORDINATION_MARKER) && COORDINATION_MARKER_ANY.test(content);
}

/**
 * The final line of every legacy (pre-v2, end-marker-less) block Quilt ever
 * shipped. The most precise boundary available: only quilt setup wrote these
 * blocks, so the real-world population is exactly these bodies. Each entry is
 * matched as a full block-final phrase (period included), which none of the
 * bodies contain mid-block.
 */
const LEGACY_BLOCK_TAILS = [
  // 0.4.x: "...scratch output) gitignored — quilt follows git's view of the tree."
  "quilt follows git's view of the tree.",
  // pre-0.4: "...It commits only your lines and leaves everyone else's work untouched."
  "leaves everyone else's work untouched.\n",
];

/**
 * The end offset of the coordination block starting at `start`. Blocks written
 * by v2+ carry an explicit end marker. Legacy blocks are bounded by their known
 * final line (see LEGACY_BLOCK_TAILS) — the precise cut, so user content added
 * after the block survives even when it isn't a `## ` heading. Fallbacks, in
 * order: the next `## ` heading after the block's own, then EOF (the block was
 * appended at EOF by setup, so EOF is the common real-world boundary anyway).
 */
function coordinationBlockEnd(text: string, start: number): number {
  const endIdx = text.indexOf(COORDINATION_END_MARKER, start);
  if (endIdx !== -1) return endIdx + COORDINATION_END_MARKER.length;
  // Earliest tail match wins, so a phrase echoed later in user content can
  // never widen the cut.
  const tailAt = LEGACY_BLOCK_TAILS.map((t) => text.indexOf(t, start)).filter((i) => i !== -1);
  if (tailAt.length > 0) {
    const lineEnd = text.indexOf("\n", Math.min(...tailAt));
    return lineEnd === -1 ? text.length : lineEnd + 1;
  }
  const ownHeading = text.indexOf("\n## ", start);
  if (ownHeading === -1) return text.length;
  const next = text.indexOf("\n## ", ownHeading + 4);
  return next === -1 ? text.length : next + 1; // keep the newline before the user's next heading
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
      detail: d.coordinationStale
        ? "refresh the coordination snippet to the current version"
        : d.hasClaudeMd
          ? "append the coordination snippet"
          : "create with the coordination snippet",
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

  // Cursor keeps its MCP config in .cursor/mcp.json (same mcpServers shape) and
  // doesn't read .mcp.json, so a repo with a .cursor/ dir gets both wired.
  if (d.hasCursorDir) {
    const cursorExisting = safeRead(d.cursorMcpPath);
    const cursor = mergeMcpServers(cursorExisting);
    if (cursor.error) {
      steps.push({
        file: ".cursor/mcp.json",
        action: "skip",
        detail: `left untouched (${cursor.error}) — add the "quilt" server by hand`,
        path: d.cursorMcpPath,
      });
    } else if (!cursor.changed) {
      steps.push({ file: ".cursor/mcp.json", action: "skip", detail: "quilt server already present", path: d.cursorMcpPath });
    } else {
      steps.push({
        file: ".cursor/mcp.json",
        action: cursorExisting !== null ? "update" : "create",
        detail: cursorExisting !== null ? "add the quilt MCP server (Cursor)" : "create with the quilt MCP server (Cursor)",
        content: cursor.content,
        path: d.cursorMcpPath,
      });
    }
  }

  // Cursor/Codex-family agents read AGENTS.md, not CLAUDE.md. Only append to an
  // AGENTS.md that already exists — creating one unprompted would change what
  // those tools load in a repo that never opted into it.
  if (d.hasAgentsMd) {
    const agents = appendCoordination(safeRead(d.agentsMdPath));
    if (!agents.changed) {
      steps.push({ file: "AGENTS.md", action: "skip", detail: "coordination snippet already present", path: d.agentsMdPath });
    } else {
      steps.push({
        file: "AGENTS.md",
        action: "update",
        detail: "append the coordination snippet",
        content: agents.content,
        path: d.agentsMdPath,
      });
    }
  }

  // Codex CLI: hooks live in the USER-GLOBAL ~/.codex/hooks.json, so this step
  // rides along whenever Codex is installed. Strictly additive merge — the file
  // is shared with the user's other Codex hooks and must never be stomped.
  if (d.codexPresent) {
    const codexExisting = safeRead(codexHooksPath());
    const codex = mergeCodexHooks(codexExisting);
    if (codex.error) {
      steps.push({
        file: "~/.codex/hooks.json",
        action: "skip",
        detail: `left untouched (${codex.error}) — add the quilt hooks by hand`,
        path: codexHooksPath(),
      });
    } else if (!codex.changed) {
      steps.push({ file: "~/.codex/hooks.json", action: "skip", detail: "capture hooks already present", path: codexHooksPath() });
    } else {
      steps.push({
        file: "~/.codex/hooks.json",
        action: codexExisting !== null ? "update" : "create",
        detail: "add the apply_patch capture hooks (Codex, user-global)",
        content: codex.content,
        path: codexHooksPath(),
      });
    }
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
