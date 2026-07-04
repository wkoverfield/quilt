import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state.js";
import { acquireClaims } from "../src/claims.js";
import { initSymbols } from "../src/symbols.js";
import { verifyClaimTargets } from "../src/claimcheck.js";
import { VERSION } from "../src/version.js";
import { readFileSync } from "node:fs";

before(async () => {
  await initSymbols();
});

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "quilt-claimcheck-"));
  const s = new Store(dir);
  s.ensureDirs();
  return { s, dir };
}

test("a typo'd symbol claim warns with the near-miss suggestion", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "utils.js"), "function formatPrice(n) {\n  return n;\n}\n");
    const results = acquireClaims(s, "bob", null, ["utils.js#formatPirce"], Date.now());
    assert.equal(results[0]!.granted, true, "still granted — could be a symbol about to be added");
    const warnings = verifyClaimTargets(s, results);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /formatPirce.*not found/);
    assert.match(warnings[0]!.message, /did you mean "formatPrice"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no warning for an existing symbol, a whole-file claim, or a not-yet-created file", () => {
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
    assert.ok(results.every((r) => r.granted));
    assert.equal(verifyClaimTargets(s, results).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no warning for a language Quilt can't parse (nothing to check against)", () => {
  const { s, dir } = newStore();
  try {
    writeFileSync(join(dir, "config.toml"), "[section]\nkey = 1\n");
    const results = acquireClaims(s, "bob", null, ["config.toml#section"], Date.now());
    assert.equal(verifyClaimTargets(s, results).length, 0);
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
