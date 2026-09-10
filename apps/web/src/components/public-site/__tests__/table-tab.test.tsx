// Spectator surface W2, Task 9 — the Table tab's static-markup contract.
//
// The brief for this task is eleven lines of PROSE with no test bodies (Task
// 8's carried them verbatim), so every assertion below is derived rather than
// transcribed. What it is derived FROM, in order: the brief's four named cases
// (a)-(d), Task 8's suite as the house style, and the three defect classes its
// review found — pin the VALUE a control opens at rather than its presence
// (AGENTS.md 19), make fixture values pairwise DISTINCT so a mutant that binds
// two of them to one source cannot survive, and give every negative assertion
// its positive pair.
//
// `apps/web` vitest is `environment: "node"`: no DOM, no cascade, no layout.
// So this file pins MARKUP — testids, order, attribute values, class tokens —
// and nothing here claims a pixel. The table's own geometry (a 96px name
// column that truncates rather than clips, a three-digit rank chip, the
// tie-break marker, tap area, axe, and the whole `expanded === true` branch
// that SSR never renders) belongs to `StandingsTableView`, is unexpressible in
// this environment, and is owed by the post-mount visual/e2e leg after Task
// 12. No test below pretends to cover it.
//
// ---------------------------------------------------------------------------
// Mutants killed (the sweep's kill list is in `task-9-report.md`)
// ---------------------------------------------------------------------------
//  (a) the tab-level empty guard removed → the EMPTY test.
//  (b) grouping collapsed to one group / one group per TABLE → the heading
//      inventory.
//  (c) grouping by adjacent RUN instead of by divisionId → the interleaved
//      document.
//  (d) heading renders the slug instead of the division name → the heading
//      value.
//  (e) `md:grid-cols-2` unconditional, and never → the two-up pair, both arms
//      read off ONE document.
//  (f) the champion strip rendered per TABLE → the one-strip count.
//  (g) the champion named from the first row instead of the crowned one → the
//      champion whose group table has them SECOND.
//  (h) the champion strip rendered with no champion → its negative pair.
//  (i) `showFullLink` dropped, or every link bound to the first view's href →
//      the per-table link values.
//  (j) document order sorted / reversed → the three `indexOf` comparisons.
//  (k) `min-w-0` dropped from the root or the grid cell → the two class
//      assertions.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { deriveHubTabs } from "@/lib/matches-hub";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { TableTab } from "../matches-hub/table-tab";
import { hubDoc, tableRow, tableView } from "./hub-fixtures";

const dict = en as Dict;

/**
 * Two divisions, three tables, and the document order is deliberately not any
 * order a mutant could arrive at by sorting:
 *
 *   • by table id      → premier-league, sunday-group, sunday-super
 *   • by caption       → "Group Stage", "League", "Super Eight"
 *   • by division slug → premier, sunday-league
 *
 * all three differ from the order below, which is the one the builder emits
 * (`competition-hub.ts:565-568` — live stage before complete, then `seq`).
 *
 * The two divisions also differ in TABLE COUNT, one and two, which is what
 * makes both arms of the `md:grid-cols-2` rule readable off a single render.
 * Nothing here carries a champion; that is this document's other job — it is
 * the negative pair for the champion strip.
 */
const doc = hubDoc({
  tables: [
    tableView("sunday-super", "sunday-league", { caption: "Super Eight" }),
    tableView("sunday-group", "sunday-league", { caption: "Group Stage" }),
    tableView("premier-league", "premier", { caption: "League" }),
  ],
});

const render = (d: CompetitionHubDocT = doc) =>
  renderToStaticMarkup(<TableTab doc={d} dict={dict} />);

/** One division's group: from its heading to the next division's, so a
 *  negative assertion can be scoped to it instead of to the whole document.
 *  Same shape as `standings-table-view.test.tsx`'s `rowHtml`. */
const groupHtml = (h: string, slug: string): string => {
  const start = h.indexOf(`data-testid="mh-table-division-${slug}"`);
  expect(start, `the ${slug} heading`).toBeGreaterThan(-1);
  const next = h.indexOf(`data-testid="mh-table-division-`, start + 1);
  return next === -1 ? h.slice(start) : h.slice(start, next);
};

/** Every division heading the document rendered, in render order. A LIST, not
 *  a containment check: the defects it separates are "one heading per table"
 *  and "one heading for everything", and both pass any `toContain`. */
const headings = (h: string) =>
  [...h.matchAll(/data-testid="mh-table-division-([a-z0-9-]+)"/g)].map((x) => x[1]);

describe("TableTab", () => {
  // ------------------------------------------------------------- (a) empty

  it("EMPTY: no tables → the mh-table-empty sentence, no heading, no table — and the tab that would show it does not exist", () => {
    const empty = hubDoc({ tables: [] });
    const h = render(empty);
    expect(h).toContain(`data-testid="mh-table-empty"`);
    expect(h).toContain("No standings yet"); // the dictionary's copy, not the key
    expect(h).not.toContain(`data-testid="mh-table-division-`);
    expect(h).not.toContain("<table");

    // The brief's own note on this case: the sentence is UNREACHABLE through
    // the hub, because a tab exists only when there is something behind it.
    // That rule is `deriveHubTabs`'s and Task 11 renders it, so this is where
    // the two halves are pinned together — the tab-level rule, and the
    // document's own derived `tabs` as its witness.
    expect(empty.tabs).not.toContain("table");
    expect(doc.tabs).toContain("table"); // the positive pair
    expect(deriveHubTabs({ matches: 0, tables: 0, leaderRows: 0, teams: 0 })).not.toContain("table");
    expect(deriveHubTabs({ matches: 0, tables: 1, leaderRows: 0, teams: 0 })).toContain("table");
  });

  // -------------------------------------------- (b) one table view per table

  it("one StandingsTableView per table view, in DOCUMENT order, each under its own `mh-table-<id>` prefix", () => {
    const h = render();
    for (const id of ["sunday-super", "sunday-group", "premier-league"]) {
      expect(h, id).toContain(`data-testid="mh-table-${id}"`);
    }
    // Document order, which is none of the sort orders a mutant would reach
    // for — see the fixture's own note.
    expect(h.indexOf(`data-testid="mh-table-sunday-super"`)).toBeLessThan(
      h.indexOf(`data-testid="mh-table-sunday-group"`),
    );
    expect(h.indexOf(`data-testid="mh-table-sunday-group"`)).toBeLessThan(
      h.indexOf(`data-testid="mh-table-premier-league"`),
    );
    // The prefix is the VIEW's id, not the division's: a division publishing an
    // overall table and one per pool renders the same entrant twice, and a bare
    // `mh-table-row-<id>` would be a duplicate testid on the page. Two rows for
    // one entrant, two distinct ids.
    expect(h).toContain(`data-testid="mh-table-sunday-super-row-alpha"`);
    expect(h).toContain(`data-testid="mh-table-sunday-group-row-alpha"`);
  });

  it("each table's Full-division link points at ITS OWN division's standings tab", () => {
    const h = render();
    // Three links, two hrefs: the two sunday tables share a division and
    // therefore a target, premier's differs. That is what makes a mutant
    // binding every link to the first view's href visible — an assertion set
    // where all three agreed could not see it.
    expect(h).toMatch(
      /data-testid="mh-table-sunday-super-full"[^>]*href="\/riverside\/autumn-cup\/sunday-league\?tab=standings"/,
    );
    expect(h).toMatch(
      /data-testid="mh-table-sunday-group-full"[^>]*href="\/riverside\/autumn-cup\/sunday-league\?tab=standings"/,
    );
    expect(h).toMatch(
      /data-testid="mh-table-premier-league-full"[^>]*href="\/riverside\/autumn-cup\/premier\?tab=standings"/,
    );
  });

  // ---------------------------------------------------- (c) division grouping

  it("tables are grouped under ONE heading per division, in first-appearance order, and the heading is the division's NAME", () => {
    const h = render();
    // A list, not a containment check: one heading per TABLE and one heading
    // for everything both survive `toContain`.
    expect(headings(h)).toEqual(["sunday-league", "premier"]);
    expect(h).toMatch(/data-testid="mh-table-division-sunday-league"[^>]*>Sunday League</);
    expect(h).toMatch(/data-testid="mh-table-division-premier"[^>]*>Premier</);

    // The heading has to outrank the table caption directly below it at EVERY
    // width, not only from `md`: `StandingsTableView`'s caption is
    // `font-display text-lg font-semibold`, so a `text-lg` division heading is
    // the same size as the stage name inside it and the grouping this tab is
    // built around stops being visible on a phone. Token matching, not a
    // substring — `text-lg` is a prefix of nothing here but `truncate` once was.
    const headingCls = h.match(
      /data-testid="mh-table-division-sunday-league" class="([^"]*)"/,
    )?.[1];
    expect(headingCls, "the division heading's class attribute").toBeTruthy();
    expect(headingCls!.split(" ")).toContain("text-xl");
    expect(headingCls!.split(" ")).not.toContain("text-lg");

    const sunday = groupHtml(h, "sunday-league");
    expect(sunday).toContain(`data-testid="mh-table-sunday-super"`);
    expect(sunday).toContain(`data-testid="mh-table-sunday-group"`);
    expect(sunday).not.toContain(`data-testid="mh-table-premier-league"`);
    expect(groupHtml(h, "premier")).toContain(`data-testid="mh-table-premier-league"`);
  });

  it("a division whose tables are NOT contiguous still gets one heading, with both its tables in document order", () => {
    // Grouping BY `divisionId` and chunking by adjacent run are the same
    // function on every document `competition-hub.ts` can build — it loops
    // divisions outermost, so a division's tables are always contiguous. They
    // differ here, on a document a builder fault could produce, and the brief
    // asked for the first: "group `doc.tables` by `divisionId` preserving
    // order". Without it a spectator gets the same division heading twice with
    // a different division wedged between them.
    const h = render(
      hubDoc({
        tables: [
          tableView("a1", "premier", { caption: "League" }),
          tableView("b1", "sunday-league", { caption: "League" }),
          tableView("a2", "premier", { caption: "Plate" }),
        ],
      }),
    );
    expect(headings(h)).toEqual(["premier", "sunday-league"]);
    const premier = groupHtml(h, "premier");
    expect(premier).toContain(`data-testid="mh-table-a1"`);
    expect(premier).toContain(`data-testid="mh-table-a2"`);
    expect(premier.indexOf(`data-testid="mh-table-a1"`)).toBeLessThan(
      premier.indexOf(`data-testid="mh-table-a2"`),
    );
  });

  // ------------------------------------------------------------ (d) champion

  /**
   * One division, three tables — two groups and the stage they feed — and the
   * crowned entrant is in NEITHER the first table nor the first row of the one
   * they are in.
   *
   * Every part of that is load-bearing, and none of it is a contrivance: this
   * is an ordinary two-group division. `divisionChampion` crowns rank 1 of the
   * FINAL standings, so the champion is top of the super eight and second in
   * their own group, and they are not in the other group's table at all. Three
   * readings of "who is the champion" are all correct on a document whose
   * champion tops the first table, and they disagree here:
   *
   *   • the first row of the first table   → Wanderers
   *   • the crowned row of the first table → nobody, so no crown at all
   *   • the crowned row of the DIVISION    → Blue Blazers
   *
   * Two of the three tables carry the crown, because the builder passes ONE
   * `championId` per division to every table it publishes for it
   * (`competition-hub.ts:563,576` → `standings-view.ts:181`) — so a per-table
   * strip prints the same champion twice for one title.
   */
  const championDoc = hubDoc({
    tables: [
      tableView("ga", "sunday-league", {
        caption: "Group A",
        rows: [tableRow("wanderers", 1), tableRow("rovers", 2)],
      }),
      tableView("gb", "sunday-league", {
        caption: "Group B",
        rows: [tableRow("athletic", 1), tableRow("blue-blazers", 2, { champion: true })],
      }),
      tableView("se", "sunday-league", {
        caption: "Super Eight",
        rows: [tableRow("blue-blazers", 1, { champion: true }), tableRow("wanderers", 2)],
      }),
    ],
  });

  it("a champion is named ONCE for the division, above its tables, and it is the crowned row's name — not the first row's", () => {
    const h = render(championDoc);
    const strips = [...h.matchAll(/data-testid="(mh-table-champion-[a-z0-9-]+)"/g)].map((x) => x[1]);
    expect(strips).toEqual(["mh-table-champion-sunday-league"]);

    const strip = h.slice(
      h.indexOf(`data-testid="mh-table-champion-sunday-league"`),
      h.indexOf(`data-testid="mh-table-ga"`),
    );
    expect(strip).toContain("Champion"); // the dictionary's word, `table.champion`
    expect(strip).toContain("Blue Blazers"); // the CROWNED row of the DIVISION
    expect(strip).not.toContain("Wanderers"); // the first row of the first table
    expect(strip).not.toContain("Athletic"); // the first row of the table they are in

    // "Above the table" is the brief's word for it, and it is also below the
    // heading it belongs to — the crown names a DIVISION's champion.
    expect(h.indexOf(`data-testid="mh-table-division-sunday-league"`)).toBeLessThan(
      h.indexOf(`data-testid="mh-table-champion-sunday-league"`),
    );
    expect(h.indexOf(`data-testid="mh-table-champion-sunday-league"`)).toBeLessThan(
      h.indexOf(`data-testid="mh-table-ga"`),
    );
  });

  it("the crowned ROW carries data-champion=\"true\" and every other row carries \"false\" — never a missing attribute", () => {
    const h = render(championDoc);
    // `standings-table-view.tsx:274` emits `data-champion` on EVERY row, as
    // "true" or "false". So "the document contains no data-champion" passes
    // vacuously on both states, and React serialises an omitted prop as
    // `"$undefined"` — the value is the assertion, anchored on `="`.
    expect(h).toMatch(/data-testid="mh-table-gb-row-blue-blazers"[^>]*data-champion="true"/);
    expect(h).toMatch(/data-testid="mh-table-gb-row-athletic"[^>]*data-champion="false"/);
    // The same entrant, crowned again in the stage table — two rows, two ids,
    // which is what the `testid` prefix exists for.
    expect(h).toMatch(/data-testid="mh-table-se-row-blue-blazers"[^>]*data-champion="true"/);
    // And the table they are NOT in carries no crowned row at all.
    expect(groupHtml(h, "sunday-league")).toMatch(
      /data-testid="mh-table-ga-row-wanderers"[^>]*data-champion="false"/,
    );
  });

  it("a division with no champion gets no crown at all, and its rows say so (the negative pair, on the canonical document)", () => {
    const h = render();
    expect(h).not.toContain(`data-testid="mh-table-champion-`);
    expect(h).not.toContain("Champion");
    // The positive half of the same fact: the rows exist and are explicitly
    // NOT champions, which is what distinguishes "no crown because nobody has
    // won" from "no crown because the rows never rendered".
    expect(h).toMatch(/data-testid="mh-table-premier-league-row-alpha"[^>]*data-champion="false"/);
  });

  // ---------------------------------------------------- two-up from md (R1)

  it("a division with MORE than one table goes two-up from `md`; one table does not — both arms off one document", () => {
    const h = render();
    // Two tables → two-up. `md:` only, so the phone stays one column: R1's
    // one-DOM rule, and a half-width standings table at 360 would put the
    // points column behind a scroll.
    expect(groupHtml(h, "sunday-league")).toMatch(/<ul class="[^"]*md:grid-cols-2/);
    // One table → NOT two-up, or the only table on the tab paints at half the
    // width of the page it is the whole content of.
    const premier = groupHtml(h, "premier");
    expect(premier).not.toMatch(/<ul class="[^"]*md:grid-cols-2/);
    expect(premier).toMatch(/<ul class="[^"]*grid/); // positive pair: still a grid
  });

  it("the root and every grid cell carry min-w-0 (the truncate chain, whose top is not written yet)", () => {
    // `StandingsTableView` truncates its caption and every entrant name, and
    // `truncate` needs `min-w-0` on the WHOLE ancestor chain. A grid item
    // defaults to `min-width: auto`, so without it the widest name sets the
    // column. The root's copy is for the mount site: Task 11/12 puts this
    // component inside a layout nobody has written, and a flex or grid parent
    // breaks the chain ABOVE here (Task 8, review P3).
    const h = render();
    expect(h).toMatch(/^<div class="min-w-0 /);
    expect(h).toMatch(/<ul class="[^"]*grid[^"]*"><li class="[^"]*min-w-0/);
  });

  // ---------------------------------------------------------------- i18n

  it("every string the tab owns comes from the dictionary — the empty sentence and the crown, in Spanish", () => {
    const empty = renderToStaticMarkup(
      <TableTab doc={hubDoc({ tables: [] })} dict={es as Dict} />,
    );
    expect(empty).toContain("Aún no hay clasificación");
    expect(empty).not.toContain("No standings yet");

    const crowned = renderToStaticMarkup(<TableTab doc={championDoc} dict={es as Dict} />);
    expect(crowned).toContain("Campeón");
    expect(crowned).not.toContain("Champion");
    // And the dictionary reaches the CHILD, not just this component: the
    // table's own chrome is Spanish too.
    expect(crowned).toContain("División completa");
  });
});
