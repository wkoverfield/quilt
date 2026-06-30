import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-fleet-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.io"]);
  g(["config", "user.name", "t"]);
  g(["config", "commit.gpgsign", "false"]);
  return dir;
}
function q(dir: string, args: string[], actor?: string) {
  const env = { ...process.env, ...(actor ? { QUILT_ACTOR: actor } : {}) };
  return spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env });
}
function write(dir: string, rel: string, c: string): void {
  writeFileSync(join(dir, rel), c);
}
function commit(dir: string, m: string): void {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", m], { cwd: dir });
}
function fleet(dir: string): any {
  return JSON.parse(q(dir, ["fleet", "--json"]).stdout);
}

// The fleet view is mission control — it has to match ground truth: once a
// collision has been reconciled (any actor ran a quilt command after the edit),
// it must surface, not show "all clear"; and it must not cry wolf when two agents
// cleanly own different parts of the same file. (The view reflects reconciled
// state — that's the pull-attribution model, not a flaw in the view.)

test("fleet view: clean disjoint work shows each actor's claims/files and NO overlap", () => {
  const dir = repo();
  try {
    // foo and bar are well separated so their edits land in distinct hunks.
    const file = (a: string, b: string) =>
      `function foo() {\n  return ${a};\n}\n\n// ----\n// ----\n// ----\n// ----\n// ----\n\nfunction bar() {\n  return ${b};\n}\n`;
    write(dir, "utils.js", file("1", "2"));
    commit(dir, "init");
    q(dir, ["init"]);
    q(dir, ["start", "--actor", "codex", "--type", "agent"], "codex");
    q(dir, ["start", "--actor", "claude", "--type", "agent"], "claude");
    q(dir, ["claim", "utils.js#foo"], "codex");
    q(dir, ["claim", "utils.js#bar"], "claude");
    write(dir, "utils.js", file("11", "22"));
    q(dir, ["status"], "codex"); // each reconciles its own delta
    q(dir, ["status"], "claude");

    const v = fleet(dir);
    assert.deepEqual(
      v.actors.map((a: any) => a.id).sort(),
      ["claude", "codex"],
      "both actors appear in the roster",
    );
    const codex = v.actors.find((a: any) => a.id === "codex");
    assert.deepEqual(codex.claims, ["utils.js#foo"]);
    assert.ok(codex.files.includes("utils.js"), "codex owns its change in utils.js");
    assert.equal(v.overlaps.length, 0, "well-separated symbols land in distinct hunks — no overlap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fleet view: shows who's blocked and cross-actor dependency heads-up", () => {
  const dir = repo();
  try {
    write(
      dir,
      "billing.js",
      "export function rate() {\n  return 0.05;\n}\n\nexport function total(amount) {\n  return amount * rate();\n}\n",
    );
    commit(dir, "init");
    q(dir, ["init"]);
    q(dir, ["start", "--actor", "codex", "--type", "agent"], "codex");
    q(dir, ["start", "--actor", "claude", "--type", "agent"], "claude");
    q(dir, ["claim", "billing.js#rate"], "codex");
    q(dir, ["claim", "billing.js#total"], "claude"); // total() calls rate()
    // claude tries to grab rate too — denied (codex holds it) -> blocked
    const denied = q(dir, ["claim", "billing.js#rate"], "claude");
    assert.notEqual(denied.status, 0, "claude's claim on rate is denied");

    const v = fleet(dir);
    assert.equal(v.blocked.length, 1, "the denial is recorded as a block");
    assert.deepEqual(v.blocked[0], {
      actor: "claude",
      target: "billing.js#rate",
      holder: "codex",
    });
    assert.ok(
      v.dependencyWarnings.some(
        (w: any) => w.dependency === "rate" && w.heldBy === "codex",
      ),
      "claude#total depends on rate, which codex holds — surfaced fleet-wide",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fleet view: a real same-line collision is never hidden", () => {
  const dir = repo();
  try {
    write(dir, "f.js", "export const rate = 1;\n");
    commit(dir, "init");
    q(dir, ["init"]);
    q(dir, ["start", "--actor", "a", "--type", "agent"], "a");
    q(dir, ["start", "--actor", "b", "--type", "agent"], "b");
    // a changes the line and reconciles (owns it); b changes the SAME line.
    write(dir, "f.js", "export const rate = 5;\n");
    q(dir, ["status"], "a");
    write(dir, "f.js", "export const rate = 9;\n");
    q(dir, ["status"], "b");

    const v = fleet(dir);
    assert.ok(v.overlaps.length > 0, "a reconciled same-line collision must surface, not show all-clear");
    assert.equal(v.overlaps[0].path, "f.js");
    assert.deepEqual(v.overlaps[0].actors.sort(), ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
