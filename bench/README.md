# Quilt eval harness

A persistent, committed suite that runs Quilt against a graded scenario ladder
and **measures** it — so architecture choices get resolved by evidence, and
regressions get caught. It is the instrument the rest of the roadmap is steered
by.

Every scenario runs twice: **WITHOUT Quilt** (the naive "many actors, one
working tree, plain git" baseline) and **WITH Quilt** (actors start sessions,
claim before editing, and `commit --mine`). The two runs are graded on the same
metrics and printed side by side.

```bash
npm run bench          # whole ladder
npm run bench -- L2    # one rung
```

Exit code is non-zero if any WITH-Quilt run regresses (silent loss,
misattribution, or a broken final state), so this doubles as a CI guard. The
same assertions run under `npm test` (see `test/bench.test.ts`).

## The ladder

Each rung escalates coordination difficulty. It comes from this project's live
two-agent experiments — the failure modes are real, observed ones.

| Rung | Name | The hard question |
|------|------|-------------------|
| **L1** | Disjoint at scale | N agents, different symbols, one file. Does each change get committed and **attributed** to its author, or absorbed into one entangled commit? |
| **L2** | Incompatible conflict | Two agents want the same line to be two different things. Is one side **silently overwritten**, or is the collision **surfaced** for a human? |
| **L3** | Dependency cascade | One agent changes a signature another depends on. Does the dependent break against the old signature, or **adapt** because it saw the change coming? |
| **L4** | Refactor underfoot | One agent restructures a module while another edits the old layout. *(planned — live layer today)* |
| **L5** | Emergent overlap | Agents start separate but drift into the same region. *(planned — live layer today)* |
| **L6** | Mixed actors + noise | Humans + agents + unrelated churn. *(planned — live layer today)* |

L1–L3 are implemented as deterministic scripted scenarios. L4–L6 are documented
here and exercised via the live sub-agent layer below until scripted versions
land.

## Metrics

| Metric | Meaning | Good |
|--------|---------|------|
| features landed | intended changes present in final committed history | all |
| silent loss | changes that vanished from history **and** working tree, with no signal | 0 |
| attribution correct | every committed change authored by the actor who made it | yes |
| misattributed | changes committed under the wrong author | 0 |
| broken final state | codebase left incoherent (e.g. a stale call site) | no |
| surfaced conflicts | collisions Quilt raised for a human — a *good* trade vs. silent loss | n/a |
| wasted/redone work | the coordination tax (deferred + redone edits) | low |
| wall clock (ms) | dominated by CLI process spawns here, not Quilt logic — see note | n/a |

`resolution quality` (LLM-judge) is intentionally **not** scored in the scripted
layer — it needs real agent output, so it lives in the live layer.

## What the scripted layer models (and what it doesn't)

The scripted scenarios are deterministic by design: edits are surgical
`anchor → text` replacements applied in a fixed interleave. Two cooperative
behaviors are encoded explicitly:

- **Defer on denial.** In WITH mode, an actor `quilt claim`s its target before
  editing; a denial means it backs off (it does not clobber). For incompatible
  conflicts (L2) the deferral stays surfaced for a human; for disjoint
  sequencing it retries after the commit phase (counted as wasted work, never
  loss).
- **Adapt on visibility.** In a cascade (L3), the dependent actor writes an
  *adapted* edit when it can see the upstream actor's claim, and a *naive* one
  when it can't.

These encode the **assumption** that a competent agent, given visibility, will
cooperate. The scripted layer is a regression guard and demo of that contract;
it does not prove real agents behave this way. **That is exactly what the live
layer tests.**

Two honest caveats:

- **Wall clock is not latency.** Each scripted actor action is a separate `node
  dist/cli.js` spawn (each loading the tree-sitter wasm), so WITH-Quilt wall
  clock is dominated by process startup, not Quilt's coordination cost. Treat it
  as relative, not absolute. Real latency is measured in the live layer.
- **No-redo without Quilt is deliberate.** When the baseline silently loses an
  edit, nobody redoes it — because nobody knows. That *is* the failure being
  measured.

## Live sub-agent layer

The scripted layer encodes the cooperative contract; the live layer tests
whether real agents honor it. This is how the experiments that produced the
ladder were actually run, written down so they're repeatable.

**Setup (per condition).** Create a throwaway git repo with a seed codebase and
a short task list whose items overlap in the way a given rung specifies.

**WITHOUT Quilt.** Spawn N general-purpose agents pointed at the *same* working
tree (no isolation), each given one task, no coordination tooling. Let them run
concurrently. Then commit and inspect.

**WITH Quilt.** Same repo, same tasks, but:
1. `quilt init`, and each agent gets the Quilt MCP server (`quilt mcp`) or the
   CLI in its toolset.
2. Each agent is instructed to `start` a session, `claim` what it's about to
   edit, check `get_conflicts` / `status` for others' in-flight work, and
   `commit --mine` when done.
3. Let them run concurrently against the shared tree.

**Grade both** with the same metrics as the scripted layer, plus the LLM-judge
`resolution quality` score: hand a judge model the task list, both final diffs,
and the commit graph, and ask which condition produced correct, coherent,
well-attributed work — and where coordination changed the outcome.

**Record** each run as a short markdown writeup (repo seed, tasks, per-condition
metrics, judge verdict, notable transcript moments) so results accumulate over
time rather than evaporating. The session that produced this ladder found: L1
absorption/serialization without Quilt; genuine cooperation wins at L2/L3 with
it (agents read each other's *uncommitted* work and made smart calls);
non-cooperative agents get no protection either way (out of scope — worktrees
don't protect them for free either).

## Files

- `harness.ts` — sandbox repos, mode-aware run primitives, metrics, grading.
- `scenarios.ts` — the L1–L3 scenarios as data, plus L4–L6 roadmap stubs.
- `run.ts` — CLI entry / report (`npm run bench`).
