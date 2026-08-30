// R5 — badminton SkinDefV3. Pure-data assertions (apps/web vitest is
// `environment: "node"`, no jsdom): the skin is a spec BUILDER, so this file
// asserts the specs it returns and leaves the DOM to
// `e2e/scorepad-v3-badminton.spec.ts`.
//
// EVERY STATE HERE COMES OUT OF THE REAL FOLD. `foldClient(badminton, ...)`
// over real `EventEnvelope`s, never a hand-typed state literal — three suites
// in this programme have shipped false-green by mirroring the skin's own
// reading of a state shape back at it, and the serve reader in particular
// (`setBasedServeContext`, R5-1) is a walk over the LEDGER whose answer a
// hand-written `{sets: [...]}` cannot reproduce at all.
//
// The one deliberate exception is `degenerateView()`, which exists precisely
// to assert the no-fold degrade path — and it is named so nobody mistakes it
// for a shortcut.
import { describe, expect, it } from "vitest";
import uiEn from "@/dictionaries/en/ui.json";
import { PAD_LABEL_KEYS } from "@/lib/scoring-vocab";
import { ribbonKeyFor } from "../../ribbon";
import type { EventEnvelope, Lineup, LineupPair, SquadState } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import type { FidelityBand, ModuleEvent } from "@seazn/engine/sport";
import { makeEnvelope } from "@seazn/engine/testkit";
import { badminton } from "@seazn/engine/sports/setbased";
import { foldClient } from "../../../module-client";
import { assertDisabledTilesExplained } from "../../tile-grid";
import { assertScorebugSpec, type PadHostView, type TileSpec } from "../../types";
import { dedicatedEventTypes, filterTilesByBand, moreActions } from "../../pad-host";
import {
  EVENT_BAND,
  EXPEDITE_TYPE,
  RALLY_ENTITLEMENT,
  RALLY_LOCKED_TILE_ID,
  RALLY_TYPE,
  SANCTION_LEVELS,
  SANCTION_TYPE,
  SET_SCORE_TILE_ID,
  SUB_TYPE,
  SUMMARY_TYPE,
  TIMEOUT_TYPE,
  badmintonDetail,
  badmintonSkinV3,
  buildContextStrip,
  buildDock,
  buildScorebug,
  buildSheets,
  buildTiles,
  refusedEventTypes,
  resolvePhase,
  sanctionSheetKey,
  serveContextOf,
} from "../badminton";
import type { TFn } from "../badminton";

// ---------------------------------------------------------------------------
// Fixtures — the fold, and nothing but the fold
// ---------------------------------------------------------------------------

/** The oracle `t`. It ECHOES ITS INPUT, including the vars, so an assertion on
 *  a built string cannot pass by coincidence when a branch resolves the WRONG
 *  key — ribbon.test.ts's own "the oracle MUST discriminate by its input"
 *  lesson. */
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
 *  `pairOrder` — the same trap `setbased/lineup.test.ts`'s own `pairSide`
 *  sets — so a reader that quietly sorted by `orderNo` names the wrong player
 *  and this file notices. */
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

const BWF_CFG = badminton.configSchema.parse({});
/** A legal SHORT config — games to 3, cap 5. `cap >= max(setTo, finalSetTo)`
 *  is a schema refinement, so this is parsed rather than hand-built. Used
 *  wherever a test needs a whole game played out rally by rally without
 *  writing 21 events. */
const SHORT_CFG = badminton.configSchema.parse({ setTo: 3, finalSetTo: 3, cap: 5 });

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
const summary = (home: number, away: number): readonly [string, unknown] => [
  SUMMARY_TYPE,
  { home, away },
];

interface ViewOpts {
  band?: FidelityBand;
  lineups?: LineupPair;
  cfg?: typeof BWF_CFG;
  events?: EventEnvelope[];
  entitlements?: Record<string, boolean>;
}

/** A `PadHostView` whose `state` is the REAL fold of `events` and whose
 *  `events` is that same ledger — the two halves `setBasedServeContext` needs,
 *  and they must describe the same match or the reader reports
 *  `ledger-mismatch` (which is itself asserted below). */
function view(opts: ViewOpts = {}): PadHostView {
  const lineups = opts.lineups ?? SINGLES;
  const cfg = opts.cfg ?? BWF_CFG;
  const events = opts.events ?? stream();
  const state = foldClient(badminton, cfg, lineups, events);
  return {
    cfg,
    state,
    summary: {},
    phase: "live",
    band: opts.band ?? 3,
    entitlements: opts.entitlements ?? { [RALLY_ENTITLEMENT]: true },
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
    squads: initSquads(SINGLES) as SquadState,
    events: [],
    contextOverrides: {},
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
  const spec = badminton.padSpec!(BWF_CFG);

  it("EVENT_BAND is padSpec's own `fidelity` map, entry for entry", () => {
    expect(EVENT_BAND).toEqual(spec.fidelity);
  });

  it("RALLY_ENTITLEMENT is the feature key padSpec gates band 3 behind", () => {
    // Named wrong, the D-7 notice upsells a plan that would not unlock
    // anything — a worse outcome than the silence it replaces.
    expect(spec.fidelityEntitlements[3]).toBe(RALLY_ENTITLEMENT);
  });

  it("SANCTION_LEVELS is the ladder padSpec itself offers, in padSpec's own order", () => {
    // BWF has THREE cards and the black one is why this list is per sport:
    // offering the FIVB's four steps on a pad with the ITTF's two would put a
    // sanction on screen the federation has no concept of. Read off the
    // published `padSpec` rather than the preset object, which is the surface
    // the legacy lane already renders from — so the two lanes can never offer
    // different ladders for the same sport.
    const action = spec.panels
      .flatMap((panel) => panel.actions)
      .find((entry) => entry.type === SANCTION_TYPE)!;
    const level = action.fields.find((field) => field.path === "level") as { values: readonly string[] };
    expect(SANCTION_LEVELS).toEqual([...level.values]);
  });

  it("SUMMARY_TYPE is the FULLY QUALIFIED coarse type, never the preset's bare half", () => {
    expect(SUMMARY_TYPE).toBe("badminton.game.summary");
    expect(SUMMARY_TYPE).not.toBe(badminton.coarseEventType);
  });
});

// ---------------------------------------------------------------------------
// phase() — the five engine phases mapped onto the closed three
// ---------------------------------------------------------------------------

describe("phase()", () => {
  it("is `pre` before core.start", () => {
    const v = view({ events: [] });
    expect(resolvePhase(v)).toBe("pre");
  });

  it("is `live` once the match has started", () => {
    expect(resolvePhase(view())).toBe("live");
  });

  it("is `post` once the match is decided — a real fold, not a typed-in phase", () => {
    // Best of 3 to 3 points: two games decides it.
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
// D-17 — who is serving. The wave's headline, and the assertion the gallery
// capture inverts.
// ---------------------------------------------------------------------------

describe("serving (D-17) — from the engine's ledger reader, never a placeholder", () => {
  it("renders NOTHING at all before the first rally — no strip item, no serving dot", () => {
    // The BWF's first server comes from a toss this kernel does not fold, so
    // the reader answers `serveOrderKnown: false`. The defect this replaces
    // was an em dash printed here; a DIFFERENT placeholder would be the same
    // defect in a new glyph, so the item must be absent, not empty.
    const spec = buildScorebug(view(), t);
    expect(spec.strip.map((item) => item.id)).not.toContain("server");
    expect(spec.halves.flatMap((half) => half.who).some((who) => who.serving)).toBe(false);
  });

  it("names the rally winner as the next server — BWF Law 10.1, swept both ways", () => {
    // SWEPT, not pinned once: a rotation bug that always answered "home" would
    // pass half of a single-case test. Each case plays one more rally than the
    // last, so the parity of the rally count differs too.
    const cases: { last: "H" | "A"; expected: string }[] = [
      { last: "H", expected: NAMES.H1! },
      { last: "A", expected: NAMES.A1! },
    ];
    for (const { last, expected } of cases) {
      const v = view({ events: stream(rally("H"), rally("A"), rally(last)) });
      expect(stripItem(v, "server")?.value, `after a rally won by ${last}`).toBe(expected);
    }
  });

  it("marks the serving player's own WhoLine, with a servingLabel beside it", () => {
    const spec = buildScorebug(view({ events: stream(rally("H")) }), t);
    const home = spec.halves[0]!;
    const away = spec.halves[1]!;
    expect(home.who[0]!.serving).toBe(true);
    // R1's standing item, and the reason it is standing: `serving: true` with
    // no label renders an aria-hidden dot and NOTHING for a screen reader.
    expect(home.who[0]!.servingLabel).toBe("pad.badminton.scorebug.serving");
    expect(away.who[0]!.serving).toBeUndefined();
  });

  it("follows the serve across a GAME change — Law 8.1, the game winner serves first", () => {
    // The set-transition rule, exercised at a real boundary rather than at
    // turn 0 (R4's D-21: turn 0 names the right player under every derivation
    // anyone has shipped, correct or not). Game 1 is banked by SUMMARY, which
    // is also the shape the gallery capture uses.
    //
    // ISOLATED ON PURPOSE — no rally after the summary. A rally would hand
    // the serve to its own winner under Law 10.1, so `summary + rally(H)`
    // names home whether or not Law 8.1 is implemented at all: the
    // set-transition rule and the rally-winner rule would agree by
    // construction and the test would prove only the second one. Asserting
    // BEFORE any rally in the new game is the only shape that isolates it.
    const homeWon = view({ events: stream(summary(21, 15)) });
    const awayWon = view({ events: stream(summary(15, 21)) });
    expect(stripItem(homeWon, "server")?.value).toBe(NAMES.H1);
    expect(stripItem(awayWon, "server")?.value).toBe(NAMES.A1);
    // Both directions, and a SECOND transition — a rule that simply answered
    // "whoever won the first game" would pass the pair above.
    const twoGames = view({ events: stream(summary(21, 15), summary(10, 21)) });
    expect(stripItem(twoGames, "server")?.value).toBe(NAMES.A1);
    // ...and the games really did change, so this is not game 1 in disguise.
    expect(buildScorebug(homeWon, t).context).toContain('"game":2');
    expect(buildScorebug(twoGames, t).context).toContain('"game":3');
  });

  // Review of PR #678 — the DECIDED board. `gameNumber` is "closed games plus one",
  // right while a match is live and wrong the moment it ends: every game is
  // then closed, so a decided best-of-3 board announced "Game 4" — a
  // game nobody played. Not a transient: the scorebug renders its context in
  // EVERY phase and pad-host renders the scorebug in "post", so this is a real
  // screen. Now clamped to `bestOf`.
  it("never names a game past `bestOf` on a DECIDED board", () => {
    const done = view({ cfg: SHORT_CFG, events: stream(summary(3, 1), summary(1, 3), summary(3, 1)) });
    expect(buildScorebug(done, t).context, "a decided board announced a game nobody played").toContain(
      '"game":3',
    );
    expect(buildScorebug(done, t).context).not.toContain('"game":4');
  });

  it("REVIEW #678/5 — a DECIDED board shows the match result, not a giant 0-0", () => {
    // `pointsOf` reads the OPEN game and returns 0 when there is none. Every
    // game is closed once a match is decided, so the biggest number on the
    // screen — the one a player looks at from across the court — read 0 for
    // both sides, with only the small games strip carrying the result.
    const done = view({ cfg: SHORT_CFG, events: stream(summary(3, 1), summary(1, 3), summary(3, 1)) });
    const [home, away] = buildScorebug(done, t).halves;
    expect([home.big, away.big], "a decided board showed 0-0 as its headline number").not.toEqual([
      "0",
      "0",
    ]);
    // The LAST game's score is what the board should rest on — the one just
    // played, which is also what a paper scoresheet shows.
    expect(home.big).toBe("3");
    expect(away.big).toBe("1");
  });

  it("REVIEW #678/7 — a DECIDED board names only games actually PLAYED, not `bestOf`", () => {
    // The clamp to `bestOf` removed "Game 6" but not the class: a best-of-3
    // won 2-0 has two games in the book and `gameNumber` (closed + 1) says 3.
    const straight = view({ cfg: SHORT_CFG, events: stream(summary(3, 1), summary(3, 1)) });
    expect(buildScorebug(straight, t).context, "named a game nobody played").toContain('"game":2');
    expect(buildScorebug(straight, t).context).not.toContain('"game":3');
  });

  it("names a SIDE, never a person, for a doubles pair — BWF Law 10.5 reads the service COURT", () => {
    // The engine declares no `serverFromPairOrder` for badminton precisely
    // because the laws pick the server from a fact this kernel does not fold.
    // Naming "whichever name got marked" is the D-21 defect; a side is the
    // true answer and this asserts we stop there.
    const v = view({ lineups: DOUBLES, events: stream(rally("H")) });
    expect(stripItem(v, "server")?.value).toBe("scorepad.attribution.home");
    expect(buildScorebug(v, t).halves.flatMap((half) => half.who).some((who) => who.serving)).toBe(false);
  });

  it("refuses to answer when the ledger and the folded state describe different matches", () => {
    // `ledger-mismatch` — the reader's second drift detector. A truncated
    // ledger beside a fully-folded state must report unknown rather than name
    // a confidently wrong side.
    const events = stream(rally("H"), rally("A"), rally("H"));
    const v = { ...view({ events }), events: events.slice(0, 2) };
    expect(stripItem(v, "server")).toBeUndefined();
  });

  it("relies on ONE engine invariant, and asserts it rather than double-guarding it", () => {
    // `servingInfo` guards on `ctx.side === null` alone, because
    // `SetBasedServeContext`'s own documented invariant is
    // `serveOrderKnown === (servingSide !== null)`. A second guard on
    // `serveOrderKnown` would be a check that can never disagree with the
    // first — and a redundant pair is a pair where neither half can be killed
    // by mutation, which is how this file first passed with the guard removed.
    // So the invariant is proven here, across every shape this skin drives the
    // reader with, instead of being defended against twice in the source.
    const shapes: EventEnvelope[][] = [
      [],
      stream(),
      stream(rally("H")),
      stream(summary(21, 15)),
      stream(summary(21, 15), rally("A"), rally("A")),
      stream(rally("H"), rally("A"), rally("H")).slice(0, 3),
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
    // Both branches genuinely occurred — an invariant proven only on the true
    // side is half an invariant.
    expect(sawBoth).toBe(3);
  });

  it("degrades to silence, not a crash, for a pad mounted before any fold", () => {
    const spec = buildScorebug(degenerateView(), t);
    expect(spec.strip.map((item) => item.id)).not.toContain("server");
    expect(assertScorebugSpec(spec)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scorebug — D-11, the interval, and the tap payload
// ---------------------------------------------------------------------------

describe("scorebug", () => {
  it("states the score ONCE (D-11): the halves carry points, the strip carries GAMES", () => {
    const v = view({ events: stream(summary(21, 15), rally("H"), rally("H")) });
    const spec = buildScorebug(v, t);
    expect(spec.halves.map((half) => half.big)).toEqual(["2", "0"]);
    // The strip's own figure is the games-won tally — a DIFFERENT fact, not a
    // second rendering of the same one. The v2 lane stated the score three
    // times above the fold; this asserts the retirement rather than assuming it.
    expect(stripItem(v, "games")?.value).toBe("1–0");
    const readouts = spec.strip.map((item) => item.value);
    expect(readouts).not.toContain("2");
    expect(assertScorebugSpec(spec)).toEqual([]);
  });

  it("words the endgame BWF has words for — setting at 20-all, golden point at 29-all", () => {
    const setting = view({ events: stream(...Array.from({ length: 40 }, (_, i) => rally(i % 2 === 0 ? "H" : "A"))) });
    expect(buildScorebug(setting, t).context).toContain("pad.badminton.context.setting");
    const golden = view({ events: stream(...Array.from({ length: 58 }, (_, i) => rally(i % 2 === 0 ? "H" : "A"))) });
    expect(buildScorebug(golden, t).context).toContain("pad.badminton.context.goldenPoint");
    // ...and neither fires on an ordinary score.
    const ordinary = view({ events: stream(rally("H"), rally("A")) });
    expect(buildScorebug(ordinary, t).context).not.toContain("pad.badminton.context.setting");
  });

  it("hints the interval AHEAD of it, announces it AT it, and drops it after — derived from the target, not hardcoded 11", () => {
    const ahead = view({ events: stream(...Array.from({ length: 10 }, () => rally("H"))) });
    expect(stripItem(ahead, "interval")).toEqual({
      id: "interval",
      label: "pad.badminton.scorebug.strip.interval",
      value: "11",
    });
    const at = view({ events: stream(...Array.from({ length: 11 }, () => rally("H"))) });
    expect(stripItem(at, "interval")?.value).toBe("pad.badminton.scorebug.strip.intervalNow");
    const past = view({ events: stream(...Array.from({ length: 12 }, () => rally("H"))) });
    expect(stripItem(past, "interval")).toBeUndefined();
    // The SHORT variant's own halfway mark, which is what proves the number is
    // derived: a hardcoded 11 is unreachable in a game to 3.
    const short = view({ cfg: SHORT_CFG, events: stream() });
    expect(stripItem(short, "interval")?.value).toBe("2");
  });

  // R5 review finding 4 — THE STREAM ABOVE CANNOT SEE THIS, BY CONSTRUCTION.
  // It scores one side every rally, so `leader` never sits still while the game
  // moves under it, and the only way past the mark is `leader > mark`. A real
  // game does the opposite: the trailing side wins points, the leader stays on
  // 11, and the strip went on announcing "Interval" at 11-10 and again at
  // 11-11 — two rallies and then four after the 60 seconds had been taken and
  // play had resumed. It cleared only at 12-11.
  it("drops the interval once play has RESUMED, not merely once the score has moved past the mark", () => {
    const to11 = Array.from({ length: 11 }, () => rally("H"));
    // 11-9 with home's OWN rally last: home took the mark on that rally and so
    // serves the next one (BWF 8.1) — the announcement is live. The away points
    // come FIRST here for exactly that reason; ordering them the other way puts
    // away on serve at the same 11-9 board, which is the state below.
    const announced = view({ events: stream(...Array.from({ length: 9 }, () => rally("A")), ...to11) });
    expect(
      stripItem(announced, "interval")?.value,
      "11-9 with home still serving — the interval is happening now",
    ).toBe("pad.badminton.scorebug.strip.intervalNow");

    // 11-10: AWAY won the last rally, so away serves and the interval is over.
    // `leader` is still 11 — the old `leader > mark` test could not tell these
    // two boards apart.
    const resumed = view({
      events: stream(...to11, ...Array.from({ length: 10 }, () => rally("A"))),
    });
    expect(stripItem(resumed, "interval"), "11-10 — play resumed two rallies ago").toBeUndefined();

    // 11-11: long past, and never ambiguous.
    const level = view({ events: stream(...to11, ...Array.from({ length: 11 }, () => rally("A"))) });
    expect(stripItem(level, "interval"), "11-11").toBeUndefined();
  });

  it("names the SERVICE COURT beside the server — BWF Law 10.2, and only while the serve is known", () => {
    // Right on an even score, left on an odd one, read off the SERVING side's
    // own points. Both parities, and both sides serving, because a rule keyed
    // on the wrong side's score agrees with this one about half the time.
    const homeEven = view({ events: stream(rally("A"), rally("H"), rally("H")) }); // home serving, home on 2
    expect(stripItem(homeEven, "server")?.value).toBe(NAMES.H1);
    expect(stripItem(homeEven, "court")?.value).toBe("pad.badminton.scorebug.strip.court.right");
    const homeOdd = view({ events: stream(rally("H")) }); // home serving, home on 1
    expect(stripItem(homeOdd, "court")?.value).toBe("pad.badminton.scorebug.strip.court.left");
    const awayOdd = view({ events: stream(rally("H"), rally("A")) }); // away serving, away on 1
    expect(stripItem(awayOdd, "server")?.value).toBe(NAMES.A1);
    expect(stripItem(awayOdd, "court")?.value).toBe("pad.badminton.scorebug.strip.court.left");
    // Unknown serve, no court: a court derived from a side nobody can name is
    // a confident wrong answer wearing a true rule.
    expect(stripItem(view(), "court")).toBeUndefined();
    // ...and no court once the match is over, for the same reason the interval
    // stops: status that outlives its match is furniture.
    const done = view({ cfg: SHORT_CFG, events: stream(summary(3, 1), summary(3, 0)) });
    expect(stripItem(done, "court")).toBeUndefined();
    expect(stripItem(done, "interval")).toBeUndefined();
  });

  it("gives the SERVE the only weight step on the strip — accented, while everything beside it stays muted", () => {
    const spec = buildScorebug(view({ events: stream(rally("H")) }), t);
    const accented = spec.strip.filter((item) => item.accent === true).map((item) => item.id);
    expect(accented, "the serve is the board's thesis and must lead its own row").toEqual(["server"]);
    // Non-vacuous: this strip really does carry other items to be quieter than.
    expect(spec.strip.length).toBeGreaterThan(2);
  });

  it("spends the LED accent on the serve and nothing else — no strip item asks for the LED panel", () => {
    // R5-3 / R4-4's discipline. The chassis already paints the serve pip, the
    // score digits and the board's top hairline from `--sport-led`; a strip
    // item taking `tone: "led"` would be a fourth thing shouting. The interval
    // is the loudest candidate and is deliberately the quietest treatment.
    for (const events of [stream(), stream(rally("H")), stream(...Array.from({ length: 11 }, () => rally("H")))]) {
      for (const item of buildScorebug(view({ events }), t).strip) {
        expect(item.tone, `strip item "${item.id}" reaches for the accent`).toBeUndefined();
      }
    }
  });

  it("halves are tappable at band 3 and INERT below it, with a hint iff tappable", () => {
    const live = buildScorebug(view(), t);
    for (const half of live.halves) {
      expect(half.tappable).toBe(true);
      expect(half.hintKey).toBe("pad.badminton.scorebug.rally.hint");
      expect(half.tapEvent?.type).toBe(RALLY_TYPE);
    }
    for (const band of [0, 1, 2] as const) {
      for (const half of buildScorebug(view({ band }), t).halves) {
        expect(half.tappable).toBe(false);
        expect(half.tapEvent).toBeUndefined();
      }
    }
    // ...and the same at band 3 once the match is over.
    const done = view({ cfg: SHORT_CFG, events: stream(summary(3, 1), summary(3, 0)) });
    for (const half of buildScorebug(done, t).halves) expect(half.tappable).toBe(false);
  });

  it("stamps the SINGLES scorer and server into the tap itself — R5-2's 'nothing to choose'", () => {
    const v = view({ events: stream(rally("H")) });
    const [home, away] = buildScorebug(v, t).halves;
    expect(home!.tapEvent!.payload).toEqual({ wonBy: "H", server: "H1", scorer: "H1" });
    // The AWAY half's tap still carries HOME's server: `server` is who served
    // the rally, not who won it. Getting these two the same way round is the
    // whole reason the kernel's own schema doc warns about the pair.
    expect(away!.tapEvent!.payload).toEqual({ wonBy: "A", server: "H1", scorer: "A1" });
  });

  it("never stamps a scorer or a server for a PAIR — neither is knowable at tap time", () => {
    const v = view({ lineups: DOUBLES, events: stream(rally("H")) });
    expect(buildScorebug(v, t).halves[0]!.tapEvent!.payload).toEqual({ wonBy: "H" });
  });

  it("never sends `serving` on the rally — it is the umpire's observation, not ours", () => {
    // Filling it from our own derivation would make `setBasedServeWalk`'s
    // drift detector compare a belief with itself and agree forever.
    for (const lineups of [SINGLES, DOUBLES]) {
      const v = view({ lineups, events: stream(rally("H"), rally("A")) });
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
  it("declares the sanction pair FIRST, span 2 each, home in column 0 and away in column 2", () => {
    // The two-lane board. `tile-grid.tsx` is a bare `grid-cols-4` and enforces
    // nothing — football's R3/B2 put Home's second yellow bodily inside the
    // AWAY lane with 65 green assertions. Modelled here the way CSS
    // auto-placement actually works, so array order is pinned as ROW order.
    const tiles = buildTiles(view(), t);
    let col = 0;
    const columns = new Map<string, number>();
    for (const tile of tiles) {
      const span = tile.span ?? 1;
      if (col + span > 4) col = 0;
      columns.set(tile.id, col);
      col = (col + span) % 4;
    }
    for (const side of ["home", "away"] as const) {
      const tile = tileById(tiles, sanctionSheetKey(side))!;
      expect(tile.span, `${side} sanction tile must own a whole lane`).toBe(2);
      expect(tile.sublabel).toBeDefined();
    }
    expect(columns.get(sanctionSheetKey("home"))).toBe(0);
    expect(columns.get(sanctionSheetKey("away"))).toBe(2);
  });

  it("every side-owned tile spans exactly 2, and no side-less tile is squeezed between the pair", () => {
    const tiles = buildTiles(view(), t);
    const sided = tiles.filter((tile) => tile.sublabel !== undefined);
    for (const tile of sided) expect(tile.span).toBe(2);
    expect(tiles.slice(0, sided.length).map((tile) => tile.id)).toEqual(sided.map((tile) => tile.id));
  });

  it("withholds the Set score tile while the current game is being scored rally by rally (D-16)", () => {
    expect(tileById(buildTiles(view(), t), SET_SCORE_TILE_ID)).toBeDefined();
    const midGame = view({ events: stream(rally("H")) });
    expect(tileById(buildTiles(midGame, t), SET_SCORE_TILE_ID)).toBeUndefined();
    // ...and it comes back the moment the game closes, because the NEXT game
    // has no points yet.
    const betweenGames = view({ events: stream(summary(21, 15)) });
    expect(tileById(buildTiles(betweenGames, t), SET_SCORE_TILE_ID)).toBeDefined();
  });

  it("drops the sanction pair below band 1 and keeps Set score at band 0", () => {
    const tiles = buildTiles(view({ band: 0 }), t);
    expect(tileById(tiles, sanctionSheetKey("home"))).toBeUndefined();
    expect(tileById(tiles, SET_SCORE_TILE_ID)).toBeDefined();
  });

  it("declares no tiles outside `live` — every tile names the live phase only", () => {
    for (const tile of buildTiles(view(), t)) expect(tile.phases).toEqual(["live"]);
    expect(buildTiles(view({ events: [] }), t).filter((tile) => tile.phases.includes("pre"))).toEqual([]);
  });

  it("honours THIS FIXTURE's records flag, not the preset's default", () => {
    const noSanctions = badminton.configSchema.parse({
      records: { timeouts: false, sanctions: false, substitutions: false, expedite: false },
    });
    const v = view({ cfg: noSanctions });
    expect(tileById(buildTiles(v, t), sanctionSheetKey("home"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D-7 — the band-limited screen, which used to be silence
// ---------------------------------------------------------------------------

describe("D-7 — below band 3 the pad SAYS SO, in badminton's own words", () => {
  const limited = () => view({ band: 2, entitlements: {} });

  it("renders a visible, disabled rally tile instead of nothing at all", () => {
    const tile = tileById(buildTiles(limited(), t), RALLY_LOCKED_TILE_ID)!;
    expect(tile.disabled).toBe(true);
    expect(tile.span).toBe(4);
    expect(tile.labelText).toBe("pad.badminton.tile.rallyLocked");
    expect(tile.sublabelText).toBe("pad.badminton.tile.rallyLocked.sublabel");
  });

  it("survives the chassis's own band filter — the gate it exists to explain must not eat it", () => {
    // The trap this guards: a tile pointing at `badminton.rally` in ANY form
    // is dropped by `filterTilesByBand` for exactly the org this tile is for.
    const v = limited();
    const tiles = buildTiles(v, t);
    const sheets = buildSheets(v, t);
    const kept = filterTilesByBand(tiles, sheets, [], badminton.padSpec!(BWF_CFG).fidelity, new Set([0, 1, 2]));
    expect(kept.map((tile) => tile.id)).toContain(RALLY_LOCKED_TILE_ID);
  });

  it("carries the REASON on a context slot, naming the plan through the shared table", () => {
    const spec = buildContextStrip(limited(), t)!;
    expect(spec.slots).toHaveLength(1);
    const slot = spec.slots[0]!;
    expect(slot.readOnly).toBe(true);
    expect(slot.message).toContain("pad.badminton.context.recording.locked");
    // The plan is interpolated, and it is the plan the SAME `featurePlan()`
    // table the recording chip uses resolves — never a literal typed here.
    expect(slot.message).toContain('"plan":"Pro"');
  });

  it("pairs the disabled tile with that message — the chassis's own rule for a disabled tile", () => {
    const v = limited();
    expect(assertDisabledTilesExplained(buildTiles(v, t), buildContextStrip(v, t))).toEqual([]);
  });

  it("says nothing at all at band 3, or once the match is over", () => {
    expect(tileById(buildTiles(view(), t), RALLY_LOCKED_TILE_ID)).toBeUndefined();
    expect(buildContextStrip(view(), t)).toBeNull();
    const done = view({ cfg: SHORT_CFG, band: 2, events: stream(summary(3, 1), summary(3, 0)) });
    expect(buildContextStrip(done, t)).toBeNull();
    expect(tileById(buildTiles(done, t), RALLY_LOCKED_TILE_ID)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// refusedEventTypes()
// ---------------------------------------------------------------------------

describe("refusedEventTypes()", () => {
  it("refuses the coarse summary exactly while the fold would throw for it", () => {
    expect(refusedEventTypes(view())).not.toContain(SUMMARY_TYPE);
    expect(refusedEventTypes(view({ events: stream(rally("H")) }))).toContain(SUMMARY_TYPE);
    expect(refusedEventTypes(view({ events: stream(summary(21, 15)) }))).not.toContain(SUMMARY_TYPE);
  });

  it("refuses timeout / sub / expedite for every shipped BWF config", () => {
    // BWF has no timeouts and no substitutions; expedite is an ITTF system.
    // All three are REGISTERED types (the kernel union needs them for
    // bijection) whose fold refuses them outright.
    const refused = refusedEventTypes(view());
    for (const type of [TIMEOUT_TYPE, SUB_TYPE, EXPEDITE_TYPE]) expect(refused).toContain(type);
  });

  it("does NOT refuse a type this fixture's own cfg says it records", () => {
    // Per fixture, never the preset's declared defaults — `SetBasedCfg.records`
    // is a real config knob (S6/#416 moved it there precisely so a variant can
    // reshape it), so refusing unconditionally would block an action the fold
    // would have accepted.
    const withTimeouts = badminton.configSchema.parse({
      records: { timeouts: true, sanctions: true, substitutions: false, expedite: false },
    });
    expect(refusedEventTypes(view({ cfg: withTimeouts }))).not.toContain(TIMEOUT_TYPE);
  });

  it("keeps the More sheet free of every dead end — the two exclusion sets, together", () => {
    // The real integration: `moreActions` is what a scorer actually sees.
    // Rally is DEDICATED (tap model S — the halves' own tapEvent), summary is
    // REFUSED mid-game, and the three unrecordable types never build a panel.
    const v = view({ events: stream(rally("H")) });
    const tiles = buildTiles(v, t);
    const sheets = buildSheets(v, t);
    const scorebug = buildScorebug(v, t);
    const dedicated = dedicatedEventTypes(tiles, sheets, [], scorebug);
    expect(dedicated).toContain(RALLY_TYPE);
    const actions = moreActions(
      badminton.padSpec!(BWF_CFG),
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
  it("prefills the Set score sheet from the CURRENT game, and clamps to the cap", () => {
    const v = view({ events: stream(summary(21, 15)) });
    const sheet = buildSheets(v, t)[SET_SCORE_TILE_ID]!;
    expect(sheet.event).toBe(SUMMARY_TYPE);
    const [home, away] = sheet.steps;
    expect(home!.kind).toBe("number");
    // Between games there is no open game, so both start at zero — never at
    // the PREVIOUS game's final score, which is the stale-prefill trap.
    expect((home as { initial: number }).initial).toBe(0);
    expect((home as { max: number }).max).toBe(BWF_CFG.cap);
    expect((away as { max: number }).max).toBe(BWF_CFG.cap);
    expect(sheet.buildPayload({ home: "21", away: "19" })).toEqual({ home: 21, away: 19 });
  });

  it("prefills from the live score once the game is under way", () => {
    const v = view({ events: stream(rally("H"), rally("H"), rally("A")) });
    const sheet = buildSheets(v, t)[SET_SCORE_TILE_ID]!;
    expect((sheet.steps[0] as { initial: number }).initial).toBe(2);
    expect((sheet.steps[1] as { initial: number }).initial).toBe(1);
  });

  it("asks a PAIR who was carded and stamps a SINGLES side's sole player without asking", () => {
    const singles = buildSheets(view(), t)[sanctionSheetKey("home")]!;
    expect(singles.steps.map((step) => step.id)).toEqual(["level"]);
    expect(singles.buildPayload({ level: "warning" })).toEqual({ by: "H", level: "warning", person: "H1" });

    const doubles = buildSheets(view({ lineups: DOUBLES }), t)[sanctionSheetKey("away")]!;
    expect(doubles.steps.map((step) => step.id)).toEqual(["level", "person"]);
    const personStep = doubles.steps[1] as { candidates: readonly string[]; side: string };
    // First-named FIRST — `pairOrder`, not `orderNo`, which the fixture
    // deliberately runs the other way.
    expect(personStep.candidates).toEqual(["A-first", "A-second"]);
    expect(personStep.side).toBe("away");
    expect(doubles.buildPayload({ level: "penalty", person: "A-second" })).toEqual({
      by: "A",
      level: "penalty",
      person: "A-second",
    });
  });

  it("tones the ladder — yellow is a caution, everything above it is the dismissal end", () => {
    const sheet = buildSheets(view(), t)[sanctionSheetKey("home")]!;
    const level = sheet.steps[0] as { options: { id: string; tone?: readonly string[] }[] };
    expect(level.options.map((option) => option.id)).toEqual([...SANCTION_LEVELS]);
    expect(level.options.find((option) => option.id === "warning")!.tone).toEqual(["caution"]);
    for (const id of ["penalty", "expulsion", "disqualification"]) {
      expect(level.options.find((option) => option.id === id)!.tone).toEqual(["dismissal"]);
    }
  });

  it("every tile that opens a sheet names a sheet this skin actually declares", () => {
    for (const band of [0, 1, 2, 3] as const) {
      const v = view({ band });
      const sheets = buildSheets(v, t);
      for (const tile of buildTiles(v, t)) {
        if (!("sheet" in tile.action)) continue;
        if (tile.action.sheet.startsWith("__pad-host/")) continue;
        expect(Object.keys(sheets), `tile ${tile.id}`).toContain(tile.action.sheet);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// dock() — R5-2, the scorer question
// ---------------------------------------------------------------------------

describe("dock()", () => {
  it("returns nothing for a SINGLES rally — the scorer was stamped at tap time", () => {
    const v = view({ events: stream(rally("H")) });
    // THE PAYLOAD `buildHalf` ITSELF BUILDS, not a hand-made one. This
    // assertion used to read `.not.toBeNull()` under this very test name — the
    // suite asserting the opposite of what it claimed, and pinning the defect:
    // every singles rally opened a dock titled "Which player won it?" with one
    // pre-answered chip, because the settled-scorer branch returned before the
    // singles guard could run.
    expect(buildDock(RALLY_TYPE, v, t, { wonBy: "H", scorer: "H1", server: "H1" })).toBeNull();
    // ...and a payload with no scorer on a singles side still has nothing to
    // ask: the guard is "the side has one player", never "scorer is undefined".
    expect(buildDock(RALLY_TYPE, v, t, { wonBy: "H" })).toBeNull();
  });

  it("keeps the dock for a DOUBLES rally that already names its scorer — a real pair still has an answer to show", () => {
    // The singles guard must not swallow the settled-scorer confirmation the
    // step above it exists to provide: same shape as the singles case, one
    // player more on court, opposite outcome.
    const v = view({ lineups: DOUBLES, events: stream(rally("H")) });
    const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "H", scorer: "H-first" });
    expect(dock).not.toBeNull();
    expect(dock!.chips.map((chip) => chip.id)).toEqual(["scorer:H-first"]);
  });

  it("offers one chip per PAIR member, and the chip's mutate stamps the scorer", () => {
    const v = view({ lineups: DOUBLES, events: stream(rally("H")) });
    const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "H" })!;
    expect(dock.title).toBe("pad.badminton.dock.rally.scorer.title");
    expect(dock.chips.map((chip) => chip.id)).toEqual(["scorer:H-first", "scorer:H-second"]);
    // A display NAME, never routed through t() — a name is not a dictionary key.
    expect(dock.chips.map((chip) => chip.labelText)).toEqual([NAMES["H-first"], NAMES["H-second"]]);
    expect(dock.chips[1]!.mutate({ wonBy: "H" })).toEqual({ wonBy: "H", scorer: "H-second" });
  });

  it("asks the WINNING side's pair, never the loser's", () => {
    const v = view({ lineups: DOUBLES, events: stream(rally("H")) });
    const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "A" })!;
    expect(dock.chips.map((chip) => chip.id)).toEqual(["scorer:A-first", "scorer:A-second"]);
  });

  it("collapses to the chosen chip once a scorer lands — one way, and the alternative leaves", () => {
    const v = view({ lineups: DOUBLES, events: stream(rally("H")) });
    const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "H", scorer: "H-second" })!;
    expect(dock.chips.map((chip) => chip.id)).toEqual(["scorer:H-second"]);
  });

  it("declines every other event type outright", () => {
    const v = view({ lineups: DOUBLES });
    for (const type of [SUMMARY_TYPE, SANCTION_TYPE, TIMEOUT_TYPE, "core.start"]) {
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
  const FOLDED = foldClient(badminton, BWF_CFG, SINGLES, []);

  it("distinguishes two rallies of the same type by who scored them", () => {
    expect(badmintonDetail(ctx(RALLY_TYPE, { wonBy: "H", scorer: "H-first" }))).toBe(NAMES["H-first"]);
    expect(badmintonDetail(ctx(RALLY_TYPE, { wonBy: "H", scorer: "H-second", server: "A-first" }))).toBe(
      `${NAMES["H-second"]} · ${NAMES["A-first"]}`,
    );
    // No state to resolve `wonBy` against: nothing can be said, and a raw
    // entrant id is never printed at the scorer.
    expect(badmintonDetail(ctx(RALLY_TYPE, { wonBy: "H" }))).toBeUndefined();
  });

  it("names the winning SIDE when nobody was attributed, so two rallies are never the same row", () => {
    // A doubles rally sent before the dock's scorer question is answered
    // carries no person. Returning undefined made the ribbon a run of
    // identical "Rally recorded" rows, each with its own Void control — how
    // the wrong point gets voided at a scoring desk (found on a 320px screen).
    expect(badmintonDetail(ctx(RALLY_TYPE, { wonBy: "H" }, FOLDED))).toBe("scorepad.attribution.home");
    expect(badmintonDetail(ctx(RALLY_TYPE, { wonBy: "A" }, FOLDED))).toBe("scorepad.attribution.away");
    // A named person still wins: it is the more specific fact.
    expect(badmintonDetail(ctx(RALLY_TYPE, { wonBy: "H", scorer: "H-first" }, FOLDED))).toBe(NAMES["H-first"]);
  });

  it("reads a summary as its score, and flags a partial one", () => {
    expect(badmintonDetail(ctx(SUMMARY_TYPE, { home: 21, away: 15 }))).toBe("21–15");
    expect(badmintonDetail(ctx(SUMMARY_TYPE, { home: 11, away: 8, partial: true }))).toBe(
      "11–8 · pad.badminton.ribbon.partial",
    );
  });

  it("words a sanction by its level, through the shared enum vocabulary", () => {
    expect(badmintonDetail(ctx(SANCTION_TYPE, { by: "H", level: "warning", person: "H1" }))).toBe(
      `sanction.warning · ${NAMES.H1}`,
    );
  });

  // R5 review, finding 3 — `badmintonDetail` had NO `TIMEOUT_TYPE` case at
  // all, so a recorded time-out reached the ribbon as a bare "Time-out
  // recorded" with no side, while both siblings named one. Not a dead path:
  // `refusedEventTypes` reads `records.timeouts` per FIXTURE, so any cfg that
  // records time-outs reaches it.
  it("names the SIDE for a timeout, resolved through ctx.state — the payload alone only has an entrant id", () => {
    expect(badmintonDetail(ctx(TIMEOUT_TYPE, { by: "H" }, FOLDED))).toBe("scorepad.attribution.home");
    expect(badmintonDetail(ctx(TIMEOUT_TYPE, { by: "A" }, FOLDED))).toBe("scorepad.attribution.away");
    // No state at all: cannot resolve, falls to the bare ribbon caption
    // rather than printing a raw entrant id at the scorer.
    expect(badmintonDetail(ctx(TIMEOUT_TYPE, { by: "H" }))).toBeUndefined();
  });

  it("adds nothing for a type it has no vocabulary for", () => {
    expect(badmintonDetail(ctx("core.start", {}))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FACTORY WIRING — the mutation-provable block this skin's header promises
// ---------------------------------------------------------------------------

describe("factory wiring — every builder is threaded the REAL translator", () => {
  // The incident this exists for: cricket's `buildTiles(view, t = (key) => key)`
  // let its own factory drop the second argument, ship the raw i18n key as the
  // visible label, and stay 425/425 green — because a defaulted parameter
  // still satisfies a callback type declaring fewer, so tsc says nothing
  // either. Every builder here takes `t` REQUIRED; this block is what notices
  // if a wrapper is ever unwrapped or a default reintroduced.
  const XLATE: TFn = (key, vars) => `XLATED:${key}${vars ? JSON.stringify(vars) : ""}`;
  const skin = badmintonSkinV3(XLATE);

  it("identifies as badminton, tap model S", () => {
    expect(skin.key).toBe("badminton");
    expect(skin.tapModel).toBe("S");
  });

  it("threads it into the scorebug — context, strip labels, serving label and hints", () => {
    const spec = skin.scorebug(view({ events: stream(rally("H")) }));
    expect(spec.context.startsWith("XLATED:")).toBe(true);
    for (const item of spec.strip) {
      if (item.label !== undefined) expect(item.label.startsWith("XLATED:")).toBe(true);
    }
    const serving = spec.halves.flatMap((half) => half.who).find((who) => who.serving);
    expect(serving!.servingLabel!.startsWith("XLATED:")).toBe(true);
  });

  it("threads it into the tiles' pre-localised text", () => {
    const tile = skin.tiles(view({ band: 2 })).find((entry) => entry.id === RALLY_LOCKED_TILE_ID)!;
    expect(tile.labelText!.startsWith("XLATED:")).toBe(true);
    expect(tile.sublabelText!.startsWith("XLATED:")).toBe(true);
  });

  it("threads it into the sheets' titles", () => {
    const sheets = skin.sheets!(view());
    for (const sheet of Object.values(sheets)) {
      for (const step of sheet.steps) expect(step.title.startsWith("XLATED:")).toBe(true);
    }
  });

  it("threads it into the dock's title", () => {
    const dock = skin.dock(RALLY_TYPE, view({ lineups: DOUBLES, events: stream(rally("H")) }), { wonBy: "H" })!;
    expect(dock.title.startsWith("XLATED:")).toBe(true);
  });

  it("threads it into the context strip's message", () => {
    const spec = skin.context!(view({ band: 2 }))!;
    expect(spec.slots[0]!.message!.startsWith("XLATED:")).toBe(true);
  });

  it("declares no swap() and no contextSelect() — BWF Law 16, and a readOnly slot", () => {
    expect(skin.swap).toBeUndefined();
    expect(skin.contextSelect).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// COPY TRUTH — a key used only inside a returned SPEC has NO other gate
// ---------------------------------------------------------------------------

describe("copy truth", () => {
  // vitest's local `t` echoes the key, `TileSpec.label`/`step.title` are plain
  // `string` so tsc never checks them, and `i18n:check` only compares locales
  // to each other — a key missing from all four is perfect parity. So the keys
  // are collected FROM THE BUILT SPECS across a band/state sweep and checked
  // against en/ui.json directly. A later wave's new tile is covered the day it
  // lands, unlike a hand-maintained list.
  function collectLabelKeys(): Set<string> {
    const keys = new Set<string>();
    // Composed INSIDE `buildContext`/`buildStrip` into one already-joined
    // string, so no field on the returned spec holds them — added explicitly
    // rather than reverse-engineered out of the composed text.
    for (const key of [
      "pad.badminton.context.line",
      "pad.badminton.context.setting",
      "pad.badminton.context.goldenPoint",
      "pad.badminton.context.recording",
      "pad.badminton.context.recording.locked",
      "pad.badminton.scorebug.serving",
      "pad.badminton.scorebug.strip.games",
      "pad.badminton.scorebug.strip.server",
      "pad.badminton.scorebug.strip.interval",
      "pad.badminton.scorebug.strip.intervalNow",
      "pad.badminton.scorebug.strip.court.left",
      "pad.badminton.scorebug.strip.court.right",
      "pad.badminton.tile.rallyLocked",
      "pad.badminton.tile.rallyLocked.sublabel",
      "pad.badminton.dock.rally.scorer.title",
      "pad.badminton.dock.person",
      "pad.badminton.ribbon.partial",
    ]) {
      keys.add(key);
    }
    const sweep: { band: FidelityBand; events: EventEnvelope[]; lineups: LineupPair }[] = [
      { band: 0, events: stream(), lineups: SINGLES },
      { band: 1, events: stream(rally("H")), lineups: SINGLES },
      { band: 2, events: stream(summary(21, 15)), lineups: DOUBLES },
      { band: 3, events: stream(rally("H"), rally("A")), lineups: DOUBLES },
    ];
    for (const { band, events, lineups } of sweep) {
      const v = view({ band, events, lineups });
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
      for (const half of scorebug.halves) {
        if (half.hintKey !== undefined) keys.add(half.hintKey);
        for (const who of half.who) if (who.servingLabel !== undefined) keys.add(who.servingLabel);
      }
      const strip = buildContextStrip(v, t);
      for (const slot of strip?.slots ?? []) keys.add(slot.label);
      const dock = buildDock(RALLY_TYPE, v, t, { wonBy: "H" });
      for (const chip of dock?.chips ?? []) keys.add(chip.label);
    }
    return keys;
  }

  it("every key this skin's specs reference exists in the English dictionary", () => {
    const dict = uiEn as Record<string, string>;
    // A translated key resolves to the KEY under this file's echoing `t`, so
    // the collected set holds raw keys, never rendered text.
    const missing = [...collectLabelKeys()].filter((key) => !(key in dict)).sort();
    expect(missing).toEqual([]);
  });

  it("collects a non-trivial set — a walk that found nothing would pass the check above vacuously", () => {
    expect(collectLabelKeys().size).toBeGreaterThan(20);
  });

  // FOUND BY A 320px SCREENSHOT, NOT BY THIS FILE — which is the reason this
  // test exists. `ScorebugHalf.hintKey` and the ribbon's per-event copy do NOT
  // resolve through a bare `t()`: both go through `padLabel()`, which checks
  // `PAD_LABEL_KEYS` MEMBERSHIP first and falls back to printing the raw
  // dotted key when the key is not in that list (scorebug.tsx, ribbon.ts).
  // Dictionary copy alone is not enough, so the check above — "the key exists
  // in en/ui.json" — passes happily while the board renders
  // "pad.badminton.scorebug.rally.hint" under the score in every locale.
  // Tennis's own entry in that list carries the identical warning; this wave
  // reproduced the defect anyway, so it is asserted here rather than
  // remembered.
  it("every hintKey the scorebug emits is REGISTERED in PAD_LABEL_KEYS, not merely translated", () => {
    const registered = new Set<string>(PAD_LABEL_KEYS);
    const hints = new Set<string>();
    for (const band of [0, 1, 2, 3] as const) {
      for (const half of buildScorebug(view({ band, events: stream(rally("H")) }), t).halves) {
        if (half.hintKey !== undefined) hints.add(half.hintKey);
      }
    }
    // Non-vacuous: a band sweep that produced no tappable half at all would
    // make the loop below assert nothing.
    expect(hints.size).toBeGreaterThan(0);
    for (const key of hints) {
      expect(registered.has(key), `${key} is not in PAD_LABEL_KEYS — padLabel() will print the raw key`).toBe(true);
    }
  });

  // The same gate for the RIBBON, which shares `padLabel`'s membership check
  // and fails the same silent way: an unregistered key leaves every row on the
  // generic "{event} recorded" fallback forever, with nothing failing.
  it("every event type this skin dispatches has a REGISTERED ribbon key", () => {
    const registered = new Set<string>(PAD_LABEL_KEYS);
    // TIMEOUT_TYPE belongs in this list (review of PR #678). It was left out
    // on the reasoning that BWF play has no time-out so the fold always
    // refuses it — true of every DECLARED variant, false of the schema:
    // `records.timeouts` is a plain `z.boolean()` on the shared set-based
    // config (`kernel.ts`), and the skin only refuses the type when the flag
    // is off. A division that sets it on got the tile, the fold accepted, and
    // the ribbon printed "badminton.timeout recorded" at a scoring desk.
    for (const type of [RALLY_TYPE, SUMMARY_TYPE, SANCTION_TYPE, TIMEOUT_TYPE]) {
      const key = ribbonKeyFor(type);
      expect(registered.has(key), `${key} is not in PAD_LABEL_KEYS — the ribbon stays on the fallback`).toBe(true);
      expect(key in (uiEn as Record<string, string>), `${key} has no English copy`).toBe(true);
    }
  });
});
