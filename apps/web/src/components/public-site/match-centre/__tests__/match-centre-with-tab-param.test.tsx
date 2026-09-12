// Spectator surface W1, Task 14d — the fixture page's ISR contract (task-8)
// forbids reading `searchParams` on the SERVER (that throws
// `DYNAMIC_SERVER_USAGE` under `revalidate` + empty-array
// `generateStaticParams`), so the `?tab=` deep link now moves client-side:
// `MatchCentreWithTabParam` reads it via `useSearchParams` (next/navigation)
// inside a `<Suspense>` boundary and forwards it to `MatchCentre` as the SAME
// `tabParam` prop `match-centre.test.tsx` already pins directly.
//
// `next/navigation` is mocked rather than exercised for real: the actual
// App Router context that backs `useSearchParams` is an internal Next
// module with no public test seam (see public-isr-contract.test.ts's own
// "No render harness exists here" — same shape of gap). Two things ARE
// verifiable under plain `renderToStaticMarkup` (real React SSR, no jsdom):
// (1) the wiring from a resolved `searchParams.get("tab")` value through to
// `MatchCentre`'s tab-selection behaviour, reusing match-centre.test.tsx's
// own assertions; and (2) React's own well-documented `renderToStaticMarkup`
// contract that a suspended child renders its nearest Suspense boundary's
// `fallback` — which lets a mock that throws a never-resolving promise stand
// in for "the route was prerendered, so useSearchParams bailed to CSR" and
// prove the fallback is the FULL `<MatchCentre tabParam={null}>`, not a
// blank spinner.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MatchCentreDocT, MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../../live-score-data";

const useSearchParams = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => useSearchParams(),
}));

const dict = en as Dict;

function buildDoc(overrides: Partial<MatchCentreDocT> = {}): MatchCentreDocT {
  return {
    fixtureId: "fx-1",
    sportKey: "cricket",
    header: {
      live: false,
      status: "scheduled",
      sides: [
        { entrantId: "home", name: "Home", short: "HOM", colour: null, badgeUrl: null },
        { entrantId: "away", name: "Away", short: "AWY", colour: null, badgeUrl: null },
      ],
      scoreLines: [null, null],
      subLines: [null, null],
      battingIndex: null,
      statusLine: null,
      rateLine: null,
      phase: null,
      strength: null,
      pillNote: null,
      metaLine: null,
      updatedAt: new Date().toISOString(),
    },
    tabs: ["summary", "scorecard", "commentary", "timeline", "sets", "info"],
    cricket: null,
    timeline: null,
    sets: null,
    info: { rows: [], calendarHref: null, divisionHref: "/d", competitionHref: "/c" },
    derivedComplete: true,
    ...overrides,
  };
}

const fullDoc = buildDoc();

function propsWithoutTab(doc: MatchCentreDocT) {
  const initial: LiveFixtureData = { status: "scheduled", summary: null, outcome: null, match_centre: doc };
  return { fixtureId: doc.fixtureId, initial, realtime: false, dict, locale: "en" };
}

describe("MatchCentreWithTabParam — resolved searchParams (real Next behaviour once hydrated/dynamic)", () => {
  it("a ?tab value that IS one of the document's tabs selects that tab's panel, same as MatchCentre's own tabParam contract", async () => {
    useSearchParams.mockReturnValue(new URLSearchParams("tab=sets"));
    const { MatchCentreWithTabParam } = await import("../match-centre-with-tab-param");
    const html = renderToStaticMarkup(<MatchCentreWithTabParam {...propsWithoutTab(fullDoc)} />);
    expect(html).toContain('data-testid="mc-tab-panel-sets"');
    expect(html).toContain('data-testid="mc-tab-sets" aria-selected="true"');
    expect(html).not.toContain('id="mc-tab-panel-summary"');
  });

  it("no ?tab at all falls back to the document's first listed tab", async () => {
    useSearchParams.mockReturnValue(new URLSearchParams(""));
    const { MatchCentreWithTabParam } = await import("../match-centre-with-tab-param");
    const html = renderToStaticMarkup(<MatchCentreWithTabParam {...propsWithoutTab(fullDoc)} />);
    expect(html).toContain('id="mc-tab-panel-summary"');
  });

  it("a ?tab value NOT in the document's tabs falls back to the first listed tab, not a crash", async () => {
    const band2Doc = buildDoc({ tabs: ["summary", "scorecard", "sets", "info"] as MatchCentreTabIdT[] });
    useSearchParams.mockReturnValue(new URLSearchParams("tab=commentary"));
    const { MatchCentreWithTabParam } = await import("../match-centre-with-tab-param");
    const html = renderToStaticMarkup(<MatchCentreWithTabParam {...propsWithoutTab(band2Doc)} />);
    expect(html).toContain('id="mc-tab-panel-summary"');
    expect(html).not.toContain('data-testid="mc-tab-commentary"');
  });
});

describe("MatchCentreWithTabParam — suspended searchParams (the route was prerendered, so useSearchParams bails to CSR)", () => {
  it("renders the Suspense fallback: the FULL MatchCentre with tabParam=null (first tab), never a blank/spinner state", async () => {
    // React's renderToStaticMarkup contract: a child that suspends (throws a
    // promise) renders its nearest Suspense boundary's `fallback` instead —
    // this is what a prerendering pass sees for real once useSearchParams has
    // no request context to read.
    useSearchParams.mockImplementation(() => {
      throw new Promise(() => {});
    });
    const { MatchCentreWithTabParam } = await import("../match-centre-with-tab-param");
    const html = renderToStaticMarkup(<MatchCentreWithTabParam {...propsWithoutTab(fullDoc)} />);
    // The fallback IS a real, full MatchCentre (scoreboard + tabs + panel) —
    // not empty markup — so the static/ISR-cached HTML still carries content.
    expect(html).toContain('data-testid="mc-root"');
    expect(html).toContain('data-testid="mc-court-card"');
    expect(html).toContain('data-testid="mc-tab-panel-summary"');
  });
});
