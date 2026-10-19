// W2c Task 17 (review M-3) — `SportModule.canEndLevel`: can a bracket match still finish LEVEL once every decider its cfg
// carries has run? The web reads it twice (the stage editor's "a level match waits for you" notice and the public format
// line), so it must be the ENGINE's answer. Expected values here come from FOLDING real streams, never from the
// declaration under test:
//   - soundness: a cfg the module says cannot end level never does, across seeded random streams;
//   - completeness: where it says it can, a stream (random where the generator reaches it, else the sport's own scripted
//     level finish) really ends level.
// "Level" is the engine's own word for a drawn or tied score: `outcome.kind` `draw` | `tie` (`isLevelOutcome` also counts
// `no_result`, which an abandon makes and a decider has nothing to do with).
import { describe, expect, it } from "vitest";
import { mulberry32 } from "../core/rng.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { BRACKET_KINDS, DRAW_KINDS } from "../core/types.ts";
import { resolvePositions } from "./catalog.ts";
import type { AnySportModule } from "./module.ts";
import { deciderKeysFor, bracketMayEndLevel } from "./rule-keys.ts";
import { builtinModules } from "../sports/index.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";

const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};

/** The cfg a BRACKET stage plays: the parsed cfg with the sport's own bracket overlay laid over it (the resolver's order). */
function bracketCfg(m: AnySportModule, over: Record<string, unknown>): Record<string, unknown> {
  const parsed = m.configSchema.parse(over) as Record<string, unknown>;
  return { ...parsed, ...(m.bracketDeciders(parsed) as Record<string, unknown>) };
}

/** Plays one seeded random match to its end under `cfg`; the outcome kind it reached, or null when it never decided. */
function playSeed(m: AnySportModule, cfg: Record<string, unknown>, seed: number): string | null {
  const lineups = defaultLineupPair(resolvePositions(m, cfg));
  const rng = mulberry32(seed);
  let state: unknown = m.init(cfg, lineups);
  for (let i = 0; i < 700; i++) {
    const next = m.arbitraryEvent?.call(m, state as never, rng);
    if (next === null || next === undefined) break;
    state = m.apply(state, makeEnvelope(i, next));
    const outcome = m.outcome(state);
    if (outcome !== null) return outcome.kind;
  }
  return null;
}

const SEEDS = 400;
const isLevel = (kind: string | null): boolean => kind === "draw" || kind === "tie";

/** The outcome kinds `SEEDS` random matches reach under `cfg`. */
function kindsOver(m: AnySportModule, cfg: Record<string, unknown>): { decided: number; level: number } {
  let decided = 0;
  let level = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const kind = playSeed(m, cfg, seed);
    if (kind === null) continue;
    decided++;
    if (isLevel(kind)) level++;
  }
  return { decided, level };
}

// One row = one decider configuration of one sport. The cfg overrides are INPUTS (which switches to throw); what each
// row proves is read from the fold.
// `raw` rows are played under their cfg as parsed, with no bracket overlay: the setups the overlay would hide (carrom's
// drawn-game house rule, a chess match with no tie-break at all). They are what a TABLE stage plays, and the declaration
// answers for them too.
interface Row { readonly sport: string; readonly name: string; readonly cfg: Record<string, unknown>; readonly canEnd: boolean; readonly raw?: true }
const OFF = { enabled: false, halfMinutes: 15 } as const;
const ET = { enabled: true, halfMinutes: 15 } as const;
const PENS = { attempts: 5, suddenDeath: true } as const;
const SD_OT = { kind: "sudden_death", minutes: 5, skaters: 3 } as const;
const ROWS: readonly Row[] = [
  { sport: "football", name: "both deciders off", cfg: { shootout: false, extraTime: OFF }, canEnd: true },
  { sport: "football", name: "extra time only: still level after it", cfg: { shootout: false, extraTime: ET }, canEnd: true },
  { sport: "football", name: "penalties only", cfg: { shootout: true, extraTime: OFF }, canEnd: false },
  { sport: "football", name: "extra time then penalties", cfg: { shootout: true, extraTime: ET }, canEnd: false },
  { sport: "icehockey", name: "no overtime, no shootout", cfg: { overtime: null, shootout: null }, canEnd: true },
  { sport: "icehockey", name: "sudden-death overtime only: a scoreless overtime ends level", cfg: { overtime: SD_OT, shootout: null }, canEnd: true },
  { sport: "icehockey", name: "shootout only", cfg: { overtime: null, shootout: PENS }, canEnd: false },
  { sport: "icehockey", name: "overtime then shootout", cfg: { overtime: SD_OT, shootout: PENS }, canEnd: false },
  { sport: "hockey", name: "no shootout", cfg: { shootout: null }, canEnd: true },
  { sport: "hockey", name: "shootout", cfg: { shootout: PENS }, canEnd: false },
  { sport: "carrom", name: "extra board (the bracket overlay forces it over a drawn-game division)", cfg: { tieBoard: "draw" }, canEnd: false },
  { sport: "carrom", name: "drawn game as configured, no overlay: the tie stands", cfg: { tieBoard: "draw" }, canEnd: true, raw: true },
  { sport: "boardgame", name: "tie-break rungs absent: every rung is played", cfg: {}, canEnd: false },
  { sport: "boardgame", name: "one rung", cfg: { tiebreakRungs: ["blitz"] }, canEnd: false },
  { sport: "boardgame", name: "no rungs: a drawn game stays level", cfg: { tiebreakRungs: [] }, canEnd: true },
  { sport: "boardgame", name: "no tie-break played at all, no overlay: a draw stands", cfg: { tiebreak: false }, canEnd: true, raw: true },
  { sport: "cricket", name: "no super over", cfg: { ballsPerInnings: 30, superOver: false }, canEnd: true },
  { sport: "cricket", name: "super over repeated until decided", cfg: { ballsPerInnings: 30, superOver: true, superOverStillTied: "repeat" }, canEnd: false },
];

describe("canEndLevel (M-3): the engine says which bracket decider setups can still end level", () => {
  it("empty case first: a module declares it exactly when it declares a decider (counted)", () => {
    let withDecider = 0;
    let without = 0;
    for (const m of builtinModules) {
      const declaresDecider = Object.values(m.ruleKeys ?? {}).some((f) => f.decider === true);
      if (declaresDecider) {
        expect(typeof m.canEndLevel, `${m.key} declares a decider but not canEndLevel`).toBe("function");
        withDecider++;
      } else {
        expect(m.canEndLevel, `${m.key} declares no decider, so it makes no level claim`).toBeUndefined();
        without++;
      }
    }
    expect(withDecider).toBe(6); // football, cricket, icehockey, hockey, carrom, boardgame
    expect(without).toBeGreaterThan(0);
    expect(withDecider + without).toBe(builtinModules.length);
  });

  it("the rows cover every sport that declares it (counted)", () => {
    const declaring = builtinModules.filter((m) => m.canEndLevel !== undefined).map((m) => m.key);
    expect(declaring.length).toBeGreaterThan(0);
    for (const key of declaring) expect(ROWS.some((r) => r.sport === key), key).toBe(true);
  });

  for (const row of ROWS) {
    it(`${row.sport}: ${row.name} -> canEndLevel ${String(row.canEnd)}, and the folds agree`, () => {
      const m = sport(row.sport);
      const cfg = row.raw === true ? (m.configSchema.parse(row.cfg) as Record<string, unknown>) : bracketCfg(m, row.cfg);
      expect(m.canEndLevel!(cfg as never), "the declaration").toBe(row.canEnd);
      const { decided, level } = kindsOver(m, cfg);
      expect(decided, "the generator reached an outcome (anti-vacuity)").toBeGreaterThan(SEEDS / 4);
      // Soundness: "cannot end level" is never contradicted by a real match. Reached from the other side too: where the
      // module says it can, the generator must be shown to produce a level result at least once (completeness).
      if (row.canEnd) expect(level, "a level match was reached").toBeGreaterThan(0);
      else expect(level, "no match ended level").toBe(0);
    });
  }
});

// The generator never plays a tied super over (a tied 30-ball innings is rare, and a tied super over after it rarer
// still), so cricket's "can end level behind a super over" rows are witnessed by the sport's own scripted finish: a tied
// main innings, then a super over that is itself tied (cricket.test.ts "tied T20 super over policies").
describe("canEndLevel (M-3): cricket behind a super over, witnessed by a scripted tied finish", () => {
  // Eleven a side, personIds H-1..H-11 / A-1..A-11, as cricket.test.ts builds them.
  const side = (prefix: string): LineupPair["home"] => ({
    entrantId: prefix,
    slots: Array.from({ length: 11 }, (_, i) => ({ personId: `${prefix}-${i + 1}`, slot: "starting" as const, orderNo: i + 1 })),
  });
  const lineups: LineupPair = { home: side("H"), away: side("A") };
  /** One super-over innings of six legal balls scoring `bats[i]` off ball i. */
  const innings = (striker: string, non: string, bowler: string, bats: readonly number[]): [string, Record<string, unknown>][] =>
    bats.map((bat, i) => ["cricket.superover.ball", { over: 0, ballInOver: i + 1, striker, nonStriker: non, bowler, runs: { bat } }]);

  function tiedEverywhere(policy: "repeat" | "boundary_count" | "shared"): { cfg: Record<string, unknown>; events: EventEnvelope[] } {
    const m = sport("cricket");
    const cfg = bracketCfg(m, { superOver: true, superOverStillTied: policy });
    const rows: [string, Record<string, unknown>][] = [
      ["core.start", {}],
      ["cricket.innings.summary", { runs: 150, wickets: 5, legalBalls: 120, boundaries: 10 }],
      ["cricket.innings.summary", { runs: 150, wickets: 7, legalBalls: 120, boundaries: 10 }],
      // The away side batted second, so it bats first in the super over (ICC); both score six: tied again, boundaries level.
      ...innings("A-1", "A-2", "H-11", [2, 2, 2, 0, 0, 0]),
      ...innings("H-1", "H-2", "A-11", [2, 2, 2, 0, 0, 0]),
    ];
    return { cfg, events: rows.map(([type, payload], i) => makeEnvelope(i, { type, payload })) };
  }
  const outcomeOfFold = (cfg: Record<string, unknown>, events: EventEnvelope[]): { kind: string } | null => {
    const state: unknown = foldMatch(sport("cricket") as never, cfg as never, lineups, events, { strictFromSeq: 0 });
    return (state as { outcome: { kind: string } | null }).outcome;
  };

  it("shared: a tied super over stands as a tie", () => {
    const { cfg, events } = tiedEverywhere("shared");
    expect(outcomeOfFold(cfg, events)?.kind).toBe("tie");
    expect(sport("cricket").canEndLevel!(cfg as never)).toBe(true);
  });

  it("boundary_count: equal boundaries as well as equal runs is still a tie", () => {
    const { cfg, events } = tiedEverywhere("boundary_count");
    expect(outcomeOfFold(cfg, events)?.kind).toBe("tie");
    expect(sport("cricket").canEndLevel!(cfg as never)).toBe(true);
  });

  it("repeat: the same tied super over does NOT end the match - another one is played", () => {
    const { cfg, events } = tiedEverywhere("repeat");
    expect(outcomeOfFold(cfg, events)).toBeNull();
    expect(sport("cricket").canEndLevel!(cfg as never)).toBe(false);
  });
});

describe("bracketMayEndLevel: the helper the web asks", () => {
  const football = sport("football");
  const off = bracketCfg(football, { shootout: false, extraTime: OFF });
  const pens = bracketCfg(football, { shootout: true, extraTime: OFF });

  it("answers the module for a bracket kind, and false for a table kind (a draw there is a result)", () => {
    let checked = 0;
    for (const kind of BRACKET_KINDS) {
      expect(bracketMayEndLevel(football, kind, off), `${kind} off`).toBe(true);
      expect(bracketMayEndLevel(football, kind, pens), `${kind} pens`).toBe(false);
      checked++;
    }
    for (const kind of DRAW_KINDS) {
      expect(bracketMayEndLevel(football, kind, off), `${kind} (a table)`).toBe(false);
      checked++;
    }
    expect(checked).toBe(BRACKET_KINDS.size + DRAW_KINDS.size);
    expect(bracketMayEndLevel(football, null, off), "no stage kind (the division level) makes no claim").toBe(false);
  });

  it("a module that declares no decider makes no claim, whatever the cfg", () => {
    const badminton = sport("badminton");
    expect(deciderKeysFor(badminton, "knockout", null)).toEqual([]);
    expect(bracketMayEndLevel(badminton, "knockout", bracketCfg(badminton, {}))).toBe(false);
  });

  it("a cfg the schema refuses makes no claim (the same safe direction as the describer)", () => {
    expect(bracketMayEndLevel(football, "knockout", { halfMinutes: -1 })).toBe(false);
  });

  it("a hand-built module with no bracketDeciders is asked nothing of them: the declaration reads the parsed cfg alone", () => {
    // The web's describer already tolerates such a double; the helper it now calls must not throw where the describer
    // does not. Football's own overlay is empty, so the real module is the control: both must answer the same.
    const double = { ...football, bracketDeciders: undefined } as unknown as AnySportModule;
    expect(typeof double.bracketDeciders).toBe("undefined");
    expect(() => bracketMayEndLevel(double, "knockout", off)).not.toThrow();
    expect(bracketMayEndLevel(double, "knockout", off)).toBe(bracketMayEndLevel(football, "knockout", off));
    expect(bracketMayEndLevel(double, "knockout", off)).toBe(true);
    expect(bracketMayEndLevel(double, "knockout", pens)).toBe(false);
  });
});
