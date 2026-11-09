import { describe, expect, it } from "vitest";
import { inningsScore, lastSuperOver } from "../cricket-super-over";

describe("lastSuperOver", () => {
  it("is null before a super over has an innings", () => {
    expect(lastSuperOver([])).toBeNull();
  });
  it("one super over: number 1 of 1, both innings", () => {
    const last = lastSuperOver([
      { side: "h", runs: 9, wickets: 0 },
      { side: "a", runs: 8, wickets: 0 },
    ]);
    expect(last?.number).toBe(1);
    expect(last?.count).toBe(1);
    expect(last?.innings.map((i) => `${i.side}${inningsScore(i)}`)).toEqual(["h9/0", "a8/0"]);
  });
  it("three super overs: the third decides, never the sum", () => {
    const last = lastSuperOver([
      { side: "a", runs: 9, wickets: 0 }, { side: "h", runs: 9, wickets: 0 },
      { side: "a", runs: 36, wickets: 0 }, { side: "h", runs: 36, wickets: 0 },
      { side: "h", runs: 36, wickets: 0 }, { side: "a", runs: 32, wickets: 0 },
    ]);
    expect(last?.number).toBe(3);
    expect(last?.innings.map((i) => `${i.side}${inningsScore(i)}`)).toEqual(["h36/0", "a32/0"]);
  });
  it("second super over's first half in progress: just that innings", () => {
    const last = lastSuperOver([
      { side: "a", runs: 9, wickets: 0 }, { side: "h", runs: 9, wickets: 0 },
      { side: "a", runs: 14, wickets: 1 },
    ]);
    expect(last?.number).toBe(2);
    expect(last?.innings.map(inningsScore)).toEqual(["14/1"]);
  });
});
