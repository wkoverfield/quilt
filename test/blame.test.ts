import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileBlame } from "../src/blame.js";
import { Store } from "../src/state.js";
import { initSymbols, ownKey, symbolLocator } from "../src/symbols.js";
import { latestPromptBefore, locateTranscript } from "../src/transcripts.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-blame-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  return dir;
}

function commit(dir: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: dir, stdio: "ignore" });
}

test("fileBlame retains disjoint line owners in separate symbols", async () => {
  const dir = repo();
  try {
    const before = "function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}\n";
    const after = "function one() {\n  return 11;\n}\n\nfunction two() {\n  return 22;\n}\n";
    writeFileSync(join(dir, "work.js"), before);
    commit(dir);
    await initSymbols();
    writeFileSync(join(dir, "work.js"), after);
    const addLoc = symbolLocator("work.js", after);
    const store = new Store(dir);
    store.ensureDirs();
    store.writeOwnership({
      files: {
        "work.js": {
          added: {
            [ownKey(addLoc(2), "  return 11;")]: "codex-12345678",
            [ownKey(addLoc(6), "  return 22;")]: "claude-87654321",
          },
          removed: {},
        },
      },
      conflicts: {},
    });

    const blame = fileBlame(store, "work.js", { claudeDir: join(dir, "none"), codexDir: join(dir, "none") });
    assert.ok(blame);
    const additions = blame!.lines.filter((line) => line.type === "add");
    assert.equal(additions.find((line) => line.text.includes("11"))?.actor, "codex-12345678");
    assert.equal(additions.find((line) => line.text.includes("22"))?.actor, "claude-87654321");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileBlame exposes exact sections for disjoint unified-diff hunks", async () => {
  const dir = repo();
  try {
    const before = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const afterLines = before.trimEnd().split("\n");
    afterLines[1] = "line two changed";
    afterLines[20] = "line twenty-one changed";
    writeFileSync(join(dir, "spread.txt"), before);
    commit(dir);
    writeFileSync(join(dir, "spread.txt"), afterLines.join("\n") + "\n");

    const store = new Store(dir);
    store.ensureDirs();
    const blame = fileBlame(store, "spread.txt", {
      claudeDir: join(dir, "none"),
      codexDir: join(dir, "none"),
    });

    assert.ok(blame);
    assert.equal(blame!.sections.length, 2);
    assert.deepEqual(blame!.sections, [
      { oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, startLineIndex: 0, lineCount: 6 },
      { oldStart: 18, oldLines: 7, newStart: 18, newLines: 7, startLineIndex: 6, lineCount: 8 },
    ]);
    assert.equal(
      blame!.sections.reduce((count, section) => count + section.lineCount, 0),
      blame!.lines.length,
    );
    assert.equal(blame!.lines[blame!.sections[1]!.startLineIndex]?.text, "line 18");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileBlame returns empty lines and sections for binary files", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "asset.bin"), Buffer.from([0, 1, 2, 3]));
    commit(dir);
    writeFileSync(join(dir, "asset.bin"), Buffer.from([0, 1, 2, 4]));

    const store = new Store(dir);
    store.ensureDirs();
    const blame = fileBlame(store, "asset.bin", {
      claudeDir: join(dir, "none"),
      codexDir: join(dir, "none"),
    });

    assert.ok(blame);
    assert.equal(blame!.binary, true);
    assert.deepEqual(blame!.lines, []);
    assert.deepEqual(blame!.sections, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileBlame lists every actor for a conflicted identical line", async () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "notes.txt"), "alpha\n");
    commit(dir);
    await initSymbols();
    const after = "alpha\nshared line\n";
    writeFileSync(join(dir, "notes.txt"), after);
    const key = ownKey(symbolLocator("notes.txt", after)(2), "shared line");
    const store = new Store(dir);
    store.ensureDirs();
    store.writeOwnership({
      files: { "notes.txt": { added: { [key]: "claude-aaaaaaaa" }, removed: {} } },
      conflicts: { "notes.txt": { [key]: ["claude-aaaaaaaa", "codex-bbbbbbbb"] } },
    });

    const line = fileBlame(store, "notes.txt", { claudeDir: join(dir, "none"), codexDir: join(dir, "none") })!
      .lines.find((candidate) => candidate.type === "add");
    assert.ok(line?.conflicted);
    assert.deepEqual(line!.actors.sort(), ["claude-aaaaaaaa", "codex-bbbbbbbb"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude transcript adapter extracts user text and skips tool results", () => {
  const dir = repo();
  try {
    const root = join(dir, "claude");
    mkdirSync(join(root, "project"), { recursive: true });
    const session = "12345678-1111-4222-8333-123456789abc";
    const rows = [
      { type: "user", sessionId: session, cwd: dir, timestamp: "2026-07-13T10:00:00.000Z", message: { role: "user", content: "first prompt" } },
      { type: "user", sessionId: session, cwd: dir, timestamp: "2026-07-13T10:01:00.000Z", message: { role: "user", content: [{ type: "tool_result", content: "private output" }] } },
      { type: "user", sessionId: session, cwd: dir, timestamp: "2026-07-13T10:02:00.000Z", message: { role: "user", content: [{ type: "text", text: "second prompt" }] } },
    ];
    writeFileSync(join(root, "project", session + ".jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const match = locateTranscript("claude-12345678", dir, { claudeDir: root });
    assert.deepEqual(match?.prompts.map((prompt) => prompt.prompt), ["first prompt", "second prompt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex transcript adapter scopes by rollout cwd and reads history prompts", () => {
  const dir = repo();
  try {
    const root = join(dir, "codex");
    const sessions = join(root, "sessions", "2026", "07", "13");
    mkdirSync(sessions, { recursive: true });
    const session = "019f343c-1111-7222-8333-123456789abc";
    writeFileSync(join(sessions, "rollout-2026-07-13T10-00-00-" + session + ".jsonl"), JSON.stringify({
      type: "session_meta", timestamp: "2026-07-13T10:00:00.000Z", payload: { id: session, cwd: dir },
    }) + "\n");
    writeFileSync(join(root, "history.jsonl"), [
      { session_id: session, ts: Date.parse("2026-07-13T10:00:00.000Z") / 1000, text: "shape the API" },
      { session_id: session, ts: Date.parse("2026-07-13T10:05:00.000Z") / 1000, text: "add the UI" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const match = locateTranscript("codex-019f343c", dir, { codexDir: root });
    assert.equal(match?.sessionId, session);
    assert.deepEqual(match?.prompts.map((prompt) => prompt.prompt), ["shape the API", "add the UI"]);
    assert.equal(latestPromptBefore(match!.prompts, "2026-07-13T10:03:00.000Z")?.prompt, "shape the API");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileBlame correlates an authorship event to the latest prompt before the edit", async () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "answer.js"), "export const answer = 0;\n");
    commit(dir);
    await initSymbols();
    const after = "export const answer = 42;\n";
    writeFileSync(join(dir, "answer.js"), after);
    const key = ownKey(symbolLocator("answer.js", after)(1), "export const answer = 42;");
    const store = new Store(dir);
    store.ensureDirs();
    store.writeOwnership({
      files: { "answer.js": { added: { [key]: "claude-12345678" }, removed: {} } },
      conflicts: {},
    });
    writeFileSync(store.paths.authorshipLog, JSON.stringify({
      seq: 1,
      ts: "2026-07-13T10:03:00.000Z",
      actor: "claude-12345678",
      path: "answer.js",
      added: ["export const answer = 42;"],
      removed: ["export const answer = 0;"],
      addedKeys: [key],
      anchor: null,
      preHash: null,
    }) + "\n");

    const claudeRoot = join(dir, "claude");
    const projectDir = join(claudeRoot, resolve(dir).replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(projectDir, { recursive: true });
    const session = "12345678-1111-4222-8333-123456789abc";
    writeFileSync(join(projectDir, session + ".jsonl"), [
      { type: "user", sessionId: session, cwd: dir, timestamp: "2026-07-13T10:00:00.000Z", message: { role: "user", content: "use the right value" } },
      { type: "user", sessionId: session, cwd: dir, timestamp: "2026-07-13T10:05:00.000Z", message: { role: "user", content: "too late" } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");

    const line = fileBlame(store, "answer.js", { claudeDir: claudeRoot, codexDir: join(dir, "none") })!
      .lines.find((candidate) => candidate.type === "add");
    assert.equal(line?.provenance[0]?.prompt, "use the right value");
    assert.equal(line?.provenance[0]?.inferred, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
