// W5 app PR B Task 3 (FX-G1 parity close; X-CU-1..5, X-RR-5): PR A wrote the late-entry catch-up rule and the line key app-side,
// in the engine's own field names, so this file is a direct compare - the app's `catchUpSet` against the engine's
// `lateEntryFixtures`, the app's `rrKey` against the engine's `roundRobinLineKey` - over the same lines and byes. Then the
// delegation itself: the app's functions CALL the engine's (an engine-only refusal surfaces by its reason name).
//
// Oracles: the ENGINE's functions (the parity) and the rulebook's hand derivations typed as literals (the named scenes, RB5-L3/L6/
// L16 over `generateRoundRobin`'s own schedule) - never the code under test. Every sweep counts what it checked.
//
// differential (the delegation describe): today (178b1b7805) neither module imports the engine - the spies see no call, and a line
// after the last drawn round is refused with the app's own words, no reason name.
import { describe, expect, it, vi } from "vitest";

/** The engine seam, pass-through, counting calls - the delegation tests read whether the app called the engine. */
const engineCalls = vi.hoisted(() => ({ lateEntryFixtures: 0, roundRobinLineKey: 0 }));
vi.mock("@seazn/engine/scheduling", async (io) => {
  const real = await io<typeof import("@seazn/engine/scheduling")>();
  return {
    ...real,
    lateEntryFixtures: (...args: Parameters<typeof real.lateEntryFixtures>) => {
      engineCalls.lateEntryFixtures++;
      return real.lateEntryFixtures(...args);
    },
    roundRobinLineKey: (...args: Parameters<typeof real.roundRobinLineKey>) => {
      engineCalls.roundRobinLineKey++;
      return real.roundRobinLineKey(...args);
    },
  };
});

import fc from "fast-check";
import { EngineError } from "@seazn/engine/core";
import { generateRoundRobin, lateEntryFixtures, roundRobinLineKey } from "@seazn/engine/scheduling";
import { CatchUpInputError, catchUpSet, decideRoundRobinLateEntry, type ByeSlot, type CatchUpFixture, type ExistingLine } from "../roundrobin-late-entry";
import { RR_MAX_LEG, RrKeyError, rrKey } from "../roundrobin-reconcile";

/** A round robin of `entrants` as the catch-up rule reads it: its lines, its byes (started through round `startedThrough`). */
function scene(entrants: readonly string[], legs: number, startedThrough: number) {
  const s = generateRoundRobin({ entrants: [...entrants], config: { legs } });
  const lines: ExistingLine[] = s.fixtures.map((f) => ({ home: f.home, away: f.away, roundNo: f.roundNo, leg: f.leg }));
  const byes: ByeSlot[] = s.rounds.flatMap((r) =>
    r.bye === undefined ? [] : [{ entrantId: r.bye, roundNo: r.roundNo, leg: r.leg, started: r.roundNo <= startedThrough }],
  );
  const lastRoundNo = Math.max(...s.rounds.map((r) => r.roundNo));
  return { lines, byes, lastRoundNo, rounds: s.rounds };
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${String(i).padStart(2, "0")}`);
/** "who:kind:round" per fixture, in placement order. */
const placed = (fixtures: readonly CatchUpFixture[], newcomer: string) =>
  fixtures.map((f) => `${f.home === newcomer ? f.away : f.home}:${f.placement.kind}:${f.placement.roundNo}`);

/** The engine's answer, or its refusal reason. */
function engineOf(input: Parameters<typeof lateEntryFixtures>[0]) {
  try {
    return lateEntryFixtures(input);
  } catch (e) {
    if (EngineError.is(e)) return { refused: (e.data as { reason?: string } | undefined)?.reason };
    throw e;
  }
}

describe("X-RR-5 the line key: rrKey's pair-and-leg part is the engine's roundRobinLineKey", () => {
  it("X-RR-5 every pair the generator draws (n 2..12, legs 1..3) keys the same, pooled or not", () => {
    let checked = 0;
    for (let n = 2; n <= 12; n++) {
      for (let legs = 1; legs <= 3; legs++) {
        for (const l of scene(ids(n), legs, 0).lines) {
          const engine = roundRobinLineKey(l.home, l.away, l.leg);
          expect(rrKey(l.home, l.away, l.leg, null), `${n}x${legs}`).toBe(engine);
          expect(rrKey(l.home, l.away, l.leg, "P"), `${n}x${legs} pooled`).toBe(`P|${engine}`);
          checked++;
        }
      }
    }
    // n(n-1)/2 lines per leg, legs 1..3 (6 per n): sum over n 2..12 of 6 * n(n-1)/2.
    expect(checked, "anti-vacuity").toBe(Array.from({ length: 11 }, (_, i) => i + 2).reduce((s, n) => s + 6 * ((n * (n - 1)) / 2), 0));
  });

  it("X-RR-5 property: any two ids and any leg the app accepts key the same; what either refuses, both refuse", () => {
    let agreed = 0;
    let refused = 0;
    const id = fc.string({ minLength: 0, maxLength: 6 });
    fc.assert(
      fc.property(id, id, fc.integer({ min: -1, max: RR_MAX_LEG }), (a, b, leg) => {
        let app: string | "refused";
        let engine: string | "refused";
        try {
          app = rrKey(a, b, leg, null);
        } catch (e) {
          expect(e).toBeInstanceOf(RrKeyError);
          app = "refused";
        }
        try {
          engine = roundRobinLineKey(a, b, leg);
        } catch (e) {
          expect(EngineError.is(e) && (e.data as { reason?: string }).reason).toBe("line_key_invalid");
          engine = "refused";
        }
        expect(app).toBe(engine);
        if (app === "refused") refused++;
        else agreed++;
      }),
      { numRuns: 500, seed: 20261120 },
    );
    expect(agreed, "anti-vacuity: keys compared").toBeGreaterThan(0);
    expect(refused, "anti-vacuity: refusals compared").toBeGreaterThan(0);
  });
});

describe("X-CU-1 the catch-up set: the app's equals the engine's lateEntryFixtures", () => {
  it("X-CU-1 every field n 2..12, legs 1..3, every started-round prefix k 0..rounds: fixtures, placements, home sides, byes, rounds", () => {
    let checked = 0;
    for (let n = 2; n <= 12; n++) {
      for (let legs = 1; legs <= 3; legs++) {
        const members = ids(n);
        const rounds = scene(members, legs, 0).lastRoundNo;
        for (let k = 0; k <= rounds; k++) {
          const s = scene(members, legs, k);
          const input = { members, newcomer: "new", legs, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo };
          expect(catchUpSet(input), `${n}x${legs} k=${k}`).toEqual(engineOf(input));
          checked++;
        }
      }
    }
    // Rounds per leg: n - 1 for an even field, n for an odd one; k runs 0..rounds, so (rounds + 1) cases per (n, legs).
    const expected = Array.from({ length: 11 }, (_, i) => i + 2).reduce((sum, n) => sum + [1, 2, 3].reduce((t, legs) => t + (n % 2 === 0 ? n - 1 : n) * legs + 1, 0), 0);
    expect(checked, "anti-vacuity: every (n, legs, k)").toBe(expected);
  });

  it("X-CU-1 the odd-n late cases (n 3..23 odd x legs 1..3 = 33), nothing started: every owed fixture on a bye, app = engine", () => {
    let checked = 0;
    for (let n = 3; n <= 23; n += 2) {
      for (const legs of [1, 2, 3]) {
        const members = ids(n);
        const s = scene(members, legs, 0);
        const input = { members, newcomer: "new", legs, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo };
        const engine = lateEntryFixtures(input);
        expect(catchUpSet(input), `${n}x${legs}`).toEqual(engine);
        // RB5-L3: every member holds one unstarted bye per leg, so nothing is appended.
        expect([engine.consumedByes.length, engine.appendedRounds], `${n}x${legs}`).toEqual([n * legs, 0]);
        checked++;
      }
    }
    expect(checked, "11 odd sizes x 3 leg counts").toBe(33);
  });

  it("X-CU-1 property: any listed (seed) order of the members and any set of started byes - app = engine", () => {
    let compared = 0;
    fc.assert(
      fc.property(
        fc
          .integer({ min: 2, max: 12 })
          .chain((n) => fc.tuple(fc.shuffledSubarray(ids(n), { minLength: n, maxLength: n }), fc.integer({ min: 1, max: 3 }), fc.array(fc.boolean(), { maxLength: 40 }))),
        ([members, legs, startedFlags]) => {
          // The schedule is drawn in id order; the members are LISTED in a shuffled (seed) order (F5: seed order need not be id order).
          const s = scene([...members].sort(), legs, 0);
          const byes = s.byes.map((b, i) => ({ ...b, started: startedFlags[i] === true }));
          const input = { members, newcomer: "new", legs, lines: s.lines, byes, lastRoundNo: s.lastRoundNo };
          expect(catchUpSet(input)).toEqual(engineOf(input));
          compared++;
        },
      ),
      { numRuns: 300, seed: 20261120 },
    );
    expect(compared, "anti-vacuity").toBe(300);
  });

  it("X-CU-1 a started bye is not taken, and the empty case: the engine's nothing_to_add is the app's RR_LATE_ENTRY_NOTHING_TO_ADD", () => {
    const s = scene(["a", "b", "c", "d", "e"], 1, 2);
    const set = catchUpSet({ members: ["a", "b", "c", "d", "e"], newcomer: "f", legs: 1, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo });
    // e's bye (r1) and d's (r2) are started (RB5-L4): never consumed.
    expect(set.consumedByes.map((b) => b.entrantId)).not.toContain("e");
    expect(set.consumedByes.map((b) => b.entrantId)).not.toContain("d");
    let checked = 0;
    // The empty case, both ways it arises: no members; a newcomer already seated against every member.
    const seated = scene(["a", "b", "c", "d", "e", "f"], 1, 2);
    for (const input of [
      { members: [] as string[], newcomer: "n", legs: 1, lines: [] as ExistingLine[], byes: [] as ByeSlot[], lastRoundNo: 0 },
      { members: ["a", "b", "c", "d", "e"], newcomer: "f", legs: 1, lines: seated.lines, byes: [] as ByeSlot[], lastRoundNo: seated.lastRoundNo },
    ]) {
      expect(engineOf(input), "the engine refuses by name").toEqual({ refused: "nothing_to_add" });
      expect(decideRoundRobinLateEntry({ stageComplete: false, stageStarted: true, ...input })).toEqual({ case: "refused", code: "RR_LATE_ENTRY_NOTHING_TO_ADD" });
      expect(decideRoundRobinLateEntry({ stageComplete: false, stageStarted: false, ...input }), "before Start too").toEqual({ case: "refused", code: "RR_LATE_ENTRY_NOTHING_TO_ADD" });
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("X-CU-2..5 the named scenes (rulebook literals; the engine's set must equal the app's)", () => {
  const FIVE = ["a", "b", "c", "d", "e"];

  it("X-CU-2 the five-field byes: bye slots c r3, b r4, a r5 (rounds 1-2 started, newcomer f)", () => {
    const s = scene(FIVE, 1, 2);
    expect(s.rounds.map((r) => `${r.roundNo}${r.bye}`), "premise: the engine's own byes").toEqual(["1e", "2d", "3c", "4b", "5a"]);
    const input = { members: FIVE, newcomer: "f", legs: 1, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo };
    for (const set of [lateEntryFixtures(input), catchUpSet(input)]) {
      expect(placed(set.fixtures, "f").slice(0, 3)).toEqual(["c:bye_slot:3", "b:bye_slot:4", "a:bye_slot:5"]);
      expect(set.consumedByes.map((b) => `${b.entrantId}${b.roundNo}`)).toEqual(["c3", "b4", "a5"]);
    }
  });

  it("X-CU-3 appended rounds: d r6, e r7; a..f owes 6 at rounds 6-11 in listed order; members listed [d, a, c, b] -> d, a, c, b", () => {
    const five = scene(FIVE, 1, 2);
    const fiveIn = { members: FIVE, newcomer: "f", legs: 1, lines: five.lines, byes: five.byes, lastRoundNo: five.lastRoundNo };
    for (const set of [lateEntryFixtures(fiveIn), catchUpSet(fiveIn)]) {
      expect(placed(set.fixtures, "f").slice(3)).toEqual(["d:catch_up_round:6", "e:catch_up_round:7"]);
      expect(set.appendedRounds).toBe(2);
    }
    const six = ["a", "b", "c", "d", "e", "f"];
    const even = scene(six, 1, 3);
    const evenIn = { members: six, newcomer: "g", legs: 1, lines: even.lines, byes: even.byes, lastRoundNo: even.lastRoundNo };
    for (const set of [lateEntryFixtures(evenIn), catchUpSet(evenIn)]) {
      expect(placed(set.fixtures, "g")).toEqual(six.map((m, i) => `${m}:catch_up_round:${6 + i}`));
    }
    const listed = ["d", "a", "c", "b"];
    const seeded = scene(listed, 1, 1);
    // B1 review m-6 (K14): the order rule is leg -> the opponent's EARLIEST round already played (RB5-L6) -> listed (seed) order
    // (the engine's declaration, catch-up.ts header: "F5, designer's call"). Listed order decides here ONLY because the first
    // key ties: a 4-field has no bye, so every member plays round 1 - asserted from the engine's own schedule, not assumed.
    const earliestOf = (lines: readonly ExistingLine[], m: string) => Math.min(...lines.filter((l) => l.home === m || l.away === m).map((l) => l.roundNo));
    expect(listed.map((m) => earliestOf(seeded.lines, m)), "premise: every member's earliest round is 1, so RB5-L6 ties").toEqual([1, 1, 1, 1]);
    const seededIn = { members: listed, newcomer: "n", legs: 1, lines: seeded.lines, byes: seeded.byes, lastRoundNo: seeded.lastRoundNo };
    for (const set of [lateEntryFixtures(seededIn), catchUpSet(seededIn)]) {
      expect(placed(set.fixtures, "n")).toEqual(["d:catch_up_round:4", "a:catch_up_round:5", "c:catch_up_round:6", "b:catch_up_round:7"]);
    }
  });

  it("X-CU-3 RB5-L6 before listed order: an opponent who first played later is owed later, even when listed first", () => {
    // The five-field's own schedule (byes 1e 2d 3c 4b 5a), every round started so no bye slot is free: all five are appended.
    // The members are handed in REVERSE (e listed first), so the two keys disagree on e: listed order alone would owe e first;
    // RB5-L6 owes the four who played round 1 first (in listed order d, c, b, a) and e - whose first match was round 2 - last.
    // differential: a listed-order-only rule gives e:6, d:7, c:8, b:9, a:10.
    const s = scene(FIVE, 1, 5);
    expect(s.rounds.map((r) => `${r.roundNo}${r.bye}`), "premise: the engine's own byes").toEqual(["1e", "2d", "3c", "4b", "5a"]);
    expect(s.byes.every((b) => b.started), "premise: no unstarted bye slot, so every owed fixture is appended").toBe(true);
    const reversed = ["e", "d", "c", "b", "a"];
    const earliestOf = (m: string) => Math.min(...s.lines.filter((l) => l.home === m || l.away === m).map((l) => l.roundNo));
    expect(reversed.map(earliestOf), "premise: e first played in round 2, the rest in round 1").toEqual([2, 1, 1, 1, 1]);
    const input = { members: reversed, newcomer: "f", legs: 1, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo };
    for (const set of [lateEntryFixtures(input), catchUpSet(input)]) {
      expect(placed(set.fixtures, "f")).toEqual(["d:catch_up_round:6", "c:catch_up_round:7", "b:catch_up_round:8", "a:catch_up_round:9", "e:catch_up_round:10"]);
    }
  });

  it("X-CU-4 the engine's set never rewrites a line: no returned key is present, every appended round is after the last, every bye_slot is a byes entry", () => {
    let fixtures = 0;
    for (let n = 2; n <= 12; n++) {
      for (let legs = 1; legs <= 3; legs++) {
        const members = ids(n);
        const s = scene(members, legs, Math.floor(n / 2));
        const set = catchUpSet({ members, newcomer: "new", legs, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo });
        const present = new Set(s.lines.map((l) => roundRobinLineKey(l.home, l.away, l.leg)));
        for (const f of set.fixtures) {
          expect(present.has(roundRobinLineKey(f.home, f.away, f.leg)), `${n}x${legs}: a new line`).toBe(false);
          if (f.placement.kind === "catch_up_round") expect(f.placement.roundNo, `${n}x${legs}`).toBeGreaterThan(s.lastRoundNo);
          else {
            const member = f.home === "new" ? f.away : f.home;
            expect(s.byes.some((b) => b.entrantId === member && b.roundNo === f.placement.roundNo && b.leg === f.leg && !b.started), `${n}x${legs}: an unstarted bye`).toBe(true);
          }
          fixtures++;
        }
      }
    }
    expect(fixtures, "anti-vacuity: every owed fixture of every field").toBe(Array.from({ length: 11 }, (_, i) => i + 2).reduce((s, n) => s + 6 * n, 0));
  });

  it("X-CU-5 two late entrants owe each other: the second owes the first, the first asked again owes nothing", () => {
    const s = scene(FIVE, 1, 2);
    const first = catchUpSet({ members: FIVE, newcomer: "f", legs: 1, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo });
    const lines = [...s.lines, ...first.fixtures.map((f) => ({ home: f.home, away: f.away, roundNo: f.placement.roundNo, leg: f.leg }))];
    const byes = s.byes.filter((b) => !first.consumedByes.includes(b));
    const last = Math.max(...lines.map((l) => l.roundNo));
    const secondIn = { members: [...FIVE, "f"], newcomer: "g", legs: 1, lines, byes, lastRoundNo: last };
    const second = catchUpSet(secondIn);
    expect(second).toEqual(lateEntryFixtures(secondIn));
    expect(placed(second.fixtures, "g"), "g owes f").toContain(`f:catch_up_round:${last + 6}`);
    expect(second.fixtures).toHaveLength(6);
    expect(engineOf({ members: FIVE, newcomer: "f", legs: 1, lines, byes, lastRoundNo: last })).toEqual({ refused: "nothing_to_add" });
  });

  it("two legs: leg 1 before leg 2 for every member, each pair's side flips - app = engine", () => {
    const members = ["a", "b", "c", "d"];
    const s = scene(members, 2, 1);
    const input = { members, newcomer: "n", legs: 2, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo };
    const set = catchUpSet(input);
    expect(set).toEqual(lateEntryFixtures(input));
    expect(set.fixtures.map((f) => f.leg)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    for (const m of members) {
      const [l1, l2] = [1, 2].map((leg) => set.fixtures.find((f) => f.leg === leg && (f.home === m || f.away === m))!);
      expect(l1!.home === "n", `${m}: the side flips`).toBe(l2!.away === "n");
    }
  });
});

describe("FX-G1 the delegation: the app's functions call the engine's", () => {
  it("catchUpSet is lateEntryFixtures: the engine is called, and its answer is the app's", () => {
    const s = scene(["a", "b", "c", "d", "e"], 1, 2);
    const input = { members: ["a", "b", "c", "d", "e"], newcomer: "f", legs: 1, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo };
    const before = engineCalls.lateEntryFixtures;
    const app = catchUpSet(input);
    expect(engineCalls.lateEntryFixtures - before, "the app asked the engine").toBe(1);
    expect(app).toEqual(lateEntryFixtures(input));
  });

  it("an engine-only refusal surfaces by its name: a line after the last drawn round is last_round_below_lines", () => {
    const base = { members: ["a"], newcomer: "n", legs: 1, lines: [] as ExistingLine[], byes: [] as ByeSlot[], lastRoundNo: 1 };
    for (const input of [
      { ...base, lines: [{ home: "a", away: "b", roundNo: 2, leg: 1 }] },
      { ...base, byes: [{ entrantId: "a", roundNo: 3, leg: 1, started: false }] },
    ]) {
      expect(engineOf(input)).toEqual({ refused: "last_round_below_lines" });
      expect(() => catchUpSet(input)).toThrow(CatchUpInputError);
      expect(() => catchUpSet(input)).toThrow(/last_round_below_lines/);
    }
    // And the other guards by the engine's names (a programming error, still the app's CatchUpInputError).
    expect(() => catchUpSet({ ...base, members: ["a", "n"] })).toThrow(/newcomer_is_member/);
    expect(() => catchUpSet({ ...base, legs: 0 })).toThrow(/legs_invalid/);
  });

  it("rrKey's pair-and-leg part is roundRobinLineKey: the engine is called, and its refusal is named line_key_invalid", () => {
    const before = engineCalls.roundRobinLineKey;
    expect(rrKey("b", "a", 2, "P")).toBe(`P|${roundRobinLineKey("a", "b", 2)}`);
    expect(engineCalls.roundRobinLineKey - before, "rrKey asked the engine (and the oracle once)").toBe(2);
    for (const [a, b] of [["a", "a"], ["", "b"], ["a:x", "b"]] as const) {
      expect(() => rrKey(a, b, 1, null), `${a}/${b}`).toThrow(RrKeyError);
      expect(() => rrKey(a, b, 1, null), `${a}/${b}`).toThrow(/line_key_invalid/);
    }
    // The app's own bounds stay app-side: a leg past RR_MAX_LEG and a bad pool (the engine has neither).
    expect(() => rrKey("a", "b", RR_MAX_LEG + 1, null)).toThrow(RrKeyError);
    expect(() => rrKey("a", "b", 1, "p|q")).toThrow(RrKeyError);
  });
});
