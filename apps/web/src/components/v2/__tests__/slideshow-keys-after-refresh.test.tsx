// The noticeboard's arrow keys after a refresh. The keyboard effect used to
// close over the FIRST render's `setIndex`, and `setIndex` maps an arrow press
// through `slideAt`/`stepFor` over `slides` — so once a poll or a realtime push
// (`router.refresh()`) handed the board new slides, the arrows kept stepping
// through the OLD list. Same length, so the effect's `slides.length` dep never
// noticed. The visible case: a match goes live, its fixtures slide PINS
// (it now shows on every other step), and → from the pinned slide jumped
// BACKWARDS to slide 1 instead of on to the next slide.
//
// `renderIsland(...).rerender()` hands down fresh props the way an RSC refresh
// does while hook state carries over — exactly the shape of the failure; a
// static render, mounted directly at the second state, is correct and blind.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { Slideshow } from "@/components/v2/slideshow";
import { slideshowLabels } from "@/server/slideshow-labels";
import type { Slide } from "@/server/slideshow-data";

// Stable, as Next's router is: the keyboard effect lists `router`, and a fresh
// object per render would re-subscribe it every render and hide the bug.
const router = vi.hoisted(() => ({ push: () => {}, refresh: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const keydown = new Set<(e: { key: string }) => void>();

beforeEach(() => {
  // Only the clock/rotation timers are faked, so nothing advances on its own.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  keydown.clear();
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: { key: string }) => void) => {
      if (type === "keydown") keydown.add(fn);
    },
    removeEventListener: (type: string, fn: (e: { key: string }) => void) => {
      if (type === "keydown") keydown.delete(fn);
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const TITLES = ["Zqx Alpha", "Zqx Bravo", "Zqx Charlie"] as const;
const slide = (title: string, pinned = false): Slide => ({
  kind: "fixtures",
  division: "Open",
  title,
  items: [],
  ...(pinned ? { pinned: true } : {}),
});

function boardProps(slides: Slide[]) {
  return { title: "Board", slides, backHref: "/b", liveHref: "/l", labels: slideshowLabels("en") };
}

function press(key: string) {
  // Non-vacuous: exactly one listener, or a press would reach none (or a
  // stale twin as well as the live one).
  expect(keydown.size).toBe(1);
  // A snapshot: the press re-renders, and a listener the effect re-subscribes
  // mid-iteration would otherwise be visited (and pressed) again.
  for (const fn of [...keydown]) fn({ key });
}

describe("<Slideshow> arrow keys follow the slides the board has NOW", () => {
  it("after a refresh pins a slide, → from the pinned slide moves on to the next slide, not back", () => {
    const board = renderIsland(Slideshow, boardProps(TITLES.map((t) => slide(t))));
    const shown = () => {
      const h2 = board.tree().filter((e) => e.type === "h2");
      expect(h2).toHaveLength(1);
      return textOf(propsOf(h2[0]!).children as never).trim();
    };
    expect(shown()).toBe(TITLES[0]);

    // The refresh: same three slides, the second now pinned (a match went live).
    board.rerender(boardProps(TITLES.map((t, i) => slide(t, i === 1))));
    // A pinned slide shows on every even step, so step 0 is now the pinned one.
    expect(shown()).toBe(TITLES[1]);

    press("ArrowRight");

    // The rulebook for →: the next slide in order.
    expect(shown()).toBe(TITLES[2]);
  });

  it("← from the pinned slide moves back to the slide before it", () => {
    const board = renderIsland(Slideshow, boardProps(TITLES.map((t) => slide(t))));
    const shown = () =>
      textOf(propsOf(board.tree().find((e) => e.type === "h2")!).children as never).trim();

    board.rerender(boardProps(TITLES.map((t, i) => slide(t, i === 1))));
    expect(shown()).toBe(TITLES[1]);

    press("ArrowLeft");

    expect(shown()).toBe(TITLES[0]);
  });

  it("with no refresh the arrows still walk the plain cycle (the second-render case is not the only one)", () => {
    const board = renderIsland(Slideshow, boardProps(TITLES.map((t) => slide(t))));
    const shown = () =>
      textOf(propsOf(board.tree().find((e) => e.type === "h2")!).children as never).trim();

    press("ArrowRight");
    expect(shown()).toBe(TITLES[1]);
    press("ArrowRight");
    expect(shown()).toBe(TITLES[2]);
    press("ArrowRight");
    expect(shown()).toBe(TITLES[0]);
  });
});
