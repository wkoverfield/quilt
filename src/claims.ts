import type { Store } from "./state.js";
import type { Claim } from "./types.js";

/** How long a claim is held before it auto-expires (refreshed on each claim). */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

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
    const results: ClaimResult[] = [];
    for (const raw of rawPaths) {
      const target = parseTarget(raw);

      const conflict = file.claims.find(
        (c) => c.actor !== actorId && overlaps(target, c),
      );
      if (conflict) {
        results.push({ ...target, granted: false, holder: conflict.actor });
        continue;
      }

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

/** Display label for a claim, e.g. `utils.js#formatPrice` or `utils.js`. */
export function claimLabel(c: Claim): string {
  return c.symbol ? `${c.path}#${c.symbol}` : c.path;
}
