import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeMcpServers,
  appendCoordination,
  detect,
  planSetup,
  COORDINATION_MARKER,
} from "../src/onboard.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-onboard-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

// --- mergeMcpServers ---

test("mergeMcpServers creates a fresh config when none exists", () => {
  const r = mergeMcpServers(null);
  assert.equal(r.changed, true);
  assert.deepEqual(JSON.parse(r.content).mcpServers.quilt, { command: "quilt", args: ["mcp"] });
});

test("mergeMcpServers adds quilt alongside existing servers", () => {
  const existing = JSON.stringify({ mcpServers: { other: { command: "foo" } } });
  const r = mergeMcpServers(existing);
  assert.equal(r.changed, true);
  const parsed = JSON.parse(r.content);
  assert.ok(parsed.mcpServers.other, "existing server preserved");
  assert.ok(parsed.mcpServers.quilt, "quilt server added");
});

test("mergeMcpServers is a no-op when quilt is already present", () => {
  const existing = JSON.stringify({ mcpServers: { quilt: { command: "quilt", args: ["mcp"] } } });
  const r = mergeMcpServers(existing);
  assert.equal(r.changed, false);
});

test("mergeMcpServers refuses to clobber malformed JSON", () => {
  const r = mergeMcpServers("{ not json");
  assert.equal(r.changed, false);
  assert.equal(r.content, "{ not json", "original content preserved");
  assert.match(r.error ?? "", /JSON/);
});

// --- appendCoordination ---

test("appendCoordination creates content with the marker when none exists", () => {
  const r = appendCoordination(null);
  assert.equal(r.changed, true);
  assert.ok(r.content.includes(COORDINATION_MARKER));
});

test("appendCoordination appends to existing CLAUDE.md exactly once", () => {
  const r1 = appendCoordination("# My rules\n");
  assert.equal(r1.changed, true);
  assert.ok(r1.content.startsWith("# My rules\n"), "existing content kept");
  assert.ok(r1.content.includes(COORDINATION_MARKER));
  // Idempotent: re-running on the merged content makes no further change.
  const r2 = appendCoordination(r1.content);
  assert.equal(r2.changed, false);
  assert.equal(r2.content, r1.content);
});

// --- detect ---

test("detect reports the orchestrator and wiring state", () => {
  const dir = tmpRepo();
  try {
    assert.equal(detect(dir).orchestrator, null, "bare repo has no orchestrator");
    writeFileSync(join(dir, "CLAUDE.md"), "# hi\n");
    assert.equal(detect(dir).orchestrator, "Claude Code");
    assert.equal(detect(dir).quiltWired, false);
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { quilt: { command: "quilt", args: ["mcp"] } } }),
    );
    assert.equal(detect(dir).quiltWired, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- planSetup / end-to-end CLI ---

test("planSetup skips files that are already wired", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { quilt: { command: "quilt", args: ["mcp"] } } }),
    );
    writeFileSync(join(dir, "CLAUDE.md"), `# rules\n\n${COORDINATION_MARKER}\nstuff\n`);
    const steps = planSetup(dir);
    assert.ok(steps.every((s) => s.action === "skip"), "everything already wired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quilt setup wires a fresh repo and is idempotent", () => {
  const dir = tmpRepo();
  try {
    const run = () => spawnSync("node", [CLI, "setup"], { cwd: dir, encoding: "utf8" });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.ok(existsSync(join(dir, ".quilt")), "Quilt initialized");
    assert.ok(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.quilt);
    assert.ok(readFileSync(join(dir, "CLAUDE.md"), "utf8").includes(COORDINATION_MARKER));

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Already wired/);
    // No duplicate snippet on re-run.
    const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    assert.equal(md.indexOf(COORDINATION_MARKER), md.lastIndexOf(COORDINATION_MARKER), "snippet added once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quilt setup --dry-run writes nothing", () => {
  const dir = tmpRepo();
  try {
    const r = spawnSync("node", [CLI, "setup", "--dry-run"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would create \.mcp\.json/);
    assert.equal(existsSync(join(dir, ".mcp.json")), false, "dry-run wrote no .mcp.json");
    assert.equal(existsSync(join(dir, ".quilt")), false, "dry-run did not initialize");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
