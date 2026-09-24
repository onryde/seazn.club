// Standings qualification status on the competition hub's Table tab (spec
// 2026-09-22 §5, Option B; plan Task 8): the marker in the rank cell, the cut
// line after place N, the legend under the table, and the rank popover —
// status headline, "if you lose", the existing tie note, the what-if and its
// assumption, in that order, in ONE popover per rank cell.
//
// `environment: "node"`, so this is `renderToStaticMarkup`. It sees which
// cells became triggers, what each trigger is named, where the cut row sits,
// which of its cells fold at which width, and what the closed panel holds. It
// cannot see the 40px hit area, the panel flipping upward or the page
// scrolling sideways: those were measured in a browser at 1280/768/320 (the
// probe `e2e/standings-qualification-layout.spec.ts`, task-8 report).
//
// The no-cut goldens (`__snapshots__/standings-table-view-no-cut*.html`) were
// CAPTURED by running this file against the table as it stood before Task 8,
// not written from reading the source. "A table with no cut renders
// byte-for-byte as it does today" is therefore a comparison with yesterday's
// output, not with whatever the new code prints for null.
// P4 (option C, 2026-09-24) re-captured both deliberately: the only bytes
// that moved are the name span's three `max-md:` two-line clamp classes.
// Stripping those back out of the new goldens gives the old ones byte for
// byte, so nothing else in the no-cut path changed. Ruling (a) the same day
// re-captured both again for a fourth, `max-md:hyphens-auto`; stripping that
// gives the P4 goldens byte for byte. Ruling (d) re-captured both once more:
// the phone floor `--sv-min` grew by the name's 7.5rem floor (120 − 96 = 24px:
// 284 → 308 full, 220 → 244 preview); writing the old value back gives the
// ruling-(a) goldens byte for byte, and `--sv-min-md` did not move.
//
// ---------------------------------------------------------------------------
// Mutants killed (task-8 report has the run log)
// ---------------------------------------------------------------------------
//  (1) the marker not rendered in the rank cell → "each row's marker".
//  (2) the cut row after the wrong row → "the cut line sits after place N".
//  (3) `ariaLabel` not passed to the popover → "each trigger is named".
//  (4) the legend shown on the preview → the legend pair, and the tab pair.
//  (5) the cut row spanning every column at every width (the brief's
//      `2 + view.columns.length`) → "the cut row's cells fold with the header".
//  (6) the no-cut path changed in any byte → the goldens.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { QualRowT, QualTableT, TableRowT, TableViewT } from "@/server/public-site/competition-hub-schema";
import { StandingsTableView } from "../standings-table-view";
import { QualCutRow } from "../qualification-bits";
import { OverviewTab } from "../matches-hub/overview-tab";
import { TableTab } from "../matches-hub/table-tab";
import { hubDoc, m, tableView } from "./hub-fixtures";

const dict = en as Dict;
const TESTID = "mh-table-t1";

const RATIO_NOTE = "Points won 140 · Points lost 100 · Ratio 1.40";
const TIE = "Level with Cy on points — separated on point ratio";

/** The hub's real column shape for a cascade: points, THEN the derived
 *  column, with a long tail (GD, PR) that folds below `md`. Two long-tail
 *  columns, because a single one cannot tell "every column" from "every
 *  column but one" in the cut row's arithmetic. */
const COLUMNS: TableViewT["columns"] = [
  { key: "played", abbr: "P", title: "Played", compact: true },
  { key: "won", abbr: "W", title: "Won", compact: true },
  { key: "lost", abbr: "L", title: "Lost", compact: true },
  { key: "gd", abbr: "GD", title: "Goal difference", compact: false },
  { key: "points", abbr: "Pts", title: "Points", compact: true },
  { key: "point_ratio", abbr: "PR", title: "Point ratio", compact: false },
];

const NAMES: Record<string, string> = { a: "Ada", b: "Bo", c: "Cy", d: "Di", e: "Ed", f: "Flo" };

const row = (entrantId: string, rank: number, points: number, over: Partial<TableRowT> = {}): TableRowT => ({
  rank,
  entrantId,
  name: NAMES[entrantId]!,
  badgeUrl: null,
  colour: null,
  cells: ["4", String(points / 3), String(4 - points / 3), String(points - 4), String(points), "1.00"],
  cellNotes: [null, null, null, null, null, null],
  tieBreakText: null,
  qual: null,
  champion: false,
  ...over,
});

/** Six rows: a leader whose ratio cell opens a note, a tied row across the
 *  line, and a departed entrant in last who has a row but never a status. */
const ROWS: TableRowT[] = [
  row("a", 1, 12, { cellNotes: [null, null, null, null, null, RATIO_NOTE] }),
  row("b", 2, 9, { tieBreakText: TIE }),
  row("c", 3, 9),
  row("d", 4, 6),
  row("e", 5, 0),
  row("f", 6, 0),
];

const BASE: TableViewT = {
  id: "t1",
  divisionId: "d1",
  divisionSlug: "div",
  divisionName: "Div",
  caption: "League",
  fullHref: "/shared/o/c/div?tab=standings",
  updatedAt: "2026-09-22T10:00:00Z",
  columns: COLUMNS,
  rows: ROWS,
  qualification: null,
};

const WHAT_IF = "If you finish level on points with Cy, point ratio decides: lose your next match by no more than 4 to finish ahead.";
const ASSUMES = "Assumes Cy's figures stay the same and your next match is an average one.";
const TABLE: QualTableT = {
  cutIndex: 2,
  label: "Top 2 go through to Finals · 1 round left",
  legend: { through: "Through", open: "Still open", out: "Out", hint: "Tap a rank for details." },
};
const QUALS: Record<string, QualRowT> = {
  a: { status: "through", label: "Through", ariaLabel: "Rank 1, Through, show details", headline: "Through to Finals, whatever happens next.", ifYouLose: null, whatIf: null, whatIfAssumption: null },
  b: { status: "win_k", label: "Win and in", ariaLabel: "Rank 2, Win and in, show details", headline: "Win your next match and you're through to Finals.", ifYouLose: t(dict, "table.qual.ifYouLose.needsHelp"), whatIf: WHAT_IF, whatIfAssumption: ASSUMES },
  c: { status: "needs_help", label: "Needs help", ariaLabel: "Rank 3, Needs help, show details", headline: "Still open: you need other results to go your way.", ifYouLose: t(dict, "table.qual.ifYouLose.out"), whatIf: null, whatIfAssumption: null },
  d: { status: "needs_help", label: "Needs help", ariaLabel: "Rank 4, Needs help, show details", headline: "Still open: you need other results to go your way.", ifYouLose: t(dict, "table.qual.ifYouLose.out"), whatIf: null, whatIfAssumption: null },
  e: { status: "out", label: "Out", ariaLabel: "Rank 5, Out, show details", headline: "Can no longer finish in the top 2.", ifYouLose: null, whatIf: null, whatIfAssumption: null },
};

/** The same table with a cut: the view's line and legend, and each row's
 *  status — Flo, departed, keeps `qual: null` as the builder leaves her. */
const withCut = (table: QualTableT = TABLE): TableViewT => ({
  ...BASE,
  qualification: table,
  rows: ROWS.map((r) => ({ ...r, qual: QUALS[r.entrantId] ?? null })),
});

type Props = Parameters<typeof StandingsTableView>[0];
const render = (view: TableViewT, over: Partial<Props> = {}) =>
  renderToStaticMarkup(<StandingsTableView view={view} dict={dict} testid={TESTID} {...over} />);

/** The `<tbody>`'s rows, in order, each as its own markup. */
function bodyRows(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  return [...body.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) => m[0]);
}
const rowOf = (html: string, id: string) => {
  const hit = bodyRows(html).find((r) => r.includes(`data-testid="${TESTID}-row-${id}"`));
  expect(hit, `no body row for ${id}`).toBeDefined();
  return hit!;
};
/** A row's rank cell: its first `<td>`. */
const rankCell = (tr: string) => tr.slice(tr.indexOf("<td"), tr.indexOf("</td>") + 5);
const buttonIn = (cell: string) => /<button[^>]*>/.exec(cell)?.[0] ?? "";
/** The panel the button's `aria-controls` names, to the end of its cell. */
function panelOf(html: string, button: string): string {
  const id = /aria-controls="([^"]*)"/.exec(button)![1]!;
  const at = html.indexOf(` id="${id}"`);
  expect(at, `aria-controls names no element: ${id}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf("</td>", at));
}
/** A string as React writes it into text: "you're" is `you&#x27;re`. */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const classesOf = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(" ");

describe("StandingsTableView — no cut renders exactly as before Task 8", () => {
  it("the full table with no qualification is byte-for-byte the pre-Task-8 golden", async () => {
    await expect(render(BASE)).toMatchFileSnapshot("./__snapshots__/standings-table-view-no-cut.html");
  });

  it("the Overview preview with no qualification is byte-for-byte the pre-Task-8 golden", async () => {
    await expect(render(BASE, { preview: 3 })).toMatchFileSnapshot(
      "./__snapshots__/standings-table-view-no-cut-preview.html",
    );
  });

  it("…and carries none of the qualification markup; its positive pair does", () => {
    const none = render(BASE);
    const cut = render(withCut());
    for (const probe of ['data-testid="qual-cut"', 'data-testid="qual-legend"', 'data-qual-marker="', 'data-qual="', 'aria-label="Rank ']) {
      expect(none, probe).not.toContain(probe);
      expect(cut, probe).toContain(probe);
    }
  });

  it("the tied row's trigger keeps its accessible name: no aria-label, the rank and an aria-hidden asterisk", () => {
    const cell = rankCell(rowOf(render(BASE), "b"));
    const button = buttonIn(cell);
    expect(button).toContain(`data-testid="${TESTID}-tie-b"`);
    expect(button).not.toContain("aria-label=");
    const inner = cell.slice(cell.indexOf(button) + button.length, cell.indexOf("</button>"));
    expect(inner).toMatch(/^<span class="[^"]*">2<\/span><span aria-hidden="true" class="[^"]*">\*<\/span>$/);
    // The panel is the tie sentence itself, not a qualification body.
    const panel = panelOf(render(BASE), button);
    expect(panel).toContain(`>${esc(TIE)}<`);
    expect(panel).not.toContain('data-testid="qual-');
  });
});

describe("StandingsTableView — with a cut (spec §5, Option B)", () => {
  const html = render(withCut());
  const rows = bodyRows(html);

  it("each row's marker is its own status, on the row and in the rank cell", () => {
    for (const [id, qual] of Object.entries(QUALS)) {
      const tr = rowOf(html, id);
      expect(/^<tr[^>]*>/.exec(tr)![0], id).toContain(`data-qual="${qual.status}"`);
      const markers = [...rankCell(tr).matchAll(/data-qual-marker="([^"]*)"/g)].map((m) => m[1]);
      expect(markers, id).toEqual([qual.status]);
    }
    // 5 rows + the legend's 3; every one decoration for sight only.
    expect([...html.matchAll(/<span aria-hidden="true" data-qual-marker=/g)]).toHaveLength(5 + 3);
  });

  it("a row the builder gave no status (the departed entrant) keeps a plain rank: no marker, no trigger", () => {
    const tr = rowOf(html, "f");
    expect(/^<tr[^>]*>/.exec(tr)![0]).not.toContain("data-qual=");
    expect(rankCell(tr)).not.toContain("data-qual-marker");
    expect(rankCell(tr)).not.toContain("<button");
  });

  it("the cut line sits after place N and says the builder's label", () => {
    const at = rows.findIndex((r) => r.includes('data-testid="qual-cut"'));
    expect(at).toBe(TABLE.cutIndex);
    expect(rows.filter((r) => r.includes('data-testid="qual-cut"'))).toHaveLength(1);
    // Above it the first N places, below it the rest — by entrant, not count.
    expect(rows[0]).toContain(`${TESTID}-row-a"`);
    expect(rows[1]).toContain(`${TESTID}-row-b"`);
    expect(rows[at + 1]).toContain(`${TESTID}-row-c"`);
    expect(rows[at]).toContain(`>${TABLE.label}<`);
    // Never under the last row: the last row's panel opens upward on
    // `tr:last-child`, and a line there says nothing.
    expect(rows.at(-1)).not.toContain("qual-cut");
  });

  it("a different N moves the line: after place 1", () => {
    const one = bodyRows(render(withCut({ ...TABLE, cutIndex: 1 })));
    expect(one.findIndex((r) => r.includes('data-testid="qual-cut"'))).toBe(1);
  });

  it("a cut under the last row draws no line, but the markers and legend stay", () => {
    const all = render(withCut({ ...TABLE, cutIndex: ROWS.length }));
    expect(all).not.toContain('data-testid="qual-cut"');
    expect(all).toContain('data-testid="qual-legend"');
    expect(all).toContain('data-qual-marker="through"');
  });

  // The brief's `colSpan={2 + view.columns.length}` crushed the NAME column:
  // under `table-fixed`, a later row spanning more columns than the header
  // shows creates grid columns the header never sized, and the remainder is
  // shared among them. Measured in Chromium at 320 with two long-tail columns
  // folded: the name column went 88px → 29px. So the cut row mirrors the
  // header: one cell spanning what a phone shows, then one empty cell per
  // folded column carrying that column's own fold class.
  it("the cut row's cells fold with the header, so it spans exactly the visible columns at each width", () => {
    const visible = (h: string, narrow: boolean) => {
      const thead = h.slice(h.indexOf("<thead>"), h.indexOf("</thead>"));
      const ths = [...thead.matchAll(/<th [^>]*>/g)].map((m) => classesOf(m[0]));
      return ths.filter((c) => !c.includes("hidden") && !(narrow && c.includes("max-md:hidden"))).length;
    };
    const cutSpan = (h: string, narrow: boolean) => {
      const cut = bodyRows(h).find((r) => r.includes('data-testid="qual-cut"'))!;
      const cells = [...cut.matchAll(/<td[^>]*>/g)].map((m) => m[0]);
      return cells.reduce((sum, td) => {
        const c = classesOf(td);
        if (c.includes("hidden") || (narrow && c.includes("max-md:hidden"))) return sum;
        return sum + Number(/colspan="(\d+)"/i.exec(td)?.[1] ?? 1);
      }, 0);
    };
    const full = render(withCut());
    const preview = render(withCut(), { preview: 3 });
    // Premise: the widths really differ, or this cannot tell the two apart.
    expect(visible(full, true)).toBeLessThan(visible(full, false));
    for (const [name, h] of [["full", full], ["preview", preview]] as const) {
      for (const narrow of [true, false]) {
        expect(cutSpan(h, narrow), `${name} ${narrow ? "phone" : "md+"}`).toBe(visible(h, narrow));
      }
    }
  });

  it("an Out row's name is muted; a row still in contention is not", () => {
    const name = (id: string) => classesOf(/<span class="[^"]*truncate[^"]*"[^>]*>/.exec(rowOf(html, id))![0]);
    expect(name("e")).toContain("text-ink-muted");
    expect(name("a")).not.toContain("text-ink-muted");
    expect(name("c")).not.toContain("text-ink-muted");
  });

  it("each trigger is named by the builder's ariaLabel; a tied row keeps its tie test id", () => {
    for (const [id, qual] of Object.entries(QUALS)) {
      const button = buttonIn(rankCell(rowOf(html, id)));
      expect(button, id).toContain(`aria-label="${qual.ariaLabel}"`);
      expect(button, id).toContain(`data-testid="${TESTID}-${id === "b" ? "tie" : "rank"}-${id}"`);
    }
  });

  it("ONE popover per rank cell, carrying the 40px hit area both ways, and no asterisk beside a marker", () => {
    for (const id of Object.keys(QUALS)) {
      const cell = rankCell(rowOf(html, id));
      expect([...cell.matchAll(/<button/g)], id).toHaveLength(1);
      const classes = classesOf(buttonIn(cell));
      // min-w-10 is the popover's own; the vertical band is `-my-2.5 py-2.5`
      // over the cell's `py-2.5` (measured in the browser).
      for (const c of ["min-w-10", "-my-2.5", "py-2.5"]) expect(classes, `${id} ${c}`).toContain(c);
      // The marker takes the tie asterisk's place; the note is in the panel.
      expect(cell, id).not.toContain(">*<");
      // What the button SHOWS: the rank chip, then the marker, and nothing
      // else — a trigger that dropped the number or led with the marker would
      // pass every check above.
      const button = buttonIn(cell);
      const inner = cell.slice(cell.indexOf(button) + button.length, cell.indexOf("</button>"));
      const rank = ROWS.find((r) => r.entrantId === id)!.rank;
      expect(inner, id).toMatch(
        new RegExp(`^<span class="[^"]*">${rank}</span><span aria-hidden="true" data-qual-marker="${QUALS[id]!.status}"[^>]*>[^<]*</span>$`),
      );
    }
  });

  it("popover content order: headline, if you lose, the tie note, the what-if, its assumption", () => {
    const panel = panelOf(html, buttonIn(rankCell(rowOf(html, "b"))));
    const b = QUALS.b!;
    const order = [b.headline, b.ifYouLose!, TIE, WHAT_IF, ASSUMES].map((s) => panel.indexOf(`>${esc(s)}<`));
    for (const [i, at] of order.entries()) expect(at, `part ${i} missing from the panel`).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(panel).toContain(' hidden=""');
  });

  it("a cut books no rank-column width of its own: the same rank class and the same two floors as the no-cut table", () => {
    // What this proves is BUDGETING: the table does not reserve extra width
    // for the marker (no new column, no wider class, no change to the floors
    // the name column is protected by). That the marker then FITS the 40px
    // content box (`w-12` less `pl-2`) is geometry this file cannot see; the
    // proof is the e2e probe's measurement — every rank trigger 40×40 at
    // 1280/768/320 with the whole row hit-tested — and the task-8 report's
    // injected-digit table (37px for one or two digits, 38.9px for three).
    const floors = (h: string) => /--sv-min:\d+px;--sv-min-md:\d+px/.exec(h)![0];
    expect(floors(html)).toBe(floors(render(BASE)));
    expect(html).toMatch(/<th[^>]*data-col="rank"[^>]*class="w-12 py-2 pl-2\s/);
    expect(classesOf(buttonIn(rankCell(rowOf(html, "c"))))).toContain("gap-px");
  });
});

describe("QualCutRow — the folds slot is additive", () => {
  it("without folds it is the ONE cell the division page's table has always drawn; with them, one empty cell per fold", () => {
    const cells = (h: string) => [...h.matchAll(/<td[^>]*>/g)].map((m) => m[0]);
    const plain = renderToStaticMarkup(<table><tbody><QualCutRow colSpan={7} label="L" /></tbody></table>);
    expect(cells(plain)).toEqual(['<td colSpan="7" class="border-t-2 border-dashed border-accent p-0">']);
    const folded = renderToStaticMarkup(
      <table><tbody><QualCutRow colSpan={4} label="L" folds={["max-md:hidden", "hidden"]} /></tbody></table>,
    );
    expect(cells(folded).slice(1)).toEqual([
      '<td class="border-t-2 border-dashed border-accent p-0 max-md:hidden">',
      '<td class="border-t-2 border-dashed border-accent p-0 hidden">',
    ]);
  });
});

describe("StandingsTableView — the legend: the Table tab keeps it, the Overview preview drops it (OQ3)", () => {
  it("the full table carries the legend after its scroll region, with the builder's four strings", () => {
    const html = render(withCut());
    const legend = html.indexOf('data-testid="qual-legend"');
    expect(legend).toBeGreaterThan(html.indexOf("</table></div>"));
    const text = html.slice(legend);
    for (const s of Object.values(TABLE.legend)) expect(text).toContain(`>${s}<`);
    expect([...text.matchAll(/data-qual-marker="([^"]*)"/g)].map((m) => m[1])).toEqual(["through", "needs_help", "out"]);
    // Before the phone disclosure, which belongs to the table's columns.
    expect(legend).toBeLessThan(html.indexOf(`data-testid="${TESTID}-more"`));
  });

  it("the preview drops the legend but keeps its markers and its cut line", () => {
    const html = render(withCut(), { preview: 3 });
    expect(html).not.toContain('data-testid="qual-legend"');
    expect(html).toContain('data-qual-marker="through"');
    expect(html).toContain('data-testid="qual-cut"');
  });

  it("a preview that stops at or before the line shows no line", () => {
    expect(render(withCut(), { preview: 2 })).not.toContain('data-testid="qual-cut"');
    expect(render(withCut(), { preview: 1 })).not.toContain('data-testid="qual-cut"');
  });
});

describe("the real mounts: the Overview previews without a legend, the Table tab with one", () => {
  const view = tableView("q1", "premier", {
    columns: COLUMNS,
    rows: withCut().rows,
    qualification: TABLE,
  });
  // A fixture still to play, or the Overview states its EMPTY case and
  // renders nothing else — no previews at all.
  const doc = hubDoc({ matches: [m("u1", "upcoming", "2026-09-05T13:00:00.000Z", "premier")], tables: [view] });

  it("OverviewTab: markers and the cut line, no legend", () => {
    const html = renderToStaticMarkup(
      <OverviewTab doc={doc} dict={dict} locale="en" now={Date.parse("2026-09-05T12:00:00.000Z")} />,
    );
    const at = html.indexOf('data-testid="mh-table-preview-q1"');
    expect(at, "the Overview mounts the preview").toBeGreaterThan(-1);
    const section = html.slice(at, html.indexOf("</section>", at));
    expect(section).toContain('data-qual-marker="through"');
    expect(section).toContain('data-testid="qual-cut"');
    expect(section).not.toContain('data-testid="qual-legend"');
  });

  it("TableTab: the same view carries its legend", () => {
    const html = renderToStaticMarkup(<TableTab doc={doc} dict={dict} />);
    const at = html.indexOf('data-testid="mh-table-q1"');
    expect(at, "the Table tab mounts the table").toBeGreaterThan(-1);
    const section = html.slice(at, html.indexOf("</section>", at));
    expect(section).toContain('data-qual-marker="through"');
    expect(section).toContain('data-testid="qual-legend"');
  });
});
