import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "dist", "cli.js");

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-watch-"));
  const g = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "test@quilt.local"]);
  g(["config", "user.name", "Quilt Test"]);
  g(["config", "commit.gpgsign", "false"]);
  return dir;
}
function commitAll(dir: string, msg: string): void {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", msg], { cwd: dir, encoding: "utf8" });
}
function quilt(dir: string, args: string[], actor?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (actor) env.QUILT_ACTOR = actor;
  const res = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
function write(dir: string, rel: string, content: string): void {
  writeFileSync(join(dir, rel), content);
}
function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), "utf8");
}
function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("clobber is detected and restore recovers the overwritten version", () => {
  const dir = makeRepo();
  try {
    write(dir, "f.txt", "l1\nl2\nl3\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);

    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    write(dir, "f.txt", "l1\nl2-alice\nl3\n");
    quilt(dir, ["status"], "alice");

    quilt(dir, ["start", "--actor", "bob", "--type", "agent"]);
    write(dir, "f.txt", "l1\nl2-bob\nl3\n"); // bob overwrites alice's line
    quilt(dir, ["status"], "bob");

    const list = JSON.parse(quilt(dir, ["restore", "--json"]).stdout);
    assert.equal(list.clobbers.length, 1, "one clobber recorded");
    assert.equal(list.clobbers[0].victimActor, "alice");
    assert.equal(list.clobbers[0].byActor, "bob");

    const r = quilt(dir, ["restore", "f.txt"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(dir, "f.txt.quilt-alice"), "l1\nl2-alice\nl3\n", "victim version recovered");
    assert.equal(read(dir, "f.txt"), "l1\nl2-bob\nl3\n", "current file untouched");

    // Restored clobbers drop off the open list.
    const after = JSON.parse(quilt(dir, ["restore", "--json"]).stdout);
    assert.equal(after.clobbers.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("a same-actor edit is not a clobber", () => {
  const dir = makeRepo();
  try {
    write(dir, "f.txt", "l1\nl2\nl3\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);
    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    write(dir, "f.txt", "l1\nl2-alice\nl3\n");
    quilt(dir, ["status"], "alice");
    write(dir, "f.txt", "l1\nl2-alice-v2\nl3\n"); // alice refines her own line
    quilt(dir, ["status"], "alice");
    const list = JSON.parse(quilt(dir, ["restore", "--json"]).stdout);
    assert.equal(list.clobbers.length, 0, "refining your own edit is not a clobber");
  } finally {
    cleanup(dir);
  }
});

test("quilt watch attributes a live edit to the active actor without a manual status", async () => {
  const dir = makeRepo();
  let watcher: ReturnType<typeof spawn> | undefined;
  try {
    write(dir, "seed.txt", "x\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);
    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);

    watcher = spawn("node", [CLI, "watch"], {
      cwd: dir,
      env: { ...process.env, QUILT_ACTOR: "alice" },
      stdio: "ignore",
    });
    await sleep(600); // let the watcher boot and register its pidfile
    assert.ok(existsSync(join(dir, ".quilt", "watcher.pid")), "watcher pidfile written");

    // Edit WITHOUT running any quilt command — the watcher should attribute it.
    write(dir, "live.txt", "alice-live-edit\n");

    let owned = false;
    for (let i = 0; i < 30 && !owned; i++) {
      await sleep(150);
      const own = JSON.parse(read(dir, join(".quilt", "ownership.json")));
      owned = own.files?.["live.txt"]?.added?.["alice-live-edit"] === "alice";
    }
    assert.ok(owned, "watcher attributed the live edit to alice");
  } finally {
    if (watcher) watcher.kill("SIGTERM");
    cleanup(dir);
  }
});
