// R7/A2 — the boardgame SkinDefV3. Pure-data assertions (apps/web vitest is
// `environment: "node"`, no jsdom): the skin is a spec BUILDER, so this file
// asserts the specs it returns and leaves the DOM to the e2e/gallery layer.
//
// TAPMODEL S REWORK (owner ruling R7-2, "tap decides, dock enriches") — this
// file used to prove tapModel T: pure-readout halves, three tiles, `dock()`
// always null. It now proves the opposite shape: both halves ARE tappable
// and commit `boardgame.result` immediately; the draw tile posts the same
// event type directly (`winner: null`) rather than opening a sheet; and
// `buildDock` offers DECISIVE_METHODS after a half tap and DRAWN_METHODS
// after the draw tile, never one flat list of 13 (R7-10). See
// `skins/boardgame.tsx`'s own header for the full ruling and why tapModel T
// was considered and rejected.
//
// EVERY STATE HERE COMES OUT OF THE REAL FOLD — `foldClient(boardgame, ...)`
// over real `EventEnvelope`s, and `boardgame.summary(state)` for the view's
// own `summary`, never a hand-typed state literal. The one deliberate
// exception is `degenerateView()`, named so nobody mistakes it for a
// shortcut.
//
// TWO CFGS, ALWAYS BOTH. `colors` is the one knob that changes what this pad
// asks and shows — the pairing sheet's `white` step, and the WHO line's
// White indicator, exist ONLY when it is true — so a single-cfg pin is this
// file's most likely false green, the same posture generic's own two-mode
// sweep takes for `resultMode`.
import { describe, expect, it } from "vitest";
import type { EventEnvelope, Lineup, LineupPair } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import type { FidelityBand, ModuleEvent } from "@seazn/engine/sport";
import { makeEnvelope } from "@seazn/engine/testkit";
import { boardgame } from "@seazn/engine/sports/boardgame";
import uiEn from "@/dictionaries/en/ui.json";
import { PAD_LABEL_KEYS } from "@/lib/scoring-vocab";
import { foldClient } from "../../../module-client";
import { dedicatedEventTypes, moreActions } from "../../pad-host";
import { resolvePad } from "../../registry";
import { ribbonKeyFor } from "../../ribbon";
import { assertScorebugSpec, type PadHostView, type TileSpec } from "../../types";
import {
  BOARD_MAX,
  DECISIVE_METHODS,
  DRAWN_METHODS,
  DRAW_TILE_ID,
  EVENT_BAND,
  PAIRING_TILE_ID,
  PAIRING_TYPE,
  RESULT_HINT_KEY,
  RESULT_TYPE,
  boardgameDetail,
  buildDock,
  buildScorebug,
  buildSheets,
  buildTiles,
  cfgOf,
  resolvePhase,
  type TFn,
} from "../boardgame";

// ---------------------------------------------------------------------------
// Fixtures — the fold, and nothing but the fold
// ---------------------------------------------------------------------------

/** The oracle `t`. It ECHOES ITS INPUT, including the vars, so an assertion
 *  on a built string cannot pass by coincidence when a branch resolves the
 *  WRONG key. */
const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

const NAMES: Record<string, string> = {
  H1: "Magnus Carlsen",
  A1: "Hikaru Nakamura",
};

function soloSide(entrantId: string, personId: string): Lineup {
  return { entrantId, slots: [{ personId, slot: "starting", orderNo: 1 }] };
}
function emptySide(entrantId: string): Lineup {
  return { entrantId, slots: [] };
}

const SOLO: LineupPair = { home: soloSide("H", "H1"), away: soloSide("A", "A1") };
const EMPTY: LineupPair = { home: emptySide("H"), away: emptySide("A") };

const DEFAULT_CFG = boardgame.configSchema.parse({});
const NO_COLORS_CFG = boardgame.configSchema.parse({ colors: false });

/** `SportModule.padSpec` is typed OPTIONAL on the shared interface (some
 *  modules declare none) even though `boardgame.ts` itself always assigns
 *  one — bound once, loudly, rather than a bare `!` repeated at every call
 *  site below. */
function realPadSpec(cfg: unknown) {
  const fn = boardgame.padSpec;
  if (!fn) throw new Error("boardgame module unexpectedly declares no padSpec");
  return fn(cfg as never);
}

const ev = (seq: number, type: string, payload: unknown): EventEnvelope =>
  makeEnvelope(seq, { type, payload } as ModuleEvent);

/** A ledger, deliberately without a leading `core.start` — `applyPairing`
 *  accepts phase "pre" or "live", so a fresh fixture can already record a
 *  pairing card, and this file must never accidentally prove otherwise.
 *  Callers that want a live phase pass `core.start` themselves. */
function stream(...events: readonly (readonly [string, unknown])[]): EventEnvelope[] {
  return events.map(([type, payload], i) => ev(i, type, payload));
}

const start = (): readonly [string, unknown] => ["core.start", {}];
const pairing = (payload: Record<string, unknown>): readonly [string, unknown] => [PAIRING_TYPE, payload];
const result = (payload: Record<string, unknown>): readonly [string, unknown] => [RESULT_TYPE, payload];

interface ViewOpts {
  band?: FidelityBand;
  lineups?: LineupPair;
  cfg?: typeof DEFAULT_CFG;
  events?: EventEnvelope[];
}

/** A `PadHostView` whose `state` AND `summary` both come out of the real
 *  module — `summary` in particular, because the board reads the engine's
 *  own per-side line and must never re-derive it. */
function view(opts: ViewOpts = {}): PadHostView {
  const lineups = opts.lineups ?? SOLO;
  const cfg = opts.cfg ?? DEFAULT_CFG;
  const events = opts.events ?? stream();
  const state = foldClient(boardgame, cfg, lineups, events);
  return {
    cfg,
    state,
    summary: boardgame.summary(state as never),
    phase: "live",
    band: opts.band ?? 3,
    entitlements: {},
    personNames: NAMES,
    squads: initSquads(lineups),
    events,
    contextOverrides: {},
  };
}

/** The ONE hand-built view in this file: a pad mounted before any fold
 *  exists at all. Named so it can never be mistaken for a convenience
 *  shortcut. */
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
  it("reports 'pre' for a fixture nobody has started — and that is where the pairing card lives", () => {
    expect(resolvePhase(view())).toBe("pre");
  });

  it("reports 'live' once core.start lands", () => {
    expect(resolvePhase(view({ events: stream(start()) }))).toBe("live");
  });

  it("maps the engine's own 'done' down to 'post' after a decisive result", () => {
    const v = view({ events: stream(start(), result({ winner: "H", method: "checkmate" })) });
    expect(resolvePhase(v)).toBe("post");
  });

  it("maps the engine's own DISTINCT 'abandoned' phase to 'post' too — unlike generic, boardgame never folds it into 'done'", () => {
    const v = view({ events: stream(start(), ["core.abandon", { reason: "venue lost" }]) });
    expect(resolvePhase(v)).toBe("post");
  });

  it("degrades to 'pre' for a pad mounted before any fold exists", () => {
    expect(resolvePhase(degenerateView())).toBe("pre");
  });
});

// ---------------------------------------------------------------------------
// scorebug() — tapModel S. The halves decide.
// ---------------------------------------------------------------------------

describe("buildScorebug — the halves", () => {
  it("names the PEOPLE, not the sides, when a lineup exists", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.halves[0].who.map((w) => w.name)).toEqual(["Magnus Carlsen"]);
    expect(spec.halves[1].who.map((w) => w.name)).toEqual(["Hikaru Nakamura"]);
  });

  it("falls back to the side label rather than rendering an empty who line", () => {
    const spec = buildScorebug(view({ lineups: EMPTY }), t);
    expect(spec.halves.map((h) => h.who.map((w) => w.name))).toEqual([
      ["scorepad.attribution.home"],
      ["scorepad.attribution.away"],
    ]);
    expect(assertScorebugSpec(spec)).toEqual([]);
  });

  it("neither half is tappable before the match starts — nothing to decide yet", () => {
    const spec = buildScorebug(view({ events: stream() }), t);
    // `tappable` is always PRESENT (true/false), the same convention
    // generic's own `buildHalf` takes (generic.test.ts: `tappable !== true`)
    // — never omitted, unlike A2's tapModel-T halves.
    expect(spec.halves.every((h) => h.tappable !== true && h.tapEvent === undefined)).toBe(true);
  });

  it("neither half is tappable once the fixture is already decided — a decided fixture records no more", () => {
    const v = view({ events: stream(start(), result({ winner: "H", method: "checkmate" })) });
    const spec = buildScorebug(v, t);
    expect(spec.halves.every((h) => h.tappable !== true && h.tapEvent === undefined)).toBe(true);
  });

  it("both halves are tappable once live — tapModel S, a tap DECIDES (R7-2)", () => {
    const spec = buildScorebug(view({ events: stream(start()) }), t);
    expect(spec.halves.every((h) => h.tappable === true)).toBe(true);
    expect(spec.halves[0].hintKey).toBe(RESULT_HINT_KEY);
    expect(spec.halves[1].hintKey).toBe(RESULT_HINT_KEY);
  });

  it("a half's tap posts boardgame.result naming THIS side the winner, and nothing else, when no pairing card ever ran", () => {
    const spec = buildScorebug(view({ events: stream(start()) }), t);
    expect(spec.halves[0].tapEvent).toEqual({ type: RESULT_TYPE, payload: { winner: "H" } });
    expect(spec.halves[1].tapEvent).toEqual({ type: RESULT_TYPE, payload: { winner: "A" } });
  });

  it("auto-attaches winnerPerson from the pairing card's own record — never re-asked, the tap alone decides", () => {
    const v = view({ events: stream(pairing({ homePerson: "H1", awayPerson: "A1" }), start()) });
    const spec = buildScorebug(v, t);
    expect(spec.halves[0].tapEvent).toEqual({ type: RESULT_TYPE, payload: { winner: "H", winnerPerson: "H1" } });
    expect(spec.halves[1].tapEvent).toEqual({ type: RESULT_TYPE, payload: { winner: "A", winnerPerson: "A1" } });
  });

  // Task 8 fix round 2 (review re-review round 1, Important I1(b), ruling
  // R43): the reviewer's P-series showed a `side` swap survives the whole
  // v3 scope unless a test derives the expected side from the skin's own
  // output. Here that is the tap's own winner entrant — "H"/"A" are the
  // SAME literal the test above already proves belongs to halves[0]/[1] —
  // never a typed index table.
  it("marks each half with its OWN side — the half whose tap names winner \"H\" is home's (kills a side swap)", () => {
    const spec = buildScorebug(view({ events: stream(start()) }), t);
    const home = spec.halves.find((h) => h.side === "home");
    const away = spec.halves.find((h) => h.side === "away");
    expect(home?.tapEvent).toEqual({ type: RESULT_TYPE, payload: { winner: "H" } });
    expect(away?.tapEvent).toEqual({ type: RESULT_TYPE, payload: { winner: "A" } });
  });

  it("shows an em dash before any result is recorded", () => {
    expect(buildScorebug(view(), t).halves.map((h) => h.big)).toEqual(["—", "—"]);
  });

  it("reads the big number off the ENGINE's own summary once decided, never a re-derivation", () => {
    const v = view({ events: stream(start(), result({ winner: "H", method: "checkmate" })) });
    // Default scoring: win=2 half-points ("1"), loss=0 half-points ("0").
    expect(buildScorebug(v, t).halves.map((h) => h.big)).toEqual(["1", "0"]);
  });

  it("shows the half-point draw figure for both sides after a drawn result", () => {
    const v = view({ events: stream(start(), result({ winner: null, method: "agreement" })) });
    expect(buildScorebug(v, t).halves.map((h) => h.big)).toEqual(["½", "½"]);
  });

  it("every built spec satisfies the chassis contract, across both cfgs and every phase", () => {
    for (const cfg of [DEFAULT_CFG, NO_COLORS_CFG]) {
      for (const events of [
        stream(),
        stream(start()),
        stream(start(), result({ winner: "H", method: "resign" })),
      ]) {
        for (const band of [0, 1, 3] as FidelityBand[]) {
          expect(assertScorebugSpec(buildScorebug(view({ cfg, band, events }), t)), `band ${band}`).toEqual([]);
        }
      }
    }
  });
});

describe("buildScorebug — the White indicator (led)", () => {
  it("shows on HOME from the very first render when colours are on — init() defaults home to White, no pairing card needed", () => {
    const spec = buildScorebug(view({ cfg: DEFAULT_CFG }), t);
    expect(spec.halves[0].who[0]).toEqual({
      name: "Magnus Carlsen",
      serving: true,
      servingLabel: "pad.boardgame.scorebug.white",
    });
    expect(spec.halves[1].who[0]).toEqual({ name: "Hikaru Nakamura" });
  });

  it("shows on NEITHER half when this division plays without colours", () => {
    const spec = buildScorebug(view({ cfg: NO_COLORS_CFG }), t);
    expect(spec.halves.every((h) => h.who.every((w) => w.serving === undefined))).toBe(true);
  });

  it("moves to AWAY once a pairing card names them White — reads the LIVE fold, not a frozen default", () => {
    const v = view({ events: stream(pairing({ white: "A" })) });
    const spec = buildScorebug(v, t);
    expect(spec.halves[0].who[0]?.serving).toBeUndefined();
    expect(spec.halves[1].who[0]).toEqual({
      name: "Hikaru Nakamura",
      serving: true,
      servingLabel: "pad.boardgame.scorebug.white",
    });
  });
});

describe("buildScorebug — the context line", () => {
  it("states colours tracked, and nothing else before a board number is known", () => {
    expect(buildScorebug(view({ cfg: DEFAULT_CFG }), t).context).toBe("pad.boardgame.context.colors");
  });

  it("states no colours for a division that plays without them", () => {
    expect(buildScorebug(view({ cfg: NO_COLORS_CFG }), t).context).toBe("pad.boardgame.context.noColors");
  });

  it("appends the board number once a pairing card names one", () => {
    const v = view({ events: stream(pairing({ board: 3 })) });
    expect(buildScorebug(v, t).context).toBe(
      'pad.boardgame.context.colors · pad.boardgame.context.board({"board":3})',
    );
  });
});

// ---------------------------------------------------------------------------
// tiles() — the pairing card, and, live, the draw tile only
// ---------------------------------------------------------------------------

const tileIds = (v: PadHostView): string[] => buildTiles(v, t).map((tile) => tile.id);
const tileById = (v: PadHostView, id: string): TileSpec | undefined =>
  buildTiles(v, t).find((tile) => tile.id === id);

/** The draw tile's own posted event, unpacked and type-narrowed once so
 *  every call site below stays a plain object comparison. Throws loudly if
 *  the tile is missing or not event-shaped, which is a fixture bug in the
 *  test, never a value this file wants to compare against `undefined`. */
function drawTileEvent(v: PadHostView): { type: string; payload: Record<string, unknown> } {
  const action = tileById(v, DRAW_TILE_ID)?.action;
  if (!action || !("event" in action)) throw new Error("draw tile is missing or not event-shaped");
  return action.event as { type: string; payload: Record<string, unknown> };
}

describe("buildTiles — pre phase", () => {
  it("offers only the pairing card, span 4, at band 1+", () => {
    const tiles = buildTiles(view({ band: 1 }), t);
    expect(tiles.map((tile) => tile.id)).toEqual([PAIRING_TILE_ID]);
    expect(tiles[0]).toMatchObject({ span: 4, phases: ["pre"], action: { sheet: PAIRING_TILE_ID } });
  });

  it("withholds the pairing card below its own band — a band-0 fixture never sees an offer it cannot afford", () => {
    expect(tileIds(view({ band: 0 }))).toEqual([]);
  });

  it("never offers the draw tile before the match starts", () => {
    expect(tileIds(view({ band: 3 }))).not.toContain(DRAW_TILE_ID);
  });
});

describe("buildTiles — live phase", () => {
  it("offers only the draw tile, span 4, at band 0 — a decisive result now comes from the halves themselves", () => {
    const v = view({ band: 0, events: stream(start()) });
    const tiles = buildTiles(v, t);
    expect(tiles.map((tile) => tile.id)).toEqual([DRAW_TILE_ID]);
    expect(tiles[0]).toMatchObject({ span: 4, phases: ["live"] });
  });

  it("the draw tile posts boardgame.result directly, winner: null — the one outcome no half tap can express", () => {
    const v = view({ events: stream(start()) });
    expect(tileById(v, DRAW_TILE_ID)?.action).toEqual({ event: { type: RESULT_TYPE, payload: { winner: null } } });
  });

  it("never re-offers the pairing card once the match has started", () => {
    expect(tileIds(view({ events: stream(start()) }))).not.toContain(PAIRING_TILE_ID);
  });
});

describe("buildTiles — post phase", () => {
  it("offers nothing at all once the fixture is decided — a decided fixture records no more", () => {
    const v = view({ events: stream(start(), result({ winner: "H", method: "checkmate" })) });
    expect(tileIds(v)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The pairing tile, both tappable halves and the draw tile agree with the
// chassis: nothing is EVER left for a More sheet, across both cfgs and every
// phase/band this skin can reach — proven against the REAL `moreActions`,
// not assumed from reading padSpec's panels and this skin's own tiles/halves
// side by side. `dedicatedEventTypes` (pad-host.tsx) walks
// `scorebug.halves[].tapEvent` as well as tile actions, so a tappable half
// is exactly as load-bearing here as a tile — re-proved under the tapModel S
// shape, not deleted.
// ---------------------------------------------------------------------------

function realMoreActions(v: PadHostView): string[] {
  const spec = realPadSpec(cfgOf(v));
  const tiles = buildTiles(v, t);
  const sheets = buildSheets(v, t);
  const scorebug = buildScorebug(v, t);
  const dedicated = dedicatedEventTypes(tiles, sheets, [], scorebug);
  return moreActions(
    spec,
    { state: v.state, summary: v.summary, phase: resolvePhase(v), band: v.band },
    dedicated,
    new Set<string>(),
  ).map((action) => action.type);
}

describe("the chassis's own More sheet never has anything left to offer", () => {
  it("across both cfgs, every band, and pre/live/post", () => {
    for (const cfg of [DEFAULT_CFG, NO_COLORS_CFG]) {
      for (const band of [0, 1, 3] as FidelityBand[]) {
        for (const events of [
          stream(),
          stream(start()),
          stream(start(), result({ winner: "H", method: "checkmate" })),
        ]) {
          const v = view({ cfg, band, events });
          expect(realMoreActions(v), `phase=${resolvePhase(v)} band=${band}`).toEqual([]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// sheets() — the pairing card only. The decisive/drawn result no longer
// opens a sheet at all under tapModel S (see `boardgame.tsx`'s header).
// ---------------------------------------------------------------------------

describe("buildSheets — the pairing card", () => {
  it("asks board + white when colours are on, and auto-attaches whichever lineup members it already knows", () => {
    const sheet = buildSheets(view({ cfg: DEFAULT_CFG }), t)[PAIRING_TILE_ID]!;
    expect(sheet.event).toBe(PAIRING_TYPE);
    expect(sheet.steps.map((s) => s.id)).toEqual(["board", "white"]);
    expect(sheet.buildPayload({ board: "3", white: "away" })).toEqual({
      board: 3,
      white: "A",
      homePerson: "H1",
      awayPerson: "A1",
    });
  });

  it("asks board ONLY when this division plays without colours — no white step at all", () => {
    const sheet = buildSheets(view({ cfg: NO_COLORS_CFG }), t)[PAIRING_TILE_ID]!;
    expect(sheet.steps.map((s) => s.id)).toEqual(["board"]);
    const payload = sheet.buildPayload({ board: "5" });
    expect(payload).toEqual({ board: 5, homePerson: "H1", awayPerson: "A1" });
    expect("white" in payload).toBe(false);
  });

  it("never auto-attaches a person the lineup does not name — no one-option picker to fake either", () => {
    const sheet = buildSheets(view({ cfg: NO_COLORS_CFG, lineups: EMPTY }), t)[PAIRING_TILE_ID]!;
    const payload = sheet.buildPayload({ board: "1" });
    expect(payload).toEqual({ board: 1 });
  });

  it("the board step is bounded by the engine's own field, and prefills from the fold's current value", () => {
    const v = view({ events: stream(pairing({ board: 7 })) });
    const sheet = buildSheets(v, t)[PAIRING_TILE_ID]!;
    const boardStep = sheet.steps.find((s) => s.id === "board");
    expect(boardStep?.kind).toBe("number");
    if (boardStep?.kind === "number") {
      expect(boardStep.initial).toBe(7);
      expect(boardStep.min).toBe(1);
      expect(boardStep.max).toBe(BOARD_MAX);
    }
  });

  it("is the ONLY sheet this skin declares — the decisive/drawn result is a tap and a dock now, never a sheet", () => {
    expect(Object.keys(buildSheets(view({ events: stream(start()) }), t))).toEqual([PAIRING_TILE_ID]);
  });

  // R7 follow-ups item 3 — `pairingSheet` used to pre-resolve its steps'
  // `title` through `t()` itself, and `guided-sheet.tsx` calls `t(step.title)`
  // AGAIN at render time; with a real translator that double-resolution logs
  // `[i18n] missing key` on every render (proved directly against this same
  // pattern in badminton.tsx). This file's own `t` stub above is an identity
  // function for a no-vars call, so it cannot tell "resolved" from "raw" —
  // a distinct stub is needed to make the regression visible.
  it("does NOT pre-resolve the sheet's titles — they stay raw MessageKeys for guided-sheet.tsx's own t() to resolve", () => {
    const XLATE: TFn = (key) => `XLATED:${key}`;
    const sheet = buildSheets(view({ cfg: DEFAULT_CFG }), XLATE)[PAIRING_TILE_ID]!;
    for (const step of sheet.steps) {
      expect(step.title.startsWith("XLATED:"), `${step.id}'s title must not be pre-resolved`).toBe(false);
      expect(step.title.startsWith("pad.boardgame.")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The seam, folded: every payload this pad can produce — the pairing sheet,
// a half tap, the draw tile's own tap, and every method a dock chip can
// mutate onto either — folds through the REAL engine, both cfgs.
// ---------------------------------------------------------------------------

describe("every payload this pad can produce folds through the real engine", () => {
  function foldOne(cfg: typeof DEFAULT_CFG, events: EventEnvelope[], type: string, payload: unknown): unknown {
    return foldClient(boardgame, cfg, SOLO, [...events, ev(events.length, type, payload)]);
  }

  it("the pairing sheet's payload, with and without colours", () => {
    const base = stream();
    for (const cfg of [DEFAULT_CFG, NO_COLORS_CFG]) {
      const sheet = buildSheets(view({ cfg, events: base }), t)[PAIRING_TILE_ID]!;
      const answers: Record<string, string> = cfg === DEFAULT_CFG ? { board: "1", white: "home" } : { board: "1" };
      expect(() => foldOne(cfg, base, PAIRING_TYPE, sheet.buildPayload(answers))).not.toThrow();
    }
  });

  it("a half tap's own payload, across every DECISIVE method a dock chip can mutate onto it", () => {
    const base = stream(start());
    for (const method of DECISIVE_METHODS) {
      const v = view({ events: base });
      const tapped = buildScorebug(v, t).halves[0]!.tapEvent!.payload;
      const dock = buildDock(RESULT_TYPE, v, t, tapped)!;
      const chip = dock.chips.find((c) => c.id === `method:${method}`)!;
      const payload = chip.mutate(tapped);
      const folded = foldOne(DEFAULT_CFG, base, RESULT_TYPE, payload) as { outcome?: { kind?: string } };
      expect(folded.outcome?.kind, method).toBe("win");
    }
  });

  it("the draw tile's own payload, across every DRAWN method a dock chip can mutate onto it", () => {
    const base = stream(start());
    for (const method of DRAWN_METHODS) {
      const v = view({ events: base });
      const drawn = drawTileEvent(v).payload;
      const dock = buildDock(RESULT_TYPE, v, t, drawn)!;
      const chip = dock.chips.find((c) => c.id === `method:${method}`)!;
      const payload = chip.mutate(drawn);
      const folded = foldOne(DEFAULT_CFG, base, RESULT_TYPE, payload) as { outcome?: { kind?: string } };
      // double_forfeit is the one drawn-branch method that folds to a
      // no_result rather than a draw (chess.md §7) — every other method here
      // is an ordinary draw.
      expect(folded.outcome?.kind, method).toBe(method === "double_forfeit" ? "no_result" : "draw");
    }
  });

  it("a full realistic sequence — pairing, then a half tap naming the pairing card's own player, enriched by a method chip", () => {
    const events = stream(
      // `white` on a REAL event payload is an ENTRANT id ("A"), never the
      // side label ("away") — unlike `sheet.buildPayload`'s own ANSWER map
      // just above, which takes the side label and translates it itself.
      pairing({ board: 4, white: "A", homePerson: "H1", awayPerson: "A1" }),
      start(),
    );
    const v = view({ events });
    const half = buildScorebug(v, t).halves[1]!; // away
    expect(half.tapEvent).toEqual({ type: RESULT_TYPE, payload: { winner: "A", winnerPerson: "A1" } });
    const dock = buildDock(RESULT_TYPE, v, t, half.tapEvent!.payload)!;
    const chip = dock.chips.find((c) => c.id === "method:checkmate")!;
    const payload = chip.mutate(half.tapEvent!.payload);
    expect(payload).toEqual({ winner: "A", winnerPerson: "A1", method: "checkmate" });
    const folded = foldOne(DEFAULT_CFG, events, RESULT_TYPE, payload) as {
      outcome?: { kind?: string; winner?: string };
      colorOfHome?: string | null;
      board?: number;
      winnerPerson?: string;
    };
    expect(folded.outcome).toMatchObject({ kind: "win", winner: "A" });
    expect(folded.colorOfHome).toBe("B"); // away is White -> home is Black
    expect(folded.board).toBe(4);
    expect(folded.winnerPerson).toBe("A1");
  });
});

// ---------------------------------------------------------------------------
// dock() — RULING R7-2: tap decides, dock enriches. DECISIVE after a half
// tap, DRAWN after the draw tile, never one flat list of 13 (R7-10).
// ---------------------------------------------------------------------------

describe("buildDock", () => {
  it("returns null for any event type other than boardgame.result", () => {
    const v = view();
    expect(buildDock(PAIRING_TYPE, v, t)).toBeNull();
    expect(buildDock(PAIRING_TYPE, v, t, { board: 1 })).toBeNull();
    expect(buildDock("core.start", v, t, {})).toBeNull();
  });

  it("offers the DECISIVE method set for a half tap's payload (a string winner)", () => {
    const dock = buildDock(RESULT_TYPE, view(), t, { winner: "H" });
    expect(dock).not.toBeNull();
    expect(dock!.chips.map((c) => c.id)).toEqual(DECISIVE_METHODS.map((m) => `method:${m}`));
  });

  it("offers the DRAWN method set for the draw tile's payload (winner: null) — NEVER the same list", () => {
    const dock = buildDock(RESULT_TYPE, view(), t, { winner: null });
    expect(dock).not.toBeNull();
    expect(dock!.chips.map((c) => c.id)).toEqual(DRAWN_METHODS.map((m) => `method:${m}`));
    // The defect R7-10 names by number: never one flat list of 13.
    expect(dock!.chips.length).not.toBe(DECISIVE_METHODS.length + DRAWN_METHODS.length);
    expect(dock!.chips.map((c) => c.id)).not.toEqual(DECISIVE_METHODS.map((m) => `method:${m}`));
  });

  it("falls back to the DECISIVE set when called with no payload at all — the common case, defensively", () => {
    const dock = buildDock(RESULT_TYPE, view(), t);
    expect(dock!.chips.map((c) => c.id)).toEqual(DECISIVE_METHODS.map((m) => `method:${m}`));
  });

  it("the title asks how the game ended, the same question either branch asks", () => {
    const decisive = buildDock(RESULT_TYPE, view(), t, { winner: "H" })!;
    const drawn = buildDock(RESULT_TYPE, view(), t, { winner: null })!;
    expect(decisive.title).toBe("pad.boardgame.sheet.result.method.title");
    expect(drawn.title).toBe(decisive.title);
  });

  it("every chip's label resolves through the real method vocabulary, with no separate labelText", () => {
    const dock = buildDock(RESULT_TYPE, view(), t, { winner: "H" })!;
    const time = dock.chips.find((c) => c.id === "method:time")!;
    expect(time.label).toBe("method.time");
    expect(time.labelText).toBeUndefined();
  });

  it("a chip's mutate rewrites ONLY method, preserving the rest of the held payload untouched", () => {
    const dock = buildDock(RESULT_TYPE, view(), t, { winner: "H", winnerPerson: "H1" })!;
    const chip = dock.chips.find((c) => c.id === "method:resign")!;
    expect(chip.mutate({ winner: "H", winnerPerson: "H1" })).toEqual({
      winner: "H",
      winnerPerson: "H1",
      method: "resign",
    });
  });

  it("a second chip tap overwrites the first — the same 'a different chip wins' behaviour every dock in this chassis gives", () => {
    const dock = buildDock(RESULT_TYPE, view(), t, { winner: "H" })!;
    const first = dock.chips.find((c) => c.id === "method:checkmate")!;
    const second = dock.chips.find((c) => c.id === "method:resign")!;
    const afterFirst = first.mutate({ winner: "H" });
    const afterSecond = second.mutate(afterFirst);
    expect(afterSecond).toEqual({ winner: "H", method: "resign" });
  });
});

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half
// ---------------------------------------------------------------------------

describe("boardgameDetail", () => {
  const v = view();

  it("the pairing row states the board, who has White, and both players", () => {
    const detail = boardgameDetail({
      t,
      eventType: PAIRING_TYPE,
      payload: { board: 3, white: "H", homePerson: "H1", awayPerson: "A1" },
      state: v.state,
      personNames: NAMES,
    });
    expect(detail).toBe(
      'pad.boardgame.ribbon.board({"board":3}) · pad.boardgame.ribbon.white({"side":"scorepad.attribution.home"}) · Magnus Carlsen · Hikaru Nakamura',
    );
  });

  it("the pairing row degrades to just the board when nothing else is known", () => {
    expect(
      boardgameDetail({ t, eventType: PAIRING_TYPE, payload: { board: 9 }, state: v.state, personNames: NAMES }),
    ).toBe('pad.boardgame.ribbon.board({"board":9})');
  });

  it("a decisive result names the winning PERSON first, then the method, then the move count", () => {
    const detail = boardgameDetail({
      t,
      eventType: RESULT_TYPE,
      payload: { winner: "H", winnerPerson: "H1", method: "checkmate", moves: 41 },
      state: v.state,
      personNames: NAMES,
    });
    expect(detail).toBe("Magnus Carlsen · method.checkmate · pad.boardgame.ribbon.moves({\"moves\":41})");
  });

  it("falls back to the winning SIDE when no person was ever named", () => {
    const detail = boardgameDetail({
      t,
      eventType: RESULT_TYPE,
      payload: { winner: "A", method: "resign" },
      state: v.state,
      personNames: NAMES,
    });
    expect(detail).toBe("scorepad.attribution.away · method.resign");
  });

  it("a drawn result states the method's own words alone — no extra 'Draw' is minted", () => {
    const detail = boardgameDetail({
      t,
      eventType: RESULT_TYPE,
      payload: { winner: null, method: "agreement" },
      state: v.state,
      personNames: NAMES,
    });
    expect(detail).toBe("method.agreement");
  });

  it("a no-result (double forfeit) reads the same way — the method text already says which", () => {
    const detail = boardgameDetail({
      t,
      eventType: RESULT_TYPE,
      payload: { winner: null, method: "double_forfeit" },
      state: v.state,
      personNames: NAMES,
    });
    expect(detail).toBe("method.double_forfeit");
  });

  it("adds nothing it cannot see, and nothing for an event type it does not know", () => {
    expect(boardgameDetail({ t, eventType: RESULT_TYPE, payload: {}, state: v.state, personNames: NAMES })).toBeUndefined();
    expect(boardgameDetail({ t, eventType: "core.start", payload: {}, state: v.state, personNames: NAMES })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The registry, the vocabulary, and the four dictionaries
// ---------------------------------------------------------------------------

describe("registry", () => {
  it("resolves boardgame to the v3 lane, and hands back a real, tapModel-S skin", () => {
    const skin = resolvePad("boardgame", t);
    expect(skin.key).toBe("boardgame");
    expect(skin.tapModel).toBe("S");
    expect(typeof skin.phase).toBe("function");
  });
});

describe("the engine surface this skin restates", () => {
  it("EVENT_BAND is the module's own fidelity map, not a second scale", () => {
    expect(EVENT_BAND).toEqual(realPadSpec(DEFAULT_CFG).fidelity);
    expect(EVENT_BAND).toEqual(realPadSpec(NO_COLORS_CFG).fidelity);
  });

  it("DECISIVE_METHODS/DRAWN_METHODS are the engine's own field values, not hand-copied", () => {
    const spec = realPadSpec(DEFAULT_CFG);
    const resultActions = spec.panels.flatMap((panel) => panel.actions).filter((a) => a.type === RESULT_TYPE);
    const decisive = resultActions.find((a) => a.attribution.length > 0);
    const drawn = resultActions.find((a) => a.attribution.length === 0);
    const methodValues = (action: (typeof resultActions)[number] | undefined): readonly string[] =>
      (action?.fields.find((f) => f.path === "method") as { values?: readonly string[] } | undefined)?.values ?? [];
    expect([...DECISIVE_METHODS]).toEqual([...methodValues(decisive)]);
    expect([...DRAWN_METHODS]).toEqual([...methodValues(drawn)]);
  });

  // MOVES_MAX no longer lives in boardgame.tsx: `moves` was a guided-sheet
  // step, and tapModel S's dock is chips only (`buildDock`'s own header) —
  // the move count is not reachable from this grammar any more.
  it("BOARD_MAX is the engine's own field bound", () => {
    const spec = realPadSpec(DEFAULT_CFG);
    const actions = spec.panels.flatMap((panel) => panel.actions);
    const board = actions.flatMap((a) => a.fields).find((f) => f.path === "board") as { max?: number } | undefined;
    expect(board?.max).toBe(BOARD_MAX);
  });
});

describe("vocabulary and copy", () => {
  it("both ribbon keys are REGISTERED, not merely translated", () => {
    for (const type of [RESULT_TYPE, PAIRING_TYPE]) {
      expect(PAD_LABEL_KEYS).toContain(ribbonKeyFor(type));
    }
  });

  // The SAME gate for the scorebug HINT, and it is here because the first cut
  // of this rework shipped without it. `padLabel()` (scorebug.tsx:228) looks
  // the key up in PAD_LABEL_KEYS and falls back to printing the key ITSELF, so
  // a hint present in all four dictionaries and in the generated key union
  // still rendered `pad.boardgame.scorebug.result.hint` as visible text on
  // BOTH halves of a live chess board. i18n parity, the union drift gate, tsc,
  // lint and 13124 unit tests were all green on it; a 1280px screenshot is
  // what caught it. badminton, table tennis, volleyball and generic each carry
  // this same assertion — boardgame was the one model-S skin without it, which
  // is exactly why it was the one that regressed.
  it("every hintKey the scorebug emits is REGISTERED in PAD_LABEL_KEYS, not merely translated", () => {
    const registered = new Set<string>(PAD_LABEL_KEYS);
    const hints = new Set<string>();
    for (const band of [0, 1, 2, 3] as const) {
      for (const cfg of [DEFAULT_CFG, NO_COLORS_CFG]) {
        for (const half of buildScorebug(view({ band, cfg, events: stream(start()) }), t).halves) {
          if (half.hintKey !== undefined) hints.add(half.hintKey);
        }
      }
    }
    // Non-vacuous: a sweep that produced no tappable half at all would make
    // the loop below assert nothing and still pass.
    expect(hints.size).toBeGreaterThan(0);
    expect(hints).toContain(RESULT_HINT_KEY);
    for (const key of hints) {
      expect(registered.has(key), `${key} is not in PAD_LABEL_KEYS — padLabel() will print the raw key`).toBe(true);
    }
  });

  /** Every key this skin can put on screen, collected from BUILT specs
   *  rather than from a hand list — the same "collect, don't hand-list"
   *  posture generic's own sweep takes. */
  function keysOn(v: PadHostView): Set<string> {
    const seen = new Set<string>();
    const recording: TFn = (key) => {
      seen.add(key);
      return key;
    };
    buildScorebug(v, recording);
    for (const tile of buildTiles(v, recording)) {
      seen.add(tile.label);
      if (tile.sublabel) seen.add(tile.sublabel);
    }
    for (const sheet of Object.values(buildSheets(v, recording))) {
      for (const step of sheet.steps) {
        seen.add(step.title);
        if (step.kind === "choice") for (const o of step.options) seen.add(o.label);
        if (step.kind === "number" && step.hintText) seen.add(step.hintText);
      }
    }
    // The dock's own keys — its title, and every chip's label — for BOTH
    // branches, since the chip set differs by branch (R7-10) and a sweep
    // that only ever probed one would miss the other's method keys entirely.
    for (const winner of ["H", null] as const) {
      const dock = buildDock(RESULT_TYPE, v, recording, { winner });
      if (dock) {
        seen.add(dock.title);
        for (const chip of dock.chips) seen.add(chip.label);
      }
    }
    // `boardgameDetail` is not called with `v` as its context — `named()`
    // short-circuits to the resolved NAME (never a key) whenever
    // `personNames` already knows the id, so these payloads deliberately
    // name people `recording`'s OWN dictionary does not know, forcing every
    // `t()`/`vocabText()` call inside `pairingDetail`/`resultDetail` to
    // actually fire and be captured — `recording` itself accumulates the
    // keys as they are resolved, so nothing further needs collecting from
    // the (joined, no-longer-a-key) return value.
    for (const [type, payload] of [
      [PAIRING_TYPE, { board: 1, white: "H", homePerson: "H1", awayPerson: "A1" }],
      [RESULT_TYPE, { winner: "H", winnerPerson: "H1", method: "checkmate", moves: 10 }],
      [RESULT_TYPE, { winner: null, method: "agreement" }],
    ] as const) {
      boardgameDetail({ t: recording, eventType: type, payload, state: v.state, personNames: NAMES });
    }
    for (const type of [RESULT_TYPE, PAIRING_TYPE]) seen.add(ribbonKeyFor(type));
    return seen;
  }

  it("every key it can render exists in the English dictionary", () => {
    const all = new Set<string>();
    for (const cfg of [DEFAULT_CFG, NO_COLORS_CFG]) {
      for (const band of [0, 1, 3] as FidelityBand[]) {
        for (const lineups of [SOLO, EMPTY]) {
          for (const events of [stream(), stream(start()), stream(pairing({ board: 1 }))]) {
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
