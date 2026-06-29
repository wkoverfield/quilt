/**
 * The graded scenario ladder. Each rung escalates the coordination difficulty.
 * L1–L3 are implemented as deterministic scripted scenarios; L4–L6 are
 * documented here as the roadmap and are exercised today via the live
 * sub-agent layer (see bench/README.md) until scripted versions land.
 */
import type { Scenario } from "./harness.js";

const A = { id: "A", type: "agent" as const };
const B = { id: "B", type: "agent" as const };
const C = { id: "C", type: "agent" as const };
const D = { id: "D", type: "agent" as const };

/** L1 — disjoint at scale: N agents, different symbols, one file. */
const L1: Scenario = {
  id: "L1",
  title: "Disjoint at scale",
  description:
    "Four agents each edit a different function in one shared file. The work " +
    "never truly conflicts, so the only question is whether each agent's change " +
    "is committed and attributed to it — or absorbed into one entangled commit.",
  actors: [A, B, C, D],
  files: {
    "utils.js":
      "function foo() {\n  return 1;\n}\n\n" +
      "function bar() {\n  return 2;\n}\n\n" +
      "function baz() {\n  return 3;\n}\n\n" +
      "function qux() {\n  return 4;\n}\n",
  },
  edits: [
    { actor: "A", file: "utils.js", claim: "utils.js#foo", anchor: "return 1;", replacement: "return 101;", marker: "return 101;", desc: "foo -> 101" },
    { actor: "B", file: "utils.js", claim: "utils.js#bar", anchor: "return 2;", replacement: "return 102;", marker: "return 102;", desc: "bar -> 102" },
    { actor: "C", file: "utils.js", claim: "utils.js#baz", anchor: "return 3;", replacement: "return 103;", marker: "return 103;", desc: "baz -> 103" },
    { actor: "D", file: "utils.js", claim: "utils.js#qux", anchor: "return 4;", replacement: "return 104;", marker: "return 104;", desc: "qux -> 104" },
  ],
};

/** L2 — incompatible conflict: two agents want the same line to be two things. */
const L2: Scenario = {
  id: "L2",
  title: "Incompatible conflict",
  description:
    "Two agents change the SAME line to different, mutually exclusive values. " +
    "There is no merge that keeps both. The question is whether one agent's work " +
    "is silently overwritten, or the collision is surfaced for a human to decide.",
  actors: [A, B],
  redoDeferred: false, // auto-redo would clobber the winner; a human must choose.
  files: {
    "pricing.js": "export function rate() {\n  return RATE;\n}\n",
  },
  edits: [
    { actor: "A", file: "pricing.js", claim: "pricing.js#rate", anchor: "return RATE;", replacement: "return 0.05;", marker: "return 0.05;", desc: "rate -> 0.05" },
    { actor: "B", file: "pricing.js", claim: "pricing.js#rate", anchor: "return RATE;", replacement: "return 0.07;", marker: "return 0.07;", desc: "rate -> 0.07" },
  ],
};

/** L3 — cascade: one agent changes a signature others depend on. */
const L3: Scenario = {
  id: "L3",
  title: "Dependency cascade",
  description:
    "Agent A changes the signature of api() to require a second argument while " +
    "agent B edits a call site. Without visibility into A's in-flight change, B " +
    "writes a call against the OLD signature and the codebase ends up broken. " +
    "With Quilt, B sees A's claim on api() and adapts the call.",
  actors: [A, B],
  files: {
    "api.js": "export function api(x) {\n  return x;\n}\n",
    "main.js": 'import { api } from "./api.js";\nconst result = api(2);\n',
  },
  edits: [
    {
      actor: "A",
      file: "api.js",
      claim: "api.js#api",
      anchor: "function api(x)",
      replacement: "function api(x, y)",
      marker: "function api(x, y)",
      desc: "api gains a required 2nd arg",
    },
    {
      actor: "B",
      file: "main.js",
      claim: "main.js",
      anchor: "api(2)",
      replacement: "api(5)", // naive: old 1-arg call -> broken under new signature
      adaptedReplacement: "api(5, 0)", // adapted: B saw A claim api.js and added the arg
      adaptsToClaimBy: "A",
      adaptsToClaimOnFile: "api.js",
      // The marker proves B's edit is PRESENT (it lands in both modes — B always
      // edits the call site). It deliberately does not encode correctness: that
      // is `broken`'s job below. So L3's discriminator is `broken` (WITHOUT) vs
      // not-broken (WITH), while features-landed/silent-loss stay honest (B's
      // work is never lost in either mode — WITHOUT it lands *wrong*, not gone).
      marker: "api(5",
      desc: "update the api() call site",
    },
  ],
  brokenIfFinalContains: ["api(5);"], // a 1-arg call against the new 2-arg signature
};

export const scenarios: Scenario[] = [L1, L2, L3];

/** L4–L6: documented rungs, exercised live until scripted versions land. */
export const plannedScenarios: Array<{ id: string; title: string; description: string }> = [
  {
    id: "L4",
    title: "Refactor underfoot",
    description:
      "One agent restructures a module (renames/moves symbols) while another " +
      "edits the old layout. Tests whether Quilt's symbol-level view keeps the " +
      "two from silently undoing each other mid-refactor.",
  },
  {
    id: "L5",
    title: "Emergent overlap",
    description:
      "Agents start on separate tasks but drift into the same region as the work " +
      "expands. Tests whether overlap is caught when it emerges, not just when " +
      "declared up front.",
  },
  {
    id: "L6",
    title: "Mixed actors + noise",
    description:
      "Humans and agents working together, plus unrelated churn (formatting, " +
      "dependency bumps). Tests attribution and conflict detection against a " +
      "realistic, noisy stream of edits.",
  },
];
