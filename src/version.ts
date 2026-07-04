import { readFileSync } from "node:fs";

/**
 * The package version, read from package.json so the CLI, the MCP server, and
 * npm can never disagree (0.4.0 shipped with a hardcoded "0.3.0" — this is why
 * hardcoding is banned). dist/ sits one level below the package root, and so
 * does src/ when running under tsx, so the relative hop is the same either way.
 */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
