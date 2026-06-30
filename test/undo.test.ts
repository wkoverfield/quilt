import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-undo-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.io"]);
  g(["config", "user.name", "t"]);
  g(["config", "commit.gpgsign", "false"]);
  return dir;
}
function q(dir: string, args: string[], actor?: string) {
  const env = { ...process.env, ...(actor ? { QUILT_ACTOR: actor } : {}) };
  return spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env });
}
function write(dir: string, rel: string, c: string): void {
  writeFileSync(join(dir, rel), c);
}
function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), "utf8");
}

// Two agents, well-separated functions in one file, cooperative order (claim
// BEFORE editing so the file is symbol-contended and attribution is per-symbol).
function twoAgentFile(dir: string, fooVal: string, barVal: string) {
  return (
    `function foo() {\n  return ${fooVal};\n}\n\n` +
    `// ----\n// ----\n// ----\n\n` +
    `function bar() {\n  return ${barVal};\n}\n`
  );
}
function setup(dir: string) {
  write(dir, "utils.js", twoAgentFile(dir, "1", "2"));
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  q(dir, ["init"]);
  q(dir, ["start", "--actor", "codex", "--type", "agent"], "codex");
  q(dir, ["start", "--actor", "claude", "--type", "agent"], "claude");
  q(dir, ["claim", "utils.js#foo"], "codex");
  q(dir, ["claim", "utils.js#bar"], "claude");
  write(dir, "utils.js", twoAgentFile(dir, "111", "222"));
  q(dir, ["status"], "codex");
  q(dir, ["status"], "claude");
}

test("undo backs out one actor's changes and keeps everyone else's", () => {
  const dir = repo();
  try {
    setup(dir);
    const r = q(dir, ["undo", "codex"]);
    assert.equal(r.status, 0, r.stderr);

    const after = read(dir, "utils.js");
    assert.match(after, /return 1;/, "codex's foo change is reverted to the baseline");
    assert.doesNotMatch(after, /return 111;/, "codex's edit is gone");
    assert.match(after, /return 222;/, "claude's bar change is preserved");

    // codex no longer owns any working-tree changes; claude still does.
    const fleet = JSON.parse(q(dir, ["fleet", "--json"]).stdout);
    const codex = fleet.actors.find((a: any) => a.id === "codex");
    const claude = fleet.actors.find((a: any) => a.id === "claude");
    assert.deepEqual(codex.files, [], "codex owns no changes after undo");
    assert.ok(claude.files.includes("utils.js"), "claude still owns its change");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undo --dry-run reports the plan and changes nothing", () => {
  const dir = repo();
  try {
    setup(dir);
    const before = read(dir, "utils.js");
    const r = q(dir, ["undo", "codex", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Would back out/);
    assert.match(r.stdout, /utils\.js/);
    assert.equal(read(dir, "utils.js"), before, "dry-run leaves the working tree untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undo of an actor with no changes is a no-op", () => {
  const dir = repo();
  try {
    setup(dir);
    const r = q(dir, ["undo", "nobody"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No attributed uncommitted changes/);
    assert.match(read(dir, "utils.js"), /return 111;/, "nothing reverted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
