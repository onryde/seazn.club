// Blog P2 Task 5 (owner ruling 2026-11-19: help and blog cached at the edge together): every help page is prerendered
// and revalidated, never rendered per request. Three things make that true, and each is pinned here:
//   - the layout runs the marketing shell with auth="client", so the nav never reads the session cookie on the server
//     (the read that made every help page ƒ Dynamic; build route table, task-5-report.md Step 0);
//   - `dynamic = "error"` on the layout and on EVERY help page, so a request-time read anywhere in the tree fails the
//     build instead of quietly un-caching it (swept from the directory, so a new page cannot miss it);
//   - `revalidate`, typed from the design (2026-11-19-blog-p2-design.md, "Route config"): 300 where a page reads the
//     plan table (an article with a plan token, the format gallery and each format page), 3600 elsewhere. The
//     article route serves token and plain articles alike, and `revalidate` is per route, so it is 300 while ANY article
//     carries a token (counted here from the files, with P1's own token reader).
//
// Single-sport reason: no sport is involved; this is route configuration.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/pricing-matrix-server", () => ({ loadPricingMatrix: async () => ({}) }));
vi.mock("next/font/google", () => ({ Barlow_Condensed: () => ({ variable: "--mk-font-display", className: "" }) }));

import * as layoutRoute from "../layout";
import * as indexRoute from "../page";
import * as articleRoute from "../[...slug]/page";
import * as galleryRoute from "../formats/page";
import * as familyRoute from "../formats/[family]/page";
import { allHelpArticles } from "@/server/help-content";
import { hasHelpTokens } from "@/server/help-tokens";

const HELP_DIR = join(import.meta.dirname, "..");
type Config = { dynamic?: string; revalidate?: number; dynamicParams?: boolean };

/** Every page.tsx under app/help, relative to it. */
function pageFiles(dir = HELP_DIR, rel = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === "__tests__" ? [] : pageFiles(join(dir, e.name), join(rel, e.name));
    return e.name === "page.tsx" ? [join(rel, e.name)] : [];
  });
}

const ROUTES: Record<string, Config> = {
  "page.tsx": indexRoute,
  "[...slug]/page.tsx": articleRoute,
  "formats/page.tsx": galleryRoute,
  "formats/[family]/page.tsx": familyRoute,
};

describe("help route configuration", () => {
  it("the layout runs the shell without the session read, and is itself dynamic = error", () => {
    expect((layoutRoute as Config).dynamic).toBe("error");
    const tree = layoutRoute.default({ children: null }) as { props: { children: { props: Record<string, unknown> } } };
    expect(tree.props.children.props.auth).toBe("client");
  });

  it("every help page on disk is dynamic = error (swept from the directory)", () => {
    const files = pageFiles().sort();
    expect(files, "every page on disk is one this test imports").toEqual(Object.keys(ROUTES).sort());
    let checked = 0;
    for (const f of files) {
      expect(ROUTES[f]!.dynamic, f).toBe("error");
      checked++;
    }
    console.log(`[help pages] dynamic = error checked: ${checked}`);
    expect(checked).toBe(4);
  });

  it("revalidate: 300 where the plan table is read, 3600 elsewhere", () => {
    const tokenArticles = [...allHelpArticles().values()].filter((a) => hasHelpTokens(a.markdown)).length;
    console.log(`[help pages] articles carrying a plan token: ${tokenArticles}`);
    expect(tokenArticles, "the article route is 300 only because some article reads the plan table").toBeGreaterThan(0);
    expect(articleRoute.revalidate).toBe(300);
    expect(galleryRoute.revalidate).toBe(300);
    expect(familyRoute.revalidate).toBe(300);
    expect(indexRoute.revalidate).toBe(3600);
    expect((layoutRoute as Config).revalidate, "the layout sets none, so it never caps a page").toBeUndefined();
  });

  it("the article route still serves what it did not prerender (token articles, moved pages)", () => {
    expect((articleRoute as Config).dynamicParams, "false would 404 every token article and redirect source").not.toBe(false);
  });
});
