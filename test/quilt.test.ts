import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "dist", "cli.js");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-test-"));
  const g = (args: string[]) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8" });
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

function quilt(dir: string, args: string[], actor?: string): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (actor) env.QUILT_ACTOR = actor;
  const res = spawnSync("node", [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
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

test("init creates .quilt and is idempotent", () => {
  const dir = makeRepo();
  try {
    write(dir, "a.txt", "hello\n");
    commitAll(dir, "init");
    const r = quilt(dir, ["init"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, ".quilt", "config.json")));
    const r2 = quilt(dir, ["init"]);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /already initialized/);
  } finally {
    cleanup(dir);
  }
});

test("start records the base SHA", () => {
  const dir = makeRepo();
  try {
    write(dir, "a.txt", "hello\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);
    const r = quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    assert.equal(r.status, 0, r.stderr);
    const head = gitOut(dir, ["rev-parse", "HEAD"]);
    const sessFiles = spawnSync("ls", [join(dir, ".quilt", "sessions")], {
      encoding: "utf8",
    }).stdout.trim().split("\n");
    const sess = JSON.parse(
      read(dir, join(".quilt", "sessions", sessFiles[0]!)),
    );
    assert.equal(sess.baseSha, head);
    assert.equal(sess.actorId, "alice");
  } finally {
    cleanup(dir);
  }
});

test("single actor edit appears in status and is owned", () => {
  const dir = makeRepo();
  try {
    write(dir, "auth.ts", "export const x = 1;\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);
    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    write(dir, "auth.ts", "export const x = 1;\nexport const y = 2;\n");
    const r = quilt(dir, ["status", "--json"], "alice");
    assert.equal(r.status, 0, r.stderr);
    const model = JSON.parse(r.stdout);
    const file = model.files.find((f: any) => f.path === "auth.ts");
    assert.ok(file, "auth.ts present in status");
    assert.equal(file.class, "mine");
  } finally {
    cleanup(dir);
  }
});

test("preview --mine matches the owned patch and applies cleanly", () => {
  const dir = makeRepo();
  try {
    write(dir, "auth.ts", "a\nb\nc\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);
    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    write(dir, "auth.ts", "a\nb\nc\nd\n");
    quilt(dir, ["status"], "alice"); // claim
    const r = quilt(dir, ["preview", "--mine", "--json"], "alice");
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.patch, /\+d/);
    assert.match(out.patch, /diff --git a\/auth\.ts b\/auth\.ts/);
  } finally {
    cleanup(dir);
  }
});

test("commit --mine --dry-run does not mutate repo or index", () => {
  const dir = makeRepo();
  try {
    write(dir, "auth.ts", "a\nb\n");
    commitAll(dir, "init");
    const headBefore = gitOut(dir, ["rev-parse", "HEAD"]);
    const indexBefore = gitOut(dir, ["status", "--porcelain"]);
    quilt(dir, ["init"]);
    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    write(dir, "auth.ts", "a\nb\nc\n");
    quilt(dir, ["status"], "alice");
    const r = quilt(dir, ["commit", "--mine", "-m", "add c", "--dry-run"], "alice");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(gitOut(dir, ["rev-parse", "HEAD"]), headBefore, "HEAD unchanged");
    // working tree still dirty, index unchanged
    assert.match(gitOut(dir, ["status", "--porcelain"]), /auth\.ts/);
    assert.notEqual(indexBefore, gitOut(dir, ["status", "--porcelain"]));
  } finally {
    cleanup(dir);
  }
});

test("commit --mine creates a normal git commit authored by the actor", () => {
  const dir = makeRepo();
  try {
    write(dir, "auth.ts", "a\nb\n");
    commitAll(dir, "init");
    const headBefore = gitOut(dir, ["rev-parse", "HEAD"]);
    quilt(dir, ["init"]);
    quilt(dir, ["start", "--actor", "alice", "--type", "agent", "--email", "alice@x.io"]);
    write(dir, "auth.ts", "a\nb\nc\n");
    quilt(dir, ["status"], "alice");
    const r = quilt(dir, ["commit", "--mine", "-m", "add c"], "alice");
    assert.equal(r.status, 0, r.stderr);
    const headAfter = gitOut(dir, ["rev-parse", "HEAD"]);
    assert.notEqual(headAfter, headBefore, "HEAD advanced");
    assert.equal(gitOut(dir, ["log", "-1", "--pretty=%an"]), "alice");
    assert.equal(gitOut(dir, ["log", "-1", "--pretty=%ae"]), "alice@x.io");
    // the committed content is in HEAD now
    assert.match(gitOut(dir, ["show", "HEAD:auth.ts"]), /c/);
    // and git does not show the committed hunk as a staged reversal
    assert.equal(gitOut(dir, ["status", "--porcelain"]), "", "working tree clean for committed file");
  } finally {
    cleanup(dir);
  }
});

test("other actors' changes remain in the working tree after commit", () => {
  const dir = makeRepo();
  try {
    write(dir, "fileA.ts", "base\n");
    write(dir, "fileB.ts", "base\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);

    // Alice starts and edits fileA, then claims.
    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    write(dir, "fileA.ts", "base\nalice\n");
    quilt(dir, ["status"], "alice");

    // Bob starts and edits fileB, then claims.
    quilt(dir, ["start", "--actor", "bob", "--type", "agent"]);
    write(dir, "fileB.ts", "base\nbob\n");
    quilt(dir, ["status"], "bob");

    // Alice commits only her changes.
    const r = quilt(dir, ["commit", "--mine", "-m", "alice work"], "alice");
    assert.equal(r.status, 0, r.stderr);

    // fileA committed; fileB still dirty in working tree.
    assert.match(gitOut(dir, ["show", "HEAD:fileA.ts"]), /alice/);
    assert.equal(
      spawnSync("git", ["show", "HEAD:fileB.ts"], { cwd: dir, encoding: "utf8" }).stdout,
      "base\n",
      "fileB not committed",
    );
    assert.equal(read(dir, "fileB.ts"), "base\nbob\n", "fileB still has bob's work");
  } finally {
    cleanup(dir);
  }
});

test("pre-existing dirty changes are marked unclaimed", () => {
  const dir = makeRepo();
  try {
    write(dir, "gen.lock", "v1\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);
    // Dirty BEFORE the session starts.
    write(dir, "gen.lock", "v1\nv2-generated\n");
    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    const r = quilt(dir, ["status", "--json"], "alice");
    const model = JSON.parse(r.stdout);
    const file = model.files.find((f: any) => f.path === "gen.lock");
    assert.ok(file);
    assert.equal(file.class, "unclaimed");
    // Alice owns nothing committable.
    const mine = quilt(dir, ["mine", "--json"], "alice");
    assert.equal(JSON.parse(mine.stdout).files.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("per-line commit: two actors editing different lines of one hunk each commit their own", () => {
  const dir = makeRepo();
  try {
    write(dir, "shared.ts", "l1\nl2\nl3\nl4\nl5\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);

    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    write(dir, "shared.ts", "l1\nl2-alice\nl3\nl4\nl5\n");
    quilt(dir, ["status"], "alice");

    quilt(dir, ["start", "--actor", "bob", "--type", "agent"]);
    write(dir, "shared.ts", "l1\nl2-alice\nl3\nl4-bob\nl5\n");
    quilt(dir, ["status"], "bob");

    // alice and bob edited DIFFERENT lines that happen to share one diff hunk.
    // bob can commit his line; alice's stays in the working tree.
    const r = quilt(dir, ["commit", "--mine", "-m", "bob l4"], "bob");
    assert.equal(r.status, 0, r.stderr);
    const head = gitOut(dir, ["show", "HEAD:shared.ts"]);
    assert.match(head, /l4-bob/, "bob's line committed");
    assert.doesNotMatch(head, /l2-alice/, "bob did NOT commit alice's line");
    assert.match(read(dir, "shared.ts"), /l2-alice/, "alice's line still in the tree");

    // alice can then commit hers on top.
    const r2 = quilt(dir, ["commit", "--mine", "-m", "alice l2"], "alice");
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(gitOut(dir, ["show", "HEAD:shared.ts"]), /l2-alice/);
    assert.match(gitOut(dir, ["show", "HEAD:shared.ts"]), /l4-bob/);
  } finally {
    cleanup(dir);
  }
});

test("status JSON is parseable and stable-shaped", () => {
  const dir = makeRepo();
  try {
    write(dir, "a.txt", "x\n");
    commitAll(dir, "init");
    quilt(dir, ["init"]);
    quilt(dir, ["start", "--actor", "alice", "--type", "agent"]);
    write(dir, "a.txt", "x\ny\n");
    const r = quilt(dir, ["status", "--json"], "alice");
    const model = JSON.parse(r.stdout);
    assert.ok(Array.isArray(model.files));
    assert.ok(model.summary && typeof model.summary.mine === "number");
    assert.ok("actor" in model && "base" in model);
  } finally {
    cleanup(dir);
  }
});

// ---- the pilot scenario: two subagents, one session, claims + native writes ----
//
// The first real pilot's headline bug: subagents of one Claude Code session
// share its session_id, and on 0.4.0 their captured work merged and the first
// commit --mine swept the other agent's files. This drives the whole repaired
// pipeline through the REAL CLI: per-subagent auto ids from agent_id, claim
// adoption binding a native write to the MCP role that claimed it, and each
// commit containing exactly that actor's files.
test("pilot replay: two subagents of one session commit exactly their own files", () => {
  const dir = makeRepo();
  try {
    write(dir, "README.md", "init\n");
    commitAll(dir, "init");
    assert.equal(quilt(dir, ["init"]).status, 0);

    // ui-agent claims its file under its role id (as it would over MCP)...
    assert.equal(quilt(dir, ["claim", "ui.ts", "--intent", "build the UI"], "ui-agent").status, 0);

    // ...and its subagent writes it natively: shared session_id, own agent_id,
    // ABSOLUTE path — exactly what a real hook payload carries.
    const hook = (payload: object) =>
      spawnSync("node", [CLI, "hook-pre"], { cwd: dir, encoding: "utf8", input: JSON.stringify(payload) });
    const hookPost = (payload: object) =>
      spawnSync("node", [CLI, "hook-post"], { cwd: dir, encoding: "utf8", input: JSON.stringify(payload) });

    const uiPayload = {
      tool_name: "Write",
      session_id: "shared-session-1234",
      agent_id: "f7e8d9c0",
      agent_type: "ui-builder",
      tool_input: { file_path: join(dir, "ui.ts"), content: "export function render() {\n  return 1;\n}\n" },
    };
    assert.equal(hook(uiPayload).status, 0);
    write(dir, "ui.ts", "export function render() {\n  return 1;\n}\n");
    assert.equal(hookPost(uiPayload).status, 0);

    // A second subagent (same session, different agent_id) writes its own file.
    const dataPayload = {
      tool_name: "Write",
      session_id: "shared-session-1234",
      agent_id: "0a1b2c3d",
      agent_type: "data-loader",
      tool_input: { file_path: join(dir, "data.ts"), content: "export function load() {\n  return [];\n}\n" },
    };
    assert.equal(hook(dataPayload).status, 0);
    write(dir, "data.ts", "export function load() {\n  return [];\n}\n");
    assert.equal(hookPost(dataPayload).status, 0);

    // The ledger tells the two subagents apart: adoption credited ui-agent
    // (the claim holder), and the data subagent got its own derived id.
    const log = read(dir, ".quilt/authorship.log");
    assert.match(log, /"actor":"ui-agent"/);
    assert.match(log, /"actor":"data-loader-0a1b2c3d"/);

    // The data subagent commits FIRST — the pilot's sweep moment. Its commit
    // must contain exactly data.ts, never ui-agent's claimed file.
    const dataCommit = quilt(dir, ["commit", "--mine", "-m", "data: loader"], "data-loader-0a1b2c3d");
    assert.equal(dataCommit.status, 0, dataCommit.stderr);
    assert.equal(gitOut(dir, ["show", "--name-only", "--format=", "HEAD"]).trim(), "data.ts");

    // ui-agent commits its own claimed work — including via a QUILT_ACTOR that
    // was never separately registered (it only claimed; adoption captured it).
    const uiCommit = quilt(dir, ["commit", "--mine", "-m", "ui: render"], "ui-agent");
    assert.equal(uiCommit.status, 0, uiCommit.stderr);
    assert.equal(gitOut(dir, ["show", "--name-only", "--format=", "HEAD"]).trim(), "ui.ts");
    assert.match(gitOut(dir, ["log", "--format=%an %s"]), /ui-agent ui: render/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pilot round 2, new bugs: the committed reconstruction silently dropped
// trivial lines that OPENED a change run — a blank separator line, and in one
// case a `}),` (which committed a syntax error). Trivial lines carry no
// ownership, so they inherit their run's decision; a run-opening one had
// nothing to inherit from and vanished.
test("commit --mine keeps run-opening trivial lines: blank separators and closer punctuation", () => {
  const dir = makeRepo();
  try {
    write(dir, "app.js", "registerRoutes(\n  home(),\n);\nfunction a() {\n  return 1;\n}\n");
    commitAll(dir, "base");
    assert.equal(quilt(dir, ["init"]).status, 0);

    // One actor, uncontested. Two edits whose diff runs OPEN with a trivial
    // line: appending a function preceded by a BLANK separator, and adding an
    // argument line adjacent to closer punctuation.
    const after =
      "registerRoutes(\n  home(),\n  admin(),\n);\nfunction a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    write(dir, "app.js", after);
    const c = quilt(dir, ["commit", "--mine", "-m", "solo work"], "solo");
    assert.equal(c.status, 0, c.stderr);

    // The committed file must be byte-identical to the worktree — nothing
    // (blank line, punctuation-only line) silently dropped.
    assert.equal(
      spawnSync("git", ["show", "HEAD:app.js"], { cwd: dir, encoding: "utf8" }).stdout,
      after,
      "committed content matches the worktree exactly",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a purely-trivial change run (formatting-only) commits with --include-unclaimed instead of vanishing", () => {
  const dir = makeRepo();
  try {
    write(dir, "fmt.js", "const a = 1;\nconst b = 2;\n");
    commitAll(dir, "base");
    assert.equal(quilt(dir, ["init"]).status, 0);

    // The actor's substantive edit plus a blank-line-only insertion elsewhere
    // (no owner signal in that run at all).
    const after = "const a = 1;\n\nconst b = 2;\nconst c = 3;\n";
    write(dir, "fmt.js", after);
    const c = quilt(dir, ["commit", "--mine", "--include-unclaimed", "-m", "solo fmt"], "solo");
    assert.equal(c.status, 0, c.stderr);
    assert.equal(
      spawnSync("git", ["show", "HEAD:fmt.js"], { cwd: dir, encoding: "utf8" }).stdout,
      after,
      "with --include-unclaimed the blank-only run commits too",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Dogfood phase 7: commit_mine classed package-lock.json as binary/too-large
// and silently SKIPPED it — the lockfile needed a manual commit and the build
// broke for everyone in between. Claimed binary files now commit whole;
// unclaimed ones are skipped LOUDLY.
test("a claimed binary file commits whole; an unclaimed one is skipped loudly", () => {
  const dir = makeRepo();
  try {
    write(dir, "app.js", "const a = 1;\n");
    commitAll(dir, "base");
    assert.equal(quilt(dir, ["init"]).status, 0);

    // A "binary" artifact (NUL byte) — same classification path as a
    // too-large lockfile. Unclaimed first: the commit must succeed for the
    // text file and WARN about the skip.
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x71, 0x00, 0x75, 0x69, 0x6c, 0x74]));
    quilt(dir, ["claim", "app.js"], "dev");
    write(dir, "app.js", "const a = 2;\n");
    const first = quilt(dir, ["commit", "--mine", "-m", "text only"], "dev");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Skipped binary.*blob\.bin/s, "the skip is loud, not silent");
    assert.doesNotMatch(
      spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout,
      /blob\.bin/,
    );

    // Claimed: the binary rides into the commit whole.
    quilt(dir, ["claim", "blob.bin"], "dev");
    const second = quilt(dir, ["commit", "--mine", "-m", "with blob"], "dev");
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Committed whole.*blob\.bin/s);
    // The count includes the whole-staged binary — a pure-binary commit must
    // not report "Committed 0 file(s)" as if nothing happened.
    assert.match(second.stdout, /Committed 1 file\(s\)/, "whole-staged binary is counted");
    const files = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: dir, encoding: "utf8",
    }).stdout.trim();
    assert.equal(files, "blob.bin");
    // Byte-exact content landed.
    const blob = spawnSync("git", ["show", "HEAD:blob.bin"], { cwd: dir });
    assert.deepEqual(blob.stdout, Buffer.from([0x71, 0x00, 0x75, 0x69, 0x6c, 0x74]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
