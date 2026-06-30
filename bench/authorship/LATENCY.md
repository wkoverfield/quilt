# Latency — does Quilt slow agents down? (2026-06-30)

Run: `node bench/authorship/latency.mjs`. Median ms over repeated runs.

| operation | latency |
|---|---|
| raw fs write | ~0.03 ms |
| `quilt_edit` (write + ledger append) | ~0.01 ms — **free** |
| `reconcile`, 1 changed file | ~31 ms |
| `reconcile`, 10 changed files | ~207 ms |
| `reconcile`, 50 changed files | ~948 ms |
| `reconcile`, 150 changed files | **~2.9 s** |

(For scale: a single LLM turn is ~1–10 s.)

## Findings

- **Capture is free.** Routing an edit through `quilt_edit` (the v0.3 path) adds no
  measurable latency vs a raw write. The new architecture costs nothing per edit.
- **`reconcile` scales ~linearly at ~19 ms/changed-file**, and it runs on *every*
  quilt command. Low-churn repos (≤10 changed files) are invisible (<200 ms next
  to a multi-second LLM turn). But a high-churn repo (50–150+ changed files) pays
  0.9–2.9 s **per command** — real drag that would slow an agent loop.

## Cause & fix (tracked, not yet done)

`reconcile` calls `git` once per changed file (the HEAD blob read in
`engine.ts#relevantPaths` / `headBlob`), inside the lock. That's O(N) subprocess
spawns. Fixes, in order of leverage:
1. **Batch the git reads** — one `git cat-file --batch` for all changed blobs
   instead of N `git show` spawns → O(1) subprocess. Biggest win.
2. **Move read-only git I/O outside the lock** so concurrent agents don't
   serialize behind each other's whole-repo scans.
3. The authorship ledger doesn't fix this by itself (it still needs HEAD content
   for the diff/prune), so this optimization is orthogonal to the v0.3 work — but
   it's the thing to do before anyone runs Quilt on a big, churny repo.

This is a perf optimization, not a correctness issue, so it's queued after the
authorship-capture increments — but it's now measured and on the list.
