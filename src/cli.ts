#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import pc from "picocolors";
import { Store } from "./state.js";
import { repoRoot, shortHead, headSha } from "./git.js";
import { activeContext } from "./session.js";
import { reconcile, buildModel } from "./engine.js";
import { initSymbols } from "./symbols.js";
import { dependencyWarnings, formatWarning } from "./push.js";
import { fleetSnapshot, renderFleet } from "./fleet.js";
import { planUndo } from "./undo.js";
import { selectOwned, commitSelection } from "./commit.js";
import { renderStatus, renderPreview } from "./render.js";
import { statusJson, mineJson, conflictsJson } from "./json.js";
import { runWatch, watcherRunning } from "./watch.js";
import { acquireClaims, acquireClaimsWait, releaseClaims, listClaims, claimLabel, pathsClaimedByOthers, pathsClaimedBySelf, pathsClaimedBySelfAny, othersHoldLiveClaims, pendingGrants, markGrantsNotified, waitersBehind } from "./claims.js";
import { recordOutcome } from "./outcomes.js";
import { runMcpServer } from "./mcp.js";
import { diagnose, probeMcpServer, type Check, type McpProbeResult } from "./doctor.js";
import { checkLatestVersion, compareVersions, detectInstallManager, versionStanding, NPM_UPDATE_COMMAND, MIN_SAFE_REASON } from "./update.js";
import { parseHookInput, runHookPre, runHookPost, sessionActorId, agentActorId } from "./hooks.js";
import { detect, planSetup, applySetup, mergeHookSettings, appendCoordination, type SetupStep } from "./onboard.js";
import { recordAuthorship, capturedBySelf } from "./authorship.js";
import { repoRelative } from "./paths.js";
import { VERSION } from "./version.js";
import type { Actor, ActorType, Config, Session } from "./types.js";

// Exit quietly when output is piped into a process that closes early
// (e.g. `quilt preview | head`) instead of crashing with EPIPE. The MCP command
// removes this so a transient pipe error can't kill a long-running server.
const epipeExit = (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
};
process.stdout.on("error", epipeExit);

function fail(msg: string): never {
  process.stderr.write(pc.red("error: ") + msg + "\n");
  process.exit(1);
}

/** Immediate child directories of `cwd` that are git repos — the "you're one
 * level ABOVE the repo" case (a checkout root whose app lives in a subfolder).
 * Capped at 3: enough to name the right place without scanning forever. */
function childGitRepos(cwd: string, limit = 3): string[] {
  const out: string[] = [];
  try {
    for (const e of readdirSync(cwd, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (existsSync(join(cwd, e.name, ".git"))) out.push(e.name);
      if (out.length >= limit) break;
    }
  } catch {
    /* unreadable dir — fall through to the generic error */
  }
  return out;
}

function findRepo(): string {
  const root = repoRoot(process.cwd());
  if (!root) {
    // When a child IS a repo, name it instead of leaving the user to guess.
    // (`quilt setup` handles this shape itself — it wires the whole workspace —
    // so this guidance is for the repo-scoped commands: doctor, init, status…)
    const children = childGitRepos(process.cwd());
    if (children.length > 0) {
      fail(
        "not inside a git repository, but " +
          children.map((c) => `${c}/`).join(", ") +
          ` ${children.length === 1 ? "is one" : "are"}. Quilt commands run inside a repo:\n` +
          `  cd ${children[0]} && quilt ${process.argv[2] ?? "doctor"}\n` +
          "  (or run `quilt setup` HERE to wire this directory as a workspace)",
      );
    }
    fail("not inside a git repository. Run this from a git working tree.");
  }
  return root;
}

/** The `quilt` server invocation wired in .mcp.json (for the doctor self-test),
 * or the default when the file can't be read. */
function wiredMcpCommand(mcpJsonPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(mcpJsonPath, "utf8")) as {
      mcpServers?: { quilt?: { command?: unknown; args?: unknown } };
    };
    const q = parsed.mcpServers?.quilt;
    if (q && typeof q.command === "string") {
      const args = Array.isArray(q.args) ? q.args.filter((a): a is string => typeof a === "string") : [];
      return [q.command, ...args];
    }
  } catch {
    /* fall through */
  }
  return ["quilt", "mcp"];
}

/** The daily staleness check, unless opted out. Fail-silent: null when offline,
 * disabled, or already checked today with no answer. Never throws. */
async function latestVersionOrNull(): Promise<string | null> {
  if (process.env.QUILT_NO_UPDATE_CHECK) return null;
  return checkLatestVersion();
}

function requireStore(): Store {
  const store = new Store(findRepo());
  if (!store.initialized) {
    fail("Quilt is not initialized here. Run `quilt init` first.");
  }
  return store;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Read all of stdin as a string (for the hook commands' JSON payload). */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/**
 * Resolve the actor a hook acts as. The ladder: QUILT_ACTOR (an explicit,
 * per-process id — always wins) > an auto id from the payload's agent_id
 * (per-SUBAGENT — subagents share the session id, so this is what tells them
 * apart) > an auto id from the session id.
 *
 * Deliberately NOT in the ladder: the `.quilt/current` session pointer
 * (`quilt start`). It is a checkout-GLOBAL file, so whoever ran start last
 * would own every subsequent hook capture in the repo regardless of which
 * agent edited — the root cause behind both pilot misattribution rounds.
 * `quilt start` scopes the CLI commands you run in your own terminal;
 * per-edit capture identity comes from the payload (or QUILT_ACTOR, which is
 * per-process env and therefore actually scoped to one agent).
 *
 * Registers a first-seen actor so it shows up in the fleet. Returns null only
 * when there's no signal at all — the hook then no-ops rather than guess.
 * `auto` marks a derived id, which enables claim adoption downstream (an
 * anonymous edit inside claimed code is attributed to the claim's holder).
 */
function hookActor(
  store: Store,
  input: { sessionId: string | null; agentId: string | null; agentType: string | null },
): { id: string; auto: boolean } | null {
  const explicit = process.env.QUILT_ACTOR;
  const derived =
    (input.agentId ? agentActorId(input.agentId, input.agentType) : null) ??
    (input.sessionId ? sessionActorId(input.sessionId) : null);
  const id = explicit || derived;
  if (!id) return null;
  if (!store.findActor(id)) {
    store.upsertActor({ id, type: "agent", displayName: id.split("/").pop() ?? id, createdAt: nowIso() });
  }
  return { id, auto: !explicit };
}

/** Initialize Quilt's .quilt/ store. Returns false if it already existed. */
function doInit(root: string): boolean {
  const store = new Store(root);
  if (store.initialized) return false;
  store.ensureDirs();
  const config: Config = { version: 1, createdAt: nowIso() };
  store.writeConfig(config);
  store.writeObserved({ files: {} });
  store.writeOwnership({ files: {}, conflicts: {} });
  store.appendLedger({ ts: nowIso(), type: "repo.initialized", repoRoot: root });
  return true;
}

/** Print one setup step (create/update/skip) for `quilt setup`. */
function printSetupStep(step: SetupStep, dryRun: boolean): void {
  if (step.action === "skip") {
    process.stdout.write(pc.dim(`  • ${step.file}: ${step.detail}\n`));
    return;
  }
  const verb = dryRun ? pc.cyan("  would ") : pc.green("  ✓ ");
  process.stdout.write(verb + `${step.action} ${step.file} — ${step.detail}\n`);
}

/**
 * Apply setup steps and attribute Quilt's own writes to `quilt-setup`, so the
 * first `quilt status` a user ever sees doesn't flag Quilt's own files as
 * suspicious unattributed changes. Attribution is skipped when `root` has no
 * initialized store (e.g. a workspace root outside any repo — those files are
 * invisible to git and need no attribution). Returns the steps written.
 */
function applySetupAttributed(root: string, steps: SetupStep[]): SetupStep[] {
  const prior = new Map<string, string | null>();
  for (const s of steps) {
    if (s.action === "skip" || s.content === undefined) continue;
    prior.set(s.file, existsSync(s.path) ? readFileSync(s.path, "utf8") : null);
  }
  const written = applySetup(steps);
  if (written.length > 0) {
    const store = new Store(root);
    if (store.initialized) {
      if (!store.findActor("quilt-setup")) {
        store.upsertActor({ id: "quilt-setup", type: "bot", displayName: "quilt-setup", createdAt: nowIso() });
      }
      for (const s of written) {
        const before = prior.get(s.file) ?? null;
        recordAuthorship(store, {
          actor: "quilt-setup",
          path: s.file,
          oldText: before ?? "",
          newText: s.content!,
          whole: before === null,
          intent: "quilt setup wiring",
        });
      }
    }
  }
  return written;
}

/** The workspace-root wiring plan: capture hooks + coordination snippet at the
 * directory sessions START in. No .mcp.json here — the MCP server is
 * repo-bound and is wired inside each child repo instead. */
function planWorkspaceRoot(wsRoot: string): SetupStep[] {
  const steps: SetupStep[] = [];
  const settingsPath = join(wsRoot, ".claude", "settings.json");
  const settingsExisting = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  const hooks = mergeHookSettings(settingsExisting);
  if (hooks.error) {
    steps.push({ file: ".claude/settings.json", action: "skip", detail: `left untouched (${hooks.error}) — add the quilt hooks by hand`, path: settingsPath });
  } else if (!hooks.changed) {
    steps.push({ file: ".claude/settings.json", action: "skip", detail: "capture hooks already present", path: settingsPath });
  } else {
    steps.push({
      file: ".claude/settings.json",
      action: settingsExisting !== null ? "update" : "create",
      detail: "add the Edit/Write capture hooks (loads for sessions started here)",
      content: hooks.content,
      path: settingsPath,
    });
  }
  const mdPath = join(wsRoot, "CLAUDE.md");
  const mdExisting = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : null;
  const md = appendCoordination(mdExisting);
  if (!md.changed) {
    steps.push({ file: "CLAUDE.md", action: "skip", detail: "coordination snippet already present", path: mdPath });
  } else {
    steps.push({
      file: "CLAUDE.md",
      action: mdExisting !== null ? "update" : "create",
      detail: mdExisting !== null ? "add the coordination snippet" : "create with the coordination snippet",
      content: md.content,
      path: mdPath,
    });
  }
  return steps;
}

/**
 * `quilt setup` from a directory that isn't a repo but CONTAINS repos: treat it
 * as a workspace. Sessions started here load hooks/instructions from HERE, and
 * the hooks attribute each edit to the repo its file lives in — so the root
 * gets hooks + snippet, and every child repo gets the full per-repo wiring.
 */
async function workspaceSetup(wsRoot: string, children: string[], dryRun: boolean): Promise<void> {
  process.stdout.write(
    pc.dim(`Not a git repo, but ${children.length} ${children.length === 1 ? "repo lives" : "repos live"} inside — wiring this directory as a workspace.\n`) +
      pc.dim("Sessions started here are captured into whichever repo each edit belongs to.\n\n"),
  );

  process.stdout.write(pc.bold("workspace root") + "\n");
  const rootSteps = planWorkspaceRoot(wsRoot);
  if (!dryRun) applySetupAttributed(wsRoot, rootSteps);
  for (const s of rootSteps) printSetupStep(s, dryRun);

  for (const child of children) {
    const childRoot = join(wsRoot, child);
    process.stdout.write("\n" + pc.bold(child + "/") + "\n");
    const initNeeded = !new Store(childRoot).initialized;
    if (dryRun) {
      if (initNeeded) process.stdout.write(pc.cyan("  would ") + "initialize Quilt (.quilt/)\n");
      for (const s of planSetup(childRoot)) printSetupStep(s, true);
      continue;
    }
    if (initNeeded) {
      doInit(childRoot);
      process.stdout.write(pc.green("  ✓ ") + "initialized Quilt (.quilt/)\n");
    }
    const childSteps = planSetup(childRoot);
    applySetupAttributed(childRoot, childSteps);
    for (const s of childSteps) printSetupStep(s, false);
  }

  if (dryRun) {
    process.stdout.write("\n" + pc.dim("Run `quilt setup` to apply.\n"));
    return;
  }

  process.stdout.write(
    "\n" +
      pc.green("✓ ") +
      "Workspace wired. Start sessions here (or in any repo) — edits are captured\n" +
      "  and protected by the hooks automatically, per repo.\n" +
      pc.dim("  Run quilt commands (status, fleet, commit --mine) inside a repo.\n") +
      pc.dim("  Note: the optional MCP claim tools load per repo, so sessions started at\n") +
      pc.dim("  the workspace root won't have them — the hooks and CLI carry everything.\n"),
  );

  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["quilt"], { stdio: "ignore" });
  if (probe.status !== 0) {
    process.stdout.write(
      "\n" + pc.yellow("⚠ ") + "`quilt` is not on your PATH — the hooks this setup wired invoke plain\n" +
        "  `quilt` and will silently do nothing until it resolves.\n" +
        pc.dim("  Install globally: npm install -g @quilt-dev/cli\n"),
    );
  }
  const latest = await latestVersionOrNull();
  if (latest && versionStanding(VERSION, latest) !== "current") {
    process.stdout.write(
      "\n" + pc.yellow("⚠ ") + `quilt ${VERSION} is behind the latest release (${latest}).\n` +
        pc.dim(`  Update: quilt update   (or: ${NPM_UPDATE_COMMAND})\n`),
    );
  }
}

/** Print active advisory claims below a status view. When `forActor` is set,
 * annotate that actor's own claims with how many agents are queued behind them
 * — so a holder sees the pressure and commits promptly instead of releasing
 * blind. */
function printClaims(store: Store, forActor?: string | null): void {
  const now = Date.now();
  const claims = listClaims(store, now);
  if (claims.length === 0) return;
  process.stdout.write(pc.dim(pc.bold("  Claimed (reserved for editing):\n")));
  for (const c of claims) {
    let tail = pc.dim(c.actor);
    if (forActor && c.actor === forActor) {
      const behind = waitersBehind(store, c, now);
      if (behind.length) {
        tail += pc.yellow(`  ← ${behind.length} waiting (${behind.join(", ")}) — commit to hand off`);
      }
    }
    process.stdout.write(`    ${claimLabel(c)}   ${tail}${c.viaQueue ? pc.dim("  (from queue)") : ""}\n`);
  }
  process.stdout.write("\n");
}

/** Surface any claims auto-granted off the queue for `actorId` since it last
 * looked, and mark them announced (shout exactly once). Used by both `status`
 * and `claim`, so an agent discovers its grant on either natural check-back —
 * not only via status. Returns the grant labels (for JSON callers). */
function surfaceGrants(store: Store, actorId: string | null): string[] {
  if (!actorId) return [];
  const grants = pendingGrants(store, actorId, Date.now());
  if (grants.length === 0) return [];
  process.stdout.write(pc.green(pc.bold("  ✓ Granted while you waited:\n")));
  for (const c of grants) {
    process.stdout.write(`    ${claimLabel(c)}${c.intent ? pc.dim(`  (${c.intent})`) : ""}\n`);
  }
  process.stdout.write(pc.dim("    it's yours now — re-read the file and layer your change on top.\n\n"));
  markGrantsNotified(store, actorId, Date.now(), grants);
  return grants.map((c) => claimLabel(c));
}

/** Print any preserved (clobbered) work below a status view. */
function printClobbers(store: Store): void {
  const open = store.readClobbers().clobbers.filter((c) => !c.restored);
  if (open.length === 0) return;
  process.stdout.write(pc.red(pc.bold("  Overwrite preserved (work saved):\n")));
  for (const c of open) {
    process.stdout.write(
      `    ${c.path}   ${pc.dim(`${c.byActor} overwrote ${c.victimActor}`)}\n`,
    );
  }
  process.stdout.write(pc.dim("    recover with: quilt restore <path>\n\n"));
}

/** Normalize commit/preview path args to a repo-relative allow-list, or
 * undefined when none were given (commit all your owned files). Entries name a
 * file or a directory prefix. `.`/the repo root means "everything" (""). A path
 * that escapes the repo is a hard error — silently dropping it would shrink
 * the commit with no signal. */
function onlyPathsFrom(store: Store, paths: string[] | undefined): Set<string> | undefined {
  if (!paths || paths.length === 0) return undefined;
  const set = new Set<string>();
  for (const p of paths) {
    if (p === "." || resolve(store.paths.repoRoot, p) === resolve(store.paths.repoRoot)) {
      set.add("");
      continue;
    }
    const rel = repoRelative(store.paths.repoRoot, p);
    if (rel === null) fail(`path "${p}" is outside this repository`);
    set.add(rel!);
  }
  return set;
}

/** The ownership predicates every `selectOwned` caller must pass — claim and
 * capture signals plus the contested-tree flag. One builder so no command
 * forgets a predicate (a missing predicate reads as "not owned" and wrongly
 * skips a claimed or captured new file). */
function ownershipSignals(store: Store, actorId: string) {
  const now = Date.now();
  return {
    pathClaimedByOther: pathsClaimedByOthers(store, actorId, now),
    pathClaimedBySelf: pathsClaimedBySelf(store, actorId, now),
    pathClaimedBySelfAny: pathsClaimedBySelfAny(store, actorId, now),
    pathCapturedBySelf: capturedBySelf(store, actorId),
    othersActive: othersHoldLiveClaims(store, actorId, now),
  };
}

const program = new Command();
program
  .name("quilt")
  .description("Actor-owned patches for Git. Same repo. Many agents. Clean commits.")
  .version(VERSION)
  // A uniform identity flag for every command — the ergonomic alternative to
  // prefixing `QUILT_ACTOR=<id>` on each call (which is easy to forget, and a
  // forgotten prefix misattributes silently). Named `--as` (not `--actor`) so
  // it never collides with `start --actor`. It just seeds the same env the rest
  // of the resolution already reads, so it composes with sessions and hooks
  // unchanged. An explicit env var still wins if both are set.
  .option("--as <id>", "act as this actor for this command (sets QUILT_ACTOR; an explicit QUILT_ACTOR env var wins)")
  .hook("preAction", (thisCommand) => {
    const as = thisCommand.opts().as as string | undefined;
    if (as && !process.env.QUILT_ACTOR) process.env.QUILT_ACTOR = as;
  });

program
  .command("init")
  .description("Initialize Quilt in this repository")
  .action(() => {
    const root = findRepo();
    const created = doInit(root);
    if (!created) {
      process.stdout.write(pc.dim("Quilt already initialized at .quilt/\n"));
    } else {
      process.stdout.write(
        pc.green("✓ ") + "Quilt initialized.\n" +
          pc.dim("  Next: quilt setup (wires your agents in — identity is automatic)\n"),
      );
    }
    // If this looks like an agent-orchestrated repo, point at one-step wiring.
    const d = detect(root);
    if (d.orchestrator && !(d.quiltWired && d.coordinationPresent)) {
      process.stdout.write(
        "\n" +
          pc.cyan("→ ") +
          `${d.orchestrator} detected. Wire the fleet up with ` +
          pc.bold("quilt setup") +
          pc.dim(" (adds the shared MCP server + coordination snippet).\n"),
      );
    }
  });

program
  .command("setup")
  .description("Wire Quilt into this repo's agent orchestrator (.mcp.json + CLAUDE.md + capture hooks)")
  .option("--dry-run", "show what would change without writing")
  .action(async (opts) => {
    const dryRun = Boolean(opts.dryRun);
    // Workspace shape: not a repo, but repos inside. Sessions start HERE (this
    // is where their hooks and instructions load from), so wire here + each
    // child, instead of refusing and sending the user one level down.
    const cwd = process.cwd();
    if (!repoRoot(cwd)) {
      const children = childGitRepos(cwd, 50);
      if (children.length > 0) {
        await workspaceSetup(cwd, children, dryRun);
        return;
      }
    }
    const root = findRepo();
    const store = new Store(root);

    const initNeeded = !store.initialized;
    if (initNeeded && !dryRun) doInit(root);

    const d = detect(root);
    const steps = planSetup(root);
    const willChange = steps.some((s) => s.action !== "skip");

    if (d.orchestrator) {
      process.stdout.write(pc.dim(`Detected ${d.orchestrator}.\n`));
    } else {
      process.stdout.write(
        pc.dim("No orchestrator config detected — wiring up for Claude Code (.mcp.json + CLAUDE.md + hooks).\n"),
      );
    }

    if (dryRun) {
      if (initNeeded) {
        process.stdout.write(pc.cyan("  would ") + "initialize Quilt (.quilt/)\n");
      }
      for (const s of steps) printSetupStep(s, true);
      process.stdout.write(
        "\n" + pc.dim(willChange || initNeeded ? "Run `quilt setup` to apply.\n" : "Already wired — nothing to do.\n"),
      );
      return;
    }

    const written = applySetupAttributed(root, steps);
    if (initNeeded) process.stdout.write(pc.green("✓ ") + "initialized Quilt (.quilt/)\n");
    for (const s of steps) printSetupStep(s, false);

    if (written.length === 0 && !initNeeded) {
      process.stdout.write("\n" + pc.green("✓ ") + "Already wired up. Your fleet is ready.\n");
    } else {
      process.stdout.write(
        "\n" +
          pc.green("✓ ") +
          "Quilt is wired in. Edits are captured and protected by the hooks automatically.\n" +
          pc.dim("  Agents are named automatically (per session/connection). Set QUILT_ACTOR\n") +
          pc.dim("  on an agent's process for a stable id that persists across sessions.\n") +
          pc.dim("  Commit the generated config files so every checkout and teammate shares\n") +
          pc.dim("  the wiring (.quilt/ stays local and is already ignored).\n") +
          pc.dim("  Run `quilt doctor` to confirm capture is flowing.\n") +
          pc.dim("  Docs: https://github.com/wkoverfield/quilt/blob/main/docs/orchestrators.md\n"),
      );
    }

    // The wall the first external fleet hit: Claude Code loads .mcp.json
    // servers only after a restart + per-project approval, and nothing in
    // Quilt's output ever said so — workers saw no quilt tools and concluded
    // Quilt was broken, while the hooks were protecting every edit underneath.
    // Make the restart a stated non-event, not a silent trap.
    process.stdout.write(
      "\n" +
        pc.cyan("→ ") +
        "You're already protected: the capture hooks are live and need nothing else.\n" +
        "  The optional MCP claim tools appear once Claude Code restarts and approves\n" +
        "  the server (/mcp shows it). An agent without them still coordinates fine:\n" +
        "  quilt claim to reserve, quilt commit --mine to commit its own lines.\n",
    );

    // The generated config invokes plain `quilt` — if that doesn't resolve on
    // PATH (local/npx install), hooks and the MCP server would fail silently
    // (hooks fail open by design). Say so now instead of leaving `quilt doctor`
    // to notice zero captures later.
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["quilt"], { stdio: "ignore" });
    if (probe.status !== 0) {
      process.stdout.write(
        "\n" +
          pc.yellow("⚠ ") +
          "`quilt` is not on your PATH — the hooks and MCP server this setup wired\n" +
          "  invoke plain `quilt` and will silently do nothing until it resolves.\n" +
          pc.dim("  Install globally: npm install -g @quilt-dev/cli\n"),
      );
    }

    // Staleness nudge: the first external user was five versions behind and
    // nothing ever told him. Cached daily, bounded, and fail-silent — offline
    // setup stays exactly as fast and quiet as before.
    const latest = await latestVersionOrNull();
    if (latest && versionStanding(VERSION, latest) !== "current") {
      process.stdout.write(
        "\n" +
          pc.yellow("⚠ ") +
          `quilt ${VERSION} is behind the latest release (${latest}).\n` +
          pc.dim(`  Update: quilt update   (or: ${NPM_UPDATE_COMMAND})\n`),
      );
    }
  });

program
  .command("start")
  .description("Start a session for an actor in this checkout (optional — agents are auto-named; QUILT_ACTOR also works)")
  .option("--actor <id>", "actor id, e.g. wilson")
  .option("--type <type>", "actor type: human | agent | bot", "human")
  .option("--name <displayName>", "human-readable display name")
  .option("--email <email>", "email used as the git author for this actor")
  .action((opts) => {
    if (!opts.actor) {
      fail(
        "start needs an identity: quilt start --actor <id>\n" +
          "  example: quilt start --actor wilson\n" +
          "  (you usually don't need this — agents are auto-named per session, and\n" +
          "   QUILT_ACTOR=<id> on any command works without a session)",
      );
    }
    const store = requireStore();
    const root = store.paths.repoRoot;
    const type = opts.type as ActorType;
    if (!["human", "agent", "bot"].includes(type)) {
      fail(`invalid --type "${type}". Use human, agent, or bot.`);
    }
    const displayName: string =
      opts.name ?? opts.actor.split("/").pop() ?? opts.actor;
    const actor: Actor = {
      id: opts.actor,
      type,
      displayName,
      email: opts.email,
      createdAt: nowIso(),
    };
    store.upsertActor(actor);

    const session: Session = {
      id: `sess_${randomUUID().slice(0, 12)}`,
      actorId: actor.id,
      actorType: type,
      repoRoot: root,
      baseSha: headSha(root),
      startedAt: nowIso(),
      status: "active",
    };
    store.writeSession(session);
    store.writeCurrentSessionId(session.id);
    // Seed the observed snapshot to the current tree so any pre-existing dirty
    // changes stay unattributed (unclaimed), not silently claimed by this actor.
    reconcile(store, null);
    store.appendLedger({
      ts: nowIso(),
      type: "session.started",
      actorId: actor.id,
      sessionId: session.id,
      baseSha: session.baseSha,
    });
    process.stdout.write(
      pc.green("✓ ") +
        `Session started for ${pc.bold(actor.id)} (${type}).\n` +
        pc.dim(`  session: ${session.id}\n  base:    ${shortHead(root)}\n`),
    );
  });

program
  .command("status")
  .description("Show who owns which working-tree changes")
  .option("--json", "emit stable JSON for agents")
  .action((opts) => {
    const store = requireStore();
    const ctx = activeContext(store);
    reconcile(store, ctx.actorId);
    const model = buildModel(store, ctx.actorId);
    const warnings = ctx.actorId
      ? dependencyWarnings(store, ctx.actorId, Date.now())
      : [];
    // Async claims: surface anything auto-granted off the queue since this
    // actor last looked, then mark it announced so it shouts exactly once.
    if (opts.json) {
      const grants = ctx.actorId ? pendingGrants(store, ctx.actorId, Date.now()) : [];
      process.stdout.write(
        JSON.stringify(
          {
            ...statusJson(model, headSha(store.paths.repoRoot)),
            dependencyWarnings: warnings,
            grantedWhileWaiting: grants.map((c) => claimLabel(c)),
          },
          null,
          2,
        ) + "\n",
      );
      if (ctx.actorId && grants.length) markGrantsNotified(store, ctx.actorId, Date.now(), grants);
      return;
    }
    surfaceGrants(store, ctx.actorId);
    process.stdout.write(renderStatus(model, shortHead(store.paths.repoRoot)));
    if (watcherRunning(store)) {
      process.stdout.write(pc.dim("  watching: live (quilt watch)\n\n"));
    }
    printClaims(store, ctx.actorId);
    if (warnings.length) {
      process.stdout.write(pc.yellow(pc.bold("  Dependency heads-up:\n")));
      for (const w of warnings) {
        process.stdout.write("    " + pc.yellow("⚠ ") + formatWarning(w) + "\n");
      }
      process.stdout.write("\n");
    }
    printClobbers(store);
  });

program
  .command("undo")
  .description("Back out one actor's uncommitted changes from the working tree, keeping everyone else's")
  .argument("<actor>", "the actor whose uncommitted changes to revert")
  .option("--dry-run", "show what would be reverted without changing any files")
  .action((actor: string, opts: { dryRun?: boolean }) => {
    const store = requireStore();
    const ctx = activeContext(store);
    reconcile(store, ctx.actorId);
    const model = buildModel(store, ctx.actorId);
    const plan = planUndo(model, store.readOwnership(), actor);

    if (plan.files.length === 0 && plan.skippedBinary.length === 0) {
      process.stdout.write(pc.dim(`No attributed uncommitted changes owned by ${actor}.\n`));
      return;
    }
    if (opts.dryRun) {
      process.stdout.write(
        pc.bold(`Would back out ${plan.totalReverted} line-change(s) by ${actor}:\n`),
      );
      for (const f of plan.files) {
        const what = f.text === null ? "delete" : `${f.reverted} line${f.reverted === 1 ? "" : "s"}`;
        process.stdout.write(`    ${f.path}   ${pc.dim(`(${what})`)}\n`);
      }
      for (const p of plan.skippedBinary) {
        process.stdout.write(pc.dim(`    ${p}   (binary — can't line-revert)\n`));
      }
      return;
    }

    const repoRoot = store.paths.repoRoot;
    for (const f of plan.files) {
      const abs = resolve(repoRoot, f.path);
      if (f.text === null) {
        rmSync(abs, { force: true });
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.text);
      }
    }
    // Absorb the undo so the next reconcile doesn't re-attribute it, and drop the
    // actor's now-gone ownership. Other actors' entries are left intact.
    store.withLock(() => {
      const obs = store.readObserved();
      const own = store.readOwnership();
      for (const f of plan.files) {
        obs.files[f.path] = f.text;
        const fo = own.files[f.path];
        if (fo) {
          for (const k of Object.keys(fo.added)) if (fo.added[k] === actor) delete fo.added[k];
          for (const k of Object.keys(fo.removed)) if (fo.removed[k] === actor) delete fo.removed[k];
        }
      }
      store.writeObserved(obs);
      store.writeOwnership(own);
    });
    process.stdout.write(
      pc.green("✓ ") +
        `Backed out ${plan.totalReverted} line-change(s) by ${actor} across ${plan.files.length} file(s). ` +
        "Other actors' work is untouched.\n",
    );
    for (const p of plan.skippedBinary) {
      process.stdout.write(pc.dim(`  skipped binary (can't line-revert): ${p}\n`));
    }
  });

program
  .command("fleet")
  .description("Mission control: a live view of the fleet — who's working, claims, conflicts")
  .option("--json", "emit the fleet view as JSON")
  .option("--watch", "refresh the view live until Ctrl-C")
  .action((opts: { json?: boolean; watch?: boolean }) => {
    const store = requireStore();
    const headLabel = shortHead(store.paths.repoRoot);
    if (opts.json) {
      process.stdout.write(JSON.stringify(fleetSnapshot(store, Date.now()), null, 2) + "\n");
      return;
    }
    const draw = () => {
      const view = renderFleet(fleetSnapshot(store, Date.now()), headLabel);
      if (opts.watch) process.stdout.write("\x1b[2J\x1b[H"); // clear + home
      process.stdout.write(view);
    };
    draw();
    if (!opts.watch) return;
    process.stdout.write(pc.dim("  (live — Ctrl-C to stop)\n"));
    const timer = setInterval(draw, 1000);
    const stop = () => {
      clearInterval(timer);
      process.stdout.write("\n");
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

program
  .command("mine")
  .description("Summarize the changes you own")
  .option("--json", "emit stable JSON for agents")
  .action((opts) => {
    const store = requireStore();
    const ctx = activeContext(store);
    if (!ctx.actorId) fail("no active actor. Set QUILT_ACTOR=<id> (or run `quilt start --actor <id>`).");
    reconcile(store, ctx.actorId);
    const model = buildModel(store, ctx.actorId);
    const selection = selectOwned(model, store.paths.repoRoot, store.readOwnership(), ownershipSignals(store, ctx.actorId));
    if (opts.json) {
      process.stdout.write(JSON.stringify(mineJson(selection, false), null, 2) + "\n");
      return;
    }
    if (selection.files.length === 0) {
      process.stdout.write(pc.dim("You don't own any uncommitted changes.\n"));
      return;
    }
    process.stdout.write(pc.bold(`\n  Your changes (${ctx.actorId}):\n\n`));
    for (const f of selection.files) {
      process.stdout.write(
        `    ${f.path}   ${pc.green("+" + f.addedLines)} ${pc.red("-" + f.removedLines)}  ${pc.dim(`${f.hunkCount} hunk${f.hunkCount === 1 ? "" : "s"}`)}\n`,
      );
    }
    if (selection.hasMixed) {
      process.stdout.write(
        pc.yellow("\n  Some hunks also touch unattributed lines (use --include-unclaimed to commit them).\n"),
      );
    }
    process.stdout.write("\n");
  });

program
  .command("conflicts")
  .description("Show shared changes: same-line clashes (contended) vs adjacent edits that commit cleanly")
  .option("--json", "emit stable JSON for agents")
  .action((opts) => {
    const store = requireStore();
    const ctx = activeContext(store);
    reconcile(store, ctx.actorId);
    const model = buildModel(store, ctx.actorId);
    const data = conflictsJson(model);
    if (opts.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      return;
    }
    if (data.conflicts.length === 0) {
      process.stdout.write(pc.green("✓ No conflicts.\n"));
      return;
    }
    process.stdout.write(pc.yellow(pc.bold("\n  Conflicts:\n\n")));
    for (const c of data.conflicts) {
      process.stdout.write(
        `    ${c.path}   ${pc.dim(c.actors.join(", "))}   ${c.lines} line(s)\n`,
      );
    }
    process.stdout.write("\n");
  });

program
  .command("preview")
  .description("Preview the exact patch `commit --mine` would create")
  .argument("[paths...]", "limit to these files (default: all your owned files)")
  .option("--mine", "preview your owned patch (default)")
  .option("--include-unclaimed", "also include hunks that touch unattributed lines")
  .option("--json", "emit the patch as JSON")
  .action((paths: string[], opts) => {
    const store = requireStore();
    const ctx = activeContext(store);
    if (!ctx.actorId) fail("no active actor. Set QUILT_ACTOR=<id> (or run `quilt start --actor <id>`).");
    reconcile(store, ctx.actorId);
    const model = buildModel(store, ctx.actorId);
    const selection = selectOwned(model, store.paths.repoRoot, store.readOwnership(), {
      includeMixed: opts.includeUnclaimed,
      onlyPaths: onlyPathsFrom(store, paths),
      ...ownershipSignals(store, ctx.actorId),
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(mineJson(selection, true), null, 2) + "\n");
      return;
    }
    process.stdout.write("\n" + renderPreview(selection.patch) + "\n\n");
    if (selection.blockedFiles.length) {
      process.stdout.write(
        pc.yellow(
          `  Note: ${selection.blockedFiles.join(", ")} also contain changes owned by others — only your hunks are shown.\n\n`,
        ),
      );
    }
    if (selection.skippedUnowned.length) {
      process.stdout.write(
        pc.yellow("  ⚠ Would leave out new files you never claimed or edited: ") +
          selection.skippedUnowned.join(", ") +
          pc.yellow("\n    (if they're yours: quilt claim <path>, or --include-unclaimed; else ignore)\n\n"),
      );
    }
  });

program
  .command("commit")
  .description("Commit only your owned patch")
  .argument("[paths...]", "limit the commit to these files (default: all your owned files)")
  .option("--mine", "commit your owned hunks (required)")
  .requiredOption("-m, --message <message>", "commit message")
  .option("--dry-run", "show what would happen without committing")
  .option("--include-unclaimed", "also commit hunks that touch unattributed lines")
  .action((paths: string[], opts) => {
    const store = requireStore();
    if (!opts.mine) fail("commit requires --mine in V0 (only owned-patch commits are supported).");
    let ctx = activeContext(store);
    if (!ctx.actorId) {
      fail("no active actor. Set QUILT_ACTOR=<id> (or run `quilt start --actor <id>`).");
    }
    if (!ctx.actor) {
      // An explicit QUILT_ACTOR that never registered (it only claimed, or its
      // edits were captured under adoption) is a declared identity, not an
      // error — register it now so its commit can carry a git author.
      const a: Actor = {
        id: ctx.actorId!,
        type: "agent",
        displayName: ctx.actorId!.split("/").pop() ?? ctx.actorId!,
        createdAt: nowIso(),
      };
      store.upsertActor(a);
      ctx = { ...ctx, actor: a };
    }
    reconcile(store, ctx.actorId);
    const model = buildModel(store, ctx.actorId);
    const selection = selectOwned(model, store.paths.repoRoot, store.readOwnership(), {
      includeMixed: opts.includeUnclaimed,
      onlyPaths: onlyPathsFrom(store, paths),
      ...ownershipSignals(store, ctx.actorId!),
    });

    if (selection.files.length === 0 && selection.wholeFiles.length === 0) {
      if (selection.skippedUnowned.length) {
        fail(
          "nothing you own to commit here. New files you never claimed or edited were left out: " +
            selection.skippedUnowned.join(", ") +
            " — if they're yours, claim them (quilt claim <path>) or pass --include-unclaimed.",
        );
      }
      if (selection.skippedBinary.length) {
        fail(
          "nothing committable at line level, and these binary/too-large files are unclaimed: " +
            selection.skippedBinary.join(", ") +
            " — claim them (quilt claim <path>) to commit them whole.",
        );
      }
      fail("you don't own any committable changes. See `quilt status`.");
    }

    const root = store.paths.repoRoot;
    if (opts.dryRun) {
      const res = commitSelection(root, selection, ctx.actor!, opts.message, {
        dryRun: true,
      });
      process.stdout.write("\n" + renderPreview(selection.patch) + "\n\n");
      if (res.reason && res.reason !== "dry-run") {
        fail(res.reason);
      }
      const dryCount = selection.files.length + selection.wholeFiles.length;
      process.stdout.write(
        pc.dim(
          `  dry-run: would commit ${dryCount} file(s), ` +
            `+${selection.totalAdded}/-${selection.totalRemoved} as ${ctx.actor!.displayName}.\n` +
            "  (no changes were made)\n\n",
        ),
      );
      // The dry run is the verification surface — a skip invisible here defeats
      // the point of previewing.
      if (selection.skippedUnowned.length) {
        process.stdout.write(
          pc.yellow("  ⚠ Would leave out new files you never claimed or edited: ") +
            selection.skippedUnowned.join(", ") +
            pc.yellow("\n    (if they're yours: quilt claim <path>, or --include-unclaimed; else ignore)\n"),
        );
      }
      return;
    }

    const res = commitSelection(root, selection, ctx.actor!, opts.message);
    if (!res.committed) fail(res.reason ?? "commit failed");

    // The work landed, so the reservations on it are spent — release them, as
    // the MCP commit_mine already does, so the fleet view doesn't keep showing
    // this actor as holding claims on files it already committed.
    const rel = releaseClaims(store, ctx.actorId!, [...selection.files.map((f) => f.path), ...selection.wholeFiles]);
    store.appendLedger({
      ts: nowIso(),
      type: "commit.mine",
      actorId: ctx.actorId,
      sessionId: ctx.session?.id ?? null,
      commitSha: res.commitSha,
      files: [...selection.files.map((f) => f.path), ...selection.wholeFiles],
    });
    // Re-observe so the freshly committed lines drop out of ownership.
    reconcile(store, ctx.actorId);

    // Count line-level files AND whole-staged binaries — a pure-binary commit
    // committed real work even though `files` (the line-level split) is empty,
    // so reporting "0 file(s)" reads as if nothing happened.
    const committedCount = selection.files.length + selection.wholeFiles.length;
    process.stdout.write(
      pc.green("✓ ") +
        `Committed ${committedCount} file(s) as ${pc.bold(ctx.actor!.displayName)} ` +
        `(${res.commitSha!.slice(0, 7)}).\n` +
        pc.dim("  Other actors' changes remain in the working tree.\n") +
        (rel.released > 0
          ? pc.dim(`  Auto-released ${rel.released} claim(s) on the committed files.\n`)
          : ""),
    );
    if (selection.wholeFiles.length) {
      process.stdout.write(
        pc.dim(`  Committed whole (claimed binary/too-large): ${selection.wholeFiles.join(", ")}\n`),
      );
    }
    if (selection.skippedBinary.length) {
      process.stdout.write(
        pc.yellow("  ⚠ Skipped binary/too-large files nobody claimed: ") +
          selection.skippedBinary.join(", ") +
          pc.yellow("\n    (claim a file to commit it whole: quilt claim <path>)\n"),
      );
    }
    if (selection.skippedUnowned.length) {
      process.stdout.write(
        pc.yellow("  ⚠ Left out new files you never claimed or edited: ") +
          selection.skippedUnowned.join(", ") +
          pc.yellow("\n    (if they're yours: quilt claim <path>, or --include-unclaimed; else ignore)\n"),
      );
    }
    if (selection.blockedFiles.length) {
      process.stdout.write(
        pc.dim(`  Left untouched in shared files: ${selection.blockedFiles.join(", ")}\n`),
      );
    }
  });

program
  .command("watch")
  .description("Watch the working tree: attribute edits live and catch collisions")
  .action(() => {
    const store = requireStore();
    runWatch(store);
  });

program
  .command("restore")
  .description("List or restore work that was overwritten (clobbered) by another actor")
  .argument("[path]", "the file whose overwritten version to restore")
  .option("--json", "emit clobber records as JSON")
  .action((path: string | undefined, opts: { json?: boolean }) => {
    const store = requireStore();
    const all = store.readClobbers().clobbers;
    const open = all.filter((c) => !c.restored);

    if (opts.json) {
      process.stdout.write(JSON.stringify({ clobbers: open }, null, 2) + "\n");
      return;
    }

    if (!path) {
      if (open.length === 0) {
        process.stdout.write(pc.green("✓ ") + "Nothing to restore — no overwritten work.\n");
        return;
      }
      process.stdout.write(pc.bold("\n  Overwritten work (preserved):\n\n"));
      for (const c of open) {
        process.stdout.write(
          `    ${c.path}   ${pc.dim(`${c.byActor} over ${c.victimActor}`)}\n` +
            pc.dim(`      restore with: quilt restore ${c.path}\n`),
        );
      }
      process.stdout.write("\n");
      return;
    }

    // Restore the most recent preserved version for this path to a safe sidecar
    // file, so the current working-tree content is never destroyed.
    const match = [...open].reverse().find((c) => c.path === path);
    if (!match) {
      fail(`no preserved version found for ${path}. Run \`quilt restore\` to list.`);
    }
    const content = store.readSnapshot(match!.snapshotId);
    if (content === null) fail(`snapshot for ${path} is missing.`);

    // Build the sidecar from the RECORDED path (trusted, repo-relative) and
    // refuse to write anywhere outside the repository root.
    const safeActor = match!.victimActor.replace(/[^\w.-]+/g, "-");
    const repoRootAbs = resolve(store.paths.repoRoot);
    const sidecarAbs = resolve(repoRootAbs, `${match!.path}.quilt-${safeActor}`);
    if (sidecarAbs !== repoRootAbs && !sidecarAbs.startsWith(repoRootAbs + sep)) {
      fail(`refusing to restore outside the repository: ${match!.path}`);
    }
    mkdirSync(dirname(sidecarAbs), { recursive: true });
    writeFileSync(sidecarAbs, content!);
    const sidecarRel = sidecarAbs.slice(repoRootAbs.length + 1);

    const clobbers = store.readClobbers();
    for (const c of clobbers.clobbers) {
      if (c.id === match!.id) c.restored = true;
    }
    store.writeClobbers(clobbers);
    // Drop the preserved blob once no open clobber still references it.
    if (!clobbers.clobbers.some((c) => c.snapshotId === match!.snapshotId && !c.restored)) {
      rmSync(store.paths.snapshot(match!.snapshotId), { force: true });
    }
    store.appendLedger({
      ts: nowIso(),
      type: "clobber.restored",
      path: match!.path,
      sidecar: sidecarRel,
      snapshotId: match!.snapshotId,
    });
    process.stdout.write(
      pc.green("✓ ") +
        `Restored ${pc.bold(match!.victimActor)}'s overwritten version of ${match!.path}\n` +
        pc.dim(`  → ${sidecarRel} (your current file is untouched; diff and merge as needed)\n`),
    );
  });

program
  .command("claim")
  .description("Reserve files (or file#symbol) for editing; with none, lists claims")
  .argument("[paths...]", "files to claim; with none, lists active claims")
  .option("--json", "emit JSON")
  .option("--intent <text>", "a short why for this claim, shown to anyone it blocks")
  .option("--creating", "allow symbol claims for symbols you are ABOUT TO ADD (they bind at write time)")
  .option("--wait [seconds]", "block until denied targets free up (holder releases, commits, or their lease lapses); default window 600s")
  .option("--queue", "async: if denied, register interest and get auto-granted when it frees — don't block, keep working (check back with quilt status)")
  .action(async (paths: string[], opts: { json?: boolean; intent?: string; creating?: boolean; wait?: string | boolean; queue?: boolean }) => {
    const store = requireStore();
    const ctx = activeContext(store);

    if (!paths || paths.length === 0) {
      const claims = listClaims(store, Date.now());
      if (opts.json) {
        process.stdout.write(JSON.stringify({ claims }, null, 2) + "\n");
        return;
      }
      if (claims.length === 0) {
        process.stdout.write(pc.dim("No active claims.\n"));
        return;
      }
      process.stdout.write(pc.bold("\n  Active claims:\n\n"));
      for (const c of claims) {
        process.stdout.write(`    ${claimLabel(c)}   ${pc.dim(c.actor)}` + (c.viaQueue ? pc.dim("  (granted from queue)") : "") + "\n");
      }
      process.stdout.write("\n");
      return;
    }

    if (!ctx.actorId) fail("no active actor. Set QUILT_ACTOR=<id> (or run `quilt start --actor <id>`).");
    if (opts.wait !== undefined && opts.queue) fail("--wait and --queue are opposite strategies; pick one (block, or register and keep working).");
    // Validate --wait EAGERLY, not just when a target turns out to be held.
    // `--wait <seconds>` is an optional-value flag, so `claim a.ts --wait b.ts`
    // parses b.ts as the wait value — without this check the claim on b.ts is
    // silently swallowed and the command exits 0 having claimed only a.ts.
    const waitSec = typeof opts.wait === "string" ? Number(opts.wait) : opts.wait === true ? 600 : undefined;
    if (opts.wait !== undefined && (!Number.isFinite(waitSec!) || waitSec! <= 0)) {
      fail(
        `invalid --wait value "${opts.wait}" — expected seconds. ` +
          `If "${opts.wait}" was meant as a path, put --wait AFTER the paths or pass --wait=<seconds>.`,
      );
    }
    // Retrying a claim is a natural check-back for a queued grant — surface it
    // here too, so an agent that re-claims (instead of running status) still
    // learns it was auto-granted off the queue.
    if (!opts.json) surfaceGrants(store, ctx.actorId);
    let results = acquireClaims(
      store,
      ctx.actorId!,
      ctx.session?.id ?? null,
      paths,
      Date.now(),
      opts.intent,
      { creating: opts.creating, queue: opts.queue },
    );
    let waitNote = "";
    let waited: { waitedMs: number; timedOut: boolean } | undefined;
    const heldNow = results.filter((r) => !r.granted && r.holder);
    const fatalNow = results.some((r) => !r.granted && !r.holder);
    if (opts.wait !== undefined && heldNow.length > 0 && !fatalNow) {
      // The blocking-wait primitive: instead of the agent blind-polling, hold
      // here and return the moment the holders release (commit auto-release
      // included) or the window elapses. (waitSec validated eagerly above.)
      if (!opts.json) {
        for (const r of heldNow) {
          const t = r.dir ? r.path + "/" : r.symbol ? `${r.path}#${r.symbol}` : r.path;
          process.stdout.write(
            pc.yellow("  … waiting ") + `${t} ${pc.dim(`(held by ${r.holder}`)}` +
              pc.dim(r.holderIntent ? ` — ${r.holderIntent})` : ")") + "\n",
          );
        }
      }
      const outcome = await acquireClaimsWait(
        store,
        ctx.actorId!,
        ctx.session?.id ?? null,
        paths,
        opts.intent,
        { creating: opts.creating, waitMs: waitSec! * 1000 },
      );
      results = outcome.results;
      waited = { waitedMs: outcome.waitedMs, timedOut: outcome.timedOut };
      waitNote = outcome.timedOut
        ? `gave up after ${Math.round(outcome.waitedMs / 1000)}s — still held`
        : outcome.waitedMs > 500
          ? `freed up after ${Math.round(outcome.waitedMs / 1000)}s`
          : "";
    }
    // Push-awareness: warn if anything just claimed depends on a symbol another
    // actor is currently changing, so the actor learns at reservation time.
    const warnings = dependencyWarnings(store, ctx.actorId!, Date.now());
    if (opts.json) {
      // Wait outcome rides in JSON too — a script must be able to tell a
      // timeout (still held, retryable) from an instant denial. Same shape the
      // MCP surface returns.
      process.stdout.write(
        JSON.stringify(
          { results, warnings, ...(waited ? { waitedMs: waited.waitedMs, timedOut: waited.timedOut } : {}) },
          null,
          2,
        ) + "\n",
      );
    } else {
      if (waitNote) process.stdout.write(pc.dim(`  (${waitNote})\n`));
      for (const r of results) {
        const target = r.dir ? r.path + "/" : r.symbol ? `${r.path}#${r.symbol}` : r.path;
        if (r.granted) {
          process.stdout.write(pc.green("  ✓ claimed ") + target + "\n");
        } else if (r.queued) {
          // Async: registered, not blocked. The agent moves on and the grant
          // lands at its next quilt call.
          const ahead = (r.queuePosition ?? 1) - 1;
          process.stdout.write(
            pc.cyan("  … queued  ") + target +
              pc.dim(` (held by ${r.holder}` + (r.holderIntent ? ` — ${r.holderIntent}` : "") + ")") + "\n",
          );
          process.stdout.write(
            pc.dim(
              `      ${ahead === 0 ? "you're next" : `${ahead} ahead of you`}; ` +
                "auto-granted when it frees — keep working, then re-check with quilt status\n",
            ),
          );
        } else {
          const why =
            r.reason === "outside-repo"
              ? "outside the repository"
              : r.reason === "symbol-not-found"
                ? `no symbol "${r.symbol}" in ${r.path}` +
                  (r.suggestion ? ` — did you mean "${r.suggestion}"?` : "") +
                  ` (a claim that binds nothing protects nothing — claim the whole file, or pass --creating if you are about to add it)`
                : r.reason === "symbols-unsupported"
                  ? `symbols aren't parsed for this file type — claim the whole file: quilt claim ${r.path}`
                  : `held by ${r.holder}`;
          process.stdout.write(pc.red("  ✗ denied  ") + `${target} ${pc.dim(`(${why})`)}\n`);
          // Hand the blocked actor the holder's intent so it can resolve the
          // collision instead of just waiting.
          if (r.holderIntent) {
            process.stdout.write(pc.dim(`      ${r.holder} is: ${r.holderIntent}\n`));
          }
          if (r.holderExpiresAt) {
            process.stdout.write(
              pc.dim(`      their claim lapses ${new Date(r.holderExpiresAt).toISOString()} unless renewed\n`),
            );
          }
          if (!opts.queue) {
            process.stdout.write(
              pc.dim("      tip: --queue to be auto-granted when it frees, or --wait to block\n"),
            );
          }
        }
      }
      for (const w of warnings) {
        process.stdout.write(pc.yellow("  ⚠ heads-up ") + formatWarning(w) + "\n");
      }
    }
    // A queued target is a SUCCESS (registered — keep working), not a denial.
    if (results.some((r) => !r.granted && !r.queued)) process.exitCode = 1;
  });

program
  .command("release")
  .description("Release your claims (with no paths, releases all of yours)")
  .argument("[paths...]", "files to release")
  .action((paths: string[]) => {
    const store = requireStore();
    const ctx = activeContext(store);
    if (!ctx.actorId) fail("no active actor. Set QUILT_ACTOR=<id> (or run `quilt start --actor <id>`).");
    const r = releaseClaims(
      store,
      ctx.actorId!,
      paths && paths.length > 0 ? paths : null,
    );
    let line = `Released ${r.released} claim${r.released === 1 ? "" : "s"}.`;
    if (r.expired > 0) line += ` (${r.expired} had already expired.)`;
    if (r.released === 0 && r.expired === 0) {
      line += pc.dim(" Nothing was held — note that commit --mine auto-releases the committed files' claims.");
    }
    process.stdout.write(pc.green("✓ ") + line + "\n");
  });

program
  .command("escalate")
  .description("Flag a collision you can't reconcile for a human — shows under 'Needs you'")
  .argument("<target>", "the clash, e.g. pool.js#maxConnections")
  .option("--reason <text>", "why it needs a human (e.g. the opposed intents)")
  .action((target: string, opts: { reason?: string }) => {
    const store = requireStore();
    const ctx = activeContext(store);
    const actor = ctx.actorId ?? "unknown";
    const o = recordOutcome(store, "escalated", actor, target, opts.reason, nowIso());
    store.appendLedger({ ts: o.ts, type: "collision.escalated", target: o.target, actorId: actor });
    process.stdout.write(
      pc.yellow("⚑ ") + `escalated ${pc.bold(o.target)} for review` +
        (o.note ? pc.dim(` — ${o.note}`) : "") + "\n",
    );
  });

program
  .command("resolve")
  .description("Mark a collision as sewn/handled — closes its 'Needs you' flag and records the trail")
  .argument("<target>", "the clash that was resolved, e.g. pool.js#maxConnections")
  .option("--note <text>", "what was done to reconcile it")
  .action((target: string, opts: { note?: string }) => {
    const store = requireStore();
    const ctx = activeContext(store);
    const actor = ctx.actorId ?? "unknown";
    const o = recordOutcome(store, "resolved", actor, target, opts.note, nowIso());
    store.appendLedger({ ts: o.ts, type: "collision.resolved", target: o.target, actorId: actor });
    process.stdout.write(
      pc.green("✓ ") + `resolved ${pc.bold(o.target)}` +
        (o.note ? pc.dim(` — ${o.note}`) : "") + "\n",
    );
  });

program
  .command("doctor")
  .description("Check Quilt's health here: wiring, identity, and whether capture is actually flowing")
  .option("--json", "output the report as JSON")
  .action(async (opts: { json?: boolean }) => {
    // Not requireStore: doctor should run pre-init and REPORT that, not error.
    const store = new Store(findRepo());
    // The async probes run up front, results handed to the sync diagnose:
    // the daily staleness check (fail-silent) and — when the server is wired
    // and the store initialized — a real initialize/tools-list handshake
    // against the exact command .mcp.json wires.
    const latest = await latestVersionOrNull();
    let mcpProbe: McpProbeResult | undefined;
    const wiring = detect(store.paths.repoRoot);
    if (store.initialized && wiring.quiltWired) {
      mcpProbe = await probeMcpServer({
        command: wiredMcpCommand(wiring.mcpJsonPath),
        cwd: store.paths.repoRoot,
      });
    }
    const report = diagnose(store, { actorEnv: process.env.QUILT_ACTOR, latest, mcpProbe });
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }
    const glyph = (s: Check["status"]) =>
      s === "ok" ? pc.green("✓") : s === "warn" ? pc.yellow("!") : s === "fail" ? pc.red("✗") : pc.dim("·");
    process.stdout.write(pc.bold("quilt doctor") + "\n\n");
    for (const c of report.checks) {
      process.stdout.write(`  ${glyph(c.status)} ${pc.bold(c.label)}  ${c.detail}\n`);
      if (c.hint) process.stdout.write(`      ${pc.dim("→ " + c.hint)}\n`);
    }
    const verdict =
      report.verdict === "healthy"
        ? pc.green("healthy")
        : report.verdict === "warnings"
          ? pc.yellow("wired, with warnings")
          : pc.red("not ready — see the checks above");
    process.stdout.write("\n" + pc.dim("Verdict: ") + verdict + "\n");
    // Non-zero on not-ready so `quilt doctor` is usable as a CI/scripting gate.
    // Warnings stay 0 (advisory), matching the convention of linters.
    if (report.verdict === "not-ready") process.exitCode = 1;
  });

program
  .command("update")
  .description("Update Quilt to the latest published version (prints the exact command when the installer can't be detected)")
  .option("--check", "only report the standing; don't run anything")
  .action(async (opts: { check?: boolean }) => {
    // Explicit command: always ask the registry fresh (no daily cache), with a
    // more generous timeout than the background nudge.
    const latest = await checkLatestVersion({ ttlMs: 0, timeoutMs: 8000 });
    if (!latest) {
      process.stdout.write(
        pc.yellow("⚠ ") + "couldn't reach the npm registry to check the latest version.\n" +
          pc.dim(`  When you're online: ${NPM_UPDATE_COMMAND}\n`),
      );
      process.exitCode = 1;
      return;
    }
    if (compareVersions(VERSION, latest) >= 0) {
      process.stdout.write(pc.green("✓ ") + `quilt ${VERSION} is up to date (latest is ${latest}).\n`);
      return;
    }
    const critical = versionStanding(VERSION, latest) === "critical";
    process.stdout.write(
      `quilt ${VERSION} → ${latest} available.` +
        (critical ? pc.red(` This build is critically stale: ${MIN_SAFE_REASON}.`) : "") +
        "\n",
    );
    const mgr = detectInstallManager();
    if (opts.check) {
      process.stdout.write(pc.dim(`  Update: ${mgr?.command ?? NPM_UPDATE_COMMAND}\n`));
      process.exitCode = 1; // scriptable: non-zero means "behind"
      return;
    }
    if (!mgr || !mgr.runnable) {
      // Can't confidently tell how this install landed — print, don't guess.
      // A git-mutating tool must never rewrite its own binary on a guess.
      process.stdout.write(
        "Couldn't confidently detect how Quilt was installed, so nothing was run.\n" +
          "Update with the command for your installer:\n" +
          pc.dim(`  npm:  ${NPM_UPDATE_COMMAND}\n`) +
          pc.dim("  pnpm: pnpm add -g @quilt-dev/cli@latest\n") +
          pc.dim("  bun:  bun add -g @quilt-dev/cli@latest\n"),
      );
      return;
    }
    const argv = mgr.command.split(" ");
    process.stdout.write(pc.dim(`  detected a ${mgr.name} install — running: `) + mgr.command + "\n\n");
    const res = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" });
    if (res.status === 0) {
      process.stdout.write("\n" + pc.green("✓ ") + `updated to ${latest}. Verify with: quilt --version\n`);
    } else {
      process.stdout.write(
        "\n" + pc.yellow("⚠ ") + `the update command exited ${res.status ?? "on a signal"} — run it yourself:\n` +
          `  ${mgr.command}\n`,
      );
      process.exitCode = 1;
    }
  });

program
  .command("mcp")
  .description("Run the Quilt MCP server (stdio) for agent integration")
  .action(async () => {
    const store = requireStore();
    // Hand stdout to the MCP transport: drop the exit-on-EPIPE handler so a
    // transient pipe error can't silently kill the server, and swallow stdout
    // errors instead. Tradeoff: a truly broken stdout would stall sends rather
    // than crash — acceptable, since normal disconnect arrives as stdin EOF,
    // which the SDK transport uses to shut the server down cleanly.
    process.stdout.removeListener("error", epipeExit);
    process.stdout.on("error", () => {});
    await runMcpServer(store);
  });

/** Deepest EXISTING ancestor of a path (a Write may create new directories). */
function nearestExistingDir(abs: string): string {
  let dir = abs;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
  return dir;
}

// The Quilt store governing a hook payload's FILE, or null when the file isn't
// in an initialized repo. Resolved from the file path, NOT process.cwd():
// sessions routinely start in a workspace root ABOVE the repo(s) — the first
// external user's exact layout — and Claude Code runs hooks with cwd at that
// root, where cwd-based resolution finds no repo and capture silently no-ops
// while the edit lands in a child repo. The file knows where it lives; cwd
// only knows where the session started. Falls back to cwd when the payload
// carries no path. Fail-open as always: any problem → no-op.
function hookStoreFor(filePath: string | null): Store | null {
  try {
    const base = filePath
      ? nearestExistingDir(dirname(resolve(process.cwd(), filePath)))
      : process.cwd();
    const root = repoRoot(base);
    if (!root) return null;
    const store = new Store(root);
    return store.initialized ? store : null;
  } catch {
    return null;
  }
}

program
  .command("hook-pre")
  .description("PreToolUse hook: snapshot + prevention for native Edit/Write/MultiEdit (reads JSON on stdin)")
  .action(async () => {
    // Fail-open: a hook must never block or crash an agent's edit on our account.
    try {
      const input = parseHookInput(JSON.parse(await readStdin()));
      const store = input && hookStoreFor(input.path);
      const actor = store && input && hookActor(store, input);
      if (store && input && actor) {
        const decision = runHookPre(store, actor.id, input, actor.auto);
        if (decision.deny) {
          // Claude Code's PreToolUse deny format: this JSON on stdout (exit 0)
          // blocks the tool call and shows `permissionDecisionReason` to the
          // agent. Allowing is the default — emit nothing.
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: decision.reason,
              },
            }) + "\n",
          );
        }
      }
    } catch {
      /* fail-open: allow the edit */
    }
    process.exit(0);
  });

program
  .command("hook-post")
  .description("PostToolUse hook: capture authorship of a native Edit/Write/MultiEdit (reads JSON on stdin)")
  .action(async () => {
    try {
      const input = parseHookInput(JSON.parse(await readStdin()));
      const store = input && hookStoreFor(input.path);
      const actor = store && input && hookActor(store, input);
      if (store && input && actor) runHookPost(store, actor.id, input, actor.auto);
    } catch {
      /* fail-open: skip capture */
    }
    process.exit(0);
  });

program
  .command("whoami")
  .description("Show the active actor and session")
  .action(() => {
    const store = requireStore();
    const ctx = activeContext(store);
    if (!ctx.actorId) {
      process.stdout.write(pc.dim("No active actor. Set QUILT_ACTOR=<id> (or run `quilt start --actor <id>`).\n"));
      return;
    }
    process.stdout.write(
      `${pc.bold(ctx.actorId)}` +
        (ctx.actor ? ` (${ctx.actor.type})` : "") +
        (ctx.session ? pc.dim(`  session ${ctx.session.id}`) : "") +
        "\n",
    );
  });

program
  .command("end")
  .description("End the active session")
  .action(() => {
    const store = requireStore();
    const ctx = activeContext(store);
    if (!ctx.session) {
      process.stdout.write(pc.dim("No active session.\n"));
      return;
    }
    const session = { ...ctx.session, status: "ended" as const, endedAt: nowIso() };
    store.writeSession(session);
    // Drop the active-session pointer so the next command doesn't resolve a
    // stale, already-ended session as the active actor.
    if (store.readCurrentSessionId() === session.id) store.clearCurrentSessionId();
    store.appendLedger({
      ts: nowIso(),
      type: "session.ended",
      actorId: session.actorId,
      sessionId: session.id,
    });
    process.stdout.write(pc.green("✓ ") + `Ended session ${session.id}.\n`);
  });

// Load the tree-sitter grammars once up front (best-effort, ~20ms) so the
// synchronous parseSymbols() used inside reconcile has them ready. If init
// fails, symbol parsing degrades to whole-file claims rather than crashing.
initSymbols()
  .then(() => program.parseAsync(process.argv))
  .catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  });
