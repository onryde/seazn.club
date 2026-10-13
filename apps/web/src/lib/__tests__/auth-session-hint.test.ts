// T16 fix round 1, R2 — the REAL createSession writes the readable signed-in hint beside the HttpOnly session, with
// the session's own life; destroySession clears both. The session cookie itself stays HttpOnly (the hint is the ONLY
// thing a page script can see). Options are captured: a jar that drops them could not tell HttpOnly from readable.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ jar: new Map<string, { value: string; opts: Record<string, unknown> }>() }));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)!.value } : undefined),
      set: (name: string, value: string, opts: Record<string, unknown> = {}) => void h.jar.set(name, { value, opts }),
      delete: (name: string) => void h.jar.delete(name),
    }),
}));
vi.mock("@/lib/db", () => ({ sql: () => Promise.resolve([]), withTenant: vi.fn() }));
vi.mock("@/lib/cache", () => ({
  cacheGet: () => Promise.resolve(null),
  cacheSet: () => Promise.resolve(),
  cacheDel: () => Promise.resolve(),
  cacheDelPattern: () => Promise.resolve(),
  cacheEnabled: () => false,
}));

const { createSession, destroySession } = await import("../auth");
const { SESSION_HINT_COOKIE } = await import("../session-hint");

beforeAll(() => {
  process.env.AUTH_SECRET ??= "auth-secret-for-session-hint-test-0123456789-0123456789-0123456789";
});
beforeEach(() => h.jar.clear());

describe("the signed-in hint rides with the session", () => {
  it("createSession: the session HttpOnly, the hint readable, '1', the same path, life and SameSite", async () => {
    await createSession("11111111-2222-4333-8444-999999999999");
    const session = h.jar.get("seazn_session");
    const hint = h.jar.get(SESSION_HINT_COOKIE);
    expect(session?.opts.httpOnly, "the session stays HttpOnly").toBe(true);
    expect(hint, "the hint is written").toBeDefined();
    expect(hint!.value).toBe("1");
    expect(hint!.opts.httpOnly, "a page script can read it").toBe(false);
    for (const k of ["path", "maxAge", "sameSite", "secure"] as const) {
      expect(hint!.opts[k], k).toEqual(session!.opts[k]);
    }
  });

  it("destroySession clears the hint with the session", async () => {
    await createSession("11111111-2222-4333-8444-999999999999");
    await destroySession();
    expect([h.jar.has("seazn_session"), h.jar.has(SESSION_HINT_COOKIE)]).toEqual([false, false]);
  });
});
