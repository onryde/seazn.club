// /start/claim: the emailed funnel link's landing hands its card the visitor's language (start wizard T2 follow-up).
// The card is a client island that words itself from <DictProvider>; mounted bare it falls back to the English catalog
// for every visitor. The page is an async server component, so it is CALLED and its element tree read (the claim/[token]
// page test's convention), then the provider subtree is rendered with the REAL useMsg.
//
// The language is the real resolveLocale's: the switcher's cookie stands in for the visitor (`next/headers` is the
// stand-in), nobody is signed in. Sweep: every shipped language. Sport: not applicable — the page words no sport.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const world = vi.hoisted(() => ({ cookieLocale: undefined as string | undefined }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getCurrentUser: async () => null,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "seazn_locale" && world.cookieLocale ? { value: world.cookieLocale } : undefined),
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

import FunnelClaimPage from "../page";
import { walk } from "@/components/__tests__/_hook-harness";
import { FunnelClaim } from "@/components/funnel-claim";
import { DictProvider } from "@/components/i18n/dict-provider";
import { MarketingNav } from "@/components/marketing-nav";
import { LOCALES, type Locale } from "@/lib/i18n-constants";

const ui = (l: Locale, key: string): string => {
  const d = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../dictionaries", l, "ui.json"), "utf8")) as Record<
    string,
    string
  >;
  const s = d[key];
  if (typeof s !== "string") throw new Error(`${l}/ui.json has no ${key}`);
  return s;
};

async function page(locale: Locale, token?: string) {
  world.cookieLocale = locale;
  const tree = (await FunnelClaimPage({ searchParams: Promise.resolve(token ? { token } : {}) })) as ReactElement;
  const els = walk(tree);
  const providers = els.filter((el) => el.type === DictProvider);
  expect(providers, `${locale}: one provider`).toHaveLength(1);
  const provider = providers[0]!;
  const cards = walk(provider).filter((el) => el.type === FunnelClaim);
  expect(cards, `${locale}: the card sits inside the provider`).toHaveLength(1);
  const navs = els.filter((el) => el.type === MarketingNav);
  expect(navs, `${locale}: one nav`).toHaveLength(1);
  return {
    provider: provider.props as { locale: string },
    card: cards[0]!.props as { token: string | null },
    nav: navs[0]!.props as { lang?: string },
    html: renderToStaticMarkup(provider),
  };
}

describe("the funnel claim page", () => {
  it("every language: the card is worded in the visitor's language, and so is the nav above it", async () => {
    let checked = 0;
    for (const l of LOCALES) {
      const none = await page(l);
      expect(none.provider.locale, l).toBe(l);
      expect(none.nav.lang, `${l}: the nav`).toBe(l);
      expect(none.card.token, `${l}: no token`).toBeNull();
      expect(none.html, `${l}: the missing-token card`).toContain(ui(l, "funnel.claim.card.missingToken"));

      const withToken = await page(l, "tok-abcdefghij");
      expect(withToken.card.token, `${l}: the token reaches the card`).toBe("tok-abcdefghij");
      expect(withToken.html, `${l}: the working card`).toContain(ui(l, "funnel.claim.card.working"));
      checked++;
    }
    expect(checked, "anti-vacuity: every language").toBe(LOCALES.length);
    expect(new Set(LOCALES.map((l) => ui(l, "funnel.claim.card.working"))).size, "premise: each language words it its own way").toBe(
      LOCALES.length,
    );
  });
});
