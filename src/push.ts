import { join } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import type { Store } from "./state.js";
import type { Claim } from "./types.js";
import { listClaims } from "./claims.js";
import { symbolReferences } from "./symbols.js";

/**
 * Push-awareness: proactively warn an actor when a symbol it depends on is being
 * changed by someone else. This makes the dependency-cascade win (L3) not hinge
 * on an agent remembering to check for conflicts — the moment it reserves its
 * work, Quilt tells it a dependency is in flux.
 *
 * V1 is intra-file and name-based: a warning fires when a symbol you claimed
 * references another top-level symbol (by name) that a different actor has
 * claimed. Name-based matching means a cross-file reference to a same-named
 * symbol can match too (useful — that's the L3 caller/api case), at the cost of
 * a possible false positive on homonyms. Advisory only, so that tradeoff is
 * acceptable; cross-file import resolution is a future refinement.
 */
export interface DependencyWarning {
  /** The claimed symbol of yours that has the dependency, e.g. "main.js#caller". */
  yourSymbol: string;
  /** The depended-on symbol name being changed, e.g. "api". */
  dependency: string;
  /** Who is currently changing it. */
  heldBy: string;
  /** Where they claimed it, e.g. "api.js#api". */
  heldTarget: string;
}

function readWorktree(repoRoot: string, relPath: string): string | null {
  const abs = join(repoRoot, relPath);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * Compute dependency warnings for `forActor`: symbols they've claimed that
 * depend on a symbol another actor is currently changing. Returns [] when there
 * is nothing to warn about (including when symbol parsing is unavailable).
 */
export function dependencyWarnings(
  store: Store,
  forActor: string,
  now: number,
): DependencyWarning[] {
  const claims = listClaims(store, now);

  // Index every claimed *symbol* by its name: who holds it and where.
  const claimedByName = new Map<string, Array<{ actor: string; label: string }>>();
  for (const c of claims) {
    if (!c.symbol) continue;
    const arr = claimedByName.get(c.symbol) ?? claimedByName.set(c.symbol, []).get(c.symbol)!;
    arr.push({ actor: c.actor, label: `${c.path}#${c.symbol}` });
  }
  if (claimedByName.size === 0) return [];

  const repoRoot = store.paths.repoRoot;
  const warnings: DependencyWarning[] = [];
  const seen = new Set<string>();

  // For each symbol THIS actor claimed, see what it references, and whether any
  // referenced symbol is claimed by someone else.
  const refCache = new Map<string, Map<string, Set<string>>>();
  for (const mine of claims) {
    if (mine.actor !== forActor || !mine.symbol) continue;

    let refs = refCache.get(mine.path);
    if (!refs) {
      const content = readWorktree(repoRoot, mine.path);
      refs = content ? symbolReferences(mine.path, content) : new Map();
      refCache.set(mine.path, refs);
    }

    for (const dep of refs.get(mine.symbol) ?? []) {
      for (const holder of claimedByName.get(dep) ?? []) {
        if (holder.actor === forActor) continue; // your own claim isn't a warning
        const key = `${mine.path}#${mine.symbol}->${holder.label}@${holder.actor}`;
        if (seen.has(key)) continue;
        seen.add(key);
        warnings.push({
          yourSymbol: `${mine.path}#${mine.symbol}`,
          dependency: dep,
          heldBy: holder.actor,
          heldTarget: holder.label,
        });
      }
    }
  }
  return warnings;
}

/** Human-readable one-liners for a set of warnings. */
export function formatWarning(w: DependencyWarning): string {
  return `${w.yourSymbol} depends on ${w.dependency}, which ${w.heldBy} is changing (${w.heldTarget})`;
}
