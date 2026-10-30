import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { activeOrg, apiJson, claimProfileBySql, loginUi } from "./helpers";

// Screenshot + layout evidence for the top-nav Streaming page and YouTube Connect on it (T9; owner 2026-10-27, spec D3: Streaming is
// its own page, between Directory and Settings in the nav; the Directory keeps four tabs).
//
// Walked as a first-time visitor (own empty storageState + a login per test, which auto-provisions an org) so it runs with --no-deps. The
// round trip to Google is the FAKE YouTube (YOUTUBE_DRIVER=fake, e2e.yml): the consent form posts to the real route, the real
// route redirects to the fake authorize hop, the hop returns to the real callback, and the page lands on `/streaming?youtube=<code>`.
//
// What this spec adds over the unit tests (which cannot see layout, real tap area, or a browser serialising a form):
//   * the nav item exists and the gantry still FITS - one row, nothing past the viewport - at the widths the owner's budget is measured at,
//     in all four locales' labels (the longest of them is the one that wraps);
//   * the Streaming page, the consent step, the picker and every connection-row state at 1280, 768 and 320 with no sideways page scroll;
//   * a 43-character channel name (the realistic stress for a truncating row) does not widen the page;
//   * the real consent step really gates Continue, and a real fake-Google round trip really lands a connected row and a banner.
test.use({ storageState: { cookies: [], origins: [] } });

const SHOTS = process.env.YOUTUBE_SHOTS_DIR ?? resolve(process.cwd(), "../../.superpowers/sdd/shots/youtube-streaming");
const WIDTHS = [1280, 768, 320] as const;
/** The nav budget is measured here: the phone floor and the width just above it (335 was 3px over), the dual-role link's own threshold (350),
 *  the widths around `md`/`lg` where the labels appear (768-836 is where fr/nl Sign-out was pushed out), and desktop. Every one must FIT. */
const NAV_WIDTHS = [320, 335, 350, 360, 390, 640, 700, 768, 800, 836, 1023, 1024, 1280] as const;

const BANNER_WAIT_MS = 5_000;
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

// Budget - derived, never a flat literal (AGENTS.md class 20).
const NAV_MS = 20_000;
const ACT_MS = 5_000;
const budget = (c: { navs: number; acts: number }): number => Math.max(60_000, c.navs * NAV_MS + c.acts * ACT_MS);

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

/** The label that wraps a radio or checkbox: the input itself is 16px, the label is the thumb's target. */
const labelOf = (input: Locator): Locator => input.locator("xpath=ancestor::label[1]");

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

/** `first` precedes `second` in reading order as LAID OUT: on one row it sits to the left, stacked it sits above. */
async function expectReadsBefore(first: Locator, second: Locator, label: string): Promise<void> {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  expect(a !== null && b !== null, `${label}: both are laid out`).toBe(true);
  const sameRow = Math.abs(a!.y - b!.y) < 2;
  expect(sameRow ? a!.x < b!.x : a!.y < b!.y, `${label}: ${JSON.stringify({ first: a, second: b })}`).toBe(true);
}

/** The top gantry fits: every link in its <nav> shares one row (no wrap) and ends inside the viewport (nothing clipped or pushed), the
 *  Sign-out button (the control that used to be pushed out) ends inside it too, and each link's centre hit-tests to the link itself. */
async function expectGantryFits(page: Page, where: string): Promise<void> {
  const seen = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("header.app-gantry nav a")).filter((a) => {
      const r = a.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const rects = links.map((a) => a.getBoundingClientRect());
    const tops = rects.map((r) => Math.round(r.top));
    const header = document.querySelector("header.app-gantry")!.getBoundingClientRect();
    const signOut = document.querySelector("header.app-gantry button[title]")!.getBoundingClientRect();
    const covered = links.filter((a) => {
      const r = a.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !(at !== null && (at === a || a.contains(at)));
    }).length;
    return {
      vw: document.documentElement.clientWidth,
      signOutRight: signOut.right,
      covered,
      n: links.length,
      tops,
      maxRight: Math.max(...rects.map((r) => r.right)),
      headerScrollW: document.querySelector("header.app-gantry")!.scrollWidth,
      headerH: Math.round(header.height),
      testids: links.map((a) => (a as HTMLElement).dataset.testid ?? ""),
    };
  });
  expect(seen.n, `${where}: the gantry has links to measure`).toBeGreaterThanOrEqual(3);
  expect(seen.testids, `${where}: the Streaming item is among them`).toContain("nav-streaming");
  expect(new Set(seen.tops).size, `${where}: the nav links wrap onto ${new Set(seen.tops).size} rows (tops ${seen.tops.join(",")})`).toBe(1);
  expect(seen.maxRight, `${where}: the last nav link ends at ${Math.round(seen.maxRight)}px of ${seen.vw}px`).toBeLessThanOrEqual(seen.vw + 1);
  expect(seen.headerScrollW, `${where}: the gantry scrolls sideways (${seen.headerScrollW} > ${seen.vw})`).toBeLessThanOrEqual(seen.vw + 1);
  expect(seen.signOutRight, `${where}: Sign out ends at ${Math.round(seen.signOutRight)}px of ${seen.vw}px`).toBeLessThanOrEqual(seen.vw);
  expect(seen.covered, `${where}: ${seen.covered} nav link(s) have something else painted over their centre`).toBe(0);
}

async function expectNoSeriousAxe(page: Page, where: string): Promise<void> {
  const AxeBuilder = (await import("@axe-core/playwright")).default;
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id} - ${v.nodes[0]?.html}`), `axe serious/critical ${where}`).toEqual([]);
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

/** A fresh signed-in owner with a fresh org of its own (the org gets the plan's streaming entitlements). */
async function rig(page: Page, tag: string): Promise<{ orgId: string; orgSlug: string; email: string }> {
  const email = `delivered+yt-${tag}-${Date.now()}@resend.dev`;
  await loginUi(page, email, "/");
  const created = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", { name: `YT Streaming ${tag} ${Date.now()}` });
  await apiJson(page.request, "/api/orgs/active", "POST", { org_id: created.data!.id });
  const org = await activeOrg(page);
  return { orgId: org.id, orgSlug: org.slug, email };
}

/** A pasted-key destination, made over the API (the same call the Add form makes). */
async function addKeyDestination(page: Page, orgId: string, label: string): Promise<void> {
  const res = await apiJson(page.request, `/api/v1/orgs/${orgId}/stream-targets`, "POST", { kind: "youtube", label, streamKey: `yt9-${randomUUID()}-key` });
  expect(res.status, "SETUP: a pasted-key destination is added").toBe(201);
}

/** Channel ids unique to this run: the fake numbers its fresh channels from 1, and the database outlives it. */
const channel = (title: string) => ({ id: `UC${randomUUID().replace(/-/g, "").slice(0, 22)}`, title });

/** What the helper below was last told to offer for a page, and how many connects it has served. */
const offers = new WeakMap<Page, { channels: { id: string; title: string }[]; fired: number }>();
/** Tell the fake YouTube which channels the NEXT grant (the one this OAuth `state` mints) has, BEFORE the browser follows the redirect to
 *  the fake authorize hop. The route is installed once per page; a later call only changes what it offers.
 *
 *  It routes the ORIGINAL form POST to `/api/youtube/connect` - the only request of this flow Playwright hands to a handler. The hop that
 *  follows is a 303 REDIRECT target, and a route handler is called for the first URL of a redirect chain only: a handler on
 *  `fake-authorize` never ran, so the fake fell back to "Fake Channel n" and every step below that needs a chosen channel was inert. So:
 *  let the start run with `maxRedirects: 0`, read the `state` out of its Location, post the control `setChannels` for that state, then
 *  fulfil the browser with the very response the start gave (303, Location and both OAuth cookies intact). `**` + the exact path, so the
 *  callback (`/api/youtube/connect/callback`) is not matched. `connectThroughConsent` asserts the helper ran once per connect. */
async function offerChannels(page: Page, channels: { id: string; title: string }[]): Promise<void> {
  const installed = offers.get(page);
  if (installed) {
    installed.channels = channels;
    return;
  }
  const slot = { channels, fired: 0 };
  offers.set(page, slot);
  await page.route("**/api/youtube/connect", async (route) => {
    const start = await route.fetch({ maxRedirects: 0 });
    expect(start.status(), "SETUP: the start answers with the 303 to the authorize hop").toBe(303);
    const state = new URL(start.headers()["location"] ?? "", "http://localhost").searchParams.get("state");
    expect(state, "SETUP: the start's Location carries the OAuth state").toBeTruthy();
    const res = await page.request.post("/api/internal/youtube/fake", { data: { op: "setChannels", channels: slot.channels, state } });
    expect(res.status(), "SETUP: the fake accepts the channels for this state").toBe(200);
    slot.fired++;
    await route.fulfill({ response: start });
  });
}

/** Open the consent step, tick, and press Continue: the real form POST, the real route, the fake Google, the real callback. The channel offer
 *  must have been installed (`offerChannels`) and must have run exactly once for this connect: a helper that silently did nothing is the
 *  failure this guards (the fake would mint "Fake Channel n" and the steps that read a chosen title would be asserting a fixture). */
async function connectThroughConsent(page: Page): Promise<void> {
  const slot = offers.get(page);
  expect(slot, "SETUP: offerChannels ran before this connect").toBeDefined();
  const before = slot!.fired;
  const submit = page.getByTestId("youtube-connect-submit");
  await expect(submit, "Continue is disabled until the box is ticked").toBeDisabled();
  await page.getByTestId("youtube-consent").check();
  await expect(submit).toBeEnabled();
  await Promise.all([page.waitForURL(/\/streaming\?youtube=/), submit.click()]);
  await declineCookies(page);
  expect(slot!.fired - before, "the channel offer ran once for this connect (the fake was told which channels this state mints)").toBe(1);
}

// ---------------------------------------------------------------------------------------------------------------------
// The nav item
// ---------------------------------------------------------------------------------------------------------------------
test("Streaming nav item: present between Directory and Settings, and the gantry fits at every width (all four locales' labels)", async ({ page }) => {
  test.setTimeout(budget({ navs: NAV_WIDTHS.length * 2 + 4, acts: 12 }));
  const { orgSlug } = await rig(page, "nav");

  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "/streaming");
  const link = page.getByTestId("nav-streaming");
  await expect(link, "the Streaming nav item").toBeVisible();
  await expect(link).toHaveAttribute("href", "/streaming");
  await expect(link).toHaveAttribute("aria-label", dictOf("console")["nav.streaming"] ?? "");
  // Order: Directory, Streaming, Settings.
  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll("header.app-gantry nav a")).map((a) => a.getAttribute("href") ?? ""),
  );
  const at = (needle: string) => order.findIndex((h) => h.startsWith(needle));
  expect(at("/directory"), "Directory is in the nav").toBeGreaterThan(-1);
  expect(at("/directory")).toBeLessThan(at("/streaming"));
  expect(at("/streaming")).toBeLessThan(at(`/o/${orgSlug}/settings`));
  await shot(page, "nav-1280");

  // The page the item leads to is the Streaming one (the nav marks no current item, so the heading is the proof).
  await expect(page.getByRole("heading", { level: 1, name: en("streaming.title") })).toBeVisible();

  // The gantry fits at the budget widths in the dashboard's labels, and then with each locale's (longer) words on the Streaming page.
  for (const w of NAV_WIDTHS) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(150);
    await expectGantryFits(page, `en at ${w}`);
  }
  for (const locale of ["es", "fr", "nl"] as const) {
    await page.context().addCookies([{ name: "seazn_locale", value: locale, url: new URL(page.url()).origin }]);
    await open(page, "/streaming");
    await expect(page.getByTestId("nav-streaming")).toHaveAttribute("aria-label", dictOf("console", locale)["nav.streaming"] ?? "");
    // Below lg Sign out is its icon alone: it is still NAMED, in this locale's words (by role + name, not by its painted text).
    await expect(page.locator("header.app-gantry").getByRole("button", { name: dictOf("console", locale)["nav.signOut"] ?? "" })).toBeVisible();
    for (const w of NAV_WIDTHS) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(150);
      await expectGantryFits(page, `${locale} at ${w}`);
    }
  }
});

test("Streaming nav item, dual-role: an organiser who is ALSO a claimed player (five links, labels from lg) fits at every width in all four locales", async ({ page }) => {
  test.setTimeout(budget({ navs: 4 + 2, acts: 12 }));
  const { email } = await rig(page, "navdual");
  // The dual-role seam (nav.tsx isPlayer): a claimed player profile adds the Player home link. Own throwaway account, never a shared identity.
  await claimProfileBySql(email);
  for (const locale of ["en", "es", "fr", "nl"] as const) {
    await page.context().addCookies([{ name: "seazn_locale", value: locale, url: new URL(page.url()).origin }]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/streaming");
    // The locale witness: the page really is in this locale (a cookie that silently failed would measure English four times). The Streaming
    // item's name and, below lg, Sign-out's name (its label is hidden there) come from this locale's own dictionary, by role + name.
    await expect(page.getByTestId("nav-streaming"), `${locale}: the nav speaks ${locale}`).toHaveAttribute("aria-label", dictOf("console", locale)["nav.streaming"] ?? "");
    await expect(
      page.locator("header.app-gantry").getByRole("button", { name: dictOf("console", locale)["nav.signOut"] ?? "" }),
      `${locale}: Sign out is named in ${locale}`,
    ).toBeVisible();
    const links = await page.locator("header.app-gantry nav a").count();
    expect(links, `${locale}: Dashboard, Directory, Streaming, Settings and Player home`).toBe(5);
    for (const w of NAV_WIDTHS) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(150);
      await expectGantryFits(page, `dual-role ${locale} at ${w}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The page: empty, then with a pasted-key destination
// ---------------------------------------------------------------------------------------------------------------------
test("Streaming page: no destinations, then a pasted key - Add and Connect YouTube side by side, no page scroll at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: 8, acts: 20 }));
  const { orgId } = await rig(page, "empty");

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    await open(page, "/streaming");
    await expect(page.getByRole("heading", { level: 1, name: en("streaming.title") })).toBeVisible();
    const empty = page.getByTestId("stream-dest-empty");
    await expect(empty, "the empty card").toBeVisible();
    await expect(empty).toContainText(en("streamDest.empty"));
    await expect(page.getByTestId("stream-dest-empty-add")).toBeVisible();
    await expect(page.getByTestId("youtube-connect-empty")).toBeVisible();
    await expectTappable(page.getByTestId("youtube-connect-empty"), `Connect YouTube (empty) at ${w}`);
    await expectTappable(page.getByTestId("stream-dest-empty-add"), `Add streaming key (empty) at ${w}`);
    // Owner 2026-10-30: Connect YouTube is the primary button and comes first; Add streaming key is the secondary one after it.
    await expect(page.getByTestId("youtube-connect-empty"), `Connect YouTube (empty) is primary at ${w}`).toHaveClass(/\bbtn-primary\b/);
    await expect(page.getByTestId("stream-dest-empty-add"), `Add streaming key (empty) is secondary at ${w}`).toHaveClass(/\bbtn-ghost\b/);
    await expectReadsBefore(page.getByTestId("youtube-connect-empty"), page.getByTestId("stream-dest-empty-add"), `empty card at ${w}`);
    await expectNoPageScroll(page, `empty Streaming page at ${w}`);
    await shot(page, `page-empty-${w}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "/streaming");
  await expectNoSeriousAxe(page, "on the empty /streaming");

  await addKeyDestination(page, orgId, "Club YouTube (key)");
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    await open(page, "/streaming");
    await expect(page.getByTestId("stream-dest-row")).toHaveCount(1);
    await expect(page.getByTestId("youtube-channel-list"), "no channels yet: no channel group").toHaveCount(0);
    await expect(page.getByTestId("stream-dest-add")).toBeVisible();
    await expect(page.getByTestId("youtube-connect")).toBeVisible();
    await expectTappable(page.getByTestId("youtube-connect"), `Connect YouTube at ${w}`);
    await expect(page.getByTestId("youtube-connect"), `Connect YouTube is primary at ${w}`).toHaveClass(/\bbtn-primary\b/);
    await expect(page.getByTestId("stream-dest-add"), `Add streaming key is secondary at ${w}`).toHaveClass(/\bbtn-ghost\b/);
    await expectReadsBefore(page.getByTestId("youtube-connect"), page.getByTestId("stream-dest-add"), `header row at ${w}`);
    await expectNoPageScroll(page, `Streaming page with a pasted key at ${w}`);
    await shot(page, `page-pasted-${w}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The connect flow, end to end through the fake Google
// ---------------------------------------------------------------------------------------------------------------------
test("Connect YouTube: the consent step gates Continue, one channel connects, several open the picker - consent, picker and connected row at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: 16, acts: 40 }));
  const { orgId } = await rig(page, "connect");
  await addKeyDestination(page, orgId, "Club YouTube (key)");
  const LONG = "Riverside Community Football Club Juniors U12";   // 45 characters: the stress for a truncating row

  // --- the consent step ----------------------------------------------------------------------------------------------
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    await open(page, "/streaming");
    await page.getByTestId("youtube-connect").click();
    const form = page.getByTestId("youtube-connect-form");
    await expect(form, "the consent step opens inline").toBeVisible();
    await expect(page.getByTestId("youtube-privacy-unlisted"), "Unlisted preselected").toBeChecked();
    await expect(page.getByTestId("youtube-kids-no"), "made-for-kids No preselected").toBeChecked();
    await expect(page.getByTestId("youtube-connect-submit")).toBeDisabled();
    await expect(page.getByTestId("youtube-consent-required")).toHaveText(en("streaming.youtube.consent.required"));
    await expect(form).toContainText(en("streaming.youtube.settingsNote"));
    // YouTube's under-16 live rule is a clause of what the organiser ticks (PO 2026-10-30, owner-requested): inside the consent box's
    // own label, which sits above Continue at every width; the separate note #1089 added is gone. The clause is typed from the ruling.
    const consentLabel = labelOf(page.getByTestId("youtube-consent"));
    await expect(consentLabel, "the under-16 clause is part of the consent").toContainText("makes sure an adult is visibly present whenever players under 16 are on camera");
    await expect(page.getByTestId("youtube-minors-note"), "no separate note any more").toHaveCount(0);
    const [labelBox, continueBox] = [await consentLabel.boundingBox(), await page.getByTestId("youtube-connect-submit").boundingBox()];
    expect(labelBox && continueBox && labelBox.y + labelBox.height <= continueBox.y, `the consent label is read before Continue at ${w}`).toBe(true);
    for (const id of ["youtube-privacy-unlisted", "youtube-privacy-public", "youtube-privacy-private", "youtube-kids-no", "youtube-kids-yes", "youtube-consent"]) {
      await expectTappable(labelOf(page.getByTestId(id)), `${id} at ${w}`);
    }
    await expectTappable(page.getByTestId("youtube-connect-cancel"), `Cancel at ${w}`);
    await expectNoPageScroll(page, `consent step at ${w}`);
    await shot(page, `consent-${w}`);
    if (w === 1280) await expectNoSeriousAxe(page, "on the consent step");
  }
  // The links the law asks for are there and open outside the app.
  const hrefs = await page.getByTestId("youtube-connect-form").locator("a").evaluateAll((as) => as.map((a) => [a.getAttribute("href"), a.getAttribute("rel")]));
  expect(hrefs.map(([h]) => h)).toEqual(["https://www.youtube.com/t/terms", "https://www.youtube.com/t/community_guidelines", "https://www.youtube.com/t/terms", expect.stringMatching(/^\/legal\/privacy/)]);
  for (const [, rel] of hrefs) expect(rel).toBe("noopener noreferrer");

  // --- one channel: ticked, Continue, fake Google, landed connected ----------------------------------------------------
  await page.setViewportSize({ width: 1280, height: 900 });
  const firstChannel = channel(LONG);
  await offerChannels(page, [firstChannel]);
  await connectThroughConsent(page);
  await expect(page).toHaveURL(/\/streaming\?youtube=connected$/);
  const banner = page.getByTestId("youtube-landing");
  await expect(banner).toHaveAttribute("data-code", "connected");
  await expect(banner).toContainText(en("streaming.youtube.landing.connected"));
  const row = page.getByTestId("youtube-channel-row");
  await expect(row, "the connected channel is listed").toHaveCount(1);
  await expect(row.getByTestId("youtube-channel-title")).toHaveText(LONG);
  await expect(row.getByTestId("youtube-channel-meta")).toContainText(en("streaming.youtube.privacy.unlisted"));
  await expect(row.getByTestId("youtube-channel-status"), "a health check has not run: NEUTRAL, never 'connected'").toHaveText(en("streaming.youtube.status.unknown"));
  await expect(page.getByTestId("stream-dest-row"), "the pasted key is still listed beside it").toHaveCount(1);
  // The two kinds sit in two groups, channels first.
  await expect(page.getByRole("heading", { level: 2, name: en("streaming.youtube.channels") })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: en("streaming.keys.heading") })).toBeVisible();
  // A connected channel has no Rename / Replace key / Remove.
  for (const id of ["stream-dest-rename", "stream-dest-replace", "stream-dest-remove", "stream-dest-menu"]) {
    await expect(row.getByTestId(id), `a connected channel has no ${id}`).toHaveCount(0);
  }
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    await expect(row.getByTestId("youtube-settings")).toBeVisible();
    await expectTappable(row.getByTestId("youtube-settings"), `Settings at ${w}`);
    await expectNoPageScroll(page, `connected channel (long name) at ${w}`);
    await shot(page, `connected-${w}`);
  }
  await expectNoSeriousAxe(page, "on /streaming with a connected channel");
  // Dismissing the banner clears the query.
  await page.getByTestId("youtube-landing-dismiss").click();
  await expect(page).toHaveURL(/\/streaming$/);
  await expect(page.getByTestId("youtube-landing")).toHaveCount(0);

  // --- several channels: the picker ------------------------------------------------------------------------------------------
  const second = channel("Riverside Juniors");
  // The FIRST option carries the long title: a <fieldset>'s UA min-inline-size is min-content, so a long unbreakable title used to push
  // the picker past the card at 320 (clipped, no ellipsis). The loop below asserts no page scroll with it; the 320 block after it
  // asserts the title is cut INSIDE the card.
  await offerChannels(page, [channel(LONG), second]);
  await open(page, "/streaming");
  await page.getByTestId("youtube-connect").click();
  await connectThroughConsent(page);
  await expect(page).toHaveURL(/\/streaming\?youtube=pick&pending=[0-9a-f-]{36}$/);
  const picker = page.getByTestId("youtube-picker");
  await expect(picker).toBeVisible();
  await expect(page.getByTestId("youtube-picker-channel")).toHaveCount(2);
  await expect(page.getByTestId("youtube-picker-connect"), "nothing is preselected").toBeDisabled();
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
    await expectTappable(labelOf(page.getByTestId("youtube-picker-channel").first()), `a channel radio at ${w}`);
    await expectNoPageScroll(page, `channel picker at ${w}`);
    await shot(page, `picker-${w}`);
  }
  // I1 at 320: the long title's box ends inside the picker card, and it is cut with an ellipsis rather than pushed out.
  await page.setViewportSize({ width: 320, height: 700 });
  const pickerTitle = labelOf(page.getByTestId("youtube-picker-channel").first()).locator("span.truncate");
  await expect(pickerTitle).toHaveText(LONG);
  const cardBox = await picker.boundingBox();
  const titleBox = await pickerTitle.boundingBox();
  expect(cardBox, "the picker card is painted").not.toBeNull();
  expect(titleBox, "the title is painted").not.toBeNull();
  expect(titleBox!.x + titleBox!.width, "the title's right edge is inside the card's").toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 0.5);
  expect(await pickerTitle.evaluate((el) => el.scrollWidth > el.clientWidth), "the 45-character title is truncated, not pushed out").toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId("youtube-picker-channel").nth(1).check();
  await page.getByTestId("youtube-picker-connect").click();
  await expect(page).toHaveURL(/\/streaming\?youtube=connected$/);
  await expect(page.getByTestId("youtube-channel-row")).toHaveCount(2);
  await expect(page.getByTestId("youtube-channel-title").filter({ hasText: "Riverside Juniors" })).toHaveCount(1);

  // --- M5: a pick of a channel the org ALREADY has says so, and adds nothing --------------------------------------------------
  await offerChannels(page, [firstChannel, channel("Riverside Veterans")]);
  await open(page, "/streaming");
  await page.getByTestId("youtube-connect").click();
  await connectThroughConsent(page);
  await expect(page).toHaveURL(/\/streaming\?youtube=pick&pending=[0-9a-f-]{36}$/);
  await page.getByTestId("youtube-picker-channel").first().check();
  await page.getByTestId("youtube-picker-connect").click();
  await expect(page).toHaveURL(/\/streaming\?youtube=already_connected$/);
  const already = page.getByTestId("youtube-landing");
  await expect(already).toHaveAttribute("data-code", "already_connected");
  await expect(already).toContainText(en("streaming.youtube.alreadyConnected"));
  await expect(already, "not the plain 'connected' sentence").not.toContainText(en("streaming.youtube.landing.connected"));
  await expect(page.getByTestId("youtube-channel-row"), "no second connection was made").toHaveCount(2);
  await expectNoPageScroll(page, "the already-connected banner");
});

// ---------------------------------------------------------------------------------------------------------------------
// Every row state
// ---------------------------------------------------------------------------------------------------------------------
test("A connected channel's row in every state - connected, not enabled, blocked, not checked, reconnect needed, terms outdated - at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: 12, acts: 40 }));
  const { orgId } = await rig(page, "states");
  const one = channel("Riverside FC");
  await page.setViewportSize({ width: 1280, height: 900 });
  await offerChannels(page, [one]);
  await open(page, "/streaming");
  await page.getByTestId("youtube-connect-empty").click();
  await connectThroughConsent(page);
  await expect(page.getByTestId("youtube-channel-row")).toHaveCount(1);

  // Each state is written to the connection row the way the health sweep and a dead grant write it, then the page is read again.
  const STATES: { name: string; patch: (sql: import("postgres").Sql) => Promise<unknown>; status: string | null; tone: string; line: string; termsLine?: string }[] = [
    { name: "enabled", patch: (sql) => sql`update org_youtube_connections set last_health_at = now(), last_error_code = null where org_id = ${orgId}`, status: en("streaming.youtube.status.connected"), tone: "ok", line: en("streaming.youtube.statusLine.connected") },
    { name: "not-enabled", patch: (sql) => sql`update org_youtube_connections set last_health_at = now(), last_error_code = 'youtube_live_not_enabled' where org_id = ${orgId}`, status: en("streaming.youtube.status.notEnabled"), tone: "warn", line: en("streaming.youtube.statusLine.notEnabled") },
    { name: "blocked", patch: (sql) => sql`update org_youtube_connections set last_health_at = now(), last_error_code = 'youtube_live_blocked' where org_id = ${orgId}`, status: en("streaming.youtube.status.blocked"), tone: "bad", line: en("streaming.youtube.statusLine.blocked") },
    { name: "not-checked", patch: (sql) => sql`update org_youtube_connections set last_health_at = null, last_error_code = null where org_id = ${orgId}`, status: en("streaming.youtube.status.unknown"), tone: "neutral", line: en("streaming.youtube.statusLine.unknown") },
    { name: "reconnect", patch: (sql) => sql`update org_youtube_connections set status = 'reconnect_needed', status_since = now() where org_id = ${orgId}`, status: en("streaming.youtube.status.reconnectNeeded"), tone: "bad", line: en("streaming.youtube.statusLine.reconnectNeeded") },
    { name: "terms-outdated", patch: (sql) => sql`update org_youtube_connections set status = 'connected', status_since = now(), consent_version = 0 where org_id = ${orgId}`, status: en("streaming.youtube.status.unknown"), tone: "neutral", line: en("streaming.youtube.statusLine.unknown"), termsLine: en("streaming.youtube.statusLine.reviewTerms") },
  ];
  let checked = 0;
  for (const s of STATES) {
    await withDb(async (sql) => { await s.patch(sql); });
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
      await open(page, "/streaming");
      const row = page.getByTestId("youtube-channel-row");
      await expect(row, s.name).toHaveCount(1);
      await expect(row, s.name).toHaveAttribute("data-tone", s.tone);
      if (s.status) await expect(row.getByTestId("youtube-channel-status"), s.name).toHaveText(s.status);
      await expect(row.getByTestId("youtube-channel-line"), s.name).toContainText(s.line);
      if (s.name === "not-enabled") await expect(row.getByTestId("youtube-channel-hint")).toContainText(en("streaming.youtube.notEnabledHint"));
      if (s.termsLine) {
        await expect(row.getByTestId("youtube-channel-terms-line"), s.name).toContainText(s.termsLine);
        await expect(row.getByTestId("youtube-review-terms")).toBeVisible();
      } else {
        await expect(row.getByTestId("youtube-channel-terms-line"), s.name).toHaveCount(0);
      }
      if (s.name === "reconnect") await expectTappable(row.getByTestId("youtube-reconnect"), `Reconnect at ${w}`);
      await expectNoPageScroll(page, `row state ${s.name} at ${w}`);
      await shot(page, `state-${s.name}-${w}`);
    }
    checked++;
  }
  expect(checked, "every state was walked").toBe(STATES.length);

  // Review updated terms: the wording is shown, Accept stays disabled until ticked, and accepting clears the notice.
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "/streaming");
  await page.getByTestId("youtube-review-terms").click();
  const terms = page.getByTestId("youtube-terms-form");
  await expect(terms).toBeVisible();
  await expect(page.getByTestId("youtube-terms-accept")).toBeDisabled();
  await shot(page, "review-terms-1280");
  await terms.getByTestId("youtube-consent").check();
  await page.getByTestId("youtube-terms-accept").click();
  await expect(page.getByTestId("youtube-review-terms"), "the notice is gone once accepted").toHaveCount(0);
  await expect(page.getByTestId("youtube-channel-terms")).toHaveCount(0);

  // Settings: change the visibility and read it back.
  await page.getByTestId("youtube-settings").click();
  await page.getByTestId("youtube-privacy-public").check();
  await page.getByTestId("youtube-settings-save").click();
  await expect(page.getByTestId("youtube-channel-meta")).toContainText(en("streaming.youtube.privacy.public"));
});
