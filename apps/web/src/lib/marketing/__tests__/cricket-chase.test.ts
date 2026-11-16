// The product pages' cricket chase (cricket-chase.ts): the small model behind "one tap, four screens". Over length is
// the engine's own declaration, never a number typed here.
import { describe, expect, it } from "vitest";
import { cricketPadRules } from "@seazn/engine/pad";
import { CHASE, BALLS_PER_OVER, chaseOver, needText, openingChase, oversText, tap, undo, type ChaseKey, type ChaseState } from "../cricket-chase";

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
    expect(strip(tap(s, "4"))).toMatchObject({ runs: 31, balls: 20, wkts: 2 });
    const w = tap(s, "wide");
    expect(w.runs).toBe(28);
    expect(w.balls).toBe(s.balls);
  });

  it("out adds a wicket and a ball and no runs", () => {
    const s = tap(openingChase(), "out");
    expect(strip(s)).toMatchObject({ runs: 27, wkts: 3, balls: 20 });
  });

  it("the over strip resets after the engine's balls-per-over legal balls", () => {
    let s = openingChase();
    const left = ENGINE_BPO - (s.balls % ENGINE_BPO);
    for (let i = 0; i < left; i++) s = tap(s, "0");
    expect(s.balls % ENGINE_BPO).toBe(0);
    expect(s.over.length).toBeGreaterThanOrEqual(left);
    s = tap(s, "wide"); // a wide opens the next over's strip without using a ball
    expect(s.over).toEqual(["wd"]);
    s = tap(s, "1");
    expect(s.over).toEqual(["wd", "1"]);
  });

  it("undo restores the exact previous state, any number of times, and is a no-op at the opening state", () => {
    const a = openingChase();
    const b = tap(a, "2");
    const c = tap(b, "out");
    expect(strip(undo(c))).toEqual(strip(b));
    expect(strip(undo(undo(c)))).toEqual(strip(a));
    const back = undo(undo(c));
    expect(undo(back)).toBe(back);
    expect(undo(a)).toBe(a);
  });

  it("reaching the target ends the chase: further taps return the same object", () => {
    let s = openingChase();
    while (!chaseOver(s)) s = tap(s, "6");
    expect(chaseOver(s)).toBe("won");
    expect(s.runs).toBeGreaterThanOrEqual(CHASE.target);
    for (const k of KEYS) expect(tap(s, k)).toBe(s);
    expect(needText(s).runs).toBe(0);
  });

  it("ten wickets ends the chase the same way", () => {
    let s = openingChase();
    while (!chaseOver(s)) s = tap(s, "out");
    expect(chaseOver(s)).toBe("allOut");
    expect(s.wkts).toBe(CHASE.wicketsToFall);
    for (const k of KEYS) expect(tap(s, k)).toBe(s);
  });

  it("sweep: no sequence of taps yields negative runs, an eleventh wicket, or a tap accepted after the end", () => {
    let visited = 0;
    const walk = (s: ChaseState, depth: number) => {
      for (const k of KEYS) {
        const n = tap(s, k);
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
    while (CHASE.target - nearWin.runs > 6) nearWin = tap(nearWin, "4");
    walk(nearWin, 3);
    let nearOut = openingChase();
    while (nearOut.wkts < CHASE.wicketsToFall - 1) nearOut = tap(nearOut, "out");
    walk(nearOut, 3);
    expect(visited).toBeGreaterThan(1000);
  });
});

describe("cricket chase: balls left", () => {
  it("counts down from the innings' overs at the engine's over length", async () => {
    const { ballsLeft } = await import("../cricket-chase");
    const s = openingChase();
    expect(ballsLeft(s)).toBe(CHASE.overs * ENGINE_BPO - s.balls);
    expect(ballsLeft(tap(s, "1"))).toBe(ballsLeft(s) - 1);
    expect(ballsLeft(tap(s, "wide"))).toBe(ballsLeft(s));
  });
});
