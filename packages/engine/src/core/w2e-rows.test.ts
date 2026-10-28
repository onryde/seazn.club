// W2e cross-sport rule rows proved in src/core. Every describe/it title carries its row id as a whole token
// (packages/engine/test/rules-reference.ts reads them).
//
// X-SU-1 (Task 15, checklist X6a): core.suspend and core.resume on the goal sports. They are kernel-owned: the fold records the stoppage
// and the sport module never sees either event, so nothing it holds - score, period, outcome - can move. A decided match cannot be
// suspended. The expected values are the row's own statement, checked on the real football, hockey and ice hockey modules.
//
// X-DV-1 (Task 17, SC-P13): draws on a ladder, double-elimination, stepladder or page-playoff stage are not built as a table result, by
// design. The engine half is the declaration every sport makes (`supportsDraws` is false in those stage kinds, whatever the config, and no
// table-paid level result is reachable there) and the kernel's stage sets (`forbidsLevelResult`). A level SCORE is still folded as a draw by
// the sport module (the fold does not know the stage); the stage then holds it for the organiser's settle (`settleOffered`), which is the
// engine half of X-BR-2. What the web door does with it - stores it `needs_decision` (X-BR-2), or refuses a generic one (GN-KO-1) - is those
// rows' and is proved in apps/web.
//
// Every fold is PAD-SHAPED (`strictFromSeq: 0`): the write path.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatch, foldMatchWithStoppage, outcomeOf, settleOffered, type EventEnvelope } from "../core/events.ts";
import { DRAW_KINDS, forbidsLevelResult, isLevelOutcome, StageKind, type LineupPair } from "../core/types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";

const STRICT = { strictFromSeq: 0 } as const;

type Spec = [type: string, payload?: unknown, voids?: string];

interface GoalSport {
  key: string;
  module: AnySportModule;
  lineups: LineupPair;
  /** A goal for `by`. */
  goal: (by: string) => Spec;
  /** The markers that take regulation from the opening whistle to full time. */
  toFullTime: Spec[];
}

const moduleOf = (key: string): AnySportModule => {
  const found = builtinModules.find((m) => m.key === key);
  if (found === undefined) throw new Error(`no module "${key}" in the registry`);
  return found;
};

/** The goal sports of X-SU-1's text: football, hockey, ice hockey. Each carries the events that drive its own goal and its own periods. */
const GOAL_SPORTS: GoalSport[] = [
  {
    key: "football",
    module: moduleOf("football"),
    lineups: defaultLineupPair(moduleOf("football").positions),
    goal: (by) => ["football.goal", { by }],
    toFullTime: [["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]],
  },
  {
    key: "hockey",
    module: moduleOf("hockey"),
    lineups: defaultLineupPair(moduleOf("hockey").positions),
    goal: (by) => ["hockey.goal", { by, kind: "fg" }],
    toFullTime: ["Q2", "Q3", "Q4", "FT"].map((to): Spec => ["hockey.period.advance", { to }]),
  },
  {
    key: "icehockey",
    module: moduleOf("icehockey"),
    lineups: defaultLineupPair(moduleOf("icehockey").positions),
    goal: (by) => ["icehockey.goal", { by }],
    toFullTime: ["P2", "P3", "FT"].map((to): Spec => ["icehockey.period.advance", { to }]),
  },
];

const stream = (specs: readonly Spec[]): EventEnvelope[] =>
  specs.map(([type, payload, voids], i) => makeEnvelope(i, { type, payload: payload ?? {} }, voids));
const cfgOf = (sport: GoalSport): unknown => sport.module.configSchema.parse({});
const fold = (sport: GoalSport, specs: readonly Spec[]) => foldMatch(sport.module, cfgOf(sport), sport.lineups, stream(specs), STRICT);
const foldFull = (sport: GoalSport, specs: readonly Spec[]) =>
  foldMatchWithStoppage(sport.module, cfgOf(sport), sport.lineups, stream(specs), STRICT);

/** The code of the EngineError a fold throws, or null when it folds. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
}

const START: Spec = ["core.start"];
const SUSPEND: Spec = ["core.suspend", { reason: "floodlight failure" }];
const RESUME: Spec = ["core.resume"];

describe("X-SU-1 core.suspend and core.resume on the goal sports record a stoppage the sport module never sees, and a decided match cannot be suspended", () => {
  it("X-SU-1 sweeps the three goal sports of the row, all in the registry", () => {
    // Anti-vacuity: the sweep below is over these, and an empty or shrunk list would prove nothing.
    expect(GOAL_SPORTS.map((s) => s.key)).toEqual(["football", "hockey", "icehockey"]);
    for (const sport of GOAL_SPORTS) expect(builtinModules).toContain(sport.module);
  });

  it("X-SU-1 a suspend and a resume leave the folded state of the sport byte for byte as it was, mid-match", () => {
    let checked = 0;
    for (const sport of GOAL_SPORTS) {
      const played: Spec[] = [START, sport.goal("H"), sport.goal("A"), sport.goal("H")];
      const control = fold(sport, played);
      expect(sport.module.outcome(control), `${sport.key} control is mid-match`).toBeNull();
      const withStoppage = fold(sport, [...played, SUSPEND, RESUME]);
      expect(withStoppage, sport.key).toEqual(control);
      // Mid-stoppage the state is the same too: the module has not been told anything.
      const during = fold(sport, [...played, SUSPEND]);
      expect(during, `${sport.key} during the stoppage`).toEqual(control);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("X-SU-1 the stoppage is recorded on the fold with its reason, and clears on resume", () => {
    for (const sport of GOAL_SPORTS) {
      const open = foldFull(sport, [START, sport.goal("H"), SUSPEND]);
      expect(open.stoppage, sport.key).toEqual({ reason: "floodlight failure", eventId: "e-2" });
      expect(foldFull(sport, [START, sport.goal("H"), SUSPEND, RESUME]).stoppage, `${sport.key} resumed`).toBeNull();
      // A resume with no open stoppage is a no-op, not a refusal (a voided suspend leaves its resume pointing at nothing).
      expect(foldFull(sport, [START, sport.goal("H"), RESUME]).stoppage, `${sport.key} orphan resume`).toBeNull();
    }
  });

  it("X-SU-1 a scoring event during the stoppage is refused until play resumes, and the score then moves as usual", () => {
    for (const sport of GOAL_SPORTS) {
      expect(codeOf(() => fold(sport, [START, SUSPEND, sport.goal("H")])), `${sport.key} goal while suspended`).toBe("WRONG_PHASE");
      const resumed = fold(sport, [START, SUSPEND, RESUME, sport.goal("H")]);
      expect((resumed as { goals: { home: number; away: number } }).goals, `${sport.key} after resume`).toEqual({ home: 1, away: 0 });
      // A second suspend while one is open is refused too.
      expect(codeOf(() => fold(sport, [START, SUSPEND, SUSPEND])), `${sport.key} second suspend`).toBe("WRONG_PHASE");
    }
  });

  it("X-SU-1 the stoppage leaves period and phase where they were: the period markers wait for the resume", () => {
    for (const sport of GOAL_SPORTS) {
      const first = sport.toFullTime[0] as Spec;
      expect(codeOf(() => fold(sport, [START, SUSPEND, first])), `${sport.key} period marker while suspended`).toBe("WRONG_PHASE");
      const phaseBefore = (fold(sport, [START]) as { phase: string }).phase;
      expect((fold(sport, [START, SUSPEND]) as { phase: string }).phase, sport.key).toBe(phaseBefore);
    }
  });

  it("X-SU-1 a decided match cannot be suspended, however it was decided", () => {
    let checked = 0;
    for (const sport of GOAL_SPORTS) {
      const decided: Spec[] = [START, sport.goal("H"), ...sport.toFullTime];
      expect(sport.module.outcome(fold(sport, decided)), `${sport.key} decided by the score`).toMatchObject({ kind: "win", winner: "H" });
      expect(codeOf(() => fold(sport, [...decided, SUSPEND])), `${sport.key} suspend after full time`).toBe("ALREADY_DECIDED");
      // Decided by a forfeit: the same refusal. A retirement needs something played first (ruling 113), hence the goal.
      const forfeited: Spec[] = [START, sport.goal("H"), ["core.forfeit", { by: "A", reason: "retired" }]];
      expect(codeOf(() => fold(sport, [...forfeited, SUSPEND])), `${sport.key} suspend after a forfeit`).toBe("ALREADY_DECIDED");
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("X-SU-1 the organiser's abandon, a forfeit and a note are still admitted during the stoppage; the abandon and the forfeit decide the match as they would otherwise", () => {
    for (const sport of GOAL_SPORTS) {
      // Abandon under the default replay policy: no result, flagged for the organiser.
      const abandoned = foldFull(sport, [START, sport.goal("H"), SUSPEND, ["core.abandon", { reason: "thunderstorm" }]]);
      expect(outcomeOf(sport.module, abandoned), `${sport.key} abandon`).toBeNull();
      expect((abandoned.state as { replayFlagged: boolean }).replayFlagged, `${sport.key} abandon flagged`).toBe(true);
      // A retirement forfeit (something is played, so it is admitted) awards the match to the other side.
      const forfeited = foldFull(sport, [START, sport.goal("H"), SUSPEND, ["core.forfeit", { by: "A", reason: "retired" }]]);
      expect(outcomeOf(sport.module, forfeited), `${sport.key} forfeit`).toEqual({ kind: "award", winner: "H", loser: "A", reason: "retired" });
      // An annotation is admitted and moves neither the score nor the open stoppage.
      const noted = foldFull(sport, [START, sport.goal("H"), SUSPEND, ["core.note", { text: "covers on" }]]);
      expect(noted.stoppage, `${sport.key} note`).toEqual({ reason: "floodlight failure", eventId: "e-2" });
      expect((noted.state as { goals: { home: number } }).goals.home, `${sport.key} note score`).toBe(1);
    }
  });

  it("X-SU-1 voiding the suspend un-suspends the match, and voiding the resume suspends it again", () => {
    for (const sport of GOAL_SPORTS) {
      const unsuspended = fold(sport, [START, SUSPEND, ["core.void", {}, "e-1"], sport.goal("H")]);
      expect((unsuspended as { goals: { home: number } }).goals.home, `${sport.key} void suspend`).toBe(1);
      const resuspended = foldFull(sport, [START, SUSPEND, RESUME, ["core.void", {}, "e-2"]]);
      expect(resuspended.stoppage, `${sport.key} void resume`).toEqual({ reason: "floodlight failure", eventId: "e-1" });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// X-DV-1 (SC-P13) - draws on a ladder, double-elimination, stepladder or page-playoff stage: not built, by design
// ---------------------------------------------------------------------------------------------------------------------

describe("X-DV-1 no sport can end a ladder, double-elimination, stepladder or page-playoff match level: supportsDraws is false there under every config", () => {
  // The four stage kinds of the row's text, by their StageKind values.
  const NO_DRAW_KINDS = ["ladder", "double_elim", "stepladder", "page_playoff"] as const;

  /** Every config a sport declares, plus carrom's tieBoard "draw" house rule: no declared carrom variant turns it on, and it is the one
   *  switch that makes a carrom table match drawable. */
  const cfgsOf = (m: AnySportModule): Array<{ name: string; cfg: unknown }> => [
    ...declaredCfgs<unknown>(m as never),
    ...(m.key === "carrom" ? [{ name: "tieBoard draw", cfg: m.configSchema.parse({ tieBoard: "draw" }) as unknown }] : []),
  ];

  it("X-DV-1 the four stage kinds are real StageKind values, and the kernel forbids a level result in each", () => {
    for (const kind of NO_DRAW_KINDS) {
      expect(StageKind.options, kind).toContain(kind);
      expect(forbidsLevelResult(kind), kind).toBe(true);
      // None of them is a stage kind that takes draws.
      expect(DRAW_KINDS.has(kind), kind).toBe(false);
    }
    // The negative pair: a table stage kind does not forbid one.
    for (const kind of DRAW_KINDS) expect(forbidsLevelResult(kind), kind).toBe(false);
    expect(DRAW_KINDS.size).toBeGreaterThan(0);
  });

  it("X-DV-1 every sport, under every declared config, supports no draw on the four stage kinds and pays no level result into a table there", () => {
    let pairs = 0;
    let checked = 0;
    const sports = forEachSport(({ module: m }) => {
      for (const { name, cfg } of cfgsOf(m)) {
        pairs++;
        for (const kind of NO_DRAW_KINDS) {
          expect(m.supportsDraws(cfg as never, kind), `${m.key} ${name} ${kind}`).toBe(false);
          expect([...m.reachableResultKinds(cfg as never, kind)], `${m.key} ${name} ${kind} table-paid level results`).toEqual([]);
          checked++;
        }
      }
    });
    expect(sports).toBe(builtinModules.length);
    expect(pairs).toBeGreaterThan(builtinModules.length);
    expect(checked).toBe(pairs * NO_DRAW_KINDS.length);
  });

  it("X-DV-1 the sweep is not vacuous: wherever a table CAN draw, the four kinds still cannot", () => {
    // Anti-vacuity: a sweep over sports that never draw anywhere would pass on `return false` everywhere. These are the (sport, config) pairs
    // whose table stage supports a draw, read from the engine's own declarations.
    const drawCapable: Array<{ key: string; name: string; cfg: unknown }> = [];
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of cfgsOf(m)) if (m.supportsDraws(cfg as never, "league")) drawCapable.push({ key: m.key, name, cfg });
    });
    expect(drawCapable.length).toBeGreaterThan(0);
    // The sports with a draw-capable config include the goal sports, the board game, generic, carrom (its house rule) and a cricket Test.
    const sports = new Set(drawCapable.map((d) => d.key));
    for (const key of ["football", "hockey", "icehockey", "boardgame", "generic", "carrom", "cricket"]) expect(sports.has(key), key).toBe(true);
    // The set sports never draw at all.
    for (const key of ["volleyball", "badminton", "tabletennis", "tennis"]) expect(sports.has(key), key).toBe(false);
    let checked = 0;
    for (const { key, name, cfg } of drawCapable) {
      const module = builtinModules.find((m) => m.key === key)!;
      for (const kind of NO_DRAW_KINDS) {
        expect(module.supportsDraws(cfg as never, "league"), `${key} ${name} league`).toBe(true);
        expect(module.supportsDraws(cfg as never, kind), `${key} ${name} ${kind}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(drawCapable.length * NO_DRAW_KINDS.length);
  });

  it("X-DV-1 a level score is still folded as a draw on each of the four kinds, and the stage holds it for the organiser's settle where a table keeps it", () => {
    // The fold does not know the stage: a level score is a draw whichever kind it is played in. What differs is the kernel's answer to "is this
    // match owed the organiser's settle?" (`settleOffered`): yes on a bracket kind (held, X-BR-2), no in a table (the draw is a result).
    // One level fold per sport that can reach a draw (the set sports cannot: test above). Generic's draw is refused at the web door
    // (GN-KO-1) but its fold is the same.
    interface Level { key: string; cfg: unknown; lineups: LineupPair; specs: Spec[] }
    const level = (key: string, cfg: unknown, specs: Spec[]): Level => {
      const module = moduleOf(key);
      return { key, cfg: module.configSchema.parse(cfg), lineups: defaultLineupPair(module.positions), specs };
    };
    const levels: Level[] = [
      level("football", {}, [START, ["football.goal", { by: "H" }], ["football.period", { phase: "HT" }], ["football.goal", { by: "A" }], ["football.period", { phase: "FT" }]]),
      level("boardgame", {}, [START, ["boardgame.result", { winner: null, method: "agreement" }]]),
      level("carrom", { gameTo: 100, maxBoards: 1, bestOf: 1, tieBoard: "draw" }, [START, ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 0, queenTo: null }]]),
      level("generic", declaredCfgs<unknown>(moduleOf("generic") as never).find((c) => c.name === "score")?.cfg ?? {}, [START, ["generic.result", { isDraw: true, p1Score: 1, p2Score: 1 }]]),
    ];
    let held = 0;
    let kept = 0;
    for (const { key, cfg, lineups, specs } of levels) {
      const module = moduleOf(key);
      const folded = foldMatchWithStoppage(module, cfg, lineups, stream(specs), STRICT);
      const outcome = outcomeOf(module, folded);
      expect(outcome, `${key} folds the level score to a draw`).toEqual({ kind: "draw" });
      expect(isLevelOutcome(outcome), key).toBe(true);
      const facts = { outcome, abandoned: false, state: folded.state };
      for (const kind of NO_DRAW_KINDS) {
        expect(settleOffered(module, kind, facts), `${key} ${kind}: held for the organiser's settle`).toBe(true);
        held++;
      }
      // The negative pair: a table kind keeps the same draw as its result.
      for (const kind of DRAW_KINDS) {
        expect(settleOffered(module, kind, facts), `${key} ${kind}: the draw is a result`).toBe(false);
        kept++;
      }
    }
    expect(held).toBe(levels.length * NO_DRAW_KINDS.length);
    expect(kept).toBe(levels.length * DRAW_KINDS.size);
    expect(levels.length).toBeGreaterThan(1);
  });
});
