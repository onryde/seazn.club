// The product pages' cricket chase (cricket-chase.ts): the small model behind "one tap, four screens". Over length is
// the engine's own declaration, never a number typed here.
import { describe, expect, it } from "vitest";
import { cricketPadRules } from "@seazn/engine/pad";
import { BALLS_PER_OVER } from "../cricket-chase-rules";
import { CHASE, chaseOver, needText, openingChase, oversText, tap, undo, type ChaseKey, type ChaseState, chaseMoment } from "../cricket-chase";

const KEYS: ChaseKey[] = ["0", "1", "2", "3", "4", "6", "wide", "out"];
const ENGINE_BPO = cricketPadRules.ballsPerOver({});
const strip = (s: ChaseState) => ({ runs: s.runs, wkts: s.wkts, balls: s.balls, over: s.over, last: s.last });

describe("cricket chase model", () => {
  it("premise: the engine declares a positive over length and the model uses it", () => {
    expect(ENGINE_BPO).toBeGreaterThan(0);
    expect(BALLS_PER_OVER).toBe(ENGINE_BPO);
  });

  it("opening state is 27/2 after 3.1 overs chasing 49", () => {
    const s = openingChase();
    expect(strip(s)).toMatchObject({ runs: 27, wkts: 2, balls: 19 });
    expect(CHASE.target).toBe(49);
    expect(oversText(s.balls, ENGINE_BPO)).toBe(`${Math.floor(19 / ENGINE_BPO)}.${19 % ENGINE_BPO}`);
    expect(needText(s).runs).toBe(22);
    expect(chaseOver(s)).toBeNull();
  });

  it("a run adds to runs and balls; a wide adds one run and no ball", () => {
    const s = openingChase();
    expect(strip(tap(s, "4", ENGINE_BPO))).toMatchObject({ runs: 31, balls: 20, wkts: 2 });
    const w = tap(s, "wide", ENGINE_BPO);
    expect(w.runs).toBe(28);
    expect(w.balls).toBe(s.balls);
  });

  it("out adds a wicket and a ball and no runs", () => {
    const s = tap(openingChase(), "out", ENGINE_BPO);
    expect(strip(s)).toMatchObject({ runs: 27, wkts: 3, balls: 20 });
  });

  it("the over strip resets after the engine's balls-per-over legal balls", () => {
    let s = openingChase();
    const left = ENGINE_BPO - (s.balls % ENGINE_BPO);
    for (let i = 0; i < left; i++) s = tap(s, "0", ENGINE_BPO);
    expect(s.balls % ENGINE_BPO).toBe(0);
    expect(s.over.length).toBeGreaterThanOrEqual(left);
    s = tap(s, "wide", ENGINE_BPO); // a wide opens the next over's strip without using a ball
    expect(s.over).toEqual(["wd"]);
    s = tap(s, "1", ENGINE_BPO);
    expect(s.over).toEqual(["wd", "1"]);
  });

  it("undo restores the exact previous state, any number of times, and is a no-op at the opening state", () => {
    const a = openingChase();
    const b = tap(a, "2", ENGINE_BPO);
    const c = tap(b, "out", ENGINE_BPO);
    expect(strip(undo(c))).toEqual(strip(b));
    expect(strip(undo(undo(c)))).toEqual(strip(a));
    const back = undo(undo(c));
    expect(undo(back)).toBe(back);
    expect(undo(a)).toBe(a);
  });

  it("reaching the target ends the chase: further taps return the same object", () => {
    let s = openingChase();
    while (!chaseOver(s)) s = tap(s, "6", ENGINE_BPO);
    expect(chaseOver(s)).toBe("won");
    expect(s.runs).toBeGreaterThanOrEqual(CHASE.target);
    for (const k of KEYS) expect(tap(s, k, ENGINE_BPO)).toBe(s);
    expect(needText(s).runs).toBe(0);
  });

  it("ten wickets ends the chase the same way", () => {
    let s = openingChase();
    while (!chaseOver(s)) s = tap(s, "out", ENGINE_BPO);
    expect(chaseOver(s)).toBe("allOut");
    expect(s.wkts).toBe(CHASE.wicketsToFall);
    for (const k of KEYS) expect(tap(s, k, ENGINE_BPO)).toBe(s);
  });

  it("sweep: no sequence of taps yields negative runs, an eleventh wicket, or a tap accepted after the end", () => {
    let visited = 0;
    const walk = (s: ChaseState, depth: number) => {
      for (const k of KEYS) {
        const n = tap(s, k, ENGINE_BPO);
        visited++;
        expect(n.runs).toBeGreaterThanOrEqual(s.runs);
        expect(n.wkts).toBeLessThanOrEqual(CHASE.wicketsToFall);
        expect(n.balls - s.balls === 0 || n.balls - s.balls === 1).toBe(true);
        if (chaseOver(s)) expect(n).toBe(s);
        else if (depth > 1) walk(n, depth - 1);
      }
    };
    walk(openingChase(), 4);
    let nearWin = openingChase();
    while (CHASE.target - nearWin.runs > 6) nearWin = tap(nearWin, "4", ENGINE_BPO);
    walk(nearWin, 3);
    let nearOut = openingChase();
    while (nearOut.wkts < CHASE.wicketsToFall - 1) nearOut = tap(nearOut, "out", ENGINE_BPO);
    walk(nearOut, 3);
    expect(visited).toBeGreaterThan(1000);
  });
});

describe("cricket chase: balls left", () => {
  it("counts down from the innings' overs at the engine's over length", async () => {
    const { ballsLeft } = await import("../cricket-chase");
    const s = openingChase();
    expect(ballsLeft(s, ENGINE_BPO)).toBe(CHASE.overs * ENGINE_BPO - s.balls);
    expect(ballsLeft(tap(s, "1", ENGINE_BPO), ENGINE_BPO)).toBe(ballsLeft(s, ENGINE_BPO) - 1);
    expect(ballsLeft(tap(s, "wide", ENGINE_BPO), ENGINE_BPO)).toBe(ballsLeft(s, ENGINE_BPO));
  });
});

// What the stream tile announces after a tap. Expected values are worked by hand from the laws (a boundary is a four
// or a six; an over is `ballsPerOver` LEGAL balls; a wide is one run and not a ball), never read from the model.
describe("chaseMoment", () => {
  const play = (keys: ChaseKey[], bpo = 6) => keys.reduce((s, k) => tap(s, k, bpo), openingChase());

  it("nothing before the first tap, and nothing for a ball that is not a moment", () => {
    expect(chaseMoment(openingChase(), 6)).toEqual({ ball: null, endOfOver: null });
    for (const key of ["0", "1", "2", "3", "wide"] as const) expect(chaseMoment(play([key]), 6), key).toEqual({ ball: null, endOfOver: null });
  });

  it("a six, a four and a wicket each announce themselves, and are told apart", () => {
    expect(chaseMoment(play(["6"]), 6).ball).toBe("six");
    expect(chaseMoment(play(["4"]), 6).ball).toBe("four");
    expect(chaseMoment(play(["out"]), 6).ball).toBe("out");
    // Only the LAST ball: a six followed by a single is no longer a moment.
    expect(chaseMoment(play(["6", "1"]), 6).ball).toBeNull();
  });

  it("the sixth legal ball ends the over: its number, and every run scored in it, wides included", () => {
    // The demo opens 19 balls in (3.1) with a single on the strip. Five more legal balls and one wide finish over 4.
    const s = play(["2", "wide", "4", "0", "1", "6"]);
    expect(s.balls).toBe(24);
    expect(chaseMoment(s, 6)).toEqual({ ball: "six", endOfOver: { over: 4, runs: 1 + 2 + 1 + 4 + 0 + 1 + 6 } });
    // One ball earlier it had not ended.
    expect(chaseMoment(play(["2", "wide", "4", "0", "1"]), 6).endOfOver).toBeNull();
  });

  it("a wide after the over has ended is the next over's ball, not a second end of over", () => {
    const s = play(["2", "4", "0", "1", "6", "wide"]);
    expect(s.balls).toBe(24);
    expect(chaseMoment(s, 6).endOfOver).toBeNull();
  });

  it("the over length is the parameter's: five-ball overs end the over one legal ball in", () => {
    expect(chaseMoment(play(["1"], 5), 5).endOfOver).toEqual({ over: 4, runs: 2 });
    expect(chaseMoment(play(["1"], 6), 6).endOfOver).toBeNull();
  });

  it("taking the ball back takes its moment back", () => {
    expect(chaseMoment(undo(play(["6"])), 6)).toEqual({ ball: null, endOfOver: null });
  });
});
