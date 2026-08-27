// Root DailyWord component -- rendered through react-dom/server (no jsdom;
// see _shared/use-game-store.test.tsx's header). This is the real SSR case
// useGameStore's guard exists for (typeof window === "undefined" here,
// exactly like PLAYER_MAP's dynamic(..., { ssr: false }) would still need
// to tolerate if Next ever renders one frame before the client chunk takes
// over). A static-markup smoke test is enough to lock in that mounting
// never crashes and the expected chrome (title, grid, keyboard) is present.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DailyWord from "../index";

describe("DailyWord (root component)", () => {
  it("renders without crashing when window doesn't exist (SSR)", () => {
    expect(typeof window).toBe("undefined");
    expect(() => renderToStaticMarkup(<DailyWord />)).not.toThrow();
  });

  it("renders the title, an empty grid, and the on-screen keyboard", () => {
    const html = renderToStaticMarkup(<DailyWord />);
    expect(html).toContain("Daily Word");
    expect(html).toContain('data-testid="daily-word-grid"');
    expect(html).toContain('data-testid="daily-word-keyboard"');
    // Fresh game, nothing played yet: streak and win% both read zero.
    expect(html).toContain("🔥 0");
  });
});
