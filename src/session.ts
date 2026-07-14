import type { Store } from "./state.js";
import type { Actor, Session } from "./types.js";

export interface ActiveContext {
  session: Session | null;
  actor: Actor | null;
  actorId: string | null;
  source: "actor-env" | "session-env" | "current-pointer" | "none";
}

/**
 * Resolve who "I" am for this invocation. Precedence:
 *   QUILT_ACTOR env > QUILT_SESSION env's actor > .quilt/current pointer.
 * This lets concurrent agents each run in their own shell/env without clobbering
 * a shared pointer file.
 */
export function activeContext(store: Store): ActiveContext {
  const envActor = process.env.QUILT_ACTOR;
  const envSession = process.env.QUILT_SESSION;
  const sessionId = envSession ?? store.readCurrentSessionId();
  const foundSession = sessionId ? store.readSession(sessionId) : null;

  const actorId = envActor ?? foundSession?.actorId ?? null;
  // An explicit actor must never inherit another actor's checkout-global
  // session. Besides confusing whoami, that would attach the wrong session and
  // prompt lineage to a durable provenance record.
  const session = envActor && foundSession?.actorId !== envActor ? null : foundSession;
  const actor = actorId ? store.findActor(actorId) : null;
  const source = envActor
    ? "actor-env"
    : envSession
      ? "session-env"
      : session
        ? "current-pointer"
        : "none";
  return { session, actor, actorId, source };
}
