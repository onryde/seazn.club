// W5 B4 (stress S4): the results grid is n x n cells, and every load of a Swiss or league division page carried all of them -
// a 500-entrant Swiss, one round played, served 249,500 cells (87 MB, 17 s to first byte) inside a CLOSED disclosure. The page
// now sends the cells' makings (`resultsGridData`: one line per played pairing) and the table is drawn the first time the
// disclosure opens (`ResultsGridDisclosure`).
//
// Expected values come from the fixtures the test builds (how many pairings hold a line), never from the builder; the open
// grid's markup is the one `ResultsMatrix` draws (results-matrix.test.tsx and forfeit-tag-surfaces.test.tsx pin that markup).
// Sport-agnostic: the grid reads scorelines and statuses, no sport.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import en from "@/dictionaries/en/public.json";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { ResultsMatrix, resultsGridData } from "../results-matrix";
import { ResultsGrid, ResultsGridDisclosure } from "../results-grid";

const FX = (id: string, home: string, away: string, status: string, headline?: string) => ({
  id, division_id: "d", stage_id: "s", pool_id: null, round_no: 1, seq_in_round: 1,
  home_entrant_id: home, away_entrant_id: away, scheduled_at: null, venue: null,
  court_label: null, status, outcome: null, abandon_reason: null,
  summary: headline ? { headline } : null,
});

/** A Swiss-shaped field: `n` entrants, one round played (n / 2 pairings, each decided). */
function field(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `e${i + 1}`);
  const names = Object.fromEntries(ids.map((id, i) => [id, `Player ${i + 1}`]));
  const fixtures = Array.from({ length: n / 2 }, (_, k) => FX(`f${k + 1}`, ids[2 * k]!, ids[2 * k + 1]!, "decided", "1–0"));
  return { ids, names, fixtures };
}

const input = (n: number) => {
  const { ids, names, fixtures } = field(n);
  return { entrantIds: ids, entrantNames: names, fixtures: fixtures as never, fixtureHref: (id: string) => `/f/${id}`, dict: en };
};

describe("resultsGridData: the page sends the grid's makings, sized by the fixtures, never the square of the field", () => {
  it("one cell entry per played pairing, and every line keeps its link and headline", () => {
    for (const n of [2, 8, 200]) {
      const data = resultsGridData(input(n))!;
      const lines = Object.values(data.cells).flat();
      expect(Object.keys(data.cells), `n=${n}: pairings that hold a line`).toHaveLength(n / 2);
      expect(lines, `n=${n}: lines`).toHaveLength(n / 2);
      expect(lines.every((l) => l.kind === "result" && l.href === `/f/${l.id}` && l.headline === "1–0")).toBe(true);
      expect(data.entrantIds).toHaveLength(n);
    }
  });

  it("a pairing outside the axis sends nothing; a field of one draws no grid (the empty case)", () => {
    const base = input(4);
    const data = resultsGridData({ ...base, fixtures: [...(base.fixtures as unknown[]), FX("x", "e1", "stranger", "decided", "2–0")] as never })!;
    expect(Object.values(data.cells).flat().map((l) => l.id)).not.toContain("x");
    expect(resultsGridData({ ...base, entrantIds: ["e1"] })).toBeNull();
    expect(renderToStaticMarkup(createElement(ResultsMatrix, { ...base, entrantIds: ["e1"] }))).toBe("");
  });

  // B4 review m-6: this asserted the open grid equal to `ResultsMatrix`'s markup, which is now `ResultsGrid(resultsGridData(...))`
  // itself - equal by construction. The markup's own pins are results-matrix.test.tsx and forfeit-tag-surfaces.test.tsx; what is
  // left here is the one fact this file owns: the browser draws the whole square from the makings.
  it("the open grid draws the full square from the makings: n x n cells, one row per entrant", () => {
    const html = renderToStaticMarkup(createElement(ResultsGrid, { data: resultsGridData(input(8))! }));
    expect(html.match(/<td/g), "8 x 8 cells").toHaveLength(64);
    expect(html.match(/<th scope="row"/g), "one row per entrant").toHaveLength(8);
  });
});

describe("ResultsGridDisclosure: the table is drawn only once the disclosure opens", () => {
  const SUMMARY = "min-h-11 cursor-pointer py-3.5 text-xs font-medium text-ink-muted hover:text-ink";
  const props = (n: number) => ({ data: resultsGridData(input(n))!, label: en["division.resultsGrid"], summaryClassName: SUMMARY, noScript: en["division.resultsGrid.noScript"] });

  it("closed: the page carries the summary, with its classes, and not one cell", () => {
    const html = renderToStaticMarkup(createElement(ResultsGridDisclosure, props(200)));
    expect(html).toContain(`<summary class="${SUMMARY}">${en["division.resultsGrid"]}</summary>`);
    expect(html).not.toContain("<td");
    expect(html).not.toContain("data-results-matrix");
    // The 200-entrant grid would be 40,000 cells; closed, the disclosure is a few hundred bytes.
    expect(html.length).toBeLessThan(1_000);
  });

  // B4 review m-11: with scripts off a <details> still opens (natively), and it opened to nothing and said nothing. The page's own
  // sentence (from its dictionary, every locale - i18n:check) is inside the disclosure, behind <noscript>, so only a reader the
  // table never reaches sees it, and it names where the same results are.
  it("with scripts off, the open disclosure says the grid needs JavaScript and where the results are (inside it, behind noscript)", () => {
    const html = renderToStaticMarkup(createElement(ResultsGridDisclosure, props(8)));
    const inside = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    const from = inside.indexOf("<noscript>");
    expect(from, "a noscript inside the disclosure").toBeGreaterThan(-1);
    expect(inside.slice(from, inside.indexOf("</noscript>")), "the page's sentence, in it").toContain(en["division.resultsGrid.noScript"]);
    expect(html.indexOf("<noscript>"), "after the summary, so it is what the opened disclosure shows").toBeGreaterThan(html.indexOf("</summary>"));
  });

  it("opening draws the full grid; closing keeps it drawn; a toggle that reports closed draws nothing", () => {
    const island = renderIsland(ResultsGridDisclosure, props(8));
    const details = () => island.tree().find((n) => n.type === "details") as ReactElement;
    const grids = () => island.tree().filter((n) => n.type === ResultsGrid).length;
    expect(grids(), "closed").toBe(0);
    (propsOf(details()).onToggle as (e: unknown) => void)({ currentTarget: { open: false } });
    expect(grids(), "a toggle event reporting closed").toBe(0);
    (propsOf(details()).onToggle as (e: unknown) => void)({ currentTarget: { open: true } });
    expect(grids(), "opened").toBe(1);
    (propsOf(details()).onToggle as (e: unknown) => void)({ currentTarget: { open: false } });
    expect(grids(), "closed again: still drawn, hidden by the details").toBe(1);
  });

  // B4 review I-3: a tap before hydration opens the <details> natively, and its `toggle` fires before React listens. React hands
  // the element to the ref at hydration's commit; an element that is already open is drawn then. The browser proof is the e2e
  // (e2e/results-grid-open.spec.ts, held scripts); this pins the island's half: what the ref does with each element it is handed.
  it("an element already open when React takes it over is drawn; a closed one, or none, is not (the tap before hydration)", () => {
    let checked = 0;
    for (const [handed, want] of [[{ open: true }, 1], [{ open: false }, 0], [null, 0]] as const) {
      const island = renderIsland(ResultsGridDisclosure, props(8));
      const details = () => island.tree().find((n) => n.type === "details") as ReactElement;
      const grids = () => island.tree().filter((n) => n.type === ResultsGrid).length;
      const ref = propsOf(details()).ref as ((el: unknown) => void) | undefined;
      expect(typeof ref, "the disclosure hands its element to a ref callback").toBe("function");
      ref!(handed);
      expect(grids(), `handed ${JSON.stringify(handed)}`).toBe(want);
      if (want === 1) expect(propsOf(details()).ref, "the ref is stable across a re-render (it runs once, at mount)").toBe(ref);
      checked++;
    }
    expect(checked, "anti-vacuity: open, closed and no element").toBe(3);
  });
});
