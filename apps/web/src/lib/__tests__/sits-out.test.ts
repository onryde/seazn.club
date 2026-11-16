// W5 app PR A, Task 3 (X-SF-4): the pure half of "Sits out". The byes come from the ENGINE's own schedule (`rounds[].bye`), never a
// list typed here; the expected rest is the rulebook's: in a round robin of an odd field every entrant sits out exactly one round.
import { describe, expect, it } from "vitest";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { sitsOutByRound, sitsOutByesOf } from "../sits-out";

const ids = ["a", "b", "c", "d", "e"];
const names = Object.fromEntries(ids.map((i) => [i, i.toUpperCase()]));
const engineByes = (entrants: string[], legs = 1) =>
  generateRoundRobin({ entrants, config: { legs } }).rounds.flatMap((r) => (r.bye === undefined ? [] : [{ round_no: r.roundNo, entrant_id: r.bye }]));

describe("sitsOutByRound", () => {
  it("the empty case first: no byes, no lines (an even field, a knockout, a stage drawn before W5)", () => {
    expect(sitsOutByRound([], names, new Set()).size).toBe(0);
    expect(sitsOutByRound(engineByes(["a", "b", "c", "d"]), names, new Set()).size, "an even field has no bye").toBe(0);
    expect(sitsOutByesOf({})).toEqual([]);
    expect(sitsOutByesOf(null)).toEqual([]);
    expect(sitsOutByesOf({ round_byes: "x" })).toEqual([]);
  });

  it("five entrants: one name per round, and every entrant sits out exactly once", () => {
    const byes = engineByes(ids);
    expect(byes, "premise: five rounds, one bye each").toHaveLength(5);
    const lines = sitsOutByRound(byes, names, new Set());
    expect([...lines.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...lines.values()].flat().sort()).toEqual(["A", "B", "C", "D", "E"]);
    for (const list of lines.values()) expect(list).toHaveLength(1);
  });

  it("a departed entrant is not named: her round has no line (differential: without the filter it names her)", () => {
    const byes = engineByes(ids);
    const roundOfC = byes.find((b) => b.entrant_id === "c")!.round_no;
    const lines = sitsOutByRound(byes, names, new Set(["c"]));
    expect(lines.has(roundOfC)).toBe(false);
    expect(lines.size).toBe(4);
    expect([...lines.values()].flat()).not.toContain("C");
    expect(sitsOutByRound(byes, names, new Set()).has(roundOfC), "the same byes, nobody departed: named").toBe(true);
  });

  it("an id with no name (a setup stage's seat id) is not named", () => {
    const lines = sitsOutByRound([{ round_no: 1, entrant_id: "slot:3" }, { round_no: 2, entrant_id: "a" }], names, new Set());
    expect([...lines.entries()]).toEqual([[2, ["A"]]]);
  });

  it("a several-pool round lists one name per pool, in stored order, each once", () => {
    const byes = [
      { round_no: 1, entrant_id: "a" },
      { round_no: 1, entrant_id: "d" },
      { round_no: 1, entrant_id: "a" },
    ];
    expect(sitsOutByRound(byes, names, new Set()).get(1)).toEqual(["A", "D"]);
  });

  it("two legs: the second leg's rounds are the engine's own later round numbers", () => {
    const byes = engineByes(ids, 2);
    expect(byes, "premise: 10 rounds, one bye each").toHaveLength(10);
    expect(sitsOutByRound(byes, names, new Set()).size).toBe(10);
  });

  it("sitsOutByesOf keeps only well-formed entries", () => {
    const got = sitsOutByesOf({ round_byes: [{ pool: null, round_no: 1, leg: 1, entrant_id: "a" }, { round_no: "x", entrant_id: "b" }, null, { round_no: 2 }] });
    expect(got.map((b) => b.entrant_id)).toEqual(["a"]);
  });
});
