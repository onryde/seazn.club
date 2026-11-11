// Title sponsor poster - the owner's visual sign-off capture: the REAL competition page's hero and the sponsor editor at 320, 768 and 1280,
// each state witnessed BEFORE its shot, the PNGs written to TITLE_POSTER_CAPTURE_DIR - which only the e2e workflow's opt-in
// `title_poster_captures` dispatch sets, and which it uploads as the `title-poster-captures` artifact. The PNGs never enter the repo
// (owner 2026-10-09). Modelled on `sponsor-deals-captures.spec.ts`, whose step and upload it sits beside in `.github/workflows/e2e.yml`.
//
// Without TITLE_POSTER_CAPTURE_DIR every test here SKIPS: the walkthrough "rest" legs select the file on every push to main (the inventory
// in src/lib/__tests__/e2e-ci-wiring.test.ts names it), and a capture nobody asked for is a minute of CI spent on pictures nobody will read.
//
// The states (English unless named, at each of 320 / 768 / 1280, file `<state>-<width>-tall.png`):
//   hero-3-posters              three Title sponsors with posters, the first on show, the dots under it (reduced motion: nothing turns)
//   hero-1-poster               one Title sponsor with a poster: no dots
//   hero-fallback-logo          a Title sponsor with a logo and no poster: the logo on white
//   hero-fallback-monogram-long a 43-character name, no logo, no poster, no link: the monogram card, the name in two lines, no Visit
//   hero-long-name-es / -nl     the same 43-character name, with a poster and a link, on an org whose public pages are Spanish / Dutch
//   hero-register-open          registration open: the Register button beside the panel
//   hero-no-title               the control: a competition with no Title sponsor, the hero as it always was
//   editor                      the sponsor page's editor, a 1920 x 1080 picture picked: the preview and the crop warning
//   details                     the sponsor page, read-only, with a stored poster: its Poster row
// and one picture at a phone's real size: the band on a 320 x 568 screen (`band-320x568.png`).
//
// WHAT IS FAKED, exactly - one thing, at the browser's boundary: the bytes of the pictures. CI's storage host
// (`NEXT_PUBLIC_SUPABASE_URL=https://stub.supabase.co`) answers nothing, so every poster and logo is stored as a URL under it (the sponsor API
// takes any http(s) poster) and `routePosterArt` answers the browser's `/_next/image` request for it with art. Everything else is real: the
// sponsors are made through the API, the registration is opened through the API, the public page is the server's own render, the Spanish and
// Dutch pages are an org whose default locale is that (the only thing a public page reads: it is cached and has no viewer).
//
// The viewport is TALL (1600) on purpose, and the files say so (`-tall`): a side panel scrolls inside itself, and a picture cut at 900px
// shows the owner half a screen. A hero picture is clipped to the hero and the band under it, so it shows exactly what a visitor sees there.
// A tall picture is NOT what a phone shows - the one 320 x 568 shot is.
//
// EVERY WITNESS IS READ FROM THE SEED, not typed beside it: which sponsors a competition holds, in what order, with what face, is the data
// below, and each witness (a dot count, the sponsor on show, the poster URL the browser asked for) is derived from it.
//
// ANTI-VACUITY (AGENTS.md class 10): the last test asserts every file exists, is a PNG, and that no two are byte-identical - a capture that
// errored before a shot, or two states that never opened, cannot pass it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, setOrgLocaleSql, withDb } from "../helpers";
import { releaseSettingsOrg, seedCompetition, seedDivision, seedSettingsOrg, sponsorEditUrl, sponsorUrl, type SeededOrg } from "../settings-support";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { posterPng, posterSvg, routePosterArt, storagePublicUrl } from "../helpers/poster-art";

const DIR = process.env.TITLE_POSTER_CAPTURE_DIR;
const WIDTHS = [320, 768, 1280] as const;
const HEIGHT = 1600;
const STATES = [
  "hero-3-posters",
  "hero-1-poster",
  "hero-fallback-logo",
  "hero-fallback-monogram-long",
  "hero-long-name-es",
  "hero-long-name-nl",
  "hero-register-open",
  "hero-no-title",
  "editor",
  "details",
] as const;
type State = (typeof STATES)[number];
/** The realistic 43-character name. */
const LONG_SPONSOR = "Harbourside Building Supplies and Timber Co";
/** From this width up the page draws the panel; below it, the band. */
const PANEL_FROM = 768;

type Lang = "en" | "es" | "nl";
const dictionary = (file: "ui" | "public", lang: Lang): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${lang}/${file}.json`, import.meta.url)), "utf8"));
function word(dict: Record<string, string>, key: string, vars: Record<string, string | number> = {}): string {
  const v = dict[key];
  if (v === undefined) throw new Error(`dictionary has no ${key}`);
  return v.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}
const UI_EN = dictionary("ui", "en");
const PUBLIC: Record<Lang, Record<string, string>> = { en: dictionary("public", "en"), es: dictionary("public", "es"), nl: dictionary("public", "nl") };

// --- The seed, as data ------------------------------------------------------------------------------------------------------------------

interface Face {
  label: string;
  fill: string;
}
interface SponsorSeed {
  name: string;
  /** None: the sponsor has no link, so its slide has no anchor and no Visit. */
  url?: string;
  poster?: Face;
  logo?: Face;
  tier?: "title" | "gold";
}
const PANDYAS: SponsorSeed = { name: "Pandyas", url: "https://pandyas.example/", poster: { label: "Pandyas", fill: "#0f766e" } };
const RIDGE: SponsorSeed = { name: "Ridge Cycles", url: "https://ridge-cycles.example/", poster: { label: "Ridge Cycles", fill: "#1d4ed8" } };
const FENWICK: SponsorSeed = { name: "Fenwick Print", url: "https://fenwick.example/", poster: { label: "Fenwick Print", fill: "#b45309" } };
const MARINE: SponsorSeed = { name: "Harbourside Marine", url: "https://harbourside-marine.example/", poster: { label: "Harbourside Marine", fill: "#7e22ce" } };
const QUAY: SponsorSeed = { name: "Quay Fisheries", url: "https://quay-fisheries.example/", logo: { label: "QF", fill: "#0e7490" } };
const NORTHBANK: SponsorSeed = { name: "Northbank Print", url: "https://northbank.example/", poster: { label: "Northbank Print", fill: "#15803d" } };
const OLD_MILL: SponsorSeed = { name: "Old Mill Bakery", url: "https://old-mill.example/", tier: "gold" };
/** The long name with no link and no picture at all: the monogram card. */
const LONG_PLAIN: SponsorSeed = { name: LONG_SPONSOR };
/** The long name with a poster and a link: what the Spanish and Dutch pages show. */
const LONG_LINKED: SponsorSeed = { name: LONG_SPONSOR, url: "https://harbourside-building.example/", poster: { label: "Harbourside", fill: "#be123c" } };

interface CompSeed {
  name: string;
  sponsors: readonly SponsorSeed[];
  /** Open the registration of a division of it (the Register button in the hero). */
  registration?: true;
}
const COMPS = {
  three: { name: "Harbour Cup", sponsors: [PANDYAS, RIDGE, FENWICK] },
  one: { name: "Marine Open", sponsors: [MARINE] },
  logo: { name: "Quay Summer League", sponsors: [QUAY] },
  mono: { name: "Timber Trophy", sponsors: [LONG_PLAIN] },
  register: { name: "Northbank Open", sponsors: [NORTHBANK], registration: true },
  none: { name: "Old Mill Classic", sponsors: [OLD_MILL] },
} as const satisfies Record<string, CompSeed>;
type CompKey = keyof typeof COMPS;
const LOCALE_ORGS = {
  es: { orgName: "Club Deportivo del Puerto", comp: { name: "Copa del Puerto", sponsors: [LONG_LINKED] } },
  nl: { orgName: "Sportclub De Haven", comp: { name: "Havenbeker", sponsors: [LONG_LINKED] } },
} as const satisfies Record<string, { orgName: string; comp: CompSeed }>;
type LocaleKey = keyof typeof LOCALE_ORGS;

const logoSvg = (label: string, fill: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480"><circle cx="240" cy="240" r="220" fill="${fill}"/>` +
  `<text x="240" y="240" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="150" font-weight="700" fill="#ffffff">${label}</text></svg>`;

test.skip(!DIR, "opt-in: the e2e workflow's title_poster_captures input sets TITLE_POSTER_CAPTURE_DIR");
test.describe.configure({ mode: "serial" });

const shotPath = (state: State, width: number): string => join(DIR!, `${state}-${width}-tall.png`);
const phoneShotPath = (): string => join(DIR!, "band-320x568.png");

/** What the seed made, by competition: its slug, and its sponsors' ids in slide order. */
interface SeededComp {
  slug: string;
  sponsorIds: string[];
}
let main: SeededOrg;
const comps = {} as Record<CompKey, SeededComp>;
const localeOrgs = {} as Record<LocaleKey, { org: SeededOrg; comp: SeededComp }>;
/** Every stored picture's URL and the art the browser is given for it. */
const art: { url: string; svg: string }[] = [];
/** A sponsor's stored poster URL, by sponsor id. */
const posterOf = new Map<string, string>();
/** The wide picture the editor shot picks. */
let widePng: Buffer;
const seededOrgs: SeededOrg[] = [];

// --- Budgets (AGENTS.md class 20): a navigation, a tap or read, and the pictures arriving. -------------------------------------------------
const NAV_MS = 20_000;
const ACT_MS = 5_000;
const budget = (): void => test.setTimeout(4 * NAV_MS + 8 * ACT_MS);

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const ctx of opened.splice(0)) await ctx.close().catch(() => undefined);
});

async function newOrg(request: APIRequestContext, label: string, displayName: string, lang: Lang): Promise<SeededOrg> {
  const org = await seedSettingsOrg(request, { plan: "pro", label });
  seededOrgs.push(org);
  // A name a person would give a club, not the seed's: it is the line over the competition's name.
  await withDb((sql) => sql`update organizations set name = ${displayName} where id = ${org.orgId}`);
  if (lang !== "en") await setOrgLocaleSql(org.orgId, lang);
  return org;
}

async function addSponsor(request: APIRequestContext, org: SeededOrg, competitionId: string, s: SponsorSeed): Promise<string> {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const facePath = (kind: "poster" | "logo") => `assets/orgs/${org.orgId}/content/${kind}-${stamp}.png`;
  const poster = s.poster ? storagePublicUrl(facePath("poster")) : undefined;
  const logo = s.logo ? storagePublicUrl(facePath("logo")) : undefined;
  const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", {
    name: s.name,
    tier: s.tier ?? "title",
    competition_id: competitionId,
    ...(s.url ? { url: s.url } : {}),
    ...(poster ? { poster_path: poster } : {}),
    ...(logo ? { logo_path: logo } : {}),
  });
  expect(res.status, `${s.name}: ${JSON.stringify(res.error)}`).toBe(201);
  if (poster && s.poster) {
    art.push({ url: poster, svg: posterSvg(s.poster.label, s.poster.fill) });
    posterOf.set(res.data!.id, poster);
  }
  if (logo && s.logo) art.push({ url: logo, svg: logoSvg(s.logo.label, s.logo.fill) });
  return res.data!.id;
}

async function addComp(request: APIRequestContext, org: SeededOrg, seed: CompSeed): Promise<SeededComp> {
  const c = await seedCompetition(request, org.orgId, { name: seed.name, visibility: "public", status: "published" });
  const sponsorIds: string[] = [];
  // In slide order: the resolver orders equal rows by display_order, then creation, so the first made is slide 0.
  for (const s of seed.sponsors) sponsorIds.push(await addSponsor(request, org, c.id, s));
  if (seed.registration) {
    const division = await seedDivision(request, c.id, { name: "Open Division" });
    const reg = await apiJson(request, `/api/v1/divisions/${division.id}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "team",
      allow_free_agents: true,
      fee_cents: 0,
      approval: "auto",
    });
    expect(reg.status, `opening registration: ${JSON.stringify(reg.error)}`).toBeLessThan(300);
  }
  return { slug: c.slug, sponsorIds };
}

test.beforeAll(async ({ request, browser }) => {
  test.setTimeout(300_000);
  expect(LONG_SPONSOR.length, "premise: the realistic 43 characters").toBe(43);
  mkdirSync(DIR!, { recursive: true });
  main = await newOrg(request, "title-poster-capture", "Harbourside Sports Club", "en");
  for (const key of Object.keys(COMPS) as CompKey[]) comps[key] = await addComp(request, main, COMPS[key]);
  for (const key of Object.keys(LOCALE_ORGS) as LocaleKey[]) {
    const org = await newOrg(request, `title-poster-capture-${key}`, LOCALE_ORGS[key].orgName, key);
    localeOrgs[key] = { org, comp: await addComp(request, org, LOCALE_ORGS[key].comp) };
  }
  widePng = await posterPng(browser, 1920, 1080, "#334155", "1920 x 1080");
  expect(art.length, "the seed made pictures to give the browser").toBeGreaterThan(0);
});

test.afterAll(async ({ request }) => {
  // Newest first: each release hands the active org back to the one before it.
  for (const org of [...seededOrgs].reverse()) await releaseSettingsOrg(request, org).catch(() => undefined);
});

// --- Helpers ------------------------------------------------------------------------------------------------------------------------

/** A logged-out visitor with the consent banner answered (it would sit over the bottom of a phone) and reduced motion on, so nothing turns
 *  under the camera; every stored picture is answered with its art. */
async function visitorPage(browser: Browser, width: number, height: number = HEIGHT): Promise<Page> {
  const ctx = await browser.newContext({
    storageState: await consentedAnonymousState(),
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  opened.push(ctx);
  for (const a of art) await routePosterArt(ctx, a.url, { svg: a.svg });
  return ctx.newPage();
}
async function openHero(browser: Browser, width: number, orgSlug: string, compSlug: string, height: number = HEIGHT): Promise<Page> {
  const page = await visitorPage(browser, width, height);
  await page.goto(`/live/${orgSlug}/${compSlug}`, { waitUntil: "load" });
  return page;
}

const panelOf = (page: Page): Locator => page.getByTestId("mh-hero-poster");
const bandOf = (page: Page): Locator => page.getByTestId("mh-title-band");

/** The placement at this width: the showcase that is drawn (the band below 768, the panel from it), the other one hidden, and the one slide
 *  on show. */
async function placement(page: Page, width: number, what: string): Promise<{ showcase: Locator; current: Locator }> {
  const phone = width < PANEL_FROM;
  const showcase = phone ? bandOf(page) : panelOf(page);
  await expect(showcase, `${what}: the ${phone ? "band" : "panel"} carries the sponsor at ${width}`).toBeVisible();
  await expect(phone ? panelOf(page) : bandOf(page), `${what}: and the ${phone ? "panel" : "band"} steps aside`).toBeHidden();
  const current = showcase.locator('[data-testid="title-slide"][data-current="true"]');
  await expect(current, `${what}: exactly one slide is on show`).toHaveCount(1);
  return { showcase, current };
}

/** The picture is in the page and decoded, not a box waiting for its bytes. */
const arrived = (img: Locator, what: string) =>
  expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), { message: `${what}: the picture arrived`, timeout: NAV_MS })
    .toBe(true);

/** The name's own element: the band's sentence below 768, the panel's caption from it. */
const nameOf = (width: number, showcase: Locator, current: Locator): Locator =>
  width < PANEL_FROM ? current.getByTestId("title-band-sentence") : showcase.getByTestId("title-slide-caption");

/** A picture of the hero and, below 768, the band under it: the page from its top edge to a little below the last of them. */
async function heroShot(page: Page, file: string, width: number, what: string): Promise<void> {
  const hero = page.getByTestId("mh-hero");
  await expect(hero, `${what}: the hero is on the page`).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  const heroBox = (await hero.boundingBox())!;
  const band = bandOf(page);
  const bandBox = (await band.count()) > 0 && (await band.isVisible()) ? await band.boundingBox() : null;
  const bottom = Math.max(heroBox.y + heroBox.height, bandBox ? bandBox.y + bandBox.height : 0);
  await page.screenshot({ path: file, animations: "disabled", clip: { x: 0, y: 0, width, height: Math.min(HEIGHT, Math.ceil(bottom + 16)) } });
}

/** The witness first, at this width; then no horizontal page scroll; then the shot of the state's own region. */
async function regionShot(page: Page, file: string, what: string, region: Locator): Promise<void> {
  await expect(region, `${what}: its region is on the page`).toBeVisible();
  await expectNoHorizontalScroll(page);
  await region.screenshot({ path: file, animations: "disabled" });
}
/** A sponsor's own page: the page body below 768, a side panel from it. */
const pageRegion = (page: Page, width: number): Locator => (width >= PANEL_FROM ? page.getByRole("dialog") : page.getByTestId("sponsor-sheet-page"));

// --- The captures -------------------------------------------------------------------------------------------------------------------

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: HEIGHT } });

    test("three posters, the first on show", async ({ browser }) => {
      budget();
      const seeded = comps.three;
      const page = await openHero(browser, width, main.slug, seeded.slug);
      const { showcase, current } = await placement(page, width, "3 posters");
      await expect(showcase.getByTestId("title-showcase-dot"), "witness: one dot per sponsor").toHaveCount(COMPS.three.sponsors.length);
      await expect(current, "witness: the first sponsor is on show").toHaveAttribute("data-sponsor-id", seeded.sponsorIds[0]!);
      await expect(showcase.locator("[aria-live]"), "witness: reduced motion, so nothing turns by itself").toHaveAttribute("aria-live", "polite");
      const img = current.getByTestId("title-slide-poster");
      await expect.poll(() => img.getAttribute("src"), { message: "witness: it is the first sponsor's own poster the browser asked for" }).toContain(encodeURIComponent(posterOf.get(seeded.sponsorIds[0]!)!));
      await arrived(img, "the first poster");
      await heroShot(page, shotPath("hero-3-posters", width), width, "hero-3-posters");
    });

    test("one poster, no dots", async ({ browser }) => {
      budget();
      const seeded = comps.one;
      const page = await openHero(browser, width, main.slug, seeded.slug);
      const { showcase, current } = await placement(page, width, "1 poster");
      await expect(showcase.getByTestId("title-slide"), "witness: one sponsor, one slide").toHaveCount(1);
      await expect(showcase.getByTestId("title-showcase-dot"), "witness: one slide has no dots").toHaveCount(0);
      await expect(current.locator("a"), "witness: the linked sponsor's slide is one link").toHaveAttribute("href", `/s/${seeded.sponsorIds[0]}?src=site`);
      await arrived(current.getByTestId("title-slide-poster"), "the poster");
      await heroShot(page, shotPath("hero-1-poster", width), width, "hero-1-poster");
    });

    test("a logo and no poster: the logo on white", async ({ browser }) => {
      budget();
      const page = await openHero(browser, width, main.slug, comps.logo.slug);
      const { current } = await placement(page, width, "logo card");
      const card = current.getByTestId("title-slide-fallback");
      await expect(card, "witness: the card a sponsor without a poster gets").toBeVisible();
      await expect(current.getByTestId("title-slide-poster"), "witness: no poster on it").toHaveCount(0);
      await expect(card.getByTestId("title-slide-monogram"), "witness: it has a logo, so no monogram").toHaveCount(0);
      await arrived(card.locator("img"), "the logo");
      await heroShot(page, shotPath("hero-fallback-logo", width), width, "hero-fallback-logo");
    });

    test("a 43-character name, no logo, no poster, no link: the monogram card", async ({ browser }) => {
      budget();
      const page = await openHero(browser, width, main.slug, comps.mono.slug);
      const { showcase, current } = await placement(page, width, "monogram");
      await expect(current.getByTestId("title-slide-monogram"), "witness: the sponsor's initial").toHaveText(LONG_SPONSOR[0]!);
      await expect(current.getByTestId("title-slide-poster"), "witness: no poster").toHaveCount(0);
      await expect(current.locator("a"), "witness: no link, so no anchor").toHaveCount(0);
      await expect(showcase.getByTestId("title-band-visit"), "witness: and no Visit").toHaveCount(0);
      const name = nameOf(width, showcase, current);
      await expect(name, "witness: the name is shown whole, in the DOM and in its title").toHaveAttribute("title", width < PANEL_FROM ? word(PUBLIC.en, "landing.presentedBy", { sponsor: LONG_SPONSOR }) : LONG_SPONSOR);
      await heroShot(page, shotPath("hero-fallback-monogram-long", width), width, "hero-fallback-monogram-long");
    });

    for (const lang of ["es", "nl"] as const) {
      test(`the 43-character name on a ${lang} page`, async ({ browser }) => {
        budget();
        const seeded = localeOrgs[lang];
        const dict = PUBLIC[lang];
        // The pair of every translated witness below: it is NOT the English, so a page still in English would not satisfy it.
        expect(word(dict, "landing.presentedBy", { sponsor: "x" }), `${lang}: the sentence is translated`).not.toBe(word(PUBLIC.en, "landing.presentedBy", { sponsor: "x" }));
        const page = await openHero(browser, width, seeded.org.slug, seeded.comp.slug);
        const { showcase, current } = await placement(page, width, `${lang} long name`);
        const sentence = word(dict, "landing.presentedBy", { sponsor: LONG_SPONSOR });
        if (width < PANEL_FROM) {
          await expect(current.getByTestId("title-band-sentence"), `${lang}: the band's sentence is in ${lang}, with the whole name`).toHaveText(sentence);
          await expect(current.getByTestId("title-band-visit"), `${lang}: its Visit is in ${lang}`).toHaveText(word(dict, "titleSponsor.visit"));
        } else {
          await expect(page.getByTestId("mh-hero-sponsor"), `${lang}: the hero's sentence is in ${lang}`).toContainText(sentence);
          await expect(showcase.getByText(word(dict, "titleSponsor.kicker"), { exact: true }), `${lang}: the panel's label is in ${lang}`).toBeVisible();
          await expect(showcase.getByTestId("title-slide-caption"), `${lang}: the caption is the whole name`).toHaveText(LONG_SPONSOR);
        }
        await arrived(current.getByTestId("title-slide-poster"), `${lang} poster`);
        await heroShot(page, shotPath(lang === "es" ? "hero-long-name-es" : "hero-long-name-nl", width), width, `hero-long-name-${lang}`);
      });
    }

    test("registration open: the Register button beside the panel", async ({ browser }) => {
      budget();
      const page = await openHero(browser, width, main.slug, comps.register.slug);
      const { showcase } = await placement(page, width, "register");
      const register = page.getByTestId("mh-hero-register");
      await expect(register, "witness: registration is open, so the hero offers it").toBeVisible();
      await expect(register, "witness: in the words of the page").toHaveText(word(PUBLIC.en, "landing.register"));
      if (width >= PANEL_FROM) {
        const r = (await register.boundingBox())!;
        const p = (await showcase.boundingBox())!;
        const apart = r.x + r.width <= p.x + 1 || p.x + p.width <= r.x + 1 || r.y + r.height <= p.y + 1 || p.y + p.height <= r.y + 1;
        expect(apart, `witness: Register (${JSON.stringify(r)}) does not overlap the panel (${JSON.stringify(p)})`).toBe(true);
      }
      await heroShot(page, shotPath("hero-register-open", width), width, "hero-register-open");
    });

    test("no Title sponsor: the hero as it always was (the control)", async ({ browser }) => {
      budget();
      const page = await openHero(browser, width, main.slug, comps.none.slug);
      await expect(page.getByTestId("mh-hero"), "witness: the hero").toBeVisible();
      await expect(panelOf(page), "witness: no panel").toHaveCount(0);
      await expect(bandOf(page), "witness: no band").toHaveCount(0);
      await expect(page.getByTestId("mh-hero-sponsor"), "witness: no hero sentence").toHaveCount(0);
      await expect(page.locator('[class*="md:grid-cols-[minmax(0,1fr)_auto]"]'), "witness: the plain one-column hero").toHaveCount(0);
      // The pair: the page is not empty of sponsors, the gold one is on the board.
      await expect(page.getByText(OLD_MILL.name).first(), "witness: the competition's gold sponsor is on the page").toBeAttached();
      await heroShot(page, shotPath("hero-no-title", width), width, "hero-no-title");
    });

    test("the editor: a wide picture picked, its preview and the crop warning", async ({ page }) => {
      budget();
      const quay = comps.logo.sponsorIds[0]!;
      await page.goto(sponsorEditUrl(main.slug, quay));
      const region = pageRegion(page, width);
      const field = region.getByTestId("sponsor-poster-field");
      await expect(field, "witness: the editor is open with its Poster field").toBeVisible();
      const crop = field.getByTestId("sponsor-poster-crop");
      // A tap before React has attached is lost, not queued (AGENTS.md class 20): pick again until the warning is on screen. Picking the same
      // file twice is the same state, so the retry is safe.
      await expect(async () => {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 3_000 }), field.getByTestId("sponsor-poster-tile").click({ timeout: 3_000 })]);
        await chooser.setFiles({ name: "wide.png", mimeType: "image/png", buffer: widePng });
        await expect(crop, "witness: a 1920 x 1080 picture would lose 55 % of its width").toBeVisible({ timeout: 3_000 });
      }).toPass({ timeout: NAV_MS });
      await expect(crop, "witness: the warning says what is cut").toContainText("55");
      await expect(crop, "witness: in the words of the editor").toHaveText(word(UI_EN, "sponsors.poster.cropWidth", { percent: 55, width: 1080, height: 1350 }));
      await expect(field.getByTestId("sponsor-poster-remove"), "witness: a picked picture can be removed").toBeVisible();
      await arrived(field.getByTestId("sponsor-poster-tile").locator("img"), "the preview");
      await regionShot(page, shotPath("editor", width), `editor @${width}`, region);
    });

    test("the sponsor's page: the Poster row with a stored poster", async ({ page }) => {
      budget();
      const marine = comps.one.sponsorIds[0]!;
      const poster = posterOf.get(marine)!;
      // The thumbnail is a plain image of the stored URL (not the optimiser's): answer it with the poster's art.
      const svg = art.find((a) => a.url === poster)!.svg;
      await page.route((url) => url.href === poster, (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg }));
      await page.goto(sponsorUrl(main.slug, marine));
      const region = pageRegion(page, width);
      await expect(region.getByTestId("sponsor-sheet-name"), "witness: the sponsor's own page").toHaveText(MARINE.name);
      const row = region.getByTestId("sponsor-sheet-detail-poster");
      const thumb = row.getByTestId("sponsor-sheet-poster-thumb");
      await expect(thumb, "witness: the Poster row shows the stored poster").toHaveAttribute("src", poster);
      await expect(row, "witness: one Title poster row").toHaveCount(1);
      await arrived(thumb, "the thumbnail");
      await regionShot(page, shotPath("details", width), `details @${width}`, region);
    });
  });
}

test.describe("the band on a phone's real screen (320 x 568)", () => {
  test("the sponsor under the hero, as a person holding the phone sees it", async ({ browser }) => {
    budget();
    const page = await openHero(browser, 320, main.slug, comps.three.slug, 568);
    const { showcase, current } = await placement(page, 320, "band at 320 x 568");
    await expect(showcase.getByTestId("title-showcase-dot"), "witness: one dot per sponsor").toHaveCount(COMPS.three.sponsors.length);
    await arrived(current.getByTestId("title-slide-poster"), "the first poster");
    await expectNoHorizontalScroll(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    // Whether the band is on the first screen is what the owner is here to see: it is recorded, not asserted.
    const band = (await bandOf(page).boundingBox())!;
    const screen = page.viewportSize()!;
    console.log(`title poster captures: the band starts at y=${Math.round(band.y)} and ends at y=${Math.round(band.y + band.height)} on a ${screen.width} x ${screen.height} screen`);
    await page.screenshot({ path: phoneShotPath(), animations: "disabled" });
  });
});

test("anti-vacuity: every state at every width exists, is a PNG, and no two are identical", () => {
  const files = [...WIDTHS.flatMap((w) => STATES.map((s) => shotPath(s, w))), phoneShotPath()];
  const missing = files.filter((f) => !existsSync(f));
  expect(missing, "every capture was written").toEqual([]);
  const digests = new Map<string, string>();
  for (const f of files) {
    const bytes = readFileSync(f);
    expect(bytes.subarray(1, 4).toString("latin1"), `${f} is a PNG`).toBe("PNG");
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(digests.get(digest), `${f} is byte-identical to ${digests.get(digest)}`).toBeUndefined();
    digests.set(digest, f);
  }
  const expected = STATES.length * WIDTHS.length + 1;
  console.log(`title poster captures checked: ${files.length} (${STATES.length} states x ${WIDTHS.length} widths + 1 phone shot)`);
  expect(files.length, "the picture count is the one the header promises").toBe(expected);
  expect(digests.size).toBe(expected);
});
