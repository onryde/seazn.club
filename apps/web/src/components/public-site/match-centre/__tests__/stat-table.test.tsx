// Spectator surface W1, whole-branch review fix round — `StatTable`
// accessibility.
//
// This workspace's vitest is `environment: "node"` (no jsdom), so these are
// `renderToStaticMarkup` assertions on real React SSR output. Nothing here
// measures a width, a focus ring or a contrast ratio: what a markup test CAN
// see is which element carries which role, scope and text, and that is exactly
// what the two defects below are about.
//
// ---------------------------------------------------------------------------
// Why this file exists (whole-branch review, Accessibility group)
// ---------------------------------------------------------------------------
//
//  1. THE NUMERIC HEADERS LOCALISED ONLY VIA `title`. `title` is a HOVER
//     affordance — a phone has none — and where a `<th>` has text content that
//     text WINS the accessible name, so the localised word in `title` was
//     never announced either. `scorecard-tab.tsx`'s own `Th` already does this
//     correctly (`sr-only` word + `aria-hidden` abbreviation); this primitive
//     did not, and the two sit three inches apart on the same tab.
//
//  2. THE NAME CELL WAS A `<td>`. In a stat table the name IS the row's header
//     — without `<th scope="row">` a screen reader reading "62" out of the
//     runs column cannot say whose 62 it is. `sets-tab.tsx:164` is the one
//     place on this surface that already got it right.
//
// ---------------------------------------------------------------------------
// Mutants killed
// ---------------------------------------------------------------------------
// Applied by hand to `../stat-table.tsx`, run, observed red, restored from a
// `cp` backup of the FIXED state — never `git checkout`, which on an
// uncommitted tree restores the index and deletes the work under test.
// `numTotalTests` stayed 534 under both, so neither is the collection-break
// shape that reads as a survivor.
//
//  (M4) NOTATION ONLY — the two spans replaced by a bare `{col.abbr}`, so the
//       localised word lives in `title` again and nowhere else.
//       → RED: "each numeric header ships an sr-only localised word…",
//         "witnessed in FRENCH…", and (in `summary-tab.test.tsx`) "the batters
//         table is table-fixed, every numeric header has an explicit width…".
//
//  (M5) THE NAME CELL BACK TO `<td>` — `<th scope="row">` reverted.
//       → RED: 'renders the name cell as <th scope="row">, never a <td>'.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import fr from "@/dictionaries/fr/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { StatTable, type StatColumn } from "../stat-table";

interface Row {
  name: string;
  runs: number;
  balls: number;
  fours: number;
}

const ROWS: Row[] = [
  { name: "R. Sharma", runs: 62, balls: 41, fours: 7 },
  { name: "S. Yadav", runs: 38, balls: 22, fours: 2 },
];

const COLUMNS: StatColumn<Row>[] = [
  { abbr: "R", titleKey: "matchCentre.col.runs", width: "w-7", cell: (r) => r.runs },
  { abbr: "B", titleKey: "matchCentre.col.balls", width: "w-7", cell: (r) => r.balls },
  { abbr: "4s", titleKey: "matchCentre.col.fours", width: "w-7", cell: (r) => r.fours, foldAtPhone: true },
];

const render = (dict: Dict): string =>
  renderToStaticMarkup(
    <StatTable<Row>
      dict={dict}
      captionKey="matchCentre.atTheCrease"
      nameTitleKey="matchCentre.col.batter"
      columns={COLUMNS}
      rows={ROWS}
      nameCell={(r) => r.name}
      rowKey={(r) => r.name}
    />,
  );

describe("StatTable — numeric column headers carry the localised word as TEXT, not only in `title`", () => {
  it("each numeric header ships an sr-only localised word and an aria-hidden abbreviation", () => {
    const html = render(en as Dict);
    for (const col of COLUMNS) {
      const label = en[col.titleKey as keyof typeof en] as string;
      expect(html, col.abbr).toContain(`<span class="sr-only">${label}</span>`);
      expect(html, col.abbr).toContain(`<span aria-hidden="true">${col.abbr}</span>`);
    }
    // The positive pair for "aria-hidden on the abbreviation": the notation is
    // still IN the markup — this folds it out of the accessibility tree, it
    // never removes it, and a sighted reader still reads "R", "B", "4s".
    expect(html).toContain(">R</span>");
  });

  it("witnessed in FRENCH, where the localised word and the English one differ", () => {
    // An English assertion cannot witness a dropped `t()` — the fallback dict
    // IS English. In French the right answer is a different string from the
    // English one, so a header that lost its localised text fails here.
    // `matchCentre.col.fours` specifically: French carries "Quatres" for it,
    // where `col.runs` is the same word in both and could not witness a
    // dropped lookup at all.
    const html = render(fr as Dict);
    const frFours = fr["matchCentre.col.fours"] as string;
    expect(frFours).not.toBe(en["matchCentre.col.fours"] as string); // the differential holds
    expect(html).toContain(`<span class="sr-only">${frFours}</span>`);
    expect(html).not.toContain(`<span class="sr-only">${en["matchCentre.col.fours"] as string}</span>`);
    // …and the notation is NOT translated — "notation, not copy" (see the
    // component's own doc comment). This is the negative half.
    expect(html).toContain('<span aria-hidden="true">4s</span>');
  });
});

describe("StatTable — the name cell is the ROW HEADER", () => {
  it('renders the name cell as <th scope="row">, never a <td>', () => {
    const html = render(en as Dict);
    // Both rows, not just the first: a guard applied to `rows[0]` alone would
    // pass a one-row assertion.
    expect((html.match(/<th scope="row"[^>]*data-testid="mc-stat-name-cell"/g) ?? []).length).toBe(ROWS.length);
    // The negative half — the name is no longer in a plain data cell.
    expect(html).not.toContain('<td data-testid="mc-stat-name-cell"');
    // …and the positive pair: the numeric cells ARE still `<td>`, or an
    // "everything is a header" mutant would pass the line above.
    expect((html.match(/<td /g) ?? []).length).toBe(ROWS.length * COLUMNS.length);
  });

  it("the row header still carries the name a reader sees", () => {
    const html = render(en as Dict);
    for (const row of ROWS) expect(html, row.name).toContain(`>${row.name}</span>`);
  });
});
