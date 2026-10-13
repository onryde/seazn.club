// W2b Loop R2 N-1 — ONE lock order for the bracket writers that judge a seat by another line's stored decision: the
// stage lock (`lockStageSeats`) BEFORE any `fixture:` lock. Loop R I-2 (e8f3585c7) gave the void of a double walkover
// and a decision's cascade that stage lock, but took it AFTER the writer's own fixture lock — and the void then locked
// its targets after it. So the void of a double walkover held `stage` and asked for a semi's `fixture:` lock, while that
// semi's own decision (`onDecided`) held `fixture:` and asked for `stage`: 40P01. When Postgres chose the decision as the
// victim, `scoreEvent` threw AFTER the last point had committed (scoring.ts) and the semi's winner was never seated in
// the final — and nothing later seats her.
//
// Now: a void of a stored double walkover takes the stage lock before its own fixture lock (append-event.ts, read
// unlocked first); `onDecided` takes it before its fixture lock; the revive (`reviveDeadSeats`) refuses to run without it.
// Two transactions through the product's own writers, parked behind a third connection that holds the stage lock.
// single-sport: badminton; the lock order reads the feed graph, never the sport.
import { afterAll, describe, expect, it } from "vitest";
import { sql, withTenant } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { lockStageSeats, releaseFedSeats } from "@/server/engine-db/fed-seats";
import { onDecided } from "@/server/usecases/scoring";
import { seedBracket } from "./helpers/seed-bracket";
import { fixtureRow, labelOf, playBadminton, post, rowsOf, seatOf, siblingOf, tip, type FixtureRow } from "./helpers/w2b-rig";

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

/** Every backend waiting, directly or down a chain, on a lock `pid` holds. */
async function blockedBehind(pid: number): Promise<number[]> {
  const seen = new Set<number>();
  let frontier = [pid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const p of frontier) {
      for (const w of await waitersOn(p)) {
        if (seen.has(w)) continue;
        seen.add(w);
        next.push(w);
      }
    }
    frontier = next;
  }
  return [...seen];
}

async function until(what: string, done: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Postgres's deadlock code, anywhere in a rejection (postgres.js puts it on `.code`). */
const isDeadlock = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" && ((r.reason as { code?: string })?.code === "40P01" || /deadlock/i.test(String(r.reason)));
const why = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" ? `${(r.reason as { code?: string })?.code ?? "?"}: ${String(r.reason)}` : "ok";

const loserOf = (r: FixtureRow) => (r.outcome?.winner === r.home_entrant_id ? r.away_entrant_id : r.home_entrant_id);

/** Sixteen entrants. R16 line F a recorded double walkover; its sibling G played, so QF Q is the cascade's walkover
 *  over F's dead seat, and Q's walkover winner sits in SF P; Q's sibling QF played out, so P has both seats; P one game
 *  from its end. */
async function sixteen() {
  const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 16 });
  const rows = await rowsOf(s.stageId);
  const firstRound = Math.min(...rows.map((r) => r.round_no));
  const r16 = rows.filter((r) => r.round_no === firstRound);
  expect(r16.length, "rig: sixteen entrants make eight first-round lines").toBe(8);
  const F = r16[0]!;
  const G = siblingOf(rows, F);
  const dw = await post(s.auth, F.id, "core.forfeit", { by: "both", reason: "walkover" });
  expect([dw.status, dw.outcome], "rig: F is a recorded double walkover").toEqual(["forfeited", { kind: "double_walkover" }]);
  const g = await playBadminton(s.auth, G.id, true);
  const Q = await fixtureRow(F.winner_to_fixture!);
  expect([Q.status, Q.outcome?.kind, Q.outcome?.winner], "rig: Q is the cascade's walkover to G's winner").toEqual([
    "forfeited",
    "award",
    g.outcome!.winner,
  ]);
  const Q2 = siblingOf(await rowsOf(s.stageId), Q);
  for (const line of (await rowsOf(s.stageId)).filter((r) => r.winner_to_fixture === Q2.id)) await playBadminton(s.auth, line.id, true);
  await playBadminton(s.auth, Q2.id, true);
  const P = await fixtureRow(Q.winner_to_fixture!);
  expect([P.status, P.home_entrant_id !== null, P.away_entrant_id !== null], "rig: SF P is seated and unplayed").toEqual(["scheduled", true, true]);
  await post(s.auth, P.id, "core.start");
  await post(s.auth, P.id, "badminton.game.summary", { home: 21, away: 10 });
  expect((await fixtureRow(P.id)).status, "rig: P is one game from its end").toBe("in_play");
  const final = await fixtureRow(P.winner_to_fixture!);
  expect(seatOf(final, P.winner_to_slot), "rig: the final's seat from P waits").toBeNull();
  return { s, F, Q, P, finalId: final.id, dwEventId: dw.event_id };
}

/** Four entrants: SF1 a recorded double walkover appended BELOW the console, so its own cascade (`onDecided`) has not
 *  run — the moment between the double walkover's commit and its cascade, when an organiser can already void it. */
async function four() {
  const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
  const sf1 = await fixtureRow(s.fixtureIds[0]!);
  const dw = await appendEvent(s.auth.orgId, sf1.id, await tip(sf1.id), { type: "core.forfeit", payload: { by: "both", reason: "walkover" } });
  const after = await fixtureRow(sf1.id);
  expect([after.status, after.outcome], "rig: SF1 is a recorded double walkover").toEqual(["forfeited", { kind: "double_walkover" }]);
  return { s, sf1, dwEventId: dw.event.id };
}

/** Hold the stage lock on a third connection while `queue` lines writers up behind it, in order; a writer that runs
 *  through or fails while the lock is held is reported, never waited out. */
async function behindTheStage(stageId: string, queue: Array<() => Promise<unknown>>) {
  const out: Promise<unknown>[] = [];
  const early: (PromiseSettledResult<unknown> | undefined)[] = [];
  await sql.begin(async (holder) => {
    await lockStageSeats(holder, stageId);
    const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
    for (const [i, start] of queue.entries()) {
      const p = start();
      out.push(p);
      p.then(
        (value) => (early[i] ??= { status: "fulfilled", value }),
        (reason: unknown) => (early[i] ??= { status: "rejected", reason }),
      );
      const waiting = () => out.filter((_, k) => early[k] === undefined).length;
      await until(`writer ${i + 1} queues behind the stage lock`, async () => early[i] !== undefined || (await blockedBehind(held!.pid)).length === waiting());
    }
    expect(
      queue.map((_, k) => (early[k] === undefined ? "waits" : why(early[k]!))),
      `every writer waits behind the held stage lock — none ran through it`,
    ).toEqual(queue.map(() => "waits"));
  }); // commits: the writers go on, in the order they queued
  return Promise.allSettled(out);
}

describe.skipIf(!HAS_DB)("Loop R2 N-1: the stage lock comes before every fixture lock", () => {
  it("the void of a double walkover two rounds back races a semi's last point: no deadlock, the void is refused (the semi started), the semi's winner is seated in the final", async () => {
    const { s, F, P, finalId, dwEventId } = await sixteen();
    // The void queues first, so it is granted the stage first: under the old order it then asked for P's fixture lock,
    // which P's decision held while it waited for the stage.
    const [v, d] = await behindTheStage(s.stageId, [
      () => post(s.auth, F.id, "core.void", { event_id: dwEventId }),
      () => post(s.auth, P.id, "badminton.game.summary", { home: 21, away: 10 }),
    ]);
    expect([isDeadlock(v!), isDeadlock(d!)], `no writer is a deadlock victim (void ${why(v!)}; decision ${why(d!)})`).toEqual([false, false]);
    expect(v!.status === "rejected" && (v!.reason as { code?: string }).code, `the void is refused: P started (${why(v!)})`).toBe("NEXT_MATCH_STARTED");
    expect(d!.status, `the semi's last point and its cascade succeed (${why(d!)})`).toBe("fulfilled");
    const semi = await fixtureRow(P.id);
    const final = await fixtureRow(finalId);
    expect([semi.status, seatOf(final, P.winner_to_slot)], "P is decided and its winner sits in the final").toEqual(["decided", semi.outcome!.winner]);
    expect(loserOf(semi), "P had a loser (a played semi, not a walkover)").not.toBeNull();
    expect((await fixtureRow(F.id)).outcome, "F's double walkover stands — the void was refused whole").toEqual({ kind: "double_walkover" });
  }, 90_000);

  it("a double walkover's own cascade races its void: the void waits at the stage lock holding no fixture lock, then revives — both succeed", async () => {
    const { s, sf1, dwEventId } = await four();
    // The cascade queues first: under a fixture-first void it was granted the stage, then asked for SF1's fixture lock,
    // which the void held while it waited for the stage.
    const [d, v] = await behindTheStage(s.stageId, [
      () => onDecided(s.auth, sf1.id),
      () => post(s.auth, sf1.id, "core.void", { event_id: dwEventId }),
    ]);
    expect([d!.status, v!.status], `both writers succeed (cascade ${why(d!)}; void ${why(v!)})`).toEqual(["fulfilled", "fulfilled"]);
    const semi = await fixtureRow(sf1.id);
    const final = await fixtureRow(sf1.winner_to_fixture!);
    expect(
      [semi.status, semi.outcome, final.status, final.outcome, seatOf(final, sf1.winner_to_slot), labelOf(final, sf1.winner_to_slot)],
      "SF1 is live again and the final waits for it",
    ).toEqual(["scheduled", null, "scheduled", null, null, "slot.winner_match"]);
  }, 60_000);

  it("a feed edge wired between onDecided's unlocked read and its locked one: the stage lock is still taken before the cascade reads", async () => {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const sf1 = await fixtureRow(s.fixtureIds[0]!);
    for (let g = 0; g < 2; g++) {
      if (g === 0) await appendEvent(s.auth.orgId, sf1.id, await tip(sf1.id), { type: "core.start", payload: {} });
      await appendEvent(s.auth.orgId, sf1.id, await tip(sf1.id), { type: "badminton.game.summary", payload: { home: 21, away: 10 } });
    }
    const decided = await fixtureRow(sf1.id);
    expect(decided.status, "rig: SF1 is decided, its cascade not run").toBe("decided");
    // The edge is not wired yet when the decision first reads its line (as before `wireCrossFeeds` runs).
    await sql`update fixtures set winner_to_fixture = null, winner_to_slot = null where id = ${sf1.id}`;
    let settled = false;
    let deciding!: Promise<unknown>;
    let queuedOnStage = false;
    await sql.begin(async (stageHolder) => {
      await lockStageSeats(stageHolder, s.stageId);
      const [stage] = await stageHolder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await sql.begin(async (fixtureHolder) => {
        await fixtureHolder`select pg_advisory_xact_lock(hashtext(${"fixture:" + sf1.id}))`;
        const [fx] = await fixtureHolder<{ pid: number }[]>`select pg_backend_pid() as pid`;
        deciding = onDecided(s.auth, sf1.id);
        deciding.then(() => (settled = true), () => (settled = true));
        await until("the decision read its line unwired and waits for its fixture lock", async () => (await waitersOn(fx!.pid)).length === 1);
        await fixtureHolder`update fixtures set winner_to_fixture = ${sf1.winner_to_fixture}, winner_to_slot = ${sf1.winner_to_slot} where id = ${sf1.id}`;
      }); // the edge lands; the decision takes its fixture lock and finds it
      await until("the decision either runs through or queues on the stage lock", async () => {
        queuedOnStage = (await waitersOn(stage!.pid)).length > 0;
        return settled || queuedOnStage;
      });
    });
    await deciding;
    expect(queuedOnStage, "the decision waited for the stage lock before its cascade read the feeders").toBe(true);
    const final = await fixtureRow(sf1.winner_to_fixture!);
    expect(seatOf(final, sf1.winner_to_slot), "and then seated its winner").toBe(decided.outcome!.winner);
  }, 60_000);

  it("another stage kind: the void of a double walkover on a line that feeds nothing takes no stage lock, and needs none", async () => {
    // A league's line feeds no next match, so its double walkover killed no seat (X-DW-4: a table line is recorded and
    // counted). Its void revives nothing; the revive's lock-order guard must not refuse it.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "league", entrants: 4 });
    const line = await fixtureRow(s.fixtureIds[0]!);
    expect([line.winner_to_fixture, line.loser_to_fixture], "rig: a league line feeds nothing").toEqual([null, null]);
    const dw = await post(s.auth, line.id, "core.forfeit", { by: "both", reason: "walkover" });
    expect([dw.status, dw.outcome], "rig: a recorded double walkover").toEqual(["forfeited", { kind: "double_walkover" }]);
    await post(s.auth, line.id, "core.void", { event_id: dw.event_id });
    const after = await fixtureRow(line.id);
    expect([after.status, after.outcome], "the void stands: the line is unplayed again").toEqual(["scheduled", null]);
  }, 60_000);

  it("the revive refuses to run without the stage lock taken first (a writer that reaches it fixture-first is a lock-order bug, not a race to lose)", async () => {
    const { s, sf1 } = await four();
    await expect(
      withTenant(s.auth.orgId, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + sf1.id}))`;
        return releaseFedSeats(tx, sf1.id, { kind: "double_walkover" }, null);
      }),
    ).rejects.toThrow(/^reviveDeadSeats: fixture .* revives without the stage lock/);
    // …and with it taken first, the same call runs.
    const changed = await withTenant(s.auth.orgId, async (tx) => {
      await lockStageSeats(tx, s.stageId);
      await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + sf1.id}))`;
      return releaseFedSeats(tx, sf1.id, { kind: "double_walkover" }, null);
    });
    // SF1's own cascade never ran (appended below the console), so its double walkover killed nothing to revive.
    expect(changed, "the revive ran under the stage lock, and found nothing killed").toEqual([]);
  }, 60_000);
});
