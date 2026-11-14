// /start/claim: the emailed funnel link's landing hands its card the visitor's language (start wizard T2 follow-up).
// The card is a client island that words itself from <DictProvider>; mounted bare it falls back to the English catalog
// for every visitor. The page is an async server component, so it is CALLED and its element tree read (the claim/[token]
// page test's convention), then the provider subtree is rendered with the REAL useMsg.
//
// The language, in order: the one the DRAFT was started in (read by the token, never claiming it — the emailed URL
// carries none), then the real resolveLocale's (the switcher's cookie, then the browser's `x-seazn-locale`; nobody is
// signed in). `next/headers` is the stand-in for the visitor. Sweep: every shipped language. Sport: every funnel sport,
// for the first-day-passed card's "Start again" link (the draft's sport as /start's key, read by the token).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const world = vi.hoisted(() => ({
  cookieLocale: undefined as string | undefined,
  browserLocale: undefined as string | undefined,
}));
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
  headers: async () => new Headers(world.browserLocale ? { "x-seazn-locale": world.browserLocale } : {}),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), usePathname: () => "/start/claim" }));

import FunnelClaimPage from "../page";
import { walk } from "@/components/__tests__/_hook-harness";
import { FunnelClaim } from "@/components/funnel-claim";
import { DictProvider } from "@/components/i18n/dict-provider";
import { HtmlLang } from "@/components/i18n/html-lang";
import { MarketingNav } from "@/components/marketing-nav";
import { sql } from "@/lib/db";
import { consumeFunnelDraft, createFunnelDraft } from "@/lib/funnel";
import { FUNNEL_SPORTS } from "@/lib/funnel-sports";
import { LOCALES, type Locale } from "@/lib/i18n-constants";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `fcpg-${randomUUID().slice(0, 8)}`;

const ui = (l: Locale, key: string): string => {
  const d = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../dictionaries", l, "ui.json"), "utf8")) as Record<
    string,
    string
  >;
  const s = d[key];
  if (typeof s !== "string") throw new Error(`${l}/ui.json has no ${key}`);
  return s;
};

async function page(token?: string) {
  const tree = (await FunnelClaimPage({ searchParams: Promise.resolve(token ? { token } : {}) })) as ReactElement;
  const els = walk(tree);
  const providers = els.filter((el) => el.type === DictProvider);
  expect(providers, "one provider").toHaveLength(1);
  const provider = providers[0]!;
  const cards = walk(provider).filter((el) => el.type === FunnelClaim);
  expect(cards, "the card sits inside the provider").toHaveLength(1);
  const navs = els.filter((el) => el.type === MarketingNav);
  expect(navs, "one nav").toHaveLength(1);
  const langs = els.filter((el) => el.type === HtmlLang);
  expect(langs, "one <html lang> writer").toHaveLength(1);
  return {
    locale: (provider.props as { locale: string }).locale,
    card: cards[0]!.props as { token: string | null; restartSport?: string | null; reference?: string | null },
    nav: (navs[0]!.props as { lang?: string }).lang,
    htmlLang: (langs[0]!.props as { lang?: string }).lang,
    html: renderToStaticMarkup(provider),
  };
}
async function draftIn(locale: Locale | null, sport = "Badminton"): Promise<string> {
  const { token } = await createFunnelDraft(
    `${RUN}-${randomUUID().slice(0, 6)}@example.com`,
    { name: `${RUN} ${randomUUID().slice(0, 6)}`, sport, entrants: 4 },
    sql,
    locale,
  );
  return token;
}

beforeEach(() => {
  world.cookieLocale = undefined;
  world.browserLocale = undefined;
});
afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from funnel_drafts where email like ${`${RUN}-%`}`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("the funnel claim page", () => {
  it("every language: the card, the nav and <html lang> follow the visitor's language", async () => {
    let checked = 0;
    for (const l of LOCALES) {
      world.cookieLocale = l;
      const none = await page();
      expect(none.locale, l).toBe(l);
      expect(none.nav, `${l}: the nav`).toBe(l);
      expect(none.htmlLang, `${l}: <html lang>`).toBe(l);
      expect(none.card.token, `${l}: no token`).toBeNull();
      expect(none.html, `${l}: the missing-token card`).toContain(ui(l, "funnel.claim.card.missingToken"));
      checked++;
    }
    expect(checked, "anti-vacuity: every language").toBe(LOCALES.length);
    expect(new Set(LOCALES.map((l) => ui(l, "funnel.claim.card.working"))).size, "premise: each language words it its own way").toBe(
      LOCALES.length,
    );
  });

  it.skipIf(!HAS_DB)("the draft's language wins: started on /fr/start, opened in an English browser — or under a Spanish cookie", async () => {
    const fr = await draftIn("fr");
    const cases = [
      { name: "an English browser", cookie: undefined, browser: "en" },
      { name: "a Spanish switcher cookie", cookie: "es", browser: "en" },
      { name: "a Dutch browser", cookie: undefined, browser: "nl" },
    ];
    let checked = 0;
    for (const c of cases) {
      world.cookieLocale = c.cookie;
      world.browserLocale = c.browser;
      const got = await page(fr);
      expect(got.locale, c.name).toBe("fr");
      expect(got.nav, `${c.name}: the nav`).toBe("fr");
      expect(got.htmlLang, `${c.name}: <html lang>`).toBe("fr");
      expect(got.card.token, `${c.name}: the token reaches the card`).toBe(fr);
      expect(got.html, `${c.name}: the working card, in French`).toContain(ui("fr", "funnel.claim.card.working"));
      checked++;
    }
    expect(checked, "anti-vacuity: every visitor").toBe(cases.length);

    // Read-only: rendering the page never claims the draft — the card's own POST does.
    const [{ used_at }] = await sql<{ used_at: Date | null }[]>`select used_at from funnel_drafts where token = ${fr}`;
    expect(used_at, "the page left the draft unclaimed").toBeNull();
    expect(await consumeFunnelDraft(fr), "and it still claims").not.toBeNull();
    // A link opened a second time is still that visitor's: its dead-link card is in their language too.
    world.browserLocale = "en";
    expect((await page(fr)).locale, "a used draft keeps its language").toBe("fr");
  });

  it.skipIf(!HAS_DB)("the card's Start again sport is the draft's, as /start's key; anything else carries none", async () => {
    // The stored `sport` is the catalogue NAME the wizard posts (lib/funnel-sports.ts); /start's link takes the key.
    let checked = 0;
    for (const sp of FUNNEL_SPORTS) {
      const got = await page(await draftIn("en", sp.name));
      expect(got.card.restartSport, sp.name).toBe(sp.key);
      checked++;
    }
    expect(checked, "anti-vacuity: every funnel sport").toBe(FUNNEL_SPORTS.length);
    expect((await page(await draftIn("en", "Quidditch"))).card.restartSport, "a sport /start does not list").toBeNull();
    expect((await page(`never-${randomUUID()}`)).card.restartSport, "a token that names no draft").toBeNull();
    expect((await page()).card.restartSport, "no token").toBeNull();
  });

  it.skipIf(!HAS_DB)("the card gets the draft's reference — the one its latest email carries, also for a replaced link; none without a draft", async () => {
    // V518: the replaced-link card names the code to look for. A resubmit keeps the reference, so the replaced link and the live one
    // read the same; the start's own answer is the expected value, never the page's read.
    const email = `${RUN}-${randomUUID().slice(0, 6)}@example.com`;
    const payload = { name: `${RUN} ref`, sport: "Badminton", entrants: 4 };
    const first = await createFunnelDraft(email, payload, sql, "en");
    const second = await createFunnelDraft(email, payload, sql, "en");
    let checked = 0;
    for (const token of [first.token, second.token]) {
      expect((await page(token)).card.reference, token === first.token ? "the replaced link" : "the live link").toBe(first.reference);
      checked++;
    }
    expect(checked).toBe(2);
    expect((await page(`never-${randomUUID()}`)).card.reference, "a token that names no draft").toBeNull();
    expect((await page()).card.reference, "no token").toBeNull();
  });

  it.skipIf(!HAS_DB)("no draft language falls to the visitor's: a draft started with none, and a token no draft was minted for", async () => {
    world.cookieLocale = "es";
    expect((await page(await draftIn(null))).locale, "a draft with no language").toBe("es");
    world.cookieLocale = undefined;
    world.browserLocale = "nl";
    const unknown = await page(`never-${randomUUID()}`);
    expect(unknown.locale, "a token that names no draft").toBe("nl");
    expect(unknown.html).toContain(ui("nl", "funnel.claim.card.working"));
  });
});
