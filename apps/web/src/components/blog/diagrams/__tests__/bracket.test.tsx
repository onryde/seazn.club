// The bracket drawing (blog batch 4, fix round 1: gate 4, one picture per post). Rendered from each post's GOLDEN model, never a
// hand-built one, so a post whose picture is wrong or missing fails here. Each check reports what it covered; zero is a failure.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { BracketMatchModel, DiagramModel } from "@/blog/examples/types";
import { BlogDiagram } from "@/components/blog/blog-diagram";
import { BOX_W, SLOT, layoutBracket } from "@/components/blog/diagrams/bracket";

type Bracket = Extract<DiagramModel, { kind: "bracket" }>;
const POSTS = ["third-place-match", "page-playoff-and-stepladder", "double-elimination-explained", "what-is-a-plate"] as const;
const modelOf = (id: string): Bracket => {
  const d = BLOG_GOLDENS[id]?.diagram;
  if (d?.kind !== "bracket") throw new Error(`${id}: the golden carries no bracket diagram`);
  return d;
};
const matchesOf = (m: Bracket): BracketMatchModel[] => m.rounds.flatMap((r) => r.matches);

describe("every batch 4 bracket post carries a bracket picture, drawn without overlap", () => {
  it("lays out every match once, in its own slot, with each edge running from its source to its seat", () => {
    let boxes = 0;
    let edges = 0;
    for (const id of POSTS) {
      const model = modelOf(id);
      const layout = layoutBracket(model);
      expect(layout.boxes.length, `${id}: every match is placed`).toBe(matchesOf(model).length);
      // No two boxes of a column are closer than a slot (a box is drawn with its label and the gap under it).
      for (const a of layout.boxes) {
        for (const b of layout.boxes) {
          if (a !== b && a.col === b.col) expect(Math.abs(a.y - b.y), `${id}: ${a.key} and ${b.key} overlap`).toBeGreaterThanOrEqual(SLOT - 0.001);
        }
        expect(a.x + BOX_W, `${id}: ${a.key} is inside the drawing`).toBeLessThanOrEqual(layout.width);
      }
      const feeds = matchesOf(model).flatMap((m) => [m.homeFrom, m.awayFrom]).filter((f) => f !== undefined);
      expect(layout.edges.length, `${id}: one edge per feed`).toBe(feeds.length);
      for (const e of layout.edges) {
        const from = layout.boxes.find((b) => b.key === e.from)!;
        const to = layout.boxes.find((b) => b.key === e.to)!;
        expect(from.col, `${id}: ${e.from} feeds a later column`).toBeLessThan(to.col);
        expect(e.d.startsWith(`M ${from.x + BOX_W} `), `${id}: the edge leaves ${e.from}'s right side`).toBe(true);
        expect(e.d.endsWith(`H ${to.x}`), `${id}: the edge enters ${e.to}'s left side`).toBe(true);
      }
      boxes += layout.boxes.length;
      edges += layout.edges.length;
    }
    expect(boxes, "anti-vacuity: boxes laid out").toBeGreaterThan(20);
    expect(edges, "anti-vacuity: edges laid out").toBeGreaterThan(15);
  });

  it("no two lines run on top of each other, and parallel vertical runs keep their distance (review N4)", () => {
    // An edge is `M x1 y1 H xm V y2 H x2`: out of its source, down a channel, into its seat. Read each back from its path.
    const MIN_APART = 7;
    let pairs = 0;
    let sharedSource = 0;
    let horizontals = 0;
    for (const id of POSTS) {
      const layout = layoutBracket(modelOf(id));
      const segs = layout.edges.map((e) => {
        const m = /^M ([\d.]+) ([\d.]+) H ([\d.]+) V ([\d.]+) H ([\d.]+)$/.exec(e.d);
        if (m === null) throw new Error(`${id}: an edge is not an elbow: ${e.d}`);
        const [x1, y1, xm, y2, x2] = m.slice(1).map(Number) as [number, number, number, number, number];
        return { e, x1, y1, xm, y2, x2 };
      });
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const a = segs[i]!;
          const b = segs[j]!;
          pairs++;
          // First horizontal runs: the same row of the same column may not overlap in x.
          if (a.y1 === b.y1 && Math.min(a.xm, a.x1) < Math.max(b.xm, b.x1) && Math.min(b.xm, b.x1) < Math.max(a.xm, a.x1)) {
            throw new Error(`${id}: the lines ${a.e.from}->${a.e.to} and ${b.e.from}->${b.e.to} run on top of each other leaving their sources`);
          }
          // Any two horizontal runs of different lines at the same height may not overlap (a line leaving a match along the line entering the next).
          const hRuns = (x: (typeof a)) => [
            { y: x.y1, lo: Math.min(x.x1, x.xm), hi: Math.max(x.x1, x.xm) },
            { y: x.y2, lo: Math.min(x.xm, x.x2), hi: Math.max(x.xm, x.x2) },
          ];
          for (const ra of hRuns(a)) {
            for (const rb of hRuns(b)) {
              horizontals++;
              if (Math.abs(ra.y - rb.y) < 2 && ra.lo < rb.hi - 0.5 && rb.lo < ra.hi - 0.5) {
                throw new Error(`${id}: a line of ${a.e.from}->${a.e.to} runs along a line of ${b.e.from}->${b.e.to} at y=${ra.y}`);
              }
            }
          }
          if (a.e.from === b.e.from) {
            sharedSource++;
            expect(a.y1, `${id}: ${a.e.from} sends a winner line and a loser line from different rows`).not.toBe(b.y1);
          }
          // Vertical runs whose spans overlap may not sit closer than MIN_APART.
          const aLo = Math.min(a.y1, a.y2);
          const aHi = Math.max(a.y1, a.y2);
          const bLo = Math.min(b.y1, b.y2);
          const bHi = Math.max(b.y1, b.y2);
          if (aLo < bHi && bLo < aHi) {
            expect(Math.abs(a.xm - b.xm), `${id}: ${a.e.from}->${a.e.to} and ${b.e.from}->${b.e.to} run side by side`).toBeGreaterThanOrEqual(MIN_APART);
          }
        }
      }
    }
    expect(pairs, "anti-vacuity: line pairs compared").toBeGreaterThan(100);
    expect(horizontals, "anti-vacuity: horizontal runs compared").toBeGreaterThan(400);
    expect(sharedSource, "anti-vacuity: a source that sends both a winner and a loser line (the third-place and double elimination figures)").toBeGreaterThan(0);
  });

  it("renders the title as the SVG's <title> and as the caption, every match and every seat, in a named, focusable scroll box", () => {
    let seats = 0;
    for (const id of POSTS) {
      const model = modelOf(id);
      const html = renderToStaticMarkup(<BlogDiagram model={model} />);
      const escaped = model.title.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");
      expect(html, id).toContain("<svg");
      expect(html, `${id}: title`).toContain(`>${escaped}</title>`);
      expect(html, `${id}: caption`).toContain(`>${escaped}</figcaption>`);
      expect((html.match(/data-match="/g) ?? []).length, `${id}: every match drawn`).toBe(matchesOf(model).length);
      expect(html, `${id}: scroll box is a focusable region with a name`).toMatch(/role="region"[^>]*aria-labelledby="blog-diagram-bracket-cap"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/);
      for (const m of matchesOf(model)) {
        for (const seat of [m.home, m.away]) {
          if (seat === null) continue;
          expect(html, `${id}: ${seat}`).toContain(`>${seat}<`);
          seats++;
        }
      }
    }
    expect(seats, "anti-vacuity: seats rendered").toBeGreaterThan(40);
  });

  it("a seat and its tag fit the box (a long name would run under the tag or out of the box)", () => {
    let checked = 0;
    for (const id of POSTS) {
      for (const m of matchesOf(modelOf(id))) {
        for (const seat of [m.home, m.away]) {
          if (seat === null) continue;
          const tag = m.tags?.[seat];
          // 12 px semibold is about 7 px a character; the tag's pill is 5.2 px a character and 10 of padding; the box keeps 8 px each side.
          const width = seat.length * 7 + (tag === undefined ? 0 : tag.length * 5.2 + 10 + 6);
          expect(width, `${id}: ${seat}${tag === undefined ? "" : ` [${tag}]`}`).toBeLessThanOrEqual(BOX_W - 16);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
});

describe("a model the drawing cannot place is refused by name, never drawn wrong", () => {
  const seat = (home: string, away: string | null): BracketMatchModel => ({ home, away });
  it("refuses an empty model, a duplicate id, a feed from nowhere, and a feed from the same column", () => {
    const empty: Bracket = { kind: "bracket", title: "t", rounds: [] };
    expect(() => layoutBracket(empty)).toThrow(/no matches/);
    const dup: Bracket = { kind: "bracket", title: "t", rounds: [{ name: "a", matches: [{ ...seat("A", "B"), id: "x" }, { ...seat("C", "D"), id: "x" }] }] };
    expect(() => layoutBracket(dup)).toThrow(/two matches are called 'x'/);
    const nowhere: Bracket = {
      kind: "bracket",
      title: "t",
      rounds: [{ name: "a", matches: [{ ...seat("A", "B"), id: "x" }] }, { name: "b", matches: [{ ...seat("A", "C"), id: "y", homeFrom: { id: "ghost", side: "winner" } }] }],
    };
    expect(() => layoutBracket(nowhere)).toThrow(/'ghost'/);
    const sameCol: Bracket = {
      kind: "bracket",
      title: "t",
      rounds: [{ name: "a", matches: [{ ...seat("A", "B"), id: "x" }, { ...seat("A", "C"), id: "y", homeFrom: { id: "x", side: "winner" } }] }],
    };
    expect(() => layoutBracket(sameCol)).toThrow(/earlier column/);
  });

  it("pushes a second match that would land on the same slot below the first (a final and a third-place match fed by the same two semi-finals)", () => {
    const model: Bracket = {
      kind: "bracket",
      title: "t",
      rounds: [
        { name: "sf", matches: [{ ...seat("A", "B"), id: "s1" }, { ...seat("C", "D"), id: "s2" }] },
        {
          name: "f",
          matches: [
            { ...seat("A", "C"), id: "f", homeFrom: { id: "s1", side: "winner" }, awayFrom: { id: "s2", side: "winner" } },
            { ...seat("B", "D"), id: "t", homeFrom: { id: "s1", side: "loser" }, awayFrom: { id: "s2", side: "loser" } },
          ],
        },
      ],
    };
    const l = layoutBracket(model);
    const f = l.boxes.find((b) => b.key === "f")!;
    const t = l.boxes.find((b) => b.key === "t")!;
    expect(t.y - f.y).toBeGreaterThanOrEqual(SLOT - 0.001);
    expect(l.hasLoserEdge).toBe(true);
  });
});
