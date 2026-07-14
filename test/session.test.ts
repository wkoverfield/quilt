import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state.js";
import { activeContext } from "../src/session.js";

test("explicit actor never inherits another actor's current session", () => {
  const dir = mkdtempSync(join(tmpdir(), "quilt-session-"));
  const oldActor = process.env.QUILT_ACTOR;
  const oldSession = process.env.QUILT_SESSION;
  try {
    const store = new Store(dir);
    store.ensureDirs();
    store.upsertActor({ id: "alpha", type: "agent", displayName: "alpha", createdAt: "2026-01-01T00:00:00Z" });
    store.upsertActor({ id: "beta", type: "agent", displayName: "beta", createdAt: "2026-01-01T00:00:00Z" });
    store.writeSession({
      id: "beta-session", actorId: "beta", actorType: "agent", repoRoot: dir,
      baseSha: null, startedAt: "2026-01-01T00:00:00Z", status: "active",
    });
    store.writeCurrentSessionId("beta-session");
    process.env.QUILT_ACTOR = "alpha";
    delete process.env.QUILT_SESSION;
    const context = activeContext(store);
    assert.equal(context.actorId, "alpha");
    assert.equal(context.actor?.id, "alpha");
    assert.equal(context.session, null);
    assert.equal(context.source, "actor-env");
  } finally {
    if (oldActor === undefined) delete process.env.QUILT_ACTOR;
    else process.env.QUILT_ACTOR = oldActor;
    if (oldSession === undefined) delete process.env.QUILT_SESSION;
    else process.env.QUILT_SESSION = oldSession;
    rmSync(dir, { recursive: true, force: true });
  }
});
