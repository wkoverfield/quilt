import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLatestVersion,
  compareVersions,
  detectInstallManager,
  versionStanding,
  MIN_SAFE_VERSION,
} from "../src/update.js";

// --- compareVersions ---

test("compareVersions orders plain and prerelease versions", () => {
  assert.equal(compareVersions("0.4.3", "0.4.4"), -1);
  assert.equal(compareVersions("0.4.4", "0.4.4"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.3.0", MIN_SAFE_VERSION), -1);
  assert.equal(compareVersions("v0.4.4", "0.4.4"), 0, "a leading v is tolerated");
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1, "prerelease sorts below its release");
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
});

test("versionStanding: current / behind / critical", () => {
  assert.equal(versionStanding("0.4.4", "0.4.4"), "current");
  assert.equal(versionStanding("0.4.5", "0.4.4"), "current", "ahead of the registry is not 'behind'");
  assert.equal(versionStanding("0.4.3", "0.4.4"), "behind");
  // Below 0.4.0 is critical regardless of gap size: no auto-identity at all.
  assert.equal(versionStanding("0.3.0", "0.4.4"), "critical");
});

// --- checkLatestVersion: cache, TTL, and fail-silence ---

function cacheDir(): string {
  return mkdtempSync(join(tmpdir(), "quilt-update-"));
}

test("checkLatestVersion fetches once, then serves the daily cache", async () => {
  const dir = cacheDir();
  const cachePath = join(dir, "latest.json");
  try {
    let fetches = 0;
    const fetchLatest = async () => {
      fetches++;
      return "9.9.9";
    };
    assert.equal(await checkLatestVersion({ cachePath, fetchLatest, now: 1000 }), "9.9.9");
    assert.equal(await checkLatestVersion({ cachePath, fetchLatest, now: 2000 }), "9.9.9");
    assert.equal(fetches, 1, "the second call inside the TTL never touches the network");
    // Past the TTL it re-checks.
    assert.equal(await checkLatestVersion({ cachePath, fetchLatest, ttlMs: 500, now: 5000 }), "9.9.9");
    assert.equal(fetches, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkLatestVersion is fail-silent offline: null result, failure cached, no throw", async () => {
  const dir = cacheDir();
  const cachePath = join(dir, "latest.json");
  try {
    let fetches = 0;
    const failing = async () => {
      fetches++;
      throw new Error("ENETDOWN");
    };
    // A throwing fetcher must never propagate.
    assert.equal(await checkLatestVersion({ cachePath, fetchLatest: failing, now: 1000 }), null);
    // The failure is cached too: an offline machine pays the check once per
    // TTL, not on every doctor/setup run.
    assert.equal(await checkLatestVersion({ cachePath, fetchLatest: failing, now: 2000 }), null);
    assert.equal(fetches, 1, "the failed check is cached for the TTL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkLatestVersion tolerates a corrupt cache file", async () => {
  const dir = cacheDir();
  const cachePath = join(dir, "latest.json");
  try {
    writeFileSync(cachePath, "{ nope");
    const got = await checkLatestVersion({ cachePath, fetchLatest: async () => "1.2.3", now: 1000 });
    assert.equal(got, "1.2.3");
    assert.match(readFileSync(cachePath, "utf8"), /1\.2\.3/, "the cache heals itself");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- detectInstallManager ---

test("detectInstallManager recognizes the common global installs and stays null on a guess", () => {
  const npm = detectInstallManager("/opt/homebrew/lib/node_modules/@quilt-dev/cli/dist/cli.js");
  assert.equal(npm?.name, "npm");
  assert.ok(npm?.runnable);

  const pnpm = detectInstallManager("/Users/x/Library/pnpm/global/5/.pnpm/@quilt-dev+cli@0.4.3/node_modules/@quilt-dev/cli/dist/cli.js");
  assert.equal(pnpm?.name, "pnpm");

  const bun = detectInstallManager("/Users/x/.bun/install/global/node_modules/@quilt-dev/cli/dist/cli.js");
  assert.equal(bun?.name, "bun");

  const npx = detectInstallManager("/Users/x/.npm/_npx/abc123/node_modules/@quilt-dev/cli/dist/cli.js");
  assert.equal(npx?.name, "npx");
  assert.equal(npx?.runnable, false, "npx has no persistent install to update");

  // A repo checkout (dev) matches nothing — the CLI must print, not run.
  assert.equal(detectInstallManager("/Users/x/code/quilt/dist/cli.js"), null);
});
