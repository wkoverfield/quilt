# Authorship-capture eval — first run (2026-06-30)

Prototype **A (Labeled-Write Ledger)** vs **C (status quo)** on the three
scenarios that expose the core problem. Run: `node bench/authorship/eval.mjs`.
Both score against a known ground-truth authorship map; only genuinely-changed,
non-trivial lines are scored.

| scenario | A correct | C correct | C misattributed |
|---|---|---|---|
| silent concurrent edits, different functions, same file | 2/2 | 1/2 | 1 |
| identical line added in two different places | 2/2 | 1/2 | 1 |
| rapid interleave, neither reconciles until the end | 3/3 | 1/3 | 2 |
| **total** | **7/7 (100%)** | **3/7 (43%)** | **4** |

## What it shows

On exactly the cases that break the current model, **capture-at-edit (A)
reconstructs authorship perfectly while the status quo (C) misattributes most of
it** — a silent edit gets swept to whoever reconciles first, and two identical
lines collapse to one owner. A's positional replay handles the duplicate-line
case the content-keyed model can't.

## What it does NOT show (honest caveats)

- **A's 100% is "by construction of capturing the payload."** It proves the
  mechanism is *sufficient* — if every edit's old→new payload is recorded, you
  recover authorship exactly, and the positional replay is sound — but it does
  **not** prove **coverage**: that real agents' edits actually get captured (vs
  raw `bash`/`sed` writes that bypass the tool). Coverage is the separate
  existential question (rough transcript probe: high for Claude coding agents,
  which used the `Edit` tool ~exclusively; a clean instrumented number is owed).
- **C's 43% is its rate on *adversarial* scenarios**, not its real-world average.
  Disjoint, well-timed edits attribute fine under C. The point is that these
  failure modes are real and A eliminates them.

## Next

- Add the remaining scenarios: clobber, true-collision *prevention* (deny-before-
  write via preHash + claims), two sub-agents in one process (per-call actor),
  and the `bash`-write floor (must degrade to `unknown` + surfaced, never lost).
- Prototype **bet B** (per-actor patch captured at the *run* boundary, no FUSE)
  and add it to the table — it's the rival that covers the `bash` hole.
- Instrument a real multi-agent run for a clean **coverage** number.
