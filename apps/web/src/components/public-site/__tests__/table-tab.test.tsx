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
// Mutants killed — 24 run, 24 killed; the full kill list with killers per
// mutant is in `task-9-report.md` §Fix round 1.
// ---------------------------------------------------------------------------
//  (a) the tab-level empty guard removed → the EMPTY test.
//  (b) grouping collapsed to one group / one group per TABLE → the heading
//      inventory.
//  (c) grouping by adjacent RUN instead of by divisionId → the interleaved
//      document.
//  (d) group order, and order WITHIN a group, reversed → the `indexOf` pairs.
//  (e) heading renders the slug instead of the division name, or drops back to
//      the caption's own `text-lg` → the heading value and its class tokens.
//  (f) `md:grid-cols-2` unconditional, and never → the two-up pair, both arms
//      read off ONE document.
//  (g) THE CROWN, four ways, and the first of them is why this file has a
//      three-division champion document (review F1): sourced from the whole
//      DOCUMENT rather than the group's own views; sourced from the group's
//      first table only; taken as the first ROW; rendered per TABLE. Each
//      names a different entrant or a different number of strips, and the
//      strip inventory plus the per-group name assertions separate all four.
//  (h) the strip rendered for every division, or its testid hardcoded to one
//      → the strip inventory and the uncrowned division's group.
//  (i) `showFullLink={false}`, or every link bound to the first view's href →
//      the per-table link values. NOTE `showFullLink` restates the child's
//      default, so DELETING the prop is a no-op, not a survivor — see the
//      comment at the call site.
//  (j) the view rendered twice, or the testid prefix taken from the division
//      → the table COUNT and the per-view ids.
//  (k) `min-w-0` dropped from the root or any grid cell → the class
//      assertions, which read every cell rather than the first.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
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
 * (`competition-hub.ts:567-570` — live stage before complete, then `seq`).
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
  const start = h.indexOf(`data-testid="mh-table-heading-${slug}"`);
  expect(start, `the ${slug} heading`).toBeGreaterThan(-1);
  const next = h.indexOf(`data-testid="mh-table-heading-`, start + 1);
  return next === -1 ? h.slice(start) : h.slice(start, next);
};

/** Every division heading the document rendered, in render order. A LIST, not
 *  a containment check: the defects it separates are "one heading per table"
 *  and "one heading for everything", and both pass any `toContain`. */
const headings = (h: string) =>
  [...h.matchAll(/data-testid="mh-table-heading-([a-z0-9-]+)"/g)].map((x) => x[1]);

describe("TableTab", () => {
  // ------------------------------------------------------------- (a) empty

  it("EMPTY: no tables → the mh-table-empty sentence, no heading, no table — and the tab that would show it does not exist", () => {
    const empty = hubDoc({ tables: [] });
    const h = render(empty);
    expect(h).toContain(`data-testid="mh-table-empty"`);
    // The root handle is on THIS arm too (Task 11, R3) — a handle that exists
    // on the populated arm only resolves for a locator on one competition and
    // not on another.
    expect(h).toContain(`data-testid="mh-table"`);
    expect(h).toContain("No standings yet"); // the dictionary's copy, not the key
    expect(h).not.toContain(`data-testid="mh-table-heading-`);
    expect(h).not.toContain("<table");

    // The brief's own note on this case: the sentence is UNREACHABLE through
    // the hub, because a tab exists only when there is something behind it.
    // That rule is `deriveHubTabs`'s and Task 11 renders it, so this is where
    // the two halves are pinned together — the tab-level rule, and the
    // document's own derived `tabs` as its witness.
    expect(empty.tabs).not.toContain("table");
    expect(doc.tabs).toContain("table"); // the positive pair
    expect(deriveHubTabs({ matches: 0, tables: 0, knockouts: 0, leaderRows: 0, teams: 0 })).not.toContain("table");
    expect(deriveHubTabs({ matches: 0, tables: 1, knockouts: 0, leaderRows: 0, teams: 0 })).toContain("table");
  });

  // -------------------------------------------- (b) one table view per table

  it("one StandingsTableView per table view — three views, three tables — in DOCUMENT order, each under its own `mh-table-<id>` prefix", () => {
    const h = render();
    for (const id of ["sunday-super", "sunday-group", "premier-league"]) {
      expect(h, id).toContain(`data-testid="mh-table-${id}"`);
    }
    // ONE per view, which the containment checks above cannot say (review F5):
    // rendering every view twice passes all of them. `StandingsTableView`'s
    // root is `<section data-testid={testid}>`, and this tab's own division
    // wrapper is a `<section>` with no testid, so the count is the tables'.
    expect(h.match(/<section data-testid="mh-table-/g) ?? []).toHaveLength(3);
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

  it("each table's Full-division link carries ITS OWN view's fullHref — what the link IS, not where a spectator lands", () => {
    const h = render();
    // The title used to say the link "points at its own division's standings
    // TAB", which is a claim about an outcome and it is false today (review
    // G1): `components/public-site/tabs.tsx:15` is `useState(0)` and reads no
    // query parameter, while the builder emits `?tab=standings`
    // (`competition-hub.ts:584`) — so the spectator arrives on Schedule. The
    // href is what this component is answerable for; the destination is the
    // division page's, and it is recorded for the owner rather than patched
    // here (that route is `revalidate = 30`, so reading `searchParams` trades
    // the public surface's caching for a tab default — a design call).
    //
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
    expect(h).toMatch(/data-testid="mh-table-heading-sunday-league"[^>]*>Sunday League</);
    expect(h).toMatch(/data-testid="mh-table-heading-premier"[^>]*>Premier</);
    // Re-review NEW-2 — the LEVEL, not just the text. `<h2>` is the rank a
    // division heading has to hold: the tab panel is a section of the hub page
    // and `StandingsTableView`'s own caption sits below this. Swapping it to
    // `<h3>` survived every other assertion here, and a heading level is
    // markup, so it is pinnable now rather than at the post-mount leg.
    expect(h).toMatch(/<h2[^>]*data-testid="mh-table-heading-sunday-league"/);
    expect(h).toMatch(/<h2[^>]*data-testid="mh-table-heading-premier"/);

    // The heading has to outrank the table caption directly below it at EVERY
    // width, not only from `md`: `StandingsTableView`'s caption is
    // `font-display text-lg font-semibold`, so a `text-lg` division heading is
    // the same size as the stage name inside it and the grouping this tab is
    // built around stops being visible on a phone. Token matching, not a
    // substring — `text-lg` is a prefix of nothing here but `truncate` once was.
    const headingCls = h.match(
      /data-testid="mh-table-heading-sunday-league" class="([^"]*)"/,
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
   * (`competition-hub.ts:562,590` → `standings-view.ts:181`) — so a per-table
   * strip prints the same champion twice for one title.
   *
   * Round 1, review F1: it took two MORE divisions to witness the decision this
   * document exists for. With one division, the crown could be sourced from
   * `doc.tables` instead of from the group's own views and all eleven tests
   * stayed green — a competition with one division finished would then print
   * that champion above EVERY division's tables. So `premier` is crowned too,
   * with a DIFFERENT entrant (pairwise-distinct, or a strip cannot be caught
   * naming another division's champion), and `juniors` is not crowned at all —
   * the arm that proves a crown is not simply printed for every group.
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
      tableView("pl", "premier", {
        caption: "League",
        rows: [tableRow("city", 1, { champion: true }), tableRow("rangers", 2)],
      }),
      tableView("jl", "juniors", {
        caption: "League",
        rows: [tableRow("colts", 1), tableRow("cubs", 2)],
      }),
    ],
  });

  it("a champion is named ONCE for the division, above its tables, and it is that DIVISION's crowned row — not the first row's, not another division's", () => {
    const h = render(championDoc);
    // One strip per CROWNED division, in document order. A list, so both
    // "a strip for the uncrowned division too" and "one strip for the whole
    // document" are visible; `juniors` is absent because nobody has won it.
    const strips = [...h.matchAll(/data-testid="(mh-table-champion-[a-z0-9-]+)"/g)].map((x) => x[1]);
    expect(strips).toEqual(["mh-table-champion-sunday-league", "mh-table-champion-premier"]);

    const strip = h.slice(
      h.indexOf(`data-testid="mh-table-champion-sunday-league"`),
      h.indexOf(`data-testid="mh-table-ga"`),
    );
    expect(strip).toContain("Champion"); // the dictionary's word, `table.champion`
    expect(strip).toContain("Blue Blazers"); // the CROWNED row of the DIVISION
    expect(strip).not.toContain("Wanderers"); // the first row of the first table
    expect(strip).not.toContain("Athletic"); // the first row of the table they are in

    // Review F1 — the group boundary itself. Each strip names ITS OWN
    // division's champion, so a crown sourced from `doc.tables` rather than
    // from the group's views prints Blue Blazers over Premier as well, and
    // this is what says so. The whole group is read, not just the strip: the
    // wrong name would be inside it either way.
    const premier = groupHtml(h, "premier");
    expect(premier).not.toContain("Blue Blazers");
    // Re-review NEW-1 — sliced to the STRIP, not read off the whole group.
    // `groupHtml` contains premier's own table, whose rows already say "City",
    // so a `toContain("City")` on the group passed even with the strip's name
    // blanked for every division but the first. The strip has to be asked
    // directly, exactly as sunday-league's is above.
    const premierStrip = premier.slice(
      premier.indexOf(`data-testid="mh-table-champion-premier"`),
      premier.indexOf(`data-testid="mh-table-pl"`),
    );
    expect(premierStrip).toContain("Champion");
    expect(premierStrip).toContain("City");
    // And the division nobody has won gets no crown, in a document that has
    // two — the positive-and-negative pair on one render.
    expect(groupHtml(h, "juniors")).not.toContain(`data-testid="mh-table-champion-`);

    // "Above the table" is the brief's word for it, and it is also below the
    // heading it belongs to — the crown names a DIVISION's champion.
    expect(h.indexOf(`data-testid="mh-table-heading-sunday-league"`)).toBeLessThan(
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
    //
    // EVERY row, not a sample of them (review F5): the title says "every other
    // row" and a two-row sample cannot say it. The same entrant is crowned in
    // two tables — two rows, two ids, which is what the `testid` prefix exists
    // for — and the two divisions' crowns are on different entrants.
    const crowns = [
      ...h.matchAll(/data-testid="(mh-table-[a-z0-9-]+-row-[a-z0-9-]+)"[^>]*data-champion="(\w+)"/g),
    ];
    expect(Object.fromEntries(crowns.map((x) => [x[1], x[2]]))).toEqual({
      "mh-table-ga-row-wanderers": "false",
      "mh-table-ga-row-rovers": "false",
      "mh-table-gb-row-athletic": "false",
      "mh-table-gb-row-blue-blazers": "true",
      "mh-table-se-row-blue-blazers": "true",
      "mh-table-se-row-wanderers": "false",
      "mh-table-pl-row-city": "true",
      "mh-table-pl-row-rangers": "false",
      "mh-table-jl-row-colts": "false",
      "mh-table-jl-row-cubs": "false",
    });
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
    const h = render(championDoc);
    // `data-testid="mh-table"` joined it in Task 11 (its R3) — see
    // `matches-tab.test.tsx`'s own root test for why the hub root needs a
    // uniform per-panel handle.
    expect(h).toMatch(/^<div data-testid="mh-table" class="min-w-0 /);
    // EVERY cell, not the first one (review F5): this document has five tables
    // across three divisions, so a `min-w-0` that only reached the head of a
    // group — or only the first group — is visible here.
    const cells = [...h.matchAll(/<li class="([^"]*)"/g)].map((x) => x[1]!);
    expect(cells).toHaveLength(5); // every table sits in one, and nothing else emits an <li>
    for (const cls of cells) expect(cls.split(" ")).toContain("min-w-0");
    // And it is the GRID ITEM that carries it — `min-width: auto` is a
    // property of the item, so the same class on a wrapper inside the cell
    // would not do the job.
    // `[^>]*` after the class: the list now also carries `role="list"`
    // (final review C8 — Tailwind's preflight strips list semantics, and the
    // reason held on one tab and was missing on five). The assertion is about
    // the `<li>` being the GRID ITEM, not about which attributes the `<ul>`
    // happens to carry.
    expect(h).toMatch(/<ul class="[^"]*grid[^"]*"[^>]*><li class="[^"]*min-w-0/);
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

// ---------------------------------------------------------------------------
// `?division=` (owner ruling 2026-09-16, division-page parity): the Table tab
// FILTERS by division, with the same rail the Matches and Knockout tabs carry,
// so the division page's redirect can land on `?tab=table&division={slug}`.
// ---------------------------------------------------------------------------

describe("TableTab — the division filter", () => {
  afterEach(() => vi.unstubAllGlobals());

  const renderWith = (d: CompetitionHubDocT, initialDivision: string | null | undefined) =>
    renderToStaticMarkup(<TableTab doc={d} dict={dict} initialDivision={initialDivision} />);
  const tablesIn = (h: string) =>
    [...h.matchAll(/<section data-testid="mh-table-([a-z0-9-]+)"/g)].map((x) => x[1]);
  const pressedChips = (h: string) =>
    [...h.matchAll(/data-testid="(mh-table-division-[a-z0-9-]+)"[^>]*aria-pressed="true"/g)].map((x) => x[1]);

  it("NO FILTER FIRST: every division's tables, All pressed, and a chip per division in document order", () => {
    const h = renderWith(doc, null);
    expect(tablesIn(h)).toEqual(["sunday-super", "sunday-group", "premier-league"]);
    expect(pressedChips(h)).toEqual(["mh-table-division-all"]);
    expect([...h.matchAll(/data-testid="mh-table-division-([a-z0-9-]+)"/g)].map((x) => x[1])).toEqual([
      "all",
      "sunday-league",
      "premier",
    ]);
    expect(h).toMatch(/data-testid="mh-table-divisions"[^>]*role="group"[^>]*tabindex="0"[^>]*aria-label="Filter by division"/);
  });

  it("a valid `?division=` shows ONLY that division's tables and presses its chip — the other division's heading and tables are gone", () => {
    const h = renderWith(doc, "premier");
    expect(tablesIn(h)).toEqual(["premier-league"]);
    expect(headings(h)).toEqual(["premier"]);
    expect(pressedChips(h)).toEqual(["mh-table-division-premier"]);
    // …and the other way round, so a filter hardwired to one slug cannot pass.
    const sunday = renderWith(doc, "sunday-league");
    expect(tablesIn(sunday)).toEqual(["sunday-super", "sunday-group"]);
    expect(headings(sunday)).toEqual(["sunday-league"]);
  });

  it("an unknown, empty or table-less `?division=` behaves exactly like no filter", () => {
    const unfiltered = renderWith(doc, null);
    for (const slug of ["ghost", "", "all"]) {
      expect(renderWith(doc, slug), JSON.stringify(slug)).toBe(unfiltered);
    }
  });

  it("ONE division is no choice: no rail, and its `?division=` still shows its tables", () => {
    const single = hubDoc({ tables: [tableView("premier-league", "premier", { caption: "League" })] });
    const h = renderWith(single, "premier");
    expect(h).not.toContain(`data-testid="mh-table-divisions"`);
    expect(tablesIn(h)).toEqual(["premier-league"]);
  });

  it("a chip tap narrows the tab and writes `division=` back to the URL; All takes it out again", () => {
    const loc = { href: "https://seazn.club/shared/riverside/autumn-cup?tab=table", search: "?tab=table" };
    const replaced: string[] = [];
    vi.stubGlobal("window", {
      location: loc,
      history: {
        replaceState: (_s: unknown, _t: unknown, next: string) => {
          replaced.push(next);
          const u = new URL(next);
          loc.href = u.toString();
          loc.search = u.search;
        },
      },
    });
    const island = renderIsland(TableTab, { doc, dict, initialDivision: null });
    const views = () =>
      island
        .tree()
        .filter((x: ReactElement) => typeof propsOf(x).testid === "string")
        .map((x: ReactElement) => propsOf(x).testid);
    const tap = (testid: string) =>
      (propsOf(island.tree().find((x: ReactElement) => propsOf(x)["data-testid"] === testid)!).onClick as () => void)();

    expect(views()).toEqual(["mh-table-sunday-super", "mh-table-sunday-group", "mh-table-premier-league"]);
    tap("mh-table-division-premier");
    expect(replaced).toEqual(["https://seazn.club/shared/riverside/autumn-cup?tab=table&division=premier"]);
    expect(views()).toEqual(["mh-table-premier-league"]);
    tap("mh-table-division-all");
    expect(replaced.at(-1)).toBe("https://seazn.club/shared/riverside/autumn-cup?tab=table");
    expect(views()).toEqual(["mh-table-sunday-super", "mh-table-sunday-group", "mh-table-premier-league"]);
  });
});

