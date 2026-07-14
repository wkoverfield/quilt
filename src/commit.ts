import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { git, headFileMode, headRef, headSha } from "./git.js";
import {
  buildHunks,
  isTrivialLine,
  lineDiff,
  renderPatch,
  splitLines,
} from "./diff.js";
import {
  type FileModel,
  type WorktreeModel,
} from "./engine.js";
import { symbolLocator, opKeyer, OWN_KEY_SEP } from "./symbols.js";
import type { Actor, FileOwnership, OwnershipFile } from "./types.js";
import { commitMessageWithProvenance, type CommitProvenanceV1 } from "./provenance.js";

export interface SelectedFile {
  path: string;
  hunkCount: number;
  addedLines: number;
  removedLines: number;
}

export interface Selection {
  patch: string;
  files: SelectedFile[];
  /** Files that have owned hunks but also unresolved blockers in the same file. */
  blockedFiles: string[];
  /** Binary or too-large-to-diff files CLAIMED by the actor — staged whole
   * into the commit (no line-level split is possible for them). */
  wholeFiles: string[];
  /** Binary/too-large files skipped because nobody claimed them. Surfaced
   * LOUDLY: a silently dropped lockfile is a broken build for everyone. */
  skippedBinary: string[];
  /** NEW untracked files skipped because the actor never claimed or captured
   * them (inference alone made them "owned") — surfaced so a default commit
   * never silently attaches a file the actor didn't touch. */
  skippedUnowned: string[];
  /** False when actor-owned work was withheld because the file could not be
   * split safely. Foreign adjacent work does not make a commit incomplete. */
  completeForActor: boolean;
  hasMixed: boolean;
  totalAdded: number;
  totalRemoved: number;
}

/** git mode for a working-tree file: 100755 if executable, else 100644. */
function worktreeMode(repoRoot: string, relPath: string): string {
  try {
    const m = statSync(join(repoRoot, relPath)).mode;
    return (m & 0o111) !== 0 ? "100755" : "100644";
  } catch {
    return "100644";
  }
}

interface OwnedBuild {
  /** the file as it would be with ONLY the actor's owned line-changes applied,
   *  or null when the actor's changes delete the file. undefined = no change. */
  text?: string | null;
  added: number;
  removed: number;
  /** a changed line is owned by a DIFFERENT actor (left in the working tree) */
  hasOther: boolean;
  /** an unattributed changed line was skipped (committable with --include-unclaimed) */
  hasUnclaimed: boolean;
  /** a named symbol has BOTH included and excluded changed lines — committing
   * would tear the construct (e.g. a function missing one of its lines), which
   * is how a syntax error got committed in the pilot. The file must not be
   * partially committed. */
  torn: boolean;
}

/**
 * Reconstruct a file containing only the active actor's owned line-changes,
 * line by line: keep context, apply the actor's owned adds/removes, OMIT other
 * actors' adds, and KEEP (as context) other actors' removals. Lone structural
 * lines (braces) inherit the ownership of their surrounding change run so a
 * function commits with its own closing brace. This lets two actors commit
 * different changes that happen to share one diff hunk.
 */
function buildOwnedText(
  path: string,
  headText: string | null,
  worktreeText: string | null,
  owned: FileOwnership | undefined,
  actor: string,
  includeUnclaimed: boolean,
): OwnedBuild {
  const ops = lineDiff(headText ?? "", worktreeText ?? "");
  // Key each line the same way reconcile did: adds by their symbol scope in the
  // worktree, removals by their scope in HEAD.
  const keyOf = opKeyer(symbolLocator(path, worktreeText ?? ""), symbolLocator(path, headText ?? ""));
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  let changed = false;
  let hasOther = false;
  let hasUnclaimed = false;
  let lastFromWorktree = false; // for the committed file's trailing newline
  // Tear detection: a NAMED symbol with both included and excluded changed
  // lines cannot be partially committed — the result is a construct missing
  // some of its lines (the committed-syntax-error failure). Track the symbol
  // scope (the key's prefix) of every non-trivial changed line on each side.

  // Pass 1 — decide every op. Non-trivial changed lines decide by owner.
  // Trivial lines (braces, blanks — never owned) are left undecided here and
  // resolved in pass 2 from their change-run's neighbors: the old single-pass
  // "inherit the preceding decision" dropped a trivial line that OPENED a run
  // (nothing preceded it but an eq reset), which is how a `}),` and blank
  // lines silently vanished from committed files in the pilot.
  const decisions: (boolean | null)[] = new Array(ops.length).fill(null);
  const trivial: boolean[] = new Array(ops.length).fill(false);
  const scopes: string[] = new Array(ops.length).fill("");
  ops.forEach((op, i) => {
    const key = keyOf(op); // every op, so the line cursor stays aligned
    if (op.type === "eq") return;
    if (isTrivialLine(op.text)) {
      trivial[i] = true;
      return;
    }
    const owner = op.type === "add" ? owned?.added[key!] : owned?.removed[key!];
    let include: boolean;
    if (owner === actor) include = true;
    else if (owner == null) {
      include = includeUnclaimed;
      hasUnclaimed = hasUnclaimed || !includeUnclaimed;
    } else {
      include = false;
      hasOther = true;
    }
    decisions[i] = include;
    scopes[i] = key ? key.slice(0, key.indexOf(OWN_KEY_SEP)) : "";
  });

  // Pass 2 — resolve trivial lines within each contiguous change run: nearest
  // decided neighbor, preferring the preceding one (a closing brace belongs to
  // the construct above it), else the following (a run-opening `}),` or blank
  // belongs to the change right after it). A run that is ENTIRELY trivial
  // (pure formatting) has no owner signal at all: committable only with
  // --include-unclaimed, and flagged so it is never dropped silently.
  let runStart = -1;
  const resolveRun = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      if (!trivial[i]) continue;
      let dec: boolean | null = null;
      for (let p = i - 1; p >= start; p--) {
        if (decisions[p] !== null) { dec = decisions[p]!; break; }
      }
      if (dec === null) {
        for (let n = i + 1; n < end; n++) {
          if (decisions[n] !== null) { dec = decisions[n]!; break; }
        }
      }
      if (dec === null) {
        dec = includeUnclaimed;
        hasUnclaimed = hasUnclaimed || !includeUnclaimed;
      }
      decisions[i] = dec;
    }
  };
  ops.forEach((op, i) => {
    if (op.type === "eq") {
      if (runStart !== -1) resolveRun(runStart, i);
      runStart = -1;
    } else if (runStart === -1) {
      runStart = i;
    }
  });
  if (runStart !== -1) resolveRun(runStart, ops.length);

  // Pass 3 — emit.
  ops.forEach((op, i) => {
    if (op.type === "eq") {
      out.push(op.text);
      lastFromWorktree = false;
      return;
    }
    const include = decisions[i] === true;
    if (op.type === "add") {
      if (include) {
        out.push(op.text);
        added++;
        changed = true;
        lastFromWorktree = true;
      }
    } else {
      if (include) {
        removed++;
        changed = true;
      } else {
        out.push(op.text); // keep the head line (another actor's removal, or unclaimed)
        lastFromWorktree = false;
      }
    }
  });

  // A construct is torn only when one CONTIGUOUS change run is split between
  // actors. V1 treated any two edits anywhere in the same function as a tear,
  // which made independent operation instances in one symbol impossible to
  // commit (#100). Separate runs already carry unchanged structural context
  // and are safe to split; a mixed run remains fail-closed.
  let torn = false;
  const runIncludedScopes = new Set<string>();
  const runExcludedScopes = new Set<string>();
  const finishTearRun = () => {
    if ([...runIncludedScopes].some((scope) => runExcludedScopes.has(scope))) torn = true;
    runIncludedScopes.clear();
    runExcludedScopes.clear();
  };
  ops.forEach((op, i) => {
    if (op.type === "eq") { finishTearRun(); return; }
    if (trivial[i]) return;
    if (decisions[i] === true) runIncludedScopes.add(scopes[i]!);
    else runExcludedScopes.add(scopes[i]!);
  });
  finishTearRun();
  if (!changed) return { added: 0, removed: 0, hasOther, hasUnclaimed, torn };
  // The actor's changes delete the file entirely.
  if (worktreeText === null && out.length === 0) {
    return { text: null, added, removed, hasOther, hasUnclaimed, torn };
  }
  const headFinal = headText === null ? true : splitLines(headText).finalNewline;
  const wtFinal = worktreeText === null ? true : splitLines(worktreeText).finalNewline;
  const finalNL = lastFromWorktree ? wtFinal : headFinal;
  const text = out.length === 0 ? "" : out.join("\n") + (finalNL ? "\n" : "");
  return { text, added, removed, hasOther, hasUnclaimed, torn };
}

/**
 * Build the patch of the active actor's owned changes at LINE granularity, so an
 * actor can commit just their lines even when those lines share a diff hunk with
 * another actor's. Pass includeMixed to also commit unattributed changed lines.
 */
export function selectOwned(
  model: WorktreeModel,
  repoRoot: string,
  ownership: OwnershipFile,
  opts: {
    includeMixed?: boolean;
    /** paths covered by another actor's live claim — includeMixed never
     * applies there (their mid-flight hunks can read "unclaimed" while
     * attribution is pending, and must not be sweepable on that label). */
    pathClaimedByOther?: (path: string) => boolean;
    /** paths covered by the ACTOR'S OWN live claim (whole-file or directory) —
     * lets a binary/too-large file (a lockfile, an asset) ride into the commit
     * whole, since no line-level split exists for it. */
    pathClaimedBySelf?: (path: string) => boolean;
    /** an explicit repo-relative path allow-list: commit ONLY these files of
     * yours (a hard filter, not a hint). Empty/undefined = all your owned
     * files. Lets an actor scope its commit and never sweep an unnamed file. */
    onlyPaths?: Set<string>;
    /** true if the actor has CAPTURED authorship for this path (a hook/MCP
     * edit recorded it). With `othersActive`, the signal that separates a file
     * the actor really produced from one inference merely swept onto it. */
    pathCapturedBySelf?: (path: string) => boolean;
    /** like pathClaimedBySelf but at ANY granularity (symbol claims count) —
     * the orphan gate's ownership signal. A forward symbol claim
     * (`new.ts#helper --creating`) is the documented way to pre-claim a file
     * you're about to create; it must satisfy the gate even though it can't
     * commit a binary whole. */
    pathClaimedBySelfAny?: (path: string) => boolean;
    /** true if any OTHER actor holds a live claim (a CONTESTED tree). Only then
     * is an inference-only new file suspect: another actor is around, so an
     * untracked file the actor never claimed or captured could be theirs (or an
     * orphan) — inference may have attributed it while the tree was briefly
     * uncontested, and that attribution persists. Solo trees keep the simple
     * rule: a new file in your tree is yours. Mirrors the engine's own
     * contested-tree inference gate. */
    othersActive?: boolean;
  } = {},
): Selection {
  const actor = model.activeActorId;
  const patches: string[] = [];
  const files: SelectedFile[] = [];
  const blockedFiles: string[] = [];
  const wholeFiles: string[] = [];
  const skippedBinary: string[] = [];
  const skippedUnowned: string[] = [];
  let hasMixed = false;
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const file of model.files) {
    if (actor === null) continue;
    // An explicit path filter is a HARD boundary: a named commit touches only
    // the named files, so an unnamed change (an orphan untracked file, another
    // actor's leftover) can never ride along. An entry names a file OR a
    // directory prefix (`commit --mine src/` scopes to everything under src/),
    // matching how claims treat directory targets.
    if (opts.onlyPaths) {
      const hit = [...opts.onlyPaths].some(
        (p) => p === "" || p === file.path || file.path.startsWith(p + "/"),
      );
      if (!hit) continue;
    }
    if (file.binary) {
      // No line-level ownership exists for a binary or too-large file
      // (package-lock.json is the canonical case). A claim is the ownership
      // signal at file granularity: claimed by this actor → commit it whole;
      // otherwise skip it VISIBLY — the dogfood fleet lost a lockfile to a
      // silent skip and shipped a broken build.
      if (opts.pathClaimedBySelf?.(file.path)) wholeFiles.push(file.path);
      else skippedBinary.push(file.path);
      continue;
    }
    // In a CONTESTED tree (another actor holds a live claim), a NEW untracked
    // file with no ownership signal beyond inference (never claimed, never
    // captured) is not committed by default — it could be an orphan or another
    // actor's leftover, and sweeping it in is how `commit --mine` silently
    // attaches a file the actor never touched. Included once claimed or with
    // --include-unclaimed, and surfaced so the skip is never silent. Solo trees
    // are exempt: with nobody else around, a new file in your tree is yours.
    const claimedAny = opts.pathClaimedBySelfAny ?? opts.pathClaimedBySelf;
    const inferenceOnlyNewFile =
      (opts.othersActive ?? false) &&
      file.isNew &&
      !(claimedAny?.(file.path) ?? false) &&
      !(opts.pathCapturedBySelf?.(file.path) ?? false);
    if (inferenceOnlyNewFile && !(opts.includeMixed ?? false)) {
      skippedUnowned.push(file.path);
      continue;
    }
    const includeMixedHere =
      (opts.includeMixed ?? false) && !(opts.pathClaimedByOther?.(file.path) ?? false);
    const built = buildOwnedText(
      file.path,
      file.oldText,
      file.newText,
      ownership.files[file.path],
      actor,
      includeMixedHere,
    );
    if (built.hasUnclaimed) hasMixed = true;
    // A torn symbol (some of its changed lines included, some excluded) can
    // never be partially committed — the committed construct would be missing
    // lines. Withhold the whole file; the tear resolves by claiming/owning the
    // rest, `--include-unclaimed`, or the other actor committing first.
    if (built.torn) {
      blockedFiles.push(file.path);
      continue;
    }
    if (built.added === 0 && built.removed === 0) {
      continue;
    }

    const committed = built.text ?? null; // null => the actor deletes the file
    const hunks = buildHunks(lineDiff(file.oldText ?? "", committed ?? ""));
    if (hunks.length === 0) continue;

    const patch = renderPatch(
      {
        relPath: file.path,
        oldText: file.oldText,
        newText: committed,
        newMode: file.oldText === null ? worktreeMode(repoRoot, file.path) : undefined,
        oldMode:
          committed === null ? headFileMode(repoRoot, file.path) ?? undefined : undefined,
      },
      hunks,
    );
    patches.push(patch);
    files.push({
      path: file.path,
      hunkCount: hunks.length,
      addedLines: built.added,
      removedLines: built.removed,
    });
    totalAdded += built.added;
    totalRemoved += built.removed;
  }

  return {
    patch: patches.join(""),
    files,
    blockedFiles,
    wholeFiles,
    skippedBinary,
    skippedUnowned,
    completeForActor: blockedFiles.length === 0,
    hasMixed,
    totalAdded,
    totalRemoved,
  };
}

export interface CommitResult {
  committed: boolean;
  commitSha?: string;
  reason?: string;
}

/**
 * Apply the selected patch to a throwaway temporary index and produce a real
 * git commit, without ever touching the user's working index or working tree.
 * On dry-run, validate that the patch applies cleanly and stop short of writing
 * any objects or moving any ref.
 */
export function commitSelection(
  repoRoot: string,
  selection: Selection,
  actor: Actor,
  message: string,
  opts: { dryRun?: boolean; defaultAuthorEmail?: string; provenance?: CommitProvenanceV1 } = {},
): CommitResult {
  if (!selection.patch.trim() && selection.wholeFiles.length === 0) {
    return { committed: false, reason: "no owned changes to commit" };
  }

  const mid = inProgressOperation(repoRoot);
  if (mid) {
    return {
      committed: false,
      reason: `a git ${mid} is in progress — finish or abort it before committing`,
    };
  }

  const base = headSha(repoRoot); // null on an unborn branch
  const tmp = mkdtempSync(join(tmpdir(), "quilt-idx-"));
  const indexFile = join(tmp, "index");
  const patchFile = join(tmp, "mine.patch");
  writeFileSync(patchFile, selection.patch);
  const env = { GIT_INDEX_FILE: indexFile };

  try {
    // Seed the temp index from HEAD (or empty on an unborn branch).
    if (base) {
      git(["read-tree", base], { cwd: repoRoot, env });
    } else {
      git(["read-tree", "--empty"], { cwd: repoRoot, env });
    }

    // Stage only the owned hunks into the temp index.
    if (selection.patch.trim()) {
      const apply = git(
        ["apply", "--cached", "--whitespace=nowarn", patchFile],
        { cwd: repoRoot, env, check: false },
      );
      if (apply.status !== 0) {
        return {
          committed: false,
          reason: `patch did not apply cleanly:\n${apply.stderr.trim()}`,
        };
      }
    }

    // Stage claimed binary/too-large files whole (worktree bytes verbatim) —
    // patches can't express them, but the temp index can hold their blobs.
    for (const rel of selection.wholeFiles) {
      const abs = join(repoRoot, rel);
      if (!existsSync(abs)) {
        git(["update-index", "--force-remove", "--", rel], { cwd: repoRoot, env, check: false });
        continue;
      }
      const sha = git(["hash-object", "-w", "--", rel], { cwd: repoRoot, env }).stdout.trim();
      const mode = worktreeMode(repoRoot, rel);
      git(["update-index", "--add", "--cacheinfo", `${mode},${sha},${rel}`], { cwd: repoRoot, env });
    }

    const tree = git(["write-tree"], { cwd: repoRoot, env }).stdout.trim();

    if (opts.dryRun) {
      return { committed: false, reason: "dry-run" };
    }

    const repoEmail = git(["config", "--get", "user.email"], {
      cwd: repoRoot,
      check: false,
    }).stdout.trim();
    const email = actor.email ?? opts.defaultAuthorEmail ?? (repoEmail || `${actor.id}@quilt.local`);
    // Author AND committer are the actor, so `git log --format='%an / %cn'`
    // attributes the commit to the actor rather than the local git config.
    const identityEnv: Record<string, string> = {
      GIT_AUTHOR_NAME: actor.displayName,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: actor.displayName,
      GIT_COMMITTER_EMAIL: email,
    };
    const parentArgs = base ? ["-p", base] : [];
    const commitMessage = opts.provenance
      ? commitMessageWithProvenance(message, { ...opts.provenance, tree, parent: base })
      : message;
    const commitSha = git(
      ["commit-tree", tree, ...parentArgs, "-F", "-"],
      { cwd: repoRoot, env: identityEnv, input: commitMessage },
    ).stdout.trim();

    // Move the branch with a compare-and-swap on the old value. If another actor
    // committed in the meantime, the CAS fails and we surface a retry instead of
    // crashing or clobbering their commit. The commit object we wrote is simply
    // left dangling (harmless, GC'd later).
    const ref = headRef(repoRoot) ?? "HEAD";
    const updateArgs = base
      ? ["update-ref", ref, commitSha, base]
      : ["update-ref", ref, commitSha];
    const updated = git(updateArgs, { cwd: repoRoot, check: false });
    if (updated.status !== 0) {
      return {
        committed: false,
        reason: "HEAD moved while committing — re-run `quilt commit --mine`",
      };
    }

    // Sync the real index for the committed paths up to the new HEAD so git
    // doesn't show the just-committed hunks as a staged "reversal". The working
    // tree is never touched, so other actors' uncommitted edits stay put. Chunk
    // the paths so a very large commit can't blow past the argv length limit.
    const paths = [...selection.files.map((f) => f.path), ...selection.wholeFiles];
    for (let i = 0; i < paths.length; i += 200) {
      git(["reset", "-q", "--", ...paths.slice(i, i + 200)], {
        cwd: repoRoot,
        check: false,
      });
    }

    return { committed: true, commitSha };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Detects an in-progress merge/rebase/cherry-pick/revert. Committing on top of a
 * half-finished operation would produce incorrect history, so `commit --mine`
 * refuses until it's resolved.
 */
function inProgressOperation(repoRoot: string): string | null {
  const named: Array<[string, string]> = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ];
  for (const [refName, label] of named) {
    if (
      git(["rev-parse", "-q", "--verify", refName], {
        cwd: repoRoot,
        check: false,
      }).status === 0
    ) {
      return label;
    }
  }
  const gitDirOut = git(["rev-parse", "--git-dir"], {
    cwd: repoRoot,
    check: false,
  });
  if (gitDirOut.status === 0) {
    const raw = gitDirOut.stdout.trim();
    const gitDir = isAbsolute(raw) ? raw : join(repoRoot, raw);
    if (
      existsSync(join(gitDir, "rebase-merge")) ||
      existsSync(join(gitDir, "rebase-apply"))
    ) {
      return "rebase";
    }
    // BISECT_LOG is a file in the git dir, not a ref — check it directly.
    if (existsSync(join(gitDir, "BISECT_LOG"))) return "bisect";
  }
  return null;
}
