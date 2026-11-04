import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

/**
 * Unprefixed marketing paths ("/", "/start", "/pricing") rewrite to the
 * resolved locale so the footer language switcher works without a visible
 * redirect: it writes the seazn_locale cookie and refreshes, and the rewrite
 * then serves the matching per-locale prerender. Regression guard — before the
 * fix these paths were hardcoded to /en and ignored the cookie.
 */
function req(path: string, opts: { cookie?: string; acceptLanguage?: string } = {}) {
  const headers = new Headers();
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.acceptLanguage) headers.set("accept-language", opts.acceptLanguage);
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

const rewriteTarget = (res: Response) =>
  new URL(res.headers.get("x-middleware-rewrite") ?? "http://x/none").pathname;

describe("marketing [lang] rewrite honors the resolved locale", () => {
  it("rewrites / to the seazn_locale cookie's locale", () => {
    expect(rewriteTarget(proxy(req("/", { cookie: "seazn_locale=fr" })))).toBe("/fr");
    expect(rewriteTarget(proxy(req("/", { cookie: "seazn_locale=es" })))).toBe("/es");
  });

  it("rewrites unprefixed sub-paths to the cookie's locale, keeping the path", () => {
    expect(rewriteTarget(proxy(req("/start", { cookie: "seazn_locale=nl" })))).toBe("/nl/start");
    expect(rewriteTarget(proxy(req("/pricing", { cookie: "seazn_locale=fr" })))).toBe("/fr/pricing");
  });

  it("cookie wins over Accept-Language", () => {
    expect(
      rewriteTarget(proxy(req("/", { cookie: "seazn_locale=fr", acceptLanguage: "es" }))),
    ).toBe("/fr");
  });

  it("falls back to Accept-Language when no cookie is set", () => {
    expect(rewriteTarget(proxy(req("/", { acceptLanguage: "fr-FR,fr;q=0.9" })))).toBe("/fr");
  });

  it("serves /en to crawlers with no cookie and no Accept-Language (English stays canonical)", () => {
    expect(rewriteTarget(proxy(req("/")))).toBe("/en");
  });

  it("LIVE1 option A: a bare /live is the marketing wall (rewritten to the locale); /live/<org>/… is the spectator hub (never rewritten)", () => {
    // The wall: exactly the unprefixed path, rewritten like /start and /pricing.
    expect(rewriteTarget(proxy(req("/live")))).toBe("/en/live");
    expect(rewriteTarget(proxy(req("/live", { cookie: "seazn_locale=fr" })))).toBe("/fr/live");
    // The hub: a `/live/` prefix is NOT marketing. A rewrite here would swallow every spectator page into [lang].
    const hub = ["/live/riverside", "/live/riverside/summer-cup", "/live/riverside/summer-cup/open?tab=standings"];
    for (const path of hub) {
      const res = proxy(req(path, { cookie: "seazn_locale=fr" }));
      expect(res.headers.get("x-middleware-rewrite"), `${path}: not rewritten`).toBeNull();
    }
    expect(hub.length, "anti-vacuity: hub paths").toBe(3);
  });

  it("ignores an unsupported cookie locale and negotiates instead", () => {
    // de isn't a built locale — cookie is skipped, Accept-Language wins.
    expect(
      rewriteTarget(proxy(req("/", { cookie: "seazn_locale=de", acceptLanguage: "nl" }))),
    ).toBe("/nl");
  });
});
