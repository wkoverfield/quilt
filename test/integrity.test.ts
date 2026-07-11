import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-integrity-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Wilson"]);
  git(["config", "user.email", "wilson@example.com"]);
  git(["config", "commit.gpgsign", "false"]);
  return dir;
}

function run(dir: string, args: string[], actor?: string) {
  const env = { ...process.env, QUILT_NO_UPDATE_CHECK: "1" };
  delete env.QUILT_ACTOR;
  delete env.QUILT_SESSION;
  if (actor) env.QUILT_ACTOR = actor;
  return spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env });
}

function git(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}

function capturedEdit(dir: string, actor: string, oldString: string, newString: string, invocation: string) {
  const payload = JSON.stringify({
    tool_name: "Edit",
    tool_use_id: invocation,
    session_id: actor,
    tool_input: { file_path: join(dir, "m.ts"), old_string: oldString, new_string: newString },
  });
  const env = { ...process.env, QUILT_ACTOR: actor, QUILT_NO_UPDATE_CHECK: "1" };
  const pre = spawnSync("node", [CLI, "hook-pre"], { cwd: dir, encoding: "utf8", env, input: payload });
  assert.equal(pre.status, 0, pre.stderr);
  const before = readFileSync(join(dir, "m.ts"), "utf8");
  writeFileSync(join(dir, "m.ts"), before.replace(oldString, newString));
  const post = spawnSync("node", [CLI, "hook-post"], { cwd: dir, encoding: "utf8", env, input: payload });
  assert.equal(post.status, 0, post.stderr);
}

test("#100: reused identical boilerplate inside one symbol remains committable by the later actor", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "m.ts"), "export function values() {\n  return [];\n}\n");
    git(dir, ["add", "-A"]); git(dir, ["commit", "-qm", "seed"]);
    assert.equal(run(dir, ["init"]).status, 0);

    capturedEdit(
      dir,
      "first",
      "  return [];",
      "  const rows = [{ lastTouched: Math.max(1, 2) }];\n  return rows;",
      "first-add",
    );
    const first = run(dir, ["commit", "--mine", "-m", "first"], "first");
    assert.equal(first.status, 0, first.stderr);

    capturedEdit(
      dir,
      "backend",
      "  return rows;",
      "  rows.push({ lastTouched: Math.max(1, 2) });\n  return rows;",
      "backend-add",
    );
    const preview = run(dir, ["preview", "--mine", "--json"], "backend");
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /rows\.push/);
    const commit = run(dir, ["commit", "--mine", "-m", "backend"], "backend");
    assert.equal(commit.status, 0, commit.stderr);
    assert.match(git(dir, ["show", "--format=", "HEAD"]), /rows\.push/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("identical dirty additions remain independently owned across sequential partial commits", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "m.ts"), "export function values() {\n  const rows: unknown[] = [];\n  if (rows.length === 0) rows.push(null);\n  return rows;\n}\n");
    git(dir, ["add", "-A"]); git(dir, ["commit", "-qm", "seed"]);
    run(dir, ["init"]);
    const boilerplate = "  rows.push({ lastTouched: Math.max(1, 2) });\n";
    capturedEdit(dir, "actor-a", "  if (rows.length === 0)", boilerplate + "  if (rows.length === 0)", "same-a");
    capturedEdit(dir, "actor-b", "  return rows;", boilerplate + "  return rows;", "same-b");

    const a = run(dir, ["commit", "--mine", "-m", "a"], "actor-a");
    assert.equal(a.status, 0, a.stderr);
    assert.equal((git(dir, ["show", "--format=", "HEAD"]).match(/lastTouched/g) ?? []).length, 1);
    assert.equal((readFileSync(join(dir, "m.ts"), "utf8").match(/lastTouched/g) ?? []).length, 2);

    const bPreview = run(dir, ["preview", "--mine", "--json"], "actor-b");
    assert.equal(bPreview.status, 0, bPreview.stderr);
    assert.match(bPreview.stdout, /rows\.push/);
    const b = run(dir, ["commit", "--mine", "-m", "b"], "actor-b");
    assert.equal(b.status, 0, b.stderr);
    assert.equal((git(dir, ["show", "HEAD:m.ts"]).match(/lastTouched/g) ?? []).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository author.email config preserves actor name and uses a deploy-recognized email", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "m.ts"), "export const n = 1;\n");
    git(dir, ["add", "-A"]); git(dir, ["commit", "-qm", "seed"]);
    run(dir, ["init"]);
    const configured = run(dir, ["config", "author.email", "deploy@example.com"]);
    assert.equal(configured.status, 0, configured.stderr);
    capturedEdit(dir, "builder-a", "n = 1", "n = 2", "email-edit");
    const committed = run(dir, ["commit", "--mine", "-m", "email"], "builder-a");
    assert.equal(committed.status, 0, committed.stderr);
    assert.equal(git(dir, ["show", "-s", "--format=%ae", "HEAD"]), "deploy@example.com");
    assert.equal(git(dir, ["show", "-s", "--format=%an", "HEAD"]), "builder-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared-shell commit refuses a checkout-global actor when another actor owns dirty work", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "m.ts"), "export const n = 1;\n");
    git(dir, ["add", "-A"]); git(dir, ["commit", "-qm", "seed"]);
    run(dir, ["init"]);
    run(dir, ["start", "--actor", "stale"]);
    capturedEdit(dir, "live-builder", "n = 1", "n = 2", "identity-edit");
    const unsafe = run(dir, ["commit", "--mine", "-m", "wrong"]);
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /ambiguous actor in a shared checkout/);
    const safe = run(dir, ["commit", "--mine", "-m", "right"], "live-builder");
    assert.equal(safe.status, 0, safe.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve --take transfers phantom ownership and makes the target committable", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "m.ts"), "export const n = 1;\n");
    git(dir, ["add", "-A"]); git(dir, ["commit", "-qm", "seed"]);
    run(dir, ["init"]);
    capturedEdit(dir, "dead-builder", "n = 1", "n = 2", "dead-edit");
    const taken = run(
      dir,
      ["resolve", "m.ts", "--take", "--from", "dead-builder", "--note", "builder exited"],
      "live-builder",
    );
    assert.equal(taken.status, 0, taken.stderr);
    assert.match(taken.stdout, /transferred 2 operation/);
    const committed = run(dir, ["commit", "--mine", "-m", "recovered"], "live-builder");
    assert.equal(committed.status, 0, committed.stderr);
    assert.match(git(dir, ["show", "--format=", "HEAD"]), /n = 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
