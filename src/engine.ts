import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { changedPaths, headBlob } from "./git.js";
import {
  buildHunks,
  isTrivialLine,
  lineDiff,
  looksBinary,
  splitLines,
  MAX_LCS_CELLS,
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
  try {
    // lstat (not stat) so a symlink is never followed — Quilt must not read or
    // snapshot whatever a symlink points at (could be outside the repo).
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function lineCount(text: string | null): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
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
  const clobbers = store.readClobbers();
  let clobbersChanged = false;

  // Files reserved by OTHER actors. We skip them entirely this pass: don't
  // attribute, don't advance the observed snapshot, don't prune. A claim
  // reserves not just editing but attribution, so one actor's reconcile can
  // never absorb or mis-credit another actor's in-flight work on a claimed file.
  const nowMs = Date.now();
  const claimedByOther = new Map<string, string>();
  for (const c of store.readClaims().claims) {
    if (c.expiresAt > nowMs && c.actor !== activeActorId) {
      claimedByOther.set(c.path, c.actor);
    }
  }

  for (const path of relevantPaths(store)) {
    if (claimedByOther.has(path)) continue;
    const head = headBlob(repoRoot, path);
    const current = readWorktree(repoRoot, path);

    // Baseline for "what changed since we last looked".
    const observedHasKey = Object.prototype.hasOwnProperty.call(
      observed.files,
      path,
    );
    const baseline = observedHasKey ? observed.files[path] ?? null : head;

    const binary =
      (head !== null && looksBinary(head)) ||
      (current !== null && looksBinary(current));
    // For files too large to diff reliably, the LCS engine falls back to a
    // whole-file replace, which would flag every owned line as removed and fire
    // spurious clobbers. Treat them like binary: observe but don't attribute.
    // Guard the ACTUAL diff inputs — both the attribution diff (baseline→current,
    // where baseline can be the much-larger observed content) and the prune diff
    // (head→current).
    const tooLarge =
      lineCount(baseline) * lineCount(current) > MAX_LCS_CELLS ||
      lineCount(head) * lineCount(current) > MAX_LCS_CELLS;

    if (!binary && !tooLarge && activeActorId) {
      const delta = lineDiff(baseline ?? "", current ?? "");
      const file = (ownership.files[path] ??= { added: {}, removed: {} });
      const conflicts = ownership.conflicts;

      // Clobber detection: the active actor is removing lines that ANOTHER actor
      // owns (uncommitted). Preserve the victim's pre-clobber content so it can
      // be restored — detect-and-preserve, nothing is silently lost.
      const victims = new Map<string, string[]>();
      for (const op of delta) {
        if (op.type !== "del" || isTrivialLine(op.text)) continue;
        const owner = file.added[op.text];
        if (owner && owner !== activeActorId) {
          const sample = victims.get(owner) ?? [];
          if (sample.length < 3) sample.push(op.text);
          victims.set(owner, sample);
        }
      }
      if (victims.size > 0 && baseline) {
        // One snapshot per file per clobber event: `baseline` is the whole
        // pre-clobber file, which already contains every victim's lines, so all
        // victims of this event share the snapshot (each restores the same full
        // file and fishes out their own lines).
        const snapshotId = randomUUID().slice(0, 12);
        store.preserveSnapshot(snapshotId, baseline);
        for (const [victim, sampleLines] of victims) {
          clobbers.clobbers.push({
            id: randomUUID().slice(0, 12),
            ts: new Date().toISOString(),
            path,
            victimActor: victim,
            byActor: activeActorId,
            snapshotId,
            sampleLines,
            restored: false,
          });
          store.appendLedger({
            ts: new Date().toISOString(),
            type: "clobber.detected",
            path,
            victimActor: victim,
            byActor: activeActorId,
            snapshotId,
          });
        }
        clobbersChanged = true;
      }

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
  if (clobbersChanged) store.writeClobbers(clobbers);

  // Prune expired advisory claims so claims.json stays bounded even on
  // read-only workflows that never call acquire. We're already inside the lock,
  // so touch the files directly (do NOT re-enter withLock).
  const claimsFile = store.readClaims();
  const now = Date.now();
  const kept = claimsFile.claims.filter((c) => c.expiresAt > now);
  if (kept.length !== claimsFile.claims.length) {
    store.writeClaims({ claims: kept });
  }
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
      (current !== null && looksBinary(current)) ||
      lineCount(head) * lineCount(current) > MAX_LCS_CELLS;

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
