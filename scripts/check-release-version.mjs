import { readFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const lock = read("package-lock.json");
const server = read("server.json");

const versions = {
  "package.json": pkg.version,
  "package-lock.json": lock.version,
  "package-lock root package": lock.packages?.[""]?.version,
  "server.json": server.version,
  "server.json npm package": server.packages?.[0]?.version,
};

const mismatches = Object.entries(versions).filter(([, version]) => version !== pkg.version);
if (mismatches.length) {
  process.stderr.write(
    "release version mismatch; expected " + pkg.version + "\n" +
    mismatches.map(([file, version]) => `  ${file}: ${String(version)}`).join("\n") + "\n",
  );
  process.exit(1);
}
if (server.name !== pkg.mcpName) {
  process.stderr.write(`MCP name mismatch: package.json=${pkg.mcpName}, server.json=${server.name}\n`);
  process.exit(1);
}

process.stdout.write(`release metadata aligned at ${pkg.version}\n`);
