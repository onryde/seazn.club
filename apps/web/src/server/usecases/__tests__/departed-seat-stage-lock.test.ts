// W2b Loop R2 N-2 — a withdrawal's no-event seat write (`writeDepartedSeat`, X-WD-3 / X-WD-4) runs the cascade
// (`resolveBracketSeats`) over the stage, and the cascade judges each seat by its FEEDER's stored decision. It held only
// its own fixture's lock. So a departure double walkover on SF1, racing SF2's decision (`onDecided`: seat its winner in
// the final, then run the cascade), could commit with each side having read the other's line before the other
// committed: SF2's cascade saw SF1 still undecided, SF1's saw the final still empty — the final left holding SF2's
// winner beside a dead feeder, no walkover, and no later write that ever looks at it again. A stuck final.
//
// Now the departure takes the stage lock (`lockStageSeats`) before its fixture lock — the one order Loop R2 N-1 set
// (stage, then fixtures) — so it and a decision's cascade never read each other's line in flight. Through the
// product's own writers (`withdrawEntrantCascade` or `writeDepartedSeat`, `onDecided`, `scoreEvent`), parked by a third
// connection.
// single-sport: badminton; the seat rules read the feed graph and entrant statuses, never the sport.
import { afterAll, describe, expect, it } from "vitest";
import { sql, withTenant } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { lockStageSeats } from "@/server/engine-db/fed-seats";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, labelOf, playBadminton, post, rowsOf, seatOf, tip } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { onDecided } from "../scoring";
import { writeDepartedSeat } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;
const BYE_KEY = "bracket.slot.bye";

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

const why = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? String(r.reason) : "ok");

/** Eight entrants: QF1 a recorded double walkover, QF2 played, so SF1 is the cascade's walkover to QF2's winner E, who
 *  sits in the final with nobody yet beside her — and E has withdrawn (a bare status write; the departure's seat write
 *  is the caller's). */
async function eightWithEInTheFinal() {
  const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 8 });
  const rows = await rowsOf(s.stageId);
  const firstRound = Math.min(...rows.map((r) => r.round_no));
  const [qf1, qf2] = rows.filter((r) => r.round_no === firstRound && r.winner_to_fixture === rows.find((x) => x.round_no === firstRound)!.winner_to_fixture);
  expect([qf1, qf2].every((r) => r !== undefined), "rig: two quarter-finals feed SF1").toBe(true);
  const dw = await post(s.auth, qf1!.id, "core.forfeit", { by: "both", reason: "walkover" });
  const qf2Done = await playBadminton(s.auth, qf2!.id, true);
  const e = qf2Done.outcome!.winner!;
  const sf1 = await fixtureRow(qf1!.winner_to_fixture!);
  expect([sf1.status, sf1.outcome?.kind, sf1.outcome?.winner], "rig: SF1 is the cascade's walkover to E").toEqual(["forfeited", "award", e]);
  const finalId = sf1.winner_to_fixture!;
  const before = await fixtureRow(finalId);
  expect([seatOf(before, sf1.winner_to_slot), before.status], "rig: E waits in the final, opponent unknown").toEqual([e, "scheduled"]);
  await sql`update entrants set status = 'withdrawn' where id = ${e}`;
  return { s, qf1: qf1!, sf1, e, finalId, dwEventId: dw.event_id };
}

describe.skipIf(!HAS_DB)("Loop R2 N-2: a departure's seat write and a decision's cascade never read each other's line in flight", () => {
  it("X-WD-4: SF1's second player withdraws while SF2's decision is mid-cascade — the final is walked over to SF2's winner, never left stuck beside a dead semi", async () => {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const [sf1, sf2] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    expect(sf1!.winner_to_fixture, "rig: both semis feed one final").toBe(sf2!.winner_to_fixture);
    // SF2 played out below the console: decided, its cascade (`onDecided`) not yet run.
    await appendEvent(s.auth.orgId, sf2!.id, await tip(sf2!.id), { type: "core.start", payload: {} });
    for (let g = 0; g < 2; g++) {
      await appendEvent(s.auth.orgId, sf2!.id, await tip(sf2!.id), { type: "badminton.game.summary", payload: { home: 21, away: 10 } });
    }
    const decided = await fixtureRow(sf2!.id);
    expect(decided.status, "rig: SF2 is decided").toBe("decided");
    // SF2 is a placement game, so its decision writes the stage's rank overrides AFTER its cascade has read the
    // feeders (`onDecided`) — the row the holder below parks it on, between that read and its commit.
    await sql`update stages set config = config || ${sql.json({ placements: { [decided.ext_key!]: [1, 2] } } as never)} where id = ${s.stageId}`;
    // SF1's home player left by a bare status write (no cascade), so the draw still seats her (X-WD-4).
    await sql`update entrants set status = 'withdrawn' where id = ${sf1!.home_entrant_id}`;

    let deciding!: Promise<unknown>;
    let withdrawing!: Promise<unknown>;
    let withdrew = false;
    let departureQueued = false;
    await sql.begin(async (holder) => {
      await holder`select id from stages where id = ${s.stageId} for update`;
      const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      deciding = onDecided(s.auth, sf2!.id);
      deciding.catch(() => {});
      let decisionPid = 0;
      await until("SF2's decision parks behind the held stage row, after its cascade", async () => {
        const w = await waitersOn(held!.pid);
        decisionPid = w[0] ?? 0;
        return w.length === 1;
      });
      withdrawing = withdrawEntrantCascade(s.auth, sf1!.away_entrant_id!);
      withdrawing.then(() => (withdrew = true), () => (withdrew = true));
      await until("the departure either runs through or queues behind the decision", async () => {
        departureQueued = (await waitersOn(decisionPid)).length > 0;
        return withdrew || departureQueued;
      });
    }); // commits: the decision goes on (SF2's winner seated), then the departure
    const [d, w] = await Promise.allSettled([deciding, withdrawing]);
    expect([d.status, w.status], `both writers succeed (decision ${why(d)}; withdrawal ${why(w)})`).toEqual(["fulfilled", "fulfilled"]);
    const semi = await fixtureRow(sf1!.id);
    const final = await fixtureRow(sf1!.winner_to_fixture!);
    const seen = {
      sf1: [semi.status, semi.outcome],
      final: [final.status, final.outcome?.kind, final.outcome?.winner, seatOf(final, sf2!.winner_to_slot), labelOf(final, sf1!.winner_to_slot)],
    };
    expect(seen, `SF1 is a departure double walkover, so the final is SF2's winner's walkover: ${JSON.stringify(seen)}`).toEqual({
      sf1: ["forfeited", { kind: "double_walkover" }],
      final: ["forfeited", "award", decided.outcome!.winner, decided.outcome!.winner, BYE_KEY],
    });
    // The mechanism, after the behaviour: the departure did not read the final while the decision was in flight.
    expect(departureQueued, "the departure queued behind the decision").toBe(true);
  }, 90_000);

  it("X-WD-3 (tbd) against a double walkover's void: the departure holds the final, the void waits, then revives the semi and lifts the dead stamp — the final waits for the live semi", async () => {
    // Eight entrants: QF1 a recorded double walkover, QF2 played, so SF1 is the cascade's walkover to QF2's winner E,
    // who sits in the final with nobody yet beside her. E has withdrawn: her opponent is unknown, so her seat is stamped
    // dead (`writeDepartedSeat` "tbd", driven directly). The organiser voids QF1's double walkover at the same moment.
    //
    // Coverage, not the N-2 witness: the void's revive reaches the final, so it already queued behind the departure on
    // the final's fixture lock before N-2 — the departure double walkover case above is the one the stage lock decides.
    // E's departed status is written FIRST here, the state the stamp is written for. `withdrawEntrantCascade` writes it
    // LAST, after its seat writes — a void planned in that window reads E as still in the field and leaves her seat's
    // stamp beside the revived semi (Loop R2 fix report, finding N-2b: escalated, not fixed here).
    const { s, qf1, sf1, e, finalId, dwEventId } = await eightWithEInTheFinal();
    let withdrawing!: Promise<unknown>;
    let voiding!: Promise<unknown>;
    let voided = false;
    let voidQueued = false;
    await sql.begin(async (holder) => {
      // The departure writes the final's row after it has taken its locks.
      await holder`select id from fixtures where id = ${finalId} for update`;
      const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      withdrawing = withTenant(s.auth.orgId, (tx) => writeDepartedSeat(tx, finalId, e, "tbd"));
      withdrawing.catch(() => {});
      let departurePid = 0;
      await until("the departure parks behind the held final row", async () => {
        const w = await waitersOn(held!.pid);
        departurePid = w[0] ?? 0;
        return w.length === 1;
      });
      voiding = post(s.auth, qf1.id, "core.void", { event_id: dwEventId });
      voiding.then(() => (voided = true), () => (voided = true));
      await until("the void either runs through or queues behind the departure", async () => {
        voidQueued = (await waitersOn(departurePid)).length > 0;
        return voided || voidQueued;
      });
    }); // commits: the departure stamps E's seat dead, then the void revives SF1 and lifts that stamp
    const [w, v] = await Promise.allSettled([withdrawing, voiding]);
    expect([w.status, v.status], `both writers succeed (departure ${why(w)}; void ${why(v)})`).toEqual(["fulfilled", "fulfilled"]);
    const final = await fixtureRow(finalId);
    const semi = await fixtureRow(sf1.id);
    const seen = {
      qf1: [(await fixtureRow(qf1.id)).status],
      sf1: [semi.status, semi.outcome],
      final: [final.status, final.outcome, seatOf(final, sf1.winner_to_slot), labelOf(final, sf1.winner_to_slot)],
    };
    // Never a dead stamp in the final while the semi feeding it is live again.
    expect(seen, `the final waits for the revived semi: ${JSON.stringify(seen)}`).toEqual({
      qf1: ["scheduled"],
      sf1: ["scheduled", null],
      final: ["scheduled", null, null, "slot.winner_match"],
    });
    expect(voidQueued, "the void queued behind the departure").toBe(true);
  }, 90_000);
  it("the departure takes the stage lock BEFORE its fixture lock: a double walkover's void granted the stage first never waits on a departure that holds the final", async () => {
    // The void queues on the stage first, then the departure. Fixture-first, the departure held the final's fixture lock
    // while it waited for the stage — and the void, granted the stage, then asked for that final (its revive reaches
    // it): 40P01. Stage-first, the departure holds nothing while it waits; the void revives SF1 and takes E back out of
    // the final, and the departure then finds her seat gone — refused, as its guarded write promises, never a deadlock.
    const { s, qf1, sf1, e, finalId, dwEventId } = await eightWithEInTheFinal();
    const out: Promise<unknown>[] = [];
    const early: (PromiseSettledResult<unknown> | undefined)[] = [];
    await sql.begin(async (holder) => {
      await lockStageSeats(holder, s.stageId);
      const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const writers = [
        () => post(s.auth, qf1.id, "core.void", { event_id: dwEventId }),
        () => withTenant(s.auth.orgId, (tx) => writeDepartedSeat(tx, finalId, e, "tbd")),
      ];
      for (const [i, start] of writers.entries()) {
        const p = start();
        out.push(p);
        p.then(
          (value) => (early[i] ??= { status: "fulfilled", value }),
          (reason: unknown) => (early[i] ??= { status: "rejected", reason }),
        );
        await until(`writer ${i + 1} queues behind the stage lock`, async () => early[i] !== undefined || (await waitersOn(held!.pid)).length === i + 1);
      }
      expect(writers.map((_, k) => (early[k] === undefined ? "waits" : why(early[k]!))), "both writers wait on the held stage lock").toEqual(["waits", "waits"]);
    }); // commits: the void is granted the stage first
    const [v, d] = await Promise.allSettled(out);
    const deadlock = (r: PromiseSettledResult<unknown>) => r.status === "rejected" && (r.reason as { code?: string })?.code === "40P01";
    expect([deadlock(v!), deadlock(d!)], `no deadlock victim (void ${why(v!)}; departure ${why(d!)})`).toEqual([false, false]);
    expect(v!.status, `the void succeeds (${why(v!)})`).toBe("fulfilled");
    expect(d!.status === "rejected" && String(d!.reason), "the departure finds E's seat gone and says so").toMatch(
      new RegExp(`^Error: writeDepartedSeat: fixture ${finalId} is no longer the undecided line entrant ${e} was judged on \\(tbd\\)$`),
    );
    const final = await fixtureRow(finalId);
    expect(
      [(await fixtureRow(sf1.id)).status, final.status, seatOf(final, sf1.winner_to_slot), labelOf(final, sf1.winner_to_slot)],
      "SF1 is live again and the final waits for it",
    ).toEqual(["scheduled", "scheduled", null, "slot.winner_match"]);
  }, 90_000);
});
