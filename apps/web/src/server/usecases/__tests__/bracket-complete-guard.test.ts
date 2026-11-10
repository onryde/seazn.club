// W4 app-A Task 6 (gap AN-2, the app half of engine row X-CH-7; X-CH-2 and X-CH-5 pinned).
//
// AN-2: the engine completes a bracket once every FINAL is settled (`isBracketStageComplete`), and a third-place line is
// never a final — so an organiser who scored the semis and the final could Complete the stage with its third-place match
// still unplayed, and the division read "Finished" beside a missing result (prod data). `completeStage` now asks one
// more question at exactly the point the engine says yes: is there a line of this bracket still owed a result
// (`undecidedBracketFixtures`)? If so the Complete is refused by name — STAGE_HAS_UNDECIDED_FIXTURES, 409, "This bracket
// still has matches without a result. Finish or settle them first." with the lines' ids (the plan's code, status and
// sentence, typed here). Controller ruling C4: a final NOT yet settled keeps today's soft `{completed: false}`; the 409
// fires only when the engine WOULD complete.
//
// X-CH-2 (pinned): a finalist withdraws — the final is a `withdrew` walkover to the other finalist, the stage completes,
// and the division's champion is them. X-CH-5 (pinned, owner ruling 275): an unplayed final is never decided
// automatically — no auto-advance pass, no completion read, and no outcome naming a seed or a table; an organiser's
// explicit Settle on an abandoned final still decides it.
//
// Expected values come from the rulebook rows and from rows this file reads BEFORE the step under test — never from the
// code under test.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { completeStageIfReady } from "@/server/engine-db";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, playBadminton, post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { divisionChampion, type ChampionFixture, type ChampionStage, type ChampionStandings } from "@/server/public-site/champion";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { startDivision } from "../schedule";
import { completeStage, createStages, generateStageFixtures, undecidedBracketFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The plan's refusal (Task 6), typed here — never read back from the refusal table. */
const UNDECIDED = { status: 409, code: "STAGE_HAS_UNDECIDED_FIXTURES" } as const;

interface Line {
  id: string;
  round_no: number;
  seq_in_round: number;
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string | null; reason?: string; method?: string } | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  winner_to_fixture: string | null;
  loser_to_fixture: string | null;
  is_final: boolean;
  third_place: boolean;
  conditional: boolean;
}
const linesOf = (stageId: string) =>
  sql<Line[]>`
    select id, round_no, seq_in_round, status, outcome, home_entrant_id, away_entrant_id, winner_to_fixture,
           loser_to_fixture, is_final, third_place, conditional
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const stageStatus = async (stageId: string) =>
  (await sql<{ status: string }[]>`select status from stages where id = ${stageId}`)[0]!.status;
const snapshots = async (stageId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from standings_snapshots where stage_id = ${stageId}`)[0]!.n;
const ledgerTypes = async (divisionId: string) =>
  (await sql<{ type: string }[]>`select type from division_events where division_id = ${divisionId} order by seq`).map((r) => r.type);
const undecided = (stageId: string) => sql.begin((tx) => undecidedBracketFixtures(tx as never, stageId));

/** The two sports this file plays: badminton by straight games, chess (boardgame) by a checkmate. */
const SPORTS = [
  { sport: "badminton", variant: "bwf" },
  { sport: "boardgame", variant: "classical" },
] as const;
type Sport = (typeof SPORTS)[number]["sport"];

/** Play a seated line to a real result: the home side wins when `homeWins`. */
async function decide(auth: AuthCtx, sport: Sport, line: Line, homeWins: boolean): Promise<void> {
  if (sport === "badminton") {
    await playBadminton(auth, line.id, homeWins);
    return;
  }
  await post(auth, line.id, "core.start");
  await post(auth, line.id, "boardgame.result", { winner: homeWins ? line.home_entrant_id : line.away_entrant_id, method: "checkmate" });
  expect((await fixtureRow(line.id)).status, "rig: the chess line decided").toBe("decided");
}

/** A knockout of four with a third-place line, Started; both semi-finals decided (home wins). */
async function semisDecided(sport: Sport, variant: string) {
  const s = await seedBracket({ sport, variant: declaredVariant(sport, variant), stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
  const before = await linesOf(s.stageId);
  const semis = before.filter((l) => l.winner_to_fixture !== null);
  expect(semis.length, "rig: two semi-finals").toBe(2);
  for (const semi of semis) await decide(s.auth, sport, semi, true);
  const after = await linesOf(s.stageId);
  const final = after.find((l) => l.id === semis[0]!.winner_to_fixture)!;
  const third = after.find((l) => l.id === semis[0]!.loser_to_fixture)!;
  expect(third.third_place, "rig: the semis' losers meet in the third-place line").toBe(true);
  expect([final.home_entrant_id !== null, final.away_entrant_id !== null, third.home_entrant_id !== null, third.away_entrant_id !== null]).toEqual([
    true,
    true,
    true,
    true,
  ]);
  return { ...s, sport, final, third };
}

describe.runIf(HAS_DB)("W4 T6 AN-2: a bracket completes only with every match decided", () => {
  let swept = 0;
  for (const { sport, variant } of SPORTS) {
    it(`X-CH-7 AN-2 a decided final beside an unplayed third-place line cannot be completed — refused by name, nothing written (${sport})`, async () => {
      const r = await semisDecided(sport, variant);
      await decide(r.auth, sport, r.final, true);
      expect((await fixtureRow(r.third.id)).status, "premise: the third-place line is unplayed").toBe("scheduled");
      const ledger = await ledgerTypes(r.divisionId);

      await expect(completeStage(r.auth, r.stageId)).rejects.toMatchObject({ ...UNDECIDED, extra: { fixture_ids: [r.third.id] } });
      expect(await stageStatus(r.stageId), "the stage stays active").toBe("active");
      expect(await snapshots(r.stageId), "no placement snapshot").toBe(0);
      expect(await ledgerTypes(r.divisionId), "no stage_completed, nothing appended").toEqual(ledger);
      // The second call: still refused, still nothing written.
      await expect(completeStage(r.auth, r.stageId)).rejects.toMatchObject(UNDECIDED);
      expect(await stageStatus(r.stageId)).toBe("active");

      // The positive pair: the third-place line decided, the same Complete goes through and ranks four.
      await decide(r.auth, sport, await linesOf(r.stageId).then((ls) => ls.find((l) => l.id === r.third.id)!), true);
      const done = await completeStage(r.auth, r.stageId);
      expect(done.completed).toBe(true);
      const ev = done.events.find((e) => e.type === "stage_completed");
      expect(ev?.type === "stage_completed" ? ev.finalRanks.length : 0, "four entrants ranked").toBe(4);
      expect(await stageStatus(r.stageId)).toBe("complete");
      swept++;
    }, 180_000);
  }
  it("anti-vacuity: both sports were driven", () => expect(swept).toBe(SPORTS.length));

  it("X-CH-7 AN-2 a third-place line IN PLAY, or abandoned and held for a settle, refuses the same way (badminton)", async () => {
    // single-sport: badminton — the refusal reads fixture statuses only; the two sports above already sweep the sport.
    const playing = await semisDecided("badminton", "bwf");
    await playBadminton(playing.auth, playing.final.id, true);
    await post(playing.auth, playing.third.id, "core.start");
    await post(playing.auth, playing.third.id, "badminton.game.summary", { home: 21, away: 10 });
    expect((await fixtureRow(playing.third.id)).status, "premise: in play").toBe("in_play");
    await expect(completeStage(playing.auth, playing.stageId)).rejects.toMatchObject({ ...UNDECIDED, extra: { fixture_ids: [playing.third.id] } });

    const held = await semisDecided("badminton", "bwf");
    await playBadminton(held.auth, held.final.id, true);
    await post(held.auth, held.third.id, "core.start");
    await post(held.auth, held.third.id, "core.abandon", { reason: "rain" });
    const abandoned = await fixtureRow(held.third.id);
    expect([abandoned.status, abandoned.outcome], "premise: abandoned, decided nobody").toEqual(["abandoned", null]);
    await expect(completeStage(held.auth, held.stageId)).rejects.toMatchObject({ ...UNDECIDED, extra: { fixture_ids: [held.third.id] } });
    // The organiser's settle decides it; the Complete then goes through.
    await post(held.auth, held.third.id, "core.settle", { winner: abandoned.home_entrant_id, method: "organiser" });
    expect((await completeStage(held.auth, held.stageId)).completed).toBe(true);
  }, 240_000);

  it("the wire (engine 5.0.0 FinalPlace[]): stage_completed.finalRanks stays entrant ids in rank order - in the response AND in the stored event - and a decided third place splits 3rd from 4th", async () => {
    // Smoke w4KnockoutA, the bench and the matrix read these as strings; the engine's own event carries { entrantId, rank }.
    for (const { sport, variant } of SPORTS) {
      const r = await semisDecided(sport, variant);
      await decide(r.auth, sport, r.final, true);
      await decide(r.auth, sport, r.third, true);
      const done = await completeStage(r.auth, r.stageId);
      expect(done.completed).toBe(true);
      const ev = done.events.find((e) => e.type === "stage_completed");
      expect(ev?.type, `${sport}: the event is returned`).toBe("stage_completed");
      const ranks = ev?.type === "stage_completed" ? ev.finalRanks : [];
      const [stored] = await sql<{ payload: { finalRanks: unknown } }[]>`
        select payload from division_events where division_id = ${r.divisionId} and type = 'stage_completed'`;
      expect(stored!.payload.finalRanks, `${sport}: the stored event carries the same ids`).toEqual(ranks);
      expect(ranks.length, `${sport}: four ranked`).toBe(4);
      expect(ranks.every((id) => typeof id === "string"), `${sport}: plain ids, not places`).toBe(true);
      const after = await linesOf(r.stageId);
      const final = after.find((l) => l.id === r.final.id)!;
      const third = after.find((l) => l.id === r.third.id)!;
      expect(ranks[0], `${sport}: the final's winner is first`).toBe(final.home_entrant_id);
      expect(ranks[1], `${sport}: the final's loser is second`).toBe(final.away_entrant_id);
      expect(ranks[2], `${sport}: the third-place winner is third`).toBe(third.home_entrant_id);
      expect(ranks[3], `${sport}: the third-place loser is fourth`).toBe(third.away_entrant_id);
    }
  }, 240_000);

  it("C4: a final NOT yet settled keeps the soft answer — {completed: false}, no refusal, nothing written", async () => {
    // single-sport: badminton — the engine's own completion predicate answers here; no sport field is read.
    const r = await semisDecided("badminton", "bwf");
    await post(r.auth, r.final.id, "core.start");
    await post(r.auth, r.final.id, "badminton.game.summary", { home: 21, away: 10 });
    const final = await fixtureRow(r.final.id);
    expect([final.status, final.outcome], "premise: the final is in play, no outcome").toEqual(["in_play", null]);
    const out = await completeStage(r.auth, r.stageId);
    expect(out).toMatchObject({ completed: false });
    expect(await stageStatus(r.stageId)).toBe("active");
    expect(await snapshots(r.stageId)).toBe(0);
  }, 180_000);

  it("R-1 consequence stays: a third-place line whose BOTH seats are departure-dead is no match owed — the stage completes on its final", async () => {
    // single-sport: badminton. withdrawal-w2b.test.ts's legacy shape (a disqualification written without the cascade):
    // both semi losers departed, so the third-place line is a bye line nobody can play. Refusing here would hold the
    // stage open forever behind a line with nobody in it.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    const semis = (await linesOf(s.stageId)).filter((l) => l.winner_to_fixture !== null);
    for (const semi of semis) {
      await sql`update entrants set status = 'disqualified' where id = ${semi.away_entrant_id}`;
      await playBadminton(s.auth, semi.id, true);
    }
    const third = await fixtureRow(semis[0]!.loser_to_fixture!);
    expect([third.status, third.home_entrant_id, third.away_entrant_id], "premise: an empty, unplayable line").toEqual(["scheduled", null, null]);
    expect(await undecided(s.stageId), "the final is the one line owed").toEqual([semis[0]!.winner_to_fixture]);
    await playBadminton(s.auth, semis[0]!.winner_to_fixture!, true);
    expect(await undecided(s.stageId), "nothing owed").toEqual([]);
    expect((await completeStage(s.auth, s.stageId)).completed).toBe(true);
  }, 180_000);
});

describe.runIf(HAS_DB)("W4 T6 undecidedBracketFixtures — the lines of a bracket still owed a result", () => {
  it("the empty cases first: a stage with no fixtures, a table stage, an unknown stage — none owed", async () => {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "league", entrants: 4 });
    expect((await linesOf(s.stageId)).length, "premise: the league has scheduled matches").toBeGreaterThan(0);
    expect(await undecided(s.stageId), "a table stage is no bracket").toEqual([]);
    const [bare] = await createStages(s.auth, s.divisionId, { seq: 2, kind: "knockout", name: "Later", config: {}, progression: null });
    expect(await undecided(bare!.id), "a bracket with no fixtures").toEqual([]);
    expect(await undecided(randomUUID()), "an unknown stage").toEqual([]);
  }, 120_000);

  it("a fresh bracket owes every line, in bracket order; a decided line leaves the list; a cancelled one is never owed", async () => {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    const lines = await linesOf(s.stageId);
    expect(lines.length, "premise: two semis, a final, a third-place line").toBe(4);
    expect(await undecided(s.stageId)).toEqual(lines.map((l) => l.id));
    await playBadminton(s.auth, lines[0]!.id, true);
    expect(await undecided(s.stageId), "the decided semi leaves").toEqual(lines.slice(1).map((l) => l.id));
    await sql`update fixtures set status = 'cancelled' where id = ${lines[1]!.id}`;
    expect(await undecided(s.stageId), "a cancelled line is never owed").toEqual(lines.slice(2).map((l) => l.id));
  }, 120_000);

  it("double elimination: the bracket reset is owed only when the losers' champion won the grand final", async () => {
    // single-sport: badminton — the reset rule is the engine's harness rule (champion.ts): owed iff the grand final's
    // winner is not its home entrant (the winners' champion sits at home).
    // B1b review M5: that last clause is the code's own assumption, so the expected value is NOT read from it. It is the
    // rulebook's: the winners' champion is the grand finalist who has lost no match, and the reset is owed iff the other
    // one won. A premise then pins that the generator seats that unbeaten finalist at home — the seat `resetOwed` reads —
    // so a generator that seated the losers' champion at home reds the premise instead of inverting code and oracle together.
    let judged = 0;
    for (const gfHomeWins of [true, false]) {
      const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "double_elim", entrants: 4, stageConfig: { bracketReset: true } });
      const reset = (await linesOf(s.stageId)).find((l) => l.conditional);
      expect(reset, "rig: a double elimination with bracketReset draws a conditional reset").toBeDefined();
      for (let guard = 0; guard < 12; guard++) {
        const open = (await linesOf(s.stageId)).filter(
          (l) => !l.conditional && l.status === "scheduled" && l.home_entrant_id !== null && l.away_entrant_id !== null,
        );
        if (open.length === 0) break;
        for (const l of open) await playBadminton(s.auth, l.id, l.is_final ? gfHomeWins : true);
      }
      const gf = (await linesOf(s.stageId)).find((l) => l.is_final && !l.conditional && !l.third_place)!;
      expect(gf.status, "premise: the grand final is decided").toBe("decided");
      expect(gf.outcome?.winner === gf.home_entrant_id, "premise: the side the case asks for won it").toBe(gfHomeWins);
      const others = (await linesOf(s.stageId)).filter((l) => !l.conditional && l.status !== "decided" && l.status !== "forfeited");
      expect(others, "premise: every other line is settled").toEqual([]);
      // Who lost a match before the grand final, off the stored outcomes (a line's loser is the seat its winner is not).
      const before = (await linesOf(s.stageId)).filter((l) => !l.conditional && l.id !== gf.id && l.outcome?.winner);
      expect(before.length, "anti-vacuity: the lines before the grand final were read").toBeGreaterThan(0);
      const beaten = new Set(before.map((l) => (l.outcome!.winner === l.home_entrant_id ? l.away_entrant_id : l.home_entrant_id)));
      const unbeaten = [gf.home_entrant_id, gf.away_entrant_id].filter((e) => !beaten.has(e));
      expect(unbeaten.length, "premise (rulebook): exactly one grand finalist is unbeaten — the winners' champion").toBe(1);
      expect(unbeaten[0], "premise: the winners' champion sits at the grand final's home (the seat the reset rule reads)").toBe(
        gf.home_entrant_id,
      );
      const resetOwed = gf.outcome!.winner !== unbeaten[0];
      expect(resetOwed, "premise: the case drove the side it asks for").toBe(!gfHomeWins);
      expect(await undecided(s.stageId), resetOwed ? "owed: the losers' champion won" : "not owed: the winners' champion won").toEqual(
        resetOwed ? [reset!.id] : [],
      );
      judged++;
    }
    expect(judged).toBe(2);
  }, 300_000);
});

/** A badminton doubles knockout of four PAIRS, generated and Started (seedBracket seeds the sport's default kind,
 *  individuals). Each pair is two people. */
async function pairKnockout() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Doubles ${randomUUID().slice(0, 6)}`, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open doubles",
    slug: "dbl-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  const person = async (name: string) =>
    (await createPerson(auth, { full_name: name, consent: {}, dob: null, gender: null, external_ref: null })).id;
  const pairs = [];
  for (let i = 1; i <= 4; i++) {
    const members = [];
    for (const n of ["a", "b"]) {
      members.push({ person_id: await person(`P${i}${n}`), is_captain: false, roles: [], default_position_key: null, squad_number: null });
    }
    pairs.push({ kind: "pair" as const, display_name: `Pair ${i}`, seed: i, members });
  }
  await createEntrants(auth, division.id, pairs);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null });
  await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  return { auth, divisionId: division.id, stageId: stage!.id };
}

/** The division's crown, through the public site's own reader, off the rows as stored. */
async function championOf(divisionId: string): Promise<string | null> {
  const stages = await sql<ChampionStage[]>`select id, seq, kind, status from stages where division_id = ${divisionId}`;
  const fixtures = await sql<ChampionFixture[]>`
    select f.id, f.stage_id, f.round_no, f.status, f.outcome, f.is_final, f.third_place, f.conditional, f.home_entrant_id
      from fixtures f join stages s on s.id = f.stage_id where s.division_id = ${divisionId}`;
  const standings = await sql<ChampionStandings[]>`
    select ss.stage_id, ss.pool_id, ss.rows from standings_snapshots ss join stages s on s.id = ss.stage_id where s.division_id = ${divisionId}`;
  return divisionChampion(stages, fixtures, standings);
}

describe.runIf(HAS_DB)("W4 T6 X-CH-2 one finalist withdraws: the final walks over and the other is champion", () => {
  let kinds = 0;
  for (const kind of ["individual", "pair"] as const) {
    it(`X-CH-2 one finalist withdraws: the final is a withdrew walkover, the stage completes, the other finalist is champion (${kind})`, async () => {
      const r =
        kind === "individual"
          ? await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 })
          : await pairKnockout();
      const semis = (await linesOf(r.stageId)).filter((l) => l.winner_to_fixture !== null);
      expect(semis.length, "rig: two semi-finals").toBe(2);
      for (const semi of semis) await playBadminton(r.auth, semi.id, true);
      const final = (await linesOf(r.stageId)).find((l) => l.id === semis[0]!.winner_to_fixture)!;
      const [leaver, stayer] = [final.home_entrant_id!, final.away_entrant_id!];
      expect(leaver && stayer, "premise: both finalists seated").toBeTruthy();

      await withdrawEntrantCascade(r.auth, leaver);

      const walked = await fixtureRow(final.id);
      expect(walked.status, "the final is a walkover").toBe("forfeited");
      expect(walked.outcome, "to the finalist who stayed, for the one who withdrew").toMatchObject({
        kind: "award",
        winner: stayer,
        loser: leaver,
        reason: "withdrew",
      });
      const done = await completeStage(r.auth, r.stageId);
      expect(done.completed, "the stage completes on the walkover").toBe(true);
      expect(await championOf(r.divisionId), "the champion is the finalist who stayed").toBe(stayer);
      kinds++;
    }, 180_000);
  }
  it("anti-vacuity: individual and pair both driven", () => expect(kinds).toBe(2));
});

describe.runIf(HAS_DB)("W4 T6 X-CH-5 an unplayed final is never decided automatically (owner ruling 275)", () => {
  /** A knockout of eight with auto-progress on, every line but the final decided through the scorer's own write (each
   *  decision is an auto-advance pass). */
  async function finalUnplayed() {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 8 });
    await patchDivision(s.auth, s.divisionId, { auto_progress: true } as never);
    let passes = 0;
    for (let guard = 0; guard < 6; guard++) {
      const open = (await linesOf(s.stageId)).filter(
        (l) => l.winner_to_fixture !== null && l.status === "scheduled" && l.home_entrant_id !== null && l.away_entrant_id !== null,
      );
      if (open.length === 0) break;
      for (const l of open) {
        await playBadminton(s.auth, l.id, true);
        passes++;
        expect(await stageStatus(s.stageId), "every auto-advance pass leaves the stage active").toBe("active");
      }
    }
    expect(passes, "premise: six lines played before the final (four quarters, two semis)").toBe(6);
    const final = (await linesOf(s.stageId)).find((l) => l.winner_to_fixture === null)!;
    return { ...s, final };
  }

  it("X-CH-5 every auto-advance pass leaves the final undecided and the stage active; no outcome names a seed or a table; the completion read says not yet", async () => {
    // single-sport: badminton — the rule is about who decides a final, not how it is scored.
    const r = await finalUnplayed();
    const final = await fixtureRow(r.final.id);
    expect([final.status, final.outcome, final.home_entrant_id !== null, final.away_entrant_id !== null], "the final waits, seated").toEqual([
      "scheduled",
      null,
      true,
      true,
    ]);
    const outcomes = (await linesOf(r.stageId)).filter((l) => l.outcome !== null);
    expect(outcomes.length, "anti-vacuity: the six decided lines were read").toBe(6);
    for (const l of outcomes) expect(JSON.stringify(l.outcome), `${l.id}: an outcome named for a seed or a table`).not.toMatch(/seed|table/i);
    expect(await completeStageIfReady(r.auth.orgId, r.stageId), "engine-db completion: not yet").toEqual({ completed: false, events: [] });
    expect(await completeStage(r.auth, r.stageId), "the organiser's Complete: not yet, no refusal").toMatchObject({ completed: false });
    expect(await stageStatus(r.stageId)).toBe("active");
    // B1b review M6: D5 asks that no outcome is written, so the final is read again AFTER both completion calls.
    const after = await fixtureRow(r.final.id);
    expect([after.status, after.outcome], "neither completion call wrote the final").toEqual(["scheduled", null]);

    // D5's positive pair: the final decided by play, auto-advance completes the stage.
    await playBadminton(r.auth, r.final.id, true);
    expect(await stageStatus(r.stageId), "the decided bracket auto-completes").toBe("complete");
    expect(await ledgerTypes(r.divisionId), "through the auto-advance").toContain("stage_auto_advanced");
  }, 300_000);

  it("X-CH-5 / X-ST-1 the settle path stays offered: an abandoned final is held, and the organiser's explicit Settle decides it", async () => {
    // single-sport: badminton — as above.
    const r = await finalUnplayed();
    await post(r.auth, r.final.id, "core.start");
    await post(r.auth, r.final.id, "core.abandon", { reason: "rain" });
    const held = await fixtureRow(r.final.id);
    expect([held.status, held.outcome], "the abandoned final decided nobody").toEqual(["abandoned", null]);
    expect(await stageStatus(r.stageId), "nothing completes around it").toBe("active");
    expect(await completeStage(r.auth, r.stageId)).toMatchObject({ completed: false });

    await post(r.auth, r.final.id, "core.settle", { winner: held.away_entrant_id, method: "organiser" });
    const settled = await fixtureRow(r.final.id);
    expect(settled.outcome?.winner, "the organiser's pick").toBe(held.away_entrant_id);
    expect(await stageStatus(r.stageId), "and the bracket completes on it").toBe("complete");
  }, 300_000);
});
