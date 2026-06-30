# Running a fleet: Quilt with Claude Code subagents (and other orchestrators)

When you fan out several agents — Claude Code subagents, Codex, Cursor, Aider —
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
`.mcp.json` (merging, never clobbering), and appends the coordination snippet to
`CLAUDE.md`. It's idempotent — safe to re-run. The manual steps below are what it
does, if you'd rather wire it by hand.

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

- Pick a stable id for yourself — your role or task name (e.g. `auth-agent`).
  Use that exact id as `actor` on every Quilt call.
- Before you edit a file, `claim` what you're about to change
  (`path#symbol`, e.g. `src/auth.ts#login`), and pass a short `intent` — the why
  (your ticket/task). It's shown to anyone you block, so they can reconcile.
- If your claim is denied, another agent holds that code and is mid-change. The
  response carries their `holderIntent`. Use it instead of forcing your change
  through: if they're already doing your change, drop yours; if it's compatible,
  adapt; if your goals are genuinely opposed, do NOT overwrite — `escalate` the
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
needed — an id is registered the first time it's used.

## When two agents collide

Most collisions are a context gap, not a real conflict — one agent just didn't
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
yours to make. Quilt never resolves anything itself — it hands your agents the
context and records what they decided.

## Why it works

One shared server with **per-call actor** means there's no single "active" agent
for the others to clobber: every claim and commit is attributed to the id that
made it. A fleet of subagents ends up with one clean, correctly-authored commit
each, in a single checkout — no worktree per agent, no merge pile-up.

This is verified in the test suite: a 4-subagent fleet through one server keeps
every agent's attribution, where the un-named (shared-actor) path collapses the
whole fleet into a single author. See the orchestration eval in
`test/mcp.test.ts`.

## Other orchestrators

The same pattern works anywhere agents can reach an MCP server and you can give
them instructions: Codex, Cursor, Aider, or your own harness. Point them all at
one `quilt mcp` server and have each pass its own `actor`. An agent that skips
Quilt entirely gets no coordination — Quilt coordinates the agents that
participate, the same way Git does.
