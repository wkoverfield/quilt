import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { everydayNudge, CHECK_TTL_MS } from "../src/update.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "quilt-nudge-"));
}

/** A fresh cache file (never triggers the detached refresh, so no network). */
function freshCache(dir: string, latest: string | null): string {
  const path = join(dir, "latest.json");
  writeFileSync(path, JSON.stringify({ latest, checkedAt: Date.now() }));
  return path;
}

test("everydayNudge speaks once per TTL when behind, and stays quiet when current", () => {
  const dir = tempDir();
  const cachePath = freshCache(dir, "99.0.0");
  const stampPath = join(dir, "nudged.json");
  const now = Date.now();
  const first = everydayNudge("0.6.1", { cachePath, stampPath, now });
  assert.match(first!, /0\.6\.1 is behind the latest release \(99\.0\.0\)/);
  assert.match(first!, /quilt update/);
  assert.equal(everydayNudge("0.6.1", { cachePath, stampPath, now: now + 1000 }), null, "stamped: quiet for the day");
  assert.match(everydayNudge("0.6.1", { cachePath, stampPath, now: now + CHECK_TTL_MS + 1 })!, /behind/, "next day: nudges again");
  // A newer release than the one already nudged about is news, not a repeat.
  freshCache(dir, "100.0.0");
  assert.match(everydayNudge("0.6.1", { cachePath, stampPath, now: now + 2000 })!, /100\.0\.0/);
  // Current or ahead: nothing, and no stamp written.
  const dir2 = tempDir();
  assert.equal(everydayNudge("99.0.0", { cachePath: freshCache(dir2, "99.0.0"), stampPath: join(dir2, "nudged.json") }), null);
  assert.equal(existsSync(join(dir2, "nudged.json")), false);
  // A cached failed check (null) never nudges.
  const dir3 = tempDir();
  assert.equal(everydayNudge("0.6.1", { cachePath: freshCache(dir3, null), stampPath: join(dir3, "nudged.json") }), null);
});

test("ordinary commands print the nudge on stderr once; hooks and opt-out never do", () => {
  const cacheHome = tempDir();
  mkdirSync(join(cacheHome, "quilt"), { recursive: true });
  freshCache(join(cacheHome, "quilt"), "99.0.0");
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_CACHE_HOME: cacheHome,
    QUILT_TELEMETRY: "0",
    QUILT_TELEMETRY_DIR: tempDir(),
  };
  delete env.QUILT_NO_UPDATE_CHECK;
  const run = (args: string[], extra: Record<string, string> = {}, input?: string) =>
    spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...env, ...extra }, input });

  const hook = run(["hook-pre"], {}, "{}");
  assert.ok(!/behind the latest/.test(hook.stderr), "hook path never nudges");

  const first = run(["telemetry"]);
  assert.match(first.stderr, /behind the latest release \(99\.0\.0\)/, "first ordinary command nudges");
  assert.ok(!/behind the latest/.test(first.stdout), "nudge goes to stderr, never stdout");

  const second = run(["telemetry"]);
  assert.ok(!/behind the latest/.test(second.stderr), "same day: quiet");

  const optOut = run(["telemetry"], { QUILT_NO_UPDATE_CHECK: "1", XDG_CACHE_HOME: tempDir() });
  assert.ok(!/behind the latest/.test(optOut.stderr), "QUILT_NO_UPDATE_CHECK silences it");
});
