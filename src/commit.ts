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
import { symbolLocator, opKeyer } from "./symbols.js";
import type { Actor, FileOwnership, OwnershipFile } from "./types.js";

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
  /** True if any selectable hunk was "mixed" (mine + unattributed). */
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
  // Key each line the same way reconcile did: adds by their scope in the
  // worktree, removals by their scope in HEAD.
  const keyOf = opKeyer(symbolLocator(path, worktreeText ?? ""), symbolLocator(path, headText ?? ""));
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  let changed = false;
  let hasOther = false;
  let hasUnclaimed = false;
  let lastFromWorktree = false; // for the committed file's trailing newline
  let blockInclude = false; // trivial lines inherit their change run's decision

  for (const op of ops) {
    const key = keyOf(op); // every op, so the line cursor stays aligned
    if (op.type === "eq") {
      out.push(op.text);
      lastFromWorktree = false;
      blockInclude = false;
      continue;
    }
    let include: boolean;
    if (isTrivialLine(op.text)) {
      include = blockInclude;
    } else {
      const owner = op.type === "add" ? owned?.added[key!] : owned?.removed[key!];
      if (owner === actor) include = true;
      else if (owner == null) {
        include = includeUnclaimed;
        hasUnclaimed = hasUnclaimed || !includeUnclaimed;
      } else {
        include = false;
        hasOther = true;
      }
      blockInclude = include;
    }
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
  }

  if (!changed) return { added: 0, removed: 0, hasOther, hasUnclaimed };
  // The actor's changes delete the file entirely.
  if (worktreeText === null && out.length === 0) {
    return { text: null, added, removed, hasOther, hasUnclaimed };
  }
  const headFinal = headText === null ? true : splitLines(headText).finalNewline;
  const wtFinal = worktreeText === null ? true : splitLines(worktreeText).finalNewline;
  const finalNL = lastFromWorktree ? wtFinal : headFinal;
  const text = out.length === 0 ? "" : out.join("\n") + (finalNL ? "\n" : "");
  return { text, added, removed, hasOther, hasUnclaimed };
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
  opts: { includeMixed?: boolean } = {},
): Selection {
  const actor = model.activeActorId;
  const patches: string[] = [];
  const files: SelectedFile[] = [];
  const blockedFiles: string[] = [];
  let hasMixed = false;
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const file of model.files) {
    if (file.binary || actor === null) continue;
    const built = buildOwnedText(
      file.path,
      file.oldText,
      file.newText,
      ownership.files[file.path],
      actor,
      opts.includeMixed ?? false,
    );
    if (built.hasUnclaimed) hasMixed = true;
    if (built.added === 0 && built.removed === 0) {
      if (built.hasOther) blockedFiles.push(file.path);
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
    if (built.hasOther) blockedFiles.push(file.path);
  }

  return { patch: patches.join(""), files, blockedFiles, hasMixed, totalAdded, totalRemoved };
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
  opts: { dryRun?: boolean } = {},
): CommitResult {
  if (!selection.patch.trim()) {
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

    const tree = git(["write-tree"], { cwd: repoRoot, env }).stdout.trim();

    if (opts.dryRun) {
      return { committed: false, reason: "dry-run" };
    }

    const email = actor.email ?? `${actor.id}@quilt.local`;
    // Author AND committer are the actor, so `git log --format='%an / %cn'`
    // attributes the commit to the actor rather than the local git config.
    const identityEnv: Record<string, string> = {
      GIT_AUTHOR_NAME: actor.displayName,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: actor.displayName,
      GIT_COMMITTER_EMAIL: email,
    };
    const parentArgs = base ? ["-p", base] : [];
    const commitSha = git(
      ["commit-tree", tree, ...parentArgs, "-m", message],
      { cwd: repoRoot, env: identityEnv },
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
    const paths = selection.files.map((f) => f.path);
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
