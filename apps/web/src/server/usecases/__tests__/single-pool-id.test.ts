// W5 app PR A, Task 3 (X-BD-7; RB5-E5, P3) — a one-pool group stage writes its pool id and behaves as a league, driven through the
// real usecases on a real database: the stage by `createStages` + `generateStageFixtures`, the result by the real scoring path
// (`playToDecided`), the readers by the very functions the news drafts and the public pages call.
//
// Main wrote `pool_id = null` on every line of a group with ONE pool and no `pools` row (`generate-tx.ts` only materialised pool
// rows when `poolCount > 1`), so a group of one was the one table stage the pool machinery could not see: Add match refused it
// ("both entrants must be in the same pool"), and a pool-aware reader found no pool A. Now pool A exists and every line carries it,
// and every reader that asked for "the table with no pool" (`pool_id is null`) still finds a one-pool group's single table.
//
// Expected values: a group of n plays n(n-1)/2 matches (rulebook), a league keeps NO pool (control), the winner of a decided match
// is the stored outcome's. Never the code under test's answer.
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql, withTenant } from "@/lib/db";
import { assembleDigestStandings, assembleRecapEnrichment, draftPostsForDecidedFixture, type FixtureCtx } from "../org-posts";
import { generateStageFixtures, getStandings } from "../stages";
import { addFixture } from "../stages";
import { createEntrants } from "../entrants";
import { listDivisionFixturesForBoard } from "../fixtures";
import { startDivision } from "../schedule";
import { playToDecided } from "./_quick-match-probe";
import { BADMINTON, FOOTBALL, lineBetween, rig, rowsOf, type Rig } from "./_w5-t3-rig";

vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

interface PoolRow {
  id: string;
  key: string;
  name: string;
}
const poolsOf = (stageId: string) => sql<PoolRow[]>`select id, key, name from pools where stage_id = ${stageId} order by key`;

describe.skipIf(!HAS_DB)("X-BD-7 a one-pool group stage writes pool_id on every fixture", () => {
  // differential: today null — `generate-tx.ts` materialised pool rows only when `poolCount > 1`
  for (const sport of [BADMINTON, FOOTBALL]) {
    for (const poolsConfig of ["no pools key", "pools.count 1"] as const) {
      it(`X-BD-7 a one-pool group stage writes pool_id on every fixture (${sport.key}, ${poolsConfig})`, async () => {
        const r = await rig({ n: 4, kind: "group", sport, ...(poolsConfig === "pools.count 1" ? { pools: 1 } : {}) });
        const pools = await poolsOf(r.stageId);
        expect(pools.map((p) => [p.key, p.name]), "exactly one pool row: A").toEqual([["A", "Pool A"]]);
        const rows = await rowsOf(r.stageId);
        expect(rows, "premise: a group of 4 plays 6 matches (n(n-1)/2)").toHaveLength(6);
        expect(new Set(rows.map((x) => x.pool_id)), "every line carries pool A's id").toEqual(new Set([pools[0]!.id]));
        for (const x of rows) expect(x.ext_key, "a pooled line's key carries its pool, as every pool's does").toMatch(/^pA-rr-r\d+-c\d+-L1$/);
      });
    }
  }

  it("X-BD-7 pin: a league keeps NO pool and no pool row (a league is not a group)", async () => {
    const r = await rig({ n: 4, kind: "league" });
    expect(await poolsOf(r.stageId)).toHaveLength(0);
    const rows = await rowsOf(r.stageId);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((x) => x.pool_id))).toEqual(new Set([null]));
  });

  it("X-BD-7 pin: a two-pool group is unchanged: two pool rows, every line in its own pool", async () => {
    const r = await rig({ n: 4, kind: "group", pools: 2 });
    const pools = await poolsOf(r.stageId);
    expect(pools.map((p) => p.key)).toEqual(["A", "B"]);
    const rows = await rowsOf(r.stageId);
    expect(rows).toHaveLength(2); // two pools of two: one match each
    expect(new Set(rows.map((x) => x.pool_id))).toEqual(new Set(pools.map((p) => p.id)));
  });

  it("X-BD-7 the pool survives the sequence: Generate again is a no-op; a roster that grows keeps pool A on every line, patched or redrawn", async () => {
    const r = await rig({ n: 4, kind: "group" });
    const [pool] = await poolsOf(r.stageId);
    const before = await rowsOf(r.stageId);
    const again = await generateStageFixtures(r.auth, r.stageId);
    expect(again.created, "a second Generate adds nothing").toBe(0);
    expect(await rowsOf(r.stageId)).toEqual(before);
    expect(await poolsOf(r.stageId), "and writes no second pool row").toHaveLength(1);

    // 4 -> 6 (even -> even): the reconcile adds the missing pairs, patched in place or (when the patch would run longer than a fresh
    // draw, Task 2's bloat rule) drawn again: either way every line of the grown table carries pool A.
    for (const name of ["P5", "P6"]) await createEntrants(r.auth, r.divisionId, [{ kind: "individual", display_name: name, seed: null, members: [{ new_person: { full_name: `${name} m` }, is_captain: false, roles: [] }] }]);
    const grown = await generateStageFixtures(r.auth, r.stageId);
    expect(["in_place", "regenerated"], "premise: the roster change was reconciled").toContain(grown.reconcile?.kind);
    const rows = await rowsOf(r.stageId);
    expect(rows, "a group of 6 plays 15 matches").toHaveLength(15);
    expect(new Set(rows.map((x) => x.pool_id)), "the new lines carry pool A as well").toEqual(new Set([pool!.id]));
    expect(new Set(rows.map((x) => (x.ext_key ?? "").slice(0, 2))), "and its key prefix").toEqual(new Set(["pA"]));
  });
});

describe.skipIf(!HAS_DB)("X-BD-7 a one-pool group behaves as a league", () => {
  // differential: today 422 "both entrants must be in the same pool of this stage" (the single pool had no id)
  it("X-BD-7 Add match works on a one-pool group and lands in pool A", async () => {
    const r = await rig({ n: 4, kind: "group" });
    const [pool] = await poolsOf(r.stageId);
    const rows = await rowsOf(r.stageId);
    const ab = lineBetween(rows, r.ids[0]!, r.ids[1]!);
    await sql`update fixtures set status = 'cancelled' where id = ${ab.id}`;
    const added = await addFixture(r.auth, r.stageId, { home_entrant_id: r.ids[0]!, away_entrant_id: r.ids[1]! });
    const [row] = await sql<{ pool_id: string | null; round_no: number }[]>`select pool_id, round_no from fixtures where id = ${added.fixture_id}`;
    expect(row!.pool_id, "the added match is folded by pool A's table").toBe(pool!.id);
    expect(row!.round_no, "and takes the round the voided match left (X-BD-6 on a group)").toBe(ab.round_no);
  });

  it("X-BD-7 a one-pool group's standings are served WITHOUT naming the pool, as a league's are (the v1 route's call)", async () => {
    const r = await rig({ n: 2, kind: "group" });
    await startDivision(r.auth, r.divisionId);
    const [fx] = await rowsOf(r.stageId);
    expect(await playToDecided(r.auth, fx!.id)).toMatchObject({ kind: "decided" });
    const table = await getStandings(r.auth, r.stageId);
    expect(table.rows, "both entrants are in the single table").toHaveLength(2);
  });
});

// ---- Review Focus 5: every surface that read "the table with no pool" still finds a one-pool group's table ----------------------

interface Played {
  r: Rig;
  fixtureId: string;
  winnerId: string;
  winnerName: string;
  loserId: string;
}

/** Two entrants, one match decided through the real write path: the smallest stage with a table that has a leader. */
async function played(kind: "league" | "group"): Promise<Played> {
  const r = await rig({ n: 2, kind });
  await startDivision(r.auth, r.divisionId);
  const [fx] = await rowsOf(r.stageId);
  expect(await playToDecided(r.auth, fx!.id), "premise: the match decided").toMatchObject({ kind: "decided" });
  const [{ outcome }] = await sql<{ outcome: { winner?: string } | null }[]>`select outcome from fixtures where id = ${fx!.id}`;
  const winnerId = outcome?.winner;
  if (!winnerId) throw new Error("premise: the decided match stored no winner");
  const [w] = await sql<{ display_name: string }[]>`select display_name from entrants where id = ${winnerId}`;
  const snaps = await sql<{ pool_id: string | null; rows: { entrantId: string; rank?: number }[] }[]>`
    select pool_id, rows from standings_snapshots where stage_id = ${r.stageId}`;
  expect(snaps, "premise: the write path stored exactly one table").toHaveLength(1);
  if (kind === "group") {
    const [pool] = await poolsOf(r.stageId);
    expect(snaps[0]!.pool_id, "premise: stored under pool A (the table `pool_id is null` cannot see)").toBe(pool!.id);
  } else {
    expect(snaps[0]!.pool_id, "premise: a league's table has no pool").toBeNull();
  }
  // the previous table, so a climber exists: the winner stood second
  await sql`
    update standings_snapshots set previous_rows = (
      select jsonb_agg(jsonb_set(r, '{rank}', to_jsonb(case when r->>'entrantId' = ${winnerId} then 2 else 1 end)))
      from jsonb_array_elements(rows) r)
    where stage_id = ${r.stageId}`;
  return { r, fixtureId: fx!.id, winnerId, winnerName: w!.display_name, loserId: r.ids.find((i) => i !== winnerId)! };
}

async function fixtureCtxOf(p: Played): Promise<FixtureCtx> {
  const [row] = await sql<Omit<FixtureCtx, "stage_kind">[] & { stage_kind: string }[]>`
    select f.id as fixture_id, f.org_id, f.division_id, d.competition_id, f.stage_id, st.kind as stage_kind, f.round_no, f.status,
           f.home_entrant_id, f.away_entrant_id, h.display_name as home_name, a.display_name as away_name, f.scheduled_at,
           null::text as venue, null::text as venue_tz, d.name as division_name, c.name as competition_name,
           d.sport_key, d.module_version, d.auto_posts, null::text as default_locale
    from fixtures f join stages st on st.id = f.stage_id join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id join entrants h on h.id = f.home_entrant_id join entrants a on a.id = f.away_entrant_id
    where f.id = ${p.fixtureId}`;
  return row as unknown as FixtureCtx;
}

describe.skipIf(!HAS_DB)("X-BD-7 a one-pool group's table is still read by every surface", () => {
  // The league is the control: the same two entrants, the same match, no pool. Each surface must answer the same for the group.
  // differential: today (group with pool_id null) the readers answer; after the pool id lands, a `pool_id is null` reader answers
  // nothing, silently — the section is dropped, the page is not red.
  for (const kind of ["league", "group"] as const) {
    it(`X-BD-7 the weekly digest's standings section finds the ${kind}'s table`, async () => {
      const p = await played(kind);
      const sections = await withTenant(p.r.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: p.r.stageId, division_name: "Open" }]));
      expect(sections, "one section, not a silently dropped one").toHaveLength(1);
      expect(sections[0]!.top3[0]!.name, "the leader is the match's winner").toBe(p.winnerName);
      expect(sections[0]!.climber?.entrantName, "and the climber is read from the same table's previous rows").toBe(p.winnerName);
    });

    it(`X-BD-7 the recap's standings-move line finds the ${kind}'s table`, async () => {
      const p = await played(kind);
      const fx = await fixtureCtxOf(p);
      const out = await withTenant(p.r.auth.orgId, (tx) => assembleRecapEnrichment(tx, fx, []));
      expect(out.standingsMoves, "the winner climbed 2 -> 1").toEqual([{ entrantName: p.winnerName, from: 2, to: 1 }]);
    });

    it(`X-BD-7 the round recap and the result post read the ${kind}'s table (the standings block, the winner's movement)`, async () => {
      const p = await played(kind);
      await sql`update divisions set auto_posts = true where id = ${p.r.divisionId}`;
      await withTenant(p.r.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, p.fixtureId, true));
      const posts = await sql<{ kind: string; body_md: string }[]>`
        select kind, body_md from org_posts where org_id = ${p.r.auth.orgId} order by kind`;
      const recap = posts.find((x) => x.kind === "round_recap");
      expect(recap, "premise: the round (one match) is complete, so a recap is drafted").toBeDefined();
      // the recap's standings block names the leader on a standings line: the winner's name appears more than the results line alone
      const mentions = (recap!.body_md.match(new RegExp(p.winnerName, "g")) ?? []).length;
      expect(mentions, `${kind}: the standings block names the winner beside the results line`).toBeGreaterThanOrEqual(2);
    });
  }
});

// ---- X-SF-5: the board read hands the pool letter to the card (the inert-seam check: real loader, not a fixture) -----------------

describe.skipIf(!HAS_DB)("X-SF-5 the board loader sends the pool letter for a stage with several pools only", () => {
  it("X-SF-5 a two-pool group: every card carries its pool's letter; a one-pool group and a league send none", async () => {
    const two = await rig({ n: 4, kind: "group", pools: 2 });
    const twoPools = await poolsOf(two.stageId);
    const letterOf = new Map(twoPools.map((p) => [p.id, p.key]));
    const board = await listDivisionFixturesForBoard(two.auth, two.divisionId);
    expect(board, "premise: two pools of two play one match each").toHaveLength(2);
    expect(board.map((f) => f.pool_key).sort(), "the letters A and B, one card each").toEqual(["A", "B"]);
    for (const f of board) expect(f.pool_key, "and each card's letter is its own pool's").toBe(letterOf.get(f.pool_id!));

    const one = await rig({ n: 4, kind: "group" });
    const oneBoard = await listDivisionFixturesForBoard(one.auth, one.divisionId);
    expect(oneBoard).toHaveLength(6);
    for (const f of oneBoard) expect("pool_key" in f, "a one-pool group's card reads as a league's: no key at all").toBe(false);

    const league = await rig({ n: 4, kind: "league" });
    const leagueBoard = await listDivisionFixturesForBoard(league.auth, league.divisionId);
    expect(leagueBoard).toHaveLength(6);
    for (const f of leagueBoard) expect("pool_key" in f).toBe(false);
  });
});
