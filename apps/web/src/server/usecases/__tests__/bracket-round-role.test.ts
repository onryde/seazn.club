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
    eligibility: [],
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
});
