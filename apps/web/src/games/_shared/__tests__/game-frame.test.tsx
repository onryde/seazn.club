// GameFrame — the header/status/footer chrome Daily Word and 2048 wrap
// themselves in. Chess Quest keeps its own GameShell (chess-quest/components
// /GameShell.tsx); this is a deliberately simpler, generic sibling — no
// chess-quest CSS custom properties, no Rich HTML status renderer, no chip
// list.
//
// Rendered through react-dom/server (no jsdom in this workspace — see
// use-game-store.test.tsx's header for the same fact). Static markup is
// enough to lock in this component's whole contract: what it renders is a
// pure function of its props, no interactivity of its own.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GameFrame } from "../game-frame";

describe("GameFrame", () => {
  it("renders the title and the children", () => {
    const html = renderToStaticMarkup(
      <GameFrame title="Daily Word">
        <div>board goes here</div>
      </GameFrame>,
    );
    expect(html).toContain("Daily Word");
    expect(html).toContain("board goes here");
  });

  it("renders status when given, and omits the status block entirely when not", () => {
    const withStatus = renderToStaticMarkup(
      <GameFrame title="2048" status="Game over">
        <div>board</div>
      </GameFrame>,
    );
    expect(withStatus).toContain("Game over");

    const withoutStatus = renderToStaticMarkup(
      <GameFrame title="2048">
        <div>board</div>
      </GameFrame>,
    );
    expect(withoutStatus).not.toContain("Game over");
  });

  it("renders score when given", () => {
    const html = renderToStaticMarkup(
      <GameFrame title="2048" score="Best: 4096">
        <div>board</div>
      </GameFrame>,
    );
    expect(html).toContain("Best: 4096");
  });

  it("renders footer when given, and omits it entirely when not", () => {
    const withFooter = renderToStaticMarkup(
      <GameFrame title="2048" footer={<button type="button">New game</button>}>
        <div>board</div>
      </GameFrame>,
    );
    expect(withFooter).toContain("New game");

    const withoutFooter = renderToStaticMarkup(
      <GameFrame title="2048">
        <div>board</div>
      </GameFrame>,
    );
    expect(withoutFooter).not.toContain("New game");
  });
});
