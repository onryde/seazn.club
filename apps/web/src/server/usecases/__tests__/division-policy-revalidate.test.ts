// Privacy hotfix (2026-09-16) — a division's NAME POLICY change reaches public
// pages at once.
//
// `youth` (derived from `age_max`) and `player_name_display` decide whether a
// division's players are named in full. Turning either stricter is the
// safeguarding "hide this now" moment, and the player card's cache entry,
// which reads every roster the person has in the org, is tagged with the ORG.
// So `patchDivision` must expire the org tag and the division's own tags when
// the STORED policy actually changes. It must not fire when it does not: the
// registration hub re-sends `age_max` on every Save, and an org tag bust
// rebuilds the org's whole public tree.
//
// Through Next's real per-request flush, the harness shape of
// `score-revalidate-in-request.test.ts`: a tag fired after the use-case
// resolves is dropped by Next, so the assertions run the instant it resolves.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Next's node environment installs this global before any server module
  // loads; without it Next's storages are a fake that throws on `run`.
  const g = globalThis as { AsyncLocalStorage?: unknown };
  g.AsyncLocalStorage ??= process.getBuiltinModule("node:async_hooks").AsyncLocalStorage;
});

// The public Redis documents, in memory (final review I2): a literal DEL and a
// `prefix*` sweep, both applied the moment they are called.
const redis = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheDel: (...keys: string[]) => {
    for (const key of keys) redis.delete(key);
    return Promise.resolve();
  },
  cacheDelPattern: async (pattern: string) => {
    const prefix = pattern.slice(0, -1);
    for (const key of [...redis.keys()]) if (pattern.endsWith("*") && key.startsWith(prefix)) redis.delete(key);
  },
}));

import { EventEmitter } from "node:events";
import { AfterContext } from "next/dist/server/after/after-context";
import { workAsyncStorage, type WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import {
  workUnitAsyncStorage,
  type RequestStore,
} from "next/dist/server/app-render/work-unit-async-storage.external";
import { executeRevalidates } from "next/dist/server/revalidation-utils";
import { defaultConfig } from "next/dist/server/config-shared";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { competitionTag, divisionTag, orgTag } from "@/server/public-site/data";
import { createCompetition } from "../competitions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { createDivision, patchDivision } from "../divisions";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

type FlushCall = { tags: string[]; durations: { expire?: number } | undefined };

/** One route-handler request: the handler inside both storages, then ONE
 *  flush as soon as it resolves (app-route/module.js), then the after-window:
 *  `after()` callbacks run once the response closes. `gap` runs between the
 *  handler resolving and the flush. `calls` is what the REQUEST flushed. */
async function inRequest<T>(
  handler: () => Promise<T>,
  gap?: () => void,
): Promise<{ result: T; calls: FlushCall[] }> {
  const calls: FlushCall[] = [];
  const res = new EventEmitter();
  const waitingOn: Array<Promise<unknown>> = [];
  const afterContext = new AfterContext({
    waitUntil: (promise: Promise<unknown>) => {
      waitingOn.push(promise);
    },
    onClose: (listener: () => void) => {
      res.once("close", listener);
    },
    onTaskError: undefined,
  });
  const workStore = {
    route: "/api/v1/divisions/[id]",
    page: "/api/v1/divisions/[id]/route",
    incrementalCache: {
      revalidateTag: (tags: string | string[], durations?: { expire?: number }) => {
        calls.push({ tags: typeof tags === "string" ? [tags] : [...tags], durations });
      },
    },
    cacheLifeProfiles: defaultConfig.cacheLife,
    afterContext,
  } as unknown as WorkStore;
  const requestStore = { type: "request", phase: "action" } as unknown as RequestStore;
  const out = await workAsyncStorage.run(workStore, async () => {
    const result = await workUnitAsyncStorage.run(requestStore, handler);
    gap?.();
    const flush = executeRevalidates(workStore);
    if (flush !== false) await flush;
    return { result, calls: [...calls] };
  });
  res.emit("close");
  await Promise.all(waitingOn);
  return out;
}

const GENERIC = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("patchDivision — a name-policy change expires the org's public pages", () => {
  let auth: AuthCtx;
  let orgSlug: string;
  let competitionId: string;

  const division = async (name: string, ageMax: number | null) =>
    createDivision(auth, competitionId, {
      name,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC,
      ...(ageMax === null ? {} : { age_max: ageMax }),
    });

  beforeAll(async () => {
    ({ auth } = await seedOrg("pro"));
    [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Policy Revalidate Cup",
      visibility: "public",
      branding: {},
    });
    competitionId = comp.id;
  });

  const tagsOf = (calls: FlushCall[]) => calls.flatMap((c) => c.tags).sort();

  it("player_name_display turned to first_initial: the org tag expires immediately, and the division and competition tags are revalidated too", async () => {
    const adult = await division("Seniors", null);
    const { result, calls } = await inRequest(() =>
      patchDivision(auth, adult.id, { player_name_display: "first_initial" }),
    );
    expect(result.player_name_display).toBe("first_initial");
    expect(tagsOf(calls)).toEqual(
      [orgTag(orgSlug), divisionTag(adult.id), competitionTag(competitionId)].sort(),
    );
    expect(calls.find((c) => c.tags.includes(orgTag(orgSlug)))!.durations).toEqual({ expire: 0 });
  });

  it("youth turned on by a new age_max: both revalidations fire", async () => {
    const adult = await division("Open", null);
    const { result, calls } = await inRequest(() => patchDivision(auth, adult.id, { age_max: 12 }));
    expect(result.youth, "precondition: age_max 12 derives youth").toBe(true);
    expect(tagsOf(calls)).toEqual(
      [orgTag(orgSlug), divisionTag(adult.id), competitionTag(competitionId)].sort(),
    );
  });

  it("an unrelated rename fires neither", async () => {
    const u12 = await division("U12", 12);
    const { result, calls } = await inRequest(() => patchDivision(auth, u12.id, { name: "Under 12s" }));
    expect(result.name).toBe("Under 12s");
    expect(calls).toEqual([]);
  });

  it("the hub re-sending an unchanged age_max (and name display) fires neither", async () => {
    const u14 = await division("U14", 14);
    expect(u14.youth, "precondition: a youth division").toBe(true);
    const { result, calls } = await inRequest(() =>
      patchDivision(auth, u14.id, { age_max: 14, player_name_display: u14.player_name_display }),
    );
    expect(result.youth).toBe(true);
    expect(calls).toEqual([]);
  });

  it("youth turned on: the division tag EXPIRES (not stale), and the public Redis documents printing its names are dropped — its competition's hub, its schedule, standings and entrants, and its fixtures' match-centre documents; another division's are kept (final review I2)", async () => {
    const adult = await division("Seniors I2", null);
    const other = await division("Veterans I2", null);
    await createEntrants(
      auth,
      adult.id,
      ["Arun Kumar", "Dev Patel"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, adult.id, { seq: 1, kind: "league", name: "League", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    expect(fixtures.length, "premise: the division has a fixture").toBeGreaterThan(0);
    const named = [
      `pub:v1:hub:${competitionId}`,
      `pub:v1:div:${adult.id}:entrants-v2`,
      `pub:v1:div:${adult.id}:standings`,
      ...fixtures.map((f) => `pub:v1:fixture:v2:${f.id}`),
    ];
    const unrelated = [`pub:v1:div:${other.id}:entrants-v2`, `pub:v1:fixture:v2:00000000-0000-4000-8000-000000000000`];
    redis.clear();
    for (const key of [...named, ...unrelated]) redis.set(key, { cached: "Arun Kumar" });

    const { result, calls } = await inRequest(() => patchDivision(auth, adult.id, { age_max: 12 }));

    expect(result.youth, "precondition: age_max 12 derives youth").toBe(true);
    expect(calls.find((c) => c.tags.includes(divisionTag(adult.id)))!.durations, "the division tag").toEqual({
      expire: 0,
    });
    expect(named.filter((key) => redis.has(key)), "documents still printing the old names").toEqual([]);
    expect(unrelated.filter((key) => redis.has(key)), "another division's documents").toEqual(unrelated);
  });

  it("a poll that re-bakes a document between the policy change's Redis drop and its tag flush: dropped AGAIN in the after-window (review r2-m1)", async () => {
    const adult = await division("Seniors rebake", null);
    const named = [
      `pub:v1:hub:${competitionId}`,
      `pub:v1:div:${adult.id}:entrants-v2`,
      `pub:v1:div:${adult.id}:standings`,
      `pub:v1:div:${adult.id}:schedule`,
    ];
    redis.clear();
    for (const key of named) redis.set(key, { cached: "Arun Kumar" });

    let droppedMidRequest: string[] | null = null;
    await inRequest(
      () => patchDivision(auth, adult.id, { age_max: 12 }),
      () => {
        droppedMidRequest = named.filter((key) => !redis.has(key));
        for (const key of named) redis.set(key, { cached: "re-baked Arun Kumar" });
      },
    );

    expect(droppedMidRequest, "premise: the first drop ran inside the request").toEqual(named);
    expect(named.filter((key) => redis.has(key)), "documents re-baked in the gap and never dropped again").toEqual([]);
  });

  it("an unrelated rename drops no public Redis document", async () => {
    const u16 = await division("U16 I2", 16);
    const kept = [`pub:v1:hub:${competitionId}`, `pub:v1:div:${u16.id}:entrants-v2`];
    redis.clear();
    for (const key of kept) redis.set(key, { cached: true });
    await inRequest(() => patchDivision(auth, u16.id, { name: "Under 16s" }));
    expect(kept.filter((key) => redis.has(key))).toEqual(kept);
  });
});
