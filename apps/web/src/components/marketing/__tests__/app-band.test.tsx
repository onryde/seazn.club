// The app band (spec 2026-11-25 §4; owner-approved Option B): the slim "ticket stub" strip on the home page and three
// product pages. What a DOM would be needed for (widths, centring, hit-testing) is e2e/app-promo.spec.ts's.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ReactElement } from "react";
// prerender, not renderToStaticMarkup: the home page nests async server components (home-signed-in.test.tsx).
import { prerender } from "react-dom/static";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppBand } from "@/components/marketing/app-band";
import { PLAY_STORE_URL } from "@/lib/app-store";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import HomePage from "@/app/[lang]/(marketing)/page";
import MatchDayPage from "@/app/[lang]/(marketing)/product/match-day/page";
import RemoteScoringPage from "@/app/[lang]/(marketing)/product/remote-scoring/page";
import StreamingPage from "@/app/[lang]/(marketing)/product/streaming/page";

vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/en",
  useSearchParams: () => new URLSearchParams(),
}));
// The home page's own reads (session, prices, quick match): none of them decides anything about the band.
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => null }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/pricing-matrix-server", () => ({ loadPricingMatrix: async () => ({}) }));
vi.mock("@/server/usecases/quick-match-recent", () => ({ readRecentQuickMatches: async () => [] }));
vi.mock("@/server/usecases/quick-match-sports", () => ({ listQuickMatchSports: async () => [] }));

const DICTS: Record<Locale, Record<string, string>> = { en, es, fr, nl };
const LABEL = "Seazn Club Mobile App";

// The owner's approved English (2026-11-25), typed from the task brief: the oracle, never read back from the product.
const APPROVED = {
  "home.app": ["Your phone is the camera and the scorer", LABEL, "Scan your organiser’s code to stream a match with the score on screen, or to score it."],
  "product.streaming.app": ["Put the camera in your pocket", LABEL, "Scan a match or court code, then hold Go live. No laptop, no capture card."],
  "product.matchday.app": ["One phone follows the court", LABEL, "Scan a court code once. It goes live when a match starts and stops when it ends."],
  "product.remote.app": ["Score from the app too", LABEL, "Scan your organiser’s scoring code and score every point, ball or goal. The browser pad still works."],
} as const;
type Prefix = keyof typeof APPROVED;

type Page = (p: { params: Promise<{ lang: string }> }) => Promise<ReactElement>;
const PAGES: { prefix: Prefix; page: Page; file: string; next: string }[] = [
  // `next`: something only the section AFTER the band carries, per the brief's placement.
  { prefix: "home.app", page: HomePage, file: "app/[lang]/(marketing)/page.tsx", next: "home.finale.title" },
  { prefix: "product.streaming.app", page: StreamingPage, file: "app/[lang]/(marketing)/product/streaming/page.tsx", next: "product.streaming.ticket.title" },
  { prefix: "product.matchday.app", page: MatchDayPage, file: "app/[lang]/(marketing)/product/match-day/page.tsx", next: "product.matchday.ticket.title" },
  { prefix: "product.remote.app", page: RemoteScoringPage, file: "app/[lang]/(marketing)/product/remote-scoring/page.tsx", next: "product.remote.road.title" },
];

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const BAND = /<section [^>]*data-testid="app-band"[^>]*>.*?<\/section>/gs;
/** Each run of text in the markup, one per element that holds text: a joined "title — label" would be one run. */
const textRuns = (html: string) => [...html.matchAll(/>([^<>]+)</g)].map((m) => decode(m[1]!));

async function renderStatic(page: Page, lang: string): Promise<string> {
  const { prelude } = await prerender(await page({ params: Promise.resolve({ lang }) }));
  return new Response(prelude as ReadableStream<Uint8Array>).text();
}

describe("AppBand", () => {
  it("renders the title, the label and the line as three separate blocks, then one Play badge, in the given order", async () => {
    const html = renderToStaticMarkup(await AppBand({ lang: "en", title: "A title", label: "A label", line: "A line." }));
    expect(html.match(BAND)).toHaveLength(1);
    expect(textRuns(html)).toEqual(["A title", "A label", "A line."]);
    expect(html.match(/data-testid="play-badge"/g)).toHaveLength(1);
    expect(html).toContain(`href="${PLAY_STORE_URL}"`);
    expect(html.indexOf("A line.")).toBeLessThan(html.indexOf('data-testid="play-badge"'));
  });

  it("the badge follows the band's language, English for one the site does not have — counted", async () => {
    let checked = 0;
    for (const [lang, art] of [["en", "en"], ["es", "es"], ["fr", "fr"], ["nl", "nl"], ["de", "en"]] as const) {
      const html = renderToStaticMarkup(await AppBand({ lang, title: "t", label: "l", line: "n" }));
      expect(html, lang).toContain(`src="/badges/google-play-${art}.png"`);
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe("the band's copy", () => {
  it("English is the owner's approved copy, word for word — counted", () => {
    let checked = 0;
    for (const [prefix, [title, label, line]] of Object.entries(APPROVED)) {
      expect([DICTS.en[`${prefix}.title`], DICTS.en[`${prefix}.label`], DICTS.en[`${prefix}.line`]], prefix).toEqual([title, label, line]);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("es, fr and nl translate every title and line, and keep the product's name — counted", () => {
    let checked = 0;
    for (const lang of ["es", "fr", "nl"] as const) {
      for (const prefix of Object.keys(APPROVED)) {
        for (const key of ["title", "line"]) {
          const value = DICTS[lang][`${prefix}.${key}`];
          expect(value, `${lang} ${prefix}.${key}`).toBeTruthy();
          expect(value, `${lang} ${prefix}.${key}`).not.toBe(DICTS.en[`${prefix}.${key}`]);
          checked++;
        }
        expect(DICTS[lang][`${prefix}.label`], `${lang} ${prefix}.label`).toBe(LABEL);
        checked++;
      }
    }
    expect(checked).toBe(36);
  });
});

// One product name (owner, 2026-11-25): every sentence that used to say "the Seazn app" names the product, with each
// language's own article. Keys, name and articles are typed from the task brief, never read from the product.
const NAMING_KEYS = [
  "product.shared.appName",
  "product.streaming.road.3.cap",
  "product.streaming.cam.lede",
  "sport.cricket.road.2.cap",
  "sport.cricket.phones.lede",
  "product.remote.meta.description",
  "product.remote.road.2.cap",
  "product.remote.faq.2.a",
  "product.remote.faq.3.a",
  "product.matchday.faq.1.a",
];
const ARTICLE: Record<Locale, string> = { en: "the", es: "la", fr: "la", nl: "de" };
const OLD_NAMES = /Seazn(?: Club)?[ -]app\b|\bapp(?:li|lication)?(?: de)? Seazn\b/i;

describe("the app's one name in the marketing copy", () => {
  it("each renamed string names the product after its article, capitalised only where it opens a sentence — counted", () => {
    let checked = 0;
    let opening = 0;
    for (const lang of LOCALES) {
      for (const key of NAMING_KEYS) {
        const value = DICTS[lang][key]!;
        const named = [...value.matchAll(new RegExp(`(\\S+) ${LABEL}`, "g"))];
        expect(named.length, `${lang} ${key}: ${value}`).toBe(value.split(LABEL).length - 1);
        expect(named.length, `${lang} ${key}: ${value}`).toBeGreaterThan(0);
        for (const m of named) {
          // appName is the one fragment: pages set it inside their own sentences (the sport page capitalises it there).
          const opens = key !== "product.shared.appName" && /(^|[.!?]\s+)$/.test(value.slice(0, m.index));
          const article = opens ? ARTICLE[lang][0]!.toUpperCase() + ARTICLE[lang].slice(1) : ARTICLE[lang];
          expect(m[1], `${lang} ${key}: ${value}`).toBe(article);
          if (opens) opening++;
          checked++;
        }
      }
    }
    expect(checked).toBe(40);
    // Both capitalisations were really exercised.
    expect(opening).toBeGreaterThan(0);
    expect(opening).toBeLessThan(checked);
  });

  it("no marketing string, in any locale, still uses an old name — counted", () => {
    // The scan's own premise: it knows each old spelling, and does not fire on the product's name.
    for (const old of ["the Seazn app", "la app de Seazn", "l'application Seazn", "l'appli Seazn", "L'app Seazn", "de Seazn-app", "the Seazn Club app", "la app Seazn Club", "l'app Seazn Club", "de Seazn Club-app"]) {
      expect(old).toMatch(OLD_NAMES);
    }
    expect(`la ${LABEL}`).not.toMatch(OLD_NAMES);
    let checked = 0;
    for (const lang of LOCALES) {
      for (const [key, value] of Object.entries(DICTS[lang])) {
        expect(value, `${lang} ${key}`).not.toMatch(OLD_NAMES);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4000);
  });

  // The marketing copy is not the only place a person reads the name: the product's own screens and the help say it too.
  it("no other dictionary and no help article uses an old name — counted", () => {
    const old: string[] = [];
    // Counted per locale: one total floor would still pass with whole locales unread.
    const strings: Record<string, number> = {};
    for (const lang of LOCALES) {
      const dir = join(__dirname, "../../../dictionaries", lang);
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        for (const [key, value] of Object.entries(JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>)) {
          if (OLD_NAMES.test(JSON.stringify(value))) old.push(`${lang}/${file} ${key}`);
          strings[lang] = (strings[lang] ?? 0) + 1;
        }
      }
    }
    const help = join(__dirname, "../../../../content/help");
    const articles = readdirSync(help, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".md"));
    for (const file of articles) if (OLD_NAMES.test(readFileSync(join(help, file), "utf8"))) old.push(`help/${file}`);
    const blog = join(__dirname, "../../../../content/blog");
    const posts = readdirSync(blog).filter((f) => f.endsWith(".md"));
    for (const file of posts) if (OLD_NAMES.test(readFileSync(join(blog, file), "utf8"))) old.push(`blog/${file}`);
    expect(old).toEqual([]);
    for (const lang of ["en", "es", "fr", "nl"]) expect(strings[lang] ?? 0, `${lang} strings read`).toBeGreaterThan(10_000);
    expect(articles.length).toBeGreaterThan(50);
    expect(posts.length).toBeGreaterThan(30);
  });
});

describe("the four pages", () => {
  it.each(PAGES.flatMap((p) => LOCALES.map((lang) => [p.prefix, lang, p] as const)))(
    "%s in %s: one band, carrying this page's own words and this locale's badge",
    async (prefix, lang, { page }) => {
      const html = await renderStatic(page, lang);
      const bands = html.match(BAND) ?? [];
      expect(bands).toHaveLength(1);
      const d = DICTS[lang];
      expect(textRuns(bands[0]!)).toEqual([d[`${prefix}.title`], d[`${prefix}.label`], d[`${prefix}.line`]]);
      expect(bands[0]).toContain(`src="/badges/google-play-${lang}.png"`);
    },
  );

  it.each(PAGES.map((p) => [p.prefix, p] as const))(
    "%s sits between two sections of the page, never inside one, ahead of the section the brief names — counted",
    async (_prefix, { page, next }) => {
      const html = await renderStatic(page, "en");
      const at = html.search(/<section [^>]*data-testid="app-band"/);
      expect(at).toBeGreaterThan(0);
      // The tag before it closes a section: inside a hero or a split band it would be a closing div.
      expect(html.slice(0, at).replace(/<!--[^>]*-->/g, "")).toMatch(/<\/section>$/);
      const after = decode(html.slice(at).replace(BAND, ""));
      const following = /<section\b.*?<\/section>/s.exec(after)?.[0] ?? "";
      expect(following.replace(/<[^>]+>/g, "")).toContain(DICTS.en[next]!.replace(/\*/g, ""));
    },
  );

  it("the home band comes after the competition flow", async () => {
    const html = await renderStatic(HomePage, "en");
    const flow = html.indexOf('data-testid="competition-flow"');
    const band = html.indexOf('data-testid="app-band"');
    expect(flow).toBeGreaterThan(0);
    expect(band).toBeGreaterThan(flow);
    // Only the flow's own closing tag lies between the two: no other section starts in between.
    expect(html.slice(flow, band).split("<section").length - 1).toBe(1);
  });
});

// The plan's "never on" list (public competition pages, the app shell, overlays, embeds, slideshow, the scoring pad),
// held at the source: a surface can only show the badge or the band by importing it.
describe("where the app is promoted", () => {
  const SRC_DIR = join(__dirname, "../../..");
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "__tests__") walk(path);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) sources.push(path);
    }
  };
  walk(SRC_DIR);
  const importersOf = (module: string) => {
    expect(sources.length).toBeGreaterThan(500);
    const re = new RegExp(`(?:from|import\\()\\s*["'][^"']*/${module}["']`);
    return sources.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => relative(SRC_DIR, f)).sort();
  };

  it("the band is imported by exactly the home page and the three product pages", () => {
    expect(importersOf("app-band")).toEqual(PAGES.map((p) => p.file).sort());
  });

  it("the badge is imported by exactly the marketing footer and the band", () => {
    expect(importersOf("play-badge")).toEqual(["components/marketing-footer.tsx", "components/marketing/app-band.tsx"]);
  });
});
