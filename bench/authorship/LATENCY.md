# Latency — does Quilt slow agents down? (2026-06-30, incl. batched git reads)

Run: `node bench/authorship/latency.mjs`. Median ms over repeated runs.

| operation | before (per-file git) | after (batched) |
|---|---|---|
| raw fs write | ~0.03 ms | ~0.03 ms |
| `quilt_edit` (write + ledger append) | ~0.01 ms — **free** | ~0.01 ms — **free** |
| `reconcile`, 1 changed file | ~31 ms | ~38 ms |
| `reconcile`, 10 changed files | ~207 ms | **~38 ms** |
| `reconcile`, 50 changed files | ~948 ms | **~47 ms** |
| `reconcile`, 150 changed files | **~2.9 s** | **~68 ms** |

(For scale: a single LLM turn is ~1–10 s.)

## Findings

- **Capture is free.** Routing an edit through `quilt_edit` (the v0.3 path) adds no
  measurable latency vs a raw write. The new architecture costs nothing per edit.
- **`reconcile` is now near-flat in changed-file count.** It was ~19 ms/file
  (O(N) subprocess spawns, 0.9–2.9 s on a churny 50–150-file repo). Batching the
  HEAD reads dropped 150 files from ~2.9 s to ~68 ms (~43×). What's left is a
  fixed ~38 ms floor (three git spawns per reconcile: `status`, `rev-parse`,
  `cat-file --batch`) plus a tiny marginal per-file cost (worktree read + diff).

## Done

1. **Batch the git reads** — DONE (2026-06-30). `git.ts#headBlobs` reads every
   changed file's HEAD content in one `git cat-file --batch` instead of a `git
   show` (plus a `rev-parse`) per file. `engine.ts` reconcile and `buildModel`
   both route through it. This was the biggest win and it's landed.

## Still tracked (not yet done)

2. **Move read-only git I/O outside the lock** so concurrent agents don't
   serialize behind each other's whole-repo scans. Lower leverage now that the
   whole scan is ~40–70 ms, but still worth it under heavy fan-out.
3. The remaining fixed floor is three git spawns; could be trimmed further (e.g.
   fold `rev-parse` into the batch), but ~40 ms next to a multi-second LLM turn is
   already invisible.
