import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { repoRelative } from "../src/paths.js";

// repoRelative is the boundary every actor-controlled path crosses before it
// can match a claim or land in the ledger — test it directly, not just through
// the hooks/claims callers.

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "quilt-paths-"));
}

test("repoRelative: relative, dot-relative, and absolute-inside all key identically", () => {
  const root = tmp();
  try {
    assert.equal(repoRelative(root, "src/a.js"), "src/a.js");
    assert.equal(repoRelative(root, "./src/a.js"), "src/a.js");
    assert.equal(repoRelative(root, join(root, "src", "a.js")), "src/a.js");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repoRelative: separators normalize to forward slashes", () => {
  const root = tmp();
  try {
    // join() builds with the platform separator; the key must always come back
    // with `/` (on POSIX this is trivially true; on Windows it's the fix).
    const rel = repoRelative(root, join(root, "deep", "nested", "f.ts"));
    assert.equal(rel, "deep/nested/f.ts");
    assert.ok(!rel!.includes("\\"));
    assert.ok(!rel!.includes(sep === "/" ? "\\" : sep));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repoRelative: traversal, outside-absolute, and the root itself are rejected", () => {
  const root = tmp();
  const other = tmp();
  try {
    assert.equal(repoRelative(root, "../escape.js"), null);
    assert.equal(repoRelative(root, "a/../../escape.js"), null);
    assert.equal(repoRelative(root, join(other, "x.js")), null);
    assert.equal(repoRelative(root, root), null, "the root is not a file target");
    assert.equal(repoRelative(root, "."), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("repoRelative: a not-yet-created deep path still normalizes through an alias", () => {
  const root = tmp(); // under os.tmpdir(), itself an alias on macOS (/var -> /private/var)
  try {
    const real = realpathSync(root);
    // Nothing under new/deep exists yet — realExisting must walk up to the root.
    assert.equal(repoRelative(root, join(real, "new", "deep", "file.js")), "new/deep/file.js");
    if (real !== root) {
      assert.equal(repoRelative(real, join(root, "new", "deep", "file.js")), "new/deep/file.js");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repoRelative: a symlink pointing outside the repo does not smuggle a path inside", () => {
  const root = tmp();
  const outside = tmp();
  try {
    // root/link -> outside. A path THROUGH the link names bytes outside the
    // repo; after realpath it must resolve outside root and be rejected.
    symlinkSync(outside, join(root, "link"));
    const viaLink = repoRelative(root, join(root, "link", "victim.js"));
    // The direct string check accepts "link/victim.js" (it's under root by
    // spelling) — which is exactly why safeAbs separately refuses symlinks.
    // What repoRelative must NOT do is claim the OUTSIDE spelling is inside:
    assert.equal(repoRelative(root, join(outside, "victim.js")), null);
    // And if it resolved the link spelling, it must have kept it under root.
    if (viaLink !== null) assert.ok(!viaLink.startsWith(".."));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
