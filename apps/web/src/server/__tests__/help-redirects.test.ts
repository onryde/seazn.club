// Redirects for help pages that moved or were split: HELP_REDIRECTS maps an OLD slug to the NEW one, and the slug page
// answers the old address with a permanent redirect (help-redirect-page.test.ts drives the page). This file pins the MAP.
// The map is empty until a content task moves a page, so every rule runs on the real map (0 entries today, reported) AND on
// fixture maps that each break exactly one rule, so a rule that stops checking fails here, not silently on the first real move.
import { describe, expect, it } from "vitest";
import { allHelpArticles } from "@/server/help-content";
import { HELP_REDIRECTS, helpRedirectProblems, helpRedirectTarget } from "@/server/help-redirects";
import { HELP_ARTICLE_SLUGS, helpUrl } from "@/lib/help";

const ARTICLES = new Set(allHelpArticles().keys());
// Real articles, used as fixture targets so a fixture can only fail for the reason it is built to.
const BILLING = "billing/plans";
const START = "getting-started/create-a-competition";

/** Registry entries (lib/help.ts) that resolve to neither an article nor a redirect source. */
function registryProblems(registry: readonly string[], articles: ReadonlySet<string>, map: Readonly<Record<string, string>>): string[] {
  return registry
    .filter((slug) => !articles.has(slug) && helpRedirectTarget(slug, map) === null)
    .map((slug) => `lib/help.ts lists '${slug}', which is neither an article nor a redirect source`);
}

describe("help redirects: the real map", () => {
  it("every rule holds for HELP_REDIRECTS (the count is reported; empty is a legitimate state)", () => {
    const entries = Object.keys(HELP_REDIRECTS).length;
    console.log(`help-redirects: ${entries} redirect(s) checked against ${ARTICLES.size} articles${entries === 0 ? " (none yet; each rule is proven on fixtures below)" : ""}`);
    expect(ARTICLES.size, "anti-vacuity: the article set the rules check against is not empty").toBeGreaterThan(0);
    expect(helpRedirectProblems(HELP_REDIRECTS, ARTICLES)).toEqual([]);
  });

  it("every lib/help.ts slug is an article or a redirect source", () => {
    expect(HELP_ARTICLE_SLUGS.length, "anti-vacuity: registry slugs checked").toBeGreaterThan(0);
    expect(registryProblems(HELP_ARTICLE_SLUGS, ARTICLES, HELP_REDIRECTS)).toEqual([]);
  });
});

describe("help redirects: each rule, on a fixture that breaks exactly it", () => {
  it("a well-formed map has no problems (the positive pair), including one source with two homes' worth of history", () => {
    expect(helpRedirectProblems({ "billing/old-plans": BILLING, "billing/older-plans": BILLING, "old/start": START }, ARTICLES)).toEqual([]);
    expect(helpRedirectProblems({}, ARTICLES), "the empty map").toEqual([]);
  });

  it("the target must be an article", () => {
    const problems = helpRedirectProblems({ "billing/old-plans": "billing/no-such-page" }, ARTICLES);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/billing\/old-plans/);
    expect(problems[0]).toMatch(/target 'billing\/no-such-page' is not an article/);
  });

  it("no chain longer than one hop: a target that is itself a source fails, whichever way round the map is written", () => {
    const chain = { "x/first": "x/second", "x/second": BILLING };
    const problems = helpRedirectProblems(chain, ARTICLES);
    expect(problems.some((p) => /x\/first/.test(p) && /chain/.test(p))).toBe(true);
    // the same chain written in the other order is caught too
    const reversed = helpRedirectProblems({ "x/second": BILLING, "x/first": "x/second" }, ARTICLES);
    expect(reversed.some((p) => /x\/first/.test(p) && /chain/.test(p))).toBe(true);
    // a loop is a chain
    expect(helpRedirectProblems({ "x/a": "x/b", "x/b": "x/a" }, ARTICLES).filter((p) => /chain/.test(p))).toHaveLength(2);
  });

  it("no slug is both an article and a redirect source", () => {
    const problems = helpRedirectProblems({ [BILLING]: START }, ARTICLES);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/'billing\/plans' is an article and also a redirect source/);
  });

  it("no self-redirect", () => {
    const problems = helpRedirectProblems({ "x/same": "x/same" }, ARTICLES);
    expect(problems.some((p) => /x\/same/.test(p) && /redirects to itself/.test(p))).toBe(true);
    // a self-redirect onto a real article is reported as one too (not only as the article-and-source clash)
    expect(helpRedirectProblems({ [BILLING]: BILLING }, ARTICLES).some((p) => /redirects to itself/.test(p))).toBe(true);
  });

  it("a source or target not written as section/page (leading or trailing slash, one segment, upper case) never matches a request, so it fails", () => {
    const bad = ["/old/page", "old/page/", "old", "Old/Page", "old//page", "old/page/extra", ""];
    for (const src of bad) {
      const problems = helpRedirectProblems({ [src]: BILLING }, ARTICLES);
      expect(problems.some((p) => /not written as section\/page/.test(p)), `source '${src}'`).toBe(true);
    }
    expect(bad.length, "anti-vacuity").toBeGreaterThan(5);
  });

  it("every problem is reported, not just the first", () => {
    const problems = helpRedirectProblems({ "a/one": "a/nope", "a/two": "a/two", [BILLING]: START }, ARTICLES);
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("helpRedirectTarget", () => {
  const map = { "old/page": BILLING };

  it("returns the new slug for a source and null for anything else", () => {
    expect(helpRedirectTarget("old/page", map)).toBe(BILLING);
    expect(helpRedirectTarget(BILLING, map), "an article is not a source").toBeNull();
    expect(helpRedirectTarget("nothing/here", map)).toBeNull();
    expect(helpRedirectTarget("", map)).toBeNull();
  });

  it("only an own key counts: object-prototype names are not redirect sources", () => {
    for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(helpRedirectTarget(k, map), k).toBeNull();
      expect(helpRedirectTarget(k, {}), `${k} on the empty map`).toBeNull();
    }
  });

  it("the default map is HELP_REDIRECTS", () => {
    expect(helpRedirectTarget("old/page")).toBe(HELP_REDIRECTS["old/page"] ?? null);
  });
});

describe("registry <-> redirects (lib/help.ts)", () => {
  it("an old slug kept in the registry is fine while it redirects; a slug that is neither is a defect (fixture)", () => {
    const articles = new Set([BILLING]);
    expect(registryProblems(["old/page", BILLING], articles, { "old/page": BILLING })).toEqual([]);
    expect(registryProblems(["old/page", BILLING], articles, {}), "the empty map").toHaveLength(1);
    expect(registryProblems(["gone/page"], articles, { "old/page": BILLING })).toHaveLength(1);
  });

  it("helpUrl still builds the link for a registry slug (the redirect then carries the reader on)", () => {
    expect(helpUrl(BILLING)).toBe(`/help/${BILLING}`);
  });
});
