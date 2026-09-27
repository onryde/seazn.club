// Public hub query perf T4 (2026-09-27): the division read's independent
// queries run together, and the five correlated `fixtures` subselects per
// fixture row became one lateral probe. PERF ONLY — the output must not move
// by a byte, row order included.
//
// So every loader here is diffed against its own pre-T4 body, frozen below
// from e5848d2f3 (`readPublicDivisionDetail` in public-site/data.ts,
// `embedDivisionData` in embed-data.ts). The frozen copies call today's
// helpers (`withCourtVenueNames`, `maskPublicEntrantNames`), which T4 did not
// change, so what differs between the two sides is exactly what T4 changed:
// the SQL and the order the reads run in.
//
// Over a realistic competition (`_public-loaders-scene.ts`): knockout feeders
// with winner AND loser edges, a final and a bronze with no next fixture, byes,
// a withdrawn entrant, a setup division and an empty one — and fixtures that
// tie on (round_no, seq_in_round) across two stages.
//
// Row order is compared exactly on the ORDER BY's key; rows that TIE on it are
// compared as a set. Their order was never fixed: when the pre-T4 statement
// walks the index they come back in physical row order (pinned below), and
// when it scans and sorts, in the sort's permutation — measured 2026-09-27,
// its own custom and generic plans returned this scene's ties in different
// orders, and postgres.js prepares it, so one connection could already flip
// between them. The first run of this file compared ties exactly and went
// green; a later run, on a fuller database, went red on a plan choice, not on
// a row T4 changed.
//
// The fan-out half pins the pool budget (12 connections a machine in prod):
// one division read may hold at most four reads in flight, and the hub rebuild,
// which already reads every division at once, reads each division one query at
// a time — its demand stays one connection per division.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

/** Peak number of tagged-template queries awaiting Postgres at once. */
const probe = vi.hoisted(() => ({ inFlight: 0, peak: 0 }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const counted = new Proxy(actual.sql, {
    apply(target, thisArg, args: unknown[]) {
      const query = Reflect.apply(target, thisArg, args) as PromiseLike<unknown>;
      const head = args[0];
      // `sql(ids)` / `sql(obj)` build fragments, not statements.
      if (!(Array.isArray(head) && "raw" in head)) return query;
      return (async () => {
        probe.inFlight += 1;
        probe.peak = Math.max(probe.peak, probe.inFlight);
        try {
          return await query;
        } finally {
          probe.inFlight -= 1;
        }
      })();
    },
  });
  return { ...actual, sql: counted };
});

import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { isoDateTime } from "@/lib/public-site";
import { embedDivisionData } from "@/server/embed-data";
import { resolveSponsors } from "@/server/usecases/sponsors";
import { loadCompetitionHub } from "../competition-hub";
import {
  getPublicCompetition,
  getPublicDivision,
  maskPublicEntrantNames,
  readPublicDivisionDetail,
  withCourtVenueNames,
  type PublicCompetition,
  type PublicDivision,
  type PublicEntrant,
  type PublicFixture,
  type PublicStage,
  type PublicStandings,
} from "../data";
import { seedLoadersScene, type LoadersScene } from "./_public-loaders-scene";

const HAS_DB = !!process.env.DATABASE_URL;

// ── Frozen pre-T4 bodies (e5848d2f3). The differential oracle; never call ──
// ── these from product code.                                              ──

const normalizeFixtureBefore = <T extends { scheduled_at: unknown }>(f: T): T => ({
  ...f,
  scheduled_at: isoDateTime(f.scheduled_at),
});
const normalizeStandingsBefore = (s: PublicStandings): PublicStandings => ({
  ...s,
  updated_at: isoDateTime(s.updated_at)!,
});

async function readPublicDivisionDetailBefore(division: PublicDivision) {
  // `rules`: main's per-stage match rules (bb6523248), which landed on this
  // read after the freeze; carried here so the diff is still T4's alone.
  const stages = await sql<PublicStage[]>`
    select id, division_id, seq, kind, name, status,
           qualify_count, qualify_per_group, next_stage_name, swiss_rounds, points_rule,
           has_rank_overrides,
           (select x.config->'rules' from stages x where x.id = public_stages_v.id) as rules
    from public_stages_v where division_id = ${division.id} order by seq`;
  const pools = await sql<{ id: string; stage_id: string; key: string; name: string }[]>`
    select p.id, p.stage_id, p.key, p.name
    from public_pools_v p
    join public_stages_v s on s.id = p.stage_id
    where s.division_id = ${division.id} order by p.key`;
  const rawFixtures = await sql<PublicFixture[]>`
    select id, division_id, stage_id, pool_id, round_no, seq_in_round,
           home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
           scheduled_at, venue, court_label,
           status, outcome, summary, last_seq,
           lane, is_final, third_place, conditional,
           (select x.ext_key from fixtures x where x.id = public_fixtures_v.id) as ext_key,
           (select x.winner_to_fixture from fixtures x where x.id = public_fixtures_v.id) as winner_to_fixture,
           (select x.winner_to_slot    from fixtures x where x.id = public_fixtures_v.id) as winner_to_slot,
           (select x.loser_to_fixture  from fixtures x where x.id = public_fixtures_v.id) as loser_to_fixture,
           (select x.loser_to_slot     from fixtures x where x.id = public_fixtures_v.id) as loser_to_slot
    from public_fixtures_v where division_id = ${division.id}
    order by round_no, seq_in_round`.then((rows) => rows.map(normalizeFixtureBefore));
  const fixtures = await withCourtVenueNames(rawFixtures);
  const standings = (
    await sql<PublicStandings[]>`
    select stage_id, pool_id, rows, updated_at
    from public_standings_v where division_id = ${division.id}`
  ).map(normalizeStandingsBefore);
  const rawEntrants = await sql<PublicEntrant[]>`
    select id, division_id, kind, display_name, seed, status, members,
           team_display, badge_url
    from public_entrants_v where division_id = ${division.id}
    order by seed nulls last, display_name`;
  const entrants = await maskPublicEntrantNames(rawEntrants, division);
  const [ss] = await sql<{ tz: string }[]>`
    select coalesce(ss.tz, o.timezone, 'UTC') as tz
    from divisions d
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations o on o.id = d.org_id
    where d.id = ${division.id}`;
  return { stages, pools, fixtures, standings, entrants, tz: ss?.tz ?? "UTC" };
}

const isoBefore = <T extends { scheduled_at: unknown }>(f: T): T => ({
  ...f,
  scheduled_at: f.scheduled_at ? new Date(f.scheduled_at as string).toISOString() : null,
});

async function embedDivisionDataBefore(divisionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(divisionId)) return { ok: false, reason: "not_found" } as const;
  const [division] = await sql<PublicDivision[]>`
    select d.id, d.competition_id, d.name, d.slug, d.description,
           d.sport_key, d.variant_key, d.status, d.module_version, d.tiebreakers,
           s.name as sport_name, 0 as entrant_count,
           dv.youth, dv.player_name_display, dv.config
    from public_divisions_v d
    left join sports s on s.key = d.sport_key
    join divisions dv on dv.id = d.id
    where d.id = ${divisionId}`;
  if (!division) return { ok: false, reason: "not_found" } as const;
  const [competition] = await sql<(PublicCompetition & { org_id: string })[]>`
    select id, org_id, name, slug, description, starts_on, ends_on, branding,
           status, visibility
    from public_competitions_v where id = ${division.competition_id}`;
  if (!competition) return { ok: false, reason: "not_found" } as const;
  if (!(await hasFeature(competition.org_id, "embeds.enabled", competition.id))) {
    return { ok: false, reason: "not_entitled" } as const;
  }
  const [org] = await sql<{ id: string; slug: string; name: string; default_locale: string }[]>`
    select id, slug, name, default_locale from organizations where id = ${competition.org_id}`;
  if (!org) return { ok: false, reason: "not_found" } as const;
  const [stages, pools, fixtures, standings, entrants, ssRows] = await Promise.all([
    sql<PublicStage[]>`
      select id, division_id, seq, kind, name, status,
             qualify_count, qualify_per_group, next_stage_name, swiss_rounds, points_rule,
             has_rank_overrides
      from public_stages_v where division_id = ${divisionId} order by seq`,
    sql<{ id: string; stage_id: string; key: string; name: string }[]>`
      select p.id, p.stage_id, p.key, p.name
      from public_pools_v p
      join public_stages_v s on s.id = p.stage_id
      where s.division_id = ${divisionId} order by p.key`,
    sql<PublicFixture[]>`
      select id, division_id, stage_id, pool_id, round_no, seq_in_round,
             home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
             scheduled_at, venue, court_label,
             status, outcome, summary, last_seq,
             lane, is_final, third_place, conditional,
             (select x.ext_key from fixtures x where x.id = public_fixtures_v.id) as ext_key,
             (select x.winner_to_fixture from fixtures x where x.id = public_fixtures_v.id) as winner_to_fixture,
             (select x.winner_to_slot    from fixtures x where x.id = public_fixtures_v.id) as winner_to_slot,
             (select x.loser_to_fixture  from fixtures x where x.id = public_fixtures_v.id) as loser_to_fixture,
             (select x.loser_to_slot     from fixtures x where x.id = public_fixtures_v.id) as loser_to_slot
      from public_fixtures_v where division_id = ${divisionId}
      order by round_no, seq_in_round`
      .then((rows) => rows.map(isoBefore))
      .then((rows) => withCourtVenueNames(rows)),
    sql<PublicStandings[]>`
      select stage_id, pool_id, rows, updated_at
      from public_standings_v where division_id = ${divisionId}`,
    sql<PublicEntrant[]>`
      select id, division_id, kind, display_name, seed, status, members, team_display, badge_url
      from public_entrants_v where division_id = ${divisionId}
      order by seed nulls last, display_name`.then((rows) => maskPublicEntrantNames(rows, division)),
    sql<{ tz: string }[]>`
      select coalesce(ss.tz, o.timezone, 'UTC') as tz
      from divisions d
      left join schedule_settings ss on ss.division_id = d.id
      left join organizations o on o.id = d.org_id
      where d.id = ${divisionId}`,
  ]);
  return {
    ok: true,
    data: {
      org, competition, division, stages, pools, fixtures, standings, entrants,
      sponsors: await resolveSponsors(org.id, competition.id),
      tz: ssRows[0]?.tz ?? "UTC",
    },
  } as const;
}

// ── The suite ─────────────────────────────────────────────────────────────

let scene: LoadersScene;
let divisions: Record<"cup" | "bracket" | "draft" | "empty", PublicDivision>;

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seedLoadersScene();
  const shell = await getPublicCompetition(scene.orgSlug, scene.compSlug);
  const bySlug = (slug: string) => shell!.divisions.find((d) => d.slug === slug)!;
  divisions = { cup: bySlug("cup"), bracket: bySlug("bracket"), draft: bySlug("draft"), empty: bySlug("empty") };
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** Identity, twice over: structural (types and `undefined` included) and
 *  serialised (key order included — the data cache stores JSON). */
function expectIdentical(after: unknown, before: unknown, label: string) {
  expect(after, label).toStrictEqual(before);
  expect(JSON.stringify(after), label).toBe(JSON.stringify(before));
}

type Keyed = { id: string; round_no: number; seq_in_round: number };
const orderKey = (f: Keyed) => `${f.round_no}.${f.seq_in_round}`;
/** Ties on the ORDER BY put in one fixed order (by id), everything else untouched. */
const settleTies = <D extends { fixtures: Keyed[] }>(doc: D): D => ({
  ...doc,
  fixtures: [...doc.fixtures].sort(
    (a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  ),
});
/** {@link expectIdentical} for a document carrying a fixture list: the list's
 *  key sequence exactly, and the whole document once ties are settled on both
 *  sides (see the header on why ties are a set). */
function expectIdenticalUpToTies<D extends { fixtures: Keyed[] }>(after: D, before: D, label: string) {
  expect(after.fixtures.map(orderKey), `${label}: ORDER BY key sequence`).toEqual(before.fixtures.map(orderKey));
  expectIdentical(settleTies(after), settleTies(before), label);
}

const SLUGS = ["cup", "bracket", "draft", "empty"] as const;

describe.skipIf(!HAS_DB)("readPublicDivisionDetail — identical to the pre-T4 read", () => {
  it("the scene holds what the replaced subselects produced (so the diff below is not vacuous)", async () => {
    const cup = await readPublicDivisionDetailBefore(divisions.cup);
    const bracket = await readPublicDivisionDetailBefore(divisions.bracket);
    const empty = await readPublicDivisionDetailBefore(divisions.empty);
    const draft = await readPublicDivisionDetailBefore(divisions.draft);
    // Feeders: winner AND loser edges, with their slots.
    expect(cup.fixtures.some((f) => f.winner_to_fixture && f.winner_to_slot === 2)).toBe(true);
    expect(cup.fixtures.some((f) => f.loser_to_fixture && f.loser_to_slot === 1)).toBe(true);
    // Fixtures with no next fixture (the final and the bronze).
    expect(cup.fixtures.filter((f) => f.stage_id === cup.stages[1]!.id && f.winner_to_fixture === null)).toHaveLength(2);
    // Every row carries the generator's id.
    expect(cup.fixtures.every((f) => typeof f.ext_key === "string")).toBe(true);
    // A tie on the ORDER BY across two stages.
    const keys = cup.fixtures.map((f) => `${f.round_no}.${f.seq_in_round}`);
    expect(new Set(keys).size).toBeLessThan(keys.length);
    // A bye, a withdrawn entrant, names on courts, and the setup redaction.
    expect(bracket.fixtures.some((f) => (f.away_slot_label as { key?: string } | null)?.key === "bracket.slot.bye")).toBe(true);
    expect(cup.entrants.some((e) => e.status === "withdrawn")).toBe(true);
    expect(cup.fixtures.some((f) => f.court_name !== null)).toBe(true);
    expect(draft.fixtures.length).toBeGreaterThan(0);
    expect(draft.fixtures.every((f) => f.court_name === null && f.scheduled_at === null)).toBe(true);
    // Masked members and a standings table ride along.
    expect(cup.entrants.some((e) => (e.members ?? []).length > 1)).toBe(true);
    expect(cup.standings.length).toBeGreaterThan(0);
    // The empty division is empty everywhere.
    expect([empty.stages, empty.pools, empty.fixtures, empty.standings, empty.entrants].map((a) => a.length)).toEqual([0, 0, 0, 0, 0]);
  });

  it("the pre-T4 fixtures statement leaves tied rows in PHYSICAL order when it walks the index (why ties are compared as a set)", async () => {
    // The statement verbatim from e5848d2f3, on the plan that walks the
    // (division_id, round_no, seq_in_round) index — forced with planner
    // switches so the proof does not depend on the table's statistics. A
    // btree keeps equal keys in heap-position order, so the ties come back in
    // `ctid` order: where Postgres happened to store the rows, which an update
    // or a vacuum moves, and which the query never states. (Its other plan,
    // scan and sort, gives a sort's permutation instead — measured 2026-09-27,
    // the statement's own custom and generic plans disagreed on this scene;
    // not pinned, because which plan runs is exactly what is not fixed.)
    const { walked, physical } = await sql.begin(async (tx) => {
      for (const s of ["enable_sort", "enable_bitmapscan", "enable_seqscan"]) await tx.unsafe(`set local ${s} = off`);
      const rows = await tx<Keyed[]>`
        select id, division_id, stage_id, pool_id, round_no, seq_in_round,
               home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
               scheduled_at, venue, court_label,
               status, outcome, summary, last_seq,
               lane, is_final, third_place, conditional,
               (select x.ext_key from fixtures x where x.id = public_fixtures_v.id) as ext_key,
               (select x.winner_to_fixture from fixtures x where x.id = public_fixtures_v.id) as winner_to_fixture,
               (select x.winner_to_slot    from fixtures x where x.id = public_fixtures_v.id) as winner_to_slot,
               (select x.loser_to_fixture  from fixtures x where x.id = public_fixtures_v.id) as loser_to_fixture,
               (select x.loser_to_slot     from fixtures x where x.id = public_fixtures_v.id) as loser_to_slot
        from public_fixtures_v where division_id = ${divisions.cup.id}
        order by round_no, seq_in_round`;
      const byPosition = await tx<{ id: string }[]>`
        select id from fixtures where division_id = ${divisions.cup.id} order by ctid`;
      return { walked: rows, physical: byPosition.map((r) => r.id) };
    });
    const ties = Object.values(Object.groupBy(walked, orderKey)).filter((group) => group!.length > 1);
    // Premise: the scene has ties to order (league round 1 against knockout round 1).
    expect(ties.length).toBeGreaterThan(0);
    for (const group of ties) {
      const ids = group!.map((f) => f.id);
      expect(ids).toEqual(physical.filter((id) => ids.includes(id)));
    }
  });

  for (const slug of SLUGS) {
    it(`${slug}: concurrent and sequential reads both equal the pre-T4 read (ties as a set)`, async () => {
      const before = await readPublicDivisionDetailBefore(divisions[slug]);
      expectIdenticalUpToTies(await readPublicDivisionDetail(divisions[slug]), before, `${slug} concurrent`);
      expectIdenticalUpToTies(await readPublicDivisionDetail(divisions[slug], { sequential: true }), before, `${slug} sequential`);
    });
  }

  it("getPublicDivision serves the same body under its shell", async () => {
    const shell = (await getPublicCompetition(scene.orgSlug, scene.compSlug))!;
    const before = await readPublicDivisionDetailBefore(divisions.cup);
    const after = await getPublicDivision(scene.orgSlug, scene.compSlug, "cup");
    expect(after).not.toBeNull();
    expectIdenticalUpToTies(
      after!,
      { org: shell.org, competition: shell.competition, division: divisions.cup, ...before },
      "getPublicDivision(cup)",
    );
  });
});

describe.skipIf(!HAS_DB)("embedDivisionData — identical to the pre-T4 embed read", () => {
  for (const slug of SLUGS) {
    it(`${slug}`, async () => {
      const before = await embedDivisionDataBefore(divisions[slug].id);
      // Premise: the embed is served (a not_entitled on both sides would agree vacuously).
      expect(before.ok).toBe(true);
      const after = await embedDivisionData(divisions[slug].id);
      if (!after.ok || !before.ok) throw new Error(`${slug}: embed not served`);
      expectIdenticalUpToTies(after.data, before.data, slug);
    });
  }
});

describe.skipIf(!HAS_DB)("division read fan-out stays inside the pool budget", () => {
  const peakOf = async (read: () => Promise<unknown>) => {
    probe.peak = 0;
    await read();
    return probe.peak;
  };

  it("one division read holds its four independent lanes in flight at once — never more; sequential holds one", async () => {
    // The pre-T4 read is the positive pair for "one at a time".
    expect(await peakOf(() => readPublicDivisionDetailBefore(divisions.cup))).toBe(1);
    expect(await peakOf(() => readPublicDivisionDetail(divisions.cup))).toBe(4);
    expect(await peakOf(() => readPublicDivisionDetail(divisions.cup, { sequential: true }))).toBe(1);
  });

  it("the Redis hub rebuild reads every division at once, each one query at a time: one connection per division plus the ban read", async () => {
    const shell = (await getPublicCompetition(scene.orgSlug, scene.compSlug))!;
    expect(shell.divisions).toHaveLength(4);
    const peak = await peakOf(() => loadCompetitionHub(scene.orgSlug, scene.compSlug, new Date(), { uncached: true }));
    expect(peak).toBeLessThanOrEqual(shell.divisions.length + 1);
    // The page path too: its division reads go through getPublicDivision.
    const pagePeak = await peakOf(() => loadCompetitionHub(scene.orgSlug, scene.compSlug, new Date()));
    expect(pagePeak).toBeLessThanOrEqual(shell.divisions.length + 1);
  });
});
