# Live run — a fleet that sews itself — 2026-06-30

- **What this tests:** the full **sew** — agents handling collisions on their own
  through Quilt's context (intent), and surfacing only the genuine conflicts to a
  human. The payoff the whole feature is for.
- **Agents:** 4 general-purpose coding agents (Claude), real edits, real
  decisions. They were given the coordination protocol (the one `quilt setup`
  writes) and their ticket — nothing about the expected outcome.
- **Seed repo:** `app.js` with `login(user)` and `maxConnections()`.

## The fleet

Four agents, two pairs that land on the same symbol for different reasons:

| Agent | Ticket | Target |
|---|---|---|
| `alpha` | AUTH-1: add input validation to `login()` | `app.js#login` |
| `beta` | AUTH-3: add input validation to `login()` (**duplicate** of AUTH-1) | `app.js#login` |
| `perf` | PERF-412: raise `maxConnections()` to 500 for peak load | `app.js#maxConnections` |
| `safety` | SAFETY-87: cap `maxConnections()` at 25 to protect the DB | `app.js#maxConnections` |

`alpha` and `perf` claim and edit first (in-flight, as fleet agents are between
coordination points). Then `beta` and `safety` arrive and hit the held symbols.

## Result: the fleet sewed itself; one real conflict reached the human

The final `quilt fleet`:

```
Quilt · fleet   4 actors, 1 needs-you, 0 clashes, 1 blocked

  Needs you  (agents couldn't reconcile these — your call)
    ⚑ app.js#maxConnections  Directly opposed intents on the same value. SAFETY-87
      needs 25 to protect the DB; PERF-412 raises it to 500 for peak load. 25 vs
      500. Needs a human (e.g. incident-aware throttling vs static ceiling).
      (raised by safety)

  Actors
    ● alpha   claims: app.js#login
    ○ beta    idle
    ● perf    claims: app.js#maxConnections
    ○ safety  idle
```

Ground truth: `login()` has alpha's validation, `maxConnections()` has perf's
`500`, **0 clashes**, nothing auto-committed, nothing overwritten. The engineer's
entire to-do list is **one item** — the genuine conflict.

## The context gap dissolved itself (beta)

`beta`'s AUTH-3 was a duplicate of alpha's AUTH-1. It claimed `login` and was
denied — but the denial carried *why*:

```
✗ denied  app.js#login (held by alpha)
    alpha is: AUTH-1: add input validation to login
```

From beta's own report:

> "The holderIntent Quilt surfaced — alpha's 'AUTH-1: add input validation to
> login' — is the same change my AUTH-3 ticket asks for. When the holder is
> already doing what my ticket asks, my work is redundant. I did not edit, did
> not duplicate, and did not escalate (goals aren't opposed — they're
> identical)."

No human touched this. The duplicate work simply didn't happen, because the
blocked agent could see what the holder was doing. That's the 80% case — most
collisions are a context gap, and the intent closes it.

## The genuine conflict escalated (safety)

`safety`'s SAFETY-87 (cap at 25) is directly opposed to perf's PERF-412 (raise to
500) — the same value can't be both. safety was denied, saw perf's intent, and
recognized this isn't reconcilable by an agent:

> "These are genuinely opposed — the same function must return one value, and
> 25 ≠ 500. Forcing my change through would silently clobber their work. Per
> protocol I escalated naming both intents and stopped."

It ran `quilt escalate` instead of overwriting. That put the one decision that's
actually a human's — a product call between a safety cap and a peak-load ceiling
— in front of the engineer, with both sides spelled out, and left perf's work
intact.

## What this proves

- **The fleet resolves what it can and escalates what it can't, on its own.** Two
  agents collided on `login` → the duplicate dissolved with no human. Two collided
  on `maxConnections` → the genuine conflict was raised, not clobbered. The
  engineer sees **one** item, not four.
- **The intelligence is the agents you already run.** Quilt called no LLM and
  spawned nothing. It captured each agent's intent, handed it to the one it
  blocked, and recorded the outcomes. The agents — Claude here, but any
  orchestrator's — did the reconciling.
- **Nothing was lost or silently decided.** alpha's and perf's work is intact, the
  duplicate never duplicated, the real conflict is on the human's list, and
  `quilt fleet` shows the whole picture. Parallel loops, one clean quilt.

(Companion to L1 disjoint, L2 same-line, and L3 cascade. Those showed Quilt
*catching* collisions; this shows the fleet *resolving* them and surfacing only
what a human must decide.)

---

*Orchestration note: the four agents were run one at a time so each claimed under
its own identity. Running two `quilt start` agents truly concurrently in one
shared shell races on the active-session pointer — the documented pattern for a
real fleet is the MCP server (per-call actor) or `QUILT_ACTOR` per shell, both of
which avoid that. The agents' resolution decisions were entirely their own.*
