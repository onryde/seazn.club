// W5 app PR B, Task 7 (X-ADJ-4; C6; R24 pick 15 A): the adjustment footnote under a table, beside PR A's departure notes in one slot
// (`TableFootnotes`), on the division page's table (StandingsTable) and the hub's (buildTableView → StandingsTableView). The text is
// the R24 sentence ("Marsh Lane: −3 points, fielded an ineligible player, 16 Nov 2026."), under the table, outside its scroll.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StandingsRow } from "@seazn/engine/competition";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";
import type { AdjustmentNote } from "@/lib/points-adjustment-note";
import type { WithdrawalNote } from "@/lib/table-withdrawal-note";
import { buildTableView } from "@/server/public-site/standings-view";
import { StandingsTable } from "../standings-table";
import { StandingsTableView } from "../standings-table-view";
import { TableFootnotes } from "../table-footnotes";

const enMsg = (key: TKey, vars?: Record<string, string | number>) => t(en as Dict, key, vars);
const LONG = "Riverside Rovers Community Football Club 2nd";
const ROWS: StandingsRow[] = [
  { entrantId: "hv", played: 3, won: 3, drawn: 0, lost: 0, points: 9, metrics: {}, rank: 1 },
  { entrantId: "dp", played: 3, won: 1, drawn: 0, lost: 2, points: 3, metrics: {}, rank: 2 },
  { entrantId: "ml", played: 3, won: 1, drawn: 1, lost: 1, points: 1, metrics: {}, rank: 3 },
];
const NAMES = { hv: "Harbour Vale Reds", dp: "Dunmore Park", ml: LONG };
const AT = "2026-11-16T10:00:00.000Z";
const adj = (over: Partial<AdjustmentNote> = {}): AdjustmentNote => ({
  seq: 7,
  entrantId: "ml",
  name: LONG,
  delta: -3,
  unit: "points",
  pointsUnit: "whole",
  reason: "fielded an ineligible player",
  at: AT,
  ...over,
});
const withdrawal: WithdrawalNote = { entrantId: "dp", name: "Dunmore Park", status: "withdrawn", policy: "walkover", played: 3, scheduled: 3 };

describe("TableFootnotes", () => {
  it("the empty case: neither kind of note, nothing at all", () => {
    expect(renderToStaticMarkup(createElement(TableFootnotes, { withdrawals: [], adjustments: [] }))).toBe("");
  });
  it("both kinds, departures first, each in its own list", () => {
    const html = renderToStaticMarkup(
      createElement(TableFootnotes, {
        withdrawals: [{ entrantId: "dp", lead: "Dunmore Park (withdrawn):", body: "x" }],
        adjustments: [{ key: "7", entrantId: "ml", lead: "Marsh Lane:", body: "−3 points, r, 16 Nov 2026." }],
      }),
    );
    expect(html.indexOf("standings-withdrawal-notes")).toBeLessThan(html.indexOf("standings-adjustment-notes"));
    expect(html).toContain('data-testid="standings-adjustment-note-ml"');
  });
});

describe("the division page's table (StandingsTable)", () => {
  const render = (adjustmentNotes?: AdjustmentNote[], withdrawalNotes?: WithdrawalNote[]) =>
    renderToStaticMarkup(
      createElement(StandingsTable, {
        rows: ROWS,
        metricSpecs: [],
        cascade: ["points"],
        entrantNames: NAMES,
        entrantStatuses: { dp: "withdrawn" },
        dict: en as Dict,
        locale: "en",
        tz: "UTC",
        adjustmentNotes,
        withdrawalNotes,
      }),
    );
  it("prints the R24 sentence under the table, the long name in bold, wrapping", () => {
    const html = render([adj()]);
    expect(html).toContain(`<strong class="font-semibold text-ink">${LONG}:</strong> −3 points, fielded an ineligible player, 16 Nov 2026.`);
    expect(html).toMatch(/data-testid="standings-adjustment-note-ml" class="[^"]*\bbreak-words\b/);
    expect(html.indexOf('data-testid="standings-adjustment-notes"')).toBeGreaterThan(html.lastIndexOf("</table>"));
  });
  it("beside a departure note, in the same slot", () => {
    const html = render([adj()], [withdrawal]);
    expect(html).toContain('data-testid="standings-withdrawal-note-dp"');
    expect(html).toContain('data-testid="standings-adjustment-note-ml"');
  });
  it("a table with no adjustment prints no adjustment note (absent and empty alike)", () => {
    expect(render()).not.toContain("standings-adjustment-notes");
    expect(render([])).not.toContain("standings-adjustment-notes");
  });
});

describe("the hub's table (buildTableView → StandingsTableView)", () => {
  const view = (adjustmentNotes?: AdjustmentNote[]) =>
    buildTableView({
      id: "t1",
      division: { id: "d1", slug: "div", name: "Div" },
      caption: "League",
      rules: null,
      dateOf: (iso) => (iso === AT ? "16 Nov 2026" : null),
      fullHref: "/live/o/c/div?tab=standings",
      rows: ROWS,
      metricSpecs: [],
      cascade: ["points"],
      entrantNames: NAMES,
      entrantLogos: {},
      entrantColours: {},
      championIds: [],
      updatedAt: "2026-11-17T00:00:00.000Z",
      msg: enMsg,
      adjustmentNotes,
      locale: "en",
    });
  it("the builder resolves the line in the org's language and the full table prints it; the preview leaves it out", () => {
    const v = view([adj({ delta: -1, unit: "wins" })]);
    expect(v.adjustmentNotes).toEqual([{ key: "7", entrantId: "ml", lead: `${LONG}:`, body: "−1 win, fielded an ineligible player, 16 Nov 2026." }]);
    const html = renderToStaticMarkup(createElement(StandingsTableView, { view: v, dict: en as Dict, testid: "mh-table-t1" }));
    expect(html).toContain('data-testid="standings-adjustment-note-ml"');
    const preview = renderToStaticMarkup(createElement(StandingsTableView, { view: v, dict: en as Dict, testid: "mh-table-t1", preview: 3 }));
    expect(preview).not.toContain("standings-adjustment-notes");
  });
  it("no adjustment: the view carries no key", () => {
    expect(view()).not.toHaveProperty("adjustmentNotes");
    expect(view([])).not.toHaveProperty("adjustmentNotes");
  });
});
