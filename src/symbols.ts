import { splitLines } from "./diff.js";

/** A named, line-ranged code symbol (function, class, etc.). */
export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "value";
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

const JS_LIKE = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
]);

function ext(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

// Top-level declarations we recognize. `export` / `export default` prefixes are
// stripped before matching.
const DECL = [
  { re: /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" as const },
  { re: /^class\s+([A-Za-z_$][\w$]*)/, kind: "class" as const },
  {
    re: /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
    kind: "value" as const,
  },
];

/** Count net brace depth change on a line (naive — ignores braces in strings). */
function braceDelta(line: string): number {
  let d = 0;
  for (const ch of line) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

/**
 * Extract top-level symbols (functions, classes, exported values) with their
 * line ranges. Heuristic and JS/TS-only for now, behind a stable interface so a
 * tree-sitter backend can replace it without touching callers. Returns [] for
 * unsupported or unparseable files, so callers fall back to whole-file claims.
 */
export function parseSymbols(path: string, content: string): CodeSymbol[] {
  if (!JS_LIKE.has(ext(path))) return [];
  const lines = splitLines(content).lines;
  const symbols: CodeSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw
      .replace(/^export\s+default\s+/, "")
      .replace(/^export\s+/, "")
      .trimStart();

    let matched: { name: string; kind: CodeSymbol["kind"] } | null = null;
    for (const d of DECL) {
      const m = d.re.exec(trimmed);
      if (m) {
        matched = { name: m[1]!, kind: d.kind };
        break;
      }
    }
    if (!matched) continue;

    const startLine = i + 1;
    // If a block opens on this line, brace-match to its close; otherwise (e.g.
    // `const x = 1;` or a one-line arrow) the range is just this line.
    let depth = braceDelta(raw);
    let endLine = startLine;
    if (depth > 0) {
      let j = i + 1;
      for (; j < lines.length && depth > 0; j++) depth += braceDelta(lines[j]!);
      if (depth <= 0) {
        endLine = j; // 1-based inclusive close line
        i = j - 1; // skip past the consumed block
      }
      // unbalanced (depth still > 0): leave endLine = startLine, don't skip
    }

    symbols.push({ name: matched.name, kind: matched.kind, startLine, endLine });
  }

  return symbols;
}

/** The symbol whose range contains a given 1-based line, if any. */
export function symbolAtLine(symbols: CodeSymbol[], line: number): CodeSymbol | null {
  for (const s of symbols) {
    if (line >= s.startLine && line <= s.endLine) return s;
  }
  return null;
}
