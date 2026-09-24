// #850 — a round-robin REST bye scores nothing, through every scoring reader,
// on REAL rows the REAL generator wrote.
//
// OWNER RULING (2026-09-23, _INDEX.md "Issue 850"): the league/group bye row
// awards no points and is excluded from standings, qualification, player match
// counts and public player matches; Swiss and knockout bye scoring is
// unchanged. Every reader below is driven through its real producer
// (`generateStageFixtures` + `scoreEvent`) and real consumer — no hand-built
// outcome objects (_INDEX.md "Standing warning") — and every scene carries its
// Swiss twin, where the SAME kind of row is a win: a gate that ignored the
// stage kind cannot satisfy both halves. Point values come from the division's
// own GENERIC_CONFIG, the config the fold reads.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `unstable_cache` has no incrementalCache outside a real request.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import type { StandingsRow } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import { isOneSidedAwardBye } from "@/lib/fixture-bye";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { recomputeStandings } from "@/server/engine-db";
import { readPlayerMatchSeeds } from "@/server/public-site/public-player-matches";
import type { AuthCtx } from "@/server/api-v1/auth";
import { listCompetitionCardStats, listDivisionCardStats } from "../card-stats";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { countMatchesByDivision } from "../player-stats";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const WIN = GENERIC_CONFIG.points.w;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Scene {
  auth: AuthCtx;
  orgSlug: string;
  competitionId: string;
  compSlug: string;
  divisionId: string;
  stageId: string;
  /** entrant id → the one person rostered on it */
  personOf: Map<string, string>;
}

/** A PUBLIC competition (so the public player-matches read sees it), one
 *  generic division, `n` individual entrants each with one rostered person. */
async function scene(kind: "league" | "swiss", n: number): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `rrb-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"RRB " + suffix}, ${orgSlug}) returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "RR bye " + suffix,
    visibility: "private",
    branding: {},
  });
  // Moved after create: createCompetition writes a public competition over the
  // plan cap as private, which would hide it for the wrong reason.
  await sql`update competitions set visibility = 'public' where id = ${comp.id}`;
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + suffix,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const persons: string[] = [];
  for (let i = 0; i < n; i++) {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, dob, gender, consent)
      values (${orgId}, ${`P${i + 1} ${suffix}`}, '2000-01-01', 'f', ${sql.json({ public_name: true })})
      returning id`;
    persons.push(id);
  }
  const entrants = await createEntrants(
    auth,
    division.id,
    persons.map((personId, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [{ person_id: personId, squad_number: null, default_position_key: null, is_captain: false, roles: [] }],
    })) as never,
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind,
    name: kind === "league" ? "League" : "Swiss",
    config: kind === "swiss" ? { rounds: 3 } : {},
    progression: null,
  });
  if (kind === "league") {
    await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, division.id);
  } else {
    // Started first, one Generate mints the shells AND seats round 1 with its
    // bye (the order qualification-view-db.test.ts's rig uses).
    await startDivision(auth, division.id);
    await generateStageFixtures(auth, stage!.id);
  }
  const [{ slug: compSlug }] = await sql<{ slug: string }[]>`select slug from competitions where id = ${comp.id}`;
  return {
    auth,
    orgSlug,
    competitionId: comp.id,
    compSlug,
    divisionId: division.id,
    stageId: stage!.id,
    personOf: new Map(entrants.map((e, i) => [e.id, persons[i]!])),
  };
}

interface Fx {
  id: string;
  round_no: number;
  status: string;
  outcome: unknown;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}
const fixturesOf = (s: Scene) => sql<Fx[]>`
  select id, round_no, status, outcome, home_entrant_id, away_entrant_id from fixtures
  where stage_id = ${s.stageId} order by round_no, seq_in_round`;

/** Decide every seated, unplayed board of `round` (every round when omitted):
 *  home wins 3–1. */
async function play(s: Scene, round?: number): Promise<void> {
  for (const f of await fixturesOf(s)) {
    if (round !== undefined && f.round_no !== round) continue;
    if (f.status !== "scheduled" || !f.home_entrant_id || !f.away_entrant_id) continue;
    await scoreEvent(s.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(s.auth, f.id, { expected_seq: 1, type: "generic.result", payload: { p1Score: 3, p2Score: 1 } });
  }
}

async function byeHolder(s: Scene, round: number): Promise<string> {
  const bye = (await fixturesOf(s)).find((f) => f.round_no === round && isOneSidedAwardBye(f));
  expect(bye, `the premise: round ${round} has a real bye row`).toBeDefined();
  return (bye!.home_entrant_id ?? bye!.away_entrant_id)!;
}

const rowOf = (rows: readonly StandingsRow[], id: string) => rows.find((r) => r.entrantId === id);

/** A user who has claimed `personId` — the `/me` career count's owner. */
async function claim(personId: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`rrb-${randomUUID().slice(0, 8)}@test.local`}, 'Claimer', true) returning id`;
  await sql`update persons set user_id = ${id} where id = ${personId}`;
  return id;
}

async function divisionCard(s: Scene): Promise<{ played: number; total: number }> {
  const card = (await listDivisionCardStats(s.auth, s.competitionId)).get(s.divisionId);
  expect(card).toBeDefined();
  return { played: card!.played, total: card!.total };
}

/** The competition list's card — its own SQL, counted over every division. */
async function competitionCard(s: Scene): Promise<{ played: number; total: number }> {
  const card = (await listCompetitionCardStats(s.auth)).get(s.competitionId);
  expect(card).toBeDefined();
  return { played: card!.played, total: card!.total };
}

describe.skipIf(!HAS_DB)("#850 standings — a rest bye is not in the table", () => {
  it("after round 1 the league's bye holder has played nothing and has no points; Swiss's has one win (regression pair)", async () => {
    const league = await scene("league", 5);
    await play(league, 1);
    const rested = await byeHolder(league, 1);
    const rows = await recomputeStandings(league.auth.orgId, league.stageId);
    const r = rowOf(rows, rested);
    expect(r, "the bye holder is still on the table").toBeDefined();
    expect(r).toMatchObject({ played: 0, won: 0, drawn: 0, lost: 0, points: 0 });
    // Everyone else played exactly their one board.
    for (const other of rows.filter((x) => x.entrantId !== rested)) expect(other.played).toBe(1);

    // The Swiss twin: the SAME row shape (forfeited, one seat, award) is a win.
    const swiss = await scene("swiss", 5);
    const sat = await byeHolder(swiss, 1);
    const swissRows = await recomputeStandings(swiss.auth.orgId, swiss.stageId);
    expect(rowOf(swissRows, sat)).toMatchObject({ played: 1, won: 1, points: WIN });
  });

  it("a full league of five: every entrant played 4 (not 5), and the table is byte-identical with the bye rows deleted", async () => {
    const s = await scene("league", 5);
    await play(s);
    const withByes = await recomputeStandings(s.auth.orgId, s.stageId);
    expect(withByes).toHaveLength(5);
    for (const r of withByes) expect(r.played, r.entrantId).toBe(4);
    // Three points per decided match, ten matches — and nothing for five byes.
    expect(withByes.reduce((sum, r) => sum + r.points, 0)).toBe(10 * WIN);

    // The strongest form of "excluded": the table does not change when the
    // rows are not there at all (the pre-#850 world).
    const deleted = await sql`delete from fixtures where stage_id = ${s.stageId} and ext_key like 'rr-r%-bye' returning id`;
    expect(deleted).toHaveLength(5);
    const withoutByes = await recomputeStandings(s.auth.orgId, s.stageId);
    expect(withByes).toEqual(withoutByes);
  });
});

describe.skipIf(!HAS_DB)("#850 desk card stats — played/total count matches, never a bye", () => {
  it("a league of five reads 0 of 10 at generation, 2 of 10 after round 1, 10 of 10 at the end", async () => {
    const s = await scene("league", 5);
    // The premise: five bye rows exist and are settled from the start.
    expect((await fixturesOf(s)).filter(isOneSidedAwardBye)).toHaveLength(5);
    expect(await divisionCard(s)).toEqual({ played: 0, total: 10 });
    expect(await competitionCard(s)).toEqual({ played: 0, total: 10 });
    await play(s, 1);
    expect(await divisionCard(s)).toEqual({ played: 2, total: 10 });
    expect(await competitionCard(s)).toEqual({ played: 2, total: 10 });
    await play(s);
    expect(await divisionCard(s)).toEqual({ played: 10, total: 10 });
    expect(await competitionCard(s)).toEqual({ played: 10, total: 10 });
  });

  it("Swiss is unchanged: its seated bye counts as played the moment round 1 is paired", async () => {
    const s = await scene("swiss", 5);
    const total = (await fixturesOf(s)).filter((f) => f.status !== "cancelled").length;
    expect(await divisionCard(s)).toEqual({ played: 1, total });
    expect(await competitionCard(s)).toEqual({ played: 1, total });
  });
});

describe.skipIf(!HAS_DB)("#850 player match counts and public player matches", () => {
  it("the league bye holder's person has 4 matches, not 5, and no line for the bye", async () => {
    const s = await scene("league", 5);
    await play(s);
    const rested = await byeHolder(s, 1);
    const personId = s.personOf.get(rested)!;

    const counted = await countMatchesByDivision(sql, { by: "person", personId }, [s.divisionId]);
    expect(counted.get(s.divisionId)).toBe(4);
    // The signed-in player's own view (/me) counts through the OTHER branch —
    // by the user who claimed the person — and must agree.
    const userId = await claim(personId);
    const mine = await countMatchesByDivision(sql, { by: "claimedPersons", userId }, [s.divisionId]);
    expect(mine.get(s.divisionId)).toBe(4);

    const seeds = await readPlayerMatchSeeds(sql, {
      personId,
      competitionId: s.competitionId,
      orgSlug: s.orgSlug,
      compSlug: s.compSlug,
      locale: "en",
    });
    expect(seeds).toHaveLength(4);
    const byeIds = new Set((await fixturesOf(s)).filter(isOneSidedAwardBye).map((f) => f.id));
    expect(seeds.some((x) => byeIds.has(x.fixtureId))).toBe(false);
    // Every line is a real match against a real, named opponent.
    expect(seeds.every((x) => x.opponentName !== "—")).toBe(true);
  });

  it("Swiss is unchanged: the bye holder's person has the bye as a match, a win (regression pair)", async () => {
    const s = await scene("swiss", 5);
    const sat = await byeHolder(s, 1);
    const personId = s.personOf.get(sat)!;
    const counted = await countMatchesByDivision(sql, { by: "person", personId }, [s.divisionId]);
    expect(counted.get(s.divisionId)).toBe(1);
    const mine = await countMatchesByDivision(sql, { by: "claimedPersons", userId: await claim(personId) }, [s.divisionId]);
    expect(mine.get(s.divisionId)).toBe(1);
    const seeds = await readPlayerMatchSeeds(sql, {
      personId,
      competitionId: s.competitionId,
      orgSlug: s.orgSlug,
      compSlug: s.compSlug,
      locale: "en",
    });
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.result).toBe("won");
  });
});
