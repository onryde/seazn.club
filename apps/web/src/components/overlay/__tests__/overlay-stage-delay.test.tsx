// Task 5d — the consumer half of the delay-compensation seam.
// page.tsx's own `__tests__/page.test.ts` proves `?delay=` resolves into
// `<OverlayStage delayMs=.../>`'s prop; this proves that SAME prop reaches
// `presentationNowOffsetMs` (via the real `useLiveFixture`) and then the
// CLOCK TEXT a viewer on air actually sees (via the real `useOverlayClock`
// and `OverlayBug`) — the full producer→consumer chain, never a hook called
// with a hand-written prop (both hooks already have their own isolated
// suites: `use-live-fixture.test.ts`'s delayMs describe block,
// `use-overlay-clock.test.ts`).
//
// `environment: "node"`, no jsdom. `OverlayStage` calls `useLayoutEffect`
// directly (the canvas-scale effect) — `renderIsland`'s dispatcher
// (`_hook-harness.tsx`) has no slot for that hook, only `useEffect`, so it
// cannot drive this component. `renderToStaticMarkup` is the repo's other
// precedent for a real, non-mocked render of a hook-using client component
// under `environment: "node"` (the sibling public fixture page's own
// page.test.ts renders `<MatchCentre>` this way). `useLayoutEffect`/
// `useEffect` are no-ops under SSR, which is fine here: the clock's INITIAL
// text is computed synchronously inside a `useState` initializer
// (`useOverlayClock`'s `compute()`), not inside an effect.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OverlayStage, type OverlayStageProps } from "../overlay-stage";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

const FIXED_NOW = 1_700_000_000_000;
// The clock's anchor is 60s of wall time before FIXED_NOW — an in-play
// fixture with 60s elapsed, undelayed.
const ANCHOR_MS = FIXED_NOW - 60_000;

afterEach(() => {
  vi.useRealTimers();
});

function baseProps(delayMs: number | undefined): OverlayStageProps {
  const initial: OverlayLiveData = {
    status: "in_play",
    summary: null,
    outcome: null,
    lastSeq: 1,
    venueTz: "UTC",
    clock: { phase: "H1", anchorSeconds: 0, anchorAtWallMs: ANCHOR_MS },
  };
  return {
    fixtureId: "f1",
    initial,
    realtime: false,
    sportKey: "football",
    style: "bug",
    sides: [
      { id: "home", name: "Home XI" },
      { id: "away", name: "Away XI" },
    ],
    startLabel: null,
    dict: {},
    decidedTemplates: decidedOutcomeTemplates((k) => k),
    delayMs,
  };
}

/** `OverlayBug`'s clock cell: `<span class="ovl-bug-clock ovl-display">`.
 *  Fix round 5, I3 — was `.ovl-bug-brand`, which the clock BORROWED (24/600
 *  plus the wordmark's .08em tracking) against §4's own "clock Barlow 33/700
 *  LED". The clock has its own token now, and this selector must follow it:
 *  matching the brand's class again would find the wordmark cell, not a clock. */
function clockTextOf(html: string): string {
  const match = html.match(/ovl-bug-clock ovl-display"[^>]*>([^<]*)</);
  if (!match) throw new Error(`no .ovl-bug-clock cell found in:\n${html}`);
  return match[1]!;
}

describe("OverlayStage — delayMs reaches the rendered clock end to end (Task 5d, closing R2's seam)", () => {
  it("delayMs absent (undefined): the clock reads the full 60s elapsed, no offset subtracted", () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const html = renderToStaticMarkup(<OverlayStage {...baseProps(undefined)} />);
    expect(clockTextOf(html)).toBe("01:00");
  });

  it("delayMs=5000 on the SAME fixture: the clock reads 5s further back — 00:55, not 01:00", () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const html = renderToStaticMarkup(<OverlayStage {...baseProps(5000)} />);
    expect(clockTextOf(html)).toBe("00:55");
  });

  it("delayMs=0 explicitly behaves exactly like delayMs absent (the pre-Task-5d default)", () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const html = renderToStaticMarkup(<OverlayStage {...baseProps(0)} />);
    expect(clockTextOf(html)).toBe("01:00");
  });
});
