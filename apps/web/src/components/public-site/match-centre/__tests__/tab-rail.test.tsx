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
import fr from "@/dictionaries/fr/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";
import { TabRail, scrollActiveTabIntoView } from "../tab-rail";

const dict = en as Dict;
const frDict = fr as Dict;

it("TabRail renders one role=tab per tab with aria-selected on the active one, inside a labelled rail with a single tab stop", () => {
  const html = renderToStaticMarkup(
    <TabRail tabs={["summary", "scorecard", "commentary", "info"]} active="scorecard" onChange={() => {}} dict={dict} />,
  );
  expect(html).toContain('role="tablist"');
  // The tab stop now lives on the SELECTED BUTTON, not on the rail — see the
  // roving-tabindex describe below, which pins which element has it.
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

it("each tab button carries id=mc-tab-<id>, and the ACTIVE one carries aria-controls=mc-tab-panel-<id> — the pairing MatchCentre's tabpanel wrapper relies on", () => {
  const html = renderToStaticMarkup(
    <TabRail tabs={["summary", "scorecard"]} active="summary" onChange={() => {}} dict={dict} />,
  );
  // `id` is on EVERY tab: it is what the rendered panel's `aria-labelledby`
  // points BACK at, and that direction always resolves.
  expect(html).toContain('id="mc-tab-summary"');
  expect(html).toContain('id="mc-tab-scorecard"');
  // `aria-controls` is on the ACTIVE tab only — see the component's own note.
  // `MatchCentre` renders one panel, so the inactive tab's reference would
  // name an element that is not in the document.
  expect(html).toContain('aria-controls="mc-tab-panel-summary"');
  expect(html).not.toContain('aria-controls="mc-tab-panel-scorecard"');
  // The positive pair for that negative: make SCORECARD active and the
  // reference moves with it, rather than simply never being emitted.
  const other = renderToStaticMarkup(
    <TabRail tabs={["summary", "scorecard"]} active="scorecard" onChange={() => {}} dict={dict} />,
  );
  expect(other).toContain('aria-controls="mc-tab-panel-scorecard"');
  expect(other).not.toContain('aria-controls="mc-tab-panel-summary"');
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

// R11 fix round, C8 — `tab-rail.tsx:99` used to label every tab by its ID
// (`matchCentre.tab.${tab}`), so the "sets" tab always read "Sets" — wrong
// for a football fixture, whose OWN Sets-tab panel is headed "Goals by
// period" (`buildSets`'s `kind: "periods"`) and for badminton/table tennis,
// which score GAMES inside a "sets"-shaped table (`GAME_UNIT_SPORTS`,
// `lib/public-site.ts`). The label now comes from `setsUnit` — "set" |
// "game" | "period" — NEVER `kind` (`timeline.test.ts:615`'s own note: a
// game-unit sport's `kind` is still "sets", so `kind` cannot double as the
// label). Three cases, one per unit, so a single-branch fix cannot pass.
describe("TabRail — the 'sets' tab label reads the sport's OWN unit, not a fixed word (R11 fix round, C8)", () => {
  it("unit 'set' (tennis, volleyball, …) reads 'Sets'", () => {
    const html = renderToStaticMarkup(
      <TabRail tabs={["summary", "sets"]} active="sets" onChange={() => {}} dict={dict} setsUnit="set" />,
    );
    expect(html).toContain(">Sets<");
  });

  it("unit 'period' (football, hockey, …) reads 'Periods' — NOT 'Sets'", () => {
    const html = renderToStaticMarkup(
      <TabRail tabs={["summary", "sets"]} active="sets" onChange={() => {}} dict={dict} setsUnit="period" />,
    );
    expect(html).toContain(">Periods<");
    expect(html).not.toContain(">Sets<");
  });

  it("unit 'game' (badminton, table tennis — kind is still 'sets') reads 'Games' — NOT 'Sets'", () => {
    const html = renderToStaticMarkup(
      <TabRail tabs={["summary", "sets"]} active="sets" onChange={() => {}} dict={dict} setsUnit="game" />,
    );
    expect(html).toContain(">Games<");
    expect(html).not.toContain(">Sets<");
  });

  it("no setsUnit (a document built before the field existed) falls back to today's fixed 'Sets' label — the load-bearing fallback", () => {
    const html = renderToStaticMarkup(
      <TabRail tabs={["summary", "sets"]} active="sets" onChange={() => {}} dict={dict} />,
    );
    expect(html).toContain(">Sets<");
  });

  it("every OTHER tab's label is unaffected by setsUnit", () => {
    const html = renderToStaticMarkup(
      <TabRail tabs={["summary", "timeline", "sets", "info"]} active="summary" onChange={() => {}} dict={dict} setsUnit="period" />,
    );
    expect(html).toContain(">Summary<");
    expect(html).toContain(">Timeline<");
    expect(html).toContain(">Info<");
  });

  it("the accessible name (visible text content) localises through the FRENCH dict, not just English", () => {
    const html = renderToStaticMarkup(
      <TabRail tabs={["summary", "sets"]} active="sets" onChange={() => {}} dict={frDict} setsUnit="period" />,
    );
    expect(html).toContain(`>${frDict["matchCentre.periods"] as string}<`);
    expect(html).not.toContain(">Periods<");
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

// ---------------------------------------------------------------------------
// Accessibility (whole-branch review) — ROVING TABINDEX, AND NO DANGLING
// `aria-controls`.
// ---------------------------------------------------------------------------
//
// Two separate defects with one cause: every tab was in the browser's own Tab
// order, and every tab pointed at a panel id.
//
//  * A six-tab rail cost SEVEN tab stops (the `tablist` itself carried
//    `tabIndex={0}`, plus one per button) before a keyboard user reached the
//    content. The APG tabs pattern puts exactly ONE tab stop on the rail — the
//    selected tab — and moves between tabs with the arrow keys, which this
//    rail already implements. The container stops being focusable; its
//    `onKeyDown` still fires, because the event bubbles from the focused
//    button.
//
//  * `aria-controls` referenced `mc-tab-panel-<id>` for all six tabs, but
//    `MatchCentre` renders ONLY the active panel — so five of the six pointed
//    at an element that is not in the document.
//
// NEITHER IS DIRECTLY TESTABLE HERE: this workspace has no jsdom, so nothing
// can press Tab or read a focus ring. What static markup CAN pin is the
// attribute state the browser derives that behaviour from, which is what these
// assert.
//
// MUTANTS KILLED (applied by hand, restored from a `cp` backup of the FIXED
// state; `numTotalTests` stayed 534 under all three, so none is the
// collection-break shape that reads as a survivor). The two tabindex mutants
// are deliberately SEPARATE — the rail had two sources of tab stops, and one
// mutant covering for the other would leave each of them untested:
//
//  (M9a) `tabIndex={isActive ? 0 : -1}` → `tabIndex={0}` on every button.
//        → RED: "exactly one element in the rail is in the tab order…",
//          "the tab stop MOVES with the selection".
//  (M9b) `tabIndex={0}` restored on the TABLIST container.
//        → RED: "exactly one element in the rail is in the tab order…",
//          "the tablist container is NOT itself focusable".
//  (M10) `aria-controls` unconditional again.
//        → RED: "only the selected tab carries aria-controls…", and "each tab
//          button carries id=mc-tab-<id>, and the ACTIVE one carries
//          aria-controls…".
describe("TabRail — roving tabindex (one tab stop, not one per tab)", () => {
  const SIX: MatchCentreTabIdT[] = ["summary", "scorecard", "commentary", "timeline", "sets", "info"];

  const render = (active: MatchCentreTabIdT): string =>
    renderToStaticMarkup(<TabRail tabs={SIX} active={active} onChange={() => {}} dict={dict} />);

  /** One tab's whole opening `<button …>` tag — asserted on as a unit rather
   *  than as an attribute-ORDER regex, which is not the contract (and which
   *  is what makes an unrelated attribute insertion red a test). */
  const buttonTag = (html: string, tab: MatchCentreTabIdT): string => {
    const match = html.match(new RegExp(`<button[^>]*data-testid="mc-tab-${tab}"[^>]*>`));
    expect(match, tab).not.toBeNull();
    return match![0];
  };

  it("exactly one element in the rail is in the tab order, and it is the SELECTED tab", () => {
    const html = render("commentary");
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect((html.match(/tabindex="-1"/g) ?? []).length).toBe(SIX.length - 1);
    // …and it is the selected one, not merely the first.
    const active = buttonTag(html, "commentary");
    expect(active).toContain('aria-selected="true"');
    expect(active).toContain('tabindex="0"');
  });

  it("the tab stop MOVES with the selection", () => {
    // The positive pair for the assertion above: a rail whose `tabindex="0"`
    // were hardcoded to `tabs[0]` passes the first test and fails this one.
    const html = render("info");
    expect(buttonTag(html, "info")).toContain('tabindex="0"');
    expect(buttonTag(html, "summary")).toContain('tabindex="-1"');
    expect(buttonTag(html, "summary")).toContain('aria-selected="false"');
  });

  it("the tablist container is NOT itself focusable", () => {
    const html = render("summary");
    const tablistTag = html.match(/<div[^>]*role="tablist"[^>]*>/)?.[0];
    expect(tablistTag).toBeTruthy();
    expect(tablistTag).not.toContain("tabindex");
    // The positive pair: it keeps the role and the accessible name that make
    // it a tablist at all — this removes a tab stop, not the landmark.
    expect(tablistTag).toContain('role="tablist"');
    expect(tablistTag).toContain('aria-label="');
  });
});

describe("TabRail — aria-controls names only a panel that EXISTS", () => {
  const SIX: MatchCentreTabIdT[] = ["summary", "scorecard", "commentary", "timeline", "sets", "info"];

  it("only the selected tab carries aria-controls — the other five would dangle", () => {
    const html = renderToStaticMarkup(
      <TabRail tabs={SIX} active="scorecard" onChange={() => {}} dict={dict} />,
    );
    // `MatchCentre` renders ONE panel: `mc-tab-panel-scorecard` and no other.
    expect((html.match(/aria-controls="/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-controls="mc-tab-panel-scorecard"');
    // The negative half, spelled out for the five that are not in the DOM.
    for (const tab of SIX.filter((t) => t !== "scorecard")) {
      expect(html, tab).not.toContain(`aria-controls="mc-tab-panel-${tab}"`);
    }
    // …and every tab still carries its OWN id, which is what the panel's
    // `aria-labelledby` points BACK at — that direction always resolves.
    for (const tab of SIX) expect(html, tab).toContain(`id="mc-tab-${tab}"`);
  });
});
