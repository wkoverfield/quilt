import type { Selection } from "./commit.js";
import { git } from "./git.js";
import type { Actor } from "./types.js";

export const PROVENANCE_TRAILER = "Quilt-Provenance";

export interface DurableHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface DurableFile {
  path: string;
  hunks: DurableHunk[];
}

export interface CommitProvenanceV1 {
  version: 1;
  actor: Pick<Actor, "id" | "type" | "displayName">;
  sessionId: string | null;
  capture: "owned" | "owned+unclaimed";
  /** Exact Git objects committed. Filled by commitSelection after staging. */
  tree: string | null;
  parent: string | null;
  files: DurableFile[];
}

function parseHunks(patch: string, fileCount: number): DurableHunk[][] {
  const chunks = patch.split(/^diff --git /m).slice(1);
  const byFile: DurableHunk[][] = [];
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    const hunks: DurableHunk[] = [];
    for (const line of (chunks[fileIndex] ?? "").split("\n")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!header) continue;
      hunks.push({
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
      });
    }
    byFile.push(hunks);
  }
  return byFile;
}

/** Build the portable v1 record. A Quilt commit is single-actor by
 * construction, and the hunk ranges name exactly which parts of its diff that
 * actor committed. Prompt correlation remains local until capture events carry
 * an exact, compaction-safe source-session link. */
export function buildCommitProvenance(
  selection: Selection,
  actor: Actor,
  sessionId: string | null,
  includeUnclaimed = false,
): CommitProvenanceV1 {
  const parsed = parseHunks(selection.patch, selection.files.length);
  const files = selection.files.map((file, fileIndex): DurableFile => ({
    path: file.path,
    hunks: parsed[fileIndex] ?? [],
  }));
  for (const path of selection.wholeFiles) files.push({ path, hunks: [] });
  return {
    version: 1,
    actor: { id: actor.id, type: actor.type, displayName: actor.displayName },
    sessionId,
    capture: includeUnclaimed ? "owned+unclaimed" : "owned",
    tree: null,
    parent: null,
    files,
  };
}

export function encodeProvenance(value: CommitProvenanceV1): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function commitMessageWithProvenance(message: string, value: CommitProvenanceV1): string {
  // Quilt owns this trailer namespace. Remove user-supplied copies so an
  // earlier forged record cannot disagree with the canonical final trailers.
  const clean = message
    .split("\n")
    .filter((line) => !/^Quilt-(?:Actor|Session|Capture|Provenance):/i.test(line))
    .join("\n")
    .trimEnd();
  const trailerValue = (input: string): string => input.replace(/[\r\n]+/g, " ").trim();
  const trailers = [
    `Quilt-Actor: ${trailerValue(value.actor.id)}`,
    ...(value.sessionId ? [`Quilt-Session: ${trailerValue(value.sessionId)}`] : []),
    `Quilt-Capture: ${value.capture}`,
    `${PROVENANCE_TRAILER}: ${encodeProvenance(value)}`,
  ];
  return clean + "\n\n" + trailers.join("\n") + "\n";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
}

function isProvenance(value: unknown): value is CommitProvenanceV1 {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const actor = record.actor as Record<string, unknown> | null;
  if (record.version !== 1 || !actor || typeof actor !== "object") return false;
  if (typeof actor.id !== "string" || typeof actor.displayName !== "string") return false;
  if (actor.type !== "human" && actor.type !== "agent" && actor.type !== "bot") return false;
  if (record.sessionId !== null && typeof record.sessionId !== "string") return false;
  if (record.capture !== "owned" && record.capture !== "owned+unclaimed") return false;
  if (!isObjectId(record.tree)) return false;
  if (record.parent !== null && !isObjectId(record.parent)) return false;
  if (!Array.isArray(record.files)) return false;
  return record.files.every((file) => {
    if (!file || typeof file !== "object") return false;
    const entry = file as Record<string, unknown>;
    if (typeof entry.path !== "string" || !Array.isArray(entry.hunks)) return false;
    return entry.hunks.every((hunk) => {
      if (!hunk || typeof hunk !== "object") return false;
      const range = hunk as Record<string, unknown>;
      return isNonNegativeInteger(range.oldStart) && isNonNegativeInteger(range.oldLines) &&
        isNonNegativeInteger(range.newStart) && isNonNegativeInteger(range.newLines);
    });
  });
}

export function decodeProvenance(encoded: string): CommitProvenanceV1 | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return isProvenance(value) ? value : null;
  } catch {
    return null;
  }
}

/** Read and verify provenance from a commit message. The record travels with
 * ordinary Git pushes and merges, with no separate notes ref to configure. */
export function readCommitProvenance(repoRoot: string, revision = "HEAD"): CommitProvenanceV1 | null {
  if (revision.startsWith("-")) return null;
  const shown = git(["show", "-s", "--format=%B", revision], { cwd: repoRoot, check: false });
  if (shown.status !== 0) return null;
  const matches = [...shown.stdout.matchAll(/^Quilt-Provenance:\s*(\S+)\s*$/gm)];
  const encoded = matches.at(-1)?.[1];
  const record = encoded ? decodeProvenance(encoded) : null;
  if (!record) return null;
  const objects = git(["show", "-s", "--format=%T%n%P", revision], { cwd: repoRoot, check: false });
  if (objects.status !== 0) return null;
  const [tree, parents = ""] = objects.stdout.trimEnd().split("\n");
  const firstParent = parents.trim().split(/\s+/).filter(Boolean)[0] ?? null;
  if (record.tree !== tree || record.parent !== firstParent) return null;
  return record;
}
