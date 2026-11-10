// Sponsor deals PR 2, Batch J - the owner's visual sign-off capture: the REAL screens of the deals flow at 320, 768 and 1280, each
// state witnessed BEFORE its shot, the PNGs written to SPONSOR_DEALS_CAPTURE_DIR - which only the e2e workflow's opt-in
// `sponsor_deals_captures` dispatch sets, and which it uploads as the `sponsor-deals-captures` artifact. The PNGs never enter the
// repo (owner 2026-10-09). Modelled on `sponsors-capture.spec.ts`, whose step and upload it sits beside in `.github/workflows/e2e.yml`.
//
// Without SPONSOR_DEALS_CAPTURE_DIR every test here SKIPS: the walkthrough "rest" legs select the file on every push to main (the
// inventory in src/lib/__tests__/e2e-ci-wiring.test.ts names it), and a capture nobody asked for is a minute of CI spent on pictures
// nobody will read.
//
// The states (English, at each of 320 / 768 / 1280, file `<state>-<width>-tall.png`):
//   list               Sponsors tab: every row's chip - live, live on hold, waiting for payment, waiting for approval, ended, no deal
//   sponsor-page       one sponsor's own page: its live deal, the deal queued behind it, and the one that ended
//   add-deal           the Add deal sheet, every payment-method card on screen (Online, Offline, Complimentary)
//   deal-live          a deal's own page, live
//   deal-ended         a deal's own page, ended (the timeline's last step)
//   deal-disputed      a paid deal with a formal dispute open: parked, the "Disputed" badge and the evidence link
//   deal-dispute-lost  a deal that ended because the dispute was lost
//   packages           Packages: the price list, each package's "used by" read from the seed
//   packages-create    Packages with Create package's sheet open
// at 1280 only, the deal page and the Add deal sheet in Spanish, French and Dutch (`deal-live-<locale>-1280-tall`,
// `add-deal-<locale>-1280-tall`), and one picture at a phone's real size: the Add deal sheet at 320 x 568 (`add-deal-320x568.png`).
//
// WHAT IS FAKED, exactly. A dispute needs Stripe, which a capture run does not have. Every deal is made by the REAL producers (the
// create and mark-paid routes). Then, for the two dispute states, SQL does what the dispute webhook's handler
// (usecases/sponsors.ts, `created` for a FORMAL dispute, then `lost`) would write, no more:
//   created : the deal becomes an online one with a payment intent (a dispute is only ever on a card payment), `disputed_at` and
//             `dispute_id` are set, and `parkDeal` runs: `parked_at` is set and `applyDealsToSponsor` holds the sponsor at `pending`
//             (a parked live deal holds its sponsor there; the sponsor's tier, scope and stream are already the deal's, written when
//             the deal went live).
//   lost    : the order is written off (`status = 'refunded'`, `deal_status = 'ended'`, `ended_at`, `ended_reason = 'dispute_lost'`;
//             `disputed_at` and `parked_at` are KEPT, as the handler keeps them) and `applyDealsToSponsor(endedDealId)` runs: every
//             deal has ended, so the sponsor goes `inactive`, and - because a deal wrote its placement (`placement_from_deal_id` set) -
//             its tier, scope and stream are reset to partner / whole org / off the stream and the provenance is cleared.
// It does NOT fake: the dispute alert email, the recovery of the club's transfer, the `competition_events` audit rows, or the public
// pages' cache bust. The page itself is read from the real hub.
//
// The viewport is TALL (1600) on purpose, and the files say so (`-tall`): a side panel and a bottom sheet scroll inside themselves, and
// a picture cut at 900px shows the owner half a screen. A tall picture is NOT what a phone shows - the one 320 x 568 shot is.
// Fitting a phone's real height is also the e2e spec's job (sponsor-deals.spec.ts, "add deal sheet" and "widths").
//
// EVERY WITNESS IS RECOMPUTED FROM THE SEED. `PLAN` below is the seed as data: which sponsor holds which deal on which package, and the
// status each deal ends the seeding in. The seed is checked against it through the API before any shot, and each witness (a row's chip,
// a sponsor's deals, a package's "used by") is derived from `PLAN`, never typed beside it - so a seed change moves the witnesses with it.
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

// --- The seed, as data ---------------------------------------------------------------------------------------------------------------

const SPONSORS = {
  long: LONG_SPONSOR,
  quay: "Quay Fisheries",
  northbank: "Northbank Print",
  ridge: "Ridge Gold Physiotherapy",
  oldMill: "Old Mill Bakery",
  plain: "Plain Sponsor",
} as const;
type SponsorKey = keyof typeof SPONSORS;

const PACKAGES = {
  gold: { name: "Gold Season Package", tier: "gold", priceCents: 150_000 },
  partner: { name: "Partner Board", tier: "partner", priceCents: 25_000 },
  silver: { name: "Programme Advert", tier: "silver", priceCents: 8_000 },
} as const;
type PackageKey = keyof typeof PACKAGES;

type DealStatus = "live" | "scheduled" | "awaiting_payment" | "awaiting_approval" | "ended";
/** `paid`: the order's money is in (a mark-paid went through). `dealChip` reads a SCHEDULED deal that is paid as "Paid", not "Scheduled". */
type PlannedDeal = { key: string; sponsor: SponsorKey; pkg: PackageKey; status: DealStatus; parked?: true; paid?: true };

/** Every deal the seed makes and the status it ends the seeding in (after the two dispute states below). */
const PLAN: readonly PlannedDeal[] = [
  { key: "ended", sponsor: "long", pkg: "gold", status: "ended" },
  { key: "live", sponsor: "long", pkg: "gold", status: "live" },
  { key: "queued", sponsor: "long", pkg: "partner", status: "scheduled" },
  { key: "waiting", sponsor: "quay", pkg: "partner", status: "awaiting_payment" },
  { key: "approval", sponsor: "northbank", pkg: "partner", status: "awaiting_approval", paid: true },
  { key: "disputed", sponsor: "ridge", pkg: "gold", status: "live", parked: true, paid: true },
  { key: "lost", sponsor: "oldMill", pkg: "gold", status: "ended", paid: true },
];
const planned = (key: string): PlannedDeal => {
  const p = PLAN.find((d) => d.key === key);
  if (!p) throw new Error(`PLAN has no deal ${key}`);
  return p;
};

/** A sponsor's row shows its first deal in this order (spec 6.1: the design's own order, declared here, not read from the page). */
const ROW_ORDER: readonly DealStatus[] = ["live", "awaiting_approval", "awaiting_payment", "scheduled"];
/** The chip words a planned deal wears, read the way `dealChip` (lib/sponsor-deals.ts) reads a deal: a parked live deal reads "on hold",
 *  and a SCHEDULED deal that is paid reads "Paid" (it is waiting its turn with the money in), not "Scheduled". No seeded deal is scheduled
 *  AND paid (the queued one is complimentary), so that branch is matched to the source here and not witnessed by a picture. */
function chipWords(d: PlannedDeal): string {
  if (d.status === "live") return d.parked ? ui("sponsors.deal.chip.liveOnHold") : ui("sponsors.deal.chip.live");
  const words: Record<Exclude<DealStatus, "live">, string> = {
    scheduled: d.paid ? ui("sponsors.deal.chip.paid") : ui("sponsors.deal.chip.scheduled"),
    awaiting_payment: ui("sponsors.deal.chip.awaitingPayment"),
    awaiting_approval: ui("sponsors.deal.chip.awaitingApproval"),
    ended: ui("sponsors.deal.chip.ended"),
  };
  return words[d.status];
}
/** The chip words a sponsor's row wears: the chip of the deal it shows (the first in ROW_ORDER, else its latest ended one). */
function rowChipWords(sponsor: SponsorKey): string {
  const mine = PLAN.filter((d) => d.sponsor === sponsor);
  if (mine.length === 0) return ui("sponsors.deal.chip.none");
  const shown = ROW_ORDER.map((s) => mine.find((d) => d.status === s)).find((d) => d !== undefined) ?? mine.find((d) => d.status === "ended")!;
  return chipWords(shown);
}
/** How many DISTINCT sponsors hold a not-ended deal on a package: what its card says ("Used by N sponsors", or "Not used yet"). */
function usedByWords(pkg: PackageKey): string {
  const n = new Set(PLAN.filter((d) => d.pkg === pkg && d.status !== "ended").map((d) => d.sponsor)).size;
  if (n === 0) return ui("sponsors.pkg.notUsed");
  return ui(n === 1 ? "sponsors.pkg.usedBy.one" : "sponsors.pkg.usedBy.other", { count: String(n) });
}

test.skip(!DIR, "opt-in: the e2e workflow's sponsor_deals_captures input sets SPONSOR_DEALS_CAPTURE_DIR");
test.describe.configure({ mode: "serial" });

const shotPath = (state: State, width: number): string => join(DIR!, `${state}-${width}-tall.png`);
const localeShotPath = (state: "deal-live" | "add-deal", locale: Locale): string => join(DIR!, `${state}-${locale}-1280-tall.png`);
const phoneShotPath = (): string => join(DIR!, "add-deal-320x568.png");

let org: SeededOrg;
let sponsorIds: Record<SponsorKey, string>;
let dealIds: Record<string, string>;

async function api<T>(request: APIRequestContext, path: string, method: "POST" | "PATCH" | "DELETE" | "GET", body?: unknown, want = 201): Promise<T> {
  const res = await apiJson<T>(request, `/api/v1/orgs/${org.orgId}${path}`, method, body);
  expect(res.status, `${method} ${path} answered ${res.status}: ${JSON.stringify(res.error)}`).toBe(want);
  return res.data as T;
}
const newSponsor = async (request: APIRequestContext, name: string): Promise<string> =>
  (await api<{ id: string }>(request, "/sponsors", "POST", { name, tier: "partner", url: "https://sponsor.example/" })).id;
const newPackage = async (request: APIRequestContext, p: (typeof PACKAGES)[PackageKey]): Promise<string> =>
  (await api<{ id: string }>(request, "/sponsor-packages", "POST", { name: p.name, price_cents: p.priceCents, currency: "gbp", tier: p.tier })).id;
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
const rowOf = (page: Page, key: SponsorKey): Locator => page.locator(`[data-testid="sponsor-row"][data-sponsor-id="${sponsorIds[key]}"]`);
/** A package's card, by its name (the three names are distinct, none a substring of another). */
const cardOf = (page: Page, list: Locator, pkg: PackageKey): Locator =>
  list.getByTestId("package-card").filter({ has: page.getByTestId("package-name").filter({ hasText: PACKAGES[pkg].name }) });

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

  const pkg = {} as Record<PackageKey, string>;
  for (const key of Object.keys(PACKAGES) as PackageKey[]) pkg[key] = await newPackage(request, PACKAGES[key]);
  const sponsor = {} as Record<SponsorKey, string>;
  for (const key of Object.keys(SPONSORS) as SponsorKey[]) sponsor[key] = await newSponsor(request, SPONSORS[key]);
  const deal: Record<string, string> = {};

  // The long-named sponsor's three deals, in the order that leaves one of each: one that ended, the live one, one queued behind it.
  deal.ended = await newDeal(request, sponsor.long, { package_id: pkg.gold, payment_method: "complimentary", go_live: "immediate" });
  await dealPost(request, deal.ended, "end");
  deal.live = await newDeal(request, sponsor.long, { package_id: pkg.gold, payment_method: "complimentary", go_live: "immediate" });
  deal.queued = await newDeal(request, sponsor.long, { package_id: pkg.partner, payment_method: "complimentary", go_live: "immediate" });

  // One waiting for the club's money, one paid and waiting for the club's approval.
  deal.waiting = await newDeal(request, sponsor.quay, { package_id: pkg.partner });
  deal.approval = await newDeal(request, sponsor.northbank, { package_id: pkg.partner, go_live: "on_approval" });
  await dealPost(request, deal.approval, "mark-paid");

  // The two dispute states: paid through the real route (it goes live), then given what the dispute handler writes (see the header).
  const paid = async (sponsorId: string, email: string): Promise<string> => {
    const id = await newDeal(request, sponsorId, { package_id: pkg.gold, sponsor_email: email });
    await dealPost(request, id, "mark-paid");
    return id;
  };
  deal.disputed = await paid(sponsor.ridge, "accounts@ridge-gold.example");
  deal.lost = await paid(sponsor.oldMill, "hello@old-mill.example");
  const stamp = Math.random().toString(36).slice(2, 8);
  await withDb(async (sql) => {
    // `created`, a formal dispute, for both: the deal is an online one, flagged, and PARKED (parkDeal), which holds its sponsor at pending.
    for (const [id, sponsorId, tag] of [[deal.disputed!, sponsor.ridge, "open"], [deal.lost!, sponsor.oldMill, "lost"]] as const) {
      await sql`update sponsor_orders
                   set payment_method = 'online', payment_intent_id = ${`pi_capture_${tag}_${stamp}`},
                       disputed_at = now(), dispute_id = ${`dp_capture_${tag}_${stamp}`}, parked_at = now()
                 where id = ${id} and org_id = ${org.orgId}`;
      await sql`update sponsors set status = 'pending' where id = ${sponsorId} and org_id = ${org.orgId}`;
    }
    // `lost`, for the second: the order is written off and the deal ends; every deal of its sponsor has now ended, so the sponsor goes
    // inactive, and its placement is reset ONLY when a deal wrote it (applyDealsToSponsor, the `ended_all` branch).
    await sql`update sponsor_orders
                 set status = 'refunded', deal_status = 'ended', ended_at = now(), ended_reason = 'dispute_lost'
               where id = ${deal.lost!} and org_id = ${org.orgId}`;
    const [row] = await sql<{ placement_from_deal_id: string | null }[]>`select placement_from_deal_id from sponsors where id = ${sponsor.oldMill}`;
    expect(row, "premise: the sponsor row is there").toBeDefined();
    if (row!.placement_from_deal_id !== null) {
      await sql`update sponsors
                   set status = 'inactive', tier = 'partner', competition_id = null, on_stream = false, placement_from_deal_id = null
                 where id = ${sponsor.oldMill} and org_id = ${org.orgId}`;
    } else {
      await sql`update sponsors set status = 'inactive' where id = ${sponsor.oldMill} and org_id = ${org.orgId}`;
    }
  });

  // The seed against its own plan, through the API, before any shot: a deal that ended up anywhere else fails HERE, naming it, and not as
  // a witness that disagrees with a picture three tests later.
  const read = await api<{ id: string; sponsor_id: string; package_id: string; deal_status: string }[]>(request, "/sponsor-deals", "GET", undefined, 200);
  expect(read.length, "the org holds exactly the planned deals").toBe(PLAN.length);
  for (const p of PLAN) {
    const actual = read.find((d) => d.id === deal[p.key]);
    expect(actual, `planned deal ${p.key} is in the org's deals`).toBeDefined();
    expect({ sponsor: actual!.sponsor_id, pkg: actual!.package_id, status: actual!.deal_status }, `planned deal ${p.key}`).toEqual({
      sponsor: sponsor[p.sponsor], pkg: pkg[p.pkg], status: p.status,
    });
  }
  sponsorIds = sponsor;
  dealIds = deal;
});

test.afterAll(async ({ request }) => {
  if (org) await releaseSettingsOrg(request, org);
});

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: HEIGHT } });

    test("the Sponsors list", async ({ page }) => {
      await page.goto(sponsorsUrl(org.slug, "sponsors"));
      await expect(page.getByTestId("sponsor-row"), "witness: every planned sponsor is listed").toHaveCount(Object.keys(SPONSORS).length);
      for (const key of Object.keys(SPONSORS) as SponsorKey[]) {
        await expect(rowOf(page, key).getByTestId("deal-chip"), `witness: ${SPONSORS[key]}'s chip, from the plan`).toHaveText(rowChipWords(key));
      }
      await capture(page, shotPath("list", width), `list @${width}`, page.getByTestId("sponsors-tab-sponsors"));
    });

    test("one sponsor's page", async ({ page }) => {
      await page.goto(sponsorUrl(org.slug, sponsorIds.long));
      const region = pageRegion(page, width);
      await expect(region.getByTestId("sponsor-sheet-name"), "witness: the 43-character name heads the page").toHaveText(LONG_SPONSOR);
      const deals = region.getByTestId("sponsor-sheet-deal");
      const want = PLAN.filter((d) => d.sponsor === "long").map((d) => d.status).sort();
      await expect(deals, "witness: its planned deals").toHaveCount(want.length);
      expect(
        await deals.evaluateAll((els) => els.map((e) => e.getAttribute("data-deal-status")).sort()),
        "witness: the planned statuses - one live, one queued, one ended",
      ).toEqual(want);
      await capture(page, shotPath("sponsor-page", width), `sponsor page @${width}`, region);
    });

    test("the Add deal sheet", async ({ page }) => {
      await page.goto(sponsorsUrl(org.slug, "sponsors"));
      const sheet = page.getByTestId("add-deal-sheet");
      await tapUntil(rowOf(page, "plain").getByTestId("sponsor-row-action"), sheet, "Add deal opens the sheet");
      await expect(page.getByTestId("add-deal-payment-online"), "witness: the plan sells invoices, so Online is open").toBeEnabled();
      await expectCardsInside(page, width);
      await capture(page, shotPath("add-deal", width), `add deal @${width}`, addDealRegion(page));
    });

    /** One deal's own page, witnessed by the status the PLAN gives the deal and what `extra` reads off it. */
    async function dealShot(page: Page, state: State, key: string, extra: (region: Locator) => Promise<void>): Promise<void> {
      const p = planned(key);
      await page.goto(dealUrl(org.slug, sponsorIds[p.sponsor], dealIds[key]!));
      const region = pageRegion(page, width);
      await expect(region.getByTestId("deal-page"), `${state}: the deal's page`).toHaveAttribute("data-deal-status", p.status);
      await extra(region);
      await capture(page, shotPath(state, width), `${state} @${width}`, region);
    }

    test("a live deal's page", async ({ page }) => {
      await dealShot(page, "deal-live", "live", async (region) => {
        await expect(stepOf(page, "live"), "witness: the live step is done").toHaveAttribute("data-state", "done");
        // The pair of the disputed shot below: a deal with no dispute carries no badge.
        await expect(region.getByTestId("deal-page-badge"), "witness: no dispute badge on a live deal").toHaveCount(0);
        await expect(region.getByTestId("deal-chip"), "witness: a live deal's chip, from the plan").toHaveText(chipWords(planned("live")));
      });
    });

    test("an ended deal's page", async ({ page }) => {
      await dealShot(page, "deal-ended", "ended", async () => {
        await expect(stepOf(page, "ended"), "witness: the timeline ends").toHaveAttribute("data-state", "done");
      });
    });

    test("a deal with a dispute open", async ({ page }) => {
      await dealShot(page, "deal-disputed", "disputed", async (region) => {
        await expect(region.locator('[data-testid="deal-page-badge"][data-badge="disputed"]'), "witness: the Disputed badge").toBeVisible();
        await expect(region.getByTestId("deal-page-evidence"), "witness: the evidence link that answers it").toBeVisible();
        // Parked by the dispute: still live in the ledger, but not live on the pages, and the chip says so (the pair of the live deal above).
        const held = chipWords(planned("disputed"));
        expect(held, "premise: the on-hold words are not the plain live words").not.toBe(chipWords(planned("live")));
        await expect(region.getByTestId("deal-chip"), "witness: the parked deal's chip reads on hold").toHaveText(held);
      });
    });

    test("a deal that lost its dispute", async ({ page }) => {
      await dealShot(page, "deal-dispute-lost", "lost", async (region) => {
        await expect(region.locator('[data-testid="deal-page-badge"][data-badge="dispute_lost"]'), "witness: the Dispute lost badge").toBeVisible();
        await expect(region.locator('[data-testid="deal-page-badge"][data-badge="disputed"]'), "witness: a lost dispute is no longer an open one").toHaveCount(0);
        await expect(region.getByTestId("deal-page-evidence"), "witness: nothing left to answer").toHaveCount(0);
      });
    });

    test("Packages: the price list, then Create package", async ({ page }) => {
      await page.goto(sponsorsUrl(org.slug, "packages"));
      const list = page.getByTestId("sponsors-tab-packages");
      await expect(list.getByTestId("package-card"), "witness: every planned package is a card").toHaveCount(Object.keys(PACKAGES).length);
      for (const key of Object.keys(PACKAGES) as PackageKey[]) {
        await expect(cardOf(page, list, key).getByTestId("package-used-by"), `witness: ${PACKAGES[key].name}'s "used by", counted from the plan`).toHaveText(usedByWords(key));
      }
      // The three differ, so a list that read one number for every card cannot pass.
      expect(new Set((Object.keys(PACKAGES) as PackageKey[]).map(usedByWords)).size, "premise: the three cards say three different things").toBe(3);
      await capture(page, shotPath("packages", width), `packages @${width}`, list);

      const sheet = page.getByTestId("package-create-sheet");
      await tapUntil(list.getByTestId("sponsor-pkg-create"), sheet, "Create package opens the sheet");
      const dialog = page.locator(`[role="dialog"]:has([data-testid="package-create-sheet"])`);
      await expect(sheet.getByTestId("package-create-name"), "witness: the form is open and empty").toHaveValue("");
      await capture(page, shotPath("packages-create", width), `packages create @${width}`, dialog);
    });
  });
}

test.describe("the Add deal sheet on a phone's real screen (320 x 568)", () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test("the bottom sheet, as a person holding the phone sees it", async ({ page }) => {
    await page.goto(sponsorsUrl(org.slug, "sponsors"));
    const sheet = page.getByTestId("add-deal-sheet");
    await tapUntil(rowOf(page, "plain").getByTestId("sponsor-row-action"), sheet, "Add deal opens the sheet");
    const submit = page.getByTestId("add-deal-submit");
    await expect(submit, "witness: the primary button is drawn").toBeVisible();
    const screen = page.viewportSize()!;
    const button = (await submit.boundingBox())!;
    expect(button.y, "witness: the primary button starts on the screen").toBeGreaterThanOrEqual(0);
    expect(button.y + button.height, "witness: and ends on it - a person never has to scroll to send").toBeLessThanOrEqual(screen.height + 1);
    const dialog = (await addDealRegion(page).boundingBox())!;
    expect(dialog.y + dialog.height, "witness: the sheet sits on the screen's bottom edge").toBeLessThanOrEqual(screen.height + 1);
    expect(dialog.height, "witness: and is a sheet, not the whole screen").toBeLessThan(screen.height);
    await capture(page, phoneShotPath(), "add deal @320x568", addDealRegion(page));
  });
});

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
      await page.goto(dealUrl(org.slug, sponsorIds.long, dealIds.live!));
      const region = page.getByRole("dialog");
      await expect(region.getByTestId("deal-page"), `${locale}: the deal's page`).toHaveAttribute("data-deal-status", planned("live").status);
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
      await tapUntil(rowOf(page, "plain").getByTestId("sponsor-row-action"), sheet, "Add deal opens the sheet");
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
    phoneShotPath(),
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
  const expected = STATES.length * WIDTHS.length + LOCALES.length * 2 + 1;
  console.log(`sponsor deals captures checked: ${files.length} (${STATES.length} states x ${WIDTHS.length} widths + ${LOCALES.length * 2} localized shots + 1 phone shot)`);
  expect(files.length, "the picture count is the one the header promises").toBe(expected);
  expect(digests.size).toBe(expected);
});
