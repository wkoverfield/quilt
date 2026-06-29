/**
 * The graded scenario ladder. Each rung escalates the coordination difficulty.
 * L1–L6 are all implemented as deterministic scripted scenarios. The live
 * sub-agent layer (see bench/README.md) adds breadth on top of the same ladder.
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

const H = { id: "H", type: "human" as const };

/** L4 — refactor underfoot: a refactor bulldozes a concurrent edit to the same symbol. */
const L4: Scenario = {
  id: "L4",
  title: "Refactor underfoot",
  description:
    "Agent A restructures parse() while agent B edits a line inside it. The " +
    "refactor rewrites the very line B is changing, so without coordination B's " +
    "edit is bulldozed and vanishes. With Quilt, B's symbol claim collides with " +
    "A's and the conflict is surfaced rather than silently lost.",
  actors: [A, B],
  redoDeferred: false, // B's edit may not even make sense post-refactor — human decides.
  files: {
    "utils.js":
      "function parse(input) {\n  const raw = input.trim();\n  return raw.length;\n}\n",
  },
  edits: [
    // A's refactor lands first and rewrites both lines of the body.
    { actor: "A", file: "utils.js", claim: "utils.js#parse", anchor: "const raw = input.trim();", replacement: "const raw = String(input).trim();", marker: "String(input)", desc: "harden input coercion" },
    { actor: "A", file: "utils.js", claim: "utils.js#parse", anchor: "return raw.length;", replacement: "return raw.length * 2;", marker: "length * 2;", desc: "double the result" },
    // B targets the original return line — gone after the refactor (bulldozed).
    { actor: "B", file: "utils.js", claim: "utils.js#parse", anchor: "return raw.length;", replacement: "return raw.length + 10;", marker: "length + 10;", desc: "offset the result" },
  ],
};

/** L5 — emergent overlap: agents start disjoint, then one drifts into the other's symbol. */
const L5: Scenario = {
  id: "L5",
  title: "Emergent overlap",
  description:
    "A and B start on different functions, but B's task expands until it also " +
    "edits A's function. The overlap was not declared up front — it emerged. " +
    "Without coordination B's drift overwrites A's in-flight change; with Quilt, " +
    "B's late claim on A's symbol is denied and the overlap is caught when it appears.",
  actors: [A, B],
  redoDeferred: false,
  files: {
    "utils.js":
      "function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}\n",
  },
  edits: [
    { actor: "A", file: "utils.js", claim: "utils.js#alpha", anchor: "return 1;", replacement: "return 100;", marker: "return 100;", desc: "alpha -> 100" },
    { actor: "B", file: "utils.js", claim: "utils.js#beta", anchor: "return 2;", replacement: "return 200;", marker: "return 200;", desc: "beta -> 200" },
    // B's work expands into alpha — A already changed it to `return 100;`.
    { actor: "B", file: "utils.js", claim: "utils.js#alpha", anchor: "return 100;", replacement: "return 100 + 5;", marker: "100 + 5;", desc: "(emergent) also tweak alpha" },
  ],
};

/** L6 — mixed actors + noise: human + agents + multi-file churn; does attribution hold? */
const L6: Scenario = {
  id: "L6",
  title: "Mixed actors + noise",
  description:
    "A human and two agents each touch a different file in one shared tree — a " +
    "feature change, a util tweak, and a config bump. No edit conflicts, so the " +
    "only question is whether each lands under its true author once there are " +
    "multiple actors and unrelated churn, or whether the first committer absorbs " +
    "all of it.",
  actors: [A, B, H],
  files: {
    "app.js": "function feature() {\n  return 0;\n}\n",
    "utils.js": "function helper() {\n  return 1;\n}\n",
    "config.json": '{\n  "version": "1.0.0"\n}\n',
  },
  edits: [
    { actor: "A", file: "app.js", claim: "app.js#feature", anchor: "return 0;", replacement: "return 42;", marker: "return 42;", desc: "feature -> 42" },
    { actor: "B", file: "utils.js", claim: "utils.js#helper", anchor: "return 1;", replacement: "return 7;", marker: "return 7;", desc: "helper -> 7" },
    { actor: "H", file: "config.json", claim: "config.json", anchor: '"version": "1.0.0"', replacement: '"version": "2.0.0"', marker: "2.0.0", desc: "bump version" },
  ],
};

export const scenarios: Scenario[] = [L1, L2, L3, L4, L5, L6];

/** All ladder rungs are scripted; the live sub-agent layer (bench/README.md) adds breadth. */
export const plannedScenarios: Array<{ id: string; title: string; description: string }> = [];
