// Capacity test 32, the server half of the wire (spec §5.7.9, §6.1 (2), §8.1): what a `queued` answer says about the wait.
// `lineWire` is a pure function of the stay's place, the pool, the clock and the board's anchor, so it is driven directly - the
// route and the reducer that carry it to the card are tested in the neighbouring files.
//
// The rules are the spec's (the estimate, the cadence, the warning), written here from the declared constants; the boundary pair
// for `mayTimeOut` takes `etaS` from the ANSWER and `LINE_SERVE_TAIL_S` from its declaration, so a change to either moves the test.
// Single sport, deliberately: the line serves online chess (guard.ts), and the function knows no sport.
import { describe, expect, it } from "vitest";
import { LINE_NEAR_POSITIONS, LINE_POLL_MIN_MS, LINE_POLL_MS, LINE_POLL_SLOW_MS, LINE_SERVE_TAIL_S } from "@/components/public-site/match-room/room-snapshot";
import { RTK_BUDGET_REFILL_PER_S } from "../video/budget";
import { LINE_RESERVATION, lineWire } from "../seat-line";
import { CHECKIN_BATCH_GAP_MS, CHECKIN_BATCH_SIZE, DEADLINE_AFTER_MS, LINE_DEADLINE_GRACE_MS, boardAnchor, boardCap } from "../window";

const ROUND = new Date("2026-10-15T10:00:00.000Z");
const ANCHOR = boardAnchor(ROUND, 0, false);
const CAP = boardCap(ANCHOR);
const base = { position: 1, pool: 0, need: LINE_RESERVATION, now: ROUND, anchor: ANCHOR, left: null } as const;

describe("closesAt is the board's cap, and `left` is carried verbatim", () => {
  it("batch 0 and a later batch: the cap is that batch's own start + the deadline + the line's grace (the stagger moves it)", () => {
    const later = boardAnchor(ROUND, 3 * CHECKIN_BATCH_SIZE, true); // rank 30: batch 3
    const want0 = ROUND.getTime() + DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS;
    const want3 = ROUND.getTime() + 3 * CHECKIN_BATCH_GAP_MS + DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS;
    expect(lineWire({ ...base }).closesAt).toBe(new Date(want0).toISOString());
    expect(lineWire({ ...base, anchor: later }).closesAt).toBe(new Date(want3).toISOString());
    expect(want3, "premise: the two batches have different caps").not.toBe(want0);
  });

  it("`left` is whatever the gate said, null included (3 values)", () => {
    let checked = 0;
    for (const left of [null, "silent", "camera"] as const) {
      expect(lineWire({ ...base, left }).left, String(left)).toBe(left);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

describe("etaS: the time to ADMISSION, each place ahead priced at its worst-case reservation", () => {
  it("is ceil((position x LINE_RESERVATION - pool) / refill), never negative, and 0 once the pool covers the places (the empty case first)", () => {
    // The empty case: a pool that covers the place needs no wait at all.
    expect(lineWire({ ...base, position: 1, pool: LINE_RESERVATION }).etaS, "exactly covered").toBe(0);
    expect(lineWire({ ...base, position: 1, pool: 10 * LINE_RESERVATION }).etaS, "more than covered").toBe(0);
    let checked = 0;
    for (const position of [1, 2, 7]) {
      for (const pool of [-30, 0, 1, LINE_RESERVATION - 1, LINE_RESERVATION * position - 1]) {
        const owed = position * LINE_RESERVATION - pool;
        const got = lineWire({ ...base, position, pool }).etaS;
        expect(got, `position ${position}, pool ${pool}`).toBe(Math.ceil(owed / RTK_BUDGET_REFILL_PER_S));
        expect(got, `position ${position}, pool ${pool}: a wait is positive while tokens are owed`).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked, "cases checked").toBe(15);
  });

  it("a stay one place further back waits strictly longer, and a deeper hole (a negative pool) longer still", () => {
    const at = (position: number, pool: number) => lineWire({ ...base, position, pool }).etaS;
    expect(at(2, 0)).toBeGreaterThan(at(1, 0));
    expect(at(1, -LINE_RESERVATION)).toBeGreaterThan(at(1, 0));
  });
});

describe("pollMs: never faster than the floor, near places at the near cadence, the front stay by when the pool will hold its reservation", () => {
  it("a busy answer asks again at the floor; places 1..LINE_NEAR_POSITIONS at LINE_POLL_MS and behind them at LINE_POLL_SLOW_MS", () => {
    expect(lineWire({ ...base, position: 4, busy: true }).pollMs, "busy").toBe(LINE_POLL_MIN_MS);
    expect(lineWire({ ...base, position: 40, busy: true }).pollMs, "busy, far back").toBe(LINE_POLL_MIN_MS);
    let checked = 0;
    for (const position of [2, LINE_NEAR_POSITIONS]) {
      expect(lineWire({ ...base, position }).pollMs, `place ${position}`).toBe(LINE_POLL_MS);
      checked += 1;
    }
    for (const position of [LINE_NEAR_POSITIONS + 1, LINE_NEAR_POSITIONS + 20]) {
      expect(lineWire({ ...base, position }).pollMs, `place ${position}`).toBe(LINE_POLL_SLOW_MS);
      checked += 1;
    }
    expect(checked, "places checked").toBe(4);
  });

  it("the front stay: the time until the pool holds `need`, rounded up, clamped to [LINE_POLL_MIN_MS, LINE_POLL_MS] (every clamp side)", () => {
    const wait = (tokens: number) => Math.ceil((tokens / RTK_BUDGET_REFILL_PER_S) * 1_000);
    const front = (pool: number) => lineWire({ ...base, position: 1, pool, need: LINE_RESERVATION }).pollMs;
    expect(front(LINE_RESERVATION), "the pool already holds it: the floor, not 0").toBe(LINE_POLL_MIN_MS);
    expect(front(LINE_RESERVATION + 50), "more than holds it: the floor").toBe(LINE_POLL_MIN_MS);
    expect(front(LINE_RESERVATION - 1), "one token short: under the floor, so the floor").toBe(LINE_POLL_MIN_MS);
    // Tokens short whose wait lies strictly between the floor and the near cadence: kept exactly.
    let between = 0;
    for (let short = 1; short <= LINE_RESERVATION; short += 1) {
      const ms = wait(short);
      if (ms > LINE_POLL_MIN_MS && ms < LINE_POLL_MS) {
        expect(front(LINE_RESERVATION - short), `${short} tokens short`).toBe(ms);
        between += 1;
      }
    }
    expect(between, "anti-vacuity: at least one wait lies between the clamps").toBeGreaterThan(0);
    expect(front(0), "a long wait: the near cadence, not the wait").toBe(LINE_POLL_MS);
    expect(front(-500), "a very long wait").toBe(LINE_POLL_MS);
  });

  it("`need` is what moves the front stay's wait: a completing stay (a larger need) waits longer than a plain one at the same pool", () => {
    const plain = lineWire({ ...base, position: 1, pool: 5, need: LINE_RESERVATION });
    const completing = lineWire({ ...base, position: 1, pool: 5, need: LINE_RESERVATION + 3 });
    expect(completing.pollMs).toBeGreaterThanOrEqual(plain.pollMs);
    // A pool where the difference is visible: the plain stay is within a floor of admission, the completing one is not.
    const p = LINE_RESERVATION - 1;
    expect(lineWire({ ...base, pool: p, need: LINE_RESERVATION }).pollMs).toBe(LINE_POLL_MIN_MS);
    expect(lineWire({ ...base, pool: p, need: LINE_RESERVATION + 4 }).pollMs).toBeGreaterThan(LINE_POLL_MIN_MS);
  });

  it("the sweep: no place, pool or need ever yields a cadence under the floor or over the slow cadence (counted)", () => {
    let checked = 0;
    for (const position of [1, 2, 5, 6, 30]) {
      for (const pool of [-1_000, -1, 0, 1, 20, 21, 24, 1_000]) {
        for (const need of [LINE_RESERVATION, LINE_RESERVATION + 3]) {
          for (const busy of [false, true]) {
            const ms = lineWire({ ...base, position, pool, need, busy }).pollMs;
            expect(ms, `position ${position} pool ${pool} need ${need} busy ${busy}`).toBeGreaterThanOrEqual(LINE_POLL_MIN_MS);
            expect(ms).toBeLessThanOrEqual(LINE_POLL_SLOW_MS);
            checked += 1;
          }
        }
      }
    }
    expect(checked, "cases checked").toBe(5 * 8 * 2 * 2);
  });
});

describe("mayTimeOut: etaS + LINE_SERVE_TAIL_S greater than the seconds to closesAt (the re-review 2's M4)", () => {
  /** The answer at a clock `secondsToCap` seconds before the cap. */
  const at = (secondsToCap: number, position = 3) => lineWire({ ...base, position, pool: 0, now: new Date(CAP.getTime() - secondsToCap * 1_000) });

  it("the boundary pair: the sum EQUAL to the seconds to the cap is false, one second over is true", () => {
    const eta = at(1_000).etaS; // etaS does not depend on the clock: taken from the answer
    const sum = eta + LINE_SERVE_TAIL_S;
    expect(at(sum).mayTimeOut, "equal").toBe(false);
    expect(at(sum - 1).mayTimeOut, "one second over").toBe(true);
    expect(at(sum + 1).mayTimeOut, "one second of room").toBe(false);
  });

  it("the case where the right answer is not the wrong one's constant: etaS alone is under the cap, etaS + the tail is over", () => {
    const eta = at(1_000).etaS;
    const seconds = eta + LINE_SERVE_TAIL_S - 1;
    expect(eta, "premise: etaS alone is under the seconds to the cap").toBeLessThan(seconds);
    expect(at(seconds).mayTimeOut, "the sum is over").toBe(true);
    expect(LINE_SERVE_TAIL_S, "premise: the tail is more than the one second the case needs").toBeGreaterThan(1);
  });

  it("a stay that is first (etaS 0) is warned only inside the tail of the cap; at the cap and past it, always (the empty case)", () => {
    const first = (secondsToCap: number) => lineWire({ ...base, position: 1, pool: LINE_RESERVATION, now: new Date(CAP.getTime() - secondsToCap * 1_000) });
    expect(first(1_000).etaS, "premise: nothing to wait for").toBe(0);
    expect(first(LINE_SERVE_TAIL_S).mayTimeOut, "exactly the tail left").toBe(false);
    expect(first(LINE_SERVE_TAIL_S - 1).mayTimeOut, "less than the tail left").toBe(true);
    expect(first(0).mayTimeOut, "at the cap").toBe(true);
    expect(first(-60).mayTimeOut, "past the cap").toBe(true);
  });

  it("the tail is the slowest camera that still seats: the evidence deadline + the longest back-off, in whole seconds", () => {
    expect(Number.isInteger(LINE_SERVE_TAIL_S)).toBe(true);
    expect(LINE_SERVE_TAIL_S).toBeGreaterThan(0);
  });
});
