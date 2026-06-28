import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { changedPaths, headBlob } from "./git.js";
import {
  buildHunks,
  isTrivialLine,
  lineDiff,
  looksBinary,
  splitLines,
  type Hunk,
} from "./diff.js";
import type { Store } from "./state.js";
import type { OwnershipFile } from "./types.js";

export type HunkOwnership =
  | "mine" // every changed line owned by the active actor
  | "other" // owned by a single other actor
  | "shared" // owned by multiple actors and/or conflicted
  | "mixed" // mine + unattributed lines together (needs confirmation)
  | "unclaimed"; // no owner (pre-existing dirty / generated)

export interface OwnedHunk {
  hunk: Hunk;
  ownership: HunkOwnership;
  /** Distinct actor ids that own changed lines in this hunk. */
  actors: string[];
  /** True if any changed line in this hunk is flagged as conflicted. */
  conflicted: boolean;
}

export interface FileModel {
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  oldText: string | null;
  newText: string | null;
  hunks: OwnedHunk[];
}

export interface WorktreeModel {
  activeActorId: string | null;
  files: FileModel[];
}

function readWorktree(repoRoot: string, relPath: string): string | null {
  const abs = join(repoRoot, relPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** The union of paths Quilt should consider this pass. */
function relevantPaths(store: Store): string[] {
  const repoRoot = store.paths.repoRoot;
  const set = new Set<string>(changedPaths(repoRoot));
  for (const p of Object.keys(store.readOwnership().files)) set.add(p);
  for (const p of Object.keys(store.readObserved().files)) set.add(p);
  return [...set].sort();
}

function changedLineSets(oldText: string | null, newText: string | null): {
  added: Set<string>;
  removed: Set<string>;
} {
  const ops = lineDiff(oldText ?? "", newText ?? "");
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const op of ops) {
    if (op.type === "add") added.add(op.text);
    else if (op.type === "del") removed.add(op.text);
  }
  return { added, removed };
}

/**
 * Reconcile attribution: claim everything that changed since Quilt last
 * observed each file for the active actor, detect overlaps with other actors,
 * and prune ownership for lines that are no longer part of the working diff
 * (e.g. committed or reverted). Mutates and persists ownership + observed.
 */
export function reconcile(store: Store, activeActorId: string | null): void {
  store.withLock(() => reconcileLocked(store, activeActorId));
}

function reconcileLocked(store: Store, activeActorId: string | null): void {
  const repoRoot = store.paths.repoRoot;
  const ownership = store.readOwnership();
  const observed = store.readObserved();

  for (const path of relevantPaths(store)) {
    const head = headBlob(repoRoot, path);
    const current = readWorktree(repoRoot, path);

    const binary =
      (head !== null && looksBinary(head)) ||
      (current !== null && looksBinary(current));

    if (!binary && activeActorId) {
      // Baseline for "what changed since we last looked".
      const observedHasKey = Object.prototype.hasOwnProperty.call(
        observed.files,
        path,
      );
      const baseline = observedHasKey ? observed.files[path] ?? null : head;

      const delta = lineDiff(baseline ?? "", current ?? "");
      const file = (ownership.files[path] ??= { added: {}, removed: {} });
      const conflicts = ownership.conflicts;

      for (const op of delta) {
        if (op.type === "eq") continue;
        if (isTrivialLine(op.text)) continue;
        const map = op.type === "add" ? file.added : file.removed;
        const existing = map[op.text];
        if (existing && existing !== activeActorId) {
          const fileConflicts = (conflicts[path] ??= {});
          const list: string[] = fileConflicts[op.text] ?? [existing];
          if (!list.includes(activeActorId)) list.push(activeActorId);
          fileConflicts[op.text] = list;
        } else if (!existing) {
          map[op.text] = activeActorId;
        }
      }
    }

    // Advance the observed snapshot for this path.
    observed.files[path] = current;

    // Prune ownership/conflicts for lines no longer in the working diff.
    const { added, removed } = changedLineSets(head, current);
    const file = ownership.files[path];
    if (file) {
      for (const text of Object.keys(file.added)) {
        if (!added.has(text)) delete file.added[text];
      }
      for (const text of Object.keys(file.removed)) {
        if (!removed.has(text)) delete file.removed[text];
      }
      if (
        Object.keys(file.added).length === 0 &&
        Object.keys(file.removed).length === 0
      ) {
        delete ownership.files[path];
      }
    }
    const fileConflicts = ownership.conflicts[path];
    if (fileConflicts) {
      for (const text of Object.keys(fileConflicts)) {
        if (!added.has(text) && !removed.has(text)) delete fileConflicts[text];
      }
      if (Object.keys(fileConflicts).length === 0) {
        delete ownership.conflicts[path];
      }
    }
  }

  store.writeOwnership(ownership);
  store.writeObserved(observed);
}

function classifyHunk(
  hunk: Hunk,
  path: string,
  ownership: OwnershipFile,
  activeActorId: string | null,
): OwnedHunk {
  const file = ownership.files[path];
  const fileConflicts = ownership.conflicts[path] ?? {};
  const owners = new Set<string>();
  let unowned = false;
  let conflicted = false;

  for (const op of hunk.ops) {
    if (op.type === "eq") continue;
    // Trivial lines (braces, blanks) are neither owned nor counted as
    // unattributed — they ride along with the hunk's substantive changes.
    if (isTrivialLine(op.text)) continue;
    const map = op.type === "add" ? file?.added : file?.removed;
    const owner = map?.[op.text];
    if (owner) owners.add(owner);
    else unowned = true;
    if (fileConflicts[op.text]) {
      conflicted = true;
      for (const a of fileConflicts[op.text]!) owners.add(a);
    }
  }

  const actors = [...owners];
  let ownership_: HunkOwnership;
  if (conflicted || owners.size > 1) {
    ownership_ = "shared";
  } else if (owners.size === 0) {
    ownership_ = "unclaimed";
  } else {
    const sole = actors[0]!;
    if (sole === activeActorId) ownership_ = unowned ? "mixed" : "mine";
    else ownership_ = "other";
  }

  return { hunk, ownership: ownership_, actors, conflicted };
}

/** Build the read-only worktree model used by status / mine / preview / commit. */
export function buildModel(
  store: Store,
  activeActorId: string | null,
): WorktreeModel {
  const repoRoot = store.paths.repoRoot;
  const ownership = store.readOwnership();
  const files: FileModel[] = [];

  for (const path of changedPaths(repoRoot)) {
    const head = headBlob(repoRoot, path);
    const current = readWorktree(repoRoot, path);
    if (head === current) continue;

    const binary =
      (head !== null && looksBinary(head)) ||
      (current !== null && looksBinary(current));

    const model: FileModel = {
      path,
      isNew: head === null,
      isDeleted: current === null,
      binary,
      oldText: head,
      newText: current,
      hunks: [],
    };

    if (!binary) {
      const ops = lineDiff(head ?? "", current ?? "");
      for (const hunk of buildHunks(ops)) {
        model.hunks.push(classifyHunk(hunk, path, ownership, activeActorId));
      }
    }
    files.push(model);
  }

  return { activeActorId, files };
}

/** Count changed (add/del) lines in a hunk. */
export function hunkChangedLines(hunk: Hunk): number {
  return hunk.ops.filter((o) => o.type !== "eq").length;
}

/** Convenience: does this file have any hunk owned by the active actor? */
export function fileHasMine(file: FileModel): boolean {
  return file.hunks.some((h) => h.ownership === "mine" || h.ownership === "mixed");
}

export function isFinalNewline(text: string | null): boolean {
  return text === null ? true : splitLines(text).finalNewline;
}
