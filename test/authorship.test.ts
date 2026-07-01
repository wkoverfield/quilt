import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state.js";
import { reconcile } from "../src/engine.js";
import { acquireClaims } from "../src/claims.js";
import { initSymbols } from "../src/symbols.js";

before(async () => {
  await initSymbols(); // prevention checks parse symbols to find the touched ones
});
import {
  computeDelta,
  recordAuthorship,
  readAuthorship,
  applyAndRecordEdit,
  applyAndRecordWrite,
} from "../src/authorship.js";

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "quilt-auth-"));
  const s = new Store(dir);
  s.ensureDirs();
  return { s, dir };
}

test("computeDelta extracts only genuinely added/removed lines from a payload", () => {
  const d = computeDelta("function f() {\n  return 1;\n}", "function f() {\n  return 2;\n}");
  assert.deepEqual(d.added, ["  return 2;"]);
  assert.deepEqual(d.removed, ["  return 1;"]);
});

test("recordAuthorship appends ordered events with payload-derived attribution", () => {
  const { s, dir } = newStore();
  try {
    recordAuthorship(s, { actor: "X", path: "m.js", oldText: "a\nb\n", newText: "a\nB\n", intent: "T-1" });
    recordAuthorship(s, { actor: "Y", path: "m.js", oldText: "a\nB\n", newText: "a\nB\nc\n" });
    const ev = readAuthorship(s);
    assert.equal(ev.length, 2);
    assert.deepEqual([ev[0]!.seq, ev[1]!.seq], [0, 1]);
    assert.equal(ev[0]!.actor, "X");
    assert.equal(ev[0]!.intent, "T-1");
    assert.deepEqual(ev[0]!.added, ["B"]);
    assert.equal(ev[1]!.actor, "Y");
    assert.deepEqual(ev[1]!.added, ["c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyAndRecordEdit writes the file AND captures the author in one step", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "export const limit = 100;\n");
    const r = applyAndRecordEdit(s, {
      actor: "perf",
      path: "m.js",
      oldString: "limit = 100",
      newString: "limit = 500",
      intent: "PERF-1: raise limit",
    });
    assert.ok(r.ok);
    assert.match(readFileSync(join(dir, "m.js"), "utf8"), /limit = 500/);
    const ev = readAuthorship(s);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.actor, "perf");
    assert.equal(ev[0]!.intent, "PERF-1: raise limit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyAndRecordEdit refuses a missing or non-unique old_string (no write, no event)", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "x = 1;\nx = 1;\n");
    const miss = applyAndRecordEdit(s, { actor: "a", path: "m.js", oldString: "nope", newString: "y" });
    assert.equal(miss.ok, false);
    const dup = applyAndRecordEdit(s, { actor: "a", path: "m.js", oldString: "x = 1;", newString: "x = 2;" });
    assert.equal(dup.ok, false); // ambiguous
    assert.equal(readAuthorship(s).length, 0, "no event recorded on a refused edit");
    assert.equal(readFileSync(join(dir, "m.js"), "utf8"), "x = 1;\nx = 1;\n", "file untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two actors editing one file are captured as distinct, correctly-attributed events", () => {
  // This is the core win: no inference, no timing race — each edit's author is
  // recorded at the edit, so X and Y never get confused even on a shared file.
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "function foo() {\n  return 0;\n}\nfunction bar() {\n  return 0;\n}\n");
    applyAndRecordEdit(s, { actor: "X", path: "m.js", oldString: "function foo() {\n  return 0;\n}", newString: "function foo() {\n  return 11;\n}" });
    applyAndRecordEdit(s, { actor: "Y", path: "m.js", oldString: "function bar() {\n  return 0;\n}", newString: "function bar() {\n  return 22;\n}" });
    const ev = readAuthorship(s);
    assert.equal(ev.length, 2);
    assert.deepEqual([ev[0]!.actor, ev[1]!.actor], ["X", "Y"]);
    assert.deepEqual(ev[0]!.added, ["  return 11;"]);
    assert.deepEqual(ev[1]!.added, ["  return 22;"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("anchor is the surviving line just BEFORE the edit region (for replay)", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "m.js"), "const head = 1;\nconst target = 2;\nconst tail = 3;\n");
    const r = applyAndRecordEdit(s, { actor: "a", path: "m.js", oldString: "const target = 2;", newString: "const target = 9;" });
    assert.ok(r.ok);
    assert.equal(readAuthorship(s)[0]!.anchor, "const head = 1;", "anchor = the line above the change, not the changed line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit/write refuse to escape the repo (actor-controlled path)", () => {
  const { s, dir } = newStore();
  try {
    const w = applyAndRecordWrite(s, { actor: "a", path: "../escape.js", content: "x" });
    assert.equal(w.ok, false);
    writeFileSync(join(dir, "ok.js"), "a = 1;\n");
    const e = applyAndRecordEdit(s, { actor: "a", path: "../../escape.js", oldString: "a", newString: "b" });
    assert.equal(e.ok, false);
    assert.equal(readAuthorship(s).length, 0, "no event recorded for an escaping path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger overrides inference in reconcile: a captured edit keeps its author even when another actor reconciles first (the misattribution hole, closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "quilt-auth-recon-"));
  const g = (a: string[]) => execFileSync("git", a, { cwd: dir });
  g(["init", "-q"]); g(["config", "user.email", "t@t.io"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "m.js"), "export const limit = 100;\n");
  g(["add", "-A"]); g(["commit", "-qm", "i"]);
  const s = new Store(dir);
  s.ensureDirs();
  try {
    // X edits through quilt_edit (captured), and does NOT run any quilt command.
    applyAndRecordEdit(s, { actor: "X", path: "m.js", oldString: "limit = 100", newString: "limit = 500", intent: "PERF" });
    // Y reconciles first — under pure inference this would credit X's line to Y.
    reconcile(s, "Y");
    const own = s.readOwnership();
    assert.equal(
      own.files["m.js"]?.added["export const limit = 500;"],
      "X",
      "the ledger keeps X as the author despite Y reconciling first",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prevention: an edit to a symbol another actor holds is DENIED with their intent (no write)", () => {
  const dir = mkdtempSync(join(tmpdir(), "quilt-prev-"));
  const s = new Store(dir);
  s.ensureDirs();
  try {
    const src = "function foo() {\n  return 0;\n}\nfunction bar() {\n  return 0;\n}\n";
    writeFileSync(join(dir, "m.js"), src);
    acquireClaims(s, "Y", null, ["m.js#foo"], Date.now(), "PERF-1: refactor foo");

    // X tries to edit foo (held by Y) -> denied, with Y's intent.
    const denied = applyAndRecordEdit(s, { actor: "X", path: "m.js", oldString: "function foo() {\n  return 0;\n}", newString: "function foo() {\n  return 9;\n}" });
    assert.equal(denied.ok, false);
    assert.ok("heldBy" in denied && denied.heldBy === "Y");
    assert.ok("holderIntent" in denied && denied.holderIntent === "PERF-1: refactor foo");
    assert.equal(readFileSync(join(dir, "m.js"), "utf8"), src, "file untouched on denial");
    assert.equal(readAuthorship(s).length, 0, "no event on a denied edit");

    // X edits bar (free) -> allowed and captured.
    const okEdit = applyAndRecordEdit(s, { actor: "X", path: "m.js", oldString: "function bar() {\n  return 0;\n}", newString: "function bar() {\n  return 7;\n}" });
    assert.ok(okEdit.ok);
    assert.equal(readAuthorship(s)[0]!.actor, "X");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prevention: a whole-file write that would remove a claimed symbol is DENIED", () => {
  const dir = mkdtempSync(join(tmpdir(), "quilt-prevw-"));
  const s = new Store(dir);
  s.ensureDirs();
  try {
    writeFileSync(join(dir, "m.js"), "function foo() {\n  return 0;\n}\nfunction bar() {\n  return 0;\n}\n");
    acquireClaims(s, "Y", null, ["m.js#foo"], Date.now(), "owns foo");
    // X overwrites the file WITHOUT foo — must still be denied (removing held code).
    const r = applyAndRecordWrite(s, { actor: "X", path: "m.js", content: "function bar() {\n  return 9;\n}\n" });
    assert.equal(r.ok, false);
    assert.ok("heldBy" in r && r.heldBy === "Y");
    assert.match(readFileSync(join(dir, "m.js"), "utf8"), /function foo/, "held code not deleted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyAndRecordWrite captures a whole-file create", () => {
  const { s, dir } = newStore();
  try {
    const r = applyAndRecordWrite(s, { actor: "Z", path: "new.js", content: "export const x = 1;\n", intent: "FEAT-1" });
    assert.ok(r.ok);
    assert.equal(readFileSync(join(dir, "new.js"), "utf8"), "export const x = 1;\n");
    const ev = readAuthorship(s);
    assert.equal(ev[0]!.actor, "Z");
    assert.equal(ev[0]!.whole, true);
    assert.deepEqual(ev[0]!.added, ["export const x = 1;"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
