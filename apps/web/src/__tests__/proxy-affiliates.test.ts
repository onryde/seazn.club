import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { footerCols } from "@/components/marketing-footer";
import { LOCALES } from "@/lib/i18n-constants";

/**
 * The footer's /affiliates link is UN-prefixed, and only an allow-list of
 * marketing paths in proxy.ts is rewritten under /[lang]. A link nobody
 * rewrites is a 404 — which shipped once, past a green footer test that only
 * checked the link EXISTED. So the href is taken from the footer itself and
 * driven through the real proxy, per locale.
 */
const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });
const rewriteTarget = (res: Response) =>
  new URL(res.headers.get("x-middleware-rewrite") ?? "http://x/none").pathname;

describe("footer /affiliates link resolves through the proxy", () => {
  const href = footerCols(true).flatMap((c) => c.links).find((l) => l.requiresRevshare)?.href;

  it("the footer has exactly one revshare-gated link to drive (anti-vacuity)", () => {
    expect(href).toBeTruthy();
    expect(footerCols(true).flatMap((c) => c.links).filter((l) => l.requiresRevshare)).toHaveLength(1);
  });

  it("is rewritten under the resolved locale for every locale, keeping the path", () => {
    let checked = 0;
    for (const lang of LOCALES) {
      expect(rewriteTarget(proxy(req(href!, `seazn_locale=${lang}`)))).toBe(`/${lang}${href}`);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("an unprefixed path that is NOT on the allow-list is not rewritten (negative pair)", () => {
    expect(rewriteTarget(proxy(req("/definitely-not-a-marketing-page", "seazn_locale=fr")))).toBe("/none");
  });
});
