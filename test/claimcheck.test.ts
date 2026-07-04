// Binding guarantees for symbol claims. The dogfood fleet's sharpest bug:
// a symbol claim naming nothing real (`schema.ts#people` — a table property,
// not a top-level symbol) was granted but bound NOTHING, so the agent's
// external edits attributed elsewhere and its commit silently dropped the
// file. A claim that can't bind must be refused, not granted with a warning.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state.js";
import { acquireClaims } from "../src/claims.js";
import { initSymbols } from "../src/symbols.js";
import { VERSION } from "../src/version.js";

before(async () => {
  await initSymbols();
});

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "quilt-claimbind-"));
  const s = new Store(dir);
  s.ensureDirs();
  return { s, dir };
}

test("a symbol claim naming no real symbol is DENIED with a near-miss suggestion", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "utils.js"), "function formatPrice(n) {\n  return n;\n}\n");
    const [r] = acquireClaims(s, "bob", null, ["utils.js#formatPirce"], Date.now());
    assert.equal(r!.granted, false, "granted-but-non-binding is a trap — deny");
    assert.equal(r!.reason, "symbol-not-found");
    assert.equal(r!.suggestion, "formatPrice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symbol that isn't a top-level construct (schema table property) is denied, not granted", () => {
  const { s, dir } = newStore();
  try {
    // `people` is a property inside the export, not a top-level symbol — the
    // exact dogfood shape that produced the silent partial commit.
    writeFileSync(
      join(dir, "schema.ts"),
      "export default defineSchema({\n  people: defineTable({}),\n  deals: defineTable({}),\n});\n",
    );
    const [r] = acquireClaims(s, "convex-agent", null, ["schema.ts#people"], Date.now());
    assert.equal(r!.granted, false);
    assert.equal(r!.reason, "symbol-not-found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symbol claim on an unparseable file type is denied — claim the whole file instead", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "config.toml"), "[section]\nkey = 1\n");
    const [r] = acquireClaims(s, "bob", null, ["config.toml#section"], Date.now());
    assert.equal(r!.granted, false);
    assert.equal(r!.reason, "symbols-unsupported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid symbol claims, whole-file claims, and pre-claims of not-yet-created files still grant", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "utils.js"), "function formatPrice(n) {\n  return n;\n}\n");
    const results = acquireClaims(
      s,
      "bob",
      null,
      ["utils.js#formatPrice", "utils.js", "brand-new.js#futureFn"],
      Date.now(),
    );
    assert.ok(results.every((r) => r.granted), JSON.stringify(results));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("directory claims: trailing slash reserves the whole prefix", () => {
  const { s, dir } = newStore();
  try {
    const [r] = acquireClaims(s, "codegen", null, ["convex/_generated/"], Date.now(), "codegen output");
    assert.equal(r!.granted, true);
    assert.equal(r!.dir, true);
    // Any claim under the prefix by ANOTHER actor is denied…
    const [under] = acquireClaims(s, "other", null, ["convex/_generated/api.ts"], Date.now());
    assert.equal(under!.granted, false);
    assert.equal(under!.holder, "codegen");
    assert.ok(under!.holderExpiresAt, "denials carry the holder's expiry for retry pacing");
    // …while a sibling outside the prefix is free.
    const [outside] = acquireClaims(s, "other", null, ["convex/schema.ts"], Date.now());
    assert.equal(outside!.granted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VERSION matches package.json (the 0.4.0-says-0.3.0 drift can't recur)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.equal(VERSION, pkg.version);
});
