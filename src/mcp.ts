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
 * The Quilt MCP server (stdio). Each coding agent runs its own instance with its
 * own actor identity, so attribution is precise per-agent. The intended agent
 * loop: start_session → (get_status → claim → edit → commit_mine). NOTHING is
 * written to stdout except the JSON-RPC transport.
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

  const requireActor = (): string => {
    if (!active) throw new Error("no active actor — call start_session first");
    return active.actorId;
  };
  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  const server = new McpServer({ name: "quilt", version: "0.0.1" });

  server.registerTool(
    "start_session",
    {
      description:
        "Identify the calling agent as an actor and start a session in this repo. Call this first.",
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
      inputSchema: {},
    },
    async () => {
      const actorId = active?.actorId ?? null;
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
    { description: "Summarize the changes you own.", inputSchema: {} },
    async () => {
      const actorId = requireActor();
      reconcile(store, actorId);
      const model = buildModel(store, actorId);
      return ok(mineJson(selectOwned(model, repoRoot, store.readOwnership()), false));
    },
  );

  server.registerTool(
    "get_conflicts",
    {
      description: "Show overlapping/shared changes and collisions that were caught.",
      inputSchema: {},
    },
    async () => {
      const actorId = active?.actorId ?? null;
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
      inputSchema: { includeUnclaimed: z.boolean().optional() },
    },
    async ({ includeUnclaimed }) => {
      const actorId = requireActor();
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
        message: z.string(),
        includeUnclaimed: z.boolean().optional(),
      },
    },
    async ({ message, includeUnclaimed }) => {
      const actorId = requireActor();
      const actor = store.findActor(actorId);
      if (!actor) throw new Error(`unknown actor ${actorId}`);
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
      inputSchema: { paths: z.array(z.string()) },
    },
    async ({ paths }) => {
      const actorId = requireActor();
      const results = acquireClaims(
        store,
        actorId,
        active?.session?.id ?? null,
        paths,
        Date.now(),
      );
      return ok({ results });
    },
  );

  server.registerTool(
    "release",
    {
      description:
        "Release your claims on the given paths. Omit `paths` to release ALL of yours; an empty array releases none.",
      inputSchema: { paths: z.array(z.string()).optional() },
    },
    async ({ paths }) => {
      const actorId = requireActor();
      // Omitting `paths` releases everything; an explicit empty array is a no-op
      // (so a programmatic empty list never accidentally drops all claims).
      const n = releaseClaims(store, actorId, paths ?? null);
      return ok({ released: n });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
