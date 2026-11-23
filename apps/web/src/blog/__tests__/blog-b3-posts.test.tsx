// Batch 3's posts through the real renderer: the picture in post 16 and the Swiss round diagram in posts 13 to 15. What a post
// says in a caption is read back from the example's committed result, never typed here.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogExample } from "@/components/blog/blog-example-table";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import { BYE_CELL } from "@/blog/examples/swiss-claims";
import { findBlogLeaks, withoutDiagramKind } from "@/blog/leaks";
import { blogPost } from "@/server/blog-content";
import { blogBodyLinks } from "@/server/blog-links";
import { renderBlogPost } from "@/server/blog-render";

const render = async (slug: string) => {
  const post = blogPost(slug);
  if (post === null) throw new Error(`no post '${slug}'`);
  return renderBlogPost(post);
};
const htmlOf = (r: Awaited<ReturnType<typeof render>>) => r.parts.flatMap((p) => (p.kind === "html" ? [p.html] : [])).join("\n");
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("knockout-seeds-and-byes: the picture of the bracket", () => {
  it("renders one figure with the file's own size, a real alt and a caption that names the example's byes and matches", async () => {
    const out = await render("knockout-seeds-and-byes");
    const html = htmlOf(out);
    const figures = [...html.matchAll(/<figure>(.*?)<\/figure>/gs)].map((m) => m[1]!);
    expect(figures, "the post has exactly one picture").toHaveLength(1);
    const figure = figures[0]!;
    expect(figure).toContain('src="/help/blog/knockout-seeds-and-byes-1.webp"');
    expect(figure).toMatch(/width="\d+" height="\d+"/);
    expect(/alt="([^"]+)"/.exec(figure)?.[1], "alt text").toBeTruthy();
    const caption = unescape(/<figcaption>(.*?)<\/figcaption>/s.exec(figure)![1]!);

    // The golden's table: first-round matches on the engine's lines, a bye as the example prints it.
    const golden = BLOG_GOLDENS["knockout-seeds"]!;
    const name = (cell: string) => cell.replace(/ \(seed \d+\)$/, "");
    const matches = golden.table!.rows.filter((r) => r[1] !== BYE_CELL && r[2] !== BYE_CELL).map((r) => `${name(String(r[1]))} plays ${name(String(r[2]))}`);
    expect(matches.length, "matches without a bye (zero would prove nothing)").toBeGreaterThan(0);
    for (const m of matches) expect(caption, `the caption says '${m}'`).toContain(m);
    const holders = String(golden.facts.byeHolders);
    expect(holders.length).toBeGreaterThan(0);
    expect(caption).toContain(`${holders}, the top seeds, start with a bye`);
    // Every bye holder named in the caption holds a bye in the table, and the byes are the only players the caption puts there.
    const withBye = golden.table!.rows.filter((r) => r[1] === BYE_CELL || r[2] === BYE_CELL).map((r) => name(String(r[1] === BYE_CELL ? r[2] : r[1])));
    expect(withBye.length, "bye holders in the table").toBeGreaterThan(0);
    expect([...withBye].sort(), "the caption's holders").toEqual(holders.split(" and ").sort());
  });
});

describe("posts 13 to 15 draw the Swiss round grid from their example", () => {
  const POSTS: [string, string][] = [
    ["how-swiss-pairing-works", "swiss-pairing"],
    ["swiss-chess-bye", "swiss-bye-rounds"],
    ["joining-or-leaving-a-swiss", "swiss-late-and-withdraw"],
  ];
  it("each post's example part renders exactly one grid, with the golden's boards, and the table beside it", async () => {
    let checked = 0;
    for (const [slug, id] of POSTS) {
      const out = await render(slug);
      const parts = out.parts.filter((p) => p.kind === "example" && p.id === id);
      expect(parts, `${slug}: the example part`).toHaveLength(1);
      const part = parts[0]!;
      if (part.kind !== "example") throw new Error("unreachable");
      const markup = renderToStaticMarkup(<BlogExample id={part.id} result={part.result} swipeHint="swipe" />);
      expect(markup.split('data-diagram="swissRound"').length - 1, `${slug}: grids`).toBe(1);
      const diagram = BLOG_GOLDENS[id]!.diagram;
      if (diagram?.kind !== "swissRound") throw new Error(`${id}: golden has no Swiss round diagram`);
      expect(markup.split("data-board=\"").length - 1, `${slug}: boards drawn`).toBe(diagram.pairings.length);
      expect(markup, `${slug}: the table is still there`).toContain("<table");
      checked++;
    }
    expect(checked).toBe(POSTS.length);
  });
});

describe("the shared checks that a picture and a diagram meet", () => {
  it("a picture's file path is not read as a link, and a link beside it still is", () => {
    const md = 'See [the bracket](/help/formats/knockout) and ![alt text](/help/blog/some-picture-1.webp "A caption").';
    expect(blogBodyLinks(md)).toEqual(["/help/formats/knockout"]);
    expect(blogBodyLinks('![alt](/help/blog/only-a-picture-1.webp "c")'), "a picture alone is no link").toEqual([]);
  });

  it("the leak scan skips a diagram's kind and nothing else: the same text anywhere else still leaks", () => {
    const g = BLOG_GOLDENS["swiss-pairing"]!;
    if (g.diagram?.kind !== "swissRound") throw new Error("premise: swiss-pairing has a Swiss round diagram");
    const flat = (r: typeof g) => JSON.stringify(r);
    expect(flat(g), "premise: the kind is in the golden").toContain('"kind":"swissRound"');
    expect(flat(withoutDiagramKind(g))).not.toContain("swissRound");
    expect(findBlogLeaks("swissRound").length, "premise: the word leaks when it is copy").toBeGreaterThan(0);
    const copy = { ...g, diagram: { ...g.diagram, title: "the swissRound grid" } };
    expect(flat(withoutDiagramKind(copy)), "a title that says it is still copy").toContain("swissRound");
  });
});

describe("how-swiss-pairing-works: what the pairing counts", () => {
  // The app hands the pairer who has met, each player's colours and who has had a bye, and no float history (`SwissHistoryState` in
  // `server/usecases/stages/swiss-gen.ts`), so the pairing cannot prefer a player who has floated less in an earlier round. The post
  // may say each group floats as few players as it must; it may not say anyone is picked by how often they floated.
  it("does not say a floater is chosen by how many floats they have had, and does say the group above is settled first", async () => {
    const out = await render("how-swiss-pairing-works");
    const text = unescape(htmlOf(out)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text.length, "the post rendered (zero would prove nothing)").toBeGreaterThan(500);
    expect(text, "a float history the app never sends").not.toMatch(/floated least|least[- ]floated|fewest earlier floats|floated before/i);
    expect(text, "the top-down rule is still stated").toMatch(/the group above is settled first/);
  });
});
