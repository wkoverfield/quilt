import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEventPayload,
  readTelemetryConfig,
  recordEvent,
  telemetryDecided,
  telemetryEnabled,
  writeTelemetryConfig,
} from "../src/telemetry.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "quilt-telemetry-"));
}

/** Run a block with QUILT_TELEMETRY* env pinned, restoring after. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("telemetry is off until someone says yes, and the decision persists", () => {
  const dir = tempDir();
  withEnv({ QUILT_TELEMETRY_DIR: dir, QUILT_TELEMETRY: undefined }, () => {
    assert.equal(telemetryDecided(), false);
    assert.equal(telemetryEnabled(), false);
    writeTelemetryConfig(true);
    assert.equal(telemetryDecided(), true);
    assert.equal(telemetryEnabled(), true);
    const id = readTelemetryConfig()!.anonymousId;
    writeTelemetryConfig(false);
    assert.equal(telemetryEnabled(), false);
    // The anonymous id survives toggling, so opt-out/opt-in doesn't mint ids.
    assert.equal(readTelemetryConfig()!.anonymousId, id);
  });
});

test("QUILT_TELEMETRY env kill switch beats the stored decision, both ways", () => {
  const dir = tempDir();
  withEnv({ QUILT_TELEMETRY_DIR: dir }, () => {
    writeTelemetryConfig(true);
    withEnv({ QUILT_TELEMETRY: "0" }, () => assert.equal(telemetryEnabled(), false));
    writeTelemetryConfig(false);
    withEnv({ QUILT_TELEMETRY: "1" }, () => assert.equal(telemetryEnabled(), true));
  });
});

test("event payload carries counts and environment facts, never content", () => {
  const dir = tempDir();
  withEnv({ QUILT_TELEMETRY_DIR: dir }, () => {
    writeTelemetryConfig(true);
    const payload = buildEventPayload("quilt_claim", { granted: 2, denied: 1, queued: 0 }) as any;
    assert.equal(payload.event, "quilt_claim");
    assert.equal(payload.distinct_id, readTelemetryConfig()!.anonymousId);
    assert.equal(payload.properties.granted, 2);
    assert.equal(typeof payload.properties.quilt_version, "string");
    assert.equal(payload.properties.platform, process.platform);
    // Nothing path-like or repo-like sneaks into the serialized payload.
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(process.cwd()));
    assert.ok(!text.includes("/Users/") && !text.includes("/home/"));
  });
});

test("recordEvent posts to the endpoint without blocking, and not when disabled", async () => {
  const dir = tempDir();
  const received: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    withEnv(
      { QUILT_TELEMETRY_DIR: dir, QUILT_TELEMETRY_ENDPOINT: `http://127.0.0.1:${port}/` },
      () => {
        writeTelemetryConfig(false);
        recordEvent("quilt_should_not_send", {});
        writeTelemetryConfig(true);
        const before = Date.now();
        recordEvent("quilt_setup_completed", { orchestrator: "claude-code" });
        // The call itself must return without touching the network.
        assert.ok(Date.now() - before < 200, "recordEvent must not block");
      },
    );
    // The detached child needs a moment to spawn and POST.
    const deadline = Date.now() + 8000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(received.length, 1, "exactly the enabled event should arrive");
    assert.equal(received[0].event, "quilt_setup_completed");
    assert.equal(received[0].properties.orchestrator, "claude-code");
  } finally {
    server.close();
  }
});

test("quilt telemetry on/off/status round-trips via the CLI", () => {
  const dir = tempDir();
  const env = { ...process.env, QUILT_TELEMETRY_DIR: dir, QUILT_NO_UPDATE_CHECK: "1" };
  delete (env as any).QUILT_TELEMETRY;
  const run = (args: string[]) => spawnSync("node", [CLI, ...args], { encoding: "utf8", env });
  assert.match(run(["telemetry"]).stdout, /off/);
  assert.match(run(["telemetry"]).stdout, /never asked/);
  assert.match(run(["telemetry", "on"]).stdout, /Telemetry on/);
  assert.match(run(["telemetry"]).stdout, /on/);
  assert.match(run(["telemetry", "off"]).stdout, /Telemetry off/);
  const bad = run(["telemetry", "sideways"]);
  assert.notEqual(bad.status, 0);
});

test("non-interactive setup never prompts and never decides for the user", () => {
  const dir = tempDir();
  const repo = mkdtempSync(join(tmpdir(), "quilt-telemetry-repo-"));
  const g = (a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.io"]);
  g(["config", "user.name", "t"]);
  const env = {
    ...process.env,
    QUILT_TELEMETRY_DIR: dir,
    QUILT_NO_UPDATE_CHECK: "1",
    QUILT_CODEX_DIR: join(repo, ".no-codex"),
  };
  delete (env as any).QUILT_TELEMETRY;
  // stdin is a pipe here, not a TTY, so setup must not hang on a question.
  const res = spawnSync("node", [CLI, "setup"], { cwd: repo, encoding: "utf8", env, timeout: 60_000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!/Share anonymous usage/.test(res.stdout), "must not prompt without a TTY");
  assert.equal(existsSync(join(dir, "telemetry.json")), false, "no decision may be recorded");
});
