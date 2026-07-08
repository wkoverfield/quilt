# Codex apply_patch payload samples (spike, 2026-07-08)

Ground truth captured from live codex-cli 0.142.5 sessions (`codex exec`,
workspace-write sandbox) during the 0.4.4 Codex-capture spike. Provenance
matters: these are the `custom_tool_call` records from the session rollout
files (`~/.codex/sessions/.../rollout-*.jsonl`), which record the exact
`apply_patch` input verbatim.

What these samples are NOT: the hook stdin envelope. Codex persists per-hook
trust in `~/.codex/config.toml` (`[hooks.state."<file>:<event>:<group>:<index>"]`
with a `trusted_hash`), and a newly wired hook is silently skipped in headless
runs until the user trusts it in an interactive session (or passes
`--dangerously-bypass-hook-trust`). The envelope capture needs one interactive
trust approval; see the spike notes in the 0.4.4 PR.

Files:

- `single-file-update.json` — one Update File section, exact-context hunk.
- `multi-file-success.json` — Update x2 + Add File in one patch, space-prefixed
  context lines, plus the success output listing every file it touched.
- `multi-file-failed.json` — the same patch attempted with sloppy context
  (missing indentation); apply_patch REJECTED it ("verification failed") and
  no file changed. A Post-capture must gate on the tool outcome before
  attributing anything.

Format observations for the parser (verified against these samples):

- The blob is OpenAI's apply_patch envelope: `*** Begin Patch` ...
  `*** End Patch`, with per-file sections `*** Update File: <path>`,
  `*** Add File: <path>`, `*** Delete File: <path>` (and `*** Move to:
  <path>` after an Update section for renames).
- Hunks under an Update section are `@@`-separated with ` ` (context), `-`,
  `+` prefixed lines, like unified diff bodies without line numbers.
- Extracting the FILE LIST is a line-anchored scan for the `*** ... File:`
  markers; Quilt's capture core (snapshot on Pre, diff snapshot vs disk on
  Post, per file) never needs to interpret the hunks themselves.
- On success the tool output lists the files it changed (`A z.js`, `M x.js`);
  on failure it says `apply_patch verification failed` and touches nothing.
