// W2b Task 1 — reproduction probes, server side (spec §8.2). Each `it` asserts the Appendix A answer, driven through the
// usecases the buttons call (seedBracket is those usecases in one place), so on main each is RED; the red is recorded
// with its gap id in TR/w2b-repro/ before any fix. It was gated (W2B_REPRO=1) so the build's intermediate pushes stayed
// green while every fixing task ran its probes green; Task 16 removed that gate, and this file now runs as a regression
// suite wherever a database is present. Where a probe compares several facts it compares them as ONE object, so the red diff records every
// fact today's code gets wrong, not only the first.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision, patchDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { finalizeFixture, scoreEvent } from "@/server/usecases/scoring";
import { completeStage, createStages, generateStageFixtures, getStandings } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string; method?: string } | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
}
interface StandingRow {
  entrantId: string;
  played: number;
  won: number;
  lost: number;
  points: number;
  metrics?: Record<string, number>;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, outcome,
           winner_to_fixture, winner_to_slot, loser_to_fixture, loser_to_slot
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
async function fixtureRow(id: string): Promise<Row> {
  const [r] = await sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, outcome,
           winner_to_fixture, winner_to_slot, loser_to_fixture, loser_to_slot
      from fixtures where id = ${id}`;
  if (!r) throw new Error(`no fixture ${id}`);
  return r;
}
const tip = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
/** Append at the fixture's own tip — the console's write, through `scoreEvent`. */
async function post(auth: AuthCtx, id: string, type: string, payload: unknown = {}) {
  return scoreEvent(auth, id, { expected_seq: await tip(id), type, payload } as never);
}
/** A feed edge names seat 1 or 2; anything else is a broken graph, not "no seat". */
function seatOf(r: Row, slot: number | null): string | null {
  if (slot === 1) return r.home_entrant_id;
  if (slot === 2) return r.away_entrant_id;
  throw new Error(`fixture ${r.id}: a feed edge names slot ${slot}`);
}
const moduleOf = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no module ${key}`);
  return m;
};
/** The variant's declared cfg, parsed by the module's own schema — the engine's declaration, never a typed table. */
const declaredCfg = (sport: string, variant: string) =>
  moduleOf(sport).configSchema.parse(moduleOf(sport).variants[declaredVariant(sport, variant)]) as Record<string, unknown>;
const standings = async (auth: AuthCtx, stageId: string) => (await getStandings(auth, stageId)).rows as StandingRow[];
const entrantBySeed = async (divisionId: string, seed: number) =>
  (await sql<{ id: string }[]>`select id from entrants where division_id = ${divisionId} and seed = ${seed}`)[0]!.id;
const activeAbandons = async (fixtureId: string) =>
  (
    await sql<{ n: number }[]>`
      select count(*)::int as n from score_events a
       where a.fixture_id = ${fixtureId} and a.type = 'core.abandon'
         and not exists (select 1 from score_events v where v.fixture_id = a.fixture_id and v.voids_event_id = a.id)`
  )[0]!.n;

/** An entrant's display name (seedBracket names them B1..Bn), so a red names people, not uuids. */
const nameOf = async (id: string | null | undefined) =>
  id == null ? null : ((await sql<{ n: string }[]>`select display_name as n from entrants where id = ${id}`)[0]?.n ?? id);
/** Assert the Appendix A answer as ONE object, with today's facts in the message's first line: the JSON reporter elides
 *  a nested diff ("{ …(2) }"), and the evidence README quotes that line. */
function expectFacts(got: Record<string, unknown> | unknown[], want: Record<string, unknown> | unknown[]): void {
  expect(got, `today: ${JSON.stringify(got)}`).toEqual(want);
}

/** Football 0-0 at full time: a play-produced level result, which a bracket HOLDS (needs_decision, X-BR-2). The
 *  brief's rig named badminton "through an abandon with a level outcome"; today an active abandon answers `abandoned`
 *  before the level-result rule (append-event.ts `fixtureStatusFromFold` order 2 before 3), and a badminton match has
 *  no level result, so the held shape is reached the way the W2a suite reaches it (dead-feeder-cascade.test.ts). */
async function heldFootballSemi(auth: AuthCtx, id: string): Promise<Row> {
  await post(auth, id, "core.start");
  await post(auth, id, "football.period", { phase: "HT" });
  await post(auth, id, "football.period", { phase: "FT" });
  const r = await fixtureRow(id);
  expect([r.status, r.outcome?.kind], "rig: the semi is held").toEqual(["needs_decision", "draw"]);
  return r;
}

describe.runIf(HAS_DB)("W2b reproduction probes (server)", () => {
  it("ST-G1: a cricket DLS abandon in a league scores in the table (CK-AB-1)", async () => {
    // single-sport: cricket is the one sport with a DLS result (CK-AB-1).
    const cfg: Record<string, unknown> = { ...declaredCfg("cricket", "t20"), dls: { enabled: true, edition: "standard" } };
    const s = await seedBracket({ sport: "cricket", variant: "t20", stageKind: "league", entrants: 2, divisionConfig: cfg });
    const id = s.fixtureIds[0]!;
    const minBalls = (cfg.minOversForResult as number) * (cfg.ballsPerOver as number);
    await post(s.auth, id, "core.start");
    await post(s.auth, id, "cricket.innings.summary", { runs: 150, wickets: 5, legalBalls: cfg.ballsPerInnings });
    // The chase is past the minimum (twice it), so the rain ending play leaves a DLS result (ICC T20WC PC 16.10).
    await post(s.auth, id, "cricket.innings.summary", { runs: 80, wickets: 2, legalBalls: 2 * minBalls, partial: true });
    await post(s.auth, id, "core.abandon", { reason: "rain" });
    const r = await fixtureRow(id);
    const won = (await standings(s.auth, s.stageId)).map((x) => x.won).sort().reverse();
    expectFacts({ status: r.status, won }, { status: "decided", won: [1, 0] });
  });

  it("CR-2: a cricket rain no-result in a league is 1 point each and an NR (CK-AB-2)", async () => {
    // single-sport: the no-result-with-points rule is cricket's (ICC T20WC PC 16.10.3).
    const s = await seedBracket({ sport: "cricket", variant: "t20", stageKind: "league", entrants: 2 });
    const id = s.fixtureIds[0]!;
    await post(s.auth, id, "core.start");
    await post(s.auth, id, "core.abandon", { reason: "rain" }); // before the minimum overs
    const r = await fixtureRow(id);
    const rows = await standings(s.auth, s.stageId);
    expectFacts({ status: r.status, points: rows.map((x) => x.points) }, { status: "decided", points: [1, 1] });
  });

  it("ST-G1b: a football award-policy abandon with a leader is a win (FB-AB-1)", async () => {
    // single-sport: football is the module whose `abandonPolicy: "award"` the gap names (the period sports share it, Task 4).
    const cfg = { ...declaredCfg("football", "11-a-side"), abandonPolicy: "award" };
    const s = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "league", entrants: 2, divisionConfig: cfg });
    const id = s.fixtureIds[0]!;
    const f = await fixtureRow(id);
    await post(s.auth, id, "core.start");
    await post(s.auth, id, "football.goal", { by: f.home_entrant_id });
    await post(s.auth, id, "core.abandon", { reason: "crowd trouble" });
    const r = await fixtureRow(id);
    const rows = await standings(s.auth, s.stageId);
    const of = (e: string | null) => rows.find((x) => x.entrantId === e);
    expectFacts(
      { status: r.status, homeWon: of(f.home_entrant_id)?.won ?? null, awayLost: of(f.away_entrant_id)?.lost ?? null },
      { status: "decided", homeWon: 1, awayLost: 1 },
    );
  });

  it("C17: withdrawing from a held knockout fixture walks it over to the remaining side (X-WD-1)", async () => {
    // single-sport: football reaches a held bracket fixture by play (0-0 FT); see heldFootballSemi for why not badminton.
    // stageRules {}: every preset decider off (W2c X-SR-6: a knockout otherwise starts with extra time and penalties).
    const s = await seedBracket({ sport: "football", variant: declaredVariant("football", "11-a-side"), stageKind: "knockout", entrants: 4, stageRules: {} });
    const sf1 = await heldFootballSemi(s.auth, s.fixtureIds[0]!);
    await withdrawEntrantCascade(s.auth, sf1.home_entrant_id!);
    const after = await fixtureRow(sf1.id);
    const final = await fixtureRow(sf1.winner_to_fixture!);
    const away = await nameOf(sf1.away_entrant_id);
    expectFacts(
      { status: after.status, winner: await nameOf(after.outcome?.winner), inFinal: await nameOf(seatOf(final, sf1.winner_to_slot)) },
      { status: "forfeited", winner: away, inFinal: away },
    );
  });

  it("PP-WD: a page_playoff withdrawal walks over, never holds (X-WD-2)", async () => {
    // single-sport: badminton, the W2a page_playoff withdrawal rig (dead-feeder-cascade.test.ts).
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "page_playoff", entrants: 4 });
    const q1 = (await rowsOf(s.stageId)).find((r) => r.home_entrant_id && r.away_entrant_id && r.winner_to_fixture && r.loser_to_fixture);
    if (!q1) throw new Error("page_playoff: no seated qualifier with both edges");
    await withdrawEntrantCascade(s.auth, q1.home_entrant_id!);
    const after = await fixtureRow(q1.id);
    expectFacts(
      { status: after.status, abandons: await activeAbandons(q1.id), winner: await nameOf(after.outcome?.winner) },
      { status: "forfeited", abandons: 0, winner: await nameOf(q1.away_entrant_id) },
    );
  });

  it("LD-WD: a ladder withdrawal walks the pending challenge over (X-WD-2)", async () => {
    // single-sport: badminton; seedBracket issues seed 2's challenge against seed 1, the holder, who withdraws.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "ladder", entrants: 4 });
    const challenge = s.fixtureIds[0]!;
    const holder = await entrantBySeed(s.divisionId, 1);
    const challenger = await entrantBySeed(s.divisionId, 2);
    await withdrawEntrantCascade(s.auth, holder);
    const after = await fixtureRow(challenge);
    expectFacts(
      { status: after.status, abandons: await activeAbandons(challenge), winner: await nameOf(after.outcome?.winner) },
      { status: "forfeited", abandons: 0, winner: await nameOf(challenger) },
    );
  });

  it("X-WD-3: withdrawing from a fixture whose opponent is TBD does not throw (X-WD-3)", async () => {
    // single-sport: badminton. Six entrants in an eight-line draw: the generator gives seeds 1 and 2 byes, so each is
    // seated in round 2 against the winner of a round-1 line nobody has played. The brief's "knockout of 8" has no bye.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 6 });
    const rows = await rowsOf(s.stageId);
    const tbd = rows.find((r) => (r.home_entrant_id === null) !== (r.away_entrant_id === null) && r.status === "scheduled");
    if (!tbd) throw new Error(`rig: no scheduled line with one seat filled and one TBD (${rows.map((r) => `${r.ext_key}:${r.status}`).join(", ")})`);
    const seated = (tbd.home_entrant_id ?? tbd.away_entrant_id)!;
    const out = await withdrawEntrantCascade(s.auth, seated);
    expect(out).toMatchObject({ entrant_id: seated, status: "withdrawn" });
  });

  it("CD-T13: a chess knockout withdrawal on an unstarted board walks over (BG-WO-2)", async () => {
    // single-sport: the WRONG_PHASE refusal is chess's (boardgame.ts core.forfeit outside phase "live").
    const s = await seedBracket({ sport: "boardgame", variant: declaredVariant("boardgame", "classical"), stageKind: "knockout", entrants: 4 });
    const S1 = await entrantBySeed(s.divisionId, 1);
    const [board] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id === S1 || r.away_entrant_id === S1);
    if (!board) throw new Error("rig: seed 1 has no board");
    const opponent = board.home_entrant_id === S1 ? board.away_entrant_id : board.home_entrant_id;
    await withdrawEntrantCascade(s.auth, S1);
    const after = await fixtureRow(board.id);
    expectFacts({ status: after.status, winner: await nameOf(after.outcome?.winner) }, { status: "forfeited", winner: await nameOf(opponent) });
  });

  it("CD-T13-SW: a Swiss chess withdrawal on an unstarted board walks over (BG-WO-2)", async () => {
    // single-sport: the chess copy of swiss-withdrawal-walkover.test.ts's pairedRoundOne (that file is badminton).
    const s = await seedBracket({
      sport: "boardgame",
      variant: declaredVariant("boardgame", "classical"),
      stageKind: "swiss",
      entrants: 4,
      stageConfig: { rounds: 2 },
    });
    const S4 = await entrantBySeed(s.divisionId, 4);
    const [board] = (await rowsOf(s.stageId)).filter((r) => r.round_no === 1 && (r.home_entrant_id === S4 || r.away_entrant_id === S4));
    if (!board) throw new Error("rig: S4 has no round-1 board");
    const opponent = board.home_entrant_id === S4 ? board.away_entrant_id : board.home_entrant_id;
    await withdrawEntrantCascade(s.auth, S4);
    const after = await fixtureRow(board.id);
    expectFacts({ status: after.status, winner: await nameOf(after.outcome?.winner) }, { status: "forfeited", winner: await nameOf(opponent) });
  });

  // Two outcome shapes a forfeit takes today: badminton folds a walkover to `award`, chess folds a forfeit to
  // `win{method:"forfeit"}`. X-DE-1 names every forfeit loser, so both are probed and compared as one table.
  const DE_SHAPES = [
    { sport: "badminton", variant: "bwf" },
    { sport: "boardgame", variant: "classical" },
  ] as const;
  const DE_PER_SHAPE_MS = 6_000;
  it(
    "DE-RK: a double-elimination forfeit loser is out; seating and ranks agree (X-DE-1)",
    async () => {
      const observed: unknown[] = [];
      const expected: unknown[] = [];
      for (const shape of DE_SHAPES) {
        const s = await seedBracket({ sport: shape.sport, variant: declaredVariant(shape.sport, shape.variant), stageKind: "double_elim", entrants: 4 });
        const wb1 = (await rowsOf(s.stageId)).find((r) => r.ext_key?.startsWith("wb-") && r.home_entrant_id && r.away_entrant_id);
        if (!wb1) throw new Error(`${shape.sport}: no seated winners'-bracket line`);
        const out = wb1.away_entrant_id!;
        // The walkover. Chess records it once the session has started (FIDE 6.7.1; boardgame refuses it before, B-7).
        if (shape.sport === "boardgame") await post(s.auth, wb1.id, "core.start");
        await post(s.auth, wb1.id, "core.forfeit", { by: out, reason: "walkover" });
        // Play every line out. Wherever the forfeit loser IS seated it wins, so a wrong seat shows in the ranks too.
        for (let guard = 0, open = 1; open > 0; guard++) {
          if (guard > 12) throw new Error(`${shape.sport}: play-out did not converge`);
          const lines = (await rowsOf(s.stageId)).filter((r) => r.status === "scheduled" && r.home_entrant_id && r.away_entrant_id);
          open = lines.length;
          for (const r of lines) {
            const homeWins = r.away_entrant_id !== out;
            await post(s.auth, r.id, "core.start");
            if (shape.sport === "boardgame") {
              await post(s.auth, r.id, "boardgame.result", { winner: homeWins ? r.home_entrant_id : r.away_entrant_id, method: "checkmate" });
            } else {
              for (let g = 0; g < 2; g++) await post(s.auth, r.id, "badminton.game.summary", homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 });
            }
          }
        }
        const after = await rowsOf(s.stageId);
        const seatedInLosers = after.filter((r) => r.ext_key?.startsWith("lb-") && (r.home_entrant_id === out || r.away_entrant_id === out)).length;
        const done = await completeStage(s.auth, s.stageId);
        const ev = done.events.find((e) => e.type === "stage_completed");
        const ranks = ev?.type === "stage_completed" ? ev.finalRanks : [];
        observed.push({ sport: shape.sport, seatedInLosers, completed: done.completed, rankOfOut: ranks.indexOf(out) + 1, ranked: ranks.length });
        // Out in winners' round 1, the earliest anybody goes out of a four-entrant double elimination: ranked last.
        expected.push({ sport: shape.sport, seatedInLosers: 0, completed: true, rankOfOut: 4, ranked: 4 });
      }
      expect(observed.length, "shapes checked").toBe(DE_SHAPES.length);
      expectFacts(observed, expected);
    },
    Math.max(30_000, DE_SHAPES.length * DE_PER_SHAPE_MS * 5),
  );

  it("AA-FIN: auto-advance treats a finalized fixture as finished (D18)", async () => {
    // single-sport: generic, the auto_progress rig of format-ext.test.ts; the open count is sport-blind. A league
    // stands for the brief's "group" — the open count reads the stage's fixtures whatever its kind.
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "AA " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 6),
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    await createEntrants(
      auth,
      division.id,
      ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
    );
    await patchDivision(auth, division.id, { auto_progress: true });
    const [group, ko] = await createStages(auth, division.id, [
      { seq: 1, kind: "league", name: "Group", config: {} },
      {
        seq: 2,
        kind: "knockout",
        name: "Final",
        config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "on_complete" },
      },
    ]);
    const { fixtures } = await generateStageFixtures(auth, group!.id);
    await startDivision(auth, division.id);
    expect(fixtures.length, "rig: the group has fixtures").toBeGreaterThan(0);
    // Each fixture is decided and then finalized before the next is decided, so when the LAST one decides, every
    // other one is already `finalized` — finished (spec §13 premise 9).
    for (const f of fixtures) {
      await post(auth, f.id, "core.start");
      await post(auth, f.id, "generic.result", { p1Score: 2, p2Score: 0 });
      await finalizeFixture(auth, f.id, await tip(f.id)); // the console's Finalize
    }
    const [statuses] = await sql<{ s: string[] }[]>`select array_agg(distinct status) as s from fixtures where stage_id = ${group!.id}`;
    const [ko1] = await sql<{ n: number; seated: number }[]>`
      select count(*)::int as n, count(*) filter (where home_entrant_id is not null and away_entrant_id is not null)::int as seated
        from fixtures where stage_id = ${ko!.id}`;
    // The progression takes ranks 1-2, so the knockout is one final with both seats filled.
    expectFacts({ group: statuses!.s, koFixtures: ko1!.n, koSeated: ko1!.seated }, { group: ["finalized"], koFixtures: 1, koSeated: 1 });
  });

  it("X-WD-5: a settle never seats a withdrawn loser on a loser edge", async () => {
    // single-sport: football, the held-semi rig (heldFootballSemi). The other semi is played to a real 1-0 win so the
    // third-place line has a real loser waiting on the held semi's loser edge.
    const s = await seedBracket({
      sport: "football",
      variant: declaredVariant("football", "11-a-side"),
      stageKind: "knockout",
      entrants: 4,
      stageConfig: { thirdPlace: true },
      stageRules: {}, // every preset decider off (W2c X-SR-6: a knockout otherwise starts with extra time and penalties)
    });
    const [a, b] = s.fixtureIds;
    const sf2 = await fixtureRow(b!);
    await post(s.auth, sf2.id, "core.start");
    await post(s.auth, sf2.id, "football.goal", { by: sf2.home_entrant_id });
    await post(s.auth, sf2.id, "football.period", { phase: "HT" });
    await post(s.auth, sf2.id, "football.period", { phase: "FT" });
    expect((await fixtureRow(sf2.id)).outcome, "rig: the other semi has a loser").toMatchObject({ kind: "win", loser: sf2.away_entrant_id });
    const sf1 = await heldFootballSemi(s.auth, a!);
    const withdrawn = sf1.away_entrant_id!;
    await withdrawEntrantCascade(s.auth, withdrawn);
    // The organiser's way out of a hold W2a left in place (ruling C17). Once W2b walks the hold over (X-WD-1) there
    // is no hold left to settle, and the third-place line must read the same either way.
    if ((await fixtureRow(sf1.id)).status === "needs_decision") {
      await post(s.auth, sf1.id, "core.settle", { winner: sf1.home_entrant_id, method: "organiser" });
    }
    const third = await fixtureRow(sf1.loser_to_fixture!);
    expectFacts(
      { seat: await nameOf(seatOf(third, sf1.loser_to_slot)), status: third.status, winner: await nameOf(third.outcome?.winner), withdrawn: await nameOf(withdrawn) },
      { seat: null, status: "forfeited", winner: await nameOf(sf2.away_entrant_id), withdrawn: await nameOf(withdrawn) },
    );
  });
});
