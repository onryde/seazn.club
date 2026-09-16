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
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
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
    expect(html).toContain('data-testid="mc-info"');
    expect(html).not.toContain('data-testid="mc-info-0"');
    // The links are NOT rows and must survive an empty row list.
    expect(html).toContain('data-testid="mc-info-division"');
    expect(html).toContain('data-testid="mc-info-competition"');
    expect(render(FULL)).toContain('data-testid="mc-info-0"'); // positive pair
  });

  it("the root does NOT claim the tabpanel role — MatchCentre's wrapper owns it", () => {
    // `MatchCentre` wraps whichever panel is active in ONE element carrying
    // `role="tabpanel"`, `id="mc-tab-panel-info"` and `aria-labelledby`. A
    // panel that also declared them would nest two tabpanels and put the same
    // id in the document twice — so this asserts their ABSENCE, and the panel
    // keeps only its own testid.
    const html = render(FULL);
    expect(html).toContain('data-testid="mc-info"');
    expect(html).not.toContain('role="tabpanel"');
    expect(html).not.toContain('id="mc-tab-panel-info"');
    expect(html).not.toContain('aria-labelledby=');
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

  it("internal links are routes; the calendar link is a plain download", () => {
    const html = render(FULL);
    // next/link renders an <a> in static markup, so this asserts the
    // DISTINCTION that matters at runtime rather than the element name: the
    // .ics href is a file, the other two are routes.
    expect(html).toContain('href="/api/v1/public/fixtures/fx-1/ics"');
    expect(html).toContain('href="/o/acme/c/summer/d/a"');
    expect(html).toContain('href="/o/acme/c/summer"');
    // No link renders without a destination.
    expect(html).not.toContain('href=""');
  });

  it("no dictionary key leaks into the markup unresolved", () => {
    for (const info of [FULL, NO_CALENDAR, NO_ROWS]) {
      const html = render(info);
      expect(html).not.toContain("matchCentre.");
      expect(html).not.toContain("term.");
    }
  });
});

// Task 16 (zero-English sweep): the toss row's value is
// `matchCentre.info.tossValue` with `elected` — the engine's own enum token,
// "bat" or "bowl". The Summary tab already swapped it for its `term.*` word
// (`localiseParams`); this tab did not, so a Spanish Info tab read
// "Leones — eligió bat".
describe("InfoTab — the toss row's engine token is localised", () => {
  const TOSS: InfoViewT = {
    ...FULL,
    rows: [
      {
        label: { key: "matchCentre.info.toss" },
        value: { key: "matchCentre.info.tossValue", params: { side: "Leones", elected: "bat" } },
      },
    ],
  };
  for (const [locale, d] of Object.entries({ en, es, fr, nl })) {
    it(`${locale}: "elected" reads term.bat, never the bare token`, () => {
      const pub = d as Dict;
      const html = renderToStaticMarkup(<InfoTab doc={makeDoc({ info: TOSS })} dict={pub} data={data} />);
      const term = (pub as Record<string, string>)["term.bat"]!;
      const expected = (pub as Record<string, string>)["matchCentre.info.tossValue"]!
        .replace("{side}", "Leones")
        .replace("{elected}", term);
      expect(html).toContain(expected);
      if (locale !== "en") {
        expect(term, "premise: the locale's word is not the token").not.toBe("bat");
        expect(html).not.toMatch(/\bbat\b/);
      }
    });
  }
});
