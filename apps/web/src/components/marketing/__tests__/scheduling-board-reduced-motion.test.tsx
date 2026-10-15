// SchedulingBoard under prefers-reduced-motion (ESLint L3). Reduced motion used
// to be read in a mount effect that then set the mode to "play"; it is now a
// media-query store and the mode is derived from it. Both halves of the
// preference, after hydration — the server cannot know it, so the static
// render (scheduling-board-i18n.test.tsx) is the replay either way.
import { afterEach, describe, expect, it, vi } from "vitest";

// The harness has no provider tree; the board's copy is not what is under test.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useT: () => (key: string) => key,
}));

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { SchedulingBoard } from "../scheduling-board";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mountWith = (reduce: boolean) => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({
      matches: reduce && q === "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  return renderIsland(SchedulingBoard, {}, undefined, { hydrate: true });
};
const chips = (island: ReturnType<typeof mountWith>) =>
  island.tree().filter((el) => propsOf(el)["data-testid"] === "board-chip");

describe("SchedulingBoard under prefers-reduced-motion", () => {
  it("reduce: skips the replay — the playable tray is there at once", () => {
    expect(chips(mountWith(true))).toHaveLength(3);
  });

  it("no preference: the replay plays, and hands over after it ends", () => {
    const island = mountWith(false);
    expect(chips(island), "still replaying").toHaveLength(0);
    vi.advanceTimersByTime(3400);
    expect(chips(island)).toHaveLength(3);
  });
});
