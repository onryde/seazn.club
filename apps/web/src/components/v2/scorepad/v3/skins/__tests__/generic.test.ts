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
import { foldClient } from "../../../module-client";
import { assertScorebugSpec, type PadHostView } from "../../types";
import {
  RESULT_TYPE,
  SCORE_TYPE,
  buildScorebug,
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
