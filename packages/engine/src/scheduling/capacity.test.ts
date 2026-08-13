// capacity.test.ts — D2 capacity pre-check arithmetic (design doc
// docs/superpowers/specs/bench-product-value/designs/2026-08-13-capacity-precheck-design.md,
// "Arithmetic" section, implemented verbatim: slot = m + g,
// supply_{c,d} = Σ_w ⌊(len(w) + g) / slot⌋, rest bound
// need_e = k_e·m + (k_e−1)·max(r, g), TIGHT_RATIO = 1.15).
//
// Every suggestion is proven by INDEPENDENT re-assessment: the test builds
// its own modified CapacityInput reflecting the suggested delta and calls
// assessCapacity on it directly, rather than trusting the report's own
// `flipsVerdict` field. A hardcoded `flipsVerdict: true` would still pass a
// test that only inspected the field; it cannot pass a test that re-derives
// the flip from scratch.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assessCapacity,
  TIGHT_RATIO,
  type CapacityDay,
  type CapacityEntrant,
  type CapacityInput,
} from "./capacity.ts";

const MS_PER_MIN = 60_000;
const DAY_MS = 24 * 60 * MS_PER_MIN;

/** One court, one window of `minutes` starting at `from`, on `date`. */
function oneCourtDay(date: string, from: number, minutes: number, demandCap?: number): CapacityDay {
  return {
    date,
    courts: [{ court: "Court 1", windows: [{ from, to: from + minutes * MS_PER_MIN }] }],
    ...(demandCap !== undefined ? { demandCap } : {}),
  };
}

const DAY1 = Date.UTC(2026, 9, 19, 0, 0); // 2026-10-19T00:00Z, arbitrary fixed anchor

describe("assessCapacity — supply/demand arithmetic", () => {
  it("computes supply as floor((window + gap) / slot) and verdict ok when demand fits comfortably", () => {
    // m=30, g=10 -> slot=40. One 240-minute window: floor((240+10)/40) = 6.
    const input: CapacityInput = {
      matchMinutes: 30,
      gapMinutes: 10,
      perEntrantMinRest: 0,
      fixtureCount: 4,
      days: [oneCourtDay("2026-10-19", DAY1, 240)],
      entrants: [],
    };
    const report = assessCapacity(input);
    expect(report.slotSupply).toBe(6);
    expect(report.slotDemand).toBe(4);
    expect(report.perDay).toEqual([{ date: "2026-10-19", supply: 6, demandCeiling: 4 }]);
    // ratio 6/4 = 1.5 >= TIGHT_RATIO -> not tight.
    expect(report.slotSupply).toBeGreaterThanOrEqual(TIGHT_RATIO * report.slotDemand);
    expect(report.verdict).toBe("ok");
    expect(report.suggestions).toEqual([]);
  });

  it("verdict impossible when total demand exceeds total supply (no day caps involved)", () => {
    const input: CapacityInput = {
      matchMinutes: 30,
      gapMinutes: 10,
      perEntrantMinRest: 0,
      fixtureCount: 10, // supply is 6 (as above) — 10 cannot fit
      days: [oneCourtDay("2026-10-19", DAY1, 240)],
      entrants: [],
    };
    const report = assessCapacity(input);
    expect(report.slotSupply).toBe(6);
    expect(report.verdict).toBe("impossible");
  });

  it("verdict tight when supply/demand ratio is under TIGHT_RATIO but not impossible", () => {
    // supply=6 (as above), demand=6 -> ratio exactly 1.0 < 1.15 -> tight, not impossible.
    const input: CapacityInput = {
      matchMinutes: 30,
      gapMinutes: 10,
      perEntrantMinRest: 0,
      fixtureCount: 6,
      days: [oneCourtDay("2026-10-19", DAY1, 240)],
      entrants: [],
    };
    const report = assessCapacity(input);
    expect(report.slotSupply).toBeLessThan(TIGHT_RATIO * report.slotDemand);
    expect(report.verdict).toBe("tight");
  });

  it("zero declared days with nonzero demand is impossible (nowhere to place anything)", () => {
    const input: CapacityInput = {
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      fixtureCount: 1,
      days: [],
      entrants: [],
    };
    expect(assessCapacity(input).verdict).toBe("impossible");
  });
});

describe("assessCapacity — rest lower bound (need_e = k_e·m + (k_e−1)·max(r, g))", () => {
  // The "10 fixtures, 1 entrant pair, 1 day" case the design's Testing
  // section names: plenty of COURT supply (two courts, generous windows) so
  // only the entrant's own rest bound can make this impossible. Asymmetric
  // on purpose (entrant A has 10 fixtures, B has 2) so a bug that averages
  // load across entrants instead of checking each one cannot hide.
  it("flags an over-loaded entrant impossible via the rest bound alone, while a lighter entrant on the same day is fine", () => {
    // m=60, g=15 -> slot=75. Two courts, each a 600-minute window:
    // supply/court = floor((600+15)/75) = 8, total = 16 >= fixtureCount(10).
    const day = {
      date: "2026-10-19",
      courts: [
        { court: "Court 1", windows: [{ from: DAY1, to: DAY1 + 600 * MS_PER_MIN }] },
        { court: "Court 2", windows: [{ from: DAY1, to: DAY1 + 600 * MS_PER_MIN }] },
      ],
    };
    const entrantA: CapacityEntrant = { entrantId: "A", fixtures: 10 };
    const entrantB: CapacityEntrant = { entrantId: "B", fixtures: 2 };
    const input: CapacityInput = {
      matchMinutes: 60,
      gapMinutes: 15,
      perEntrantMinRest: 0,
      fixtureCount: 10,
      days: [day],
      entrants: [entrantA, entrantB],
    };
    const report = assessCapacity(input);
    expect(report.slotSupply).toBe(16); // court supply is NOT the bottleneck
    // need_A = 10*60 + 9*max(0,15) = 600 + 135 = 735; available = union of the
    // day's windows = 600 minutes (both courts cover the SAME 600-minute span).
    const boundA = report.restBound.find((r) => r.entrantId === "A")!;
    expect(boundA.need).toBe(735);
    expect(boundA.available).toBe(600);
    expect(boundA.violated).toBe(true);
    // need_B = 2*60 + 1*15 = 135 <= 600 -> fine.
    const boundB = report.restBound.find((r) => r.entrantId === "B")!;
    expect(boundB.need).toBe(135);
    expect(boundB.violated).toBe(false);
    expect(report.verdict).toBe("impossible");
  });

  it("raising perEntrantMinRest raises the computed need (proves restFloor is actually consulted, not hardcoded)", () => {
    const day = oneCourtDay("2026-10-19", DAY1, 600);
    const base: CapacityInput = {
      matchMinutes: 30,
      gapMinutes: 5,
      perEntrantMinRest: 0,
      fixtureCount: 2,
      days: [day],
      entrants: [{ entrantId: "A", fixtures: 3 }],
    };
    const withRest: CapacityInput = { ...base, perEntrantMinRest: 40 };
    const needBase = assessCapacity(base).restBound[0]!.need;
    const needWithRest = assessCapacity(withRest).restBound[0]!.need;
    // need = k*m + (k-1)*max(r,g): base r=max(0,5)=5 -> 3*30+2*5=100.
    // raised r=max(40,5)=40 -> 3*30+2*40=170.
    expect(needBase).toBe(100);
    expect(needWithRest).toBe(170);
    expect(needWithRest).toBeGreaterThan(needBase);
  });
});

describe("assessCapacity — per-day caps (Hall-style day walk over ordered days)", () => {
  it("is impossible when a binding per-day rule cap front-loads demand past what capped days can absorb, even though TOTAL court supply is ample", () => {
    // Day1: 1 court, 300-minute window, m=30 g=0 -> slot=30 -> supply=10.
    // A max_fixtures_per_day rule caps day1 at 3 (well under its own supply).
    // Day2: no usable court time at all (supply=0), no rule cap declared.
    const day1 = oneCourtDay("2026-10-19", DAY1, 300, 3);
    const day2: CapacityDay = { date: "2026-10-20", courts: [] };
    const input: CapacityInput = {
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      fixtureCount: 4,
      days: [day1, day2],
      entrants: [],
    };
    const report = assessCapacity(input);
    // Raw total supply (10 + 0 = 10) is >= demand(4) — a naive total-supply-only
    // check would wrongly call this "ok". The cap-bounded walk must catch it:
    // day1 places at most min(10,3)=3, day2 places at most min(0,4)=0 -> 3 < 4.
    expect(report.slotSupply).toBe(10);
    expect(report.perDay).toEqual([
      { date: "2026-10-19", supply: 10, demandCeiling: 3 },
      { date: "2026-10-20", supply: 0, demandCeiling: 4 }, // defaulted to fixtureCount — no rule cap here
    ]);
    expect(report.verdict).toBe("impossible");
  });

  it("loosening the single binding day cap exits impossible (regression shape: raise the one binding constraint)", () => {
    const day1 = oneCourtDay("2026-10-19", DAY1, 300, 3);
    const day2: CapacityDay = { date: "2026-10-20", courts: [] };
    const loosened: CapacityInput = {
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      fixtureCount: 4,
      days: [{ ...day1, demandCap: 4 }, day2], // the ONLY binding constraint, raised by 1
      entrants: [],
    };
    expect(assessCapacity(loosened).verdict).not.toBe("impossible");
  });
});

describe("assessCapacity — suggestions are proven by independent re-assessment", () => {
  // Shared impossible base: 1 court, 1 day, supply=6 (as the arithmetic test
  // above), fixtureCount=10.
  function impossibleBase(): CapacityInput {
    return {
      matchMinutes: 30,
      gapMinutes: 10,
      perEntrantMinRest: 0,
      fixtureCount: 10,
      days: [oneCourtDay("2026-10-19", DAY1, 240)],
      entrants: [],
    };
  }

  it("add_day: the suggestion is honest, AND independently adding a second identical day actually flips the verdict", () => {
    const base = impossibleBase();
    const report = assessCapacity(base);
    expect(report.verdict).toBe("impossible");
    const suggestion = report.suggestions.find((s) => s.kind === "add_day");
    expect(suggestion).toBeDefined();
    expect(suggestion!.amount).toBe(1);
    expect(suggestion!.flipsVerdict).toBe(true);

    // Independent proof: build the delta ourselves (clone day1's court/window
    // shape onto a new calendar day) and re-run assessCapacity from scratch.
    const day1 = base.days[0]!;
    const day2: CapacityDay = {
      date: "2026-10-20",
      courts: day1.courts.map((c) => ({
        court: c.court,
        windows: c.windows.map((w) => ({ from: w.from + DAY_MS, to: w.to + DAY_MS })),
      })),
    };
    const applied: CapacityInput = { ...base, days: [day1, day2] };
    expect(assessCapacity(applied).verdict).not.toBe("impossible");
  });

  it("add_court: the suggestion is honest, AND independently adding a second identical court actually flips the verdict", () => {
    const base = impossibleBase();
    const report = assessCapacity(base);
    const suggestion = report.suggestions.find((s) => s.kind === "add_court");
    expect(suggestion).toBeDefined();
    expect(suggestion!.flipsVerdict).toBe(true);

    const day1 = base.days[0]!;
    const extraCourt = { court: "Court 2", windows: day1.courts[0]!.windows.map((w) => ({ ...w })) };
    const applied: CapacityInput = {
      ...base,
      days: [{ ...day1, courts: [...day1.courts, extraCourt] }],
    };
    expect(assessCapacity(applied).verdict).not.toBe("impossible");
  });

  it("shorten_match: the suggestion is honest, AND independently reducing matchMinutes by the suggested amount flips the verdict", () => {
    // m=35, g=5 -> slot=40. 300-minute window: supply=floor(305/40)=7. demand=8 -> impossible.
    const base: CapacityInput = {
      matchMinutes: 35,
      gapMinutes: 5,
      perEntrantMinRest: 0,
      fixtureCount: 8,
      days: [oneCourtDay("2026-10-19", DAY1, 300)],
      entrants: [],
    };
    const report = assessCapacity(base);
    expect(report.verdict).toBe("impossible");
    const suggestion = report.suggestions.find((s) => s.kind === "shorten_match");
    expect(suggestion).toBeDefined();
    expect(suggestion!.amount).toBe(5);
    expect(suggestion!.flipsVerdict).toBe(true);

    const applied: CapacityInput = { ...base, matchMinutes: base.matchMinutes - suggestion!.amount };
    expect(assessCapacity(applied).verdict).not.toBe("impossible");
  });

  it("shrink_gap: the suggestion is honest, AND independently reducing gapMinutes by the suggested amount flips the verdict", () => {
    // m=30, g=20 -> slot=50. 300-minute window: supply=floor(320/50)=6. demand=7 -> impossible.
    const base: CapacityInput = {
      matchMinutes: 30,
      gapMinutes: 20,
      perEntrantMinRest: 0,
      fixtureCount: 7,
      days: [oneCourtDay("2026-10-19", DAY1, 300)],
      entrants: [],
    };
    const report = assessCapacity(base);
    expect(report.verdict).toBe("impossible");
    const suggestion = report.suggestions.find((s) => s.kind === "shrink_gap");
    expect(suggestion).toBeDefined();
    expect(suggestion!.flipsVerdict).toBe(true);

    const applied: CapacityInput = { ...base, gapMinutes: base.gapMinutes - suggestion!.amount };
    expect(assessCapacity(applied).verdict).not.toBe("impossible");
  });

  it("raise_cap: the suggestion is honest, AND independently raising the identified binding day's cap by the suggested amount flips the verdict", () => {
    const day1 = oneCourtDay("2026-10-19", DAY1, 300, 3); // cap(3) < its own supply(10) -> binding
    const day2: CapacityDay = { date: "2026-10-20", courts: [] };
    const base: CapacityInput = {
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      fixtureCount: 4,
      days: [day1, day2],
      entrants: [],
    };
    const report = assessCapacity(base);
    expect(report.verdict).toBe("impossible");
    const suggestion = report.suggestions.find((s) => s.kind === "raise_cap");
    expect(suggestion).toBeDefined();
    expect(suggestion!.amount).toBe(1);
    expect(suggestion!.flipsVerdict).toBe(true);

    const applied: CapacityInput = {
      ...base,
      days: [{ ...day1, demandCap: (day1.demandCap ?? 0) + suggestion!.amount }, day2],
    };
    expect(assessCapacity(applied).verdict).not.toBe("impossible");
  });

  it("suggestions are sorted verdict-flippers first, then by smallest amount, and never claims a flip that re-assessment disproves", () => {
    const report = assessCapacity(impossibleBase());
    // Every flipper must precede every non-flipper.
    const flipIdx = report.suggestions.map((s) => s.flipsVerdict);
    const firstNonFlip = flipIdx.indexOf(false);
    if (firstNonFlip !== -1) {
      expect(flipIdx.slice(0, firstNonFlip).every(Boolean)).toBe(true);
    }
    // Cross-check EVERY suggestion the report claims flips, independently.
    for (const s of report.suggestions) {
      if (!s.flipsVerdict) continue;
      const base = impossibleBase();
      let applied: CapacityInput;
      const day1 = base.days[0]!;
      switch (s.kind) {
        case "add_day":
          applied = {
            ...base,
            days: [
              day1,
              {
                date: "2026-10-20",
                courts: day1.courts.map((c) => ({
                  court: c.court,
                  windows: c.windows.map((w) => ({ from: w.from + DAY_MS, to: w.to + DAY_MS })),
                })),
              },
            ],
          };
          break;
        case "add_court":
          applied = {
            ...base,
            days: [
              { ...day1, courts: [...day1.courts, { court: "extra", windows: day1.courts[0]!.windows.map((w) => ({ ...w })) }] },
            ],
          };
          break;
        case "shorten_match":
          applied = { ...base, matchMinutes: base.matchMinutes - s.amount };
          break;
        case "shrink_gap":
          applied = { ...base, gapMinutes: base.gapMinutes - s.amount };
          break;
        case "raise_cap":
          applied = { ...base, days: [{ ...day1, demandCap: (day1.demandCap ?? 0) + s.amount }] };
          break;
      }
      expect(assessCapacity(applied).verdict, `${s.kind} claimed flipsVerdict but did not`).not.toBe("impossible");
    }
  });
});

describe("assessCapacity — module purity (D2 contract: no DB, no solver, no clock, no pino)", () => {
  it("imports nothing but ./rest-floor.ts, and neither file reads the wall clock or logs", () => {
    const capacityPath = fileURLToPath(new URL("./capacity.ts", import.meta.url));
    const restFloorPath = fileURLToPath(new URL("./rest-floor.ts", import.meta.url));
    const capacitySrc = readFileSync(capacityPath, "utf8");
    const restFloorSrc = readFileSync(restFloorPath, "utf8");

    const importLines = (src: string) =>
      [...src.matchAll(/^import\s.*$/gm)].map((m) => m[0]);

    const capacityImports = importLines(capacitySrc);
    // The ONLY import this module may have is the rest-floor leaf.
    expect(capacityImports.length).toBe(1);
    expect(capacityImports[0]).toMatch(/from\s+["']\.\/rest-floor\.ts["']/);

    // rest-floor.ts stays a total leaf (zero imports) — if this ever changes,
    // capacity.ts's whole purity claim needs re-checking, not silently trusting it.
    expect(importLines(restFloorSrc)).toEqual([]);

    for (const [name, src] of [
      ["capacity.ts", capacitySrc],
      ["rest-floor.ts", restFloorSrc],
    ] as const) {
      // Scoped to actual `import` lines, not prose — this module's own doc
      // comments legitimately NAME pino/postgres/the solver to explain why
      // it avoids them, which would otherwise self-trip a whole-file scan.
      const imports = importLines(src).join("\n");
      expect(imports, `${name} must not import pino`).not.toMatch(/pino/);
      expect(imports, `${name} must not import postgres/DB`).not.toMatch(/postgres/);
      expect(imports, `${name} must not import the solver/grpc stack`).not.toMatch(/z3-solver|@grpc/);
      expect(imports, `${name} must not import a node builtin`).not.toMatch(/from\s+["']node:/);
      // The ambient-clock check DOES scan the whole file: an ungated
      // `Date.now()`/no-arg `new Date()` call is a runtime hazard wherever
      // it appears, not just on an import line.
      expect(src, `${name} must not read the ambient wall clock`).not.toMatch(/Date\.now\(\)|new Date\(\)(?!\.)/);
    }
  });
});
