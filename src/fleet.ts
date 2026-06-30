import pc from "picocolors";
import type { Store } from "./state.js";
import { buildModel } from "./engine.js";
import { listClaims, claimLabel } from "./claims.js";

/**
 * Mission control: a read-only, real-time view of the fleet — who's in it, what
 * each actor has claimed, which working-tree changes each owns, and where they
 * collide. Strictly read-only: it never reconciles or writes state, so watching
 * the fleet can't perturb attribution. Claims are always current; ownership is
 * as fresh as the last `quilt` command any actor ran (run `quilt watch`
 * alongside to keep it live).
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

export interface FleetView {
  actors: FleetActorView[];
  overlaps: FleetOverlap[];
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

  return { actors, overlaps, unattributed: [...unattributed].sort() };
}

/** Render the fleet view as a glanceable terminal dashboard. */
export function renderFleet(view: FleetView, headLabel: string): string {
  const out: string[] = [];
  out.push(`${pc.bold("Quilt")} ${pc.dim("· fleet")}   ${pc.dim(headLabel)}\n`);

  out.push(pc.bold("  Actors"));
  if (view.actors.length === 0) {
    out.push(pc.dim("    (no actors yet)"));
  } else {
    for (const a of view.actors) {
      const active = a.claims.length > 0 || a.files.length > 0;
      const dot = active ? pc.green("●") : pc.dim("○");
      const work = a.files.length ? a.files.join(", ") : pc.dim("idle");
      out.push(`    ${dot} ${pc.bold(a.id)} ${pc.dim(`(${a.type})`)}   ${work}`);
      if (a.claims.length) out.push(pc.dim(`        claims: ${a.claims.join(", ")}`));
    }
  }
  out.push("");

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
