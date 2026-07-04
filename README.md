# Quilt

<!-- mcp-name: io.github.wkoverfield/quilt -->

[![CI](https://github.com/wkoverfield/quilt/actions/workflows/ci.yml/badge.svg)](https://github.com/wkoverfield/quilt/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@quilt-dev/cli)](https://www.npmjs.com/package/@quilt-dev/cli)
[![downloads](https://img.shields.io/npm/dm/@quilt-dev/cli)](https://www.npmjs.com/package/@quilt-dev/cli)
[![license](https://img.shields.io/npm/l/@quilt-dev/cli)](LICENSE)

Quilt is a command-line tool that tracks which agent wrote which lines in a
shared Git checkout, so multiple AI coding agents can work in one repo at once
and each commits only its own changes.

It captures every edit at the tool boundary, keeps a per-line record of who wrote
what, and reconstructs each agent's own changes at commit time. Git stays the
source of truth. Quilt never calls an LLM or spawns agents, and its state lives in
a `.quilt/` sidecar you can delete without touching your repo.

![Two agents editing one file, plain git vs Quilt. Without Quilt (left), the first agent's commit absorbs the other's work and the history credits one author. With Quilt (right), each change is committed by the agent that made it.](examples/contrast.gif)

```bash
npm install -g @quilt-dev/cli
quilt setup     # wire Quilt into your repo (Claude Code, Cursor, or plain git)
```

## The problem

You can run about three coding agents on one repo before they start clobbering
each other. Two edit the same file and one silently overwrites the other. Their
commits tangle into one blob you can't attribute. The usual advice is "run
fewer," or "give each agent its own worktree."

Quilt lifts that ceiling. The agents share one checkout, and Quilt keeps
attribution clean, prevents collisions, and gives each agent its own clean commit.
And it holds as you add agents. Here are seven fanning out on one repo, run head
to head:

![Seven agents fan out on one repo. Without Quilt, their work collapses into one tangled commit and a collision silently overwrites an agent's change. With Quilt, each agent lands a clean, correctly-attributed commit and the collision is prevented.](examples/fleet.gif)

That is `./examples/fleet.sh`. It uses the quilt system, and you can also run it yourself.

## When two agents want the same file

Fanning out on disjoint files is the easy case. The real test is contention:

![Two builders race for the same file. The loser's denial carries the winner's stated intent and lease expiry, so it builds its other files while it waits, re-claims after the winner's commit auto-releases, and layers its change on top. Two clean commits, nothing lost.](examples/contention.gif)

That is `./examples/contention.sh` — a denial isn't a dead end, it's the other
agent's intent and a lease expiry to pace your retry against.

## What it does

- **One shared checkout.** Model humans, agents, and bots as actors editing one
  working tree, no worktree per agent.
- **Line-level attribution.** `commit --mine` commits only your lines, even when
  they share a hunk with another actor's.
- **Symbol-level claims.** Reserve `utils.js#formatPrice`, not the whole file, so
  agents editing different functions never contend. Ten languages via tree-sitter;
  whole-file claims for the rest.
- **Collision prevention.** A write into code another agent has claimed is denied,
  with the holder's stated intent, before any bytes change.
- **Push-awareness.** Claim a symbol that depends on a function another actor is
  changing, and Quilt warns you at claim time.
- **Detect and preserve.** If one actor overwrites another's uncommitted lines,
  Quilt snapshots the victim's version so nothing is silently lost.

Every commit Quilt produces is an ordinary Git commit. It trusts Git and never
rewrites it, and all state lives locally under `.quilt/`. No account, no daemon.

## Quickstart

```bash
quilt setup      # wire Quilt into the repo (MCP server, hooks, coordination)
quilt doctor     # confirm it's wired and capture is flowing
```

That's it. Agents are named automatically: each Claude Code session or MCP
connection gets its own id, so parallel agents are told apart with no setup.
Set an explicit id when you want one that is stable across sessions:

```bash
QUILT_ACTOR=auth-agent claude    # this agent's edits are attributed to auth-agent
```

Then each agent commits only its own lines:

```bash
quilt status                     # who owns what
quilt preview --mine             # exact patch that would be committed
quilt commit --mine -m "fix auth redirect"
```

`quilt fleet` shows the whole picture: every actor, their claims, and anything
that needs a human. See [docs/reference.md](docs/reference.md) for the full
command list.

## Why not worktrees?

A worktree per agent is the usual answer, and for fully independent tasks it
works. But isolation moves the problem to the end, and its costs grow with the
number of agents.

|                                 | Run fewer agents | Worktree per agent          | Quilt                       |
| ------------------------------- | ---------------- | --------------------------- | --------------------------- |
| Parallelism                     | capped low       | high                        | high                        |
| Setup per agent                 | none             | full install/build/env × N  | none (one checkout)         |
| See each other's in-flight work | n/a              | no                          | yes                         |
| Collisions                      | avoided by hand  | surface at merge            | prevented, or surfaced live |
| Clean per-agent commits         | n/a              | after a merge               | yes                         |

Worktrees isolate; they don't coordinate. When agents work the same code at the
same time, you usually want them to see each other and account for each other as
they go. That is what Quilt does. The two aren't mutually exclusive: worktrees for
independent, long-running work, Quilt for agents in the same code at once.

## Using it with agents

`quilt setup` wires the capture hooks and a shared MCP server. On Claude Code the
hooks let agents use the built-in Edit and Write tools normally while Quilt
records each change's author and blocks a write into code another agent holds,
with no protocol for the agent to follow and no setup: each session is named
automatically, or carries its own `QUILT_ACTOR` for a stable id. For other
runtimes, the same capture and prevention is available as MCP tools, with each
connection named automatically the same way.

See [docs/orchestrators.md](docs/orchestrators.md) for Codex, Cursor, Aider, and
the difference between process-per-agent and many-agents-in-one-process setups.

## Docs

- [docs/orchestrators.md](docs/orchestrators.md): running a fleet of agents.
- [docs/reference.md](docs/reference.md): the full command list, how attribution
  works, and the `.quilt/` state layout.
- [bench/](bench/): the scenario ladder Quilt is tested against, run with and
  without Quilt on the same metrics.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
