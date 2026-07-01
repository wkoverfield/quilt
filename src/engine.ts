import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { changedPaths, headBlobs } from "./git.js";
import {
  buildHunks,
  isTrivialLine,
  lineDiff,
  looksBinary,
  MAX_LCS_CELLS,
  type Hunk,
  type DiffOp,
} from "./diff.js";
import { parseSymbols, ownKey, keyText, symbolLocator, opKeyer } from "./symbols.js";
import { foldedAuthorship } from "./authorship.js";
import type { Store } from "./state.js";
import type { OwnershipFile } from "./types.js";

export type HunkOwnership =
  | "mine" // every changed line owned by the active actor
  | "other" // owned by a single other actor
  | "shared" // owned by multiple actors and/or conflicted
  | "mixed" // mine + unattributed lines together (needs confirmation)
  | "unclaimed"; // no owner (pre-existing dirty / generated)

/**
 * For a `shared` hunk, the NATURE of the overlap:
 *  - "adjacent"  — actors changed different lines that merely share a hunk
 *    (each owns a paired delete+add at its own position). Benign: `commit --mine`
 *    separates them cleanly.
 *  - "contended" — at the same position, one actor's line was replaced by
 *    another's (a same-line overwrite), or both added the identical line. This is
 *    a real clash worth a human's eyes.
 */
export type HunkOverlap = "adjacent" | "contended";

export interface OwnedHunk {
  hunk: Hunk;
  ownership: HunkOwnership;
  /** Distinct actor ids that own changed lines in this hunk. */
  actors: string[];
  /** True if any changed line in this hunk is flagged as conflicted. */
  conflicted: boolean;
  /** Set only when ownership === "shared": is the overlap benign or a real clash? */
  overlap?: HunkOverlap;
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
  // Defense in depth: paths come from .quilt/ JSON (ownership/observed) which is
  // normally Quilt-written, but a hand-edited file could inject `../` — never
  // read a path that resolves outside the repo, and never follow a symlink.
  const root = resolve(repoRoot);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
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

function setIn(map: Map<string, Set<string>>, key: string): Set<string> {
  const s = new Set<string>();
  map.set(key, s);
  return s;
}

/** Line numbers (1-based) covered by symbols whose names are in `claimed`. */
function linesInClaimedSymbols(
  path: string,
  content: string,
  claimed: Set<string>,
): Set<number> {
  const lines = new Set<number>();
  for (const sym of parseSymbols(path, content)) {
    if (!claimed.has(sym.name)) continue;
    for (let ln = sym.startLine; ln <= sym.endLine; ln++) lines.add(ln);
  }
  return lines;
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

/** The ownership KEYS (symbol scope + text) added/removed between two texts, for
 * pruning ownership down to lines still in the diff. Keyed the same way reconcile
 * records them: adds scope to the new side, removes to the old side. */
function changedLineSets(path: string, oldText: string | null, newText: string | null): {
  added: Set<string>;
  removed: Set<string>;
} {
  const ops = lineDiff(oldText ?? "", newText ?? "");
  const keyOf = opKeyer(symbolLocator(path, newText ?? ""), symbolLocator(path, oldText ?? ""));
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const op of ops) {
    const key = keyOf(op);
    if (key === null) continue;
    if (op.type === "add") added.add(key);
    else removed.add(key);
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
  // Authoritative authorship from the capture-at-edit ledger (checkpoint + log
  // tail). The ledger is the PRIMARY attribution source: any line it has an
  // author for wins. The content-key inference below is the FALLBACK FLOOR — it
  // only decides lines the ledger never captured (e.g. a raw bash/sed write).
  // Empty when nothing was captured, so the whole overlay no-ops on that path.
  const ledgerOwn = foldedAuthorship(store);

  // Files reserved by OTHER actors. We skip them entirely this pass: don't
  // attribute, don't advance the observed snapshot, don't prune. A claim
  // reserves not just editing but attribution, so one actor's reconcile can
  // never absorb or mis-credit another actor's in-flight work on a claimed file.
  //
  // Liveness invariant: this protection lasts only while the claim is live. An
  // actor must reconcile (run any quilt command, or commit) before its claim's
  // TTL elapses to keep ownership of in-flight edits — if the holder's process
  // dies after editing but before reconciling and the claim expires, the next
  // actor to reconcile will absorb that work (the same exposure as no claim).
  // A whole-file claim by another actor means skip the whole file. A *symbol*
  // claim means only that symbol's lines are off-limits — so two actors editing
  // different functions in one file proceed in parallel without either absorbing
  // the other's work.
  const nowMs = Date.now();
  const wholeFileClaimed = new Set<string>();
  const symbolClaimed = new Map<string, Set<string>>();
  for (const c of store.readClaims().claims) {
    if (c.expiresAt <= nowMs || c.actor === activeActorId) continue;
    if (c.symbol === undefined) wholeFileClaimed.add(c.path);
    else (symbolClaimed.get(c.path) ?? setIn(symbolClaimed, c.path)).add(c.symbol);
  }

  // Read every relevant file's HEAD content in one batched git call up front,
  // instead of a subprocess per path inside the loop (the reconcile hot path).
  const paths = relevantPaths(store);
  const headByPath = headBlobs(repoRoot, paths);
  for (const path of paths) {
    if (wholeFileClaimed.has(path)) continue;
    const head = headByPath.get(path) ?? null;
    const current = readWorktree(repoRoot, path);

    // Lines inside symbols another actor has claimed are off-limits for
    // attribution by this actor. Added lines are gated by the symbol's range in
    // the CURRENT file; removed lines by its range in the BASELINE.
    const claimedHere = symbolClaimed.get(path) ?? null;
    const offLimitAdd =
      claimedHere && current !== null
        ? linesInClaimedSymbols(path, current, claimedHere)
        : null;

    // Baseline for "what changed since we last looked".
    const observedHasKey = Object.prototype.hasOwnProperty.call(
      observed.files,
      path,
    );
    const baseline = observedHasKey ? observed.files[path] ?? null : head;
    const offLimitDel =
      claimedHere && baseline !== null
        ? linesInClaimedSymbols(path, baseline, claimedHere)
        : null;

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
      // Symbol scope for the ownership key: added lines live in `current`, removed
      // lines in `baseline`. Keying `symbol\0text` keeps identical text in two
      // different functions from collapsing to one owner.
      const addLoc = symbolLocator(path, current ?? "");
      const delLoc = symbolLocator(path, baseline ?? "");

      // Clobber detection: the active actor is removing lines that ANOTHER actor
      // owns (uncommitted). Preserve the victim's pre-clobber content so it can
      // be restored — detect-and-preserve, nothing is silently lost. Removals
      // inside a symbol another actor claimed are skipped (that's their edit to
      // make, not a clobber by us).
      const victims = new Map<string, string[]>();
      let bLine = 0; // 1-based line in baseline; advances on eq + del
      for (const op of delta) {
        if (op.type === "eq") {
          bLine++;
          continue;
        }
        if (op.type !== "del") continue;
        bLine++;
        if (offLimitDel && offLimitDel.has(bLine)) continue;
        if (isTrivialLine(op.text)) continue;
        // Whose line is being deleted? Prefer the authoritative ledger author —
        // it knows the true author even when this actor's reconcile hasn't yet
        // overlaid it onto file.added, so a captured-but-unreconciled line still
        // names the right clobber victim. The victim added the line (keyed by its
        // scope), so look it up by the same symbol-qualified key.
        const delKey = ownKey(delLoc(bLine), op.text);
        const owner = ledgerOwn.get(path)?.get(delKey) ?? file.added[delKey];
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

      let curLine = 0; // 1-based line in `current`; advances on eq + add
      let baseLine = 0; // 1-based line in baseline; advances on eq + del
      for (const op of delta) {
        if (op.type === "eq") {
          curLine++;
          baseLine++;
          continue;
        }
        if (op.type === "add") {
          curLine++;
          if (offLimitAdd && offLimitAdd.has(curLine)) continue; // in another's claimed symbol
        } else {
          baseLine++;
          if (offLimitDel && offLimitDel.has(baseLine)) continue;
        }
        if (isTrivialLine(op.text)) continue;
        const map = op.type === "add" ? file.added : file.removed;
        const key = op.type === "add" ? ownKey(addLoc(curLine), op.text) : ownKey(delLoc(baseLine), op.text);
        const existing = map[key];
        if (existing && existing !== activeActorId) {
          const fileConflicts = (conflicts[path] ??= {});
          const list: string[] = fileConflicts[key] ?? [existing];
          if (!list.includes(activeActorId)) list.push(activeActorId);
          fileConflicts[key] = list;
        } else if (!existing) {
          map[key] = activeActorId;
        }
      }
    }

    // Advance the observed snapshot for this path — UNLESS another actor holds a
    // symbol claim here. While a file is under symbol contention we freeze its
    // baseline so every contending actor diffs from the same point and can
    // attribute its own symbol (advancing would consume the others' deltas).
    if (!claimedHere) observed.files[path] = current;

    // Prune ownership/conflicts for lines no longer in the working diff.
    const { added, removed } = changedLineSets(path, head, current);
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

    // Ledger overlay: the ledger is authoritative, so a captured line is
    // attributed to its RECORDED author, replacing whatever the inference floor
    // above guessed (this is the fix for "whoever reconciled first owns it").
    // Only applies to lines actually present in the current diff; un-captured
    // lines keep their inferred owner — inference is the fallback floor.
    const ledgerForPath = ledgerOwn.get(path);
    if (ledgerForPath) {
      const f = (ownership.files[path] ??= { added: {}, removed: {} });
      for (const [key, actor] of ledgerForPath) {
        if (!added.has(key) || isTrivialLine(keyText(key))) continue;
        f.added[key] = actor;
        if (ownership.conflicts[path]?.[key]) delete ownership.conflicts[path]![key];
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

type FileOwnership = OwnershipFile["files"][string];

/**
 * Decide whether a shared hunk is a benign adjacency or a real same-line clash.
 *
 * Within a change region (a run of del/add ops bounded by equal context) the
 * diff emits all deletes then all adds, so delete[i] and add[i] describe the
 * same position — a replacement. If a replacement's deleted line is owned by one
 * actor and its added line by another, that's an overwrite: someone's line was
 * replaced by someone else's. Adjacent edits, by contrast, pair each actor's own
 * delete with its own add, so no cross-owner pair appears.
 */
function hunkOverlap(
  hunk: Hunk,
  file: FileOwnership | undefined,
  conflicted: boolean,
  keyOf: (op: DiffOp) => string | null,
): HunkOverlap {
  if (conflicted) return "contended"; // identical line added/removed by two actors
  let delOwners: (string | undefined)[] = [];
  let addOwners: (string | undefined)[] = [];
  let contended = false;
  const flushRegion = () => {
    const n = Math.min(delOwners.length, addOwners.length);
    for (let i = 0; i < n; i++) {
      const d = delOwners[i];
      const a = addOwners[i];
      if (d && a && d !== a) contended = true; // a line was replaced by another actor's
    }
    delOwners = [];
    addOwners = [];
  };
  for (const op of hunk.ops) {
    const key = keyOf(op); // call for EVERY op so the line cursor stays aligned
    if (op.type === "eq") {
      flushRegion();
      continue;
    }
    if (isTrivialLine(op.text)) continue;
    if (op.type === "del") delOwners.push(file?.removed?.[key!]);
    else addOwners.push(file?.added?.[key!]);
  }
  flushRegion();
  return contended ? "contended" : "adjacent";
}

function classifyHunk(
  hunk: Hunk,
  path: string,
  ownership: OwnershipFile,
  activeActorId: string | null,
  addLoc: (line: number) => string,
  delLoc: (line: number) => string,
): OwnedHunk {
  const file = ownership.files[path];
  const fileConflicts = ownership.conflicts[path] ?? {};
  const owners = new Set<string>();
  let unowned = false;
  let conflicted = false;

  // A fresh keyer per hunk, started at the hunk's line offsets. Called on every
  // op (incl. eq/trivial) so the symbol\0text keys line up with what reconcile
  // recorded.
  const keyOf = opKeyer(addLoc, delLoc, hunk.newStart, hunk.oldStart);
  for (const op of hunk.ops) {
    const key = keyOf(op);
    if (op.type === "eq") continue;
    // Trivial lines (braces, blanks) are neither owned nor counted as
    // unattributed — they ride along with the hunk's substantive changes.
    if (isTrivialLine(op.text)) continue;
    const map = op.type === "add" ? file?.added : file?.removed;
    const owner = map?.[key!];
    if (owner) owners.add(owner);
    else unowned = true;
    if (fileConflicts[key!]) {
      conflicted = true;
      for (const a of fileConflicts[key!]!) owners.add(a);
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

  const overlap =
    ownership_ === "shared"
      ? hunkOverlap(hunk, file, conflicted, opKeyer(addLoc, delLoc, hunk.newStart, hunk.oldStart))
      : undefined;
  return { hunk, ownership: ownership_, actors, conflicted, overlap };
}

/** Build the read-only worktree model used by status / mine / preview / commit. */
export function buildModel(
  store: Store,
  activeActorId: string | null,
): WorktreeModel {
  const repoRoot = store.paths.repoRoot;
  const ownership = store.readOwnership();
  const files: FileModel[] = [];

  const paths = changedPaths(repoRoot);
  const headByPath = headBlobs(repoRoot, paths);
  for (const path of paths) {
    const head = headByPath.get(path) ?? null;
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
      // Symbol scopes for keying: adds live in `current`, removals in `head`.
      const addLoc = symbolLocator(path, current ?? "");
      const delLoc = symbolLocator(path, head ?? "");
      const ops = lineDiff(head ?? "", current ?? "");
      for (const hunk of buildHunks(ops)) {
        model.hunks.push(classifyHunk(hunk, path, ownership, activeActorId, addLoc, delLoc));
      }
    }
    files.push(model);
  }

  return { activeActorId, files };
}
