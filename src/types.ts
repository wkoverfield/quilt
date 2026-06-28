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
