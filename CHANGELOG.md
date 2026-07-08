# Changelog

All notable changes to Quilt are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.4] - 2026-07-08

### Added

- **Version staleness is now visible, and updating is one command.** `quilt
  doctor` and `quilt setup` check the installed version against npm (cached
  daily, bounded, and silent when offline; `QUILT_NO_UPDATE_CHECK=1` opts
  out). Behind is a warning with the exact update command; below 0.4.0 makes
  doctor's verdict not-ready, because pre-auto-identity builds capture nothing
  for unnamed sessions. The new `quilt update` detects how Quilt was installed
  (npm/pnpm/bun) and runs the right update, or prints it when the installer
  can't be detected confidently. The hook path (`hook-pre`/`hook-post`) never
  touches the network.
- **`quilt doctor` catches a stale system git.** Quilt needs `git status
  --no-renames` (git 2.18+); a pre-2018 git on PATH used to fail deep inside
  every command with a cryptic usage error. Doctor now names the version, the
  breaking flag, and the usual fix (an old git shadowing a newer one on PATH).
- **`quilt doctor` live-tests the MCP server.** It spawns the exact command
  wired in `.mcp.json`, drives a real initialize/tools-list handshake, and
  reports "server starts and lists N tools" or a clear failure. It also states
  what it cannot see: the agent client still has to approve the server (Claude
  Code: `/mcp`) for the claim tools to appear in a session.
- **Wrong-directory guidance.** Running `quilt setup`/`init`/`doctor` one
  level above the repo (a checkout root whose app lives in a subfolder) now
  refuses and names the child repo to `cd` into, instead of wiring agent
  config at a directory no session reads.

### Changed

- **The coordination snippet and setup output now lead with the
  zero-approval path.** Hooks capture and protect edits with nothing to
  approve and nothing to call; `quilt commit --mine` works with or without
  the MCP server; the MCP claim tools are framed as the optional prevention
  layer they are. Setup also states the Claude Code restart/approval step in
  plain words, with the CLI fallback named, so a session without the MCP
  tools reads as expected rather than broken.

### Fixed

- **The coordination snippet now refreshes in place when it changes.** The
  marker is versioned (`quilt:coordination v2`); a repo onboarded under an
  older Quilt gets its block replaced on the next `quilt setup` (surrounding
  CLAUDE.md content preserved), instead of being frozen forever on whatever
  framing it first received. `quilt doctor` warns when the snippet is stale.
- **`quilt fleet` no longer shows hook-captured edits as "Unattributed / 0
  actors".** The read-only fleet view now overlays the authorship ledger, so
  an edit whose author the ledger already knows is attributed immediately,
  before any actor's next reconcile, in the one view a user watches first.

## [0.4.3] - 2026-07-05

### Added

- **`commit --mine [paths...]` and `preview --mine [paths...]`: a hard path
  allow-list (MCP: `paths` array on `commit_mine` / `preview_mine`).** Naming
  files or directory prefixes commits exactly those and nothing else, so an
  unnamed change can never ride along. A path outside the repo is a loud error,
  not a silent shrink. Previously `commit --mine mine.ts` ignored the path
  entirely and swept in everything the actor owned.
- **The contested-tree orphan gate.** When another actor holds a live claim, a
  NEW untracked file the actor never claimed and never captured is left out of
  `commit --mine` loudly (`skippedUnowned` in JSON/MCP, plus a warning naming
  the escape hatches: claim it, or `--include-unclaimed`). Inference
  attribution persists, so an orphan attributed in a briefly-uncontested tree
  would otherwise ride into commits forever. Solo trees are exempt: a new file
  in your tree is yours. A forward symbol claim (`new.ts#helper --creating`)
  counts as claiming the file, and hook/MCP-captured edits count as authorship.

- **Async claims, `claim --queue` (MCP: `queue: true`): register interest and
  get AUTO-GRANTED when the target frees, without blocking.** A blocked call is
  a blocked agent. A
  queued claim returns immediately; when the holder releases (commit
  auto-release included) or their lease lapses, the earliest waiter is granted a
  real claim and discovers it at its next `quilt status` / `get_status`
  (`grantedWhileWaiting`). No blocking, no polling. FIFO and self-healing: an
  idle grant re-promotes the next waiter, and abandoned interest expires. The
  `quilt fleet` view shows the queue. No daemon: auto-grant happens on the next
  reconcile any actor triggers.
  - The holder SEES who's queued behind it (`quilt status`: "← 1 waiting (B) — commit to hand off"), so it hands off promptly instead of releasing blind.
  - A grant is discoverable on either natural check-back: `quilt status` OR a plain `claim` retry both surface "Granted while you waited" (not status-only).
- **Global `--as <id>` flag**: a per-command way to set your actor
  (`quilt --as builder-a claim …`), the ergonomic alternative to prefixing
  `QUILT_ACTOR=<id>` on every call. An explicit env var still wins.
- **`claim --wait` (MCP: `wait` seconds): block until denied targets free
  up.** After a denial, retrying used to mean blind polling: get denied, guess
  when to retry, hope. The claim call can
  now hold until the holder releases (commit auto-release included) or their
  lease lapses, pacing itself against the lease expiry, and returns granted
  the moment the way is clear. Denials waiting can't fix (bad path, missing
  symbol) still fail fast. Each retry also refreshes the waiter's own claims
  and keeps its blocked-on state fresh in the fleet view.

### Fixed (queue fairness and safety, pre-release)

- The queue outranks a walk-up: acquiring now promotes waiters first, so a
  direct claim can no longer steal a just-lapsed lease ahead of an actor that
  was told "you're next."
- An earlier still-blocked waiter reserves its target: a later overlapping
  waiter (mixed granularity) can no longer jump the head of the queue.
- A queued interest is no longer dropped when the actor holds a NARROWER
  overlapping claim (holding `deals.js#foo` used to silently void a queued
  interest in whole-file `deals.js`).
- A queued grant now lives at least as long as the interest window it replaced
  (the waiter TTL), so an actor heads-down elsewhere cannot silently lose a
  target it was first in line for.
- `release` also cancels the actor's own queued interest in the released
  targets, so a departed actor is never auto-granted a claim it walked away
  from.
- `claim --wait` validates its value eagerly: `claim a.ts --wait b.ts` (the
  optional-value flag swallowing a path) now fails loudly before claiming
  anything, instead of exiting 0 having claimed only `a.ts`.
- Grant announcements are marked notified surgically (only the grants actually
  shown), closing a race where a grant promoted mid-command was stamped
  notified without ever being surfaced.
- MCP `claim` now rejects `wait` + `queue` together, matching the CLI: the
  combo left a live waiter behind a timed-out wait, later auto-granting a claim
  the agent was never told about.
- `--wait` outcome (`waitedMs`, `timedOut`) now rides in `claim --json` output
  too, matching the MCP shape, so a script can tell a timeout from an instant
  denial.
- `commit --dry-run` and human `preview` now surface `skippedUnowned`, so the
  orphan gate is visible on the verification surfaces, not only on the real
  commit.

### Changed

- Positioning and protocol docs now lead with the shared-checkout reality:
  captured edits need no claims at all for uncontested work (edit, then
  `commit_mine`); claims are for binding UNCAPTURABLE edits (bash, codegen)
  and for protecting code you don't want touched. The coordination snippet,
  orchestrators guide, and README problem statement all updated: the
  everyday value is surgical commits on one environment, not contention
  ceremony.
- `commit --mine` counts whole-staged binary files in its reported file
  count (a pure-binary commit no longer prints "Committed 0 file(s)").

## [0.4.2] - 2026-07-04

### Fixed

- **Binary and too-large files are no longer silently dropped from commits**
  (in real use, `package-lock.json` tripped the too-large-to-diff
  classification and vanished from `commit_mine` without a word — a broken
  build for everyone until a manual commit). No line-level split exists for
  such files, so the claim is the ownership signal: a file covered by your
  whole-file or directory claim is committed WHOLE (byte-exact, staged
  straight into the temp index); an unclaimed one is skipped LOUDLY — the CLI
  warns, and `commit_mine`/`preview_mine` return `skippedBinary` with
  guidance to claim it.

### Added

- A symbol-claim adoption regression test proving the phase-7 attribution
  shape is covered: a hook edit under an ambient auto id inside a REAL
  claimed symbol binds to the claim holder. (The phase-7 failure itself was
  the missing-symbol variant, which 0.4.1 denies at claim time.)
- Docs: the attribution-rebinding asymmetry (unclaimed→claimant rebinds;
  wrong-actor capture never does — revert + `quilt_edit` is the recovery) and
  the **deadlock-break play** (commit the granted 90%, release, let the other
  actor layer, re-claim the remainder) as the recommended move for mutual
  contention.

## [0.4.1] - 2026-07-04

### Fixed

- **Symbol claims that bind nothing are now denied** (real fleets'
  #1 finding). A symbol claim naming nothing real in the file — a typo, a
  schema table property, an unparseable file type — was granted but bound
  nothing: the claimant's external edits attributed elsewhere and its
  `commit_mine` silently dropped the file. Such claims now deny with a
  near-miss suggestion (`did you mean "formatPrice"?`) and guidance to claim
  the whole file. Pre-claiming a symbol you're about to ADD is still possible
  with the explicit `creating: true` (CLI `--creating`) opt-in — it binds when
  the symbol appears.
- **`includeUnclaimed` never touches another actor's claimed paths.** External
  edits attribute lazily, so a peer's mid-flight hunks can read "unclaimed"
  while their claim is live — sweeping them on that label stole live work.
  Claimed paths are now categorically off-limits to `--include-unclaimed`.
- **The read layer tells the truth mid-flight**: unattributed hunks on a path
  exactly one other actor has claimed are classed `other` with that actor
  named (attribution pending), not `unclaimed`. Status files also carry a
  file-level `actors` union — the side-effect-free "who holds what" view.
- **Clobber false positives eliminated**: a file whose worktree matches HEAD
  has nothing uncommitted to clobber (stale-baseline deltas are history that
  landed), and a deleted line still present at HEAD is landed code being
  rewritten — normal editing, never a clobber. Only uncommitted work counts
  as a victim.
- **Clobber lifecycle**: an open record whose sampled victim lines all exist
  at HEAD or in the worktree auto-resolves — stale alarms no longer greet
  every new actor for hours (which trained agents to ignore the one signal
  that matters most).

- **`.quilt/current` no longer binds hook capture (pilot root cause).** The
  session pointer is checkout-GLOBAL, so whoever ran `quilt start` last owned
  every subsequent captured edit in the repo, regardless of which agent made
  it — the mechanism behind both pilot misattribution rounds. Hook identity now
  comes only from per-edit signals: `QUILT_ACTOR` (per-process env) or the
  payload's agent/session ids. `quilt start` still scopes the CLI commands run
  in your own terminal.
- **`commit --mine` no longer drops trivial lines that open a change run.**
  Trivial lines (braces, closers like `}),`, blank lines) carry no ownership
  and inherit their change-run's decision — but a run-OPENING one had nothing
  to inherit from and silently vanished from the committed file (the pilot
  committed a syntax error from a dropped `}),`, and blank separator lines
  disappeared). Trivial lines now resolve from the nearest decided neighbor
  in their run (preceding, else following). A purely-trivial run (formatting
  only) has no owner signal at all: it commits with `--include-unclaimed`
  and is flagged as mixed rather than dropped silently.
- **`commit --mine` refuses to tear a symbol.** When a function had some of
  its changed lines owned by the committer and others excluded (unattributed
  or another actor's), the partial reconstruction committed a construct with
  missing lines — a syntax error in history. A file with a torn symbol is now
  withheld entirely (surfaced under "Left untouched in shared files") until
  the tear is resolved: claim/own the rest, use `--include-unclaimed`, or let
  the other actor commit first.
- **`commit --mine` no longer sweeps another agent's uncaptured files (pilot
  round 2).** The inference floor attributed every un-observed delta to
  whoever reconciled first — so files written by bash/CLI codegen (which
  capture never sees) and never claimed were absorbed into the first
  committer's commit. Inference is now gated in a contested tree: while any
  OTHER actor holds a live claim, it only attributes files the reconciling
  actor has claimed itself. Ungated single-actor behavior is unchanged.
  Un-claimed, un-captured deltas stay *pending* (frozen baseline) until their
  maker claims the file — in a fleet, own what you claim or what capture saw.
  Clobber DETECTION is deliberately not gated: an overwrite of another actor's
  uncommitted lines is still caught and preserved even in a gated file (with
  dedup, since a frozen baseline re-presents the same delta every reconcile).

- **Parallel subagents of one Claude Code session no longer merge into one
  actor.** Subagents share their parent's session id, so the session-derived
  auto id collapsed them all together — the first pilot's `commit --mine`
  swept another agent's freshly-written files into its commit. The hooks now
  read the payload's `agent_id`/`agent_type` (present only in subagent hooks)
  and derive a distinct id per subagent (`code-reviewer-f7e8d9c0`).
- **Claim adoption:** an edit arriving under an auto-derived id inside code
  claimed by exactly one actor is attributed to that holder — an agent that
  claims as `ui-agent` over MCP and edits with the native Edit tool is captured
  as `ui-agent` and is no longer denied by its own claim. Explicit identities
  (QUILT_ACTOR, start_session, per-call `actor`) are never adopted; their
  collisions still deny with the holder's intent. Ambiguity (two holders on the
  touched symbols) falls back to the deny.
- Captured edits refresh the editor's claim TTL, so a work session longer than
  the claim's 10-minute TTL can't silently lose its reservation (which let the
  next reconciler absorb the in-flight work).
- `quilt commit --mine` with a `QUILT_ACTOR` that was never separately
  registered (it only claimed, or its edits were captured via adoption) now
  registers the actor and commits, instead of failing with "no active actor".

- **Absolute file paths no longer disable prevention and capture.** Claude Code
  hooks and MCP clients send absolute `file_path`s, but claims, ownership, and
  the authorship ledger key on repo-relative paths — so a real agent's edit
  into another actor's claimed symbol was silently allowed, and its captured
  edits landed in ledger events reconcile could never match (the actor couldn't
  `commit --mine` its own work). Every actor-facing boundary (hooks, `quilt_edit`,
  `quilt_write`, claim/release) now normalizes to the repo-relative form,
  including through filesystem aliases (macOS `/tmp` → `/private/tmp`) and with
  Windows separators normalized to `/`.
- `quilt --version` and the MCP server now read the version from package.json
  instead of a hardcoded string (0.4.0 shipped reporting itself as 0.3.0).
- `quilt commit --mine` now releases the actor's claims on the committed files,
  as the MCP `commit_mine` already did, so the fleet view stops showing spent
  reservations.

### Changed

- **Claim TTL raised to 30 minutes, and claims renew on any activity.** Every
  quilt call (status, edit, commit — they all reconcile) refreshes the active
  actor's claims, so leases can't silently lapse mid-task or while blocked
  waiting on someone else. `release` reports lapsed claims separately
  (`expired: N`) instead of folding them into a confusing count.
- **`commit_mine` says it auto-released** the committed files' claims
  (`releasedClaims: N` + note). `release` with nothing held explains the
  auto-release instead of a bare `released: 0` — the paper cut every single
  real agent hit.
- **Denials carry the holder's claim expiry** (`holderExpiresAt`), so a
  blocked actor can pace retries instead of guessing.
- Claims carry `expiresAtIso` alongside the epoch `expiresAt`, matching
  `acquiredAt`'s format.

- One identity story everywhere: agents are auto-named; `QUILT_ACTOR` pins a
  stable id. `quilt status`, `whoami`, error messages, and a bare `quilt start`
  all say so consistently (start without `--actor` now explains itself instead
  of a raw missing-option error).
- Prevention denials name the specific held reservation
  (`utils.js#formatPrice`), not just the file, in hooks and MCP responses.
- `quilt status` labels unattributed changes "not captured — edited outside
  agent tooling" instead of the cryptic "pre-existing / generated?".

### Added

- **Directory claims**: a trailing slash (`convex/_generated/`) reserves every
  current and future path under the prefix — one claim for codegen output
  instead of guessing filenames in advance.
- The coordination snippet and docs now teach the binding rules real fleets
  learned the hard way: whole-file claims BEFORE editing, attribution is
  edit-time and never retroactive, commit auto-releases, shared-tree proof
  discipline, gitignore tooling artifacts.

- `quilt setup` wires Cursor too: a repo with `.cursor/` gets the quilt server
  in `.cursor/mcp.json`, and an existing `AGENTS.md` (Cursor/Codex-family)
  receives the coordination snippet.
- `quilt setup` attributes its own generated files to a `quilt-setup` actor, so
  the first `quilt status` shows them as owned instead of flagging Quilt's own
  wiring as suspicious unattributed changes.
- `quilt setup` warns when `quilt` doesn't resolve on PATH (hooks and the MCP
  server would silently do nothing), and its epilogue now says to commit the
  generated config files and links the full docs URL.

## [0.4.0] - 2026-07-01

Zero-config identity: agents no longer need to be named for capture to flow.

### Added

- **Automatic actor ids.** When no identity is set, Quilt derives one instead of
  capturing nothing: the Claude Code hooks name each session from its session id
  (`claude-1a2b3c4d`), and the MCP server names each connection from the client's
  handshake name (`cursor-3fa2`). Parallel agents get distinct ids with no setup.
  An explicit `QUILT_ACTOR` (or per-call `actor`) always wins, and remains the way
  to keep one id across sessions or to tell apart several subagents sharing one
  process or connection, which no ambient signal can split.
  - Identity-optional reads (`get_status` with no actor) stay identity-less
    rather than minting an id, so the fleet view only shows actors that acted.
- `quilt doctor` and `quilt setup` now describe the unset-`QUILT_ACTOR` state as
  auto-naming instead of a missing requirement.

## [0.3.3] - 2026-07-01

Makes Quilt publishable to the official MCP Registry, so directories that crawl
the registry (Glama, PulseMCP, Smithery) can list it. No behavior changes.

### Added

- A `server.json` describing the `quilt mcp` stdio server, an `mcpName`
  (`io.github.wkoverfield/quilt`) in `package.json`, and the matching `mcp-name`
  marker in the README. These are what the registry uses to verify ownership and
  register the server.

## [0.3.2] - 2026-07-01

Another documentation-only release, so the README shown on npm matches the one on
GitHub. No code changes.

### Changed

- Reworded the fleet-demo caption in the README to drop a line that read as
  marketing.

## [0.3.1] - 2026-07-01

A documentation and repository release. No code changes, so the CLI behaves
exactly as it does in 0.3.0. This release exists so the version published to npm
carries the rewritten README.

### Changed

- Rewrote the README as a shorter launchpad: a plain one-line description of what
  Quilt is at the top, the two-agent contrast demo as the lead with the seven-agent
  fleet run as the scale proof, and the full command reference moved into
  `docs/reference.md`.

### Added

- A CONTRIBUTING guide, a SECURITY policy, pull request and issue templates, and a
  Dependabot config for grouped weekly dependency and Actions updates.

## [0.3.0] - 2026-06-30

The capture release: agents edit with their native tools and Quilt records who
wrote which lines, no protocol to follow, with attribution that survives
concurrent edits and stays correct even for identical lines in different
functions.

### Added

- **Native-edit capture hooks**: a `PreToolUse`/`PostToolUse` hook pair
  (`quilt hook-pre` / `quilt hook-post`) that gives agents authorship capture and
  collision prevention on Claude Code's built-in `Edit`, `Write`, and `MultiEdit`
  tools with no protocol to follow: agents edit normally and Quilt records the
  author of each change, denying a write into code another agent holds. Each agent
  identifies itself with `QUILT_ACTOR`; without it the hooks capture nothing rather
  than misattribute. The `quilt_edit` / `quilt_write` MCP tools remain the fallback
  for runtimes without hooks.
  - Capture is race-free: the pre hook snapshots the file's pre-edit content
    (keyed per actor+path) and the post hook reconstructs the result from the edit
    payload in memory, so a sibling's concurrent write to the same file can never
    leak into another agent's recorded delta.
- **`quilt setup` now also installs the capture hooks** into `.claude/settings.json`
  (in addition to the `.mcp.json` server and the `CLAUDE.md` snippet it already
  wrote), same idempotent, non-clobbering merge.
- **`quilt doctor`**: a health check that turns silent failure visible: it
  reports whether Quilt is wired, whether `QUILT_ACTOR` is set, and, the key
  signal, how many edits have actually been captured, warning when there are
  uncommitted changes but nothing was recorded (the tell that capture isn't
  flowing). `--json` for scripts.

### Changed

- **The capture ledger is now the primary attribution source; content-key
  inference is the fallback floor.** Reconcile attributes every captured line to
  its recorded author and only falls back to inference for lines the ledger never
  saw (e.g. a raw `bash`/`sed` write), so who ran `reconcile` first no longer
  affects attribution for any captured edit. This now covers **removed** lines as
  well as added ones, so `commit --mine` never includes deleting another actor's
  line even when several agents edit adjacent code with no reconcile in between.
- **Ownership is now keyed by symbol scope + line text, not bare text.** Two
  identical lines in different functions (e.g. `  return null;`) no longer collapse
  to one owner, each gets its own attribution, closing a class of false conflicts
  and misattributions. Applies across reconcile, commit, undo, the fleet view, and
  the capture ledger.
- **Log compaction**: the append-only authorship log folds into a checkpoint and
  truncates once it grows past a threshold, so reconcile reads the checkpoint plus
  a short tail instead of re-reading all of history. A captured removal drops
  exactly that line's ownership, so compaction prunes removed lines rather than
  retaining stale entries. The checkpoint is written atomically before the log is
  truncated, and the fold is idempotent, so an interrupted compaction re-folds
  rather than losing authorship.

### Performance

- **`reconcile` no longer scales with changed-file count.** It read each changed
  file's HEAD content in a separate `git` subprocess (~19 ms/file, up to ~2.9 s on
  a churny 150-file repo). It now batches all those reads into one `git cat-file
  --batch`, so a 150-file reconcile drops from ~2.9 s to ~70 ms (~43×). `reconcile`
  runs on every Quilt command, so this is a whole-loop speedup on large repos.

## [0.2.0] - 2026-06-30

The orchestration release: drop a whole fleet of agents into one checkout with a
single command, and coordinate them through one shared server.

### Added

- **`quilt setup`**: one command wires Quilt into the repo's agent orchestrator:
  it detects the orchestrator (Claude Code, Cursor, AGENTS.md), adds the shared
  `quilt` MCP server to `.mcp.json` (merging, never clobbering existing config),
  and appends a coordination snippet to `CLAUDE.md`. Idempotent; `--dry-run`
  previews. `quilt init` now hints toward it when an orchestrator is detected.
- **Per-call-actor MCP**: one `quilt mcp` server attributes a whole fleet of
  subagents: every tool takes an optional `actor`, so there's no single active
  identity for the others to clobber. No `start_session` needed.
- **`quilt fleet`**: mission control: every actor, their claims, overlapping
  work, blocked claims, dependency heads-up, and collisions in one view.
  `--json` and `--watch`.
- **`quilt undo <actor>`**: surgically back out one actor's uncommitted changes
  from the shared tree, leaving everyone else's work in place (`--dry-run`).
- **More languages for symbol claims**: symbol-level claims and attribution now
  cover Python, Go, Rust, Java, Ruby, C, and C++ in addition to the JS/TS family
  (ten languages total), via tree-sitter.
- **Self-sewing collisions**: agents resolve most collisions themselves and
  surface only the genuine conflicts to you. A claim carries a short `intent`;
  when it's denied, the blocked agent receives the holder's intent and can drop a
  redundant change, adapt, or, if the goals are truly opposed, `escalate` it
  instead of overwriting. `quilt escalate` / `quilt resolve` record the outcome,
  and `quilt fleet` splits it into **Needs you** (a human's call) and **Sewn by
  agents** (the audit trail). Quilt never calls an LLM or spawns agents, it hands
  your existing agents the context and records what they decide.

### Changed

- **Collision detection tells a real clash from benign adjacency.** A shared
  hunk is now classified `contended` (two actors changed the same line, review)
  or `adjacent` (different lines that merely share a hunk, commits cleanly), so
  the alarm means something. Surfaced in `quilt fleet`, `quilt status`, and
  `quilt conflicts`; full overwrites surface as preserved, restorable overwrites.
- Push-awareness (`dependencyWarnings`) now also rides on `get_status` and works
  across the newly supported languages.

## [0.1.0] - 2026-06-29

First public release. Quilt is the coordination layer for agent fleets: many
agents share one checkout and coordinate in the open instead of each hiding in a
worktree. Every commit Quilt makes is an ordinary Git commit.

### Added

- **Actor-owned commits.** `quilt commit --mine` commits only the lines you own,
  even when they share a hunk with another actor, leaving everyone else's work
  untouched in the working tree. Built on a temp-index patch so your real index,
  working tree, and refs are never rewritten.
- **Same-checkout attribution.** A reconcile step tracks which actor produced
  which lines; pre-existing or generated changes stay unclaimed.
- **Symbol-level claims.** Reserve `utils.js#formatPrice` instead of the whole
  file so agents editing different functions never contend. Parsing is powered
  by tree-sitter (JavaScript, JSX, TypeScript, TSX); other files fall back to
  whole-file claims.
- **Push-awareness.** When you claim a symbol that depends on a function another
  actor is changing, Quilt warns you at claim time, surfaced in `quilt claim`,
  `quilt status`, and the MCP `claim` / `get_conflicts` responses as
  `dependencyWarnings`.
- **Live watcher.** `quilt watch` attributes edits as they happen and, when one
  actor overwrites uncommitted lines another actor owns, preserves both versions
  and makes the loss recoverable via `quilt restore`.
- **MCP server.** `quilt mcp` exposes `start_session`, `get_status`,
  `get_my_changes`, `get_conflicts`, `preview_mine`, `commit_mine`, `claim`, and
  `release` so agents (and orchestrators) drive Quilt directly. Stable JSON on
  every read command.
- **Eval harness.** `npm run bench` runs Quilt against a graded scenario ladder
  (L1 disjoint work, L2 incompatible conflict, L3 dependency cascade, L4
  refactor-underfoot, L5 emergent overlap, L6 mixed actors + noise), each WITH vs
  WITHOUT Quilt, plus a documented live sub-agent layer. Architecture is settled
  by evidence, not vibes.
- Local-first: all state lives under `.quilt/`. No account, no daemon, no hosted
  service.

### Security

- Claim targets are validated against the repository root: absolute paths and
  `../` traversal are rejected before any filesystem read, with a defense-in-depth
  containment check at the read sink.

### Notes

- Published on npm as `@quilt-dev/cli`, providing the `quilt` command.
- Requires Node 20+ and `git` on the PATH.

[0.4.0]: https://github.com/wkoverfield/quilt/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/wkoverfield/quilt/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/wkoverfield/quilt/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/wkoverfield/quilt/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/wkoverfield/quilt/releases/tag/v0.3.0
[0.2.0]: https://github.com/wkoverfield/quilt/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wkoverfield/quilt/releases/tag/v0.1.0
