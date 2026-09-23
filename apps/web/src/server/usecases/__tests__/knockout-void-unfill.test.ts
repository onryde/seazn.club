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
//     latest match first. No chain logic.
//  3. Re-deciding needs no new code — the ordinary fill seats the new winner.
//  4. Cross-stage feeds are out of scope and must behave exactly as before.
//
// Every scene is driven through the real `scoreEvent` — the door the console,
// the pad and the device link all share — never through `fillSlot` directly.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { getFixtureState } from "../fixtures";
import { scoreEvent } from "../scoring";
import { appendEvent } from "@/server/engine-db";
import { fixtureAwaitsSeedDraw } from "@/lib/division-phase";
import {
  completeStage,
  computeSeedProposal,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
} from "../stages";
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
    expect(err.extra).toEqual({
      next_match: { fixture_id: rig.final.id, round: rig.final.round_no, seq: rig.final.seq_in_round },
    });
    expect(err.message, "the server's own sentence names the next match").toContain(
      `R${rig.final.round_no}·${rig.final.seq_in_round}`,
    );

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
  // no score event behind it. The ruling reads that as started (it carries an
  // outcome), so the void is refused; see the report's concern about what the
  // organiser can do next.
  it("refuses when the next match was settled as a WALKOVER for this line's winner — an outcome with no events", async () => {
    const rig = await knockout();
    const [line, other] = rig.r1 as [Row, Row];
    // The dead sibling feeder, written the way `dead-feeder-cascade.test.ts`
    // writes it: raw SQL is the only road to a 'cancelled' line.
    await sql`update fixtures set status = 'cancelled', outcome = null,
                home_entrant_id = null, away_entrant_id = null
              where id = ${other.id}`;
    const decider = await decide(rig.auth, line.id);
    const final = await row(rig.final.id);
    expect(final.status, "premise: the final was walked over to this line's winner").toBe("forfeited");
    expect(final.outcome?.winner).toBe(line.home_entrant_id);
    expect(await eventCount(rig.final.id), "…with no score event behind it").toBe(0);

    const err = await refusal(voidEvent(rig.auth, line.id, decider));
    expect(err.code).toBe("NEXT_MATCH_STARTED");
    const after = await row(rig.final.id);
    expect(seat(after, line.winner_to_slot), "the winner stays seated").toBe(line.home_entrant_id);
    expect(after.outcome, "and the walkover stands").toEqual(final.outcome);
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
