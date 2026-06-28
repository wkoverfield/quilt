import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "dist", "cli.js");

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-mcp-"));
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
function write(dir: string, rel: string, content: string): void {
  writeFileSync(join(dir, rel), content);
}
function gitOut(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}

async function connect(dir: string) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [CLI, "mcp"],
    cwd: dir,
    env: { ...process.env } as Record<string, string>,
  });
  const client = new Client({ name: "quilt-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
function parse(res: any): any {
  return JSON.parse(res.content[0].text);
}

test("MCP server lists all the Quilt tools", async () => {
  const dir = makeRepo();
  const client = await connect(dir);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "claim",
      "commit_mine",
      "get_conflicts",
      "get_my_changes",
      "get_status",
      "preview_mine",
      "release",
      "start_session",
    ]);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP: start_session → edit → get_my_changes → commit_mine", async () => {
  const dir = makeRepo();
  const client = await connect(dir);
  try {
    const started = parse(
      await client.callTool({
        name: "start_session",
        arguments: { actor: "codex", type: "agent" },
      }),
    );
    assert.equal(started.actorId, "codex");

    write(dir, "auth.ts", "export const login = true;\n");

    const mine = parse(await client.callTool({ name: "get_my_changes", arguments: {} }));
    assert.ok(
      mine.files.some((f: any) => f.path === "auth.ts"),
      "agent owns its edit",
    );

    const committed = parse(
      await client.callTool({
        name: "commit_mine",
        arguments: { message: "add login" },
      }),
    );
    assert.equal(committed.committed, true);
    assert.match(gitOut(dir, ["log", "-1", "--pretty=%an"]), /codex/);
    assert.match(gitOut(dir, ["show", "HEAD:auth.ts"]), /login/);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP: claim is granted to one actor and denied to another", async () => {
  const dir = makeRepo();
  const a = await connect(dir);
  const b = await connect(dir);
  try {
    await a.callTool({ name: "start_session", arguments: { actor: "alice", type: "agent" } });
    await b.callTool({ name: "start_session", arguments: { actor: "bob", type: "agent" } });

    const aClaim = parse(
      await a.callTool({ name: "claim", arguments: { paths: ["shared.ts"] } }),
    );
    assert.equal(aClaim.results[0].granted, true);

    const bClaim = parse(
      await b.callTool({ name: "claim", arguments: { paths: ["shared.ts"] } }),
    );
    assert.equal(bClaim.results[0].granted, false);
    assert.equal(bClaim.results[0].holder, "alice");
  } finally {
    await a.close();
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
