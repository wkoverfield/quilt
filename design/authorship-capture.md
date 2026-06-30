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

1. **Ledger + capture** — `src/authorship.ts` (append/read), `quilt_edit` /
   `quilt_write` MCP tools, `quilt record-edit` CLI for the optional hook. Tests:
   events recorded with correct payload-derived attribution.
2. **Replay in reconcile** — attribute from the ledger positionally; inference
   stays as the fallback floor. Re-run the eval harness against the *real* impl.
3. **Prevention** — preHash + claims pre-write check; deny-with-intent.
4. **Hook (optional)** — Claude Code PostToolUse adapter via `record-edit`.
5. **Migrate / reconcile-replay becomes the default**, content-key path demoted to
   floor; update docs.

## Deferred / caveats

- Coverage is settled for Claude fleets; still worth checking Codex and agents
  *explicitly* told to use shell.
- Log compaction (checkpoint + truncate) for long-lived repos — the one new moving
  part the append-only model needs.
- B-style run-boundary capture kept on the shelf as a fallback for harnesses with
  no capturable edit tool.
- This largely subsumes the earlier "Tier 1–3 hardening" (the commit-time gate
  becomes one surface of the captured ledger).
