import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { git, headFileMode, headRef, headSha } from "./git.js";
import { renderPatch } from "./diff.js";
import {
  hunkChangedLines,
  type FileModel,
  type HunkOwnership,
  type WorktreeModel,
} from "./engine.js";
import type { Actor } from "./types.js";

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

const COMMITTABLE: HunkOwnership[] = ["mine"];

/**
 * Build the patch of the active actor's owned hunks. By default only pure
 * "mine" hunks are selected; pass includeMixed to also take "mixed" hunks
 * (those that sit alongside unattributed changes in the same hunk).
 */
/** git mode for a working-tree file: 100755 if executable, else 100644. */
function worktreeMode(repoRoot: string, relPath: string): string {
  try {
    const m = statSync(join(repoRoot, relPath)).mode;
    return (m & 0o111) !== 0 ? "100755" : "100644";
  } catch {
    return "100644";
  }
}

export function selectOwned(
  model: WorktreeModel,
  repoRoot: string,
  opts: { includeMixed?: boolean } = {},
): Selection {
  const committable = new Set<HunkOwnership>(COMMITTABLE);
  if (opts.includeMixed) committable.add("mixed");

  const patches: string[] = [];
  const files: SelectedFile[] = [];
  const blockedFiles: string[] = [];
  let hasMixed = false;
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const file of model.files) {
    if (file.binary) continue;
    const selected = file.hunks.filter((h) => committable.has(h.ownership));
    if (file.hunks.some((h) => h.ownership === "mixed")) hasMixed = true;
    if (selected.length === 0) continue;

    let added = 0;
    let removed = 0;
    for (const oh of selected) {
      for (const op of oh.hunk.ops) {
        if (op.type === "add") added++;
        else if (op.type === "del") removed++;
      }
    }

    const patch = renderPatch(
      {
        relPath: file.path,
        oldText: file.oldText,
        newText: file.newText,
        newMode: file.isNew ? worktreeMode(repoRoot, file.path) : undefined,
        oldMode: file.isDeleted
          ? headFileMode(repoRoot, file.path) ?? undefined
          : undefined,
      },
      selected.map((h) => h.hunk),
    );
    patches.push(patch);
    files.push({
      path: file.path,
      hunkCount: selected.length,
      addedLines: added,
      removedLines: removed,
    });
    totalAdded += added;
    totalRemoved += removed;

    // A file is "blocked" if, in addition to mine hunks, it carries hunks owned
    // by others or conflicted — we still commit only mine, but flag for review.
    if (file.hunks.some((h) => h.ownership === "other" || h.ownership === "shared")) {
      blockedFiles.push(file.path);
    }
  }

  return {
    patch: patches.join(""),
    files,
    blockedFiles,
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

export function fileHunkLines(file: FileModel): number {
  return file.hunks.reduce((n, h) => n + hunkChangedLines(h.hunk), 0);
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
    ["BISECT_LOG", "bisect"],
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
  }
  return null;
}
