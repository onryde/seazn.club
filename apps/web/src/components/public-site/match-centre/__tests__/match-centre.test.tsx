// Spectator surface W1, Task 10 — MatchCentre static-markup tests.
// `renderToStaticMarkup` is real React SSR (no jsdom needed) and does NOT run
// effects — exactly right for pinning the INITIAL render (which tabs show,
// which panel is active, the active tab from `tabParam`) without needing the
// `_hook-harness` (that harness is reserved for `useLiveFixture`'s own
// effect-driven transport test). `useLiveFixture` itself still runs (its
// `useState` initial values execute fine under SSR); only its `useEffect`
// bodies (poll/realtime wiring) are skipped, which is irrelevant here since
// these tests never advance a clock.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MatchCentreDocT, MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../../live-score-data";
import { MatchCentre, type MatchCentreProps } from "../match-centre";

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
      updatedAt: new Date().toISOString(),
    },
    tabs: ["summary", "scorecard", "commentary", "timeline", "sets", "info"],
    cricket: null,
    timeline: null,
    sets: null,
    info: { rows: [], calendarHref: null, divisionHref: "/d", competitionHref: "/c" },
    ...overrides,
  };
}

function props(doc: MatchCentreDocT, tabParam: string | null = null): MatchCentreProps {
  const initial: LiveFixtureData = { status: "scheduled", summary: null, outcome: null, match_centre: doc };
  return { fixtureId: doc.fixtureId, initial, realtime: false, dict, locale: "en", tabParam };
}

const fullDoc = buildDoc();
// A lower fidelity-band document (design doc: bands 0–3) — no play-by-play
// feed at this band, so "commentary" is absent from `tabs` entirely; a band
// is a document-level fact MatchCentre reads off `doc.tabs`, never derives.
const band2Doc = buildDoc({
  cricket: null,
  tabs: ["summary", "scorecard", "sets", "info"] as MatchCentreTabIdT[],
});

describe("MatchCentre", () => {
  it("renders only the tabs the document lists — a band-2 doc has no mc-tab-commentary", () => {
    const html = renderToStaticMarkup(<MatchCentre {...props(band2Doc)} />);
    expect(html).not.toContain('data-testid="mc-tab-commentary"');
    expect(html).toContain('data-testid="mc-tab-scorecard"');
  });

  it("a full-band document renders every tab it lists, commentary included", () => {
    const html = renderToStaticMarkup(<MatchCentre {...props(fullDoc)} />);
    expect(html).toContain('data-testid="mc-tab-commentary"');
    expect(html).toContain('data-testid="mc-tab-summary"');
    expect(html).toContain('data-testid="mc-tab-sets"');
    expect(html).toContain('data-testid="mc-tab-info"');
  });

  it("shows the active tab's panel container and hides every other tab's panel — no ?tab param defaults to the first listed tab", () => {
    const html = renderToStaticMarkup(<MatchCentre {...props(fullDoc)} />);
    // doc.tabs[0] is "summary" — Task 11 replaced its placeholder with the
    // real SummaryTab, which (fullDoc.cricket === null) renders LiveScoreBody;
    // "Not started" is LiveScoreBody's own headline fallback (live-score.tsx),
    // so its presence here is proof the summary tab is the one active.
    expect(html).toContain("Not started");
    expect(html).not.toContain('data-testid="mc-tab-panel-scorecard"');
    expect(html).not.toContain('data-testid="mc-tab-panel-commentary"');
    expect(html).not.toContain('data-testid="mc-tab-panel-timeline"');
    expect(html).not.toContain('data-testid="mc-tab-panel-sets"');
    expect(html).not.toContain('data-testid="mc-tab-panel-info"');
  });

  it("a ?tab param that IS one of the document's tabs selects that tab's panel at first render", () => {
    const html = renderToStaticMarkup(<MatchCentre {...props(fullDoc, "sets")} />);
    expect(html).toContain('data-testid="mc-tab-panel-sets"');
    expect(html).toContain('data-testid="mc-tab-sets" aria-selected="true"');
    expect(html).not.toContain("Not started"); // summary (LiveScoreBody's marker) is NOT active
  });

  it("a ?tab param NOT in the document's tabs falls back to the first listed tab, not a crash", () => {
    const html = renderToStaticMarkup(<MatchCentre {...props(band2Doc, "commentary")} />);
    expect(html).toContain("Not started"); // falls back to "summary" (doc.tabs[0])
    expect(html).not.toContain('data-testid="mc-tab-commentary"');
  });

  it("renders the court card with the document's own header", () => {
    const html = renderToStaticMarkup(<MatchCentre {...props(fullDoc)} />);
    expect(html).toContain('data-testid="mc-court-card"');
    expect(html).toContain("HOM"); // CourtCard prefers the side's short label
    expect(html).toContain("AWY");
  });

  it("each tab's panel is wrapped in role=tabpanel with the id/aria-labelledby pairing its tab button controls", () => {
    const html = renderToStaticMarkup(<MatchCentre {...props(fullDoc, "sets")} />);
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="mc-tab-panel-sets"');
    expect(html).toContain('aria-labelledby="mc-tab-sets"');
    // The rail's own button carries the id this aria-labelledby points at.
    expect(html).toContain('id="mc-tab-sets"');
  });
});

// Review fix round 1 (IMPORTANT 6, MINOR 8) — MatchCentre never renders a
// silent blank page: an absent or empty-tabs document falls back to
// LiveScoreBody (today's page, degraded but present) inside a
// `data-testid="mc-fallback"` wrapper.
describe("MatchCentre — graceful fallback (no document, or an empty tabs list)", () => {
  it("an `initial` with NO match_centre document renders the mc-fallback LiveScoreBody, not a blank page", () => {
    const initial: LiveFixtureData = { status: "scheduled", summary: null, outcome: null }; // no match_centre at all
    const html = renderToStaticMarkup(
      <MatchCentre fixtureId="fx-none" initial={initial} realtime={false} dict={dict} locale="en" tabParam={null} />,
    );
    expect(html).toContain('data-testid="mc-fallback"');
    expect(html).toContain("Not started"); // LiveScoreBody's own headline fallback
    expect(html).not.toContain('data-testid="mc-root"');
    expect(html).not.toContain('data-testid="mc-court-card"');
  });

  it("a document with an EMPTY tabs array also falls back, rather than crashing on tabs[0]", () => {
    const emptyTabsDoc = buildDoc({ tabs: [] as unknown as MatchCentreTabIdT[] });
    expect(() => renderToStaticMarkup(<MatchCentre {...props(emptyTabsDoc)} />)).not.toThrow();
    const html = renderToStaticMarkup(<MatchCentre {...props(emptyTabsDoc)} />);
    expect(html).toContain('data-testid="mc-fallback"');
  });
});
