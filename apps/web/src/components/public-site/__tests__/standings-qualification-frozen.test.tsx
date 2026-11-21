// W5 app PR B Task 6 (X-QS-1, X-QS-2; R24 pick 17 A): a finished table, as the division page / embed / console table DRAWS it.
// The view is the REAL builder's over a finished league (not a literal: the literal-shaped placement is
// standings-qualification.test.tsx's job), so this proves the seam builder -> table: circle markers kept, the cut line in the
// past tense, the legend without "Still open" and its tick reading "Qualified", and the departed row wearing its chip with no
// marker. `environment: "node"`: markup only; the browser half is the e2e X-QS-1 and the 320/768/1280 screens.
//
// Expected words are R24 pick 17 A's, typed from the mock - never read back from the dictionary the builder resolves.
//
// single-sport (generic): the table draws whatever statuses the builder hands it; which sport produced them is the builder's
// concern, swept in qualification-view.test.ts.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { defaultOrderOf } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import { buildQualificationView, divisionAwardAddsToLedger, divisionPointsBounds, type QualFixture } from "@/server/public-site/qualification-view";
import { StandingsTable } from "../standings-table";

const GENERIC = builtinModules.find((m) => m.key === "generic")!;
const CFG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
const IDS = ["a", "b", "c", "d"];
const NAMES: Record<string, string> = { a: "Ada", b: "Bo", c: "Cy", d: "Di" };

let n = 0;
const won = (round: number, w: string, l: string): QualFixture => ({
  id: `f${++n}`,
  stage_id: "S",
  pool_id: null,
  round_no: round,
  status: "decided",
  home_entrant_id: w,
  away_entrant_id: l,
  outcome: { kind: "win", winner: w, loser: l },
  played: false,
});
/** Every line played: a 3 wins, b 2, c 1, d 0. */
const FIXTURES = [won(1, "a", "b"), won(1, "c", "d"), won(2, "a", "c"), won(2, "b", "d"), won(3, "a", "d"), won(3, "b", "c")];
const ROWS = IDS.map((id, i) => ({ entrantId: id, rank: i + 1, played: 3, won: 3 - i, drawn: 0, lost: i, points: 9 - 3 * i, metrics: { for: 3 - i, against: i, diff: 3 - 2 * i } }));

function frozenView(statuses: Record<string, string>) {
  return buildQualificationView({
    stage: { id: "S", kind: "league", meta: { qualifyCount: 2, qualifyPerGroup: false, nextStageName: "Finals", swissRounds: null, pointsRule: null, hasRankOverrides: false, tablePointsRule: null } },
    poolId: null,
    rows: ROWS,
    fixtures: FIXTURES,
    entrantStatuses: statuses,
    bounds: divisionPointsBounds(GENERIC, CFG)!,
    awardAddsToLedger: divisionAwardAddsToLedger(GENERIC, CFG),
    cascade: [...defaultOrderOf(GENERIC)],
    entrantNames: NAMES,
    msg: (k: TKey, v?: Record<string, string | number>) => t(en, k, v),
    plural: (k: string, c: number, v?: Record<string, string | number>) => plural(en, k, c, "en", v),
  });
}

const render = (statuses: Record<string, string>) =>
  renderToStaticMarkup(
    createElement(StandingsTable, {
      rows: ROWS,
      metricSpecs: [{ key: "for", label: "F" }, { key: "against", label: "A" }, { key: "diff", label: "D" }],
      cascade: ["points", "diff"],
      entrantNames: NAMES,
      entrantStatuses: statuses,
      caption: "League",
      dict: en as Dict,
      qualification: frozenView(statuses),
    } as Parameters<typeof StandingsTable>[0]),
  );

const legendOf = (html: string) => html.slice(html.indexOf('data-testid="qual-legend"'), html.indexOf("</p>", html.indexOf('data-testid="qual-legend"')));
const markersOf = (html: string) => [...html.matchAll(/data-qual-marker="([a-z_]+)"/g)].map((m) => m[1]);

describe("X-QS-1 a finished table as the table draws it (W5 Task 6, R24 pick 17 A)", () => {
  const ALL_IN = Object.fromEntries(IDS.map((id) => [id, "confirmed"]));

  it("the finished table keeps its cut line, in the past tense", () => {
    const html = render(ALL_IN);
    expect(html).toContain('data-testid="qual-cut"');
    expect(html).toContain("Top 2 went through to Finals");
    expect(html, "never the live line").not.toContain("Top 2 go through");
  });

  it("the legend: the tick reads Qualified, Out stays, Still open is gone", () => {
    const legend = legendOf(render(ALL_IN));
    expect(legend.length, "premise: the legend is drawn").toBeGreaterThan(0);
    expect(legend).toContain("Qualified");
    expect(legend).toContain("Out");
    expect(legend).not.toContain("Still open");
    // the legend's own markers: the tick and the dash, never the open circle
    expect(markersOf(legend)).toEqual(["through", "out"]);
  });

  it("every row still in the field keeps its circle marker: two ticks, two dashes (rows + legend counted apart)", () => {
    const html = render(ALL_IN);
    const legend = legendOf(html);
    const rows = markersOf(html.replace(legend, ""));
    expect(rows, "4 rows checked").toHaveLength(4);
    expect(rows).toEqual(["through", "through", "out", "out"]);
    expect(html).toContain('aria-label="Rank 1, Qualified, show details"');
    expect(html).toContain('aria-label="Rank 3, Out, show details"');
  });

  it("X-QS-2 the departed row wears its Withdrawn chip and no marker; the backfill reads Qualified", () => {
    const html = render({ ...ALL_IN, b: "withdrawn" });
    const legend = legendOf(html);
    const rows = markersOf(html.replace(legend, ""));
    expect(rows, "3 rows marked (b has none)").toEqual(["through", "through", "out"]);
    expect(html).toContain("Withdrawn");
    expect(html).toContain('aria-label="Rank 3, Qualified, show details"');
    expect(html).not.toContain('aria-label="Rank 2, ');
  });
});
