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

// Extension -> grammar. tree-sitter-javascript also parses JSX; .tsx needs the
// dedicated tsx grammar (the plain typescript grammar rejects JSX).
const GRAMMAR_BY_EXT: Record<string, "javascript" | "typescript" | "tsx"> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
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
  fn: (root: Parser.SyntaxNode) => T,
): T {
  if (!ready) return fallback;
  const grammar = GRAMMAR_BY_EXT[ext(path)];
  if (!grammar) return fallback;
  const parser = parsers.get(grammar);
  if (!parser) return fallback;

  let tree: Parser.Tree | null = null;
  try {
    tree = parser.parse(content);
    return fn(tree.rootNode);
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
  return withTree(path, content, [], (root) => {
    const symbols: CodeSymbol[] = [];
    for (const top of root.namedChildren) collect(top, symbols);
    return symbols;
  });
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
  return withTree(path, content, new Map<string, Set<string>>(), (root) => {
    const symbols: CodeSymbol[] = [];
    for (const top of root.namedChildren) collect(top, symbols);
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

    // Call-expression callees: `foo(...)` -> reference to `foo`.
    for (const call of root.descendantsOfType("call_expression")) {
      const callee = call.childForFieldName("function");
      if (callee && callee.type === "identifier") {
        add(enclosing(callee.startPosition.row + 1), callee.text);
      }
    }
    // Type references: `: Foo`, `extends Foo`, etc.
    for (const t of root.descendantsOfType("type_identifier")) {
      add(enclosing(t.startPosition.row + 1), t.text);
    }
    return refs;
  });
}
