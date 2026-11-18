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
import { LINE_FALLBACK_READ_CALLS, LINE_RESERVATION_MAX, lineRecheckCost, lineWire as lineWireOf } from "../seat-line";
import { CHECKIN_BATCH_GAP_MS, CHECKIN_BATCH_SIZE, DEADLINE_AFTER_MS, LINE_DEADLINE_GRACE_MS, boardAnchor, boardCap } from "../window";

const ROUND = new Date("2026-10-15T10:00:00.000Z");
const ANCHOR = boardAnchor(ROUND, 0, false);
const CAP = boardCap(ANCHOR);
// A stay priced at the unpriced maximum (21), its re-verify the full read (3): the figures the hand-computed tables below were worked
// from. The per-stay STAMPED prices - and an estimate that sums them - are the second half of this file.
const L = LINE_RESERVATION_MAX;
const R = lineRecheckCost(LINE_FALLBACK_READ_CALLS);
type WireIn = Omit<Parameters<typeof lineWireOf>[0], "aheadReserved"> & { aheadReserved?: number };
/** `lineWire` with the places ahead all priced at L + R (the worst case) unless `aheadReserved` is stated. */
const lineWire = (o: WireIn) => lineWireOf({ aheadReserved: (o.position - 1) * (L + R), ...o });
const base = { position: 1, pool: 0, need: L, now: ROUND, anchor: ANCHOR, left: null } as const;

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

// ─── etaS (final review M-2) ─────────────────────────────────────────────────────────────────────────────────────────────
// The estimate is a CONSERVATIVE UPPER BOUND on the time to admission, and `mayTimeOut` rides on it, so an optimistic ETA delays the
// one sentence that tells a player they may be walked over. The rulebook (spec §5.7.9), written here from the declared constants:
//   - the stay at `position` is admitted once the pool has grown to `need` PLUS what every place ahead is promised, and the most a
//     place ahead can be promised is `L + R` (a COMPLETING stay: its seat triggers the opponent's
//     re-verify) - not `L`: that under-priced a completing stay ahead, and the player's own place was priced at the
//     plain reservation whether or not it was itself completing;
//   - the pool grows at `RTK_BUDGET_REFILL_PER_S`;
//   - admission happens at the stay's next POLL after the pool allows it (§5.7.3), up to one `pollMs` later.
// The cadence is the spec's too (the front stay by when the pool will hold `need`, clamped; near places at LINE_POLL_MS; the rest at
// LINE_POLL_SLOW_MS; busy at the floor), restated here so the trail does not come from the function under test.
const AHEAD = L + R;
const COMPLETING = L + R;
const cadenceMs = (position: number, need: number, pool: number, busy = false): number => {
  if (busy) return LINE_POLL_MIN_MS;
  if (position === 1) return Math.min(LINE_POLL_MS, Math.max(LINE_POLL_MIN_MS, Math.ceil((Math.max(0, need - pool) / RTK_BUDGET_REFILL_PER_S) * 1_000)));
  return position <= LINE_NEAR_POSITIONS ? LINE_POLL_MS : LINE_POLL_SLOW_MS;
};
/** Tokens the pool must hold before the stay at `position` can be admitted. */
const tokensToAdmit = (position: number, need: number) => (position - 1) * AHEAD + need;

describe("etaS: the time to ADMISSION - the place ahead at its worst case, the stay's own at its own need, plus a poll's trail (final review M-2)", () => {
  // Hand-computed from spec §5.7.9's own figures, NOT from a helper that retypes its formula (re-review m-4): a retyped formula
  // freezes whatever the spec text said when it was written. The premise pins the constants these numbers rest on to the spec's
  // figures (a place ahead "(24)" = 21 + 3; the front stay's cadence clamp [2 s, 3 s]; near places 1 to 5 at 3 s, behind at 5 s;
  // a refill of 2 tokens a second); if one is changed on purpose, this table is recomputed by hand, not by the formula.
  it("premise: the constants the hand-computed table rests on are the spec's figures", () => {
    expect([L, R, RTK_BUDGET_REFILL_PER_S]).toEqual([21, 3, 2]);
    expect(L + R, "the spec's priced place ahead: 24").toBe(24);
    expect([LINE_POLL_MIN_MS, LINE_POLL_MS, LINE_POLL_SLOW_MS, LINE_NEAR_POSITIONS]).toEqual([2_000, 3_000, 5_000, 5]);
  });

  it("the table, worked by hand (tokens to admit = places ahead x 24 + own need; seconds = (tokens - pool) / 2 + the poll; rounded up)", () => {
    // [label, position, need, pool, busy, etaS, working]
    const table: [string, number, number, number, boolean, number, string][] = [
      ["the spec's case: completing at the front, pool 22 (was told 0 s)", 1, 24, 22, false, 3, "short 24-22 = 2 -> 1 s; front cadence = 1 s clamped up to 2 s; 1 + 2 = 3"],
      ["front, plain, dry pool", 1, 21, 0, false, 14, "short 21 -> 10.5 s; cadence clamped down to 3 s; 13.5 -> 14"],
      ["front, pool exactly covers", 1, 21, 21, false, 2, "short 0; cadence floor 2 s; 0 + 2 = 2 (never 0)"],
      ["front, one token short", 1, 21, 20, false, 3, "short 1 -> 0.5 s; cadence floor 2 s; 2.5 -> 3"],
      ["second place, dry pool", 2, 21, 0, false, 26, "24 + 21 = 45 -> 22.5 s; near cadence 3 s; 25.5 -> 26"],
      ["the last near place (5)", 5, 21, 0, false, 62, "4 x 24 + 21 = 117 -> 58.5 s; near cadence 3 s; 61.5 -> 62"],
      ["the first slow place (6)", 6, 21, 0, false, 76, "5 x 24 + 21 = 141 -> 70.5 s; slow cadence 5 s; 75.5 -> 76"],
      ["a completing stay at place 3 and a pool in the hole", 3, 24, -6, false, 42, "2 x 24 + 24 = 72; 72 + 6 = 78 -> 39 s; near cadence 3 s; 42"],
      ["busy answer at the front: the floor is the trail", 1, 21, 0, true, 13, "10.5 s; busy cadence 2 s; 12.5 -> 13"],
      ["a pool far past the place: only the trail of a slow place", 7, 21, 1_000, false, 5, "short < 0 -> 0 s; slow cadence 5 s; 5"],
    ];
    let checked = 0;
    for (const [label, position, need, pool, busy, want, working] of table) {
      expect(lineWire({ ...base, position, need, pool, busy }).etaS, `${label} (${working})`).toBe(want);
      checked += 1;
    }
    expect(checked, "rows checked").toBe(table.length);
    expect(table.length, "anti-vacuity: the table is not empty").toBeGreaterThanOrEqual(10);
  });

  it("the empty case first: a pool that already covers the place leaves only the poll's trail, never 0 (the stay is admitted at its NEXT poll)", () => {
    for (const pool of [L, 10 * L]) {
      const got = lineWire({ ...base, position: 1, pool }).etaS;
      expect(got, `pool ${pool}: the front stay's cadence floor, 2 s, and nothing else`).toBe(2);
      expect(got, "a held stay is never told it is admitted now").toBeGreaterThan(0);
    }
  });

  it("the case that was wrong: a COMPLETING stay at the front with a pool one token past the plain reservation was told 0 s and is held until the pool reaches its own need", () => {
    const pool = L + 1;
    const need = COMPLETING;
    expect(pool, "premise: the plain reservation is covered, the completing need is not").toBeLessThan(need);
    const got = lineWire({ ...base, position: 1, pool, need }).etaS;
    const waitS = (need - pool) / RTK_BUDGET_REFILL_PER_S;
    expect(waitS, "premise: a real wait for the pool").toBeGreaterThan(0);
    expect(got, "at least the wait for the pool").toBeGreaterThanOrEqual(Math.ceil(waitS));
    expect(got, "the wait for the pool (2 tokens at 2 a second: 1 s) and the poll that admits it (the 2 s floor), by hand").toBe(3);
    // The wrong answer's constant: the old formula (position x L - pool) said 0 here.
    expect(Math.max(0, 1 * L - pool), "premise: the old pricing said 0 s").toBe(0);
    expect(got).toBeGreaterThan(0);
  });

  it("the boundary pair: the pool one token short of the stay's need waits strictly longer than the pool exactly at it, by the refill of that token", () => {
    const at = (pool: number) => lineWire({ ...base, position: 1, pool, need: L }).etaS;
    const exact = at(L);
    const short = at(L - 1);
    expect(exact, "covered: only the 2 s floor of the poll").toBe(2);
    expect(short, "one token short: 0.5 s of refill and the 2 s floor, 2.5 rounded up").toBe(3);
    expect(short, "one token short is not the same as covered").toBeGreaterThan(exact);
  });

  it("a place ahead is priced at L + R: one place further back adds exactly that many tokens of refill", () => {
    // Both at the near cadence and a dry pool, so the poll's trail is the same and only the price of the place moves the answer.
    const one = lineWire({ ...base, position: 1, pool: 0 }).etaS;
    const two = lineWire({ ...base, position: 2, pool: 0 }).etaS;
    expect(cadenceMs(1, L, 0), "premise: same cadence at both places").toBe(cadenceMs(2, L, 0));
    expect(two - one).toBe(AHEAD / RTK_BUDGET_REFILL_PER_S);
    expect(AHEAD, "premise: the ahead price is more than the plain reservation").toBeGreaterThan(L);
  });

  it("is an upper bound by the rulebook: at the refill rate the pool reaches what the place is promised no later than etaS, and etaS holds the poll's trail (swept, counted; the exact numbers are the hand-computed table above)", () => {
    let checked = 0;
    for (const position of [1, 2, 3, 7]) {
      for (const need of [L, COMPLETING]) {
        for (const pool of [-30, 0, 1, 20, 21, 22, 24, 50, 1_000]) {
          for (const busy of [false, true]) {
            const got = lineWire({ ...base, position, pool, need, busy }).etaS;
            const label = `position ${position} need ${need} pool ${pool} busy ${busy}`;
            expect(got, `${label}: the pool has grown to what is promised`).toBeGreaterThanOrEqual(Math.ceil((tokensToAdmit(position, need) - pool) / RTK_BUDGET_REFILL_PER_S));
            expect(got, `${label}: at least the poll's trail`).toBeGreaterThanOrEqual(Math.ceil(cadenceMs(position, need, pool, busy) / 1_000));
            checked += 1;
          }
        }
      }
    }
    expect(checked, "cases checked").toBe(4 * 2 * 9 * 2);
  });

  it("a stay one place further back waits strictly longer, and a deeper hole (a negative pool) longer still", () => {
    const at = (position: number, pool: number) => lineWire({ ...base, position, pool }).etaS;
    expect(at(2, 0)).toBeGreaterThan(at(1, 0));
    expect(at(1, -L)).toBeGreaterThan(at(1, 0));
  });

  it("the estimate is a whole number of seconds and never negative, whatever the pool", () => {
    let checked = 0;
    for (const pool of [-1_000, -1, 0, 1, 1_000]) {
      const got = lineWire({ ...base, position: 3, pool }).etaS;
      expect(Number.isInteger(got) && got >= 0, `pool ${pool}`).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(5);
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
    const front = (pool: number) => lineWire({ ...base, position: 1, pool, need: L }).pollMs;
    expect(front(L), "the pool already holds it: the floor, not 0").toBe(LINE_POLL_MIN_MS);
    expect(front(L + 50), "more than holds it: the floor").toBe(LINE_POLL_MIN_MS);
    expect(front(L - 1), "one token short: under the floor, so the floor").toBe(LINE_POLL_MIN_MS);
    // Tokens short whose wait lies strictly between the floor and the near cadence: kept exactly.
    let between = 0;
    for (let short = 1; short <= L; short += 1) {
      const ms = wait(short);
      if (ms > LINE_POLL_MIN_MS && ms < LINE_POLL_MS) {
        expect(front(L - short), `${short} tokens short`).toBe(ms);
        between += 1;
      }
    }
    expect(between, "anti-vacuity: at least one wait lies between the clamps").toBeGreaterThan(0);
    expect(front(0), "a long wait: the near cadence, not the wait").toBe(LINE_POLL_MS);
    expect(front(-500), "a very long wait").toBe(LINE_POLL_MS);
  });

  it("`need` is what moves the front stay's wait: a completing stay (a larger need) waits longer than a plain one at the same pool", () => {
    const plain = lineWire({ ...base, position: 1, pool: 5, need: L });
    const completing = lineWire({ ...base, position: 1, pool: 5, need: L + 3 });
    expect(completing.pollMs).toBeGreaterThanOrEqual(plain.pollMs);
    // A pool where the difference is visible: the plain stay is within a floor of admission, the completing one is not.
    const p = L - 1;
    expect(lineWire({ ...base, pool: p, need: L }).pollMs).toBe(LINE_POLL_MIN_MS);
    expect(lineWire({ ...base, pool: p, need: L + 4 }).pollMs).toBeGreaterThan(LINE_POLL_MIN_MS);
  });

  it("the sweep: no place, pool or need ever yields a cadence under the floor or over the slow cadence (counted)", () => {
    let checked = 0;
    for (const position of [1, 2, 5, 6, 30]) {
      for (const pool of [-1_000, -1, 0, 1, 20, 21, 24, 1_000]) {
        for (const need of [L, L + 3]) {
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

  it("a stay whose pool already covers it (etaS is only the poll's trail) is warned only inside the trail plus the tail of the cap; at the cap and past it, always (the empty case)", () => {
    const first = (secondsToCap: number) => lineWire({ ...base, position: 1, pool: L, now: new Date(CAP.getTime() - secondsToCap * 1_000) });
    const eta = first(1_000).etaS;
    expect(eta, "premise: nothing to wait for but the next poll").toBe(Math.ceil(cadenceMs(1, L, L) / 1_000));
    expect(first(eta + LINE_SERVE_TAIL_S).mayTimeOut, "exactly the trail and the tail left").toBe(false);
    expect(first(eta + LINE_SERVE_TAIL_S - 1).mayTimeOut, "less than the trail and the tail left").toBe(true);
    expect(first(0).mayTimeOut, "at the cap").toBe(true);
    expect(first(-60).mayTimeOut, "past the cap").toBe(true);
  });

  it("the warning fires in time for the case the old ETA under-priced: a completing stay at the front with a pool one token past the plain reservation", () => {
    const pool = L + 1;
    const need = COMPLETING;
    const answer = (secondsToCap: number) => lineWire({ ...base, position: 1, pool, need, now: new Date(CAP.getTime() - secondsToCap * 1_000) });
    const eta = answer(1_000).etaS;
    // The wait that really lies ahead is longer than the old pricing's 0 s: with the old ETA the stay was NOT warned here.
    expect(eta + LINE_SERVE_TAIL_S, "premise: more than the tail alone").toBeGreaterThan(LINE_SERVE_TAIL_S);
    const seconds = eta + LINE_SERVE_TAIL_S - 1;
    expect(seconds, "premise: the tail alone would fit inside the time left").toBeGreaterThanOrEqual(LINE_SERVE_TAIL_S);
    expect(answer(seconds).mayTimeOut, "warned").toBe(true);
  });

  it("the tail is the slowest camera that still seats: the evidence deadline + the longest back-off, in whole seconds", () => {
    expect(Number.isInteger(LINE_SERVE_TAIL_S)).toBe(true);
    expect(LINE_SERVE_TAIL_S).toBeGreaterThan(0);
  });
});

// ─── The estimate sums the STAMPED prices of the places ahead (plan 2 Task 7) ─────────────────────────────────────────────────
// `aheadReserved` is what every waiting stay ahead is promised: each at its OWN stamped price plus its stamped re-verify, the worst
// case. The place's own price is `need`. Hand-worked from the price table (flag on: all 9, room 8; flag off: all 21), not from the function.
describe("etaS follows aheadReserved, not the count of places ahead (the stamped price)", () => {
  // tokens to admit = aheadReserved + need; seconds = (tokens - pool) / 2 + the near cadence's 3 s; rounded up.
  it("three places ahead stamped 9 (all, flag on), 8 (room, flag on) and 21 (all, flag off), each with its re-verify: (9+1)+(8+1)+(21+3) = 43; a 8-priced fourth place on a pool of 4 waits (43+8-4)/2 + 3 = 26.5 -> 27", () => {
    const got = lineWireOf({ position: 4, aheadReserved: 10 + 9 + 24, pool: 4, need: 8, now: ROUND, anchor: ANCHOR, left: null });
    expect(got.etaS).toBe(27);
    expect(got.pollMs, "premise: the near cadence the hand count used").toBe(LINE_POLL_MS);
    // The pricing this replaces counted places: 3 x (21 + 3) + the stay's own 21 - 4 = 89 tokens -> 44.5 + 3 -> 48. A cheaper pricing
    // of every place (3 x 9 + 8 - 4 = 31) says 19. The stamped sum is neither.
    expect(Math.ceil((3 * 24 + 21 - 4) / 2 + 3), "premise: the place-count pricing says 48").toBe(48);
    expect(Math.ceil((3 * 9 + 8 - 4) / 2 + 3), "premise: the cheapest-everywhere pricing says 19").toBe(19);
  });

  it("the same position with a different sum is a different estimate, and the same sum at another position is the same (the position decides only the cadence)", () => {
    const at = (position: number, aheadReserved: number) => lineWireOf({ position, aheadReserved, pool: 0, need: 8, now: ROUND, anchor: ANCHOR, left: null }).etaS;
    // positions 2 and 3 share the near cadence (3 s): only the sum moves the answer.
    expect(at(2, 10), "(10 + 8) / 2 + 3 = 12").toBe(12);
    expect(at(2, 24), "(24 + 8) / 2 + 3 = 19").toBe(19);
    expect(at(3, 24), "the same sum at another near place: the same answer").toBe(at(2, 24));
    expect(at(2, 24)).toBeGreaterThan(at(2, 10));
  });

  it("the front place has nothing ahead: aheadReserved 0, and its own need alone sets the wait (the empty case)", () => {
    // need 8, pool 0: 8 / 2 = 4 s; the front cadence clamps (8 / 2 = 4 s -> 3 s, the near cadence); 4 + 3 = 7.
    expect(lineWireOf({ position: 1, aheadReserved: 0, pool: 0, need: 8, now: ROUND, anchor: ANCHOR, left: null }).etaS).toBe(7);
  });
});
