# Live run — <rung> — <date>

- **Rung:** L_ (<title>)
- **Agents:** N general-purpose agents (<model>)
- **Seed repo:** <one-line description of the seed codebase>
- **Tasks:** see `../tasks/<rung>.md`

## Metrics

| Metric | WITHOUT Quilt | WITH Quilt |
|--------|---------------|------------|
| features landed | | |
| silent loss | | |
| attribution correct | | |
| misattributed | | |
| broken final state | | |
| surfaced conflicts | | |
| wasted/redone work | | |
| wall clock | | |
| **resolution quality** (judge) | | |

## Judge verdict

> Paste the judge model's verdict: which condition produced correct, coherent,
> well-attributed work, and where coordination changed the outcome.

## Notable transcript moments

- WITHOUT: <e.g. agent B's commit absorbed A's work; clobber went unnoticed>
- WITH: <e.g. agent B saw A's claim on `api` via get_conflicts and adapted>

## Takeaway

<One paragraph: did real agents honor the cooperative contract the scripted
layer assumes? Any surprises that should change the scripted scenarios or the
product?>
