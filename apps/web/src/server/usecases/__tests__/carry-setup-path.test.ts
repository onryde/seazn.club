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
  confirmSeedProposal,
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
    // Names the offending kind AND the kinds that WOULD work — the actionable
    // half. Deliberately does not pin the whole sentence: the reason clause was
    // reworded once already (F6 review round 1, where "this completion has no
    // real points" turned out to be false for an americano source).
    expect(http.message).toMatch(/knockout/);
    expect(http.message).toMatch(/league\/group\/swiss/);
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

describe.skipIf(!HAS_DB)("F6 — carry-over APPLIED at confirm time (timing: setup)", () => {
  // The same league -> super-pool graph custom-points.test.ts carries on
  // `on_complete`, flipped to `timing: "setup"`: day-one TBD fixtures in the
  // target, then propose + confirm. What the two paths write must agree, so
  // the assertions below are deliberately the on_complete test's own —
  // E1's 9 points, a carry covering exactly the entrants that qualified, and
  // one `standings_carried` row.
  it("confirmSeedProposal writes carry_deltas on the target stage and one standings_carried event", async () => {
    const { auth } = await seedOrg("pro");
    const { division, entrants } = await seedDivision(auth, 4);
    const seedOf = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));
    const [phase1, superPool] = await createStages(auth, division.id, [
      { seq: 1, kind: "league", name: "Phase 1", config: {} },
      {
        seq: 2,
        kind: "league",
        name: "Super pool",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }],
          placement: "rank_order",
          timing: "setup",
          carry: "points",
        },
      },
    ]);
    // Day-one TBD round robin for the target BEFORE startDivision — start
    // generates only the first stage.
    await generateStageFixtures(auth, superPool!.id);
    const { fixtures } = await generateStageFixtures(auth, phase1!.id);
    await startDivision(auth, division.id);
    // Lower seed always wins => E1 9, E2 6, E3 3, E4 0. No ties, so the
    // confirm below needs no tiePicks (an unresolved tie 422s).
    for (const f of fixtures) {
      const homeWins = (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99);
      await decide(auth, f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
    await completeStage(auth, phase1!.id);

    const proposal = await computeSeedProposal(auth, superPool!.id);
    expect(proposal.computed.qualifiers).toHaveLength(3);
    const confirmed = await confirmSeedProposal(auth, superPool!.id, { proposalId: proposal.id });
    expect(confirmed.filled).toBeGreaterThan(0);

    const [target] = await sql<{ config: { carry_deltas?: { entrantId: string; points: number }[] } }[]>`
      select config from stages where id = ${superPool!.id}`;
    expect(target!.config.carry_deltas).toBeDefined();
    const carried = target!.config.carry_deltas!;
    const byId = new Map(entrants.map((e) => [e.display_name, e.id]));
    expect(carried.find((d) => d.entrantId === byId.get("E1"))!.points).toBe(9);

    // Carry covers EXACTLY the entrants the confirm actually seated — E4
    // finished 4th under this rankRange{1,3} and must not arrive in the super
    // pool's opening table with points from a phase it was eliminated in.
    // Derived from the target stage's OWN filled fixtures (the same
    // transaction's other half) rather than a hand-listed set, so a change to
    // who qualifies moves both sides together. Without buildCarryDeltas'
    // qualified-set filter (stages.ts) every source row folds in: 4, not 3.
    const seated = await sql<{ entrant_id: string }[]>`
      select distinct home_entrant_id as entrant_id from fixtures
        where stage_id = ${superPool!.id} and home_entrant_id is not null
      union
      select distinct away_entrant_id as entrant_id from fixtures
        where stage_id = ${superPool!.id} and away_entrant_id is not null`;
    expect([...carried.map((d) => d.entrantId)].sort()).toEqual([...seated.map((r) => r.entrant_id)].sort());
    expect(carried).toHaveLength(3);

    // One auditable ledger row, naming the target stage and the mode.
    const events = await sql<{ payload: { stageId: string; mode: string; entrants: string[] } }[]>`
      select payload from division_events
      where division_id = ${division.id} and type = 'standings_carried'`;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.stageId).toBe(superPool!.id);
    expect(events[0]!.payload.mode).toBe("points");
    expect([...events[0]!.payload.entrants].sort()).toEqual([...seated.map((r) => r.entrant_id)].sort());
    // The event's seq must not collide with anything the confirm's own
    // division already wrote, and divisions.seq must have kept up.
    const [chain] = await sql<{ broken: string | null }[]>`
      select verify_division_events_chain(${division.id})::text as broken`;
    expect(chain).toEqual({ broken: null });
    const [{ seq: watermark }] = await sql<{ seq: number }[]>`
      select seq from divisions where id = ${division.id}`;
    const [{ seq: maxSeq }] = await sql<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events where division_id = ${division.id}`;
    expect(watermark).toBe(maxSeq);
  });
});
