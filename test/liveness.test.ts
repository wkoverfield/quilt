import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state.js";
import { initSymbols } from "../src/symbols.js";
import {
  acquireClaims,
  listClaims,
  RECLAIM_IDLE_MS,
  CLAIM_TTL_MS,
} from "../src/claims.js";
import { applyAndRecordEdit, readAuthorship } from "../src/authorship.js";
import { reconcile } from "../src/engine.js";

before(async () => {
  await initSymbols();
});

// Dead-actor claim liveness: an orphaned runner (process died between claiming
// and editing) held a 30-minute lease that stranded a live builder, silently
// re-authored the builder's +59-line edit via claim adoption, and needed a
// human git-commit + resolve to untangle. These tests pin the automatic escape.

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-liveness-"));
  const g = (a: string[]) => execFileSync("git", a, { cwd: dir });
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t.io"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  const s = new Store(dir);
  s.ensureDirs();
  s.writeConfig({ version: 1, createdAt: new Date(0).toISOString() });
  s.writeObserved({ files: {} });
  s.writeOwnership({ files: {}, conflicts: {} });
  return dir;
}

function seed(dir: string, rel: string, content: string): void {
  writeFileSync(join(dir, rel), content);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: dir });
}

/** A claim planted in the past: acquired/renewed `ageMs` ago, still inside TTL. */
function plantStaleClaim(s: Store, actor: string, target: string, ageMs: number): void {
  const then = Date.now() - ageMs;
  const results = acquireClaims(s, actor, null, [target], then, "orphaned run");
  assert.ok(results.every((r) => r.granted), "planting the stale claim must succeed");
  // Sanity: still unexpired at `now` — staleness, not expiry, is under test.
  assert.ok(ageMs < CLAIM_TTL_MS, "test setup: the claim must still be inside its TTL");
}

test("the Forge repro: an anonymous edit inside a dead holder's claim is NOT adopted — it lands under its real author", () => {
  const dir = repo();
  try {
    seed(dir, "clients.ts", "export function list() {\n  return [];\n}\n");
    const s = new Store(dir);
    // The orphaned runner: claimed, then died. No session, zero edits, idle
    // past the reclaim window but well inside the 30-minute TTL.
    plantStaleClaim(s, "backend", "clients.ts", RECLAIM_IDLE_MS + 60_000);

    // The live builder edits under an auto-derived id (autoActor: the hook
    // path). Pre-fix this was adopted by "backend" — silent misattribution.
    const r = applyAndRecordEdit(s, {
      actor: "claude-live1234",
      path: "clients.ts",
      oldString: "return [];",
      newString: "return [1];",
      autoActor: true,
    });
    assert.ok("event" in r && r.ok, `edit must proceed, got ${JSON.stringify(r)}`);
    assert.equal((r as { event: { actor: string } }).event.actor, "claude-live1234", "attributed to the LIVE editor, not the dead holder");

    // The dead reservation is gone, and the reclaim is on the record.
    assert.equal(listClaims(s, Date.now()).length, 0, "the dead claim was reclaimed");
    const ledger = readFileSync(join(dir, ".quilt", "ledger.jsonl"), "utf8");
    assert.match(ledger, /claim\.reclaimed/);
    assert.match(ledger, /backend/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live claimant reclaims a dead holder's target at acquire time, with the grant explaining itself", () => {
  const dir = repo();
  try {
    seed(dir, "a.ts", "export const a = 1;\n");
    const s = new Store(dir);
    plantStaleClaim(s, "backend", "a.ts", RECLAIM_IDLE_MS + 60_000);

    const now = Date.now();
    const [r] = acquireClaims(s, "builder", null, ["a.ts"], now, "second run");
    assert.equal(r!.granted, true, "granted despite the standing (dead) claim");
    assert.equal(r!.reclaimedFrom, "backend", "the grant names who it reclaimed from");
    const claims = listClaims(s, now);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.actor, "builder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dead-LOOKING holder WITH uncommitted work is protected: no adoption, no reclaim — a loud deny instead", () => {
  const dir = repo();
  try {
    seed(dir, "b.ts", "export function f() {\n  return 1;\n}\n");
    const s = new Store(dir);
    // The holder edited (captured + attributed via reconcile), then went quiet.
    const past = Date.now() - (RECLAIM_IDLE_MS + 120_000);
    acquireClaims(s, "backend", null, ["b.ts"], past, "mid-task");
    const edited = applyAndRecordEdit(s, { actor: "backend", path: "b.ts", oldString: "return 1;", newString: "return 2;" });
    assert.ok("event" in edited && edited.ok);
    reconcile(s, "backend"); // attribute the work into ownership.json
    // Age the claim back to stale (the edit refreshed it): rewrite renewedAt.
    const file = s.readClaims();
    for (const c of file.claims) {
      c.renewedAt = past;
      c.acquiredAt = new Date(past).toISOString();
    }
    s.writeClaims(file);

    // An anonymous edit must NOT be adopted to the quiet holder, and must NOT
    // reclaim (there is real work to protect): it is denied, loudly.
    const r = applyAndRecordEdit(s, {
      actor: "claude-live9999",
      path: "b.ts",
      oldString: "return 2;",
      newString: "return 3;",
      autoActor: true,
    });
    assert.ok(!("event" in r), "the edit is denied");
    assert.equal((r as { heldBy?: string }).heldBy, "backend", "the denial names the holder");
    assert.equal(listClaims(s, Date.now()).length, 1, "the claim protecting real work survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a LIVE holder keeps today's semantics: adoption binds the anonymous edit, acquire is denied", () => {
  const dir = repo();
  try {
    seed(dir, "c.ts", "export function g() {\n  return 1;\n}\n");
    const s = new Store(dir);
    const now = Date.now();
    acquireClaims(s, "ui-agent", null, ["c.ts"], now, "styling pass");

    // Anonymous edit inside a FRESH claim → adopted by the holder (the
    // same-agent MCP-claim + native-edit pattern, unchanged).
    const r = applyAndRecordEdit(s, {
      actor: "claude-abcd1234",
      path: "c.ts",
      oldString: "return 1;",
      newString: "return 5;",
      autoActor: true,
    });
    assert.ok("event" in r && r.ok);
    assert.equal((r as { event: { actor: string } }).event.actor, "ui-agent", "live-holder adoption still applies");

    // And a rival acquire is still denied — no reclaim of a live claim.
    const [denied] = acquireClaims(s, "rival", null, ["c.ts"], Date.now());
    assert.equal(denied!.granted, false);
    assert.equal(denied!.holder, "ui-agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a queued waiter is auto-granted when the blocking holder is presumed dead (no human, no TTL wait)", () => {
  const dir = repo();
  try {
    seed(dir, "d.ts", "export const d = 1;\n");
    const s = new Store(dir);
    plantStaleClaim(s, "backend", "d.ts", RECLAIM_IDLE_MS + 60_000);

    // Wait — plant the waiter BEFORE the holder goes stale? The waiter queued
    // against a then-live holder: queue at (stale-window - 1min) ago... For the
    // test, queueing NOW against the already-stale holder must reclaim at
    // acquire time directly. Use a fresh holder + a queued waiter + reconcile.
    const now = Date.now();
    const [r] = acquireClaims(s, "builder", null, ["d.ts"], now, "wants it", { queue: true });
    // The acquire itself reaps the dead holder, so the builder is granted
    // outright rather than queued.
    assert.equal(r!.granted, true, "acquire-time reap grants immediately");
    assert.equal(r!.reclaimedFrom, "backend");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile reaps a dead holder that is blocking a live queue (the ambient unwedge)", () => {
  const dir = repo();
  try {
    seed(dir, "e.ts", "export const e = 1;\n");
    const s = new Store(dir);
    // A live-ish holder at queue time...
    const queueTime = Date.now() - (RECLAIM_IDLE_MS + 60_000);
    acquireClaims(s, "backend", null, ["e.ts"], queueTime, "first run");
    // ...a waiter queued moments later (holder still fresh then → queued)...
    const [q] = acquireClaims(s, "builder", null, ["e.ts"], queueTime + 1000, "second run", { queue: true });
    assert.equal(q!.granted, false);
    assert.equal(q!.queued, true, "queued while the holder still looked alive");

    // ...then the holder dies silently. ANY actor's reconcile (every quilt
    // command runs one) unwedges the queue.
    reconcile(s, null);
    const claims = listClaims(s, Date.now());
    assert.equal(claims.length, 1, "exactly one claim after the unwedge");
    assert.equal(claims[0]!.actor, "builder", "the waiter was promoted over the dead holder");
    assert.ok(claims[0]!.viaQueue, "granted off the queue");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ended session reclaims immediately (no idle wait) when there is no work to protect", () => {
  const dir = repo();
  try {
    seed(dir, "f.ts", "export const f = 1;\n");
    const s = new Store(dir);
    // A session-backed claim, freshly renewed...
    s.writeSession({ id: "sess_dead", actorId: "backend", actorType: "agent", repoRoot: dir, baseSha: null, startedAt: new Date().toISOString(), status: "active" });
    const now = Date.now();
    acquireClaims(s, "backend", "sess_dead", ["f.ts"], now, "run");
    // ...whose session then ENDS. That is a definitive goodbye.
    s.writeSession({ id: "sess_dead", actorId: "backend", actorType: "agent", repoRoot: dir, baseSha: null, startedAt: new Date().toISOString(), status: "ended" });

    const [r] = acquireClaims(s, "builder", null, ["f.ts"], now + 5_000);
    assert.equal(r!.granted, true, "an ended session's claim yields without waiting out the idle window");
    assert.equal(r!.reclaimedFrom, "backend");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captured edits are proof of life: refreshClaims stamps renewedAt so an active editor is never reaped", () => {
  const dir = repo();
  try {
    seed(dir, "g.ts", "export function h() {\n  return 1;\n}\n");
    const s = new Store(dir);
    const past = Date.now() - (RECLAIM_IDLE_MS + 60_000);
    acquireClaims(s, "worker", null, ["g.ts"], past, "long task");
    // The worker edits NOW (capture refreshes the claim, stamping renewedAt).
    const r = applyAndRecordEdit(s, { actor: "worker", path: "g.ts", oldString: "return 1;", newString: "return 9;" });
    assert.ok("event" in r && r.ok);

    const [denied] = acquireClaims(s, "rival", null, ["g.ts"], Date.now());
    assert.equal(denied!.granted, false, "a just-active editor's claim is live, not reapable");
    assert.equal(denied!.holder, "worker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a quiet holder's claim over UNCAPTURED work (bash/codegen writes, dirty tree) is never reclaimed", () => {
  // The claim-first codegen workflow: nothing captures raw script writes, so
  // neither the ledger nor ownership.json knows about them. The working-tree
  // dirt itself must block reclamation, or an idle holder's generated output
  // would lose its only protection with no clobber backstop.
  const dir = repo();
  try {
    seed(dir, "keep.ts", "export const k = 1;\n");
    const s = new Store(dir);
    plantStaleClaim(s, "codegen-bot", "gen/", RECLAIM_IDLE_MS + 60_000);
    // Raw uncaptured writes under the claimed directory (no quilt involved).
    execFileSync("mkdir", ["-p", join(dir, "gen")]);
    writeFileSync(join(dir, "gen", "out.ts"), "export const generated = true;\n");

    const [r] = acquireClaims(s, "rival", null, ["gen/"], Date.now());
    assert.equal(r!.granted, false, "a dirty target is never reclaimed, however quiet the holder");
    assert.equal(r!.holder, "codegen-bot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
