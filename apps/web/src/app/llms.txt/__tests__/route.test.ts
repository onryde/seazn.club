// /llms.txt (app/llms.txt/route.ts, llmstxt.org): the help centre and the blog, listed for an answer engine.
//
// Expected values come from somewhere other than the code under test: the URL set is the SITEMAP's own help and blog
// entries (app/sitemap.ts is the one authority on what is public and indexable), the staging decision is whatever
// app/robots.ts decides for the same origin, the cache header is the one Next's own metadata-route loader writes for
// sitemap.xml, and titles and descriptions come from the content on disk and the pages' own metadata builders.
//
// Single-sport reason: no sport is involved; the route lists documents.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
// A public competition is in the sitemap, so "llms.txt lists no competition page" has something it could have listed.
vi.mock("@/server/public-site/sitemap-cache", () => ({
  cachedPublicSitemapEntries: async () => [{ orgSlug: "acme-club", compSlug: "summer-cup", divisionSlugs: ["open"] }],
  SITEMAP_ENTRIES_CACHE_KEY: ["x"],
}));

import * as route from "../route";
import sitemap from "../../sitemap";
import robots from "../../robots";
import { proxy } from "@/proxy";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { blogIndexMetadata } from "@/lib/blog-seo";
import { familyDescription, FORMAT_GALLERY_DESCRIPTION, FORMAT_GALLERY_TITLE, HELP_DESCRIPTION } from "@/lib/help-seo";
import { allBlogPosts } from "@/server/blog-content";
import { allHelpArticles, helpSectionLabel } from "@/server/help-content";

const PROD = "https://seazn.club";
const STAGING = "https://stg.seazn.club";

afterEach(() => {
  vi.unstubAllEnvs();
});

const serve = async (origin: string) => {
  vi.stubEnv("OAUTH_BASE_URL", origin);
  const res = await route.GET();
  return { res, body: await res.text() };
};

interface Link {
  title: string;
  url: string;
  description: string | undefined;
  section: string;
}
const LINK = /^- \[((?:\\.|[^\\\]])+)\]\((\S+)\)(?:: (.+))?$/;
/** The links of a body, each under its section. A line that is neither structure nor a link throws. */
function parse(body: string) {
  const lines = body.split("\n");
  const sections: string[] = [];
  const links: Link[] = [];
  for (const line of lines.slice(1)) {
    if (line === "" || line.startsWith("> ")) continue;
    if (line.startsWith("## ")) {
      sections.push(line.slice(3));
      continue;
    }
    const m = LINK.exec(line);
    if (!m) throw new Error(`not a heading, a quote or a link line: ${JSON.stringify(line)}`);
    if (sections.length === 0) throw new Error(`a link before the first section: ${line}`);
    links.push({ title: m[1]!.replace(/\\(.)/g, "$1"), url: m[2]!, description: m[3], section: sections.at(-1)! });
  }
  return { first: lines[0]!, lines, sections, links };
}

describe("/llms.txt: the llmstxt.org shape", () => {
  it("opens with one H1 and a short blockquote summary, then H2 sections that each hold links", async () => {
    const { body } = await serve(PROD);
    const doc = parse(body);
    expect(doc.first).toBe("# Seazn Club");
    expect(doc.lines.filter((l) => /^# /.test(l))).toHaveLength(1);
    expect(doc.lines[1]).toBe("");
    expect(doc.lines[2]).toMatch(/^> \S/);
    expect(doc.lines[2]!.length, "short").toBeLessThan(300);
    expect(doc.sections.length, "sections").toBeGreaterThan(5);
    expect(new Set(doc.sections).size, "no section twice").toBe(doc.sections.length);
    for (const s of doc.sections) expect(doc.links.filter((l) => l.section === s).length, s).toBeGreaterThan(0);
    // No token or stray markdown reaches the file.
    expect(body).not.toContain("{{");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("is served as UTF-8 text, cached exactly as Next caches sitemap.xml", async () => {
    const { res } = await serve(PROD);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const loader = readFileSync(createRequire(import.meta.url).resolve("next/dist/build/webpack/loaders/next-metadata-route-loader.js"), "utf8");
    const nextRevalidate = /REVALIDATE: '([^']+)'/.exec(loader)?.[1];
    expect(nextRevalidate, "premise: Next's own header was found").toBeTruthy();
    expect(res.headers.get("cache-control")).toBe(nextRevalidate);
  });

  it("is request-time: the origin, and so the staging decision, is never frozen at build", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });
});

describe("/llms.txt: what it lists", () => {
  it("lists exactly the sitemap's help and blog pages, each once, as absolute production URLs", async () => {
    const { body } = await serve(PROD);
    const { links } = parse(body);
    const listed = (await sitemap()).map((e) => new URL(e.url).pathname);
    // Premise: the sitemap really holds pages llms.txt must NOT list, a competition and its division among them.
    expect(listed).toContain("/live/acme-club/summer-cup/open");
    const wanted = listed.filter((p) => /^\/(help|blog)(\/|$)/.test(p)).sort();
    expect(wanted.length, "help and blog pages in the sitemap").toBeGreaterThan(80);
    for (const l of links) expect(l.url.startsWith(`${PROD}/`), l.url).toBe(true);
    expect(links.map((l) => new URL(l.url).pathname).sort()).toEqual(wanted);
    expect(new Set(links.map((l) => l.url)).size).toBe(links.length);
    console.log(`[llms] links checked against the sitemap: ${links.length}`);
  });

  it("every help article carries its own title and description, under its section", async () => {
    const { links } = parse((await serve(PROD)).body);
    let checked = 0;
    for (const a of allHelpArticles().values()) {
      const link = links.find((l) => l.url === `${PROD}/help/${a.slug}`);
      expect(link, a.slug).toEqual({ title: a.title, url: `${PROD}/help/${a.slug}`, description: a.description || undefined, section: `Help: ${helpSectionLabel(a.section)}` });
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(checked).toBe(allHelpArticles().size);
  });

  it("every blog post carries its title and description, newest first, after the blog index", async () => {
    const { links } = parse((await serve(PROD)).body);
    const blog = links.filter((l) => l.section === "Blog");
    const posts = allBlogPosts();
    expect(posts.length).toBeGreaterThan(0);
    const index = blogIndexMetadata();
    expect(blog[0]!.url).toBe(`${PROD}/blog`);
    expect(blog[0]!.description).toBe(index.description);
    expect(blog.slice(1)).toEqual(posts.map((p) => ({ title: p.title, url: `${PROD}/blog/${p.slug}`, description: p.description, section: "Blog" })));
  });

  it("the help home, the format gallery and every format guide carry the words their pages declare", async () => {
    const { links } = parse((await serve(PROD)).body);
    const at = (path: string) => links.find((l) => l.url === `${PROD}${path}`);
    expect(at("/help")?.description).toBe(HELP_DESCRIPTION);
    expect(at("/help/formats")).toMatchObject({ title: FORMAT_GALLERY_TITLE, description: FORMAT_GALLERY_DESCRIPTION });
    let checked = 0;
    for (const f of FORMAT_FAMILIES) {
      expect(at(`/help/formats/${f.slug}`), f.slug).toMatchObject({ title: f.title, description: familyDescription(f) });
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });
});

describe("/llms.txt: only production invites crawlers (the mechanism app/robots.ts uses)", () => {
  it("answers 404 with no link exactly where robots.txt closes the site, and 200 where it does not", async () => {
    const origins = [PROD, STAGING, "https://stg.example.test", "http://localhost:3000", "https://www.seazn.club"];
    let closed = 0;
    let open = 0;
    for (const origin of origins) {
      const { res, body } = await serve(origin);
      const rules = robots().rules;
      const robotsCloses = (Array.isArray(rules) ? rules : [rules]).some((r) => r.userAgent === "*" && r.disallow === "/");
      expect(res.status, origin).toBe(robotsCloses ? 404 : 200);
      if (robotsCloses) {
        expect(body, origin).not.toContain("](");
        closed++;
      } else {
        open++;
      }
    }
    expect({ closed, open }).toEqual({ closed: 2, open: 3 });
  });
});

describe("proxy.ts serves /llms.txt and the IndexNow key file as they are", () => {
  it("neither is rewritten into /[lang] or the games tree, nor redirected, on the site or a games host", () => {
    const paths = ["/llms.txt", "/0123456789abcdef0123456789abcdef.txt"];
    let checked = 0;
    for (const host of ["seazn.club", "games.seazn.club"]) {
      for (const path of paths) {
        const res = proxy(new NextRequest(`https://${host}${path}`, { headers: { host, "accept-language": "fr" } }));
        expect(res.headers.get("x-middleware-rewrite"), `${host}${path}`).toBeNull();
        expect(res.headers.get("location"), `${host}${path}`).toBeNull();
        expect(res.status, `${host}${path}`).toBe(200);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });
});
