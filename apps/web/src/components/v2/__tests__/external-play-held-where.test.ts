// The "where" line both held/flagged queues print under a card's chip (external-play-held-copy.ts): "Round 2 · Board 4", or the
// stage name when either number is missing. It used to be a verbatim copy in the Fixtures-tab queue and the arbiter round column
// (Task 7 review M1); this pins the ONE copy. Pure: no DB, no render. Copy comes from the English dictionary, never typed here.
import { describe, expect, it } from "vitest";
import enUi from "@/dictionaries/en/ui.json";
import { messages } from "@/lib/messages";
import { where } from "../external-play-held-copy";

const en = messages as unknown as Record<string, string>;
const t = (key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[key]!);
const f = { t };
const WHERE = (round: number, board: number) => t("externalPlay.queue.where", { round, board });

describe("where", () => {
  it("both numbers: the dictionary's own line, with the round and the board in their places", () => {
    const line = where({ roundNo: 2, boardNo: 4, stageName: "Swiss" }, f);
    expect(line).toBe(WHERE(2, 4));
    // Anti-vacuity: the dictionary line really carries both slots, and the numbers differ, so swapping them would show.
    expect(enUi["externalPlay.queue.where"]).toContain("{round}");
    expect(enUi["externalPlay.queue.where"]).toContain("{board}");
    expect(line).not.toBe(WHERE(4, 2));
    expect(line).not.toContain("Swiss");
  });

  it("a missing board number falls back to the stage name (boardNo is nullable on held rows)", () => {
    expect(where({ roundNo: 2, boardNo: null, stageName: "Swiss" }, f)).toBe("Swiss");
  });

  it("a missing round number falls back to the stage name", () => {
    expect(where({ roundNo: null, boardNo: 4, stageName: "Swiss" }, f)).toBe("Swiss");
  });

  it("neither number: the stage name", () => {
    expect(where({ roundNo: null, boardNo: null, stageName: "Swiss" }, f)).toBe("Swiss");
  });

  it("round 0 / board 0 are numbers, not missing (a null check, not a falsy check)", () => {
    expect(where({ roundNo: 0, boardNo: 0, stageName: "Swiss" }, f)).toBe(WHERE(0, 0));
  });
});
