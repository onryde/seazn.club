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
  it("tablist is focusable and named; one role=tab per tab with the prefix's testids; the active tab is aria-selected (positive pair on an inactive one)", () => {
    const h = renderToStaticMarkup(
      <PublicTabRail
        tabs={tabs}
        active="matches"
        onChange={() => {}}
        ariaLabel="Competition sections"
        testidPrefix="mh"
      />,
    );
    expect(h).toMatch(/role="tablist"[^>]*tabindex="0"[^>]*aria-label="Competition sections"/);
    expect(h.match(/role="tab"/g)?.length).toBe(2);
    expect(h).toMatch(
      /id="mh-tab-matches"[^>]*aria-controls="mh-tab-panel-matches"[^>]*data-testid="mh-tab-matches"[^>]*aria-selected="true"/,
    );
    expect(h).toMatch(/data-testid="mh-tab-overview"[^>]*aria-selected="false"/);
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
