// Online Chess credits, Task 13 - the PLAYER SWEEP (spec 2026-11-23-online-chess-credits-design.md, the owner's "players never see money" line).
//
// Credits, plans, upgrades, sizes and prices are the ORGANISER's business: a player who registers for, watches or plays in a paid online
// division must not meet one of those words anywhere. A player never pays for the package and cannot act on it, so a sentence about a plan
// or a credit on their screen is a sentence about somebody else's bill.
//
// What it drives (a prod build, a real browser, NO session - a player, not the organiser):
//   one paid online division with round 1 open, in each of the four locales (en, es, fr, nl), four pages -
//     1. the public REGISTRATION page of the competition (a second, paid online division with sign-up open)
//     2. the DIVISION page (/live/{org}/{comp}/{div})
//     3. the MATCH ROOM on a player's personal link, in its CHECK-IN screen (round open, nobody joined yet)
//     4. the public FIXTURE page of that match
//   and reads each page's RENDERED text (innerText, not the markup), scanning it for that locale's words for credit, plan, upgrade, size
//   and the price. 4 locales x 4 pages = 16 pages scanned, 0 hits.
//
// The paired positive - a sweep that finds nothing proves nothing until the same scan is shown to find something: the SAME `scan` runs
// over the organiser's receipt (the pay receipt of an unpaid division, in each locale) and must find the credit and the price words
// there. Every concept's pattern is also run over a sentence the DICTIONARY says (the planted case), and every pattern must occur in
// its locale's own dictionary - a pattern that matches nothing the product can say is a dead word, not a clean page.
//
// Where the words come from: the PATTERNS are typed below (the owner's question is "which words", so that list is the spec); every
// planted SENTENCE and every PRICE is the dictionary's or the leaf's (lib/online-chess-package.ts), never typed here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { activeOrg, apiJson, setOrgLocaleSql, setOrgPlanBySql, withDb } from "./helpers";
import { dismissConsent, freshOrg } from "./directory-kit";
import { CLOCK, payThroughPayDoor, seedMatchRoom, seedOnlineRound } from "./match-room-kit";
import { ONLINE_SIZES, packagePrice } from "../src/lib/online-chess-package";
import { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } from "../src/lib/consent";

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Locale = (typeof LOCALES)[number];
const CONCEPTS = ["credit", "plan", "upgrade", "size", "price"] as const;
type Concept = (typeof CONCEPTS)[number];

// ---------------------------------------------------------------------------------------------------------------------
// The dictionaries, read as the product reads them.
// ---------------------------------------------------------------------------------------------------------------------
const dictOf = (locale: Locale): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"));
const DICT: Record<Locale, Record<string, string>> = { en: dictOf("en"), es: dictOf("es"), fr: dictOf("fr"), nl: dictOf("nl") };
const pubOf = (locale: Locale): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../src/dictionaries/${locale}/public.json`, import.meta.url)), "utf8"));
const PUB: Record<Locale, Record<string, string>> = { en: pubOf("en"), es: pubOf("es"), fr: pubOf("fr"), nl: pubOf("nl") };
/** A string of the PUBLIC dictionary (the spectator pages' words), as the locale says it. */
const sayPub = (locale: Locale, key: string): string => {
  const raw = PUB[locale][key];
  if (raw === undefined) throw new Error(`${locale}/public.json has no ${key}`);
  return raw;
};
const say = (locale: Locale, key: string, vars: Record<string, string | number> = {}): string => {
  const raw = DICT[locale][key];
  if (raw === undefined) throw new Error(`${locale}/ui.json has no ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, v: string) => {
    if (!(v in vars)) throw new Error(`say(${locale}, ${key}): no value for {${v}}`);
    return String(vars[v]);
  });
};

// ---------------------------------------------------------------------------------------------------------------------
// The words. One whole-word pattern per concept per locale (letters and digits bound a word; `u` so accents count as letters).
// ---------------------------------------------------------------------------------------------------------------------
const WORD_SRC: Record<Locale, Record<Exclude<Concept, "price">, string>> = {
  en: { credit: "credits?", plan: "plans?", upgrade: "upgrad(?:e|es|ed|ing)", size: "sizes?" },
  es: { credit: "créditos?", plan: "planes|plan", upgrade: "mejora|mejoras|mejorar", size: "tamaños?" },
  fr: { credit: "crédits?", plan: "forfaits?|offres?|plans?", upgrade: "passer à|mise à niveau|upgrade", size: "tailles?" },
  nl: { credit: "credits?", plan: "abonnementen|abonnement|plannen|plan", upgrade: "upgraden|upgrade|upgrades", size: "formaten|formaat|grootte" },
};

const BOUND_L = String.raw`(?<![\p{L}\p{N}])`;
const BOUND_R = String.raw`(?![\p{L}\p{N}])`;
const rx = (src: string): RegExp => new RegExp(`${BOUND_L}(?:${src})${BOUND_R}`, "giu");

/** Every price the leaf can quote: each size, the camera off and on. A price on a page is "<n> <that locale's credit word>". */
const PRICES = [...new Set(ONLINE_SIZES.flatMap((s) => [packagePrice(s, false), packagePrice(s, true)]))].sort((a, b) => a - b);

const PATTERNS = (locale: Locale): Record<Concept, RegExp> => ({
  credit: rx(WORD_SRC[locale].credit),
  plan: rx(WORD_SRC[locale].plan),
  upgrade: rx(WORD_SRC[locale].upgrade),
  size: rx(WORD_SRC[locale].size),
  price: rx(`(?:${PRICES.join("|")})\\s+(?:${WORD_SRC[locale].credit})`),
});

type Hit = { concept: Concept; text: string };
/** The ONE scanner: the player pages and the organiser's receipt go through this same function. */
function scan(locale: Locale, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const [concept, re] of Object.entries(PATTERNS(locale)) as [Concept, RegExp][]) {
    for (const m of text.matchAll(re)) hits.push({ concept, text: m[0] });
  }
  return hits;
}
const countBy = (hits: Hit[], concept: Concept): number => hits.filter((h) => h.concept === concept).length;

// ---------------------------------------------------------------------------------------------------------------------
// 0. The word lists are live (no browser): the scanner finds each concept in a sentence the dictionary says, and every pattern occurs in
//    its own locale's dictionary. An empty or misspelt pattern would otherwise make the sweep a clean bill of health for nothing.
// ---------------------------------------------------------------------------------------------------------------------
test.describe("the player sweep's word lists", () => {
  test("each concept is found in a sentence the dictionary says, in all four locales", () => {
    const price = packagePrice(ONLINE_SIZES[1]!, false);
    let planted = 0;
    for (const locale of LOCALES) {
      const sentences: Record<Concept, string> = {
        credit: say(locale, "onlineChess.receipt.credits.other", { count: 7 }),
        plan: say(locale, "onlineChess.receipt.refused.plan"),
        upgrade: say(locale, "billing.upgradeToPro"),
        size: say(locale, "onlineChess.receipt.refused.plan"),
        price: say(locale, price === 1 ? "onlineChess.payLine.pay.one" : "onlineChess.payLine.pay.other", { count: price }),
      };
      for (const concept of CONCEPTS) {
        const hits = scan(locale, sentences[concept]);
        expect(countBy(hits, concept), `${locale}: "${sentences[concept]}" must be caught as ${concept}`).toBeGreaterThan(0);
        planted++;
      }
    }
    expect(planted, "5 concepts x 4 locales planted").toBe(CONCEPTS.length * LOCALES.length);
  });

  test("every pattern matches something its locale's own dictionary says (no dead word)", () => {
    let live = 0;
    for (const locale of LOCALES) {
      const values = Object.values(DICT[locale]);
      for (const concept of CONCEPTS) {
        const re = PATTERNS(locale)[concept];
        const found = values.filter((v) => (v.match(re) ?? []).length > 0).length;
        expect(found, `${locale}/${concept}: the pattern occurs in no string of the dictionary - a dead word`).toBeGreaterThan(0);
        live++;
      }
    }
    expect(live).toBe(CONCEPTS.length * LOCALES.length);
  });

  test("the scanner is not a match-everything: ordinary player copy is clean", () => {
    // The product's own player-facing sentences (a registration, a match, a clock) say none of the five concepts.
    let clean = 0;
    for (const locale of LOCALES) {
      for (const key of ["externalPlay.room.checkin.title"]) {
        expect(scan(locale, say(locale, key)), `${locale} ${key}`).toEqual([]);
        clean++;
      }
    }
    expect(clean).toBe(LOCALES.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 1. The sweep.
// ---------------------------------------------------------------------------------------------------------------------
const PLAYERS = ["Ana Petrova", "Bo Lindqvist"] as const;
const RECEIPT_PLAYERS = ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"];

type PageSpec = {
  id: "register" | "division" | "room" | "fixture";
  path: string;
  /** The page is up AND is in this locale: a string the locale's own dictionary says, visible on it. A sweep of an English page filed
   *  under "es" would be a clean bill of health for the wrong language (the public pages follow the ORG's default locale, not the
   *  viewer's cookie - see `seedFor`). */
  ready: (page: Page, locale: Locale) => Promise<void>;
};
type Seeded = { pages: PageSpec[]; receiptTab: string };

async function playerContext(browser: Browser, locale: Locale) {
  const baseURL = test.info().project.use.baseURL as string;
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL });
  await ctx.addCookies([{ name: "seazn_locale", value: locale, url: baseURL }]);
  // A visitor who declined the cookie prompt: the banner is a page of its own words and not what is being swept.
  await ctx.addInitScript(
    ([k, vk, v]) => {
      localStorage.setItem(k!, "rejected");
      localStorage.setItem(vk!, v!);
    },
    [CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION] as const,
  );
  return ctx;
}

/** What the page SHOWS: the rendered text of the document, never its markup. */
const renderedText = (page: Page): Promise<string> => page.locator("body").innerText();

/**
 * One brand-new organiser per locale. The spectator pages (the division, the fixture, the room) take their language from the ORG's
 * `default_locale` - they are ISR and have no per-viewer request scope - and only the registration page reads the visitor's
 * `seazn_locale` cookie; so each locale gets an org whose default is that locale, set before anything public is first rendered (a
 * shared org flipped between locales would serve a cached page in the last one's language).
 */
async function seedFor(page: Page, locale: Locale): Promise<Seeded> {
  await freshOrg(page, `ocsweep${locale}`);
  await dismissConsent(page);
  const org = await activeOrg(page);
  await setOrgPlanBySql({ orgId: org.id }, "pro");
  await setOrgLocaleSql(org.id, locale);

  // The paid online division the players see: round 1 open, two linked players.
  const room = await seedMatchRoom(page.request, { names: [PLAYERS[0], PLAYERS[1]], stage: "knockout" });

  // A second, PAID online division of the same competition with sign-up open: the public registration page.
  const reg = await apiJson<{ id: string }>(page.request, `/api/v1/competitions/${room.competitionId}/divisions`, "POST", {
    name: "Open Rapid Sign-up",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: CLOCK },
  });
  expect(reg.status, `sign-up division: ${JSON.stringify(reg.error)}`).toBeLessThan(300);
  const settings = await apiJson(page.request, `/api/v1/divisions/${reg.data!.id}/registration-settings`, "PUT", {
    enabled: true, entrant_kind: "individual", fee_cents: 0, payment_method: "offline", form_fields: [],
  });
  expect(settings.status, `registration settings: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
  await payThroughPayDoor(page.request, reg.data!.id);
  const paid = await withDb(async (sql) => {
    const [p] = await sql<{ paid_at: Date | null }[]>`
      select paid_at from division_online_packages where division_id = ${reg.data!.id} and refunded_at is null`;
    return p?.paid_at ?? null;
  });
  expect(paid, "premise: the sign-up division's package is PAID").not.toBeNull();
  const slugs = await withDb(async (sql) => {
    const [row] = await sql<{ org: string; comp: string }[]>`
      select o.slug as org, c.slug as comp from competitions c join organizations o on o.id = c.org_id where c.id = ${room.competitionId}`;
    return row!;
  });

  // The organiser's own receipt: an UNPAID division with four entrants, in a competition of its own.
  const owing = await seedOnlineRound(page.request, [...RECEIPT_PLAYERS], { open: false, unpaid: true, stage: "swiss" });

  return {
    receiptTab: owing.fixturesTab,
    pages: [
      { id: "register", path: `/live/${slugs.org}/${slugs.comp}/register`, ready: async (p, l) => { await expect(p.locator("#reg-who-name")).toBeVisible(); await expectMarker(p, REG_MARKER(l)); } },
      { id: "division", path: room.standingsPath, ready: async (p, l) => { await expect(p.getByText("Open Rapid", { exact: false }).first()).toBeVisible(); await expectMarker(p, sayPub(l, "division.tab.standings")); } },
      {
        id: "room",
        path: `${room.roomPath}?t=${encodeURIComponent(room.white.token)}`,
        ready: async (p, l) => {
          await expect(p.getByTestId("match-room")).toHaveAttribute("data-screen", "checkin");
          await expectMarker(p, say(l, "externalPlay.room.checkin.title"));
        },
      },
      { id: "fixture", path: room.fixturePath, ready: async (p, l) => { await expect(p.getByText(PLAYERS[0]).first()).toBeVisible(); await expectMarker(p, FIXTURE_MARKER(l)); } },
    ],
  };
}

const expectMarker = async (p: Page, text: string): Promise<void> => {
  await expect(p.getByText(text, { exact: true }).first(), `the page speaks the locale: "${text}" is on it`).toBeVisible();
};
const REG_MARKER = (l: Locale): string => say(l, "register.section.identity");
const FIXTURE_MARKER = (l: Locale): string => say(l, "externalPlay.watch.details.title");

test.describe("online chess: the player sweep", () => {
  test("a player meets no credit, plan, upgrade, size or price word on any of the four pages, in any of the four locales; the organiser's receipt does", async ({ page, browser }) => {
    test.setTimeout(900_000);
    let scanned = 0;
    let receipts = 0;
    const leaks: string[] = [];
    for (const locale of LOCALES) {
      const seeded = await seedFor(page, locale);
      expect(seeded.pages.map((p) => p.id)).toEqual(["register", "division", "room", "fixture"]);

      // ---- the player ---------------------------------------------------------------------------------------------------
      const ctx = await playerContext(browser, locale);
      try {
        for (const spec of seeded.pages) {
          const p = await ctx.newPage();
          await p.setViewportSize({ width: 1280, height: 900 });
          const res = await p.goto(spec.path, { waitUntil: "load" });
          expect(res?.status(), `${locale} ${spec.id}: the page renders`).toBe(200);
          await spec.ready(p, locale);
          const text = await renderedText(p);
          expect(text.length, `${locale} ${spec.id}: the page has rendered text to scan`).toBeGreaterThan(150);
          scanned++;
          for (const h of scan(locale, text)) leaks.push(`${locale} ${spec.id}: ${h.concept} "${h.text}"`);
          await p.close();
        }
      } finally {
        await ctx.close();
      }

      // ---- the pair: the SAME scan over this locale's organiser receipt finds the words ---------------------------------------
      const origin = new URL(page.url()).origin;
      await page.context().addCookies([{ name: "seazn_locale", value: locale, url: origin }]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(seeded.receiptTab, { waitUntil: "load" });
      await page.getByTestId("online-pay-line-pay").click();
      const receipt = page.getByTestId("online-receipt");
      await expect(receipt, `${locale}: the receipt opens`).toBeVisible();
      await expect(page.getByTestId("online-receipt-row-total"), `${locale}: the quote has loaded (its total row is up)`).toBeVisible();
      const hits = scan(locale, await receipt.innerText());
      receipts++;
      expect(countBy(hits, "credit"), `${locale}: the organiser's receipt says credit`).toBeGreaterThan(0);
      expect(countBy(hits, "price"), `${locale}: the organiser's receipt says the price`).toBeGreaterThan(0);
    }
    expect(scanned, "4 locales x 4 pages scanned").toBe(16);
    expect(receipts, "the receipt scanned in each locale").toBe(LOCALES.length);
    expect(leaks, "a player must meet none of the five organiser words").toEqual([]);
  });
});
