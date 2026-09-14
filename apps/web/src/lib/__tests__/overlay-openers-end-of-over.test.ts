import { describe, expect, it } from "vitest";
import { tossMoment, warmingTossLine } from "../overlay-openers";
import {
  closedOverBaselineOf,
  CLOSED_OVER_BASELINE_NONE,
  END_OF_OVER_HOLD_MS,
  endOfOverMoment,
  endOfOverSeq,
  isClosedOverAfter,
  isFullEndOfOver,
} from "../overlay-end-of-over";
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

describe("warmingTossLine", () => {
  it("pending copy when toss is absent", () => {
    expect(
      warmingTossLine({
        toss: null,
        sideNames: ["Kings", "Royals"],
        startContext: "Sat 14:30",
        msg: (key, vars) =>
          key === "overlay.slate.warmingLineTossPending"
            ? `Toss pending · ${vars?.start}`
            : key,
      }),
    ).toBe("Toss pending · Sat 14:30");
  });

  it("won-and-elected once toss is on the wire", () => {
    expect(
      warmingTossLine({
        toss: { wonBySide: 0, elected: "bat" },
        sideNames: ["Kings", "Royals"],
        startContext: "Sat 14:30",
        msg,
      }),
    ).toBe("Kings won the toss and elected to bat");
  });
});

describe("endOfOverMoment", () => {
  const closed: OverlayClosedOver = {
    inningsIndex: 0,
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
    expect(endOfOverMoment({ closed, since: { inningsIndex: 0, over: 12 }, msg })).toBeNull();
    expect(endOfOverMoment({ closed, since: { inningsIndex: 0, over: 13 }, msg })).toBeNull();
  });

  it("fires TWICE (doubleBeat) for a newer closed over with full payload — same mechanism as SIX/FOUR/OUT/GOAL", () => {
    const [first, second] = endOfOverMoment({
      closed,
      since: { inningsIndex: 0, over: 11 },
      msg,
    })!;
    expect(first.graphic).toBe("endOfOver");
    expect(first.kind).toBe("endOfOver");
    expect(second.kind).toBe("endOfOver.bis");
    // Both beats are otherwise identical — the queue's seq:kind dedupe is
    // what lets the second through, and the render branch keys off `graphic`
    // alone, so both must carry the same payload.
    for (const m of [first, second]) {
      expect(m.graphic).toBe("endOfOver");
      expect(m.seq).toBe(endOfOverSeq(closed));
      expect(m.headline).toBe("End of over 12");
      expect(m.line).toBe("8 runs · 142/6");
      expect(m.endOfOver).toEqual(closed);
      expect(m.holdMs).toBe(END_OF_OVER_HOLD_MS);
    }
    expect(isFullEndOfOver(closed)).toBe(true);
  });

  it("compact when glyphs are empty", () => {
    const coarse: OverlayClosedOver = { ...closed, glyphs: [] };
    expect(isFullEndOfOver(coarse)).toBe(false);
    const [first] = endOfOverMoment({ closed: coarse, since: CLOSED_OVER_BASELINE_NONE, msg })!;
    expect(first.endOfOver!.glyphs).toEqual([]);
  });

  it("compact when glyphs exist but every name is masked", () => {
    const masked: OverlayClosedOver = {
      ...closed,
      batters: closed.batters.map((b) => ({ ...b, name: undefined })),
      bowler: closed.bowler ? { ...closed.bowler, name: undefined } : undefined,
    };
    expect(isFullEndOfOver(masked)).toBe(false);
  });

  it("full when glyphs plus a named bowler (batters masked)", () => {
    const bowlerOnly: OverlayClosedOver = {
      ...closed,
      batters: closed.batters.map((b) => ({ ...b, name: undefined })),
    };
    expect(isFullEndOfOver(bowlerOnly)).toBe(true);
  });

  it("fires innings-2 over 1 after an OBS mid-innings-1 baseline (bare over would silence it)", () => {
    const chaseFirst: OverlayClosedOver = {
      ...closed,
      inningsIndex: 1,
      over: 1,
      score: "4/0",
      runs: 4,
      wickets: 0,
    };
    // Mounted while innings 1 was on over 15 — old `over <= sinceOver` would drop this.
    const since = { inningsIndex: 0, over: 15 };
    expect(isClosedOverAfter(chaseFirst, since)).toBe(true);
    const [first] = endOfOverMoment({ closed: chaseFirst, since, msg })!;
    expect(first.seq).toBe(endOfOverSeq(chaseFirst));
    expect(endOfOverSeq(chaseFirst)).not.toBe(endOfOverSeq({ ...closed, over: 1 }));
  });

  it("closedOverBaselineOf reads innings+over from the mount tip", () => {
    expect(closedOverBaselineOf(null)).toEqual(CLOSED_OVER_BASELINE_NONE);
    expect(closedOverBaselineOf(closed)).toEqual({ inningsIndex: 0, over: 12 });
  });
});
