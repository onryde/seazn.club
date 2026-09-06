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
//
// Defect round 15b — the walkthrough's `elementFromPoint`/`boundingBox()`
// hit-target check measures the PAINT box of the element carrying the
// testid (the `<button>`), never a descendant, so the 44px fix had to grow
// the button itself rather than only extend its hit-test area (a `::before`
// overlay would not move `boundingBox()` at all). The pill's visual classes
// moved to an inner `<span>`, unchanged from before this round; the button
// now carries a separate, plain `min-h-11` layout class. The class-pair test
// below is rewritten to pin BOTH: the button's 44px hit-area class (same for
// both tabs) and the inner span's untouched pill class (still the one
// difference between active/inactive).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { TabRail, scrollActiveTabIntoView } from "../tab-rail";

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
    // The pill's visual class now lives on the INNER span (defect round
    // 15b) — captured as whatever immediately follows the button's own
    // opening tag, so this still proves the span belongs to THIS button,
    // not just that a matching class string exists somewhere on the page.
    const activeClass = html.match(
      /data-testid="mc-tab-summary" aria-selected="true" class="[^"]*"><span class="([^"]*)"/,
    )?.[1];
    const inactiveClass = html.match(
      /data-testid="mc-tab-scorecard" aria-selected="false" class="[^"]*"><span class="([^"]*)"/,
    )?.[1];
    expect(activeClass).toBeTruthy();
    expect(inactiveClass).toBeTruthy();

    // The ACTUAL difference, not an unterminated prefix either side would share.
    expect(activeClass).toContain("bg-accent ");
    expect(activeClass).not.toContain("bg-accent-soft");
    expect(inactiveClass).toContain("bg-accent-soft"); // present, but only inside hover:bg-accent-soft
    expect(inactiveClass).not.toMatch(/(^|\s)bg-accent(\s|$)/); // no RESTING bg-accent class

    // The shipped pill vocabulary itself (tabs.tsx:30-31), verbatim, minus
    // `shrink-0` — which moved to the button (§ below), since the pill is no
    // longer the flex item the scrolling rail shrinks/grows.
    expect(activeClass).toBe("rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink shadow-sm");
    expect(inactiveClass).toBe(
      "rounded-full px-4 py-1.5 text-sm font-medium text-ink-muted transition hover:bg-accent-soft hover:text-accent-strong",
    );
  });

  // Defect round 15b — R11's 44px tap-target floor (walkthrough evidence:
  // `boundingBox()` measured ~32px at 320px). `boundingBox()` measures the
  // PAINT box of the element carrying the testid (the button), so the fix
  // has to be a real class on the BUTTON, not a pseudo-element trick a
  // measurement tool can't see. Both tabs get the SAME hit-area class —
  // only the inner pill differs by active state (test above).
  it("every tab BUTTON (not just the pill) carries a 44px min-height hit area, identical whether active or inactive", () => {
    const html = renderToStaticMarkup(
      <TabRail tabs={["summary", "scorecard"]} active="summary" onChange={() => {}} dict={dict} />,
    );
    const activeButtonClass = html.match(/data-testid="mc-tab-summary" aria-selected="true" class="([^"]*)"/)?.[1];
    const inactiveButtonClass = html.match(/data-testid="mc-tab-scorecard" aria-selected="false" class="([^"]*)"/)?.[1];
    expect(activeButtonClass).toBeTruthy();
    expect(inactiveButtonClass).toBeTruthy();
    expect(activeButtonClass).toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(inactiveButtonClass).toMatch(/(^|\s)min-h-11(\s|$)/);
    // Identical hit-area class regardless of active state — the 44px floor
    // is not a cosmetic that only the selected tab gets.
    expect(activeButtonClass).toBe(inactiveButtonClass);
    // The button itself carries NONE of the pill's visual classes any
    // more — that would double the background/shape on the enlarged box,
    // the exact thing P2 rules out ("the pill keeps its look").
    expect(activeButtonClass).not.toContain("bg-accent");
    expect(activeButtonClass).not.toContain("rounded-full");
  });
});

// R11 fix round, C6 (Task 15 re-review) — the rail never scrolled the
// selected tab into view, so a tab picked via the `?tab=` deep link could
// render clipped at the viewport edge at 320 (`match-a-tab-commentary-320.png`).
// The scroll call is extracted as a PURE function so it is testable at all in
// this workspace: `apps/web` vitest is `environment: "node"` (no jsdom, no
// `HTMLElement` global), so "mock it on the prototype" here means a plain
// class of our own with `scrollIntoView` on ITS prototype — the same
// contract (`{ scrollIntoView(options) }`) a real button element carries,
// without needing jsdom to prove the call.
describe("scrollActiveTabIntoView (R11 fix round, C6)", () => {
  class FakeTabButton {
    scrollIntoView(): void {}
  }

  it("scrolls the element into view with inline/block 'nearest' and a SMOOTH behaviour by default", () => {
    FakeTabButton.prototype.scrollIntoView = vi.fn();
    const el = new FakeTabButton();
    scrollActiveTabIntoView(el, false);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ inline: "nearest", block: "nearest", behavior: "smooth" });
  });

  // Mutant: drop the `prefersReducedMotion ? "auto" : "smooth"` ternary
  // (always "smooth") → this reds.
  it("suppresses the smooth animation — behaviour 'auto' — when prefers-reduced-motion is set", () => {
    FakeTabButton.prototype.scrollIntoView = vi.fn();
    const el = new FakeTabButton();
    scrollActiveTabIntoView(el, true);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ inline: "nearest", block: "nearest", behavior: "auto" });
  });

  it("does nothing (never throws) when the element is null or undefined — the ref before it attaches", () => {
    expect(() => scrollActiveTabIntoView(null, false)).not.toThrow();
    expect(() => scrollActiveTabIntoView(undefined, false)).not.toThrow();
  });
});
