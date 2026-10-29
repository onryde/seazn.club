// The pad adapters (W1c Task 7), swept over PAD_ADAPTERS, so every later
// task's adapters join these tests with no new structural test code. Expected
// values come from the matrix's own generator (the events a case really
// sends), from the engine's declarations (resolveSportCfg, the modules'
// coarseEventType, drawsAllowed), from the skins' source text, and from what
// Step 0 saw in a browser. None of them comes from lib/pads.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTLE_METHODS } from "@seazn/engine/core";
import { ARMAGEDDON_RESULTS, BoardgameMethod, DECISIVE_METHODS, DRAWN_METHODS, TIEBREAK_RUNGS, boardgame, effectiveRungs, type TiebreakRung } from "@seazn/engine/sports/boardgame";
import { carrom } from "@seazn/engine/sports/carrom";
import { cricket } from "@seazn/engine/sports/cricket";
import { football } from "@seazn/engine/sports/football";
import { hockey } from "@seazn/engine/sports/hockey";
import { icehockey } from "@seazn/engine/sports/icehockey";
import { badminton, tabletennis, volleyball } from "@seazn/engine/sports/setbased";
import { tennis } from "@seazn/engine/sports/tennis";
import { beforeAll, describe, expect, it } from "vitest";
import { GENERIC_TOLERATED_EXTRA_KEYS, genericAdapter } from "../../bench/lib/drivers/adapters/generic.ts";
import { START_MATCH_TESTID, selectorForTapStep, type TapAdapterContext, type TapStep } from "../../bench/lib/drivers/scorer.ts";
import { ORGANISER_ONLY_SPORT_EVENTS, isOrganiserOnlyEvent } from "../../../apps/web/src/lib/organiser-only-events.ts";
import type { LedgerRow } from "../../bench/lib/ledger.ts";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { PAD_OWNER, PAD_SPORTS, PAD_UNOWNED, noPadReason } from "../lib/pad-sports.ts";
import { foldStream } from "../lib/fold.ts";
import { ARMAGEDDON, BOARDGAME_DRAW_TILE, BOARDGAME_RESULT, BOARDGAME_TIEBREAK, BOARDGAME_TIEBREAK_TILE, BLACK_OPTION_PREFIX, RESULT_OPTION_PREFIX, TIEBREAK_SCORE_NONE, boardgamePad, methodChipId } from "../lib/pads/boardgame.ts";
import { CARROM_BOARD, CARROM_BOARD_TILE, CARROM_COIN_MAX, carromPad } from "../lib/pads/carrom.ts";
import { CRICKET_OVER_TILE, CRICKET_SUMMARY, cricketPad, makeCricketPad, overSplit } from "../lib/pads/cricket.ts";
import { BADMINTON_SET_SCORE_TILE, BADMINTON_SUMMARY, badmintonPad } from "../lib/pads/badminton.ts";
import { FOOTBALL_GOAL, FOOTBALL_KICK_MISSED, FOOTBALL_KICK_SCORED, FOOTBALL_PERIOD, FOOTBALL_PERIOD_TILE, FOOTBALL_SHOOTOUT_KICK, footballGoalTile, footballKickTile, footballPad } from "../lib/pads/football.ts";
import { GENERIC_DRAW_TILE_ID, genericPad } from "../lib/pads/generic.ts";
import { hockeyPad } from "../lib/pads/hockey.ts";
import { icehockeyPad } from "../lib/pads/icehockey.ts";
import { PAD_ADAPTERS, registerPads } from "../lib/pads/index.ts";
import { TABLETENNIS_SET_SCORE_TILE, TABLETENNIS_SUMMARY, tabletennisPad } from "../lib/pads/tabletennis.ts";
import { TENNIS_SET_SCORE_TILE, TENNIS_SUMMARY, tennisPad } from "../lib/pads/tennis.ts";
import { PERIOD_ADVANCE_TILE, PERIOD_ATTEMPT_MISSED, PERIOD_ATTEMPT_SCORED, periodAttemptTile, periodGoalTile } from "../lib/pads/period.ts";
import type { MatrixPadAdapter } from "../lib/pads/types.ts";
import { VOLLEYBALL_SET_SCORE_TILE, VOLLEYBALL_SUMMARY, volleyballPad } from "../lib/pads/volleyball.ts";
import { compareRow } from "../lib/pads/replay.ts";
import { replayOnModel, type RowIn } from "./pad-model.ts";
import { drawsAllowed, resolveSportCfg, sportModule, stageCfg, variantKeys } from "../lib/sport-cfg.ts";
import { declaredAllOut } from "../lib/streams/cricket.ts";
import { generateStream, matchesRequest } from "../lib/streams/index.ts";
import { DECIDING_PATHS, GeneratorUnsupported, OutcomeUnreachable, START, type RequestedOutcome, type StreamEvent, type StreamRequest } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKINS = "apps/web/src/components/v2/scorepad/v3/skins";
const HOME = "e-home";
const AWAY = "e-away";

/** The outcomes a case can request of one cfg: both wins, a draw where the
 *  engine allows one in a league (drawsAllowed), a walkover, and (W2a) an abandon. */
function outcomesFor(sport: string, cfg: unknown): RequestedOutcome[] {
  return [
    { kind: "win", winner: "home" }, { kind: "win", winner: "away" },
    ...(drawsAllowed(sport, cfg, "league") ? [{ kind: "draw" } as const] : []),
    { kind: "forfeit", by: "away", reason: "walkover", at: "before_start" },
    { kind: "abandon" },
  ];
}
/** W2a: what only the ORGANISER does — a walkover (core.forfeit), an abandon (core.abandon) and a settle
 *  (core.settle, X-ST-2). The pad adapter refuses to emit their events; the console page objects do. Their requests
 *  are marked here once, by request kind, and their events by event type. */
const ORGANISER_ONLY_OUTCOMES: ReadonlySet<string> = new Set(["forfeit", "abandon", "settle"]);
const ORGANISER_ONLY_EVENTS: ReadonlySet<string> = new Set(["core.forfeit", "core.abandon", "core.settle"]);
/** The requests a scorer's pad can author. */
const padOutcomes = (os: readonly RequestedOutcome[]): RequestedOutcome[] => os.filter((o) => !ORGANISER_ONLY_OUTCOMES.has(o.kind));
const req = (sport: string, cfg: unknown, outcome: RequestedOutcome): StreamRequest => ({ sportKey: sport, cfg, stageKind: "league", home: HOME, away: AWAY, outcome });
const bracketReq = (sport: string, cfg: unknown, outcome: RequestedOutcome): StreamRequest => ({ sportKey: sport, cfg, stageKind: "knockout", home: HOME, away: AWAY, outcome });

/** W2a (finding 16): what a BRACKET match can be asked — a win, a level result (where the sport reaches one), an
 *  abandon alone and at a score, every settle method after a level result and after an abandon, and every
 *  tie-break rung. Under the stage's cfg overlay (stageCfg), as the product folds a bracket fixture. */
function bracketOutcomesFor(): RequestedOutcome[] {
  return [
    { kind: "win", winner: "home" }, { kind: "level" }, { kind: "abandon" }, { kind: "abandon", atScore: true },
    ...SETTLE_METHODS.flatMap((method) => (["level", "abandon"] as const).map((after) => ({ kind: "settle", then: "home", method, after }) as const)),
    ...TIEBREAK_RUNGS.map((rung) => ({ kind: "tiebreak", rung, winner: "away" }) as const),
    // W2c BG-KO-2: a DRAWN Armageddon advances Black — the pad records Black and "Drawn", never a winner.
    { kind: "tiebreak", rung: "armageddon", winner: "away", result: "draw" },
  ];
}

/** W2e (Tasks 19–23): a win down every deciding path, by both sides. A sport's generator builds the paths its sport
 *  has (a request for any other is refused by name, so it routes nothing); the events a built one carries (football's
 *  extra-time markers and shoot-out kicks) join the adapter's `emits` and its routes like any other. */
const pathWins = (): RequestedOutcome[] => DECIDING_PATHS.flatMap((path) => (["home", "away"] as const).map((winner) => ({ kind: "win", winner, path }) as const));

/** Every request over every system variant of `sport` in a LEAGUE, then (W2a) the bracket requests on the builder
 *  default under the knockout overlay, then (W2e) a win down every deciding path on each variant's knockout overlay —
 *  the presets switch the deciders on there (X-SR-6). The builder default (offlineBuilderDefault, pinned to
 *  division-builder.tsx by catalogue.test.ts) comes first, and it is what PADPROOF plays. Since W1d item 16 cricket's
 *  two innings a side (the `test` preset) are inside the pad's route like any other. */
function requestsFor(sport: string): StreamRequest[] {
  const def = offlineBuilderDefault(sport);
  const variants = [def, ...variantKeys(sport).filter((v) => v !== def)];
  const league = variants.flatMap((v) => {
    const cfg = resolveSportCfg(sport, v);
    return outcomesFor(sport, cfg).map((o) => req(sport, cfg, o));
  });
  const cfg = stageCfg(sport, resolveSportCfg(sport, def), "knockout", def);
  const paths = variants.flatMap((v) => {
    const ko = stageCfg(sport, resolveSportCfg(sport, v), "knockout", v);
    return pathWins().map((o) => bracketReq(sport, ko, o));
  });
  return [...league, ...bracketOutcomesFor().map((o) => bracketReq(sport, cfg, o)), ...paths];
}
/** The events a request generates, or [] where the generator declares the case unsupported. */
function streamOf(r: StreamRequest): StreamEvent[] {
  try {
    return generateStream(r);
  } catch (e) {
    if (e instanceof GeneratorUnsupported || e instanceof OutcomeUnreachable) return []; // declared out of reach: nothing to route
    throw e;
  }
}
const ctxOf = (r: StreamRequest): TapAdapterContext => ({ cfg: r.cfg, entrants: { home: r.home, away: r.away } });
/** core.forfeit and core.abandon are the organiser's (bench organiserStepsFor), core.settle too (X-ST-2): never a pad tap. */
const scorerEvents = (evs: readonly StreamEvent[]) => evs.filter((e) => !ORGANISER_ONLY_EVENTS.has(e.type));

const ADAPTERS = Object.entries(PAD_ADAPTERS).map(([k, a]) => [k, a!] as const);

describe("the pad adapter registry", () => {
  it("empty case first: the registry is non-empty, keyed by real sports in SPORT_KEYS order, each adapter under its own sport", () => {
    const keys = Object.keys(PAD_ADAPTERS);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual(SPORT_KEYS.filter((k) => k in PAD_ADAPTERS)); // wave order, never re-sorted
    for (const [k, a] of ADAPTERS) expect(a.sport, k).toBe(k);
  });

  it("the leaf run.ts plans from is the registry's key list; a sport outside it would name the route that owes it — none is owed today (carry f), so the owner loop checks 0", () => {
    expect([...PAD_SPORTS]).toEqual(Object.keys(PAD_ADAPTERS));
    const owned = Object.keys(PAD_OWNER);
    expect(owned.filter((s) => PAD_SPORTS.includes(s))).toEqual([]);
    expect([...owned, ...PAD_SPORTS].sort()).toEqual([...SPORT_KEYS].sort());
    for (const [s, owner] of Object.entries(PAD_OWNER)) {
      // A route (lib/routing.ts), so the Q-A guard reads its wave; the reason names it.
      expect(Object.isFrozen(owner), s).toBe(true);
      expect(noPadReason(s)).toBe(`no pad adapter for ${s} yet → ${owner.wave} (${owner.why})`);
    }
    expect(owned.length).toBe(SPORT_KEYS.length - PAD_SPORTS.length);
  });

  it("carry (f): every catalogue sport has an adapter — PAD_ADAPTERS covers all 11 SPORT_KEYS in order, and nothing is owed", () => {
    let checked = 0;
    for (const s of SPORT_KEYS) {
      expect(PAD_ADAPTERS[s], s).toBeDefined();
      expect(PAD_ADAPTERS[s]!.sport, s).toBe(s);
      expect(PAD_SPORTS, s).toContain(s);
      checked++;
    }
    expect(checked).toBe(11);
    expect(Object.keys(PAD_ADAPTERS)).toEqual([...SPORT_KEYS]);
    expect(Object.keys(PAD_OWNER)).toEqual([]);
    // A sport the catalogue gains later, with no adapter, still names a wave — an OPEN one
    // (T1-R2: W1c is closed). Design §8: a gap no wave lists goes to the wave owning its
    // sport, which is the one sport-family wave; read from the design, never typed.
    const design = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/superpowers/specs/2026-09-27-format-matrix-design.md"), "utf8");
    const waves = design.slice(design.indexOf("## 8. Waves"), design.indexOf("## 9."));
    expect(waves).toMatch(/Gaps not listed go to the wave owning their\s+format\/sport/);
    const sportFamily = [...waves.matchAll(/^\| \*\*(W\d+) — [^|]*a sport-family wave/gm)].map((m) => m[1]!);
    expect(sportFamily).toHaveLength(1);
    expect(PAD_UNOWNED.wave).toBe(sportFamily[0]);
    expect(noPadReason("curling")).toBe(`no pad adapter for curling yet → ${sportFamily[0]} (${PAD_UNOWNED.why})`);
  });

  it("I-1: every registered fallback declares the row types it writes (its own type among them) and a judge", () => {
    let checked = 0;
    for (const [sport, a] of ADAPTERS) {
      for (const f of a.fallbacks) {
        expect(f.writes, `${sport} ${f.eventType}`).toContain(f.eventType);
        expect(typeof f.judge, `${sport} ${f.eventType}`).toBe("function");
        checked++;
      }
    }
    console.info(`pad-adapters: ${checked} registered fallback(s) declare writes and a judge`);
    expect(checked).toBe(4); // football goal, cricket innings, icehockey and hockey advances
  });

  it("I-1: registration refuses by name a fallback with no judge, or one that declares no row type it writes; its positive pair registers, frozen", () => {
    const goal = footballPad.fallbacks[0]!;
    const unjudged: MatrixPadAdapter = { ...footballPad, fallbacks: [{ eventType: goal.eventType, writes: goal.writes, why: goal.why, rowsFor: goal.rowsFor }] };
    expect(() => registerPads({ football: unjudged })).toThrow("FallbackUnjudged: football's football.goal fallback declares no judge — a fallback is judged, never waved through");
    const writesNothing: MatrixPadAdapter = { ...footballPad, fallbacks: [{ ...goal, writes: [] }] };
    expect(() => registerPads({ football: writesNothing })).toThrow("FallbackWritesNothing: football's football.goal fallback declares no row type it writes");
    const t = registerPads({ football: footballPad, carrom: carromPad });
    expect(t.football).toBe(footballPad);
    expect(Object.keys(t)).toEqual(["football", "carrom"]);
    expect(Object.isFrozen(t)).toBe(true);
    expect(Object.isFrozen(PAD_ADAPTERS)).toBe(true);
  });
});

describe.each(ADAPTERS)("%s adapter", (sport, a) => {
  it("emits equals what its generator actually emits across every variant and outcome it accepts", () => {
    const seen = new Set<string>();
    let streams = 0;
    for (const r of requestsFor(sport)) {
      const evs = streamOf(r);
      if (evs.length > 0) streams++;
      for (const e of evs) seen.add(e.type);
    }
    expect(streams).toBeGreaterThan(0);
    expect([...a.emits].sort()).toEqual([...seen].filter((t) => !ORGANISER_ONLY_EVENTS.has(t)).sort());
  });

  it("every generated scorer event is routed to ≥1 tap — or its type is declared noControl, and refused by name — and every fallback cites its file:line", () => {
    let routed = 0;
    let barred = 0;
    const noControl = new Set(a.noControl?.eventTypes ?? []);
    for (const r of requestsFor(sport)) {
      for (const e of scorerEvents(streamOf(r))) {
        const at = `${JSON.stringify(r.outcome)} ${e.type}`;
        if (noControl.has(e.type)) {
          expect(() => a.stepsFor(e, ctxOf(r)), at).toThrow(/has no addressable pad control/);
          barred++;
          continue;
        }
        expect(a.stepsFor(e, ctxOf(r)).length, at).toBeGreaterThan(0);
        routed++;
      }
    }
    console.info(`pad-adapters: ${sport}: ${routed} generated event(s) routed, ${barred} declared noControl`);
    expect(routed).toBeGreaterThan(0);
    // Every type an adapter declares noControl is one its generator emits (a stale declaration is a failure), and the route is frozen.
    for (const t of noControl) expect(a.emits, t).toContain(t);
    if (a.noControl !== undefined) {
      expect(barred, `${sport} declares noControl but its generator never emits one`).toBeGreaterThan(0);
      expect(Object.isFrozen(a.noControl.route)).toBe(true);
    }
    for (const f of a.fallbacks) {
      expect(a.emits, f.eventType).toContain(f.eventType);
      expect(f.why, f.eventType).toMatch(/\.tsx?:\d+/);
    }
  });

  it("W2a: core.abandon and core.settle are the organiser's — the adapter emits neither and refuses both by name, and this sport's streams really carry both (so the refusal covers real events)", () => {
    const seen = { "core.abandon": 0, "core.settle": 0 };
    for (const r of requestsFor(sport)) {
      for (const e of streamOf(r)) {
        if (e.type !== "core.abandon" && e.type !== "core.settle") continue;
        expect(a.emits, `${sport} ${e.type}`).not.toContain(e.type);
        expect(() => a.stepsFor(e, ctxOf(r)), `${sport} ${e.type}`).toThrow();
        seen[e.type]++;
      }
    }
    expect(seen["core.abandon"], `${sport}: no abandon was generated`).toBeGreaterThan(0);
    expect(seen["core.settle"], `${sport}: no settle was generated`).toBeGreaterThan(0);
  });

  it("core.start is the pad's Start match button", () => {
    expect(a.stepsFor({ type: "core.start", payload: {} }, { cfg: {}, entrants: { home: HOME, away: AWAY } })).toEqual([{ kind: "testid", testid: START_MATCH_TESTID }]);
  });
});

describe("generic", () => {
  let skin = "";
  beforeAll(() => { skin = readFileSync(resolve(REPO, SKINS, "generic.tsx"), "utf8"); });

  it("delegates to the bench's genericAdapter for every route the bench maps, in both result modes", () => {
    let checked = 0;
    for (const mode of ["score", "win_loss"]) {
      const cfg = resolveSportCfg("generic", mode);
      for (const outcome of outcomesFor("generic", cfg)) {
        const r = req("generic", cfg, outcome);
        for (const e of scorerEvents(generateStream(r))) {
          expect(genericPad.stepsFor(e, ctxOf(r)), `${mode} ${JSON.stringify(e)}`).toEqual(genericAdapter.stepsFor(e, ctxOf(r)));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("a win_loss draw is the pad's draw tile, where the bench throws (bench generic.ts stepsForResult)", () => {
    // The win_loss preset refuses draws, so a draw needs allowDraws on (Step 0 item 4: the tile is offered only then).
    expect(drawsAllowed("generic", resolveSportCfg("generic", "win_loss"), "league")).toBe(false);
    const cfg = resolveSportCfg("generic", "win_loss", { allowDraws: true });
    const r = req("generic", cfg, { kind: "draw" });
    const draw = generateStream(r).find((e) => e.type === "generic.result")!;
    expect(draw.payload).toEqual({ isDraw: true });
    expect(() => genericAdapter.stepsFor(draw, ctxOf(r))).toThrow(/draw/);
    expect(genericPad.stepsFor(draw, ctxOf(r))).toEqual([{ kind: "tile", tileId: GENERIC_DRAW_TILE_ID }]);
    // Only the bare draw: a payload with anything beside isDraw is not the tile's.
    expect(() => genericPad.stepsFor({ type: "generic.result", payload: { isDraw: true, winnerId: HOME } }, ctxOf(r))).toThrow();
    expect(() => genericPad.stepsFor({ type: "generic.result", payload: { isDraw: false } }, ctxOf(r))).toThrow();
  });

  it("a score-mode draw stays the bench's score sheet (the draw tile is win_loss's)", () => {
    const cfg = resolveSportCfg("generic", "score");
    const r = req("generic", cfg, { kind: "draw" });
    const draw = generateStream(r).find((e) => e.type === "generic.result")!;
    expect(genericPad.stepsFor(draw, ctxOf(r))[0]).toEqual(genericAdapter.stepsFor(draw, ctxOf(r))[0]);
    expect(genericPad.stepsFor(draw, ctxOf(r))[0]).not.toEqual({ kind: "tile", tileId: GENERIC_DRAW_TILE_ID });
  });

  it("tolerates exactly the bench's allowlist, per type", () => {
    let checked = 0;
    for (const t of [...genericPad.emits, "generic.score"]) {
      expect(genericPad.tolerableExtraKeys?.(t) ?? [], t).toEqual(GENERIC_TOLERATED_EXTRA_KEYS.get(t) ?? []);
      checked++;
    }
    expect(checked).toBe(genericPad.emits.length + 1);
  });

  it("pins: the draw tile id is generic.tsx's own DRAW_TILE_ID, and the draw tile is built under it", () => {
    const m = /export const DRAW_TILE_ID = "([^"]+)";/.exec(skin);
    expect(m, "generic.tsx no longer exports DRAW_TILE_ID as a string literal").not.toBeNull();
    expect(GENERIC_DRAW_TILE_ID).toBe(m![1]);
    expect(skin).toMatch(/id: DRAW_TILE_ID,/);
  });

  it("Step 0 item 4: the row the draw tile wrote is equal to the generated draw", () => {
    const seen = { id: "r2", seq: 2, type: "generic.result", payload: { isDraw: true } };
    expect(compareRow({ type: "generic.result", payload: { isDraw: true } }, seen, genericPad)).toEqual({ verdict: "equal", note: null });
  });
});

describe("badminton", () => {
  let skin = "";
  beforeAll(() => { skin = readFileSync(resolve(REPO, SKINS, "badminton.tsx"), "utf8"); });
  const cfg = resolveSportCfg("badminton", offlineBuilderDefault("badminton"));

  it("a set summary is the setScore sheet with the generated numbers, home first, one per straight set of the engine's preset", () => {
    const r = req("badminton", cfg, { kind: "win", winner: "away" });
    const sums = generateStream(r).filter((e) => e.type === BADMINTON_SUMMARY);
    expect(sums.length).toBe(Math.ceil((cfg as { bestOf: number }).bestOf / 2)); // straight sets, from the preset
    for (const s of sums) {
      const p = s.payload as { home: number; away: number };
      expect(p.home).not.toBe(p.away); // the case can see a home/away swap
      expect(badmintonPad.stepsFor(s, ctxOf(r))).toEqual([
        { kind: "tile", tileId: BADMINTON_SET_SCORE_TILE },
        { kind: "number", value: p.home }, { kind: "confirm" },
        { kind: "number", value: p.away }, { kind: "confirm" },
      ]);
    }
  });

  it("a type the pad has no route for throws, naming it (never a substitute tap)", () => {
    expect(() => badmintonPad.stepsFor({ type: "badminton.rally", payload: { side: "home" } }, ctxOf(req("badminton", cfg, { kind: "win", winner: "home" })))).toThrow(/badminton\.rally/);
  });

  it("a summary that is not the sheet's {home, away} of whole numbers is refused by name, never typed as a guess (the sheet has exactly two number steps)", () => {
    const r = req("badminton", cfg, { kind: "win", winner: "home" });
    const bad: unknown[] = [null, { home: 21 }, { home: 21, away: 13, extra: 1 }, { home: 21.5, away: 13 }, { home: "21", away: 13 }];
    let checked = 0;
    for (const payload of bad) {
      expect(() => badmintonPad.stepsFor({ type: BADMINTON_SUMMARY, payload }, ctxOf(r)), JSON.stringify(payload)).toThrow(/is not the sheet's \{home, away\} of whole numbers/);
      checked++;
    }
    expect(checked).toBe(bad.length);
    // Its positive pair: a whole-number pair is typed.
    expect(badmintonPad.stepsFor({ type: BADMINTON_SUMMARY, payload: { home: 21, away: 13 } }, ctxOf(r))).toHaveLength(5);
  });

  it("tolerates no extra key: Step 0 item 2 saw the row carry exactly home and away", () => {
    expect(badmintonPad.tolerableExtraKeys?.(BADMINTON_SUMMARY) ?? []).toEqual([]);
    const seen = { id: "r2", seq: 2, type: BADMINTON_SUMMARY, payload: { away: 13, home: 21 } };
    expect(compareRow({ type: BADMINTON_SUMMARY, payload: { home: 21, away: 13 } }, seen, badmintonPad)).toEqual({ verdict: "equal", note: null });
  });

  it("pins: the tile id is badminton.tsx's SET_SCORE_TILE_ID and the event type is the engine module's coarse type", () => {
    const m = /export const SET_SCORE_TILE_ID = "([^"]+)";/.exec(skin);
    expect(m, "badminton.tsx no longer exports SET_SCORE_TILE_ID as a string literal").not.toBeNull();
    expect(BADMINTON_SET_SCORE_TILE).toBe(m![1]);
    expect(sportModule("badminton")).toBe(badminton);
    expect(BADMINTON_SUMMARY).toBe(`badminton.${badminton.coarseEventType}`);
    // The skin's own SUMMARY_TYPE is built the same way, and the setScore sheet posts it.
    expect(skin).toMatch(/export const SUMMARY_TYPE = `\$\{SPORT\}\.\$\{badmintonModule\.coarseEventType\}`;/);
    expect(skin).toMatch(/\[SET_SCORE_TILE_ID\]: setScoreSheet\(/);
  });
});

// ── W1c Task 9: the set-summary family ───────────────────────────────────────
// Each: the builder default's generated summaries → the setScore sheet, home
// first (Step 0 saw "Points — Home" / "Games — Home" first at 320), with the
// numbers taken from generateStream; the ids pinned to the skin's source and
// the engine module's own event types; the row Step 0 saw compared equal.

/** The generator's summaries of `sport` at its builder default, for a win by `winner`. */
function summariesOf(sport: string, type: string, winner: "home" | "away") {
  const cfg = resolveSportCfg(sport, offlineBuilderDefault(sport));
  const r = req(sport, cfg, { kind: "win", winner });
  return { cfg, r, sums: generateStream(r).filter((e) => e.type === type) };
}
const sheetSteps = (tile: string, p: { home: number; away: number }) => [
  { kind: "tile", tileId: tile },
  { kind: "number", value: p.home }, { kind: "confirm" },
  { kind: "number", value: p.away }, { kind: "confirm" },
];

describe("tabletennis", () => {
  let skin = "";
  beforeAll(() => { skin = readFileSync(resolve(REPO, SKINS, "tabletennis.tsx"), "utf8"); });

  it("a game summary is the setScore sheet with the generated numbers, home first, one per straight game of the engine's preset (bo5 → 3)", () => {
    let checked = 0;
    for (const winner of ["home", "away"] as const) {
      const { cfg, r, sums } = summariesOf("tabletennis", TABLETENNIS_SUMMARY, winner);
      expect(sums.length).toBe(Math.ceil((cfg as { bestOf: number }).bestOf / 2));
      for (const s of sums) {
        const p = s.payload as { home: number; away: number };
        expect(p.home).not.toBe(p.away); // the case can see a home/away swap
        expect(tabletennisPad.stepsFor(s, ctxOf(r))).toEqual(sheetSteps(TABLETENNIS_SET_SCORE_TILE, p));
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("Step 0: setScore writes without the serve anchor — no anchor step, no fallback, the row equal to the generated summary", () => {
    expect(tabletennisPad.fallbacks).toEqual([]);
    const { r, sums } = summariesOf("tabletennis", TABLETENNIS_SUMMARY, "home");
    expect(tabletennisPad.stepsFor(sums[0]!, ctxOf(r)).some((s) => s.kind === "tile" && s.tileId === "serveAnchor")).toBe(false);
    const seen = { id: "r2", seq: 2, type: TABLETENNIS_SUMMARY, payload: { away: 6, home: 11 } };
    expect(compareRow(sums[0]!, seen, tabletennisPad)).toEqual({ verdict: "equal", note: null });
    expect(tabletennisPad.tolerableExtraKeys?.(TABLETENNIS_SUMMARY) ?? []).toEqual([]);
  });

  it("a summary that is not the sheet's {home, away} of whole numbers is refused by name", () => {
    const { r } = summariesOf("tabletennis", TABLETENNIS_SUMMARY, "home");
    const bad: unknown[] = [null, { home: 11 }, { home: 11, away: 6, extra: 1 }, { home: 11.5, away: 6 }, { home: "11", away: 6 }];
    for (const payload of bad) expect(() => tabletennisPad.stepsFor({ type: TABLETENNIS_SUMMARY, payload }, ctxOf(r)), JSON.stringify(payload)).toThrow(/is not the sheet's \{home, away\} of whole numbers/);
    expect(() => tabletennisPad.stepsFor({ type: "tabletennis.rally", payload: { side: "home" } }, ctxOf(r))).toThrow(/tabletennis\.rally/);
  });

  it("pins: the tile id is tabletennis.tsx's SET_SCORE_TILE_ID and the event type is the engine module's coarse type", () => {
    const m = /export const SET_SCORE_TILE_ID = "([^"]+)";/.exec(skin);
    expect(m, "tabletennis.tsx no longer exports SET_SCORE_TILE_ID as a string literal").not.toBeNull();
    expect(TABLETENNIS_SET_SCORE_TILE).toBe(m![1]);
    expect(sportModule("tabletennis")).toBe(tabletennis);
    expect(TABLETENNIS_SUMMARY).toBe(`tabletennis.${tabletennis.coarseEventType}`);
    expect(skin).toMatch(/export const SUMMARY_TYPE = `\$\{SPORT\}\.\$\{tabletennisModule\.coarseEventType\}`;/);
    expect(skin).toMatch(/\[SET_SCORE_TILE_ID\]: setScoreSheet\(/);
  });
});

describe("volleyball", () => {
  let skin = "";
  beforeAll(() => { skin = readFileSync(resolve(REPO, SKINS, "volleyball.tsx"), "utf8"); });

  it("volleyball beach: two set summaries, the second to 21 not 15 (the final-set target applies only at set index bestOf−1)", () => {
    let checked = 0;
    for (const winner of ["home", "away"] as const) {
      const { cfg, r, sums } = summariesOf("volleyball", VOLLEYBALL_SUMMARY, winner);
      const c = cfg as { bestOf: number; setTo: number; finalSetTo: number };
      expect(offlineBuilderDefault("volleyball")).toBe("beach");
      expect(c.setTo).not.toBe(c.finalSetTo); // the case can see the wrong target
      expect(sums.length).toBe(Math.ceil(c.bestOf / 2));
      expect(sums.length).toBeLessThan(c.bestOf); // straight sets never reach set index bestOf−1
      for (const s of sums) {
        const p = s.payload as { home: number; away: number };
        expect(Math.max(p.home, p.away)).toBe(c.setTo);
        expect(volleyballPad.stepsFor(s, ctxOf(r))).toEqual(sheetSteps(VOLLEYBALL_SET_SCORE_TILE, p));
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("Step 0: the beach row Step 0 saw is equal to the generated summary; no roster, no fallback, no tolerated key", () => {
    expect(volleyballPad.fallbacks).toEqual([]);
    const { sums } = summariesOf("volleyball", VOLLEYBALL_SUMMARY, "home");
    const seen = { id: "r2", seq: 2, type: VOLLEYBALL_SUMMARY, payload: { away: 16, home: 21 } };
    expect(compareRow(sums[0]!, seen, volleyballPad)).toEqual({ verdict: "equal", note: null });
    expect(volleyballPad.tolerableExtraKeys?.(VOLLEYBALL_SUMMARY) ?? []).toEqual([]);
  });

  it("a summary that is not the sheet's {home, away} of whole numbers is refused by name", () => {
    const { r } = summariesOf("volleyball", VOLLEYBALL_SUMMARY, "home");
    for (const payload of [null, { away: 16 }, { home: 21, away: 16, side: "home" }, { home: 21, away: Number.NaN }] as unknown[]) {
      expect(() => volleyballPad.stepsFor({ type: VOLLEYBALL_SUMMARY, payload }, ctxOf(r)), JSON.stringify(payload)).toThrow(/is not the sheet's \{home, away\} of whole numbers/);
    }
    expect(() => volleyballPad.stepsFor({ type: "volleyball.rally", payload: { side: "home" } }, ctxOf(r))).toThrow(/volleyball\.rally/);
  });

  it("pins: the tile id is volleyball.tsx's SET_SCORE_TILE_ID and the event type is the engine module's coarse type", () => {
    const m = /export const SET_SCORE_TILE_ID = "([^"]+)";/.exec(skin);
    expect(m, "volleyball.tsx no longer exports SET_SCORE_TILE_ID as a string literal").not.toBeNull();
    expect(VOLLEYBALL_SET_SCORE_TILE).toBe(m![1]);
    expect(sportModule("volleyball")).toBe(volleyball);
    expect(VOLLEYBALL_SUMMARY).toBe(`volleyball.${volleyball.coarseEventType}`);
    expect(skin).toMatch(/export const SUMMARY_TYPE = `\$\{SPORT\}\.\$\{volleyballModule\.coarseEventType\}`;/);
    expect(skin).toMatch(/\[SET_SCORE_TILE_ID\]: setScoreSheet\(/);
  });
});

describe("tennis", () => {
  let skin = "";
  beforeAll(() => { skin = readFileSync(resolve(REPO, SKINS, "tennis.tsx"), "utf8"); });

  it("tennis: a 6-3 set's steps carry no tie-break numbers — exactly 5 steps, home first, for every generated set", () => {
    let checked = 0;
    for (const winner of ["home", "away"] as const) {
      const { cfg, r, sums } = summariesOf("tennis", TENNIS_SUMMARY, winner);
      const at = (cfg as { set: { tiebreakAt: number } }).set.tiebreakAt;
      expect(sums.length).toBe(Math.ceil((cfg as { bestOf: number }).bestOf / 2));
      for (const s of sums) {
        const p = s.payload as { home: number; away: number };
        // Not the tie-break shape (at+1 : at), which is the only one whose sheet asks more (tennis.tsx:851-855).
        expect(Math.min(p.home, p.away)).toBeLessThan(at);
        const steps = tennisPad.stepsFor(s, ctxOf(r));
        expect(steps).toHaveLength(5);
        expect(steps).toEqual(sheetSteps(TENNIS_SET_SCORE_TILE, p));
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("a tie-break-shaped set (tiebreakAt+1 : tiebreakAt, from the cfg) is refused by name, never typed as two numbers; its positive pair is typed", () => {
    const { cfg, r } = summariesOf("tennis", TENNIS_SUMMARY, "home");
    const at = (cfg as { set: { tiebreakAt: number } }).set.tiebreakAt;
    let checked = 0;
    for (const payload of [{ home: at + 1, away: at }, { home: at, away: at + 1 }]) {
      expect(() => tennisPad.stepsFor({ type: TENNIS_SUMMARY, payload }, ctxOf(r)), JSON.stringify(payload)).toThrow(/is a tie-break set/);
      checked++;
    }
    expect(checked).toBe(2);
    // One game fewer on the loser is a plain set: typed.
    expect(tennisPad.stepsFor({ type: TENNIS_SUMMARY, payload: { home: at + 1, away: at - 1 } }, ctxOf(r))).toHaveLength(5);
    for (const payload of [null, { home: 6 }, { home: 6, away: 3, tb: { home: 7, away: 5 } }] as unknown[]) {
      expect(() => tennisPad.stepsFor({ type: TENNIS_SUMMARY, payload }, ctxOf(r)), JSON.stringify(payload)).toThrow(/is not the sheet's \{home, away\} of whole numbers/);
    }
  });

  it("Step 0: the 6-3 row Step 0 saw (no tb key) is equal to the generated summary; no fallback, no tolerated key", () => {
    expect(tennisPad.fallbacks).toEqual([]);
    const { sums } = summariesOf("tennis", TENNIS_SUMMARY, "home");
    const seen = { id: "r2", seq: 2, type: TENNIS_SUMMARY, payload: { away: 3, home: 6 } };
    expect(compareRow(sums[0]!, seen, tennisPad)).toEqual({ verdict: "equal", note: null });
    expect(tennisPad.tolerableExtraKeys?.(TENNIS_SUMMARY) ?? []).toEqual([]);
  });

  it("pins: the setScore tile id and sheet key are tennis.tsx's, and the event type is SET_SUMMARY_TYPE, which the engine module declares", () => {
    // tennis.tsx exports neither; the tile is built with the literal id and the sheet registered under it.
    const tile = /if \(offerable\(SET_SUMMARY_TYPE\) && !setInProgressOf\(state\)\) \{\s*tiles\.push\(\{\s*id: "([^"]+)",/.exec(skin);
    expect(tile, "tennis.tsx no longer builds the set-score tile as a literal id under the SET_SUMMARY_TYPE offer").not.toBeNull();
    expect(TENNIS_SET_SCORE_TILE).toBe(tile![1]);
    expect(skin).toContain(`${TENNIS_SET_SCORE_TILE}: setScoreSheet(view),`);
    expect(skin).toMatch(/const SPORT = "tennis";/);
    expect(skin).toMatch(/const SET_SUMMARY_TYPE = `\$\{SPORT\}\.set_summary`;/);
    expect(TENNIS_SUMMARY).toBe("tennis.set_summary");
    expect(sportModule("tennis")).toBe(tennis);
    expect(Object.keys(tennis.eventSchemas ?? {})).toContain(TENNIS_SUMMARY);
  });
});

// ---------------------------------------------------------------------------
// Task 10: football, hockey, icehockey.

const TILE = (tileId: string) => selectorForTapStep({ kind: "tile", tileId });
const START_SEL = selectorForTapStep({ kind: "testid", testid: START_MATCH_TESTID });
const CHOICE_ID = /^\[data-choice-option-id="([^"]+)"\]$/;

/** football as Step 0 saw it (2026-09-30, 320, 11-a-side): Start writes
 *  core.start; a goal tile writes `{by}` alone; the period tile then a marker
 *  choice writes `{phase: <the choice's id>}`. W2e (Task 19, read off the skin's
 *  source — no browser saw it yet): a side's kick tile then the Scored / Missed
 *  choice writes `{by, scored}` (football.tsx kickSheet's buildPayload). Anything
 *  else writes nothing. */
function footballModel(ctx: TapAdapterContext, goal: (side: "home" | "away") => unknown = (side) => ({ by: ctx.entrants[side] })) {
  return (taps: readonly string[]): RowIn[] => {
    if (taps.length === 1 && taps[0] === START_SEL) return [{ type: "core.start", payload: {} }];
    for (const side of ["home", "away"] as const) {
      if (taps.length === 1 && taps[0] === TILE(`goal-${side}`)) return [{ type: "football.goal", payload: goal(side) }];
      const kick = taps.length === 2 && taps[0] === TILE(`kick-${side}`) ? CHOICE_ID.exec(taps[1]!) : null;
      if (kick !== null && (kick[1] === "scored" || kick[1] === "missed")) return [{ type: "football.shootout.kick", payload: { by: ctx.entrants[side], scored: kick[1] === "scored" } }];
    }
    const m = taps.length === 2 && taps[0] === TILE("period") ? CHOICE_ID.exec(taps[1]!) : null;
    return m === null ? [] : [{ type: "football.period", payload: { phase: m[1] } }];
  };
}

/** The dock chip a tap selector names (`pad-dock-chip-<id>`). */
const CHIP_ID = /^\[data-testid="pad-dock-chip-([^"]+)"\]$/;

/** hockey / icehockey as Step 0 saw them: a goal tile writes `{by}` (hockey, since W2d T18: the tile, then the
 *  type chip, writes `{by, kind}`); the
 *  advance tile writes `{to, at}`, where `to` is what the ENGINE says comes
 *  next (the summary's detail.nextAdvance, which the skin reads) and `at` the
 *  current play phase at elapsed 0 (whistleAt with no clock). */
function periodModel(
  sport: "hockey" | "icehockey",
  ctx: TapAdapterContext,
  o: { to?: (next: string) => string; at?: (phase: string | undefined) => unknown } = {},
) {
  const m = sport === "hockey" ? hockey : icehockey;
  return (taps: readonly string[], ledger: readonly LedgerRow[]): RowIn[] => {
    if (taps.length === 1 && taps[0] === START_SEL) return [{ type: "core.start", payload: {} }];
    for (const side of ["home", "away"] as const) {
      // W2d T18: a hockey goal tile writes nothing on its own — its type chip answers the choice, then it holds.
      if (sport === "hockey") {
        const chip = taps.length === 2 && taps[0] === TILE(`goal-${side}`) ? CHIP_ID.exec(taps[1]!) : null;
        if (chip !== null) return [{ type: `${sport}.goal`, payload: { by: ctx.entrants[side], kind: chip[1] === "ownGoal" ? "og" : chip[1]!.slice("kind:".length) } }];
        if (taps.length === 1 && taps[0] === TILE(`goal-${side}`)) return [];
        continue;
      }
      if (taps.length === 1 && taps[0] === TILE(`goal-${side}`)) return [{ type: `${sport}.goal`, payload: { by: ctx.entrants[side] } }];
    }
    // W2e (Task 20; read off period-shared.ts's SOURCE, no browser has seen it): a side's attempt tile `attempt-<side>`, then
    // the sheet's Scored / Missed choice, writes `{by, scored}` (attemptSheet's buildPayload). The tile is offered in the
    // SHOOTOUT phase only, and DISABLED on the side whose turn it is not (the engine's `shootoutNext`), so a tap on it writes nothing.
    for (const side of ["home", "away"] as const) {
      const pick = taps.length === 2 && taps[0] === TILE(periodAttemptTile(side)) ? CHOICE_ID.exec(taps[1]!) : null;
      if (pick === null || (pick[1] !== PERIOD_ATTEMPT_SCORED && pick[1] !== PERIOD_ATTEMPT_MISSED)) continue;
      const at = foldStream(m, ctx.cfg, ctx.entrants.home, ctx.entrants.away, ledger.map((r) => ({ type: r.type, payload: r.payload })));
      const sd = (m.summary(at.state as never).detail ?? {}) as { phase?: string; shootoutNext?: string | null };
      if (sd.phase !== "SHOOTOUT" || ((sd.shootoutNext === "home" || sd.shootoutNext === "away") && sd.shootoutNext !== side)) return [];
      return [{ type: `${sport}.shootout.attempt`, payload: { by: ctx.entrants[side], scored: pick[1] === PERIOD_ATTEMPT_SCORED } }];
    }
    if (taps.length !== 1 || taps[0] !== TILE("advance")) return [];
    const { state } = foldStream(m, ctx.cfg, ctx.entrants.home, ctx.entrants.away, ledger.map((r) => ({ type: r.type, payload: r.payload })));
    const d = (m.summary(state as never).detail ?? {}) as { nextAdvance?: string | null; phase?: string };
    if (d.nextAdvance == null) return [];
    const to = o.to?.(d.nextAdvance) ?? d.nextAdvance;
    const at = o.at === undefined ? { period: d.phase, elapsed: 0 } : o.at(d.phase);
    return [{ type: `${sport}.period.advance`, payload: { to, at } }];
  };
}

/** The engine's own advance order for `cfg` through LEVEL play (W2e Task 20: no goal, so the first FT opens any overtime
 *  and the second ends it, and the whistles stop where the engine names none — the shoot-out, or a draw): fold, read
 *  nextAdvance, advance to it, until the engine names none. This is the longest order a match can walk. */
function engineAdvances(sport: "hockey" | "icehockey", cfg: unknown): string[] {
  const m = sport === "hockey" ? hockey : icehockey;
  const evs: StreamEvent[] = [START];
  const out: string[] = [];
  for (;;) {
    const { state } = foldStream(m, cfg, HOME, AWAY, evs);
    const next = ((m.summary(state as never).detail ?? {}) as { nextAdvance?: string | null }).nextAdvance ?? null;
    if (next === null) return out;
    out.push(next);
    evs.push({ type: `${sport}.period.advance`, payload: { to: next } });
    if (out.length > 12) throw new Error(`${sport}: the engine never stopped naming advances: ${out.join(",")}`);
  }
}
const adv = (sport: string, to: string): StreamEvent => ({ type: `${sport}.period.advance`, payload: { to } });

describe("football", () => {
  let skin = "";
  beforeAll(() => { skin = readFileSync(resolve(REPO, SKINS, "football.tsx"), "utf8"); });

  it("football: a declared fallback's rowsFor equals the rows its steps write in the fake ledger (1 for the goal), and the stored rows fold to the requested outcome", async () => {
    const goal = footballPad.fallbacks.find((f) => f.eventType === FOOTBALL_GOAL);
    expect(goal, "football.goal is declared a fallback").toBeDefined();
    let fallbackRows = 0;
    let cases = 0;
    const cfg = resolveSportCfg("football", offlineBuilderDefault("football"));
    for (const outcome of padOutcomes(outcomesFor("football", cfg))) {
      const r = req("football", cfg, outcome);
      const evs = generateStream(r);
      const { res, ledger } = await replayOnModel(footballPad, evs, ctxOf(r), footballModel(ctxOf(r)));
      expect(res.findings, JSON.stringify(outcome)).toEqual([]);
      expect(res.rows.map((x) => x.expected.type)).toEqual(evs.map((e) => e.type));
      for (const row of res.rows) {
        if (row.expected.type === FOOTBALL_GOAL) {
          expect(row.verdict).toBe("fallback");
          expect(row.stored.length).toBe(goal!.rowsFor(row.expected, ctxOf(r)));
          expect(row.stored.length).toBe(1); // Step 0: one goal tap wrote one row
          fallbackRows++;
        } else {
          expect(row.verdict, row.expected.type).toBe("equal");
        }
      }
      const folded = foldStream(football, cfg, HOME, AWAY, ledger.map((x) => ({ type: x.type, payload: x.payload })));
      expect(matchesRequest(r, folded.outcome), JSON.stringify(outcome)).toBe("match");
      cases++;
    }
    expect(cases).toBe(3); // home win, away win, draw (11-a-side has no ET and no shootout)
    expect(fallbackRows).toBe(2);
  });

  it("I-1: the goal fallback is judged — the right rows are `fallback`; a goal credited to the other side, a generated key stored with another value, or a key the goal never carries is a `mismatch` naming it", async () => {
    const cfg = resolveSportCfg("football", offlineBuilderDefault("football"));
    const r = req("football", cfg, { kind: "win", winner: "home" });
    const evs = generateStream(r);
    const g = evs.find((e) => e.type === FOOTBALL_GOAL)!;
    const gp = g.payload as { by: string; minute: number };
    expect(typeof gp.minute).toBe("number"); // the key the pad never writes (FP-T10-1)
    const i = evs.indexOf(g);
    const ctx = ctxOf(r);
    const other = gp.by === ctx.entrants.home ? ctx.entrants.away : ctx.entrants.home;
    const cases: [string, (side: "home" | "away") => unknown, string | null][] = [
      ["right", (side) => ({ by: ctx.entrants[side] }), null],
      ["the other side", (side) => ({ by: ctx.entrants[side === "home" ? "away" : "home"] }), `by: stored ${JSON.stringify(other)}, generated ${JSON.stringify(gp.by)}`],
      ["a stored minute", (side) => ({ by: ctx.entrants[side], minute: gp.minute + 1 }), `minute: stored ${gp.minute + 1}, generated ${gp.minute}`],
      ["an ownGoal key", (side) => ({ by: ctx.entrants[side], ownGoal: false }), "untolerated key ownGoal=false"],
    ];
    for (const [label, goal, note] of cases) {
      const { res } = await replayOnModel(footballPad, evs, ctx, footballModel(ctx, goal));
      if (note === null) {
        expect(res.rows[i], label).toMatchObject({ verdict: "fallback" });
        expect(res.findings, label).toEqual([]);
      } else {
        expect(res.rows, label).toHaveLength(i + 1);
        expect(res.rows[i], label).toMatchObject({ verdict: "mismatch", note: `FallbackMismatch — ${note}` });
        expect(res.findings, label).toEqual([`stopped after event ${i + 1} of ${evs.length}: FallbackMismatch — ${note}`]);
      }
    }
    // The judge reads exactly one row: the goal tile writes one.
    const row = { id: "r2", seq: 2, type: FOOTBALL_GOAL, payload: { by: gp.by } };
    const judge = footballPad.fallbacks[0]!.judge!;
    expect(judge(g, [row])).toEqual({ ok: true, note: null });
    expect(judge(g, [row, row])).toEqual({ ok: false, note: "2 rows, where the goal tile writes 1" });
    expect(judge(g, [{ ...row, payload: {} }])).toEqual({ ok: false, note: `by: stored (absent), generated ${JSON.stringify(gp.by)}` });
  });

  it("routes: a goal is its side's tile; a marker is the period tile then the marker's choice, in every variant's marker list", () => {
    const { r } = summariesOf("football", FOOTBALL_GOAL, "away");
    expect(footballPad.stepsFor({ type: FOOTBALL_GOAL, payload: { by: AWAY, minute: 10 } }, ctxOf(r))).toEqual([{ kind: "tile", tileId: footballGoalTile("away") }]);
    expect(footballPad.stepsFor({ type: FOOTBALL_GOAL, payload: { by: HOME, minute: 10 } }, ctxOf(r))).toEqual([{ kind: "tile", tileId: footballGoalTile("home") }]);
    let checked = 0;
    for (const v of variantKeys("football")) {
      const cfg = resolveSportCfg("football", v);
      for (const e of streamOf(req("football", cfg, { kind: "win", winner: "home" })).filter((x) => x.type === FOOTBALL_PERIOD)) {
        const phase = (e.payload as { phase: string }).phase;
        expect(footballPad.stepsFor(e, ctxOf(r)), `${v} ${phase}`).toEqual([{ kind: "tile", tileId: FOOTBALL_PERIOD_TILE }, { kind: "choice", optionId: phase }]);
        checked++;
      }
    }
    console.info(`pad-adapters: football: ${checked} generated marker(s) routed`);
    expect(checked).toBeGreaterThan(0);
  });

  it("a goal by no entrant of the fixture, or a payload off either shape, is refused by name", () => {
    const { r } = summariesOf("football", FOOTBALL_GOAL, "home");
    for (const payload of [null, { by: "stranger", minute: 10 }, { minute: 10 }, { by: HOME, minute: 10, scorer: "p1" }] as unknown[]) {
      expect(() => footballPad.stepsFor({ type: FOOTBALL_GOAL, payload }, ctxOf(r)), JSON.stringify(payload)).toThrow(/football\.goal payload .* is not \{by: one of the fixture's entrants/);
    }
    for (const payload of [null, {}, { phase: "" }, { phase: "HT", at: 45 }] as unknown[]) {
      expect(() => footballPad.stepsFor({ type: FOOTBALL_PERIOD, payload }, ctxOf(r)), JSON.stringify(payload)).toThrow(/football\.period payload .* is not the sheet's \{phase\}/);
    }
    expect(() => footballPad.stepsFor({ type: "football.card", payload: {} }, ctxOf(r))).toThrow(/football\.card/);
  });

  it("Step 0: the goal row (keys [by]) mismatches the generated {by, minute}, which is why it is a fallback; the marker rows are equal", () => {
    const { r } = summariesOf("football", FOOTBALL_GOAL, "home");
    const evs = generateStream(r);
    const g = evs.find((e) => e.type === FOOTBALL_GOAL)!;
    expect(compareRow(g, { id: "r2", seq: 2, type: FOOTBALL_GOAL, payload: { by: HOME } }, footballPad).verdict).toBe("mismatch");
    let checked = 0;
    for (const e of evs.filter((x) => x.type === FOOTBALL_PERIOD)) {
      expect(compareRow(e, { id: "r3", seq: 3, type: FOOTBALL_PERIOD, payload: e.payload }, footballPad)).toEqual({ verdict: "equal", note: null });
      checked++;
    }
    expect(checked).toBe(2); // HT, FT
    expect(footballPad.fallbacks.map((f) => f.eventType)).toEqual([FOOTBALL_GOAL]);
    expect(footballPad.tolerableExtraKeys?.(FOOTBALL_GOAL) ?? []).toEqual([]);
  });

  it("pins: the goal tile's payload is {by} alone at the line the fallback cites; the period tile opens the marker sheet whose option ids are the markers", () => {
    const goal = footballPad.fallbacks.find((f) => f.eventType === FOOTBALL_GOAL)!;
    const cite = /football\.tsx:(\d+)/.exec(goal.why);
    expect(cite, goal.why).not.toBeNull();
    expect(skin.split("\n")[Number(cite![1]) - 1]).toContain(`action: { event: { type: "football.goal", payload: { by: entrantOf(state, side) } } },`);
    expect(skin).toMatch(/if \(offerable\("football\.goal"\)\) \{\s*for \(const side of SIDES\) \{\s*tiles\.push\(\{\s*id: `goal-\$\{side\}`,/);
    expect(footballGoalTile("home")).toBe("goal-home");
    const tile = /if \(offerable\("football\.period"\)\) \{\s*tiles\.push\(\{\s*id: "([^"]+)",/.exec(skin);
    expect(tile, "football.tsx no longer builds the period tile as a literal id under the football.period offer").not.toBeNull();
    expect(FOOTBALL_PERIOD_TILE).toBe(tile![1]);
    expect(skin).toContain(`action: { sheet: "${FOOTBALL_PERIOD_TILE}" },`);
    expect(skin).toContain(`${FOOTBALL_PERIOD_TILE}: periodSheet(view, t),`);
    expect(skin).toMatch(/options: periodMarkersOf\(view\.cfg\)\.map\(\(marker\) => \(\{\s*id: marker,/);
    expect(skin).toContain("buildPayload: (answers) => ({ phase: answers.marker }),");
    expect(sportModule("football")).toBe(football);
    expect(Object.keys(football.eventSchemas ?? {})).toEqual(expect.arrayContaining([FOOTBALL_GOAL, FOOTBALL_PERIOD]));
  });

  it("W2e G1 G2: a win down extra time and down the shoot-out, every variant's knockout, both winners, replays on the fake ledger — the ET markers through the period sheet, each kick its side's kick tile then Scored / Missed, no finding — and the stored rows fold to the requested path", async () => {
    let cases = 0;
    let kicks = 0;
    let etMarkers = 0;
    for (const v of variantKeys("football")) {
      const cfg = stageCfg("football", resolveSportCfg("football", v), "knockout", v);
      for (const path of ["extraTime", "shootout"] as const) for (const winner of ["home", "away"] as const) {
        const at = `${v} ${path} ${winner}`;
        const r = bracketReq("football", cfg, { kind: "win", winner, path });
        const evs = generateStream(r);
        const { res, ledger } = await replayOnModel(footballPad, evs, ctxOf(r), footballModel(ctxOf(r)));
        expect(res.findings, at).toEqual([]);
        expect(res.rows.map((x) => x.expected.type), at).toEqual(evs.map((e) => e.type));
        for (const row of res.rows) expect(row.verdict, `${at} ${row.expected.type}`).toBe(row.expected.type === FOOTBALL_GOAL ? "fallback" : "equal");
        kicks += res.rows.filter((x) => x.expected.type === FOOTBALL_SHOOTOUT_KICK).length;
        etMarkers += res.rows.filter((x) => x.expected.type === FOOTBALL_PERIOD && String((x.expected.payload as { phase: string }).phase).startsWith("ET_")).length;
        const folded = foldStream(football, cfg, HOME, AWAY, asEvents(ledger));
        expect(matchesRequest(r, folded.outcome, folded.state), at).toBe("match");
        cases++;
      }
    }
    console.info(`pad-adapters: football W2e: ${cases} path win(s) replayed, ${kicks} kick(s) and ${etMarkers} extra-time marker(s) routed`);
    expect(cases).toBe(variantKeys("football").length * 4);
    expect(kicks).toBeGreaterThan(0);
    expect(etMarkers).toBeGreaterThan(0);
  });

  it("W2e G2 routes: a kick is its side's kick tile then the Scored or Missed choice; a kick off the sheet's {by, scored} shape, or by no entrant of the fixture, is refused by name", () => {
    const { r } = summariesOf("football", FOOTBALL_GOAL, "home");
    const ctx = ctxOf(r);
    let checked = 0;
    for (const side of ["home", "away"] as const) for (const scored of [true, false]) {
      expect(footballPad.stepsFor({ type: FOOTBALL_SHOOTOUT_KICK, payload: { by: ctx.entrants[side], scored } }, ctx), `${side} ${scored}`)
        .toEqual([{ kind: "tile", tileId: footballKickTile(side) }, { kind: "choice", optionId: scored ? FOOTBALL_KICK_SCORED : FOOTBALL_KICK_MISSED }]);
      checked++;
    }
    expect(checked).toBe(4);
    for (const payload of [null, {}, { by: "stranger", scored: true }, { by: HOME }, { by: HOME, scored: "yes" }, { by: HOME, scored: true, person: "p1" }] as unknown[]) {
      expect(() => footballPad.stepsFor({ type: FOOTBALL_SHOOTOUT_KICK, payload }, ctx), JSON.stringify(payload)).toThrow(/football\.shootout\.kick payload .* is not the kick sheet's \{by: one of the fixture's entrants, scored: true or false\}/);
    }
  });

  it("W2e G2 pins: each side's kick tile is `kick-<side>` under the shoot-out offer, gated by the engine's own next kicker, and opens a one-step Scored / Missed sheet that writes {by, scored}", () => {
    expect(footballKickTile("home")).toBe("kick-home");
    expect(footballKickTile("away")).toBe("kick-away");
    expect(skin).toMatch(/export function kickSheetKey\(side: Side\): string \{\s*return `kick-\$\{side\}`;/);
    expect(skin).toMatch(/if \(offerable\("football\.shootout\.kick"\)\) \{\s*const next = state\.shootout \? footballNextKicker\(state\.shootout\.kicks\) : null;\s*for \(const side of SIDES\) \{\s*tiles\.push\(\{\s*id: kickSheetKey\(side\),/);
    expect(skin).toContain("action: { sheet: kickSheetKey(side) },");
    expect(skin).toContain("for (const side of SIDES) sheets[kickSheetKey(side)] = kickSheet(view, side);");
    const sheet = skin.slice(skin.indexOf("function kickSheet(view: PadHostView, side: Side): GuidedSheetSpec {"));
    expect(sheet.length, "football.tsx no longer declares kickSheet").toBeLessThan(skin.length);
    expect(sheet).toMatch(/^[\s\S]*?event: "football\.shootout\.kick",[\s\S]*?\{ id: "scored", [\s\S]*?\{ id: "missed", [\s\S]*?buildPayload: \(answers\) => \(\{ by, scored: answers\.outcome === "scored" \}\),/);
    expect([FOOTBALL_KICK_SCORED, FOOTBALL_KICK_MISSED]).toEqual(["scored", "missed"]);
    expect(Object.keys(football.eventSchemas ?? {})).toContain(FOOTBALL_SHOOTOUT_KICK);
    expect(footballPad.emits).toContain(FOOTBALL_SHOOTOUT_KICK);
  });
});

describe.each([["hockey", hockeyPad], ["icehockey", icehockeyPad]] as const)("%s (period kernel)", (sport, pad) => {
  it("replayed on the fake ledger: goal equal, every advance a 1-row fallback, no finding, and the stored rows fold to the requested outcome", async () => {
    const cfg = resolveSportCfg(sport, offlineBuilderDefault(sport));
    const advance = pad.fallbacks.find((f) => f.eventType === `${sport}.period.advance`);
    expect(advance, "advance is declared a fallback").toBeDefined();
    let cases = 0;
    let advances = 0;
    for (const outcome of padOutcomes(outcomesFor(sport, cfg))) {
      const r = req(sport, cfg, outcome);
      const evs = generateStream(r);
      const { res, ledger } = await replayOnModel(pad, evs, ctxOf(r), periodModel(sport, ctxOf(r)));
      expect(res.findings, JSON.stringify(outcome)).toEqual([]);
      expect(res.rows.map((x) => x.expected.type)).toEqual(evs.map((e) => e.type));
      for (const row of res.rows) {
        if (row.expected.type === `${sport}.period.advance`) {
          expect(row.verdict).toBe("fallback");
          expect(row.stored.length).toBe(advance!.rowsFor(row.expected, ctxOf(r)));
          expect((row.stored[0]!.payload as { to: string }).to).toBe((row.expected.payload as { to: string }).to);
          advances++;
        } else {
          expect(row.verdict, row.expected.type).toBe("equal");
        }
      }
      const folded = foldStream(sport === "hockey" ? hockey : icehockey, cfg, HOME, AWAY, ledger.map((x) => ({ type: x.type, payload: x.payload })));
      expect(matchesRequest(r, folded.outcome), JSON.stringify(outcome)).toBe("match");
      cases++;
    }
    // fih-outdoor: 2 wins + a draw, 4 advances each; iihf: 2 wins (no draws), 3 advances each.
    expect({ cases, advances }).toEqual(sport === "hockey" ? { cases: 3, advances: 12 } : { cases: 2, advances: 6 });
  });

  it("Mn-1: a cfg whose periods.count is not a whole number ≥ 1 is refused by name at the first advance — 1.5 periods is no match, and the builder's own count is the positive pair", () => {
    const def = resolveSportCfg(sport, offlineBuilderDefault(sport)) as { periods: { count: number } };
    const r = req(sport, def, { kind: "win", winner: "home" });
    const advance = generateStream(r).find((e) => e.type === `${sport}.period.advance`)!;
    const asCfg = (count: unknown) => ({ ...def, periods: { ...def.periods, count } });
    const first = (count: unknown) => {
      const ctx: TapAdapterContext = { cfg: asCfg(count), entrants: { home: HOME, away: AWAY } };
      pad.stepsFor({ type: "core.start", payload: {} }, ctx);
      return pad.stepsFor(advance, ctx);
    };
    // The positive pair first: a whole count ≥ 1 routes (the builder default's own).
    expect(first(def.periods.count)).toEqual([{ kind: "tile", tileId: PERIOD_ADVANCE_TILE }]);
    let checked = 0;
    for (const bad of [1.5, def.periods.count + 0.5, 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "4", null, undefined]) {
      expect(() => first(bad), String(bad)).toThrow(/periods\.count is .*, not a whole number ≥ 1/);
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("I-1: the advance fallback is judged — the right rows are `fallback`; an advance the pad writes to another label, or an `at` off {period, elapsed}, is a `mismatch` naming it", async () => {
    const cfg = resolveSportCfg(sport, offlineBuilderDefault(sport));
    const r = req(sport, cfg, { kind: "win", winner: "home" });
    const evs = generateStream(r);
    const advs = evs.filter((e) => e.type === `${sport}.period.advance`);
    const toOf = (e: StreamEvent) => (e.payload as { to: string }).to;
    const [first, last] = [advs[0]!, advs.at(-1)!];
    expect(toOf(first)).not.toBe(toOf(last)); // or the wrong label could not be witnessed
    const i = evs.indexOf(first);
    const ctx = ctxOf(r);
    const cases: [string, Parameters<typeof periodModel>[2], string | null][] = [
      ["right", {}, null],
      ["another label", { to: () => toOf(last) }, `to: stored ${JSON.stringify(toOf(last))}, generated ${JSON.stringify(toOf(first))}`],
      ["an at with no elapsed", { at: (phase) => ({ period: phase }) }, null],
      ["an at of a number", { at: () => 0 }, null],
    ];
    for (const [label, knobs, note] of cases) {
      const { res } = await replayOnModel(pad, evs, ctx, periodModel(sport, ctx, knobs));
      if (label === "right") {
        expect(res.rows[i], label).toMatchObject({ verdict: "fallback" });
        expect(res.findings, label).toEqual([]);
        continue;
      }
      expect(res.rows, label).toHaveLength(i + 1);
      expect(res.rows[i], label).toMatchObject({ verdict: "mismatch" });
      if (note !== null) expect(res.rows[i]!.note, label).toBe(`FallbackMismatch — ${note}`);
      else expect(res.rows[i]!.note, label).toMatch(/^FallbackMismatch — stamped at=.* is not \{period: a label, elapsed: a whole number ≥ 0\}$/);
      expect(res.findings, label).toHaveLength(1);
    }
    const judge = pad.fallbacks[0]!.judge!;
    const row = (payload: unknown) => ({ id: "r3", seq: 3, type: first.type, payload });
    const at = { period: "P", elapsed: 0 };
    expect(judge(first, [row({ to: toOf(first), at })])).toEqual({ ok: true, note: null });
    expect(judge(first, [row({ to: toOf(first) })])).toEqual({ ok: true, note: null }); // at is stamped, never required
    expect(judge(first, [row({ to: toOf(first), at }), row({ to: toOf(first), at })])).toEqual({ ok: false, note: "2 rows, where the advance tile writes 1" });
    expect(judge(first, [row({ to: toOf(first), at: { ...at, extra: 1 } })]).ok).toBe(false);
    expect(judge(first, [row({ to: toOf(first), at: { period: "", elapsed: 0 } })]).ok).toBe(false);
    expect(judge(first, [row({ to: toOf(first), at: { period: "P", elapsed: -1 } })]).ok).toBe(false);
    // "a whole number": a fraction is neither a stamp the advance tile writes nor a number of seconds the clock counts (W1d T12 review m-1).
    expect(judge(first, [row({ to: toOf(first), at: { period: "P", elapsed: 1.5 } })]).ok).toBe(false);
    expect(judge(first, [row({ to: toOf(first), at: { period: "P", elapsed: 30 } })]).ok).toBe(true); // its positive pair: a whole number of seconds is stamped
  });

  it("the cursor walks the ENGINE's advance order in every variant — the second FT and the fixed overtime periods included — per fixture, and refuses a wrong-order, early or extra advance naming both labels", () => {
    let checked = 0;
    let withOvertime = 0;
    // W2e Task 20: every variant's cfg, then the overtime shapes the schema allows (one sudden-death period; 1, 2 and 3 fixed periods).
    const cfgs: [string, unknown][] = [
      ...variantKeys(sport).map((v): [string, unknown] => [v, resolveSportCfg(sport, v)]),
      ...([{ kind: "sudden_death", minutes: 5 }, { kind: "periods", count: 1, minutes: 5 }, { kind: "periods", count: 2, minutes: 5 }, { kind: "periods", count: 3, minutes: 5 }] as const)
        .map((overtime): [string, unknown] => [`${overtime.kind}${"count" in overtime ? ` x${overtime.count}` : ""}`, resolveSportCfg(sport, offlineBuilderDefault(sport), { overtime })]),
    ];
    for (const [v, cfg] of cfgs) {
      const order = engineAdvances(sport, cfg);
      expect(order.at(-1), v).toBe("FT");
      // Level play: the first FT ends regulation, and an overtime cfg has a second one at the end of the overtime.
      const overtime = (cfg as { overtime: unknown }).overtime;
      expect(order.filter((x) => x === "FT").length, v).toBe(overtime === null ? 1 : 2);
      if (overtime !== null) withOvertime++;
      const ctx: TapAdapterContext = { cfg, entrants: { home: `${v}-h`, away: `${v}-a` } };
      const other: TapAdapterContext = { cfg, entrants: { home: `${v}-h2`, away: `${v}-a2` } };
      expect(() => pad.stepsFor(adv(sport, order[0]!), ctx), v).toThrow(/before core\.start/);
      pad.stepsFor(START, ctx);
      pad.stepsFor(START, other);
      if (order.length > 1) expect(() => pad.stepsFor(adv(sport, order[1]!), ctx), v).toThrow(`advance would write ${order[0]}, event names ${order[1]}`);
      for (const to of order) {
        expect(pad.stepsFor(adv(sport, to), ctx), `${v} ${to}`).toEqual([{ kind: "tile", tileId: PERIOD_ADVANCE_TILE }]);
        checked++;
      }
      expect(() => pad.stepsFor(adv(sport, "FT"), ctx), v).toThrow(/advance would write nothing \(FT is behind it\), event names FT/);
      // The other fixture's cursor never moved.
      expect(pad.stepsFor(adv(sport, order[0]!), other), v).toEqual([{ kind: "tile", tileId: PERIOD_ADVANCE_TILE }]);
      // A second match on the same pair starts over.
      pad.stepsFor(START, ctx);
      expect(pad.stepsFor(adv(sport, order[0]!), ctx), v).toEqual([{ kind: "tile", tileId: PERIOD_ADVANCE_TILE }]);
    }
    console.info(`pad-adapters: ${sport}: ${checked} advance(s) walked over ${cfgs.length} cfg(s), ${withOvertime} with overtime`);
    expect(checked).toBeGreaterThan(0);
    expect(withOvertime, "the doubled FT and the OT labels were walked").toBeGreaterThanOrEqual(4);
  });

  it("goal routes to its side's tile; a goal by no entrant, or an advance off {to}, is refused by name", () => {
    const cfg = resolveSportCfg(sport, offlineBuilderDefault(sport));
    const ctx: TapAdapterContext = { cfg, entrants: { home: HOME, away: AWAY } };
    if (sport === "hockey") {
      // W2d T18: the tile, then the type's chip — og is the existing Own goal flag.
      expect(pad.stepsFor({ type: `${sport}.goal`, payload: { by: HOME, kind: "fg" } }, ctx)).toEqual([{ kind: "tile", tileId: periodGoalTile("home") }, { kind: "chip", chipId: "kind:fg" }]);
      expect(pad.stepsFor({ type: `${sport}.goal`, payload: { by: AWAY, kind: "pc" } }, ctx)).toEqual([{ kind: "tile", tileId: periodGoalTile("away") }, { kind: "chip", chipId: "kind:pc" }]);
      expect(pad.stepsFor({ type: `${sport}.goal`, payload: { by: AWAY, kind: "og" } }, ctx)).toEqual([{ kind: "tile", tileId: periodGoalTile("away") }, { kind: "chip", chipId: "ownGoal" }]);
      for (const payload of [null, {}, { by: "stranger", kind: "fg" }, { by: HOME }, { by: HOME, kind: "" }, { by: HOME, kind: "fg", person: "p1" }] as unknown[]) {
        expect(() => pad.stepsFor({ type: `${sport}.goal`, payload }, ctx), JSON.stringify(payload)).toThrow(/goal payload .* is not \{by: one of the fixture's entrants, kind: the goal's type\}/);
      }
    } else {
      expect(pad.stepsFor({ type: `${sport}.goal`, payload: { by: HOME } }, ctx)).toEqual([{ kind: "tile", tileId: periodGoalTile("home") }]);
      expect(pad.stepsFor({ type: `${sport}.goal`, payload: { by: AWAY } }, ctx)).toEqual([{ kind: "tile", tileId: periodGoalTile("away") }]);
      for (const payload of [null, {}, { by: "stranger" }, { by: HOME, person: "p1" }, { by: HOME, kind: "fg" }] as unknown[]) {
        expect(() => pad.stepsFor({ type: `${sport}.goal`, payload }, ctx), JSON.stringify(payload)).toThrow(/goal payload .* is not \{by: one of the fixture's entrants\}/);
      }
    }
    pad.stepsFor(START, ctx);
    for (const payload of [null, {}, { to: "" }, { to: "FT", at: { period: "P1", elapsed: 0 } }] as unknown[]) {
      expect(() => pad.stepsFor({ type: `${sport}.period.advance`, payload }, ctx), JSON.stringify(payload)).toThrow(/advance payload .* is not \{to\}/);
    }
    expect(() => pad.stepsFor({ type: `${sport}.shot`, payload: {} }, ctx)).toThrow(new RegExp(`${sport}\\.shot`));
  });

  it("Step 0: the advance row ({to, at}) mismatches the generated {to}, which is why it is a fallback; the goal row is equal", () => {
    const cfg = resolveSportCfg(sport, offlineBuilderDefault(sport));
    const evs = generateStream(req(sport, cfg, { kind: "win", winner: "home" }));
    const g = evs.find((e) => e.type === `${sport}.goal`)!;
    expect(compareRow(g, { id: "r2", seq: 2, type: g.type, payload: sport === "hockey" ? { by: HOME, kind: "fg" } : { by: HOME } }, pad)).toEqual({ verdict: "equal", note: null });
    const a = evs.find((e) => e.type === `${sport}.period.advance`)!;
    const first = sport === "hockey" ? "Q1" : "P1";
    expect(compareRow(a, { id: "r3", seq: 3, type: a.type, payload: { ...(a.payload as object), at: { period: first, elapsed: 0 } } }, pad).verdict).toBe("mismatch");
    expect(pad.fallbacks.map((f) => f.eventType)).toEqual([`${sport}.period.advance`]);
    expect(pad.tolerableExtraKeys?.(a.type) ?? []).toEqual([]);
  });

  it("W2e G2 G3: a win down overtime, the shoot-out or the GWS, every variant's knockout, both winners, replays on the fake ledger — the whistles through the advance tile (the second FT included), the OT goal through its tile, each attempt its side's attempt tile then Scored / Missed, no finding — and the stored rows fold to the requested path", async () => {
    const m = sport === "hockey" ? hockey : icehockey;
    let cases = 0;
    let attempts = 0;
    let secondFt = 0;
    const paths = new Set<string>();
    for (const v of variantKeys(sport)) {
      const cfg = stageCfg(sport, resolveSportCfg(sport, v), "knockout", v);
      for (const path of ["overtime", "shootout", "gws"] as const) for (const winner of ["home", "away"] as const) {
        const r = bracketReq(sport, cfg, { kind: "win", winner, path });
        const evs = streamOf(r);
        if (evs.length === 0) continue; // the sport has no such path under this cfg: declared out of reach, nothing to route
        const at = `${sport} ${v} ${path} ${winner}`;
        const { res, ledger } = await replayOnModel(pad, evs, ctxOf(r), periodModel(sport, ctxOf(r)));
        expect(res.findings, at).toEqual([]);
        expect(res.rows.map((x) => x.expected.type), at).toEqual(evs.map((e) => e.type));
        for (const row of res.rows) expect(row.verdict, `${at} ${row.expected.type}`).toBe(row.expected.type === `${sport}.period.advance` ? "fallback" : "equal");
        attempts += res.rows.filter((x) => x.expected.type === `${sport}.shootout.attempt`).length;
        secondFt += res.rows.filter((x, i, all) => (x.expected.payload as { to?: string }).to === "FT" && all.slice(0, i).some((y) => (y.expected.payload as { to?: string }).to === "FT")).length;
        const folded = foldStream(m, cfg, HOME, AWAY, asEvents(ledger));
        expect(matchesRequest(r, folded.outcome, folded.state), at).toBe("match");
        paths.add(path);
        cases++;
      }
    }
    console.info(`pad-adapters: ${sport} W2e: ${cases} path win(s) replayed (${[...paths].join(", ")}), ${attempts} attempt(s) and ${secondFt} second FT(s) routed`);
    expect(cases).toBeGreaterThan(0);
    expect(attempts).toBeGreaterThan(0);
    // hockey has the shoot-out alone; ice hockey the overtime (with its second FT) and the GWS.
    expect([...paths].sort()).toEqual(sport === "hockey" ? ["shootout"] : ["gws", "overtime"]);
    expect(secondFt > 0, "the overtime's own FT whistle was routed").toBe(sport === "icehockey");
  });

  it("W2e G2 G3 routes: an attempt is its side's attempt tile then the Scored or Missed choice; an attempt off the sheet's {by, scored} shape, or by no entrant of the fixture, is refused by name", () => {
    const cfg = resolveSportCfg(sport, offlineBuilderDefault(sport));
    const ctx: TapAdapterContext = { cfg, entrants: { home: HOME, away: AWAY } };
    let checked = 0;
    for (const side of ["home", "away"] as const) for (const scored of [true, false]) {
      expect(pad.stepsFor({ type: `${sport}.shootout.attempt`, payload: { by: ctx.entrants[side], scored } }, ctx), `${side} ${scored}`)
        .toEqual([{ kind: "tile", tileId: periodAttemptTile(side) }, { kind: "choice", optionId: scored ? PERIOD_ATTEMPT_SCORED : PERIOD_ATTEMPT_MISSED }]);
      checked++;
    }
    expect(checked).toBe(4);
    for (const payload of [null, {}, { by: "stranger", scored: true }, { by: HOME }, { by: HOME, scored: "yes" }, { by: HOME, scored: true, person: "p1" }, { by: HOME, scored: true, void: true }] as unknown[]) {
      expect(() => pad.stepsFor({ type: `${sport}.shootout.attempt`, payload }, ctx), JSON.stringify(payload)).toThrow(/shootout\.attempt payload .* is not the attempt sheet's \{by: one of the fixture's entrants, scored: true or false\}/);
    }
    expect(pad.emits).toContain(`${sport}.shootout.attempt`);
    // An attempt moves no whistle: the advance cursor is the whistles' alone.
    pad.stepsFor(START, ctx);
    pad.stepsFor({ type: `${sport}.shootout.attempt`, payload: { by: HOME, scored: true } }, ctx);
    expect(pad.stepsFor(adv(sport, engineAdvances(sport, cfg)[0]!), ctx)).toEqual([{ kind: "tile", tileId: PERIOD_ADVANCE_TILE }]);
  });

  it("W2e: a cfg whose overtime is neither null, a sudden-death period nor whole fixed periods is refused by name at the first advance", () => {
    const def = resolveSportCfg(sport, offlineBuilderDefault(sport)) as Record<string, unknown>;
    const first = (overtime: unknown) => {
      const ctx: TapAdapterContext = { cfg: { ...def, overtime }, entrants: { home: HOME, away: AWAY } };
      pad.stepsFor(START, ctx);
      return pad.stepsFor(adv(sport, engineAdvances(sport, def)[0]!), ctx);
    };
    expect(first(null)).toEqual([{ kind: "tile", tileId: PERIOD_ADVANCE_TILE }]); // the positive pair
    expect(first({ kind: "sudden_death", minutes: 5 })).toEqual([{ kind: "tile", tileId: PERIOD_ADVANCE_TILE }]);
    expect(first({ kind: "periods", count: 2, minutes: 5 })).toEqual([{ kind: "tile", tileId: PERIOD_ADVANCE_TILE }]);
    let refused = 0;
    for (const bad of [{ kind: "periods", count: 1.5, minutes: 5 }, { kind: "periods", count: 0, minutes: 5 }, { kind: "periods", minutes: 5 }, { kind: "golden", minutes: 5 }, {}, "OT", 5]) {
      expect(() => first(bad), JSON.stringify(bad)).toThrow(/the cfg's overtime is .*, not null, a sudden-death period or a whole number ≥ 1 of fixed periods/);
      refused++;
    }
    expect(refused).toBe(7);
  });
});

describe("the period kernel pins (hockey + icehockey share period-shared.ts)", () => {
  let shared = "";
  beforeAll(() => { shared = readFileSync(resolve(REPO, SKINS, "period-shared.ts"), "utf8"); });

  it("the goal and advance tile ids and payloads, the event names, and the line the advance fallback cites", () => {
    expect(shared).toMatch(/goal: `\$\{k\}\.goal`,\s*advance: `\$\{k\}\.period\.advance`,/);
    expect(shared).toMatch(/if \(offerable\(e\.goal\)\) \{\s*for \(const side of SIDES\) \{\s*tiles\.push\(\{\s*id: `goal-\$\{side\}`,[\s\S]{0,200}?action: \{ event: \{ type: e\.goal, payload: \{ by: entrantOf\(state, side\) \} \} \},/);
    expect(periodGoalTile("away")).toBe("goal-away");
    const tile = /if \(next !== null && offerable\(e\.advance\)\) \{[\s\S]{0,120}?tiles\.push\(\{\s*id: "([^"]+)",/.exec(shared);
    expect(tile, "period-shared.ts no longer builds the advance tile as a literal id under the e.advance offer").not.toBeNull();
    expect(PERIOD_ADVANCE_TILE).toBe(tile![1]);
    let checked = 0;
    for (const pad of [hockeyPad, icehockeyPad]) {
      const f = pad.fallbacks[0]!;
      const cite = /period-shared\.ts:(\d+)/.exec(f.why);
      expect(cite, f.why).not.toBeNull();
      expect(shared.split("\n")[Number(cite![1]) - 1]).toContain("payload: at === undefined ? { to: next } : { to: next, at },");
      checked++;
    }
    expect(checked).toBe(2);
    for (const [key, m] of [["hockey", hockey], ["icehockey", icehockey]] as const) {
      expect(sportModule(key)).toBe(m);
      expect(Object.keys(m.eventSchemas ?? {})).toEqual(expect.arrayContaining([`${key}.goal`, `${key}.period.advance`]));
    }
  });

  it("W2e G2 G3 pins: each side's attempt tile is `attempt-<side>` under the attempt offer in the SHOOTOUT phase, gated by the engine's own shootoutNext, and opens a one-step Scored / Missed sheet that writes {by, scored}", () => {
    expect(periodAttemptTile("home")).toBe("attempt-home");
    expect(periodAttemptTile("away")).toBe("attempt-away");
    expect(shared).toMatch(/export function attemptSheetKey\(side: Side\): string \{\s*return `attempt-\$\{side\}`;/);
    expect(shared).toMatch(/if \(offerable\(e\.attempt\)\) \{\s*const next = asSummary\(view\.summary\)\.detail\?\.shootoutNext;\s*for \(const side of SIDES\) \{\s*tiles\.push\(\{\s*id: attemptSheetKey\(side\),/);
    expect(shared).toContain("...(next === \"home\" || next === \"away\" ? (next === side ? {} : { disabled: true }) : {}),");
    expect(shared).toContain("action: { sheet: attemptSheetKey(side) },");
    expect(shared).toContain("sheets[attemptSheetKey(side)] = attemptSheet(spec, view, side);");
    expect(shared).toContain("if (eventType === e.attempt) return phase === SHOOTOUT_PHASE;");
    const sheet = shared.slice(shared.indexOf("function attemptSheet(spec: PeriodSkinSpec, view: PadHostView, side: Side): GuidedSheetSpec {"));
    expect(sheet.length, "period-shared.ts no longer declares attemptSheet").toBeLessThan(shared.length);
    expect(sheet).toMatch(/^[\s\S]*?event: e\.attempt,[\s\S]*?\{ id: "scored", [\s\S]*?\{ id: "missed", [\s\S]*?buildPayload: \(answers\) => \(\{ by, scored: answers\.outcome === "scored" \}\),/);
    expect([PERIOD_ATTEMPT_SCORED, PERIOD_ATTEMPT_MISSED]).toEqual(["scored", "missed"]);
    for (const [key, m, pad] of [["hockey", hockey, hockeyPad], ["icehockey", icehockey, icehockeyPad]] as const) {
      expect(Object.keys(m.eventSchemas ?? {})).toContain(`${key}.shootout.attempt`);
      expect(pad.emits).toContain(`${key}.shootout.attempt`);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 11: cricket, boardgame, carrom.

const NUM_SEL = selectorForTapStep({ kind: "number", value: 0 });
const CONFIRM_SEL = selectorForTapStep({ kind: "confirm" });
const HALF_SEL = (side: "home" | "away") => selectorForTapStep({ kind: "half", side });
const CHIP_SEL = (chipId: string) => selectorForTapStep({ kind: "chip", chipId });
const numberOf = (tap: string): number | null => (tap.startsWith(`${NUM_SEL}=`) ? Number(tap.slice(NUM_SEL.length + 1)) : null);
const asEvents = (rows: readonly (LedgerRow | RowIn)[]): StreamEvent[] => rows.map((r) => ({ type: r.type, payload: r.payload }));
interface InningsLike { runs: number; wickets: number; legalBalls: number; closed: boolean }

/** cricket as Step 0 saw it (2026-09-30, 320, t20): an over sheet is the
 *  overSummary tile, then runs, wickets and balls, each a number and a
 *  confirm. It writes ONE row per over: this over added onto the fold's open
 *  innings (0/0/0 when none is open), `partial: true`. Once the engine has an
 *  outcome the tile is gone, so an over sheet after it writes nothing. */
function cricketModel(ctx: TapAdapterContext, o: { wickets?: (typed: number) => number } = {}) {
  return (taps: readonly string[], ledger: readonly LedgerRow[]): RowIn[] => {
    if (taps.length === 1 && taps[0] === START_SEL) return [{ type: "core.start", payload: {} }];
    const out: RowIn[] = [];
    for (let i = 0; i + 7 <= taps.length; i += 7) {
      const c = taps.slice(i, i + 7);
      const [r, typedW, b] = [numberOf(c[1]!), numberOf(c[3]!), numberOf(c[5]!)];
      const w = typedW === null ? null : (o.wickets?.(typedW) ?? typedW);
      if (c[0] !== TILE("overSummary") || c[2] !== CONFIRM_SEL || c[4] !== CONFIRM_SEL || c[6] !== CONFIRM_SEL || r === null || w === null || b === null) return out;
      const folded = foldStream(cricket, ctx.cfg, ctx.entrants.home, ctx.entrants.away, asEvents([...ledger, ...out]));
      if (folded.outcome !== null) return out;
      const open = ((folded.state as { innings?: InningsLike[] }).innings ?? []).find((x) => !x.closed);
      const base = open ?? { runs: 0, wickets: 0, legalBalls: 0 };
      out.push({ type: "cricket.innings.summary", payload: { runs: base.runs + r, wickets: base.wickets + w, legalBalls: base.legalBalls + b, partial: true } });
    }
    return out;
  };
}

describe("cricket", () => {
  let skin = "";
  beforeAll(() => { skin = readFileSync(resolve(REPO, SKINS, "cricket.tsx"), "utf8"); });

  it("cricket: over steps sum to the generated innings, and rowsFor matches — both innings of both outcomes, every generated variant, ballsPerOver from the engine cfg", () => {
    const summary = cricketPad.fallbacks.find((f) => f.eventType === CRICKET_SUMMARY);
    expect(summary, "cricket.innings.summary is declared a fallback").toBeDefined();
    let innings = 0;
    for (const v of variantKeys("cricket")) {
      const cfg = resolveSportCfg("cricket", v);
      const bpo = (cfg as { ballsPerOver: number }).ballsPerOver;
      for (const winner of ["home", "away"] as const) {
        const r = req("cricket", cfg, { kind: "win", winner });
        const evs = streamOf(r);
        if (evs.length === 0) continue;
        cricketPad.stepsFor(START, ctxOf(r));
        for (const e of evs.filter((x) => x.type === CRICKET_SUMMARY)) {
          const p = e.payload as { runs: number; wickets: number; legalBalls: number };
          const overs = overSplit(p, bpo);
          const at = `${v} ${winner} ${JSON.stringify(p)}`;
          expect(overs.length, at).toBe(Math.ceil(p.legalBalls / bpo));
          expect(overs.reduce((s, o) => s + o.runs, 0), at).toBe(p.runs);
          expect(overs.reduce((s, o) => s + o.wickets, 0), at).toBe(p.wickets);
          expect(overs.reduce((s, o) => s + o.balls, 0), at).toBe(p.legalBalls);
          for (const [k, o] of overs.entries()) {
            expect(o.balls, at).toBeLessThanOrEqual(bpo);
            expect(o.balls, at).toBeGreaterThanOrEqual(1);
            // The brief's spread: floor(runs/overs) on every over but the last, which takes the remainder,
            // so a chase never passes its target before its last over.
            if (k < overs.length - 1) expect({ runs: o.runs, balls: o.balls, wickets: o.wickets }, at).toEqual({ runs: Math.floor(p.runs / overs.length), balls: bpo, wickets: 0 });
          }
          const steps = cricketPad.stepsFor(e, ctxOf(r));
          expect(steps, at).toEqual(overs.flatMap((o) => [
            { kind: "tile", tileId: CRICKET_OVER_TILE },
            { kind: "number", value: o.runs }, { kind: "confirm" },
            { kind: "number", value: o.wickets }, { kind: "confirm" },
            { kind: "number", value: o.balls }, { kind: "confirm" },
          ]));
          // Step 0: every generated innings ends itself (balls out, or the chase past its target), so no close row.
          expect(summary!.rowsFor(e, ctxOf(r)), at).toBe(Math.ceil(p.legalBalls / bpo));
          innings++;
        }
      }
    }
    console.info(`pad-adapters: cricket: ${innings} generated innings split into overs`);
    expect(innings).toBeGreaterThanOrEqual(4); // t20 alone: 2 innings × 2 outcomes
  });

  it("replayed on the fake ledger: every innings a fallback of one row per over, no finding, and the stored rows fold to the requested outcome", async () => {
    const cfg = resolveSportCfg("cricket", offlineBuilderDefault("cricket"));
    const bpo = (cfg as { ballsPerOver: number }).ballsPerOver;
    let cases = 0;
    const rowsPer: number[] = [];
    for (const winner of ["home", "away"] as const) {
      const r = req("cricket", cfg, { kind: "win", winner });
      const evs = generateStream(r);
      const { res, ledger } = await replayOnModel(cricketPad, evs, ctxOf(r), cricketModel(ctxOf(r)));
      expect(res.findings, winner).toEqual([]);
      expect(res.rows.map((x) => x.verdict)).toEqual(["equal", "fallback", "fallback"]);
      for (const row of res.rows.slice(1)) {
        expect(row.stored.length).toBe(Math.ceil((row.expected.payload as { legalBalls: number }).legalBalls / bpo));
        rowsPer.push(row.stored.length);
      }
      const folded = foldStream(cricket, cfg, HOME, AWAY, asEvents(ledger));
      expect(matchesRequest(r, folded.outcome), winner).toBe("match");
      cases++;
    }
    expect(cases).toBe(2);
    expect(rowsPer).toEqual([20, 20, 20, 10]); // t20: 120 balls = 20 overs; the away chase 60 balls = 10
  });

  it("I-1: the innings fallback is judged — its last over row, less `partial`, is the generated summary; a pad that drops every over's wickets (the review's probe) is a `mismatch` naming wickets", async () => {
    const cfg = resolveSportCfg("cricket", offlineBuilderDefault("cricket"));
    const bpo = (cfg as { ballsPerOver: number }).ballsPerOver;
    let checked = 0;
    for (const winner of ["home", "away"] as const) {
      const r = req("cricket", cfg, { kind: "win", winner });
      const evs = generateStream(r);
      const first = evs.find((e) => e.type === CRICKET_SUMMARY)!;
      const p = first.payload as { runs: number; wickets: number; legalBalls: number };
      expect(p.wickets, winner).toBeGreaterThan(0); // or a dropped wicket could not be witnessed
      const { res } = await replayOnModel(cricketPad, evs, ctxOf(r), cricketModel(ctxOf(r), { wickets: () => 0 }));
      const overs = Math.ceil(p.legalBalls / bpo);
      const note = `FallbackMismatch — the last of ${overs} over rows: wickets: stored 0, generated ${p.wickets}`;
      expect(res.rows.map((x) => x.verdict), winner).toEqual(["equal", "mismatch"]);
      expect(res.rows[1]!.note, winner).toBe(note);
      expect(res.rows[1]!.stored, winner).toHaveLength(overs);
      expect(res.findings, winner).toEqual([`stopped after event 2 of ${evs.length}: ${note}`]);
      checked++;
    }
    expect(checked).toBe(2);
    // The judge reads the LAST row only (each over row is cumulative), and `partial` may only be true.
    const { sums } = summariesOf("cricket", CRICKET_SUMMARY, "home");
    const s = sums[0]!;
    const p = s.payload as { runs: number; wickets: number; legalBalls: number };
    const row = (payload: unknown, seq = 9) => ({ id: `r${seq}`, seq, type: CRICKET_SUMMARY, payload });
    const judge = cricketPad.fallbacks[0]!.judge!;
    const early = row({ runs: 0, wickets: 0, legalBalls: bpo, partial: true }, 2);
    expect(judge(s, [early, row({ ...p, partial: true })])).toEqual({ ok: true, note: null });
    expect(judge(s, [row({ ...p, partial: true }), early])).toEqual({ ok: false, note: `the last of 2 over rows: runs: stored 0, generated ${p.runs}` });
    expect(judge(s, [row({ ...p, partial: false })])).toEqual({ ok: false, note: "the last of 1 over rows: stamped partial=false is not true" });
    expect(judge(s, [row({ ...p, legalBalls: p.legalBalls - 1, partial: true })])).toEqual({ ok: false, note: `the last of 1 over rows: legalBalls: stored ${p.legalBalls - 1}, generated ${p.legalBalls}` });
    expect(judge(s, [row({ runs: p.runs, legalBalls: p.legalBalls, partial: true })])).toEqual({ ok: false, note: `the last of 1 over rows: wickets: stored (absent), generated ${p.wickets}` });
    expect(judge(s, [])).toEqual({ ok: false, note: "no over row stored for the innings" });
  });

  it("M-4: what a fixture has tapped lives in the adapter, never the module — a second adapter knows nothing of the first's fixtures, and stepsFor is one-shot per event", () => {
    const cfg = resolveSportCfg("cricket", offlineBuilderDefault("cricket"));
    const r = req("cricket", cfg, { kind: "win", winner: "home" });
    const ctx = ctxOf(r);
    const [first, second] = generateStream(r).filter((e) => e.type === CRICKET_SUMMARY);
    const a = makeCricketPad();
    const b = makeCricketPad();
    expect(a).not.toBe(b);
    a.stepsFor(START, ctx);
    const aFirst = a.stepsFor(first!, ctx);
    // b never saw this fixture's core.start. A module-level record would hold a's innings for the same entrant pair
    // and answer b's summary as the chase; each adapter's own record has nothing, and refuses it by name.
    expect(() => b.stepsFor(first!, ctx)).toThrow(/before core\.start/);
    // a's record is untouched by b's refusal: its next summary is its second innings, tapped as the chase.
    expect(a.stepsFor(second!, ctx).length).toBeGreaterThan(0);
    // b, once started, answers the same steps as a fresh adapter (and as a did).
    const fresh = makeCricketPad();
    fresh.stepsFor(START, ctx);
    b.stepsFor(START, ctx);
    expect(b.stepsFor(first!, ctx)).toEqual(fresh.stepsFor(first!, ctx));
    expect(b.stepsFor(first!, ctx).length).toBeGreaterThan(0); // (b's own second innings: the one-shot below)
    expect(fresh.stepsFor(first!, ctx)).toEqual(aFirst);
    // Two fixtures on ONE adapter are independent (the entrant pair is the key): another pair has no record yet.
    const other: TapAdapterContext = { cfg, entrants: { home: "e-other-h", away: "e-other-a" } };
    expect(() => a.stepsFor(first!, other)).toThrow(/before core\.start/);
    // One-shot per event (types.ts): asking again for the same event is a SECOND innings; a third ask is a third innings, refused.
    const once = makeCricketPad();
    once.stepsFor(START, ctx);
    once.stepsFor(first!, ctx);
    once.stepsFor(first!, ctx);
    expect(() => once.stepsFor(first!, ctx)).toThrow(/a third innings/);
    // core.start resets a fixture's record: the same pair is a fresh match.
    once.stepsFor(START, ctx);
    expect(once.stepsFor(first!, ctx)).toEqual(aFirst);
  });

  it("an innings the engine would not close itself, a chase past its target before its last over, a third innings, or no core.start is refused by name", () => {
    const cfg = resolveSportCfg("cricket", offlineBuilderDefault("cricket"));
    const B = (cfg as { ballsPerInnings: number }).ballsPerInnings;
    const allOut = declaredAllOut(cricket.padSpec?.(cfg as never));
    const ctx = (tag: string): TapAdapterContext => ({ cfg, entrants: { home: `${tag}-h`, away: `${tag}-a` } });
    const sum = (runs: number, wickets: number, legalBalls: number): StreamEvent => ({ type: CRICKET_SUMMARY, payload: { runs, wickets, legalBalls } });
    expect(() => cricketPad.stepsFor(sum(100, 2, B), ctx("nostart"))).toThrow(/before core\.start/);
    const open = ctx("open");
    cricketPad.stepsFor(START, open);
    expect(() => cricketPad.stepsFor(sum(100, 2, B - 6), open)).toThrow(/innings 1 would stay open/);
    // Its positive pair: a short innings all out closes itself — here mid-over,
    // so the last over is short (every generated innings ends on a full over).
    const bpo = (cfg as { ballsPerOver: number }).ballsPerOver;
    const allOutSteps = cricketPad.stepsFor(sum(100, allOut, B - 4), open);
    const balls = allOutSteps.filter((x, i) => x.kind === "number" && i % 7 === 5).map((x) => (x as { value: number }).value);
    expect(balls.length).toBe(Math.ceil((B - 4) / bpo));
    expect(balls.at(-1)).toBe(B - 4 - bpo * (balls.length - 1));
    expect(balls.at(-1)).not.toBe(bpo);
    expect(balls.reduce((a, b) => a + b, 0)).toBe(B - 4);
    const chase = ctx("chase");
    cricketPad.stepsFor(START, chase);
    cricketPad.stepsFor(sum(180, 4, B), chase);
    expect(() => cricketPad.stepsFor(sum(300, 3, 60), chase)).toThrow(/the chase passes its target \(181\) at over 7 of 10/);
    expect(cricketPad.stepsFor(sum(181, 3, 60), chase).length).toBe(10 * 7);
    expect(() => cricketPad.stepsFor(sum(10, 1, 6), chase)).toThrow(/a third innings/);
    const shape = ctx("shape");
    cricketPad.stepsFor(START, shape);
    for (const payload of [null, { runs: 1, wickets: 0 }, { runs: 1, wickets: 0, legalBalls: 0 }, { runs: -1, wickets: 0, legalBalls: B }, { runs: 1.5, wickets: 0, legalBalls: B }, { runs: 1, wickets: 0, legalBalls: B, partial: false }, { runs: 1, wickets: 0, legalBalls: B, declared: true }, { runs: 1, wickets: 0, legalBalls: B, extra: 1 }, { runs: 1, wickets: 0, legalBalls: B + 1 }] as unknown[]) {
      expect(() => cricketPad.stepsFor({ type: CRICKET_SUMMARY, payload }, shape), JSON.stringify(payload)).toThrow(/is not \{runs, wickets, legalBalls\}/);
    }
    expect(() => cricketPad.stepsFor({ type: "cricket.ball", payload: {} }, shape)).toThrow(/cricket\.ball/);
  });

  it("Step 0: an over row (cumulative, partial: true) mismatches the generated non-partial summary, which is why the innings is a fallback", () => {
    const { sums } = summariesOf("cricket", CRICKET_SUMMARY, "away");
    const last = { id: "r21", seq: 21, type: CRICKET_SUMMARY, payload: { runs: 150, partial: true, wickets: 5, legalBalls: 120 } };
    expect(sums[0]!.payload).toEqual({ runs: 150, wickets: 5, legalBalls: 120 });
    expect(compareRow(sums[0]!, last, cricketPad).verdict).toBe("mismatch");
    expect(cricketPad.fallbacks.map((f) => f.eventType)).toEqual([CRICKET_SUMMARY]);
    expect(cricketPad.tolerableExtraKeys?.(CRICKET_SUMMARY) ?? []).toEqual([]);
  });

  it("pins: the overSummary tile, its sheet's three steps in order with balls opening at ballsPerOver, the partial payload at the line the fallback cites, and the engine's event", () => {
    expect(skin).toMatch(/if \(fidelity !== "fine"\) \{[\s\S]{0,1400}?tiles\.push\(superOverTile\(dueAwareTile\(\{\s*id: "overSummary",/);
    const tile = /tiles\.push\(superOverTile\(dueAwareTile\(\{\s*id: "([^"]+)",/.exec(skin);
    expect(CRICKET_OVER_TILE).toBe(tile![1]);
    expect(skin).toContain(`action: { sheet: "${CRICKET_OVER_TILE}" },`);
    expect(skin).toContain(`${CRICKET_OVER_TILE}: overSummarySheet(view),`);
    expect(skin).toMatch(/\{ id: "runs", kind: "number",[^}]*initial: 0,[^}]*\},\s*\{ id: "wickets", kind: "number",[^}]*initial: 0,[^}]*\},\s*\{ id: "balls", kind: "number",[^}]*initial: bpo,[^}]*\},/);
    expect(skin).toMatch(/event: "cricket\.innings\.summary",\s*steps,\s*buildPayload: \(answers\) => \(\{\s*runs: runs \+ Number\(answers\.runs\),\s*wickets: wickets \+ Number\(answers\.wickets\),\s*legalBalls: legalBalls \+ Number\(answers\.balls\),\s*partial: true,/);
    const f = cricketPad.fallbacks[0]!;
    const cite = /cricket\.tsx:(\d+)/.exec(f.why);
    expect(cite, f.why).not.toBeNull();
    expect(skin.split("\n")[Number(cite![1]) - 1]!.trim()).toBe("partial: true,");
    expect(sportModule("cricket")).toBe(cricket);
    expect(Object.keys(cricket.eventSchemas ?? {})).toContain(CRICKET_SUMMARY);
  });
});

/** boardgame as Step 0 saw it (tapModel S): a half or the draw tile HOLDS a
 *  result — `{winner}` from the half's side, `{winner: null}` from the draw
 *  tile — a method chip rewrites the held `method`, and the hold's release
 *  writes the one row. */
function boardgameModel(ctx: TapAdapterContext) {
  return (taps: readonly string[]): RowIn[] => {
    if (taps.length === 1 && taps[0] === START_SEL) return [{ type: "core.start", payload: {} }];
    // W2a (loop H's plan, NOT yet seen in a browser — Step 8 proves it against the real pad): the tie-break tile opens
    // a sheet of choices, rung then winner (then the score, which "none" skips), and its last choice writes the row.
    if (taps[0] === TILE(BOARDGAME_TIEBREAK_TILE)) {
      const rest = taps.slice(1);
      // W2c design pass: the pad shows the rung pick only when the stage plays more than one rung; a one-rung stage opens
      // on that rung's first step, so there is no pick tap to read and the rung is the stage's own.
      const played = effectiveRungs({ tiebreakRungs: (ctx.cfg as { tiebreakRungs?: TiebreakRung[] }).tiebreakRungs });
      const asked = played.length !== 1;
      const rung: string | undefined = asked ? CHOICE_ID.exec(rest[0] ?? "")?.[1] : played[0];
      // A rung the pad does not offer is a tap on nothing: no row.
      if (rung === undefined || !(played as readonly string[]).includes(rung)) return [];
      const after = asked ? rest.slice(1) : rest;
      if (rung === ARMAGEDDON) {
        // W2c BG-KO-2 (S5): Black, then the result, then the read-back's Confirm — the Confirm is what writes the row,
        // so a sheet abandoned on the result step records nothing.
        const black = CHOICE_ID.exec(after[0] ?? "")?.[1];
        const result = CHOICE_ID.exec(after[1] ?? "")?.[1];
        const side = black?.startsWith(BLACK_OPTION_PREFIX) ? black.slice(BLACK_OPTION_PREFIX.length) : undefined;
        const outcome = result?.startsWith(RESULT_OPTION_PREFIX) ? result.slice(RESULT_OPTION_PREFIX.length) : undefined;
        const complete = after.length === 3 && after[2] === CONFIRM_SEL && (side === "home" || side === "away") && (ARMAGEDDON_RESULTS as readonly (string | undefined)[]).includes(outcome);
        return complete ? [{ type: BOARDGAME_TIEBREAK, payload: { rung, black: ctx.entrants[side as "home" | "away"], result: outcome } }] : [];
      }
      const [side, score] = after.map((t) => CHOICE_ID.exec(t)?.[1]);
      const complete = after.length === 2 && (side === "home" || side === "away") && score === TIEBREAK_SCORE_NONE;
      return complete ? [{ type: BOARDGAME_TIEBREAK, payload: { rung, winner: ctx.entrants[side] } }] : [];
    }
    let held: Record<string, unknown> | null = null;
    for (const t of taps) {
      if (t === HALF_SEL("home")) held = { winner: ctx.entrants.home };
      else if (t === HALF_SEL("away")) held = { winner: ctx.entrants.away };
      else if (t === TILE("draw")) held = { winner: null };
      else if (held !== null && t.startsWith(CHIP_SEL("method:").slice(0, -2))) {
        const m = /pad-dock-chip-method:([^"]+)"/.exec(t);
        if (m !== null) held = { ...(held as Record<string, unknown>), method: m[1] };
      }
    }
    return held === null ? [] : [{ type: "boardgame.result", payload: held }];
  };
}

describe("boardgame", () => {
  let skin = "";
  beforeAll(() => { skin = readFileSync(resolve(REPO, SKINS, "boardgame.tsx"), "utf8"); });
  // W2e T10 (BG-RS-1): the skin no longer restates the two lists, it re-exports the ENGINE's (the write path refuses a result
  // whose method is in only one list against the winner it was given). So the list is the engine's own, and the skin is
  // pinned to take it from there rather than to carry a literal of its own.
  const listOf = (name: "DECISIVE_METHODS" | "DRAWN_METHODS"): string[] => {
    const wired = new RegExp(`export const ${name}: readonly string\\[\\] = ENGINE_${name};`);
    expect(skin, `boardgame.tsx no longer takes ${name} from the engine`).toMatch(wired);
    return [...(name === "DECISIVE_METHODS" ? DECISIVE_METHODS : DRAWN_METHODS)];
  };

  it("boardgame: a draw's steps never tap a half — the draw tile then its method chip; a win is the winner's half then its method chip", () => {
    const cfg = resolveSportCfg("boardgame", offlineBuilderDefault("boardgame"));
    let draws = 0;
    let wins = 0;
    for (const outcome of padOutcomes(outcomesFor("boardgame", cfg))) {
      const r = req("boardgame", cfg, outcome);
      for (const e of generateStream(r).filter((x) => x.type === BOARDGAME_RESULT)) {
        const p = e.payload as { winner: string | null; method: string };
        const steps = boardgamePad.stepsFor(e, ctxOf(r));
        if (p.winner === null) {
          expect(steps.some((s) => s.kind === "half")).toBe(false);
          expect(steps).toEqual([{ kind: "tile", tileId: BOARDGAME_DRAW_TILE }, { kind: "chip", chipId: methodChipId(p.method) }]);
          draws++;
        } else {
          const side = p.winner === HOME ? "home" : "away";
          expect(steps).toEqual([{ kind: "half", side }, { kind: "chip", chipId: methodChipId(p.method) }]);
          wins++;
        }
      }
    }
    expect({ draws, wins }).toEqual({ draws: 1, wins: 2 });
  });

  it("replayed on the fake ledger: every result row equal, and the stored rows fold to the requested outcome", async () => {
    const cfg = resolveSportCfg("boardgame", offlineBuilderDefault("boardgame"));
    let cases = 0;
    for (const outcome of padOutcomes(outcomesFor("boardgame", cfg))) {
      const r = req("boardgame", cfg, outcome);
      const { res, ledger } = await replayOnModel(boardgamePad, generateStream(r), ctxOf(r), boardgameModel(ctxOf(r)));
      expect(res.findings, JSON.stringify(outcome)).toEqual([]);
      expect(res.rows.map((x) => x.verdict)).toEqual(["equal", "equal"]);
      expect(matchesRequest(r, foldStream(boardgame, cfg, HOME, AWAY, asEvents(ledger)).outcome), JSON.stringify(outcome)).toBe("match");
      cases++;
    }
    expect(cases).toBe(3);
  });

  it("a result by no entrant, with no method, or with a key past {winner, method} is refused by name", () => {
    const r = req("boardgame", resolveSportCfg("boardgame", offlineBuilderDefault("boardgame")), { kind: "win", winner: "home" });
    for (const payload of [null, { winner: "stranger", method: "checkmate" }, { winner: HOME }, { winner: HOME, method: "" }, { winner: null }, { winner: HOME, method: "checkmate", moves: 40 }] as unknown[]) {
      expect(() => boardgamePad.stepsFor({ type: BOARDGAME_RESULT, payload }, ctxOf(r)), JSON.stringify(payload)).toThrow(/is not \{winner: an entrant of the fixture or null, method\}/);
    }
    expect(() => boardgamePad.stepsFor({ type: "boardgame.pairing", payload: {} }, ctxOf(r))).toThrow(/boardgame\.pairing/);
  });

  it("Step 0: the rows Step 0 saw ({method, winner}) are equal to the generated results; no fallback, no tolerated key", () => {
    const cfg = resolveSportCfg("boardgame", offlineBuilderDefault("boardgame"));
    let checked = 0;
    for (const outcome of [{ kind: "win", winner: "home" }, { kind: "draw" }] as const) {
      const e = generateStream(req("boardgame", cfg, outcome)).find((x) => x.type === BOARDGAME_RESULT)!;
      const seen = outcome.kind === "draw" ? { method: "agreement", winner: null } : { method: "checkmate", winner: HOME };
      expect(compareRow(e, { id: "r2", seq: 2, type: BOARDGAME_RESULT, payload: seen }, boardgamePad)).toEqual({ verdict: "equal", note: null });
      checked++;
    }
    expect(checked).toBe(2);
    expect(boardgamePad.fallbacks).toEqual([]);
  });

  it("pins: the draw tile id and its {winner: null}, the method chip id shape, tap model S, the result type, and every generated method is a chip the dock offers", () => {
    const tile = /export const DRAW_TILE_ID = "([^"]+)";/.exec(skin);
    expect(tile, "boardgame.tsx no longer exports DRAW_TILE_ID").not.toBeNull();
    expect(BOARDGAME_DRAW_TILE).toBe(tile![1]);
    expect(skin).toMatch(/id: DRAW_TILE_ID,[\s\S]{0,200}?action: \{ event: \{ type: RESULT_TYPE, payload: \{ winner: null \} \} \},/);
    expect(skin).toContain("id: `method:${method}`,");
    expect(methodChipId("checkmate")).toBe("method:checkmate");
    expect(skin).toContain('tapModel: "S",');
    expect(skin).toContain("export const RESULT_TYPE = `${SPORT}.result`;");
    expect(skin).toContain('const SPORT = "boardgame";');
    expect(Object.keys(boardgame.eventSchemas ?? {})).toContain(BOARDGAME_RESULT);
    const decisive = listOf("DECISIVE_METHODS");
    const drawn = listOf("DRAWN_METHODS");
    let checked = 0;
    for (const r of requestsFor("boardgame")) {
      for (const e of streamOf(r).filter((x) => x.type === BOARDGAME_RESULT)) {
        const p = e.payload as { winner: string | null; method: string };
        expect(p.winner === null ? drawn : decisive, JSON.stringify(p)).toContain(p.method);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  /** The tie-break requests the matrix can make of a bracket: rapid and blitz name the winner; the Armageddon names who
   *  had Black (the generator's `winner` IS Black) and the result — Black won, or drawn (BG-KO-2: Black advances). */
  const tiebreakRequests = (): { label: string; outcome: RequestedOutcome }[] =>
    TIEBREAK_RUNGS.flatMap((rung) =>
      (["home", "away"] as const).flatMap((winner) =>
        (rung === ARMAGEDDON ? (["black", "draw"] as const) : ([undefined] as const)).map((result) => ({
          label: `${rung}/${winner}${result === undefined ? "" : `/${result}`}`,
          outcome: { kind: "tiebreak", rung, winner, ...(result === undefined ? {} : { result }) } as RequestedOutcome,
        })),
      ),
    );

  it("W2a tie-break (BG-KO-1, ruling 82; W2c BG-KO-2): the tile and the rung; then the winner and the score skipped for rapid and blitz, or Black, the result and the read-back's Confirm for the Armageddon — every rung the engine declares, both sides, a drawn Armageddon too", () => {
    const cfg = stageCfg("boardgame", resolveSportCfg("boardgame", offlineBuilderDefault("boardgame")), "knockout", offlineBuilderDefault("boardgame"));
    let driven = 0;
    let drawn = 0;
    for (const { label, outcome } of tiebreakRequests()) {
      const o = outcome as Extract<RequestedOutcome, { kind: "tiebreak" }>;
      const r = bracketReq("boardgame", cfg, outcome);
      const tb = generateStream(r).filter((e) => e.type === BOARDGAME_TIEBREAK);
      expect(tb, label).toHaveLength(1);
      const tail: TapStep[] =
        o.rung === ARMAGEDDON
          ? [{ kind: "choice", optionId: `black-${o.winner}` }, { kind: "choice", optionId: `result-${o.result}` }, { kind: "confirm" }]
          : [{ kind: "choice", optionId: o.winner }, { kind: "choice", optionId: TIEBREAK_SCORE_NONE }];
      expect(boardgamePad.stepsFor(tb[0]!, ctxOf(r)), label).toEqual([{ kind: "tile", tileId: BOARDGAME_TIEBREAK_TILE }, { kind: "choice", optionId: o.rung }, ...tail]);
      if (o.result === "draw") drawn++;
      driven++;
    }
    expect(driven).toBe((TIEBREAK_RUNGS.length - 1) * 2 + 2 * 2); // rapid, blitz × both sides; Armageddon × both Black × {Black won, drawn}
    expect(drawn, "a DRAWN Armageddon is in the sweep, for both Blacks").toBe(2);
    expect(TIEBREAK_RUNGS).toContain(ARMAGEDDON); // the one rung with no score step is one the engine declares
    expect(boardgamePad.emits).toContain(BOARDGAME_TIEBREAK);
  });

  it("W2c design pass: a stage that plays ONE rung shows no rung step, so the adapter taps none — every rung the engine declares, both sides, replayed on the fake ledger — and a rung the stage does not play is refused by name", async () => {
    const base = stageCfg("boardgame", resolveSportCfg("boardgame", offlineBuilderDefault("boardgame")), "knockout", offlineBuilderDefault("boardgame"));
    /** The bracket's cfg with the stage's rung list set (BG-KO-3). */
    const playing = (rungs: readonly string[]) => ({ ...(base as Record<string, unknown>), tiebreakRungs: rungs });
    let driven = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const cfg = playing([rung]);
      for (const winner of ["home", "away"] as const) {
        const outcome = { kind: "tiebreak", rung, winner, ...(rung === ARMAGEDDON ? { result: "black" } : {}) } as RequestedOutcome;
        const label = `${rung}/${winner}`;
        const r = bracketReq("boardgame", cfg, outcome);
        const tb = generateStream(r).filter((e) => e.type === BOARDGAME_TIEBREAK);
        expect(tb, label).toHaveLength(1);
        const tail: TapStep[] =
          rung === ARMAGEDDON
            ? [{ kind: "choice", optionId: `black-${winner}` }, { kind: "choice", optionId: "result-black" }, { kind: "confirm" }]
            : [{ kind: "choice", optionId: winner }, { kind: "choice", optionId: TIEBREAK_SCORE_NONE }];
        // The pad never shows the pick for a one-rung stage, so a tap on `rapid` / `armageddon` would find no such option.
        expect(boardgamePad.stepsFor(tb[0]!, ctxOf(r)), label).toEqual([{ kind: "tile", tileId: BOARDGAME_TIEBREAK_TILE }, ...tail]);
        const { res, ledger } = await replayOnModel(boardgamePad, generateStream(r), ctxOf(r), boardgameModel(ctxOf(r)));
        expect(res.findings, label).toEqual([]);
        expect(res.rows.map((x) => x.verdict), label).toEqual(["equal", "equal", "equal"]);
        expect(matchesRequest(r, foldStream(boardgame, cfg, HOME, AWAY, asEvents(ledger)).outcome), label).toBe("match");
        driven++;
      }
    }
    expect(driven, "every rung the engine declares, both sides").toBe(TIEBREAK_RUNGS.length * 2);
    // A rung the stage does not play is not on the pad: the adapter refuses rather than tap an option that is not there.
    const only = bracketReq("boardgame", playing(["rapid"]), { kind: "tiebreak", rung: "rapid", winner: "home" });
    expect(() => boardgamePad.stepsFor({ type: BOARDGAME_TIEBREAK, payload: { rung: "blitz", winner: HOME } }, ctxOf(only))).toThrow(/stage does not play the blitz rung/);
    expect(() => boardgamePad.stepsFor({ type: BOARDGAME_TIEBREAK, payload: { rung: ARMAGEDDON, black: HOME, result: "draw" } }, ctxOf(only))).toThrow(/stage does not play the armageddon rung/);
    // …and the several-rung stage still taps the pick (the positive pair of everything above).
    const several = bracketReq("boardgame", playing(["rapid", "armageddon"]), { kind: "tiebreak", rung: "rapid", winner: "home" });
    expect(boardgamePad.stepsFor({ type: BOARDGAME_TIEBREAK, payload: { rung: "rapid", winner: HOME } }, ctxOf(several))[1]).toEqual({ kind: "choice", optionId: "rapid" });
  });

  it("route case (a value outside the generator's): the Armageddon White wins — Black, then `result-white`, then Confirm — is equal on the ledger and folds to the OTHER entrant (BG-KO-2)", async () => {
    const cfg = stageCfg("boardgame", resolveSportCfg("boardgame", offlineBuilderDefault("boardgame")), "knockout", offlineBuilderDefault("boardgame"));
    const r = bracketReq("boardgame", cfg, { kind: "tiebreak", rung: ARMAGEDDON, winner: "home" });
    // The generator cannot ask for "White won": its `winner` is Black. Rewrite the row it emits, as the resignation case does.
    const evs = generateStream(r).map((e) => (e.type === BOARDGAME_TIEBREAK ? { ...e, payload: { rung: ARMAGEDDON, black: AWAY, result: "white" } } : e));
    const tb = evs.find((e) => e.type === BOARDGAME_TIEBREAK)!;
    expect(boardgamePad.stepsFor(tb, ctxOf(r))).toEqual([
      { kind: "tile", tileId: BOARDGAME_TIEBREAK_TILE }, { kind: "choice", optionId: ARMAGEDDON }, { kind: "choice", optionId: "black-away" }, { kind: "choice", optionId: "result-white" }, { kind: "confirm" },
    ]);
    const { res, ledger } = await replayOnModel(boardgamePad, evs, ctxOf(r), boardgameModel(ctxOf(r)));
    expect(res.findings).toEqual([]);
    expect(res.rows.map((x) => x.verdict)).toEqual(["equal", "equal", "equal"]);
    // Black is AWAY and White won, so HOME advances — never the tapped colour's own entrant.
    expect(foldStream(boardgame, cfg, HOME, AWAY, asEvents(ledger)).outcome).toMatchObject({ kind: "win", winner: HOME, method: "tiebreak_armageddon" });
  });

  it("W2a tie-break: a payload that is not the engine's rung with an entrant winner — or, for the Armageddon, an entrant as Black and one of the engine's results — is refused by name", () => {
    const r = bracketReq("boardgame", stageCfg("boardgame", resolveSportCfg("boardgame", offlineBuilderDefault("boardgame")), "knockout", offlineBuilderDefault("boardgame")), { kind: "tiebreak", rung: "rapid", winner: "home" });
    const bad: unknown[] = [null, { rung: "rapid" }, { winner: HOME }, { rung: "lots", winner: HOME }, { rung: "rapid", winner: "stranger" }, { rung: "rapid", winner: HOME, score: "2–0" }, { rung: 1, winner: HOME },
      // an extra key that sorts AFTER "winner" leaves the first two sorted keys right, so only the key count refuses it
      { rung: "rapid", winner: HOME, zz: 1 },
      // rapid and blitz never take a Black or a result: those are the Armageddon's facts
      { rung: "rapid", black: HOME, result: "draw" }, { rung: "blitz", black: AWAY }];
    for (const payload of bad) {
      expect(() => boardgamePad.stepsFor({ type: BOARDGAME_TIEBREAK, payload }, ctxOf(r)), JSON.stringify(payload)).toThrow(`is not {rung: one of ${TIEBREAK_RUNGS.join(", ")}, winner: an entrant of the fixture}`);
    }
    expect(bad).toHaveLength(10);
    // The Armageddon's own refusals: no Black, a stranger as Black, a result the engine does not declare, a missing result,
    // an extra key — and (W2c) the Armageddon's old `{rung, winner}` shape, which the engine refuses: a winner is never named.
    const badArmageddon: unknown[] = [{ rung: ARMAGEDDON, result: "draw" }, { rung: ARMAGEDDON, black: "stranger", result: "draw" }, { rung: ARMAGEDDON, black: HOME, result: "won" },
      { rung: ARMAGEDDON, black: HOME }, { rung: ARMAGEDDON, black: null, result: "draw" }, { rung: ARMAGEDDON, black: HOME, result: "draw", zz: 1 },
      { rung: ARMAGEDDON, winner: HOME }, { rung: ARMAGEDDON, winner: HOME, result: "draw" }];
    for (const payload of badArmageddon) {
      expect(() => boardgamePad.stepsFor({ type: BOARDGAME_TIEBREAK, payload }, ctxOf(r)), JSON.stringify(payload)).toThrow(
        `is not {rung: ${ARMAGEDDON}, black: an entrant of the fixture, result: one of ${ARMAGEDDON_RESULTS.join(", ")}}`,
      );
    }
    expect(badArmageddon).toHaveLength(8);
    // the positive pair: each rung of the engine's, either winner (or Black × each result), is accepted
    let accepted = 0;
    for (const rung of TIEBREAK_RUNGS) {
      if (rung === ARMAGEDDON) continue;
      expect(boardgamePad.stepsFor({ type: BOARDGAME_TIEBREAK, payload: { rung, winner: AWAY } }, ctxOf(r)).length, rung).toBeGreaterThan(0);
      accepted++;
    }
    for (const black of [HOME, AWAY])
      for (const result of ARMAGEDDON_RESULTS) {
        expect(boardgamePad.stepsFor({ type: BOARDGAME_TIEBREAK, payload: { rung: ARMAGEDDON, black, result } }, ctxOf(r)).length, `${black}/${result}`).toBeGreaterThan(0);
        accepted++;
      }
    expect(accepted).toBe((TIEBREAK_RUNGS.length - 1) + 2 * ARMAGEDDON_RESULTS.length);
  });

  it("W2a tie-break, replayed on the fake ledger: the drawn game and the tie-break row are equal to the generated ones for every rung, side and Armageddon result (drawn included), and the stored rows fold (under the bracket's cfg) to the requested win by that rung", async () => {
    const cfg = stageCfg("boardgame", resolveSportCfg("boardgame", offlineBuilderDefault("boardgame")), "knockout", offlineBuilderDefault("boardgame"));
    let cases = 0;
    for (const { label, outcome } of tiebreakRequests()) {
      const o = outcome as Extract<RequestedOutcome, { kind: "tiebreak" }>;
      const r = bracketReq("boardgame", cfg, outcome);
      const { res, ledger } = await replayOnModel(boardgamePad, generateStream(r), ctxOf(r), boardgameModel(ctxOf(r)));
      expect(res.findings, label).toEqual([]);
      expect(res.rows.map((x) => x.verdict), label).toEqual(["equal", "equal", "equal"]); // start, the drawn game, the tie-break
      const folded = foldStream(boardgame, cfg, HOME, AWAY, asEvents(ledger)).outcome;
      expect(matchesRequest(r, folded), label).toBe("match");
      // BG-KO-2: a drawn Armageddon advances Black, who is the requested winner; so does a Black win.
      expect(folded, label).toMatchObject({ kind: "win", winner: o.winner === "home" ? HOME : AWAY, method: `tiebreak_${o.rung}` });
      cases++;
    }
    expect(cases).toBe((TIEBREAK_RUNGS.length - 1) * 2 + 2 * 2);
  });

  it("pins: the Armageddon sheet's option-id prefixes and its read-back are the skin's own (black-<side>, result-<result>, a confirm step)", () => {
    expect(skin).toContain(`export const BLACK_OPTION_PREFIX = "${BLACK_OPTION_PREFIX}";`);
    expect(skin).toContain(`export const RESULT_OPTION_PREFIX = "${RESULT_OPTION_PREFIX}";`);
    expect(skin).toMatch(/id: "confirm",\s*kind: "confirm"/);
    expect(selectorForTapStep({ kind: "confirm" })).toBe('[data-testid="pad-sheet-confirm"]');
  });

  it("route case (a value outside the generator's): a resignation — the winner's half, then the `method:resign` chip — is equal on the ledger and folds to that win; the skin offers `resign`", async () => {
    const cfg = resolveSportCfg("boardgame", offlineBuilderDefault("boardgame"));
    const r = req("boardgame", cfg, { kind: "win", winner: "home" });
    const evs = generateStream(r).map((e) => (e.type === BOARDGAME_RESULT ? { ...e, payload: { ...(e.payload as object), method: "resign" } } : e));
    expect(evs.filter((e) => e.type === BOARDGAME_RESULT)).toHaveLength(1);
    expect(boardgamePad.stepsFor(evs.find((e) => e.type === BOARDGAME_RESULT)!, ctxOf(r))).toEqual([{ kind: "half", side: "home" }, { kind: "chip", chipId: methodChipId("resign") }]);
    const { res, ledger } = await replayOnModel(boardgamePad, evs, ctxOf(r), boardgameModel(ctxOf(r)));
    expect(res.findings).toEqual([]);
    expect(res.rows.map((x) => x.verdict)).toEqual(["equal", "equal"]);
    expect(foldStream(boardgame, cfg, HOME, AWAY, asEvents(ledger)).outcome).toMatchObject({ kind: "win", winner: HOME, method: "resign" });
    expect(listOf("DECISIVE_METHODS")).toContain("resign");
    // and the method really is outside what the generator emits (the reason this row exists)
    const emitted = new Set(requestsFor("boardgame").flatMap((q) => streamOf(q)).filter((e) => e.type === BOARDGAME_RESULT).map((e) => (e.payload as { method: string }).method));
    expect([...emitted].sort()).toEqual(["agreement", "checkmate"]);
  });

  // W2b (spec C-4, ruling 101; D15): the product's organiser-only boardgame.result values are EMPTY. Chess's two forfeit
  // methods are retired on write, refused for every writer, and a chess forfeit is a core.forfeit. So the items are the
  // values the product declares (each tapped on the pad, as D-P3 routes them) plus the values C-4 retired (the engine
  // still declares them, the predicate no longer gates them, and a legacy stream holding one still folds). The sweep is
  // never empty, and no retired value is demanded back. The retired half reads no skin list, because loop H's Task 12
  // takes those chips out of the dock.
  it("route cases (the PRODUCT's own organiser-only values, D-O1/D-P3, W2b C-4): every declared forfeit value is tapped on the pad — the winner's half or the draw tile, then its `method:<value>` chip — equal on the ledger, organiser-only by the product's predicate, folded by the engine, and offered by the skin's own dock list; every value C-4 retired is declared by the engine, organiser-only no longer, and still folds on replay", async () => {
    const cfg = resolveSportCfg("boardgame", offlineBuilderDefault("boardgame"));
    /** W2b spec C-4 / D15: the chess forfeit methods, retired on write. */
    const RETIRED = ["forfeit", "double_forfeit"] as const;
    const arm = ORGANISER_ONLY_SPORT_EVENTS[BOARDGAME_RESULT];
    if (arm !== undefined) expect(arm.field).toBe("method");
    const declared = arm?.values ?? [];
    const outcomes = padOutcomes(outcomesFor("boardgame", cfg));
    const decisive = listOf("DECISIVE_METHODS");
    const drawn = listOf("DRAWN_METHODS");
    // Each value is offered by exactly one of the skin's docks: that dock decides which tile holds the result (a decisive
    // half, or the draw tile), and the engine decides what the stored row folds to.
    // W2b (spec §5.2 table, boardgame row): a legacy `double_forfeit` now folds to `double_walkover`, not `no_result`.
    const FOLDS: Readonly<Record<string, Record<string, unknown>>> = { forfeit: { kind: "win", winner: HOME, method: "forfeit" }, double_forfeit: { kind: "double_walkover" } };
    const streamWith = (value: string, kind: "win" | "draw") => {
      const base = outcomes.find((o) => o.kind === kind);
      expect(base, `${value}: the generator builds no ${kind} to start from`).toBeDefined();
      const r = req("boardgame", cfg, base!);
      return { r, evs: generateStream(r).map((e) => (e.type === BOARDGAME_RESULT ? { ...e, payload: { ...(e.payload as object), method: value } } : e)) };
    };
    let checked = 0;
    for (const value of declared) {
      expect(Object.hasOwn(FOLDS, value), `${value}: no expected fold in this test (a value the product gains owes one)`).toBe(true);
      expect(RETIRED as readonly string[], `${value} is retired on write (C-4), not an organiser privilege`).not.toContain(value);
      const inDecisive = decisive.includes(value);
      const inDrawn = drawn.includes(value);
      expect(inDecisive !== inDrawn, `${value} must be offered by exactly one dock (decisive ${inDecisive}, drawn ${inDrawn})`).toBe(true);
      const { r, evs } = streamWith(value, inDecisive ? "win" : "draw");
      const result = evs.find((e) => e.type === BOARDGAME_RESULT)!;
      expect(isOrganiserOnlyEvent(result.type, result.payload), `${value} is organiser-only (the premise of the route)`).toBe(true);
      const side = (result.payload as { winner: string | null }).winner === null ? null : (result.payload as { winner: string }).winner === HOME ? "home" : "away";
      expect(boardgamePad.stepsFor(result, ctxOf(r)), value).toEqual([side === null ? { kind: "tile", tileId: BOARDGAME_DRAW_TILE } : { kind: "half", side }, { kind: "chip", chipId: methodChipId(value) }]);
      const { res, ledger } = await replayOnModel(boardgamePad, evs, ctxOf(r), boardgameModel(ctxOf(r)));
      expect(res.findings, value).toEqual([]);
      expect(res.rows.map((x) => x.verdict), value).toEqual(["equal", "equal"]);
      const row = ledger.find((x) => x.type === BOARDGAME_RESULT)!;
      expect(row.payload, value).toEqual(result.payload);
      expect(isOrganiserOnlyEvent(row.type, row.payload), `${value}: the STORED row is organiser-only too`).toBe(true);
      expect(foldStream(boardgame, cfg, HOME, AWAY, asEvents(ledger)).outcome, value).toMatchObject(FOLDS[value]!);
      checked++;
    }
    for (const value of RETIRED) {
      // The engine still declares it: the schema accepts it so a recorded stream replays (spec §5.2).
      expect(BoardgameMethod.options as readonly string[], `${value}: the engine declares it`).toContain(value);
      const { evs } = streamWith(value, value === "double_forfeit" ? "draw" : "win");
      const result = evs.find((e) => e.type === BOARDGAME_RESULT)!;
      if (value === "double_forfeit") expect((result.payload as { winner: string | null }).winner, value).toBeNull();
      expect(isOrganiserOnlyEvent(result.type, result.payload), `${value}: retired for every writer, so organiser-only no longer`).toBe(false);
      expect(foldStream(boardgame, cfg, HOME, AWAY, asEvents(evs)).outcome, `${value}: a legacy stream still folds`).toMatchObject(FOLDS[value]!);
      checked++;
    }
    expect(checked).toBe(declared.length + RETIRED.length);
    expect(checked).toBeGreaterThan(1);
  });

  it("pins (loop H adds the tie-break tile; red until it lands): the tile id and the score step's `none` option are boardgame.tsx's own, and the event is the engine's", () => {
    const tile = /export const TIEBREAK_TILE_ID = "([^"]+)";/.exec(skin);
    expect(tile, "boardgame.tsx has no TIEBREAK_TILE_ID — loop H adds the tie-break tile").not.toBeNull();
    expect(BOARDGAME_TIEBREAK_TILE).toBe(tile![1]);
    const scores = /const SCORES = \["([^"]+)"/.exec(skin);
    expect(scores, "boardgame.tsx has no SCORES list for the tie-break sheet").not.toBeNull();
    expect(TIEBREAK_SCORE_NONE).toBe(scores![1]);
    expect(Object.keys(boardgame.eventSchemas ?? {})).toContain(BOARDGAME_TIEBREAK);
  });
});

/** carrom as Step 0 saw it (club-29): the board tile, the winner's side as a
 *  choice, the opponent's coins as a number, confirm — one row at once, with
 *  no hold and no `queenTo` key. */
function carromModel(ctx: TapAdapterContext) {
  return (taps: readonly string[]): RowIn[] => {
    if (taps.length === 1 && taps[0] === START_SEL) return [{ type: "core.start", payload: {} }];
    if (taps.length !== 4 || taps[0] !== TILE("board") || taps[3] !== CONFIRM_SEL) return [];
    const side = CHOICE_ID.exec(taps[1]!)?.[1];
    const coins = numberOf(taps[2]!);
    if ((side !== "home" && side !== "away") || coins === null) return [];
    return [{ type: "carrom.board.summary", payload: { winner: ctx.entrants[side], opponentCoinsLeft: coins } }];
  };
}

describe("carrom", () => {
  let skin = "";
  beforeAll(() => { skin = readFileSync(resolve(REPO, SKINS, "carrom.tsx"), "utf8"); });

  it("carrom: queenTo null ≡ absent only for board.summary", () => {
    expect(carromPad.nullAsAbsentKeys?.(CARROM_BOARD)).toEqual(["queenTo"]);
    let checked = 0;
    for (const t of ["carrom.adjust", "carrom.toss", "core.start"]) {
      expect(carromPad.nullAsAbsentKeys?.(t) ?? [], t).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
    const { sums } = summariesOf("carrom", CARROM_BOARD, "home");
    const seen = { id: "r2", seq: 2, type: CARROM_BOARD, payload: { winner: HOME, opponentCoinsLeft: 9 } };
    expect(compareRow(sums[0]!, seen, carromPad)).toEqual({ verdict: "equal", note: null });
    // Only a NULL queenTo is excused: a queen awarded to a side is not the absent key.
    expect(compareRow({ ...sums[0]!, payload: { ...(sums[0]!.payload as object), queenTo: HOME } }, seen, carromPad).verdict).toBe("mismatch");
    // And another type's null key is not excused.
    expect(compareRow({ type: "carrom.adjust", payload: { by: HOME, note: null } }, { id: "r3", seq: 3, type: "carrom.adjust", payload: { by: HOME } }, carromPad).verdict).toBe("mismatch");
  });

  it("routes: the board tile, the winner's side, the opponent's coins, confirm; a queen board, coins off 0..9, or a stranger winner is refused by name", () => {
    const { r, sums } = summariesOf("carrom", CARROM_BOARD, "away");
    expect(carromPad.stepsFor(sums[0]!, ctxOf(r))).toEqual([{ kind: "tile", tileId: CARROM_BOARD_TILE }, { kind: "choice", optionId: "away" }, { kind: "number", value: 9 }, { kind: "confirm" }]);
    for (const payload of [null, { winner: HOME, opponentCoinsLeft: 9, queenTo: HOME }, { winner: HOME, opponentCoinsLeft: 10, queenTo: null }, { winner: HOME, opponentCoinsLeft: -1 }, { winner: "stranger", opponentCoinsLeft: 9, queenTo: null }, { winner: HOME, opponentCoinsLeft: 9, queenTo: null, breaker: HOME }] as unknown[]) {
      expect(() => carromPad.stepsFor({ type: CARROM_BOARD, payload }, ctxOf(r)), JSON.stringify(payload)).toThrow(/is not the board sheet's \{winner, opponentCoinsLeft 0\.\.9, queenTo null\}/);
    }
    expect(() => carromPad.stepsFor({ type: "carrom.adjust", payload: {} }, ctxOf(r))).toThrow(/carrom\.adjust/);
  });

  it("M-8: carrom's coin bound is the skin's — read from carrom.tsx as text, every coins field carries one `max`, the adapter accepts it and refuses one more", () => {
    // Both board sheets (the plain board and the queen board) ask the opponent's coins as a number step with a max.
    const maxes = [...skin.matchAll(/id: "coins",[^}]*?\bmax:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(maxes.length, "carrom.tsx no longer has the coins number step(s)").toBeGreaterThanOrEqual(2);
    expect(new Set(maxes).size, `the skin's coins fields disagree: ${maxes.join(", ")}`).toBe(1);
    const max = maxes[0]!;
    expect(CARROM_COIN_MAX).toBe(max);
    const { r } = summariesOf("carrom", CARROM_BOARD, "home");
    const board = (coins: number) => ({ type: CARROM_BOARD, payload: { winner: HOME, opponentCoinsLeft: coins, queenTo: null } });
    expect(carromPad.stepsFor(board(max), ctxOf(r)).filter((st) => st.kind === "number")).toEqual([{ kind: "number", value: max }]);
    expect(carromPad.stepsFor(board(0), ctxOf(r)).filter((st) => st.kind === "number")).toEqual([{ kind: "number", value: 0 }]);
    expect(() => carromPad.stepsFor(board(max + 1), ctxOf(r))).toThrow(new RegExp(`opponentCoinsLeft 0\\.\\.${max},`));
    expect(() => carromPad.stepsFor(board(-1), ctxOf(r))).toThrow(/opponentCoinsLeft/);
  });

  it("replayed on the fake ledger: every board row equal, and the stored rows fold to the requested outcome", async () => {
    const cfg = resolveSportCfg("carrom", offlineBuilderDefault("carrom"));
    let cases = 0;
    let boards = 0;
    for (const winner of ["home", "away"] as const) {
      const r = req("carrom", cfg, { kind: "win", winner });
      const evs = generateStream(r);
      const { res, ledger } = await replayOnModel(carromPad, evs, ctxOf(r), carromModel(ctxOf(r)));
      expect(res.findings, winner).toEqual([]);
      expect(res.rows.every((x) => x.verdict === "equal")).toBe(true);
      boards += res.rows.length - 1;
      expect(matchesRequest(r, foldStream(carrom, cfg, HOME, AWAY, asEvents(ledger)).outcome), winner).toBe("match");
      cases++;
    }
    expect({ cases, boards }).toEqual({ cases: 2, boards: 16 }); // club-29: 2 games × 4 boards each, Step 0 saw board 8 decide
  });

  it("route case (a value outside the generator's old one): a BRACKET game's boards carry 7 coins, not 9 — the number step takes the generated value, the rows are equal, and the stored rows fold under the overlay (tieBoard 'extra') to the requested win", async () => {
    const cfg = stageCfg("carrom", resolveSportCfg("carrom", offlineBuilderDefault("carrom")), "knockout", offlineBuilderDefault("carrom"));
    const c = cfg as { gameTo: number; maxBoards: number; pointsPerCoin: number; tieBoard: string };
    expect(c.tieBoard).toBe("extra"); // the overlay is on
    // The rulebook arithmetic, not the generator's: a level game plays maxBoards boards, a side wins ceil(maxBoards/2) of
    // them, and no board may end the game early — the largest coin count keeping those boards under the game point.
    const wins = Math.ceil(c.maxBoards / 2);
    let coins = 0;
    while ((coins + 1) * wins * c.pointsPerCoin < c.gameTo && coins < CARROM_COIN_MAX) coins++;
    expect(coins).toBe(7); // club-29
    expect(coins).toBeLessThan(CARROM_COIN_MAX);
    const r = bracketReq("carrom", cfg, { kind: "win", winner: "home" });
    const evs = generateStream(r);
    const boards = evs.filter((e) => e.type === CARROM_BOARD);
    const seven = boards.filter((e) => (e.payload as { opponentCoinsLeft: number }).opponentCoinsLeft === coins);
    expect(seven.length, "no board carries the level game's coins").toBeGreaterThan(0);
    for (const e of seven) {
      expect(carromPad.stepsFor(e, ctxOf(r)).filter((st) => st.kind === "number"), JSON.stringify(e.payload)).toEqual([{ kind: "number", value: coins }]);
    }
    const { res, ledger } = await replayOnModel(carromPad, evs, ctxOf(r), carromModel(ctxOf(r)));
    expect(res.findings).toEqual([]);
    expect(res.rows.every((x) => x.verdict === "equal")).toBe(true);
    expect(res.rows.length).toBe(evs.length);
    expect(matchesRequest(r, foldStream(carrom, cfg, HOME, AWAY, asEvents(ledger)).outcome)).toBe("match");
  });

  it("pins: the board tile under live, its sheet, the side option ids, and a payload that never carries queenTo", () => {
    expect(skin).toMatch(/if \(phase === "live"\) \{[\s\S]{0,300}?tiles\.push\(\{\s*id: "board",[\s\S]{0,200}?action: \{ sheet: "board" \},/);
    expect(CARROM_BOARD_TILE).toBe("board");
    expect(skin).toContain(`${CARROM_BOARD_TILE}: boardSheet(state),`);
    expect(skin).toContain("return SIDES.map((side) => ({ id: side, label: SIDE_LABEL[side] }));");
    expect(skin).toMatch(/function boardSheet\(state: CarromStateShape\): GuidedSheetSpec \{\s*return \{\s*event: "carrom\.board\.summary",[\s\S]{0,400}?buildPayload: \(answers\) => \(\{\s*winner: entrantOf\(state, sideAnswer\(answers\.winner\)\),\s*opponentCoinsLeft: Number\(answers\.coins \?\? 0\),\s*\}\),/);
    expect(skin).toContain("`queenTo` is simply never");
    expect(Object.keys(carrom.eventSchemas ?? {})).toContain(CARROM_BOARD);
  });
});
