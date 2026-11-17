// W5 app PR A, Task 5 (X-CU-4, X-CU-7, X-CU-11; RB5-L3, L4, L6, L7, L8, L9, L15, L16, RB5-E9) — the pure catch-up rule, the case
// decision and the pool picker.
//
// Expected values: every scene's lines and byes are `generateRoundRobin(...)` (its `fixtures[].leg`, its `rounds[].bye`), and every
// expected placement is the brief's hand derivation from RB5-L3/L6 over that schedule (typed as literals, never read back from the
// code under test). Each sweep counts what it checked (TEST-STRATEGY: zero checked is a failure).
import { describe, expect, it } from "vitest";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import {
  CatchUpInputError,
  catchUpSet,
  choosePool,
  decideRoundRobinLateEntry,
  isCatchUpExtKey,
  rrCatchUpExtKey,
  type ByeSlot,
  type CatchUpFixture,
  type ExistingLine,
} from "../roundrobin-late-entry";
import { isRrExtKey, rrLegOfExtKey } from "../roundrobin-reconcile";

/** A round robin of `entrants` as the catch-up rule reads it: its lines, its byes (started through round `startedThrough`). */
function scene(entrants: string[], legs: number, startedThrough: number) {
  const s = generateRoundRobin({ entrants, config: { legs } });
  const lines: ExistingLine[] = s.fixtures.map((f) => ({ home: f.home, away: f.away, roundNo: f.roundNo, leg: f.leg }));
  const byes: ByeSlot[] = s.rounds.flatMap((r) =>
    r.bye === undefined ? [] : [{ entrantId: r.bye, roundNo: r.roundNo, leg: r.leg, started: r.roundNo <= startedThrough }],
  );
  const lastRoundNo = Math.max(...s.rounds.map((r) => r.roundNo));
  return { lines, byes, lastRoundNo, rounds: s.rounds };
}

/** "who:kind:round" per fixture, in placement order: the newcomer's opponent, the placement and its round. */
const placed = (fixtures: readonly CatchUpFixture[], newcomer: string) =>
  fixtures.map((f) => `${f.home === newcomer ? f.away : f.home}:${f.placement.kind}:${f.placement.roundNo}`);

describe("catchUpSet / decideRoundRobinLateEntry — the empty cases first (RB5-E9, RB5-L8)", () => {
  it("no members: nothing owed is the named refusal, never an empty success", () => {
    expect(catchUpSet({ members: [], newcomer: "n", legs: 1, lines: [], byes: [], lastRoundNo: 0 })).toEqual({ fixtures: [], consumedByes: [], appendedRounds: 0 });
    expect(decideRoundRobinLateEntry({ stageComplete: false, stageStarted: true, members: [], newcomer: "n", legs: 1, lines: [], byes: [], lastRoundNo: 0 })).toEqual({
      case: "refused",
      code: "RR_LATE_ENTRY_NOTHING_TO_ADD",
    });
  });

  it("X-CU-7 a newcomer already seated against every member owes nothing: refused by name (RB5-E9)", () => {
    // f's own lines against a..e are present (the five-field schedule with f in it): nothing is owed.
    const { lines, lastRoundNo } = scene(["a", "b", "c", "d", "e", "f"], 1, 2);
    const d = decideRoundRobinLateEntry({ stageComplete: false, stageStarted: true, members: ["a", "b", "c", "d", "e"], newcomer: "f", legs: 1, lines, byes: [], lastRoundNo });
    expect(d).toEqual({ case: "refused", code: "RR_LATE_ENTRY_NOTHING_TO_ADD" });
  });

  it("X-CU-7 a complete stage refuses by name first, even with nothing owed (RB5-L15 order)", () => {
    const { lines, byes, lastRoundNo } = scene(["a", "b", "c", "d", "e"], 1, 5);
    expect(decideRoundRobinLateEntry({ stageComplete: true, stageStarted: true, members: ["a", "b", "c", "d", "e"], newcomer: "f", legs: 1, lines, byes, lastRoundNo })).toEqual({
      case: "refused",
      code: "RR_LATE_ENTRY_STAGE_COMPLETE",
    });
    expect(decideRoundRobinLateEntry({ stageComplete: true, stageStarted: true, members: [], newcomer: "f", legs: 1, lines: [], byes: [], lastRoundNo: 0 })).toMatchObject({
      code: "RR_LATE_ENTRY_STAGE_COMPLETE",
    });
  });
});

describe("catchUpSet — the brief's scenes (RB5-L3, L6; X-CU-4)", () => {
  it("five-field byes, rounds 1-2 started: c r3, b r4, a r5 take their byes; d r6, e r7 are appended", () => {
    const s = scene(["a", "b", "c", "d", "e"], 1, 2);
    // The scene's premise is the engine's own declaration: byes r1 e, r2 d, r3 c, r4 b, r5 a.
    expect(s.rounds.map((r) => `${r.roundNo}${r.bye}`)).toEqual(["1e", "2d", "3c", "4b", "5a"]);
    const set = catchUpSet({ members: ["a", "b", "c", "d", "e"], newcomer: "f", legs: 1, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo });
    expect(placed(set.fixtures, "f")).toEqual(["c:bye_slot:3", "b:bye_slot:4", "a:bye_slot:5", "d:catch_up_round:6", "e:catch_up_round:7"]);
    expect(set.consumedByes.map((b) => `${b.entrantId}${b.roundNo}`)).toEqual(["c3", "b4", "a5"]);
    expect(set.appendedRounds).toBe(2);
    // X-CU-4: nothing lands in a started round, and a started bye (d r2, e r1) is never consumed.
    expect(set.fixtures.every((f) => f.placement.roundNo > 2)).toBe(true);
    expect(set.consumedByes.every((b) => !b.started)).toBe(true);
    // RB5-G2 home side: along the owed list a, b, c, d, e the newcomer is away first, then alternates.
    const side = Object.fromEntries(set.fixtures.map((f) => [f.home === "f" ? f.away : f.home, f.home === "f" ? "home" : "away"]));
    expect(side).toEqual({ a: "away", b: "home", c: "away", d: "home", e: "away" });
  });

  it("an even field, rounds 1-3 started: six catch-up rounds 6..11 in listed order (every earliest round is 1)", () => {
    const members = ["a", "b", "c", "d", "e", "f"];
    const s = scene(members, 1, 3);
    expect(s.byes, "premise: an even field has no bye").toEqual([]);
    const set = catchUpSet({ members, newcomer: "g", legs: 1, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo });
    expect(placed(set.fixtures, "g")).toEqual(["a", "b", "c", "d", "e", "f"].map((m, i) => `${m}:catch_up_round:${6 + i}`));
    expect(set).toMatchObject({ consumedByes: [], appendedRounds: 6 });
  });

  it("seed order is not id order: members listed [d, a, c, b] append d r4, a r5, c r6, b r7", () => {
    const members = ["d", "a", "c", "b"];
    const s = scene(members, 1, 1);
    const set = catchUpSet({ members, newcomer: "n", legs: 1, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo });
    // a sort-by-id mutant gives a, b, c, d
    expect(placed(set.fixtures, "n")).toEqual(["d:catch_up_round:4", "a:catch_up_round:5", "c:catch_up_round:6", "b:catch_up_round:7"]);
  });

  it("an earlier earliest round goes first: a member who sat out round 1 plays after one who played it", () => {
    // Five-field, rounds 1-5 all started (every bye spent): e sat out round 1 (earliest line round 2); the others played round 1.
    const s = scene(["a", "b", "c", "d", "e"], 1, 5);
    const set = catchUpSet({ members: ["a", "b", "c", "d", "e"], newcomer: "f", legs: 1, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo });
    expect(placed(set.fixtures, "f")).toEqual(["a:catch_up_round:6", "b:catch_up_round:7", "c:catch_up_round:8", "d:catch_up_round:9", "e:catch_up_round:10"]);
  });

  it("two legs: both legs are owed, leg 1 before leg 2 for every member, and each pair's side flips between legs", () => {
    const members = ["a", "b", "c", "d"];
    const s = scene(members, 2, 1);
    expect(s.lastRoundNo, "premise: 4 entrants x 2 legs = 6 rounds").toBe(6);
    const set = catchUpSet({ members, newcomer: "n", legs: 2, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo });
    expect(set.fixtures).toHaveLength(8);
    expect(placed(set.fixtures, "n")).toEqual([
      "a:catch_up_round:7", "b:catch_up_round:8", "c:catch_up_round:9", "d:catch_up_round:10",
      "a:catch_up_round:11", "b:catch_up_round:12", "c:catch_up_round:13", "d:catch_up_round:14",
    ]);
    expect(set.fixtures.map((f) => f.leg)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    let flipped = 0;
    for (const m of members) {
      const [l1, l2] = [1, 2].map((leg) => set.fixtures.find((f) => f.leg === leg && (f.home === m || f.away === m))!);
      expect(l1!.home === "n", `${m}: the newcomer's side flips`).toBe(l2!.away === "n");
      flipped++;
    }
    expect(flipped).toBe(4);
  });

  it("a bye slot whose holder already plays in that round is unusable: the fixture is appended", () => {
    const s = scene(["a", "b", "c", "d", "e"], 1, 2);
    // c already plays in round 3 (an extra line there): its round-3 bye cannot seat it twice.
    const lines = [...s.lines, { home: "c", away: "x", roundNo: 3, leg: 1 }];
    const set = catchUpSet({ members: ["a", "b", "c", "d", "e"], newcomer: "f", legs: 1, lines, byes: s.byes, lastRoundNo: s.lastRoundNo });
    expect(placed(set.fixtures, "f")).toEqual(["b:bye_slot:4", "a:bye_slot:5", "c:catch_up_round:6", "d:catch_up_round:7", "e:catch_up_round:8"]);
    expect(set.consumedByes.map((b) => b.entrantId)).toEqual(["b", "a"]);
  });

  it("RB5-L16: a second newcomer owes the first; the first, asked again, owes nothing", () => {
    const s = scene(["a", "b", "c", "d", "e"], 1, 2);
    const first = catchUpSet({ members: ["a", "b", "c", "d", "e"], newcomer: "f", legs: 1, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo });
    const lines = [...s.lines, ...first.fixtures.map((f) => ({ home: f.home, away: f.away, roundNo: f.placement.roundNo, leg: f.leg }))];
    const byes = s.byes.filter((b) => !first.consumedByes.includes(b));
    const last = Math.max(...lines.map((l) => l.roundNo));
    const again = decideRoundRobinLateEntry({ stageComplete: false, stageStarted: true, members: ["a", "b", "c", "d", "e"], newcomer: "f", legs: 1, lines, byes, lastRoundNo: last });
    expect(again).toEqual({ case: "refused", code: "RR_LATE_ENTRY_NOTHING_TO_ADD" });
    const second = catchUpSet({ members: ["a", "b", "c", "d", "e", "f"], newcomer: "g", legs: 1, lines, byes, lastRoundNo: last });
    expect(second.fixtures, "g owes one fixture per member, f included").toHaveLength(6);
    expect(placed(second.fixtures, "g")).toContain("f:catch_up_round:13");
    expect(second.fixtures.every((f) => f.placement.roundNo > last)).toBe(true);
  });

  it("guards: a newcomer listed as a member, a leg count below 1 and a line after the last round are refused by name", () => {
    const base = { members: ["a"], newcomer: "n", legs: 1, lines: [] as ExistingLine[], byes: [] as ByeSlot[], lastRoundNo: 1 };
    expect(() => catchUpSet({ ...base, members: ["a", "n"] })).toThrow(CatchUpInputError);
    expect(() => catchUpSet({ ...base, legs: 0 })).toThrow(/legs/);
    expect(() => catchUpSet({ ...base, lines: [{ home: "a", away: "b", roundNo: 2, leg: 1 }] })).toThrow(/round 2/);
    expect(() => catchUpSet({ ...base, byes: [{ entrantId: "a", roundNo: 3, leg: 1, started: false }] })).toThrow(/round 3/);
  });

  it("counted sweep: an odd field with nothing started seats every owed fixture on a bye (every member holds one per leg)", () => {
    let checked = 0;
    for (let n = 3; n <= 23; n += 2) {
      for (const legs of [1, 2, 3]) {
        const members = Array.from({ length: n }, (_, i) => `m${String(i).padStart(2, "0")}`);
        const s = scene(members, legs, 0);
        expect(s.byes.length, `premise ${n}x${legs}: the engine declares one bye per member per leg`).toBe(n * legs);
        const set = catchUpSet({ members, newcomer: "new", legs, lines: s.lines, byes: s.byes, lastRoundNo: s.lastRoundNo });
        expect(set.consumedByes.length, `${n}x${legs}`).toBe(n * legs);
        expect(set.appendedRounds, `${n}x${legs}`).toBe(0);
        checked++;
      }
    }
    expect(checked, "11 odd sizes x 3 leg counts").toBe(33);
  });
});

describe("decideRoundRobinLateEntry — the cases in order (RB5-L15)", () => {
  it("X-CU-7 nothing started: rebuild_offered carrying the catch-up set; started: catch_up with the same rule", () => {
    const members = ["a", "b", "c", "d", "e"];
    const fresh = scene(members, 1, 0);
    const offered = decideRoundRobinLateEntry({ stageComplete: false, stageStarted: false, members, newcomer: "f", legs: 1, ...fresh });
    expect(offered.case).toBe("rebuild_offered");
    // RB5-L3 with every bye unstarted: each member's fixture lands in its own bye round (e r1, d r2, c r3, b r4, a r5).
    expect(placed(offered.case === "rebuild_offered" ? offered.catchUp : [], "f")).toEqual(["e:bye_slot:1", "d:bye_slot:2", "c:bye_slot:3", "b:bye_slot:4", "a:bye_slot:5"]);
    const played = scene(members, 1, 2);
    const caught = decideRoundRobinLateEntry({ stageComplete: false, stageStarted: true, members, newcomer: "f", legs: 1, ...played });
    expect(caught).toMatchObject({ case: "catch_up", appendedRounds: 2 });
  });
});

describe("choosePool — the smallest, ties by the seed snake's (n+1)th place (RB5-L9, X-CU-11)", () => {
  const pools = (sizes: Record<string, number>) =>
    new Map(Object.entries(sizes).map(([k, n]) => [k, Array.from({ length: n }, (_, i) => `${k}${i}`)]));
  it("the smallest pool wins outright", () => {
    expect(choosePool(pools({ A: 3, B: 2 }))).toBe("B");
    expect(choosePool(pools({ A: 2, B: 3 }))).toBe("A");
  });
  it("a tie goes where the snake puts the (n+1)th seed (1A 2B 3B 4A 5A 6B 7B; over three: 1A 2B 3C 4C 5B 6A 7A)", () => {
    expect(choosePool(pools({ A: 3, B: 3 }))).toBe("B");
    expect(choosePool(pools({ A: 2, B: 2, C: 2 }))).toBe("A");
    expect(choosePool(pools({ A: 3, B: 2, C: 2 })), "8th seed: B").toBe("B");
  });
  it("the snake's pool is not among the smallest: the next one it walks to that is", () => {
    // n = 7 over three: the 8th seed goes to B (size 3, not smallest), the 9th to C (smallest).
    expect(choosePool(pools({ A: 2, B: 3, C: 2 }))).toBe("C");
  });
  it("no pool, or a key that is no pool letter, is refused by name", () => {
    expect(() => choosePool(new Map())).toThrow(CatchUpInputError);
    expect(() => choosePool(new Map([["AB", []]]))).toThrow(/letter/);
  });
});

describe("catch-up line keys", () => {
  it("a catch-up line carries its pool, kind, round, position and leg; a round-robin reader takes it as a line of the table", () => {
    const keys = [rrCatchUpExtKey("", "catch_up_round", 6, 1, 1), rrCatchUpExtKey("pB-", "bye_slot", 3, 2, 2)];
    expect(keys).toEqual(["rr-cu-r6-c1-L1", "pB-rr-by-r3-c2-L2"]);
    for (const k of keys) {
      expect(isCatchUpExtKey(k), k).toBe(true);
      expect(isRrExtKey(k), `${k}: reconcile reads it as a table line`).toBe(true);
    }
    expect(keys.map(rrLegOfExtKey)).toEqual([1, 2]);
    // The generator's own keys and Add match rows are not catch-up lines.
    for (const k of ["rr-r6-c1-L1", "pA-rr-r1-c1", "adhoc-1", null]) expect(isCatchUpExtKey(k), String(k)).toBe(false);
    expect(isRrExtKey("adhoc-1")).toBe(false);
  });
});
