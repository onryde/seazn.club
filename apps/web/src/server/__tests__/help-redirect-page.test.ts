// The slug page's redirect, driven through the REAL page component with a fixture redirect map (the real map is empty
// until a page moves): an old slug answers with a permanent redirect to the new one and nothing else; an article is
// still served; an unknown slug is still a 404; and redirect sources are served on demand, not prerendered.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// Sentinels instead of Next's own control-flow errors, so a 404, a redirect and a crash are told apart (the redirect
// carries its target in the message).
const nav = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("CALLED_NOT_FOUND");
  }),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`CALLED_PERMANENT_REDIRECT:${to}`);
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`CALLED_TEMPORARY_REDIRECT:${to}`);
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: nav.notFound,
  permanentRedirect: nav.permanentRedirect,
  redirect: nav.redirect,
}));

// Rendering a token-free article needs no plan table; if the page asked for one here it would be a defect.
const matrix = vi.hoisted(() => ({ loadPricingMatrix: vi.fn(async () => { throw new Error("the plan matrix must not be loaded"); }) }));
vi.mock("@/lib/pricing-matrix-server", () => ({ loadPricingMatrix: matrix.loadPricingMatrix }));
// The article page's serif (components/reading/reading-serif.ts) is next/font, which only exists inside a Next build.
vi.mock("next/font/google", () => ({ Source_Serif_4: () => ({ variable: "--reading-serif", className: "" }) }));

// The real lookup, on a fixture map. The targets are real articles.
const FIXTURE = vi.hoisted(() => ({
  "billing/old-plans": "billing/plans",
  "getting-started/old-start": "getting-started/create-a-competition",
}) as Record<string, string>);
vi.mock("@/server/help-redirects", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/help-redirects")>();
  return { ...real, helpRedirectTarget: (slug: string) => real.helpRedirectTarget(slug, FIXTURE) };
});

import * as page from "@/app/help/[...slug]/page";
import { allHelpArticles, staticHelpSlugs } from "@/server/help-content";

const HelpArticlePage = page.default;
const call = (slug: string[]) => HelpArticlePage({ params: Promise.resolve({ slug }) });
/** A token-free article, so the page renders without a plan table. */
const PLAIN = "getting-started/start-scoring";

beforeEach(() => {
  nav.notFound.mockClear();
  nav.permanentRedirect.mockClear();
  nav.redirect.mockClear();
});

describe("help slug page: redirects", () => {
  it("premises: the fixture targets are real articles and the sources are not", () => {
    const articles = allHelpArticles();
    for (const [from, to] of Object.entries(FIXTURE)) {
      expect(articles.has(to), `target ${to}`).toBe(true);
      expect(articles.has(from), `source ${from}`).toBe(false);
    }
    expect(articles.has(PLAIN)).toBe(true);
  });

  it("an old slug is a PERMANENT redirect to /help/<new slug>, and only that", async () => {
    for (const [from, to] of Object.entries(FIXTURE)) {
      await expect(call(from.split("/"))).rejects.toThrow(`CALLED_PERMANENT_REDIRECT:/help/${to}`);
    }
    expect(nav.permanentRedirect).toHaveBeenCalledTimes(Object.keys(FIXTURE).length);
    // one argument: nothing else (query, fragment, type) is carried over
    for (const args of nav.permanentRedirect.mock.calls) expect(args).toHaveLength(1);
    expect(nav.redirect, "never the temporary one").not.toHaveBeenCalled();
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it("the sequence holds: the same old slug redirects again, and an article between two redirects is still served", async () => {
    await expect(call(["billing", "old-plans"])).rejects.toThrow("CALLED_PERMANENT_REDIRECT:/help/billing/plans");
    const served = (await call(PLAIN.split("/"))) as ReactElement;
    expect(served, "an article renders an element").toBeTruthy();
    expect(nav.permanentRedirect).toHaveBeenCalledTimes(1);
    await expect(call(["billing", "old-plans"])).rejects.toThrow("CALLED_PERMANENT_REDIRECT:/help/billing/plans");
    expect(nav.permanentRedirect).toHaveBeenCalledTimes(2);
    expect(matrix.loadPricingMatrix).not.toHaveBeenCalled();
  });

  it("an unknown slug is still a 404, including object-prototype names and the target's neighbours", async () => {
    for (const slug of [["nothing", "here"], ["constructor"], ["__proto__"], ["billing", "old-plans", "extra"], ["billing"]]) {
      await expect(call(slug), slug.join("/")).rejects.toThrow("CALLED_NOT_FOUND");
    }
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });
});

describe("help redirects are served on demand, not prerendered", () => {
  it("generateStaticParams lists articles only: no redirect source is prebuilt", () => {
    const params = page.generateStaticParams();
    expect(params.length, "anti-vacuity: some articles are prerendered").toBeGreaterThan(0);
    const listed = new Set(params.map((p) => p.slug.join("/")));
    for (const from of Object.keys(FIXTURE)) expect(listed.has(from), `source ${from}`).toBe(false);
    const articles = allHelpArticles();
    for (const slug of listed) expect(articles.has(slug), `${slug} is an article`).toBe(true);
    expect([...listed].sort()).toEqual(staticHelpSlugs(articles.values()).sort());
  });

  it("the route leaves dynamicParams on (a slug that was not prerendered must still be served), and stays ISR", () => {
    const config = page as unknown as { dynamicParams?: boolean; revalidate?: number };
    expect(config.dynamicParams, "dynamicParams = false would 404 every redirect source").not.toBe(false);
    expect(config.revalidate).toBe(300); // Blog P2 Task 5: the article route reads the plan table for token articles
  });
});
