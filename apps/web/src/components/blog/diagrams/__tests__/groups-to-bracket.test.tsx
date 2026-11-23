// The groups-to-bracket picture is a pure drawing of a `groupsToBracket` model. Rendered here from the committed example's own model
// (the producer's output, not a typed-in fixture), so a drawing that skips a team, marks the wrong ones as through, or draws too small fails.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogDiagram } from "@/components/blog/blog-diagram";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { DiagramModel } from "@/blog/examples/types";

type Groups = Extract<DiagramModel, { kind: "groupsToBracket" }>;

const modelOf = (): Groups => {
  const d = BLOG_GOLDENS["groups-into-knockout"]?.diagram;
  if (d === undefined || d.kind !== "groupsToBracket") throw new Error("groups-into-knockout has no groups diagram");
  return d;
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const textsOf = (fragment: string) => [...fragment.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs)].map((m) => m[1]!);
const PHONE_COLUMN = 320 - 2 * 16;
const SMALLEST_TEXT_PX = 12;

describe("the groups-to-bracket picture draws every team and match of the example's own model", () => {
  it("a figure with an accessible name, the caption in words, a viewBox and no fixed width", () => {
    const model = modelOf();
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('data-testid="blog-diagram"');
    expect(html).toContain(`<title id="blog-diagram-groups-to-bracket-title">${esc(model.title)}</title>`);
    expect(html).toContain(`${esc(model.title)}</figcaption>`);
    expect(html).toMatch(/viewBox="0 0 300 \d+"/);
    expect(html, "no fixed pixel width that would scroll a phone").not.toMatch(/<svg[^>]* width="/);
  });

  it("each group lists its teams in order with exactly the ones going through marked, and each match card says its two sides", () => {
    const model = modelOf();
    const html = renderToStaticMarkup(<BlogDiagram model={model} />);
    const groups = html.split('data-group="').slice(1).map((g) => g.split('data-arrow')[0]!);
    expect(groups, "a block per group").toHaveLength(model.groups.length);
    let through = 0;
    for (const [i, g] of model.groups.entries()) {
      expect(textsOf(groups[i]!), `${g.name}: its name, then its teams in finishing order`).toEqual([g.name, ...g.entrants].map(esc));
      const marks = [...groups[i]!.matchAll(/data-through="(yes|no)"/g)].map((m) => m[1]);
      expect(marks, `${g.name}: which teams are marked as through`).toEqual(g.entrants.map((_, k) => (k < g.advancing ? "yes" : "no")));
      through += marks.filter((m) => m === "yes").length;
    }
    expect(through, "teams marked as through").toBe(model.groups.reduce((n, g) => n + g.advancing, 0));
    const matches = html.split('data-match="').slice(1);
    const expected = model.bracket.flatMap((r) => r.matches);
    expect(matches, "a card per match").toHaveLength(expected.length);
    for (const [i, m] of expected.entries()) expect(textsOf(matches[i]!.split("</g></g>")[0]!).slice(0, 2), `match ${i + 1}`).toEqual([m.home ?? "Straight through", m.away ?? "Straight through"].map(esc));
    expect(html, "an arrow from the groups to the bracket").toContain('data-arrow=""');
    expect(html.split('data-round="').length - 1, "a heading per round").toBe(model.bracket.length);
    expect(html, "the straight-through place is drawn as such, once per empty line").toContain("Straight through");
    expect(html.split(">Straight through<").length - 1).toBe(expected.filter((m) => m.home === null || m.away === null).length);
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
    const model = modelOf();
    expect(measured, "texts measured (zero would prove nothing)").toBe(model.groups.reduce((n, g) => n + 1 + g.entrants.length, 0) + model.bracket.reduce((n, r) => n + 1 + 2 * r.matches.length, 0));
  });

  it("a team name's width fits its box at 13 units a letter, so a name never runs under the next group", () => {
    const model = modelOf();
    const groupW = Math.floor((300 - 8 - 2 * 8) / model.groups.length);
    const longest = Math.max(...model.groups.flatMap((g) => g.entrants.map((n) => n.length)));
    // 13 units of font is about 0.6 of it a letter in the house sans (a generous bound); the name starts 8 in and needs 4 to spare.
    expect(longest * 13 * 0.6 + 8 + 4, `the longest name (${longest} letters)`).toBeLessThanOrEqual(groupW);
  });

  it("fewer than two or more than four groups are refused, and text that is not markup is escaped", () => {
    const base = modelOf();
    expect(() => renderToStaticMarkup(<BlogDiagram model={{ ...base, groups: base.groups.slice(0, 1) }} />)).toThrow(/2 to 4 groups/);
    const html = renderToStaticMarkup(<BlogDiagram model={{ ...base, title: "A <b>draw</b>", groups: base.groups.map((g, i) => (i === 0 ? { ...g, name: "<i>A</i>" } : g)) }} />);
    expect(html).not.toContain("<b>draw</b>");
    expect(html).not.toContain("<i>A</i>");
    expect(html).toContain("&lt;i&gt;A&lt;/i&gt;");
  });
});
