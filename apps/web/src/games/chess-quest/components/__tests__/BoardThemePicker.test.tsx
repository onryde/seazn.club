// Rendered through react-dom/server — see Board.test.tsx's header comment
// for why (no jsdom in this workspace).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressProvider } from "../../lib/progress";
import { BoardThemePicker } from "../BoardThemePicker";

describe("BoardThemePicker", () => {
  it("offers all three themes and defaults to green", () => {
    const html = renderToStaticMarkup(
      <ProgressProvider>
        <BoardThemePicker />
      </ProgressProvider>,
    );
    expect(html).toContain('<option value="green"');
    expect(html).toContain('<option value="brown"');
    expect(html).toContain('<option value="purple"');
    expect(html).toMatch(/<option value="green"[^>]*selected/);
    expect(html).not.toMatch(/<option value="brown"[^>]*selected/);
  });

  it("has an accessible name so it can be found without relying on visual layout", () => {
    const html = renderToStaticMarkup(
      <ProgressProvider>
        <BoardThemePicker />
      </ProgressProvider>,
    );
    expect(html).toContain('aria-label="Board theme"');
  });

  // Selecting a theme and seeing it stick (setBoardTheme → data-theme on an
  // actual board, surviving reload) needs a real DOM + localStorage — this
  // workspace has neither under vitest (node env, no jsdom). That path is
  // covered by e2e/games.spec.ts's board-theme-picker test instead.
});
