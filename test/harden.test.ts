import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "dist", "cli.js");

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-harden-"));
  const g = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "test@quilt.local"]);
  g(["config", "user.name", "Quilt Test"]);
  g(["config", "commit.gpgsign", "false"]);
  return dir;
}
function commitAll(dir: string, msg: string): void {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", msg], { cwd: dir, encoding: "utf8" });
}
function quilt(dir: string, args: string[], actor?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (actor) env.QUILT_ACTOR = actor;
  const res = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
function write(dir: string, rel: string, content: string): void {
  writeFileSync(join(dir, rel), content);
}
function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), "utf8");
}
function gitOut(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}
function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
function setup(dir: string, actor = "alice"): void {
  quilt(dir, ["init"]);
  quilt(dir, ["start", "--actor", actor, "--type", "agent"]);
}

test("commit --mine commits a file deletion", () => {
  const dir = makeRepo();
  try {
    write(dir, "a.txt", "one\n");
    write(dir, "b.txt", "keep\n");
    commitAll(dir, "init");
    setup(dir);
    rmSync(join(dir, "a.txt"));
    quilt(dir, ["status"], "alice");
    const r = quilt(dir, ["commit", "--mine", "-m", "drop a"], "alice");
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(
      spawnSync("git", ["cat-file", "-e", "HEAD:a.txt"], { cwd: dir }).status,
      0,
      "a.txt gone from HEAD",
    );
    assert.equal(gitOut(dir, ["show", "HEAD:b.txt"]), "keep", "b.txt untouched");
  } finally {
    cleanup(dir);
  }
});

test("partial-file: alice commits her hunk, bob's hunk stays in the tree", () => {
  const dir = makeRepo();
  try {
    write(dir, "shared.ts", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);

    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    write(dir, "shared.ts", "l1\nl2-alice\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
    quilt(dir, ["status"], "alice");

    quilt(dir, ["start", "--actor", "bob", "--type", "agent"]);
    write(dir, "shared.ts", "l1\nl2-alice\nl3\nl4\nl5\nl6\nl7\nl8\nl9-bob\nl10\n");
    quilt(dir, ["status"], "bob");

    const r = quilt(dir, ["commit", "--mine", "-m", "alice line"], "alice");
    assert.equal(r.status, 0, r.stderr);

    const head = gitOut(dir, ["show", "HEAD:shared.ts"]);
    assert.match(head, /l2-alice/, "alice's hunk committed");
    assert.doesNotMatch(head, /l9-bob/, "bob's hunk NOT committed");
    assert.match(read(dir, "shared.ts"), /l9-bob/, "bob's hunk still in working tree");
  } finally {
    cleanup(dir);
  }
});

test("no-trailing-newline file round-trips through commit --mine", () => {
  const dir = makeRepo();
  try {
    write(dir, "nonl.txt", "a\nb"); // no trailing newline
    commitAll(dir, "init");
    setup(dir);
    write(dir, "nonl.txt", "a\nb\nc"); // still no trailing newline
    quilt(dir, ["status"], "alice");
    const r = quilt(dir, ["commit", "--mine", "-m", "add c"], "alice");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(gitOut(dir, ["show", "HEAD:nonl.txt"]), "a\nb\nc");
    assert.equal(gitOut(dir, ["status", "--porcelain"]), "", "clean after commit");
  } finally {
    cleanup(dir);
  }
});

test("commit --mine preserves the executable bit on a new file", () => {
  const dir = makeRepo();
  try {
    write(dir, "seed.txt", "x\n");
    commitAll(dir, "init");
    setup(dir);
    write(dir, "run.sh", "#!/bin/sh\necho hi\n");
    chmodSync(join(dir, "run.sh"), 0o755);
    quilt(dir, ["status"], "alice");
    const r = quilt(dir, ["commit", "--mine", "-m", "add script"], "alice");
    assert.equal(r.status, 0, r.stderr);
    const mode = gitOut(dir, ["ls-tree", "HEAD", "--", "run.sh"]).split(/\s+/)[0];
    assert.equal(mode, "100755", "executable bit preserved in HEAD");
  } finally {
    cleanup(dir);
  }
});

test("partial commit of a no-trailing-newline file does not corrupt the patch", () => {
  const dir = makeRepo();
  try {
    // 14 lines, NO trailing newline. Alice edits line 2, Bob the EOF line —
    // far enough apart to be separate hunks.
    const base = Array.from({ length: 14 }, (_, i) => `l${i + 1}`);
    write(dir, "f.ts", base.join("\n")); // no trailing newline
    commitAll(dir, "init");
    quilt(dir, ["init"]);

    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    const a = [...base];
    a[1] = "l2-alice";
    write(dir, "f.ts", a.join("\n"));
    quilt(dir, ["status"], "alice");

    quilt(dir, ["start", "--actor", "bob", "--type", "agent"]);
    const ab = [...a];
    ab[13] = "l14-bob"; // EOF line, still no trailing newline
    write(dir, "f.ts", ab.join("\n"));
    quilt(dir, ["status"], "bob");

    // Alice's hunk is NOT the file's last hunk and the file has no trailing
    // newline — this previously emitted a stray "\ No newline" marker mid-file.
    const r = quilt(dir, ["commit", "--mine", "-m", "alice"], "alice");
    assert.equal(r.status, 0, r.stderr);
    const expected = [...base];
    expected[1] = "l2-alice";
    assert.equal(gitOut(dir, ["show", "HEAD:f.ts"]), expected.join("\n"), "alice applied, EOF intact");
    assert.match(read(dir, "f.ts"), /l14-bob/, "bob's EOF edit still in tree");
  } finally {
    cleanup(dir);
  }
});

test("identical trivial lines (braces) in different hunks do not false-conflict", () => {
  const dir = makeRepo();
  try {
    const base = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
    write(dir, "code.ts", base.join("\n") + "\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);

    // Alice adds a block near the top (ends in a lone "}").
    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    const a = [...base];
    a.splice(1, 1, "if (a) {", "  doA();", "}");
    write(dir, "code.ts", a.join("\n") + "\n");
    quilt(dir, ["status"], "alice");

    // Bob adds a block near the bottom (also ends in a lone "}") — far enough to
    // be a separate hunk. The shared "}" must NOT register as a conflict.
    quilt(dir, ["start", "--actor", "bob", "--type", "agent"]);
    const ab = [...a];
    const bottom = ab.lastIndexOf("l18");
    ab.splice(bottom, 1, "if (b) {", "  doB();", "}");
    write(dir, "code.ts", ab.join("\n") + "\n");
    quilt(dir, ["status"], "bob");

    const conflicts = JSON.parse(quilt(dir, ["conflicts", "--json"], "bob").stdout);
    assert.equal(conflicts.conflicts.length, 0, "no false conflict from shared braces");

    const r = quilt(dir, ["commit", "--mine", "-m", "bob block"], "bob");
    assert.equal(r.status, 0, r.stderr);
    assert.match(gitOut(dir, ["show", "HEAD:code.ts"]), /doB\(\)/);
    assert.doesNotMatch(gitOut(dir, ["show", "HEAD:code.ts"]), /doA\(\)/, "alice's block not committed");
    assert.match(read(dir, "code.ts"), /doA\(\)/, "alice's block still in tree");
  } finally {
    cleanup(dir);
  }
});

test("a rename is committed as delete-old + add-new", () => {
  const dir = makeRepo();
  try {
    write(dir, "old.txt", "alpha\nbeta\ngamma\n");
    commitAll(dir, "init");
    setup(dir);
    renameSync(join(dir, "old.txt"), join(dir, "new.txt"));
    quilt(dir, ["status"], "alice");
    const r = quilt(dir, ["commit", "--mine", "-m", "rename"], "alice");
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(
      spawnSync("git", ["cat-file", "-e", "HEAD:old.txt"], { cwd: dir }).status,
      0,
      "old path removed from HEAD",
    );
    assert.equal(gitOut(dir, ["show", "HEAD:new.txt"]), "alpha\nbeta\ngamma");
    assert.equal(gitOut(dir, ["status", "--porcelain"]), "", "clean after rename commit");
  } finally {
    cleanup(dir);
  }
});
