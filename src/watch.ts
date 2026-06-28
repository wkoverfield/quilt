import { existsSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import pc from "picocolors";
import type { Store } from "./state.js";
import { reconcile } from "./engine.js";
import { activeContext } from "./session.js";

const IGNORE_EXACT = new Set([".git", ".quilt", "node_modules", "dist"]);
const IGNORE_PREFIXES = [".git/", ".quilt/", "node_modules/", "dist/"];

function ignored(rel: string): boolean {
  if (!rel) return true;
  if (IGNORE_EXACT.has(rel)) return true;
  return IGNORE_PREFIXES.some((p) => rel.startsWith(p));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True if a live `quilt watch` process is recorded for this repo. */
export function watcherRunning(store: Store): number | null {
  if (!existsSync(store.paths.watcherPid)) return null;
  const pid = Number.parseInt(
    readFileSync(store.paths.watcherPid, "utf8").trim(),
    10,
  );
  return Number.isInteger(pid) && isAlive(pid) ? pid : null;
}

/**
 * Run the watcher: attribute working-tree edits to the active actor live (no
 * need to run `quilt status` to claim) and surface clobbers as they happen.
 * Blocks until interrupted.
 */
export function runWatch(store: Store): void {
  const root = store.paths.repoRoot;

  const existing = watcherRunning(store);
  if (existing) {
    process.stderr.write(
      pc.red("error: ") + `a quilt watcher is already running (pid ${existing})\n`,
    );
    process.exit(1);
  }

  writeFileSync(store.paths.watcherPid, String(process.pid));
  const cleanup = () => rmSync(store.paths.watcherPid, { force: true });
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.stdout.write("\n" + pc.dim("quilt watch stopped.\n"));
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  // Track clobbers we've already announced by id (robust to clobbers.json being
  // rewritten by `quilt restore`); seed with the ones that already exist.
  const printed = new Set<string>();
  for (const c of store.readClobbers().clobbers) printed.add(c.id);
  const ctx = activeContext(store);
  process.stdout.write(
    pc.green("✓ ") + "quilt watching " + pc.bold(root) + "\n",
  );
  process.stdout.write(
    pc.dim(
      `  active actor: ${ctx.actorId ?? "(none — run quilt start)"}\n` +
        "  edits are attributed live; collisions are caught and preserved. Ctrl-C to stop.\n\n",
    ),
  );

  let timer: NodeJS.Timeout | null = null;
  let firstScheduled = 0;
  const DEBOUNCE_MS = 150;
  const MAX_DEBOUNCE_MS = 2000;

  const tick = () => {
    timer = null;
    firstScheduled = 0;
    try {
      const actorId = activeContext(store).actorId;
      // Without an active actor there's nobody to attribute edits to. Do NOT
      // reconcile — that would advance the observed snapshot past unattributed
      // work and make it impossible to claim later.
      if (!actorId) return;
      reconcile(store, actorId);
      for (const c of store.readClobbers().clobbers) {
        if (printed.has(c.id)) continue;
        printed.add(c.id);
        process.stdout.write(
          pc.red("  ⚠ collision  ") +
            `${pc.bold(c.byActor)} overwrote ${pc.bold(c.victimActor)}'s edits in ${c.path} — ` +
            pc.dim(`both saved · quilt restore ${c.path}\n`),
        );
      }
    } catch (err) {
      process.stderr.write(
        pc.red("  watch error: ") + (err as Error).message + "\n",
      );
    }
  };

  // Debounce bursts of writes, but cap the total wait so a long run of ignored
  // churn (e.g. git rewriting many files) can't starve attribution forever.
  const schedule = () => {
    const now = Date.now();
    if (!firstScheduled) firstScheduled = now;
    if (timer) clearTimeout(timer);
    if (now - firstScheduled >= MAX_DEBOUNCE_MS) {
      tick();
      return;
    }
    timer = setTimeout(tick, DEBOUNCE_MS);
  };

  try {
    watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (ignored(filename.toString())) return;
      schedule();
    });
  } catch (err) {
    cleanup();
    process.stderr.write(
      pc.red("error: ") +
        `could not watch ${root}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
}
