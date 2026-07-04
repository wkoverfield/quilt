import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state.js";
import {
  acquireClaims,
  releaseClaims,
  listClaims,
  CLAIM_TTL_MS,
} from "../src/claims.js";

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "quilt-claims-"));
  const s = new Store(dir);
  s.ensureDirs();
  return { s, dir };
}

test("claims: a denied actor receives the holder's intent (the sew primitive)", () => {
  const { s, dir } = newStore();
  try {
    const t0 = 1000;
    acquireClaims(s, "perf", "sessA", ["pool.js#maxConnections"], t0, "PERF-412: raise for peak load");
    // The holder's intent is recorded on the claim.
    const held = listClaims(s, t0).find((c) => c.actor === "perf");
    assert.equal(held?.intent, "PERF-412: raise for peak load");

    // A blocked actor learns WHY, so it can resolve instead of guessing.
    const r = acquireClaims(s, "safety", "sessB", ["pool.js#maxConnections"], t0, "SAFETY-87: cap to protect DB");
    assert.equal(r[0]!.granted, false);
    assert.equal(r[0]!.holder, "perf");
    assert.equal(r[0]!.holderIntent, "PERF-412: raise for peak load");

    // Re-claiming with a new intent updates it; a blank intent is ignored.
    acquireClaims(s, "perf", "sessA", ["pool.js#maxConnections"], t0 + 1, "PERF-412: now dynamic");
    assert.equal(listClaims(s, t0 + 1).find((c) => c.actor === "perf")?.intent, "PERF-412: now dynamic");
    acquireClaims(s, "perf", "sessA", ["pool.js#maxConnections"], t0 + 2, "   ");
    assert.equal(listClaims(s, t0 + 2).find((c) => c.actor === "perf")?.intent, "PERF-412: now dynamic");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claims: acquire, deny another actor, release, re-acquire", () => {
  const { s, dir } = newStore();
  try {
    const t0 = 1000;
    let r = acquireClaims(s, "alice", "sessA", ["a.ts", "b.ts"], t0);
    assert.ok(r.every((x) => x.granted), "alice gets both");

    r = acquireClaims(s, "bob", "sessB", ["a.ts"], t0);
    assert.equal(r[0]!.granted, false);
    assert.equal(r[0]!.holder, "alice");

    releaseClaims(s, "alice", ["a.ts"], t0);
    r = acquireClaims(s, "bob", "sessB", ["a.ts"], t0);
    assert.equal(r[0]!.granted, true, "freed path is claimable");

    // alice still holds b.ts
    assert.ok(listClaims(s, t0).some((c) => c.path === "b.ts" && c.actor === "alice"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claims: expire after the TTL", () => {
  const { s, dir } = newStore();
  try {
    const t0 = 1000;
    acquireClaims(s, "alice", null, ["x.ts"], t0);
    const later = t0 + CLAIM_TTL_MS + 1;
    assert.equal(listClaims(s, later).length, 0, "claim expired");
    const r = acquireClaims(s, "bob", null, ["x.ts"], later);
    assert.equal(r[0]!.granted, true, "bob claims the expired path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claims: release all of an actor's claims", () => {
  const { s, dir } = newStore();
  try {
    const t0 = 1000;
    acquireClaims(s, "alice", null, ["a", "b", "c"], t0);
    const n = releaseClaims(s, "alice", null, t0);
    assert.equal(n.released, 3);
    assert.equal(listClaims(s, t0).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claims: releasing with an empty array releases nothing", () => {
  const { s, dir } = newStore();
  try {
    acquireClaims(s, "alice", null, ["a", "b"], 1000);
    const n = releaseClaims(s, "alice", [], 1000);
    assert.equal(n.released, 0, "empty array is a no-op, not release-all");
    assert.equal(listClaims(s, 1000).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claims: ./foo and foo are the same claim (path normalization)", () => {
  const { s, dir } = newStore();
  try {
    const a = acquireClaims(s, "alice", null, ["./src/x.ts"], 1000);
    assert.equal(a[0]!.granted, true);
    const b = acquireClaims(s, "bob", null, ["src/x.ts"], 1000);
    assert.equal(b[0]!.granted, false, "normalized to the same path");
    assert.equal(b[0]!.holder, "alice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claims: different symbols in one file don't contend; same symbol does", () => {
  const { s, dir } = newStore();
  try {
    const t = 1000;
    assert.equal(acquireClaims(s, "a1", null, ["utils.js#foo"], t)[0]!.granted, true);
    // Different symbol, same file → granted.
    const bar = acquireClaims(s, "a2", null, ["utils.js#bar"], t)[0]!;
    assert.equal(bar.granted, true);
    assert.equal(bar.symbol, "bar");
    // Same symbol → denied.
    const foo2 = acquireClaims(s, "a2", null, ["utils.js#foo"], t)[0]!;
    assert.equal(foo2.granted, false);
    assert.equal(foo2.holder, "a1");
    // A whole-file claim overlaps any symbol claim → denied.
    assert.equal(acquireClaims(s, "a3", null, ["utils.js"], t)[0]!.granted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLock is not reentrant (fails fast instead of self-deadlocking)", () => {
  const { s, dir } = newStore();
  try {
    assert.throws(() => s.withLock(() => s.withLock(() => 1)), /not reentrant/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claims: re-claiming your own path refreshes its expiry", () => {
  const { s, dir } = newStore();
  try {
    const t0 = 1000;
    acquireClaims(s, "alice", null, ["x"], t0);
    const t1 = t0 + CLAIM_TTL_MS - 1; // just before expiry
    acquireClaims(s, "alice", null, ["x"], t1); // refresh
    const stillHeld = listClaims(s, t0 + CLAIM_TTL_MS + 1); // past original expiry
    assert.equal(stillHeld.length, 1, "refresh extended the TTL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claims: an absolute path inside the repo is stored repo-relative and collides with the relative form", () => {
  const { s, dir } = newStore();
  try {
    const t0 = 1000;
    const [r] = acquireClaims(s, "alice", null, [join(dir, "src", "a.js") + "#login"], t0, "auth work");
    assert.equal(r!.granted, true);
    assert.equal(r!.path, "src/a.js", "stored repo-relative with forward slashes");
    // The relative spelling of the same target is the SAME claim — denied for bob.
    const [denied] = acquireClaims(s, "bob", null, ["src/a.js#login"], t0);
    assert.equal(denied!.granted, false);
    assert.equal(denied!.holder, "alice");
    // Releasing by the absolute spelling frees the relative claim.
    assert.equal(releaseClaims(s, "alice", [join(dir, "src", "a.js")], t0).released, 1);
    assert.equal(listClaims(s, t0).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claims: a path outside the repo is still rejected outright", () => {
  const { s, dir } = newStore();
  try {
    const [r] = acquireClaims(s, "eve", null, ["/etc/passwd"], 1000);
    assert.equal(r!.granted, false);
    assert.equal(r!.reason, "outside-repo");
    const [r2] = acquireClaims(s, "eve", null, ["../sibling/file.js"], 1000);
    assert.equal(r2!.granted, false);
    assert.equal(r2!.reason, "outside-repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
