import "server-only";
// Per-request context shared by BOTH route wrappers (v1's api-v1/http.ts and
// the non-versioned lib/http.ts) and read by the shared pino logger's mixin
// (server/logger.ts) so every log line carries requestId/orgId/userId
// without call sites passing them by hand. Distinct from api-v1/context.ts's
// ALS, which is v1-only and rate-limit-specific.
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContextStore {
  requestId: string;
  orgId?: string;
  userId?: string;
}

const als = new AsyncLocalStorage<RequestContextStore>();

export function runRequestContext<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ requestId }, fn);
}

/** Auth choke points call this once orgId/userId resolve. */
export function setRequestActor(actor: { orgId?: string | null; userId?: string | null }): void {
  const store = als.getStore();
  if (!store) return;
  if (actor.orgId) store.orgId = actor.orgId;
  if (actor.userId) store.userId = actor.userId;
}

export function getRequestContext(): Partial<RequestContextStore> {
  return als.getStore() ?? {};
}
