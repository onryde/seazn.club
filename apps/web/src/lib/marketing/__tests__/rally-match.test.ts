// The rally sports' demo model (rally-match.ts): badminton, table tennis, volleyball. Set targets, match length and the
// score bound are the engine's own declarations, never numbers typed here; the win-by-two and bound rules are the
// sports' laws (BWF 7.3-7.5, ITTF 2.11, FIVB 6.2-6.3).
import { describe, expect, it } from "vitest";
import { badmintonPadRules, tabletennisPadRules, volleyballPadRules } from "@seazn/engine/pad";
import { RALLY_RULES, RALLY_SPORTS } from "../rally-rules";
import { matchWinner, openingRally, point, setsWon, undo, type RallyRules, type RallyState } from "../rally-match";

const ENGINE = { badminton: badmintonPadRules, tabletennis: tabletennisPadRules, volleyball: volleyballPadRules } as const;
const play = (s: RallyState, sides: string, r: RallyRules) => [...sides].reduce((acc, c) => point(acc, c as "a" | "b", r), s);
const view = (s: RallyState) => ({ sets: s.sets, a: s.a, b: s.b });

describe("rally rules come from the engine", () => {
  it.each(RALLY_SPORTS.map((k) => [k]))("%s: targets per set, match length and bound are the engine's", (sport) => {
    const e = ENGINE[sport];
    const r = RALLY_RULES[sport];
    expect(r.bestOf).toBe(e.bestOf({}));
    expect(r.bestOf % 2).toBe(1);
    expect(r.targets).toEqual(Array.from({ length: r.bestOf }, (_, i) => e.setTarget({}, i)));
    expect(r.bound).toBe(e.scoreBound({}));
    expect(Math.min(...r.targets)).toBeGreaterThan(4);
  });

  it("premise: at least one sport's deciding set has its own target, so 'per set' is not decoration", () => {
    const differs = RALLY_SPORTS.filter((k) => new Set(RALLY_RULES[k].targets).size > 1);
    expect(differs).toContain("volleyball");
  });
});

describe.each(RALLY_SPORTS.map((k) => [k]))("rally match: %s", (sport) => {
  const r = RALLY_RULES[sport];
  const need = Math.ceil(r.bestOf / 2);
  const decider = r.targets[r.bestOf - 1]!;

  it("opens in the deciding set, level on sets, three points from the end", () => {
    const s = openingRally(r);
    expect(setsWon(s, r)).toEqual({ a: need - 1, b: need - 1 });
    expect(s.sets).toHaveLength(r.bestOf - 1);
    expect([s.a, s.b]).toEqual([decider - 3, decider - 4]);
    expect(matchWinner(s, r)).toBeNull();
    // Every set already played is a legal final score for its own target.
    s.sets.forEach(([a, b], i) => {
      const t = r.targets[i]!;
      expect(Math.max(a, b), `set ${i + 1}`).toBe(t);
      expect(Math.abs(a - b)).toBeGreaterThanOrEqual(2);
    });
  });

  it("three points to the leader win the set and the match", () => {
    const s = play(openingRally(r), "aaa", r);
    expect(matchWinner(s, r)).toBe("a");
    expect(setsWon(s, r)).toEqual({ a: need, b: need - 1 });
    expect(s.sets[s.sets.length - 1]).toEqual([decider, decider - 4]);
    expect(s.last).toBe("a");
  });

  it("the other side can win it too", () => {
    const three = play(openingRally(r), "bbb", r);
    expect(matchWinner(three, r)).toBeNull();
    const s = point(three, "b", r);
    expect(matchWinner(s, r)).toBe("b");
    expect(s.sets[s.sets.length - 1]).toEqual([decider - 3, decider]);
  });

  it("at the target with a one-point lead the set is not over; two clear ends it", () => {
    // Level at target-1, then one each way.
    const level = play(openingRally(r), "abb", r);
    expect([level.a, level.b]).toEqual([decider - 2, decider - 2]);
    const deuce = play(level, "ab", r);
    expect([deuce.a, deuce.b]).toEqual([decider - 1, decider - 1]);
    const adv = point(deuce, "a", r);
    expect([adv.a, adv.b]).toEqual([decider, decider - 1]);
    expect(matchWinner(adv, r)).toBeNull();
    const won = point(adv, "a", r);
    expect(matchWinner(won, r)).toBe("a");
    expect(won.sets[won.sets.length - 1]).toEqual([decider + 1, decider - 1]);
  });

  it("the bound ends a set that never gets two clear", () => {
    let s = play(openingRally(r), "abb", r);
    let guard = 0;
    while (Math.max(s.a, s.b) < r.bound - 1 || s.a !== s.b) {
      s = point(s, s.a <= s.b ? "a" : "b", r);
      if (++guard > 200) throw new Error("never reached the bound");
    }
    expect([s.a, s.b]).toEqual([r.bound - 1, r.bound - 1]);
    expect(matchWinner(s, r)).toBeNull();
    const won = point(s, "b", r);
    expect(matchWinner(won, r)).toBe("b");
    expect(won.sets[won.sets.length - 1]).toEqual([r.bound - 1, r.bound]);
  });

  it("a point after the match is over changes nothing, and undo steps back one point at a time", () => {
    const start = openingRally(r);
    const won = play(start, "aaa", r);
    expect(point(won, "b", r)).toBe(won);
    const back = undo(won);
    expect(matchWinner(back, r)).toBeNull();
    expect(view(back)).toEqual(view(play(start, "aa", r)));
    expect(view(undo(undo(back)))).toEqual(view(start));
    expect(undo(start)).toBe(start);
  });
});
