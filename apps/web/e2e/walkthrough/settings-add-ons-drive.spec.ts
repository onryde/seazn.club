import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { seedSettingsOrg, releaseSettingsOrg, type SeededOrg } from "../settings-support";
import { setOrgSubscriptionSql } from "../helpers";
import { ORG_ADDON_RIDER_PLANS, money, orgAddonMinor } from "../price-kit";
import { routes } from "../../src/lib/routes";

/**
 * W4 of the settings walkthrough programme — the Add-ons tab's own controls
 * (`/o/{slug}/settings/add-ons`, SPEC-6 §A5, v17 gap #293) and the refusal
 * branches of the route behind them.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: complete a purchase. Saving a
 * non-zero count calls `stripe.subscriptions.retrieve` on the group's real
 * subscription id, and every org this suite can seed carries a FIXTURE id — so
 * a Save here would not be a purchase at all, it would be a 500 and a Sentry
 * capture for a Stripe object that does not exist. The W4 plan §1 rules real
 * money out of this wave for its own (budget) reasons; the point worth
 * recording is that the shortcut is not available even if it had not.
 *
 * What is left is exactly what design §7 Class 1/2 asks for on this surface and
 * what no unit test can see: WHICH control the page offers in each group state,
 * what the stepper OPENS AT, what its bounds are, what price it quotes, and
 * which of the route's refusals fires for which state. `apps/web` vitest is
 * `environment: "node"`, so the page's four-way branch (community / no live
 * subscription / not the payer / the control) has never been driven in a
 * browser; `add-ons-page.test.tsx` renders the component with props handed to
 * it, which proves the component and not the wiring.
 *
 * THREE THINGS THE BRIEF FOR THIS FILE GOT WRONG, all corrected here and all
 * verified against the tree rather than assumed (AGENTS.md failure class 5):
 *
 *  1. `POST /api/billing/extra-orgs` takes `{ count }` and NOTHING else — its
 *     Zod schema is `.strict()`, so the `{ org_id, count }` body the brief
 *     sketched answers 422 (bad body), never the 409 it was written to prove.
 *     WHICH group is acted on comes from the `x-seazn-org` header, else the
 *     `seazn_org` cookie (`requireBillingOwner` -> `requestScopedOrgId`), which
 *     is why every call below names its org in a header rather than a field.
 *  2. There is no disabled Save button to assert on: `extra-orgs-control.tsx`
 *     renders Save and Cancel ONLY while the draft is dirty. "Disabled until
 *     dirty" and "absent until dirty" are different products; the second is the
 *     one that shipped.
 *  3. `setOrgSubscriptionSql` is `(orgId, { plan_key, status, … })` — a bare id
 *     and a FIELDS OBJECT, not `({ orgId }, planKey)`.
 *
 * `mode: "default"`, matching settings-connect-gates.spec.ts: `fullyParallel`
 * would run `beforeAll` — and so `seedSettingsOrg` — once per worker against a
 * shared Pro user bounded to five owned orgs, and `serial` would skip every
 * test after the first red, which is the opposite of what a walkthrough is for.
 */
test.describe.configure({ mode: "default" });

/** Copy read from the dictionary the page renders from, never retyped — this
 *  folder's idiom (settings-org-tabs.spec.ts:60, settings-admin.spec.ts:11). */
const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);

/** `t()`'s `{name}` interpolation. Throws on a missing key: a renamed key must
 *  red loudly here rather than resolve to a locator that matches nothing and
 *  times out three assertions later. */
function ui(key: string, vars: Record<string, string | number> = {}): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en dictionary key: ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`));
}

/** Budgets expressed in what each test does, never a flat literal beside a
 *  derived cost (AGENTS.md failure class 20). */
const NAV_MS = 20_000;
const API_MS = 6_000;
const budget = (navs: number, apis: number): number =>
  Math.max(60_000, 15_000 + navs * NAV_MS + apis * API_MS);

const READ_MS = 20_000;

/** The plan the beforeAll org is put on, and therefore the plan whose rider
 *  price every money assertion below is derived from. Named once so the seed
 *  lookups and the DB writes cannot drift apart. */
const PLAN = "pro";

let org: SeededOrg;

// ---------------------------------------------------------------------------
// State the product itself has no path to set
// ---------------------------------------------------------------------------

/**
 * A short-lived direct connection, the same shape settings-connect-gates.spec.ts
 * and registration-connect.spec.ts open. Deliberately NOT `src/lib/db`:
 * importing it drags the app's whole DB/auth graph into the Playwright process.
 */
async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { connection: { search_path: "seazn_club" }, ssl: false });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The currency this org's BILL is in — what `preferredCurrency` reads first
 * (`subscriptions.currency`, joined through `organizations.subscription_id`)
 * and therefore the currency the rider is quoted in.
 *
 * Written directly because nothing in the product writes it: it is mirrored
 * from Stripe at checkout, and this suite never reaches a checkout. Setting it
 * explicitly is also what makes the price assertions deterministic instead of
 * dependent on the runner's Accept-Language falling through to usd.
 */
async function setGroupCurrency(orgId: string, currency: string | null): Promise<void> {
  await withDb(async (sql) => {
    await sql`
      update subscriptions s set currency = ${currency}
       from organizations o
      where o.subscription_id = s.id and o.id = ${orgId}`;
  });
}

/**
 * Give the group a live paid subscription WITHOUT Stripe.
 *
 * `hasLiveSubscription` (lib/subscription-status.ts) is `stripe_subscription_id
 * IS NOT NULL` **and** a status in the live set — two columns, not one — and
 * `seedSettingsOrg`'s Pro flip moves neither, so a freshly seeded Pro org has
 * no live subscription at all. That is a real product state (the plan row says
 * Pro, checkout was never completed), and the page has its own branch for it,
 * which is why the first test asserts that branch before this runs.
 *
 * The id is a fixture, and it is never dereferenced: every assertion in this
 * file stops at a guard that runs BEFORE `stripe.subscriptions.retrieve`.
 */
async function makeGroupLive(seeded: SeededOrg, planKey = PLAN): Promise<void> {
  await setOrgSubscriptionSql(seeded.orgId, {
    plan_key: planKey,
    status: "active",
    stripe_subscription_id: `sub_e2e_addons_${seeded.orgId.slice(0, 8)}`,
  });
}

/**
 * `POST /api/billing/extra-orgs`, naming the org in the header the product's
 * own client seams stamp (`x-seazn-org`, lib/org-scope.ts).
 *
 * Not `apiJson`: it sets no such header, so the call would land on whatever org
 * the shared cookie jar last pointed at — and `seedSettingsOrg` moves that
 * cookie on every seed, so the target would depend on test order. It also types
 * `error` as an object, while `handler`'s HttpError branch answers a bare
 * `{ ok: false, error: "<string>" }` — and the STRING is what separates this
 * route's two different 409s from each other.
 */
async function postExtraOrgs(
  request: APIRequestContext,
  slug: string,
  body: unknown,
): Promise<{ status: number; error: string }> {
  const res = await request.fetch("/api/billing/extra-orgs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-seazn-org": slug },
    data: body,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: unknown };
  return { status: res.status(), error: typeof json.error === "string" ? json.error : "" };
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

/** The stepper's own number field — the one `data-` hook the control ships. */
const countField = (page: Page) => page.locator("[data-extra-org-count]");

/** The rider card, so "Save" cannot be satisfied by some other Save on the
 *  settings shell if one ever lands there. */
const riderCard = (page: Page) =>
  page.locator("div.card").filter({ has: page.locator("[data-extra-org-count]") });

const saveButton = (page: Page) =>
  riderCard(page).getByRole("button", { name: ui("addOns.extraOrg.save"), exact: true });

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { plan: PLAN, label: "W4-addons" });
  } finally {
    await ctx.close();
  }
});

test.afterAll(async ({ browser }) => {
  // The release lives here, never in a `finally` inside a test: a Playwright
  // `test.setTimeout` does not unwind the test function, so a `finally` there
  // never runs and a leaked seed spends one of the shared Pro user's five
  // owner slots for the rest of the leg.
  if (!org) return;
  const ctx = await browser.newContext();
  try {
    await releaseSettingsOrg(ctx.request, org);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------

test("the tab offers no stepper until the group has a live subscription, then opens it at the 0 riders the group actually holds", async ({
  page,
}: {
  page: Page;
}) => {
  test.setTimeout(budget(2, 0));

  // ARM ONE: Pro by plan row, but checkout never completed. The page must say
  // so and offer nothing — a stepper here would take a number the route cannot
  // honour and answer 409 after the customer had already chosen.
  await page.goto(routes.addOns(org.slug));
  await expect(
    page.getByText(ui("addOns.noLiveSubscription")),
    "a Pro plan row without a live subscription must be said in words",
  ).toBeVisible({ timeout: READ_MS });
  await expect(
    countField(page),
    "…and the stepper must not be in the DOM at all, not merely hidden",
  ).toHaveCount(0);

  // ARM TWO: the same org, now billed.
  await makeGroupLive(org);
  await page.reload();

  const count = countField(page);
  await expect(count, "a billed Pro group gets the control").toBeVisible({ timeout: READ_MS });
  // Pin what the control OPENS AT, not merely that it is reachable (AGENTS.md
  // failure class 19). Nothing has been bought, so the honest opening value is
  // 0 — a control that opened at 1 would read as a rider already on the bill.
  await expect(count, "it opens at the riders the group actually holds").toHaveValue("0");
  await expect(count, "…and declares that same number as its floor").toHaveAttribute("min", "0");

  await expect(
    page.getByRole("button", { name: ui("addOns.extraOrg.decrease") }),
    "decrease is dead at the floor",
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: ui("addOns.extraOrg.increase") }),
    "…while increase is live, so this is a bound and not a dead card",
  ).toBeEnabled();

  // Save is ABSENT, not disabled, until the draft differs from the baseline —
  // `extra-orgs-control.tsx` renders the Save/Cancel pair inside `dirty &&`.
  await expect(saveButton(page), "nothing to save yet").toHaveCount(0);
  await expect(
    page.getByText(ui("addOns.extraOrg.floorNote", { min: 0 })),
    "no organisation is standing on a rider, so no floor note",
  ).toHaveCount(0);
});

test("stepping up offers Save and quotes the catalog's own price — per unit, and multiplied", async ({
  page,
}: {
  page: Page;
}) => {
  test.setTimeout(budget(1, 0));

  await makeGroupLive(org);
  await setGroupCurrency(org.orgId, "usd");
  await page.goto(routes.addOns(org.slug));

  const unit = orgAddonMinor(PLAN, "usd");
  expect(unit, `stripe-plans.json sells no ${PLAN} rider — this file has nothing to assert`)
    .not.toBeNull();
  await expect(
    page.getByText(ui("addOns.extraOrg.priceEach", { price: money(unit!, "usd") })),
    "the quoted rate is the rider SKU's own, read from the seed Stripe is synced from",
  ).toBeVisible({ timeout: READ_MS });

  const count = countField(page);
  const increase = page.getByRole("button", { name: ui("addOns.extraOrg.increase") });
  await increase.click();
  await expect(count).toHaveValue("1");
  await expect(saveButton(page), "a dirty draft offers Save").toBeVisible();
  await expect(saveButton(page)).toBeEnabled();

  // TWO, not one: at a count of 1 the total and the unit price are the same
  // string, so a control that rendered the unit rate as the total would pass.
  await increase.click();
  await expect(count).toHaveValue("2");
  await expect(
    page.getByText(ui("addOns.extraOrg.newTotal", { total: money(unit! * 2, "usd") })),
    "the new total is the rate times the count, not the rate again",
  ).toBeVisible();
  await expect(
    page.getByText(ui("addOns.extraOrg.prorateUp")),
    "raising says the difference is charged now",
  ).toBeVisible();

  // Cancel returns the draft to the baseline, which takes Save away again —
  // proving Save's presence tracks dirtiness rather than having appeared once
  // and stuck. NOT Save: see this file's header on why nothing here buys.
  await riderCard(page)
    .getByRole("button", { name: ui("addOns.extraOrg.cancel"), exact: true })
    .click();
  await expect(count, "cancel restores the count the group holds").toHaveValue("0");
  await expect(saveButton(page), "…and withdraws the offer to save").toHaveCount(0);
});

test("the rider is quoted in the currency the group is billed in, not in a default", async ({
  page,
}: {
  page: Page;
}) => {
  test.setTimeout(budget(1, 0));

  const usd = orgAddonMinor(PLAN, "usd");
  const gbp = orgAddonMinor(PLAN, "gbp");
  expect(usd, "no usd price point for the rider").not.toBeNull();
  expect(gbp, "no gbp price point for the rider").not.toBeNull();
  // Anti-vacuity: if the two rendered the same string this test could not tell
  // a page that honours the bill's currency from one that always says usd.
  expect(money(gbp!, "gbp")).not.toBe(money(usd!, "usd"));

  await makeGroupLive(org);
  await setGroupCurrency(org.orgId, "gbp");
  try {
    await page.goto(routes.addOns(org.slug));
    await expect(
      page.getByText(ui("addOns.extraOrg.priceEach", { price: money(gbp!, "gbp") })),
      "a gbp bill quotes the rider's gbp price point",
    ).toBeVisible({ timeout: READ_MS });
    await expect(
      page.getByText(ui("addOns.extraOrg.priceEach", { price: money(usd!, "usd") })),
      "…and not the usd one as well",
    ).toHaveCount(0);
  } finally {
    // Restored so a later test's money assertions cannot inherit this one's
    // currency. The `finally` is best-effort — a `test.setTimeout` does not
    // unwind — which is why every money assertion in this file sets the
    // currency it wants rather than trusting the order it runs in.
    await setGroupCurrency(org.orgId, "usd");
  }
});

test("the ceiling the stepper declares is the ceiling the route enforces", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(1, 1));

  await makeGroupLive(org);
  await page.goto(routes.addOns(org.slug));

  const count = countField(page);
  await expect(count).toBeVisible({ timeout: READ_MS });
  // Read off the control rather than restated here: `MAX_EXTRA_ORGS` lives in
  // `lib/billing-group.ts`, which opens with `import "server-only"` and cannot
  // be imported into this process. What makes this more than an echo is the
  // API call below — the same number has to come back out of the route's own
  // refusal, and the route reads the constant directly.
  const max = Number(await count.getAttribute("max"));
  expect(max, "the control must declare a finite ceiling").toBeGreaterThan(1);

  await count.fill(String(max + 1));
  await expect(
    page.getByText(ui("addOns.extraOrg.outOfRange", { min: 0, max })),
    "over the ceiling, the control says so",
  ).toBeVisible();
  await expect(count, "…and marks the field invalid").toHaveAttribute("aria-invalid", "true");
  await expect(
    saveButton(page),
    "…and refuses to offer a save that would be refused",
  ).toHaveCount(0);

  // The other side of the boundary, so the refusal is about the ceiling rather
  // than about any large-looking number.
  await count.fill(String(max));
  await expect(
    page.getByText(ui("addOns.extraOrg.outOfRange", { min: 0, max })),
    "at the ceiling, the complaint clears",
  ).toHaveCount(0);
  await expect(saveButton(page), "…and the save is offered").toBeVisible();

  // The server's own answer, reached before any Stripe call (the count check is
  // the FIRST statement of setExtraOrgs, ahead of requireBillingOwner). Its
  // message carries the bound, so this compares the number the control declares
  // to the number the route refuses on — two renderings of one constant that
  // have drifted before in this repo.
  const refused = await postExtraOrgs(request, org.slug, { count: max + 1 });
  expect(refused.status, "one past the ceiling").toBe(422);
  expect(refused.error, "the route refuses on the same bound the control declares").toContain(
    String(max),
  );
});

test("the API refuses a group with no live subscription — 409, and the tab never offered the control", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(1, 3));

  // Its own org, and this is the isolation case design §3 sanctions extra orgs
  // for: the state under test is "no live subscription", which is exactly the
  // state the shared org in this file has been moved out of.
  const community = await seedSettingsOrg(request, { plan: "community", label: "W4-addons-nosub" });
  try {
    const refused = await postExtraOrgs(request, community.slug, { count: 1 });
    expect(refused.status, "a group with nothing to attach an item to").toBe(409);
    expect(
      refused.error,
      "…refused for the subscription, not for the plan — the two 409s have different remedies",
    ).toContain("active paid subscription");

    // And the page never made the offer the route just refused. Community hits
    // the FIRST branch of the page's ladder (no rider SKU on this plan), which
    // is why the copy is the community notice rather than the no-subscription
    // one.
    await page.goto(routes.addOns(community.slug));
    await expect(page.getByText(ui("addOns.communityNotice"))).toBeVisible({ timeout: READ_MS });
    await expect(countField(page), "no stepper on a plan that cannot hold a rider").toHaveCount(0);
  } finally {
    await releaseSettingsOrg(request, community);
  }
});

test("…and refuses a live subscription on a plan the catalog sells no rider for — a different 409", async ({
  request,
}: {
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(0, 3));

  // Anti-vacuity, derived from the seed rather than typed: if community ever
  // gained a rider SKU this case would silently stop testing the branch it is
  // named for.
  expect(
    ORG_ADDON_RIDER_PLANS,
    "community must have no rider SKU, or this case no longer applies",
  ).not.toContain("community");
  expect(ORG_ADDON_RIDER_PLANS.length, "…and some plan must have one").toBeGreaterThan(0);

  const community = await seedSettingsOrg(request, { plan: "community", label: "W4-addons-sku" });
  try {
    // A live subscription ON COMMUNITY: contrived, but it is the only way to
    // reach the SECOND 409 — the first guard would otherwise answer for it, and
    // two tests asserting the same status through the same branch would prove
    // half of what they claim.
    await makeGroupLive(community, "community");
    const refused = await postExtraOrgs(request, community.slug, { count: 1 });
    expect(refused.status, "live subscription, no rider SKU for the plan").toBe(409);
    expect(refused.error, "…refused for the PLAN this time, and it says which").toContain(
      "community",
    );
    expect(
      refused.error,
      "…which is a different sentence from the no-subscription refusal",
    ).not.toContain("active paid subscription");
  } finally {
    await releaseSettingsOrg(request, community);
  }
});
