import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/state.js";
import { fleetSnapshot } from "../src/fleet.js";
import { initSymbols, ownKey, symbolLocator } from "../src/symbols.js";
import { startUiServer, type UiServer } from "../src/ui.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "quilt-ui-"));
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

/** A repo with two actors, disjoint edits in one file, reconciled. */
function fixture(): string {
  const dir = repo();
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
  q(dir, ["status"], "codex");
  q(dir, ["status"], "claude");
  return dir;
}

async function withServer(dir: string, fn: (ui: UiServer) => Promise<void>): Promise<void> {
  const ui = await startUiServer(new Store(dir), 0);
  try {
    await fn(ui);
  } finally {
    ui.server.close();
  }
}

test("ui: serves the dashboard page and a fleet JSON payload with per-file authorship", async () => {
  const dir = fixture();
  await withServer(dir, async (ui) => {
    const page = await fetch(ui.url + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /Quilt · fleet/);
    assert.match(html, /api\/fleet/);

    const res = await fetch(ui.url + "/api/fleet");
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(typeof d.repo, "string");
    assert.equal(typeof d.head, "string");
    assert.deepEqual(d.actors.map((a: any) => a.id).sort(), ["claude", "codex"]);

    // The who-wrote-what rows: one changed file, both actors credited lines.
    assert.equal(d.files.length, 1);
    const f = d.files[0];
    assert.equal(f.path, "utils.js");
    assert.equal(f.overlap, "none");
    const byId = Object.fromEntries(f.actors.map((a: any) => [a.id, a.lines]));
    assert.ok(byId.codex >= 1, `codex should own lines, got ${JSON.stringify(f.actors)}`);
    assert.ok(byId.claude >= 1, `claude should own lines, got ${JSON.stringify(f.actors)}`);

    const blameRes = await fetch(ui.url + "/api/blame?path=utils.js");
    assert.equal(blameRes.status, 200);
    const blame = await blameRes.json();
    assert.equal(blame.path, "utils.js");
    assert.equal(blame.binary, false);
    assert.ok(blame.lines.some((line: any) => line.type === "add" && line.actors.length === 1));
  });
});

test("ui: refuses non-loopback Host headers (DNS rebinding guard)", async () => {
  const dir = fixture();
  // fetch/undici won't override Host, so speak raw http for this one.
  const status = (port: number, host: string) =>
    new Promise<number>((resolvePromise, rejectPromise) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/api/fleet", headers: { host } },
        (res) => {
          res.resume();
          resolvePromise(res.statusCode ?? 0);
        },
      );
      req.on("error", rejectPromise);
      req.end();
    });
  await withServer(dir, async (ui) => {
    assert.equal(await status(ui.port, "evil.example.com"), 403);
    assert.equal(await status(ui.port, "localhost:9999"), 200);
    assert.equal(await status(ui.port, "127.0.0.1:" + ui.port), 200);
    const blameStatus = (host: string) =>
      new Promise<number>((resolvePromise, rejectPromise) => {
        const req = request(
          { host: "127.0.0.1", port: ui.port, path: "/api/blame?path=utils.js", headers: { host } },
          (res) => { res.resume(); resolvePromise(res.statusCode ?? 0); },
        );
        req.on("error", rejectPromise);
        req.end();
      });
    assert.equal(await blameStatus("evil.example.com"), 403);
  });
});

test("ui: blame endpoint rejects paths outside the repository", async () => {
  const dir = fixture();
  await withServer(dir, async (ui) => {
    assert.equal((await fetch(ui.url + "/api/blame?path=../etc/passwd")).status, 400);
    assert.equal((await fetch(ui.url + "/api/blame?path=/etc/passwd")).status, 400);
  });
});

test("ui: unknown paths 404", async () => {
  const dir = fixture();
  await withServer(dir, async (ui) => {
    const res = await fetch(ui.url + "/etc/passwd");
    assert.equal(res.status, 404);
  });
});

test("ui: falls back to an ephemeral port when the preferred one is taken", async () => {
  const dir = fixture();
  const first = await startUiServer(new Store(dir), 0);
  try {
    const second = await startUiServer(new Store(dir), first.port);
    try {
      assert.notEqual(second.port, first.port);
      const res = await fetch(second.url + "/api/fleet");
      assert.equal(res.status, 200);
    } finally {
      second.server.close();
    }
  } finally {
    first.server.close();
  }
});

test("who-wrote-what credits every contender on a conflicted identical line", async () => {
  // An identical-line conflict stores ONE owner in ownership.files (first
  // claimant) and the full contender list in ownership.conflicts. The per-actor
  // counts must credit all contenders, or the who-wrote-what row silently
  // drops a real author. Built directly with the real key functions because
  // reaching this state end-to-end needs an interleaved double-reconcile.
  const dir = repo();
  write(dir, "notes.txt", "alpha\n");
  commit(dir, "init");
  q(dir, ["init"]);
  await initSymbols();
  const newText = "alpha\nshared line of work\n";
  write(dir, "notes.txt", newText);
  const scope = symbolLocator("notes.txt", newText)(2);
  const key = ownKey(scope, "shared line of work", 1);
  const store = new Store(dir);
  store.writeOwnership({
    files: { "notes.txt": { added: { [key]: "actor-a" }, removed: {} } },
    conflicts: { "notes.txt": { [key]: ["actor-a", "actor-b"] } },
  });
  const view = fleetSnapshot(store, Date.now());
  const row = view.files.find((f) => f.path === "notes.txt");
  assert.ok(row, "notes.txt should have a who-wrote-what row");
  const byId = Object.fromEntries(row!.actors.map((a) => [a.id, a.lines]));
  assert.equal(byId["actor-a"], 1);
  assert.equal(byId["actor-b"], 1, "the second contender must not be dropped");
  assert.equal(row!.overlap, "contended");
});

test("fleet --json includes the files field", () => {
  const dir = fixture();
  const out = q(dir, ["fleet", "--json"]);
  const v = JSON.parse(out.stdout);
  assert.ok(Array.isArray(v.files));
  assert.equal(v.files[0].path, "utils.js");
});
