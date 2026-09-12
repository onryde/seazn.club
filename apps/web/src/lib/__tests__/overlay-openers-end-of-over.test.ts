import { describe, expect, it } from "vitest";
import { tossMoment } from "../overlay-openers";
import { endOfOverMoment, isFullEndOfOver } from "../overlay-end-of-over";
import type { OverlayClosedOver } from "../overlay-cricket";

const msg = (key: string, vars?: Record<string, string | number>) => {
  if (key === "overlay.toss.bat") return "bat";
  if (key === "overlay.toss.bowl") return "bowl";
  if (key === "overlay.toss.wonAndElected") return `${vars?.team} won the toss and elected to ${vars?.choice}`;
  if (key === "overlay.endOfOver.title") return `End of over ${vars?.over}`;
  if (key === "overlay.endOfOver.runsScore") return `${vars?.runs} runs · ${vars?.score}`;
  return key;
};

describe("tossMoment", () => {
  it("returns null when scoring has started", () => {
    expect(
      tossMoment({
        toss: { wonBySide: 0, elected: "bat" },
        sideNames: ["Kings", "Royals"],
        scoringStarted: true,
        msg,
      }),
    ).toBeNull();
  });

  it("returns null without a toss", () => {
    expect(
      tossMoment({ toss: null, sideNames: ["Kings", "Royals"], scoringStarted: false, msg }),
    ).toBeNull();
  });

  it("builds a toss graphic with 8s hold", () => {
    const m = tossMoment({
      toss: { wonBySide: 1, elected: "bowl" },
      sideNames: ["Kings", "Royals"],
      scoringStarted: false,
      msg,
    })!;
    expect(m.graphic).toBe("toss");
    expect(m.kind).toBe("toss");
    expect(m.holdMs).toBe(8000);
    expect(m.headline).toBe("Royals won the toss and elected to bowl");
  });
});

describe("endOfOverMoment", () => {
  const closed: OverlayClosedOver = {
    over: 12,
    runs: 8,
    wickets: 1,
    score: "142/6",
    glyphs: [
      { kind: "runs", runs: 1 },
      { kind: "runs", runs: 4 },
      { kind: "wicket", dismissal: "bowled" },
    ],
    bowler: { name: "Bumrah", overs: "4.0", maidens: 0, runs: 28, wickets: 2 },
    batters: [
      { name: "Iyer", runs: 40, balls: 24, onStrike: true },
      { name: "Pant", runs: 12, balls: 8, onStrike: false },
    ],
  };

  it("is null when over is not newer than the baseline", () => {
    expect(endOfOverMoment({ closed, sinceOver: 12, msg })).toBeNull();
    expect(endOfOverMoment({ closed, sinceOver: 13, msg })).toBeNull();
  });

  it("fires once for a newer closed over with full payload", () => {
    const m = endOfOverMoment({ closed, sinceOver: 11, msg })!;
    expect(m.graphic).toBe("endOfOver");
    expect(m.seq).toBe(12);
    expect(m.headline).toBe("End of over 12");
    expect(m.line).toBe("8 runs · 142/6");
    expect(m.endOfOver).toEqual(closed);
    expect(isFullEndOfOver(closed)).toBe(true);
  });

  it("compact when glyphs are empty", () => {
    const coarse: OverlayClosedOver = { ...closed, glyphs: [] };
    expect(isFullEndOfOver(coarse)).toBe(false);
    expect(endOfOverMoment({ closed: coarse, sinceOver: 0, msg })!.endOfOver!.glyphs).toEqual([]);
  });
});
