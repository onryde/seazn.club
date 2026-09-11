// Spectator surface W2, Task 10 — the Stats, Teams and Info tabs' static-markup
// contract.
//
// The brief carried literal test bodies for Stats and Teams and a `/* … */`
// PLACEHOLDER for Info, so the Info block below is derived rather than
// transcribed — in the style of Tasks 8 and 9, from the brief's own prose list
// of Info rows, the house style those two suites set, and the defect classes
// their reviews found. The Stats and Teams blocks keep every assertion the
// brief named and add the ones its three-line bodies could not carry.
//
// `apps/web` vitest is `environment: "node"`: no DOM, no cascade, no layout. So
// this file pins MARKUP — testids, order, attribute values, class tokens — and
// nothing here claims a pixel. Tap area, the crest's real contrast on a
// painted tile, and whether a two-up grid actually reflows are the post-mount
// visual/e2e leg's after Task 12. No test below pretends to cover them.
//
// SIX PLACES THE BRIEF WAS WRONG OR SILENT, each written up where it bites.
// Items 5 and 6 were shipped in round 1 without being declared, and review F7
// and F8 are right that a deviation nobody wrote down is one Task 12 discovers
// by writing the wrong locator:
//
//  1. The Info tab's dates are formatted in UTC, not in a competition zone.
//     `HubInfo.startsOn`/`endsOn` are CALENDAR DATES and the schema says so
//     (`competition-hub-schema.ts:168-169`); `new Date("2026-09-01")` is UTC
//     midnight, so formatting it in any zone behind UTC rolls the day back. See
//     the dates block for the executed evidence and the zone this suite uses.
//  2. `fmtDate` renders in en-GB in EVERY locale — `format.ts:10` pins
//     `LOCALE` and the helper takes no locale parameter. The brief's "`fmtDate`
//     in `Intl` of the org locale" is false, repo-wide. The dates assertions
//     are English on purpose.
//  3. `info.calendars[]` carries NO slug, and the testid the brief mandates
//     needs one. Joined on `href`, never on array position — see `calendarSlug`.
//  4. `mh-leader-{personId}` is not unique. One person tops two boards of the
//     same division routinely (cricket runs AND sixes), so the brief's testid
//     is the same duplicate-id defect Task 9's `mh-table-{id}-row-{entrantId}`
//     exists to avoid. Scoped to the board here, and the row inventory below
//     asserts uniqueness rather than assuming it.
//  5. The brief makes the leader's NAME the link ("name (a `Link` to
//     `personHref` when non-null, plain text otherwise)"); the whole ROW is the
//     link, so the tap target is 44px rather than one line of text high. Task
//     12 must not write a name-scoped anchor locator — the `<a>` is the row.
//  6. The brief's Teams card says "seed chip when `seed`". Shipped as
//     `seed !== null`, which keeps the chip for a zero-seeded entrant; the
//     literal truthiness silently drops it. Tested both ways below.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { deriveHubTabs } from "@/lib/matches-hub";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { InfoTab, calendarSlug, competitionDateLine } from "../matches-hub/info-tab";
import { StatsTab } from "../matches-hub/stats-tab";
import { TeamsTab } from "../matches-hub/teams-tab";
import { board, calendarFor, division, hubDoc, info, leader, m, team } from "./hub-fixtures";

const dict = en as Dict;

/** The whole OPENING TAG carrying a testid, attribute order irrelevant. Task
 *  9's suite matched `data-testid="…"[^>]*href="…"`, which silently depends on
 *  `data-testid` being serialised first; `next/link` spreads its props and this
 *  file binds testids to hrefs a dozen times, so the tag is read whole. */
const tagOf = (h: string, testid: string): string => {
  const at = h.indexOf(`data-testid="${testid}"`);
  expect(at, `${testid} is in the markup`).toBeGreaterThan(-1);
  return h.slice(h.lastIndexOf("<", at), h.indexOf(">", at) + 1);
};

/** The root `<div>`'s class tokens.
 *
 *  NOT `/^<div data-testid="mh-…"/`, which is how Task 9's suite says this and
 *  which is unsafe on any of these three tabs: React hoists a
 *  `<link rel="preload" as="image">` AHEAD of the markup for every `<img>` in
 *  the tree, so the Teams tab's first byte is a preload tag the moment one
 *  entrant has a badge — and `EntityLogo` would do the same to the Stats tab
 *  the day a leader's entrant has one. The root is read by testid instead. */
const rootClasses = (h: string, testid: string): string[] =>
  tagOf(h, testid)
    .match(/class="([^"]*)"/)?.[1]
    ?.split(" ") ?? [];

/** The opening tag of the element INSIDE a row that carries its geometry — a
 *  `<Link>` when the leader has a player page, a `<div>` when not. The row
 *  `<li>` itself carries only `min-w-0`, so the first `class="…"` after the
 *  testid is the wrong element; this skips past the `<li …>` tag first. Reading
 *  the tag WHOLE is what lets the tap target and the href be asserted on the
 *  same element rather than merely both present somewhere in the row. */
const rowBodyTag = (h: string, testid: string): string => {
  const row = rowHtml(h, testid);
  const at = row.indexOf("<", row.indexOf(">") + 1);
  return row.slice(at, row.indexOf(">", at) + 1);
};

/** One `<li>`'s markup, from its testid to the first `</li>` after it. Review
 *  F4 of Task 9: a negative assertion read off the whole document — or even
 *  off the whole group — passes on markup that merely says the same thing
 *  somewhere else. No row below nests a list, so the first close is its own. */
const rowHtml = (h: string, testid: string): string => {
  const at = h.indexOf(`data-testid="${testid}"`);
  expect(at, `${testid} is in the markup`).toBeGreaterThan(-1);
  return h.slice(at, h.indexOf("</li>", at));
};

// ===========================================================================
// Stats
// ===========================================================================

describe("StatsTab", () => {
  /**
   * Two divisions, three boards, six rows, and every value pairwise distinct.
   *
   * Load-bearing, none of it decoration:
   *
   *  • `p1` tops BOTH of sunday-league's boards, which is what an ordinary
   *    cricket division looks like and what makes the brief's
   *    `mh-leader-{personId}` a duplicate id;
   *  • three reasons a row has no link, and they must not be conflated —
   *    `p2` is MASKED (a consent fold), `p4` has no public player page
   *    (`publicProfile` false), and `p1`/`p3`/`p5` have both. The negative
   *    assertion therefore has two positives beside it, not one;
   *  • `p6` has NO ENTRANT (review F4). `leaders.ts:311` emits
   *    `entrantName: null` for a leader whose row carries no `entrant_id`, and
   *    `hub-fixtures.tsx` defaults every row to "Blue Blazers", so both the
   *    entrant line's conditional and `EntityLogo`'s `entrantName ?? person`
   *    fallback had a live production arm no fixture reached;
   *  • sunday-league publishes two boards and premier one, so both arms of the
   *    two-up rule read off a single render (Task 9's shape).
   */
  const statsDoc = hubDoc({
    leaders: [
      board("sunday-league", "runs", [
        leader("p1", "Arjun Mehta", "/riverside/autumn-cup/players/p1", {
          entrantName: "Blue Blazers",
          value: "412",
        }),
        leader("p2", "B. R.", null, { masked: true, entrantName: "Queens", value: "318" }),
        leader("p3", "Chidi Okafor", "/riverside/autumn-cup/players/p3", {
          entrantName: "Rovers",
          value: "207",
        }),
      ]),
      board("sunday-league", "sixes", [
        leader("p1", "Arjun Mehta", "/riverside/autumn-cup/players/p1", {
          entrantName: "Blue Blazers",
          value: "19",
        }),
        leader("p4", "Dara Quinn", null, { entrantName: "Wanderers", value: "11" }),
        leader("p6", "Femi Adeyemi", "/riverside/autumn-cup/players/p6", {
          entrantName: null,
          value: "7",
        }),
      ]),
      board("premier", "wickets", [
        leader("p5", "Elif Demir", "/riverside/autumn-cup/players/p5", {
          entrantName: "City",
          value: "27",
        }),
      ]),
    ],
  });

  /** The entrant line's exact class attribute. A class string is a coupling and
   *  normally the wrong thing to assert on — but "there is no second line under
   *  the name" has no testid, no text and no tag of its own to anchor on, and
   *  the alternative (counting `<span>`s) is a worse coupling to the same
   *  markup. The rank span's own `text-xs text-ink-muted` sits inside a
   *  different, longer class string, so this cannot match it by accident. */
  const ENTRANT_LINE_CLASS = 'class="min-w-0 truncate text-xs text-ink-muted"';

  const render = (d: CompetitionHubDocT = statsDoc, dd: Dict = dict) =>
    renderToStaticMarkup(<StatsTab doc={d} dict={dd} />);

  it("EMPTY: no boards → the mh-leaders-empty sentence and nothing else — and the tab that would show it does not exist", () => {
    const empty = hubDoc({ leaders: [] });
    const h = render(empty);
    expect(h).toContain(`data-testid="mh-leaders-empty"`);
    expect(h).toContain("No stats yet"); // the dictionary's copy, not the key
    expect(h).not.toContain(`data-testid="mh-stats-division-`);
    expect(h).not.toContain("<ol");
    // Review F6 — the PANEL ROOT survives the empty arm. A handle that exists
    // only on a populated competition is not a handle, and Task 12 would write
    // `[data-testid="mh-stats"]` expecting one.
    expect(rootClasses(h, "mh-stats")).toContain("min-w-0");

    // The same pairing Task 9 makes for its own empty arm: this sentence is
    // UNREACHABLE through the hub, because `deriveHubTabs` offers no Stats tab
    // until a board has a row. What it catches is a direct render and a
    // `?tab=stats` deep link that outlived its data.
    expect(empty.tabs).not.toContain("stats");
    expect(statsDoc.tabs).toContain("stats"); // the positive pair
    expect(deriveHubTabs({ matches: 0, tables: 0, leaderRows: 0, teams: 0 })).not.toContain("stats");
    expect(deriveHubTabs({ matches: 0, tables: 0, leaderRows: 1, teams: 0 })).toContain("stats");
  });

  it("boards are grouped under ONE heading per division, in first-appearance order, and each board is its own `mh-leaders-<slug>-<key>` section", () => {
    const h = render();
    // Lists, not containment checks: "one heading per BOARD" and "one heading
    // for everything" both survive `toContain`.
    expect([...h.matchAll(/data-testid="mh-stats-division-([a-z0-9-]+)"/g)].map((x) => x[1])).toEqual([
      "sunday-league",
      "premier",
    ]);
    expect(
      [...h.matchAll(/<section data-testid="(mh-leaders-[a-z0-9-]+)"/g)].map((x) => x[1]),
    ).toEqual([
      "mh-leaders-sunday-league-runs",
      "mh-leaders-sunday-league-sixes",
      "mh-leaders-premier-wickets",
    ]);
    // The heading is the division's NAME, and it is an `<h2>` — the same rank
    // the Table tab's division heading holds, so the two tabs cannot disagree
    // about the document outline once Task 11 puts them under one page `<h1>`.
    expect(h).toMatch(/<h2[^>]*data-testid="mh-stats-division-sunday-league"[^>]*>Sunday League</);
    expect(h).toMatch(/<h2[^>]*data-testid="mh-stats-division-premier"[^>]*>Premier</);
    // And the board's own label, which the DOCUMENT carries pre-resolved
    // (`playerStatLabel` runs in the builder) — this tab never looks a stat key
    // up. `titleCase` is the fixture's stand-in for that resolution.
    expect(h).toMatch(/data-testid="mh-leaders-sunday-league-runs"[\s\S]{0,300}?>Runs</);
    expect(h).toMatch(/data-testid="mh-leaders-premier-wickets"[\s\S]{0,300}?>Wickets</);

    // Group scoping: premier's group carries premier's board and neither of
    // sunday-league's.
    const premier = h.slice(h.indexOf(`data-testid="mh-stats-division-premier"`));
    expect(premier).toContain(`data-testid="mh-leaders-premier-wickets"`);
    expect(premier).not.toContain(`data-testid="mh-leaders-sunday-league-runs"`);
    expect(premier).not.toContain(`data-testid="mh-leaders-sunday-league-sixes"`);
  });

  it("every row is a `<li>` under its board's `<ol>`, in document order, and its testid is UNIQUE — which `mh-leader-<personId>` is not", () => {
    const h = render();
    const rowIds = [
      ...h.matchAll(/<li data-testid="(mh-leaders-[a-z0-9-]+-row-[a-z0-9-]+)"/g),
    ].map((x) => x[1]!);
    expect(rowIds).toEqual([
      "mh-leaders-sunday-league-runs-row-p1",
      "mh-leaders-sunday-league-runs-row-p2",
      "mh-leaders-sunday-league-runs-row-p3",
      "mh-leaders-sunday-league-sixes-row-p1",
      "mh-leaders-sunday-league-sixes-row-p4",
      "mh-leaders-sunday-league-sixes-row-p6",
      "mh-leaders-premier-wickets-row-p5",
    ]);
    // THE deviation from the brief, asserted rather than argued: `p1` is on two
    // boards, so a testid keyed on the person alone appears twice on one page —
    // a duplicate id, and a Playwright locator that resolves to two elements.
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(rowIds.filter((id) => id.endsWith("-row-p1"))).toHaveLength(2);
    // One `<ol>` per board, so a board rendered twice — or every board's rows
    // poured into one list — is visible. Containment cannot say either.
    expect(h.match(/<ol/g) ?? []).toHaveLength(3);
  });

  it("a row carries its RANK (the position, 1-based), the person, the entrant and the formatted value — each bound to its own row", () => {
    const h = render();
    // Bound per row, and every value in this document is distinct, so a mutant
    // that reads all three from the first row of the board — or from the first
    // board — cannot survive. `>412<` and not `412`: terminated, so "4120"
    // could not satisfy it either.
    const p1 = rowHtml(h, "mh-leaders-sunday-league-runs-row-p1");
    expect(p1).toContain(">1<"); // rank
    expect(p1).toContain(">Arjun Mehta<");
    expect(p1).toContain(">Blue Blazers<");
    expect(p1).toContain(">412<");

    const p3 = rowHtml(h, "mh-leaders-sunday-league-runs-row-p3");
    expect(p3).toContain(">3<");
    expect(p3).toContain(">Chidi Okafor<");
    expect(p3).toContain(">Rovers<");
    expect(p3).toContain(">207<");

    // The rank RESTARTS per board — `p1` is 1st on runs and 1st on sixes, and
    // `p4` is 2nd on sixes, not 5th of the division. A rank taken from a
    // document-wide counter reads 4 and 5 here.
    expect(rowHtml(h, "mh-leaders-sunday-league-sixes-row-p1")).toContain(">1<");
    const p4 = rowHtml(h, "mh-leaders-sunday-league-sixes-row-p4");
    expect(p4).toContain(">2<");
    expect(p4).toContain(">11<");
    // A board in another division starts again at 1.
    expect(rowHtml(h, "mh-leaders-premier-wickets-row-p5")).toContain(">1<");

    // The value is the display face of the whole tab, so its type is pinned:
    // `tabular-nums` keeps a five-row column from dancing, `font-display` is
    // the number face the scorebug and the standings table already use.
    const valueCls = h.match(/<span class="([^"]*)">412<\/span>/)?.[1];
    expect(valueCls, "the value span's class attribute").toBeTruthy();
    expect(valueCls!.split(" ")).toContain("tabular-nums");
    expect(valueCls!.split(" ")).toContain("font-display");
  });

  it("a row with a personHref is a LINK to it; a row without one is not a link at all — the positive and negative pair, twice each", () => {
    const h = render();
    // Positive: the link is the row, and it carries THIS person's href.
    expect(rowHtml(h, "mh-leaders-sunday-league-runs-row-p1")).toContain(
      `href="/riverside/autumn-cup/players/p1"`,
    );
    expect(rowHtml(h, "mh-leaders-premier-wickets-row-p5")).toContain(
      `href="/riverside/autumn-cup/players/p5"`,
    );

    // Negative, TWICE, because the document has two different reasons for it
    // and this tab must not conflate them. `p2` is masked; `p4` simply has no
    // public player page. Sliced to the ROW: the board around it is full of
    // links, so a document-wide `not.toContain("href=")` would be false on the
    // fixed component and true on nothing.
    expect(rowHtml(h, "mh-leaders-sunday-league-runs-row-p2")).not.toContain("href=");
    expect(rowHtml(h, "mh-leaders-sunday-league-sixes-row-p4")).not.toContain("href=");
    // …and both still RENDER, under the name the document carries. Dropping the
    // row would silently change the standings a spectator reads
    // (`leaders.ts:172-186`), so the masked label is the point, not the absence.
    expect(rowHtml(h, "mh-leaders-sunday-league-runs-row-p2")).toContain(">B. R.<");
    expect(rowHtml(h, "mh-leaders-sunday-league-sixes-row-p4")).toContain(">Dara Quinn<");

    // Review F3 — the 44px tap target, which had NO assertion at all while both
    // sibling tabs asserted theirs. When the row is a link, the row IS the tap
    // target, so the bar belongs on the element carrying the href. Read over
    // BOTH arms and over two divisions: linked and unlinked share `ROW_CLASS`,
    // so a mutant stripping it from the constant has to die on either.
    for (const id of [
      "mh-leaders-sunday-league-runs-row-p1", // linked
      "mh-leaders-premier-wickets-row-p5", // linked, another division
      "mh-leaders-sunday-league-runs-row-p2", // not linked — same geometry
    ]) {
      const tag = rowBodyTag(h, id);
      expect(tag.match(/class="([^"]*)"/)?.[1]?.split(" ") ?? [], id).toContain("min-h-11");
      expect(tag.match(/class="([^"]*)"/)?.[1]?.split(" ") ?? [], id).toContain("min-w-0");
    }
    // And on the SAME element as the href, for the two linked ones — a 44px box
    // beside the link rather than around it is not a tap target.
    expect(rowBodyTag(h, "mh-leaders-sunday-league-runs-row-p1")).toContain("href=");
    expect(rowBodyTag(h, "mh-leaders-premier-wickets-row-p5")).toContain("href=");
    expect(rowBodyTag(h, "mh-leaders-sunday-league-runs-row-p2")).not.toContain("href=");
  });

  it("a leader with NO entrant shows no entrant line, and takes the crest's initials from the PERSON instead", () => {
    // Review F4. `leaders.ts:311` is `row.entrant_id === null ? null : …`, so a
    // null `entrantName` is production, not a contrivance — and `badgeUrl` on a
    // leader row is the ENTRANT's (`leaders.ts:314-317`, `resolveEntrantBadge`),
    // which is why the initials under it must be the entrant's when there is
    // one. Both arms were unwitnessed: the fixture defaulted every row to an
    // entrant, so `name={row.entrantName ?? row.person.name}` could be reduced
    // to `row.person.name` with 31/31 still green.
    const h = render();
    const withEntrant = rowHtml(h, "mh-leaders-sunday-league-runs-row-p1");
    // "Blue Blazers" → BB, not "Arjun Mehta" → AM.
    expect(withEntrant).toContain(">BB<");
    expect(withEntrant).not.toContain(">AM<");
    expect(withEntrant).toContain(ENTRANT_LINE_CLASS);

    const without = rowHtml(h, "mh-leaders-sunday-league-sixes-row-p6");
    // "Femi Adeyemi" → FA, the fallback arm.
    expect(without).toContain(">FA<");
    // …and no entrant line under the name, rather than an empty one.
    expect(without).not.toContain(ENTRANT_LINE_CLASS);
    // The positive half of that: the row still renders, with its name and value.
    expect(without).toContain(">Femi Adeyemi<");
    expect(without).toContain(">7<");
  });

  it("a MASKED person is never linked, even on a document that offers a href — the safeguarding arm the builder's own rule cannot enforce here", () => {
    // `buildLeaderBoards` never emits this pair (`leaders.ts:224` is
    // `row.publicProfile && !row.masked`), but the SCHEMA permits it: `person.
    // masked` and `personHref` are independent fields, and the consequence of
    // getting it wrong is a youth player's real name one tap away — the player
    // page renders the unmasked name, which is exactly what the division's
    // masking policy exists to withhold. So the tab carries its own guard
    // rather than trusting an invariant nothing in the type system holds.
    //
    // This is the ONE place this file duplicates a rule that lives upstream,
    // and it is duplicated deliberately, with a test that kills it.
    const leak = hubDoc({
      leaders: [
        board("sunday-league", "runs", [
          leader("p9", "M. K.", "/riverside/autumn-cup/players/p9", { masked: true }),
        ]),
      ],
    });
    const h = render(leak);
    expect(rowHtml(h, "mh-leaders-sunday-league-runs-row-p9")).not.toContain("href=");
    expect(rowHtml(h, "mh-leaders-sunday-league-runs-row-p9")).toContain(">M. K.<");
    // The positive pair on the same shape: unmask that person and the link is
    // back, so the guard is reading `masked` and not simply suppressing links.
    const open = hubDoc({
      leaders: [
        board("sunday-league", "runs", [
          leader("p9", "Maya Kaur", "/riverside/autumn-cup/players/p9", { masked: false }),
        ]),
      ],
    });
    expect(rowHtml(render(open), "mh-leaders-sunday-league-runs-row-p9")).toContain(
      `href="/riverside/autumn-cup/players/p9"`,
    );
  });

  it("a division with MORE than one board goes two-up from `md`; one board does not — both arms off one document", () => {
    const h = render();
    const sunday = h.slice(
      h.indexOf(`data-testid="mh-stats-division-sunday-league"`),
      h.indexOf(`data-testid="mh-stats-division-premier"`),
    );
    expect(sunday).toMatch(/<ul class="[^"]*md:grid-cols-2/);
    const premier = h.slice(h.indexOf(`data-testid="mh-stats-division-premier"`));
    expect(premier).not.toMatch(/<ul class="[^"]*md:grid-cols-2/);
    expect(premier).toMatch(/<ul class="[^"]*grid/); // positive pair: still a grid
  });

  it("the root and every grid cell carry min-w-0 (the truncate chain, whose top is not written yet)", () => {
    const h = render();
    expect(rootClasses(h, "mh-stats")).toContain("min-w-0");
    // EVERY board cell, not the first: three boards across two divisions, so a
    // `min-w-0` that reached only the head of a group is visible here. Row
    // `<li>`s carry a `data-testid` before their class and so do not match
    // `<li class="` — the count below is exactly the board cells.
    const cells = [...h.matchAll(/<li class="([^"]*)"/g)].map((x) => x[1]!);
    expect(cells).toHaveLength(3);
    for (const cls of cells) expect(cls.split(" ")).toContain("min-w-0");
  });

  it("every string the tab owns comes from the dictionary — the empty sentence, in Spanish", () => {
    const h = render(hubDoc({ leaders: [] }), es as Dict);
    expect(h).toContain("Aún no hay estadísticas");
    expect(h).not.toContain("No stats yet");
    // The board LABEL is not the tab's string to translate: the builder
    // resolves it (`competition-hub.ts:637` → `playerStatLabel`) and the
    // document carries the finished word, so a Spanish render shows whatever
    // the document holds. Pinned so a later hand does not "fix" it by looking
    // a key up here.
    expect(renderToStaticMarkup(<StatsTab doc={statsDoc} dict={es as Dict} />)).toContain(">Runs<");
  });
});

// ===========================================================================
// Teams
// ===========================================================================

describe("TeamsTab", () => {
  /**
   * Two divisions, four cards, and all three crest arms on one render:
   *
   *  • `e1` has a badge          → an `<img>`, and no monogram;
   *  • `e2` has a colour, no badge → a monogram tile painted `#123456`;
   *  • `e3` has NEITHER            → the neutral tile, which the brief does not
   *    name and which is the common case for a club that has uploaded nothing;
   *  • `e4` has a LIGHT colour     → the same tile, with the ink flipped.
   *
   * Seeds cover the boundary that matters: `e3` is seeded **0**. A truthiness
   * test drops that chip, a `!== null` test keeps it, and only a fixture with a
   * zero in it can tell the two apart.
   */
  const teamsDoc = hubDoc({
    teams: [
      team("e1", "Southend Blue Blazers", "https://cdn.example/b.png", null, { seed: 1 }),
      team("e2", "Rochford Ramblers CC", null, "#123456"),
      team("e3", "Ashingdon Athletic", null, null, { divisionSlug: "premier", seed: 0 }),
      team("e4", "Canvey Canaries", null, "#ffdd00", { divisionSlug: "premier" }),
    ],
  });

  const render = (d: CompetitionHubDocT = teamsDoc, dd: Dict = dict) =>
    renderToStaticMarkup(<TeamsTab doc={d} dict={dd} />);

  it("EMPTY: no teams → the mh-teams-empty sentence — and the tab that would show it does not exist", () => {
    const empty = hubDoc({ teams: [] });
    const h = render(empty);
    expect(h).toContain(`data-testid="mh-teams-empty"`);
    expect(h).toContain("No entrants yet");
    expect(h).not.toContain(`data-testid="mh-teams-division-`);
    // Review F6, as for Stats: the panel root survives the empty arm.
    expect(rootClasses(h, "mh-teams")).toContain("min-w-0");
    expect(empty.tabs).not.toContain("teams");
    expect(teamsDoc.tabs).toContain("teams"); // the positive pair
    expect(deriveHubTabs({ matches: 0, tables: 0, leaderRows: 0, teams: 0 })).not.toContain("teams");
    expect(deriveHubTabs({ matches: 0, tables: 0, leaderRows: 0, teams: 1 })).toContain("teams");
  });

  it("cards are grouped under ONE heading per division, in first-appearance order, each card scoped to its own group", () => {
    const h = render();
    expect([...h.matchAll(/data-testid="mh-teams-division-([a-z0-9-]+)"/g)].map((x) => x[1])).toEqual(
      ["sunday-league", "premier"],
    );
    // BOTH headings' text, not just the first — the mutation sweep's T19.
    // Sourcing the name from `doc.teams[0]` rather than from the group prints
    // "Sunday League" over premier's cards too, and a single assertion on the
    // first group cannot see it, because the first group is the one a
    // document-scoped read happens to get right. Task 9's review F1, in a new
    // file: a per-group derivation needs a MULTI-group witness on the value,
    // not only on the testid.
    expect(h).toMatch(/<h2[^>]*data-testid="mh-teams-division-sunday-league"[^>]*>Sunday League</);
    expect(h).toMatch(/<h2[^>]*data-testid="mh-teams-division-premier"[^>]*>Premier</);
    expect([...h.matchAll(/data-testid="(mh-team-e[0-9]+)"/g)].map((x) => x[1])).toEqual([
      "mh-team-e1",
      "mh-team-e2",
      "mh-team-e3",
      "mh-team-e4",
    ]);
    const premier = h.slice(h.indexOf(`data-testid="mh-teams-division-premier"`));
    expect(premier).toContain(`data-testid="mh-team-e3"`);
    expect(premier).not.toContain(`data-testid="mh-team-e1"`);
  });

  it("badge → an <img> with that src; colour → a monogram tile painted with it; neither → the neutral tile — three arms, one render", () => {
    const h = render();
    const e1 = rowHtml(h, "mh-team-e1");
    expect(e1).toContain('src="https://cdn.example/b.png"');
    expect(e1).not.toContain("background:"); // the badge arm paints nothing
    expect(e1).not.toContain(">SB<"); // …and shows no monogram

    const e2 = rowHtml(h, "mh-team-e2");
    expect(e2).toMatch(/background:#123456[\s\S]*?>RC</); // the brief's own assertion
    expect(e2).not.toContain("<img");

    // The arm the brief does not name, and the one most cards land on.
    const e3 = rowHtml(h, "mh-team-e3");
    expect(e3).toContain(">AA<");
    expect(e3).not.toContain("<img");
    expect(e3).not.toContain("style="); // no colour → no inline paint at all

    // Review F5 — every crest is `aria-hidden`, on all three arms. The entrant's
    // NAME is beside it, so a crest that announced itself would read the same
    // team twice ("RC Rochford Ramblers CC"), which is the double-read
    // `teams-tab.tsx`'s own comment exists to prevent. React serialises a bare
    // `aria-hidden` as `aria-hidden="true"`, so the value is the assertion.
    for (const [id, cardHtml] of [
      ["e1 (badge)", e1],
      ["e2 (painted)", e2],
      ["e3 (neutral)", e3],
    ] as const) {
      expect(cardHtml, id).toContain('aria-hidden="true"');
      // ONE GEOMETRY FOR ALL THREE ARMS, and 32 specifically. This used to be
      // structural — a private `CREST_CLASS` literal shared by three branches —
      // and is now a `size={32}` passed to `EntityLogo`, which is a value
      // rather than a shape. A mutation sweep found the difference: dropping
      // the card's crest to 24 SURVIVED every test in this file, because no
      // assertion had ever named the box. A reachability test is satisfied by
      // any value; this pins the one the card opens at.
      expect(cardHtml, id).toContain("h-8 w-8");
      expect(cardHtml, id).not.toContain("h-6 w-6");
    }
  });

  it("the monogram's INK is derived from the tile's own colour, so a light team colour does not print white on yellow", () => {
    const h = render();
    // Dark navy: white reads on it. Light yellow: it does not, and the same
    // tile flips to ink. Both off one render, and the two colours are the two
    // sides of the WCAG ratio rather than a threshold typed into the code.
    expect(rowHtml(h, "mh-team-e2")).toContain("color:#ffffff");
    expect(rowHtml(h, "mh-team-e4")).toContain("color:#0f172a");
    expect(rowHtml(h, "mh-team-e4")).toContain("background:#ffdd00");

    // The PREDICATE's own table — every refused value, the charset, the
    // fullwidth hash, and the two invariants that replaced the round-1
    // `try`/`catch` — moved with the function into
    // `components/ui/__tests__/entity-logo.test.tsx` when `Crest` collapsed
    // into `EntityLogo`. One copy, not two that drift. What stays here is the
    // claim this tab owes: that a card RENDERS the pair it was given.
  });

  it("a colour with NO hash is normalised before it reaches `style` — measuring it is not the same as painting it", () => {
    // Review F1, and the half the first round missed. `contrast.ts:18` is
    // `hex.trim().replace(/^#/, "")` — the hash is OPTIONAL there — so
    // "123456" measures as dark navy and picks white ink, while
    // `style="background:123456"` is a declaration the browser DROPS. The tile
    // paints transparent and the monogram is white initials on the card's white
    // ground: invisible, and invisible only for the entrants whose colour
    // arrived without a hash. `server/api-v1/schemas.ts:3169,3180` take club
    // `colors` as an unvalidated `z.record(z.string(), z.string())`, so that is
    // a value the product accepts today.
    //
    // The gate's own input table lives with the gate, in
    // `components/ui/__tests__/entity-logo.test.tsx`. What this asserts is the
    // half that is this tab's: that the normalisation is reached THROUGH a
    // rendered card, which is where the defect would have been visible.
    const h = render(hubDoc({ teams: [team("e9", "Hashless Harriers", null, "123456")] }));
    expect(rowHtml(h, "mh-team-e9")).toContain("background:#123456");
    expect(rowHtml(h, "mh-team-e9")).not.toContain("background:123456");
    expect(rowHtml(h, "mh-team-e9")).toContain(">HH<");

    // And the refusal arm through the same path, so "the card paints what it
    // was given" has its negative: a value CSS cannot parse leaves no `style`
    // on the card at all rather than an empty one.
    const bad = render(hubDoc({ teams: [team("e8", "Puce Piranhas", null, "puce")] }));
    expect(rowHtml(bad, "mh-team-e8")).not.toContain("style=");
    expect(rowHtml(bad, "mh-team-e8")).toContain(">PP<");
  });

  it("every card links to ITS OWN division's entrants tab, and the card is the 44px tap target", () => {
    const h = render();
    // Two divisions, two hrefs. An assertion set where all four agreed could
    // not see a card bound to the first team's href.
    expect(tagOf(h, "mh-team-e1")).toContain(
      `href="/riverside/autumn-cup/sunday-league?tab=entrants"`,
    );
    expect(tagOf(h, "mh-team-e2")).toContain(
      `href="/riverside/autumn-cup/sunday-league?tab=entrants"`,
    );
    expect(tagOf(h, "mh-team-e3")).toContain(`href="/riverside/autumn-cup/premier?tab=entrants"`);
    expect(tagOf(h, "mh-team-e4")).toContain(`href="/riverside/autumn-cup/premier?tab=entrants"`);
    // `?tab=entrants` became a REAL destination in `9150768cd` — the division
    // page's `Tabs` reads the query parameter now, where it was `useState(0)`
    // and every one of these links landed the spectator on Schedule (Task 9,
    // review G1). The href is still all this component is answerable for.
    for (const id of ["mh-team-e1", "mh-team-e2", "mh-team-e3", "mh-team-e4"]) {
      expect(tagOf(h, id).match(/class="([^"]*)"/)?.[1]?.split(" "), id).toContain("min-h-11");
    }
  });

  it("a seeded entrant carries its seed chip — INCLUDING seed 0 — and an unseeded one carries none", () => {
    const h = render();
    expect(rowHtml(h, "mh-team-e1")).toContain("Seed 1");
    // The boundary: `seed` is `number | null`, and `0` is a number. A truthy
    // test silently drops the chip for it, which is the `Number("")` family of
    // defect (AGENTS.md) wearing a different hat.
    expect(rowHtml(h, "mh-team-e3")).toContain("Seed 0");
    // The negative pair, sliced to the cards that have no seed — the document
    // is full of the word "Seed", so this is unreadable off the whole markup.
    expect(rowHtml(h, "mh-team-e2")).not.toContain("Seed");
    expect(rowHtml(h, "mh-team-e4")).not.toContain("Seed");
  });

  it("the root, every grid cell and the name span carry the truncate chain", () => {
    const h = render();
    expect(rootClasses(h, "mh-teams")).toContain("min-w-0");
    const cells = [...h.matchAll(/<li class="([^"]*)"/g)].map((x) => x[1]!);
    expect(cells).toHaveLength(4);
    for (const cls of cells) expect(cls.split(" ")).toContain("min-w-0");
    // A 43-character entrant name is exactly how the phone-composition
    // overflow was found (AGENTS.md), and `truncate` is inert without
    // `min-w-0` on the whole chain — the card, the cell and the span.
    const name = h.match(/<span class="([^"]*)"[^>]*>Southend Blue Blazers</)?.[1];
    expect(name, "the name span's class attribute").toBeTruthy();
    expect(name!.split(" ")).toContain("truncate");
    expect(name!.split(" ")).toContain("min-w-0");
    expect(tagOf(h, "mh-team-e1").match(/class="([^"]*)"/)?.[1]?.split(" ")).toContain("min-w-0");
    // Review F5 — and the `title`, which is the only way the ellipsised half of
    // a truncated name is reachable at all. It goes with `truncate`: dropping
    // it makes the longest names unreadable on a pointer with nothing else red.
    expect(h).toContain('title="Southend Blue Blazers"');
    expect(h).toContain('title="Rochford Ramblers CC"');
  });

  it("every string the tab owns comes from the dictionary — the seed chip and the empty sentence, in Spanish", () => {
    const h = render(teamsDoc, es as Dict);
    expect(h).toContain("Cabeza de serie 1");
    expect(h).not.toContain("Seed 1");
    const empty = render(hubDoc({ teams: [] }), es as Dict);
    expect(empty).toContain("Aún no hay participantes");
    expect(empty).not.toContain("No entrants yet");
  });
});

// ===========================================================================
// Info
// ===========================================================================

describe("InfoTab", () => {
  /**
   * The divisions are in `America/New_York`, and that is the whole point.
   *
   * `startsOn`/`endsOn` are CALENDAR DATES (`competition-hub-schema.ts:168`),
   * `new Date("2026-09-01")` is UTC midnight, and formatting that instant in a
   * zone behind UTC rolls the day back. Executed against this repo's own
   * `fmtDate`:
   *
   *     Europe/London        1 September 2026
   *     America/New_York     31 August 2026     <-- wrong day, wrong month
   *     Australia/Sydney     1 September 2026
   *
   * This suite's runtime zone is Europe/London, which is UTC+1 in September and
   * renders correctly whether the zone is right or wrong — so a fixture in the
   * repo's default `Europe/London` could not witness the bug at all. With the
   * divisions in New York, both plausible wrong answers (format in the
   * division's zone, format in a named zone behind UTC) print "31 August" and
   * the assertions below say so.
   *
   * The calendars are also deliberately in the OPPOSITE order to the divisions,
   * which is what makes the href join differential: index alignment gives every
   * calendar link the other division's slug.
   */
  const infoDivisions = [
    division("premier", { tz: "America/New_York" }),
    division("sunday-league", { tz: "America/New_York" }),
  ];
  const infoDoc = hubDoc({
    divisions: infoDivisions,
    info: info({
      startsOn: "2026-09-01",
      endsOn: "2026-09-20",
      venues: ["Riverside Oval", "Kings Park"],
      registrationOpen: false,
      calendars: [calendarFor("sunday-league"), calendarFor("premier")],
    }),
  });

  type Slots = Partial<{
    descriptionSlot: ReactNode;
    shareSlot: ReactNode;
    sponsorsSlot: ReactNode;
  }>;
  const render = (d: CompetitionHubDocT = infoDoc, slots: Slots = {}) =>
    renderToStaticMarkup(<InfoTab doc={d} dict={dict} locale="en" {...slots} />);

  it("the dates are the competition's CALENDAR days, formatted in UTC — not in a division's zone, where the day rolls back", () => {
    const h = render();
    const row = tagOf(h, "mh-info-dates");
    expect(row).toBeTruthy();
    const dates = h.slice(h.indexOf(`data-testid="mh-info-dates"`));
    expect(dates).toContain("Dates"); // the label, from `info.dates`
    expect(dates).toContain("1 September 2026 – 20 September 2026");
    // The witness. `America/New_York` is UTC-4 in September, so a component
    // that formatted these in the division's zone — or in any zone behind UTC —
    // prints the day before, and here that is also the month before.
    expect(h).not.toContain("31 August");
    expect(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/New_York",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date("2026-09-01")),
      "the assertion above is only differential if a behind-UTC zone really moves the day",
    ).toBe("31 August 2026");
    expect(infoDoc.divisions.every((d) => d.tz === "America/New_York")).toBe(true);
  });

  it("the calendar dates are formatted by a MECHANISM that names its zone — a guard that holds at CI's zone too", () => {
    // The test above kills "formatted in the division's zone", because the
    // division is explicitly `America/New_York`. It does NOT kill the other
    // shape of the same bug: formatting with NO zone at all
    // (`new Date(d).toLocaleDateString("en-GB", …)`), which is what the
    // competition landing page did until Task 12. That mutant renders
    // "1 September 2026" on this runner (Europe/London, UTC+1 in September) and
    // again on CI (`ubuntu-latest`, UTC) — so it survives in both the broken and
    // the fixed state everywhere the suite actually runs, and is decoration.
    //
    // Task 12 hit this exactly and answered it by asserting the MECHANISM
    // rather than a rendered day. Copied here, because a zone-dependent guard
    // over a zone bug is the one kind of test that cannot witness its own
    // subject: `process.env.TZ` set mid-run does not move ICU, so the suite
    // cannot arrange the zone that would make it differential.
    // The whole OPTION SHAPE, not just the zone. Re-review N2: recording only
    // `opts?.timeZone` makes the `toContain("UTC")` below go vacuous the first
    // time anything else on this tab formats in UTC — the set would carry
    // "UTC" from some other formatter while the calendar dates quietly used a
    // different zone. The page's own version of this test
    // (`[competitionSlug]/__tests__/page.test.tsx:541`) filters on the shape
    // instead; mirrored here so the two say the same thing.
    const built: (Intl.DateTimeFormatOptions | undefined)[] = [];
    const Original = Intl.DateTimeFormat;
    const locale = vi.spyOn(Date.prototype, "toLocaleDateString");
    // A `function`, not an arrow: `fmt()` calls `new Intl.DateTimeFormat(…)`
    // (`lib/format.ts:29`) and an arrow is not constructible, so an arrow mock
    // reds with "is not a constructor" rather than measuring anything.
    const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
      this: unknown,
      l?: Intl.LocalesArgument,
      o?: Intl.DateTimeFormatOptions,
    ) {
      built.push(o);
      return new Original(l, o);
    } as unknown as typeof Intl.DateTimeFormat);

    try {
      render();
    } finally {
      spy.mockRestore();
      locale.mockRestore();
    }

    // `toLocaleDateString` does NOT route through the patchable `Intl` global,
    // so a zone-less formula is invisible to the constructor spy and only this
    // assertion sees it. Both halves are needed; neither is redundant.
    expect(locale, "no date is formatted without naming a zone").not.toHaveBeenCalled();
    expect(built.length, "at least one formatter was built").toBeGreaterThan(0);
    expect(
      built.filter((o) => o?.timeZone === undefined),
      "every formatter names its zone",
    ).toEqual([]);
    // The calendar-date formatter SPECIFICALLY — matched on `DATE_OPTS`'s own
    // shape, so another formatter's UTC cannot stand in for this one.
    expect(
      built.filter((o) => o?.timeZone === "UTC" && o?.month === "long" && o?.year === "numeric"),
      "the competition's calendar dates are formatted in UTC",
    ).not.toEqual([]);
  });

  it("the date line covers every combination of the two nullable calendar dates", () => {
    // One sample is not a parity sweep (AGENTS.md 7). All five states of a pair
    // of independently-nullable dates, on the function rather than through five
    // renders — the render above proves the line reaches the DOM.
    expect(competitionDateLine({ startsOn: null, endsOn: null })).toBe("");
    expect(competitionDateLine({ startsOn: "2026-09-01", endsOn: null })).toBe("1 September 2026");
    // An end date with no start is not a shape the console can produce today,
    // but the schema permits it independently and `fmtRange` would silently
    // print NOTHING for it — the reason this is a `filter` and not that helper.
    expect(competitionDateLine({ startsOn: null, endsOn: "2026-09-20" })).toBe("20 September 2026");
    expect(competitionDateLine({ startsOn: "2026-09-01", endsOn: "2026-09-20" })).toBe(
      "1 September 2026 – 20 September 2026",
    );
    // A one-day competition says its day once, not twice with a dash.
    expect(competitionDateLine({ startsOn: "2026-09-01", endsOn: "2026-09-01" })).toBe(
      "1 September 2026",
    );
  });

  it("no dates at all → no Dates row, rather than a label with nothing after it (the negative pair)", () => {
    const h = render(hubDoc({ divisions: infoDivisions, info: info({ startsOn: null, endsOn: null }) }));
    expect(h).not.toContain(`data-testid="mh-info-dates"`);
    expect(h).not.toContain("Dates");
    expect(h).toContain(`data-testid="mh-info"`); // the tab still renders
  });

  it("the venues are listed in the VIEWER's locale, with that locale's conjunction — and no venues means no row", () => {
    const h = render();
    const venues = h.slice(h.indexOf(`data-testid="mh-info-venues"`));
    expect(venues).toContain("Venues");
    // `Intl.ListFormat`, the same helper `stages-panel.tsx:1343` uses, not a
    // hardcoded ", ". This is the ONE thing on the tab the `locale` prop is
    // for — the dates deliberately do not take it (`format.ts:10` pins en-GB
    // repo-wide, and threading a locale through `fmtDate` is separate work).
    expect(venues).toContain("Riverside Oval and Kings Park");

    const empty = render(hubDoc({ divisions: infoDivisions, info: info({ venues: [] }) }));
    expect(empty).not.toContain(`data-testid="mh-info-venues"`);
    expect(empty).not.toContain("Venues");
  });

  it("registration OPEN says so and offers the Register link; CLOSED says so and offers none (the positive pair)", () => {
    const open = render(
      hubDoc({ divisions: infoDivisions, info: info({ registrationOpen: true }) }),
    );
    const openRow = open.slice(open.indexOf(`data-testid="mh-info-registration"`));
    expect(openRow).toContain("Registration open");
    expect(openRow).not.toContain("Registration closed");
    expect(tagOf(open, "mh-info-register")).toContain(`href="/riverside/autumn-cup/register"`);
    expect(open).toContain(">Register<");

    // CLOSED: the sentence changes AND the link goes. Sliced to the row, because
    // the tab carries other links (calendars, present) either way.
    const closed = render();
    const closedRow = closed.slice(
      closed.indexOf(`data-testid="mh-info-registration"`),
      closed.indexOf(`data-testid="mh-info-calendars"`),
    );
    expect(closedRow).toContain("Registration closed");
    expect(closedRow).not.toContain("Registration open");
    expect(closedRow).not.toContain("href=");
    expect(closed).not.toContain(`data-testid="mh-info-register"`);
  });

  it("one .ics link per division, and its testid comes from the division whose href it IS — never from its position in the array", () => {
    const h = render();
    // The calendars are in the opposite order to `doc.divisions`, so index
    // alignment names each link after the OTHER division. Both the inventory
    // and the per-link hrefs say so.
    expect(
      [...h.matchAll(/data-testid="(mh-info-calendar-[a-z0-9_-]+)"/g)].map((x) => x[1]),
    ).toEqual(["mh-info-calendar-sunday-league", "mh-info-calendar-premier"]);
    expect(tagOf(h, "mh-info-calendar-sunday-league")).toContain(
      `href="/riverside/autumn-cup/sunday-league/calendar.ics"`,
    );
    expect(tagOf(h, "mh-info-calendar-premier")).toContain(
      `href="/riverside/autumn-cup/premier/calendar.ics"`,
    );
    // Each link is named by its division, under one "Add to calendar" heading —
    // a link list that repeated the heading's words would read the same four
    // times to a screen reader.
    expect(h).toContain("Add to calendar");
    expect(rowHtml(h, "mh-info-calendar-sunday-league")).toContain("Sunday League");
    // Review F10 — the heading LEVEL, which nothing pinned: swapping it to
    // `<h3>` survived the whole suite. It is an `<h2>` at 11px, the same rank
    // the Stats and Teams tabs give a division heading at `text-xl`, because
    // rank is not size: this is a top-level section of the panel, and demoting
    // it would leave this tab with no `<h2>` at all under Task 11's page `<h1>`.
    expect(h).toMatch(/<h2[^>]*>Add to calendar<\/h2>/);

    const none = render(hubDoc({ divisions: infoDivisions, info: info({ calendars: [] }) }));
    expect(none).not.toContain(`data-testid="mh-info-calendars"`);
    expect(none).not.toContain("Add to calendar");
  });

  it("calendarSlug falls back to the entry's own INDEX when no division's href matches — never to the division at that position, which collides", () => {
    // The fallback exists because a calendar entry carries no slug and nothing
    // enforces the alignment the builder happens to have today
    // (`competition-hub.ts:663-666` maps straight off `hubDivisions`). Shipped
    // with a test so it is not dead code: a builder that filtered its calendar
    // list would land here.
    const divisions = [division("premier"), division("sunday-league")];
    expect(calendarSlug({ href: "/riverside/autumn-cup/premier/calendar.ics" }, 1, divisions)).toBe(
      "premier",
    );
    // The index, not `divisions[index].slug`. Review F2: the positional rung
    // was worse than nothing, because it collides with a STRUCTURAL match on
    // the very document it was written for — a filtered calendar list is
    // exactly what puts an unmatched entry beside a matched one.
    expect(calendarSlug({ href: "/somewhere/else.ics" }, 1, divisions)).toBe("_1");
    expect(calendarSlug({ href: "/somewhere/else.ics" }, 5, divisions)).toBe("_5");

    // The collision itself, as a uniqueness assertion rather than a value one:
    // entry 0 matches nothing, entry 1 matches `premier`. Under the old rung
    // both rendered `mh-info-calendar-premier` — the duplicate locator the
    // Stats row testid was deviated from the brief to avoid.
    const mixed = [{ href: "/moved/premier.ics" }, calendarFor("premier")];
    const slugs = mixed.map((cal, i) => calendarSlug(cal, i, divisions));
    expect(slugs).toEqual(["_0", "premier"]);
    expect(new Set(slugs).size).toBe(slugs.length);

    // Re-review N1 — the UNDERSCORE, and the case that earns it. A bare
    // `String(index)` was called "unique by construction" and is not: `Slug`
    // (`api-v1/schemas.ts:56-60`) permits a bare "0" and it is client-settable
    // at `CreateDivision.slug`. So a division genuinely slugged "0", beside an
    // unmatched entry at index 0, collided all over again — the same defect one
    // rung further down, because moving a guard does not re-earn its rationale.
    // Neither `Slug` nor `slugify` can emit `_`, so the fallback now lives in a
    // namespace no real slug can reach.
    const zeroSlug = [division("0"), division("premier")];
    const clash = [{ href: "/moved/zero.ics" }, calendarFor("0")];
    const clashSlugs = clash.map((cal, i) => calendarSlug(cal, i, zeroSlug));
    expect(clashSlugs).toEqual(["_0", "0"]);
    expect(new Set(clashSlugs).size).toBe(clashSlugs.length);

    // …and through the component, on the same shape, so the invariant is held
    // where the testids are actually emitted.
    const filtered = render(
      hubDoc({
        divisions,
        info: info({
          calendars: [
            { divisionName: "Moved", href: "/moved/premier.ics" },
            calendarFor("premier"),
          ],
        }),
      }),
    );
    const ids = [...filtered.matchAll(/data-testid="(mh-info-calendar-[a-z0-9_-]+)"/g)].map(
      (x) => x[1]!,
    );
    expect(ids).toEqual(["mh-info-calendar-_0", "mh-info-calendar-premier"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(tagOf(filtered, "mh-info-calendar-_0")).toContain(`href="/moved/premier.ics"`);
    expect(tagOf(filtered, "mh-info-calendar-premier")).toContain(
      `href="/riverside/autumn-cup/premier/calendar.ics"`,
    );

    // Every entry unmatched: still one link each, still unique.
    const stray = render(
      hubDoc({
        divisions: [division("premier")],
        info: info({
          calendars: [
            { divisionName: "Premier", href: "/moved/premier.ics" },
            { divisionName: "Ghost", href: "/moved/ghost.ics" },
          ],
        }),
      }),
    );
    expect(
      [...stray.matchAll(/data-testid="(mh-info-calendar-[a-z0-9_-]+)"/g)].map((x) => x[1]),
    ).toEqual(["mh-info-calendar-_0", "mh-info-calendar-_1"]);
    expect(tagOf(stray, "mh-info-calendar-_1")).toContain(`href="/moved/ghost.ics"`);
  });

  it("the Present link is always offered, at the href the document carries", () => {
    const h = render();
    expect(tagOf(h, "mh-info-present")).toContain(`href="/riverside/autumn-cup/present"`);
    expect(h).toContain(">Present<");
  });

  it("the three SLOTS render when given and take their chrome with them when not (positive and negative pairs)", () => {
    // The page owns the description prose, the share bar and the sponsor board
    // — each is an async server component or a client island with its own
    // data — so this tab positions them and renders nothing of its own around
    // an absent one. A heading with no content under it is the shape review
    // taught us to refuse.
    const withSlots = render(infoDoc, {
      descriptionSlot: <p data-testid="probe-description">Prose</p>,
      shareSlot: <p data-testid="probe-share">Bar</p>,
      sponsorsSlot: <p data-testid="probe-sponsors">Board</p>,
    });
    expect(withSlots).toContain(`data-testid="mh-info-description"`);
    expect(withSlots).toContain(`data-testid="probe-description"`);
    expect(withSlots).toContain(`data-testid="mh-info-share"`);
    expect(withSlots).toContain(`data-testid="probe-share"`);
    // The share row's own heading, and its level — same rank rule as the
    // calendar heading above (review F10).
    expect(withSlots).toMatch(/<h2[^>]*>Share this competition<\/h2>/);
    expect(withSlots).toContain(`data-testid="mh-info-sponsors"`);
    expect(withSlots).toContain(`data-testid="probe-sponsors"`);

    const bare = render();
    expect(bare).not.toContain(`data-testid="mh-info-description"`);
    expect(bare).not.toContain(`data-testid="mh-info-share"`);
    expect(bare).not.toContain("Share this competition");
    expect(bare).not.toContain(`data-testid="mh-info-sponsors"`);
    // …and the rows the document itself owns are still there, so "no slots"
    // is not "no tab".
    expect(bare).toContain(`data-testid="mh-info-dates"`);
    expect(bare).toContain(`data-testid="mh-info-present"`);
  });

  it("the rows appear in the order the brief lists them, top to bottom", () => {
    const h = render(infoDoc, {
      descriptionSlot: <p data-testid="probe-description">Prose</p>,
      shareSlot: <p data-testid="probe-share">Bar</p>,
      sponsorsSlot: <p data-testid="probe-sponsors">Board</p>,
    });
    const order = [
      "mh-info-description",
      "mh-info-dates",
      "mh-info-venues",
      "mh-info-registration",
      "mh-info-calendars",
      "mh-info-share",
      "mh-info-present",
      "mh-info-sponsors",
    ].map((id) => h.indexOf(`data-testid="${id}"`));
    // Presence FIRST: a missing row is `-1`, which sorts to the front, and the
    // first row of this list is the one that would sort there anyway.
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("the root carries min-w-0, and every link on the tab is a 44px tap target", () => {
    const h = render();
    expect(rootClasses(h, "mh-info")).toContain("min-w-0");
    for (const id of ["mh-info-calendar-sunday-league", "mh-info-calendar-premier", "mh-info-present"]) {
      expect(tagOf(h, id).match(/class="([^"]*)"/)?.[1]?.split(" "), id).toContain("min-h-11");
    }
    const open = render(hubDoc({ divisions: infoDivisions, info: info({ registrationOpen: true }) }));
    expect(tagOf(open, "mh-info-register").match(/class="([^"]*)"/)?.[1]?.split(" ")).toContain(
      "min-h-11",
    );
  });

  it("every string the tab owns comes from the dictionary — five labels and the venue conjunction, in Spanish", () => {
    const h = renderToStaticMarkup(
      <InfoTab
        doc={hubDoc({
          divisions: infoDivisions,
          info: info({
            venues: ["Riverside Oval", "Kings Park"],
            registrationOpen: true,
            calendars: [calendarFor("premier")],
          }),
        })}
        dict={es as Dict}
        locale="es"
      />,
    );
    expect(h).toContain("Fechas");
    expect(h).toContain("Sedes");
    expect(h).toContain("Inscripciones abiertas");
    expect(h).toContain("Inscribirse");
    expect(h).toContain("Añadir al calendario");
    expect(h).toContain("Presentar");
    expect(h).not.toContain("Registration open");
    expect(h).not.toContain("Add to calendar");
    // The list conjunction is the locale's too — "y", not "and". A component
    // that hardcoded `en` here would still pass every label assertion above.
    expect(h).toContain("Riverside Oval y Kings Park");
    // The DATES stay en-GB in every locale, which is `format.ts`'s repo-wide
    // deferral and not a gap this tab may close on its own (the brief said
    // otherwise). Asserted so the divergence is a decision on the record.
    expect(h).toContain("1 September 2026");
  });

  it("the four locales all carry the keys this tab renders", () => {
    // `division.entrantsEmpty` is the one key here that is not in a namespace
    // this surface owns — see the note at its call site in `teams-tab.tsx`. It
    // is checked in all four locales alongside the rest, because a reused key
    // is exactly the kind a later hand deletes as unused.
    for (const [locale, d] of Object.entries({ en, es, fr, nl })) {
      for (const k of [
        "leaders.empty",
        "teams.seed",
        "division.entrantsEmpty",
        "info.dates",
        "info.venues",
        "info.registration.open",
        "info.registration.closed",
        "info.calendar",
        "info.share",
        "landing.register",
        "landing.present",
      ]) {
        expect(Object.hasOwn(d, k), `${locale} ${k}`).toBe(true);
      }
    }
  });
});

// ===========================================================================
// The shared fixture's own contract
// ===========================================================================

describe("hub-fixtures divisions derivation (Task 9, review F2)", () => {
  it("`hubDoc` derives `divisions` from all four lists, so no document claims a leader board or a team for a division it does not carry", () => {
    // Review F2 booked this assertion for "the first suite that reads
    // `doc.divisions` alongside another list" — `InfoTab` joins
    // `info.calendars` to a division by href, so this is that suite. The
    // schema cannot supply it: `CompetitionHubDoc`'s only `superRefine` checks
    // `tabs`, and nothing cross-checks a division slug anywhere else.
    expect(hubDoc({ matches: [m("f1", "live", null, "matchy")] }).divisions.map((d) => d.slug)).toEqual(
      ["matchy"],
    );
    expect(
      hubDoc({ leaders: [board("boardy", "runs", [leader("p1", "A", null)])] }).divisions.map(
        (d) => d.slug,
      ),
    ).toEqual(["boardy"]);
    expect(
      hubDoc({ teams: [team("e1", "A", null, null, { divisionSlug: "teamy" })] }).divisions.map(
        (d) => d.slug,
      ),
    ).toEqual(["teamy"]);
    // First-appearance order, deduplicated ACROSS the lists — and the lists are
    // read matches, tables, leaders, teams, so a document whose lists disagree
    // about division order takes the earlier list's. Pinned rather than left
    // implicit: it is arbitrary, it is invisible on every document the builder
    // can produce (it loops divisions outermost, so all four lists agree), and
    // a later hand reordering the concatenation would otherwise change what
    // `hubDoc` returns with nothing red to say so.
    const mixed = hubDoc({
      teams: [
        team("e1", "A", null, null, { divisionSlug: "second" }),
        team("e2", "B", null, null, { divisionSlug: "first" }),
      ],
      leaders: [board("first", "runs", [leader("p1", "A", null)])],
    });
    expect(mixed.divisions.map((d) => d.slug)).toEqual(["first", "second"]);
  });
});
