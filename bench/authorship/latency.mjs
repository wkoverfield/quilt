// Latency benchmark — how much does Quilt add to an agent's loop?
//
// Context: an LLM turn is seconds; Quilt ops should be milliseconds. But two
// things could bite: (1) reconcile shells out to git per changed file, so it may
// scale with repo churn; (2) routing edits through quilt_edit adds a write+append
// vs a raw edit. This measures both so we know where (if anywhere) to optimize.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../../dist/state.js";
import { reconcile } from "../../dist/engine.js";
import { applyAndRecordEdit } from "../../dist/authorship.js";

function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), "quilt-lat-"));
  const g = (a) => execFileSync("git", a, { cwd: dir });
  g(["init", "-q"]); g(["config", "user.email", "t@t.io"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  return dir;
}
function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function timeIt(n, fn) { const ts = []; for (let i = 0; i < n; i++) { const t = performance.now(); fn(i); ts.push(performance.now() - t); } return median(ts); }

console.log("Quilt latency (median ms over repeated runs)\n");

// 1) quilt_edit capture cost vs a raw fs write
{
  const dir = tmpRepo();
  writeFileSync(join(dir, "f.js"), "let v = 0;\n");
  execFileSync("git", ["add", "-A"], { cwd: dir }); execFileSync("git", ["commit", "-qm", "i"], { cwd: dir });
  const s = new Store(dir); s.ensureDirs();
  let k = 0;
  const raw = timeIt(50, () => { writeFileSync(join(dir, "f.js"), `let v = ${k++};\n`); });
  let j = 1;
  const cap = timeIt(50, () => { applyAndRecordEdit(s, { actor: "x", path: "f.js", oldString: `let v = ${j - 1};`, newString: `let v = ${j};` }); j++; });
  console.log(`  raw fs write:            ${raw.toFixed(3)} ms`);
  console.log(`  quilt_edit (write+ledger): ${cap.toFixed(3)} ms   (overhead ${(cap - raw).toFixed(3)} ms/edit)`);
  rmSync(dir, { recursive: true, force: true });
}

// 2) reconcile latency vs number of changed files (the scaling concern)
console.log("\n  reconcile, by changed-file count:");
for (const N of [1, 10, 50, 150]) {
  const dir = tmpRepo();
  for (let i = 0; i < N; i++) writeFileSync(join(dir, `f${i}.js`), "export const a = 0;\n");
  execFileSync("git", ["add", "-A"], { cwd: dir }); execFileSync("git", ["commit", "-qm", "i"], { cwd: dir });
  const s = new Store(dir); s.ensureDirs();
  let r = 0;
  const t = timeIt(8, () => { for (let i = 0; i < N; i++) writeFileSync(join(dir, `f${i}.js`), `export const a = ${r};\n`); r++; reconcile(s, "x"); });
  console.log(`    ${String(N).padStart(3)} files: ${t.toFixed(1)} ms   (${(t / N).toFixed(2)} ms/file)`);
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n(For scale: a single LLM turn is typically 1000–10000 ms.)");
