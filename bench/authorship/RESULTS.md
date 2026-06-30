# Authorship-capture eval — results (2026-06-30)

Three bets, scored against known ground truth. Run: `node bench/authorship/eval.mjs`.

- **A — Labeled-Write Ledger:** capture each edit's `old→new` payload at the tool
  boundary; reconcile = replay. Precise (per-edit). Edits that bypass the tool
  (raw `bash`) aren't captured — they're left **uncredited/surfaced**, never
  silently miscredited.
- **B — Run-boundary capture:** snapshot the tree per `quilt run <actor>` and
  diff. Captures *any* edit method (incl. `bash`), but coarse — two actors editing
  the same file in one run window can't be separated → **misattribution**.
- **C — status quo:** infer authorship on reconcile (the real Quilt CLI).

## Accuracy (on the scenarios that expose the core problem)

| | correct | misattributed (silent wrong) | uncredited (surfaced) |
|---|---|---|---|
| **A ledger** | **10/11 (91%)** | **0** | 1 (the bash edit) |
| **B run-boundary** | 10/11 (91%) | 1 (concurrency) | 0 |
| **C status quo** | 6/11 (55%) | 5 | 0 |

Per scenario: A and B both beat C on silent-concurrent, identical-line, and
rapid-interleave (C misattributes all of these). The two differentiators:
- **Scenario 4 (bash write):** A's blind spot — it leaves the bash edit
  *uncredited and surfaced* (safe); B captures it; C misattributes it.
- **Scenario 5 (concurrent same-file):** B's blind spot — it *silently
  misattributes* one actor's lines to the other; A and C get it right.

**The key distinction isn't the 91% tie — it's the failure mode.** A's only gap
**fails safe** (it says "unknown, look here," never wrong). B's only gap **fails
unsafe** (silent wrong credit). C fails unsafe, a lot.

## Coverage (the existential question — does A's bash blind spot matter?)

Measured by parsing the transcripts of **5 real Claude agents** doing varied,
realistic coding tasks (add function, new module, refactor/rename, bug fix,
multi-file feature) with **no Quilt and no instructions** — i.e. their natural
editing behavior:

```
file-writes via the capturable tool (Edit/Write/MultiEdit) = 9
file-writes via bash (sed/heredoc/tee/redirect)            = 0
bash used for read/run only (node, verification)           = 3
=> CAPTURABLE COVERAGE = 9/9 = 100%
```

Every file write went through the Edit/Write tool. Bash was used only to *run*
things, never to write file content. So **A's one weakness (bash edits) did not
occur at all** in realistic Claude-agent work.

**Bigger, bash-tempting sample (n=13).** Re-measured with 8 more agents on tasks
chosen to *tempt* shell edits — bulk version bump across files, one-line fixes
across several files, JSON edits, a refactor, a Python edit, a markdown table —
the exact cases where `sed -i` would be natural:

```
file-writes via the capturable tool = 20
file-writes via bash                =  0
bash for read/run only              =  5
=> CAPTURABLE COVERAGE = 20/20 = 100%  (13 agents)
```

Still zero bash file-writes even when the task invites shell editing — which
closes the one caveat that could have favored bet B.

## Verdict

**A (Labeled-Write Ledger) is the bet.** With coverage ~100% for the target
agents, A's bash blind spot is essentially theoretical — and even when it hits, it
**fails safe** (surfaced, never miscredited). B's coverage advantage (bash) is
moot when coverage is already complete, and B buys it at the cost of an *unsafe*
concurrency misattribution that A doesn't have. C silently misattributes ~half
the hard cases.

So: build A for real — the MCP `quilt_edit`/`quilt_write` tool (per-call actor),
the authorship ledger, positional replay in reconcile, and the preHash + claims
pre-write check for prevention. Keep **B-style run-boundary capture as a possible
fallback** for harnesses with no capturable edit tool, and the existing inference
as the floor.

## Honest caveats

- n=13 Claude agents (including deliberately bash-tempting tasks) — coverage held
  at 100%. Still worth checking other harnesses (Codex) and agents *explicitly*
  told to use shell, but the Claude-fleet case (the primary target) looks settled.
- The eval scenarios are adversarial and synthetic; they prove failure modes
  exist and that A eliminates the unsafe ones, not a real-world rate.
- B's model here is a simplification of run-boundary capture; a real prototype
  could do better on concurrency with finer snapshots (at more cost).
- A's 91%→effectively-100% rests on coverage holding; it's the number to keep
  watching as the eval grows.
