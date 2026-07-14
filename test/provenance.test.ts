import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commitMessageWithProvenance,
  decodeProvenance,
  encodeProvenance,
  readCommitProvenance,
  type CommitProvenanceV1,
} from "../src/provenance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "dist", "cli.js");

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-provenance-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.name", "Test"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "commit.gpgsign", "false"]);
  return dir;
}

function cli(dir: string, args: string[], actor?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("node", [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, QUILT_NO_UPDATE_CHECK: "1", ...extraEnv, ...(actor ? { QUILT_ACTOR: actor } : {}) },
  });
}

function commitFixture(dir: string): void {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "fixture"], { cwd: dir });
}

test("provenance codec round-trips a versioned record", () => {
  const value: CommitProvenanceV1 = {
    version: 1,
    actor: { id: "alice", type: "agent", displayName: "Alice" },
    sessionId: "session-1",
    capture: "owned",
    tree: "a".repeat(40),
    parent: "b".repeat(40),
    files: [{ path: "a.ts", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }] }],
  };
  assert.deepEqual(decodeProvenance(encodeProvenance(value)), value);
  assert.equal(decodeProvenance("not-base64-json"), null);
});

test("malformed nested provenance is rejected instead of crashing readers", () => {
  const malformed = Buffer.from(JSON.stringify({
    version: 1,
    actor: { id: "alice", type: "agent", displayName: "Alice" },
    sessionId: null,
    capture: "owned",
    tree: "a".repeat(40),
    parent: null,
    files: [{}],
  })).toString("base64url");
  assert.equal(decodeProvenance(malformed), null);
});

test("commit --mine embeds portable provenance readable from a fresh clone", () => {
  const dir = repo();
  const clone = dir + "-clone";
  try {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitFixture(dir);
    assert.equal(cli(dir, ["init"]).status, 0);
    assert.equal(cli(dir, ["start", "--actor", "alice", "--type", "agent", "--email", "alice@example.com"]).status, 0);
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    assert.equal(cli(dir, ["status"], "alice").status, 0);
    const committed = cli(dir, ["commit", "--mine", "-m", "change a"], "alice");
    assert.equal(committed.status, 0, committed.stderr);
    const record = readCommitProvenance(dir);
    assert.equal(record?.actor.id, "alice");
    assert.equal(record?.capture, "owned");
    assert.deepEqual(record?.files.map((file) => file.path), ["a.ts"]);
    assert.equal(record?.tree, spawnSync("git", ["show", "-s", "--format=%T", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim());
    const body = spawnSync("git", ["show", "-s", "--format=%B", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout;
    assert.match(body, /^Quilt-Actor: alice$/m);
    assert.match(body, /^Quilt-Provenance: /m);

    spawnSync("git", ["clone", "-q", dir, clone]);
    const fromClone = cli(clone, ["provenance", "HEAD", "--json"]);
    assert.equal(fromClone.status, 0, fromClone.stderr);
    assert.equal(JSON.parse(fromClone.stdout).actor.id, "alice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("actor and session values cannot inject forged trailers", () => {
  const value: CommitProvenanceV1 = {
    version: 1,
    actor: { id: "alice\nQuilt-Provenance: forged", type: "agent", displayName: "Alice" },
    sessionId: "s\nQuilt-Actor: forged",
    capture: "owned",
    tree: "a".repeat(40),
    parent: null,
    files: [],
  };
  const message = commitMessageWithProvenance(
    "safe\n\nSigned-off-by: Maintainer <m@example.com>\nQuilt-Provenance: user-forged",
    value,
  );
  assert.equal((message.match(/^Quilt-Provenance:/gm) ?? []).length, 1);
  assert.equal((message.match(/^Quilt-Actor:/gm) ?? []).length, 1);
  assert.match(message, /^Signed-off-by: Maintainer <m@example\.com>$/m);
  assert.doesNotMatch(message, /user-forged/);
});

test("concurrent actor registration retains every actor and email", async () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "a.txt"), "base\n");
    commitFixture(dir);
    assert.equal(cli(dir, ["init"]).status, 0);
    const count = 40;
    const exits = await Promise.all(Array.from({ length: count }, (_, i) => new Promise<number | null>((done) => {
      const child = spawn("node", [CLI, "start", "--actor", `actor-${i}`, "--type", "agent", "--email", `actor-${i}@example.com`], {
        cwd: dir,
        env: { ...process.env, QUILT_NO_UPDATE_CHECK: "1" },
        stdio: "ignore",
      });
      child.on("close", done);
    })));
    assert.ok(exits.every((code) => code === 0));
    const actors = JSON.parse(readFileSync(join(dir, ".quilt", "actors.json"), "utf8")).actors as Array<{ id: string; email?: string }>;
    assert.equal(actors.length, count);
    for (let i = 0; i < count; i++) {
      assert.equal(actors.find((actor) => actor.id === `actor-${i}`)?.email, `actor-${i}@example.com`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
