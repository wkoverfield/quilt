/**
 * Quilt eval harness — core.
 *
 * Runs a graded scenario against a throwaway git repo twice: once WITHOUT Quilt
 * (the naive "many actors, one working tree, plain git" baseline) and once WITH
 * Quilt (actors start sessions, claim before editing, and `commit --mine`). The
 * two runs are graded on the same metrics so we can compare them side by side.
 *
 * The scripted scenarios are deterministic: edits are surgical anchor->text
 * replacements applied in a fixed interleave, and cooperative behavior (an actor
 * deferring when its claim is denied, or adapting when it sees another actor's
 * claim) is encoded explicitly. That makes the suite fast, CI-able, and a
 * regression guard. The companion live-sub-agent layer (see bench/README.md)
 * tests whether *real* agents actually exhibit the cooperative behavior the
 * scripted layer assumes.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

export type Mode = "without" | "with";

export interface Actor {
  id: string;
  type: "human" | "agent";
}

export interface Edit {
  /** Who makes this edit. */
  actor: string;
  /** Repo-relative file to edit. */
  file: string;
  /**
   * Symbol/path this edit reserves (e.g. "utils.js#foo"). In WITH mode the actor
   * runs `quilt claim <claim>` before editing; a denial means it defers.
   */
  claim?: string;
  /** Unique substring of the CURRENT file content to replace. */
  anchor: string;
  /** Replacement text the naive (coordination-blind) actor writes. */
  replacement: string;
  /**
   * Replacement a coordination-aware actor writes instead (WITH mode only) — use
   * for cascade scenarios where seeing another actor's claim lets this actor
   * adapt (e.g. call the new signature). Defaults to `replacement`.
   */
  adaptedReplacement?: string;
  /**
   * If set, this edit only adapts when the named actor holds a live claim.
   * Models "B adapts because it saw A is changing `api`."
   */
  adaptsToClaimBy?: string;
  /** File whose claim triggers adaptation (a dependency). Defaults to this edit's file. */
  adaptsToClaimOnFile?: string;
  /** Unique survival probe — a substring that appears only if this edit landed. */
  marker: string;
  desc: string;
}

export interface Scenario {
  id: string; // "L1"
  title: string;
  description: string;
  /** Initial committed tree. */
  files: Record<string, string>;
  actors: Actor[];
  /** Ordered, interleaved edits across actors. */
  edits: Edit[];
  /**
   * Whether claim-denied (deferred) edits retry after the commit phase. True for
   * disjoint sequencing (the work just waits its turn). False for genuinely
   * incompatible conflicts, where auto-redoing would clobber the winner — those
   * stay surfaced for a human to resolve.
   */
  redoDeferred?: boolean;
  /**
   * A substring that, if present in the FINAL committed tree, means the system
   * is in a broken state (e.g. a stale call site after a signature change).
   * Used to grade "do all features actually work together".
   */
  brokenIfFinalContains?: string[];
}

export interface EditOutcome {
  edit: Edit;
  /** Edit text was written into the working tree at some point. */
  applied: boolean;
  /** Actor deferred because a claim was denied (cooperative sequencing). */
  deferred: boolean;
  /** Intended write never happened because the anchor was already gone. */
  clobbered: boolean;
  /** Marker present in final HEAD tree (landed in committed history). */
  inHead: boolean;
  /** Marker present in final working tree (preserved even if uncommitted). */
  inWorktree: boolean;
  /** Git author of the commit that introduced the marker, if any. */
  committedBy: string | null;
}

export interface Metrics {
  /** Edits whose change is present in the final committed history. */
  featuresLanded: number;
  totalFeatures: number;
  /** Intended changes that vanished entirely (not in HEAD, not in worktree). */
  silentLoss: number;
  /** Edits attributed to the wrong actor in git history. */
  misattributed: number;
  attributionCorrect: boolean;
  /** Conflicts Quilt surfaced for a human (claim denials / contention). Good. */
  surfacedConflicts: number;
  /** Redone/deferred work — the coordination tax. */
  wastedWork: number;
  /** System left in a broken/incoherent state (stale call sites, etc.). */
  broken: boolean;
  wallClockMs: number;
}

export interface RunResult {
  mode: Mode;
  outcomes: EditOutcome[];
  metrics: Metrics;
}

export interface ScenarioResult {
  scenario: Scenario;
  without: RunResult;
  with: RunResult;
}

function sh(cmd: string, args: string[], cwd: string, env?: Record<string, string>) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(args: string[], cwd: string, env?: Record<string, string>) {
  return sh("git", args, cwd, env);
}

function quilt(args: string[], cwd: string, actor?: string) {
  return sh("node", [CLI, ...args], cwd, actor ? { QUILT_ACTOR: actor } : undefined);
}

/** Create a throwaway git repo seeded with the scenario's base tree. */
function setupRepo(scn: Scenario): string {
  const dir = mkdtempSync(join(tmpdir(), `quilt-bench-${scn.id}-`));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "base@quilt.local"], dir);
  git(["config", "user.name", "base"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  for (const [rel, content] of Object.entries(scn.files)) {
    const abs = join(dir, rel);
    writeFileSync(abs, content);
  }
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "base"], dir);
  return dir;
}

function read(dir: string, rel: string): string {
  const abs = join(dir, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : "";
}

/** Does the current HEAD tree (committed) contain `needle` in the given file? */
function inHeadTree(dir: string, rel: string, needle: string): boolean {
  const r = git(["show", `HEAD:${rel}`], dir);
  return r.status === 0 && r.stdout.includes(needle);
}

/** Author name of the commit that first introduced `needle` into history. */
function authorOf(dir: string, needle: string): string | null {
  // -S<string> finds commits that changed the count of the string; newest first.
  const r = git(["log", "-S", needle, "--format=%an", "--", "."], dir);
  if (r.status !== 0) return null;
  const lines = r.stdout.split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1]! : null; // introducing commit
}

/** Is there a live claim by `actor` on `file` (whole-file or any symbol in it)? */
function hasOverlappingClaim(dir: string, byActor: string, file: string): boolean {
  const r = quilt(["claim", "--json"], dir, byActor);
  if (r.status !== 0) return false;
  try {
    const j = JSON.parse(r.stdout);
    const claims: Array<{ actor?: string; path?: string }> = j.claims ?? [];
    return claims.some((c) => c.actor === byActor && c.path === file);
  } catch {
    return false;
  }
}

function applyEdit(dir: string, edit: Edit, text: string): boolean {
  const cur = read(dir, edit.file);
  if (!cur.includes(edit.anchor)) return false; // anchor gone -> clobbered
  writeFileSync(join(dir, edit.file), cur.replace(edit.anchor, text));
  return true;
}

/** Run the scenario WITHOUT Quilt: naive shared tree + plain git commits. */
function runWithout(scn: Scenario): RunResult {
  const t0 = process.hrtime.bigint();
  const dir = setupRepo(scn);
  const outcomes: EditOutcome[] = [];
  try {
    // Apply edits in interleave order; same-region edits clobber (last anchor wins).
    for (const edit of scn.edits) {
      const applied = applyEdit(dir, edit, edit.replacement);
      outcomes.push({
        edit,
        applied,
        deferred: false,
        clobbered: !applied,
        inHead: false,
        inWorktree: false,
        committedBy: null,
      });
    }
    // Commit phase: each actor commits with plain git. The first committer's
    // `git add -A` sweeps up everyone's pending edits -> absorption.
    for (const actor of scn.actors) {
      git(["add", "-A"], dir);
      const has = git(["diff", "--cached", "--quiet"], dir).status !== 0;
      if (has) {
        git(["commit", "-q", "-m", `${actor.id}: work`], dir, {
          GIT_AUTHOR_NAME: actor.id,
          GIT_AUTHOR_EMAIL: `${actor.id}@quilt.local`,
          GIT_COMMITTER_NAME: actor.id,
          GIT_COMMITTER_EMAIL: `${actor.id}@quilt.local`,
        });
      }
    }
    finalize(dir, scn, outcomes);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { mode: "without", outcomes, metrics: grade(dir, scn, outcomes, ms) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the scenario WITH Quilt: sessions, claims, and `commit --mine`. */
function runWith(scn: Scenario): RunResult {
  const t0 = process.hrtime.bigint();
  const dir = setupRepo(scn);
  const outcomes: EditOutcome[] = [];
  try {
    quilt(["init"], dir);
    for (const a of scn.actors) quilt(["start", "--actor", a.id, "--type", a.type], dir, a.id);

    const deferredEdits: Edit[] = [];
    for (const edit of scn.edits) {
      const oc: EditOutcome = {
        edit,
        applied: false,
        deferred: false,
        clobbered: false,
        inHead: false,
        inWorktree: false,
        committedBy: null,
      };
      // Cooperative claim: reserve before editing; a denial means defer.
      if (edit.claim) {
        const c = quilt(["claim", edit.claim], dir, edit.actor);
        if (c.status !== 0) {
          oc.deferred = true;
          deferredEdits.push(edit);
          outcomes.push(oc);
          continue;
        }
      }
      // Coordination-aware adaptation: if another actor holds an overlapping
      // claim, write the adapted variant instead of the naive one.
      let text = edit.replacement;
      if (
        edit.adaptedReplacement &&
        edit.adaptsToClaimBy &&
        hasOverlappingClaim(dir, edit.adaptsToClaimBy, edit.adaptsToClaimOnFile ?? edit.file)
      ) {
        text = edit.adaptedReplacement;
      }
      oc.applied = applyEdit(dir, edit, text);
      oc.clobbered = !oc.applied;
      outcomes.push(oc);
    }

    // Commit phase: each actor commits only its own hunks.
    for (const a of scn.actors) {
      quilt(["commit", "--mine", "-m", `${a.id}: work`], dir, a.id);
    }

    // Resolution pass: for disjoint sequencing, deferred actors retry once now
    // that claims have cleared (the realistic "wait, then redo" — counted as
    // wasted work, not loss). Skipped for incompatible conflicts, which stay
    // surfaced for a human rather than auto-clobbering the winner.
    for (const edit of scn.redoDeferred === false ? [] : deferredEdits) {
      quilt(["release", edit.claim!], dir).status; // best-effort: free stale claims
      const c = quilt(["claim", edit.claim!], dir, edit.actor);
      if (c.status === 0) {
        const oc = outcomes.find((o) => o.edit === edit)!;
        oc.applied = applyEdit(dir, edit, edit.replacement);
        oc.deferred = oc.applied ? true : oc.deferred; // keep "deferred" = wasted work
        quilt(["commit", "--mine", "-m", `${edit.actor}: redo ${edit.desc}`], dir, edit.actor);
      }
    }

    finalize(dir, scn, outcomes);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { mode: "with", outcomes, metrics: grade(dir, scn, outcomes, ms) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Probe final HEAD + worktree state for each edit's marker. */
function finalize(dir: string, scn: Scenario, outcomes: EditOutcome[]): void {
  for (const oc of outcomes) {
    const { file, marker } = oc.edit;
    oc.inHead = inHeadTree(dir, file, marker);
    oc.inWorktree = read(dir, file).includes(marker);
    oc.committedBy = oc.inHead ? authorOf(dir, marker) : null;
  }
}

function grade(dir: string, scn: Scenario, outcomes: EditOutcome[], wallClockMs: number): Metrics {
  let featuresLanded = 0;
  let silentLoss = 0;
  let misattributed = 0;
  let surfacedConflicts = 0;
  let wastedWork = 0;

  for (const oc of outcomes) {
    if (oc.inHead) {
      featuresLanded++;
      if (oc.committedBy && oc.committedBy !== oc.edit.actor) misattributed++;
    } else if (!oc.inWorktree && !oc.deferred) {
      // Gone from history AND working tree, and not a conscious deferral -> lost.
      silentLoss++;
    }
    if (oc.deferred) {
      // A claim denial Quilt surfaced for a human; the work waits, never vanishes.
      surfacedConflicts++;
      wastedWork++;
    }
  }

  const broken = (scn.brokenIfFinalContains ?? []).some((needle) =>
    Object.keys(scn.files).some((f) => read(dir, f).includes(needle)),
  );

  return {
    featuresLanded,
    totalFeatures: outcomes.length,
    silentLoss,
    misattributed,
    attributionCorrect: misattributed === 0,
    surfacedConflicts,
    wastedWork,
    broken,
    wallClockMs,
  };
}

export function runScenario(scn: Scenario): ScenarioResult {
  return { scenario: scn, without: runWithout(scn), with: runWith(scn) };
}
