import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state.js";
import { recordOutcome, openEscalations, resolutions, normalizeTarget } from "../src/outcomes.js";

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "quilt-outcomes-"));
  const s = new Store(dir);
  s.ensureDirs();
  return { s, dir };
}

test("outcomes: an escalation is open until a later resolution closes it", () => {
  const { s, dir } = newStore();
  try {
    recordOutcome(s, "escalated", "safety", "pool.js#maxConnections", "500 vs 25 — opposed", "t1");
    let open = openEscalations(s);
    assert.equal(open.length, 1, "escalation is open");
    assert.equal(open[0]!.target, "pool.js#maxConnections");
    assert.equal(open[0]!.note, "500 vs 25 — opposed");

    // A resolution on the same target closes it (latest outcome per target wins).
    recordOutcome(s, "resolved", "wilson", "pool.js#maxConnections", "made it env-configurable", "t2");
    assert.equal(openEscalations(s).length, 0, "resolution clears the Needs-you flag");
    assert.equal(resolutions(s).length, 1, "the resolution is in the audit trail");

    // A fresh escalation on the same target re-opens it (later outcome wins again).
    recordOutcome(s, "escalated", "safety", "pool.js#maxConnections", "regressed", "t3");
    assert.equal(openEscalations(s).length, 1, "a later escalation re-opens it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outcomes: targets are normalized and independent", () => {
  const { s, dir } = newStore();
  try {
    recordOutcome(s, "escalated", "a", "./pool.js#maxConnections", undefined, "t1");
    recordOutcome(s, "escalated", "b", "other.js#foo", "needs a decision", "t2");
    const open = openEscalations(s);
    assert.deepEqual(open.map((o) => o.target).sort(), ["other.js#foo", "pool.js#maxConnections"]);
    // `./pool.js#x` and `pool.js#x` are the same target — a resolve on the bare
    // form closes the escalation recorded with the `./` form.
    recordOutcome(s, "resolved", "wilson", "pool.js#maxConnections", undefined, "t3");
    assert.deepEqual(openEscalations(s).map((o) => o.target), ["other.js#foo"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeTarget strips ./ and trailing slashes, keeps the symbol", () => {
  assert.equal(normalizeTarget("./a.js#f"), "a.js#f");
  assert.equal(normalizeTarget("a.js#  f  "), "a.js#f");
  assert.equal(normalizeTarget("dir/"), "dir");
  assert.equal(normalizeTarget("a.js#"), "a.js");
});
