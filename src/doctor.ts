// `quilt doctor` — a health check that turns SILENT failure into a visible one.
//
// Quilt's hooks fail open: if capture ever stops working (QUILT_ACTOR unset, a
// hook not wired, an orchestrator change), edits quietly fall back to best-effort
// inference and nothing tells the user. This surfaces that: it reports whether
// the wiring is in place, whether identity is set, and — the key signal — how
// many edits have actually been captured. "0 edits recorded despite uncommitted
// changes" is the tell that capture isn't flowing.
import { detect } from "./onboard.js";
import { readAuthorship, readCheckpoint } from "./authorship.js";
import { watcherRunning } from "./watch.js";
import { changedPaths } from "./git.js";
import { openEscalations } from "./outcomes.js";
import type { Store } from "./state.js";

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface Check {
  label: string;
  status: CheckStatus;
  detail: string;
  /** an actionable next step, when there is one. */
  hint?: string;
}

export interface DoctorReport {
  checks: Check[];
  /** worst status across the checks. */
  verdict: "healthy" | "warnings" | "not-ready";
  /** total edits captured (checkpoint + un-compacted log). */
  captureCount: number;
}

/**
 * Diagnose Quilt's health in a repo. Pure except for reading state + git; returns
 * a structured report the CLI renders. `actorEnv` is the caller's QUILT_ACTOR.
 */
export function diagnose(store: Store, opts: { actorEnv?: string } = {}): DoctorReport {
  const checks: Check[] = [];
  const root = store.paths.repoRoot;

  if (!store.initialized) {
    checks.push({
      label: "Quilt",
      status: "fail",
      detail: "not initialized in this repo",
      hint: "run `quilt setup` (wires everything) or `quilt init`",
    });
    return finish(checks, 0);
  }
  checks.push({ label: "Quilt", status: "ok", detail: "initialized (.quilt/)" });

  const d = detect(root);
  if (d.orchestrator) {
    checks.push({ label: "Orchestrator", status: "ok", detail: `detected ${d.orchestrator}` });
  } else {
    checks.push({ label: "Orchestrator", status: "info", detail: "none detected", hint: "run `quilt setup` to wire one in" });
  }

  checks.push(
    d.quiltWired
      ? { label: "MCP server", status: "ok", detail: "quilt server in .mcp.json" }
      : { label: "MCP server", status: "warn", detail: "not in .mcp.json", hint: "run `quilt setup` — agents reach Quilt over MCP" },
  );

  checks.push(
    d.hooksWired
      ? { label: "Capture hooks", status: "ok", detail: "Edit/Write hooks in .claude/settings.json" }
      : {
          label: "Capture hooks",
          status: "warn",
          detail: "not installed",
          hint: "run `quilt setup` — without them, native edits aren't captured",
        },
  );

  // Identity. The doctor usually runs in the human's shell, where QUILT_ACTOR is
  // legitimately unset — so this is informational, not a warning. The point is to
  // remind that each AGENT process needs its own id or the hooks capture nothing.
  const actor = opts.actorEnv?.trim();
  checks.push(
    actor
      ? { label: "Identity", status: "ok", detail: `QUILT_ACTOR=${actor}` }
      : {
          label: "Identity",
          status: "info",
          detail: "QUILT_ACTOR not set in this shell",
          hint: "expected for you; each agent process needs its own QUILT_ACTOR for the hooks to attribute it",
        },
  );

  // Capture health — the core signal. Reading the checkpoint THROWS on a corrupt
  // one (by design elsewhere), but a health tool must never crash — that's the
  // exact case it should report — so catch it and surface it as a failed check.
  let events;
  let total: number;
  try {
    events = readAuthorship(store);
    total = readCheckpoint(store).count + events.length;
  } catch (e) {
    checks.push({
      label: "Capture",
      status: "fail",
      detail: "authorship state is unreadable",
      hint: `${(e as Error).message.replace(/^quilt:\s*/, "")}`,
    });
    return finish(checks, 0);
  }
  if (total > 0) {
    const last = events.at(-1);
    checks.push({
      label: "Capture",
      status: "ok",
      detail: `${total} edit${total === 1 ? "" : "s"} recorded${last ? ` (latest by ${last.actor})` : ""}`,
    });
  } else {
    let changed = 0;
    try {
      changed = changedPaths(root).length;
    } catch {
      /* not fatal for a health check */
    }
    // Warn only in an AGENT shell (QUILT_ACTOR set): there, uncommitted changes
    // with nothing captured means this agent's edits aren't flowing. In a human
    // shell — including right after `quilt setup`, whose own config files show as
    // uncommitted — that's expected, so stay at info rather than cry wolf.
    checks.push(
      changed > 0 && d.hooksWired && actor
        ? {
            label: "Capture",
            status: "warn",
            detail: `0 edits recorded, but ${changed} file${changed === 1 ? " has" : "s have"} uncommitted changes`,
            hint: "your edits aren't being captured — is this process's QUILT_ACTOR set? the hooks fail open silently",
          }
        : { label: "Capture", status: "info", detail: "0 edits recorded yet" },
    );
  }

  const pid = watcherRunning(store);
  checks.push(
    pid
      ? { label: "Live view", status: "ok", detail: `quilt watch running (pid ${pid})` }
      : {
          label: "Live view",
          status: "info",
          detail: "quilt watch not running",
          hint: "fleet/status refresh only when you run a quilt command; `quilt watch` keeps them live",
        },
  );

  const esc = openEscalations(store);
  if (esc.length > 0) {
    checks.push({
      label: "Needs you",
      status: "warn",
      detail: `${esc.length} escalation${esc.length === 1 ? "" : "s"} awaiting a human`,
      hint: "`quilt fleet` shows them",
    });
  }

  return finish(checks, total);
}

function finish(checks: Check[], captureCount: number): DoctorReport {
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  return { checks, verdict: hasFail ? "not-ready" : hasWarn ? "warnings" : "healthy", captureCount };
}
