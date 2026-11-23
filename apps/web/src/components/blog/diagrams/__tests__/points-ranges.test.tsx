// The points-ranges picture is a pure drawing of a `pointsRanges` model. Rendered here from the committed example's own model (the
// producer's output, not a typed-in fixture), so a drawing that skips a team, moves a bar, or draws too small fails.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogDiagram } from "@/components/blog/blog-diagram";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { DiagramModel } from "@/blog/examples/types";

type Ranges = Extract<DiagramModel, { kind: "pointsRanges" }>;

const modelOf = (): Ranges => {
  const d = BLOG_GOLDENS["clinched-or-eliminated"]?.diagram;
  if (d === undefined || d.kind !== "pointsRanges") throw new Error("clinched-or-eliminated has no points-ranges diagram");
  return d;
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const textsOf = (fragment: string) => [...fragment.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs)].map((m) => m[1]!);
const numberAttr = (tag: string, name: string) => Number(new RegExp(`\\b${name}="([\\d.]+)"`).exec(tag)![1]);
const PHONE_COLUMN = 320 - 2 * 16;
const SMALLEST_TEXT_PX = 12;

describe("the points-ranges picture draws every team of the example's own model", () => {
  it("a figure with an accessible name, the caption in words, a viewBox and no fixed width", () => {
    const model = modelOf();
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('data-testid="blog-diagram"');
    expect(html).toContain(`<title id="blog-diagram-points-ranges-title">${esc(model.title)}</title>`);
    expect(html).toContain(`${esc(model.title)}</figcaption>`);
    expect(html).toMatch(/viewBox="0 0 300 \d+"/);
    expect(html, "no fixed pixel width that would scroll a phone").not.toMatch(/<svg[^>]* width="/);
  });

  it("each team's row says its name, its range and its words, in the model's order", () => {
    const model = modelOf();
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    const rows = html.split("<g data-row=").slice(1);
    expect(rows, "a row per team").toHaveLength(model.rows.length);
    for (const [i, r] of model.rows.entries()) {
      expect(textsOf(rows[i]!), `row ${i + 1}`).toEqual([r.team, `${r.worst} to ${r.best}`, r.label].map(esc));
    }
  });

  it("each bar runs from the fewest to the most on one shared axis, and the dot sits at the points now", () => {
    const model = modelOf();
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    const rows = html.split("<g data-row=").slice(1);
    const span = 300 - 2 * 4;
    const at = (p: number) => 4 + (p / model.axisMax) * span;
    let checked = 0;
    for (const [i, r] of model.rows.entries()) {
      const bar = /<rect data-bar=""[^>]*>/.exec(rows[i]!)![0];
      const now = /<circle data-now=""[^>]*>/.exec(rows[i]!)![0];
      expect(numberAttr(bar, "x"), `${r.team} bar start`).toBeCloseTo(at(r.worst), 6);
      expect(numberAttr(bar, "x") + numberAttr(bar, "width"), `${r.team} bar end`).toBeCloseTo(Math.max(at(r.best), at(r.worst) + 2), 6);
      expect(numberAttr(now, "cx"), `${r.team} dot`).toBeCloseTo(at(r.now), 6);
      checked++;
    }
    expect(checked, "bars checked (zero would prove nothing)").toBe(model.rows.length);
    expect(new Set(model.rows.map((r) => r.worst)).size, "the bars do not all start in the same place").toBeGreaterThan(1);
  });

  it("a bar's colour follows its words: through, win and in and qualified are one colour, needs help another, out a third", () => {
    const model = modelOf();
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    const rows = html.split("<g data-row=").slice(1);
    const fillOf = (i: number) => /<rect data-bar=""[^>]*class="([^"]*)"/.exec(rows[i]!)![1]!;
    const byWord = new Map<string, Set<string>>();
    for (const [i, r] of model.rows.entries()) byWord.set(r.label, new Set([...(byWord.get(r.label) ?? []), fillOf(i)]));
    for (const [word, fills] of byWord) expect(fills.size, `'${word}' has one colour`).toBe(1);
    const colour = (word: string) => [...byWord.get(word)!][0]!;
    // The example shows every kind of word, and no two kinds share a colour except through and win and in.
    for (const w of ["Through", "Win and in", "Needs help", "Out"]) expect(byWord.has(w), `'${w}' is drawn`).toBe(true);
    expect(colour("Through")).toBe(colour("Win and in"));
    expect(new Set([colour("Through"), colour("Needs help"), colour("Out")]).size, "three colours").toBe(3);
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
    expect(measured, "texts measured (zero would prove nothing)").toBe(modelOf().rows.length * 3);
  });

  it("the name, the range and the words never run into one another at 13 units a letter", () => {
    const model = modelOf();
    const unit = 13 * 0.56;
    // name at 4, range at 96, words end at 296: the name must end before the range starts, the range before the words start.
    const longestName = Math.max(...model.rows.map((r) => r.team.length));
    expect(4 + longestName * unit, "the longest name ends before the range starts").toBeLessThanOrEqual(96 - 4);
    for (const r of model.rows) {
      const rangeEnd = 96 + `${r.worst} to ${r.best}`.length * unit;
      const wordsStart = 296 - r.label.length * unit;
      expect(rangeEnd, `${r.team}: the range ends before its words start`).toBeLessThanOrEqual(wordsStart - 4);
    }
  });

  it("a range that does not fit the axis is refused, and text that is not markup is escaped", () => {
    const base = modelOf();
    expect(() => renderToStaticMarkup(<BlogDiagram model={{ ...base, axisMax: 0 }} />)).toThrow(/axis/);
    expect(() => renderToStaticMarkup(<BlogDiagram model={{ ...base, rows: base.rows.map((r, i) => (i === 0 ? { ...r, best: base.axisMax + 1 } : r)) }} />)).toThrow(/does not fit/);
    expect(() => renderToStaticMarkup(<BlogDiagram model={{ ...base, rows: base.rows.map((r, i) => (i === 0 ? { ...r, now: r.worst - 1 } : r)) }} />)).toThrow(/does not fit/);
    const html = renderToStaticMarkup(<BlogDiagram model={{ ...base, title: "A <b>range</b>", rows: base.rows.map((r, i) => (i === 0 ? { ...r, team: "<i>X</i>" } : r)) }} />);
    expect(html).not.toContain("<b>range</b>");
    expect(html).not.toContain("<i>X</i>");
    expect(html).toContain("&lt;i&gt;X&lt;/i&gt;");
  });
});
