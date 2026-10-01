// Every sport × declared variant × {league, knockout, swiss} × 7 outcomes:
// generate, FOLD through the real module (strict), and demand the folded
// outcome equals the request. Draw reachability comes from supportsDraws, not
// a table (R9); tie reachability from the engine's own source and decideTie.
// Gaps the generators knowingly leave are a COMMITTED list whose staleness is
// checked in both directions (empty since ruling 44).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { describe, expect, it } from "vitest";
import { CfgInvalid, drawsAllowed, resolveSportCfg, sportModule, variantKeys } from "../lib/sport-cfg.ts";
import { foldStream } from "../lib/fold.ts";
import { STREAM_GENERATORS, generateStream, matchesRequest } from "../lib/streams/index.ts";
import { KNOWN_UNSUPPORTED } from "../lib/streams/known-unsupported.ts";
import { AllOutUndeclared, TEST_BALLS, cricketGenerator, declaredAllOut } from "../lib/streams/cricket.ts";
import { stagesForRow } from "../lib/catalogue.ts";
import { buildSportVariants, offlineBuilderDefault, type VariantCase } from "../lib/variants.ts";
import { footballPhases } from "../lib/streams/football.ts";
import { periodLabels } from "../lib/streams/period.ts";
import {
  ALL_OUTCOMES, GeneratorUnsupported, OutcomeUnreachable, START, outcomeLabel, type RequestedOutcome, type StreamRequest,
} from "../lib/streams/types.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Engine sport directories with a non-test source that emits a `kind: "tie"`
 *  outcome — read from the engine's own text, never from the generators, so a
 *  sport whose engine can end level but whose generator declares no tied()
 *  reds the sweep instead of hiding behind OutcomeUnreachable. */
const SPORTS_SRC = resolve(REPO, "packages/engine/src/sports");
const TIE_SPORTS = new Set((readdirSync(SPORTS_SRC, { recursive: true }) as string[])
  .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.split(sep).includes("__tests__"))
  .filter((p) => /kind:\s*"tie"/.test(readFileSync(resolve(SPORTS_SRC, p), "utf8")))
  .map((p) => p.split(sep)[0]!));
/** A tie is unreachable where the engine never emits one, or where its level
 *  score opens a super over instead (cricket decideTie, cricket.ts:935-946). */
const tieUnreachable = (req: StreamRequest): boolean => !TIE_SPORTS.has(req.sportKey) || (req.cfg as { superOver?: unknown }).superOver === true;

const STAGES: readonly StageKind[] = ["league", "knockout", "swiss"];
const CASES = builtinModules.flatMap((m) =>
  variantKeys(m.key).flatMap((variant) =>
    STAGES.flatMap((stageKind) =>
      ALL_OUTCOMES.map((outcome) => ({
        key: `${m.key}:${variant}:${stageKind}:${outcomeLabel(outcome)}`,
        req: { sportKey: m.key, cfg: resolveSportCfg(m.key, variant), stageKind, home: "H", away: "A", outcome } as StreamRequest,
      })),
    ),
  ),
);
const thrownUnsupported = new Set<string>();
/** Rows whose stream was generated and folded strictly WITHOUT THROWING. Abandon
 *  rows are in here but are not outcome-asserted (matchesRequest answers
 *  "unasserted" before reading the outcome; design §8), so the per-sport
 *  checked count below counts win rows only (R25: a sweep whose every row
 *  abstained is a failure, not a pass). */
const folded = new Set<string>();

describe("stream sweep — discovery first (an empty sweep passes vacuously, R13/R25)", () => {
  it("covers all 11 sports, every declared variant, 3 stage kinds, 7 outcomes", () => {
    expect(new Set(CASES.map((c) => c.req.sportKey)).size).toBe(11);
    const variants = builtinModules.reduce((n, m) => n + variantKeys(m.key).length, 0);
    expect(CASES.length).toBe(variants * STAGES.length * ALL_OUTCOMES.length);
    expect(Object.keys(STREAM_GENERATORS).sort()).toEqual(builtinModules.map((m) => m.key).sort());
  });
});

describe("stream sweep", () => {
  it.each(CASES.map((c) => [c.key, c] as const))("%s", (key, { req }) => {
    let events;
    try {
      events = generateStream(req);
    } catch (e) {
      if (e instanceof OutcomeUnreachable) {
        if (req.outcome.kind === "tie") {
          expect(tieUnreachable(req), `${key}: a tie the engine can reach was refused`).toBe(true);
          return;
        }
        expect(req.outcome.kind).toBe("draw");
        expect(drawsAllowed(req.sportKey, req.cfg, req.stageKind)).toBe(false);
        return;
      }
      if (e instanceof GeneratorUnsupported) {
        thrownUnsupported.add(key);
        expect(KNOWN_UNSUPPORTED, `unlisted generator gap ${key}`).toContain(key);
        return;
      }
      throw e;
    }
    expect(KNOWN_UNSUPPORTED, `stale KNOWN_UNSUPPORTED entry ${key}`).not.toContain(key);
    const m = sportModule(req.sportKey);
    const declared = (m as { eventSchemas?: Record<string, unknown> }).eventSchemas;
    for (const ev of events) {
      if (ev.type.startsWith("core.") || declared === undefined) continue;
      expect(Object.keys(declared), `${key}: ${ev.type}`).toContain(ev.type);
    }
    const result = foldStream(m, req.cfg, "H", "A", events); // strict: throws on an unreachable score
    expect(matchesRequest(req, result.outcome), key).toBe(req.outcome.kind === "abandon" ? "unasserted" : "match");
    if (req.outcome.kind === "tie") expect(tieUnreachable(req), `${key}: a tie generated where the engine cannot end level`).toBe(false);
    folded.add(key);
  });

  it("every KNOWN_UNSUPPORTED entry was actually thrown (the list cannot outlive its gap)", () => {
    expect([...KNOWN_UNSUPPORTED].filter((k) => !thrownUnsupported.has(k))).toEqual([]);
  });

  it("the sweep folded a decided row for every sport (non-zero checked count per sport)", () => {
    for (const m of builtinModules) {
      const decided = [...folded].filter((k) => k.startsWith(`${m.key}:`) && /:win-(home|away)$/.test(k));
      expect(decided.length, `${m.key}: no win row folded`).toBeGreaterThan(0);
    }
  });

  it("the sweep folded a tie row for every sport whose engine can end level, and for no other (ruling 44)", () => {
    expect(TIE_SPORTS.size).toBeGreaterThan(0);
    for (const m of builtinModules) {
      const ties = [...folded].filter((k) => k.startsWith(`${m.key}:`) && k.endsWith(":tie"));
      if (TIE_SPORTS.has(m.key)) expect(ties.length, `${m.key}: no tie row folded`).toBeGreaterThan(0);
      else expect(ties, m.key).toEqual([]);
    }
  });
});

// Every declared variant shares some constant (bestOf ≥ 3, pointsPerCoin 1,
// maxBoards above the boards needed, 3- or 4-period counts, no league decider),
// so a generator that hard-coded it would pass the sweep. Each case below
// overrides one knob so the right answer differs from that constant, then folds
// strictly through the real module.
const WINS: readonly RequestedOutcome[] = ALL_OUTCOMES.filter((o) => o.kind === "win");

function offCatalogue(sportKey: string, variant: string, overrides: Record<string, unknown>, stageKind: StageKind, outcome: RequestedOutcome): StreamRequest {
  const cfg = resolveSportCfg(sportKey, variant, overrides) as Record<string, unknown>;
  const base = resolveSportCfg(sportKey, variant) as Record<string, unknown>;
  // configSchema strips unknown keys: an ignored override would test the default twice.
  for (const k of Object.keys(overrides)) {
    expect(cfg[k], `${sportKey}.${k} override was not applied`).toEqual(overrides[k]);
    expect(cfg[k], `${sportKey}.${k} override equals the default`).not.toEqual(base[k]);
  }
  return { sportKey, cfg, stageKind, home: "H", away: "A", outcome };
}

function foldsAsRequested(req: StreamRequest): { length: number; match: string } {
  const events = generateStream(req);
  return { length: events.length, match: matchesRequest(req, foldStream(sportModule(req.sportKey), req.cfg, "H", "A", events).outcome) };
}

describe("off-catalogue cfgs — the right answer differs from the catalogue's shared constant", () => {
  it("empty case first: the override guard refuses an override the schema drops", () => {
    expect(() => offCatalogue("carrom", "icf", { notAKnob: 1 }, "league", WINS[0] as RequestedOutcome)).toThrow(/override was not applied/);
  });

  it("volleyball bestOf 1: the only set is the FINAL set, won at finalSetTo — not setTo", () => {
    for (const outcome of WINS) {
      const r = offCatalogue("volleyball", "indoor", { bestOf: 1 }, "knockout", outcome);
      const cfg = r.cfg as { setTo: number; finalSetTo: number };
      expect(cfg.finalSetTo).not.toBe(cfg.setTo);
      expect(foldsAsRequested(r)).toEqual({ length: 2, match: "match" });
    }
  });

  it("set-based winBy: the loser's score follows winBy (6), and floors at nil when winBy nears the target (20)", () => {
    for (const overrides of [{ winBy: 6 }, { winBy: 20 }]) {
      for (const outcome of WINS) {
        const got = foldsAsRequested(offCatalogue("badminton", "bwf", overrides, "league", outcome));
        expect(got.match, JSON.stringify(overrides)).toBe("match");
      }
    }
  });

  it("tennis: games follow set.winBy and floor at nil; a best-of-1 is the DECIDING set, a match tie-break under matchTiebreakTo", () => {
    const set = (gamesTo: number, winBy: number) => ({ set: { gamesTo, winBy, tiebreakAt: null, tiebreakTo: 7 } });
    const cases: [string, Record<string, unknown>][] = [
      ["tour", set(6, 4)], // 6-1: a winBy-blind loser score (6-3) is not terminal
      ["tour", set(2, 2)], // 2-0: the nil floor binds
      ["doubles-noad-mtb10", { bestOf: 1 }], // the only set is an MTB, scored in points to matchTiebreakTo
      ["doubles-noad-mtb10", { bestOf: 1, tiebreak: { winBy: 6 } }], // MTB loser follows tiebreak.winBy (10-1, not 10-5)
      // Parked Task 3 T5: winBy ≥ target — 11-0 is the only terminal score, so a
      // loser computed from any other winBy (7 gives 11-1) is not terminal.
      ["doubles-noad-mtb10", { bestOf: 1, finalSet: { matchTiebreakTo: 11 }, tiebreak: { winBy: 11 } }],
      ["grand-slam", { bestOf: 1 }], // finalSet {tiebreakTo} is still a GAMES set
    ];
    for (const [variant, overrides] of cases) {
      for (const outcome of WINS) {
        const got = foldsAsRequested(offCatalogue("tennis", variant, overrides, "knockout", outcome));
        expect(got.match, `${variant} ${JSON.stringify(overrides)}`).toBe("match");
      }
    }
  });

  it("carrom: pointsPerCoin and maxBoards each change how many boards a game needs", () => {
    const base = generateStream(offCatalogue("carrom", "icf", {}, "league", WINS[0] as RequestedOutcome)).length;
    for (const overrides of [{ pointsPerCoin: 2 }, { maxBoards: 2 }]) {
      for (const outcome of WINS) {
        const got = foldsAsRequested(offCatalogue("carrom", "icf", overrides, "league", outcome));
        expect(got.match, JSON.stringify(overrides)).toBe("match");
        expect(got.length, JSON.stringify(overrides)).not.toBe(base);
      }
    }
  });

  it("periodLabels agrees with the engine's strict advance guard at every schema-legal period count", () => {
    let checked = 0;
    for (const [sport, variant] of [["hockey", "fih-outdoor"], ["icehockey", "recreational"]] as const) {
      const counts: number[] = [];
      for (let n = 0; n <= 12; n++) {
        try { resolveSportCfg(sport, variant, { periods: { count: n, minutes: 10 } }); counts.push(n); } catch (e) { if (!(e instanceof CfgInvalid)) throw e; }
      }
      // 2 is the discriminating count: halves are "H", every other non-4 count is "P".
      expect(counts, sport).toContain(2);
      for (const count of counts) {
        for (const outcome of [...WINS, { kind: "draw" } as const]) {
          const r = offCatalogue(sport, variant, { periods: { count, minutes: 10 } }, "league", outcome);
          expect(foldsAsRequested(r).match, `${sport} periods ${count} ${outcomeLabel(outcome)}`).toBe("match");
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("football: a league cfg with ET or a shootout is DECLARED drawable, and the generator refuses the draw it cannot end", () => {
    for (const overrides of [{ extraTime: { enabled: true, halfMinutes: 15 } }, { shootout: true }]) {
      const r = offCatalogue("football", "11-a-side", overrides, "league", { kind: "draw" });
      // supportsDraws reads the stage only (football.ts:2666), never the cfg.
      expect(drawsAllowed("football", r.cfg, "league"), JSON.stringify(overrides)).toBe(true);
      expect(() => generateStream(r), JSON.stringify(overrides)).toThrow(GeneratorUnsupported);
      // Load-bearing: the stream the guard withholds folds UNDECIDED under this cfg.
      const level = [START, ...(footballPhases(2) ?? []).map((phase) => ({ type: "football.period", payload: { phase } }))];
      expect(foldStream(sportModule("football"), r.cfg, "H", "A", level).outcome, JSON.stringify(overrides)).toBeNull();
    }
  });

  it("carrom: tieBoard 'draw' is declared drawable in a league, and the generator refuses the draw (W2 owns its shape)", () => {
    const r = offCatalogue("carrom", "icf", { tieBoard: "draw" }, "league", { kind: "draw" });
    expect(drawsAllowed("carrom", r.cfg, "league")).toBe(true);
    expect(() => generateStream(r)).toThrow(GeneratorUnsupported);
  });
});

// T8 RR-1: the cricket generator hard-coded 4/5/3 wickets, so every short-side
// cfg (3 a side: all-out is 2) folded to "wickets exceed all-out" — a harness
// defect the catalogue filed as an engine refusal for W2. The engine's
// all-out follows playersPerSide (cricket.ts allOutWickets, :625-629, refused
// under a strict fold at :1682); the declared variant set only ever uses one
// side size, so a hard-coded count still passed the default-preset sweep.
const SUMMARY = "cricket.innings.summary";
/** The engine's own declared wicket ceiling for an innings total (its padSpec
 *  field), read here in the test from the module — never from the generator. */
function declaredWicketsMax(cfg: unknown): number {
  const spec = sportModule("cricket").padSpec?.(cfg as never);
  const field = spec?.panels.flatMap((p) => p.actions).find((a) => a.type === SUMMARY)?.fields.find((f) => f.path === "wickets");
  expect(field?.kind, "cricket padSpec declares no summary wickets field").toBe("number");
  return field?.kind === "number" ? field.max : Number.NaN;
}
function cricketWins(cfg: unknown, stageKind: StageKind, label: string): number {
  let n = 0;
  const innings = 2 * (cfg as { inningsPerSide: number }).inningsPerSide;
  for (const outcome of WINS) {
    const req: StreamRequest = { sportKey: "cricket", cfg, stageKind, home: "H", away: "A", outcome };
    const events = generateStream(req);
    const max = declaredWicketsMax(cfg);
    const summaries = events.filter((e) => e.type === SUMMARY).map((e) => e.payload as { wickets: number });
    // One summary per innings; a two-innings innings victory ends an innings early.
    expect(summaries.length, label).toBeLessThanOrEqual(innings);
    expect(summaries.length, label).toBeGreaterThanOrEqual(innings === 2 ? 2 : innings - 1);
    for (const s of summaries) expect(s.wickets, `${label} ${outcomeLabel(outcome)}`).toBeLessThanOrEqual(max);
    // A chase that wins has a wicket in hand: the side is not all out.
    if (outcome.kind === "win" && outcome.winner === "away") expect(summaries.at(-1)?.wickets, label).toBeLessThan(max);
    expect(matchesRequest(req, foldStream(sportModule("cricket"), cfg, "H", "A", events).outcome), `${label} ${outcomeLabel(outcome)}`).toBe("match");
    n++;
  }
  return n;
}

describe("cricket wickets follow playersPerSide (T8 RR-1)", () => {
  it("every committed cricket variant case, both winners, folds strictly to the requested winner — swept from the variant set, counted", () => {
    const vs = buildSportVariants("cricket");
    const sizes = new Set<number>();
    let folded = 0;
    let twoInnings = 0;
    for (const vc of vs.cases) {
      const cfg = resolveSportCfg("cricket", vc.preset, { ...vc.overrides }) as { playersPerSide: number; inningsPerSide: number };
      // Two innings a side folds too since ruling 44 (no generator gap left).
      if (cfg.inningsPerSide === 2) twoInnings++;
      folded += cricketWins(cfg, stagesForRow(vc.row)[0]!.kind as StageKind, `${vc.id} (${cfg.playersPerSide} a side, ${cfg.inningsPerSide} innings)`);
      sizes.add(cfg.playersPerSide);
    }
    expect(folded).toBeGreaterThan(0);
    expect(twoInnings, "the sweep holds no two-innings case to witness ruling 44 with").toBeGreaterThan(0);
    expect(folded / WINS.length).toBe(vs.cases.length);
    // Load-bearing: the set holds a side too short for the old hard-coded 5
    // wickets (all-out below 5), or this sweep cannot witness RR-1.
    expect([...sizes].some((n) => declaredWicketsMax(resolveSportCfg("cricket", "t20", { playersPerSide: n })) < 5), [...sizes].join(",")).toBe(true);
    console.info(`streams: ${folded} cricket variant wins folded across side sizes ${[...sizes].sort((a, b) => a - b).join(", ")}`);
  });

  it("every schema-legal side size up to the default folds both winners — empty case first: the schema refuses a side of 1", () => {
    const refused: number[] = [];
    let folded = 0;
    for (let n = 1; n <= 11; n++) {
      let cfg: unknown;
      try {
        cfg = resolveSportCfg("cricket", "t20", { playersPerSide: n });
      } catch (e) {
        if (!(e instanceof CfgInvalid)) throw e;
        refused.push(n);
        continue;
      }
      for (const stageKind of STAGES) folded += cricketWins(cfg, stageKind, `t20, ${n} a side, ${stageKind}`);
    }
    expect(refused).toEqual([1]);
    expect(folded).toBe(10 * STAGES.length * WINS.length);
  });

  it("the all-out read from the engine's declaration refuses a spec that does not declare it (a guard, reached)", () => {
    const cfg = resolveSportCfg("cricket", "t20", { playersPerSide: 3 });
    const real = sportModule("cricket").padSpec?.(cfg as never);
    expect(declaredAllOut(real)).toBe(declaredWicketsMax(cfg));
    expect(() => declaredAllOut(undefined)).toThrow(AllOutUndeclared);
    expect(() => declaredAllOut({ panels: [], fidelity: {} })).toThrow(AllOutUndeclared);
    const zero = real === undefined ? undefined : {
      ...real,
      panels: real.panels.map((p) => ({ ...p, actions: p.actions.map((a) => (a.type === SUMMARY ? { ...a, fields: a.fields.map((f) => (f.path === "wickets" && f.kind === "number" ? { ...f, max: 0 } : f)) } : a)) })),
    };
    expect(() => declaredAllOut(zero)).toThrow(AllOutUndeclared);
  });
});

describe("label derivations — empty/degenerate first", () => {
  it("periodLabels: 0 → none; 4 → quarters; 2 → halves; 3 → periods", () => {
    expect(periodLabels(0)).toEqual([]);
    expect(periodLabels(4)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(periodLabels(2)).toEqual(["H1", "H2"]);
    expect(periodLabels(3)).toEqual(["P1", "P2", "P3"]);
  });
  it("footballPhases: 2 → HT FT; 4 → QT HT 3QT FT; anything else is not generated", () => {
    expect(footballPhases(2)).toEqual(["HT", "FT"]);
    expect(footballPhases(4)).toEqual(["QT", "HT", "3QT", "FT"]);
    expect(footballPhases(3)).toBeNull();
  });
});

describe("cricket two-innings and tie (ruling 44, D4)", () => {
  // State transitions and empty case first: a `test` cfg asked for EVERY
  // outcome (win either side, draw, tie) on a stage that allows the draw and
  // one that refuses it; then the variations the right answer depends on —
  // the follow-on on/off/out of reach, the super over on, a sport with no tie.
  /** The 24 committed `test`-preset cases (ruling 31), read from the committed catalogue as the other tests read it. */
  const testCases = (): VariantCase[] =>
    (JSON.parse(readFileSync(resolve(REPO, "scripts/matrix/catalogue/variants.json"), "utf8")) as { sports: { sport: string; cases: VariantCase[] }[] })
      .sports.find((s) => s.sport === "cricket")!.cases.filter((c) => c.preset === "test");
  const LEVEL = ALL_OUTCOMES.filter((o) => o.kind === "win" || o.kind === "draw" || o.kind === "tie");

  it("empty case first: the preset itself (no overrides) folds every reachable outcome, and the knockout draw is the one refused", () => {
    const cfg = resolveSportCfg("cricket", "test");
    expect((cfg as { ballsPerInnings: unknown }).ballsPerInnings).toBeNull(); // the TEST_BALLS premise, from the engine preset
    const got: string[] = [];
    for (const stageKind of ["league", "knockout"] as const) {
      for (const outcome of LEVEL) {
        const req = { sportKey: "cricket", cfg, stageKind, home: "h", away: "a", outcome };
        try {
          const events = generateStream(req);
          expect(events.filter((e) => e.type === SUMMARY).every((e) => (e.payload as { legalBalls: number }).legalBalls <= TEST_BALLS)).toBe(true);
          expect(matchesRequest(req, foldStream(sportModule("cricket"), cfg, "h", "a", events).outcome), `${stageKind} ${outcomeLabel(outcome)}`).toBe("match");
          got.push(`${stageKind}:${outcomeLabel(outcome)}`);
        } catch (e) {
          expect(e, `${stageKind} ${outcomeLabel(outcome)}`).toBeInstanceOf(OutcomeUnreachable);
          got.push(`${stageKind}:${outcomeLabel(outcome)}:unreachable`);
        }
      }
    }
    // Draw reachability is the engine's (supportsDraws), never a table: only where it answers false is the draw refused.
    const expected = (["league", "knockout"] as const).flatMap((k) => LEVEL.map((o) => `${k}:${outcomeLabel(o)}${o.kind === "draw" && !drawsAllowed("cricket", cfg, k) ? ":unreachable" : ""}`));
    expect(got).toEqual(expected);
    expect(got.filter((g) => g.endsWith(":unreachable"))).toEqual(["knockout:draw:unreachable"]);
  });

  it("the 24 committed test-preset cases each fold every reachable outcome to the requested result — counted", () => {
    let folded = 0;
    const cases = testCases();
    expect(cases.length).toBe(24);
    for (const vc of cases) {
      const cfg = resolveSportCfg("cricket", "test", vc.overrides);
      for (const stageKind of ["league", "knockout"] as const) {
        for (const outcome of LEVEL) {
          const req = { sportKey: "cricket", cfg, stageKind, home: "h", away: "a", outcome };
          let events;
          try { events = generateStream(req); } catch (e) {
            expect(e, `${vc.id} ${stageKind} ${outcomeLabel(outcome)}`).toBeInstanceOf(OutcomeUnreachable);
            expect(outcome.kind === "draw" && !drawsAllowed("cricket", cfg, stageKind), `${vc.id}: only a refused draw may be unreachable here`).toBe(true);
            continue;
          }
          expect(matchesRequest(req, foldStream(sportModule("cricket"), cfg, "h", "a", events).outcome), `${vc.id} ${stageKind} ${outcomeLabel(outcome)}`).toBe("match");
          folded++;
        }
      }
    }
    expect(folded).toBeGreaterThan(cases.length * 2);
    console.info(`streams: ${folded} two-innings outcomes folded across the ${cases.length} committed test cases`);
  });

  it("a cfg with an over limit (most committed test cases override ballsPerInnings) keeps every innings inside it; with none, TEST_BALLS — both arms reached", () => {
    let checked = 0;
    for (const vc of testCases()) {
      const cfg = resolveSportCfg("cricket", "test", vc.overrides) as { ballsPerInnings: number | null };
      for (const outcome of LEVEL) {
        let events;
        try { events = generateStream({ sportKey: "cricket", cfg, stageKind: "league", home: "h", away: "a", outcome }); } catch { continue; }
        for (const e of events.filter((x) => x.type === SUMMARY)) {
          expect((e.payload as { legalBalls: number }).legalBalls, vc.id).toBeLessThanOrEqual(cfg.ballsPerInnings ?? TEST_BALLS);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    // Both arms: some committed cases set a quota (the strict fold refuses legalBalls above it, cricket.ts:1686), some keep the preset's none.
    const withQuota = testCases().filter((c) => typeof c.overrides.ballsPerInnings === "number").length;
    expect(withQuota).toBeGreaterThan(0);
    expect(withQuota).toBeLessThan(testCases().length);
  });

  it("win-home uses the follow-on only where the cfg enables it and the lead reaches it; the by-runs shape otherwise folds to the same winner", () => {
    const on = resolveSportCfg("cricket", "test");
    const off = resolveSportCfg("cricket", "test", { followOn: { enabled: false, lead: 200 } });
    const beyond = resolveSportCfg("cricket", "test", { followOn: { enabled: true, lead: 400 } }); // the shape's lead is 300: out of reach
    const ev = (cfg: unknown) => generateStream({ sportKey: "cricket", cfg, stageKind: "league", home: "h", away: "a", outcome: { kind: "win", winner: "home" } });
    expect(ev(on).some((e) => e.type === "cricket.followon")).toBe(true);
    expect(ev(off).some((e) => e.type === "cricket.followon")).toBe(false);
    expect(ev(beyond).some((e) => e.type === "cricket.followon")).toBe(false);
    for (const cfg of [on, off, beyond]) expect(foldStream(sportModule("cricket"), cfg, "h", "a", ev(cfg)).outcome).toMatchObject({ kind: "win", winner: "h" });
    // The innings victory is the follow-on's own result, and the 4-innings chase is by runs.
    expect(foldStream(sportModule("cricket"), on, "h", "a", ev(on)).outcome).toMatchObject({ method: "innings" });
    expect(foldStream(sportModule("cricket"), off, "h", "a", ev(off)).outcome).toMatchObject({ method: "regulation" });
  });

  it("tie: limited overs folds level with superOver off, is unreachable with it on; two innings folds level too; a sport with no tied() is unreachable", () => {
    const t20 = resolveSportCfg("cricket", "t20");
    const test = resolveSportCfg("cricket", "test");
    const req = (cfg: unknown, sportKey = "cricket") => ({ sportKey, cfg, stageKind: "league" as const, home: "h", away: "a", outcome: { kind: "tie" } as const });
    expect(foldStream(sportModule("cricket"), t20, "h", "a", generateStream(req(t20))).outcome?.kind).toBe("tie");
    expect(foldStream(sportModule("cricket"), test, "h", "a", generateStream(req(test))).outcome?.kind).toBe("tie");
    // The guard's premise, from the engine (decideTie, cricket.ts:935-946): under a super over the same level stream does NOT end tied.
    const t20so = resolveSportCfg("cricket", "t20", { superOver: true });
    expect(foldStream(sportModule("cricket"), t20so, "h", "a", generateStream(req(t20))).outcome).toBeNull();
    expect(() => generateStream(req(t20so))).toThrow(OutcomeUnreachable);
    // Two innings cannot carry a super over (the engine's refine: "superOver requires inningsPerSide = 1");
    // a raw cfg that claims both is still refused by the guard, never generated.
    expect(() => resolveSportCfg("cricket", "test", { superOver: true })).toThrow(CfgInvalid);
    expect(() => generateStream(req({ ...(test as object), superOver: true }))).toThrow(OutcomeUnreachable);
    expect(() => generateStream(req(resolveSportCfg("badminton", offlineBuilderDefault("badminton")), "badminton"))).toThrow(OutcomeUnreachable);
  });

  it("matchesRequest's tie arm: a tie request matches a folded tie only — a win, a draw or nothing is a mismatch (preflight T10 a)", () => {
    const r = { sportKey: "cricket", cfg: resolveSportCfg("cricket", "t20"), stageKind: "league" as const, home: "h", away: "a", outcome: { kind: "tie" } as const };
    expect(matchesRequest(r, { kind: "tie" })).toBe("match");
    expect(matchesRequest(r, { kind: "win", winner: "h", loser: "a" })).toBe("mismatch");
    expect(matchesRequest(r, { kind: "draw" })).toBe("mismatch");
    expect(matchesRequest(r, null)).toBe("mismatch");
  });

  it("a cfg that is neither one nor two innings a side is refused by name (the schema allows neither; a guard, reached)", () => {
    const cfg = { ...(resolveSportCfg("cricket", "t20") as object), inningsPerSide: 3 };
    expect(() => cricketGenerator.decided({ sportKey: "cricket", cfg, stageKind: "league", home: "h", away: "a", outcome: { kind: "win", winner: "home" } })).toThrow(GeneratorUnsupported);
    expect(() => resolveSportCfg("cricket", "t20", { inningsPerSide: 3 })).toThrow(CfgInvalid);
  });

  it("KNOWN_UNSUPPORTED is empty (ruling 44)", () => { expect(KNOWN_UNSUPPORTED).toEqual([]); });
});
