import type { Store } from "./state.js";
import type { Claim } from "./types.js";

/** How long a claim is held before it auto-expires (refreshed on each claim). */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

export interface ClaimResult {
  path: string;
  granted: boolean;
  /** when denied, the actor currently holding the path */
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
 * Acquire advisory claims on paths for an actor. A path already held by a
 * different (live) actor is denied; one held by the same actor (or expired) is
 * (re)granted and its TTL refreshed. All-or-nothing is intentionally NOT used —
 * each path is reported independently so a caller can proceed with what it got.
 */
export function acquireClaims(
  store: Store,
  actorId: string,
  sessionId: string | null,
  paths: string[],
  now: number,
): ClaimResult[] {
  return store.withLock(() => {
    const file = store.readClaims();
    file.claims = active(file.claims, now);
    const results: ClaimResult[] = [];
    for (const raw of paths) {
      const path = normalizePath(raw);
      const existing = file.claims.find((c) => c.path === path);
      if (existing && existing.actor !== actorId) {
        results.push({ path, granted: false, holder: existing.actor });
        continue;
      }
      if (existing) {
        existing.expiresAt = now + CLAIM_TTL_MS;
        existing.session = sessionId;
      } else {
        file.claims.push({
          path,
          actor: actorId,
          session: sessionId,
          acquiredAt: new Date(now).toISOString(),
          expiresAt: now + CLAIM_TTL_MS,
        });
      }
      results.push({ path, granted: true });
    }
    store.writeClaims(file);
    return results;
  });
}

/** Release an actor's claims. With no paths, release ALL of the actor's claims. */
export function releaseClaims(
  store: Store,
  actorId: string,
  paths: string[] | null,
): number {
  const norm = paths === null ? null : paths.map(normalizePath);
  return store.withLock(() => {
    const file = store.readClaims();
    const before = file.claims.length;
    file.claims = file.claims.filter((c) => {
      if (c.actor !== actorId) return true;
      if (norm === null) return false; // release all of this actor's claims
      return !norm.includes(c.path);
    });
    store.writeClaims(file);
    return before - file.claims.length;
  });
}

/** Currently-active (non-expired) claims. */
export function listClaims(store: Store, now: number): Claim[] {
  return active(store.readClaims().claims, now);
}
