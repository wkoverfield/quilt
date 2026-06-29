import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "dist", "cli.js");

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-conc-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.io"]);
  g(["config", "user.name", "t"]);
  g(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "shared.js"), "function f() { return 1; }\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  spawnSync("node", [CLI, "init"], { cwd: dir });
  return dir;
}
function quilt(dir: string, args: string[], actor?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (actor) env.QUILT_ACTOR = actor;
  const r = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function write(dir: string, rel: string, c: string): void {
  writeFileSync(join(dir, rel), c);
}

test("a file claimed by B is NOT absorbed by A's reconcile or commit", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    quilt(dir, ["start", "--actor", "B", "--type", "agent"]);

    // B reserves shared.js and edits it, but hasn't run a quilt command yet.
    quilt(dir, ["claim", "shared.js"], "B");
    write(dir, "shared.js", "function f() { return 2; }\n");

    // A creates its own file, then reconciles by running status/commit FIRST.
    write(dir, "a-only.js", "const a = 1;\n");
    const aMine = JSON.parse(quilt(dir, ["mine", "--json"], "A").stdout);
    const aPaths = aMine.files.map((f: any) => f.path);
    assert.ok(aPaths.includes("a-only.js"), "A owns its own file");
    assert.ok(!aPaths.includes("shared.js"), "A must NOT absorb B's claimed file");

    // A commits — must not sweep up B's shared.js.
    quilt(dir, ["claim", "a-only.js"], "A");
    const aCommit = quilt(dir, ["commit", "--mine", "-m", "A work"], "A");
    assert.equal(aCommit.status, 0, aCommit.stderr);
    assert.equal(
      spawnSync("git", ["show", "HEAD:shared.js"], { cwd: dir, encoding: "utf8" }).stdout,
      "function f() { return 1; }\n",
      "shared.js was NOT committed by A",
    );

    // Now B reconciles — B owns its own edit to shared.js.
    const bMine = JSON.parse(quilt(dir, ["mine", "--json"], "B").stdout);
    assert.ok(
      bMine.files.some((f: any) => f.path === "shared.js"),
      "B owns its edit to shared.js",
    );
    const bCommit = quilt(dir, ["commit", "--mine", "-m", "B work"], "B");
    assert.equal(bCommit.status, 0, bCommit.stderr);
    assert.match(
      spawnSync("git", ["show", "HEAD:shared.js"], { cwd: dir, encoding: "utf8" }).stdout,
      /return 2/,
      "B's edit committed under B",
    );
    assert.equal(
      spawnSync("git", ["log", "-1", "--pretty=%an", "--", "shared.js"], {
        cwd: dir,
        encoding: "utf8",
      }).stdout.trim(),
      "B",
      "shared.js attributed to B, not A",
    );

    // Post-release cleanup: B released its claim on commit. A's next reconcile
    // should now see shared.js as fully committed (no diff) and carry no phantom
    // ownership of it — confirming the earlier skip left no stale baseline.
    quilt(dir, ["release", "shared.js"], "B");
    const aMineAfter = JSON.parse(quilt(dir, ["mine", "--json"], "A").stdout);
    assert.ok(
      !aMineAfter.files.some((f: any) => f.path === "shared.js"),
      "A has no phantom ownership of shared.js after B committed + released",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
