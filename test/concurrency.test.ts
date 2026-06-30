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

test("per-line commit: two actors APPEND functions to one file (same hunk) and both commit cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "quilt-append-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.io"]);
  g(["config", "user.name", "t"]);
  g(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "helpers.js"), "module.exports = {};\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  spawnSync("node", [CLI, "init"], { cwd: dir });
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    quilt(dir, ["start", "--actor", "B", "--type", "agent"]);
    quilt(dir, ["claim", "helpers.js#alpha"], "A");
    quilt(dir, ["claim", "helpers.js#beta"], "B");

    // Both append their function — adjacent, so they land in ONE diff hunk.
    writeFileSync(
      join(dir, "helpers.js"),
      'module.exports = {};\nfunction alpha() {\n  return "a";\n}\nfunction beta() {\n  return "b";\n}\n',
    );

    assert.equal(quilt(dir, ["commit", "--mine", "-m", "A: alpha"], "A").status, 0);
    let head = spawnSync("git", ["show", "HEAD:helpers.js"], { cwd: dir, encoding: "utf8" }).stdout;
    assert.match(head, /function alpha/, "A committed alpha");
    assert.doesNotMatch(head, /function beta/, "A did NOT commit B's beta");

    assert.equal(quilt(dir, ["commit", "--mine", "-m", "B: beta"], "B").status, 0);
    head = spawnSync("git", ["show", "HEAD:helpers.js"], { cwd: dir, encoding: "utf8" }).stdout;
    assert.match(head, /function alpha/);
    assert.match(head, /function beta/, "both functions committed");
    assert.equal(
      spawnSync("git", ["log", "--pretty=%an", "-2"], { cwd: dir, encoding: "utf8" }).stdout.trim(),
      "B\nA",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two actors editing DIFFERENT symbols in one file: parallel, no contention, no absorb, clean commits", () => {
  const dir = mkdtempSync(join(tmpdir(), "quilt-sym-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.io"]);
  g(["config", "user.name", "t"]);
  g(["config", "commit.gpgsign", "false"]);
  // foo and bar are well separated (padding) so their edits land in distinct hunks.
  const file = (a: string, b: string) =>
    `function foo() {\n  return ${a};\n}\n\n// ----\n// ----\n// ----\n// ----\n// ----\n// ----\n// ----\n\nfunction bar() {\n  return ${b};\n}\n`;
  writeFileSync(join(dir, "utils.js"), file("1", "2"));
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  spawnSync("node", [CLI, "init"], { cwd: dir });
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    quilt(dir, ["start", "--actor", "B", "--type", "agent"]);

    // Symbol claims on different functions both granted (no false contention).
    assert.equal(quilt(dir, ["claim", "utils.js#foo"], "A").status, 0);
    assert.equal(
      quilt(dir, ["claim", "utils.js#bar"], "B").status,
      0,
      "B is NOT blocked by A's claim on a different symbol",
    );

    // Both edit their own function in the shared file (no waiting).
    writeFileSync(join(dir, "utils.js"), file("10", "20"));

    // Attribution stays separated: A owns only foo, B owns only bar.
    assert.match(quilt(dir, ["preview", "--mine"], "A").stdout, /return 10/);
    assert.doesNotMatch(quilt(dir, ["preview", "--mine"], "A").stdout, /return 20/);
    assert.match(quilt(dir, ["preview", "--mine"], "B").stdout, /return 20/);
    assert.doesNotMatch(quilt(dir, ["preview", "--mine"], "B").stdout, /return 10/);

    // Each commits its own symbol cleanly; the other's change stays in the tree.
    assert.equal(quilt(dir, ["commit", "--mine", "-m", "A: foo"], "A").status, 0);
    assert.equal(quilt(dir, ["commit", "--mine", "-m", "B: bar"], "B").status, 0);
    const head = spawnSync("git", ["show", "HEAD:utils.js"], { cwd: dir, encoding: "utf8" }).stdout;
    assert.match(head, /return 10/, "foo change committed");
    assert.match(head, /return 20/, "bar change committed");
    assert.equal(
      spawnSync("git", ["log", "--pretty=%an", "-2"], { cwd: dir, encoding: "utf8" }).stdout.trim(),
      "B\nA",
      "two commits, correctly attributed to B then A",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("symbol claims work off JS too: two actors on different Python functions, no contention", () => {
  const dir = mkdtempSync(join(tmpdir(), "quilt-py-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.io"]);
  g(["config", "user.name", "t"]);
  g(["config", "commit.gpgsign", "false"]);
  // alpha and beta well separated so their edits land in distinct hunks.
  const file = (a: string, b: string) =>
    `def alpha():\n    return ${a}\n\n\n# ----\n# ----\n# ----\n# ----\n# ----\n\n\ndef beta():\n    return ${b}\n`;
  writeFileSync(join(dir, "m.py"), file("1", "2"));
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  spawnSync("node", [CLI, "init"], { cwd: dir });
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    quilt(dir, ["start", "--actor", "B", "--type", "agent"]);

    assert.equal(quilt(dir, ["claim", "m.py#alpha"], "A").status, 0);
    assert.equal(
      quilt(dir, ["claim", "m.py#beta"], "B").status,
      0,
      "B claims a different Python function, not blocked by A",
    );

    writeFileSync(join(dir, "m.py"), file("10", "20"));
    assert.equal(quilt(dir, ["commit", "--mine", "-m", "A: alpha"], "A").status, 0);
    assert.equal(quilt(dir, ["commit", "--mine", "-m", "B: beta"], "B").status, 0);

    const head = spawnSync("git", ["show", "HEAD:m.py"], { cwd: dir, encoding: "utf8" }).stdout;
    assert.match(head, /return 10/, "alpha change committed");
    assert.match(head, /return 20/, "beta change committed");
    assert.equal(
      spawnSync("git", ["log", "--pretty=%an", "-2"], { cwd: dir, encoding: "utf8" }).stdout.trim(),
      "B\nA",
      "two clean Python commits, correctly attributed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
