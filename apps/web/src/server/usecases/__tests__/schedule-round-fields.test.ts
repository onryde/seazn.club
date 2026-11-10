// X-SW-31 / rulings 255-256, the PURE half: what the three round fields are made of, and who gets them.
// (schedule-swiss-round-barrier.test.ts drives every real producer through the database and judges what reaches the
// engine; this file pins the helpers those producers share, with no database.)
//
// Expected values come from the rulebook and the engine's own declarations, never from the code under test:
//   - X-SW-31 gives the end barrier to a Swiss stage and to nothing else (stage kinds from the API's own `StageKind` enum);
//   - the division's "minimum rest" is the STRICTEST of the engine's rest sources (`restFloor`'s documented MAX, #459), so
//     the rest figures below are chosen so a "first source wins" or "ignore the rest" reading lands on a different number;
//   - the per-player daily cap is a `max_fixtures_per_day` rule that counts each PLAYER (`every_entrant`) or PERSON
//     (`every_person`) separately - the engine's `entityKeysFor` - not the division-wide one the constraints panel writes.
import { describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { makeClock, validateAssignments } from "@seazn/engine/scheduling";
import type { HardConstraint } from "@seazn/engine/scheduling";
import { StageKind } from "@/server/api-v1/schemas";
import type { AiSchedulePlan } from "../schedule-ai-prompt";
import { toEngineAssignments, toSchedulableFixtures, verifyConfig, type PackFixture, type SchedulePack } from "../schedule-ai";
import {
  ROUND_SEQUENCE_STAGE_KINDS,
  perPlayerDailyCap,
  roundBarrierFor,
  roundFieldsFor,
  roundFieldsOf,
  toAssignment,
  type FixtureLite,
  type RoundFields,
} from "../schedule";

const DIV = "11111111-1111-4111-8111-111111111111";
const OTHER_DIV = "22222222-2222-4222-8222-222222222222";

describe("roundBarrierFor: the one helper (X-SW-31)", () => {
  it("every stage kind: the end barrier for a Swiss stage and for nothing else", () => {
    const kinds = StageKind.options;
    const ends = kinds.filter((k) => roundBarrierFor(k) === "end");
    expect(kinds.length, "anti-vacuity: the whole kind registry was swept").toBeGreaterThanOrEqual(9);
    expect(ends, "only swiss").toEqual(["swiss"]);
    for (const k of kinds.filter((x) => x !== "swiss")) expect(roundBarrierFor(k), `${k}: no barrier at all (absent = the start floor)`).toBeUndefined();
  });

  it("swiss is a round-sequence stage (the barrier needs a round to bar)", () => {
    expect(ROUND_SEQUENCE_STAGE_KINDS).toContain("swiss");
  });
});

describe("perPlayerDailyCap: only the rules that count each player", () => {
  const rule = (count: number, scope: HardConstraint["scope"]): HardConstraint => ({ type: "max_fixtures_per_day", count, scope });
  it("none, or the division-wide one alone: 0 (no per-player cap)", () => {
    expect(perPlayerDailyCap(undefined)).toBe(0);
    expect(perPlayerDailyCap([])).toBe(0);
    expect(perPlayerDailyCap([rule(5, { kind: "division", divisionId: DIV })]), "the constraints panel's box is a different quantity").toBe(0);
  });
  it("an every_person or every_entrant rule is the cap; with both, the smaller", () => {
    expect(perPlayerDailyCap([rule(3, { kind: "every_person" })])).toBe(3);
    expect(perPlayerDailyCap([rule(4, { kind: "every_entrant" })])).toBe(4);
    expect(perPlayerDailyCap([rule(4, { kind: "every_entrant" }), rule(2, { kind: "every_person" }), rule(1, { kind: "division", divisionId: DIV })])).toBe(2);
  });
  it("another kind of hard rule is not a cap", () => {
    expect(perPlayerDailyCap([{ type: "min_rest_minutes", minutes: 10, scope: { kind: "every_entrant" } } as HardConstraint])).toBe(0);
  });
});

describe("roundFieldsFor: the fields a round sequence of one stage kind carries", () => {
  const constraints = (over: Record<string, unknown> = {}) => ({
    noBackToBack: false,
    startWindows: [],
    fieldFairness: "off" as const,
    parallelism: "mixed" as const,
    crossPersonClash: "warn" as const,
    ...over,
  });
  const cfg = (over: { perEntrantMinRest?: number; constraints?: ReturnType<typeof constraints> } = {}) => ({
    perEntrantMinRest: over.perEntrantMinRest ?? 0,
    gapMinutes: 0,
    matchMinutes: 30,
    ...(over.constraints !== undefined ? { constraints: over.constraints } : {}),
  });

  it("a start-floor kind carries NO key at all (not a zero): every kind but swiss", () => {
    // "No key" is not "a key set to undefined": `toEqual({})` accepts `{ roundBarrier: undefined }`, so each key is
    // asserted ABSENT (and the key list empty), under a rest and under a per-player cap - the two inputs that make a
    // Swiss row carry a value.
    const cap: HardConstraint[] = [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "every_person" } }];
    const withCap = cfg({ perEntrantMinRest: 30, constraints: constraints({ hard: cap }) });
    let swept = 0;
    for (const k of StageKind.options.filter((x) => x !== "swiss")) {
      for (const [label, config] of [["a rest of 30", cfg({ perEntrantMinRest: 30 })], ["nothing set", cfg()], ["a rest and a cap", withCap]] as const) {
        const fields = roundFieldsFor(k, config, DIV);
        for (const key of ["roundBarrier", "roundGapMinutes", "roundsPerDayCap"] as const) {
          expect(fields, `${k} (${label}): no ${key} key`).not.toHaveProperty(key);
        }
        expect(Object.keys(fields), `${k} (${label}): no keys at all`).toEqual([]);
      }
      swept++;
    }
    expect(swept, "anti-vacuity").toBe(StageKind.options.length - 1);
    expect(swept, "anti-vacuity: the sweep reached at least one non-swiss kind").toBeGreaterThan(0);
  });

  it("a Swiss stage with nothing set: the barrier and two explicit zeros", () => {
    expect(roundFieldsFor("swiss", cfg(), DIV)).toEqual({ roundBarrier: "end", roundGapMinutes: 0, roundsPerDayCap: 0 });
  });

  it("the gap is the division's strictest rest source, not the first and not the Settings field alone", () => {
    expect(roundFieldsFor("swiss", cfg({ perEntrantMinRest: 20 }), DIV).roundGapMinutes, "Settings alone").toBe(20);
    expect(roundFieldsFor("swiss", cfg({ perEntrantMinRest: 20, constraints: constraints({ restMin: 45 }) }), DIV).roundGapMinutes, "restMin above Settings").toBe(45);
    expect(roundFieldsFor("swiss", cfg({ perEntrantMinRest: 50, constraints: constraints({ restMin: 45 }) }), DIV).roundGapMinutes, "Settings above restMin").toBe(50);
    expect(
      roundFieldsFor("swiss", cfg({ perEntrantMinRest: 20, constraints: constraints({ restByGroup: { [DIV]: 60 } }) }), DIV).roundGapMinutes,
      "a rest keyed to THIS division",
    ).toBe(60);
    expect(
      roundFieldsFor("swiss", cfg({ perEntrantMinRest: 20, constraints: constraints({ restByGroup: { [OTHER_DIV]: 90 } }) }), DIV).roundGapMinutes,
      "a rest keyed to another division is not this one's",
    ).toBe(20);
  });

  it("the cap is the per-player daily cap", () => {
    const hard: HardConstraint[] = [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "every_person" } }];
    expect(roundFieldsFor("swiss", cfg({ constraints: constraints({ hard }) }), DIV).roundsPerDayCap).toBe(2);
  });

  it("no settings at all (a division that has none yet): the barrier alone, gap and cap zero", () => {
    expect(roundFieldsFor("swiss", undefined, DIV)).toEqual({ roundBarrier: "end", roundGapMinutes: 0, roundsPerDayCap: 0 });
  });
});

describe("the producers' seam: roundFieldsOf and toAssignment", () => {
  const SWISS = "swiss-stage";
  const LEAGUE = "league-stage";
  const BRACKET = "bracket-stage";
  const swissFields: RoundFields = { roundBarrier: "end", roundGapMinutes: 30, roundsPerDayCap: 2 };
  const stages = new Map<string, RoundFields>([
    [SWISS, swissFields],
    [LEAGUE, {}],
  ]);
  const lite = (over: Partial<FixtureLite>): FixtureLite => ({
    id: "f1",
    stage_id: SWISS,
    division_id: DIV,
    pool_id: null,
    round_no: 2,
    seq_in_round: 1,
    ext_key: null,
    home_entrant_id: null,
    away_entrant_id: null,
    outcome: null,
    home_slot_label: null,
    away_slot_label: null,
    scheduled_at: "2030-08-01T10:00:00Z",
    court_id: "c1",
    venue_id: null,
    court_label: null,
    venue: null,
    status: "scheduled",
    schedule_locked: false,
    winner_to_fixture: null,
    loser_to_fixture: null,
    ...over,
  });

  it("a Swiss row carries its round and the three fields; a league row its round alone; a bracket row nothing", () => {
    expect(roundFieldsOf(stages, { stage_id: SWISS, round_no: 2 })).toEqual({ roundNo: 2, ...swissFields });
    expect(roundFieldsOf(stages, { stage_id: LEAGUE, round_no: 2 })).toEqual({ roundNo: 2 });
    expect(roundFieldsOf(stages, { stage_id: BRACKET, round_no: 2 })).toEqual({});
    expect(roundFieldsOf(undefined, { stage_id: SWISS, round_no: 2 }), "no stages passed: round order inert, as before").toEqual({});
  });

  it("a bare id set (the old shape) still orders by round and carries no barrier", () => {
    expect(roundFieldsOf(new Set([SWISS]), { stage_id: SWISS, round_no: 2 })).toEqual({ roundNo: 2 });
  });

  it("toAssignment: the three fields on a Swiss board, none on a league board, and nothing at all on a Swiss bye shell", () => {
    const people = new Map<string, string[]>();
    expect(toAssignment(lite({}), 30, people, stages)).toMatchObject({ roundNo: 2, ...swissFields });
    const league = toAssignment(lite({ stage_id: LEAGUE }), 30, people, stages);
    expect(league.roundNo).toBe(2);
    expect(Object.keys(league).filter((k) => k.startsWith("round")), "a league row carries the round and nothing else").toEqual(["roundNo"]);
    const bye = toAssignment(lite({ ext_key: "sw-r2-bye" }), 30, people, stages);
    expect(Object.keys(bye).filter((k) => k.startsWith("round")), "a bye is no round's board").toEqual([]);
    expect(Object.keys(toAssignment(lite({}), 30, people)).filter((k) => k.startsWith("round")), "no stages passed").toEqual([]);
  });
});

describe("the AI pack adapters stamp pack.roundRules beside pack.roundNos", () => {
  const T0 = Date.parse("2030-08-01T09:00:00.000Z");
  const MIN = 60_000;
  const iso = (t: number) => new Date(t).toISOString();
  const rules: RoundFields = { roundBarrier: "end", roundGapMinutes: 15, roundsPerDayCap: 3 };

  function pack(fixtures: { id: string; round: number; stageId: string; rr: boolean; swiss: boolean }[], withRules: boolean): SchedulePack {
    const movable: PackFixture[] = fixtures.map((f, i) => ({
      id: f.id,
      ext_key: null,
      round: f.round,
      seq: i,
      pool: null,
      home: null,
      away: null,
      feeds: { winner_to: null, after: [] },
      current: { at: null, court: null },
      pinned: false,
    }));
    return {
      mode: "generate",
      division: { id: DIV, name: "Div", sport: "generic", tz: "UTC" },
      tz: "UTC",
      clock: makeClock(T0, "UTC"),
      window: { start: "2030-08-01", end: "2030-08-08" },
      sessionHours: { start: "08:00", end: "22:00" },
      settings: {
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 0,
        courts: ["Court 1", "Court 2", "Court 3"],
        sessionWindows: [],
        blackouts: [],
        constraints: { noBackToBack: false, startWindows: [], fieldFairness: "off", parallelism: "mixed", crossPersonClash: "warn" },
      },
      entrants: [],
      people: [],
      participants: Object.fromEntries(fixtures.map((f) => [f.id, [] as string[]])),
      poolIds: {},
      stageIds: Object.fromEntries(fixtures.map((f) => [f.id, f.stageId] as const)),
      roundNos: Object.fromEntries(fixtures.filter((f) => f.rr).map((f) => [f.id, f.round] as const)),
      ...(withRules ? { roundRules: Object.fromEntries(fixtures.filter((f) => f.swiss).map((f) => [f.id, rules] as const)) } : {}),
      assumptions: [],
      parsed: { hard: [], soft: [], unparsed: [] },
      fixtures: { movable, obstacles: [] },
      draft: [],
      instruction: "",
      prior: null,
      officials: [],
    };
  }
  const board = [
    { id: "s1", round: 1, stageId: "swiss", rr: true, swiss: true },
    { id: "s2", round: 2, stageId: "swiss", rr: true, swiss: true },
    { id: "l1", round: 1, stageId: "league", rr: true, swiss: false },
    { id: "k1", round: 1, stageId: "ko", rr: false, swiss: false },
  ];
  const plan = (): AiSchedulePlan => ({
    assignments: board.map((f, i) => ({ fixture_id: f.id, scheduled_at: iso(T0 + i * 60 * MIN), court_label: "Court 1" })),
    unschedulable: [],
    explanations: [],
    summary: "",
  });

  it("the plan's Assignments and the full SchedulableFixture set carry the Swiss rules on the Swiss rows alone", () => {
    const p = pack(board, true);
    for (const rows of [toEngineAssignments(plan(), p), toSchedulableFixtures(p)]) {
      const byId = new Map(rows.map((r) => [("fixtureId" in r ? r.fixtureId : r.id) as string, r]));
      expect(byId.size, "anti-vacuity: all four fixtures").toBe(4);
      expect(byId.get("s1")).toMatchObject(rules);
      expect(byId.get("s2")).toMatchObject(rules);
      expect(Object.keys(byId.get("l1")!).filter((k) => k.startsWith("round")), "league: the round alone").toEqual(["roundNo"]);
      expect(Object.keys(byId.get("k1")!).filter((k) => k.startsWith("round")), "bracket: nothing").toEqual([]);
    }
  });

  it("a pack that predates the field stamps no rule (the start floor it always had)", () => {
    const p = pack(board, false);
    expect(toEngineAssignments(plan(), p).every((a) => a.roundBarrier === undefined && a.roundGapMinutes === undefined)).toBe(true);
    expect(toSchedulableFixtures(p).every((f) => f.roundBarrier === undefined)).toBe(true);
  });

  it("the premise the whole sweep rests on: the engine refuses a Swiss sequence whose rows disagree", () => {
    const p = pack(board, true);
    const rows = toEngineAssignments(plan(), p);
    expect(() => validateAssignments(rows, verifyConfig(p)), "uniform rows verify").not.toThrow();
    const mixed = rows.map((r) => (r.fixtureId === "s2" ? { ...r, roundBarrier: undefined } : r));
    const err = (() => {
      try {
        validateAssignments(mixed, verifyConfig(p));
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(EngineError.is(err, "CONFIG_INVALID"), "one producer that forgets the barrier makes every Swiss edit fail").toBe(true);
  });
});
