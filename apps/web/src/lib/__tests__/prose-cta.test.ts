// PEF round 2 (controller, 2026-11-03): the editor's Button tool must produce a branded button on the public page.
//
// The sponsor/CTA grammar (lib/prose.ts header, v3/06 §2) is "a paragraph that is ONLY a bold link", written
// `**[label](url)**`. The editor's Button tool wrote `[**label**](url)` instead (TipTap ranks the link mark outside
// bold), and the renderer only branded the first nesting, so every button made in the editor reached the public page
// as a plain bold link (proven in a browser on both hosts: zero `a.prose-cta`).
//
// Held here, through the REAL `renderProse`:
//   (a) the renderer treats `[**label**](url)` exactly like `**[label](url)**` — byte-identical HTML, so a description
//       already saved in the old shape renders right with no data migration — and refuses an unsafe scheme the same
//       way in both;
//   (b) the editor's canonicaliser (`canonicalCtaMarkdown`, called on every editor change) rewrites the old shape into
//       the documented one and changes nothing else — and nothing it does changes what the renderer draws;
//   and that every public surface that draws organiser prose goes through that one renderer.
// Expected HTML is never typed here: the canonical shape's own render is the reference, and the canonical shape is the
// one the renderer documents (and prose.test.ts pins as the button).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalCtaMarkdown, renderProse } from "@/lib/prose";

const LABEL = "Book your place";
const URL_OK = "https://example.com/register";
const canonical = (label: string, url: string) => `**[${label}](${url})**`;
const boldInside = (label: string, url: string) => `[**${label}**](${url})`;

describe("renderProse: the sponsor button in either nesting (a)", () => {
  it("`[**label**](url)` renders byte-identically to `**[label](url)**`, and that render IS the branded button", async () => {
    const reference = await renderProse(canonical(LABEL, URL_OK));
    // Anti-vacuity: the reference is the button, or the equality below would compare two plain links.
    expect(reference, "premise: the canonical shape is the branded button").toContain('class="prose-cta"');
    expect(await renderProse(boldInside(LABEL, URL_OK))).toBe(reference);
  });

  it("…in a whole description too: between other paragraphs, and after a link, as the editor writes it", async () => {
    const around = (cta: string) => `Doors open at nine. [Club website](https://example.org/club)\n\n${cta}\n\nSee you there.`;
    const reference = await renderProse(around(canonical(LABEL, URL_OK)));
    expect(reference.match(/class="prose-cta"/g)?.length, "premise: exactly one button").toBe(1);
    expect(await renderProse(around(boldInside(LABEL, URL_OK)))).toBe(reference);
  });

  it("the link safety rules are the same for both: allowed schemes keep their href, unsafe ones lose it, in both", async () => {
    const cases = [
      { url: "https://example.com/r", allowed: true },
      { url: "http://example.com/r", allowed: true },
      { url: "mailto:club@example.com", allowed: true },
      { url: "javascript:alert(1)", allowed: false },
      { url: "JaVaScRiPt:alert(1)", allowed: false },
      { url: "data:text/html,hi", allowed: false },
      { url: "vbscript:msgbox(1)", allowed: false },
    ];
    let checked = 0;
    for (const { url, allowed } of cases) {
      const a = await renderProse(canonical(LABEL, url));
      const b = await renderProse(boldInside(LABEL, url));
      expect(b, `${url}: both nestings render the same`).toBe(a);
      for (const html of [a, b]) {
        if (allowed) expect(html, url).toContain(`href="${url}"`);
        else {
          expect(html, `${url}: refused`).not.toMatch(/javascript:|data:|vbscript:/i);
          expect(html, `${url}: no href survives`).not.toContain("href=");
        }
        // Neither nesting ever gains a rel/target the other lacks, or any attribute beyond href and the class.
        expect(html, url).not.toMatch(/\s(rel|target|on\w+|style)=/i);
        checked += 1;
      }
    }
    // Anti-vacuity: every case, both nestings.
    expect(checked).toBe(cases.length * 2);
  });

  it("only a paragraph that is ONLY the bold link is a button — in either nesting", async () => {
    const notButtons = [
      (s: (l: string, u: string) => string) => `Please ${s("register", URL_OK)} today.`,
      (s: (l: string, u: string) => string) => `- ${s(LABEL, URL_OK)}`,
      (s: (l: string, u: string) => string) => `> ${s(LABEL, URL_OK)}`,
      (s: (l: string, u: string) => string) => `${s(LABEL, URL_OK)} and more`,
    ];
    for (const shape of notButtons) {
      for (const nest of [canonical, boldInside]) {
        const html = await renderProse(shape(nest));
        expect(html, shape(nest)).not.toContain("prose-cta");
        expect(html, `${shape(nest)}: still a bold link`).toMatch(/<strong>|<a /);
      }
    }
    // A link with more than the bold label in it is not the grammar either.
    expect(await renderProse(`[**${LABEL}** today](${URL_OK})`)).not.toContain("prose-cta");
  });
});

describe("canonicalCtaMarkdown: the editor writes the documented shape (b)", () => {
  it("rewrites the editor's `[**label**](url)` paragraph to `**[label](url)**`", () => {
    expect(canonicalCtaMarkdown(boldInside(LABEL, URL_OK))).toBe(canonical(LABEL, URL_OK));
  });

  it("rewrites every button in a description and leaves every other byte alone", () => {
    const md = [
      "Doors open at nine. [Club website](https://example.org/club)",
      "",
      boldInside(LABEL, URL_OK),
      "",
      "Please [**register**](https://x.dev) today.",
      "",
      boldInside("Sponsor", "https://sponsor.example"),
    ].join("\n");
    const want = [
      "Doors open at nine. [Club website](https://example.org/club)",
      "",
      canonical(LABEL, URL_OK),
      "",
      "Please [**register**](https://x.dev) today.",
      "",
      canonical("Sponsor", "https://sponsor.example"),
    ].join("\n");
    expect(canonicalCtaMarkdown(md)).toBe(want);
  });

  it("the empty case and the already-canonical case come back unchanged, and a second pass changes nothing", () => {
    for (const md of ["", "   ", canonical(LABEL, URL_OK), "Just text.", "- [**x**](https://x.dev)"]) {
      expect(canonicalCtaMarkdown(md), JSON.stringify(md)).toBe(md);
    }
    const once = canonicalCtaMarkdown(boldInside(LABEL, URL_OK));
    expect(canonicalCtaMarkdown(once)).toBe(once);
  });

  it("never changes what the public page draws (checked against the renderer, not against itself)", async () => {
    const corpus = [
      boldInside(LABEL, URL_OK),
      boldInside("Book \\*now\\*", URL_OK),
      boldInside("Tickets \\[early\\]", "https://example.com/a\\(b\\)"),
      `[**${LABEL}**](${URL_OK} "Title")`,
      `Intro\n\n${boldInside(LABEL, URL_OK)}\n\nOutro`,
      `Line one\\\n${boldInside(LABEL, URL_OK)}`,
      `- ${boldInside(LABEL, URL_OK)}`,
      `> ${boldInside(LABEL, URL_OK)}`,
      boldInside(LABEL, "javascript:alert(1)"),
      `[**${LABEL}**][ref]\n\n[ref]: ${URL_OK}`,
      "Please [**register**](https://x.dev) today.",
      canonical(LABEL, URL_OK),
    ];
    let rewritten = 0;
    for (const md of corpus) {
      const out = canonicalCtaMarkdown(md);
      if (out !== md) rewritten += 1;
      expect(await renderProse(out), md).toBe(await renderProse(md));
      expect(out.length, `${md}: the same length (the 20 000 cap bites in the same place)`).toBe(md.length);
    }
    // Anti-vacuity: the corpus exercises real rewrites, not only pass-throughs.
    expect(rewritten).toBeGreaterThanOrEqual(5);
  });
});

/** Every `.ts`/`.tsx` under src, tests excluded, as [path relative to src, text]. */
function sources(): [string, string][] {
  const root = join(__dirname, "..", "..");
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "__tests__" || name === "node_modules") continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(name)) out.push([relative(root, p), readFileSync(p, "utf8")]);
    }
  };
  walk(root);
  return out;
}

describe("one authority: every public surface draws organiser prose through renderProse", () => {
  const files = sources();

  it("only lib/prose.ts and the help centre build a Markdown pipeline", () => {
    expect(files.length, "anti-vacuity: the sweep read the source tree").toBeGreaterThan(100);
    const builders = files
      .filter(([, text]) => /from "(unified|remark-parse|marked|markdown-it|react-markdown)"/.test(text))
      .map(([p]) => p)
      .sort();
    expect(builders).toEqual(["lib/prose.ts", "server/help-content.ts"]);
  });

  it("the help centre's renderer draws help articles only — news posts go through renderProse like every organiser box", () => {
    const helpUsers = files.filter(([, text]) => /\brenderHelpMarkdown\b/.test(text)).map(([p]) => p).sort();
    expect(helpUsers).toEqual(["app/help/[...slug]/page.tsx", "server/help-content.ts"]);
    const news = files.find(([p]) => p === "app/(public)/live/[orgSlug]/news/[postSlug]/page.tsx");
    expect(news, "the news post page exists where this test looks").toBeDefined();
    expect(news![1]).toMatch(/\brenderProse\(post\.bodyMd/);
  });
});
