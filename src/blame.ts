import { readAuthorship, type AuthorshipEvent } from "./authorship.js";
import { buildModel, type OwnedLine } from "./engine.js";
import type { Store } from "./state.js";
import { latestPromptBefore, locateTranscript, type TranscriptOptions } from "./transcripts.js";

export interface LineProvenance {
  actor: string;
  editTs: string | null;
  provider: "claude" | "codex" | null;
  sessionId: string | null;
  promptTs: string | null;
  prompt: string | null;
  inferred: boolean;
}

export interface BlameLine extends OwnedLine {
  /** Convenience owner for single-owner consumers. Conflicts also expose actors. */
  actor: string | null;
  lineNumber: number | null;
  provenance: LineProvenance[];
}

/** Stable boundaries for one unified-diff hunk within the flattened lines array. */
export interface BlameSection {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  startLineIndex: number;
  lineCount: number;
}

export interface FileBlame {
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  lines: BlameLine[];
  sections: BlameSection[];
}

function matchingEvent(
  events: AuthorshipEvent[],
  path: string,
  line: OwnedLine,
  actor: string,
): AuthorshipEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.path !== path || event.actor !== actor) continue;
    if (line.type === "add") {
      if (line.key && event.addedKeys?.includes(line.key)) return event;
      if (!event.addedKeys && event.added.includes(line.text)) return event;
    } else if (line.type === "del") {
      if (line.key && event.removedKeys?.includes(line.key)) return event;
      if (!event.removedKeys && event.removed.includes(line.text)) return event;
    }
  }
  return null;
}

/**
 * Diff HEAD to the worktree and retain the engine's ownership call per line.
 * Transcript reads happen only when this function is called by the review API.
 */
export function fileBlame(
  store: Store,
  relPath: string,
  transcriptOptions: TranscriptOptions = {},
): FileBlame | null {
  const file = buildModel(store, null, { ledgerOverlay: true }).files.find((candidate) => candidate.path === relPath);
  if (!file) return null;
  if (file.binary) {
    return {
      path: file.path,
      isNew: file.isNew,
      isDeleted: file.isDeleted,
      binary: true,
      lines: [],
      sections: [],
    };
  }

  const events = readAuthorship(store);
  const transcriptCache = new Map<string, ReturnType<typeof locateTranscript>>();
  let startLineIndex = 0;
  const sections = file.hunks.map((ownedHunk): BlameSection => {
    const section = {
      oldStart: ownedHunk.hunk.oldStart,
      oldLines: ownedHunk.hunk.oldLines,
      newStart: ownedHunk.hunk.newStart,
      newLines: ownedHunk.hunk.newLines,
      startLineIndex,
      lineCount: ownedHunk.lines.length,
    };
    startLineIndex += section.lineCount;
    return section;
  });
  const lines = file.hunks.flatMap((hunk) => hunk.lines.map((line): BlameLine => {
    const provenance = line.actors.map((actor): LineProvenance => {
      const event = matchingEvent(events, file.path, line, actor);
      if (!transcriptCache.has(actor)) {
        transcriptCache.set(actor, locateTranscript(actor, store.paths.repoRoot, transcriptOptions));
      }
      const transcript = transcriptCache.get(actor) ?? null;
      const prompt = event && transcript ? latestPromptBefore(transcript.prompts, event.ts) : null;
      return {
        actor,
        editTs: event?.ts ?? null,
        provider: transcript?.provider ?? null,
        sessionId: transcript?.sessionId ?? null,
        promptTs: prompt?.ts ?? null,
        prompt: prompt?.prompt ?? null,
        inferred: prompt !== null,
      };
    });
    return {
      ...line,
      actor: line.actors[0] ?? null,
      lineNumber: line.type === "del" ? line.oldLineNumber : line.newLineNumber,
      provenance,
    };
  }));
  return {
    path: file.path,
    isNew: file.isNew,
    isDeleted: file.isDeleted,
    binary: false,
    lines,
    sections,
  };
}
