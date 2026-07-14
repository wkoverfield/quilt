import { spawnSync } from "node:child_process";

export interface GitRunOptions {
  cwd: string;
  /** Extra environment variables (merged over process.env). */
  env?: Record<string, string | undefined>;
  /** Data to write to stdin. */
  input?: string | Buffer;
  /** If true, a non-zero exit throws. Defaults to true. */
  check?: boolean;
}

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a git command. Quilt shells out to git for all repository operations so
 * that git remains the single source of truth (Principle 1: trust git).
 */
/** spawnSync is set to `encoding: "buffer"`, which it would (wrongly) try to use
 * to encode a string stdin — so coerce, letting callers pass a string or Buffer
 * as the `input` type promises. */
function toBufferInput(input: string | Buffer | undefined): Buffer | undefined {
  return typeof input === "string" ? Buffer.from(input, "utf8") : input;
}

export function git(args: string[], opts: GitRunOptions): GitResult {
  const res = spawnSync("git", args, {
    cwd: opts.cwd,
    input: toBufferInput(opts.input),
    encoding: "buffer",
    env: { ...process.env, ...opts.env },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`failed to run git ${args.join(" ")}: ${res.error.message}`);
  }
  const stdout = res.stdout ? res.stdout.toString("utf8") : "";
  const stderr = res.stderr ? res.stderr.toString("utf8") : "";
  const status = res.status ?? 1;
  if (opts.check !== false && status !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${status}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return { status, stdout, stderr };
}

/** Return raw bytes from a git command (for binary-safe blob reads). */
export function gitBytes(args: string[], opts: GitRunOptions): Buffer {
  const res = spawnSync("git", args, {
    cwd: opts.cwd,
    input: toBufferInput(opts.input),
    encoding: "buffer",
    env: { ...process.env, ...opts.env },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`failed to run git ${args.join(" ")}: ${res.error.message}`);
  }
  if ((res.status ?? 1) !== 0 && opts.check !== false) {
    const stderr = res.stderr ? res.stderr.toString("utf8") : "";
    throw new Error(`git ${args.join(" ")} exited ${res.status}: ${stderr.trim()}`);
  }
  return res.stdout ?? Buffer.alloc(0);
}

/** The raw `git --version` line (e.g. "git version 2.50.1"), or null if git
 * can't be run at all. Used by `quilt doctor` to catch a stale system git
 * (pre-2.18 breaks the `status --no-renames` flag Quilt relies on). */
export function gitVersionString(): string | null {
  const res = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/** Absolute path to the repository working-tree root, or null if not a repo. */
export function repoRoot(cwd: string): string | null {
  const res = git(["rev-parse", "--show-toplevel"], { cwd, check: false });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/** Is `relPath` ignored by git? Covers the repo's .gitignore, .git/info/exclude
 * and the user's global excludesfile, so a user who already ignores agent config
 * machine-wide is never told to ignore it again. */
export function pathIsIgnored(cwd: string, relPath: string): boolean {
  return git(["check-ignore", "-q", "--", relPath], { cwd, check: false }).status === 0;
}

/** Is `relPath` in the index? A tracked file is already part of the repo's
 * committed surface, so writing to it exposes nothing new. */
export function pathIsTracked(cwd: string, relPath: string): boolean {
  return git(["ls-files", "--error-unmatch", "--", relPath], { cwd, check: false }).status === 0;
}

/** Does the repo have an `origin` remote? Gates the (slower) visibility probe:
 * a repo with no remote can't be published, so there is nothing to look up. */
export function hasOriginRemote(cwd: string): boolean {
  const res = git(["remote", "get-url", "origin"], { cwd, check: false });
  return res.status === 0 && res.stdout.trim() !== "";
}

/** Current HEAD commit SHA, or null on an unborn branch (no commits yet). */
export function headSha(cwd: string): string | null {
  const res = git(["rev-parse", "HEAD"], { cwd, check: false });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/** Symbolic ref of the current branch (e.g. refs/heads/main), or null if detached. */
export function headRef(cwd: string): string | null {
  const res = git(["symbolic-ref", "-q", "HEAD"], { cwd, check: false });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/** Short HEAD SHA for display, or "(no commits)" when unborn. */
export function shortHead(cwd: string): string {
  const sha = headSha(cwd);
  if (!sha) return "(no commits)";
  return sha.slice(0, 7);
}

/**
 * Read a file's committed content at HEAD. Returns null if the path does not
 * exist at HEAD (i.e. it is a newly added file).
 */
export function headBlob(cwd: string, relPath: string): string | null {
  const sha = headSha(cwd);
  if (!sha) return null;
  const res = git(["show", `HEAD:${relPath}`], { cwd, check: false });
  if (res.status !== 0) return null;
  return res.stdout;
}

/**
 * Read many files' HEAD content in ONE `git cat-file --batch` instead of a
 * subprocess per path — the reconcile hot path (see bench/authorship/LATENCY.md).
 * Returns `path -> content` (utf8), or `null` for a path absent at HEAD (a new
 * file) or that doesn't resolve to a blob. Order-correlated: cat-file emits one
 * record per input line in order, so responses map back to `paths` by index.
 * Parsed byte-wise off the raw buffer so blob sizes stay correct for any bytes.
 */
export function headBlobs(cwd: string, paths: string[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  if (paths.length === 0) return result;
  const sha = headSha(cwd);
  if (!sha) {
    for (const p of paths) result.set(p, null); // unborn branch: nothing at HEAD
    return result;
  }
  const input = paths.map((p) => `HEAD:${p}`).join("\n") + "\n";
  const out = gitBytes(["cat-file", "--batch"], { cwd, input });
  let off = 0;
  for (const p of paths) {
    const nl = out.indexOf(0x0a, off); // end of this record's header line
    if (nl === -1) {
      result.set(p, null); // truncated/short output — treat as absent
      continue;
    }
    const header = out.toString("utf8", off, nl);
    off = nl + 1;
    const tokens = header.split(" ");
    // Missing object: "<input> missing" (the input path may contain spaces, but
    // the final token is always "missing"). Found blob: "<oid> blob <size>".
    if (tokens[tokens.length - 1] === "missing" || tokens[tokens.length - 2] !== "blob") {
      result.set(p, null);
      if (tokens[tokens.length - 1] !== "missing") {
        // A non-blob (e.g. a tree) still has <size> bytes of body to skip over.
        const size = Number(tokens[tokens.length - 1]);
        if (Number.isFinite(size)) off += size + 1;
      }
      continue;
    }
    const size = Number(tokens[tokens.length - 1]);
    result.set(p, out.toString("utf8", off, off + size));
    off += size + 1; // skip the body and its trailing LF
  }
  return result;
}

/**
 * Paths that differ between HEAD and the working tree (tracked + untracked),
 * relative to the repo root. Uses NUL-delimited porcelain for safety.
 */
export function changedPaths(cwd: string): string[] {
  // --no-renames makes a rename surface as a delete + add, which Quilt can
  // attribute and commit independently. With rename detection on, the old path
  // is hidden and `commit --mine` would duplicate the file instead of moving it.
  const res = git(
    ["status", "--porcelain=1", "-z", "--untracked-files=all", "--no-renames"],
    { cwd },
  );
  const out: string[] = [];
  const parts = res.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    // Format: XY<space>path  (XY = two status chars)
    const status = entry.slice(0, 2);
    let path = entry.slice(3);
    // Defensive: `--no-renames` above makes git emit a rename as delete+add, so
    // `R` shouldn't appear — but if it ever does, porcelain -z puts the old path
    // in the next NUL field, so consume it rather than treat it as a real path.
    if (status[0] === "R" || status[1] === "R") {
      i++; // consume the old-path field
    }
    // Never attribute Quilt's own state directory.
    if (path && path !== ".quilt" && !path.startsWith(".quilt/")) out.push(path);
  }
  return out;
}

/**
 * The git file mode of a path at HEAD (e.g. "100644", "100755", "120000" for a
 * symlink), or null if the path does not exist at HEAD. Used so `commit --mine`
 * preserves the executable bit and symlink type when staging deletes/changes.
 */
export function headFileMode(cwd: string, relPath: string): string | null {
  const sha = headSha(cwd);
  if (!sha) return null;
  const res = git(["ls-tree", "HEAD", "--", relPath], { cwd, check: false });
  if (res.status !== 0) return null;
  const line = res.stdout.trim();
  if (!line) return null;
  // Format: "<mode> <type> <sha>\t<path>"
  const mode = line.split(/\s+/)[0];
  return mode ?? null;
}
