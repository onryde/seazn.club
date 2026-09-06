import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { seedSettingsOrg, releaseSettingsOrg, type SeededOrg } from "../settings-support";
import {
  aiCreditBalance,
  drainAiCredits,
  joinOrgToGroupSql,
  orgGroupIdSql,
  setOrgSubscriptionSql,
} from "../helpers";
import { CREDIT_PACK_KEYS, creditPackLabel } from "../price-kit";
import { routes } from "../../src/lib/routes";

/**
 * W4 of the settings walkthrough programme — the four billing panels design
 * §11 names as never having been driven: the Credits tab's buy/export
 * affordances, the operator console's per-member allocation editor, the promo
 * box, and the cancel-reason picker.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: complete a purchase, mutate a real
 * subscription, or grant a credit through Stripe (W4 plan §1). Every org this
 * suite can seed carries at most a FIXTURE `stripe_subscription_id` and no
 * Stripe customer at all, so a completion here would not be a purchase — it
 * would be a 5xx on an object that does not exist. What is left is what design
 * §7 Class 1/2 asks for and what `apps/web` vitest (`environment: "node"`)
 * structurally cannot see: which control each panel offers, what it OPENS AT,
 * where its bounds are, and which of the real route's refusals fires.
 *
 * SIX THINGS THE BRIEF FOR THIS FILE GOT WRONG, every one re-checked against
 * the tree rather than assumed (AGENTS.md failure class 5):
 *
 *  0. Neither page is a `?tab=`. `billing` and `credits` are `SettingsNavKey`s
 *     with their own ROUTES (`routes.billing` / `routes.credits`), not
 *     `SettingsTab`s — and `settings/page.tsx` falls an unrecognised `?tab=`
 *     back to "organization" SILENTLY, so `settingsUrl(slug, "credits")` would
 *     have driven the organisation panel while every locator below timed out.
 *     The same trap Task 1 hit on `connect` and Task 2 on `add-ons`.
 *
 *  1. The buy-credits control is `[data-buy-credits]`, not
 *     `getByTestId("buy-credits")`, and clicking it does NOT mount a Stripe
 *     iframe: `buy-credits.tsx` opens a PACK LADDER first, and the embedded
 *     checkout is fetched only after a rung is chosen and `Pay` is pressed.
 *     The affordance under test is therefore the ladder, and this file asserts
 *     that no `stripe.com` iframe is ever mounted.
 *
 *  2. "The CSV export is absent with no history" is true for the pro org, and
 *     it is not the interesting half. `createOrgForUser` bootstraps a monthly
 *     grant onto the new org's wallet — but `seedSettingsOrg`'s Pro path then
 *     calls `splitOrgIntoOwnGroupSql`, which mints a NEW `subscriptions` row,
 *     and `walletIdFor` is `coalesce(subscription_id, id)`: the grant is left
 *     on the abandoned wallet. A seeded COMMUNITY org skips the split and keeps
 *     its grant, which is what gives this file a real positive arm instead of
 *     the brief's recorded gap. The negative arm is then produced from it with
 *     `drainAiCredits`, so both arms are one org and one differential.
 *
 *  3. `PromoCodeBox` and `CancelSubscriptionButton` are NOT both reachable.
 *     Both need `isPayer && isPaid && hasStripeSubscription`; the promo box
 *     additionally needs `overview`, and `getBillingOverview` returns null the
 *     moment `stripe_customer_id` is null (before any Stripe call). So the
 *     promo box cannot be driven by this suite at all, and its route is proven
 *     at the route instead — which is where its refusals live anyway.
 *
 *  4. `POST /api/billing/promo` takes `{ code }` / `{ remove: true }` (checked
 *     against `billing-manage.tsx`'s own `post(...)` calls) and WHICH group it
 *     acts on comes from the `x-seazn-org` header, else the `seazn_org` cookie
 *     (`requireBillingOwner` -> `requestScopedOrgId`). `apiJson` sets no such
 *     header and `seedSettingsOrg` moves that cookie on every seed, so a call
 *     through it would target a test-order-dependent org. Every call below
 *     names its org explicitly.
 *
 *  5. `PUT /api/billing/group/allocation` does take `{ org_id, monthly_cap }`
 *     (the brief's guess was right — confirmed against `operator-console.tsx`'s
 *     own fetch), but a bad body answers **400**, not 422: `handler`'s
 *     `ZodError` branch in `lib/http.ts` returns 400. And the console does not
 *     render for a solo org — `showOperator` requires `members.length > 1`, so
 *     this file builds a real group of two.
 *
 * SELECTORS. `billing-manage.tsx` and `operator-console.tsx` carried no
 * `data-testid` at all, so every control here could only be reached by role or
 * by copy — and the entitlements ladder rewrite is about to move copy on this
 * exact surface, which would break these anchors silently. Six hooks were added
 * with this file (`cancel-subscription`, `cancel-reason`, `promo-box` on all
 * three PromoCodeBox shapes, `allocation-cap`, `allocation-cap-input`,
 * `allocation-save`) and every positive assertion below anchors on them. Two
 * anchors are deliberately NOT testids: the cancel picker's option text, which
 * is derived from the component's own `CANCEL_REASONS` and so already moves
 * with a copy change, and the dictionary strings read through `ui()`, which are
 * the thing under test rather than a way of finding it.
 *
 * `mode: "default"`, matching its sibling settings specs: `serial` would skip
 * every test after the first red, which is the opposite of what a walkthrough
 * is for.
 */
test.describe.configure({ mode: "default" });

/** Copy read from the dictionary the pages render from, never retyped — this
 *  folder's idiom (settings-add-ons-drive.spec.ts:62). */
const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);

/** `t()`'s `{name}` interpolation. Throws on a missing key: a renamed key must
 *  red loudly here rather than resolve to a locator that matches nothing. */
function ui(key: string, vars: Record<string, string | number> = {}): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en dictionary key: ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`));
}

/** `plural()`'s en category pick — `Intl.PluralRules("en")` is `one` at 1 and
 *  `other` everywhere else, including 0. Playwright's default locale is en-US
 *  (pinned in the price-kit parity test), so the runner and the server agree. */
function pluralUi(key: string, count: number): string {
  const cat = new Intl.PluralRules("en").select(count);
  return ui(UI_EN[`${key}.${cat}`] !== undefined ? `${key}.${cat}` : `${key}.other`, { count });
}

/** Budgets expressed in what each test does, never a flat literal beside a
 *  derived cost (AGENTS.md failure class 20). */
const NAV_MS = 20_000;
const API_MS = 6_000;
const budget = (navs: number, apis: number): number =>
  Math.max(60_000, 15_000 + navs * NAV_MS + apis * API_MS);

const READ_MS = 20_000;

/**
 * `CANCEL_REASONS` and the picker's placeholder, read out of the component
 * that declares them.
 *
 * They are module-private literals in `billing-manage.tsx` — not exported, and
 * unreachable by import from this process anyway (a `.tsx` drags `next/link`
 * and `@/lib/i18n`'s `server-only` into the Playwright runtime). Typing "6" (or
 * the five strings) into the spec would make the test assert yesterday's list
 * the day someone adds a reason; parsing the declaration makes the expectation
 * move with the source, and a failed parse throws instead of quietly asserting
 * nothing (AGENTS.md failure class 19).
 *
 * Recorded while reading it: every string in this dialog — the title, the body,
 * "What made you cancel? (optional)", the placeholder and all five reasons — is
 * hardcoded English, on a surface where the rest of the billing page goes
 * through the dictionary. Pre-existing, out of this task's scope, reported to
 * the programme's findings register rather than fixed here.
 */
function cancelPickerFromSource(): { placeholder: string; reasons: string[] } {
  const path = fileURLToPath(new URL("../../src/components/billing-manage.tsx", import.meta.url));
  const src = readFileSync(path, "utf8");
  const block = /const CANCEL_REASONS = \[([\s\S]*?)\] as const;/.exec(src);
  if (!block) throw new Error(`${path}: CANCEL_REASONS literal not found — did it move?`);
  const reasons = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (reasons.length === 0) throw new Error(`${path}: CANCEL_REASONS parsed empty`);
  const placeholder = /<option value="">([^<]+)<\/option>/.exec(src)?.[1];
  if (!placeholder) throw new Error(`${path}: the reason picker's placeholder option not found`);
  return { placeholder, reasons };
}

/**
 * A route path read out of the module that CALLS it.
 *
 * The two wire listeners below are negative-only (`toEqual([])`), and a
 * negative assertion on a hardcoded path goes silently vacuous the day the
 * route is renamed: the listener watches a dead path, sees nothing, and passes
 * forever. Parsing the caller's own literal means a rename either moves the
 * listener with it or throws here. Same reasoning as
 * {@link cancelPickerFromSource}.
 */
function routeFromSource(relPath: string, pattern: RegExp): string {
  const path = fileURLToPath(new URL(relPath, import.meta.url));
  const found = pattern.exec(readFileSync(path, "utf8"))?.[1];
  if (!found) throw new Error(`${path}: no route literal matched ${pattern} — did the call move?`);
  return found;
}

/** The POST `BuyCredits` makes when `Pay` is pressed — the money boundary. */
const CREDIT_PACK_CHECKOUT = routeFromSource(
  "../../src/lib/billing-checkout-client.ts",
  /fetchCreditPackCheckoutClientSecret[\s\S]*?"(\/api\/billing\/[a-z-]+)"/,
);

/** The POST `CancelSubscriptionButton` makes once the confirm resolves true. */
const CANCEL_SUBSCRIPTION = routeFromSource(
  "../../src/components/billing-manage.tsx",
  /function CancelSubscriptionButton[\s\S]*?post\("(\/api\/billing\/[a-z-]+)"/,
);

let org: SeededOrg;

/**
 * Every org seeded INSIDE a test, registered at creation.
 *
 * A test-local `finally` is the fast path and not the guarantee: a Playwright
 * `test.setTimeout` does not unwind the test function, so on a timeout the
 * `finally` never runs — and a leaked seed permanently spends one of the shared
 * Pro user's five owner slots for the rest of the leg. Drained in `afterAll`,
 * which DOES run. Pattern established by settings-add-ons-drive.spec.ts.
 */
const strays: SeededOrg[] = [];

/** Seed an org for one test and register it for the drain in the same breath —
 *  the two must never be separate statements, or a throw between them leaks. */
async function seedStray(
  request: APIRequestContext,
  opts: { plan?: "community" | "pro"; label?: string },
): Promise<SeededOrg> {
  const seeded = await seedSettingsOrg(request, opts);
  strays.push(seeded);
  return seeded;
}

/**
 * Give the group a live-SHAPED paid subscription without Stripe.
 *
 * `hasLiveSubscription` (lib/subscription-status.ts) is `stripe_subscription_id
 * IS NOT NULL` **and** a live status — two columns — and `seedSettingsOrg`'s Pro
 * flip moves neither, so a freshly seeded Pro org renders no manage block at
 * all. The id is a fixture and is never dereferenced: every assertion in this
 * file stops at a guard that runs before any `stripe.subscriptions.*` call, and
 * the one control that would dereference it (Cancel) is dismissed, not
 * confirmed.
 */
async function makeGroupLive(seeded: SeededOrg): Promise<void> {
  await setOrgSubscriptionSql(seeded.orgId, {
    plan_key: "pro",
    status: "active",
    stripe_subscription_id: `sub_e2e_panels_${seeded.orgId.slice(0, 8)}`,
  });
}

/**
 * `POST /api/billing/promo`, naming the org in the header the product's own
 * client seams stamp (`x-seazn-org`, lib/org-scope.ts).
 *
 * Not `apiJson`: besides the header, it types `error` as an object while
 * `handler`'s `HttpError`/`ZodError` branches answer a bare
 * `{ ok: false, error: "<string>" }` — and the STRING is the only thing that
 * separates this route's three different 400s from each other. "Some kind of
 * refusal" is satisfied by a 404 from a path typo, which is how a matrix row
 * silently stops testing anything.
 */
async function postPromo(
  request: APIRequestContext,
  slug: string,
  body: unknown,
): Promise<{ status: number; error: string }> {
  const res = await request.fetch("/api/billing/promo", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-seazn-org": slug },
    data: body,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: unknown };
  return { status: res.status(), error: typeof json.error === "string" ? json.error : "" };
}

interface AllocationMember {
  orgId: string;
  orgName: string;
  monthlyCap: number | null;
  spentThisPeriod: number;
}

/** `PUT /api/billing/group/allocation`. The target org is a BODY field here,
 *  not a header — the route gates on `requireUser` + `subscriptionIsOwnedBy`,
 *  never on the request-scoped org. */
async function putAllocation(
  request: APIRequestContext,
  body: unknown,
): Promise<{ status: number; error: string }> {
  const res = await request.fetch("/api/billing/group/allocation", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    data: body,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: unknown };
  return { status: res.status(), error: typeof json.error === "string" ? json.error : "" };
}

/** The console's own read route — the server's answer, as opposed to the
 *  table's rendering of it. */
async function getAllocation(
  request: APIRequestContext,
): Promise<{ status: number; walletId: string; members: AllocationMember[] }> {
  const res = await request.fetch("/api/billing/group/allocation");
  const json = (await res.json().catch(() => ({}))) as {
    data?: { walletId?: string; members?: AllocationMember[] };
  };
  return {
    status: res.status(),
    walletId: json.data?.walletId ?? "",
    members: json.data?.members ?? [],
  };
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { plan: "pro", label: "W4-panels" });
    await makeGroupLive(org);
  } finally {
    await ctx.close();
  }
});

test.afterAll(async ({ browser }) => {
  // EVERY release lives here, never only in a `finally` inside a test — see the
  // note on `strays`. Each is guarded so one failure cannot strand the rest,
  // and `releaseSettingsOrg` is documented safe to call twice.
  const ctx = await browser.newContext();
  try {
    for (const stray of strays.splice(0)) {
      try {
        await releaseSettingsOrg(ctx.request, stray);
      } catch {
        // best effort; the next stray still gets its turn
      }
    }
    if (org) await releaseSettingsOrg(ctx.request, org);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------

test("the Credits tab's buy control opens the seed's pack ladder, choosing nothing until a rung is picked, and never mounts a checkout", async ({
  page,
}: {
  page: Page;
}) => {
  test.setTimeout(budget(1, 0));

  // The §1 boundary, recorded from the wire: reaching the embedded checkout
  // means POSTing for a client secret, and nothing below may do that.
  //
  // NOT an `iframe[src*="stripe.com"]` count — that was the brief's shape and
  // it is unusable here: Stripe.js is loaded by `stripePromise` as soon as the
  // page's client bundle runs and injects TWO hidden control iframes of its
  // own, so the count is 2 before anything is clicked (measured, 2026-09-06).
  const checkoutPosts: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === CREDIT_PACK_CHECKOUT) checkoutPosts.push(r.method());
  });

  await page.goto(routes.credits(org.slug));
  await expect(
    page.getByRole("heading", { level: 1, name: ui("settings.nav.credits") }),
    "routes.credits must land on the Credits page, not the organisation tab",
  ).toBeVisible({ timeout: READ_MS });

  const trigger = page.locator("[data-buy-credits]").first();
  await expect(trigger).toHaveText(ui("billing.credits.buy"));
  await trigger.click();

  const modal = page.getByRole("dialog");
  await expect(modal.getByText(ui("billing.credits.buyModal.reassurance"))).toBeVisible();

  // MEMBERSHIP AND ORDER, not a count: the modal renders one radio per seed
  // rung and the assertions below pick rungs by index, so a reordered ladder
  // has to be a failure here rather than a silently different price later.
  const rungs = modal.locator('input[name="credit-pack"]');
  expect(
    await rungs.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)),
    "the pack ladder must be exactly stripe-plans.json's packs, in seed order",
  ).toEqual([...CREDIT_PACK_KEYS]);

  // WHAT IT OPENS AT (AGENTS.md failure class 19): nothing preselected, and a
  // pay button that says so and cannot be pressed. A ladder that defaulted to a
  // rung would charge a buyer for a pack they never chose.
  expect(await rungs.evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).checked).length)).toBe(0);
  const pay = modal.getByRole("button", { name: ui("billing.credits.buyModal.choose"), exact: true });
  await expect(pay).toBeDisabled();

  // The LAST rung, deliberately: it is the dearest, so a button that quoted a
  // constant (or always quoted the cheapest) still fails. Derived from the same
  // seed the page prices from, via the parity-guarded kit — never a literal.
  const dearest = CREDIT_PACK_KEYS[CREDIT_PACK_KEYS.length - 1];
  const cheapest = CREDIT_PACK_KEYS[0];
  expect(
    creditPackLabel(dearest),
    "the ladder's ends must differ, or the assertion below cannot witness a wrong quote",
  ).not.toBe(creditPackLabel(cheapest));

  await rungs.last().check();
  const payChosen = modal.getByRole("button", {
    name: ui("billing.credits.buyModal.pay", { price: creditPackLabel(dearest) }),
    exact: true,
  });
  await expect(payChosen).toBeEnabled();

  // Backing out leaves no purchase behind: the ladder closes, the app's own
  // checkout sheet was never rendered, and no client secret was ever asked for.
  await modal.getByRole("button", { name: ui("confirm.cancel"), exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(ui("billing.credits.buyModal.checkoutTitle"))).toHaveCount(0);
  expect(checkoutPosts, "choosing a rung must not start a checkout — Pay does").toEqual([]);
});

test("the credits CSV export appears only once the wallet has ledger history, and the file it serves is the table", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(2, 4));

  // COMMUNITY, and the plan is the point: `seedSettingsOrg`'s Pro path splits
  // the org onto a fresh billing group, which changes `walletIdFor` and strands
  // the bootstrap grant on the abandoned wallet. A community seed keeps it, so
  // this org has real ledger history that nothing in this file wrote.
  const wallet = await seedStray(request, { plan: "community", label: "W4-panels-wallet" });
  try {
    const balance = await aiCreditBalance(wallet.orgId);
    expect(
      balance,
      "a new org is bootstrapped a monthly grant (lib/auth.ts createOrgForUser) — with an empty wallet the positive arm below proves nothing",
    ).toBeGreaterThan(0);

    await page.goto(routes.credits(wallet.slug));
    const credits = page.locator("[data-credits]");
    await expect(credits).toBeVisible({ timeout: READ_MS });

    // The DB's number, rendered. Scoped to the row that carries the "Balance"
    // label so it cannot be satisfied by the same digits in the history table.
    const balanceRow = credits.locator("div.flex.items-baseline").first();
    await expect(balanceRow).toContainText(ui("billing.credits.balance"));
    await expect(balanceRow).toContainText(pluralUi("billing.credits.creditsCount", balance));

    const exportLink = credits.getByRole("link", { name: ui("billing.credits.export") });
    await expect(exportLink).toBeVisible();
    // The export lives under /settings/billing even though the tab moved to
    // /settings/credits — asserted rather than assumed, since a wrong href is a
    // 404 the page itself never shows.
    await expect(exportLink).toHaveAttribute("href", `${routes.billing(wallet.slug)}/credits.csv`);
    await expect(exportLink).toHaveAttribute("download", "");

    const historyRows = credits.locator("table tbody tr");
    const rowCount = await historyRows.count();
    expect(rowCount).toBeGreaterThan(0);

    const csv = await request.get(`${routes.billing(wallet.slug)}/credits.csv`);
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    const lines = (await csv.text()).split("\r\n");
    expect(lines[0]).toBe("date,action,model,change,competition,org");
    // The two agree AT THIS FIXTURE's size, and that is all this pins: the table
    // renders `creditHistory`'s default 50 and the route asks for 1000, so a
    // wallet past 50 rows would legitimately disagree. What it does catch is the
    // export serving a DIFFERENT slice — a wrong wallet, or a dropped row.
    expect(rowCount).toBeLessThan(50);
    expect(lines.length - 1, "the export is the same ledger slice the table drew").toBe(rowCount);

    // Column 3 is `change`; the three before it (date/action/model) never contain
    // a comma, so a quoted org name further right cannot shift it.
    const cells = lines.slice(1).map((l) => l.split(","));
    expect(cells.reduce((sum, c) => sum + Number(c[3]), 0), "the exported deltas ARE the balance").toBe(
      balance,
    );

    // The activity column, against the dictionary. `t()`'s `TKey` accepts ANY
    // string and a missing key RENDERS AS THE DOTTED KEY — tsc, i18n:check and a
    // source scan are all green on that, and only a render catches it. The
    // history's action keys are computed at runtime (`actionKey` in
    // credits-tab.ts), so this is the only gate on them.
    expect(await historyRows.locator("td:nth-child(2)").allInnerTexts()).toEqual(
      cells.map((c) => ui(`billing.credits.action.${c[1]}`)),
    );

    // The differential: same org, same page, ledger emptied. Without this the
    // "appears only once there is history" claim is one arm of a two-arm rule.
    await drainAiCredits(wallet.orgId);
    await page.reload();
    await expect(credits.getByRole("link", { name: ui("billing.credits.export") })).toHaveCount(0);
    await expect(credits.getByText(ui("billing.credits.empty"))).toBeVisible();
    await expect(credits.locator("div.flex.items-baseline").first()).toContainText(
      pluralUi("billing.credits.creditsCount", 0),
    );
  } finally {
    await releaseSettingsOrg(request, wallet);
  }
});

test("the cancel dialog opens on no reason and offers exactly the reasons the component declares — and dismissing it posts nothing", async ({
  page,
}: {
  page: Page;
}) => {
  test.setTimeout(budget(1, 0));

  const { placeholder, reasons } = cancelPickerFromSource();
  expect(reasons.length, "a picker with no reasons would satisfy every assertion below").toBeGreaterThan(0);

  // Proof that backing out spends nothing, recorded from the wire rather than
  // inferred: a confirm that fell through would POST here.
  const cancelPosts: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === CANCEL_SUBSCRIPTION) cancelPosts.push(r.method());
  });

  await page.goto(routes.billing(org.slug));
  const cancelButton = page.getByTestId("cancel-subscription");
  await expect(
    cancelButton,
    "the manage block needs isPayer && isPaid && a live subscription — see makeGroupLive",
  ).toBeVisible({ timeout: READ_MS });
  await cancelButton.click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const picker = dialog.getByTestId("cancel-reason");
  // WHAT IT OPENS AT: no reason chosen. The reason is optional and is sent as
  // `undefined` when blank, so a preselected first reason would file every
  // cancellation under "Season finished".
  await expect(picker).toHaveValue("");

  const options = picker.locator("option");
  expect(
    await options.evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value)),
    "the picker's VALUES are what /api/billing/cancel receives as `reason`",
  ).toEqual(["", ...reasons]);
  expect(await options.allInnerTexts()).toEqual([placeholder, ...reasons]);

  // Esc cancels (confirm-provider.tsx), resolving the promise false — so `go()`
  // returns before the POST.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(cancelPosts, `dismissing the dialog must not touch ${CANCEL_SUBSCRIPTION}`).toEqual([]);
  await expect(cancelButton).toBeVisible();
});

test("the promo route refuses three distinct ways before it can reach Stripe, and the box is absent while the Stripe read is", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(1, 5));

  // No code at all. The schema accepts the body (`code` optional, `remove`
  // defaulted), so this is the HANDLER's own guard, not validation.
  const empty = await postPromo(request, org.slug, {});
  expect(empty.status).toBe(400);

  // A well-formed code on a group with no Stripe customer: `requireCustomer`
  // refuses before `stripe.promotionCodes.list` is ever called, which is why
  // this is reachable at all without money.
  const noCustomer = await postPromo(request, org.slug, { code: "WELCOME10" });
  expect(noCustomer.status).toBe(400);

  // The remove arm takes the same guard — asserted separately because the two
  // arms are different code paths that happen to share a refusal.
  const remove = await postPromo(request, org.slug, { remove: true });
  expect(remove.status).toBe(400);
  expect(remove.error).toBe(noCustomer.error);

  // Validation, not a handler guard: an empty and an over-long code are both
  // Zod rejections, and `handler`'s ZodError branch answers 400 (NOT 422).
  const blank = await postPromo(request, org.slug, { code: "" });
  const tooLong = await postPromo(request, org.slug, { code: "X".repeat(51) });
  expect(blank.status).toBe(400);
  expect(tooLong.status).toBe(400);
  expect(tooLong.error).toBe(blank.error);

  // Three DIFFERENT sentences, so this file is testing three branches rather
  // than one status code five times. Every message is non-empty: a bare
  // `{ ok:false }` would collapse the set to one and pass a set-size check.
  const messages = [empty.error, noCustomer.error, blank.error];
  expect(messages.every((m) => m.length > 0), `promo refusals were ${JSON.stringify(messages)}`).toBe(
    true,
  );
  expect(new Set(messages).size).toBe(3);

  // The UI half, with its positive pair so an absence cannot come from a blank
  // page: the manage block IS rendered, and the promo box still is not —
  // `PromoCodeBox` is gated on `overview`, and `getBillingOverview` returns null
  // the moment `stripe_customer_id` is null. Recorded, not filed as a defect: a
  // group that completed checkout has a customer and gets the box.
  //
  // HONEST LIMIT, stated rather than hidden: a `toHaveCount(0)` on a testid is
  // satisfied by that testid being DELETED, so this half cannot witness the
  // hook's own removal. `promo-box` is on all three of PromoCodeBox's shapes
  // precisely so the wave that can render one — a group with a live Stripe
  // customer — has a positive pair to write against it.
  await page.goto(routes.billing(org.slug));
  await expect(page.getByTestId("cancel-subscription")).toBeVisible({ timeout: READ_MS });
  await expect(page.getByTestId("promo-box")).toHaveCount(0);
});

test("the operator console opens a member at its real cap, refuses a negative or fractional one, and a saved cap reaches the route", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(1, 12));

  // A group of TWO. `showOperator` is `members.length > 1`, so a solo org never
  // sees this panel at all — the console cannot be driven without building the
  // shape it exists for. Its own org, then moved onto the beforeAll org's bill
  // exactly as an attach would leave it (joinOrgToGroupSql, no Stripe).
  const member = await seedStray(request, { plan: "community", label: "W4-panels-member" });
  try {
    await joinOrgToGroupSql(member.orgId, await orgGroupIdSql(org.orgId));

    // ---- the route's own bounds, none of which write anything ---------------
    const negative = await putAllocation(request, { org_id: member.orgId, monthly_cap: -1 });
    expect(negative.status, "a negative cap is a Zod rejection -> 400").toBe(400);
    const fractional = await putAllocation(request, { org_id: member.orgId, monthly_cap: 1.5 });
    expect(fractional.status, "credits are whole -> 400").toBe(400);
    // An org id that names NOTHING — `setOrgAllocation`'s own first guard, which
    // 404s before it ever reaches the payer check. Deliberately not the 403 arm
    // (an org in someone ELSE's group): that needs a second identity and is
    // already covered where the sibling group routes are gated.
    const stranger = await putAllocation(request, { org_id: randomUUID(), monthly_cap: 5 });
    expect(stranger.status, "an unknown org is refused, never upserted into existence").toBe(404);

    // The clear arm, which DOES write: an explicit NULL row, not a delete. Run
    // before the UI so the editor's opening state below is one this test set.
    const cleared = await putAllocation(request, { org_id: member.orgId, monthly_cap: null });
    expect(cleared.status).toBe(200);

    // `allocationConsole` resolves the payer's group with the MOST live orgs, and
    // the shared Pro user owns several one-org groups. Assert we got OURS before
    // reading anything off the table, so a foreign group is a legible failure
    // rather than a silently different set of rows.
    const before = await getAllocation(request);
    expect(before.status).toBe(200);
    expect(
      before.members.map((m) => m.orgId).sort(),
      `allocation console resolved to ${JSON.stringify(before.members.map((m) => m.orgName))}, expected this file's pair`,
    ).toEqual([org.orgId, member.orgId].sort());
    expect(before.members.find((m) => m.orgId === member.orgId)?.monthlyCap).toBeNull();

    // ---- the editor --------------------------------------------------------
    await page.goto(routes.billing(org.slug));
    const console_ = page.locator("[data-operator-console]");
    await expect(console_, "a group of two must render the operator console").toBeVisible({
      timeout: READ_MS,
    });
    const row = console_.locator("tbody tr").filter({ hasText: member.name });
    await expect(row).toHaveCount(1);

    // WHAT THE ROW OPENS AT: the null cap set above, rendered as Unlimited.
    const capButton = row.getByTestId("allocation-cap");
    await expect(capButton).toContainText(ui("billing.operator.unlimited"));
    await capButton.click();

    const editor = page.getByRole("dialog");
    await expect(editor).toContainText(ui("billing.operator.editor.title", { org: member.name }));
    const modes = editor.locator('input[name="cap-mode"]');
    await expect(modes.first(), "the editor must open on the member's CURRENT mode").toBeChecked();
    const capField = editor.getByTestId("allocation-cap-input");
    await expect(capField).toHaveValue("");
    // The accessible name is still asserted, separately from the hook that finds
    // the field: a testid makes the control reachable, it does not make it
    // labelled, and dropping the `aria-label` would leave axe's own gate to
    // catch a control this file had stopped watching.
    await expect(capField).toHaveAttribute("aria-label", ui("billing.operator.editor.capLabel"));
    const save = editor.getByTestId("allocation-save");
    // Same split as the cap field above: the hook FINDS it, the dictionary says
    // what it must read. A testid is not an accessible name.
    await expect(save).toHaveText(ui("billing.operator.editor.save"));
    // Disabled because nothing CHANGED yet — the unchanged bound, distinct from
    // the invalid bound below, which is why both are asserted.
    await expect(save).toBeDisabled();
    await expect(editor.getByText(ui("billing.operator.editor.invalid"))).toHaveCount(0);

    await capField.fill("-1");
    await expect(editor.getByText(ui("billing.operator.editor.invalid"))).toBeVisible();
    await expect(save, "a negative cap must not be savable from the UI either").toBeDisabled();

    await capField.fill("1.5");
    await expect(editor.getByText(ui("billing.operator.editor.invalid"))).toBeVisible();
    await expect(save).toBeDisabled();

    // A cap that is neither 0 nor the null it opened at, so neither a stuck
    // default nor a dropped write can pass.
    await capField.fill("250");
    await expect(editor.getByText(ui("billing.operator.editor.invalid"))).toHaveCount(0);
    await expect(save).toBeEnabled();
    await save.click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row.getByTestId("allocation-cap")).toContainText("250");
    await expect(row).toContainText(ui("billing.operator.ofCap", { cap: 250 }));

    // RE-OPEN, and this is the arm that makes "opens on the member's current
    // mode" mean anything. `AllocationEditor` seeds itself from props
    // (`useState(member.monthlyCap === null)` / `useState(String(cap))`), so the
    // first open above happens to agree with the component's hardcoded DEFAULT —
    // `useState(true)` and `useState("")` both survive it. This member now holds
    // 250 in the console's own state (`onSaved`), so a defaulted editor is a
    // different answer from a seeded one (AGENTS.md failure class 19).
    await capButton.click();
    const reopened = page.getByRole("dialog");
    await expect(
      reopened.locator('input[name="cap-mode"]').nth(1),
      "re-opening a capped member must arm the LIMITED radio, not the default unlimited one",
    ).toBeChecked();
    await expect(reopened.getByTestId("allocation-cap-input")).toHaveValue("250");
    await reopened.getByRole("button", { name: ui("confirm.cancel"), exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The server's answer, not the table's optimistic one: `onSaved` updates
    // local state, so the row above would read 250 even if the PUT had been
    // dropped. This is the only assertion that proves the cap was persisted.
    const after = await getAllocation(request);
    expect(after.members.find((m) => m.orgId === member.orgId)?.monthlyCap).toBe(250);
  } finally {
    await releaseSettingsOrg(request, member);
  }
});
