import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state.js";
import { acquireClaims } from "../src/claims.js";
import { initSymbols } from "../src/symbols.js";
import { readAuthorship } from "../src/authorship.js";
import { parseHookInput, runHookPre, runHookPost, type HookInput } from "../src/hooks.js";

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
  assert.deepEqual(p, { tool: "Edit", path: "m.js", edits: [{ oldString: "a", newString: "b" }], content: null });
});

test("parseHookInput accepts the alternate old_str/new_str/file_text spellings", () => {
  const edit = parseHookInput({ tool_name: "Edit", tool_input: { file_path: "m.js", old_str: "a", new_str: "b" } });
  assert.deepEqual(edit!.edits, [{ oldString: "a", newString: "b" }]);
  const write = parseHookInput({ tool_name: "Write", tool_input: { file_path: "m.js", file_text: "hi" } });
  assert.equal(write!.content, "hi");
});

test("parseHookInput handles a Write (content) and a MultiEdit (edits[])", () => {
  const w = parseHookInput({ tool_name: "Write", tool_input: { file_path: "m.js", content: "hello\n" } });
  assert.deepEqual(w, { tool: "Write", path: "m.js", edits: [], content: "hello\n" });
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
