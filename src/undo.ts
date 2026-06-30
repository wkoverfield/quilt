import { isTrivialLine, lineDiff, splitLines } from "./diff.js";
import type { WorktreeModel } from "./engine.js";
import type { FileOwnership, OwnershipFile } from "./types.js";

/**
 * Reconstruct a file with one actor's uncommitted changes BACKED OUT, keeping
 * everyone else's: omit the actor's added lines, restore the head lines it
 * removed, and leave every other actor's (and unclaimed) changes exactly as they
 * are in the working tree. This is the inverse of commit.ts's buildOwnedText —
 * "everyone except this actor" instead of "only this actor" — and it's what lets
 * you back out one rogue agent's work from a shared checkout without touching the
 * others'. Trivial structural lines (braces) follow their change run, same as the
 * commit path.
 */
function buildWithoutActor(
  headText: string | null,
  worktreeText: string | null,
  owned: FileOwnership | undefined,
  actor: string,
): { text: string | null; reverted: number } {
  const ops = lineDiff(headText ?? "", worktreeText ?? "");
  const out: string[] = [];
  let reverted = 0;
  let lastFromWorktree = false;
  let blockRevert = false; // trivial lines inherit their run's revert decision

  for (const op of ops) {
    if (op.type === "eq") {
      out.push(op.text);
      lastFromWorktree = false;
      blockRevert = false;
      continue;
    }
    let revert: boolean;
    if (isTrivialLine(op.text)) {
      revert = blockRevert;
    } else {
      const owner = op.type === "add" ? owned?.added[op.text] : owned?.removed[op.text];
      revert = owner === actor; // back out ONLY this actor's lines
      blockRevert = revert;
    }
    if (op.type === "add") {
      if (revert) {
        reverted++; // drop the actor's added line
      } else {
        out.push(op.text); // keep another actor's / unclaimed add
        lastFromWorktree = true;
      }
    } else {
      if (revert) {
        out.push(op.text); // restore the head line the actor removed
        reverted++;
        lastFromWorktree = false;
      }
      // else: another actor's / unclaimed removal — leave it removed (omit head line)
    }
  }

  if (reverted === 0) return { text: worktreeText, reverted: 0 };
  // Undoing a file the actor CREATED (no head) whose every line was theirs: the
  // file should cease to exist, not be left as an empty stub.
  if (headText === null && out.length === 0) return { text: null, reverted };
  if (worktreeText === null && out.length === 0) return { text: null, reverted };
  const headFinal = headText === null ? true : splitLines(headText).finalNewline;
  const wtFinal = worktreeText === null ? true : splitLines(worktreeText).finalNewline;
  const finalNL = lastFromWorktree ? wtFinal : headFinal;
  const text = out.length === 0 ? "" : out.join("\n") + (finalNL ? "\n" : "");
  return { text, reverted };
}

export interface UndoFile {
  path: string;
  /** Reconstructed content with the actor's changes backed out (null = delete). */
  text: string | null;
  /** Number of the actor's line-changes reverted. */
  reverted: number;
}

export interface UndoPlan {
  actor: string;
  files: UndoFile[];
  totalReverted: number;
  /** Binary files the actor changed that can't be line-reverted. */
  skippedBinary: string[];
}

/**
 * Plan backing out an actor's uncommitted working-tree changes. Pure: computes
 * the new content per file without writing anything (the caller writes, or
 * previews on --dry-run).
 */
export function planUndo(model: WorktreeModel, ownership: OwnershipFile, actor: string): UndoPlan {
  const files: UndoFile[] = [];
  const skippedBinary: string[] = [];
  let totalReverted = 0;

  for (const file of model.files) {
    const owns =
      ownership.files[file.path] &&
      (Object.values(ownership.files[file.path]!.added).includes(actor) ||
        Object.values(ownership.files[file.path]!.removed).includes(actor));
    if (!owns) continue;
    if (file.binary) {
      skippedBinary.push(file.path);
      continue;
    }
    const built = buildWithoutActor(file.oldText, file.newText, ownership.files[file.path], actor);
    if (built.reverted === 0) continue;
    files.push({ path: file.path, text: built.text, reverted: built.reverted });
    totalReverted += built.reverted;
  }

  return { actor, files, totalReverted, skippedBinary };
}
