# Changelog

All notable changes to Quilt are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-06-30

The capture release: agents edit with their native tools and Quilt records who
wrote which lines — no protocol to follow — with attribution that survives
concurrent edits and stays correct even for identical lines in different
functions.

### Added

- **Native-edit capture hooks** — a `PreToolUse`/`PostToolUse` hook pair
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
  wrote) — same idempotent, non-clobbering merge.
- **`quilt doctor`** — a health check that turns silent failure visible: it
  reports whether Quilt is wired, whether `QUILT_ACTOR` is set, and — the key
  signal — how many edits have actually been captured, warning when there are
  uncommitted changes but nothing was recorded (the tell that capture isn't
  flowing). `--json` for scripts.

### Changed

- **The capture ledger is now the primary attribution source; content-key
  inference is the fallback floor.** Reconcile attributes every captured line to
  its recorded author and only falls back to inference for lines the ledger never
  saw (e.g. a raw `bash`/`sed` write) — so who ran `reconcile` first no longer
  affects attribution for any captured edit.
- **Ownership is now keyed by symbol scope + line text, not bare text.** Two
  identical lines in different functions (e.g. `  return null;`) no longer collapse
  to one owner — each gets its own attribution, closing a class of false conflicts
  and misattributions. Applies across reconcile, commit, undo, the fleet view, and
  the capture ledger.
- **Log compaction** — the append-only authorship log folds into a checkpoint and
  truncates once it grows past a threshold, so reconcile reads the checkpoint plus
  a short tail instead of re-reading all of history. A captured removal drops
  exactly that line's ownership, so compaction prunes removed lines rather than
  retaining stale entries. The checkpoint is written atomically before the log is
  truncated, and the fold is idempotent, so an interrupted compaction re-folds
  rather than losing authorship.

### Performance

- **`reconcile` no longer scales with changed-file count.** It read each changed
  file's HEAD content in a separate `git` subprocess (~19 ms/file — up to ~2.9 s on
  a churny 150-file repo). It now batches all those reads into one `git cat-file
  --batch`, so a 150-file reconcile drops from ~2.9 s to ~70 ms (~43×). `reconcile`
  runs on every Quilt command, so this is a whole-loop speedup on large repos.

## [0.2.0] - 2026-06-30

The orchestration release: drop a whole fleet of agents into one checkout with a
single command, and coordinate them through one shared server.

### Added

- **`quilt setup`** — one command wires Quilt into the repo's agent orchestrator:
  it detects the orchestrator (Claude Code, Cursor, AGENTS.md), adds the shared
  `quilt` MCP server to `.mcp.json` (merging, never clobbering existing config),
  and appends a coordination snippet to `CLAUDE.md`. Idempotent; `--dry-run`
  previews. `quilt init` now hints toward it when an orchestrator is detected.
- **Per-call-actor MCP** — one `quilt mcp` server attributes a whole fleet of
  subagents: every tool takes an optional `actor`, so there's no single active
  identity for the others to clobber. No `start_session` needed.
- **`quilt fleet`** — mission control: every actor, their claims, overlapping
  work, blocked claims, dependency heads-up, and collisions in one view.
  `--json` and `--watch`.
- **`quilt undo <actor>`** — surgically back out one actor's uncommitted changes
  from the shared tree, leaving everyone else's work in place (`--dry-run`).
- **More languages for symbol claims** — symbol-level claims and attribution now
  cover Python, Go, Rust, Java, Ruby, C, and C++ in addition to the JS/TS family
  (ten languages total), via tree-sitter.
- **Self-sewing collisions** — agents resolve most collisions themselves and
  surface only the genuine conflicts to you. A claim carries a short `intent`;
  when it's denied, the blocked agent receives the holder's intent and can drop a
  redundant change, adapt, or — if the goals are truly opposed — `escalate` it
  instead of overwriting. `quilt escalate` / `quilt resolve` record the outcome,
  and `quilt fleet` splits it into **Needs you** (a human's call) and **Sewn by
  agents** (the audit trail). Quilt never calls an LLM or spawns agents — it hands
  your existing agents the context and records what they decide.

### Changed

- **Collision detection tells a real clash from benign adjacency.** A shared
  hunk is now classified `contended` (two actors changed the same line — review)
  or `adjacent` (different lines that merely share a hunk — commits cleanly), so
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
  actor is changing, Quilt warns you at claim time — surfaced in `quilt claim`,
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

[0.3.0]: https://github.com/wkoverfield/quilt/releases/tag/v0.3.0
[0.2.0]: https://github.com/wkoverfield/quilt/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wkoverfield/quilt/releases/tag/v0.1.0
