// The pad adapters (W1c Task 7), swept over PAD_ADAPTERS, so every later
// task's adapters join these tests with no new structural test code. Expected
// values come from the matrix's own generator (the events a case really
// sends), from the engine's declarations (resolveSportCfg, the modules'
// coarseEventType, drawsAllowed), from the skins' source text, and from what
// Step 0 saw in a browser. None of them comes from lib/pads.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { badminton, tabletennis, volleyball } from "@seazn/engine/sports/setbased";
import { tennis } from "@seazn/engine/sports/tennis";
import { beforeAll, describe, expect, it } from "vitest";
import { GENERIC_TOLERATED_EXTRA_KEYS, genericAdapter } from "../../bench/lib/drivers/adapters/generic.ts";
import { START_MATCH_TESTID, type TapAdapterContext } from "../../bench/lib/drivers/scorer.ts";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { PAD_OWNER, PAD_SPORTS, noPadReason } from "../lib/pad-sports.ts";
import { BADMINTON_SET_SCORE_TILE, BADMINTON_SUMMARY, badmintonPad } from "../lib/pads/badminton.ts";
import { GENERIC_DRAW_TILE_ID, genericPad } from "../lib/pads/generic.ts";
import { PAD_ADAPTERS } from "../lib/pads/index.ts";
import { TABLETENNIS_SET_SCORE_TILE, TABLETENNIS_SUMMARY, tabletennisPad } from "../lib/pads/tabletennis.ts";
import { TENNIS_SET_SCORE_TILE, TENNIS_SUMMARY, tennisPad } from "../lib/pads/tennis.ts";
import { VOLLEYBALL_SET_SCORE_TILE, VOLLEYBALL_SUMMARY, volleyballPad } from "../lib/pads/volleyball.ts";
import { compareRow } from "../lib/pads/replay.ts";
import { drawsAllowed, resolveSportCfg, sportModule, variantKeys } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { GeneratorUnsupported, type RequestedOutcome, type StreamEvent, type StreamRequest } from "../lib/streams/types.ts";
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

  it("the leaf run.ts plans from is the registry's key list, and every other sport names the W1c task that owes it", () => {
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
