// Git interception: the shared `.git/index` is process-global mutable state, so
// raw `git add` / `git commit` / `git reset` from one actor operates on every
// other actor's staging area. With one actor that's harmless; with several it
// is how staged work gets committed under the wrong message or silently
// destroyed. This module guards the raw-git path:
//
//   - `quilt hook-bash` (PreToolUse, matcher `Bash`) classifies the command an
//     agent is about to run. Index-mutating git is denied ONLY when 2+ actors
//     have dirty attributed work — a solo actor's raw git can hurt nobody else.
//   - `quilt git -- <args>` is the deliberate escape hatch: it records a ledger
//     event, snapshots the index when the command can destroy it, then runs
//     real git verbatim.
//   - `quilt hook-git-pre-commit` (installed to `.git/hooks/pre-commit`) is the
//     backstop for commits that never crossed an agent hook: it refuses a
//     staged set spanning 2+ actors' lines (the `git add -A` sweep). It cannot
//     catch a commit of a SINGLE actor's staged tree made by someone else —
//     raw git carries no committer identity — which is why the Bash hook, where
//     identity exists, is the primary guard.
//
// Everything here fails open: a broken guard must never brick a shell or a
// commit. Denials are loud; failures are silent allows.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { foldedAuthorship } from "./authorship.js";
import { changedPaths, git } from "./git.js";
import type { Store } from "./state.js";

/** A normalized PreToolUse payload for the Bash tool. */
export interface BashHookInput {
  command: string;
  cwd: string | null;
  sessionId: string | null;
  agentId: string | null;
  agentType: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Normalize a raw Claude Code hook JSON for tool_name "Bash". Null when the
 * payload is any other tool or carries no command. */
export function parseBashHookInput(raw: unknown): BashHookInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (str(o.tool_name) !== "Bash") return null;
  const input = (o.tool_input ?? {}) as Record<string, unknown>;
  const command = str(input.command);
  if (!command) return null;
  return {
    command,
    cwd: str(o.cwd),
    sessionId: str(o.session_id),
    agentId: str(o.agent_id),
    agentType: str(o.agent_type),
  };
}

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

/** Shell operators that end one simple command and start another. */
const OPERATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);

/**
 * Split a shell command line into simple-command token lists, honoring single
 * and double quotes so `echo "git add"` is one token, not a git invocation.
 * This is a classifier, not a shell: backticks, `$(...)`, and escapes inside
 * words are kept as literal token text. That errs toward seeing MORE git than
 * the shell would run (a `git add` inside `$()` still classifies), which for a
 * guard is the safe direction.
 */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (word !== "") tokens.push(word);
    word = "";
  };
  const endSegment = () => {
    endWord();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < command.length) {
        word += command[++i];
      } else if (c === quote) {
        quote = null;
      } else {
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      // A quote opening mid-word (or an empty '' / "") still ends up in the
      // same token; the empty string must still count as a word.
      if (word === "") word = "\0EMPTY\0";
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      continue;
    }
    if (c === "\n" || c === ";" || c === "&" || c === "|") {
      // Coalesce && and || into one operator; either way the segment ends.
      endSegment();
      if ((c === "&" || c === "|") && command[i + 1] === c) i++;
      continue;
    }
    if (c === "(" || c === ")") {
      // Subshell delimiters: treat as segment boundaries so `(git add .)`
      // still classifies.
      endSegment();
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    word += c;
  }
  endSegment();
  // Restore explicit empty-string words.
  return segments.map((seg) => seg.map((t) => t.replace(/\0EMPTY\0/g, "")));
}

/** A git invocation the guard cares about. */
export interface GitMutation {
  /** the git subcommand, e.g. "add", "commit", "reset". */
  sub: string;
  /** true when the command can discard index state (reset/stash/read-tree/
   * checkout-with-pathspec) and deserves a write-tree snapshot first. */
  destroysIndex: boolean;
}

/** git global options that take a separate argument value. */
const GIT_GLOBAL_OPTS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** Subcommands that always write the shared index. */
const ALWAYS_MUTATING = new Set(["add", "commit", "reset", "stash", "rm", "mv", "update-index", "read-tree"]);

/** Subcommands whose allowed form can still destroy staged state. */
const INDEX_DESTROYING = new Set(["reset", "stash", "read-tree"]);

/**
 * Classify one simple command's tokens. Returns the mutation when this is an
 * index-mutating git invocation, null otherwise (not git, or read-only git).
 *
 * Scope is deliberately the index-mutating set: add, commit, reset, stash,
 * rm, mv, update-index, read-tree, `restore --staged`, `apply --cached|--index`,
 * and `checkout` only in its pathspec form (`checkout -- <path>` writes index
 * and worktree; branch switching is a coordination event, not an index race,
 * and stays out of scope).
 */
export function classifyTokens(tokens: string[]): GitMutation | null {
  let i = 0;
  // Skip leading env assignments (FOO=bar git ...) and benign wrappers.
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (!(/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t === "env" || t === "command" || t === "nohup")) break;
    i++;
  }
  const head = tokens[i];
  if (head === undefined) return null;
  const base = head.replace(/\\/g, "/").split("/").pop() ?? head;
  if (base !== "git") return null;
  i++;
  // Skip git's global options to find the subcommand.
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (!t.startsWith("-")) break;
    if (GIT_GLOBAL_OPTS_WITH_ARG.has(t)) i += 2;
    else i += 1; // -P, --no-pager, --git-dir=x, -c k=v (inline forms)
  }
  const sub = tokens[i];
  if (sub === undefined) return null;
  const rest = tokens.slice(i + 1);
  if (ALWAYS_MUTATING.has(sub)) {
    return { sub, destroysIndex: INDEX_DESTROYING.has(sub) };
  }
  if (sub === "restore" && rest.some((t) => t === "--staged" || t === "-S" || /^-[a-zA-Z]*S/.test(t))) {
    return { sub: "restore --staged", destroysIndex: true };
  }
  if (sub === "apply" && rest.some((t) => t === "--cached" || t === "--index")) {
    return { sub: `apply ${rest.includes("--cached") ? "--cached" : "--index"}`, destroysIndex: false };
  }
  if (sub === "checkout" && rest.includes("--")) {
    return { sub: "checkout -- <paths>", destroysIndex: true };
  }
  return null;
}

/** First index-mutating git invocation in a command line, or null. */
export function classifyCommand(command: string): GitMutation | null {
  for (const seg of shellSegments(command)) {
    const m = classifyTokens(seg);
    if (m) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dirty-actor census
// ---------------------------------------------------------------------------

/**
 * Distinct actors with attributed work on paths git currently sees as dirty.
 * Reads ownership + the authorship fold and intersects with `git status` — no
 * reconcile, so it is cheap enough for a hook and never takes the store lock.
 * The git-status intersection is what keeps stale attribution (from work since
 * committed or reverted) from counting: a path that is clean in git cannot
 * hold anyone's dirty lines, whatever the state files still say.
 */
export function dirtyActors(store: Store): string[] {
  const dirty = new Set(changedPaths(store.paths.repoRoot));
  if (dirty.size === 0) return [];
  const actors = new Set<string>();
  const ownership = store.readOwnership();
  for (const [path, file] of Object.entries(ownership.files)) {
    if (!dirty.has(path)) continue;
    for (const side of [file.added, file.removed]) {
      for (const actor of Object.values(side)) actors.add(actor);
    }
  }
  for (const [path, byKey] of foldedAuthorship(store)) {
    if (!dirty.has(path)) continue;
    for (const actor of byKey.values()) actors.add(actor);
  }
  return [...actors].sort();
}

/** The PreToolUse denial text. CLI register: state the stakes, then the safe
 * path, then the deliberate override. */
export function denyReason(mutation: GitMutation, actors: string[]): string {
  return (
    `Quilt: ${actors.length} actors have uncommitted work in this checkout ` +
    `(${actors.join(", ")}). Raw \`git ${mutation.sub}\` operates on the SHARED git index: ` +
    `it can commit their staged work under your message or destroy their staging. ` +
    `Commit your own lines with \`quilt commit --mine -m "<message>"\` (no staging needed). ` +
    `If you deliberately need raw git here, run \`quilt git -- ${mutation.sub} ...\` — it is recorded and snapshots the index first.`
  );
}

// ---------------------------------------------------------------------------
// Index snapshots
// ---------------------------------------------------------------------------

/** Ring size: enough to recover any recent reset without growing unbounded. */
export const SNAPSHOT_RING = 20;

export interface IndexSnapshot {
  ts: string;
  /** the tree sha `git write-tree` produced from the index at snapshot time. */
  tree: string;
  /** what was about to run, for the human reading the ring later. */
  context: string;
}

function snapshotsPath(store: Store): string {
  return join(store.paths.repoRoot, ".quilt", "index-snapshots.jsonl");
}

/**
 * Snapshot the current shared index as a tree object before a destructive
 * command runs. `git write-tree` persists the tree (and the blobs `git add`
 * already wrote) into the object database, so the staging selection survives
 * the reset and `git read-tree <sha>` restores it. Returns the tree sha, or
 * null when the index cannot be written (e.g. unmerged entries) — the guard
 * never blocks on its own bookkeeping.
 */
export function recordIndexSnapshot(store: Store, context: string): string | null {
  try {
    const res = git(["write-tree"], { cwd: store.paths.repoRoot, check: false });
    if (res.status !== 0) return null;
    const tree = res.stdout.trim();
    if (!tree) return null;
    const entry: IndexSnapshot = { ts: new Date().toISOString(), tree, context };
    const p = snapshotsPath(store);
    let lines: string[] = [];
    if (existsSync(p)) {
      lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    }
    lines.push(JSON.stringify(entry));
    if (lines.length > SNAPSHOT_RING) lines = lines.slice(lines.length - SNAPSHOT_RING);
    writeFileSync(p, lines.join("\n") + "\n");
    return tree;
  } catch {
    return null;
  }
}

/** The recorded snapshots, oldest first. Unparseable lines are skipped. */
export function readIndexSnapshots(store: Store): IndexSnapshot[] {
  const p = snapshotsPath(store);
  if (!existsSync(p)) return [];
  const out: IndexSnapshot[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as IndexSnapshot;
      if (parsed && typeof parsed.tree === "string") out.push(parsed);
    } catch {
      /* skip */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pre-commit backstop
// ---------------------------------------------------------------------------

/** Env var the passthrough sets so its own `git commit` is not re-refused. */
export const PASSTHROUGH_ENV = "QUILT_GIT_PASSTHROUGH";

/** Exit code `hook-git-pre-commit` uses for an actual refusal. The shim honors
 * ONLY this code: any other failure — including an older installed quilt that
 * does not know the command and exits 1 — reads as "no verdict" and the commit
 * proceeds. Without this distinction, version skew between the shim and the
 * installed CLI would fail closed and block every commit. */
export const REFUSAL_EXIT = 65;

/**
 * Owners of the currently staged set: actor -> staged files carrying that
 * actor's attributed lines. Per-file granularity — enough to catch a sweep
 * (`git add -A` on a multi-actor tree) without re-deriving per-line hunks at
 * commit time.
 */
export function stagedActorSpan(store: Store): Map<string, string[]> {
  const res = git(["diff", "--cached", "--name-only", "--no-renames"], {
    cwd: store.paths.repoRoot,
    check: false,
  });
  if (res.status !== 0) return new Map();
  const staged = new Set(res.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  if (staged.size === 0) return new Map();
  const byActor = new Map<string, Set<string>>();
  const add = (actor: string, path: string) => {
    (byActor.get(actor) ?? byActor.set(actor, new Set()).get(actor)!).add(path);
  };
  const ownership = store.readOwnership();
  for (const [path, file] of Object.entries(ownership.files)) {
    if (!staged.has(path)) continue;
    for (const side of [file.added, file.removed]) {
      for (const actor of Object.values(side)) add(actor, path);
    }
  }
  for (const [path, byKey] of foldedAuthorship(store)) {
    if (!staged.has(path)) continue;
    for (const actor of byKey.values()) add(actor, path);
  }
  return new Map([...byActor.entries()].map(([a, files]) => [a, [...files].sort()]));
}

/** The pre-commit refusal text, listing each actor's staged files. */
export function preCommitRefusal(span: Map<string, string[]>): string {
  const lines = [...span.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([actor, files]) => `  ${actor}: ${files.join(", ")}`);
  return (
    `quilt: the staged set spans ${span.size} actors' uncommitted work:\n` +
    lines.join("\n") +
    "\n" +
    "Committing it would land their lines under this commit's message.\n" +
    'Commit only your own lines with `quilt commit --mine -m "<message>"`,\n' +
    "or run the commit deliberately with `quilt git -- commit ...` (recorded).\n"
  );
}

// ---------------------------------------------------------------------------
// Pre-commit hook installation
// ---------------------------------------------------------------------------

/** Marker identifying the shim as Quilt's; bump the version to force reinstall. */
export const PRE_COMMIT_MARKER = "# quilt pre-commit shim v1";

/** A pre-existing non-quilt pre-commit hook is preserved here and chained. */
export const CHAINED_HOOK_NAME = "pre-commit.local";

/**
 * The shim `quilt setup` installs at `.git/hooks/pre-commit`. Fail-open by
 * construction: when `quilt` is not on PATH (GUI clients with a minimal env)
 * the check is skipped rather than failing the commit. A pre-existing hook,
 * preserved as `pre-commit.local`, runs after the quilt check passes.
 */
export const PRE_COMMIT_SHIM = `#!/bin/sh
${PRE_COMMIT_MARKER}
# Installed by \`quilt setup\` (re-verified on every run; \`quilt doctor\` checks it).
# Refuses a commit whose staged set spans multiple actors' uncommitted work.
# Only exit ${REFUSAL_EXIT} is a refusal; any other failure (quilt missing, an older
# quilt without this command) must NOT block the commit.
if command -v quilt >/dev/null 2>&1; then
  # stderr silenced: an older quilt prints "unknown command" there; the refusal
  # itself comes on stdout from the current CLI.
  quilt hook-git-pre-commit 2>/dev/null
  if [ $? -eq ${REFUSAL_EXIT} ]; then exit 1; fi
fi
hookdir=$(dirname "$0")
if [ -x "$hookdir/${CHAINED_HOOK_NAME}" ]; then
  "$hookdir/${CHAINED_HOOK_NAME}" "$@" || exit $?
fi
exit 0
`;

export interface PreCommitInstallResult {
  action: "create" | "update" | "skip";
  detail: string;
}

/** Is Quilt's shim (any version) present at `.git/hooks/pre-commit`? */
export function preCommitInstalled(root: string): boolean {
  const p = join(root, ".git", "hooks", "pre-commit");
  if (!existsSync(p)) return false;
  try {
    return readFileSync(p, "utf8").includes("quilt pre-commit shim");
  } catch {
    return false;
  }
}

/** Is the CURRENT shim installed? Compares content, not the marker, so any
 * shim change redeploys on the next `quilt setup` without a marker bump. */
export function preCommitCurrent(root: string): boolean {
  const p = join(root, ".git", "hooks", "pre-commit");
  if (!existsSync(p)) return false;
  try {
    return readFileSync(p, "utf8") === PRE_COMMIT_SHIM;
  } catch {
    return false;
  }
}

/**
 * Install (or re-verify) the pre-commit shim. A pre-existing hook that is not
 * Quilt's is preserved as `pre-commit.local` and chained after the check; if
 * that name is already taken by something else, nothing is touched and the
 * result says so. Idempotent: a current shim is a skip.
 */
export function installPreCommitHook(root: string, dryRun: boolean): PreCommitInstallResult {
  const hooksDir = join(root, ".git", "hooks");
  const hookPath = join(hooksDir, "pre-commit");
  const chainedPath = join(hooksDir, CHAINED_HOOK_NAME);
  const exists = existsSync(hookPath);
  if (exists && preCommitCurrent(root)) {
    return { action: "skip", detail: "pre-commit guard already installed" };
  }
  let action: PreCommitInstallResult["action"];
  let detail: string;
  if (!exists) {
    action = "create";
    detail = "install the pre-commit guard (multi-actor staged sets are refused)";
  } else if (preCommitInstalled(root)) {
    action = "update";
    detail = "update the pre-commit guard to the current version";
  } else if (existsSync(chainedPath)) {
    return {
      action: "skip",
      detail: `left untouched — an existing pre-commit hook is present and ${CHAINED_HOOK_NAME} is taken; chain \`quilt hook-git-pre-commit\` into it by hand`,
    };
  } else {
    action = "update";
    detail = `install the pre-commit guard (existing hook preserved as ${CHAINED_HOOK_NAME}, still runs)`;
  }
  if (dryRun) return { action, detail };
  try {
    mkdirSync(hooksDir, { recursive: true });
    if (exists && !preCommitInstalled(root) && !existsSync(chainedPath)) {
      renameSync(hookPath, chainedPath);
    }
    writeFileSync(hookPath, PRE_COMMIT_SHIM);
    chmodSync(hookPath, 0o755);
    return { action, detail };
  } catch (e) {
    return { action: "skip", detail: `could not install pre-commit guard (${(e as Error).message})` };
  }
}

/** Append a passthrough/guard event to the ledger without throwing. */
export function logGuardEvent(store: Store, event: Record<string, unknown>): void {
  try {
    store.appendLedger({ ts: new Date().toISOString(), type: "git.passthrough", ...event });
  } catch {
    /* bookkeeping must not block the command */
  }
}
