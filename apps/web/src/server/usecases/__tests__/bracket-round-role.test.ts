// F1 Task 2: generating a double-elim stage must persist each fixture's
// lane, is_final, third_place and conditional flags. Before this task
// bracketToGen computed them (from BracketFixtureGen) and then dropped them
// on the floor, so every consumer had to re-derive a round name from
// round_no/match-count instead — and drifted (design 2026-08-17 §2.3).
import { describe, expect, it, afterAll } from "vitest";
import { sql } from "@/lib/db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { isBye, type RunSheetFixture } from "@/lib/run-sheet-groups";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

type RoleRow = {
  ext_key: string | null;
  round_no: number;
  lane: "WB" | "LB" | "GF" | null;
  is_final: boolean;
  third_place: boolean;
  conditional: boolean;
};

// formats.double_elim is Pro-gated (format-gates.ts stageNeedsDoubleElimGate)
// — seedOrg("pro") so createStages doesn't 402.
async function seedDoubleElimStage(entrantCount: number) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Bracket Round Role DE",
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrantCount }, (_, i) => ({
      kind: "individual" as const,
      display_name: `Entrant ${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "double_elim",
    name: "DE",
    // bracketReset:true is what makes generateDoubleElim (bracket.ts) emit
    // the `gf-reset` fixture with conditional:true — without it there is no
    // conditional row to assert on below.
    config: { bracketReset: true },
  });
  return { auth, divisionId: division.id, stageId: stage!.id };
}

// Review finding #1 (against Tasks 1-2): a double-elim of 8 never produces a
// third-place fixture, so the test above only ever exercises third_place in
// its FALSE state — a mutation hardcoding `third_place: false` on every row
// would have survived every existing assertion. A single-elim stage with
// `config.thirdPlace: true` is the one shape that actually produces a
// third-place playoff (generateSingleElim, bracket.ts) — seed one and assert
// the column reads true on THAT fixture specifically.
async function seedKnockoutStage(entrantCount: number, config: Record<string, unknown>) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Bracket Round Role KO",
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrantCount }, (_, i) => ({
      kind: "individual" as const,
      display_name: `Entrant ${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "knockout",
    name: "KO",
    config,
  });
  return { auth, divisionId: division.id, stageId: stage!.id };
}

// Review finding #2 (against Tasks 1-2): stages.ts has TWO insert sites —
// generateStageFixtures' plain path (covered above via a real DE) and
// generateSeededStageFixtures' `.seeding` path (stages.ts ~1550-1571,
// reached whenever a stage declares `seeding` — generateStageFixtures
// short-circuits into it, see its own `.seeding` branch). Only the first was
// covered; a mutation dropping the F1 role columns from the SECOND insert's
// row object would have survived every existing assertion in this file.
async function seedSeededDoubleElimStage(entrantCount: number) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Bracket Round Role Seeded DE",
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrantCount }, (_, i) => ({
      kind: "individual" as const,
      display_name: `Entrant ${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const stages = await createStages(auth, division.id, [
    { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
    {
      seq: 2,
      kind: "double_elim",
      name: "DE",
      config: { bracketReset: true },
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: entrantCount }] }],
        placement: "rank_order",
        // F2: was `.seeding` (the old propose/confirm-at-setup vocabulary,
        // implicit in which field was set) — "setup" reproduces that
        // behaviour exactly. This test only cares about bracket structure
        // (round role persistence), not when slots resolve.
        timing: "setup",
      },
    },
  ]);
  const de = stages.find((s) => s.kind === "double_elim")!;
  return { auth, divisionId: division.id, stageId: de.id };
}

describe.skipIf(!HAS_DB)("generateStageFixtures — persists bracket round role (F1 Task 2)", () => {
  it("persists lane, is_final and third_place for a double-elim bracket", async () => {
    const { auth, stageId } = await seedDoubleElimStage(8);
    await generateStageFixtures(auth, stageId);

    const rows = await sql<RoleRow[]>`
      select ext_key, round_no, lane, is_final, third_place, conditional
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.lane !== null)).toBe(true);
    expect(new Set(rows.map((r) => r.lane))).toEqual(new Set(["WB", "LB", "GF"]));
    expect(rows.filter((r) => r.is_final).length).toBeGreaterThan(0);
    expect(rows.some((r) => r.conditional)).toBe(true); // the bracket-reset game
  });

  it("persists third_place=true on the fixture that is actually a third-place playoff (review finding #1)", async () => {
    const { auth, stageId } = await seedKnockoutStage(8, { thirdPlace: true });
    await generateStageFixtures(auth, stageId);

    const rows = await sql<RoleRow[]>`
      select ext_key, round_no, lane, is_final, third_place, conditional
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

    const thirdPlaceRows = rows.filter((r) => r.third_place);
    expect(thirdPlaceRows).toHaveLength(1);
    expect(thirdPlaceRows[0]!.ext_key).toMatch(/-3p$/);
    // The column genuinely varies within this stage -- a mutation hardcoding
    // either constant value would fail one of these two assertions.
    expect(rows.some((r) => !r.third_place)).toBe(true);
    expect(rows.every((r) => r.lane === null)).toBe(true); // single-elim: no lane
  });

  it("persists lane/is_final/third_place/conditional through the SEEDED insert site too (review finding #2)", async () => {
    const { auth, stageId } = await seedSeededDoubleElimStage(8);
    await generateStageFixtures(auth, stageId); // routes into generateSeededStageFixtures

    const rows = await sql<RoleRow[]>`
      select ext_key, round_no, lane, is_final, third_place, conditional
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.lane !== null)).toBe(true);
    expect(new Set(rows.map((r) => r.lane))).toEqual(new Set(["WB", "LB", "GF"]));
    expect(rows.filter((r) => r.is_final).length).toBeGreaterThan(0);
    expect(rows.some((r) => r.conditional)).toBe(true); // the bracket-reset game
  });

  // Post-merge code review, defect 1: the fix for "a bye renders TBD" only
  // ever reached previewDivisionFixtures (stages.ts:886, the wizard's
  // in-memory preview) — the REAL insert path persisted away_slot_label =
  // NULL for a bye's phantom side, so every real renderer (public bracket,
  // stages-panel, bracket-panel, ~15 more) fell through resolveSlotLabel's
  // null-label branch to "TBD". Confirmed against a live division before the
  // fix: has_away=false, away_slot_label=NULL. A bye is known at setup and
  // never resolves to anyone, so "TBD" tells an organiser to wait for
  // something that is not coming. This test goes through generateStageFixtures
  // and reads the PERSISTED column, not previewDivisionFixtures's in-memory
  // shape, so it actually covers the path real users hit.
  it("persists a Bye slot label on a bye's phantom side, not a null that renders TBD (review finding: defect 1)", async () => {
    // 6 entrants -> buildSingleElim pads to 8 slots -> 2 byes in round 0: a
    // real entrant lands on `home`, `away` is never filled, ever.
    const { auth, stageId } = await seedKnockoutStage(6, {});
    await generateStageFixtures(auth, stageId);

    const rows = await sql<
      {
        ext_key: string | null;
        status: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        away_slot_label: { key: string; params: Record<string, unknown> } | null;
      }[]
    >`
      select ext_key, status, home_entrant_id, away_entrant_id, away_slot_label
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

    const byeRows = rows.filter((r) => r.status === "forfeited");
    expect(byeRows.length).toBeGreaterThan(0); // 6-into-8 always produces byes
    for (const row of byeRows) {
      expect(row.home_entrant_id).not.toBeNull(); // the awarded side is real
      expect(row.away_entrant_id).toBeNull(); // the phantom side is never filled
      expect(row.away_slot_label).toEqual({ key: "bracket.slot.bye", params: {} });
    }
  });

  // Walkthrough gate 1, finding 1 (2026-09-05): the generator wrote a bye's
  // outcome with JSON.stringify() into the jsonb column instead of tx.json(),
  // which the driver then stored as a JSON STRING SCALAR — jsonb_typeof =
  // 'string', not 'object' — so `isBye()` (and every other reader doing
  // outcome?.kind) silently saw undefined for every generated bye ever
  // produced. This drives the REAL generator (generateStageFixtures) and
  // reads the REAL persisted column — a hand-built `outcome: { kind: "award" }`
  // fixture, which every pre-existing bye test in this suite uses, cannot
  // witness this bug at all: the object shape it asserts against is the shape
  // the product does not produce (AGENTS.md recurring class 1).
  it("persists a bye's outcome as a real jsonb OBJECT, not a double-encoded string (walkthrough gate 1, finding 1)", async () => {
    const { auth, stageId } = await seedKnockoutStage(6, {});
    await generateStageFixtures(auth, stageId);

    const rows = await sql<
      {
        status: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        outcome: unknown;
        outcome_typeof: string;
      }[]
    >`
      select status, home_entrant_id, away_entrant_id, outcome,
             jsonb_typeof(outcome) as outcome_typeof
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

    const byeRows = rows.filter((r) => r.status === "forfeited");
    expect(byeRows.length).toBeGreaterThan(0); // 6-into-8 always produces byes
    for (const row of byeRows) {
      // Pin the VALUE the driver stored, not just that a column is non-null.
      // 'string' is exactly what the bug produced; a mutant reverting the fix
      // to JSON.stringify would flip this back to 'string' and fail here.
      expect(row.outcome_typeof).toBe("object");
      const outcome = row.outcome as { kind: string; winner: string };
      expect(outcome.kind).toBe("award");
      expect(outcome.winner).toBe(row.home_entrant_id); // the awarded side, not the phantom one

      // Real consumer, real producer: isBye() is the exact function the run
      // sheet calls to decide bracket ghost-row rendering (R7b) and the
      // filter-count skip. Only the fields it reads are selected above; the
      // cast supplies the rest of RunSheetFixture's Pick, which isBye never
      // touches.
      expect(
        isBye({
          outcome: row.outcome,
          home_entrant_id: row.home_entrant_id,
          away_entrant_id: row.away_entrant_id,
        } as unknown as RunSheetFixture),
      ).toBe(true);
    }
  });
});
