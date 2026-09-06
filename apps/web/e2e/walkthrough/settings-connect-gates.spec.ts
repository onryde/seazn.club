import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  settingsUrl,
  type SeededOrg,
} from "../settings-support";
import { apiJson, setOrgConnectSql } from "../helpers";
import { routes } from "../../src/lib/routes";

/**
 * W4 of the settings walkthrough programme — the Connect-conditioned gates:
 * register cases #2 (the entry-fee currency locks once Connect is attached),
 * #3 (the `stripe` default-method radio) and #25 (a currency chosen before
 * Connect attached is stranded rather than silently reset).
 *
 * Every case here turns on two columns of `organizations` —
 * `stripe_account_id` and `stripe_charges_enabled` — and the two are NOT the
 * same switch, which is the whole reason this file exists:
 *
 *   - `default_payment_method = 'stripe'` is gated on CHARGES being enabled:
 *     an account mid-onboarding cannot take a card yet.
 *   - `currency` is gated on an ACCOUNT BEING ATTACHED at all, because
 *     `syncConnectAccount` re-mirrors the account's settlement currency onto
 *     the column on every sync — so the write is refused rather than accepted
 *     and silently reverted by the next webhook.
 *
 * A spec that treated them as one switch would assert nothing in half its
 * cases; see `detachConnect` below for the trap that is easiest to fall into.
 *
 * Parallel-safe: no case needs the shared Connect fixture account
 * (`acct_1U8o7FBlv9TBkyYa`) — that one has no release path and crashes the
 * smoke sponsor suite while another org holds it. State is flipped in SQL
 * (helpers' `setOrgConnectSql`, plus the detach below) and read back out of
 * the column, never through a real Stripe onboarding round trip.
 *
 * `mode: "default"`, for the reasons settings-org-tabs.spec.ts sets out at
 * length: `fullyParallel: true` would otherwise spread these across workers
 * and run `beforeAll` — and so `seedSettingsOrg` — once per worker, against a
 * shared Pro user bounded to five owned orgs. `default` rather than `serial`
 * because serial skips every test after the first red, and this file exists to
 * FIND defects on an uncovered surface (AGENTS.md failure class 21).
 */
test.describe.configure({ mode: "default" });

/**
 * Test budgets expressed in what each test does, never a flat literal beside a
 * derived cost (AGENTS.md failure class 20). A "nav" is a cold dynamic render
 * of a settings surface; an "api" is one authenticated JSON round trip.
 */
const NAV_MS = 20_000;
const API_MS = 6_000;
const budget = (navs: number, apis: number): number =>
  Math.max(60_000, 15_000 + navs * NAV_MS + apis * API_MS);

const READ_MS = 20_000;

let org: SeededOrg;

// ---------------------------------------------------------------------------
// Reads and state flips that are not the writer's own echo
// ---------------------------------------------------------------------------

/**
 * A short-lived direct connection, the same shape registration-connect.spec.ts
 * opens. Deliberately NOT `src/lib/db`: importing it drags the whole app's
 * DB/auth graph into the Playwright process.
 *
 * It is needed because `/api/orgs/[id]` exposes PATCH and NOTHING ELSE — there
 * is no GET handler on that route — and `GET /api/orgs` answers from
 * `getUserOrgs`, whose projection carries no `currency`. So the read-back that
 * proves the strand goes to the column itself, which is stronger than an API
 * echo of the value we just sent anyway.
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

interface OrgMoneyRow {
  currency: string | null;
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
}

async function readOrgMoney(orgId: string): Promise<OrgMoneyRow> {
  return withDb(async (sql) => {
    const [row] = await sql`
      select currency, stripe_account_id, stripe_charges_enabled
      from organizations where id = ${orgId}`;
    if (!row) throw new Error(`readOrgMoney: no organization ${orgId}`);
    return row as OrgMoneyRow;
  });
}

/**
 * Fully DETACH the Connect account.
 *
 * helpers' `setOrgConnectSql(orgId, false)` does not do this and must not be
 * mistaken for it: it writes
 * `stripe_account_id = coalesce(stripe_account_id, 'acct_e2e_…')`, so it
 * always leaves an account ATTACHED and only moves `charges_enabled`. That is
 * exactly the state case #3 wants (onboarding started, cannot charge yet) and
 * exactly the wrong precondition for the currency cases, whose lock keys on
 * `stripe_account_id IS NOT NULL` — a case that used it to "detach" would find
 * the select already disabled at the point it asserts the control is live, and
 * would report a test-setup mistake as a product defect.
 */
async function detachConnect(orgId: string): Promise<void> {
  await withDb(async (sql) => {
    await sql`
      update organizations
      set stripe_account_id = null, stripe_charges_enabled = false
      where id = ${orgId}`;
  });
}

/**
 * The entry-fee currency allowlist, read off the control the organiser
 * actually uses instead of being typed into this file.
 *
 * `REGISTRATION_CURRENCIES` cannot be imported here, and the failure is worth
 * recording rather than rediscovering: `src/lib/currency.ts` opens with
 * `import stripePlans from "@/config/stripe-plans.json"`, and Playwright's ESM
 * loader rejects that with `needs an import attribute of "type: json"` — which
 * surfaces as `Error: No tests found`, the quietest red available. The select
 * renders exactly one <option> per member of that constant
 * (`org-registration-currency.tsx`), so this is the same list one hop later
 * and still moves when the constant does. It has to: `SUPPORTED_CURRENCIES`
 * lost AUD this session (entitlements v18 T10, V394) and
 * `REGISTRATION_CURRENCIES` is a filter of it, so a pair of hardcoded codes
 * would not notice the next withdrawal.
 */
async function currencyOptions(page: Page): Promise<string[]> {
  const select = page.getByTestId("reg-currency-select");
  await expect(select, "the entry-fee currency control must mount").toBeAttached({
    timeout: READ_MS,
  });
  const values = await select
    .locator("option")
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
  expect(values.length, "the allowlist needs two members for these cases to say anything")
    .toBeGreaterThan(1);
  return values;
}

/** A member of the live allowlist that is not `current` — so every write in
 *  this file actually MOVES the column, whatever order the cases run in. */
function otherThan(options: string[], current: string | null): string {
  const next = options.find((c) => c !== current);
  if (!next) throw new Error(`no currency other than ${current} in [${options.join(", ")}]`);
  return next;
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { plan: "pro", label: "W4-connect" });
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
    // Swallowed on purpose. The detach is a courtesy — `releaseSettingsOrg`
    // deletes the org outright a line later, taking the fake `acct_e2e_…`
    // with it — but the RELEASE is the obligation, and an unguarded await
    // here would let one DB blip skip it and leak an owner slot for the rest
    // of the leg, which is the exact failure this hook exists to prevent.
    try {
      await detachConnect(org.orgId);
    } catch {
      // the release below is still owed
    }
    await releaseSettingsOrg(ctx.request, org);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------

test("case #3 — the stripe default-method radio: the UI disables it, and now so does the API", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(2, 2));

  // Onboarding started, charges not yet live — an account IS attached, which
  // is what makes this state different from "no Connect at all".
  await setOrgConnectSql(org.orgId, false);
  const before = await readOrgMoney(org.orgId);
  expect(before.stripe_account_id, "case #3 needs an attached account").not.toBeNull();
  expect(before.stripe_charges_enabled, "…that cannot charge yet").toBe(false);

  // The connect card is its OWN route, not a `?tab=` panel of the settings
  // index: `connect` is a `SettingsNavKey`, not a `SettingsTab`, and
  // settings/page.tsx falls an unrecognised `?tab=` back to "organization".
  // Built from `routes.connect`, the same builder the nav rail uses, so a path
  // change moves this spec with it.
  await page.goto(routes.connect(org.slug));
  await expect(
    page.getByTestId("method-stripe"),
    "stripe cannot be the default while charges are disabled",
  ).toBeDisabled({ timeout: READ_MS });
  await expect(
    page.getByTestId("method-offline"),
    "…while offline stays available, so this is a gate and not a dead panel",
  ).toBeEnabled({ timeout: READ_MS });

  const refused = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", {
    default_payment_method: "stripe",
  });
  expect(refused.status, "PATCH default_payment_method=stripe without charges").toBe(409);
  expect(
    (await readOrgMoney(org.orgId)).stripe_charges_enabled,
    "the refusal must not have flipped anything",
  ).toBe(false);

  await setOrgConnectSql(org.orgId, true);
  await page.reload();
  await expect(
    page.getByTestId("method-stripe"),
    "charges enabled must unlock the radio",
  ).toBeEnabled({ timeout: READ_MS });

  const accepted = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", {
    default_payment_method: "stripe",
  });
  expect(accepted.status, "PATCH default_payment_method=stripe with charges").toBe(200);
});

test("case #2 — the entry-fee currency select locks once Connect is attached, and the API refuses the write too", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(2, 3));

  await detachConnect(org.orgId);
  const held = (await readOrgMoney(org.orgId)).currency;

  await page.goto(settingsUrl(org.slug, "preferences"));
  const select = page.getByTestId("reg-currency-select");
  await expect(select, "unattached: the organiser can still choose").toBeEnabled({
    timeout: READ_MS,
  });
  // Pin what the control OPENS AT, not merely that it is reachable (AGENTS.md
  // failure class 19): a select rendering the platform default rather than the
  // org's stored value satisfies "enabled" and is wrong.
  await expect(select, "unattached: it opens at the org's stored currency").toHaveValue(
    held ?? "",
  );

  const options = await currencyOptions(page);
  const target = otherThan(options, held);
  const set = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", { currency: target });
  expect(set.status, "currency is editable while no account is attached").toBe(200);

  await setOrgConnectSql(org.orgId, true);
  await page.reload();
  await expect(select, "attached: the control must lock").toBeDisabled({ timeout: READ_MS });
  await expect(select, "…still showing the value the organiser chose").toHaveValue(target);

  const refused = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", {
    currency: otherThan(options, target),
  });
  expect(refused.status, "PATCH currency with an account attached").toBe(409);
});

test("case #25 — a currency chosen before Connect attached is stranded, visibly, not silently reset", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(2, 3));

  // The SEQUENCING is the case: choose a currency while nothing is attached,
  // then attach, then prove that what renders back — and what the column holds
  // — is the value that was there before the lock, not a default and not a
  // blank.
  await detachConnect(org.orgId);
  const held = (await readOrgMoney(org.orgId)).currency;

  await page.goto(settingsUrl(org.slug, "preferences"));
  const options = await currencyOptions(page);
  const stranded = otherThan(options, held);

  const set = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", { currency: stranded });
  expect(set.status, "set the currency BEFORE Connect attaches").toBe(200);

  await setOrgConnectSql(org.orgId, true);
  await page.reload();
  const select = page.getByTestId("reg-currency-select");
  await expect(select, "attached: locked").toBeDisabled({ timeout: READ_MS });
  await expect(
    select,
    "…and still showing what was chosen before the lock, not a default",
  ).toHaveValue(stranded);

  const attempt = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", {
    currency: otherThan(options, stranded),
  });
  expect(attempt.status, "the stranded value cannot be edited out of the lock").toBe(409);

  // The strand, read out of the column rather than echoed back by the writer:
  // still `stranded`, not reverted to a platform default by the refusal.
  expect((await readOrgMoney(org.orgId)).currency).toBe(stranded);
});
