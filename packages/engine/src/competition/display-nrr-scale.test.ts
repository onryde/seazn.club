// W2e Task 8c (owner D19; rule row CK-BO-2) - net run rate prints per OVER of the competition's own length, not per six balls.
//
// The Hundred is five-ball overs. The ECB's The Hundred Playing Conditions (effective 1 April 2026,
// https://resources.ecb.co.uk/ecb/document/2026/07/17/5c8379f1-a589-4a04-942f-b73ab42ca93d/The-Hundred-2026.pdf) say:
//   16.9.4(a) "A team's net run rate is calculated by deducting from the average runs per over scored by that team, the
//             average runs per over scored against that team."
//   17.1      "An over, wherever it is referred to in the Laws and Playing Conditions shall comprise 5 balls. Any reference
//             to 6 balls or 6 valid balls in the Laws shall be replaced by 5 balls and 5 valid balls respectively."
// So a Hundred table prints runs per FIVE balls, and a six-ball competition (T20, ODI) runs per six. The ledger is balls
// (`balls_faced_eff` / `balls_bowled_eff`), so the over length is the one fact the display needs.
//
// Every expected number below is worked by hand from those two clauses (overs = balls / balls-per-over, rate = runs /
// overs), and the over length each variant plays comes from the ENGINE's own declaration (`cricket.variants` through its
// `configSchema`), never a typed 5. The cascade ORDER is the integer cross-multiplication in tiebreakers.ts, which has no
// scale at all; the ordering tests below pin that it did not move and that the printed values are ordered the same way.
//
// Single-sport: net run rate and an over length exist only in cricket (the `nrr` key is cricket's; no other sport reads
// `ballsPerOver`). The last case of the first block shows the other derived keys ignore the length.
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "../core/types.ts";
// single-sport: net run rate and an over length (`ballsPerOver`) exist only in cricket.
import { cricket } from "../sports/cricket/cricket.ts";
import { reachableOutcomes, tableLayoutOf } from "./points.ts";
import { DEFAULT_BALLS_PER_OVER, PLAIN_LAYOUT, derivedMetricText } from "./display.ts";
import { foldResults, type StandingsRow } from "./standings.ts";
import { tieKeyValue, tieWhatIf } from "./tie-what-if.ts";
import { rankStandings } from "./tiebreakers.ts";

type Cfg = { ballsPerInnings: number | null; ballsPerOver: number };
const parsed = (variant: string): Cfg => cricket.configSchema.parse(cricket.variants[variant]);
const SIX = parsed("t20").ballsPerOver;
const FIVE = parsed("hundred").ballsPerOver;

function row(rf: number, bf: number, ra: number, bb: number): StandingsRow {
  return {
    entrantId: "X",
    played: 1,
    won: 0,
    drawn: 0,
    lost: 0,
    points: 0,
    metrics: { runs_for: rf, balls_faced_eff: bf, runs_against: ra, balls_bowled_eff: bb },
  };
}

describe("CK-BO-2 net run rate is runs per over of the competition's own length", () => {
  it("CK-BO-2 premises: The Hundred plays a different over from T20, and the display's default is cricket's own standard over", () => {
    expect(FIVE, "the Hundred's over").not.toBe(SIX);
    expect(DEFAULT_BALLS_PER_OVER, "the display's fallback is the schema's default over, not a second number").toBe(
      (cricket.configSchema.parse({}) as Cfg).ballsPerOver,
    );
    expect(PLAIN_LAYOUT.ballsPerOver).toBe(DEFAULT_BALLS_PER_OVER);
  });

  it("CK-BO-2 100 runs off 100 balls against 80 off 100: +1.000 per five-ball over, +1.200 per six-ball over", () => {
    // 16.9.4(a), over = 5 balls: 100 balls = 20 overs, so 100/20 = 5.000 scored and 80/20 = 4.000 conceded: +1.000.
    // Over = 6 balls: 100 balls = 16.667 overs, so 6.000 − 4.800 = +1.200 (the figure the display printed for every sport).
    const r = row(100, 100, 80, 100);
    expect(FIVE).toBe(5);
    expect(derivedMetricText(r, "nrr", FIVE)).toBe("+1.000");
    expect(derivedMetricText(r, "nrr", SIX)).toBe("+1.200");
    expect(derivedMetricText(r, "nrr"), "no length given: the pre-existing six").toBe("+1.200");
  });

  it("CK-BO-2 a side that faced fewer balls than it bowled, and the sign on the other side", () => {
    // 150 off 90 balls (18 overs of five: 8.333) against 120 off 100 balls (20 overs: 6.000): +2.333.
    // Six-ball overs: 150 off 15 overs = 10.000, 120 off 16.667 = 7.200: +2.800.
    expect(derivedMetricText(row(150, 90, 120, 100), "nrr", FIVE)).toBe("+2.333");
    expect(derivedMetricText(row(150, 90, 120, 100), "nrr", SIX)).toBe("+2.800");
    // The mirror image is the same magnitude, negative, with no plus sign.
    expect(derivedMetricText(row(120, 100, 150, 90), "nrr", FIVE)).toBe("-2.333");
    expect(derivedMetricText(row(120, 100, 150, 90), "nrr", SIX)).toBe("-2.800");
  });

  it("CK-BO-2 level ledgers print an unsigned zero, and no ledger prints a dash, at every over length", () => {
    for (const bpo of [FIVE, SIX]) {
      expect(derivedMetricText(row(90, 100, 90, 100), "nrr", bpo), `level, ${bpo}-ball overs`).toBe("0.000");
      expect(derivedMetricText(row(0, 0, 0, 0), "nrr", bpo), `no balls faced, ${bpo}-ball overs`).toBe("—");
      expect(derivedMetricText({ ...row(0, 0, 0, 0), metrics: {} }, "nrr", bpo), `no ledger, ${bpo}-ball overs`).toBe("—");
    }
  });

  it("CK-BO-2 every variant the engine declares prints runs per over of the over IT plays (swept; the variants disagree)", () => {
    const r = row(173, 120, 151, 118);
    let checked = 0;
    const lengths = new Set<number>();
    for (const variant of Object.keys(cricket.variants)) {
      const bpo = parsed(variant).ballsPerOver;
      // runs per over = runs / (balls / over length), the clause's own words; the table prints the difference.
      const perOver = 173 / (120 / bpo) - 151 / (118 / bpo);
      expect(derivedMetricText(r, "nrr", bpo), variant).toBe(`${perOver > 0 ? "+" : ""}${perOver.toFixed(3)}`);
      lengths.add(bpo);
      checked++;
    }
    expect(checked, "variants swept").toBe(Object.keys(cricket.variants).length);
    expect(checked).toBeGreaterThan(2);
    expect(lengths.size, "the sweep covers more than one over length").toBeGreaterThan(1);
  });

  it("CK-BO-2 a junk over length is refused, not printed (NaN / 0 / negative / fractional / infinite are no length)", () => {
    const r = row(100, 100, 80, 100);
    let refused = 0;
    for (const bad of [0, -5, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => derivedMetricText(r, "nrr", bad), String(bad)).toThrow(/over length/i);
      // a config refusal is CONFIG_INVALID (the engine's write-door convention), naming the value it refused
      expect(() => derivedMetricText(r, "nrr", bad), String(bad)).toThrow(
        expect.objectContaining({ name: "EngineError", code: "CONFIG_INVALID", data: { ballsPerOver: bad } }),
      );
      refused++;
    }
    expect(refused).toBe(5);
  });

  it("CK-BO-2 the other derived metrics ignore the over length (it is NRR's alone)", () => {
    const ledger: StandingsRow = {
      ...row(100, 100, 80, 100),
      metrics: { sets_won: 6, sets_lost: 4, points_won: 90, points_lost: 60, runs_for: 100, balls_faced_eff: 100, runs_against: 80, balls_bowled_eff: 100 },
    };
    let checked = 0;
    for (const key of ["set_ratio", "point_ratio", "set_diff", "point_diff"] as const) {
      expect(derivedMetricText(ledger, key, FIVE), key).toBe(derivedMetricText(ledger, key, SIX));
      expect(derivedMetricText(ledger, key, FIVE), key).toBe(derivedMetricText(ledger, key));
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("CK-BO-2 the table layout carries the over length", () => {
  const rule = cricket.tablePointsRule(parsed("hundred") as never, "league");
  const reach = reachableOutcomes(cricket, parsed("hundred"), "league");

  it("CK-BO-2 tableLayoutOf takes the over length, defaults to the engine's, and leaves apart/unit as they were", () => {
    const five = tableLayoutOf(rule, reach, FIVE);
    const dflt = tableLayoutOf(rule, reach);
    expect(five.ballsPerOver).toBe(FIVE);
    expect(dflt.ballsPerOver).toBe(DEFAULT_BALLS_PER_OVER);
    expect({ apart: five.apart, unit: five.unit }).toEqual({ apart: dflt.apart, unit: dflt.unit });
    expect({ apart: five.apart, unit: five.unit }).toEqual({ apart: PLAIN_LAYOUT.apart, unit: PLAIN_LAYOUT.unit });
  });

  it("CK-BO-2 tableLayoutOf refuses a junk over length", () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      expect(() => tableLayoutOf(rule, reach, bad), String(bad)).toThrow(/over length/i);
      expect(() => tableLayoutOf(rule, reach, bad), String(bad)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID", data: { ballsPerOver: bad } }),
      );
    }
  });
});

describe("CK-BO-2 the table's ORDER does not move, and its printed values are ordered the way it ranks", () => {
  // Four sides, two ties: every match is a tie (1 point each), so points are level and NRR splits all four. Per-ball margins:
  // A 1.5 − 1.2 = +0.3, C 1.3 − 1.2 = +0.1, D −0.1, B −0.3 (balls are 100 a side everywhere), so the rank is A, C, D, B.
  const side = (id: string, rf: number, ra: number): StandingsDelta => ({
    entrantId: id,
    played: 1,
    won: 0,
    drawn: 0,
    lost: 0,
    points: 1,
    metrics: { runs_for: rf, balls_faced_eff: 100, runs_against: ra, balls_bowled_eff: 100 },
  });
  const results: [StandingsDelta, StandingsDelta][] = [
    [side("A", 150, 120), side("B", 120, 150)],
    [side("C", 130, 120), side("D", 120, 130)],
  ];
  const cascade = ["points", "nrr"] as const;

  it("CK-BO-2 the rank is A, C, D, B by NRR whatever the over length, and the values print per over of each length", () => {
    const rows = rankStandings(foldResults(["A", "B", "C", "D"], results), { cascade, results }).rows;
    expect(rows.map((r) => r.entrantId)).toEqual(["A", "C", "D", "B"]);
    expect(rows.map((r) => r.tieBreak?.key), "every place was decided on NRR").toEqual(["nrr", "nrr", "nrr", "nrr"]);
    // five-ball overs: 5 × (per-ball margin); six-ball: 6 ×.
    expect(rows.map((r) => derivedMetricText(r, "nrr", FIVE))).toEqual(["+1.500", "+0.500", "-0.500", "-1.500"]);
    expect(rows.map((r) => derivedMetricText(r, "nrr", SIX))).toEqual(["+1.800", "+0.600", "-0.600", "-1.800"]);
    // The printed values, at either scale, descend down the table: the table never prints a number out of its own order.
    for (const bpo of [FIVE, SIX]) {
      const printed = rows.map((r) => Number(derivedMetricText(r, "nrr", bpo)));
      expect(printed, `${bpo}-ball overs`).toEqual([...printed].sort((a, b) => b - a));
      expect(new Set(printed).size, "no two sides print level").toBe(4);
    }
  });

  it("CK-BO-2 ranking takes no over length: the order does not depend on the order the sides were folded in", () => {
    const forward = rankStandings(foldResults(["A", "B", "C", "D"], results), { cascade, results }).rows.map((r) => r.entrantId);
    const reversed = rankStandings(foldResults(["D", "C", "B", "A"], results), { cascade, results }).rows.map((r) => r.entrantId);
    expect(forward).toEqual(["A", "C", "D", "B"]);
    expect(reversed).toEqual(forward);
  });

  it("CK-BO-2 the qualification what-if prints NRR on the same scale as the table (tieKeyValue / tieWhatIf)", () => {
    const rows = rankStandings(foldResults(["A", "B", "C", "D"], results), { cascade, results }).rows;
    const a = rows.find((r) => r.entrantId === "A")!;
    const b = rows.find((r) => r.entrantId === "B")!;
    expect(tieKeyValue(a, "nrr", FIVE)).toBe(derivedMetricText(a, "nrr", FIVE));
    expect(tieKeyValue(a, "nrr", FIVE)).toBe("+1.500");
    expect(tieKeyValue(a, "nrr")).toBe("+1.800");
    const opts = { winsOnly: false, primary: "points" as const };
    expect(tieWhatIf(a, b, cascade, { ...opts, ballsPerOver: FIVE })).toEqual({ kind: "rule", key: "nrr", mine: "+1.500", theirs: "-1.500" });
    expect(tieWhatIf(a, b, cascade, opts), "no length given: the pre-existing six").toEqual({ kind: "rule", key: "nrr", mine: "+1.800", theirs: "-1.800" });
  });
});
