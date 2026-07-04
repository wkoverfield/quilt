import { basename, dirname, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * The repo-relative, forward-slash form of `p`, or null when it falls outside
 * the repo. `p` may already be relative, or absolute — Claude Code hooks and
 * MCP clients send absolute `file_path`s, and every store (claims, ownership,
 * the authorship ledger) keys on the repo-relative form, so every actor-facing
 * boundary must normalize through here before matching or recording anything.
 *
 * Tolerates the repo being reached through a filesystem alias (macOS's
 * /tmp -> /private/tmp, a symlinked home): when the plain resolve escapes,
 * both sides are compared again through realpath before giving up. Separators
 * are normalized to `/` so keys match across platforms (Windows resolves with
 * `\`, but git — and Quilt's stores — speak `/`).
 */
export function repoRelative(repoRoot: string, p: string): string | null {
  const root = resolve(repoRoot);
  const direct = relAgainst(root, resolve(root, p));
  if (direct !== null) return direct;
  try {
    return relAgainst(realpathSync(root), realExisting(resolve(root, p)));
  } catch {
    return null;
  }
}

function relAgainst(root: string, abs: string): string | null {
  if (abs === root || !abs.startsWith(root + sep)) return null;
  return abs.slice(root.length + 1).split(sep).join("/");
}

/** realpath of `abs`, resolving through the deepest EXISTING ancestor so a
 * not-yet-created file still normalizes (its parent decides where it really is). */
function realExisting(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(realExisting(parent), basename(abs));
  }
}

/** Resolves the on-disk layout of the .quilt state directory for a repo root. */
export class QuiltPaths {
  constructor(public readonly repoRoot: string) {}

  get dir(): string {
    return join(this.repoRoot, ".quilt");
  }
  get config(): string {
    return join(this.dir, "config.json");
  }
  get actors(): string {
    return join(this.dir, "actors.json");
  }
  get sessionsDir(): string {
    return join(this.dir, "sessions");
  }
  session(id: string): string {
    return join(this.sessionsDir, `${id}.json`);
  }
  /** Pointer file naming the active session id for this checkout. */
  get current(): string {
    return join(this.dir, "current");
  }
  /** Last-observed working-tree snapshot the reconciler diffs against. */
  get observed(): string {
    return join(this.dir, "observed.json");
  }
  /** Per-file, per-actor line ownership map. */
  get ownership(): string {
    return join(this.dir, "ownership.json");
  }
  get ledger(): string {
    return join(this.dir, "ledger.jsonl");
  }
  get snapshotsDir(): string {
    return join(this.dir, "snapshots");
  }
  snapshot(id: string): string {
    return join(this.snapshotsDir, `${id}.blob`);
  }
  /** Records of overwritten work preserved for `quilt restore`. */
  get clobbers(): string {
    return join(this.dir, "clobbers.json");
  }
  /** Pidfile for a running `quilt watch` process. */
  get watcherPid(): string {
    return join(this.dir, "watcher.pid");
  }
  /** Advisory file claims (reservations) held by actors. */
  get claims(): string {
    return join(this.dir, "claims.json");
  }
  /** Collision outcomes: escalations (needs a human) and resolutions (audit). */
  get outcomes(): string {
    return join(this.dir, "outcomes.json");
  }
  /** Append-only authorship log: one event per captured edit (the ledger). */
  get authorshipLog(): string {
    return join(this.dir, "authorship.log");
  }
  /** Compacted fold of old authorship events (line-ownership), so the log stays
   * bounded — reconcile reads this checkpoint plus the un-compacted log tail. */
  get authorshipCheckpoint(): string {
    return join(this.dir, "authorship.checkpoint.json");
  }
  /** Directory for pre→post hook snapshots (the pre-edit file content). */
  get hookSnapshotsDir(): string {
    return join(this.dir, "hooks");
  }
  /** A single pre→post snapshot file, keyed by a hash of actor+path. */
  hookSnapshot(key: string): string {
    return join(this.hookSnapshotsDir, `${key}.blob`);
  }
}
