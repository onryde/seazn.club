// Sponsor deals PR 2, Batch J - the owner's visual sign-off capture: the REAL screens of the deals flow at 320, 768 and 1280, each
// state witnessed BEFORE its shot, the PNGs written to SPONSOR_DEALS_CAPTURE_DIR - which only the e2e workflow's opt-in
// `sponsor_deals_captures` dispatch sets, and which it uploads as the `sponsor-deals-captures` artifact. The PNGs never enter the
// repo (owner 2026-10-09). Modelled on `sponsors-capture.spec.ts`, whose step and upload it sits beside in `.github/workflows/e2e.yml`.
//
// Without SPONSOR_DEALS_CAPTURE_DIR every test here SKIPS: the walkthrough "rest" legs select the file on every push to main (the
// inventory in src/lib/__tests__/e2e-ci-wiring.test.ts names it), and a capture nobody asked for is a minute of CI spent on pictures
// nobody will read.
//
// The states (English, at each of 320 / 768 / 1280):
//   list               Sponsors tab: a live deal, one waiting for payment, one waiting for approval, and a sponsor with no deal
//   sponsor-page       one sponsor's own page: its live deal, the deal queued behind it, and the one that ended
//   add-deal           the Add deal sheet, every payment-method card on screen (Online, Offline, Complimentary)
//   deal-live          a deal's own page, live
//   deal-ended         a deal's own page, ended (the timeline's last step)
//   deal-disputed      a paid deal with a dispute open: the "Disputed" badge and the evidence link
//   deal-dispute-lost  a deal that ended because the dispute was lost
//   packages           Packages: the price list, one package used, one not
//   packages-create    Packages with Create package's sheet open
// and, at 1280 only, the deal page and the Add deal sheet in Spanish, French and Dutch (`deal-live-<locale>-1280`,
// `add-deal-<locale>-1280`).
//
// Honest about the two dispute states: a dispute needs Stripe, which a capture run does not have. They are made by the REAL producers
// up to the point Stripe would act (a deal created and marked paid through the API) and then given the same columns the dispute
// webhook writes (`sponsor_orders.disputed_at` / `dispute_id`, and for the lost one `status = 'refunded'`, `deal_status = 'ended'`,
// `ended_reason = 'dispute_lost'` - usecases/sponsors.ts, the `lost` arm of the dispute close). The page is read from the real hub.
//
// The viewport is TALL (1600) on purpose: a side panel and a bottom sheet scroll inside themselves, and a picture of one cut at 900px
// shows the owner half a screen. Fitting a phone's real height is the e2e spec's job (sponsor-deals.spec.ts, "add deal sheet" and
// "widths"), not this file's.
//
// ANTI-VACUITY (AGENTS.md class 10): the last test asserts every file exists, is a PNG, and that no two are byte-identical - a capture
// that errored before a shot, or two states that never opened, cannot pass it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, setBoolEntitlementOverrideSql, setOrgConnectSql, withDb } from "../helpers";
import {
  dealUrl, releaseSettingsOrg, seedCompetition, seedSettingsOrg, sponsorsUrl, sponsorUrl, tapUntil, type SeededOrg,
} from "../settings-support";

const DIR = process.env.SPONSOR_DEALS_CAPTURE_DIR;
const WIDTHS = [320, 768, 1280] as const;
const HEIGHT = 1600;
const STATES = ["list", "sponsor-page", "add-deal", "deal-live", "deal-ended", "deal-disputed", "deal-dispute-lost", "packages", "packages-create"] as const;
type State = (typeof STATES)[number];
const LOCALES = ["es", "fr", "nl"] as const;
type Locale = (typeof LOCALES)[number];
/** The realistic 43-character name. */
const LONG_SPONSOR = "Harbourside Building Supplies and Timber Co";

const dictionary = (locale: "en" | Locale): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"));
const EN = dictionary("en");
function word(dict: Record<string, string>, key: string): string {
  const v = dict[key];
  if (v === undefined) throw new Error(`ui.json has no ${key}`);
  return v;
}
const ui = (key: string, vars: Record<string, string> = {}): string =>
  Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, v), word(EN, key));

test.skip(!DIR, "opt-in: the e2e workflow's sponsor_deals_captures input sets SPONSOR_DEALS_CAPTURE_DIR");
test.describe.configure({ mode: "serial" });

const shotPath = (state: State, width: number): string => join(DIR!, `${state}-${width}.png`);
const localeShotPath = (state: "deal-live" | "add-deal", locale: Locale): string => join(DIR!, `${state}-${locale}-1280.png`);

let org: SeededOrg;
let ids: {
  long: string; quay: string; northbank: string; ridge: string; oldMill: string; plain: string;
  liveDeal: string; endedDeal: string; queuedDeal: string; disputedDeal: string; lostDeal: string;
};

async function api<T>(request: APIRequestContext, path: string, method: "POST" | "PATCH" | "DELETE" | "GET", body?: unknown, want = 201): Promise<T> {
  const res = await apiJson<T>(request, `/api/v1/orgs/${org.orgId}${path}`, method, body);
  expect(res.status, `${method} ${path} answered ${res.status}: ${JSON.stringify(res.error)}`).toBe(want);
  return res.data as T;
}
const newSponsor = async (request: APIRequestContext, name: string): Promise<string> =>
  (await api<{ id: string }>(request, "/sponsors", "POST", { name, tier: "partner", url: "https://sponsor.example/" })).id;
const newPackage = async (request: APIRequestContext, name: string, tier: string, priceCents: number): Promise<string> =>
  (await api<{ id: string }>(request, "/sponsor-packages", "POST", { name, price_cents: priceCents, currency: "gbp", tier })).id;
const newDeal = async (request: APIRequestContext, sponsorId: string, over: Record<string, unknown>): Promise<string> =>
  (await api<{ deal: { id: string } }>(request, `/sponsors/${sponsorId}/deals`, "POST", { competition_id: null, payment_method: "offline", go_live: "on_payment", ...over })).deal.id;
const dealPost = async (request: APIRequestContext, dealId: string, action: "mark-paid" | "end"): Promise<void> => {
  await api(request, `/sponsor-deals/${dealId}/${action}`, "POST", undefined, 200);
};

/** The witness first, at this width; then no horizontal page scroll; then the shot of the state's own region. */
async function capture(page: Page, file: string, what: string, region: Locator): Promise<void> {
  await expect(region, `${what}: its region is on the page`).toBeVisible();
  await expectNoHorizontalScroll(page);
  await region.screenshot({ path: file, animations: "disabled" });
}

/** A sponsor's or a deal's own page: the page body below 768, a side panel from it. */
const pageRegion = (page: Page, width: number): Locator => (width >= 768 ? page.getByRole("dialog") : page.getByTestId("sponsor-sheet-page"));
const addDealRegion = (page: Page): Locator => page.locator(`[role="dialog"]:has([data-testid="add-deal-sheet"])`);
const stepOf = (page: Page, key: string): Locator => page.locator(`[data-testid="deal-page-step"][data-step="${key}"]`);

/** Every payment-method card is on screen: wholly inside the sheet, so the picture shows all three and not the first two. */
async function expectCardsInside(page: Page, width: number): Promise<void> {
  const sheet = (await addDealRegion(page).boundingBox())!;
  for (const method of ["online", "offline", "complimentary"]) {
    const card = page.getByTestId(`add-deal-payment-${method}-card`);
    await expect(card, `${width}: the ${method} payment card is drawn`).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.y, `${width}: the ${method} card starts inside the sheet`).toBeGreaterThanOrEqual(sheet.y - 1);
    expect(box.y + box.height, `${width}: the ${method} card ends inside the sheet`).toBeLessThanOrEqual(sheet.y + sheet.height + 1);
  }
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  expect(LONG_SPONSOR.length, "premise: the realistic 43 characters").toBe(43);
  mkdirSync(DIR!, { recursive: true });
  org = await seedSettingsOrg(request, { plan: "pro", label: "sponsor-deals-capture" });
  // Online is open on the Add deal sheet (and so its card is enabled in the picture): the plan sells invoices and Stripe takes charges.
  await setBoolEntitlementOverrideSql(org.orgId, "sponsors.monetize", true);
  await setOrgConnectSql(org.orgId, true);
  await seedCompetition(request, org.orgId, { name: "Harbour Summer League", visibility: "public" });

  const gold = await newPackage(request, "Gold Season Package", "gold", 150_000);
  const partner = await newPackage(request, "Partner Board", "partner", 25_000);
  await newPackage(request, "Programme Advert", "silver", 8_000);

  const long = await newSponsor(request, LONG_SPONSOR);
  const quay = await newSponsor(request, "Quay Fisheries");
  const northbank = await newSponsor(request, "Northbank Print");
  const ridge = await newSponsor(request, "Ridge Gold Physiotherapy");
  const oldMill = await newSponsor(request, "Old Mill Bakery");
  const plain = await newSponsor(request, "Plain Sponsor");

  // The long-named sponsor's three deals, in the order that leaves one of each: one that ended, the live one, one queued behind it.
  const endedDeal = await newDeal(request, long, { package_id: gold, payment_method: "complimentary", go_live: "immediate" });
  await dealPost(request, endedDeal, "end");
  const liveDeal = await newDeal(request, long, { package_id: gold, payment_method: "complimentary", go_live: "immediate" });
  const queuedDeal = await newDeal(request, long, { package_id: partner, payment_method: "complimentary", go_live: "immediate" });

  // One waiting for the club's money, one paid and waiting for the club's approval.
  await newDeal(request, quay, { package_id: partner });
  const approval = await newDeal(request, northbank, { package_id: partner, go_live: "on_approval" });
  await dealPost(request, approval, "mark-paid");

  // The two dispute states: paid through the real route, then given what the dispute webhook writes (see the header).
  const paid = async (sponsorId: string, email: string): Promise<string> => {
    const id = await newDeal(request, sponsorId, { package_id: gold, sponsor_email: email });
    await dealPost(request, id, "mark-paid");
    return id;
  };
  const disputedDeal = await paid(ridge, "accounts@ridge-gold.example");
  const lostDeal = await paid(oldMill, "hello@old-mill.example");
  const stamp = Math.random().toString(36).slice(2, 8);
  await withDb(async (sql) => {
    await sql`update sponsor_orders
                 set payment_method = 'online', payment_intent_id = ${`pi_capture_open_${stamp}`},
                     disputed_at = now(), dispute_id = ${`dp_capture_open_${stamp}`}
               where id = ${disputedDeal} and org_id = ${org.orgId}`;
    await sql`update sponsor_orders
                 set payment_method = 'online', payment_intent_id = ${`pi_capture_lost_${stamp}`},
                     disputed_at = now(), dispute_id = ${`dp_capture_lost_${stamp}`},
                     status = 'refunded', deal_status = 'ended', ended_at = now(), ended_reason = 'dispute_lost'
               where id = ${lostDeal} and org_id = ${org.orgId}`;
  });
  ids = { long, quay, northbank, ridge, oldMill, plain, liveDeal, endedDeal, queuedDeal, disputedDeal, lostDeal };
});

test.afterAll(async ({ request }) => {
  if (org) await releaseSettingsOrg(request, org);
});

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: HEIGHT } });

    test("the Sponsors list", async ({ page }) => {
      await page.goto(sponsorsUrl(org.slug, "sponsors"));
      const rows = page.getByTestId("sponsor-row");
      await expect(rows, "witness: all six sponsors are listed").toHaveCount(6);
      const chip = (id: string) => page.locator(`[data-testid="sponsor-row"][data-sponsor-id="${id}"]`).getByTestId("deal-chip");
      await expect(chip(ids.long), "witness: a live deal").toHaveText(ui("sponsors.deal.chip.live"));
      await expect(chip(ids.quay), "witness: one waiting for payment").toHaveText(ui("sponsors.deal.chip.awaitingPayment"));
      await expect(chip(ids.northbank), "witness: one waiting for approval").toHaveText(ui("sponsors.deal.chip.awaitingApproval"));
      await expect(chip(ids.plain), "witness: a sponsor with no deal").toHaveText(ui("sponsors.deal.chip.none"));
      await capture(page, shotPath("list", width), `list @${width}`, page.getByTestId("sponsors-tab-sponsors"));
    });

    test("one sponsor's page", async ({ page }) => {
      await page.goto(sponsorUrl(org.slug, ids.long));
      const region = pageRegion(page, width);
      await expect(region.getByTestId("sponsor-sheet-name"), "witness: the 43-character name heads the page").toHaveText(LONG_SPONSOR);
      const deals = region.getByTestId("sponsor-sheet-deal");
      await expect(deals, "witness: its three deals").toHaveCount(3);
      expect(
        await deals.evaluateAll((els) => els.map((e) => e.getAttribute("data-deal-status")).sort()),
        "witness: one live, one queued, one ended",
      ).toEqual(["ended", "live", "scheduled"]);
      await capture(page, shotPath("sponsor-page", width), `sponsor page @${width}`, region);
    });

    test("the Add deal sheet", async ({ page }) => {
      await page.goto(sponsorsUrl(org.slug, "sponsors"));
      const sheet = page.getByTestId("add-deal-sheet");
      await tapUntil(
        page.locator(`[data-testid="sponsor-row"][data-sponsor-id="${ids.plain}"]`).getByTestId("sponsor-row-action"),
        sheet,
        "Add deal opens the sheet",
      );
      await expect(page.getByTestId("add-deal-payment-online"), "witness: the plan sells invoices, so Online is open").toBeEnabled();
      await expectCardsInside(page, width);
      await capture(page, shotPath("add-deal", width), `add deal @${width}`, addDealRegion(page));
    });

    /** One deal's own page, witnessed by the state the deal itself carries (`data-deal-status`) and what `extra` reads off it. */
    async function dealShot(page: Page, state: State, sponsorId: string, dealId: string, status: string, extra: (region: Locator) => Promise<void>): Promise<void> {
      await page.goto(dealUrl(org.slug, sponsorId, dealId));
      const region = pageRegion(page, width);
      await expect(region.getByTestId("deal-page"), `${state}: the deal's page`).toHaveAttribute("data-deal-status", status);
      await extra(region);
      await capture(page, shotPath(state, width), `${state} @${width}`, region);
    }

    test("a live deal's page", async ({ page }) => {
      await dealShot(page, "deal-live", ids.long, ids.liveDeal, "live", async (region) => {
        await expect(stepOf(page, "live"), "witness: the live step is done").toHaveAttribute("data-state", "done");
        // The pair of the disputed shot below: a deal with no dispute carries no badge.
        await expect(region.getByTestId("deal-page-badge"), "witness: no dispute badge on a live deal").toHaveCount(0);
      });
    });

    test("an ended deal's page", async ({ page }) => {
      await dealShot(page, "deal-ended", ids.long, ids.endedDeal, "ended", async () => {
        await expect(stepOf(page, "ended"), "witness: the timeline ends").toHaveAttribute("data-state", "done");
      });
    });

    test("a deal with a dispute open", async ({ page }) => {
      await dealShot(page, "deal-disputed", ids.ridge, ids.disputedDeal, "live", async (region) => {
        await expect(region.locator('[data-testid="deal-page-badge"][data-badge="disputed"]'), "witness: the Disputed badge").toBeVisible();
        await expect(region.getByTestId("deal-page-evidence"), "witness: the evidence link that answers it").toBeVisible();
      });
    });

    test("a deal that lost its dispute", async ({ page }) => {
      await dealShot(page, "deal-dispute-lost", ids.oldMill, ids.lostDeal, "ended", async (region) => {
        await expect(region.locator('[data-testid="deal-page-badge"][data-badge="dispute_lost"]'), "witness: the Dispute lost badge").toBeVisible();
        await expect(region.locator('[data-testid="deal-page-badge"][data-badge="disputed"]'), "witness: a lost dispute is no longer an open one").toHaveCount(0);
        await expect(region.getByTestId("deal-page-evidence"), "witness: nothing left to answer").toHaveCount(0);
      });
    });

    test("Packages: the price list, then Create package", async ({ page }) => {
      await page.goto(sponsorsUrl(org.slug, "packages"));
      const list = page.getByTestId("sponsors-tab-packages");
      await expect(list.getByTestId("package-card"), "witness: the three packages are cards").toHaveCount(3);
      await expect(list.getByTestId("package-used-by").filter({ hasText: ui("sponsors.pkg.notUsed") }), "witness: one package nobody holds").toHaveCount(1);
      await expect(list.getByTestId("package-used-by").filter({ hasText: ui("sponsors.pkg.usedBy.one", { count: "1" }) }), "witness: and one a sponsor holds").not.toHaveCount(0);
      await capture(page, shotPath("packages", width), `packages @${width}`, list);

      const sheet = page.getByTestId("package-create-sheet");
      await tapUntil(list.getByTestId("sponsor-pkg-create"), sheet, "Create package opens the sheet");
      const dialog = page.locator(`[role="dialog"]:has([data-testid="package-create-sheet"])`);
      await expect(sheet.getByTestId("package-create-name"), "witness: the form is open and empty").toHaveValue("");
      await capture(page, shotPath("packages-create", width), `packages create @${width}`, dialog);
    });
  });
}

test.describe("the deal page and the Add deal sheet in Spanish, French and Dutch (1280)", () => {
  test.use({ viewport: { width: 1280, height: HEIGHT } });

  for (const locale of LOCALES) {
    test(`${locale}: a deal's page`, async ({ page }) => {
      const dict = dictionary(locale);
      // The pair of every translated witness below is that it is NOT the English: a page still in English would satisfy a witness
      // that read the English words, and these three shots would be three pictures of the English page.
      expect(word(dict, "sponsors.deal.timeline.created"), `${locale}: the witness word is translated`).not.toBe(word(EN, "sponsors.deal.timeline.created"));
      await page.goto(sponsorsUrl(org.slug, "sponsors"));
      await page.context().addCookies([{ name: "seazn_locale", value: locale, url: new URL(page.url()).origin }]);
      await page.goto(dealUrl(org.slug, ids.long, ids.liveDeal));
      const region = page.getByRole("dialog");
      await expect(region.getByTestId("deal-page"), `${locale}: the deal's page`).toHaveAttribute("data-deal-status", "live");
      await expect(stepOf(page, "created").getByTestId("deal-page-step-title"), `${locale}: its timeline is in ${locale}`).toHaveText(word(dict, "sponsors.deal.timeline.created"));
      await capture(page, localeShotPath("deal-live", locale), `deal page ${locale}`, region);
    });

    test(`${locale}: the Add deal sheet`, async ({ page }) => {
      const dict = dictionary(locale);
      expect(word(dict, "sponsors.deal.action.sendInvoice"), `${locale}: the witness word is translated`).not.toBe(word(EN, "sponsors.deal.action.sendInvoice"));
      await page.goto(sponsorsUrl(org.slug, "sponsors"));
      await page.context().addCookies([{ name: "seazn_locale", value: locale, url: new URL(page.url()).origin }]);
      await page.goto(sponsorsUrl(org.slug, "sponsors"));
      const sheet = page.getByTestId("add-deal-sheet");
      await tapUntil(
        page.locator(`[data-testid="sponsor-row"][data-sponsor-id="${ids.plain}"]`).getByTestId("sponsor-row-action"),
        sheet,
        "Add deal opens the sheet",
      );
      // Online is the opening on this org (invoices sold, Stripe taking charges), so the primary button is Send invoice.
      await expect(page.getByTestId("add-deal-submit"), `${locale}: its primary button is in ${locale}`).toHaveText(word(dict, "sponsors.deal.action.sendInvoice"));
      await expectCardsInside(page, 1280);
      await capture(page, localeShotPath("add-deal", locale), `add deal ${locale}`, addDealRegion(page));
    });
  }
});

test("anti-vacuity: every state at every width exists, is a PNG, and no two are identical", () => {
  const files = [
    ...WIDTHS.flatMap((w) => STATES.map((s) => shotPath(s, w))),
    ...LOCALES.flatMap((l) => [localeShotPath("deal-live", l), localeShotPath("add-deal", l)]),
  ];
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
  console.log(`sponsor deals captures checked: ${files.length} (${STATES.length} states x ${WIDTHS.length} widths + ${LOCALES.length * 2} localized shots)`);
  expect(digests.size).toBe(STATES.length * WIDTHS.length + LOCALES.length * 2);
});
