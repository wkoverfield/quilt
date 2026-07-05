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

test("holder-side visibility: a holder's status shows who's queued behind it", () => {
  const dir = makeRepo();
  try {
    q(dir, ["claim", "shared.js", "--intent", "A holds"], "A");
    q(dir, ["claim", "shared.js", "--queue", "--intent", "B waits"], "B");
    const s = q(dir, ["status"], "A");
    assert.match(s.stdout, /1 waiting \(B\)/, "the holder sees the waiter and is told to commit to hand off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a queued grant surfaces on a plain claim RETRY, not only via status", () => {
  const dir = makeRepo();
  try {
    q(dir, ["claim", "shared.js"], "A");
    q(dir, ["claim", "shared.js", "--queue"], "B");
    q(dir, ["release", "shared.js"], "A"); // auto-grants to B
    // B never runs `status` — it just retries the claim, and learns it's theirs.
    const r = q(dir, ["claim", "shared.js"], "B");
    assert.match(r.stdout, /Granted while you waited/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symbol claim does NOT swallow the actor's queued interest in the whole file (covers, not overlaps)", () => {
  const dir = makeRepo();
  try {
    // B holds one symbol; A holds a different one — legal concurrency.
    q(dir, ["claim", "shared.js#f", "--intent", "B's function"], "B");
    q(dir, ["claim", "shared.js#g", "--creating", "--intent", "A's function"], "A");
    // B wants the WHOLE file next; A's symbol claim blocks that, so B queues.
    const queued = q(dir, ["claim", "shared.js", "--queue", "--intent", "refactor whole file"], "B");
    assert.equal(queued.status, 0, queued.stderr);
    assert.match(queued.stdout, /queued\s+shared\.js/);
    // A releases. Promotion must GRANT B the whole file — B's own narrower
    // symbol claim overlaps the target but does not cover it, and the old
    // overlaps() check silently dropped the waiter here (auto-grant never came).
    q(dir, ["release", "shared.js#g"], "A");
    const status = q(dir, ["status"], "B");
    assert.match(status.stdout, /Granted while you waited/, "the whole-file grant arrived");
    assert.match(status.stdout, /shared\.js/);
    // And the claim list shows B holding the whole file, not just the symbol.
    const list = q(dir, ["claim"], "B");
    assert.match(list.stdout, /shared\.js\s+B/, "whole-file claim exists for B");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a walk-up claim cannot steal a lapsed lease ahead of the queue (queue outranks direct)", () => {
  const dir = makeRepo();
  try {
    q(dir, ["claim", "shared.js"], "A");
    q(dir, ["claim", "shared.js", "--queue"], "B"); // told "you're next"
    // A dies; its lease lapses with nobody reconciling in between.
    const cp = join(dir, ".quilt", "claims.json");
    const file = JSON.parse(readFileSync(cp, "utf8"));
    file.claims.find((c: any) => c.actor === "A").expiresAt = Date.now() - 1;
    writeFileSync(cp, JSON.stringify(file));
    // Newcomer C walks up and claims directly. Acquire itself prunes the lapsed
    // lease — the queue must be promoted FIRST, so B wins and C is denied.
    const c = q(dir, ["claim", "shared.js"], "C");
    assert.notEqual(c.status, 0, "the walk-up loses to the queue");
    assert.match(c.stdout, /held by B/);
    const s = q(dir, ["status"], "B");
    assert.match(s.stdout, /Granted while you waited/, "B got the grant it was promised");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a later symbol waiter is NOT promoted past an earlier still-blocked whole-file waiter", () => {
  const dir = makeRepo();
  try {
    // Two symbol holders; A queues for the WHOLE file first, then B queues for #g.
    q(dir, ["claim", "shared.js#f", "--creating"], "H1");
    q(dir, ["claim", "shared.js#g", "--creating"], "H2");
    q(dir, ["claim", "shared.js", "--queue"], "A");
    const b = q(dir, ["claim", "shared.js#g", "--queue", "--creating"], "B");
    assert.match(b.stdout, /1 ahead of you/, "B is told A is ahead");
    // H2 frees #g. A is still blocked by H1 — but A's head-of-queue interest
    // reserves the file, so B must NOT jump it.
    q(dir, ["release", "shared.js#g"], "H2");
    const sB = q(dir, ["status"], "B");
    assert.ok(!sB.stdout.includes("Granted while you waited"), "B did not jump the queue");
    // When H1 also frees, A (first in line) gets the whole file, then B waits on A.
    q(dir, ["release", "shared.js#f"], "H1");
    const sA = q(dir, ["status"], "A");
    assert.match(sA.stdout, /Granted while you waited/, "the head of the queue wins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release cancels the actor's own queued interest (no zombie auto-grant later)", () => {
  const dir = makeRepo();
  try {
    q(dir, ["claim", "shared.js"], "A");
    q(dir, ["claim", "shared.js", "--queue"], "B");
    // B changes its mind and releases the target it was queued for.
    q(dir, ["release", "shared.js"], "B");
    // A frees the file; B must NOT be silently granted a claim it walked away from.
    q(dir, ["release", "shared.js"], "A");
    const s = q(dir, ["status"], "B");
    assert.ok(!s.stdout.includes("Granted while you waited"), "no zombie grant for B");
    const list = q(dir, ["claim"], "B");
    assert.ok(!/shared\.js\s+B/.test(list.stdout), "B holds nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a queued grant lives at least as long as the interest window it replaced", () => {
  const dir = makeRepo();
  try {
    q(dir, ["claim", "shared.js"], "A");
    q(dir, ["claim", "shared.js", "--queue"], "B");
    q(dir, ["release", "shared.js"], "A"); // promotes B immediately
    const cp = join(dir, ".quilt", "claims.json");
    const file = JSON.parse(readFileSync(cp, "utf8"));
    const grant = file.claims.find((c: any) => c.actor === "B" && c.viaQueue);
    assert.ok(grant, "B was promoted");
    // Waiter TTL (60m) outlives the claim TTL (30m): the grant must carry the
    // longer window, or an actor away for 40 minutes silently loses a target
    // it was first in line for.
    assert.ok(
      grant.expiresAt - Date.now() > 45 * 60 * 1000,
      `grant expiry too short: ${grant.expiresAt - Date.now()}ms`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
