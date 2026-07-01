import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state.js";
import { initSymbols } from "../src/symbols.js";
import { applyAndRecordEdit } from "../src/authorship.js";
import { mergeHookSettings } from "../src/onboard.js";
import { diagnose, type DoctorReport } from "../src/doctor.js";

before(async () => {
  await initSymbols();
});

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-doctor-"));
  const g = (a: string[]) => execFileSync("git", a, { cwd: dir });
  g(["init", "-q"]); g(["config", "user.email", "t@t.io"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  return dir;
}
/** A fully-initialized Quilt store (config written, so `initialized` is true). */
function initStore(dir: string): Store {
  const s = new Store(dir);
  s.ensureDirs();
  s.writeConfig({ version: 1, createdAt: new Date(0).toISOString() });
  return s;
}
function check(r: DoctorReport, label: string) {
  return r.checks.find((c) => c.label === label);
}

test("doctor flags an uninitialized repo as not-ready", () => {
  const dir = gitRepo();
  try {
    const r = diagnose(new Store(dir)); // never ran init
    assert.equal(r.verdict, "not-ready");
    assert.equal(check(r, "Quilt")?.status, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reports captured edits and reflects QUILT_ACTOR identity", () => {
  const dir = gitRepo();
  writeFileSync(join(dir, "m.js"), "function foo() {\n  return 0;\n}\n");
  execFileSync("git", ["add", "-A"], { cwd: dir }); execFileSync("git", ["commit", "-qm", "i"], { cwd: dir });
  const s = initStore(dir);
  try {
    applyAndRecordEdit(s, { actor: "alpha", path: "m.js", oldString: "return 0", newString: "return 1" });
    const withActor = diagnose(s, { actorEnv: "alpha" });
    assert.equal(check(withActor, "Identity")?.status, "ok");
    assert.match(check(withActor, "Capture")!.detail, /1 edit recorded.*alpha/);
    // No QUILT_ACTOR (the human's shell) — informational, not a warning.
    assert.equal(check(diagnose(s, {}), "Identity")?.status, "info");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor WARNS in an agent shell when hooks are wired, changes exist, but nothing captured", () => {
  // The silent-failure signal, in AGENT context (QUILT_ACTOR set): this agent's
  // edits aren't flowing. In a human shell the same state stays at info (below).
  const dir = gitRepo();
  writeFileSync(join(dir, "m.js"), "a\n");
  execFileSync("git", ["add", "-A"], { cwd: dir }); execFileSync("git", ["commit", "-qm", "i"], { cwd: dir });
  const s = initStore(dir);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), mergeHookSettings(null).content); // hooks wired
  writeFileSync(join(dir, "m.js"), "b\n"); // uncommitted change, never captured
  try {
    const cap = check(diagnose(s, { actorEnv: "alpha" }), "Capture");
    assert.equal(cap?.status, "warn");
    assert.match(cap!.detail, /0 edits recorded/);
    assert.match(cap!.hint ?? "", /QUILT_ACTOR/);
    // Same state, human shell (no actor) → info, not a warning (no cry-wolf).
    assert.equal(check(diagnose(s, {}), "Capture")?.status, "info");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reports a corrupt checkpoint instead of crashing (a health tool must not crash on the thing it should diagnose)", () => {
  const dir = gitRepo();
  const s = initStore(dir);
  try {
    writeFileSync(join(dir, ".quilt", "authorship.checkpoint.json"), "{ not json");
    const r = diagnose(s, {}); // must not throw
    const cap = check(r, "Capture");
    assert.equal(cap?.status, "fail");
    assert.match(cap!.detail, /unreadable/);
    assert.equal(r.verdict, "not-ready");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor is healthy when wired, identified, and capturing", () => {
  const dir = gitRepo();
  writeFileSync(join(dir, "m.js"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir }); execFileSync("git", ["commit", "-qm", "i"], { cwd: dir });
  const s = initStore(dir);
  // Wire the full orchestrator (mcp + hooks + coordination) and capture an edit.
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { quilt: { command: "quilt", args: ["mcp"] } } }));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), mergeHookSettings(null).content);
  try {
    applyAndRecordEdit(s, { actor: "alpha", path: "m.js", oldString: "x", newString: "y" });
    const r = diagnose(s, { actorEnv: "alpha" });
    assert.equal(r.verdict, "healthy");
    assert.equal(r.captureCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
