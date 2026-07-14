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

    // A creates its own file. While B holds a live claim the tree is CONTESTED:
    // an unclaimed, uncaptured file could be anyone's bash write, so inference
    // must NOT hand it to whoever reconciles first (that sweep is the pilot
    // bug). It stays pending until A claims it.
    write(dir, "a-only.js", "const a = 1;\n");
    const aPending = JSON.parse(quilt(dir, ["mine", "--json"], "A").stdout);
    assert.ok(
      !aPending.files.some((f: any) => f.path === "a-only.js"),
      "in a contested tree an unclaimed file stays pending, not auto-owned",
    );

    // Claiming it is what takes ownership — the pending delta is still there.
    quilt(dir, ["claim", "a-only.js"], "A");
    const aMine = JSON.parse(quilt(dir, ["mine", "--json"], "A").stdout);
    const aPaths = aMine.files.map((f: any) => f.path);
    assert.ok(aPaths.includes("a-only.js"), "A owns its file once claimed");
    assert.ok(!aPaths.includes("shared.js"), "A must NOT absorb B's claimed file");
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
    // alpha/beta don't exist yet — forward claims need the explicit opt-in.
    quilt(dir, ["claim", "helpers.js#alpha", "--creating"], "A");
    quilt(dir, ["claim", "helpers.js#beta", "--creating"], "B");

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
    const aPreview = JSON.parse(quilt(dir, ["preview", "--mine", "--json"], "A").stdout);
    assert.equal(aPreview.completeForActor, true, "foreign adjacent work is not falsely reported as withheld");
    assert.deepEqual(aPreview.blockedFiles, []);

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

// Pilot round 2: ui-agent's commit --mine swept seven of data-agent's
// uncommitted convex files — bash/CLI-written (never captured), never claimed.
// The contested-tree gate must keep them out of ui-agent's commit, and let
// data-agent take them by claiming.
test("commit --mine never sweeps another agent's uncaptured bash-written files while claims are live", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["init"]);

    // data-agent is visibly mid-work (a live claim on its schema)...
    write(dir, "schema.ts", "export const schema = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: dir, encoding: "utf8" });
    quilt(dir, ["claim", "schema.ts", "--intent", "data model"], "data-agent");

    // ...and its CLI codegen drops files capture never sees.
    for (let i = 1; i <= 7; i++) write(dir, `gen${i}.ts`, `export const g${i} = ${i};\n`);

    // ui-agent does its own (claimed) work and commits.
    write(dir, "ui.ts", "export const ui = 1;\n");
    quilt(dir, ["claim", "ui.ts", "--intent", "build UI"], "ui-agent");
    const c = quilt(dir, ["commit", "--mine", "-m", "ui work"], "ui-agent");
    assert.equal(c.status, 0, c.stderr);
    const committed = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: dir, encoding: "utf8",
    }).stdout.trim().split("\n");
    assert.deepEqual(committed, ["ui.ts"], "ui-agent commits ONLY its claimed file — no sweep");

    // data-agent claims its generated files and takes ownership of the pending deltas.
    quilt(dir, ["claim", "gen1.ts", "gen2.ts", "gen3.ts", "gen4.ts", "gen5.ts", "gen6.ts", "gen7.ts"], "data-agent");
    const d = quilt(dir, ["commit", "--mine", "-m", "data work"], "data-agent");
    assert.equal(d.status, 0, d.stderr);
    const dataCommitted = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: dir, encoding: "utf8",
    }).stdout.trim().split("\n").sort();
    assert.deepEqual(
      dataCommitted,
      ["gen1.ts", "gen2.ts", "gen3.ts", "gen4.ts", "gen5.ts", "gen6.ts", "gen7.ts"],
      "data-agent's claim takes the pending files",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pilot round 3, bug 2: a partial commit tore a function apart — one of its
// lines was excluded (unattributed) while its siblings committed, landing a
// syntax error in history. A torn symbol must withhold the whole file.
test("commit --mine withholds a file rather than tear a symbol (no committed syntax errors)", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["start", "--actor", "A", "--type", "agent"]);
    write(
      dir,
      "shared.js",
      "function f() { return 1; }\nfunction g() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n",
    );
    // Simulate the pilot's split directly: the ledger attributes ONE of g's
    // new lines to A; g's other new lines stay unattributed (B's live claim
    // elsewhere keeps the contested-tree gate from handing them to A).
    const ledger =
      JSON.stringify({
        seq: 0,
        ts: new Date().toISOString(),
        actor: "A",
        path: "shared.js",
        added: ["  const a = 1;"],
        removed: [],
        addedKeys: ["g\u0000  const a = 1;"],
        anchor: null,
        preHash: null,
      }) + "\n";
    writeFileSync(join(dir, ".quilt", "authorship.log"), ledger);
    quilt(dir, ["claim", "elsewhere.js"], "B");

    const c = quilt(dir, ["commit", "--mine", "-m", "A partial"], "A");
    // A owns one line inside g but not g's other new lines → tear → the file
    // is withheld entirely (nothing committable → nonzero exit).
    assert.notEqual(c.status, 0, "torn file must not commit");
    const head = spawnSync("git", ["show", "HEAD:shared.js"], { cwd: dir, encoding: "utf8" });
    assert.doesNotMatch(head.stdout, /const a = 1;/, "no torn fragment of g landed in history");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The contested-tree gate must not blind clobber DETECTION: an overwrite of
// another actor's uncommitted lines in an unclaimed file is still caught and
// preserved even while an unrelated claim is live somewhere else in the repo.
test("clobber detection still fires in a gated file while unrelated claims are live", () => {
  const dir = makeRepo();
  try {
    // B edits shared.js and reconciles once (uncontested) — B owns the line
    // and the observed baseline carries B's version.
    write(dir, "shared.js", "function f() { return 42; }\n");
    quilt(dir, ["status"], "B");

    // An unrelated live claim then makes the whole tree contested for C.
    quilt(dir, ["claim", "unrelated.ts"], "A");

    // C bulldozes B's line. C's reconcile (via status) is gated for shared.js —
    // but the overwrite must still be detected and B's content preserved.
    write(dir, "shared.js", "function f() { return 0; }\n");
    quilt(dir, ["status"], "C");
    const clobbers = JSON.parse(readFileSync(join(dir, ".quilt", "clobbers.json"), "utf8"));
    const hit = clobbers.clobbers.find((x: any) => x.victimActor === "B" && !x.restored);
    assert.ok(hit, "the overwrite of B's captured line was detected despite the gate");

    // And it doesn't duplicate on the next reconcile (frozen baseline re-sees the delta).
    quilt(dir, ["status"], "C");
    const again = JSON.parse(readFileSync(join(dir, ".quilt", "clobbers.json"), "utf8"));
    assert.equal(
      again.clobbers.filter((x: any) => x.victimActor === "B" && x.path === "shared.js").length,
      1,
      "one open clobber per victim+path, not one per reconcile",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Dogfood fix 1b: includeUnclaimed must never sweep hunks on a path another
// actor has CLAIMED — external edits attribute lazily, so a peer's mid-flight
// hunks can read "unclaimed" while their claim is listed in the same response.
test("commit --mine --include-unclaimed refuses hunks on another actor's claimed path", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["init"]);
    // B claims data.ts and writes it externally (no capture — the lazy path).
    quilt(dir, ["claim", "data.ts", "--intent", "data layer"], "B");
    write(dir, "data.ts", "export const rows = [];\n");
    // A does its own claimed work, then tries the sweep flag.
    quilt(dir, ["claim", "ui.ts"], "A");
    write(dir, "ui.ts", "export const ui = 1;\n");
    const c = quilt(dir, ["commit", "--mine", "--include-unclaimed", "-m", "A sweep attempt"], "A");
    assert.equal(c.status, 0, c.stderr);
    const committed = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: dir, encoding: "utf8",
    }).stdout.trim().split("\n");
    assert.deepEqual(committed, ["ui.ts"], "B's claimed in-flight file stays out even with the flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Dogfood fix 1c: the READ layer tells the truth mid-flight — a peer's
// uncaptured hunks on their claimed path read as THEIRS (attribution
// pending), not as "unclaimed".
test("status classes a peer's uncaptured hunks on their claimed path as theirs, not unclaimed", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["init"]);
    quilt(dir, ["claim", "feature.ts", "--intent", "building feature"], "B");
    write(dir, "feature.ts", "export const wip = true;\n");
    const st = JSON.parse(quilt(dir, ["status", "--json"], "A").stdout);
    const f = st.files.find((x: any) => x.path === "feature.ts");
    assert.ok(f, "file visible");
    assert.equal(f.class, "other", "claimed-by-B reads as B's, not unclaimed");
    assert.deepEqual(f.actors, ["B"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Dogfood fix 2: clobber correctness. Rewriting COMMITTED lines is normal
// editing — landed history is not clobberable.
test("rewriting committed-at-HEAD lines never fires a clobber", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["init"]);
    // B authors a line and commits it — it's landed history now.
    quilt(dir, ["claim", "shared.js"], "B");
    write(dir, "shared.js", "function f() { return 2; }\n");
    quilt(dir, ["status"], "B");
    assert.equal(quilt(dir, ["commit", "--mine", "-m", "B lands"], "B").status, 0);
    // A rewrites the landed line (a routine refactor).
    quilt(dir, ["claim", "shared.js"], "A");
    write(dir, "shared.js", "function f() { return 3; }\n");
    quilt(dir, ["status"], "A");
    let clobbers = { clobbers: [] as any[] };
    try {
      clobbers = JSON.parse(readFileSync(join(dir, ".quilt", "clobbers.json"), "utf8"));
    } catch {
      /* file never created = no clobbers ever fired — exactly right */
    }
    assert.equal(
      clobbers.clobbers.filter((c: any) => !c.restored).length,
      0,
      "no clobber for rewriting landed code",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Dogfood fix 2b: a stale open clobber whose victim lines exist at HEAD is
// describing work that LANDED — it auto-resolves instead of alarming every
// future actor.
test("a stale clobber whose victim lines landed at HEAD auto-resolves on reconcile", () => {
  const dir = makeRepo();
  try {
    quilt(dir, ["init"]);
    // Plant an old open clobber whose sample line is exactly what HEAD holds.
    const stale = {
      clobbers: [{
        id: "stale1", ts: new Date(0).toISOString(), path: "shared.js",
        victimActor: "B", byActor: "A", snapshotId: "none",
        sampleLines: ["function f() { return 1; }"], restored: false,
      }],
    };
    writeFileSync(join(dir, ".quilt", "clobbers.json"), JSON.stringify(stale));
    quilt(dir, ["status"], "A");
    const after = JSON.parse(readFileSync(join(dir, ".quilt", "clobbers.json"), "utf8"));
    assert.equal(after.clobbers[0].restored, true, "landed work is not a live alarm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
