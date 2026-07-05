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
import { foldedAuthorship, foldedRemovals, readAuthorship } from "./authorship.js";
import { CLAIM_TTL_MS, promoteWaiters } from "./claims.js";
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
  // Read the log once and feed both folds (added-ownership and removal-author).
  const authorshipLog = readAuthorship(store);
  const ledgerOwn = foldedAuthorship(store, authorshipLog);
  // ...and who removed each line, so a captured removal is attributed to its
  // recorded author too (not just whoever reconciled first) — else a commit can
  // include deleting another actor's line when no reconcile ran between edits.
  const removalOwn = foldedRemovals(authorshipLog);

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
  // Directory claims cover every path under their prefix — collected apart
  // because Set.has can't do prefix matches.
  const othersDirClaims: string[] = [];
  const selfDirClaims: string[] = [];
  // For the contested-tree gate below: does any OTHER actor hold a live claim
  // anywhere, and which paths has the ACTIVE actor claimed itself?
  let othersHaveLiveClaims = false;
  const selfClaimedPaths = new Set<string>();
  for (const c of store.readClaims().claims) {
    if (c.expiresAt <= nowMs) continue;
    if (c.actor === activeActorId) {
      if (c.dir) selfDirClaims.push(c.path);
      else selfClaimedPaths.add(c.path);
      continue;
    }
    othersHaveLiveClaims = true;
    if (c.dir) othersDirClaims.push(c.path);
    else if (c.symbol === undefined) wholeFileClaimed.add(c.path);
    else (symbolClaimed.get(c.path) ?? setIn(symbolClaimed, c.path)).add(c.symbol);
  }
  const underAny = (dirs: string[], p: string) =>
    dirs.some((d) => p === d || p.startsWith(d + "/"));

  // Read every relevant file's HEAD content in one batched git call up front,
  // instead of a subprocess per path inside the loop (the reconcile hot path).
  const paths = relevantPaths(store);
  const headByPath = headBlobs(repoRoot, paths);
  for (const path of paths) {
    if (wholeFileClaimed.has(path) || underAny(othersDirClaims, path)) continue;
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

    // The contested-tree gate on the INFERENCE floor. Inference ("everything
    // that changed since we last looked belongs to the active actor") is only
    // sound when there's one plausible author. While OTHER actors hold live
    // claims — visible mid-work — a delta in a file this actor never claimed
    // could just as well be theirs (a bash/CLI write capture never saw), so
    // attributing it to whoever happens to reconcile first is how one agent's
    // commit swept seven of another agent's untracked files in the pilot.
    // While contested, inference only attributes paths the active actor has
    // CLAIMED; other deltas stay pending (baseline frozen below) so their true
    // maker can still take them by claiming, and capture/ledger attribution is
    // unaffected. When no one else holds claims, inference behaves as before —
    // the single-actor plain-git flow loses nothing. Same liveness trade-off
    // as claims themselves: protection lasts while claims are live.
    const inferHere =
      !othersHaveLiveClaims || selfClaimedPaths.has(path) || underAny(selfDirClaims, path);

    if (!binary && !tooLarge && activeActorId) {
      const delta = lineDiff(baseline ?? "", current ?? "");
      // Symbol scope for the ownership key: added lines live in `current`, removed
      // lines in `baseline`. Keying `symbol\0text` keeps identical text in two
      // different functions from collapsing to one owner (or one false conflict).
      const addLoc = symbolLocator(path, current ?? "");
      const delLoc = symbolLocator(path, baseline ?? "");

      // Clobber detection: lines another actor owns (uncommitted) are being
      // removed. Preserve the victim's pre-clobber content so it can be
      // restored — detect-and-preserve, nothing is silently lost. Removals
      // inside a symbol another actor claimed are skipped (that's their edit to
      // make, not a clobber by us). Detection runs even for files the
      // contested-tree gate excludes from INFERENCE below: the victim comes
      // from the ledger/ownership record (reliable either way), and skipping
      // would leave an overwrite invisible for as long as claims stay live.
      // `byActor` stays the reconciling actor — the same best-available guess
      // it has always been on the inference path.
      //
      // Two hard limits keep it honest (the dogfood fleet's false alarms):
      // a file whose worktree MATCHES HEAD has nothing uncommitted to clobber
      // — deltas against a stale frozen baseline are just history that landed;
      // and a deleted line that still EXISTS at HEAD is landed code being
      // rewritten, which is normal editing, never a clobber. Only uncommitted
      // work can be a victim.
      const victims = new Map<string, string[]>();
      const headLines =
        current === head ? null : new Set(head === null ? [] : head.split("\n"));
      let bLine = 0; // 1-based line in baseline; advances on eq + del
      for (const op of delta) {
        if (headLines === null) break; // worktree == HEAD: nothing clobberable
        if (op.type === "eq") {
          bLine++;
          continue;
        }
        if (op.type !== "del") continue;
        bLine++;
        if (offLimitDel && offLimitDel.has(bLine)) continue;
        if (isTrivialLine(op.text)) continue;
        if (headLines.has(op.text)) continue; // landed code being rewritten
        // Whose line is being deleted? Prefer the authoritative ledger author —
        // it knows the true author even when this actor's reconcile hasn't yet
        // overlaid it onto file.added, so a captured-but-unreconciled line still
        // names the right clobber victim. The victim added the line (keyed by its
        // scope), so look it up by the same symbol-qualified key.
        const delKey = ownKey(delLoc(bLine), op.text);
        const owner = ledgerOwn.get(path)?.get(delKey) ?? ownership.files[path]?.added[delKey];
        if (owner && owner !== activeActorId) {
          // A gated file's baseline stays frozen, so the same pending delta is
          // seen by every reconcile until resolved — don't re-record a clobber
          // that's already open for this victim on this path.
          const open = clobbers.clobbers.some(
            (c) => !c.restored && c.path === path && c.victimActor === owner,
          );
          if (open) continue;
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

      // Inference attribution — gated: only when the tree is uncontested or
      // the active actor claimed this path (see the contested-tree note above).
      if (inferHere) {
        const file = (ownership.files[path] ??= { added: {}, removed: {} });
        const conflicts = ownership.conflicts;
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
    }

    // Advance the observed snapshot for this path — UNLESS another actor holds a
    // symbol claim here (while a file is under symbol contention we freeze its
    // baseline so every contending actor diffs from the same point), or the
    // contested-tree gate left this file's delta unattributed (advancing would
    // consume the delta and no one could ever claim it afterwards; frozen, it
    // stays attributable by whoever claims the file).
    const pendingUnattributed =
      Boolean(activeActorId) &&
      !inferHere &&
      !binary &&
      !tooLarge &&
      (current ?? "") !== (baseline ?? "");
    if (!claimedHere && !pendingUnattributed) observed.files[path] = current;

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
    // Applies to lines present in the current diff; un-captured lines keep their
    // inferred owner — inference is the fallback floor. Added and removed sides
    // are overlaid symmetrically so neither depends on reconcile timing.
    const ledgerForPath = ledgerOwn.get(path);
    if (ledgerForPath) {
      const f = (ownership.files[path] ??= { added: {}, removed: {} });
      for (const [key, actor] of ledgerForPath) {
        if (!added.has(key) || isTrivialLine(keyText(key))) continue;
        f.added[key] = actor;
        if (ownership.conflicts[path]?.[key]) delete ownership.conflicts[path]![key];
      }
    }
    // Same key-mismatch caveat as the added overlay (see symbols.ts#opKeyer): a
    // removed line's key here scopes to HEAD's symbol, the ledger's to the edit's
    // baseline — they diverge only if the enclosing function was renamed between
    // the two, in which case this silently no-ops and the line keeps its inferred
    // owner (benign, rare).
    const removalForPath = removalOwn.get(path);
    if (removalForPath) {
      const f = (ownership.files[path] ??= { added: {}, removed: {} });
      for (const [key, actor] of removalForPath) {
        if (!removed.has(key) || isTrivialLine(keyText(key))) continue;
        f.removed[key] = actor;
        if (ownership.conflicts[path]?.[key]) delete ownership.conflicts[path]![key];
      }
    }
  }

  // Clobber lifecycle: an open record whose sampled victim lines all exist at
  // HEAD or in the current worktree of its path is describing work that is NOT
  // lost — it landed or is still sitting there. Auto-resolve it. Without this,
  // stale entries from hours-old phases read as live alarms to every new actor
  // (and trained the dogfood fleet to ignore the one signal that matters most).
  for (const c of clobbers.clobbers) {
    if (c.restored || c.sampleLines.length === 0) continue;
    const cur = readWorktree(repoRoot, c.path);
    const headText = headByPath.get(c.path) ?? headBlobs(repoRoot, [c.path]).get(c.path) ?? null;
    const present = (text: string | null, line: string) =>
      text !== null && text.split("\n").includes(line);
    if (c.sampleLines.every((l) => present(cur, l) || present(headText, l))) {
      c.restored = true;
      clobbersChanged = true;
    }
  }

  store.writeOwnership(ownership);
  store.writeObserved(observed);
  if (clobbersChanged) store.writeClobbers(clobbers);

  // Prune expired advisory claims so claims.json stays bounded even on
  // read-only workflows that never call acquire. We're already inside the lock,
  // so touch the files directly (do NOT re-enter withLock). While here, RENEW
  // the active actor's live claims: any quilt activity (status, edit, commit
  // — they all reconcile) is proof of life, so an actor mid-task never has its
  // reservations silently lapse under it (the dogfood fleet lost 8 of 12
  // claims to the TTL while still editing, one while blocked waiting).
  const claimsFile = store.readClaims();
  const now = Date.now();
  let claimsDirty = false;
  const kept = claimsFile.claims.filter((c) => c.expiresAt > now);
  if (kept.length !== claimsFile.claims.length) claimsDirty = true;
  if (activeActorId) {
    for (const c of kept) {
      if (c.actor !== activeActorId) continue;
      c.expiresAt = now + CLAIM_TTL_MS;
      c.expiresAtIso = new Date(c.expiresAt).toISOString();
      claimsDirty = true;
    }
  }
  claimsFile.claims = kept;
  // A lapsed lease (a dead or idle holder) frees its target — promote the
  // earliest queued waiter so the async claim lands even when nobody explicitly
  // released. No-op when the queue is empty.
  if (promoteWaiters(claimsFile, now).length > 0) claimsDirty = true;
  if (claimsDirty) {
    store.writeClaims(claimsFile);
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
    if (op.type === "del") delOwners.push(file?.removed[key!]);
    else addOwners.push(file?.added[key!]);
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
  /** the sole OTHER actor holding a live claim covering `path`, if any. */
  claimedByOther?: (path: string) => string | null,
): OwnedHunk {
  const file = ownership.files[path];
  const fileConflicts = ownership.conflicts[path] ?? {};
  const owners = new Set<string>();
  let unowned = false;
  let conflicted = false;

  // A fresh keyer per hunk, started at the hunk's line offsets. Called on every
  // op (incl. eq/trivial) so the keys line up with what reconcile recorded.
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
    // No recorded owner — but if another actor holds a live claim on this
    // path, the honest read is "theirs, attribution pending", not "unclaimed":
    // external edits attribute lazily, and the dogfood fleet repeatedly saw
    // a mid-flight peer's hunks labeled unclaimed while that peer's claims
    // were listed in the same response (which made includeUnclaimed a trap).
    const holder = claimedByOther?.(path);
    if (holder && holder !== activeActorId) {
      ownership_ = "other";
      actors.push(holder);
    } else {
      ownership_ = "unclaimed";
    }
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

  // Live claims by OTHER actors, for the attribution-pending read: an
  // unattributed hunk on a path exactly one other actor has claimed reads as
  // theirs, not as unclaimed. Ambiguous (2+ holders) stays unclaimed.
  const nowMs = Date.now();
  const holdersByPath = new Map<string, Set<string>>();
  const dirHolders: Array<{ prefix: string; actor: string }> = [];
  for (const c of store.readClaims().claims) {
    if (c.expiresAt <= nowMs || c.actor === activeActorId) continue;
    if (c.dir) dirHolders.push({ prefix: c.path, actor: c.actor });
    else (holdersByPath.get(c.path) ?? holdersByPath.set(c.path, new Set()).get(c.path)!).add(c.actor);
  }
  const claimedByOther = (p: string): string | null => {
    const set = new Set(holdersByPath.get(p) ?? []);
    for (const d of dirHolders) {
      if (p === d.prefix || p.startsWith(d.prefix + "/")) set.add(d.actor);
    }
    return set.size === 1 ? [...set][0]! : null;
  };

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
        model.hunks.push(
          classifyHunk(hunk, path, ownership, activeActorId, addLoc, delLoc, claimedByOther),
        );
      }
    }
    files.push(model);
  }

  return { activeActorId, files };
}
