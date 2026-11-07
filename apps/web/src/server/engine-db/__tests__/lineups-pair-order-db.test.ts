// S2-2 web finding #2 and #3 — DB-BACKED proof that the SERVER lineup loaders
// carry `lineups.pair_order` into `LineupSlot.pairOrder`, and order rows by the
// same rule the pad's own read (`readLineup`, usecases/fixtures.ts) uses.
//
// Why a DB test: `buildLineup` maps `r.pair_order` off a row object, so a unit
// test handing it a row with that key stays green while the `select` lists
// that produce real rows never name the column (the AGENTS.md "inert seam",
// same shape as lineups-squad-number-db.test.ts).
//
// What the field is for (engine 3.0.2, sports/squad-state.ts `pairOrderOf`,
// setbased/kernel.ts serveContext): table tennis and badminton doubles name a
// serving PERSON only when exactly two on-field players of a side carry a
// `pairOrder`. The server fold never carried it, so `serverPersonId` was always
// null server-side while the browser pad named one.
//
// Expected values are derived from the seed (the declared pair order, and the
// order the pad's query returns), never typed in beside the code under test.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { loadLineupPair, loadLineupPairsForDivision } from "../lineups";

type Tx = postgres.TransactionSql;
const HAS_DB = !!process.env.DATABASE_URL;

interface Seeded {
  divisionId: string;
  fixtureId: string;
  homeEntrantId: string;
  awayEntrantId: string;
  /** personId -> declared pair_order (null = none declared). */
  declared: Map<string, number | null>;
  /** person ids of the home side in the order the PAD's own read returns them
   *  (`order by order_no nulls last, full_name`) — the single authority for
   *  row order (finding #3). */
  homePadOrder: string[];
}

async function seedDoublesFixture(): Promise<Seeded> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"PO " + suffix}, ${"po-" + suffix})
    returning id`;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version, status)
    values (${competitionId}, 'Div', ${"div-" + suffix}, 'tabletennis', 'default',
            ${sql.json({})}, '1.0.0', 'active')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name) values (${divisionId}, 1, 'league', 'League')
    returning id`;

  const declared = new Map<string, number | null>();

  /** A doubles pair entrant: two players, both starting, no bench. Names are
   *  given in the order the PAD sorts them (alphabetical); the person ids are
   *  generated so the id order is the REVERSE of the name order — the two
   *  tie-break rules then disagree, which is what makes #3 observable. */
  async function makePair(
    name: string,
    side: "a" | "b",
    players: readonly { readonly name: string; readonly pairOrder: number | null }[],
  ): Promise<{ entrantId: string; personIds: string[] }> {
    const [{ id: entrantId }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, kind, display_name, seed)
      values (${divisionId}, 'pair', ${name}, 1)
      returning id`;
    // Fixed uuids per side: the first-named player gets the HIGHER id.
    const tail = `${side}${suffix}`.padEnd(12, "0");
    const ids = [`ffffffff-0000-4000-8000-${tail}`, `00000000-0000-4000-8000-${tail}`];
    const personIds: string[] = [];
    for (const [i, p] of players.entries()) {
      const personId = ids[i]!;
      await sql`insert into persons (id, org_id, full_name) values (${personId}, ${orgId}, ${p.name})`;
      await sql`
        insert into entrant_members (entrant_id, person_id, org_id)
        values (${entrantId}, ${personId}, ${orgId})`;
      declared.set(personId, p.pairOrder);
      personIds.push(personId);
    }
    return { entrantId, personIds };
  }

  // Home: both rows have NO order_no, so the tie-break decides the row order.
  // "Aaron" sorts before "Zed" by name but has the higher person id.
  const home = await makePair("Home pair", "a", [
    { name: "Aaron", pairOrder: 2 },
    { name: "Zed", pairOrder: 1 },
  ]);
  // Away: a pair with NO declared order — the field must stay absent.
  const away = await makePair("Away pair", "b", [
    { name: "Bea", pairOrder: null },
    { name: "Cy", pairOrder: null },
  ]);

  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${home.entrantId}, ${away.entrantId})
    returning id`;

  for (const [entrantId, personIds] of [
    [home.entrantId, home.personIds],
    [away.entrantId, away.personIds],
  ] as const) {
    for (const personId of personIds) {
      await sql`
        insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, position_key, order_no, roles, pair_order)
        values (${fixtureId}, ${entrantId}, ${personId}, ${orgId}, 'starting', null, null,
                ${sql.json([])}, ${declared.get(personId) ?? null})`;
    }
  }

  // The pad's authority for row order, read with ITS query shape.
  const padRows = await sql<{ person_id: string }[]>`
    select l.person_id
    from lineups l join persons p on p.id = l.person_id
    where l.fixture_id = ${fixtureId} and l.entrant_id = ${home.entrantId}
    order by l.order_no nulls last, p.full_name`;

  return {
    divisionId,
    fixtureId,
    homeEntrantId: home.entrantId,
    awayEntrantId: away.entrantId,
    declared,
    homePadOrder: padRows.map((r) => r.person_id),
  };
}

describe.skipIf(!HAS_DB)("engine-db/lineups: pair_order reaches LineupSlot.pairOrder (S2-2 #2, #3)", () => {
  it("loadLineupPair carries every declared pair order off a REAL query, and omits an undeclared one", async () => {
    const seed = await seedDoublesFixture();
    const tx = sql as unknown as Tx;
    const pair = await loadLineupPair(tx, seed.fixtureId, seed.homeEntrantId, seed.awayEntrantId);

    // Non-vacuous: both sides produced both rows, and a real order arrived.
    expect(pair.home.slots.length).toBe(2);
    expect(pair.away.slots.length).toBe(2);
    expect([...pair.home.slots, ...pair.away.slots].filter((s) => s.pairOrder !== undefined).length).toBe(2);

    for (const slot of [...pair.home.slots, ...pair.away.slots]) {
      const declared = seed.declared.get(slot.personId);
      expect(declared, `${slot.personId} was seeded`).not.toBeUndefined();
      if (declared === null) expect(slot).not.toHaveProperty("pairOrder");
      else expect(slot.pairOrder, slot.personId).toBe(declared);
    }
  });

  it("orders rows exactly as the pad's own read does (finding #3), when order_no is absent", async () => {
    const seed = await seedDoublesFixture();
    const tx = sql as unknown as Tx;
    const pair = await loadLineupPair(tx, seed.fixtureId, seed.homeEntrantId, seed.awayEntrantId);
    const ids = pair.home.slots.map((s) => s.personId);
    // The seed makes the two rules disagree: id order is the reverse of name order.
    expect([...seed.homePadOrder].sort()).not.toEqual(seed.homePadOrder);
    expect(ids).toEqual(seed.homePadOrder);
    // The fallback orderNo follows that same row order.
    expect(pair.home.slots.map((s) => s.orderNo)).toEqual([1, 2]);
  });

  it("loadLineupPairsForDivision — the SECOND select — agrees with the single-fixture loader", async () => {
    const seed = await seedDoublesFixture();
    const tx = sql as unknown as Tx;
    const byFixture = await loadLineupPairsForDivision(tx, seed.divisionId);
    const pair = byFixture.get(seed.fixtureId);
    expect(pair, "the seeded fixture is in the division-wide map").not.toBeUndefined();
    const single = await loadLineupPair(tx, seed.fixtureId, seed.homeEntrantId, seed.awayEntrantId);
    expect(pair).toEqual(single);
    expect(pair!.home.slots.filter((s) => s.pairOrder !== undefined).length).toBe(2);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});
