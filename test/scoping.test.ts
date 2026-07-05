import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "dist", "cli.js");

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-scope-"));
  const g = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "test@quilt.local"]);
  g(["config", "user.name", "Quilt Test"]);
  g(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "seed.txt"), "x\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  spawnSync("node", [CLI, "init"], { cwd: dir });
  return dir;
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
function gitOut(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}
function headFiles(dir: string): string[] {
  return gitOut(dir, ["show", "--name-only", "--pretty=format:", "HEAD"])
    .split("\n")
    .filter(Boolean)
    .sort();
}
function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
function gitCommitAll(dir: string, msg: string): void {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", msg], { cwd: dir, encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// Part 1 — path scoping: `commit --mine [paths...]` is a HARD filter.
// The fleet-round-4 defect: naming a file did nothing (the command took no
// path args), so `commit --mine mine.ts` swept in everything the actor owned.
// ---------------------------------------------------------------------------

test("commit --mine <path> commits ONLY the named file; other owned work stays in the tree", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    write(dir, "mine.ts", "export const a = 1;\n");
    write(dir, "other.ts", "export const b = 2;\n");
    const res = quilt(dir, ["commit", "--mine", "mine.ts", "-m", "scoped"], "A");
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(headFiles(dir), ["mine.ts"], "only the named file is in the commit");
    // The unnamed file is untouched, still uncommitted, still the actor's.
    const mine = JSON.parse(quilt(dir, ["mine", "--json"], "A").stdout);
    assert.ok(
      mine.files.some((f: any) => f.path === "other.ts"),
      "the unnamed file remains owned and uncommitted",
    );
  } finally {
    cleanup(dir);
  }
});

test("preview --mine <path> scopes the patch to the named file", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    write(dir, "mine.ts", "export const a = 1;\n");
    write(dir, "other.ts", "export const b = 2;\n");
    const out = JSON.parse(quilt(dir, ["preview", "--mine", "mine.ts", "--json"], "A").stdout);
    assert.deepEqual(
      out.files.map((f: any) => f.path),
      ["mine.ts"],
      "the preview holds only the named file",
    );
    assert.ok(!out.patch.includes("other.ts"), "the patch text never mentions the unnamed file");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Part 2 — the contested-tree orphan gate. Inference attribution persists: a
// file attributed while the tree was briefly uncontested stays attributed. So
// once ANOTHER actor is live, an inference-only new file (never claimed, never
// captured) must not ride into a commit — that sweep is how `commit --mine`
// attached a harness artifact the agent never touched. Solo trees are exempt:
// a new file in your tree is yours (tests elsewhere cover exec-bit, renames).
// ---------------------------------------------------------------------------

test("contested tree: an inference-only new file is skipped LOUDLY, not swept into the commit", () => {
  const dir = makeRepo();
  try {
    write(dir, "app.ts", "export const app = 0;\n");
    gitCommitAll(dir, "app");
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    quilt(dir, ["start", "--actor", "B", "--type", "agent"]);

    // A's real work is an EDIT to committed code, and an orphan appears
    // alongside it (harness artifact, stray tool output — not A's doing). A's
    // reconcile runs while the tree is UNCONTESTED, so inference attributes
    // both to A, and that attribution persists.
    write(dir, "app.ts", "export const app = 1;\n");
    write(dir, "orphan.txt", "not A's file\n");
    quilt(dir, ["status"], "A"); // reconcile → inference attribution lands

    // Now B goes live somewhere else entirely — the tree becomes contested.
    const claim = quilt(dir, ["claim", "seed.txt"], "B");
    assert.equal(claim.status, 0, claim.stderr);

    // A's unscoped commit takes its real work but NOT the orphan.
    const res = quilt(dir, ["commit", "--mine", "-m", "A work"], "A");
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(headFiles(dir), ["app.ts"], "the orphan is not in the commit");
    assert.match(res.stdout, /orphan\.txt/, "the skip is loud, naming the file");
    assert.ok(existsSync(join(dir, "orphan.txt")), "the orphan stays in the working tree");

    // And the selection JSON tells an agent the same thing.
    const mine = JSON.parse(quilt(dir, ["mine", "--json"], "A").stdout);
    assert.deepEqual(mine.skippedUnowned, ["orphan.txt"], "skippedUnowned names the orphan");
  } finally {
    cleanup(dir);
  }
});

test("contested tree: claiming the new file is the escape hatch — it commits after a claim", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    quilt(dir, ["start", "--actor", "B", "--type", "agent"]);
    write(dir, "newfile.ts", "export const n = 1;\n");
    quilt(dir, ["status"], "A");
    quilt(dir, ["claim", "seed.txt"], "B"); // contested

    // Without a signal the commit refuses, explaining itself.
    const refused = quilt(dir, ["commit", "--mine", "-m", "try"], "A");
    assert.notEqual(refused.status, 0, "nothing committable without a signal");
    assert.match(refused.stderr, /newfile\.ts/, "the refusal names the file");
    assert.match(refused.stderr, /claim/, "the refusal points at the escape hatch");

    // Claiming it is the ownership signal.
    quilt(dir, ["claim", "newfile.ts"], "A");
    const res = quilt(dir, ["commit", "--mine", "-m", "A work"], "A");
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(headFiles(dir), ["newfile.ts"]);
  } finally {
    cleanup(dir);
  }
});

test("contested tree: --include-unclaimed overrides the orphan gate", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    quilt(dir, ["start", "--actor", "B", "--type", "agent"]);
    write(dir, "newfile.ts", "export const n = 1;\n");
    quilt(dir, ["status"], "A");
    quilt(dir, ["claim", "seed.txt"], "B"); // contested
    const res = quilt(dir, ["commit", "--mine", "--include-unclaimed", "-m", "all of it"], "A");
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(headFiles(dir), ["newfile.ts"]);
  } finally {
    cleanup(dir);
  }
});

test("solo tree: a new unclaimed file still commits — the gate only arms when others are live", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    write(dir, "newfile.ts", "export const n = 1;\n");
    const res = quilt(dir, ["commit", "--mine", "-m", "solo"], "A");
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(headFiles(dir), ["newfile.ts"]);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// The MCP surface — same rules through the tools an agent actually calls, and
// the capture signal: a file the actor CREATED through quilt_write is captured
// authorship, not inference, so the contested-tree gate must let it through.
// ---------------------------------------------------------------------------

async function connect(dir: string) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [CLI, "mcp"],
    cwd: dir,
    env: { ...process.env } as Record<string, string>,
  });
  const client = new Client({ name: "quilt-scope-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
function parse(res: any): any {
  return JSON.parse(res.content[0].text);
}

test("MCP: commit_mine with paths commits only the named file", async () => {
  const dir = makeRepo();
  const client = await connect(dir);
  try {
    await client.callTool({
      name: "start_session",
      arguments: { actor: "mcp-a", type: "agent" },
    });
    write(dir, "mine.ts", "export const a = 1;\n");
    write(dir, "other.ts", "export const b = 2;\n");
    const res = parse(
      await client.callTool({
        name: "commit_mine",
        arguments: { actor: "mcp-a", message: "scoped", paths: ["mine.ts"] },
      }),
    );
    assert.equal(res.committed, true, JSON.stringify(res));
    assert.deepEqual(headFiles(dir), ["mine.ts"], "only the named file is in the commit");
  } finally {
    await client.close();
    cleanup(dir);
  }
});

test("MCP: a quilt_write-created file is CAPTURED, so a contested tree still commits it", async () => {
  const dir = makeRepo();
  const client = await connect(dir);
  try {
    await client.callTool({
      name: "start_session",
      arguments: { actor: "mcp-a", type: "agent" },
    });
    // The actor really authors the new file — through the capturing tool.
    const wrote = parse(
      await client.callTool({
        name: "quilt_write",
        arguments: { actor: "mcp-a", path: "created.ts", content: "export const c = 1;\n" },
      }),
    );
    assert.ok(wrote.ok !== false, JSON.stringify(wrote));

    // Another actor goes live → contested tree.
    const claim = quilt(dir, ["claim", "seed.txt"], "B");
    assert.equal(claim.status, 0, claim.stderr);

    // Captured authorship is a real ownership signal — no claim needed.
    const res = parse(
      await client.callTool({
        name: "commit_mine",
        arguments: { actor: "mcp-a", message: "captured work" },
      }),
    );
    assert.equal(res.committed, true, JSON.stringify(res));
    assert.deepEqual(headFiles(dir), ["created.ts"]);
    assert.deepEqual(res.skippedUnowned ?? [], [], "nothing was skipped — the file is captured");
  } finally {
    await client.close();
    cleanup(dir);
  }
});

test("MCP: contested tree — an inference-only new file is skipped and surfaced in the response", async () => {
  const dir = makeRepo();
  const client = await connect(dir);
  try {
    await client.callTool({
      name: "start_session",
      arguments: { actor: "mcp-a", type: "agent" },
    });
    // Real work through the capturing tool, plus an orphan from outside it.
    await client.callTool({
      name: "quilt_write",
      arguments: { actor: "mcp-a", path: "real.ts", content: "export const r = 1;\n" },
    });
    write(dir, "orphan.txt", "harness artifact\n");
    // Reconcile while uncontested — inference attributes the orphan.
    await client.callTool({ name: "get_status", arguments: { actor: "mcp-a" } });
    // Contested now.
    quilt(dir, ["claim", "seed.txt"], "B");

    const res = parse(
      await client.callTool({
        name: "commit_mine",
        arguments: { actor: "mcp-a", message: "real work only" },
      }),
    );
    assert.equal(res.committed, true, JSON.stringify(res));
    assert.deepEqual(headFiles(dir), ["real.ts"], "the orphan never enters the commit");
    assert.deepEqual(res.skippedUnowned, ["orphan.txt"], "the response names the skip");
  } finally {
    await client.close();
    cleanup(dir);
  }
});

test("a forward symbol claim (--creating) on a new file satisfies the contested-tree gate", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    quilt(dir, ["start", "--actor", "B", "--type", "agent"]);
    quilt(dir, ["claim", "seed.txt"], "B"); // contested from the start
    // A follows the documented protocol exactly: forward-claim the symbol it's
    // about to create, then write the file via bash.
    const claim = quilt(dir, ["claim", "helper.ts#helper", "--creating"], "A");
    assert.equal(claim.status, 0, claim.stderr);
    write(dir, "helper.ts", "export function helper() { return 1; }\n");
    const res = quilt(dir, ["commit", "--mine", "-m", "add helper"], "A");
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(headFiles(dir), ["helper.ts"], "the forward-claimed file commits");
  } finally {
    cleanup(dir);
  }
});

test("commit --mine <dir>/ scopes to everything under the directory", () => {
  const dir = makeRepo();
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    spawnSync("mkdir", ["-p", join(dir, "src")]);
    write(dir, "src/a.ts", "export const a = 1;\n");
    write(dir, "src/b.ts", "export const b = 2;\n");
    write(dir, "other.ts", "export const o = 3;\n");
    const res = quilt(dir, ["commit", "--mine", "src", "-m", "src only"], "A");
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(headFiles(dir), ["src/a.ts", "src/b.ts"], "the directory arg matches its contents");
  } finally {
    cleanup(dir);
  }
});

test("commit --mine with a path outside the repo fails loudly, not silently empty", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    write(dir, "mine.ts", "export const a = 1;\n");
    const res = quilt(dir, ["commit", "--mine", "../elsewhere.ts", "-m", "x"], "A");
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /outside this repository/);
  } finally {
    cleanup(dir);
  }
});
