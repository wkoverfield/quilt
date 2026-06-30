import { join } from "node:path";

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
}
