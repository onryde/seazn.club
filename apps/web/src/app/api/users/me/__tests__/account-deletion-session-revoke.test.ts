// Security: a deleted account's sessions on OTHER devices must stop working.
//
// Sessions here are stateless JWTs (lib/auth.ts): nothing server-side records "this token is revoked", so the only
// thing standing between a token minted before the deletion and the account it names is what `getCurrentUser` does
// with the user row. Deletion is a SOFT delete (DELETE /api/users/me anonymises the row and stamps `deleted_at`;
// the row stays for 30 days), and the resolver's lookup used to ignore `deleted_at` — so the deleting device was
// signed out (its cookie is cleared) while every other device's token kept resolving, to a signed-in "Deleted User".
//
// Two things must both hold, and each is pinned by its own mutation below:
//   * the lookup refuses a deleted row            (drop `deleted_at is null`  -> the DB-filter tests red)
//   * the cached copy of the row cannot outlive it (drop `invalidateUser`     -> the warm-cache test reds)
//
// Driven end to end, with nothing stubbed on the identity path: the REAL createSession mints each device's cookie into
// that device's own jar, the REAL DELETE /api/users/me deletes the account (real Postgres), and the REAL getCurrentUser /
// requireUser / GET /api/users/me are what each device is then asked. The stand-ins are the outside world only: the
// cookie jar (`next/headers`), the account-deletion email, Stripe, and Redis — replaced by an in-memory cache that honours
// the same contract (get / set with a TTL on the clock / delete by key or glob), because the suite has no Redis and a
// no-op cache would make the "warm cache" half of this file vacuous.
//
// Sport: not applicable. Sessions and account deletion are sport-agnostic.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ subscriptions: { cancel: vi.fn(async () => ({})) } }) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendAccountDeletionEmail: vi.fn(async () => {}),
}));

type Entry = { value: string; expiresAt: number };
const h = vi.hoisted(() => ({
  /** One cookie jar per device. The test switches `device` before each call, the way each device's request carries its own cookies. */
  jars: new Map<string, Map<string, string>>(),
  device: "A",
  cache: new Map<string, Entry>(),
  /** Every TTL the resolver asked the cache to hold a user for, in seconds. */
  ttlsAsked: [] as number[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    const jar = h.jars.get(h.device)!;
    return {
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    };
  },
}));

// Redis, as a Map on the (fakeable) clock. Same observable contract as lib/cache.ts: a miss is null, a value past its TTL is a
// miss, and delete-by-pattern takes a glob.
vi.mock("@/lib/cache", async (importOriginal) => {
  const live = (key: string): Entry | undefined => {
    const e = h.cache.get(key);
    if (e && e.expiresAt <= Date.now()) {
      h.cache.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    ...(await importOriginal<typeof import("@/lib/cache")>()),
    cacheEnabled: () => true,
    cacheGet: async (key: string) => {
      const e = live(key);
      return e ? JSON.parse(e.value) : null;
    },
    cacheSet: async (key: string, value: unknown, ttlSeconds: number) => {
      if (key.startsWith("user:")) h.ttlsAsked.push(ttlSeconds);
      h.cache.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    cacheDel: async (...keys: string[]) => void keys.forEach((k) => h.cache.delete(k)),
    cacheDelPattern: async (pattern: string) => {
      const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      for (const k of [...h.cache.keys()]) if (re.test(k)) h.cache.delete(k);
    },
  };
});

import { sql } from "@/lib/db";
import { createSession, getCurrentUser, requireUser } from "@/lib/auth";
import { AuthError } from "@/lib/errors";
import { sendAccountDeletionEmail } from "@/lib/email";
import { DELETE, GET } from "@/app/api/users/me/route";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `srev-${randomUUID().slice(0, 8)}`;
const userKey = (id: string) => `user:${id}`;
const seeded: string[] = [];

type Seed = { id: string; email: string; name: string };

async function seedUser(tag: string): Promise<Seed> {
  const email = `${RUN}-${tag}-${randomUUID().slice(0, 6)}@test.local`;
  const name = `Session ${tag}`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, ${name}, true) returning id`;
  seeded.push(id);
  return { id, email, name };
}

const as = (device: string) => {
  h.device = device;
  if (!h.jars.has(device)) h.jars.set(device, new Map());
};
const tokenOn = (device: string) => h.jars.get(device)?.get("seazn_session");

/** Sign `userId` in on `device` through the real createSession, one second after the last mint so each device holds a DIFFERENT JWT. */
async function signIn(device: string, userId: string): Promise<string> {
  as(device);
  vi.setSystemTime(Date.now() + 1000);
  await createSession(userId);
  return tokenOn(device)!;
}

/** What this device is told right now, asked three ways: the resolver, the throwing guard, and the real whoami route. */
async function ask(device: string) {
  as(device);
  const user = await getCurrentUser();
  let guard: "ok" | "AuthError" | "other" = "ok";
  try {
    await requireUser();
  } catch (e) {
    guard = e instanceof AuthError ? "AuthError" : "other";
  }
  const res = await GET();
  return { user, guard, status: res.status };
}

const del = (device: string) => {
  as(device);
  return DELETE(new Request("http://test.local/api/users/me", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) }));
};
const row = async (id: string) =>
  (await sql<{ email: string; display_name: string; deleted_at: Date | null }[]>`
    select email, display_name, deleted_at from users where id = ${id}`)[0]!;

beforeEach(() => {
  vi.clearAllMocks();
  h.jars.clear();
  h.cache.clear();
  h.ttlsAsked.length = 0;
  h.device = "A";
  // Only the clock: the session TTL and the cache TTL both read Date, and the test moves it. Timers stay real so the pool is untouched.
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  if (HAS_DB) {
    await sql`delete from users where id = any(${seeded}::uuid[])`.catch(() => undefined);
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

describe.skipIf(!HAS_DB)("a deleted account's sessions on other devices", () => {
  it("every other device's session stops resolving after the deletion — through a WARM cache — and a second account is untouched", async () => {
    const leaver = await seedUser("leaver");
    const bystander = await seedUser("bystander");
    const tokenA = await signIn("A", leaver.id);
    const tokenB = await signIn("B", leaver.id);
    const tokenC = await signIn("C", leaver.id);
    const tokenD = await signIn("D", bystander.id);
    // Three distinct JWTs for one account (so these are three sessions, not one cookie copied), and a fourth for someone else.
    expect(new Set([tokenA, tokenB, tokenC]).size).toBe(3);
    expect(new Set([tokenA, tokenB, tokenC, tokenD]).size).toBe(4);

    // BEFORE: everyone is signed in, and the resolver has warmed the cache for both accounts.
    for (const [device, who] of [["A", leaver], ["B", leaver], ["C", leaver], ["D", bystander]] as const) {
      const before = await ask(device);
      expect(before.user?.id, `${device} resolves before the deletion`).toBe(who.id);
      expect(before.guard).toBe("ok");
      expect(before.status).toBe(200);
    }
    expect(h.cache.has(userKey(leaver.id)), "the leaver's row is cached (the precondition this test is about)").toBe(true);
    expect(h.cache.has(userKey(bystander.id))).toBe(true);

    // The deletion, from device A, through the real route.
    const res = await del("A");
    expect(res.status).toBe(200);
    expect((await row(leaver.id)).deleted_at).not.toBeNull();

    // AFTER: the deleting device's cookie is cleared (that always worked). B and C still hold a cookie carrying a valid,
    // unexpired JWT for the leaver, which is the thing under test — and they are signed out too.
    expect(tokenOn("A")).toBeUndefined();
    expect(tokenOn("B")).toBe(tokenB);
    expect(tokenOn("C")).toBe(tokenC);
    const checked: string[] = [];
    for (const device of ["A", "B", "C"]) {
      const after = await ask(device);
      expect(after.user, `${device}: getCurrentUser`).toBeNull();
      expect(after.guard, `${device}: requireUser`).toBe("AuthError");
      expect(after.status, `${device}: GET /api/users/me`).toBe(401);
      checked.push(device);
    }
    expect(checked, "every device of the deleted account was asked").toEqual(["A", "B", "C"]);

    // The refusal did not re-cache the anonymised row, and the deletion's cache bust took only the leaver's entry.
    expect(h.cache.has(userKey(leaver.id)), "a deleted user is never cached").toBe(false);
    expect(h.cache.has(userKey(bystander.id)), "the bust is scoped to the leaver").toBe(true);

    // Positive pair: the second account resolves, with its own profile, on every path.
    const other = await ask("D");
    expect(other.user).toMatchObject({ id: bystander.id, display_name: bystander.name, email: bystander.email });
    expect(other.guard).toBe("ok");
    expect(other.status).toBe(200);
  });

  it("with a COLD cache the database lookup refuses the deleted row on its own", async () => {
    const leaver = await seedUser("cold");
    await signIn("A", leaver.id);
    await signIn("B", leaver.id);
    expect((await ask("B")).user?.id).toBe(leaver.id);
    expect((await del("A")).status).toBe(200);
    h.cache.clear(); // nothing cached: only the lookup can answer, and the row IS still in the table
    expect((await row(leaver.id)).display_name, "the row survives the soft delete, anonymised").toBe("Deleted User");

    const after = await ask("B");
    expect(after.user).toBeNull();
    expect(after.guard).toBe("AuthError");
    expect(after.status).toBe(401);
    expect(h.cache.has(userKey(leaver.id))).toBe(false);
  });

  it("a deletion whose cache bust was MISSED still ends when the cached entry expires", async () => {
    const leaver = await seedUser("ttl");
    await signIn("B", leaver.id);
    expect((await ask("B")).user?.id).toBe(leaver.id);
    expect(h.ttlsAsked.length, "the resolver cached the row, with a TTL").toBeGreaterThan(0);
    const ttlSeconds = Math.max(...h.ttlsAsked);
    expect(ttlSeconds).toBeGreaterThan(0);

    // Delete the row behind the application's back: the bust never runs, so the warm entry is left in place.
    await sql`update users set deleted_at = now(), display_name = 'Deleted User' where id = ${leaver.id}`;
    expect(h.cache.has(userKey(leaver.id)), "the entry the missed bust leaves behind").toBe(true);

    // Past the TTL the entry is gone and the lookup answers, and the lookup refuses a deleted row.
    vi.setSystemTime(Date.now() + (ttlSeconds + 1) * 1000);
    const after = await ask("B");
    expect(after.user).toBeNull();
    expect(after.guard).toBe("AuthError");
    expect(after.status).toBe(401);
  });

  it("deleting twice: a stale session cannot run the deletion again, and nothing is re-anonymised or re-mailed", async () => {
    const leaver = await seedUser("twice");
    await signIn("A", leaver.id);
    await signIn("B", leaver.id);
    expect((await del("A")).status).toBe(200);
    const first = await row(leaver.id);
    expect(first.deleted_at).not.toBeNull();
    expect(vi.mocked(sendAccountDeletionEmail)).toHaveBeenCalledTimes(1);

    // Device A's cookie is cleared; device B still holds its own. Neither may delete again.
    const fromA = await del("A");
    const fromB = await del("B");
    expect(fromA.status).toBe(401);
    expect(fromB.status, "the stale session is refused rather than served a second deletion").toBe(401);

    const second = await row(leaver.id);
    expect(second.deleted_at?.getTime(), "deleted_at is stamped once").toBe(first.deleted_at!.getTime());
    expect(vi.mocked(sendAccountDeletionEmail), "no second 'your account is deleted' mail").toHaveBeenCalledTimes(1);
  });

  it("a session minted AFTER the deletion (an impersonation or login link redeemed late) resolves to nobody", async () => {
    const leaver = await seedUser("late");
    await signIn("A", leaver.id);
    expect((await del("A")).status).toBe(200);

    // The same createSession the impersonation page and the login-link consumers call, for an id that is now deleted.
    const late = await signIn("E", leaver.id);
    expect(late).toBeTruthy();
    const after = await ask("E");
    expect(after.user).toBeNull();
    expect(after.guard).toBe("AuthError");
    expect(after.status).toBe(401);
  });

  it("the address is free again after deletion, and a new account on it is a different person to the old tokens", async () => {
    const leaver = await seedUser("reuse");
    await signIn("A", leaver.id);
    await signIn("B", leaver.id);
    expect((await del("A")).status).toBe(200);
    expect(tokenOn("B"), "device B still holds the old account's cookie").toBeTruthy();

    // Someone signs up with the address the leaver used. The old token names the OLD id.
    const [{ id: newId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${leaver.email}, 'New Owner', true) returning id`;
    seeded.push(newId);
    expect(newId).not.toBe(leaver.id);
    await signIn("N", newId);

    expect((await ask("B")).user, "the old account's token stays refused").toBeNull();
    const fresh = await ask("N");
    expect(fresh.user).toMatchObject({ id: newId, display_name: "New Owner", email: leaver.email });
  });
});
