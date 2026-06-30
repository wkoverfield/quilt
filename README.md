# Quilt

[![CI](https://github.com/wkoverfield/quilt/actions/workflows/ci.yml/badge.svg)](https://github.com/wkoverfield/quilt/actions/workflows/ci.yml)

**The coordination layer for agent fleets.** Same repo. Many agents. Clean commits.

```bash
quilt commit --mine
```

![Two coding agents share one checkout: they claim different functions without contending, one gets a heads-up that something it depends on is changing, and each commits only its own work.](examples/demo.gif)

Same edits, two agents, one repo. Plain git vs Quilt:

![Without Quilt, the first agent's commit absorbs the other's work and the history credits one author; with Quilt, each change is committed by the agent that made it.](examples/contrast.gif)

Everyone else ran *toward* isolation: a worktree per agent, a branch per agent,
reconcile at PR time. That trades one mess for another. You get `node_modules`,
`.env`, and build caches per worktree, agents blind to each other's in-flight
work, and a merge pile-up at the end. Quilt goes the other way: **many agents,
one checkout**, coordinating in the open.

Parallelism comes from **coordination and visibility**, not isolation and
blindness. Agents claim the code they're about to touch, see each other's
uncommitted work, get a heads-up when something they depend on is changing, and
each commits only its own changes. Quilt is a cooperative protocol, like Git
itself, and it keeps Git as the source of truth: every commit it makes is an
ordinary Git commit.

### See it in 20 seconds

```bash
git clone https://github.com/wkoverfield/quilt && cd quilt
npm install && npm run build
./examples/demo.sh
```

Two agents share one checkout, claim different functions in the same file
without contending, one gets a heads-up that a function it depends on is
changing, and each lands only its own work as a clean, correctly-attributed
commit.

---

## What it does

- **Same-checkout actor ownership.** Model humans, agents, and bots as actors
  sharing one working tree.
- **Symbol-level claims.** Reserve `utils.js#formatPrice`, not the whole file, so
  agents editing different functions never contend. Powered by tree-sitter
  (JavaScript, TypeScript, JSX/TSX, Python, Go, Rust), with whole-file claims for
  everything else.
- **Push-awareness.** When you claim a symbol that depends on a function another
  actor is changing, Quilt warns you at claim time so the cascade is never a
  surprise.
- **Line-level attribution.** Quilt tracks which actor produced which lines, and
  `commit --mine` commits only yours even when they share a hunk.
- **Conflict surfacing.** Overlapping edits are flagged, not silently committed;
  pre-existing or generated changes stay unattributed.
- **Preview-first `commit --mine`.** See the exact patch before anything moves.
- **Preserves other actors' work.** Committing yours leaves everyone else's
  changes untouched in the working tree.
- **Human-readable status + stable JSON**, and a first-class MCP server for
  agents.
- **Local-first.** All state lives under `.quilt/`. No account, no daemon, no
  hosted service.

Quilt trusts Git and never rewrites it. Every commit Quilt produces is an
ordinary Git commit.

---

## Why not worktrees?

A worktree (or branch, or clone) per agent is the usual answer, and for fully
independent tasks it works. But isolation has costs that grow with the number of
agents:

- **Setup tax.** Every worktree needs its own install, build, and environment —
  `node_modules`, `.env`, build caches — duplicated N times.
- **Blindness.** Agents can't see each other's uncommitted work, so they find
  out they collided or broke a shared dependency at merge time, after the work
  is already done.
- **Merge tax.** Reconciliation happens at the end, when the branches have
  diverged the most.

The deeper issue is that worktrees isolate; they don't coordinate. When agents
are working in the same codebase, you usually want the opposite — for them to
see each other and account for each other as they go. Quilt keeps everyone in
one checkout and coordinates continuously: claims stop collisions before they
happen, shared visibility lets an agent adapt to what another is doing, and
`commit --mine` keeps each actor's history clean without a checkout per agent.

Worktrees still make sense for genuinely independent, long-running work, or when
you want hard OS-level isolation. Quilt is for agents working the same code at
the same time. The two aren't mutually exclusive.

---

## Install

```bash
npm install -g @quilt-dev/cli     # puts the `quilt` command on your PATH
```

Or from source:

```bash
npm install        # install deps
npm run build      # compile to dist/
npm link           # put `quilt` on your PATH
```

Requires Node 20+ and `git` on the PATH.

---

## Quickstart

```bash
quilt init
quilt start --actor wilson/codex-auth --type agent

# ... the agent edits files ...

quilt status                       # who owns what
quilt preview --mine               # exact patch that would be committed
quilt commit --mine -m "fix auth redirect"
```

### Multiple actors, one checkout

```bash
quilt start --actor alice --type agent   # Alice's shell
# alice edits src/auth.ts
quilt status                              # claims Alice's edits

quilt start --actor bob --type agent     # Bob's shell
# bob edits src/theme.ts
quilt status                              # claims Bob's edits

quilt commit --mine -m "auth work"        # (as Alice) commits ONLY Alice's hunks
# Bob's changes remain in the working tree, uncommitted.
```

Concurrent actors run in their own shells; set `QUILT_ACTOR=<id>` (or
`QUILT_SESSION=<id>`) per shell so each invocation knows who "you" are without a
shared pointer.

---

## Commands

| Command | Purpose |
| --- | --- |
| `quilt init` | Initialize `.quilt/` in the repo. |
| `quilt start --actor <id> [--type human\|agent\|bot] [--name <n>] [--email <e>]` | Start a session for an actor. |
| `quilt watch` | Watch the tree: attribute edits live and catch collisions. |
| `quilt status [--json]` | Show who owns which working-tree changes. |
| `quilt mine [--json]` | Summarize the changes you own. |
| `quilt conflicts [--json]` | Show overlapping/shared changes. |
| `quilt restore [path] [--json]` | List or recover work overwritten by another actor. |
| `quilt preview --mine [--json] [--include-unclaimed]` | Print the exact patch `commit --mine` would create. |
| `quilt commit --mine -m <msg> [--dry-run] [--include-unclaimed]` | Commit only your owned patch. |
| `quilt claim [targets...] [--json]` | Reserve files, or `file#symbol`, for editing; with none, lists claims. |
| `quilt release [paths...]` | Release your claims (all of yours if no paths). |
| `quilt mcp` | Run the MCP server (stdio) for agent integration. |
| `quilt whoami` | Show the active actor/session. |
| `quilt end` | End the active session. |

---

## Live attribution + collision rescue (`quilt watch`)

Run the watcher once and stop thinking about it:

```bash
quilt watch
```

It attributes edits to the active actor **as they happen** (no need to run
`quilt status` to claim) and it catches collisions. When one actor's edit
overwrites uncommitted lines another actor owns, Quilt preserves *both* versions
and tells you:

```txt
⚠ collision  claude-ui overwrote codex's edits in auth.ts. both saved, run: quilt restore auth.ts
```

Nothing is silently lost. `quilt restore auth.ts` writes the overwritten version
to a sidecar file (`auth.ts.quilt-codex`) so you can diff and merge; your
current file is never touched.

Preservation captures the victim's **last-observed** content, so keep `quilt
watch` running while agents work, so it keeps that snapshot current to each edit.
Without the watcher, the preserved version is only as fresh as the last `quilt`
command the victim ran.

This is the backstop for actors Quilt knows about: when one actor's edit
overwrites lines another actor already owns, the loss is made visible and
recoverable instead of silent. Preventing the overwrite outright is what
**claims** are for (below); this catches the case where someone edited without
claiming first. It can't referee writers that never identify themselves; Quilt
coordinates participants, not anonymous edits.

## Agent-native: the MCP server

Coding agents drive Quilt directly over MCP. Each agent runs its own server, so
attribution is precise per-agent.

```jsonc
// .mcp.json (or your agent's MCP config)
{
  "mcpServers": {
    "quilt": { "command": "quilt", "args": ["mcp"], "env": { "QUILT_ACTOR": "codex-auth" } }
  }
}
```

Tools: `start_session`, `get_status`, `get_my_changes`, `get_conflicts`,
`preview_mine`, `commit_mine`, `claim`, `release`. The intended loop:

```txt
start_session  →  get_status  →  claim(symbols)  →  …edit…  →  commit_mine
```

`claim` adds **advisory prevention** on top of detect-and-preserve: a symbol
already claimed by another actor is denied, so a well-behaved agent edits
something else. The `claim` and `get_conflicts` responses also carry
**`dependencyWarnings`**: push-awareness, so the moment an agent reserves a
symbol it learns whether a function it depends on is being changed by someone
else (see below). An agent that skips claiming but still drives Quilt as itself
is still caught by collision detection.

Quilt is a **cooperative protocol**, like Git: it coordinates the agents that
participate. Each agent identifies itself (its own MCP server, or `QUILT_ACTOR`).
An agent that ignores Quilt entirely gets no protection, the same way a worktree
gives an uncoordinated agent only isolation, not coordination. The intended path
is to wire your agents (or your orchestrator) into the MCP server so cooperation
is the default.

**Running a fleet of subagents?** One shared `quilt mcp` server can attribute a
whole fleet — each subagent passes its own `actor` per call, so there's no single
identity to clobber. See [docs/orchestrators.md](docs/orchestrators.md) for the
paste-in Claude Code (and Codex / Cursor / Aider) setup.

## Push-awareness: dependents hear about changes

The hardest multi-agent failure is the silent cascade: agent A changes a
function's signature while agent B, not knowing, builds against the old one.
Quilt closes that gap proactively. When you claim a symbol, Quilt reads what it
references and warns you if any dependency is currently claimed by someone else:

```txt
$ quilt claim billing.js#total          # while another actor holds billing.js#rate
  ✓ claimed billing.js#total
  ⚠ heads-up billing.js#total depends on rate, which codex is changing (billing.js#rate)
```

The win doesn't depend on B remembering to look. The same warnings appear in
`quilt status` and in the `claim` / `get_conflicts` MCP responses as
`dependencyWarnings`. (V1 is advisory and name-based, including across files;
import-resolution is a future refinement.)

## Evidence: the eval harness

Architecture choices here are settled by evidence, not vibes. [`bench/`](bench/)
runs Quilt against a graded scenario ladder (L1 disjoint work, L2 incompatible
conflict, L3 dependency cascade, L4 refactor-underfoot, L5 emergent overlap, L6
mixed actors + noise), each scenario run **WITH vs WITHOUT** Quilt and graded on
the same metrics (silent loss, attribution correctness, broken final state,
surfaced conflicts, wasted work).

```bash
npm run bench           # the whole ladder, side by side
```

The scripted scenarios are deterministic and run in CI; a documented live
sub-agent layer ([`bench/live/`](bench/live/README.md)) replays the same ladder
with real agents. See [`bench/README.md`](bench/README.md) for the honesty
caveats (what the scripted layer models vs. what the live layer tests).

## How attribution works

Quilt is honest and conservative: a blocked commit beats a spooky one.

Each `quilt` command runs a **reconcile** step:

1. Quilt keeps an *observed* snapshot of the working tree.
2. The delta since it last looked is attributed to the actor active for this
   command.
3. `quilt start` seeds the observed snapshot to the current tree, so anything
   already dirty stays **unclaimed** (e.g. formatter output, generated locks).
4. Reservations and attribution are **symbol-aware**: claim `utils.js#formatPrice`
   so two actors editing different functions in one file never contend.

`commit --mine` then diffs `HEAD → worktree`, keeps only the **lines you own**
(even when they share a hunk with another actor's changes: your lines commit,
theirs stay in the tree), applies that patch to a throwaway temporary index
(`GIT_INDEX_FILE` + `git apply --cached` + `write-tree` + `commit-tree` +
`update-ref`), and produces a normal Git commit. Your real index and the working
tree are never rewritten; other actors' changes stay exactly where they were.

This means: **run a `quilt` command around your edit batch** (the intended
agent workflow, call `status` before and after editing) so Quilt captures your
delta before another actor's.

### Limitations (honest)

- Attribution keys on **line content** (blank lines and lone braces/punctuation
  are ignored so they don't false-conflict). Two actors adding the same
  *substantive* line in different places can still be flagged as overlapping;
  conservative by design.
- Symbol parsing covers **JavaScript, TypeScript, JSX/TSX, Python, Go, and Rust**
  (tree-sitter). Other languages fall back to whole-file claims and line-level
  attribution.
- Push-awareness is **advisory and name-based**; a cross-file reference to a
  same-named symbol can false-positive. Import resolution is a future refinement.
- No automatic conflict resolution: Quilt surfaces, it does not merge.
- Binary files are never attributed or committed by Quilt.
- POSIX-first. CRLF / `core.autocrlf` repos on Windows aren't handled yet.

---

## State layout

```
.quilt/
  config.json        # repo config
  actors.json        # known actors
  sessions/*.json    # sessions
  current            # active session pointer for this checkout
  observed.json      # last-observed worktree snapshot (reconcile baseline)
  ownership.json     # per-file line ownership + conflicts
  clobbers.json      # records of overwritten work, preserved for restore
  snapshots/         # preserved pre-clobber file content
  watcher.pid        # pidfile for a running `quilt watch`
  ledger.jsonl       # append-only event log
```

`.quilt/` is git-ignored automatically.

---

## Development

```bash
npm run build   # tsc -> dist/
npm test        # build + run the acceptance suite against fixture repos
npm run bench   # run the eval ladder (WITH vs WITHOUT Quilt)
npm run dev -- status   # run the CLI from source via tsx
```

---

## License

MIT
