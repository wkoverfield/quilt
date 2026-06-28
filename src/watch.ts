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

  let lastClobbers = store.readClobbers().clobbers.length;
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
  const tick = () => {
    timer = null;
    const actorId = activeContext(store).actorId;
    reconcile(store, actorId);
    const clobbers = store.readClobbers().clobbers;
    if (clobbers.length > lastClobbers) {
      for (const c of clobbers.slice(lastClobbers)) {
        process.stdout.write(
          pc.red("  ⚠ collision  ") +
            `${pc.bold(c.byActor)} overwrote ${pc.bold(c.victimActor)}'s edits in ${c.path} — ` +
            pc.dim(`both saved · quilt restore ${c.path}\n`),
        );
      }
      lastClobbers = clobbers.length;
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, 150);
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
