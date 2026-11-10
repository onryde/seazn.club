// W4 app-A Task 17 (FX-G7, SL-1): a withdrawal INSIDE a stepladder or page playoff that is a FINAL stage — the only
// shape the product offers since X-SP-6 (RB4-S7: league then stepladder, league or Swiss then page playoff). The matrix's
// R4 withdraws during the TABLE stage, so a withdrawal inside the finals had never been driven (plan, "Premises found
// false" 1). Real Postgres, through the usecases the buttons call: Generate, Start, Score, Complete, the seed proposal's
// Confirm, Withdraw (`withdrawEntrantCascade`).
//
// The answers come from the W4 rulebook, never from the code under test:
// - RB4-S1 (stepladder): the lowest two seeds play first; each winner meets the next seed up. k=4: R1 = 4 v 3,
//   R2 = R1's winner v 2, Final = R2's winner v 1.
// - RB4-S2 (page playoff): Q1 = 1 v 2; E = 3 v 4; Q2 = Q1's loser v E's winner; Final = Q1's winner v Q2's winner.
// - RB4-S3 / X-SP-3: a withdrawal walks over and never voids — no line abandoned or voided.
// - X-SP-5: a Q1 withdrawal walks Q1 over, then Q2 over to E's winner: the Final is Q1's other side v E's winner, and
//   the withdrawn entrant is never seated again.
// Pre-flight ruling C6: SEATING only. Every RANK assertion (X-SP-4 "ranked as the rung-2 loser", X-SP-5 "ranks last")
// is the engine bump's (PR B), carried in app-B carry-notes C19 — never patched around here.
//
// Seeds come from the table: every league line is won by the better seed, so the league's order IS the seed order and
// the proposal the organiser confirms seats E1..E4 as seeds 1..4 (asserted, never assumed).
//
// Sports: badminton (individual, game scoring) and the first engine sport whose entrants are TEAMS (`sportFor`, from the
// engine's own `entrantModel.defaultKind` — football today, with its bracket preset of extra time and penalties).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import type { AuthCtx } from "@/server/api-v1/auth";
import { fixtureRow, playBadminton, post, rowsOf, seatOf, type FixtureRow } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { completeStage, computeSeedProposal, confirmSeedProposal, createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** RB4-S7's two final-stage shapes, as the builder builds them (templates, not typed bodies). */
const FINALS = { stepladder: "group_stepladder", page_playoff: "group_playoffs" } as const;
type FinalsKind = keyof typeof FINALS;
const KNOBS = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };

/** The second sport: the first one (registry order) whose engine-declared default entrant is a team. */
function sportFor(): string {
  const m = builtinModules.find((x) => x.entrantModel?.defaultKind === "team");
  if (m === undefined) throw new Error("premise: the engine declares no team sport");
  return m.key;
}
const SPORTS = ["badminton", sportFor()] as const;

/** One decided line, won by `winner`, played through the sport's own events. */
async function win(auth: AuthCtx, sport: string, fixtureId: string, winner: string): Promise<FixtureRow> {
  const row = await fixtureRow(fixtureId);
  if (row.home_entrant_id === null || row.away_entrant_id === null) throw new Error(`rig: ${row.ext_key} is not seated`);
  if (winner !== row.home_entrant_id && winner !== row.away_entrant_id) throw new Error(`rig: ${winner} is not on ${row.ext_key}`);
  if (sport === "badminton") return playBadminton(auth, fixtureId, winner === row.home_entrant_id);
  if (sport === "football") {
    await post(auth, fixtureId, "core.start");
    await post(auth, fixtureId, "football.goal", { by: winner });
    await post(auth, fixtureId, "football.period", { phase: "HT" });
    await post(auth, fixtureId, "football.period", { phase: "FT" });
    const r = await fixtureRow(fixtureId);
    if (r.status !== "decided") throw new Error(`rig: ${r.ext_key} did not decide (${r.status})`);
    return r;
  }
  throw new Error(`rig: no play script for ${sport} (sportFor picked a sport this file cannot score)`);
}

interface Finals {
  auth: AuthCtx;
  sport: string;
  divisionId: string;
  stageId: string;
  /** Entrant id by league finish (= seed into the finals): seed[1] topped the table. */
  seed: Record<1 | 2 | 3 | 4, string>;
}

/** A league of four, played out (the better seed wins every line), completed, and its proposal confirmed into the finals. */
async function seededFinals(sport: string, kind: FinalsKind, opts: { reverse?: boolean } = {}): Promise<Finals> {
  const m = builtinModules.find((x) => x.key === sport)!;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `T17 ${sport} ${randomUUID().slice(0, 6)}`, visibility: "private", branding: {} });
  const variant = Object.keys(m.variants)[0]!;
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 8),
    sport_key: sport,
    variant_key: variant,
    config: m.variants[variant] as Record<string, unknown>,
  });
  const entrantKind = m.entrantModel?.defaultKind ?? "individual";
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({ kind: entrantKind, display_name: `E${i + 1}`, seed: i + 1, members: [] })) as never,
  );
  const template = FINALS[kind];
  expect(templatesForSport(sport, effectiveEntrantModel(m.entrantModel ?? null, null).kinds).map((t) => t.key), `${sport} offers ${template}`).toContain(template);
  const body = buildTemplateStages(template, KNOBS).map((s, i) => ({ ...s, seq: i + 1 }));
  expect(body.map((s) => [s.kind, s.progression !== null]), `premise: ${template} is a league then a fed ${kind}`).toEqual([["league", false], [kind, true]]);
  const [league, finals] = await createStages(auth, division.id, body as never);
  await generateStageFixtures(auth, league!.id);
  await generateStageFixtures(auth, finals!.id);
  await startDivision(auth, division.id);
  const seedOf = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));
  for (const f of await rowsOf(league!.id)) {
    // `reverse`: the WORSE registration seed wins every line, so the league's order (= the finals' draw seeds) is the REVERSE of
    // the registration seeds - the case where reading a registration seed instead of the draw seed is wrong (C12).
    const homeBetter = (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99);
    const better = homeBetter !== (opts.reverse === true) ? f.home_entrant_id! : f.away_entrant_id!;
    await win(auth, sport, f.id, better);
  }
  await completeStage(auth, league!.id);
  const proposal = await computeSeedProposal(auth, finals!.id);
  expect(proposal.computed.ties, "premise: the better seed won every line, so the table has no tie").toEqual([]);
  await confirmSeedProposal(auth, finals!.id, { proposalId: proposal.id });
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  const seed =
    opts.reverse === true
      ? { 1: byName.get("E4")!, 2: byName.get("E3")!, 3: byName.get("E2")!, 4: byName.get("E1")! }
      : { 1: byName.get("E1")!, 2: byName.get("E2")!, 3: byName.get("E3")!, 4: byName.get("E4")! };
  return { auth, sport, divisionId: division.id, stageId: finals!.id, seed };
}

const pair = (r: FixtureRow) => [r.home_entrant_id, r.away_entrant_id].sort();
const sorted = (...ids: string[]) => [...ids].sort();
/** RB4-S3: the stage holds no abandoned or voided line, and no abandon or void was ever written on one. */
async function nothingVoided(stageId: string): Promise<{ rows: number; events: number }> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stageId} and status in ('abandoned', 'void')`;
  const [e] = await sql<{ n: number }[]>`
    select count(*)::int as n from score_events ev join fixtures f on f.id = ev.fixture_id
     where f.stage_id = ${stageId} and ev.type in ('core.abandon', 'core.void')`;
  return { rows: r!.n, events: e!.n };
}
/** A walkover written for `winner` over the withdrawn side: forfeited, an award, the winner named. */
const walkedOverTo = (r: FixtureRow) => ({ status: r.status, kind: (r.outcome as { kind?: string } | null)?.kind, winner: (r.outcome as { winner?: string } | null)?.winner });
/** Every seat in the stage that holds `entrantId`, by fixture. */
const seatsOf = async (stageId: string, entrantId: string) =>
  (await rowsOf(stageId)).filter((r) => r.home_entrant_id === entrantId || r.away_entrant_id === entrantId).map((r) => r.ext_key);

/** The stepladder's three lines (RB4-S1, k=4), found by their feed edges: the final feeds nothing, R2 feeds the final. */
async function rungs(stageId: string) {
  const rows = await rowsOf(stageId);
  const final = rows.filter((r) => r.winner_to_fixture === null);
  const r2 = rows.filter((r) => final.length === 1 && r.winner_to_fixture === final[0]!.id);
  const r1 = rows.filter((r) => r2.length === 1 && r.winner_to_fixture === r2[0]!.id);
  expect([rows.length, r1.length, r2.length, final.length], "premise: k=4 is three rungs in a line").toEqual([3, 1, 1, 1]);
  return { r1: r1[0]!, r2: r2[0]!, final: final[0]! };
}

/** The page playoff's four lines (RB4-S2), found by their feed edges: Q1 feeds the final AND Q2 (its loser). */
async function pageLines(stageId: string) {
  const rows = await rowsOf(stageId);
  const final = rows.filter((r) => r.winner_to_fixture === null);
  const q1 = rows.filter((r) => r.loser_to_fixture !== null);
  const q2 = rows.filter((r) => q1.length === 1 && r.id === q1[0]!.loser_to_fixture);
  const e = rows.filter((r) => q2.length === 1 && r.winner_to_fixture === q2[0]!.id && r.id !== q1[0]!.id);
  expect([rows.length, q1.length, e.length, q2.length, final.length], "premise: Q1, E, Q2 and the final").toEqual([4, 1, 1, 1, 1]);
  return { q1: q1[0]!, e: e[0]!, q2: q2[0]!, final: final[0]! };
}

describe.skipIf(!HAS_DB)("a withdrawal inside a final-stage stepladder (X-SP-3, seating; ranks are PR B's, C6)", () => {
  it.each(SPORTS)("%s: the seeding is RB4-S1's — R1 = 4 v 3, R2 waits for its winner beside seed 2, the final beside seed 1", async (sport) => {
    const f = await seededFinals(sport, "stepladder");
    const { r1, r2, final } = await rungs(f.stageId);
    expect(pair(r1)).toEqual(sorted(f.seed[3], f.seed[4]));
    expect([r2.home_entrant_id, r2.away_entrant_id].filter(Boolean)).toEqual([f.seed[2]]);
    expect([final.home_entrant_id, final.away_entrant_id].filter(Boolean)).toEqual([f.seed[1]]);
  });

  it.each(SPORTS)("%s: X-SP-3 seed 2 withdraws with R2 seated (R1 played): R2 walks over to R1's winner, the final is seed 1 v that climber, nothing voided", async (sport) => {
    const f = await seededFinals(sport, "stepladder");
    const { r1, r2, final } = await rungs(f.stageId);
    await win(f.auth, sport, r1.id, f.seed[3]);
    expect(pair(await fixtureRow(r2.id)), "R2 seated before the withdrawal").toEqual(sorted(f.seed[2], f.seed[3]));
    const out = await withdrawEntrantCascade(f.auth, f.seed[2]);
    expect(out).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0 });
    expect(walkedOverTo(await fixtureRow(r2.id))).toEqual({ status: "forfeited", kind: "award", winner: f.seed[3] });
    expect(pair(await fixtureRow(final.id)), "the final: seed 1 v the climber").toEqual(sorted(f.seed[1], f.seed[3]));
    expect(await nothingVoided(f.stageId)).toEqual({ rows: 0, events: 0 });
    // The final is still a match to play (scheduled), and the withdrawn seed sits on no line but the one walked over.
    expect((await fixtureRow(final.id)).status).toBe("scheduled");
    expect(await seatsOf(f.stageId, f.seed[2])).toEqual([r2.ext_key]);
  });

  it.each(SPORTS)("%s: X-SP-3 seed 2 withdraws BEFORE R1 is played (R2's other seat still empty): the climber walks R2 over on arrival, nothing voided", async (sport) => {
    const f = await seededFinals(sport, "stepladder");
    const { r1, r2, final } = await rungs(f.stageId);
    const out = await withdrawEntrantCascade(f.auth, f.seed[2]);
    expect(out).toMatchObject({ voided: 0 });
    const held = await fixtureRow(r2.id);
    expect([held.status, held.home_entrant_id === f.seed[2] || held.away_entrant_id === f.seed[2]], "R2 waits; seed 2 is off it").toEqual(["scheduled", false]);
    await win(f.auth, sport, r1.id, f.seed[4]); // the lower seed climbs, so the right answer differs from "seed 3"
    expect(walkedOverTo(await fixtureRow(r2.id)), "R1's winner walks R2 over").toEqual({ status: "forfeited", kind: "award", winner: f.seed[4] });
    expect(pair(await fixtureRow(final.id))).toEqual(sorted(f.seed[1], f.seed[4]));
    expect(await nothingVoided(f.stageId)).toEqual({ rows: 0, events: 0 });
    expect(await seatsOf(f.stageId, f.seed[2]), "never seated after withdrawing").toEqual([]);
  });

  it.each(SPORTS)("%s: sequence — then seed 1 withdraws from the final: the climber walks the final over; a second withdrawal of either is refused and changes nothing", async (sport) => {
    const f = await seededFinals(sport, "stepladder");
    const { r1, r2, final } = await rungs(f.stageId);
    await win(f.auth, sport, r1.id, f.seed[3]);
    await withdrawEntrantCascade(f.auth, f.seed[2]);
    const before = await rowsOf(f.stageId);
    await expect(withdrawEntrantCascade(f.auth, f.seed[2]), "a second call").rejects.toMatchObject({ status: 409 });
    expect(await rowsOf(f.stageId), "the refused second call wrote nothing").toEqual(before);
    await withdrawEntrantCascade(f.auth, f.seed[1]);
    expect(walkedOverTo(await fixtureRow(final.id)), "the final walks over to the climber").toEqual({ status: "forfeited", kind: "award", winner: f.seed[3] });
    expect(walkedOverTo(await fixtureRow(r2.id))).toEqual({ status: "forfeited", kind: "award", winner: f.seed[3] });
    expect(await nothingVoided(f.stageId)).toEqual({ rows: 0, events: 0 });
    await expect(withdrawEntrantCascade(f.auth, f.seed[1])).rejects.toMatchObject({ status: 409 });
  });
});

describe.skipIf(!HAS_DB)("a withdrawal inside a final-stage page playoff (X-SP-5, seating; ranks are PR B's, C6)", () => {
  it.each(SPORTS)("%s: the seeding is RB4-S2's — Q1 = 1 v 2, E = 3 v 4, Q2 and the final wait", async (sport) => {
    const f = await seededFinals(sport, "page_playoff");
    const { q1, e, q2, final } = await pageLines(f.stageId);
    expect(pair(q1)).toEqual(sorted(f.seed[1], f.seed[2]));
    expect(pair(e)).toEqual(sorted(f.seed[3], f.seed[4]));
    expect([pair(q2), pair(final)]).toEqual([[null, null], [null, null]]);
  });

  it.each(SPORTS)("%s: X-SP-5 a Q1 withdrawal walks Q1 over, then Q2 over to E's winner; the final is Q1's other side v E's winner, nothing voided", async (sport) => {
    const f = await seededFinals(sport, "page_playoff");
    const { q1, e, q2, final } = await pageLines(f.stageId);
    const out = await withdrawEntrantCascade(f.auth, f.seed[1]);
    expect(out).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0 });
    expect(walkedOverTo(await fixtureRow(q1.id)), "Q1 walks over to its other side").toEqual({ status: "forfeited", kind: "award", winner: f.seed[2] });
    expect(seatOf(await fixtureRow(final.id), q1.winner_to_slot), "Q1's winner waits in the final").toBe(f.seed[2]);
    expect(seatOf(await fixtureRow(q2.id), q1.loser_to_slot), "Q1's loser — the withdrawn seed — is never seated in Q2").toBeNull();
    await win(f.auth, sport, e.id, f.seed[4]); // the lower seed wins E, so the right answer differs from "seed 3"
    expect(walkedOverTo(await fixtureRow(q2.id)), "Q2 walks over to E's winner").toEqual({ status: "forfeited", kind: "award", winner: f.seed[4] });
    const fin = await fixtureRow(final.id);
    expect([fin.status, pair(fin)], "the final: Q1's other side v E's winner").toEqual(["scheduled", sorted(f.seed[2], f.seed[4])]);
    expect(await nothingVoided(f.stageId)).toEqual({ rows: 0, events: 0 });
    expect(await seatsOf(f.stageId, f.seed[1]), "seated on Q1 only, never after").toEqual([q1.ext_key]);
  });

  it.each(SPORTS)("%s: X-SP-5 order reversed — E played first, then the Q1 withdrawal walks Q1 AND Q2 over at once; the same final, nothing voided", async (sport) => {
    const f = await seededFinals(sport, "page_playoff");
    const { q1, e, q2, final } = await pageLines(f.stageId);
    await win(f.auth, sport, e.id, f.seed[3]);
    expect(seatOf(await fixtureRow(q2.id), e.winner_to_slot), "E's winner waits in Q2").toBe(f.seed[3]);
    await withdrawEntrantCascade(f.auth, f.seed[1]);
    expect(walkedOverTo(await fixtureRow(q1.id))).toEqual({ status: "forfeited", kind: "award", winner: f.seed[2] });
    expect(walkedOverTo(await fixtureRow(q2.id)), "Q2 walks over to E's winner").toEqual({ status: "forfeited", kind: "award", winner: f.seed[3] });
    expect(pair(await fixtureRow(final.id))).toEqual(sorted(f.seed[2], f.seed[3]));
    expect(await nothingVoided(f.stageId)).toEqual({ rows: 0, events: 0 });
    expect(await seatsOf(f.stageId, f.seed[1])).toEqual([q1.ext_key]);
  });

  it.each(SPORTS)("%s: a Q2-bound withdrawal after Q1 is played: Q1's loser withdraws from Q2 and E's winner walks it over into the final", async (sport) => {
    const f = await seededFinals(sport, "page_playoff");
    const { q1, e, q2, final } = await pageLines(f.stageId);
    await win(f.auth, sport, q1.id, f.seed[1]);
    await win(f.auth, sport, e.id, f.seed[3]);
    expect(pair(await fixtureRow(q2.id)), "Q2: Q1's loser v E's winner").toEqual(sorted(f.seed[2], f.seed[3]));
    await withdrawEntrantCascade(f.auth, f.seed[2]);
    expect(walkedOverTo(await fixtureRow(q2.id))).toEqual({ status: "forfeited", kind: "award", winner: f.seed[3] });
    expect(pair(await fixtureRow(final.id))).toEqual(sorted(f.seed[1], f.seed[3]));
    expect(await nothingVoided(f.stageId)).toEqual({ rows: 0, events: 0 });
  });
});

// W4 app PR B (C19, C12, C23; X-SP-4, X-SP-5): the RANK assertions the seating tests above left to PR B. The league's order is
// the REVERSE of the registration seeds (`reverse`), so a rank read from a registration seed instead of the draw seed is
// wrong. Expected ranks come from the rulebook rows and from fixture outcomes read from the database, never from the code:
//  - RB4-S4 / X-SP-4: a withdrawn stepladder seed ranks as the loser of the rung she was due to enter. K=4: seed 2 enters
//    R2, so she is R2's loser - 3rd, below the final's loser (2nd) and above R1's loser (4th).
//  - RB4-S5 / X-SP-5: a withdrawn page-playoff entrant ranks below everyone still in the stage - 4th.
const outcomeOf = (r: FixtureRow) => r.outcome as { winner: string; loser?: string | null };
const loserOfRow = (r: FixtureRow) => (outcomeOf(r).winner === r.home_entrant_id ? r.away_entrant_id : r.home_entrant_id)!;
/** The ranks `completeStage` answers (`stage_completed.finalRanks`, ids in rank order). */
async function completeRanks(auth: AuthCtx, stageId: string): Promise<string[]> {
  const done = await completeStage(auth, stageId);
  expect(done.completed, "the stage completes").toBe(true);
  const ev = done.events.find((e) => e.type === "stage_completed");
  if (ev?.type !== "stage_completed") throw new Error("rig: no stage_completed event");
  return ev.finalRanks;
}

describe.skipIf(!HAS_DB)("a withdrawn finalist stage seed is RANKED (X-SP-4 / X-SP-5; the draw order is not the registration order)", () => {
  it.each(SPORTS)("%s: X-SP-4 stepladder - seed 2 withdraws before R1: she ranks 3rd (the loser of R2, the rung she was due to enter)", async (sport) => {
    const f = await seededFinals(sport, "stepladder", { reverse: true });
    const { r1, r2, final } = await rungs(f.stageId);
    expect(pair(r1), "premise: the draw seeds are the league order, not the registration seeds").toEqual(sorted(f.seed[3], f.seed[4]));
    await withdrawEntrantCascade(f.auth, f.seed[2]);
    await win(f.auth, sport, r1.id, f.seed[4]); // the lower seed climbs
    await win(f.auth, sport, final.id, f.seed[1]);
    const ranks = await completeRanks(f.auth, f.stageId);
    const r1After = await fixtureRow(r1.id);
    const finalAfter = await fixtureRow(final.id);
    expect(ranks, "every seed once: champion, final's loser, the withdrawn seed (R2's loser), R1's loser").toEqual([
      outcomeOf(finalAfter).winner,
      loserOfRow(finalAfter),
      f.seed[2],
      loserOfRow(r1After),
    ]);
    expect(ranks.indexOf(f.seed[2]) + 1).toBe(3);
    // R2 was walked over to the climber (seed 4) the moment R1 decided: the comment's claim, asserted.
    expect(walkedOverTo(await fixtureRow(r2.id)), "R2 walks over to R1's winner").toEqual({ status: "forfeited", kind: "award", winner: f.seed[4] });
  });

  it.each(SPORTS)("%s: X-SP-5 page playoff - seed 1 withdraws before Q1: she ranks 4th, below the eliminator's loser", async (sport) => {
    const f = await seededFinals(sport, "page_playoff", { reverse: true });
    const { q1, e, final } = await pageLines(f.stageId);
    expect(pair(q1), "premise: Q1 is the draw's seeds 1 v 2").toEqual(sorted(f.seed[1], f.seed[2]));
    await withdrawEntrantCascade(f.auth, f.seed[1]);
    await win(f.auth, sport, e.id, f.seed[4]);
    await win(f.auth, sport, final.id, f.seed[4]);
    const ranks = await completeRanks(f.auth, f.stageId);
    const eAfter = await fixtureRow(e.id);
    expect(ranks).toEqual([f.seed[4], f.seed[2], loserOfRow(eAfter), f.seed[1]]);
    expect(ranks.indexOf(f.seed[1]) + 1, "last: below everyone still in the stage").toBe(4);
  });
});
