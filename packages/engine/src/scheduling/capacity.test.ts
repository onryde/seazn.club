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
  type CapacityVerdict,
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

describe("assessCapacity — the per-day union is computed once per day, not once per entrant-day", () => {
  // P10 Task 5 review. The rest-bound loop called `dayUnionMinutes(day)` once
  // per ENTRANT per day, so cost grew as entrants × days for an answer that
  // depends only on the day. That was affordable while this ran in one browser
  // over one board; §4 puts it behind a POST endpoint accepting up to 2000
  // fixtures and 4000 days, on a session-authenticated route with no
  // per-request throttle.
  //
  // Counting calls directly would mean reaching into a module-private function,
  // so this measures the observable consequence instead: the same day object
  // shared by many entrants must not multiply the work. A getter on `courts`
  // counts how many times the day's windows are actually read.
  it("reads each day's windows the same number of times for 50 entrants as for 400", () => {
    const readsFor = (entrantCount: number): { reads: number; bounds: number } => {
      let reads = 0;
      const windows = [{ from: DAY1, to: DAY1 + 600 * MS_PER_MIN }];
      const day = {
        date: "2026-10-19",
        get courts() {
          reads++;
          return [{ court: "Court 1", windows }];
        },
      };
      const report = assessCapacity({
        matchMinutes: 60,
        gapMinutes: 15,
        perEntrantMinRest: 0,
        fixtureCount: entrantCount,
        days: [day],
        entrants: Array.from({ length: entrantCount }, (_, i) => ({
          entrantId: `E${i}`,
          fixtures: 1,
        })),
      });
      // Every entrant still gets a real bound — this must not pass by doing
      // nothing.
      expect(report.restBound.every((b) => b.available === 600)).toBe(true);
      return { reads, bounds: report.restBound.length };
    };

    const small = readsFor(50);
    const large = readsFor(400);
    expect(small.bounds).toBe(50);
    expect(large.bounds).toBe(400);
    // The assertion is INVARIANCE, not a magic ceiling: other passes (the
    // supply walk, the day cap) legitimately read the day too, and pinning
    // their exact count would just break on unrelated edits. Pre-fix this
    // grew one read per entrant, so 400 entrants read 8× what 50 did.
    expect(large.reads).toBe(small.reads);
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

describe("assessCapacity — per-day FLOOR (fixtures a rule nails to one day)", () => {
  /** Two roomy days, 6 slots each, 12 total — ample for 8 fixtures on the
   *  totals alone. The point of every test here is that the totals are not
   *  the whole story once a rule says WHICH day a fixture must land on. */
  const twoRoomyDays = (forcedOnDay1?: number): CapacityDay[] => [
    { ...oneCourtDay("2026-10-19", DAY1, 240), ...(forcedOnDay1 !== undefined ? { forcedDemand: forcedOnDay1 } : {}) },
    oneCourtDay("2026-10-20", DAY1 + DAY_MS, 240),
  ];

  const base = (days: CapacityDay[], fixtureCount: number): CapacityInput => ({
    matchMinutes: 30,
    gapMinutes: 10, // slot = 40 -> floor((240+10)/40) = 6 per day
    perEntrantMinRest: 0,
    fixtureCount,
    days,
    entrants: [],
  });

  // CONTROL, not proof. This passes with the floor removed entirely — it
  // has to, because the point is that a floor which FITS changes nothing.
  // Labelled because a reader scanning the block would otherwise count it
  // as evidence the floor works, and it is evidence of the opposite:
  // evidence the floor does not fire when it should not.
  it("CONTROL — stays ok when the forced fixtures fit inside their own day", () => {
    const report = assessCapacity(base(twoRoomyDays(6), 8));
    expect(report.slotSupply).toBe(12);
    // 6 nailed to day 1 (its exact capacity), 2 free, 6 free slots on day 2.
    expect(report.verdict).toBe("ok");
  });

  it("is impossible when ONE day is nailed past its own capacity, even though total supply is ample", () => {
    // This is the case a total-supply check cannot see, and the reason the
    // floor exists: 12 slots for 8 fixtures looks comfortable, but 7 of them
    // can only go on a day that holds 6. The 7th is unplaceable and no amount
    // of slack on day 2 can absorb it.
    const report = assessCapacity(base(twoRoomyDays(7), 8));
    expect(report.slotSupply).toBe(12);
    expect(report.slotDemand).toBe(8);
    expect(report.verdict).toBe("impossible");
  });

  it("the SAME board with those fixtures free instead of nailed is ok — the floor is doing the work, not the arithmetic", () => {
    // Identical supply and demand; the only difference is `forcedDemand`.
    // Without this pairing the test above would also pass if the change had
    // simply made the whole module stricter.
    const report = assessCapacity(base(twoRoomyDays(undefined), 8));
    expect(report.slotSupply).toBe(12);
    expect(report.slotDemand).toBe(8);
    expect(report.verdict).toBe("ok");
  });

  // CONTROL, not proof — also passes with the floor removed. It guards the
  // double-count regression specifically (forced demand PLUS the same
  // fixtures again as free demand would read 24 against 12 and cry
  // impossible), which is a failure mode of the FIX, not of its absence.
  it("CONTROL — counts a forced fixture once, not twice: a fully-nailed board that exactly fits is not impossible", () => {
    // Every fixture nailed, 6 to each day, 12 slots. If the walk double
    // counted (forced demand PLUS the same fixtures again as free demand) it
    // would see 24 against 12 and cry impossible.
    const days: CapacityDay[] = [
      { ...oneCourtDay("2026-10-19", DAY1, 240), forcedDemand: 6 },
      { ...oneCourtDay("2026-10-20", DAY1 + DAY_MS, 240), forcedDemand: 6 },
    ];
    const report = assessCapacity(base(days, 12));
    expect(report.verdict).not.toBe("impossible");
  });

  it("a per-day rule CAP still binds a forced fixture — the floor cannot push past the ceiling", () => {
    // Day 1 holds 6 by court supply but a max_fixtures_per_day rule caps it
    // at 2, and 4 fixtures are nailed to it. The cap is what binds.
    const days: CapacityDay[] = [
      { ...oneCourtDay("2026-10-19", DAY1, 240, 2), forcedDemand: 4 },
      oneCourtDay("2026-10-20", DAY1 + DAY_MS, 240),
    ];
    const report = assessCapacity(base(days, 6));
    expect(report.verdict).toBe("impossible");
  });

  it("an over-counted floor cannot wrap negative and hide a real shortfall", () => {
    // Defensive: a caller that reports more forced than the board has
    // fixtures must not produce a negative free demand that cancels the
    // overflow. 20 nailed to a 6-slot day is impossible however it is
    // counted.
    const report = assessCapacity(base(twoRoomyDays(20), 8));
    expect(report.verdict).toBe("impossible");
  });
});

describe("assessCapacity — raise_cap points at the day the cap is actually blocking", () => {
  it("prefers the day whose CAP blocks forced work over an unrelated day with a wider cap/supply gap", () => {
    // Day 1: 6 slots, capped at 5, with 6 fixtures nailed to it. The cap is
    // one short of holding the forced work, so raising it is the only move
    // that can flip the verdict.
    // Day 2: 6 slots, capped at 1 — a WIDER (supply − cap) deficit of 5 vs
    // day 1's 1, and nothing forced. Ranking on deficit alone picks this
    // one, and raising its cap cannot flip anything.
    const days: CapacityDay[] = [
      { ...oneCourtDay("2026-10-19", DAY1, 240, 5), forcedDemand: 6 },
      oneCourtDay("2026-10-20", DAY1 + DAY_MS, 240, 1),
    ];
    const input: CapacityInput = {
      matchMinutes: 30,
      gapMinutes: 10,
      perEntrantMinRest: 0,
      fixtureCount: 7,
      days,
      entrants: [],
    };
    const report = assessCapacity(input);
    expect(report.verdict).toBe("impossible");

    const raise = report.suggestions.find((s) => s.kind === "raise_cap");
    expect(raise, "no raise_cap suggestion was offered at all").toBeDefined();
    // `CapacitySuggestion` is {kind, amount, flipsVerdict} — it does NOT
    // carry the date, so which day was chosen is observable only through
    // whether the suggestion actually works. That is the right assertion
    // anyway: ranking on deficit alone picks day 2, whose cap +1 changes
    // nothing, and `flipsVerdict` is a live re-computation (suggestionsFor
    // re-runs computeCore on the candidate), not a claim.
    expect(raise!.flipsVerdict).toBe(true);

    // Independent re-derivation, so this does not rest on the module's own
    // bookkeeping: raising DAY 1's cap by one fixes the board, raising day
    // 2's does not. If the ranking ever picks day 2 again, the assertion
    // above goes false and these two show why.
    const raiseDay = (date: string): CapacityVerdict =>
      assessCapacity({
        ...input,
        days: input.days.map((d) =>
          d.date === date ? { ...d, demandCap: (d.demandCap ?? 0) + 1 } : d,
        ),
      }).verdict;
    expect(raiseDay("2026-10-19")).not.toBe("impossible");
    expect(raiseDay("2026-10-20")).toBe("impossible");
  });
});
