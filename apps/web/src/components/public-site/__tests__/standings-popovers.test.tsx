// The standings popovers, as both tables RENDER them — the tie-break note on a
// rank and the won/lost breakdown behind a ratio cell, through the one shared
// `StandingsPopover`.
//
// `environment: "node"` (no jsdom in this repo), so this is `renderToStaticMarkup`
// and it sees the CLOSED state only: which cells became triggers, that each
// trigger is a real button wired to a panel that exists, and what the panel
// says. What it cannot see — the panel closing on an outside tap, on Esc, when
// another opens, and whether it paints above the rows below — is
// `e2e/standings-popovers.spec.ts`'s, measured in a browser.
//
// Every negative ships with its positive pair: the no-ledger row is the
// negative for the ratio trigger, the untied row for the tie trigger.
//
// ---------------------------------------------------------------------------
// Mutants killed (see the task report for the killer list per mutant)
// ---------------------------------------------------------------------------
//  (g) the division table renders the derived cell as plain text again → the
//      ratio trigger disappears.
//  (h) the note guard dropped in the division table (a trigger on every
//      derived cell) → the no-ledger row grows one.
//  (i) the hub renders `cellNotes` against the wrong column index → the note
//      lands on set_ratio.
//  (j) the tie-break reverts to `<details>` / `title=` → no tie trigger.
//  (k) `aria-controls` pointed at an id no panel carries.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StandingsRow } from "@seazn/engine/competition";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";
import type { TableViewT } from "@/server/public-site/competition-hub-schema";
import { buildTableView, ratioNote } from "@/server/public-site/standings-view";
import { StandingsTable } from "../standings-table";
import { StandingsTableView } from "../standings-table-view";
import { PANEL_CLASS } from "../standings-popover";

const dict = en as Dict;
const msg = (key: TKey, vars?: Record<string, string | number>) => t(dict, key, vars);

/** Volleyball-shaped: the set-based kernel's own metric declarations, with the
 *  point ledger hidden from the table (`display: false`) and ranked on. */
const SPECS = [
  { key: "sets_won", label: "Sets won" },
  { key: "sets_lost", label: "Sets lost" },
  { key: "points_won", label: "Points won", display: false },
  { key: "points_lost", label: "Points lost", display: false },
];
const CASCADE = ["points", "wins", "set_ratio", "point_ratio", "h2h_points"];
const NAMES = { al: "Alpha", be: "Beta", cy: "Cygnus" };

const row = (entrantId: string, over: Partial<StandingsRow>): StandingsRow => ({
  entrantId,
  played: 3,
  won: 2,
  drawn: 0,
  lost: 1,
  points: 6,
  metrics: {},
  ...over,
});

const ROWS: StandingsRow[] = [
  row("al", {
    rank: 1,
    metrics: { sets_won: 6, sets_lost: 3, points_won: 120, points_lost: 98 },
    tieBreak: { key: "point_ratio", with: ["be"] },
  }),
  row("be", { rank: 2, metrics: { sets_won: 6, sets_lost: 3, points_won: 110, points_lost: 104 } }),
  // Entered, never played: no ledger, so "—" and no trigger.
  row("cy", { rank: 3, played: 0, won: 0, lost: 0, points: 0, metrics: {} }),
];

/** The element with `id`, opening tag through its text, or "" when no element
 *  carries that id. React escapes nothing in a `useId` value we care about. */
function byId(html: string, id: string): string {
  const at = html.indexOf(` id="${id}"`);
  if (at < 0) return "";
  const open = html.lastIndexOf("<", at);
  return html.slice(open, html.indexOf("</span>", at));
}

/** Every trigger button in `html`, with the panel its `aria-controls` names. */
function triggers(html: string): { testid: string; button: string; panel: string }[] {
  return [...html.matchAll(/<button[^>]*>/g)]
    .map((m) => m[0])
    // Only the popovers: the hub's "Show all columns" button also carries
    // `aria-controls` (it names the scroll region it unfolds).
    .filter((b) => /data-testid="[^"]*-(tie|ratio)-/.test(b))
    .map((button) => {
      const controls = /aria-controls="([^"]*)"/.exec(button)![1]!;
      return {
        testid: /data-testid="([^"]*)"/.exec(button)?.[1] ?? "",
        button,
        panel: byId(html, controls),
      };
    });
}

/** A row as a document cached before `cellNotes` existed would carry it. */
const withoutNotes = <R extends { cellNotes?: unknown }>(r: R): Omit<R, "cellNotes"> => {
  const copy = { ...r };
  delete copy.cellNotes;
  return copy;
};

/** React escapes `&` in an attribute value, and the last-row flip is spelled
 *  `[tr:last-child_&]` — decode before comparing class lists. */
const decode = (s: string) => s.replace(/&amp;/g, "&");

const RATIO_TEXT = (r: StandingsRow) => ratioNote(r, "point_ratio", msg)!;
const TIE_TEXT = msg("table.tieBreak", { with: "Beta", rule: msg("table.tieBreak.point_ratio") });

describe("the division page's table (StandingsTable)", () => {
  const html = renderToStaticMarkup(
    createElement(StandingsTable, {
      rows: ROWS,
      metricSpecs: SPECS,
      cascade: CASCADE,
      entrantNames: NAMES,
      dict,
    }),
  );
  const all = triggers(html);

  it("a ratio cell with a ledger is a trigger whose panel states the owner-approved totals", () => {
    const al = all.find((x) => x.testid === "standings-ratio-point_ratio-al");
    expect(al, "Alpha's point-ratio cell is not a trigger").toBeDefined();
    expect(al!.button).toContain('type="button"');
    expect(al!.button).toContain('aria-expanded="false"');
    // The panel exists, is closed, and says the English sentence verbatim.
    expect(al!.panel, "aria-controls names no element").not.toBe("");
    expect(al!.panel).toContain("hidden");
    expect(al!.panel).toContain(">Points won 120 · Points lost 98 · Ratio 1.22");
    expect(RATIO_TEXT(ROWS[0]!)).toBe("Points won 120 · Points lost 98 · Ratio 1.22");
    // The cell still SHOWS the ratio — the trigger is the number itself.
    expect(al!.button).toBeDefined();
    expect(html).toMatch(/data-testid="standings-ratio-point_ratio-al"[^>]*>1\.22<\/button>/);
    // Beta's own numbers, not Alpha's: the note is per row.
    const be = all.find((x) => x.testid === "standings-ratio-point_ratio-be");
    expect(be!.panel).toContain(">Points won 110 · Points lost 104 · Ratio 1.06");
  });

  it("negative pair: the row with no ledger prints a plain dash and has NO ratio trigger", () => {
    expect(all.some((x) => x.testid.endsWith("-cy") && x.testid.startsWith("standings-ratio-"))).toBe(false);
    // The dash is still there, as text in its cell.
    const cyRow = html.slice(html.indexOf(">Cygnus<"));
    expect(cyRow.slice(0, cyRow.indexOf("</tr>"))).toMatch(/<td[^>]*>—<\/td>/);
  });

  it("set_ratio stays plain text even with a ledger (its unit is the sport's word)", () => {
    expect(all.some((x) => x.testid.startsWith("standings-ratio-set_ratio-"))).toBe(false);
    expect(html).toMatch(/<td[^>]*>2\.00<\/td>/);
  });

  it("the tie-break note is a button trigger now, not a <details>, and only on the tied row", () => {
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    const ties = all.filter((x) => x.testid.startsWith("standings-tie-"));
    expect(ties.map((x) => x.testid)).toEqual(["standings-tie-al"]);
    expect(ties[0]!.panel).toContain("hidden");
    expect(ties[0]!.panel).toContain(`>${TIE_TEXT}`);
  });

  it("every trigger's panel id is unique, and every panel reads the shared panel classes", () => {
    const ids = all.map((x) => /aria-controls="([^"]*)"/.exec(x.button)![1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(3); // al tie + al ratio + be ratio
    for (const x of all) expect(decode(x.panel)).toContain(PANEL_CLASS);
  });
});

describe("the hub's Table tab (StandingsTableView)", () => {
  const view: TableViewT = buildTableView({
    id: "t1",
    division: { id: "d1", slug: "div", name: "Div" },
    caption: "League",
    fullHref: "/shared/o/c/div?tab=standings",
    rows: ROWS,
    metricSpecs: SPECS,
    cascade: CASCADE,
    entrantNames: NAMES,
    entrantLogos: {},
    entrantColours: {},
    championId: null,
    updatedAt: "2026-09-22T00:00:00.000Z",
    msg,
  });
  const html = renderToStaticMarkup(
    createElement(StandingsTableView, { view, dict, testid: "mh-table-t1" }),
  );
  const all = triggers(html);

  it("the ratio note rides the wire and opens from the point-ratio cell, under the prefix", () => {
    const al = all.find((x) => x.testid === "mh-table-t1-ratio-point_ratio-al");
    expect(al, "Alpha's point-ratio cell is not a trigger on the hub").toBeDefined();
    expect(al!.panel).toContain(">Points won 120 · Points lost 98 · Ratio 1.22");
    // Order-differential: the note sits in the point_ratio cell, not set_ratio.
    expect(html).toMatch(/<td[^>]*data-col="point_ratio"[^>]*>[\s\S]*?mh-table-t1-ratio-point_ratio-al/);
    expect(html).toMatch(/<td[^>]*data-col="set_ratio"[^>]*>2\.00<\/td>/);
  });

  it("negative pair: no ledger, no trigger — and a cached document with no cellNotes renders plain cells", () => {
    expect(all.some((x) => x.testid === "mh-table-t1-ratio-point_ratio-cy")).toBe(false);
    const legacy: TableViewT = { ...view, rows: view.rows.map(withoutNotes) };
    const plain = renderToStaticMarkup(
      createElement(StandingsTableView, { view: legacy, dict, testid: "mh-table-t1" }),
    );
    expect(triggers(plain).filter((x) => x.testid.includes("-ratio-"))).toEqual([]);
    expect(plain).toMatch(/<td[^>]*data-col="point_ratio"[^>]*>1\.22<\/td>/);
  });

  it("the tie note is the same popover (no title= hover a phone cannot reach), on the tied row only", () => {
    const ties = all.filter((x) => x.testid.startsWith("mh-table-t1-tie-"));
    expect(ties.map((x) => x.testid)).toEqual(["mh-table-t1-tie-al"]);
    expect(ties[0]!.panel).toContain(`>${TIE_TEXT}`);
    expect(html).not.toContain(`title="${TIE_TEXT}"`);
    for (const x of all) expect(decode(x.panel)).toContain(PANEL_CLASS);
  });
});
