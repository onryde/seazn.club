// W4 app B, B5a Task 11 (X-CH-3; WD-CASC's vacant half): both finalists out -> the title is vacant automatically, nobody
// ranks 1st and both finalists rank 2nd; a Reinstate of a finalist reverses it (the one place ruling 271's "wait on the
// desk" yields: the finalist's seat was never taken, so nothing is placed). Real Postgres, through the usecases the
// buttons call (Withdraw, the PATCH, Complete) and the public read.
//
// How a final gets two departed finalists: a withdrawal after Start is a WALKOVER to the other finalist (X-CH-2) and
// settles the final, so the vacant title is reached by the bare status flip (ruling 111's self-withdrawal, which
// cascades nothing) of one finalist and the cascade of the other - the same order the W2b suite drives (X-WD-4).
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, playBadminton, post, rowsOf, type FixtureRow } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { divisionTitle } from "@/server/public-site/champion";
import { getPublicDivision } from "@/server/public-site/data";
import { patchEntrant, writeEntrantPatch } from "../entrants";
import { completeStage, getStandings } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// The sport registry rows a two-entrant final can be seeded for without play (the final is the draw). Football's held
// rig switches the extra time and penalties off (stageRules {}), as the W2b suite does.
const SPORTS = [
  { sport: "badminton", variant: declaredVariant("badminton", "bwf"), extra: {} },
  { sport: "football", variant: declaredVariant("football", "11-a-side"), extra: { stageRules: {} } },
  { sport: "boardgame", variant: declaredVariant("boardgame", "classical"), extra: {} },
] as const;

const activeEvents = async (fixtureId: string) =>
  (
    await sql<{ n: number }[]>`
      select count(*)::int as n from score_events e where e.fixture_id = ${fixtureId} and e.type <> 'core.void'
        and not exists (select 1 from score_events v where v.voids_event_id = e.id)`
  )[0]!.n;

async function finalOf(stageId: string): Promise<FixtureRow> {
  const finals = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} and is_final and not third_place`;
  expect(finals, "rig: exactly one deciding final").toHaveLength(1);
  return fixtureRow(finals[0]!.id);
}

/** The ranks the stage's stored placement holds, by entrant. */
async function ranksOf(auth: Parameters<typeof getStandings>[0], stageId: string): Promise<Map<string, number>> {
  const snap = await getStandings(auth, stageId);
  const rows = snap.rows as { entrantId: string; rank: number }[];
  expect(rows.length, "anti-vacuity: the snapshot has rows").toBeGreaterThan(0);
  return new Map(rows.map((r) => [r.entrantId, r.rank]));
}

/** Out by the bare flip (no cascade), then out by the cascade: the second departure is the trigger. */
async function bothOut(
  s: { auth: Parameters<typeof getStandings>[0] },
  first: string,
  second: string,
  secondAs: "withdrawn" | "disqualified" = "withdrawn",
): Promise<void> {
  await writeEntrantPatch(s.auth, first, { status: "withdrawn" });
  await withdrawEntrantCascade(s.auth, second, { as: secondAs });
}

describe.skipIf(!HAS_DB)("W4 B5a T11: both finalists out leaves the title vacant (X-CH-3)", () => {
  for (const sp of SPORTS) {
    it(`X-CH-3 both finalists withdraw: the final is a departure double walkover, both rank 2nd, nobody 1st (${sp.sport})`, async () => {
      // differential: today the final waits for settle (X-WD-4), nothing is written and Complete answers not finished.
      const s = await seedBracket({ sport: sp.sport, variant: sp.variant, stageKind: "knockout", entrants: 2, ...sp.extra });
      const final = await finalOf(s.stageId);
      const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
      await bothOut(s, a, b);
      const after = await fixtureRow(final.id);
      expect([after.status, after.outcome, after.home_entrant_id, after.away_entrant_id]).toEqual(["forfeited", { kind: "double_walkover" }, a, b]);
      expect(await activeEvents(final.id), "no event, as a bye is written").toBe(0);
      const done = await completeStage(s.auth, s.stageId);
      expect(done.completed, "no settle is asked: the stage completes").toBe(true);
      const ranks = await ranksOf(s.auth, s.stageId);
      // Rank places (X-CH-3, X-FR-1): both finalists 2nd, 1st vacant.
      expect([...ranks.values()].sort(), "nobody 1st, both 2nd").toEqual([2, 2]);
      expect(ranks.get(a)).toBe(2);
      expect(ranks.get(b)).toBe(2);
    });
  }

  it("X-CH-3 four entrants: the semi-final losers share 3rd behind the vacant title; the public title reads vacant", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    expect(semis, "rig: two seated semis").toHaveLength(2);
    for (const sf of semis) await playBadminton(s.auth, sf.id, true);
    const final = await finalOf(s.stageId);
    expect([final.home_entrant_id, final.away_entrant_id].every((x) => x !== null), "rig: both finalists seated").toBe(true);
    await bothOut(s, final.home_entrant_id!, final.away_entrant_id!);
    expect((await completeStage(s.auth, s.stageId)).completed).toBe(true);
    const ranks = await ranksOf(s.auth, s.stageId);
    // Rank places table: [2, 2, 3, 3] (X-CH-3 then the shared 3rd, X-TP-3).
    expect([...ranks.values()].sort()).toEqual([2, 2, 3, 3]);
    // The public read: the stage's final is a double walkover, so divisionTitle is vacant.
    const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div from divisions d
        join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id where d.id = ${s.divisionId}`;
    await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
    const data = await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div);
    expect(data, "the public division reads").not.toBeNull();
    expect(divisionTitle(data!.stages, data!.fixtures, data!.standings)).toMatchObject({ kind: "vacant" });
  });

  it("X-CH-3 a disqualification counts as out", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    await bothOut(s, final.home_entrant_id!, final.away_entrant_id!, "disqualified");
    expect((await fixtureRow(final.id)).outcome).toEqual({ kind: "double_walkover" });
  });

  it("X-CH-2 a single withdrawal is still a walkover to the other finalist (the second departure is the trigger)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    await withdrawEntrantCascade(s.auth, final.home_entrant_id!);
    const after = await fixtureRow(final.id);
    expect([after.status, after.outcome]).toEqual([
      "forfeited",
      { kind: "award", winner: final.away_entrant_id, loser: final.home_entrant_id, reason: "withdrew" },
    ]);
  });

  it("empty case: a final with one seat TBD and the seated finalist withdrawing stays X-WD-3's dead-seat walkover, never vacant", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    await playBadminton(s.auth, semis[0]!.id, true);
    const seated = (await fixtureRow(semis[0]!.id)).outcome as { winner: string };
    await withdrawEntrantCascade(s.auth, seated.winner);
    const final = await finalOf(s.stageId);
    expect(final.outcome?.kind, "no double walkover with a seat still TBD").not.toBe("double_walkover");
    expect(final.status).toBe("scheduled");
  });

  it("X-CH-3 only the deciding final is the TITLE's: a third-place match with both sides out is X-TP-7's departure double walkover, never a vacant title", async () => {
    // B4 T9 (X-TP-7) supersedes the hold this test used to pin ("stays open"): the bronze match is settled by the same
    // no-event write, and the deciding final is untouched - nobody's title is vacant while its finalists are in.
    const s = await seedBracket({
      sport: "badminton",
      variant: declaredVariant("badminton", "bwf"),
      stageKind: "knockout",
      entrants: 4,
      stageConfig: { thirdPlace: true },
    });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    for (const sf of semis) await playBadminton(s.auth, sf.id, true);
    const [bronze] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s.stageId} and third_place`;
    expect(bronze, "rig: a third-place match").toBeDefined();
    const b = await fixtureRow(bronze!.id);
    expect([b.home_entrant_id, b.away_entrant_id].every((x) => x !== null), "rig: both bronze seats filled").toBe(true);
    await bothOut(s, b.home_entrant_id!, b.away_entrant_id!);
    const after = await fixtureRow(b.id);
    expect(after.outcome, "the bronze match is a departure double walkover").toEqual({ kind: "double_walkover" });
    const final = await finalOf(s.stageId);
    expect([final.status, final.outcome], "the deciding final is untouched").toEqual(["scheduled", null]);
  });

  it("X-CH-3 reinstating one finalist reverses it: a walkover to them, champion; reinstating the other re-opens the final", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    await bothOut(s, a, b);
    expect((await fixtureRow(final.id)).outcome).toEqual({ kind: "double_walkover" });
    // The Reinstate door (ruling 271 sends every other knockout arrival to the desk flag; the final's seat was never taken).
    await patchEntrant(s.auth, a, { status: "confirmed" });
    const one = await fixtureRow(final.id);
    expect([one.status, one.outcome]).toEqual(["forfeited", { kind: "award", winner: a, loser: b, reason: "withdrew" }]);
    expect(await activeEvents(final.id)).toBe(0);
    const flagged = await sql<{ n: number }[]>`select count(*)::int as n from entrants where id = ${a} and knockout_waiting_stage_id is not null`;
    expect(flagged[0]!.n, "nothing is placed and nobody waits").toBe(0);
    expect((await completeStage(s.auth, s.stageId)).completed).toBe(true);
    expect((await ranksOf(s.auth, s.stageId)).get(a), "the reinstated finalist is champion").toBe(1);
    // the stage had completed with the walkover standing: reinstating the second re-opens the final AND the stage
    await patchEntrant(s.auth, b, { status: "confirmed" });
    const both = await fixtureRow(final.id);
    expect([both.status, both.outcome]).toEqual(["scheduled", null]);
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${s.stageId}`;
    expect(st!.status, "a completed stage whose final is open again is active").toBe("active");
    // Sequence: vacant -> reinstate -> vacant again (both out again by the same doors)
    await bothOut(s, a, b);
    expect((await fixtureRow(final.id)).outcome).toEqual({ kind: "double_walkover" });
  });

  it("X-CH-3 a reversal after the stage completed re-ranks its snapshot", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    await bothOut(s, a, b);
    await completeStage(s.auth, s.stageId);
    expect([...(await ranksOf(s.auth, s.stageId)).values()]).toEqual([2, 2]);
    await patchEntrant(s.auth, a, { status: "confirmed" });
    const ranks = await ranksOf(s.auth, s.stageId);
    expect([ranks.get(a), ranks.get(b)], "re-ranked in the same transaction").toEqual([1, 2]);
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${s.stageId}`;
    expect(st!.status, "the stage stays complete").toBe("complete");
  });

  it("X-CH-3 a Reinstate of a NON-finalist is untouched by the revival (null) and still waits (app A, ruling 271)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    await playBadminton(s.auth, semis[0]!.id, true);
    const loser = (await fixtureRow(semis[0]!.id)).outcome as { loser: string };
    await writeEntrantPatch(s.auth, loser.loser, { status: "withdrawn" });
    const before = await sql`select id, status, outcome from fixtures where stage_id = ${s.stageId} order by id`;
    await patchEntrant(s.auth, loser.loser, { status: "confirmed" });
    const after = await sql`select id, status, outcome from fixtures where stage_id = ${s.stageId} order by id`;
    expect(after, "no fixture moved").toEqual(before);
  });

  it("X-CH-3 the console's recorded double walkover on a final is still refused (X-DW-3 holds for a recorded one)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    await expect(post(s.auth, final.id, "core.forfeit", { by: "both", reason: "walkover" })).rejects.toMatchObject({ code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" });
    expect((await fixtureRow(final.id)).status).toBe("scheduled");
  });

  it("X-CH-3 a reversal after a stage that TAKES this stage's ranks was seeded is refused by name (VACANT_TITLE_ALREADY_SEEDED)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    await bothOut(s, a, b);
    await completeStage(s.auth, s.stageId);
    // A later stage whose draw this stage's ranks filled (it takes rankRange 1-2 of it): a confirmed seed proposal on it. A stage with no
    // such take is no dependent, so an unrelated one would not refuse.
    const [next] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name, status, config, progression)
      select division_id, org_id, 2, 'knockout', 'Next', 'pending', '{}'::jsonb,
             ${sql.json({ timing: "setup", placement: "rank_order", sources: [{ stage: { stageId: s.stageId }, take: [{ kind: "rankRange", from: 1, to: 2 }] }] } as never)}
        from stages where id = ${s.stageId} returning id`;
    await sql`insert into stage_seed_proposals (org_id, stage_id, computed, status, confirmed_at)
              select org_id, ${next!.id}, '{}'::jsonb, 'confirmed', now() from stages where id = ${s.stageId}`;
    await expect(patchEntrant(s.auth, a, { status: "confirmed" })).rejects.toMatchObject({ status: 409, code: "VACANT_TITLE_ALREADY_SEEDED" });
    const [still] = await sql<{ status: string }[]>`select status from entrants where id = ${a}`;
    expect(still!.status, "the refusal rolled the Reinstate back").toBe("withdrawn");
    expect((await fixtureRow(final.id)).outcome).toEqual({ kind: "double_walkover" });
  });

  it("I-2 once the final is vacant, voiding a semi-final works again: the seat is released and the final is open, not vacant (badminton)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    expect(semis, "rig: two seated semis").toHaveLength(2);
    for (const sf of semis) await playBadminton(s.auth, sf.id, true);
    const final = await finalOf(s.stageId);
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    await bothOut(s, a, b);
    expect((await fixtureRow(final.id)).outcome, "premise: the title is vacant").toEqual({ kind: "double_walkover" });
    // Take back the second game of the semi that seated `a`: the semi is undecided again.
    const feeder = semis.find((sf) => sf.winner_to_fixture === final.id && (sf.winner_to_slot === 1 ? final.home_entrant_id : final.away_entrant_id) === a)!;
    const live = await sql<{ id: string }[]>`
      select e.id from score_events e where e.fixture_id = ${feeder.id} and e.type = 'badminton.game.summary'
        and not exists (select 1 from score_events v where v.voids_event_id = e.id) order by e.seq desc`;
    await post(s.auth, feeder.id, "core.void", { event_id: live[0]!.id });
    const after = await fixtureRow(final.id);
    expect([after.status, after.outcome], "the final is open again, not vacant").toEqual(["scheduled", null]);
    expect(feeder.winner_to_slot === 1 ? after.home_entrant_id : after.away_entrant_id, "the voided semi's seat is released").toBeNull();
    expect(feeder.winner_to_slot === 1 ? after.away_entrant_id : after.home_entrant_id, "the other finalist keeps its seat").toBe(b);
    // The semi can be replayed to the other result and the final takes the new finalist.
    await post(s.auth, feeder.id, "badminton.game.summary", { home: 10, away: 21 });
    await post(s.auth, feeder.id, "badminton.game.summary", { home: 10, away: 21 });
    expect((await fixtureRow(feeder.id)).status, "premise: the replayed semi decided (away wins 2-1)").toBe("decided");
    const replayed = await fixtureRow(final.id);
    const replayWinner = (await fixtureRow(feeder.id)).outcome as { winner: string };
    expect(replayWinner.winner, "premise: the replay's winner is the semi's away side").toBe(feeder.away_entrant_id);
    expect(feeder.winner_to_slot === 1 ? replayed.home_entrant_id : replayed.away_entrant_id, "the replayed semi seats ITS WINNER").toBe(replayWinner.winner);
  });

  it("n-2 the I-2 reset is final-only: a non-final departure double walkover keeps NEXT_MATCH_STARTED; a played non-final too", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 8 });
    const quarters = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    expect(quarters.length, "rig: four seated quarters").toBe(4);
    for (const q of quarters) await playBadminton(s.auth, q.id, true);
    const semiId = (await fixtureRow(quarters[0]!.id)).winner_to_fixture!;
    const feeders = quarters.filter((q) => q.winner_to_fixture === semiId);
    expect(feeders, "rig: two quarters feed the semi").toHaveLength(2);
    const semi = await fixtureRow(semiId);
    const [a, b] = [semi.home_entrant_id!, semi.away_entrant_id!];
    // The OTHER semi is played: a played non-final with events.
    const otherSemi = (await rowsOf(s.stageId)).find((r) => r.id !== semiId && r.home_entrant_id && r.away_entrant_id && r.winner_to_fixture === semi.winner_to_fixture)!;
    const otherFeeder = quarters.find((q) => q.winner_to_fixture === otherSemi.id)!;
    await playBadminton(s.auth, otherSemi.id, true);
    // Both seated semi-finalists out: a departure double walkover on a line that FEEDS the final.
    await bothOut(s, a, b);
    expect((await fixtureRow(semiId)).outcome, "premise: the semi is a departure double walkover").toEqual({ kind: "double_walkover" });
    const lastGame = async (id: string) =>
      (await sql<{ id: string }[]>`
        select e.id from score_events e where e.fixture_id = ${id} and e.type = 'badminton.game.summary'
          and not exists (select 1 from score_events v where v.voids_event_id = e.id) order by e.seq desc limit 1`)[0]!.id;
    const before = await sql`select id, status, outcome, home_entrant_id, away_entrant_id from fixtures where stage_id = ${s.stageId} order by id`;
    // Taking back a quarter that seated the double-walkover semi: still refused (it feeds on), nothing written.
    await expect(post(s.auth, feeders[0]!.id, "core.void", { event_id: await lastGame(feeders[0]!.id) })).rejects.toMatchObject({ code: "NEXT_MATCH_STARTED" });
    // Taking back a quarter that seated a PLAYED semi: refused, nothing written.
    await expect(post(s.auth, otherFeeder.id, "core.void", { event_id: await lastGame(otherFeeder.id) })).rejects.toMatchObject({ code: "NEXT_MATCH_STARTED" });
    const after = await sql`select id, status, outcome, home_entrant_id, away_entrant_id from fixtures where stage_id = ${s.stageId} order by id`;
    expect(after, "both refusals rolled back").toEqual(before);
  });
});

// W4 T16 fix round 1 (PO ruling 2026-11-10, RB4-C3 / RB4-T6): both finalists out is the vacant title WHATEVER the order and whichever
// door - two desk Withdraws in a row included. The first Withdraw settles the final as a `withdrew` walkover to the other finalist;
// the second departure turns that walkover into the departure double walkover. A PLAYED final stays as played (ruling 271).
describe.skipIf(!HAS_DB)("W4 T16 fix 1: two sequential Withdraws of both finalists leave the title vacant (RB4-C3)", () => {
  let checked = 0;
  afterAll(() => {
    if (HAS_DB) expect(checked, "anti-vacuity: the sequential-withdraw cases ran").toBeGreaterThan(0);
  });
  const twice = async (s: { auth: Parameters<typeof getStandings>[0] }, first: string, second: string) => {
    await withdrawEntrantCascade(s.auth, first);
    await withdrawEntrantCascade(s.auth, second);
  };

  for (const sp of SPORTS) {
    for (const order of ["home first", "away first"] as const) {
      it(`(a, b, f) both finalists Withdraw one after the other (${order}): vacant, no event, both rank 2nd (${sp.sport})`, async () => {
        const s = await seedBracket({ sport: sp.sport, variant: sp.variant, stageKind: "knockout", entrants: 2, ...sp.extra });
        const final = await finalOf(s.stageId);
        const [a, b] = order === "home first" ? [final.home_entrant_id!, final.away_entrant_id!] : [final.away_entrant_id!, final.home_entrant_id!];
        await withdrawEntrantCascade(s.auth, a);
        // premise (the first Withdraw): a walkover to the other finalist - the state the second departure must turn over.
        expect((await fixtureRow(final.id)).outcome, "premise: the first Withdraw walks the final over").toMatchObject({ kind: "award", winner: b, reason: "withdrew" });
        await withdrawEntrantCascade(s.auth, b);
        const after = await fixtureRow(final.id);
        expect([after.status, after.outcome]).toEqual(["forfeited", { kind: "double_walkover" }]);
        expect(await activeEvents(final.id), "no live event: the walkover's forfeit is voided, nothing recorded").toBe(0);
        expect((await completeStage(s.auth, s.stageId)).completed).toBe(true);
        const ranks = await ranksOf(s.auth, s.stageId);
        expect([...ranks.values()].sort(), "nobody 1st, both 2nd (RB4-C3)").toEqual([2, 2]);
        checked++;
      });
    }
  }

  it("(e) vacant by two Withdraws, then a Reinstate reverses it: a walkover to the reinstated finalist, the other reinstated re-opens the final", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    await twice(s, a, b);
    expect((await fixtureRow(final.id)).outcome, "premise: vacant").toEqual({ kind: "double_walkover" });
    await patchEntrant(s.auth, a, { status: "confirmed" });
    expect((await fixtureRow(final.id)).outcome).toEqual({ kind: "award", winner: a, loser: b, reason: "withdrew" });
    await patchEntrant(s.auth, b, { status: "confirmed" });
    const open = await fixtureRow(final.id);
    expect([open.status, open.outcome]).toEqual(["scheduled", null]);
    // sequence: out again by the same door
    await twice(s, a, b);
    expect((await fixtureRow(final.id)).outcome).toEqual({ kind: "double_walkover" });
    checked++;
  });

  const footballWins = async (auth: Parameters<typeof getStandings>[0], id: string) => {
    await post(auth, id, "core.start");
    await post(auth, id, "football.goal", { by: (await fixtureRow(id)).home_entrant_id, minute: 12 });
    await post(auth, id, "football.period", { phase: "HT" });
    await post(auth, id, "football.period", { phase: "FT" });
    const r = await fixtureRow(id);
    if (r.status !== "decided") throw new Error(`rig: ${r.ext_key} did not decide (${r.status})`);
  };
  const bronzeSports = [
    { sport: "badminton", variant: declaredVariant("badminton", "bwf"), extra: {}, play: async (auth: Parameters<typeof getStandings>[0], id: string) => void (await playBadminton(auth, id, true)) },
    { sport: "football", variant: declaredVariant("football", "11-a-side"), extra: { stageRules: {} }, play: footballWins },
  ] as const;
  for (const sp of bronzeSports) {
    it(`(c) the third-place match: its two sides Withdraw one after the other - vacant 3rd, both rank 4th (1, 2, 4, 4) (${sp.sport})`, async () => {
      const s = await seedBracket({ sport: sp.sport, variant: sp.variant, stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true }, ...sp.extra });
      for (const sf of (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id)) await sp.play(s.auth, sf.id);
      const [bronze] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s.stageId} and third_place`;
      const b0 = await fixtureRow(bronze!.id);
      const [a, b] = [b0.home_entrant_id!, b0.away_entrant_id!];
      await withdrawEntrantCascade(s.auth, a);
      expect((await fixtureRow(b0.id)).outcome, "premise: walkover to the other").toMatchObject({ kind: "award", winner: b, reason: "withdrew" });
      await withdrawEntrantCascade(s.auth, b);
      expect((await fixtureRow(b0.id)).outcome).toEqual({ kind: "double_walkover" });
      const final = await finalOf(s.stageId);
      expect([final.status, final.outcome], "the deciding final is untouched").toEqual(["scheduled", null]);
      await sp.play(s.auth, final.id);
      expect((await completeStage(s.auth, s.stageId)).completed).toBe(true);
      const ranks = await ranksOf(s.auth, s.stageId);
      expect([...ranks.values()].sort(), "1st, 2nd, and the two bronze sides level 4th").toEqual([1, 2, 4, 4]);
      expect([ranks.get(a), ranks.get(b)]).toEqual([4, 4]);
      checked++;
    });
  }

  it("(d) a PLAYED final stays as played when a finalist then withdraws: the champion is unchanged (ruling 271)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    await playBadminton(s.auth, final.id, true);
    const played = await fixtureRow(final.id);
    const champion = (played.outcome as { winner: string }).winner;
    const events = await activeEvents(final.id);
    expect(events, "premise: the final has recorded play").toBeGreaterThan(0);
    await withdrawEntrantCascade(s.auth, champion);
    await withdrawEntrantCascade(s.auth, champion === final.home_entrant_id ? final.away_entrant_id! : final.home_entrant_id!);
    const after = await fixtureRow(final.id);
    expect([after.status, after.outcome]).toEqual([played.status, played.outcome]);
    expect(await activeEvents(final.id), "the ledger is untouched").toBe(events);
    checked++;
  });

  it("(g) the walkover's LOSER departing again is no vacancy: the other finalist is still in and stays champion-elect", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    await withdrawEntrantCascade(s.auth, a);
    const ledger = async () => (await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${final.id}`)[0]!.n;
    const rows = await ledger();
    expect(rows, "premise: the first Withdraw wrote its forfeit").toBeGreaterThan(0);
    await withdrawEntrantCascade(s.auth, a, { as: "disqualified" });
    expect(await ledger(), "the walkover is not voided and re-written: b is still in").toBe(rows);
    expect((await fixtureRow(final.id)).outcome, "b still holds the walkover").toMatchObject({ kind: "award", winner: b, reason: "withdrew" });
    checked++;
  });

  it("(I2) Withdraw, the organiser Completes the stage, then the walkover champion withdraws: the CHAMPION STANDS (PO ruling 2026-11-10)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    await withdrawEntrantCascade(s.auth, a);
    expect((await completeStage(s.auth, s.stageId)).completed).toBe(true);
    const ranksBefore = await ranksOf(s.auth, s.stageId);
    expect([ranksBefore.get(b), ranksBefore.get(a)], "premise: b champion, a 2nd").toEqual([1, 2]);
    const ledger = async () => (await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${final.id}`)[0]!.n;
    const rows = await ledger();
    await withdrawEntrantCascade(s.auth, b);
    const after = await fixtureRow(final.id);
    expect([after.status, after.outcome], "the walkover stands").toEqual(["forfeited", { kind: "award", winner: b, loser: a, reason: "withdrew" }]);
    expect(await ledger(), "no void, no re-write").toBe(rows);
    expect([...(await ranksOf(s.auth, s.stageId)).entries()].sort(), "the stored ranks are unchanged").toEqual([...ranksBefore.entries()].sort());
    const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div from divisions d
        join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id where d.id = ${s.divisionId}`;
    await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
    const data = await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div);
    expect(divisionTitle(data!.stages, data!.fixtures, data!.standings), "the public title agrees").toMatchObject({ kind: "champion" });
    checked++;
  });

  it("(I2, -3p) the stage Completed, the bronze walkover winner then withdraws: the bronze walkover stands", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    for (const sf of (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id)) await playBadminton(s.auth, sf.id, true);
    const [bronze] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s.stageId} and third_place`;
    const b0 = await fixtureRow(bronze!.id);
    const [a, b] = [b0.home_entrant_id!, b0.away_entrant_id!];
    await withdrawEntrantCascade(s.auth, a);
    await playBadminton(s.auth, (await finalOf(s.stageId)).id, true);
    expect((await completeStage(s.auth, s.stageId)).completed).toBe(true);
    await withdrawEntrantCascade(s.auth, b);
    expect((await fixtureRow(b0.id)).outcome).toEqual({ kind: "award", winner: b, loser: a, reason: "withdrew" });
    checked++;
  });

  it("(m1) a walkover that is NOT a withdrawal (the organiser's award) stays an award when its winner then departs", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    await post(s.auth, final.id, "core.forfeit", { by: a, reason: "walkover" });
    const before = await fixtureRow(final.id);
    expect(before.outcome, "premise: an award for another reason").toMatchObject({ kind: "award", winner: b });
    expect((before.outcome as { reason?: string }).reason, "premise: not a withdrawal").not.toBe("withdrew");
    await withdrawEntrantCascade(s.auth, b);
    const after = await fixtureRow(final.id);
    expect([after.status, after.outcome]).toEqual([before.status, before.outcome]);
    checked++;
  });

  it("(m1) a SEMI-final is no final: withdraw A then B there, and the semi stays an award to B", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const semi = (await rowsOf(s.stageId)).find((r) => r.home_entrant_id && r.away_entrant_id)!;
    const [a, b] = [semi.home_entrant_id!, semi.away_entrant_id!];
    await withdrawEntrantCascade(s.auth, a);
    expect((await fixtureRow(semi.id)).outcome, "premise: walkover to b").toMatchObject({ kind: "award", winner: b, reason: "withdrew" });
    await withdrawEntrantCascade(s.auth, b);
    expect((await fixtureRow(semi.id)).outcome, "still an award to b, never a double walkover").toMatchObject({ kind: "award", winner: b });
    checked++;
  });
});
