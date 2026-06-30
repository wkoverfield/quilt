// Authorship-capture eval harness.
//
// Drives identical edit sequences through two capture strategies and scores each
// against KNOWN ground truth (the harness records who authored each line as it
// applies the edits):
//   A — Labeled-Write Ledger (capture at the edit, prototype in ledger.mjs)
//   C — status quo (the real Quilt CLI: infer authorship on reconcile)
//
// The scenarios are the ones that expose the core problem: silent concurrent
// edits, identical lines, the fleet "first-reconcile-wins" race.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newLedger, recordEdit, ownershipFromLedger, applyEdit } from "./ledger.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js");

const trivial = (t) => {
  const s = t.trim();
  return s === "" || /^[{}()\[\];,]+$/.test(s) || s === "});" || s === "})";
};
function splitLines(s) {
  const o = s.split("\n");
  if (o.length && o[o.length - 1] === "") o.pop();
  return o;
}

// --- scenarios -------------------------------------------------------------
// Each op: { actor, path, old, new, reconcileC } — reconcileC=true means in the
// status-quo run this actor runs a quilt command after its edit (captures its
// delta). A always captures at the edit, so reconcileC is irrelevant to A.
const SCENARIOS = [
  {
    name: "1. silent concurrent edits, different functions, same file",
    seed: { "m.js": "function foo() {\n  return 0;\n}\nfunction bar() {\n  return 0;\n}\n" },
    ops: [
      // X edits foo and goes silent (never calls quilt)
      { actor: "X", path: "m.js", old: "function foo() {\n  return 0;\n}", new: "function foo() {\n  return 11;\n}", reconcileC: false },
      // Y edits bar and reconciles -> in C, Y's reconcile sweeps X's silent line
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
      // only Y ever runs a quilt command, at the very end -> C attributes all to Y
      { actor: "Y", path: "m.js", old: null, new: null, reconcileC: true, noop: true },
    ],
  },
];

// --- ground truth: apply edits, tagging new lines with their editor ---------
function groundTruth(scn) {
  const bufs = {};
  for (const [p, c] of Object.entries(scn.seed)) bufs[p] = splitLines(c).map((text) => ({ text, author: null }));
  for (const op of scn.ops) {
    if (op.noop) continue;
    // Same authorship logic as the ledger: only genuinely-changed lines are the
    // actor's; context lines keep prior authorship.
    bufs[op.path] = applyEdit(bufs[op.path], splitLines(op.old), splitLines(op.new), op.actor);
  }
  return bufs;
}
function firstSpan(buf, needle) {
  for (let i = 0; i + needle.length <= buf.length; i++) {
    if (needle.every((t, j) => buf[i + j].text === t)) return i;
  }
  return buf.length;
}

// --- path A: replay through the ledger -------------------------------------
function runA(scn) {
  const led = newLedger();
  for (const op of scn.ops) {
    if (op.noop) continue;
    recordEdit(led, op.actor, op.path, op.old, op.new, op.actor + "-intent");
  }
  return ownershipFromLedger(led, scn.seed);
}

// --- path C: drive the real Quilt CLI (fleet path, per-call actor) ----------
function runC(scn) {
  const dir = mkdtempSync(join(tmpdir(), "authC-"));
  const g = (a) => execFileSync("git", a, { cwd: dir });
  g(["init", "-q"]); g(["config", "user.email", "t@t.io"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  const cur = {};
  for (const [p, c] of Object.entries(scn.seed)) { writeFileSync(join(dir, p), c); cur[p] = splitLines(c); }
  g(["add", "-A"]); g(["commit", "-q", "-m", "seed"]);
  execFileSync("node", [CLI, "init"], { cwd: dir });
  const quilt = (args, actor) => {
    try { execFileSync("node", [CLI, ...args], { cwd: dir, env: { ...process.env, QUILT_ACTOR: actor } }); } catch {}
  };
  for (const op of scn.ops) {
    if (!op.noop) {
      const buf = cur[op.path];
      const at = firstSpan(buf.map((text) => ({ text })), splitLines(op.old));
      buf.splice(at, splitLines(op.old).length, ...splitLines(op.new));
      writeFileSync(join(dir, op.path), buf.join("\n") + "\n");
    }
    if (op.reconcileC) quilt(["status"], op.actor);
  }
  // read ownership.json -> { path: {lineText: actor} }
  const own = {};
  const op = join(dir, ".quilt", "ownership.json");
  if (existsSync(op)) {
    const j = JSON.parse(readFileSync(op, "utf8"));
    for (const [p, f] of Object.entries(j.files || {})) own[p] = f.added || {};
  }
  rmSync(dir, { recursive: true, force: true });
  // map final lines -> predicted actor
  const pred = {};
  for (const [p] of Object.entries(scn.seed)) {
    pred[p] = cur[p].map((text) => ({ text, author: own[p]?.[text] ?? null }));
  }
  return pred;
}

// --- scoring ---------------------------------------------------------------
function score(truthBufs, predBufs) {
  let correct = 0, misattributed = 0, lost = 0, total = 0;
  for (const [p, tbuf] of Object.entries(truthBufs)) {
    const pred = predBufs[p] || [];
    // align by position over the final file (both derived from same final content)
    for (let i = 0; i < tbuf.length; i++) {
      const t = tbuf[i];
      if (t.author === null || trivial(t.text)) continue; // only score authored, non-trivial lines
      total++;
      const pAuthor = pred[i]?.text === t.text ? pred[i].author : (pred.find((x) => x.text === t.text)?.author ?? null);
      if (pAuthor === t.author) correct++;
      else if (pAuthor == null) lost++;
      else misattributed++;
    }
  }
  return { total, correct, misattributed, lost };
}

// --- run -------------------------------------------------------------------
console.log("Authorship-capture eval — A (Labeled-Write Ledger) vs C (status quo)\n");
const agg = { A: { total: 0, correct: 0, misattributed: 0, lost: 0 }, C: { total: 0, correct: 0, misattributed: 0, lost: 0 } };
for (const scn of SCENARIOS) {
  const truth = groundTruth(scn);
  const a = score(truth, runA(scn));
  const c = score(truth, runC(scn));
  for (const k of ["total", "correct", "misattributed", "lost"]) { agg.A[k] += a[k]; agg.C[k] += c[k]; }
  console.log(`${scn.name}`);
  console.log(`   ground-truth authored lines: ${a.total}`);
  console.log(`   A:  correct ${a.correct}  misattributed ${a.misattributed}  lost ${a.lost}`);
  console.log(`   C:  correct ${c.correct}  misattributed ${c.misattributed}  lost ${c.lost}\n`);
}
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
console.log("=== TOTALS ===");
console.log(`A (ledger):  ${agg.A.correct}/${agg.A.total} correct (${pct(agg.A.correct, agg.A.total)}%)  ·  ${agg.A.misattributed} misattributed  ·  ${agg.A.lost} lost`);
console.log(`C (status quo): ${agg.C.correct}/${agg.C.total} correct (${pct(agg.C.correct, agg.C.total)}%)  ·  ${agg.C.misattributed} misattributed  ·  ${agg.C.lost} lost`);
