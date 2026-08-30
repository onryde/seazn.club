// R7/A1 — the generic SkinDefV3. Pure-data assertions (apps/web vitest is
// `environment: "node"`, no jsdom): the skin is a spec BUILDER, so this file
// asserts the specs it returns and leaves the DOM to the e2e/gallery layer.
//
// EVERY STATE HERE COMES OUT OF THE REAL FOLD — `foldClient(generic, ...)`
// over real `EventEnvelope`s, and `generic.summary(state)` for the view's own
// `summary`, never a hand-typed state literal. The one deliberate exception is
// `degenerateView()`, named so nobody mistakes it for a shortcut.
//
// GENERIC IS TWO PADS, NOT ONE. `resultMode` is the only variant knob in this
// wave that changes the pad itself, so every structural assertion below is
// made against BOTH modes — a single-mode pin is this file's most likely false
// green.
import { describe, expect, it } from "vitest";
import type { EventEnvelope, Lineup, LineupPair } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import type { FidelityBand, ModuleEvent } from "@seazn/engine/sport";
import { makeEnvelope } from "@seazn/engine/testkit";
import { generic, padSpec as genericPadSpec } from "@seazn/engine/sports/generic";
import uiEn from "@/dictionaries/en/ui.json";
import { PAD_LABEL_KEYS } from "@/lib/scoring-vocab";
import { foldClient } from "../../../module-client";
import { dedicatedEventTypes, entitledBandsFrom, moreActions } from "../../pad-host";
import { buildRecording } from "../../recording-chip";
import { LEGACY_SPORTS, resolvePad } from "../../registry";
import { ribbonKeyFor } from "../../ribbon";
import { MORE_SHEET_KEY, assertScorebugSpec, type PadHostView, type TileSpec } from "../../types";
import {
  CORRECTION_TILE_ID,
  DRAW_TILE_ID,
  EVENT_BAND,
  MAX_PLAUSIBLE_SCORE,
  MAX_TALLY_STEP,
  MORE_TILE_ID,
  RESULT_HINT_KEY,
  RESULT_TYPE,
  SCORE_ENTRY_TILE_ID,
  SCORE_TYPE,
  SETTLE_TILE_ID,
  TALLY_HINT_KEY,
  buildDock,
  buildScorebug,
  buildSheets,
  buildTiles,
  cfgOf,
  genericDetail,
  resolvePhase,
  type TFn,
} from "../generic";

// ---------------------------------------------------------------------------
// Fixtures — the fold, and nothing but the fold
// ---------------------------------------------------------------------------

/** The oracle `t`. It ECHOES ITS INPUT, including the vars, so an assertion on
 *  a built string cannot pass by coincidence when a branch resolves the WRONG
 *  key. */
const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

const NAMES: Record<string, string> = {
  H1: "Hana Otieno",
  A1: "Ama Boateng",
  "H-first": "Home First",
  "H-second": "Home Second",
};

function soloSide(entrantId: string, personId: string): Lineup {
  return { entrantId, slots: [{ personId, slot: "starting", orderNo: 1 }] };
}

/** A two-person side. `orderNo` runs the OTHER WAY from `pairOrder` so a
 *  reader that quietly sorted by `orderNo` names the wrong player first and
 *  this file notices. */
function pairSide(entrantId: string, first: string, second: string): Lineup {
  return {
    entrantId,
    slots: [
      { personId: second, slot: "starting", orderNo: 1, pairOrder: 2 },
      { personId: first, slot: "starting", orderNo: 2, pairOrder: 1 },
    ],
  };
}

const SOLO: LineupPair = { home: soloSide("H", "H1"), away: soloSide("A", "A1") };
const PAIRED: LineupPair = { home: pairSide("H", "H-first", "H-second"), away: soloSide("A", "A1") };

const SCORE_CFG = generic.configSchema.parse(generic.variants!.score);
const WIN_LOSS_CFG = generic.configSchema.parse(generic.variants!.win_loss);
/** score mode with draws REFUSED — a legal cfg the shipped `score` variant
 *  does not produce, and the one that makes a level tally unsettleable. */
const SCORE_NO_DRAWS_CFG = generic.configSchema.parse({ resultMode: "score", allowDraws: false });
/** win_loss WITH draws — likewise legal, and the only cfg that earns a Draw
 *  tile. */
const WIN_LOSS_DRAWS_CFG = generic.configSchema.parse({ resultMode: "win_loss", allowDraws: true });

const ev = (seq: number, type: string, payload: unknown): EventEnvelope =>
  makeEnvelope(seq, { type, payload } as ModuleEvent);

/** A ledger. Deliberately WITHOUT a leading `core.start`: generic's own
 *  `applyScore`/`applyResult` both accept phase "pre", so a fresh fixture is
 *  scoreable with no Start tap and this file must never accidentally prove
 *  otherwise. Callers that want a live phase pass `core.start` themselves. */
function stream(...events: readonly (readonly [string, unknown])[]): EventEnvelope[] {
  return events.map(([type, payload], i) => ev(i, type, payload));
}

const start = (): readonly [string, unknown] => ["core.start", {}];
const point = (by: "H" | "A", points = 1, extra: Record<string, unknown> = {}): readonly [string, unknown] => [
  SCORE_TYPE,
  { by, points, ...extra },
];
const winner = (winnerId: "H" | "A"): readonly [string, unknown] => [RESULT_TYPE, { winnerId }];

interface ViewOpts {
  band?: FidelityBand;
  lineups?: LineupPair;
  cfg?: typeof SCORE_CFG;
  events?: EventEnvelope[];
}

/** A `PadHostView` whose `state` AND `summary` both come out of the real
 *  module — `summary` in particular, because the board reads the engine's own
 *  per-side line and must never re-derive it. */
function view(opts: ViewOpts = {}): PadHostView {
  const lineups = opts.lineups ?? SOLO;
  const cfg = opts.cfg ?? SCORE_CFG;
  const events = opts.events ?? stream();
  const state = foldClient(generic, cfg, lineups, events);
  return {
    cfg,
    state,
    summary: generic.summary(state as never),
    phase: "live",
    band: opts.band ?? 3,
    entitlements: {},
    personNames: NAMES,
    squads: initSquads(lineups),
    events,
    contextOverrides: {},
  };
}

/** The ONE hand-built view in this file: a pad mounted before any fold exists
 *  at all. Named so it can never be mistaken for a convenience shortcut. */
function degenerateView(over: Partial<PadHostView> = {}): PadHostView {
  return {
    cfg: {},
    state: {},
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: {},
    squads: initSquads(SOLO),
    events: [],
    contextOverrides: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// phase()
// ---------------------------------------------------------------------------

describe("resolvePhase", () => {
  it("reports 'pre' for a fixture nobody has started — and that is a SCOREABLE phase", () => {
    expect(resolvePhase(view())).toBe("pre");
  });

  it("reports 'live' once core.start lands", () => {
    expect(resolvePhase(view({ events: stream(start()) }))).toBe("live");
  });

  it("maps the engine's own 'done' down to 'post' after a result", () => {
    const v = view({ cfg: WIN_LOSS_CFG, events: stream(start(), winner("H")) });
    expect(resolvePhase(v)).toBe("post");
  });

  it("maps an abandoned fixture to 'post' too — core.abandon folds to phase 'done'", () => {
    const v = view({ events: stream(start(), ["core.abandon", { reason: "rain" }]) });
    expect(resolvePhase(v)).toBe("post");
  });

  it("degrades to 'pre' for a pad mounted before any fold exists", () => {
    expect(resolvePhase(degenerateView())).toBe("pre");
  });
});

// ---------------------------------------------------------------------------
// scorebug() — the board IS the instrument
// ---------------------------------------------------------------------------

describe("buildScorebug — the halves", () => {
  it("names the PEOPLE, not the sides, when a lineup exists (D-6)", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.halves[0].who.map((w) => w.name)).toEqual(["Hana Otieno"]);
    expect(spec.halves[1].who.map((w) => w.name)).toEqual(["Ama Boateng"]);
  });

  it("falls back to the side label rather than rendering an empty who line", () => {
    const spec = buildScorebug(degenerateView({ squads: initSquads({ home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } }) }), t);
    expect(spec.halves.map((h) => h.who.map((w) => w.name))).toEqual([
      ["scorepad.attribution.home"],
      ["scorepad.attribution.away"],
    ]);
    expect(assertScorebugSpec(spec)).toEqual([]);
  });

  it("reads the big number off the ENGINE's own summary, never a re-derivation", () => {
    const v = view({ events: stream(point("H"), point("H", 2), point("A")) });
    const spec = buildScorebug(v, t);
    // `generic.summary` renders the running tally while the fixture is
    // undecided: 3 - 1.
    expect(spec.halves.map((h) => h.big)).toEqual(["3", "1"]);
  });

  it("shows the engine's own W/L letters once a win_loss fixture is decided", () => {
    const v = view({ cfg: WIN_LOSS_CFG, events: stream(start(), winner("A")) });
    expect(buildScorebug(v, t).halves.map((h) => h.big)).toEqual(["L", "W"]);
  });

  it("shows an em dash before anything is recorded", () => {
    expect(buildScorebug(view({ cfg: WIN_LOSS_CFG }), t).halves.map((h) => h.big)).toEqual(["—", "—"]);
  });
});

describe("buildScorebug — the tap, per resultMode", () => {
  it("score mode: a half tap commits ONE point to that side, immediately", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.halves[0].tappable).toBe(true);
    expect(spec.halves[0].tapEvent).toEqual({ type: SCORE_TYPE, payload: { by: "H", points: 1, person: "H1" } });
    expect(spec.halves[1].tapEvent).toEqual({ type: SCORE_TYPE, payload: { by: "A", points: 1, person: "A1" } });
  });

  it("score mode: omits `person` when the side has more than one player — the dock asks", () => {
    const spec = buildScorebug(view({ lineups: PAIRED }), t);
    expect(spec.halves[0].tapEvent).toEqual({ type: SCORE_TYPE, payload: { by: "H", points: 1 } });
  });

  it("win_loss mode: a half tap commits the RESULT, naming that side the winner", () => {
    const spec = buildScorebug(view({ cfg: WIN_LOSS_CFG }), t);
    expect(spec.halves[0].tapEvent).toEqual({ type: RESULT_TYPE, payload: { winnerId: "H" } });
    expect(spec.halves[1].tapEvent).toEqual({ type: RESULT_TYPE, payload: { winnerId: "A" } });
  });

  it("both modes: a decided fixture has no tappable half left", () => {
    const decided = view({ cfg: WIN_LOSS_CFG, events: stream(start(), winner("H")) });
    expect(buildScorebug(decided, t).halves.every((h) => h.tappable !== true)).toBe(true);
  });

  it("score mode at band 0: the tally is out of band, so no half is tappable", () => {
    const spec = buildScorebug(view({ band: 0 }), t);
    expect(spec.halves.every((h) => h.tappable !== true)).toBe(true);
  });

  it("win_loss at band 0: generic.result IS a band-0 event, so the halves stay live", () => {
    const spec = buildScorebug(view({ cfg: WIN_LOSS_CFG, band: 0 }), t);
    expect(spec.halves.every((h) => h.tappable === true)).toBe(true);
  });

  it("every built spec satisfies the chassis contract", () => {
    for (const cfg of [SCORE_CFG, WIN_LOSS_CFG, SCORE_NO_DRAWS_CFG, WIN_LOSS_DRAWS_CFG]) {
      for (const band of [0, 1, 2, 3] as FidelityBand[]) {
        expect(assertScorebugSpec(buildScorebug(view({ cfg, band }), t)), `${cfg.resultMode}@${band}`).toEqual([]);
      }
    }
  });
});

describe("buildScorebug — the context line states what this pad can record", () => {
  it("score mode in band names the running tally, and the draw policy", () => {
    expect(buildScorebug(view(), t).context).toBe("pad.generic.context.tally · pad.generic.context.draws");
  });

  it("score mode with draws refused says so", () => {
    expect(buildScorebug(view({ cfg: SCORE_NO_DRAWS_CFG }), t).context).toBe(
      "pad.generic.context.tally · pad.generic.context.noDraws",
    );
  });

  it("score mode BELOW the tally's band reads 'result only' — that is what the fixture records", () => {
    expect(buildScorebug(view({ band: 0 }), t).context).toBe(
      "pad.generic.context.resultOnly · pad.generic.context.draws",
    );
  });

  it("win_loss always reads 'result only', at every band", () => {
    for (const band of [0, 3] as FidelityBand[]) {
      expect(buildScorebug(view({ cfg: WIN_LOSS_CFG, band }), t).context).toBe(
        "pad.generic.context.resultOnly · pad.generic.context.noDraws",
      );
    }
    expect(buildScorebug(view({ cfg: WIN_LOSS_DRAWS_CFG }), t).context).toBe(
      "pad.generic.context.resultOnly · pad.generic.context.draws",
    );
  });
});

describe("buildScorebug — the strip says only what the two numbers cannot", () => {
  it("says nothing at all before a tally exists", () => {
    expect(buildScorebug(view(), t).strip).toEqual([]);
  });

  it("says nothing in win_loss mode, ever — there is no tally to word", () => {
    const v = view({ cfg: WIN_LOSS_DRAWS_CFG, events: stream(point("H"), point("H")) });
    expect(buildScorebug(v, t).strip).toEqual([]);
  });

  it("words the lead, naming the leader", () => {
    const v = view({ events: stream(point("H"), point("H", 2), point("A")) });
    expect(buildScorebug(v, t).strip).toEqual([
      { id: "margin", value: 'pad.generic.scorebug.strip.lead({"name":"Hana Otieno","by":2})' },
    ]);
  });

  it("words a level tally, and ACCENTS it only when a level result cannot be recorded", () => {
    const level = stream(point("H"), point("A"));
    expect(buildScorebug(view({ events: level }), t).strip).toEqual([
      { id: "margin", value: "pad.generic.scorebug.strip.level" },
    ]);
    expect(buildScorebug(view({ cfg: SCORE_NO_DRAWS_CFG, events: level }), t).strip).toEqual([
      { id: "margin", value: "pad.generic.scorebug.strip.level", accent: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// tiles() — everything the board itself cannot say
// ---------------------------------------------------------------------------

const tileIds = (v: PadHostView): string[] => buildTiles(v, t).map((tile) => tile.id);
const tileById = (v: PadHostView, id: string): TileSpec | undefined =>
  buildTiles(v, t).find((tile) => tile.id === id);

describe("buildTiles — score mode", () => {
  it("offers the explicit score sheet from the very first render, at every band", () => {
    for (const band of [0, 1, 2, 3] as FidelityBand[]) {
      expect(tileIds(view({ band })), `band ${band}`).toContain(SCORE_ENTRY_TILE_ID);
    }
  });

  it("withholds both tally-shaped tiles until a tally actually exists", () => {
    const fresh = tileIds(view());
    expect(fresh).not.toContain(SETTLE_TILE_ID);
    expect(fresh).not.toContain(CORRECTION_TILE_ID);
  });

  it("offers 'finish from tally' once a tally exists, showing exactly what it will record", () => {
    const v = view({ events: stream(point("H"), point("H", 2), point("A")) });
    const tile = tileById(v, SETTLE_TILE_ID);
    expect(tile?.action).toEqual({ event: { type: RESULT_TYPE, payload: {} } });
    expect(tile?.sublabelText).toBe("3 – 1");
  });

  it("WITHHOLDS 'finish from tally' at a level tally the division cannot record", () => {
    const level = stream(point("H"), point("A"));
    expect(tileIds(view({ events: level }))).toContain(SETTLE_TILE_ID);
    expect(tileIds(view({ cfg: SCORE_NO_DRAWS_CFG, events: level }))).not.toContain(SETTLE_TILE_ID);
  });

  it("offers the correction sheet only while there is something to subtract", () => {
    expect(tileIds(view({ events: stream(point("H")) }))).toContain(CORRECTION_TILE_ID);
    // Tallied, then corrected back to nothing: `state.running` still exists,
    // but no side has a point left to remove.
    expect(tileIds(view({ events: stream(point("H"), point("H", -1)) }))).not.toContain(CORRECTION_TILE_ID);
  });

  it("drops every tally-shaped tile at band 0 — that fixture records one card", () => {
    const ids = tileIds(view({ band: 0, events: stream(point("H")) }));
    expect(ids).toEqual([SCORE_ENTRY_TILE_ID]);
  });

  it("never offers a Draw tile — a level score IS the draw", () => {
    for (const cfg of [SCORE_CFG, SCORE_NO_DRAWS_CFG]) {
      expect(tileIds(view({ cfg, events: stream(point("H"), point("A")) }))).not.toContain(DRAW_TILE_ID);
    }
  });
});

describe("buildTiles — win_loss mode", () => {
  it("offers a Draw tile ONLY where the fold would accept one", () => {
    expect(tileIds(view({ cfg: WIN_LOSS_DRAWS_CFG }))).toContain(DRAW_TILE_ID);
    expect(tileIds(view({ cfg: WIN_LOSS_CFG }))).not.toContain(DRAW_TILE_ID);
  });

  it("the Draw tile is ABSENT, never disabled — a dead-end tap is worse than no tile", () => {
    expect(buildTiles(view({ cfg: WIN_LOSS_CFG }), t).some((tile) => tile.disabled === true)).toBe(false);
  });

  it("the Draw tile commits the draw itself, with no sheet in the way", () => {
    const tile = tileById(view({ cfg: WIN_LOSS_DRAWS_CFG }), DRAW_TILE_ID);
    expect(tile?.action).toEqual({ event: { type: RESULT_TYPE, payload: { isDraw: true } } });
  });

  it("offers no score-entry or correction tile — this pad records no numbers", () => {
    const ids = tileIds(view({ cfg: WIN_LOSS_DRAWS_CFG, events: stream(point("H")) }));
    expect(ids).not.toContain(SCORE_ENTRY_TILE_ID);
    expect(ids).not.toContain(CORRECTION_TILE_ID);
    expect(ids).not.toContain(SETTLE_TILE_ID);
  });
});

describe("buildTiles — every tile declares the phases generic can actually fold in", () => {
  it("pre AND live, because applyScore/applyResult both accept phase 'pre'", () => {
    for (const cfg of [SCORE_CFG, WIN_LOSS_DRAWS_CFG]) {
      const tiles = buildTiles(view({ cfg, events: stream(point("H"), point("H")) }), t);
      expect(tiles.length, `${cfg.resultMode} has tiles to check`).toBeGreaterThan(0);
      for (const tile of tiles) expect(tile.phases, tile.id).toEqual(["pre", "live"]);
    }
  });
});

// ---------------------------------------------------------------------------
// The More tile — declared ONLY when the chassis has something to put in it
// ---------------------------------------------------------------------------

/** The REAL chassis answer for this view: what `moreActions` would render. */
function realMoreActions(v: PadHostView): string[] {
  const spec = genericPadSpec(cfgOf(v) as never);
  const tiles = buildTiles(v, t);
  const sheets = buildSheets(v, t);
  const scorebug = buildScorebug(v, t);
  const dedicated = dedicatedEventTypes(tiles, sheets, [], scorebug);
  return moreActions(
    spec,
    { state: v.state, summary: v.summary, phase: resolvePhase(v), band: v.band, entitlements: v.entitlements },
    dedicated,
    new Set<string>(),
  ).map((action) => action.type);
}

describe("the More tile agrees with the chassis, in every mode/band/phase", () => {
  it("is declared exactly when moreActions has something to show", () => {
    const ledgers: EventEnvelope[][] = [stream(), stream(start()), stream(start(), point("H"))];
    let sawBoth = { withMore: false, withoutMore: false };
    for (const cfg of [SCORE_CFG, SCORE_NO_DRAWS_CFG, WIN_LOSS_CFG, WIN_LOSS_DRAWS_CFG]) {
      for (const band of [0, 1, 2, 3] as FidelityBand[]) {
        for (const events of ledgers) {
          const v = view({ cfg, band, events });
          const declared = tileIds(v).includes(MORE_TILE_ID);
          const real = realMoreActions(v).length > 0;
          expect(declared, `${cfg.resultMode}@${band} phase=${resolvePhase(v)}`).toBe(real);
          sawBoth = { withMore: sawBoth.withMore || declared, withoutMore: sawBoth.withoutMore || !declared };
        }
      }
    }
    // Guard the guard: a sweep that only ever saw one answer would agree
    // vacuously with anything.
    expect(sawBoth).toEqual({ withMore: true, withoutMore: true });
  });

  it("win_loss at band 1+ keeps the module's own tally actions reachable through More", () => {
    expect(realMoreActions(view({ cfg: WIN_LOSS_CFG, band: 1, events: stream(start()) }))).toEqual([SCORE_TYPE]);
  });
});

// ---------------------------------------------------------------------------
// sheets() — a METHOD of the view, rebuilt per render
// ---------------------------------------------------------------------------

describe("buildSheets", () => {
  it("every sheet a tile opens exists, and no sheet is declared without an opener", () => {
    for (const cfg of [SCORE_CFG, SCORE_NO_DRAWS_CFG, WIN_LOSS_CFG, WIN_LOSS_DRAWS_CFG]) {
      for (const band of [0, 3] as FidelityBand[]) {
        const v = view({ cfg, band, events: stream(start(), point("H")) });
        const sheets = buildSheets(v, t);
        const opened = buildTiles(v, t)
          .map((tile) => ("sheet" in tile.action ? tile.action.sheet : null))
          .filter((key): key is string => key !== null && key !== MORE_SHEET_KEY);
        expect(new Set(Object.keys(sheets)), `${cfg.resultMode}@${band}`).toEqual(new Set(opened));
      }
    }
  });

  it("the score sheet PREFILLS from the tally, so an unedited confirm records the board", () => {
    const v = view({ events: stream(point("H"), point("H", 2), point("A")) });
    const sheet = buildSheets(v, t)[SCORE_ENTRY_TILE_ID]!;
    expect(sheet.event).toBe(RESULT_TYPE);
    expect(sheet.steps.map((step) => (step.kind === "number" ? step.initial : null))).toEqual([3, 1]);
    expect(sheet.buildPayload({ home: "12", away: "9" })).toEqual({ p1Score: 12, p2Score: 9 });
  });

  it("the score sheet's ceiling is the ENGINE's own plausibility bound, not a number invented here", () => {
    const spec = genericPadSpec(SCORE_CFG as never);
    const engineMax = spec.panels
      .flatMap((panel) => panel.actions)
      .find((action) => action.fields.some((field) => field.path === "p1Score"))
      ?.fields.find((field) => field.path === "p1Score");
    const sheet = buildSheets(view(), t)[SCORE_ENTRY_TILE_ID]!;
    for (const step of sheet.steps) {
      if (step.kind === "number") expect(step.max).toBe((engineMax as { max?: number }).max);
    }
  });

  it("the correction sheet posts a NEGATIVE points, never zero, against the side chosen", () => {
    const v = view({ events: stream(point("H"), point("H", 2)) });
    const sheet = buildSheets(v, t)[CORRECTION_TILE_ID]!;
    expect(sheet.event).toBe(SCORE_TYPE);
    expect(sheet.buildPayload({ side: "home", points: "2" })).toEqual({ by: "H", points: -2 });
    expect(sheet.buildPayload({ side: "away", points: "1" })).toEqual({ by: "A", points: -1 });
  });

  it("the correction sheet cannot offer 0, and cannot offer more than a side actually holds", () => {
    const v = view({ events: stream(point("H", 4), point("A")) });
    const step = buildSheets(v, t)[CORRECTION_TILE_ID]!.steps.find((s) => s.kind === "number");
    expect(step).toBeDefined();
    if (step?.kind === "number") {
      expect(step.min).toBe(1);
      expect(step.max).toBe(4);
      expect(step.initial).toBeGreaterThanOrEqual(1);
    }
  });

  it("the correction sheet's own step is capped by the engine's single-press bound", () => {
    const v = view({ events: stream(point("H", 50), point("H", 50)) });
    const step = buildSheets(v, t)[CORRECTION_TILE_ID]!.steps.find((s) => s.kind === "number");
    if (step?.kind === "number") expect(step.max).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// The seam, folded: every payload this skin can build, through the REAL engine
// ---------------------------------------------------------------------------

describe("every payload this pad can produce folds through the real engine", () => {
  function foldOne(cfg: typeof SCORE_CFG, events: EventEnvelope[], type: string, payload: unknown): unknown {
    return foldClient(generic, cfg, SOLO, [...events, ev(events.length, type, payload)]);
  }

  it("score mode: the half tap, the dock's amended amount, a correction, the settle and the sheet", () => {
    const base = stream(start());
    const half = buildScorebug(view({ events: base }), t).halves[0]!.tapEvent!;
    expect(() => foldOne(SCORE_CFG, base, half.type, half.payload)).not.toThrow();
    // The dock's own amend: the SAME held payload with a different amount.
    expect(() => foldOne(SCORE_CFG, base, half.type, { ...half.payload, points: 5 })).not.toThrow();
    const tallied = stream(start(), point("H", 3), point("A"));
    const v = view({ events: tallied });
    const correction = buildSheets(v, t)[CORRECTION_TILE_ID]!;
    expect(() =>
      foldOne(SCORE_CFG, tallied, correction.event, correction.buildPayload({ side: "home", points: "1" })),
    ).not.toThrow();
    const settle = tileById(v, SETTLE_TILE_ID)!.action;
    expect("event" in settle).toBe(true);
    if ("event" in settle) {
      expect(() => foldOne(SCORE_CFG, tallied, settle.event.type, settle.event.payload)).not.toThrow();
    }
    const entry = buildSheets(v, t)[SCORE_ENTRY_TILE_ID]!;
    expect(() =>
      foldOne(SCORE_CFG, tallied, entry.event, entry.buildPayload({ home: "21", away: "19" })),
    ).not.toThrow();
  });

  it("win_loss mode: both half taps and the Draw tile", () => {
    const base = stream(start());
    const spec = buildScorebug(view({ cfg: WIN_LOSS_DRAWS_CFG, events: base }), t);
    for (const half of spec.halves) {
      expect(() => foldOne(WIN_LOSS_DRAWS_CFG, base, half.tapEvent!.type, half.tapEvent!.payload)).not.toThrow();
    }
    const draw = tileById(view({ cfg: WIN_LOSS_DRAWS_CFG, events: base }), DRAW_TILE_ID)!.action;
    if ("event" in draw) {
      expect(() => foldOne(WIN_LOSS_DRAWS_CFG, base, draw.event.type, draw.event.payload)).not.toThrow();
    }
  });

  it("the settle tile the pad WITHHOLDS is exactly the one the fold refuses", () => {
    const level = stream(start(), point("H"), point("A"));
    // Withheld — and this is why.
    expect(tileIds(view({ cfg: SCORE_NO_DRAWS_CFG, events: level }))).not.toContain(SETTLE_TILE_ID);
    expect(() => foldOne(SCORE_NO_DRAWS_CFG, level, RESULT_TYPE, {})).toThrow(/draws are not allowed/);
    // Offered where draws ARE allowed, and the fold accepts it there.
    expect(() => foldOne(SCORE_CFG, level, RESULT_TYPE, {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// dock() — RULING R7-2: tap decides, dock enriches. Generic's only enrichment
// is "actually, that was worth more", so the dock AMENDS the held payload and
// never posts a second event.
// ---------------------------------------------------------------------------

const tap = (v: PadHostView, side: 0 | 1): Record<string, unknown> =>
  buildScorebug(v, t).halves[side]!.tapEvent!.payload;

describe("buildDock", () => {
  it("win_loss declares NO dock at all — a terminal card has nothing to enrich", () => {
    const v = view({ cfg: WIN_LOSS_DRAWS_CFG });
    for (const type of [RESULT_TYPE, SCORE_TYPE]) {
      expect(buildDock(type, v, t, { winnerId: "H" })).toBeNull();
    }
  });

  it("score mode opens nothing for the result card either", () => {
    expect(buildDock(RESULT_TYPE, view(), t, {})).toBeNull();
  });

  it("offers the three amounts, as MODIFIERS of the point already recorded", () => {
    const v = view();
    const dock = buildDock(SCORE_TYPE, v, t, tap(v, 0))!;
    expect(dock.title).toBe("pad.generic.dock.amount.title");
    expect(dock.chips.map((chip) => chip.id)).toEqual(["points:2", "points:3", "points:5"]);
    expect(dock.chips.every((chip) => chip.kind === "flag")).toBe(true);
  });

  it("a chip REPLACES the amount on the same payload — it never adds a second event", () => {
    const v = view();
    const held = tap(v, 0);
    const dock = buildDock(SCORE_TYPE, v, t, held)!;
    const three = dock.chips.find((chip) => chip.id === "points:3")!;
    expect(three.mutate(held)).toEqual({ ...held, points: 3 });
    // And a second, different chip corrects the first rather than stacking:
    // `dockController` refuses only a REPEAT of the same chip.
    const two = dock.chips.find((chip) => chip.id === "points:2")!;
    expect(two.mutate(three.mutate(held))).toEqual({ ...held, points: 2 });
  });

  it("every amended payload still folds through the real engine", () => {
    const base = stream(start());
    const v = view({ events: base });
    const held = tap(v, 0);
    const dock = buildDock(SCORE_TYPE, v, t, held)!;
    for (const chip of dock.chips) {
      const amended = chip.mutate(held);
      expect(
        () => foldClient(generic, SCORE_CFG, SOLO, [...base, ev(base.length, SCORE_TYPE, amended)]),
        `chip ${chip.id}`,
      ).not.toThrow();
    }
  });

  it("asks who scored ONLY when the side has more than one player", () => {
    const solo = view();
    expect(buildDock(SCORE_TYPE, solo, t, tap(solo, 0))!.chips.map((c) => c.id)).toEqual([
      "points:2",
      "points:3",
      "points:5",
    ]);
    const paired = view({ lineups: PAIRED });
    const dock = buildDock(SCORE_TYPE, paired, t, tap(paired, 0))!;
    expect(dock.title).toBe("pad.generic.dock.both.title");
    expect(dock.chips.map((chip) => chip.id)).toEqual([
      "points:2",
      "points:3",
      "points:5",
      "person:H-first",
      "person:H-second",
    ]);
    // Person chips stay PILLS; only the amounts are flags.
    expect(dock.chips.filter((chip) => chip.id.startsWith("person:")).every((chip) => chip.kind === undefined)).toBe(
      true,
    );
  });

  it("does not re-ask a question the tap already answered", () => {
    const paired = view({ lineups: PAIRED });
    const dock = buildDock(SCORE_TYPE, paired, t, { ...tap(paired, 0), person: "H-first" })!;
    expect(dock.chips.some((chip) => chip.id.startsWith("person:"))).toBe(false);
    expect(dock.title).toBe("pad.generic.dock.amount.title");
  });

  it("names the winning side's OWN players, never the other side's", () => {
    const paired = view({ lineups: PAIRED });
    const away = buildDock(SCORE_TYPE, paired, t, tap(paired, 1))!;
    expect(away.chips.some((chip) => chip.id.startsWith("person:"))).toBe(false);
  });

  it("degrades to the amounts alone when the payload names no resolvable side", () => {
    const paired = view({ lineups: PAIRED });
    const dock = buildDock(SCORE_TYPE, paired, t, { points: 1 })!;
    expect(dock.chips.map((chip) => chip.id)).toEqual(["points:2", "points:3", "points:5"]);
  });
});

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half
// ---------------------------------------------------------------------------

function detail(v: PadHostView, eventType: string, payload: Record<string, unknown>): string | undefined {
  return genericDetail({ t, eventType, payload, state: v.state, personNames: NAMES });
}

describe("genericDetail", () => {
  it("names the person and the amount for a tallied point", () => {
    expect(detail(view(), SCORE_TYPE, { by: "H", points: 3, person: "H1" })).toBe(
      'Hana Otieno · pad.generic.ribbon.points({"points":3})',
    );
  });

  it("falls back to the SIDE when nobody was attributed — never an empty row", () => {
    expect(detail(view(), SCORE_TYPE, { by: "A", points: 1 })).toBe(
      'scorepad.attribution.away · pad.generic.ribbon.points({"points":1})',
    );
  });

  it("carries the sign, so a correction is legible in the log", () => {
    expect(detail(view(), SCORE_TYPE, { by: "H", points: -2 })).toContain('{"points":-2}');
  });

  it("reads a typed result as its score", () => {
    expect(detail(view(), RESULT_TYPE, { p1Score: 21, p2Score: 19 })).toBe("21 – 19");
  });

  it("names the winning side for a win_loss card", () => {
    expect(detail(view({ cfg: WIN_LOSS_CFG }), RESULT_TYPE, { winnerId: "A" })).toBe("scorepad.attribution.away");
  });

  it("words a declared draw", () => {
    expect(detail(view({ cfg: WIN_LOSS_DRAWS_CFG }), RESULT_TYPE, { isDraw: true })).toBe(
      "pad.generic.ribbon.draw",
    );
  });

  it("adds nothing it cannot see — a settle-from-tally card carries no facts", () => {
    expect(detail(view(), RESULT_TYPE, {})).toBeUndefined();
    expect(detail(view(), "core.start", {})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The registry, the vocabulary, and the four dictionaries
// ---------------------------------------------------------------------------

describe("registry", () => {
  it("resolves generic to the v3 lane, and hands back a real skin", () => {
    const lane = resolvePad("generic", t);
    expect(lane.lane).toBe("v3");
    if (lane.lane === "v3") {
      expect(lane.skin.key).toBe("generic");
      expect(lane.skin.tapModel).toBe("S");
      expect(typeof lane.skin.phase).toBe("function");
    }
  });

  it("no longer routes generic down the legacy lane", () => {
    expect(LEGACY_SPORTS.has("generic")).toBe(false);
  });
});

describe("the engine surface this skin restates", () => {
  it("EVENT_BAND is the module's own fidelity map, not a second scale", () => {
    for (const cfg of [SCORE_CFG, WIN_LOSS_CFG]) {
      expect(EVENT_BAND).toEqual(genericPadSpec(cfg as never).fidelity);
    }
  });

  it("MAX_TALLY_STEP and MAX_PLAUSIBLE_SCORE are the engine's own field bounds", () => {
    const fields = genericPadSpec(SCORE_CFG as never).panels
      .flatMap((panel) => panel.actions)
      .flatMap((action) => action.fields);
    const points = fields.find((field) => field.path === "points" && "max" in field && field.max > 0);
    const p1 = fields.find((field) => field.path === "p1Score");
    expect((points as { max: number }).max).toBe(MAX_TALLY_STEP);
    expect((p1 as { max: number }).max).toBe(MAX_PLAUSIBLE_SCORE);
  });

  it("the recording chip renders NO upsell for generic: an empty entitlement map entitles every band", () => {
    const entitlements = genericPadSpec(SCORE_CFG as never).fidelityEntitlements;
    expect(entitlements).toEqual({});
    const bands = entitledBandsFrom(entitlements, {});
    expect([...bands].sort()).toEqual([0, 1, 2, 3]);
    // `RecordingChip` shows its upsell only when the NEXT band is locked, and
    // no band is: generic ships free at every level it declares.
    for (const band of [0, 1, 2] as FidelityBand[]) {
      const nextBand = (band + 1) as FidelityBand;
      const next = buildRecording(nextBand, band, bands, entitlements[nextBand] ?? "", (k) => k);
      expect(next.locked, `band ${nextBand}`).toBe(false);
      expect(next.upsell).toBeUndefined();
    }
  });
});

describe("vocabulary and copy", () => {
  it("both ribbon keys are REGISTERED, not merely translated", () => {
    for (const type of [RESULT_TYPE, SCORE_TYPE]) {
      expect(PAD_LABEL_KEYS).toContain(ribbonKeyFor(type));
    }
  });

  it("both scorebug hints are registered — padLabel prints the raw key otherwise", () => {
    expect(PAD_LABEL_KEYS).toContain(TALLY_HINT_KEY);
    expect(PAD_LABEL_KEYS).toContain(RESULT_HINT_KEY);
  });

  /** Every key this skin can put on screen, collected from BUILT specs rather
   *  than from a hand list — a skin's tile/step/chip i18n keys have no gate of
   *  their own, so a list written by hand would miss exactly the key that was
   *  forgotten. */
  function keysOn(v: PadHostView): Set<string> {
    const seen = new Set<string>();
    const recording: TFn = (key) => {
      seen.add(key);
      return key;
    };
    const bug = buildScorebug(v, recording);
    for (const half of bug.halves) if (half.hintKey) seen.add(half.hintKey);
    for (const tile of buildTiles(v, recording)) {
      seen.add(tile.label);
      if (tile.sublabel) seen.add(tile.sublabel);
    }
    for (const sheet of Object.values(buildSheets(v, recording))) {
      for (const step of sheet.steps) if (step.kind === "choice") for (const o of step.options) seen.add(o.label);
    }
    for (const payload of [{ by: "H", points: 1 }, { by: "H", points: 1, person: "H-first" }]) {
      const dock = buildDock(SCORE_TYPE, v, recording, payload);
      if (dock) for (const chip of dock.chips) seen.add(chip.label);
    }
    for (const [type, payload] of [
      [SCORE_TYPE, { by: "H", points: 2, person: "H1" }],
      [SCORE_TYPE, { by: "H", points: 2 }],
      [RESULT_TYPE, { p1Score: 3, p2Score: 1 }],
      [RESULT_TYPE, { winnerId: "H" }],
      [RESULT_TYPE, { isDraw: true }],
    ] as const) {
      genericDetail({ t: recording, eventType: type, payload, state: v.state, personNames: NAMES });
    }
    for (const type of [RESULT_TYPE, SCORE_TYPE]) seen.add(ribbonKeyFor(type));
    return seen;
  }

  it("every key it can render exists in the English dictionary", () => {
    const all = new Set<string>();
    for (const cfg of [SCORE_CFG, SCORE_NO_DRAWS_CFG, WIN_LOSS_CFG, WIN_LOSS_DRAWS_CFG]) {
      for (const band of [0, 1, 3] as FidelityBand[]) {
        for (const lineups of [SOLO, PAIRED]) {
          for (const events of [stream(), stream(start()), stream(start(), point("H", 3), point("A"))]) {
            for (const key of keysOn(view({ cfg, band, lineups, events }))) all.add(key);
          }
        }
      }
    }
    // Guard the guard: a sweep that collected nothing would pass silently.
    expect(all.size).toBeGreaterThan(15);
    const missing = [...all].filter((key) => !(key in (uiEn as Record<string, string>)));
    expect(missing).toEqual([]);
  });
});
