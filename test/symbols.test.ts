import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initSymbols, parseSymbols, symbolReferences } from "../src/symbols.js";

// parseSymbols is synchronous but depends on the tree-sitter grammars being
// loaded; the CLI does this once at startup. Mirror that here.
before(async () => {
  await initSymbols();
});

/** Find a symbol by name, asserting it exists. */
function sym(path: string, content: string, name: string) {
  const found = parseSymbols(path, content).find((s) => s.name === name);
  assert.ok(found, `expected a symbol named ${name}`);
  return found;
}

test("function and class declarations get exact 1-based inclusive line ranges", () => {
  const src = "function foo() {\n  return 1;\n}\n\nclass Bar {\n  m() {}\n}\n";
  const foo = sym("a.js", src, "foo");
  assert.equal(foo.kind, "function");
  assert.deepEqual([foo.startLine, foo.endLine], [1, 3]);
  const bar = sym("a.js", src, "Bar");
  assert.equal(bar.kind, "class");
  assert.deepEqual([bar.startLine, bar.endLine], [5, 7]);
});

test("const/let/var declarations are reported as values", () => {
  const src = "const x = 1;\nlet y = 2;\nvar z = 3;\n";
  const syms = parseSymbols("a.js", src);
  assert.deepEqual(
    syms.map((s) => [s.name, s.kind, s.startLine, s.endLine]),
    [
      ["x", "value", 1, 1],
      ["y", "value", 2, 2],
      ["z", "value", 3, 3],
    ],
  );
});

test("multi-line arrow body extends the range to the closing brace", () => {
  const src = "const add = (a, b) => {\n  const s = a + b;\n  return s;\n};\n";
  const add = sym("a.js", src, "add");
  assert.deepEqual([add.startLine, add.endLine], [1, 4]);
});

test("export and export default prefixes are unwrapped, range covers the export keyword", () => {
  const src = "export function foo() {\n  return 1;\n}\n\nexport default class Baz {\n  m() {}\n}\n";
  const foo = sym("a.ts", src, "foo");
  assert.deepEqual([foo.startLine, foo.endLine], [1, 3]);
  const baz = sym("a.ts", src, "Baz");
  assert.equal(baz.kind, "class");
  assert.deepEqual([baz.startLine, baz.endLine], [5, 7]);
});

test("multiple declarators in one statement each become a symbol", () => {
  const syms = parseSymbols("a.js", "const a = 1, b = 2;\n");
  assert.deepEqual(syms.map((s) => s.name).sort(), ["a", "b"]);
});

test("TypeScript interfaces, enums, and type aliases are surfaced", () => {
  const src = "interface Foo {\n  a: number;\n}\nenum Color { Red, Green }\ntype Id = string;\n";
  assert.equal(sym("a.ts", src, "Foo").kind, "class");
  assert.equal(sym("a.ts", src, "Color").kind, "class");
  assert.equal(sym("a.ts", src, "Id").kind, "value");
});

test("tsx files parse JSX-bearing components", () => {
  const src = "export function App() {\n  return <div>hi</div>;\n}\n";
  const app = sym("App.tsx", src, "App");
  assert.deepEqual([app.startLine, app.endLine], [1, 3]);
});

test("unsupported extensions and unparseable input return []", () => {
  assert.deepEqual(parseSymbols("notes.md", "# hi\nfunction x() {}\n"), []);
  // Garbage still parses (tree-sitter is error-tolerant) but yields no top-level
  // declarations; the contract is just "never throw".
  assert.doesNotThrow(() => parseSymbols("a.js", "}{)(;;function"));
});

test("braces inside strings do not corrupt ranges (heuristic-killer case)", () => {
  const src = "function f() {\n  const s = '}';\n  return s;\n}\nconst after = 1;\n";
  const f = sym("a.js", src, "f");
  assert.deepEqual([f.startLine, f.endLine], [1, 4]);
  const after = sym("a.js", src, "after");
  assert.deepEqual([after.startLine, after.endLine], [5, 5]);
});

// --- Python / Go / Rust: symbol claims work off the JS family ---

test("Python: functions, classes, and decorated defs", () => {
  const src = "def foo(x):\n    return x\n\nclass Bar:\n    def m(self):\n        return 1\n\n@deco\ndef baz():\n    pass\n";
  assert.equal(sym("m.py", src, "foo").kind, "function");
  assert.equal(sym("m.py", src, "Bar").kind, "class");
  const baz = sym("m.py", src, "baz");
  assert.equal(baz.kind, "function");
  assert.deepEqual([baz.startLine, baz.endLine], [8, 10], "decorated def range includes the decorator");
});

test("Go: functions, methods, structs, and interfaces", () => {
  const src =
    "package main\n\nfunc Foo(x int) int {\n\treturn x\n}\n\ntype Point struct {\n\tX int\n}\n\ntype Greeter interface {\n\tGreet() string\n}\n\nfunc (p Point) M() int { return 1 }\n";
  assert.equal(sym("m.go", src, "Foo").kind, "function");
  assert.equal(sym("m.go", src, "M").kind, "function"); // method
  assert.equal(sym("m.go", src, "Point").kind, "class"); // struct
  assert.equal(sym("m.go", src, "Greeter").kind, "class"); // interface
});

test("Rust: functions, structs, enums, and traits", () => {
  const src = "pub fn foo(x: i32) -> i32 {\n    x\n}\n\nstruct Point {\n    x: i32,\n}\n\nenum Color { Red }\n\ntrait Greet {\n    fn hi(&self);\n}\n";
  assert.equal(sym("m.rs", src, "foo").kind, "function");
  assert.equal(sym("m.rs", src, "Point").kind, "class"); // struct
  assert.equal(sym("m.rs", src, "Color").kind, "class"); // enum
  assert.equal(sym("m.rs", src, "Greet").kind, "class"); // trait
});

test("Python push-awareness: a function's call to another is captured cross-file", () => {
  // caller() calls helper() — symbolReferences records the dependency by name,
  // which is what lets push-awareness fire across Python files too.
  const refs = symbolReferences("main.py", "def caller():\n    return helper(1)\n");
  assert.deepEqual([...(refs.get("caller") ?? [])], ["helper"]);
});
