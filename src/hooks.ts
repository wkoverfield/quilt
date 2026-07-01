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
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { anchorForEdit, checkHeldEdit, checkHeldWrite, recordAuthorship, type EditDenied } from "./authorship.js";
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
  return { tool, path, edits, content };
}

/** Guard an actor-controlled path against escaping the repo or being a symlink.
 * path.resolve is purely lexical, so a repo-internal symlink would otherwise let
 * readBefore follow it to an out-of-repo target and capture its content — mirror
 * the lstat guard authorship.ts applies. */
function safeAbs(store: Store, path: string): string | null {
  const root = resolve(store.paths.repoRoot);
  const abs = resolve(root, path);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  try {
    if (lstatSync(abs).isSymbolicLink()) return null;
  } catch {
    /* file doesn't exist yet — fine for a create */
  }
  return abs;
}

function snapshotKey(actor: string, path: string): string {
  return createHash("sha256").update(`${actor}\0${path}`).digest("hex").slice(0, 32);
}

function snapshotPath(store: Store, actor: string, path: string): string {
  return store.paths.hookSnapshot(snapshotKey(actor, path));
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
 * PreToolUse: snapshot the file's pre-edit content for the Post hook, and run the
 * prevention claim-check. Denies (blocks the tool) when another actor holds the
 * code the write would touch, handing back their intent so the agent can resolve
 * in-band. A no-op allow when there's no path or no edit payload.
 */
export function runHookPre(store: Store, actor: string, input: HookInput): HookPreDecision {
  if (!input.path) return { deny: false };
  const abs = safeAbs(store, input.path);
  if (!abs) return { deny: false }; // outside the repo — not Quilt's to police
  const before = readBefore(abs);

  let denied: EditDenied | null = null;
  if (input.content !== null && input.edits.length === 0) {
    // Whole-file Write (existing content is null for a not-yet-created file).
    denied = checkHeldWrite(store, actor, input.path, input.content, existsSync(abs) ? before : null);
  } else {
    // Edit / MultiEdit — any held edit denies the whole call.
    for (const e of input.edits) {
      denied = checkHeldEdit(store, actor, input.path, before, e.oldString);
      if (denied) break;
    }
  }
  if (denied) {
    return {
      deny: true,
      reason:
        `Quilt: ${input.path} is held by ${denied.heldBy}` +
        (denied.holderIntent ? ` (${denied.holderIntent})` : "") +
        `. They are mid-change. If they're already doing your change, drop yours; ` +
        `if it's compatible, adapt around it; if your goals are genuinely opposed, ` +
        `escalate instead of overwriting.`,
    };
  }

  // Allowed → stash the before-image so Post can compute the real delta. Only
  // when there's actually a payload to capture: an unrecognized tool (or a
  // widened matcher) yields no edits and null content, and must not leave a
  // snapshot that Post would turn into a zero-delta event.
  if (input.content !== null || input.edits.length > 0) {
    mkdirSync(store.paths.hookSnapshotsDir, { recursive: true });
    writeFileSync(snapshotPath(store, actor, input.path), before);
  }
  return { deny: false };
}

/** Replay the edit payload against the pre-image IN MEMORY, mirroring what the
 * native tool wrote — the first occurrence of each old_string, applied in order.
 * Reconstructing `after` this way (rather than re-reading the written file) is
 * what makes capture race-free: a sibling's concurrent write to the same file
 * can't leak into this actor's recorded delta. */
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
export function runHookPost(store: Store, actor: string, input: HookInput): void {
  if (!input.path) return;
  if (!safeAbs(store, input.path)) return;
  const snap = snapshotPath(store, actor, input.path);
  if (!existsSync(snap)) return; // nothing captured for this call
  const before = readFileSync(snap, "utf8");

  if (input.content !== null && input.edits.length === 0) {
    // Whole-file write — mirror applyAndRecordWrite exactly: whole:true treats the
    // content as fresh (added = every line, removed = none), so oldText is ignored.
    // Passing "" keeps both capture paths recording overwrites identically.
    recordAuthorship(store, { actor, path: input.path, oldText: "", newText: input.content, whole: true });
  } else {
    // Edit / MultiEdit — diff the pre-image against the in-memory post-image, so
    // adds/removes are whole lines matching how ownership is keyed. Anchor only
    // for a single edit (unambiguous location); MultiEdit leaves it null.
    const after = replayEdits(before, input.edits);
    const only = input.edits.length === 1 ? input.edits[0] : undefined;
    const anchor = only ? anchorForEdit(before, only.oldString) : null;
    recordAuthorship(store, { actor, path: input.path, oldText: before, newText: after, anchor });
  }
  rmSync(snap, { force: true });
}
