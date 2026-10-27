// W2d Task 18 (HK-TB-2, B3; PS-7d, owner 2026-10-24) — a hockey (FIH) goal records its type.
//
// FIH GTR App. 3 ranks level teams on FIELD GOALS: every goal not scored from a penalty corner or a penalty stroke,
// own goals included (B3). The table reads it as gf − goals_pc − goals_stroke, so an untyped corner goal would count
// as a field goal. The engine therefore refuses an untyped `hockey.goal` on the WRITE path, by its own name
// (`GOAL_KIND_REQUIRED`, PS-7d: the scorer sees it, so it is not `CONFIG_INVALID`). Replay stays tolerant: a ledger
// that already holds an untyped goal (an older pad, the API before this) still folds, and that goal counts as a field
// goal (B3's definition, owner G1 2026-10-26).
//
// The expected answers come from the rule rows, never from the preset flag under test: HK-TB-2 makes FIH hockey record
// every goal's type; IIHF ice hockey and IFAB football rank on no goal type, so their goals stay typeless.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "../../core/events.ts";
import { mulberry32 } from "../../core/rng.ts";
import type { LineupPair } from "../../core/types.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import { FOLD_EPOCH } from "../../sport/fold-epoch.ts";
import type { AnySportModule, ModuleEvent } from "../../sport/module.ts";
import { declaredCfgs } from "../../testkit/declared-cfgs.ts";
import { forEachSport } from "../../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { hockey } from "../hockey/hockey.ts";
import { icehockey } from "../icehockey/icehockey.ts";
import type { PeriodState } from "./kernel.ts";

/** The rule rows, by sport key: true where the federation's ranking reads a goal's type (HK-TB-2, FIH GTR App. 3).
 *  Absent means the sport's goals carry no type a rule reads (IIHF, IFAB). */
const GOAL_TYPE_RANKS: Readonly<Record<string, true>> = { hockey: true };

/** Every write a test below makes is PAD-SHAPED: the whole stream is new (`strictFromSeq: 0`), the write path. */
const STRICT_ALL = { strictFromSeq: 0 } as const;

const envelopes = (events: readonly ModuleEvent[]): EventEnvelope[] => events.map((e, i) => makeEnvelope(i, e));

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof EngineError) return err.code;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The FIH ledger the field-goal rule reads, from a real fold of the hockey kernel.
// single-sport: field goals are FIH hockey's own tie-break (HK-TB-2); no other sport ranks on a goal's type.
// ---------------------------------------------------------------------------

const fihCfg = hockey.configSchema.parse({});
const fihLineups: LineupPair = defaultLineupPair(resolvePositions(hockey, fihCfg));
const FH = fihLineups.home.entrantId;
const FA = fihLineups.away.entrantId;
const start: ModuleEvent = { type: "core.start", payload: {} };
const goal = (by: string, kind?: string): ModuleEvent => ({
  type: "hockey.goal",
  payload: kind === undefined ? { by } : { by, kind },
});
// FIH outdoor: four quarters (hockey.ts defaults), then full time.
const toFullTime: ModuleEvent[] = ["Q2", "Q3", "Q4", "FT"].map((to) => ({ type: "hockey.period.advance", payload: { to } }));

/** gf − goals_pc − goals_stroke per side (FIH GTR App. 3, B3), off the table rows the module pays for a finished
 *  match — the ledger `field_goals` compares (`competition/cascade-rules.ts`). */
function fieldGoals(stream: readonly EventEnvelope[], opts?: { strictFromSeq?: number }): { home: number; away: number } {
  const folded = foldMatchWithStoppage(hockey, fihCfg, fihLineups, stream, opts);
  const outcome = outcomeOf(hockey, folded);
  if (outcome === null) throw new Error("the stream decided nothing");
  const [home, away] = hockey.standingsDelta(outcome, fihCfg, { kind: "league" }, folded.state);
  const fg = (row: typeof home | undefined): number => {
    const m = row?.metrics ?? {};
    return (m["gf"] ?? 0) - (m["goals_pc"] ?? 0) - (m["goals_stroke"] ?? 0);
  };
  const byId = new Map([home, away].map((row) => [row?.entrantId, row]));
  return { home: fg(byId.get(FH)), away: fg(byId.get(FA)) };
}

describe("W2d T18 — a hockey (FIH) goal records its type (HK-TB-2, B3, PS-7d)", () => {
  it("HK-TB-2 B3 a strict hockey.goal with no kind is refused GOAL_KIND_REQUIRED (PS-7d: the named code, not CONFIG_INVALID); every other sport's typeless goal is accepted", () => {
    let refused = 0;
    let accepted = 0;
    const sports = forEachSport(({ key, module }) => {
      const type = `${key}.goal`;
      if ((module as AnySportModule).eventSchemas?.[type] === undefined) return; // no goal event to type
      for (const { name, cfg } of declaredCfgs(module as never)) {
        const lineups = defaultLineupPair(resolvePositions(module as never, cfg));
        const stream = envelopes([start, { type, payload: { by: lineups.home.entrantId } }]);
        const code = codeOf(() => foldMatch(module as never, cfg, lineups, stream, STRICT_ALL));
        if (GOAL_TYPE_RANKS[key] === true) {
          expect(code, `${key}/${name}`).toBe("GOAL_KIND_REQUIRED");
          refused++;
        } else {
          expect(code, `${key}/${name}: a typeless goal is this sport's ordinary goal`).toBeNull();
          accepted++;
        }
      }
    });
    expect(sports).toBeGreaterThan(0);
    // Both halves reached: FIH hockey's declared cfgs refused, and at least one other sport (ice hockey) accepted.
    expect(refused).toBeGreaterThanOrEqual(declaredCfgs(hockey as never).length);
    expect(accepted).toBeGreaterThanOrEqual(declaredCfgs(icehockey as never).length);
  });

  it("the refusal names the kinds the sport records, and is an EngineError the server maps by code", () => {
    let err: unknown;
    try {
      foldMatch(hockey, fihCfg, fihLineups, envelopes([start, goal(FH)]), STRICT_ALL);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ code: "GOAL_KIND_REQUIRED", data: { goalKinds: fihCfg.goalKinds } });
  });

  it("every kind the cfg declares is an explicit choice the write path accepts, Field goal (fg) included", () => {
    let checked = 0;
    for (const { name, cfg } of declaredCfgs(hockey as never)) {
      const lineups = defaultLineupPair(resolvePositions(hockey, cfg as never));
      for (const kind of (cfg as PeriodState["cfg"]).goalKinds) {
        const state = foldMatch(hockey, cfg as never, lineups, envelopes([start, goal(lineups.home.entrantId, kind)]), STRICT_ALL);
        // An own goal credits the other side (FIH Rule 9.12); every other kind the side that struck it.
        const credited = kind === "og" ? state.goals.away : state.goals.home;
        expect(credited, `${name}/${kind}`).toBe(1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("PS-7d an own goal (kind 'og', the existing ownGoal control) is accepted under strict and counts as a field goal for the credited side", () => {
    const stream = envelopes([start, goal(FH, "og"), ...toFullTime]);
    // Strict all the way: the own goal is a typed goal, so the write path takes it.
    expect(codeOf(() => foldMatch(hockey, fihCfg, fihLineups, stream, STRICT_ALL))).toBeNull();
    // H struck it into its own goal: A gets the goal, and it is a field goal (B3: own goals count).
    expect(fieldGoals(stream, STRICT_ALL)).toEqual({ home: 0, away: 1 });
  });

  it("HK-TB-2 replay of a ledger holding an untyped goal still folds and counts it as a field goal (the read path and the next append)", () => {
    // H's untyped goal is history (an older pad, or the API before this); A's corner goal is typed.
    const legacy = envelopes([start, goal(FH), goal(FA, "pc"), ...toFullTime]);
    // The READ path (state, score page, standings) passes no options: tolerant.
    expect(fieldGoals(legacy)).toEqual({ home: 1, away: 0 });
    // The next APPEND validates only the new event (append-event.ts: strictFromSeq = the candidate's seq), so the
    // untyped goal at seq 1 is replayed, not re-judged.
    expect(fieldGoals(legacy, { strictFromSeq: 2 })).toEqual({ home: 1, away: 0 });
    // The same ledger written today is refused at the untyped goal: tolerance is replay's, not the write's.
    expect(codeOf(() => foldMatch(hockey, fihCfg, fihLineups, legacy, STRICT_ALL))).toBe("GOAL_KIND_REQUIRED");
  });

  it("a void of a legacy untyped goal is a strict write the engine takes (the void is new, the goal is history)", () => {
    const voided = [...envelopes([start, goal(FH)]), makeEnvelope(2, { type: "core.void", payload: {} }, "e-1")];
    const state = foldMatch(hockey, fihCfg, fihLineups, voided, { strictFromSeq: 2 });
    expect(state.goals).toEqual({ home: 0, away: 0 });
  });

  it("the sequence: a refused untyped goal, then the same goal with its type is accepted, and the next goal needs its own", () => {
    expect(codeOf(() => foldMatch(hockey, fihCfg, fihLineups, envelopes([start, goal(FH)]), STRICT_ALL))).toBe("GOAL_KIND_REQUIRED");
    const resent = envelopes([start, goal(FH, "stroke")]);
    expect(foldMatch(hockey, fihCfg, fihLineups, resent, STRICT_ALL).goals).toEqual({ home: 1, away: 0 });
    // The second goal of the match is judged on its own: a typed first goal does not license an untyped second.
    const second = envelopes([start, goal(FH, "stroke"), goal(FA)]);
    expect(codeOf(() => foldMatch(hockey, fihCfg, fihLineups, second, STRICT_ALL))).toBe("GOAL_KIND_REQUIRED");
  });

  it("the generator a conformance walk folds strictly never emits an untyped hockey goal, while ice hockey's still does", () => {
    const walk = (module: AnySportModule, type: string): { goals: number; untyped: number } => {
      let goals = 0;
      let untyped = 0;
      for (const { cfg } of declaredCfgs(module as never)) {
        const lineups = defaultLineupPair(resolvePositions(module as never, cfg));
        for (let seed = 1; seed <= 25; seed++) {
          const rng = mulberry32(seed);
          let state = module.init(cfg as never, lineups);
          for (let i = 0; i < 120; i++) {
            const next = module.arbitraryEvent?.(state as never, rng) ?? null;
            if (next === null) break;
            if (next.type === type) {
              goals++;
              if ((next.payload as { kind?: unknown }).kind === undefined) untyped++;
            }
            // `apply` with no context is STRICT (core/events.ts isStrictFold): what conformance and the floor do.
            state = module.apply(state as never, makeEnvelope(i, next) as never);
          }
        }
      }
      return { goals, untyped };
    };
    const fih = walk(hockey as never, "hockey.goal");
    expect(fih.goals).toBeGreaterThan(0);
    expect(fih.untyped).toBe(0);
    const iihf = walk(icehockey as never, "icehockey.goal");
    expect(iihf.goals).toBeGreaterThan(0);
    expect(iihf.untyped, "ice hockey's goal type stays optional, and its walk still writes a typeless goal").toBeGreaterThan(0);
  });

  it("fold-epoch: FOLD_EPOCH.hockey is 4 (Task 3's 3, plus this task's major; PS-9c — no git in vitest); ice hockey is untouched at 2", () => {
    expect(FOLD_EPOCH.hockey).toBe(4);
    expect(FOLD_EPOCH.icehockey).toBe(2);
  });
});
