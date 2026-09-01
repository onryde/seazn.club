// R7/A3 — the carrom SkinDefV3. Pure-data assertions (apps/web vitest is
// `environment: "node"`, no jsdom): the skin is a spec BUILDER, so this file
// asserts the specs it returns and leaves the DOM to the e2e/gallery layer.
//
// TAPMODEL T (carried into this wave verbatim): both scorebug halves are
// READOUTS, and every action is a tile that opens a sheet. This file proves
// that shape directly, the same way `football.test.ts`/`hockey.test.ts` do
// for their own tapModel-T skins, and it does NOT reproduce boardgame's
// tapModel-S shape (that skin's own header explains why it was reworked OFF
// this grammar).
//
// EVERY STATE HERE COMES OUT OF THE REAL FOLD — `foldClient(carrom, ...)`
// over real `EventEnvelope`s, and `carrom.summary(state)` for the view's own
// `summary`, never a hand-typed state literal. The one deliberate exception
// is `degenerateView()`, named so nobody mistakes it for a shortcut.
//
// TWO CFGS, ALWAYS BOTH where a bound can move: `icf` (the shipping default)
// and `club-29` (`gameTo: 29, queenPoints: 5, queenCapAt: 24`) — R7-10's own
// ruling that the variant shifts cfg numbers only, never the event surface or
// pad shape, is proven here rather than assumed.
import { describe, expect, it } from "vitest";
import type { EventEnvelope, Lineup, LineupPair } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import type { FidelityBand, ModuleEvent } from "@seazn/engine/sport";
import { makeEnvelope } from "@seazn/engine/testkit";
import { carrom } from "@seazn/engine/sports/carrom";
import uiEn from "@/dictionaries/en/ui.json";
import { PAD_LABEL_KEYS } from "@/lib/scoring-vocab";
import { foldClient } from "../../../module-client";
import { dedicatedEventTypes, moreActions } from "../../pad-host";
import { resolvePad } from "../../registry";
import { ribbonKeyFor } from "../../ribbon";
import { assertScorebugSpec, type DockSpec, type PadHostView, type TileSpec } from "../../types";
import {
  ADJUST_REASONS,
  EVENT_BAND,
  buildDock,
  buildScorebug,
  buildSheets,
  buildTiles,
  carromDetail,
  resolvePhase,
  type TFn,
} from "../carrom";

// ---------------------------------------------------------------------------
// Fixtures — the fold, and nothing but the fold
// ---------------------------------------------------------------------------

/** The oracle `t`. It ECHOES ITS INPUT, including the vars, so an assertion
 *  on a built string cannot pass by coincidence when a branch resolves the
 *  WRONG key. */
const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

const NAMES: Record<string, string> = {
  H1: "Meena",
  A1: "Ravi",
};

function soloSide(entrantId: string, personId: string): Lineup {
  return { entrantId, slots: [{ personId, slot: "starting", orderNo: 1 }] };
}
function emptySide(entrantId: string): Lineup {
  return { entrantId, slots: [] };
}

const SOLO: LineupPair = { home: soloSide("H", "H1"), away: soloSide("A", "A1") };
const EMPTY: LineupPair = { home: emptySide("H"), away: emptySide("A") };

const DEFAULT_CFG = carrom.configSchema.parse({});
const CLUB29_CFG = carrom.configSchema.parse({ gameTo: 29, queenPoints: 5, queenCapAt: 24 });

/** `SportModule.padSpec` is typed OPTIONAL on the shared interface even
 *  though `carrom.ts` itself always assigns one — bound once, loudly, rather
 *  than a bare `!` repeated at every call site below. */
function realPadSpec(cfg: unknown) {
  const fn = carrom.padSpec;
  if (!fn) throw new Error("carrom module unexpectedly declares no padSpec");
  return fn(cfg as never);
}

const ev = (seq: number, type: string, payload: unknown): EventEnvelope =>
  makeEnvelope(seq, { type, payload } as ModuleEvent);

function stream(...events: readonly (readonly [string, unknown])[]): EventEnvelope[] {
  return events.map(([type, payload], i) => ev(i, type, payload));
}

const start = (): readonly [string, unknown] => ["core.start", {}];
const board = (payload: Record<string, unknown>): readonly [string, unknown] => ["carrom.board.summary", payload];

interface ViewOpts {
  band?: FidelityBand;
  lineups?: LineupPair;
  cfg?: typeof DEFAULT_CFG;
  events?: EventEnvelope[];
}

/** A `PadHostView` whose `state` AND `summary` both come out of the real
 *  module — `summary` in particular, because the dock reads the engine's own
 *  per-board entrant-id-resolved record and must never re-derive it. */
function view(opts: ViewOpts = {}): PadHostView {
  const lineups = opts.lineups ?? SOLO;
  const cfg = opts.cfg ?? DEFAULT_CFG;
  const events = opts.events ?? stream();
  const state = foldClient(carrom, cfg, lineups, events);
  return {
    cfg,
    state,
    summary: carrom.summary(state as never),
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
  it("reports 'pre' before core.start — the toss belongs here", () => {
    expect(resolvePhase(view())).toBe("pre");
  });

  it("reports 'live' once core.start lands", () => {
    expect(resolvePhase(view({ events: stream(start()) }))).toBe("live");
  });

  it("maps the engine's own 'done' down to 'post' after a forfeit", () => {
    const v = view({ events: stream(start(), ["core.forfeit", { by: "H", reason: "test forfeit" }]) });
    expect(resolvePhase(v)).toBe("post");
  });

  it("maps the engine's own 'abandoned' phase to 'post' too", () => {
    const v = view({ events: stream(start(), ["core.abandon", { reason: "test abandon" }]) });
    expect(resolvePhase(v)).toBe("post");
  });

  it("degrades to 'pre' for a pad mounted before any fold exists", () => {
    expect(resolvePhase(degenerateView())).toBe("pre");
  });
});

// ---------------------------------------------------------------------------
// scorebug() — tapModel T: both halves are readouts.
// ---------------------------------------------------------------------------

describe("buildScorebug — the halves", () => {
  it("names the PEOPLE, not the sides — entrantModel is individual/pair, never a team", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.halves[0].who.map((w) => w.name)).toEqual(["Meena"]);
    expect(spec.halves[1].who.map((w) => w.name)).toEqual(["Ravi"]);
  });

  it("falls back to the side label rather than rendering an empty who line", () => {
    const spec = buildScorebug(view({ lineups: EMPTY }), t);
    expect(spec.halves.map((h) => h.who.map((w) => w.name))).toEqual([
      ["scorepad.attribution.home"],
      ["scorepad.attribution.away"],
    ]);
    expect(assertScorebugSpec(spec)).toEqual([]);
  });

  it("neither half is ever tappable — tapModel T, both are readouts", () => {
    for (const events of [stream(), stream(start())]) {
      const spec = buildScorebug(view({ events }), t);
      expect(spec.halves.every((h) => h.tappable !== true && h.tapEvent === undefined)).toBe(true);
    }
  });

  it("shows 0-0 before any board is recorded", () => {
    expect(buildScorebug(view({ events: stream(start()) }), t).halves.map((h) => h.big)).toEqual(["0", "0"]);
  });

  it("reads the CURRENT (open) game's points, not a cross-game total", () => {
    const v = view({ events: stream(start(), board({ winner: "H", opponentCoinsLeft: 4 })) });
    expect(buildScorebug(v, t).halves.map((h) => h.big)).toEqual(["4", "0"]);
  });

  it("the sub figure is the SERIES tally (games won), honestly zero before any game closes", () => {
    const v = view({ events: stream(start(), board({ winner: "H", opponentCoinsLeft: 4 })) });
    expect(buildScorebug(v, t).halves.map((h) => h.sub)).toEqual(["(0)", "(0)"]);
  });

  it("every built spec satisfies the chassis contract, across both cfgs, every band and phase", () => {
    for (const cfg of [DEFAULT_CFG, CLUB29_CFG]) {
      for (const events of [stream(), stream(start()), stream(start(), board({ winner: "H", opponentCoinsLeft: 4 }))]) {
        for (const band of [0, 1, 3] as FidelityBand[]) {
          expect(assertScorebugSpec(buildScorebug(view({ cfg, band, events }), t)), `band ${band}`).toEqual([]);
        }
      }
    }
  });
});

describe("buildScorebug — context and strip", () => {
  it("states the format — best of N, first to M", () => {
    expect(buildScorebug(view({ cfg: DEFAULT_CFG }), t).context).toBe(
      'pad.carrom.context.format({"bestOf":3,"gameTo":25})',
    );
  });

  it("states the CLUB-29 numbers, not the icf default — R7-10, no code branch needed", () => {
    expect(buildScorebug(view({ cfg: CLUB29_CFG }), t).context).toBe(
      'pad.carrom.context.format({"bestOf":3,"gameTo":29})',
    );
  });

  it("omits the game strip item before core.start — nothing to show yet", () => {
    expect(buildScorebug(view({ events: stream() }), t).strip).toEqual([]);
  });

  it("shows 'Game 1/3' the instant the first game opens", () => {
    const strip = buildScorebug(view({ events: stream(start()) }), t).strip;
    expect(strip).toEqual([{ id: "game", label: "pad.carrom.header.game", value: "1/3", tone: "led" }]);
  });
});

// ---------------------------------------------------------------------------
// tiles() — one tile per padSpec action.
// ---------------------------------------------------------------------------

const tileIds = (v: PadHostView): string[] => buildTiles(v).map((tile) => tile.id);
const tileById = (v: PadHostView, id: string): TileSpec | undefined =>
  buildTiles(v).find((tile) => tile.id === id);

describe("buildTiles — pre phase", () => {
  it("offers the toss tile, span 4, at band 1+", () => {
    const tiles = buildTiles(view({ band: 1 }));
    expect(tiles.map((tile) => tile.id)).toEqual(["toss"]);
    expect(tiles[0]).toMatchObject({ span: 4, phases: ["pre"], action: { sheet: "toss" } });
  });

  it("withholds the toss tile below band 1 — a band-0 org cannot afford it", () => {
    expect(tileIds(view({ band: 0 }))).toEqual([]);
  });
});

describe("buildTiles — live phase", () => {
  it("offers both board tiles at band 0 — carrom.board.summary is band 0", () => {
    const v = view({ band: 0, events: stream(start()) });
    expect(tileIds(v)).toEqual(["board", "boardQueen"]);
    expect(tileById(v, "board")).toMatchObject({ span: 2, kind: "primary", phases: ["live"], action: { sheet: "board" } });
    expect(tileById(v, "boardQueen")).toMatchObject({
      span: 2,
      kind: "primary",
      phases: ["live"],
      action: { sheet: "boardQueen" },
    });
  });

  it("adds the two adjustment tiles only at band 1+", () => {
    const v0 = view({ band: 0, events: stream(start()) });
    const v1 = view({ band: 1, events: stream(start()) });
    expect(tileIds(v0)).not.toContain("adjustCredit");
    expect(tileIds(v0)).not.toContain("adjustDeduct");
    expect(tileIds(v1)).toEqual(["board", "boardQueen", "adjustCredit", "adjustDeduct"]);
    expect(tileById(v1, "adjustCredit")).toMatchObject({ kind: "minor", span: 2, action: { sheet: "adjustCredit" } });
    expect(tileById(v1, "adjustDeduct")).toMatchObject({ kind: "minor", span: 2, action: { sheet: "adjustDeduct" } });
  });

  it("never re-offers the toss tile once the match has started", () => {
    expect(tileIds(view({ events: stream(start()) }))).not.toContain("toss");
  });

  it("declares no 'more' tile at all — every padSpec action is already dedicated", () => {
    for (const band of [0, 1, 3] as FidelityBand[]) {
      expect(tileIds(view({ band, events: stream(start()) }))).not.toContain("more");
    }
  });
});

describe("buildTiles — post phase", () => {
  it("offers nothing at all once the fixture is decided", () => {
    const v = view({ events: stream(start(), ["core.forfeit", { by: "H", reason: "test forfeit" }]) });
    expect(tileIds(v)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Every padSpec action is dedicated — nothing is EVER left for a More sheet,
// proven against the REAL `moreActions`, not assumed from reading padSpec's
// panels and this skin's own tiles/sheets side by side.
// ---------------------------------------------------------------------------

function realMoreActions(v: PadHostView): string[] {
  const spec = realPadSpec(v.cfg);
  const tiles = buildTiles(v);
  const sheets = buildSheets(v);
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
    for (const cfg of [DEFAULT_CFG, CLUB29_CFG]) {
      for (const band of [0, 1, 3] as FidelityBand[]) {
        for (const events of [stream(), stream(start()), stream(start(), ["core.forfeit", { by: "H", reason: "test forfeit" }])]) {
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

describe("buildSheets — toss", () => {
  it("asks exactly one question — who breaks first", () => {
    const sheet = buildSheets(view())["toss"]!;
    expect(sheet.event).toBe("carrom.toss");
    expect(sheet.steps.map((s) => s.id)).toEqual(["firstBreak"]);
    expect(sheet.buildPayload({ firstBreak: "away" })).toEqual({ firstBreak: "A" });
    expect(sheet.buildPayload({ firstBreak: "home" })).toEqual({ firstBreak: "H" });
  });
});

describe("buildSheets — board (no queen)", () => {
  it("asks winner then coins, and never sends queenTo at all", () => {
    const sheet = buildSheets(view())["board"]!;
    expect(sheet.event).toBe("carrom.board.summary");
    expect(sheet.steps.map((s) => s.id)).toEqual(["winner", "coins"]);
    const payload = sheet.buildPayload({ winner: "home", coins: "4" });
    expect(payload).toEqual({ winner: "H", opponentCoinsLeft: 4 });
    expect("queenTo" in payload).toBe(false);
  });

  it("the coins step is bounded 0-9 — Law 52(b)(ii)'s own FIXED bound, not cfg-derived", () => {
    for (const cfg of [DEFAULT_CFG, CLUB29_CFG]) {
      const step = buildSheets(view({ cfg }))["board"]!.steps.find((s) => s.id === "coins");
      expect(step?.kind).toBe("number");
      if (step?.kind === "number") {
        expect(step.min).toBe(0);
        expect(step.max).toBe(9);
      }
    }
  });
});

describe("buildSheets — board (queen covered)", () => {
  it("asks winner, THEN queenTo independently, then coins", () => {
    const sheet = buildSheets(view())["boardQueen"]!;
    expect(sheet.event).toBe("carrom.board.summary");
    expect(sheet.steps.map((s) => s.id)).toEqual(["winner", "queenTo", "coins"]);
    expect(sheet.buildPayload({ winner: "home", queenTo: "away", coins: "3" })).toEqual({
      winner: "H",
      queenTo: "A",
      opponentCoinsLeft: 3,
    });
  });
});

describe("buildSheets — umpire adjustment", () => {
  it("credit: delta bounded 1..cfg.gameTo, asks side, delta, reason", () => {
    const sheet = buildSheets(view({ cfg: DEFAULT_CFG }))["adjustCredit"]!;
    expect(sheet.event).toBe("carrom.game.adjust");
    expect(sheet.steps.map((s) => s.id)).toEqual(["side", "delta", "reason"]);
    const delta = sheet.steps.find((s) => s.id === "delta");
    expect(delta?.kind).toBe("number");
    if (delta?.kind === "number") {
      expect(delta.min).toBe(1);
      expect(delta.max).toBe(25);
      expect(delta.initial).toBe(1);
    }
  });

  it("deduct: delta bounded -cfg.gameTo..-1 — the mirror image, never zero-reachable", () => {
    const sheet = buildSheets(view({ cfg: DEFAULT_CFG }))["adjustDeduct"]!;
    const delta = sheet.steps.find((s) => s.id === "delta");
    expect(delta?.kind).toBe("number");
    if (delta?.kind === "number") {
      expect(delta.min).toBe(-25);
      expect(delta.max).toBe(-1);
      expect(delta.initial).toBe(-1);
    }
  });

  it("the bound follows cfg.gameTo — club-29 widens it to 29", () => {
    const sheet = buildSheets(view({ cfg: CLUB29_CFG }))["adjustCredit"]!;
    const delta = sheet.steps.find((s) => s.id === "delta");
    if (delta?.kind === "number") expect(delta.max).toBe(29);
  });

  it("buildPayload resolves the chosen side and passes delta/reason through", () => {
    const sheet = buildSheets(view())["adjustCredit"]!;
    expect(sheet.buildPayload({ side: "home", delta: "5", reason: "foul" })).toEqual({
      entrantId: "H",
      delta: 5,
      reason: "foul",
    });
  });

  it("ADJUST_REASONS is the engine's own padSpec field values, not hand-copied", () => {
    const spec = realPadSpec(DEFAULT_CFG);
    const actions = spec.panels.flatMap((panel) => panel.actions).filter((a) => a.type === "carrom.game.adjust");
    for (const action of actions) {
      const reasonField = action.fields.find((f) => f.path === "reason") as { values?: readonly string[] } | undefined;
      expect([...ADJUST_REASONS]).toEqual([...(reasonField?.values ?? [])]);
    }
    expect(actions.length).toBeGreaterThan(0);
  });
});

describe("the engine surface this skin restates", () => {
  it("EVENT_BAND is the module's own fidelity map, not a second scale", () => {
    expect(EVENT_BAND).toEqual(realPadSpec(DEFAULT_CFG).fidelity);
    expect(EVENT_BAND).toEqual(realPadSpec(CLUB29_CFG).fidelity);
  });
});

// ---------------------------------------------------------------------------
// The seam, folded: every payload this pad can produce folds through the
// REAL engine, both cfgs — a fixture on both ends proves the fixture.
// ---------------------------------------------------------------------------

describe("every payload this pad can produce folds through the real engine", () => {
  function foldOne(cfg: typeof DEFAULT_CFG, events: EventEnvelope[], type: string, payload: unknown): unknown {
    return foldClient(carrom, cfg, SOLO, [...events, ev(events.length, type, payload)]);
  }

  it("the toss sheet's payload sets firstBreak", () => {
    const sheet = buildSheets(view())["toss"]!;
    const folded = foldOne(DEFAULT_CFG, stream(), "carrom.toss", sheet.buildPayload({ firstBreak: "away" })) as {
      tossTaken?: boolean;
      firstBreak?: string;
    };
    expect(folded.tossTaken).toBe(true);
    expect(folded.firstBreak).toBe("away");
  });

  it("the board (no queen) sheet banks coins x pointsPerCoin, no queen bonus", () => {
    const base = stream(start());
    const sheet = buildSheets(view({ events: base }))["board"]!;
    const folded = foldOne(DEFAULT_CFG, base, "carrom.board.summary", sheet.buildPayload({ winner: "home", coins: "4" })) as {
      games: { score: { home: number; away: number } }[];
    };
    expect(folded.games[0]?.score).toEqual({ home: 4, away: 0 });
  });

  it("the board (queen covered) sheet, SAME side, banks coins + the queen bonus", () => {
    const base = stream(start());
    const sheet = buildSheets(view({ events: base }))["boardQueen"]!;
    const payload = sheet.buildPayload({ winner: "home", queenTo: "home", coins: "3" });
    const folded = foldOne(DEFAULT_CFG, base, "carrom.board.summary", payload) as {
      games: { score: { home: number; away: number }; boards: { queenScored: boolean }[] }[];
    };
    // 3 coins + 3 queenPoints (default) = 6, and the fold's own record agrees
    // the queen was actually credited.
    expect(folded.games[0]?.score).toEqual({ home: 6, away: 0 });
    expect(folded.games[0]?.boards[0]?.queenScored).toBe(true);
  });

  it("the board (queen covered) sheet, OPPOSITE sides for winner and queenTo, credits NO queen bonus", () => {
    const base = stream(start());
    const sheet = buildSheets(view({ events: base }))["boardQueen"]!;
    const payload = sheet.buildPayload({ winner: "home", queenTo: "away", coins: "3" });
    const folded = foldOne(DEFAULT_CFG, base, "carrom.board.summary", payload) as {
      games: { score: { home: number; away: number }; boards: { queenScored: boolean }[] }[];
    };
    expect(folded.games[0]?.score).toEqual({ home: 3, away: 0 });
    expect(folded.games[0]?.boards[0]?.queenScored).toBe(false);
  });

  it("the adjustment credit sheet's payload, default (unedited) delta", () => {
    const base = stream(start());
    const sheet = buildSheets(view({ events: base }))["adjustCredit"]!;
    const payload = sheet.buildPayload({ side: "home", delta: "1", reason: "foul" });
    const folded = foldOne(DEFAULT_CFG, base, "carrom.game.adjust", payload) as {
      games: { score: { home: number; away: number } }[];
    };
    expect(folded.games[0]?.score.home).toBe(1);
  });

  it("the adjustment deduct sheet's payload takes the score down, clamped at zero by the engine, never negative", () => {
    const base = stream(start(), board({ winner: "H", opponentCoinsLeft: 4 }));
    const sheet = buildSheets(view({ events: base }))["adjustDeduct"]!;
    const payload = sheet.buildPayload({ side: "home", delta: "-2", reason: "due_coins" });
    const folded = foldOne(DEFAULT_CFG, base, "carrom.game.adjust", payload) as {
      games: { score: { home: number; away: number } }[];
    };
    expect(folded.games[0]?.score.home).toBe(2);
  });

  it("a dock-enriched board payload (breaker + queenBy) still folds clean", () => {
    const base = stream(start());
    const sheet = buildSheets(view({ events: base }))["boardQueen"]!;
    let payload = sheet.buildPayload({ winner: "home", queenTo: "home", coins: "2" });
    const v = view({ events: [...base, ev(base.length, "carrom.board.summary", payload)] });
    const breakerDock = buildDock("carrom.board.summary", v, t, payload)!;
    const breakerChip = breakerDock.chips.find((c) => c.labelText === "Meena")!;
    payload = breakerChip.mutate(payload);
    const queenDock = buildDock("carrom.board.summary", v, t, payload)!;
    const queenChip = queenDock.chips[0]!;
    payload = queenChip.mutate(payload);
    expect(() => foldOne(DEFAULT_CFG, base, "carrom.board.summary", payload)).not.toThrow();
    expect(payload).toMatchObject({ breaker: expect.any(String), queenBy: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// dock() — required fields on the sheet, optional attribution in the dock.
// ---------------------------------------------------------------------------

describe("buildDock — carrom.toss", () => {
  it("is always null — the toss schema has no optional field at all", () => {
    expect(buildDock("carrom.toss", view(), t, { firstBreak: "H" })).toBeNull();
  });
});

describe("buildDock — carrom.board.summary", () => {
  /** A view whose LAST recorded board is exactly the one `payload` describes
   *  — the real shape `dock()` sees in production (rendered AFTER the
   *  optimistic fold has already applied the tapped event). */
  function afterBoard(payload: Record<string, unknown>): PadHostView {
    const events = stream(start(), ["carrom.board.summary", payload]);
    return view({ events });
  }

  it("withheld below band 1 — carrom's own fidelity map has no tier above 1", () => {
    const v = afterBoard({ winner: "H", opponentCoinsLeft: 4 });
    expect(buildDock("carrom.board.summary", { ...v, band: 0 }, t, { winner: "H", opponentCoinsLeft: 4 })).toBeNull();
  });

  it("asks WHO BROKE first, scoped to the breaking side's own roster", () => {
    const v = afterBoard({ winner: "H", opponentCoinsLeft: 4 });
    const dock = buildDock("carrom.board.summary", v, t, { winner: "H", opponentCoinsLeft: 4 })!;
    expect(dock).not.toBeNull();
    expect(dock.title).toBe("pad.carrom.dock.breaker.title");
    // firstBreak defaults to "home" (init()) — game 1, board 1 breaks home.
    expect(dock.chips.map((c) => c.labelText)).toEqual(["Meena"]);
  });

  it("moves to QUEEN COVERED BY once breaker is answered — the queen-covered path only", () => {
    const v = afterBoard({ winner: "H", queenTo: "A", opponentCoinsLeft: 3 });
    const dock = buildDock("carrom.board.summary", v, t, {
      winner: "H",
      queenTo: "A",
      opponentCoinsLeft: 3,
      breaker: "H1",
    })!;
    expect(dock.title).toBe("pad.carrom.dock.queenBy.title");
    // queenTo is AWAY, so the picker is scoped to away's own roster.
    expect(dock.chips.map((c) => c.labelText)).toEqual(["Ravi"]);
  });

  it("never asks queenBy on the no-queen path — queenTo is null, not a side", () => {
    const v = afterBoard({ winner: "H", opponentCoinsLeft: 4 });
    const dock = buildDock("carrom.board.summary", v, t, { winner: "H", opponentCoinsLeft: 4, breaker: "H1" });
    expect(dock).toBeNull();
  });

  it("returns null once both breaker and queenBy are answered — nothing left to enrich", () => {
    const v = afterBoard({ winner: "H", queenTo: "H", opponentCoinsLeft: 3 });
    const dock = buildDock("carrom.board.summary", v, t, {
      winner: "H",
      queenTo: "H",
      opponentCoinsLeft: 3,
      breaker: "H1",
      queenBy: "H1",
    });
    expect(dock).toBeNull();
  });

  it("a chip's mutate sets ONLY its own field, the rest of the held payload untouched", () => {
    const v = afterBoard({ winner: "H", opponentCoinsLeft: 4 });
    const dock = buildDock("carrom.board.summary", v, t, { winner: "H", opponentCoinsLeft: 4 })!;
    const chip = dock.chips.find((c) => c.labelText === "Meena")!;
    expect(chip.mutate({ winner: "H", opponentCoinsLeft: 4 })).toEqual({
      winner: "H",
      opponentCoinsLeft: 4,
      breaker: "H1",
    });
  });
});

describe("buildDock — carrom.game.adjust", () => {
  it("withheld below band 1", () => {
    const v = view({ events: stream(start()) });
    expect(buildDock("carrom.game.adjust", { ...v, band: 0 }, t, { entrantId: "H", delta: 5, reason: "foul" })).toBeNull();
  });

  it("pools BOTH squads — the offender is routinely the OPPONENT of the side whose score moved", () => {
    const v = view({ events: stream(start()) });
    const dock: DockSpec = buildDock("carrom.game.adjust", v, t, { entrantId: "H", delta: 5, reason: "foul" })!;
    expect(dock.title).toBe("pad.carrom.dock.adjust.title");
    expect(dock.chips.map((c) => c.labelText)).toEqual(["Meena", "Ravi"]);
  });

  it("returns null once person is already answered", () => {
    const v = view({ events: stream(start()) });
    const dock = buildDock("carrom.game.adjust", v, t, { entrantId: "H", delta: 5, reason: "foul", person: "A1" });
    expect(dock).toBeNull();
  });

  it("a chip's mutate sets person only", () => {
    const v = view({ events: stream(start()) });
    const dock = buildDock("carrom.game.adjust", v, t, { entrantId: "H", delta: 5, reason: "foul" })!;
    const chip = dock.chips.find((c) => c.labelText === "Ravi")!;
    expect(chip.mutate({ entrantId: "H", delta: 5, reason: "foul" })).toEqual({
      entrantId: "H",
      delta: 5,
      reason: "foul",
      person: "A1",
    });
  });
});

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half
// ---------------------------------------------------------------------------

describe("carromDetail", () => {
  const v = view();

  it("the toss row names the side that breaks first", () => {
    expect(carromDetail({ t, eventType: "carrom.toss", payload: { firstBreak: "H" }, state: v.state, personNames: NAMES })).toBe(
      "scorepad.attribution.home",
    );
  });

  it("a board row states winner, coins, queen and breaker, in that order", () => {
    const detail = carromDetail({
      t,
      eventType: "carrom.board.summary",
      payload: { winner: "H", opponentCoinsLeft: 4, queenTo: "H", breaker: "H1" },
      state: v.state,
      personNames: NAMES,
    });
    expect(detail).toBe(
      'scorepad.attribution.home · pad.carrom.ribbon.board.coins.other({"points":4}) · pad.carrom.ribbon.board.queen({"side":"scorepad.attribution.home"}) · pad.carrom.ribbon.board.breaker({"name":"Meena"})',
    );
  });

  it("a no-queen board row omits the queen fragment entirely", () => {
    const detail = carromDetail({
      t,
      eventType: "carrom.board.summary",
      payload: { winner: "A", opponentCoinsLeft: 1 },
      state: v.state,
      personNames: NAMES,
    });
    expect(detail).toBe('scorepad.attribution.away · pad.carrom.ribbon.board.coins.other({"points":1})');
  });

  it("an adjustment row states side, signed points and reason", () => {
    const detail = carromDetail({
      t,
      eventType: "carrom.game.adjust",
      payload: { entrantId: "H", delta: 5, reason: "foul", person: "A1" },
      state: v.state,
      personNames: NAMES,
    });
    expect(detail).toBe(
      'scorepad.attribution.home · pad.carrom.ribbon.adjust.points.other({"delta":5}) · reason.foul · Ravi',
    );
  });

  it("adds nothing it cannot see, and nothing for an event type it does not know", () => {
    expect(carromDetail({ t, eventType: "carrom.board.summary", payload: {}, state: v.state, personNames: NAMES })).toBeUndefined();
    expect(carromDetail({ t, eventType: "core.start", payload: {}, state: v.state, personNames: NAMES })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The registry, the vocabulary, and the four dictionaries
// ---------------------------------------------------------------------------

describe("registry", () => {
  it("resolves carrom to the v3 lane, and hands back a real, tapModel-T skin", () => {
    const skin = resolvePad("carrom", t);
    expect(skin.key).toBe("carrom");
    expect(skin.tapModel).toBe("T");
    expect(typeof skin.phase).toBe("function");
  });
});

describe("vocabulary and copy", () => {
  it("all three ribbon keys are REGISTERED, not merely translated", () => {
    for (const type of ["carrom.toss", "carrom.board.summary", "carrom.game.adjust"]) {
      expect(PAD_LABEL_KEYS).toContain(ribbonKeyFor(type));
    }
  });

  /** Every key this skin can put on screen, collected from BUILT specs
   *  rather than from a hand list — the same "collect, don't hand-list"
   *  posture generic's/boardgame's own sweeps take. */
  function keysOn(v: PadHostView): Set<string> {
    const seen = new Set<string>();
    const recording: TFn = (key) => {
      seen.add(key);
      return key;
    };
    buildScorebug(v, recording);
    for (const tile of buildTiles(v)) {
      seen.add(tile.label);
      if (tile.sublabel) seen.add(tile.sublabel);
    }
    for (const sheet of Object.values(buildSheets(v))) {
      for (const step of sheet.steps) {
        seen.add(step.title);
        if (step.kind === "choice") for (const o of step.options) seen.add(o.label);
        if (step.kind === "number" && step.hintText) seen.add(step.hintText);
      }
    }
    // The dock's own keys — title and every chip's label — for every branch
    // this skin's dock can reach: board breaker, board queenBy, and adjust
    // person. A sweep that only ever probed one would miss the others' keys
    // entirely.
    for (const [type, payload] of [
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 4 }],
      ["carrom.board.summary", { winner: "H", queenTo: "A", opponentCoinsLeft: 3, breaker: "H1" }],
      ["carrom.game.adjust", { entrantId: "H", delta: 5, reason: "foul" }],
    ] as const) {
      const events = stream(start(), [type, payload]);
      const dv = view({ events });
      const dock = buildDock(type, dv, recording, payload);
      if (dock) {
        seen.add(dock.title);
        for (const chip of dock.chips) seen.add(chip.label);
      }
    }
    // `carromDetail` is not called with `v` as its context — `named()`
    // short-circuits to the resolved NAME (never a key) whenever
    // `personNames` already knows the id, so these payloads deliberately
    // name people `recording`'s own dictionary does not know, forcing every
    // `t()`/`vocabText()`/`ctx.plural` fallback call inside `carromDetail` to
    // actually fire and be captured.
    for (const [type, payload] of [
      ["carrom.toss", { firstBreak: "H" }],
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 4, queenTo: "H", breaker: "H1" }],
      ["carrom.game.adjust", { entrantId: "H", delta: -3, reason: "due_coins", person: "A1" }],
    ] as const) {
      carromDetail({ t: recording, eventType: type, payload, state: v.state, personNames: NAMES });
    }
    for (const type of ["carrom.toss", "carrom.board.summary", "carrom.game.adjust"]) seen.add(ribbonKeyFor(type));
    return seen;
  }

  it("every key it can render exists in the English dictionary", () => {
    const all = new Set<string>();
    for (const cfg of [DEFAULT_CFG, CLUB29_CFG]) {
      for (const band of [0, 1, 3] as FidelityBand[]) {
        for (const lineups of [SOLO, EMPTY]) {
          for (const events of [stream(), stream(start()), stream(start(), board({ winner: "H", opponentCoinsLeft: 4 }))]) {
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
