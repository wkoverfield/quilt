# Quilt reference

The full command list, how attribution works internally, and the on-disk state
layout. For a quick start, see the [README](../README.md). For running a fleet of
agents, see [orchestrators.md](orchestrators.md).

## Commands

| Command | Purpose |
| --- | --- |
| `quilt init` | Initialize `.quilt/` in the repo. |
| `quilt setup [--dry-run]` | Wire Quilt into the repo's orchestrator: the shared MCP server in `.mcp.json` (and `.cursor/mcp.json` when a `.cursor/` dir exists), the coordination snippet in `CLAUDE.md` (and an existing `AGENTS.md`), and the native-edit capture hooks in `.claude/settings.json` (idempotent). |
| `quilt start --actor <id> [--type human\|agent\|bot] [--name <n>] [--email <e>]` | Start a session for an actor. Optional — agents are auto-named per session/connection, and `QUILT_ACTOR=<id>` pins a stable id without a session. Scopes only the CLI commands run in your terminal; it never binds other agents' captured edits (the pointer is checkout-global, capture identity is per-edit). |
| `quilt watch` | Watch the tree: attribute edits live and catch collisions. |
| `quilt fleet [--json] [--watch]` | Mission control: every actor, their claims, overlaps, and collisions in one view. |
| `quilt status [--json]` | Show who owns which working-tree changes. |
| `quilt mine [--json]` | Summarize the changes you own. |
| `quilt conflicts [--json]` | Show shared changes: same-line clashes vs adjacent edits that commit cleanly. |
| `quilt undo <actor> [--dry-run]` | Back out one actor's uncommitted changes, leaving everyone else's untouched. |
| `quilt escalate <target> [--reason]` | Flag a collision agents can't reconcile for a human (shows under "Needs you"). |
| `quilt resolve <target> [--note]` | Mark a collision sewn or handled. Clears its "Needs you" flag, records the trail. |
| `quilt restore [path] [--json]` | List or recover work overwritten by another actor. |
| `quilt preview --mine [--json] [--include-unclaimed]` | Print the exact patch `commit --mine` would create. |
| `quilt commit --mine -m <msg> [--dry-run] [--include-unclaimed]` | Commit only your owned patch. |
| `quilt claim [targets...] [--json] [--creating]` | Reserve files (`src/auth.ts`), directories (`convex/_generated/`), or symbols (`file#symbol`) for editing — BEFORE you edit; the claim is what binds external edits to you. A symbol missing from the file is denied unless `--creating` (you are about to add it). With no targets, lists claims. |
| `quilt release [paths...]` | Release your claims (all of yours if no paths). |
| `quilt mcp` | Run the MCP server (stdio) for agent integration. |
| `quilt doctor [--json]` | Health check: is Quilt wired, is identity set, and is capture actually flowing? |
| `quilt whoami` | Show the active actor and session. |
| `quilt end` | End the active session. |

Run `quilt --help` or `quilt <command> --help` for the full flag list.

## Live attribution: `quilt watch`

Run the watcher once and stop thinking about it:

```bash
quilt watch
```

It attributes edits to the active actor as they happen (no need to run `quilt
status` to claim), and it catches collisions. When one actor's edit overwrites
uncommitted lines another actor owns, Quilt preserves both versions and tells you:

```txt
⚠ collision  claude-ui overwrote codex's edits in auth.ts. both saved, run: quilt restore auth.ts
```

Nothing is silently lost. `quilt restore auth.ts` writes the overwritten version
to a sidecar file (`auth.ts.quilt-codex`) so you can diff and merge; your current
file is never touched. Preserving the victim's content captures its last-observed
version, so keep `quilt watch` running while agents work to keep that snapshot
current to each edit. Preventing the overwrite outright is what claims are for;
this catches the case where someone edited without claiming first.

## Push-awareness

The hardest multi-agent failure is the silent cascade: agent A changes a
function's signature while agent B, not knowing, builds against the old one.
Quilt closes that gap. When you claim a symbol, Quilt reads what it references and
warns you if any dependency is currently claimed by someone else:

```txt
$ quilt claim billing.js#total          # while another actor holds billing.js#rate
  ✓ claimed billing.js#total
  ⚠ heads-up billing.js#total depends on rate, which codex is changing (billing.js#rate)
```

The same warnings appear in `quilt status` and in the `claim` and `get_conflicts`
MCP responses as `dependencyWarnings`. (v1 is advisory and name-based, including
across files; import-resolution is a future refinement.)

## How attribution works

Quilt is conservative: a blocked commit beats a wrong one.

Each `quilt` command runs a reconcile step:

1. Quilt keeps an *observed* snapshot of the working tree.
2. The delta since it last looked is attributed to the actor active for this
   command. Captured edits (via the hooks or MCP tools) are attributed to their
   recorded author, so who runs reconcile first doesn't change the result.
3. `quilt start` seeds the observed snapshot to the current tree, so anything
   already dirty stays unclaimed (formatter output, generated locks).
4. Reservations and attribution are symbol-aware, so two actors editing different
   functions in one file never contend.

`commit --mine` then diffs `HEAD -> worktree`, keeps only the lines you own (even
when they share a hunk with another actor's changes: your lines commit, theirs
stay in the tree), applies that patch to a throwaway temporary index
(`GIT_INDEX_FILE` + `git apply --cached` + `write-tree` + `commit-tree` +
`update-ref`), and produces a normal Git commit. Your real index and the working
tree are never rewritten; other actors' changes stay exactly where they were.

Attribution keys on symbol scope plus line content. Blank lines and lone
braces/punctuation are ignored so they don't false-conflict. Identical lines in
different functions are kept distinct; two identical lines in the same function
can still collapse, which is rare and conservative by design. Binary files are
never attributed or committed. Quilt is POSIX-first; CRLF and `core.autocrlf`
repos on Windows aren't handled yet.

## State layout

```
.quilt/
  config.json                 # repo config
  actors.json                 # known actors
  sessions/*.json             # sessions
  current                     # active session pointer for this checkout
  observed.json               # last-observed worktree snapshot (reconcile baseline)
  ownership.json              # per-file line ownership + conflicts
  clobbers.json               # records of overwritten work, preserved for restore
  snapshots/                  # preserved pre-clobber file content
  watcher.pid                 # pidfile for a running `quilt watch`
  ledger.jsonl                # append-only event log (sessions, claims, clobbers)
  authorship.log              # captured edits: who authored which lines
  authorship.checkpoint.json  # compacted fold of old authorship events
  hooks/                      # pre/post hook snapshots (pre-edit file content)
```

`.quilt/` is git-ignored automatically.
