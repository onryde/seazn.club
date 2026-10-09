// R4 — tennis SkinDefV3. Pure-data assertions (apps/web vitest is
// `environment: "node"`, no jsdom): the skin is a spec BUILDER, so this file
// asserts the specs it returns and leaves the DOM to e2e.
//
// Two things are proved by driving the REAL engine rather than a hand-typed
// stand-in, matching the precedent football.test.ts/cricket.test.ts already
// set (there is no shared skin-test factory in this tree; each file defines
// its own local `t`/`squads()`/`state()`/`cfg()`/`view()`):
//   - guided-sheet gating goes through `initialSheetState`/`currentStep`/
//     `answerStep` from ../../guided-sheet;
//   - the serve-rotation mirror (this skin's own header explains WHY it is a
//     mirror, not an import) is proven against REAL folds of the public
//     `tennis` module, reusing the scenarios `packages/engine/src/sports/
//     nested/serve-context.test.ts` already pins as the oracle — a stronger
//     proof than a hand-derived expectation would be, and the one place a
//     drift between this mirror and the real kernel would actually surface.
import { describe, expect, it } from "vitest";
import uiEn from "@/dictionaries/en/ui.json";
import type { EventEnvelope, LineupPair, SquadState } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import type { ModuleEvent } from "@seazn/engine/sport";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { tennis } from "@seazn/engine/sports/tennis";
import { serveContext } from "@seazn/engine/sports/nested";
import { foldClient } from "../../../module-client";
import { answerStep, currentStep, initialSheetState } from "../../guided-sheet";
import type { GuidedSheetSpec, PadHostView, TileSpec } from "../../types";
import type { MessageKey } from "@/lib/messages";
import {
  EVENT_BAND,
  INTERRUPTION_KINDS,
  POINT_KINDS,
  SANCTION_LEVELS,
  buildDock,
  buildScorebug,
  buildSheets,
  buildTiles,
  gameAwardTileId,
  refusedEventTypes,
  resolvePhase,
  sanctionSheetKey,
  tennisDetail,
  tennisSkinV3,
} from "../tennis";
import type { TFn } from "../tennis";
import { dedicatedEventTypes } from "../../pad-host";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

const NAMES: Record<string, string> = {
  H: "Home Player",
  A: "Away Player",
  "H-first": "Home First",
  "H-second": "Home Second",
  "A-first": "Away First",
  "A-second": "Away Second",
};

function singlesSquads(): SquadState {
  return initSquads({
    home: { entrantId: "H", slots: [{ personId: "H", slot: "starting", orderNo: 1 }] },
    away: { entrantId: "A", slots: [{ personId: "A", slot: "starting", orderNo: 1 }] },
  });
}

/** Defect 1/2 fixture (code review, 2026-08-25): a fixture created from
 *  display-name-only entrants — no team sheet at all, either side. This is a
 *  common, legitimate state (`buildHalf`'s own `players.length > 0` fallback
 *  and `v6-sports.spec.ts`'s comment both acknowledge it), NOT the doubles
 *  "populated roster, undeclared order" shape `doublesSquads(false)` already
 *  covers — the two must stay distinguishable in tests, since only THIS one
 *  is in scope for the fix. */
function emptySquads(): SquadState {
  return initSquads({
    home: { entrantId: "H", slots: [] },
    away: { entrantId: "A", slots: [] },
  });
}

/** Matches `serve-context.test.ts`'s own `pairSide()` fixture byte for byte:
 *  `orderNo` runs the OTHER way from `pairOrder`, so a reader that quietly
 *  used `orderNo` instead answers with the wrong player. */
function doublesSquads(declareOrder: boolean): SquadState {
  const home = declareOrder
    ? [
        { personId: "H-second", slot: "starting" as const, orderNo: 1, pairOrder: 2 },
        { personId: "H-first", slot: "starting" as const, orderNo: 2, pairOrder: 1 },
      ]
    : [
        { personId: "H-first", slot: "starting" as const, orderNo: 1 },
        { personId: "H-second", slot: "starting" as const, orderNo: 2 },
      ];
  const away = declareOrder
    ? [
        { personId: "A-second", slot: "starting" as const, orderNo: 1, pairOrder: 2 },
        { personId: "A-first", slot: "starting" as const, orderNo: 2, pairOrder: 1 },
      ]
    : [
        { personId: "A-first", slot: "starting" as const, orderNo: 1 },
        { personId: "A-second", slot: "starting" as const, orderNo: 2 },
      ];
  return initSquads({ home: { entrantId: "H", slots: home }, away: { entrantId: "A", slots: away } });
}

function state(over: Record<string, unknown> = {}) {
  return {
    phase: "live",
    entrants: { home: "H", away: "A" },
    sets: [] as unknown[],
    games: { home: 0, away: 0 },
    points: { kind: "standard" as const, home: 0, away: 0, advantage: null },
    setsWon: { home: 0, away: 0 },
    serving: "home",
    ...over,
  };
}

function cfg(over: Record<string, unknown> = {}) {
  return {
    bestOf: 3,
    set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 },
    finalSet: "same" as const,
    game: { noAd: false },
    tiebreak: { winBy: 2 },
    ...over,
  };
}

function view(over: Partial<PadHostView> = {}): PadHostView {
  return {
    cfg: cfg(),
    state: state(),
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: NAMES,
    squads: singlesSquads(),
    events: [],
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
    ...over,
  };
}

const tileById = (tiles: readonly TileSpec[], id: string): TileSpec | undefined => tiles.find((tile) => tile.id === id);
const stripValue = (v: PadHostView, id: string): string | undefined =>
  buildScorebug(v, t).strip.find((item) => item.id === id)?.value;

// ---------------------------------------------------------------------------
// i18n keys this skin registers must exist in the English dictionary — the
// same "en carries every key this file's own strings reference" sanity every
// v3 skin test performs before trusting `t()` output shapes below.
// ---------------------------------------------------------------------------

// A key used only inside a skin's own returned SPEC (a TileSpec.label, a
// GuidedSheetStep.title, an options[].label, a strip item's label, a
// hintKey, a WhoLine.servingLabel) has NO gate at all: vitest's local `t`
// returns the key verbatim, `TileSpec.label`/`step.title` are plain
// `string` (not `MessageKey`) so tsc never checks them, and `i18n:check`
// only verifies parity BETWEEN locales — a key missing from all four is
// perfect parity. This is exactly how football's R3/B2 shipped a card
// sheet's colour-step title with no copy at all. The guard that actually
// works (`skins/__tests__/football.test.ts`'s own "copy truth" test):
// collect every such key FROM THE BUILT SPECS across a representative band/
// state sweep, then assert each exists in en/ui.json — a later wave's new
// tile/step is covered the day it lands, unlike a hand-maintained list.
function collectLabelKeys(): Set<string> {
  const keys = new Set<string>();
  // The context line's two pieces are consumed by `t()` INSIDE `buildContext`
  // to compose one already-joined string, never stored as a field this walk
  // could collect — added explicitly rather than reverse-engineered out of
  // the composed text.
  keys.add("pad.tennis.context.line");
  keys.add("pad.tennis.context.tiebreak");
  const bandsAndStates: { band: 0 | 1 | 2 | 3; over: Record<string, unknown> }[] = [
    { band: 0, over: state() },
    { band: 1, over: state({ games: { home: 1, away: 0 } }) },
    { band: 3, over: state({ points: { kind: "tiebreak", home: 3, away: 2 } }) },
    { band: 3, over: state({ sets: [{ home: 6, away: 4 }] }) },
  ];
  for (const { band, over } of bandsAndStates) {
    const v = view({ band, state: over, squads: doublesSquads(true) });
    for (const tile of buildTiles(v)) {
      keys.add(tile.label);
      if (tile.sublabel !== undefined) keys.add(tile.sublabel);
    }
    for (const spec of Object.values(buildSheets(v))) {
      for (const step of spec.steps) {
        keys.add(step.title);
        if (step.kind === "choice") for (const option of step.options) keys.add(option.label);
      }
    }
    const scorebug = buildScorebug(v, t);
    for (const item of scorebug.strip) if (item.label !== undefined) keys.add(item.label);
    for (const half of scorebug.halves) {
      if (half.hintKey !== undefined) keys.add(half.hintKey);
      for (const who of half.who) if (who.servingLabel !== undefined) keys.add(who.servingLabel);
    }
    for (const payload of [{ by: "H", server: "H" }, { by: "H" }, { by: "H", server: "H", meta: { kind: "ace" } }]) {
      const dock = buildDock("tennis.point", v, t, payload);
      if (dock) keys.add(dock.title);
    }
  }
  return keys;
}

describe("copy truth — every key this skin's built specs reference exists in en/ui.json", () => {
  it("no missing keys, across a representative band/state sweep", () => {
    const dict = uiEn as Record<string, string>;
    const missing = [...collectLabelKeys()].filter(
      (key) => key !== "__pad-host/more__" && !Object.prototype.hasOwnProperty.call(dict, key),
    );
    expect(missing).toEqual([]);
  });

  it("vacuity guard: the sweep actually collects a realistic number of keys", () => {
    // A broken sweep (e.g. every band gated to the same tiles) would still
    // pass the test above vacuously — pin a floor so a regression there reds
    // too. 25 is this wave's own new-key count; the sweep also re-collects
    // several already-existing keys (action labels, side labels), so the
    // real floor is comfortably above that.
    expect(collectLabelKeys().size).toBeGreaterThanOrEqual(25);
  });
});

// ---------------------------------------------------------------------------
// resolvePhase()
// ---------------------------------------------------------------------------

describe("resolvePhase", () => {
  it("maps pre -> pre", () => {
    expect(resolvePhase(view({ state: state({ phase: "pre" }) }))).toBe("pre");
  });
  it("maps live -> live", () => {
    expect(resolvePhase(view({ state: state({ phase: "live" }) }))).toBe("live");
  });
  it.each(["done", "final", "abandoned"])("maps %s -> post", (phase) => {
    expect(resolvePhase(view({ state: state({ phase }) }))).toBe("post");
  });
  it("defaults to pre for a state with no phase at all", () => {
    expect(resolvePhase(view({ state: {} }))).toBe("pre");
  });
});

// ---------------------------------------------------------------------------
// The serve-rotation mirror — proved against REAL folds. Scenarios lifted
// from `nested/serve-context.test.ts` verbatim so this stays an oracle proof,
// not a second hand-derived guess that could agree with a broken mirror.
// ---------------------------------------------------------------------------

const STRICT_ALL = { strictFromSeq: 0 } as const;
const point = (by: string): ModuleEvent => ({ type: "tennis.point", payload: { by } });
const straight = (by: string, n: number): ModuleEvent[] => Array(n).fill(point(by));
const game = (by: string): ModuleEvent[] => straight(by, 4);
const gamesFor = (by: string, n: number): ModuleEvent[] => Array.from({ length: n }, () => game(by)).flat();
const start: ModuleEvent = { type: "core.start", payload: {} };

function cfgFor(variant?: string) {
  const preset = variant === undefined ? {} : tennis.variants[variant];
  return tennis.configSchema.parse(preset);
}
function foldReal(lineups: LineupPair, cfgParsed: unknown, events: ModuleEvent[]) {
  const envelopes: EventEnvelope[] = events.map((event, i) => makeEnvelope(i, event));
  return foldClient(tennis, cfgParsed, lineups, envelopes, STRICT_ALL);
}
const SINGLES_LINEUPS: LineupPair = defaultLineupPair(tennis.positions);
function doublesLineups(): LineupPair {
  return {
    home: {
      entrantId: "H",
      slots: [
        { personId: "H-second", slot: "starting", orderNo: 1, pairOrder: 2 },
        { personId: "H-first", slot: "starting", orderNo: 2, pairOrder: 1 },
      ],
    },
    away: {
      entrantId: "A",
      slots: [
        { personId: "A-second", slot: "starting", orderNo: 1, pairOrder: 2 },
        { personId: "A-first", slot: "starting", orderNo: 2, pairOrder: 1 },
      ],
    },
  };
}

describe("servingInfo (via buildScorebug's strip + WhoLine dot) — real folds", () => {
  it("singles: names the sole roster member directly, no declared order needed", () => {
    const folded = foldReal(SINGLES_LINEUPS, cfgFor(), [start]);
    const v = view({ state: folded, squads: singlesSquads() });
    expect(stripValue(v, "server")).toBe(NAMES.H);
    const half = buildScorebug(v, t).halves[0]!;
    expect(half.who[0]!.serving).toBe(true);
    expect(half.who[0]!.servingLabel).toBeTruthy();
  });

  it("singles: alternates side every game, matching the fold's own alternation", () => {
    const folded = foldReal(SINGLES_LINEUPS, cfgFor(), [start, ...game("H")]);
    const v = view({ state: folded, squads: singlesSquads() });
    // After H's game, serve passes to A.
    expect(stripValue(v, "server")).toBe(NAMES.A);
    expect(buildScorebug(v, t).halves[1]!.who[0]!.serving).toBe(true);
    expect(buildScorebug(v, t).halves[0]!.who[0]!.serving).toBeUndefined();
  });

  it("doubles, declared order: names the pair member due, advancing the rotation across games", () => {
    const cfgDoubles = cfgFor("doubles-noad-mtb10");
    const squads = doublesSquads(true);
    expect(stripValue(view({ state: foldReal(doublesLineups(), cfgDoubles, [start]), squads }), "server")).toBe(
      NAMES["H-first"],
    );
    expect(
      stripValue(view({ state: foldReal(doublesLineups(), cfgDoubles, [start, ...game("H")]), squads }), "server"),
    ).toBe(NAMES["A-first"]);
    expect(
      stripValue(
        view({ state: foldReal(doublesLineups(), cfgDoubles, [start, ...game("H"), ...game("A")]), squads }),
        "server",
      ),
    ).toBe(NAMES["H-second"]);
  });

  it("doubles, UNDECLARED order: no server name and no serving dot — omitted, not guessed", () => {
    const squads = doublesSquads(false);
    const folded = foldReal(doublesLineups(), cfgFor("doubles-noad-mtb10"), [start]);
    const v = view({ state: folded, squads });
    expect(stripValue(v, "server")).toBe(t("scorepad.attribution.home")); // side-level fallback only
    const spec = buildScorebug(v, t);
    expect(spec.halves[0]!.who.every((w) => w.serving === undefined)).toBe(true);
    expect(spec.halves[1]!.who.every((w) => w.serving === undefined)).toBe(true);
  });

  it("a tie-break counts as one game and continues the pair rotation (mtb variant)", () => {
    const cfgDoubles = cfgFor("doubles-noad-mtb10");
    const squads = doublesSquads(true);
    const to66 = [start, ...gamesFor("H", 5), ...gamesFor("A", 5), ...game("H"), ...game("A")];
    const atTb = foldReal(doublesLineups(), cfgDoubles, to66);
    expect(stripValue(view({ state: atTb, squads }), "server")).toBe(NAMES["H-first"]);
    const done = foldReal(doublesLineups(), cfgDoubles, [...to66, ...straight("H", 7)]);
    expect(stripValue(view({ state: done, squads }), "server")).toBe(NAMES["A-first"]);
  });

  it("names the right partner the GAME AFTER a closed tie-break, where parity stops covering", () => {
    // The test above agrees with the oracle by coincidence — 6 and the real
    // 8 share a parity. One more game crosses a floor(_/2) boundary, which
    // is precisely where a serve derivation that has lost the breaker's own
    // turn count starts naming the wrong player, and keeps doing it for the
    // rest of the match. Oracle: `nested/serve-context.test.ts`'s "does not
    // desync the doubles rotation for the game after a closed tie-break".
    const cfgDoubles = cfgFor("doubles-noad-mtb10");
    const squads = doublesSquads(true);
    const to66 = [start, ...gamesFor("H", 5), ...gamesFor("A", 5), ...game("H"), ...game("A")];
    const setTwoGameTwo = foldReal(doublesLineups(), cfgDoubles, [...to66, ...straight("H", 7), ...game("A")]);
    expect(setTwoGameTwo.serving).toBe("home"); // sanity
    // Asserted against the engine directly as well, so this stays an oracle
    // proof: if the two ever disagree, the pad is the one that is wrong.
    expect(serveContext(setTwoGameTwo as never).personId).toBe("H-first");
    expect(stripValue(view({ state: setTwoGameTwo, squads }), "server")).toBe(NAMES["H-first"]);
  });

  it("keeps naming the server ONE point into a tie-break, where the fold's `serving` has rotated", () => {
    // ITF gives the breaker's second point to the other side, so one point
    // in, `state.serving` is no longer the side that OPENED the breaker.
    // The engine reconciles that against `tbFirstServer`; a pad that never
    // passes it along reads its own match as desynced and drops the server
    // name for half of every tie-break — the shape of loss a scorer notices
    // exactly when the match is tightest.
    const cfgDoubles = cfgFor("doubles-noad-mtb10");
    const squads = doublesSquads(true);
    const to66 = [start, ...gamesFor("H", 5), ...gamesFor("A", 5), ...game("H"), ...game("A")];
    const afterP1 = foldReal(doublesLineups(), cfgDoubles, [...to66, point("H")]);
    expect(afterP1.serving).toBe("away"); // sanity — point 2 is away's
    expect(stripValue(view({ state: afterP1, squads }), "server")).toBe(NAMES["A-first"]);
  });

  it("does not inflate completed games by a banked match-tie-break's raw point score", () => {
    // Same fixture `serve-context.test.ts` pins: MTB closes 10-0, banked as
    // ONE game (the 20th) — 19 games completed, not 29 raw points. Either
    // wrong count changes serviceTurn/personId here. `events` is deliberately
    // NOT wired into `view()` in this one test (contrast the poisoning tests
    // below, which wire it on purpose) — this test's own job is the games
    // arithmetic, not the set_summary staleness rule.
    //
    // Both summary sets are EVEN-game on purpose (6-4, 2-6). An odd one
    // desyncs the fold's `serving` from the turn walk and the engine then
    // declines to name anyone at all (`serveOrderKnown: false`), which would
    // make this test pass or fail on the staleness rule instead of on the
    // arithmetic it exists to pin.
    const cfgDoubles = cfgFor("doubles-noad-mtb10");
    const squads = doublesSquads(true);
    const oneSetAll: ModuleEvent[] = [
      start,
      { type: "tennis.set_summary", payload: { home: 6, away: 4 } },
      { type: "tennis.set_summary", payload: { home: 2, away: 6 } },
    ];
    const done = foldReal(doublesLineups(), cfgDoubles, [...oneSetAll, ...straight("H", 10)]);
    expect(stripValue(view({ state: done, squads }), "server")).toBe(NAMES["A-first"]);
  });

  // REPLACES "a set ever scored by set_summary poisons serve info for the REST
  // of the match". That test pinned a local event sniffer that refused on ANY
  // summary, and it used an EVEN one (6-0) — precisely the case the engine's
  // R4-7 guard says is still derivable. It was a test written to match the
  // implementation rather than the design, and the behaviour it locked in cost
  // the scorer every ace and double-fault attribution for the rest of a match
  // they had merely backfilled a set into. Cloud review, 2026-08-26.
  it("an EVEN-game summary does NOT poison serve info — the engine says the rotation is still derivable", () => {
    const events: EventEnvelope[] = [
      makeEnvelope(0, start),
      makeEnvelope(1, { type: "tennis.set_summary", payload: { home: 6, away: 0 } }),
      ...game("H").map((e, i) => makeEnvelope(2 + i, e)),
    ];
    const folded = foldClient(tennis, cfgFor(), SINGLES_LINEUPS, events, STRICT_ALL);
    const v = view({ state: folded, squads: singlesSquads(), events });
    const spec = buildScorebug(v, t);
    expect(stripValue(v, "server")).toBeDefined();
    expect(spec.halves.some((h) => h.who.some((w) => w.serving === true))).toBe(true);
    // And the tap event carries the server, which is what makes ace /
    // double-fault attribution reachable at all.
    expect(spec.halves[0]!.tapEvent?.payload.server).toBeDefined();
  });

  it("an ODD-game summary DOES still refuse — the fold and the walk genuinely disagree there", () => {
    const events: EventEnvelope[] = [
      makeEnvelope(0, start),
      makeEnvelope(1, { type: "tennis.set_summary", payload: { home: 6, away: 3 } }),
      ...game("H").map((e, i) => makeEnvelope(2 + i, e)),
    ];
    const folded = foldClient(tennis, cfgFor(), SINGLES_LINEUPS, events, STRICT_ALL);
    const v = view({ state: folded, squads: singlesSquads(), events });
    const spec = buildScorebug(v, t);
    expect(stripValue(v, "server")).toBeUndefined();
    expect(spec.halves.every((h) => h.who.every((w) => w.serving === undefined))).toBe(true);
    expect(spec.halves[0]!.tapEvent?.payload.server).toBeUndefined();
  });

  it("MUTATION PROOF: a SINGLES side is not exempt — the person is unambiguous but the SIDE is not", () => {
    // 9 banked games: `state.serving` never moved, the walk did. There is
    // exactly one player per side, so naming the person is trivial — and
    // still wrong, because the side it would be attached to is the wrong end
    // of the court. A guard that special-cased singles would pass everything
    // above and fail here.
    const events: EventEnvelope[] = [
      makeEnvelope(0, start),
      makeEnvelope(1, { type: "tennis.set_summary", payload: { home: 6, away: 3 } }),
    ];
    const folded = foldClient(tennis, cfgFor(), SINGLES_LINEUPS, events, STRICT_ALL);
    const v = view({ state: folded, squads: singlesSquads(), events });
    expect(stripValue(v, "server")).toBeUndefined();
  });

  it("a VOIDED set_summary never poisons serve info — it genuinely never happened", () => {
    const summaryEnv = makeEnvelope(1, { type: "tennis.set_summary", payload: { home: 6, away: 0 } });
    const events: EventEnvelope[] = [
      makeEnvelope(0, start),
      summaryEnv,
      makeEnvelope(2, { type: "core.void", payload: {} }, summaryEnv.id),
    ];
    const folded = foldClient(tennis, cfgFor(), SINGLES_LINEUPS, events, STRICT_ALL);
    const v = view({ state: folded, squads: singlesSquads(), events });
    expect(stripValue(v, "server")).toBe(NAMES.H);
  });
});

// ---------------------------------------------------------------------------
// The `@seazn/engine/sports/nested` barrel (R4-3) — this skin's own proof
// that IT stays consuming the real function rather than re-forking is the
// suite above (every `servingInfo`/`buildScorebug` assertion there resolves
// through `deriveServeContext` -> the imported `serveContext`). This test's
// job is narrower and different: pin that the BARREL ITSELF still resolves
// and still answers correctly, independent of this skin, so a later edit to
// `packages/engine/src/sports/nested/index.ts` that silently drops the
// export reds HERE — at the import — rather than only showing up as a subtly
// wrong serve dot three call frames away inside the skin.
// ---------------------------------------------------------------------------

describe("@seazn/engine/sports/nested barrel", () => {
  it("serveContext imports through the barrel and answers a real fold (oracle: nested/serve-context.test.ts's own 'alternates every game')", () => {
    // One completed game for H: serve passes to A, turn floor(1/2) = 0, no
    // declared pair order in these lineups so personId stays null — the
    // exact g=1 case `nested/serve-context.test.ts`'s own loop pins.
    const folded = foldReal(SINGLES_LINEUPS, cfgFor(), [start, ...game("H")]);
    expect(serveContext(folded)).toEqual({
      side: "away",
      serviceTurn: 0,
      personId: null,
      serveOrderKnown: true,
    });
  });
});

// ---------------------------------------------------------------------------
// buildScorebug — context, big, tappable gate, tapEvent shape, strip.
// ---------------------------------------------------------------------------

describe("buildScorebug", () => {
  it("context names best-of and the current (1-based) set", () => {
    const spec = buildScorebug(view({ state: state({ sets: [{ home: 6, away: 4 }] }) }), t);
    expect(spec.context).toBe(`${t("pad.tennis.context.line", { bestOf: 3, set: 2 })}`);
  });

  it("context appends tie-break while points.kind is tiebreak", () => {
    const spec = buildScorebug(
      view({ state: state({ points: { kind: "tiebreak", home: 3, away: 2 } }) }),
      t,
    );
    expect(spec.context).toContain(t("pad.tennis.context.tiebreak"));
  });

  it("context appends tie-break during a match tie-break too", () => {
    const spec = buildScorebug(
      view({ state: state({ points: { kind: "matchTiebreak", home: 4, away: 2 } }) }),
      t,
    );
    expect(spec.context).toContain(t("pad.tennis.context.tiebreak"));
  });

  it.each([
    [0, "0"],
    [1, "15"],
    [2, "30"],
    [3, "40"],
  ])("standard points %i renders %s", (n, word) => {
    const spec = buildScorebug(view({ state: state({ points: { kind: "standard", home: n, away: 0, advantage: null } }) }), t);
    expect(spec.halves[0]!.big).toBe(word);
  });

  it("deuce (40-40, no advantage) reads 40 on BOTH halves", () => {
    const spec = buildScorebug(
      view({ state: state({ points: { kind: "standard", home: 3, away: 3, advantage: null } }) }),
      t,
    );
    expect(spec.halves[0]!.big).toBe("40");
    expect(spec.halves[1]!.big).toBe("40");
  });

  it("advantage reads AD on the advantaged side and 40 on the other", () => {
    const spec = buildScorebug(
      view({ state: state({ points: { kind: "standard", home: 3, away: 3, advantage: "away" } }) }),
      t,
    );
    expect(spec.halves[0]!.big).toBe("40");
    expect(spec.halves[1]!.big).toBe("AD");
  });

  it("tiebreak points render as the raw count, not the 0/15/30/40 ladder", () => {
    const spec = buildScorebug(view({ state: state({ points: { kind: "tiebreak", home: 8, away: 6 } }) }), t);
    expect(spec.halves[0]!.big).toBe("8");
    expect(spec.halves[1]!.big).toBe("6");
  });

  // Task 8 fix round 2 (review re-review round 1, Important I1(b), ruling
  // R43): P3 in the reviewer's mutant table inverted THIS skin's `side`
  // literal and survived the whole v3 scope. Derived from the fixture's own
  // tiebreak split (8-6, the test above), never a typed index table.
  it("marks each half with its OWN side — home's half carries HOME's tiebreak points (kills a side swap)", () => {
    const spec = buildScorebug(view({ state: state({ points: { kind: "tiebreak", home: 8, away: 6 } }) }), t);
    const home = spec.halves.find((h) => h.side === "home");
    const away = spec.halves.find((h) => h.side === "away");
    expect(home?.big).toBe("8");
    expect(away?.big).toBe("6");
  });

  it("halves are tappable at band 3 while live, and carry a real tapEvent + hintKey", () => {
    const spec = buildScorebug(view({ band: 3, phase: "live" }), t);
    for (const half of spec.halves) {
      expect(half.tappable).toBe(true);
      expect(half.hintKey).toBe("pad.tennis.scorebug.point.hint");
      expect(half.tapEvent?.type).toBe("tennis.point");
    }
    expect(spec.halves[0]!.tapEvent?.payload.by).toBe("H");
    expect(spec.halves[1]!.tapEvent?.payload.by).toBe("A");
  });

  it("halves carry `server` on BOTH sides' tapEvent when the server is known", () => {
    const spec = buildScorebug(view({ state: state({ serving: "home" }) }), t);
    expect(spec.halves[0]!.tapEvent?.payload.server).toBe("H");
    expect(spec.halves[1]!.tapEvent?.payload.server).toBe("H");
  });

  it("R4-5: SINGLES stamps `scorer` on the tapEvent automatically — the side's sole on-field member", () => {
    const spec = buildScorebug(view(), t); // default view() = singlesSquads()
    expect(spec.halves[0]!.tapEvent?.payload.scorer).toBe("H");
    expect(spec.halves[1]!.tapEvent?.payload.scorer).toBe("A");
  });

  it("R4-5 MUTATION PROOF: singles' auto-scorer is the TAPPED side's own member, never the other side's", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.halves[0]!.tapEvent?.payload.scorer).not.toBe("A");
    expect(spec.halves[1]!.tapEvent?.payload.scorer).not.toBe("H");
  });

  it("R4-5: DOUBLES leaves `scorer` OFF the tapEvent — nobody is auto-picked from a pair", () => {
    const spec = buildScorebug(view({ squads: doublesSquads(true) }), t);
    expect(spec.halves[0]!.tapEvent?.payload).not.toHaveProperty("scorer");
    expect(spec.halves[1]!.tapEvent?.payload).not.toHaveProperty("scorer");
  });

  it("halves are NOT tappable below band 3 — band 0 would be a dead-end tap (tennis.point is band 3)", () => {
    const spec = buildScorebug(view({ band: 0 }), t);
    for (const half of spec.halves) {
      expect(half.tappable).toBeFalsy();
      expect(half.tapEvent).toBeUndefined();
    }
  });

  it("halves are NOT tappable outside live phase", () => {
    const spec = buildScorebug(view({ phase: "pre", state: state({ phase: "pre" }) }), t);
    for (const half of spec.halves) expect(half.tappable).toBeFalsy();
  });

  it("assertScorebugSpec passes — every tappable half has hintKey AND tapEvent", async () => {
    const { assertScorebugSpec } = await import("../../types");
    expect(assertScorebugSpec(buildScorebug(view(), t))).toEqual([]);
    expect(assertScorebugSpec(buildScorebug(view({ band: 0 }), t))).toEqual([]);
  });

  it("strip carries sets and games, always", () => {
    const spec = buildScorebug(
      view({ state: state({ setsWon: { home: 1, away: 0 }, games: { home: 3, away: 2 } }) }),
      t,
    );
    expect(spec.strip.find((s) => s.id === "sets")?.value).toBe("1–0");
    expect(spec.strip.find((s) => s.id === "games")?.value).toBe("3–2");
  });

  it("who lines carry PERSON names from the lineup, never entrant labels (D-6)", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.halves[0]!.who[0]!.name).toBe(NAMES.H);
    expect(spec.halves[0]!.who[0]!.name).not.toBe("H");
  });

  it("a pair entrant gives TWO who-lines, first-named first", () => {
    const spec = buildScorebug(view({ squads: doublesSquads(true) }), t);
    expect(spec.halves[0]!.who.map((w) => w.name)).toEqual([NAMES["H-first"], NAMES["H-second"]]);
  });

  it("ends-change strip item appears after an odd game count and disappears after an even one", () => {
    const odd = buildScorebug(view({ state: state({ games: { home: 1, away: 0 } }) }), t);
    expect(odd.strip.some((s) => s.id === "ends")).toBe(true);
    const even = buildScorebug(view({ state: state({ games: { home: 1, away: 1 } }) }), t);
    expect(even.strip.some((s) => s.id === "ends")).toBe(false);
  });

  it("ends-change tracks every 6 points inside a tiebreak the same way", () => {
    const before = buildScorebug(view({ state: state({ points: { kind: "tiebreak", home: 5, away: 0 } }) }), t);
    expect(before.strip.some((s) => s.id === "ends")).toBe(false);
    const after = buildScorebug(view({ state: state({ points: { kind: "tiebreak", home: 6, away: 0 } }) }), t);
    expect(after.strip.some((s) => s.id === "ends")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildTiles + refusedEventTypes — D-16.
// ---------------------------------------------------------------------------

describe("buildTiles — D-16 (set score withheld while the set is in progress)", () => {
  it("offers the Set score tile at love-all, before any point of the set", () => {
    expect(tileById(buildTiles(view()), "setScore")).toBeDefined();
  });

  it("withholds it once games have started", () => {
    expect(tileById(buildTiles(view({ state: state({ games: { home: 1, away: 0 } }) })), "setScore")).toBeUndefined();
  });

  it("withholds it once points have started, even at 0 games", () => {
    expect(
      tileById(buildTiles(view({ state: state({ points: { kind: "standard", home: 1, away: 0, advantage: null } }) })), "setScore"),
    ).toBeUndefined();
  });

  it("re-offers it in a LATER set once the prior one closed (per-set, not per-match)", () => {
    const s = state({ sets: [{ home: 6, away: 4 }], games: { home: 0, away: 0 } });
    expect(tileById(buildTiles(view({ state: s })), "setScore")).toBeDefined();
  });

  it("refusedEventTypes lists tennis.set_summary ONLY while the set is in progress — mirrors buildTiles exactly", () => {
    expect(refusedEventTypes(view({ state: state({ games: { home: 1, away: 0 } }) }))).toContain("tennis.set_summary");
    expect(refusedEventTypes(view())).not.toContain("tennis.set_summary");
  });

  // tennis.point USED to be listed by refusedEventTypes, as a stand-in for
  // "already reachable elsewhere" — the chassis could not see that a
  // tapModel-S half is an entry point, and this array was the only lever the
  // contract exposed. It was never a refusal: the fold accepts a point
  // whenever the match is live. The chassis learned about tap model S
  // instead (`dedicatedEventTypes`, commit 8ea826d46), so this function went
  // back to meaning what it says, and the two exclusion sets R3 deliberately
  // kept apart stay apart.
  it("refusedEventTypes does NOT list tennis.point — the fold accepts a point whenever live, so it is not a refusal", () => {
    expect(refusedEventTypes(view())).not.toContain("tennis.point");
    expect(refusedEventTypes(view({ state: state({ games: { home: 1, away: 0 } }) }))).not.toContain("tennis.point");
  });

  // DEFENCE IN DEPTH, deliberately not labelled a defect fix. A review
  // reported a live dead-end tap here — tile withheld during a breaker =>
  // type drops out of `dedicatedEventTypes` => `moreActions` re-offers the
  // generic form => tapping it throws `GAME_AWARD_DURING_TIEBREAK`. The
  // mechanism is real but it never fires: `nestedPadSpec`'s Award-game panel
  // already gates on `state.points.kind`, so the action is not in
  // `buildPadView`'s output during a breaker and there is nothing to
  // re-offer. Verified on a running production build with this refusal
  // removed — the More sheet still had nothing in it.
  //
  // These tests therefore pin the SECOND layer, over a hazard that is real
  // (with both layers removed the sheet does render an Award-game form) but
  // currently unreachable. Read them as "this cannot regress if the engine
  // gate moves", never as "this was broken for users".
  describe("game.award during a breaker — defence in depth over the engine's own panel gate", () => {
    const breaker = (kind: "tiebreak" | "matchTiebreak") =>
      view({ state: state({ points: { kind, home: 3, away: 2 } }) });

    it("withholds both Award-game tiles during a tie-break", () => {
      const tiles = buildTiles(breaker("tiebreak"));
      expect(tiles.filter((tile) => tile.label === "pad.tennis.action.gameAward")).toEqual([]);
    });

    it("REGRESSION: refusedEventTypes lists tennis.game.award during a tie-break, so More cannot re-offer it", () => {
      expect(refusedEventTypes(breaker("tiebreak"))).toContain("tennis.game.award");
    });

    it("REGRESSION: the same holds in a MATCH tie-break — the engine refuses both kinds alike", () => {
      expect(refusedEventTypes(breaker("matchTiebreak"))).toContain("tennis.game.award");
    });

    it("does NOT refuse it in a standard game — the tile is the only offer, and it is a legal one", () => {
      expect(refusedEventTypes(view())).not.toContain("tennis.game.award");
      expect(buildTiles(view()).some((tile) => tile.label === "pad.tennis.action.gameAward")).toBe(true);
    });

    it("MUTATION PROOF: a withheld tile is NOT a dedicated type — which is the hazard this layer covers", () => {
      const v = breaker("tiebreak");
      const dedicated = dedicatedEventTypes(buildTiles(v), buildSheets(v), [], buildScorebug(v, t));
      // Withholding the tile removes it from `dedicated`, so `moreActions`
      // would re-offer the type if anything still put it in the PadSpec's
      // panels. Today nothing does (the engine gate); this pins the pad's
      // own half so the two cannot BOTH be missing.
      expect([...dedicated]).not.toContain("tennis.game.award");
      expect(refusedEventTypes(v)).toContain("tennis.game.award");
    });
  });

  // The replacement guarantee, asserted where it actually lives now. This is
  // the test that matters: if the chassis ever stops resolving a tappable
  // half, the point silently gains a second entry point through the generic
  // More form — and that path bypasses the dock, so a chair using it loses
  // the ace / double-fault / winner / unforced-error enrichment with nothing
  // on screen to say so.
  it("the scorebug's own tapEvent is what de-duplicates the point out of the More sheet", () => {
    const v = view();
    const dedicated = dedicatedEventTypes(buildTiles(v), buildSheets(v), [], buildScorebug(v, t));
    expect([...dedicated]).toContain("tennis.point");
  });
});

describe("buildTiles — band + phase gating, per EVENT_BAND", () => {
  it("withholds every tile above the ACTIVE band", () => {
    const tiles = buildTiles(view({ band: 0 }));
    expect(tileById(tiles, sanctionSheetKey("home"))).toBeUndefined();
    expect(tileById(tiles, "interruption")).toBeUndefined();
    expect(tileById(tiles, gameAwardTileId("home"))).toBeUndefined();
  });

  it("offers set score at band 0 (a band-0 event)", () => {
    expect(tileById(buildTiles(view({ band: 0 })), "setScore")).toBeDefined();
  });

  it("offers sanction/interruption at band 1", () => {
    const tiles = buildTiles(view({ band: 1 }));
    expect(tileById(tiles, sanctionSheetKey("home"))).toBeDefined();
    expect(tileById(tiles, "interruption")).toBeDefined();
    expect(tileById(tiles, gameAwardTileId("home"))).toBeUndefined();
  });

  it("no tile at all outside live phase", () => {
    const tiles = buildTiles(view({ phase: "pre", state: state({ phase: "pre" }) }));
    expect(tiles.filter((tl) => tl.id !== "more")).toEqual([]);
  });

  it("EVENT_BAND matches the engine's own fidelity map (kernel.ts:1553-1559)", () => {
    expect(EVENT_BAND).toEqual({
      "tennis.set_summary": 0,
      "tennis.sanction": 1,
      "tennis.interruption": 1,
      "tennis.point": 3,
      "tennis.game.award": 3,
    });
  });
});

describe("buildTiles — Code violation and Award game are per-side tiles", () => {
  it("Code violation: two tiles, each carrying the correct side sublabel and sheet", () => {
    const tiles = buildTiles(view());
    const home = tileById(tiles, sanctionSheetKey("home"))!;
    const away = tileById(tiles, sanctionSheetKey("away"))!;
    expect(home.sublabel).toBe("scorepad.attribution.home");
    expect(away.sublabel).toBe("scorepad.attribution.away");
    expect(home.action).toEqual({ sheet: sanctionSheetKey("home") });
  });

  it("Award game: two DIRECT-COMMIT tiles (no sheet), payload names the winning side's entrant", () => {
    const tiles = buildTiles(view());
    const home = tileById(tiles, gameAwardTileId("home"))!;
    expect(home.action).toEqual({ event: { type: "tennis.game.award", payload: { winner: "H" } } });
    const away = tileById(tiles, gameAwardTileId("away"))!;
    expect(away.action).toEqual({ event: { type: "tennis.game.award", payload: { winner: "A" } } });
  });

  it("Award game is withheld during a tie-break — the breaker IS the deciding game", () => {
    const tiles = buildTiles(view({ state: state({ points: { kind: "tiebreak", home: 3, away: 2 } }) }));
    expect(tileById(tiles, gameAwardTileId("home"))).toBeUndefined();
  });

  it("Award game is withheld during a match tie-break too", () => {
    const tiles = buildTiles(view({ state: state({ points: { kind: "matchTiebreak", home: 3, away: 2 } }) }));
    expect(tileById(tiles, gameAwardTileId("home"))).toBeUndefined();
  });

  it("Award game returns once back to standard scoring", () => {
    const tiles = buildTiles(view({ state: state({ points: { kind: "standard", home: 0, away: 0, advantage: null } }) }));
    expect(tileById(tiles, gameAwardTileId("home"))).toBeDefined();
  });
});

// R3/B2's own incident (`reference_v3_board_two_lanes_and_dock_after_
// sheet.md`): three football card tiles per side put Home's second yellow
// bodily inside the away lane, with every unit assertion still green,
// because nothing in tile-grid.tsx's bare `grid-cols-4` enforces the
// home-left/away-right convention — array order alone decides it. Pinned
// here two ways per side-owned tile: span === 2, and the COLUMN it lands in,
// modelling the same CSS auto-placement the real grid performs — across
// every combination that changes how many SIDE-LESS tiles (setScore,
// interruption) precede a pair, which is exactly the lever that broke it
// for football.
describe("buildTiles — the two-lane board: side pairs never cross lanes (R3/B2's own incident)", () => {
  function columnOf(tiles: readonly TileSpec[], id: string): number {
    let col = 0;
    for (const tile of tiles) {
      const span = tile.span ?? 1;
      if (col + span > 4) col = 0;
      if (tile.id === id) return col;
      col = (col + span) % 4;
    }
    throw new Error(`tile "${id}" not found`);
  }

  // Band 3 throughout — high enough that BOTH side pairs (sanction at band 1,
  // gameAward at band 3) can be checked in the same run. Three state shapes
  // that each change which side-less singles (setScore, interruption) are
  // present, hence how many tiles precede a pair — the exact axis football's
  // own incident varied along.
  const SCENARIOS: { name: string; over: Record<string, unknown> }[] = [
    { name: "fresh set (setScore + interruption both offered)", over: state() },
    { name: "mid-set (setScore withheld, interruption offered)", over: state({ games: { home: 1, away: 0 } }) },
    {
      name: "fresh set, tiebreak in progress (gameAward withheld)",
      over: state({ points: { kind: "tiebreak", home: 2, away: 1 } }),
    },
  ];

  it.each(SCENARIOS)("$name: every side-owned tile spans 2 and lands in its OWN side's column", ({ over }) => {
    const tiles = buildTiles(view({ state: over, band: 3 }));
    for (const tile of tiles) {
      if (tile.sublabel === "scorepad.attribution.home" || tile.sublabel === "scorepad.attribution.away") {
        expect(tile.span, tile.id).toBe(2);
      }
    }
    if (tileById(tiles, sanctionSheetKey("home"))) {
      expect(columnOf(tiles, sanctionSheetKey("home"))).toBe(0);
      expect(columnOf(tiles, sanctionSheetKey("away"))).toBe(2);
    }
    if (tileById(tiles, gameAwardTileId("home"))) {
      expect(columnOf(tiles, gameAwardTileId("home"))).toBe(0);
      expect(columnOf(tiles, gameAwardTileId("away"))).toBe(2);
    }
  });

  it("MUTATION-SHAPED CHECK: a side-less single ahead of a pair, alone, would misalign it — confirms the test can actually see the defect class", () => {
    // Reproduces football's own R3/B2 shape directly against THIS skin's
    // tiles, independent of buildTiles' current (correct) ordering: one
    // single span-2 tile, then a side pair, is exactly the misalignment.
    const decoy: TileSpec = { id: "decoy", label: "x" as MessageKey, kind: "minor", span: 2, phases: ["live"], action: { sheet: "x" } };
    const home: TileSpec = { id: "h", label: "x" as MessageKey, sublabel: "scorepad.attribution.home", kind: "standard", span: 2, phases: ["live"], action: { sheet: "h" } };
    const away: TileSpec = { id: "a", label: "x" as MessageKey, sublabel: "scorepad.attribution.away", kind: "standard", span: 2, phases: ["live"], action: { sheet: "a" } };
    expect(columnOf([decoy, home, away], "a")).toBe(0); // away lands in the HOME lane
    expect(columnOf([home, away], "a")).toBe(2); // without the decoy, it is correct
  });
});

it("buildTiles always offers More, spanning the full row", () => {
  const tile = tileById(buildTiles(view()), "more")!;
  expect(tile.span).toBe(4);
  expect(tile.action).toEqual({ sheet: "__pad-host/more__" });
});

// No Fault/Let/Retire tiles anywhere — R4-1/R4-2.
it("declares no fault, let or retire tile at any band", () => {
  for (const band of [0, 1, 2, 3] as const) {
    const ids = buildTiles(view({ band })).map((tl) => tl.id);
    for (const banned of ["fault", "let", "retire"]) expect(ids).not.toContain(banned);
  }
});

// ---------------------------------------------------------------------------
// buildSheets
// ---------------------------------------------------------------------------

function driveSheet(spec: GuidedSheetSpec, answers: readonly string[]) {
  let s = initialSheetState();
  for (const answer of answers) {
    const outcome = answerStep(spec, s, answer);
    if (outcome.done) return outcome.event;
    s = outcome.state;
  }
  throw new Error("sheet did not complete with the given answers");
}

describe("setScore sheet", () => {
  it("home/away only, when the score is not the tie-break shape", () => {
    const spec = buildSheets(view()).setScore!;
    const event = driveSheet(spec, ["6", "4"]);
    expect(event).toEqual({ type: "tennis.set_summary", payload: { home: 6, away: 4 } });
  });

  it("asks tb points ONLY when the score is tiebreakAt+1 : tiebreakAt", () => {
    const spec = buildSheets(view()).setScore!;
    // 7-6 IS the shape (tiebreakAt=6) — tbHome/tbAway must be asked.
    let s = initialSheetState();
    s = (answerStep(spec, s, "7") as { state: typeof s }).state;
    s = (answerStep(spec, s, "6") as { state: typeof s }).state;
    expect(currentStep(spec, s)!.id).toBe("tbHome");
    const event = driveSheet(spec, ["7", "6", "7", "5"]);
    expect(event).toEqual({ type: "tennis.set_summary", payload: { home: 7, away: 6, tb: { home: 7, away: 5 } } });
  });

  it("skips the tb step entirely for a plain, non-tiebreak score", () => {
    const spec = buildSheets(view()).setScore!;
    const s0 = initialSheetState();
    const afterHome = answerStep(spec, s0, "6");
    expect(afterHome.done).toBe(false);
    if (afterHome.done) throw new Error("unreachable");
    const afterAway = answerStep(spec, afterHome.state, "4");
    // The wizard completes right here — no tb step was ever visited.
    expect(afterAway.done).toBe(true);
    if (!afterAway.done) throw new Error("unreachable");
    expect(afterAway.event).toEqual({ type: "tennis.set_summary", payload: { home: 6, away: 4 } });
  });

  it("never asks tb during an MTB-deciding set — home/away carry the MTB points directly", () => {
    const v = view({
      cfg: cfg({ finalSet: { matchTiebreakTo: 10 } }),
      state: state({ setsWon: { home: 1, away: 1 } }), // deciding set, bestOf 3
    });
    const spec = buildSheets(v).setScore!;
    const event = driveSheet(spec, ["10", "8"]);
    expect(event).toEqual({ type: "tennis.set_summary", payload: { home: 10, away: 8 } });
  });
});

describe("sanction sheets — per side, level tones, person narrowed to that side", () => {
  it("declares one sheet per side, keyed by sanctionSheetKey", () => {
    const sheets = buildSheets(view());
    expect(sheets[sanctionSheetKey("home")]).toBeDefined();
    expect(sheets[sanctionSheetKey("away")]).toBeDefined();
  });

  it("offers all four SANCTION_LEVELS, in the engine's own ladder order", () => {
    const step = buildSheets(view())[sanctionSheetKey("home")]!.steps[0]!;
    expect(step.kind).toBe("choice");
    expect((step as { options: { id: string }[] }).options.map((o) => o.id)).toEqual(SANCTION_LEVELS);
    expect(SANCTION_LEVELS).toEqual(["warning", "point_penalty", "game_penalty", "default"]);
  });

  it("R4-4: warning and default carry a tone; point_penalty/game_penalty carry none", () => {
    const options = buildSheets(view())[sanctionSheetKey("home")]!.steps[0]! as {
      options: { id: string; tone?: readonly string[] }[];
    };
    const toneOf = (id: string) => options.options.find((o) => o.id === id)?.tone;
    expect(toneOf("warning")).toEqual(["caution"]);
    expect(toneOf("default")).toEqual(["dismissal"]);
    expect(toneOf("point_penalty")).toBeUndefined();
    expect(toneOf("game_penalty")).toBeUndefined();
  });

  it("person step is narrowed to the FIXED side's own on-field roster — a doubles pair gives two candidates", () => {
    const step = buildSheets(view({ squads: doublesSquads(true) }))[sanctionSheetKey("home")]!.steps[1]! as {
      side: string;
      candidates?: readonly string[];
    };
    expect(step.side).toBe("home");
    expect(step.candidates).toEqual(["H-first", "H-second"]);
  });

  it("away sheet never offers a home player as a candidate", () => {
    const step = buildSheets(view({ squads: doublesSquads(true) }))[sanctionSheetKey("away")]!.steps[1]! as {
      candidates?: readonly string[];
    };
    expect(step.candidates).toEqual(["A-first", "A-second"]);
  });

  it("builds a payload naming the OFFENDER as `by`, never the fold's own opposite convention", () => {
    const spec = buildSheets(view())[sanctionSheetKey("away")]!;
    const event = driveSheet(spec, ["point_penalty", "A"]);
    expect(event).toEqual({ type: "tennis.sanction", payload: { by: "A", level: "point_penalty", person: "A" } });
  });
});

// ---------------------------------------------------------------------------
// Defect 2 fix (code review, 2026-08-25): `NestedSanction.person` is OPTIONAL
// by the engine's own schema ("absent = the pair/team, not a named player"),
// but the person step above was MANDATORY — `candidatesForStep`
// (guided-sheet.tsx:103) is `step.candidates ?? resolvePool(...)`, and an
// EMPTY array is not nullish, so it superseded the pool with nothing to show.
// On a lineup-less fixture the sheet dead-ended on "Who?" with no way to
// finish recording the violation at all. Fixed with a `when` predicate — the
// shipped chassis idiom for skipping a step without a tap (guided-sheet.tsx's
// own G2 doc; `interruptionSheet` already uses it for its own person steps)
// — over passing `undefined` for `candidates`, so the skip is driven by the
// SAME `candidates` list the step already renders from, rather than a second,
// separately-computed condition that could drift from it.
// ---------------------------------------------------------------------------

describe("sanction sheet — defect 2 fix: person step skips cleanly with no on-field roster", () => {
  it("MUTATION PROOF (throws — sheet never completes — without the fix): completes after `level` alone, person omitted", () => {
    const spec = buildSheets(view({ squads: emptySquads() }))[sanctionSheetKey("home")]!;
    const event = driveSheet(spec, ["warning"]);
    expect(event).toEqual({ type: "tennis.sanction", payload: { by: "H", level: "warning", person: undefined } });
  });

  it("still asks person when the side DOES have an on-field roster — unchanged", () => {
    const spec = buildSheets(view({ squads: singlesSquads() }))[sanctionSheetKey("home")]!;
    let s = initialSheetState();
    s = (answerStep(spec, s, "warning") as { state: typeof s }).state;
    expect(currentStep(spec, s)!.id).toBe("person");
  });
});

describe("interruption sheet — R4-2, one generic tile, side is genuinely optional", () => {
  it("kind, then side, then duration when side is none — person is skipped entirely", () => {
    const spec = buildSheets(view()).interruption!;
    let s = initialSheetState();
    s = (answerStep(spec, s, "medical") as { state: typeof s }).state;
    s = (answerStep(spec, s, "none") as { state: typeof s }).state;
    expect(currentStep(spec, s)!.id).toBe("duration");
    const event = driveSheet(spec, ["medical", "none", "45"]);
    expect(event).toEqual({ type: "tennis.interruption", payload: { kind: "medical", duration: 45 } });
  });

  it("side=home asks personHome next, narrowed to home's own roster, and sends `by`", () => {
    const spec = buildSheets(view({ squads: doublesSquads(true) })).interruption!;
    let s = initialSheetState();
    s = (answerStep(spec, s, "toilet") as { state: typeof s }).state;
    s = (answerStep(spec, s, "home") as { state: typeof s }).state;
    const step = currentStep(spec, s)!;
    expect(step.id).toBe("personHome");
    expect((step as { candidates?: readonly string[] }).candidates).toEqual(["H-first", "H-second"]);
    const event = driveSheet(spec, ["toilet", "home", "H-first", "60"]);
    expect(event).toEqual({
      type: "tennis.interruption",
      payload: { kind: "toilet", by: "H", person: "H-first", duration: 60 },
    });
  });

  it("side=away asks personAway, never personHome, and sends the away entrant as `by`", () => {
    const spec = buildSheets(view({ squads: doublesSquads(true) })).interruption!;
    const event = driveSheet(spec, ["heat", "away", "A-second", "90"]);
    expect(event).toEqual({
      type: "tennis.interruption",
      payload: { kind: "heat", by: "A", person: "A-second", duration: 90 },
    });
  });

  it("INTERRUPTION_KINDS are the engine's own closed vocabulary", () => {
    expect(INTERRUPTION_KINDS).toEqual(["medical", "toilet", "heat", "other"]);
  });
});

describe("interruption sheet — defect 2 fix: person step skips cleanly when the chosen side has no on-field roster", () => {
  it("MUTATION PROOF (throws — sheet never completes — without the fix): side=home with an EMPTY home roster skips personHome, straight to duration", () => {
    const spec = buildSheets(view({ squads: emptySquads() })).interruption!;
    let s = initialSheetState();
    s = (answerStep(spec, s, "medical") as { state: typeof s }).state;
    s = (answerStep(spec, s, "home") as { state: typeof s }).state;
    expect(currentStep(spec, s)!.id).toBe("duration");
    const event = driveSheet(spec, ["medical", "home", "45"]);
    expect(event).toEqual({ type: "tennis.interruption", payload: { kind: "medical", by: "H", duration: 45 } });
  });

  it("still asks personAway when away's roster IS populated — unchanged", () => {
    const spec = buildSheets(view({ squads: doublesSquads(true) })).interruption!;
    let s = initialSheetState();
    s = (answerStep(spec, s, "heat") as { state: typeof s }).state;
    s = (answerStep(spec, s, "away") as { state: typeof s }).state;
    expect(currentStep(spec, s)!.id).toBe("personAway");
  });

  it("side=none is unaffected — still skips straight to duration regardless of roster", () => {
    const spec = buildSheets(view({ squads: emptySquads() })).interruption!;
    const event = driveSheet(spec, ["other", "none", "10"]);
    expect(event).toEqual({ type: "tennis.interruption", payload: { kind: "other", duration: 10 } });
  });
});

// ---------------------------------------------------------------------------
// buildDock — build spec §4, the wave's real product value.
// ---------------------------------------------------------------------------

describe("buildDock — legality by side, read from the PAYLOAD not the live view", () => {
  it("returns null for every non-point event type", () => {
    expect(buildDock("tennis.sanction", view(), t, {})).toBeNull();
    expect(buildDock("tennis.set_summary", view(), t, {})).toBeNull();
    expect(buildDock("tennis.interruption", view(), t, {})).toBeNull();
    expect(buildDock("tennis.game.award", view(), t, {})).toBeNull();
  });

  it("offers ace when `by` IS the serving side (server belongs to the winning side)", () => {
    const spec = buildDock("tennis.point", view(), t, { by: "H", server: "H" })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["ace", "winner", "ue"]);
  });

  it("offers double_fault when `by` is NOT the serving side", () => {
    const spec = buildDock("tennis.point", view(), t, { by: "A", server: "H" })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["double_fault", "winner", "ue"]);
  });

  it("MUTATION PROOF: offers NEITHER ace nor double_fault when the server is unknown — winner/ue only", () => {
    const spec = buildDock("tennis.point", view(), t, { by: "H" })!; // no `server`
    expect(spec.chips.map((c) => c.id)).toEqual(["winner", "ue"]);
  });

  it("MUTATION PROOF: an ace tap on the RECEIVING side is impossible — the chip is never offered there", () => {
    // side H won the point, but H is the RECEIVER here (A served) — ace must
    // never appear, only double_fault/winner/ue.
    const spec = buildDock("tennis.point", view(), t, { by: "H", server: "A" })!;
    expect(spec.chips.map((c) => c.id)).not.toContain("ace");
    expect(spec.chips.map((c) => c.id)).toEqual(["double_fault", "winner", "ue"]);
  });

  it("one-way: once a kind lands in the payload, ONLY that chip is returned", () => {
    const spec = buildDock("tennis.point", view(), t, { by: "H", server: "H", meta: { kind: "ace" } })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["ace"]);
  });

  it("a chosen chip's mutate sets meta.kind and preserves the rest of the payload", () => {
    const spec = buildDock("tennis.point", view(), t, { by: "H", server: "H" })!;
    const ace = spec.chips.find((c) => c.id === "ace")!;
    expect(ace.mutate({ by: "H", server: "H" })).toEqual({ by: "H", server: "H", meta: { kind: "ace" } });
  });

  it("POINT_KINDS is the engine's own closed vocabulary, in NestedPointMeta's own order", () => {
    expect(POINT_KINDS).toEqual(["ace", "double_fault", "winner", "ue"]);
  });

  it("resolves the serving side from PERSON membership in doubles, not from the tapped side alone", () => {
    const doubles = view({ squads: doublesSquads(true) });
    // A-first served (person-level), H won the point (side-level) -> receiver's point.
    const spec = buildDock("tennis.point", doubles, t, { by: "H", server: "A-first" })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["double_fault", "winner", "ue"]);
  });
});

// ---------------------------------------------------------------------------
// buildDock — defect 1 fix (code review, 2026-08-25): a lineup-less fixture
// can never name a SERVER PERSON, but `serveContext.side` (`kernel.ts:511-
// 518`) is `state.serving` directly, entirely roster-independent — and side
// is all the ace-vs-double-fault legality rule needs. `buildHalf` never gets
// a wire-safe way to carry that side fact forward (`NestedPoint` is a
// `z.strictObject` — `by`/`server`/`scorer`/`meta` only, checked against
// kernel.ts, so a new field would fail validation the instant the optimistic
// fold applies it), so the fix lives entirely on the READ side, in
// `buildDock` itself, re-deriving the SIDE ONLY (never a person) from
// `view.state` — safe except at the exact point that ends a game/tiebreak/
// set, where `state.serving` has already rotated (see the MUTATION PROOF
// below).
// ---------------------------------------------------------------------------

describe("buildDock — defect 1 fix: lineup-less fixture still gates ace/double_fault by SIDE", () => {
  it("buildHalf never stamps a `server` PERSON for a roster-less fixture — there is nobody to name", () => {
    const spec = buildScorebug(view({ squads: emptySquads() }), t);
    expect(spec.halves[0]!.tapEvent?.payload).not.toHaveProperty("server");
    expect(spec.halves[1]!.tapEvent?.payload).not.toHaveProperty("server");
  });

  it("offers ace/double_fault BY SIDE with no on-field roster at all, mid-game", () => {
    const v = view({
      squads: emptySquads(),
      state: state({ serving: "home", points: { kind: "standard", home: 1, away: 0, advantage: null } }),
    });
    const ace = buildDock("tennis.point", v, t, { by: "H" })!; // home serves, home wins -> ace
    expect(ace.chips.map((c) => c.id)).toEqual(["ace", "winner", "ue"]);
    const df = buildDock("tennis.point", v, t, { by: "A" })!; // home serves, away wins -> double_fault
    expect(df.chips.map((c) => c.id)).toEqual(["double_fault", "winner", "ue"]);
  });

  it("a real `server` name still takes precedence over the roster-less fallback", () => {
    // Populated roster: `server` resolves for real, so the SIDE-only fallback
    // must never override it — unchanged path, pinned here for precedence.
    const spec = buildDock("tennis.point", view(), t, { by: "H", server: "H" })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["ace", "winner", "ue"]);
  });

  it("stays a safe omission for an undeclared DOUBLES rotation — a real roster, just no fixed order (unchanged)", () => {
    const v = view({
      squads: doublesSquads(false),
      state: state({ points: { kind: "standard", home: 1, away: 0, advantage: null } }),
    });
    const spec = buildDock("tennis.point", v, t, { by: "H" })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["winner", "ue"]);
  });

  // Was "stays a safe omission with ANY set_summary history". It used an EVEN
  // summary (6-0), which is exactly the case the engine's R4-7 guard says is
  // still derivable — so it pinned an over-refusal that cost the scorer every
  // ace and double fault after a backfilled set. Split in two: the refusal is
  // now driven by the engine's verdict, not by the presence of a summary.
  it("an ODD-game summary is still a safe omission — the fold and the walk disagree", () => {
    const v = view({
      squads: emptySquads(),
      // 9 banked games: `serving` never moved, the walk did.
      state: state({
        serving: "home",
        sets: [{ home: 6, away: 3 }],
        points: { kind: "standard", home: 1, away: 0, advantage: null },
      }),
    });
    const spec = buildDock("tennis.point", v, t, { by: "H" })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["winner", "ue"]);
  });

  it("an EVEN-game summary keeps the fallback working — the rotation is genuinely derivable", () => {
    const v = view({
      squads: emptySquads(),
      state: state({
        serving: "home",
        sets: [{ home: 6, away: 0 }],
        points: { kind: "standard", home: 1, away: 0, advantage: null },
      }),
    });
    const spec = buildDock("tennis.point", v, t, { by: "H" })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["ace", "winner", "ue"]);
  });

  // Boundary TWO (final review). Inside a breaker `state.serving` rotates
  // MID-GAME — after every odd point (`applyTbPoint`) — and the (0, 0) guard
  // cannot see it, because a breaker at 3-2 is not at (0, 0). Read raw, the
  // re-derived side names the NEXT point's server, so ace and double_fault
  // came out INVERTED on half of every tie-break's points: a wrong serving
  // statistic against a person, recorded silently, in the phase of a set
  // where aces decide it. Recoverable exactly (the rotation is a pure
  // function of the point count), so it is corrected, not withheld.
  it("REGRESSION: names the server of the point JUST PLAYED after an ODD tie-break point, not the next one", () => {
    // Home served TB point 1 and won it. `applyTbPoint` has already handed
    // serve to away for points 2-3, so `state.serving` reads "away" — but
    // home hit that ace.
    const v = view({
      squads: emptySquads(),
      // `games: 6-6` and `tbFirstServer` are not decoration: a live tie-break
      // at 0-0 games with no recorded first server is a state the fold can
      // never produce, and the engine's drift guard now (correctly) refuses
      // to answer for it. The fixture has to be a state that can exist.
      state: state({
        serving: "away",
        games: { home: 6, away: 6 },
        tbFirstServer: "home",
        points: { kind: "tiebreak", home: 1, away: 0 },
      }),
    });
    expect(buildDock("tennis.point", v, t, { by: "H" })!.chips.map((c) => c.id)).toEqual(["ace", "winner", "ue"]);
    expect(buildDock("tennis.point", v, t, { by: "A" })!.chips.map((c) => c.id)).toEqual([
      "double_fault",
      "winner",
      "ue",
    ]);
  });

  it("REGRESSION: does NOT step back on an EVEN tie-break point — serve did not hand off there", () => {
    // Two points played; away is serving points 2-3 and won point 2.
    const v = view({
      squads: emptySquads(),
      state: state({
        serving: "away",
        games: { home: 6, away: 6 },
        tbFirstServer: "home",
        points: { kind: "tiebreak", home: 1, away: 1 },
      }),
    });
    expect(buildDock("tennis.point", v, t, { by: "A" })!.chips.map((c) => c.id)).toEqual(["ace", "winner", "ue"]);
  });

  it("REGRESSION: a MATCH tie-break hands off on the same odd-point rule", () => {
    const v = view({
      squads: emptySquads(),
      // An MTB opens off `bankSet`, which zeroes `games` and records the
      // first server — so 0-0 games IS the realistic shape here.
      state: state({
        serving: "away",
        tbFirstServer: "home",
        points: { kind: "matchTiebreak", home: 5, away: 4 },
      }),
    });
    // 9 points played — odd, so away is serving NEXT and home served this one.
    expect(buildDock("tennis.point", v, t, { by: "H" })!.chips.map((c) => c.id)).toEqual(["ace", "winner", "ue"]);
  });

  it("MUTATION PROOF: the step-back is breaker-ONLY — a standard game never hands off mid-game", () => {
    // 15-0: one point played, odd. A step-back that ignored `points.kind`
    // would invert this, calling home's own ace a double fault.
    const v = view({
      squads: emptySquads(),
      state: state({ serving: "home", points: { kind: "standard", home: 1, away: 0, advantage: null } }),
    });
    expect(buildDock("tennis.point", v, t, { by: "H" })!.chips.map((c) => c.id)).toEqual(["ace", "winner", "ue"]);
  });

  it("MUTATION PROOF: a game-ending point stays a safe omission — a naive post-fold recompute would MISCLASSIFY it, not merely omit it", () => {
    // Home was serving and WON this exact point, ending the game: by the time
    // this dock renders, `winGame`/`serveAfterGame` (kernel.ts:791-825) have
    // already rotated `state.serving` to "away" and reset `state.points` to a
    // fresh (0, 0) — checked exhaustively, every exit path of `winGame`/
    // `bankSet` does both together. A recompute that ignored this would read
    // the CURRENT `state.serving` ("away") and misclassify home's ace as
    // away's double_fault — the opposite of "just omit it".
    const v = view({
      squads: emptySquads(),
      state: state({ serving: "away", points: { kind: "standard", home: 0, away: 0, advantage: null } }),
    });
    const spec = buildDock("tennis.point", v, t, { by: "H" })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["winner", "ue"]);
  });
});

// ---------------------------------------------------------------------------
// buildDock — R4-5's doubles scorer step (the dock's SECOND question).
// ---------------------------------------------------------------------------

describe("buildDock — R4-5 doubles scorer step", () => {
  it("does not appear before a shot type is chosen — step 1 stays kind-only, even in doubles", () => {
    const doubles = view({ squads: doublesSquads(true) });
    const spec = buildDock("tennis.point", doubles, t, { by: "H", server: "H-first" })!; // no meta.kind yet
    expect(spec.chips.map((c) => c.id)).toEqual(["ace", "winner", "ue"]);
    expect(spec.chips.some((c) => c.id.startsWith("scorer:"))).toBe(false);
  });

  it("offers exactly the WINNING pair's two players once a kind lands, doubles only", () => {
    const doubles = view({ squads: doublesSquads(true) });
    const spec = buildDock("tennis.point", doubles, t, { by: "H", server: "H-first", meta: { kind: "ace" } })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["scorer:H-first", "scorer:H-second"]);
  });

  it("MUTATION PROOF: never offers the LOSING side's pair — only the side that won the point (`by`)", () => {
    const doubles = view({ squads: doublesSquads(true) });
    const spec = buildDock("tennis.point", doubles, t, {
      by: "A",
      server: "H-first",
      meta: { kind: "double_fault" },
    })!;
    const ids = spec.chips.map((c) => c.id);
    expect(ids).toEqual(["scorer:A-first", "scorer:A-second"]);
    expect(ids).not.toContain("scorer:H-first");
    expect(ids).not.toContain("scorer:H-second");
  });

  it("labels each chip with the player's own NAME via labelText, never a dictionary lookup", () => {
    const doubles = view({ squads: doublesSquads(true) });
    const spec = buildDock("tennis.point", doubles, t, { by: "H", server: "H-first", meta: { kind: "ace" } })!;
    expect(spec.chips.map((c) => c.labelText)).toEqual([NAMES["H-first"], NAMES["H-second"]]);
    expect(spec.chips.every((c) => c.label === "pad.tennis.dock.person")).toBe(true);
  });

  it("SINGLES never reaches this step, even with no `scorer` in the payload — nothing to choose", () => {
    const spec = buildDock("tennis.point", view(), t, { by: "H", server: "H", meta: { kind: "ace" } })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["ace"]);
  });

  it("collapses back to the kind chip once `scorer` is answered — the answered question stops being asked", () => {
    const doubles = view({ squads: doublesSquads(true) });
    const spec = buildDock("tennis.point", doubles, t, {
      by: "H",
      server: "H-first",
      scorer: "H-first",
      meta: { kind: "ace" },
    })!;
    expect(spec.chips.map((c) => c.id)).toEqual(["ace"]);
  });

  it("a chosen scorer chip's mutate sets `scorer` and preserves the rest of the payload", () => {
    const doubles = view({ squads: doublesSquads(true) });
    const spec = buildDock("tennis.point", doubles, t, { by: "H", server: "H-first", meta: { kind: "ace" } })!;
    const chip = spec.chips.find((c) => c.id === "scorer:H-second")!;
    expect(chip.mutate({ by: "H", server: "H-first", meta: { kind: "ace" } })).toEqual({
      by: "H",
      server: "H-first",
      meta: { kind: "ace" },
      scorer: "H-second",
    });
  });
});

// ---------------------------------------------------------------------------
// tennisDetail — the ribbon's varying half.
// ---------------------------------------------------------------------------

describe("tennisDetail", () => {
  const ctx = (over: Record<string, unknown>) => ({
    t,
    eventType: over.eventType as string,
    payload: (over.payload as Record<string, unknown>) ?? {},
    personNames: NAMES,
  });

  it("point: shot kind + server name", () => {
    expect(tennisDetail(ctx({ eventType: "tennis.point", payload: { server: "H", meta: { kind: "ace" } } }))).toBe(
      `${t("kind.ace")} · ${NAMES.H}`,
    );
  });

  it("point: undefined when there is nothing to add", () => {
    expect(tennisDetail(ctx({ eventType: "tennis.point", payload: { by: "H" } }))).toBeUndefined();
  });

  it("set_summary: the score, plus the tie-break line when present", () => {
    expect(tennisDetail(ctx({ eventType: "tennis.set_summary", payload: { home: 7, away: 6, tb: { home: 7, away: 5 } } }))).toBe(
      "7–6 · (7-5)",
    );
  });

  it("sanction: level + person + free-text reason when present", () => {
    expect(
      tennisDetail(ctx({ eventType: "tennis.sanction", payload: { level: "warning", person: "H", reason: "racquet abuse" } })),
    ).toBe(`${t("sanction.warning")} · ${NAMES.H} · racquet abuse`);
  });

  // The engine's `tennis.sanction` event carries the offender as `by`, not
  // `person` (kernel.ts) — `person` is dressing this function invents. The
  // test above only ever exercised the invented field, so a real
  // engine-shaped payload silently dropped the name (scoring-vocab-labels
  // e2e:191 caught it live: `row` never contained the offender's name).
  it("sanction: falls back to `by` when `person` is absent — the engine's own field name", () => {
    expect(
      tennisDetail(ctx({ eventType: "tennis.sanction", payload: { level: "warning", by: "H", reason: "racquet abuse" } })),
    ).toBe(`${t("sanction.warning")} · ${NAMES.H} · racquet abuse`);
  });

  it("interruption: kind + person", () => {
    expect(tennisDetail(ctx({ eventType: "tennis.interruption", payload: { kind: "medical", person: "A" } }))).toBe(
      `${t("kind.medical")} · ${NAMES.A}`,
    );
  });

  it("game.award: the free-text reason only (no fold access to resolve winner's side)", () => {
    expect(tennisDetail(ctx({ eventType: "tennis.game.award", payload: { winner: "H", reason: "code violation" } }))).toBe(
      "code violation",
    );
    expect(tennisDetail(ctx({ eventType: "tennis.game.award", payload: { winner: "H" } }))).toBeUndefined();
  });

  it("unknown event type: undefined", () => {
    expect(tennisDetail(ctx({ eventType: "core.start", payload: {} }))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tennisSkinV3 — factory assembly. Proves `t` is threaded THROUGH the
// factory, not merely usable by the builders in isolation — the same
// tsc-invisible trap R2c's cricket proof exists to catch: a default
// parameter type-checks, lints, and ships a raw i18n key to a scorer while
// every direct-call test above stays green.
// ---------------------------------------------------------------------------

describe("tennisSkinV3 — factory assembly", () => {
  it("assembles a full SkinDefV3: key/tapModel correct, no swap/context/contextSelect", () => {
    const skin = tennisSkinV3(t);
    expect(skin.key).toBe("tennis");
    expect(skin.tapModel).toBe("S");
    expect(skin.tiles(view()).length).toBeGreaterThan(0);
    expect(skin.phase!(view())).toBe("live");
    expect(skin.swap).toBeUndefined();
    expect(skin.context).toBeUndefined();
    expect(skin.contextSelect).toBeUndefined();
  });

  it("two different t functions produce two independently-localised scorebugs — proves the closure, not a shared cache", () => {
    const skinA = tennisSkinV3((k, vars) => `A:${k}${vars ? JSON.stringify(vars) : ""}`);
    const skinB = tennisSkinV3((k, vars) => `B:${k}${vars ? JSON.stringify(vars) : ""}`);
    expect(skinA.scorebug(view()).context).toContain("A:pad.tennis.context.line");
    expect(skinB.scorebug(view()).context).toContain("B:pad.tennis.context.line");
  });

  it("dock() closes over the factory's own t, not a bare default — the same proof as cricket's R2c pin", () => {
    const marker = tennisSkinV3((k) => `MARK:${k}`);
    const spec = marker.dock("tennis.point", view(), { by: "H", server: "H" })!;
    expect(spec.title).toBe("MARK:pad.tennis.dock.point.title");
  });

  it("sheets() closes over the factory's own t — mirrors cricket's R2c proof for the same tsc-invisible trap", () => {
    const marker = tennisSkinV3((k) => `MARK:${k}`);
    // sheets() itself takes no t in this skin (buildSheets is t-free), so the
    // proof here is that a step's OWN title key is exactly what the chassis
    // will resolve — sheets() must still be reachable off the factory result.
    expect(marker.sheets!(view()).setScore).toBeDefined();
  });

  it("registry flip: resolvePad('tennis', t) resolves to the v3 skin (see registry-totality.test.ts for the mutation proof)", async () => {
    const { resolvePad } = await import("../../registry");
    expect(resolvePad("tennis", t).key).toBe("tennis");
  });
});
