// Pad wave P3.1 — THE SET-BASED DRIFT GUARD. Badminton, table tennis and volleyball each used to carry their own copy of
// set-based rule facts (sanction ladders, fidelity bands, the set-score bound, the deuce/golden-point wording, the
// interval mark, the expedite threshold and floor, the libero band, the rotation cycle). They now read them from
// `@seazn/engine/pad`. This file stops a copy growing back under any name: it drives each skin's BUILDERS (the sanction
// sheet's options, the set-score sheet's `max`, the tiles a band shows, the scorebug's context line and strip, the
// expedite tile and dock) over states the REAL fold produced, and compares what they offer with the engine's own
// declaration: `padSpec(cfg)` and its fidelity map, the fold's acceptance, or the pad record. Never a constant the skin
// exports, and never a table typed here (AGENTS.md class 19, Review Focus 1).
//
// Every fact runs at two or more DECLARED cfgs per sport (`declaredCfgs`, plus a custom one where a rule needs it), so a
// fact read once at module load from the default cfg goes red at the second (Review Focus 2). The file reports how many
// facts it compared, and fewer than 20 is a failure.
//
// Single-sport reason: these are the three skins of the set-based kernel; each sport's own builder is what is driven.
import { describe, expect, it } from "vitest";
import type { EventEnvelope, Lineup, LineupPair } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import {
  badmintonPadRules,
  padEnumValues,
  padNumberBound,
  tabletennisPadRules,
  volleyballPadRules,
  type SetBasedPadRules,
} from "@seazn/engine/pad";
import type { FidelityBand, ModuleEvent } from "@seazn/engine/sport";
import { entrantKindCap } from "@seazn/engine/sport";
import { badminton, tabletennis, volleyball, type SetBasedCfg, type SetBasedModule, type SetBasedState } from "@seazn/engine/sports/setbased";
import { declaredCfgs, makeEnvelope } from "@seazn/engine/testkit";
import { foldClient } from "../../../module-client";
import type { GuidedSheetSpec, PadHostView, ScorebugSpec, TileSpec } from "../../types";
import * as bd from "../badminton";
import { SANCTION_LEVEL_STEP_ID } from "../sanction-ending";
import * as tt from "../tabletennis";
import * as vb from "../volleyball";

type TFn = (key: string, vars?: Record<string, string | number>) => string;
/** Echoes its input, vars included, so a built string names the key and the numbers it was built from. */
const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

type Side = "home" | "away";
const SIDES: readonly Side[] = ["home", "away"];

interface Skin {
  readonly key: "badminton" | "tabletennis" | "volleyball";
  readonly module: SetBasedModule;
  readonly rules: SetBasedPadRules;
  readonly lineups: (cfg: SetBasedCfg) => LineupPair;
  readonly RALLY_TYPE: string;
  readonly SUMMARY_TYPE: string;
  readonly SANCTION_TYPE: string;
  readonly SET_SCORE_TILE_ID: string;
  readonly sanctionSheetKey: (side: Side) => string;
  readonly sheets: (view: PadHostView) => Record<string, GuidedSheetSpec>;
  readonly scorebug: (view: PadHostView) => ScorebugSpec;
  readonly tiles: (view: PadHostView) => TileSpec[];
  /** The context-line key for each deuceNote answer. Wording is the skin's own (presentation); WHEN it shows is the rule. */
  readonly noteKey: { readonly goldenPoint: string; readonly setting: string };
}

const singles = (entrantId: string): Lineup => ({ entrantId, slots: [{ personId: `${entrantId}1`, slot: "starting", orderNo: 1 }] });
const SINGLES: LineupPair = { home: singles("H"), away: singles("A") };

const COURT = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;
/** Six starters and a bench whose first member is a libero (FIVB's catalog shape). */
function team(entrantId: string): Lineup {
  return {
    entrantId,
    slots: [
      ...COURT.map((positionKey, i) => ({ personId: `${entrantId}-p${i + 1}`, positionKey, slot: "starting" as const, orderNo: i + 1 })),
      { personId: `${entrantId}-lib`, slot: "bench" as const, orderNo: 7, roles: ["libero"] },
      { personId: `${entrantId}-b2`, slot: "bench" as const, orderNo: 8 },
    ],
  };
}
const pair = (entrantId: string): Lineup => ({
  entrantId,
  slots: [
    { personId: `${entrantId}-a`, slot: "starting", orderNo: 1, pairOrder: 1 },
    { personId: `${entrantId}-b`, slot: "starting", orderNo: 2, pairOrder: 2 },
  ],
});
const TEAM: LineupPair = { home: team("H"), away: team("A") };
const PAIR: LineupPair = { home: pair("H"), away: pair("A") };

const SKINS: readonly Skin[] = [
  {
    key: "badminton",
    module: badminton,
    rules: badmintonPadRules,
    lineups: () => SINGLES,
    RALLY_TYPE: bd.RALLY_TYPE,
    SUMMARY_TYPE: bd.SUMMARY_TYPE,
    SANCTION_TYPE: bd.SANCTION_TYPE,
    SET_SCORE_TILE_ID: bd.SET_SCORE_TILE_ID,
    sanctionSheetKey: bd.sanctionSheetKey,
    sheets: (view) => bd.buildSheets(view, t),
    scorebug: (view) => bd.buildScorebug(view, t),
    tiles: (view) => bd.buildTiles(view),
    noteKey: { goldenPoint: "pad.badminton.context.goldenPoint", setting: "pad.badminton.context.setting" },
  },
  {
    key: "tabletennis",
    module: tabletennis,
    rules: tabletennisPadRules,
    lineups: () => SINGLES,
    RALLY_TYPE: tt.RALLY_TYPE,
    SUMMARY_TYPE: tt.SUMMARY_TYPE,
    SANCTION_TYPE: tt.SANCTION_TYPE,
    SET_SCORE_TILE_ID: tt.SET_SCORE_TILE_ID,
    sanctionSheetKey: tt.sanctionSheetKey,
    sheets: (view) => tt.buildSheets(view),
    scorebug: (view) => tt.buildScorebug(view, t),
    tiles: (view) => tt.buildTiles(view),
    noteKey: { goldenPoint: "pad.tabletennis.context.goldenPoint", setting: "pad.tabletennis.context.deuce" },
  },
  {
    key: "volleyball",
    module: volleyball,
    rules: volleyballPadRules,
    lineups: (cfg) => (cfg.records.substitutions ? TEAM : PAIR),
    RALLY_TYPE: vb.RALLY_TYPE,
    SUMMARY_TYPE: vb.SUMMARY_TYPE,
    SANCTION_TYPE: vb.SANCTION_TYPE,
    SET_SCORE_TILE_ID: vb.SET_SCORE_TILE_ID,
    sanctionSheetKey: vb.sanctionSheetKey,
    sheets: (view) => vb.buildSheets(view, t),
    scorebug: (view) => vb.buildScorebug(view, t),
    tiles: (view) => vb.buildTiles(view),
    noteKey: { goldenPoint: "pad.volleyball.context.goldenPoint", setting: "pad.volleyball.context.deuce" },
  },
];

const cfgsOf = (module: SetBasedModule) => declaredCfgs<SetBasedCfg>(module);

function specOf(module: SetBasedModule, cfg: SetBasedCfg) {
  if (module.padSpec === undefined) throw new Error(`${module.key} declares no padSpec`);
  return module.padSpec(cfg);
}

const envelopes = (events: readonly ModuleEvent[]): EventEnvelope[] =>
  [{ type: "core.start", payload: {} } as ModuleEvent, ...events].map((event, i) => makeEnvelope(i, event));

/** A view whose state is the REAL fold of `events` (after a core.start), strict when asked: the write path's refusals. */
function view(skin: Skin, cfg: SetBasedCfg, events: readonly ModuleEvent[] = [], band: FidelityBand = 3, strict = false): PadHostView {
  const lineups = skin.lineups(cfg);
  const ledger = envelopes(events);
  const state = foldClient(skin.module, cfg, lineups, ledger, strict ? { strictFromSeq: 0 } : undefined);
  return {
    cfg,
    state,
    summary: {},
    phase: "live",
    band,
    entitlements: {},
    personNames: {},
    squads: initSquads(lineups),
    events: ledger,
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
  };
}

const rally = (skin: Skin, wonBy: "H" | "A", extra: Record<string, unknown> = {}): ModuleEvent => ({
  type: skin.RALLY_TYPE,
  payload: { wonBy, ...extra },
});
const levelAt = (skin: Skin, n: number): ModuleEvent[] =>
  Array.from({ length: 2 * n }, (_, i) => rally(skin, i % 2 === 0 ? "H" : "A"));
/** Closed sets to love, alternating winners from H: what it takes to reach set `index`. */
const setsBefore = (skin: Skin, cfg: SetBasedCfg, index: number): ModuleEvent[] =>
  Array.from({ length: index }, (_, i) => {
    const to = skin.rules.setTarget(cfg, i);
    return { type: skin.SUMMARY_TYPE, payload: i % 2 === 0 ? { home: to, away: 0 } : { home: 0, away: to } };
  });

/** Facts compared, across the whole file. Read by the last test. */
let compared = 0;
const fact = (): void => {
  compared++;
};

describe("each skin's sanction sheet and set-score sheet offer what padSpec(cfg) declares", () => {
  it("BD-SN-1 VB-SN-1 the sanction level options are padSpec's enum, in its order, per side, at every declared cfg", () => {
    for (const skin of SKINS) {
      for (const { name, cfg } of cfgsOf(skin.module)) {
        const declared = padEnumValues(specOf(skin.module, cfg), skin.SANCTION_TYPE, "level");
        const sheets = skin.sheets(view(skin, cfg));
        for (const side of SIDES) {
          const step = sheets[skin.sanctionSheetKey(side)]?.steps.find((s) => s.id === SANCTION_LEVEL_STEP_ID);
          expect(step?.kind, `${skin.key} ${name} ${side}`).toBe("choice");
          const offered = step?.kind === "choice" ? step.options.map((option) => option.id) : [];
          expect(offered, `${skin.key} ${name} ${side}`).toEqual([...declared]);
          fact();
        }
      }
    }
  });

  // Every declared badminton cfg is capped and every declared table tennis / volleyball cfg is uncapped, so each sport gets
  // the OTHER branch too: `cap` is an organiser key for badminton and volleyball, and the schema allows it for table tennis.
  const OTHER_BRANCH: Readonly<Record<Skin["key"], { name: string; cfg: SetBasedCfg }>> = {
    badminton: { name: "uncapped", cfg: badminton.configSchema.parse({ cap: null }) },
    tabletennis: { name: "capped 15", cfg: tabletennis.configSchema.parse({ cap: 15 }) },
    volleyball: { name: "capped 30", cfg: volleyball.configSchema.parse({ cap: 30 }) },
  };

  it("BD-SC-2 TT-SC-2 VB-SC-2 the set-score fields' max is padSpec's bound, both fields, at every declared cfg plus one cfg on the other cap branch", () => {
    for (const skin of SKINS) {
      const cfgs = [...cfgsOf(skin.module), OTHER_BRANCH[skin.key]];
      // Both branches of the bound are met, so neither can be re-typed in a skin unseen.
      expect(new Set(cfgs.map(({ cfg }) => cfg.cap === null)).size, skin.key).toBe(2);
      for (const { name, cfg } of cfgs) {
        const spec = specOf(skin.module, cfg);
        const sheet = skin.sheets(view(skin, cfg))[skin.SET_SCORE_TILE_ID];
        for (const field of ["home", "away"] as const) {
          const step = sheet?.steps.find((s) => s.id === field);
          expect(step?.kind, `${skin.key} ${name} ${field}`).toBe("number");
          expect(step?.kind === "number" ? step.max : undefined, `${skin.key} ${name} ${field}`).toBe(
            padNumberBound(spec, skin.SUMMARY_TYPE, field).max,
          );
          fact();
        }
      }
    }
  });
});

describe("the tiles a band shows follow padSpec's fidelity map", () => {
  it("sanction tiles, the set-score tile and the tappable halves appear exactly at the bands the fidelity map allows", () => {
    for (const skin of SKINS) {
      for (const { name, cfg } of cfgsOf(skin.module).slice(0, 2)) {
        const bands = specOf(skin.module, cfg).fidelity;
        for (const band of [0, 1, 2, 3] as const) {
          const v = view(skin, cfg, [], band);
          const ids = skin.tiles(v).map((tile) => tile.id);
          const at = `${skin.key} ${name} band ${band}`;
          expect(ids.includes(skin.sanctionSheetKey("home")), `${at} sanction`).toBe(band >= bands[skin.SANCTION_TYPE]!);
          expect(ids.includes(skin.SET_SCORE_TILE_ID), `${at} set score`).toBe(band >= bands[skin.SUMMARY_TYPE]!);
          expect(skin.scorebug(v).halves.every((half) => half.tappable === band >= bands[skin.RALLY_TYPE]!), `${at} halves`).toBe(true);
          fact();
          fact();
          fact();
        }
      }
    }
  });
});

describe("BD-SC-1 TT-SC-1 VB-SC-1 the context line: Best of N and the deuce note come from the pad record, over real folds", () => {
  it("names the cfg's own bestOf at every declared cfg", () => {
    for (const skin of SKINS) {
      for (const { name, cfg } of cfgsOf(skin.module)) {
        expect(skin.scorebug(view(skin, cfg)).context, `${skin.key} ${name}`).toContain(`"bestOf":${skin.rules.bestOf(cfg)}`);
        fact();
      }
    }
  });

  // A capped and an uncapped cfg per sport where the sport declares one, the deciding set where its target differs, and a
  // custom win-by-one cfg where the old skin constant ("setting" at target-1 all) was wrong.
  const SWEEPS: readonly { skin: Skin; label: string; cfg: SetBasedCfg; index: number }[] = [
    { skin: SKINS[0]!, label: "bwf", cfg: badminton.configSchema.parse(badminton.variants.bwf), index: 0 },
    { skin: SKINS[0]!, label: "short", cfg: badminton.configSchema.parse(badminton.variants.short), index: 0 },
    { skin: SKINS[0]!, label: "win-by-one", cfg: badminton.configSchema.parse({ winBy: 1 }), index: 0 },
    { skin: SKINS[1]!, label: "default (uncapped)", cfg: tabletennis.configSchema.parse({}), index: 0 },
    { skin: SKINS[1]!, label: "hardbat-21", cfg: tabletennis.configSchema.parse(tabletennis.variants["hardbat-21"]), index: 0 },
    { skin: SKINS[1]!, label: "capped 15", cfg: tabletennis.configSchema.parse({ cap: 15 }), index: 0 },
    { skin: SKINS[2]!, label: "beach set 1", cfg: volleyball.configSchema.parse(volleyball.variants.beach), index: 0 },
    { skin: SKINS[2]!, label: "beach deciding set", cfg: volleyball.configSchema.parse(volleyball.variants.beach), index: 2 },
    { skin: SKINS[2]!, label: "capped 7", cfg: volleyball.configSchema.parse({ setTo: 5, finalSetTo: 5, cap: 7 }), index: 0 },
  ];

  it("shows the golden-point / setting wording exactly where the engine's deuceNote says, at every level score of the set", () => {
    let golden = 0;
    let setting = 0;
    for (const { skin, label, cfg, index } of SWEEPS) {
      const before = setsBefore(skin, cfg, index);
      const target = skin.rules.setTarget(cfg, index);
      // The last level score the set can show: target-1 all under win-by-one (the next point ends it), cap-1 all under a cap,
      // and a few ties past the target when uncapped.
      const through = cfg.winBy <= 1 ? target - 1 : cfg.cap === null ? target + 3 : cfg.cap - 1;
      for (let n = 1; n <= through; n++) {
        const v = view(skin, cfg, [...before, ...levelAt(skin, n)]);
        const set = (v.state as SetBasedState).sets[index];
        expect(set !== undefined && !set.closed && set.home === n && set.away === n, `${skin.key} ${label} ${n}-all is a level open set`).toBe(true);
        const note = skin.rules.deuceNote(v.state, cfg);
        const context = skin.scorebug(v).context;
        expect(context.includes(skin.noteKey.goldenPoint), `${skin.key} ${label} ${n}-all golden`).toBe(note === "goldenPoint");
        expect(context.includes(skin.noteKey.setting), `${skin.key} ${label} ${n}-all setting`).toBe(note === "setting");
        if (note === "goldenPoint") golden++;
        if (note === "setting") setting++;
        fact();
      }
    }
    // Both wordings are reached, so the sweep cannot pass by never meeting one.
    expect(golden).toBeGreaterThan(0);
    expect(setting).toBeGreaterThan(0);
  });

  it("drops the note on a board decided at a tie (a retirement, a disqualification, an abandon), where the set still reads level", () => {
    const endings: readonly ModuleEvent[] = [
      { type: "core.forfeit", payload: { by: "A", reason: "retired" } },
      { type: "core.forfeit", payload: { by: "A", reason: "disqualified" } },
      { type: "core.abandon", payload: { reason: "weather" } },
    ];
    let checked = 0;
    for (const skin of SKINS) {
      const cfg = skin.module.configSchema.parse({});
      const n = skin.rules.setTarget(cfg, 0) + 1;
      // The positive pair: live at the same tie, the note is on the board.
      expect(skin.scorebug(view(skin, cfg, levelAt(skin, n))).context, `${skin.key} ${n}-all live`).toContain(skin.noteKey.setting);
      for (const ending of endings) {
        const v = view(skin, cfg, [...levelAt(skin, n), ending]);
        const set = (v.state as SetBasedState).sets[0];
        expect(set !== undefined && !set.closed && set.home === n && set.away === n, `${skin.key} ${ending.type} leaves the set level`).toBe(true);
        expect(skin.rules.deuceNote(v.state, cfg), `${skin.key} ${ending.type}`).toBeNull();
        const context = skin.scorebug(v).context;
        expect(context.includes(skin.noteKey.goldenPoint) || context.includes(skin.noteKey.setting), `${skin.key} ${ending.type}: ${context}`).toBe(false);
        checked++;
        fact();
      }
    }
    expect(checked).toBe(SKINS.length * endings.length);
  });
});

describe("badminton's strip: the interval mark and the service court", () => {
  const skin = SKINS[0]!;
  const strip = (v: PadHostView, id: string) => skin.scorebug(v).strip.find((item) => item.id === id);

  it("BD-IN-1 announces the interval ahead at the engine's mark for the game about to be played, deciding game included", () => {
    const cases: readonly { label: string; cfg: SetBasedCfg; index: number }[] = [
      { label: "bwf", cfg: badminton.configSchema.parse(badminton.variants.bwf), index: 0 },
      { label: "bwf-3x15", cfg: badminton.configSchema.parse(badminton.variants["bwf-3x15"]), index: 0 },
      { label: "short", cfg: badminton.configSchema.parse(badminton.variants.short), index: 0 },
      { label: "deciding game to 15", cfg: badminton.configSchema.parse({ setTo: 21, finalSetTo: 15, cap: 30 }), index: 2 },
    ];
    for (const { label, cfg, index } of cases) {
      const item = strip(view(skin, cfg, setsBefore(skin, cfg, index)), "interval");
      expect(item?.value, label).toBe(String(badmintonPadRules.intervalMark(cfg, index)));
      fact();
    }
  });

  it("BD-CT-1 names the service court the engine names for the serving side's score, both sides serving", () => {
    const cfg = badminton.configSchema.parse({});
    const courtKey = { right: "pad.badminton.scorebug.strip.court.right", left: "pad.badminton.scorebug.strip.court.left" } as const;
    let checked = 0;
    for (let home = 1; home <= 4; home++) {
      const events = Array.from({ length: home }, () => rally(skin, "H"));
      expect(strip(view(skin, cfg, events), "court")?.value, `home serving on ${home}`).toBe(courtKey[badmintonPadRules.serviceCourt(home)]);
      for (let away = 1; away <= 3; away++) {
        const both = [...events, ...Array.from({ length: away }, () => rally(skin, "A"))];
        expect(strip(view(skin, cfg, both), "court")?.value, `away serving on ${away}`).toBe(courtKey[badmintonPadRules.serviceCourt(away)]);
        checked++;
      }
      checked++;
    }
    expect(checked).toBe(16);
    compared += checked;
  });
});

describe("table tennis: the expedite tile and the 13-return question", () => {
  const skin = SKINS[1]!;
  const EXPEDITE: ModuleEvent = { type: tt.EXPEDITE_TYPE, payload: {} };

  it("TT-EX-2 offers Start expedite until both reach the engine's floor, and refuses it in the More sheet exactly when the tile is gone", () => {
    const floor = tabletennisPadRules.expediteScoreFloor;
    const cfgs = cfgsOf(tabletennis).filter(({ cfg }) => cfg.records.expedite);
    expect(cfgs.length).toBeGreaterThanOrEqual(2);
    for (const { name, cfg } of cfgs) {
      const scores: readonly (readonly [number, number])[] = [[floor - 1, floor - 1], [floor, floor - 1], [floor - 1, floor], [floor, floor]];
      for (const [home, away] of scores) {
        const lead = Math.min(home, away);
        const events = [...levelAt(skin, lead), ...Array.from({ length: home - lead }, () => rally(skin, "H")), ...Array.from({ length: away - lead }, () => rally(skin, "A"))];
        const v = view(skin, cfg, events);
        const shown = skin.tiles(v).some((tile) => tile.id === tt.EXPEDITE_START_TILE_ID);
        expect(shown, `${name} ${home}-${away}`).toBe(!(home >= floor && away >= floor));
        expect(tt.refusedEventTypes(v).includes(tt.EXPEDITE_TYPE), `${name} ${home}-${away} More`).toBe(!shown);
        fact();
      }
      // Once in force the tile goes, because the fold refuses a second start.
      const started = view(skin, cfg, [EXPEDITE]);
      expect(skin.tiles(started).some((tile) => tile.id === tt.EXPEDITE_START_TILE_ID), `${name} in force`).toBe(false);
      expect(() => view(skin, cfg, [EXPEDITE, EXPEDITE], 3, true), `${name} second start`).toThrow();
      fact();
    }
  });

  it("TT-EX-1 asks the 13-return question exactly for the rallies the fold accepts at the engine's threshold, and stamps that threshold", () => {
    const cfg = tabletennis.configSchema.parse({});
    const ids = { home: "H", away: "A" } as const;
    const v = view(skin, cfg, [EXPEDITE]);
    let checked = 0;
    for (const serving of SIDES) {
      for (const winner of SIDES) {
        const payload = { wonBy: ids[winner], serving: ids[serving], scorer: `${ids[winner]}1` };
        const dock = tt.buildDock(tt.RALLY_TYPE, v, t, payload);
        const chip = dock?.chips.find((c) => c.id === "expediteReturn");
        let accepted = true;
        try {
          view(skin, cfg, [EXPEDITE, rally(skin, ids[winner], { serving: ids[serving], returns: tabletennisPadRules.expediteReturns })], 3, true);
        } catch {
          accepted = false;
        }
        expect(chip !== undefined, `${serving} served, ${winner} won`).toBe(accepted);
        if (chip !== undefined) expect(chip.mutate(payload).returns).toBe(tabletennisPadRules.expediteReturns);
        checked++;
      }
    }
    expect(checked).toBe(4);
    compared += checked;
  });
});

describe("volleyball: the libero band and the rotation cycle", () => {
  const skin = SKINS[2]!;

  it("VB-LB-1 offers the libero swap from the engine's liberoBand up, and not below it", () => {
    const cfg = volleyball.configSchema.parse(volleyball.variants.indoor);
    for (const band of [0, 1, 2, 3] as const) {
      const v = view(skin, cfg, [], band);
      const tiles = skin.tiles(v).map((tile) => tile.id);
      const offered = band >= volleyballPadRules.liberoBand;
      expect(tiles.includes(vb.liberoSwapSlotId("home")), `band ${band} tile`).toBe(offered);
      expect(vb.buildSwap(v, t).some((slot) => slot.id === vb.liberoSwapSlotId("home")), `band ${band} swap`).toBe(offered);
      fact();
    }
  });

  it("VB-RC-1 asks a side to field the engine's rotation cycle indoors and a pair on the beach", () => {
    for (const { name, cfg } of cfgsOf(volleyball)) {
      const expected = cfg.records.substitutions ? volleyball.serveRotation.rotationCycle : entrantKindCap("pair");
      expect(vb.playersToField(view(skin, cfg)), name).toBe(expected);
      fact();
    }
  });

  it("VB-RC-1 reserves every rotation number 1..cycle for the strip's rotation slot", () => {
    const cfg = volleyball.configSchema.parse(volleyball.variants.indoor);
    const cycle = volleyball.serveRotation.rotationCycle!;
    const item = skin.scorebug(view(skin, cfg, [rally(skin, "H"), rally(skin, "A")])).strip.find((entry) => entry.label === "pad.volleyball.scorebug.strip.rotation");
    expect(item, "the rotation slot").toBeDefined();
    expect(item?.reserve).toEqual(Array.from({ length: cycle }, (_, i) => String(i + 1)));
    fact();
  });
});

describe("the drift guard compared enough", () => {
  it("reports the facts compared, and fewer than 20 is a failure", () => {
    console.info(`[pad-rules-setbased] facts compared: ${compared}`);
    expect(compared).toBeGreaterThanOrEqual(20);
  });
});
