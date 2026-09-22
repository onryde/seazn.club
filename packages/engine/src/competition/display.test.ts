// Standings display helpers — doc 09 §2 (PROMPT-12).
import { describe, expect, it } from "vitest";
import type { StandingsRow } from "./standings.ts";
import { derivedMetricText, tieBreakLabel, DERIVED_METRICS, RATIO_LEDGERS } from "./display.ts";

function row(metrics: Record<string, number>): StandingsRow {
  return { entrantId: "X", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics };
}

describe("derivedMetricText (doc 09 §2)", () => {
  it("NRR from the integer ledger, signed, 3 decimals", () => {
    // 250 runs off 300 balls (5.0/over) vs 200 off 300 (4.0/over) ⇒ +1.000
    const r = row({
      runs_for: 250,
      balls_faced_eff: 300,
      runs_against: 200,
      balls_bowled_eff: 300,
    });
    expect(derivedMetricText(r, "nrr")).toBe("+1.000");
  });

  it("NRR before any play is a dash, negative NRR unsigned-minus", () => {
    expect(derivedMetricText(row({}), "nrr")).toBe("—");
    const losing = row({
      runs_for: 200,
      balls_faced_eff: 300,
      runs_against: 250,
      balls_bowled_eff: 300,
    });
    expect(derivedMetricText(losing, "nrr")).toBe("-1.000");
  });

  it("set ratio: finite, unbeaten (∞) and no-data (—)", () => {
    expect(derivedMetricText(row({ sets_won: 6, sets_lost: 4 }), "set_ratio")).toBe("1.50");
    expect(derivedMetricText(row({ sets_won: 6, sets_lost: 0 }), "set_ratio")).toBe("∞");
    expect(derivedMetricText(row({}), "set_ratio")).toBe("—");
  });

  it("each ratio divides its OWN won/lost pair, the one RATIO_LEDGERS declares", () => {
    // Every pair differs, so a ratio reading a neighbour's ledger (the point
    // ratio off the sets, say) prints a different number rather than passing
    // by coincidence. The standings popover shows these same two totals
    // beside the ratio, so the pair is declared once and read by both.
    const r = row({
      sets_won: 4,
      sets_lost: 2,
      boards_won: 7,
      boards_lost: 3,
      points_won: 150,
      points_lost: 160,
    });
    expect(derivedMetricText(r, "set_ratio")).toBe("2.00");
    expect(derivedMetricText(r, "board_ratio")).toBe("2.33");
    expect(derivedMetricText(r, "point_ratio")).toBe("0.94");
    expect(RATIO_LEDGERS).toEqual({
      set_ratio: ["sets_won", "sets_lost"],
      board_ratio: ["boards_won", "boards_lost"],
      point_ratio: ["points_won", "points_lost"],
    });
    for (const [key, [won, lost]] of Object.entries(RATIO_LEDGERS)) {
      expect(derivedMetricText(r, key as keyof typeof RATIO_LEDGERS), key).toBe(
        (r.metrics[won]! / r.metrics[lost]!).toFixed(2),
      );
    }
  });

  it("point and board ratio share set ratio's edges: unbeaten is ∞, no ledger is —", () => {
    expect(derivedMetricText(row({ points_won: 50, points_lost: 0 }), "point_ratio")).toBe("∞");
    expect(derivedMetricText(row({}), "point_ratio")).toBe("—");
    expect(derivedMetricText(row({ points_won: 0, points_lost: 42 }), "point_ratio")).toBe("0.00");
    expect(derivedMetricText(row({ boards_won: 9, boards_lost: 0 }), "board_ratio")).toBe("∞");
    expect(derivedMetricText(row({}), "board_ratio")).toBe("—");
  });

  it("buchholz columns render half-steps from materialised metrics", () => {
    expect(derivedMetricText(row({ buchholz_cut1: 7.5 }), "buchholz_cut1")).toBe("7½");
    expect(derivedMetricText(row({ buchholz_cut1: 7 }), "buchholz_cut1")).toBe("7");
    expect(derivedMetricText(row({}), "buchholz_cut1")).toBeNull();
  });

  it("sberger trims trailing zeros", () => {
    expect(derivedMetricText(row({ sberger: 12.25 }), "sberger")).toBe("12.25");
    expect(derivedMetricText(row({ sberger: 12 }), "sberger")).toBe("12");
  });
});

describe("tieBreakLabel", () => {
  it("maps known keys to human phrasing and falls back to the raw key", () => {
    expect(tieBreakLabel("h2h_points")).toBe("head-to-head");
    expect(tieBreakLabel("lots")).toBe("drawing of lots");
    expect(tieBreakLabel("mystery")).toBe("mystery");
  });
});

describe("DERIVED_METRICS", () => {
  it("covers every cascade key the dashboard can render as a column", () => {
    expect(DERIVED_METRICS.map((m) => m.key)).toEqual([
      "nrr",
      "set_ratio",
      "board_ratio",
      "point_ratio",
      "buchholz_cut1",
      "buchholz",
      "sberger",
    ]);
  });
});
