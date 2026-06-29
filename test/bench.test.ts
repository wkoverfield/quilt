import { test, before } from "node:test";
import assert from "node:assert/strict";
import { runScenario, type ScenarioResult } from "../bench/harness.js";
import { scenarios } from "../bench/scenarios.js";

// The eval harness is both a regression guard for Quilt and an instrument that
// must actually discriminate. These tests assert two things per rung:
//   1. WITH Quilt: no silent loss, correct attribution, no broken final state.
//   2. WITHOUT Quilt: the harness genuinely detects the failure it's meant to —
//      otherwise a "clean WITH" result would be meaningless.

// Run the scenarios once in a before() hook (not at import time) so a failure to
// spawn the CLI surfaces as one hook error rather than poisoning every test.
const byId: Record<string, ScenarioResult> = {};
before(() => {
  for (const s of scenarios) byId[s.id] = runScenario(s);
});

for (const s of scenarios) {
  test(`${s.id} WITH Quilt: no loss, correct attribution, not broken`, () => {
    const m = byId[s.id]!.with.metrics;
    assert.equal(m.silentLoss, 0, "no work should silently vanish");
    assert.ok(m.attributionCorrect, "every change attributed to its author");
    assert.equal(m.broken, false, "final state must be coherent");
  });
}

test("L1 WITHOUT Quilt entangles attribution (absorption is real)", () => {
  const m = byId["L1"]!.without.metrics;
  assert.ok(m.misattributed > 0, "naive shared-tree commits absorb others' work");
});

test("L2 WITHOUT Quilt silently loses one side of an incompatible conflict", () => {
  const m = byId["L2"]!.without.metrics;
  assert.ok(m.silentLoss > 0, "the overwritten edit vanishes with no signal");
});

test("L2 WITH Quilt surfaces the conflict instead of losing work", () => {
  const m = byId["L2"]!.with.metrics;
  assert.equal(m.silentLoss, 0);
  assert.ok(m.surfacedConflicts > 0, "the collision is raised for a human");
});

test("L3 WITHOUT Quilt leaves the codebase broken (cascade not seen)", () => {
  const m = byId["L3"]!.without.metrics;
  assert.equal(m.broken, true, "B writes against the old signature");
});

test("L3 WITH Quilt adapts the dependent call (no break)", () => {
  const m = byId["L3"]!.with.metrics;
  assert.equal(m.broken, false, "B sees A's claim and adapts");
});

test("L4 WITHOUT Quilt bulldozes B's edit during A's refactor", () => {
  const m = byId["L4"]!.without.metrics;
  assert.ok(m.silentLoss > 0, "B's line edit vanishes under the refactor");
});

test("L4 WITH Quilt surfaces the refactor/edit collision", () => {
  const m = byId["L4"]!.with.metrics;
  assert.equal(m.silentLoss, 0);
  assert.ok(m.surfacedConflicts > 0);
});

test("L5 WITHOUT Quilt loses A's work when B's task drifts into it", () => {
  const m = byId["L5"]!.without.metrics;
  assert.ok(m.silentLoss > 0, "emergent overlap overwrites A's in-flight change");
});

test("L5 WITH Quilt catches the overlap when it emerges", () => {
  const m = byId["L5"]!.with.metrics;
  assert.equal(m.silentLoss, 0);
  assert.ok(m.surfacedConflicts > 0, "B's late claim on A's symbol is denied");
});

test("L6 WITHOUT Quilt misattributes under mixed actors + noise", () => {
  const m = byId["L6"]!.without.metrics;
  assert.ok(m.misattributed > 0, "the first committer absorbs the others' work");
});

test("L6 WITH Quilt keeps every author correct under noise", () => {
  const m = byId["L6"]!.with.metrics;
  assert.ok(m.attributionCorrect);
  assert.equal(m.silentLoss, 0);
});
