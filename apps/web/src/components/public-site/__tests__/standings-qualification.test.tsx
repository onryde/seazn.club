// Standings qualification status on the division page's table (spec
// 2026-09-22 §5, Option B; plan Task 7): the marker in the rank cell, the cut
// line after place N, the legend under the table, and the rank popover's
// content — status headline, "if you lose", the existing tie note, the
// what-if and its assumption, in that order, in ONE popover per rank cell.
//
// `environment: "node"`, so this is `renderToStaticMarkup`: it sees which
// cells became triggers, what each trigger is named, where the cut row sits
// and what the closed panel holds. It cannot see the 40px hit area, the
// panel flipping upward, or the page scrolling sideways — those were measured
// in a browser at 1280/768/320 (task-7 report, Step 6).
//
// The QualificationView here is a literal on purpose: this suite pins where
// the TABLE places each string. That the division page and the embed hand
// the table a view built by the real builder from the real data shape is the
// two page plumbing tests' job.
//
// The no-cut golden (`__snapshots__/standings-table-no-cut.html`) was CAPTURED
// by running this file against the table as it stood before Task 7, not
// written from reading the source — so "a division with no cut renders
// byte-for-byte as it does today" is a comparison with yesterday's output,
// not with whatever the new code happens to print for null.
// P4 (option C, 2026-09-24) re-captured it deliberately: the only bytes
// that moved are the row header's `max-md:` two-line clamp (a wrapper span,
// the clamped name with its `title`, a 7.5rem phone floor on the division
// table). Stripping those back out of the new golden gives the old one
// byte for byte, so nothing else in the no-cut path changed. Ruling (a) the
// same day re-captured it again for one class on the name,
// `max-md:hyphens-auto`; stripping that gives the P4 golden byte for byte.
//
// ---------------------------------------------------------------------------
// Mutants killed (task-7 report has the run log)
// ---------------------------------------------------------------------------
//  (1) the marker not rendered in the rank cell → "each row's marker".
//  (2) the cut row after the wrong row (`index === cutIndex`, or no `- 1`)
//      → "the cut line sits after place N".
//  (3) `ariaLabel` not passed to the popover, or dropped inside it → "each
//      trigger is named by the builder".
//  (4) the no-qualification path changed in any byte → the golden.
//  (5) the popover body reordered → "popover content order".
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StandingsRow } from "@seazn/engine/competition";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { QualificationView } from "@/server/public-site/qualification-view";
import { StandingsTable } from "../standings-table";
import { StandingsPopover } from "../standings-popover";

const dict = en as Dict;

/** Goals shown, the point ledger hidden and ranked on — so the table carries a
 *  ratio popover as well as the rank one, as a volleyball-shaped division does. */
const SPECS = [
  { key: "gf", label: "GF" },
  { key: "ga", label: "GA" },
  { key: "gd", label: "GD" },
  { key: "points_won", label: "Points won", display: false },
  { key: "points_lost", label: "Points lost", display: false },
];
const CASCADE = ["points", "point_ratio", "gd"];
const NAMES: Record<string, string> = { a: "Ada", b: "Bo", c: "Cy", d: "Di", e: "Ed", f: "Flo" };

const row = (entrantId: string, rank: number, points: number, over: Partial<StandingsRow> = {}): StandingsRow => ({
  entrantId,
  rank,
  played: 4,
  won: points / 3,
  drawn: 0,
  lost: 4 - points / 3,
  points,
  metrics: { gf: points + 2, ga: 6, gd: points - 4, points_won: 80 + points, points_lost: 90 },
  ...over,
});

/** Six rows: a clear leader, a tie on points across the line (Bo split from
 *  Cy on point ratio), and a withdrawn entrant in last — who has a row but no
 *  status, as the builder leaves a departed entrant. */
const ROWS: StandingsRow[] = [
  row("a", 1, 12),
  row("b", 2, 9, { tieBreak: { key: "point_ratio", with: ["c"] } }),
  row("c", 3, 9),
  row("d", 4, 6),
  row("e", 5, 0),
  row("f", 6, 0, { played: 1, won: 0, lost: 1 }),
];
const STATUSES: Record<string, string> = { a: "confirmed", b: "confirmed", c: "confirmed", d: "confirmed", e: "confirmed", f: "withdrawn" };
const LOGOS: Record<string, string | null> = { a: null, b: null, c: null, d: null, e: null, f: null };

const BASE = {
  rows: ROWS,
  metricSpecs: SPECS,
  cascade: CASCADE,
  entrantNames: NAMES,
  entrantLogos: LOGOS,
  entrantStatuses: STATUSES,
  caption: "League",
  dict,
};

const WHAT_IF = "If you finish level on points with Cy, point ratio decides: lose your next match by no more than 4 to finish ahead.";
const ASSUMES = "Assumes Cy's figures stay the same and your next match is an average one.";
const QUAL: QualificationView = {
  table: {
    cutIndex: 2,
    label: "Top 2 go through to Finals · 1 round left",
    legend: { through: "Through", open: "Still open", out: "Out", hint: "Tap a rank for details." },
  },
  rows: {
    a: { status: "through", label: "Through", ariaLabel: "Rank 1, Through, show details", headline: "Through to Finals, whatever happens next.", ifYouLose: null, whatIf: null, whatIfAssumption: null },
    b: { status: "win_k", label: "Win and in", ariaLabel: "Rank 2, Win and in, show details", headline: "Win your next match and you're through to Finals.", ifYouLose: "If you lose your next match, you'll need other results to go your way.", whatIf: WHAT_IF, whatIfAssumption: ASSUMES },
    c: { status: "needs_help", label: "Needs help", ariaLabel: "Rank 3, Needs help, show details", headline: "Still open: you need other results to go your way.", ifYouLose: "If you lose your next match, you're out.", whatIf: null, whatIfAssumption: null },
    d: { status: "needs_help", label: "Needs help", ariaLabel: "Rank 4, Needs help, show details", headline: "Still open: you need other results to go your way.", ifYouLose: "If you lose your next match, you're out.", whatIf: null, whatIfAssumption: null },
    e: { status: "out", label: "Out", ariaLabel: "Rank 5, Out, show details", headline: "Can no longer finish in the top 2.", ifYouLose: null, whatIf: null, whatIfAssumption: null },
  },
};

const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(StandingsTable, { ...BASE, ...over } as Parameters<typeof StandingsTable>[0]));

/** The `<tbody>`'s rows, in order, each as its own markup. */
function bodyRows(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  return [...body.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) => m[0]);
}
/** The row whose name cell names `name` — every name here is unique. */
const rowOf = (html: string, name: string) => {
  const hit = bodyRows(html).find((r) => r.includes(`>${name}<`));
  expect(hit, `no body row for ${name}`).toBeDefined();
  return hit!;
};
/** A row's rank cell: its first `<td>`. */
const rankCell = (tr: string) => tr.slice(tr.indexOf("<td"), tr.indexOf("</td>") + 5);
/** The element carrying id=`id`, opening tag to its closing `</span>` —
 *  the panel is a `<span>`, and its body spans are closed inside it. */
function panelOf(html: string, button: string): string {
  const id = /aria-controls="([^"]*)"/.exec(button)![1]!;
  const at = html.indexOf(` id="${id}"`);
  expect(at, `aria-controls names no element: ${id}`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<", at);
  // The panel is the popover root's last child: it ends where the root does.
  return html.slice(open, html.indexOf("</span></span></td>", at));
}
const buttonIn = (cell: string) => /<button[^>]*>/.exec(cell)?.[0] ?? "";
/** A string as React writes it into text: "you're" is `you&#x27;re`. */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("the QUAL fixture speaks today's copy", () => {
  // A fixture holding a retired sentence ("If you lose your next match: Out.")
  // still renders, so nothing else here would notice it drifting from what the
  // product prints: every "if you lose" line must be one the dictionary makes.
  it("each ifYouLose line is an English table.qual.ifYouLose.* sentence", () => {
    const current = new Set(
      Object.entries(en as Record<string, string>)
        .filter(([k]) => k.startsWith("table.qual.ifYouLose."))
        .map(([, v]) => v),
    );
    const lines = Object.values(QUAL.rows).flatMap((r) => (r.ifYouLose === null ? [] : [r.ifYouLose]));
    expect(lines.length, "premise: the fixture carries if-you-lose lines").toBeGreaterThan(0);
    expect(lines.filter((l) => !current.has(l))).toEqual([]);
  });
});

describe("StandingsPopover — the trigger's accessible name (controller ruling M2)", () => {
  it("without ariaLabel the button carries NO aria-label: its content names it, as before", () => {
    const html = renderToStaticMarkup(
      <StandingsPopover trigger="7" testid="p">
        note
      </StandingsPopover>,
    );
    const button = buttonIn(html);
    expect(button).toContain('data-testid="p"');
    expect(button).not.toContain("aria-label=");
  });
  it("with ariaLabel the button is named by it", () => {
    const html = renderToStaticMarkup(
      <StandingsPopover trigger="7" testid="p" ariaLabel="Rank 7, Out, show details">
        note
      </StandingsPopover>,
    );
    expect(buttonIn(html)).toContain('aria-label="Rank 7, Out, show details"');
  });
});

describe("StandingsTable — no cut renders exactly as before Task 7", () => {
  it("the table with no qualification is byte-for-byte the pre-Task-7 golden", async () => {
    await expect(render()).toMatchFileSnapshot("./__snapshots__/standings-table-no-cut.html");
  });

  it("qualification null and undefined render the same bytes as omitting it", () => {
    const omitted = render();
    expect(render({ qualification: null })).toBe(omitted);
    expect(render({ qualification: undefined })).toBe(omitted);
  });

  it("…and carries none of the qualification markup; its positive pair does", () => {
    const none = render({ qualification: null });
    const cut = render({ qualification: QUAL });
    for (const probe of ['data-testid="qual-cut"', 'data-testid="qual-legend"', 'data-qual-marker="', 'data-qual="', 'aria-label="Rank ']) {
      expect(none, probe).not.toContain(probe);
      expect(cut, probe).toContain(probe);
    }
  });

  it("the tied row's trigger keeps its accessible name: no aria-label, the rank and an aria-hidden asterisk", () => {
    const cell = rankCell(rowOf(render({ qualification: null }), "Bo"));
    const button = buttonIn(cell);
    expect(button).toContain('data-testid="standings-tie-b"');
    expect(button).not.toContain("aria-label=");
    const inner = cell.slice(cell.indexOf(button) + button.length, cell.indexOf("</button>"));
    expect(inner).toMatch(/^<span class="[^"]*">2<\/span><span aria-hidden="true" class="[^"]*">\*<\/span>$/);
  });
});

describe("StandingsTable — with a cut (spec §5, Option B)", () => {
  const html = render({ qualification: QUAL });
  const rows = bodyRows(html);

  it("each row's marker is its own status, on the row and in the rank cell", () => {
    for (const [id, qual] of Object.entries(QUAL.rows)) {
      const tr = rowOf(html, NAMES[id]!);
      expect(/^<tr[^>]*>/.exec(tr)![0], id).toContain(`data-qual="${qual.status}"`);
      const markers = [...rankCell(tr).matchAll(/data-qual-marker="([^"]*)"/g)].map((m) => m[1]);
      expect(markers, id).toEqual([qual.status]);
    }
    // The markers are decoration for sight: the status is spoken by the name.
    expect([...html.matchAll(/<span aria-hidden="true" data-qual-marker=/g)]).toHaveLength(5 + 3); // 5 rows + 3 legend
  });

  it("a row the builder gave no status (the withdrawn entrant) keeps a plain rank: no marker, no trigger", () => {
    const tr = rowOf(html, "Flo");
    expect(/^<tr[^>]*>/.exec(tr)![0]).not.toContain("data-qual=");
    expect(rankCell(tr)).not.toContain("data-qual-marker");
    expect(rankCell(tr)).not.toContain("<button");
  });

  it("the cut line sits after place N, spans every column and says the builder's label", () => {
    const at = rows.findIndex((r) => r.includes('data-testid="qual-cut"'));
    expect(at).toBe(QUAL.table.cutIndex);
    expect(rows.filter((r) => r.includes('data-testid="qual-cut"'))).toHaveLength(1);
    // Above it the first N places, below it the rest — by name, not by count.
    expect(rows[0]).toContain(">Ada<");
    expect(rows[1]).toContain(">Bo<");
    expect(rows[at + 1]).toContain(">Cy<");
    const thead = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
    const columns = [...thead.matchAll(/<th /g)].length;
    expect(columns).toBeGreaterThan(2);
    // React serialises the prop as written (`colSpan`); HTML reads it either way.
    expect(rows[at]).toMatch(new RegExp(`<td colspan="${columns}"`, "i"));
    expect(rows[at]).toContain(`>${QUAL.table.label}<`);
    // Never the last row: the last row's panel opens upward on `tr:last-child`.
    expect(rows.at(-1)).not.toContain("qual-cut");
  });

  it("a different N moves the line: after place 1", () => {
    const one = bodyRows(render({ qualification: { ...QUAL, table: { ...QUAL.table, cutIndex: 1 } } }));
    expect(one.findIndex((r) => r.includes('data-testid="qual-cut"'))).toBe(1);
  });

  it("a cut under the last row draws no line (it would say nothing), but the markers and legend stay", () => {
    const all = render({ qualification: { ...QUAL, table: { ...QUAL.table, cutIndex: ROWS.length } } });
    expect(all).not.toContain('data-testid="qual-cut"');
    expect(all).toContain('data-testid="qual-legend"');
    expect(all).toContain('data-qual-marker="through"');
  });

  it("the legend sits under the table, outside its scroll box, with the builder's four strings", () => {
    const region = html.indexOf('role="region"');
    const tableEnd = html.indexOf("</table></div>");
    const legend = html.indexOf('data-testid="qual-legend"');
    expect(region).toBeGreaterThan(-1);
    expect(legend).toBeGreaterThan(tableEnd);
    const text = html.slice(legend);
    const { through, open, out, hint } = QUAL.table.legend;
    for (const s of [through, open, out, hint]) expect(text).toContain(`>${s}<`);
    expect([...text.matchAll(/data-qual-marker="([^"]*)"/g)].map((m) => m[1])).toEqual(["through", "needs_help", "out"]);
  });

  it("an Out row's name is muted; a row still in contention is not", () => {
    const name = (who: string) => /<th scope="row" class="([^"]*)"/.exec(rowOf(html, who))![1]!;
    expect(name("Ed").split(" ")).toContain("text-ink-muted");
    expect(name("Ed").split(" ")).not.toContain("text-ink");
    expect(name("Ada").split(" ")).toContain("text-ink");
    expect(name("Cy").split(" ")).toContain("text-ink");
  });

  it("each trigger is named by the builder's ariaLabel; a tied row keeps its tie test id", () => {
    for (const [id, qual] of Object.entries(QUAL.rows)) {
      const button = buttonIn(rankCell(rowOf(html, NAMES[id]!)));
      expect(button, id).toContain(`aria-label="${qual.ariaLabel}"`);
      expect(button, id).toContain(`data-testid="standings-${id === "b" ? "tie" : "rank"}-${id}"`);
    }
  });

  it("ONE popover per rank cell, carrying the 40px hit area both ways", () => {
    for (const id of Object.keys(QUAL.rows)) {
      const cell = rankCell(rowOf(html, NAMES[id]!));
      expect([...cell.matchAll(/<button/g)], id).toHaveLength(1);
      const classes = /class="([^"]*)"/.exec(buttonIn(cell))![1]!.split(" ");
      // min-w-10 is the popover's own; the vertical band is the host's
      // `-my-2.5 py-2.5` over the cell's padding (measured in the browser).
      for (const c of ["min-w-10", "-my-2.5", "py-2.5"]) expect(classes, `${id} ${c}`).toContain(c);
    }
  });

  it("popover content order: headline, if you lose, the tie note, the what-if, its assumption", () => {
    const button = buttonIn(rankCell(rowOf(html, "Bo")));
    const panel = panelOf(html, button);
    const tie = t(dict, "table.tieBreak", { with: "Cy", rule: t(dict, "table.tieBreak.point_ratio") });
    const b = QUAL.rows.b!;
    const order = [b.headline, b.ifYouLose!, tie, WHAT_IF, ASSUMES].map((s) => panel.indexOf(`>${esc(s)}<`));
    for (const [i, at] of order.entries()) expect(at, `part ${i} missing from the panel`).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(panel).toContain(' hidden=""');
  });

  it("a status with nothing more to say shows its headline alone", () => {
    const panel = panelOf(html, buttonIn(rankCell(rowOf(html, "Ada"))));
    expect(panel).toContain(`>${esc(QUAL.rows.a!.headline)}<`);
    for (const id of ["qual-if-lose", "qual-tie-note", "qual-what-if"]) expect(panel, id).not.toContain(`data-testid="${id}"`);
  });
});
