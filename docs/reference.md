# Quilt reference

The full command list, how attribution works internally, and the on-disk state
layout. For a quick start, see the [README](../README.md). For running a fleet of
agents, see [orchestrators.md](orchestrators.md).

## Commands

| Command | Purpose |
| --- | --- |
| `quilt init` | Initialize `.quilt/` in the repo. |
| `quilt setup [--dry-run]` | Wire Quilt into the repo's orchestrator (or, run from a non-repo directory that contains repos, wire that whole workspace: hooks + snippet at the root, full wiring in each child repo): the shared MCP server in `.mcp.json` (and `.cursor/mcp.json` when a `.cursor/` dir exists), the coordination snippet in `CLAUDE.md` (and an existing `AGENTS.md`), and the native-edit capture hooks in `.claude/settings.json` (idempotent). |
| `quilt config author.email [email]` | Read or set the repository-default Git author email. Actor names remain distinct. |
| `quilt start --actor <id> [--type human\|agent\|bot] [--name <n>] [--email <e>]` | Start a session for an actor. Optional — agents are auto-named per session/connection, and `QUILT_ACTOR=<id>` pins a stable id without a session. Scopes only the CLI commands run in your terminal; it never binds other agents' captured edits (the pointer is checkout-global, capture identity is per-edit). |
| `quilt watch` | Watch the tree: attribute edits live and catch collisions. |
| `quilt fleet [--json] [--watch]` | Mission control: every actor, their claims, overlaps, and collisions in one view. JSON includes `files`, the per-file who-wrote-what rows (per-actor line counts). |
| `quilt ui [--port <n>] [--no-open]` | The fleet view as a live local web page: who wrote what, expandable per-line provenance review, active claims, blocked/queued actors, and the "Needs you" queue. Binds 127.0.0.1 only, read-only over `.quilt/`, refreshes every 2s; falls back to a free port when the default (4747) is taken. |
| `quilt status [--json]` | Show who owns which working-tree changes. |
| `quilt mine [--json]` | Summarize the changes you own. |
| `quilt conflicts [--json]` | Show shared changes: same-line clashes vs adjacent edits that commit cleanly. |
| `quilt undo <actor> [--dry-run]` | Back out one actor's uncommitted changes, leaving everyone else's untouched. |
| `quilt escalate <target> [--reason]` | Flag a collision agents can't reconcile for a human (shows under "Needs you"). |
| `quilt resolve <target> [--note] [--take --from <actor>]` | Mark a collision handled. Plain resolve is audit-only; `--take` transfers the named actor's dirty operations to the resolver. |
| `quilt restore [path] [--json]` | List or recover work overwritten by another actor. |
| `quilt preview --mine [paths...] [--json] [--include-unclaimed]` | Print the exact patch `commit --mine` would create. Path args (files or directory prefixes) scope the preview. |
| `quilt commit --mine [paths...] -m <msg> [--dry-run] [--include-unclaimed]` | Commit only your owned patch. Path args are a hard allow-list: name a file or directory and nothing else rides along. When another actor holds a live claim, a NEW file you never claimed or edited is left out loudly (`skippedUnowned`): claim it, or pass `--include-unclaimed` if it's yours. |
| `quilt claim [targets...] [--json] [--creating] [--wait [s]] [--queue]` | Reserve files (`src/auth.ts`), directories (`convex/_generated/`), or symbols (`file#symbol`) for editing, BEFORE you edit; the claim is what binds external edits to you. A symbol missing from the file is denied unless `--creating` (you are about to add it). `--wait` blocks until denied targets free up; `--queue` is the async alternative: register interest, return now, get auto-granted when it frees (surfaced in `quilt status` as "granted while you waited"). With no targets, lists claims. A conflicting claim whose holder shows no sign of life for 5+ minutes (or whose session ended) and has no uncommitted work in the target is reclaimed automatically; the grant reports `reclaimedFrom`. |
| `quilt release [paths...]` | Release your claims (all of yours if no paths). Also cancels your queued interest in the released targets. |
| `quilt mcp` | Run the MCP server (stdio) for agent integration. |
| `quilt doctor [--json]` | Health check: is Quilt wired, is identity set, and is capture actually flowing? Also checks the installed version against npm (cached daily, silent offline), the system git (2.18+ needed), and live-tests that the wired MCP server starts and lists its tools. |
| `quilt update [--check]` | Update to the latest published version. Detects how Quilt was installed (npm/pnpm/bun) and runs the right command, or prints it when the installer can't be detected confidently. `--check` only reports (non-zero exit when behind). |
| `quilt telemetry [on\|off]` | Show or change anonymous usage telemetry. Off by default; `quilt setup` asks once on a TTY. See [Telemetry](#telemetry). |
| `quilt whoami` | Show the active actor and session. |
| `quilt end` | End the active session. |

A global `--as <id>` sets your actor for any command (the per-command form of `QUILT_ACTOR=<id>`). An explicit `QUILT_ACTOR` env var wins over `--as`; `QUILT_SESSION=<session>` pins a live session. Actor-sensitive mutation refuses a checkout-global pointer when another actor owns dirty work.

Run `quilt --help` or `quilt <command> --help` for the full flag list.

## Provenance review: `quilt ui`

In the **Who wrote what** table, select a changed file to expand its live
`HEAD` to worktree diff. Each changed line shows its Quilt actor, conflicts
list every credited actor, and edits without recorded ownership are marked
unattributed.

For auto-derived Claude Code and Codex actors, Quilt can also show the latest
user prompt before the captured edit. Prompt matching is a time-based inference,
not a hard link. Transcripts are read from local agent storage only after the
file is expanded. Prompt text never leaves the loopback-only dashboard and is
never included in telemetry. Other actor types continue to show reliable
per-agent attribution without a prompt.

An actor represents a session or subagent run, not necessarily one person or
one prompt. Raw shell writes, generated files, and pre-existing dirty changes
can legitimately remain unattributed.

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

Attribution keys each changed-operation instance by add/remove side, symbol
scope, line content, and occurrence. Blank lines and lone braces/punctuation
are ignored so they don't false-conflict. Identical lines in different functions
or repeated inside one function remain distinct. Binary files are never
attributed or committed. Quilt is POSIX-first; CRLF and `core.autocrlf`
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

## Telemetry

Anonymous usage telemetry is off by default and strictly opt-in: `quilt setup`
asks once, on an interactive TTY only (never in CI, never over a pipe), and
records the decision either way so it never asks twice. Toggle any time with
`quilt telemetry on|off`; `quilt telemetry` shows the current state.

What is sent when enabled, and only then:

| Event | When | Properties |
| --- | --- | --- |
| `quilt_setup_completed` | `quilt setup` finishes | detected orchestrator name, whether the repo was already wired |
| `quilt_session_started` | `quilt start` | actor type (`human`/`agent`/`bot`) |
| `quilt_claim` | `quilt claim` with targets | counts: granted, denied, queued |
| `quilt_commit_mine` | `quilt commit --mine` succeeds | count of files committed |
| `quilt_escalation` | `quilt escalate` | none |

Every event also carries the quilt version, the platform (`darwin`/`linux`),
the Node major version, and a random anonymous id generated locally (stored in
`~/.config/quilt/telemetry.json`, kept across on/off toggles). Nothing else:
no code, file paths, repo names, actor ids, branch names, commit messages, or
claim intents. The hot capture path (`hook-pre`/`hook-post`) is never
instrumented.

Environment variables: `QUILT_TELEMETRY=0` forces telemetry off for a process
regardless of the stored decision (set it in CI); `QUILT_TELEMETRY=1` forces
it on the same way. Events are posted to PostHog by a short-lived detached
process, so no quilt command ever waits on the network, and delivery failures
are silent.
