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
export function git(args: string[], opts: GitRunOptions): GitResult {
  const res = spawnSync("git", args, {
    cwd: opts.cwd,
    input: opts.input,
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
    input: opts.input,
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

/** Absolute path to the repository working-tree root, or null if not a repo. */
export function repoRoot(cwd: string): string | null {
  const res = git(["rev-parse", "--show-toplevel"], { cwd, check: false });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
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
 * Paths that differ between HEAD and the working tree (tracked + untracked),
 * relative to the repo root. Uses NUL-delimited porcelain for safety.
 */
export function changedPaths(cwd: string): string[] {
  const res = git(["status", "--porcelain=1", "-z", "--untracked-files=all"], {
    cwd,
  });
  const out: string[] = [];
  const parts = res.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    // Format: XY<space>path  (XY = two status chars)
    const status = entry.slice(0, 2);
    let path = entry.slice(3);
    // Renames carry "old -> new"; porcelain -z puts old path in the next field.
    if (status[0] === "R" || status[1] === "R") {
      i++; // consume the old-path field
    }
    // Never attribute Quilt's own state directory.
    if (path && path !== ".quilt" && !path.startsWith(".quilt/")) out.push(path);
  }
  return out;
}

/** True if the path is tracked by git at HEAD or the index. */
export function isTracked(cwd: string, relPath: string): boolean {
  const res = git(["ls-files", "--error-unmatch", "--", relPath], {
    cwd,
    check: false,
  });
  return res.status === 0;
}
