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

test("MCP: ONE shared server attributes two subagents via per-call actor", async () => {
  const dir = makeRepo();
  // foo and bar are well separated so their edits land in distinct hunks.
  write(
    dir,
    "utils.ts",
    "export function foo() {\n  return 1;\n}\n\n// ----\n// ----\n// ----\n\nexport function bar() {\n  return 2;\n}\n",
  );
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });

  // A single client = a single shared `quilt mcp` process (no start_session,
  // no QUILT_ACTOR) — exactly the Claude Code / Codex shared-server case.
  const c = await connect(dir);
  try {
    // Two subagents claim different symbols through the same server, each naming
    // itself per call. Both granted: distinct actors, no clobbering.
    const claimA = parse(
      await c.callTool({ name: "claim", arguments: { actor: "agent-a", paths: ["utils.ts#foo"] } }),
    );
    assert.equal(claimA.results[0].granted, true);
    const claimB = parse(
      await c.callTool({ name: "claim", arguments: { actor: "agent-b", paths: ["utils.ts#bar"] } }),
    );
    assert.equal(claimB.results[0].granted, true, "agent-b is a distinct actor, not blocked by agent-a");

    // Both edit their own symbol in the shared file.
    write(
      dir,
      "utils.ts",
      "export function foo() {\n  return 10;\n}\n\n// ----\n// ----\n// ----\n\nexport function bar() {\n  return 20;\n}\n",
    );

    // Each commits its own through the shared server.
    const commitA = parse(
      await c.callTool({ name: "commit_mine", arguments: { actor: "agent-a", message: "a: foo" } }),
    );
    assert.equal(commitA.committed, true);
    const commitB = parse(
      await c.callTool({ name: "commit_mine", arguments: { actor: "agent-b", message: "b: bar" } }),
    );
    assert.equal(commitB.committed, true);

    // Two commits, each correctly attributed — the keystone for orchestration.
    assert.equal(
      gitOut(dir, ["log", "--pretty=%an", "-2"]),
      "agent-b\nagent-a",
      "the shared server attributed each subagent to itself",
    );
    const head = gitOut(dir, ["show", "HEAD:utils.ts"]);
    assert.match(head, /return 10/, "foo change committed");
    assert.match(head, /return 20/, "bar change committed");
  } finally {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Orchestration confidence eval: a fleet of N subagents drives ONE shared
// `quilt mcp` server. With per-call actor, each subagent's work stays attributed
// to it; the pre-per-call-actor path (subagents omit their id, sharing one
// active actor) collapses the whole fleet into a single author. Same engine, no
// silent loss either way — the difference is whether a fleet keeps its identity.
// This guards the orchestrator integration: if it ever regresses, a fleet's
// history silently collapses to one name and this fails.
test("MCP orchestration eval: per-call actor keeps a 4-subagent fleet attributed; shared active actor collapses it", async () => {
  const N = 4;
  const file = (vals: number[]): string =>
    Array.from({ length: N }, (_, i) => `export function f${i}() {\n  return ${vals[i]};\n}\n`)
      .join("\n// ----\n// ----\n// ----\n\n");
  const base = file([0, 0, 0, 0]);
  const edited = file([10, 20, 30, 40]);
  const SEED_AUTHOR = "Quilt Test"; // makeRepo's git user.name (the seed commit)

  // distinct non-seed commit authors, oldest-first values irrelevant
  const fleetAuthors = (dir: string): string[] => {
    const all = gitOut(dir, ["log", "--pretty=%an"]).split("\n").filter(Boolean);
    return [...new Set(all.filter((a) => a !== SEED_AUTHOR))];
  };

  // ----- WITHOUT per-call actor: one active actor, subagents omit their id -----
  const d1 = makeRepo();
  write(d1, "mod.ts", base);
  spawnSync("git", ["add", "-A"], { cwd: d1 });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: d1 });
  const c1 = await connect(d1);
  try {
    await c1.callTool({ name: "start_session", arguments: { actor: "fleet", type: "agent" } });
    for (let i = 0; i < N; i++) {
      await c1.callTool({ name: "claim", arguments: { paths: [`mod.ts#f${i}`] } }); // no actor -> "fleet"
    }
    write(d1, "mod.ts", edited);
    for (let i = 0; i < N; i++) {
      await c1.callTool({ name: "commit_mine", arguments: { message: `f${i}` } }); // no actor -> "fleet"
    }
    const head1 = gitOut(d1, ["show", "HEAD:mod.ts"]);
    for (const v of [10, 20, 30, 40]) assert.match(head1, new RegExp(`return ${v}`), "no work lost");
    assert.deepEqual(
      fleetAuthors(d1),
      ["fleet"],
      "without per-call actor the whole fleet collapses into one author",
    );
  } finally {
    await c1.close();
    rmSync(d1, { recursive: true, force: true });
  }

  // ----- WITH per-call actor: each subagent names itself -----
  const d2 = makeRepo();
  write(d2, "mod.ts", base);
  spawnSync("git", ["add", "-A"], { cwd: d2 });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: d2 });
  const c2 = await connect(d2);
  try {
    for (let i = 0; i < N; i++) {
      const r = parse(
        await c2.callTool({ name: "claim", arguments: { actor: `agent-${i}`, paths: [`mod.ts#f${i}`] } }),
      );
      assert.equal(r.results[0].granted, true, `agent-${i} claims its own symbol`);
    }
    write(d2, "mod.ts", edited);
    for (let i = 0; i < N; i++) {
      const r = parse(
        await c2.callTool({ name: "commit_mine", arguments: { actor: `agent-${i}`, message: `f${i}` } }),
      );
      assert.equal(r.committed, true, `agent-${i} commits its own work`);
    }
    const head2 = gitOut(d2, ["show", "HEAD:mod.ts"]);
    for (const v of [10, 20, 30, 40]) assert.match(head2, new RegExp(`return ${v}`), "no work lost");
    assert.deepEqual(
      fleetAuthors(d2).sort(),
      ["agent-0", "agent-1", "agent-2", "agent-3"],
      "with per-call actor every subagent keeps its own attribution",
    );
    // and each function's change is attributed to the right subagent
    for (let i = 0; i < N; i++) {
      const author = gitOut(d2, ["log", "-S", `return ${(i + 1) * 10}`, "--pretty=%an", "--", "mod.ts"]);
      assert.equal(author, `agent-${i}`, `f${i} attributed to agent-${i}`);
    }
  } finally {
    await c2.close();
    rmSync(d2, { recursive: true, force: true });
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
      await a.callTool({
        name: "claim",
        arguments: { paths: ["shared.ts"], intent: "REFACTOR-3: extract the helper" },
      }),
    );
    assert.equal(aClaim.results[0].granted, true);

    const bClaim = parse(
      await b.callTool({ name: "claim", arguments: { paths: ["shared.ts"] } }),
    );
    assert.equal(bClaim.results[0].granted, false);
    assert.equal(bClaim.results[0].holder, "alice");
    // bob learns WHY alice holds it, so it can resolve from her intent.
    assert.equal(bClaim.results[0].holderIntent, "REFACTOR-3: extract the helper");
  } finally {
    await a.close();
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP: claim returns push-awareness warnings at reservation time", async () => {
  const dir = makeRepo();
  write(dir, "api.js", "export function api(x) {\n  return x;\n}\n");
  write(
    dir,
    "main.js",
    'import { api } from "./api.js";\nexport function caller() {\n  return api(2);\n}\n',
  );
  const a = await connect(dir);
  const b = await connect(dir);
  try {
    await a.callTool({ name: "start_session", arguments: { actor: "alice", type: "agent" } });
    await b.callTool({ name: "start_session", arguments: { actor: "bob", type: "agent" } });

    await a.callTool({ name: "claim", arguments: { paths: ["api.js#api"] } });
    const bClaim = parse(
      await b.callTool({ name: "claim", arguments: { paths: ["main.js#caller"] } }),
    );
    assert.equal(bClaim.results[0].granted, true);
    assert.equal(bClaim.dependencyWarnings.length, 1, "bob is warned at claim time");
    assert.equal(bClaim.dependencyWarnings[0].dependency, "api");
    assert.equal(bClaim.dependencyWarnings[0].heldBy, "alice");

    // get_status (the orient tool agents call first) must also carry the warning,
    // not just the claim response — mirrors `quilt status --json`.
    const bStatus = parse(await b.callTool({ name: "get_status", arguments: { actor: "bob" } }));
    assert.equal(bStatus.dependencyWarnings.length, 1, "get_status surfaces push-awareness too");
    assert.equal(bStatus.dependencyWarnings[0].dependency, "api");
  } finally {
    await a.close();
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
