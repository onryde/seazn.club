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
import { createDivision, patchDivision } from "../divisions";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

type FlushCall = { tags: string[]; durations: { expire?: number } | undefined };

/** One route-handler request: the handler inside both storages, then ONE
 *  flush as soon as it resolves (app-route/module.js). */
async function inRequest<T>(handler: () => Promise<T>): Promise<{ result: T; calls: FlushCall[] }> {
  const calls: FlushCall[] = [];
  const workStore = {
    route: "/api/v1/divisions/[id]",
    page: "/api/v1/divisions/[id]/route",
    incrementalCache: {
      revalidateTag: (tags: string | string[], durations?: { expire?: number }) => {
        calls.push({ tags: typeof tags === "string" ? [tags] : [...tags], durations });
      },
    },
    cacheLifeProfiles: defaultConfig.cacheLife,
  } as unknown as WorkStore;
  const requestStore = { type: "request", phase: "action" } as unknown as RequestStore;
  return workAsyncStorage.run(workStore, async () => {
    const result = await workUnitAsyncStorage.run(requestStore, handler);
    const flush = executeRevalidates(workStore);
    if (flush !== false) await flush;
    return { result, calls };
  });
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
});
