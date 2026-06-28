import type { Store } from "./state.js";
import type { Actor, Session } from "./types.js";

export interface ActiveContext {
  session: Session | null;
  actor: Actor | null;
  actorId: string | null;
}

/**
 * Resolve who "I" am for this invocation. Precedence:
 *   QUILT_ACTOR env > QUILT_SESSION env's actor > .quilt/current pointer.
 * This lets concurrent agents each run in their own shell/env without clobbering
 * a shared pointer file.
 */
export function activeContext(store: Store): ActiveContext {
  const envActor = process.env.QUILT_ACTOR;
  const sessionId = store.readCurrentSessionId();
  const session = sessionId ? store.readSession(sessionId) : null;

  const actorId = envActor ?? session?.actorId ?? null;
  const actor = actorId ? store.findActor(actorId) : null;
  return { session, actor, actorId };
}
