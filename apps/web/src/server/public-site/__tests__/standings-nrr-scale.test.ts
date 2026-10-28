// W2e Task 8c (owner D19; rule row CK-BO-2) - the public tables print net run rate per OVER of the division's own length.
//
// The engine prints `runs per over` (ECB The Hundred Playing Conditions 2026, 16.9.4(a); an over is 5 balls, 17.1), and takes
// the over length as an argument (packages/engine display-nrr-scale.test.ts proves the arithmetic). What this file proves is
// that the web hands it the length: from the division's stored config, through the ONE loader (`stageTableRulesDocOf`, built
// from the stage's rows by `unpinnedRulesDoc`), its layout (`tableLayoutFor`), and both public tables - the hub's view
// (`buildTableView`) and the division page's component (`StandingsTable`, rendered to markup, since `environment: "node"`).
// Rows come from the engine's own `foldResults` / `rankStandings`, over the module's own cascade.
//
// Expected values are the rulebook's, worked by hand: a side that scored 100 off 100 balls and conceded 80 off 100 has
// 5.000 and 4.000 runs per five-ball over (+1.000), or 6.000 and 4.800 per six-ball over (+1.200). The over length each
// variant plays is the ENGINE's declaration (`cricket.variants` through its `configSchema`), never a number typed here.
//
// Cross-sport sweep: the loader runs over every shipped module and every config it declares (no other sport carries an over
// length, so its doc must carry none). The table cases are cricket's - net run rate exists only there.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "@seazn/engine/core";
import { DEFAULT_BALLS_PER_OVER, PLAIN_LAYOUT, foldResults, rankStandings, type StandingsRow } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { StandingsTable } from "@/components/public-site/standings-table";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";
import { buildTableView, cellText, tableColumns, tableLayoutFor, type TableViewInput } from "../standings-view";

const EN = en as unknown as Dict;
const NAMES: Record<string, string> = { A: "Ash", B: "Birch", C: "Cedar", D: "Dogwood" };

const cricket: AnySportModule = (() => {
  const m = builtinModules.find((x) => x.key === "cricket");
  if (m === undefined) throw new Error("premise: cricket is a built-in sport");
  return m;
})();
type Cfg = { ballsPerOver: number };
const overLength = (variant: string): number => (cricket.configSchema.parse(cricket.variants[variant]) as Cfg).ballsPerOver;
const FIVE = overLength("hundred");
const SIX = overLength("t20");
const docOf = (variant: string) => unpinnedRulesDoc({ module: cricket, divisionConfig: cricket.variants[variant] });

/** One tied match per pair, so points are level and NRR (the module's third step) decides all four places. A beats B 150-120
 *  by runs per ball, C beats D 130-120; balls are 100 a side. Per-ball margins: A +0.3, C +0.1, D -0.1, B -0.3. */
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
function ranked(variant: string): StandingsRow[] {
  return rankStandings(foldResults(["A", "B", "C", "D"], results), { cascade: docOf(variant).tiebreakers, results }).rows;
}
const ORDER = ["A", "C", "D", "B"];
// A: 5 x (1.5 - 1.2) = +1.5 per five-ball over; 6 x 0.3 = +1.8 per six-ball. C +0.5 / +0.6, D -0.5 / -0.6, B -1.5 / -1.8.
const FIVE_BALL = ["+1.500", "+0.500", "-0.500", "-1.500"];
const SIX_BALL = ["+1.800", "+0.600", "-0.600", "-1.800"];

const viewInput = (variant: string, rows: StandingsRow[], rules: ReturnType<typeof docOf> | null): TableViewInput => ({
  id: "t",
  division: { id: "d1", slug: "div", name: "Div" },
  caption: "League",
  fullHref: "/x",
  rows,
  metricSpecs: cricket.metrics,
  cascade: docOf(variant).tiebreakers,
  entrantNames: NAMES,
  entrantLogos: {},
  entrantColours: {},
  championId: null,
  updatedAt: "2026-10-28T10:00:00Z",
  msg: (k, v) => t(EN, k, v),
  rules,
  dateOf: () => null,
});
const nrrCells = (view: ReturnType<typeof buildTableView>): string[] => {
  const at = view.columns.findIndex((c) => c.key === "nrr");
  expect(at, "the NRR column is on the table").toBeGreaterThanOrEqual(0);
  return view.rows.map((r) => r.cells[at]!);
};

describe("CK-BO-2 the loader carries the division's over length", () => {
  it("CK-BO-2 premises: the Hundred plays a different over from T20, and a row's ordering is by NRR alone", () => {
    expect(FIVE).not.toBe(SIX);
    expect(ranked("hundred").map((r) => r.entrantId)).toEqual(ORDER);
    expect(ranked("hundred").map((r) => r.tieBreak?.key)).toEqual(["nrr", "nrr", "nrr", "nrr"]);
  });

  it("CK-BO-2 every shipped module x every config it declares: a doc carries the over length iff the sport's config has one", () => {
    let docs = 0;
    let withLength = 0;
    const lengths = new Set<number>();
    for (const sportModule of builtinModules) {
      for (const { name, cfg } of declaredCfgs<Record<string, unknown>>(sportModule as never)) {
        const doc = unpinnedRulesDoc({ module: sportModule, divisionConfig: cfg });
        const own = cfg.ballsPerOver;
        expect(doc.ballsPerOver, `${sportModule.key} ${name}`).toBe(typeof own === "number" ? own : undefined);
        docs++;
        if (doc.ballsPerOver !== undefined) {
          withLength++;
          lengths.add(doc.ballsPerOver);
          expect(sportModule.key, "only cricket carries an over").toBe("cricket");
        }
      }
    }
    expect(docs, "docs judged").toBeGreaterThan(builtinModules.length);
    expect(withLength, "docs that carry a length").toBe(Object.keys(cricket.variants).length + 1);
    expect(lengths.size, "both the Hundred's and the standard over are seen").toBeGreaterThan(1);
    expect(lengths.has(FIVE)).toBe(true);
  });

  it("CK-BO-2 the doc's over length is the division's: a stage's own rules do not move it, and a stored Hundred config reads five", () => {
    // The stored division config is `{...variant.config, ...overrides}`; ballsPerOver survives a stage that cuts the innings.
    const stored = { ...(cricket.variants.hundred as Record<string, unknown>), ballsPerInnings: 60 };
    const doc = unpinnedRulesDoc({ module: cricket, divisionConfig: stored, stageConfig: { rules: { ballsPerInnings: 40 } } });
    expect(doc.ballsPerOver).toBe(FIVE);
    // A config the sport cannot read carries none (the layout then prints the default), never a guess.
    const unreadable = (() => {
      try {
        return unpinnedRulesDoc({ module: cricket, divisionConfig: { ballsPerOver: -3 } }).ballsPerOver;
      } catch {
        return "refused" as const;
      }
    })();
    expect(unreadable === undefined || unreadable === "refused", `a junk over length is no over length (${String(unreadable)})`).toBe(true);
  });

  it("CK-BO-2 tableLayoutFor hands the layout the doc's length, or the default when the doc names none", () => {
    expect(tableLayoutFor(docOf("hundred")).ballsPerOver).toBe(FIVE);
    expect(tableLayoutFor(docOf("t20")).ballsPerOver).toBe(SIX);
    const { ballsPerOver: _dropped, ...bare } = docOf("hundred");
    void _dropped;
    expect(tableLayoutFor(bare).ballsPerOver, "an older cached doc has no length").toBe(DEFAULT_BALLS_PER_OVER);
    expect(tableLayoutFor(null)).toBe(PLAIN_LAYOUT);
    expect(tableLayoutFor(undefined)).toBe(PLAIN_LAYOUT);
  });
});

describe("CK-BO-2 both public tables print NRR per over of the division's length", () => {
  it("CK-BO-2 cellText: the Hundred prints per five-ball over, T20 per six, and a table with no rules per six", () => {
    const rows = ranked("hundred");
    const doc = docOf("hundred");
    const column = tableColumns(cricket.metrics, doc.tiebreakers, rows, tableLayoutFor(doc)).find((c) => c.key === "nrr")!;
    expect(column.kind).toBe("derived");
    const a = rows.find((r) => r.entrantId === "A")!;
    expect(cellText(a, column, tableLayoutFor(docOf("hundred")))).toBe("+1.500");
    expect(cellText(a, column, tableLayoutFor(docOf("t20")))).toBe("+1.800");
    expect(cellText(a, column, tableLayoutFor(null))).toBe("+1.800");
  });

  it("CK-BO-2 the hub's view (buildTableView): per-over values, and the SAME row order at either length", () => {
    const hundred = buildTableView(viewInput("hundred", ranked("hundred"), docOf("hundred")));
    const t20 = buildTableView(viewInput("t20", ranked("t20"), docOf("t20")));
    expect(hundred.rows.map((r) => r.entrantId), "Hundred order").toEqual(ORDER);
    expect(t20.rows.map((r) => r.entrantId), "T20 order").toEqual(ORDER);
    expect(nrrCells(hundred)).toEqual(FIVE_BALL);
    expect(nrrCells(t20)).toEqual(SIX_BALL);
    // The refused-rules table (no doc) is the default over, as it always was.
    expect(nrrCells(buildTableView(viewInput("t20", ranked("t20"), null)))).toEqual(SIX_BALL);
  });

  it("CK-BO-2 the division page's component (StandingsTable) prints the same cells as the hub's view", () => {
    const html = (variant: string, rows: StandingsRow[]) =>
      renderToStaticMarkup(
        createElement(StandingsTable, {
          rows,
          metricSpecs: cricket.metrics as never,
          cascade: docOf(variant).tiebreakers,
          entrantNames: NAMES,
          dict: EN,
          rules: docOf(variant),
          locale: "en",
          tz: "UTC",
        }),
      );
    const hundred = html("hundred", ranked("hundred"));
    const t20 = html("t20", ranked("t20"));
    for (const text of FIVE_BALL) expect(hundred, `Hundred prints ${text}`).toContain(`>${text}<`);
    for (const text of SIX_BALL) expect(t20, `T20 prints ${text}`).toContain(`>${text}<`);
    // …and not the other's: a component still dividing by six would print the T20 column for the Hundred.
    for (const text of SIX_BALL) expect(hundred, `Hundred must not print ${text}`).not.toContain(`>${text}<`);
    for (const text of FIVE_BALL) expect(t20, `T20 must not print ${text}`).not.toContain(`>${text}<`);
  });
});
