import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { VERSION } from "./version.js";

/**
 * Opt-in, anonymous usage telemetry. The rules, in order of importance:
 *
 * 1. OFF until a human says yes. The only prompt is at `quilt setup`, on a
 *    TTY, once. No answer (or a non-interactive run) means off, and we never
 *    nag: the decision is stored either way.
 * 2. Counts, never content. Events carry an event name, a random anonymous
 *    id, the quilt version, platform, and small numeric counts. Never repo
 *    names, file paths, actor ids, branch names, commit messages, or code.
 * 3. Never in the way. Events are posted by a detached child process so the
 *    CLI's exit is never delayed, failures are silent, and the hot hook path
 *    (hook-pre/hook-post) is never instrumented.
 *
 * Kill switches: `quilt telemetry off`, or QUILT_TELEMETRY=0 in the
 * environment (wins over the stored decision, useful for CI). QUILT_TELEMETRY=1
 * force-enables for a process the same way.
 */

interface TelemetryConfig {
  enabled: boolean;
  /** Random UUID, generated locally, meaningless outside these events. */
  anonymousId: string;
  decidedAt: string;
}

const POSTHOG_ENDPOINT = "https://us.i.posthog.com/i/v0/e/";
// PostHog write-only project token: safe to ship in an OSS client by design
// (it can only ingest events, never read anything back).
const POSTHOG_KEY = "phc_7aGIe4BBqxv2qxtftFdi83so2t5LrV0UBFqZaYsOz9w";

/** Config dir override for tests; XDG-respecting default otherwise. */
function configDir(): string {
  if (process.env.QUILT_TELEMETRY_DIR) return process.env.QUILT_TELEMETRY_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config"), "quilt");
}

function configPath(): string {
  return join(configDir(), "telemetry.json");
}

export function readTelemetryConfig(): TelemetryConfig | null {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TelemetryConfig>;
    if (typeof parsed.enabled !== "boolean" || typeof parsed.anonymousId !== "string") return null;
    return {
      enabled: parsed.enabled,
      anonymousId: parsed.anonymousId,
      decidedAt: typeof parsed.decidedAt === "string" ? parsed.decidedAt : "",
    };
  } catch {
    return null;
  }
}

export function writeTelemetryConfig(enabled: boolean): TelemetryConfig {
  const config: TelemetryConfig = {
    enabled,
    anonymousId: readTelemetryConfig()?.anonymousId ?? randomUUID(),
    decidedAt: new Date().toISOString(),
  };
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n");
  return config;
}

/** Has the user ever answered the opt-in question (either way)? */
export function telemetryDecided(): boolean {
  return readTelemetryConfig() !== null;
}

/** Effective on/off: env kill switch first, then the stored decision. */
export function telemetryEnabled(): boolean {
  const env = process.env.QUILT_TELEMETRY;
  if (env === "0" || env === "off" || env === "false") return false;
  if (env === "1" || env === "on" || env === "true") return true;
  return readTelemetryConfig()?.enabled === true;
}

/** Event property allow-list enforcement: values must be small scalars. */
type EventProps = Record<string, string | number | boolean>;

export function buildEventPayload(event: string, props: EventProps = {}): object {
  return {
    api_key: POSTHOG_KEY,
    event,
    distinct_id: readTelemetryConfig()?.anonymousId ?? "undecided",
    properties: {
      quilt_version: VERSION,
      platform: process.platform,
      node_major: Number(process.versions.node.split(".")[0]),
      ...props,
    },
  };
}

/**
 * Record an event and return immediately. The POST happens in a detached
 * child process (stdio ignored, unref'd), so a short-lived CLI command never
 * waits on the network and a dead endpoint costs nothing. No-op unless
 * telemetry is enabled.
 */
export function recordEvent(event: string, props: EventProps = {}): void {
  if (!telemetryEnabled()) return;
  try {
    const payload = JSON.stringify(buildEventPayload(event, props));
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
      env: { QUILT_T_URL: endpoint, QUILT_T_BODY: payload },
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Telemetry must never break, slow down, or noisy up the actual work.
  }
}

/** One-line, plain-words description of what is (and is not) collected. */
export const TELEMETRY_DISCLOSURE =
  "Anonymous usage counts only (which commands run, granted/denied/queued totals,\n" +
  "  quilt version, OS). Never code, file paths, repo or actor names, or commit\n" +
  "  messages. Off by default; change any time: quilt telemetry on|off";

/**
 * The one-time opt-in question, asked only at `quilt setup`, only on an
 * interactive TTY, only if never answered, and never in CI. Records the
 * decision either way so it is never asked twice. Returns the decision, or
 * null when the environment made asking inappropriate.
 */
export async function maybePromptForTelemetry(): Promise<boolean | null> {
  if (telemetryDecided()) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  if (process.env.CI) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolvePromise) => {
      rl.question(
        "\nShare anonymous usage counts to help improve Quilt? [y/N]\n" +
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
