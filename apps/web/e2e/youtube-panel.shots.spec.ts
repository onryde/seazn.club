import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate } from "./helpers";
import { waitForHydration } from "./directory-kit";
import { grantRigPackCredits, setRigPlan, signInAs } from "./overlay-kit";
import { disposeFakePhones, pairedPhone } from "./helpers/fake-capture-phone";
import { openTargetPicker, selectTarget, targetPicker } from "./helpers/stream-target-picker";
import { STREAM_KIND_BRAND } from "../src/components/v2/stream-platform-mark";
import { YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL, YOUTUBE_REFUSAL_CODES } from "../src/lib/youtube";

// Screenshot + layout evidence for YouTube Connect T12 (owner's Option B, 2026-10-27; polish and icon rulings 2026-10-28): the fixture
// stream panel's destination picker, the six YouTube refusals each with its fix, the replay row, and the four polish items on the
// Streaming page. WRITTEN, NOT RUN by the task that added it (T12 runs no Playwright); it is the evidence the owner reviews and the
// spec CI can dispatch. Run it with --no-deps like its sibling `youtube-streaming.shots.spec.ts`, whose rig it follows:
//   YOUTUBE_DRIVER=fake, a real signed-in owner of a Pro org, the real fake-Google round trip for a connected channel.
//
// What it adds over the unit tests (which cannot see layout, real tap area, or paint):
//   * the picker at 1280, 768 and 320: the closed field, the open list with an API-backed channel row AND a pasted-key row, no sideways
//     page scroll with the list open, every row a 44px-plus tap target, and NO YouTube logo on any picker row (owner 2026-10-28: a logo
//     must be a link back to YouTube; a picker row is not one, so both YouTube rows wear the neutral tile);
//   * each of the six refusals, driven through the real panel with the wire's own code: the fix that replaces Go live is the one the spec
//     names (Reconnect -> the Streaming page in a new tab, Try again -> the same Go live asked again, the rest -> only "Use another");
//   * the replay row after a match: the times in the venue's zone, Watch replay with the icon inside the link, Copy link that copies;
//   * the four polish items: the channel-row Settings control paints as a button at rest, the empty card's Connect YouTube leaves while
//     the channel picker is open, the denied banner's text and Dismiss share one centre line at 768 and 1280, and the YouTube logo on the
//     Streaming page is ONLY the channel row's, a link to that channel on YouTube (unaltered, at least 20px tall, a 44px tap area, a
//     violet focus ring) - the pasted-key row and the Connect buttons wear no logo.
test.use({ storageState: { cookies: [], origins: [] } });

const SHOTS = process.env.YOUTUBE_SHOTS_DIR ?? resolve(process.cwd(), "../../.superpowers/sdd/shots/youtube-panel");
const WIDTHS = [1280, 768, 320] as const;
const BANNER_WAIT_MS = 5_000;
/** The icon is YouTube's own artwork: red, with a white triangle (developers.google.com/youtube/terms/branding-guidelines, read 2026-10-28). */
const OFFICIAL_FILLS = ["#FF0000", "#FFFFFF"];
const MIN_ICON_PX = 20;

// Budget - derived, never a flat literal (AGENTS.md class 20).
const NAV_MS = 20_000;
const ACT_MS = 5_000;
const SEED_MS = 60_000;
const budget = (c: { navs: number; acts: number }): number => Math.max(60_000, SEED_MS + c.navs * NAV_MS + c.acts * ACT_MS);

const asked = new WeakSet<Page>();
/** The cookie prompt mounts over the page at hydration and would sit on top of every picture and hit-test: decline it like a visitor would. */
async function declineCookies(page: Page): Promise<void> {
  const banner = page.getByTestId("cookie-consent");
  if (!asked.has(page)) {
    asked.add(page);
    await banner.waitFor({ state: "visible", timeout: BANNER_WAIT_MS }).catch(() => {});
  }
  if (await banner.isVisible()) {
    await banner.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(banner, "the cookie banner is gone after Reject").toHaveCount(0);
  }
}
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "load" });
  await declineCookies(page);
}
async function shot(page: Page, name: string): Promise<void> {
  await declineCookies(page);
  // A full-page capture of a page that is scrolled draws the STICKY nav at the scroll offset, so the first picture of a 320px page whose
  // button Playwright had scrolled to showed a blank band above the nav (60-127px) and the back link above it. The page was never
  // broken (`expectNavPinned` proves it each time); the capture was. Capture from the top, where the nav and the band coincide.
  await page.evaluate(() => window.scrollTo(0, 0));
  const path = resolve(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: "image/png" });
}

// Copy from the dictionary itself, never typed, so a copy edit moves the expectation with it.
const dictOf = (file: string, locale = "en"): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../src/dictionaries/${locale}/${file}.json`, import.meta.url)), "utf8")) as Record<string, string>;
const EN_UI = dictOf("ui");
const en = (key: string, vars: Record<string, string | number> = {}): string => {
  const raw = EN_UI[key];
  if (raw === undefined) throw new Error(`en/ui.json has no ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, v: string) => {
    if (!(v in vars)) throw new Error(`en(${key}): no value for {${v}}`);
    return String(vars[v]);
  });
};

// ---------------------------------------------------------------------------------------------------------------------
// Layout probes
// ---------------------------------------------------------------------------------------------------------------------

/** The page does not scroll sideways: with the html/body clip lifted, nothing is wider than the viewport. Names the offenders. */
async function expectNoPageScroll(page: Page, where: string): Promise<void> {
  const seen = await page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const vw = html.clientWidth;
    const prev = [html.style.overflowX, body.style.overflowX];
    html.style.overflowX = "visible";
    body.style.overflowX = "visible";
    const overflowPx = Math.max(0, html.scrollWidth - vw);
    [html.style.overflowX, body.style.overflowX] = prev;
    const contained = (el: Element) => {
      for (let n = el.parentElement; n && n !== body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
      }
      return false;
    };
    const offenders = Array.from(body.querySelectorAll("*"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > vw + 1 && !contained(el);
      })
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}[${(el as HTMLElement).dataset.testid ?? ""}] right=${Math.round(el.getBoundingClientRect().right)}`);
    return { vw, overflowPx, offenders };
  });
  expect(seen.offenders, `${where}: boxes reach past the ${seen.vw}px viewport`).toEqual([]);
  expect(seen.overflowPx, `${where}: ${seen.overflowPx}px of sideways page scroll at ${seen.vw}px`).toBeLessThanOrEqual(1);
}

/** The control's centre is its own (nothing paints over it), and on a phone it is a 44px target. Hit-tested with elementFromPoint. */
async function expectTappable(loc: Locator, label: string): Promise<void> {
  await loc.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  const probe = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { own: at !== null && (at === el || el.contains(at)), w: r.width, h: r.height, vw: document.documentElement.clientWidth };
  });
  expect(probe.own, `${label}: something else is on top of its centre`).toBe(true);
  if (probe.vw < 768) {
    expect(probe.h, `${label} at ${probe.vw}: ${Math.round(probe.w)}x${Math.round(probe.h)}px`).toBeGreaterThanOrEqual(43.5);
  }
}

/** Is this a link to YouTube itself (https, youtube.com or a subdomain, or youtu.be)? The page's own `isYoutubeUrl`, restated for the browser side. */
const isYoutubeHref = (protocol: string | null, host: string | null): boolean =>
  protocol === "https:" && host !== null && (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be");

/** Every official YouTube icon under `scope`: unaltered colours, at least 20px tall, fully painted (nothing over its centre), not clipped
 *  by an ancestor narrower than the mark - and INSIDE a link to YouTube (owner 2026-10-28: "any logo used within an application must be
 *  clickable and link back to YouTube content"). Returns how many it read - a scope that held none is a failure, not a pass. */
async function expectOfficialIcons(scope: Locator, where: string): Promise<number> {
  const seen = await scope.locator("svg[data-youtube-icon]").evaluateAll((svgs) =>
    svgs.map((svg) => {
      const r = svg.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      let clipped = false;
      for (let n = svg.parentElement; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.overflowX !== "visible" && (n.getBoundingClientRect().width < r.width - 0.5 || n.getBoundingClientRect().height < r.height - 0.5)) clipped = true;
      }
      return {
        fills: Array.from(svg.querySelectorAll("path")).map((p) => (p.getAttribute("fill") ?? "").toUpperCase()),
        h: r.height,
        w: r.width,
        opacity: getComputedStyle(svg).opacity,
        painted: at !== null && (at === svg || svg.contains(at) || at.contains(svg)),
        clipped,
        linkProtocol: svg.closest("a[href]") ? new URL((svg.closest("a[href]") as HTMLAnchorElement).href).protocol : null,
        linkHost: svg.closest("a[href]") ? new URL((svg.closest("a[href]") as HTMLAnchorElement).href).hostname : null,
      };
    }),
  );
  expect(seen.length, `${where}: the scope holds at least one official icon`).toBeGreaterThan(0);
  for (const [i, s] of seen.entries()) {
    expect(s.fills, `${where} #${i}: the official two colours, unaltered`).toEqual(OFFICIAL_FILLS);
    expect(s.h, `${where} #${i}: the icon is at least ${MIN_ICON_PX}px tall`).toBeGreaterThanOrEqual(MIN_ICON_PX - 0.5);
    expect(s.opacity, `${where} #${i}: fully opaque`).toBe("1");
    expect(s.painted, `${where} #${i}: nothing covers it`).toBe(true);
    expect(s.clipped, `${where} #${i}: no ancestor clips it`).toBe(false);
    expect(isYoutubeHref(s.linkProtocol, s.linkHost), `${where} #${i}: the logo sits inside a link to YouTube (${s.linkProtocol}//${s.linkHost})`).toBe(true);
  }
  return seen.length;
}

/** A scope that must draw NO YouTube logo (a row or a button is not a link to YouTube). The scope itself must exist, or "none inside" is
 *  vacuous. */
async function expectNoYoutubeLogo(scope: Locator, where: string): Promise<void> {
  expect(await scope.count(), `${where}: the scope exists (an absent scope proves nothing)`).toBeGreaterThan(0);
  await expect(scope.locator("svg[data-youtube-icon]"), `${where}: no YouTube logo`).toHaveCount(0);
}

/** The channel row's logo link, read off the browser: where it leads, how it is named, that its tap area is 44px (hit-tested at the
 *  corners of a 44px square centred on the icon, which the icon's own 34x24 box does not reach), that the icon did not grow to make
 *  room, and that a keyboard user sees the violet-600 ring. */
async function expectChannelLogoLink(row: Locator, page: Page, channelId: string, channelTitle: string, where: string): Promise<void> {
  const link = row.getByTestId("youtube-logo-link");
  await expect(link, `${where}: one logo link on the row`).toHaveCount(1);
  await expect(link).toHaveAttribute("href", `https://www.youtube.com/channel/${channelId}`);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link, `${where}: named '<channel> on YouTube'`).toHaveAttribute("aria-label", en("streaming.youtube.channelLink", { name: channelTitle }));
  await link.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  const hit = await link.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // 19px, not 22: a hair inside the 44px square so sub-pixel layout cannot flake the corner.
    const corners = [[-19, -19], [19, -19], [-19, 19], [19, 19]].map(([dx, dy]) => {
      const at = document.elementFromPoint(cx + dx!, cy + dy!);
      return at !== null && (at === el || el.contains(at));
    });
    const svg = el.querySelector("svg")!.getBoundingClientRect();
    return { corners, linkW: r.width, linkH: r.height, iconH: svg.height };
  });
  expect(hit.corners, `${where}: all four corners of the 44px tap area hit the link`).toEqual([true, true, true, true]);
  expect(Math.round(hit.iconH), `${where}: the visible icon is its own 24px (the tap area did not enlarge it)`).toBe(24);
  expect(hit.linkH, `${where}: the link's own box is the icon's (the 44px is a pseudo-element)`).toBeLessThan(30);
  // Keyboard focus: a key press first, so the browser treats the script focus as keyboard-driven (:focus-visible).
  await page.keyboard.press("Shift");
  await link.focus();
  const ring = await link.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: cs.outlineColor };
  });
  expect(ring.style, `${where}: a focus ring is drawn`).not.toBe("none");
  expect(ring.width, `${where}: the ring is at least 2px`).toBeGreaterThanOrEqual(2);
  expect(ring.color, `${where}: the ring is violet-600 (#7c3aed)`).toBe("rgb(124, 58, 237)");
  await link.blur();
}

// ---------------------------------------------------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------------------------------------------------
async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

interface Rig {
  orgId: string;
  orgSlug: string;
  /** The fixture page of the rig's one match; null when no match was asked for. */
  fixturePath: string | null;
  fixtureId: string | null;
}

/** A fresh Pro owner with an org of their own and (optionally) a two-side league with one match - the recipe of
 *  walkthrough/streaming-destinations.spec.ts's `seedRig`, so the panel under test is the one a real organiser sees. */
async function rig(page: Page, opts: { match?: boolean } = {}): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+ytp-${tag}@resend.dev`;
  const orgSlug = `ytp-org-${tag}`;
  const orgId = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${ownerEmail}, ${"YT Panel Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"YT Panel Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return newOrgId;
  });
  await signInAs(page, ownerEmail);
  await setRigPlan(orgId, "pro");
  if (!opts.match) return { orgId, orgSlug, fixturePath: null, fixtureId: null };
  const label = `YT Panel ${tag}`;
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: label, visibility: "public" });
  if (comp.status >= 300 || !comp.data) throw new Error(`rig: POST competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
  const div = await apiJson<{ id: string; slug: string }>(page.request, `/api/v1/competitions/${comp.data.id}/divisions`, "POST", {
    name: label.slice(0, 40), sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  if (div.status >= 300 || !div.data) throw new Error(`rig: POST division -> ${div.status} ${JSON.stringify(div.error)}`);
  const ents = await addEntrantsViaApi(page.request, div.data.id, [`Side A ${tag}`, `Side B ${tag}`]);
  if (ents.status >= 300 || ents.ids.length !== 2) throw new Error(`rig: entrants -> ${ents.status}`);
  await createStageAndGenerate(page.request, div.data.id);
  const [fixture] = await withDb((sql) => sql<{ id: string; no: number }[]>`select id, fixture_no as no from fixtures where division_id = ${div.data!.id} order by fixture_no`);
  if (!fixture) throw new Error("rig: the league generated no fixture");
  await grantRigPackCredits(orgId, 3);
  return { orgId, orgSlug, fixturePath: `/o/${orgSlug}/c/${comp.data.slug}/d/${div.data.slug}/f/${fixture.no}`, fixtureId: fixture.id };
}

/** A pasted-key destination, made over the API (the same call the Add form makes). */
async function addKeyDestination(page: Page, orgId: string, label: string, kind: "youtube" | "twitch" = "youtube"): Promise<void> {
  const res = await apiJson(page.request, `/api/v1/orgs/${orgId}/stream-targets`, "POST", { kind, label, streamKey: `yt9-${randomUUID()}-key` });
  expect(res.status, "SETUP: a pasted-key destination is added").toBe(201);
}

/** Channel ids unique to this run: the fake numbers its fresh channels from 1, and the database outlives it. */
const channel = (title: string) => ({ id: `UC${randomUUID().replace(/-/g, "").slice(0, 22)}`, title });

/** Tell the fake YouTube which channels the NEXT grant has, then take the real consent round trip (the recipe of
 *  youtube-streaming.shots.spec.ts's `offerChannels` + `connectThroughConsent`, in one: the route is installed per call). */
async function connectChannel(page: Page, channels: { id: string; title: string }[], trigger: "youtube-connect" | "youtube-connect-empty"): Promise<void> {
  let fired = 0;
  await page.route("**/api/youtube/connect", async (route) => {
    const start = await route.fetch({ maxRedirects: 0 });
    expect(start.status(), "SETUP: the start answers with the 303 to the authorize hop").toBe(303);
    const state = new URL(start.headers()["location"] ?? "", "http://localhost").searchParams.get("state");
    expect(state, "SETUP: the start's Location carries the OAuth state").toBeTruthy();
    const res = await page.request.post("/api/internal/youtube/fake", { data: { op: "setChannels", channels, state } });
    expect(res.status(), "SETUP: the fake accepts the channels for this state").toBe(200);
    fired++;
    await route.fulfill({ response: start });
  });
  // Every landing is a full document load, and a click on server-rendered markup before React hydrates is DROPPED: the card never opens.
  // `page.route` turns the HTTP cache off, so each landing refetches its ~20 chunks (30-260 ms apiece under four workers) and hydrates well
  // after the click's own navigation wait resolves. Connect 1 is safe (its URL wait below really waits for `load`); from connect 2 on the
  // URL ALREADY matches, so that wait gates nothing and the next trigger click (connect 3) lands on un-hydrated markup.
  const opener = page.getByTestId(trigger);
  await waitForHydration(opener);
  await opener.click();
  const submit = page.getByTestId("youtube-connect-submit");
  await expect(submit, "Continue is disabled until the box is ticked").toBeDisabled();
  await page.getByTestId("youtube-consent").check();
  await Promise.all([page.waitForURL(/\/streaming\?youtube=/), submit.click()]);
  await declineCookies(page);
  expect(fired, "the channel offer ran once for this connect").toBe(1);
}

test.afterEach(async () => {
  await disposeFakePhones();
});

// ---------------------------------------------------------------------------------------------------------------------
// 1. The four polish items on the Streaming page
// ---------------------------------------------------------------------------------------------------------------------
test("Streaming page polish - the Settings button at rest, Connect leaves with the picker, the denied banner is centred, one official icon - at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: 14, acts: 40 }));
  const { orgId } = await rig(page);

  // (2) The empty card's Connect YouTube is hidden while the channel picker is open - the picker is the thing to act on.
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "/streaming");
  await expect(page.getByTestId("youtube-connect-empty"), "PREMISE: with no channel connected the empty card offers Connect").toBeVisible();
  const first = channel("Riverside FC");
  const second = channel("Riverside Juniors");
  await connectChannel(page, [first, second], "youtube-connect-empty");
  await expect(page).toHaveURL(/\/streaming\?youtube=pick&pending=[0-9a-f-]{36}$/);
  await expect(page.getByTestId("youtube-picker")).toBeVisible();
  await expect(page.getByTestId("youtube-connect-empty"), "the picker is open: the empty card's Connect is gone").toHaveCount(0);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    await expect(page.getByTestId("youtube-connect-empty"), `at ${w}`).toHaveCount(0);
    await expectNoPageScroll(page, `picker open at ${w}`);
    await shot(page, `polish-connect-hidden-${w}`);
  }
  await page.getByTestId("youtube-picker-channel").first().check();
  await page.getByTestId("youtube-picker-connect").click();
  const row = page.getByTestId("youtube-channel-row");
  await expect(row).toHaveCount(1, { timeout: NAV_MS });

  // (1) The channel row's Settings reads as a button at rest: a visible border and a fill (not text that only looks like a link),
  //     at the 44px floor on a phone.
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    const settings = row.getByTestId("youtube-settings");
    await expect(settings).toBeVisible();
    const paint = await settings.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: parseFloat(cs.borderTopWidth), borderColor: cs.borderTopColor, bg: cs.backgroundColor };
    });
    expect(paint.border, `Settings at ${w}: a border at rest`).toBeGreaterThanOrEqual(1);
    expect(paint.borderColor, `Settings at ${w}: the border is painted`).not.toBe("rgba(0, 0, 0, 0)");
    expect(paint.bg, `Settings at ${w}: a fill at rest, not transparent text`).not.toBe("rgba(0, 0, 0, 0)");
    await expectTappable(settings, `Settings at ${w}`);
    await expectNoPageScroll(page, `row at ${w}`);
    await shot(page, `polish-settings-${w}`);
  }

  // (4) The YouTube LOGO on this page is only the channel row's, and it is a link to that channel (owner 2026-10-28). The pasted key's
  //     row wears the neutral tile instead (it keeps the row aligned), and the Connect button wears nothing. (The key is added only
  //     now: the empty card above is what a page with NO destination shows, and any destination would have replaced it.)
  await addKeyDestination(page, orgId, "Pasted key");
  await open(page, "/streaming");
  await expect(row).toHaveCount(1);
  let icons = 0;
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    icons += await expectOfficialIcons(row, `channel row at ${w}`);
    await expectChannelLogoLink(row, page, first.id, first.title, `channel row at ${w}`);
    const pastedRow = page.getByTestId("stream-dest-row").first();
    await expectNoYoutubeLogo(pastedRow, `pasted-key row at ${w}`);
    await expect(pastedRow.locator('[data-platform-mark="youtube"]'), `pasted-key row at ${w}: the neutral tile keeps the row aligned`).toHaveCount(1);
    await expectNoYoutubeLogo(page.getByTestId("youtube-connect"), `the Connect YouTube button at ${w}`);
    await expectNoPageScroll(page, `the logo link row at ${w}`);
    await shot(page, `polish-icon-${w}`);
  }
  expect(icons, "anti-vacuity: the channel row's logo was read at every width, and it is the only one").toBe(WIDTHS.length);

  // (3) The denied banner: the sentence and Dismiss share one centre line from 768 up; on a phone Dismiss stacks full width below.
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    await open(page, "/streaming?youtube=denied");
    const banner = page.getByTestId("youtube-landing");
    await expect(banner).toHaveAttribute("data-code", "denied");
    await expect(banner).toContainText(en("streaming.youtube.landing.denied"));
    const dismiss = page.getByTestId("youtube-landing-dismiss");
    const text = banner.locator("p");
    const [t, d] = [await text.boundingBox(), await dismiss.boundingBox()];
    expect(t && d, "both boxes are measurable").toBeTruthy();
    if (w >= 768) {
      const delta = Math.abs(t!.y + t!.height / 2 - (d!.y + d!.height / 2));
      expect(delta, `the sentence and Dismiss are centred on one line at ${w} (off by ${delta.toFixed(1)}px)`).toBeLessThanOrEqual(1.5);
    } else {
      expect(d!.y, `Dismiss stacks below the sentence at ${w}`).toBeGreaterThanOrEqual(t!.y + t!.height - 1);
      await expectTappable(dismiss, `Dismiss at ${w}`);
    }
    await expectNoPageScroll(page, `denied banner at ${w}`);
    await shot(page, `polish-denied-banner-${w}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. The fixture panel: the picker, the six refusals, the replay row
// ---------------------------------------------------------------------------------------------------------------------
/** The fixture's Stream panel on its Phone tab (the recipe of walkthrough/streaming-destinations.spec.ts's `openPhoneTab`). */
async function openPhoneTab(page: Page, r: Rig): Promise<Locator> {
  await open(page, r.fixturePath!);
  const control = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
  await expect(control, "the fixture offers exactly one visible Stream control").toHaveCount(1, { timeout: NAV_MS });
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  await expect(scope).toBeAttached({ timeout: NAV_MS });
  const phoneTab = scope.getByTestId("stream-tab-phone");
  if (await phoneTab.count()) await phoneTab.click();
  await expect(scope.locator("[data-phone-body]")).toBeAttached({ timeout: NAV_MS });
  return scope.locator("[data-phone-body]");
}

/** Connect a real channel (the Streaming page, the fake Google) and add a pasted key: the two kinds the picker tells apart. */
async function seedDestinations(page: Page, r: Rig, channelTitle: string, keyLabel: string): Promise<void> {
  await open(page, "/streaming");
  await connectChannel(page, [channel(channelTitle)], "youtube-connect-empty");
  await expect(page.getByTestId("youtube-channel-row")).toHaveCount(1, { timeout: NAV_MS });
  await addKeyDestination(page, r.orgId, keyLabel);
}

/** The wire's own refusal, as `prepare.ts` writes it (`youtubeRefusal`): the status per code, and the code as the envelope's `error.code`. */
const REFUSAL_STATUS: Record<(typeof YOUTUBE_REFUSAL_CODES)[number], number> = {
  youtube_reconnect_needed: 409,
  youtube_live_not_enabled: 409,
  youtube_live_blocked: 409,
  youtube_limit_reached: 429,
  youtube_channel_busy: 409,
  youtube_unavailable: 503,
};
/** The fix each refusal replaces Go live with (spec §6.2 and the controller's ruling of T12 fix round 1): the channel's grant is dead ->
 *  Reconnect; a refusal a retry may clear (YouTube did not answer, its quota for new streams is spent, the channel's ten streams are all
 *  live) -> Try again; not enabled for live and restricted -> only "Use another destination". */
const FIX: Record<(typeof YOUTUBE_REFUSAL_CODES)[number], "reconnect" | "retry" | "none"> = {
  youtube_reconnect_needed: "reconnect",
  youtube_live_not_enabled: "none",
  youtube_live_blocked: "none",
  youtube_limit_reached: "retry",
  youtube_channel_busy: "retry",
  youtube_unavailable: "retry",
};

test("Fixture panel - the picker lists a channel and a pasted key with their kind, at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: 10, acts: 30 }));
  const r = await rig(page, { match: true });
  const channelTitle = `Riverside FC ${randomBytes(2).toString("hex")}`;
  const keyLabel = `Court key ${randomBytes(2).toString("hex")}`;
  await seedDestinations(page, r, channelTitle, keyLabel);
  let widthsRead = 0;
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    const body = await openPhoneTab(page, r);
    const trigger = targetPicker(body);
    await expect(trigger, "the closed field names the picked destination").toBeVisible();
    await expectTappable(trigger, `the picker at ${w}`);
    await shot(page, `picker-closed-${w}`);

    await openTargetPicker(body);
    const rows = body.getByTestId("stream-target-option");
    await expect(rows).toHaveCount(2);
    await expect(body.getByTestId("stream-target-list")).toHaveAttribute("role", "listbox");
    const names = await rows.evaluateAll((els) => els.map((e) => e.querySelector('[data-testid="stream-target-name"]')?.textContent ?? ""));
    expect([...names].sort(), "the list offers the channel and the pasted key").toEqual([channelTitle, keyLabel].sort());
    const kinds = await rows.evaluateAll((els) => els.map((e) => e.querySelector('[data-testid="stream-target-kind"]')?.textContent ?? ""));
    expect(kinds.some((k) => k.startsWith(en("stream.dest.kind.channel", { platform: STREAM_KIND_BRAND.youtube }))), "the channel row says it is a connected channel").toBe(true);
    expect(kinds.includes(en("stream.dest.kind.key", { platform: STREAM_KIND_BRAND.youtube })), "the pasted row says it is a stream key").toBe(true);
    for (const [i, row] of (await rows.all()).entries()) await expectTappable(row, `picker row ${i} at ${w}`);
    await expectNoYoutubeLogo(body.getByTestId("stream-target-list"), `picker rows at ${w}`);
    await expect(body.getByTestId("stream-target-list").locator('[data-platform-mark="youtube"]'), `picker rows at ${w}: both YouTube rows wear the neutral tile`).toHaveCount(2);
    await expectNoPageScroll(page, `the open picker at ${w}`);
    await shot(page, `picker-open-${w}`);

    await selectTarget(body, (await rows.first().getAttribute("data-target-id"))!);
    await expect(body.getByTestId("stream-target-list")).toHaveCount(0);
    widthsRead++;
  }
  expect(widthsRead, "anti-vacuity: every width was walked").toBe(WIDTHS.length);
});

test("Fixture panel - each of the six YouTube refusals replaces Go live with its own fix, at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: 6 + YOUTUBE_REFUSAL_CODES.length, acts: 20 + 8 * YOUTUBE_REFUSAL_CODES.length }));
  const r = await rig(page, { match: true });
  await seedDestinations(page, r, `Riverside FC ${randomBytes(2).toString("hex")}`, `Court key ${randomBytes(2).toString("hex")}`);
  let posts = 0;
  let nextCode: (typeof YOUTUBE_REFUSAL_CODES)[number] = "youtube_reconnect_needed";
  await page.route("**/api/v1/fixtures/*/stream-sessions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts++;
    await route.fulfill({
      status: REFUSAL_STATUS[nextCode],
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { code: nextCode, message: `YouTube refused Go live: ${nextCode}`, connectionId: randomUUID() } }),
    });
  });
  let checked = 0;
  for (const code of YOUTUBE_REFUSAL_CODES) {
    nextCode = code;
    // A fresh panel each time (openPhoneTab loads the page): the previous refusal's state is gone.
    const scope = await openPhoneTab(page, r);
    await pairedPhone(page); // W5: Go live needs a paired phone
    // Pick the channel - the destination YouTube refuses.
    await openTargetPicker(scope);
    const channelRow = scope.getByTestId("stream-target-option").filter({ hasText: en("stream.dest.kind.channel", { platform: STREAM_KIND_BRAND.youtube }) });
    await expect(channelRow, "exactly one connected channel is offered").toHaveCount(1);
    await selectTarget(scope, (await channelRow.getAttribute("data-target-id"))!);
    await scope.getByTestId("stream-go-live").click();
    const block = scope.getByTestId("stream-youtube-refusal");
    await expect(block, `${code}: the refusal block`).toBeVisible({ timeout: ACT_MS * 2 });
    await expect(block).toHaveAttribute("data-code", code);
    // The block replaced the Go live the organiser had just pressed: focus lands on the BLOCK (tabindex -1, role=alert), not on the top of
    // the page and not on one of its buttons - the refusal commits while the start is in flight, when Try again is still disabled.
    await expect(block, `${code}: focus moved to the refusal block`).toBeFocused();
    // Wait for the start to end (Try again enables; the other fixes were never disabled), THEN one Tab reaches the first enabled action.
    const firstAction = scope.getByTestId({ reconnect: "stream-youtube-reconnect", retry: "stream-youtube-retry", none: "stream-youtube-pick-another" }[FIX[code]]);
    await expect(firstAction, `${code}: the first action is enabled once the start has ended`).toBeEnabled({ timeout: ACT_MS * 2 });
    await page.keyboard.press("Tab");
    await expect(firstAction, `${code}: one Tab from the block reaches the first enabled action`).toBeFocused();
    await expect(scope.getByTestId("stream-create-error")).toHaveText(en(`stream.error.${code}`, { max: YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL }));
    await expect(scope.getByTestId("stream-youtube-refusal-note")).toHaveText(en("stream.youtube.refused.nothing"));
    await expect(scope.getByTestId("stream-go-live"), `${code}: the refusal REPLACES Go live`).toHaveCount(0);
    await expect(targetPicker(scope), `${code}: the picker field is red`).toHaveAttribute("aria-invalid", "true");
    const fix = FIX[code];
    await expect(scope.getByTestId("stream-youtube-reconnect")).toHaveCount(fix === "reconnect" ? 1 : 0);
    await expect(scope.getByTestId("stream-youtube-retry")).toHaveCount(fix === "retry" ? 1 : 0);
    await expect(scope.getByTestId("stream-youtube-pick-another"), `${code}: every refusal offers another destination`).toBeVisible();
    for (const id of ["stream-youtube-reconnect", "stream-youtube-retry", "stream-youtube-pick-another"]) {
      const el = scope.getByTestId(id);
      if (await el.count()) await expectTappable(el, `${code}: ${id}`);
    }
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
      await expectNoPageScroll(page, `${code} at ${w}`);
      if (code === "youtube_reconnect_needed" || code === "youtube_unavailable") await shot(page, `refusal-${code}-${w}`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    if (fix === "reconnect") {
      const link = scope.getByTestId("stream-youtube-reconnect");
      await expect(link).toHaveAttribute("href", "/streaming");
      const [popup] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
      await popup.waitForLoadState();
      expect(new URL(popup.url()).pathname, "Reconnect opens the Streaming page, never the old Directory tab").toBe("/streaming");
      await popup.close();
    }
    if (fix === "retry") {
      const before = posts;
      await scope.getByTestId("stream-youtube-retry").click();
      await expect.poll(() => posts, { message: "Try again IS Go live asked again", timeout: ACT_MS }).toBe(before + 1);
    }
    // "Use another destination" clears the refusal and opens the picker on the focused field.
    await scope.getByTestId("stream-youtube-pick-another").click();
    await expect(scope.getByTestId("stream-youtube-refusal"), `${code}: the refusal is cleared`).toHaveCount(0);
    await expect(targetPicker(scope)).toHaveAttribute("aria-expanded", "true");
    await expect(targetPicker(scope), "focus is on the picker").toBeFocused();
    checked++;
  }
  expect(checked, "anti-vacuity: all six refusals were driven").toBe(YOUTUBE_REFUSAL_CODES.length);
});

test("Fixture panel - the picker with channels that are not ready: the badge gets its own line and the name keeps the whole column, at 1280, 768 and 320", async ({ page }) => {
  // Five channels, each in a different health, with realistic long names: the healthy rows of the other tests never put a badge beside a
  // 40-character name, which is where a row breaks (a badge beside the name left "Alph..."; its own line is what keeps the name readable).
  test.setTimeout(budget({ navs: 6 + 5 * 3, acts: 40 + 5 * 8 }));
  const r = await rig(page, { match: true });
  const tag = randomBytes(2).toString("hex");
  const channels = [
    { title: `Alpha Riverside Basketball Club ${tag}`, badge: en("streaming.youtube.status.reconnectNeeded"), tone: "bad" },
    { title: `Bravo Riverside Basketball Club ${tag}`, badge: en("streaming.youtube.status.notEnabled"), tone: "warn" },
    { title: `Charlie Riverside Basketball Club ${tag}`, badge: en("streaming.youtube.status.blocked"), tone: "bad" },
    { title: `Delta Riverside Basketball Club ${tag}`, badge: en("streaming.youtube.status.unknown"), tone: "neutral" },
    { title: `Echo Riverside Basketball Club ${tag}`, badge: null, tone: null },
  ] as const;
  await open(page, "/streaming");
  for (const [i, c] of channels.entries()) {
    await connectChannel(page, [channel(c.title)], i === 0 ? "youtube-connect-empty" : "youtube-connect");
    await expect(page.getByTestId("youtube-channel-row"), `SETUP: channel ${i + 1} is connected`).toHaveCount(i + 1, { timeout: NAV_MS });
  }
  // The server's own states, written the way its health check and a revoked grant leave them (connections.ts `liveStateOf`): a dead grant is
  // `reconnect_needed`; a check made AFTER the token last changed says enabled (no code), not enabled, or blocked; no check says unknown.
  await withDb(async (sql) => {
    const set = async (title: string, patch: { status?: string; code?: string | null; checked?: boolean }) => {
      const rows = await sql`
        update org_youtube_connections
           set status = ${patch.status ?? "connected"},
               last_health_at = ${patch.checked ? sql`status_since + interval '1 minute'` : null},
               last_error_code = ${patch.code ?? null}
         where org_id = ${r.orgId} and channel_title = ${title}
        returning id`;
      expect(rows.length, `SETUP: ${title} was found once`).toBe(1);
    };
    await set(channels[0].title, { status: "reconnect_needed" });
    await set(channels[1].title, { checked: true, code: "youtube_live_not_enabled" });
    await set(channels[2].title, { checked: true, code: "youtube_live_blocked" });
    await set(channels[3].title, {});
    await set(channels[4].title, { checked: true });
  });
  let widthsRead = 0;
  let badgesRead = 0;
  let geometryRead = 0;
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    const body = await openPhoneTab(page, r);
    await openTargetPicker(body);
    const rows = body.getByTestId("stream-target-option");
    await expect(rows, "the list offers all five channels").toHaveCount(channels.length);
    for (const c of channels) {
      const row = rows.filter({ has: page.getByTestId("stream-target-name").filter({ hasText: c.title }) });
      await expect(row, `${c.title}: one row`).toHaveCount(1);
      const badge = row.getByTestId("stream-target-health");
      if (c.badge === null) {
        await expect(badge, `${c.title}: a ready channel claims no badge`).toHaveCount(0);
      } else {
        await expect(badge, `${c.title} at ${w}: the badge`).toHaveText(c.badge);
        await expect(badge).toHaveAttribute("data-tone", c.tone);
        badgesRead++;
      }
      // The geometry. The badge is a line of its own UNDER the name and kind lines, so the name keeps the row's whole text column: a badge
      // beside it took 46% of the row and left "Alph..." / "Bravo Riv..." at 768 as well as 320 (the channels share their prefix).
      // Every number is read off the boxes the browser laid out: the text column is the row's inner width less the mark and the check mark.
      const box = await row.evaluate((el) => {
        const rect = (sel: string) => el.querySelector(sel)?.getBoundingClientRect() ?? null;
        const li = el.getBoundingClientRect();
        const css = getComputedStyle(el);
        const name = rect('[data-testid="stream-target-name"]')!;
        const kind = rect('[data-testid="stream-target-kind"]')!;
        const mark = rect("[data-platform-mark]")!;
        const check = rect("svg.lucide-check");
        const inner = li.width - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
        const b = rect('[data-testid="stream-target-health"]');
        return {
          rowRight: li.right, scrolls: el.scrollWidth > el.clientWidth + 1, nameW: name.width, nameBottom: name.bottom, kindBottom: kind.bottom,
          column: inner - mark.width - (check?.width ?? 0), badgeTop: b?.top ?? null, badgeRight: b?.right ?? 0,
        };
      });
      expect(box.scrolls, `${c.title} at ${w}: the row's content fits the row`).toBe(false);
      expect(box.nameW, `${c.title} at ${w}: the name keeps the text column (${Math.round(box.nameW)} of ${Math.round(box.column)}px)`).toBeGreaterThanOrEqual(box.column * 0.7);
      if (box.badgeTop !== null) {
        expect(box.badgeTop, `${c.title} at ${w}: the badge is a line of its own, under the name`).toBeGreaterThanOrEqual(box.nameBottom - 1);
        expect(box.badgeTop, `${c.title} at ${w}: ... and under the kind line`).toBeGreaterThanOrEqual(box.kindBottom - 1);
        expect(box.badgeRight, `${c.title} at ${w}: the badge stays inside the row`).toBeLessThanOrEqual(box.rowRight + 1);
      }
      geometryRead++;
      await expectTappable(row, `${c.title} row at ${w}`);
    }
    await expectNoPageScroll(page, `the open picker with unhealthy channels at ${w}`);
    await shot(page, `picker-unhealthy-open-${w}`);
    // Picked, the trigger carries the same badge (it reads like the row it came from) without widening the page.
    const pick = rows.filter({ has: page.getByTestId("stream-target-name").filter({ hasText: channels[0].title }) });
    await selectTarget(body, (await pick.getAttribute("data-target-id"))!);
    await expect(targetPicker(body).getByTestId("stream-target-health"), `the trigger wears the picked channel's badge at ${w}`).toHaveText(channels[0].badge);
    await expectNoPageScroll(page, `the closed picker on an unhealthy channel at ${w}`);
    await shot(page, `picker-unhealthy-picked-${w}`);
    widthsRead++;
  }
  expect(widthsRead, "anti-vacuity: every width was walked").toBe(WIDTHS.length);
  expect(badgesRead, "anti-vacuity: four badged channels were read at every width").toBe(WIDTHS.length * 4);
  expect(geometryRead, "anti-vacuity: every row (badged or ready) was measured at every width").toBe(WIDTHS.length * channels.length);
});

test("Fixture panel - after a match: the replay row shows when it ran, Watch replay wears the icon, Copy link copies, at 1280, 768 and 320", async ({ page, context }) => {
  test.setTimeout(budget({ navs: 8, acts: 20 }));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  const r = await rig(page, { match: true });
  await seedDestinations(page, r, `Riverside FC ${randomBytes(2).toString("hex")}`, `Court key ${randomBytes(2).toString("hex")}`);
  const REPLAY = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const startedAt = "2026-09-14T11:00:00.000Z";
  const endedAt = "2026-09-14T11:45:00.000Z";
  // The ended session as the server reads it (StreamSessionView): the panel's card is a pure function of this view.
  await page.route("**/api/v1/fixtures/*/stream-sessions/current", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          id: randomUUID(), fixtureId: r.fixtureId, mode: "passthrough", overlay: null, state: "completed", desiredState: "ending",
          failReason: null, health: null, ingest: null, output: null, balance: 2, startedAt, endedAt, replayUrl: REPLAY, replayParts: [],
          target: { id: randomUUID(), kind: "youtube", label: "Riverside FC" }, fixtureDecided: true, fixtureHeld: false,
          endReason: "stopped", creditUsed: true, startCause: "organiser", restart: null, countdown: null,
        },
      }),
    }),
  );
  let widthsRead = 0;
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    const body = await openPhoneTab(page, r);
    const row = body.getByTestId("stream-replay-row");
    await expect(row, "the ended card draws the replay row").toBeVisible({ timeout: NAV_MS });
    await expect(row.getByTestId("stream-replay-times")).toHaveText(/\d{1,2}:\d{2}.+\d{1,2}:\d{2}/);
    const watch = row.getByTestId("stream-replay");
    await expect(watch).toHaveAttribute("href", REPLAY);
    await expect(watch).toHaveAttribute("target", "_blank");
    expect(await expectOfficialIcons(watch, `Watch replay at ${w}`), "the icon sits INSIDE the link, so the mark leads to YouTube").toBe(1);
    await expectTappable(watch, `Watch replay at ${w}`);
    const copy = row.getByTestId("stream-replay-copy");
    await expectTappable(copy, `Copy link at ${w}`);
    await copy.click();
    await expect(copy, "Copy link confirms").toContainText(en("stream.replay.copied"));
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    if (copied !== null) expect(copied, "the clipboard holds the replay link").toBe(REPLAY);
    await expectNoPageScroll(page, `the replay row at ${w}`);
    await shot(page, `replay-row-${w}`);
    widthsRead++;
  }
  expect(widthsRead, "anti-vacuity: every width was walked").toBe(WIDTHS.length);
});

test("Fixture panel - after a match: the replay parts (one; two; one plus the club's own link; private; private beside a public one) read apart by words and a note, at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: 20, acts: 30 }));
  const r = await rig(page, { match: true });
  await seedDestinations(page, r, `Riverside FC ${randomBytes(2).toString("hex")}`, `Court key ${randomBytes(2).toString("hex")}`);
  const PART_1 = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const PART_2 = "https://www.youtube.com/watch?v=9bZkp7q19f0";
  const CLUB = "https://club.example.com/live/final";
  const startedAt = "2026-09-14T11:00:00.000Z";
  const endedAt = "2026-09-14T11:45:00.000Z";
  // The cases are the three shapes the view can take after a match (StreamSessionView.replayParts + replayUrl): the same stubbed
  // endpoint answers with whichever is current, so each width re-opens the panel on the shape under test.
  const cases = [
    { name: "one-part", replayUrl: PART_1, parts: [{ partNo: 1, url: PART_1, private: false }], hrefs: [PART_1], labels: [en("stream.phone.replay")], partLabels: [] as string[], icons: 1, latest: false, notes: [false] },
    {
      name: "two-parts", replayUrl: PART_1, parts: [{ partNo: 1, url: PART_1, private: false }, { partNo: 2, url: PART_2, private: false }], hrefs: [PART_1, PART_2],
      labels: [en("stream.phone.replay"), en("stream.phone.replay")], partLabels: [en("streaming.youtube.part", { n: 1 }), en("streaming.youtube.part", { n: 2 })], icons: 2, latest: true, notes: [false, false],
    },
    {
      name: "one-part-club-link", replayUrl: CLUB, parts: [{ partNo: 1, url: PART_1, private: false }], hrefs: [PART_1, CLUB], labels: [en("stream.phone.replay"), en("stream.url.label")],
      partLabels: [] as string[], icons: 1, latest: false, notes: [false, false],
    },
    // Owner ruling A (2026-10-28): the organiser keeps a private channel's replay, with a note that the public page does not show it.
    // The end step writes no link for it, so the fixture's own link is empty.
    {
      name: "private", replayUrl: null as string | null, parts: [{ partNo: 1, url: PART_1, private: true }], hrefs: [PART_1], labels: [en("stream.phone.replay")],
      partLabels: [] as string[], icons: 1, latest: false, notes: [true],
    },
    {
      name: "private-mixed", replayUrl: PART_1, parts: [{ partNo: 1, url: PART_1, private: false }, { partNo: 2, url: PART_2, private: true }], hrefs: [PART_1, PART_2],
      labels: [en("stream.phone.replay"), en("stream.phone.replay")], partLabels: [en("streaming.youtube.part", { n: 1 }), en("streaming.youtube.part", { n: 2 })], icons: 2, latest: true,
      notes: [false, true],
    },
  ];
  let current = cases[0];
  await page.route("**/api/v1/fixtures/*/stream-sessions/current", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          id: randomUUID(), fixtureId: r.fixtureId, mode: "passthrough", overlay: null, state: "completed", desiredState: "ending",
          failReason: null, health: null, ingest: null, output: null, balance: 2, startedAt, endedAt, replayUrl: current.replayUrl, replayParts: current.parts,
          target: { id: randomUUID(), kind: "youtube", label: "Riverside FC" }, fixtureDecided: true, fixtureHeld: false,
          endReason: "stopped", creditUsed: true, startCause: "organiser", restart: null, countdown: null,
        },
      }),
    }),
  );
  let rowsRead = 0;
  let casesWalked = 0;
  for (const c of cases) {
    current = c;
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
      const body = await openPhoneTab(page, r);
      const area = body.getByTestId("stream-replay-row");
      await expect(area, `${c.name} at ${w}: the ended card draws the replay area`).toBeVisible({ timeout: NAV_MS });
      const items = area.getByTestId("stream-replay-item");
      await expect(items, `${c.name} at ${w}: one item per part, then the club's own link`).toHaveCount(c.hrefs.length);
      for (const [i, href] of c.hrefs.entries()) {
        const link = items.nth(i).getByTestId("stream-replay");
        await expect(link, `${c.name} at ${w} #${i}: where it leads`).toHaveAttribute("href", href);
        // Told apart by TEXT: the club's own link says "Your stream link", never a second "Watch replay".
        await expect(link, `${c.name} at ${w} #${i}: what it says`).toHaveText(c.labels[i]);
        await expectTappable(link, `${c.name} link #${i} at ${w}`);
        await expectTappable(items.nth(i).getByTestId("stream-replay-copy"), `${c.name} Copy link #${i} at ${w}`);
        // A private part says so; a public part and the club's own link carry no note. Asserted per item, in both directions.
        const note = items.nth(i).getByTestId("stream-replay-private");
        if (c.notes[i]) await expect(note, `${c.name} at ${w} #${i}: the private note`).toHaveText(en("streaming.youtube.replay.private"));
        else await expect(note, `${c.name} at ${w} #${i}: no note`).toHaveCount(0);
        rowsRead++;
      }
      // Part labels only beside two or more parts; the times line says it is the latest session's only then.
      await expect(area.getByTestId("stream-replay-part"), `${c.name} at ${w}: part labels`).toHaveText(c.partLabels);
      const times = area.getByTestId("stream-replay-times");
      await expect(times).toHaveText(/\d{1,2}:\d{2}.+\d{1,2}:\d{2}/);
      const latest = en("stream.replay.latestSession", { times: "" }).trim();
      if (c.latest) await expect(times, `${c.name} at ${w}: the times line names the latest session`).toContainText(latest);
      else await expect(times, `${c.name} at ${w}: one replay, so the times line is just when it ran`).not.toContainText(latest);
      // The mark follows the LINK: a YouTube part wears the official icon (inside the link), the club's own link wears none.
      expect(await expectOfficialIcons(area, `${c.name} at ${w}`), `${c.name} at ${w}: one icon per YouTube link`).toBe(c.icons);
      if (c.name === "one-part-club-link") await expectNoYoutubeLogo(items.nth(1), `the club's own link at ${w}`);
      await expectNoPageScroll(page, `the replay parts (${c.name}) at ${w}`);
      await shot(page, `panel-replay-${c.name}-${w}`);
    }
    casesWalked++;
  }
  expect(casesWalked, "anti-vacuity: every shape was walked").toBe(cases.length);
  expect(rowsRead, "anti-vacuity: every link of every shape was read at every width").toBe(WIDTHS.length * cases.reduce((n, c) => n + c.hrefs.length, 0));
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Disconnect (T18): the confirm, the refusal while a match is using the channel, the disconnected state, and the
//    restricted Streaming page an org keeps after it has lost Go live
// ---------------------------------------------------------------------------------------------------------------------
const connectionState = (connectionId: string) =>
  withDb((sql) => sql<{ status: string; tokenGone: boolean; archived: number }[]>`
    select c.status, c.refresh_token_enc is null as "tokenGone",
           (select count(*)::int from org_stream_targets t where t.youtube_connection_id = c.id and t.archived_at is not null) as archived
      from org_youtube_connections c where c.id = ${connectionId}`).then((rows) => rows[0]!);

/** The nav is pinned to the top of the VIEWPORT whatever the page's scroll (it is `sticky top-0`), and nothing but a modal sits over it.
 *  At 320 these pages scroll (Playwright scrolls the Disconnect button into view), which is what once looked like a blank band above
 *  the nav in a full-page capture: this is the evidence that the app does not have one. */
async function expectNavPinned(page: Page, where: string): Promise<void> {
  const s = await page.evaluate(() => {
    const h = document.querySelector("header");
    const at = document.elementFromPoint(160, 10);
    return { headerTop: h ? h.getBoundingClientRect().top : null, overHeader: !!at?.closest("header"), modal: !!document.querySelector('[role="alertdialog"]') };
  });
  expect(s.headerTop, `${where}: the nav is at the top of the viewport`).not.toBeNull();
  expect(Math.abs(s.headerTop!), `${where}: the nav is at the top of the viewport (was ${s.headerTop})`).toBeLessThanOrEqual(0.5);
  if (!s.modal) expect(s.overHeader, `${where}: the nav, not blank page, is what is at the top of the screen`).toBe(true);
}

/** Sideways room for a dialog: its box sits inside the viewport on both sides. */
async function expectInsideViewport(loc: Locator, page: Page, where: string): Promise<void> {
  const box = await loc.boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box, `${where}: measurable`).not.toBeNull();
  expect(box!.x, `${where}: starts inside the viewport`).toBeGreaterThanOrEqual(-0.5);
  expect(box!.x + box!.width, `${where}: ends inside the viewport`).toBeLessThanOrEqual(vw + 0.5);
}

test("Disconnect - the confirm dialog, the refusal while a match is using the channel, and the disconnected state - at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: WIDTHS.length * 8, acts: WIDTHS.length * 16 }));
  const r = await rig(page, { match: true });
  let confirmed = 0;
  let refused = 0;
  let disconnected = 0;
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    await open(page, "/streaming");
    const ch = channel(`Riverside Live ${w}`);
    await connectChannel(page, [ch], "youtube-connect-empty");
    const row = page.getByTestId("youtube-channel-row");
    await expect(row).toHaveCount(1, { timeout: NAV_MS });
    const connectionId = (await row.getAttribute("data-connection-id"))!;
    // A match is using the channel: SQL puts a `bound` broadcast on the rig's fixture (the shape of Go live mid-admission); the end rule
    // says "not due". Deleted below, once the refusal has been seen.
    await withDb((sql) => sql`
      insert into youtube_broadcasts (made_for_kids, org_id, connection_id, fixture_id, title, privacy, state)
      values (false, ${r.orgId}, ${connectionId}, ${r.fixtureId!}, ${"disconnect shots " + w}, 'unlisted', 'bound')`);
    // Premise (B6 batch review N2): the refusal shot below only means something if a match really holds the channel. Read the row back.
    const held = () => withDb((sql) => sql<{ n: number }[]>`
      select count(*)::int as n from youtube_broadcasts where connection_id = ${connectionId} and state = 'bound'`).then((x) => x[0]!.n);
    expect(await held(), `premise at ${w}: a bound broadcast holds the channel`).toBe(1);

    const disconnect = row.getByTestId("youtube-disconnect");
    await waitForHydration(disconnect);
    await expect(disconnect, `the row's action at ${w}`).toHaveText(en("streaming.youtube.action.disconnect"));
    await expectTappable(disconnect, `Disconnect at ${w}`);
    await expectNoPageScroll(page, `the row with Disconnect at ${w}`);
    await expectNavPinned(page, `the row at ${w}`);
    await shot(page, `disconnect-row-${w}`);

    // (1) The confirm: names the channel, says what goes and what stays; both buttons reachable; Cancel changes nothing.
    await disconnect.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(en("streaming.youtube.disconnect.title", { name: ch.title }));
    await expect(dialog).toContainText(en("streaming.youtube.disconnect.body"));
    const confirmBtn = dialog.getByRole("button", { name: en("streaming.youtube.disconnect.confirm"), exact: true });
    const cancelBtn = dialog.getByRole("button", { name: en("streamDest.cancel"), exact: true });
    await expectTappable(confirmBtn, `the confirm button at ${w}`);
    await expectTappable(cancelBtn, `the cancel button at ${w}`);
    await expectInsideViewport(dialog, page, `the dialog at ${w}`);
    await expectNoPageScroll(page, `the dialog open at ${w}`);
    await expectNavPinned(page, `the confirm at ${w}`);
    await shot(page, `disconnect-confirm-${w}`);
    await cancelBtn.click();
    await expect(dialog, "Cancel closes it").toHaveCount(0);
    expect((await connectionState(connectionId)).status, `Cancel at ${w} changed nothing`).toBe("connected");
    confirmed++;

    // (2) Confirm while the match is using it: the refusal is a sentence in the row, and nothing was disconnected.
    await disconnect.click();
    await dialog.getByRole("button", { name: en("streaming.youtube.disconnect.confirm"), exact: true }).click();
    await expect(row.getByTestId("youtube-error")).toHaveText(en("streaming.youtube.error.inUse"));
    expect(await connectionState(connectionId), `refused at ${w}: still connected, token kept, destination not archived`).toEqual({ status: "connected", tokenGone: false, archived: 0 });
    await expectNoPageScroll(page, `the refusal at ${w}`);
    await expectNavPinned(page, `the refusal at ${w}`);
    await shot(page, `disconnect-in-use-${w}`);
    refused++;

    // (3) The match is over: the same tap now disconnects. The channel leaves the list; the page keeps the news.
    await withDb((sql) => sql`delete from youtube_broadcasts where connection_id = ${connectionId}`);
    expect(await held(), `premise at ${w}: the match is over - nothing holds the channel`).toBe(0);
    await disconnect.click();
    await dialog.getByRole("button", { name: en("streaming.youtube.disconnect.confirm"), exact: true }).click();
    const notice = page.getByTestId("youtube-disconnected");
    await expect(notice).toContainText(en("streaming.youtube.disconnect.done", { name: ch.title }));
    // m6: the button that asked left with the row; the news takes focus, so a keyboard or screen-reader user is not dropped at the top.
    await expect(notice, `focus follows the news at ${w}`).toBeFocused();
    await expect(page.getByTestId("youtube-channel-row"), "the channel left the list").toHaveCount(0);
    // F5: connecting this channel raised "YouTube channel connected."; it must not sit above "X is disconnected", and a reload must not bring it back
    await expect(page.getByTestId("youtube-landing"), `the stale connect banner is gone at ${w}`).toHaveCount(0);
    await expect(page, `its query is cleared at ${w}`).toHaveURL(/\/streaming$/);
    expect(await connectionState(connectionId), `disconnected at ${w}: revoked, token gone, destination archived`).toEqual({ status: "revoked", tokenGone: true, archived: 1 });
    await expectTappable(page.getByTestId("youtube-disconnected-dismiss"), `Dismiss at ${w}`);
    await expectNoPageScroll(page, `the disconnected page at ${w}`);
    await expectNavPinned(page, `the disconnected page at ${w}`);
    await shot(page, `disconnect-done-${w}`);
    await page.getByTestId("youtube-disconnected-dismiss").click();
    await expect(notice, "Dismiss clears the news").toHaveCount(0);
    disconnected++;
  }
  expect([confirmed, refused, disconnected], "anti-vacuity: every width walked the whole path").toEqual([WIDTHS.length, WIDTHS.length, WIDTHS.length]);
});

/** The fake YouTube's control route (the e2e server runs YOUTUBE_DRIVER=fake): one op, its `data` back. */
async function fakeOp(page: Page, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await page.request.post("/api/internal/youtube/fake", { data: body });
  expect(res.status(), `SETUP: the fake takes ${String(body.op)}`).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

test("Disconnect that could not check the channel's stream keys (fix 2026-10-30): the keys-left notice, never \"deleted\" - at 1280, 768 and 320", async ({ page }) => {
  // The longest copy the notice has: the keys could not be checked (YouTube would not list the channel's streams) AND Google did not
  // answer the revoke, so the lead sentence is the keys' and the revoke's own sentence, with its Google link, follows it. The count
  // variant ("couldn't delete N stream keys") needs a pooled key on the fake channel, which only a Go live makes; its copy is the same
  // shape and is pinned in every locale by youtube-connect-panel.test.tsx and through the real route by youtube-connect-seam.test.tsx.
  test.setTimeout(budget({ navs: WIDTHS.length * 4, acts: WIDTHS.length * 12 }));
  const r = await rig(page, { match: true });
  let walked = 0;
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    await open(page, "/streaming");
    const ch = channel(`Riverside Keys ${w}`);
    await connectChannel(page, [ch], "youtube-connect-empty");
    const row = page.getByTestId("youtube-channel-row");
    await expect(row).toHaveCount(1, { timeout: NAV_MS });
    // Scoped to THIS channel's grant, so a disconnect another worker runs beside this one never takes the failures.
    const state = await fakeOp(page, { op: "state", fixtureId: r.fixtureId! });
    const tokenHandle = state.tokenHandle;
    expect(typeof tokenHandle, `PREMISE at ${w}: the fixture's destination is this channel, so the fake can name its grant`).toBe("string");
    await fakeOp(page, { op: "failNext", method: "listStreams", code: "youtube_unavailable", reason: "backendError", tokenHandle });
    await fakeOp(page, { op: "failNext", method: "revoke", code: "youtube_unavailable", reason: "backendError", tokenHandle });

    const disconnect = row.getByTestId("youtube-disconnect");
    await waitForHydration(disconnect);
    await disconnect.click();
    await page.getByRole("alertdialog").getByRole("button", { name: en("streaming.youtube.disconnect.confirm"), exact: true }).click();
    const notice = page.getByTestId("youtube-disconnected");
    await expect(notice).toContainText(en("streaming.youtube.disconnect.keysUnchecked", { name: ch.title }));
    await expect(notice).toContainText(en("streaming.youtube.disconnect.keysTail.unconfirmed", { link: en("streaming.youtube.disconnect.googleLink") }));
    await expect(notice, `never "deleted" while a key may be left, at ${w}`).not.toContainText("Seazn deleted what it stored");
    await expect(notice).toHaveAttribute("data-keys-left", "unknown");
    await expect(notice).toHaveAttribute("data-outcome", "not_confirmed");
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice, `focus follows the news at ${w}`).toBeFocused();
    await expect(page.getByTestId("youtube-channel-row"), "the channel left the list").toHaveCount(0);
    await expect(notice.getByTestId("youtube-disconnected-google-link"), `the revoke's Google link at ${w} (an inline link in the sentence)`).toBeVisible();
    await expectTappable(page.getByTestId("youtube-disconnected-dismiss"), `Dismiss at ${w}`);
    await expectNoPageScroll(page, `the keys-left notice at ${w}`);
    await expectNavPinned(page, `the keys-left notice at ${w}`);
    await shot(page, `disconnect-keys-unchecked-${w}`);
    await page.getByTestId("youtube-disconnected-dismiss").click();
    await expect(notice, "Dismiss clears the news").toHaveCount(0);
    walked++;
  }
  expect(walked, "anti-vacuity: every width walked the whole path").toBe(WIDTHS.length);
});

test("Disconnect stays reachable after the org loses Go live - the restricted Streaming page, then a 404 once nothing is left - at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: WIDTHS.length * 3 + 12, acts: 40 }));
  const r = await rig(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "/streaming");
  const a = channel("Riverside FC");
  const b = channel("Riverside Juniors");
  await connectChannel(page, [a], "youtube-connect-empty");
  await expect(page.getByTestId("youtube-channel-row")).toHaveCount(1, { timeout: NAV_MS });
  await connectChannel(page, [b], "youtube-connect");
  await expect(page.getByTestId("youtube-channel-row")).toHaveCount(2, { timeout: NAV_MS });

  // The org loses streaming (no overlay, no relay): the same two overrides the route test uses. There is no cache in front of the
  // entitlements here (REDIS_URL is unset locally and in CI), so the next request reads them.
  await withDb(async (sql) => {
    for (const feature of ["streaming.overlay", "streaming.relay"]) {
      await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
                values (${r.orgId}, ${feature}, false, 'disconnect shots') on conflict (org_id, feature_key) do update set bool_value = false`;
    }
  });

  let walked = 0;
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    await open(page, "/streaming");
    const panel = page.getByTestId("stream-disconnect-only");
    await expect(panel, `the restricted page at ${w}`).toBeVisible();
    await expect(page.getByTestId("nav-streaming"), `the nav still offers the page at ${w}`).toHaveCount(1);
    await expect(page.getByTestId("stream-disconnect-only-note")).toHaveText(en("streaming.youtube.disconnectOnly.note"));
    const rows = page.getByTestId("youtube-channel-row");
    await expect(rows).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const row = rows.nth(i);
      await expectTappable(row.getByTestId("youtube-disconnect"), `Disconnect #${i} at ${w}`);
      for (const id of ["youtube-settings", "youtube-reconnect", "youtube-review-terms", "youtube-channel-line"]) {
        await expect(row.getByTestId(id), `${id} is not on the restricted row #${i} at ${w}`).toHaveCount(0);
      }
    }
    for (const id of ["youtube-connect", "youtube-connect-empty", "stream-dest-add", "stream-dest-empty"]) {
      await expect(page.getByTestId(id), `${id} is not on the restricted page at ${w}`).toHaveCount(0);
    }
    await expectNoPageScroll(page, `the restricted page at ${w}`);
    await shot(page, `disconnect-only-${w}`);
    walked++;
  }
  expect(walked, "anti-vacuity: every width").toBe(WIDTHS.length);

  // Disconnect both from this page: the first leaves one, the second leaves the empty line - and the page is not re-read (a re-read
  // would be the 404 an org with nothing to disconnect gets).
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "/streaming");
  const rows = page.getByTestId("youtube-channel-row");
  await waitForHydration(rows.first().getByTestId("youtube-disconnect"));
  for (const [left, name] of [[1, a.title], [0, b.title]] as const) {
    await rows.first().getByTestId("youtube-disconnect").click();
    await page.getByRole("alertdialog").getByRole("button", { name: en("streaming.youtube.disconnect.confirm"), exact: true }).click();
    await expect(rows).toHaveCount(left);
    await expect(page.getByTestId("youtube-disconnected")).toContainText(en("streaming.youtube.disconnect.done", { name }));
    await expect(page.getByTestId("youtube-disconnected"), `focus follows the news on the restricted page too (${name})`).toBeFocused();
  }
  await expect(page.getByTestId("stream-disconnect-only-empty")).toHaveText(en("streaming.youtube.disconnectOnly.none"));
  // F7: the last one took the page's own nav with it - the page re-rendered at the emptied URL (not the 404), and what the person was
  // told is still on screen, so the nav no longer offers a link that would 404 and the confirmation was not swapped for a 404.
  await expect(page, "still on the page, at the emptied address").toHaveURL(/\/streaming\?disconnected=1$/);
  await expect(page.getByTestId("nav-streaming"), "the nav dropped the item without a reload").toHaveCount(0);
  await expect(page.getByTestId("youtube-disconnected"), "the news is still there").toContainText(en("streaming.youtube.disconnect.done", { name: b.title }));
  await expect(page.getByTestId("stream-disconnect-only-empty"), "and the empty line").toHaveText(en("streaming.youtube.disconnectOnly.none"));
  await expectNoPageScroll(page, "the restricted page, emptied");
  await shot(page, "disconnect-only-empty-1280");
  const left = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from org_youtube_connections where org_id = ${r.orgId} and status <> 'revoked'`);
  expect(left[0]!.n, "both connections are revoked").toBe(0);

  // Nothing left to disconnect, and no Go live: the page is the 404 it always was, and the nav no longer offers it.
  const gone = await page.goto("/streaming", { waitUntil: "load" });
  expect(gone?.status(), "an org with nothing to disconnect and no Go live gets the 404").toBe(404);
  await page.goto("/dashboard", { waitUntil: "load" });
  await declineCookies(page);
  await expect(page.getByTestId("nav-streaming"), "the nav no longer offers Streaming").toHaveCount(0);
});
