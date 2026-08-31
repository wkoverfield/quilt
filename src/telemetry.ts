import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { VERSION } from "./version.js";

/**
 * Anonymous usage telemetry, in two tiers. The rules, in order of importance:
 *
 * 1. Two tiers, one kill switch. The daily HEARTBEAT (version, OS, random id,
 *    nothing else) is on by default so "is anyone still using this" has an
 *    answer. COMMAND EVENTS (which commands run, small counts) stay opt-in:
 *    off until a human says yes at `quilt setup`, asked once, on a TTY only.
 *    Saying no — ever, in any version — turns off both tiers. So do
 *    QUILT_TELEMETRY=0, DO_NOT_TRACK, or `quilt telemetry off`.
 * 2. Counts, never content. Payloads carry an event name, a random anonymous
 *    id, the quilt version, platform, and small numeric counts. Never repo
 *    names, file paths, actor ids, branch names, commit messages, or code.
 * 3. Never in the way. Payloads are posted by a detached child process so the
 *    CLI's exit is never delayed, failures are silent, and the hot hook path
 *    (hook-pre/hook-post and friends) is never instrumented.
 *
 * Precedence when signals disagree: QUILT_TELEMETRY (explicit, per-process,
 * both directions) beats DO_NOT_TRACK, which beats CI, which beats the stored
 * decision, which beats the tier default.
 */

interface TelemetryConfig {
  /** Random UUID, generated locally, meaningless outside these events. */
  anonymousId: string;
  /** The stored consent decision for command events; absent = never asked. */
  enabled?: boolean;
  decidedAt?: string;
}

const POSTHOG_ENDPOINT = "https://us.i.posthog.com/i/v0/e/";
// PostHog write-only project token: safe to ship in an OSS client by design
// (it can only ingest events, never read anything back).
const POSTHOG_KEY = "phc_QUILT_PROJECT_KEY_TBD";
/** Process-scoped fallback for a payload built before any id was persisted. */
const ephemeralAnonymousId = randomUUID();

/** Heartbeats fire at most once per this window, per machine. */
export const HEARTBEAT_TTL_MS = 24 * 60 * 60 * 1000;

/** Config dir override for tests; XDG-respecting default otherwise. */
function configDir(): string {
  if (process.env.QUILT_TELEMETRY_DIR) return process.env.QUILT_TELEMETRY_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config"), "quilt");
}

function configPath(): string {
  return join(configDir(), "telemetry.json");
}

function heartbeatPath(): string {
  return join(configDir(), "heartbeat.json");
}

export function readTelemetryConfig(): TelemetryConfig | null {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TelemetryConfig>;
    if (typeof parsed.anonymousId !== "string") return null;
    return {
      anonymousId: parsed.anonymousId,
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : undefined,
      decidedAt: typeof parsed.decidedAt === "string" ? parsed.decidedAt : undefined,
    };
  } catch {
    return null;
  }
}

export function writeTelemetryConfig(enabled: boolean): TelemetryConfig {
  const config: TelemetryConfig = {
    anonymousId: readTelemetryConfig()?.anonymousId ?? randomUUID(),
    enabled,
    decidedAt: new Date().toISOString(),
  };
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n");
  return config;
}

/**
 * The persistent anonymous id, minted on first need. Independent of the
 * consent decision: the heartbeat needs a stable id before anyone has been
 * asked anything, and opt-out/opt-in toggles must never mint new ids.
 */
export function ensureAnonymousId(): string {
  const existing = readTelemetryConfig();
  if (existing) return existing.anonymousId;
  const config: TelemetryConfig = { anonymousId: randomUUID() };
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n");
  } catch {
    return ephemeralAnonymousId;
  }
  return config.anonymousId;
}

/** Has the user ever answered the opt-in question (either way)? */
export function telemetryDecided(): boolean {
  return typeof readTelemetryConfig()?.enabled === "boolean";
}

type Tier = "event" | "heartbeat";

function allowed(tier: Tier): boolean {
  const env = process.env.QUILT_TELEMETRY;
  if (env === "0" || env === "off" || env === "false") return false;
  if (env === "1" || env === "on" || env === "true") return true;
  const dnt = process.env.DO_NOT_TRACK;
  if (dnt !== undefined && dnt !== "" && dnt !== "0" && dnt !== "false") return false;
  if (process.env.CI) return false;
  const decision = readTelemetryConfig()?.enabled;
  if (decision === false) return false;
  if (tier === "event") return decision === true;
  return true;
}

/** Effective on/off for command events: opt-in, so off until someone said yes. */
export function telemetryEnabled(): boolean {
  return allowed("event");
}

/** Effective on/off for the daily heartbeat: on unless someone said no. */
export function heartbeatEnabled(): boolean {
  return allowed("heartbeat");
}

/** Event property allow-list enforcement: values must be small scalars. */
type EventProps = Record<string, string | number | boolean>;

export function buildEventPayload(event: string, props: EventProps = {}): object {
  return {
    api_key: POSTHOG_KEY,
    event,
    distinct_id: readTelemetryConfig()?.anonymousId ?? ephemeralAnonymousId,
    properties: {
      $process_person_profile: false,
      quilt_version: VERSION,
      platform: process.platform,
      node_major: Number(process.versions.node.split(".")[0]),
      ...props,
    },
  };
}

/**
 * POST a payload from a detached child process (stdio ignored, unref'd), so a
 * short-lived CLI command never waits on the network and a dead endpoint
 * costs nothing.
 */
function postDetached(payload: object): void {
  try {
    const body = JSON.stringify(payload);
    const endpoint = process.env.QUILT_TELEMETRY_ENDPOINT ?? POSTHOG_ENDPOINT;
    // The child gets the payload via env (not argv, which is visible in ps).
    const script =
      'fetch(process.env.QUILT_T_URL,{method:"POST",headers:{"Content-Type":"application/json"},' +
      "body:process.env.QUILT_T_BODY,signal:AbortSignal.timeout(4000)}).catch(()=>{})" +
      ".finally(()=>process.exit(0))";
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { QUILT_T_URL: endpoint, QUILT_T_BODY: body },
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Telemetry must never break, slow down, or noisy up the actual work.
  }
}

/** Record a command event and return immediately. No-op unless opted in. */
export function recordEvent(event: string, props: EventProps = {}): void {
  if (!telemetryEnabled()) return;
  postDetached(buildEventPayload(event, props));
}

/**
 * Send the daily heartbeat if one is due. The TTL stamp is claimed before the
 * POST: a failed send costs one quiet day rather than risking duplicates or
 * retries, and this function must stay safe to call from every command entry.
 * The stamp file is machine-global and quilt commands run concurrently, so
 * the claim uses exclusive-create ("wx"): stale stamps are removed and the
 * one process that recreates the file sends; EEXIST losers stay silent.
 */
export function maybeSendHeartbeat(): void {
  if (!heartbeatEnabled()) return;
  try {
    if (existsSync(heartbeatPath())) {
      try {
        const raw = JSON.parse(readFileSync(heartbeatPath(), "utf8")) as { lastSentAt?: string };
        const last = raw.lastSentAt ? Date.parse(raw.lastSentAt) : Number.NaN;
        if (Number.isFinite(last) && Date.now() - last < HEARTBEAT_TTL_MS) return;
      } catch {
        // A corrupt stamp (truncated write, manual edit) must not disable the
        // heartbeat forever: treat it as stale and fall through to replace it.
      }
      rmSync(heartbeatPath(), { force: true });
    }
    mkdirSync(configDir(), { recursive: true });
    let fd: number;
    try {
      fd = openSync(heartbeatPath(), "wx");
    } catch {
      return; // a concurrent quilt process claimed today's heartbeat first
    }
    try {
      writeSync(fd, JSON.stringify({ lastSentAt: new Date().toISOString() }) + "\n");
    } finally {
      closeSync(fd);
    }
    ensureAnonymousId();
    postDetached(buildEventPayload("quilt_heartbeat"));
  } catch {
    // Same rule as postDetached: never break the actual work.
  }
}

/** Plain-words description of both tiers, shown wherever telemetry comes up. */
export const TELEMETRY_DISCLOSURE =
  "Daily heartbeat (on by default): quilt version, OS, node major, random id.\n" +
  "  Command events (opt-in): which commands run and granted/denied/queued counts.\n" +
  "  Never code, file paths, repo or actor names, or commit messages.\n" +
  "  Everything off: quilt telemetry off (or QUILT_TELEMETRY=0, or DO_NOT_TRACK=1)";

/**
 * The one-time command-events opt-in question, asked only at `quilt setup`,
 * only on an interactive TTY, only if never answered, and never in CI.
 * Records the decision either way so it is never asked twice. Returns the
 * decision, or null when the environment made asking inappropriate.
 */
export async function maybePromptForTelemetry(): Promise<boolean | null> {
  if (telemetryDecided()) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  if (process.env.CI) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolvePromise) => {
      rl.question(
        "\nAlso share anonymous command counts to help improve Quilt? [y/N]\n" +
          "  " + TELEMETRY_DISCLOSURE.split("\n").join("\n") + "\n> ",
        resolvePromise,
      );
      // A closed stdin (Ctrl-D) resolves as "no answer" rather than hanging.
      rl.once("close", () => resolvePromise(""));
    });
    const enabled = /^y(es)?$/i.test(answer.trim());
    writeTelemetryConfig(enabled);
    return enabled;
  } catch {
    return null;
  } finally {
    rl.close();
  }
}
