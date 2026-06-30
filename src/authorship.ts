// The authorship ledger — capture who authored which lines AT THE EDIT.
//
// The core insight (see design/authorship-capture.md): the OS records that bytes
// changed, never which agent changed them. So instead of inferring authorship
// later from reconcile timing (lossy, races), we record it the instant an edit
// happens, from the tool-call payload (old -> new), which carries the actor's
// identity and brackets the exact byte change. Each edit appends one immutable
// event; ownership is a replay of the log. This is the v0.3 substrate.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { lineDiff } from "./diff.js";
import type { Store } from "./state.js";

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
  args: { actor: string; path: string; oldText: string; newText: string; intent?: string; whole?: boolean },
): AuthorshipEvent {
  const { actor, path, oldText, newText, intent, whole } = args;
  return store.withLock(() => {
    const events = readAuthorship(store);
    const { added, removed } = whole
      ? { added: splitLines(newText), removed: [] }
      : computeDelta(oldText, newText);
    const oldL = splitLines(oldText);
    const ev: AuthorshipEvent = {
      seq: events.length,
      ts: new Date().toISOString(),
      actor,
      path,
      added,
      removed,
      anchor: whole ? null : oldL[0] ?? null,
      preHash: whole ? null : sha(oldText),
      intent: intent?.trim() ? intent.trim() : undefined,
      whole: whole || undefined,
    };
    appendFileSync(store.paths.authorshipLog, JSON.stringify(ev) + "\n");
    return ev;
  });
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
): { ok: true; event: AuthorshipEvent } | { ok: false; error: string } {
  const abs = join(store.paths.repoRoot, args.path);
  if (!existsSync(abs)) return { ok: false, error: `file not found: ${args.path}` };
  const before = readFileSync(abs, "utf8");
  const idx = before.indexOf(args.oldString);
  if (idx === -1) return { ok: false, error: "old_string not found in file" };
  if (before.indexOf(args.oldString, idx + 1) !== -1) {
    return { ok: false, error: "old_string is not unique; include more context" };
  }
  const after = before.slice(0, idx) + args.newString + before.slice(idx + args.oldString.length);
  atomicWrite(abs, after);
  const event = recordAuthorship(store, {
    actor: args.actor,
    path: args.path,
    oldText: args.oldString,
    newText: args.newString,
    intent: args.intent,
  });
  return { ok: true, event };
}

/** Whole-file write/create with authorship capture (the `quilt_write` tool). */
export function applyAndRecordWrite(
  store: Store,
  args: { actor: string; path: string; content: string; intent?: string },
): { ok: true; event: AuthorshipEvent } {
  const abs = join(store.paths.repoRoot, args.path);
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
