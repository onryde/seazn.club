// Spectator W2, Task 15 — the org home's in-play count, against real Postgres.
//
// The org home's chip is now derived from live fixtures (`competitionChip(
// status, in_play)`), and two readers carry that count: `getPublicOrg` for the
// page's first paint and `publicOrgLive` for the island's poll. Both answers
// come from ONE query (`listOrgHomeCompetitions`), so what this file proves is
// that the query counts the right fixtures and lists the right competitions:
//
//   * only `in_play` fixtures — a scheduled one in the same division is not;
//   * only fixtures in PUBLIC divisions — `public_fixtures_v` does NOT hide an
//     archived division's fixtures (only `public_divisions_v` does, V262/V268),
//     so a count joined to the wrong view would light the chip for a division
//     the public page does not even show;
//   * only fixtures of THAT competition — a live match next door is not;
//   * only the competitions the org home LISTS — `public_competitions_v`
//     admits `unlisted` too, and the landing list is `visibility = 'public'`;
//     a private one is not in the view at all.
//
// Real Postgres required; skipped without DATABASE_URL, same convention and
// the same seeding usecases as `competition-hub-db.test.ts`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Passthrough, never memoising: every read below must hit the database.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
// The usecase's Redis cache-aside is not what this file is about (the route's
// cache test owns it), and a configured REDIS_URL must not serve a stale entry
// here or be written to by a test.
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => {}),
}));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { publicOrgLive } from "@/server/usecases/public";
import { getPublicOrg } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface Scene {
  emptyOrgSlug: string;
  orgSlug: string;
  /** Public. Division `open`: 3 fixtures, ONE in play. Division `old`:
   *  archived, 1 fixture, in play. Expected count: 1. */
  mainId: string;
  /** Public. One division, 1 fixture, in play. Expected count: 1. */
  nextDoorId: string;
  /** Public. One division, 3 fixtures, none in play. Expected count: 0. */
  quietId: string;
  /** Unlisted, with a match in play — readable by link, not LISTED. */
  unlistedId: string;
  /** Private, with a match in play — not public at all. */
  privateId: string;
}

let scene: Scene;

async function seed(): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  const insertOrg = async (label: string) => {
    const slug = `org-live-${label}-${suffix}`;
    const [{ id }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${`Org Live ${label} ${suffix}`}, ${slug})
      returning id`;
    return { id, slug };
  };
  const empty = await insertOrg("empty");
  const org = await insertOrg("main");

  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  // Five competitions exceed the community active cap.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${org.id}, 'competitions.max_active', null, 'test')`;

  const auth: AuthCtx = { orgId: org.id, via: "session", userId: null, role: "owner", keyId: null };

  // Created PRIVATE and moved to the visibility under test with one UPDATE:
  // `createCompetition` silently degrades an over-cap public create to
  // private, which would let a visibility assertion pass for the wrong reason.
  const competition = async (name: string, visibility: "public" | "unlisted" | "private", startsOn: string) => {
    const row = await createCompetition(auth, {
      name: `${name} ${suffix}`,
      visibility: "private",
      branding: {},
      starts_on: startsOn,
      ends_on: "2030-12-31",
    });
    await sql`update competitions set visibility = ${visibility} where id = ${row.id}`;
    return row.id;
  };

  /** A league division with `teams` entrants, and its generated fixture ids. */
  const division = async (competitionId: string, slug: string, teams: number) => {
    const d = await createDivision(auth, competitionId, {
      name: slug,
      slug,
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
    });
    await createEntrants(
      auth,
      d.id,
      Array.from({ length: teams }, (_, i) => ({
        kind: "team" as const,
        display_name: `${slug} team ${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "League", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    return { divisionId: d.id, fixtureIds: fixtures.map((f) => f.id) };
  };
  const play = (fixtureId: string) => sql`update fixtures set status = 'in_play' where id = ${fixtureId}`;

  const mainId = await competition("Main Cup", "public", "2026-09-01");
  const open = await division(mainId, "open", 3);
  expect(open.fixtureIds.length, "the seed needs a second, NOT-in-play fixture beside the live one").toBeGreaterThan(1);
  await play(open.fixtureIds[0]!);
  const old = await division(mainId, "old", 2);
  await play(old.fixtureIds[0]!);
  await sql`update divisions set archived_at = now() where id = ${old.divisionId}`;

  const nextDoorId = await competition("Next Door Cup", "public", "2026-08-01");
  await play((await division(nextDoorId, "nd", 2)).fixtureIds[0]!);

  const quietId = await competition("Quiet Cup", "public", "2026-07-01");
  await division(quietId, "quiet", 3);

  const unlistedId = await competition("Unlisted Cup", "unlisted", "2026-06-01");
  await play((await division(unlistedId, "ul", 2)).fixtureIds[0]!);

  const privateId = await competition("Private Cup", "private", "2026-05-01");
  await play((await division(privateId, "pv", 2)).fixtureIds[0]!);

  return { emptyOrgSlug: empty.slug, orgSlug: org.slug, mainId, nextDoorId, quietId, unlistedId, privateId };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const counts = (rows: { id: string; in_play: number }[]) =>
  Object.fromEntries(rows.map((r) => [r.id, r.in_play]));

describe.skipIf(!HAS_DB)("getPublicOrg — each listed competition's in-play count", () => {
  it("EMPTY first: an org with no competitions lists none, and its poll says none", async () => {
    const data = await getPublicOrg(scene.emptyOrgSlug);
    expect(data?.competitions).toEqual([]);
    expect(await publicOrgLive(scene.emptyOrgSlug)).toEqual({ competitions: [] });
  });

  it("a competition with fixtures and none in play counts 0 (not absent, not null)", async () => {
    const data = (await getPublicOrg(scene.orgSlug))!;
    const quiet = data.competitions.find((c) => c.id === scene.quietId);
    expect(quiet?.in_play).toBe(0);
  });

  it("counts only the in-play fixtures of PUBLIC divisions of THAT competition", async () => {
    const data = (await getPublicOrg(scene.orgSlug))!;
    // Main: one live in `open` (+2 scheduled there), one live in the archived
    // `old` division, and one live in Next Door. Exactly 1 is the answer only
    // a query honouring all three rules gives: counting the archived division
    // says 2, counting scheduled fixtures says 3+, and dropping the
    // competition join says at least 2.
    expect(counts(data.competitions)).toEqual({
      [scene.mainId]: 1,
      [scene.nextDoorId]: 1,
      [scene.quietId]: 0,
    });
    for (const c of data.competitions) expect(typeof c.in_play, c.id).toBe("number");
  });

  it("lists exactly the org's PUBLIC competitions — the unlisted and private ones, both with a live match, are absent", async () => {
    const data = (await getPublicOrg(scene.orgSlug))!;
    const ids = data.competitions.map((c) => c.id);
    expect(ids).not.toContain(scene.unlistedId);
    expect(ids).not.toContain(scene.privateId);
    // Positive pair: the listing is not empty for some other reason, and it is
    // still in the page's order (starts_on descending).
    expect(ids).toEqual([scene.mainId, scene.nextDoorId, scene.quietId]);
  });
});

describe.skipIf(!HAS_DB)("publicOrgLive — the poll carries the same list and the same counts", () => {
  it("returns {id, status, in_play} for exactly the competitions the page lists, with the page's counts", async () => {
    const page = (await getPublicOrg(scene.orgSlug))!;
    const live = await publicOrgLive(scene.orgSlug);
    expect(live.competitions).toEqual(
      page.competitions.map((c) => ({ id: c.id, status: c.status, in_play: c.in_play })),
    );
    // Not two empty lists agreeing.
    expect(counts(live.competitions)[scene.mainId]).toBe(1);
  });

  it("a private or unlisted competition is absent from the poll", async () => {
    const ids = (await publicOrgLive(scene.orgSlug)).competitions.map((c) => c.id);
    expect(ids).not.toContain(scene.privateId);
    expect(ids).not.toContain(scene.unlistedId);
    expect(ids).toContain(scene.nextDoorId);
  });

  it("an unknown org is a 404, never an empty 200", async () => {
    const err = await publicOrgLive(`no-such-org-${randomUUID()}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
  });
});
