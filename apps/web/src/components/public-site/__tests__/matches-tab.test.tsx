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
import { MatchesTab, type MatchesTabProps } from "../matches-hub/matches-tab";
import { hubDoc, m } from "./hub-fixtures";

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

  it("upcoming matches group by venue day with a day header and the zone caption; unscheduled last", () => {
    const h = render(doc, { initialFilter: "upcoming" });
    expect(h).toContain(`data-testid="mh-day-2026-09-06"`);
    // `fmtDate(tz, iso, { weekday: "long", day: "numeric", month: "long" })`.
    // The brief's own comment here said "in the ORG locale"; that is FALSE and
    // the correction matters, because it is the difference between a test
    // pinning a bug and a test pinning a deliberate deferral. `format.ts:10`
    // is `const LOCALE = "en-GB"`, hard-pinned, and `fmtDate` (`format.ts:33`)
    // takes NO locale parameter — so every date on the public spectator
    // surface renders in English in all four locales, repo-wide, deferred to
    // the wave that threads the resolved locale through those signatures (see
    // that file's own header comment). The Spanish test below is this fact's
    // second, deliberate witness.
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

  it("filter and division rails are focusable, named scrolling regions (R1)", () => {
    const h = render();
    expect(h).toMatch(/data-testid="mh-filters"[^>]*role="group"[^>]*tabindex="0"[^>]*aria-label="/);
    expect(h).toMatch(/data-testid="mh-divisions"[^>]*role="group"[^>]*tabindex="0"[^>]*aria-label="/);
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
    // `fmtZoneAbbrev(tz, null)` falls back to `new Date()` — it would happily
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

  it("the day heading is ENGLISH in every locale — `format.ts:10` pins the formatter to en-GB and `fmtDate` takes no locale (the dictionary copy around it IS translated)", () => {
    // Deliberate and repo-wide, not a defect this test is freezing: `fmtDate`
    // has no locale parameter to thread, and giving it one is a separate wave
    // (`format.ts`'s header comment). What this pins is that the surrounding
    // COPY is not English by accident — if the caption were hardcoded rather
    // than dictionary-resolved, this test is what would catch it.
    const h = renderToStaticMarkup(
      <MatchesTab doc={doc} dict={es as Dict} locale="es" now={NOW} initialFilter="upcoming" />,
    );
    expect(h).toContain("Sunday 6 September"); // the DATE: English, in Spanish
    expect(h).toContain("horarios en BST"); // the COPY around it: translated
    expect(h).toContain("Todas las divisiones");
    expect(h).not.toContain("times in BST");
  });

  it("every card sits in a min-w-0 grid cell (class assertion — node vitest cannot measure a line box)", () => {
    // `MatchCard` truncates the entrant name, the venue and the stage line,
    // and `truncate` needs `min-w-0` on the WHOLE ancestor chain (AGENTS.md).
    // A grid item defaults to `min-width: auto`, so without this the card's
    // widest text sets the column and a 43-character name pushes the page
    // sideways at 320 instead of ellipsising.
    const h = render(doc, { initialFilter: "upcoming" });
    expect(h).toMatch(/<ul class="[^"]*grid[^"]*"><li class="[^"]*min-w-0/);
  });

  it("chips are 44px tap targets and the rails bleed to the phone edge (R1)", () => {
    const h = render();
    const filters = h.match(/data-testid="mh-filters"[^>]*class="([^"]*)"/)?.[1];
    expect(filters, "the filter rail's class attribute").toBeTruthy();
    for (const cls of ["overflow-x-auto", "max-md:-mx-4", "max-md:px-4"]) {
      expect(filters!.split(" "), cls).toContain(cls);
    }
    const chip = h.match(/data-testid="mh-filter-live"[^>]*class="([^"]*)"/)?.[1];
    expect(chip, "the Live chip's class attribute").toBeTruthy();
    expect(chip!.split(" ")).toContain("min-h-11");
    expect(chip!.split(" ")).toContain("shrink-0");
  });
});
