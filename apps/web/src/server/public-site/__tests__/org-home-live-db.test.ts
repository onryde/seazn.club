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
import { competitionChip } from "@/lib/public-site";
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
  /** The three-tier order (owner ruling 2026-09-17). See `seedOrdering`. */
  ordering: OrderingScene;
  /** An org with NOTHING in play and nothing marked live: the listing is the
   *  date order, untouched. */
  calm: CalmScene;
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

interface OrderingScene {
  orgSlug: string;
  /** Starts 2026-09-10 — the NEWEST. Status `published`, one division, 3
   *  fixtures, none in play. Tier 2 ("Upcoming"). */
  newIdleId: string;
  /** Starts 2026-07-01. Status `live` and NOTHING in play in a public division:
   *  scheduled fixtures in its public division, and an in-play fixture in an
   *  ARCHIVED one, which the chip does not count. Tier 1 ("On now"). */
  onNowId: string;
  /** Starts 2026-06-01. Status `published`, ONE fixture in play. Tier 0. */
  oldLiveId: string;
  /** Starts 2026-05-01. TWO fixtures in play — more than `oldLive`, so a sort
   *  by the count instead of by "any in play" puts it first. Tier 0. */
  olderLiveId: string;
  /** The fixture that makes `oldLive` live — the "match finishes" case moves it. */
  oldLiveFixtureId: string;
  /** Starts 2026-04-01, the OLDEST. Status `published`, an in-play fixture in an
   *  ARCHIVED division and scheduled fixtures in its public one — "in play" by
   *  a wrong reading of the fixtures, while its chip says "Upcoming". Tier 2. */
  decoyId: string;
}

interface CalmScene {
  orgSlug: string;
  /** starts 2026-10-01 */
  octId: string;
  /** starts 2026-09-01, created AFTER `septFirstId` */
  septSecondId: string;
  /** starts 2026-09-01, created first */
  septFirstId: string;
  /** no dates at all */
  undatedId: string;
}

let scene: Scene;

/** Seeding helpers bound to one org. */
function orgKit(orgId: string, suffix: string) {
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };

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

  return { competition, division, play };
}

async function insertOrg(label: string, suffix: string) {
  const slug = `org-live-${label}-${suffix}`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${`Org Live ${label} ${suffix}`}, ${slug})
    returning id`;
  // Five-plus competitions exceed the community active cap.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${id}, 'competitions.max_active', null, 'test')`;
  return { id, slug };
}

/**
 * The three-tier order. Date order (starts_on desc) would read
 *   newIdle, onNow, oldLive, olderLive, decoy.
 * Three tiers read
 *   oldLive, olderLive | onNow | newIdle, decoy
 * — the two with a match in play lifted in their own date order, the one marked
 * live with nothing in play next, ABOVE the newer idle one, and the decoy left
 * at the bottom because its chip counts 0 and says "Upcoming". Each tier
 * boundary is an ordering differential: at both, the older row is above.
 */
async function seedOrdering(suffix: string): Promise<OrderingScene> {
  const org = await insertOrg("order", suffix);
  const { competition, division, play } = orgKit(org.id, suffix);

  const newIdleId = await competition("New Idle Cup", "public", "2026-09-10");
  await division(newIdleId, "new-idle", 3);
  await sql`update competitions set status = 'published' where id = ${newIdleId}`;

  const onNowId = await competition("On Now Cup", "public", "2026-07-01");
  await division(onNowId, "on-now-open", 3);
  const onNowArchived = await division(onNowId, "on-now-old", 2);
  await play(onNowArchived.fixtureIds[0]!);
  await sql`update divisions set archived_at = now() where id = ${onNowArchived.divisionId}`;
  await sql`update competitions set status = 'live' where id = ${onNowId}`;

  const oldLiveId = await competition("Old Live Cup", "public", "2026-06-01");
  const oldLive = await division(oldLiveId, "old-live", 2);
  await play(oldLive.fixtureIds[0]!);
  await sql`update competitions set status = 'published' where id = ${oldLiveId}`;

  const olderLiveId = await competition("Older Live Cup", "public", "2026-05-01");
  const olderLive = await division(olderLiveId, "older-live", 4);
  await play(olderLive.fixtureIds[0]!);
  await play(olderLive.fixtureIds[1]!);

  const decoyId = await competition("Decoy Cup", "public", "2026-04-01");
  await division(decoyId, "decoy-open", 3);
  const decoyArchived = await division(decoyId, "decoy-old", 2);
  await play(decoyArchived.fixtureIds[0]!);
  await sql`update divisions set archived_at = now() where id = ${decoyArchived.divisionId}`;
  await sql`update competitions set status = 'published' where id = ${decoyId}`;

  return {
    orgSlug: org.slug,
    newIdleId,
    onNowId,
    oldLiveId,
    olderLiveId,
    oldLiveFixtureId: oldLive.fixtureIds[0]!,
    decoyId,
  };
}

async function seedCalm(suffix: string): Promise<CalmScene> {
  const org = await insertOrg("calm", suffix);
  const { competition, division } = orgKit(org.id, suffix);
  const septFirstId = await competition("Sept First Cup", "public", "2026-09-01");
  const undatedId = await competition("Undated Cup", "public", "2026-01-01");
  await sql`update competitions set starts_on = null, ends_on = null where id = ${undatedId}`;
  const octId = await competition("Oct Cup", "public", "2026-10-01");
  const septSecondId = await competition("Sept Second Cup", "public", "2026-09-01");
  // Fixtures exist, none in play: "calm" is a count of 0, not an absence.
  await division(septFirstId, "calm", 3);
  return { orgSlug: org.slug, octId, septSecondId, septFirstId, undatedId };
}

async function seed(): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  const empty = await insertOrg("empty", suffix);
  const org = await insertOrg("main", suffix);

  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;

  const { competition, division, play } = orgKit(org.id, suffix);

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

  return {
    emptyOrgSlug: empty.slug,
    orgSlug: org.slug,
    ordering: await seedOrdering(suffix),
    calm: await seedCalm(suffix),
    mainId,
    nextDoorId,
    quietId,
    unlistedId,
    privateId,
  };
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
    // still in the page's order (in play first, then starts_on descending —
    // main and next door are both in play, so here the two orders agree; the
    // ordering describe below is where they differ).
    expect(ids).toEqual([scene.mainId, scene.nextDoorId, scene.quietId]);
  });
});

// Owner ruling 2026-09-17: the org home lists competitions in THREE tiers, each
// read off the chip on the card — a match in play ("{count} live now"), then
// marked live with nothing in play ("On now"), then the rest. Within each tier
// the date order stands. The tier is `orgHomeTier` (lib/public-site.ts), built
// on the chip's own predicates, never a second reading of the status or the
// count. The poll carries the same order, and the island sorts its cards with
// the same function after every poll (org-live-chips.tsx).
describe.skipIf(!HAS_DB)("listOrgHomeCompetitions — three tiers: in play, then 'On now', then the rest", () => {
  const pageIds = async (slug: string) => (await getPublicOrg(slug))!.competitions.map((c) => c.id);
  const pollIds = async (slug: string) => (await publicOrgLive(slug)).competitions.map((c) => c.id);
  const THREE_TIERS = (o: OrderingScene) => [o.oldLiveId, o.olderLiveId, o.onNowId, o.newIdleId, o.decoyId];

  it("EMPTY first: an org with nothing in play and nothing marked live keeps the date order exactly (starts_on desc, undated last, newer row breaks a tie)", async () => {
    const { calm } = scene;
    const data = (await getPublicOrg(calm.orgSlug))!;
    expect(data.competitions.every((c) => c.in_play === 0), "premise: nothing in play").toBe(true);
    expect(data.competitions.every((c) => c.status !== "live"), "premise: nothing marked live").toBe(true);
    const expected = [calm.octId, calm.septSecondId, calm.septFirstId, calm.undatedId];
    expect(data.competitions.map((c) => c.id)).toEqual(expected);
    expect(await pollIds(calm.orgSlug)).toEqual(expected);
  });

  it("the whole list: in play (by date), then 'On now', then the rest (by date) — against a date order that differs at every tier", async () => {
    const o = scene.ordering;
    // Date order alone would be [newIdle, onNow, oldLive, olderLive, decoy].
    expect(await pageIds(o.orgSlug)).toEqual(THREE_TIERS(o));
  });

  it("tier 1 | tier 2 boundary: an OLDER competition with a match in play is above a NEWER one marked live with nothing in play", async () => {
    const o = scene.ordering;
    const ids = await pageIds(o.orgSlug);
    expect(ids.indexOf(o.oldLiveId)).toBeLessThan(ids.indexOf(o.onNowId));
    expect(ids.indexOf(o.olderLiveId)).toBeLessThan(ids.indexOf(o.onNowId));
  });

  it("tier 2 | tier 3 boundary: an OLDER competition marked live with nothing in play ('On now') is above a NEWER idle one", async () => {
    const o = scene.ordering;
    const ids = await pageIds(o.orgSlug);
    expect(ids.indexOf(o.onNowId)).toBeLessThan(ids.indexOf(o.newIdleId));
  });

  it("each row's tier is its chip: count > 0, else 'On now', else neither — an archived division's live match counts for nothing", async () => {
    const o = scene.ordering;
    const rows = (await getPublicOrg(o.orgSlug))!.competitions;
    expect(rows.map((c) => [c.id, c.in_play > 0, competitionChip(c.status, c.in_play)])).toEqual([
      [o.oldLiveId, true, "on-now"],
      [o.olderLiveId, true, "on-now"],
      [o.onNowId, false, "on-now"],
      [o.newIdleId, false, "upcoming"],
      [o.decoyId, false, "upcoming"],
    ]);
    const onNow = rows.find((c) => c.id === o.onNowId)!;
    expect(onNow.status, "premise: 'On now' is the STATUS").toBe("live");
    expect(onNow.in_play, "premise: its archived division's live match is not counted").toBe(0);
    expect(rows.find((c) => c.id === o.decoyId)!.in_play).toBe(0);
    // The in-play ones are ordered by date, not by how many are in play:
    // `olderLive` has MORE matches in play and is still second.
    const count = counts(rows);
    expect(count[o.olderLiveId]).toBeGreaterThan(count[o.oldLiveId]!);
  });

  it("the poll lists the competitions in the page's order", async () => {
    const o = scene.ordering;
    const live = await publicOrgLive(o.orgSlug);
    expect(live.competitions.map((c) => c.id)).toEqual(THREE_TIERS(o));
    expect(live.competitions.map((c) => c.id)).toEqual(await pageIds(o.orgSlug));
  });

  it("a match FINISHING drops its competition past the 'On now' one, back into the date order of the rest, on the page and in the poll", async () => {
    const o = scene.ordering;
    await sql`update fixtures set status = 'decided' where id = ${o.oldLiveFixtureId}`;
    try {
      const expected = [o.olderLiveId, o.onNowId, o.newIdleId, o.oldLiveId, o.decoyId];
      expect(await pageIds(o.orgSlug)).toEqual(expected);
      expect(await pollIds(o.orgSlug)).toEqual(expected);
    } finally {
      await sql`update fixtures set status = 'in_play' where id = ${o.oldLiveFixtureId}`;
    }
    // …and starting again lifts it back: the scene is restored for its siblings.
    expect(await pageIds(o.orgSlug)).toEqual(THREE_TIERS(o));
  });

  it("marking the 'On now' competition published again drops it into the date order of the rest, on the page and in the poll", async () => {
    const o = scene.ordering;
    await sql`update competitions set status = 'published' where id = ${o.onNowId}`;
    try {
      const expected = [o.oldLiveId, o.olderLiveId, o.newIdleId, o.onNowId, o.decoyId];
      expect(await pageIds(o.orgSlug)).toEqual(expected);
      expect(await pollIds(o.orgSlug)).toEqual(expected);
    } finally {
      await sql`update competitions set status = 'live' where id = ${o.onNowId}`;
    }
    expect(await pageIds(o.orgSlug)).toEqual(THREE_TIERS(o));
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
