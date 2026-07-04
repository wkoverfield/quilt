import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store } from "../src/state.js";
import { acquireClaims } from "../src/claims.js";
import { initSymbols } from "../src/symbols.js";
import { readAuthorship } from "../src/authorship.js";
import { parseHookInput, runHookPre, runHookPost, sessionActorId, agentActorId, type HookInput } from "../src/hooks.js";

before(async () => {
  await initSymbols(); // prevention parses symbols to find the touched ones
});

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "quilt-hooks-"));
  const s = new Store(dir);
  s.ensureDirs();
  return { s, dir };
}

/** Simulate the native tool applying an edit between the Pre and Post hooks. */
function applyEdit(dir: string, path: string, oldStr: string, newStr: string) {
  const abs = join(dir, path);
  const before = readFileSync(abs, "utf8");
  writeFileSync(abs, before.replace(oldStr, newStr));
}

// ---- parseHookInput ----

test("parseHookInput normalizes an Edit payload (old_string/new_string)", () => {
  const p = parseHookInput({
    tool_name: "Edit",
    tool_input: { file_path: "m.js", old_string: "a", new_string: "b" },
  });
  assert.deepEqual(p, {
    tool: "Edit",
    path: "m.js",
    edits: [{ oldString: "a", newString: "b" }],
    content: null,
    sessionId: null,
    agentId: null,
    agentType: null,
  });
});

test("parseHookInput carries session_id for auto identity, and sessionActorId derives from it", () => {
  const p = parseHookInput({
    tool_name: "Edit",
    session_id: "AB12cd34-9999-4abc-8def-000011112222",
    tool_input: { file_path: "m.js", old_string: "a", new_string: "b" },
  });
  assert.equal(p!.sessionId, "AB12cd34-9999-4abc-8def-000011112222");
  assert.equal(sessionActorId(p!.sessionId!), "claude-ab12cd34");
  assert.equal(sessionActorId("!!!"), null, "no derivable id from junk");
});

test("parseHookInput accepts the alternate old_str/new_str/file_text spellings", () => {
  const edit = parseHookInput({ tool_name: "Edit", tool_input: { file_path: "m.js", old_str: "a", new_str: "b" } });
  assert.deepEqual(edit!.edits, [{ oldString: "a", newString: "b" }]);
  const write = parseHookInput({ tool_name: "Write", tool_input: { file_path: "m.js", file_text: "hi" } });
  assert.equal(write!.content, "hi");
});

test("parseHookInput handles a Write (content) and a MultiEdit (edits[])", () => {
  const w = parseHookInput({ tool_name: "Write", tool_input: { file_path: "m.js", content: "hello\n" } });
  assert.deepEqual(w, {
    tool: "Write", path: "m.js", edits: [], content: "hello\n",
    sessionId: null, agentId: null, agentType: null,
  });
  const m = parseHookInput({
    tool_name: "MultiEdit",
    tool_input: { file_path: "m.js", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] },
  });
  assert.equal(m!.edits.length, 2);
  assert.deepEqual(m!.edits[1], { oldString: "c", newString: "d" });
});

test("parseHookInput returns null without a tool_name", () => {
  assert.equal(parseHookInput({ tool_input: {} }), null);
  assert.equal(parseHookInput(null), null);
});

// ---- capture roundtrip ----

test("Pre snapshots and Post captures a native Edit's author + delta", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "export const limit = 100;\n");
    const input = parseHookInput({
      tool_name: "Edit",
      tool_input: { file_path: "m.js", old_string: "limit = 100", new_string: "limit = 500" },
    })!;
    const decision = runHookPre(s, "perf", input);
    assert.equal(decision.deny, false);
    applyEdit(dir, "m.js", "limit = 100", "limit = 500"); // the native tool runs
    runHookPost(s, "perf", input);

    const ev = readAuthorship(s);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.actor, "perf");
    assert.deepEqual(ev[0]!.added, ["export const limit = 500;"]);
    assert.deepEqual(ev[0]!.removed, ["export const limit = 100;"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Post captures a whole-file Write as whole:true", () => {
  const { s, dir } = newStore();
  try {
    const input = parseHookInput({ tool_name: "Write", tool_input: { file_path: "new.js", content: "export const x = 1;\n" } })!;
    assert.equal(runHookPre(s, "a", input).deny, false);
    writeFileSync(join(dir, "new.js"), "export const x = 1;\n"); // native Write creates it
    runHookPost(s, "a", input);
    const ev = readAuthorship(s);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.whole, true);
    assert.deepEqual(ev[0]!.added, ["export const x = 1;"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MultiEdit captures every added line in one event", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "function a() {\n  return 0;\n}\nfunction b() {\n  return 0;\n}\n");
    const input = parseHookInput({
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "m.js",
        edits: [
          { old_string: "function a() {\n  return 0;\n}", new_string: "function a() {\n  return 1;\n}" },
          { old_string: "function b() {\n  return 0;\n}", new_string: "function b() {\n  return 2;\n}" },
        ],
      },
    })!;
    assert.equal(runHookPre(s, "a", input).deny, false);
    applyEdit(dir, "m.js", "function a() {\n  return 0;\n}", "function a() {\n  return 1;\n}");
    applyEdit(dir, "m.js", "function b() {\n  return 0;\n}", "function b() {\n  return 2;\n}");
    runHookPost(s, "a", input);
    const ev = readAuthorship(s);
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0]!.added.sort(), ["  return 1;", "  return 2;"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- prevention ----

test("Pre DENIES a native edit into a symbol another actor holds, with their intent", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "export function maxConnections() {\n  return 100;\n}\n");
    // perf holds the symbol.
    acquireClaims(s, "perf", null, ["m.js#maxConnections"], Date.now(), "PERF-1: raise to 500");
    const input = parseHookInput({
      tool_name: "Edit",
      tool_input: { file_path: "m.js", old_string: "return 100", new_string: "return 25" },
    })!;
    const decision = runHookPre(s, "safety", input);
    assert.equal(decision.deny, true);
    assert.match(decision.reason!, /held by perf/);
    assert.match(decision.reason!, /PERF-1/);
    // Denied → nothing snapshotted, and if the (blocked) tool never runs, no capture.
    runHookPost(s, "safety", input);
    assert.equal(readAuthorship(s).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pre allows an edit into a symbol the SAME actor holds", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "export function maxConnections() {\n  return 100;\n}\n");
    acquireClaims(s, "perf", null, ["m.js#maxConnections"], Date.now(), "PERF-1");
    const input = parseHookInput({
      tool_name: "Edit",
      tool_input: { file_path: "m.js", old_string: "return 100", new_string: "return 500" },
    })!;
    assert.equal(runHookPre(s, "perf", input).deny, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- safety / no-op ----

test("Post without a matching Pre snapshot records nothing", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "a = 1;\n");
    const input = parseHookInput({ tool_name: "Edit", tool_input: { file_path: "m.js", old_string: "1", new_string: "2" } })!;
    runHookPost(s, "a", input); // no prior Pre
    assert.equal(readAuthorship(s).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a path escaping the repo is neither snapshotted nor captured (and never denied)", () => {
  const { s, dir } = newStore();
  try {
    const input: HookInput = { tool: "Edit", path: "../../escape.js", edits: [{ oldString: "a", newString: "b" }], content: null };
    assert.equal(runHookPre(s, "a", input).deny, false);
    runHookPost(s, "a", input);
    assert.equal(readAuthorship(s).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlink path is refused — its target's content is never snapshotted", () => {
  const { s, dir } = newStore();
  const outside = mkdtempSync(join(tmpdir(), "quilt-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "SECRET\n");
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    const input: HookInput = { tool: "Edit", path: "link.txt", edits: [{ oldString: "SECRET", newString: "x" }], content: null };
    assert.equal(runHookPre(s, "a", input).deny, false, "not our path to police, but not captured either");
    // No snapshot written (the symlink was refused), so nothing to leak.
    assert.equal(existsSync(s.paths.hookSnapshotsDir) ? readdirSync(s.paths.hookSnapshotsDir).length : 0, 0);
    runHookPost(s, "a", input);
    assert.equal(readAuthorship(s).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an unrecognized tool payload (no edits, no content) leaves no snapshot and records nothing", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "x = 1;\n");
    const input: HookInput = { tool: "Bash", path: "m.js", edits: [], content: null };
    assert.equal(runHookPre(s, "a", input).deny, false);
    assert.equal(existsSync(s.paths.hookSnapshotsDir) ? readdirSync(s.paths.hookSnapshotsDir).length : 0, 0, "no spurious snapshot");
    runHookPost(s, "a", input);
    assert.equal(readAuthorship(s).length, 0, "no zero-delta event");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two actors editing the same file use separate snapshots (no cross-talk)", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "function a() {\n  return 0;\n}\nfunction b() {\n  return 0;\n}\n");
    const inA = parseHookInput({ tool_name: "Edit", tool_input: { file_path: "m.js", old_string: "function a() {\n  return 0;\n}", new_string: "function a() {\n  return 1;\n}" } })!;
    const inB = parseHookInput({ tool_name: "Edit", tool_input: { file_path: "m.js", old_string: "function b() {\n  return 0;\n}", new_string: "function b() {\n  return 2;\n}" } })!;
    // Both Pres fire (interleaved), then both writes, then both Posts.
    runHookPre(s, "A", inA);
    runHookPre(s, "B", inB);
    applyEdit(dir, "m.js", "function a() {\n  return 0;\n}", "function a() {\n  return 1;\n}");
    applyEdit(dir, "m.js", "function b() {\n  return 0;\n}", "function b() {\n  return 2;\n}");
    runHookPost(s, "A", inA);
    runHookPost(s, "B", inB);
    const ev = readAuthorship(s);
    assert.equal(ev.length, 2);
    const byActor = new Map(ev.map((e) => [e.actor, e.added]));
    assert.deepEqual(byActor.get("A"), ["  return 1;"]);
    assert.deepEqual(byActor.get("B"), ["  return 2;"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot is consumed after Post (a second Post is a no-op)", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "x = 1;\n");
    const input = parseHookInput({ tool_name: "Edit", tool_input: { file_path: "m.js", old_string: "1", new_string: "2" } })!;
    runHookPre(s, "a", input);
    applyEdit(dir, "m.js", "1", "2");
    runHookPost(s, "a", input);
    runHookPost(s, "a", input); // snapshot already consumed
    assert.equal(readAuthorship(s).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- zero-config identity through the real CLI hook commands ----

test("hooks auto-name the actor from the Claude session id when QUILT_ACTOR is unset", () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const dir = mkdtempSync(join(tmpdir(), "quilt-autoactor-"));
  const g = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    g(["init", "-q"]);
    writeFileSync(join(dir, "m.js"), "function f() { return 1; }\n");
    g(["add", "-A"]);
    spawnSync("node", [CLI, "init"], { cwd: dir });

    // Claude Code always sends session_id in the hook payload. No QUILT_ACTOR.
    const env = { ...process.env } as Record<string, string>;
    delete env.QUILT_ACTOR;
    delete env.QUILT_SESSION;
    const payload = JSON.stringify({
      tool_name: "Edit",
      session_id: "deadbeef-1234-4abc-8def-000011112222",
      tool_input: { file_path: "m.js", old_string: "return 1;", new_string: "return 2;" },
    });
    const pre = spawnSync("node", [CLI, "hook-pre"], { cwd: dir, encoding: "utf8", input: payload, env });
    assert.equal(pre.status, 0, pre.stderr);
    writeFileSync(join(dir, "m.js"), "function f() { return 2; }\n");
    const post = spawnSync("node", [CLI, "hook-post"], { cwd: dir, encoding: "utf8", input: payload, env });
    assert.equal(post.status, 0, post.stderr);

    // The edit is captured, attributed to the derived per-session id.
    const s = new Store(dir);
    const ev = readAuthorship(s);
    assert.equal(ev.length, 1, "capture flowed with zero config");
    assert.equal(ev[0].actor, "claude-deadbeef");

    // An explicit QUILT_ACTOR still wins over the session id.
    const payload2 = JSON.stringify({
      tool_name: "Edit",
      session_id: "deadbeef-1234-4abc-8def-000011112222",
      tool_input: { file_path: "m.js", old_string: "return 2;", new_string: "return 3;" },
    });
    const env2 = { ...env, QUILT_ACTOR: "named-agent" };
    spawnSync("node", [CLI, "hook-pre"], { cwd: dir, encoding: "utf8", input: payload2, env: env2 });
    writeFileSync(join(dir, "m.js"), "function f() { return 3; }\n");
    spawnSync("node", [CLI, "hook-post"], { cwd: dir, encoding: "utf8", input: payload2, env: env2 });
    const ev2 = readAuthorship(s);
    assert.equal(ev2.length, 2);
    assert.equal(ev2[1].actor, "named-agent", "explicit id beats the auto id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- absolute-path payloads (what Claude Code actually sends) ----
//
// Real hook payloads carry an ABSOLUTE tool_input.file_path. Claims, ownership,
// and the ledger all key repo-relative, so the hooks must normalize — recording
// the absolute path verbatim made prevention never match a claim and capture
// flow into events reconcile could never use (the 0.4.x field bug).

test("hook-pre denies an absolute-path edit into another actor's claimed symbol", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "function held() {\n  return 1;\n}\n");
    acquireClaims(s, "alice", null, ["m.js#held"], Date.now(), "alice's change");
    const input: HookInput = {
      tool: "Edit",
      path: join(dir, "m.js"), // absolute, exactly like a real payload
      edits: [{ oldString: "return 1;", newString: "return 2;" }],
      content: null,
      sessionId: null,
    };
    const d = runHookPre(s, "bob", input);
    assert.equal(d.deny, true, "absolute path must still match the relative claim");
    assert.match(d.reason!, /m\.js#held/, "deny names the specific held symbol");
    assert.match(d.reason!, /alice's change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook capture with an absolute path records a repo-relative ledger event", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "function f() {\n  return 1;\n}\n");
    const input: HookInput = {
      tool: "Edit",
      path: join(dir, "m.js"),
      edits: [{ oldString: "return 1;", newString: "return 9;" }],
      content: null,
      sessionId: null,
    };
    assert.equal(runHookPre(s, "carol", input).deny, false);
    applyEdit(dir, "m.js", "return 1;", "return 9;");
    runHookPost(s, "carol", input);
    const ev = readAuthorship(s);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].path, "m.js", "ledger keys repo-relative, not absolute");
    assert.equal(ev[0].actor, "carol");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook Pre/Post agree when Pre sees an absolute path and Post a relative one", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "n.js"), "function g() {\n  return 1;\n}\n");
    const abs: HookInput = {
      tool: "Edit", path: join(dir, "n.js"),
      edits: [{ oldString: "return 1;", newString: "return 5;" }], content: null, sessionId: null,
    };
    runHookPre(s, "dave", abs);
    applyEdit(dir, "n.js", "return 1;", "return 5;");
    runHookPost(s, "dave", { ...abs, path: "n.js" }); // spelled differently — same snapshot
    assert.equal(readAuthorship(s).length, 1, "snapshot keyed on the normalized path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an absolute path through a filesystem alias (macOS /var -> /private/var) still normalizes", () => {
  const { s, dir } = newStore(); // dir is under os.tmpdir(), an alias on macOS
  try {
    const real = realpathSync(dir);
    writeFileSync(join(dir, "a.js"), "function h() {\n  return 1;\n}\n");
    const input: HookInput = {
      tool: "Edit",
      path: join(real, "a.js"), // the OTHER spelling of the same repo
      edits: [{ oldString: "return 1;", newString: "return 7;" }],
      content: null,
      sessionId: null,
    };
    assert.equal(runHookPre(s, "erin", input).deny, false);
    applyEdit(dir, "a.js", "return 1;", "return 7;");
    runHookPost(s, "erin", input);
    const ev = readAuthorship(s);
    assert.equal(ev.length, 1, "alias spelling still captures");
    assert.equal(ev[0].path, "a.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a payload path outside the repo is ignored, absolute or traversal", () => {
  const { s, dir } = newStore();
  try {
    const outside = mkdtempSync(join(tmpdir(), "quilt-outside-"));
    writeFileSync(join(outside, "x.js"), "function x() {}\n");
    for (const p of [join(outside, "x.js"), "../x.js"]) {
      const input: HookInput = {
        tool: "Edit", path: p,
        edits: [{ oldString: "a", newString: "b" }], content: null, sessionId: null,
      };
      assert.equal(runHookPre(s, "eve", input).deny, false);
      runHookPost(s, "eve", input);
    }
    assert.equal(readAuthorship(s).length, 0, "nothing outside the repo is captured");
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- subagent identity (the pilot bug) ----
//
// Subagents of one Claude Code session share its session_id, so without the
// payload's agent_id every parallel subagent collapses into ONE derived actor
// and their work merges — data-agent's commit swept ui-agent's files in the
// first real pilot. Two defenses, tested here: distinct per-subagent auto ids
// from agent_id, and claim ADOPTION so an auto-id edit inside claimed code is
// attributed to (not denied for) the claim's holder.

test("agentActorId derives distinct readable ids for parallel subagents", () => {
  assert.equal(agentActorId("f7e8d9c0", "code-reviewer"), "code-reviewer-f7e8d9c0");
  assert.equal(agentActorId("A1B2-C3D4-extra", null), "agent-a1b2c3d4");
  assert.equal(agentActorId("!!!", "x"), null);
  assert.notEqual(agentActorId("aaaa1111", "worker"), agentActorId("bbbb2222", "worker"));
});

test("parseHookInput carries agent_id/agent_type from a subagent payload", () => {
  const p = parseHookInput({
    tool_name: "Edit",
    session_id: "abc-123",
    agent_id: "f7e8d9c0",
    agent_type: "ui-builder",
    tool_input: { file_path: "m.js", old_string: "a", new_string: "b" },
  });
  assert.equal(p!.agentId, "f7e8d9c0");
  assert.equal(p!.agentType, "ui-builder");
});

test("adoption: an auto-id edit inside a claim is attributed to the holder, not denied", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "ui.ts"), "export function render() {\n  return 1;\n}\n");
    // ui-agent claimed via MCP under its role id; its native edit arrives at
    // the hook under a session/agent-derived id.
    acquireClaims(s, "ui-agent", null, ["ui.ts"], Date.now(), "build the UI");
    const input: HookInput = {
      tool: "Edit", path: join(dir, "ui.ts"),
      edits: [{ oldString: "return 1;", newString: "return 2;" }],
      content: null, sessionId: null, agentId: null, agentType: null,
    };
    // autoActor=true → adopted by the sole holder: allowed AND credited right.
    const d = runHookPre(s, "claude-abc12345", input, true);
    assert.equal(d.deny, false, "the holder's own subagent edit must not self-deny");
    applyEdit(dir, "ui.ts", "return 1;", "return 2;");
    runHookPost(s, "claude-abc12345", input, true);
    const ev = readAuthorship(s);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].actor, "ui-agent", "capture credits the claim holder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adoption never applies to an explicit identity — a named actor is still denied", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "ui.ts"), "export function render() {\n  return 1;\n}\n");
    acquireClaims(s, "ui-agent", null, ["ui.ts"], Date.now(), "build the UI");
    const input: HookInput = {
      tool: "Edit", path: join(dir, "ui.ts"),
      edits: [{ oldString: "return 1;", newString: "return 9;" }],
      content: null, sessionId: null, agentId: null, agentType: null,
    };
    const d = runHookPre(s, "data-agent", input, false);
    assert.equal(d.deny, true, "an explicit actor editing another's claim is a real collision");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adoption is ambiguous with two holders on the touched code — falls back to deny", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(
      join(dir, "two.ts"),
      "export function a() {\n  return 1;\n}\nexport function b() {\n  return 2;\n}\n",
    );
    acquireClaims(s, "agent-one", null, ["two.ts#a"], Date.now());
    acquireClaims(s, "agent-two", null, ["two.ts#b"], Date.now());
    const input: HookInput = {
      tool: "Write", path: join(dir, "two.ts"),
      edits: [], content: "export function c() {\n  return 3;\n}\n",
      sessionId: null, agentId: null, agentType: null,
    };
    const d = runHookPre(s, "claude-abc12345", input, true);
    assert.equal(d.deny, true, "two holders — no single actor to adopt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a captured edit refreshes the holder's claim TTL (long work never outlives its claim)", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "w.ts"), "export function work() {\n  return 1;\n}\n");
    const t0 = Date.now();
    acquireClaims(s, "worker", null, ["w.ts"], t0, "long task");
    const beforeExp = s.readClaims().claims[0]!.expiresAt;
    const input: HookInput = {
      tool: "Edit", path: "w.ts",
      edits: [{ oldString: "return 1;", newString: "return 2;" }],
      content: null, sessionId: null, agentId: null, agentType: null,
    };
    runHookPre(s, "worker", input);
    applyEdit(dir, "w.ts", "return 1;", "return 2;");
    runHookPost(s, "worker", input);
    const afterExp = s.readClaims().claims[0]!.expiresAt;
    assert.ok(afterExp >= beforeExp, "TTL refreshed by the captured edit");
    assert.ok(afterExp > t0, "claim still live");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the .quilt/current pointer never binds hook capture — `quilt start` does not own other agents' edits", () => {
  // Pilot root cause: .quilt/current is checkout-GLOBAL, so whoever ran
  // `quilt start` last owned every subsequent hook capture in the repo.
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const dir = mkdtempSync(join(tmpdir(), "quilt-ptr-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.io"]);
  g(["config", "user.name", "t"]);
  try {
    writeFileSync(join(dir, "f.js"), "function f() {\n  return 1;\n}\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    spawnSync("node", [CLI, "init"], { cwd: dir });
    // Someone starts a session — .quilt/current now points at "lastguy".
    spawnSync("node", [CLI, "start", "--actor", "lastguy"], { cwd: dir, encoding: "utf8" });

    // A DIFFERENT agent's native edit arrives carrying only a session id.
    const env = { ...process.env };
    delete env.QUILT_ACTOR;
    const payload = JSON.stringify({
      tool_name: "Edit",
      session_id: "beefcafe-1111-4abc-8def-000011112222",
      tool_input: { file_path: join(dir, "f.js"), old_string: "return 1;", new_string: "return 2;" },
    });
    spawnSync("node", [CLI, "hook-pre"], { cwd: dir, encoding: "utf8", input: payload, env });
    writeFileSync(join(dir, "f.js"), "function f() {\n  return 2;\n}\n");
    spawnSync("node", [CLI, "hook-post"], { cwd: dir, encoding: "utf8", input: payload, env });

    const log = readFileSync(join(dir, ".quilt", "authorship.log"), "utf8");
    assert.match(log, /"actor":"claude-beefcafe"/, "captured under the session-derived id");
    assert.doesNotMatch(log, /"actor":"lastguy"/, "the global pointer must not own the edit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Dogfood phase 7 "confirms #1": a REAL-symbol claim must bind an external
// (hook-captured) edit made under an ambient auto id — adoption at symbol
// granularity, not just whole-file. (The trap variant — a symbol that doesn't
// exist — is now denied at claim time.)
test("adoption binds a hook edit to a SYMBOL claim holder (real symbol, auto id)", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(
      join(dir, "projects.ts"),
      "export const create = () => {\n  return 1;\n};\nexport const remove = () => {\n  return 2;\n};\n",
    );
    acquireClaims(s, "convex-agent", null, ["projects.ts#create"], Date.now(), "WKO-23 create mutation");
    const input: HookInput = {
      tool: "Edit",
      path: join(dir, "projects.ts"),
      edits: [{ oldString: "return 1;", newString: "return 99;" }],
      content: null, sessionId: null, agentId: "ae0e1234", agentType: "general-purpose",
    };
    // Arrives under the ambient auto id (the exact phase-7 shape)…
    const d = runHookPre(s, "general-purpose-ae0e1234", input, true);
    assert.equal(d.deny, false, "the holder's own edit must not self-deny");
    applyEdit(dir, "projects.ts", "return 1;", "return 99;");
    runHookPost(s, "general-purpose-ae0e1234", input, true);
    const ev = readAuthorship(s);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.actor, "convex-agent", "symbol claim binds the capture to its holder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
