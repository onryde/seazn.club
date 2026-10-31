// W2b Task 7 (spec §5.3 web half, §5.4; plan D20, PF-5, PF-8b, C-5; Review Focus 1 and 2). A double walkover seats
// nobody; its fed seats are dead and the cascade walks the other side over; a forfeit loser never drops to a losers'
// or third-place seat; byes carry `reason: "bye"`. Expected values come from Appendix A (X-DW-2, X-DE-1, X-BR-1) and
// the engine's own pinned bye deltas (`bye-deltas.json`, spec C-5; read through `byeDeltas()` from @seazn/engine/testkit), never from
// the code under test.
import { afterAll, describe, expect, it } from "vitest";
import { advancesNobody, OUTCOME_KINDS } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { byeDeltas } from "@seazn/engine/testkit";
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { recomputeStandings } from "@/server/engine-db";
import { completeStageIfReady } from "@/server/engine-db/competition";
import { onDecided } from "@/server/usecases/scoring";
import { completeStage, getStandings, loadBracketFixtures } from "@/server/usecases/stages";
import { bracketWinnerLoser } from "../competition";
import { advancingSides } from "../fed-seats";
import { assertAdvancingSeat, SEATING_STATUSES } from "../level-seat";
import { declaredVariant, insertLegacyEvents, seedBracket } from "./helpers/seed-bracket";
import { fixtureRow, labelOf, playBadminton, post, rowsOf, seatOf, siblingOf, tip, type FixtureRow } from "./helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const BYE = "bracket.slot.bye";
const DW = { kind: "double_walkover" } as const;
const byeAward = (winner: string | null) => ({ kind: "award", winner, loser: null, reason: "bye" });

/** A double walkover recorded through the console's write, before either side started (a walkover's phase). */
async function doubleWalkover(auth: AuthCtx, id: string) {
  const out = await post(auth, id, "core.forfeit", { by: "both", reason: "walkover" });
  expect([out.status, out.outcome], "rig: the double walkover is recorded").toEqual(["forfeited", DW]);
  return out;
}

/** Play every seated, scheduled line until none is left; home wins unless `loses` is home. */
async function playOut(auth: AuthCtx, stageId: string, loses: ReadonlySet<string> = new Set()) {
  for (let guard = 0; ; guard++) {
    if (guard > 16) throw new Error("rig: play-out did not converge");
    const lines = (await rowsOf(stageId)).filter((r) => r.status === "scheduled" && r.home_entrant_id && r.away_entrant_id);
    if (lines.length === 0) return;
    for (const r of lines) await playBadminton(auth, r.id, !loses.has(r.home_entrant_id!));
  }
}

const ranksOf = async (auth: AuthCtx, stageId: string) => {
  const done = await completeStage(auth, stageId);
  const ev = done.events.find((e) => e.type === "stage_completed");
  return { completed: done.completed, ranks: ev?.type === "stage_completed" ? ev.finalRanks : [] };
};

describe("advancingSides / bracketWinnerLoser: one reading per engine outcome kind (X-BR-1, X-DE-1, X-DW-2)", () => {
  // Expected per kind from the rule rows: a win sends its winner on and its loser down a loser edge (X-BR-1); a
  // forfeit loser is out (X-DE-1: an award names no loser to send on, and a legacy forfeit win is a forfeit); a level
  // result seats nobody (X-BR-2); a double walkover advances nobody, both sides out (X-DW-2).
  const SAMPLE: Record<(typeof OUTCOME_KINDS)[number], unknown> = {
    win: { kind: "win", winner: "h", loser: "a" },
    draw: { kind: "draw" },
    tie: { kind: "tie" },
    no_result: { kind: "no_result" },
    award: { kind: "award", winner: "h", loser: "a", reason: "walkover" },
    double_walkover: { kind: "double_walkover" },
  };
  const WANT: Record<(typeof OUTCOME_KINDS)[number], { adv: [string | undefined, string | undefined]; bracket: object }> = {
    win: { adv: ["h", "a"], bracket: { winner: "h", loser: "a" } },
    draw: { adv: [undefined, undefined], bracket: {} },
    tie: { adv: [undefined, undefined], bracket: {} },
    no_result: { adv: [undefined, undefined], bracket: {} },
    award: { adv: ["h", undefined], bracket: { winner: "h", loser: "a", walkedOver: "loser" } },
    double_walkover: { adv: [undefined, undefined], bracket: { walkedOver: "both" } },
  };
  it("empty case first: no outcome sends nobody", () => {
    expect(advancingSides(null)).toEqual({ winner: undefined, loser: undefined });
    expect(bracketWinnerLoser(null, "h", "a")).toEqual({});
  });
  it("every OUTCOME_KINDS member is classified, and an undeclared kind is a corrupt row, never nobody", () => {
    let checked = 0;
    for (const kind of OUTCOME_KINDS) {
      const a = advancingSides(SAMPLE[kind]);
      expect([[a.winner, a.loser], bracketWinnerLoser(SAMPLE[kind], "h", "a")], kind).toEqual([WANT[kind].adv, WANT[kind].bracket]);
      checked++;
    }
    expect(checked).toBe(OUTCOME_KINDS.length);
    expect(() => advancingSides({ kind: "bogus" })).toThrow(/not an engine OUTCOME_KINDS member/);
    expect(() => bracketWinnerLoser({ kind: "bogus" }, "h", "a")).toThrow(/not an engine OUTCOME_KINDS member/);
  });
  it("the award's other shapes: a bye has no loser; a pre-W2b award names only its winner (loser = the other seat); a legacy forfeit win is a forfeit", () => {
    expect(advancingSides({ kind: "award", winner: "h", loser: null, reason: "bye" })).toEqual({ winner: "h", loser: undefined });
    expect(bracketWinnerLoser({ kind: "award", winner: "h", loser: null, reason: "bye" }, "h", null)).toEqual({ winner: "h" });
    expect(bracketWinnerLoser({ kind: "award", winner: "h" }, "h", null)).toEqual({ winner: "h" });
    expect(bracketWinnerLoser({ kind: "award", winner: "h" }, "h", "a")).toEqual({ winner: "h", loser: "a", walkedOver: "loser" });
    expect(advancingSides({ kind: "win", winner: "h", loser: "a", method: "forfeit" })).toEqual({ winner: "h", loser: undefined }); // legacy
    expect(bracketWinnerLoser({ kind: "win", winner: "h", loser: "a", method: "forfeit" }, "h", "a")).toEqual({ winner: "h", loser: "a", walkedOver: "loser" }); // legacy
    // The negative pair: a played method keeps its loser.
    expect(advancingSides({ kind: "win", winner: "h", loser: "a", method: "checkmate" })).toEqual({ winner: "h", loser: "a" });
  });
});

describe.skipIf(!HAS_DB)("X-DW-2: a double walkover seats nobody; the cascade walks the other side over", () => {
  it("X-DW-2 (knockout of 8): the semi seat it feeds is dead, the other quarter-final's winner is walked over into the final, and the stage completes", async () => {
    // single-sport: badminton; the cascade reads the feed graph and the outcome, never the sport.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 8 });
    const rows = await rowsOf(s.stageId);
    const qf1 = (await fixtureRow(s.fixtureIds[0]!)) as FixtureRow;
    const qf2 = siblingOf(rows, qf1);
    await doubleWalkover(s.auth, qf1.id);
    const out = [qf1.home_entrant_id!, qf1.away_entrant_id!];
    // Stamped late: nothing is decided about the semi until its other feeder resolves.
    const early = await fixtureRow(qf1.winner_to_fixture!);
    expect([seatOf(early, qf1.winner_to_slot), labelOf(early, qf1.winner_to_slot), early.status]).toEqual([null, "slot.winner_match", "scheduled"]);
    const q2 = await playBadminton(s.auth, qf2.id, true);
    const sf = await fixtureRow(qf1.winner_to_fixture!);
    expect({
      dead: [seatOf(sf, qf1.winner_to_slot), labelOf(sf, qf1.winner_to_slot)],
      status: sf.status,
      outcome: sf.outcome,
      inFinal: seatOf(await fixtureRow(sf.winner_to_fixture!), sf.winner_to_slot),
    }).toEqual({ dead: [null, BYE], status: "forfeited", outcome: byeAward(q2.home_entrant_id), inFinal: q2.home_entrant_id });
    await playOut(s.auth, s.stageId);
    const { completed, ranks } = await ranksOf(s.auth, s.stageId);
    const after = await rowsOf(s.stageId);
    const seated = after.filter((r) => r.id !== qf1.id).flatMap((r) => [r.home_entrant_id, r.away_entrant_id]);
    // Both are out AT the quarter-final: everyone who went out later (the finalists, any semi-final loser) ranks
    // above both of them, and neither is seated anywhere later.
    const qfRound = qf1.round_no;
    const laterOut = after
      .filter((r) => r.round_no > qfRound && r.outcome?.kind === "win")
      .flatMap((r) => [r.outcome!.winner!, r.outcome!.loser!]);
    expect(laterOut.length, "rig: later rounds were played").toBeGreaterThan(0);
    const worstLater = Math.max(...laterOut.map((e) => ranks.indexOf(e)));
    expect({ completed, ranked: ranks.length, outAt: out.map((e) => ranks.indexOf(e) > worstLater), seatedLater: out.filter((e) => seated.includes(e)) }).toEqual({
      completed: true,
      ranked: 8,
      outAt: [true, true],
      seatedLater: [],
    });
  });

  it("X-DW-2 (third place): a semi-final double walkover — the other semi's winner is champion by walkover, its loser wins third place by walkover", async () => {
    // single-sport: as above. The third-place seat is a LOSER edge: PF-8b's delegation is what kills it.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    const [a, b] = s.fixtureIds;
    const sf1 = await fixtureRow(a!);
    await doubleWalkover(s.auth, sf1.id);
    const sf2 = await playBadminton(s.auth, b!, true);
    const final = await fixtureRow(sf1.winner_to_fixture!);
    const third = await fixtureRow(sf1.loser_to_fixture!);
    expect({
      final: [final.status, final.outcome, labelOf(final, sf1.winner_to_slot)],
      third: [third.status, third.outcome, labelOf(third, sf1.loser_to_slot)],
    }).toEqual({
      final: ["forfeited", byeAward(sf2.home_entrant_id), BYE],
      third: ["forfeited", byeAward(sf2.away_entrant_id), BYE],
    });
    const { completed, ranks } = await ranksOf(s.auth, s.stageId);
    // PF-5: both double-walkover entrants are out (the D-G1 un-beaten guard counts them), so the stage completes.
    expect({ completed, champion: ranks[0] }).toEqual({ completed: true, champion: sf2.home_entrant_id });
  });

  it("X-DW-2 (double elimination): neither entrant appears in the losers' bracket, and the losers' seat it fed is dead, so its opponent walks over", async () => {
    // single-sport: as above.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "double_elim", entrants: 4 });
    const rows = await rowsOf(s.stageId);
    const wb1 = rows.find((r) => r.ext_key?.startsWith("wb-") && r.home_entrant_id && r.away_entrant_id)!;
    const wb2 = siblingOf(rows, wb1);
    await doubleWalkover(s.auth, wb1.id);
    const out = [wb1.home_entrant_id!, wb1.away_entrant_id!];
    const w2 = await playBadminton(s.auth, wb2.id, true);
    const lb = await fixtureRow(wb1.loser_to_fixture!);
    expect([lb.status, lb.outcome, labelOf(lb, wb1.loser_to_slot)]).toEqual(["forfeited", byeAward(w2.away_entrant_id), BYE]);
    await playOut(s.auth, s.stageId);
    const after = await rowsOf(s.stageId);
    const inLosers = after.filter((r) => r.ext_key?.startsWith("lb-")).flatMap((r) => [r.home_entrant_id, r.away_entrant_id]);
    const { completed, ranks } = await ranksOf(s.auth, s.stageId);
    expect({ inLosers: out.filter((e) => inLosers.includes(e)), completed, last2: out.map((e) => ranks.indexOf(e) >= 2) }).toEqual({
      inLosers: [],
      completed: true,
      last2: [true, true],
    });
  });

  it("X-DE-1: a winners'-bracket walkover loser is never seated in the losers' bracket; its opponent advances by walkover; ranks put it out in that round", async () => {
    // Two outcome shapes a forfeit takes: the W2b `award` (badminton through core.forfeit) and the LEGACY chess
    // `win{method:"forfeit"}` a pre-W2b stream still folds to (carry-in) — compared as one table.
    const observed: unknown[] = [];
    const expected: unknown[] = [];
    for (const sport of ["badminton", "boardgame"] as const) {
      const variant = declaredVariant(sport, sport === "badminton" ? "bwf" : "classical");
      const s = await seedBracket({ sport, variant, stageKind: "double_elim", entrants: 4 });
      const rows = await rowsOf(s.stageId);
      const wb1 = rows.find((r) => r.ext_key?.startsWith("wb-") && r.home_entrant_id && r.away_entrant_id)!;
      const wb2 = siblingOf(rows, wb1);
      const loser = wb1.away_entrant_id!;
      if (sport === "badminton") {
        await post(s.auth, wb1.id, "core.forfeit", { by: loser, reason: "walkover" });
      } else {
        // Written before W2b retired the method on write (D15): raw SQL, then the next append folds it.
        await insertLegacyEvents(wb1.id, [
          { type: "core.start", payload: {} },
          { type: "boardgame.result", payload: { winner: wb1.home_entrant_id, method: "forfeit" } }, // legacy row
        ]);
        await post(s.auth, wb1.id, "core.note", { text: "arbiter's report" });
      }
      const wb1After = await fixtureRow(wb1.id);
      // Play wb2 and everything after it; wherever the forfeit loser IS seated it wins, so a wrong seat shows.
      for (let guard = 0; ; guard++) {
        if (guard > 12) throw new Error(`${sport}: play-out did not converge`);
        const lines = (await rowsOf(s.stageId)).filter((r) => r.status === "scheduled" && r.home_entrant_id && r.away_entrant_id);
        if (lines.length === 0) break;
        for (const r of lines) {
          const homeWins = r.away_entrant_id !== loser;
          await post(s.auth, r.id, "core.start");
          if (sport === "boardgame") {
            await post(s.auth, r.id, "boardgame.result", { winner: homeWins ? r.home_entrant_id : r.away_entrant_id, method: "checkmate" });
          } else {
            for (let g = 0; g < 2; g++) await post(s.auth, r.id, "badminton.game.summary", homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 });
          }
        }
      }
      const lb = await fixtureRow(wb1.loser_to_fixture!);
      const w2 = await fixtureRow(wb2.id);
      const seatedInLosers = (await rowsOf(s.stageId)).filter((r) => r.ext_key?.startsWith("lb-") && (r.home_entrant_id === loser || r.away_entrant_id === loser)).length;
      const { completed, ranks } = await ranksOf(s.auth, s.stageId);
      observed.push({ sport, wb1: wb1After.status, seatedInLosers, lb: [lb.status, lb.outcome?.winner], completed, rankOfOut: ranks.indexOf(loser) + 1 });
      // Out in winners' round 1, the earliest anybody goes out of a four-entrant double elimination: ranked last.
      expected.push({ sport, wb1: sport === "badminton" ? "forfeited" : "decided", seatedInLosers: 0, lb: ["forfeited", w2.outcome?.loser], completed: true, rankOfOut: 4 });
    }
    expect(observed.length, "shapes checked").toBe(2);
    expect(observed).toEqual(expected);
  }, 120_000);

  it("X-BR-1 (amended): a bracket fixture is decided only by a win or a double walkover — a level result is held, a double walkover completes the line", async () => {
    // single-sport: football reaches a held bracket fixture by play (0-0 FT, X-BR-2).
    // stageRules {}: every preset decider off (W2c X-SR-6: a knockout otherwise starts with extra time and penalties).
    const s = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 4, stageRules: {} });
    const [a, b] = s.fixtureIds;
    const sf1 = await fixtureRow(a!);
    await post(s.auth, sf1.id, "core.start");
    await post(s.auth, sf1.id, "football.period", { phase: "HT" });
    await post(s.auth, sf1.id, "football.period", { phase: "FT" });
    const held = await fixtureRow(sf1.id);
    const out = await doubleWalkover(s.auth, b!);
    const sf2 = await fixtureRow(b!);
    const final = await fixtureRow(sf1.winner_to_fixture!);
    expect({
      held: [held.status, held.outcome?.kind, seatOf(final, sf1.winner_to_slot)],
      dw: [out.status, advancesNobody(out.outcome as never), seatOf(final, sf2.winner_to_slot)],
      // A held line is not dead (it waits for the settle); the walkover's seat is stamped only once the held line
      // resolves, so the final is still waiting on both.
      final: [final.status, labelOf(final, sf2.winner_to_slot)],
    }).toEqual({ held: ["needs_decision", "draw", null], dw: ["forfeited", true, null], final: ["scheduled", "slot.winner_match"] });
    // The organiser settles the held semi: its winner is seated and the double walkover's seat is now dead, so the
    // final is walked over to the settle's winner.
    await post(s.auth, sf1.id, "core.settle", { winner: sf1.home_entrant_id, method: "organiser" });
    const after = await fixtureRow(final.id);
    expect([after.status, after.outcome, labelOf(after, sf2.winner_to_slot)]).toEqual(["forfeited", byeAward(sf1.home_entrant_id), BYE]);
  });
});

describe("D20: assertAdvancingSeat — a double walkover must never fill a seat (the bug shape, unit)", () => {
  it("empty case first: silent with no seated entrant, on a win, and under a non-seating status", () => {
    const base = { fixtureId: "f", stageKind: "knockout", outcome: DW };
    expect(() => assertAdvancingSeat({ ...base, status: "forfeited", seatedEntrant: null })).not.toThrow();
    expect(() => assertAdvancingSeat({ ...base, status: "decided", outcome: { kind: "win", winner: "a", loser: "b" }, seatedEntrant: "a" })).not.toThrow();
    expect(() => assertAdvancingSeat({ ...base, status: "scheduled", seatedEntrant: "a" })).not.toThrow();
  });
  it("D20: under every seating status, a seated entrant fed by a double walkover throws LEVEL_RESULT_SEATED advances_nobody", () => {
    let checked = 0;
    for (const status of SEATING_STATUSES) {
      expect(() => assertAdvancingSeat({ fixtureId: "f", stageKind: "knockout", status, outcome: DW, seatedEntrant: "a" }), status).toThrow(
        expect.objectContaining({ code: "LEVEL_RESULT_SEATED", data: expect.objectContaining({ reason: "advances_nobody" }) }),
      );
      checked++;
    }
    expect(checked).toBe(3);
  });
});

/** A 4-draw knockout whose first semi is FORCED to a stored double walkover with one of its entrants already seated
 *  in the final — the bug shape D20 exists to catch, reachable only by forcing the row. */
async function forcedSeat() {
  const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
  const sf = await fixtureRow(s.fixtureIds[0]!);
  const seat = sf.winner_to_slot === 1 ? sql`home_entrant_id` : sql`away_entrant_id`;
  await sql`update fixtures set status = 'forfeited', outcome = ${sql.json(DW)} where id = ${sf.id}`;
  await sql`update fixtures set ${seat} = ${sf.home_entrant_id} where id = ${sf.winner_to_fixture}`;
  return { ...s, sf };
}
const advancesNobodyRefusal = { code: "LEVEL_RESULT_SEATED", data: expect.objectContaining({ reason: "advances_nobody" }) };

describe.skipIf(!HAS_DB)("D20: every seating read path asserts a double walkover seated nobody (forced rows)", () => {
  it("D20: onDecided refuses a double walkover with a seated next fixture", async () => {
    const t = await forcedSeat();
    await expect(onDecided(t.auth, t.sf.id)).rejects.toMatchObject(advancesNobodyRefusal);
    // The positive pair: an award seats its winner.
    const p = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const sf = await fixtureRow(p.fixtureIds[0]!);
    await sql`update fixtures set status = 'forfeited',
                outcome = ${sql.json({ kind: "award", winner: sf.home_entrant_id, loser: sf.away_entrant_id, reason: "walkover" })}
              where id = ${sf.id}`;
    await onDecided(p.auth, sf.id);
    expect(seatOf(await fixtureRow(sf.winner_to_fixture!), sf.winner_to_slot)).toBe(sf.home_entrant_id);
  });
  it("D20: the bracket completion read (completeStageIfReady → toBracketFixture) refuses the forced shape", async () => {
    const t = await forcedSeat();
    await expect(completeStageIfReady(t.auth.orgId, t.stageId)).rejects.toMatchObject(advancesNobodyRefusal);
  });
  it("D20: the completed-bracket rebuild read (loadBracketFixtures) refuses the forced shape; an unseated double walkover reads clean, walked over by both", async () => {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const sf = await fixtureRow(s.fixtureIds[0]!);
    await doubleWalkover(s.auth, sf.id);
    const clean = await withTenant(s.auth.orgId, (tx) => loadBracketFixtures(tx, s.stageId));
    expect(clean.find((f) => f.id === sf.id)).toMatchObject({ walkedOver: "both", home: sf.home_entrant_id, away: sf.away_entrant_id });
    expect(clean.find((f) => f.id === sf.id)).not.toHaveProperty("winner");
    const t = await forcedSeat();
    await expect(withTenant(t.auth.orgId, (tx) => loadBracketFixtures(tx, t.stageId))).rejects.toMatchObject(advancesNobodyRefusal);
  });
});

describe.skipIf(!HAS_DB)("Review Focus 1 and 2: a void moves the seats with it", () => {
  it("Review Focus 1: void of a double walkover un-seats the walkover it caused", async () => {
    // single-sport: badminton; the seat rules read the feed graph.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const [a, b] = s.fixtureIds;
    const sf1 = await fixtureRow(a!);
    const dw = await doubleWalkover(s.auth, sf1.id);
    const sf2 = await playBadminton(s.auth, b!, true);
    const walked = await fixtureRow(sf1.winner_to_fixture!);
    expect([walked.status, walked.outcome], "rig: the final was walked over").toEqual(["forfeited", byeAward(sf2.home_entrant_id)]);
    const out = await post(s.auth, sf1.id, "core.void", { event_id: dw.event_id });
    const final = await fixtureRow(walked.id);
    // The fed fixture goes back to waiting: no outcome, the dead seat's drawn label back, the other semi's winner kept.
    expect({
      sf1: [out.status, out.outcome],
      final: [final.status, final.outcome, seatOf(final, sf1.winner_to_slot), labelOf(final, sf1.winner_to_slot), seatOf(final, sf2.winner_to_slot)],
    }).toEqual({
      sf1: ["scheduled", null],
      final: ["scheduled", null, null, "slot.winner_match", sf2.home_entrant_id],
    });
    // The sequence goes on: the semi is played after all and its winner is seated.
    const replayed = await playBadminton(s.auth, sf1.id, false);
    expect(seatOf(await fixtureRow(final.id), sf1.winner_to_slot)).toBe(replayed.away_entrant_id);
  });

  it("Review Focus 1: a line voided because BOTH its feeders were double walkovers goes back to waiting when one is voided", async () => {
    // single-sport: badminton; the seat rules read the feed graph. A knockout of 8: two quarter-finals feed one semi.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 8 });
    const rows = await rowsOf(s.stageId);
    const qf1 = await fixtureRow(s.fixtureIds[0]!);
    const qf2 = siblingOf(rows, qf1);
    const dw1 = await doubleWalkover(s.auth, qf1.id);
    await doubleWalkover(s.auth, qf2.id);
    const voided = await fixtureRow(qf1.winner_to_fixture!);
    expect([voided.status, voided.outcome, voided.home_entrant_id, voided.away_entrant_id], "rig: both feeders dead, the semi is void").toEqual([
      "abandoned",
      null,
      null,
      null,
    ]);
    await post(s.auth, qf1.id, "core.void", { event_id: dw1.event_id });
    const semi = await fixtureRow(voided.id);
    expect([semi.status, semi.outcome, seatOf(semi, qf1.winner_to_slot), seatOf(semi, qf2.winner_to_slot)]).toEqual(["scheduled", null, null, null]);
    // The sequence goes on: the quarter-final is played after all, the other feeder is still dead, so its winner is
    // walked over the semi (a bye) and seated in the final.
    const played = await playBadminton(s.auth, qf1.id, true);
    const after = await fixtureRow(semi.id);
    expect([after.status, after.outcome, seatOf(after, qf1.winner_to_slot)]).toEqual(["forfeited", byeAward(played.home_entrant_id), played.home_entrant_id]);
    expect(seatOf(await fixtureRow(semi.winner_to_fixture!), semi.winner_to_slot)).toBe(played.home_entrant_id);
  });

  it("Review Focus 1: if the next match has started, the void is refused NEXT_MATCH_STARTED and nothing changes", async () => {
    // single-sport: as above. A knockout of 8: the quarter-final's walkover feeds a semi whose winner reached the final.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 8 });
    const rows = await rowsOf(s.stageId);
    const qf1 = await fixtureRow(s.fixtureIds[0]!);
    const dw = await doubleWalkover(s.auth, qf1.id);
    await playBadminton(s.auth, siblingOf(rows, qf1).id, true);
    await playOut(s.auth, s.stageId, new Set()); // plays every seated line, the final included…
    // …so take the final back to "started, not finished": void its last game and keep it in play.
    const finalId = (await rowsOf(s.stageId)).find((r) => r.winner_to_fixture === null)!.id;
    const [last] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${finalId} order by seq desc limit 1`;
    await post(s.auth, finalId, "core.void", { event_id: last!.id });
    expect((await fixtureRow(finalId)).status, "rig: the final is in play").toBe("in_play");
    const before = { tip: await tip(qf1.id), rows: await rowsOf(s.stageId) };
    await expect(post(s.auth, qf1.id, "core.void", { event_id: dw.event_id })).rejects.toMatchObject({ status: 409, code: "NEXT_MATCH_STARTED" });
    expect({ tip: await tip(qf1.id), rows: await rowsOf(s.stageId) }).toEqual(before);
  });

  it("Review Focus 2: void then the other side's walkover — the table and the seat follow the second forfeit only", async () => {
    // single-sport: badminton, in a league (the table) and a knockout (the seat).
    const lg = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "league", entrants: 3 });
    const id = lg.fixtureIds[0]!;
    const f = await fixtureRow(id);
    const first = await post(lg.auth, id, "core.forfeit", { by: f.home_entrant_id, reason: "walkover" });
    await post(lg.auth, id, "core.void", { event_id: first.event_id });
    await post(lg.auth, id, "core.forfeit", { by: f.away_entrant_id, reason: "walkover" });
    const rows = (await getStandings(lg.auth, lg.stageId)).rows as { entrantId: string; won: number; lost: number; played: number }[];
    const of = (e: string | null) => rows.find((r) => r.entrantId === e)!;
    expect({ home: [of(f.home_entrant_id).played, of(f.home_entrant_id).won], away: [of(f.away_entrant_id).played, of(f.away_entrant_id).lost] }).toEqual({
      home: [1, 1],
      away: [1, 1],
    });
    const ko = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const sf = await fixtureRow(ko.fixtureIds[0]!);
    const wrong = await post(ko.auth, sf.id, "core.forfeit", { by: sf.home_entrant_id, reason: "walkover" });
    expect(seatOf(await fixtureRow(sf.winner_to_fixture!), sf.winner_to_slot), "rig: the wrong winner was seated").toBe(sf.away_entrant_id);
    await post(ko.auth, sf.id, "core.void", { event_id: wrong.event_id });
    await post(ko.auth, sf.id, "core.forfeit", { by: sf.away_entrant_id, reason: "walkover" });
    expect(seatOf(await fixtureRow(sf.winner_to_fixture!), sf.winner_to_slot)).toBe(sf.home_entrant_id);
  });
});

const BYE_DELTAS = byeDeltas() as Record<string, Record<string, Record<"home" | "away", { entrantId: string; played: number; won: number; drawn: number; lost: number; points: number; metrics: Record<string, number> }[]>>>;

describe.skipIf(!HAS_DB)("C-5: every bye writer stores reason bye, and a bye credits exactly today's bye delta", () => {
  it("C-5 bye: the Swiss bye, the generator bye and the seeded bye store {kind:award, winner, loser:null, reason:bye}", async () => {
    // single-sport: badminton; the three writers are sport-blind SQL (stages.ts).
    const sw = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "swiss", entrants: 5, stageConfig: { rounds: 2 } });
    const swissBye = (await rowsOf(sw.stageId)).find((r) => r.round_no === 1 && (r.home_entrant_id === null) !== (r.away_entrant_id === null))!;
    const gen = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 6 });
    const genByes = (await rowsOf(gen.stageId)).filter((r) => r.status === "forfeited");
    const ko = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const sf1 = await fixtureRow(ko.fixtureIds[0]!);
    await doubleWalkover(ko.auth, sf1.id);
    const sf2 = await playBadminton(ko.auth, ko.fixtureIds[1]!, true);
    const seeded = await fixtureRow(sf1.winner_to_fixture!);
    const got = [swissBye, ...genByes, seeded].map((r) => r.outcome);
    const want = [swissBye, ...genByes].map((r) => byeAward(r.home_entrant_id ?? r.away_entrant_id)).concat([byeAward(sf2.home_entrant_id)]);
    expect(genByes.length, "rig: a six-draw knockout has two generator byes").toBe(2);
    expect(got).toEqual(want);
  });

  it("C-5 bye: a Swiss table credits exactly bye-deltas.json's delta, per sport", async () => {
    let checked = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants).find((v) => BYE_DELTAS[m.key]?.[v] !== undefined);
      if (variant === undefined) throw new Error(`${m.key}: no pinned bye delta for any declared variant`);
      const s = await seedBracket({ sport: m.key, variant, stageKind: "swiss", entrants: 3, stageConfig: { rounds: 2 } });
      const bye = (await rowsOf(s.stageId)).find((r) => r.round_no === 1 && (r.home_entrant_id === null) !== (r.away_entrant_id === null));
      if (!bye) throw new Error(`${m.key}: round 1 has no bye`);
      const seat = bye.home_entrant_id !== null ? "home" : "away";
      const recipient = (bye.home_entrant_id ?? bye.away_entrant_id)!;
      await recomputeStandings(s.auth.orgId, s.stageId);
      const row = ((await getStandings(s.auth, s.stageId)).rows as { entrantId: string; played: number; won: number; drawn: number; lost: number; points: number; metrics?: Record<string, number> }[]).find(
        (r) => r.entrantId === recipient,
      )!;
      const pinned = BYE_DELTAS[m.key]![variant]![seat].find((d) => d.entrantId === "W")!;
      const metricsGot = Object.fromEntries(Object.keys(pinned.metrics).map((k) => [k, row.metrics?.[k]]));
      expect({ played: row.played, won: row.won, drawn: row.drawn, lost: row.lost, points: row.points, metrics: metricsGot }, m.key).toEqual({
        played: pinned.played,
        won: pinned.won,
        drawn: pinned.drawn,
        lost: pinned.lost,
        points: pinned.points,
        metrics: pinned.metrics,
      });
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
  }, 180_000);
});
