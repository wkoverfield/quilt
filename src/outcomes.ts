// Collision outcomes — how a clash was handled.
//
// When the fleet's own agents resolve collisions (Quilt is the substrate, not the
// resolver), two things have to be visible to the engineer: the clashes an agent
// could NOT reconcile and kicked up for a human ("escalated" → Needs you), and a
// trail of the ones an agent sewed itself ("resolved" → audit). The latest
// outcome per target wins: an escalation stays open until a later resolution
// closes it.
import { randomUUID } from "node:crypto";
import type { Store } from "./state.js";
import type { Outcome } from "./types.js";

/** Normalize a target the same way claims do, so `./a#f` and `a#f` agree. */
export function normalizeTarget(raw: string): string {
  const hash = raw.indexOf("#");
  const path = (hash === -1 ? raw : raw.slice(0, hash)).replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (hash === -1) return path;
  const symbol = raw.slice(hash + 1).trim();
  return symbol ? `${path}#${symbol}` : path;
}

/** Record a collision outcome and return it. */
export function recordOutcome(
  store: Store,
  kind: Outcome["kind"],
  actor: string,
  rawTarget: string,
  note: string | undefined,
  nowIso: string,
): Outcome {
  return store.withLock(() => {
    const file = store.readOutcomes();
    const outcome: Outcome = {
      id: randomUUID().slice(0, 12),
      target: normalizeTarget(rawTarget),
      kind,
      actor,
      note: note?.trim() ? note.trim() : undefined,
      ts: nowIso,
    };
    file.outcomes.push(outcome);
    store.writeOutcomes(file);
    return outcome;
  });
}

/** The latest outcome recorded for each target (insertion order = chronological). */
function latestByTarget(outcomes: Outcome[]): Map<string, Outcome> {
  const latest = new Map<string, Outcome>();
  for (const o of outcomes) latest.set(o.target, o); // later entries overwrite
  return latest;
}

/**
 * Open escalations — targets whose most recent outcome is an escalation (no
 * resolution has closed it yet). These are the "Needs you" items.
 */
export function openEscalations(store: Store): Outcome[] {
  const latest = latestByTarget(store.readOutcomes().outcomes);
  return [...latest.values()]
    .filter((o) => o.kind === "escalated")
    .sort((a, b) => a.target.localeCompare(b.target));
}

/** Every resolution recorded (the audit trail), most recent first. */
export function resolutions(store: Store): Outcome[] {
  return store
    .readOutcomes()
    .outcomes.filter((o) => o.kind === "resolved")
    .reverse();
}
