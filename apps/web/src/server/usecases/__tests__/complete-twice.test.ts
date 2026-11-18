// W5 app PR A Task 17 (X-BD-4 <- RB5-S4): a SECOND Complete on a stage that is already complete is a no-op that says so.
// Real Postgres required; skipped without DATABASE_URL.
//
// Today `completeStageIfReady` answers `{ completed: true, events: [] }` for an already-complete stage
// (engine-db/competition.ts), so `completeStage` passes its `if (!result.completed) return` and runs
// `progressCompletedStage` again: it recomputes a setup-timing draft, 409s over a CONFIRMED one
// (STAGE_COMPLETED_SEEDING_FAILED), writes a NEW proposal beside a STALE one, and publishes the hub. The matrix harness
// drove around it (the drivers refused a repeat /complete), which is the avoidance this task removes.
//
// What a second Complete must leave exactly as it was: the draft (its `computed` untouched), a confirmed proposal and the
// seats it filled, a stale proposal, the next stage's fixtures, the division's ledger. Every test reads the rows before and
// after: "no new proposal" alone would pass over a proposal quietly rewritten in place.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, confirmSeedProposal, createStages, generateStageFixtures, type CompleteStageResult } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The two sources the brief names: a league and a pooled group, each feeding a setup-timing knockout. The expected
 *  qualifier count is the table's own arithmetic (league top 2; group: top 1 of each of 2 pools). */
const SOURCES = [
  { label: "league_ko", kind: "league", config: {}, take: { kind: "rankRange", from: 1, to: 2 }, qualifiers: 2 },
  { label: "groups_ko", kind: "group", config: { pools: { count: 2 } }, take: { kind: "topNPerGroup", n: 1 }, qualifiers: 2 },
] as const;

async function decide(auth: AuthCtx, fixtureId: string, homeWins: boolean) {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  return scoreEvent(auth, fixtureId, {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: homeWins ? 2 : 0, p2Score: homeWins ? 0 : 2 },
  });
}

async function rig(source: (typeof SOURCES)[number]) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "CT " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
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
    Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const seedOf = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));
  const [src, ko] = await createStages(auth, division.id, [
    { seq: 1, kind: source.kind, name: "Source", config: source.config },
    {
      seq: 2,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: { sources: [{ stage: "previous", take: [source.take] }], placement: "rank_order", timing: "setup" },
    },
  ]);
  await generateStageFixtures(auth, ko!.id); // the day-one TBD bracket a setup-timing proposal fills
  const { fixtures } = await generateStageFixtures(auth, src!.id);
  await startDivision(auth, division.id);
  for (const f of fixtures) await decide(auth, f.id, (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99));
  return { auth, divisionId: division.id, srcId: src!.id, koId: ko!.id, sourceFixtures: fixtures.length };
}

const proposalRows = (stageId: string) =>
  sql<{ id: string; status: string; computed: unknown; confirmed_at: string | null; created_at: string }[]>`
    select id, status, computed, confirmed_at, created_at from stage_seed_proposals where stage_id = ${stageId} order by created_at, id`;
const koSeats = (stageId: string) =>
  sql<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null; status: string; round_no: number | null }[]>`
    select id, home_entrant_id, away_entrant_id, status, round_no from fixtures where stage_id = ${stageId} order by id`;
const ledger = async (divisionId: string) => ({
  events: await sql<{ seq: number; type: string }[]>`select seq, type from division_events where division_id = ${divisionId} order by seq`,
  divisionSeq: (await sql<{ seq: number; status: string }[]>`select seq, status from divisions where id = ${divisionId}`)[0],
  stages: await sql<{ id: string; status: string }[]>`select id, status from stages where division_id = ${divisionId} order by seq`,
});

describe.skipIf(!HAS_DB)("X-BD-4: a second Complete is a no-op that says so", () => {
  describe.each(SOURCES)("$label", (source) => {
    it("a DRAFT proposal: the second Complete answers already_complete with that draft, and rewrites nothing", async () => {
      const r = await rig(source);
      const first = await completeStage(r.auth, r.srcId);
      expect(first.completed).toBe(true);
      expect(first.already_complete, "the first completion is not a repeat").toBeUndefined();
      expect(first.seed_proposal?.status).toBe("draft");

      // A sentinel in the draft's own `computed`: a re-run of computeSeedProposal rewrites it in place (it reuses a live
      // draft), which "the row count is 1" cannot see.
      const marker = { marker: "second-complete-must-not-touch-this", qualifiers: [], ties: [] };
      await sql`update stage_seed_proposals set computed = ${sql.json(marker as never)} where id = ${first.seed_proposal!.id}`;
      const before = { proposals: await proposalRows(r.koId), seats: await koSeats(r.koId), ledger: await ledger(r.divisionId) };
      expect(before.proposals, "rig: one draft after the first Complete").toHaveLength(1);

      // differential: today the second call answers `completed: true` with no `already_complete`, and re-runs
      // progressCompletedStage (completion.ts), which recomputes the draft over the sentinel.
      const second = await completeStage(r.auth, r.srcId);
      expect(second).toEqual({
        completed: false,
        already_complete: true,
        events: [],
        seed_proposal: { id: first.seed_proposal!.id, status: "draft" },
      } satisfies CompleteStageResult);

      expect(await proposalRows(r.koId), "the draft row is byte-for-byte what it was, `computed` included").toEqual(before.proposals);
      expect(await koSeats(r.koId), "no draw: the knockout's lines are exactly as they were").toEqual(before.seats);
      expect(await ledger(r.divisionId), "no event, no sequence bump, no stage or division moved").toEqual(before.ledger);

      // The sequence: a third call is the same no-op (the answer does not drift, nothing accumulates).
      expect(await completeStage(r.auth, r.srcId)).toEqual(second);
      expect(await proposalRows(r.koId)).toEqual(before.proposals);
    }, 120_000);

    it("a CONFIRMED proposal: the second Complete leaves it confirmed and its seats where they are (today it 409s)", async () => {
      const r = await rig(source);
      const first = await completeStage(r.auth, r.srcId);
      await confirmSeedProposal(r.auth, r.koId, { proposalId: first.seed_proposal!.id });
      const before = { proposals: await proposalRows(r.koId), seats: await koSeats(r.koId), ledger: await ledger(r.divisionId) };
      expect(before.proposals.map((p) => p.status), "rig: the proposal is confirmed").toEqual(["confirmed"]);
      expect(before.seats.some((s) => s.home_entrant_id !== null), "rig: the confirm seated the knockout").toBe(true);

      // differential: today computeSeedProposal over a confirmed proposal throws SEEDING_ALREADY_CONFIRMED, which
      // completeStage wraps as 409 STAGE_COMPLETED_SEEDING_FAILED - a failure for a call that has nothing to do.
      const second = await completeStage(r.auth, r.srcId);
      expect(second).toEqual({ completed: false, already_complete: true, events: [], seed_proposal: null });

      expect(await proposalRows(r.koId), "the confirmed proposal is untouched, no draft beside it").toEqual(before.proposals);
      expect(await koSeats(r.koId), "the seats the confirm filled stand").toEqual(before.seats);
      expect(await ledger(r.divisionId)).toEqual(before.ledger);
    }, 120_000);

    it("a STALE proposal: the second Complete does not write a new draft beside it", async () => {
      const r = await rig(source);
      const first = await completeStage(r.auth, r.srcId);
      // The state itself (a correction that could not be re-proposed leaves the latest row stale): set directly, the
      // assertion is that Complete leaves whatever stale row it finds exactly alone.
      await sql`update stage_seed_proposals set status = 'stale' where id = ${first.seed_proposal!.id}`;
      const before = { proposals: await proposalRows(r.koId), seats: await koSeats(r.koId) };
      expect(before.proposals.map((p) => p.status), "rig: the only row is stale").toEqual(["stale"]);

      // differential: today a stale latest row makes computeSeedProposal INSERT a fresh draft (the stale one stays beside it).
      const second = await completeStage(r.auth, r.srcId);
      expect(second).toEqual({ completed: false, already_complete: true, events: [], seed_proposal: null });
      expect(await proposalRows(r.koId), "still exactly one row, still stale").toEqual(before.proposals);
      expect(await koSeats(r.koId)).toEqual(before.seats);
    }, 120_000);

    it("a stage that is NOT finished still answers a plain completed:false (no already_complete): the field names a repeat only", async () => {
      // The empty case of the new answer: nothing has completed, so nothing can be "already" complete.
      const { auth } = await seedOrg("pro");
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "CT " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
      const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
      await createEntrants(auth, division.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
      const [src] = await createStages(auth, division.id, [{ seq: 1, kind: source.kind, name: "Source", config: source.config }]);
      await generateStageFixtures(auth, src!.id);
      await startDivision(auth, division.id);
      const out = await completeStage(auth, src!.id);
      expect(out).toEqual({ completed: false, events: [] });
      expect(Object.keys(out), "no already_complete key at all on a stage that has not completed").not.toContain("already_complete");
    }, 120_000);
  });

  it("the LAST stage: a second Complete does not complete the division twice (every sport the registry declares)", async () => {
    let checked = 0;
    for (const mod of builtinModules) {
      const variantKey = Object.keys(mod.variants)[0]!;
      const { auth } = await seedOrg("pro");
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "CT " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
      const division = await createDivision(auth, comp.id, {
        name: "Open",
        slug: "open",
        sport_key: mod.key,
        variant_key: variantKey,
        config: mod.variants[variantKey] as Record<string, unknown>,
      });
      const kind = mod.entrantModel?.defaultKind ?? "individual";
      await createEntrants(auth, division.id, [1, 2].map((n) => ({ kind, display_name: `E${n}`, seed: n, members: [] })));
      const [stage] = await createStages(auth, division.id, [{ seq: 1, kind: "league", name: "League", config: {} }]);
      const { fixtures } = await generateStageFixtures(auth, stage!.id);
      await startDivision(auth, division.id);
      // A walkover decides the one line in any sport (a core event, no sport payload).
      const f = fixtures[0]!;
      await scoreEvent(auth, f.id, { expected_seq: 0, type: "core.start", payload: {} } as never);
      const walked = await scoreEvent(auth, f.id, { expected_seq: 1, type: "core.forfeit", payload: { by: f.home_entrant_id, reason: "walkover" } } as never);
      expect(walked.status, `${mod.key}: rig - the walkover decides the line`).toBe("forfeited");

      const first = await completeStage(auth, stage!.id);
      expect(first, `${mod.key}: the first Complete completes the division`).toMatchObject({ completed: true, division_completed: true });
      const before = await ledger(division.id);
      expect(before.events.filter((e) => e.type === "division_completed"), `${mod.key}: one division_completed after the first`).toHaveLength(1);
      expect(before.events.filter((e) => e.type === "stage_completed"), `${mod.key}: one stage_completed after the first`).toHaveLength(1);

      const second = await completeStage(auth, stage!.id);
      expect(second, `${mod.key}: differential - today completed:true, no already_complete`).toEqual({
        completed: false,
        already_complete: true,
        events: [],
        seed_proposal: null,
      });
      expect(Object.keys(second), `${mod.key}: no division_completed on the second answer`).not.toContain("division_completed");
      expect(await ledger(division.id), `${mod.key}: no second division_completed, no sequence bump`).toEqual(before);
      checked++;
    }
    expect(checked, "every registry sport was driven").toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
  }, 600_000);

  it("an on_complete next stage that is already DRAWN: the second Complete seeds nothing and draws nothing", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "CT " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    const entrants = await createEntrants(auth, division.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
    const seedOf = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));
    const [src, ko] = await createStages(auth, division.id, [
      { seq: 1, kind: "league", name: "League", config: {} },
      {
        seq: 2,
        kind: "knockout",
        name: "Final",
        config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "on_complete" },
      },
    ]);
    const { fixtures } = await generateStageFixtures(auth, src!.id);
    await startDivision(auth, division.id);
    for (const f of fixtures) await decide(auth, f.id, (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99));
    const first = await completeStage(auth, src!.id);
    expect(first.next_stage_fixtures, "rig: the first Complete drew the knockout").toBeGreaterThan(0);
    const before = { seats: await koSeats(ko!.id), ledger: await ledger(division.id) };

    const second = await completeStage(auth, src!.id);
    expect(second).toEqual({ completed: false, already_complete: true, events: [], seed_proposal: null });
    expect(await koSeats(ko!.id), "no draw: the same lines, same seats").toEqual(before.seats);
    expect(await ledger(division.id)).toEqual(before.ledger);
  }, 120_000);
});
