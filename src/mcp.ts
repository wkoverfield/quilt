import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import type { Store } from "./state.js";
import { headSha, shortHead } from "./git.js";
import { reconcile, buildModel } from "./engine.js";
import { selectOwned, commitSelection } from "./commit.js";
import { statusJson, mineJson, conflictsJson } from "./json.js";
import { acquireClaims, acquireClaimsWait, releaseClaims, listClaims, pathsClaimedByOthers, pathsClaimedBySelf } from "./claims.js";
import { recordOutcome, openEscalations } from "./outcomes.js";
import { applyAndRecordEdit, applyAndRecordWrite } from "./authorship.js";
import { VERSION } from "./version.js";
import { dependencyWarnings } from "./push.js";
import type { Actor, ActorType, Session } from "./types.js";

/**
 * The Quilt MCP server (stdio). Attribution is per-agent. Two ways to identify:
 * an agent can pin one identity (its own server via QUILT_ACTOR, or a single
 * start_session call), OR — when several subagents share ONE server (Claude
 * Code / Codex spawning a fleet) — each tool call passes its own `actor`, so the
 * shared process attributes every subagent correctly. Intended loop:
 * (start_session?) → get_status → claim → edit → commit_mine. NOTHING is written
 * to stdout except the JSON-RPC transport.
 */
export async function runMcpServer(store: Store): Promise<void> {
  const repoRoot = store.paths.repoRoot;
  const nowIso = () => new Date().toISOString();

  let active: { actorId: string; session: Session | null } | null = null;
  // Let an agent's MCP config pin its identity via env, without a start_session call.
  const envActor = process.env.QUILT_ACTOR;
  if (envActor) {
    const sid = store.readCurrentSessionId();
    const sess = sid ? store.readSession(sid) : null;
    // Only adopt the existing session if it actually belongs to this actor —
    // a stale QUILT_SESSION could otherwise point at someone else's session.
    active = { actorId: envActor, session: sess?.actorId === envActor ? sess : null };
  }

  /**
   * The zero-config fallback: an auto id minted once per connection from the
   * client's handshake name (e.g. `cursor-3fa2`). Stdio servers are spawned per
   * client process, so this is stable for that agent's whole run — the common
   * one-agent-per-process case just works with no naming at all. Several
   * subagents sharing ONE connection still need per-call `actor` ids (there's no
   * ambient signal to tell them apart), and an explicit id is what gives
   * continuity across runs.
   */
  let connectionActorId: string | null = null;
  const connectionActor = (): string => {
    if (!connectionActorId) {
      const client = server.server.getClientVersion()?.name ?? "agent";
      const base =
        client
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "agent";
      connectionActorId = `${base}-${randomBytes(2).toString("hex")}`;
    }
    return connectionActorId;
  };

  /**
   * Resolve who a tool call acts as. Precedence: an explicit per-call `actor`
   * argument > the env/start_session `active` actor > (for calls that NEED an
   * identity) the per-connection auto id. The per-call form is what lets ONE
   * shared server (e.g. Claude Code or Codex running several subagents against
   * one `quilt mcp` process) attribute each subagent correctly — there is no
   * single global "active" agent to clobber. An actor named for the first time
   * is auto-registered, so a subagent can just pass its id without a separate
   * start_session. Optional-identity reads (get_status without an actor) stay
   * identity-less rather than minting an auto id, so the fleet view doesn't fill
   * with actors that never edited.
   */
  const resolveActor = (explicit: string | undefined, required: boolean): string | null => {
    const id = explicit ?? active?.actorId ?? (required ? connectionActor() : null);
    if (!id) return null;
    if (!store.findActor(id)) {
      store.upsertActor({
        id,
        type: "agent",
        displayName: id.split("/").pop() ?? id,
        createdAt: nowIso(),
      });
    }
    return id;
  };
  /** Whether resolveActor would fall back to the auto-derived connection id —
   * a derived identity enables claim adoption on quilt_edit/quilt_write. */
  const isAutoActor = (explicit: string | undefined): boolean =>
    explicit === undefined && !active;
  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  // Reusable optional per-call actor field for every actor-scoped tool.
  const actorArg = z
    .string()
    .optional()
    .describe(
      "actor id to act as. Auto-derived per connection when omitted (from the client name, e.g. cursor-3fa2), so naming is optional for a single agent. Pass an explicit id (your role/task name) when several subagents share one server — they have no ambient identity to tell them apart — or when you want a stable id across runs.",
    );

  const server = new McpServer({ name: "quilt", version: VERSION });

  server.registerTool(
    "start_session",
    {
      description:
        "Register an actor and start a session in this repo, pinning this server to that identity. Optional: if several agents share one server, skip this and pass `actor` on each call instead.",
      inputSchema: {
        actor: z.string().describe("actor id, e.g. auth-agent"),
        type: z.enum(["human", "agent", "bot"]).optional(),
        name: z.string().optional(),
        email: z.string().optional(),
      },
    },
    async ({ actor, type, name, email }) => {
      const t = (type ?? "agent") as ActorType;
      const a: Actor = {
        id: actor,
        type: t,
        displayName: name ?? actor.split("/").pop() ?? actor,
        email,
        createdAt: nowIso(),
      };
      store.upsertActor(a);
      const session: Session = {
        id: `sess_${randomUUID().slice(0, 12)}`,
        actorId: actor,
        actorType: t,
        repoRoot,
        baseSha: headSha(repoRoot),
        startedAt: nowIso(),
        status: "active",
      };
      store.writeSession(session);
      // Seed observed so pre-existing dirty changes stay unclaimed.
      reconcile(store, null);
      store.appendLedger({
        ts: nowIso(),
        type: "session.started",
        actorId: actor,
        sessionId: session.id,
        baseSha: session.baseSha,
        via: "mcp",
      });
      active = { actorId: actor, session };
      return ok({ sessionId: session.id, actorId: actor, base: shortHead(repoRoot) });
    },
  );

  server.registerTool(
    "get_status",
    {
      description:
        "Show who owns which working-tree changes, plus caught collisions and active claims. Call before editing and before committing.",
      inputSchema: { actor: actorArg },
    },
    async ({ actor }) => {
      const actorId = resolveActor(actor, false);
      reconcile(store, actorId);
      const model = buildModel(store, actorId);
      return ok({
        ...statusJson(model, headSha(repoRoot)),
        clobbers: store.readClobbers().clobbers.filter((c) => !c.restored),
        claims: listClaims(store, Date.now()),
        // Push-awareness at the orient step: a symbol this actor already claimed
        // depends on one another actor is changing. Mirrors `quilt status --json`.
        dependencyWarnings: actorId ? dependencyWarnings(store, actorId, Date.now()) : [],
        // Collisions an agent kicked up for a human and not yet resolved.
        needsYou: openEscalations(store),
      });
    },
  );

  server.registerTool(
    "get_my_changes",
    { description: "Summarize the changes you own.", inputSchema: { actor: actorArg } },
    async ({ actor }) => {
      const actorId = resolveActor(actor, true)!;
      reconcile(store, actorId);
      const model = buildModel(store, actorId);
      return ok(mineJson(selectOwned(model, repoRoot, store.readOwnership(), { pathClaimedByOther: pathsClaimedByOthers(store, actorId, Date.now()), pathClaimedBySelf: pathsClaimedBySelf(store, actorId, Date.now()) }), false));
    },
  );

  server.registerTool(
    "get_conflicts",
    {
      description: "Show overlapping/shared changes and collisions that were caught.",
      inputSchema: { actor: actorArg },
    },
    async ({ actor }) => {
      const actorId = resolveActor(actor, false);
      reconcile(store, actorId);
      const model = buildModel(store, actorId);
      return ok({
        ...conflictsJson(model),
        clobbers: store.readClobbers().clobbers.filter((c) => !c.restored),
        // Push-awareness: symbols this actor claimed that depend on a symbol
        // another actor is currently changing.
        dependencyWarnings: actorId ? dependencyWarnings(store, actorId, Date.now()) : [],
      });
    },
  );

  server.registerTool(
    "preview_mine",
    {
      description: "Preview the exact patch commit_mine would create.",
      inputSchema: { actor: actorArg, includeUnclaimed: z.boolean().optional() },
    },
    async ({ actor, includeUnclaimed }) => {
      const actorId = resolveActor(actor, true)!;
      reconcile(store, actorId);
      const model = buildModel(store, actorId);
      const sel = selectOwned(model, repoRoot, store.readOwnership(), {
        includeMixed: includeUnclaimed,
        pathClaimedByOther: pathsClaimedByOthers(store, actorId, Date.now()),
        pathClaimedBySelf: pathsClaimedBySelf(store, actorId, Date.now()),
      });
      return ok({
        patch: sel.patch,
        wholeFiles: sel.wholeFiles,
        skippedBinary: sel.skippedBinary,
        files: sel.files,
        totalAdded: sel.totalAdded,
        totalRemoved: sel.totalRemoved,
      });
    },
  );

  server.registerTool(
    "commit_mine",
    {
      description:
        "Commit only your owned hunks as a normal git commit, leaving other actors' changes in the tree.",
      inputSchema: {
        actor: actorArg,
        message: z.string(),
        includeUnclaimed: z.boolean().optional(),
      },
    },
    async ({ actor: actorIn, message, includeUnclaimed }) => {
      const actorId = resolveActor(actorIn, true)!;
      // resolveActor registered the actor if it was first-seen, so it exists.
      const actor = store.findActor(actorId)!;
      reconcile(store, actorId);
      const model = buildModel(store, actorId);
      const sel = selectOwned(model, repoRoot, store.readOwnership(), {
        includeMixed: includeUnclaimed,
        pathClaimedByOther: pathsClaimedByOthers(store, actorId, Date.now()),
        pathClaimedBySelf: pathsClaimedBySelf(store, actorId, Date.now()),
      });
      if (sel.files.length === 0 && sel.wholeFiles.length === 0) {
        return ok({
          committed: false,
          reason: "no owned changes to commit",
          ...(sel.skippedBinary.length
            ? { skippedBinary: sel.skippedBinary, note: "binary/too-large files need a claim to commit whole" }
            : {}),
        });
      }
      const res = commitSelection(repoRoot, sel, actor, message);
      let releasedClaims = 0;
      if (res.committed) {
        // commit_mine auto-releases the committed files' claims — SAY so in
        // the response, or the protocol's trailing `release` reads as a
        // failure (`released: 0` burned a status call for every single
        // dogfood agent).
        releasedClaims = releaseClaims(store, actorId, [...sel.files.map((f) => f.path), ...sel.wholeFiles]).released;
        reconcile(store, actorId);
        store.appendLedger({
          ts: nowIso(),
          type: "commit.mine",
          actorId,
          commitSha: res.commitSha,
          files: sel.files.map((f) => f.path),
          via: "mcp",
        });
      }
      return ok(
        res.committed
          ? {
              ...res,
              releasedClaims,
              wholeFiles: sel.wholeFiles,
              skippedBinary: sel.skippedBinary,
              note:
                "committed files' claims were auto-released — no separate release call needed" +
                (sel.skippedBinary.length
                  ? "; WARNING: unclaimed binary/too-large files were SKIPPED (claim them to commit them whole): " +
                    sel.skippedBinary.join(", ")
                  : ""),
            }
          : res,
      );
    },
  );

  server.registerTool(
    "claim",
    {
      description:
        "Reserve files BEFORE you edit them — a claim placed before editing is also what BINDS your external edits to your actor id, so claim whole files first as the default. Use a bare path for a whole file, a trailing slash for a whole directory (e.g. convex/_generated/ — right for codegen output), or `path#symbol` (e.g. utils.js#formatPrice) to reserve one function so others can edit other parts of the same file in parallel (a symbol that does not exist in the file is denied with a suggestion, since it would bind nothing). Pass a short `intent` (the why) so an actor you block can resolve the collision from it. A denied target is held by another actor — its `holderIntent` tells you what they're doing, so reconcile from that instead of just waiting.",
      inputSchema: {
        actor: actorArg,
        paths: z.array(z.string()),
        intent: z.string().optional().describe("a short why for this claim, e.g. the ticket/task"),
        creating: z.boolean().optional().describe("allow symbol claims for symbols you are ABOUT TO ADD to an existing file (they bind at write time). Without it, a symbol missing from the file is denied."),
        wait: z.number().optional().describe("seconds to BLOCK waiting for holder-denied targets to free up (holder releases, commits, or their lease lapses) instead of polling yourself. Returns as soon as everything grants. Capped at 120 per call — re-call to keep waiting. Denials that waiting can't fix (bad path, missing symbol) return immediately."),
      },
    },
    async ({ actor, paths, intent, creating, wait }) => {
      const actorId = resolveActor(actor, true)!;
      const sessionId = active?.actorId === actorId ? active?.session?.id ?? null : null;
      let results = acquireClaims(store, actorId, sessionId, paths, Date.now(), intent, { creating });
      let waited: { waitedMs: number; timedOut: boolean } | undefined;
      const heldNow = results.some((r) => !r.granted && r.holder);
      const fatalNow = results.some((r) => !r.granted && !r.holder);
      if (wait && wait > 0 && heldNow && !fatalNow) {
        // Block server-side instead of making the agent poll. Capped per call
        // so a long wait can't trip the MCP client's tool timeout; the agent
        // re-calls to extend (each re-call also refreshes its own claims).
        const waitMs = Math.min(wait, 120) * 1000;
        const outcome = await acquireClaimsWait(store, actorId, sessionId, paths, intent, {
          creating,
          waitMs,
        });
        results = outcome.results;
        waited = { waitedMs: outcome.waitedMs, timedOut: outcome.timedOut };
      }
      // Push-awareness at reservation time: tell the agent if anything it just
      // claimed depends on a symbol another actor is currently changing.
      // (A symbol claim that names nothing is DENIED with reason
      // symbol-not-found + a suggestion — it used to be granted-but-non-binding,
      // which produced a silent partial commit in the field.)
      return ok({
        results,
        ...(waited
          ? {
              waitedMs: waited.waitedMs,
              ...(waited.timedOut
                ? { note: "wait window elapsed with targets still held — re-call with wait to keep waiting, or work elsewhere" }
                : {}),
            }
          : {}),
        dependencyWarnings: dependencyWarnings(store, actorId, Date.now()),
      });
    },
  );

  server.registerTool(
    "release",
    {
      description:
        "Release your claims on the given paths. Omit `paths` to release ALL of yours; an empty array releases none.",
      inputSchema: { actor: actorArg, paths: z.array(z.string()).optional() },
    },
    async ({ actor, paths }) => {
      const actorId = resolveActor(actor, true)!;
      // Omitting `paths` releases everything; an explicit empty array is a no-op
      // (so a programmatic empty list never accidentally drops all claims).
      const r = releaseClaims(store, actorId, paths ?? null);
      return ok({
        released: r.released,
        expired: r.expired,
        ...(r.released === 0 && r.expired === 0
          ? { note: "nothing was held — commit_mine auto-releases the committed files' claims" }
          : {}),
      });
    },
  );

  server.registerTool(
    "escalate",
    {
      description:
        "Flag a collision you CANNOT reconcile (e.g. two opposed intents on the same line) for a human. Use this instead of forcing a change through when a denied claim's holderIntent conflicts with yours. It shows up under 'Needs you' until resolved.",
      inputSchema: {
        actor: actorArg,
        target: z.string().describe("the clash, e.g. pool.js#maxConnections"),
        reason: z.string().optional().describe("why it needs a human — name the opposed intents"),
      },
    },
    async ({ actor, target, reason }) => {
      const actorId = resolveActor(actor, false) ?? "unknown";
      const o = recordOutcome(store, "escalated", actorId, target, reason, new Date().toISOString());
      store.appendLedger({ ts: o.ts, type: "collision.escalated", target: o.target, actorId });
      return ok({ escalated: o });
    },
  );

  server.registerTool(
    "resolve",
    {
      description:
        "Mark a collision as sewn/handled after you reconciled it — closes its 'Needs you' flag and records the audit trail. Use after you've merged or adapted so the work accounts for both intents.",
      inputSchema: {
        actor: actorArg,
        target: z.string().describe("the clash that was resolved, e.g. pool.js#maxConnections"),
        note: z.string().optional().describe("what you did to reconcile it"),
      },
    },
    async ({ actor, target, note }) => {
      const actorId = resolveActor(actor, false) ?? "unknown";
      const o = recordOutcome(store, "resolved", actorId, target, note, new Date().toISOString());
      store.appendLedger({ ts: o.ts, type: "collision.resolved", target: o.target, actorId });
      return ok({ resolved: o });
    },
  );

  server.registerTool(
    "quilt_edit",
    {
      description:
        "Edit a file through Quilt instead of your raw editor. Replaces the unique `old_string` with `new_string` and records WHO authored the change at the moment of the edit — so attribution is exact even when several agents share this checkout, with no claims or reconcile guesswork. Pass `why` (your ticket/task). Prefer this over a plain file edit when coordinating a fleet.",
      inputSchema: {
        actor: actorArg,
        path: z.string().describe("file path (repo-relative or absolute; stored repo-relative)"),
        old_string: z.string().describe("the exact text to replace (must be unique in the file)"),
        new_string: z.string().describe("the replacement text"),
        why: z.string().optional().describe("a short why for this edit, e.g. the ticket/task"),
      },
    },
    async ({ actor, path, old_string, new_string, why }) => {
      const actorId = resolveActor(actor, true)!;
      const r = applyAndRecordEdit(store, {
        actor: actorId,
        path,
        oldString: old_string,
        newString: new_string,
        intent: why,
        autoActor: isAutoActor(actor),
      });
      if (!r.ok) {
        return ok(
          "heldBy" in r
            ? { applied: false, denied: true, heldBy: r.heldBy, holderIntent: r.holderIntent, target: r.target,
                guidance: "Another agent holds this code. Use their intent: if they're already doing your change, drop it; if compatible, edit elsewhere; if genuinely opposed, escalate." }
            : { applied: false, error: r.error },
        );
      }
      return ok({ applied: true, captured: r.event });
    },
  );

  server.registerTool(
    "quilt_write",
    {
      description:
        "Write a whole file (create or overwrite) through Quilt, recording you as the author of its contents at write time. Use for new files. Pass `why`.",
      inputSchema: {
        actor: actorArg,
        path: z.string().describe("file path (repo-relative or absolute; stored repo-relative)"),
        content: z.string().describe("full file contents"),
        why: z.string().optional(),
      },
    },
    async ({ actor, path, content, why }) => {
      const actorId = resolveActor(actor, true)!;
      const r = applyAndRecordWrite(store, {
        actor: actorId,
        path,
        content,
        intent: why,
        autoActor: isAutoActor(actor),
      });
      if (!r.ok) {
        return ok("heldBy" in r ? { applied: false, denied: true, heldBy: r.heldBy, holderIntent: r.holderIntent, target: r.target } : { applied: false, error: r.error });
      }
      return ok({ applied: true, captured: r.event });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
