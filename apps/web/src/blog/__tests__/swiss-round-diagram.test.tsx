// The Swiss round grid is a pure drawing of a `swissRound` model. Rendered here from the committed examples' own models (the
// producer's output, not a typed-in fixture), so a drawing that skips a board, a float tag, a bye or the left-out player fails.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogDiagram } from "@/components/blog/blog-diagram";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { DiagramModel } from "@/blog/examples/types";

type SwissRound = Extract<DiagramModel, { kind: "swissRound" }>;

const SWISS_IDS = ["swiss-pairing", "swiss-bye-rounds", "swiss-late-and-withdraw"] as const;
const modelOf = (id: string): SwissRound => {
  const d = BLOG_GOLDENS[id]?.diagram;
  if (d === undefined || d.kind !== "swissRound") throw new Error(`${id} has no Swiss round diagram`);
  return d;
};
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** The text inside a tag, markup-escaped as React prints it. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("the Swiss round diagram draws every part of the example's own model", () => {
  const totals = { boards: 0, floats: 0, byes: 0, out: 0, chips: 0 };

  for (const id of SWISS_IDS) {
    it(`${id}: a figure with an accessible name, one card per board, and a caption that says the key fact`, () => {
      const model = modelOf(id);
      const html = renderToStaticMarkup(<BlogDiagram model={model} />);
      expect(html).toContain('role="img"');
      expect(html).toContain('data-testid="blog-diagram"');
      expect(html).toContain(`<title id="swiss-round-${model.round}-title">${esc(model.title)}</title>`);
      expect(html).toContain(`<figcaption`);
      expect(html).toContain(`${esc(model.title)}</figcaption>`);
      expect(html, "the drawing is sized by its viewBox").toMatch(/viewBox="0 0 360 \d+"/);
      expect(html, "no fixed pixel width that would scroll a phone").not.toMatch(/<svg[^>]* width="/);
      // One group per board, numbered as the model numbers them.
      expect(count(html, "data-board=\""), "board groups").toBe(model.pairings.length);
      for (const p of model.pairings) {
        expect(html, `board ${p.board}`).toContain(`data-board="${p.board}"`);
        expect(html).toContain(esc(p.first));
        if (p.second !== null) expect(html).toContain(esc(p.second));
        if (p.result !== undefined) expect(html).toContain(esc(p.result));
      }
      // The float tag is text, once per float board: never by colour alone.
      const floats = model.pairings.filter((p) => p.float === true).length;
      expect(count(html, ">float</text>"), "float tags").toBe(floats);
      // A strip for each bye and each player the round did not seat.
      expect(count(html, 'data-strip="bye"'), "bye strips").toBe(model.byes.length);
      expect(count(html, 'data-strip="out"'), "left-out strips").toBe((model.notSeated ?? []).length);
      for (const b of model.byes) expect(html).toContain(`Bye: ${esc(b)}`);
      for (const n of model.notSeated ?? []) expect(html).toContain(`${esc(n.name)}: ${esc(n.why)}`);
      // Chess colours: two chips a board, drawn from the model's `firstWhite`.
      const chips = count(html, 'strokeWidth="1.2"') + count(html, 'stroke-width="1.2"');
      expect(chips, "colour chips").toBe(model.pairings.filter((p) => p.firstWhite !== undefined).length * 2);
      // Which side is White: the first chip is the first player's, the second is the opposite colour, board by board.
      const segments = html.split('data-board="').slice(1);
      for (const [i, p] of model.pairings.entries()) {
        if (p.firstWhite === undefined) continue;
        const colours = [...segments[i]!.matchAll(/class="(fill-white stroke-slate-500|fill-slate-800 stroke-slate-800)"/g)].map((m) => m[1] === "fill-white stroke-slate-500");
        expect(colours, `board ${p.board}: first player's chip, then the second's`).toEqual([p.firstWhite, !p.firstWhite]);
      }
      totals.boards += model.pairings.length;
      totals.floats += floats;
      totals.byes += model.byes.length;
      totals.out += (model.notSeated ?? []).length;
      totals.chips += chips;
    });
  }

  it("the three examples between them drew boards, a float, a bye, a left-out player and colours (zero would prove nothing)", () => {
    expect(totals.boards, "boards").toBeGreaterThan(0);
    expect(totals.floats, "float boards").toBeGreaterThan(0);
    expect(totals.byes, "byes").toBeGreaterThan(0);
    expect(totals.out, "left-out players").toBeGreaterThan(0);
    expect(totals.chips, "colour chips").toBeGreaterThan(0);
  });

  it("a model with no colours draws no chips, and a board with no opponent says so", () => {
    const model: SwissRound = { kind: "swissRound", round: 1, title: "A round with no colours", pairings: [{ board: 1, first: "Ana", second: null, float: false }], byes: [] };
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    expect(html).not.toContain("stroke-width=\"1.2\"");
    expect(html).toContain("No opponent");
    expect(html).not.toContain(">float</text>");
  });

  it("text that is not markup is escaped, not drawn as a tag", () => {
    const model: SwissRound = { kind: "swissRound", round: 1, title: "A <b>round</b> & more", pairings: [{ board: 1, first: "<i>Ana</i>", second: "B & C", float: false }], byes: ["<u>D</u>"] };
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    expect(html).not.toContain("<b>round</b>");
    expect(html).not.toContain("<i>Ana</i>");
    expect(html).not.toContain("<u>D</u>");
    expect(html).toContain("&lt;i&gt;Ana&lt;/i&gt;");
  });
});
