// Swiss shell mint — first Generate creates empty fixture rows for every
// configured round so organisers can schedule ahead. Pair seating is Task 3.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { EngineError } from "@seazn/engine/core";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface FixtureRow {
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: unknown;
}

async function fixturesOf(stageId: string): Promise<FixtureRow[]> {
  return sql<FixtureRow[]>`
    select round_no, home_entrant_id, away_entrant_id, status, outcome
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;
}

async function seedSwissStage(
  auth: AuthCtx,
  config: Record<string, unknown>,
): Promise<{ divisionId: string; stageId: string }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss shells " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config,
    progression: null,
  });
  return { divisionId: division.id, stageId: stage!.id };
}

describe.runIf(HAS_DB)("swiss shell fixtures — mint all rounds on first Generate", () => {
  it("Generate mints shells for all rounds without seating anyone", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);

    const rows = await fixturesOf(stageId);
    expect(rows).toHaveLength(6); // 3 rounds × 2 boards (4 entrants)
    expect(rows.every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(true);
    expect(rows.every((f) => f.status === "scheduled")).toBe(true);
    expect(rows.every((f) => f.outcome === null)).toBe(true);
  });

  it("Generate without config.rounds returns CONFIG_INVALID", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedSwissStage(auth, {});

    await expect(generateStageFixtures(auth, stageId)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "CONFIG_INVALID"),
    );
  });

  it("second Generate with all shells unseated does not duplicate rows", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedSwissStage(auth, { rounds: 3 });
    await startDivision(auth, divisionId);

    const first = await fixturesOf(stageId);
    expect(first).toHaveLength(6);

    const again = await generateStageFixtures(auth, stageId);
    expect(again.created).toBe(0);

    const after = await fixturesOf(stageId);
    expect(after).toHaveLength(6);
  });
});
