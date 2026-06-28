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

/**
 * True if content looks binary (contains a NUL byte). UTF-8 decoding preserves
 * NUL bytes, so scanning the decoded string is reliable for detection; we scan
 * up to 1 MB so a binary file whose first kilobytes happen to be NUL-free (e.g.
 * a media file with a text header) is still caught.
 */
export function looksBinary(text: string): boolean {
  const limit = Math.min(text.length, 1_000_000);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

/**
 * Structural/whitespace-only lines (blank lines, lone braces/brackets/punctuation)
 * are excluded from per-line ownership: they recur identically all over a file, so
 * content-keyed attribution would otherwise raise false conflicts when two actors
 * each add a `}` in unrelated places. Such lines ride along with the substantive
 * lines in their hunk instead of being owned on their own.
 */
export function isTrivialLine(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  return /^[(){}\[\];,]+$/.test(t);
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

/**
 * Render a single hunk's body (the @@ header plus content lines), correctly
 * placing "\ No newline at end of file" markers. The tricky case: when a file
 * has no trailing newline and the last line is a context line that the other
 * side extends past, git splits that line into a remove + add so each side can
 * carry its own newline status. We reproduce that exactly so `git apply` accepts
 * the patch.
 */
function renderHunkBody(
  hunk: Hunk,
  oldFinalNewline: boolean,
  newFinalNewline: boolean,
  totalOld: number,
  totalNew: number,
): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const lines: string[] = [header];
  const ops = hunk.ops;

  // Whether THIS hunk actually reaches the final line of each side's file.
  // Computed from line coverage, not hunk ordering, so a "no newline" marker is
  // never emitted mid-file when committing a subset of a file's hunks.
  const reachesOldEof =
    hunk.oldLines > 0 && hunk.oldStart + hunk.oldLines - 1 === totalOld;
  const reachesNewEof =
    hunk.newLines > 0 && hunk.newStart + hunk.newLines - 1 === totalNew;

  // The last line belonging to each side within this hunk.
  let lastOld = -1;
  let lastNew = -1;
  for (let k = 0; k < ops.length; k++) {
    const t = ops[k]!.type;
    if (t === "eq" || t === "del") lastOld = k;
    if (t === "eq" || t === "add") lastNew = k;
  }

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]!;
    const isOldEnd = reachesOldEof && k === lastOld;
    const isNewEnd = reachesNewEof && k === lastNew;
    const oldEnds = isOldEnd && !oldFinalNewline;
    const newEnds = isNewEnd && !newFinalNewline;

    if (op.type === "del") {
      lines.push("-" + op.text);
      if (oldEnds) lines.push(NO_NEWLINE);
    } else if (op.type === "add") {
      lines.push("+" + op.text);
      if (newEnds) lines.push(NO_NEWLINE);
    } else {
      // Context line. If only one side ends here without a newline, split it
      // into a remove + add so each side carries its own newline status.
      if (isOldEnd && isNewEnd && oldEnds === newEnds) {
        lines.push(" " + op.text);
        if (oldEnds) lines.push(NO_NEWLINE);
      } else if (oldEnds || newEnds) {
        lines.push("-" + op.text);
        if (oldEnds) lines.push(NO_NEWLINE);
        lines.push("+" + op.text);
        if (newEnds) lines.push(NO_NEWLINE);
      } else {
        lines.push(" " + op.text);
      }
    }
  }
  return lines.join("\n");
}

export interface PatchOptions {
  relPath: string;
  oldText: string | null;
  newText: string | null;
  /** git mode for a newly added file (defaults to 100644). */
  newMode?: string;
  /** git mode the file had at HEAD, for a deletion (defaults to 100644). */
  oldMode?: string;
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

  const totalOld = opts.oldText === null ? 0 : splitLines(opts.oldText).lines.length;
  const totalNew = opts.newText === null ? 0 : splitLines(opts.newText).lines.length;

  const out: string[] = [];
  out.push(`diff --git a/${relPath} b/${relPath}`);
  if (isNew) out.push(`new file mode ${opts.newMode ?? "100644"}`);
  if (isDeleted) out.push(`deleted file mode ${opts.oldMode ?? "100644"}`);
  out.push(`--- ${isNew ? "/dev/null" : "a/" + relPath}`);
  out.push(`+++ ${isDeleted ? "/dev/null" : "b/" + relPath}`);

  for (const hunk of hunks) {
    out.push(renderHunkBody(hunk, oldFinal, newFinal, totalOld, totalNew));
  }
  return out.join("\n") + "\n";
}
