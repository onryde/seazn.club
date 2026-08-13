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

describe("assessHealth — courtBalance", () => {
  it("scores 3 asymmetric entrants (3, 3 and 4 fixtures) by Shannon entropy of their own court distribution vs uniform", () => {
    // A: 3 fixtures, 1 per court (3 courts total) -> H/Hmax = 1 (perfect).
    // B: 3 fixtures, all on Court 1 -> H = 0 (pinned) -> ratio 0 (worst).
    // E: 4 fixtures split 2/2 across 2 of the 3 courts -> ratio = ln(2)/ln(3).
    // mean = (1 + 0 + ln(2)/ln(3))/3 -> score 54. Verified via node -e.
    expect(COURT_BALANCE_MIN_FIXTURES).toBe(3);
    const fixtures: HealthFixture[] = [
      fx("a1", "A", "X1", 0, 60, { court: "Court 1" }),
      fx("a2", "A", "X2", 100, 60, { court: "Court 2" }),
      fx("a3", "A", "X3", 200, 60, { court: "Court 3" }),
      fx("b1", "B", "X4", 0, 60, { court: "Court 1" }),
      fx("b2", "B", "X5", 100, 60, { court: "Court 1" }),
      fx("b3", "B", "X6", 200, 60, { court: "Court 1" }),
      fx("e1", "E", "X7", 0, 60, { court: "Court 1" }),
      fx("e2", "E", "X8", 100, 60, { court: "Court 1" }),
      fx("e3", "E", "X9", 200, 60, { court: "Court 2" }),
      fx("e4", "E", "X10", 300, 60, { court: "Court 2" }),
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "courtBalance")!;
    expect(m.score).toBe(54);
    // Bottom-3 by ratio ascending (worst/most-pinned first). value = distinct
    // courts used. All 3 eligible entrants appear (exactly 3 qualify).
    expect(m.offenders).toEqual([
      { kind: "entrant", id: "B", label: "B", value: 1 },
      { kind: "entrant", id: "E", label: "E", value: 2 },
      { kind: "entrant", id: "A", label: "A", value: 3 },
    ]);
  });

  it("an entrant with only 2 fixtures is excluded (below C_min) regardless of how pinned they are", () => {
    const fixtures: HealthFixture[] = [
      fx("p1", "PIN", "Y1", 0, 60, { court: "Court 1" }),
      fx("p2", "PIN", "Y2", 100, 60, { court: "Court 1" }),
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "courtBalance")!;
    expect(m.score).toBe(100); // nothing eligible -> nothing to penalise
    expect(m.offenders).toEqual([]);
  });

  it("a single-court board cannot penalise anyone for using it exclusively (Hmax=0 guard, not NaN)", () => {
    const fixtures: HealthFixture[] = [
      fx("o1", "ONLY", "Z1", 0, 60, { court: "Court 1" }),
      fx("o2", "ONLY", "Z2", 100, 60, { court: "Court 1" }),
      fx("o3", "ONLY", "Z3", 200, 60, { court: "Court 1" }),
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "courtBalance")!;
    expect(m.score).toBe(100);
    expect(Number.isNaN(m.score)).toBe(false);
  });
});

describe("assessHealth — gapDispersion", () => {
  it("scores 2 asymmetric court-days (3 fixtures with gaps vs 2 back-to-back) via idle_inside / (idle_inside + idle_edges)", () => {
    // Court 1 day: fixtures at [0-60],[120-180],[300-360] inside a
    // configured [0,400] window. idle_inside = 60+120 = 180. idle_edges =
    // (400-180 busy) - 180 = 40 (0 before first, 40 after last). f=180/220.
    // Court 2 day: [0-60],[60-120] back-to-back inside a window matching
    // their own span exactly [0,120] -> zero idle anywhere -> f=0.
    // mean f = 0.409 -> score 59. Verified via node -e.
    expect(PRIME_N).toBe(2); // sanity: declared-config constant exists
    const fixtures: HealthFixture[] = [
      fx("c1a", "A", "X1", 0, 60, { court: "Court 1" }),
      fx("c1b", "A", "X2", 120, 60, { court: "Court 1" }),
      fx("c1c", "A", "X3", 300, 60, { court: "Court 1" }),
      fx("c2a", "B", "X4", 0, 60, { court: "Court 2" }),
      fx("c2b", "B", "X5", 60, 60, { court: "Court 2" }),
    ];
    const config: HealthConfig = {
      isRoundRobin: true,
      courtWindows: {
        "Court 1::2026-10-19": { from: 0, to: 400 * MS_PER_MIN },
        "Court 2::2026-10-19": { from: 0, to: 120 * MS_PER_MIN },
      },
    };
    const report = assessHealth(fixtures, config);
    const m = metric(report, "gapDispersion")!;
    expect(m.score).toBe(59);
    // Worst-3 by fragmentation descending: Court 1 day (f=0.818) before
    // Court 2 day (f=0). Only 2 court-days with >=2 fixtures exist.
    expect(m.offenders).toEqual([
      { kind: "courtDay", id: "Court 1::2026-10-19", label: "Court 1 2026-10-19", value: 120 },
      { kind: "courtDay", id: "Court 2::2026-10-19", label: "Court 2 2026-10-19", value: 0 },
    ]);
  });

  it("falls back to the court-day's OWN fixture span when no window is configured — idle_edges=0, so any internal gap makes f=1 (not fractional)", () => {
    const fixtures: HealthFixture[] = [
      fx("n1", "C", "X1", 0, 60, { court: "Court 3", dayKey: "2026-10-20" }),
      fx("n2", "C", "X2", 100, 60, { court: "Court 3", dayKey: "2026-10-20" }),
    ];
    const report = assessHealth(fixtures, { isRoundRobin: true }); // no courtWindows
    const m = metric(report, "gapDispersion")!;
    // f=1 for the only court-day -> mean=1 -> score=0.
    expect(m.score).toBe(0);
    expect(m.offenders[0]!.value).toBe(40); // the 40-minute internal gap
  });

  it("a court-day with only 1 fixture is excluded entirely (no internal gap can exist)", () => {
    const fixtures: HealthFixture[] = [fx("solo", "S", "X1", 0, 60, { court: "Court 9" })];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "gapDispersion")!;
    expect(m.score).toBe(100); // nothing eligible -> nothing to penalise
    expect(m.offenders).toEqual([]);
  });
});

describe("assessHealth — homeAwayAlternation", () => {
  it("scores 2 asymmetric entrants (4 fixtures perfectly alternating vs 5 with a 4-run) via mean alternation rate minus the worst run's overage penalty", () => {
    // A: home,away,home,away (4 fixtures) -> flips=3/3=1 (perfect), r=1.
    // B: home,home,home,home,away (5 fixtures) -> flips=1/4=0.25, r=4 (a
    // 4-run of the same side). meanA=0.625. Only B's r exceeds 3, by 1.
    // score = 100*0.625 - 10*max(0,4-3) = 52.5 -> round-half-up -> 53.
    // Verified via node -e.
    const fixtures: HealthFixture[] = [
      fx("a1", "A", "P1", 0, 60),
      fx("a2", "P2", "A", 100, 60),
      fx("a3", "A", "P3", 200, 60),
      fx("a4", "P4", "A", 300, 60),
      fx("b1", "B", "Q1", 0, 60, { court: "Court 2" }),
      fx("b2", "B", "Q2", 100, 60, { court: "Court 2" }),
      fx("b3", "B", "Q3", 200, 60, { court: "Court 2" }),
      fx("b4", "B", "Q4", 300, 60, { court: "Court 2" }),
      fx("b5", "Q5", "B", 400, 60, { court: "Court 2" }),
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "homeAwayAlternation")!;
    expect(m.score).toBe(53);
    expect(HOME_AWAY_RUN_THRESHOLD).toBe(4);
    // Only entrants with r >= 4 are offenders — A (r=1) is NOT included,
    // this is a threshold, not a top-3 ranking like the other metrics.
    expect(m.offenders).toEqual([{ kind: "entrant", id: "B", label: "B", value: 4 }]);
  });

  it("is ABSENT (not present-and-zero) for a bracket stage — the caller's isRoundRobin=false gate", () => {
    const fixtures: HealthFixture[] = [
      fx("k1", "A", "P1", 0, 60),
      fx("k2", "P2", "A", 100, 60),
      fx("k3", "A", "P3", 200, 60),
      fx("k4", "P4", "A", 300, 60),
    ];
    const report = assessHealth(fixtures, BRACKET);
    expect(metric(report, "homeAwayAlternation")).toBeUndefined();
    // The other 4 metrics are still present — only this one is gated.
    expect(report.metrics.map((x) => x.key).sort()).toEqual(
      ["courtBalance", "gapDispersion", "primeSlotFairness", "restSpread"].sort(),
    );
    expect(report.metrics).toHaveLength(4);
  });

  it("no offender when every entrant's longest run stays at or below the threshold", () => {
    const fixtures: HealthFixture[] = [
      fx("c1", "C", "P1", 0, 60),
      fx("c2", "P2", "C", 100, 60),
      fx("c3", "C", "P3", 200, 60),
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "homeAwayAlternation")!;
    expect(m.offenders).toEqual([]);
  });
});
