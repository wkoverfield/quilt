import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/state.js";
import { foldedAuthorship, readAuthorship, recordAuthorship } from "../src/authorship.js";
import { dirtyActors } from "../src/gitguard.js";
import {
  BASH_CAPTURE_MAX_FILES,
  baselinePath,
  captureBashDelta,
  sweepStaleBaselines,
  writeBashBaseline,
} from "../src/bashcapture.js";

function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), "quilt-bashcap-"));
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "tracked.txt"), "original line\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "base"]);
  const store = new Store(dir);
  store.ensureDirs();
  store.writeConfig({ version: 1, createdAt: new Date().toISOString() });
  store.writeObserved({ files: {} });
  store.writeOwnership({ files: {}, conflicts: {} });
  return { dir, store, run };
}

test("a new file written between Pre and Post is attributed to the actor, mode bash", () => {
  const { dir, store } = newRepo();
  writeBashBaseline(store, "bash-actor", "inv-1");
  writeFileSync(join(dir, "made-by-heredoc.txt"), "line one\nline two\n");
  const result = captureBashDelta(store, "bash-actor", "inv-1");
  assert.deepEqual(result.captured, ["made-by-heredoc.txt"]);
  const events = readAuthorship(store);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actor, "bash-actor");
  assert.equal(events[0]!.mode, "bash");
  assert.deepEqual(events[0]!.added, ["line one", "line two"]);
  // The census now sees this actor.
  assert.deepEqual(dirtyActors(store), ["bash-actor"]);
});

test("a tracked file modified via bash diffs against HEAD, not empty", () => {
  const { dir, store } = newRepo();
  writeBashBaseline(store, "a", "inv-2");
  writeFileSync(join(dir, "tracked.txt"), "original line\nappended by sed\n");
  captureBashDelta(store, "a", "inv-2");
  const ev = readAuthorship(store)[0]!;
  assert.deepEqual(ev.added, ["appended by sed"]);
  assert.deepEqual(ev.removed, []);
});

test("a file already dirty before the call diffs against the baseline snapshot", () => {
  const { dir, store } = newRepo();
  writeFileSync(join(dir, "tracked.txt"), "original line\npre-existing dirt\n");
  writeBashBaseline(store, "a", "inv-3");
  writeFileSync(join(dir, "tracked.txt"), "original line\npre-existing dirt\nnew from this call\n");
  captureBashDelta(store, "a", "inv-3");
  const ev = readAuthorship(store)[0]!;
  // Only the line THIS call added — the pre-existing dirt is not swept in.
  assert.deepEqual(ev.added, ["new from this call"]);
});

test("files untouched by the call are not attributed", () => {
  const { dir, store } = newRepo();
  writeFileSync(join(dir, "someone-elses.txt"), "their dirty work\n");
  writeBashBaseline(store, "a", "inv-4");
  writeFileSync(join(dir, "mine.txt"), "my write\n");
  const result = captureBashDelta(store, "a", "inv-4");
  assert.deepEqual(result.captured, ["mine.txt"]);
  const events = readAuthorship(store);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.path, "mine.txt");
});

test("a deletion is captured as removed lines", () => {
  const { dir, store, run } = newRepo();
  writeBashBaseline(store, "a", "inv-5");
  rmSync(join(dir, "tracked.txt"));
  captureBashDelta(store, "a", "inv-5");
  const ev = readAuthorship(store)[0]!;
  assert.deepEqual(ev.removed, ["original line"]);
  assert.deepEqual(ev.added, []);
  void run;
});

test("the baseline is consumed exactly once and a missing baseline no-ops", () => {
  const { dir, store } = newRepo();
  writeBashBaseline(store, "a", "inv-6");
  assert.ok(existsSync(baselinePath(store, "a", "inv-6")));
  writeFileSync(join(dir, "x.txt"), "x\n");
  captureBashDelta(store, "a", "inv-6");
  assert.ok(!existsSync(baselinePath(store, "a", "inv-6")));
  const again = captureBashDelta(store, "a", "inv-6");
  assert.deepEqual(again.captured, []);
  assert.equal(readAuthorship(store).length, 1);
});

test("interleaved actors with separate invocations do not consume each other's baselines", () => {
  const { dir, store } = newRepo();
  writeBashBaseline(store, "actor-a", "inv-a");
  writeBashBaseline(store, "actor-b", "inv-b");
  writeFileSync(join(dir, "a-file.txt"), "by a\n");
  const ra = captureBashDelta(store, "actor-a", "inv-a");
  assert.deepEqual(ra.captured, ["a-file.txt"]);
  // B's baseline predates A's write, so B's post would see a-file changed too:
  // the documented window. But B's own delta here is computed from B's OWN
  // baseline — the manifests never cross.
  writeFileSync(join(dir, "b-file.txt"), "by b\n");
  const rb = captureBashDelta(store, "actor-b", "inv-b");
  assert.ok(rb.captured.includes("b-file.txt"));
  const fold = foldedAuthorship(store);
  assert.equal(fold.get("a-file.txt")?.size, 1);
});

test("capture skips above the file cap and reports it", () => {
  const { dir, store } = newRepo();
  for (let i = 0; i < BASH_CAPTURE_MAX_FILES + 1; i++) {
    writeFileSync(join(dir, `bulk-${i}.txt`), `${i}\n`);
  }
  const baseline = writeBashBaseline(store, "a", "inv-7");
  assert.ok(baseline.skipped, "cap should trigger a skip");
  writeFileSync(join(dir, "one-more.txt"), "z\n");
  const result = captureBashDelta(store, "a", "inv-7");
  assert.equal(result.captured.length, 0);
  assert.ok(result.skipped);
  assert.equal(readAuthorship(store).length, 0);
});

test("binary content is change-detected but never line-attributed", () => {
  const { dir, store } = newRepo();
  writeBashBaseline(store, "a", "inv-8");
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x00, 0x1a]));
  const result = captureBashDelta(store, "a", "inv-8");
  assert.deepEqual(result.captured, []);
  assert.equal(readAuthorship(store).length, 0);
});

test("a natively-captured edit during the call is not shadowed by the bash delta", () => {
  const { dir, store } = newRepo();
  writeBashBaseline(store, "bash-actor", "inv-shadow");
  // Sibling's native Edit lands mid-call and is captured exactly.
  writeFileSync(join(dir, "sibling.txt"), "native line\n");
  recordAuthorship(store, { actor: "native-actor", path: "sibling.txt", oldText: "", newText: "native line\n", whole: true });
  // The bash call itself writes a different file.
  writeFileSync(join(dir, "bash-file.txt"), "bash line\n");
  const result = captureBashDelta(store, "bash-actor", "inv-shadow");
  assert.deepEqual(result.captured, ["bash-file.txt"], "the natively-captured path is skipped");
  const fold = foldedAuthorship(store);
  const siblingOwners = new Set(fold.get("sibling.txt")?.values());
  assert.deepEqual([...siblingOwners], ["native-actor"], "exact attribution survives");
});

test("overlapping same-key baselines: first call wins, second goes dark instead of wrong", () => {
  const { dir, store } = newRepo();
  writeFileSync(join(dir, "tracked.txt"), "original line\ndirt before first call\n");
  const first = writeBashBaseline(store, "a", "same-key");
  // Second Pre with the identical fallback key must NOT overwrite the baseline.
  writeFileSync(join(dir, "tracked.txt"), "original line\ndirt before first call\nfirst call wrote this\n");
  const second = writeBashBaseline(store, "a", "same-key");
  assert.deepEqual(second, first, "existing baseline is returned, not replaced");
  const result = captureBashDelta(store, "a", "same-key");
  assert.deepEqual(result.captured, ["tracked.txt"]);
  const ev = readAuthorship(store)[0]!;
  assert.deepEqual(ev.added, ["first call wrote this"], "diffed against the FIRST call's reference state");
});

test("unchanged dirty files are skipped via lstat without content comparison", () => {
  const { dir, store } = newRepo();
  writeFileSync(join(dir, "untouched.txt"), "dirty but stable\n");
  writeBashBaseline(store, "a", "inv-lstat");
  const result = captureBashDelta(store, "a", "inv-lstat");
  assert.deepEqual(result.captured, [], "no-op call attributes nothing");
  assert.equal(readAuthorship(store).length, 0);
});

test("stale baselines are swept after the TTL", () => {
  const { store } = newRepo();
  writeBashBaseline(store, "a", "inv-dead");
  const p = baselinePath(store, "a", "inv-dead");
  assert.ok(existsSync(p));
  const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(p, old, old);
  sweepStaleBaselines(store);
  assert.ok(!existsSync(p));
});
