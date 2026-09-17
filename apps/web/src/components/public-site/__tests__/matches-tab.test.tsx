// Spectator surface W2, Task 8 — the Matches tab's static-markup contract
// (the brief's own Step 1 tests verbatim where the brief is right, plus the
// cases its six leave open).
//
// `apps/web` vitest is `environment: "node"`: there is no DOM, so every test
// here is `renderToStaticMarkup`. That has two consequences worth stating
// once rather than per test. It cannot click, so what these pin is the value
// each control OPENS AT (AGENTS.md 19 — a reachability test is satisfied by
// ANY value); the click path itself is Task 11/12's e2e. And it cannot run
// `useEffect`, so the zone-caption guard's post-mount arm is unwitnessable
// here — what the markup proves is the DEFAULT, which is "caption shown",
// exactly the arm a server render must produce.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { MatchesTab, showZoneCaption, type MatchesTabProps } from "../matches-hub/matches-tab";
import { division, hubDoc, m } from "./hub-fixtures";

const NOW = Date.parse("2026-09-05T12:00:00Z");

const doc = hubDoc({
  matches: [
    m("l1", "live", "2026-09-05T11:00:00Z", "t8"),
    m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"),
    m("u2", "upcoming", "2026-09-06T15:00:00Z", "sunday"),
    m("c1", "completed", "2026-09-04T10:00:00Z", "t8"),
  ],
});

const render = (d: CompetitionHubDocT = doc, over: Partial<MatchesTabProps> = {}) =>
  renderToStaticMarkup(
    <MatchesTab doc={d} dict={en as Dict} locale="en" now={NOW} {...over} />,
  );

describe("MatchesTab", () => {
  it("EMPTY: no matches → mh-matches-empty, NO filter chips (nothing to filter)", () => {
    const h = render(hubDoc({ matches: [] }));
    expect(h).toContain(`data-testid="mh-matches-empty"`);
    expect(h).not.toContain(`data-testid="mh-filter-live"`);
  });

  it("default filter follows the ladder — with a live match the Live chip is pressed and ONLY the live card renders (upcoming exists but is not shown)", () => {
    const h = render();
    expect(h).toMatch(/data-testid="mh-filter-live"[^>]*aria-pressed="true"/);
    expect(h).toMatch(/data-testid="mh-filter-upcoming"[^>]*aria-pressed="false"/);
    expect(h).toContain(`data-testid="mh-match-l1"`);
    expect(h).not.toContain(`data-testid="mh-match-u1"`);
  });

  it("with no live match the default is Upcoming (order-differential: completed outnumber upcoming); chips carry counts", () => {
    const h = render(
      hubDoc({
        matches: [
          m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"),
          m("c1", "completed", null, "t8"),
          m("c2", "completed", null, "t8"),
        ],
      }),
    );
    expect(h).toMatch(/data-testid="mh-filter-upcoming"[^>]*aria-pressed="true"/);
    expect(h).toMatch(/mh-filter-completed[^>]*>[^<]*2/);
  });

  it("EACH chip opens at its OWN bucket's count, on a document where the three differ", () => {
    // Review F3: both count regexes in this file targeted Completed, so a
    // mutant binding all three chips to one bucket — or swapping live and
    // upcoming — survived all 15 tests. AGENTS.md 19: pin the VALUE a control
    // opens at, not merely that it is there. Pairwise-distinct counts are what
    // makes a swap visible, and the canonical `doc` above cannot do it (live
    // 1 / upcoming 2 / completed 1). Terminated with `<` so "Live 10" cannot
    // satisfy "Live 1".
    const h = render(
      hubDoc({
        matches: [
          m("l1", "live", "2026-09-05T11:00:00Z", "t8"),
          m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"),
          m("u2", "upcoming", "2026-09-06T15:00:00Z", "t8"),
          m("c1", "completed", "2026-09-04T10:00:00Z", "t8"),
          m("c2", "completed", "2026-09-04T12:00:00Z", "t8"),
          m("c3", "completed", "2026-09-03T12:00:00Z", "t8"),
        ],
      }),
    );
    expect(h).toMatch(/data-testid="mh-filter-live"[^>]*>Live 1</);
    expect(h).toMatch(/data-testid="mh-filter-upcoming"[^>]*>Upcoming 2</);
    expect(h).toMatch(/data-testid="mh-filter-completed"[^>]*>Completed 3</);
  });

  it("upcoming matches group by venue day with a day header and the zone caption", () => {
    const h = render(doc, { initialFilter: "upcoming" });
    expect(h).toContain(`data-testid="mh-day-2026-09-06"`);
    // `fmtPublicDate(locale, tz, iso, { weekday: "long", day: "numeric", month:
    // "long" })` — the page's locale, English day-month (owner ruling
    // 2026-09-16). The Spanish test below is this fact's second witness.
    expect(h).toMatch(
      /mh-day-2026-09-06[^>]*>[\s\S]*?Sunday 6 September[\s\S]*?times in BST/,
    );
  });

  it("division chips: 'All' pressed by default; a division filter narrows to that division and shows the empty-filter state when nothing matches", () => {
    const h = render(doc, { initialFilter: "completed", initialDivision: "sunday" });
    expect(h).toMatch(/data-testid="mh-division-sunday"[^>]*aria-pressed="true"/);
    expect(h).toContain(`data-testid="mh-matches-empty-filter"`);
    expect(h).not.toContain(`data-testid="mh-matches-empty"`); // positive pair: the absolute-empty state is different
    // And the OTHER half of the sentence this test is named for: with no
    // division chosen, All is the pressed one.
    expect(render()).toMatch(/data-testid="mh-division-all"[^>]*aria-pressed="true"/);
  });

  it("filter and division rails are focusable, named scrolling regions (R1) — and the NAME is the dictionary's, not the key", () => {
    const h = render();
    expect(h).toMatch(/data-testid="mh-filters"[^>]*role="group"[^>]*tabindex="0"[^>]*aria-label="/);
    expect(h).toMatch(/data-testid="mh-divisions"[^>]*role="group"[^>]*tabindex="0"[^>]*aria-label="/);
    // Review F5: anchoring on `aria-label="` alone matches an EMPTY label, a
    // swapped one, and the raw dictionary key — `t()` returns the key on a
    // miss, so deleting `matchesHub.filtersLabel` would render
    // `aria-label="matchesHub.filtersLabel"` and stay green. The accessible
    // name is the whole point of AGENTS.md 23 for these rails, so it gets a
    // VALUE, and each is pinned to its own rail so a swap dies too.
    expect(h).toMatch(/data-testid="mh-filters"[^>]*aria-label="Match filters"/);
    expect(h).toMatch(/data-testid="mh-divisions"[^>]*aria-label="Filter by division"/);

    // Review F7: every other chip assertion is an independent per-testid
    // regex, so a reversed rail passed the whole suite. Live · Upcoming ·
    // Completed is the design of record's own wording and `MATCH_BUCKETS`'
    // own order.
    expect(h.indexOf(`data-testid="mh-filter-live"`)).toBeLessThan(
      h.indexOf(`data-testid="mh-filter-upcoming"`),
    );
    expect(h.indexOf(`data-testid="mh-filter-upcoming"`)).toBeLessThan(
      h.indexOf(`data-testid="mh-filter-completed"`),
    );
    // All divisions leads the division rail — it is the way out of every
    // other chip on it.
    expect(h.indexOf(`data-testid="mh-division-all"`)).toBeLessThan(
      h.indexOf(`data-testid="mh-division-t8"`),
    );
  });

  it("the component root carries min-w-0 (review P3 — the mount site is not written yet)", () => {
    // Inside this component the truncate chain is complete, but Task 11/12
    // mounts it in a layout nobody has written; a flex or grid parent breaks
    // the chain ABOVE here and `MatchCard` truncates three of its own strings.
    // `data-testid="mh-matches"` joined it in Task 11 (its R3): the hub root
    // counts `mh-<tabId>` roots to prove exactly one panel drew, which is what
    // kills "render every tab regardless of `doc.tabs`". Asserted HERE, on the
    // root, rather than only from the mount — the class and the handle are one
    // element's contract and a mount-side test could not tell which element
    // carried which.
    expect(render()).toMatch(/^<div data-testid="mh-matches" class="min-w-0 space-y-3"/);
  });

  it("the day heading is an <h2> — this panel's only heading cannot skip a level under the page h1", () => {
    // Final review C2, and the assertion Table, Stats, Teams and Info already
    // carry (`table-tab.test.tsx:196-202`, `stats-teams-info-tabs.test.tsx:213`).
    // The day heading is the ONLY heading on this whole panel — the filter and
    // division rails carry none — so at `<h3>` the Matches tab ran h1 → h3
    // straight off the page's own `<h1>`, with no `<h2>` anywhere.
    // `info-tab.tsx:168-175` writes the rule this broke.
    //
    // Both the LEVEL and the tag name were unpinned before this: `<h3>` → `<h2>`
    // and `<h3>` → `<span>` each survived the whole suite.
    const h = render();
    expect(h).toMatch(/<h2 class="font-display text-sm font-semibold text-ink">/);
    // No level below h2 anywhere on the panel, so nothing can reintroduce the
    // skip by demoting this one and adding another.
    expect(h).not.toContain("<h3");
    expect(h).not.toContain("<h4");
    // Positive pair: the heading still says what it said — this is an outline
    // change, not a copy change, and the visual size is deliberately unchanged.
    expect(h).toContain("Saturday 5 September");
  });

  it("the EMPTY arm carries the same root handle — a handle on one arm only is not a handle", () => {
    // The absolute-empty state returns early, so its root is a different
    // element in the source. Task 10's Stats tab found exactly this and put the
    // root inside both branches; these two files were the ones still returning
    // a bare `<p>`.
    const h = render(hubDoc({ matches: [] }));
    expect(h).toContain(`data-testid="mh-matches"`);
    expect(h).toContain(`data-testid="mh-matches-empty"`);
  });

  // ---------------------------------------------------------------- beyond the brief

  it("a bucket with nothing in it gets NO chip — a rail does not carry a dead end (positive pair: the buckets that do have matches are still there)", () => {
    // A competition with fixtures drawn and none played reads "Upcoming 3",
    // not "Live 0 · Upcoming 3 · Completed 0". Most spectators meet the hub on
    // a day nothing is being played, so the zero chips would be the common
    // rendering, and each one leads to the empty-filter dead end.
    const h = render(
      hubDoc({
        matches: [
          m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"),
          m("u2", "upcoming", "2026-09-06T15:00:00Z", "t8"),
        ],
      }),
    );
    expect(h).toContain(`data-testid="mh-filter-upcoming"`);
    expect(h).not.toContain(`data-testid="mh-filter-live"`);
    expect(h).not.toContain(`data-testid="mh-filter-completed"`);
  });

  it("a ONE-division hub has no division rail at all, and its cards drop the division chip (positive pair: the filter rail stays)", () => {
    const h = render(
      hubDoc({
        matches: [
          m("l1", "live", "2026-09-05T11:00:00Z", "t8"),
          m("c1", "completed", "2026-09-04T10:00:00Z", "t8"),
        ],
      }),
    );
    expect(h).not.toContain(`data-testid="mh-divisions"`);
    expect(h).not.toContain(`data-testid="mh-division-all"`);
    expect(h).toContain(`data-testid="mh-filters"`);
    expect(h).not.toContain(`data-testid="mh-match-division"`);
  });

  it("choosing a division drops the now-redundant chip from every card (positive pair: All keeps it)", () => {
    const chosen = render(doc, { initialFilter: "upcoming", initialDivision: "sunday" });
    expect(chosen).toContain(`data-testid="mh-match-u2"`);
    expect(chosen).not.toContain(`data-testid="mh-match-division"`);

    const all = render(doc, { initialFilter: "upcoming" });
    expect(all).toContain(`data-testid="mh-match-division"`);
  });

  it("counts are over ALL matches, not the division-narrowed subset — the chip is a total, so it cannot go to zero while a filter is on", () => {
    const d = hubDoc({
      matches: [
        m("l1", "live", "2026-09-05T11:00:00Z", "t8"),
        m("u1", "upcoming", "2026-09-06T13:00:00Z", "sunday"),
        m("c1", "completed", "2026-09-04T10:00:00Z", "t8"),
        m("c2", "completed", "2026-09-04T14:00:00Z", "t8"),
      ],
    });
    // Sunday has NO completed matches, and the Completed chip still reads 2.
    const h = render(d, { initialFilter: "upcoming", initialDivision: "sunday" });
    expect(h).toMatch(/mh-filter-completed[^>]*>[^<]*2/);
  });

  it("the unscheduled group sorts LAST and carries no zone caption (there is no instant to state a zone at)", () => {
    const h = render(
      hubDoc({
        matches: [
          m("u0", "upcoming", null, "t8"),
          m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"),
        ],
      }),
      { initialFilter: "upcoming" },
    );
    const dated = h.indexOf(`data-testid="mh-day-2026-09-06"`);
    const undated = h.indexOf(`data-testid="mh-day-unscheduled"`);
    expect(dated).toBeGreaterThan(-1);
    expect(undated).toBeGreaterThan(dated);
    // `fmtPublicZoneAbbrev(locale, tz, null)` falls back to `new Date()` — it would happily
    // print a caption for a fixture that has no time at all. The section from
    // the unscheduled heading onward carries none.
    expect(h.slice(undated)).not.toContain("times in");
    expect(h).toContain("Unscheduled");
  });

  it("completed matches read newest-first INSIDE a day (sortHubMatches's order survives the grouping)", () => {
    // Given oldest-first, so a grouping that merely preserved input order
    // would fail. Both fixtures are on the same London day, so this is the
    // within-group order and not the between-group one.
    const h = render(
      hubDoc({
        matches: [
          m("early", "completed", "2026-09-04T09:00:00Z", "t8"),
          m("late", "completed", "2026-09-04T15:00:00Z", "t8"),
        ],
      }),
      { initialFilter: "completed" },
    );
    expect(h.indexOf(`data-testid="mh-match-late"`)).toBeGreaterThan(-1);
    expect(h.indexOf(`data-testid="mh-match-late"`)).toBeLessThan(
      h.indexOf(`data-testid="mh-match-early"`),
    );
  });

  it("the day heading is in the org's locale, and so is the dictionary copy around it", () => {
    // Until the owner's 2026-09-16 ruling this test pinned the heading as
    // ENGLISH in Spanish ("Sunday 6 September"), because `fmtDate` was en-GB in
    // every locale. The heading now reads Spanish, and so does the zone label
    // inside the caption: it pinned `fmtZoneAbbrev`'s en-GB "BST" — British
    // Summer Time, an English name — until Task 16's zero-English sweep. What
    // this also pins is that the surrounding COPY is not English by accident —
    // if the caption were hardcoded rather than dictionary-resolved, this test
    // is what would catch it.
    const h = renderToStaticMarkup(
      <MatchesTab doc={doc} dict={es as Dict} locale="es" now={NOW} initialFilter="upcoming" />,
    );
    const esDay = new Intl.DateTimeFormat("es", {
      timeZone: "Europe/London",
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(new Date("2026-09-06T13:00:00Z"));
    expect(h).toContain(esDay); // the DATE: Spanish
    expect(h).not.toContain("Sunday 6 September");
    const esZone = new Intl.DateTimeFormat("es", { timeZone: "Europe/London", timeZoneName: "short" })
      .formatToParts(new Date("2026-09-06T13:00:00Z"))
      .find((p) => p.type === "timeZoneName")?.value;
    expect(esZone, "premise: Intl's es label is not the English one").not.toBe("BST");
    expect(h).toContain(`horarios en ${esZone}`); // the COPY around it, and the zone: Spanish
    expect(h).toContain("Todas las divisiones");
    expect(h).not.toContain("BST");
    expect(h).not.toContain("times in");
  });

  it("every card sits in a min-w-0 grid cell (class assertion — node vitest cannot measure a line box)", () => {
    // `MatchCard` truncates the entrant name, the venue and the stage line,
    // and `truncate` needs `min-w-0` on the WHOLE ancestor chain (AGENTS.md).
    // A grid item defaults to `min-width: auto`, so without this the card's
    // widest text sets the column and a 43-character name pushes the page
    // sideways at 320 instead of ellipsising.
    const h = render(doc, { initialFilter: "upcoming" });
    // `[^>]*` after the class: the list now also carries `role="list"`
    // (final review C8 — Tailwind's preflight strips list semantics, and the
    // reason held on one tab and was missing on five). The assertion is about
    // the `<li>` being the GRID ITEM, not about which attributes the `<ul>`
    // happens to carry.
    expect(h).toMatch(/<ul class="[^"]*grid[^"]*"[^>]*><li class="[^"]*min-w-0/);
  });

  // ------------------------------------------------- reconciling a stale choice

  /** Every `mh-filter-*` chip currently carrying `aria-pressed="true"`. A
   *  COUNT, not a containment check: the defect this catches is ZERO pressed
   *  chips, which every `toContain`-shaped assertion in this file passes. */
  const pressedFilters = (h: string) =>
    [...h.matchAll(/data-testid="(mh-filter-[a-z]+)"[^>]*aria-pressed="true"/g)].map((x) => x[1]);

  it("a chosen bucket that has NO matches falls back to the ladder — never a rail with nothing pressed (review F1)", () => {
    // Two ways in, and they are the same state: `?filter=live` on a hub with
    // no live match (this render), and a live match ENDING under a spectator
    // who tapped Live, because `use-live-competition.ts` swaps the whole
    // document every tick (design R10). Before the fix this rendered a rail of
    // chips with none pressed above "No matches for this filter".
    const liveFree = hubDoc({
      matches: [
        m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"),
        m("u2", "upcoming", "2026-09-06T15:00:00Z", "t8"),
      ],
    });
    const h = render(liveFree, { initialFilter: "live" });
    expect(pressedFilters(h)).toEqual(["mh-filter-upcoming"]);
    expect(h).toContain(`data-testid="mh-match-u1"`);
    expect(h).not.toContain(`data-testid="mh-matches-empty-filter"`);

    // The positive pair, on the SAME document: a chosen bucket that does have
    // matches is still honoured, so the fallback cannot be passing by ignoring
    // the choice altogether.
    expect(pressedFilters(render(doc, { initialFilter: "completed" }))).toEqual([
      "mh-filter-completed",
    ]);
  });

  it("exactly one filter chip is pressed in every state the ladder can reach", () => {
    // The generalisation of the case above: whatever the document and whatever
    // was asked for, a rail that renders at all names its own selection once.
    for (const over of [
      {},
      { initialFilter: "live" as const },
      { initialFilter: "upcoming" as const },
      { initialFilter: "completed" as const },
    ]) {
      expect(pressedFilters(render(doc, over)), JSON.stringify(over)).toHaveLength(1);
    }
  });

  it("a chosen division with NO fixtures falls back to All, which is the only control that could clear it (review F2)", () => {
    // The hub document carries every division, including ones drawn but never
    // scheduled. `?division=ghost` used to narrow to nothing AND suppress the
    // rail (a fixture-less division is not a chip), so the All chip that would
    // clear it was gone too: no on-screen escape at all.
    const ghosted = hubDoc({
      matches: [
        m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"),
        m("u2", "upcoming", "2026-09-06T15:00:00Z", "sunday"),
      ],
      divisions: [division("t8"), division("sunday"), division("ghost")],
    });
    const h = render(ghosted, { initialDivision: "ghost" });
    expect(h).toMatch(/data-testid="mh-division-all"[^>]*aria-pressed="true"/);
    expect(h).not.toContain(`data-testid="mh-division-ghost"`); // no fixtures, no chip
    expect(h).toContain(`data-testid="mh-match-u1"`);
    expect(h).not.toContain(`data-testid="mh-matches-empty-filter"`);
  });

  it("a bare `?division=` reads as an empty string, and it too falls back to All", () => {
    // `URLSearchParams.get("division")` on `?division=` returns `""`, and
    // `initialDivision ?? null` KEPT it: `division === null` was false so All
    // rendered unpressed, and `divisionSlug === ""` matched nothing. One
    // predicate closes this with the case above — no division has slug `""`.
    const h = render(doc, { initialDivision: "" });
    expect(h).toMatch(/data-testid="mh-division-all"[^>]*aria-pressed="true"/);
    expect(h).not.toContain(`data-testid="mh-matches-empty-filter"`);
  });

  it("a division chosen while the rail is SUPPRESSED falls back to All (one division is no choice, so there is no chip to un-press)", () => {
    const single = hubDoc({
      matches: [
        m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"),
        m("u2", "upcoming", "2026-09-06T15:00:00Z", "t8"),
      ],
    });
    const h = render(single, { initialDivision: "t8" });
    expect(h).not.toContain(`data-testid="mh-divisions"`);
    expect(h).toContain(`data-testid="mh-match-u1"`);
    expect(h).not.toContain(`data-testid="mh-matches-empty-filter"`);
  });

  it("the reconciliation is against the CHIPS on screen, not merely against the divisions that have fixtures", () => {
    // The witness that separates those two readings, and the reason the
    // component derives one `divisionChips` list that both the rail and the
    // reconciliation read. Nothing in `CompetitionHubDoc` cross-checks a
    // match's `divisionSlug` against `divisions` (the refinement only pins
    // `tabs`), so a builder fault can produce a match whose division the
    // document does not list. Reconciling against "divisions with fixtures"
    // would then honour `t8`, hide the unlisted match, and leave no rail to
    // undo it — F2's stranding, one document shape further out.
    const orphaned = hubDoc({
      matches: [
        m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"),
        m("u2", "upcoming", "2026-09-06T15:00:00Z", "unlisted"),
      ],
      divisions: [division("t8")],
    });
    const h = render(orphaned, { initialDivision: "t8" });
    expect(h).not.toContain(`data-testid="mh-divisions"`);
    expect(h).toContain(`data-testid="mh-match-u1"`);
    expect(h).toContain(`data-testid="mh-match-u2"`);
  });

  // ------------------------------------------------------------ day ordering

  it("a COMPLETED list opens on the most recent day, and unscheduled still sorts last (review F9)", () => {
    // `sortHubMatches` reads completed newest-first; `groupByDay` then re-sorts
    // the GROUPS ascending, so the intent survived inside a day and inverted
    // between days — Results opened on the competition's first match day.
    const h = render(
      hubDoc({
        matches: [
          m("c-old", "completed", "2026-09-03T10:00:00Z", "t8"),
          m("c-new", "completed", "2026-09-04T10:00:00Z", "t8"),
          m("c-tbd", "completed", null, "t8"),
        ],
      }),
      { initialFilter: "completed" },
    );
    const newest = h.indexOf(`data-testid="mh-day-2026-09-04"`);
    const oldest = h.indexOf(`data-testid="mh-day-2026-09-03"`);
    const undated = h.indexOf(`data-testid="mh-day-unscheduled"`);
    expect(newest).toBeGreaterThan(-1);
    expect(newest).toBeLessThan(oldest);
    expect(undated).toBeGreaterThan(oldest);
  });

  it("UPCOMING days stay ascending — the reversal is scoped to Completed (ordering-differential pair)", () => {
    const h = render(
      hubDoc({
        matches: [
          m("u-late", "upcoming", "2026-09-07T10:00:00Z", "t8"),
          m("u-soon", "upcoming", "2026-09-06T10:00:00Z", "t8"),
        ],
      }),
      { initialFilter: "upcoming" },
    );
    expect(h.indexOf(`data-testid="mh-day-2026-09-06"`)).toBeLessThan(
      h.indexOf(`data-testid="mh-day-2026-09-07"`),
    );
  });

  // ------------------------------------------------------------ zone caption

  describe("showZoneCaption", () => {
    // Extracted from the JSX (review F4) precisely so these arms exist: with
    // the predicate inlined, `renderToStaticMarkup` always took the server
    // snapshot and a mutant deleting the `viewerZone` comparison survived the
    // whole suite.
    const london = { key: "2026-09-06", tz: "Europe/London", items: [{ tz: "Europe/London" }] };

    it("shown when the viewer's zone is unknown (the server render) or different", () => {
      expect(showZoneCaption(london, null)).toBe(true);
      expect(showZoneCaption(london, "Asia/Kolkata")).toBe(true);
    });

    it("DROPPED when the viewer is already in that zone — the arm no static-markup test can reach", () => {
      expect(showZoneCaption(london, "Europe/London")).toBe(false);
    });

    it("DROPPED for the unscheduled group — there is no instant to state a zone at", () => {
      expect(showZoneCaption({ ...london, key: "unscheduled" }, null)).toBe(false);
    });

    it("DROPPED when the group's fixtures DISAGREE about their zone (review P2)", () => {
      // `DayGroup.tz` is the FIRST item's zone and `lib/matches-hub.ts:120-123`
      // says it is meaningful "for the common case (one competition, one zone)
      // and only that". Captioning a mixed group "times in BST" over a card
      // showing an IST kick-off states something false; silence is honest, and
      // each card still carries its own time in its own zone.
      expect(
        showZoneCaption(
          { ...london, items: [{ tz: "Europe/London" }, { tz: "Asia/Kolkata" }] },
          null,
        ),
      ).toBe(false);
    });
  });

  it("a day whose fixtures span two zones renders NO caption, and both cards still render (review P2, end to end)", () => {
    // 13:00Z is 2026-09-06 in London and 18:30 the same day in Kolkata, so the
    // two share a day key and land in one group with disagreeing zones.
    const h = render(
      hubDoc({
        matches: [
          m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"),
          m("u2", "upcoming", "2026-09-06T13:00:00Z", "t8", { tz: "Asia/Kolkata" }),
        ],
      }),
      { initialFilter: "upcoming" },
    );
    expect(h).toContain(`data-testid="mh-day-2026-09-06"`);
    expect(h).not.toContain("times in");
    expect(h).toContain(`data-testid="mh-match-u1"`);
    expect(h).toContain(`data-testid="mh-match-u2"`);
  });

  it("chips are 44px tap targets, the rails bleed to the phone edge (R1), and wrap from lg (Knockout fix round C1)", () => {
    const h = render();
    const filters = h.match(/data-testid="mh-filters"[^>]*class="([^"]*)"/)?.[1];
    expect(filters, "the filter rail's class attribute").toBeTruthy();
    for (const cls of ["overflow-x-auto", "max-md:-mx-4", "max-md:px-4", "lg:flex-wrap"]) {
      expect(filters!.split(" "), cls).toContain(cls);
    }
    // Wrapping is for a mouse at lg, which cannot scroll a rail sideways; a
    // phone keeps the swipe rail, so there is no bare `flex-wrap`.
    expect(filters!.split(" ")).not.toContain("flex-wrap");
    const chip = h.match(/data-testid="mh-filter-live"[^>]*class="([^"]*)"/)?.[1];
    expect(chip, "the Live chip's class attribute").toBeTruthy();
    expect(chip!.split(" ")).toContain("min-h-11");
    expect(chip!.split(" ")).toContain("shrink-0");
  });
});
