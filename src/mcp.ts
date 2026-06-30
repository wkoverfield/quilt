import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Store } from "./state.js";
import { headSha, shortHead } from "./git.js";
import { reconcile, buildModel } from "./engine.js";
import { selectOwned, commitSelection } from "./commit.js";
import { statusJson, mineJson, conflictsJson } from "./json.js";
import { acquireClaims, releaseClaims, listClaims } from "./claims.js";
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
   * Resolve who a tool call acts as. Precedence: an explicit per-call `actor`
   * argument > the env/start_session `active` actor. The per-call form is what
   * lets ONE shared server (e.g. Claude Code or Codex running several subagents
   * against one `quilt mcp` process) attribute each subagent correctly — there
   * is no single global "active" agent to clobber. An actor named for the first
   * time is auto-registered, so a subagent can just pass its id without a
   * separate start_session.
   */
  const resolveActor = (explicit: string | undefined, required: boolean): string | null => {
    const id = explicit ?? active?.actorId ?? null;
    if (!id) {
      if (required) {
        throw new Error("no actor — pass `actor`, or call start_session first");
      }
      return null;
    }
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
  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  // Reusable optional per-call actor field for every actor-scoped tool.
  const actorArg = z
    .string()
    .optional()
    .describe(
      "actor id to act as. Required when several agents share one server (each subagent passes its own id, e.g. its role/task name); optional if identity is pinned via start_session or QUILT_ACTOR.",
    );

  const server = new McpServer({ name: "quilt", version: "0.1.0" });

  server.registerTool(
    "start_session",
    {
      description:
        "Register an actor and start a session in this repo, pinning this server to that identity. Optional: if several agents share one server, skip this and pass `actor` on each call instead.",
      inputSchema: {
        actor: z.string().describe("actor id, e.g. wilson/codex-auth"),
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
      return ok(mineJson(selectOwned(model, repoRoot, store.readOwnership()), false));
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
      const sel = selectOwned(model, repoRoot, store.readOwnership(), { includeMixed: includeUnclaimed });
      return ok({
        patch: sel.patch,
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
      const sel = selectOwned(model, repoRoot, store.readOwnership(), { includeMixed: includeUnclaimed });
      if (sel.files.length === 0) {
        return ok({ committed: false, reason: "no owned changes to commit" });
      }
      const res = commitSelection(repoRoot, sel, actor, message);
      if (res.committed) {
        releaseClaims(store, actorId, sel.files.map((f) => f.path));
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
      return ok(res);
    },
  );

  server.registerTool(
    "claim",
    {
      description:
        "Reserve files BEFORE you edit them. Use `path#symbol` (e.g. utils.js#formatPrice) to reserve just one function/class so others can edit other parts of the same file in parallel; use a bare path to reserve the whole file. A denied target is held by another actor — edit something else or coordinate.",
      inputSchema: { actor: actorArg, paths: z.array(z.string()) },
    },
    async ({ actor, paths }) => {
      const actorId = resolveActor(actor, true)!;
      const sessionId = active?.actorId === actorId ? active?.session?.id ?? null : null;
      const results = acquireClaims(store, actorId, sessionId, paths, Date.now());
      // Push-awareness at reservation time: tell the agent if anything it just
      // claimed depends on a symbol another actor is currently changing.
      return ok({ results, dependencyWarnings: dependencyWarnings(store, actorId, Date.now()) });
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
      const n = releaseClaims(store, actorId, paths ?? null);
      return ok({ released: n });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
