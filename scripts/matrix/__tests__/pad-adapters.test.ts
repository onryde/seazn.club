// The pad adapters (W1c Task 7), swept over PAD_ADAPTERS, so every later
// task's adapters join these tests with no new structural test code. Expected
// values come from the matrix's own generator (the events a case really
// sends), from the engine's declarations (resolveSportCfg, the modules'
// coarseEventType, drawsAllowed), from the skins' source text, and from what
// Step 0 saw in a browser. None of them comes from lib/pads.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { carrom } from "@seazn/engine/sports/carrom";
import { cricket } from "@seazn/engine/sports/cricket";
import { football } from "@seazn/engine/sports/football";
import { hockey } from "@seazn/engine/sports/hockey";
import { icehockey } from "@seazn/engine/sports/icehockey";
import { badminton, tabletennis, volleyball } from "@seazn/engine/sports/setbased";
import { tennis } from "@seazn/engine/sports/tennis";
import { beforeAll, describe, expect, it } from "vitest";
import { GENERIC_TOLERATED_EXTRA_KEYS, genericAdapter } from "../../bench/lib/drivers/adapters/generic.ts";
import { START_MATCH_TESTID, selectorForTapStep, type PadPage, type TapAdapterContext } from "../../bench/lib/drivers/scorer.ts";
import type { LedgerRow } from "../../bench/lib/ledger.ts";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { PAD_OWNER, PAD_SPORTS, noPadReason } from "../lib/pad-sports.ts";
import { foldStream } from "../lib/fold.ts";
import { BOARDGAME_DRAW_TILE, BOARDGAME_RESULT, boardgamePad, methodChipId } from "../lib/pads/boardgame.ts";
import { CARROM_BOARD, CARROM_BOARD_TILE, carromPad } from "../lib/pads/carrom.ts";
import { CRICKET_OVER_TILE, CRICKET_SUMMARY, cricketPad, overSplit } from "../lib/pads/cricket.ts";
import { BADMINTON_SET_SCORE_TILE, BADMINTON_SUMMARY, badmintonPad } from "../lib/pads/badminton.ts";
import { FOOTBALL_GOAL, FOOTBALL_PERIOD, FOOTBALL_PERIOD_TILE, footballGoalTile, footballPad } from "../lib/pads/football.ts";
import { GENERIC_DRAW_TILE_ID, genericPad } from "../lib/pads/generic.ts";
import { hockeyPad } from "../lib/pads/hockey.ts";
import { icehockeyPad } from "../lib/pads/icehockey.ts";
import { PAD_ADAPTERS, registerPads } from "../lib/pads/index.ts";
import { TABLETENNIS_SET_SCORE_TILE, TABLETENNIS_SUMMARY, tabletennisPad } from "../lib/pads/tabletennis.ts";
import { TENNIS_SET_SCORE_TILE, TENNIS_SUMMARY, tennisPad } from "../lib/pads/tennis.ts";
import { PERIOD_ADVANCE_TILE, periodGoalTile } from "../lib/pads/period.ts";
import type { MatrixPadAdapter } from "../lib/pads/types.ts";
import { VOLLEYBALL_SET_SCORE_TILE, VOLLEYBALL_SUMMARY, volleyballPad } from "../lib/pads/volleyball.ts";
import { compareRow, replayEvents, type ReplayResult } from "../lib/pads/replay.ts";
import { drawsAllowed, resolveSportCfg, sportModule, variantKeys } from "../lib/sport-cfg.ts";
import { declaredAllOut } from "../lib/streams/cricket.ts";
import { generateStream, matchesRequest } from "../lib/streams/index.ts";
import { GeneratorUnsupported, START, type RequestedOutcome, type StreamEvent, type StreamRequest } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKINS = "apps/web/src/components/v2/scorepad/v3/skins";
const HOME = "e-home";
const AWAY = "e-away";

/** The outcomes a case can request of one cfg: both wins, a draw where the
 *  engine allows one in a league (drawsAllowed), and a walkover. */
function outcomesFor(sport: string, cfg: unknown): RequestedOutcome[] {
  return [
    { kind: "win", winner: "home" }, { kind: "win", winner: "away" },
    ...(drawsAllowed(sport, cfg, "league") ? [{ kind: "draw" } as const] : []),
    { kind: "forfeit", by: "away", reason: "walkover" },
  ];
}
const req = (sport: string, cfg: unknown, outcome: RequestedOutcome): StreamRequest => ({ sportKey: sport, cfg, stageKind: "league", home: HOME, away: AWAY, outcome });

/** Every request over every system variant of `sport`. The builder default
 *  (offlineBuilderDefault, pinned to division-builder.tsx by catalogue.test.ts)
 *  comes first, and it is what PADPROOF plays. */
function requestsFor(sport: string): StreamRequest[] {
  const def = offlineBuilderDefault(sport);
  const variants = [def, ...variantKeys(sport).filter((v) => v !== def)];
  return variants.flatMap((v) => {
    const cfg = resolveSportCfg(sport, v);
    return outcomesFor(sport, cfg).map((o) => req(sport, cfg, o));
  });
}
/** The events a request generates, or [] where the generator declares the case unsupported. */
function streamOf(r: StreamRequest): StreamEvent[] {
  try {
    return generateStream(r);
  } catch (e) {
    if (e instanceof GeneratorUnsupported) return [];
    throw e;
  }
}
const ctxOf = (r: StreamRequest): TapAdapterContext => ({ cfg: r.cfg, entrants: { home: r.home, away: r.away } });
/** core.forfeit is the organiser's (bench organiserStepsFor), never a pad tap. */
const scorerEvents = (evs: readonly StreamEvent[]) => evs.filter((e) => e.type !== "core.forfeit");

const ADAPTERS = Object.entries(PAD_ADAPTERS).map(([k, a]) => [k, a!] as const);

describe("the pad adapter registry", () => {
  it("empty case first: the registry is non-empty, keyed by real sports in SPORT_KEYS order, each adapter under its own sport", () => {
    const keys = Object.keys(PAD_ADAPTERS);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual(SPORT_KEYS.filter((k) => k in PAD_ADAPTERS)); // wave order, never re-sorted
    for (const [k, a] of ADAPTERS) expect(a.sport, k).toBe(k);
  });

  it("the leaf run.ts plans from is the registry's key list; a sport outside it would name the W1c task that owes it — none is owed today (carry f), so the owner loop checks 0", () => {
    expect([...PAD_SPORTS]).toEqual(Object.keys(PAD_ADAPTERS));
    const owned = Object.keys(PAD_OWNER);
    expect(owned.filter((s) => PAD_SPORTS.includes(s))).toEqual([]);
    expect([...owned, ...PAD_SPORTS].sort()).toEqual([...SPORT_KEYS].sort());
    for (const [s, owner] of Object.entries(PAD_OWNER)) {
      expect(owner, s).toMatch(/^W1c Task (9|10|11)$/);
      // The reason is what the mixed ledger's exemption rule and the ⏳ case read.
      expect(noPadReason(s)).toBe(`no pad adapter for ${s} yet → ${owner}`);
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
    // A sport the catalogue gains later, with no adapter, still names a wave.
    expect(noPadReason("curling")).toBe("no pad adapter for curling yet → W1c (no task owns it)");
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
    expect([...a.emits].sort()).toEqual([...seen].filter((t) => t !== "core.forfeit").sort());
  });

  it("every generated scorer event is routed to ≥1 tap, and every fallback cites its file:line", () => {
    let routed = 0;
    for (const r of requestsFor(sport)) {
      for (const e of scorerEvents(streamOf(r))) {
        expect(a.stepsFor(e, ctxOf(r)).length, `${r.cfg === undefined ? "" : JSON.stringify(r.outcome)} ${e.type}`).toBeGreaterThan(0);
        routed++;
      }
    }
    console.info(`pad-adapters: ${sport}: ${routed} generated event(s) routed`);
    expect(routed).toBeGreaterThan(0);
    for (const f of a.fallbacks) {
      expect(a.emits, f.eventType).toContain(f.eventType);
      expect(f.why, f.eventType).toMatch(/\.tsx?:\d+/);
    }
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

type RowIn = { type: string; payload: unknown };
const TILE = (tileId: string) => selectorForTapStep({ kind: "tile", tileId });
const START_SEL = selectorForTapStep({ kind: "testid", testid: START_MATCH_TESTID });
const CHOICE_ID = /^\[data-choice-option-id="([^"]+)"\]$/;

/** Replays `events` through the real replay on a fake pad modelled on what
 *  Step 0 saw each route write. Every tap is recorded; the replay's hold
 *  release (its `pad-send-now` presence check, the one boundary it crosses
 *  after every event's taps) commits the rows `write` answers for the taps
 *  since the last release. */
async function replayOnModel(
  adapter: MatrixPadAdapter,
  events: readonly StreamEvent[],
  ctx: TapAdapterContext,
  write: (taps: readonly string[], ledger: readonly LedgerRow[]) => RowIn[],
): Promise<{ res: ReplayResult; ledger: LedgerRow[] }> {
  const ledger: LedgerRow[] = [];
  let taps: string[] = [];
  const sendNow = selectorForTapStep({ kind: "releaseHold" });
  const page: PadPage = {
    locator: (sel: string) => ({
      click: async () => { taps.push(sel); },
      fill: async (v: string) => { taps.push(`${sel}=${v}`); },
      waitFor: async () => undefined,
      count: async () => {
        if (sel === sendNow) {
          for (const r of write(taps, ledger)) ledger.push({ id: `r${ledger.length + 1}`, seq: ledger.length + 1, type: r.type, payload: r.payload });
          taps = [];
        }
        return 0;
      },
    }),
    goto: async () => undefined,
    setViewportSize: async () => undefined,
  };
  const res = await replayEvents(page, adapter, events, ctx, {
    holdMs: 3000,
    tip: async () => 0,
    ledger: async (since: number) => ledger.filter((r) => r.seq > since),
    sleep: async () => undefined,
  });
  return { res, ledger };
}

/** football as Step 0 saw it (2026-09-30, 320, 11-a-side): Start writes
 *  core.start; a goal tile writes `{by}` alone; the period tile then a marker
 *  choice writes `{phase: <the choice's id>}`. Anything else writes nothing. */
function footballModel(ctx: TapAdapterContext, goal: (side: "home" | "away") => unknown = (side) => ({ by: ctx.entrants[side] })) {
  return (taps: readonly string[]): RowIn[] => {
    if (taps.length === 1 && taps[0] === START_SEL) return [{ type: "core.start", payload: {} }];
    for (const side of ["home", "away"] as const) {
      if (taps.length === 1 && taps[0] === TILE(`goal-${side}`)) return [{ type: "football.goal", payload: goal(side) }];
    }
    const m = taps.length === 2 && taps[0] === TILE("period") ? CHOICE_ID.exec(taps[1]!) : null;
    return m === null ? [] : [{ type: "football.period", payload: { phase: m[1] } }];
  };
}

/** hockey / icehockey as Step 0 saw them: a goal tile writes `{by}`; the
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
      if (taps.length === 1 && taps[0] === TILE(`goal-${side}`)) return [{ type: `${sport}.goal`, payload: { by: ctx.entrants[side] } }];
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

/** The engine's own advance order for `cfg` after a home goal: fold, read
 *  nextAdvance, advance to it, until the engine names none. */
function engineAdvances(sport: "hockey" | "icehockey", cfg: unknown): string[] {
  const m = sport === "hockey" ? hockey : icehockey;
  const evs: StreamEvent[] = [START, { type: `${sport}.goal`, payload: { by: HOME } }];
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
    for (const outcome of outcomesFor("football", cfg).filter((o) => o.kind !== "forfeit")) {
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
});

describe.each([["hockey", hockeyPad], ["icehockey", icehockeyPad]] as const)("%s (period kernel)", (sport, pad) => {
  it("replayed on the fake ledger: goal equal, every advance a 1-row fallback, no finding, and the stored rows fold to the requested outcome", async () => {
    const cfg = resolveSportCfg(sport, offlineBuilderDefault(sport));
    const advance = pad.fallbacks.find((f) => f.eventType === `${sport}.period.advance`);
    expect(advance, "advance is declared a fallback").toBeDefined();
    let cases = 0;
    let advances = 0;
    for (const outcome of outcomesFor(sport, cfg).filter((o) => o.kind !== "forfeit")) {
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
  });

  it("the cursor walks the ENGINE's advance order in every variant, per fixture, and refuses a wrong-order, early or extra advance naming both labels", () => {
    let checked = 0;
    for (const v of variantKeys(sport)) {
      const cfg = resolveSportCfg(sport, v);
      const order = engineAdvances(sport, cfg);
      expect(order.at(-1), v).toBe("FT");
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
    console.info(`pad-adapters: ${sport}: ${checked} advance(s) walked over ${variantKeys(sport).length} variant(s)`);
    expect(checked).toBeGreaterThan(0);
  });

  it("goal routes to its side's tile; a goal by no entrant, or an advance off {to}, is refused by name", () => {
    const cfg = resolveSportCfg(sport, offlineBuilderDefault(sport));
    const ctx: TapAdapterContext = { cfg, entrants: { home: HOME, away: AWAY } };
    expect(pad.stepsFor({ type: `${sport}.goal`, payload: { by: HOME } }, ctx)).toEqual([{ kind: "tile", tileId: periodGoalTile("home") }]);
    expect(pad.stepsFor({ type: `${sport}.goal`, payload: { by: AWAY } }, ctx)).toEqual([{ kind: "tile", tileId: periodGoalTile("away") }]);
    for (const payload of [null, {}, { by: "stranger" }, { by: HOME, person: "p1" }] as unknown[]) {
      expect(() => pad.stepsFor({ type: `${sport}.goal`, payload }, ctx), JSON.stringify(payload)).toThrow(/goal payload .* is not \{by: one of the fixture's entrants\}/);
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
    expect(compareRow(g, { id: "r2", seq: 2, type: g.type, payload: { by: HOME } }, pad)).toEqual({ verdict: "equal", note: null });
    const a = evs.find((e) => e.type === `${sport}.period.advance`)!;
    const first = sport === "hockey" ? "Q1" : "P1";
    expect(compareRow(a, { id: "r3", seq: 3, type: a.type, payload: { ...(a.payload as object), at: { period: first, elapsed: 0 } } }, pad).verdict).toBe("mismatch");
    expect(pad.fallbacks.map((f) => f.eventType)).toEqual([`${sport}.period.advance`]);
    expect(pad.tolerableExtraKeys?.(a.type) ?? []).toEqual([]);
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
    for (const payload of [null, { runs: 1, wickets: 0 }, { runs: 1, wickets: 0, legalBalls: 0 }, { runs: -1, wickets: 0, legalBalls: B }, { runs: 1.5, wickets: 0, legalBalls: B }, { runs: 1, wickets: 0, legalBalls: B, partial: true }, { runs: 1, wickets: 0, legalBalls: B + 1 }] as unknown[]) {
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
  const listOf = (name: string): string[] => {
    const m = new RegExp(`export const ${name}: readonly string\\[\\] = \\[([^\\]]*)\\];`).exec(skin);
    expect(m, `boardgame.tsx no longer exports ${name} as a literal list`).not.toBeNull();
    return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  };

  it("boardgame: a draw's steps never tap a half — the draw tile then its method chip; a win is the winner's half then its method chip", () => {
    const cfg = resolveSportCfg("boardgame", offlineBuilderDefault("boardgame"));
    let draws = 0;
    let wins = 0;
    for (const outcome of outcomesFor("boardgame", cfg).filter((o) => o.kind !== "forfeit")) {
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
    for (const outcome of outcomesFor("boardgame", cfg).filter((o) => o.kind !== "forfeit")) {
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
