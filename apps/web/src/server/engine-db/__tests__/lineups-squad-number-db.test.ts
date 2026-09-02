// WS-SQ (ScoringPad v3, R8 sweep) — DB-BACKED proof that this loader's SQL
// actually SELECTS the shirt number.
//
// Why this file exists rather than a unit test. `buildLineup` maps
// `r.squad_number` off a row object; a unit test can hand it a row object
// carrying that key and go green forever while the `select` list that produces
// real rows never mentions the column. That is precisely the regression this
// wave is fixing: `SquadMember.squadNumber` has been declared in the engine
// since S3, and this loader never fetched the column, so the field was
// structurally unreachable on the server fold. Only a query against a real
// database can witness a missing column in a select list.
//
// `squad_number` lives on `entrant_members`, NOT on `lineups`, so both queries
// reach it through a LEFT join — which is also why the null case below is a
// real scenario and not defensive padding.
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
  /** personId -> the squad number seeded on `entrant_members`, `null` for a
   *  member who has none. The expectations below are read out of THIS map, so
   *  a change to the seed moves the assertions with it. */
  declared: Map<string, number | null>;
}

async function seedFixtureWithLineups(): Promise<Seeded> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"SQ " + suffix}, ${"sq-" + suffix})
    returning id`;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version, status)
    values (${competitionId}, 'Div', ${"div-" + suffix}, 'icehockey', 'default',
            ${sql.json({})}, '1.0.0', 'active')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name) values (${divisionId}, 1, 'league', 'League')
    returning id`;

  const declared = new Map<string, number | null>();

  /** One entrant plus its members, each with the squad number it declares. */
  async function makeEntrant(
    name: string,
    roster: readonly { readonly name: string; readonly squadNumber: number | null; readonly slot: "starting" | "bench" }[],
  ): Promise<{ entrantId: string; slots: { personId: string; slot: string; positionKey: string }[] }> {
    const [{ id: entrantId }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, kind, display_name, seed)
      values (${divisionId}, 'team', ${name}, 1)
      returning id`;
    const slots: { personId: string; slot: string; positionKey: string }[] = [];
    for (const [i, member] of roster.entries()) {
      const [{ id: personId }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name) values (${orgId}, ${member.name}) returning id`;
      await sql`
        insert into entrant_members (entrant_id, person_id, org_id, squad_number)
        values (${entrantId}, ${personId}, ${orgId}, ${member.squadNumber})`;
      declared.set(personId, member.squadNumber);
      // Realistic ice-hockey duplication: one G, then D/F repeating, so the
      // position key is NOT a unique distinguisher for the on-ice six.
      slots.push({ personId, slot: member.slot, positionKey: i === 0 ? "G" : i % 2 === 0 ? "D" : "F" });
    }
    return { entrantId, slots };
  }

  const home = await makeEntrant("Home", [
    { name: "H Goalie", squadNumber: 30, slot: "starting" },
    { name: "H Def One", squadNumber: 4, slot: "starting" },
    { name: "H Def Two", squadNumber: 77, slot: "starting" },
    { name: "H Fwd One", squadNumber: 9, slot: "starting" },
    { name: "H Fwd Two", squadNumber: 11, slot: "starting" },
    { name: "H Fwd Three", squadNumber: 19, slot: "starting" },
    { name: "H Bench", squadNumber: 21, slot: "bench" },
    // The member with NO declared number — the LEFT join's null arm.
    { name: "H Unnumbered", squadNumber: null, slot: "bench" },
  ]);
  const away = await makeEntrant("Away", [
    { name: "A Goalie", squadNumber: 1, slot: "starting" },
    { name: "A Def", squadNumber: 6, slot: "starting" },
  ]);

  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${home.entrantId}, ${away.entrantId})
    returning id`;

  for (const s of [...home.slots.map((x) => ({ ...x, entrantId: home.entrantId })), ...away.slots.map((x) => ({ ...x, entrantId: away.entrantId }))]) {
    await sql`
      insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, position_key, order_no, roles)
      values (${fixtureId}, ${s.entrantId}, ${s.personId}, ${orgId}, ${s.slot}, ${s.positionKey}, null, ${sql.json([])})`;
  }

  return { divisionId, fixtureId, homeEntrantId: home.entrantId, awayEntrantId: away.entrantId, declared };
}

describe.skipIf(!HAS_DB)("engine-db/lineups: squad_number reaches LineupSlot.squadNumber (WS-SQ)", () => {
  it("loadLineupPair carries every declared shirt number off a REAL query", async () => {
    const seed = await seedFixtureWithLineups();
    const tx = sql as unknown as Tx;
    const pair = await loadLineupPair(tx, seed.fixtureId, seed.homeEntrantId, seed.awayEntrantId);

    const slots = [...pair.home.slots, ...pair.away.slots];
    // Non-vacuous: the fixture really did produce rows on both sides.
    expect(pair.home.slots.length).toBe(8);
    expect(pair.away.slots.length).toBe(2);

    for (const slot of slots) {
      const declared = seed.declared.get(slot.personId);
      expect(declared, `${slot.personId} was seeded`).not.toBeUndefined();
      if (declared === null) {
        // Absent, never `null` — the same shape the engine's own
        // `memberFromSlot` and registry.tsx's `toLineupSlot` produce.
        expect(slot).not.toHaveProperty("squadNumber");
      } else {
        expect(slot.squadNumber, slot.personId).toBe(declared);
      }
    }
    // At least one real number arrived, so a loader that dropped the column
    // entirely cannot satisfy the loop above by vacuous agreement.
    expect(slots.filter((s) => s.squadNumber !== undefined).length).toBe(9);
  });

  it("loadLineupPairsForDivision — the SECOND select — carries them identically", async () => {
    const seed = await seedFixtureWithLineups();
    const tx = sql as unknown as Tx;
    const byFixture = await loadLineupPairsForDivision(tx, seed.divisionId);
    const pair = byFixture.get(seed.fixtureId);
    expect(pair, "the seeded fixture is in the division-wide map").not.toBeUndefined();

    // The two loaders must agree field for field: they build the same
    // `LineupPair` for the same fixture, and a column added to one select and
    // forgotten in the other is exactly the drift this pair of queries exists
    // to avoid. Compared against the single-fixture loader's own output rather
    // than a second hand-typed table.
    const single = await loadLineupPair(tx, seed.fixtureId, seed.homeEntrantId, seed.awayEntrantId);
    const numbersOf = (p: typeof single) =>
      Object.fromEntries([...p.home.slots, ...p.away.slots].map((s) => [s.personId, s.squadNumber]));
    expect(numbersOf(pair!)).toEqual(numbersOf(single));
    expect(Object.values(numbersOf(pair!)).filter((n) => n !== undefined).length).toBe(9);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});
