// health.test.ts — D3 schedule health arithmetic (design doc
// docs/superpowers/specs/bench-product-value/designs/2026-08-13-schedule-health-design.md,
// "Metric formulas" section, implemented verbatim). Every expected number
// below is derived independently from the formula text (by hand, cross-
// checked with a standalone node script — never by calling assessHealth and
// trusting its own output), and every board uses UNEQUAL entrant/court/day
// counts on purpose (the symmetric-fixture trap: a bug that averages across
// entrants, or hardcodes "2 courts", can hide on a board where every
// dimension happens to divide evenly).
import { describe, expect, it } from "vitest";
import { assessHealth, PRIME_N, COURT_BALANCE_MIN_FIXTURES, HOME_AWAY_RUN_THRESHOLD, type HealthFixture, type HealthConfig } from "./health.ts";

const MS_PER_MIN = 60_000;
const DAY = "2026-10-19";
const RR: HealthConfig = { isRoundRobin: true };
const BRACKET: HealthConfig = { isRoundRobin: false };

function fx(
  fixtureId: string,
  home: string | undefined,
  away: string | undefined,
  startMin: number,
  durMin: number,
  opts: { court?: string; dayKey?: string; roundNo?: number } = {},
): HealthFixture {
  return {
    fixtureId,
    court: opts.court ?? "Court 1",
    start: startMin * MS_PER_MIN,
    end: (startMin + durMin) * MS_PER_MIN,
    dayKey: opts.dayKey ?? DAY,
    ...(home !== undefined ? { home } : {}),
    ...(away !== undefined ? { away } : {}),
    ...(opts.roundNo !== undefined ? { roundNo: opts.roundNo } : {}),
  };
}

function metric(report: ReturnType<typeof assessHealth>, key: string) {
  return report.metrics.find((m) => m.key === key);
}

describe("assessHealth — restSpread", () => {
  it("scores an asymmetric board (entrant A: 3 fixtures, entrant B: 2 fixtures) via each entrant's OWN achievable-ideal gap", () => {
    // A: gaps [120, 60] min vs its own ideal (mean) of 90 -> p_A = 1/6.
    // B: gap [40] min vs its own ideal of 40 (a single gap is ALWAYS its own
    // mean) -> p_B = 0. meanP = 1/12 -> score = round(100*(1-1/12)) = 92.
    // Independently verified via node -e before writing this assertion.
    const fixtures: HealthFixture[] = [
      fx("f1", "A", "P1", 0, 60),
      fx("f2", "A", "P2", 180, 60),
      fx("f3", "A", "P3", 300, 60),
      fx("f4", "B", "P4", 0, 60, { court: "Court 2" }),
      fx("f5", "B", "P5", 100, 60, { court: "Court 2" }),
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "restSpread")!;
    expect(m.score).toBe(92);
    expect(m.explanation.key).toBe("schedule.health.explain.restSpread");
    // bottom-3 by p_e, worst first: A (p=1/6) before B (p=0). Only 2 eligible
    // entrants (P1..P5 each appear once, excluded — |F_e|<2).
    expect(m.offenders).toEqual([
      { kind: "entrant", id: "A", label: "A", value: 60 },
      { kind: "entrant", id: "B", label: "B", value: 40 },
    ]);
  });

  it("an entrant with EXACTLY 2 fixtures always scores p_e=0, however tight the single gap — the 'ideal' IS that one gap by construction", () => {
    const fixtures: HealthFixture[] = [
      fx("g1", "T", "Q1", 0, 60),
      fx("g2", "T", "Q2", 61, 60), // gap = 1 minute, extremely tight
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "restSpread")!;
    expect(m.score).toBe(100);
    expect(m.offenders).toEqual([{ kind: "entrant", id: "T", label: "T", value: 1 }]);
  });

  it("adversarial board: 3 near-zero gaps then one long one scores well below the asymmetric board above (0.667 mean penalty -> 33)", () => {
    // D: gaps [0, 0, 240] -> ideal (mean) = 80. p = (1 + 1 + 0)/3 = 2/3.
    // score = round(100*(1-2/3)) = 33. Verified independently via node -e.
    const fixtures: HealthFixture[] = [
      fx("d1", "D", "R1", 0, 60),
      fx("d2", "D", "R2", 60, 60), // gap 0
      fx("d3", "D", "R3", 120, 60), // gap 0
      fx("d4", "D", "R4", 420, 60), // gap 240
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "restSpread")!;
    expect(m.score).toBe(33);
    expect(m.offenders[0]).toEqual({ kind: "entrant", id: "D", label: "D", value: 0 });
  });

  it("an entrant with only 1 fixture is excluded entirely — never divides by zero, never appears as an offender", () => {
    const fixtures: HealthFixture[] = [fx("s1", "SOLO", "OPP", 0, 60)];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "restSpread")!;
    // Nothing eligible -> "nothing to penalise" default, same convention
    // every metric below uses for an empty eligible set.
    expect(m.score).toBe(100);
    expect(m.offenders).toEqual([]);
  });
});
