import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseApplyPatchFiles, parseCodexHookInput, codexActorId } from "../src/hooks.js";
import { mergeCodexHooks, codexHooksTrusted } from "../src/onboard.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "codex-payload-samples");

function fixtureBlob(name: string): string {
  return (JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as { input: string }).input;
}

// --- parsing, against the LIVE-captured payload samples ---

test("parseApplyPatchFiles reads the real single-file and multi-file blobs", () => {
  const single = parseApplyPatchFiles(fixtureBlob("single-file-update.json"));
  assert.deepEqual(single, [{ path: "x.js", kind: "update" }]);

  const multi = parseApplyPatchFiles(fixtureBlob("multi-file-success.json"));
  assert.deepEqual(multi, [
    { path: "x.js", kind: "update" },
    { path: "y.js", kind: "update" },
    { path: "z.js", kind: "add" },
  ]);
});

test("parseApplyPatchFiles handles Delete File and Move to sections", () => {
  const blob = "*** Begin Patch\n*** Delete File: old.js\n*** Update File: a.js\n*** Move to: b.js\n@@\n-x\n+y\n*** End Patch\n";
  assert.deepEqual(parseApplyPatchFiles(blob), [
    { path: "old.js", kind: "delete" },
    { path: "a.js", kind: "update", movePath: "b.js" },
  ]);
});

test("parseCodexHookInput detects the envelope in any tool_input field and derives the codex actor id", () => {
  const payload = {
    hook_event_name: "PreToolUse",
    session_id: "019F43F8-bb27-7750-8c91-0706ade15a04",
    cwd: "/tmp/somewhere",
    tool_name: "apply_patch",
    tool_input: { command: fixtureBlob("single-file-update.json") },
  };
  const p = parseCodexHookInput(payload);
  assert.ok(p, "recognized as a Codex payload");
  assert.equal(p!.files.length, 1);
  assert.equal(p!.cwd, "/tmp/somewhere");
  assert.equal(codexActorId(p!.sessionId!), "codex-019f43f8");

  // Field-name drift: the blob under a different key is still found.
  const drifted = parseCodexHookInput({ session_id: "x1", tool_input: { input: fixtureBlob("single-file-update.json") } });
  assert.ok(drifted, "blob detection keys on the envelope, not the field name");

  // A Claude Edit payload is NOT a Codex payload.
  assert.equal(
    parseCodexHookInput({ tool_name: "Edit", tool_input: { file_path: "m.js", old_string: "a", new_string: "b" } }),
    null,
  );
});

// --- global hooks.json merge: additive, never stomping the user's hooks ---

test("mergeCodexHooks adds the apply_patch groups and preserves every existing hook", () => {
  const existing = JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "my-session-start.sh" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-git-guard.sh" }] }],
    },
  });
  const r = mergeCodexHooks(existing);
  assert.equal(r.changed, true);
  const merged = JSON.parse(r.content);
  assert.equal(merged.hooks.SessionStart[0].hooks[0].command, "my-session-start.sh", "unrelated events untouched");
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, "my-git-guard.sh", "the user's group keeps its INDEX (Codex trusts by position)");
  assert.equal(merged.hooks.PreToolUse[1].matcher, "apply_patch");
  assert.equal(merged.hooks.PreToolUse[1].hooks[0].command, "quilt hook-pre");
  assert.equal(merged.hooks.PostToolUse[0].matcher, "apply_patch");
  // Idempotent.
  const again = mergeCodexHooks(r.content);
  assert.equal(again.changed, false);
  // Malformed input is refused, not clobbered.
  const bad = mergeCodexHooks("{ nope");
  assert.equal(bad.changed, false);
  assert.ok(bad.error);
});

test("codexHooksTrusted reads wiring + config.toml trust state (QUILT_CODEX_DIR override)", () => {
  const dir = mkdtempSync(join(tmpdir(), "quilt-codexdir-"));
  const prev = process.env.QUILT_CODEX_DIR;
  process.env.QUILT_CODEX_DIR = dir;
  try {
    assert.equal(codexHooksTrusted(), null, "no wiring at all → null");
    writeFileSync(join(dir, "hooks.json"), mergeCodexHooks(null).content);
    assert.equal(codexHooksTrusted(), false, "wired but no trust entries → false");
    writeFileSync(
      join(dir, "config.toml"),
      '[hooks.state."' + join(dir, "hooks.json") + ':pre_tool_use:0:0"]\ntrusted_hash = "sha256:x"\n' +
        '[hooks.state."' + join(dir, "hooks.json") + ':post_tool_use:0:0"]\ntrusted_hash = "sha256:y"\n',
    );
    assert.equal(codexHooksTrusted(), true, "trust entries for our group indexes → true");
  } finally {
    if (prev === undefined) delete process.env.QUILT_CODEX_DIR;
    else process.env.QUILT_CODEX_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the capture roundtrip: multi-file patch, per-file authorship ---

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-codexcap-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t.io"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  return dir;
}

test("a multi-file apply_patch round-trip captures per-file authorship under the codex session id", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "x.js"), "function one() {\n  return 111;\n}\n");
    writeFileSync(join(dir, "y.js"), "function two() {\n  return 2;\n}\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
    spawnSync("node", [CLI, "init"], { cwd: dir, encoding: "utf8" });

    // The REAL multi-file blob captured live from codex-cli 0.142.5.
    const payload = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "019f43fb-2635-7202-9041-93e42d6975d1",
      cwd: dir,
      tool_name: "apply_patch",
      tool_input: { command: fixtureBlob("multi-file-success.json") },
    });
    const env = { ...process.env, NO_COLOR: "1" };
    // Codex runs hooks with cwd wherever the session lives — use a NON-repo
    // cwd to prove resolution comes from the payload, not the process.
    const outside = tmpdir();
    let r = spawnSync("node", [CLI, "hook-pre"], { cwd: outside, encoding: "utf8", env, input: payload });
    assert.equal(r.status, 0, r.stderr);
    // The tool applies the patch (simulated writes matching the blob).
    writeFileSync(join(dir, "x.js"), "function one() {\n  return 1111;\n}\n");
    writeFileSync(join(dir, "y.js"), "function two() {\n  return 222;\n}\n");
    writeFileSync(join(dir, "z.js"), "function three() {\n  return 3;\n}\n");
    r = spawnSync("node", [CLI, "hook-post"], { cwd: outside, encoding: "utf8", env, input: payload });
    assert.equal(r.status, 0, r.stderr);

    const events = readFileSync(join(dir, ".quilt", "authorship.log"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.path).sort(), ["x.js", "y.js", "z.js"], "one capture per touched file");
    assert.ok(events.every((e) => e.actor === "codex-019f43fb"), "attributed to the codex session auto-id");
    const zEvent = events.find((e) => e.path === "z.js");
    assert.ok(zEvent!.added.length >= 3, "the added file's lines are captured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a FAILED apply_patch (disk unchanged) records nothing", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "x.js"), "function one() {\n  return 111;\n}\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
    spawnSync("node", [CLI, "init"], { cwd: dir, encoding: "utf8" });

    const payload = JSON.stringify({
      session_id: "deadfa11-0000-0000-0000-000000000000",
      cwd: dir,
      tool_name: "apply_patch",
      tool_input: { command: fixtureBlob("multi-file-failed.json") },
    });
    const env = { ...process.env, NO_COLOR: "1" };
    spawnSync("node", [CLI, "hook-pre"], { cwd: dir, encoding: "utf8", env, input: payload });
    // apply_patch verification failed: no file changed between pre and post.
    spawnSync("node", [CLI, "hook-post"], { cwd: dir, encoding: "utf8", env, input: payload });

    assert.ok(
      !existsSync(join(dir, ".quilt", "authorship.log")) ||
        readFileSync(join(dir, ".quilt", "authorship.log"), "utf8").trim() === "",
      "an untouched tree yields zero authorship events",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup wires Codex when ~/.codex exists (QUILT_CODEX_DIR) and prints the trust warning", () => {
  const dir = repo();
  const codexHome = mkdtempSync(join(tmpdir(), "quilt-codexhome-"));
  try {
    mkdirSync(codexHome, { recursive: true });
    const env = { ...process.env, NO_COLOR: "1", QUILT_NO_UPDATE_CHECK: "1", QUILT_CODEX_DIR: codexHome };
    const r = spawnSync("node", [CLI, "setup"], { cwd: dir, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /codex\/hooks\.json/);
    assert.match(r.stdout, /Codex trust/, "the silent-until-approved reality is stated");
    const wired = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
    assert.equal(wired.hooks.PreToolUse[0].matcher, "apply_patch");
    // Idempotent re-run.
    const again = spawnSync("node", [CLI, "setup"], { cwd: dir, encoding: "utf8", env });
    assert.match(again.stdout, /already present/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("a Claude Write whose CONTENT contains a patch envelope is NOT misrouted to the Codex path", () => {
  // e.g. an agent writing documentation about apply_patch, or a .patch file.
  const p = parseCodexHookInput({
    tool_name: "Write",
    session_id: "abc",
    tool_input: {
      file_path: "docs/patch-format.md",
      content: "Example:\n*** Begin Patch\n*** Update File: x.js\n*** End Patch\n",
    },
  });
  assert.equal(p, null, "file_path marks a Claude payload; the marker in content is just text");
});

test("a rename (Move to) never re-attributes unchanged lines — removal at the source, only real changes at the destination", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "a.js"), "const one = 1;\nconst two = 2;\nconst three = 3;\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
    spawnSync("node", [CLI, "init"], { cwd: dir, encoding: "utf8" });

    const blob = "*** Begin Patch\n*** Update File: a.js\n*** Move to: b.js\n@@\n-const two = 2;\n+const two = 22;\n*** End Patch\n";
    const payload = JSON.stringify({
      session_id: "abcd1234-0000-0000-0000-000000000000",
      cwd: dir,
      tool_name: "apply_patch",
      tool_input: { command: blob },
    });
    const env = { ...process.env, NO_COLOR: "1" };
    let r = spawnSync("node", [CLI, "hook-pre"], { cwd: dir, encoding: "utf8", env, input: payload });
    assert.equal(r.status, 0, r.stderr);
    // The tool performs the move + one-line change.
    rmSync(join(dir, "a.js"));
    writeFileSync(join(dir, "b.js"), "const one = 1;\nconst two = 22;\nconst three = 3;\n");
    r = spawnSync("node", [CLI, "hook-post"], { cwd: dir, encoding: "utf8", env, input: payload });
    assert.equal(r.status, 0, r.stderr);

    const events = readFileSync(join(dir, ".quilt", "authorship.log"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    const atOld = events.find((e) => e.path === "a.js");
    const atNew = events.find((e) => e.path === "b.js");
    assert.ok(atOld, "the source's removal is recorded");
    assert.equal(atOld!.added.length, 0, "nothing is ADDED at the old path");
    assert.equal(atOld!.removed.length, 3, "the mover removed the old path's lines");
    assert.ok(atNew, "the destination records the in-transit change");
    assert.deepEqual(atNew!.added, ["const two = 22;"], "ONLY the genuinely changed line is owned at the destination");
    assert.ok(!atNew!.added.includes("const one = 1;"), "unchanged moved lines are NOT re-attributed to the mover");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
