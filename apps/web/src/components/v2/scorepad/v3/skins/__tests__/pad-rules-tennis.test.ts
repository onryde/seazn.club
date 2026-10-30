// Pad wave P3.2 — THE TENNIS DRIFT GUARD.
//
// The tennis skin no longer copies a rule fact: it reads `tennisPadRules` from `@seazn/engine/pad`. This file drives the skin's
// BUILDERS (the sheets' steps and options, the dock's chips, the tiles per band, the scorebug's calls and its ends-change cue)
// and compares what they offer with what the ENGINE declares or does: the padSpec fields and fidelity map the pad conformance
// suite reads, the fold's own spoken score and serve, and the strict fold's own refusals. Never against a skin constant, and
// never against a table typed here, so a copy that drifts back into the skin (whatever it is called, which the literal guard
// cannot see) goes red.
//
// Tennis only, by design: it is the nested kernel's one preset. Every sweep counts what it compared and fails on zero.
import { describe, expect, it } from "vitest";
import { EngineError, initSquads } from "@seazn/engine/core";
import type { EventEnvelope, LineupPair, SquadState } from "@seazn/engine/core";
import { padEnumValues, padNumberBound, tennisPadRules } from "@seazn/engine/pad";
import type { ModuleEvent, PadSpec } from "@seazn/engine/sport";
import { tennis } from "@seazn/engine/sports/tennis";
import { declaredCfgs, defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { foldClient } from "../../../module-client";
import { answerStep, currentStep, initialSheetState } from "../../guided-sheet";
import type { GuidedSheetStep, PadHostView } from "../../types";
import { buildDock, buildScorebug, buildSheets, buildTiles, gameAwardTileId, refusedEventTypes, sanctionSheetKey } from "../tennis";
import type { TFn } from "../tennis";

const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);
type Side = "home" | "away";
type Cfg = ReturnType<typeof tennis.configSchema.parse>;

const H = "H";
const A = "A";
const STRICT_ALL = { strictFromSeq: 0 } as const;
const LINEUPS: LineupPair = defaultLineupPair(tennis.positions);

const singles = (): SquadState =>
  initSquads({
    home: { entrantId: H, slots: [{ personId: H, slot: "starting", orderNo: 1 }] },
    away: { entrantId: A, slots: [{ personId: A, slot: "starting", orderNo: 1 }] },
  });
/** A fixture with no team sheet at all: the dock then reads the serving SIDE off the state (the tie-break server flip). */
const rosterless = (): SquadState => initSquads({ home: { entrantId: H, slots: [] }, away: { entrantId: A, slots: [] } });

function view(over: Partial<PadHostView> = {}): PadHostView {
  return {
    cfg: tennis.configSchema.parse({}),
    state: {},
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: { [H]: "Home Player", [A]: "Away Player" },
    squads: singles(),
    events: [],
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
    ...over,
  };
}

const start: ModuleEvent = { type: "core.start", payload: {} };
const point = (side: Side): ModuleEvent => ({ type: "tennis.point", payload: { by: side === "home" ? H : A } });
const summary = (home: number, away: number): ModuleEvent => ({ type: "tennis.set_summary", payload: { home, away } });
const gameAward: ModuleEvent = { type: "tennis.game.award", payload: { winner: H } };
const envelopes = (events: readonly ModuleEvent[]): EventEnvelope[] => events.map((event, i) => makeEnvelope(i, event));
const fold = (cfg: Cfg, events: readonly ModuleEvent[]) => foldClient(tennis, cfg, LINEUPS, envelopes(events), STRICT_ALL);
function refusal(cfg: Cfg, events: readonly ModuleEvent[]): { code: string; message: string } | null {
  try {
    fold(cfg, events);
    return null;
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return { code: error.code, message: error.message };
  }
}
const specOf = (cfg: Cfg): PadSpec => {
  if (tennis.padSpec === undefined) throw new Error("premise: tennis declares a padSpec");
  return tennis.padSpec(cfg);
};

/** Every declared cfg, plus an advantage set and a short set with a 10-point decider tie-break: shapes no variant ships. */
function cfgs(): { name: string; cfg: Cfg }[] {
  const variants = tennis.variants as Record<string, Record<string, unknown>>;
  return [
    ...declaredCfgs<Cfg>(tennis),
    { name: "advantage sets", cfg: tennis.configSchema.parse({ set: { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 } }) },
    { name: "short sets + a final-set tie-break to 10", cfg: tennis.configSchema.parse({ ...variants["short-sets"], finalSet: { tiebreakTo: 10 } }) },
  ];
}

/** Every fact this file compares, by kind, so the last test can hold the total. */
const compared: Record<string, number> = {};
const count = (kind: string, n = 1) => {
  compared[kind] = (compared[kind] ?? 0) + n;
};

const stepOf = (steps: readonly GuidedSheetStep[], id: string): GuidedSheetStep => {
  const step = steps.find((s) => s.id === id);
  if (step === undefined) throw new Error(`no step "${id}"`);
  return step;
};
const optionIds = (step: GuidedSheetStep): string[] => {
  if (step.kind !== "choice") throw new Error(`step "${step.id}" is a ${step.kind} step, not a choice`);
  return step.options.map((o) => o.id);
};
const maxOf = (step: GuidedSheetStep): number | undefined => (step.kind === "number" ? step.max : undefined);

describe("the sheets offer what the engine's padSpec declares, for every cfg", () => {
  it("sanction levels (both sides, ladder order), interruption kinds and duration bound, set-score bounds, best-of (counted)", () => {
    const bestOfs = new Set<number>();
    for (const { name, cfg } of cfgs()) {
      const spec = specOf(cfg);
      const live = fold(cfg, [start]);
      const sheets = buildSheets(view({ cfg, state: live }), t);
      for (const side of ["home", "away"] as const) {
        expect(optionIds(stepOf(sheets[sanctionSheetKey(side)]!.steps, "level")), `${name} ${side}`).toEqual(padEnumValues(spec, "tennis.sanction", "level"));
        count("sanction levels");
      }
      const interruption = sheets.interruption!.steps;
      expect(optionIds(stepOf(interruption, "kind")), name).toEqual(padEnumValues(spec, "tennis.interruption", "kind"));
      expect(maxOf(stepOf(interruption, "duration")), name).toBe(padNumberBound(spec, "tennis.interruption", "duration").max);
      count("interruption", 2);
      const setScore = sheets.setScore!.steps;
      for (const [id, path] of [["home", "home"], ["away", "away"], ["tbHome", "tb.home"], ["tbAway", "tb.away"]] as const) {
        expect(maxOf(stepOf(setScore, id)), `${name} ${id}`).toBe(padNumberBound(spec, "tennis.set_summary", path).max);
        count("set-score bounds");
      }
      // the context line names the cfg's own best-of (grand slam's 5, not the tour default's 3)
      expect(buildScorebug(view({ cfg, state: live }), t).context, name).toContain(`"bestOf":${cfg.bestOf}`);
      bestOfs.add(cfg.bestOf);
      count("best of");
    }
    expect([...bestOfs].sort()).toEqual([3, 5]);
  });

  it("the point dock offers exactly the engine's point kinds between its two sides of the net, in the engine's order", () => {
    const cfg = tennis.configSchema.parse({});
    const declared = padEnumValues(specOf(cfg), "tennis.point", "meta.kind");
    const live = view({ cfg, state: fold(cfg, [start]) });
    const byServer = buildDock("tennis.point", live, t, { by: H, server: H })!.chips.map((c) => c.id);
    const byReceiver = buildDock("tennis.point", live, t, { by: A, server: H })!.chips.map((c) => c.id);
    const unknownServer = buildDock("tennis.point", view({ cfg, state: fold(cfg, [start]), squads: singles() }), t, { by: A })!.chips.map((c) => c.id);
    expect(new Set([...byServer, ...byReceiver])).toEqual(new Set(declared));
    for (const chips of [byServer, byReceiver, unknownServer]) {
      expect(chips, "each dock keeps the engine's order").toEqual(declared.filter((kind) => chips.includes(kind)));
      expect(chips.length).toBeGreaterThan(0);
    }
    // an ace is the server's point and a double fault the receiver's: neither side is offered both
    expect(byServer.filter((k) => !byReceiver.includes(k)).length).toBeGreaterThan(0);
    expect(byReceiver.filter((k) => !byServer.includes(k)).length).toBeGreaterThan(0);
    count("point kinds", 3);
  });
});

describe("the tiles follow the engine's fidelity map, band by band", () => {
  it("each tile's event type is offered exactly at the bands its fidelity allows; the point half likewise (counted)", () => {
    const cfg = tennis.configSchema.parse({});
    const fidelity = specOf(cfg).fidelity;
    const state = fold(cfg, [start]);
    const tileTypes: [string, string][] = [
      [sanctionSheetKey("home"), "tennis.sanction"],
      [sanctionSheetKey("away"), "tennis.sanction"],
      ["interruption", "tennis.interruption"],
      ["setScore", "tennis.set_summary"],
      [gameAwardTileId("home"), "tennis.game.award"],
      [gameAwardTileId("away"), "tennis.game.award"],
    ];
    for (const band of [0, 1, 2, 3] as const) {
      const tiles = buildTiles(view({ cfg, state, band })).map((tile) => tile.id);
      for (const [id, type] of tileTypes) {
        expect(tiles.includes(id), `band ${band} ${id}`).toBe(band >= fidelity[type]!);
        count("band gates");
      }
      const half = buildScorebug(view({ cfg, state, band }), t).halves[0]!;
      expect(half.tappable, `band ${band} point half`).toBe(band >= fidelity["tennis.point"]!);
      count("band gates");
    }
  });
});

describe("the scorebug's calls are the fold's own spoken game score", () => {
  it("at every standard game score, deuce and both advantages included (counted)", () => {
    const cfg = tennis.configSchema.parse({});
    const seen: string[][] = [];
    for (let home = 0; home <= 3; home++) {
      for (let away = 0; away <= 3; away++) {
        const base = [start, ...Array<ModuleEvent>(home).fill(point("home")), ...Array<ModuleEvent>(away).fill(point("away"))];
        const scores = home === 3 && away === 3 ? [base, [...base, point("home")], [...base, point("away")]] : [base];
        for (const events of scores) {
          const state = fold(cfg, events);
          const spoken = (tennis.summary(state).detail as { game?: unknown }).game;
          if (typeof spoken !== "string") throw new Error("premise: the fold speaks the game score");
          // the skin capitalises the advantage call ("AD"); the fold writes "Ad" - the casing is presentation
          const [homeCall, awayCall] = spoken.toUpperCase().split("–");
          const halves = buildScorebug(view({ cfg, state }), t).halves;
          expect([halves[0]!.big, halves[1]!.big], spoken).toEqual([homeCall, awayCall]);
          seen.push([halves[0]!.big, halves[1]!.big]);
          count("calls");
        }
      }
    }
    expect(seen).toHaveLength(18);
  });
});

describe("the ends-change cue is the engine's ITF Rule 10 reading", () => {
  const cfg = tennis.configSchema.parse({});
  const mtb10 = tennis.configSchema.parse(tennis.variants["doubles-noad-mtb10"]);
  const game = (side: Side): ModuleEvent[] => Array<ModuleEvent>(4).fill(point(side));
  const twelveGames = Array.from({ length: 12 }, (_, i) => game(i % 2 === 0 ? "home" : "away")).flat();
  const breakerPoints = (n: number) => Array.from({ length: n }, (_, i) => point(i % 2 === 0 ? "home" : "away"));
  const cue = (c: Cfg, events: ModuleEvent[]) => buildScorebug(view({ cfg: c, state: fold(c, events) }), t).strip.some((s) => s.id === "ends");

  it("follows tennisPadRules.endsChanged at every step through a tie-break set and into the next (counted, both answers seen)", () => {
    const events: ModuleEvent[] = [start, ...twelveGames, ...breakerPoints(12), point("home"), point("home"), ...game("away"), ...game("home")];
    let shown = 0;
    for (let n = 1; n <= events.length; n++) {
      const prefix = events.slice(0, n);
      const state = fold(cfg, prefix);
      const has = buildScorebug(view({ cfg, state }), t).strip.some((s) => s.id === "ends");
      expect(has, `after ${n} events`).toBe(tennisPadRules.endsChanged(state));
      if (has) shown++;
      count("ends cue");
    }
    expect(shown).toBeGreaterThan(5);
    expect(events.length - shown).toBeGreaterThan(5);
  });

  it("the cases where a by-the-count reading goes wrong: inside a tie-break, at a set boundary, in a match tie-break", () => {
    // Rule 10 / 5(b): a tie-break changes ends after every six points, so after the 7th the last changeover was not one
    expect(cue(cfg, [start, ...twelveGames, ...breakerPoints(6)])).toBe(true);
    expect(cue(cfg, [start, ...twelveGames, ...breakerPoints(7)])).toBe(false);
    expect(cue(cfg, [start, ...twelveGames, ...breakerPoints(12)])).toBe(true);
    // Rule 10: the ends change at the end of a set of an odd total (6-3), not of an even one (6-4)
    expect(cue(cfg, [start, summary(6, 3)])).toBe(true);
    expect(cue(cfg, [start, summary(6, 4)])).toBe(false);
    // a match tie-break after an odd second set opens on a change of ends
    expect(cue(mtb10, [start, summary(6, 0), summary(3, 6)])).toBe(true);
    expect(cue(mtb10, [start, summary(6, 0), summary(3, 6), ...breakerPoints(6)])).toBe(true);
    expect(cue(mtb10, [start, summary(6, 0), summary(3, 6), ...breakerPoints(7)])).toBe(false);
    // no cue once the match is over
    expect(cue(cfg, [start, summary(6, 4), summary(6, 3)])).toBe(false);
    count("ends cue", 9);
  });
});

describe("the set-score sheet asks for the tie-break's points exactly when the strict fold refuses the score without them", () => {
  it("first set and deciding set, every cfg, every score to the field bound (counted)", () => {
    let cells = 0;
    let asked = 0;
    for (const { name, cfg } of cfgs()) {
      const need = Math.ceil(cfg.bestOf / 2) - 1;
      const toDecider = Array.from({ length: need }, () => [summary(cfg.set.gamesTo, 0), summary(0, cfg.set.gamesTo)]).flat();
      for (const before of [[start], [start, ...toDecider]]) {
        const state = fold(cfg, before);
        const sheet = buildSheets(view({ cfg, state }), t).setScore!;
        const limit = Math.min(tennisPadRules.gamesFieldBound(cfg), 15);
        for (let home = 0; home <= limit; home++) {
          for (let away = 0; away <= limit; away++) {
            // the step after both games are entered is the tie-break's, or none
            const afterHome = answerStep(sheet, initialSheetState(), String(home));
            if (afterHome.done) throw new Error("premise: the away games are asked after the home games");
            const afterAway = answerStep(sheet, afterHome.state, String(away));
            const asksTiebreak = !afterAway.done && currentStep(sheet, afterAway.state)?.id === "tbHome";
            const why = refusal(cfg, [...before, summary(home, away)]);
            const refusedWithoutTb = why !== null && why.code === "INVALID_EVENT" && /include its points as tb/.test(why.message);
            expect(asksTiebreak, `${name} ${before.length === 1 ? "first" : "deciding"} set ${home}-${away}`).toBe(refusedWithoutTb);
            cells++;
            if (asksTiebreak) asked++;
          }
        }
      }
    }
    count("tie-break shape", cells);
    expect(cells).toBeGreaterThan(1000);
    expect(asked).toBeGreaterThan(0);
  });
});

describe("game award: the tiles and the More sheet withhold it exactly when the strict fold refuses it", () => {
  it("in a standard game, a tie-break and a match tie-break (counted, both answers seen)", () => {
    const cfg = tennis.configSchema.parse({});
    const mtb10 = tennis.configSchema.parse(tennis.variants["doubles-noad-mtb10"]);
    const twelveGames = Array.from({ length: 12 }, (_, i) => Array<ModuleEvent>(4).fill(point(i % 2 === 0 ? "home" : "away"))).flat();
    const cases: [string, Cfg, ModuleEvent[]][] = [
      ["start", cfg, [start]],
      ["mid-game", cfg, [start, point("home"), point("away")]],
      ["6-6, the tie-break", cfg, [start, ...twelveGames]],
      ["inside the tie-break", cfg, [start, ...twelveGames, point("home"), point("away"), point("home")]],
      ["the match tie-break", mtb10, [start, summary(6, 0), summary(3, 6)]],
      ["inside the match tie-break", mtb10, [start, summary(6, 0), summary(3, 6), point("away")]],
    ];
    let refusedSeen = 0;
    for (const [name, c, events] of cases) {
      const refused = refusal(c, [...events, gameAward])?.code === "GAME_AWARD_DURING_TIEBREAK";
      const v = view({ cfg: c, state: fold(c, events) });
      const tiles = buildTiles(v).map((tile) => tile.id);
      expect(tiles.includes(gameAwardTileId("home")), name).toBe(!refused);
      expect(tiles.includes(gameAwardTileId("away")), name).toBe(!refused);
      expect(refusedEventTypes(v).includes("tennis.game.award"), name).toBe(refused);
      count("game award", 3);
      if (refused) refusedSeen++;
    }
    expect(refusedSeen).toBe(4);
  });
});

describe("the rosterless dock reads the tie-break server the fold served, after the serve has turned over", () => {
  it("after every tie-break point, an ace is offered exactly to the side that served it (counted)", () => {
    const cfg = tennis.configSchema.parse({});
    const twelveGames = Array.from({ length: 12 }, (_, i) => Array<ModuleEvent>(4).fill(point(i % 2 === 0 ? "home" : "away"))).flat();
    const events: ModuleEvent[] = [start, ...twelveGames];
    // stays level to 6-6 (12 points, still the tie-break), and is not alternating, so the winner and the server part company
    const winners: Side[] = ["home", "home", "away", "away", "home", "away", "away", "home", "home", "away", "away", "home"];
    let points = 0;
    let byServer = 0;
    for (const [i, by] of winners.entries()) {
      const n = i + 1;
      const served = fold(cfg, events).serving; // the fold's server of the point about to be played
      events.push(point(by));
      const state = fold(cfg, events);
      expect(state.points.kind, "premise: still inside the tie-break").toBe("tiebreak");
      const chips = buildDock("tennis.point", view({ cfg, state, squads: rosterless() }), t, { by: by === "home" ? H : A })!.chips.map((c) => c.id);
      expect(chips.includes("ace"), `point ${n} won by ${by}, served by ${served}`).toBe(by === served);
      expect(chips.includes("double_fault"), `point ${n} won by ${by}, served by ${served}`).toBe(by !== served);
      points++;
      if (by === served) byServer++;
    }
    count("tie-break server", points);
    expect(points).toBe(12);
    expect(byServer, "both a server's and a receiver's point were compared").toBeGreaterThan(0);
    expect(points - byServer).toBeGreaterThan(0);
  });
});

describe("anti-vacuity", () => {
  it("every kind of fact was compared, and the total clears the plan's floor of 11", () => {
    const total = Object.values(compared).reduce((a, b) => a + b, 0);
    console.info(`[pad-rules-tennis] facts compared: ${total} (${Object.entries(compared).map(([k, n]) => `${k} ${n}`).join(", ")})`);
    expect(Object.keys(compared).sort()).toEqual(
      ["band gates", "best of", "calls", "ends cue", "game award", "interruption", "point kinds", "sanction levels", "set-score bounds", "tie-break server", "tie-break shape"].sort(),
    );
    expect(total).toBeGreaterThanOrEqual(11);
  });
});
