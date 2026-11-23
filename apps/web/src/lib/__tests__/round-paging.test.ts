// W5 follow-ups C (owner 2026-11-23, mock 2026-11-23_w5-schedule-paging-options, Option A "by round"): which rounds of a BIG
// schedule start open. The rule is the owner's words, not this code's: "Finished rounds collapse into one line; the live round
// and the next round are open; later rounds are folded headers". Pure, sport-blind (it reads statuses only), so one status
// vocabulary stands in for every sport - the sport sweep lives in the seams that feed it (`schedule-paging.test.ts`).
import { describe, expect, it } from "vitest";
import { FIXTURE_STATUSES, LOCKED_FIXTURE_STATUSES, SETTLED_FIXTURE_STATUSES } from "../fixture-status";
import { ROUND_PAGING_MIN_FIXTURES, fixtureBucket, pagesByRound, planRounds, type RoundBuckets } from "../round-paging";

const g = (key: string, live: number, upcoming: number, result: number): { key: string; buckets: RoundBuckets } => ({
  key,
  buckets: { live, upcoming, result },
});
const openKeys = (plan: ReturnType<typeof planRounds>) => plan.filter((r) => r.open).map((r) => r.key);
const states = (plan: ReturnType<typeof planRounds>) => Object.fromEntries(plan.map((r) => [r.key, r.state]));

describe("planRounds (Option A: live and next open, the rest folded)", () => {
  it("the empty schedule plans nothing (stated first: no round is open, none is finished)", () => {
    expect(planRounds([])).toEqual([]);
  });

  it("mid-season: finished rounds fold, the live round and the NEXT round open, later rounds fold as upcoming", () => {
    // The mock's own scene: rounds 1-5 played, round 6 live, 7 next, 8 and 9 upcoming.
    const plan = planRounds([
      g("r1", 0, 0, 35), g("r2", 0, 0, 35), g("r3", 0, 0, 35), g("r4", 0, 0, 35), g("r5", 0, 0, 35),
      g("r6", 1, 30, 4), g("r7", 0, 35, 0), g("r8", 0, 35, 0), g("r9", 0, 35, 0),
    ]);
    expect(openKeys(plan)).toEqual(["r6", "r7"]);
    expect(states(plan)).toEqual({
      r1: "finished", r2: "finished", r3: "finished", r4: "finished", r5: "finished",
      r6: "live", r7: "next", r8: "upcoming", r9: "upcoming",
    });
    // Anti-vacuity: every round planned, each exactly once.
    expect(plan.map((r) => r.key)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"]);
  });

  it("between rounds (nothing live, the last played round finished): only the next round opens", () => {
    const plan = planRounds([g("r1", 0, 0, 10), g("r2", 0, 0, 10), g("r3", 0, 10, 0), g("r4", 0, 10, 0)]);
    expect(openKeys(plan)).toEqual(["r3"]);
    expect(states(plan).r3).toBe("next");
    expect(states(plan).r4).toBe("upcoming");
  });

  it("a round part-played with nothing live is the current round: it opens beside the next one", () => {
    const plan = planRounds([g("r1", 0, 0, 10), g("r2", 0, 4, 6), g("r3", 0, 10, 0), g("r4", 0, 10, 0)]);
    expect(openKeys(plan)).toEqual(["r2", "r3"]);
    expect(states(plan)).toMatchObject({ r2: "inProgress", r3: "next", r4: "upcoming" });
  });

  it("a postponed match behind the live round keeps its round folded (in progress), never stealing 'next' from the round after the live one", () => {
    const plan = planRounds([g("r1", 0, 0, 10), g("r2", 0, 1, 9), g("r3", 2, 3, 5), g("r4", 0, 10, 0), g("r5", 0, 10, 0)]);
    expect(openKeys(plan)).toEqual(["r3", "r4"]);
    expect(states(plan)).toMatchObject({ r2: "inProgress", r3: "live", r4: "next", r5: "upcoming" });
    expect(plan.find((r) => r.key === "r2")!.open).toBe(false);
  });

  it("two rounds live at once both open, and the next is the first round after the LAST live one", () => {
    const plan = planRounds([g("r1", 1, 0, 9), g("r2", 2, 8, 0), g("r3", 0, 10, 0)]);
    expect(openKeys(plan)).toEqual(["r1", "r2", "r3"]);
    expect(states(plan)).toMatchObject({ r1: "live", r2: "live", r3: "next" });
  });

  it("nothing played yet: the first round is next and opens alone", () => {
    const plan = planRounds([g("r1", 0, 10, 0), g("r2", 0, 10, 0)]);
    expect(openKeys(plan)).toEqual(["r1"]);
    expect(states(plan)).toEqual({ r1: "next", r2: "upcoming" });
  });

  it("everything finished: the LAST round opens (its results are the story), every other folds into the finished line", () => {
    const plan = planRounds([g("r1", 0, 0, 10), g("r2", 0, 0, 10), g("final", 0, 0, 1)]);
    expect(openKeys(plan)).toEqual(["final"]);
    expect(plan.every((r) => r.state === "finished")).toBe(true);
  });

  it("the live round is the last round: it opens with no next", () => {
    const plan = planRounds([g("sf", 0, 0, 2), g("final", 1, 0, 0)]);
    expect(openKeys(plan)).toEqual(["final"]);
    expect(states(plan)).toEqual({ sf: "finished", final: "live" });
  });

  it("carries each round's own counts through, untouched", () => {
    const [r] = planRounds([g("r1", 1, 2, 3)]);
    expect(r).toMatchObject({ key: "r1", live: 1, upcoming: 2, result: 3, total: 6 });
  });

  it("a round with no match in it (all counts zero) is a caller error, refused by name, never planned as finished", () => {
    expect(() => planRounds([g("r1", 0, 0, 10), g("empty", 0, 0, 0)])).toThrow(/ROUND_PAGING_EMPTY_ROUND/);
  });
});

describe("fixtureBucket (which chip a match sits under)", () => {
  it("classifies every fixture status the schema has (anti-vacuity: the whole vocabulary, 8 statuses)", () => {
    const seen = FIXTURE_STATUSES.map((s) => [s, fixtureBucket(s)] as const);
    expect(seen.length).toBe(8);
    for (const [s, b] of seen) {
      if (s === "in_play") expect(b).toBe("live");
      // Settled (a result, a walkover, an abandonment) and locked (finalized, cancelled = a void) are results; a held level
      // bracket match (`needs_decision`) was PLAYED - the public row reads it Ended - so it is a result too.
      else if (SETTLED_FIXTURE_STATUSES.has(s) || LOCKED_FIXTURE_STATUSES.has(s) || s === "needs_decision") expect(b).toBe("result");
      else expect(b).toBe("upcoming");
    }
    expect(seen.filter(([, b]) => b === "upcoming").map(([s]) => s)).toEqual(["scheduled"]);
  });

  it("a status the schema does not have is refused by name, never filed under a chip", () => {
    expect(() => fixtureBucket("postponed")).toThrow(/ROUND_PAGING_UNKNOWN_STATUS/);
  });
});

describe("pagesByRound (only a BIG schedule pages)", () => {
  it(`pages strictly above ${ROUND_PAGING_MIN_FIXTURES} fixtures, never at or below (the owner's brief: big schedules on phones)`, () => {
    expect(ROUND_PAGING_MIN_FIXTURES).toBe(200);
    expect(pagesByRound(0)).toBe(false);
    expect(pagesByRound(ROUND_PAGING_MIN_FIXTURES)).toBe(false);
    expect(pagesByRound(ROUND_PAGING_MIN_FIXTURES + 1)).toBe(true);
    expect(pagesByRound(4970)).toBe(true);
  });
});
