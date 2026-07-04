# Running a fleet: Quilt with Claude Code subagents (and other orchestrators)

When you fan out several agents (Claude Code subagents, Codex, Cursor, Aider),
they work in one checkout. Quilt keeps them coordinated: each agent claims the
code it's about to change, sees the others' in-flight work, and commits only its
own, so the history stays clean and correctly attributed instead of one agent's
commit swallowing everyone else's work.

The whole integration is: **one shared Quilt MCP server, and each agent names
itself on every call.**

## Quick start: `quilt setup`

In an agent repo, one command wires everything below up for you:

```sh
quilt setup          # initializes Quilt, adds the MCP server, drops the snippet
quilt setup --dry-run  # preview the changes first
```

It detects your orchestrator (Claude Code, Cursor, …), adds the `quilt` server to
`.mcp.json` (merging, never clobbering), appends the coordination snippet to
`CLAUDE.md`, and installs the capture hooks into `.claude/settings.json`. It's
idempotent, safe to re-run. The manual steps below are what it does, if you'd
rather wire it by hand.

## Two ways to capture: hooks and MCP

Quilt captures who wrote which lines through either path, and you can use both:

- **Hooks (zero protocol).** On Claude Code, `quilt setup` installs a
  `PreToolUse`/`PostToolUse` hook pair on the native `Edit`, `Write`, and
  `MultiEdit` tools. Agents edit the way they already do, no new tools, no
  instructions to follow, and Quilt records the author of each change and denies
  a write into code another agent is mid-change on. Identity is automatic: each
  session gets its own id (see below). This is the seamless path.
- **MCP (explicit).** The `quilt_edit` / `quilt_write` tools, and the
  `claim` → `commit_mine` loop below, work anywhere an agent can reach an MCP
  server, Codex, Cursor, Aider, your own harness, including runtimes that have
  no hook system. Reach for this when hooks aren't available.

### How agents get their ids

Identity is automatic by default, with an explicit override:

- **Hooks:** every Claude Code session already carries a session id in the hook
  payload, so an unnamed session is captured as `claude-<8 chars of its session
  id>`. Parallel sessions get distinct ids for free. **Subagents** (Task tool)
  share their parent's session id but carry their own `agent_id`/`agent_type`
  in the payload, so each is captured under its own id, e.g.
  `code-reviewer-f7e8d9c0` — parallel subagents of one session never merge.
- **MCP:** an unnamed tool call gets a per-connection id derived from the
  client's handshake name, e.g. `cursor-3fa2` or `codex-91bc`. Stdio servers are
  spawned per client process, so the id is stable for that agent's whole run.
- **Explicit (`QUILT_ACTOR`, or per-call `actor`):** always wins. Set it when you
  want an id that persists across sessions, so tomorrow's session can
  `commit --mine` yesterday's uncommitted lines:

```sh
QUILT_ACTOR=auth-agent claude   # this agent's native edits are captured as "auth-agent"
```

The trade-off with auto ids is continuity: a new session on the same task is a
new actor, so uncommitted work from an ended session belongs to the old id
(visible in `quilt fleet`, committable or revertable by naming that id). Agents
that commit before they finish never notice.

The one topology auto-naming can't split is **several agents sharing one MCP
connection with no per-call ids**: a shared connection has one ambient
identity. For that, each agent passes its own `actor` on each `quilt_edit` /
`claim` call, so one shared `quilt mcp` server attributes them all correctly.

**Claim adoption** ties the two identity worlds together. When an edit arrives
under an *auto-derived* id (a session/agent/connection name nobody chose) and
the code it touches is claimed by exactly one actor, the edit is attributed to
that claim's holder — so an agent that claims as `ui-agent` over MCP and then
edits with the native Edit tool is captured as `ui-agent`, not as a derived id,
and is never denied by its own claim. An *explicit* identity is never adopted:
a named actor editing someone else's claim is a real collision and is denied
with the holder's intent. Captured edits also refresh the holder's claim TTL,
so a long work session can't silently outlive its reservation.

The honest edge of adoption: a *different* anonymous agent (say, another
session's auto id) that edits into a claim without claiming first is also
credited to the holder rather than denied — under a derived id there is no way
to tell "the holder's own hands" from "an anonymous trespasser", and the claim
is the strongest signal available. Agents that follow the protocol (claim
before editing) never hit this: their own claim attempt is denied first, with
the holder's intent, at the coordination point. Give agents explicit ids
(`QUILT_ACTOR`, per-call `actor`) when you want strict denial semantics
between them.

The hooks also need Quilt initialized in the repo (`quilt setup` does this, or run
`quilt init` once). If the store isn't initialized, the hooks no-op silently
rather than error, so if native edits aren't being captured, check that
`.quilt/` exists (`quilt doctor` reports this).

## 1. Add the shared server

One `quilt mcp` process serves the whole fleet. Don't pin it to an identity
(no `QUILT_ACTOR`), so each agent can act as itself per call.

```jsonc
// .mcp.json (or your agent's MCP config)
{
  "mcpServers": {
    "quilt": { "command": "quilt", "args": ["mcp"] }
  }
}
```

Run `quilt init` once in the repo first.

## 2. Tell your agents to coordinate

Drop this into `CLAUDE.md` (or each subagent's instructions). The only rule that
matters: **pick a stable id for yourself and pass it as `actor` on every Quilt
call.**

```md
You share this checkout with other agents. Coordinate through Quilt:

- Identity is automatic: if you don't name yourself, Quilt derives an id from
  your session/connection. But if you are one of SEVERAL subagents sharing one
  process or MCP connection, pick a stable id, your role or task name (e.g.
  `auth-agent`), and pass it as `actor` on every Quilt call, since a shared
  connection can't tell you apart automatically.
- Before you edit a file, `claim` what you're about to change
  (`path#symbol`, e.g. `src/auth.ts#login`), and pass a short `intent`, the why
  (your ticket/task). It's shown to anyone you block, so they can reconcile.
- If your claim is denied, another agent holds that code and is mid-change. The
  response carries their `holderIntent`. Use it instead of forcing your change
  through: if they're already doing your change, drop yours; if it's compatible,
  adapt; if your goals are genuinely opposed, do NOT overwrite, `escalate` the
  target (with a `reason` naming both intents) and a human decides.
- When you reconcile a clash yourself, `resolve` the target with a `note` so the
  decision is recorded.
- The claim response may also include `dependencyWarnings`: a function you depend
  on is being changed by another agent. Account for it.
- When your change is ready, `commit_mine` with your id. It commits only your
  lines and leaves everyone else's work untouched.
```

`quilt setup` writes this block for you.

## 3. The loop

```txt
claim(actor: "auth-agent", paths: ["src/auth.ts#login"])
  → …edit src/auth.ts…
commit_mine(actor: "auth-agent", message: "fix login redirect")
```

Each agent runs this independently against the same server. No `start_session`
needed, an id is registered the first time it's used.

## When two agents collide

Most collisions are a context gap, not a real conflict, one agent just didn't
know what the other was doing. The `intent` on a claim closes that gap: when a
claim is denied, the blocked agent gets the holder's `holderIntent` and resolves
it itself:

```txt
claim(actor: "safety", paths: ["pool.js#maxConnections"], intent: "SAFETY-87: cap to protect DB")
  → denied: held by "perf"  ·  holderIntent: "PERF-412: raise for peak load"
  → opposed intents on the same line → escalate(target: "pool.js#maxConnections",
       reason: "PERF-412 wants it higher, SAFETY-87 lower")
```

The genuine conflicts surface to a human (`quilt fleet` → **Needs you**); the
rest the agents sew themselves and record with `resolve` (**Sewn by agents**). So
your loops keep running and you only weigh in on the calls that are actually
yours to make. Quilt never resolves anything itself, it hands your agents the
context and records what they decided.

## Why it works

One shared server with **per-call actor** means there's no single "active" agent
for the others to clobber: every claim and commit is attributed to the id that
made it. A fleet of subagents ends up with one clean, correctly-authored commit
each, in a single checkout, no worktree per agent, no merge pile-up.

This is verified in the test suite: a 4-subagent fleet through one server keeps
every agent's attribution, where the un-named (shared-actor) path collapses the
whole fleet into a single author. See the orchestration eval in
`test/mcp.test.ts`.

## Other orchestrators

The same pattern works anywhere agents can reach an MCP server and you can give
them instructions: Codex, Cursor, Aider, or your own harness. Point them all at
one `quilt mcp` server and have each pass its own `actor`. An agent that skips
Quilt entirely gets no coordination, Quilt coordinates the agents that
participate, the same way Git does.
