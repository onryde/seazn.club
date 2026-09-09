// Spectator surface W2, Task 7 — `PublicTabRail`'s static-markup contract
// (brief's own Step 4 test, verbatim, plus one rendered-copy check). Same DOM
// contract as W1's `TabRail` (`match-centre/tab-rail.tsx`) but parameterised
// on caller-supplied `{id,label}` pairs instead of the match-centre's fixed
// dictionary lookups — the hub's own tab set is DERIVED per document
// (`deriveHubTabs`), so this rail cannot hard-code a vocabulary.
//
// Assertions anchor on `="` — an omitted prop serialises as `"$undefined"`,
// so a bare attribute-name probe would pass in both states (AGENTS.md).
// Keyboard behaviour (Left/Right/Home/End) is not unit-testable here — no
// jsdom to dispatch a real KeyboardEvent — the same documented gap
// `tab-rail.test.tsx` records for its own suite.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicTabRail } from "../tab-rail";

const tabs = [
  { id: "overview" as const, label: "Overview" },
  { id: "matches" as const, label: "Matches" },
];

describe("PublicTabRail", () => {
  it("the tablist is NAMED but not itself focusable; the SELECTED tab is the rail's single tab stop and the inactive one is out of the tab order (positive pair); one role=tab per tab with the prefix's testids", () => {
    const h = renderToStaticMarkup(
      <PublicTabRail
        tabs={tabs}
        active="matches"
        onChange={() => {}}
        ariaLabel="Competition sections"
        testidPrefix="mh"
      />,
    );
    // ROVING TABINDEX, not a focusable tablist. The brief specified
    // `tabIndex={0}` on the container, which is the shape W1's whole-branch
    // review already removed from `match-centre/tab-rail.tsx` — a rail with
    // its own tab stop plus one per button costs a keyboard user N+1 stops
    // before the content. Folding this rail onto W1's (Task 19) would have
    // propagated the regression back INTO the match centre.
    expect(h).toMatch(/role="tablist"[^>]*aria-label="Competition sections"/);
    expect(h).not.toMatch(/role="tablist"[^>]*tabindex=/);
    expect(h.match(/role="tab"/g)?.length).toBe(2);
    expect(h).toMatch(
      /id="mh-tab-matches"[^>]*aria-controls="mh-tab-panel-matches"[^>]*tabindex="0"[^>]*data-testid="mh-tab-matches"[^>]*aria-selected="true"/,
    );
    // The positive pair: the INACTIVE tab is out of the tab order entirely,
    // which is the half that makes it a single stop rather than none.
    expect(h).toMatch(/tabindex="-1"[^>]*data-testid="mh-tab-overview"[^>]*aria-selected="false"/);
  });

  it("renders the real label text, not a bare id or dictionary key (RENDERED COPY, not just a testid)", () => {
    const h = renderToStaticMarkup(
      <PublicTabRail
        tabs={tabs}
        active="matches"
        onChange={() => {}}
        ariaLabel="Competition sections"
        testidPrefix="mh"
      />,
    );
    expect(h).toContain(">Overview<");
    expect(h).toContain(">Matches<");
  });
});
