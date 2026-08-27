// Grid -- rendered through react-dom/server (no jsdom in this workspace;
// see _shared/use-game-store.test.tsx's header for the same fact across
// the games toolkit). Static markup locks in the DOM shape the e2e
// acceptance criteria depend on: "type a guess, see five coloured tiles."
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Grid } from "../Grid";

describe("Grid", () => {
  it("renders 6 rows of 5 tiles each, even with no guesses yet", () => {
    const html = renderToStaticMarkup(<Grid guesses={[]} current="" answer="MOTOR" />);
    expect((html.match(/data-tile/g) ?? []).length).toBe(30);
    expect((html.match(/data-row="/g) ?? []).length).toBe(6);
  });

  it("colors a submitted guess's tiles via data-result, one hit/near/miss per letter", () => {
    const html = renderToStaticMarkup(<Grid guesses={["ROBOT"]} current="" answer="MOTOR" />);
    // ROBOT vs MOTOR -> near, hit, miss, hit, near (see engine.test.ts)
    expect(html).toContain('data-result="near"');
    expect(html).toContain('data-result="hit"');
    expect(html).toContain('data-result="miss"');
    // exactly 5 colored tiles from the one submitted row, the rest are "empty"
    expect((html.match(/data-result="(hit|near|miss)"/g) ?? []).length).toBe(5);
    expect((html.match(/data-result="empty"/g) ?? []).length).toBe(25);
  });

  it("shows the in-progress row's letters uncolored", () => {
    const html = renderToStaticMarkup(<Grid guesses={[]} current="ROB" answer="MOTOR" />);
    expect(html).toContain(">R<");
    expect(html).toContain(">O<");
    expect(html).toContain(">B<");
    expect((html.match(/data-result="(hit|near|miss)"/g) ?? []).length).toBe(0);
  });
});
