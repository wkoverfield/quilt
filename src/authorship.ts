// The authorship ledger — capture who authored which lines AT THE EDIT.
//
// The core insight (see design/authorship-capture.md): the OS records that bytes
// changed, never which agent changed them. So instead of inferring authorship
// later from reconcile timing (lossy, races), we record it the instant an edit
// happens, from the tool-call payload (old -> new), which carries the actor's
// identity and brackets the exact byte change. Each edit appends one immutable
// event; ownership is a replay of the log. This is the v0.3 substrate.
import { appendFileSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { lineDiff } from "./diff.js";
import { parseSymbols, ownKey, symbolLocator } from "./symbols.js";
import { claimHeldByOther } from "./claims.js";
import type { Store } from "./state.js";

/** A denial: another actor holds the code this edit would touch. */
export interface EditDenied {
  ok: false;
  error: string;
  /** the actor holding the conflicting claim, and their stated why. */
  heldBy: string;
  holderIntent?: string;
}

/**
 * Resolve a repo-relative path to an absolute one, refusing anything that escapes
 * the repo (`../` traversal, absolute paths) or is a symlink — `path` is actor-
 * controlled, so a write must never land outside the working tree. Mirrors the
 * guard claims.ts/engine.ts apply to reads. Returns null if disallowed. Shared
 * with the native-edit hooks (hooks.ts) so both apply the identical guard.
 */
export function safeAbs(repoRoot: string, relPath: string): string | null {
  const root = resolve(repoRoot);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  try {
    if (lstatSync(abs).isSymbolicLink()) return null; // never write through a symlink
  } catch {
    /* file doesn't exist yet — fine for a create */
  }
  return abs;
}

export interface AuthorshipEvent {
  /** monotonic per-repo sequence (append order). */
  seq: number;
  ts: string;
  actor: string;
  path: string;
  /** genuinely-new lines this actor introduced (old -> new diff). */
  added: string[];
  /** lines this edit removed. */
  removed: string[];
  /** ownership keys (symbol scope + text) for the added lines, so identical text
   * in different symbols doesn't collapse to one owner. Parallel to `added`.
   * Absent on pre-symbol-keying events; the fold falls back to a bare-text key. */
  addedKeys?: string[];
  /** ownership keys for the removed lines — the fold deletes these, so a captured
   * removal drops the line's ownership (and lets compaction prune it). */
  removedKeys?: string[];
  /** a context line just before the change, for positional replay. */
  anchor: string | null;
  /** sha256 of the pre-image region — the prevention primitive (phase 3). */
  preHash: string | null;
  /** the agent's stated "why" for this edit. */
  intent?: string;
  /** true for a whole-file write/create. */
  whole?: boolean;
}

/** The symbol names an edit touches, then whether another actor holds any of them. */
function checkHeld(
  store: Store,
  actor: string,
  path: string,
  before: string,
  idx: number,
  oldString: string,
): EditDenied | null {
  const startLine = before.slice(0, idx).split("\n").length; // 1-based start of the match
  const endLine = startLine + oldString.split("\n").length - 1;
  const touched = parseSymbols(path, before)
    .filter((s) => !(s.endLine < startLine || s.startLine > endLine))
    .map((s) => s.name);
  return heldDenial(claimHeldByOther(store, actor, path, touched, Date.now()));
}

/** Shape a `claimHeldByOther` hit into the shared EditDenied return, or null if clear. */
function heldDenial(held: ReturnType<typeof claimHeldByOther>): EditDenied | null {
  if (!held) return null;
  return { ok: false, error: `held by ${held.holder}`, heldBy: held.holder, holderIntent: held.intent };
}

/**
 * Prevention check for an `old_string` edit, given the file's current content.
 * Returns an EditDenied if another actor holds the touched symbol(s), else null
 * (including when the old_string can't be located — that's not a claim problem).
 * Shared by the MCP `quilt_edit` tool and the native-Edit hook so both prevent
 * identically.
 */
export function checkHeldEdit(
  store: Store,
  actor: string,
  path: string,
  before: string,
  oldString: string,
): EditDenied | null {
  const idx = before.indexOf(oldString);
  if (idx === -1) return null;
  return checkHeld(store, actor, path, before, idx, oldString);
}

/**
 * Prevention check for a whole-file write. Considers symbols in BOTH the new
 * content and the existing file (pass its content, or null if new), so
 * overwriting a claimed symbol away is still denied. Shared by `quilt_write`
 * and the native-Write hook.
 */
export function checkHeldWrite(
  store: Store,
  actor: string,
  path: string,
  content: string,
  existing: string | null,
): EditDenied | null {
  const symbols = new Set(parseSymbols(path, content).map((s) => s.name));
  if (existing !== null) for (const s of parseSymbols(path, existing)) symbols.add(s.name);
  return heldDenial(claimHeldByOther(store, actor, path, [...symbols], Date.now()));
}

function splitLines(s: string): string[] {
  const out = s.split("\n");
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Read the full append-only ledger (chronological). */
export function readAuthorship(store: Store): AuthorshipEvent[] {
  const p = store.paths.authorshipLog;
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuthorshipEvent);
}

/**
 * Fold a run of events into an existing `path -> (ownKey -> actor)` map, later
 * event winning for the same key. The one place the fold rule lives, so the
 * log-fold and the checkpoint-fold can't drift.
 *
 * Keys are `symbol\0text` (event.addedKeys/removedKeys), so an added line is
 * owned under its symbol scope and a removal deletes exactly that line's entry —
 * an identical line in another symbol has a different key and is untouched. That
 * lets compaction prune removed lines instead of accumulating stale entries.
 */
function foldEvents(byPath: Map<string, Map<string, string>>, events: AuthorshipEvent[]): void {
  for (const ev of events) {
    let m = byPath.get(ev.path);
    if (!m) byPath.set(ev.path, (m = new Map()));
    // Legacy events (pre-symbol-keying) have no addedKeys — fall back to a
    // bare-text key (empty symbol scope), matching how top-level lines key.
    const addedKeys = ev.addedKeys ?? ev.added.map((t) => ownKey("", t));
    for (const key of addedKeys) m.set(key, ev.actor);
    // A captured removal drops the line's ownership — the line is gone from the
    // file as of this event. Events are appended in real order under the store
    // lock, so a later re-add (which re-sets the key) always wins over an earlier
    // removal, and vice versa; no owner-guard is needed or correct here (a removal
    // by another actor still means the line is gone).
    for (const key of ev.removedKeys ?? []) m.delete(key);
  }
}

/** A compacted fold of old events: the log's authorship folded once, so the log
 * can be truncated and reconcile need not re-read all of history every time. */
export interface AuthorshipCheckpoint {
  /** total events folded into this checkpoint (keeps `seq` monotonic post-truncate). */
  count: number;
  /** the folded `path -> ownKey(symbol\0text) -> actor`, latest-author-wins. */
  ownership: Record<string, Record<string, string>>;
}

/** Compact once the un-folded log passes this many events. */
export const COMPACT_THRESHOLD = 1000;

/**
 * Read the checkpoint. Absent → an empty checkpoint (nothing compacted yet). But
 * a checkpoint that EXISTS and won't parse is fatal: the log was truncated after
 * it was written, so it's the only record of that compacted authorship. Returning
 * empty would silently misattribute every historical line, so we throw loudly
 * instead — a corrupt checkpoint is a stop-and-look, not something to paper over.
 */
export function readCheckpoint(store: Store): AuthorshipCheckpoint {
  const p = store.paths.authorshipCheckpoint;
  if (!existsSync(p)) return { count: 0, ownership: {} };
  let cp: AuthorshipCheckpoint;
  try {
    cp = JSON.parse(readFileSync(p, "utf8")) as AuthorshipCheckpoint;
  } catch (e) {
    throw new Error(
      `quilt: authorship checkpoint is corrupt (${p}) — compacted authorship history can't be read. ` +
        `Restore it from backup, or delete it to continue without that history. (${(e as Error).message})`,
    );
  }
  return { count: cp.count ?? 0, ownership: cp.ownership ?? {} };
}

/**
 * The authoritative line-ownership reconcile attributes from: the checkpoint's
 * fold plus the un-compacted log tail on top (later wins). Reading the checkpoint
 * instead of re-folding all of history keeps reconcile cheap on long-lived repos.
 */
export function foldedAuthorship(store: Store): Map<string, Map<string, string>> {
  const cp = readCheckpoint(store);
  const byPath = new Map<string, Map<string, string>>();
  for (const [path, lines] of Object.entries(cp.ownership)) {
    byPath.set(path, new Map(Object.entries(lines)));
  }
  foldEvents(byPath, readAuthorship(store));
  return byPath;
}

/** Fold the current log into the checkpoint and truncate the log. NOT locked —
 * call only while holding the store lock. Writing the checkpoint atomically
 * BEFORE truncating means a crash in between just leaves the log to be re-folded
 * (idempotent: re-setting a line to the same actor is a no-op), never lost. */
function compactLocked(store: Store): void {
  const events = readAuthorship(store);
  if (events.length === 0) return;
  const cp = readCheckpoint(store);
  const byPath = new Map<string, Map<string, string>>();
  for (const [path, lines] of Object.entries(cp.ownership)) byPath.set(path, new Map(Object.entries(lines)));
  foldEvents(byPath, events);
  const ownership: Record<string, Record<string, string>> = {};
  for (const [path, m] of byPath) ownership[path] = Object.fromEntries(m);
  const next: AuthorshipCheckpoint = { count: cp.count + events.length, ownership };
  const tmp = store.paths.authorshipCheckpoint + ".tmp";
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, store.paths.authorshipCheckpoint); // atomic
  writeFileSync(store.paths.authorshipLog, ""); // truncate only after the checkpoint is durable
}

/** Compact the ledger (fold the log into the checkpoint, truncate). Locked — the
 * explicit entry point (recordAuthorship compacts inline under its own lock). For
 * tests and a future `quilt compact` maintenance command. */
export function compactAuthorship(store: Store): void {
  store.withLock(() => compactLocked(store));
}

/** The genuinely-added and removed lines for an old->new payload. */
export function computeDelta(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const ops = lineDiff(oldText, newText);
  return {
    added: ops.filter((o) => o.type === "add").map((o) => o.text),
    removed: ops.filter((o) => o.type === "del").map((o) => o.text),
  };
}

interface KeyedDelta {
  added: string[];
  removed: string[];
  addedKeys: string[];
  removedKeys: string[];
}

/**
 * The delta plus each line's symbol-qualified ownership key. Added lines take
 * their scope from the post-image (`newText`), removed lines from the pre-image
 * (`oldText`) — each is where that line physically lives — so the fold keys the
 * same way reconcile does. A whole write is all-adds against the new content.
 */
function keyedDelta(path: string, oldText: string, newText: string, whole: boolean): KeyedDelta {
  if (whole) {
    const loc = symbolLocator(path, newText);
    const added = splitLines(newText);
    return { added, removed: [], addedKeys: added.map((t, i) => ownKey(loc(i + 1), t)), removedKeys: [] };
  }
  const addLoc = symbolLocator(path, newText);
  const delLoc = symbolLocator(path, oldText);
  const added: string[] = [];
  const removed: string[] = [];
  const addedKeys: string[] = [];
  const removedKeys: string[] = [];
  let newLine = 0;
  let oldLine = 0;
  for (const op of lineDiff(oldText, newText)) {
    if (op.type === "eq") {
      newLine++;
      oldLine++;
    } else if (op.type === "add") {
      newLine++;
      added.push(op.text);
      addedKeys.push(ownKey(addLoc(newLine), op.text));
    } else {
      oldLine++;
      removed.push(op.text);
      removedKeys.push(ownKey(delLoc(oldLine), op.text));
    }
  }
  return { added, removed, addedKeys, removedKeys };
}

/**
 * Append one authorship event, derived from the edit payload. The seq is the
 * current event count (assigned under the lock so concurrent appends stay
 * ordered). Returns the event.
 */
export function recordAuthorship(
  store: Store,
  args: {
    actor: string;
    path: string;
    oldText: string;
    newText: string;
    intent?: string;
    whole?: boolean;
    /** the stable line just BEFORE the edit region (survives the replacement), for replay. */
    anchor?: string | null;
  },
): AuthorshipEvent {
  const { actor, path, oldText, newText, intent, whole } = args;
  return store.withLock(() => {
    const events = readAuthorship(store);
    const { added, removed, addedKeys, removedKeys } = keyedDelta(path, oldText, newText, !!whole);
    const ev: AuthorshipEvent = {
      // seq spans the compacted history too, so it stays monotonic after a
      // truncation resets the log to empty.
      seq: readCheckpoint(store).count + events.length,
      ts: new Date().toISOString(),
      actor,
      path,
      added,
      removed,
      addedKeys,
      removedKeys: removedKeys.length ? removedKeys : undefined,
      anchor: whole ? null : args.anchor ?? null,
      preHash: whole ? null : sha(oldText),
      intent: intent?.trim() ? intent.trim() : undefined,
      whole: whole || undefined,
    };
    appendFileSync(store.paths.authorshipLog, JSON.stringify(ev) + "\n");
    // Keep the log bounded: once it's grown past the threshold, fold it into the
    // checkpoint and truncate. Same lock, so the fold sees exactly what we wrote.
    if (events.length + 1 >= COMPACT_THRESHOLD) compactLocked(store);
    return ev;
  });
}

/**
 * The surviving anchor line for an `old_string` edit (the last complete line
 * before the match), or null if the string can't be located. Used by the hook,
 * which — unlike applyAndRecordEdit — doesn't already hold the match offset.
 */
export function anchorForEdit(before: string, oldString: string): string | null {
  const idx = before.indexOf(oldString);
  return idx === -1 ? null : lineBefore(before, idx);
}

/** The last complete line of `text` before offset `idx` (the surviving anchor). */
function lineBefore(text: string, idx: number): string | null {
  const head = text.slice(0, idx).split("\n");
  // head's last element is the partial line where the match starts (or "" at a
  // line boundary); the element before it is the last complete preceding line.
  return head.length >= 2 ? head[head.length - 2] ?? null : null;
}

/**
 * Apply an `old_string` -> `new_string` edit to a file and capture authorship in
 * one step — exactly what the `quilt_edit` MCP tool does. The write is atomic
 * (temp + rename) so a crash never leaves a half-written file. Returns the event,
 * or an error string if the old_string can't be located.
 */
export function applyAndRecordEdit(
  store: Store,
  args: { actor: string; path: string; oldString: string; newString: string; intent?: string },
): { ok: true; event: AuthorshipEvent } | { ok: false; error: string } | EditDenied {
  const abs = safeAbs(store.paths.repoRoot, args.path);
  if (!abs) return { ok: false, error: "path escapes the repository" };
  if (!existsSync(abs)) return { ok: false, error: `file not found: ${args.path}` };
  const before = readFileSync(abs, "utf8");
  const idx = before.indexOf(args.oldString);
  if (idx === -1) return { ok: false, error: "old_string not found in file" };
  if (before.indexOf(args.oldString, idx + 1) !== -1) {
    return { ok: false, error: "old_string is not unique; include more context" };
  }
  // PREVENTION: if another actor holds the symbol(s) this edit touches, deny the
  // write before any bytes change and hand back their intent — the earliest
  // possible encounter point (earlier than commit), so the agent resolves in-band.
  const denied = checkHeldEdit(store, args.actor, args.path, before, args.oldString);
  if (denied) return denied;
  const after = before.slice(0, idx) + args.newString + before.slice(idx + args.oldString.length);
  atomicWrite(abs, after);
  // Diff the FULL before->after content (computed in-memory from the bytes this
  // actor read — never a disk re-read, so a sibling's concurrent write can't taint
  // it). This yields whole-line adds/removes that match how ownership is keyed,
  // unlike the partial old_string/new_string fragments.
  const event = recordAuthorship(store, {
    actor: args.actor,
    path: args.path,
    oldText: before,
    newText: after,
    intent: args.intent,
    anchor: lineBefore(before, idx),
  });
  return { ok: true, event };
}

/** Whole-file write/create with authorship capture (the `quilt_write` tool). */
export function applyAndRecordWrite(
  store: Store,
  args: { actor: string; path: string; content: string; intent?: string },
): { ok: true; event: AuthorshipEvent } | { ok: false; error: string } | EditDenied {
  const abs = safeAbs(store.paths.repoRoot, args.path);
  if (!abs) return { ok: false, error: "path escapes the repository" };
  // A whole-file write collides with any other actor's claim on this path. Check
  // symbols in BOTH the new content and the existing file — overwriting a file in
  // a way that removes a claimed symbol must still be denied (else it silently
  // deletes the held code).
  const existing = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  const denied = checkHeldWrite(store, args.actor, args.path, args.content, existing);
  if (denied) return denied;
  atomicWrite(abs, args.content);
  const event = recordAuthorship(store, {
    actor: args.actor,
    path: args.path,
    oldText: "",
    newText: args.content,
    intent: args.intent,
    whole: true,
  });
  return { ok: true, event };
}

function atomicWrite(abs: string, content: string): void {
  const tmp = abs + ".quilt-tmp";
  writeFileSync(tmp, content);
  renameSync(tmp, abs);
}
