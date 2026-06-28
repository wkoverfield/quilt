/**
 * A tiny, dependency-free line differ. One engine powers three things:
 *  - status display (which lines changed vs HEAD)
 *  - attribution (what changed since Quilt last observed the file)
 *  - patch generation for `commit --mine` (git-apply compatible unified diffs)
 *
 * Generating our own unified diffs means we never have to touch the user's
 * index to learn about untracked files, and we keep full control of which
 * hunks get committed.
 */

export type OpType = "eq" | "del" | "add";

export interface DiffOp {
  type: OpType;
  text: string;
}

export interface Hunk {
  /** 1-based start line in the old file (0 if old side is empty). */
  oldStart: number;
  oldLines: number;
  /** 1-based start line in the new file (0 if new side is empty). */
  newStart: number;
  newLines: number;
  ops: DiffOp[];
}

interface SplitResult {
  lines: string[];
  finalNewline: boolean;
}

export function splitLines(text: string): SplitResult {
  if (text === "") return { lines: [], finalNewline: true };
  const finalNewline = text.endsWith("\n");
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), finalNewline };
}

/** True if content looks binary (contains a NUL byte in the first 8000 chars). */
export function looksBinary(text: string): boolean {
  const limit = Math.min(text.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

const MAX_LCS_CELLS = 6_000_000;

/** Line-level diff via LCS. Falls back to full replace for very large inputs. */
export function lineDiff(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText).lines;
  const b = splitLines(newText).lines;

  if (a.length * b.length > MAX_LCS_CELLS) {
    const ops: DiffOp[] = [];
    for (const t of a) ops.push({ type: "del", text: t });
    for (const t of b) ops.push({ type: "add", text: t });
    return ops;
  }

  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) row[j] = next[j + 1]! + 1;
      else row[j] = Math.max(next[j]!, row[j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++]! });
  while (j < m) ops.push({ type: "add", text: b[j++]! });
  return ops;
}

/** Group a flat op list into hunks with `context` lines of surrounding equality. */
export function buildHunks(ops: DiffOp[], context = 3): Hunk[] {
  const changedIdx: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.type !== "eq") changedIdx.push(k);
  }
  if (changedIdx.length === 0) return [];

  // Group changed-op indices into clusters separated by > 2*context eq lines.
  const clusters: Array<[number, number]> = [];
  let start = changedIdx[0]!;
  let prev = changedIdx[0]!;
  for (let c = 1; c < changedIdx.length; c++) {
    const idx = changedIdx[c]!;
    if (idx - prev > context * 2) {
      clusters.push([start, prev]);
      start = idx;
    }
    prev = idx;
  }
  clusters.push([start, prev]);

  const hunks: Hunk[] = [];
  for (const [from, to] of clusters) {
    const hStart = Math.max(0, from - context);
    const hEnd = Math.min(ops.length - 1, to + context);

    let oldStart = 1;
    let newStart = 1;
    for (let k = 0; k < hStart; k++) {
      const t = ops[k]!.type;
      if (t === "eq") {
        oldStart++;
        newStart++;
      } else if (t === "del") oldStart++;
      else newStart++;
    }

    const hunkOps = ops.slice(hStart, hEnd + 1);
    let oldLines = 0;
    let newLines = 0;
    for (const op of hunkOps) {
      if (op.type === "eq") {
        oldLines++;
        newLines++;
      } else if (op.type === "del") oldLines++;
      else newLines++;
    }
    hunks.push({
      oldStart: oldLines === 0 ? oldStart - 1 : oldStart,
      oldLines,
      newStart: newLines === 0 ? newStart - 1 : newStart,
      newLines,
      ops: hunkOps,
    });
  }
  return hunks;
}

const NO_NEWLINE = "\\ No newline at end of file";

/** Render a single hunk's body (the @@ header plus content lines). */
function renderHunkBody(
  hunk: Hunk,
  oldFinalNewline: boolean,
  newFinalNewline: boolean,
  isLastHunk: boolean,
): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const lines: string[] = [header];
  for (let k = 0; k < hunk.ops.length; k++) {
    const op = hunk.ops[k]!;
    const prefix = op.type === "eq" ? " " : op.type === "del" ? "-" : "+";
    lines.push(prefix + op.text);
    if (isLastHunk && k === hunk.ops.length - 1) {
      // Emit the "no newline" marker for whichever side this final line belongs to.
      if (op.type === "del" && !oldFinalNewline) lines.push(NO_NEWLINE);
      else if (op.type === "add" && !newFinalNewline) lines.push(NO_NEWLINE);
      else if (op.type === "eq" && (!oldFinalNewline || !newFinalNewline)) {
        lines.push(NO_NEWLINE);
      }
    }
  }
  return lines.join("\n");
}

export interface PatchOptions {
  relPath: string;
  oldText: string | null;
  newText: string | null;
}

/**
 * Build a git-apply-compatible unified diff containing only the supplied hunks.
 * Pass the full hunk list to commit everything, or a filtered subset to commit
 * only the active actor's owned hunks.
 */
export function renderPatch(opts: PatchOptions, hunks: Hunk[]): string {
  if (hunks.length === 0) return "";
  const { relPath } = opts;
  const isNew = opts.oldText === null;
  const isDeleted = opts.newText === null;
  const oldFinal = opts.oldText === null ? true : splitLines(opts.oldText).finalNewline;
  const newFinal = opts.newText === null ? true : splitLines(opts.newText).finalNewline;

  const out: string[] = [];
  out.push(`diff --git a/${relPath} b/${relPath}`);
  if (isNew) out.push("new file mode 100644");
  if (isDeleted) out.push("deleted file mode 100644");
  out.push(`--- ${isNew ? "/dev/null" : "a/" + relPath}`);
  out.push(`+++ ${isDeleted ? "/dev/null" : "b/" + relPath}`);

  for (let h = 0; h < hunks.length; h++) {
    out.push(renderHunkBody(hunks[h]!, oldFinal, newFinal, h === hunks.length - 1));
  }
  return out.join("\n") + "\n";
}
