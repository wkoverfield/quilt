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
import { parseSymbols } from "./symbols.js";
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
 * guard claims.ts/engine.ts apply to reads. Returns null if disallowed.
 */
function safeAbs(repoRoot: string, relPath: string): string | null {
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
  const held = claimHeldByOther(store, actor, path, touched, Date.now());
  if (!held) return null;
  return { ok: false, error: `held by ${held.holder}`, heldBy: held.holder, holderIntent: held.intent };
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
 * Fold the ledger into current authorship: `path -> (lineText -> actor)`, where a
 * later event wins for the same line. This is the authoritative record reconcile
 * overlays on top of (or in place of) its content-key inference — a line the
 * ledger has an author for is attributed to THAT actor, no matter who happened to
 * run reconcile. (Position-aware keying for identical lines is a later increment;
 * for now latest-by-text, which still fixes the who-reconciled-first hole.)
 */
export function ledgerOwnership(events: AuthorshipEvent[]): Map<string, Map<string, string>> {
  const byPath = new Map<string, Map<string, string>>();
  for (const ev of events) {
    let m = byPath.get(ev.path);
    if (!m) byPath.set(ev.path, (m = new Map()));
    for (const line of ev.added) m.set(line, ev.actor);
  }
  return byPath;
}

/** The genuinely-added and removed lines for an old->new payload. */
export function computeDelta(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const ops = lineDiff(oldText, newText);
  return {
    added: ops.filter((o) => o.type === "add").map((o) => o.text),
    removed: ops.filter((o) => o.type === "del").map((o) => o.text),
  };
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
    const { added, removed } = whole
      ? { added: splitLines(newText), removed: [] }
      : computeDelta(oldText, newText);
    const ev: AuthorshipEvent = {
      seq: events.length,
      ts: new Date().toISOString(),
      actor,
      path,
      added,
      removed,
      anchor: whole ? null : args.anchor ?? null,
      preHash: whole ? null : sha(oldText),
      intent: intent?.trim() ? intent.trim() : undefined,
      whole: whole || undefined,
    };
    appendFileSync(store.paths.authorshipLog, JSON.stringify(ev) + "\n");
    return ev;
  });
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
  const denied = checkHeld(store, args.actor, args.path, before, idx, args.oldString);
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
  // A whole-file write collides with any other actor's claim on this path.
  const symbols = parseSymbols(args.path, args.content).map((s) => s.name);
  const held = claimHeldByOther(store, args.actor, args.path, symbols, Date.now());
  if (held) return { ok: false, error: `held by ${held.holder}`, heldBy: held.holder, holderIntent: held.intent };
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
