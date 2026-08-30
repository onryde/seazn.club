// R5/C3 — volleyball SkinDefV3. Pure-data assertions (apps/web vitest is
// `environment: "node"`, no jsdom): the skin is a spec BUILDER, so this file
// asserts the specs it returns and leaves the DOM to
// `e2e/scorepad-v3-volleyball.spec.ts`.
//
// EVERY STATE HERE COMES OUT OF THE REAL FOLD. `foldClient(volleyball, ...)`
// over real `EventEnvelope`s, never a hand-typed state literal — three suites
// in this programme have shipped false-green by mirroring the skin's own
// reading of a state shape back at it, and the serve reader in particular
// (`setBasedServeContext`, R5-1) is a walk over the LEDGER whose answer a
// hand-written `{sets: [...]}` cannot reproduce at all.
//
// `view()`'s `squads` field is `squadStateOf(state, lineups)` — the SAME
// fallback `pad-host.tsx` computes (`state.squads ?? initSquads(lineups)`) —
// deliberately NOT the badminton/table-tennis siblings' own simplification of
// always `initSquads(lineups)`. That shortcut is harmless for them (neither
// sport ever changes its squad — no swap()), but this file's own libero tests
// need to see a REAL post-replacement squad, and `initSquads(lineups)`
// unconditionally would silently show the pristine team sheet forever, no
// matter what lineup events the fixture's own event stream folds — an inert
// seam a green suite would never catch.
import { describe, expect, it } from "vitest";
import uiEn from "@/dictionaries/en/ui.json";
import { PAD_LABEL_KEYS } from "@/lib/scoring-vocab";
import { ribbonKeyFor } from "../../ribbon";
import type { EventEnvelope, Lineup, LineupPair, LineupPolicy, SquadMember } from "@seazn/engine/core";
import { memberOf, reduceLineupEvent } from "@seazn/engine/core";
import type { FidelityBand, ModuleEvent } from "@seazn/engine/sport";
import { makeEnvelope } from "@seazn/engine/testkit";
import { volleyball } from "@seazn/engine/sports/setbased";
import { foldClient } from "../../../module-client";
import { assertDisabledTilesExplained } from "../../tile-grid";
import { assertScorebugSpec, type PadHostView, type TileSpec } from "../../types";
import { dedicatedEventTypes, filterTilesByBand, moreActions, squadStateOf } from "../../pad-host";
import {
  EVENT_BAND,
  EXPEDITE_TYPE,
  LIBERO_TYPE,
  RALLY_ENTITLEMENT,
  RALLY_LOCKED_TILE_ID,
  RALLY_TYPE,
  SANCTION_LEVELS,
  SANCTION_TYPE,
  SERVE_ANCHOR_TILE_ID,
  SET_SCORE_TILE_ID,
  SUB_TYPE,
  SUMMARY_TYPE,
  TIMEOUT_TYPE,
  buildContextStrip,
  buildDock,
  buildScorebug,
  buildSheets,
  openerSheetKey,
  buildSwap,
  buildTiles,
  liberoSwapSlotId,
  refusedEventTypes,
  resolvePhase,
  sanctionSheetKey,
  serveContextOf,
  timeoutTileId,
  volleyballDetail,
  volleyballSkinV3,
} from "../volleyball";
import type { TFn } from "../volleyball";

// ---------------------------------------------------------------------------
// Fixtures — the fold, and nothing but the fold
// ---------------------------------------------------------------------------

/** The oracle `t`. It ECHOES ITS INPUT, including the vars, so an assertion on
 *  a built string cannot pass by coincidence when a branch resolves the WRONG
 *  key — ribbon.test.ts's own "the oracle MUST discriminate by its input"
 *  lesson. */
const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

const NAMES: Record<string, string> = {
  "H-p1": "Home Setter", "H-p2": "Home OH1", "H-p3": "Home MB1", "H-p4": "Home OPP",
  "H-p5": "Home OH2", "H-p6": "Home MB2", "H-lib": "Home Libero", "H-b2": "Home Bench",
  "A-p1": "Away Setter", "A-p2": "Away OH1", "A-p3": "Away MB1", "A-p4": "Away OPP",
  "A-p5": "Away OH2", "A-p6": "Away MB2", "A-lib": "Away Libero", "A-b2": "Away Bench",
  "H-first": "Home First", "H-second": "Home Second", "A-first": "Away First", "A-second": "Away Second",
};

const COURT = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;

/** An indoor team sheet: six starters plus a two-person bench, the FIRST
 *  bench slot named as a LIBERO (`roles: ["libero"]`) — FIVB's own catalog
 *  shape. Mirrors `setbased/lineup.test.ts`'s own `volleyballSide` (a skin's
 *  unit tests build their own fixtures rather than importing another
 *  package's test helper). */
function teamSide(entrantId: string): Lineup {
  const starters = COURT.map((positionKey, i) => ({
    personId: `${entrantId}-p${i + 1}`,
    positionKey,
    slot: "starting" as const,
    orderNo: i + 1,
  }));
  const bench = [
    { personId: `${entrantId}-lib`, slot: "bench" as const, orderNo: 7, roles: ["libero"] },
    { personId: `${entrantId}-b2`, slot: "bench" as const, orderNo: 8 },
  ];
  return { entrantId, slots: [...starters, ...bench] };
}

/** A team sheet with NO libero named anywhere — the "this side never used
 *  one" fixture the atomic-tile-pair test needs. */
function teamSideNoLibero(entrantId: string): Lineup {
  const starters = COURT.map((positionKey, i) => ({
    personId: `${entrantId}-p${i + 1}`,
    positionKey,
    slot: "starting" as const,
    orderNo: i + 1,
  }));
  return { entrantId, slots: [...starters, { personId: `${entrantId}-b2`, slot: "bench" as const, orderNo: 8 }] };
}

/** A beach pair team sheet — two named players, first-named first.
 *  `orderNo` runs the OTHER WAY from `pairOrder` — the same trap
 *  `setbased/lineup.test.ts`'s own `pairSide` sets — so a reader that
 *  quietly sorted by `orderNo` names the wrong player and this file
 *  notices. */
function pairSide(entrantId: string, first: string, second: string): Lineup {
  return {
    entrantId,
    slots: [
      { personId: second, slot: "starting", orderNo: 1, pairOrder: 2 },
      { personId: first, slot: "starting", orderNo: 2, pairOrder: 1 },
    ],
  };
}

const TEAM: LineupPair = { home: teamSide("H"), away: teamSide("A") };
const TEAM_HOME_LIBERO_ONLY: LineupPair = { home: teamSide("H"), away: teamSideNoLibero("A") };
const PAIR: LineupPair = {
  home: pairSide("H", "H-first", "H-second"),
  away: pairSide("A", "A-first", "A-second"),
};
/** The MIRROR of `PAIR` — pairOrder swapped, so a test that sweeps both
 *  directions cannot pass by a reader that quietly ignores `pairOrder`. */
const PAIR_SWAPPED: LineupPair = {
  home: pairSide("H", "H-second", "H-first"),
  away: pairSide("A", "A-second", "A-first"),
};

const VB_CFG = volleyball.configSchema.parse({});
/** The `beach` variant's own declared override object
 *  (`setbased/volleyball.ts`), parsed directly rather than resolved through a
 *  variant key — `records.substitutions: false` is the one field this file's
 *  own rotation tests need. */
const BEACH_CFG = volleyball.configSchema.parse({
  bestOf: 3,
  setTo: 21,
  finalSetTo: 15,
  records: { timeouts: true, sanctions: true, substitutions: false, expedite: false },
});
/** A legal SHORT config — sets to 3, cap 5 — for a test that needs a whole
 *  set (or several) played out rally by rally without writing 25 events. */
const SHORT_CFG = volleyball.configSchema.parse({ setTo: 3, finalSetTo: 3, cap: 5 });

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

/** THREE set summaries, home straight — volleyball's own `bestOf` DEFAULTS TO
 *  5 (badminton's is 3, which is why the identical two-summary shape in that
 *  sibling's own tests decides a match and this sport's own copy of it must
 *  not): "best of 5" is FIRST TO THREE SET WINS, so two summaries (one win
 *  each) leaves the match very much undecided — three straight home wins is
 *  the shortest real path to a decision. */
const DECIDED = [summary(3, 1), summary(3, 1), summary(3, 1)] as const;

/** A libero exchange event, either direction — `off`/`on` name whoever is
 *  leaving/arriving, and `positionKey` is whatever position the ARRIVING
 *  player is taking, matching the test's own bookkeeping (never read by this
 *  helper — it is the skin's own `buildLiberoEvent` that derives it for
 *  real, proven separately below). */
const liberoSwap = (
  side: "H" | "A",
  off: string,
  on: string,
  positionKey: string,
  onRoles?: readonly string[],
): readonly [string, unknown] => [
  LIBERO_TYPE,
  {
    side,
    off,
    on: { personId: on, positionKey, slot: "starting", orderNo: 7, ...(onRoles ? { roles: onRoles } : {}) },
    exemption: "libero",
  },
];

interface ViewOpts {
  band?: FidelityBand;
  lineups?: LineupPair;
  cfg?: typeof VB_CFG;
  events?: EventEnvelope[];
  entitlements?: Record<string, boolean>;
}

/** A `PadHostView` whose `state` is the REAL fold of `events` and whose
 *  `events`/`squads` describe that SAME match — see this file's header for
 *  why `squads` is `squadStateOf(state, lineups)` rather than the siblings'
 *  own always-`initSquads` shortcut. */
function view(opts: ViewOpts = {}): PadHostView {
  const lineups = opts.lineups ?? TEAM;
  const cfg = opts.cfg ?? VB_CFG;
  const events = opts.events ?? stream();
  const state = foldClient(volleyball, cfg, lineups, events);
  return {
    cfg,
    state,
    summary: {},
    phase: "live",
    band: opts.band ?? 3,
    entitlements: opts.entitlements ?? { [RALLY_ENTITLEMENT]: true },
    personNames: NAMES,
    squads: squadStateOf(state, lineups),
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
    squads: squadStateOf({}, TEAM),
    events: [],
    contextOverrides: {},
    ...over,
  };
}

const tileById = (tiles: readonly TileSpec[], id: string): TileSpec | undefined =>
  tiles.find((tile) => tile.id === id);
const stripItem = (v: PadHostView, id: string) => buildScorebug(v, t).strip.find((item) => item.id === id);
/** Non-null by construction: every fixture in this file except
 *  `degenerateView()` (asserted separately, via `serveContextOf` directly)
 *  has a real, parsed `cfg.records`, so `serveContextOf` never actually
 *  returns `null` for any of them — the assertion is what lets every other
 *  call site read `.side`/`.rotation`/`.serverPersonId` directly rather than
 *  re-narrowing `| null` at every one. */
const ctxOf = (v: PadHostView) => serveContextOf(v, v.state as Record<string, unknown>)!;

// ---------------------------------------------------------------------------
// The engine facts this file restates — pinned EQUAL, never assumed
// ---------------------------------------------------------------------------

describe("the constants this skin restates cannot drift from the engine's own", () => {
  const spec = volleyball.padSpec!(VB_CFG);

  it("EVENT_BAND is padSpec's own `fidelity` map, entry for entry", () => {
    expect(EVENT_BAND).toEqual(spec.fidelity);
  });

  it("LIBERO_TYPE (core.lineup.replacement) carries no padSpec.fidelity entry for any sport — the band filter fails OPEN for it by design", () => {
    expect(spec.fidelity[LIBERO_TYPE]).toBeUndefined();
  });

  it("RALLY_ENTITLEMENT is the feature key padSpec gates band 3 behind", () => {
    expect(spec.fidelityEntitlements[3]).toBe(RALLY_ENTITLEMENT);
  });

  it("SANCTION_LEVELS is the ladder padSpec itself offers, in padSpec's own order", () => {
    const action = spec.panels.flatMap((panel) => panel.actions).find((entry) => entry.type === SANCTION_TYPE)!;
    const level = action.fields.find((field) => field.path === "level") as { values: readonly string[] };
    expect(SANCTION_LEVELS).toEqual([...level.values]);
  });

  it("SUMMARY_TYPE is the FULLY QUALIFIED coarse type — volleyball's OWN 'set.summary', never badminton's 'game.summary'", () => {
    expect(SUMMARY_TYPE).toBe("volleyball.set.summary");
    expect(SUMMARY_TYPE).not.toBe(volleyball.coarseEventType);
  });

  it("volleyball.lineupPolicy() declares the libero exemption — the fact this file's swap() is built on", () => {
    const policy = volleyball.lineupPolicy!(VB_CFG);
    expect(policy.reentry).toBe("once");
    expect(policy.reentryPositionLock).toBe(true);
    expect(policy.exemptions?.libero).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// phase()
// ---------------------------------------------------------------------------

describe("phase()", () => {
  it("is `pre` before core.start", () => {
    expect(resolvePhase(view({ events: [] }))).toBe("pre");
  });

  it("is `live` once the match has started", () => {
    expect(resolvePhase(view())).toBe("live");
  });

  it("is `post` once the match is decided — a real fold, not a typed-in phase", () => {
    const v = view({ cfg: SHORT_CFG, events: stream(...DECIDED) });
    expect((v.state as { phase: string }).phase).not.toBe("live");
    expect(resolvePhase(v)).toBe("post");
  });
});

// ---------------------------------------------------------------------------
// buildScorebug() — the half carries the SIDE, never the roster
// ---------------------------------------------------------------------------

describe("buildScorebug() — the half never shows a player, only the side", () => {
  it("both halves are the SIDE label, both sides — never a name, never six of them", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.halves[0]!.who).toEqual([{ name: "scorepad.attribution.home" }]);
    expect(spec.halves[1]!.who).toEqual([{ name: "scorepad.attribution.away" }]);
    expect(assertScorebugSpec(spec)).toEqual([]);
  });

  it("never marks a half `serving` — the serve is a STRIP fact for this sport", () => {
    const spec = buildScorebug(view({ events: stream(rally("H")) }), t);
    for (const half of spec.halves) for (const who of half.who) expect(who.serving).toBeUndefined();
  });

  it("context reads 'Best of N · Set M', volleyball's own word — never 'Game'", () => {
    expect(buildScorebug(view(), t).context).toBe("pad.volleyball.context.line({\"bestOf\":5,\"set\":1})");
  });

  it("names the SET a summary just opened, both directions", () => {
    const v = view({ events: stream(summary(25, 20)) });
    expect(buildScorebug(v, t).context).toContain('"set":2');
  });

  it("flags deuce one short of the set's own target, derived not hardcoded — 24 for a 25-point set", () => {
    const v = view({ cfg: SHORT_CFG, events: stream(rally("H"), rally("H"), rally("A"), rally("A")) });
    // SHORT_CFG's set target is 3: tied at 2-2 is one short of 3.
    expect(buildScorebug(v, t).context).toContain("pad.volleyball.context.deuce");
  });

  it("flags golden point at cap-1 for a CUSTOM capped cfg — volleyball ships uncapped, but the schema allows one", () => {
    const capped = volleyball.configSchema.parse({ setTo: 5, finalSetTo: 5, cap: 7 });
    // Tied 6-6 (cap-1) — 6 rallies each, alternating.
    const v = view({ cfg: capped, events: stream(...Array.from({ length: 12 }, (_, i) => rally(i % 2 === 0 ? "H" : "A"))) });
    expect(buildScorebug(v, t).context).toContain("pad.volleyball.context.goldenPoint");
  });

  it("the halves' own points are read from the open set, both sides", () => {
    const v = view({ events: stream(rally("H"), rally("H"), rally("A")) });
    const spec = buildScorebug(v, t);
    expect(spec.halves[0]!.big).toBe("2");
    expect(spec.halves[1]!.big).toBe("1");
  });

  it("halves are tappable only live and at band 3 — swept both band and phase", () => {
    expect(buildScorebug(view({ band: 2 }), t).halves[0]!.tappable).toBe(false);
    expect(buildScorebug(view({ band: 3 }), t).halves[0]!.tappable).toBe(true);
    const done = view({ cfg: SHORT_CFG, events: stream(...DECIDED) });
    expect(buildScorebug(done, t).halves[0]!.tappable).toBe(false);
  });

  it("the sets tally is `id: \"games\"` — the shared gallery locator, even though the LABEL says Sets", () => {
    const item = stripItem(view({ events: stream(summary(25, 20)) }), "games")!;
    expect(item.label).toBe("pad.volleyball.scorebug.strip.sets");
    expect(item.value).toBe("1–0");
  });

  it("no strip item ever takes `tone: \"led\"` — R5-3's discipline", () => {
    const v = view({ events: stream(rally("H")) });
    for (const item of buildScorebug(v, t).strip) expect(item.tone).not.toBe("led");
  });
});

// ---------------------------------------------------------------------------
// D-17 — the serve, consumed from the engine, both sides, every branch
// ---------------------------------------------------------------------------

describe("serving via serveContextOf() — D-17, consumed never re-derived", () => {
  it("is unknown before the first rally — a fresh team sheet AND a fresh beach pair", () => {
    expect(ctxOf(view({ lineups: TEAM })).serveOrderKnown).toBe(false);
    expect(ctxOf(view({ lineups: PAIR })).serveOrderKnown).toBe(false);
    expect(stripItem(view({ lineups: TEAM }), "server")).toBeUndefined();
  });

  it("self-heals from the FIRST rally alone (side-out) — swept both winners", () => {
    const homeWins = view({ events: stream(rally("H")) });
    expect(ctxOf(homeWins).side).toBe("home");
    const awayWins = view({ events: stream(rally("A")) });
    expect(ctxOf(awayWins).side).toBe("away");
  });

  it("names the RALLY WINNER as due to serve next, never the loser — swept a THIRD rally too", () => {
    const v = view({ events: stream(rally("H"), rally("A"), rally("H")) });
    expect(ctxOf(v).side).toBe("home");
    // Indoor never names a PERSON (see the next test) — the strip's own
    // honest degrade is the side label, not a fabricated name.
    expect(stripItem(v, "server")!.value).toBe("scorepad.attribution.home");
  });

  it("an indoor side never names a PERSON — no serverFromPairOrder answer for a six-long roster", () => {
    const v = view({ events: stream(rally("H")) });
    expect(ctxOf(v).serverPersonId).toBeNull();
    expect(stripItem(v, "server")!.value).toBe("scorepad.attribution.home");
  });

  // The next four tests all rest on a VERIFIED engine fact (checked directly
  // against `foldMatch`, not this file's own reading of itself — this file's
  // header states it in full): for `setStart: "alternate"`, NEITHER
  // `serverPersonId` NOR `rotation` ever resolves without a `serving`
  // declaration landing on some set's own first rally — ordinary play alone
  // answers `side` (self-heals, proven above) but never these two. So every
  // one of them anchors set 1's own first rally deliberately, through the
  // RAW event shape the anchor SHEET itself posts (`rally(side, {serving})`)
  // — never a second, hand-rolled declaration path.
  const anchoredSet1 = (winner: "H" | "A") => stream(rally(winner, { serving: winner }), rally(winner), rally(winner));

  it("a beach pair names a PERSON (FIVB 13.2) once anchored — swept BOTH pairOrder directions", () => {
    const declared = view({ lineups: PAIR, cfg: BEACH_CFG, events: stream(rally("H", { serving: "H" })) });
    expect(NAMES[ctxOf(declared).serverPersonId!]).toBe("Home First");
    const swapped = view({ lineups: PAIR_SWAPPED, cfg: BEACH_CFG, events: stream(rally("H", { serving: "H" })) });
    expect(NAMES[ctxOf(swapped).serverPersonId!]).toBe("Home Second");
  });

  it("the strip names that person, both pairOrder directions, and the half never does", () => {
    const declared = view({ lineups: PAIR, cfg: BEACH_CFG, events: stream(rally("H", { serving: "H" })) });
    expect(stripItem(declared, "server")!.value).toBe("Home First");
    const spec = buildScorebug(declared, t);
    for (const half of spec.halves) for (const who of half.who) expect(who.serving).toBeUndefined();
  });

  it("the ROTATION number resolves once anchored — swept THREE increments, never pinned at one", () => {
    const one = view({ events: stream(rally("H", { serving: "H" })) });
    expect(ctxOf(one).rotation).toBe(1);
    expect(stripItem(one, "rotation")!.value).toBe("1");
    const two = view({ events: stream(rally("H", { serving: "H" }), rally("A"), rally("H")) });
    expect(ctxOf(two).rotation).toBe(2);
    const three = view({ events: stream(rally("H", { serving: "H" }), rally("A"), rally("H"), rally("A"), rally("H")) });
    expect(ctxOf(three).rotation).toBe(3);
  });

  it("the rotation number stays ABSENT for a beach pair, even once anchored and the server resolves", () => {
    const v = view({ lineups: PAIR, cfg: BEACH_CFG, events: stream(rally("H", { serving: "H" })) });
    expect(ctxOf(v).side).toBe("home");
    expect(ctxOf(v).serverPersonId).not.toBeNull(); // resolved
    expect(ctxOf(v).rotation, "a 2-player side can never field a 6-position rotation").toBeUndefined();
    expect(stripItem(v, "rotation")).toBeUndefined();
  });

  it("`setStart: \"alternate\"` opens the next set with the OPPONENT of the first server, never the winner — pinned at an opener who LOST the set it opens", () => {
    // Home serves rally 1 (declared — becomes set 1's first server) and wins
    // the set outright, so the winner and the first server are the SAME
    // side — the one construction that actually distinguishes "alternate off
    // the first server" from a wrongly-applied "winner serves next" (a
    // different sport's rule): the correct answer for set 2's opener is
    // AWAY, the side that LOST set 1.
    const v = view({ cfg: SHORT_CFG, events: anchoredSet1("H") });
    expect(ctxOf(v).side, "set 2 opens with the loser of set 1, not its winner").toBe("away");
  });

  it("...and the mirror: away serves first (declared) and wins, set 2 opens with HOME", () => {
    const v = view({ cfg: SHORT_CFG, events: anchoredSet1("A") });
    expect(ctxOf(v).side).toBe("home");
  });

  it("WITHOUT an anchor, alternation cannot open set 2 either — the propagating gap this file's header proves, not merely asserts", () => {
    // The identical set 1 (3-0 to home), but no declaration on any of its
    // rallies. `firstServer` for set 1 never resolves, so `opponent(...)`
    // has nothing to open set 2 from — side-out has to re-resolve from
    // set 2's OWN first rally instead, exactly as it did for set 1.
    const v = view({ cfg: SHORT_CFG, events: stream(rally("H"), rally("H"), rally("H")) });
    expect(ctxOf(v).serveOrderKnown, "unanchored — set 2 opens unresolved, not resolved-but-wrong").toBe(false);
  });

  it("the DECIDING set is TOSSED, not derived — unknown at 0-0, self-heals from its own first rally regardless of winner, but the rotation stays lost for that whole set unless it is anchored too", () => {
    // 2 sets each: home, away, home, away — 2-2 in sets, set 5 (the decider
    // for bestOf: 5) is about to open.
    const toDecider = [summary(3, 0), summary(0, 3), summary(3, 0), summary(0, 3)] as const;
    const before = view({ cfg: SHORT_CFG, events: stream(...toDecider) });
    const beforeCtx = ctxOf(before);
    expect(beforeCtx.serveOrderKnown).toBe(false);
    expect(beforeCtx.unknownBecause).toBe("deciding-set-toss");
    expect(stripItem(before, "server")).toBeUndefined();
    expect(stripItem(before, "rotation")).toBeUndefined();

    const afterHome = view({ cfg: SHORT_CFG, events: stream(...toDecider, rally("H")) });
    expect(ctxOf(afterHome).side, "side-out answers for itself the moment the decider's own first rally lands, even unanchored").toBe("home");
    expect(ctxOf(afterHome).rotation, "the chain never fully repairs without a fresh declaration — the toss resets firstServer again").toBeUndefined();

    const afterAway = view({ cfg: SHORT_CFG, events: stream(...toDecider, rally("A")) });
    expect(ctxOf(afterAway).side).toBe("away");

    // Anchored: the SAME decider, but its own first rally declares serving.
    const anchored = view({ cfg: SHORT_CFG, events: stream(...toDecider, rally("H", { serving: "H" })) });
    expect(ctxOf(anchored).rotation, "a fresh declaration on the decider's own first rally resolves the rotation too").toBe(1);
  });

  it("is unknown once the match is over", () => {
    const done = view({ cfg: SHORT_CFG, events: stream(...DECIDED) });
    expect(ctxOf(done).unknownBecause).toBe("match-over");
  });
});

// ---------------------------------------------------------------------------
// The serve anchor — the tile+sheet this file's header explains at length
// ---------------------------------------------------------------------------

describe("the serve anchor — offered while a declaration could still resolve EITHER the side or the rotation", () => {
  it("is offered at 0-0 of a fresh match", () => {
    expect(tileById(buildTiles(view(), t), SERVE_ANCHOR_TILE_ID)).toBeDefined();
  });

  // REVERSED in review of PR #678, finding 3, and the reversal is a
  // correction of FACT, not of the owner's ruling.
  //
  // This test asserted the tile STAYS OFFERED after an ordinary rally, on the
  // reasoning that it posts a declaration "and a declaration is exactly what
  // clears `chainBroken`". That is true of table tennis, whose `fixed-turns`
  // rotation lets the kernel combine a declared server with the score to name
  // the set's opener mid-set. It is false of volleyball, and not because of
  // any engine shortcoming: under side-out the next server simply IS the last
  // rally's winner, so once a point has been scored "who serves now" says
  // nothing about who OPENED the set — and the opener is the only thing the
  // rotation is missing. `setBasedServeWalk`'s non-`fixed-turns` branch says
  // exactly that, clearing `chainBroken` only at `before === 0`.
  //
  // Measured, not argued: declaring on the fourth rally leaves BOTH `rotation`
  // and `side` null, and declaring the other side sets `recorded-disagrees`,
  // which blanks the server strip for the rest of the set. So the tile was
  // promising a repair it could not perform, and one of its two answers made
  // the board worse. R5-7's rule — "offer it while anything it can fix is
  // unresolved" — is what this now implements, against the true facts.
  it("WITHDRAWS once a point is scored, because a side-out declaration can no longer name the set's opener", () => {
    const v = view({ events: stream(rally("H")) });
    expect(ctxOf(v).side, "`side` self-heals from any rally").toBe("home");
    expect(ctxOf(v).rotation, "but the rotation does not, and now cannot").toBeUndefined();
    expect(
      tileById(buildTiles(v, t), SERVE_ANCHOR_TILE_ID),
      "offering it here promises a fix the engine cannot perform",
    ).toBeUndefined();
  });

  it("a MID-SET declaration really does resolve nothing — the fact the withdrawal is built on", () => {
    const late = view({
      events: stream(rally("H"), rally("A"), rally("H"), rally("A", { serving: "A" })),
    });
    expect(ctxOf(late).rotation, "declaring mid-set cannot recover the rotation").toBeUndefined();
    // Nor does it even restore the SERVER: the walk's non-`fixed-turns`
    // branch sets `serving` but leaves `chainBroken`, so the reader still
    // declines to name a side.
    expect(ctxOf(late).side, "and it does not restore the server either").toBeNull();
  });

  it("ASKS on the first tap of a set, because after one point the opener is unrecoverable", () => {
    // The gap owner ruling R5-7 named and the anchor tile never closed:
    // nothing tells a scorer to press a tile before their first point, so the
    // natural flow — tap a half, start scoring — destroyed the set's opener
    // and the FIVB 7.6.2 rotation with it. The half now routes to a
    // one-question sheet on that first tap only.
    const fresh = view({ events: stream() });
    const [home, away] = buildScorebug(fresh, t).halves;
    expect(home.tapSheet, "the home half must ask before it scores").toBe(openerSheetKey("home"));
    expect(away.tapSheet).toBe(openerSheetKey("away"));
    // The event is still there: the sheet's job is to build THAT rally with
    // one more fact attached, not to replace it.
    expect(home.tapEvent?.type).toBe(RALLY_TYPE);
  });

  it("asks ONCE — the second tap of a set scores immediately", () => {
    // A prompt on every tap would be intolerable in a sport scored rally by
    // rally, and unnecessary: once a point exists the chain runs itself.
    const afterOne = view({ events: stream(rally("H", { serving: "H" })) });
    const [home] = buildScorebug(afterOne, t).halves;
    expect(home.tapSheet, "tap model S must stay one tap after the opener is known").toBeUndefined();
    expect(home.tapEvent?.type).toBe(RALLY_TYPE);
  });

  it("does not ask once the opener is already unrecoverable — a question nobody can answer is worse than none", () => {
    const undeclared = view({ events: stream(rally("H")) });
    const [home] = buildScorebug(undeclared, t).halves;
    expect(home.tapSheet).toBeUndefined();
  });

  it("never asks a BEACH pair, which fields no rotation for an opener to number", () => {
    const beach = view({ lineups: PAIR, cfg: BEACH_CFG, events: stream() });
    const [home] = buildScorebug(beach, t).halves;
    expect(home.tapSheet, "a two-tap sport must not be interrupted for a number it has no use for").toBeUndefined();
  });

  it("the sheet it opens asks ONE question and posts the tapped rally anchored", () => {
    const fresh = view({ events: stream() });
    const sheet = buildSheets(fresh, t)[openerSheetKey("away")]!;
    expect(sheet.event).toBe(RALLY_TYPE);
    expect(sheet.steps.length, "the half already knows the winner — only the server is missing").toBe(1);
    const payload = sheet.buildPayload({ serving: "home" }) as { wonBy: unknown; serving: unknown };
    // The AWAY half was tapped, so away won; home was declared serving.
    expect(payload.wonBy).not.toBe(payload.serving);
    // And the anchored rally really does resolve the rotation, which is the
    // whole point — asserted against a real fold, not the payload alone.
    const anchored = view({ events: stream(rally("A", { serving: "H" })) });
    expect(ctxOf(anchored).rotation, "the answer must actually buy the rotation number").not.toBeUndefined();
  });

  it("is still offered at 0-0, where a declaration DOES anchor the set", () => {
    const fresh = view({ events: stream() });
    expect(tileById(buildTiles(fresh, t), SERVE_ANCHOR_TILE_ID)).toBeDefined();
  });

  it("withdraws once the pad can report the rotation too — the tile answers a question, it is not permanent furniture", () => {
    const v = view({ events: stream(rally("H", { serving: "H" })) });
    expect(ctxOf(v).side).toBe("home");
    expect(ctxOf(v).rotation, "a declared rally resolves the rotation").not.toBeUndefined();
    expect(tileById(buildTiles(v, t), SERVE_ANCHOR_TILE_ID)).toBeUndefined();
  });

  // Review of PR #678. The kernel's `sideFieldsTheRotation` asks "was a squad
  // DECLARED?" and, once one was, SIZES it and never consults the cfg flag.
  // The first cut of `fieldsTheRotation` asked "are there on-field PLAYERS?"
  // against `view.squads` instead — a different input: `state.squads` is
  // ABSENT wherever a squad adds no information (probed: an ordinary indoor
  // fixture has none, which is why the `substitutions` fallback is the branch
  // that actually fires there), while the pad always materialises
  // `view.squads` from the team sheet.
  //
  // Where the two part company is a squad that IS declared and fields nobody:
  // the kernel answers false — nothing can ever number that rotation — while
  // the old pad code fell through to the flag, answered true, and offered the
  // anchor tile FOREVER for a question no declaration could settle. Exactly
  // the permanence this helper exists to prevent.
  //
  // REWRITTEN in review of PR #678, because the version here before it faked
  // the wrong input and so could never have caught the real defect.
  //
  // It overrode `v.state.squads` — on the premise that the kernel reads the
  // folded state's squads. The kernel reads the squads of the state it is
  // HANDED, and what this skin hands it is `serveInput`'s SHIM, whose
  // `squads` is `view.squads`. Overriding `state.squads` therefore changed
  // nothing the engine ever saw: the shim still carried six on-court players,
  // the engine still answered "yes, this side fields a rotation", and the old
  // pad code answered "no" off its fallback. The two disagreed in production
  // and this test could not see it, because it was faking a field neither
  // side reads.
  //
  // `view.squads` is faked instead — the input the engine actually sizes.
  it("does not offer the tile for a side that fields no rotation — the input the ENGINE sizes, not the folded state's", () => {
    const v = view({ events: stream(rally("H")) });
    expect(
      (v.state as { squads?: unknown }).squads,
      "an ordinary indoor fold persists no squad — which is why the shim, not the fold, is what the engine reads",
    ).toBeUndefined();
    const emptied = {
      ...v,
      squads: { ...v.squads, home: { ...v.squads.home, members: [] } },
    } as typeof v;

    expect(
      tileById(buildTiles(emptied, t), SERVE_ANCHOR_TILE_ID),
      "nobody on court means no rotation to number, so a declaration cannot settle anything",
    ).toBeUndefined();
    // And the engine agrees on the very same input, which is the whole point:
    // this predicate is a restatement, so it is pinned against the original.
    expect(ctxOf(emptied).rotation).toBeUndefined();
  });

  it("never lingers for a BEACH pair, which fields no six to rotate", () => {
    // The guard that stops R5-7 turning the tile into permanent furniture
    // wherever a rotation can never resolve: `fieldsTheRotation` restates the
    // kernel's own `sideFieldsTheRotation`, and this pins the copy against a
    // real fold of the beach variant rather than asserting it.
    const v = view({ lineups: PAIR, cfg: BEACH_CFG, events: stream(rally("H")) });
    expect(ctxOf(v).side, "the side is known").toBe("home");
    expect(ctxOf(v).rotation, "a pair has no rotation number, ever").toBeUndefined();
    expect(tileById(buildTiles(v, t), SERVE_ANCHOR_TILE_ID)).toBeUndefined();
  });

  it("is offered again at 0-0 of the DECIDING set — the set boundary IS the second chance", () => {
    const toDecider = [summary(3, 0), summary(0, 3), summary(3, 0), summary(0, 3)] as const;
    const before = view({ cfg: SHORT_CFG, events: stream(...toDecider) });
    expect(
      tileById(buildTiles(before, t), SERVE_ANCHOR_TILE_ID),
      "the deciding set is tossed, so its opener is genuinely undeclared again",
    ).toBeDefined();

    // REVERSED in review of PR #678, finding 3: this used to assert the tile
    // survived an ordinary first rally of the decider "same rule as set 1".
    // It does not, and must not — once a point is scored, side-out makes the
    // next server a function of the last rally, so a declaration can no longer
    // name the opener. Offering it here would promise a repair the engine
    // cannot perform. The genuine second chance is the SET BOUNDARY, which is
    // what the first assertion above pins.
    const ordinary = view({ cfg: SHORT_CFG, events: stream(...toDecider, rally("H")) });
    expect(ctxOf(ordinary).rotation).toBeUndefined();
    expect(tileById(buildTiles(ordinary, t), SERVE_ANCHOR_TILE_ID)).toBeUndefined();

    // A DECLARED first rally resolves both, and the tile withdraws.
    const declared = view({ cfg: SHORT_CFG, events: stream(...toDecider, rally("H", { serving: "H" })) });
    expect(ctxOf(declared).rotation).not.toBeUndefined();
    expect(tileById(buildTiles(declared, t), SERVE_ANCHOR_TILE_ID)).toBeUndefined();
  });

  it("is never offered once the match is over", () => {
    const done = view({ cfg: SHORT_CFG, events: stream(...DECIDED) });
    expect(tileById(buildTiles(done, t), SERVE_ANCHOR_TILE_ID)).toBeUndefined();
  });

  // Mutation audit — `needsServeAnchor`'s two `unknownBecause` exclusions
  // (`recorded-disagrees`, `ledger-mismatch`) had no coverage of their own:
  // every test above reaches the tile only through `undeclared`,
  // `deciding-set-toss` or `match-over`, so neutering the whole predicate to
  // `return true` left every test above green (97/97). Both exclusions are
  // pinned here, for a different reason each, so they are separate tests
  // rather than one loop — table tennis's own `tiles()` describe pins the
  // byte-identical predicate the same way.
  it("withholds the anchor during a RECORDED DISAGREEMENT — a re-declaration is not what fixes that", () => {
    // Home declares AND wins the anchor rally, so side-out says home keeps
    // serving. The very next rally's own `serving` field wrongly says away —
    // a genuine contradiction between what was recorded and what the fold
    // implies. The engine refuses to re-anchor mid-dispute (R4-7: the NEXT
    // set resolves it, per `setStart:"alternate"`, not a same-set
    // redeclaration), so offering the tile here would invite an answer to a
    // question the engine has already refused to accept.
    const disputed = view({ events: stream(rally("H", { serving: "H" }), rally("A", { serving: "A" })) });
    expect(ctxOf(disputed).unknownBecause).toBe("recorded-disagrees");
    expect(ctxOf(disputed).side, "the reader must not name a server mid-dispute").toBeNull();
    expect(
      tileById(buildTiles(disputed, t), SERVE_ANCHOR_TILE_ID),
      "a disputed chain is not an undeclared one — the anchor must stay withheld",
    ).toBeUndefined();
  });

  it("withholds the anchor on a LEDGER MISMATCH — no event of any kind repairs that", () => {
    // `view()`'s `state` is folded from the FULL three-rally stream, but the
    // `events` handed to the reader are truncated to the first two — state
    // and ledger now describe different matches. That is structural: a fresh
    // declaration cannot reconcile it, so the tile must not be offered.
    const events = stream(rally("H", { serving: "H" }), rally("A"), rally("H"));
    const mismatched = { ...view({ events }), events: events.slice(0, 2) };
    expect(ctxOf(mismatched).unknownBecause).toBe("ledger-mismatch");
    expect(tileById(buildTiles(mismatched, t), SERVE_ANCHOR_TILE_ID)).toBeUndefined();
  });

  it("the sheet posts a real RALLY_TYPE event with `serving` — TWO independent choice steps, both sides offered", () => {
    const sheet = buildSheets(view(), t)[SERVE_ANCHOR_TILE_ID]!;
    expect(sheet.event).toBe(RALLY_TYPE);
    expect(sheet.steps).toHaveLength(2);
    expect(sheet.buildPayload({ serving: "away", wonBy: "home" })).toEqual({
      wonBy: "H",
      serving: "A",
    });
  });

  it("stamps neither `server` nor `scorer` — unlike table tennis, this sport has no singles case to have named one, and the ordinary dock asks afterward", () => {
    const sheet = buildSheets(view(), t)[SERVE_ANCHOR_TILE_ID]!;
    const payload = sheet.buildPayload({ serving: "home", wonBy: "home" });
    expect(payload).not.toHaveProperty("server");
    expect(payload).not.toHaveProperty("scorer");
    // ...and the dock DOES ask, for the same reason an ordinary tap would:
    const dock = buildDock(RALLY_TYPE, view(), t, payload)!;
    expect(dock.chips.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// D-7 — the band-limited screen
// ---------------------------------------------------------------------------

describe("D-7 — below band 3 the pad SAYS SO, in volleyball's own words", () => {
  const limited = () => view({ band: 2, entitlements: {} });

  it("renders a visible, disabled rally tile instead of nothing at all", () => {
    const tile = tileById(buildTiles(limited(), t), RALLY_LOCKED_TILE_ID)!;
    expect(tile.disabled).toBe(true);
    expect(tile.span).toBe(4);
    expect(tile.labelText).toBe("pad.volleyball.tile.rallyLocked");
    expect(tile.sublabelText).toBe("pad.volleyball.tile.rallyLocked.sublabel");
  });

  it("survives the chassis's own band filter — the gate it exists to explain must not eat it", () => {
    const v = limited();
    const tiles = buildTiles(v, t);
    const sheets = buildSheets(v, t);
    const kept = filterTilesByBand(tiles, sheets, [], volleyball.padSpec!(VB_CFG).fidelity, new Set([0, 1, 2]));
    expect(kept.map((tile) => tile.id)).toContain(RALLY_LOCKED_TILE_ID);
  });

  it("carries the REASON on a context slot, naming the plan through the shared table", () => {
    const spec = buildContextStrip(limited(), t)!;
    expect(spec.slots).toHaveLength(1);
    expect(spec.slots[0]!.readOnly).toBe(true);
    expect(spec.slots[0]!.message).toContain("pad.volleyball.context.recording.locked");
    expect(spec.slots[0]!.message).toContain('"plan":"Pro"');
  });

  it("pairs the disabled tile with that message — the chassis's own rule for a disabled tile", () => {
    const v = limited();
    expect(assertDisabledTilesExplained(buildTiles(v, t), buildContextStrip(v, t))).toEqual([]);
  });

  it("says nothing at all at band 3, or once the match is over", () => {
    expect(tileById(buildTiles(view(), t), RALLY_LOCKED_TILE_ID)).toBeUndefined();
    expect(buildContextStrip(view(), t)).toBeNull();
    const done = view({ cfg: SHORT_CFG, band: 2, events: stream(...DECIDED) });
    expect(buildContextStrip(done, t)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tiles()
// ---------------------------------------------------------------------------

describe("buildTiles()", () => {
  it("sanctions and timeouts are a HOME/AWAY pair, home first — column alignment", () => {
    const tiles = buildTiles(view(), t);
    const sanctionHome = tiles.findIndex((tl) => tl.id === sanctionSheetKey("home"));
    const sanctionAway = tiles.findIndex((tl) => tl.id === sanctionSheetKey("away"));
    expect(sanctionHome).toBeGreaterThanOrEqual(0);
    expect(sanctionAway).toBe(sanctionHome + 1);
    const timeoutHome = tiles.findIndex((tl) => tl.id === timeoutTileId("home"));
    const timeoutAway = tiles.findIndex((tl) => tl.id === timeoutTileId("away"));
    expect(timeoutAway).toBe(timeoutHome + 1);
  });

  it("withholds sanctions/timeouts when this FIXTURE's own cfg says it does not record them", () => {
    const noneRecorded = volleyball.configSchema.parse({
      records: { timeouts: false, sanctions: false, substitutions: false, expedite: false },
    });
    const tiles = buildTiles(view({ cfg: noneRecorded }), t);
    expect(tileById(tiles, sanctionSheetKey("home"))).toBeUndefined();
    expect(tileById(tiles, timeoutTileId("home"))).toBeUndefined();
  });

  it("the timeout tile dispatches DIRECTLY, no sheet, `by` the tapped side's own entrant id", () => {
    const tile = tileById(buildTiles(view(), t), timeoutTileId("away"))!;
    // `entrantOf` resolves the ENTRANT id ("A", `teamSide("A")`'s own
    // `entrantId`), never the bare side tag "away".
    expect(tile.action).toMatchObject({ event: { type: TIMEOUT_TYPE, payload: { by: "A" } } });
  });

  it("Set score is withheld once the CURRENT set is in progress", () => {
    expect(tileById(buildTiles(view(), t), SET_SCORE_TILE_ID)).toBeDefined();
    const inProgress = view({ events: stream(rally("H")) });
    expect(tileById(buildTiles(inProgress, t), SET_SCORE_TILE_ID)).toBeUndefined();
  });

  it("no libero named on EITHER side — no libero tile for either", () => {
    const tiles = buildTiles(view({ lineups: { home: teamSideNoLibero("H"), away: teamSideNoLibero("A") } }), t);
    expect(tileById(tiles, liberoSwapSlotId("home"))).toBeUndefined();
    expect(tileById(tiles, liberoSwapSlotId("away"))).toBeUndefined();
  });

  it("a libero named on ONLY ONE side still offers BOTH tiles — the atomic 0-or-2 pair invariant", () => {
    const tiles = buildTiles(view({ lineups: TEAM_HOME_LIBERO_ONLY }), t);
    const home = tileById(tiles, liberoSwapSlotId("home"));
    const away = tileById(tiles, liberoSwapSlotId("away"));
    expect(home, "home named a libero").toBeDefined();
    expect(away, "away never used one, but the pair must stay atomic or column alignment breaks").toBeDefined();
    const homeIdx = tiles.findIndex((tl) => tl.id === liberoSwapSlotId("home"));
    expect(tiles[homeIdx + 1]!.id).toBe(liberoSwapSlotId("away"));
  });

  it("the libero tile is gated live + band >= 1, independent of the rally band", () => {
    const belowAdmin = view({ band: 0, entitlements: {} });
    expect(tileById(buildTiles(belowAdmin, t), liberoSwapSlotId("home"))).toBeUndefined();
    const admin = view({ band: 1, entitlements: {} });
    expect(tileById(buildTiles(admin, t), liberoSwapSlotId("home"))).toBeDefined();
  });

  it("the More tile is always last", () => {
    const tiles = buildTiles(view(), t);
    expect(tiles.at(-1)!.id).toBe("more");
  });
});

// ---------------------------------------------------------------------------
// refusedEventTypes()
// ---------------------------------------------------------------------------

describe("refusedEventTypes()", () => {
  it("refuses the coarse summary exactly while the fold would throw for it", () => {
    expect(refusedEventTypes(view())).not.toContain(SUMMARY_TYPE);
    expect(refusedEventTypes(view({ events: stream(rally("H")) }))).toContain(SUMMARY_TYPE);
    expect(refusedEventTypes(view({ events: stream(summary(25, 15)) }))).not.toContain(SUMMARY_TYPE);
  });

  it("refuses expedite for every shipped volleyball config — FIVB has no ITTF-style system", () => {
    expect(refusedEventTypes(view())).toContain(EXPEDITE_TYPE);
  });

  it("does NOT refuse timeout/sub when this fixture's own cfg says it records them (indoor default), and DOES for beach's own substitutions flag", () => {
    const refusedIndoor = refusedEventTypes(view());
    expect(refusedIndoor).not.toContain(TIMEOUT_TYPE);
    expect(refusedIndoor).not.toContain(SUB_TYPE);
    const refusedBeach = refusedEventTypes(view({ cfg: BEACH_CFG }));
    expect(refusedBeach).not.toContain(TIMEOUT_TYPE);
    expect(refusedBeach, "beach has no bench to substitute from — S6/#416").toContain(SUB_TYPE);
  });

  it("keeps the More sheet free of every dead end EXCEPT the scoresheet sub tally — a genuinely different fact from the libero swap, left reachable on purpose", () => {
    // `volleyball.sub` (the FIVB scoresheet's substitution-BOX tally) is
    // deliberately neither dedicated (no tile) nor refused (this fixture
    // records substitutions) — this file's own header explains why: it is a
    // real, separate fact from the libero swap's actual lineup change, and
    // the generic form is its only surface. Every OTHER type must still be
    // either dedicated or refused.
    const v = view({ events: stream(rally("H")) });
    const tiles = buildTiles(v, t);
    const sheets = buildSheets(v, t);
    const swaps = buildSwap(v, t);
    const scorebug = buildScorebug(v, t);
    const dedicated = dedicatedEventTypes(tiles, sheets, swaps, scorebug);
    expect(dedicated).toContain(RALLY_TYPE);
    const actions = moreActions(
      volleyball.padSpec!(VB_CFG),
      { state: v.state, summary: v.summary, phase: "live", band: 3, entitlements: v.entitlements },
      dedicated,
      new Set(refusedEventTypes(v)),
    );
    expect(actions.map((action) => action.type)).toEqual([SUB_TYPE]);
  });

  it("...and once this fixture does NOT record substitutions (beach), even that one dead end closes", () => {
    const v = view({ cfg: BEACH_CFG, lineups: PAIR, events: stream(rally("H")) });
    const tiles = buildTiles(v, t);
    const sheets = buildSheets(v, t);
    const swaps = buildSwap(v, t);
    const scorebug = buildScorebug(v, t);
    const dedicated = dedicatedEventTypes(tiles, sheets, swaps, scorebug);
    const actions = moreActions(
      volleyball.padSpec!(BEACH_CFG),
      { state: v.state, summary: v.summary, phase: "live", band: 3, entitlements: v.entitlements },
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
  it("prefills the Set score sheet from the CURRENT set, and clamps to the cap", () => {
    const v = view({ events: stream(summary(25, 15)) });
    const sheet = buildSheets(v, t)[SET_SCORE_TILE_ID]!;
    expect(sheet.event).toBe(SUMMARY_TYPE);
    const [home, away] = sheet.steps;
    expect((home as { initial: number }).initial).toBe(0);
    expect((home as { max: number }).max).toBe(VB_CFG.cap ?? Math.max(VB_CFG.setTo, VB_CFG.finalSetTo) + 20);
    expect(sheet.buildPayload({ home: "25", away: "19" })).toEqual({ home: 25, away: 19 });
    void away;
  });

  it("prefills from the live score once the set is under way", () => {
    const v = view({ events: stream(rally("H"), rally("H"), rally("A")) });
    const sheet = buildSheets(v, t)[SET_SCORE_TILE_ID]!;
    expect((sheet.steps[0] as { initial: number }).initial).toBe(2);
    expect((sheet.steps[1] as { initial: number }).initial).toBe(1);
  });

  it("the sanction ladder is FIVB's own four steps, warning toned caution, everything else dismissal", () => {
    const sheet = buildSheets(view(), t)[sanctionSheetKey("home")]!;
    const level = sheet.steps[0] as { kind: "choice"; options: { id: string; tone?: readonly string[] }[] };
    expect(level.options.map((o) => o.id)).toEqual(SANCTION_LEVELS);
    expect(level.options.find((o) => o.id === "warning")!.tone).toEqual(["caution"]);
    for (const id of ["penalty", "expulsion", "disqualification"]) {
      expect(level.options.find((o) => o.id === id)!.tone).toEqual(["dismissal"]);
    }
  });

  it("asks WHO only when the side has more than one on-field player — a pair auto-stamps its sole member", () => {
    const teamSheet = buildSheets(view(), t)[sanctionSheetKey("home")]!;
    expect(teamSheet.steps.length).toBe(2);
    const singleton: LineupPair = {
      home: { entrantId: "H", slots: [{ personId: "H-solo", slot: "starting", orderNo: 1 }] },
      away: teamSide("A"),
    };
    const soleSheet = buildSheets(view({ lineups: singleton }), t)[sanctionSheetKey("home")]!;
    expect(soleSheet.steps.length).toBe(1);
    expect(soleSheet.buildPayload({ level: "warning" })).toMatchObject({ person: "H-solo" });
  });
});

// ---------------------------------------------------------------------------
// swap() — FIVB 15.6/19.3, the libero exchange
// ---------------------------------------------------------------------------

describe("buildSwap() — the libero exchange", () => {
  it("returns nothing before the match starts, and nothing once it is over", () => {
    expect(buildSwap(view({ events: [] }), t)).toEqual([]);
    const done = view({ cfg: SHORT_CFG, events: stream(...DECIDED) });
    expect(buildSwap(done, t)).toEqual([]);
  });

  it("returns nothing when NEITHER side has ever named a libero", () => {
    const noLibero: LineupPair = { home: teamSideNoLibero("H"), away: teamSideNoLibero("A") };
    expect(buildSwap(view({ lineups: noLibero }), t)).toEqual([]);
  });

  it("returns BOTH slots when only one side has ever named a libero — the tile-pair's own atomicity", () => {
    const slots = buildSwap(view({ lineups: TEAM_HOME_LIBERO_ONLY }), t);
    expect(slots.map((s) => s.side)).toEqual(["home", "away"]);
  });

  it("declares the REAL wire type, `core.lineup.replacement` — and buildEvent actually returns it (the pair types.ts obliges a skin to prove)", () => {
    const slot = buildSwap(view(), t).find((s) => s.side === "home")!;
    expect(slot.eventType).toBe(LIBERO_TYPE);
    expect(slot.buildEvent("H-p3", "H-lib").type).toBe(slot.eventType);
  });

  it("policyOk is always true — the exemption channel is uncapped and this file never grows a squad", () => {
    for (const slot of buildSwap(view(), t)) expect(slot.policyOk).toBe(true);
  });

  it("candidates: the libero herself, and anyone who has already been off once via this exchange — a bench player who has NEVER been off and carries no libero role is excluded entirely", () => {
    const slot = buildSwap(view(), t).find((s) => s.side === "home")!;
    expect(slot.candidates, "the libero is a fresh, never-off candidate — offered by ROLE").toContain("H-lib");
    expect(slot.candidates, "an ordinary bench player who has never left and is not a libero is not this flow's business").not.toContain("H-b2");
  });

  it("after a real exchange, the ORIGINAL PLAYER (now bench, timesOff > 0) is offered too — and the libero (now on court) is not", () => {
    const events = stream(liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"]));
    const slot = buildSwap(view({ events }), t).find((s) => s.side === "home")!;
    expect(slot.candidates).toContain("H-p3");
    expect(slot.candidates, "she is on court now — not a bench candidate").not.toContain("H-lib");
  });

  it("buildEvent, bringing the libero ON: positionKey is the DEPARTING player's own position, and exemption is 'libero'", () => {
    const v = view();
    const slot = buildSwap(v, t).find((s) => s.side === "home")!;
    const built = slot.buildEvent("H-p3", "H-lib");
    expect(built).toMatchObject({
      type: LIBERO_TYPE,
      payload: { side: "H", off: "H-p3", on: { personId: "H-lib", positionKey: "MB" }, exemption: "libero" },
    });
  });

  it("buildEvent, bringing the ORIGINAL PLAYER back: positionKey is THEIR OWN lastPositionKey — FIVB 15.6's position lock, auto-derived and never asked", () => {
    const events = stream(liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"]));
    const v = view({ events });
    const slot = buildSwap(v, t).find((s) => s.side === "home")!;
    const built = slot.buildEvent("H-lib", "H-p3");
    expect(built.payload).toMatchObject({ side: "H", off: "H-lib", on: { personId: "H-p3", positionKey: "MB" } });
  });

  it("a candidate returning for the FIRST time is not blocked", () => {
    const events = stream(liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"]));
    const slot = buildSwap(view({ events }), t).find((s) => s.side === "home")!;
    expect(slot.blocked?.["H-p3"]).toBeUndefined();
  });

  it("FIVB 19.3.2.1 — a candidate who has already used a return is UNBLOCKED: a libero exchange is not bound by 15.6's substitution re-entry cap", () => {
    // Formerly named "FIVB 15.6 — a candidate who has ALREADY used their one
    // return is BLOCKED, worded from the machine .reason, never the engine's
    // own ID-bearing English", and asserted `slot.blocked?.["H-p3"]` equalled
    // the `reentryLimit` copy on exactly this cycle. That assertion encoded
    // a defect, not a rule: FIVB 15.6's "once, and only once" cap bounds the
    // ORDINARY substitution allowance; a libero replacement is a 19.3.2.1
    // exchange, not a 15.6 substitution, and is UNLIMITED. `bringOn`
    // (`core/lineup.ts`) now carries an `exemptReplacement` flag that skips
    // both count refusals for the `on` half of a `core.lineup.replacement`
    // naming a declared exemption — every candidate this sheet offers IS
    // that `on` half. THIS IS A DELIBERATE REVERSAL: restore the old
    // `liberoBlockedReason` count checks (or revert the `bringOn` exemption
    // bypass) and this test reds again.
    //
    // H-p3 off (lib on) -> H-p3 back on (his 1st return) -> H-p3 off again
    // (lib on again). H-p3's bench record is now timesOff:2, timesOn:1 —
    // what used to be "his allowance is spent" no longer applies to him.
    const events = stream(
      liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"]),
      liberoSwap("H", "H-lib", "H-p3", "MB"),
      liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"]),
    );
    const slot = buildSwap(view({ events }), t).find((s) => s.side === "home")!;
    expect(slot.candidates).toContain("H-p3");
    expect(slot.blocked?.["H-p3"]).toBeUndefined();
  });

  it("MUTATION PROOF — the pad's unblocked verdict is exactly what a REAL reduceLineupEvent now accepts, not this file's own reading of itself", () => {
    // Formerly asserted `probe.ok === false` / `probe.reason ===
    // "reentry-limit"` on this exact cycle, and `slot.blocked?.["H-p3"]`
    // toBeDefined() to match it — proving the pad's restatement agreed with
    // a real refusal. That refusal is gone: `bringOn` (`core/lineup.ts`) now
    // exempts the `on` half of a `core.lineup.replacement` naming a declared
    // exemption from both count refusals (FIVB 19.3.2.1 vs 15.6's `reentry:
    // "once"`), and this probe names `exemption: "libero"`. THIS IS A
    // DELIBERATE REVERSAL: revert the `bringOn` exemption bypass, or restore
    // the old `liberoBlockedReason` count checks with nothing behind them in
    // the engine, and this test reds — either the probe stops being `ok`, or
    // the pad disagrees with an engine that is once again refusing it.
    const events = stream(
      liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"]),
      liberoSwap("H", "H-lib", "H-p3", "MB"),
      liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"]),
    );
    const v = view({ events });
    const policy: LineupPolicy = volleyball.lineupPolicy!(VB_CFG);
    const p3 = memberOf(v.squads.home, "H-p3")!;
    expect(p3.timesOff).toBe(2);
    expect(p3.timesOn).toBe(1);
    // The REAL engine call this file's own `liberoBlockedReason` restates.
    // The OFF half must be the LIBERO, and that is no longer incidental: an
    // earlier version of this probe took "any on-field player", on the stated
    // premise that the checks read only the candidate coming ON. That premise
    // died with the `requiresRole` bound (review PR #678) — the exemption now
    // reads BOTH players, and it must, or the channel launders an ordinary
    // re-entry past FIVB 15.6. Naming the libero is also the only transaction
    // a scorer could really be performing here: H-p3 returns FOR the libero
    // who replaced them.
    const anyOnField: SquadMember = v.squads.home.members.find(
      (m) => m.onField && (m.roles?.includes("libero") ?? false),
    )!;
    const probe = reduceLineupEvent(
      v.squads,
      {
        type: "core.lineup.replacement",
        payload: {
          side: "H",
          off: anyOnField.personId,
          on: { personId: "H-p3", positionKey: "MB", slot: "starting", orderNo: 3 },
          exemption: "libero",
        },
      },
      policy,
    );
    expect(probe.ok).toBe(true);
    // And this file's own swap slot agrees with that real acceptance.
    const slot = buildSwap(v, t).find((s) => s.side === "home")!;
    expect(slot.blocked?.["H-p3"]).toBeUndefined();
  });

  it("REVIEW #678/4 — the wrong player cannot take the libero's slot and strand the one FIVB 19.3.2.3 requires back", () => {
    // H-p3 (MB) goes off for the libero; separately H-p5 has left from OH.
    // A scorer picking OFF = the libero, ON = H-p5 would, before this fix,
    // send H-p5's OWN last position (OH) — which satisfied H-p5's own lock,
    // was accepted, and silently vacated the MB slot the libero was holding,
    // leaving H-p3 stranded off court.
    const events = stream(
      // H-p5 leaves from OH and STAYS off — they are the wrong player for the
      // libero's MB slot, and the point of the test.
      liberoSwap("H", "H-p5", "H-p7", "OH"),
      liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"]),
    );
    const v = view({ events });
    const policy: LineupPolicy = volleyball.lineupPolicy!(VB_CFG);
    const slot = buildSwap(v, t).find((s) => s.side === "home")!;

    // The WRONG player for that slot is refused, by the engine's own position
    // lock, because the event now names the position being VACATED.
    const wrong = reduceLineupEvent(v.squads, slot.buildEvent("H-lib", "H-p5") as never, policy);
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.reason).toBe("reentry-position");

    // The player the libero actually replaced is still accepted — the rule
    // must not be enforced by refusing everyone.
    const right = reduceLineupEvent(v.squads, slot.buildEvent("H-lib", "H-p3") as never, policy);
    expect(right.ok, "the player the libero replaced must still be able to return").toBe(true);
  });

  it("REVIEW #678/2 — an ORDINARY player must not be cycled unlimited times through the libero channel (FIVB 15.6 still binds them)", () => {
    // The hole this pins: `buildLiberoEvent` stamps `exemption: "libero"` on
    // EVERY event this sheet produces, and `liberoCandidatesFor` offers any
    // bench member with `timesOff > 0` — not only a libero, and not only the
    // player a libero replaced. With `bringOn` now skipping the count
    // refusals for a declared exemption, an ordinary substitute could be
    // returned again and again on the libero's uncapped channel, which is
    // exactly the 15.6 allowance the exemption was never meant to touch.
    //
    // H-p3 here is an ordinary middle blocker. No libero takes part in the
    // transaction at all: H-lib is never named.
    const events = stream(
      liberoSwap("H", "H-p3", "H-p7", "MB"),
      liberoSwap("H", "H-p7", "H-p3", "MB"),
      liberoSwap("H", "H-p3", "H-p7", "MB"),
    );
    const v = view({ events });
    const policy: LineupPolicy = volleyball.lineupPolicy!(VB_CFG);
    const p3 = memberOf(v.squads.home, "H-p3")!;
    expect(p3.timesOn, "H-p3 has already used 15.6's one return").toBeGreaterThanOrEqual(1);
    expect(p3.roles?.includes("libero") ?? false, "H-p3 is an ORDINARY player").toBe(false);
    const anyOnField: SquadMember = v.squads.home.members.find((m) => m.onField)!;
    // The REAL production path: the slot the sheet builds, and the event its
    // own `buildEvent` produces for the pair a scorer could actually pick.
    const slot = buildSwap(v, t).find((s) => s.side === "home")!;
    expect(slot.candidates, "the sheet offers this ordinary player at all").toContain("H-p3");
    const probe = reduceLineupEvent(v.squads, slot.buildEvent(anyOnField.personId, "H-p3") as never, policy);
    // A second return for an ordinary player is 15.6's business, not
    // 19.3.2.1's. The exemption must not launder it.
    expect(probe.ok).toBe(false);
    // `exemption-role-absent`, not `reentry-limit`, and the distinction is the
    // fix itself: the engine refuses because this pair is not a 19.3.2.1
    // exchange AT ALL, so it never reaches the 15.6 count it would otherwise
    // have been laundered past. Restoring the old count check in the skin
    // would refuse the same pair for the wrong reason and re-break the real
    // libero along with it.
    expect(!probe.ok && probe.reason).toBe("exemption-role-absent");
    // And the sheet greys it out BEFORE the tap, rather than earning the
    // refusal at the scoring door.
    expect(slot.blocked?.["H-p3"]).toBeDefined();
  });

  it("decorates every candidate with the POSITION CODE the fold already holds — the picker used to discard it", () => {
    // One completed libero exchange, so the squad holds a libero, a player
    // it replaced, and the rest of the six on court.
    const v = view({ events: stream(liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"])) });
    const slot = buildSwap(v, t).find((s) => s.side === "home")!;
    // Not a lookup this file invents: `positionKey` is on the folded squad
    // member, and the row simply threw it away before this ruling.
    // H-p3 came OFF, so `positionKey` is cleared and `lastPositionKey` holds
    // MB — the position they will return to, and the one `buildLiberoEvent`
    // will actually send for them.
    expect(slot.candidateMeta?.["H-p3"]?.lead).toBe("MB");
    // The libero on court reads MB TOO, because they took over the middle
    // blocker's position — not "L". This is not a defect, it is the whole
    // reason `tag` exists: after one exchange the position code alone cannot
    // tell these two players apart, and the sheet is entirely about which of
    // them is the libero.
    expect(slot.candidateMeta?.["H-lib"]?.lead).toBe("MB");
  });

  it("tags the LIBERO, whom the position code cannot identify once they are on court", () => {
    // One completed libero exchange, so the squad holds a libero, a player
    // it replaced, and the rest of the six on court.
    const v = view({ events: stream(liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"])) });
    const slot = buildSwap(v, t).find((s) => s.side === "home")!;
    expect(slot.candidateMeta?.["H-lib"]?.tag).toBe(t("pad.volleyball.swap.liberoTag"));
    // An ordinary middle blocker carries a position and no tag — otherwise
    // the marker would say nothing, being on every row.
    expect(slot.candidateMeta?.["H-p3"]?.tag).toBeUndefined();
  });

  it("keys the table over the WHOLE squad, not just the ON list — the OFF step's pool is resolved by the CHASSIS", () => {
    // One completed libero exchange, so the squad holds a libero, a player
    // it replaced, and the rest of the six on court.
    const v = view({ events: stream(liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"])) });
    const slot = buildSwap(v, t).find((s) => s.side === "home")!;
    // `liberoCandidatesFor` returns bench-side candidates; the OFF step draws
    // from `resolvePool({pool:"onfield"})` inside swap-sheet.tsx. A table
    // built from the ON list alone would decorate one step and not the other,
    // and no test of the ON list could ever see it.
    const onCourt = v.squads.home.members.filter((m) => m.onField).map((m) => m.personId);
    expect(onCourt.length).toBeGreaterThan(0);
    for (const id of onCourt) {
      expect(slot.candidateMeta?.[id], `on-court ${id} is undecorated`).toBeDefined();
    }
  });

  it("`reentry-position` is dedicated in the refusal table too (FIVB's own position lock, the brief's second named fact), even though this file's own auto-derivation makes it unreachable from its own UI", () => {
    // Proven the other way round: a REAL return built by THIS FILE's own
    // buildEvent, replayed through the real reducer, must never hit it.
    const events = stream(liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"]));
    const v = view({ events });
    const slot = buildSwap(v, t).find((s) => s.side === "home")!;
    const built = slot.buildEvent("H-lib", "H-p3");
    const policy: LineupPolicy = volleyball.lineupPolicy!(VB_CFG);
    const result = reduceLineupEvent(v.squads, built, policy);
    expect(result.ok, "the auto-derived position is always the historically correct one").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dock() — R5-2. NO singles branch: volleyball's smallest side is a pair.
// ---------------------------------------------------------------------------

describe("buildDock() — every side is asked, never auto-set", () => {
  it("a beach PAIR opens the dock — R5-2's own reason for existing, and there is no auto-set path on this sport at all", () => {
    const v = view({ lineups: PAIR, cfg: BEACH_CFG, events: stream(rally("H")) });
    const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "H" })!;
    expect(dock.chips.map((c) => c.id)).toEqual(["scorer:H-first", "scorer:H-second"]);
  });

  it("a full indoor TEAM opens the dock with all six on-court players, first-named first", () => {
    const v = view({ events: stream(rally("H")) });
    const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "H" })!;
    expect(dock.chips.map((c) => c.id)).toEqual(["H-p1", "H-p2", "H-p3", "H-p4", "H-p5", "H-p6"].map((id) => `scorer:${id}`));
  });

  it("the LOSING side is never offered", () => {
    const v = view({ lineups: PAIR, cfg: BEACH_CFG, events: stream(rally("H")) });
    const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "H" })!;
    expect(dock.chips.some((c) => c.id.includes("A-first") || c.id.includes("A-second"))).toBe(false);
  });

  it("a degenerate ONE-PLAYER roster (a hand-built or gallery fixture) commits with no dock at all — defensive, matching the siblings' own singles guard", () => {
    const singleton: LineupPair = {
      home: { entrantId: "H", slots: [{ personId: "H-solo", slot: "starting", orderNo: 1 }] },
      away: { entrantId: "A", slots: [{ personId: "A-solo", slot: "starting", orderNo: 1 }] },
    };
    const v = view({ lineups: singleton, events: stream(rally("H")) });
    expect(buildDock(RALLY_TYPE, v, t, { wonBy: "H" })).toBeNull();
  });

  it("the chip's mutate sets `scorer`, one-way once answered", () => {
    const v = view({ lineups: PAIR, cfg: BEACH_CFG, events: stream(rally("H")) });
    const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "H" })!;
    const chip = dock.chips.find((c) => c.id === "scorer:H-second")!;
    expect(chip.mutate({ wonBy: "H" })).toEqual({ wonBy: "H", scorer: "H-second" });
    const answered = buildDock(RALLY_TYPE, v, t, { wonBy: "H", scorer: "H-second" })!;
    expect(answered.chips).toHaveLength(1);
    expect(answered.chips[0]!.id).toBe("scorer:H-second");
  });

  it("returns null for any other event type", () => {
    expect(buildDock(SUMMARY_TYPE, view(), t, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// activityDetail()
// ---------------------------------------------------------------------------

describe("activityDetail()", () => {
  const ctx = (eventType: string, payload: Record<string, unknown>, state: unknown = {}) => ({
    t,
    eventType,
    payload,
    personNames: NAMES,
    state,
  });

  // R5, found by reading the ribbon on a real 320px screen after five taps:
  // volleyball's halves are TEAM-level, so an unattributed rally is the
  // ORDINARY case here, not an edge one — and every one of those rows read
  // "Rally recorded" with its own Void control beside it.
  it("names the winning SIDE when nobody was attributed — volleyball's ordinary tap", () => {
    const folded = foldClient(volleyball, VB_CFG, TEAM, stream());
    expect(volleyballDetail(ctx(RALLY_TYPE, { wonBy: "H" }, folded))).toBe("scorepad.attribution.home");
    expect(volleyballDetail(ctx(RALLY_TYPE, { wonBy: "A" }, folded))).toBe("scorepad.attribution.away");
    // A named person still wins: it is the more specific fact.
    expect(volleyballDetail(ctx(RALLY_TYPE, { wonBy: "H", scorer: "H-p3" }, folded))).toBe("Home MB1");
  });

  it("a rally names the scorer first, the server second", () => {
    expect(volleyballDetail(ctx(RALLY_TYPE, { scorer: "H-p3", server: "H-p1" }))).toBe("Home MB1 · Home Setter");
  });

  it("a summary states the score, and flags a partial one", () => {
    expect(volleyballDetail(ctx(SUMMARY_TYPE, { home: 25, away: 20 }))).toBe("25–20");
    expect(volleyballDetail(ctx(SUMMARY_TYPE, { home: 25, away: 20, partial: true }))).toBe("25–20 · pad.volleyball.ribbon.partial");
  });

  it("a sanction states the level, the person, and any free-text reason", () => {
    expect(volleyballDetail(ctx(SANCTION_TYPE, { level: "warning", person: "H-p3" }))).toContain("Home MB1");
  });

  it("a timeout resolves the side from the fold, never a raw entrant id", () => {
    const state = { entrants: { home: "H", away: "A" } };
    expect(volleyballDetail(ctx(TIMEOUT_TYPE, { by: "A" }, state))).toBe("scorepad.attribution.away");
  });

  it("an unknown type returns undefined — the ribbon falls to its own generic fallback", () => {
    expect(volleyballDetail(ctx("volleyball.expedite.start", {}))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// factory wiring — every builder is threaded the REAL translator
// ---------------------------------------------------------------------------

describe("factory wiring — every builder is threaded the REAL translator", () => {
  const XLATE: TFn = (key, vars) => `XLATED:${key}${vars ? JSON.stringify(vars) : ""}`;
  const skin = volleyballSkinV3(XLATE);

  it("identifies as volleyball, tap model S", () => {
    expect(skin.key).toBe("volleyball");
    expect(skin.tapModel).toBe("S");
  });

  it("threads it into the scorebug — context, halves and strip labels", () => {
    const spec = skin.scorebug(view({ events: stream(rally("H")) }));
    expect(spec.context.startsWith("XLATED:")).toBe(true);
    expect(spec.halves[0]!.who[0]!.name.startsWith("XLATED:")).toBe(true);
    for (const item of spec.strip) if (item.label !== undefined) expect(item.label.startsWith("XLATED:")).toBe(true);
  });

  it("threads it into the tiles' pre-localised text", () => {
    const tile = skin.tiles(view({ band: 2 })).find((entry) => entry.id === RALLY_LOCKED_TILE_ID)!;
    expect(tile.labelText!.startsWith("XLATED:")).toBe(true);
    expect(tile.sublabelText!.startsWith("XLATED:")).toBe(true);
  });

  it("threads it into the sheets' titles", () => {
    const sheets = skin.sheets!(view());
    for (const sheet of Object.values(sheets)) for (const step of sheet.steps) expect(step.title.startsWith("XLATED:")).toBe(true);
  });

  it("threads it into the dock's title", () => {
    const dock = skin.dock(RALLY_TYPE, view({ events: stream(rally("H")) }), { wonBy: "H" })!;
    expect(dock.title.startsWith("XLATED:")).toBe(true);
  });

  it("threads it into the context strip's message", () => {
    const spec = skin.context!(view({ band: 2 }))!;
    expect(spec.slots[0]!.message!.startsWith("XLATED:")).toBe(true);
  });

  // "threads it into the swap sheet's blocked reason" RETIRED 2026-08-30: it
  // exercised the same FIVB 15.6 cycle as above to produce a blocked
  // "H-p3", then asserted `blocked["H-p3"]!.startsWith("XLATED:")` — proving
  // `liberoCandidatesFor`'s `t(LIBERO_REFUSAL_KEY[reason])` call used the
  // REAL injected translator, not a hardcoded string. `bringOn`'s
  // `exemptReplacement` change means `liberoBlockedReason` now always
  // returns `null` (see its own doc comment) — that `t(...)` call site is
  // dead code, unreachable from any input this file can construct, so no
  // state exists that would make the old assertion true any more. Not
  // replaced with a direct `t(LIBERO_REFUSAL_KEY[...])` call: that would
  // test the map and the translator in isolation, exactly the "mirror" this
  // suite's own header warns against, not whether THIS builder threads `t`
  // through. If `blocked` ever becomes reachable from this file again,
  // restore this test alongside whatever makes it reachable.

  it("declares swap() (unlike badminton/table tennis) and no contextSelect() — a readOnly slot's picker can never open", () => {
    expect(skin.swap).toBeDefined();
    expect(skin.contextSelect).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// degenerate view — the no-fold, no-config, no-lineup mount
// ---------------------------------------------------------------------------

describe("degenerate view — a pad mounted before any fold exists", () => {
  it("never throws, and reports every fact it cannot know as absent", () => {
    const v = degenerateView();
    expect(() => buildScorebug(v, t)).not.toThrow();
    const spec = buildScorebug(v, t);
    expect(spec.halves[0]!.big).toBe("0");
    // No cfg at all (`cfg.records` undefined) — `serveContextOf` refuses to
    // replay against a half-built config rather than reporting a confident
    // answer off it, so the reader itself is `null`, not merely unresolved.
    expect(ctxOf(v)).toBeNull();
    expect(buildSwap(v, t)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// COPY TRUTH — a key used only inside a returned SPEC has NO other gate
// ---------------------------------------------------------------------------

describe("copy truth", () => {
  function collectLabelKeys(): Set<string> {
    const keys = new Set<string>();
    for (const key of [
      "pad.volleyball.context.line",
      "pad.volleyball.context.deuce",
      "pad.volleyball.context.goldenPoint",
      "pad.volleyball.context.recording",
      "pad.volleyball.context.recording.locked",
      "pad.volleyball.scorebug.strip.sets",
      "pad.volleyball.scorebug.strip.server",
      "pad.volleyball.scorebug.strip.rotation",
      "pad.volleyball.tile.rallyLocked",
      "pad.volleyball.tile.rallyLocked.sublabel",
      "pad.volleyball.dock.rally.scorer.title",
      "pad.volleyball.dock.person",
      "pad.volleyball.ribbon.partial",
      "pad.volleyball.sheet.libero.off.title",
      "pad.volleyball.sheet.libero.on.title",
      "pad.volleyball.swap.refused.reentryLimit",
      "pad.volleyball.swap.refused.reentryPosition",
      "pad.volleyball.action.serveAnchor",
      "pad.volleyball.sheet.serveAnchor.serving.title",
      "pad.volleyball.sheet.serveAnchor.wonBy.title",
      "pad.swap.refused",
    ]) {
      keys.add(key);
    }
    const liberoEvents = stream(
      liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"]),
      liberoSwap("H", "H-lib", "H-p3", "MB"),
      liberoSwap("H", "H-p3", "H-lib", "MB", ["libero"]),
    );
    const sweep: { band: FidelityBand; events: EventEnvelope[]; lineups: LineupPair }[] = [
      { band: 0, events: stream(), lineups: TEAM },
      // 0-0, band 3 — the serve anchor tile is live only here.
      { band: 3, events: stream(), lineups: TEAM },
      { band: 1, events: stream(rally("H")), lineups: TEAM },
      { band: 2, events: stream(summary(25, 15)), lineups: PAIR },
      { band: 3, events: stream(rally("H"), rally("A")), lineups: PAIR },
      { band: 3, events: liberoEvents, lineups: TEAM },
    ];
    for (const { band, events, lineups } of sweep) {
      const v = view({ band, events, lineups, cfg: lineups === PAIR ? BEACH_CFG : VB_CFG });
      for (const tile of buildTiles(v, t)) {
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
      for (const half of scorebug.halves) if (half.hintKey !== undefined) keys.add(half.hintKey);
      const strip = buildContextStrip(v, t);
      for (const slot of strip?.slots ?? []) keys.add(slot.label);
      const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "H" });
      for (const chip of dock?.chips ?? []) keys.add(chip.label);
      for (const slot of buildSwap(v, t)) {
        keys.add(slot.offLabel);
        keys.add(slot.onLabel);
        for (const message of Object.values(slot.blocked ?? {})) keys.add(message);
      }
    }
    return keys;
  }

  it("every key this skin's specs reference exists in the English dictionary", () => {
    const dict = uiEn as Record<string, string>;
    const missing = [...collectLabelKeys()].filter((key) => !(key in dict)).sort();
    expect(missing).toEqual([]);
  });

  it("collects a non-trivial set — a walk that found nothing would pass the check above vacuously", () => {
    expect(collectLabelKeys().size).toBeGreaterThan(20);
  });

  it("every hintKey the scorebug emits is REGISTERED in PAD_LABEL_KEYS, not merely translated", () => {
    const registered = new Set<string>(PAD_LABEL_KEYS);
    const hints = new Set<string>();
    for (const band of [0, 1, 2, 3] as const) {
      for (const half of buildScorebug(view({ band, events: stream(rally("H")) }), t).halves) {
        if (half.hintKey !== undefined) hints.add(half.hintKey);
      }
    }
    expect(hints.size).toBeGreaterThan(0);
    for (const key of hints) expect(registered.has(key), `${key} is not in PAD_LABEL_KEYS`).toBe(true);
  });

  it("every event type this skin dispatches directly has a REGISTERED ribbon key", () => {
    const registered = new Set<string>(PAD_LABEL_KEYS);
    for (const type of [RALLY_TYPE, SUMMARY_TYPE, SANCTION_TYPE, TIMEOUT_TYPE]) {
      const key = ribbonKeyFor(type);
      expect(registered.has(key), `${key} is not in PAD_LABEL_KEYS — the ribbon stays on the fallback`).toBe(true);
      expect(key in (uiEn as Record<string, string>), `${key} has no English copy`).toBe(true);
    }
  });
});
