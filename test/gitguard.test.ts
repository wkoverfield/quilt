import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/state.js";
import { recordAuthorship } from "../src/authorship.js";
import {
  CHAINED_HOOK_NAME,
  classifyCommand,
  classifyTokens,
  dirtyActors,
  denyReason,
  installPreCommitHook,
  parseBashHookInput,
  preCommitCurrent,
  preCommitInstalled,
  preCommitRefusal,
  readIndexSnapshots,
  recordIndexSnapshot,
  shellSegments,
  stagedActorSpan,
  SNAPSHOT_RING,
} from "../src/gitguard.js";

/** A real git repo with an initialized Quilt store and one committed file. */
function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), "quilt-gitguard-"));
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  run(["add", "base.txt"]);
  run(["commit", "-q", "-m", "base"]);
  const store = new Store(dir);
  store.ensureDirs();
  store.writeConfig({ version: 1, createdAt: new Date().toISOString() });
  store.writeObserved({ files: {} });
  store.writeOwnership({ files: {}, conflicts: {} });
  return { dir, store, run };
}

// ---- shellSegments ----

test("shellSegments splits on shell operators and honors quotes", () => {
  assert.deepEqual(shellSegments("cd a && git add ."), [["cd", "a"], ["git", "add", "."]]);
  assert.deepEqual(shellSegments('echo "git add" | cat'), [["echo", "git add"], ["cat"]]);
  assert.deepEqual(shellSegments("git commit -m 'a; b'"), [["git", "commit", "-m", "a; b"]]);
});

// ---- classification ----

test("index-mutating git classifies, read-only git does not", () => {
  for (const cmd of [
    "git add -A",
    'git commit -m "msg"',
    "git reset --hard HEAD~1",
    "git stash",
    "git rm --cached f.txt",
    "git mv a b",
    "git update-index --add f",
    "git read-tree HEAD",
    "git restore --staged f.txt",
    "git apply --cached p.patch",
    "git checkout -- f.txt",
  ]) {
    assert.ok(classifyCommand(cmd), `expected mutating: ${cmd}`);
  }
  for (const cmd of [
    "git status",
    "git log --oneline",
    "git diff --cached",
    "git push origin main",
    "git fetch",
    "git branch -a",
    "git restore f.txt",
    "git apply p.patch",
    "git checkout main",
    "git checkout -b feat/x",
    "ls -la",
    'echo "git add -A"',
    "quilt commit --mine -m x",
    "quilt git -- reset --hard",
  ]) {
    assert.equal(classifyCommand(cmd), null, `expected pass: ${cmd}`);
  }
});

test("shell wrappers cannot smuggle mutating git past the classifier", () => {
  assert.ok(classifyCommand('sh -c "git add ."'), "sh -c");
  assert.ok(classifyCommand("bash -c 'git add -A && git commit -m x'"), "bash -c");
  assert.ok(classifyCommand('bash -lc "git commit -m x"'), "combined -lc");
  assert.ok(classifyCommand("git ls-files -z | xargs -0 git add"), "xargs");
  assert.ok(classifyCommand("echo `git add .`"), "backtick substitution");
  assert.equal(classifyCommand('sh -c "git status"'), null, "read-only stays read-only inside a wrapper");
  assert.equal(classifyCommand("sh script.sh"), null, "a script path is not a -c string");
});

test("backslash-newline continuation does not hide the subcommand", () => {
  assert.ok(classifyCommand("git \\\n  add -A"), "continuation before subcommand");
  assert.ok(classifyCommand("git commit \\\n  -m 'long message'"), "continuation after subcommand");
});

test("stash is classified per subcommand", () => {
  assert.equal(classifyCommand("git stash list"), null);
  assert.equal(classifyCommand("git stash show -p"), null);
  assert.equal(classifyTokens(["git", "stash"])?.destroysIndex, true);
  assert.equal(classifyTokens(["git", "stash", "pop"])?.destroysIndex, true);
  assert.equal(classifyTokens(["git", "stash", "drop"])?.destroysIndex, false);
  assert.ok(classifyCommand("git stash clear"));
});

test("dry-run previews are not classified as mutations", () => {
  assert.equal(classifyCommand("git add -n ."), null);
  assert.equal(classifyCommand("git commit --dry-run"), null);
  assert.equal(classifyCommand("git rm -rn f"), null);
  // For commit, -n means --no-verify, not dry-run: still a real commit.
  assert.ok(classifyCommand("git commit -n -m x"));
  // -N (intent-to-add) writes the index: still a mutation.
  assert.ok(classifyCommand("git add -N f"));
});

test("classification sees through compound commands, wrappers, and global options", () => {
  assert.ok(classifyCommand("cd sub && git add . && git commit -m x"));
  assert.ok(classifyCommand("GIT_TRACE=1 git add ."));
  assert.ok(classifyCommand("env FOO=1 git add ."));
  assert.ok(classifyCommand("/usr/bin/git add ."));
  assert.ok(classifyCommand("git -C sub add ."));
  assert.ok(classifyCommand("git -c core.autocrlf=false add ."));
  assert.ok(classifyCommand("npx tsc --noEmit && git add -A && git commit -m done"));
  assert.equal(classifyCommand("git -C sub status"), null);
});

test("destroysIndex marks the snapshot-worthy commands", () => {
  assert.equal(classifyTokens(["git", "reset", "--hard"])?.destroysIndex, true);
  assert.equal(classifyTokens(["git", "stash"])?.destroysIndex, true);
  assert.equal(classifyTokens(["git", "add", "-A"])?.destroysIndex, false);
  assert.equal(classifyTokens(["git", "commit", "-m", "x"])?.destroysIndex, false);
});

// ---- hook payload ----

test("parseBashHookInput accepts Bash payloads only", () => {
  const p = parseBashHookInput({
    tool_name: "Bash",
    tool_input: { command: "git add -A" },
    cwd: "/tmp/x",
    session_id: "s-1",
  });
  assert.equal(p?.command, "git add -A");
  assert.equal(p?.cwd, "/tmp/x");
  assert.equal(parseBashHookInput({ tool_name: "Edit", tool_input: { file_path: "a" } }), null);
  assert.equal(parseBashHookInput({ tool_name: "Bash", tool_input: {} }), null);
});

// ---- dirty-actor census ----

test("dirtyActors counts distinct actors on git-dirty paths only", () => {
  const { dir, store } = newRepo();
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.txt"), "two\n");
  recordAuthorship(store, { actor: "actor-a", path: "a.txt", oldText: "", newText: "one\n", whole: true });
  recordAuthorship(store, { actor: "actor-b", path: "b.txt", oldText: "", newText: "two\n", whole: true });
  // Stale attribution on a path git sees as clean must not count.
  recordAuthorship(store, { actor: "actor-stale", path: "base.txt", oldText: "", newText: "base\n", whole: true });
  spawnSync("git", ["checkout", "--", "base.txt"], { cwd: dir });
  assert.deepEqual(dirtyActors(store), ["actor-a", "actor-b"]);
});

test("denyReason names the actors, the safe path, and the escape hatch", () => {
  const msg = denyReason({ sub: "add", destroysIndex: false }, ["actor-a", "actor-b"]);
  assert.match(msg, /2 actors/);
  assert.match(msg, /actor-a, actor-b/);
  assert.match(msg, /quilt commit --mine/);
  assert.match(msg, /quilt git -- add/);
});

// ---- index snapshots ----

test("recordIndexSnapshot writes a real tree and the ring stays bounded", () => {
  const { dir, store, run } = newRepo();
  writeFileSync(join(dir, "staged.txt"), "staged\n");
  run(["add", "staged.txt"]);
  const tree = recordIndexSnapshot(store, "test");
  assert.ok(tree, "snapshot should produce a tree");
  const type = spawnSync("git", ["cat-file", "-t", tree!], { cwd: dir, encoding: "utf8" });
  assert.equal(type.stdout.trim(), "tree");
  // The staged file must be inside the snapshot tree.
  const ls = spawnSync("git", ["ls-tree", "--name-only", tree!], { cwd: dir, encoding: "utf8" });
  assert.match(ls.stdout, /staged\.txt/);
  for (let i = 0; i < SNAPSHOT_RING + 5; i++) recordIndexSnapshot(store, `ring-${i}`);
  assert.equal(readIndexSnapshots(store).length, SNAPSHOT_RING);
});

// ---- pre-commit backstop ----

test("stagedActorSpan flags a staged set spanning two actors", () => {
  const { dir, store, run } = newRepo();
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.txt"), "two\n");
  writeFileSync(join(dir, "nobody.txt"), "unattributed\n");
  recordAuthorship(store, { actor: "actor-a", path: "a.txt", oldText: "", newText: "one\n", whole: true });
  recordAuthorship(store, { actor: "actor-b", path: "b.txt", oldText: "", newText: "two\n", whole: true });
  run(["add", "-A"]);
  const span = stagedActorSpan(store);
  assert.deepEqual([...span.keys()].sort(), ["actor-a", "actor-b"]);
  assert.deepEqual(span.get("actor-a"), ["a.txt"]);
  const msg = preCommitRefusal(span);
  assert.match(msg, /spans 2 actors/);
  assert.match(msg, /actor-a: a\.txt/);
  assert.match(msg, /quilt commit --mine/);
});

test("stagedActorSpan is single-actor when only one actor's files are staged", () => {
  const { dir, store, run } = newRepo();
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.txt"), "two\n");
  recordAuthorship(store, { actor: "actor-a", path: "a.txt", oldText: "", newText: "one\n", whole: true });
  recordAuthorship(store, { actor: "actor-b", path: "b.txt", oldText: "", newText: "two\n", whole: true });
  run(["add", "a.txt"]); // b.txt stays unstaged
  const span = stagedActorSpan(store);
  assert.deepEqual([...span.keys()], ["actor-a"]);
});

// ---- pre-commit hook installation ----

test("installPreCommitHook installs an executable shim and is idempotent", () => {
  const { dir } = newRepo();
  const first = installPreCommitHook(dir, false);
  assert.equal(first.action, "create");
  const hookPath = join(dir, ".git", "hooks", "pre-commit");
  assert.ok(existsSync(hookPath));
  assert.ok(preCommitInstalled(dir));
  assert.ok(preCommitCurrent(dir));
  const again = installPreCommitHook(dir, false);
  assert.equal(again.action, "skip");
});

test("installPreCommitHook preserves and chains a pre-existing hook", () => {
  const { dir } = newRepo();
  const hookPath = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, "#!/bin/sh\necho existing\n");
  chmodSync(hookPath, 0o755);
  const res = installPreCommitHook(dir, false);
  assert.equal(res.action, "update");
  assert.ok(preCommitCurrent(dir));
  const chained = join(dir, ".git", "hooks", CHAINED_HOOK_NAME);
  assert.ok(existsSync(chained));
  assert.match(readFileSync(chained, "utf8"), /echo existing/);
  assert.match(readFileSync(hookPath, "utf8"), new RegExp(CHAINED_HOOK_NAME));
});

test("installPreCommitHook refuses when pre-commit.local is already taken", () => {
  const { dir } = newRepo();
  writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho theirs\n");
  writeFileSync(join(dir, ".git", "hooks", CHAINED_HOOK_NAME), "#!/bin/sh\necho occupied\n");
  const res = installPreCommitHook(dir, false);
  assert.equal(res.action, "skip");
  assert.match(readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8"), /echo theirs/);
});

test("core.hooksPath redirects installation to the effective hooks dir", () => {
  const { dir, run } = newRepo();
  const custom = join(dir, ".husky");
  run(["config", "core.hooksPath", ".husky"]);
  const res = installPreCommitHook(dir, false);
  assert.equal(res.action, "create");
  assert.ok(existsSync(join(custom, "pre-commit")), "shim lands where git will actually run it");
  assert.ok(!existsSync(join(dir, ".git", "hooks", "pre-commit")), "nothing written to the ignored default dir");
  assert.ok(preCommitInstalled(dir));
  assert.ok(preCommitCurrent(dir));
});

test("a worktree checkout installs into the shared common hooks dir", () => {
  const { dir, run } = newRepo();
  const wt = join(dir, "..", "gitguard-wt-" + Date.now());
  run(["worktree", "add", "-q", wt, "-b", "wt-branch"]);
  try {
    const res = installPreCommitHook(wt, false);
    assert.equal(res.action, "create");
    assert.ok(preCommitInstalled(wt), "the worktree sees the shim via the common dir");
    assert.ok(existsSync(join(dir, ".git", "hooks", "pre-commit")), "hooks are shared at the main checkout's .git");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: dir });
  }
});

test("concurrent snapshot appends do not lose entries", () => {
  const { dir, store, run } = newRepo();
  writeFileSync(join(dir, "s.txt"), "s\n");
  run(["add", "s.txt"]);
  for (let i = 0; i < 5; i++) recordIndexSnapshot(store, `burst-${i}`);
  const contexts = readIndexSnapshots(store).map((s) => s.context);
  for (let i = 0; i < 5; i++) assert.ok(contexts.includes(`burst-${i}`));
});

test("stagedActorSpan matches non-ASCII staged paths against ownership keys", () => {
  const { dir, store, run } = newRepo();
  const name = "café-ü.txt";
  writeFileSync(join(dir, name), "accent\n");
  writeFileSync(join(dir, "plain.txt"), "plain\n");
  recordAuthorship(store, { actor: "actor-a", path: name, oldText: "", newText: "accent\n", whole: true });
  recordAuthorship(store, { actor: "actor-b", path: "plain.txt", oldText: "", newText: "plain\n", whole: true });
  run(["add", "-A"]);
  const span = stagedActorSpan(store);
  assert.deepEqual([...span.keys()].sort(), ["actor-a", "actor-b"], "quotePath must not hide the accented file");
});

test("a drifted quilt shim is reinstalled (content comparison, not the marker)", () => {
  const { dir } = newRepo();
  installPreCommitHook(dir, false);
  const hookPath = join(dir, ".git", "hooks", "pre-commit");
  // Simulate a shim from a build with different content but the same marker.
  writeFileSync(hookPath, readFileSync(hookPath, "utf8").replace("exit 0", "exit 0 # drift"));
  assert.ok(preCommitInstalled(dir));
  assert.equal(preCommitCurrent(dir), false);
  const res = installPreCommitHook(dir, false);
  assert.equal(res.action, "update");
  assert.ok(preCommitCurrent(dir));
  // A quilt-marked shim is replaced in place, never chained to itself.
  assert.ok(!existsSync(join(dir, ".git", "hooks", CHAINED_HOOK_NAME)));
});

test("the shim honors only the refusal exit code, so version skew fails open", () => {
  const { dir } = newRepo();
  installPreCommitHook(dir, false);
  const shim = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(shim, /-eq 65/, "refusal code is the only blocking exit");
  assert.match(shim, /2>\/dev\/null/, "an older quilt's unknown-command noise is silenced");
  assert.match(shim, /command -v quilt/, "quilt missing entirely is a silent pass");
});

test("dry-run plans without writing", () => {
  const { dir } = newRepo();
  const res = installPreCommitHook(dir, true);
  assert.equal(res.action, "create");
  assert.ok(!existsSync(join(dir, ".git", "hooks", "pre-commit")));
});
