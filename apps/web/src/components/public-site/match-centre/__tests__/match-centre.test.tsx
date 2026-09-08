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
      phase: null,
      strength: null,
      updatedAt: new Date().toISOString(),
    },
    tabs: ["summary", "scorecard", "commentary", "timeline", "sets", "info"],
    cricket: null,
    timeline: null,
    sets: null,
    info: { rows: [], calendarHref: null, divisionHref: "/d", competitionHref: "/c" },
    // REQUIRED, not optional: `derivedComplete` has a zod `.default(true)`, and
    // a defaulted field is required on the schema's OUTPUT type — which is what
    // `MatchCentreDocT` is. Spelled out rather than weakening the schema: a
    // parsed document ALWAYS carries the flag, so a consumer never has to ask
    // whether it was present.
    derivedComplete: true,
    ...overrides,
  };
}

function props(doc: MatchCentreDocT, tabParam: string | null = null): MatchCentreProps {
  const initial: LiveFixtureData = { status: "scheduled", summary: null, outcome: null, match_centre: doc };
  return { fixtureId: doc.fixtureId, initial, realtime: false, dict, tabParam };
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
    // doc.tabs[0] is "summary" — anchored on the STRUCTURAL tabpanel id
    // (review fix round 2 minor), not an English literal like "Not started"
    // (SummaryTab's own rendered content, which is locale- and
    // sport-dependent and so a fragile identity check).
    expect(html).toContain('id="mc-tab-panel-summary"');
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
    expect(html).not.toContain('id="mc-tab-panel-summary"'); // summary is NOT the active panel
  });

  it("a ?tab param NOT in the document's tabs falls back to the first listed tab, not a crash", () => {
    const html = renderToStaticMarkup(<MatchCentre {...props(band2Doc, "commentary")} />);
    expect(html).toContain('id="mc-tab-panel-summary"'); // falls back to "summary" (doc.tabs[0])
    expect(html).not.toContain('data-testid="mc-tab-commentary"');
  });

  it("renders the court card with the document's own header", () => {
    const html = renderToStaticMarkup(<MatchCentre {...props(fullDoc)} />);
    expect(html).toContain('data-testid="mc-court-card"');
    expect(html).toContain("HOM"); // CourtCard prefers the side's short label
    expect(html).toContain("AWY");
  });

  it("each tab's panel is wrapped in EXACTLY ONE role=tabpanel with the id/aria-labelledby pairing its tab button controls", () => {
    const html = renderToStaticMarkup(<MatchCentre {...props(fullDoc, "sets")} />);
    // Review fix round 2 (Task 10 deferred minor, + a follow-up correction)
    // — exactly one, not just "at least one": a second stray tabpanel
    // wrapper (or, before the follow-up, the "sets" PLACEHOLDER's own now-
    // removed `data-testid="mc-tab-panel-sets"` duplicating the wrapper's)
    // would still pass a bare `.toContain`.
    expect(html.match(/role="tabpanel"/g)?.length).toBe(1);
    expect(html.match(/data-testid="mc-tab-panel-[a-z]+"/g)?.length).toBe(1);
    expect(html).toContain('id="mc-tab-panel-sets"');
    expect(html).toContain('data-testid="mc-tab-panel-sets"');
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
      <MatchCentre fixtureId="fx-none" initial={initial} realtime={false} dict={dict} tabParam={null} />,
    );
    expect(html).toContain('data-testid="mc-fallback"');
    // Review round 3 — LiveScoreBody's headline fallback keeps its ORIGINAL
    // copy verbatim, on its own key `matchCentre.status.notStarted` ("Not
    // started"), per the product owner's ruling — round 2 briefly routed it
    // through matchCentre.status.scheduled ("Scheduled") instead, which
    // silently changed the copy a live Playwright spec
    // (e2e/scorepad-v3-football.spec.ts) asserts on the legacy fixture
    // page. Anchor on the dict VALUE, not the literal, either way.
    expect(html).toContain(dict["matchCentre.status.notStarted"] as string);
    expect(html).not.toContain('data-testid="mc-root"');
    expect(html).not.toContain('data-testid="mc-court-card"');
  });

  it("a document with an EMPTY tabs array also falls back, rather than crashing on tabs[0] — AND still names both sides (the document HAD a header, unlike the no-document case)", () => {
    const emptyTabsDoc = buildDoc({ tabs: [] as unknown as MatchCentreTabIdT[] });
    expect(() => renderToStaticMarkup(<MatchCentre {...props(emptyTabsDoc)} />)).not.toThrow();
    // A `summary.perSide` is what actually surfaces `entrantNames` in
    // `LiveScoreBody`'s markup — the bare `props()` helper's `summary: null`
    // fixture renders nothing that would exercise the names lookup at all.
    const initial: LiveFixtureData = {
      status: "scheduled",
      summary: { perSide: [{ entrantId: "home", line: "—" }, { entrantId: "away", line: "—" }] },
      outcome: null,
      match_centre: emptyTabsDoc,
    };
    const html = renderToStaticMarkup(
      <MatchCentre fixtureId={emptyTabsDoc.fixtureId} initial={initial} realtime={false} dict={dict} tabParam={null} />,
    );
    expect(html).toContain('data-testid="mc-fallback"');
    // Review fix round 2 (Task 10 deferred minor) — the document (just an
    // empty tabs list) still has a real header with both sides' names.
    expect(html).toContain("Home");
    expect(html).toContain("Away");
  });
});

// ---------------------------------------------------------------------------
// Accessibility (whole-branch review) — THE TABPANEL MUST BE REACHABLE.
// ---------------------------------------------------------------------------
//
// The Info and Timeline panels contain no focusable element at all: prose,
// definition rows, a list of lines. Under the APG tabs pattern that is exactly
// the case where the panel itself takes `tabIndex={0}` — otherwise a keyboard
// user arrows along the rail, presses Tab, and lands PAST the content the rail
// was selecting, with no way to scroll or read it from the keyboard.
//
// Applied unconditionally rather than "only when the panel has no focusable
// child": which panels have one is data-dependent (a scorecard's scroll
// regions appear only when there are rows to scroll), so a conditional would
// be a rule that silently changed with the document.
//
// MUTANT KILLED: `tabIndex={0}` deleted from the wrapper, applied by hand and
// restored from a `cp` backup of the FIXED state (`numTotalTests` stayed 534).
// → RED: "the role=tabpanel wrapper carries tabIndex=0, for panels with
// nothing focusable inside".
describe("MatchCentre — the tabpanel wrapper is focusable", () => {
  it("the role=tabpanel wrapper carries tabIndex=0, for panels with nothing focusable inside", () => {
    for (const tab of ["info", "timeline", "summary"] as const) {
      const html = renderToStaticMarkup(<MatchCentre {...props(fullDoc, tab)} />);
      const wrapperTag = html.match(/<div[^>]*role="tabpanel"[^>]*>/)?.[0];
      expect(wrapperTag, tab).toBeTruthy();
      expect(wrapperTag, tab).toContain('tabindex="0"');
      // The positive pair: it is still the SAME element that owns the role,
      // the id and the label — this adds a tab stop, it does not move the
      // panel's identity onto a new wrapper.
      expect(wrapperTag, tab).toContain(`id="mc-tab-panel-${tab}"`);
      expect(wrapperTag, tab).toContain(`aria-labelledby="mc-tab-${tab}"`);
    }
  });

  it("the no-document fallback does NOT invent a tabpanel", () => {
    // The negative half: `tabIndex` belongs to the tabpanel, and the fallback
    // branch has no rail and no panel — a blanket `tabIndex={0}` sprayed on
    // every wrapper would show up here.
    const html = renderToStaticMarkup(<MatchCentre {...props(buildDoc({ tabs: [] }))} />);
    expect(html).toContain('data-testid="mc-fallback"');
    expect(html).not.toContain('role="tabpanel"');
  });
});
