import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  activeOrg,
  apiJson,
  invalidateOrgEntitlements,
  loginUi,
  setBoolEntitlementOverrideSql,
} from "./helpers";
import { seedOverlayFixture } from "./overlay-kit";
import { seedStreamHistory } from "./helpers/stream-history-seed";
import { STREAM_CREDIT_PACKS } from "../src/lib/stream-credit-packs";
import { STREAM_HISTORY_CSV_HEADER } from "../src/server/usecases/stream-credit-history-csv";

// Screenshot + axe evidence for Settings -> Credits, which has two sides: AI (the default, and what every old link opens)
// and Streaming (`?kind=stream`, owner decision 2026-10-20, Option A). Own empty storageState + a login per test
// (auto-provisions an org, which gets a bootstrap credit grant) so it runs with --no-deps.
//
// The Streaming side is walked two ways: with a realistic ledger (every row kind, a long entrant name, past one page, the
// export, the buy tiles opening the checkout), and for an org whose plan does not stream (the empty state). Each at 1280,
// 768 and 320 (the ledger also at 1024, where the table starts) with no horizontal page scroll — the ledger and the pack tiles are exactly where a long name or a 3-up grid
// would push the page wider.
test.use({ storageState: { cookies: [], origins: [] } });

const SHOTS =
  process.env.CREDITS_SHOTS_DIR ??
  resolve(process.cwd(), "../../.superpowers/sdd/shots/credits-tab");

// ---------------------------------------------------------------------------------------------------------------------
// The cookie banner. These pages are walked as a first-time visitor (own empty storageState), so the consent prompt
// mounts over the page at hydration and would sit on top of every picture and every hit-test. Answer it the way a visitor
// who declines does: tap Reject. (Not Accept, and not a seeded localStorage key — the tap is the product's own path.)
// ---------------------------------------------------------------------------------------------------------------------
const BANNER_WAIT_MS = 5_000;
const asked = new WeakSet<Page>();

/** Tap the banner's Reject if there is one. The banner mounts from an effect AFTER hydration, so `goto` can return
 *  before it exists: the first call per page waits for it; after that a banner is only acted on when already showing
 *  (the choice is stored, so it does not come back). A page that never shows one costs the wait once. */
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

/** `page.goto`, then answer the cookie prompt: every navigation here is a fresh page load. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "load" });
  await declineCookies(page);
}

async function shot(page: Page, name: string): Promise<void> {
  await declineCookies(page);   // belt and braces: never a picture with the banner over it
  const path = resolve(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  // Also on the test itself, so the HTML report carries it whenever the run uploads one.
  await test.info().attach(name, { path, contentType: "image/png" });
}

// ---------------------------------------------------------------------------------------------------------------------
// Copy from the dictionary itself, never typed, so a copy edit moves the expectation with it.
// ---------------------------------------------------------------------------------------------------------------------
const EN_UI = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const en = (key: string, vars: Record<string, string | number> = {}): string => {
  const raw = EN_UI[key];
  if (raw === undefined) throw new Error(`en/ui.json has no ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, v: string) => {
    if (!(v in vars)) throw new Error(`en(${key}): no value for {${v}}`);
    return String(vars[v]);
  });
};
const credits = (n: number): string =>
  n === 1
    ? en("settings.credits.stream.balanceCount.one", { count: n })
    : en("settings.credits.stream.balanceCount.other", { count: n });

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

// ---------------------------------------------------------------------------------------------------------------------
// Budget — derived, never a flat literal (AGENTS.md class 20).
// ---------------------------------------------------------------------------------------------------------------------
const NAV_MS = 20_000;
const ACT_MS = 5_000;
/** `seedOverlayFixture`: an org, a rostered hockey fixture, four events and a PUT, all over the API. */
const SEED_MS = 45_000;
const budget = (c: { seeds: number; navs: number; acts: number }): number =>
  Math.max(60_000, c.seeds * SEED_MS + c.navs * NAV_MS + c.acts * ACT_MS);

// ---------------------------------------------------------------------------------------------------------------------
// Layout probes
// ---------------------------------------------------------------------------------------------------------------------

/** The page does not scroll sideways: with the html/body clip lifted, nothing is wider than the viewport. Names the
 *  offenders, so a red says WHICH box. Boxes inside their own scroller or clip are not counted (they cannot widen the page). */
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

/** The control's centre is its own (nothing paints over it), and on a phone it is a 44px target. Hit-tested with
 *  elementFromPoint: a bounding box measures paint, not what a thumb reaches. */
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

async function expectNoSeriousAxe(page: Page, where: string): Promise<void> {
  const AxeBuilder = (await import("@axe-core/playwright")).default;
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`),
    `axe serious/critical ${where}`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------------
// AI side — the default
// ---------------------------------------------------------------------------------------------------------------------

test("Credits tab, AI side: nav entry, the switch, desktop + mobile, axe", async ({ page }) => {
  const email = `delivered+credits-${Date.now()}@resend.dev`;
  await loginUi(page, email, "/");
  // Create + activate a fresh org (bootstrap credit grant fires on creation),
  // so the wallet shows a real balance.
  const created = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
    name: `Credits Demo ${Date.now()}`,
  });
  await apiJson(page.request, "/api/orgs/active", "POST", { org_id: created.data!.id });
  const org = await activeOrg(page);

  // Nav showing the "Credits" tab (desktop settings sidebar) — renamed from "AI Credits" when the tab got a second side.
  //
  // `exact: true` is load-bearing: Playwright's `name` is a SUBSTRING match,
  // and the rail's plan header carries a second link to the same route
  // reading "10 AI credits". Without it this resolves to two elements and
  // fails strict mode — which is what it did.
  await open(page, `/o/${org.slug}/settings?tab=organization`);
  await expect(page.getByRole("link", { name: en("settings.nav.credits"), exact: true })).toBeVisible();
  await shot(page, "settings-nav-desktop");

  // The page, desktop: it opens on the AI side (every old link did), with the switch naming it.
  await open(page, `/o/${org.slug}/settings/credits`);
  await expect(page.getByRole("heading", { level: 1, name: en("settings.nav.credits") })).toBeVisible();
  await expect(page.getByTestId("credits-kind-ai")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("credits-kind-stream")).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator("[data-credits]"), "the AI wallet card").toBeVisible();
  await expect(page.locator("[data-credits-stream]"), "not the Streaming card").toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, "credits-desktop");

  // axe on /settings/credits (serious/critical only).
  await expectNoSeriousAxe(page, "on /settings/credits");

  // Mobile 375px — no horizontal page scroll.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(200);
  await expectNoPageScroll(page, "AI side at 375");
  await shot(page, "credits-mobile-375");

  // The switch is two links the keyboard and a thumb can reach: 44px each at 375.
  await expectTappable(page.getByTestId("credits-kind-stream"), "the Streaming switch");
  await page.getByTestId("credits-kind-stream").click();
  await expect(page).toHaveURL(/\/settings\/credits\?kind=stream$/);
  await expect(page.locator("[data-credits-stream]")).toBeVisible();
  await expect(page.getByTestId("credits-kind-stream")).toHaveAttribute("aria-current", "page");
  // …and back: the AI side keeps its bare URL.
  await page.getByTestId("credits-kind-ai").click();
  await expect(page).toHaveURL(/\/settings\/credits$/);
  await expect(page.locator("[data-credits]")).toBeVisible();
});

// ---------------------------------------------------------------------------------------------------------------------
// Streaming side — a realistic ledger
// ---------------------------------------------------------------------------------------------------------------------

// A 60-character club name — the realistic stress for the match line (a 43-character name once put 106px of sideways
// overflow on a card here, seen only in a browser).
const LONG_HOME = "The Extraordinarily Long Named Riverside Hockey Club First XI";
const LONG_AWAY = "Northern Counties Veterans Over-Fifties Reserve Squad (Mixed)";
const PAGE_SIZE = 25;

test("Credits tab, Streaming side: the ledger, the pager, the export and the buy tiles — no page scroll at 1280, 1024, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ seeds: 1, navs: 14, acts: 30 }));

  const rig = await seedOverlayFixture(page);
  const seed = await withDb(async (sql) => {
    const [owner] = await sql<{ id: string }[]>`select id from users where email = ${rig.ownerEmail}`;
    await sql`update entrants set display_name = ${LONG_HOME} where id = ${rig.homeEntrantId}`;
    await sql`update entrants set display_name = ${LONG_AWAY} where id = ${rig.awayEntrantId}`;
    return seedStreamHistory(sql, { orgId: rig.orgId, ownerId: owner!.id, fixtureId: rig.fixtureId });
  });
  const [fx] = await withDb((sql) => sql<{ fixture_no: number }[]>`select fixture_no from fixtures where id = ${rig.fixtureId}`);
  const fixtureHref = `/o/${rig.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}/f/${fx!.fixture_no}`;

  // --- 1280: the Streaming side, reached through the switch ---------------------------------------------------------
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, `/o/${rig.orgSlug}/settings/credits`);
  await expect(page.getByTestId("credits-kind-ai")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("credits-kind-stream").click();
  await expect(page).toHaveURL(/\/settings\/credits\?kind=stream$/);
  const history = page.getByTestId("credits-stream-history");
  await expect(history).toBeVisible({ timeout: NAV_MS });

  // What the page's own read did to the ledger: it grants this month's free credits once (Pro streams on a monthly
  // credit). Read from the ledger, so the screen is asserted against the table, not against itself.
  const ledger = await withDb(async (sql) => {
    const [rows] = await sql<{ n: number; total: number }[]>`
      select count(*)::int as n, coalesce(sum(delta), 0)::int as total from org_stream_credits where org_id = ${rig.orgId}`;
    const [free] = await sql<{ granted: number; used: number }[]>`
      select coalesce(sum(delta) filter (where reason = 'grant' and bucket = 'monthly'), 0)::int as granted,
             coalesce(-sum(delta) filter (where reason = 'consume' and bucket = 'monthly'), 0)::int as used
        from org_stream_credits
       where org_id = ${rig.orgId} and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`;
    return { rows: rows!.n, total: rows!.total, granted: free!.granted, used: free!.used };
  });
  const ownRows = ledger.rows - seed.rows;
  expect(ownRows, "the first read grants this month's free credits once — or, on a plan with none, nothing").toBeGreaterThanOrEqual(0);
  expect(ownRows).toBeLessThanOrEqual(1);
  expect(ledger.rows, "the ledger is longer than one page, or the pager below proves nothing").toBeGreaterThan(PAGE_SIZE);

  // The balance, in match credits.
  await expect(page.getByTestId("credits-stream-balance")).toHaveText(credits(ledger.total));
  // The free meter: "N of M used", one segment per free credit (only with a grant).
  if (ledger.granted > 0) {
    await expect(page.getByTestId("credits-stream-free-used")).toHaveText(
      en("settings.credits.stream.freeUsed", { used: ledger.used, cap: ledger.granted }),
    );
    if (ledger.granted <= 20) {
      await expect(page.locator('[data-testid="credits-stream-meter"] > span')).toHaveCount(ledger.granted);
    }
  } else {
    await expect(page.getByTestId("credits-stream-free-used")).toHaveCount(0);
  }

  // The first page: PAGE_SIZE rows, newest first, in the kinds the ledger wrote (this month's grant, then the seed).
  const rows = page.getByTestId("credits-stream-row");
  await expect(rows).toHaveCount(PAGE_SIZE);
  const expectedKinds = [...(ownRows === 1 ? ["monthlyGrant"] : []), ...seed.curatedKinds];
  const kinds = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
  expect(kinds.slice(0, expectedKinds.length), "kinds, newest first").toEqual(expectedKinds);
  // Each kind is a sentence a person reads — never the kind's own name, never a dictionary key.
  const text = (await history.innerText()).replace(/\s+/g, " ");
  for (const kind of new Set(expectedKinds)) {
    const sentence =
      kind === "packPurchase"
        ? en("settings.credits.stream.kind.packPurchase.other", { count: 5 })
        : en(`settings.credits.stream.kind.${kind}`);
    expect(text, `the ${kind} sentence`).toContain(sentence);
  }
  expect(text).not.toMatch(/settings\.credits\.|packPurchase|streamUsed|refundNoCamera/);

  // A row for a match names it, links the fixture page, and shows both (long) entrants in full in the DOM.
  const used = page.locator('[data-testid="credits-stream-row"][data-kind="streamUsed"]').first();
  const link = used.getByRole("link");
  await expect(link).toHaveAttribute("href", fixtureHref);
  await expect(link).toContainText(LONG_HOME);
  await expect(link).toContainText(LONG_AWAY);
  // …and a row that is not about a match links nothing.
  await expect(page.locator('[data-testid="credits-stream-row"][data-kind="expired"]').getByRole("link")).toHaveCount(0);

  // axe on the populated Streaming side.
  await expectNoSeriousAxe(page, "on the populated Streaming side at 1280");

  // --- the export --------------------------------------------------------------------------------------------------
  const exportLink = page.getByTestId("credits-stream-export");
  await expect(exportLink).toHaveAttribute("href", `/o/${rig.orgSlug}/settings/credits/stream.csv`);
  const csv = await page.request.get(`/o/${rig.orgSlug}/settings/credits/stream.csv`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(csv.headers()["content-disposition"]).toContain("stream-credits.csv");
  const lines = (await csv.text()).split("\r\n");
  expect(lines[0]).toBe(STREAM_HISTORY_CSV_HEADER.join(","));
  expect(lines, "every ledger row, past the first page").toHaveLength(ledger.rows + 1);
  const streamed = lines.find((l) => l.split(",")[1] === "streamUsed");
  expect(streamed, "a streamUsed row names its match").toContain(`${LONG_HOME} v ${LONG_AWAY}`);
  // …and its fixture number, the column that still names the match when a side is undecided.
  expect(streamed!.split(",")[STREAM_HISTORY_CSV_HEADER.indexOf("fixture_no")], "the fixture_no column").toBe(String(fx!.fixture_no));

  // --- the pager ---------------------------------------------------------------------------------------------------
  await expect(page.getByTestId("credits-stream-latest")).toHaveCount(0);
  await page.getByTestId("credits-stream-older").click();
  await expect(page).toHaveURL(/\/settings\/credits\?kind=stream&before=/);
  await expect(rows).toHaveCount(ledger.rows - PAGE_SIZE);
  await expect(page.getByTestId("credits-stream-older")).toHaveCount(0);
  await expect(page.getByTestId("credits-stream-paid"), "no return from Stripe, no payment notice").toHaveCount(0);
  await page.getByTestId("credits-stream-latest").click();
  await expect(page).toHaveURL(/\/settings\/credits\?kind=stream$/);
  await expect(rows).toHaveCount(PAGE_SIZE);
  // a hand-edited cursor is the latest page, not an error screen
  await open(page, `/o/${rig.orgSlug}/settings/credits?kind=stream&before=not-a-cursor`);
  await expect(rows).toHaveCount(PAGE_SIZE);

  // --- the layout at 1280, 1024, 768 and 320 ----------------------------------------------------------------------
  let measured = 0;
  for (const width of [1280, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page, `/o/${rig.orgSlug}/settings/credits?kind=stream`);
    await expect(rows).toHaveCount(PAGE_SIZE);
    await expectNoPageScroll(page, `Streaming side at ${width}`);

    // One DOM, two shapes: the column header row is the wide shape's, absent below lg (1024). At 768 the Settings rail leaves
    // the card ~490px, which is cards' room, not a five-column table's.
    await expect(page.getByRole("columnheader")).toHaveCount(width >= 1024 ? 5 : 0);

    // Every row, and the long match line inside it, stays inside the viewport.
    const boxes = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return Array.from(document.querySelectorAll('[data-testid="credits-stream-row"], [data-testid="credits-stream-row"] a')).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, vw };
      });
    });
    expect(boxes.length, `rows measured at ${width}`).toBeGreaterThan(PAGE_SIZE);
    for (const b of boxes) {
      expect(b.left, `${width}: a row starts left of the viewport`).toBeGreaterThanOrEqual(-1);
      expect(b.right, `${width}: a row reaches past the viewport`).toBeLessThanOrEqual(b.vw + 1);
    }
    measured += boxes.length;

    // The match link is a real target on a phone, and the three pack tiles and the export link are too.
    await expectTappable(
      page.locator('[data-testid="credits-stream-row"][data-kind="streamUsed"]').first().getByRole("link"),
      `the match link at ${width}`,
    );
    for (const pack of STREAM_CREDIT_PACKS) {
      await expectTappable(page.getByTestId(`credits-stream-buy-pack-${pack.size}`), `the ${pack.size}-pack tile at ${width}`);
    }
    await expectTappable(page.getByTestId("credits-stream-export"), `the export link at ${width}`);

    if (width === 320) await expectNoSeriousAxe(page, "on the populated Streaming side at 320");
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, `stream-populated-${width}`);
  }
  expect(measured, "anti-vacuity: the layout probes measured rows at all four widths").toBeGreaterThan(PAGE_SIZE * 4);

  // --- the buy tiles open the checkout, asking for a return to Settings ---------------------------------------------
  const pack = STREAM_CREDIT_PACKS.find((p) => p.popular) ?? STREAM_CREDIT_PACKS[0]!;
  const posts: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/billing/relay-checkout" && r.method() === "POST") posts.push(r.postData() ?? "");
  });
  const [answered] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/billing/relay-checkout" && r.request().method() === "POST",
      { timeout: NAV_MS },
    ),
    page.getByTestId(`credits-stream-buy-pack-${pack.size}`).click(),
  ]);
  expect(posts, "one tap, one checkout request").toHaveLength(1);
  // No fixture: this screen has none. The route reads `returnTo` to send Stripe back HERE.
  expect(JSON.parse(posts[0]!)).toEqual({ orgId: rig.orgId, pack: pack.size, returnTo: "settings" });
  const sheet = page.getByTestId("stream-checkout-modal");
  if (answered.ok()) {
    // A real Stripe test key: the embedded checkout mounts over the screen.
    await expect(sheet).toBeVisible({ timeout: NAV_MS });
    await expect(
      sheet.locator('iframe[src^="https://js.stripe.com/"], iframe[src^="https://checkout.stripe.com/"]').first(),
      "the sheet mounts Stripe's own embedded checkout frame",
    ).toBeAttached({ timeout: NAV_MS });
    await expectNoPageScroll(page, "checkout sheet open at 320");
    await shot(page, "stream-buy-sheet-320");
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
  } else {
    // The CI dummy key: Stripe refuses, and the screen says checkout did not open — the tile is free to try again.
    await expect(page.getByTestId("credits-stream-buy-error")).toHaveText(en("stream.credits.error.unknown"));
    await expect(sheet).toHaveCount(0);
    await shot(page, "stream-buy-refused-320");
  }
  await expect(page.getByTestId(`credits-stream-buy-pack-${pack.size}`), "the purchase lock was released").toBeEnabled();
});

// ---------------------------------------------------------------------------------------------------------------------
// Streaming side — a plan that does not stream: the empty state
// ---------------------------------------------------------------------------------------------------------------------

test("Credits tab, Streaming side: a plan without phone streaming shows the reason and an empty history — no page scroll at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ seeds: 0, navs: 6, acts: 12 }));

  const email = `delivered+credits-stream-${Date.now()}@resend.dev`;
  await loginUi(page, email, "/");
  const created = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", { name: `Credits Stream Off ${Date.now()}` });
  await apiJson(page.request, "/api/orgs/active", "POST", { org_id: created.data!.id });
  const org = await activeOrg(page);
  // Switch the relay off for this org (a staff override — the only way the gate is reachable). That read then grants nothing
  // and writes no row, so the history is genuinely empty.
  await setBoolEntitlementOverrideSql(org.id, "streaming.relay", false);
  await invalidateOrgEntitlements(page.request, org.id);

  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page, `/o/${org.slug}/settings/credits?kind=stream`);
    await expect(page.getByTestId("credits-stream-balance")).toHaveText(credits(0));
    await expect(page.getByTestId("credits-stream-notice")).toHaveText(en("settings.credits.stream.notIncluded"));
    await expect(page.getByTestId("credits-stream-empty")).toHaveText(en("settings.credits.stream.empty"));
    // Nothing to buy, nothing to export, no free meter, no table, no pager.
    for (const pack of STREAM_CREDIT_PACKS) await expect(page.getByTestId(`credits-stream-buy-pack-${pack.size}`)).toHaveCount(0);
    await expect(page.getByTestId("credits-stream-export")).toHaveCount(0);
    await expect(page.getByTestId("credits-stream-free-used")).toHaveCount(0);
    await expect(page.getByTestId("credits-stream-history")).toHaveCount(0);
    await expect(page.getByTestId("credits-stream-pager")).toHaveCount(0);
    await expectNoPageScroll(page, `Streaming side, empty, at ${width}`);
    if (width === 320) await expectNoSeriousAxe(page, "on the empty Streaming side at 320");
    await shot(page, `stream-empty-${width}`);
  }

  // The read wrote nothing: an org that cannot stream is not granted free credits by looking at the page.
  const [count] = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${org.id}`);
  expect(count!.n).toBe(0);
});
