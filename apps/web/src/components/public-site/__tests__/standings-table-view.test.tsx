// Spectator surface W2, Task 2 — `StandingsTableView` static-markup tests.
//
// `environment: "node"`, so this is real React SSR through
// `renderToStaticMarkup` (no jsdom in this repo — same convention as
// `bracket.test.tsx` and W1's `commentary-tab.test.tsx`). The component is
// `"use client"` for one reason, the phone disclosure's `useState`, and SSR
// renders its INITIAL (collapsed) state — which is exactly the state the
// phone composition has to be correct in for a spectator with no JS.
//
// Assertions anchor on `="` per AGENTS.md, and every negative ships with its
// positive pair.
//
// ---------------------------------------------------------------------------
// Mutants killed (Task 2) — component
// ---------------------------------------------------------------------------
//  (m) the `max-md:hidden` dropped from the `<td>` branch → the th/td pair.
//  (n) `colCls` folds COMPACT columns instead of long-tail ones → the
//      negative pair on `data-col="points"`.
//  (o) the disclosure rendered unconditionally → the all-compact view.
//  (p) the row testid emitted as a bare `mh-table-row-…` literal instead of
//      from the `testid` prefix → the prefix test (R-C: two tables for one
//      division would otherwise emit duplicate ids).
//  (q) `columnWidth`'s thresholds collapsed to one class → the width test.
//  (r) the `sr-only`/`aria-hidden` header pair replaced by bare notation →
//      the header-name test.
//  (s) `preview` ignored → the preview test.
//  (t) `showFullLink` ignored → its negative pair.
//  (u) `data-champion` hard-coded → its negative pair.
//  (v) cells rendered in reverse column order → the cell-alignment test.
//
// Every mutant compiles and collects; `numTotalTests` was pinned on each run.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { TableViewT } from "@/server/public-site/competition-hub-schema";
import { StandingsTableView } from "../standings-table-view";

const dict = en as Dict;
const TESTID = "mh-table-t1";

const view: TableViewT = {
  id: "t1",
  divisionId: "d1",
  divisionSlug: "div",
  divisionName: "Div",
  caption: "League",
  fullHref: "/shared/o/c/div?tab=standings",
  updatedAt: "2026-09-05T10:00:00Z",
  columns: [
    { key: "played", abbr: "P", title: "Played", compact: true },
    { key: "won", abbr: "W", title: "Won", compact: true },
    { key: "lost", abbr: "L", title: "Lost", compact: true },
    { key: "gd", abbr: "GD", title: "GD", compact: false },
    { key: "points", abbr: "Pts", title: "Points", compact: true },
  ],
  rows: [
    {
      rank: 1,
      entrantId: "a",
      name: "Bartholomew Ravindranath-Oyelaran-Whitaker XI",
      badgeUrl: null,
      cells: ["2", "2", "0", "4", "6"],
      tieBreakText: null,
      champion: true,
    },
    {
      rank: 2,
      entrantId: "b",
      name: "Beta",
      badgeUrl: "https://x/b.png",
      cells: ["2", "0", "2", "-4", "0"],
      tieBreakText: "Level with Alpha — separated on GD",
      champion: false,
    },
  ],
};

type Props = Parameters<typeof StandingsTableView>[0];
const html = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(
    <StandingsTableView view={view} dict={dict} testid={TESTID} {...over} />,
  );

/** The opening tag + contents of one row, so a negative assertion can be
 *  scoped to that row instead of to the whole document. */
const rowHtml = (h: string, entrantId: string): string => {
  const start = h.indexOf(`<tr data-testid="${TESTID}-row-${entrantId}"`);
  expect(start).toBeGreaterThan(-1);
  return h.slice(start, h.indexOf("</tr>", start));
};

describe("StandingsTableView — phone composition", () => {
  it("EMPTY rows → the empty-case copy, NO table and NO disclosure", () => {
    const h = html({ view: { ...view, rows: [] } });
    expect(h).toContain(`data-testid="${TESTID}-empty"`);
    expect(h).toContain(t(dict, "table.empty"));
    expect(h).not.toContain("<table");
    // The long tail exists in `columns` but there is nothing to reveal.
    expect(h).not.toContain(`data-testid="${TESTID}-more"`);
  });

  it("long-tail columns carry max-md:hidden on BOTH th and td; compact columns never do", () => {
    const h = html();
    expect(h).toMatch(/<th[^>]*data-col="gd"[^>]*class="[^"]*\smax-md:hidden"/);
    expect(h).toMatch(/<td[^>]*data-col="gd"[^>]*class="[^"]*\smax-md:hidden"/);
    // Positive pair for the fold: the compact columns are present at every
    // width, header and cell alike.
    expect(h).not.toMatch(/<th[^>]*data-col="points"[^>]*max-md:hidden/);
    expect(h).not.toMatch(/<td[^>]*data-col="points"[^>]*max-md:hidden/);
    expect(h).toMatch(/<th[^>]*data-col="points"[^>]*class="/);
  });

  it("the disclosure exists once per table, is md:hidden, announces its state and names what it controls", () => {
    const h = html();
    expect(h.match(new RegExp(`data-testid="${TESTID}-more"`, "g"))?.length).toBe(1);
    expect(h).toMatch(/data-testid="mh-table-t1-more"[^>]*aria-expanded="false"/);
    expect(h).toMatch(/data-testid="mh-table-t1-more"[^>]*aria-controls="mh-table-t1-scroll"/);
    // The `\s` before `md:hidden` is what stops this matching inside
    // `max-md:hidden` — AGENTS.md's phone-composition note.
    expect(h).toMatch(/data-testid="mh-table-t1-more"[^>]*class="[^"]*\smd:hidden"/);
    expect(h).toContain(t(dict, "table.more"));
    // AGENTS.md #23: a scrolling region owes a tabindex, a role and a name,
    // and tabindex cannot follow a media query, so all three are unconditional.
    expect(h).toMatch(/id="mh-table-t1-scroll"[^>]*role="region"[^>]*tabindex="0"[^>]*aria-label="League"/);
  });

  it("a table whose columns are ALL compact renders no disclosure (negative pair for the one above)", () => {
    const compactOnly: TableViewT = {
      ...view,
      columns: view.columns.filter((c) => c.compact),
      rows: view.rows.map((r) => ({ ...r, cells: [r.cells[0]!, r.cells[1]!, r.cells[2]!, r.cells[4]!] })),
    };
    const h = html({ view: compactOnly });
    expect(h).not.toContain(`data-testid="${TESTID}-more"`);
    // …but the table itself is still there.
    expect(h).toContain(`data-testid="${TESTID}-row-a"`);
  });

  it("every row testid derives from the `testid` prefix, so two tables for one division cannot collide", () => {
    const h = html();
    expect(h).toContain(`data-testid="${TESTID}-row-a"`);
    expect(h).toContain(`data-testid="${TESTID}-row-b"`);
    // The prefix is honoured, not decorative: a pool table for the same
    // division emits different ids for the same entrants.
    const pool = html({ testid: "mh-table-t2" });
    expect(pool).toContain(`data-testid="mh-table-t2-row-a"`);
    expect(pool).not.toContain(`data-testid="${TESTID}-row-a"`);
  });

  it("rows: rank chip, crest (img when badgeUrl, initials otherwise), truncating name, champion marker, tie-break", () => {
    const h = html();
    expect(h).toContain('src="https://x/b.png"');
    // `initials()` is first word + LAST word: "Bartholomew … XI" → "BX".
    expect(h).toContain(">BX<");
    expect(h).toMatch(
      /class="[^"]*truncate[^"]*"[^>]*>Bartholomew Ravindranath-Oyelaran-Whitaker XI</,
    );
    expect(rowHtml(h, "a")).toContain('data-champion="true"');
    expect(rowHtml(h, "b")).toContain('data-champion="false"');
    // The tie-break sentence is hover text AND real text: a `title` alone is
    // an affordance a phone does not have (W1's stat-table finding).
    expect(h).toContain('title="Level with Alpha — separated on GD"');
    expect(h).toMatch(/class="sr-only">Level with Alpha — separated on GD</);
    expect(rowHtml(h, "a")).not.toContain("sr-only\">Level with");
  });

  it("cells land under their own column — the i-th cell renders in the i-th column", () => {
    const b = rowHtml(html(), "b");
    // Order-differential: reversing the column loop would put "0" here and
    // "-4" under points.
    expect(b).toMatch(/<td[^>]*data-col="gd"[^>]*>-4</);
    expect(b).toMatch(/<td[^>]*data-col="points"[^>]*>0</);
    expect(b).toMatch(/<td[^>]*data-col="won"[^>]*>0</);
  });

  it("numeric headers ship the localised word as real sr-only text with the notation hidden from the a11y tree", () => {
    const h = html();
    // `<th>` text content wins the accessible name, so a `title` alone leaves
    // a screen reader announcing "GD" and never "Goal difference".
    expect(h).toMatch(/<th[^>]*data-col="points"[^>]*title="Points"/);
    expect(h).toContain('<span class="sr-only">Points</span>');
    expect(h).toContain("<span aria-hidden=\"true\">Pts</span>");
  });

  it("a column's width comes from its widest cell, not from a single class for every column", () => {
    const wide: TableViewT = {
      ...view,
      columns: [...view.columns, { key: "nrr", abbr: "NRR", title: "NRR", compact: false }],
      rows: view.rows.map((r, i) => ({ ...r, cells: [...r.cells, i === 0 ? "+1.000" : "—"] })),
    };
    const h = html({ view: wide });
    // "P" over one digit is the narrow class; "+1.000" needs the wide one.
    expect(h).toMatch(/<th[^>]*data-col="played"[^>]*class="w-8\s/);
    expect(h).toMatch(/<th[^>]*data-col="nrr"[^>]*class="w-14\s/);
    // Differential against a flat class: "Pts" is three characters wide and
    // lands between the two.
    expect(h).toMatch(/<th[^>]*data-col="points"[^>]*class="w-11\s/);
  });

  it("preview={1} renders one row plus the full-division link; showFullLink=false hides it (positive pair)", () => {
    const previewed = html({ preview: 1 });
    expect(previewed.match(new RegExp(`data-testid="${TESTID}-row-`, "g"))?.length).toBe(1);
    expect(previewed).toContain(`data-testid="${TESTID}-row-a"`);
    expect(previewed).not.toContain(`data-testid="${TESTID}-row-b"`);
    expect(previewed).toContain(`data-testid="${TESTID}-full"`);
    expect(previewed).toContain('href="/shared/o/c/div?tab=standings"');
    // Positive pair: with no preview every row renders.
    expect(html().match(new RegExp(`data-testid="${TESTID}-row-`, "g"))?.length).toBe(2);
    expect(html({ showFullLink: false })).not.toContain(`data-testid="${TESTID}-full"`);
  });
});
