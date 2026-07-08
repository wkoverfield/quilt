// Version staleness: know when the installed Quilt is behind npm, and make
// updating one command.
//
// Why this exists: the first real external user ran a five-versions-stale
// global install (0.3.0, pre-auto-identity) across four terminals, watched
// capture record nothing, and gave up. Nothing ever told him he was stale.
// This module gives `quilt doctor` and `quilt setup` a cached, fail-silent
// latest-version check, and gives `quilt update` the right update command for
// how the CLI was installed.
//
// Hard rules:
//  - Fail-silent and bounded: offline or a slow registry must never error,
//    block, or meaningfully slow a command. Any failure returns null.
//  - Checked at most once per TTL (a day) via a tiny user-level cache file.
//  - NEVER called from the hook path (hook-pre/hook-post) — those run on every
//    edit and must stay fast and offline.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The npm registry endpoint for the published package's latest version. */
export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/@quilt-dev/cli/latest";

/** Re-check the registry at most this often. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a background check may wait on the network before giving up. */
export const CHECK_TIMEOUT_MS = 1500;

/**
 * Versions below this are genuinely broken for fleet use, not merely stale:
 * 0.4.0 added auto-identity (per-session actor ids) and the capture fixes.
 * On anything older, unnamed sessions capture nothing — the exact failure the
 * first external user hit. `quilt doctor` treats below-minimum as not-ready.
 */
export const MIN_SAFE_VERSION = "0.4.0";
export const MIN_SAFE_REASON =
  "versions before 0.4.0 lack auto-identity and the capture fixes (unnamed sessions record nothing)";

/**
 * Compare two dotted versions: -1 if a < b, 0 if equal, 1 if a > b.
 * Numeric per-part compare; a prerelease suffix sorts below its release
 * (1.0.0-rc < 1.0.0). Unparseable parts compare as 0.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [aCore, aPre] = splitPre(a);
  const [bCore, bPre] = splitPre(b);
  const ap = aCore.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bp = bCore.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const d = (ap[i] ?? 0) - (bp[i] ?? 0);
    if (d < 0) return -1;
    if (d > 0) return 1;
  }
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) return aPre < bPre ? -1 : aPre > bPre ? 1 : 0;
  return 0;
}

function splitPre(v: string): [string, string | null] {
  const clean = v.trim().replace(/^v/, "");
  const idx = clean.indexOf("-");
  return idx === -1 ? [clean, null] : [clean.slice(0, idx), clean.slice(idx + 1)];
}

/** Where the installed version stands relative to the published latest. */
export type VersionStanding = "current" | "behind" | "critical";

/** Classify `current` against `latest`. "critical" = below MIN_SAFE_VERSION. */
export function versionStanding(current: string, latest: string): VersionStanding {
  if (compareVersions(current, MIN_SAFE_VERSION) < 0) return "critical";
  return compareVersions(current, latest) < 0 ? "behind" : "current";
}

interface VersionCache {
  /** the latest published version, or null when the last check failed. */
  latest: string | null;
  checkedAt: number;
}

/** The user-level cache file (shared across repos, works pre-`quilt init`). */
export function versionCachePath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "quilt", "latest.json");
}

function readCache(path: string): VersionCache | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as VersionCache;
    if (typeof parsed.checkedAt !== "number") return null;
    return { latest: typeof parsed.latest === "string" ? parsed.latest : null, checkedAt: parsed.checkedAt };
  } catch {
    return null;
  }
}

function writeCache(path: string, cache: VersionCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache));
  } catch {
    /* a cache that can't be written just means we check again next time */
  }
}

export interface CheckLatestOptions {
  cachePath?: string;
  ttlMs?: number;
  timeoutMs?: number;
  /** injectable for tests; defaults to the real registry fetch. */
  fetchLatest?: (timeoutMs: number) => Promise<string | null>;
  now?: number;
}

/** Fetch the latest published version from the npm registry, or null on any
 * failure (offline, timeout, bad response) — never throws. */
export async function fetchLatestFromRegistry(timeoutMs: number): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(REGISTRY_LATEST_URL, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown };
      return typeof body.version === "string" ? body.version : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * The latest published version, from the daily cache or (when the cache is
 * stale) one bounded registry fetch. Returns null when unknown — offline,
 * timed out, or a failed check cached earlier today. Never throws. Failures
 * are cached too, so an offline machine pays the timeout at most once per TTL,
 * not on every doctor run.
 */
export async function checkLatestVersion(opts: CheckLatestOptions = {}): Promise<string | null> {
  const cachePath = opts.cachePath ?? versionCachePath();
  const ttl = opts.ttlMs ?? CHECK_TTL_MS;
  const now = opts.now ?? Date.now();
  const cached = readCache(cachePath);
  if (cached && now - cached.checkedAt < ttl) return cached.latest;
  const fetcher = opts.fetchLatest ?? fetchLatestFromRegistry;
  let latest: string | null = null;
  try {
    latest = await fetcher(opts.timeoutMs ?? CHECK_TIMEOUT_MS);
  } catch {
    latest = null; // a throwing fetcher still counts as a failed (null) check
  }
  writeCache(cachePath, { latest, checkedAt: now });
  return latest;
}

export interface InstallManager {
  /** e.g. "npm", "pnpm", "bun", "yarn", "npx" */
  name: string;
  /** the exact one-line update command for this install. */
  command: string;
  /** false when the right move is to print, not execute (e.g. npx has no
   * persistent install to update). */
  runnable: boolean;
}

export const NPM_UPDATE_COMMAND = "npm install -g @quilt-dev/cli@latest";

/**
 * Detect how this CLI was installed by inspecting the real path of the running
 * entry script. Pattern-based and conservative: a null means "not confident",
 * and the caller should print the likely command instead of executing anything
 * — a git-mutating tool must never rewrite its own binary on a guess.
 */
export function detectInstallManager(entryPath: string = process.argv[1] ?? ""): InstallManager | null {
  let real = entryPath;
  try {
    real = realpathSync(entryPath);
  } catch {
    /* fall back to the raw path */
  }
  const p = real.split("\\").join("/");
  if (p.includes("/_npx/")) {
    return { name: "npx", command: "npx @quilt-dev/cli@latest", runnable: false };
  }
  if (p.includes("/pnpm/") || p.includes("/.pnpm/")) {
    return { name: "pnpm", command: "pnpm add -g @quilt-dev/cli@latest", runnable: true };
  }
  if (p.includes("/.bun/")) {
    return { name: "bun", command: "bun add -g @quilt-dev/cli@latest", runnable: true };
  }
  if (p.includes("/yarn/global/") || p.includes("/.yarn/")) {
    return { name: "yarn", command: "yarn global add @quilt-dev/cli@latest", runnable: true };
  }
  // npm's global tree: <prefix>/lib/node_modules/@quilt-dev/cli (or
  // node_modules directly under an npm prefix on Windows).
  if (p.includes("/lib/node_modules/@quilt-dev/") || p.includes("/npm/node_modules/@quilt-dev/")) {
    return { name: "npm", command: NPM_UPDATE_COMMAND, runnable: true };
  }
  return null;
}
