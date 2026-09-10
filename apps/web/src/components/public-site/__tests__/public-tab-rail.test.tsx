// Spectator surface W2, Task 7 — `PublicTabRail`'s static-markup contract
// (brief's own Step 4 test, verbatim, plus one rendered-copy check). Same DOM
// contract as W1's `TabRail` (`match-centre/tab-rail.tsx`) but parameterised
// on caller-supplied `{id,label}` pairs instead of the match-centre's fixed
// dictionary lookups — the hub's own tab set is DERIVED per document
// (`deriveHubTabs`), so this rail cannot hard-code a vocabulary.
//
// Assertions anchor on `="` — an omitted prop serialises as `"$undefined"`,
// so a bare attribute-name probe would pass in both states (AGENTS.md).
//
// Two describes, and the split is deliberate. `renderToStaticMarkup` runs no
// effects and exposes no handlers, so everything it can witness is markup;
// the "mounted behaviour" describe below drives the component through
// `renderIsland` instead, which supplies React's own hook dispatcher and so
// runs effects and hands back live props. That still is NOT a browser: there
// is no jsdom here, nothing dispatches a real KeyboardEvent, and refs never
// attach — so what the second describe proves is that the handlers and
// effects DO the right thing when called, never that a key press reaches
// them. Focus order, the scroll itself and the 44px box remain the e2e
// matrix's to measure.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

// `scrollActiveTabIntoView` is SHARED with W1's rail rather than re-derived
// (see the effect's own note in `tab-rail.tsx`), so the way to witness the
// effect calling it — with no jsdom to attach a real ref to — is to replace
// the shared export and watch for the call. `importOriginal` is spread so the
// rest of that module (including `prefersReducedMotion`) stays real.
const scrollSpy = vi.hoisted(() => vi.fn());
vi.mock("../match-centre/tab-rail", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scrollActiveTabIntoView: scrollSpy,
}));

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

    // And `aria-controls` on the ACTIVE tab only. The panel container renders
    // just the active panel, so any other tab's `aria-controls` would name an
    // element that is not in the document — W1 shipped exactly that and its
    // whole-branch review removed it. Asserting only the positive left the
    // rule undefended: emitting `aria-controls` on every tab survived both
    // tests in this file until this line.
    expect(h.match(/aria-controls=/g)?.length).toBe(1);
    expect(h).not.toMatch(/data-testid="mh-tab-overview"[^>]*aria-controls=/);
    expect(h).not.toMatch(/aria-controls=[^>]*data-testid="mh-tab-overview"/);
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

  // The 44px hit target lives on the BUTTON; the pill's look lives on an
  // inner SPAN. This file's own header claimed that split while line 99 did
  // the opposite — `TAB_BUTTON_BASE` and the pill classes were concatenated
  // onto one `<button>`, which stretched the `bg-accent rounded-full`
  // background itself to 44px, so the hub's tabs rendered visibly chunkier
  // than the match centre's and than `tabs.tsx`'s. W1 separated them
  // deliberately (`_DESIGN.md` P2, after `boundingBox()` measured 32px at 320
  // in defect round 15b) because the walkthrough's hit-target check measures
  // the paint box of the element carrying `data-testid` — the button — and
  // never a descendant.
  //
  // `environment: "node"`: this pins the CLASS SPLIT, and cannot measure a
  // box. It is the difference between "the button is 44px tall and the pill
  // still looks 32px" being ARRANGED and being MEASURED; the measurement is
  // the seven-width e2e matrix's job.
  it("the button carries the hit area and an inner span carries the pill — not one element carrying both", () => {
    const h = renderToStaticMarkup(
      <PublicTabRail
        tabs={tabs}
        active="matches"
        onChange={() => {}}
        ariaLabel="Competition sections"
        testidPrefix="mh"
      />,
    );
    const pair = (id: string, selected: boolean) =>
      h.match(
        new RegExp(`data-testid="mh-tab-${id}" aria-selected="${selected}" class="([^"]*)"><span class="([^"]*)"`),
      );

    for (const [id, selected] of [["matches", true], ["overview", false]] as const) {
      const m = pair(id, selected);
      expect(m, `${id}: button > span`).toBeTruthy();
      const [, buttonClass, pillClass] = m!;
      // The hit area is on the button, identical in both states...
      expect(buttonClass!.split(" "), `${id} button`).toContain("min-h-11");
      expect(buttonClass!.split(" "), `${id} button`).toContain("shrink-0");
      // ...and NONE of the pill's visual classes are, which is the half that
      // fails if the two are fused back together.
      expect(buttonClass, `${id} button`).not.toContain("rounded-full");
      expect(buttonClass, `${id} button`).not.toContain("px-4");
      // The pill keeps its look and does NOT carry the 44px floor.
      expect(pillClass!.split(" "), `${id} pill`).toContain("rounded-full");
      expect(pillClass, `${id} pill`).not.toContain("min-h-11");
    }
  });
});

// Behaviour that needs the component actually MOUNTED. `renderToStaticMarkup`
// runs no effects and hands back no handlers, so the two rules below — the
// C6 scroll-into-view and the empty-rail keyboard guard — are invisible to
// every test above. `renderIsland` supplies React's hook dispatcher instead
// (no jsdom in this workspace), which runs effects and lets a handler be
// invoked the way a browser would. `window` is stubbed because the effect
// registers a resize listener and `environment: "node"` has no window at all;
// real React never runs an effect on the server, so this is the harness
// standing in for a browser, not the component needing one.
describe("PublicTabRail — mounted behaviour", () => {
  function stubWindow() {
    const listeners: Record<string, (() => void)[]> = {};
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: () => void) => {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
      },
    });
    return listeners;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    scrollSpy.mockClear();
  });

  // W1's C6 fix, which this rail shipped without. It is `overflow-x-auto`
  // carrying up to SIX tabs (`deriveHubTabs`'s widest output), which
  // overflows 320 — so a tab selected by a `?tab=` deep link (Task 13) or a
  // keyboard Home/End jump past the fold renders CLIPPED at the viewport
  // edge, the exact defect `match-a-tab-commentary-320.png` recorded.
  it("scrolls the ACTIVE tab into view on mount, again on resize, and drops the listener on unmount", () => {
    const listeners = stubWindow();
    const island = renderIsland(PublicTabRail<"overview" | "matches">, {
      tabs,
      active: "matches" as const,
      onChange: () => {},
      ariaLabel: "Competition sections",
      testidPrefix: "mh",
    });

    // Counted through `?? []` rather than asserted on the array itself: an
    // absent key is the exact state a dropped listener produces, and
    // `toHaveLength` on `undefined` fails with "Target cannot be null or
    // undefined" — a message about the assertion instead of about the rail.
    const resizeCount = () => (listeners.resize ?? []).length;

    expect(scrollSpy, "scrolled on mount").toHaveBeenCalledTimes(1);
    expect(resizeCount(), "resize listeners after mount").toBe(1);

    // A click made while the rail is wide enough needs no scroll, and a later
    // resize down to a phone width does not itself change `active` — so an
    // effect keyed on `[active]` alone fires once, at the wrong width.
    listeners.resize![0]!();
    expect(scrollSpy, "scrolled again on resize").toHaveBeenCalledTimes(2);

    island.unmount();
    expect(resizeCount(), "resize listeners after unmount").toBe(0);
  });

  // `PublicTabRail` is an exported GENERIC primitive. A hub document cannot
  // reach an empty rail (`tabs: z.array(…).min(1)`), but Task 12's division
  // rail and every later caller inherit this handler without that constraint:
  // `findIndex` gives -1, ArrowRight computes `(-1 + 1) % 0` = NaN, NaN is
  // `!== null`, and `tabs[NaN]!.id` throws a TypeError that unmounts the tree.
  // Home/End are the same shape via `tabs[0]` / `tabs[-1]`.
  it("an EMPTY rail ignores every navigation key instead of throwing", () => {
    stubWindow();
    const onChange = vi.fn();
    const island = renderIsland(PublicTabRail<string>, {
      tabs: [] as { id: string; label: string }[],
      active: "overview",
      onChange,
      ariaLabel: "Competition sections",
      testidPrefix: "mh",
    });
    const tablist = island
      .tree()
      .find((el) => (propsOf(el) as { role?: string }).role === "tablist");
    expect(tablist, "the role=tablist element").toBeTruthy();
    const onKeyDown = propsOf(tablist!).onKeyDown as (e: unknown) => void;

    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      expect(() => onKeyDown({ key, preventDefault: () => {} }), key).not.toThrow();
    }
    expect(onChange).not.toHaveBeenCalled();
  });
});
