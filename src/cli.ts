#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
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
import { acquireClaims, releaseClaims, listClaims, claimLabel } from "./claims.js";
import { runMcpServer } from "./mcp.js";
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

function findRepo(): string {
  const root = repoRoot(process.cwd());
  if (!root) fail("not inside a git repository. Run this from a git working tree.");
  return root;
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

/** Print active advisory claims below a status view. */
function printClaims(store: Store): void {
  const claims = listClaims(store, Date.now());
  if (claims.length === 0) return;
  process.stdout.write(pc.dim(pc.bold("  Claimed (reserved for editing):\n")));
  for (const c of claims) {
    process.stdout.write(`    ${claimLabel(c)}   ${pc.dim(c.actor)}\n`);
  }
  process.stdout.write("\n");
}

/** Print any preserved (clobbered) work below a status view. */
function printClobbers(store: Store): void {
  const open = store.readClobbers().clobbers.filter((c) => !c.restored);
  if (open.length === 0) return;
  process.stdout.write(pc.red(pc.bold("  Collisions caught (work preserved):\n")));
  for (const c of open) {
    process.stdout.write(
      `    ${c.path}   ${pc.dim(`${c.byActor} overwrote ${c.victimActor}`)}\n`,
    );
  }
  process.stdout.write(pc.dim("    recover with: quilt restore <path>\n\n"));
}

const program = new Command();
program
  .name("quilt")
  .description("Actor-owned patches for Git. Same repo. Many agents. Clean commits.")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize Quilt in this repository")
  .action(() => {
    const root = findRepo();
    const store = new Store(root);
    if (store.initialized) {
      process.stdout.write(pc.dim("Quilt already initialized at .quilt/\n"));
      return;
    }
    store.ensureDirs();
    const config: Config = { version: 1, createdAt: nowIso() };
    store.writeConfig(config);
    store.writeObserved({ files: {} });
    store.writeOwnership({ files: {}, conflicts: {} });
    store.appendLedger({ ts: nowIso(), type: "repo.initialized", repoRoot: root });
    process.stdout.write(
      pc.green("✓ ") + "Quilt initialized.\n" +
        pc.dim("  Next: quilt start --actor <id> --type agent\n"),
    );
  });

program
  .command("start")
  .description("Start a session for an actor in this checkout")
  .requiredOption("--actor <id>", "actor id, e.g. wilson/codex-auth")
  .option("--type <type>", "actor type: human | agent | bot", "human")
  .option("--name <displayName>", "human-readable display name")
  .option("--email <email>", "email used as the git author for this actor")
  .action((opts) => {
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
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { ...statusJson(model, headSha(store.paths.repoRoot)), dependencyWarnings: warnings },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    process.stdout.write(renderStatus(model, shortHead(store.paths.repoRoot)));
    if (watcherRunning(store)) {
      process.stdout.write(pc.dim("  watching: live (quilt watch)\n\n"));
    }
    printClaims(store);
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
    if (!ctx.actorId) fail("no active actor. Run `quilt start --actor <id>`.");
    reconcile(store, ctx.actorId);
    const model = buildModel(store, ctx.actorId);
    const selection = selectOwned(model, store.paths.repoRoot, store.readOwnership());
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
  .description("Show overlapping changes claimed by multiple actors")
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
  .option("--mine", "preview your owned patch (default)")
  .option("--include-unclaimed", "also include hunks that touch unattributed lines")
  .option("--json", "emit the patch as JSON")
  .action((opts) => {
    const store = requireStore();
    const ctx = activeContext(store);
    if (!ctx.actorId) fail("no active actor. Run `quilt start --actor <id>`.");
    reconcile(store, ctx.actorId);
    const model = buildModel(store, ctx.actorId);
    const selection = selectOwned(model, store.paths.repoRoot, store.readOwnership(), {
      includeMixed: opts.includeUnclaimed,
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
  });

program
  .command("commit")
  .description("Commit only your owned patch")
  .option("--mine", "commit your owned hunks (required)")
  .requiredOption("-m, --message <message>", "commit message")
  .option("--dry-run", "show what would happen without committing")
  .option("--include-unclaimed", "also commit hunks that touch unattributed lines")
  .action((opts) => {
    const store = requireStore();
    if (!opts.mine) fail("commit requires --mine in V0 (only owned-patch commits are supported).");
    const ctx = activeContext(store);
    if (!ctx.actorId || !ctx.actor) {
      fail("no active actor. Run `quilt start --actor <id>` first.");
    }
    reconcile(store, ctx.actorId);
    const model = buildModel(store, ctx.actorId);
    const selection = selectOwned(model, store.paths.repoRoot, store.readOwnership(), {
      includeMixed: opts.includeUnclaimed,
    });

    if (selection.files.length === 0) {
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
      process.stdout.write(
        pc.dim(
          `  dry-run: would commit ${selection.files.length} file(s), ` +
            `+${selection.totalAdded}/-${selection.totalRemoved} as ${ctx.actor!.displayName}.\n` +
            "  (no changes were made)\n\n",
        ),
      );
      return;
    }

    const res = commitSelection(root, selection, ctx.actor!, opts.message);
    if (!res.committed) fail(res.reason ?? "commit failed");

    store.appendLedger({
      ts: nowIso(),
      type: "commit.mine",
      actorId: ctx.actorId,
      sessionId: ctx.session?.id ?? null,
      commitSha: res.commitSha,
      files: selection.files.map((f) => f.path),
    });
    // Re-observe so the freshly committed lines drop out of ownership.
    reconcile(store, ctx.actorId);

    process.stdout.write(
      pc.green("✓ ") +
        `Committed ${selection.files.length} file(s) as ${pc.bold(ctx.actor!.displayName)} ` +
        `(${res.commitSha!.slice(0, 7)}).\n` +
        pc.dim("  Other actors' changes remain in the working tree.\n"),
    );
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
  .action((paths: string[], opts: { json?: boolean }) => {
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
        process.stdout.write(`    ${claimLabel(c)}   ${pc.dim(c.actor)}\n`);
      }
      process.stdout.write("\n");
      return;
    }

    if (!ctx.actorId) fail("no active actor. Run `quilt start --actor <id>` first.");
    const results = acquireClaims(
      store,
      ctx.actorId!,
      ctx.session?.id ?? null,
      paths,
      Date.now(),
    );
    // Push-awareness: warn if anything just claimed depends on a symbol another
    // actor is currently changing, so the actor learns at reservation time.
    const warnings = dependencyWarnings(store, ctx.actorId!, Date.now());
    if (opts.json) {
      process.stdout.write(JSON.stringify({ results, warnings }, null, 2) + "\n");
    } else {
      for (const r of results) {
        const target = r.symbol ? `${r.path}#${r.symbol}` : r.path;
        if (r.granted) {
          process.stdout.write(pc.green("  ✓ claimed ") + target + "\n");
        } else {
          const why =
            r.reason === "outside-repo" ? "outside the repository" : `held by ${r.holder}`;
          process.stdout.write(pc.red("  ✗ denied  ") + `${target} ${pc.dim(`(${why})`)}\n`);
        }
      }
      for (const w of warnings) {
        process.stdout.write(pc.yellow("  ⚠ heads-up ") + formatWarning(w) + "\n");
      }
    }
    if (results.some((r) => !r.granted)) process.exitCode = 1;
  });

program
  .command("release")
  .description("Release your claims (with no paths, releases all of yours)")
  .argument("[paths...]", "files to release")
  .action((paths: string[]) => {
    const store = requireStore();
    const ctx = activeContext(store);
    if (!ctx.actorId) fail("no active actor. Run `quilt start --actor <id>` first.");
    const n = releaseClaims(
      store,
      ctx.actorId!,
      paths && paths.length > 0 ? paths : null,
    );
    process.stdout.write(pc.green("✓ ") + `Released ${n} claim${n === 1 ? "" : "s"}.\n`);
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

program
  .command("whoami")
  .description("Show the active actor and session")
  .action(() => {
    const store = requireStore();
    const ctx = activeContext(store);
    if (!ctx.actorId) {
      process.stdout.write(pc.dim("No active actor. Run `quilt start --actor <id>`.\n"));
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
