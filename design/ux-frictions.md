# UX friction log — fresh-user test run, 2026-07-03

> **Status: all 11 items fixed on `fix/ux-frictions` (2026-07-03).** Each fix
> verified by replaying the original repro against the rebuilt CLI; regression
> tests added for the P0/P1 items. Kept for the record of how each was found.

Method: clean install of the published package (`@quilt-dev/cli`) into a scratch
repo, following only what the README and CLI output say. Simulated the real
Claude Code hook payloads (absolute `file_path`, Pre → write → Post) and the
zero-config auto-actor flow. Every item below was reproduced, not inferred.

## P0 — broken on the real path (launch-blocking)

### 1. Absolute paths in hook payloads silently disable prevention AND attribution
Claude Code sends an **absolute** `tool_input.file_path`. The hooks resolve it
for filesystem access ([hooks.ts:126](../src/hooks.ts)) but pass the **raw**
string into the claim check, the snapshot key, and `recordAuthorship`.
Claims and ownership are keyed repo-relative, so nothing ever matches:

- `hook-pre` with an absolute path **allowed** an edit into another actor's
  claimed symbol (same payload with a relative path correctly denied).
- `hook-post` recorded the ledger event under the absolute path. Result: the
  actor's own `preview --mine` says "Nothing owned by you to commit", fleet
  shows them **idle** with their work under "Unattributed changes".
- With a claim in place, inference rescues attribution — which is why earlier
  end-to-end tests looked clean. The 0.4.0 zero-config flow (auto actors, no
  claims) has no rescue: capture flows into a dead ledger.

Fix: normalize to repo-relative at the hook boundary
(`relative(repoRoot, safeAbs(...))`) before claim-check/snapshot/record.
Apply the same normalization in MCP `quilt_edit`/`quilt_write` — the schema
*says* "repo-relative" but agents routinely pass the absolute paths they have
in context. Add tests that drive hooks with absolute paths (none do today —
that's how this slipped through).

## P1 — trust and consistency

### 2. `quilt --version` reports 0.3.0 on the 0.4.0 package
Hardcoded in [cli.ts:141](../src/cli.ts) and [mcp.ts:100](../src/mcp.ts).
Read the version from package.json at build/runtime so it can't drift again.

### 3. Claiming a nonexistent symbol succeeds silently
`quilt claim 'utils.js#formatPirce'` (typo) → "✓ claimed". The agent believes
it's protected; the real function is not. Error (or warn) when the symbol
isn't found in the file, ideally suggesting near matches.

### 4. First-ever `quilt status` is noise about Quilt's own files
Right after `quilt setup`, status lists `.mcp.json`, `CLAUDE.md`,
`.claude/settings.json` as `Unclaimed … pre-existing / generated?`. The tool's
first impression is flagging its own artifacts as anomalies. Setup should
self-attribute its writes (e.g. actor `quilt-setup`) or mark them observed.

## P2 — the identity story is told three different ways

### 5. Conflicting guidance: `quilt start` vs `QUILT_ACTOR` vs auto-ids
- `quilt status` → "Actor: (none — run quilt start)"
- `quilt doctor` → "auto ids per session … fine for most use"
- README → `QUILT_ACTOR=auth-agent claude`
- bare `quilt start` → `error: required option '--actor <id>' not specified`
  (curt commander error, no example)

Pick one canonical story (auto-ids, `QUILT_ACTOR` to pin) and make status /
whoami / start all echo it. Consider retiring `quilt start` from user-facing
copy entirely.

### 6. Setup epilogue points at `docs/orchestrators.md`
That file exists in the Quilt source repo, not in the user's repo. Use the
full GitHub URL.

### 7. Fleet shows stale actor state after commit
alice edited and landed `commit --mine`, fleet still says
"● alice (agent) reserved, not yet edited". Either release/refresh claim
state on commit or phrase it truthfully ("claim open, work committed").

## P3 — polish

### 8. Deny message is file-level for a symbol-level hold
"utils.js is held by alice" — but only `utils.js#formatPrice` is. Name the
symbol; bob holds a different symbol in the same file.

### 9. Hooks/MCP hardcode the `quilt` command
Non-global installs (npx, local devDependency) make hooks fail silently open;
`doctor`'s "0 edits captured" catches it only after the fact. Setup could
verify `quilt` resolves on PATH (warn if not) or write the resolved absolute
path into the config.

### 10. "pre-existing / generated?" label
Reads as a question the tool is asking itself. Say what it means:
"not captured — made outside an agent session".

### 11. Setup doesn't say whether to commit the generated files
A new user doesn't know if `.mcp.json` / `CLAUDE.md` / `.claude/settings.json`
should be checked in (they should, to share the wiring). One line in the
epilogue fixes it.

## What already feels good (keep)

- `quilt doctor` — clear checks, right verdict, actionable arrows.
- Deny-with-intent ("alice is: add currency arg") — best-in-class moment.
- `undo <actor>` — backed out exactly one actor's lines, said so plainly.
- escalate → "Needs you" in fleet → resolve: the whole loop reads well.
- Outside-a-repo error is crisp; `.quilt/` self-gitignores (nice touch).
