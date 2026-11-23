// The best-placed picture is a pure drawing of a `bestPlaced` model. Rendered here from the committed example's own model (the producer's
// output, not a typed-in fixture), so a drawing that skips a card, marks the wrong ones as through or draws too small fails.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogDiagram } from "@/components/blog/blog-diagram";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { DiagramModel } from "@/blog/examples/types";

type Best = Extract<DiagramModel, { kind: "bestPlaced" }>;

const modelOf = (): Best => {
  const d = BLOG_GOLDENS["best-third-placed-teams"]?.diagram;
  if (d === undefined || d.kind !== "bestPlaced") throw new Error("best-third-placed-teams has no best-placed diagram");
  return d;
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const textsOf = (fragment: string) => [...fragment.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs)].map((m) => m[1]!);
const PHONE_COLUMN = 320 - 2 * 16;
const SMALLEST_TEXT_PX = 12;

describe("the best-placed picture draws every card of the example's own model", () => {
  it("a figure with an accessible name, the caption in words, a viewBox and no fixed width", () => {
    const model = modelOf();
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('data-testid="blog-diagram"');
    expect(html).toContain(`<title id="blog-diagram-best-placed-title">${esc(model.title)}</title>`);
    expect(html).toContain(`${esc(model.title)}</figcaption>`);
    expect(html).toMatch(/viewBox="0 0 300 \d+"/);
    expect(html, "no fixed pixel width that would scroll a phone").not.toMatch(/<svg[^>]* width="/);
  });

  it("each card says its team, whether it is through, its group, what was counted and what was left out, and exactly the first `take` are through", () => {
    const model = modelOf();
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    const cards = html.split('data-card="').slice(1);
    expect(cards, "a card per candidate").toHaveLength(model.candidates.length);
    let through = 0;
    for (const [i, c] of model.candidates.entries()) {
      const isThrough = i < model.take;
      expect(cards[i]!, `card ${i + 1} marked as through or not`).toContain(`data-through="${isThrough ? "yes" : "no"}"`);
      expect(textsOf(cards[i]!), `card ${i + 1}`).toEqual([c.team, isThrough ? "Through" : "Out", c.group, c.counted, c.leftOut].map(esc));
      if (isThrough) through++;
    }
    expect(through, "cards marked through").toBe(model.take);
    expect(through, "and some are out").toBeLessThan(model.candidates.length);
  });

  it("every text is the house small-text size or more at a 320px screen", () => {
    const html = renderToStaticMarkup(<BlogDiagram model={modelOf()} />);
    const box = /viewBox="0 0 (\d+) \d+"/.exec(html);
    expect(box, "a viewBox").not.toBeNull();
    const pxPerUnit = PHONE_COLUMN / Number(box![1]);
    let measured = 0;
    for (const tag of html.matchAll(/<text\b([^>]*)>(.*?)<\/text>/gs)) {
      const size = /font-size="([\d.]+)"/.exec(tag[1]!);
      expect(size, `a text with no font size ('${tag[2]}')`).not.toBeNull();
      expect(Number(size![1]) * pxPerUnit, `'${tag[2]}'`).toBeGreaterThanOrEqual(SMALLEST_TEXT_PX);
      measured++;
    }
    expect(measured, "texts measured (zero would prove nothing)").toBe(modelOf().candidates.length * 5);
  });

  it("the longest line fits its card at 13 units a letter, so a line never runs off the card", () => {
    const model = modelOf();
    const longest = Math.max(...model.candidates.flatMap((c) => [c.team, c.group, c.counted, c.leftOut].map((s) => s.length)));
    // 13 units of font is about 0.56 of it a letter in the house sans for text with digits (the browser pass measures the real width); a line
    // starts 10 in and needs 10 to spare.
    expect(longest * 13 * 0.56 + 10 + 10, `the longest line (${longest} letters)`).toBeLessThanOrEqual(300 - 8);
  });

  it("a cut that is no cut is refused, and text that is not markup is escaped", () => {
    const base = modelOf();
    expect(() => renderToStaticMarkup(<BlogDiagram model={{ ...base, take: 0 }} />)).toThrow(/no cut/);
    expect(() => renderToStaticMarkup(<BlogDiagram model={{ ...base, take: base.candidates.length }} />)).toThrow(/no cut/);
    const html = renderToStaticMarkup(<BlogDiagram model={{ ...base, title: "A <b>cut</b>", candidates: base.candidates.map((c, i) => (i === 0 ? { ...c, team: "<i>X</i>" } : c)) }} />);
    expect(html).not.toContain("<b>cut</b>");
    expect(html).not.toContain("<i>X</i>");
    expect(html).toContain("&lt;i&gt;X&lt;/i&gt;");
  });
});
