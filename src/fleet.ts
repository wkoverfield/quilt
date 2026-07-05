import pc from "picocolors";
import type { Store } from "./state.js";
import { buildModel } from "./engine.js";
import { listClaims, listBlocks, listWaiters, claimLabel } from "./claims.js";
import { openEscalations, resolutions } from "./outcomes.js";
import { dependencyWarnings, formatWarning, type DependencyWarning } from "./push.js";
import type { Outcome } from "./types.js";

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
  /**
   * "contended" — a same-line overwrite or identical-line clash that wants a
   * human's eyes. "adjacent" — different lines that merely share a hunk; commits
   * separate cleanly. The engine distinguishes these per hunk; a file is
   * contended if any of its shared hunks is.
   */
  kind: "adjacent" | "contended";
}

/** An actor whose claim was denied because someone else holds the target. */
export interface FleetBlock {
  actor: string;
  target: string;
  holder: string;
  /** The holder's stated intent, so the block explains itself. */
  holderIntent?: string;
}

/**
 * A recorded overwrite whose victim's work is preserved and not yet restored.
 * This is the "full overwrite" sibling of a contended overlap: one actor
 * replaced lines another owned, so the hunk has a single owner now and wouldn't
 * show as a shared overlap — but it's a real clash, so the fleet surfaces it.
 */
export interface FleetClobber {
  path: string;
  byActor: string;
  victimActor: string;
}

export interface FleetView {
  actors: FleetActorView[];
  overlaps: FleetOverlap[];
  /** Who's blocked on whom (denied claims still held by the holder). */
  blocked: FleetBlock[];
  /** The async queue: who's waiting to be auto-granted which target. */
  queue: Array<{ target: string; actor: string; intent?: string }>;
  /** Preserved overwrites not yet restored — full-overwrite clashes. */
  clobbers: FleetClobber[];
  /** Genuine conflicts an agent kicked up for a human — the "Needs you" list. */
  needsYou: Outcome[];
  /** Recent collisions the agents sewed themselves — the audit glance. */
  sewn: Outcome[];
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
    // "shared"). The engine further tags each shared hunk: "adjacent" (different
    // lines sharing a hunk — commits cleanly) or "contended" (a same-line
    // overwrite or identical-line clash). A file is contended if any shared hunk
    // is, so a real clash is never hidden behind benign adjacency.
    const overlapActors = new Set<string>();
    let overlapLines = 0;
    let contended = false;
    for (const h of f.hunks) {
      if (h.hunk.ops.some((o) => o.type !== "eq")) changed = true;
      for (const a of h.actors) {
        owned = true;
        (filesByActor.get(a) ?? filesByActor.set(a, new Set()).get(a)!).add(f.path);
      }
      if (h.ownership === "shared") {
        for (const a of h.actors) overlapActors.add(a);
        overlapLines += h.hunk.ops.filter((o) => o.type !== "eq").length;
        if (h.overlap === "contended") contended = true;
      }
    }
    if (changed && !owned) unattributed.add(f.path);
    if (overlapActors.size) {
      overlaps.push({
        path: f.path,
        actors: [...overlapActors].sort(),
        lines: overlapLines,
        kind: contended ? "contended" : "adjacent",
      });
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
      holderIntent: b.holderIntent,
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

  const clobbers: FleetClobber[] = store
    .readClobbers()
    .clobbers.filter((c) => !c.restored)
    .map((c) => ({ path: c.path, byActor: c.byActor, victimActor: c.victimActor }));

  const queue = listWaiters(store, now)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
    .map((w) => ({
      target: w.dir ? w.path + "/" : w.symbol ? `${w.path}#${w.symbol}` : w.path,
      actor: w.actor,
      intent: w.intent,
    }));

  return {
    actors,
    overlaps,
    blocked,
    queue,
    clobbers,
    needsYou: openEscalations(store),
    sewn: resolutions(store).slice(0, 5),
    dependencyWarnings: warnings,
    unattributed: [...unattributed].sort(),
  };
}

/** Render the fleet view as a glanceable terminal dashboard. */
export function renderFleet(view: FleetView, headLabel: string): string {
  const out: string[] = [];
  const clashes = view.overlaps.filter((o) => o.kind === "contended").length + view.clobbers.length;
  const counts =
    `${view.actors.length} actor${view.actors.length === 1 ? "" : "s"}` +
    `, ${view.needsYou.length} needs-you` +
    `, ${clashes} clash${clashes === 1 ? "" : "es"}` +
    `, ${view.blocked.length} blocked`;
  out.push(`${pc.bold("Quilt")} ${pc.dim("· fleet")}   ${pc.dim(headLabel)}   ${pc.dim(counts)}\n`);

  // The engineer's action list goes first: clashes the agents couldn't sew.
  if (view.needsYou.length) {
    out.push(pc.bold(pc.yellow("  Needs you")) + pc.dim("  (agents couldn't reconcile these — your call)"));
    for (const o of view.needsYou) {
      out.push(
        "    " + pc.yellow("⚑ ") + pc.bold(o.target) +
          (o.note ? pc.dim(`  ${o.note}`) : "") + pc.dim(`   (raised by ${o.actor})`),
      );
    }
    out.push(pc.dim("    clear with: quilt resolve <target>"));
    out.push("");
  }

  out.push(pc.bold("  Actors"));
  if (view.actors.length === 0) {
    out.push(pc.dim("    (no actors yet)"));
  } else {
    for (const a of view.actors) {
      const active = a.claims.length > 0 || a.files.length > 0;
      const dot = active ? pc.green("●") : pc.dim("○");
      const work = a.files.length
        ? a.files.join(", ")
        : pc.dim(a.claims.length ? "holding claims, no uncommitted edits" : "idle");
      out.push(`    ${dot} ${pc.bold(a.id)} ${pc.dim(`(${a.type})`)}   ${work}`);
      if (a.claims.length) out.push(pc.dim(`        claims: ${a.claims.join(", ")}`));
    }
  }
  out.push("");

  if (view.blocked.length) {
    out.push(pc.bold(pc.red("  Blocked")));
    for (const b of view.blocked) {
      const held = b.holderIntent ? `held by ${b.holder}: ${b.holderIntent}` : `held by ${b.holder}`;
      out.push(
        "    " + pc.red("⛔ ") + `${pc.bold(b.actor)} waiting on ${b.target} ${pc.dim(`(${held})`)}`,
      );
    }
    out.push("");
  }

  if (view.queue.length) {
    out.push(pc.bold(pc.cyan("  Queue")) + pc.dim("  (auto-granted when the target frees)"));
    for (const w of view.queue) {
      out.push(
        "    " + pc.cyan("… ") + `${pc.bold(w.actor)} queued for ${w.target}` +
          (w.intent ? pc.dim(`  (${w.intent})`) : ""),
      );
    }
    out.push("");
  }

  if (view.dependencyWarnings.length) {
    out.push(pc.bold(pc.yellow("  Dependency heads-up")));
    for (const w of view.dependencyWarnings) out.push("    " + pc.yellow("⚠ ") + formatWarning(w));
    out.push("");
  }

  const contended = view.overlaps.filter((o) => o.kind === "contended");
  const adjacent = view.overlaps.filter((o) => o.kind === "adjacent");
  const fmtOverlap = (c: FleetOverlap) =>
    `${c.path}   ${pc.dim(c.actors.join(", "))}   ${pc.dim(`(${c.lines} line${c.lines === 1 ? "" : "s"})`)}`;
  if (view.clobbers.length) {
    out.push(pc.bold(pc.red("  Overwrite preserved")) + pc.dim("  (one actor replaced another's lines — both saved)"));
    for (const c of view.clobbers) {
      out.push("    " + pc.red("⚠ ") + `${c.path}   ${pc.dim(`${c.byActor} overwrote ${c.victimActor}`)}`);
    }
    out.push(pc.dim("    recover with: quilt restore <path>"));
    out.push("");
  }

  if (!view.overlaps.length) {
    if (!view.clobbers.length) out.push(pc.dim("  Overlaps: none\n"));
  } else {
    if (contended.length) {
      out.push(pc.bold(pc.red("  Same-line clash")) + pc.dim("  (two actors changed the same line — review)"));
      for (const c of contended) out.push("    " + pc.red("⚠ ") + fmtOverlap(c));
      out.push(pc.dim("    recover overwritten work: quilt restore <path>   ·   back out an actor: quilt undo <actor>"));
      out.push("");
    }
    if (adjacent.length) {
      out.push(pc.bold(pc.dim("  Working close")) + pc.dim("  (different lines in one region — commits cleanly)"));
      for (const c of adjacent) out.push("    " + pc.dim("· " + fmtOverlap(c)));
      out.push("");
    }
  }

  if (view.sewn.length) {
    out.push(pc.dim(pc.bold("  Sewn by agents")) + pc.dim("  (recent — agents reconciled these themselves)"));
    for (const o of view.sewn) {
      out.push(pc.dim(`    ✓ ${o.target}${o.note ? `  ${o.note}` : ""}  (${o.actor})`));
    }
    out.push("");
  }

  if (view.unattributed.length) {
    out.push(pc.dim(pc.bold("  Unattributed changes")));
    for (const p of view.unattributed) out.push(pc.dim(`    ${p}`));
    out.push("");
  }

  return out.join("\n") + "\n";
}
