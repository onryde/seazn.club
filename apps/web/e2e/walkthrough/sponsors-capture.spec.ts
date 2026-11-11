// R4 sponsors on stream, S15 — the owner's visual sign-off capture (controller addendum 2026-11-01): the REAL pages, at
// 320, 768 and 1280, each state witnessed BEFORE its shot, the PNGs written to SPONSOR_CAPTURE_DIR — which only the
// e2e workflow's opt-in `sponsor_captures` dispatch sets, and which it uploads as the `sponsor-captures` artifact. The
// PNGs never enter the repo (owner 2026-10-09). Modelled on S7's overlay readability capture
// (`e2e/overlay-readability.capture.ts`), whose step and upload it sits beside in `.github/workflows/e2e.yml`.
//
// Without SPONSOR_CAPTURE_DIR every test here SKIPS: the walkthrough "rest" legs select the file on every push to main
// (the inventory in src/lib/__tests__/e2e-ci-wiring.test.ts names it), and a capture nobody asked for is a minute of
// CI spent on pictures nobody will read.
//
// The states (spec 2026-10-27 §4–§6; S10–S14):
//   match-board       the public match page's sponsor board (S10) — `mh-sponsors`
//   hub-overview      Sponsors hub › Overview (S13): a 43-character name, a DELETED sponsor's row, the figures
//   hub-sponsors      Sponsors hub › Sponsors (S11)
//   hub-packages      Sponsors hub › Packages (S11)
//   hub-on-stream     Sponsors hub › On stream (S12): the switch on, the dial
//   share-open        Overview › Share report, opened, a link created and its url shown (S13)
//   report            the public report /r/sponsor/<token> (S14), anonymous, the 43-character name
// Each shot is the state's own region. The org TOP BAR has its own shots (the nav sign-off, coordinator 2026-11-08):
//   nav-logo-<w>              `header.app-gantry` of an org with a logo, at 320/768/1280
//   nav-name43-<w>            the same bar for an org with a 43-character name
//   nav-account-menu-1280     the account menu open (owner, Option A, 2026-11-11): the bar and the dropdown under it, one
//                             clip of the page - the menu is portalled to <body>, so a shot of the header alone would miss it.
// Before each: Sponsors (folded to the home's entry below 350 — nav.tsx `hidden min-[350px]:flex`, so it is asserted HIDDEN
// at 320, and above it the link AND its label span visible), the account menu trigger visible AND tappable inside the viewport
// (elementFromPoint), no Settings or Sign-out icon left on the bar (both live in the menu since 2026-11-11), the bar's content
// inside its box, and no page scroll. At 320 the logo org's crest stands alone (nav.tsx folds its wordmark there: CI e2e
// 42438561906 measured that bar 354px wide, its last control past the edge).
//
// ANTI-VACUITY (AGENTS.md class 10): the last test asserts every file exists, is a PNG, and that no two are
// byte-identical — a capture that errored before a shot, or two states that never opened, cannot pass it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll, withDb } from "../helpers";
import { releaseSettingsOrg, seedCompetition, seedSettingsOrg, sponsorsUrl, type SeededOrg } from "../settings-support";
import { reportLinkPath } from "../../src/lib/sponsor-report";
import { routes } from "../../src/lib/routes";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { releaseStandInOrg, seedStandInOrg, type StandInOrg } from "../helpers/sponsor-relay-standin";

const DIR = process.env.SPONSOR_CAPTURE_DIR;
const WIDTHS = [320, 768, 1280] as const;
const STATES = ["match-board", "hub-overview", "hub-sponsors", "hub-packages", "hub-on-stream", "share-open", "report"] as const;
type State = (typeof STATES)[number];
/** Review Focus 5's realistic names: 43 characters each. */
const LONG_SPONSOR = "Harbourside Building Supplies and Timber Co";
const LONG_AWAY = "Kingsway Northern Athletic Club Under 21s B";
const GONE_SPONSOR = "Old Mill Bakery";
const EMPTY_JAR = { cookies: [], origins: [] };

const UI: Record<string, string> = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"));
const CONSOLE: Record<string, string> = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/console.json", import.meta.url)), "utf8"));
/** The top bar's shots, by name: both orgs at every width, and the account menu open at 1280. */
const NAV_SHOTS = [...WIDTHS.flatMap((w) => [`nav-logo-${w}`, `nav-name43-${w}`]), "nav-account-menu-1280"];
const LONG_ORG = "Harbourside Northern Athletic Club U21 Team";
const NAV_LOGO_URL = "https://crest.nav-capture.example/crest.png";
const navShotPath = (name: string) => join(DIR!, `${name}.png`);
const ui = (key: string): string => {
  const v = UI[key];
  if (v === undefined) throw new Error(`en/ui.json has no ${key}`);
  return v;
};

test.skip(!DIR, "opt-in: the e2e workflow's sponsor_captures input sets SPONSOR_CAPTURE_DIR");
test.describe.configure({ mode: "serial" });

let org: SeededOrg;
let matchPath = "";
let titleId = "";
let reportToken = "";

const shotPath = (state: State, width: number) => join(DIR!, `${state}-${width}.png`);

/** The witness first, at this width; then no horizontal page scroll; then the shot of the state's own region. */
async function capture(page: Page, state: State, width: number, region: Locator): Promise<void> {
  await expect(region, `${state} @${width}: its region is on the page`).toBeVisible();
  await expectNoHorizontalScroll(page);
  await region.screenshot({ path: shotPath(state, width), animations: "disabled" });
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000);
  expect(LONG_SPONSOR.length, "premise: Review Focus 5's 43 characters").toBe(43);
  expect(LONG_AWAY.length).toBe(43);
  mkdirSync(DIR!, { recursive: true });
  org = await seedSettingsOrg(request, { plan: "pro", label: "sponsors-capture" });
  const comp = await seedCompetition(request, org.orgId, { name: "Harbour Summer League", visibility: "public" });
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
    name: "T20", sport_key: "cricket", variant_key: "t20", config: {},
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  expect((await addEntrantsViaApi(request, div.data!.id, ["Harbour Town CC", LONG_AWAY], "team")).status).toBe(201);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id);
  expect(fixtureIds.length, "premise: two entrants seat one fixture").toBe(1);
  const fixtureId = fixtureIds[0]!;
  const divRead = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${div.data!.id}`);
  matchPath = routes.publicFixture(org.slug, comp.slug, divRead.data!.slug, fixtureId);

  // One sponsor per tier, the title's name the long one; the title and gold ticked onto the stream; the dial Normal.
  const ids: Record<string, string> = {};
  for (const s of [
    { name: LONG_SPONSOR, tier: "title", url: "https://harbourside.example/" },
    { name: "Ridge Gold Physiotherapy", tier: "gold", url: "https://ridge-gold.example/" },
    { name: "Quay Fisheries", tier: "silver", url: "https://quay.example/" },
    { name: "Northbank Print", tier: "partner", url: "https://northbank.example/" },
    { name: GONE_SPONSOR, tier: "partner", url: "https://old-mill.example/" },
  ]) {
    const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", s);
    expect(made.status, `${s.name}: ${JSON.stringify(made.error)}`).toBe(201);
    ids[s.name] = made.data!.id;
  }
  titleId = ids[LONG_SPONSOR]!;
  for (const name of [LONG_SPONSOR, "Ridge Gold Physiotherapy"]) {
    expect((await apiJson(request, `/api/v1/orgs/${org.orgId}/sponsors/${ids[name]}`, "PATCH", { on_stream: true })).status).toBe(200);
  }
  expect((await apiJson(request, `/api/v1/orgs/${org.orgId}/sponsor-stream-settings`, "PUT", { competitionId: null, enabled: true, frequency: "normal" })).status).toBe(200);
  expect((await apiJson(request, `/api/v1/orgs/${org.orgId}/sponsor-packages`, "POST", { name: "Gold Season Package", price_cents: 25_000, currency: "gbp", tier: "gold" })).status).toBe(201);

  // Proof of play, this year (the Overview's default period) and before now: two closed showings for the title, one for
  // the sponsor that is then DELETED (its rows keep the name, sponsor_id goes null: the Overview's "Deleted" row), and
  // two stream visits for the title.
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000);
  await withDb(async (sql) => {
    const air = (sponsorId: string, name: string, moment: string, at: Date, ms: number) => sql`
      insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, moment_id, source, break_kind, style, started_at, ended_at)
      values (${org.orgId}, ${sponsorId}, ${name}, ${fixtureId}, ${moment}, 'rotation', 'over_end', 'lower_third', ${at}, ${new Date(at.getTime() + ms)})`;
    await air(titleId, LONG_SPONSOR, "6:sponsor.over_end", day(3), 8_000);
    await air(titleId, LONG_SPONSOR, "18:sponsor.over_end", day(2), 8_000);
    await air(ids[GONE_SPONSOR]!, GONE_SPONSOR, "30:sponsor.over_end", day(2), 8_000);
    for (const at of [day(3), day(2)]) {
      await sql`insert into sponsor_clicks (org_id, sponsor_id, fixture_id, source, at) values (${org.orgId}, ${titleId}, ${fixtureId}, 'stream', ${at})`;
    }
  });
  expect((await apiJson(request, `/api/v1/orgs/${org.orgId}/sponsors/${ids[GONE_SPONSOR]}`, "DELETE")).status, "the bakery is deleted").toBeLessThan(300);

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const link = await apiJson<{ url: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors/${titleId}/report-links`, "POST", {
    competitionId: null, from: iso(day(30)), to: iso(day(0)),
  });
  expect(link.status, JSON.stringify(link.error)).toBe(201);
  reportToken = link.data!.url.split("/").at(-1)!;
});

test.afterAll(async ({ request }) => {
  if (org) await releaseSettingsOrg(request, org);
});

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the match page's sponsor board (S10)", async ({ browser }) => {
      // The public page, as a visitor sees it: no session.
      const ctx = await browser.newContext({ storageState: EMPTY_JAR, viewport: { width, height: 900 } });
      try {
        const page = await ctx.newPage();
        expect((await page.goto(matchPath))?.status()).toBe(200);
        const board = page.getByTestId("mh-sponsors");
        await expect(board, "witness: the board is drawn").toBeVisible();
        await expect(board, "witness: the title sponsor heads it, the gold sits on it").toContainText(LONG_SPONSOR);
        await expect(board).toContainText("Ridge Gold Physiotherapy");
        await capture(page, "match-board", width, board);
      } finally {
        await ctx.close();
      }
    });

    test("the hub's four tabs (S11–S13)", async ({ page }) => {
      await page.goto(sponsorsUrl(org.slug, "overview"));
      const overview = page.getByTestId("sponsors-tab-overview");
      await expect(page.getByTestId(`sponsor-overview-row-${titleId}`).getByTestId("sponsor-overview-name"), "witness: the long name's row").toHaveText(LONG_SPONSOR);
      await expect(page.getByTestId(`sponsor-overview-row-gone-${GONE_SPONSOR}`).getByText(ui("sponsors.overview.deleted"), { exact: true }), "witness: the deleted sponsor's row").toBeVisible();
      // Owner ruling 2026-11-01 (PR B deferred): no row has a viewer number, so every row's viewers read "Coming soon" - five
      // rows, the five sponsors seeded above (the deleted one keeps its row by name).
      await expect(overview.getByTestId("sponsor-overview-viewers"), "witness: five rows").toHaveCount(5);
      await expect(overview.getByTestId("viewers-coming-soon"), "witness: the viewers legend in every row").toHaveCount(5);
      await expect(overview.getByTestId("viewers-coming-soon").first()).toHaveText(ui("sponsors.viewers.comingSoon"));
      await capture(page, "hub-overview", width, overview);

      await page.goto(sponsorsUrl(org.slug, "sponsors"));
      const sponsors = page.getByTestId("sponsors-tab-sponsors");
      await expect(sponsors.getByText(LONG_SPONSOR).first(), "witness: the sponsor list").toBeVisible();
      await capture(page, "hub-sponsors", width, sponsors);

      await page.goto(sponsorsUrl(org.slug, "packages"));
      const packages = page.getByTestId("sponsors-tab-packages");
      await expect(packages.getByText("Gold Season Package").first(), "witness: the seeded package").toBeVisible();
      await capture(page, "hub-packages", width, packages);

      await page.goto(sponsorsUrl(org.slug, "on_stream"));
      const onStream = page.getByTestId("sponsors-tab-on_stream");
      await expect(page.getByTestId("on-stream-switch"), "witness: the rotation is on").toHaveAttribute("aria-checked", "true");
      await expect(page.getByTestId("on-stream-dial-normal"), "witness: the dial reads Normal").toHaveAttribute("aria-checked", "true");
      await capture(page, "hub-on-stream", width, onStream);
    });

    test("Overview › Share report, opened, with its url (S13) — and that url opens the report for a stranger", async ({ page, browser }) => {
      await page.goto(sponsorsUrl(org.slug, "overview"));
      await page.getByTestId(`sponsor-overview-row-${titleId}`).getByTestId("sponsor-overview-share").click();
      const panel = page.getByTestId("sponsor-share");
      await expect(panel, "witness: the panel opened").toBeVisible();
      await panel.getByTestId("sponsor-share-create").click();
      const shown = panel.getByTestId("sponsor-share-url");
      await expect(shown, "witness: the link was created and shown").toHaveValue(/\/r\/sponsor\/[A-Za-z0-9_-]{43}$/);
      await capture(page, "share-open", width, panel);

      // S13's owed item: the url the panel SHOWED, not one the test rebuilt, opens the report with no session at all.
      const url = new URL(await shown.inputValue());
      expect(url.origin, "the panel's url is on this site").toBe(new URL(page.url()).origin);
      const stranger = await browser.newContext({ storageState: EMPTY_JAR, viewport: { width, height: 900 } });
      try {
        const viewer = await stranger.newPage();
        expect((await viewer.goto(url.href))?.status(), "the shown url answers a stranger").toBe(200);
        await expect(viewer.getByTestId("sponsor-report"), "and it is the sponsor's report").toBeVisible();
        await expect(viewer.getByRole("heading", { level: 1 }), "the report of the sponsor whose row was shared").toContainText(LONG_SPONSOR);
      } finally {
        await stranger.close();
      }
    });

    test("the public report (S14)", async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: EMPTY_JAR, viewport: { width, height: 900 } });
      try {
        const page = await ctx.newPage();
        expect((await page.goto(reportLinkPath(reportToken)))?.status()).toBe(200);
        const report = page.getByTestId("sponsor-report");
        await expect(page.getByRole("heading", { level: 1 }), "witness: the long name heads it").toContainText(LONG_SPONSOR);
        await expect(page.getByTestId("report-showing"), "witness: the two showings").toHaveCount(2);
        await expect(report.getByTestId("viewers-coming-soon"), "witness: the viewers legend (owner ruling 2026-11-01)").toHaveText(ui("sponsors.viewers.comingSoon"));
        // Final review S14: the stranger's empty jar shows the cookie banner, which would sit over the report in the shot.
        await dismissCookieBanner(page);
        await capture(page, "report", width, report);
      } finally {
        await ctx.close();
      }
    });
  });
}

test.describe("the org top bar (nav sign-off)", () => {
  let logoOrg: StandInOrg | undefined;
  let longOrg: StandInOrg | undefined;
  const word = (key: string) => {
    const v = CONSOLE[key];
    if (v === undefined) throw new Error(`en/console.json has no ${key}`);
    return v;
  };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(90_000);
    expect(LONG_ORG.length, "premise: a 43-character org name").toBe(43);
    logoOrg = await seedStandInOrg(browser, "spnav", { logoUrl: NAV_LOGO_URL });
    const crest = readFileSync(fileURLToPath(new URL("../../public/apple-touch-icon.png", import.meta.url)));
    await logoOrg.ctx.route(`${new URL(NAV_LOGO_URL).origin}/**`, (r) => r.fulfill({ status: 200, contentType: "image/png", body: crest }));
    longOrg = await seedStandInOrg(browser, "spnav43", { orgName: LONG_ORG });
  });
  test.afterAll(async () => {
    try {
      await releaseStandInOrg(logoOrg);
    } finally {
      await releaseStandInOrg(longOrg);
    }
  });

  /** A control a person can tap: its box wholly inside the viewport, and a tap at its centre lands on IT (elementFromPoint, AGENTS.md
   *  class 2 - `toBeVisible` passes for a button past the viewport's edge, and html's `overflow-x: clip` hides it without a scroll). */
  async function expectTappable(control: Locator, width: number, what: string): Promise<void> {
    const at = await control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { left: r.left, right: r.right, hit: hit !== null && (hit === el || el.contains(hit)) };
    });
    expect(at.left, `${width}: ${what} starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(at.right, `${width}: ${what} ends inside the viewport`).toBeLessThanOrEqual(width);
    expect(at.hit, `${width}: a tap at ${what}'s centre reaches it`).toBe(true);
  }

  /** The bar at this width, witnessed: Sponsors (hidden at 320, where the home's entry stands in), the account menu trigger,
   *  the bar's content inside its own box, the trigger tappable inside the viewport, no page scroll. CI e2e 42438561906
   *  measured the logo org's bar 354px wide at 320, its last control wholly past the edge: nav.tsx now folds a logo org's
   *  wordmark there. */
  async function witnessBar(o: StandInOrg, width: number): Promise<Locator> {
    const { page } = o;
    await page.setViewportSize({ width, height: 900 });
    await page.goto(routes.orgHome(o.orgSlug));
    const header = page.locator("header.app-gantry");
    await expect(header).toBeVisible();
    const sponsors = header.getByTestId("nav-sponsors");
    if (width === 320) await expect(sponsors, "320: Sponsors folds to the home's entry").toBeHidden();
    else {
      // The word is its own span (nav.tsx `navLabelClass`, `hidden md:inline`): `toHaveText` on the link reads a HIDDEN
      // span's text too, so the label's paint is asserted on the span itself.
      await expect(sponsors, `${width}: Sponsors is on the bar`).toBeVisible();
      await expect(sponsors.getByText(word("nav.sponsors"), { exact: true }), `${width}: its label is painted`).toBeVisible();
    }
    // Settings and Sign out moved into the account menu (owner, Option A, 2026-11-11): the bar's last control is its trigger.
    await expect(header.getByTestId("nav-settings"), `${width}: no Settings icon on the bar`).toHaveCount(0);
    await expect(header.getByRole("button", { name: word("nav.signOut"), exact: true }), `${width}: no Sign-out icon on the bar`).toHaveCount(0);
    const trigger = header.getByRole("button", { name: word("nav.account.menu"), exact: true });
    await expect(trigger, `${width}: the account menu trigger`).toBeVisible();
    const fit = await header.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(fit.scroll, `${width}: the bar's content fits its box`).toBeLessThanOrEqual(fit.client);
    await expectTappable(trigger, width, "the account menu trigger");
    // Whatever the wordmark does at this width, the home link keeps its name (nav.tsx folds it with `sr-only`, never `hidden`).
    await expect(header.getByRole("link", { name: "Seazn Club" }), `${width}: the home link is still named Seazn Club`).toHaveAttribute("href", "/");
    await expectNoHorizontalScroll(page);
    return header;
  }

  for (const width of WIDTHS) {
    test(`the top bar @${width}: an org with a logo, an org with a 43-character name`, async () => {
      const header = await witnessBar(logoOrg!, width);
      const crest = header.locator(`img[src="${NAV_LOGO_URL}"]`);
      await expect(crest, "witness: the org's logo").toBeVisible();
      await expect.poll(() => crest.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      await expectTappable(crest, width, "the club's crest");
      // At 320 the club's crest takes the wordmark's place (its box leaves the row); from 768 both are drawn, the wordmark wider.
      const drawn = (h: Locator) => h.locator('img[src="/logo-wide-night.png"]').evaluate((img) => img.getBoundingClientRect().width);
      const crestWidth = await crest.evaluate((img) => img.getBoundingClientRect().width);
      if (width === 320) expect(await drawn(header), "320: the wordmark gives its place to the crest").toBeLessThanOrEqual(1);
      else expect(await drawn(header), `${width}: the wordmark beside the crest`).toBeGreaterThan(crestWidth);
      await header.screenshot({ path: navShotPath(`nav-logo-${width}`), animations: "disabled" });

      const bar = await witnessBar(longOrg!, width);
      expect(await drawn(bar), `${width}: an org without a logo keeps its wordmark - the bar's only mark`).toBeGreaterThan(crestWidth);
      const chip = bar.locator('[data-tour="org-chip"]');
      // The org chip is the name's place from `sm` (640); at 320 the bar carries no name. From 640 the chip gives up width
      // before anything else (nav.tsx `shrink-[999]`: "a clipped club name costs nothing"), so its TEXT is the witness.
      if (width === 320) await expect(chip, "320: no org chip").toBeHidden();
      else await expect(chip.locator("span.truncate"), "witness: the long name, in its chip").toHaveText(LONG_ORG);
      await bar.screenshot({ path: navShotPath(`nav-name43-${width}`), animations: "disabled" });
    });
  }

  test("the top bar @1280: the account menu open, Organisation settings and Sign out inside it", async () => {
    const header = await witnessBar(longOrg!, 1280);
    const page = longOrg!.page;
    await header.getByRole("button", { name: word("nav.account.menu"), exact: true }).click();
    const menu = page.getByTestId("account-menu");
    await expect(menu, "witness: the menu is open").toBeVisible();
    await expect(page.getByTestId("account-menu-settings"), "Organisation settings, named").toHaveText(word("nav.account.orgSettings"));
    await expect(page.getByTestId("account-menu-settings")).toHaveAttribute("href", routes.orgSettings(longOrg!.orgSlug));
    await expect(page.getByTestId("account-menu-signout"), "Sign out, named").toHaveText(word("nav.signOut"));
    await expectTappable(page.getByTestId("account-menu-signout"), 1280, "Sign out");
    // One clip from the bar's top to the menu's foot: the menu is portalled to <body>, outside the header's box.
    const hb = (await header.boundingBox())!;
    const mb = (await menu.boundingBox())!;
    await page.screenshot({ path: navShotPath("nav-account-menu-1280"), animations: "disabled", clip: { x: 0, y: hb.y, width: 1280, height: Math.ceil(mb.y + mb.height - hb.y + 8) } });
    await page.keyboard.press("Escape");
    await expect(menu, "Escape closes it").toHaveCount(0);
  });
});

test("anti-vacuity: every state at every width exists, is a PNG, and no two are identical", () => {
  const files = [...WIDTHS.flatMap((w) => STATES.map((s) => shotPath(s, w))), ...NAV_SHOTS.map(navShotPath)];
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
  console.log(`sponsor captures checked: ${files.length} (${STATES.length} states × ${WIDTHS.length} widths + ${NAV_SHOTS.length} top-bar shots)`);
  expect(digests.size).toBe(STATES.length * WIDTHS.length + 2 * WIDTHS.length + 1);
});
