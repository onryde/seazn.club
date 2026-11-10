// W4 knockout app PR B, batch B1 (T2' + T3): the post-engine-bump adaptations of the bracket read, driven through the
// usecases the buttons call on real Postgres (Generate, Start, Score, Withdraw, Complete) and the auto-advance after a score.
//
// Rulebook rows (rulebook-W4-knockout.md), never read back from the code under test:
//  - X-CH-1: a double elimination whose winners'-bracket champion wins the grand final is decided there; the bracket
//    reset is never played. Won by the other side, the reset is owed and decides the title.
//  - X-FR-4 (rulings 266/267): a knockout without a third-place match ranks its two semi-final losers LEVEL, 3rd - the
//    wire keeps `finalRanks` (ids in rank order) and adds `places` (the ranks, [1, 2, 3, 3]) and `title`.
//  - X-FR-1 (RB4-R1): every drawn entrant is ranked once; one who never held a seat in this stage and was never drawn into it
//    is not ranked in it.
//  - C14 / RB4-C2: a finalist who withdraws before the final ranks 2nd.
//  - C9 / RB4-P3: the plate's field (`firstLossField`) is complete once every first match is played, which a bye holder's is
//    not until round 2.
// Sports: badminton and the first engine sport whose entrants are teams (`sportFor`).
import { afterAll, describe, expect, it } from "vitest";
import { type FixtureRow, fixtureRow, playBadminton, post, rowsOf } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { builtinModules } from "@seazn/engine/sports";
import { firstLossField } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { bracketStageIsDecided } from "@/server/engine-db/competition";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { resolveStoredProgression } from "../stored-progression";
import { completeStage, loadBracketFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { createEntrants } from "../entrants";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

function sportFor(): string {
  const m = builtinModules.find((x) => x.entrantModel?.defaultKind === "team");
  if (m === undefined) throw new Error("premise: the engine declares no team sport");
  return m.key;
}
const SPORTS = ["badminton", sportFor()] as const;
const variantOf = (sport: string) => declaredVariant(sport, Object.keys(builtinModules.find((m) => m.key === sport)!.variants)[0]!);

/** One decided line, won by the HOME side (`homeWins`) through the sport's own events. */
async function play(auth: AuthCtx, sport: string, row: FixtureRow, homeWins: boolean): Promise<void> {
  if (row.home_entrant_id === null || row.away_entrant_id === null) throw new Error(`rig: ${row.ext_key} is not seated`);
  if (sport === "badminton") {
    await playBadminton(auth, row.id, homeWins);
    return;
  }
  if (sport === "football") {
    await post(auth, row.id, "core.start");
    await post(auth, row.id, "football.goal", { by: homeWins ? row.home_entrant_id : row.away_entrant_id });
    await post(auth, row.id, "football.period", { phase: "HT" });
    await post(auth, row.id, "football.period", { phase: "FT" });
    const r = await fixtureRow(row.id);
    if (r.status !== "decided") throw new Error(`rig: ${r.ext_key} did not decide (${r.status})`);
    return;
  }
  throw new Error(`rig: no play script for ${sport} (sportFor picked a sport this file cannot score)`);
}

/** Play the next seated, scheduled line (lowest round first), skipping `skip` ext_keys; null when none is left. */
async function playNext(auth: AuthCtx, sport: string, stageId: string, homeWins: (r: FixtureRow) => boolean, skip: ReadonlySet<string> = new Set()): Promise<FixtureRow | null> {
  const next = (await rowsOf(stageId)).find((r) => r.status === "scheduled" && r.home_entrant_id !== null && r.away_entrant_id !== null && !(r.ext_key !== null && skip.has(r.ext_key)));
  if (next === undefined) return null;
  await play(auth, sport, next, homeWins(next));
  return fixtureRow(next.id);
}
async function playAll(auth: AuthCtx, sport: string, stageId: string, homeWins: (r: FixtureRow) => boolean, skip?: ReadonlySet<string>): Promise<number> {
  let n = 0;
  for (;;) {
    const r = await playNext(auth, sport, stageId, homeWins, skip);
    if (r === null) return n;
    n++;
  }
}

const stageStatus = async (stageId: string) => (await sql<{ status: string }[]>`select status from stages where id = ${stageId}`)[0]!.status;
const ledger = async (divisionId: string) => (await sql<{ type: string }[]>`select type from division_events where division_id = ${divisionId} order by seq`).map((r) => r.type);
type Done = { type: "stage_completed"; finalRanks: string[]; places: { entrantId: string; rank: number }[]; title?: { kind: string; champion?: string; winners?: string[]; finalists?: string[] } };
const completedEvent = (events: readonly { type: string }[]): Done => {
  const ev = events.find((e) => e.type === "stage_completed");
  if (ev === undefined) throw new Error("rig: no stage_completed event");
  return ev as unknown as Done;
};

describe.runIf(HAS_DB)("X-CH-1 (C2/C17): a double elimination decided in its grand final completes - by Complete AND by auto-advance", () => {
  const RESET = new Set(["gf-reset"]);
  let swept = 0;
  for (const sport of SPORTS) {
    it(`${sport}: the winners' champion wins GF1 - the reset stays unplayed and reads void; Complete finishes the stage, the champion is the GF1 winner`, async () => {
      const s = await seedBracket({ sport, variant: variantOf(sport), stageKind: "double_elim", entrants: 4, stageConfig: { bracketReset: true } });
      const rows0 = await rowsOf(s.stageId);
      const reset = rows0.find((r) => r.ext_key === "gf-reset");
      expect(reset, "rig: the stage was generated with a bracket reset").toBeDefined();
      // Empty case first: nothing played - not decided, Complete answers not-completed (and does not 500).
      expect(await sql.begin((tx) => bracketStageIsDecided(tx as never, s.stageId))).toBe(false);
      expect((await completeStage(s.auth, s.stageId)).completed).toBe(false);
      const played = await playAll(s.auth, sport, s.stageId, () => true, RESET);
      expect(played, "every line but the reset was played (4 entrants: 6 lines + GF1)").toBeGreaterThanOrEqual(6);
      const gf = (await rowsOf(s.stageId)).find((r) => r.ext_key === "gf")!;
      expect(gf.outcome?.winner, "rig: the home side - the winners' champion - won GF1").toBe(gf.home_entrant_id);
      expect((await fixtureRow(reset!.id)).status, "the reset is still a scheduled line").toBe("scheduled");
      expect(await stageStatus(s.stageId), "not completed behind the organiser's back with auto-advance off").toBe("active");
      expect(await sql.begin((tx) => bracketStageIsDecided(tx as never, s.stageId)), "decided: an un-owed reset reads void").toBe(true);
      const done = await completeStage(s.auth, s.stageId);
      expect(done.completed).toBe(true);
      const ev = completedEvent(done.events);
      expect(ev.finalRanks[0], "the champion is the GF1 winner (read from the fixture row)").toBe(gf.outcome!.winner);
      expect(ev.finalRanks.length, "four entrants ranked").toBe(4);
      expect(ev.title).toEqual({ kind: "champion", champion: gf.outcome!.winner });
      expect(await stageStatus(s.stageId)).toBe("complete");
      swept++;
    }, 240_000);

    it(`${sport}: the LB champion wins GF1 - the reset is OWED: Complete is not-completed until it is played, and then the reset winner is champion`, async () => {
      const s = await seedBracket({ sport, variant: variantOf(sport), stageKind: "double_elim", entrants: 4, stageConfig: { bracketReset: true } });
      await playAll(s.auth, sport, s.stageId, (r) => r.ext_key !== "gf", RESET); // GF1: the AWAY side (LB champion) wins
      const rows = await rowsOf(s.stageId);
      const gf = rows.find((r) => r.ext_key === "gf")!;
      const reset = rows.find((r) => r.ext_key === "gf-reset")!;
      expect(gf.outcome?.winner, "rig: the away side won GF1").toBe(gf.away_entrant_id);
      expect([reset.home_entrant_id, reset.away_entrant_id].every((id) => id !== null), "the owed reset is seated").toBe(true);
      expect(await sql.begin((tx) => bracketStageIsDecided(tx as never, s.stageId)), "an OWED reset keeps the bracket open").toBe(false);
      const before = await ledger(s.divisionId);
      expect((await completeStage(s.auth, s.stageId)).completed, "owed, unplayed: not completed").toBe(false);
      expect(await ledger(s.divisionId), "nothing written").toEqual(before);
      await play(s.auth, sport, reset, true);
      const done = await completeStage(s.auth, s.stageId);
      expect(done.completed).toBe(true);
      const resetAfter = await fixtureRow(reset.id);
      expect(completedEvent(done.events).finalRanks[0], "the reset decides the title").toBe(resetAfter.outcome!.winner);
      swept++;
    }, 240_000);

    it(`${sport}: with auto-advance on, the last score of a DE won in GF1 completes the stage with no button (and the owed-reset shape does not)`, async () => {
      const won = await seedBracket({ sport, variant: variantOf(sport), stageKind: "double_elim", entrants: 4, stageConfig: { bracketReset: true } });
      await sql`update divisions set auto_progress = true where id = ${won.divisionId}`;
      await playAll(won.auth, sport, won.stageId, () => true, RESET);
      expect(await stageStatus(won.stageId), "GF1 won by the winners' champion: auto-advanced").toBe("complete");
      expect(await ledger(won.divisionId)).toContain("stage_auto_advanced");

      const owed = await seedBracket({ sport, variant: variantOf(sport), stageKind: "double_elim", entrants: 4, stageConfig: { bracketReset: true } });
      await sql`update divisions set auto_progress = true where id = ${owed.divisionId}`;
      await playAll(owed.auth, sport, owed.stageId, (r) => r.ext_key !== "gf", RESET);
      expect(await stageStatus(owed.stageId), "GF1 won by the LB champion: the reset is owed, so it stays open").toBe("active");
      expect(await ledger(owed.divisionId), "and no auto-advance was logged for a stage that did not advance").not.toContain("stage_auto_advanced");
      await playNext(owed.auth, sport, owed.stageId, () => true); // the reset
      expect(await stageStatus(owed.stageId), "the reset played: auto-advanced").toBe("complete");
      swept++;
    }, 300_000);
  }
  it("anti-vacuity: every shape was driven in both sports", () => expect(swept).toBe(SPORTS.length * 3));
});

describe.runIf(HAS_DB)("X-FR-4 (T3): the wire keeps finalRanks as ids and adds places and title", () => {
  let swept = 0;
  for (const sport of SPORTS) {
    it(`${sport}: a knockout of four without a third-place match - finalRanks four ids, places [1,2,3,3], title the final's winner`, async () => {
      const s = await seedBracket({ sport, variant: variantOf(sport), stageKind: "knockout", entrants: 4 });
      await playAll(s.auth, sport, s.stageId, () => true);
      const rows = await rowsOf(s.stageId);
      const final = rows.find((r) => r.winner_to_fixture === null)!;
      const semis = rows.filter((r) => r.winner_to_fixture === final.id);
      expect(semis.length, "rig: two semi-finals").toBe(2);
      const done = await completeStage(s.auth, s.stageId);
      const ev = completedEvent(done.events);
      expect(ev.finalRanks.every((id) => typeof id === "string"), "finalRanks is still ids").toBe(true);
      expect(ev.places.map((p) => p.rank)).toEqual([1, 2, 3, 3]);
      expect(ev.places.map((p) => p.entrantId), "places is finalRanks, with its ranks").toEqual(ev.finalRanks);
      expect(ev.finalRanks[0]).toBe(final.outcome!.winner);
      expect(ev.finalRanks[1], "the runner-up is the final's other side").toBe(final.outcome!.winner === final.home_entrant_id ? final.away_entrant_id : final.home_entrant_id);
      expect(new Set(ev.places.slice(2).map((p) => p.entrantId)), "the shared 3rd is the two semi-final losers").toEqual(
        new Set(semis.map((r) => (r.outcome!.winner === r.home_entrant_id ? r.away_entrant_id : r.home_entrant_id))),
      );
      expect(ev.title).toEqual({ kind: "champion", champion: final.outcome!.winner });
      // The stored ledger row carries the same wire shape (one event, written once).
      const [row] = await sql<{ payload: Done }[]>`select payload from division_events where division_id = ${s.divisionId} and type = 'stage_completed'`;
      expect(row!.payload.places.map((p) => p.rank)).toEqual([1, 2, 3, 3]);
      swept++;
    }, 240_000);

    it(`${sport}: with a third-place match the four places are distinct [1,2,3,4]`, async () => {
      const s = await seedBracket({ sport, variant: variantOf(sport), stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
      await playAll(s.auth, sport, s.stageId, () => true);
      const ev = completedEvent((await completeStage(s.auth, s.stageId)).events);
      expect(ev.places.map((p) => p.rank)).toEqual([1, 2, 3, 4]);
      expect(ev.finalRanks.length).toBe(4);
      swept++;
    }, 240_000);
  }
  it("anti-vacuity: both shapes in both sports", () => expect(swept).toBe(SPORTS.length * 2));
});

describe.runIf(HAS_DB)("C14 / RB4-C2 (C6): a finalist who withdraws with the other semi-final unplayed ranks 2nd", () => {
  let swept = 0;
  for (const sport of SPORTS) {
    it(`${sport}: semi A's winner withdraws before semi B is played - the stage completes and she is 2nd`, async () => {
      const s = await seedBracket({ sport, variant: variantOf(sport), stageKind: "knockout", entrants: 4 });
      const rows = await rowsOf(s.stageId);
      const final = rows.find((r) => r.winner_to_fixture === null)!;
      const [semiA, semiB] = rows.filter((r) => r.winner_to_fixture === final.id);
      await play(s.auth, sport, semiA!, true);
      const finalist = (await fixtureRow(semiA!.id)).outcome!.winner!;
      const out = await withdrawEntrantCascade(s.auth, finalist);
      expect(out.policy, "premise: the withdrawal walked something over or left her seat dead").not.toBe("none");
      expect((await fixtureRow(semiB!.id)).status, "semi B is still unplayed").toBe("scheduled");
      await play(s.auth, sport, await fixtureRow(semiB!.id), true);
      const semiBWinner = (await fixtureRow(semiB!.id)).outcome!.winner!;
      expect((await fixtureRow(final.id)).outcome?.winner, "semi B's winner walks the final over").toBe(semiBWinner);
      const done = await completeStage(s.auth, s.stageId);
      expect(done.completed).toBe(true);
      const ev = completedEvent(done.events);
      expect(ev.places.find((p) => p.entrantId === finalist)?.rank, "the withdrawn finalist is ranked 2nd").toBe(2);
      expect(ev.places[0]).toEqual({ entrantId: semiBWinner, rank: 1 });
      expect(ev.places.map((p) => p.entrantId).sort(), "everyone drawn is ranked exactly once").toEqual(
        [...new Set([semiA!, semiB!].flatMap((r) => [r.home_entrant_id!, r.away_entrant_id!]))].sort(),
      );
      swept++;
    }, 240_000);
  }
  it("anti-vacuity: both sports", () => expect(swept).toBe(SPORTS.length));
});

describe.runIf(HAS_DB)("X-FR-1 (C1): a division entrant who was never drawn into the knockout is not ranked in it", () => {
  it("badminton: a withdrawn entrant who never held a seat is absent from finalRanks and places (the empty-roster guard)", async () => {
    // single-sport: badminton - the roster is sport-blind (the sport-swept DE/wire cases above cover the second sport).
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    // A fifth entrant joins the division AFTER the draw and leaves again: never seated, not waiting, not drawn.
    const [ghost] = await createEntrants(s.auth, s.divisionId, [{ kind: "individual", display_name: "Ghost", seed: null, members: [] }] as never);
    await sql`update entrants set status = 'withdrawn' where id = ${ghost!.id}`;
    await playAll(s.auth, "badminton", s.stageId, () => true);
    const ev = completedEvent((await completeStage(s.auth, s.stageId)).events);
    expect(ev.finalRanks.length, "the four drawn entrants only").toBe(4);
    expect(ev.finalRanks).not.toContain(ghost!.id);
  }, 240_000);

  it("badminton: an entrant parked on this stage (knockout_waiting_stage_id) is not declared either", async () => {
    // single-sport: badminton - same reason as above.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const [late] = await createEntrants(s.auth, s.divisionId, [{ kind: "individual", display_name: "Late", seed: null, members: [] }] as never);
    await sql`update entrants set knockout_waiting_stage_id = ${s.stageId} where id = ${late!.id}`;
    // Reach the guard: a stored `qualified` list that names her (a cut that ran before she was parked) must not declare her.
    const seatedIds = (await sql<{ h: string | null; a: string | null }[]>`select home_entrant_id as h, away_entrant_id as a from fixtures where stage_id = ${s.stageId}`).flatMap((r) => [r.h, r.a]).filter((x): x is string => !!x);
    await sql`update stages set config = coalesce(config, '{}'::jsonb) || ${sql.json({ qualified: [...new Set(seatedIds), late!.id] } as never)} where id = ${s.stageId}`;
    await playAll(s.auth, "badminton", s.stageId, () => true);
    const ev = completedEvent((await completeStage(s.auth, s.stageId)).events);
    expect(ev.finalRanks.length, "the waiting entrant would rank last in a stage she has not entered").toBe(4);
    expect(ev.finalRanks).not.toContain(late!.id);
  }, 240_000);
});

describe.runIf(HAS_DB)("C9 (C5/C11): the plate's field completes after round 2 on a real Generate, and a stored roundLosers{round:1} still resolves", () => {
  let swept = 0;
  for (const sport of SPORTS) {
    it(`${sport}: six entrants (two byes) - the field is open after round 1, complete after round 2; losers = the lines played`, async () => {
      const s = await seedBracket({ sport, variant: variantOf(sport), stageKind: "knockout", entrants: 6 });
      const rowsNow = () => sql.begin((tx) => loadBracketFixtures(tx as never, s.stageId));
      // Empty case: nothing played - the engine's own answer is "not complete" (the main draw exists, first matches pending).
      const empty = firstLossField(await rowsNow());
      expect(empty.complete).toBe(false);
      expect(empty.losers.length).toBe(0);
      // The opening round is engine round 0 (the `first_loss_no_opening_round` refusal otherwise).
      expect(Math.min(...(await rowsNow()).map((r) => r.round)), "the opening round is round 0").toBe(0);
      const all = await rowsOf(s.stageId);
      const opening = all.filter((r) => r.round_no === 1 && r.home_entrant_id !== null && r.away_entrant_id !== null);
      expect(opening.length, "rig: six entrants - two real lines in round 1 (the others hold byes)").toBe(2);
      for (const r of opening) await play(s.auth, sport, r, true);
      const afterR1 = firstLossField(await rowsNow());
      expect(afterR1.complete, "the bye holders have not played their first match yet").toBe(false);
      expect(afterR1.pending.length).toBeGreaterThan(0);
      const r2 = (await rowsOf(s.stageId)).filter((r) => r.round_no === 2);
      for (const r of r2) await play(s.auth, sport, r, true);
      const afterR2 = firstLossField(await rowsNow());
      expect(afterR2.complete, "every first match is now played").toBe(true);
      // RB4-P1: the field is the entrants who lost their FIRST match. Derived from the played lines alone: a loser is a first
      // loss iff she had not played (and won) a decided line in an earlier round - the round-1 losers, and the bye holders
      // who lost round 2; a round-1 winner who loses round 2 lost her second match.
      const lines = (await rowsOf(s.stageId)).filter((r) => r.status === "decided");
      const played = new Set<string>();
      const firstLosers: string[] = [];
      for (const round of [...new Set(lines.map((r) => r.round_no))].sort((a, b) => a - b)) {
        const these = lines.filter((r) => r.round_no === round);
        for (const r of these) {
          const loser = r.outcome!.winner === r.home_entrant_id ? r.away_entrant_id! : r.home_entrant_id!;
          if (!played.has(loser)) firstLosers.push(loser);
        }
        for (const r of these) {
          played.add(r.home_entrant_id!);
          played.add(r.away_entrant_id!);
        }
      }
      expect(firstLosers.length, "rig: 2 round-1 losers and 1 bye holder who lost round 2").toBe(3);
      expect(new Set(afterR2.losers.map((l) => l.entrantId))).toEqual(new Set(firstLosers));
      swept++;
    }, 240_000);

    it(`${sport}: a STORED roundLosers{round:1} resolves its losers against the engine-round rows, and its descriptors stay in the stored numbering`, async () => {
      const s = await seedBracket({ sport, variant: variantOf(sport), stageKind: "knockout", entrants: 4 });
      const r1 = (await rowsOf(s.stageId)).filter((r) => r.round_no === 1);
      expect(r1.length, "rig: two semi-finals").toBe(2);
      for (const r of r1) await play(s.auth, sport, r, true);
      const losers = (await Promise.all(r1.map((r) => fixtureRow(r.id)))).map((r) => (r.outcome!.winner === r.home_entrant_id ? r.away_entrant_id! : r.home_entrant_id!));
      const bracket = await sql.begin((tx) => loadBracketFixtures(tx as never, s.stageId));
      const spec = { sources: [{ stage: "previous" as const, take: [{ kind: "roundLosers" as const, round: 1, count: 2 }] }], placement: "rank_order" as const };
      const out = resolveStoredProgression(spec, [{ poolCount: 1 } as never], [{ pools: [], bracket }]);
      expect(new Set(out.qualifiers.map((q) => q.entrantId)), "the round-1 losers (stored round 1 = the opening round)").toEqual(new Set(losers));
      expect(out.qualifiers.map((q) => q.descriptor), "descriptors keep the STORED round").toEqual([
        { kind: "round_loser", round: 1, position: 1 },
        { kind: "round_loser", round: 1, position: 2 },
      ]);
      // The converse: stored round 2 is the final - its loser is the one entrant.
      expect(
        () => resolveStoredProgression({ ...spec, sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 2, count: 1 }] }] }, [{ poolCount: 1 } as never], [{ pools: [], bracket }]),
        "stored round 2 is the final, undecided: refused by the engine, never silently read as round 1",
      ).toThrow(/round 1 has no loser|has no loser/);
      swept++;
    }, 240_000);
  }
  it("anti-vacuity: both shapes in both sports", () => expect(swept).toBe(SPORTS.length * 2));
});
