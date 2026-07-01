# Design: authorship capture (the v0.3 core)

**Status: DECIDED — bet A, the Labeled-Write Ledger. Eval-backed.**
See `bench/authorship/` for the prototypes, harness, and results.

## The core problem

N agents edit ONE shared working tree. The OS records *that* bytes changed, never
*which agent* changed them. So per-agent authorship is unobservable from the tree
alone — yet correct attribution, collision *prevention*, and the self-sewing
"sew" all depend on it. The status quo *infers* authorship late (on `reconcile`,
"whoever ran a command owns the delta," keyed on line text), which silently
misattributes concurrent edits and only feels seamless under a strict protocol.

## The decision (and the evidence)

A group brainstorm (5 independent architects) converged 4-of-5 on **capturing
authorship at the write, at the tool-call boundary.** We prototyped three bets and
scored them against ground truth:

| | correct | silently misattributed | uncredited (surfaced) |
|---|---|---|---|
| **A — Labeled-Write Ledger** | 10/11 | **0** | 1 (a bash edit) |
| B — run-boundary capture | 10/11 | 1 (concurrency) | 0 |
| C — status quo | 6/11 | 5 | 0 |

A and B both crush C; the tie breaks on **failure mode** — A fails *safe* (says
"unknown, look here," never miscredits), B fails *unsafe* (silent wrong credit).
And **coverage settles it:** across 13 real Claude agents on varied, bash-tempting
tasks, **20/20 file-writes went through the capturable Edit/Write tool, 0 via
bash.** So A's only weakness doesn't occur in practice, and when it does it's
safe. **A is the bet.**

## Bet A — the mechanism

Replace late inference with an append-only authorship ledger written *at the
edit*, then make `reconcile` *replay* it. Four parts, each a graft onto existing
code:

1. **Capture (load-bearing): an MCP edit tool.** `quilt_edit{actor, path,
   old_string, new_string, why?}` and `quilt_write{actor, path, content, why?}`,
   registered in `mcp.ts` reusing `resolveActor()` (per-call actor, auto-register).
   The tool does the write itself (atomic temp+rename) and appends one event.
   Authorship is computed from the **payload** (`old→new` via `diff.ts` lineDiff),
   never a post-write disk re-read (which on a shared tree could contain a
   sibling's bytes). A Claude-Code hook is an optional accelerator only — never
   load-bearing (its post-write re-read races, and session-id can't tell two
   sub-agents apart; the MCP tool's per-call actor can).
2. **Ledger.** Event `{seq, ts, actor, path, added, removed, anchor, preHash,
   intent}` appended to `.quilt/authorship.log` under the existing `withLock`.
3. **Replay.** `reconcile` attributes each event's hunk to its recorded actor,
   keyed **positionally** (anchor), not by line text — killing both the timing
   race and the identical-line collapse. The content-key heuristic survives only
   as the fallback floor for deltas with no matching event (raw bash) — those are
   surfaced as `unknown`, never silently miscredited.
4. **Prevention.** Before a write lands, verify the region still matches `preHash`
   (mismatch = true concurrent edit, caught with no window) and consult the
   `claims` overlap oracle; if held by another actor, deny and return their
   `holderIntent` so the blocked agent self-resolves in-band.

Commit is unchanged (temp-index per-actor commit; every output an ordinary git
commit). Constraints all hold: deterministic (replay a log), local-first (a flat
file, no daemon), Git stays truth, Quilt calls no LLM (intent is the agent's own
`why`), cooperative floor (uncaptured edits fall through to detect-and-preserve).

## Implementation plan (increments)

1. **Ledger + capture** — DONE. `src/authorship.ts` (append/read), `quilt_edit` /
   `quilt_write` MCP tools. Events recorded with payload-derived attribution.
2. **Replay in reconcile** — DONE. Reconcile folds the ledger and attributes each
   captured line to its recorded author; inference stays as the fallback floor.
3. **Prevention** — DONE. Claims pre-write check; deny-with-intent, before any
   bytes change.
4. **Native-edit hooks** — DONE. A Pre/Post Claude Code hook pair on the built-in
   Edit/Write/MultiEdit tools, so capture + prevention work with zero protocol
   (the MCP tools stay the fallback). `quilt setup` installs them.
5. **Ledger-replay is the default; content-key inference is the floor** — DONE.
   The reconcile overlay is authoritative for every captured line; inference only
   decides lines the ledger never captured (e.g. a raw bash/sed write). Plus **log
   compaction**: the append-only log folds into a checkpoint (`authorship.checkpoint.json`)
   once it passes a threshold and truncates, so reconcile reads the checkpoint plus
   a short tail instead of all of history. The checkpoint is written atomically
   before the truncate, and the fold is idempotent, so a crash in between re-folds
   rather than losing authorship.

## Deferred / caveats

- Coverage is settled for Claude fleets; still worth checking Codex and agents
  *explicitly* told to use shell.
- Positional keying (anchor + postHash) for identical lines across functions —
  still latest-by-text today; the duplicate-one-liner collapse is the known edge.
- Real Claude-Code live run of the hook + a 4th eval path in `bench/authorship/`.
- B-style run-boundary capture kept on the shelf as a fallback for harnesses with
  no capturable edit tool.
- This largely subsumes the earlier "Tier 1–3 hardening" (the commit-time gate
  becomes one surface of the captured ledger).
