// S2-5 ruling 108 (design §7.4) — football's clock reads MATCH time.
//
// One `it` per vector row, every expected string written by hand from the
// rule, never asked of the code: a period starts at the sum of the nominal
// lengths before it (F8's rule, the engine's `phaseLengths`), and past its own
// nominal end the clock reads the time PASSED in added time, `90+2:30` at
// 92:30 (ruling 109, owner, 2026-11-08: "A"). The phone plan mirrors these
// vectors, so a row changed here is a row changed there.
import { describe, expect, it } from "vitest";
import { clockPeriodsOf, matchClock, matchTimeCfgOf } from "../football-match-time";
import { buildFootballClock, readClock } from "../football";
import { buildClock } from "../period-shared";
import type { PadHostView } from "../../types";
import { foldFootball, footballCfg } from "../../__tests__/_football-fold";
import { foldPeriod, hockey, periodCfg } from "../../__tests__/_period-fold";

const read = (cfg: unknown, period: string, elapsed: number) => matchClock({ period, elapsed }, matchTimeCfgOf(cfg));

const viewOf = (cfg: unknown, state: unknown): PadHostView => ({
  cfg,
  state,
  summary: {},
  phase: "live",
  band: 3,
  entitlements: {},
  personNames: {},
  squads: {
    home: { entrantId: "H", members: [], subsUsed: 0, exemptUsed: {} },
    away: { entrantId: "A", members: [], subsUsed: 0, exemptUsed: {} },
  },
  events: [],
  contextOverrides: {},
  stageKind: null,
  canOrganise: true,
  entrantNames: {},
});

describe("matchClock — the first half, 2 × 45 (engine defaults)", () => {
  it("{H1, 0} reads 0:00", () => expect(read({}, "H1", 0)).toBe("0:00"));
  it("{H1, 65} reads 1:05", () => expect(read({}, "H1", 65)).toBe("1:05"));
  it("{H1, 2699} reads 44:59", () => expect(read({}, "H1", 2699)).toBe("44:59"));
  it("{H1, 2700} reads 45:00 — the nominal end is still regulation", () => expect(read({}, "H1", 2700)).toBe("45:00"));
  it("{H1, 2759} reads 45+0:59", () => expect(read({}, "H1", 2759)).toBe("45+0:59"));
  it("{H1, 2760} reads 45+1:00", () => expect(read({}, "H1", 2760)).toBe("45+1:00"));
});

describe("matchClock — the second half starts at 45:00", () => {
  it("{H2, 0} reads 45:00", () => expect(read({}, "H2", 0)).toBe("45:00"));
  it("{H2, 1320} reads 67:00", () => expect(read({}, "H2", 1320)).toBe("67:00"));
  it("{H2, 2699} reads 89:59", () => expect(read({}, "H2", 2699)).toBe("89:59"));
  it("{H2, 2850} reads 90+2:30 (ruling 109)", () => expect(read({}, "H2", 2850)).toBe("90+2:30"));
  it("{H2, 2880} reads 90+3:00", () => expect(read({}, "H2", 2880)).toBe("90+3:00"));
  it("{H2, 3360} reads 90+11:00", () => expect(read({}, "H2", 3360)).toBe("90+11:00"));
});

describe("matchClock — extra time starts at 90:00", () => {
  const et = { extraTime: { enabled: true, halfMinutes: 15 } };
  it("{ET_H1, 0} reads 90:00", () => expect(read(et, "ET_H1", 0)).toBe("90:00"));
  it("{ET_H1, 900} reads 105:00", () => expect(read(et, "ET_H1", 900)).toBe("105:00"));
  it("{ET_H2, 0} reads 105:00", () => expect(read(et, "ET_H2", 0)).toBe("105:00"));
  it("{ET_H2, 905} reads 120+0:05", () => expect(read(et, "ET_H2", 905)).toBe("120+0:05"));
});

describe("matchClock — quarters (halves: 4) start at the sum of the ones before", () => {
  const quarters = { halves: 4, halfMinutes: 10 };
  it("{H1, 0} reads 0:00", () => expect(read(quarters, "H1", 0)).toBe("0:00"));
  it("{Q2, 0} reads 10:00", () => expect(read(quarters, "Q2", 0)).toBe("10:00"));
  it("{Q3, 125} reads 22:05", () => expect(read(quarters, "Q3", 125)).toBe("22:05"));
  it("{Q4, 660} reads 40+1:00", () => expect(read(quarters, "Q4", 660)).toBe("40+1:00"));
});

describe("matchClock — periodSeconds overrides only UNEQUAL halves", () => {
  const unequal = { periodSeconds: { H1: 2400, H2: 2700 } };
  it("unequal {H1: 2400, H2: 2700}: {H1, 2430} reads 40+0:30", () => expect(read(unequal, "H1", 2430)).toBe("40+0:30"));
  it("unequal {H1: 2400, H2: 2700}: {H2, 0} reads 40:00", () => expect(read(unequal, "H2", 0)).toBe("40:00"));
  it("uniform {H1: 2400, H2: 2400} is ignored: {H2, 0} reads 45:00", () =>
    expect(read({ periodSeconds: { H1: 2400, H2: 2400 } }, "H2", 0)).toBe("45:00"));
});

describe("matchClock — empty and malformed input", () => {
  it("a period the cfg does not know ({ET_H1, 65} with no extra time) reads 1:05", () =>
    expect(read({}, "ET_H1", 65)).toBe("1:05"));
  it("{H1, -5} reads 0:00", () => expect(read({}, "H1", -5)).toBe("0:00"));
  it("{H1, NaN} reads 0:00", () => expect(read({}, "H1", Number.NaN)).toBe("0:00"));
  it("a negative or NaN elapsed in a LATER period reads that period's start, never earlier", () => {
    expect(read({}, "H2", -5)).toBe("45:00");
    expect(read({}, "H2", Number.NaN)).toBe("45:00");
  });
  it("a cfg the engine refuses reads as the engine's defaults", () => {
    expect(read({ halves: 3 }, "H2", 0)).toBe("45:00");
    expect(read(null, "H2", 0)).toBe("45:00");
  });
});

describe("the football skin shows match time; hockey is unchanged", () => {
  it("buildFootballClock's display reads match time, from a real fold in H2", () => {
    const cfg = footballCfg();
    const state = foldFootball(cfg, [["core.start"], ["football.period", { phase: "HT" }]]);
    expect(state.phase).toBe("H2");
    const spec = buildFootballClock(viewOf(cfg, state))!;
    expect(spec.period).toBe("H2");
    expect(spec.display!(0)).toBe("45:00");
    expect(spec.display!(1320)).toBe("67:00");
  });

  it("the display follows the cfg the view carries (quarters)", () => {
    const cfg = footballCfg({ halves: 4, halfMinutes: 10 });
    const state = foldFootball(cfg, [["core.start"], ["football.period", { phase: "QT" }]]);
    expect(state.phase).toBe("Q2");
    expect(buildFootballClock(viewOf(cfg, state))!.display!(30)).toBe("10:30");
  });

  it("hockey's buildClock spec has neither shared nor display", () => {
    const cfg = periodCfg(hockey);
    const state = foldPeriod(hockey, cfg, [["core.start"]]);
    const spec = buildClock(viewOf(cfg, state))!;
    expect(spec).not.toBeNull();
    expect(spec).not.toHaveProperty("shared");
    expect(spec).not.toHaveProperty("display");
  });

  it("readClock reads the fold's asOf in match time", () => {
    expect(readClock({ asOf: { period: "H2", elapsed: 1320 } }, "H2", {})).toBe("67:00");
    expect(readClock({ asOf: { period: "H2", elapsed: 2850 } }, "H2", {})).toBe("90+2:30");
  });
});

// S2-5 ruling 110: the viewers' overlay shows a football clock only in a clock period, and reads a period after the
// anchor's as starting from its own start — so the list is the engine's period order (F8), written here by hand.
describe("clockPeriodsOf — the clock periods, in match order (ruling 110)", () => {
  it("halves, then extra time when it is enabled", () => {
    expect(clockPeriodsOf(matchTimeCfgOf({}))).toEqual(["H1", "H2"]);
    expect(clockPeriodsOf(matchTimeCfgOf({ extraTime: { enabled: true, halfMinutes: 15 } }))).toEqual([
      "H1",
      "H2",
      "ET_H1",
      "ET_H2",
    ]);
  });

  it("quarters at halves: 4", () => {
    expect(clockPeriodsOf(matchTimeCfgOf({ halves: 4, halfMinutes: 20 }))).toEqual(["H1", "Q2", "Q3", "Q4"]);
  });
});

