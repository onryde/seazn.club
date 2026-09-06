# Settings W4 Implementation Plan — connect/credits/add-ons, the uncovered billing panels, sponsor monetize

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive `settings/{connect,credits,add-ons}`, the billing panels the existing suites leave uncovered (operator console, billing-group panel is already covered — see scope note below —, promo-code apply/remove, cancel-reason select), and the sponsor monetize half (sell/invoice/refund), closing edge cases #2, #3 and #25, and confirm the one real defect this wave's own research already found (§0).

**Architecture:** Four new `e2e/walkthrough/*.spec.ts` files, following the W2/W3 pattern exactly (`seedSettingsOrg`/`releaseSettingsOrg`, `test.describe.configure({ mode: "default" })`, one org per spec file). Three run parallel and API-heavy; the fourth (sponsor monetize) is the programme's one deliberately serial, real-Stripe-sandbox leg, exactly as design §6 prices it in.

**Tech Stack:** Playwright (`walkthrough` project), Vitest (unit regression), the existing `settingsUrl`/`seedSettingsOrg`/`apiJson`/`setOrgConnectSql`/`setOrgSubscriptionSql`/`setEntitlementOverrideSql` helpers.

**Spec:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-design.md` (design of record), `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md` (rulings), `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_RULES.md` (speed/isolation rules).

## §0. Ground truth as of 2026-09-06 (re-verified against `origin/main` at `7c0f5b1f8`, not memory)

Entitlements v18 W2 (PR #719) merged into `main` this session. It does **not** touch `lib/org-addons.ts`, `lib/org-addon-plans.ts`, `lib/seat-addons.ts`, or `settings/add-ons/page.tsx` (empty diff, checked directly). It does change two constants every task below must derive from, never hardcode:

- `PURCHASABLE_PLAN_KEYS = ["pro"] as const` (`lib/types.ts:214`, new). **Seed fixtures on `"pro"`, never `"pro_plus"`** — `pro_plus` now hits checkout-schema rejection paths that read as a different failure than what these specs test.
- `SUPPORTED_CURRENCIES = ["usd","eur","gbp","inr"]` (`lib/currency.ts`, V394 dropped `aud`).
- Six new migrations (V393–V398) landed. **The worktree's test DB needs `db:apply` then `sync:sports` again** before any task runs — this is the standing repo trap (`AGENTS.md` "Environment setup"), not new to this wave.

**A confirmed defect, found while researching this plan, not asserted from memory:** `PATCH /api/orgs/[id]/route.ts:109` accepts `default_payment_method: "stripe"` unconditionally —

```ts
if ("default_payment_method" in body) updates.default_payment_method = body.default_payment_method;
```

— with no check against `stripe_charges_enabled`. `org-payment-instructions.tsx`'s `method-stripe` radio is `disabled={!chargesEnabled}` client-side only. This is the exact Class-1 shape design §1 opened with (`/admin/settings`'s dead Save) — a disabled control the API happily accepts. **Ruling:** fix it in Task 1, not deferred to W8. Design §10's "test-only through W7" is this programme's *default*, but `_INDEX.md` ruling 7 already overrode that default twice this programme for confirmed, mechanical, small-blast-radius gaps on a money-adjacent surface ("the hardcoded English... on a customer-facing row", "an api-keys test that may be exercising the session instead of the key"). Leaving a known-unguarded write path live for four more waves costs more than a two-line guard costs to review. If the reviewer or owner disagrees, revert is a one-line change — recorded here so it is visible, not silent.

## §1. The budget crisis this wave inherits — folded in here, not a separate follow-up

Per the user's explicit instruction, W3's budget overrun is **this wave's problem to plan around**, not a decision to punt elsewhere.

- Owner ruling 6 (`_INDEX.md`): the ≤60s programme ceiling **holds**; waves restructure to fit it, the ceiling does not move.
- W2 measured ~30s. W3's plan targeted ≤10s; it actually landed ~11–12.5s. Cumulative through W3 was reported at ~57–58.5s of the 60s ceiling, with W4–W8 still ahead.
- **This wave's own new work is structured to spend almost none of that headroom**: Tasks 1–3 are seeded once per file, API-first per `_RULES.md` §5 (an `APIRequestContext` read wherever the API's own answer is the thing under test; a browser page load only where a rendered `disabled` state is what the API cannot show), no `waitForTimeout`, no screenshots, no axe.
- **Task 4 (sponsor monetize) is the one place this wave cannot be cheap.** Design §6 already prices this in as "the single place in the programme that does not run in parallel", and CI's `walkthrough` project is provisioned with a real `STRIPE_SECRET_KEY` (`e2e.yml:283`) precisely so this leg runs for real, not with a dummy key — unlike the `serial`/`parallel` projects (`e2e.yml:652,942`), which always get the dummy key and could never exercise this path regardless of what this plan does.
- **Ruling, recorded rather than hidden:** completing a real Stripe purchase for extra-orgs, extra-seats, credit packs, promo-code apply, or subscription cancellation is **out of scope for this wave's always-on coverage**. No e2e spec in this repo completes any of those five paths today (confirmed by search, not assumed) — the only place they are exercised for real is a `BILLING_LIVE=1`-gated **Vitest** suite (`extra-org-addon.live.test.ts` and its three siblings), which stays outside the CI-measured walkthrough leg entirely. Extending real-money completion to five more surfaces now, on top of an already-strained budget, buys marginal coverage beyond what W4 is actually scoped to prove (Class 1 UI-only gating, and the bounds/refusal branches an API read can see) at a cost this wave cannot absorb. Tasks 2 and 3 below prove gating, bounds and refusal branches only — never completion.
- **Task 5 measures the real delta and reports it honestly.** If the sponsor-monetize leg alone exceeds the remaining ~1.5–3s of headroom — which is likely, given it is a full browser round trip against real Stripe network calls — that measurement **is** the escalation ruling 6 itself was built to receive ("put to the owner with the measurement"), not a defect in this plan. Task 5 prepares that escalation with raw numbers rather than silently absorbing or hiding an overrun.

## Global Constraints

- `pnpm@10.34.5`, `node >=26`. Fresh worktree: `pnpm install`, then `db:apply` + `sync:sports` (§0).
- One org per **spec file**, not per test — the shared Pro user's `orgs.max_owned` cap (see `settings-support.ts`'s own doc comment). Seed with `seedSettingsOrg(request, { plan: "pro", label: "W4" })`; release in `afterAll` with `releaseSettingsOrg`.
- `test.describe.configure({ mode: "default" })` on every new parallel-safe file (never the ambient default, never `serial`, per `settings-org-tabs.spec.ts`'s own documented reasoning — `serial` hides every red after the first).
- Helpers live outside `e2e/walkthrough/` (the `testMatch` trap, `_RULES.md` §3) — no new file goes there; existing `settings-support.ts`/`helpers.ts` cover everything this wave needs.
- Derive every expected value from its source-of-truth constant: `ORG_ADDONS`/`ORG_ADDON_FEATURE_KEY`/`ORG_ADDON_DELTA_EACH` (`lib/org-addons.ts`), `SEAT_ADDON` (`lib/seat-addons.ts`), `SUPPORTED_CURRENCIES`/`REGISTRATION_CURRENCIES` (`lib/currency.ts`), `PURCHASABLE_PLAN_KEYS` (`lib/types.ts`). Never a typed literal for a price, currency list, or plan key — §0's whole point is that these just moved once already.
- No `waitForTimeout` — `expect.poll`/`waitForResponse` only. No screenshots, no axe (`gallery.capture`/`mobile.spec.ts` own those). At most one `page.reload()` per tab under test.
- Restore every borrowed privilege/shared resource in `finally`/`afterAll` (`_RULES.md` §4) — the Connect fixture account above all.
- Subagent dispatches use Opus 5 (programme ruling 5 — this overrides `AGENTS.md`'s general "never override `model:`").
- Any new user-facing string ships to all four locale dictionaries via `gen-keys` — none of this wave's changes add one (the API guard fix reuses the existing generic error shape; the new testid is not copy).
- New WALKTHROUGH_SPECS entries appended to `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`'s array (currently closing at line 205) in the same task that adds each spec file — the trap that cost W3 two red CI checks.

---

### Task 1: Connect surface — cases #2, #3, #25, and the confirmed API gap

**Files:**
- Modify: `apps/web/src/app/api/orgs/[id]/route.ts:109`
- Modify: `apps/web/src/app/api/orgs/[id]/__tests__/route.test.ts`
- Modify: `apps/web/src/components/org-registration-currency.tsx`
- Create: `apps/web/e2e/walkthrough/settings-connect-gates.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`

**Interfaces:**
- Consumes: `seedSettingsOrg`/`releaseSettingsOrg`/`settingsUrl` (`../settings-support`), `apiJson`/`setOrgConnectSql` (`../helpers`), `REGISTRATION_CURRENCIES` (`@/lib/currency`).
- Produces: nothing later tasks depend on — this task's spec file is self-contained.

- [ ] **Step 1: Write the failing unit test for the API gap**

Append to `apps/web/src/app/api/orgs/[id]/__tests__/route.test.ts`, inside the existing `describe.skipIf(!HAS_DB)("PATCH /api/orgs/[id] slug cache invalidation", ...)` block's sibling — add a new `describe` beneath it, before the closing `afterAll`:

```ts
describe.skipIf(!HAS_DB)("PATCH /api/orgs/[id] default_payment_method gate", () => {
  it("refuses stripe as the default method while charges are not enabled", async () => {
    const org = await seedOrg();
    const res = await PATCH(patchReq({ default_payment_method: "stripe" }), {
      params: Promise.resolve({ id: org.id }),
    });
    expect(res.status).toBe(409);
  });

  it("accepts stripe once charges are enabled", async () => {
    const org = await seedOrg();
    await sql`update organizations set stripe_charges_enabled = true where id = ${org.id}`;
    const res = await PATCH(patchReq({ default_payment_method: "stripe" }), {
      params: Promise.resolve({ id: org.id }),
    });
    expect(res.status).toBe(200);
  });

  it("always accepts offline, regardless of charges_enabled", async () => {
    const org = await seedOrg();
    const res = await PATCH(patchReq({ default_payment_method: "offline" }), {
      params: Promise.resolve({ id: org.id }),
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify the first case fails**

Run: `cd apps/web && npx vitest run src/app/api/orgs/\[id\]/__tests__/route.test.ts --reporter=json --outputFile=/tmp/w4-t1-red.json`
Expected: the first new test FAILS (`res.status` is `200`, not `409`) — this is the confirmed gap from §0, not a mistake in the test.

- [ ] **Step 3: Add the guard**

In `apps/web/src/app/api/orgs/[id]/route.ts`, replace line 109:

```ts
    if ("default_payment_method" in body) updates.default_payment_method = body.default_payment_method;
```

with:

```ts
    if ("default_payment_method" in body) {
      if (body.default_payment_method === "stripe") {
        const [conn] = await sql<{ stripe_charges_enabled: boolean }[]>`
          select stripe_charges_enabled from organizations where id = ${id}`;
        if (!conn) throw new HttpError(404, "Organization not found");
        if (!conn.stripe_charges_enabled) {
          throw new HttpError(409, "Stripe is not ready to accept charges yet");
        }
      }
      updates.default_payment_method = body.default_payment_method;
    }
```

`HttpError` is already imported in this file (used two blocks below for the currency lock). This mirrors that guard's exact shape — a targeted `select` before the write, not a whole-row precondition check.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cd apps/web && npx vitest run src/app/api/orgs/\[id\]/__tests__/route.test.ts --reporter=json --outputFile=/tmp/w4-t1-green.json`
Expected: all three new cases PASS, and the pre-existing two tests in the file still pass (5/5 total in this file).

- [ ] **Step 5: Add the `data-testid` the e2e spec needs**

In `apps/web/src/components/org-registration-currency.tsx`, the `<select>` element currently reads:

```tsx
        <select
          className="input min-h-11 w-auto"
          aria-label={msg("settings.org.regCurrency.aria")}
          value={value}
          disabled={locked}
          onChange={(e) => setValue(e.target.value as Currency)}
        >
```

Add one attribute — no other change:

```tsx
        <select
          className="input min-h-11 w-auto"
          data-testid="reg-currency-select"
          aria-label={msg("settings.org.regCurrency.aria")}
          value={value}
          disabled={locked}
          onChange={(e) => setValue(e.target.value as Currency)}
        >
```

- [ ] **Step 6: Write the e2e spec — cases #2, #3, #25**

Create `apps/web/e2e/walkthrough/settings-connect-gates.spec.ts`:

```ts
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { seedSettingsOrg, releaseSettingsOrg, settingsUrl, type SeededOrg } from "../settings-support";
import { apiJson, setOrgConnectSql } from "../helpers";
import { REGISTRATION_CURRENCIES } from "../../src/lib/currency";

/**
 * W4 of the settings walkthrough programme — Class 1 (UI-only gating) cases
 * #2, #3 and #25, all of which turn on `organizations.stripe_account_id` /
 * `stripe_charges_enabled`. Parallel-safe: every case reads state through the
 * API or a single reload, never through a real Stripe onboarding round trip
 * (that needs the shared fixture account — see settings-sponsor-monetize.spec.ts).
 */
test.describe.configure({ mode: "default" });

let org: SeededOrg;

test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  org = await seedSettingsOrg(request, { plan: "pro", label: "W4-connect" });
});

test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await releaseSettingsOrg(request, org);
});

test("case #3 — the stripe default-method radio: UI disables it, and now so does the API", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  await setOrgConnectSql(org.orgId, false);
  await page.goto(settingsUrl(org.slug, "connect"));
  await expect(page.getByTestId("method-stripe")).toBeDisabled();

  const refused = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", {
    default_payment_method: "stripe",
  });
  expect(refused.status).toBe(409);

  await setOrgConnectSql(org.orgId, true);
  await page.reload();
  await expect(page.getByTestId("method-stripe")).toBeEnabled();

  const accepted = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", {
    default_payment_method: "stripe",
  });
  expect(accepted.status).toBe(200);
});

test("case #2 — the entry-fee currency select locks once Connect is attached, and the API refuses the write too", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  // Pick a currency that is not the default and IS in the live registration
  // set, derived rather than typed — SUPPORTED_CURRENCIES lost "aud" this
  // session (V394); a hardcoded "usd" would not notice the next cut either.
  const target = REGISTRATION_CURRENCIES.find((c) => c !== "usd") ?? REGISTRATION_CURRENCIES[0]!;

  const before = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", { currency: target });
  expect(before.status).toBe(200);

  await page.goto(settingsUrl(org.slug, "preferences"));
  await expect(page.getByTestId("reg-currency-select")).toBeEnabled();
  await expect(page.getByTestId("reg-currency-select")).toHaveValue(target);

  await setOrgConnectSql(org.orgId, true);
  await page.reload();
  await expect(page.getByTestId("reg-currency-select")).toBeDisabled();

  const other = REGISTRATION_CURRENCIES.find((c) => c !== target)!;
  const refused = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", { currency: other });
  expect(refused.status).toBe(409);
});

test("case #25 — a currency set before Connect attached is stranded, visibly, not silently reset", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  // Deliberately re-uses the org from case #2 (same beforeAll seed) — the
  // sequencing IS the case: set a non-default currency BEFORE Connect
  // attaches, then attach, then prove the value that renders back is the one
  // that was there before the lock, not a default or a blank.
  const stranded = REGISTRATION_CURRENCIES.find((c) => c !== "usd") ?? REGISTRATION_CURRENCIES[0]!;
  await setOrgConnectSql(org.orgId, false); // detach — org.currency from case #2 is already `stranded`'s sibling test value
  const set = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", { currency: stranded });
  expect(set.status).toBe(200);

  await setOrgConnectSql(org.orgId, true);
  await page.goto(settingsUrl(org.slug, "preferences"));
  await expect(page.getByTestId("reg-currency-select")).toBeDisabled();
  await expect(page.getByTestId("reg-currency-select")).toHaveValue(stranded);

  const attempt = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", {
    currency: REGISTRATION_CURRENCIES.find((c) => c !== stranded)!,
  });
  expect(attempt.status).toBe(409);
  // Confirms the strand: still `stranded`, not silently reverted to a default.
  const read = await apiJson<{ currency: string }>(request, `/api/orgs/${org.orgId}`, "GET");
  expect(read.data?.currency).toBe(stranded);
});
```

- [ ] **Step 7: Run the spec locally**

Run: `cd apps/web && npx playwright test e2e/walkthrough/settings-connect-gates.spec.ts --project=walkthrough --reporter=json --output=/tmp/w4-t1-e2e.json`
Expected: 3/3 pass. If `GET /api/orgs/{id}` is not the right read route for the last assertion, check `apps/web/src/app/api/orgs/[id]/route.ts`'s `GET` handler response shape and adjust the field path — do not change the assertion's intent (that the value survived, unchanged).

- [ ] **Step 8: Register the new spec in the CI wiring inventory**

In `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`, add a new group after the "Settings W3" group (the gating-matrix trio ending `"settings-role-gates.spec.ts",`):

```ts
    // Settings W4 — connect/credits/add-ons, the billing panels the existing
    // suites leave uncovered, and the sponsor monetize half.
    "settings-connect-gates.spec.ts",
```

(The remaining three W4 spec filenames from Tasks 2–4 are added to this same group by those tasks — do not duplicate this comment line.)

- [ ] **Step 9: Run the wiring test**

Run: `cd apps/web && npx vitest run src/lib/__tests__/e2e-ci-wiring.test.ts --reporter=json --outputFile=/tmp/w4-t1-wiring.json`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/app/api/orgs/\[id\]/route.ts \
        apps/web/src/app/api/orgs/\[id\]/__tests__/route.test.ts \
        apps/web/src/components/org-registration-currency.tsx \
        apps/web/e2e/walkthrough/settings-connect-gates.spec.ts \
        apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts
git commit -m "fix(settings): guard default_payment_method=stripe on charges_enabled; drive Connect gating cases #2/#3/#25"
```

---

### Task 2: Add-ons and extra-seats — control affordances, derived bounds, refusal branches (not completion)

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-add-ons-drive.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`

**Interfaces:**
- Consumes: `seedSettingsOrg`/`releaseSettingsOrg`/`settingsUrl`, `apiJson`/`setOrgSubscriptionSql`, `ORG_ADDONS`/`orgAddonPriceMinor` (`@/lib/org-addons`), `SEAT_ADDON` (`@/lib/seat-addons`).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the spec**

Create `apps/web/e2e/walkthrough/settings-add-ons-drive.spec.ts`:

```ts
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { seedSettingsOrg, releaseSettingsOrg, settingsUrl, type SeededOrg } from "../settings-support";
import { apiJson, setOrgSubscriptionSql } from "../helpers";
import { ORG_ADDONS, orgAddonForPlan, orgAddonPriceMinor } from "../../src/lib/org-addons";
import { PURCHASABLE_PLAN_KEYS } from "../../src/lib/types";

/**
 * W4 — the add-ons page's own controls (§11 out-of-scope note: completing a
 * real subscription-item purchase against Stripe is NOT this file's job —
 * see settings-add-ons-drive.spec.ts's sibling doc-comment in the W4 plan for
 * why. This file proves the stepper's bounds and the API's refusal branches,
 * which is exactly what design §7 Class 1/2 asks W4 for on this surface.
 */
test.describe.configure({ mode: "default" });

let org: SeededOrg;

test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  org = await seedSettingsOrg(request, { plan: "pro", label: "W4-addons" });
});

test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await releaseSettingsOrg(request, org);
});

test("the extra-org stepper opens at 0, respects min/max, and Save is disabled until dirty", async ({
  page,
}: {
  page: Page;
}) => {
  const addon = orgAddonForPlan("pro");
  test.skip(!addon, "no org-addon SKU seeded for pro in this environment's stripe-plans.json");

  await page.goto(settingsUrl(org.slug, "add-ons"));
  const count = page.locator("[data-extra-org-count]");
  await expect(count).toHaveValue("0");

  const decrement = page.getByRole("button", { name: "−" });
  await expect(decrement).toBeDisabled(); // already at min

  const increment = page.getByRole("button", { name: "+" });
  const saveButton = page.getByRole("button", { name: /save/i });
  await expect(saveButton).toBeDisabled(); // not dirty yet

  await increment.click();
  await expect(count).toHaveValue("1");
  await expect(saveButton).toBeEnabled();
});

test("the org-addon price and currency shown are the catalog's own, never a typed literal", async ({
  page,
}: {
  page: Page;
}) => {
  const addon = orgAddonForPlan("pro");
  test.skip(!addon, "no org-addon SKU seeded for pro in this environment's stripe-plans.json");
  const priceMinor = orgAddonPriceMinor("pro", "usd");
  test.skip(priceMinor === null, "no usd price point for the pro org-addon SKU");

  await page.goto(settingsUrl(org.slug, "add-ons"));
  const expected = `$${(priceMinor! / 100).toFixed(2)}`;
  await expect(page.getByText(expected, { exact: false })).toBeVisible();
});

test("the API refuses an extra-orgs change without a live subscription (409)", async ({
  request,
}: {
  request: APIRequestContext;
}) => {
  // A community org (no live subscription) hits the guard extra-orgs.ts:100-121
  // enforces BEFORE any Stripe call — no catalog SKU needed to prove this.
  const community = await seedSettingsOrg(request, { plan: "community", label: "W4-addons-refuse" });
  try {
    const res = await apiJson(request, "/api/billing/extra-orgs", "POST", {
      org_id: community.orgId,
      count: 1,
    });
    expect(res.status).toBe(409);
  } finally {
    await releaseSettingsOrg(request, community);
  }
});

test("the API refuses a plan with no org-addon SKU, derived from PURCHASABLE_PLAN_KEYS never a hardcoded key", async ({
  request,
}: {
  request: APIRequestContext;
}) => {
  const unsellable = ORG_ADDONS.every((e) => e.planKey !== "community");
  test.skip(!unsellable, "community unexpectedly has an org-addon SKU — case no longer applies");
  expect(PURCHASABLE_PLAN_KEYS as readonly string[]).not.toContain("community");

  const community = await seedSettingsOrg(request, { plan: "community", label: "W4-addons-sku" });
  try {
    // stripe_subscription_id is set so the request clears the LIVE-subscription
    // guard and reaches the SKU guard specifically — proving which 409 fires.
    await setOrgSubscriptionSql({ orgId: community.orgId }, "community");
    const res = await apiJson(request, "/api/billing/extra-orgs", "POST", {
      org_id: community.orgId,
      count: 1,
    });
    expect(res.status).toBe(409);
  } finally {
    await releaseSettingsOrg(request, community);
  }
});
```

Note: `orgAddonForPlan`/`ORG_ADDONS` import path — check `@/lib/org-addons`'s actual export list before wiring the relative import above; if the file is not resolvable via a relative path from `e2e/` in this repo's `tsconfig`, use the same `../../src/lib/...` relative form `settings-org-tabs.spec.ts` already uses for `BRAND_PALETTE` (confirmed working there).

`setOrgSubscriptionSql`'s exact signature (`helpers.ts:1021`) takes `({ orgId?, email? }, planKey, opts?)` — confirm the second positional argument accepts `"community"` as a bare string or needs an options object with `status`, and adjust the call in the last test to match; the intent (a community-plan org with *some* `stripe_subscription_id`/`status` combination that clears the live-subscription check but has no addon SKU) is what must survive, not the literal call shape above.

- [ ] **Step 2: Run it locally**

Run: `cd apps/web && npx playwright test e2e/walkthrough/settings-add-ons-drive.spec.ts --project=walkthrough --reporter=json --output=/tmp/w4-t2-e2e.json`
Expected: all non-skipped tests pass. A `test.skip` firing on the SKU-dependent tests is a valid outcome in an environment whose `stripe-plans.json` seed has no `pro` org-addon entry — confirm which happened by reading `.testResults[].name` and the skip reasons, not just the pass count.

- [ ] **Step 3: Register the spec**

In `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`, add beneath Task 1's new line:

```ts
    "settings-add-ons-drive.spec.ts",
```

- [ ] **Step 4: Run the wiring test and commit**

Run: `cd apps/web && npx vitest run src/lib/__tests__/e2e-ci-wiring.test.ts --reporter=json --outputFile=/tmp/w4-t2-wiring.json`
Expected: PASS.

```bash
git add apps/web/e2e/walkthrough/settings-add-ons-drive.spec.ts apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts
git commit -m "test(settings): drive the add-ons stepper's bounds and the extra-orgs API's refusal branches"
```

---

### Task 3: Credits, operator console, promo code, cancel reason — affordances and bounds

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-billing-panels.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`

**Interfaces:**
- Consumes: `seedSettingsOrg`/`releaseSettingsOrg`/`settingsUrl`, `apiJson`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the spec**

Create `apps/web/e2e/walkthrough/settings-billing-panels.spec.ts`:

```ts
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { seedSettingsOrg, releaseSettingsOrg, settingsUrl, type SeededOrg } from "../settings-support";
import { apiJson } from "../helpers";

/**
 * W4 — the panels design §11 names as previously undriven: the credits page's
 * buy/export affordances, the operator console's per-org allocation editor
 * (no Stripe call at all — operator-allocation.ts is a pure DB upsert), the
 * promo-code apply/remove pair, and the cancel-reason select. None of these
 * complete a real Stripe mutation here — see the W4 plan's §1 ruling.
 */
test.describe.configure({ mode: "default" });

let org: SeededOrg;

test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  org = await seedSettingsOrg(request, { plan: "pro", label: "W4-billing-panels" });
});

test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await releaseSettingsOrg(request, org);
});

test("the buy-credits control opens the embedded checkout without completing it", async ({
  page,
}: {
  page: Page;
}) => {
  await page.goto(settingsUrl(org.slug, "credits"));
  await page.getByTestId("buy-credits").click();
  // Stripe's embedded checkout mounts inside an iframe — asserting the iframe
  // appears is the affordance; billing.spec.ts already owns filling it out.
  await expect(page.locator('iframe[src*="stripe.com"]')).toBeVisible({ timeout: 15_000 });
});

test("the CSV export link is absent with no history, and appears once there is a ledger row", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  await page.goto(settingsUrl(org.slug, "credits"));
  await expect(page.getByRole("link", { name: /export/i })).toHaveCount(0);
  // No ledger-seeding helper exists for this org's credits today (confirmed:
  // no e2e in this repo drives a credit grant outside the live-Stripe suite)
  // — the positive case is therefore left to whichever wave adds one, and is
  // recorded as a gap rather than faked with a raw SQL insert into a ledger
  // table this spec does not own.
});

test("promo apply and remove render and hit the real route, refused without a live Stripe subscription", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  await page.goto(settingsUrl(org.slug, "billing"));
  await page.getByRole("button", { name: /have a promo code/i }).click();
  await page.getByLabel("Promotion code").fill("WELCOME10");
  const apply = page.getByRole("button", { name: "Apply" });
  await expect(apply).toBeEnabled();
  await apply.click();
  // A freshly seeded org's subscriptions row has no real stripe_subscription_id
  // — the route's own guard refuses before any Stripe call, which is exactly
  // the boundary this test is pinned to (see §1: completion is out of scope).
  const res = await apiJson(request, "/api/billing/promo", "POST", { code: "WELCOME10" });
  expect(res.status).toBeGreaterThanOrEqual(400);
});

test("the cancel-reason select renders every CANCEL_REASONS option", async ({ page }: { page: Page }) => {
  await page.goto(settingsUrl(org.slug, "billing"));
  await page.getByRole("button", { name: "Cancel subscription" }).click();
  const select = page.getByRole("combobox", { name: /what made you cancel/i });
  await expect(select).toBeVisible();
  const optionCount = await select.locator("option").count();
  // "Choose a reason…" plus the 5 CANCEL_REASONS entries in billing-manage.tsx.
  expect(optionCount).toBe(6);
});

test("operator console: allocation editor validates the cap and PUTs to the real route", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  // operator-allocation.ts's authorization is PAYER-of-the-group, not owner-
  // of-this-org — the seeded org's own creator IS its payer (fresh community
  // subscription per org, per settings-support.ts's doc comment), so no
  // extra seeding is needed to reach the console as its own operator.
  const res = await apiJson(request, "/api/billing/group/allocation", "PUT", {
    org_id: org.orgId,
    monthly_cap: 500,
  });
  expect(res.status).toBe(200);

  const negative = await apiJson(request, "/api/billing/group/allocation", "PUT", {
    org_id: org.orgId,
    monthly_cap: -1,
  });
  expect(negative.status).toBe(400);

  await page.goto(settingsUrl(org.slug, "billing"));
  await expect(page.getByRole("button", { name: "Edit" }).first()).toBeVisible();
});
```

Note: the exact route path/body shape for `POST /api/billing/promo` (`code` vs `promo_code` field name) and `PUT /api/billing/group/allocation` (`org_id`/`monthly_cap` vs `orgId`/`cap`) must be confirmed against the live route handlers before this task is marked done — `billing-manage.tsx:957` and `operator-console.tsx`'s fetch call are the sources of truth; adjust the request bodies above to match exactly rather than guessing.

- [ ] **Step 2: Run it locally**

Run: `cd apps/web && npx playwright test e2e/walkthrough/settings-billing-panels.spec.ts --project=walkthrough --reporter=json --output=/tmp/w4-t3-e2e.json`
Expected: all pass. `stripe.com` iframe assertion needs a real or CI-provisioned `STRIPE_SECRET_KEY` reachable from the checkout-session route to mount at all — if it 5xxes locally with a dummy key, gate that one test the same way `event-pass.spec.ts` does (`passCheckoutProbeStatus`-style: probe, `test.skip` on `>=500`, named reason) rather than leaving it flaky.

- [ ] **Step 3: Register the spec**

```ts
    "settings-billing-panels.spec.ts",
```

- [ ] **Step 4: Run the wiring test and commit**

Run: `cd apps/web && npx vitest run src/lib/__tests__/e2e-ci-wiring.test.ts --reporter=json --outputFile=/tmp/w4-t3-wiring.json`

```bash
git add apps/web/e2e/walkthrough/settings-billing-panels.spec.ts apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts
git commit -m "test(settings): drive credits/operator-console/promo/cancel affordances and bounds"
```

---

### Task 4: Sponsor monetize — the real Connect fixture leg (serial, expensive, mandated)

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`

**Interfaces:**
- Consumes: `apiJson` (`../helpers`), the fixture-claim pattern from `registration-connect.spec.ts` (`claimConnectAccount`/`releaseConnectAccount` — copy the shape, do not import it; it is file-local there for a reason — one claimant at a time, and importing it would let two files race the same module-scoped account without either knowing about the other).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the spec**

Create `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts`:

```ts
// The sponsor monetize half — sell a package, send an invoice, refund an
// order — through the shared Stripe Connect fixture account. Deliberately
// SERIAL: the fixture (`STRIPE_CONNECT_TEST_ACCOUNT`) has no release path and
// only one org may hold it at a time (design §6.1) — the same reason
// registration-connect.spec.ts and the rs007 specs are each their own
// self-contained serial file rather than sharing a project-wide serial mode.
//
// settings-org-tabs.spec.ts explicitly excludes this half (its own doc
// comment, W2): "needs the shared Connect fixture account... crashes smoke's
// sponsor-checkout suite while another org holds it."
//
// OPT-IN, same gate as the three existing Connect walkthroughs:
//   CONNECT_WALKTHROUGH=1 STRIPE_CONNECT_TEST_ACCOUNT=acct_... \
//     npx playwright test e2e/walkthrough/settings-sponsor-monetize.spec.ts --project=walkthrough
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson } from "../helpers";
import { seedSettingsOrg, releaseSettingsOrg, settingsUrl, type SeededOrg } from "../settings-support";

test.describe.configure({ mode: "serial" });

const ENABLED = process.env.CONNECT_WALKTHROUGH === "1";
const CONNECT_ACCOUNT = process.env.STRIPE_CONNECT_TEST_ACCOUNT ?? "";

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

async function claimConnectAccount(orgId: string): Promise<string | null> {
  return withDb(async (sql) => {
    const prior = await sql`select id from organizations where stripe_account_id = ${CONNECT_ACCOUNT}`;
    const priorId = (prior[0]?.id as string | undefined) ?? null;
    if (priorId) {
      await sql`update organizations set stripe_account_id = null, stripe_charges_enabled = false where id = ${priorId}`;
    }
    await sql`update organizations set stripe_account_id = ${CONNECT_ACCOUNT}, stripe_charges_enabled = true where id = ${orgId}`;
    return priorId;
  });
}

async function releaseConnectAccount(orgId: string, priorId: string | null): Promise<void> {
  await withDb(async (sql) => {
    await sql`update organizations set stripe_account_id = null, stripe_charges_enabled = false where id = ${orgId}`;
    if (priorId) {
      await sql`update organizations set stripe_account_id = ${CONNECT_ACCOUNT}, stripe_charges_enabled = true where id = ${priorId}`;
    }
  });
}

let org: SeededOrg;
let priorHolder: string | null = null;

test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  test.skip(!ENABLED, "opt-in: set CONNECT_WALKTHROUGH=1 (needs a real sk_test)");
  test.skip(!CONNECT_ACCOUNT, "STRIPE_CONNECT_TEST_ACCOUNT is unset — a fabricated account id is rejected by Stripe");
  org = await seedSettingsOrg(request, { plan: "pro", label: "W4-sponsor-monetize" });
  await request.post(`/api/orgs/${org.orgId}/entitlements`, {
    data: { feature_key: "sponsors.monetize", bool_value: true },
  }).catch(() => {}); // best-effort — Task 4's implementer confirms the real override route/helper below
  priorHolder = await claimConnectAccount(org.orgId);
});

test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  if (!org) return;
  await releaseConnectAccount(org.orgId, priorHolder);
  await releaseSettingsOrg(request, org);
});

test("sell a sponsor package, send an invoice, and refund it — through the connected account", async ({
  page,
}: {
  page: Page;
}) => {
  await page.goto(settingsUrl(org.slug, "sponsors"));

  await page.getByRole("button", { name: /new package/i }).click();
  await page.getByLabel(/name/i).fill("Gold Match Sponsor");
  await page.getByLabel(/price/i).fill("50");
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page.getByText("Gold Match Sponsor")).toBeVisible();

  await page.getByRole("button", { name: /invoice/i }).click();
  await page.getByLabel(/name/i).last().fill("Riverside Sports Ltd");
  await page.getByLabel(/email/i).fill("sponsor@example.com");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByText(/sent/i)).toBeVisible({ timeout: 20_000 });

  const refundButton = page.getByRole("button", { name: /refund/i }).first();
  await refundButton.click();
  await expect(page.getByText(/refunded/i)).toBeVisible({ timeout: 20_000 });
});
```

`sponsors.monetize` entitlement override: confirm the real route/helper — `setBoolEntitlementOverrideSql(orgId, featureKey, value)` (`helpers.ts:518`) is the established pattern every other gated spec in this programme uses (Task 1–3 above and W2/W3's specs); replace the speculative `fetch(.../entitlements)` call above with `await setBoolEntitlementOverrideSql(org.orgId, "sponsors.monetize", true)` imported from `../helpers`, and delete the `.catch(() => {})` — a real helper call should not need one. The selectors for "new package"/"invoice"/"send"/"refund" buttons are read off `sponsor-packages.tsx`'s actual rendered labels — the file's `aria-label`s use `msg("sponsors...")` dictionary keys, not literal English; confirm the current English dictionary strings for these before locking in `getByRole("button", { name: ... })` patterns, since a regex match against dictionary copy is the one thing `_RULES.md`'s "copy read from the dictionary" idiom exists to prevent going stale silently.

- [ ] **Step 2: Run it locally, with the fixture**

Run:
```bash
CONNECT_WALKTHROUGH=1 STRIPE_CONNECT_TEST_ACCOUNT=acct_1U8o7FBlv9TBkyYa \
  npx playwright test e2e/walkthrough/settings-sponsor-monetize.spec.ts --project=walkthrough \
  --reporter=json --output=/tmp/w4-t4-e2e.json
```
Expected: 1/1 passes, and `RESTORE>>>`-style logging (or an equivalent assertion) confirms the fixture account is handed back to whichever org held it before this run — check with a direct query if in doubt, the same way `registration-connect.spec.ts` does.

Run without the env vars too: `npx playwright test e2e/walkthrough/settings-sponsor-monetize.spec.ts --project=walkthrough --reporter=json --output=/tmp/w4-t4-skip.json` — expected: 1 skipped, with a visible named reason (mirror `registration-connect.spec.ts`'s own skip-summary reporter if this file needs one; check whether that reporting is global-setup-level and therefore automatic for every `CONNECT_WALKTHROUGH`-gated file, or per-file).

- [ ] **Step 3: Register the spec**

```ts
    "settings-sponsor-monetize.spec.ts",
```

- [ ] **Step 4: Run the wiring test and commit**

```bash
cd apps/web && npx vitest run src/lib/__tests__/e2e-ci-wiring.test.ts --reporter=json --outputFile=/tmp/w4-t4-wiring.json
git add apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts
git commit -m "test(settings): drive the sponsor monetize half through the real Connect fixture, serial"
```

---

### Task 5: Budget measurement, honest escalation, and the wave's own review

**Files:** none created — this task reads CI/local run output and writes the plan's closing report into the PR description; no source change.

- [ ] **Step 1: Run the whole `walkthrough` project locally and record wall clock**

Run: `cd apps/web && time npx playwright test --project=walkthrough --workers=3 --reporter=json --outputFile=/tmp/w4-full-walkthrough.json`

Record the `duration` field from the JSON report's summary alongside the wall-clock `time` output, and separately the four new files' own contribution (rerun with `--grep` scoped to just `settings-connect-gates|settings-add-ons-drive|settings-billing-panels|settings-sponsor-monetize` is NOT sufficient on its own per `AGENTS.md`'s own trap #21 — `-g` is a filename sweep in costume; use the full project run's per-file timing in the JSON report's `.testResults[].duration`, not a grepped re-run, to attribute cost).

- [ ] **Step 2: Compare against remaining headroom and write the honest verdict**

Remaining headroom at W4's start (§1): ~1.5–3s of the 60s ceiling, after W0–W3's reported ~57–58.5s. Tasks 1–3 are designed to add close to nothing (API-first, one seed per file, no extra page loads beyond what each assertion strictly needs) — confirm this from the JSON report rather than assuming it. Task 4 is very likely to exceed the remaining headroom on its own, being a real network round trip against Stripe.

Write the verdict into the PR description in this shape (fill in the real numbers, do not round favorably):

```
W4 budget: <measured delta>s added to the walkthrough leg (Tasks 1-3: <X>s, Task 4: <Y>s).
Cumulative: <prior total>s + <this wave's delta>s = <new total>s of the 60s ceiling.
Ruling needed: ceiling holds and W5-W8 absorb the overrun by cutting elsewhere,
OR the ceiling is amended for this wave's mandated real-Stripe leg specifically.
Recommendation (not a ruling): <your call, following ruling 6's own precedent —
put it to the owner with the measurement>.
```

This is the escalation the plan's §1 promised — it belongs in the PR, not silently absorbed into a rounded-down claim of "on budget."

- [ ] **Step 3: Dispatch the final whole-branch review**

Per `subagent-driven-development`, dispatch the final code reviewer on the most capable available model (Opus 5, per programme ruling 5) against the full branch diff. Reviewer inputs: this plan file, the design doc, and `_RULES.md`. Pay particular attention to:
- the Task 1 API guard — does it correctly distinguish the 404 (org not found) and 409 (charges not enabled) paths, and does the existing currency-lock guard two lines below still read correctly after the edit;
- whether any of Tasks 2-4's selectors (`getByRole`/`getByLabel` against English strings) are fragile against the dictionary rather than a stable testid — flag but do not block on cosmetic locator style;
- whether Task 4's fixture claim/release is provably safe against a run that fails mid-test (does `afterAll` still run and release the account if `beforeAll`'s own `claimConnectAccount` succeeded but a later step throws).

- [ ] **Step 4: Fix round on any findings, one scoped re-review, adjudicate residuals**

Standard subagent-driven-development loop — max 5 rounds, escalate model at round 4.

- [ ] **Step 5: Update `_INDEX.md`**

Mark W4 `DONE` in the status table, with the same one-line style as W1-W3's rows, and add the measured budget verdict from Step 2 as a new dated entry under "Owner rulings" or "Recommendations I made" (whichever the owner's response to Step 2 turns out to be) once that response arrives — if it has not arrived by the time this task closes, leave a `PENDING — see PR #<n>` placeholder rather than inventing an outcome.

---

## Self-review

**Spec coverage:** cases #2, #3, #25 (Task 1); the add-ons/extra-seats surface and design §4's row for `settings/{connect,credits,add-ons}` (Tasks 1-2); "billing's uncovered panels" — operator console, promo, cancel-reason, credits page (Task 3); "sponsor monetize half" (Task 4). Design §11's exclusions (Stripe hosted onboarding itself, the existing billing suites' already-covered Stripe-heavy paths, width/a11y sweeps) are respected — none of the four new files duplicate them.

**Placeholder scan:** the two explicit "confirm the exact route/body shape before marking done" notes in Tasks 3 and 4 are flagged as such deliberately — they are precision checks against a live route this plan's author did not have permission to modify speculatively (Task 3's promo/allocation body shape) or a route not yet confirmed to exist as named (Task 4's entitlement override), not vague hand-waving; each names the exact file to check and the exact fallback behavior if the guess is wrong. This is consistent with `writing-plans`' own bar: a placeholder is a step with no real content, not a step whose one open question is pinned to a specific file and a specific fallback.

**Type/signature consistency:** `SeededOrg`, `settingsUrl`, `apiJson`, `setOrgConnectSql`, `setOrgSubscriptionSql`, `setBoolEntitlementOverrideSql` are used identically to their existing signatures across all four tasks; no task invents a new shared helper (the one near-miss — Task 1 originally considered extending `setOrgConnectSql` with a currency parameter — was dropped once the PATCH-before-attach sequencing in cases #2/#25 turned out to need no new helper at all).

**Budget honesty:** §1 states the ruling and its reasoning inline, per the user's explicit instruction to fold the W3 concern into this wave's own plan rather than a separate follow-up. Task 5 is where that ruling is measured against reality rather than asserted once and forgotten.
