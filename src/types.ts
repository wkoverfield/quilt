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
 * record which actor owns each added / removed line. The key is `symbol\0text`
 * (see symbols.ts#ownKey): the enclosing symbol scope plus the line content.
 * Keying on content (not fixed line numbers) keeps ownership stable as line
 * numbers shift; adding the symbol scope stops identical lines in two different
 * functions (e.g. `  return null;`) from collapsing to one owner.
 */
export interface FileOwnership {
  /** ownership key (symbol\0text) -> owning actorId, for added lines */
  added: Record<string, string>;
  /** ownership key (symbol\0text) -> owning actorId, for removed lines */
  removed: Record<string, string>;
}

export interface OwnershipFile {
  /** relPath -> ownership */
  files: Record<string, FileOwnership>;
  /**
   * Lines claimed by more than one actor, surfaced as conflicts.
   * relPath -> { symbol\0text -> [actorId, ...] }
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
  /**
   * Optional symbol within the file (e.g. a function or class name). A claim
   * with no symbol reserves the whole file; symbol claims let multiple actors
   * reserve different symbols in the same file without contending.
   */
  symbol?: string;
  actor: string;
  session: string | null;
  acquiredAt: string;
  /** epoch ms; the claim is ignored once now > expiresAt. */
  expiresAt: number;
  /**
   * Optional short "why" for this claim (e.g. "PERF-412: raise for peak load").
   * Surfaced to an actor whose overlapping claim is denied, so it can resolve a
   * collision from the holder's intent instead of guessing or blocking.
   */
  intent?: string;
}

/**
 * A recorded claim denial: `actor` tried to reserve a target that `holder`
 * already has. Short-lived (refreshed on each denied retry, expires if the actor
 * stops trying) and only surfaced while the holder still holds it — so the fleet
 * view can show who is blocked on whom.
 */
export interface Block {
  path: string;
  symbol?: string;
  actor: string;
  holder: string;
  blockedAt: string;
  /** epoch ms; ignored once now > expiresAt. */
  expiresAt: number;
  /** The holder's claim intent at denial time, so the block explains itself. */
  holderIntent?: string;
}

export interface ClaimsFile {
  claims: Claim[];
  blocks?: Block[];
}

/**
 * How a collision was handled. An agent that hits a clash it can't reconcile
 * `escalated`s it (a genuine conflict — needs a human); one that sews it records
 * a `resolved` outcome (the audit trail). The latest outcome per target wins: an
 * escalation is "open" (needs you) until a later resolution closes it.
 */
export interface Outcome {
  id: string;
  /** path or path#symbol the collision is on */
  target: string;
  kind: "escalated" | "resolved";
  /** who recorded it (the agent, or a human) */
  actor: string;
  /** why it needs a human (escalated) or what was done to sew it (resolved) */
  note?: string;
  ts: string;
}

export interface OutcomesFile {
  outcomes: Outcome[];
}
