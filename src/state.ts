import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  openSync,
  closeSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { QuiltPaths } from "./paths.js";
import type {
  Actor,
  ActorsFile,
  Config,
  LedgerEvent,
  ObservedFile,
  OwnershipFile,
  Session,
} from "./types.js";

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** Reads and writes everything under .quilt/ for a repo. */
export class Store {
  readonly paths: QuiltPaths;

  constructor(repoRoot: string) {
    this.paths = new QuiltPaths(repoRoot);
  }

  get initialized(): boolean {
    return existsSync(this.paths.config);
  }

  ensureDirs(): void {
    mkdirSync(this.paths.dir, { recursive: true });
    mkdirSync(this.paths.sessionsDir, { recursive: true });
    mkdirSync(this.paths.snapshotsDir, { recursive: true });
    // Keep Quilt's own state out of git — it is local-first by default.
    writeFileSync(join(this.paths.dir, ".gitignore"), "*\n");
  }

  // --- config ---
  readConfig(): Config | null {
    if (!existsSync(this.paths.config)) return null;
    return readJson<Config | null>(this.paths.config, null);
  }
  writeConfig(config: Config): void {
    writeJson(this.paths.config, config);
  }

  // --- actors ---
  readActors(): Actor[] {
    return readJson<ActorsFile>(this.paths.actors, { actors: [] }).actors;
  }
  upsertActor(actor: Actor): void {
    const actors = this.readActors();
    const idx = actors.findIndex((a) => a.id === actor.id);
    if (idx >= 0) actors[idx] = actor;
    else actors.push(actor);
    writeJson(this.paths.actors, { actors } satisfies ActorsFile);
  }
  findActor(id: string): Actor | null {
    return this.readActors().find((a) => a.id === id) ?? null;
  }

  // --- sessions ---
  readSession(id: string): Session | null {
    return readJson<Session | null>(this.paths.session(id), null);
  }
  writeSession(session: Session): void {
    writeJson(this.paths.session(session.id), session);
  }
  /** All active sessions for this repo. */
  activeSessions(): Session[] {
    const dir = this.paths.sessionsDir;
    if (!existsSync(dir)) return [];
    const out: Session[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const s = this.readSession(f.replace(/\.json$/, ""));
      if (s && s.status === "active") out.push(s);
    }
    return out;
  }

  // --- current session pointer ---
  readCurrentSessionId(): string | null {
    const envSession = process.env.QUILT_SESSION;
    if (envSession) return envSession;
    if (!existsSync(this.paths.current)) return null;
    return readFileSync(this.paths.current, "utf8").trim() || null;
  }
  writeCurrentSessionId(id: string): void {
    writeFileSync(this.paths.current, id + "\n");
  }
  clearCurrentSessionId(): void {
    rmSync(this.paths.current, { force: true });
  }

  // --- observed snapshot ---
  readObserved(): ObservedFile {
    return readJson<ObservedFile>(this.paths.observed, { files: {} });
  }
  writeObserved(observed: ObservedFile): void {
    writeJson(this.paths.observed, observed);
  }

  // --- ownership ---
  readOwnership(): OwnershipFile {
    return readJson<OwnershipFile>(this.paths.ownership, {
      files: {},
      conflicts: {},
    });
  }
  writeOwnership(ownership: OwnershipFile): void {
    writeJson(this.paths.ownership, ownership);
  }

  // --- ledger ---
  appendLedger(event: LedgerEvent): void {
    appendFileSync(this.paths.ledger, JSON.stringify(event) + "\n");
  }

  /**
   * Run `fn` while holding an exclusive lock on .quilt, so concurrent actor
   * processes can't interleave read-modify-write of ownership/observed state
   * and lose each other's claims. The lock auto-expires after 10s (a crashed
   * process never wedges the repo); after ~5s of contention we proceed anyway
   * rather than block a developer's command indefinitely.
   */
  withLock<T>(fn: () => T): T {
    const lockPath = this.paths.dir + "/lock";
    const start = Date.now();
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(lockPath, "wx");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 10_000) {
            rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          continue; // lock vanished between open and stat; retry
        }
        if (Date.now() - start > 5_000) break; // give up waiting, proceed best-effort
        sleepSync(25);
      }
    }
    try {
      return fn();
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
        rmSync(lockPath, { force: true });
      }
    }
  }
}

/** Synchronous sleep that blocks without busy-spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
