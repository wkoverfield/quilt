// Async claims (`--queue`): register interest, keep working, get auto-granted
// when the holder frees the target — the non-blocking sibling of `--wait`.
// The fleet's #2 ask ("a blocked shell is a blocked agent"). Drives the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-queue-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.io"]);
  g(["config", "user.name", "t"]);
  g(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "shared.js"), "export const f = () => 1;\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  spawnSync("node", [CLI, "init"], { cwd: dir });
  return dir;
}
function q(dir: string, args: string[], actor: string) {
  const r = spawnSync("node", [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, QUILT_ACTOR: actor, NO_COLOR: "1" },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("--queue registers on denial, does NOT block, exits 0 (registration is success)", () => {
  const dir = makeRepo();
  try {
    q(dir, ["claim", "shared.js", "--intent", "holding"], "A");
    const r = q(dir, ["claim", "shared.js", "--queue", "--intent", "next"], "B");
    assert.equal(r.status, 0, "queued is success, not a denial exit");
    assert.match(r.stdout, /queued\s+shared\.js/);
    assert.match(r.stdout, /you're next/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a queued waiter is auto-granted when the holder COMMITS, surfaced once in status", () => {
  const dir = makeRepo();
  try {
    q(dir, ["claim", "shared.js", "--intent", "A work"], "A");
    q(dir, ["claim", "shared.js", "--queue", "--intent", "B work"], "B");
    // A edits + commits, which auto-releases its claim.
    writeFileSync(join(dir, "shared.js"), "export const f = () => 2;\n");
    q(dir, ["status"], "A"); // reconcile captures A's edit for its own commit
    assert.equal(q(dir, ["commit", "--mine", "-m", "A"], "A").status, 0);

    // B's next status surfaces the auto-grant.
    const s1 = q(dir, ["status"], "B");
    assert.match(s1.stdout, /Granted while you waited/);
    assert.match(s1.stdout, /shared\.js/);
    // And it shouts exactly once — the second status does not repeat it.
    const s2 = q(dir, ["status"], "B");
    assert.doesNotMatch(s2.stdout, /Granted while you waited/);
    // B actually holds it now.
    assert.match(q(dir, ["claim"], "B").stdout, /shared\.js.*B/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a queued waiter is auto-granted on an explicit release", () => {
  const dir = makeRepo();
  try {
    q(dir, ["claim", "shared.js"], "A");
    q(dir, ["claim", "shared.js", "--queue"], "B");
    q(dir, ["release", "shared.js"], "A");
    const s = q(dir, ["status"], "B");
    assert.match(s.stdout, /Granted while you waited/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a queued waiter is auto-granted when the holder's lease lapses (dead holder)", () => {
  const dir = makeRepo();
  try {
    q(dir, ["claim", "shared.js"], "A");
    q(dir, ["claim", "shared.js", "--queue"], "B");
    // Expire A's lease — a crashed holder.
    const cp = join(dir, ".quilt", "claims.json");
    const file = JSON.parse(readFileSync(cp, "utf8"));
    file.claims.find((c: any) => c.actor === "A").expiresAt = Date.now() - 1;
    writeFileSync(cp, JSON.stringify(file));
    // Any of B's calls reconciles, which promotes the waiter off the lapsed lease.
    const s = q(dir, ["status"], "B");
    assert.match(s.stdout, /Granted while you waited/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FIFO: the earliest waiter is granted first; the later one stays queued", () => {
  const dir = makeRepo();
  try {
    q(dir, ["claim", "shared.js"], "A");
    q(dir, ["claim", "shared.js", "--queue", "--intent", "B first"], "B");
    q(dir, ["claim", "shared.js", "--queue", "--intent", "C second"], "C");
    // C should be told it's behind B.
    const cAgain = q(dir, ["claim", "shared.js", "--queue"], "C");
    assert.match(cAgain.stdout, /1 ahead of you/);

    q(dir, ["release", "shared.js"], "A");
    // B gets it; C does not (B now holds it).
    assert.match(q(dir, ["status"], "B").stdout, /Granted while you waited/);
    assert.doesNotMatch(q(dir, ["status"], "C").stdout, /Granted while you waited/);
    // When B releases, C is promoted.
    q(dir, ["release", "shared.js"], "B");
    assert.match(q(dir, ["status"], "C").stdout, /Granted while you waited/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fatal denial (missing symbol) is NOT queued, even with --queue", () => {
  const dir = makeRepo();
  try {
    const r = q(dir, ["claim", "shared.js#noSuchFn", "--queue"], "B");
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /no symbol "noSuchFn"/);
    assert.doesNotMatch(r.stdout, /queued/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--wait and --queue are mutually exclusive", () => {
  const dir = makeRepo();
  try {
    const r = q(dir, ["claim", "shared.js", "--wait", "--queue"], "B");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /opposite strategies|pick one/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queuePosition counts a whole-file waiter ahead of a later symbol waiter (mixed granularity)", () => {
  const dir = makeRepo();
  try {
    // holder H takes the whole file so both A and B are denied and queue.
    q(dir, ["claim", "shared.js"], "H");
    // A queues for the WHOLE file first.
    q(dir, ["claim", "shared.js", "--queue", "--intent", "A whole"], "A");
    // B then queues for a SYMBOL in the same file — A's whole-file interest
    // conflicts with B's symbol, so B must be told it's behind A, not "next".
    const b = q(dir, ["claim", "shared.js#f", "--queue", "--intent", "B sym"], "B");
    assert.match(b.stdout, /1 ahead of you/, "the whole-file waiter ahead is counted");
    assert.doesNotMatch(b.stdout, /you're next/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
