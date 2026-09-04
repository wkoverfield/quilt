import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEventPayload,
  ensureAnonymousId,
  heartbeatEnabled,
  maybeSendHeartbeat,
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

/** Neutral ambient signals: tests must behave the same on a laptop and in CI. */
const NEUTRAL = { QUILT_TELEMETRY: undefined, DO_NOT_TRACK: undefined, CI: undefined };

/** A local sink that collects posted payloads. */
async function withSink(fn: (url: string, received: any[]) => Promise<void>): Promise<void> {
  const received: any[] = [];
  const server: Server = createServer((req, res) => {
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
    await fn(`http://127.0.0.1:${port}/`, received);
  } finally {
    server.close();
  }
}

async function drain(received: any[], expected: number, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (received.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("command events are off until someone says yes, and the decision persists", () => {
  const dir = tempDir();
  withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir }, () => {
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

test("heartbeat is on by default, and a stored no turns it off", () => {
  const dir = tempDir();
  withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir }, () => {
    assert.equal(heartbeatEnabled(), true, "fresh install: heartbeat on");
    assert.equal(telemetryEnabled(), false, "fresh install: events off");
    writeTelemetryConfig(false);
    assert.equal(heartbeatEnabled(), false, "a no anywhere means fully dark");
    writeTelemetryConfig(true);
    assert.equal(heartbeatEnabled(), true);
  });
});

test("DO_NOT_TRACK and CI suppress both tiers; QUILT_TELEMETRY beats both", () => {
  const dir = tempDir();
  withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir }, () => {
    writeTelemetryConfig(true);
    withEnv({ DO_NOT_TRACK: "1" }, () => {
      assert.equal(heartbeatEnabled(), false);
      assert.equal(telemetryEnabled(), false);
    });
    withEnv({ CI: "true" }, () => {
      assert.equal(heartbeatEnabled(), false);
      assert.equal(telemetryEnabled(), false);
    });
    withEnv({ DO_NOT_TRACK: "1", QUILT_TELEMETRY: "1" }, () => {
      assert.equal(heartbeatEnabled(), true, "explicit per-process opt-in wins");
    });
    withEnv({ QUILT_TELEMETRY: "0" }, () => {
      assert.equal(heartbeatEnabled(), false);
    });
  });
});

test("QUILT_TELEMETRY env kill switch beats the stored decision, both ways", () => {
  const dir = tempDir();
  withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir }, () => {
    writeTelemetryConfig(true);
    withEnv({ QUILT_TELEMETRY: "0" }, () => assert.equal(telemetryEnabled(), false));
    writeTelemetryConfig(false);
    withEnv({ QUILT_TELEMETRY: "1" }, () => assert.equal(telemetryEnabled(), true));
  });
});

test("anonymous id exists independent of any consent decision", () => {
  const dir = tempDir();
  withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir }, () => {
    const id = ensureAnonymousId();
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(telemetryDecided(), false, "an id is not a decision");
    assert.equal(ensureAnonymousId(), id, "stable across calls");
    writeTelemetryConfig(true);
    assert.equal(readTelemetryConfig()!.anonymousId, id, "opting in keeps the id");
  });
});

test("event payload carries counts and environment facts, never content", () => {
  const dir = tempDir();
  withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir }, () => {
    writeTelemetryConfig(true);
    const payload = buildEventPayload("quilt_claim", { granted: 2, denied: 1, queued: 0 }) as any;
    assert.equal(payload.event, "quilt_claim");
    assert.equal(payload.distinct_id, readTelemetryConfig()!.anonymousId);
    assert.equal(payload.properties.granted, 2);
    assert.equal(payload.properties.$process_person_profile, false);
    assert.equal(typeof payload.properties.quilt_version, "string");
    assert.equal(payload.properties.platform, process.platform);
    // Nothing path-like or repo-like sneaks into the serialized payload.
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(process.cwd()));
    assert.ok(!text.includes("/Users/") && !text.includes("/home/"));
  });
});

test("forced telemetry before a stored decision uses one process-scoped anonymous identity", () => {
  const dir = tempDir();
  withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir, QUILT_TELEMETRY: "1" }, () => {
    const first = buildEventPayload("first") as any;
    const second = buildEventPayload("second") as any;
    assert.notEqual(first.distinct_id, "undecided");
    assert.notEqual(second.distinct_id, "undecided");
    assert.equal(first.distinct_id, second.distinct_id);
  });
});

test("recordEvent posts to the endpoint without blocking, and not when disabled", async () => {
  const dir = tempDir();
  await withSink(async (url, received) => {
    withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir, QUILT_TELEMETRY_ENDPOINT: url }, () => {
      writeTelemetryConfig(false);
      recordEvent("quilt_should_not_send", {});
      writeTelemetryConfig(true);
      const before = Date.now();
      recordEvent("quilt_setup_completed", { orchestrator: "claude-code" });
      // The call itself must return without touching the network.
      assert.ok(Date.now() - before < 200, "recordEvent must not block");
    });
    await drain(received, 1);
    assert.equal(received.length, 1, "exactly the enabled event should arrive");
    assert.equal(received[0].event, "quilt_setup_completed");
    assert.equal(received[0].properties.orchestrator, "claude-code");
  });
});

test("heartbeat sends once, respects the daily TTL, and carries only the envelope", async () => {
  const dir = tempDir();
  await withSink(async (url, received) => {
    withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir, QUILT_TELEMETRY_ENDPOINT: url }, () => {
      maybeSendHeartbeat();
      maybeSendHeartbeat();
      maybeSendHeartbeat();
    });
    await drain(received, 1);
    // Give any wrongly-spawned second send a moment to land before counting.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(received.length, 1, "TTL must collapse repeat calls to one send");
    const hb = received[0];
    assert.equal(hb.event, "quilt_heartbeat");
    assert.deepEqual(
      Object.keys(hb.properties).sort(),
      ["$process_person_profile", "node_major", "platform", "quilt_version"],
      "heartbeat carries the envelope and nothing else",
    );
    withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir }, () => {
      assert.equal(hb.distinct_id, readTelemetryConfig()!.anonymousId, "id is the persisted one");
      assert.ok(existsSync(join(dir, "heartbeat.json")), "TTL stamp written");
    });
  });
});

test("a corrupt heartbeat stamp is replaced, not fatal", async () => {
  const dir = tempDir();
  await withSink(async (url, received) => {
    withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir, QUILT_TELEMETRY_ENDPOINT: url }, () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "heartbeat.json"), "{not json");
      maybeSendHeartbeat();
    });
    await drain(received, 1);
    assert.equal(received.length, 1, "corrupt stamp must self-heal and send");
    withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir }, () => {
      const stamp = JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8"));
      assert.equal(typeof stamp.lastSentAt, "string", "stamp rewritten cleanly");
    });
  });
});

test("a declined decision or ambient opt-out means no heartbeat and no stamp", async () => {
  const dir = tempDir();
  await withSink(async (url, received) => {
    withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir, QUILT_TELEMETRY_ENDPOINT: url }, () => {
      writeTelemetryConfig(false);
      maybeSendHeartbeat();
      assert.equal(existsSync(join(dir, "heartbeat.json")), false, "suppressed: no stamp");
    });
    const dir2 = tempDir();
    withEnv({ ...NEUTRAL, QUILT_TELEMETRY_DIR: dir2, QUILT_TELEMETRY_ENDPOINT: url, DO_NOT_TRACK: "1" }, () => {
      maybeSendHeartbeat();
      assert.equal(existsSync(join(dir2, "heartbeat.json")), false);
    });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(received.length, 0, "nothing may arrive");
  });
});

test("ordinary CLI commands stamp a heartbeat; hook-* commands never do", () => {
  const dir = tempDir();
  const env = { ...process.env, QUILT_TELEMETRY_DIR: dir, QUILT_NO_UPDATE_CHECK: "1", QUILT_TELEMETRY_ENDPOINT: "http://127.0.0.1:1/" };
  delete (env as any).QUILT_TELEMETRY;
  delete (env as any).DO_NOT_TRACK;
  delete (env as any).CI;
  const run = (args: string[], input?: string) =>
    spawnSync("node", [CLI, ...args], { encoding: "utf8", env, input });
  // The hot path first: every hook command, both the commander-routed pair
  // and the argv fast-path trio, must not stamp, mint ids, or send.
  for (const hook of ["hook-pre", "hook-post", "hook-bash", "hook-bash-post", "hook-git-pre-commit"]) {
    run([hook], "{}");
  }
  assert.equal(existsSync(join(dir, "heartbeat.json")), false, "hook path stays uninstrumented");
  assert.equal(existsSync(join(dir, "telemetry.json")), false, "hook path never mints an id");
  // Any ordinary command entry stamps (the send itself is fail-silent).
  run(["telemetry"]);
  assert.equal(existsSync(join(dir, "heartbeat.json")), true, "ordinary commands heartbeat");
});

test("quilt telemetry on/off/status round-trips via the CLI", () => {
  const dir = tempDir();
  const env = { ...process.env, QUILT_TELEMETRY_DIR: dir, QUILT_NO_UPDATE_CHECK: "1", QUILT_TELEMETRY_ENDPOINT: "http://127.0.0.1:1/" };
  delete (env as any).QUILT_TELEMETRY;
  delete (env as any).DO_NOT_TRACK;
  delete (env as any).CI;
  const run = (args: string[]) => spawnSync("node", [CLI, ...args], { encoding: "utf8", env });
  const fresh = run(["telemetry"]).stdout;
  assert.match(fresh, /Heartbeat: on/);
  assert.match(fresh, /Command events: off/);
  assert.match(fresh, /defaults/);
  assert.match(run(["telemetry", "on"]).stdout, /Telemetry on/);
  assert.match(run(["telemetry"]).stdout, /Command events: on/);
  assert.match(run(["telemetry", "off"]).stdout, /Telemetry off \(heartbeat included\)/);
  const off = run(["telemetry"]).stdout;
  assert.match(off, /Heartbeat: off/);
  assert.match(off, /your stored decision/);
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
    QUILT_TELEMETRY_ENDPOINT: "http://127.0.0.1:1/",
    QUILT_CODEX_DIR: join(repo, ".no-codex"),
  };
  delete (env as any).QUILT_TELEMETRY;
  delete (env as any).DO_NOT_TRACK;
  delete (env as any).CI;
  // stdin is a pipe here, not a TTY, so setup must not hang on a question.
  const res = spawnSync("node", [CLI, "setup"], { cwd: repo, encoding: "utf8", env, timeout: 60_000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!/share anonymous command counts/i.test(res.stdout), "must not prompt without a TTY");
  assert.match(res.stdout, /daily anonymous heartbeat/, "heartbeat disclosure always prints");
  if (existsSync(join(dir, "telemetry.json"))) {
    const stored = JSON.parse(readFileSync(join(dir, "telemetry.json"), "utf8"));
    assert.equal(stored.enabled, undefined, "an id may be minted, a decision may not");
  }
});
