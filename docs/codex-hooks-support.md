# Backlog: native hook capture for OpenAI Codex

Status: **not started** — captured 2026-07-05. This is a marker so whoever owns
Quilt picks it up, not a finished design.

## The premise that turned out wrong

`docs/orchestrators.md` (the "Two ways to capture" section) currently says the
hooks path is Claude-Code-only and routes Codex to the MCP path because Codex is
a "runtime that has no hook system." **That is no longer true.** Codex CLI
(verified on 0.142.5) has a full hook system that reads `~/.codex/hooks.json`,
with a schema near-identical to Claude Code's `settings.json` hooks. So Codex can
get the same seamless native-edit capture Claude Code gets today, instead of only
the explicit `quilt_edit`/`claim` MCP path.

## Why this is a Codex *adapter*, not a config flag

The capture core (snapshot file on Pre → let the tool run → diff on Post →
attribute) is tool-agnostic and survives. What's Claude-shaped is the parsing
layer (`src/hooks.ts` `parseHookInput`) and the setup wiring (`src/onboard.ts`).
Codex's tool boundary is structurally different:

| | Claude Code (parsed today) | Codex |
|---|---|---|
| Config file | `.claude/settings.json` | `~/.codex/hooks.json` (global, not per-repo) |
| Edit tool name | `Edit` / `Write` / `MultiEdit` | `apply_patch` (always) — matcher may be `apply_patch\|Edit\|Write` but payload reports `tool_name: "apply_patch"` |
| Payload | `tool_input.file_path` + `edits[]` w/ `old_string`/`new_string` | `tool_input.command` = a raw `apply_patch` blob (`*** Update File: <path>` / `@@` hunks) |
| Files per call | one | **potentially many** in one patch — Quilt's model is one `file_path` per event |
| Post output | — | `PostToolUse` adds a `tool_response` field |
| Identity | `session_id` + `agent_id`/`agent_type` → `claude-<8>` | Codex payload has `session_id`, `cwd`, `turn_id`, `tool_use_id`, `hook_event_name`, `model`, `permission_mode`; derive `codex-<n>` |

The multi-file `apply_patch` is the real design wrinkle: one hook event can touch
N files, so snapshot/diff/attribute must loop over the files parsed out of the
patch blob, not assume a single `file_path`.

## Open unknown — resolve before building

The exact JSON of a real Codex `apply_patch` hook payload is not documented (the
patch structure inside `tool_input.command`). **First step: land a throwaway hook
that logs one real payload from a live Codex `apply_patch`**, then design the
parser against ground truth. Do not design the patch parser from the docs alone.

## Deny/prevention is a separate, later question

Quilt's claim-prevention emits Claude's `hookSpecificOutput.permissionDecision:
"deny"` on PreToolUse. Codex has its own permission model (`permission_mode`, a
`PermissionRequest` event). Capture (authorship) is the 80/20 and should ship
first; verify Codex's deny/permission schema before attempting prevention parity.

## Concrete surface (from recon, ~23 Claude-hardcoded spots)

Files, in dependency order:
1. `src/onboard.ts` — detect Codex (`~/.codex/` present), plan Codex setup steps,
   merge into `~/.codex/hooks.json` (global file — different from per-repo
   `.claude/settings.json`; think about idempotent merge into a shared file).
   Hardcoded today: `HOOK_MATCHER = "Edit|Write|MultiEdit"` (onboard.ts:14),
   `.claude/settings.json` path (onboard.ts:92), `"Claude Code"` naming and the
   `claude-` actor prefix (onboard.ts:104/115), fallback message (cli.ts:274).
2. `src/hooks.ts` — split `parseHookInput` into per-agent parsers
   (`parseClaudeHookInput` / `parseCodexHookInput`); Codex parser extracts file
   set + before/after from the `apply_patch` blob; actor id prefix per agent
   (hooks.ts:115).
3. `src/cli.ts` — `hook-pre`/`hook-post` deny-format routing (cli.ts:1140-1148),
   dynamic `hookEventName` (cli.ts:1143).
4. `src/doctor.ts` — report Codex hook status alongside Claude (doctor.ts:68).
5. `test/hooks.test.ts` + `test/onboard.test.ts` — Codex payload parsing, actor
   derivation, setup detection/wiring, capture roundtrip.
6. `docs/orchestrators.md` — correct the "no hook system" claim; document the
   Codex hooks path next to Claude Code's.

## Testing the result (what "done" looks like)

`quilt setup` in a repo detects Codex, wires `~/.codex/hooks.json`, and a real
Codex session editing files via `apply_patch` is captured with correct
per-file authorship in `.quilt/` — including a multi-file patch attributed
correctly across all its files.

## Spike results (2026-07-08, codex-cli 0.142.5, live)

Captured during the 0.4.4 launch-hardening pass; real payloads live in
[`codex-payload-samples/`](codex-payload-samples/).

**The patch format is tractable.** Confirmed against live single-file,
multi-file (Update x2 + Add File), and failed patches: the blob is OpenAI's
apply_patch envelope, and the capture core never needs to interpret hunks.
Pre: scan the blob for `*** Update/Add/Delete File:` markers, snapshot each
named file. Post: check the tool outcome, then diff snapshot vs disk per
file. A failed patch ("apply_patch verification failed") changes nothing and
must not be attributed.

**The real blocker is hook trust, not parsing.** Codex persists per-hook
trust in `~/.codex/config.toml` under
`[hooks.state."<file>:<event>:<group>:<index>"]` with an opaque
`trusted_hash`. A hook newly merged into `~/.codex/hooks.json` is silently
skipped (headless and interactive alike) until the user approves it in an
interactive Codex session or runs with `--dangerously-bypass-hook-trust`.
Verified live: pre-existing trusted hooks fired while the freshly added
logging hook never ran. Consequences:

- `quilt setup` wiring Codex hooks cannot deliver zero-config capture the
  way it does on Claude Code: the wired hooks do nothing until an
  interactive approval. That is the exact "silently not working" trap the
  0.4.4 release removes from the Claude path, so shipping Codex capture
  without handling it would recreate the bug we just fixed.
- Setup output and doctor must state the approval step explicitly (mirror
  of the MCP approval note), and doctor should read `[hooks.state]` to
  report wired-but-untrusted as its own check.
- The hook stdin envelope (exact field names) still needs one live capture
  from a TRUSTED hook; everything else about the parser can be built from
  the samples.

**Recommendation: 0.4.5 fast-follow, not 0.4.4.** The parser is clean, but
the trust flow needs its own design round (and one interactive approval to
capture the envelope). Codex users work over MCP at launch, as today.
