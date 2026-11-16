// The tennis page's demo model (tennis-match.ts). The point calls and the match length are the engine's declarations;
// deuce, advantage, the two-game margin and the tie-break at six games all are ITF Rules 5-7.
import { describe, expect, it } from "vitest";
import { tennisPadRules } from "@seazn/engine/pad";
import { TENNIS_RULES } from "../tennis-rules";
import { calls, matchWinner, openingTennis, point, setsWon, undo, type TennisState } from "../tennis-match";

const R = TENNIS_RULES;
const play = (s: TennisState, sides: string) => [...sides].reduce((acc, c) => point(acc, c as "a" | "b", R), s);
const view = (s: TennisState) => ({ sets: s.sets, games: [s.ga, s.gb], points: [s.pa, s.pb] });
const AD = "AD";

describe("tennis rules come from the engine", () => {
  it("point calls and match length are the engine's", () => {
    expect(R.calls).toEqual([...tennisPadRules.pointCalls]);
    expect(R.calls).toHaveLength(4);
    expect(R.bestOf).toBe(tennisPadRules.bestOf({}));
    expect(R.bestOf % 2).toBe(1);
  });
});

describe("tennis match", () => {
  const need = Math.ceil(R.bestOf / 2);

  it("opens in the deciding set, level on sets, the leader serving for the match at 5-4, 30-15", () => {
    const s = openingTennis(R);
    expect(setsWon(s)).toEqual({ a: need - 1, b: need - 1 });
    expect([s.ga, s.gb]).toEqual([5, 4]);
    expect(calls(s, R, AD)).toEqual({ a: R.calls[2], b: R.calls[1] });
    expect(matchWinner(s, R)).toBeNull();
  });

  it("two points to the leader win the game, the set 6-4 and the match", () => {
    const one = point(openingTennis(R), "a", R);
    expect(calls(one, R, AD)).toEqual({ a: R.calls[3], b: R.calls[1] });
    expect(matchWinner(one, R)).toBeNull();
    const s = point(one, "a", R);
    expect(matchWinner(s, R)).toBe("a");
    expect(s.sets[s.sets.length - 1]).toEqual([6, 4]);
    expect(setsWon(s)).toEqual({ a: need, b: need - 1 });
  });

  it("deuce: forty-all, advantage, back to deuce, and two in a row to win the game", () => {
    const deuce = play(openingTennis(R), "bba");
    expect(calls(deuce, R, AD)).toEqual({ a: R.calls[3], b: R.calls[3] });
    const adA = point(deuce, "a", R);
    expect(calls(adA, R, AD)).toEqual({ a: AD, b: R.calls[3] });
    expect([adA.ga, adA.gb]).toEqual([5, 4]);
    const back = point(adA, "b", R);
    expect(calls(back, R, AD)).toEqual({ a: R.calls[3], b: R.calls[3] });
    const adB = point(back, "b", R);
    expect(calls(adB, R, AD)).toEqual({ a: R.calls[3], b: AD });
    const game = point(adB, "b", R);
    expect([game.ga, game.gb]).toEqual([5, 5]);
    expect(calls(game, R, AD)).toEqual({ a: R.calls[0], b: R.calls[0] });
    expect(matchWinner(game, R)).toBeNull();
  });

  it("six games is not enough at 6-5: the set goes to 7-5", () => {
    const fiveAll = play(openingTennis(R), "bbb");
    expect([fiveAll.ga, fiveAll.gb]).toEqual([5, 5]);
    const sixFive = play(fiveAll, "aaaa");
    expect([sixFive.ga, sixFive.gb]).toEqual([6, 5]);
    expect(matchWinner(sixFive, R)).toBeNull();
    const done = play(sixFive, "aaaa");
    expect(matchWinner(done, R)).toBe("a");
    expect(done.sets[done.sets.length - 1]).toEqual([7, 5]);
  });

  it("at six games all a tie-break is played to seven, two clear, and the set is 7-6", () => {
    const sixAll = play(play(openingTennis(R), "bbb"), "aaaabbbb");
    expect([sixAll.ga, sixAll.gb]).toEqual([6, 6]);
    // Four straight points would win an ordinary game; in the tie-break it is only 4-0.
    const fourLove = play(sixAll, "aaaa");
    expect([fourLove.ga, fourLove.gb]).toEqual([6, 6]);
    expect(calls(fourLove, R, AD)).toEqual({ a: "4", b: "0" });
    expect(matchWinner(fourLove, R)).toBeNull();
    expect(matchWinner(play(fourLove, "aaa"), R)).toBe("a");
    const tb = play(sixAll, "ababab");
    expect(calls(tb, R, AD)).toEqual({ a: "3", b: "3" });
    const sixSix = play(tb, "ababab");
    expect(calls(sixSix, R, AD)).toEqual({ a: "6", b: "6" });
    const sevenSix = point(sixSix, "b", R);
    expect(matchWinner(sevenSix, R)).toBeNull();
    const done = point(sevenSix, "b", R);
    expect(matchWinner(done, R)).toBe("b");
    expect(done.sets[done.sets.length - 1]).toEqual([6, 7]);
  });

  it("a point after the match changes nothing; take back steps one point at a time", () => {
    const start = openingTennis(R);
    const done = play(start, "aa");
    expect(point(done, "b", R)).toBe(done);
    expect(view(undo(done))).toEqual(view(point(start, "a", R)));
    expect(view(undo(undo(done)))).toEqual(view(start));
    expect(undo(start)).toBe(start);
  });
});
