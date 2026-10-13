// W2b Loop R I-2 (controller ruling 2026-10-13): the void of a double walkover and the decision of its sibling line are
// two writers of the same next match, and each reads the other's line. The void revives what the double walkover killed
// (`reviveDeadSeats`: it reads the final); the sibling's decision seats its winner and runs the cascade
// (`onDecided` → `fillSlot`, `resolveBracketSeats`: it reads the double walkover). Each took only its OWN fixture's lock,
// so with the void parked after its read and before its commit, the decision read the double walkover still standing and
// walked the final over to its winner, while the void had already planned nothing — both committed. The semi was live
// again, and the final a no-event walkover the organiser cannot void, its stage possibly complete with a champion.
//
// Now both take one stage-scoped advisory lock (`lockStageSeats`) before reading the other line, in one order: stage,
// own fixture, targets (Loop R2 N-1, stage-lock-order.test.ts). Two transactions through the product's own writers (`scoreEvent` for the void, `onDecided`
// for the decision), interleaved by a third connection holding a row the void writes after its read.
// single-sport: badminton; the seat rules read the feed graph, never the sport.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { onDecided } from "@/server/usecases/scoring";
import { seedBracket } from "./helpers/seed-bracket";
import { fixtureRow, labelOf, post, seatOf, tip, type FixtureRow } from "./helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** Backends waiting on a lock `pid` holds. */
async function waitersOn(pid: number): Promise<number[]> {
  const rows = await sql<{ pid: number }[]>`select pid from pg_locks where not granted and ${pid} = any(pg_blocking_pids(pid))`;
  return [...new Set(rows.map((r) => r.pid))];
}

async function until(what: string, done: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A knockout of four: SF1 a recorded double walkover, SF2 decided by play with its `onDecided` NOT yet run (the
 *  last game appended below the console, exactly the moment between a decision's commit and its cascade). */
async function scene() {
  const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
  const [a, b] = s.fixtureIds;
  const sf1 = await fixtureRow(a!);
  const dw = await post(s.auth, sf1.id, "core.forfeit", { by: "both", reason: "walkover" });
  expect([dw.status, dw.outcome], "rig: SF1 is a recorded double walkover").toEqual(["forfeited", { kind: "double_walkover" }]);
  const sf2Id = b!;
  await post(s.auth, sf2Id, "core.start");
  await post(s.auth, sf2Id, "badminton.game.summary", { home: 21, away: 10 });
  await appendEvent(s.auth.orgId, sf2Id, await tip(sf2Id), { type: "badminton.game.summary", payload: { home: 21, away: 10 } });
  const sf2 = await fixtureRow(sf2Id);
  expect(sf2.status, "rig: SF2 is decided").toBe("decided");
  expect(sf1.winner_to_fixture, "rig: both semis feed one final").toBe(sf2.winner_to_fixture);
  const final = await fixtureRow(sf1.winner_to_fixture!);
  expect(
    [final.status, final.outcome, seatOf(final, sf1.winner_to_slot), seatOf(final, sf2.winner_to_slot)],
    "rig: the final still waits — SF2's cascade has not run, and SF1's dead seat had nobody beside it",
  ).toEqual(["scheduled", null, null, null]);
  return { s, sf1, sf2, final, dwEventId: dw.event_id };
}

/** The ruled end state, whichever writer goes first: SF1 is live again, so the final WAITS for it — no walkover, SF2's
 *  winner seated, SF1's seat empty under its drawn label. */
async function expectFinalWaits(sf1: FixtureRow, sf2: FixtureRow, finalId: string) {
  const final = await fixtureRow(finalId);
  const semi = await fixtureRow(sf1.id);
  const seen = {
    sf1: [semi.status, semi.outcome],
    final: [final.status, final.outcome, seatOf(final, sf2.winner_to_slot), seatOf(final, sf1.winner_to_slot), labelOf(final, sf1.winner_to_slot)],
  };
  expect(seen, `the final waits for the live semi: ${JSON.stringify(seen)}`).toEqual({
    sf1: ["scheduled", null],
    final: ["scheduled", null, sf2.outcome!.winner, null, "slot.winner_match"],
  });
}

describe.skipIf(!HAS_DB)("Loop R I-2: the void of a double walkover and its sibling's decision never both commit on a stale read", () => {
  it("the void reads first and parks before its commit; the sibling's decision waits for it, then seats its winner beside a live semi — no walkover", async () => {
    const { s, sf1, sf2, final, dwEventId } = await scene();
    let voiding!: Promise<unknown>;
    let deciding!: Promise<unknown>;
    let decided = false;
    let decisionQueuedBehindVoid = false;
    await sql.begin(async (holder) => {
      // The void writes SF1's match_states row AFTER it has read the final (`releaseFedSeats` → `reviveDeadSeats`,
      // append-event.ts) — holding that row parks it between its read and its commit.
      await holder`select fixture_id from match_states where fixture_id = ${sf1.id} for update`;
      const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      voiding = post(s.auth, sf1.id, "core.void", { event_id: dwEventId });
      voiding.catch(() => {});
      let voidPid = 0;
      await until("the void parks behind the held row", async () => {
        const w = await waitersOn(held!.pid);
        voidPid = w[0] ?? 0;
        return w.length === 1;
      });
      deciding = onDecided(s.auth, sf2.id);
      deciding.then(() => (decided = true), () => (decided = true));
      await until("the decision either runs through or queues behind the void", async () => {
        decisionQueuedBehindVoid = (await waitersOn(voidPid)).length > 0;
        return decided || decisionQueuedBehindVoid;
      });
    }); // commits: the void goes on, then the decision
    const [v, d] = await Promise.allSettled([voiding, deciding]);
    expect([v.status, d.status], `both writers succeed (${JSON.stringify([v, d].map((x) => (x.status === "rejected" ? String(x.reason) : "ok")))})`).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    await expectFinalWaits(sf1, sf2, final.id);
    // The mechanism, after the behaviour: the decision did not read the double walkover while the void was in flight.
    expect(decisionQueuedBehindVoid, "the decision queued behind the void").toBe(true);
  }, 60_000);

  it("the other order: the decision holds the stage first and parks; the void waits for it, then revives the walkover it wrote", async () => {
    const { s, sf1, sf2, final, dwEventId } = await scene();
    let voiding!: Promise<unknown>;
    let deciding!: Promise<unknown>;
    let voided = false;
    let voidQueuedBehindDecision = false;
    let voidCommittedEarly = -1;
    await sql.begin(async (holder) => {
      // The decision writes the final's row (`fillSlot`) after it has taken the stage lock.
      await holder`select id from fixtures where id = ${final.id} for update`;
      const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      deciding = onDecided(s.auth, sf2.id);
      deciding.catch(() => {});
      let decisionPid = 0;
      await until("the decision parks behind the held row", async () => {
        const w = await waitersOn(held!.pid);
        decisionPid = w[0] ?? 0;
        return w.length === 1;
      });
      voiding = post(s.auth, sf1.id, "core.void", { event_id: dwEventId });
      voiding.then(() => (voided = true), () => (voided = true));
      await until("the void either runs through or queues behind the decision", async () => {
        voidQueuedBehindDecision = (await waitersOn(decisionPid)).length > 0;
        return voided || voidQueuedBehindDecision;
      });
      // The void's APPEND is where it revives: had it run through, its event is committed now — and only its own
      // cascade afterwards (`onDecided` on the voided semi) would be the one queued behind the decision.
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from score_events where fixture_id = ${sf1.id} and type = 'core.void'`;
      voidCommittedEarly = n;
    }); // commits: the decision goes on (seats SF2's winner, walks the final over the dead seat), then the void
    const [v, d] = await Promise.allSettled([voiding, deciding]);
    expect([v.status, d.status], `both writers succeed (${JSON.stringify([v, d].map((x) => (x.status === "rejected" ? String(x.reason) : "ok")))})`).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    await expectFinalWaits(sf1, sf2, final.id);
    // One lock order, both ways round: the void did not read the final while the decision was in flight.
    expect([voidQueuedBehindDecision, voidCommittedEarly], "the void queued behind the decision, its append uncommitted").toEqual([true, 0]);
  }, 60_000);
});
