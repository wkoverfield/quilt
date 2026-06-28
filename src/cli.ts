#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import pc from "picocolors";
import { Store } from "./state.js";
import { repoRoot, shortHead, headSha } from "./git.js";
import { activeContext } from "./session.js";
import { reconcile, buildModel } from "./engine.js";
import { selectOwned, commitSelection } from "./commit.js";
import { renderStatus, renderPreview } from "./render.js";
import { statusJson, mineJson, conflictsJson } from "./json.js";
import type { Actor, ActorType, Config, Session } from "./types.js";

// Exit quietly when output is piped into a process that closes early
// (e.g. `quilt preview | head`) instead of crashing with EPIPE.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

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

const program = new Command();
program
  .name("quilt")
  .description("Actor-owned patches for Git. Same repo. Many agents. Clean commits.")
  .version("0.0.1");

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
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(statusJson(model, headSha(store.paths.repoRoot)), null, 2) + "\n",
      );
      return;
    }
    process.stdout.write(renderStatus(model, shortHead(store.paths.repoRoot)));
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
    const selection = selectOwned(model, store.paths.repoRoot);
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
    const selection = selectOwned(model, store.paths.repoRoot, {
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
    const selection = selectOwned(model, store.paths.repoRoot, {
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

program.parseAsync(process.argv).catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
