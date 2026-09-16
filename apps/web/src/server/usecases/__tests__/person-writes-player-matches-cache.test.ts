// Spectator W2, Task 14 — the ORGANISER's person writes reach the public player
// page's cached match lines at once, not after their TTL.
//
// `publicPlayerMatches` (usecases/public.ts) caches each person's lines in
// Redis under their competition's generation token, and its consent gate runs
// only on a miss. The player's own consent write retires the org's tokens
// (`me-consent-player-matches-cache.test.ts`). These are the other doors, and
// for an under-16 the organiser's `patchPerson` is the ONLY one: `setMyConsent`
// refuses them (CONSENT_LOCKED). Without a delete here a revoked minor's own
// lines, and their full name as the opponent in everyone else's lines, stayed
// served until the document expired.
//
// Driven over real rows, end to end: the real writers, the real gate
// (`publicPlayerGate`), the real reader and the real name masking, one
// fixture in play between a minor and an adult. Redis is an in-memory store
// behind `@/lib/cache`; Next's `unstable_cache` is a pass-through, so the
// Redis document is the ONLY cache a read can be served from.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  failDel: null as Error | null,
}));
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheGet: async (key: string) => (redis.store.has(key) ? redis.store.get(key) : null),
  cacheSet: async (key: string, value: unknown) => {
    redis.store.set(key, value);
  },
  cacheDel: (...keys: string[]) => {
    if (redis.failDel) return Promise.reject(redis.failDel);
    for (const key of keys) redis.store.delete(key);
    return Promise.resolve();
  },
  cacheDelPattern: async () => {},
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { sql } from "@/lib/db";
import { maskDisplayName } from "@/lib/name-display";
import { createPerson, patchPerson } from "../persons";
import { mergePersons, reverseMerge } from "../person-merge";
import { endSql, opponentOf, read, scene, settle } from "./_player-matches-writes-scene";

const HAS_DB = !!process.env.DATABASE_URL;
const DELETE_FAILED = "consent: a public Redis delete failed (the write stands)";

beforeEach(() => {
  redis.store.clear();
  redis.failDel = null;
  vi.clearAllMocks();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await endSql();
});

describe.skipIf(!HAS_DB)("organiser person writes retire the cached match lines (Task 14)", () => {
  it("patchPerson revoking a MINOR's public name: the next poll misses — their page 404s and the opponent's line masks them", async () => {
    const s = await scene("revoke");
    expect(await opponentOf(s, s.ben.id), "premise: Ben's line names Ada in full").toEqual(["Ada Lovelace"]);
    expect((await read(s, s.ada.id)).matches, "premise: Ada has her line").toHaveLength(1);

    await patchPerson(s.owner, s.ada.id, { consent: { public_name: false } });
    await settle();

    expect(await opponentOf(s, s.ben.id)).toEqual([maskDisplayName("Ada Lovelace", "first_initial")]);
    await expect(read(s, s.ada.id)).rejects.toMatchObject({ status: 404 });
  }, 120_000);

  it("a field no public document carries (gender, external_ref) deletes nothing: the cached lines are still what is served", async () => {
    const s = await scene("quiet");
    expect(await opponentOf(s, s.ben.id)).toEqual(["Ada Lovelace"]);
    const token = redis.store.get(s.genKey);
    expect(typeof token, "premise: the read minted a generation").toBe("string");

    await patchPerson(s.owner, s.ada.id, { gender: "f", external_ref: "ref-7" });
    await settle();
    expect(redis.store.get(s.genKey), "the generation survived").toBe(token);

    // What that costs, and why the three identity fields must delete: a change
    // that does NOT go through a deleting writer is not seen until the TTL.
    await sql`update persons set consent = ${sql.json({ public_name: false })} where id = ${s.ada.id}`;
    expect(await opponentOf(s, s.ben.id), "served from the cache").toEqual(["Ada Lovelace"]);
  }, 120_000);

  it.each([
    ["full_name", { full_name: "Ada King" }],
    ["dob", { dob: "2012-05-05" }],
  ] as const)("patchPerson changing %s deletes the org's generation too", async (_field, patch) => {
    const s = await scene("identity");
    await read(s, s.ben.id);
    expect(redis.store.has(s.genKey), "premise: minted").toBe(true);

    await patchPerson(s.owner, s.ada.id, patch);
    await settle();

    expect(redis.store.has(s.genKey)).toBe(false);
  }, 120_000);

  it("a MERGE that resolves the survivor to opted-out masks them on the next poll, and REVERSING it unmasks them on the next", async () => {
    const s = await scene("merge");
    const dup = await createPerson(s.owner, { full_name: "Ben Stokes", consent: { public_name: false }, dob: null });
    expect(await opponentOf(s, s.ada.id), "premise: Ada's line names Ben in full").toEqual(["Ben Stokes"]);

    const merged = await mergePersons(s.owner, s.ben.id, dup.id, { confirmedBy: s.ownerId });
    await settle();
    // Stricter consent wins (`resolveConsent`): the survivor is now opted out.
    expect(await opponentOf(s, s.ada.id), "after the merge").toEqual([maskDisplayName("Ben Stokes", "first_initial")]);

    await reverseMerge(s.owner, merged.merge_id, { confirmedBy: s.ownerId });
    await settle();
    expect(await opponentOf(s, s.ada.id), "after the reversal").toEqual(["Ben Stokes"]);
  }, 120_000);

  it("a Redis delete that fails is logged, leaves nothing unhandled, and the organiser's write stands", async () => {
    const s = await scene("fail");
    const failure = new Error("simulated Redis failure");
    redis.failDel = failure;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const row = await patchPerson(s.owner, s.ada.id, { consent: { public_name: false } });
      await settle();
      expect(row.consent).toEqual({ public_name: false });
      expect(logMock.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: failure, person: s.ada.id, keys: expect.arrayContaining([s.genKey]) }),
        DELETE_FAILED,
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 120_000);
});
