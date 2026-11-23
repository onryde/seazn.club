// The fixture-list picture is a pure drawing of a `fixtureList` model. Rendered here from the committed examples' own models (the
// producers' output, not typed-in fixtures), so a drawing that skips a case or a match, shows a case's words in the wrong place or
// draws too small fails. Both posts that use it are swept (anti-vacuity: the count of pictures is asserted).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogDiagram } from "@/components/blog/blog-diagram";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { DiagramModel } from "@/blog/examples/types";

type List = Extract<DiagramModel, { kind: "fixtureList" }>;

const IDS = ["withdrawal-in-a-league", "joining-a-league-late"] as const;
const modelOf = (id: string): List => {
  const d = BLOG_GOLDENS[id]?.diagram;
  if (d === undefined || d.kind !== "fixtureList") throw new Error(`${id} has no fixture-list diagram`);
  return d;
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const textsOf = (fragment: string) => [...fragment.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs)].map((m) => m[1]!);
const PHONE_COLUMN = 320 - 2 * 16;
const SMALLEST_TEXT_PX = 12;
const UNIT = 13 * 0.56;

describe("the fixture-list picture draws every case and match of the examples' own models", () => {
  it("a figure with an accessible name, the caption in words, a viewBox and no fixed width", () => {
    let checked = 0;
    for (const id of IDS) {
      const model = modelOf(id);
      const html = renderToStaticMarkup(<BlogDiagram model={model} />);
      expect(html, id).toContain('role="img"');
      expect(html, id).toContain('data-testid="blog-diagram"');
      expect(html, id).toContain(`<title id="blog-diagram-fixture-list-title">${esc(model.title)}</title>`);
      expect(html, id).toContain(`${esc(model.title)}</figcaption>`);
      expect(html, id).toMatch(/viewBox="0 0 300 \d+"/);
      expect(html, `${id}: no fixed pixel width that would scroll a phone`).not.toMatch(/<svg[^>]* width="/);
      checked++;
    }
    expect(checked, "pictures checked").toBe(IDS.length);
  });

  it("each case says its heading and verdict, then each match its round, opponent and what became of it, in the model's order", () => {
    let matches = 0;
    for (const id of IDS) {
      const model = modelOf(id);
      const html = renderToStaticMarkup(<BlogDiagram model={model} />);
      const scenes = html.split("<g data-scene=").slice(1);
      expect(scenes, `${id}: a group per case`).toHaveLength(model.scenes.length);
      for (const [i, s] of model.scenes.entries()) {
        const lines = scenes[i]!.split("<g data-line=").slice(1);
        expect(lines, `${id}: case ${i + 1}: a group per match`).toHaveLength(s.lines.length);
        expect(textsOf(scenes[i]!.split("<g data-line=")[0]!), `${id}: case ${i + 1}`).toEqual([s.heading, s.lead, s.effect].map(esc));
        for (const [j, l] of s.lines.entries()) {
          expect(textsOf(lines[j]!), `${id}: case ${i + 1}, match ${j + 1}`).toEqual([l.round, l.opponent, l.fate].map(esc));
          matches++;
        }
      }
    }
    expect(matches, "matches checked (zero would prove nothing)").toBeGreaterThan(0);
  });

  it("a dot's colour follows what became of the match: no two kinds share a colour, and one kind is always the same colour", () => {
    const colourOf = new Map<string, Set<string>>();
    for (const id of IDS) {
      const model = modelOf(id);
      const html = renderToStaticMarkup(<BlogDiagram model={model} />);
      const dots = [...html.matchAll(/<circle [^>]*class="([^"]*)"/g)].map((m) => m[1]!);
      const tones = model.scenes.flatMap((s) => s.lines.map((l) => l.tone));
      expect(dots, `${id}: a dot per match`).toHaveLength(tones.length);
      for (const [i, tone] of tones.entries()) colourOf.set(tone, new Set([...(colourOf.get(tone) ?? []), dots[i]!]));
    }
    for (const t of ["keep", "drop", "award", "new"]) expect(colourOf.has(t), `a '${t}' dot is drawn by one of the examples`).toBe(true);
    for (const [tone, colours] of colourOf) expect(colours.size, `'${tone}' is one colour`).toBe(1);
    expect(new Set([...colourOf.values()].map((c) => [...c][0])).size, "four kinds, four colours").toBe(colourOf.size);
  });

  it("every text is the house small-text size or more at a 320px screen", () => {
    let measured = 0;
    for (const id of IDS) {
      const html = renderToStaticMarkup(<BlogDiagram model={modelOf(id)} />);
      const box = /viewBox="0 0 (\d+) \d+"/.exec(html);
      expect(box, `${id}: a viewBox`).not.toBeNull();
      const pxPerUnit = PHONE_COLUMN / Number(box![1]);
      for (const tag of html.matchAll(/<text\b([^>]*)>(.*?)<\/text>/gs)) {
        const size = /font-size="([\d.]+)"/.exec(tag[1]!);
        expect(size, `a text with no font size ('${tag[2]}')`).not.toBeNull();
        expect(Number(size![1]) * pxPerUnit, `'${tag[2]}'`).toBeGreaterThanOrEqual(SMALLEST_TEXT_PX);
        measured++;
      }
    }
    expect(measured, "texts measured (zero would prove nothing)").toBeGreaterThan(0);
  });

  it("no text runs off the picture or into the next column at 13 units a letter", () => {
    let lines = 0;
    for (const id of IDS) {
      for (const s of modelOf(id).scenes) {
        // heading and the verdict's two parts start at 4 and must end inside the 300 wide picture with 4 to spare.
        for (const t of [s.heading, s.lead, s.effect]) expect(4 + t.length * UNIT, `'${t}'`).toBeLessThanOrEqual(300 - 4);
        for (const l of s.lines) {
          // round starts at 22 and must end before the opponent starts at 86; the opponent before the right-aligned fate.
          expect(22 + l.round.length * UNIT, `'${l.round}' ends before the opponent`).toBeLessThanOrEqual(86 - 4);
          expect(86 + l.opponent.length * UNIT, `'${l.opponent}' ends before its fate starts`).toBeLessThanOrEqual(296 - l.fate.length * UNIT - 4);
          lines++;
        }
      }
    }
    expect(lines, "lines measured (zero would prove nothing)").toBeGreaterThan(0);
  });

  it("the fate is drawn right-aligned against the right edge, the position the overlap test above measures from", () => {
    let fates = 0;
    for (const id of IDS) {
      const model = modelOf(id);
      const html = renderToStaticMarkup(<BlogDiagram model={model} />);
      const wanted = model.scenes.flatMap((s) => s.lines.map((l) => l.fate));
      for (const fate of wanted) {
        const tag = new RegExp(`<text\\b([^>]*)>${fate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</text>`).exec(html);
        expect(tag, `'${fate}' is drawn`).not.toBeNull();
        expect(tag![1], `'${fate}' is right-aligned`).toContain('text-anchor="end"');
        expect(Number(/\bx="([\d.]+)"/.exec(tag![1]!)![1]), `'${fate}' ends 4 units from the edge`).toBe(296);
        fates++;
      }
    }
    expect(fates, "fates checked (zero would prove nothing)").toBeGreaterThan(0);
  });

  it("a case with no matches or too many is refused, and text that is not markup is escaped", () => {
    const base = modelOf("withdrawal-in-a-league");
    expect(() => renderToStaticMarkup(<BlogDiagram model={{ ...base, scenes: [] }} />)).toThrow(/1 to 3 cases/);
    expect(() => renderToStaticMarkup(<BlogDiagram model={{ ...base, scenes: base.scenes.map((s, i) => (i === 0 ? { ...s, lines: [] } : s)) }} />)).toThrow(/1 to 10 matches/);
    const html = renderToStaticMarkup(<BlogDiagram model={{ ...base, title: "A <b>list</b>", scenes: base.scenes.map((s, i) => (i === 0 ? { ...s, heading: "<i>X</i>" } : s)) }} />);
    expect(html).not.toContain("<b>list</b>");
    expect(html).not.toContain("<i>X</i>");
    expect(html).toContain("&lt;i&gt;X&lt;/i&gt;");
  });
});
