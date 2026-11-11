// Engine 7.0.0 (onryde/seazn.club.engine#41, F-R3) and the controller's ruling 154, on the web pad.
//
// 1. THE CAPS IN EXTRA TIME. Law 3 (IFAB Laws of the Game 2025/26, 3.2): a competition may allow five substitutions in three
//    opportunities, and where it plays extra time, one more substitution and one more opportunity in it. The engine models the
//    extra pair as `extraTimeSubs: { subs, windows }`, read only once the match has reached extra time. The expected caps below
//    are typed from the Law, never computed by the code under test, and the fold the pad must agree with is the REAL one.
// 2. A SUBSTITUTION'S STAMP (ruling 154, superseding the web's R3-2): a sub joins the stoppage of the newest stamped event when
//    that event is itself a substitution in this period and the live reading is at most 120 s past it; otherwise it takes the
//    live reading, floored at the fold's `asOf`; with no reading it is unstamped. Mirrors the phone's footballClock.ts.
//
// single-sport: `extraTimeSubs` and the substitution window exist in football's schema alone.
import { describe, expect, it } from "vitest";
import { foldMatch, initSquads, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { resolvePositions } from "@seazn/engine/sport";
import { football, type FootballCfg, type FootballState } from "@seazn/engine/sports/football";
import { lineupFromCatalog, makeEnvelope } from "@seazn/engine/testkit";
import type { GameTimeStamp } from "../../clock";
import type { PadHostView } from "../../types";
import { buildSwap, type TFn } from "../football";
import { SUB_STOPPAGE_SECONDS, subCapsOf, subStampOf, subStoppageOf, type SubLedgerRow } from "../football-subs";

const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

// Law 3.2, typed from the rulebook: five substitutions, three opportunities; in extra time one more of each.
const LAW3_SUBS = 5;
const LAW3_WINDOWS = 3;
const ET_EXTRA = { subs: 1, windows: 1 } as const;
const EXTRA_TIME = { enabled: true, halfMinutes: 15 } as const;

const cfgOf = (over: Record<string, unknown>): FootballCfg =>
  football.configSchema.parse({ maxSubs: LAW3_SUBS, subWindows: LAW3_WINDOWS, ...over });

describe("engine 7.0.0: the caps the pad reads rise in extra time only, and only with extraTimeSubs", () => {
  // phase -> the caps Law 3 puts in force there, per competition. ET_* phases are unreachable without extra time on, so a
  // competition without it is asked only the phases it can reach (the kicks straight after full time among them).
  const RAISED = { maxSubs: LAW3_SUBS + ET_EXTRA.subs, subWindows: LAW3_WINDOWS + ET_EXTRA.windows };
  const BASE = { maxSubs: LAW3_SUBS, subWindows: LAW3_WINDOWS };
  const CASES: { label: string; cfg: FootballCfg; want: Record<string, { maxSubs: number | undefined; subWindows: number | undefined }> }[] = [
    {
      label: "extra time + extraTimeSubs",
      cfg: cfgOf({ extraTime: EXTRA_TIME, shootout: true, extraTimeSubs: ET_EXTRA }),
      want: { H1: BASE, H2: BASE, ET_H1: RAISED, ET_H2: RAISED, SHOOTOUT: RAISED },
    },
    {
      label: "extra time, no extraTimeSubs",
      cfg: cfgOf({ extraTime: EXTRA_TIME, shootout: true }),
      want: { H1: BASE, H2: BASE, ET_H1: BASE, ET_H2: BASE, SHOOTOUT: BASE },
    },
    {
      label: "extraTimeSubs but no extra time (kicks straight after full time)",
      cfg: cfgOf({ shootout: true, extraTimeSubs: ET_EXTRA }),
      want: { H1: BASE, H2: BASE, SHOOTOUT: BASE },
    },
    {
      label: "rolling subs: no player cap at all, the window cap still rises",
      cfg: cfgOf({ rollingSubs: true, extraTime: EXTRA_TIME, extraTimeSubs: ET_EXTRA }),
      want: {
        H2: { maxSubs: undefined, subWindows: LAW3_WINDOWS },
        ET_H1: { maxSubs: undefined, subWindows: LAW3_WINDOWS + ET_EXTRA.windows },
      },
    },
  ];

  it("subCapsOf answers Law 3 for every competition and phase (counted)", () => {
    let judged = 0;
    for (const { label, cfg, want } of CASES) {
      for (const [phase, caps] of Object.entries(want)) {
        expect(subCapsOf(cfg, phase), `${label} @ ${phase}`).toEqual(caps);
        judged++;
      }
    }
    expect(judged).toBe(15);
  });

  it("a cfg with no caps stays uncapped in extra time (the extra pair raises only a declared cap)", () => {
    expect(subCapsOf(football.configSchema.parse({ extraTime: EXTRA_TIME, extraTimeSubs: ET_EXTRA }), "ET_H1")).toEqual({
      maxSubs: football.configSchema.parse({}).maxSubs === undefined ? undefined : football.configSchema.parse({}).maxSubs! + ET_EXTRA.subs,
      subWindows: undefined,
    });
    // An empty cfg, the shape the dispatch-totality sweep hands every reader, does not throw.
    expect(() => subCapsOf({}, "ET_H1")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The pad's slot against the REAL fold, in regulation and in extra time.
// ---------------------------------------------------------------------------------------------------------------------

/** Eleven a side plus seven on the bench, so six ordinary substitutions are possible without re-entry. */
function lineups(cfg: FootballCfg): LineupPair {
  const side = (id: string): LineupPair["home"] => {
    const base = lineupFromCatalog(resolvePositions(football, cfg), id);
    const bench = Array.from({ length: 7 }, (_, k) => ({ personId: `${id}-b${k + 1}`, slot: "bench" as const, orderNo: base.slots.length + k + 1 }));
    return { ...base, slots: [...base.slots, ...bench] };
  };
  return { home: side("H"), away: side("A") };
}

interface Played {
  cfg: FootballCfg;
  state: FootballState;
  events: EventEnvelope[];
}

/** Kick off, then home substitutes at each stamp in `subs` (one player per stamp), then optionally plays a level 90 into ET_H1. */
function play(cfg: FootballCfg, subs: readonly GameTimeStamp[], to: "H1" | "H2" | "ET_H1"): Played {
  const specs: { type: string; payload?: unknown }[] = [{ type: "core.start", payload: {} }];
  const lu = lineups(cfg);
  const starters = lu.home.slots.filter((s) => s.slot !== "bench").map((s) => s.personId);
  const bench = lu.home.slots.filter((s) => s.slot === "bench").map((s) => s.personId);
  subs.forEach((at, k) => specs.push({ type: "football.sub", payload: { by: "H", off: starters[k + 1]!, on: bench[k]!, at } }));
  if (to !== "H1") specs.push({ type: "football.period", payload: { phase: "HT" } });
  if (to === "ET_H1") {
    specs.push({ type: "football.goal", payload: { by: "H" } }, { type: "football.goal", payload: { by: "A" } });
    specs.push({ type: "football.period", payload: { phase: "FT" } });
  }
  const events = specs.map((s, i) => makeEnvelope(i + 1, s as never));
  const state = foldMatch(football, cfg, lu, events, { strictFromSeq: 1 });
  expect(state.phase, "premise: the fold reached the phase asked for").toBe(to);
  return { cfg, state, events };
}

function accepts(played: Played, payload: unknown): boolean {
  const probe = makeEnvelope(played.events.length + 1, { type: "football.sub", payload } as never);
  try {
    foldMatch(football, played.cfg, lineups(played.cfg), [...played.events, probe], { strictFromSeq: 1 });
    return true;
  } catch {
    return false;
  }
}

function viewOf(played: Played, clockAt: GameTimeStamp | undefined): PadHostView {
  return {
    cfg: played.cfg,
    state: played.state,
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: {},
    squads: initSquads(lineups(played.cfg)),
    events: played.events,
    contextOverrides: {},
    stageKind: "knockout",
    canOrganise: true,
    entrantNames: {},
    ...(clockAt === undefined ? {} : { clockAt }),
  };
}

/** The home slot's verdict and the fold's on the substitution it would send now. */
function verdict(played: Played, clockAt: GameTimeStamp) {
  const slot = buildSwap(viewOf(played, clockAt), t)[0]!;
  const off = played.state.squads.home.onPitch.at(-1)!;
  const on = played.state.squads.home.bench.at(-1)!;
  const event = slot.buildEvent(off, on);
  return { slot, payload: event.payload as Record<string, unknown>, fold: accepts(played, event.payload) };
}

// Five subs in three windows, all in the first half (two, two, one).
const FIVE_IN_THREE: GameTimeStamp[] = [
  { period: "H1", elapsed: 600 }, { period: "H1", elapsed: 600 },
  { period: "H1", elapsed: 1500 }, { period: "H1", elapsed: 1500 },
  { period: "H1", elapsed: 2400 },
];
// Three subs in three windows: substitutions in hand, opportunities spent.
const THREE_IN_THREE: GameTimeStamp[] = [{ period: "H1", elapsed: 600 }, { period: "H1", elapsed: 1500 }, { period: "H1", elapsed: 2400 }];

describe("engine 7.0.0: the sub slot agrees with the fold in extra time, both ways", () => {
  const withEt = cfgOf({ extraTime: EXTRA_TIME, shootout: true, extraTimeSubs: ET_EXTRA });
  const withoutEt = cfgOf({ extraTime: EXTRA_TIME, shootout: true });
  const etClock = { period: "ET_H1", elapsed: 300 };

  it("the sixth substitution: allowed in ET_H1 with extraTimeSubs, refused without it, refused in H2 either way", () => {
    const cases = [
      { label: "ET_H1 + extraTimeSubs", played: play(withEt, FIVE_IN_THREE, "ET_H1"), clock: etClock, ok: true },
      { label: "ET_H1, no extraTimeSubs", played: play(withoutEt, FIVE_IN_THREE, "ET_H1"), clock: etClock, ok: false },
      { label: "H2 + extraTimeSubs (not extra time yet)", played: play(withEt, FIVE_IN_THREE, "H2"), clock: { period: "H2", elapsed: 600 }, ok: false },
    ];
    for (const { label, played, clock, ok } of cases) {
      const { slot, fold } = verdict(played, clock);
      expect(fold, `${label}: premise, the fold's own answer`).toBe(ok);
      expect(slot.policyOk, `${label}: the slot agrees with the fold`).toBe(ok);
      if (!ok) {
        expect(slot.policyMessage, label).toContain("pad.football.context.sub.blocked.maxSubs");
        expect(slot.policyMessage, `${label}: worded with the cap in force (Law 3: five)`).toContain(`"max":${LAW3_SUBS}`);
      }
    }
    expect(cases.length).toBe(3);
  });

  it("the fourth window: allowed in ET_H1 with extraTimeSubs, refused without it, refused in H2 either way", () => {
    const cases = [
      { label: "ET_H1 + extraTimeSubs", played: play(withEt, THREE_IN_THREE, "ET_H1"), clock: etClock, ok: true },
      { label: "ET_H1, no extraTimeSubs", played: play(withoutEt, THREE_IN_THREE, "ET_H1"), clock: etClock, ok: false },
      { label: "H2 + extraTimeSubs", played: play(withEt, THREE_IN_THREE, "H2"), clock: { period: "H2", elapsed: 600 }, ok: false },
    ];
    for (const { label, played, clock, ok } of cases) {
      const { slot, payload, fold } = verdict(played, clock);
      expect(payload.at, `${label}: stamped with the live reading`).toEqual(clock);
      expect(fold, `${label}: premise, the fold's own answer`).toBe(ok);
      expect(slot.policyOk, `${label}: the slot agrees with the fold`).toBe(ok);
      if (!ok) {
        expect(slot.policyMessage, label).toContain("pad.football.context.sub.blocked.subWindows");
        expect(slot.policyMessage, `${label}: worded with the cap in force (Law 3: three)`).toContain(`"windows":${LAW3_WINDOWS}`);
      }
    }
    expect(cases.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Ruling 154: a substitution's stamp.
// ---------------------------------------------------------------------------------------------------------------------

let seq = 0;
const row = (type: string, at?: GameTimeStamp, over: Partial<SubLedgerRow> = {}): SubLedgerRow => ({
  id: `e${++seq}`,
  type,
  payload: at === undefined ? {} : { by: "H", at },
  ...over,
});
const H2 = (elapsed: number): GameTimeStamp => ({ period: "H2", elapsed });

describe("ruling 154: a substitution joins the stoppage of the sub before it, for 120 s of match time", () => {
  it("the window is 120 s, in one named constant", () => {
    expect(SUB_STOPPAGE_SECONDS).toBe(120);
  });

  it("120 s after the stoppage's stamp joins it; 121 s does not, and takes its own reading", () => {
    const events = [row("football.sub", H2(1000))];
    expect(subStampOf(events, "H2", H2(1120), H2(1000))).toEqual(H2(1000));
    expect(subStampOf(events, "H2", H2(1121), H2(1000))).toEqual(H2(1121));
  });

  it("an opponent's substitution at the stoppage keeps it open; so does a lineup change from another screen", () => {
    const opp = [row("football.sub", H2(1000)), { ...row("football.sub", H2(1000)), payload: { by: "A", at: H2(1000) } }];
    expect(subStampOf(opp, "H2", H2(1090), H2(1000))).toEqual(H2(1000));
    for (const type of ["core.lineup.substitution", "core.lineup.replacement"]) {
      expect(subStampOf([row("football.sub", H2(1000)), row(type, H2(1000))], "H2", H2(1100), H2(1000)), type).toEqual(H2(1000));
    }
    // The newest stamped sub IS the stoppage: an opponent's own stamp 30 s later re-opens the 120 s from there.
    expect(subStampOf([row("football.sub", H2(1000)), row("football.sub", H2(1030))], "H2", H2(1140), H2(1030))).toEqual(H2(1030));
  });

  it("a goal, a card or a clock event after the sub ends the stoppage", () => {
    for (const type of ["football.goal", "football.card", "football.clock"]) {
      const events = [row("football.sub", H2(1000)), row(type, H2(1050))];
      expect(subStoppageOf(events, "H2"), type).toBeNull();
      expect(subStampOf(events, "H2", H2(1060), H2(1050)), type).toEqual(H2(1060));
    }
  });

  it("an unstamped event in between does not end it (only stamped events are read), and a VOIDED sub is no stoppage", () => {
    expect(subStampOf([row("football.sub", H2(1000)), row("football.shot")], "H2", H2(1100), H2(1000))).toEqual(H2(1000));
    const sub = row("football.sub", H2(1000));
    const withdrawn = [sub, row("core.void", undefined, { voids: sub.id })];
    expect(subStoppageOf(withdrawn, "H2")).toBeNull();
    expect(subStampOf(withdrawn, "H2", H2(1050), H2(1000))).toEqual(H2(1050));
  });

  it("a substitution in a new period never joins the last one of the period before", () => {
    const events = [row("football.sub", { period: "H1", elapsed: 2700 })];
    expect(subStoppageOf(events, "H2")).toBeNull();
    expect(subStampOf(events, "H2", H2(30), undefined)).toEqual(H2(30));
  });

  it("its own reading is floored at the fold's asOf in the same period, never at another period's", () => {
    expect(subStampOf([], "H2", H2(990), H2(1000))).toEqual(H2(1000));
    expect(subStampOf([], "H2", H2(990), { period: "H1", elapsed: 2700 })).toEqual(H2(990));
  });

  it("no live reading, or one of another period (a break, a clock nobody started), stamps nothing", () => {
    expect(subStampOf([row("football.sub", H2(1000))], "H2", undefined, H2(1000))).toBeUndefined();
    expect(subStampOf([], "H2", { period: "H1", elapsed: 2760 }, H2(0))).toBeUndefined();
  });

  it("through the pad: a joining sub carries the stoppage's stamp, a late one the live reading, a clockless one `at: undefined`", () => {
    const played = play(cfgOf({ extraTime: EXTRA_TIME }), [{ period: "H1", elapsed: 1500 }], "H1");
    const joins = verdict(played, { period: "H1", elapsed: 1500 + 90 });
    expect(joins.payload.at).toEqual({ period: "H1", elapsed: 1500 });
    const late = verdict(played, { period: "H1", elapsed: 1500 + 121 });
    expect(late.payload.at).toEqual({ period: "H1", elapsed: 1621 });
    const slot = buildSwap(viewOf(played, undefined), t)[0]!;
    const payload = slot.buildEvent("x", "y").payload as Record<string, unknown>;
    expect("at" in payload, "the key is the refusal: the host must not fill it").toBe(true);
    expect(payload.at).toBeUndefined();
  });
});

describe("ruling 154 through the real fold: windows count stoppages, as Law 3 does", () => {
  /** Plays the home subs, each stamped the way the pad would stamp it at its live reading, and returns the windows the fold counts. */
  function windowsAfter(readings: readonly GameTimeStamp[]): number {
    const cfg = cfgOf({});
    let played = play(cfg, [], "H1");
    for (const live of readings) {
      const { payload } = verdict(played, live);
      const probe = makeEnvelope(played.events.length + 1, { type: "football.sub", payload } as never);
      const events = [...played.events, probe];
      played = { cfg, events, state: foldMatch(football, cfg, lineups(cfg), events, { strictFromSeq: 1 }) };
    }
    const subs = played.state.squads.home.offUsed.length;
    expect(subs, "premise: every substitution was folded").toBe(readings.length);
    return played.state.squads.home.subWindows?.length ?? 0;
  }

  it("two subs thirty minutes apart are two windows", () => {
    expect(windowsAfter([{ period: "H1", elapsed: 600 }, { period: "H1", elapsed: 600 + 30 * 60 }])).toBe(2);
  });

  it("a double change read 45 s apart on the clock is ONE window (the stamp the old asOf rule would have split)", () => {
    expect(windowsAfter([{ period: "H1", elapsed: 600 }, { period: "H1", elapsed: 645 }])).toBe(1);
  });

  it("three subs across 2 min 30 s chain from the FIRST stamp, not the one before: the third, 150 s on, opens a second window", () => {
    expect(windowsAfter([{ period: "H1", elapsed: 600 }, { period: "H1", elapsed: 700 }, { period: "H1", elapsed: 750 }])).toBe(2);
  });
});
