// #364 follow-up — the viewport gate that holds the demo's replay until the
// block is on screen.
//
// Driven through `_hook-harness` (node env, no DOM) with a fabricated element
// and a stubbed `IntersectionObserver`, so the two states that matter are both
// real: BEFORE any intersection the gate is shut, and the callback opens it.
// A test that only rendered the island would prove neither — with no DOM the
// island's ref never fills in, and the hook's fail-open branch answers first.
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { useStartOnView } from "../use-start-on-view";

/** Stands in for the section's DOM node. The stub never touches it — it only
 *  has to be the same object the hook hands to `observe`. */
const NODE = { nodeName: "SECTION" } as unknown as Element;

type Entry = { isIntersecting: boolean };
type Cb = (entries: Entry[]) => void;

/** The observers the component under test constructed, in order. */
let made: {
  cb: Cb;
  options: IntersectionObserverInit | undefined;
  observed: Element[];
  disconnects: number;
}[] = [];

function stubObserver(): void {
  made = [];
  class FakeIO {
    private readonly rec: (typeof made)[number];
    constructor(cb: Cb, options?: IntersectionObserverInit) {
      this.rec = { cb, options, observed: [], disconnects: 0 };
      made.push(this.rec);
    }
    observe(el: Element): void {
      this.rec.observed.push(el);
    }
    disconnect(): void {
      this.rec.disconnects += 1;
    }
    unobserve(): void {}
    takeRecords(): [] {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeIO);
}

/** A one-hook component: renders the gate's answer as text the harness reads.
 *  The ref box is filled during render, which is when React attaches a real
 *  `ref=` too — so the effect below sees a node exactly as it would in a
 *  browser. */
function Probe(): string {
  const ref = { current: NODE };
  return useStartOnView(ref) ? "started" : "waiting";
}

const mount = () => renderIsland(Probe, {} as Record<string, never>, (node) => [node as never]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useStartOnView", () => {
  it("holds the replay shut until the block is seen", () => {
    stubObserver();
    const probe = mount();
    expect(textOf(probe.tree() as never), "started before any intersection").toBe("waiting");
    expect(made).toHaveLength(1);
    expect(made[0]!.observed, "did not observe the element it was given").toEqual([NODE]);
  });

  it("opens on the first intersection and stops observing", () => {
    stubObserver();
    const probe = mount();
    made[0]!.cb([{ isIntersecting: true }]);
    expect(textOf(probe.tree() as never)).toBe("started");
    expect(made[0]!.disconnects, "observer left alive after it fired").toBeGreaterThan(0);
  });

  it("stays shut for a callback that reports nothing visible", () => {
    stubObserver();
    const probe = mount();
    made[0]!.cb([{ isIntersecting: false }]);
    expect(textOf(probe.tree() as never)).toBe("waiting");
  });

  it("latches — a later non-intersecting callback cannot rewind it", () => {
    stubObserver();
    const probe = mount();
    made[0]!.cb([{ isIntersecting: true }]);
    made[0]!.cb([{ isIntersecting: false }]);
    expect(textOf(probe.tree() as never)).toBe("started");
  });

  // A fractional threshold is a fraction of the OBSERVED element, so on an
  // element taller than `1 / threshold` viewports it can never be met. The demo
  // screen stacks to about nine viewports at 375px, where a 0.15 threshold left
  // the gate shut for ever — the mobile e2e hung on "waiting for the engine".
  // Whatever this hook asks for has to be height-independent.
  it("asks for no fractional threshold — it would be unreachable on a tall block", () => {
    stubObserver();
    mount();
    const threshold = made[0]!.options?.threshold;
    const asked = threshold === undefined ? [0] : [threshold].flat();
    expect(Math.max(...asked), "a fractional threshold cannot be met by a tall element").toBe(0);
  });

  // The branch every OTHER suite in this directory depends on: with no
  // `IntersectionObserver` the gate must be open on the first render, or the
  // node-env island tests would all hang on a trace that never advances.
  it("fails open where IntersectionObserver does not exist", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const probe = mount();
    expect(textOf(probe.tree() as never)).toBe("started");
  });
});
