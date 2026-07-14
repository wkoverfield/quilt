import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

export interface PromptRecord {
  ts: string;
  prompt: string;
}

export interface TranscriptMatch {
  provider: "claude" | "codex";
  sessionId: string;
  prompts: PromptRecord[];
}

export interface TranscriptOptions {
  claudeDir?: string;
  codexDir?: string;
}

function jsonLines(path: string): unknown[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try { return [JSON.parse(line) as unknown]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

function filesUnder(root: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && accept(path)) out.push(path);
    }
  };
  walk(root);
  return out;
}

function actorParts(actorId: string): { provider: "claude" | "codex"; prefix: string } | null {
  const match = /^(claude|codex)-(.+)$/.exec(actorId);
  if (!match) return null;
  return { provider: match[1] as "claude" | "codex", prefix: match[2]! };
}

function insideRepo(cwd: unknown, repoRoot: string): boolean {
  if (typeof cwd !== "string") return false;
  const root = resolve(repoRoot);
  const at = resolve(cwd);
  return at === root || at.startsWith(root + sep) || root.startsWith(at + sep);
}

function claudeText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part): part is { type: string; text?: unknown } => !!part && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text).trim())
    .filter(Boolean)
    .join("\n");
  return text || null;
}

function claudeMatch(prefix: string, repoRoot: string, root: string): TranscriptMatch | null {
  const encodedRepo = resolve(repoRoot).replace(/[^a-zA-Z0-9]/g, "-");
  const projectRoot = join(root, encodedRepo);
  const searchRoot = existsSync(projectRoot) ? projectRoot : root;
  const candidates = filesUnder(searchRoot, (path) => path.endsWith(".jsonl") && basename(path).startsWith(prefix));
  for (const path of candidates) {
    const rows = jsonLines(path) as Array<Record<string, any>>;
    const sessionId = rows.find((row) => typeof row.sessionId === "string")?.sessionId;
    if (typeof sessionId !== "string" || !sessionId.startsWith(prefix)) continue;
    if (!rows.some((row) => insideRepo(row.cwd, repoRoot))) continue;
    const prompts = rows.flatMap((row): PromptRecord[] => {
      if (row.type !== "user" || row.message?.role !== "user" || typeof row.timestamp !== "string") return [];
      const prompt = claudeText(row.message.content);
      return prompt ? [{ ts: row.timestamp, prompt }] : [];
    });
    return { provider: "claude", sessionId, prompts };
  }
  return null;
}

function rolloutMeta(path: string): { id: string; cwd: string; prompts: PromptRecord[] } | null {
  const rows = jsonLines(path) as Array<Record<string, any>>;
  const meta = rows.find((row) => row.type === "session_meta")?.payload;
  if (!meta || typeof meta.id !== "string" || typeof meta.cwd !== "string") return null;
  const prompts = rows.flatMap((row): PromptRecord[] => {
    if (row.type !== "event_msg" || row.payload?.type !== "user_message") return [];
    if (typeof row.timestamp !== "string" || typeof row.payload.message !== "string") return [];
    const prompt = row.payload.message.trim();
    return prompt ? [{ ts: row.timestamp, prompt }] : [];
  });
  return { id: meta.id, cwd: meta.cwd, prompts };
}

function codexMatch(prefix: string, repoRoot: string, root: string): TranscriptMatch | null {
  const sessionsDir = join(root, "sessions");
  let match: { id: string; prompts: PromptRecord[] } | null = null;
  for (const path of filesUnder(sessionsDir, (p) => p.endsWith(".jsonl") && basename(p).startsWith("rollout-"))) {
    if (!basename(path).includes(prefix)) continue;
    const meta = rolloutMeta(path);
    if (meta?.id.startsWith(prefix) && insideRepo(meta.cwd, repoRoot)) {
      match = { id: meta.id, prompts: meta.prompts };
      break;
    }
  }
  if (!match) return null;

  const history = jsonLines(join(root, "history.jsonl")) as Array<Record<string, any>>;
  const primary = history.flatMap((row): PromptRecord[] => {
    if (row.session_id !== match!.id || typeof row.ts !== "number" || typeof row.text !== "string") return [];
    const prompt = row.text.trim();
    return prompt ? [{ ts: new Date(row.ts * 1000).toISOString(), prompt }] : [];
  });
  return { provider: "codex", sessionId: match.id, prompts: primary.length ? primary : match.prompts };
}

/** Locate the local transcript for an auto-derived Quilt actor. Read-only. */
export function locateTranscript(
  actorId: string,
  repoRoot: string,
  options: TranscriptOptions = {},
): TranscriptMatch | null {
  const parts = actorParts(actorId);
  if (!parts) return null;
  if (parts.provider === "claude") {
    const root = options.claudeDir ?? process.env.QUILT_CLAUDE_DIR ?? join(homedir(), ".claude", "projects");
    return claudeMatch(parts.prefix, repoRoot, root);
  }
  const root = options.codexDir ?? process.env.QUILT_CODEX_DIR ?? join(homedir(), ".codex");
  return codexMatch(parts.prefix, repoRoot, root);
}

/** Latest user prompt at or before an edit, which is a time-based inference. */
export function latestPromptBefore(prompts: PromptRecord[], editTs: string): PromptRecord | null {
  const limit = Date.parse(editTs);
  if (!Number.isFinite(limit)) return null;
  let best: PromptRecord | null = null;
  for (const prompt of prompts) {
    const at = Date.parse(prompt.ts);
    if (!Number.isFinite(at) || at > limit) continue;
    if (!best || at > Date.parse(best.ts)) best = prompt;
  }
  return best;
}
