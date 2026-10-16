import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { OVERLAY_SPORT_KEYS } from "@/components/overlay/overlay-tokens";
import { declaresToss, tossMoment, warmingLine } from "../overlay-openers";
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

describe("warmingLine", () => {
  it("pending copy when toss is absent", () => {
    expect(
      warmingLine({
        sportKey: "cricket",
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
      warmingLine({
        sportKey: "cricket",
        toss: { wonBySide: 0, elected: "bat" },
        sideNames: ["Kings", "Royals"],
        startContext: "Sat 14:30",
        msg,
      }),
    ).toBe("Kings won the toss and elected to bat");
  });
});

// Review d (PR #974, pre-existing from #782): the warming card said "Toss pending" for EVERY sport — a football or
// badminton broadcast promising a toss it will never have. The toss line belongs to a sport whose ENGINE MODULE declares
// a toss; every other sport's warming line is its start alone. The expectation is read off each module's own
// `eventSchemas` (the engine's declaration of what it accepts), never off the app's table the code reads.
describe("warmingLine — a toss line only for a sport whose module declares a toss (every overlay sport)", () => {
  const pendingMsg = (key: string, vars?: Record<string, string | number>) =>
    key === "overlay.slate.warmingLineTossPending" ? `Toss pending · ${vars?.start}` : msg(key, vars);
  const declared = new Map(builtinModules.map((m) => [m.key, Object.keys(m.eventSchemas ?? {})]));

  it("toss copy iff the engine module declares `<sport>.toss`; the start alone otherwise", () => {
    let toss = 0;
    let plain = 0;
    for (const sportKey of OVERLAY_SPORT_KEYS) {
      const types = declared.get(sportKey);
      expect(types, `${sportKey}: no engine module`).toBeDefined();
      const wants = types!.includes(`${sportKey}.toss`);
      expect(declaresToss(sportKey), sportKey).toBe(wants);
      const line = warmingLine({ sportKey, toss: null, sideNames: ["Kings", "Royals"], startContext: "Sat 14:30", msg: pendingMsg });
      if (wants) {
        expect(line, sportKey).toBe("Toss pending · Sat 14:30");
        toss++;
      } else {
        expect(line, sportKey).toBe("Sat 14:30");
        plain++;
      }
    }
    console.log(`overlay sports checked: ${toss + plain} (toss: ${toss}, no toss: ${plain})`);
    expect(toss + plain).toBe(OVERLAY_SPORT_KEYS.length);
    // Both branches witnessed, or the sweep proves one of them by default.
    expect(toss, "no overlay sport declares a toss").toBeGreaterThan(0);
    expect(plain, "every overlay sport declares a toss").toBeGreaterThan(0);
  });

  it("a known toss on a sport with none declared is ignored, not announced", () => {
    expect(
      warmingLine({ sportKey: "football", toss: { wonBySide: 0, elected: "bat" }, sideNames: ["Kings", "Royals"], startContext: "Sat 14:30", msg }),
    ).toBe("Sat 14:30");
  });

  it("an unknown sport key declares no toss", () => {
    expect(declaresToss("quidditch")).toBe(false);
    expect(declaresToss("")).toBe(false);
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
