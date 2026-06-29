# Live sub-agent layer

The scripted ladder (`../`) encodes the cooperative contract deterministically.
This layer tests whether **real agents** honor it: spawn general-purpose agents
against a throwaway repo, WITH the Quilt MCP/CLI vs WITHOUT, and grade both on
the same metrics plus an LLM-judged resolution-quality score.

It is run by hand (it needs live agents and is non-deterministic), but the
protocol and artifacts are committed so runs are repeatable and results
accumulate instead of evaporating. This is exactly how the experiments that
produced the ladder were run.

## Runbook

For a chosen rung (start with **L2** — the cleanest signal):

1. **Seed a throwaway repo.**
   ```bash
   d=$(mktemp -d) && cd "$d" && git init -q
   git config user.email a@quilt.local && git config user.name seed
   # write the seed files (mirror the rung's scenario in ../scenarios.ts)
   git add -A && git commit -qm seed
   ```

2. **Write the task list** — one task per agent, overlapping the way the rung
   specifies (see `tasks/` for per-rung task lists). Each agent gets exactly one.

3. **Condition A — WITHOUT Quilt.** Spawn N general-purpose agents pointed at the
   *same* working tree (no isolation, no coordination tooling), each with one
   task. Let them run concurrently. Then `git add -A && git commit` per agent
   identity and capture the result.

4. **Condition B — WITH Quilt.** Fresh copy of the seed repo. `quilt init`, give
   each agent the Quilt MCP server (`quilt mcp`) or CLI, and instruct each to:
   `start` a session → `claim` what it's about to edit → check `get_conflicts` /
   `status` for others' in-flight work → `commit --mine` when done. Run
   concurrently against the shared tree.

5. **Grade both** with the metrics in `../README.md` (features landed, silent
   loss, attribution correct, broken state, surfaced conflicts, wasted work,
   wall clock), plus **resolution quality**: hand a judge model the task list,
   both final diffs, and both commit graphs, and ask which condition produced
   correct, coherent, well-attributed work — and where coordination changed the
   outcome.

6. **Record** the run by copying `RESULTS-TEMPLATE.md` to
   `results/<date>-<rung>.md` and filling it in. Commit it.

## What to look for

The session that produced this ladder found, live:

- **L1** without Quilt: agents serialize (worktrees) or entangle attribution
  (shared tree) even though the work is disjoint.
- **L2 / L3** with Quilt: genuine cooperation wins — agents read each other's
  *uncommitted, in-flight* work (impossible across isolated worktrees) and made
  smart calls: preserved a safety guard, escalated a true conflict, avoided a
  signature-change cascade. The value came FROM cooperation, not despite it.
- **Non-cooperative agents** get no protection either way — out of scope, and
  worktrees don't protect them for free either.

## Files

- `tasks/` — per-rung task lists handed to the agents.
- `RESULTS-TEMPLATE.md` — copy per run into `results/`.
- `results/` — accumulated run writeups (created as runs happen).
