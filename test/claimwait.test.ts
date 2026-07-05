// `claim --wait`: the blocking-wait primitive. Before it, a denied agent's
// only strategy was blind polling — "get denied, guess when to retry, hope"
// (the verification fleet's #1 friction). These drive the real CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-wait-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.io"]);
  g(["config", "user.name", "t"]);
  g(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "shared.js"), "function f() { return 1; }\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  spawnSync("node", [CLI, "init"], { cwd: dir });
  return dir;
}
function quilt(dir: string, args: string[], actor: string) {
  const r = spawnSync("node", [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    // NO_COLOR: picocolors turns ANSI on when CI is set, which splinters
    // phrases like "claimed shared.js" with reset codes mid-match.
    env: { ...process.env, QUILT_ACTOR: actor, NO_COLOR: "1" },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("claim --wait blocks, then grants the moment the holder releases", async () => {
  const dir = makeRepo();
  try {
    assert.equal(quilt(dir, ["claim", "shared.js", "--intent", "holding"], "A").status, 0);

    // B waits in the background while A still holds.
    const b = spawn("node", [CLI, "claim", "shared.js", "--wait", "30", "--intent", "next"], {
      cwd: dir,
      env: { ...process.env, QUILT_ACTOR: "B", NO_COLOR: "1" },
    });
    let out = "";
    b.stdout.on("data", (d) => (out += d));
    const done = new Promise<number>((res) => b.on("exit", (c) => res(c ?? 1)));

    // Give B time to enter the wait, then A releases.
    await new Promise((r) => setTimeout(r, 1500));
    assert.match(out, /waiting/, "B reported it was waiting");
    assert.equal(quilt(dir, ["release", "shared.js"], "A").status, 0);

    const code = await done;
    assert.equal(code, 0, out);
    assert.match(out, /claimed shared\.js/, "B was granted after the release");
    assert.match(out, /freed up after/, "B reports how long it waited");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim --wait times out with the denial still explained", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["claim", "shared.js", "--intent", "long task"], "A");
    const start = Date.now();
    const r = quilt(dir, ["claim", "shared.js", "--wait", "2"], "B");
    const elapsed = Date.now() - start;
    assert.notEqual(r.status, 0, "still denied → nonzero exit");
    assert.match(r.stdout, /gave up after/);
    assert.match(r.stdout, /held by A/);
    assert.ok(elapsed >= 1800 && elapsed < 15000, `waited the window (${elapsed}ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim --wait fails FAST on a denial waiting can't fix (missing symbol)", () => {
  const dir = makeRepo();
  try {
    const start = Date.now();
    const r = quilt(dir, ["claim", "shared.js#noSuchFn", "--wait", "30"], "B");
    const elapsed = Date.now() - start;
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /no symbol "noSuchFn"/);
    assert.ok(elapsed < 5000, `returned immediately, not after the window (${elapsed}ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim --wait grants when the holder's lease lapses (dead holder costs one lease)", async () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["claim", "shared.js", "--intent", "will die"], "A");
    // Force A's lease to lapse in ~2s — a crashed holder, compressed.
    const claimsPath = join(dir, ".quilt", "claims.json");
    const file = JSON.parse(readFileSync(claimsPath, "utf8"));
    file.claims[0].expiresAt = Date.now() + 2000;
    writeFileSync(claimsPath, JSON.stringify(file));

    const start = Date.now();
    const r = quilt(dir, ["claim", "shared.js", "--wait", "30", "--intent", "takeover"], "B");
    const elapsed = Date.now() - start;
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /claimed shared\.js/);
    assert.ok(elapsed < 15000, `granted shortly after the lapse (${elapsed}ms), not the full window`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim a.ts --wait b.ts fails LOUDLY — the optional-value flag must not swallow a path", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "b.js"), "x\n");
    // Commander parses b.js as the --wait value. Before the eager validation
    // this exited 0 having claimed only shared.js — the agent believed it held
    // both files. Now it must refuse before claiming ANYTHING.
    const r = quilt(dir, ["claim", "shared.js", "--wait", "b.js"], "A");
    assert.notEqual(r.status, 0, "a swallowed path is an error, not a success");
    assert.match(r.stderr, /b\.js/, "the error names the swallowed value");
    assert.match(r.stderr, /--wait/, "the error explains which flag ate it");
    const list = quilt(dir, ["claim"], "A");
    assert.ok(!list.stdout.includes("shared.js"), "nothing was claimed — the command failed whole");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim --wait with an explicit numeric value still works (--wait 1 times out cleanly)", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["claim", "shared.js", "--intent", "holding"], "A");
    const r = quilt(dir, ["claim", "shared.js", "--wait", "1"], "B");
    assert.notEqual(r.status, 0, "still held after the window: denial");
    assert.match(r.stdout, /gave up after/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
