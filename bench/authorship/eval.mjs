// Authorship-capture eval harness — A vs B vs C.
//
//   A — Labeled-Write Ledger: capture each edit's old->new payload at the tool
//       boundary; reconcile = replay. Precise (per-edit), but edits that bypass
//       the tool (raw bash) are NOT captured — they fall to a SURFACED "unknown"
//       (never silently miscredited).
//   B — Run-boundary capture: snapshot the tree per `quilt run <actor>` and diff.
//       Captures ANY edit method (incl. bash), but coarse: two actors editing the
//       same file in overlapping run windows can't be separated -> misattribution.
//   C — status quo: infer on reconcile (the real Quilt CLI).
//
// Scored against known ground truth. Buckets: correct / misattributed (silently
// credited to the WRONG actor — the dangerous failure) / uncredited (left to a
// human, surfaced — the safe gap).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newLedger, recordEdit, ownershipFromLedger, applyEdit } from "./ledger.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js");
const trivial = (t) => { const s = t.trim(); return s === "" || /^[{}()\[\];,]+$/.test(s) || s === "});" || s === "})"; };
function splitLines(s) { const o = s.split("\n"); if (o.length && o[o.length - 1] === "") o.pop(); return o; }
function firstSpan(buf, needle) { for (let i = 0; i + needle.length <= buf.length; i++) { if (needle.every((t, j) => buf[i + j].text === t)) return i; } return buf.length; }

const SCENARIOS = [
  {
    name: "1. silent concurrent edits, different functions, same file",
    seed: { "m.js": "function foo() {\n  return 0;\n}\nfunction bar() {\n  return 0;\n}\n" },
    ops: [
      { actor: "X", path: "m.js", old: "function foo() {\n  return 0;\n}", new: "function foo() {\n  return 11;\n}", reconcileC: false },
      { actor: "Y", path: "m.js", old: "function bar() {\n  return 0;\n}", new: "function bar() {\n  return 22;\n}", reconcileC: true },
    ],
  },
  {
    name: "2. identical line added in two different places",
    seed: { "m.js": "function foo() {\n}\nfunction bar() {\n}\n" },
    ops: [
      { actor: "X", path: "m.js", old: "function foo() {\n}", new: "function foo() {\n  return null;\n}", reconcileC: true },
      { actor: "Y", path: "m.js", old: "function bar() {\n}", new: "function bar() {\n  return null;\n}", reconcileC: true },
    ],
  },
  {
    name: "3. rapid interleave, neither reconciles until the end",
    seed: { "m.js": "const a = 0;\nconst b = 0;\nconst c = 0;\n" },
    ops: [
      { actor: "X", path: "m.js", old: "const a = 0;", new: "const a = 1;", reconcileC: false },
      { actor: "Y", path: "m.js", old: "const b = 0;", new: "const b = 2;", reconcileC: false },
      { actor: "X", path: "m.js", old: "const c = 0;", new: "const c = 3;", reconcileC: false },
      { actor: "Y", path: "m.js", old: null, new: null, reconcileC: true, noop: true },
    ],
  },
  {
    name: "4. bash-written silent edit (A's blind spot) + a tool edit",
    seed: { "m.js": "const a = 0;\nconst b = 0;\n" },
    ops: [
      { actor: "X", path: "m.js", old: "const a = 0;", new: "const a = 1;", reconcileC: false, via: "bash" },
      { actor: "Y", path: "m.js", old: "const b = 0;", new: "const b = 2;", reconcileC: true },
    ],
  },
  {
    name: "5. two actors edit the same file concurrently (B's blind spot)",
    seed: { "m.js": "const a = 0;\nconst b = 0;\n" },
    ops: [
      { actor: "X", path: "m.js", old: "const a = 0;", new: "const a = 1;", reconcileC: true },
      { actor: "Y", path: "m.js", old: "const b = 0;", new: "const b = 2;", reconcileC: true },
    ],
    bConcurrent: true, bWinner: "Y", // one shared run window -> B can't separate the two actors
  },
];

function groundTruth(scn) {
  const bufs = {};
  for (const [p, c] of Object.entries(scn.seed)) bufs[p] = splitLines(c).map((text) => ({ text, author: null }));
  for (const op of scn.ops) { if (op.noop) continue; bufs[op.path] = applyEdit(bufs[op.path], splitLines(op.old), splitLines(op.new), op.actor); }
  return bufs;
}

// A: ledger replay; bash edits are NOT captured (left author:null = surfaced/uncredited, never guessed).
function runA(scn) {
  const led = newLedger();
  for (const op of scn.ops) { if (op.noop || op.via === "bash") continue; recordEdit(led, op.actor, op.path, op.old, op.new, op.actor + "-intent"); }
  return ownershipFromLedger(led, scn.seed);
}

// B: run-boundary tree-diff. Captures every edit method. For non-overlapping runs
// it attributes each op's delta to its actor; for one shared concurrent window it
// can't separate the actors -> the window's closer (bWinner) gets the whole delta.
function runB(scn) {
  const bufs = {};
  for (const [p, c] of Object.entries(scn.seed)) bufs[p] = splitLines(c).map((text) => ({ text, author: null }));
  for (const op of scn.ops) {
    if (op.noop) continue;
    const who = scn.bConcurrent ? scn.bWinner : op.actor;
    bufs[op.path] = applyEdit(bufs[op.path], splitLines(op.old), splitLines(op.new), who);
  }
  return bufs;
}

// C: drive the real Quilt CLI (fleet path, per-call actor). bash vs tool is the
// same to C — it diffs the tree on reconcile regardless of edit method.
function runC(scn) {
  const dir = mkdtempSync(join(tmpdir(), "authC-"));
  const g = (a) => execFileSync("git", a, { cwd: dir });
  g(["init", "-q"]); g(["config", "user.email", "t@t.io"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  const cur = {};
  for (const [p, c] of Object.entries(scn.seed)) { writeFileSync(join(dir, p), c); cur[p] = splitLines(c); }
  g(["add", "-A"]); g(["commit", "-q", "-m", "seed"]);
  execFileSync("node", [CLI, "init"], { cwd: dir });
  const quilt = (args, actor) => { try { execFileSync("node", [CLI, ...args], { cwd: dir, env: { ...process.env, QUILT_ACTOR: actor } }); } catch {} };
  for (const op of scn.ops) {
    if (!op.noop) {
      const buf = cur[op.path];
      const at = firstSpan(buf.map((text) => ({ text })), splitLines(op.old));
      buf.splice(at, splitLines(op.old).length, ...splitLines(op.new));
      writeFileSync(join(dir, op.path), buf.join("\n") + "\n");
    }
    if (op.reconcileC) quilt(["status"], op.actor);
  }
  const own = {};
  const op = join(dir, ".quilt", "ownership.json");
  if (existsSync(op)) { const j = JSON.parse(readFileSync(op, "utf8")); for (const [p, f] of Object.entries(j.files || {})) own[p] = f.added || {}; }
  rmSync(dir, { recursive: true, force: true });
  const pred = {};
  for (const [p] of Object.entries(scn.seed)) pred[p] = cur[p].map((text) => ({ text, author: own[p]?.[text] ?? null }));
  return pred;
}

function score(truthBufs, predBufs) {
  let correct = 0, misattributed = 0, uncredited = 0, total = 0;
  for (const [p, tbuf] of Object.entries(truthBufs)) {
    const pred = predBufs[p] || [];
    for (let i = 0; i < tbuf.length; i++) {
      const t = tbuf[i];
      if (t.author === null || trivial(t.text)) continue;
      total++;
      const pAuthor = pred[i]?.text === t.text ? pred[i].author : (pred.find((x) => x.text === t.text)?.author ?? null);
      if (pAuthor === t.author) correct++;
      else if (pAuthor == null || pAuthor === "?") uncredited++;
      else misattributed++;
    }
  }
  return { total, correct, misattributed, uncredited };
}

console.log("Authorship-capture eval — A (ledger) vs B (run-boundary) vs C (status quo)\n");
const agg = { A: {}, B: {}, C: {} };
for (const k of ["A", "B", "C"]) agg[k] = { total: 0, correct: 0, misattributed: 0, uncredited: 0 };
for (const scn of SCENARIOS) {
  const truth = groundTruth(scn);
  const res = { A: score(truth, runA(scn)), B: score(truth, runB(scn)), C: score(truth, runC(scn)) };
  for (const k of ["A", "B", "C"]) for (const m of ["total", "correct", "misattributed", "uncredited"]) agg[k][m] += res[k][m];
  console.log(scn.name + `   (${res.A.total} authored lines)`);
  for (const k of ["A", "B", "C"]) console.log(`   ${k}:  correct ${res[k].correct}  misattributed ${res[k].misattributed}  uncredited ${res[k].uncredited}`);
  console.log();
}
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
console.log("=== TOTALS (misattributed = silent wrong credit; uncredited = surfaced for a human) ===");
for (const [k, label] of [["A", "A ledger        "], ["B", "B run-boundary  "], ["C", "C status quo    "]]) {
  const a = agg[k];
  console.log(`${label}: ${a.correct}/${a.total} correct (${pct(a.correct, a.total)}%)  ·  ${a.misattributed} misattributed  ·  ${a.uncredited} uncredited`);
}
