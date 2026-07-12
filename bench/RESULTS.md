# Scripted ladder results

Run 2026-07-12 on Quilt 0.4.6 (repo main, `284ca29`), macOS, Node 22.
Reproduce with `npm run bench`. The harness, scenarios, and metric definitions
are documented in [bench/README.md](README.md); every number below comes from
running the same six scenarios twice, WITHOUT Quilt (N agents, one working
tree, plain git) and WITH Quilt (same tree, actors claim before editing and
`commit --mine`).

## The headline

Across the six-scenario ladder (18 intended changes by 2 to 4 concurrent
actors), the shared checkout WITHOUT Quilt:

- **silently lost 3 changes** (L2, L4, L5): gone from history and the working
  tree, with no signal to anyone,
- **misattributed 9 changes** (L1, L3, L5, L6): committed under an author who
  did not write them,
- **broke the final state once** (L3): a call site left incoherent against a
  changed signature,
- and **surfaced 0 conflicts**, because plain git has no mechanism to notice.

WITH Quilt, on the same scenarios: **0 silent losses, 0 misattributions,
0 broken final states.** The three genuine collisions became surfaced
conflicts for a human instead of losses, at a cost of 3 deferred or redone
edits (the coordination tax).

## Per rung

| Rung | Scenario | | silent loss | misattributed | broken state | surfaced |
|---|---|---|---|---|---|---|
| L1 | Disjoint at scale | without | 0 | **3** | no | 0 |
| | | with | 0 | 0 | no | 0 |
| L2 | Incompatible conflict | without | **1** | 0 | no | 0 |
| | | with | 0 | 0 | no | 1 |
| L3 | Dependency cascade | without | 0 | **1** | **yes** | 0 |
| | | with | 0 | 0 | no | 0 |
| L4 | Refactor underfoot | without | **1** | 0 | no | 0 |
| | | with | 0 | 0 | no | 1 |
| L5 | Emergent overlap | without | **1** | **2** | no | 0 |
| | | with | 0 | 0 | no | 1 |
| L6 | Mixed actors + noise | without | 0 | **3** | no | 0 |
| | | with | 0 | 0 | no | 0 |

Attribution was fully correct in 2 of 6 scenarios without Quilt, and in 6 of 6
with it. Features landed is identical across conditions on every rung: where
the baseline silently dropped a change, Quilt surfaced the same collision
instead, so the difference is *what happens to the losing edit*, not how much
work gets through.

## How to read this honestly

- **The scripted layer encodes cooperative agents.** Actors claim before
  editing and back off on denial; the harness proves what the coordination
  contract delivers when it is followed, not that every agent follows it. The
  [live layer](live/README.md) tests real agents against the same ladder.
- **Wall clock is not latency.** Every scripted action is a separate CLI
  process spawn (each loading the tree-sitter runtime), so WITH-Quilt wall
  clock in the harness output measures process startup, not coordination cost.
  Real per-command latency is measured separately in
  [authorship/LATENCY.md](authorship/LATENCY.md).
- **No-redo without Quilt is deliberate.** When the baseline silently loses an
  edit, nobody redoes it, because nobody knows. That is the failure being
  measured.
- These runs double as a regression gate: `npm run bench` exits non-zero if
  any WITH-Quilt run regresses on silent loss, misattribution, or a broken
  final state, and the same assertions run under `npm test`.

## Related evidence

- [authorship/RESULTS.md](authorship/RESULTS.md): the capture-strategy eval
  behind Quilt's ledger design (why capture-at-the-tool-boundary beats
  run-boundary snapshots, and why its one blind spot fails safe), including
  coverage measurements over 13 real Claude agents (100% of file writes went
  through capturable tools).
- [authorship/LATENCY.md](authorship/LATENCY.md): per-command overhead.
- [live/](live/README.md): the live sub-agent protocol and result template.
