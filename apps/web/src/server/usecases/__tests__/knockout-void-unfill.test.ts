// Owner-reported (2026-09-23), owner-approved fix: VOIDING A DECIDED KNOCKOUT
// RESULT MUST TAKE BACK THE NAME IT ADVANCED.
//
// THE DEFECT. A decided fixture seats its winner (and, on a `loser_to` edge,
// its loser) in the next fixture through `fillSlot`, which only ever writes a
// NULL seat. A void that erased the decision recomputed nothing but standings,
// so the name stayed where the old result had put it. Re-scoring the match the
// OTHER way then ran a fill that touched no row: the next round kept the old
// winner, and no organiser control could fix it short of "Rebuild fixtures",
// which wipes the schedule.
//
// THE RULING (owner-approved 2026-09-23):
//  1. When a void erases a decision, the seat it fed IN THE SAME STAGE is
//     emptied and its "Winner of R1·2" label restored — only if the seat holds
//     one of THIS fixture's two entrants, and only if the next fixture has not
//     started (scheduled, no outcome, no live score events).
//  2. If it HAS started, the void is refused before anything is written:
//     409 NEXT_MATCH_STARTED, naming the next match. The organiser unwinds
//     latest match first. No chain logic — with ONE exception added in fix
//     round 1: a walkover the cascade awarded is not a started match, so it is
//     reset and the reset follows what that walkover advanced (see the end of
//     this file).
//  3. Re-deciding needs no new code — the ordinary fill seats the new winner.
//  4. Cross-stage feeds are out of scope and must behave exactly as before.
//  5. (Fix round 1.) A void that FLIPS the winner without the fold passing
//     through undecided takes the old names back the same way.
//
// Every scene is driven through the real `scoreEvent` — the door the console,
// the pad and the device link all share — never through `fillSlot` directly.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { generateSingleElim } from "@seazn/engine/scheduling";
import { cricket } from "@seazn/engine/sports/cricket";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { scriptLedger, type Delivery } from "@/server/public-site/__tests__/cricket-ledger";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { getFixtureState, listDivisionFixturesForBoard } from "../fixtures";
import { onDecided, scoreEvent } from "../scoring";
import { appendEvent } from "@/server/engine-db";
import { releaseFedSeats } from "@/server/engine-db/fed-seats";
import { fixtureAwaitsSeedDraw } from "@/lib/division-phase";
import {
  completeStage,
  computeSeedProposal,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
  listStages,
  resolveBracketSeats,
} from "../stages";
import { boardRoundCodes } from "@/components/v2/board/round-codes";
import { matchRef } from "@/lib/slot-label";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import { nextMatchLabel, nextMatchRefOf, type NextMatchRef } from "@/lib/next-match-started";
import { withdrawEntrantCascade } from "../withdrawal";
import { resnapshotFixtureConfig } from "../admin-fixture-config";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Label {
  key: string;
  params: Record<string, unknown>;
}

interface Row {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: Label | null;
  away_slot_label: Label | null;
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string } | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
  third_place: boolean;
}

async function row(id: string): Promise<Row> {
  const [r] = await sql<Row[]>`
    select id, stage_id, round_no, seq_in_round, home_entrant_id, away_entrant_id,
           home_slot_label, away_slot_label, status, outcome,
           winner_to_fixture, winner_to_slot, loser_to_fixture, loser_to_slot, third_place
    from fixtures where id = ${id}`;
  if (!r) throw new Error(`no fixture ${id}`);
  return r;
}

/** Who sits in seat `slot` (1 = home, 2 = away) of `r`. */
const seat = (r: Row, slot: number | null) => (slot === 1 ? r.home_entrant_id : r.away_entrant_id);
const seatLabel = (r: Row, slot: number | null) => (slot === 1 ? r.home_slot_label : r.away_slot_label);

async function eventCount(fixtureId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
  return n;
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  /** Round one, in draw order. */
  r1: Row[];
  /** The fixture both round-one lines feed with their WINNER. */
  final: Row;
  /** The third-place line, when the stage has one. */
  third: Row | null;
}

/** A started four-entrant knockout on the plain generation path — the path
 *  that STAMPS `slot.winner_match` / `slot.loser_match` onto every fed seat.
 *  Everything is read back off the rows the generator wrote, never assumed. */
async function knockout(
  config: Record<string, unknown> = {},
  sport: { sport_key: string; variant_key: string; config: Record<string, unknown> } = {
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  },
): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Void Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    ...sport,
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, [{ seq: 1, kind: "knockout", name: "Cup", config }]);
  await generateStageFixtures(auth, stage!.id);
  await sql`update divisions set status = 'active' where id = ${division.id}`;
  const ids = await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  const rows = await Promise.all(ids.map((r) => row(r.id)));
  const r1 = rows.filter((r) => r.round_no === 1);
  const finalId = r1[0]!.winner_to_fixture;
  expect(finalId, "round one feeds a final").not.toBeNull();
  expect(r1.every((r) => r.winner_to_fixture === finalId), "both lines feed the SAME final").toBe(true);
  return {
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    r1,
    final: rows.find((r) => r.id === finalId)!,
    third: rows.find((r) => r.third_place) ?? null,
  };
}

async function lastSeq(auth: AuthCtx, fixtureId: string): Promise<number> {
  return (await getFixtureState(auth, fixtureId)).last_seq;
}

async function append(auth: AuthCtx, fixtureId: string, type: string, payload: unknown) {
  return scoreEvent(auth, fixtureId, { expected_seq: await lastSeq(auth, fixtureId), type, payload });
}

/** Start and decide `fixtureId`; the HOME side wins unless `awayWins`. Returns
 *  the id of the deciding event, which is what a console "Void" names. */
async function decide(auth: AuthCtx, fixtureId: string, awayWins = false): Promise<string> {
  const s = await getFixtureState(auth, fixtureId);
  if (s.status === "scheduled" && s.last_seq === 0) await append(auth, fixtureId, "core.start", {});
  const out = await append(auth, fixtureId, "generic.result", awayWins ? { p1Score: 0, p2Score: 2 } : { p1Score: 2, p2Score: 0 });
  expect(out.outcome, "the result decided the fixture").not.toBeNull();
  return out.event_id;
}

async function voidEvent(auth: AuthCtx, fixtureId: string, eventId: string) {
  return append(auth, fixtureId, "core.void", { event_id: eventId });
}

/** The error a refused call rejected with — and it MUST reject. */
async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the call was expected to be refused").toBeInstanceOf(HttpError);
  return err as HttpError;
}

const LOCALES = ["en", "fr", "es", "nl"] as const;
type Locale = (typeof LOCALES)[number];
const lookupIn = (locale: Locale) => (key: MessageKey, vars?: Record<string, string | number>) =>
  msgFor(locale, key, vars);

/** What the SCHEDULE BOARD calls `fixtureId` in `locale` — the expression
 *  schedule-board.tsx builds each card's ref with (`matchRef` over the code
 *  `boardRoundCodes` gives it), fed by the board's own read. Fix round 2
 *  ruling: the refusal names the next match with exactly this. */
async function boardRef(auth: AuthCtx, fixtureId: string, locale: Locale = "en"): Promise<string> {
  const [{ division_id }] = await sql<{ division_id: string }[]>`select division_id from fixtures where id = ${fixtureId}`;
  const [board, stages] = await Promise.all([
    listDivisionFixturesForBoard(auth, division_id),
    listStages(auth, division_id),
  ]);
  const f = board.find((x) => x.id === fixtureId)!;
  const lookup = lookupIn(locale);
  return matchRef(f.round_no, f.seq_in_round, lookup, boardRoundCodes(board, stages, lookup).get(f.id)?.code);
}

/** The refusal names `fixtureId` — by the board's label, in every language the
 *  reader might read it in, and in the server's own English sentence. */
async function expectNamesTheBoardsWay(auth: AuthCtx, err: HttpError, fixtureId: string): Promise<NextMatchRef> {
  const ref = nextMatchRefOf(err.extra);
  expect(ref, "the refusal carries a ref a reader accepts").not.toBeNull();
  expect(ref!.fixture_id).toBe(fixtureId);
  for (const locale of LOCALES) {
    expect(nextMatchLabel(ref!, lookupIn(locale)), `${locale}: the label the board shows`).toBe(
      await boardRef(auth, fixtureId, locale),
    );
  }
  expect(err.message, "the server's own sentence names it the board's way").toContain(`(${await boardRef(auth, fixtureId)})`);
  return ref!;
}

describe.skipIf(!HAS_DB)("voiding a decided knockout result takes back the name it advanced", () => {
  it("empties the seat the winner was advanced into, and restores the label the GENERATOR stamped there", async () => {
    const rig = await knockout();
    // R1·2, not R1·1: its round and seq DIFFER, so a label restored with the
    // two swapped (or with the target's own ref) cannot pass by coincidence.
    const line = rig.r1[1]!;
    expect(line.round_no, "premise: round and seq differ").not.toBe(line.seq_in_round);
    const slot = line.winner_to_slot;
    // The label is read off generation, not typed here: "restore" means the
    // SAME value the draw wrote, whatever shape that is.
    const drawn = seatLabel(rig.final, slot);
    expect(drawn, "the plain generator stamps a feeder label on a fed seat").toEqual({
      key: "slot.winner_match",
      params: { round: line.round_no, seq: line.seq_in_round },
    });

    const decider = await decide(rig.auth, line.id);
    const seated = await row(rig.final.id);
    expect(seat(seated, slot), "precondition: the winner was advanced").toBe(line.home_entrant_id);
    expect(seatLabel(seated, slot), "precondition: filling the seat cleared its label").toBeNull();

    await voidEvent(rig.auth, line.id, decider);

    const after = await row(rig.final.id);
    expect(seat(after, slot), "the old winner no longer holds the seat").toBeNull();
    expect(seatLabel(after, slot), "and the seat reads 'Winner of …' again").toEqual(drawn);
    expect((await row(line.id)).outcome, "the void erased the decision").toBeNull();
  });

  it("on a `timing: \"setup\"` draw the seat goes back to NO label — the shape THAT generator left, so the desk does not read the drawn bracket as owing its draw again", async () => {
    // Groups of two, each winner qualifying into a setup-timed knockout: the
    // shape every shipped template progression has. Its generator leaves a
    // sibling-fed seat's label NULL on purpose (`fixtureAwaitsSeedDraw` reads
    // a label beside an empty seat as "owes the draw"), so restoring the plain
    // path's `slot.winner_match` here would be the wrong shape.
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Setup Cup " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
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
      Array.from({ length: 8 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const stages = await createStages(auth, division.id, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 4 } } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ]);
    const groups = stages.find((s) => s.kind === "group")!.id;
    const ko = stages.find((s) => s.kind === "knockout")!.id;
    await generateStageFixtures(auth, ko);
    await generateStageFixtures(auth, groups);
    for (const f of await sql<{ id: string }[]>`select id from fixtures where stage_id = ${groups}`) {
      await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
      await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
    }
    await completeStage(auth, groups);
    await sql`update divisions set status = 'active' where id = ${division.id}`;
    const proposal = await computeSeedProposal(auth, ko);
    await confirmSeedProposal(auth, ko, { proposalId: proposal.id });

    const semis = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${ko} and round_no = 1 order by seq_in_round`;
    const line = await row(semis[0]!.id);
    const drawnFinal = await row(line.winner_to_fixture!);
    expect(seat(drawnFinal, line.winner_to_slot), "precondition: the final's seat is open after the draw").toBeNull();
    expect(seatLabel(drawnFinal, line.winner_to_slot), "…and this generator left it UNLABELLED").toBeNull();

    const decider = await decide(auth, line.id);
    expect(seat(await row(drawnFinal.id), line.winner_to_slot)).toBe(line.home_entrant_id);

    await voidEvent(auth, line.id, decider);

    const after = await row(drawnFinal.id);
    expect(seat(after, line.winner_to_slot), "the seat is emptied").toBeNull();
    expect(seatLabel(after, line.winner_to_slot), "and left exactly as the draw left it: no label").toBeNull();
    expect(fixtureAwaitsSeedDraw(after), "the drawn bracket does not read as owing its draw").toBe(false);
  });

  it("un-fills the LOSER edge too: the third-place seat the loser was dropped into", async () => {
    const rig = await knockout({ thirdPlace: true });
    expect(rig.third, "thirdPlace: true draws a third-place line").not.toBeNull();
    const [first, second] = rig.r1 as [Row, Row];
    expect(first.loser_to_fixture, "round one feeds its loser into the third-place line").toBe(rig.third!.id);
    const drawnLoserLabel = seatLabel(rig.third!, first.loser_to_slot);
    expect(drawnLoserLabel).toEqual({
      key: "slot.loser_match",
      params: { round: first.round_no, seq: first.seq_in_round },
    });

    const decider = await decide(rig.auth, first.id);
    await decide(rig.auth, second.id);
    const before = await row(rig.third!.id);
    expect(seat(before, first.loser_to_slot), "precondition: the loser was dropped").toBe(first.away_entrant_id);

    await voidEvent(rig.auth, first.id, decider);

    const third = await row(rig.third!.id);
    expect(seat(third, first.loser_to_slot), "the loser's seat is emptied").toBeNull();
    expect(seatLabel(third, first.loser_to_slot), "and reads 'Loser of …' again").toEqual(drawnLoserLabel);
    expect(seat(third, second.loser_to_slot), "the OTHER line's loser stays").toBe(second.away_entrant_id);
    const final = await row(rig.final.id);
    expect(seat(final, first.winner_to_slot), "the winner edge is emptied in the same void").toBeNull();
    expect(seat(final, second.winner_to_slot), "the other finalist stays").toBe(second.home_entrant_id);
  });

  it("leaves a seat that holds someone ELSE exactly as it is", async () => {
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    const decider = await decide(rig.auth, line.id);
    // Nothing in the product writes a fed seat except this fixture's own fill,
    // so the foreign occupant is put there by hand: the guard exists so that
    // a void can never evict a name it did not put there.
    const stranger = other.home_entrant_id!;
    const column = line.winner_to_slot === 1 ? sql`home_entrant_id` : sql`away_entrant_id`;
    await sql`update fixtures set ${column} = ${stranger} where id = ${rig.final.id}`;

    await voidEvent(rig.auth, line.id, decider);

    const after = await row(rig.final.id);
    expect(seat(after, line.winner_to_slot), "a name this fixture did not put there stays").toBe(stranger);
    expect(seatLabel(after, line.winner_to_slot), "and gains no label").toBeNull();
  });

  it("un-fills a seat holding THIS fixture's OTHER entrant too (either of its two entrants, per the ruling)", async () => {
    const rig = await knockout();
    const line = rig.r1[0]!;
    const decider = await decide(rig.auth, line.id);
    const column = line.winner_to_slot === 1 ? sql`home_entrant_id` : sql`away_entrant_id`;
    await sql`update fixtures set ${column} = ${line.away_entrant_id} where id = ${rig.final.id}`;

    await voidEvent(rig.auth, line.id, decider);

    expect(seat(await row(rig.final.id), line.winner_to_slot)).toBeNull();
  });

  // Each row is a different way for the next match to have STARTED, and each
  // is a clause of the ruling's "not started" test: status, outcome, and live
  // score events are checked separately because each can be true alone.
  it.each([
    ["in play (a live core.start)", "start"],
    ["decided", "decide"],
    ["still 'scheduled' but carrying a live score event (a note)", "note"],
  ] as const)("refuses the void when the next match is %s — and writes NOTHING", async (_label, how) => {
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    const decider = await decide(rig.auth, line.id);
    await decide(rig.auth, other.id);
    if (how === "start") await append(rig.auth, rig.final.id, "core.start", {});
    if (how === "decide") await decide(rig.auth, rig.final.id);
    if (how === "note") await append(rig.auth, rig.final.id, "core.note", { text: "coin toss done" });
    if (how === "note") expect((await row(rig.final.id)).status, "a note does not start the match").toBe("scheduled");

    const lineBefore = await row(line.id);
    const eventsBefore = await eventCount(line.id);
    const finalBefore = await row(rig.final.id);

    const err = await refusal(voidEvent(rig.auth, line.id, decider));
    expect(err.status).toBe(409);
    expect(err.code).toBe("NEXT_MATCH_STARTED");
    const ref = await expectNamesTheBoardsWay(rig.auth, err, rig.final.id);
    expect(ref, "the pair every match ref is composed from").toMatchObject({
      round: rig.final.round_no,
      seq: rig.final.seq_in_round,
    });
    // The board names a knockout final by its code ("F·1"), so the refusal
    // never prints the round number the board does not show.
    expect(ref.code, "a knockout final's round is coded").toBeDefined();
    expect(err.message).not.toContain(`R${rig.final.round_no}·${rig.final.seq_in_round}`);

    expect(await eventCount(line.id), "no void was written").toBe(eventsBefore);
    const lineAfter = await row(line.id);
    expect(lineAfter.outcome, "the result stands").toEqual(lineBefore.outcome);
    expect(lineAfter.status).toBe(lineBefore.status);
    const finalAfter = await row(rig.final.id);
    expect(seat(finalAfter, line.winner_to_slot), "the winner stays seated").toBe(seat(finalBefore, line.winner_to_slot));
  });

  // The status clause on its own. Nothing in the product writes 'cancelled'
  // (stages.ts `feederIsDead` says so), but it is a valid value an import can
  // carry, so the only way to reach it is raw SQL — the point of the test, not
  // a shortcut. A cancelled next match has no outcome and no events: only the
  // `status !== 'scheduled'` clause sees it.
  it("refuses when the next match is 'cancelled' (import-only state, written by raw SQL): the STATUS alone says it is not waiting", async () => {
    const rig = await knockout();
    const line = rig.r1[0]!;
    const decider = await decide(rig.auth, line.id);
    await sql`update fixtures set status = 'cancelled' where id = ${rig.final.id}`;
    const final = await row(rig.final.id);
    expect([final.outcome, await eventCount(rig.final.id)], "premise: no outcome, no events").toEqual([null, 0]);

    const err = await refusal(voidEvent(rig.auth, line.id, decider));
    expect(err.code).toBe("NEXT_MATCH_STARTED");
    expect(seat(await row(rig.final.id), line.winner_to_slot)).toBe(line.home_entrant_id);
  });

  // A next match the SYSTEM settled: its other feeder is dead, so deciding
  // this line hands the final to its winner as a walkover — a real outcome with
  // no score event behind it. CONTROLLER RULING, fix round 1: a match decided
  // ONLY by the cascade has not started — nobody played it and there is
  // nothing on it to void — so it is RESET rather than refused, and re-deciding
  // the line lets the cascade award it again.
  it("UN-DOES a final the cascade walked over (an award with no score event): scheduled again, the seat empty and labelled, the bye kept", async () => {
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    // The dead sibling feeder, written the way `dead-feeder-cascade.test.ts`
    // writes it: raw SQL is the only road to a 'cancelled' line.
    await sql`update fixtures set status = 'cancelled', outcome = null,
                home_entrant_id = null, away_entrant_id = null
              where id = ${other.id}`;
    const drawn = seatLabel(rig.final, line.winner_to_slot);
    const decider = await decide(rig.auth, line.id);
    const final = await row(rig.final.id);
    expect(final.status, "premise: the final was walked over to this line's winner").toBe("forfeited");
    expect(final.outcome).toEqual({ kind: "award", winner: line.home_entrant_id });
    expect(await eventCount(rig.final.id), "…with no score event behind it").toBe(0);
    expect(seatLabel(final, other.winner_to_slot)?.key, "premise: the dead side carries the bye").toBe("bracket.slot.bye");

    const out = await voidEvent(rig.auth, line.id, decider);
    expect(out.outcome, "the void went through").toBeNull();

    const after = await row(rig.final.id);
    expect(after.status, "the walkover is undone").toBe("scheduled");
    expect(after.outcome).toBeNull();
    expect(seat(after, line.winner_to_slot), "the old winner is taken back").toBeNull();
    expect(seatLabel(after, line.winner_to_slot), "and the seat reads 'Winner of …' again").toEqual(drawn);
    expect(seat(after, other.winner_to_slot), "the dead side is still empty").toBeNull();
    expect(seatLabel(after, other.winner_to_slot), "…and still a bye, so the cascade can award it again").toEqual(
      seatLabel(final, other.winner_to_slot),
    );
    // The cascade itself re-runs cleanly over the reset: the final's live seat
    // waits on a feeder that is in play, not dead, so there is nothing to award.
    expect(await sql.begin((tx) => resolveBracketSeats(tx, rig.stageId)), "nothing to cascade yet").toEqual([]);
    expect(await row(rig.final.id)).toEqual(after);
  });

  it("re-deciding the line the OTHER way lets the cascade award the final again — to the NEW winner — and a second cascade pass writes nothing", async () => {
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    await sql`update fixtures set status = 'cancelled', outcome = null,
                home_entrant_id = null, away_entrant_id = null
              where id = ${other.id}`;
    const decider = await decide(rig.auth, line.id);
    await voidEvent(rig.auth, line.id, decider);

    await decide(rig.auth, line.id, true);

    const final = await row(rig.final.id);
    expect(final.status).toBe("forfeited");
    expect(final.outcome, "awarded to the re-decided winner, not the old one").toEqual({
      kind: "award",
      winner: line.away_entrant_id,
    });
    expect(seat(final, line.winner_to_slot)).toBe(line.away_entrant_id);
    expect(await eventCount(rig.final.id), "still nothing recorded on it").toBe(0);
    expect(await sql.begin((tx) => resolveBracketSeats(tx, rig.stageId)), "idempotent after the re-award").toEqual([]);
    expect(await row(rig.final.id)).toEqual(final);
  });

  // The other half of the same rule: an award that DOES have a score event
  // behind it is a walkover somebody recorded — here the withdrawal cascade's
  // own `core.forfeit` — and that match is a real decision, so it refuses.
  it("still REFUSES when the final was walked over by a WITHDRAWAL — an award with a live core.forfeit behind it", async () => {
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    const decider = await decide(rig.auth, line.id);
    await decide(rig.auth, other.id);
    await withdrawEntrantCascade(rig.auth, other.home_entrant_id!);
    const final = await row(rig.final.id);
    expect(final.status, "premise: the final was walked over").toBe("forfeited");
    expect(final.outcome).toMatchObject({ kind: "award", winner: line.home_entrant_id });
    expect(await eventCount(rig.final.id), "premise: by a recorded forfeit").toBe(1);

    const err = await refusal(voidEvent(rig.auth, line.id, decider));
    expect(err.code).toBe("NEXT_MATCH_STARTED");
    const after = await row(rig.final.id);
    expect(seat(after, line.winner_to_slot), "the winner stays seated").toBe(line.home_entrant_id);
    expect(after.outcome, "and the walkover stands").toEqual(final.outcome);
    expect(after.status).toBe("forfeited");
  });

  // The next match's OWN append lock. An append to the final that is already
  // in flight holds `fixture:<final>` and writes at commit; without the lock
  // the void reads "not started" before that write lands and then empties the
  // seat of a match already under way. The holder here stands in for that
  // append: it takes the same lock and moves the final to in_play at commit.
  it("waits on the next match's own append lock: a start committing during the check is SEEN, and the void refused", async () => {
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    const decider = await decide(rig.auth, line.id);
    await decide(rig.auth, other.id);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let holderPid = 0;
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + rig.final.id}))`;
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      holderPid = pid;
      await gate;
      await tx`update fixtures set status = 'in_play' where id = ${rig.final.id}`;
    });
    for (let i = 0; holderPid === 0 && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
    expect(holderPid, "the stand-in append holds the final's lock").not.toBe(0);

    let settled = false;
    const voiding = voidEvent(rig.auth, line.id, decider).then(
      () => { settled = true; return null; },
      (e: unknown) => { settled = true; return e; },
    );
    // Until the void is queued behind the holder — or, on a build without the
    // lock, until it has already gone through.
    for (let i = 0; !settled && i < 500; i++) {
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_locks
        where locktype = 'advisory' and not granted and ${holderPid} = any(pg_blocking_pids(pid))`;
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    await holder;
    const err = await voiding;

    expect(err, "the void saw the start that committed while it waited").toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("NEXT_MATCH_STARTED");
    expect(seat(await row(rig.final.id), line.winner_to_slot), "a match under way keeps its player").toBe(
      line.home_entrant_id,
    );
  });

  it("does NOT count a start that was itself voided: the next match is back to not-started, so the void goes through", async () => {
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    const decider = await decide(rig.auth, line.id);
    await decide(rig.auth, other.id);
    const started = await append(rig.auth, rig.final.id, "core.start", {});
    await voidEvent(rig.auth, rig.final.id, started.event_id);
    const final = await row(rig.final.id);
    expect(final.status, "precondition: the final is scheduled again").toBe("scheduled");
    expect(await eventCount(rig.final.id), "…with two ledger rows, neither of them live").toBe(2);

    await voidEvent(rig.auth, line.id, decider);

    expect(seat(await row(rig.final.id), line.winner_to_slot)).toBeNull();
  });

  it("a void that does NOT erase the decision leaves the next match alone, even one that has started", async () => {
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    await decide(rig.auth, line.id);
    // A note is accepted after the decision (`core.note` is post-decision in
    // the kernel); voiding it changes nothing about who won.
    const note = await append(rig.auth, line.id, "core.note", { text: "shirt colours swapped" });
    await decide(rig.auth, other.id);
    await append(rig.auth, rig.final.id, "core.start", {});

    const out = await voidEvent(rig.auth, line.id, note.event_id);

    expect(out.outcome, "still decided").not.toBeNull();
    expect(seat(await row(rig.final.id), line.winner_to_slot), "the winner stays").toBe(line.home_entrant_id);
  });

  it("the seat left open by the void waits for its feeder: NO walkover is handed to the other side", async () => {
    // The known risk, pinned before the fix was built. `resolveBracketSeats`
    // stamps a bye on an open seat whose feeder is DEAD. After an un-fill the
    // final holds one live entrant beside an open seat fed by the fixture just
    // voided — which will be re-scored, so it must read as a LIVE feeder.
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    await decide(rig.auth, other.id); // the other seat of the final is filled FIRST
    const decider = await decide(rig.auth, line.id);

    await voidEvent(rig.auth, line.id, decider);

    const voided = await row(line.id);
    // A result-void leaves the line where its remaining live events put it:
    // core.start is still live, so it is in play — which `feederIsDead`
    // (cancelled, or abandoned with no outcome) never reads as dead.
    expect(voided.status).toBe("in_play");
    expect(voided.outcome).toBeNull();
    const final = await row(rig.final.id);
    expect(seat(final, line.winner_to_slot), "the voided line's seat is open").toBeNull();
    expect(seat(final, other.winner_to_slot), "the other finalist is still seated").toBe(other.home_entrant_id);
    expect(final.status, "the final is NOT settled as a walkover").toBe("scheduled");
    expect(final.outcome).toBeNull();
    expect(final.home_slot_label?.key).not.toBe("bracket.slot.bye");
    expect(final.away_slot_label?.key).not.toBe("bracket.slot.bye");
  });

  it("void, then re-score it the OTHER way: the next match holds the NEW winner", async () => {
    const rig = await knockout();
    const line = rig.r1[0]!;
    const decider = await decide(rig.auth, line.id);
    expect(seat(await row(rig.final.id), line.winner_to_slot)).toBe(line.home_entrant_id);

    await voidEvent(rig.auth, line.id, decider);
    await decide(rig.auth, line.id, true);

    const final = await row(rig.final.id);
    expect(seat(final, line.winner_to_slot), "the re-decided winner is seated").toBe(line.away_entrant_id);
    expect(seatLabel(final, line.winner_to_slot), "a filled seat carries no label").toBeNull();
  });

  it("finalize-then-void: a finalized result is locked, so the void is refused and the seat stays", async () => {
    const rig = await knockout();
    const line = rig.r1[0]!;
    const decider = await decide(rig.auth, line.id);
    await append(rig.auth, line.id, "core.finalize", {});

    await expect(voidEvent(rig.auth, line.id, decider)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });

    expect(seat(await row(rig.final.id), line.winner_to_slot)).toBe(line.home_entrant_id);
  });

  it("a CROSS-STAGE feed is out of scope and behaves exactly as before: not refused, not un-filled", async () => {
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    // The shape `wireCrossFeeds` builds: a feed edge whose target lives in
    // ANOTHER stage. Moving the final there leaves both edges pointing at it.
    const [elsewhere] = await createStages(rig.auth, rig.divisionId, [
      { seq: 2, kind: "knockout", name: "Elsewhere", config: {} },
    ]);
    await sql`update fixtures set stage_id = ${elsewhere!.id} where id = ${rig.final.id}`;
    const decider = await decide(rig.auth, line.id);
    await decide(rig.auth, other.id);
    // Started, so a same-stage target WOULD refuse — the witness that the
    // stage boundary, not the not-started test, is what lets this through.
    await append(rig.auth, rig.final.id, "core.start", {});

    const out = await voidEvent(rig.auth, line.id, decider);

    expect(out.outcome, "the void went through").toBeNull();
    expect(seat(await row(rig.final.id), line.winner_to_slot), "and the cross-stage seat is untouched").toBe(
      line.home_entrant_id,
    );
  });
});

// The staff re-snapshot (`admin-fixture-config.ts`) is the one writer besides
// the append path that can ERASE a decision: re-folding under a corrected
// config (tennis best of three → best of five) can un-decide a line that
// already advanced its winner. It is the same erasure, so it owes the same
// ruling — found by grepping every writer of `fixtures.outcome`, not by name.
describe.skipIf(!HAS_DB)("the staff re-snapshot that un-decides a line takes the name back the same way", () => {
  const TENNIS_BEST_OF_3 = {
    bestOf: 3,
    set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 },
    finalSet: "same",
    game: { noAd: false },
    tiebreak: { winBy: 2 },
    points: { win: 2, loss: 0 },
  } as const;
  const tennis = () =>
    knockout({}, { sport_key: "tennis", variant_key: "tour", config: TENNIS_BEST_OF_3 });

  async function superadmin(): Promise<string> {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, is_staff, staff_role)
      values (${`staff-${randomUUID().slice(0, 8)}@example.test`}, 'Staff', true, 'superadmin')
      returning id`;
    return id;
  }

  /** Two straight sets: decided at best of three, still in play at five. */
  async function twoSets(auth: AuthCtx, fixtureId: string): Promise<void> {
    await append(auth, fixtureId, "core.start", {});
    await append(auth, fixtureId, "tennis.set_summary", { home: 6, away: 4 });
    const out = await append(auth, fixtureId, "tennis.set_summary", { home: 6, away: 3 });
    expect(out.outcome, "two straight sets decide a best-of-three").not.toBeNull();
  }

  async function bestOfFive(divisionId: string): Promise<void> {
    await sql`update divisions set config = ${sql.json({ ...TENNIS_BEST_OF_3, bestOf: 5 } as never)} where id = ${divisionId}`;
  }

  async function snapshotOf(fixtureId: string): Promise<unknown> {
    const [r] = await sql<{ config_snapshot: unknown }[]>`select config_snapshot from fixtures where id = ${fixtureId}`;
    return r!.config_snapshot;
  }

  async function auditCount(fixtureId: string): Promise<number> {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from staff_audit_log where target_id = ${fixtureId}`;
    return n;
  }

  it("a re-snapshot that un-decides a line empties the seat it fed and restores the drawn label", async () => {
    const rig = await tennis();
    const line = rig.r1[0]!;
    const drawn = seatLabel(rig.final, line.winner_to_slot);
    await twoSets(rig.auth, line.id);
    expect(seat(await row(rig.final.id), line.winner_to_slot), "precondition: advanced").toBe(line.home_entrant_id);

    await bestOfFive(rig.divisionId);
    await resnapshotFixtureConfig(await superadmin(), line.id, "the cup is best of five");

    expect((await row(line.id)).outcome, "the corrected config un-decided the line").toBeNull();
    const final = await row(rig.final.id);
    expect(seat(final, line.winner_to_slot), "the old winner is taken back").toBeNull();
    expect(seatLabel(final, line.winner_to_slot)).toEqual(drawn);
  });

  it("a re-snapshot that KEEPS the decision leaves the next match alone, even one under way", async () => {
    const rig = await tennis();
    const [line, other] = rig.r1 as [Row, Row];
    await twoSets(rig.auth, line.id);
    await twoSets(rig.auth, other.id);
    await append(rig.auth, rig.final.id, "core.start", {});

    // A correction that changes the table, not who won.
    await sql`update divisions set config = ${sql.json({ ...TENNIS_BEST_OF_3, points: { win: 3, loss: 0 } } as never)} where id = ${rig.divisionId}`;
    await resnapshotFixtureConfig(await superadmin(), line.id, "a win is worth three");

    expect((await row(line.id)).outcome, "still decided").not.toBeNull();
    expect(seat(await row(rig.final.id), line.winner_to_slot), "the winner stays").toBe(line.home_entrant_id);
  });

  it("refuses the re-snapshot when the next match has started, and rewrites NOTHING — not the config, not the audit trail", async () => {
    const rig = await tennis();
    const [line, other] = rig.r1 as [Row, Row];
    await twoSets(rig.auth, line.id);
    await twoSets(rig.auth, other.id);
    await append(rig.auth, rig.final.id, "core.start", {});
    const snapshotBefore = await snapshotOf(line.id);
    const lineBefore = await row(line.id);

    await bestOfFive(rig.divisionId);
    const err = await refusal(resnapshotFixtureConfig(await superadmin(), line.id, "the cup is best of five"));

    expect(err.status).toBe(409);
    expect(err.code).toBe("NEXT_MATCH_STARTED");
    expect(await snapshotOf(line.id), "the discarded config was not discarded").toEqual(snapshotBefore);
    expect(await auditCount(line.id), "no audit row claims a re-snapshot that never happened").toBe(0);
    const lineAfter = await row(line.id);
    expect(lineAfter.outcome, "the result stands").toEqual(lineBefore.outcome);
    expect(lineAfter.status).toBe(lineBefore.status);
    expect(seat(await row(rig.final.id), line.winner_to_slot), "the winner stays seated").toBe(line.home_entrant_id);
  });
});

// ---------------------------------------------------------------------------
// FIX ROUND 1 — controller rulings on the first round's concerns (2026-09-23).
//
//  - A walkover the CASCADE awarded (status 'forfeited', `{kind: "award"}`, no
//    live score event) has not started: it is reset, and the reset reaches on
//    through whatever that walkover itself advanced. An award with a recorded
//    event behind it still refuses (the withdrawal case, above).
//  - A void that FLIPS the winner without the fold ever passing through
//    undecided owes the same un-fill: the stored decision's winner (and loser)
//    differ from the new fold's, so the old one is taken back and the ordinary
//    fill seats the new one.
// ---------------------------------------------------------------------------

/** A knockout drawn from a published `config.qualified` list, with the pairing
 *  of `seeds` withdrawn BEFORE the draw — so the generator voids that line
 *  (nobody left on either side). That is the product's own road to a dead
 *  feeder, the one `dead-feeder-cascade.test.ts` drives; the pairing is
 *  checked against the engine's own draw rather than assumed. */
async function qualifiedDrawWithVoidLine(field: number, seeds: [number, number]) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Cascade Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: field }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, [{ seq: 1, kind: "knockout", name: "Finals", config: {} }]);
  const qualified = entrants.map((e) => e.id);
  await sql`update stages set config = ${sql.json({ qualified } as never)} where id = ${stage!.id}`;
  await sql`update divisions set status = 'active' where id = ${division.id}`;
  const [a, b] = [qualified[seeds[0] - 1]!, qualified[seeds[1] - 1]!];
  const drawn = generateSingleElim({ entrants: qualified, seeds: new Map(qualified.map((id, i) => [id, i + 1])) });
  expect(
    drawn.fixtures.some((f) => (f.home === a && f.away === b) || (f.home === b && f.away === a)),
    "premise: the two seeds are drawn against each other",
  ).toBe(true);
  await withdrawEntrantCascade(auth, a);
  await withdrawEntrantCascade(auth, b);
  await generateStageFixtures(auth, stage!.id);

  const ids = await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  const rows = await Promise.all(ids.map((r) => row(r.id)));
  const dead = rows.filter((r) => r.status === "abandoned" && r.outcome === null);
  expect(dead, "exactly one line has nobody left on either side").toHaveLength(1);
  const semi = rows.find((r) => r.id === dead[0]!.winner_to_fixture)!;
  const sibling = rows.find((r) => r.winner_to_fixture === semi.id && r.id !== dead[0]!.id)!;
  const final = rows.find((r) => r.id === semi.winner_to_fixture)!;
  expect(final, "the walkover line feeds a later round").toBeTruthy();
  return { auth, stageId: stage!.id, rows, dead: dead[0]!, semi, sibling, final };
}

describe.skipIf(!HAS_DB)("fix round 1: a walkover the CASCADE awarded has not started — it is reset, all the way through", () => {
  it("a void reaches THROUGH the cascade walkover: the semi it awarded is reset, AND the final seat that walkover filled is taken back", async () => {
    const d = await qualifiedDrawWithVoidLine(8, [4, 5]);
    const semiSeatLabel = seatLabel(d.semi, d.sibling.winner_to_slot);
    const finalSeatLabel = seatLabel(d.final, d.semi.winner_to_slot);
    const decider = await decide(d.auth, d.sibling.id);
    const winner = d.sibling.home_entrant_id!;
    const semi = await row(d.semi.id);
    expect(semi.status, "premise: the cascade walked the semi over").toBe("forfeited");
    expect(semi.outcome).toEqual({ kind: "award", winner });
    expect(await eventCount(d.semi.id), "premise: nobody recorded anything on it").toBe(0);
    expect(seat(await row(d.final.id), d.semi.winner_to_slot), "premise: the walkover advanced its winner").toBe(winner);

    const out = await voidEvent(d.auth, d.sibling.id, decider);
    expect(out.outcome).toBeNull();

    const semiAfter = await row(d.semi.id);
    expect(semiAfter.status, "the walkover is undone").toBe("scheduled");
    expect(semiAfter.outcome).toBeNull();
    expect(seat(semiAfter, d.sibling.winner_to_slot), "the voided line's winner is taken back").toBeNull();
    expect(seatLabel(semiAfter, d.sibling.winner_to_slot), "with the label the draw wrote").toEqual(semiSeatLabel);
    expect(seatLabel(semiAfter, d.dead.winner_to_slot)?.key, "the dead side keeps its bye").toBe("bracket.slot.bye");
    const finalAfter = await row(d.final.id);
    expect(seat(finalAfter, d.semi.winner_to_slot), "…and so is the name the WALKOVER advanced").toBeNull();
    expect(seatLabel(finalAfter, d.semi.winner_to_slot)).toEqual(finalSeatLabel);
    expect(await sql.begin((tx) => resolveBracketSeats(tx, d.stageId)), "the cascade has nothing to do yet").toEqual([]);

    // Re-decided the other way: the cascade awards the semi to the NEW winner
    // and the final seats them.
    await decide(d.auth, d.sibling.id, true);
    const semiRedone = await row(d.semi.id);
    expect(semiRedone.status).toBe("forfeited");
    expect(semiRedone.outcome).toEqual({ kind: "award", winner: d.sibling.away_entrant_id });
    expect(seat(await row(d.final.id), d.semi.winner_to_slot)).toBe(d.sibling.away_entrant_id);
    expect(await sql.begin((tx) => resolveBracketSeats(tx, d.stageId)), "idempotent after the re-award").toEqual([]);
  });

  it("REFUSES through the walkover when the match BEYOND it has started — naming THAT match — and writes nothing", async () => {
    const d = await qualifiedDrawWithVoidLine(8, [4, 5]);
    const decider = await decide(d.auth, d.sibling.id);
    // The other half plays out, so the final has both finalists; then it starts.
    for (const r of d.rows.filter((r) => r.round_no === 1 && r.winner_to_fixture !== d.semi.id)) {
      await decide(d.auth, r.id);
    }
    const otherSemi = d.rows.find((r) => r.round_no === d.semi.round_no && r.id !== d.semi.id)!;
    await decide(d.auth, otherSemi.id);
    await append(d.auth, d.final.id, "core.start", {});
    const semiBefore = await row(d.semi.id);
    const finalBefore = await row(d.final.id);
    const eventsBefore = await eventCount(d.sibling.id);

    const err = await refusal(voidEvent(d.auth, d.sibling.id, decider));
    expect(err.code).toBe("NEXT_MATCH_STARTED");
    // It names the match that is actually under way — the board's way.
    await expectNamesTheBoardsWay(d.auth, err, d.final.id);
    expect(await eventCount(d.sibling.id), "no void was written").toBe(eventsBefore);
    expect(await row(d.semi.id), "the walkover stands, untouched").toEqual(semiBefore);
    expect(await row(d.final.id), "the final keeps both players").toEqual(finalBefore);
  });
});

// ---- the flip -------------------------------------------------------------

/** Six balls an innings, three a side: small enough to script by hand. The
 *  SAME partial feeds the division row and `scriptLedger`, so the config the
 *  write path freezes is the one the script was built under. */
const CRICKET_PARTIAL = { ballsPerInnings: 6, ballsPerOver: 6, playersPerSide: 3, minOversForResult: 1 };

const member = (personId: string) => ({
  person_id: personId,
  squad_number: null,
  default_position_key: null,
  is_captain: false,
  roles: [] as string[],
});

/** A four-team cricket knockout: a sport whose fold CAN change its winner
 *  without passing through undecided. Voiding one delivery of a chase
 *  re-scores every ball after it, and the innings still ends where it ended. */
async function cricketKnockout() {
  const { auth } = await seedOrg("pro");
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('cricket', 'Cricket', ${cricket.version}, ${sql.json(cricket.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('cricket', 't20', 'T20', ${sql.json(cricket.variants.t20 as never)}, true)
    on conflict do nothing`;
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Flip Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "T20",
    slug: "t20-" + randomUUID().slice(0, 6),
    sport_key: "cricket",
    variant_key: "t20",
    config: {},
  } as never);
  await sql`update divisions set config = ${sql.json(cricket.configSchema.parse(CRICKET_PARTIAL) as never)}
            where id = ${division.id}`;
  const names = ["Blazers", "Rovers", "Comets", "Dingoes"];
  const squads: string[][] = [];
  for (const name of names) {
    const xi: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name) values (${auth.orgId}, ${`${name} ${i}`}) returning id`;
      xi.push(id);
    }
    squads.push(xi);
  }
  const entrants = await createEntrants(
    auth,
    division.id,
    names.map((display_name, i) => ({ kind: "team", display_name, seed: i + 1, members: squads[i]!.map(member) })) as never,
  );
  const xiOf = new Map(entrants.map((e, i) => [e.id, squads[i]!]));
  const [stage] = await createStages(auth, division.id, [{ seq: 1, kind: "knockout", name: "Cup", config: {} }]);
  await generateStageFixtures(auth, stage!.id);
  await sql`update divisions set status = 'active' where id = ${division.id}`;
  const ids = await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  const rows = await Promise.all(ids.map((r) => row(r.id)));
  const r1 = rows.filter((r) => r.round_no === 1);
  const final = rows.find((r) => r.id === r1[0]!.winner_to_fixture)!;
  return { auth, r1, final, xiOf };
}

/** Home makes 6 off its six balls. Away chases 7: a no-ball hit for four (5,
 *  and not a legal ball), five dots, then 2 off the LAST ball — target reached
 *  on the final delivery, away wins. Void the no-ball and the same six legal
 *  balls make 2: the innings ends on the same delivery, home wins by 4. The
 *  fold never passes through undecided on the way.
 *
 *  Everything but the deciding ball goes in through the one append path
 *  directly (no rate limit to trip); the deciding ball goes through
 *  `scoreEvent`, so the ordinary fill seats the chaser in the final. Returns
 *  the no-ball's event id — the thing an organiser would void. */
async function chaseWonOnANoBall(
  auth: AuthCtx,
  line: Row,
  xiOf: Map<string, string[]>,
): Promise<string> {
  const home = xiOf.get(line.home_entrant_id!)!;
  const away = xiOf.get(line.away_entrant_id!)!;
  for (const [entrantId, xi] of [
    [line.home_entrant_id!, home],
    [line.away_entrant_id!, away],
  ] as const) {
    for (const [i, personId] of xi.entries()) {
      await sql`
        insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles, role)
        values (${line.id}, ${entrantId}, ${personId}, 'starting', null, ${i + 1}, ${sql.json([])}, 'player')`;
    }
  }
  const dots: Delivery[] = [{ bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }];
  const ledger = scriptLedger({
    cfg: CRICKET_PARTIAL,
    home,
    away,
    tossWonBy: "home",
    elected: "bat",
    innings: [
      { batting: "home", bowlers: [away[0]!], deliveries: [1, 1, 1, 1, 1, 1].map((bat) => ({ bat }) as Delivery) },
      { batting: "away", bowlers: [home[0]!], deliveries: [{ extra: "noball", runs: 1, bat: 4 }, ...dots, { bat: 2 }] },
    ],
  });
  expect(
    (ledger.state as { outcome: { winner?: string } | null }).outcome?.winner,
    "premise: the script's own fold has the chasers winning",
  ).toBe("away");
  const entrantOf = { home: line.home_entrant_id!, away: line.away_entrant_id! } as const;
  const events = ledger.events.map((ev) =>
    ev.type === "cricket.toss"
      ? { type: ev.type, payload: { ...(ev.payload as object), wonBy: entrantOf[(ev.payload as { wonBy: "home" | "away" }).wonBy] } }
      : { type: ev.type, payload: ev.payload },
  );
  let noBall: string | null = null;
  for (const [i, ev] of events.slice(0, -1).entries()) {
    const out = await appendEvent(auth.orgId, line.id, i, { type: ev.type, payload: ev.payload, recordedBy: null });
    if ((ev.payload as { runs?: { extras?: { kind?: string } } }).runs?.extras?.kind === "noball") noBall = out.event.id;
  }
  const last = events.at(-1)!;
  const decided = await scoreEvent(auth, line.id, { expected_seq: events.length - 1, type: last.type, payload: last.payload });
  expect(decided.outcome, "premise: the chase was won on the last ball").toMatchObject({ winner: line.away_entrant_id });
  expect(noBall, "premise: the script recorded a no-ball").not.toBeNull();
  return noBall!;
}

describe.skipIf(!HAS_DB)("fix round 1: a void that FLIPS the winner without passing through undecided", () => {
  // The gate's first clause: with no STORED decision there is nothing to take
  // back, so recording a first result can never be refused by the un-fill.
  // The scene needs a seat that already holds this line's player and a final
  // that is not waiting — both only reachable by raw SQL — because that is
  // exactly the state in which reaching for the next match WOULD refuse.
  it("a FIRST result takes nothing back: it never reaches the next match, even one holding this line's player that is not waiting", async () => {
    const rig = await knockout();
    const line = rig.r1[0]!;
    const column = line.winner_to_slot === 1 ? sql`home_entrant_id` : sql`away_entrant_id`;
    await sql`update fixtures set ${column} = ${line.home_entrant_id}, status = 'cancelled' where id = ${rig.final.id}`;

    await decide(rig.auth, line.id);

    const final = await row(rig.final.id);
    expect(seat(final, line.winner_to_slot), "the seat is untouched").toBe(line.home_entrant_id);
    expect(final.status).toBe("cancelled");
  });

  it("takes the old winner back and the ordinary fill seats the NEW one — the final never keeps a name the result no longer gives it", async () => {
    const rig = await cricketKnockout();
    const line = rig.r1[0]!;
    const noBall = await chaseWonOnANoBall(rig.auth, line, rig.xiOf);
    expect(seat(await row(rig.final.id), line.winner_to_slot), "precondition: the chasers were advanced").toBe(
      line.away_entrant_id,
    );

    const out = await voidEvent(rig.auth, line.id, noBall);

    expect(out.outcome, "the fold never passed through undecided").toMatchObject({
      kind: "win",
      winner: line.home_entrant_id,
    });
    const final = await row(rig.final.id);
    expect(seat(final, line.winner_to_slot), "the NEW winner holds the seat").toBe(line.home_entrant_id);
    expect(seatLabel(final, line.winner_to_slot), "a filled seat carries no label").toBeNull();
  });

  it("refuses the flip when the next match is no longer waiting — and writes nothing", async () => {
    const rig = await cricketKnockout();
    const line = rig.r1[0]!;
    const noBall = await chaseWonOnANoBall(rig.auth, line, rig.xiOf);
    // The only way to stop a final that has one seat filled from waiting is a
    // status only raw SQL writes (see the 'cancelled' test above).
    await sql`update fixtures set status = 'cancelled' where id = ${rig.final.id}`;
    const lineBefore = await row(line.id);
    const eventsBefore = await eventCount(line.id);

    const err = await refusal(voidEvent(rig.auth, line.id, noBall));

    expect(err.code).toBe("NEXT_MATCH_STARTED");
    expect(await eventCount(line.id), "no void was written").toBe(eventsBefore);
    expect((await row(line.id)).outcome, "the result stands").toEqual(lineBefore.outcome);
    expect(seat(await row(rig.final.id), line.winner_to_slot), "the seat is kept").toBe(line.away_entrant_id);
  });
});

// ---------------------------------------------------------------------------
// Fix round 2 (review 2026-09-23): the locks.
//
// Every append holds its own fixture's lock (append-event.ts) for the length
// of its transaction, and the un-fill takes each next match's lock on top. Two
// voids that each hold one and want the other's deadlock, and Postgres kills
// one of them with 40P01 — a 500 to an organiser who did nothing wrong. The
// rest of this block pins the other two lock rules the review found: a
// cross-stage target is never locked at all, and the POST-commit fill reads
// the result that stands when it runs, not the one it was handed.
// ---------------------------------------------------------------------------

/** Wait until a backend is queued behind `holderPid` on an advisory lock — or
 *  until `settled()` says the call under test finished without queueing.
 *  Returns whether it queued. */
async function queuedBehind(holderPid: number, settled: () => boolean): Promise<boolean> {
  for (let i = 0; i < 500; i++) {
    if (settled()) return false;
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted and ${holderPid} = any(pg_blocking_pids(pid))`;
    if (n > 0) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("neither queued nor settled in 5s");
}

/** A side transaction holding `fixture:<id>` — the lock an append to that
 *  fixture holds — until `release()`; `then` runs inside it before commit. */
function holdFixtureLock<T>(id: string, then: (tx: Tx) => Promise<T>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const state = { pid: 0 };
  const done = sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + id}))`;
    const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    state.pid = pid;
    await gate;
    return then(tx as unknown as Tx);
  }) as Promise<T>;
  const ready = (async () => {
    for (let i = 0; state.pid === 0 && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
    expect(state.pid, "the stand-in holds the lock").not.toBe(0);
    return state.pid;
  })();
  return { ready, release: () => release(), done };
}

/** A page playoff (the IPL shape), generated for real: pp-q1 sends its winner
 *  to the final and its LOSER to pp-q2, and pp-q2 sends its winner to the
 *  final too. Rows are found by the generator's own ids (`ext_key`). */
async function pagePlayoff() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Page Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
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
    ["A", "B", "C", "D"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, [{ seq: 1, kind: "page_playoff", name: "Playoffs", config: {} }]);
  await generateStageFixtures(auth, stage!.id);
  await sql`update divisions set status = 'active' where id = ${division.id}`;
  const byKey = async (key: string) => {
    const [r] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stage!.id} and ext_key = ${key}`;
    expect(r, `the generator wrote ${key}`).toBeDefined();
    return row(r!.id);
  };
  const [q1, elim, q2, final] = await Promise.all(["pp-q1", "pp-elim", "pp-q2", "pp-final"].map(byKey));
  expect(q1!.winner_to_fixture, "premise: pp-q1's winner goes to the final").toBe(final!.id);
  expect(q1!.loser_to_fixture, "premise: pp-q1's LOSER goes to pp-q2").toBe(q2!.id);
  expect(q2!.winner_to_fixture, "premise: pp-q2's winner goes to the final too").toBe(final!.id);
  expect(q2!.round_no, "premise: pp-q2 plays before the final").toBeLessThan(final!.round_no);
  return { auth, q1: q1!, elim: elim!, q2: q2!, final: final! };
}

describe.skipIf(!HAS_DB)("fix round 2: the un-fill's locks", () => {
  // M1. pp-q1's void wants the final (its winner edge) AND pp-q2 (its loser
  // edge); pp-q2's void holds pp-q2 and wants the final. Locking pp-q1's
  // targets winner-edge first takes the final and then queues on pp-q2 while
  // pp-q2's void queues on the final: a cycle. In bracket order (round, then
  // id) pp-q1's void asks for pp-q2 FIRST, so it queues holding nothing
  // pp-q2's void needs. The stand-in plays pp-q2's void exactly: it holds
  // pp-q2's append lock from the start, then runs the un-fill.
  it("two voids that each need the other's lock both finish — pp-q1's void takes pp-q2 before the final, so a page playoff cannot deadlock", async () => {
    const pp = await pagePlayoff();
    const q1Decider = await decide(pp.auth, pp.q1.id);
    await decide(pp.auth, pp.elim.id);
    await decide(pp.auth, pp.q2.id);
    const q2 = await row(pp.q2.id);
    const before = await row(pp.final.id);
    expect(before.home_entrant_id && before.away_entrant_id, "premise: both finalists are seated").toBeTruthy();

    const q2Void = holdFixtureLock(pp.q2.id, (tx) => releaseFedSeats(tx, pp.q2.id, q2.outcome, null));
    const q2VoidPid = await q2Void.ready;
    let settled = false;
    const q1Void = voidEvent(pp.auth, pp.q1.id, q1Decider).then(
      () => { settled = true; return null; },
      (e: unknown) => { settled = true; return e; },
    );
    expect(await queuedBehind(q2VoidPid, () => settled), "pp-q1's void waits for pp-q2's").toBe(true);
    q2Void.release();
    const [released, q1Err] = await Promise.all([
      q2Void.done.then((ids) => ids, (e: unknown) => e),
      q1Void,
    ]);

    expect(released, "pp-q2's void went through — it was not the deadlock victim").toEqual([pp.final.id]);
    expect(q1Err, "pp-q1's void was refused, not killed").toBeInstanceOf(HttpError);
    expect((q1Err as HttpError).code, "…because pp-q2 has been played").toBe("NEXT_MATCH_STARTED");
    // …and it names pp-q2 the board's way. The board codes only knockout and
    // double-elimination rounds, so a page playoff's match keeps "R2·1" there,
    // and here.
    const ref = await expectNamesTheBoardsWay(pp.auth, q1Err as HttpError, pp.q2.id);
    expect(ref.code, "a round the board does not code carries no code").toBeUndefined();
    const after = await row(pp.final.id);
    expect(after.home_entrant_id, "pp-q1's winner keeps the final seat (its void rolled back)").toBe(before.home_entrant_id);
    expect(after.away_entrant_id, "pp-q2's winner was taken back").toBeNull();
  });

  // M3. A cross-stage target is never un-filled, so its lock buys nothing —
  // and taking it before reading its stage made a void wait on (or deadlock
  // with) a match in another stage that it will not touch.
  it("never takes a CROSS-STAGE target's lock: the stage is read first, so the void does not queue on a match it will not touch", async () => {
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    const [elsewhere] = await createStages(rig.auth, rig.divisionId, [
      { seq: 2, kind: "knockout", name: "Elsewhere", config: {} },
    ]);
    await sql`update fixtures set stage_id = ${elsewhere!.id} where id = ${rig.final.id}`;
    const decider = await decide(rig.auth, line.id);
    await decide(rig.auth, other.id);

    const holder = holdFixtureLock(rig.final.id, async () => null);
    const holderPid = await holder.ready;
    let settled = false;
    const voiding = voidEvent(rig.auth, line.id, decider).then(
      () => { settled = true; return null; },
      (e: unknown) => { settled = true; return e; },
    );
    const queued = await queuedBehind(holderPid, () => settled);
    holder.release();
    await holder.done;

    expect(queued, "the void never waited on the other stage's match").toBe(false);
    expect(await voiding, "and it went through").toBeNull();
    expect(seat(await row(rig.final.id), line.winner_to_slot), "the cross-stage seat is untouched").toBe(
      line.home_entrant_id,
    );
  });

  // M2. `onDecided` runs AFTER the append commits. A void can commit in that
  // gap: its un-fill finds the seat still empty (the fill has not run), and
  // then the late fill seats the winner the void just took away — the very
  // name this whole fix exists to take back. The stand-in below is that void:
  // it holds the line's append lock and, at commit, writes what a void that
  // erases the decision writes. The late fill must wait for it and read the
  // outcome that stands.
  it("the post-commit fill waits on the line's own lock and fills from the outcome that STANDS: a void committing in the gap leaves the seat empty", async () => {
    const rig = await knockout();
    const line = rig.r1[0]!;
    await decide(rig.auth, line.id);
    // The scene inside the gap: the decision has committed, its fill has not.
    const column = line.winner_to_slot === 1 ? sql`home_entrant_id` : sql`away_entrant_id`;
    await sql`update fixtures set ${column} = null where id = ${rig.final.id}`;

    const theVoid = holdFixtureLock(line.id, async (tx) => {
      await tx`update fixtures set outcome = null, status = 'in_play' where id = ${line.id}`;
    });
    const voidPid = await theVoid.ready;
    let settled = false;
    const lateFill = onDecided(rig.auth, line.id).then(
      (ids) => { settled = true; return ids; },
      (e: unknown) => { settled = true; throw e; },
    );
    const queued = await queuedBehind(voidPid, () => settled);
    theVoid.release();
    await theVoid.done;
    const filled = await lateFill;

    expect(queued, "the late fill queued behind the void").toBe(true);
    expect(filled, "it seated nobody").not.toContain(rig.final.id);
    expect(seat(await row(rig.final.id), line.winner_to_slot), "the voided winner is NOT put back").toBeNull();
  });

  it("and a late fill for a result that still stands seats its winner as before", async () => {
    const rig = await knockout();
    const line = rig.r1[0]!;
    await decide(rig.auth, line.id);
    const column = line.winner_to_slot === 1 ? sql`home_entrant_id` : sql`away_entrant_id`;
    await sql`update fixtures set ${column} = null where id = ${rig.final.id}`;

    const filled = await onDecided(rig.auth, line.id);

    expect(filled).toContain(rig.final.id);
    expect(seat(await row(rig.final.id), line.winner_to_slot)).toBe(line.home_entrant_id);
  });
});
