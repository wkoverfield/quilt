import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

/** A named, line-ranged code symbol (function, class, etc.). */
export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "value";
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

const require = createRequire(import.meta.url);

type Grammar =
  | "javascript"
  | "typescript"
  | "tsx"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "ruby"
  | "c"
  | "cpp";
const isJsFamily = (g: Grammar): boolean =>
  g === "javascript" || g === "typescript" || g === "tsx";

// Extension -> grammar. tree-sitter-javascript also parses JSX; .tsx needs the
// dedicated tsx grammar (the plain typescript grammar rejects JSX).
const GRAMMAR_BY_EXT: Record<string, Grammar> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
};

/** Loaded parsers, one per grammar, populated by initSymbols(). */
const parsers = new Map<string, Parser>();
let initPromise: Promise<void> | null = null;
let ready = false;

function ext(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/**
 * One-time async initialization of the tree-sitter runtime and grammars.
 * Idempotent and best-effort: if anything fails (missing wasm, load error),
 * `ready` stays false and parseSymbols() degrades to [] so callers fall back to
 * whole-file claims rather than crashing. Call this once at process startup
 * before any command that may parse — it keeps parseSymbols() synchronous.
 */
export function initSymbols(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await Parser.init();
    const grammars = new Set(Object.values(GRAMMAR_BY_EXT));
    for (const g of grammars) {
      const wasm = require.resolve(`tree-sitter-wasms/out/tree-sitter-${g}.wasm`);
      const lang = await Parser.Language.load(wasm);
      const p = new Parser();
      p.setLanguage(lang);
      parsers.set(g, p);
    }
    ready = true;
  })().catch(() => {
    // Leave ready=false; parseSymbols() returns [] and Quilt falls back to
    // whole-file claims. Never let a parser problem break a quilt command.
    ready = false;
  });
  return initPromise;
}

/** Top-level node types we surface as symbols, with the kind we report. */
function symbolKind(nodeType: string): CodeSymbol["kind"] | null {
  switch (nodeType) {
    case "function_declaration":
    case "generator_function_declaration":
      return "function";
    case "class_declaration":
    case "abstract_class_declaration":
    case "interface_declaration":
    case "enum_declaration":
      return "class";
    case "type_alias_declaration":
      return "value";
    default:
      return null;
  }
}

/** 1-based inclusive line range of a node, including any leading `export`. */
function range(
  node: Parser.SyntaxNode,
  outer: Parser.SyntaxNode,
): { startLine: number; endLine: number } {
  return {
    startLine: outer.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function pushDeclarators(
  node: Parser.SyntaxNode,
  outer: Parser.SyntaxNode,
  out: CodeSymbol[],
): void {
  // `const a = 1, b = 2` -> one "value" symbol per declarator.
  for (const child of node.namedChildren) {
    if (child.type !== "variable_declarator") continue;
    const nameNode = child.childForFieldName("name");
    if (!nameNode) continue;
    out.push({
      name: nameNode.text,
      kind: "value",
      ...range(child, child === node.namedChildren[0] ? outer : child),
    });
  }
}

function collect(top: Parser.SyntaxNode, out: CodeSymbol[]): void {
  // Unwrap `export` / `export default` to the underlying declaration.
  let node = top;
  if (node.type === "export_statement") {
    const decl = node.namedChildren.find(
      (c) =>
        symbolKind(c.type) !== null ||
        c.type === "lexical_declaration" ||
        c.type === "variable_declaration",
    );
    if (!decl) return;
    node = decl;
  }

  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    pushDeclarators(node, top, out);
    return;
  }

  const kind = symbolKind(node.type);
  if (!kind) return;
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;
  out.push({ name: nameNode.text, kind, ...range(node, top) });
}

// Top-level declaration node types -> kind, for the non-JS grammars. Each grammar
// names a function/class/type its own way; these are the common, high-value ones.
const LANG_KINDS: Partial<Record<Grammar, Record<string, CodeSymbol["kind"]>>> = {
  python: { function_definition: "function", class_definition: "class" },
  go: { function_declaration: "function", method_declaration: "function" },
  rust: {
    function_item: "function",
    struct_item: "class",
    enum_item: "class",
    trait_item: "class",
  },
  java: {
    class_declaration: "class",
    interface_declaration: "class",
    enum_declaration: "class",
    record_declaration: "class",
    annotation_type_declaration: "class",
  },
  ruby: {
    method: "function",
    singleton_method: "function",
    class: "class",
    module: "class",
  },
  // C/C++ function_definition is handled specially (name lives in the declarator).
  c: { struct_specifier: "class", union_specifier: "class", enum_specifier: "class", type_definition: "value" },
  cpp: {
    class_specifier: "class",
    struct_specifier: "class",
    union_specifier: "class",
    enum_specifier: "class",
    type_definition: "value",
  },
};

// Per-grammar call-site shape for the dependency graph (push-awareness): the AST
// node type for a call and the field holding the callee name. Grammars not listed
// use the C-family default (`call_expression` / `function`).
const CALL_SPEC: Partial<Record<Grammar, { node: string; field: string }>> = {
  python: { node: "call", field: "function" },
  ruby: { node: "call", field: "method" },
  java: { node: "method_invocation", field: "name" },
};

/**
 * Extract a C/C++ function name from a `function_definition`. The name lives
 * inside the declarator, possibly wrapped in pointer/reference/parenthesized
 * declarators (`int *foo()`), so dig down to the innermost named declarator.
 */
// Step into a declarator's inner declarator. pointer_declarator carries a named
// `declarator` field; reference_declarator / parenthesized_declarator expose
// their child only as an unnamed-positional named child, so fall back to that.
function declaratorChild(d: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return d.childForFieldName("declarator") ?? d.namedChildren[0] ?? null;
}

function cFunctionName(node: Parser.SyntaxNode): string | null {
  let d: Parser.SyntaxNode | null = declaratorChild(node);
  while (d && d.type !== "function_declarator") d = declaratorChild(d);
  let name: Parser.SyntaxNode | null = d?.childForFieldName("declarator") ?? null;
  while (name && name.childForFieldName("declarator")) name = name.childForFieldName("declarator");
  if (!name) return null;
  // Accept a plain or C++-qualified identifier; reject anything exotic (e.g. a
  // function returning a function pointer leaves a garbled declarator) so it
  // degrades to a whole-file claim rather than an unusable symbol name.
  return /^[A-Za-z_~]\w*(::~?[A-Za-z_]\w*)*$/.test(name.text) ? name.text : null;
}

function lineRange(node: Parser.SyntaxNode): { startLine: number; endLine: number } {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

/** Extract top-level symbols for Python / Go / Rust from one top-level node. */
function collectLang(top: Parser.SyntaxNode, out: CodeSymbol[], grammar: Grammar): void {
  // Python: `@deco`-wrapped def/class — unwrap, but keep the decorator span.
  if (grammar === "python" && top.type === "decorated_definition") {
    const inner = top.namedChildren.find(
      (c) => c.type === "function_definition" || c.type === "class_definition",
    );
    const name = inner?.childForFieldName("name");
    if (inner && name) {
      out.push({
        name: name.text,
        kind: inner.type === "class_definition" ? "class" : "function",
        ...lineRange(top),
      });
    }
    return;
  }
  // Go: `type ( ... )` / `type Foo struct{}` / `type Foo = Bar` wrap one or more
  // type_spec (definitions) or type_alias (aliases).
  if (grammar === "go" && top.type === "type_declaration") {
    for (const spec of top.namedChildren) {
      if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
      const name = spec.childForFieldName("name");
      if (!name) continue;
      const t = spec.childForFieldName("type");
      const kind =
        spec.type === "type_spec" && t && (t.type === "struct_type" || t.type === "interface_type")
          ? "class"
          : "value";
      out.push({ name: name.text, kind, ...lineRange(spec) });
    }
    return;
  }
  // C / C++ free functions and methods: the name is buried in the declarator.
  if ((grammar === "c" || grammar === "cpp") && top.type === "function_definition") {
    const fname = cFunctionName(top);
    if (fname) out.push({ name: fname, kind: "function", ...lineRange(top) });
    return;
  }
  // C / C++ typedef may name several aliases: `typedef int foo, bar;`. Surface
  // each cleanly-named alias; skip complex declarators (e.g. `typedef int *p`).
  if ((grammar === "c" || grammar === "cpp") && top.type === "type_definition") {
    for (const decl of top.childrenForFieldName("declarator")) {
      if (/^[A-Za-z_]\w*$/.test(decl.text)) {
        out.push({ name: decl.text, kind: "value", ...lineRange(top) });
      }
    }
    return;
  }

  const kind = LANG_KINDS[grammar]?.[top.type];
  if (!kind) return;
  // Most grammars expose the symbol name via the "name" field; C typedefs put it
  // in "declarator" (`typedef struct {...} Foo`).
  const name = top.childForFieldName("name") ?? top.childForFieldName("declarator");
  if (name && !name.text.includes("\n")) out.push({ name: name.text, kind, ...lineRange(top) });
}

/** Top-level symbols of a parsed file, dispatching to the right grammar's rules. */
function collectAll(root: Parser.SyntaxNode, grammar: Grammar): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const top of root.namedChildren) {
    if (isJsFamily(grammar)) collect(top, symbols);
    else collectLang(top, symbols, grammar);
  }
  return symbols;
}

/**
 * Parse `content` and hand the root node to `fn`, then free the tree. The Tree
 * lives in the wasm heap and is reclaimed only by an explicit delete() (JS GC
 * won't do it), so callers MUST copy any data they need into plain objects
 * before returning — by the time `fn` returns, the tree is freed. Returns
 * `fallback` for unsupported extensions, unparseable input, or before
 * initSymbols() has resolved.
 */
function withTree<T>(
  path: string,
  content: string,
  fallback: T,
  fn: (root: Parser.SyntaxNode, grammar: Grammar) => T,
): T {
  if (!ready) return fallback;
  const grammar = GRAMMAR_BY_EXT[ext(path)];
  if (!grammar) return fallback;
  const parser = parsers.get(grammar);
  if (!parser) return fallback;

  let tree: Parser.Tree | null = null;
  try {
    tree = parser.parse(content);
    return fn(tree.rootNode, grammar);
  } catch {
    return fallback;
  } finally {
    tree?.delete();
  }
}

/**
 * Extract top-level symbols (functions, classes, exported values, plus TS
 * interfaces / enums / type aliases) with their 1-based inclusive line ranges,
 * using tree-sitter. Returns [] for unsupported extensions, unparseable input,
 * or before initSymbols() has resolved, so callers fall back to whole-file
 * claims. The interface is intentionally synchronous and unchanged from the
 * earlier heuristic backend.
 */
export function parseSymbols(path: string, content: string): CodeSymbol[] {
  return withTree(path, content, [], (root, grammar) => collectAll(root, grammar));
}

/**
 * Whether `path` is a language Quilt can parse symbols out of right now (the
 * extension has a grammar AND the parsers finished loading). Lets callers
 * distinguish "no such symbol in this file" (worth flagging) from "we can't see
 * symbols here at all" (unknowable, stay quiet).
 */
export function canParse(path: string): boolean {
  return ready && ext(path) in GRAMMAR_BY_EXT;
}

/** Separates the symbol scope from the line text in an ownership key. NUL can't
 * appear in a source line, so it's an unambiguous delimiter. */
export const OWN_KEY_SEP = "\u0000";

/**
 * The ownership key for a line: its enclosing symbol scope plus the line text.
 * Keying on `symbol\0text` instead of bare `text` stops identical lines in
 * different symbols (e.g. `  return null;` in two functions) from collapsing to
 * one owner. Top-level lines use an empty scope, so they key by text as before.
 */
export function ownKey(symbol: string, text: string): string {
  return symbol + OWN_KEY_SEP + text;
}

/** The line text back out of an ownership key (drops the symbol scope). */
export function keyText(key: string): string {
  const i = key.indexOf(OWN_KEY_SEP);
  return i === -1 ? key : key.slice(i + 1);
}

/**
 * Build a line-number -> enclosing-symbol lookup for a file's content, so callers
 * can compute ownership keys while walking a diff. Parses once; the returned
 * function maps a 1-based line number to the innermost symbol containing it (a
 * method beats its class — smallest span wins, ties broken by document order),
 * or "" when the line is top-level or the file doesn't parse. Empty content or an
 * unsupported language yields "" for every line, i.e. plain text keying — a safe
 * degrade.
 */
export function symbolLocator(path: string, content: string): (line: number) => string {
  const symbols = parseSymbols(path, content);
  if (symbols.length === 0) return () => "";
  return (line: number) => {
    let best = "";
    let bestSpan = Infinity;
    for (const s of symbols) {
      if (line >= s.startLine && line <= s.endLine) {
        const span = s.endLine - s.startLine; // innermost = smallest span
        if (span < bestSpan) {
          best = s.name;
          bestSpan = span;
        }
      }
    }
    return best;
  };
}

/**
 * A stateful helper for walking a line diff and producing each op's ownership
 * key. `addLoc`/`delLoc` are symbol locators for the new and old sides; pass the
 * hunk's `newStart`/`oldStart` (default 1 for a whole-file diff). Call it on
 * EVERY op in order: `eq` advances both cursors and returns null; `add`/`del`
 * return the line's `symbol\0text` key. Added lines scope to the new side (where
 * they live), removed lines to the old side.
 *
 * Consistency note: reconcile keys a removed line from its scope in the
 * last-observed baseline, while commit/undo/fleet key it from HEAD. These match
 * unless the enclosing function was RENAMED between HEAD and the baseline (a rare
 * uncommitted-rename case); if they diverge the removal is treated as unclaimed
 * (benign — never misattributed or lost). Added lines have no such split (every
 * reader scopes them from the shared working tree).
 */
export function opKeyer(
  addLoc: (line: number) => string,
  delLoc: (line: number) => string,
  newStart = 1,
  oldStart = 1,
): (op: { type: "eq" | "add" | "del"; text: string }) => string | null {
  let newLine = newStart - 1;
  let oldLine = oldStart - 1;
  return (op) => {
    if (op.type === "eq") {
      newLine++;
      oldLine++;
      return null;
    }
    if (op.type === "add") {
      newLine++;
      return ownKey(addLoc(newLine), op.text);
    }
    oldLine++;
    return ownKey(delLoc(oldLine), op.text);
  };
}

/**
 * Dependency graph: maps each top-level symbol name to the set of names it
 * references in its body — function-call callees and type references. Targets
 * are NOT restricted to symbols defined in this file, so an imported callee
 * (e.g. `caller` calling `api` from another module) is recorded by name; that's
 * what lets push-awareness catch cross-file cascades when the callee is a
 * claimed symbol elsewhere. Returns an empty map for unsupported/unparseable
 * input.
 */
export function symbolReferences(path: string, content: string): Map<string, Set<string>> {
  return withTree(path, content, new Map<string, Set<string>>(), (root, grammar) => {
    const symbols = collectAll(root, grammar);
    const refs = new Map<string, Set<string>>();

    // Find the top-level symbol whose line range encloses a given 1-based row.
    const enclosing = (row: number): string | null => {
      for (const s of symbols) if (row >= s.startLine && row <= s.endLine) return s.name;
      return null;
    };
    const add = (owner: string | null, name: string) => {
      if (!owner || owner === name) return; // ignore self / recursion
      (refs.get(owner) ?? refs.set(owner, new Set()).get(owner)!).add(name);
    };

    // Call callees: `foo(...)` -> reference to `foo`. Each grammar names the call
    // node and the callee field differently, so dispatch on both.
    const { node: callNode, field: calleeField } = CALL_SPEC[grammar] ?? {
      node: "call_expression",
      field: "function",
    };
    for (const call of root.descendantsOfType(callNode)) {
      const callee = call.childForFieldName(calleeField);
      if (callee && callee.type === "identifier") {
        add(enclosing(callee.startPosition.row + 1), callee.text);
      }
    }
    // Type references: `: Foo`, `extends Foo`, Rust `type_identifier`, etc.
    for (const t of root.descendantsOfType("type_identifier")) {
      add(enclosing(t.startPosition.row + 1), t.text);
    }
    return refs;
  });
}
