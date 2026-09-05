// Spectator surface W1, Task 13 — InfoTab static-markup tests.
//
// ---------------------------------------------------------------------------
// Mutants killed (Task 13) — Info
// ---------------------------------------------------------------------------
//  (r) SORT THE ROWS — `rows.map(…)` became
//      `[...rows].sort((a, b) => a.label.key.localeCompare(b.label.key)).map(…)`.
//      The server orders them toss · format · venue · start · stage ·
//      scored-as, which is a reading order, not an alphabet.
//      → RED: "rows render in the order GIVEN".
//
//  (s) ALWAYS SHOW THE CALENDAR LINK — the `calendarHref !== null` guard
//      dropped, rendering `href={null}`.
//      → RED: "the calendar link is hidden when there is no href".
//
// Both compile and collect (`numTotalTests` unchanged), so neither is the
// collection-break shape that reads as a survivor.
import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import {
  MatchCentreDoc,
  type InfoViewT,
  type MatchCentreDocT,
} from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../../live-score-data";
import { InfoTab } from "../info-tab";
import { makeDoc } from "./fixtures";

const dict = en as Dict;
const data = {} as LiveFixtureData;

// Real dictionary keys with real params on BOTH halves of each row, so the
// assertions prove the label AND the value go through `t()` — a row that
// resolved only its label would look right in a testid-only test.
const ROWS: InfoViewT["rows"] = [
  { label: { key: "matchCentre.timeline" }, value: { key: "term.yellow" } },
  { label: { key: "matchCentre.sets" }, value: { key: "matchCentre.col.set", params: { n: 3 } } },
  {
    label: { key: "matchCentre.periods" },
    value: { key: "org.competitionsBy", params: { org: "Riverside" } },
  },
];

const FULL: InfoViewT = {
  rows: ROWS,
  calendarHref: "/api/v1/public/fixtures/fx-1/ics",
  divisionHref: "/o/acme/c/summer/d/a",
  competitionHref: "/o/acme/c/summer",
};
const NO_CALENDAR: InfoViewT = { ...FULL, calendarHref: null };
const NO_ROWS: InfoViewT = { ...FULL, rows: [] };

const render = (info: InfoViewT): string =>
  renderToStaticMarkup(<InfoTab doc={makeDoc({ info })} dict={dict} data={data} />);

const DOCS: MatchCentreDocT[] = [FULL, NO_CALENDAR, NO_ROWS].map((info) => makeDoc({ info }));

beforeAll(() => {
  for (const d of DOCS) expect(MatchCentreDoc.safeParse(d).success).toBe(true);
});

describe("InfoTab", () => {
  it("EMPTY: zero rows renders the panel container and the links, no row grid", () => {
    const html = render(NO_ROWS);
    expect(html).toContain('data-testid="mc-tab-panel-info"');
    expect(html).not.toContain('data-testid="mc-info-0"');
    // The links are NOT rows and must survive an empty row list.
    expect(html).toContain('data-testid="mc-info-division"');
    expect(html).toContain('data-testid="mc-info-competition"');
    expect(render(FULL)).toContain('data-testid="mc-info-0"'); // positive pair
  });

  it("the root IS the tab panel — role, id and the label the rail points at", () => {
    const html = render(FULL);
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="mc-tab-panel-info"');
    expect(html).toContain('aria-labelledby="mc-tab-info"');
  });

  it("rows render in the order GIVEN, with label AND value resolved", () => {
    const html = render(FULL);
    const at = (i: number) => html.indexOf(`data-testid="mc-info-${i}"`);
    expect(at(0)).toBeGreaterThanOrEqual(0);
    expect(at(0)).toBeLessThan(at(1));
    expect(at(1)).toBeLessThan(at(2));
    // The server's order is a READING order (toss · format · venue · start …),
    // and alphabetising the label keys would reorder these three — which is
    // what makes this assertion able to fail.
    expect(html.indexOf(en["matchCentre.timeline"])).toBeLessThan(
      html.indexOf(en["matchCentre.periods"]),
    );

    // Labels…
    for (const key of ["matchCentre.timeline", "matchCentre.sets", "matchCentre.periods"] as const) {
      expect(html, key).toContain(en[key]);
    }
    // …and VALUES, params and all.
    expect(html).toContain(en["term.yellow"]);
    expect(html).toContain("Set 3");
    expect(html).toContain("Competitions run by Riverside");
    expect(html).not.toContain("{n}");
    expect(html).not.toContain("{org}");
  });

  it("the calendar link is hidden when there is no href, and present when there is", () => {
    const withHref = render(FULL);
    expect(withHref).toContain('data-testid="mc-info-calendar"');
    expect(withHref).toContain('href="/api/v1/public/fixtures/fx-1/ics"');
    expect(withHref).toContain(en["matchCentre.info.addToCalendar"]);

    const without = render(NO_CALENDAR);
    expect(without).not.toContain('data-testid="mc-info-calendar"');
    // …and specifically not a link with no destination.
    expect(without).not.toContain('href=""');
  });

  it("the division and competition links carry their hrefs and localised labels", () => {
    const html = render(FULL);
    expect(html).toContain('href="/o/acme/c/summer/d/a"');
    expect(html).toContain('href="/o/acme/c/summer"');
    expect(html).toContain(en["matchCentre.info.division"]);
    expect(html).toContain(en["matchCentre.info.competition"]);
  });

  it("the rows sit in a two-column grid at phone widths", () => {
    // The brief's layout call: two columns at 320, label above value. Asserted
    // on the class because no unit test can measure paint — Task 15's
    // screenshots are what prove the labels actually fit.
    const html = render(FULL);
    expect(html).toMatch(/class="[^"]*grid-cols-2[^"]*"/);
  });

  it("no dictionary key leaks into the markup unresolved", () => {
    for (const info of [FULL, NO_CALENDAR, NO_ROWS]) {
      const html = render(info);
      expect(html).not.toContain("matchCentre.");
      expect(html).not.toContain("term.");
    }
  });
});
