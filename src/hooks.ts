// Native-tool capture: a Pre/Post Claude-Code hook pair that gives agents
// capture + prevention on the built-in Edit / Write / MultiEdit tools with ZERO
// protocol. Agents edit normally; Quilt records who authored which lines and
// denies writes into code another actor holds. The MCP quilt_edit / quilt_write
// tools stay the fallback for runtimes without hooks.
//
// Why a PAIR of hooks: a PostToolUse hook has the edit payload but not the file's
// pre-edit content, so it can't compute the full-line delta that ownership keys
// on (it would only see the old_string/new_string fragments). So:
//   - PreToolUse snapshots the `before` content AND runs the claim check (deny a
//     write into held code — prevention at the earliest point, before any bytes
//     change).
//   - PostToolUse diffs that snapshot against the now-written file to get the
//     real delta, and appends the authorship event.
// The snapshot is keyed by actor+path, which is race-free: one agent runs its
// tool calls sequentially (Pre → write → Post), and two agents editing the same
// file get different keys, so neither reads the other's snapshot.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  adoptClaimHolder,
  anchorForEdit,
  checkHeldEdit,
  checkHeldWrite,
  recordAuthorship,
  safeAbs,
  touchedByEdit,
  touchedByWrite,
  type EditDenied,
} from "./authorship.js";
import { refreshClaims } from "./claims.js";
import { repoRelative } from "./paths.js";
import type { Store } from "./state.js";

/** One old→new replacement (Edit = one; MultiEdit = many). */
export interface HookEdit {
  oldString: string;
  newString: string;
}

/** A hook payload normalized across Edit / Write / MultiEdit and field spellings. */
export interface HookInput {
  tool: string;
  /** repo-relative or absolute file path from tool_input.file_path. */
  path: string | null;
  /** present for Edit / MultiEdit. */
  edits: HookEdit[];
  /** present for Write (whole-file content). */
  content: string | null;
  /** Claude Code session id — the auto-identity fallback when QUILT_ACTOR is unset. */
  sessionId: string | null;
  /** Subagent instance id — present ONLY when the hook fired inside a subagent
   * (Task tool). All subagents share the parent's session_id, so this is the
   * one signal that tells parallel subagents of one session apart. */
  agentId: string | null;
  /** Subagent type (e.g. "code-reviewer") — a readable prefix for the auto id. */
  agentType: string | null;
  invocationId?: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Normalize the raw Claude-Code hook JSON into a HookInput. Accepts both field
 * spellings — the current tool schema uses `old_string`/`new_string`/`content`,
 * but we also accept `old_str`/`new_str`/`file_text` so a schema rename can't
 * silently turn capture into a no-op. Returns null if there's no usable payload.
 */
export function parseHookInput(raw: unknown): HookInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const tool = str(o.tool_name);
  if (!tool) return null;
  const input = (o.tool_input ?? {}) as Record<string, unknown>;
  const path = str(input.file_path);

  const oneEdit = (e: Record<string, unknown>): HookEdit | null => {
    const oldString = str(e.old_string) ?? str(e.old_str);
    const newString = str(e.new_string) ?? str(e.new_str);
    if (oldString === null || newString === null) return null;
    return { oldString, newString };
  };

  const edits: HookEdit[] = [];
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (typeof e === "object" && e !== null) {
        const parsed = oneEdit(e as Record<string, unknown>);
        if (parsed) edits.push(parsed);
      }
    }
  } else {
    const single = oneEdit(input);
    if (single) edits.push(single);
  }

  const content = str(input.content) ?? str(input.file_text);
  const sessionId = str(o.session_id);
  const agentId = str(o.agent_id);
  const agentType = str(o.agent_type);
  const suppliedInvocation = str(o.tool_use_id) ?? str(o.tool_call_id) ?? str(o.hook_event_id);
  const invocationId = suppliedInvocation ?? createHash("sha256")
    .update(JSON.stringify({ tool, path, edits, content }))
    .digest("hex")
    .slice(0, 16);
  const normalized: HookInput = { tool, path, edits, content, sessionId, agentId, agentType };
  // Internal transaction metadata; keep the long-standing normalized payload
  // JSON shape stable for API consumers.
  Object.defineProperty(normalized, "invocationId", { value: invocationId, enumerable: false });
  return normalized;
}

/**
 * Derive a per-session auto actor id from a Claude Code session id, so capture
 * flows with ZERO config: no QUILT_ACTOR, no instructions. Parallel sessions get
 * distinct ids for free (each session has its own id). The trade-off is
 * continuity — a new session on the same task is a new actor — so QUILT_ACTOR
 * stays the way to pin a stable id, and always wins over this fallback.
 */
export function sessionActorId(sessionId: string): string | null {
  const clean = sessionId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!clean) return null;
  return `claude-${clean.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Codex: native capture for OpenAI Codex CLI's apply_patch tool.
//
// Codex's tool boundary differs from Claude Code's in two structural ways: the
// edit payload is ONE raw apply_patch envelope (not per-file old/new strings),
// and one call can touch MANY files. So the Codex path parses the FILE LIST
// out of the envelope and runs the same snapshot-on-Pre / diff-on-Post capture
// core per file. Hunks are never interpreted: Post diffs the Pre snapshot
// against the file on disk, which also makes a FAILED patch (apply_patch
// verification rejects and touches nothing) a natural no-op — empty delta,
// nothing recorded. Envelope trade-off vs the Claude path: Post reads the
// written file from disk rather than replaying the payload in memory, so a
// sibling's concurrent write to the same file between Pre and Post could ride
// into this actor's delta. Ground-truth payload samples live in
// docs/codex-payload-samples/.
// ---------------------------------------------------------------------------

/** One file's change parsed out of an apply_patch envelope. */
export interface CodexPatchFile {
  path: string;
  kind: "update" | "add" | "delete";
  /** for a rename: `*** Move to:` following an Update section. */
  movePath?: string;
}

/** A normalized Codex hook payload. */
export interface CodexHookInput {
  files: CodexPatchFile[];
  sessionId: string | null;
  /** the Codex session's working directory — blob paths are relative to it. */
  cwd: string | null;
  invocationId: string;
}

const PATCH_MARKER = "*** Begin Patch";

/** Extract the file sections from an apply_patch blob. Line-anchored scan of
 * the `*** Update/Add/Delete File:` markers; hunk bodies are skipped. */
export function parseApplyPatchFiles(blob: string): CodexPatchFile[] {
  const files: CodexPatchFile[] = [];
  const lines = blob.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (!m) continue;
    const entry: CodexPatchFile = {
      path: m[2]!.trim(),
      kind: m[1]!.toLowerCase() as CodexPatchFile["kind"],
    };
    const move = lines[i + 1]?.match(/^\*\*\* Move to: (.+)$/);
    if (move) entry.movePath = move[1]!.trim();
    files.push(entry);
  }
  return files;
}

/**
 * Recognize and normalize a Codex apply_patch hook payload, or null when the
 * payload isn't one (the caller then tries the Claude Code parser). Detection
 * keys on the PATCH ENVELOPE ITSELF — any string field of tool_input carrying
 * `*** Begin Patch` — rather than only on tool_name, so a schema rename or a
 * shell-wrapped apply_patch can't silently disable capture.
 */
export function parseCodexHookInput(raw: unknown): CodexHookInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const input = (o.tool_input ?? {}) as Record<string, unknown>;
  // A Claude-shaped payload (tool_input.file_path) is never a Codex patch,
  // even when its CONTENT happens to contain a patch envelope — an agent
  // Writing documentation about apply_patch must not be routed here and have
  // the marker text parsed as real file sections.
  if (typeof input.file_path === "string") return null;
  let blob: string | null = null;
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.includes(PATCH_MARKER)) {
      blob = v;
      break;
    }
  }
  if (blob === null) return null;
  const files = parseApplyPatchFiles(blob);
  if (files.length === 0) return null;
  return {
    files,
    sessionId: str(o.session_id),
    cwd: str(o.cwd),
    invocationId:
      str(o.tool_use_id) ??
      str(o.tool_call_id) ??
      createHash("sha256").update(blob).digest("hex").slice(0, 16),
  };
}

/** The Codex sibling of sessionActorId: `codex-<8 chars of the session id>`. */
export function codexActorId(sessionId: string): string | null {
  const clean = sessionId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!clean) return null;
  return `codex-${clean.slice(0, 8)}`;
}

/** A store-relative file entry for the Codex capture core. `moveRel` pairs a
 * rename's destination with its source so a move is captured as ONE file whose
 * key changed, not as an unrelated full delete + full add. */
export interface CodexCaptureFile {
  rel: string;
  moveRel?: string;
}

/**
 * Codex PreToolUse: snapshot each file's pre-patch content so Post can diff.
 * Capture only — no prevention: Codex has its own permission model, and deny
 * parity is a separate, later effort (verify Codex's deny schema first).
 * `files` carry store-relative paths (the caller resolves blob paths against
 * the payload's cwd and each file's own repo). For a rename, the SOURCE path
 * is snapshotted; the destination doesn't exist yet.
 */
export function runCodexHookPre(store: Store, actor: string, files: CodexCaptureFile[], invocationId = "legacy"): void {
  for (const f of files) {
    const abs = safeAbs(store.paths.repoRoot, f.rel);
    if (!abs) continue;
    mkdirSync(store.paths.hookSnapshotsDir, { recursive: true });
    writeFileSync(snapshotPath(store, actor, f.rel, invocationId), readBefore(abs));
  }
}

/**
 * Codex PostToolUse: per file, diff the Pre snapshot against what's on disk
 * now and record authorship. A failed patch leaves the disk identical to the
 * snapshot — empty delta, nothing recorded — so tool_response parsing isn't
 * needed for correctness. Consumes the snapshots.
 *
 * Renames are the attribution-sensitive case: recording a move as a full
 * delete at the old path plus a full ADD at the new path would hand the mover
 * ownership of every line in the file — including other actors' uncommitted
 * work riding along in the move. Instead a rename records (a) the REMOVAL of
 * the old path's lines (the mover really did remove that path), and (b) at
 * the new path, only the lines the mover genuinely CHANGED during the move
 * (old content diffed against new content under the new key). Unchanged moved
 * lines stay unowned in the ledger and fall to the normal inference floor —
 * no ledger answer beats a wrong ledger answer.
 */
export function runCodexHookPost(store: Store, actor: string, files: CodexCaptureFile[], invocationId = "legacy"): void {
  for (const f of files) {
    const snap = snapshotPath(store, actor, f.rel, invocationId);
    if (!existsSync(snap)) continue;
    const before = readFileSync(snap, "utf8");
    const abs = safeAbs(store.paths.repoRoot, f.rel);
    if (!abs) {
      rmSync(snap, { force: true });
      continue;
    }
    const oldGone = !existsSync(abs);
    const destAbs = f.moveRel ? safeAbs(store.paths.repoRoot, f.moveRel) : null;
    if (f.moveRel && destAbs && oldGone && existsSync(destAbs)) {
      // The rename actually happened: removal at the source...
      if (before !== "") {
        recordAuthorship(store, { actor, path: f.rel, oldText: before, newText: "", anchor: null });
      }
      // ...and at the destination, only what genuinely changed in transit.
      const moved = readFileSync(destAbs, "utf8");
      if (moved !== before) {
        recordAuthorship(store, { actor, path: f.moveRel, oldText: before, newText: moved, anchor: null });
        refreshClaims(store, actor, f.moveRel, Date.now());
      }
      refreshClaims(store, actor, f.rel, Date.now());
      rmSync(snap, { force: true });
      continue;
    }
    const after = readBefore(abs); // "" when the patch deleted the file
    if (after !== before) {
      recordAuthorship(store, { actor, path: f.rel, oldText: before, newText: after, anchor: null });
      refreshClaims(store, actor, f.rel, Date.now());
    }
    rmSync(snap, { force: true });
  }
}

/**
 * A per-SUBAGENT auto id from the hook payload's agent_id/agent_type. All
 * subagents of a session share its session_id, so without this every parallel
 * subagent would collapse into ONE session-derived actor and their work would
 * merge — the misattribution the pilot hit. `code-reviewer-f7e8d9c0` reads in
 * the fleet; a typeless subagent falls back to `agent-<id>`.
 */
export function agentActorId(agentId: string, agentType: string | null): string | null {
  const id = agentId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (!id) return null;
  const type = agentType
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${type || "agent"}-${id}`;
}

function snapshotKey(actor: string, path: string, invocationId: string): string {
  // 128 bits of sha256 — ample to avoid collisions for a transient scratch file.
  return createHash("sha256").update(`${actor}\0${invocationId}\0${path}`).digest("hex").slice(0, 32);
}

function snapshotPath(store: Store, actor: string, path: string, invocationId: string): string {
  return store.paths.hookSnapshot(snapshotKey(actor, path, invocationId));
}

/** The pre-write content of a path (empty string for a not-yet-created file). */
function readBefore(abs: string): string {
  return existsSync(abs) ? readFileSync(abs, "utf8") : "";
}

export interface HookPreDecision {
  /** true → the native tool call is blocked. */
  deny: boolean;
  reason?: string;
}

/**
 * The symbols an entire hook payload touches, and the actor the call should act
 * as: the raw caller for an explicit identity, or — for an auto-derived id —
 * the sole claim holder of the touched code (adoption; see adoptClaimHolder).
 * Shared by Pre and Post so they resolve the SAME actor for one tool call: Post
 * recomputes from the snapshot's `before`, which is byte-identical to what Pre
 * used, and adoption is deterministic given the same claims.
 */
function effectiveActor(
  store: Store,
  actor: string,
  autoActor: boolean,
  rel: string,
  before: string,
  existing: boolean,
  input: HookInput,
): string {
  if (!autoActor) return actor;
  const touched =
    input.content !== null && input.edits.length === 0
      ? touchedByWrite(rel, input.content, existing ? before : null)
      : input.edits.flatMap((e) => touchedByEdit(rel, before, e.oldString));
  return adoptClaimHolder(store, actor, rel, touched);
}

/**
 * PreToolUse: snapshot the file's pre-edit content for the Post hook, and run the
 * prevention claim-check. Denies (blocks the tool) when another actor holds the
 * code the write would touch, handing back their intent so the agent can resolve
 * in-band. A no-op allow when there's no path or no edit payload.
 * `autoActor` marks a derived identity, enabling claim adoption.
 */
export function runHookPre(
  store: Store,
  actor: string,
  input: HookInput,
  autoActor = false,
): HookPreDecision {
  if (!input.path) return { deny: false };
  // Claude Code sends an ABSOLUTE file_path — normalize to the repo-relative
  // form every store keys on, or nothing (claims, ownership, the ledger) would
  // ever match and both prevention and capture would silently no-op.
  const rel = repoRelative(store.paths.repoRoot, input.path);
  if (!rel) return { deny: false }; // outside the repo — not Quilt's to police
  const abs = safeAbs(store.paths.repoRoot, rel);
  if (!abs) return { deny: false }; // a symlink — never write through it
  const before = readBefore(abs);
  const asActor = effectiveActor(store, actor, autoActor, rel, before, existsSync(abs), input);

  let denied: EditDenied | null = null;
  if (input.content !== null && input.edits.length === 0) {
    // Whole-file Write (existing content is null for a not-yet-created file).
    denied = checkHeldWrite(store, asActor, rel, input.content, existsSync(abs) ? before : null);
  } else {
    // Edit / MultiEdit — any held edit denies the whole call.
    for (const e of input.edits) {
      denied = checkHeldEdit(store, asActor, rel, before, e.oldString);
      if (denied) break;
    }
  }
  if (denied) {
    return {
      deny: true,
      reason:
        `Quilt: ${denied.target ?? rel} is held by ${denied.heldBy}` +
        (denied.holderIntent ? ` (${denied.holderIntent})` : "") +
        `. They are mid-change. If they're already doing your change, drop yours; ` +
        `if it's compatible, adapt around it; if your goals are genuinely opposed, ` +
        `escalate instead of overwriting.`,
    };
  }

  // Allowed → stash the before-image so Post can compute the real delta. Only
  // when there's actually a payload to capture: an unrecognized tool (or a
  // widened matcher) yields no edits and null content, and must not leave a
  // snapshot that Post would turn into a zero-delta event. Keyed on the
  // normalized path so Pre and Post agree however the payload spelled it.
  if (input.content !== null || input.edits.length > 0) {
    mkdirSync(store.paths.hookSnapshotsDir, { recursive: true });
    writeFileSync(snapshotPath(store, actor, rel, input.invocationId ?? "legacy"), before);
  }
  return { deny: false };
}

/** Replay the edit payload against the pre-image IN MEMORY, mirroring what the
 * native tool wrote — the first occurrence of each old_string, applied in order.
 * This matches Claude Code's own Edit/MultiEdit semantics (first occurrence, and
 * a non-unique old_string is rejected before the hook fires), so the location we
 * find here is the one the tool actually changed. Reconstructing `after` this way
 * (rather than re-reading the written file) is what makes capture race-free: a
 * sibling's concurrent write to the same file can't leak into this actor's
 * recorded delta. */
function replayEdits(before: string, edits: HookEdit[]): string {
  let after = before;
  for (const e of edits) {
    const idx = after.indexOf(e.oldString);
    if (idx === -1) continue; // couldn't locate — skip, don't fabricate a change
    after = after.slice(0, idx) + e.newString + after.slice(idx + e.oldString.length);
  }
  return after;
}

/**
 * PostToolUse: read the stashed pre-image, reconstruct the post-image in memory
 * from the edit payload, compute the full before→after delta, and append the
 * authorship event. No-op if there's no snapshot (Pre didn't run, or the write
 * was denied). Consumes the snapshot so it can't be reused.
 */
export function runHookPost(store: Store, actor: string, input: HookInput, autoActor = false): void {
  if (!input.path) return;
  // Same normalization as Pre: the ledger keys events by repo-relative path, so
  // an absolute payload path recorded verbatim would never match reconcile's
  // view of the working tree and the capture would be dead weight.
  const rel = repoRelative(store.paths.repoRoot, input.path);
  if (!rel || !safeAbs(store.paths.repoRoot, rel)) return;
  // The snapshot is keyed by the RAW caller id — stable across the Pre/Post of
  // one tool call regardless of adoption (which is re-derived below from the
  // same `before` bytes Pre saw).
  const snap = snapshotPath(store, actor, rel, input.invocationId ?? "legacy");
  if (!existsSync(snap)) return; // nothing captured for this call
  const before = readFileSync(snap, "utf8");
  const asActor = effectiveActor(store, actor, autoActor, rel, before, before !== "", input);

  if (input.content !== null && input.edits.length === 0) {
    // Whole-file write — mirror applyAndRecordWrite exactly: whole:true treats the
    // content as fresh (added = every line, removed = none), so oldText is ignored.
    // Passing "" keeps both capture paths recording overwrites identically.
    recordAuthorship(store, { actor: asActor, path: rel, oldText: "", newText: input.content, whole: true });
  } else {
    // Edit / MultiEdit — diff the pre-image against the in-memory post-image, so
    // adds/removes are whole lines matching how ownership is keyed. Anchor only
    // for a single edit (unambiguous location); MultiEdit leaves it null.
    const after = replayEdits(before, input.edits);
    const only = input.edits.length === 1 ? input.edits[0] : undefined;
    const anchor = only ? anchorForEdit(before, only.oldString) : null;
    recordAuthorship(store, { actor: asActor, path: rel, oldText: before, newText: after, anchor });
  }
  // Editing is proof of life: keep the effective actor's reservation on this
  // file fresh so a long work session can't silently outlive its claim.
  refreshClaims(store, asActor, rel, Date.now());
  rmSync(snap, { force: true });
}
