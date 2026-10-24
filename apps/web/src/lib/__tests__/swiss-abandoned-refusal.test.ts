// W2c X-AB-5 (fix round 1, I2): the shared shape of the Swiss "settle the abandoned board first" refusal.
import { describe, expect, it } from "vitest";
import { SWISS_ABANDONED_BOARDS_REASON, abandonedBoardsOf } from "../swiss-abandoned-refusal";

const board = (o: object = {}) => ({ fixtureId: "f1", round: 1, board: 2, ...o });

describe("abandonedBoardsOf", () => {
  it("empty cases first: nothing, an object with no list, and an empty list are not a named refusal", () => {
    for (const data of [undefined, null, 7, "x", {}, { abandoned: [] }, { abandoned: "no" }]) expect(abandonedBoardsOf(data), String(JSON.stringify(data))).toBeNull();
  });

  it("reads the boards in the order given, with their ids and numbers", () => {
    expect(abandonedBoardsOf({ abandoned: [board(), board({ fixtureId: "f2", round: 2, board: 1 })] })).toEqual([
      { fixtureId: "f1", round: 1, board: 2 },
      { fixtureId: "f2", round: 2, board: 1 },
    ]);
  });

  it("rejects the whole list when any entry is malformed (counted) - a half-read list would name the wrong boards", () => {
    const bad: unknown[] = [null, "f1", {}, board({ fixtureId: "" }), board({ fixtureId: 3 }), board({ round: 0 }), board({ round: 1.5 }), board({ round: "1" }), board({ board: 0 }), board({ board: -1 }), board({ board: NaN })];
    let checked = 0;
    for (const b of bad) {
      expect(abandonedBoardsOf({ abandoned: [board(), b] }), JSON.stringify(b)).toBeNull();
      expect(abandonedBoardsOf({ abandoned: [b] }), JSON.stringify(b)).toBeNull();
      checked++;
    }
    expect(checked).toBe(bad.length);
  });

  it("the reason string is the wire's", () => {
    expect(SWISS_ABANDONED_BOARDS_REASON).toBe("swiss_abandoned_boards");
  });
});
