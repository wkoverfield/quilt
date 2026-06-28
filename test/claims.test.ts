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

test("claims: acquire, deny another actor, release, re-acquire", () => {
  const { s, dir } = newStore();
  try {
    const t0 = 1000;
    let r = acquireClaims(s, "alice", "sessA", ["a.ts", "b.ts"], t0);
    assert.ok(r.every((x) => x.granted), "alice gets both");

    r = acquireClaims(s, "bob", "sessB", ["a.ts"], t0);
    assert.equal(r[0]!.granted, false);
    assert.equal(r[0]!.holder, "alice");

    releaseClaims(s, "alice", ["a.ts"]);
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
    const n = releaseClaims(s, "alice", null);
    assert.equal(n, 3);
    assert.equal(listClaims(s, t0).length, 0);
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
