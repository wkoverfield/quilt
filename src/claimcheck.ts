// Sanity-check granted symbol claims against the file's actual symbols, so a
// typo'd target (`utils.js#formatPirce`) doesn't silently reserve nothing —
// the claimant walks away believing the real function is protected when no
// edit-time check will ever match it.
//
// Warnings, not denials: claiming a symbol you are ABOUT to add is a
// legitimate move (reserve the name before writing the function), so a missing
// symbol can't be an error. The warning tells the actor what Quilt can see and
// suggests a near-miss when one exists.
import { existsSync, readFileSync } from "node:fs";
import { safeAbs } from "./authorship.js";
import { canParse, parseSymbols } from "./symbols.js";
import type { ClaimResult } from "./claims.js";
import type { Store } from "./state.js";

export interface ClaimWarning {
  target: string;
  message: string;
}

/**
 * Warnings for granted symbol claims whose symbol isn't in the file. Quiet for
 * whole-file claims, denied claims, files that don't exist yet (creating a file
 * is exactly when you'd pre-claim its symbols), and languages Quilt can't parse
 * (no symbol list to check against — the claim still works whole-file-wise).
 */
export function verifyClaimTargets(store: Store, results: ClaimResult[]): ClaimWarning[] {
  const warnings: ClaimWarning[] = [];
  for (const r of results) {
    if (!r.granted || !r.symbol) continue;
    const abs = safeAbs(store.paths.repoRoot, r.path);
    if (!abs || !existsSync(abs) || !canParse(r.path)) continue;
    let names: string[];
    try {
      names = parseSymbols(r.path, readFileSync(abs, "utf8")).map((s) => s.name);
    } catch {
      continue; // unreadable/unparseable — nothing to check against
    }
    if (names.includes(r.symbol)) continue;
    const near = closest(r.symbol, names);
    warnings.push({
      target: `${r.path}#${r.symbol}`,
      message:
        `symbol "${r.symbol}" not found in ${r.path}` +
        (near ? ` — did you mean "${near}"?` : "") +
        ` (claim granted anyway — fine if you're about to add it)`,
    });
  }
  return warnings;
}

/** The nearest existing symbol within a small edit distance, or null. */
function closest(target: string, names: string[]): string | null {
  let best: string | null = null;
  let bestDist = 3; // only suggest genuinely-close names (distance <= 2)
  for (const n of names) {
    const d = editDistance(target.toLowerCase(), n.toLowerCase(), bestDist);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

/** Levenshtein distance, capped: returns `cap` when the true distance is >= cap. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) >= cap) return cap;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const d = Math.min(
        (prev[j] ?? cap) + 1,
        (cur[j - 1] ?? cap) + 1,
        (prev[j - 1] ?? cap) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur[j] = d;
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin >= cap) return cap;
    prev = cur;
  }
  return Math.min(prev[b.length] ?? cap, cap);
}
