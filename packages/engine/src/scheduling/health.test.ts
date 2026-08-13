// health.test.ts — D3 schedule health arithmetic (design doc
// docs/superpowers/specs/bench-product-value/designs/2026-08-13-schedule-health-design.md,
// "Metric formulas" section, implemented verbatim). Every expected number
// below is derived independently from the formula text (by hand, cross-
// checked with a standalone node script — never by calling assessHealth and
// trusting its own output), and every board uses UNEQUAL entrant/court/day
// counts on purpose (the symmetric-fixture trap: a bug that averages across
// entrants, or hardcodes "2 courts", can hide on a board where every
// dimension happens to divide evenly).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  it("adversarial board: 3 near-zero gaps then one long one scores well below the asymmetric board above (0.667 mean penalty -> 33) — AND the other 4 metrics stay high on this same board (review finding #5: no cross-contamination)", () => {
    // D: gaps [0, 0, 240] -> ideal (mean) = 80. p = (1 + 1 + 0)/3 = 2/3.
    // score = round(100*(1-2/3)) = 33. Verified independently via node -e.
    //
    // Sides ALTERNATE (home,away,home,away) and the 4th fixture carries a
    // DIFFERENT dayKey label — both changes are free with respect to
    // restSpread's own arithmetic (it reads neither field) and with respect
    // to every OTHER metric's court-day/entrant grouping, verified via
    // node -e before writing this board: the FIRST version of this board
    // (D always home, all 4 fixtures on one dayKey) genuinely scored 0 on
    // BOTH homeAwayAlternation (D's unbroken 4-run) and gapDispersion (the
    // same 240-minute rest gap read as a 240-minute court-day hole) — real
    // defects in the BOARD's construction, not in the metrics under test,
    // and exactly the class of thing this finding exists to catch.
    const fixtures: HealthFixture[] = [
      fx("d1", "D", "R1", 0, 60),
      fx("d2", "R2", "D", 60, 60), // gap 0
      fx("d3", "D", "R3", 120, 60), // gap 0
      fx("d4", "R4", "D", 420, 60, { dayKey: "2026-10-20" }), // gap 240, own dayKey
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "restSpread")!;
    expect(m.score).toBe(33);
    expect(m.offenders[0]).toEqual({ kind: "entrant", id: "D", label: "D", value: 0 });

    // courtBalance: D's only court total is "Court 1" -> Hmax=0 guard -> 100.
    expect(metric(report, "courtBalance")!.score).toBe(100);
    // gapDispersion: d1-d3 are now the ONLY qualifying court-day (back-to-
    // back, f=0); d4 sits alone on its own dayKey (<2 fixtures, excluded).
    expect(metric(report, "gapDispersion")!.score).toBe(100);
    // homeAwayAlternation: D now alternates perfectly (home,away,home,away).
    expect(metric(report, "homeAwayAlternation")!.score).toBe(100);
    // primeSlotFairness: NOT near-100 — R1-R4 are single-appearance
    // opponents, and this metric has no |F_e| exclusion (design, verbatim),
    // so each of them shows some deviation from an expected share built on
    // just 4 total fixtures. That is an inherent property of a minimal
    // hand-built board with throwaway opponents, not contamination from
    // restSpread's own badness — still comfortably above restSpread's own
    // 33, which is the thing actually being guarded against here.
    expect(metric(report, "primeSlotFairness")!.score).toBe(70);
    expect(metric(report, "primeSlotFairness")!.score).toBeGreaterThan(m.score);
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

  it("an OVERLAPPING/double-booked entrant (a negative gap) scores the WORST possible penalty, not a perfect one (review finding #3)", () => {
    // OVR plays two fixtures where the second STARTS 30 minutes before the
    // first ENDS — a genuine double-booking. idealGap (= mean of the single
    // gap, by the telescoping identity every other test in this file relies
    // on) is therefore -30 minutes: non-positive, the same branch a
    // legitimately-perfect back-to-back board also lands in (see the next
    // test) — but this is the WORST case a board can produce for an
    // entrant, not the best, and must not be scored p_e=0.
    const fixtures: HealthFixture[] = [
      fx("v1", "OVR", "P1", 0, 60), // 0-60
      fx("v2", "OVR", "P2", 30, 60), // 30-90: starts 30min before v1 ends
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "restSpread")!;
    // The only eligible entrant scores the maximum penalty (p_e=1) ->
    // meanP=1 -> score=100*(1-1)=0. NOT 100.
    expect(m.score).toBe(0);
    // worstGapMin surfaces the actual (negative) overlap amount, not a
    // clamped-to-zero value — an organiser looking at "-30 min" is exactly
    // the information "you have a double-booking" needs to convey.
    expect(m.offenders).toEqual([{ kind: "entrant", id: "OVR", label: "OVR", value: -30 }]);
  });

  it("a fully back-to-back board with ZERO waste (no overlap, idealGap=0 exactly) is legitimately perfect — distinguishes the overlap fix from this pre-existing-correct case", () => {
    const fixtures: HealthFixture[] = [
      fx("z1", "Z", "P1", 0, 60), // 0-60
      fx("z2", "Z", "P2", 60, 60), // 60-120, touches exactly, gap=0
      fx("z3", "Z", "P3", 120, 60), // 120-180, touches exactly, gap=0
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "restSpread")!;
    expect(m.score).toBe(100);
  });

  it("explanation.params.count is the TRUE affected-entrant total, not the capped offender-list length (review finding #2)", () => {
    // 4 entrants, each independently shaped [0,0,240] like the adversarial
    // board above (p=2/3 each, all > 0 -> all 4 "affected"). offenders is
    // capped at top-3 by topOffenders; count must still read 4.
    const opp = (n: number) => `O${n}`;
    const entrant = (id: string, court: string, oBase: number): HealthFixture[] => [
      fx(`${id}f1`, id, opp(oBase), 0, 60, { court }),
      fx(`${id}f2`, id, opp(oBase + 1), 60, 60, { court }),
      fx(`${id}f3`, id, opp(oBase + 2), 120, 60, { court }),
      fx(`${id}f4`, id, opp(oBase + 3), 420, 60, { court }),
    ];
    const fixtures: HealthFixture[] = [
      ...entrant("P1", "Court 1", 1),
      ...entrant("P2", "Court 2", 5),
      ...entrant("P3", "Court 3", 9),
      ...entrant("P4", "Court 4", 13),
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "restSpread")!;
    expect(m.score).toBe(33); // identical p=2/3 for all 4 -> same as the single-entrant adversarial board
    expect(m.offenders).toHaveLength(3); // list stays capped
    expect(m.explanation.params?.count).toBe(4); // but the true total is reported
    expect(m.explanation.params!.count).toBeGreaterThan(m.offenders.length);
  });
});

describe("assessHealth — courtBalance", () => {
  it("scores 3 asymmetric entrants (3, 3 and 4 fixtures) by Shannon entropy of their own court distribution vs uniform — AND the other 4 metrics stay high on this same board (review finding #5: no cross-contamination)", () => {
    // A: 3 fixtures, 1 per court (3 courts total) -> H/Hmax = 1 (perfect).
    // B: 3 fixtures, all on Court 1 -> H = 0 (pinned) -> ratio 0 (worst).
    // E: 4 fixtures split 2/2 across 2 of the 3 courts -> ratio = ln(2)/ln(3).
    // mean = (1 + 0 + ln(2)/ln(3))/3 -> score 54. Verified via node -e.
    //
    // Sequenced as back-to-back ROUNDS (each entrant plays at most once per
    // round) and sides alternate per entrant — neither changes WHICH court
    // each fixture is on, so courtBalance's own score/offenders are
    // unchanged from the first version of this board. What the first
    // version got wrong: two fixtures literally double-booked Court 1 at
    // the same instant (a1 and b1 both 0-60), which courtBalance cannot
    // see (it never reads `start`/`end`) but which is nonsense as applied-
    // schedule data, and separately every entrant was always "home",
    // reading as a genuine (not contaminated) homeAwayAlternation zero.
    expect(COURT_BALANCE_MIN_FIXTURES).toBe(3);
    const fixtures: HealthFixture[] = [
      fx("a2", "A", "X1", 0, 60, { court: "Court 2" }),
      fx("b1", "B", "X4", 0, 60, { court: "Court 1" }),
      fx("a3", "X2", "A", 60, 60, { court: "Court 3" }),
      fx("b2", "X5", "B", 60, 60, { court: "Court 1" }),
      fx("e3", "E", "X7", 60, 60, { court: "Court 2" }),
      fx("b3", "B", "X6", 120, 60, { court: "Court 1" }),
      fx("e4", "X8", "E", 120, 60, { court: "Court 2" }),
      fx("e1", "E", "X9", 180, 60, { court: "Court 1" }),
      fx("e2", "X10", "E", 240, 60, { court: "Court 1" }),
      fx("a1", "A", "X3", 300, 60, { court: "Court 1" }),
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "courtBalance")!;
    expect(m.score).toBe(54);
    // Bottom-3 by ratio ascending (worst/most-pinned first). value = distinct
    // courts used. All 3 eligible entrants appear (exactly 3 qualify).
    // IDENTICAL to the first version of this board — court assignment per
    // entrant is unchanged, only timing/sides moved.
    expect(m.offenders).toEqual([
      { kind: "entrant", id: "B", label: "B", value: 1 },
      { kind: "entrant", id: "E", label: "E", value: 2 },
      { kind: "entrant", id: "A", label: "A", value: 3 },
    ]);

    // gapDispersion: every court-day is now back-to-back internally (zero
    // gaps within each of Court 1's and Court 2's own sequences) -> f=0 for
    // both qualifying court-days.
    expect(metric(report, "gapDispersion")!.score).toBe(100);
    // homeAwayAlternation: A/B/E each now alternate perfectly.
    expect(metric(report, "homeAwayAlternation")!.score).toBe(100);
    // restSpread: high but not pinned to an exact value here (not this
    // board's target metric) — comfortably above courtBalance's own 54.
    expect(metric(report, "restSpread")!.score).toBe(83);
    // primeSlotFairness: also softened here, by an unrelated and larger
    // effect than the boards above — 10 single-appearance opponents (this
    // metric has no |F_e| exclusion) against only 3 real multi-fixture
    // entrants. 47 is close to courtBalance's own 54, but for an
    // INDEPENDENTLY explicable reason (opponent-count dilution, not a
    // shared code path) — not evidence of contamination between the two.
    expect(metric(report, "primeSlotFairness")!.score).toBe(47);
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

  it("explanation.params.count is the TRUE affected-entrant total, not the capped offender-list length (review finding #2)", () => {
    // 4 entrants, each 3 fixtures split 2:1 across the SAME 2 courts — the
    // best possible split for 3 fixtures over 2 courts, yet still ratio<1
    // (perfectly uniform needs equal counts, 2:1 is not equal) -> all 4
    // "affected". offenders is capped at top-3.
    const opp = (n: number) => `O${n}`;
    const entrant = (id: string, oBase: number): HealthFixture[] => [
      fx(`${id}f1`, id, opp(oBase), 0, 60, { court: "Court 1" }),
      fx(`${id}f2`, id, opp(oBase + 1), 100, 60, { court: "Court 1" }),
      fx(`${id}f3`, id, opp(oBase + 2), 200, 60, { court: "Court 2" }),
    ];
    const fixtures: HealthFixture[] = [
      ...entrant("Q1", 1),
      ...entrant("Q2", 4),
      ...entrant("Q3", 7),
      ...entrant("Q4", 10),
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "courtBalance")!;
    expect(m.score).toBe(92); // identical ratio for all 4 (verified via node -e)
    expect(m.offenders).toHaveLength(3);
    expect(m.explanation.params?.count).toBe(4);
    expect(m.explanation.params!.count).toBeGreaterThan(m.offenders.length);
  });
});

describe("assessHealth — gapDispersion", () => {
  it("scores 2 asymmetric court-days (3 fixtures with gaps vs 2 back-to-back) via idle_inside / (idle_inside + idle_edges) — AND the other 4 metrics stay high on this same board (review finding #5: no cross-contamination)", () => {
    // Court 1 day: fixtures at [0-60],[120-180],[300-360] inside a
    // configured [0,400] window. idle_inside = 60+120 = 180. idle_edges =
    // (400-180 busy) - 180 = 40 (0 before first, 40 after last). f=180/220.
    // Court 2 day: [0-60],[60-120] back-to-back inside a window matching
    // their own span exactly [0,120] -> zero idle anywhere -> f=0.
    // mean f = 0.409 -> score 59. Verified via node -e.
    //
    // gapDispersion groups by (court, day) alone — WHICH entrants play each
    // fixture is irrelevant to its own arithmetic, so every fixture below
    // uses a DISTINCT single-appearance pair (P1..P5 vs Q1..Q5). The FIRST
    // version of this board reused one entrant (A) across all 3 Court 1
    // fixtures, which genuinely pinned it to that one court (courtBalance
    // 0, a real defect in the board, not the metric) purely because 3
    // fixtures on 1 court happened to meet courtBalance's own C_min — an
    // accident of reusing an entrant, not anything gapDispersion's target
    // score needed.
    expect(PRIME_N).toBe(2); // sanity: declared-config constant exists
    const fixtures: HealthFixture[] = [
      fx("c1a", "P1", "Q1", 0, 60, { court: "Court 1" }),
      fx("c1b", "P2", "Q2", 120, 60, { court: "Court 1" }),
      fx("c1c", "P3", "Q3", 300, 60, { court: "Court 1" }),
      fx("c2a", "P4", "Q4", 0, 60, { court: "Court 2" }),
      fx("c2b", "P5", "Q5", 60, 60, { court: "Court 2" }),
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
    // IDENTICAL to the first version of this board — gapDispersion's own
    // arithmetic never read the entrant ids that changed.
    expect(m.offenders).toEqual([
      { kind: "courtDay", id: "Court 1::2026-10-19", label: "Court 1 2026-10-19", value: 120 },
      { kind: "courtDay", id: "Court 2::2026-10-19", label: "Court 2 2026-10-19", value: 0 },
    ]);

    // restSpread/courtBalance/homeAwayAlternation: every entrant here is
    // single-appearance (|F_e|=1) -> nothing eligible on any of the three
    // -> the shared "nothing to penalise" default, 100.
    expect(metric(report, "restSpread")!.score).toBe(100);
    expect(metric(report, "courtBalance")!.score).toBe(100);
    expect(metric(report, "homeAwayAlternation")!.score).toBe(100);
    // primeSlotFairness: softened by the same single-appearance-opponent
    // structural effect the restSpread adversarial board documents above
    // (no |F_e| exclusion for this metric) — still clearly above
    // gapDispersion's own 59, the thing actually being guarded against.
    expect(metric(report, "primeSlotFairness")!.score).toBe(68);
    expect(metric(report, "primeSlotFairness")!.score).toBeGreaterThan(m.score);
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

  it("explanation.params.count is the TRUE affected-court-day total, not the capped offender-list length (review finding #2)", () => {
    // 4 court-days, each 2 fixtures with a real gap, no configured window ->
    // f=1 for every one of them (the fallback rule: any internal gap makes
    // f=1 with no wider window to be idle against) -> all 4 "affected".
    const fixtures: HealthFixture[] = [
      fx("g1a", "A", "X1", 0, 60, { court: "Court 1", dayKey: "2026-10-19" }),
      fx("g1b", "A", "X2", 100, 60, { court: "Court 1", dayKey: "2026-10-19" }),
      fx("g2a", "B", "X3", 0, 60, { court: "Court 2", dayKey: "2026-10-19" }),
      fx("g2b", "B", "X4", 100, 60, { court: "Court 2", dayKey: "2026-10-19" }),
      fx("g3a", "C", "X5", 0, 60, { court: "Court 1", dayKey: "2026-10-20" }),
      fx("g3b", "C", "X6", 100, 60, { court: "Court 1", dayKey: "2026-10-20" }),
      fx("g4a", "D", "X7", 0, 60, { court: "Court 2", dayKey: "2026-10-20" }),
      fx("g4b", "D", "X8", 100, 60, { court: "Court 2", dayKey: "2026-10-20" }),
    ];
    const report = assessHealth(fixtures, RR); // no courtWindows configured
    const m = metric(report, "gapDispersion")!;
    expect(m.score).toBe(0); // f=1 for all 4 -> mean=1 -> score=0
    expect(m.offenders).toHaveLength(3);
    expect(m.explanation.params?.count).toBe(4);
    expect(m.explanation.params!.count).toBeGreaterThan(m.offenders.length);
  });
});

describe("assessHealth — homeAwayAlternation", () => {
  it("scores 2 asymmetric entrants (4 fixtures perfectly alternating vs 5 with a 4-run) via mean alternation rate minus the worst run's overage penalty — AND the other 4 metrics stay high on this same board (review finding #5: no cross-contamination)", () => {
    // A: home,away,home,away (4 fixtures) -> flips=3/3=1 (perfect), r=1.
    // B: home,home,home,home,away (5 fixtures) -> flips=1/4=0.25, r=4 (a
    // 4-run of the same side). meanA=0.625. Only B's r exceeds 3, by 1.
    // score = 100*0.625 - 10*max(0,4-3) = 52.5 -> round-half-up -> 53.
    // Verified via node -e.
    //
    // A/B now split 2 courts each (courtBalance) with each entrant's own
    // fixtures back-to-back within their own court (gapDispersion) — court
    // and timing changed, but each entrant's ORDER-BY-START side sequence
    // is IDENTICAL to the first version of this board (home,away,home,away
    // for A; home,home,home,home,away for B), so homeAwayAlternation's own
    // computation, which reads only that ordered side sequence, is
    // unaffected. The first version put A entirely on "Court 1" and B
    // entirely on "Court 2" with a 40-minute gap before every fixture,
    // which genuinely pinned both on courtBalance and fragmented both
    // court-days on gapDispersion — real defects in the board, not this
    // metric leaking into those two.
    const fixtures: HealthFixture[] = [
      fx("a1", "A", "Q1", 0, 60, { court: "Court 1" }),
      fx("b1", "B", "Q2", 0, 60, { court: "Court 2" }),
      fx("a2", "Q3", "A", 60, 60, { court: "Court 2" }),
      fx("b2", "B", "Q4", 60, 60, { court: "Court 1" }),
      fx("a3", "A", "Q5", 120, 60, { court: "Court 1" }),
      fx("b3", "B", "Q6", 120, 60, { court: "Court 2" }),
      fx("a4", "Q7", "A", 180, 60, { court: "Court 2" }),
      fx("b4", "B", "Q8", 180, 60, { court: "Court 1" }),
      fx("b5", "Q9", "B", 240, 60, { court: "Court 2" }),
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "homeAwayAlternation")!;
    expect(m.score).toBe(53);
    expect(HOME_AWAY_RUN_THRESHOLD).toBe(4);
    // Only entrants with r >= 4 are offenders — A (r=1) is NOT included,
    // this is a threshold, not a top-3 ranking like the other metrics.
    // IDENTICAL to the first version — the run/flip pattern is unchanged.
    expect(m.offenders).toEqual([{ kind: "entrant", id: "B", label: "B", value: 4 }]);

    expect(metric(report, "restSpread")!.score).toBe(100);
    // courtBalance: A splits its 4 fixtures exactly 2/2 across Court 1/2
    // (perfectly uniform, ratio 1); B splits 5 fixtures 3/2 (very close to
    // uniform, ratio ~0.97) — mean rounds to 99, not literally 100.
    expect(metric(report, "courtBalance")!.score).toBe(99);
    expect(metric(report, "gapDispersion")!.score).toBe(100);
    // primeSlotFairness: softened by 9 single-appearance opponents against
    // 2 real entrants (same structural note as the boards above) — still
    // clearly above homeAwayAlternation's own 53.
    expect(metric(report, "primeSlotFairness")!.score).toBe(58);
    expect(metric(report, "primeSlotFairness")!.score).toBeGreaterThan(m.score);
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

describe("assessHealth — primeSlotFairness", () => {
  it("scores 6 entrants (2 fixtures each, asymmetric prime exposure) via deviation from their expected prime share — AND the other 4 metrics stay high on this same board (review finding #5: no cross-contamination)", () => {
    // Court 1 day: A v B, A v B, C v D, C v D (4 fixtures) -> prime (last 2)
    // = the two C v D fixtures. A/B get ZERO prime fixtures.
    // Court 2 day: E v F, E v F (2 fixtures) -> prime (last min(2,2)=2) =
    // BOTH. |F|=6 total, P=4 total prime.
    // expected_e = 2*4/6 = 1.333 for everyone (each plays exactly 2).
    // A/B: actual=0 -> d=1.333/1.333=1 (fully starved, capped at 1).
    // C/D/E/F: actual=2 -> d=0.667/1.333=0.5 (hogging).
    // mean = (1+1+0.5*4)/6 = 0.667 -> score = round(100*(1-0.667)) = 33.
    // Verified via node -e.
    //
    // primeSlotFairness only cares about court-day POSITION (chronological
    // rank within each (court,day) group), never the actual gap sizes
    // between fixtures — so the pairs below are now back-to-back (zero
    // gaps) with sides alternating within each pair, which changes NEITHER
    // which fixtures land in the "last PRIME_N" slots nor any entrant's own
    // actual/expected prime count. The first version of this board had a
    // uniform 40-minute gap before every fixture with no window configured
    // (any gap -> f=1, the documented fallback) and every entrant always on
    // the same side of its own pairing — both genuinely tanked
    // gapDispersion and homeAwayAlternation, not a leak from this metric.
    const fixtures: HealthFixture[] = [
      fx("f1", "A", "B", 0, 60, { court: "Court 1" }),
      fx("f2", "B", "A", 60, 60, { court: "Court 1" }),
      fx("f3", "C", "D", 120, 60, { court: "Court 1" }),
      fx("f4", "D", "C", 180, 60, { court: "Court 1" }),
      fx("f5", "E", "F", 0, 60, { court: "Court 2" }),
      fx("f6", "F", "E", 60, 60, { court: "Court 2" }),
    ];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "primeSlotFairness")!;
    expect(m.score).toBe(33);
    // top-3 by |d_e| descending: A, B tie at d=1 (lex: A, B), then C/D/E/F
    // tie at d=0.5 — lex picks C third.
    expect(m.offenders).toEqual([
      { kind: "entrant", id: "A", label: "A", value: -1.33 },
      { kind: "entrant", id: "B", label: "B", value: -1.33 },
      { kind: "entrant", id: "C", label: "C", value: 0.67 },
    ]);
    // Review finding #2: all SIX entrants on this board have d_e > 0 (A/B
    // starved at d=1, C/D/E/F hogging at d=0.5) — count must report the true
    // total, not the capped 3-entry offenders list.
    expect(m.offenders).toHaveLength(3);
    expect(m.explanation.params?.count).toBe(6);
    expect(m.explanation.params!.count).toBeGreaterThan(m.offenders.length);

    // All 4 of the OTHER metrics score perfectly on this board: every pair
    // is back-to-back (gapDispersion), every entrant alternates sides
    // (homeAwayAlternation), and no entrant reaches either metric's own
    // eligibility floor (courtBalance's C_min=3, restSpread's |F_e|>=2) —
    // this board's badness is isolated entirely to primeSlotFairness.
    expect(metric(report, "restSpread")!.score).toBe(100);
    expect(metric(report, "courtBalance")!.score).toBe(100);
    expect(metric(report, "gapDispersion")!.score).toBe(100);
    expect(metric(report, "homeAwayAlternation")!.score).toBe(100);
  });

  it("a court-day with fewer than PRIME_N fixtures treats ALL of them as prime (min(PRIME_N, count))", () => {
    expect(PRIME_N).toBe(2);
    // Single fixture on its own court-day: min(2,1)=1 prime fixture, so this
    // lone entrant's actual share is 100%, not diluted by a nonexistent 2nd.
    const fixtures: HealthFixture[] = [fx("solo", "A", "B", 0, 60)];
    const report = assessHealth(fixtures, RR);
    const m = metric(report, "primeSlotFairness")!;
    // |F|=1, P=1. expected_A = 1*1/1 = 1. actual_A=1. d=0 -> perfect.
    expect(m.score).toBe(100);
  });
});

describe("assessHealth — regression: full report pinned for one fixed board", () => {
  it("matches the frozen report exactly — any metric drift reds this with a diff", () => {
    // A small, asymmetric, DOUBLE-BOOKING-FREE round-robin board: 5 entrants
    // (A:3, B:2, C:3, D:3, E:3 fixtures — never uniform), 2 courts, 2 days.
    // Constructed as sequential "rounds" per court so no entrant is ever
    // scheduled on two courts at once (verified programmatically while
    // building this board — an earlier draft had exactly that bug: two
    // fixtures 90 minutes apart on DIFFERENT courts for the same entrant,
    // which produced a NEGATIVE restSpread gap and was caught only by
    // checking for overlaps, not by eyeballing the numbers).
    //
    // Every number below was independently hand-derived from the formula
    // text (shown in comments per metric) before being frozen here — not
    // copied from a first run and trusted. The one deliberate exception is
    // primeSlotFairness's 3rd offender: B and A are a MATHEMATICAL tie at
    // exactly 1/6, but 18/7 and 12/7 round to different float64s on the way
    // there, so B (whose rounding lands fractionally higher) wins the slot
    // over lexicographic A — a real, deterministic, reproducible ordering,
    // not a bug (confirmed via node -e before freezing this).
    const DAY_MIN = 1440;
    const day = (dayIdx: number, startMin: number, durMin: number, home: string, away: string, court: string): HealthFixture => ({
      fixtureId: `${court[court.length - 1]}${dayIdx}_${startMin}`,
      court,
      dayKey: dayIdx === 0 ? "2026-11-02" : "2026-11-03",
      start: (dayIdx * DAY_MIN + startMin) * MS_PER_MIN,
      end: (dayIdx * DAY_MIN + startMin + durMin) * MS_PER_MIN,
      home,
      away,
    });
    const fixtures: HealthFixture[] = [
      day(0, 0, 60, "A", "B", "Court A"),
      day(0, 0, 60, "C", "D", "Court B"),
      day(0, 90, 60, "A", "C", "Court A"),
      day(0, 90, 60, "B", "E", "Court B"),
      day(0, 200, 60, "D", "E", "Court B"),
      day(1, 0, 60, "A", "D", "Court A"),
      day(1, 0, 60, "C", "E", "Court B"),
    ];
    const config: HealthConfig = {
      isRoundRobin: true,
      courtWindows: { "Court A::2026-11-02": { from: -30 * MS_PER_MIN, to: 300 * MS_PER_MIN } },
    };
    const report = assessHealth(fixtures, config);
    expect(report).toEqual({
      metrics: [
        {
          key: "restSpread",
          score: 64,
          // count=4, not 3: A/C/D/E all have p_e>0 (B is excluded from the
          // metric entirely, |F_e|=2). Independently recomputed via node -e
          // against this exact board after review finding #2's fix — never
          // copied from a first run.
          explanation: { key: "schedule.health.explain.restSpread", params: { count: 4 } },
          offenders: [
            { kind: "entrant", id: "A", label: "A", value: 30 },
            { kind: "entrant", id: "C", label: "C", value: 30 },
            { kind: "entrant", id: "E", label: "E", value: 50 },
          ],
        },
        {
          key: "courtBalance",
          score: 46,
          // count=4: all 4 eligible entrants (A/C/D/E, each |F_e|>=3) have
          // ratio<1 — none is perfectly uniform on this board.
          explanation: { key: "schedule.health.explain.courtBalance", params: { count: 4 } },
          offenders: [
            { kind: "entrant", id: "A", label: "A", value: 1 },
            { kind: "entrant", id: "E", label: "E", value: 1 },
            { kind: "entrant", id: "C", label: "C", value: 2 },
          ],
        },
        {
          key: "gapDispersion",
          score: 43,
          // count stays 2 — exactly 2 court-days qualify (>=2 fixtures) on
          // this board, and both have f>0, so the true total already equals
          // the (unfilled) offender list length here; unaffected by the fix.
          explanation: { key: "schedule.health.explain.gapDispersion", params: { count: 2 } },
          offenders: [
            { kind: "courtDay", id: "Court B::2026-11-02", label: "Court B 2026-11-02", value: 50 },
            { kind: "courtDay", id: "Court A::2026-11-02", label: "Court A 2026-11-02", value: 30 },
          ],
        },
        {
          key: "homeAwayAlternation",
          score: 60,
          explanation: { key: "schedule.health.explain.homeAwayAlternation", params: { count: 0 } },
          offenders: [],
        },
        {
          key: "primeSlotFairness",
          score: 81,
          // count=5, not 3: EVERY entrant on this board (A/B/C/D/E) has
          // d_e>0 — none lands exactly on their expected prime share.
          explanation: { key: "schedule.health.explain.primeSlotFairness", params: { count: 5 } },
          offenders: [
            { kind: "entrant", id: "C", label: "C", value: -0.57 },
            { kind: "entrant", id: "D", label: "D", value: -0.57 },
            { kind: "entrant", id: "B", label: "B", value: 0.29 },
          ],
        },
      ],
    });
  });
});

describe("assessHealth — module purity (D3 contract: no imports, no DB, no solver, no clock, no pino)", () => {
  it("imports NOTHING — even leafer than capacity.ts, which imports rest-floor.ts — and never reads the wall clock or logs", () => {
    const path = fileURLToPath(new URL("./health.ts", import.meta.url));
    const src = readFileSync(path, "utf8");
    const importLines = [...src.matchAll(/^import\s.*$/gm)].map((m) => m[0]);
    expect(importLines).toEqual([]);
    // Scoped to actual `import` lines (none exist, but keep the shape
    // parallel to capacity.test.ts's purity test for whoever edits this
    // next and adds a real one).
    expect(src, "must not read the ambient wall clock").not.toMatch(/Date\.now\(\)|new Date\(\)(?!\.)/);
    expect(src, "must not import pino").not.toMatch(/^import[^\n]*pino/m);
    expect(src, "must not import postgres/DB").not.toMatch(/^import[^\n]*postgres/m);
  });
});
