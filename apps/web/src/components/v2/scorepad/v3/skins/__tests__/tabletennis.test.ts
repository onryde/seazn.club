// R5/C2 — table tennis SkinDefV3. Pure-data assertions (apps/web vitest is
// `environment: "node"`, no jsdom): the skin is a spec BUILDER, so this file
// asserts the specs it returns and leaves the DOM to
// `e2e/scorepad-v3-tabletennis.spec.ts`.
//
// EVERY STATE HERE COMES OUT OF THE REAL FOLD, badminton's own precedent
// (`reference_setbased_serve_test_authoring_traps.md`): `foldClient
// (tabletennis, ...)` over real `EventEnvelope`s, never a hand-typed state
// literal. The one deliberate exception is `degenerateView()`, named so
// nobody mistakes it for a shortcut.
//
// TABLE TENNIS'S OWN ROTATION IS `fixed-turns`, NOT `rally-winner` — a
// SINGLE-PARITY PIN would be this file's most likely false green (this
// programme's own repeated lesson: R4 tie-break 10-0, R4 D-21 turn 6/8, R5-1's
// own expedite-trigger survivor). Every serve-derivation test below asserts
// BOTH sides at two different scores, and the game-boundary test pins a
// `setStart:"alternate"` opener that LOSES the game it opened, so the
// alternation cannot be confused with "the winner serves".
import { describe, expect, it } from "vitest";
import uiEn from "@/dictionaries/en/ui.json";
import { PAD_LABEL_KEYS } from "@/lib/scoring-vocab";
import { ribbonKeyFor } from "../../ribbon";
import type { EventEnvelope, Lineup, LineupPair, SquadState } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import type { FidelityBand, ModuleEvent } from "@seazn/engine/sport";
import { makeEnvelope } from "@seazn/engine/testkit";
import { tabletennis } from "@seazn/engine/sports/setbased";
import { EngineError } from "@seazn/engine/core";
import { foldClient } from "../../../module-client";
import { assertScorebugSpec, type PadHostView, type TileSpec } from "../../types";
import { dedicatedEventTypes, moreActions } from "../../pad-host";
import {
  EVENT_BAND,
  EXPEDITE_RETURNS_THRESHOLD,
  EXPEDITE_START_TILE_ID,
  EXPEDITE_TYPE,
  RALLY_TYPE,
  SANCTION_LEVELS,
  SANCTION_TYPE,
  SERVE_ANCHOR_TILE_ID,
  SET_SCORE_TILE_ID,
  SUB_TYPE,
  SUMMARY_TYPE,
  TIMEOUT_TYPE,
  buildDock,
  buildScorebug,
  buildSheets,
  buildTiles,
  refusedEventTypes,
  resolvePhase,
  sanctionSheetKey,
  serveContextOf,
  tabletennisDetail,
  tabletennisSkinV3,
  timeoutTileId,
} from "../tabletennis";
import type { TFn } from "../tabletennis";

// ---------------------------------------------------------------------------
// Fixtures — the fold, and nothing but the fold
// ---------------------------------------------------------------------------

/** The oracle `t`. It ECHOES ITS INPUT, including the vars, so an assertion on
 *  a built string cannot pass by coincidence when a branch resolves the WRONG
 *  key. */
const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

const NAMES: Record<string, string> = {
  H1: "Home Singles",
  A1: "Away Singles",
  "H-first": "Home First",
  "H-second": "Home Second",
  "A-first": "Away First",
  "A-second": "Away Second",
};

function singlesSide(entrantId: string, personId: string): Lineup {
  return { entrantId, slots: [{ personId, slot: "starting", orderNo: 1 }] };
}

/** A pair team sheet. `orderNo` deliberately runs the OTHER WAY from
 *  `pairOrder` (badminton's own `pairSide` trap) so a reader that quietly
 *  sorted by `orderNo` names the wrong player and this file notices —
 *  load-bearing here in particular, because `serverFromPairOrder: true`
 *  means the ENGINE (not a fallback) names the doubles server off this
 *  exact order. */
function pairSide(entrantId: string, first: string, second: string): Lineup {
  return {
    entrantId,
    slots: [
      { personId: second, slot: "starting", orderNo: 1, pairOrder: 2 },
      { personId: first, slot: "starting", orderNo: 2, pairOrder: 1 },
    ],
  };
}

const SINGLES: LineupPair = { home: singlesSide("H", "H1"), away: singlesSide("A", "A1") };
const DOUBLES: LineupPair = {
  home: pairSide("H", "H-first", "H-second"),
  away: pairSide("A", "A-first", "A-second"),
};

const ITTF_CFG = tabletennis.configSchema.parse({});
/** A legal SHORT config — best of 3, games to 3, no cap needed (table tennis
 *  ships uncapped and the schema's `cap >= max(setTo,finalSetTo)` refinement
 *  is trivially satisfied by `cap: null`). `bestOf: 3` is EXPLICIT and not
 *  inherited from the module default (5) — two banked games only decide a
 *  best-of-3 match (`majority(3) === 2`); the module's own best-of-5 default
 *  needs three. Used wherever a test needs a whole match played out without
 *  eleven-plus events. */
const SHORT_CFG = tabletennis.configSchema.parse({ bestOf: 3, setTo: 3, finalSetTo: 3 });
/** The hardbat-21 variant's own config, by hand (never via `variants` here —
 *  this file asserts the SKIN's own cfg-derived arithmetic, so it must read
 *  it off a plain parsed cfg the same way a fixture's `cfg` field would
 *  arrive). Games to 21 — deuce at 20-all, never the default's 10-all, which
 *  is exactly the "hardcoded 10" trap this wave's own brief names. */
const HARDBAT_CFG = tabletennis.configSchema.parse({ setTo: 21, finalSetTo: 21 });

const ev = (seq: number, type: string, payload: unknown): EventEnvelope =>
  makeEnvelope(seq, { type, payload } as ModuleEvent);

/** Every stream starts with `core.start`: `applyRally` refuses anything while
 *  the phase is still "pre". */
function stream(...events: readonly (readonly [string, unknown])[]): EventEnvelope[] {
  return [ev(0, "core.start", {}), ...events.map(([type, payload], i) => ev(i + 1, type, payload))];
}

const rally = (wonBy: "H" | "A", extra: Record<string, unknown> = {}): readonly [string, unknown] => [
  RALLY_TYPE,
  { wonBy, ...extra },
];
const summary = (home: number, away: number): readonly [string, unknown] => [SUMMARY_TYPE, { home, away }];
/** The serve anchor's own wire shape — `serving` declared alongside `wonBy`,
 *  the umpire's own observation of who served AND who won one rally,
 *  precisely what `serveAnchorSheet`'s `buildPayload` constructs (asserted
 *  directly in the sheets() section below). Kept separate from `rally()`
 *  because an ordinary tap NEVER carries `serving` (this file's own
 *  "never sends serving" test), so a caller reaching for this helper is a
 *  visible, deliberate choice. */
const anchor = (serving: "H" | "A", wonBy: "H" | "A"): readonly [string, unknown] => [
  RALLY_TYPE,
  { wonBy, serving },
];
const expedite = (): readonly [string, unknown] => [EXPEDITE_TYPE, {}];

interface ViewOpts {
  band?: FidelityBand;
  lineups?: LineupPair;
  cfg?: typeof ITTF_CFG;
  events?: EventEnvelope[];
  entitlements?: Record<string, boolean>;
}

/** A `PadHostView` whose `state` is the REAL fold of `events` and whose
 *  `events` is that same ledger — the two halves `setBasedServeContext`
 *  needs. */
function view(opts: ViewOpts = {}): PadHostView {
  const lineups = opts.lineups ?? SINGLES;
  const cfg = opts.cfg ?? ITTF_CFG;
  const events = opts.events ?? stream();
  const state = foldClient(tabletennis, cfg, lineups, events);
  return {
    cfg,
    state,
    summary: {},
    phase: "live",
    band: opts.band ?? 3,
    entitlements: opts.entitlements ?? {},
    personNames: NAMES,
    squads: initSquads(lineups),
    events,
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
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
    squads: initSquads(SINGLES) as SquadState,
    events: [],
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
    ...over,
  };
}

const tileById = (tiles: readonly TileSpec[], id: string): TileSpec | undefined =>
  tiles.find((tile) => tile.id === id);
const stripItem = (v: PadHostView, id: string) => buildScorebug(v, t).strip.find((item) => item.id === id);

// ---------------------------------------------------------------------------
// The engine facts this file restates — pinned EQUAL, never assumed
// ---------------------------------------------------------------------------

describe("the constants this skin restates cannot drift from the engine's own", () => {
  const spec = tabletennis.padSpec!(ITTF_CFG);

  it("EVENT_BAND is padSpec's own `fidelity` map, entry for entry", () => {
    expect(EVENT_BAND).toEqual(spec.fidelity);
  });


  it("SANCTION_LEVELS is the ladder padSpec itself offers, in padSpec's own order", () => {
    // The ITTF umpire has yellow and red only — offering the FIVB's four
    // steps on this pad would put a sanction on screen this federation has
    // no concept of.
    const action = spec.panels.flatMap((panel) => panel.actions).find((entry) => entry.type === SANCTION_TYPE)!;
    const level = action.fields.find((field) => field.path === "level") as { values: readonly string[] };
    expect(SANCTION_LEVELS).toEqual([...level.values]);
    expect(SANCTION_LEVELS).toHaveLength(2);
  });

  it("SUMMARY_TYPE is the FULLY QUALIFIED coarse type, never the preset's bare half", () => {
    expect(SUMMARY_TYPE).toBe("tabletennis.game.summary");
    expect(SUMMARY_TYPE).not.toBe(tabletennis.coarseEventType);
  });

  it("EXPEDITE_RETURNS_THRESHOLD is the ITTF 2.15.2 threshold the REAL fold enforces, at the exact boundary", () => {
    // Restated (the engine's own EXPEDITE_RETURNS is not exported from the
    // barrel this skin is limited to) and pinned against a live fold rather
    // than assumed: a rally crediting the SERVING side their Nth-return win
    // throws `EXPEDITE_WRONG_WINNER` at N=13 and NOT at N=12 — the threshold
    // itself, not merely "some number throws".
    const events = stream(expedite());
    const state = foldClient(tabletennis, ITTF_CFG, SINGLES, events);
    const atThreshold = () =>
      tabletennis.apply(state, ev(2, RALLY_TYPE, { wonBy: "H", serving: "H", returns: EXPEDITE_RETURNS_THRESHOLD }) as never, {
        strict: true,
      });
    const belowThreshold = () =>
      tabletennis.apply(
        state,
        ev(2, RALLY_TYPE, { wonBy: "H", serving: "H", returns: EXPEDITE_RETURNS_THRESHOLD - 1 }) as never,
        { strict: true },
      );
    expect(atThreshold).toThrow(EngineError);
    expect(atThreshold).toThrow(/13/);
    expect(belowThreshold).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// phase() — the five engine phases mapped onto the closed three
// ---------------------------------------------------------------------------

describe("phase()", () => {
  it("is `pre` before core.start", () => {
    expect(resolvePhase(view({ events: [] }))).toBe("pre");
  });

  it("is `live` once the match has started", () => {
    expect(resolvePhase(view())).toBe("live");
  });

  it("is `post` once the match is decided — a real fold, not a typed-in phase", () => {
    const v = view({ cfg: SHORT_CFG, events: stream(summary(3, 1), summary(3, 0)) });
    expect((v.state as { phase: string }).phase).not.toBe("live");
    expect(resolvePhase(v)).toBe("post");
  });

  it("never widens PadPhase past the three UI values", () => {
    for (const v of [view({ events: [] }), view(), view({ cfg: SHORT_CFG, events: stream(summary(3, 1), summary(3, 0)) })]) {
      expect(["pre", "live", "post"]).toContain(resolvePhase(v));
    }
  });
});

// ---------------------------------------------------------------------------
// D-17 — who is serving. `fixed-turns` never self-heals: without the anchor
// tile's declaration, this section's OWN engine fact (kernel.ts) is that
// `believedServer` returns null forever, however many rallies are tapped.
// ---------------------------------------------------------------------------

describe("serving (D-17) — from the engine's ledger reader, never a placeholder", () => {
  it("renders NOTHING before any declaration, however many ordinary rallies are tapped", () => {
    // Unlike badminton (rally-winner self-heals from the very next rally),
    // `fixed-turns` needs the anchor. Ten ordinary taps, no `serving` on any
    // of them, must still show nothing — the exact regression a self-healing
    // assumption borrowed from badminton would ship silently.
    const spec = buildScorebug(view({ events: stream(...Array.from({ length: 10 }, (_, i) => rally(i % 2 === 0 ? "H" : "A"))) }), t);
    expect(spec.strip.map((item) => item.id)).not.toContain("server");
    expect(spec.strip.map((item) => item.id)).not.toContain("serve");
    expect(spec.halves.flatMap((half) => half.who).some((who) => who.serving)).toBe(false);
  });

  it("resolves once the anchor declares it, and walks the WITHIN-GAME rotation both sides, both serve numbers", () => {
    // The anchor: away served, home won. `firstServer = away`.
    const afterAnchor = view({ events: stream(anchor("A", "H")) });
    expect(stripItem(afterAnchor, "server")?.value, "away served the anchor and turnLength is 2 — away serves again").toBe(NAMES.A1);
    expect(stripItem(afterAnchor, "serve")?.value).toBe("pad.tabletennis.scorebug.strip.serve.second");

    // Away wins the second rally too (a plain tap — NO declaration).
    const afterSecond = view({ events: stream(anchor("A", "H"), rally("A")) });
    expect(stripItem(afterSecond, "server")?.value, "turn flips — home's turn now").toBe(NAMES.H1);
    expect(stripItem(afterSecond, "serve")?.value).toBe("pad.tabletennis.scorebug.strip.serve.first");

    // Home wins the third rally.
    const afterThird = view({ events: stream(anchor("A", "H"), rally("A"), rally("H")) });
    expect(stripItem(afterThird, "server")?.value, "still home's turn — their second serve").toBe(NAMES.H1);
    expect(stripItem(afterThird, "serve")?.value).toBe("pad.tabletennis.scorebug.strip.serve.second");
  });

  it("names a PERSON for a doubles pair — ITTF 2.13.4's own service order, unlike badminton", () => {
    const v = view({ lineups: DOUBLES, events: stream(anchor("H", "A")) });
    // `serverFromPairOrder: true` + a declared 2-long pairOrder — the ENGINE
    // itself names the server, pairOrder-1 first.
    expect(stripItem(v, "server")?.value).toBe(NAMES["H-first"]);
    expect(buildScorebug(v, t).halves.flatMap((half) => half.who).some((who) => who.serving)).toBe(true);
  });

  it("follows the serve across a GAME change — setStart:'alternate', a LOSING opener so 'winner serves' cannot masquerade as it", () => {
    // Home serves the anchor AND wins it, then wins every rally to close the
    // game 3-0 (SHORT_CFG). `firstServer = home = the game-1 WINNER`. If
    // this file's own code (or the engine) secretly implemented "winner
    // serves next game" instead of "opponent of the SET'S FIRST SERVER",
    // both readings would agree that home opens game 2 — so this scenario is
    // built precisely so they DISAGREE: alternate predicts AWAY (home's
    // opponent), the wrong rule predicts HOME (the winner). Game 2's opener
    // is therefore a side that LOST game 1's opening exchange's own game.
    const v = view({ cfg: SHORT_CFG, events: stream(anchor("H", "H"), rally("H"), rally("H")) });
    expect((v.state as { sets: unknown[] }).sets.filter((s) => (s as { closed?: boolean }).closed).length).toBe(1);
    expect(stripItem(v, "server")?.value, "ITTF 2.13.6 — the OPPONENT of game 1's first server opens game 2").toBe(NAMES.A1);
    expect(stripItem(v, "server")?.value).not.toBe(NAMES.H1);
    // The turn resets too: game 2's very first serve is away's FIRST, not a
    // carried-over count from game 1.
    expect(stripItem(v, "serve")?.value).toBe("pad.tabletennis.scorebug.strip.serve.first");
  });

  // R5/C2 review finding 3 — the test above defeats "the WINNER serves next",
  // and the reviewer showed it cannot defeat "the LOSER serves next": with the
  // opener also winning game 1, `opponent(firstServer)` and `opponent(winner)`
  // name the same side, so both rules agree and the fixture cannot tell them
  // apart. This is the alternate-vs-winner mutant already on record for this
  // shared kernel. The pair of fixtures together is what closes it — do not
  // delete either one.
  //
  // Here the opener LOSES: home serves the anchor, away wins it and the game.
  //   alternate (correct) -> opponent(firstServer = home) = AWAY
  //   "loser serves next" -> loser = home                 = HOME   (disagrees)
  it("follows the serve across a game the opener LOST — so 'loser serves next' cannot masquerade as alternate either", () => {
    const v = view({ cfg: SHORT_CFG, events: stream(anchor("H", "A"), rally("A"), rally("A")) });
    expect((v.state as { sets: unknown[] }).sets.filter((s) => (s as { closed?: boolean }).closed).length).toBe(1);
    expect(
      stripItem(v, "server")?.value,
      "ITTF 2.13.6 reads the SET'S FIRST SERVER, not the game's winner and not its loser",
    ).toBe(NAMES.A1);
    expect(stripItem(v, "server")?.value).not.toBe(NAMES.H1);
  });

  it("refuses to answer when the ledger and the folded state describe different matches", () => {
    const events = stream(anchor("H", "H"), rally("A"), rally("H"));
    const v = { ...view({ events }), events: events.slice(0, 2) };
    expect(stripItem(v, "server")).toBeUndefined();
  });

  it("relies on ONE engine invariant, and asserts it rather than double-guarding it", () => {
    // A redundant pair of guards (`serveOrderKnown` AND `side===null`) is a
    // pair no mutation can kill — each half silently covers for the other
    // (`reference_redundant_guard_pair_is_mutation_unkillable.md`, paid for
    // on badminton's own equivalent). This file's own `servingInfo` guards
    // on `ctx.side === null` alone; the invariant it relies on is proven
    // here instead, against the real engine, across shapes that hit BOTH
    // branches.
    const shapes: EventEnvelope[][] = [
      [],
      stream(),
      stream(rally("H")),
      stream(anchor("H", "A")),
      stream(summary(11, 7)),
      stream(anchor("H", "A"), rally("A"), rally("A")).slice(0, 3),
    ];
    let sawBoth = 0;
    for (const events of shapes) {
      const v = view({ events });
      const ctx = serveContextOf(v, v.state as Record<string, unknown>);
      if (ctx === null) continue;
      expect(ctx.serveOrderKnown, JSON.stringify(events.map((e) => e.type))).toBe(ctx.side !== null);
      expect(ctx.serveOrderKnown).toBe(ctx.servingSide !== null);
      if (ctx.serveOrderKnown) sawBoth |= 1;
      else sawBoth |= 2;
    }
    expect(sawBoth).toBe(3);
  });

  it("degrades to silence, not a crash, for a pad mounted before any fold", () => {
    const spec = buildScorebug(degenerateView(), t);
    expect(spec.strip.map((item) => item.id)).not.toContain("server");
    expect(assertScorebugSpec(spec)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scorebug — D-11, the deuce/golden-point context, and the tap payload
// ---------------------------------------------------------------------------

describe("scorebug", () => {
  it("states the score ONCE (D-11): the halves carry points, the strip carries GAMES", () => {
    const v = view({ events: stream(summary(11, 7), anchor("H", "H"), rally("H")) });
    const spec = buildScorebug(v, t);
    expect(spec.halves.map((half) => half.big)).toEqual(["2", "0"]);
    expect(stripItem(v, "games")?.value).toBe("1–0");
    const readouts = spec.strip.map((item) => item.value);
    expect(readouts).not.toContain("2");
    expect(assertScorebugSpec(spec)).toEqual([]);
  });

  // Task 8 fix round 2 (review re-review round 1, Important I1(b), ruling
  // R43): closes the parity gap the reviewer's P-series showed — a `side`
  // swap here would otherwise survive the whole v3 scope. Derived from this
  // fixture's own point split (2-0, the test above), never a typed index
  // table.
  it("marks each half with its OWN side — home's half carries HOME's points (kills a side swap)", () => {
    const v = view({ events: stream(summary(11, 7), anchor("H", "H"), rally("H")) });
    const spec = buildScorebug(v, t);
    const home = spec.halves.find((h) => h.side === "home");
    const away = spec.halves.find((h) => h.side === "away");
    expect(home?.big).toBe("2");
    expect(away?.big).toBe("0");
  });

  it("words Deuce off the CFG-DERIVED target, never a hardcoded 10 — hardbat-21 accelerates at 20-all", () => {
    const deuceDefault = view({ events: stream(...Array.from({ length: 20 }, (_, i) => rally(i % 2 === 0 ? "H" : "A"))) });
    expect(buildScorebug(deuceDefault, t).context).toContain("pad.tabletennis.context.deuce");
    const deuceHardbat = view({ cfg: HARDBAT_CFG, events: stream(...Array.from({ length: 40 }, (_, i) => rally(i % 2 === 0 ? "H" : "A"))) });
    expect(buildScorebug(deuceHardbat, t).context).toContain("pad.tabletennis.context.deuce");
    // ...and 10-10 under the HARDBAT cfg must NOT read as deuce — a
    // hardcoded 10 would fire here, where the real target is 21.
    const notYetHardbat = view({ cfg: HARDBAT_CFG, events: stream(...Array.from({ length: 20 }, (_, i) => rally(i % 2 === 0 ? "H" : "A"))) });
    expect(buildScorebug(notYetHardbat, t).context).not.toContain("pad.tabletennis.context.deuce");
    // ...nor does an ordinary score under the default cfg.
    const ordinary = view({ events: stream(rally("H"), rally("A")) });
    expect(buildScorebug(ordinary, t).context).not.toContain("pad.tabletennis.context.deuce");
  });

  it("words Golden point for a custom cfg that sets a cap, generic to any target", () => {
    const capped = tabletennis.configSchema.parse({ cap: 15 });
    const golden = view({ cfg: capped, events: stream(...Array.from({ length: 28 }, (_, i) => rally(i % 2 === 0 ? "H" : "A"))) });
    expect(buildScorebug(golden, t).context).toContain("pad.tabletennis.context.goldenPoint");
  });

  it("names Game N, derived from the closed-set count, not a hand-typed number", () => {
    const g1 = view({ events: stream() });
    expect(buildScorebug(g1, t).context).toContain('"game":1');
    const g2 = view({ cfg: SHORT_CFG, events: stream(summary(3, 1)) });
    expect(buildScorebug(g2, t).context).toContain('"game":2');
  });

  it("spends the LED accent on the serve and nothing else — no strip item asks for the LED panel", () => {
    for (const events of [stream(), stream(anchor("H", "A")), stream(anchor("H", "A"), rally("A"), expedite())]) {
      for (const item of buildScorebug(view({ events }), t).strip) {
        expect(item.tone, `strip item "${item.id}" reaches for the accent`).toBeUndefined();
      }
      const accented = buildScorebug(view({ events }), t).strip.filter((item) => item.accent === true).map((item) => item.id);
      expect(accented.every((id) => id === "server")).toBe(true);
    }
  });

  it("shows Expedite on the strip once introduced, live only, and never before", () => {
    expect(stripItem(view({ events: stream() }), "expedite")).toBeUndefined();
    const v = view({ events: stream(expedite()) });
    expect(stripItem(v, "expedite")?.value).toBe("pad.tabletennis.scorebug.strip.expedite");
    // Match-scoped: still present after a game closes mid-match (2.15.4 runs
    // it to the end of the MATCH, not the game).
    const midMatch = view({ cfg: SHORT_CFG, events: stream(expedite(), summary(3, 1)) });
    expect(stripItem(midMatch, "expedite")?.value).toBeDefined();
  });

  it("halves are tappable at band 3 and INERT below it, with a hint iff tappable", () => {
    const live = buildScorebug(view(), t);
    for (const half of live.halves) {
      expect(half.tappable).toBe(true);
      expect(half.hintKey).toBe("pad.tabletennis.scorebug.rally.hint");
      expect(half.tapEvent?.type).toBe(RALLY_TYPE);
    }
    for (const band of [0, 1, 2] as const) {
      for (const half of buildScorebug(view({ band }), t).halves) {
        expect(half.tappable).toBe(false);
        expect(half.tapEvent).toBeUndefined();
      }
    }
    const done = view({ cfg: SHORT_CFG, events: stream(summary(3, 1), summary(3, 0)) });
    for (const half of buildScorebug(done, t).halves) expect(half.tappable).toBe(false);
  });

  it("stamps the SINGLES scorer and server into the tap itself — R5-2's 'nothing to choose'", () => {
    const v = view({ events: stream(anchor("A", "H")) });
    const [home, away] = buildScorebug(v, t).halves;
    // Away served the anchor rally, so `server` (a PERSON stat field, safe
    // regardless of side) is away's sole player on BOTH halves' next tap.
    expect(home!.tapEvent!.payload).toEqual({ wonBy: "H", server: "A1", scorer: "H1" });
    expect(away!.tapEvent!.payload).toEqual({ wonBy: "A", server: "A1", scorer: "A1" });
  });

  it("never stamps a scorer for a PAIR — not knowable at tap time", () => {
    const v = view({ lineups: DOUBLES, events: stream(anchor("H", "A")) });
    const home = buildScorebug(v, t).halves[0]!;
    expect(home.tapEvent!.payload).toEqual({ wonBy: "H", server: NAMES["H-first"] ? "H-first" : undefined });
  });

  it("never sends `serving` on an ORDINARY tap — it is the umpire's own observation, not ours", () => {
    // Filling it in from `serveContextOf`'s own answer would make
    // `setBasedServeWalk`'s drift detector compare a belief with itself and
    // agree forever — the exact trap that would defeat table tennis's own
    // anchor mechanism's value.
    for (const lineups of [SINGLES, DOUBLES]) {
      const v = view({ lineups, events: stream(anchor("H", "A"), rally("A")) });
      for (const half of buildScorebug(v, t).halves) {
        expect(half.tapEvent!.payload).not.toHaveProperty("serving");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// tiles()
// ---------------------------------------------------------------------------

describe("tiles()", () => {
  it("declares the sanction pair FIRST, then the timeout pair, home column 0 / away column 2 throughout", () => {
    const tiles = buildTiles(view());
    let col = 0;
    const columns = new Map<string, number>();
    for (const tile of tiles) {
      const span = tile.span ?? 1;
      if (col + span > 4) col = 0;
      columns.set(tile.id, col);
      col = (col + span) % 4;
    }
    for (const [key, side] of [
      [sanctionSheetKey("home"), "home"],
      [sanctionSheetKey("away"), "away"],
      [timeoutTileId("home"), "home"],
      [timeoutTileId("away"), "away"],
    ] as const) {
      const tile = tileById(tiles, key)!;
      expect(tile.span, `${key} must own a whole lane`).toBe(2);
      expect(tile.sublabel, `${key} must be side-labelled`).toBeDefined();
      expect(columns.get(key), `${key} (${side})`).toBe(side === "home" ? 0 : 2);
    }
  });

  it("withholds the Set score tile while the current game is being scored rally by rally (D-16)", () => {
    expect(tileById(buildTiles(view()), SET_SCORE_TILE_ID)).toBeDefined();
    const midGame = view({ events: stream(anchor("H", "A")) });
    expect(tileById(buildTiles(midGame), SET_SCORE_TILE_ID)).toBeUndefined();
    const betweenGames = view({ events: stream(summary(11, 7)) });
    expect(tileById(buildTiles(betweenGames), SET_SCORE_TILE_ID)).toBeDefined();
  });

  it("offers Start expedite until introduced, then withdraws it", () => {
    expect(tileById(buildTiles(view()), EXPEDITE_START_TILE_ID)).toBeDefined();
    const started = view({ events: stream(expedite()) });
    expect(tileById(buildTiles(started), EXPEDITE_START_TILE_ID)).toBeUndefined();
  });

  // R5 review finding 3 — ITTF 2.15.1's OWN second clause, which the gate did
  // not carry: the system comes in after ten minutes "unless both players or
  // pairs have scored at least 9 points". Before this, one frictionless tap put
  // a match into expedite from any score at all, 2.15.4 kept it there for the
  // rest of the MATCH, and the only recovery was voiding the event.
  it("withdraws Start expedite once BOTH sides have reached 9 — ITTF 2.15.1's own floor", () => {
    const eight = [...Array<number>(8)].flatMap(() => [rally("H"), rally("A")]);
    const eightAll = view({ events: stream(...eight) });
    expect(tileById(buildTiles(eightAll), EXPEDITE_START_TILE_ID), "8-8: still introducible").toBeDefined();

    const nine = [...Array<number>(9)].flatMap(() => [rally("H"), rally("A")]);
    const nineAll = view({ events: stream(...nine) });
    expect(tileById(buildTiles(nineAll), EXPEDITE_START_TILE_ID), "9-9: the law says no").toBeUndefined();

    // ONE SIDE at 9 is not the floor — the law needs BOTH, and a 9-3 game is
    // exactly the stuck one expedite exists for.
    const lopsided = view({ events: stream(...[...Array<number>(9)].map(() => rally("H"))) });
    expect(tileById(buildTiles(lopsided), EXPEDITE_START_TILE_ID), "9-0: still introducible").toBeDefined();
  });

  it("refuses the same action in the More sheet at 9-all — hiding the tile alone would just move it", () => {
    const nine = [...Array<number>(9)].flatMap(() => [rally("H"), rally("A")]);
    expect(refusedEventTypes(view({ events: stream(...nine) }))).toContain(EXPEDITE_TYPE);
    // ...and a second declaration, which the fold refuses outright.
    expect(refusedEventTypes(view({ events: stream(expedite()) }))).toContain(EXPEDITE_TYPE);
    // Not refused in the ordinary case, or the tile above would be unreachable.
    expect(refusedEventTypes(view())).not.toContain(EXPEDITE_TYPE);
  });

  it("offers the serve anchor exactly while the reader cannot say, and never once it can", () => {
    expect(tileById(buildTiles(view()), SERVE_ANCHOR_TILE_ID), "undeclared — offer it").toBeDefined();
    const resolved = view({ events: stream(anchor("H", "A")) });
    expect(tileById(buildTiles(resolved), SERVE_ANCHOR_TILE_ID), "resolved — gone").toBeUndefined();
    // Below band 3 the rally family is unreachable at all, anchor included.
    expect(tileById(buildTiles(view({ band: 2 })), SERVE_ANCHOR_TILE_ID)).toBeUndefined();
  });

  // R5/C2 review finding 2 — `needsServeAnchor`'s TWO `unknownBecause`
  // exclusions had zero coverage: the reviewer neutered the whole predicate to
  // `return true` and all 73 tests still passed. The behaviour was already
  // correct; nothing was holding it. Both exclusions are pinned here, and the
  // reason each one exists is different, so they are separate tests rather
  // than one loop.
  it("withholds the anchor during a RECORDED DISAGREEMENT — a re-declaration is not what fixes that", () => {
    // Home served and won the anchor, so `turnLength: 2` says home serves
    // rally 2 as well. The umpire's own `serving` on that rally says AWAY, and
    // the engine refuses to re-anchor mid-dispute (R4-7) — the NEXT game
    // resolves it, not another declaration. Offering the tile here would
    // invite the scorer to answer a question that cannot be answered.
    const disputed = view({ events: stream(anchor("H", "H"), rally("H", { serving: "A" })) });
    expect(stripItem(disputed, "server"), "the reader must not name a server mid-dispute").toBeUndefined();
    expect(
      tileById(buildTiles(disputed), SERVE_ANCHOR_TILE_ID),
      "a disputed chain is not an undeclared one — the anchor must stay withheld",
    ).toBeUndefined();
  });

  it("withholds the anchor on a LEDGER MISMATCH — no event of any kind repairs that", () => {
    // The folded state and the ledger describe different matches (state folded
    // from the full stream, `events` truncated). That is structural: a fresh
    // declaration cannot reconcile it, so the tile must not be offered.
    const events = stream(anchor("H", "H"), rally("A"), rally("H"));
    const mismatched = { ...view({ events }), events: events.slice(0, 2) };
    expect(stripItem(mismatched, "server")).toBeUndefined();
    expect(tileById(buildTiles(mismatched), SERVE_ANCHOR_TILE_ID)).toBeUndefined();
  });

  it("declares no tiles outside `live` — every tile names the live phase only", () => {
    for (const tile of buildTiles(view())) expect(tile.phases).toEqual(["live"]);
    expect(buildTiles(view({ events: [] })).filter((tile) => tile.phases.includes("pre"))).toEqual([]);
  });

  it("honours THIS FIXTURE's records flag, not the preset's default", () => {
    // Table tennis defaults timeouts/sanctions/expedite ON and substitutions
    // OFF — the OPPOSITE of badminton's all-off default — so this pins the
    // fixture-cfg reading rather than assuming a shape borrowed from there.
    const noneRecorded = tabletennis.configSchema.parse({
      records: { timeouts: false, sanctions: false, substitutions: false, expedite: false },
    });
    const v = view({ cfg: noneRecorded });
    expect(tileById(buildTiles(v), sanctionSheetKey("home"))).toBeUndefined();
    expect(tileById(buildTiles(v), timeoutTileId("home"))).toBeUndefined();
    expect(tileById(buildTiles(v), EXPEDITE_START_TILE_ID)).toBeUndefined();
    // ...and the inverse: a custom cfg that turns substitutions ON (never
    // shipped, but legal) is honoured too — the tile family this skin does
    // not build one for stays absent regardless, since `SUB_TYPE` has no
    // dedicated tile at all; proven instead via `refusedEventTypes` below.
  });

  it("fires the Timeout tile as a direct event naming the SIDE, no sheet, no `technical` field", () => {
    const tile = tileById(buildTiles(view()), timeoutTileId("away"))!;
    expect(tile.action).toEqual({ event: { type: TIMEOUT_TYPE, payload: { by: "A" } } });
  });
});

// ---------------------------------------------------------------------------
// D-7 — the band-limited screen. Table tennis's own shape DIFFERS from
// badminton's: this kernel's records default ON for timeouts/sanctions/
// expedite, all band 1 (ungated), so a community org keeps THREE drawers
// beside Set score, not badminton's one.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// W1 / Task 4 (entitlements v18) — the D-7 block that stood here is DELETED.
//
// It covered a disabled "Rally by rally is locked" tile and a context slot
// naming the plan that would unlock it. Neither exists: a band is the
// scorer's own pick on the Recording chip now, so there is no lock to word
// and nothing for a skin to explain. The keys those two fed
// (`pad.{sport}.context.recording[.locked]`, `pad.{sport}.tile.rallyLocked
// [.sublabel]`) are gone from all four dictionaries with them.
//
// What replaced the coverage: `v3/__tests__/recording-chip.test.tsx` (the
// picker, and that it never renders a lock, an upsell or a plan name) and
// `e2e/scoring-free.spec.ts` (a free org picking a band on a real pad).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// refusedEventTypes()
// ---------------------------------------------------------------------------

describe("refusedEventTypes()", () => {
  it("refuses the coarse summary exactly while the fold would throw for it", () => {
    expect(refusedEventTypes(view())).not.toContain(SUMMARY_TYPE);
    expect(refusedEventTypes(view({ events: stream(anchor("H", "A")) }))).toContain(SUMMARY_TYPE);
    expect(refusedEventTypes(view({ events: stream(summary(11, 7)) }))).not.toContain(SUMMARY_TYPE);
  });

  it("does NOT refuse timeout or expedite for the DEFAULT ITTF cfg — the opposite of badminton", () => {
    // `records` defaults timeouts/sanctions/expedite ON for this sport;
    // asserting the negative here is the load-bearing half — a refusal
    // list copied from badminton's own (all-refused) shape would fail
    // silently by over-refusing, never by a missing tile.
    const refused = refusedEventTypes(view());
    expect(refused).not.toContain(TIMEOUT_TYPE);
    expect(refused).not.toContain(EXPEDITE_TYPE);
    // `substitutions` DOES default off (the ITTF has no substitute).
    expect(refused).toContain(SUB_TYPE);
  });

  it("does NOT refuse a type this fixture's own cfg says it records, even when the shipped default disagrees", () => {
    const subsOn = tabletennis.configSchema.parse({
      records: { timeouts: true, sanctions: true, substitutions: true, expedite: true },
    });
    expect(refusedEventTypes(view({ cfg: subsOn }))).not.toContain(SUB_TYPE);
    const timeoutsOff = tabletennis.configSchema.parse({
      records: { timeouts: false, sanctions: true, substitutions: false, expedite: true },
    });
    expect(refusedEventTypes(view({ cfg: timeoutsOff }))).toContain(TIMEOUT_TYPE);
  });

  it("keeps the More sheet free of every dead end — the two exclusion sets, together", () => {
    const v = view({ events: stream(anchor("H", "A")) });
    const tiles = buildTiles(v);
    const sheets = buildSheets(v, t);
    const scorebug = buildScorebug(v, t);
    const dedicated = dedicatedEventTypes(tiles, sheets, [], scorebug);
    expect(dedicated).toContain(RALLY_TYPE);
    expect(dedicated).toContain(TIMEOUT_TYPE);
    const actions = moreActions(
      tabletennis.padSpec!(ITTF_CFG),
      { state: v.state, summary: v.summary, phase: "live", band: 3 },
      dedicated,
      new Set(refusedEventTypes(v)),
    );
    expect(actions.map((action) => action.type)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sheets()
// ---------------------------------------------------------------------------

describe("sheets()", () => {
  it("prefills the Set score sheet from the CURRENT game, titled Points, and clamps to the uncapped margin", () => {
    const v = view({ events: stream(summary(11, 7)) });
    const sheet = buildSheets(v, t)[SET_SCORE_TILE_ID]!;
    expect(sheet.event).toBe(SUMMARY_TYPE);
    const [home, away] = sheet.steps;
    expect(home!.title).toBe("pad.tabletennis.sheet.setScore.home.title");
    expect((home as { initial: number }).initial).toBe(0);
    // Uncapped default: setTo(11) + 20 margin.
    expect((home as { max: number }).max).toBe(31);
    expect((away as { max: number }).max).toBe(31);
    expect(sheet.buildPayload({ home: "11", away: "9" })).toEqual({ home: 11, away: 9 });
  });

  it("clamps to a custom cap when the cfg sets one, never the uncapped margin", () => {
    const capped = tabletennis.configSchema.parse({ cap: 15 });
    const sheet = buildSheets(view({ cfg: capped }), t)[SET_SCORE_TILE_ID]!;
    expect((sheet.steps[0] as { max: number }).max).toBe(15);
  });

  it("asks a PAIR who was carded and stamps a SINGLES side's sole player without asking", () => {
    const singles = buildSheets(view(), t)[sanctionSheetKey("home")]!;
    expect(singles.steps.map((step) => step.id)).toEqual(["level"]);
    expect(singles.buildPayload({ level: "warning" })).toEqual({ by: "H", level: "warning", person: "H1" });

    const doubles = buildSheets(view({ lineups: DOUBLES }), t)[sanctionSheetKey("away")]!;
    expect(doubles.steps.map((step) => step.id)).toEqual(["level", "person"]);
    const personStep = doubles.steps[1] as { candidates: readonly string[]; side: string };
    expect(personStep.candidates).toEqual(["A-first", "A-second"]);
    expect(personStep.side).toBe("away");
    expect(doubles.buildPayload({ level: "penalty", person: "A-second" })).toEqual({
      by: "A",
      level: "penalty",
      person: "A-second",
    });
  });

  it("tones the ladder — yellow is a caution, red is the dismissal end", () => {
    const sheet = buildSheets(view(), t)[sanctionSheetKey("home")]!;
    const level = sheet.steps[0] as { options: { id: string; tone?: readonly string[] }[] };
    expect(level.options.map((option) => option.id)).toEqual([...SANCTION_LEVELS]);
    expect(level.options.find((option) => option.id === "warning")!.tone).toEqual(["caution"]);
    expect(level.options.find((option) => option.id === "penalty")!.tone).toEqual(["dismissal"]);
  });

  it("the serve anchor sheet asks BOTH facts independently, and its payload is a REAL rally the fold accepts", () => {
    const sheet = buildSheets(view(), t)[SERVE_ANCHOR_TILE_ID]!;
    expect(sheet.event).toBe(RALLY_TYPE);
    expect(sheet.steps.map((step) => step.id)).toEqual(["serving", "wonBy"]);
    // Server and winner independent — away served, home won.
    const payload = sheet.buildPayload({ serving: "away", wonBy: "home" });
    expect(payload).toEqual({ wonBy: "H", serving: "A", server: "A1", scorer: "H1" });
    // Fed through the REAL fold: proves the payload is genuinely valid, not
    // merely shaped like one.
    const state = foldClient(tabletennis, ITTF_CFG, SINGLES, stream());
    const next = tabletennis.apply(state, ev(1, RALLY_TYPE, payload) as never, { strict: true });
    expect((next as { sets: { home: number; away: number }[] }).sets[0]).toMatchObject({ home: 1, away: 0 });
  });

  it("the serve anchor omits attribution for a PAIR — nobody is nameable from a side alone", () => {
    const sheet = buildSheets(view({ lineups: DOUBLES }), t)[SERVE_ANCHOR_TILE_ID]!;
    const payload = sheet.buildPayload({ serving: "home", wonBy: "away" });
    expect(payload).toEqual({ wonBy: "A", serving: "H" });
  });

  it("every tile that opens a sheet names a sheet this skin actually declares", () => {
    for (const band of [0, 1, 2, 3] as const) {
      const v = view({ band });
      const sheets = buildSheets(v, t);
      for (const tile of buildTiles(v)) {
        if (!("sheet" in tile.action)) continue;
        if (tile.action.sheet.startsWith("__pad-host/")) continue;
        expect(Object.keys(sheets), `tile ${tile.id}`).toContain(tile.action.sheet);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// dock() — R5-2's scorer question, plus table tennis's own expedite recovery
// ---------------------------------------------------------------------------

describe("dock()", () => {
  it("returns nothing for a SINGLES rally with no expedite in force — the scorer was stamped at tap time", () => {
    const v = view({ events: stream(anchor("H", "A")) });
    expect(buildDock(RALLY_TYPE, v, t, { wonBy: "H", scorer: "H1", server: "A1" })).toBeNull();
  });

  it("offers one chip per PAIR member, and the chip's mutate stamps the scorer", () => {
    const v = view({ lineups: DOUBLES, events: stream(anchor("H", "A")) });
    const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "H" })!;
    expect(dock.title).toBe("pad.tabletennis.dock.rally.scorer.title");
    expect(dock.chips.map((chip) => chip.id)).toEqual(["scorer:H-first", "scorer:H-second"]);
    expect(dock.chips.map((chip) => chip.labelText)).toEqual([NAMES["H-first"], NAMES["H-second"]]);
    expect(dock.chips[1]!.mutate({ wonBy: "H" })).toEqual({ wonBy: "H", scorer: "H-second" });
  });

  it("asks the WINNING side's pair, never the loser's", () => {
    const v = view({ lineups: DOUBLES, events: stream(anchor("H", "A")) });
    const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "A" })!;
    expect(dock.chips.map((chip) => chip.id)).toEqual(["scorer:A-first", "scorer:A-second"]);
  });

  // R5/C2 fix — this used to fall through to `null`, so the moment a doubles
  // scorer answered, the whole dock vanished: the confirmation of what they
  // had just chosen AND the "Send now" control that commits before the hold
  // expires. Badminton's dock stays open showing the answer, and a scorer
  // moving between the two pads met two behaviours for one gesture. Found by
  // driving a doubles fixture in a browser, not by any assertion here.
  it("STAYS OPEN once the pair's scorer is settled, showing that answer as the only chip", () => {
    const v = view({ lineups: DOUBLES, events: stream(anchor("H", "A")) });
    const settled = buildDock(RALLY_TYPE, v, t, { wonBy: "H", scorer: "H-second" });
    expect(settled, "an answered dock must not disappear — the flush control lives on it").not.toBeNull();
    expect(settled!.chips).toHaveLength(1);
    expect(settled!.title).toBe("pad.tabletennis.dock.rally.scorer.title");
  });

  // The other side of that branch: SINGLES had nothing to ask, so it has no
  // dock to leave open. Pinned beside its opposite so neither can be "fixed"
  // into the other.
  it("still returns nothing for a settled SINGLES rally — there was never a question", () => {
    const v = view({ events: stream(anchor("H", "A")) });
    expect(buildDock(RALLY_TYPE, v, t, { wonBy: "H", scorer: "H1" })).toBeNull();
  });

  it("offers the 13th-return chip once expedite is in force, for singles AND doubles alike", () => {
    const singles = view({ events: stream(expedite(), anchor("H", "A")) });
    const singlesDock = buildDock(RALLY_TYPE, singles, t, { wonBy: "H", scorer: "H1" })!;
    // UNCHECKED, and the title says so: none of these payloads carries `serving`,
    // so `checkExpedite` cannot compare a receiver and counts the rally in
    // `expediteUnchecked` instead of validating it. The dock used to claim the
    // same "13th return?" either way, which is the one thing
    // DOMAIN.tabletennis.md asks a pad that cannot enforce the rule not to do.
    expect(singlesDock.title).toBe("pad.tabletennis.dock.rally.expedite.unchecked.title");
    expect(singlesDock.chips.map((chip) => chip.id)).toEqual(["expediteReturn"]);
    expect(singlesDock.chips[0]!.mutate({ wonBy: "H" })).toEqual({ wonBy: "H", returns: EXPEDITE_RETURNS_THRESHOLD });
    // Never touches `serving` — the chip's own doc reason: re-deriving the
    // pre-tap serving side here, after the optimistic fold has already
    // advanced past this rally, risks crediting the WRONG winner.
    expect(singlesDock.chips[0]!.mutate({ wonBy: "H" })).not.toHaveProperty("serving");
  });

  it("asks the scorer BEFORE offering the return chip, for a doubles pair under expedite", () => {
    const v = view({ lineups: DOUBLES, events: stream(expedite(), anchor("H", "A")) });
    // Scorer still open — step 1.
    const step1 = buildDock(RALLY_TYPE, v, t, { wonBy: "H" })!;
    expect(step1.title).toBe("pad.tabletennis.dock.rally.scorer.title");
    // Scorer settled — step 2 becomes reachable.
    const step2 = buildDock(RALLY_TYPE, v, t, { wonBy: "H", scorer: "H-second" })!;
    expect(step2.title).toBe("pad.tabletennis.dock.rally.expedite.unchecked.title");
  });

  // R5 review, finding 2 — this test USED to assert `toBeNull()` here, and in
  // doing so it froze a real defect as intended behaviour: the scorer answered
  // the expedite question and the dock, with its "Send now", vanished. It sat
  // two tests below the very "STAYS OPEN" fix it should have been modelled on.
  // The chip stops being OFFERED (step 2 no longer asks), which is what the
  // old title meant; the dock still CONFIRMS the answer.
  it("stops OFFERING the return chip once this rally has flagged one, but keeps CONFIRMING it — singles included", () => {
    const v = view({ events: stream(expedite(), anchor("H", "A")) });
    const settled = buildDock(RALLY_TYPE, v, t, {
      wonBy: "H",
      scorer: "H1",
      returns: EXPEDITE_RETURNS_THRESHOLD,
    })!;
    expect(settled, "a singles scorer answered a real question — the dock must not vanish").not.toBeNull();
    expect(settled.title).toBe("pad.tabletennis.dock.rally.expedite.unchecked.title");
    expect(settled.chips.map((c) => c.id)).toEqual(["expediteReturn"]);
    // No scorer chip: singles never asked that question (`buildHalf` stamps
    // the sole scorer at tap time), so there is nothing of that kind to show.
  });

  it("confirms BOTH answers once a doubles rally under expedite has settled them", () => {
    const v = view({ lineups: DOUBLES, events: stream(expedite(), anchor("H", "A")) });
    const settled = buildDock(RALLY_TYPE, v, t, {
      wonBy: "H",
      scorer: "H-second",
      returns: EXPEDITE_RETURNS_THRESHOLD,
    })!;
    // The scorer chip alone was the whole dock before this fix, so the
    // expedite answer went unconfirmed even in the case the fix was written
    // for.
    expect(settled.chips.map((c) => c.id)).toEqual(["scorer:H-second", "expediteReturn"]);
    expect(settled.title).toBe("pad.tabletennis.dock.rally.expedite.unchecked.title");
  });

  // R5 review finding 1 — THE HIGHEST-HARM DEFECT THIS WAVE FOUND, and it was
  // found by FOLDING the pad's own two outputs together, never by reading
  // either alone. The suite already proved the engine throws
  // `EXPEDITE_WRONG_WINNER` on a server-credited 13-return rally (see the
  // constants block above), and separately proved the dock offers the chip.
  // Nobody had put the two in the same test — so the pad went on offering a
  // chip whose only effect, on a rally the serve anchor said the SERVER won,
  // was to destroy the whole rally: score, serve fact and all, with the sheet
  // closing and nothing on screen to say why.
  it("does NOT offer the 13th-return chip on a rally the SERVER won — the chip would make the fold throw the rally away", () => {
    const events = stream(expedite());
    const v = view({ events });
    // The serve anchor's own shape: home served, home won.
    const served = { wonBy: "H", serving: "H", scorer: "H1" };
    expect(buildDock(RALLY_TYPE, v, t, served)).toBeNull();

    // And that refusal is not squeamishness — this is what the chip WOULD have
    // produced, folded against the real engine.
    const state = foldClient(tabletennis, ITTF_CFG, SINGLES, events);
    const stamped = { ...served, returns: EXPEDITE_RETURNS_THRESHOLD };
    expect(() => tabletennis.apply(state, ev(2, RALLY_TYPE, stamped) as never, { strict: true })).toThrow(EngineError);
  });

  it("DOES offer it when the RECEIVER won, and titles it as CHECKED — the one shape ITTF 2.15.4 describes", () => {
    const events = stream(expedite());
    const v = view({ events });
    const received = { wonBy: "A", serving: "H", scorer: "A1" };
    const dock = buildDock(RALLY_TYPE, v, t, received)!;
    expect(dock.title).toBe("pad.tabletennis.dock.rally.expedite.title");
    expect(dock.chips.map((chip) => chip.id)).toEqual(["expediteReturn"]);
    // The answer the pad offers is one the fold ACCEPTS. Same pairing as the
    // test above, opposite verdict — neither can be "fixed" into the other.
    const state = foldClient(tabletennis, ITTF_CFG, SINGLES, events);
    const stamped = dock.chips[0]!.mutate(received);
    expect(() => tabletennis.apply(state, ev(2, RALLY_TYPE, stamped) as never, { strict: true })).not.toThrow();
  });

  it("still shows NO dock at all when a singles rally was never asked anything", () => {
    // The one genuine null: no expedite, and a singles side whose sole scorer
    // was stamped at tap time. Nothing was asked, so there is nothing to keep
    // open — this is the case the pair test legitimately guards.
    const v = view({ events: stream(anchor("H", "A")) });
    expect(buildDock(RALLY_TYPE, v, t, { wonBy: "H", scorer: "H1" })).toBeNull();
  });

  it("declines every other event type outright", () => {
    const v = view({ lineups: DOUBLES });
    for (const type of [SUMMARY_TYPE, SANCTION_TYPE, TIMEOUT_TYPE, EXPEDITE_TYPE, "core.start"]) {
      expect(buildDock(type, v, t, {})).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half
// ---------------------------------------------------------------------------

describe("activityDetail()", () => {
  const ctx = (eventType: string, payload: Record<string, unknown>, state?: unknown) => ({
    t,
    eventType,
    payload,
    personNames: NAMES,
    state,
  });
  const FOLDED = foldClient(tabletennis, ITTF_CFG, SINGLES, stream());

  it("distinguishes two rallies of the same type by who scored them, and flags a 13th-return win", () => {
    expect(tabletennisDetail(ctx(RALLY_TYPE, { wonBy: "H", scorer: "H-first" }))).toBe(NAMES["H-first"]);
    expect(tabletennisDetail(ctx(RALLY_TYPE, { wonBy: "H", scorer: "H-second", server: "A-first" }))).toBe(
      `${NAMES["H-second"]} · ${NAMES["A-first"]}`,
    );
    expect(
      tabletennisDetail(ctx(RALLY_TYPE, { wonBy: "H", scorer: "H1", server: "A1", returns: EXPEDITE_RETURNS_THRESHOLD })),
    ).toBe(`${NAMES.H1} · ${NAMES.A1} · pad.tabletennis.ribbon.expediteReturn`);
    // Below the threshold: no flag.
    expect(tabletennisDetail(ctx(RALLY_TYPE, { wonBy: "H", scorer: "H1", returns: EXPEDITE_RETURNS_THRESHOLD - 1 }))).toBe(
      NAMES.H1,
    );
    // No state to resolve `wonBy` against: nothing can be said.
    expect(tabletennisDetail(ctx(RALLY_TYPE, { wonBy: "H" }))).toBeUndefined();
  });

  it("names the winning SIDE when nobody was attributed, so two rallies are never the same row", () => {
    expect(tabletennisDetail(ctx(RALLY_TYPE, { wonBy: "H" }, FOLDED))).toBe("scorepad.attribution.home");
    expect(tabletennisDetail(ctx(RALLY_TYPE, { wonBy: "A" }, FOLDED))).toBe("scorepad.attribution.away");
    // The expedite flag rides along, since it alone cannot tell two rows apart.
    expect(
      tabletennisDetail(ctx(RALLY_TYPE, { wonBy: "H", returns: EXPEDITE_RETURNS_THRESHOLD }, FOLDED)),
    ).toBe("scorepad.attribution.home · pad.tabletennis.ribbon.expediteReturn");
    // A named person still wins: it is the more specific fact.
    expect(tabletennisDetail(ctx(RALLY_TYPE, { wonBy: "H", scorer: "H1" }, FOLDED))).toBe(NAMES.H1);
  });

  it("reads a summary as its score, and flags a partial one", () => {
    expect(tabletennisDetail(ctx(SUMMARY_TYPE, { home: 11, away: 7 }))).toBe("11–7");
    expect(tabletennisDetail(ctx(SUMMARY_TYPE, { home: 8, away: 6, partial: true }))).toBe(
      "8–6 · pad.tabletennis.ribbon.partial",
    );
  });

  it("words a sanction by its level, through the shared enum vocabulary", () => {
    expect(tabletennisDetail(ctx(SANCTION_TYPE, { by: "H", level: "warning", person: "H1" }))).toBe(
      `sanction.warning · ${NAMES.H1}`,
    );
  });

  it("names the SIDE for a timeout, resolved through ctx.state — the payload alone only has an entrant id", () => {
    expect(tabletennisDetail(ctx(TIMEOUT_TYPE, { by: "H" }, FOLDED))).toBe("scorepad.attribution.home");
    expect(tabletennisDetail(ctx(TIMEOUT_TYPE, { by: "A" }, FOLDED))).toBe("scorepad.attribution.away");
    // No state at all: cannot resolve, falls to the bare ribbon caption.
    expect(tabletennisDetail(ctx(TIMEOUT_TYPE, { by: "H" }))).toBeUndefined();
  });

  it("adds nothing for a type it has no vocabulary for", () => {
    expect(tabletennisDetail(ctx("core.start", {}))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FACTORY WIRING — the mutation-provable block this skin's header promises
// ---------------------------------------------------------------------------

describe("factory wiring — every builder is threaded the REAL translator", () => {
  const XLATE: TFn = (key, vars) => `XLATED:${key}${vars ? JSON.stringify(vars) : ""}`;
  const skin = tabletennisSkinV3(XLATE);

  it("identifies as tabletennis, tap model S", () => {
    expect(skin.key).toBe("tabletennis");
    expect(skin.tapModel).toBe("S");
  });

  it("threads it into the scorebug — context, strip labels, serving label and hints", () => {
    const spec = skin.scorebug(view({ events: stream(anchor("H", "A")) }));
    expect(spec.context.startsWith("XLATED:")).toBe(true);
    for (const item of spec.strip) {
      if (item.label !== undefined) expect(item.label.startsWith("XLATED:")).toBe(true);
      if (item.value !== undefined && ["expedite", "server"].includes(item.id ?? "")) {
        // value may be a name (never XLATED) or a translated fallback label —
        // not asserted here; label coverage above is the real proof.
      }
    }
    const serving = spec.halves.flatMap((half) => half.who).find((who) => who.serving);
    expect(serving!.servingLabel!.startsWith("XLATED:")).toBe(true);
  });


  // R7 follow-ups item 3 (`TileSpec.label`/`SheetChoiceStep.title` typed
  // `MessageKey`) found the OPPOSITE bug to the one this block's header
  // warns about: these sheets used to pre-resolve `title` through `t()`
  // THEMSELVES, and `guided-sheet.tsx`'s own render functions call
  // `t(step.title)` again unconditionally — a real translator looks up the
  // now-English STRING as a key, misses, and logs
  // `[i18n] missing key: <resolved text>` on every render (proved directly
  // against badminton's identical pattern). The fallback happens to echo the
  // string back unchanged, so the screen was never wrong — only the console.
  // Titles now stay raw, like every other v3 skin's, so the downstream
  // `t()` call is the ONLY resolution.
  it("does NOT pre-resolve the sheets' titles — they stay raw MessageKeys for guided-sheet.tsx's own t() to resolve", () => {
    const sheets = skin.sheets!(view());
    for (const sheet of Object.values(sheets)) {
      for (const step of sheet.steps) {
        expect(step.title.startsWith("XLATED:"), `${step.id}'s title must not be pre-resolved`).toBe(false);
        expect(step.title.startsWith("pad.tabletennis.")).toBe(true);
      }
    }
  });

  it("threads it into the dock's title", () => {
    const dock = skin.dock(RALLY_TYPE, view({ lineups: DOUBLES, events: stream(anchor("H", "A")) }), { wonBy: "H" })!;
    expect(dock.title.startsWith("XLATED:")).toBe(true);
  });


  it("declares no swap() and no contextSelect()", () => {
    expect(skin.swap).toBeUndefined();
    expect(skin.contextSelect).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// COPY TRUTH — a key used only inside a returned SPEC has NO other gate
// ---------------------------------------------------------------------------

describe("copy truth", () => {
  function collectLabelKeys(): Set<string> {
    const keys = new Set<string>();
    for (const key of [
      "pad.tabletennis.context.line",
      "pad.tabletennis.context.deuce",
      "pad.tabletennis.context.goldenPoint",
      "pad.tabletennis.scorebug.serving",
      "pad.tabletennis.scorebug.strip.games",
      "pad.tabletennis.scorebug.strip.server",
      "pad.tabletennis.scorebug.strip.serve.first",
      "pad.tabletennis.scorebug.strip.serve.second",
      "pad.tabletennis.scorebug.strip.expedite",
      "pad.tabletennis.dock.rally.scorer.title",
      "pad.tabletennis.dock.rally.expedite.title",
      "pad.tabletennis.dock.rally.expedite.unchecked.title",
      "pad.tabletennis.dock.rally.expedite.chip",
      "pad.tabletennis.dock.person",
      "pad.tabletennis.ribbon.partial",
      "pad.tabletennis.ribbon.expediteReturn",
    ]) {
      keys.add(key);
    }
    const sweep: { band: FidelityBand; events: EventEnvelope[]; lineups: LineupPair }[] = [
      { band: 0, events: stream(), lineups: SINGLES },
      { band: 1, events: stream(anchor("H", "A")), lineups: SINGLES },
      { band: 2, events: stream(summary(11, 7)), lineups: DOUBLES },
      { band: 3, events: stream(expedite(), anchor("H", "A")), lineups: DOUBLES },
    ];
    for (const { band, events, lineups } of sweep) {
      const v = view({ band, events, lineups });
      for (const tile of buildTiles(v)) {
        keys.add(tile.label);
        if (tile.sublabel !== undefined) keys.add(tile.sublabel);
      }
      for (const sheet of Object.values(buildSheets(v, t))) {
        for (const step of sheet.steps) {
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
      const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "H" });
      for (const chip of dock?.chips ?? []) keys.add(chip.label);
      const dockExpedite = buildDock(RALLY_TYPE, v, t, { wonBy: "H", scorer: "H1" });
      for (const chip of dockExpedite?.chips ?? []) keys.add(chip.label);
    }
    return keys;
  }

  it("every key this skin's specs reference exists in the English dictionary", () => {
    const dict = uiEn as Record<string, string>;
    const missing = [...collectLabelKeys()].filter((key) => !(key in dict)).sort();
    expect(missing).toEqual([]);
  });

  it("collects a non-trivial set — a walk that found nothing would pass the check above vacuously", () => {
    expect(collectLabelKeys().size).toBeGreaterThan(15);
  });

  // FOUND BY A 320px SCREENSHOT on badminton, NOT BY ITS UNIT TESTS —
  // `ScorebugHalf.hintKey` and the ribbon's per-event copy do NOT resolve
  // through a bare `t()`. Both go through `padLabel()`, which checks
  // `PAD_LABEL_KEYS` MEMBERSHIP first and falls back to printing the raw
  // dotted key when the key is not in that list.
  it("every hintKey the scorebug emits is REGISTERED in PAD_LABEL_KEYS, not merely translated", () => {
    const registered = new Set<string>(PAD_LABEL_KEYS);
    const hints = new Set<string>();
    for (const band of [0, 1, 2, 3] as const) {
      for (const half of buildScorebug(view({ band, events: stream(anchor("H", "A")) }), t).halves) {
        if (half.hintKey !== undefined) hints.add(half.hintKey);
      }
    }
    expect(hints.size).toBeGreaterThan(0);
    for (const key of hints) {
      expect(registered.has(key), `${key} is not in PAD_LABEL_KEYS — padLabel() will print the raw key`).toBe(true);
    }
  });

  it("every event type this skin dispatches through a dedicated tile has a REGISTERED ribbon key", () => {
    const registered = new Set<string>(PAD_LABEL_KEYS);
    // FIVE of the six kernel-union types — every one this skin builds a
    // dedicated tile or tapModel-S half for. `sub` is deliberately absent:
    // no tile exists for it at all, so it stays on the generic fallback.
    for (const type of [RALLY_TYPE, SUMMARY_TYPE, SANCTION_TYPE, TIMEOUT_TYPE, EXPEDITE_TYPE]) {
      const key = ribbonKeyFor(type);
      expect(registered.has(key), `${key} is not in PAD_LABEL_KEYS — the ribbon stays on the fallback`).toBe(true);
      expect(key in (uiEn as Record<string, string>), `${key} has no English copy`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// R8/#676 — the strip's WIDTH across a serve-reader refusal (badminton's own
// block, ported: fix round 1 shipped this contract for badminton ONLY, and two
// mutants survived here for want of it).
// ---------------------------------------------------------------------------

/** The `serverOverride` shape — `state` folded from one ledger, `events` from
 *  another. What a genuinely diverged pad actually looks like, rather than a
 *  fixture hand-edited into disagreeing with itself. */
function divergedView(opts: ViewOpts = {}): PadHostView {
  const lineups = opts.lineups ?? SINGLES;
  const cfg = opts.cfg ?? ITTF_CFG;
  const localEvents = opts.events ?? stream(anchor("A", "H"), rally("H"));
  const serverEvents = [...localEvents, ev(localEvents.length, RALLY_TYPE, { wonBy: "A" })];
  return { ...view({ ...opts, events: localEvents }), state: foldClient(tabletennis, cfg, lineups, serverEvents) };
}

describe("R8/#676 — table tennis holds its strip's shape across a refusal", () => {
  it("the diverged view really is a DRIFT refusal", () => {
    const v = divergedView();
    expect(serveContextOf(v, v.state as never)?.unknownBecause).toBe("ledger-mismatch");
  });

  it("an ANSWERED strip really does carry `serve` — so reserving it is not a phantom slot", () => {
    // Pins the premise the unconditional reserved `serve` slot rests on:
    // tabletennis.ts declares `within: "fixed-turns"` unconditionally, so the
    // kernel populates serveNumber for every complete chain. If that preset
    // ever changes, this reds instead of the slot silently becoming a phantom.
    const spec = buildScorebug(view({ events: stream(anchor("A", "H"), rally("H")) }), t);
    expect(spec.strip.map((i) => i.id)).toContain("serve");
  });

  it("holds BOTH serve-derived slots open, valueless and unlocatable", () => {
    const spec = buildScorebug(divergedView(), t);
    expect(spec.strip.map((i) => i.id)).not.toContain("server");
    expect(spec.strip.map((i) => i.id)).not.toContain("serve");
    const reserved = spec.strip.filter((i) => i.reserved === true);
    expect(reserved).toHaveLength(2);
    for (const slot of reserved) {
      expect(slot.value).toBe("");
      expect(slot.id).toBeUndefined();
      expect(slot.reserve?.length).toBeGreaterThan(0);
    }
    expect(assertScorebugSpec(spec)).toEqual([]);
  });

  it("reserves the SAME width answered as refused", () => {
    const answered = buildScorebug(view({ events: stream(anchor("A", "H"), rally("H")) }), t);
    const refused = buildScorebug(divergedView(), t);
    const aServer = answered.strip.find((i) => i.id === "server");
    const aServe = answered.strip.find((i) => i.id === "serve");
    expect(aServer?.value).toBeTruthy();
    const held = refused.strip.filter((i) => i.reserved === true);
    expect(held[0]?.reserve).toEqual(aServer?.reserve);
    expect(held[1]?.reserve).toEqual(aServe?.reserve);
    // The kill for the mutant that survived round 1: an answered slot that
    // stops reserving renders narrower than its own reserved twin.
    expect(aServer?.reserve, "the answered server slot must reserve").toBeDefined();
    expect(aServer?.reserve).toContain(aServer?.value);
    expect(aServe?.reserve).toContain(aServe?.value);
  });

  it("the reservation is the value SPACE, not the current value", () => {
    const h = buildScorebug(view({ events: stream(anchor("A", "H")) }), t).strip.find((i) => i.id === "server");
    const a = buildScorebug(view({ events: stream(anchor("H", "A")) }), t).strip.find((i) => i.id === "server");
    expect(h?.reserve).toEqual(a?.reserve);
    expect(h?.reserve).toContain(h?.value);
    expect(h?.reserve).toContain(a?.value);
  });

  it("reserves nothing before the first rally — absence is not drift", () => {
    const spec = buildScorebug(view({ events: stream() }), t);
    expect(spec.strip.some((i) => i.reserved === true)).toBe(false);
  });
});
