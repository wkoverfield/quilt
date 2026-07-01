import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headBlob, headBlobs } from "../src/git.js";

function tmpRepo(): { dir: string; g: (a: string[]) => void } {
  const dir = mkdtempSync(join(tmpdir(), "quilt-git-"));
  const g = (a: string[]) => execFileSync("git", a, { cwd: dir });
  g(["init", "-q"]); g(["config", "user.email", "t@t.io"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  return { dir, g };
}

test("headBlobs reads many files' HEAD content in one batch, matching headBlob", () => {
  const { dir, g } = tmpRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
    writeFileSync(join(dir, "b.txt"), "just b\n");
    g(["add", "-A"]); g(["commit", "-qm", "i"]);
    const m = headBlobs(dir, ["a.txt", "b.txt"]);
    assert.equal(m.get("a.txt"), "line1\nline2\n");
    assert.equal(m.get("b.txt"), "just b\n");
    // Same result as N single reads.
    assert.equal(m.get("a.txt"), headBlob(dir, "a.txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headBlobs returns null for a path absent at HEAD (new/untracked file)", () => {
  const { dir, g } = tmpRepo();
  try {
    writeFileSync(join(dir, "tracked.txt"), "x\n");
    g(["add", "-A"]); g(["commit", "-qm", "i"]);
    writeFileSync(join(dir, "untracked.txt"), "y\n");
    const m = headBlobs(dir, ["tracked.txt", "untracked.txt", "never-existed.txt"]);
    assert.equal(m.get("tracked.txt"), "x\n");
    assert.equal(m.get("untracked.txt"), null);
    assert.equal(m.get("never-existed.txt"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headBlobs parses by byte length, so multi-byte content and following files stay aligned", () => {
  const { dir, g } = tmpRepo();
  try {
    // "café" — é is 2 bytes in utf8, so byte length (6) != char length (5). If the
    // parser advanced by chars, the NEXT file's content would be misaligned.
    writeFileSync(join(dir, "a.txt"), "café\n");
    writeFileSync(join(dir, "b.txt"), "after\n");
    g(["add", "-A"]); g(["commit", "-qm", "i"]);
    const m = headBlobs(dir, ["a.txt", "b.txt"]);
    assert.equal(m.get("a.txt"), "café\n");
    assert.equal(m.get("b.txt"), "after\n", "next file stays aligned after a multi-byte blob");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headBlobs handles a path with a space", () => {
  const { dir, g } = tmpRepo();
  try {
    writeFileSync(join(dir, "my file.txt"), "spaced\n");
    g(["add", "-A"]); g(["commit", "-qm", "i"]);
    assert.equal(headBlobs(dir, ["my file.txt"]).get("my file.txt"), "spaced\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headBlobs on an unborn branch (no commits) returns null for everything", () => {
  const { dir } = tmpRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "x\n");
    const m = headBlobs(dir, ["a.txt"]);
    assert.equal(m.get("a.txt"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headBlobs on an empty path list makes no git call and returns an empty map", () => {
  const { dir } = tmpRepo();
  try {
    assert.equal(headBlobs(dir, []).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
