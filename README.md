# Quilt

**Actor-owned patches for Git.** Same repo. Many agents. Clean commits.

```bash
quilt commit --mine
```

Parallel coding agents are pushing teams toward worktree sprawl and messy,
late PR-time reconciliation. Worktrees help, but they don't solve the
*same-checkout* problem: multiple actors — humans, coding agents, bots,
formatters — editing **one** working tree and needing clean ownership of who
changed what.

Git already supports partial staging (`git add -p`), but git doesn't know
*which actor* made each hunk. Quilt adds that missing ownership layer while
keeping Git as the source of truth.

---

## What it does

- **Same-checkout actor ownership** — model humans, agents, and bots as actors
  sharing one working tree.
- **Hunk-level attribution** — Quilt tracks which actor produced which lines.
- **Unclaimed / conflicted detection** — pre-existing or generated changes stay
  unattributed; overlapping edits are surfaced, not silently committed.
- **Preview-first `commit --mine`** — see the exact patch before anything moves.
- **Preserves other actors' work** — committing yours leaves everyone else's
  changes untouched in the working tree.
- **Human-readable status + stable JSON** for agents.
- **Local-first** — all state lives under `.quilt/`. No account, no daemon, no
  hosted service.

Quilt trusts Git and never rewrites it. Every commit Quilt produces is an
ordinary Git commit.

---

## Install

```bash
npm install        # install deps
npm run build      # compile to dist/
npm link           # optional: put `quilt` on your PATH
```

Requires Node 18+ and `git` on the PATH.

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

It attributes edits to the active actor **as they happen** — no need to run
`quilt status` to claim — and it catches collisions. When one actor's edit
overwrites uncommitted lines another actor owns, Quilt preserves *both* versions
and tells you:

```txt
⚠ collision  claude-ui overwrote codex's edits in auth.ts — both saved · quilt restore auth.ts
```

Nothing is silently lost. `quilt restore auth.ts` writes the overwritten version
to a sidecar file (`auth.ts.quilt-codex`) so you can diff and merge — your
current file is never touched.

Preservation captures the victim's **last-observed** content, so keep `quilt
watch` running while agents work — it keeps that snapshot current to each edit.
Without the watcher, the preserved version is only as fresh as the last `quilt`
command the victim ran.

This is the safety net for actors Quilt knows about: when one actor's edit
overwrites lines another actor already owns, the loss is made visible and
recoverable instead of silent. (Preventing the overwrite outright — advisory
claims — arrives with the agent-facing MCP layer.) It can't referee writers that
never identify themselves; Quilt coordinates participants, not anonymous edits.

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
start_session  →  get_status  →  claim(files)  →  …edit…  →  commit_mine
```

`claim` adds **advisory prevention** on top of detect-and-preserve: a file
already claimed by another actor is denied, so a well-behaved agent edits
something else. An agent that skips claiming but still drives Quilt as itself is
still caught by collision detection.

Quilt is a **cooperative protocol** — like git, it coordinates the agents that
participate. Each agent identifies itself (its own MCP server, or `QUILT_ACTOR`).
An agent that ignores Quilt entirely gets no protection, the same way a worktree
gives an uncoordinated agent only isolation, not coordination. The intended path
is to wire your agents (or your orchestrator) into the MCP server so cooperation
is the default.

## How attribution works

Quilt is honest and conservative — a blocked commit beats a spooky one.

Each `quilt` command runs a **reconcile** step:

1. Quilt keeps an *observed* snapshot of the working tree.
2. The delta since it last looked is attributed to the actor active for this
   command.
3. `quilt start` seeds the observed snapshot to the current tree, so anything
   already dirty stays **unclaimed** (e.g. formatter output, generated locks).
4. Reservations and attribution are **symbol-aware**: claim `utils.js#formatPrice`
   so two actors editing different functions in one file never contend.

`commit --mine` then diffs `HEAD → worktree`, keeps only the **lines you own**
(even when they share a hunk with another actor's changes — your lines commit,
theirs stay in the tree), applies that patch to a throwaway temporary index
(`GIT_INDEX_FILE` + `git apply --cached` + `write-tree` + `commit-tree` +
`update-ref`), and produces a normal Git commit. Your real index and the working
tree are never rewritten; other actors' changes stay exactly where they were.

This means: **run a `quilt` command around your edit batch** (the intended
agent workflow — call `status` before and after editing) so Quilt captures your
delta before another actor's.

### V0 limitations (honest)

- Attribution keys on **line content** (blank lines and lone braces/punctuation
  are ignored so they don't false-conflict). Two actors adding the same
  *substantive* line in different places can still be flagged as overlapping —
  conservative by design. Precise per-edit attribution arrives with the watcher.
- No tree-sitter/symbol ownership yet (V1).
- No automatic conflict resolution — Quilt surfaces, it does not merge.
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
npm run dev -- status   # run the CLI from source via tsx
```

---

## License

MIT
