import pc from "picocolors";
import type { Store } from "./state.js";
import { buildModel } from "./engine.js";
import { listClaims, listBlocks, claimLabel } from "./claims.js";
import { dependencyWarnings, formatWarning, type DependencyWarning } from "./push.js";

/**
 * Mission control: a read-only view of the fleet — who's in it, what each actor
 * has claimed, which working-tree changes each owns, and where they overlap.
 * Strictly read-only: it never reconciles or writes state, so watching the fleet
 * can't perturb attribution. Because Quilt attributes on reconcile (pull, not
 * push), the view reflects state AS OF the last `quilt` command any actor ran —
 * an overlap appears once a collision has been reconciled, not the instant the
 * keystroke lands. Claims, by contrast, are always current. Run `quilt watch`
 * alongside (it reconciles on file events) to keep ownership close to live.
 */
export interface FleetActorView {
  id: string;
  type: string;
  /** Claim labels this actor currently holds, e.g. "utils.js#foo". */
  claims: string[];
  /** Files this actor owns changes in, in the working tree. */
  files: string[];
}

/**
 * A region where more than one actor has changes in the same diff hunk. Quilt
 * still commits each actor's own lines, so an overlap usually resolves cleanly —
 * but it's where a same-line clash (one agent overwriting another) would show
 * up, so it's surfaced for a look rather than hidden.
 */
export interface FleetOverlap {
  path: string;
  actors: string[];
  lines: number;
}

/** An actor whose claim was denied because someone else holds the target. */
export interface FleetBlock {
  actor: string;
  target: string;
  holder: string;
}

export interface FleetView {
  actors: FleetActorView[];
  overlaps: FleetOverlap[];
  /** Who's blocked on whom (denied claims still held by the holder). */
  blocked: FleetBlock[];
  /** Cross-actor dependency heads-up: a claimed symbol depends on one being changed. */
  dependencyWarnings: DependencyWarning[];
  /** Files with changes attributed to no one (pre-existing, generated, etc.). */
  unattributed: string[];
}

/** Compute the current fleet view. Read-only. */
export function fleetSnapshot(store: Store, now: number): FleetView {
  const model = buildModel(store, null); // read-only: no active actor, no reconcile
  const claims = listClaims(store, now);
  const known = store.readActors();

  const filesByActor = new Map<string, Set<string>>();
  const unattributed = new Set<string>();
  const overlaps: FleetOverlap[] = [];
  for (const f of model.files) {
    let owned = false;
    let changed = false;
    // An overlap = a hunk owned by more than one actor (engine marks it
    // "shared"). This covers both a benign adjacency (different lines, commits
    // cleanly) and a real same-line overwrite — they're indistinguishable from
    // the hunk alone, so we surface the region for a look rather than guess.
    const overlapActors = new Set<string>();
    let overlapLines = 0;
    for (const h of f.hunks) {
      if (h.hunk.ops.some((o) => o.type !== "eq")) changed = true;
      for (const a of h.actors) {
        owned = true;
        (filesByActor.get(a) ?? filesByActor.set(a, new Set()).get(a)!).add(f.path);
      }
      if (h.ownership === "shared") {
        for (const a of h.actors) overlapActors.add(a);
        overlapLines += h.hunk.ops.filter((o) => o.type !== "eq").length;
      }
    }
    if (changed && !owned) unattributed.add(f.path);
    if (overlapActors.size) {
      overlaps.push({ path: f.path, actors: [...overlapActors].sort(), lines: overlapLines });
    }
  }

  const claimsByActor = new Map<string, string[]>();
  for (const c of claims) {
    (claimsByActor.get(c.actor) ?? claimsByActor.set(c.actor, []).get(c.actor)!).push(claimLabel(c));
  }

  const typeOf = new Map(known.map((a) => [a.id, a.type as string]));
  const ids = new Set<string>([
    ...known.map((a) => a.id),
    ...filesByActor.keys(),
    ...claimsByActor.keys(),
  ]);
  const actors: FleetActorView[] = [...ids].sort().map((id) => ({
    id,
    type: typeOf.get(id) ?? "agent",
    claims: (claimsByActor.get(id) ?? []).sort(),
    files: [...(filesByActor.get(id) ?? [])].sort(),
  }));

  const blocked = listBlocks(store, now)
    .map((b) => ({
      actor: b.actor,
      target: b.symbol ? `${b.path}#${b.symbol}` : b.path,
      holder: b.holder,
    }))
    .sort((a, b) => a.actor.localeCompare(b.actor) || a.target.localeCompare(b.target));

  // Dependency heads-up across the whole fleet (each actor's warnings, deduped).
  const seen = new Set<string>();
  const warnings: DependencyWarning[] = [];
  for (const a of actors) {
    for (const w of dependencyWarnings(store, a.id, now)) {
      const key = `${w.yourSymbol}->${w.heldTarget}@${w.heldBy}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(w);
    }
  }

  return {
    actors,
    overlaps,
    blocked,
    dependencyWarnings: warnings,
    unattributed: [...unattributed].sort(),
  };
}

/** Render the fleet view as a glanceable terminal dashboard. */
export function renderFleet(view: FleetView, headLabel: string): string {
  const out: string[] = [];
  const counts =
    `${view.actors.length} actor${view.actors.length === 1 ? "" : "s"}` +
    `, ${view.overlaps.length} overlap${view.overlaps.length === 1 ? "" : "s"}` +
    `, ${view.blocked.length} blocked`;
  out.push(`${pc.bold("Quilt")} ${pc.dim("· fleet")}   ${pc.dim(headLabel)}   ${pc.dim(counts)}\n`);

  out.push(pc.bold("  Actors"));
  if (view.actors.length === 0) {
    out.push(pc.dim("    (no actors yet)"));
  } else {
    for (const a of view.actors) {
      const active = a.claims.length > 0 || a.files.length > 0;
      const dot = active ? pc.green("●") : pc.dim("○");
      const work = a.files.length
        ? a.files.join(", ")
        : pc.dim(a.claims.length ? "reserved, not yet edited" : "idle");
      out.push(`    ${dot} ${pc.bold(a.id)} ${pc.dim(`(${a.type})`)}   ${work}`);
      if (a.claims.length) out.push(pc.dim(`        claims: ${a.claims.join(", ")}`));
    }
  }
  out.push("");

  if (view.blocked.length) {
    out.push(pc.bold(pc.red("  Blocked")));
    for (const b of view.blocked) {
      out.push(
        "    " + pc.red("⛔ ") + `${pc.bold(b.actor)} waiting on ${b.target} ${pc.dim(`(held by ${b.holder})`)}`,
      );
    }
    out.push("");
  }

  if (view.dependencyWarnings.length) {
    out.push(pc.bold(pc.yellow("  Dependency heads-up")));
    for (const w of view.dependencyWarnings) out.push("    " + pc.yellow("⚠ ") + formatWarning(w));
    out.push("");
  }

  if (view.overlaps.length) {
    out.push(pc.bold(pc.yellow("  Overlapping work")) + pc.dim("  (same region — review for a same-line clash)"));
    for (const c of view.overlaps) {
      out.push(
        "    " +
          pc.yellow("⚠ ") +
          `${c.path}   ${pc.dim(c.actors.join(", "))}   ${pc.dim(`(${c.lines} line${c.lines === 1 ? "" : "s"})`)}`,
      );
    }
    out.push("");
  } else {
    out.push(pc.dim("  Overlaps: none\n"));
  }

  if (view.unattributed.length) {
    out.push(pc.dim(pc.bold("  Unattributed changes")));
    for (const p of view.unattributed) out.push(pc.dim(`    ${p}`));
    out.push("");
  }

  return out.join("\n") + "\n";
}
