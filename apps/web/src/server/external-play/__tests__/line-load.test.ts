// The capacity load run's arithmetic (e2e/load/line-load.ts): every copied constant pinned to the server's own declaration, and every
// metric proved on hand-counted cases - the expected values are written from the spec's words (§5.6.8), never taken from the function
// under test. Single sport, deliberately: nothing here knows a sport (online play exists for `boardgame` only, guard.ts).
import { describe, expect, it } from "vitest";
import { BATCH_REREAD_JITTER_MS } from "../../../components/public-site/match-room/use-room";
import { LINE_POLL_MIN_MS, LINE_POLL_MS } from "../../../components/public-site/match-room/room-snapshot";
import { STRANDED_CREATE_AFTER_MS, SWEEP_CADENCE_MS } from "../../usecases/external-play/sweep";
import {
  ADMIT_HOLD_MS,
  LINE_ABANDON_AFTER_MS,
  LINE_COMPLETING_LEVEL,
  LINE_MINT_CALLS,
  LINE_READ_CALLS,
  LINE_RECHECK_COST,
  LINE_RELEASE_GRACE_MS,
  LINE_RESERVATION,
  LINE_TOKEN_CALLS,
} from "../seat-line";
import { RTK_BUDGET_BURST, RTK_BUDGET_REFILL_PER_S } from "../video/budget";
import {
  CHECKIN_BATCH_GAP_MS,
  CHECKIN_BATCH_SIZE,
  DEADLINE_AFTER_MS,
  LINE_DEADLINE_GRACE_MS,
  WINDOW_OPEN_LEAD_MS,
  boardAnchor,
  boardCap,
  windowFor,
} from "../window";
import {
  LINE_LOAD,
  admissionPace,
  barsOf,
  boardTimes,
  callsOf,
  classifyCreates,
  classifyInversions,
  DRY_MARGIN_CALLS,
  drainOf,
  dryArrivalSpreadS,
  etaStats,
  gateLevels,
  heldStays,
  judgeCosts,
  nettingOwed,
  peakPerSecond,
  warningStats,
  poolOf,
  slowBound,
  stayCosts,
  type BoardCreate,
  type LineSample,
  type StayInLine,
  type VendorCall,
} from "../../../../e2e/load/line-load";

describe("LINE_LOAD: every number the run copies is the server's own", () => {
  it("equals the declarations it was copied from, one by one", () => {
    expect(LINE_LOAD.batchSize).toBe(CHECKIN_BATCH_SIZE);
    expect(LINE_LOAD.batchGapMs).toBe(CHECKIN_BATCH_GAP_MS);
    expect(LINE_LOAD.windowLeadMs).toBe(WINDOW_OPEN_LEAD_MS);
    expect(LINE_LOAD.deadlineAfterMs).toBe(DEADLINE_AFTER_MS);
    expect(LINE_LOAD.lineGraceMs).toBe(LINE_DEADLINE_GRACE_MS);
    expect(LINE_LOAD.reservation).toBe(LINE_RESERVATION);
    expect(LINE_LOAD.recheckCost).toBe(LINE_RECHECK_COST);
    expect(LINE_LOAD.abandonAfterMs).toBe(LINE_ABANDON_AFTER_MS);
    expect(LINE_LOAD.releaseGraceMs).toBe(LINE_RELEASE_GRACE_MS);
    expect(LINE_LOAD.admitHoldMs).toBe(ADMIT_HOLD_MS);
    expect(LINE_LOAD.sweepCadenceMs).toBe(SWEEP_CADENCE_MS);
    expect(LINE_LOAD.strandedCreateAfterMs).toBe(STRANDED_CREATE_AFTER_MS);
    expect(LINE_LOAD.batchRereadJitterMs).toBe(BATCH_REREAD_JITTER_MS);
    expect(LINE_LOAD.pollMinMs).toBe(LINE_POLL_MIN_MS);
    expect(LINE_LOAD.pollMs).toBe(LINE_POLL_MS);
    expect(LINE_LOAD.completingLevel, "seat-line.ts LINE_COMPLETING_LEVEL: the level B-dry's min gate level is judged against").toBe(LINE_COMPLETING_LEVEL);
  });

  it("the MEASURED instant-camera cost per player sits between the model's floor and ceiling, both made from the server's own call counts", () => {
    // 7.1 is the report's `perPlayerCheckIn` of every B run (426 check-in calls for 60 players). The floor is one stay (the mint, one read of the
    // seat, the token handed with it); the ceiling adds the opponent's re-verify, shared by the board's two players. A measurement outside the
    // bracket would mean the harness or the product changed under it, and B-dry's derivation would be dry or wet by accident.
    const floor = LINE_MINT_CALLS + LINE_READ_CALLS + LINE_TOKEN_CALLS;
    const ceiling = floor + LINE_RECHECK_COST / 2;
    expect(LINE_LOAD.instantCallsPerPlayer).toBeGreaterThanOrEqual(floor);
    expect(LINE_LOAD.instantCallsPerPlayer).toBeLessThanOrEqual(ceiling);
  });

  it("the spec's own thresholds (30 s prompt, 50 ms jitter) are the spec's words, and not zero", () => {
    expect(LINE_LOAD.createPromptMs).toBe(30_000);
    expect(LINE_LOAD.arrivalJitterMs).toBe(50);
  });
});

describe("boardTimes equals the server's window for every rank (a sweep, counted)", () => {
  it("batch, anchor, opening, deadline and cap agree with boardAnchor / windowFor / boardCap for 36 ranks x staggered or not", () => {
    const opened = new Date("2026-10-15T10:00:00.000Z");
    let checked = 0;
    for (const staggered of [true, false]) {
      for (let rank = 0; rank < 36; rank += 1) {
        const anchor = boardAnchor(opened, rank, staggered);
        const w = windowFor(anchor);
        expect(boardTimes(opened.getTime(), rank, staggered), `rank ${rank} staggered ${staggered}`).toEqual({
          batch: anchor.batch,
          anchorAt: anchor.at.getTime(),
          opensAt: w.opensAt.getTime(),
          deadlineAt: w.deadline.getTime(),
          capAt: boardCap(anchor).getTime(),
        });
        checked += 1;
      }
    }
    expect(checked, "ranks checked").toBe(72);
  });

  it("refuses a rank that is not a non-negative integer", () => {
    expect(() => boardTimes(0, -1, true)).toThrow(RangeError);
    expect(() => boardTimes(0, 1.5, true)).toThrow(RangeError);
  });
});

describe("classifyCreates: the metrics defined once (§5.6.8)", () => {
  const CAP = 1_000_000;
  const board = (id: string, seated: number | null, seen: number | null, cap = CAP): BoardCreate => ({ id, bothSeatedAt: seated, gameSeenAt: seen, capAt: cap });

  it("a game within 30 s is prompt, past 30 s is LATE, exactly 30 s is prompt (the boundary), and a board with a player never seated is neither", () => {
    const got = classifyCreates(
      [board("a", 0, 5_000), board("b", 0, 30_000), board("c", 0, 30_001), board("d", null, null), board("e", 100, 100)],
      10_000_000,
    );
    expect(got.boards, "boards looked at").toBe(5);
    expect(got.prompt).toBe(3);
    expect(got.lateCreates).toEqual(["c"]);
    expect(got.notBothSeated).toBe(1);
    expect(got.neverCreated).toEqual([]);
    expect(got.afterSeatMs.sort((x, y) => x - y)).toEqual([0, 5_000, 30_000, 30_001]);
  });

  it("never created: no game at the EARLIER of the cap and two sweep cadences after the last seat - and not before it (the run may simply have ended early)", () => {
    const twoCadences = 2 * LINE_LOAD.sweepCadenceMs;
    // Seated at 0, cap far away: judged at two cadences.
    expect(classifyCreates([board("n", 0, null)], twoCadences).neverCreated, "at the judgement instant").toEqual(["n"]);
    expect(classifyCreates([board("n", 0, null)], twoCadences - 1).neverCreated, "one ms before it").toEqual([]);
    expect(classifyCreates([board("n", 0, null)], twoCadences - 1).unresolved, "an unresolved board: the run proved nothing").toEqual(["n"]);
    // Seated at 0, cap near: judged at the cap.
    expect(classifyCreates([board("n", 0, null, 50_000)], 50_000).neverCreated, "at the cap").toEqual(["n"]);
    expect(classifyCreates([board("n", 0, null, 50_000)], 49_999).neverCreated).toEqual([]);
  });

  it("a late create beyond the stranded arm's bound (cadence + STRANDED_CREATE_AFTER_MS) is reported apart; at the bound it is not", () => {
    const bound = LINE_LOAD.sweepCadenceMs + LINE_LOAD.strandedCreateAfterMs;
    const got = classifyCreates([board("at", 0, bound), board("over", 0, bound + 1)], 10_000_000);
    expect(got.lateCreates.sort()).toEqual(["at", "over"]);
    expect(got.beyondStrandedBound).toEqual(["over"]);
  });

  it("an empty set looks at nothing: the report says 0 boards, which the run refuses", () => {
    expect(classifyCreates([], 0).boards).toBe(0);
  });
});

describe("realized calls per stay, from the fixture server's own log", () => {
  const call = (at: number, meetingId: string | null): VendorCall => ({ at, meetingId, route: "GET /x" });

  it("counts a meeting's calls in a closed window, ignores other meetings and calls with no meeting", () => {
    const calls = [call(5, "m1"), call(10, "m1"), call(20, "m1"), call(21, "m1"), call(10, "m2"), call(10, null)];
    expect(callsOf(calls, "m1", 10, 20).length, "both ends count").toBe(2);
    expect(callsOf(calls, "m2", 0, 100).length).toBe(1);
    expect(callsOf(calls, "none", 0, 100).length).toBe(0);
  });

  it("a stay's own spend is its meeting in [first claim, seated]; the re-verify is the OPPONENT's meeting after the opponent was served, up to this seat", () => {
    const calls = [
      call(1, "mA"), call(2, "mA"), call(3, "mA"), // A: three, before A was served at 3
      call(4, "mB"), call(6, "mB"), // B's own, before B seated at 7
      call(5, "mA"), call(6, "mA"), call(7, "mA"), // the re-verify of A's camera, by B's seat (A served at 3, B at 7)
      call(8, "mA"), // after B was served: nobody's
    ];
    const got = stayCosts(calls, [
      { id: "A", ownMeeting: "mA", opponentMeeting: "mB", firstClaimAt: 0, seatedAt: 3, opponentSeatedAt: 7, unreserved: [] },
      { id: "B", ownMeeting: "mB", opponentMeeting: "mA", firstClaimAt: 0, seatedAt: 7, opponentSeatedAt: 3, unreserved: ["re-press"] },
    ]);
    expect(got[0]).toEqual({ id: "A", own: 3, recheck: 0, unreserved: [] });
    expect(got[1]!.own, "B's own").toBe(2);
    expect(got[1]!.recheck, "B paid for the re-verify of A's camera (calls 5, 6, 7)").toBe(3);
    expect(got[1]!.unreserved).toEqual(["re-press"]);
  });

  it("judgeCosts: above the reservation is reported with its stay, at it is not; the distribution counts stays per spend; zero stays checked is visible", () => {
    const costs = [
      { id: "a", own: 6, recheck: 0, unreserved: [] },
      { id: "b", own: 21, recheck: 3, unreserved: [] },
      { id: "c", own: 22, recheck: 4, unreserved: ["re-press"] },
      { id: "d", own: 6, recheck: 0, unreserved: [] },
    ];
    const v = judgeCosts(costs, 21, 3);
    expect(v.stays).toBe(4);
    expect(v.over.map((c) => c.id)).toEqual(["c"]);
    expect(v.overRecheck.map((c) => c.id)).toEqual(["c"]);
    expect(v.distribution).toEqual({ 6: 2, 21: 1, 22: 1 });
    expect(v.max).toBe(22);
    expect(judgeCosts([], 21, 3).stays, "nothing checked").toBe(0);
  });
});

describe("classifyInversions: the three excuses, each counted apart (§5.6.8)", () => {
  const stay = (id: string, first: number, queued: number | null, admitted: number | null, rejoiner = false): StayInLine => ({
    id,
    firstClaimAt: first,
    queuedAt: queued,
    admittedAt: admitted,
    servedAt: null,
    rejoiner,
  });

  it("an in-order set is clean, with its pairs reported", () => {
    const got = classifyInversions([stay("a", 100, 110, 500), stay("b", 300, 310, 600), stay("c", 500, 510, 700)]);
    expect(got).toEqual({ pairs: 3, unexcused: [], excused: { rejoiner: 0, notYetInLine: 0, jitter: 0 } });
  });

  it("an inversion nothing excuses is unexcused and names the pair", () => {
    const got = classifyInversions([stay("a", 100, 110, 900), stay("b", 300, 310, 600)]);
    expect(got.unexcused).toEqual([["a", "b"]]);
    expect(got.excused).toEqual({ rejoiner: 0, notYetInLine: 0, jitter: 0 });
  });

  it("(a) the earlier arrival is a rejoiner; (b) it was first held only after the later one was admitted; (c) the arrivals are under 50 ms apart", () => {
    expect(classifyInversions([stay("a", 100, 110, 900, true), stay("b", 300, 310, 600)]).excused, "(a)").toEqual({ rejoiner: 1, notYetInLine: 0, jitter: 0 });
    expect(classifyInversions([stay("a", 100, 700, 900), stay("b", 300, 310, 600)]).excused, "(b)").toEqual({ rejoiner: 0, notYetInLine: 1, jitter: 0 });
    expect(classifyInversions([stay("a", 100, 110, 900), stay("b", 149, 160, 600)]).excused, "(c) 49 ms").toEqual({ rejoiner: 0, notYetInLine: 0, jitter: 1 });
    expect(classifyInversions([stay("a", 100, 110, 900), stay("b", 150, 160, 600)]).unexcused, "(c) exactly 50 ms is NOT jitter").toEqual([["a", "b"]]);
  });

  it("(b) at the boundary: first held AT the later one's admission is already in line, so not excused", () => {
    expect(classifyInversions([stay("a", 100, 600, 900), stay("b", 300, 310, 600)]).unexcused).toEqual([["a", "b"]]);
    expect(classifyInversions([stay("a", 100, 601, 900), stay("b", 300, 310, 600)]).unexcused).toEqual([]);
  });

  it("a tie in arrival is no pair; a stay never held is out of the pairs; admitted in the same instant is not inverted", () => {
    expect(classifyInversions([stay("a", 100, 110, 900), stay("b", 100, 110, 600)]).pairs).toBe(0);
    expect(classifyInversions([stay("a", 100, null, 900), stay("b", 300, 310, 600)]).pairs).toBe(0);
    const same = classifyInversions([stay("a", 100, 110, 600), stay("b", 300, 310, 600)]);
    expect([same.pairs, same.unexcused.length]).toEqual([1, 0]);
  });
});

describe("the pool, the drained phase, the admission pace", () => {
  const sample = (at: number, tokens: number, inFlight: number, completing: number, waiting: number): LineSample => ({ at, tokens, inFlight, completing, waiting });

  it("the pool is the level less every held reservation, plus the recheck cost of each completing stay", () => {
    expect(poolOf(sample(0, 100, 2, 1, 0))).toBe(100 - 2 * LINE_RESERVATION - 1 * LINE_RECHECK_COST);
    expect(poolOf(sample(0, 10, 1, 0, 0)), "it may go negative").toBe(10 - LINE_RESERVATION);
  });

  it("drained: the first sample with a waiting stay and a pool under one reservation; the in-flight maximum is read from there on, not before", () => {
    const samples = [
      sample(0, 300, 5, 0, 0), // not drained: nobody waiting
      sample(500, 10, 4, 0, 0), // pool negative but nobody waiting
      sample(1_000, 150, 2, 0, 3), // waiting, pool 150 - 42 = 108: holds a reservation, not drained
      sample(1_500, 50, 3, 0, 3), // waiting, pool 50 - 63 < 21: DRAINED here
      sample(2_000, 70, 2, 0, 2),
      sample(2_500, 90, 6, 0, 1),
    ];
    expect(drainOf(samples)).toEqual({ drainedAt: 1_500, maxInFlightDrained: 6, samplesChecked: 6 });
    // The pool EQUAL to one reservation still admits (the gate admits iff pool >= reservation): not drained. And the drain sample itself
    // is inside the drained phase, so an in-flight maximum standing AT it counts.
    const edge = [sample(0, 2 * LINE_RESERVATION + LINE_RESERVATION, 2, 0, 3), sample(500, 2 * LINE_RESERVATION + LINE_RESERVATION - 1, 9, 0, 3), sample(1_000, 100, 1, 0, 3)];
    expect(poolOf(edge[0]!), "premise: exactly one reservation in the pool").toBe(LINE_RESERVATION);
    expect(drainOf(edge).drainedAt, "pool == reservation is not drained; one token less is").toBe(500);
    expect(drainOf(edge).maxInFlightDrained, "the in-flight maximum standing AT the drain sample counts").toBe(9);
    expect(drainOf([sample(0, 300, 5, 0, 0)])).toEqual({ drainedAt: null, maxInFlightDrained: 0, samplesChecked: 1 });
    expect(drainOf([]).samplesChecked, "nothing sampled").toBe(0);
  });

  it("the pace: the interval between consecutive admissions from a point, in seconds, mean and median; an admission before the point is out", () => {
    const got = admissionPace([0, 10_000, 19_000, 40_000, 41_000], 10_000);
    // admitted from 10 s: 10, 19, 40, 41 -> gaps 9, 21, 1 s
    expect(got.admissions).toBe(4);
    expect(got.intervals).toBe(3);
    expect(got.meanS).toBeCloseTo((9 + 21 + 1) / 3, 10);
    expect(got.p50S, "median of 1, 9, 21").toBe(9);
    expect(admissionPace([5_000], 0), "one admission has no interval").toEqual({ admissions: 1, intervals: 0, meanS: null, p50S: null });
  });
});

describe("B-slow's bound (§5.6.8), built from the run's own calls", () => {
  const run = { callsRun: 1_100, players: 60, warmupS: 10, maxInFlightDrained: 2, burst: RTK_BUDGET_BURST, refillPerS: RTK_BUDGET_REFILL_PER_S, pollMs: LINE_POLL_MS, maxBackoffMs: 8_000 };

  it("at 10 s with 1,100 calls: s = 18, lag (reservation + recheck) = (2 x 24 + (24 - 18.33)) / 2, bound = (1,100 - 300) / 2 + s + 3 + lag; the sum model is 600 s and discriminates", () => {
    const got = slowBound(run);
    const dBar = 1_100 / 60;
    expect(got.perPlayer).toBeCloseTo(dBar, 10);
    expect(got.s).toBe(18);
    expect(got.lag).toBeCloseTo((2 * 24 + (24 - dBar)) / 2, 10);
    expect(got.lagSpec, "the spec's own lag, reservation alone, reported beside it").toBeCloseTo((2 * 21 + (21 - dBar)) / 2, 10);
    expect(got.bound).toBeCloseTo((1_100 - 300) / 2 + 18 + 3 + got.lag, 10);
    expect(got.sumModel).toBe(600);
    expect(got.discriminates, "600 s > the bound").toBe(true);
    // The spec's model said a bound of about 434 to 478 s at 10 s.
    expect(got.bound).toBeGreaterThan(434);
    expect(got.bound).toBeLessThan(478);
  });

  it("at 5 s the sum model (300 s) is BELOW the bound: it does not discriminate, and the run says so (it proves the cost model, not the window)", () => {
    // 60 players at the table's 15 calls for a 5 s camera: about 900 calls; the spec's model puts the bound at 340 to 384 s.
    const got = slowBound({ ...run, callsRun: 900, warmupS: 5 });
    expect(got.sumModel).toBe(300);
    expect(got.bound).toBeGreaterThan(340);
    expect(got.bound).toBeLessThan(384);
    expect(got.discriminates).toBe(false);
  });

  it("a larger run or more in flight raises the bound; more players with the same calls lowers D-bar and so raises the lag's second term", () => {
    expect(slowBound({ ...run, callsRun: 1_200 }).bound).toBeGreaterThan(slowBound(run).bound);
    expect(slowBound({ ...run, maxInFlightDrained: 3 }).bound).toBeGreaterThan(slowBound(run).bound);
    expect(slowBound({ ...run, players: 120 }).lag).toBeGreaterThan(slowBound(run).lag);
  });

  it("the lag's second term never goes negative: a player who spent MORE than one hold has nothing left to wait for (floor at zero)", () => {
    // 3,000 calls over 60 players = 50 a player, above the 24 held: the term is 0, so the lag is exactly the in-flight term.
    const got = slowBound({ ...run, callsRun: 3_000, maxInFlightDrained: 2 });
    expect(got.perPlayer).toBe(50);
    expect(got.lag).toBe((2 * 24) / RTK_BUDGET_REFILL_PER_S);
  });

  it("discriminates is STRICT: a sum model equal to the bound does not discriminate (200 players x 30 s = 6,000 s = 5,970 calls at 1/s + 30 s warm-up)", () => {
    const got = slowBound({ callsRun: 5_970, players: 200, warmupS: 30, maxInFlightDrained: 0, burst: 0, refillPerS: 1, pollMs: 0, maxBackoffMs: 0 });
    expect([got.bound, got.sumModel], "premise: equal").toEqual([6_000, 6_000]);
    expect(got.discriminates).toBe(false);
  });

  it("refuses a run with no players", () => {
    expect(() => slowBound({ ...run, players: 0 })).toThrow(RangeError);
  });

  it("the netting trigger: the MEAN interval above 1.5 x D-bar / refill is owed (13.75 s at 18.33 calls a player); at it, or with no intervals, it is not", () => {
    const dBar = 1_100 / 60;
    const limit = (1.5 * dBar) / RTK_BUDGET_REFILL_PER_S;
    expect(nettingOwed(limit + 0.01, dBar, RTK_BUDGET_REFILL_PER_S)).toBe(true);
    expect(nettingOwed(limit, dBar, RTK_BUDGET_REFILL_PER_S)).toBe(false);
    expect(nettingOwed(null, dBar, RTK_BUDGET_REFILL_PER_S)).toBe(false);
  });
});

describe("ETA shown against the wait that happened, and the busiest second", () => {
  it("the ETA is an upper bound: a wait longer than shown is counted; the median of shown / actual is reported; a zero wait has no ratio", () => {
    const got = etaStats([
      { shownS: 100, actualS: 50 }, // 2.0
      { shownS: 60, actualS: 60 }, // 1.0
      { shownS: 30, actualS: 40 }, // 0.75, exceeded
      { shownS: 10, actualS: 0 }, // no ratio
    ]);
    expect(got.players).toBe(4);
    expect(got.medianShownOverActual, "median of 0.75, 1, 2").toBe(1);
    expect(got.exceeded).toBe(1);
    expect(etaStats([]).medianShownOverActual).toBeNull();
    // A zero wait is out of the median: ratios 0.5 and 2 give 0.5 (the lower middle), not the 2 an Infinity would pull in.
    expect(etaStats([{ shownS: 10, actualS: 20 }, { shownS: 40, actualS: 20 }, { shownS: 10, actualS: 0 }]).medianShownOverActual).toBe(0.5);
  });

  it("the mayTimeOut warning as the players saw it: answers with a line, answers that warned, players who saw it at least once; an answer with no line is not counted (hand-counted)", () => {
    const line = (mayTimeOut: boolean) => ({ line: { mayTimeOut } });
    const none = { line: null };
    const got = warningStats([
      [none, line(false), line(true), line(true)], // two warned answers, one player
      [line(false), line(false)], // never warned
      [none, none], // never held: no line at all
      [line(true)], // a second player who saw it
    ]);
    expect(got).toEqual({ answersWithALine: 6, warnedAnswers: 3, playersWithALine: 3, playersWarned: 2 });
    // The empty case: nobody was held, and the report says so as zeros rather than as a missing figure.
    expect(warningStats([])).toEqual({ answersWithALine: 0, warnedAnswers: 0, playersWithALine: 0, playersWarned: 0 });
    expect(warningStats([[none], []])).toEqual({ answersWithALine: 0, warnedAnswers: 0, playersWithALine: 0, playersWarned: 0 });
  });

  it("the peak a second: the busiest whole second and how many seconds had any request", () => {
    expect(peakPerSecond([0, 100, 999, 1_000, 1_001, 1_002, 1_003, 5_000])).toEqual({ peak: 4, seconds: 3 });
    expect(peakPerSecond([])).toEqual({ peak: 0, seconds: 0 });
  });
});

describe("which pass bars a capacity scenario owes, by the shape of its run (harness bar fix, B-dry)", () => {
  // The scenario names are the ones the harness header documents (chess-30-boards.load.ts, "RUN IT"); the expected sets are written from
  // that header's words, not read back from barsOf: the line FORMS (two or more stays waiting, so there are pairs and positions to order)
  // on B-honest and the B-slow legs; at B's instant cameras the bucket sits a few tokens from dry and whether a stay is held is run-to-run
  // (5 of 6 runs), so B owes the product bars only and RECORDS the held count; B-dry is B made short of tokens ON PURPOSE and owes the dry bars.
  const NAMED = ["A", "A-slow", "B", "B-dry", "B-honest", "B-slow-5", "B-slow-10", "B-end", "B-end-slow-10", "regress", "mixed"] as const;
  const COST = ["B", "B-honest", "B-slow-5", "B-slow-10"];
  const ORDER = ["B-honest", "B-slow-5", "B-slow-10"];
  const DRY = ["B-dry"];

  it("every documented scenario, against the three bar families (11 scenarios checked)", () => {
    let checked = 0;
    for (const name of NAMED) {
      const got = barsOf(name);
      expect(got.cost, `${name}: cost bars`).toBe(COST.includes(name));
      expect(got.order, `${name}: order bars (admission pairs, inversions, positions)`).toBe(ORDER.includes(name));
      expect(got.dry, `${name}: dry bars (held stays >= 1, min gate level under the completing level)`).toBe(DRY.includes(name));
      checked += 1;
    }
    expect(checked, "scenarios checked").toBe(NAMED.length);
  });

  it("the families are disjoint where the shapes differ: B owes neither the order nor the dry bars; B-dry owes only the dry bars", () => {
    for (const name of NAMED) expect(barsOf(name).order && barsOf(name).dry, name).toBe(false);
    expect(barsOf("B"), "B (instant cameras): 0 pairs is the shape of the run, and the held count is recorded, not judged").toEqual({ cost: true, order: false, dry: false });
    expect(barsOf("B-honest").order, "B-honest measured 190-210 pairs: it owns the order bars").toBe(true);
    expect(barsOf("B-dry"), "B-dry owes the dry bars and the product bars every strict leg owes").toEqual({ cost: false, order: false, dry: true });
  });

  it("an unknown scenario name owes nothing - a label, as the header says", () => {
    expect(barsOf("anything-else")).toEqual({ cost: false, order: false, dry: false });
  });

  it("heldStays counts the stays the budget held (a queued_at stamp), and is 0 for none", () => {
    const stay = (id: string, queued: number | null, admitted: number | null) => ({ id, firstClaimAt: 100, queuedAt: queued, admittedAt: admitted, servedAt: null });
    expect(heldStays([]), "empty").toBe(0);
    expect(heldStays([stay("a", null, null), stay("b", null, null)]), "never held").toBe(0);
    expect(heldStays([stay("a", 110, 900), stay("b", null, 200), stay("c", 120, null)]), "held then admitted, admitted straight away (not held), held and gone").toBe(2);
  });
});

describe("B-dry's arrival spread is derived: demand exceeds the bucket's supply by a margin made of the product's own constants", () => {
  const PLAYERS = 60; // 30 boards, as B
  const c = LINE_LOAD.instantCallsPerPlayer;
  const supply = (spreadS: number) => RTK_BUDGET_BURST + RTK_BUDGET_REFILL_PER_S * spreadS;
  const input = { players: PLAYERS, perPlayerCalls: c, burst: RTK_BUDGET_BURST, refillPerS: RTK_BUDGET_REFILL_PER_S, marginCalls: DRY_MARGIN_CALLS };

  it("the margin is a completing candidate's admission threshold plus the idle level, from the server's declarations", () => {
    expect(DRY_MARGIN_CALLS).toBe(LINE_RESERVATION + LINE_RECHECK_COST + LINE_COMPLETING_LEVEL);
  });

  it("at the derived spread the run's demand exceeds the supply by EXACTLY the margin (the definition, checked on the numbers)", () => {
    const w = dryArrivalSpreadS(input);
    expect(w, "a spread was derived").not.toBeNull();
    expect(PLAYERS * c - supply(w!)).toBeCloseTo(DRY_MARGIN_CALLS, 9);
    expect(w!, "a real spread, not a burst").toBeGreaterThan(0);
  });

  it("B's own spread (60 s) is short of tokens by far less than the margin, which is why B alone cannot promise a dry bucket", () => {
    const bShort = PLAYERS * c - supply(60);
    expect(bShort, "B is barely short (knife-edge), not wet").toBeGreaterThan(0);
    expect(bShort, "and by less than the margin").toBeLessThan(DRY_MARGIN_CALLS);
    expect(dryArrivalSpreadS(input)!, "so B-dry's spread is shorter than B's").toBeLessThan(60);
  });

  it("monotone and honest: more players need a longer spread; a demand the burst alone covers (plus the margin) has none, and the run refuses it", () => {
    const more = dryArrivalSpreadS({ ...input, players: PLAYERS + 20 });
    expect(more!).toBeGreaterThan(dryArrivalSpreadS(input)!);
    expect(dryArrivalSpreadS({ ...input, players: 10 }), "10 players cannot exceed burst + margin").toBeNull();
    expect(dryArrivalSpreadS({ ...input, players: 0 }), "no players").toBeNull();
    expect(dryArrivalSpreadS({ ...input, refillPerS: 0 }), "no refill: no spread to divide by").toBeNull();
    expect(dryArrivalSpreadS({ ...input, perPlayerCalls: 0 }), "no demand").toBeNull();
    // the edge: demand = burst + margin exactly gives a zero spread, which is no spread (one call per player keeps the sum exact)
    const edge = { ...input, perPlayerCalls: 1, players: RTK_BUDGET_BURST + DRY_MARGIN_CALLS };
    expect(dryArrivalSpreadS(edge), "exactly the edge").toBeNull();
    expect(dryArrivalSpreadS({ ...edge, players: edge.players + RTK_BUDGET_REFILL_PER_S }), "one second of refill past the edge is a one-second spread").toBeCloseTo(1, 9);
  });
});

describe("gateLevels: the lowest bucket level any gate decision saw, read from the server's log", () => {
  const line = (extra: string) => `{"level":30,"msg":"seat-line: gate decision",${extra}}`;

  it("empty and unrelated logs have no level (null, and zero decisions: a run that looked at nothing proves nothing)", () => {
    expect(gateLevels([])).toEqual({ decisions: 0, min: null });
    expect(gateLevels(['{"msg":"scoring event appended"}', "", "not json"])).toEqual({ decisions: 0, min: null });
  });

  it("the minimum over the decisions that carry a level, zero included; decisions without one (an older build) are not counted", () => {
    const got = gateLevels([line('"decision":"go_idle","tokens":7.6'), line('"decision":"hold_recheck","tokens":3.9'), line('"decision":"go_idle"'), line('"decision":"go_idle","tokens":12'), '{"msg":"other","tokens":0.1}']);
    expect(got).toEqual({ decisions: 3, min: 3.9 });
    expect(gateLevels([line('"decision":"hold_pool","tokens":0')]), "a level of 0 is a level").toEqual({ decisions: 1, min: 0 });
  });
});
