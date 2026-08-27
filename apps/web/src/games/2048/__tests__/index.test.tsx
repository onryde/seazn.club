// Root Game2048 component -- rendered through react-dom/server (no jsdom;
// see _shared/use-game-store.test.tsx's header). This is the real SSR case
// useGameStore's guard exists for: no window, so useGameStore returns
// INITIAL_STATE verbatim (the empty-board sentinel) without ever running
// migrate or the mount effect that spawns the opening two tiles -- both of
// those need a real client mount. A static-markup smoke test locks in that
// mounting never crashes and the expected chrome (title, board, score) is
// present in that pre-hydration state.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Game2048 from "../index";

describe("Game2048 (root component)", () => {
  it("renders without crashing when window doesn't exist (SSR)", () => {
    expect(typeof window).toBe("undefined");
    expect(() => renderToStaticMarkup(<Game2048 />)).not.toThrow();
  });

  it("renders the title, an empty board, and the starting score/best", () => {
    const html = renderToStaticMarkup(<Game2048 />);
    expect(html).toContain("2048");
    expect(html).toContain('data-testid="2048-board"');
    // Fresh (pre-hydration) SSR state: the empty-board sentinel, 16 zero cells.
    expect((html.match(/data-value="0"/g) ?? []).length).toBe(16);
    expect(html).toContain("Score: 0");
    expect(html).toContain("Best: 0");
  });

  it("shows the default play instructions before any move has happened", () => {
    const html = renderToStaticMarkup(<Game2048 />);
    expect(html).toContain("Arrow keys, WASD, or swipe to move tiles.");
  });

  it("renders a New game control in the footer", () => {
    const html = renderToStaticMarkup(<Game2048 />);
    expect(html).toContain("New game");
  });
});
