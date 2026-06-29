/**
 * Eval-harness entry point.
 *
 *   npm run bench            # run the whole ladder, print the comparison
 *   npm run bench -- L2      # run one rung
 *
 * Exits non-zero if any WITH-Quilt run regresses (silent loss, misattribution,
 * or a broken final state), so this doubles as a CI guard.
 */
import { runScenario, type ScenarioResult, type Metrics } from "./harness.js";
import { scenarios, plannedScenarios } from "./scenarios.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function fmt(without: string, withq: string): string {
  return `${pad(without, 22)}${withq}`;
}

// A cell colored green when it equals the "good" outcome, red otherwise.
function boolCell(value: boolean, good: boolean): string {
  const color = value === good ? GREEN : RED;
  return `${color}${value ? "yes" : "no"}${RESET}`;
}
function numCell(n: number, good: boolean): string {
  return `${good ? GREEN : RED}${n}${RESET}`;
}
/** colored content + padding, so ANSI codes don't throw off column width. */
function cell(content: string, plainLen: number, width = 22): string {
  return content + " ".repeat(Math.max(1, width - plainLen));
}

function metricLines(w: Metrics, q: Metrics): string[] {
  const row = (label: string, wc: string, wl: number, qc: string) =>
    `  ${pad(label, 22)}${cell(wc, wl)}${qc}`;
  return [
    row("features landed", `${w.featuresLanded}/${w.totalFeatures}`, `${w.featuresLanded}/${w.totalFeatures}`.length, `${q.featuresLanded}/${q.totalFeatures}`),
    row("silent loss", numCell(w.silentLoss, w.silentLoss === 0), `${w.silentLoss}`.length, numCell(q.silentLoss, q.silentLoss === 0)),
    row("attribution correct", boolCell(w.attributionCorrect, true), `${w.attributionCorrect ? "yes" : "no"}`.length, boolCell(q.attributionCorrect, true)),
    row("misattributed", numCell(w.misattributed, w.misattributed === 0), `${w.misattributed}`.length, numCell(q.misattributed, q.misattributed === 0)),
    row("broken final state", boolCell(w.broken, false), `${w.broken ? "yes" : "no"}`.length, boolCell(q.broken, false)),
    row("surfaced conflicts", `${DIM}${w.surfacedConflicts}${RESET}`, `${w.surfacedConflicts}`.length, `${YELLOW}${q.surfacedConflicts}${RESET}`),
    row("wasted/redone work", `${w.wastedWork}`, `${w.wastedWork}`.length, `${q.wastedWork}`),
    row("wall clock (ms)", w.wallClockMs.toFixed(0), w.wallClockMs.toFixed(0).length, q.wallClockMs.toFixed(0)),
  ];
}

/** A WITH-Quilt run regresses if it loses work, misattributes, or breaks. */
function regressed(m: Metrics): string[] {
  const fails: string[] = [];
  if (m.silentLoss > 0) fails.push(`silent loss = ${m.silentLoss}`);
  if (!m.attributionCorrect) fails.push(`misattributed = ${m.misattributed}`);
  if (m.broken) fails.push("broken final state");
  return fails;
}

function printResult(r: ScenarioResult): boolean {
  const { scenario: s, without: w, with: q } = r;
  console.log(`\n${BOLD}${s.id} — ${s.title}${RESET}`);
  console.log(`${DIM}${s.description}${RESET}`);
  console.log(`\n  ${pad("", 22)}${pad("WITHOUT quilt", 22)}WITH quilt`);
  for (const line of metricLines(w.metrics, q.metrics)) console.log(line);

  const fails = regressed(q.metrics);
  if (fails.length) {
    console.log(`  ${RED}✗ WITH-quilt regressed: ${fails.join(", ")}${RESET}`);
    return false;
  }
  console.log(`  ${GREEN}✓ WITH-quilt clean${RESET}`);
  return true;
}

function main(): void {
  const filter = process.argv[2]?.toUpperCase();
  const selected = filter ? scenarios.filter((s) => s.id === filter) : scenarios;
  if (filter && selected.length === 0) {
    console.error(`No scripted scenario "${filter}". Available: ${scenarios.map((s) => s.id).join(", ")}`);
    process.exit(2);
  }

  console.log(`${BOLD}Quilt eval harness${RESET} ${DIM}— scripted ladder, WITHOUT vs WITH Quilt${RESET}`);
  let allClean = true;
  for (const s of selected) {
    const result = runScenario(s);
    if (!printResult(result)) allClean = false;
  }

  if (!filter) {
    console.log(`\n${BOLD}Planned rungs${RESET} ${DIM}(live sub-agent layer today — see bench/README.md)${RESET}`);
    for (const p of plannedScenarios) {
      console.log(`  ${DIM}${p.id} — ${p.title}: ${p.description.split(".")[0]}.${RESET}`);
    }
  }

  console.log("");
  process.exit(allClean ? 0 : 1);
}

main();
