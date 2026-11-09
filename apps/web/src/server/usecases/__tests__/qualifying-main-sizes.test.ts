// W4 app-A Task 15 (QM-2; rule X-QM-5): where does qualifying_main complete? Driven, not reasoned: for every field from 2 to
// 17 the builder's own drafts (`formatStagesFor`, which sends q = 4 whatever the box says) go through the real doors:
// qualifying → complete → propose → confirm → main draw → play out → complete. The record per n is what names
// QUALIFYING_MAIN_MIN (lib/format-size-gates.ts).
//
// Badminton only: the sweep reads seats, ranks and proposals, which no sport field reaches; format-size-gates.test.ts sweeps the
// gate across other sports.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { formatStagesFor } from "@/lib/division-builder/format-choice";
import { QUALIFYING_MAIN_MIN } from "@/lib/format-size-gates";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, computeSeedProposal, confirmSeedProposal, createStages, generateStageFixtures, getSeedProposal } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

interface Line {
  id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}

const linesOf = (stageId: string) =>
  sql<Line[]>`select id, home_entrant_id, away_entrant_id, status from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

/** Play every open line, the lower seed winning, until none is left. */
async function playOut(auth: AuthCtx, stageId: string, seedOf: ReadonlyMap<string, number>): Promise<void> {
  for (let guard = 0; guard < 40; guard++) {
    const open = (await linesOf(stageId)).filter((l) => l.home_entrant_id !== null && l.away_entrant_id !== null && l.status === "scheduled");
    if (open.length === 0) return;
    for (const l of open) {
      const homeWins = seedOf.get(l.home_entrant_id!)! < seedOf.get(l.away_entrant_id!)!;
      await post(auth, l.id, "core.start");
      for (let g = 0; g < 2; g++) await post(auth, l.id, "badminton.game.summary", homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 });
    }
  }
  throw new Error("the stage never ran out of open lines");
}

/** The whole format at a field of `n`: "completes", or the first refusal, by the step and the code it came with. */
async function drive(n: number, opts: { qualified?: number } = {}): Promise<string> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "QM-2 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const seedOf = new Map(made.map((e, i) => [e.id, i + 1]));
  let step = "create";
  try {
    // The builder's own door by default (it sends q = 4, whatever the box says); `qualified` is the API's.
    const drafts =
      opts.qualified !== undefined
        ? buildTemplateStages("qualifying_main", { qualified: opts.qualified, swissRounds: 5, poolCount: 2, legs: 1 })
        : formatStagesFor("qualifying_main", { qualified: 99, swissRounds: 5, poolCount: 2, legs: 1, standingsCarry: "none" });
    const ids: string[] = [];
    for (const [i, d] of drafts.entries()) {
      const [stage] = await createStages(auth, division.id, CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }));
      ids.push(stage!.id);
    }
    const [source, main] = [ids[0]!, ids[1]!];
    step = "start";
    await startDivision(auth, division.id);
    step = "main generate";
    await generateStageFixtures(auth, main);
    step = "qualifying";
    await playOut(auth, source, seedOf);
    step = "complete qualifying";
    expect((await completeStage(auth, source)).completed).toBe(true);
    step = "propose";
    let proposal = await getSeedProposal(auth, main);
    if (proposal?.status !== "draft") {
      await computeSeedProposal(auth, main);
      proposal = await getSeedProposal(auth, main);
    }
    step = "confirm";
    await confirmSeedProposal(auth, main, { proposalId: proposal!.id });
    step = "main";
    await playOut(auth, main, seedOf);
    step = "complete main";
    expect((await completeStage(auth, main)).completed).toBe(true);
    return "completes";
  } catch (err) {
    if (err instanceof HttpError || EngineError.is(err)) return `${step}: ${(err as { code?: string }).code ?? (err as Error).message}`;
    throw err;
  }
}

describe.runIf(HAS_DB)("QM-2 where qualifying_main completes (q = 4, as the builder sends it)", () => {
  // The record that named QUALIFYING_MAIN_MIN, before the gate stood: n = 2 and 3 played the whole qualifying stage and failed at
  // "complete qualifying: STAGE_COMPLETED_SEEDING_FAILED: the previous stage takes rank 3 (rank 4 at n = 3), but only n entrants are
  // available"; every n from 4 to 17 completed. Now the first of those is refused before any of it is played.
  let checked = 0;
  for (let n = 2; n <= 17; n++) {
    const below = n < QUALIFYING_MAIN_MIN;
    it(`X-QM-5 n=${n} ${below ? "is refused up front, by name" : "completes"}`, async () => {
      const verdict = await drive(n);
      expect(verdict).toBe(below ? "start: QUALIFYING_MAIN_TOO_FEW" : "completes");
      checked++;
    }, 300_000);
  }
  it("anti-vacuity: 16 fields were driven, and the bound is the sweep's", () => {
    expect(checked).toBe(16);
    expect(QUALIFYING_MAIN_MIN).toBe(4);
  });

  // The bound is the cut's, not the template's: an API-built q. Recorded before the gate too: q = 8 stuck at 5 and 7, the same failure
  // at Complete, and completed at 8, 9, 12 and 17; q = 2 completed at 2, 3, 4 and 5.
  for (const [q, n, verdict] of [
    [8, 5, "start: QUALIFYING_MAIN_TOO_FEW"],
    [8, 7, "start: QUALIFYING_MAIN_TOO_FEW"],
    [8, 8, "completes"],
    [8, 9, "completes"],
    [2, 2, "completes"],
    [2, 3, "completes"],
  ] as const) {
    it(`an API-built cut of ${q} at n=${n}: ${verdict}`, async () => {
      expect(await drive(n, { qualified: q })).toBe(verdict);
    }, 300_000);
  }
});
