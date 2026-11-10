import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TAG, apiJson, setBoolEntitlementOverrideSql } from "../helpers";
import {
  seedCompetition,
  seedSettingsOrg,
  releaseSettingsOrg,
  sponsorsUrl,
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
 * where leg N+1 has nothing to assert without leg N's Stripe object. Leg 5
 * (batch F fix round 1) sells leg 1's package again, to a second sponsor who
 * never pays, and ends that deal from its order. Same
 * reason `registration-connect.spec.ts` and the rs007 specs are each their own
 * self-contained serial file rather than sharing a project-wide serial mode.
 *
 * ── FIVE THINGS THE BRIEF FOR THIS FILE GOT WRONG ────────────────────────────
 * Each re-checked against the tree rather than assumed (AGENTS.md class 5).
 *
 *  1. **The refund the brief asks for cannot follow the invoice it asks for.**
 *     `sponsor-packages.tsx` renders the Refund control only for a deal that
 *     `allowedActions` offers a refund on (paid, undisputed, not already
 *     refunded), and a just-sent invoice is `pending` — `createDeal` inserts the
 *     deal, mints a Checkout Session and emails a link. Nothing moves it to
 *     `paid` except
 *     `payment_intent.succeeded` carrying `metadata.kind === "sponsor"`
 *     (`usecases/billing-events/` -> `handleSponsorPaymentSucceeded`). The
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
 *     matches nothing until the deal POST resolves. Nor is anything reachable
 *     by `getByLabel(/name/i)`: every field on this panel sits inside a
 *     WRAPPING `<label>` that also holds the control, so Playwright resolves it
 *     by text CONTENT — which folds in a `<select>`'s option labels. Package
 *     fields are located as "the control inside the label that says X", the
 *     same idiom `settings-org-tabs.spec.ts:70-84` established on this very
 *     page; the invoice form's own controls carry test ids (`invoice-sponsor`,
 *     `invoice-email`, `invoice-send`), since sponsor deals T12 turned its typed
 *     "Sponsor name" into a picker of the org's sponsors.
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
 *  5. The console lives on the Sponsors hub's "Packages and orders" tab:
 *     `sponsorsUrl(slug, "packages")`. It WAS `settingsUrl(slug, "sponsors")` - the one place in W4 where a
 *     Settings `?tab=` was right, `sponsors` being a real `SettingsTab` unlike `connect`/`credits`/`add-ons`/
 *     `billing` (`SettingsNavKey`s with their own routes, which silently fell back to the organisation panel
 *     for Tasks 1-3). R4 sponsors-on-stream S11 moved the tab out of Settings: `?tab=sponsors` there now
 *     redirects to the hub's Sponsors tab (OrgSponsors only), and `SponsorPackages` is its own tab, so this
 *     spec goes to `packages` directly rather than through a redirect that would land on the wrong body.
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
  return new RegExp(`^${uiSource(key, wildcards)}$`);
}

/** `uiPattern`'s body: the escaped sentence with its named placeholders open. */
function uiSource(key: string, wildcards: Record<string, string>): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en dictionary key: ${key}`);
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(/\\\{(\w+)\\\}/g, (m, k: string) => wildcards[k] ?? m);
}

/** A confirm body the console builds from several sentences joined by one space (the refund's money, placement and
 *  can't-be-undone sentences), as ONE whole-text RegExp: each part pinned, in order, nothing else. */
function uiSentences(parts: [string, Record<string, string>][]): RegExp {
  return new RegExp(`^${parts.map(([key, wildcards]) => uiSource(key, wildcards)).join(" ")}$`);
}

/** Budgets expressed in what each leg does, never a flat literal beside a
 *  derived cost (AGENTS.md failure class 20). A `stripe` unit is one real
 *  round trip to Stripe — through our server, or from the runner. */
const NAV_MS = 20_000;
const STRIPE_MS = 30_000;
const budget = (navs: number, stripeCalls: number): number =>
  Math.max(90_000, 20_000 + navs * NAV_MS + stripeCalls * STRIPE_MS);

/**
 * The `beforeAll` hook's own budget, and it needs one: a Playwright hook
 * carries its OWN timeout, defaulting to the global `testConfig.timeout`
 * (60_000 — playwright.config.ts, which the `walkthrough` project does not
 * override), and only an explicit `test.setTimeout` INSIDE the hook raises it.
 * `claimConnectAccount` blocks on `pg_advisory_lock(70070071)` with no bound on
 * the wait, and every other holder of that lock takes it from a test body that
 * has already budgeted itself 600_000 (rs007-invite-pay-cancel.spec.ts and
 * all five cases in rs007-money-matrix.spec.ts). So the incumbent may
 * legitimately hold it for ten minutes while this hook is given one — a flaky
 * hook timeout under CI's `--workers=3`, not a deterministic one.
 */
const CONNECT_LOCK_WAIT_MS = 600_000;
/** The hook's own work on top of that wait: the org seed, the entitlement
 *  override, and the claim's own UPDATEs once the lock is won. */
const SETUP_WORK_MS = 90_000;
const SETUP_MS = CONNECT_LOCK_WAIT_MS + SETUP_WORK_MS;

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
const SPONSOR_EMAIL = `delivered+sponsor-${TAG}-${RUN}@resend.dev`;
/** Leg 5's sponsor: invoiced, never paid, ended from its order. */
const SECOND_NAME = `Quay Chandlers ${RUN}`;
const SECOND_EMAIL = `delivered+sponsor2-${TAG}-${RUN}@resend.dev`;
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
/** A sponsor deal as `GET /sponsor-deals` answers it (sponsor deals Task 7, F8: the order IS the deal; `/sponsor-orders` is
 *  retired). Task 12 moved this spec's UI path onto the deal API too: the picker, the pay link, Refund. */
interface OrderRow {
  id: string;
  package_id: string;
  sponsor_name: string;
  sponsor_email: string | null;
  amount_cents: number;
  currency: string;
  payment_status: "pending" | "paid" | "failed" | "refunded" | "none";
  deal_status: string;
  ended_reason: string | null;
  paid_at: string | null;
  sponsor_id: string | null;
}
interface SponsorRow {
  id: string;
  name: string;
  tier: string;
  status: "active" | "pending" | "inactive";
  competition_id: string | null;
  on_stream: boolean;
}

/** The sponsor's three emails go through the email outbox (phase 3, wave 2).
 *  Every row of one kind about one thing, read straight from the table: the
 *  console shows none of them. */
async function outboxRows(
  kind: string,
  refType: string,
  refId: string,
): Promise<{ status: string; has_body: boolean }[]> {
  return withDb(async (sql) => [
    ...(await sql<{ status: string; has_body: boolean }[]>`
      select status, body_sealed is not null as has_body
        from email_outbox
       where kind = ${kind} and ref_type = ${refType} and ref_id = ${refId}
       order by created_at`),
  ]);
}

/** An outbox row is WAITING while it has no attempt behind it yet. */
const isWaiting = (status: string): boolean => status === "queued" || status === "sending";

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
/** The sponsor leg 2 creates BEFORE it can send an invoice (sponsor deals T12: an invoice goes to a sponsor). */
let sponsorId = "";
/** The tier that sponsor started on — not the package's, so leg 3 can see the deal move it. */
let sponsorTierBefore = "";
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
  // FIRST STATEMENT, before the skip and before any await: see SETUP_MS. The
  // hook's default 60s cannot outlast a lock holder that budgets itself 600s.
  test.setTimeout(SETUP_MS);
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

test("sell: the Sponsors hub's Packages and orders tab creates a priced package, at the values its own controls open at", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(1, 0));
  await page.goto(sponsorsUrl(org.slug, "packages"));

  const panel = page.getByTestId("sponsor-packages");
  // `sponsor-packages` wraps BOTH views since the final fix (a plan without the feature keeps its deals' exits there), so the
  // sell console is told apart by its own package form, and the upsell by its own paragraph - each the other's pair.
  await expect(
    panel.getByTestId("sponsor-pkg-create"),
    "a Pro org with sponsors.monetize must get the sell console's package form",
  ).toBeVisible({ timeout: READ_MS });
  await expect(panel.getByTestId("sponsor-sell-upsell"), "...and not the upsell paragraph").toHaveCount(0);
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

test("invoice: Send invoice picks a sponsor and mints a REAL Stripe Checkout Session on the connected account", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  // Three nav-sized waits: the page, the reload once the sponsor exists, and the outbox poll (READ_MS) below.
  test.setTimeout(budget(3, 1));
  expect(packageId, "leg 1 must have sold a package").not.toBe("");
  await page.goto(sponsorsUrl(org.slug, "packages"));

  const panel = page.getByTestId("sponsor-packages");
  await expect(panel).toBeVisible({ timeout: READ_MS });
  await expect(
    panel.getByText(ui("sponsors.orders.empty")),
    "no orders exist yet",
  ).toBeVisible();

  // The invoice form is FOLDED until the package's own Send invoice is pressed
  // — `invoiceFor === pkg.id` gates it, so the controls do not exist before then.
  const picker = panel.getByTestId("invoice-sponsor");
  await expect(picker, "the invoice form must be folded until asked for").toHaveCount(0);

  await panel.getByTestId(`invoice-open-${packageId}`).click();

  // THE EMPTY CASE, in a real browser (sponsor deals T12): a fresh org has no sponsor, and an invoice goes to a sponsor — so the
  // form says where to start and offers neither a picker nor a Send button.
  const noSponsors = panel.getByTestId("invoice-no-sponsors");
  await expect(noSponsors, "an org with no sponsor is told to add one first").toBeVisible();
  await expect(noSponsors).toHaveText(ui("sponsors.order.noSponsors"));
  await expect(noSponsors, "and the words are a link to the Sponsors tab").toHaveAttribute(
    "href",
    new RegExp(`/o/${org.slug}/sponsors\\?tab=sponsors$`),
  );
  await expect(panel.getByTestId("invoice-send"), "no sponsor, no Send").toHaveCount(0);
  await expect(picker).toHaveCount(0);

  // Add the sponsor (over the API: the Sponsors tab's own add form is other specs' subject). A tier that is NOT the package's, so
  // leg 3 can tell a placement that took the deal's tier from one that kept its own.
  const sponsorTier = packageTier === "partner" ? "silver" : "partner";
  const added = await apiJson<SponsorRow>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", {
    name: SPONSOR_NAME,
    tier: sponsorTier,
  });
  expect(added.status, `POST /sponsors answered ${added.status}: ${JSON.stringify(added.error)}`).toBe(201);
  sponsorId = added.data!.id;
  sponsorTierBefore = added.data!.tier;
  expect(sponsorTierBefore, "premise: the sponsor starts on a tier other than the package's").not.toBe(packageTier);

  // The picker's sponsors arrive with the page, so the page is read again.
  await page.reload();
  await expect(panel).toBeVisible({ timeout: READ_MS });
  await panel.getByTestId(`invoice-open-${packageId}`).click();
  await expect(picker, "with a sponsor the form offers the picker").toBeVisible();
  await expect(panel.getByTestId("invoice-no-sponsors")).toHaveCount(0);
  await expect(picker, "the picker opens at the first sponsor by display_order — the only one here").toHaveValue(
    sponsorId,
  );
  await picker.selectOption(sponsorId);
  // The form tells the club what an unpaid invoice does to the sponsor: off the public pages until it is paid.
  await expect(panel.getByTestId("invoice-hidden-note"), "a sponsor with no live deal is told the invoice hides it").toHaveText(
    ui("sponsors.order.hiddenUntilPaid"),
  );

  const send = panel.getByTestId("invoice-send");
  await expect(send, "an unaddressed invoice must not be sendable").toBeDisabled();
  await panel.getByTestId("invoice-email").fill(SPONSOR_EMAIL);
  await expect(send).toBeEnabled();

  const [sent] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsors/${sponsorId}/deals`) &&
        r.request().method() === "POST",
      { timeout: STRIPE_MS },
    ),
    send.click(),
  ]);
  // A 409 here is the Connect gate refusing an unconnected org
  // (`createDeal`'s own `connect_required`), i.e. the claim in `beforeAll`
  // did not take. Say which it was.
  expect(
    sent.status(),
    `POST /sponsors/{id}/deals answered ${sent.status()}: ${await sent.text()}`,
  ).toBe(201);

  // The link Stripe returned is the proof the rail is real: a fabricated
  // `acct_e2e_*` destination is rejected outright, so a hosted-checkout URL
  // cannot exist unless the connected account does. It rides in the create's
  // answer, beside the deal (F11) — the deal itself carries no url.
  const body = (await sent.json()) as { data?: { checkout_url?: string | null; deal?: { id?: string } } };
  expect(
    body.data?.checkout_url ?? "",
    "Stripe must have returned a hosted checkout URL for the destination charge",
  ).toMatch(/^https:\/\/checkout\.stripe\.com\//);

  // And the console SHOWS it — the banner and the copyable link, not just a
  // 201 nobody surfaced.
  await expect(panel.getByText(ui("sponsors.order.sent"))).toBeVisible();
  await expect(panel.getByRole("button", { name: ui("sponsors.order.copyLink") })).toBeVisible();
  const shown = (await panel.getByTestId("invoice-link").textContent()) ?? "";
  expect(shown.trim(), "the banner must show the link Stripe actually returned").toBe(
    body.data!.checkout_url,
  );

  const orders = await apiJson<OrderRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsor-deals`);
  expect(orders.status, "GET /sponsor-deals").toBe(200);
  const order = orders.data?.find((o) => o.sponsor_email === SPONSOR_EMAIL);
  expect(order, `no order for ${SPONSOR_EMAIL} came back from the API`).toBeDefined();
  expect(order!.id, "the deal the console read back is the one the create answered").toBe(body.data!.deal!.id);
  expect(order!.package_id, "the order must hang off the package that was invoiced").toBe(packageId);
  expect(order!.sponsor_id, "the deal is the PICKED sponsor's, not a new one").toBe(sponsorId);
  expect(order!.sponsor_name, "the deal names the sponsor it was picked for").toBe(SPONSOR_NAME);
  expect(order!.amount_cents, "the order must be priced from the package, not from the form").toBe(
    PRICE_CENTS,
  );
  expect(order!.currency).toBe(packageCurrency);
  expect(order!.payment_status, "an unpaid invoice is pending").toBe("pending");
  expect(order!.deal_status, "a sent online deal awaits its payment").toBe("awaiting_payment");
  orderId = order!.id;

  // The deal's effect on the sponsor it was picked for: a deal waiting for its payment HIDES the sponsor (applyDealsToSponsor
  // step 4 — `inactive`, tier untouched), so leg 3's "goes live, on the package's tier" is a change from something, not a
  // restatement of a default (the sponsor was created `active`).
  const waiting = await apiJson<SponsorRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
  expect(waiting.status, "GET /sponsors").toBe(200);
  const hidden = waiting.data?.filter((s) => s.name === SPONSOR_NAME) ?? [];
  expect(hidden.map((s) => s.id), "sending the invoice minted no second sponsor").toEqual([sponsorId]);
  expect(hidden[0]!.status, "an unpaid deal hides its sponsor until it is live").toBe("inactive");
  expect(hidden[0]!.tier, "and has not yet moved the sponsor's tier").toBe(sponsorTierBefore);

  // The invoice email went through the outbox: ONE row for the order, and the
  // request made its first attempt once the response was out, so it is no
  // longer waiting and keeps no body. CI's server has no Resend key, so there
  // it ends `dead` (`no_api_key`); a server with one has sent it. Polled,
  // because that attempt runs after the response.
  await expect
    .poll(
      async () =>
        (await outboxRows("sponsor_invoice", "sponsor_order", orderId)).map((r) => ({
          waiting: isWaiting(r.status),
          hasBody: r.has_body,
        })),
      {
        timeout: READ_MS,
        message: "one sponsor_invoice row for the order, its first attempt made, no body kept",
      },
    )
    .toEqual([{ waiting: false, hasBody: false }]);

  // The negative half of leg 3's positive: a pending order offers no refund.
  // Asserted here so the pair is a real differential rather than a lone
  // "the button exists" reachability check.
  await expect(panel.getByText(ui("sponsors.order.status.pending"))).toBeVisible();
  await expect(
    panel.getByRole("button", { name: ui("sponsors.order.refund"), exact: true }),
    "a pending order must NOT offer a refund",
  ).toHaveCount(0);

  // The duplicate-invoice confirm, in a real browser: the picked sponsor now has an OPEN deal on this package, so a second
  // invoice for it asks first — and declining mints nothing (no second Checkout Session, no second deal).
  await panel.getByTestId(`invoice-open-${packageId}`).click();
  await panel.getByTestId("invoice-email").fill(SPONSOR_EMAIL);
  await panel.getByTestId("invoice-send").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog, "a sponsor with an open deal on this package is asked before a second invoice").toBeVisible();
  await expect(dialog.getByText(ui("sponsors.order.dupConfirm.title"))).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const after = await apiJson<OrderRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsor-deals`);
  expect(
    after.data?.filter((o) => o.sponsor_id === sponsorId).length,
    "declining the confirm sent nothing: still the one deal",
  ).toBe(1);
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

  const orders = await apiJson<OrderRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsor-deals`);
  const order = orders.data?.find((o) => o.id === orderId);
  expect(order, "the order must still be readable").toBeDefined();
  expect(order!.payment_status, "the activation event must mark the order paid").toBe("paid");
  expect(order!.paid_at, "the activation event must stamp when it was paid").not.toBeNull();
  expect(order!.sponsor_id, "the paid deal is still the picked sponsor's — no placement was minted for it").toBe(
    sponsorId,
  );

  // The receipt is queued in the activation's own transaction, one per
  // payment however often it is delivered, and the worker makes its first
  // attempt: ONE row for the order, still waiting.
  expect(
    (await outboxRows("sponsor_receipt", "sponsor_order", orderId)).map((r) => r.status),
    "one sponsor_receipt row for the order, queued for the worker",
  ).toEqual(["queued"]);

  // The placement itself, on the public-facing sponsor list — and carrying the
  // PACKAGE's tier, which is the only thing that copies it there.
  const sponsors = await apiJson<SponsorRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
  expect(sponsors.status, "GET /sponsors").toBe(200);
  expect(
    sponsors.data?.filter((s) => s.name === SPONSOR_NAME).length,
    "the payment minted no second sponsor row: the picked sponsor is the only one of that name",
  ).toBe(1);
  const placement = sponsors.data?.find((s) => s.id === sponsorId);
  expect(placement, "the picked sponsor must still be readable").toBeDefined();
  expect(placement!.name, "the placement is named for the sponsor who paid").toBe(SPONSOR_NAME);
  expect(
    placement!.tier,
    `the live deal moves the sponsor from its own tier (${sponsorTierBefore}) onto the package's`,
  ).toBe(packageTier);
  expect(placement!.status, "a paid deal takes the sponsor from hidden to live").toBe("active");

  // The console agrees, and NOW offers the refund it refused in leg 2.
  await page.goto(sponsorsUrl(org.slug, "packages"));
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
  // Four nav-sized waits: three pages, and the outbox poll (READ_MS) below.
  test.setTimeout(budget(4, 3));
  expect(paymentIntentId, "leg 3 must have paid the order").not.toBe("");
  await page.goto(sponsorsUrl(org.slug, "packages"));

  const panel = page.getByTestId("sponsor-packages");
  await expect(panel).toBeVisible({ timeout: READ_MS });
  await panel.getByRole("button", { name: ui("sponsors.order.refund"), exact: true }).click();

  // The confirm step is not decoration: `refundOrder` returns without calling
  // Stripe if it is dismissed, so the dialog is on the money path.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(ui("sponsors.order.refundConfirm.title"))).toBeVisible();
  // Paid at Stripe Checkout (leg 3's real charge), never marked by hand: the card body, not the recorded-only one (review m1).
  // Then what the public pages do (batch G, m1 remainder): this deal is LIVE, so its placement hands over or comes off.
  await expect(
    dialog.getByText(
      uiSentences([
        ["sponsors.order.refundConfirm.body", { amount: ".+", name: SPONSOR_NAME }],
        ["sponsors.order.refundConfirm.placementLive", { name: SPONSOR_NAME }],
        ["sponsors.order.refundConfirm.irreversible", {}],
      ]),
    ),
  ).toBeVisible();
  const confirm = dialog.getByRole("button", {
    // "Refund {amount}" — the amount is browser-locale currency formatting, so
    // the sentence is pinned and the money is left open (see `uiPattern`).
    name: uiPattern("sponsors.order.refundConfirm.label", { amount: ".+" }),
  });
  await expect(confirm).toBeVisible();

  const [refunded] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsor-deals/${orderId}/refund`) &&
        r.request().method() === "POST",
      { timeout: STRIPE_MS },
    ),
    confirm.click(),
  ]);
  expect(
    refunded.status(),
    `POST /sponsor-deals/{id}/refund answered ${refunded.status()}: ${await refunded.text()}`,
  ).toBe(200);

  const orders = await apiJson<OrderRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsor-deals`);
  const order = orders.data?.find((o) => o.id === orderId);
  expect(order!.payment_status, "the refunded order must read back refunded").toBe("refunded");

  // The refund notice is queued in the refund's own transaction, and the
  // console request makes its first attempt once the response is out: ONE row
  // for the order (the later `charge.refunded` from Stripe flips nothing, so
  // it queues nothing), no longer waiting. Polled, as the invoice's is.
  await expect
    .poll(
      async () =>
        (await outboxRows("sponsor_refund", "sponsor_order", orderId)).map((r) => ({
          waiting: isWaiting(r.status),
        })),
      {
        timeout: READ_MS,
        message: "one sponsor_refund row for the order, its first attempt made",
      },
    )
    .toEqual([{ waiting: false }]);

  // The placement comes DOWN — the half of the refund a Stripe-only assertion
  // cannot see, and the reason `refundSponsorOrder` reuses the charge.refunded
  // path rather than only flipping a status.
  const sponsors = await apiJson<SponsorRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
  const placement = sponsors.data?.find((s) => s.id === order!.sponsor_id);
  expect(placement, "the placement row survives as the audit trail").toBeDefined();
  expect(placement!.id, "and it is still the sponsor the deal was picked for").toBe(sponsorId);
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
  await page.goto(sponsorsUrl(org.slug, "packages"));
  const settled = page.getByTestId("sponsor-packages");
  await expect(settled).toBeVisible({ timeout: READ_MS });
  await expect(settled.getByText(ui("sponsors.order.status.refunded"))).toBeVisible();
  await expect(
    settled.getByRole("button", { name: ui("sponsors.order.refund"), exact: true }),
    "a refunded order must not offer a second refund",
  ).toHaveCount(0);

  // The Sponsors tab agrees: a sponsor whose deal carries payment history (refunded money counts) cannot be deleted. The
  // console does not ask first — it sends the delete and the server's 409 is read back in the dictionary's words — and the
  // row stays, because the deal is the audit trail.
  await page.goto(sponsorsUrl(org.slug, "sponsors"));
  const remove = page.getByRole("button", { name: ui("settings.org.sponsors.remove", { name: SPONSOR_NAME }) });
  await expect(remove).toBeVisible({ timeout: READ_MS });
  const [refused] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsors/${sponsorId}`) && r.request().method() === "DELETE",
    ),
    remove.click(),
  ]);
  expect(refused.status(), "deleting a sponsor with a refunded deal is refused").toBe(409);
  await expect(page.getByText(ui("sponsors.error.hasDealHistory"))).toBeVisible();
  await expect(remove, "the refused sponsor is still listed").toBeVisible();
  const kept = await apiJson<SponsorRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
  expect(kept.data?.some((s) => s.id === sponsorId), "and still exists server-side").toBe(true);
});

// ---------------------------------------------------------------------------
// Leg 5 — END NOW (batch F fix round 1, review I2): the console exits a deal it created
// ---------------------------------------------------------------------------

test("end now: an invoice the sponsor never pays is resent, then ended from its order - its link dies at Stripe, the sponsor stays off the public page until the club taps Show on site again, in the placement the club set by hand", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  // Navs: the console (three visits), the Sponsors tab (twice), the public page read five times and opened twice, the outbox
  // poll. Stripe: the send, the resend, the end, the runner's read.
  test.setTimeout(budget(13, 4));
  expect(packageId, "leg 1 must have sold a package").not.toBe("");

  // A public competition, so the sponsor's public view can be read back: an org-wide sponsor's board shows on its page.
  const comp = await seedCompetition(request, org.orgId, { name: `Deals end-now ${RUN}`, visibility: "public" });
  const onPublicPage = async (): Promise<boolean> => {
    const res = await request.get(`/live/${org.slug}/${comp.slug}`);
    expect(res.status(), "the public competition page answers").toBe(200);
    return (await res.text()).includes(SECOND_NAME);
  };
  // Batch G ruling (g): the sponsor STARTS from a placement the club set by hand - the title tier, scoped to this competition
  // (a Pro org: `sponsors.tiers`) - so ending a deal that never went live can be seen to keep it, not reset it to the default
  // org-wide partner.
  const added = await apiJson<SponsorRow>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", {
    name: SECOND_NAME,
    url: "https://quay-chandlers.example/",
    tier: "title",
    competition_id: comp.id,
  });
  expect(added.status, `POST /sponsors answered ${added.status}: ${JSON.stringify(added.error)}`).toBe(201);
  const secondId = added.data!.id;
  expect(added.data!.status, "premise: a sponsor added by hand is on").toBe("active");
  expect(added.data, "premise: the hand-set placement").toMatchObject({ tier: "title", competition_id: comp.id, on_stream: false });
  await expect
    .poll(onPublicPage, { timeout: READ_MS, message: "premise: a sponsor added by hand shows on the public page" })
    .toBe(true);
  // ...as the title sponsor, in the hero lockup and not on the board (each the other's negative pair).
  const publicUrl = `/live/${org.slug}/${comp.slug}`;
  await page.goto(publicUrl);
  await expect(page.getByTestId("mh-hero-sponsor"), "premise: the title tier is the hero lockup").toContainText(SECOND_NAME, {
    timeout: READ_MS,
  });
  await expect(page.getByTestId("mh-sponsors").filter({ hasText: SECOND_NAME }), "premise: and not the board").toHaveCount(0);

  // Send it an invoice from the console (a real Checkout Session on the fixture account).
  await page.goto(sponsorsUrl(org.slug, "packages"));
  const panel = page.getByTestId("sponsor-packages");
  await expect(panel).toBeVisible({ timeout: READ_MS });
  await panel.getByTestId(`invoice-open-${packageId}`).click();
  await panel.getByTestId("invoice-sponsor").selectOption(secondId);
  await expect(panel.getByTestId("invoice-hidden-note"), "no live deal: the invoice hides the sponsor until it is paid").toHaveText(
    ui("sponsors.order.hiddenUntilPaid"),
  );
  await panel.getByTestId("invoice-email").fill(SECOND_EMAIL);
  const [sent] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsors/${secondId}/deals`) && r.request().method() === "POST",
      { timeout: STRIPE_MS },
    ),
    panel.getByTestId("invoice-send").click(),
  ]);
  expect(sent.status(), `POST /sponsors/{id}/deals answered ${sent.status()}: ${await sent.text()}`).toBe(201);
  const created = (await sent.json()) as { data: { deal: { id: string }; checkout_url: string } };
  const dealId = created.data.deal.id;
  const payLink = created.data.checkout_url;
  expect(payLink, "a real hosted checkout URL").toMatch(/^https:\/\/checkout\.stripe\.com\//);
  await expect.poll(onPublicPage, { timeout: READ_MS, message: "a deal waiting for its money hides the sponsor" }).toBe(false);

  // The deal now holds the sponsor's status (D9): switching it back on by hand is refused while the deal waits.
  const held = await apiJson(request, `/api/v1/orgs/${org.orgId}/sponsors/${secondId}`, "PATCH", { status: "active" });
  expect(held.status, "an open deal holds the sponsor's status").toBe(409);
  expect(held.error?.code).toBe("sponsor_has_open_deal");
  // ...so the Sponsors tab does not offer to show it again yet (the negative half of the tap below).
  await page.goto(sponsorsUrl(org.slug, "sponsors"));
  await expect(page.getByRole("button", { name: ui("sponsors.edit", { name: SECOND_NAME }) })).toBeVisible({ timeout: READ_MS });
  await expect(page.getByTestId(`sponsor-show-${secondId}`), "a deal waiting to go live holds the sponsor: no Show on site again").toHaveCount(0);
  await page.goto(sponsorsUrl(org.slug, "packages"));
  await expect(panel).toBeVisible({ timeout: READ_MS });

  // RESEND, tapped: the open link is reused (F32 - one payable link, never two) and a second invoice email is queued.
  const resend = panel.getByTestId(`order-resend-${dealId}`);
  await expect(resend).toHaveText(ui("sponsors.order.resend"));
  const [resent] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsor-deals/${dealId}/send-invoice`) && r.request().method() === "POST",
      { timeout: STRIPE_MS },
    ),
    resend.click(),
  ]);
  expect(resent.status(), `POST send-invoice answered ${resent.status()}: ${await resent.text()}`).toBe(200);
  const again = (await resent.json()) as { data: { checkout_url: string } };
  expect(again.data.checkout_url, "the stored open session is reused, not a second link").toBe(payLink);
  await expect(panel.getByTestId("invoice-link"), "the console shows the link it resent").toHaveText(payLink);
  await expect
    .poll(async () => (await outboxRows("sponsor_invoice", "sponsor_order", dealId)).length, {
      timeout: READ_MS,
      message: "the send and the resend: two invoice emails for the deal",
    })
    .toBe(2);

  // END NOW, tapped: the confirm says what the public page will do, and confirming ends the deal.
  await panel.getByTestId(`order-end-${dealId}`).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog, "End now asks first").toBeVisible();
  await expect(dialog.getByText(ui("sponsors.order.endConfirm.title"))).toBeVisible();
  await expect(dialog.getByText(ui("sponsors.order.endConfirm.bodyHidden", { name: SECOND_NAME }))).toBeVisible();
  const [ended] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsor-deals/${dealId}/end`) && r.request().method() === "POST",
      { timeout: STRIPE_MS },
    ),
    dialog.getByRole("button", { name: ui("sponsors.order.endConfirm.label"), exact: true }).click(),
  ]);
  expect(ended.status(), `POST /end answered ${ended.status()}: ${await ended.text()}`).toBe(200);
  await expect(dialog).toHaveCount(0);
  // Batch G New-1: the banner showed this deal's link after the resend (above); the deal ended, the link is dead, the banner goes.
  await expect(panel.getByTestId("invoice-link"), "an ended deal's pay link is no longer offered").toHaveCount(0);

  const deals = await apiJson<OrderRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsor-deals`);
  expect(deals.status, "GET /sponsor-deals").toBe(200);
  expect(deals.data?.find((d) => d.id === dealId), "the deal reads back ended now, never paid").toMatchObject({
    deal_status: "ended",
    ended_reason: "ended_now",
    payment_status: "pending",
  });
  // The console reads it back: ended and unpaid (review m3), with nothing left to resend or end.
  await expect(panel.getByText(ui("sponsors.order.status.endedUnpaid"))).toBeVisible();
  await expect(panel.getByTestId(`order-end-${dealId}`)).toHaveCount(0);
  await expect(panel.getByTestId(`order-resend-${dealId}`)).toHaveCount(0);

  // The link it emailed is dead, read from STRIPE: a sponsor who opens the old email cannot pay an ended deal.
  const sessionId = /\/(cs_(?:test|live)_[A-Za-z0-9]+)/.exec(payLink)?.[1] ?? "";
  expect(sessionId, `a Checkout Session id in ${payLink}`).not.toBe("");
  const session = await runnerStripe().checkout.sessions.retrieve(sessionId);
  expect(session.status, "End now expired the session it sent").toBe("expired");

  // The confirm said the sponsor stays off the public page; it does, and it is still switched off.
  const off = await apiJson<SponsorRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
  expect(off.data?.find((s) => s.id === secondId)?.status, "the sponsor's last deal ended: it stays off").toBe("inactive");
  // Ruling (g): the deal never went live, so it never wrote the placement - the club's hand-set one is kept, not reset.
  expect(off.data?.find((s) => s.id === secondId), "the hand-set placement survives the never-live deal").toMatchObject({
    tier: "title",
    competition_id: comp.id,
    on_stream: false,
  });
  expect(await onPublicPage(), "and is not on the public page").toBe(false);

  // Spec §10.3 (owner, 2026-11-07): "After all of a sponsor's deals have ended: the club may switch the sponsor back on by
  // hand, as for a sponsor with no deal." The Sponsors tab offers it on the hidden sponsor's row - TAPPED here, and the
  // terminal state is read back where a visitor meets it: the public page.
  await page.goto(sponsorsUrl(org.slug, "sponsors"));
  const showAgain = page.getByTestId(`sponsor-show-${secondId}`);
  await expect(showAgain, "every deal ended: the hidden sponsor can be shown again").toBeVisible({ timeout: READ_MS });
  await expect(showAgain).toHaveText(ui("sponsors.showAgain"));
  const [shown] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsors/${secondId}`) && r.request().method() === "PATCH",
      { timeout: READ_MS },
    ),
    showAgain.click(),
  ]);
  expect(shown.status(), `PATCH answered ${shown.status()}: ${await shown.text()}`).toBe(200);
  expect(JSON.parse(shown.request().postData() ?? "null"), "the status PATCH and nothing else").toEqual({ status: "active" });
  await expect(showAgain, "switched on: nothing left to show again").toHaveCount(0);
  const on = await apiJson<SponsorRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
  expect(on.data?.find((s) => s.id === secondId)?.status, "the sponsor reads back on").toBe("active");
  await expect.poll(onPublicPage, { timeout: READ_MS, message: "switched back on, it shows on the public page again" }).toBe(true);
  expect(on.data?.find((s) => s.id === secondId), "switched back on in the placement the club set").toMatchObject({
    tier: "title",
    competition_id: comp.id,
  });
  // Read back where a visitor meets it: the title sponsor's hero lockup again - not the partner board a reset would have put it
  // on (the pair: a reset placement shows on the board and not in the hero).
  await page.goto(publicUrl);
  await expect(page.getByTestId("mh-hero-sponsor"), "back in the hero, as the title sponsor").toContainText(SECOND_NAME, {
    timeout: READ_MS,
  });
  await expect(page.getByTestId("mh-sponsors").filter({ hasText: SECOND_NAME }), "not on the board").toHaveCount(0);
});
