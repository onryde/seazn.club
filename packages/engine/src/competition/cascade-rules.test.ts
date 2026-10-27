// W2d Task 6 (spec §5.5; D3, D8, D10(d), D11, OC1, OC3; rule rows X-TB-3, X-TB-5, X-TB-7, FB-TB-4). The write side of a
// tie-break order: `validateCascade` returns EVERY refusal, and `offerableKeys` is the editor's "+ Add step" (§9).
//
// Every expected refusal comes from the spec's own text (the rule rows, D8, D10(d), D11, OC1, OC3) or from the engine's
// declarations — `module.primaryTableKey`, `module.metrics`, `module.configSchema`, and the ledgers the comparators read
// (`RATIO_LEDGERS`, `DIFF_KEYS`, `FOR_KEYS`) — never from the validator itself. The vocabulary below is typed as a full
// Record over `TiebreakerKey`, so engine tsc fails the day the union grows a key these sweeps would not visit.
//
// Sequence (TEST-STRATEGY rule 1): the empty order → a valid one → one fault → three faults → another sport; a second
// call on the same input; the ranker running exactly what the validator lets through (rule 5).
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { StageKind } from "../core/types.ts";
import type { AnySportModule, TiebreakerKey } from "../sport/module.ts";
// single-sport: boardgame (chess) is the sport whose default order ranks on buchholz, so it is valid only on a Swiss stage (rule 3); every rule is also swept over forEachSport
import { boardgame } from "../sports/boardgame/index.ts";
// single-sport: cricket is the one sport that records the NRR ledger (D10(d)) — the positive case beside the forEachSport refusal sweep
import { cricket } from "../sports/cricket/index.ts";
// single-sport: football is the one sport with the fair_play metric and a `fairPlay` cfg switch (D8, FB-TB-4)
import { football } from "../sports/football/index.ts";
// single-sport: hockey is the one sport that records goals_pc/goals_stroke (field_goals, B3)
import { hockey } from "../sports/hockey/index.ts";
import { builtinModules } from "../sports/index.ts";
// single-sport: badminton is a D11 "wins first" sport, where the wrong answer ("points") differs from the right one
import { badminton } from "../sports/setbased/badminton.ts";
// single-sport: table tennis is the set sport that ranks on points (D11), the contrast to badminton's wins
import { tabletennis } from "../sports/setbased/tabletennis.ts";
// single-sport: tennis records no goal/run difference, the witness for how a 'sport' refusal's `need` names every alias of the ledger it lacks
import { tennis } from "../sports/tennis/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { offerableKeys, validateCascade, type CascadeContext, type CascadeRefusal } from "./cascade-rules.ts";
import { RATIO_LEDGERS } from "./display.ts";
import { DIFF_KEYS, FOR_KEYS, rankStandings } from "./tiebreakers.ts";

const VOCABULARY: Record<TiebreakerKey, true> = {
  points: true, wins: true, h2h_points: true, h2h_diff: true, h2h_for: true, diff: true, for: true, nrr: true,
  set_ratio: true, game_ratio: true, board_ratio: true, point_ratio: true, buchholz: true, buchholz_cut1: true,
  sberger: true, direct: true, fair_play: true, seed: true, lots: true, set_diff: true, point_diff: true, h2h_two: true,
  h2h_wins: true, h2h_set_ratio: true, h2h_point_ratio: true, h2h_reapply: true, h2h_exclusion: true,
  matches_played: true, field_goals: true,
};
const KEYS = Object.keys(VOCABULARY) as TiebreakerKey[];
const SPORTS = builtinModules.length;
const KINDS = StageKind.options;
const NON_SWISS = KINDS.filter((kind) => kind !== "swiss");

// Spec §5.5 rule 4: "every head-to-head key (`h2h_*`, `h2h_two`, `direct`, the h2h modifiers)".
const headToHead = (key: TiebreakerKey): boolean => key.startsWith("h2h_") || key === "direct";
// Spec §5.5 rule 5 / §5.6: the block modifiers, and the mini-table keys a block is made of (h2h_two and direct are their
// own steps, not mini-table keys).
const MODIFIERS: readonly TiebreakerKey[] = ["h2h_reapply", "h2h_exclusion"];
const BLOCK_KEYS: readonly TiebreakerKey[] = ["h2h_points", "h2h_diff", "h2h_for", "h2h_wins", "h2h_set_ratio", "h2h_point_ratio"];

// Spec §5.5 rule 2: the ledger each metric-backed key ranks on — the one its comparator reads (tiebreakers.ts: DIFF_KEYS and
// FOR_KEYS by alias, RATIO_LEDGERS for the ratio and difference keys, the NRR fraction's four counters, and field goals'
// gf − goals_pc − goals_stroke, spec §5.6 B3). Every group must be recorded; any one alias of a group will do.
const LEDGER: Partial<Record<TiebreakerKey, readonly (readonly string[])[]>> = {
  diff: [DIFF_KEYS], h2h_diff: [DIFF_KEYS],
  for: [FOR_KEYS], h2h_for: [FOR_KEYS],
  nrr: [["runs_for"], ["balls_faced_eff"], ["runs_against"], ["balls_bowled_eff"]],
  set_ratio: RATIO_LEDGERS.set_ratio.map((m) => [m]), set_diff: RATIO_LEDGERS.set_ratio.map((m) => [m]),
  h2h_set_ratio: RATIO_LEDGERS.set_ratio.map((m) => [m]),
  point_ratio: RATIO_LEDGERS.point_ratio.map((m) => [m]), point_diff: RATIO_LEDGERS.point_ratio.map((m) => [m]),
  h2h_point_ratio: RATIO_LEDGERS.point_ratio.map((m) => [m]),
  game_ratio: RATIO_LEDGERS.game_ratio.map((m) => [m]),
  board_ratio: RATIO_LEDGERS.board_ratio.map((m) => [m]),
  field_goals: [["gf"], ["goals_pc"], ["goals_stroke"]],
  fair_play: [["fair_play"]],
};

const firstCfg = (module: AnySportModule): unknown => (declaredCfgs(module)[0] as { cfg: unknown }).cfg;
const ctxOf = (module: AnySportModule, stageKind: StageKind = "league", over: Partial<CascadeContext> = {}): CascadeContext => ({
  module, cfg: firstCfg(module), stageKind, crossGroup: false, ...over,
});
/** The refusals in a fixed order (index, then reason), so a test pins the SET of faults, not the validator's emit order. */
const sorted = (refusals: readonly CascadeRefusal[]): CascadeRefusal[] =>
  [...refusals].sort((a, b) => a.index - b.index || a.reason.localeCompare(b.reason));
const reasons = (refusals: readonly CascadeRefusal[], reason: CascadeRefusal["reason"]): CascadeRefusal[] =>
  refusals.filter((r) => r.reason === reason);
const other = (primary: "points" | "wins"): "points" | "wins" => (primary === "points" ? "wins" : "points");
const records = (module: AnySportModule, groups: readonly (readonly string[])[]): boolean => {
  const keys = new Set(module.metrics.map((m) => m.key));
  return groups.every((aliases) => aliases.some((m) => keys.has(m)));
};

describe("validateCascade — X-TB-3 the order's shape (spec §5.5 rule 1), empty first", () => {
  it("X-TB-3 [] is refused {index:-1, key:null, reason:'empty'} on every stage kind including swiss", () => {
    expect(KINDS, "premise: swiss is a stage kind").toContain("swiss");
    let checked = 0;
    forEachSport(({ module }) => {
      for (const stageKind of KINDS) {
        for (const crossGroup of [false, true]) {
          expect(validateCascade([], ctxOf(module, stageKind, { crossGroup })), `${module.key} ${stageKind}`).toEqual([
            { index: -1, key: null, reason: "empty" },
          ]);
          checked++;
        }
      }
    });
    expect(checked).toBe(SPORTS * KINDS.length * 2);
  });

  it("X-TB-3 [primaryTableKey, …, lots] is accepted on every stage kind, for every sport", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      for (const stageKind of KINDS) {
        expect(validateCascade([module.primaryTableKey, "seed", "lots"], ctxOf(module, stageKind)), `${module.key} ${stageKind}`).toEqual([]);
        checked++;
      }
    });
    expect(checked).toBe(SPORTS * KINDS.length);
  });

  it("X-TB-3 a second call returns the same refusals and leaves the order untouched", () => {
    const order = Object.freeze<TiebreakerKey[]>(["points", "nrr", "set_diff"]);
    const ctx = ctxOf(badminton);
    const once = validateCascade(order, ctx);
    expect(once.length, "premise: the order has faults to return").toBeGreaterThan(0);
    expect(validateCascade(order, ctx)).toEqual(once);
    expect(order).toEqual(["points", "nrr", "set_diff"]);
  });

  it("X-TB-3 OC3 h2h_two may appear twice; any other key twice is refused 'duplicate' at its second index", () => {
    // BWF 16.2.2/16.2.3.1/16.2.4.1: "between two" after each step.
    expect(validateCascade(["wins", "h2h_two", "set_diff", "h2h_two", "point_diff", "h2h_two", "lots"], ctxOf(badminton))).toEqual([]);
    let checked = 0;
    forEachSport(({ module }) => {
      for (const key of KEYS) {
        if (key === "h2h_two") continue;
        // Swiss: the first/last rule is off (OC1), so the repeat is the only shape fault.
        const dup = reasons(validateCascade([key, key], ctxOf(module, "swiss")), "duplicate");
        expect(dup, `${module.key} ${key}`).toEqual([{ index: 1, key, reason: "duplicate" }]);
        checked++;
      }
      expect(reasons(validateCascade(["h2h_two", "h2h_two", "h2h_two"], ctxOf(module, "swiss")), "duplicate")).toEqual([]);
    });
    expect(checked).toBe(SPORTS * (KEYS.length - 1));
  });

  it("X-TB-3 a non-Swiss order must start with primaryTableKey: badminton ['points',…,'lots'] → 'first' (primary is wins)", () => {
    expect(badminton.primaryTableKey, "premise (D11): badminton's primary measure is wins").toBe("wins");
    expect(validateCascade(["points", "set_diff", "lots"], ctxOf(badminton))).toEqual([
      { index: 0, key: "points", reason: "first", need: "wins" },
    ]);
    // The same order where points IS the primary: the right answer differs from a constant "points" or "wins".
    expect(tabletennis.primaryTableKey, "premise (D11): table tennis ranks on points").toBe("points");
    expect(validateCascade(["points", "set_diff", "lots"], ctxOf(tabletennis))).toEqual([]);
    let checked = 0;
    forEachSport(({ module }) => {
      for (const stageKind of NON_SWISS) {
        const wrong = other(module.primaryTableKey);
        expect(validateCascade([wrong, "lots"], ctxOf(module, stageKind)), `${module.key} ${stageKind}`).toEqual([
          { index: 0, key: wrong, reason: "first", need: module.primaryTableKey },
        ]);
        checked++;
      }
    });
    expect(checked).toBe(SPORTS * NON_SWISS.length);
  });

  it("X-TB-3 a non-Swiss order must end with exactly one lots: missing → 'last'", () => {
    expect(validateCascade(["wins", "set_diff"], ctxOf(badminton))).toEqual([
      { index: 1, key: "set_diff", reason: "last", need: "lots" },
    ]);
    // A drawing of lots anywhere but last leaves the steps after it dead: refused there, and the order's own end too.
    expect(sorted(validateCascade(["wins", "lots", "set_diff"], ctxOf(badminton)))).toEqual([
      { index: 1, key: "lots", reason: "last", need: "lots" },
      { index: 2, key: "set_diff", reason: "last", need: "lots" },
    ]);
    // Exactly once: a second drawing is a repeat, and the first one is no longer last.
    expect(sorted(validateCascade(["wins", "lots", "lots"], ctxOf(badminton)))).toEqual([
      { index: 1, key: "lots", reason: "last", need: "lots" },
      { index: 2, key: "lots", reason: "duplicate" },
    ]);
    let checked = 0;
    forEachSport(({ module }) => {
      for (const stageKind of NON_SWISS) {
        expect(validateCascade([module.primaryTableKey], ctxOf(module, stageKind)), `${module.key} ${stageKind}`).toEqual([
          { index: 0, key: module.primaryTableKey, reason: "last", need: "lots" },
        ]);
        checked++;
      }
    });
    expect(checked).toBe(SPORTS * NON_SWISS.length);
  });

  it("X-TB-3 OC1 a Swiss order not starting with the primary or not ending in lots is accepted; nrr in a badminton Swiss order is still refused 'sport'", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      expect(validateCascade([other(module.primaryTableKey), "seed"], ctxOf(module, "swiss")), module.key).toEqual([]);
      checked++;
    });
    expect(checked).toBe(SPORTS);
    // Chess's own Swiss order (W3 owns it): buchholz first after points, wins late, lots last — accepted as it stands.
    expect(validateCascade(boardgame.defaultTiebreakers("swiss", boardgame.configSchema.parse({})), ctxOf(boardgame, "swiss"))).toEqual([]);
    expect(validateCascade(["points", "nrr"], ctxOf(badminton, "swiss"))).toEqual([
      { index: 1, key: "nrr", reason: "sport", need: "runs_for, balls_faced_eff, runs_against, balls_bowled_eff" },
    ]);
  });
});

describe("validateCascade — X-TB-5 what the sport records and what the stage format has (rules 2, 3)", () => {
  it("X-TB-5 nrr outside cricket and board_ratio outside carrom → 'sport' (D10(d), counted over forEachSport)", () => {
    let checked = 0;
    const accepted: string[] = [];
    forEachSport(({ key, module }) => {
      for (const [step, home] of [["nrr", "cricket"], ["board_ratio", "carrom"]] as const) {
        const refused = reasons(validateCascade([module.primaryTableKey, step, "lots"], ctxOf(module)), "sport");
        if (key === home) {
          expect(refused, `${key} ${step}`).toEqual([]);
          accepted.push(`${key}:${step}`);
        } else {
          expect(refused.map((r) => [r.index, r.key]), `${key} ${step}`).toEqual([[1, step]]);
        }
        checked++;
      }
    });
    expect(checked).toBe(SPORTS * 2);
    expect(accepted).toEqual(["cricket:nrr", "carrom:board_ratio"]);
  });

  it("X-TB-5 every metric-backed key needs the ledger its comparator reads, and no other key is ever refused 'sport'", () => {
    let refused = 0;
    let accepted = 0;
    forEachSport(({ module }) => {
      for (const key of KEYS) {
        if (key === "fair_play") continue; // its cfg half is FB-TB-4's
        const got = reasons(validateCascade([key], ctxOf(module, "swiss")), "sport");
        const ledger = LEDGER[key];
        if (ledger !== undefined && !records(module, ledger)) {
          expect(got.map((r) => [r.index, r.key]), `${module.key} ${key}`).toEqual([[0, key]]);
          refused++;
        } else {
          expect(got, `${module.key} ${key}`).toEqual([]);
          accepted++;
        }
      }
    });
    expect(refused + accepted).toBe(SPORTS * (KEYS.length - 1));
    expect(refused).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
    // `need` names the ledger: every alias of a group, then each missing group.
    expect(validateCascade(["diff"], ctxOf(tennis, "swiss"))).toEqual([{ index: 0, key: "diff", reason: "sport", need: "gd or run_diff or diff" }]);
  });

  it("field_goals needs hockey's gf/goals_pc/goals_stroke; refused 'sport' in football", () => {
    expect(validateCascade(["points", "field_goals", "lots"], ctxOf(hockey))).toEqual([]);
    expect(validateCascade(["points", "field_goals", "lots"], ctxOf(football))).toEqual([
      { index: 1, key: "field_goals", reason: "sport", need: "goals_pc, goals_stroke" },
    ]);
    // B3: a field goal is a FIH notion — no other sport records corners and strokes.
    const accepted: string[] = [];
    expect(forEachSport(({ key, module }) => {
      if (reasons(validateCascade([module.primaryTableKey, "field_goals", "lots"], ctxOf(module)), "sport").length === 0) accepted.push(key);
    })).toBe(SPORTS);
    expect(accepted).toEqual(["hockey"]);
  });

  it("X-TB-5 buchholz/buchholz_cut1 outside swiss → 'stage_format'; on any sport's swiss stage → accepted (RB2A-15)", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      for (const stageKind of KINDS) {
        const got = validateCascade([module.primaryTableKey, "buchholz", "buchholz_cut1", "lots"], ctxOf(module, stageKind));
        expect(got, `${module.key} ${stageKind}`).toEqual(
          stageKind === "swiss"
            ? []
            : [
                { index: 1, key: "buchholz", reason: "stage_format", need: "swiss" },
                { index: 2, key: "buchholz_cut1", reason: "stage_format", need: "swiss" },
              ],
        );
        checked++;
      }
    });
    expect(checked).toBe(SPORTS * KINDS.length);
  });

  it("X-TB-5 sberger and direct are accepted on a round-robin stage (SPEC §5.5 rule 3)", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      for (const stageKind of KINDS) {
        expect(validateCascade([module.primaryTableKey, "sberger", "direct", "lots"], ctxOf(module, stageKind)), `${module.key} ${stageKind}`).toEqual([]);
        checked++;
      }
    });
    expect(checked).toBe(SPORTS * KINDS.length);
  });

  it("FB-TB-4 fair_play: football with fairPlay true accepted; fairPlay false → 'fair_play_off'; hockey → 'sport' (D8)", () => {
    const fifa = football.defaultTiebreakers("league", football.configSchema.parse({}));
    const at = fifa.indexOf("fair_play");
    expect(at, "premise: football's default order holds fair_play").toBeGreaterThan(0);
    const on = football.configSchema.parse({ fairPlay: true });
    const off = football.configSchema.parse({ fairPlay: false });
    expect(validateCascade(fifa, { ...ctxOf(football), cfg: on })).toEqual([]);
    expect(validateCascade(fifa, { ...ctxOf(football), cfg: off })).toEqual([
      { index: at, key: "fair_play", reason: "fair_play_off", need: "fairPlay" },
    ]);
    // A stored partial cfg reads the schema's declared default (football tracks fair play unless told not to).
    expect((football.configSchema.parse({}) as { fairPlay: unknown }).fairPlay, "premise: the schema defaults fairPlay on").toBe(true);
    expect(validateCascade(fifa, { ...ctxOf(football), cfg: {} })).toEqual([]);
    expect(reasons(validateCascade(fifa, { ...ctxOf(football), cfg: { fairPlay: false } }), "fair_play_off")).toHaveLength(1);
    // A cfg the schema refuses is read as given — D8's literal `cfg.fairPlay === true`: a cfg that is no object tracks no
    // fair play, and reading it never throws; one that carries `fairPlay: true` beside a bad field still tracks it.
    for (const raw of [undefined, null, 42, "x"]) {
      expect(football.configSchema.safeParse(raw).success, `premise: the schema refuses ${String(raw)}`).toBe(false);
      expect(validateCascade(fifa, { ...ctxOf(football), cfg: raw }), String(raw)).toEqual([
        { index: at, key: "fair_play", reason: "fair_play_off", need: "fairPlay" },
      ]);
    }
    const unparsed = { fairPlay: true, points: 7 };
    expect(football.configSchema.safeParse(unparsed).success, "premise: the schema refuses a non-object points").toBe(false);
    expect(validateCascade(fifa, { ...ctxOf(football), cfg: unparsed })).toEqual([]);
    expect(validateCascade(["points", "fair_play", "lots"], ctxOf(hockey))).toEqual([
      { index: 1, key: "fair_play", reason: "sport", need: "fair_play" },
    ]);
    // D8: offered ONLY in football — every other sport refuses it as a step it does not record.
    let checked = 0;
    forEachSport(({ key, module }) => {
      const got = validateCascade([module.primaryTableKey, "fair_play", "lots"], ctxOf(module));
      expect(got, key).toEqual(key === "football" ? [] : [{ index: 1, key: "fair_play", reason: "sport", need: "fair_play" }]);
      checked++;
    });
    expect(checked).toBe(SPORTS);
  });
});

describe("validateCascade — X-TB-7 cross-group (rule 4) and the modifier position (rule 5)", () => {
  it("X-TB-7 crossGroup:true refuses every h2h key, h2h_two, direct and the modifiers → 'cross_group'", () => {
    expect(KEYS.filter(headToHead), "premise: the spec's head-to-head list").toEqual([
      "h2h_points", "h2h_diff", "h2h_for", "direct", "h2h_two", "h2h_wins", "h2h_set_ratio", "h2h_point_ratio", "h2h_reapply", "h2h_exclusion",
    ]);
    let refused = 0;
    let checked = 0;
    forEachSport(({ module }) => {
      for (const key of KEYS) {
        const across = reasons(validateCascade([key], ctxOf(module, "swiss", { crossGroup: true })), "cross_group");
        expect(across, `${module.key} ${key}`).toEqual(headToHead(key) ? [{ index: 0, key, reason: "cross_group" }] : []);
        if (headToHead(key)) refused++;
        // The positive pair: within one group, head-to-head is what the step is for.
        expect(reasons(validateCascade([key], ctxOf(module, "swiss")), "cross_group"), `${module.key} ${key}`).toEqual([]);
        checked++;
      }
    });
    expect(checked).toBe(SPORTS * KEYS.length);
    expect(refused).toBe(SPORTS * 10);
  });

  it("h2h_reapply/h2h_exclusion not directly after an h2h block, or two in one block → 'position'", () => {
    const fb = ctxOf(football);
    // UEFA 20.01(d): the block, then its re-application.
    expect(validateCascade(["points", "h2h_points", "h2h_diff", "h2h_for", "h2h_reapply", "diff", "for", "lots"], fb)).toEqual([]);
    // Two blocks, one modifier each.
    expect(validateCascade(["points", "h2h_points", "h2h_reapply", "diff", "h2h_diff", "h2h_exclusion", "lots"], fb)).toEqual([]);
    expect(validateCascade(["points", "h2h_reapply", "h2h_points", "lots"], fb)).toEqual([{ index: 1, key: "h2h_reapply", reason: "position" }]);
    expect(validateCascade(["points", "diff", "h2h_exclusion", "lots"], fb)).toEqual([{ index: 2, key: "h2h_exclusion", reason: "position" }]);
    // Two in one block.
    expect(validateCascade(["points", "h2h_points", "h2h_reapply", "h2h_exclusion", "lots"], fb)).toEqual([
      { index: 3, key: "h2h_exclusion", reason: "position" },
    ]);
    // h2h_two and direct are steps of their own, not a mini-table block.
    expect(validateCascade(["points", "h2h_two", "h2h_reapply", "lots"], fb)).toEqual([{ index: 2, key: "h2h_reapply", reason: "position" }]);
    expect(validateCascade(["points", "direct", "h2h_exclusion", "lots"], fb)).toEqual([{ index: 2, key: "h2h_exclusion", reason: "position" }]);
    // At the very start there is no block before it (Swiss, so position is the only fault).
    expect(validateCascade(["h2h_exclusion", "points"], ctxOf(football, "swiss"))).toEqual([{ index: 0, key: "h2h_exclusion", reason: "position" }]);
    // Every mini-table key opens a block a modifier may close, for every sport.
    let checked = 0;
    forEachSport(({ module }) => {
      for (const block of BLOCK_KEYS) {
        for (const modifier of MODIFIERS) {
          expect(reasons(validateCascade([block, modifier], ctxOf(module, "swiss")), "position"), `${module.key} ${block} ${modifier}`).toEqual([]);
          checked++;
        }
      }
    });
    expect(checked).toBe(SPORTS * BLOCK_KEYS.length * MODIFIERS.length);
  });

  it("rule 5 agrees with the ranker: an order refused on position throws in rankStandings, and one accepted on it parses there (fast-check, counted)", () => {
    // `rankStandings([], …)` parses the order (the ranker's `parseCascade`) before it ranks anything, so zero rows is the
    // parse alone: what this holds the two to is the rule both enforce, not a ranking.
    let refused = 0;
    let accepted = 0;
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...KEYS), { minLength: 1, maxLength: 8 }), (cascade) => {
        const position = reasons(validateCascade(cascade, ctxOf(football, "swiss")), "position").length > 0;
        let threw: unknown = null;
        try {
          rankStandings([], { cascade });
        } catch (e) {
          threw = e;
        }
        if (position) {
          expect(EngineError.is(threw, "CONFIG_INVALID"), cascade.join(",")).toBe(true);
          refused++;
        } else {
          expect(threw, cascade.join(",")).toBeNull();
          accepted++;
        }
      }),
      { seed: 20261025, numRuns: 600 },
    );
    expect(refused).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
  });
});

describe("validateCascade — every refusal, primaryTableKey, and the guards", () => {
  it("every refusal is returned, not just the first (an order with three faults returns three)", () => {
    expect(sorted(validateCascade(["points", "nrr", "set_diff"], ctxOf(badminton)))).toEqual([
      { index: 0, key: "points", reason: "first", need: "wins" },
      { index: 1, key: "nrr", reason: "sport", need: "runs_for, balls_faced_eff, runs_against, balls_bowled_eff" },
      { index: 2, key: "set_diff", reason: "last", need: "lots" },
    ]);
    // Another sport, the same order: cricket ranks on points and records the NRR ledger, but keeps no sets.
    expect(sorted(validateCascade(["points", "nrr", "set_diff"], ctxOf(cricket)))).toEqual([
      { index: 2, key: "set_diff", reason: "last", need: "lots" },
      { index: 2, key: "set_diff", reason: "sport", need: "sets_won, sets_lost" },
    ]);
    // One step, two faults: a set-ratio mini-table across groups in a sport that keeps no sets.
    expect(sorted(validateCascade(["points", "h2h_set_ratio", "lots"], ctxOf(football, "league", { crossGroup: true })))).toEqual([
      { index: 1, key: "h2h_set_ratio", reason: "cross_group" },
      { index: 1, key: "h2h_set_ratio", reason: "sport", need: "sets_won, sets_lost" },
    ]);
  });

  it("refusals come in the spec's rule order (§5.5 1 → 5), each rule's by index — not one list sorted by step", () => {
    // Unsorted on purpose (every other case here compares `sorted`): badminton's three faults are rule 1's `first` (step 1)
    // and `last` (step 3), then rule 2's `sport` (step 2).
    expect(validateCascade(["points", "nrr", "set_diff"], ctxOf(badminton)).map((r) => [r.reason, r.index])).toEqual([
      ["first", 0],
      ["last", 2],
      ["sport", 1],
    ]);
    // Within one rule, by index: two ledgers badminton does not keep, then the order's closing lots is fine.
    expect(validateCascade(["wins", "nrr", "board_ratio", "lots"], ctxOf(badminton)).map((r) => [r.reason, r.index])).toEqual([
      ["sport", 1],
      ["sport", 2],
    ]);
    // All five rules on one league order across groups, in turn: the shape (1), two ledgers (2), Buchholz outside Swiss (3),
    // a modifier compared across groups (4) that follows no h2h block (5).
    expect(
      validateCascade(["nrr", "buchholz", "diff", "h2h_reapply"], ctxOf(badminton, "league", { crossGroup: true })).map((r) => [r.reason, r.index]),
    ).toEqual([
      ["first", 0],
      ["last", 3],
      ["sport", 0],
      ["sport", 2],
      ["stage_format", 1],
      ["cross_group", 3],
      ["position", 3],
    ]);
  });

  it("X-TB-3 D11 primaryTableKey is wins for volleyball, badminton and tennis, and points for every other sport (forEachSport, counted)", () => {
    const wins: string[] = [];
    expect(forEachSport(({ key, module }) => {
      expect(["points", "wins"], key).toContain(module.primaryTableKey);
      if (module.primaryTableKey === "wins") wins.push(key);
    })).toBe(SPORTS);
    expect(wins.sort()).toEqual(["badminton", "tennis", "volleyball"]);
  });

  it("rule 6: an unknown key is refused by name (CONFIG_INVALID) — the zod enum is the gate, so one reaching here is a caller's breach", () => {
    const unknown = "sp_pc_scored" as TiebreakerKey;
    // [order, the offending key, its index, the step number a person reads (1-based)]
    const cases: [TiebreakerKey[], string, number, number][] = [
      [[unknown], "sp_pc_scored", 0, 1],
      [["points", unknown, "lots"], "sp_pc_scored", 1, 2],
      [["points", "lots", "toString" as TiebreakerKey], "toString", 2, 3],
    ];
    for (const [cascade, key, index, step] of cases) {
      let threw: unknown = null;
      try {
        validateCascade(cascade, ctxOf(hockey));
      } catch (e) {
        threw = e;
      }
      expect(EngineError.is(threw, "CONFIG_INVALID"), cascade.join(",")).toBe(true);
      expect((threw as EngineError).message).toContain(`"${key}" at position ${step} is not a tie-break key`);
      expect((threw as EngineError).data).toEqual({ key, index });
    }
  });
});

/** The refusals inserting a key at `position` ADDS: those of the new order that the old order's refusals, moved past the
 *  inserted step, do not already account for. The spec's identity, computed here from `validateCascade` alone. */
// The oracle compares whole refusals, `need` included. offerableKeys leaves `need` out of a refusal's identity on the
// premise that, in one ctx, it is fixed by the key and the reason; `needs` (one per ctx) holds that premise over every
// refusal the sweep sees.
interface NeedLedger { readonly byKeyReason: Map<string, string | null>; readonly conflicts: string[]; checked: number }
function addedBy(
  cascade: readonly TiebreakerKey[],
  position: number,
  ctx: CascadeContext,
  needs: NeedLedger,
): (key: TiebreakerKey) => CascadeRefusal[] {
  const id = (r: CascadeRefusal, index: number): string => JSON.stringify([index, r.key, r.reason, r.need ?? null]);
  const hold = (r: CascadeRefusal): void => {
    const at = JSON.stringify([r.key, r.reason]);
    const need = r.need ?? null;
    if (!needs.byKeyReason.has(at)) needs.byKeyReason.set(at, need);
    else if (needs.byKeyReason.get(at) !== need) needs.conflicts.push(`${at}: ${String(needs.byKeyReason.get(at))} vs ${String(need)}`);
    needs.checked++;
  };
  const old = validateCascade(cascade, ctx);
  old.forEach(hold);
  const before = new Set(old.map((r) => id(r, r.index >= position ? r.index + 1 : r.index)));
  return (key) => {
    const now = validateCascade([...cascade.slice(0, position), key, ...cascade.slice(position)], ctx);
    now.forEach(hold);
    return now.filter((r) => !before.has(id(r, r.index)));
  };
}

describe("offerableKeys — '+ Add step' (spec §9)", () => {
  it("premise: this file's vocabulary is in TiebreakerKey's own order, read from the union's declaration in module.ts", () => {
    // Layout-free: a Stryker sandbox reprints module.ts with the union on one line (a comment splitting it), so the
    // declaration is isolated (`export type TiebreakerKey =` to its `;`), its comments dropped, and every quoted member
    // read wherever it sits.
    const source = readFileSync(new URL("../sport/module.ts", import.meta.url), "utf8");
    const head = /export\s+type\s+TiebreakerKey\s*=/.exec(source);
    expect(head, "module.ts declares TiebreakerKey").not.toBeNull();
    const start = head?.index ?? 0;
    const end = source.indexOf(";", start);
    expect(end, "the declaration ends").toBeGreaterThan(start);
    const declaration = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const declared = [...declaration.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(declared.length, "anti-vacuity: the union's members were read").toBe(KEYS.length);
    expect(KEYS).toEqual(declared);
  });

  it("offerableKeys complement: it offers exactly the keys whose insertion adds no refusal, in TiebreakerKey's own order (forEachSport × stage kind, counted)", () => {
    let cells = 0;
    let offered = 0;
    let hidden = 0;
    let ordered = 0;
    const conflicts: string[] = [];
    let needsChecked = 0;
    forEachSport(({ module }) => {
      const cfgs: unknown[] = [firstCfg(module)];
      if (module.key === "football") cfgs.push(football.configSchema.parse({ fairPlay: false }));
      // The empty order, the minimal valid one, one with an h2h block, and the sport's two defaults as they stand: the
      // league one (signed and shape-valid since Task 11) and the Swiss one, which keeps its pre-W2d order (OC1) and so is,
      // for most sports, an INVALID order under every non-Swiss kind — one the editor can still be asked to extend.
      const orders: TiebreakerKey[][] = [
        [],
        [module.primaryTableKey, "lots"],
        [module.primaryTableKey, "h2h_points", "h2h_reapply", "seed", "lots"],
        [...module.defaultTiebreakers("league", firstCfg(module))],
        [...module.defaultTiebreakers("swiss", firstCfg(module))],
      ];
      for (const stageKind of KINDS) {
        for (const crossGroup of [false, true]) {
          for (const cfg of cfgs) {
            const ctx: CascadeContext = { module, cfg, stageKind, crossGroup };
            const needs: NeedLedger = { byKeyReason: new Map(), conflicts, checked: 0 };
            for (const order of orders) {
              for (let position = 0; position <= order.length; position++) {
                const offers = offerableKeys(order, position, ctx);
                expect(new Set(offers).size, "no key offered twice").toBe(offers.length);
                // The editor lists "+ Add step" in the order this returns: TiebreakerKey's own (the premise test above).
                expect(offers, "offered in TiebreakerKey's own order").toEqual(KEYS.filter((key) => offers.includes(key)));
                if (offers.length >= 2) ordered++;
                const added = addedBy(order, position, ctx, needs);
                for (const key of KEYS) {
                  const adds = added(key);
                  expect(offers.includes(key), `${module.key} ${stageKind} x${String(crossGroup)} [${order.join(",")}] @${position} ${key}`).toBe(adds.length === 0);
                  if (adds.length === 0) offered++;
                  else hidden++;
                }
                cells++;
              }
            }
            needsChecked += needs.checked;
          }
        }
      }
    });
    expect(cells).toBeGreaterThan(SPORTS * KINDS.length * 2 * 4);
    expect(offered).toBeGreaterThan(0);
    expect(hidden).toBeGreaterThan(0);
    // anti-vacuity for the order check: one key offered cannot be out of order.
    expect(ordered).toBeGreaterThan(0);
    // The premise offerableKeys's refusal identity rests on (cascade-rules.ts `refusalId`), over every refusal seen.
    expect(conflicts).toEqual([]);
    expect(needsChecked).toBeGreaterThan(cells);
    // ~3,800 cells × 29 keys, each a validateCascade call; a loaded runner is several times slower than an idle one.
  }, 60_000);

  it("§9 between the pinned rows: never the primary or lots again, modifiers only directly after an h2h step, no head-to-head across groups (non-Swiss, counted)", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      const order: TiebreakerKey[] = [module.primaryTableKey, "h2h_points", "lots"];
      for (const stageKind of NON_SWISS) {
        for (const crossGroup of [false, true]) {
          const ctx = ctxOf(module, stageKind, { crossGroup });
          // Before the pinned first row and after the pinned last one, nothing fits.
          expect(offerableKeys(order, 0, ctx), `${module.key} @0`).toEqual([]);
          expect(offerableKeys(order, order.length, ctx), `${module.key} @end`).toEqual([]);
          for (let position = 1; position < order.length; position++) {
            const offers = offerableKeys(order, position, ctx);
            expect(offers, `${module.key} @${position}`).not.toContain(module.primaryTableKey);
            expect(offers, `${module.key} @${position}`).not.toContain("lots");
            const afterBlock = BLOCK_KEYS.includes(order[position - 1] as TiebreakerKey);
            for (const modifier of MODIFIERS) expect(offers.includes(modifier), `${module.key} @${position} ${modifier}`).toBe(afterBlock && !crossGroup);
            if (crossGroup) expect(offers.filter(headToHead), `${module.key} @${position}`).toEqual([]);
            expect(offers, `${module.key} @${position}`).toContain("seed");
            checked++;
          }
        }
      }
    });
    expect(checked).toBe(SPORTS * NON_SWISS.length * 2 * 2);
  }, 60_000);

  it("offerableKeys on another sport: badminton's sets steps are offered and football's goals steps are not, at the same position", () => {
    const bd = offerableKeys(["wins", "lots"], 1, ctxOf(badminton));
    const fb = offerableKeys(["points", "lots"], 1, ctxOf(football));
    for (const key of ["set_diff", "point_diff", "set_ratio", "h2h_two"] as const) expect(bd, key).toContain(key);
    for (const key of ["diff", "for", "fair_play", "field_goals", "nrr"] as const) expect(bd, key).not.toContain(key);
    for (const key of ["diff", "for", "fair_play", "h2h_points"] as const) expect(fb, key).toContain(key);
    for (const key of ["set_diff", "point_diff", "field_goals", "nrr", "buchholz"] as const) expect(fb, key).not.toContain(key);
  });

  it("offerableKeys refuses a position outside the order (CONFIG_INVALID)", () => {
    for (const position of [-1, 3, 1.5, Number.NaN]) {
      let threw: unknown = null;
      try {
        offerableKeys(["points", "lots"], position, ctxOf(football));
      } catch (e) {
        threw = e;
      }
      expect(EngineError.is(threw, "CONFIG_INVALID"), String(position)).toBe(true);
      expect((threw as EngineError).message).toMatch(/outside the order \(0\.\.2\)/);
      expect((threw as EngineError).data, String(position)).toEqual({ position });
    }
    expect(offerableKeys(["points", "lots"], 2, ctxOf(football))).toEqual([]);
  });
});
