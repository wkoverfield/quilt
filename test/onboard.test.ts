import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeMcpServers,
  mergeHookSettings,
  appendCoordination,
  detect,
  planSetup,
  COORDINATION_MARKER,
  HOOK_PRE_COMMAND,
  HOOK_POST_COMMAND,
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

test("mergeMcpServers refuses a non-object mcpServers without throwing or losing data", () => {
  // A string/number would throw on property assignment; an array would silently
  // drop our entry. All must bail safely with the original content preserved.
  for (const bad of ['{"mcpServers":"foo"}', '{"mcpServers":[1,2]}', '{"mcpServers":5}', "[1,2,3]"]) {
    const r = mergeMcpServers(bad);
    assert.equal(r.changed, false, `${bad} should not change`);
    assert.equal(r.content, bad, `${bad} should be preserved verbatim`);
    assert.ok(r.error, `${bad} should report an error`);
  }
});

// --- appendCoordination ---

test("appendCoordination creates content with the marker when none exists", () => {
  const r = appendCoordination(null);
  assert.equal(r.changed, true);
  assert.ok(r.content.includes(COORDINATION_MARKER));
  // The snippet teaches the full sew loop, not just claim/commit.
  for (const term of ["intent", "holderIntent", "escalate", "resolve"]) {
    assert.ok(r.content.includes(term), `coordination snippet should mention ${term}`);
  }
  // Capture leads, while the prevention boundary stays honest per client.
  assert.ok(r.content.includes("quilt commit --mine"), "the CLI commit path is taught");
  assert.ok(r.content.includes("captured by the quilt hooks"), "leads with automatic capture");
  assert.ok(r.content.includes("Codex hooks are capture-only"), "states the Codex enforcement boundary");
  assert.ok(/NOT in your MCP list[\s\S]*still keep capture and attribution/.test(r.content), "says what remains without MCP tools");
  assert.ok(
    r.content.indexOf("captured by the quilt hooks") < r.content.indexOf("CLAIM before editing"),
    "hooks lead, claims are the optional-advanced section",
  );
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

// --- mergeHookSettings ---

test("mergeHookSettings creates settings with both capture hooks", () => {
  const r = mergeHookSettings(null);
  assert.equal(r.changed, true);
  const parsed = JSON.parse(r.content);
  assert.equal(parsed.hooks.PreToolUse[0].hooks[0].command, HOOK_PRE_COMMAND);
  assert.equal(parsed.hooks.PreToolUse[0].matcher, "Edit|Write|MultiEdit");
  assert.equal(parsed.hooks.PostToolUse[0].hooks[0].command, HOOK_POST_COMMAND);
});

test("mergeHookSettings preserves existing unrelated settings and hooks", () => {
  const existing = JSON.stringify({
    permissions: { allow: ["Bash"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }] },
  });
  const r = mergeHookSettings(existing);
  assert.equal(r.changed, true);
  const parsed = JSON.parse(r.content);
  assert.deepEqual(parsed.permissions.allow, ["Bash"], "unrelated settings kept");
  assert.equal(parsed.hooks.PreToolUse.length, 2, "existing Bash hook kept, quilt appended");
  assert.ok(parsed.hooks.PreToolUse.some((g: { hooks: { command: string }[] }) => g.hooks[0].command === HOOK_PRE_COMMAND));
});

test("mergeHookSettings is a no-op when the quilt hooks are already present", () => {
  const first = mergeHookSettings(null).content;
  const r = mergeHookSettings(first);
  assert.equal(r.changed, false);
});

test("mergeHookSettings refuses malformed JSON and a non-array hook event", () => {
  assert.equal(mergeHookSettings("{ not json").error, "not valid JSON");
  const bad = JSON.stringify({ hooks: { PreToolUse: "oops" } });
  const r = mergeHookSettings(bad);
  assert.equal(r.changed, false);
  assert.match(r.error!, /PreToolUse is not an array/);
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
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), mergeHookSettings(null).content);
    const steps = planSetup(dir);
    assert.ok(steps.every((s) => s.action === "skip"), "everything already wired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quilt setup wires a fresh repo and is idempotent", () => {
  const dir = tmpRepo();
  try {
    // QUILT_NO_UPDATE_CHECK keeps the test hermetic: setup's staleness nudge
    // would otherwise touch the network (or its daily cache) once.
    const run = () =>
      spawnSync("node", [CLI, "setup"], { cwd: dir, encoding: "utf8", env: { ...process.env, QUILT_NO_UPDATE_CHECK: "1" } });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.ok(existsSync(join(dir, ".quilt")), "Quilt initialized");
    assert.ok(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.quilt);
    assert.ok(readFileSync(join(dir, "CLAUDE.md"), "utf8").includes(COORDINATION_MARKER));
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, HOOK_PRE_COMMAND);
    assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, HOOK_POST_COMMAND);
    assert.equal(detect(dir).hooksWired, true);

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
    // NO_COLOR keeps stdout plain: picocolors force-enables ANSI when CI is set
    // (GitHub Actions), which would otherwise split "would " and "create" with a
    // reset code and break the substring match.
    const r = spawnSync("node", [CLI, "setup", "--dry-run"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would create \.mcp\.json/);
    assert.equal(existsSync(join(dir, ".mcp.json")), false, "dry-run wrote no .mcp.json");
    assert.equal(existsSync(join(dir, ".quilt")), false, "dry-run did not initialize");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSetup wires Cursor's .cursor/mcp.json and appends coordination to an existing AGENTS.md", () => {
  const dir = tmpRepo();
  try {
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(join(dir, "AGENTS.md"), "# Agents\n");
    const steps = planSetup(dir);
    const cursor = steps.find((s) => s.file === ".cursor/mcp.json");
    assert.ok(cursor, "a .cursor dir gets its own MCP config step");
    assert.equal(cursor!.action, "create");
    assert.ok(cursor!.content!.includes('"quilt"'));
    const agents = steps.find((s) => s.file === "AGENTS.md");
    assert.ok(agents, "an existing AGENTS.md receives the coordination snippet");
    assert.ok(agents!.content!.includes(COORDINATION_MARKER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSetup does NOT create AGENTS.md or .cursor config when neither exists", () => {
  const dir = tmpRepo();
  try {
    const files = planSetup(dir).map((s) => s.file);
    assert.ok(!files.includes("AGENTS.md"));
    assert.ok(!files.includes(".cursor/mcp.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- versioned snippet refresh (review finding: a presence-only marker check
// froze already-onboarded repos on whatever snippet they first received) ---

const LEGACY_BLOCK = `<!-- quilt:coordination -->
## Coordinating with other agents (Quilt)

You share this checkout with other agents. Coordinate through Quilt:

- Before you edit a file, claim what you're about to change. Pass intent.
- If your claim is denied, read holderIntent, escalate or resolve.
- When your change is ready, commit_mine with your id.`;

test("appendCoordination REPLACES a legacy (unversioned) block in place, preserving surrounding content", () => {
  const existing = `# My rules\n\nDo the thing.\n\n${LEGACY_BLOCK}\n\n## My other section\n\nkeep me\n`;
  const r = appendCoordination(existing);
  assert.equal(r.changed, true, "a stale block is a change, not a no-op");
  assert.ok(r.content.includes(COORDINATION_MARKER), "the current versioned marker landed");
  assert.ok(!r.content.includes("<!-- quilt:coordination -->\n"), "the legacy marker is gone");
  assert.ok(!r.content.includes("Coordinate through Quilt:"), "the old body is gone");
  assert.ok(r.content.startsWith("# My rules\n\nDo the thing.\n"), "content before the block survives");
  assert.ok(r.content.includes("## My other section\n\nkeep me"), "content after the block survives");
  assert.equal(r.content.split("<!-- quilt:coordination").length - 1, 1, "exactly one start marker remains");
  // Idempotent from here: the refreshed content is current.
  assert.equal(appendCoordination(r.content).changed, false);
});

test("appendCoordination refreshes a v2+ block via its end marker when the version bumps", () => {
  // Simulate a hypothetical older versioned block (v1 style with end marker).
  const oldVersioned = `<!-- quilt:coordination v1 -->\n## Coordinating with other agents (Quilt)\n\nold body\n<!-- /quilt:coordination -->`;
  const existing = `# rules\n\n${oldVersioned}\n\ntrailing notes\n`;
  const r = appendCoordination(existing);
  assert.equal(r.changed, true);
  assert.ok(r.content.includes(COORDINATION_MARKER));
  assert.ok(!r.content.includes("old body"));
  assert.ok(r.content.includes("trailing notes"), "content after the end marker survives");
});

test("detect + doctor surface a stale coordination snippet", () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "CLAUDE.md"), `${LEGACY_BLOCK}\n`);
    const d = detect(dir);
    assert.equal(d.coordinationPresent, false, "a legacy block is not the current one");
    assert.equal(d.coordinationStale, true);
    const step = planSetup(dir).find((s) => s.file === "CLAUDE.md");
    assert.equal(step?.action, "update");
    assert.match(step!.detail, /refresh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy block refresh cuts at the known final line, so trailing NON-heading user content survives", () => {
  // The block was appended at EOF by setup, but users edit files: plain
  // trailing paragraphs (no ## heading) must not be swallowed by the refresh.
  const legacy04 = `<!-- quilt:coordination -->
## Coordinating with other agents (Quilt)

You share this checkout with other agents. Coordinate through Quilt:

- CLAIM before editing when either applies. Always pass a short intent.
- If denied, read holderIntent, escalate or resolve.
- Repo-wide proof gates can fail mid-wave. Keep tooling artifacts (test snapshots,
  scratch output) gitignored — quilt follows git's view of the tree.`;
  const existing = `# rules\n\n${legacy04}\n\nmy own trailing note, not a heading\n- my own list item\n`;
  const r = appendCoordination(existing);
  assert.equal(r.changed, true);
  assert.ok(r.content.includes(COORDINATION_MARKER));
  assert.ok(!r.content.includes("Coordinate through Quilt:"), "old body gone");
  assert.ok(r.content.includes("my own trailing note, not a heading"), "trailing paragraph survives");
  assert.ok(r.content.includes("- my own list item"), "trailing list survives");
  assert.equal(r.content.split("<!-- quilt:coordination").length - 1, 1);
});

test("legacy block refresh: pre-0.4 body (different final line) also cuts precisely", () => {
  const legacyPre04 = `<!-- quilt:coordination -->
## Coordinating with other agents (Quilt)

You share this checkout with other agents. Coordinate through Quilt:

- Before you edit a file, claim what you're about to change. Pass intent.
- When your change is ready, commit_mine with your id. It commits only your
  lines and leaves everyone else's work untouched.`;
  const existing = `${legacyPre04}\n\nkeep this line\n`;
  const r = appendCoordination(existing);
  assert.equal(r.changed, true);
  assert.ok(r.content.includes("keep this line"), "content after the pre-0.4 tail survives");
  assert.ok(!r.content.includes("Before you edit a file, claim"), "old body gone");
});
