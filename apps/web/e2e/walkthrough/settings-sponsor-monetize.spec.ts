import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TAG, apiJson, setBoolEntitlementOverrideSql } from "../helpers";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  settingsUrl,
  type SeededOrg,
} from "../settings-support";
import {
  claimConnectAccount,
  releaseConnectAccount,
  withDb,
  type ConnectClaim,
} from "../rs007-money-kit";

/**
 * W4 of the settings walkthrough programme — the sponsor MONETIZE half of
 * `?tab=sponsors`, the one control set `settings-org-tabs.spec.ts` (W2)
 * excludes by name in its own doc comment: "Every control in
 * `sponsor-packages.tsx` (sell / invoice / refund) is the monetize half — it
 * needs the shared Connect fixture account".
 *
 * Sell a priced package, send a pay-now invoice, take the payment, refund it —
 * every leg through REAL Stripe test mode against the REAL connected account.
 *
 * OPT-IN, same gate as the three existing Connect walkthroughs:
 *   eval "$(seazn-env env --label <l>)"; set -a; . ./apps/web/.env.local; set +a
 *   CONNECT_WALKTHROUGH=1 PLAYWRIGHT_BASE=http://localhost:<port> \
 *     npx playwright test e2e/walkthrough/settings-sponsor-monetize.spec.ts \
 *     --project=walkthrough
 *
 * `mode: "serial"`, and the ONLY settings spec in this programme that is —
 * every sibling is `mode: "default"` so one red cannot hide the next. Serial is
 * forced here twice over. The fixture account (`STRIPE_CONNECT_TEST_ACCOUNT`)
 * is claimed by a `beforeAll` behind an advisory lock (see below), so a second
 * worker generation would not seize it — it would STALL on that lock for the
 * whole of the first generation's run, which is a hang rather than a defect
 * but is no better; and the
 * four legs below are ONE money trail (package -> order -> payment -> refund),
 * where leg N+1 has nothing to assert without leg N's Stripe object. Same
 * reason `registration-connect.spec.ts` and the rs007 specs are each their own
 * self-contained serial file rather than sharing a project-wide serial mode.
 *
 * ── FIVE THINGS THE BRIEF FOR THIS FILE GOT WRONG ────────────────────────────
 * Each re-checked against the tree rather than assumed (AGENTS.md class 5).
 *
 *  1. **The refund the brief asks for cannot follow the invoice it asks for.**
 *     `sponsor-packages.tsx:467` renders the Refund control only for
 *     `order.status === "paid" && !order.disputed_at`, and a just-sent invoice
 *     is `pending` — `startSponsorCheckout` inserts the order, mints a Checkout
 *     Session and emails a link. Nothing moves it to `paid` except
 *     `payment_intent.succeeded` carrying `metadata.kind === "sponsor"`
 *     (`billing-events.ts:2172` -> `handleSponsorPaymentSucceeded`). The
 *     brief's three-step flow would have clicked a button that never renders.
 *
 *     Closed here the way `scripts/smoke.ts` already closes it for the
 *     analogous registration path (`payRealDestinationCharge`, smoke.ts:9151):
 *     an INDEPENDENT, real destination charge against the fixture account, then
 *     that real PaymentIntent hand-delivered to our own webhook route as a
 *     correctly-signed event. A real Checkout Session's `payment_intent` stays
 *     null until a browser visits the hosted page, and Stripe cannot reach
 *     localhost for the callback, so this is the only mechanism that produces a
 *     genuinely paid sponsor order without a `stripe listen` forwarder. The
 *     Session minted in leg 2 is still real and still proves the Connect rail —
 *     Stripe rejects a fabricated `acct_e2e_*` as a transfer destination, which
 *     is exactly why `helpers.ts`'s `setOrgConnectSql` is unusable here.
 *
 *  2. **Every selector in the brief is wrong.** They were guessed English, not
 *     read: there is no "new package" ("Create package"), no "invoice" button
 *     ("Send invoice"), no "send" ("Send pay-now invoice"), and `/sent/i`
 *     matches nothing until the order POST resolves. Nor is anything reachable
 *     by `getByLabel(/name/i)`: every field on this panel sits inside a
 *     WRAPPING `<label>` that also holds the control, so Playwright resolves it
 *     by text CONTENT — which folds in a `<select>`'s option labels — and
 *     "name" alone matches both "Package name" and "Sponsor name". Fields are
 *     located as "the control inside the label that says X", the same idiom
 *     `settings-org-tabs.spec.ts:70-84` established on this very page.
 *
 *  3. **The `sponsors.monetize` override is a no-op on a Pro org.** The live
 *     catalog grants it at pro/enterprise/event_pass/event_pass_l and refuses
 *     it only at community (`select * from plan_entitlements where feature_key
 *     = 'sponsors.monetize'`, checked against this run's DB). The call is kept
 *     anyway, and deliberately: `entitlements v18` is re-cutting the plan
 *     ladder in a sibling branch, and a spec whose whole subject is the paid
 *     half should not go vacuously "upsell" the day the key moves tiers. It is
 *     belt-and-braces, not the enabling step the brief believed it was.
 *
 *  4. **Two more secrets are required, neither named in the brief.** The
 *     refund is a REAL `refunds.create` on the SERVER, so the server under test
 *     needs a live test key; and leg 3 signs an event the server verifies, so
 *     the runner needs the SAME `STRIPE_WEBHOOK_SECRET` the server booted with.
 *     Both are gated below with named skip reasons rather than discovered as a
 *     500 four minutes in.
 *
 *  5. `settingsUrl(slug, "sponsors")` IS right — the one place in W4 where it
 *     is. `sponsors` is a real `SettingsTab` (`settings-nav.tsx:15-22`), unlike
 *     `connect`/`credits`/`add-ons`/`billing`, which are `SettingsNavKey`s with
 *     their own routes and which silently fell back to the organisation panel
 *     for Tasks 1-3. Verified rather than inherited.
 *
 * SELECTORS. One `data-testid` was added with this file —
 * `sponsor-packages` on the console's root. It is not convenience: `OrgSponsors`
 * renders directly above on the same tab from the SAME two dictionary keys
 * (`sponsors.tierLabel`, `sponsors.scopeLabel`), so an unscoped label locator
 * is ambiguous by construction. Everything else is reached by role, or by copy
 * read from the dictionary through `ui()` — the copy is what is under test, not
 * a way of finding things.
 */
test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const ENABLED = process.env.CONNECT_WALKTHROUGH === "1";
const CONNECT_ACCOUNT = process.env.STRIPE_CONNECT_TEST_ACCOUNT ?? "";
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

/** Every missing precondition at once, so a run reports all of them rather
 *  than one per attempt. Null means "nothing missing". */
const SKIP_REASON: string | null = (() => {
  const missing = [
    ENABLED ? null : "CONNECT_WALKTHROUGH=1",
    CONNECT_ACCOUNT ? null : "STRIPE_CONNECT_TEST_ACCOUNT (a fabricated account id is rejected by Stripe)",
    /^(sk|rk)_test_/.test(STRIPE_KEY)
      ? null
      : "STRIPE_SECRET_KEY (a test-mode sk_/rk_ key — leg 3 charges and leg 4 refunds for real)",
    WEBHOOK_SECRET
      ? null
      : "STRIPE_WEBHOOK_SECRET (the SAME value the server under test booted with — leg 3 signs the activation event)",
  ].filter((m): m is string => m !== null);
  return missing.length === 0 ? null : `opt-in: missing ${missing.join(", ")}`;
})();

// A skip is only honest if someone SEES it. Playwright's summary prints
// "4 skipped" with no reason attached, and a leg that silently skips its only
// real-Stripe proof is indistinguishable from one that ran it. Say so on
// stdout, at collection time, where the job log keeps it — the same reporting
// `registration-connect.spec.ts:42-52` does, and per-file rather than in
// global-setup (checked: `e2e/global-setup.ts` knows nothing about
// CONNECT_WALKTHROUGH, so nothing else would say it).
if (SKIP_REASON) {
  console.warn(
    `\n  ⚠ settings-sponsor-monetize walkthrough SKIPPED — the sponsor money path was NOT exercised.` +
      `\n    ${SKIP_REASON}` +
      `\n    Nothing else in the suite sells, invoices or refunds a sponsor package.\n`,
  );
}

// ---------------------------------------------------------------------------
// Copy, budgets, small helpers
// ---------------------------------------------------------------------------

/** Copy read from the dictionary the page renders from, never retyped — this
 *  folder's idiom (settings-billing-panels.spec.ts:100, settings-org-tabs.spec.ts:59). */
const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);

/** `msg()`'s `{name}` interpolation. Throws on a missing key: a renamed key
 *  must red loudly here rather than resolve to a locator that matches nothing
 *  and times out somewhere unrelated. */
function ui(key: string, vars: Record<string, string | number> = {}): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en dictionary key: ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`));
}

/**
 * The same string as a whole-name RegExp with named placeholders left open.
 *
 * The refund dialog's confirm label is "Refund {amount}", and `{amount}` is
 * `Intl.NumberFormat` output from the BROWSER's locale — retyping "£2.50" here
 * would pin the runner's locale into the locator and rot on a currency change.
 * This keeps the sentence under test and lets the money through.
 */
function uiPattern(key: string, wildcards: Record<string, string>): RegExp {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en dictionary key: ${key}`);
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filled = escaped.replace(/\\\{(\w+)\\\}/g, (m, k: string) => wildcards[k] ?? m);
  return new RegExp(`^${filled}$`);
}

/** Budgets expressed in what each leg does, never a flat literal beside a
 *  derived cost (AGENTS.md failure class 20). A `stripe` unit is one real
 *  round trip to Stripe — through our server, or from the runner. */
const NAV_MS = 20_000;
const STRIPE_MS = 30_000;
const budget = (navs: number, stripeCalls: number): number =>
  Math.max(90_000, 20_000 + navs * NAV_MS + stripeCalls * STRIPE_MS);

const READ_MS = 20_000;

/** "the control inside the wrapping label that says X" — see doc note 2. */
function fieldIn(scope: Locator, label: string): Locator {
  return scope.locator("label").filter({ hasText: label }).locator("input");
}
function selectIn(scope: Locator, label: string): Locator {
  return scope.locator("label").filter({ hasText: label }).locator("select");
}

// The run's own identifiers. `TAG` scopes them to this run so a stray row is
// attributable; the random suffix keeps two runs of the same tag from tripping
// `sendInvoice`'s duplicate-invoice confirm dialog on a shared org.
const RUN = randomBytes(3).toString("hex");
const PKG_NAME = `Gold Match Sponsor ${TAG}-${RUN}`;
const SPONSOR_NAME = `Riverside Sports Ltd ${RUN}`;
const SPONSOR_EMAIL = `sponsor-${TAG}-${RUN}@example.com`;
/** The test's own input and the cents it must arrive as. Small on purpose:
 *  legs 3 and 4 move this for real. */
const PRICE_MAJOR = "2.50";
const PRICE_CENTS = 250;

interface PackageRow {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  tier: string;
  active: boolean;
}
interface OrderRow {
  id: string;
  package_id: string;
  sponsor_name: string;
  sponsor_email: string;
  payment_intent_id: string | null;
  amount_cents: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded";
  sponsor_id: string | null;
}
interface SponsorRow {
  id: string;
  name: string;
  tier: string;
  status: "active" | "pending" | "inactive";
}

// ---------------------------------------------------------------------------
// The fixture account: claim, and give it back
// ---------------------------------------------------------------------------

/**
 * `organizations.stripe_account_id` is UNIQUE, so exactly one org can hold the
 * fixture account at a time. Take it for the duration and give it back — the
 * smoke sponsor suite crashes if it finds the account already claimed.
 *
 * IMPORTED from `rs007-money-kit.ts`, not copied. The first draft of this file
 * kept a file-local copy, reasoning that "the claim IS the mutual exclusion, so
 * two files must not share one implementation". That is exactly backwards: the
 * kit's `claimConnectAccount` takes `pg_advisory_lock(70070071)` on a dedicated
 * `max: 1` connection held open for the duration, so a second worker QUEUES
 * instead of seizing the account mid-run — and an exclusion only excludes if
 * every claimant waits on the SAME lock. A local copy opts out of it. This
 * matters concretely rather than in principle: the `walkthrough` project does
 * not set `fullyParallel: false` (that is the separate `serial` project,
 * playwright.config.ts:169-175 — this one inherits the file's
 * `fullyParallel: true`) and CI runs it with `--workers=3`, while four files
 * contend for this one account. THREE of the four now queue on the kit's lock
 * — the two rs007 specs and this one. `registration-connect.spec.ts` is the
 * holdout: it still carries its own file-local UNLOCKED copy (:60, :72, :91),
 * so it can still seize the account out from under any of the other three. A
 * follow-up, deliberately not fixed here. The symptom of losing that race is a
 * Stripe "missing destination" error hundreds of lines from its cause.
 *
 * Equally deliberately NOT `helpers.ts`'s `setOrgConnectSql`: that writes a
 * fabricated `acct_e2e_<id>` (helpers.ts:542) which Stripe rejects as a
 * transfer destination, so the Checkout Session in leg 2 would never mint.
 *
 * The restoration assertion below is fed by `releaseConnectAccount`'s RETURN
 * value, which the kit reads on the lock connection before unlocking. An
 * earlier version of this file re-read the row itself on a fresh `withDb`
 * connection AFTER the release resolved — outside the exclusion window, so a
 * worker queued on the lock could claim the account in the gap and the
 * assertion would report a hand-back failure against a fixture that was handed
 * back correctly. The read has to happen under the lock, and only the kit can
 * do it there.
 */

// ---------------------------------------------------------------------------
// Shared state (serial file — see the header)
// ---------------------------------------------------------------------------

let org: SeededOrg;
/** The kit's claim handle (`{ priorId, orgId }`), or null on a skipped run
 *  where the account was never taken. */
let claim: ConnectClaim | null = null;
/** Whatever held the fixture after `afterAll` handed it back, as reported by
 *  `releaseConnectAccount` from a read taken on the LOCK connection before the
 *  unlock — captured so the assertion can run AFTER every other cleanup step,
 *  never instead of one, without the value going stale in the meantime. */
let restoredHolder: string | null = null;
let restoreRan = false;

let packageId = "";
let packageTier = "";
let packageCurrency = "";
let orderId = "";
let paymentIntentId = "";
/** `billing_events` has no org FK and `releaseSeededOrgSql` only SOFT-deletes,
 *  so the activation event outlives the org unless it is named and dropped. */
const strayEventIds: string[] = [];

/** A Stripe client for the RUNNER's own calls (leg 3's charge, leg 4's
 *  verification). The SERVER has its own from `apps/web/.env.local`. */
function runnerStripe(): Stripe {
  return new Stripe(STRIPE_KEY);
}

test.use({
  // A wrong selector should fail in seconds, not ride the test timeout — the
  // first run of registration-connect.spec.ts sat 8 minutes on a button that
  // never existed. The real Stripe waits get their own explicit, longer ones.
  actionTimeout: 15_000,
  viewport: { width: 1280, height: 900 },
});

test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  test.skip(SKIP_REASON !== null, SKIP_REASON ?? "");
  org = await seedSettingsOrg(request, { plan: "pro", label: "W4-sponsor-monetize" });
  // See doc note 3: redundant against today's catalog, kept against tomorrow's.
  await setBoolEntitlementOverrideSql(org.orgId, "sponsors.monetize", true);
  // Blocks until any other worker holding the fixture gives it back.
  claim = await claimConnectAccount(org.orgId);
  console.log(
    `CONNECT>>> ${CONNECT_ACCOUNT} taken from ${claim.priorId ?? "nobody"} for ${org.slug}`,
  );
});

test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  // ORDER IS LOAD-BEARING, and it is the fix W4 Task 1's reviewer forced: the
  // fixture must be detached BEFORE the org is released, or a soft-deleted org
  // keeps the account forever. Every step is independently guarded so one
  // failure cannot strand the next.
  //
  // UNCONDITIONAL, per the kit's contract: a `claimConnectAccount` that threw
  // after taking the lock but before its UPDATEs landed still holds the lock,
  // and only an unguarded call releases it. The returned holder is read on the
  // lock connection before the unlock, so no worker queued behind us can make
  // it stale between the hand-back and the assertion.
  restoredHolder = await releaseConnectAccount(claim);
  if (claim) restoreRan = true;
  for (const id of strayEventIds) {
    await withDb((sql) => sql`delete from billing_events where id = ${id}`).catch(() => {});
  }
  if (org) await releaseSettingsOrg(request, org).catch(() => {});

  // Asserted LAST, so a broken restoration is reported without having skipped
  // the rest of the teardown. This is the single most consequential assertion
  // in the file: the fixture account is shared with `registration-connect`,
  // the rs007 specs and `scripts/smoke.ts`, and a run that keeps it silently
  // breaks all of them rather than this one.
  if (restoreRan) {
    expect(
      restoredHolder,
      `the Connect fixture ${CONNECT_ACCOUNT} was NOT handed back to its prior holder — ` +
        `every other Connect spec in this repo is now broken until this is repaired by hand`,
    ).toBe(claim?.priorId ?? null);
  }
});

// ---------------------------------------------------------------------------
// Leg 1 — SELL
// ---------------------------------------------------------------------------

test("sell: the sponsors tab creates a priced package, at the values its own controls open at", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(1, 0));
  await page.goto(settingsUrl(org.slug, "sponsors"));

  const panel = page.getByTestId("sponsor-packages");
  await expect(
    panel,
    "a Pro org with sponsors.monetize must get the sell console, not the upsell paragraph",
  ).toBeVisible({ timeout: READ_MS });
  await expect(
    panel.getByText(ui("sponsors.sell.empty")),
    "a fresh org must open on the no-packages empty state",
  ).toBeVisible();

  const nameInput = fieldIn(panel, ui("sponsors.pkg.name"));
  const priceInput = fieldIn(panel, ui("sponsors.pkg.price"));
  const currency = selectIn(panel, ui("sponsors.pkg.currency"));
  const tier = selectIn(panel, ui("sponsors.tierLabel"));
  const create = panel.getByRole("button", { name: ui("sponsors.pkg.create"), exact: true });

  // What the controls OPEN AT, read off the live DOM — never a table typed in
  // here (AGENTS.md class 19). These two values are then the EXPECTATION the
  // created row is judged against, so a default that silently moves is caught
  // as a transmission failure rather than sailing past a hardcoded "gbp".
  packageCurrency = await currency.inputValue();
  packageTier = await tier.inputValue();
  expect(packageCurrency, "the currency picker must open at a 3-letter ISO code").toMatch(/^[a-z]{3}$/);
  expect(packageTier, "the tier picker must open at a real tier, not a blank").not.toBe("");

  await expect(create, "Create package must be refused on an empty draft").toBeDisabled();
  await nameInput.fill(PKG_NAME);
  await priceInput.fill(PRICE_MAJOR);
  await expect(create, "a named, priced draft must be sellable").toBeEnabled();

  const [created] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsor-packages`) &&
        r.request().method() === "POST",
      { timeout: READ_MS },
    ),
    create.click(),
  ]);
  expect(created.status(), "POST /sponsor-packages").toBe(201);

  // Read back through the API, not the console's own echo of what it just
  // sent — the writer confirming its own write proves nothing.
  const pkgs = await apiJson<PackageRow[]>(
    request,
    `/api/v1/orgs/${org.orgId}/sponsor-packages`,
  );
  expect(pkgs.status, "GET /sponsor-packages").toBe(200);
  const row = pkgs.data?.find((p) => p.name === PKG_NAME);
  expect(row, `no package named ${PKG_NAME} came back from the API`).toBeDefined();
  expect(row!.price_cents, "the typed major-unit price must arrive as cents").toBe(PRICE_CENTS);
  expect(row!.currency, "the currency the picker opened at must be the one that was sold").toBe(
    packageCurrency,
  );
  expect(row!.tier, "the tier the picker opened at must be the one that was sold").toBe(packageTier);
  expect(row!.active, "a new package must be on sale").toBe(true);
  packageId = row!.id;

  // And the console shows it: the empty state is gone and the row is listed.
  await expect(panel.getByText(PKG_NAME)).toBeVisible();
  await expect(panel.getByText(ui("sponsors.sell.empty"))).toHaveCount(0);
  // The draft is cleared for the next sale rather than left primed to re-send.
  await expect(nameInput, "the draft must reset after a sale").toHaveValue("");
});

// ---------------------------------------------------------------------------
// Leg 2 — INVOICE
// ---------------------------------------------------------------------------

test("invoice: Send invoice mints a REAL Stripe Checkout Session on the connected account", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(1, 1));
  expect(packageId, "leg 1 must have sold a package").not.toBe("");
  await page.goto(settingsUrl(org.slug, "sponsors"));

  const panel = page.getByTestId("sponsor-packages");
  await expect(panel).toBeVisible({ timeout: READ_MS });
  await expect(
    panel.getByText(ui("sponsors.orders.empty")),
    "no orders exist yet",
  ).toBeVisible();

  // The invoice form is FOLDED until the package's own Send invoice is pressed
  // — `invoiceFor === pkg.id` gates it, so the fields do not exist before then.
  const sponsorNameField = fieldIn(panel, ui("sponsors.order.name"));
  await expect(sponsorNameField, "the invoice form must be folded until asked for").toHaveCount(0);

  await panel.getByRole("button", { name: ui("sponsors.pkg.invoice"), exact: true }).click();
  await expect(sponsorNameField).toBeVisible();

  const send = panel.getByRole("button", { name: ui("sponsors.order.send"), exact: true });
  await expect(send, "an unaddressed invoice must not be sendable").toBeDisabled();
  await sponsorNameField.fill(SPONSOR_NAME);
  await fieldIn(panel, ui("sponsors.order.email")).fill(SPONSOR_EMAIL);
  await expect(send).toBeEnabled();

  const [sent] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsor-orders`) &&
        r.request().method() === "POST",
      { timeout: STRIPE_MS },
    ),
    send.click(),
  ]);
  // A 409 here is the Connect gate refusing an unconnected org
  // (`startSponsorCheckout`'s own "Connect Stripe (Get paid) before selling"),
  // i.e. the claim in `beforeAll` did not take. Say which it was.
  expect(sent.status(), `POST /sponsor-orders answered ${sent.status()}: ${await sent.text()}`).toBe(
    201,
  );

  // The link Stripe returned is the proof the rail is real: a fabricated
  // `acct_e2e_*` destination is rejected outright, so a hosted-checkout URL
  // cannot exist unless the connected account does.
  const body = (await sent.json()) as { data?: { checkout_url?: string } };
  expect(
    body.data?.checkout_url ?? "",
    "Stripe must have returned a hosted checkout URL for the destination charge",
  ).toMatch(/^https:\/\/checkout\.stripe\.com\//);

  // And the console SHOWS it — the banner and the copyable link, not just a
  // 201 nobody surfaced.
  await expect(panel.getByText(ui("sponsors.order.sent"))).toBeVisible();
  await expect(panel.getByRole("button", { name: ui("sponsors.order.copyLink") })).toBeVisible();
  const shown = (await panel.locator("code").first().textContent()) ?? "";
  expect(shown, "the banner must show the link Stripe actually returned").toBe(
    body.data!.checkout_url,
  );

  const orders = await apiJson<OrderRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsor-orders`);
  expect(orders.status, "GET /sponsor-orders").toBe(200);
  const order = orders.data?.find((o) => o.sponsor_email === SPONSOR_EMAIL);
  expect(order, `no order for ${SPONSOR_EMAIL} came back from the API`).toBeDefined();
  expect(order!.package_id, "the order must hang off the package that was invoiced").toBe(packageId);
  expect(order!.sponsor_name).toBe(SPONSOR_NAME);
  expect(order!.amount_cents, "the order must be priced from the package, not from the form").toBe(
    PRICE_CENTS,
  );
  expect(order!.currency).toBe(packageCurrency);
  expect(order!.status, "an unpaid invoice is pending").toBe("pending");
  expect(order!.sponsor_id, "no placement exists until the money lands").toBeNull();
  orderId = order!.id;

  // The negative half of leg 3's positive: a pending order offers no refund.
  // Asserted here so the pair is a real differential rather than a lone
  // "the button exists" reachability check.
  await expect(panel.getByText(ui("sponsors.order.status.pending"))).toBeVisible();
  await expect(
    panel.getByRole("button", { name: ui("sponsors.order.refund"), exact: true }),
    "a pending order must NOT offer a refund",
  ).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Leg 3 — PAID
// ---------------------------------------------------------------------------

test("paid: a real destination charge, delivered as a signed event, activates the placement", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(1, 4));
  expect(orderId, "leg 2 must have sent an invoice").not.toBe("");
  const stripe = runnerStripe();

  // A real destination charge in the shape `startSponsorCheckout` builds:
  // amount to the connected account, platform application fee, confirmed
  // headlessly with the `pm_card_visa` test token. The metadata is exactly what
  // the app stamps on `payment_intent_data.metadata`, because that is what
  // `handleSponsorPaymentSucceeded` reads to find the order.
  //
  // See doc note 1 for why this is an INDEPENDENT PaymentIntent rather than
  // the Session leg 2 minted: a Session's `payment_intent` stays null until a
  // browser visits the hosted page, and no forwarder can reach localhost.
  const intent = await stripe.paymentIntents.create({
    amount: PRICE_CENTS,
    currency: packageCurrency,
    // Any positive fee proves the destination/fee pairing; nothing downstream
    // asserts it matches the org's live fee_percent, which is a separate
    // concern (`scripts/smoke.ts:9151`'s payRealDestinationCharge says the
    // same about the analogous registration charge).
    application_fee_amount: Math.max(1, Math.round(PRICE_CENTS * 0.02)),
    transfer_data: { destination: CONNECT_ACCOUNT },
    metadata: { kind: "sponsor", order_id: orderId, package_id: packageId, org_id: org.orgId },
    payment_method: "pm_card_visa",
    confirm: true,
    return_url: "https://walkthrough.example.com/return",
  });
  expect(intent.status, `payment_intent ${intent.id}`).toBe("succeeded");
  paymentIntentId = intent.id;

  // Stripe creates the Transfer and ApplicationFee objects ASYNCHRONOUSLY,
  // seconds after the intent already reads "succeeded". Leg 4's refund asks
  // for `reverse_transfer` + `refund_application_fee`, which fails against
  // objects that do not exist yet — so wait for them here rather than racing
  // them there (the same 15s poll smoke.ts:9186 uses, and for the same reason).
  const chargeId =
    typeof intent.latest_charge === "string" ? intent.latest_charge : (intent.latest_charge?.id ?? "");
  expect(chargeId, `payment_intent ${intent.id} succeeded with no latest_charge`).not.toBe("");
  await expect
    .poll(
      async () => {
        const charge = await stripe.charges.retrieve(chargeId);
        const transfer = typeof charge.transfer === "string" ? charge.transfer : charge.transfer?.id;
        const fee =
          typeof charge.application_fee === "string"
            ? charge.application_fee
            : charge.application_fee?.id;
        return Boolean(transfer && fee);
      },
      {
        message: `charge ${chargeId} never grew a transfer + application_fee`,
        timeout: STRIPE_MS,
        intervals: [750],
      },
    )
    .toBe(true);

  // Hand it to our OWN webhook route, correctly signed — the production
  // fulfilment path, not a SQL flip that would assert this spec's own seed.
  // Mirrors `postSignedStripeWebhook` in e2e/event-pass.spec.ts:432.
  const eventId = `evt_w4_sponsor_${RUN}_${randomBytes(4).toString("hex")}`;
  strayEventIds.push(eventId);
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: "payment_intent.succeeded",
    data: { object: intent },
  });
  const delivered = await page.request.post("/api/webhooks/stripe", {
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripe.webhooks.generateTestHeaderString({
        payload,
        secret: WEBHOOK_SECRET,
      }),
    },
    data: payload,
  });
  // 400 here is a signature the server would not accept — i.e. the runner and
  // the server booted with different STRIPE_WEBHOOK_SECRETs.
  expect(
    delivered.status(),
    `POST /api/webhooks/stripe answered ${delivered.status()}: ${await delivered.text()}`,
  ).toBe(200);

  const orders = await apiJson<OrderRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsor-orders`);
  const order = orders.data?.find((o) => o.id === orderId);
  expect(order, "the order must still be readable").toBeDefined();
  expect(order!.status, "the activation event must mark the order paid").toBe("paid");
  expect(order!.payment_intent_id, "the order must record the intent that paid it").toBe(intent.id);
  expect(order!.sponsor_id, "a paid order must have minted its placement").not.toBeNull();

  // The placement itself, on the public-facing sponsor list — and carrying the
  // PACKAGE's tier, which is the only thing that copies it there.
  const sponsors = await apiJson<SponsorRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
  expect(sponsors.status, "GET /sponsors").toBe(200);
  const placement = sponsors.data?.find((s) => s.id === order!.sponsor_id);
  expect(placement, "the order's sponsor_id must resolve to a real placement").toBeDefined();
  expect(placement!.name, "the placement is named for the sponsor who paid").toBe(SPONSOR_NAME);
  expect(placement!.tier, "the placement must inherit the package's tier").toBe(packageTier);
  expect(placement!.status, "a paid placement goes live").toBe("active");

  // The console agrees, and NOW offers the refund it refused in leg 2.
  await page.goto(settingsUrl(org.slug, "sponsors"));
  const panel = page.getByTestId("sponsor-packages");
  await expect(panel).toBeVisible({ timeout: READ_MS });
  await expect(panel.getByText(ui("sponsors.order.status.paid"))).toBeVisible();
  await expect(
    panel.getByRole("button", { name: ui("sponsors.order.refund"), exact: true }),
    "a paid order must offer a refund",
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// Leg 4 — REFUND
// ---------------------------------------------------------------------------

test("refund: the console reverses the charge, and the placement comes off the public pages", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(2, 3));
  expect(paymentIntentId, "leg 3 must have paid the order").not.toBe("");
  await page.goto(settingsUrl(org.slug, "sponsors"));

  const panel = page.getByTestId("sponsor-packages");
  await expect(panel).toBeVisible({ timeout: READ_MS });
  await panel.getByRole("button", { name: ui("sponsors.order.refund"), exact: true }).click();

  // The confirm step is not decoration: `refundOrder` returns without calling
  // Stripe if it is dismissed, so the dialog is on the money path.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(ui("sponsors.order.refundConfirm.title"))).toBeVisible();
  const confirm = dialog.getByRole("button", {
    // "Refund {amount}" — the amount is browser-locale currency formatting, so
    // the sentence is pinned and the money is left open (see `uiPattern`).
    name: uiPattern("sponsors.order.refundConfirm.label", { amount: ".+" }),
  });
  await expect(confirm).toBeVisible();

  const [refunded] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsor-orders/${orderId}/refund`) &&
        r.request().method() === "POST",
      { timeout: STRIPE_MS },
    ),
    confirm.click(),
  ]);
  expect(
    refunded.status(),
    `POST /sponsor-orders/{id}/refund answered ${refunded.status()}: ${await refunded.text()}`,
  ).toBe(200);

  const orders = await apiJson<OrderRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsor-orders`);
  const order = orders.data?.find((o) => o.id === orderId);
  expect(order!.status, "the refunded order must read back refunded").toBe("refunded");

  // The placement comes DOWN — the half of the refund a Stripe-only assertion
  // cannot see, and the reason `refundSponsorOrder` reuses the charge.refunded
  // path rather than only flipping a status.
  const sponsors = await apiJson<SponsorRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
  const placement = sponsors.data?.find((s) => s.id === order!.sponsor_id);
  expect(placement, "the placement row survives as the audit trail").toBeDefined();
  expect(placement!.status, "a refunded placement must leave the public pages").toBe("inactive");

  // And the money actually moved back, read from STRIPE rather than from our
  // own row — a local status flip with a failed `refunds.create` behind it is
  // exactly the shape a DB-only assertion cannot tell from a real refund.
  const stripe = runnerStripe();
  const refundList = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 10 });
  expect(refundList.data.length, `Stripe recorded no refund against ${paymentIntentId}`).toBe(1);
  expect(refundList.data[0]!.amount, "the refund must return the whole order").toBe(PRICE_CENTS);
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const chargeId =
    typeof intent.latest_charge === "string" ? intent.latest_charge : (intent.latest_charge?.id ?? "");
  const charge = await stripe.charges.retrieve(chargeId);
  expect(charge.refunded, "Stripe's own charge must read as refunded").toBe(true);
  expect(charge.amount_refunded, "the whole charge must be refunded").toBe(PRICE_CENTS);

  // The console settles on it: the refund control is spent, the badge moves.
  await page.goto(settingsUrl(org.slug, "sponsors"));
  const settled = page.getByTestId("sponsor-packages");
  await expect(settled).toBeVisible({ timeout: READ_MS });
  await expect(settled.getByText(ui("sponsors.order.status.refunded"))).toBeVisible();
  await expect(
    settled.getByRole("button", { name: ui("sponsors.order.refund"), exact: true }),
    "a refunded order must not offer a second refund",
  ).toHaveCount(0);
});
