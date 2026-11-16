// The goal sports' demo model (goal-match.ts): football, hockey, ice hockey. The card each demo records is the first
// class the engine itself offers for that sport, never a word typed here.
import { describe, expect, it } from "vitest";
import { footballPadRules, hockeyPadRules, icehockeyPadRules } from "@seazn/engine/pad";
import { GOAL_RULES, GOAL_SPORTS } from "../goal-rules";
import { card, fullTime, goal, openingGoal, outcome, undo, type GoalState } from "../goal-match";

const view = (s: GoalState) => ({ a: s.a, b: s.b, over: s.over, events: s.events.map((e) => `${e.kind}:${e.side}`) });

describe("goal rules come from the engine", () => {
  it("each sport's card is the first class its own engine rules offer", () => {
    const engine = { football: footballPadRules.cardColors, hockey: hockeyPadRules.suspensionClasses({}), icehockey: icehockeyPadRules.suspensionClasses({}) };
    let checked = 0;
    for (const sport of GOAL_SPORTS) {
      expect(engine[sport].length, sport).toBeGreaterThan(0);
      expect(GOAL_RULES[sport].card, sport).toBe(engine[sport][0]);
      checked++;
    }
    expect(checked).toBe(3);
    // The three are not one constant: a typed "yellow" would fail two of them.
    expect(new Set(GOAL_SPORTS.map((s) => GOAL_RULES[s].card)).size).toBe(3);
  });
});

describe("goal match", () => {
  it("opens level at 1-1 late in the match, with both goals on the timeline", () => {
    const s = openingGoal();
    expect(view(s)).toEqual({ a: 1, b: 1, over: false, events: ["goal:a", "goal:b"] });
    expect(outcome(s)).toBeNull();
    expect(s.events.every((e, i, all) => i === 0 || e.minute > all[i - 1]!.minute)).toBe(true);
  });

  it("a goal adds one to that side only and joins the timeline, later than everything before it", () => {
    const s0 = openingGoal();
    const s = goal(s0, "b");
    expect([s.a, s.b]).toEqual([1, 2]);
    expect(s.events).toHaveLength(3);
    expect(s.events[2]).toMatchObject({ kind: "goal", side: "b" });
    expect(s.events[2]!.minute).toBeGreaterThan(s0.events[1]!.minute);
    expect(goal(s, "a").events[3]!.minute).toBeGreaterThan(s.events[2]!.minute);
  });

  it("a card is on the timeline and changes no score", () => {
    const s = card(openingGoal(), "a");
    expect([s.a, s.b]).toEqual([1, 1]);
    expect(s.events[2]).toMatchObject({ kind: "card", side: "a" });
  });

  it("no result until full time; then the leader has won, or it is a draw", () => {
    expect(outcome(goal(openingGoal(), "a"))).toBeNull();
    expect(outcome(fullTime(goal(openingGoal(), "a")))).toBe("a");
    expect(outcome(fullTime(goal(openingGoal(), "b")))).toBe("b");
    expect(outcome(fullTime(openingGoal()))).toBe("draw");
  });

  it("after full time nothing changes the match", () => {
    const done = fullTime(goal(openingGoal(), "a"));
    expect(goal(done, "b")).toBe(done);
    expect(card(done, "b")).toBe(done);
    expect(fullTime(done)).toBe(done);
  });

  it("take back steps back one action at a time, full time included", () => {
    const start = openingGoal();
    const done = fullTime(card(goal(start, "a"), "b"));
    const reopened = undo(done);
    expect(reopened.over).toBe(false);
    expect(outcome(reopened)).toBeNull();
    expect(view(undo(reopened))).toEqual(view(goal(start, "a")));
    expect(view(undo(undo(undo(done))))).toEqual(view(start));
    expect(undo(start)).toBe(start);
  });
});
