// The Title sponsor's poster, end to end (spec 2026-11-11 "Title sponsor poster in the competition hero"): an organiser uploads a
// poster in the sponsor editor, a visitor sees it in the competition hero, taps it and is counted, a second Title sponsor rotates in,
// the organiser removes the poster, and a downgrade takes the whole placement away. Every step a PERSON does is a tap or a pick
// through the UI; setup (the org, the competition, the sponsors at the Title tier, the downgrade) goes through the API, and each
// result is read back off the system's own record (the sponsor row, the click rows) and off what a person sees (the public page).
//
// The ONE stand-in is storage, at the browser's boundary (helpers/poster-art.ts): the content-upload grant, the PUT, the GET of what
// was stored, and the `/_next/image` bytes for the poster. CI's storage host (`NEXT_PUBLIC_SUPABASE_URL=https://stub.supabase.co`)
// answers nothing, so the real grant would sign a URL on a real bucket and the real optimiser could never fetch the poster. The
// sponsor's own site is never reached either (helpers/sponsor-hop.ts: each `/s/` hop goes to the REAL server, which answers the 302
// and counts the click; the sponsor's page is handed back in its place).
//
//   W1   organiser, 1280: the sponsor's page, Edit, tap the Poster tile and choose a 1920 x 1080 PNG - the crop warning says 55 % of
//        the width goes; choose a 1080 x 1350 PNG instead - the warning is gone; Save - the row holds the stored url, and the
//        read-only page shows the thumbnail
//   W1b  organiser, 1280 / 768 / 320: the editor's Poster field with a stored poster, captured at each width (attached, never in the
//        repo); no sideways scroll; at 320 Remove is a 44px target that a tap would reach
//   W2   visitor, 1280: the panel, the poster in it (its src names the stored url, it arrived), the hero sentence with no picture
//   W3   visitor taps the poster: the real /s/ route answers 302 to exactly the sponsor's url, the new tab shows the sponsor's page,
//        and one `site` click is on record
//   W4   visitor, 320: the band, Visit is a 44px target, tapped: a second `site` click
//   W5   the poster fails to load (storage answers 404): the logo card takes its place and no broken picture is drawn
//   W5b  a poster on a host the optimiser does not allow, against the REAL optimiser in the production build: the same card (SKIPS, loudly
//        and by name, unless E2E_PROD_TARGET is set: a dev server throws on an unconfigured host while rendering)
//   W6   a second Title sponsor (a logo, no link): the showcase turns every 6 s (the page's clock driven), B has no link, a hovering
//        mouse pauses it, a dot tap stops it for the page view, reduced motion never starts it
//   W7   organiser: Remove poster, Save - the row reads null, and the visitor's page shows the logo card
//   W8   both sponsors downgraded to partner over the API: no panel, no band, no hero sentence, the hero's grid is the plain one, and
//        the poster is still on the row (a downgrade takes the placement away, never the picture)
//
// NOT DRIVEN, named plainly: the storage bucket's own refusal of an oversize object (413, a stand-in answers 200), and the browser's
// paint of the crossfade (it is a CSS transition; the data-current attribute is what is asserted).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { PROD_TARGET, apiJson, expectNoHorizontalScroll, withDb } from "../helpers";
import {
  releaseSettingsOrg,
  seedCompetition,
  seedSettingsOrg,
  sponsorEditUrl,
  sponsorUrl,
  tapUntil,
  type SeededCompetition,
  type SeededOrg,
} from "../settings-support";
import { HIT_TARGET_FLOOR_PX, consentedAnonymousState } from "../scorepad-a11y-kit";
import { posterPng, posterSvg, routePosterArt, standInStorage, storagePublicUrl } from "../helpers/poster-art";
import { SPONSOR_PAGE_TITLE, realSponsorHop } from "../helpers/sponsor-hop";
import { TITLE_ROTATE_MS } from "../../src/lib/sponsor-poster";

// --- copy, read from the dictionary the editor renders from --------------------------------------------------------------------
const EN_UI: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
const say = (key: string, vars: Record<string, string | number> = {}): string => {
  const v = EN_UI[key];
  if (v === undefined) throw new Error(`no dictionary entry ${key}`);
  return v.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
};

// --- the clocks (AGENTS.md #20; walkthrough README "What they cost") -----------------------------------------------------------
/** A navigation, a tap or read, and a read that waits for the server's cache to be told (the sponsor writes expire it in the request). */
const NAV_MS = 20_000;
const ACT_MS = 5_000;
const READ_MS = 30_000;
/** How long each sponsor stays up, from the product's own constant, so changing it moves every drive below. A turn is driven a little past
 *  one period: the interval fires once per period, and half a period of slack cannot make it fire twice. */
const ROTATE_MS = TITLE_ROTATE_MS;
const PAST_ONE_TURN_MS = ROTATE_MS + ROTATE_MS / 12;

// --- the people and things ----------------------------------------------------------------------------------------------------
const A = { name: "Pandyas", url: "https://pandyas.example/title", id: "" };
const B = { name: "Ridge Cycles", id: "", logo: "" };
/** What 1920 x 1080 loses in a 4:5 box (spec section 11): the box shows 4/5 of the height as width, 864 of 1920 columns = 45 %, so 55 % goes. */
const CROP_WIDTH_PERCENT = 55;
const POSTER_FILL = "#0f766e";
/** Visitors have addresses of their own: a click is counted once per address (the redirect's dedupe window). */
const IP_W3 = "198.51.100.71";
const IP_W4 = "198.51.100.72";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 900 } });

let org: SeededOrg;
let comp: SeededCompetition;
let publicUrl = "";
/** The url the editor stored for A's poster, as the stand-in storage issued it (W1). */
let storedPoster = "";

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const ctx of opened.splice(0)) await ctx.close().catch(() => undefined);
});

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000);
  org = await seedSettingsOrg(request, { plan: "pro", label: "title-poster" });
  comp = await seedCompetition(request, org.orgId, { name: `Pandyas Cup ${Date.now().toString(36)}`, visibility: "public", status: "published" });
  publicUrl = `/live/${org.slug}/${comp.slug}`;
  const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", {
    name: A.name,
    url: A.url,
    tier: "title",
    competition_id: comp.id,
  });
  expect(made.status, `A: ${JSON.stringify(made.error)}`).toBe(201);
  A.id = made.data!.id;
});

test.afterAll(async ({ request }) => {
  // The org goes with everything in it: both competitions, every sponsor, the click rows.
  if (org) await releaseSettingsOrg(request, org).catch(() => undefined);
});

// --- helpers ------------------------------------------------------------------------------------------------------------------
interface Visitor {
  ctx: BrowserContext;
  page: Page;
}
/** A logged-out visitor with the consent banner answered (it would sit over the bottom of a phone), an address of their own when asked,
 *  and the context closed after the test (a `finally` never runs on a timeout). */
async function visitor(
  browser: Browser,
  opts: { width: number; ip?: string; reducedMotion?: boolean; height?: number },
): Promise<Visitor> {
  const ctx = await browser.newContext({
    storageState: await consentedAnonymousState(),
    viewport: { width: opts.width, height: opts.height ?? 900 },
    ...(opts.ip ? { extraHTTPHeaders: { "fly-client-ip": opts.ip } } : {}),
    ...(opts.reducedMotion ? { reducedMotion: "reduce" as const } : {}),
  });
  opened.push(ctx);
  return { ctx, page: await ctx.newPage() };
}

const panelOf = (page: Page): Locator => page.getByTestId("mh-hero-poster");
const bandOf = (page: Page): Locator => page.getByTestId("mh-title-band");
const currentSlide = (showcase: Locator): Locator => showcase.locator('[data-testid="title-slide"][data-current="true"]');
const slideOf = (showcase: Locator, id: string): Locator => showcase.locator(`[data-testid="title-slide"][data-sponsor-id="${id}"]`);
/** The hero's two-column grid class, present only while the page has a Title sponsor to show. */
const heroGrid = (page: Page): Locator => page.locator('[class*="md:grid-cols-[minmax(0,1fr)_auto]"]');

/** A sponsor's page, as the sheet shows it: a dialog from 768, the page body below it. */
const sheetOf = (page: Page, width: number): Locator => (width >= 768 ? page.getByRole("dialog") : page.getByTestId("sponsor-sheet-page"));

const clicksOf = (sponsorId: string) =>
  withDb((sql) => sql<{ source: string }[]>`select source from sponsor_clicks where sponsor_id = ${sponsorId} order by at, id`).then((rows) =>
    rows.map((r) => ({ source: r.source })),
  );
const posterOf = (sponsorId: string) =>
  withDb((sql) => sql<{ poster_path: string | null }[]>`select poster_path from sponsors where id = ${sponsorId}`).then((rows) => rows[0]?.poster_path);

/** A shot of `region`, written under the run's output directory and attached to the report (never into the repo). Returns its bytes so the
 *  caller can hold the set of shots to "all exist, all differ" (AGENTS.md class 10). */
async function shot(testInfo: TestInfo, name: string, region: Locator): Promise<Buffer> {
  const path = testInfo.outputPath(`${name}.png`);
  const bytes = await region.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
  return bytes;
}

/** React has attached to `el`: a tap before that is lost, not queued (AGENTS.md class 20), and a timer armed by an effect does not exist. */
const hydrated = (el: Locator, why: string) =>
  expect.poll(() => el.evaluate((node) => Object.keys(node).some((k) => k.startsWith("__reactProps$"))), { message: why, timeout: NAV_MS }).toBe(true);

/** React schedules a render, and then the passive effects that arm a timer, through MessageChannel tasks (the scheduler's own channel, which the
 *  page clock does not fake). A page-side round trip through a channel of our own queues behind whatever React already posted, so awaiting
 *  it is "the work React had pending has run". One hop per stage - the render, the effects, and the render an effect's own state change
 *  asks for - so the count is the number of stages, not a time. */
const REACT_STAGES = 3;
const drainReactQueue = (page: Page): Promise<void> =>
  page.evaluate(async (stages) => {
    for (let i = 0; i < stages; i++) {
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          resolve();
        };
        channel.port2.postMessage(null);
      });
    }
  }, REACT_STAGES);

/** Choose `buffer` in the Poster field the way a person does: tap the tile, answer the file chooser it opens. */
async function pickPoster(page: Page, field: Locator, name: string, buffer: Buffer): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), field.getByTestId("sponsor-poster-tile").click()]);
  await chooser.setFiles({ name, mimeType: "image/png", buffer });
}

test("W1 organiser: pick a wide picture and read the crop warning, pick a 4:5 one instead, Save - the row holds the stored url and the page shows the thumbnail", async ({ page, browser }) => {
  test.setTimeout(6 * NAV_MS + 12 * ACT_MS);
  const { issued } = await standInStorage(page, org.orgId);
  const wide = await posterPng(browser, 1920, 1080, "#334155");
  const exact = await posterPng(browser, 1080, 1350, POSTER_FILL);
  expect(wide.equals(exact), "premise: the two pictures are different files").toBe(false);

  await page.goto(sponsorUrl(org.slug, A.id));
  const sheet = sheetOf(page, 1280);
  await expect(sheet.getByTestId("sponsor-sheet-name")).toHaveText(A.name);
  await expect(sheet.getByTestId("sponsor-sheet-detail-poster"), "premise: no poster yet").toContainText(say("sponsors.sheet.noPoster"));
  await tapUntil(sheet.getByTestId("sponsor-sheet-edit"), sheet.getByTestId("sponsor-poster-field"), "Edit opens the editor, with its Poster field");
  const field = sheet.getByTestId("sponsor-poster-field");
  await expect(field.getByTestId("sponsor-poster-remove"), "premise: nothing to remove before a pick").toHaveCount(0);

  await pickPoster(page, field, "wide.png", wide);
  await expect(field.getByTestId("sponsor-poster-crop"), "a 1920 x 1080 picture would lose 55 % of its width").toHaveText(
    say("sponsors.poster.cropWidth", { percent: CROP_WIDTH_PERCENT, width: 1080, height: 1350 }),
  );
  await expect(field.getByTestId("sponsor-poster-remove"), "the pick is on the tile: Remove is offered").toBeVisible();

  await pickPoster(page, field, "exact.png", exact);
  await expect(field.getByTestId("sponsor-poster-crop"), "a 1080 x 1350 picture loses nothing: the warning is gone").toHaveCount(0);

  const [saved] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/v1/orgs/${org.orgId}/sponsors/${A.id}`,
      { timeout: NAV_MS },
    ),
    sheet.getByRole("button", { name: say("sponsors.save"), exact: true }).click(),
  ]);
  expect(saved.status(), `PATCH answered ${saved.status()}: ${await saved.text()}`).toBe(200);
  expect(Object.keys(saved.request().postDataJSON() as object), "the save carries the poster and nothing else").toEqual(["poster_path"]);

  // A pick is never an upload: the first picture was dropped for the second, and only a Save asks storage for a place to put one.
  expect(issued.length, "one upload: the picture that was saved, not the one that was replaced").toBe(1);
  storedPoster = issued[0]!;
  expect(await posterOf(A.id), "the row holds exactly the url storage issued").toBe(storedPoster);

  const thumb = sheet.getByTestId("sponsor-sheet-poster-thumb");
  await expect(thumb, "the read-only page shows the poster's thumbnail").toBeVisible();
  await expect(thumb).toHaveAttribute("src", storedPoster);
  await expect.poll(() => thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth), { message: "the thumbnail arrived", timeout: NAV_MS }).toBeGreaterThan(0);
});

test("W1b organiser: the Poster field with a stored poster at 1280, 768 and 320 - captured, no sideways scroll, and at 320 Remove is a 44px target a tap reaches", async ({ page }, testInfo) => {
  test.setTimeout(5 * NAV_MS + 15 * ACT_MS);
  expect(storedPoster, "W1 stored a poster").not.toBe("");
  await standInStorage(page, org.orgId);
  const shots = new Map<number, Buffer>();
  // The field's own measured width at each viewport: the sheet is a side dialog from 768 up (`modal.tsx`: `w-full md:max-w-lg`, 512px, with no
  // `lg:` rule), so 1280 and 768 draw the SAME 512px sheet and an element shot of the field is pixel-identical at the two (CI e2e 43103487857:
  // "every width's shot differs", Expected 3, Received 2). Below 768 the page is the phone body, a different layout. The check therefore
  // asks for what is true: the states opened and the phone layout differs, and two widths may match only when they measure the same.
  const fieldWidths = new Map<number, number>();
  for (const width of [1280, 768, 320] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(sponsorEditUrl(org.slug, A.id));
    const field = sheetOf(page, width).getByTestId("sponsor-poster-field");
    await expect(field, `${width}: the editor is open with its Poster field`).toBeVisible();
    const remove = field.getByTestId("sponsor-poster-remove");
    await expect(remove, `${width}: a stored poster is on the tile, so Remove is offered`).toBeVisible();
    const tileImg = field.getByTestId("sponsor-poster-tile").locator("img");
    await expect(tileImg, `${width}: the tile shows the stored poster`).toHaveAttribute("src", storedPoster);
    // The capture is of the picture, not of an empty tile still waiting for its bytes: a shot taken before it decoded would differ by width
    // anyway (the layout moves) and pass the all-differ check on the wrong evidence.
    await expect
      .poll(() => tileImg.evaluate((img) => (img as HTMLImageElement).naturalWidth), { message: `${width}: the tile's picture arrived`, timeout: NAV_MS })
      .toBeGreaterThan(0);
    await remove.scrollIntoViewIfNeeded();
    const reach = await remove.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { width: r.width, height: r.height, hit: at !== null && (at === el || el.contains(at)) };
    });
    expect(reach.hit, `${width}: a tap at Remove's centre lands on Remove`).toBe(true);
    if (width < 768) {
      expect(reach.height, `${width}: Remove is ${HIT_TARGET_FLOOR_PX}px tall`).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
      expect(reach.width, `${width}: and ${HIT_TARGET_FLOOR_PX}px wide`).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
    }
    await expectNoHorizontalScroll(page);
    const box = await field.boundingBox();
    expect(box, `${width}: the field has a box to measure`).not.toBeNull();
    fieldWidths.set(width, Math.round(box!.width));
    shots.set(width, await shot(testInfo, `poster-field-${width}`, field));
  }
  // A capture that errored before a shot, or a state that never opened, cannot pass: three shots, each with pixels, and the phone layout
  // is not the desktop one.
  expect(shots.size, "shots taken").toBe(3);
  for (const [width, bytes] of shots) expect(bytes.length, `${width}: the shot has pixels`).toBeGreaterThan(1_000);
  const digest = (width: number): string => createHash("sha256").update(shots.get(width)!).digest("hex");
  const widthsNote = `field widths: 1280 -> ${fieldWidths.get(1280)}px, 768 -> ${fieldWidths.get(768)}px, 320 -> ${fieldWidths.get(320)}px`;
  expect(digest(320), `the 320 shot differs from the 1280 shot: the phone layout is its own (${widthsNote})`).not.toBe(digest(1280));
  // 768 may equal 1280 only when the field measured the same at both (the same 512px sheet); a different width with the same pixels is a
  // capture that did not open the state it names.
  if (fieldWidths.get(768) !== fieldWidths.get(1280)) {
    expect(digest(768), `the 768 shot differs from the 1280 shot, the field being a different width (${widthsNote})`).not.toBe(digest(1280));
  }
});

test("W2 visitor, 1280: the panel carries the poster (its src names the stored url and it arrived), the hero sentence has no picture", async ({ browser }, testInfo) => {
  test.setTimeout(4 * NAV_MS + 10 * ACT_MS);
  expect(storedPoster, "W1 stored a poster").not.toBe("");
  const v = await visitor(browser, { width: 1280 });
  await routePosterArt(v.ctx, storedPoster, { svg: posterSvg(A.name, POSTER_FILL) });
  const panel = panelOf(v.page);
  const img = currentSlide(panel).getByTestId("title-slide-poster");
  // The first read after a write: the server's cache was told in the request that saved it, so this is a bounded wait, not a retry loop.
  await expect(async () => {
    await v.page.goto(publicUrl, { waitUntil: "load" });
    await expect(img, "the Title sponsor's poster is in the panel").toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: READ_MS });
  await expect(v.page.getByTestId("mh-title-band"), "the phone band is not drawn at 1280").toBeHidden();
  await expect(panel.getByTestId("title-slide-caption"), "the sponsor's name sits under it").toHaveText(A.name);
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).currentSrc), { message: "the browser asked the optimiser for the stored poster" }).toContain(
    encodeURIComponent(storedPoster),
  );
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { message: "the poster arrived" }).toBeGreaterThan(0);
  expect(await img.getAttribute("alt"), "the poster is in a link that names the sponsor, so it has no alt of its own").toBe("");
  await expect(currentSlide(panel).locator("a"), "the poster is a link").toHaveAttribute("href", `/s/${A.id}?src=site`);

  const sentence = v.page.getByTestId("mh-hero-sponsor");
  await expect(sentence, "the hero keeps its sentence for the sponsor").toContainText(A.name);
  await expect(sentence.locator("img"), "and the sentence has no picture: the poster is the image").toHaveCount(0);
  await expect(heroGrid(v.page), "the hero is in its two-column grid while there is a Title sponsor").toHaveCount(1);
  await expectNoHorizontalScroll(v.page);
  await shot(testInfo, "visitor-panel-1280", panel);
});

test("W3 visitor taps the poster: the real /s/ route answers 302 to exactly the sponsor's url, the new tab shows its page, one site click is on record", async ({ browser }) => {
  test.setTimeout(4 * NAV_MS + 8 * ACT_MS);
  const v = await visitor(browser, { width: 1280, ip: IP_W3 });
  await routePosterArt(v.ctx, storedPoster, { svg: posterSvg(A.name, POSTER_FILL) });
  const tapped = await realSponsorHop(v.ctx, `/s/${A.id}`);
  await v.page.goto(publicUrl, { waitUntil: "load" });
  const poster = currentSlide(panelOf(v.page)).locator("a");
  await expect(poster).toBeVisible({ timeout: READ_MS });
  expect(await clicksOf(A.id), "premise: no click yet").toEqual([]);
  const [tab] = await Promise.all([v.ctx.waitForEvent("page"), poster.click()]);
  const hop = await tapped.hop;
  const asked = new URL(hop.url);
  expect(asked.pathname + asked.search, "the poster's own href: this sponsor, the competition page").toBe(`/s/${A.id}?src=site`);
  expect(hop.status, "the real /s/ route redirects").toBe(302);
  expect(hop.location, "to exactly the url the sponsor was created with").toBe(A.url);
  await expect(tab, "the new tab shows what the sponsor's url answered").toHaveTitle(SPONSOR_PAGE_TITLE);
  await expect.poll(() => clicksOf(A.id), { message: "one click, from the site", timeout: READ_MS }).toEqual([{ source: "site" }]);
});

test("W4 visitor, 320: the band's Visit is a 44px target and a tap counts a second site click", async ({ browser }, testInfo) => {
  test.setTimeout(4 * NAV_MS + 8 * ACT_MS);
  const v = await visitor(browser, { width: 320, height: 568, ip: IP_W4 });
  await routePosterArt(v.ctx, storedPoster, { svg: posterSvg(A.name, POSTER_FILL) });
  const tapped = await realSponsorHop(v.ctx, `/s/${A.id}`);
  await v.page.goto(publicUrl, { waitUntil: "load" });
  const band = bandOf(v.page);
  await expect(band, "below 768 the band carries the sponsor").toBeVisible({ timeout: READ_MS });
  await expect(panelOf(v.page), "and the panel is not drawn").toBeHidden();
  await expect(v.page.getByTestId("mh-hero-sponsor"), "nor the hero's sentence").toBeHidden();
  const visit = currentSlide(band).getByTestId("title-band-visit");
  await visit.scrollIntoViewIfNeeded();
  const reach = await visit.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { width: r.width, height: r.height, hit: at !== null && (at === el || el.contains(at) || (at.closest("a")?.contains(el) ?? false)) };
  });
  expect(reach.hit, "a tap at Visit's centre lands on Visit (or the link around it)").toBe(true);
  expect(reach.height, "Visit is 44px tall").toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
  expect(reach.width, "and 44px wide").toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
  await expectNoHorizontalScroll(v.page);
  await shot(testInfo, "visitor-band-320", band);

  const [tab] = await Promise.all([v.ctx.waitForEvent("page"), visit.click()]);
  const hop = await tapped.hop;
  expect(hop.status, "the real /s/ route redirects").toBe(302);
  expect(hop.location, "to exactly the url the sponsor was created with").toBe(A.url);
  await expect(tab).toHaveTitle(SPONSOR_PAGE_TITLE);
  await expect
    .poll(() => clicksOf(A.id), { message: "a second click, from another address", timeout: READ_MS })
    .toEqual([{ source: "site" }, { source: "site" }]);
});

test("W5 the poster fails to load: the logo card takes its place and no broken picture is drawn", async ({ browser }, testInfo) => {
  test.setTimeout(4 * NAV_MS + 8 * ACT_MS);
  const v = await visitor(browser, { width: 1280 });
  // Storage answers 404 for the poster the row holds. The page was served with the poster in its markup: only the browser can know it failed.
  await routePosterArt(v.ctx, storedPoster, { status: 404 });
  await v.page.goto(publicUrl, { waitUntil: "load" });
  const panel = panelOf(v.page);
  const card = currentSlide(panel).getByTestId("title-slide-fallback");
  await expect(card, "the card a sponsor without a poster gets").toBeVisible({ timeout: READ_MS });
  await expect(currentSlide(panel).getByTestId("title-slide-poster"), "and the failed poster is gone from the slide").toHaveCount(0);
  await expect(card.getByTestId("title-slide-monogram"), "no logo on file: the sponsor's initial").toHaveText(A.name[0]!);
  await shot(testInfo, "visitor-panel-fallback-1280", panel);
});

// A skip is only honest if someone SEES it (the idiom of settings-sponsor-monetize.spec.ts): the summary prints "1 skipped" with no reason,
// and nothing else in the suite sends a poster to the real optimiser, so say what was not exercised, once, at collection time.
const W5B_SKIP = "needs the production build's real /_next/image: a dev server throws on a host outside images.remotePatterns while it renders the page, and its optimiser is not the one that ships. Set E2E_PROD_TARGET=1 and run against `next start`.";
if (!PROD_TARGET) {
  console.warn(`\n  ⚠ title-sponsor-poster W5b SKIPPED - the real optimiser's refusal of an unconfigured poster host was NOT exercised.\n    ${W5B_SKIP}\n`);
}
test("W5b a poster on a host the optimiser does not allow falls back to the same card, against the real optimiser", async ({ browser, request }) => {
  test.skip(!PROD_TARGET, `W5b ${W5B_SKIP}`);
  test.setTimeout(6 * NAV_MS + 10 * ACT_MS);
  // No stand-in here at all: the production build's own `/_next/image` refuses a host outside `images.remotePatterns` (a 400), and
  // the sponsor API accepts any http(s) poster, so this is the page's one defence for a poster that can never load (spec D14).
  const second = await seedCompetition(request, org.orgId, { name: `Unconfigured host ${Date.now().toString(36)}`, visibility: "public", status: "published" });
  const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", {
    name: "Fenwick Print",
    tier: "title",
    competition_id: second.id,
    poster_path: "https://poster-host-unconfigured.example/fenwick.png",
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const v = await visitor(browser, { width: 1280 });
  await v.page.goto(`/live/${org.slug}/${second.slug}`, { waitUntil: "load" });
  const panel = panelOf(v.page);
  await expect(panel, "the page has a Title sponsor's panel").toBeVisible({ timeout: READ_MS });
  await expect(currentSlide(panel).getByTestId("title-slide-fallback"), "the optimiser refused the host: the logo card").toBeVisible({ timeout: READ_MS });
  await expect(currentSlide(panel).getByTestId("title-slide-poster")).toHaveCount(0);
  await expect(currentSlide(panel).getByTestId("title-slide-monogram")).toHaveText("F");
});

test("W6 two Title sponsors rotate: a turn every period, none for a sponsor with no link, a hover pauses, a dot tap stops it, reduced motion never starts it", async ({ browser, request }) => {
  test.setTimeout(8 * NAV_MS + 25 * ACT_MS);
  // B: a logo and no link. The resolver orders competition-scoped rows first, then by tier, display_order and created_at: A and B are both
  // scoped to this competition at the same tier, and A was created first (display_order is max + 1), so A is in front.
  B.logo = storagePublicUrl(`assets/orgs/${org.orgId}/content/logo-ridge-${Date.now().toString(36)}.png`);
  const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", {
    name: B.name,
    tier: "title",
    competition_id: comp.id,
    logo_path: B.logo,
  });
  expect(made.status, `B: ${JSON.stringify(made.error)}`).toBe(201);
  B.id = made.data!.id;
  const art = async (ctx: BrowserContext) => {
    await routePosterArt(ctx, storedPoster, { svg: posterSvg(A.name, POSTER_FILL) });
    await routePosterArt(ctx, B.logo, { svg: posterSvg(B.name, "#1d4ed8") });
  };

  // The page's own clock is driven, so a turn is a call and not a six-second wait. Installed before the page exists, so every timer the
  // showcase arms is a fake one; paused once React has attached, so none fires between the reads below.
  const v = await visitor(browser, { width: 1280 });
  await art(v.ctx);
  await v.page.clock.install();
  await v.page.goto(publicUrl, { waitUntil: "load" });
  const panel = panelOf(v.page);
  const showcase = panel.getByTestId("title-showcase");
  const current = currentSlide(panel);
  const live = showcase.locator("[aria-live]");
  const dots = showcase.getByTestId("title-showcase-dot");
  await expect(async () => {
    // A read right after B's creation can still be the cached one-sponsor page: ask again until the server serves both.
    await v.page.reload({ waitUntil: "load" });
    await expect(panel.getByTestId("title-slide"), "both Title sponsors are slides").toHaveCount(2, { timeout: 3_000 });
  }).toPass({ timeout: READ_MS });
  await hydrated(showcase, "the showcase has hydrated, so its timer exists");
  await v.page.clock.pauseAt((await v.page.evaluate(() => Date.now())) + 1_000);
  await expect(dots, "one dot per sponsor").toHaveCount(2);
  await expect(current, "A is first").toHaveAttribute("data-sponsor-id", A.id);
  await expect(live, "rotating: the box says it is not a live region").toHaveAttribute("aria-live", "off");

  // A turn: B is up, and B (no link) is not an anchor.
  await v.page.clock.runFor(PAST_ONE_TURN_MS);
  await expect(current, "after one period B is up").toHaveAttribute("data-sponsor-id", B.id);
  await expect(slideOf(panel, B.id).locator("a"), "B has no link, so no anchor").toHaveCount(0);
  await expect(slideOf(panel, A.id).locator("a"), "A has one").toHaveCount(1);

  // A hovering mouse pauses it: two whole periods go by and B stays up.
  await panel.hover();
  await expect(live, "paused: the box now announces its changes").toHaveAttribute("aria-live", "polite");
  await v.page.clock.runFor(2 * ROTATE_MS);
  await expect(current, "a hover holds the showcase").toHaveAttribute("data-sponsor-id", B.id);
  // The mouse leaves: it starts again, from the moment it left.
  await v.page.mouse.move(0, 0);
  await expect(live, "the mouse left: rotating again").toHaveAttribute("aria-live", "off");
  await v.page.clock.runFor(PAST_ONE_TURN_MS);
  await expect(current, "after the mouse left, one period brings A back").toHaveAttribute("data-sponsor-id", A.id);

  // A tap on B's dot takes over for the page view. The mouse is moved away first, so "stopped" is the only thing holding it: a rotation
  // that merely paused on hover would turn on the next period.
  await dots.nth(1).click();
  await expect(current, "the dot shows B").toHaveAttribute("data-sponsor-id", B.id);
  await v.page.mouse.move(0, 0);
  await expect(live, "stopped, not merely paused: no hover, and the box announces its changes").toHaveAttribute("aria-live", "polite");
  // "Polite" reads the same before and after the pointer-leave is handled (hovered and stopped both give it), so no DOM signal says React
  // has taken the leave in. A rotation that was only PAUSED re-arms its timer on that render, and a runFor that beat the render would pass
  // for the wrong reason: the page's own task queue is drained instead (no wall-clock wait, and nothing the paused page clock fakes).
  await drainReactQueue(v.page);
  await v.page.clock.runFor(5 * ROTATE_MS);
  await expect(current, "five periods after a dot tap, B is still up").toHaveAttribute("data-sponsor-id", B.id);

  // Reduced motion: it never starts, and the dots still work.
  const calm = await visitor(browser, { width: 1280, reducedMotion: true });
  await art(calm.ctx);
  await calm.page.clock.install();
  await calm.page.goto(publicUrl, { waitUntil: "load" });
  const calmPanel = panelOf(calm.page);
  await expect(calmPanel.getByTestId("title-slide")).toHaveCount(2);
  await hydrated(calmPanel.getByTestId("title-showcase"), "the calm showcase has hydrated");
  await calm.page.clock.pauseAt((await calm.page.evaluate(() => Date.now())) + 1_000);
  await expect(calmPanel.locator("[aria-live]"), "reduced motion: nothing rotates by itself").toHaveAttribute("aria-live", "polite");
  await expect(currentSlide(calmPanel), "A is first").toHaveAttribute("data-sponsor-id", A.id);
  await calm.page.clock.runFor(5 * ROTATE_MS);
  await expect(currentSlide(calmPanel), "five periods on, still A").toHaveAttribute("data-sponsor-id", A.id);
  await calmPanel.getByTestId("title-showcase-dot").nth(1).click();
  await expect(currentSlide(calmPanel), "a dot tap still moves it: the visitor is the one moving it").toHaveAttribute("data-sponsor-id", B.id);
});

test("W7 organiser: Remove poster, Save - the row reads null and the visitor's page shows the logo card", async ({ page, browser }) => {
  test.setTimeout(6 * NAV_MS + 12 * ACT_MS);
  await standInStorage(page, org.orgId);
  expect(await posterOf(A.id), "premise: A still holds its poster").toBe(storedPoster);
  await page.goto(sponsorUrl(org.slug, A.id));
  const sheet = sheetOf(page, 1280);
  await tapUntil(sheet.getByTestId("sponsor-sheet-edit"), sheet.getByTestId("sponsor-poster-field"), "Edit opens the editor");
  const field = sheet.getByTestId("sponsor-poster-field");
  await expect(field.getByTestId("sponsor-poster-tile").locator("img"), "the tile shows the stored poster").toHaveAttribute("src", storedPoster);
  await field.getByTestId("sponsor-poster-remove").click();
  await expect(field.getByTestId("sponsor-poster-remove"), "removed: the tile is empty and Remove is gone").toHaveCount(0);
  await expect(field.getByTestId("sponsor-poster-tile").locator("img"), "and the tile no longer shows a picture").toHaveCount(0);
  const [saved] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/v1/orgs/${org.orgId}/sponsors/${A.id}`,
      { timeout: NAV_MS },
    ),
    sheet.getByRole("button", { name: say("sponsors.save"), exact: true }).click(),
  ]);
  expect(saved.status(), `PATCH answered ${saved.status()}: ${await saved.text()}`).toBe(200);
  expect(saved.request().postDataJSON(), "the save says the poster is gone, and nothing else").toEqual({ poster_path: null });
  await expect.poll(() => posterOf(A.id), { message: "the row reads null", timeout: READ_MS }).toBeNull();
  await expect(sheet.getByTestId("sponsor-sheet-detail-poster"), "the page says the logo shows instead").toContainText(say("sponsors.sheet.noPoster"));

  // The visitor: A's slide is the card a sponsor without a poster gets. Reduced motion, so A is the one on show while it is read.
  const v = await visitor(browser, { width: 1280, reducedMotion: true });
  await routePosterArt(v.ctx, B.logo, { svg: posterSvg(B.name, "#1d4ed8") });
  const panel = panelOf(v.page);
  const slideA = slideOf(panel, A.id);
  await expect(async () => {
    await v.page.goto(publicUrl, { waitUntil: "load" });
    await expect(slideA.getByTestId("title-slide-fallback"), "A shows the logo card").toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: READ_MS });
  await expect(slideA.getByTestId("title-slide-poster"), "and no poster").toHaveCount(0);
  await expect(slideOf(panel, B.id), "B is untouched: still a slide").toHaveCount(1);
});

test("W8 both sponsors downgraded to partner: no panel, no band, no hero sentence, the plain hero grid, and the poster still on the row", async ({ browser, request }) => {
  test.setTimeout(5 * NAV_MS + 12 * ACT_MS);
  // W7 removed A's poster, so a "the poster survives" check would compare null with null. Put one back (setup, over the API) so the row
  // holds a value the downgrade could destroy.
  const restored = await apiJson<{ poster_path: string | null }>(request, `/api/v1/orgs/${org.orgId}/sponsors/${A.id}`, "PATCH", { poster_path: storedPoster });
  expect(restored.status, JSON.stringify(restored.error)).toBe(200);
  expect(await posterOf(A.id), "premise: A holds a poster again before the downgrade").toBe(storedPoster);
  // The positive half first: with both at Title the page has the whole placement, and A's poster in it.
  const before = await visitor(browser, { width: 1280, reducedMotion: true });
  await routePosterArt(before.ctx, B.logo, { svg: posterSvg(B.name, "#1d4ed8") });
  await routePosterArt(before.ctx, storedPoster, { svg: posterSvg(A.name, POSTER_FILL) });
  await before.page.goto(publicUrl, { waitUntil: "load" });
  await expect(panelOf(before.page), "premise: the panel is drawn while they are Title sponsors").toBeVisible({ timeout: READ_MS });
  await expect(slideOf(panelOf(before.page), A.id).getByTestId("title-slide-poster"), "premise: A's poster is in it").toHaveCount(1);
  await expect(before.page.getByTestId("mh-title-band")).toHaveCount(1);
  await expect(before.page.getByTestId("mh-hero-sponsor")).toHaveCount(1);
  await expect(heroGrid(before.page)).toHaveCount(1);

  for (const sponsor of [A, B]) {
    const res = await apiJson<{ tier: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors/${sponsor.id}`, "PATCH", { tier: "partner" });
    expect(res.status, `${sponsor.name}: ${JSON.stringify(res.error)}`).toBe(200);
    expect(res.data?.tier, `${sponsor.name} is a partner now`).toBe("partner");
  }

  const v = await visitor(browser, { width: 1280, reducedMotion: true });
  await v.page.goto(publicUrl, { waitUntil: "load" });
  await expect(async () => {
    await v.page.reload({ waitUntil: "load" });
    await expect(v.page.getByTestId("mh-sponsors-partners"), "the page now lists them as partners").toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: READ_MS });
  await expect(v.page.getByTestId("mh-sponsors-partners")).toContainText(A.name);
  await expect(v.page.getByTestId("mh-sponsors-partners")).toContainText(B.name);
  await expect(v.page.getByTestId("mh-hero-poster"), "no poster panel").toHaveCount(0);
  await expect(v.page.getByTestId("mh-title-band"), "no band").toHaveCount(0);
  await expect(v.page.getByTestId("mh-hero-sponsor"), "no hero sentence").toHaveCount(0);
  await expect(heroGrid(v.page), "the hero is the plain one-column hero again").toHaveCount(0);
  await expect(v.page.getByTestId("title-showcase"), "no showcase anywhere on the page, panel or band").toHaveCount(0);
  expect(await v.page.content(), "and no poster is asked of the optimiser").not.toContain(encodeURIComponent(storedPoster));
  // The downgrade took the PLACEMENT away, not the picture: the row still holds the poster, so a plan that comes back has it to show.
  expect(await posterOf(A.id), "A's poster survived the downgrade").toBe(storedPoster);
  await expectNoHorizontalScroll(v.page);
});
