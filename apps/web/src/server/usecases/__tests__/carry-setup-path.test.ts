// F6 (#625) — `standings.carry_over` on the `timing: "setup"` propose/confirm
// path. Real Postgres required; skipped without DATABASE_URL.
//
// The on_complete path (seedNextStage) has carried since Jul3/05 and is
// covered by custom-points.test.ts (the happy path) and
// qualification-from-any-stage.test.ts (the bracket/ladder/americano refusal,
// which throws EngineError CONFIG_INVALID there). This file is the SETUP
// timing sibling, where the same refusal has to reach an organiser as an
// HttpError from the endpoint their UI actually posts to
// (POST /stages/{id}/seed-proposal -> computeSeedProposal), not as a
// swallowed complete-time error.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import {
  completeStage,
  computeSeedProposal,
  createStages,
  generateStageFixtures,
  type StageRow,
} from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

async function seedDivision(auth: AuthCtx, count: number) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Carry " + randomUUID().slice(0, 6),
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
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: count }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  return { division, entrants };
}

async function decide(auth: AuthCtx, fixtureId: string, hs: number, as_: number) {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  return scoreEvent(auth, fixtureId, {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: hs, p2Score: as_ },
  });
}

/** Decide every currently-decidable fixture in a stage, regenerating between
 *  passes so later-round winner feeds are wired, until nothing is left. Lower
 *  seed always wins — same deterministic convention as
 *  qualification-from-any-stage.test.ts's own helper. */
async function decideWholeBracket(auth: AuthCtx, stageId: string, seedOf: Map<string, number>): Promise<void> {
  for (let guard = 0; guard < 10; guard++) {
    await generateStageFixtures(auth, stageId).catch(() => undefined);
    const rows = await sql<
      { id: string; home_entrant_id: string | null; away_entrant_id: string | null; status: string }[]
    >`select id, home_entrant_id, away_entrant_id, status from fixtures where stage_id = ${stageId}`;
    const decidable = rows.filter(
      (f) => f.home_entrant_id && f.away_entrant_id && !["decided", "finalized"].includes(f.status),
    );
    if (decidable.length === 0) return;
    for (const f of decidable) {
      const homeWins = (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99);
      await decide(auth, f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
  }
  throw new Error(`decideWholeBracket(${stageId}): did not converge`);
}

describe.skipIf(!HAS_DB)("F6 — carry-over source validation at propose time (timing: setup)", () => {
  it("computeSeedProposal refuses a knockout source with carry: HttpError 422 SEEDING_CARRY_SOURCE_INVALID naming the offending kind", async () => {
    const { auth } = await seedOrg("pro");
    const { division, entrants } = await seedDivision(auth, 8);
    const seedOf = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));
    const [main, plate] = await createStages(auth, division.id, [
      { seq: 1, kind: "knockout", name: "Main", config: {} },
      {
        seq: 2,
        kind: "knockout",
        name: "Plate",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
          placement: "rank_order",
          timing: "setup",
          // A knockout completion snapshots POSITIONAL placements only
          // (placementTable zeroes every stat), so there are no real points
          // here to carry — see REAL_TABLE_KINDS (stages.ts).
          carry: "points",
        },
      },
    ]);
    await generateStageFixtures(auth, plate!.id); // day-one TBD bracket
    await generateStageFixtures(auth, main!.id);
    await startDivision(auth, division.id);
    await decideWholeBracket(auth, main!.id, seedOf);

    // completeStage computes the draft for a setup-timing next stage itself,
    // and does NOT swallow a genuine progression misconfiguration: it reports
    // "completed, but the next stage's seeding couldn't be prepared" (A4 / F3
    // ultrareview finding 4), which re-wraps this refusal as 409
    // STAGE_COMPLETED_SEEDING_FAILED and keeps the reason in the message. The
    // completion itself still commits — asserted below, because an organiser
    // whose carry is misconfigured must not also be blocked from finishing the
    // stage they actually played.
    const completeErr = await completeStage(auth, main!.id).catch((e: unknown) => e);
    expect(completeErr).toBeInstanceOf(HttpError);
    expect(completeErr as HttpError).toMatchObject({ status: 409, code: "STAGE_COMPLETED_SEEDING_FAILED" });
    expect((completeErr as HttpError).message).toMatch(/carry-over needs a table-stage source/);
    const [mainRow] = await sql<{ status: string }[]>`select status from stages where id = ${main!.id}`;
    expect(mainRow!.status).toBe("complete");

    // …and the explicit propose — POST /stages/{id}/seed-proposal, the call an
    // organiser's panel makes — answers with the carry-specific code, which the
    // 409 wrapper above necessarily flattens away.
    const err = await computeSeedProposal(auth, plate!.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const http = err as HttpError;
    expect(http.status).toBe(422);
    expect(http.code).toBe("SEEDING_CARRY_SOURCE_INVALID");
    expect(http.message).toMatch(/knockout/);
    expect(http.extra).toMatchObject({ stageId: main!.id, kind: "knockout", carry: "points" });

    // Refused BEFORE a draft is written — an organiser must not be handed a
    // proposal they can confirm into a stage whose carry can never be applied.
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from stage_seed_proposals where stage_id = ${plate!.id} and status = 'draft'`;
    expect(row!.n).toBe(0);
  });

  it("a group source with the same carry proposes normally — the guard refuses non-real kinds only, not carry itself", async () => {
    const { auth } = await seedOrg("pro");
    const { division, entrants } = await seedDivision(auth, 8);
    const seedOfEntrant = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));
    const stages: StageRow[] = await createStages(auth, division.id, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 4 } } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
          placement: "rank_order",
          timing: "setup",
          carry: "points",
        },
      },
    ]);
    const groups = stages.find((s) => s.kind === "group")!;
    const ko = stages.find((s) => s.kind === "knockout")!;
    await generateStageFixtures(auth, ko.id);
    const { fixtures } = await generateStageFixtures(auth, groups.id);
    await startDivision(auth, division.id);
    for (const f of fixtures) {
      const homeWins = (seedOfEntrant.get(f.home_entrant_id!) ?? 99) < (seedOfEntrant.get(f.away_entrant_id!) ?? 99);
      await decide(auth, f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
    await completeStage(auth, groups.id);

    const proposal = await computeSeedProposal(auth, ko.id);
    expect(proposal.status).toBe("draft");
    expect(proposal.computed.qualifiers).toHaveLength(8);
  });
});
