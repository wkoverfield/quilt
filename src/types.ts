export type ActorType = "human" | "agent" | "bot";

export interface Actor {
  id: string;
  type: ActorType;
  displayName: string;
  email?: string;
  createdAt: string;
}

export type SessionStatus = "active" | "ended";

export interface Session {
  id: string;
  actorId: string;
  actorType: ActorType;
  repoRoot: string;
  baseSha: string | null;
  startedAt: string;
  status: SessionStatus;
  endedAt?: string;
}

export interface Config {
  version: number;
  createdAt: string;
}

export interface ActorsFile {
  actors: Actor[];
}

/**
 * Ownership of working-tree edits, keyed by repo-relative path. For each file we
 * record which actor owns each added / removed line of content. Keying on line
 * content (rather than fixed line numbers) keeps ownership stable as the file is
 * edited and line numbers shift.
 */
export interface FileOwnership {
  /** added line text -> owning actorId */
  added: Record<string, string>;
  /** removed line text -> owning actorId */
  removed: Record<string, string>;
}

export interface OwnershipFile {
  /** relPath -> ownership */
  files: Record<string, FileOwnership>;
  /**
   * Lines claimed by more than one actor, surfaced as conflicts.
   * relPath -> { line -> [actorId, ...] }
   */
  conflicts: Record<string, Record<string, string[]>>;
}

/** Last-observed content the reconciler diffs against, keyed by relPath. */
export interface ObservedFile {
  /** relPath -> file content as Quilt last saw it (null = absent/deleted). */
  files: Record<string, string | null>;
}

export interface LedgerEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

/**
 * A recorded clobber: an actor's edit overwrote uncommitted lines that another
 * actor owned. The victim's pre-clobber file content is preserved as a snapshot
 * so `quilt restore` can recover it — nothing is silently lost.
 */
export interface ClobberRecord {
  id: string;
  ts: string;
  path: string;
  /** actor whose uncommitted work was overwritten */
  victimActor: string;
  /** actor who made the overwriting edit */
  byActor: string;
  /** id of the preserved pre-clobber snapshot blob */
  snapshotId: string;
  /** a few sample lines that were overwritten, for display */
  sampleLines: string[];
  restored: boolean;
}

export interface ClobbersFile {
  clobbers: ClobberRecord[];
}

/**
 * An advisory claim: an actor reserves a file for editing so other actors know
 * to stay off it. Claims are cooperative (like git itself) — they prevent
 * collisions between agents that respect them; the clobber detector is the
 * safety net for those that don't. Claims auto-expire so a dead agent never
 * wedges a file.
 */
export interface Claim {
  path: string;
  actor: string;
  session: string | null;
  acquiredAt: string;
  /** epoch ms; the claim is ignored once now > expiresAt. */
  expiresAt: number;
}

export interface ClaimsFile {
  claims: Claim[];
}
