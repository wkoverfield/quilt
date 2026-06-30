import { resolve, sep } from "node:path";
import type { Store } from "./state.js";
import type { Claim, Block } from "./types.js";

/** How long a claim is held before it auto-expires (refreshed on each claim). */
export const CLAIM_TTL_MS = 10 * 60 * 1000;
/** How long a recorded denial lingers without a retry. Short — a block is news. */
export const BLOCK_TTL_MS = 90 * 1000;

export interface ClaimTarget {
  path: string;
  symbol?: string;
}

export interface ClaimResult {
  path: string;
  symbol?: string;
  granted: boolean;
  /** when denied, the actor currently holding the conflicting reservation */
  holder?: string;
  /** when denied for a non-conflict reason (e.g. a path outside the repo) */
  reason?: "outside-repo";
}

/**
 * True if `p` resolves outside `repoRoot` (absolute path or `../` traversal).
 * Claim targets are actor-controlled, so this gates them before any filesystem
 * read keyed on a claim path (push-awareness reads claimed files) can escape the
 * repository. Mirrors the guard the restore path already applies to writes.
 */
function escapesRepo(repoRoot: string, p: string): boolean {
  const root = resolve(repoRoot);
  const abs = resolve(root, p);
  return abs !== root && !abs.startsWith(root + sep);
}

function active(claims: Claim[], now: number): Claim[] {
  return claims.filter((c) => c.expiresAt > now);
}

/** Normalize a claim path so `./foo` and `foo` don't become separate claims. */
function normalizePath(p: string): string {
  return p.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/**
 * Parse a claim target string. `utils.js#formatPrice` reserves just the
 * `formatPrice` symbol; `utils.js` reserves the whole file. The path is
 * normalized; an empty symbol is treated as a whole-file claim.
 */
export function parseTarget(raw: string): ClaimTarget {
  const hash = raw.indexOf("#");
  if (hash === -1) return { path: normalizePath(raw) };
  const path = normalizePath(raw.slice(0, hash));
  const symbol = raw.slice(hash + 1).trim();
  return symbol ? { path, symbol } : { path };
}

/** Two reservations on the same file overlap unless they name distinct symbols. */
function overlaps(a: ClaimTarget, b: Claim): boolean {
  if (a.path !== b.path) return false;
  // A whole-file reservation on either side covers everything in the file.
  if (a.symbol === undefined || b.symbol === undefined) return true;
  return a.symbol === b.symbol;
}

function label(t: ClaimTarget): string {
  return t.symbol ? `${t.path}#${t.symbol}` : t.path;
}

/**
 * Acquire advisory claims for an actor. A reservation that overlaps one held by
 * a different (live) actor is denied; one the actor already holds (or that has
 * expired) is (re)granted and its TTL refreshed. Symbol claims on the same file
 * only collide when they name the same symbol, so agents editing different
 * functions in one file don't contend. Each target is reported independently.
 */
export function acquireClaims(
  store: Store,
  actorId: string,
  sessionId: string | null,
  rawPaths: string[],
  now: number,
): ClaimResult[] {
  return store.withLock(() => {
    const file = store.readClaims();
    file.claims = active(file.claims, now);
    file.blocks = (file.blocks ?? []).filter((b) => b.expiresAt > now);
    const sameTarget = (b: Block, t: ClaimTarget) =>
      b.actor === actorId && b.path === t.path && b.symbol === t.symbol;
    const results: ClaimResult[] = [];
    for (const raw of rawPaths) {
      const target = parseTarget(raw);

      // Never let an actor reserve (and thereby cause a read of) a path outside
      // the repo. Absolute paths and `../` traversal are rejected outright.
      if (escapesRepo(store.paths.repoRoot, target.path)) {
        results.push({ ...target, granted: false, reason: "outside-repo" });
        continue;
      }

      const conflict = file.claims.find(
        (c) => c.actor !== actorId && overlaps(target, c),
      );
      if (conflict) {
        results.push({ ...target, granted: false, holder: conflict.actor });
        // Record the denial so the fleet view can show who's blocked on whom.
        const prior = file.blocks.find((b) => sameTarget(b, target));
        if (prior) {
          prior.holder = conflict.actor;
          prior.expiresAt = now + BLOCK_TTL_MS;
        } else {
          file.blocks.push({
            path: target.path,
            symbol: target.symbol,
            actor: actorId,
            holder: conflict.actor,
            blockedAt: new Date(now).toISOString(),
            expiresAt: now + BLOCK_TTL_MS,
          });
        }
        continue;
      }
      // Granted: this actor is no longer blocked on this target.
      file.blocks = file.blocks.filter((b) => !sameTarget(b, target));

      const own = file.claims.find(
        (c) =>
          c.actor === actorId &&
          c.path === target.path &&
          c.symbol === target.symbol,
      );
      if (own) {
        own.expiresAt = now + CLAIM_TTL_MS;
        own.session = sessionId;
      } else {
        file.claims.push({
          path: target.path,
          symbol: target.symbol,
          actor: actorId,
          session: sessionId,
          acquiredAt: new Date(now).toISOString(),
          expiresAt: now + CLAIM_TTL_MS,
        });
      }
      results.push({ ...target, granted: true });
    }
    store.writeClaims(file);
    return results;
  });
}

/**
 * Release an actor's claims. With no targets, release ALL of the actor's claims.
 * A target naming a file (no symbol) releases every claim the actor holds on
 * that file (whole-file and any symbol claims).
 */
export function releaseClaims(
  store: Store,
  actorId: string,
  rawPaths: string[] | null,
): number {
  const targets = rawPaths === null ? null : rawPaths.map(parseTarget);
  return store.withLock(() => {
    const file = store.readClaims();
    const before = file.claims.length;
    file.claims = file.claims.filter((c) => {
      if (c.actor !== actorId) return true;
      if (targets === null) return false; // release all of this actor's claims
      return !targets.some(
        (t) =>
          t.path === c.path &&
          (t.symbol === undefined || t.symbol === c.symbol),
      );
    });
    store.writeClaims(file);
    return before - file.claims.length;
  });
}

/** Currently-active (non-expired) claims. */
export function listClaims(store: Store, now: number): Claim[] {
  return active(store.readClaims().claims, now);
}

/**
 * Active claim denials — who is blocked on whom. Only surfaced while the denial
 * is fresh AND the holder still holds an overlapping claim (a block whose holder
 * has released is no longer real, so it's dropped).
 */
export function listBlocks(store: Store, now: number): Block[] {
  const file = store.readClaims();
  const claims = active(file.claims, now);
  return (file.blocks ?? [])
    .filter((b) => b.expiresAt > now)
    .filter((b) =>
      claims.some((c) => c.actor === b.holder && overlaps({ path: b.path, symbol: b.symbol }, c)),
    );
}

/** Display label for a claim, e.g. `utils.js#formatPrice` or `utils.js`. */
export function claimLabel(c: Claim): string {
  return c.symbol ? `${c.path}#${c.symbol}` : c.path;
}
