// `quilt doctor` — a health check that turns SILENT failure into a visible one.
//
// Quilt's hooks fail open: if capture ever stops working (QUILT_ACTOR unset, a
// hook not wired, an orchestrator change), edits quietly fall back to best-effort
// inference and nothing tells the user. This surfaces that: it reports whether
// the wiring is in place, whether identity is set, and — the key signal — how
// many edits have actually been captured. "0 edits recorded despite uncommitted
// changes" is the tell that capture isn't flowing.
import { spawn } from "node:child_process";
import { detect } from "./onboard.js";
import { readAuthorship, readCheckpoint } from "./authorship.js";
import { watcherRunning } from "./watch.js";
import { changedPaths, gitVersionString } from "./git.js";
import { openEscalations } from "./outcomes.js";
import { compareVersions, versionStanding, MIN_SAFE_VERSION, MIN_SAFE_REASON, NPM_UPDATE_COMMAND } from "./update.js";
import { VERSION } from "./version.js";
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

/** Quilt needs `git status --no-renames`, which landed in git 2.18 (2018). */
export const MIN_GIT_MAJOR = 2;
export const MIN_GIT_MINOR = 18;

/** Parse "git version 2.50.1 (Apple Git-155)" into its numeric parts. */
export function parseGitVersion(raw: string): { major: number; minor: number } | null {
  const m = raw.match(/git version (\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function gitTooOld(v: { major: number; minor: number }): boolean {
  return v.major < MIN_GIT_MAJOR || (v.major === MIN_GIT_MAJOR && v.minor < MIN_GIT_MINOR);
}

/** The outcome of spawning `quilt mcp` and asking it for its tool list. */
export interface McpProbeResult {
  ok: boolean;
  toolCount: number;
  error?: string;
}

export interface DiagnoseOptions {
  /** the caller's QUILT_ACTOR. */
  actorEnv?: string;
  /** latest published version from checkLatestVersion(): a string when known,
   * null when the check failed (offline) — then no version check is reported —
   * or undefined when no check ran at all. */
  latest?: string | null;
  /** the running version; overridable so tests can exercise stale installs. */
  currentVersion?: string;
  /** `git --version` output; overridable for tests. null = git unrunnable. */
  gitVersion?: string | null;
  /** result of probeMcpServer(); undefined when the probe wasn't run. */
  mcpProbe?: McpProbeResult;
}

/**
 * Diagnose Quilt's health in a repo. Pure except for reading state + git; returns
 * a structured report the CLI renders. `actorEnv` is the caller's QUILT_ACTOR.
 */
export function diagnose(store: Store, opts: DiagnoseOptions = {}): DoctorReport {
  const checks: Check[] = [];
  const root = store.paths.repoRoot;

  // Version staleness first — the highest-leverage check. A five-versions-stale
  // global install is how the first external user lost an afternoon: pre-0.4.0
  // builds lack auto-identity entirely, so capture silently records nothing.
  const current = opts.currentVersion ?? VERSION;
  if (compareVersions(current, MIN_SAFE_VERSION) < 0) {
    checks.push({
      label: "Version",
      status: "fail",
      detail: `v${current} is below ${MIN_SAFE_VERSION} — ${MIN_SAFE_REASON}`,
      hint: `update now: quilt update (or: ${NPM_UPDATE_COMMAND})`,
    });
  } else if (typeof opts.latest === "string") {
    const standing = versionStanding(current, opts.latest);
    checks.push(
      standing === "current"
        ? { label: "Version", status: "ok", detail: `v${current} (latest)` }
        : {
            label: "Version",
            status: "warn",
            detail: `v${current} installed, ${opts.latest} is out`,
            hint: `update: quilt update (or: ${NPM_UPDATE_COMMAND})`,
          },
    );
  }
  // opts.latest === null (offline / check failed) or undefined: stay silent —
  // a staleness nudge must never turn into a network-required error.

  // A pre-2.18 system git breaks `git status --no-renames` with a cryptic
  // usage error deep inside every quilt command — detect it here and name the
  // usual cause (an old git shadowing a newer one on PATH).
  const gitRaw = opts.gitVersion !== undefined ? opts.gitVersion : gitVersionString();
  const gitParsed = gitRaw ? parseGitVersion(gitRaw) : null;
  if (gitRaw === null) {
    checks.push({
      label: "Git",
      status: "fail",
      detail: "git can't be run from this shell",
      hint: "quilt shells out to git for everything — install git or fix PATH",
    });
  } else if (gitParsed && gitTooOld(gitParsed)) {
    checks.push({
      label: "Git",
      status: "fail",
      detail: `git ${gitParsed.major}.${gitParsed.minor} is too old — Quilt needs ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}+ (for \`git status --no-renames\`)`,
      hint: "an old git is likely shadowing a newer one on your PATH — check `which -a git` and put the newer one first, or upgrade git",
    });
  } else if (gitParsed) {
    checks.push({ label: "Git", status: "ok", detail: `git ${gitParsed.major}.${gitParsed.minor}` });
  }
  // Unparseable version output: skip rather than guess.

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

  // The live self-test: does `quilt mcp` actually start and list its tools?
  // Run by the CLI (async) and passed in; absent when the probe didn't run.
  if (opts.mcpProbe) {
    checks.push(
      opts.mcpProbe.ok
        ? {
            label: "MCP self-test",
            status: "ok",
            detail: `server starts and lists ${opts.mcpProbe.toolCount} tools`,
          }
        : {
            label: "MCP self-test",
            status: "warn",
            detail: `server didn't respond${opts.mcpProbe.error ? ` (${opts.mcpProbe.error})` : ""}`,
            hint: "check that `quilt` resolves on PATH (npm install -g @quilt-dev/cli); the capture hooks still protect edits without MCP",
          },
    );
  }

  // What doctor CANNOT see: whether the agent client has APPROVED the server.
  // Claude Code asks per project; unapproved means the claim tools never load
  // in a session even though everything above is green. Say so, and say what
  // still works — treating the optional MCP layer as the product is exactly
  // how the first external user concluded "Quilt is unusable" while the hooks
  // were protecting every edit underneath.
  if (d.quiltWired) {
    checks.push({
      label: "MCP approval",
      status: "info",
      detail: "the claim tools appear after the client restarts and approves the server (Claude Code: /mcp)",
      hint: "doctor can't see approval state — a freshly-wired server missing from a session is expected until then; the capture hooks protect edits either way",
    });
  }

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

  // Identity. Capture no longer depends on QUILT_ACTOR — the hooks fall back to
  // a per-session auto id (claude-xxxxxxxx) and the MCP server to a
  // per-connection one — so unset is informational: it means auto-naming, not
  // no-capture. An explicit id is what buys continuity across sessions.
  const actor = opts.actorEnv?.trim();
  checks.push(
    actor
      ? { label: "Identity", status: "ok", detail: `QUILT_ACTOR=${actor}` }
      : {
          label: "Identity",
          status: "info",
          detail: "QUILT_ACTOR not set — agents get auto ids per session",
          hint: "fine for most use; set QUILT_ACTOR for a stable id that persists across sessions",
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

/**
 * Spawn the wired MCP server command and drive a real initialize → tools/list
 * handshake over stdio. Proves the server starts and serves its tools FROM THE
 * CLI SIDE — it cannot prove the agent client approved the server (that lives
 * in the client). Fail-safe: any error, non-JSON output, or the timeout
 * resolves to `{ ok: false }`; never throws, never hangs past `timeoutMs`.
 */
export function probeMcpServer(opts: {
  /** the server invocation, e.g. ["quilt", "mcp"] (what .mcp.json wires). */
  command: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<McpProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (r: McpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolvePromise(r);
    };
    const [cmd, ...args] = opts.command;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd!, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "ignore"] });
    } catch (e) {
      resolvePromise({ ok: false, toolCount: 0, error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => done({ ok: false, toolCount: 0, error: `no response in ${timeoutMs}ms` }), timeoutMs);
    child.on("error", (e) => done({ ok: false, toolCount: 0, error: e.message }));
    child.on("exit", (code) => done({ ok: false, toolCount: 0, error: `server exited (${code ?? "signal"}) before responding` }));

    // The MCP stdio transport speaks newline-delimited JSON-RPC.
    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { tools?: unknown[] } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not a JSON-RPC line; keep reading until the timeout
        }
        if (msg.id === 1) {
          // initialize acked — complete the handshake, then ask for the tools.
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (msg.id === 2) {
          const tools = Array.isArray(msg.result?.tools) ? msg.result!.tools! : [];
          done(
            tools.length > 0
              ? { ok: true, toolCount: tools.length }
              : { ok: false, toolCount: 0, error: "server responded but listed no tools" },
          );
        }
      }
    });
    const send = (obj: unknown) => {
      try {
        child.stdin!.write(JSON.stringify(obj) + "\n");
      } catch {
        /* exit handler reports it */
      }
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "quilt-doctor", version: VERSION },
      },
    });
  });
}
