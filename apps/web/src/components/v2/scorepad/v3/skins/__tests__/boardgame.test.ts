// R7/A2 — the boardgame SkinDefV3. Pure-data assertions (apps/web vitest is
// `environment: "node"`, no jsdom): the skin is a spec BUILDER, so this file
// asserts the specs it returns and leaves the DOM to the e2e/gallery layer.
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
import { LEGACY_SPORTS, resolvePad } from "../../registry";
import { ribbonKeyFor } from "../../ribbon";
import { assertScorebugSpec, type PadHostView, type TileSpec } from "../../types";
import {
  BOARD_MAX,
  DECISIVE_METHODS,
  DRAWN_METHODS,
  DRAW_TILE_ID,
  EVENT_BAND,
  MOVES_MAX,
  PAIRING_TILE_ID,
  PAIRING_TYPE,
  RESULT_TILE_ID,
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
// scorebug() — tapModel T, pure readouts
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

  it("neither half is tappable — tapModel T, every action is a tile", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.halves.every((h) => h.tappable === undefined && h.tapEvent === undefined)).toBe(true);
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
// tiles() — one per padSpec action
// ---------------------------------------------------------------------------

const tileIds = (v: PadHostView): string[] => buildTiles(v, t).map((tile) => tile.id);
const tileById = (v: PadHostView, id: string): TileSpec | undefined =>
  buildTiles(v, t).find((tile) => tile.id === id);

describe("buildTiles — pre phase", () => {
  it("offers only the pairing card, span 4, at band 1+", () => {
    const tiles = buildTiles(view({ band: 1 }), t);
    expect(tiles.map((tile) => tile.id)).toEqual([PAIRING_TILE_ID]);
    expect(tiles[0]).toMatchObject({ span: 4, phases: ["pre"], action: { sheet: PAIRING_TILE_ID } });
  });

  it("withholds the pairing card below its own band — a band-0 fixture never sees an offer it cannot afford", () => {
    expect(tileIds(view({ band: 0 }))).toEqual([]);
  });

  it("never offers the result or draw tile before the match starts", () => {
    expect(tileIds(view({ band: 3 }))).not.toContain(RESULT_TILE_ID);
    expect(tileIds(view({ band: 3 }))).not.toContain(DRAW_TILE_ID);
  });
});

describe("buildTiles — live phase", () => {
  it("offers Result and Draw side by side, span 2 each, at band 0 — a board game's terminal record ships free", () => {
    const v = view({ band: 0, events: stream(start()) });
    const tiles = buildTiles(v, t);
    expect(tiles.map((tile) => tile.id)).toEqual([RESULT_TILE_ID, DRAW_TILE_ID]);
    for (const tile of tiles) expect(tile).toMatchObject({ span: 2, phases: ["live"] });
    expect(tileById(v, RESULT_TILE_ID)?.action).toEqual({ sheet: RESULT_TILE_ID });
    expect(tileById(v, DRAW_TILE_ID)?.action).toEqual({ sheet: DRAW_TILE_ID });
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
// The Result/Draw/Pairing tiles agree with the chassis: nothing is EVER left
// for a More sheet, across both cfgs and every phase/band this skin can
// reach — proven against the REAL `moreActions`, not assumed from reading
// `padSpec`'s three panels and this skin's three tiles side by side.
// ---------------------------------------------------------------------------

function realMoreActions(v: PadHostView): string[] {
  const spec = realPadSpec(cfgOf(v));
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
// sheets()
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
});

describe("buildSheets — the decisive result", () => {
  it("asks who won, how, and the (optional) move count", () => {
    const sheet = buildSheets(view({ events: stream(start()) }), t)[RESULT_TILE_ID]!;
    expect(sheet.event).toBe(RESULT_TYPE);
    expect(sheet.steps.map((s) => s.id)).toEqual(["winner", "method", "moves"]);
  });

  it("builds a bare winner when moves is left at 0 and no pairing card ever named a player", () => {
    const sheet = buildSheets(view({ events: stream(start()) }), t)[RESULT_TILE_ID]!;
    expect(sheet.buildPayload({ winner: "away", method: "resign", moves: "0" })).toEqual({
      winner: "A",
      method: "resign",
    });
  });

  it("includes moves only when it is actually greater than zero", () => {
    const sheet = buildSheets(view({ events: stream(start()) }), t)[RESULT_TILE_ID]!;
    expect(sheet.buildPayload({ winner: "home", method: "checkmate", moves: "41" })).toEqual({
      winner: "H",
      method: "checkmate",
      moves: 41,
    });
  });

  it("auto-attaches winnerPerson from the pairing card's own record for the WINNING side — never re-asked", () => {
    const v = view({ events: stream(pairing({ homePerson: "H1", awayPerson: "A1" }), start()) });
    const sheet = buildSheets(v, t)[RESULT_TILE_ID]!;
    expect(sheet.buildPayload({ winner: "home", method: "checkmate", moves: "0" })).toEqual({
      winner: "H",
      method: "checkmate",
      winnerPerson: "H1",
    });
    expect(sheet.buildPayload({ winner: "away", method: "resign", moves: "0" })).toEqual({
      winner: "A",
      method: "resign",
      winnerPerson: "A1",
    });
  });

  it("the method step carries every DECISIVE method, and ONLY 'time' — the clock flag falling — carries the dismissal tone", () => {
    const sheet = buildSheets(view(), t)[RESULT_TILE_ID]!;
    const methodStep = sheet.steps.find((s) => s.id === "method");
    expect(methodStep?.kind).toBe("choice");
    if (methodStep?.kind === "choice") {
      expect(methodStep.options.map((o) => o.id)).toEqual([...DECISIVE_METHODS]);
      for (const option of methodStep.options) {
        expect(option.tone, option.id).toEqual(option.id === "time" ? ["dismissal"] : undefined);
      }
      const time = methodStep.options.find((o) => o.id === "time");
      expect(time?.label).toBe("method.time");
    }
  });

  it("the moves step is bounded by the engine's own field", () => {
    const sheet = buildSheets(view(), t)[RESULT_TILE_ID]!;
    const movesStep = sheet.steps.find((s) => s.id === "moves");
    expect(movesStep?.kind).toBe("number");
    if (movesStep?.kind === "number") {
      expect(movesStep.min).toBe(0);
      expect(movesStep.max).toBe(MOVES_MAX);
      expect(movesStep.initial).toBe(0);
    }
  });
});

describe("buildSheets — the drawn / no-result branch", () => {
  it("asks how, and the move count — never a winner step, matching padSpec's own empty attribution list", () => {
    const sheet = buildSheets(view(), t)[DRAW_TILE_ID]!;
    expect(sheet.event).toBe(RESULT_TYPE);
    expect(sheet.steps.map((s) => s.id)).toEqual(["method", "moves"]);
    expect(sheet.buildPayload({ method: "agreement", moves: "0" })).toEqual({ winner: null, method: "agreement" });
  });

  it("carries every DRAWN method, none of them toned — no card, no flag, on this branch", () => {
    const sheet = buildSheets(view(), t)[DRAW_TILE_ID]!;
    const methodStep = sheet.steps.find((s) => s.id === "method");
    expect(methodStep?.kind).toBe("choice");
    if (methodStep?.kind === "choice") {
      expect(methodStep.options.map((o) => o.id)).toEqual([...DRAWN_METHODS]);
      expect(methodStep.options.every((o) => o.tone === undefined)).toBe(true);
    }
  });

  it("includes moves only when greater than zero, same rule as the decisive branch", () => {
    const sheet = buildSheets(view(), t)[DRAW_TILE_ID]!;
    expect(sheet.buildPayload({ method: "repetition", moves: "88" })).toEqual({
      winner: null,
      method: "repetition",
      moves: 88,
    });
  });
});

// ---------------------------------------------------------------------------
// The seam, folded: every payload this pad can produce folds through the
// REAL engine, both cfgs.
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

  it("the decisive-result sheet's payload, across every method", () => {
    const base = stream(start());
    for (const method of DECISIVE_METHODS) {
      const sheet = buildSheets(view({ events: base }), t)[RESULT_TILE_ID]!;
      const payload = sheet.buildPayload({ winner: "home", method, moves: "12" });
      const folded = foldOne(DEFAULT_CFG, base, RESULT_TYPE, payload) as { outcome?: { kind?: string } };
      expect(folded.outcome?.kind, method).toBe("win");
    }
  });

  it("the draw sheet's payload, across every drawn/no-result method", () => {
    const base = stream(start());
    for (const method of DRAWN_METHODS) {
      const sheet = buildSheets(view({ events: base }), t)[DRAW_TILE_ID]!;
      const payload = sheet.buildPayload({ method, moves: "0" });
      const folded = foldOne(DEFAULT_CFG, base, RESULT_TYPE, payload) as { outcome?: { kind?: string } };
      // double_forfeit is the one drawn-branch method that folds to a
      // no_result rather than a draw (chess.md §7) — every other method here
      // is an ordinary draw.
      expect(folded.outcome?.kind, method).toBe(method === "double_forfeit" ? "no_result" : "draw");
    }
  });

  it("a full realistic sequence — pairing, then a decisive result naming the pairing card's own player", () => {
    const events = stream(
      // `white` on a REAL event payload is an ENTRANT id ("A"), never the
      // side label ("away") — unlike `sheet.buildPayload`'s own ANSWER map
      // just above, which takes the side label and translates it itself.
      pairing({ board: 4, white: "A", homePerson: "H1", awayPerson: "A1" }),
      start(),
    );
    const v = view({ events });
    const sheet = buildSheets(v, t)[RESULT_TILE_ID]!;
    const payload = sheet.buildPayload({ winner: "away", method: "checkmate", moves: "34" });
    expect(payload).toEqual({ winner: "A", method: "checkmate", moves: 34, winnerPerson: "A1" });
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
// dock() — always null; every fact is already a sheet step
// ---------------------------------------------------------------------------

describe("buildDock", () => {
  it("returns null for both event types, with or without a payload", () => {
    const v = view();
    expect(buildDock(RESULT_TYPE, v, t)).toBeNull();
    expect(buildDock(RESULT_TYPE, v, t, { winner: "H", method: "checkmate" })).toBeNull();
    expect(buildDock(PAIRING_TYPE, v, t)).toBeNull();
    expect(buildDock(PAIRING_TYPE, v, t, { board: 1 })).toBeNull();
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
  it("resolves boardgame to the v3 lane, and hands back a real, tapModel-T skin", () => {
    const lane = resolvePad("boardgame", t);
    expect(lane.lane).toBe("v3");
    if (lane.lane === "v3") {
      expect(lane.skin.key).toBe("boardgame");
      expect(lane.skin.tapModel).toBe("T");
      expect(typeof lane.skin.phase).toBe("function");
    }
  });

  it("no longer routes boardgame down the legacy lane", () => {
    expect(LEGACY_SPORTS.has("boardgame")).toBe(false);
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

  it("MOVES_MAX and BOARD_MAX are the engine's own field bounds", () => {
    const spec = realPadSpec(DEFAULT_CFG);
    const actions = spec.panels.flatMap((panel) => panel.actions);
    const moves = actions.flatMap((a) => a.fields).find((f) => f.path === "moves") as { max?: number } | undefined;
    const board = actions.flatMap((a) => a.fields).find((f) => f.path === "board") as { max?: number } | undefined;
    expect(moves?.max).toBe(MOVES_MAX);
    expect(board?.max).toBe(BOARD_MAX);
  });
});

describe("vocabulary and copy", () => {
  it("both ribbon keys are REGISTERED, not merely translated", () => {
    for (const type of [RESULT_TYPE, PAIRING_TYPE]) {
      expect(PAD_LABEL_KEYS).toContain(ribbonKeyFor(type));
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
