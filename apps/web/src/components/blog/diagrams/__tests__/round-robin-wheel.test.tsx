// The round-robin wheel is a pure drawing of a `roundRobinWheel` model. Rendered here from the committed example's own model (the
// producer's output, not a typed-in fixture), so a drawing that skips a place, puts a team in the wrong column or draws too small fails.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogDiagram } from "@/components/blog/blog-diagram";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { DiagramModel } from "@/blog/examples/types";

type Wheel = Extract<DiagramModel, { kind: "roundRobinWheel" }>;

const modelOf = (): Wheel => {
  const d = BLOG_GOLDENS["round-robin-schedule"]?.diagram;
  if (d === undefined || d.kind !== "roundRobinWheel") throw new Error("round-robin-schedule has no wheel diagram");
  return d;
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const textsOf = (fragment: string) => [...fragment.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs)].map((m) => m[1]!);
const PHONE_COLUMN = 320 - 2 * 16;
const SMALLEST_TEXT_PX = 12;

describe("the round-robin wheel draws every place of the example's own model", () => {
  it("a figure with an accessible name, the caption in words, a viewBox and no fixed width", () => {
    const model = modelOf();
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('data-testid="blog-diagram"');
    expect(html).toContain(`<title id="blog-diagram-round-robin-wheel-title">${esc(model.title)}</title>`);
    expect(html).toContain(`${esc(model.title)}</figcaption>`);
    expect(html).toMatch(/viewBox="0 0 300 \d+"/);
    expect(html, "no fixed pixel width that would scroll a phone").not.toMatch(/<svg[^>]* width="/);
  });

  it("the top row is the fixed place then the first of the loop, the bottom row the rest of the loop from its far end; a column pairs the two", () => {
    const model = modelOf();
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    const m = model.rotating.length;
    const cols = (m + 1) / 2;
    const groups = html.split('data-slot="').slice(1);
    expect(groups, "a group for each place of the picture").toHaveLength(m + 1);
    const texts = groups.map((g) => textsOf(g)[0]);
    const top = [model.fixed, ...model.rotating.slice(0, cols - 1)].map(esc);
    const bottom = Array.from({ length: cols }, (_, i) => esc(model.rotating[m - 1 - i]!));
    expect(texts.slice(0, cols), "top row, left to right").toEqual(top);
    expect(texts.slice(cols), "bottom row, left to right").toEqual(bottom);
    expect(html.split('data-slot="fixed"').length - 1, "one fixed place").toBe(1);
    expect(html.split('data-match="').length - 1, "one match line a column").toBe(cols);
    expect(html, "the loop's arrow").toContain('data-loop=""');
    // The columns pair what the circle method pairs: rotating[j] against rotating[m-2-j], the last of the loop against the fixed place.
    const pairs = top.map((t, i) => [t, bottom[i]!]);
    expect(pairs[0], "the fixed place meets the last of the loop").toEqual([esc(model.fixed), esc(model.rotating[m - 1]!)]);
    for (let j = 0; j <= (m - 3) / 2; j++) expect(pairs[j + 1], `column ${j + 1}`).toEqual([esc(model.rotating[j]!), esc(model.rotating[m - 2 - j]!)]);
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
    expect(measured, "texts measured (zero would prove nothing)").toBe(modelOf().rotating.length + 1);
  });

  it("a loop with an even number of places, or fewer than three, is refused, and text that is not markup is escaped", () => {
    const base: Wheel = { kind: "roundRobinWheel", title: "t", fixed: "F", rotating: ["a", "b", "c", "d"], round: 1 };
    expect(() => renderToStaticMarkup(<BlogDiagram model={base} />)).toThrow(/odd number/);
    expect(() => renderToStaticMarkup(<BlogDiagram model={{ ...base, rotating: ["a"] }} />)).toThrow(/odd number/);
    const html = renderToStaticMarkup(<BlogDiagram model={{ ...base, title: "A <b>wheel</b>", fixed: "<i>F</i>", rotating: ["a", "b", "c"] }} />);
    expect(html).not.toContain("<b>wheel</b>");
    expect(html).not.toContain("<i>F</i>");
    expect(html).toContain("&lt;i&gt;F&lt;/i&gt;");
  });
});
