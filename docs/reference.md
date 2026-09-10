# Quilt reference

The full command list, how attribution works internally, and the on-disk state
layout. For a quick start, see the [README](../README.md). For running a fleet of
agents, see [orchestrators.md](orchestrators.md).

## Commands

| Command | Purpose |
| --- | --- |
| `quilt init` | Initialize `.quilt/` in the repo. |
| `quilt setup [--dry-run] [--gitignore]` | Wire Quilt into the repo's orchestrator (or, run from a non-repo directory that contains repos, wire that whole workspace: hooks + snippet at the root, full wiring in each child repo): the shared MCP server in `.mcp.json` (and `.cursor/mcp.json` when a `.cursor/` dir exists), the coordination snippet in `CLAUDE.md` (and an existing `AGENTS.md`), the native-edit capture hooks and the raw-git guard in `.claude/settings.json`, and the pre-commit guard in `.git/hooks/pre-commit` (all idempotent; the pre-commit hook is re-verified every run since re-clones wipe `.git/hooks`). Setup then lists any of these files that git neither tracks nor ignores, since a later `git add -A` would sweep them into a commit; it says so more loudly when `gh` reports the repo public. Commit them to share the wiring (the default), or pass `--gitignore` to ignore newly untracked config. Existing tracked config remains tracked, and setup names any tracked files it changes. |
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
| `quilt commit --mine [paths...] -m <msg> [--dry-run] [--include-unclaimed]` | Commit only your owned patch and embed durable provenance. Path args are a hard allow-list. `--include-unclaimed` is recorded as mixed capture. Prompt correlation remains local and is not published into Git. |
| `quilt provenance [commit] [--json]` | Read the portable, versioned Quilt provenance embedded in a commit. Defaults to `HEAD` and works without local `.quilt/` state. |
| `quilt claim [targets...] [--json] [--creating] [--wait [s]] [--queue]` | Reserve files (`src/auth.ts`), directories (`convex/_generated/`), or symbols (`file#symbol`) for editing, BEFORE you edit; the claim is what binds external edits to you. A symbol missing from the file is denied unless `--creating` (you are about to add it). `--wait` blocks until denied targets free up; `--queue` is the async alternative: register interest, return now, get auto-granted when it frees (surfaced in `quilt status` as "granted while you waited"). With no targets, lists claims. A conflicting claim whose holder shows no sign of life for 5+ minutes (or whose session ended) and has no uncommitted work in the target is reclaimed automatically; the grant reports `reclaimedFrom`. |
| `quilt release [paths...]` | Release your claims (all of yours if no paths). Also cancels your queued interest in the released targets. |
| `quilt git -- <args>` | Run raw git deliberately in a guarded checkout: records a ledger event, snapshots the index first when the command can destroy staged state (reset, stash, read-tree, `checkout -- <paths>`), then executes system git verbatim with the pre-commit guard stood down. Exit code mirrors git's. |
| `quilt snapshots` | List index snapshots taken before destructive git commands. Each is a real tree object; `git read-tree <tree>` restores that staging selection without touching worktree files. |
| `quilt mcp` | Run the MCP server (stdio) for agent integration. |
| `quilt doctor [--json]` | Health check: is Quilt wired, is identity set, and is capture actually flowing? Also checks the installed version against npm (cached daily, silent offline), the system git (2.18+ needed), and live-tests that the wired MCP server starts and lists its tools. |
| `quilt update [--check]` | Update to the latest published version. Detects how Quilt was installed (npm/pnpm/bun) and runs the right command, or prints it when the installer can't be detected confidently. `--check` only reports (non-zero exit when behind). |
| `quilt telemetry [on\|off]` | Show or change anonymous usage telemetry. A daily heartbeat is on by default; command events are opt-in (`quilt setup` asks once on a TTY). `off` silences everything. See [Telemetry](#telemetry). |
| `quilt whoami` | Show the active actor and session. |
| `quilt end` | End the active session. |

A global `--as <id>` sets your actor for any command (the per-command form of `QUILT_ACTOR=<id>`). An explicit `QUILT_ACTOR` env var wins over `--as`; `QUILT_SESSION=<session>` pins a live session. Actor-sensitive mutation refuses a checkout-global pointer when another actor owns dirty work.

Run `quilt --help` or `quilt <command> --help` for the full flag list.

Any ordinary command also prints a one-line stderr notice, at most once a
day, when the cached registry check shows a newer release. The foreground
never waits on the network (a stale cache refreshes in a detached process),
`hook-*` commands and `quilt mcp` never print it, and `QUILT_NO_UPDATE_CHECK=1`
silences every version check.

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

## Durable provenance in Git

`quilt commit --mine` writes a compact, versioned provenance envelope into the
commit message. It records the actor, Quilt session when safely available,
every file and hunk range in the owned patch, whether unclaimed changes were
explicitly included, and the exact parent and tree objects. Because the record
is part of the commit, ordinary pushes, fetches, and clones carry it.

Prompt matching remains a time-based inference in the local review UI. Prompt
text and fingerprints are not written into Git history.

This is self-reported commit metadata, not a cryptographic signature. Quilt
verifies that the embedded parent and tree match the commit before displaying
the record. A future signed attestation layer can add authenticity for policy
enforcement.

Inspect a record as text or JSON:

```bash
quilt provenance HEAD
quilt provenance HEAD --json
```

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

## The raw-git guard

The git index (`.git/index`, the staging area) is one shared file per checkout.
Every `git add`, `git reset`, and `git commit` operates on it regardless of
which actor runs the command, so with several actors working, raw staging can
commit one actor's staged files under another actor's message, or silently
discard a staging selection. `quilt commit --mine` never touches the shared
index (it builds each commit in a private temporary index), and the guard
keeps the raw path from racing it. Two layers:

- **In agent sessions** (wired by `quilt setup` as a `Bash`-matcher hook in
  `.claude/settings.json`): index-mutating git commands (`add`, `commit`,
  `reset`, `stash` except `list`/`show`, `rm`, `mv`, `update-index`,
  `read-tree`, `restore --staged`, `apply --cached`, `checkout -- <paths>`)
  are denied while two or more actors have uncommitted attributed work,
  including when wrapped in `sh -c`, `xargs`, or backticks. With zero or one
  such actor the command runs unguarded; before an allowed `reset`/`stash` the
  index is snapshotted (see `quilt snapshots`). Read-only git, dry-run
  previews, and branch switching are never touched.
- **At commit time** (a `pre-commit` hook `quilt setup` installs into the
  effective hooks directory, respecting `core.hooksPath` and worktrees, and
  re-verifies on every run since re-clones wipe `.git/hooks`): a commit
  whose staged set spans two or more actors' lines is refused. This catches a
  `git add -A` sweep of a shared tree from any shell, agent or human. It
  cannot attribute the person committing, so a commit that contains exactly
  one actor's staged work always passes here; only the session-level guard
  can see who is acting. A pre-existing `pre-commit` hook is preserved as
  `pre-commit.local` and still runs after the check passes.

Two limits, stated plainly because assuming otherwise is how staged work gets
lost:

- **Pure theft is stopped only by the session-level layer.** The canonical
  race is a bare `git commit` that ships another actor's already-staged tree
  under the committer's message. That staged set belongs to exactly one
  actor, so the pre-commit check passes it; only the session hook, which
  knows who is acting, refuses it. The pre-commit layer exists for the
  sweep case, not this one.
- **The dirty-actor census counts attributed work.** Bash-write capture
  (below) attributes most writes, so coverage is normally high; what remains
  invisible is writes from outside any agent session (human terminals, cron,
  editors). The guard does not stand down silently when coverage is dark: it
  warns when the tree is dirty, multiple actors are registered, and nothing
  is attributed, and `quilt doctor` reports the same condition as
  "Attribution coverage".

Both layers fail open: if `quilt` is missing from `PATH`, or is an older
version, commands and commits proceed rather than break. The deliberate
override for both layers is `quilt git -- <args>`.

## How attribution works

Quilt is conservative: a blocked commit beats a wrong one.

Capture runs at three tool boundaries, all wired by `quilt setup`:

- **Native edits** (Claude Code Edit/Write/MultiEdit): the hook pair replays
  the edit payload in memory, so the recorded delta is exact and a sibling's
  concurrent write cannot leak into it.
- **Bash writes** (heredocs, `sed`, `patch`, codegen scripts): the Bash hook
  pair snapshots the git-dirty set before the command and diffs it after,
  attributing the delta to the calling session. The before-image for a file
  that was already dirty is its pre-call snapshot; for a clean file, its HEAD
  blob; for a new file, empty. These events carry `mode: "bash"` because the
  delta is inferred from disk: a write from another session landing during
  the call can ride into it (the same trade-off as Codex capture). Capture
  skips, with a `capture.skipped` ledger event, when the pre-call dirty set
  exceeds 200 files or 5MB of content; binary files are change-detected but
  never line-attributed.
- **Codex `apply_patch`**: the envelope's file list drives the same
  snapshot-and-diff core.

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
  index-snapshots.jsonl       # write-tree snapshots taken before destructive git commands
  authorship.log              # captured edits: who authored which lines
  authorship.checkpoint.json  # compacted fold of old authorship events
  hooks/                      # pre/post hook snapshots (pre-edit file content)
```

`.quilt/` is git-ignored automatically.

## Telemetry

Telemetry has two tiers. The daily heartbeat is on by default: at most once
per 24 hours, the first ordinary quilt command of the day sends a single
`quilt_heartbeat` event carrying only the shared envelope described below.
Command events are strictly opt-in: `quilt setup` asks once, on an
interactive TTY only (never in CI, never over a pipe), and records the
decision either way so it never asks twice. Toggle everything with
`quilt telemetry on|off`; `quilt telemetry` shows the state of both tiers
and why. Saying no at the prompt, or running `quilt telemetry off`, turns
off both tiers, including the heartbeat.

Command events, sent only after opt-in:

| Event | When | Properties |
| --- | --- | --- |
| `quilt_setup_completed` | `quilt setup` finishes | detected orchestrator name, whether the repo was already wired |
| `quilt_session_started` | `quilt start` | actor type (`human`/`agent`/`bot`) |
| `quilt_claim` | `quilt claim` with targets | counts: granted, denied, queued |
| `quilt_commit_mine` | `quilt commit --mine` succeeds | count of files committed |
| `quilt_escalation` | `quilt escalate` | none |

Every payload, heartbeat included, carries the same envelope and nothing
else: the quilt version, the platform (`darwin`/`linux`), the Node major
version, and a random anonymous id generated locally (stored in
`~/.config/quilt/telemetry.json`, kept across on/off toggles, meaningless
outside these events). No code, file paths, repo names, actor ids, branch
names, commit messages, or claim intents. The hot capture path (every
`hook-*` command) is never instrumented and never sends anything.

Environment variables: `QUILT_TELEMETRY=0` forces everything off for a
process regardless of the stored decision; `QUILT_TELEMETRY=1` forces
everything on the same way and wins over the signals below. The standard
`DO_NOT_TRACK=1` convention is honored and silences both tiers, and a set
`CI` variable does the same, so pipelines never send anything. Before a
stored decision exists, forced telemetry uses an ephemeral id scoped to
that CLI process and does not write consent state. Payloads are posted to
PostHog by a short-lived detached process, so no quilt command ever waits
on the network, and delivery failures are silent.
