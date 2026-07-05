import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./state.js";
import type { Claim, Block, Waiter, ClaimsFile } from "./types.js";
import { repoRelative } from "./paths.js";
import { canParse, closestName, parseSymbols } from "./symbols.js";

/** How long a claim is held before it auto-expires. 30 minutes: the dogfood
 * fleet held 10-minute leases that silently lapsed mid-task (8 of 12 expired
 * while an actor was still editing, one lapsed while an actor was blocked
 * waiting on someone ELSE's claim). Renewal on activity (see reconcile) is
 * the real protection; the longer floor covers actors between quilt calls. */
export const CLAIM_TTL_MS = 30 * 60 * 1000;
/** How long a recorded denial lingers without a retry. Short — a block is news. */
export const BLOCK_TTL_MS = 90 * 1000;
/** How long a queued interest survives without the actor coming back. Longer
 * than a claim — a waiter is often off doing other work — but bounded so an
 * agent that never returns can't wedge the queue behind it. */
export const WAITER_TTL_MS = 60 * 60 * 1000;

export interface ClaimTarget {
  path: string;
  symbol?: string;
  /** directory claim (`convex/_generated/`) — covers every path under it. */
  dir?: boolean;
}

export interface ClaimResult {
  path: string;
  symbol?: string;
  dir?: boolean;
  granted: boolean;
  /** when denied, the actor currently holding the conflicting reservation */
  holder?: string;
  /** when denied, the holder's stated intent — enough to resolve the collision */
  holderIntent?: string;
  /** when denied, when the holder's conflicting claim lapses (epoch ms) — the
   * retry-pacing signal waiters were missing. */
  holderExpiresAt?: number;
  /** when denied for a non-conflict reason */
  reason?: "outside-repo" | "symbol-not-found" | "symbols-unsupported";
  /** for symbol-not-found: a close existing symbol name, if one exists. */
  suggestion?: string;
  /** when denied AND the actor asked to queue: it's now registered for
   * auto-grant when the target frees. `queuePosition` is 1-based (1 = next). */
  queued?: boolean;
  queuePosition?: number;
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
 * `formatPrice` symbol; `utils.js` reserves the whole file; a trailing slash
 * (`convex/_generated/`) reserves the whole DIRECTORY — every current and
 * future path under it. The path is normalized; an empty symbol is treated as
 * a whole-file claim.
 */
export function parseTarget(raw: string): ClaimTarget {
  const hash = raw.indexOf("#");
  const pathPart = hash === -1 ? raw : raw.slice(0, hash);
  const dir = /\/+\s*$/.test(pathPart);
  const path = normalizePath(pathPart.trim());
  if (hash === -1) return dir ? { path, dir: true } : { path };
  const symbol = raw.slice(hash + 1).trim();
  // A directory can't have a symbol; a `dir/#x` target degrades to the dir.
  if (dir) return { path, dir: true };
  return symbol ? { path, symbol } : { path };
}

/** Does a directory claim on `dirPath` cover `p`? */
function underDir(dirPath: string, p: string): boolean {
  return p === dirPath || p.startsWith(dirPath + "/");
}

/** Two reservations overlap when they could cover the same lines. `b` only
 * needs `path`/`symbol`/`dir`, so claims AND waiters both fit. */
function overlaps(a: ClaimTarget, b: { path: string; symbol?: string; dir?: boolean }): boolean {
  // A directory claim on either side covers everything under its prefix.
  if (a.dir && b.dir) return underDir(a.path, b.path) || underDir(b.path, a.path);
  if (a.dir) return underDir(a.path, b.path);
  if (b.dir) return underDir(b.path, a.path);
  if (a.path !== b.path) return false;
  // A whole-file reservation on either side covers everything in the file.
  if (a.symbol === undefined || b.symbol === undefined) return true;
  return a.symbol === b.symbol;
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
  intent?: string,
  opts: {
    /** Allow symbol claims whose symbol isn't in the file YET — the forward
     * claim for a function you're about to add (it binds at write time, when
     * the symbol exists). Without this, a missing symbol is a denial: a claim
     * that binds nothing protects nothing, and granted-but-non-binding is how
     * the dogfood fleet shipped a silent partial commit. */
    creating?: boolean;
    /** On a HOLDER denial, register interest instead of just reporting denied:
     * the actor is auto-granted the target when it frees (the async `--queue`
     * path). Non-blocking. Denials waiting can't fix (bad path, missing symbol)
     * are never queued. */
    queue?: boolean;
  } = {},
): ClaimResult[] {
  const cleanIntent = intent?.trim() ? intent.trim() : undefined;
  return store.withLock(() => {
    const file = store.readClaims();
    file.claims = active(file.claims, now);
    file.blocks = (file.blocks ?? []).filter((b) => b.expiresAt > now);
    file.waiters = (file.waiters ?? []).filter((w) => w.expiresAt > now);
    const sameTarget = (b: Block, t: ClaimTarget) =>
      b.actor === actorId && b.path === t.path && b.symbol === t.symbol;
    const sameWaiter = (w: Waiter, t: ClaimTarget) =>
      w.actor === actorId && w.path === t.path && w.symbol === t.symbol && Boolean(w.dir) === Boolean(t.dir);
    const results: ClaimResult[] = [];
    for (const raw of rawPaths) {
      const parsed = parseTarget(raw);

      // Never let an actor reserve (and thereby cause a read of) a path outside
      // the repo — push-awareness reads claimed files, so a target that escapes
      // is rejected outright. An absolute path INSIDE the repo is fine (agents
      // pass what they have in hand) and is stored repo-relative so it matches
      // the form every other claim and every edit-time check uses.
      const rel = repoRelative(store.paths.repoRoot, parsed.path);
      if (rel === null) {
        results.push({ ...parsed, granted: false, reason: "outside-repo" });
        continue;
      }
      const target: ClaimTarget = { ...parsed, path: rel };

      // A symbol claim that names NOTHING binds nothing: edit-time prevention
      // and attribution match on real symbols, so a granted-but-non-binding
      // claim is a trap — the dogfood fleet shipped a silent partial commit
      // believing a `schema.ts#people` claim protected the file. Deny it:
      // either the symbol is a typo (suggest the near miss), the "symbol"
      // isn't a top-level construct, or the file's language has no symbol
      // support (claim the whole file). Two deliberate escapes: a file that
      // doesn't exist yet (pre-claiming what you're about to create), and an
      // explicit `creating` opt-in for adding a new symbol to an existing
      // file — both bind at write time, when the symbol appears.
      if (target.symbol) {
        const abs = join(store.paths.repoRoot, target.path);
        if (existsSync(abs)) {
          if (!canParse(target.path)) {
            results.push({ ...target, granted: false, reason: "symbols-unsupported" });
            continue;
          }
          if (!opts.creating) {
            let names: string[] = [];
            try {
              names = parseSymbols(target.path, readFileSync(abs, "utf8")).map((s) => s.name);
            } catch {
              /* unreadable — fall through and treat as no symbols */
            }
            if (!names.includes(target.symbol)) {
              results.push({
                ...target,
                granted: false,
                reason: "symbol-not-found",
                suggestion: closestName(target.symbol, names) ?? undefined,
              });
              continue;
            }
          }
        }
      }

      const conflict = file.claims.find(
        (c) => c.actor !== actorId && overlaps(target, c),
      );
      if (conflict) {
        const denied: ClaimResult = {
          ...target,
          granted: false,
          holder: conflict.actor,
          holderIntent: conflict.intent,
          holderExpiresAt: conflict.expiresAt,
        };
        // Async path: register interest so the actor is auto-granted when the
        // holder frees, instead of blocking or blind-polling. Dedup by
        // actor+target (re-queuing just refreshes the TTL and keeps FIFO order).
        if (opts.queue) {
          const existing = file.waiters.find((w) => sameWaiter(w, target));
          if (existing) {
            existing.expiresAt = now + WAITER_TTL_MS;
            existing.session = sessionId;
            if (cleanIntent !== undefined) existing.intent = cleanIntent;
          } else {
            file.waiters.push({
              path: target.path,
              symbol: target.symbol,
              dir: target.dir || undefined,
              actor: actorId,
              session: sessionId,
              intent: cleanIntent,
              queuedAt: new Date(now).toISOString(),
              expiresAt: now + WAITER_TTL_MS,
            });
          }
          denied.queued = true;
          // 1-based FIFO position among the waiters that ACTUALLY conflict with
          // this target — using the same overlaps() rule promoteWaiters grants
          // by, so a whole-file waiter ahead of a symbol waiter (and vice versa)
          // is counted. file.waiters is in insertion (queuedAt) order.
          denied.queuePosition =
            file.waiters.filter((w) => overlaps(target, w)).findIndex((w) => sameWaiter(w, target)) + 1;
        }
        results.push(denied);
        // Record the denial so the fleet view can show who's blocked on whom,
        // carrying the holder's intent so the block explains itself.
        const prior = file.blocks.find((b) => sameTarget(b, target));
        if (prior) {
          prior.holder = conflict.actor;
          prior.holderIntent = conflict.intent;
          prior.expiresAt = now + BLOCK_TTL_MS;
        } else {
          file.blocks.push({
            path: target.path,
            symbol: target.symbol,
            actor: actorId,
            holder: conflict.actor,
            holderIntent: conflict.intent,
            blockedAt: new Date(now).toISOString(),
            expiresAt: now + BLOCK_TTL_MS,
          });
        }
        continue;
      }
      // Granted: this actor is no longer blocked on, or waiting for, this target.
      file.blocks = file.blocks.filter((b) => !sameTarget(b, target));
      file.waiters = file.waiters.filter((w) => !sameWaiter(w, target));

      const own = file.claims.find(
        (c) =>
          c.actor === actorId &&
          c.path === target.path &&
          c.symbol === target.symbol &&
          Boolean(c.dir) === Boolean(target.dir),
      );
      if (own) {
        own.expiresAt = now + CLAIM_TTL_MS;
        own.expiresAtIso = new Date(own.expiresAt).toISOString();
        own.session = sessionId;
        if (cleanIntent !== undefined) own.intent = cleanIntent;
      } else {
        file.claims.push({
          path: target.path,
          symbol: target.symbol,
          dir: target.dir || undefined,
          actor: actorId,
          session: sessionId,
          acquiredAt: new Date(now).toISOString(),
          expiresAt: now + CLAIM_TTL_MS,
          expiresAtIso: new Date(now + CLAIM_TTL_MS).toISOString(),
          intent: cleanIntent,
        });
      }
      results.push({ ...target, granted: true });
    }
    store.writeClaims(file);
    return results;
  });
}

/**
 * Auto-grant queued waiters against the current claim state, in FIFO order.
 * Mutates `file` in place and returns the claims newly granted off the queue
 * (for ledger/notification). The heart of async claims: whenever a target
 * frees (a release, a commit's auto-release, or a lease lapse), the earliest
 * live waiter whose target is now free gets a real claim — `viaQueue`, not yet
 * notified, so the actor discovers it at its next quilt call.
 *
 * FIFO falls out naturally: waiters are tried oldest-first, and a waiter that's
 * granted immediately HOLDS the target, so the next same-target waiter sees the
 * fresh conflict and stays queued. A waiter whose actor already holds the code
 * (it re-claimed directly) is just dropped. Callers must hold the store lock.
 */
export function promoteWaiters(file: ClaimsFile, now: number, sessionFallback: string | null = null): Claim[] {
  file.claims = active(file.claims, now);
  const waiters = (file.waiters ?? [])
    .filter((w) => w.expiresAt > now)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  const granted: Claim[] = [];
  const remaining: Waiter[] = [];
  for (const w of waiters) {
    const target: ClaimTarget = { path: w.path, symbol: w.symbol, dir: w.dir };
    // Already satisfied — the actor claimed it directly while waiting.
    if (file.claims.some((c) => c.actor === w.actor && overlaps(target, c))) continue;
    // Still held by someone else — stays queued (and holds its FIFO slot).
    if (file.claims.some((c) => c.actor !== w.actor && overlaps(target, c))) {
      remaining.push(w);
      continue;
    }
    // Free: grant it, off the queue.
    const claim: Claim = {
      path: w.path,
      symbol: w.symbol,
      dir: w.dir || undefined,
      actor: w.actor,
      session: w.session ?? sessionFallback,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: now + CLAIM_TTL_MS,
      expiresAtIso: new Date(now + CLAIM_TTL_MS).toISOString(),
      intent: w.intent,
      viaQueue: true,
    };
    file.claims.push(claim);
    granted.push(claim);
  }
  file.waiters = remaining;
  return granted;
}

/**
 * The queued grants for `actorId` not yet surfaced to it — the "granted while
 * you waited" callout. Reading them does NOT mark them notified; call
 * `markGrantsNotified` (inside a lock) once you've shown them, so they shout
 * exactly once. A pure read otherwise.
 */
export function pendingGrants(store: Store, actorId: string, now: number): Claim[] {
  return active(store.readClaims().claims, now).filter(
    (c) => c.actor === actorId && c.viaQueue && !c.notifiedAt,
  );
}

/** Mark this actor's un-announced queued grants as surfaced. Locked. */
export function markGrantsNotified(store: Store, actorId: string, now: number): void {
  store.withLock(() => {
    const file = store.readClaims();
    let changed = false;
    for (const c of file.claims) {
      if (c.actor === actorId && c.viaQueue && !c.notifiedAt) {
        c.notifiedAt = now;
        changed = true;
      }
    }
    if (changed) store.writeClaims(file);
  });
}

/** All active waiters (the queue), for the fleet view. */
export function listWaiters(store: Store, now: number): Waiter[] {
  return (store.readClaims().waiters ?? []).filter((w) => w.expiresAt > now);
}

/**
 * Release an actor's claims. With no targets, release ALL of the actor's claims.
 * A target naming a file (no symbol) releases every claim the actor holds on
 * that file (whole-file and any symbol claims).
 */
export interface WaitOutcome {
  /** the final acquire pass's results. */
  results: ClaimResult[];
  /** how long this call actually blocked. */
  waitedMs: number;
  /** true when the wait window elapsed with holder-denials still standing. */
  timedOut: boolean;
}

/**
 * `acquireClaims`, but BLOCK on holder-denials until they free up or `waitMs`
 * elapses — the primitive the dogfood fleet was missing. Without it a denied
 * agent's only strategy was blind polling: "get denied, guess when to retry,
 * hope." This waits server-side and returns the moment the holder releases
 * (commit auto-release included), pacing polls against the holder's lease
 * expiry so a dead holder costs at most one lease.
 *
 * Only HOLDER denials are waited on. A denial that waiting can't fix — a
 * target outside the repo, a symbol that doesn't exist — returns immediately,
 * so a typo fails fast instead of hanging for the full window.
 *
 * Each retry re-runs the full acquire, which also refreshes the TTL on the
 * caller's already-granted targets and keeps its blocked-on record fresh in
 * the fleet view: a waiting agent stays visibly waiting.
 */
export async function acquireClaimsWait(
  store: Store,
  actorId: string,
  sessionId: string | null,
  rawPaths: string[],
  intent: string | undefined,
  opts: { creating?: boolean; waitMs: number; pollMs?: number },
): Promise<WaitOutcome> {
  const pollMs = opts.pollMs ?? 2000;
  const start = Date.now();
  for (;;) {
    const now = Date.now();
    const results = acquireClaims(store, actorId, sessionId, rawPaths, now, intent, {
      creating: opts.creating,
    });
    const waitable = results.filter((r) => !r.granted && r.holder);
    const fatal = results.some((r) => !r.granted && !r.holder);
    if (waitable.length === 0 || fatal) {
      return { results, waitedMs: now - start, timedOut: false };
    }
    const elapsed = now - start;
    if (elapsed >= opts.waitMs) {
      return { results, waitedMs: elapsed, timedOut: true };
    }
    // Sleep until the next poll — or the earliest holder lease expiry, or the
    // end of our window, whichever comes first. Floor keeps a tight loop out.
    const soonestLapse = Math.min(
      ...waitable.map((r) => (r.holderExpiresAt ?? now + pollMs) - now),
    );
    const sleep = Math.max(250, Math.min(pollMs, soonestLapse, opts.waitMs - elapsed));
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
}

export interface ReleaseResult {
  /** live claims actually released by this call. */
  released: number;
  /** claims of this actor that had ALREADY silently TTL-expired — surfaced so
   * "released: 0" after a long task reads as what it is, not as a failure. */
  expired: number;
}

export function releaseClaims(
  store: Store,
  actorId: string,
  rawPaths: string[] | null,
  now: number = Date.now(),
): ReleaseResult {
  // Normalize the same way acquire does, so releasing by an absolute path frees
  // the (repo-relative) claim it acquired. A target outside the repo can't match
  // any stored claim; keep it as parsed so it just releases nothing.
  const targets =
    rawPaths === null
      ? null
      : rawPaths.map((raw) => {
          const t = parseTarget(raw);
          return { ...t, path: repoRelative(store.paths.repoRoot, t.path) ?? t.path };
        });
  return store.withLock(() => {
    const file = store.readClaims();
    const matchesTarget = (path: string, symbol: string | undefined): boolean =>
      targets === null ||
      targets.some((t) => t.path === path && (t.symbol === undefined || t.symbol === symbol));
    let released = 0;
    let expired = 0;
    file.claims = file.claims.filter((c) => {
      if (c.actor !== actorId) return true;
      if (c.expiresAt <= now) {
        expired++; // lapsed on its own — drop it, but report it separately
        return false;
      }
      if (!matchesTarget(c.path, c.symbol)) return true;
      released++;
      return false;
    });
    // Releasing a claim resolves any block where this actor was the holder, so
    // drop those now rather than waiting for them to time out (a re-acquire
    // inside the TTL would otherwise make a resolved block reappear).
    if (file.blocks?.length) {
      file.blocks = file.blocks.filter(
        (b) => !(b.holder === actorId && matchesTarget(b.path, b.symbol)),
      );
    }
    // A freed target may be exactly what a queued waiter was waiting for —
    // auto-grant the earliest before writing, so the async claim lands the
    // instant this actor lets go (including a commit's auto-release).
    if (released > 0 || expired > 0) promoteWaiters(file, now);
    store.writeClaims(file);
    return { released, expired };
  });
}

/** Currently-active (non-expired) claims. */
export function listClaims(store: Store, now: number): Claim[] {
  return active(store.readClaims().claims, now);
}

/**
 * Is some OTHER actor holding a claim that an edit to `path` touching `symbols`
 * would collide with? A whole-file claim by another actor collides with any edit;
 * a symbol claim collides only when the edit touches that symbol. Returns the
 * holder (and their intent) of the first such claim, or null if the edit is free.
 * This is the edit-time prevention oracle: deny the write before bytes change.
 */
export function claimHeldByOther(
  store: Store,
  actorId: string,
  rawPath: string,
  symbols: string[],
  now: number,
): { holder: string; intent?: string; target: string } | null {
  const parsed = parseTarget(rawPath).path;
  const path = repoRelative(store.paths.repoRoot, parsed) ?? parsed;
  for (const c of listClaims(store, now)) {
    if (c.actor === actorId || !claimCoversPath(c, path)) continue;
    if (c.dir || c.symbol === undefined || symbols.includes(c.symbol)) {
      return { holder: c.actor, intent: c.intent, target: claimLabel(c) };
    }
  }
  return null;
}

/** Does claim `c` reach `path` at all (same file, or a directory prefix)? */
export function claimCoversPath(c: Claim, path: string): boolean {
  if (c.dir) return underDir(c.path, path);
  return c.path === path;
}

/**
 * A predicate over paths: is this path covered by a live WHOLE-FILE or
 * DIRECTORY claim held by `actorId` itself? File-granularity ownership signal
 * — what lets a claimed binary/too-large file (a lockfile) commit whole.
 * Symbol claims don't count: they're line-scoped by design.
 */
export function pathsClaimedBySelf(
  store: Store,
  actorId: string | null,
  now: number,
): (path: string) => boolean {
  if (!actorId) return () => false;
  const own = listClaims(store, now).filter(
    (c) => c.actor === actorId && c.symbol === undefined,
  );
  return (path: string) => own.some((c) => claimCoversPath(c, path));
}

/**
 * A predicate over paths: is this path covered by any live claim held by an
 * actor OTHER than `actorId`? The guard rail for `--include-unclaimed`:
 * external edits attribute lazily, so mid-flight hunks on a peer's claimed
 * path can read "unclaimed" — sweeping them because of that label is how live
 * work gets stolen. Claimed paths are off-limits to includeUnclaimed, period.
 */
export function pathsClaimedByOthers(
  store: Store,
  actorId: string | null,
  now: number,
): (path: string) => boolean {
  const others = listClaims(store, now).filter((c) => c.actor !== actorId);
  return (path: string) => others.some((c) => claimCoversPath(c, path));
}

/**
 * The distinct OTHER actors holding claims that an edit to `path` touching
 * `symbols` would collide with. The plural sibling of `claimHeldByOther`, for
 * the auto-identity adoption rule: an edit arriving under an auto-derived id
 * inside claimed code is adopted by the holder — but only when there is exactly
 * ONE holder to adopt (two holders on the touched symbols is ambiguous, so the
 * caller falls back to the deny).
 */
export function claimHolders(
  store: Store,
  actorId: string,
  rawPath: string,
  symbols: string[],
  now: number,
): Set<string> {
  const parsed = parseTarget(rawPath).path;
  const path = repoRelative(store.paths.repoRoot, parsed) ?? parsed;
  const holders = new Set<string>();
  for (const c of listClaims(store, now)) {
    if (c.actor === actorId || !claimCoversPath(c, path)) continue;
    if (c.dir || c.symbol === undefined || symbols.includes(c.symbol)) holders.add(c.actor);
  }
  return holders;
}

/**
 * Refresh the TTL on an actor's claims covering `path` (whole-file and symbol
 * claims alike). Called after a captured edit, so an actively-editing actor
 * never loses its reservation mid-work — without this, a claim made once and
 * followed by >TTL of editing expires silently, and the next actor to
 * reconcile absorbs the in-flight work (the exposure reconcile documents).
 */
export function refreshClaims(store: Store, actorId: string, rawPath: string, now: number): void {
  const path = repoRelative(store.paths.repoRoot, rawPath) ?? rawPath;
  store.withLock(() => {
    const file = store.readClaims();
    let changed = false;
    for (const c of file.claims) {
      if (c.actor === actorId && claimCoversPath(c, path) && c.expiresAt > now) {
        c.expiresAt = now + CLAIM_TTL_MS;
        c.expiresAtIso = new Date(c.expiresAt).toISOString();
        changed = true;
      }
    }
    if (changed) store.writeClaims(file);
  });
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

/** Display label for a claim, e.g. `utils.js#formatPrice`, `utils.js`, `gen/`. */
export function claimLabel(c: Claim): string {
  if (c.dir) return c.path + "/";
  return c.symbol ? `${c.path}#${c.symbol}` : c.path;
}
