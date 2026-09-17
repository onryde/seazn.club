// Spectator W2, Task 14 (review R4-2) — a division's privacy settings reach the
// public player page's cached match lines on the next poll, not after the TTL.
//
// `publicPlayerMatches` (usecases/public.ts) caches each person's lines under
// their competition's generation token, and names are masked only on a miss —
// by the opponent's division `youth` flag and `player_name_display` setting
// (`public-player-matches.ts` reads both from `divisions`). `patchDivision` is
// the one runtime writer of either column on an existing division (`youth`
// directly, or re-derived from `age_max`), so it retires the org's tokens when
// one of them CHANGES, and leaves them alone otherwise: the registration hub
// re-sends `age_max` on every Save, and each needless delete costs every
// player page in the org a cold read.
//
// Driven over real rows: the real writer, the real reader and the real
// masking. Redis is an in-memory store behind `@/lib/cache`; Next's
// `unstable_cache` is a pass-through, so the Redis document is the ONLY cache
// a read can be served from.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheGet: async (key: string) => (redis.store.has(key) ? redis.store.get(key) : null),
  cacheSet: async (key: string, value: unknown) => {
    redis.store.set(key, value);
  },
  cacheDel: (...keys: string[]) => {
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
vi.mock("@/server/logger", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

import { sql } from "@/lib/db";
import { maskDisplayName } from "@/lib/name-display";
import { patchDivision } from "../divisions";
import { endSql, opponentOf, scene, settle } from "./_player-matches-writes-scene";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  redis.store.clear();
  vi.clearAllMocks();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await endSql();
});

describe.skipIf(!HAS_DB)("patchDivision retires the cached match lines when a name-masking input changes (Task 14)", () => {
  it.each([
    ["an age band that makes the division youth (age_max 15)", { age_max: 15 }],
    ["the name display set to first_initial", { player_name_display: "first_initial" as const }],
    ["the youth flag switched on directly", { youth: true }],
  ])("%s: the next poll serves the opponent's MASKED name", async (_label, patch) => {
    const s = await scene("div-mask");
    expect(await opponentOf(s, s.ben.id), "premise: Ben's line names Ada in full, and is now cached").toEqual([
      "Ada Lovelace",
    ]);
    expect(redis.store.has(s.genKey), "premise: the read minted a generation").toBe(true);

    await patchDivision(s.owner, s.division.id, patch);
    await settle();

    expect(await opponentOf(s, s.ben.id)).toEqual([maskDisplayName("Ada Lovelace", "first_initial")]);
  }, 120_000);

  it.each([
    ["a rename", { name: "Open Renamed" }],
    // The registration hub's Save shape: `age_max` rides every body.
    ["an unchanged age band re-sent (age_max null again)", { age_max: null }],
    ["an unchanged name display re-sent (null again)", { player_name_display: null }],
  ])("%s keeps the generation, and the cached lines are what is served", async (_label, patch) => {
    const s = await scene("div-quiet");
    expect(await opponentOf(s, s.ben.id)).toEqual(["Ada Lovelace"]);
    const token = redis.store.get(s.genKey);
    expect(typeof token, "premise: the read minted a generation").toBe("string");

    await patchDivision(s.owner, s.division.id, patch);
    await settle();

    expect(redis.store.get(s.genKey), "the generation survived").toBe(token);
    // The document is still served from cache: a masking change that bypasses
    // the writer is invisible until the TTL — which is why the writer deletes.
    await sql`update divisions set youth = true where id = ${s.division.id}`;
    expect(await opponentOf(s, s.ben.id), "served from the cache").toEqual(["Ada Lovelace"]);
  }, 120_000);

  it("a concurrent write that commits while this one waits is what the change is measured against, so the retire still fires", async () => {
    const s = await scene("div-race");
    await sql`update divisions set youth = true where id = ${s.division.id}`;
    await opponentOf(s, s.ben.id);
    expect(redis.store.has(s.genKey), "premise: the read minted a generation").toBe(true);

    // Another writer turns youth OFF and holds the row, uncommitted. Between
    // its commit and ours a poll could cache the unmasked name, so our turning
    // it back ON is a change and must retire — which it can only see if its
    // "before" is read after that commit, not before it.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let signalHeld!: (pid: number) => void;
    const held = new Promise<number>((resolve) => (signalHeld = resolve));
    const holder = sql.begin(async (tx) => {
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await tx`update divisions set youth = false where id = ${s.division.id}`;
      signalHeld(pid);
      await released;
    });
    const holderPid = await held;

    const write = patchDivision(s.owner, s.division.id, { youth: true });
    // Parallel-safe waiter probe: a backend blocked by THIS holder.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))`;
      if (n > 0) break;
      if (Date.now() > deadline) throw new Error("premise: the PATCH never queued behind the holder");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;
    const row = await write;
    await settle();

    expect(row.youth, "premise: the PATCH landed").toBe(true);
    expect(redis.store.has(s.genKey), "false (the holder's commit) to true is a change").toBe(false);
  }, 120_000);
});
