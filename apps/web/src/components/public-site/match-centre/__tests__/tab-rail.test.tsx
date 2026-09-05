// Spectator surface W1, Task 10 — TabRail static-markup tests (brief's own
// Step 1 test, verbatim below). `renderToStaticMarkup` needs no DOM (real
// React SSR); TabRail's only interactive behaviour (arrow-key navigation) is
// effect-free (a plain `onKeyDown` handler), so static markup pins its
// id/aria-controls wiring even though the actual key-dispatch cannot be
// unit-tested here (no jsdom to fire a real KeyboardEvent) — that is a
// documented gap, not a skipped assertion pretending to be one. Assertions
// anchor on `="` — an omitted prop serialises as `"$undefined"`, so a bare
// attribute-name probe would pass in both states.
//
// Review fix round 1:
// - IMPORTANT 3 — the old "accented/quiet pill classes" test asserted an
//   UNTERMINATED class prefix (`bg-accent`, which is also a substring of
//   `bg-accent-soft`), so it could not actually tell the two pills apart —
//   it would have passed even if both pills carried the SAME class. Rewritten
//   below to extract each button's full `class` attribute via regex capture
//   and assert the ACTUAL difference in both directions.
// - CRITICAL 1 — a RENDERED-COPY assertion (the active tab's label reads the
//   real word "Summary", not a key) — the same class of defect the
//   "public."-prefix bug shipped past every existing testid-only assertion.
// - IMPORTANT 7 — one test pins the id/aria-controls PAIRING every tab must
//   carry for the panel it opens.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { TabRail } from "../tab-rail";

const dict = en as Dict;

it("TabRail renders one role=tab per tab with aria-selected on the active one, inside a focusable, labelled rail", () => {
  const html = renderToStaticMarkup(
    <TabRail tabs={["summary", "scorecard", "commentary", "info"]} active="scorecard" onChange={() => {}} dict={dict} />,
  );
  expect(html).toContain('role="tablist"');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain('aria-label="');
  expect(html.match(/role="tab"/g)?.length).toBe(4);
  expect(html).toContain('data-testid="mc-tab-scorecard" aria-selected="true"');
  expect(html).toContain('data-testid="mc-tab-summary" aria-selected="false"'); // positive pair of the negative
});

it("renders the real dictionary word for each tab, not a raw key (RENDERED COPY, not just a testid)", () => {
  const html = renderToStaticMarkup(
    <TabRail tabs={["summary", "scorecard"]} active="summary" onChange={() => {}} dict={dict} />,
  );
  expect(html).toContain(">Summary<");
  expect(html).toContain(">Scorecard<");
  expect(html).not.toMatch(/\bmatchCentre\.tab\./); // no raw key ever leaks into the DOM
});

it("each tab button carries id=mc-tab-<id> and aria-controls=mc-tab-panel-<id> — the pairing MatchCentre's tabpanel wrapper relies on", () => {
  const html = renderToStaticMarkup(
    <TabRail tabs={["summary", "scorecard"]} active="summary" onChange={() => {}} dict={dict} />,
  );
  expect(html).toContain('id="mc-tab-summary"');
  expect(html).toContain('aria-controls="mc-tab-panel-summary"');
  expect(html).toContain('id="mc-tab-scorecard"');
  expect(html).toContain('aria-controls="mc-tab-panel-scorecard"');
});

describe("TabRail — accented/quiet pill classes (shipped vocabulary, tabs.tsx:30-31)", () => {
  it("the active pill carries a RESTING accent background; the inactive pill has none (hover-only)", () => {
    const html = renderToStaticMarkup(
      <TabRail tabs={["summary", "scorecard"]} active="summary" onChange={() => {}} dict={dict} />,
    );
    const activeClass = html.match(/data-testid="mc-tab-summary" aria-selected="true" class="([^"]*)"/)?.[1];
    const inactiveClass = html.match(/data-testid="mc-tab-scorecard" aria-selected="false" class="([^"]*)"/)?.[1];
    expect(activeClass).toBeTruthy();
    expect(inactiveClass).toBeTruthy();

    // The ACTUAL difference, not an unterminated prefix either side would share.
    expect(activeClass).toContain("bg-accent ");
    expect(activeClass).not.toContain("bg-accent-soft");
    expect(inactiveClass).toContain("bg-accent-soft"); // present, but only inside hover:bg-accent-soft
    expect(inactiveClass).not.toMatch(/(^|\s)bg-accent(\s|$)/); // no RESTING bg-accent class

    // The shipped vocabulary itself (tabs.tsx:30-31), verbatim.
    expect(activeClass).toBe("shrink-0 rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink shadow-sm");
    expect(inactiveClass).toBe(
      "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium text-ink-muted transition hover:bg-accent-soft hover:text-accent-strong",
    );
  });
});
