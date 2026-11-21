// W5 B4 (stress F8; owner 2026-11-21, per-format max entrants): the most entrants each format can START inside the measured
// line budget. Expected values come from the REAL generator Start runs (`generate`, usecases/stages/generators.ts: the engine's
// round robin per seeded pool, its single- and double-elimination and stepladder brackets) and, for a Swiss, the rulebook's shell
// count (W3 §4: every round at once, ceil(n/2) lines a round - the boards and, on an odd field, the bye shell). Never the
// module's own count.
import { describe, expect, it } from "vitest";
import { generate } from "@/server/usecases/stages/generators";
import type { ActiveEntrant } from "@/server/usecases/stages/types";
import { formatMaxEntrants, formatMaxGate, START_LINE_BUDGET, type FormatStage } from "@/lib/format-max-entrants";
import { swissRoundsDefault } from "@/lib/swiss-rounds";
import { buildTemplateStages, STAGE_TEMPLATES } from "@/lib/format-templates";
import { openingKnobs } from "@/lib/division-builder/model";

const field = (n: number): ActiveEntrant[] => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, seed: null, swiss_first_round: null }));

/** The lines Start draws for `stage` over `n`: the server's own generator, or the rulebook's Swiss shell count. */
function drawn(stage: FormatStage, n: number): number {
  const cfg = (stage.config ?? {}) as Record<string, unknown>;
  if (stage.kind === "swiss") {
    const rounds = typeof cfg.rounds === "number" ? cfg.rounds : swissRoundsDefault(n);
    return rounds * Math.ceil(n / 2);
  }
  return generate(stage.kind, cfg, field(n), new Map()).length;
}

/** Every format whose Start draw grows with its field, at the shapes the builder sends and the knobs at their bounds. */
const GROWING: [string, FormatStage][] = [
  ["league", { kind: "league", config: { legs: 1 } }],
  ["double league", { kind: "league", config: { legs: 2 } }],
  ["groups of 2 pools", { kind: "group", config: { pools: { count: 2 } } }],
  ["groups of 4 pools", { kind: "group", config: { pools: { count: 4 } } }],
  ["groups of 8 pools", { kind: "group", config: { pools: { count: 8 } } }],
  ["swiss at the field's default rounds", { kind: "swiss", config: {} }],
  ["swiss of 7 rounds", { kind: "swiss", config: { rounds: 7 } }],
  ["swiss of 15 rounds", { kind: "swiss", config: { rounds: 15 } }],
  ["knockout", { kind: "knockout", config: {} }],
  ["knockout with a third-place match", { kind: "knockout", config: { thirdPlace: true } }],
  ["double elimination", { kind: "double_elim", config: {} }],
  ["double elimination with a bracket reset", { kind: "double_elim", config: { bracketReset: true } }],
  ["stepladder", { kind: "stepladder", config: {} }],
];

describe("formatMaxEntrants: the largest field each format starts inside the line budget", () => {
  it.each(GROWING)("%s: the real draw at the max fits the budget, and one entrant more does not", (_label, stage) => {
    const max = formatMaxEntrants(stage);
    expect(max, "a format whose draw grows with its field has a max").not.toBeNull();
    expect(drawn(stage, max!), `the draw of ${max}`).toBeLessThanOrEqual(START_LINE_BUDGET);
    expect(drawn(stage, max! + 1), `the draw of ${max! + 1}`).toBeGreaterThan(START_LINE_BUDGET);
  });

  it("a field that lands EXACTLY on the budget is admitted (the boundary is inclusive)", () => {
    // Four pools of 50, 50, 50, 52 draw 3 x 1,225 + 1,326 = 5,001; of 50, 50, 51, 51 draw 2 x 1,225 + 2 x 1,275 = 5,000. The
    // case the right answer differs from an exclusive bound's.
    const stage = { kind: "group", config: { pools: { count: 4 } } };
    const atBudget = Array.from({ length: 400 }, (_, i) => i + 8).filter((n) => drawn(stage, n) === START_LINE_BUDGET);
    expect(atBudget.length, "a field whose draw is exactly the budget exists for this shape").toBeGreaterThan(0);
    expect(formatMaxEntrants(stage)).toBe(Math.max(...atBudget));
  });

  it("every field from 8 up to each round-robin and Swiss max fits, and every bracket field at and around each power of two", () => {
    let checked = 0;
    for (const [label, stage] of GROWING) {
      const max = formatMaxEntrants(stage)!;
      const fields =
        stage.kind === "league" || stage.kind === "group" || stage.kind === "swiss"
          ? Array.from({ length: max - 7 }, (_, i) => i + 8)
          : Array.from({ length: 13 }, (_, k) => 2 ** (k + 3)).flatMap((p) => [p - 1, p, p + 1]).filter((n) => n >= 8 && n <= max);
      for (const n of fields) {
        expect(drawn(stage, n), `${label} of ${n}`).toBeLessThanOrEqual(START_LINE_BUDGET);
        checked++;
      }
    }
    // Anti-vacuity: the walk read real draws, thousands of them.
    expect(checked).toBeGreaterThan(3_000);
  });

  it("a Swiss whose stored rounds overrun the budget even at the smallest probe answers, never throws (the door takes any count >= 1)", () => {
    // The stage door bounds a Swiss's rounds from below only (schemas/stages.ts), so a stored count can draw past the budget at
    // any field. The max is still the largest field that fits, by the rulebook's count, down to a field that fits none (0).
    let checked = 0;
    for (const rounds of [700, 1_250, 2_500, 2_501, 5_000, 5_001, 1_000_000]) {
      const stage = { kind: "swiss", config: { rounds } };
      const fits = Array.from({ length: 16 }, (_, i) => i).filter((n) => drawn(stage, n) <= START_LINE_BUDGET);
      expect(formatMaxEntrants(stage), `rounds ${rounds}`).toBe(Math.max(...fits));
      checked++;
    }
    expect(checked).toBe(7);
    expect(formatMaxEntrants({ kind: "swiss", config: { rounds: 5_001 } }), "a count no field of one or more fits").toBe(0);
  });

  it("a kind whose Start draw does not grow with its field has no max: americano, a ladder, a page playoff", () => {
    expect(formatMaxEntrants({ kind: "americano", config: { mode: "americano", courtCount: 2, rounds: 7 } })).toBeNull();
    expect(formatMaxEntrants({ kind: "americano", config: { mode: "mexicano", courtCount: 2, rounds: 7 } })).toBeNull();
    expect(formatMaxEntrants({ kind: "ladder", config: { challengeRange: 3 } })).toBeNull();
    expect(formatMaxEntrants({ kind: "page_playoff", config: {} })).toBeNull();
  });
});

describe("every template's first stage, at the builder's opening knobs", () => {
  // americano and mexicano draw their config's courts x rounds, a ladder draws nothing at Start: their draws are held to the
  // budget by the server's exact count (DRAW_TOO_LARGE, usecases/stages/generate-tx.ts), not by a field.
  const NO_FIELD_MAX = ["americano", "mexicano", "ladder"];

  it("has a max wherever its draw grows with the field, and that max is the real draw's", () => {
    let checked = 0;
    for (const t of STAGE_TEMPLATES) {
      const first = buildTemplateStages(t.key, openingKnobs(16))[0]!;
      const max = formatMaxEntrants(first);
      if (NO_FIELD_MAX.includes(t.key)) {
        expect(max, t.key).toBeNull();
        continue;
      }
      expect(max, t.key).not.toBeNull();
      expect(drawn(first, max!), `${t.key} at ${max}`).toBeLessThanOrEqual(START_LINE_BUDGET);
      expect(drawn(first, max! + 1), `${t.key} at ${max! + 1}`).toBeGreaterThan(START_LINE_BUDGET);
      checked++;
    }
    // The exclusion is pinned by size, so a new template cannot slip into it unseen.
    expect(STAGE_TEMPLATES.filter((t) => NO_FIELD_MAX.includes(t.key))).toHaveLength(NO_FIELD_MAX.length);
    expect(checked).toBe(STAGE_TEMPLATES.length - NO_FIELD_MAX.length);
  });
});

describe("formatMaxGate: a division's field against its FIRST stage's max", () => {
  const league = { kind: "league", config: { legs: 1 } };
  const knockout = { kind: "knockout", config: {} };

  it("no stages: no format, nothing to refuse", () => {
    expect(formatMaxGate([], 1_000_000)).toBeNull();
  });

  it("at the max: allowed; one over: refused with the max and the field", () => {
    const max = formatMaxEntrants(league)!;
    expect(formatMaxGate([league], max)).toBeNull();
    expect(formatMaxGate([league], max + 1)).toEqual({ max, entrants: max + 1 });
  });

  it("only the first stage is drawn at Start: a knockout after a league is judged as the league, a league after a knockout as the knockout", () => {
    const leagueMax = formatMaxEntrants(league)!;
    expect(formatMaxGate([league, knockout], leagueMax + 1)).toEqual({ max: leagueMax, entrants: leagueMax + 1 });
    expect(formatMaxGate([knockout, league], leagueMax + 1)).toBeNull();
  });

  it("a first stage with no field max refuses no field", () => {
    expect(formatMaxGate([{ kind: "ladder", config: {} }], 100_000)).toBeNull();
  });
});
