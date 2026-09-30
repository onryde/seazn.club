// The pad adapters (W1c Task 7), swept over PAD_ADAPTERS, so every later
// task's adapters join these tests with no new structural test code. Expected
// values come from the matrix's own generator (the events a case really
// sends), from the engine's declarations (resolveSportCfg, the modules'
// coarseEventType, drawsAllowed), from the skins' source text, and from what
// Step 0 saw in a browser. None of them comes from lib/pads.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { badminton } from "@seazn/engine/sports/setbased";
import { beforeAll, describe, expect, it } from "vitest";
import { GENERIC_TOLERATED_EXTRA_KEYS, genericAdapter } from "../../bench/lib/drivers/adapters/generic.ts";
import { START_MATCH_TESTID, type TapAdapterContext } from "../../bench/lib/drivers/scorer.ts";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { PAD_OWNER, PAD_SPORTS, noPadReason } from "../lib/pad-sports.ts";
import { BADMINTON_SET_SCORE_TILE, BADMINTON_SUMMARY, badmintonPad } from "../lib/pads/badminton.ts";
import { GENERIC_DRAW_TILE_ID, genericPad } from "../lib/pads/generic.ts";
import { PAD_ADAPTERS } from "../lib/pads/index.ts";
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
