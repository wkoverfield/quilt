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
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnose, parseGitVersion, probeMcpServer, type DoctorReport } from "../src/doctor.js";

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

// --- version staleness (the highest-leverage check: the first external user
// ran a five-versions-stale install and nothing ever told him) ---

test("doctor nudges when behind the published latest", () => {
  const dir = gitRepo();
  const s = initStore(dir);
  try {
    const r = diagnose(s, { latest: "9.9.9", currentVersion: "0.4.4" });
    const v = check(r, "Version");
    assert.equal(v?.status, "warn");
    assert.match(v!.detail, /0\.4\.4/);
    assert.match(v!.detail, /9\.9\.9/);
    assert.match(v!.hint ?? "", /quilt update/, "the nudge names the exact update command");
    assert.equal(r.verdict, "warnings");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor treats a pre-0.4.0 build as not-ready (broken, not merely stale)", () => {
  const dir = gitRepo();
  const s = initStore(dir);
  try {
    // No `latest` needed: below the minimum is knowable offline.
    const r = diagnose(s, { currentVersion: "0.3.0" });
    const v = check(r, "Version");
    assert.equal(v?.status, "fail");
    assert.match(v!.detail, /auto-identity/);
    assert.equal(r.verdict, "not-ready");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor stays silent about versions when the check failed (offline) and ok when current", () => {
  const dir = gitRepo();
  const s = initStore(dir);
  try {
    // latest: null = the daily check failed (offline). No Version check at all,
    // and the verdict is unaffected — a nudge must never require the network.
    const offline = diagnose(s, { latest: null, currentVersion: "0.4.4" });
    assert.equal(check(offline, "Version"), undefined);
    assert.notEqual(offline.verdict, "not-ready");

    const current = diagnose(s, { latest: "0.4.4", currentVersion: "0.4.4" });
    assert.equal(check(current, "Version")?.status, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- git version (a pre-2.18 system git breaks `status --no-renames` with a
// cryptic error inside every command — doctor must name it and the fix) ---

test("parseGitVersion handles real-world version strings", () => {
  assert.deepEqual(parseGitVersion("git version 2.50.1 (Apple Git-155)"), { major: 2, minor: 50 });
  assert.deepEqual(parseGitVersion("git version 2.15.0"), { major: 2, minor: 15 });
  assert.equal(parseGitVersion("not git at all"), null);
});

test("doctor fails loudly on a pre-2.18 git and names the PATH-shadowing fix", () => {
  const dir = gitRepo();
  const s = initStore(dir);
  try {
    const r = diagnose(s, { gitVersion: "git version 2.15.0" });
    const g = check(r, "Git");
    assert.equal(g?.status, "fail");
    assert.match(g!.detail, /2\.15/);
    assert.match(g!.detail, /no-renames/, "the failing flag is named");
    assert.match(g!.hint ?? "", /PATH/);
    assert.equal(r.verdict, "not-ready");

    // A modern git is an ok check; git unrunnable at all is a fail.
    assert.equal(check(diagnose(s, { gitVersion: "git version 2.50.1" }), "Git")?.status, "ok");
    assert.equal(check(diagnose(s, { gitVersion: null }), "Git")?.status, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- MCP: the approval reality note, and the live self-test ---

test("doctor notes that MCP claim tools need client approval while hooks work without it", () => {
  const dir = gitRepo();
  const s = initStore(dir);
  try {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { quilt: { command: "quilt", args: ["mcp"] } } }));
    const r = diagnose(s, {});
    const a = check(r, "MCP approval");
    assert.equal(a?.status, "info", "informational — doctor can't see the client's approval state");
    assert.match(a!.detail + (a!.hint ?? ""), /approv/);
    assert.match(a!.hint ?? "", /hooks/, "says the hooks protect without approval");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor renders the MCP self-test result (ok and failure)", () => {
  const dir = gitRepo();
  const s = initStore(dir);
  try {
    const ok = diagnose(s, { mcpProbe: { ok: true, toolCount: 13 } });
    assert.equal(check(ok, "MCP self-test")?.status, "ok");
    assert.match(check(ok, "MCP self-test")!.detail, /13 tools/);

    const bad = diagnose(s, { mcpProbe: { ok: false, toolCount: 0, error: "spawn quilt ENOENT" } });
    assert.equal(check(bad, "MCP self-test")?.status, "warn");
    assert.match(check(bad, "MCP self-test")!.hint ?? "", /hooks still protect/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeMcpServer drives a real initialize/tools-list handshake against dist/cli.js", async () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const dir = gitRepo();
  initStore(dir); // quilt mcp refuses to run uninitialized
  try {
    const r = await probeMcpServer({ command: [process.execPath, CLI, "mcp"], cwd: dir, timeoutMs: 10_000 });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.toolCount >= 10, `expected the full tool set, got ${r.toolCount}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeMcpServer fails safe: dead command, exiting server, and silence all resolve", async () => {
  const dir = gitRepo();
  try {
    const missing = await probeMcpServer({ command: ["quilt-definitely-not-a-command"], cwd: dir, timeoutMs: 3000 });
    assert.equal(missing.ok, false);

    const exits = await probeMcpServer({ command: [process.execPath, "-e", "process.exit(1)"], cwd: dir, timeoutMs: 3000 });
    assert.equal(exits.ok, false);
    assert.match(exits.error ?? "", /exited/);

    const silent = await probeMcpServer({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: dir,
      timeoutMs: 500,
    });
    assert.equal(silent.ok, false);
    assert.match(silent.error ?? "", /no response/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
