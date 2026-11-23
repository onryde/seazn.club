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
/** The blog column at a 320px screen: the layout's 16px gutters (`app/blog/layout.tsx`, `px-4`) either side. */
const PHONE_COLUMN = 320 - 2 * 16;
/** The house small-text size: Tailwind `text-xs`, 12px (the blog's table headers and hints use it). */
const SMALLEST_TEXT_PX = 12;
/** The texts of a markup fragment, in order, as React printed them: `<text ...>content</text>`. */
const textsOf = (fragment: string) => [...fragment.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs)].map((m) => m[1]!);
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
      expect(html, "the drawing is sized by its viewBox").toMatch(/viewBox="0 0 300 \d+"/);
      expect(html, "no fixed pixel width that would scroll a phone").not.toMatch(/<svg[^>]* width="/);
      // One group per board, numbered as the model numbers them.
      expect(count(html, "data-board=\""), "board groups").toBe(model.pairings.length);
      // Each card says, in order and scoped to ITS OWN group: board number, the float tag when it is one, the first player and the
      // points going in, the second player and theirs, then the result. A score drawn on the wrong card, or not at all, fails here.
      const segments = html.split('data-board="').slice(1);
      expect(segments, "a segment per board").toHaveLength(model.pairings.length);
      for (const [i, p] of model.pairings.entries()) {
        const want = [String(p.board), ...(p.float ? ["float"] : []), esc(p.first), esc(p.firstScore ?? ""), esc(p.second ?? "No opponent"), esc(p.secondScore ?? ""), ...(p.result !== undefined ? [esc(p.result)] : [])];
        const got = textsOf(segments[i]!);
        expect(got.slice(0, want.length), `board ${p.board}: the texts on its card`).toEqual(want);
        if (i < segments.length - 1) expect(got, `board ${p.board}: nothing else on its card`).toEqual(want);
        if (p.float !== true) expect(got.includes("float"), `board ${p.board} is not a float`).toBe(false);
      }
      // The float tag is text, once per float board: never by colour alone.
      const floats = model.pairings.filter((p) => p.float === true).length;
      expect(count(html, ">float</text>"), "float tags").toBe(floats);
      // A strip for each bye and each player the round did not seat.
      expect(count(html, 'data-strip="bye"'), "bye strips").toBe(model.byes.length);
      expect(count(html, 'data-strip="out"'), "left-out strips").toBe((model.notSeated ?? []).length);
      for (const b of model.byes) expect(html).toContain(`Bye: ${esc(b)}`);
      const stripTexts = textsOf(html.slice(html.indexOf('data-strip="')));
      for (const n of model.notSeated ?? []) {
        const at = stripTexts.indexOf(esc(n.name));
        expect(at, `the strip for ${n.name}`).toBeGreaterThanOrEqual(0);
        expect(stripTexts[at + 1], `${n.name}'s strip says why, on its own line`).toBe(esc(n.why));
      }
      // Chess colours: two chips a board, drawn from the model's `firstWhite`.
      const chips = count(html, 'strokeWidth="1.2"') + count(html, 'stroke-width="1.2"');
      expect(chips, "colour chips").toBe(model.pairings.filter((p) => p.firstWhite !== undefined).length * 2);
      // Which side is White: the first chip is the first player's, the second is the opposite colour, board by board.
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

  it("every text of the drawing is the house small-text size or more at a 320px screen, and the float tag is one of them", () => {
    let measured = 0;
    let floatTags = 0;
    let smallest = Infinity;
    for (const id of SWISS_IDS) {
      const html = renderToStaticMarkup(<BlogDiagram model={modelOf(id)} />);
      const box = /viewBox="0 0 (\d+) \d+"/.exec(html);
      expect(box, `${id}: a viewBox`).not.toBeNull();
      const pxPerUnit = PHONE_COLUMN / Number(box![1]);
      // A font size is set on a <text> or on the <g> that holds it (the column headers); a text with neither would inherit
      // the page's size, which this test cannot see, so it is refused.
      for (const tag of html.matchAll(/<text\b([^>]*)>(.*?)<\/text>/gs)) {
        const own = /font-size="([\d.]+)"/.exec(tag[1]!);
        const groupSize = /<g[^>]*font-size="([\d.]+)"[^>]*>(?:(?!<\/g>).)*?<text\b[^>]*>\s*(?:<!-- -->)?/s.exec(html.slice(0, tag.index! + tag[0].length));
        const units = own !== null ? Number(own[1]) : groupSize !== null ? Number(groupSize[1]) : NaN;
        expect(Number.isNaN(units), `${id}: a text with no font size ('${tag[2]}')`).toBe(false);
        const px = units * pxPerUnit;
        expect(px, `${id}: '${tag[2]}' is ${px.toFixed(1)}px at 320`).toBeGreaterThanOrEqual(SMALLEST_TEXT_PX);
        smallest = Math.min(smallest, px);
        measured++;
        if (tag[2] === "float") floatTags++;
      }
    }
    expect(measured, "texts measured (zero would prove nothing)").toBeGreaterThan(40);
    expect(floatTags, "float tags measured").toBeGreaterThan(0);
    expect(smallest, "the smallest text on the phone").toBeGreaterThanOrEqual(SMALLEST_TEXT_PX);
  });

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
