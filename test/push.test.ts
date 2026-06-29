import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initSymbols, symbolReferences } from "../src/symbols.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "dist", "cli.js");

before(async () => {
  await initSymbols();
});

// --- symbolReferences unit ---

test("symbolReferences records call-expression callees per enclosing symbol", () => {
  const src =
    "function caller() {\n  return api(2) + helper();\n}\n" +
    "function api(x) {\n  return x;\n}\n" +
    "function helper() {\n  return 1;\n}\n";
  const refs = symbolReferences("m.js", src);
  assert.deepEqual([...(refs.get("caller") ?? [])].sort(), ["api", "helper"]);
  assert.equal(refs.has("api"), false, "api references nothing");
});

test("symbolReferences captures imported (cross-file) callees by name", () => {
  const src =
    'import { api } from "./api.js";\n' +
    "export function caller() {\n  return api(7);\n}\n";
  const refs = symbolReferences("main.js", src);
  assert.deepEqual([...(refs.get("caller") ?? [])], ["api"]);
});

test("a self-recursive call is not a self-dependency", () => {
  const refs = symbolReferences("r.js", "function fib(n) {\n  return fib(n - 1);\n}\n");
  assert.equal(refs.has("fib"), false);
});

// --- end-to-end push-awareness via the CLI ---

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-push-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.io"]);
  g(["config", "user.name", "t"]);
  g(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "api.js"), "export function api(x) {\n  return x;\n}\n");
  writeFileSync(
    join(dir, "main.js"),
    'import { api } from "./api.js";\nexport function caller() {\n  return api(2);\n}\n',
  );
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base"]);
  spawnSync("node", [CLI, "init"], { cwd: dir });
  return dir;
}

function quilt(dir: string, args: string[], actor?: string) {
  const env = { ...process.env, ...(actor ? { QUILT_ACTOR: actor } : {}) };
  const r = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("claiming a dependent symbol warns that its dependency is being changed", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"], "A");
    quilt(dir, ["start", "--actor", "B", "--type", "agent"], "B");

    // A reserves the upstream signature.
    assert.equal(quilt(dir, ["claim", "api.js#api"], "A").status, 0);

    // B reserves a caller that depends on api — should be told at claim time.
    const bClaim = quilt(dir, ["claim", "main.js#caller"], "B");
    assert.equal(bClaim.status, 0, "B's claim on a different symbol is still granted");
    assert.match(bClaim.stdout, /heads-up/, "B is warned proactively");
    assert.match(bClaim.stdout, /depends on api/);
    assert.match(bClaim.stdout, /A is changing/);

    // The same warning is available in JSON for agents.
    const statusJson = JSON.parse(quilt(dir, ["status", "--json"], "B").stdout);
    assert.equal(statusJson.dependencyWarnings.length, 1);
    assert.equal(statusJson.dependencyWarnings[0].dependency, "api");
    assert.equal(statusJson.dependencyWarnings[0].heldBy, "A");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no warning when the dependency is not claimed by anyone else", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "B", "--type", "agent"], "B");
    const bClaim = quilt(dir, ["claim", "main.js#caller"], "B");
    assert.doesNotMatch(bClaim.stdout, /heads-up/, "nothing to warn about");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim targets that escape the repo are rejected, never read", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"], "A");
    for (const bad of ["../../../../etc/passwd#root", "/etc/passwd#root", "../secret.txt"]) {
      const r = quilt(dir, ["claim", bad], "A");
      assert.notEqual(r.status, 0, `${bad} must be denied (non-zero exit)`);
      assert.match(r.stdout, /outside the repository/, `${bad} reason surfaced`);
    }
    // The rejected targets are not persisted as claims.
    const claims = JSON.parse(quilt(dir, ["claim", "--json"], "A").stdout).claims;
    assert.equal(claims.length, 0, "no out-of-repo claim was stored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
