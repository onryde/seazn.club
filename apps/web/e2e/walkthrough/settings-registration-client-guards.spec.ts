import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  seedCompetition,
  releaseCompetition,
  seedDivision,
  releaseDivision,
  type SeededOrg,
  type SeededCompetition,
} from "../settings-support";
import { apiJson, planCapSql, setOrgConnectSql } from "../helpers";
import { routes } from "../../src/lib/routes";

/**
 * W7 of the settings walkthrough programme — the registration hub's config
 * panel (`/o/{org}/c/{comp}/registration`, the Settings tab's row-click
 * modal), driven for the three CLIENT-side behaviours no API-only spec can
 * see:
 *
 *  - case #20: the card-fee-minimum gate is real, not vacuous — it blocks the
 *    save before any network write, so the organiser learns about the problem
 *    without a round trip;
 *  - case #24: a real double-tap on Save fires ONE save cycle, not two;
 *  - case #23: this panel writes through TWO endpoints in parallel
 *    (`Promise.allSettled` over PATCH `/divisions/{id}` and PUT
 *    `.../registration-settings`, `use-registration-hub-config.ts`), so one
 *    half can land while the other is refused. An over-limit capacity is the
 *    cheapest way to put the pair in exactly that state and prove the panel
 *    reports it honestly instead of claiming a whole save.
 *
 * `registration-hub.spec.ts` (RS004, `e2e/`) drives the same surface for a
 * different programme. Its `openConfigPanel`/`openSection` helpers are
 * deliberately RE-DECLARED here rather than imported: it is a spec file, not
 * a shared helper module, and the `walkthrough` project's `testMatch` refuses
 * a spec importing a spec. Seeding differs too — this file uses this
 * programme's `seedSettingsOrg`/`seedCompetition`/`seedDivision`, so its org
 * is its own and its plan is known.
 *
 * `mode: "default"`, not `serial`, for the reason every prior wave file in
 * this folder gives: `fullyParallel: true` plus `--workers=3` would run
 * `beforeAll` (and so `seedSettingsOrg`) once per worker against a shared Pro
 * user capped at five owned orgs, and `serial` would abort every later test on
 * the first red (AGENTS.md failure class 21).
 */
test.describe.configure({ mode: "default" });

/**
 * Copy read from the dictionary the page renders from, never retyped here —
 * this folder's own idiom (`settings-schedule-drive.spec.ts:36`).
 */
const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
function ui(key: string): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en ui dictionary key: ${key}`);
  return raw;
}

const L = {
  /** The CLIENT-side card-fee rule's message (`validationMessage`,
   *  registration-hub-config-panel.tsx:94-95, keyed off
   *  `validateConfigState`'s "cardFeeMinimum" issue). Deliberately NOT the
   *  server's own 422 string ("Card entry fees must be at least 1.00 (or 0
   *  for free)", registrations.ts) — those two are different sentences, and
   *  telling them apart is exactly what makes case #20's assertion able to
   *  witness a client gate that has stopped firing. */
  cardFeeMinimum: ui("reg.hub.config.cardFeeMinimumError"),
};

/**
 * The server's plan-limit refusal (`putRegistrationSettings`,
 * `usecases/registrations.ts`) — a bare `HttpError(422, ...)` message string,
 * not a dictionary key, rendered verbatim by the panel because `mapSaveError`
 * routes it to the `capacity` field with its own message. The LIMIT is
 * interpolated, so it is read from the live plan matrix at run time rather
 * than typed in here (helpers' `planCapSql`, the same source of truth
 * `pricing-v3.spec.ts` uses for the pricing table).
 */
function capacityOverLimitMessage(limit: number): string {
  return `Capacity exceeds your plan's entrant limit (${limit})`;
}

/** `PutRegistrationSettings`' own capacity ceiling, mirrored client-side by
 *  `validateConfigState`'s CAPACITY_MAX (registration-hub-config-state.ts).
 *  A plan limit at or above this could not be exceeded without tripping the
 *  CLIENT gate first, which would make case #23 test the wrong guard. */
const CAPACITY_MAX = 10_000;

/** How long case #24 holds the save's PUT open, so the second tap of a
 *  double-tap lands while the panel is still `busy`. Comfortably longer than
 *  the two Playwright round trips between the clicks, and well inside the
 *  60s test budget. */
const SAVE_HOLD_MS = 1_500;

// ---------------------------------------------------------------------------

let org: SeededOrg;
let comp: SeededCompetition;
/** The live `entrants.per_division.max` grant for the plan this file seeds. */
let entrantLimit: number;

test.beforeAll(async ({ browser }) => {
  // Its own context, not the `request` fixture — `seedSettingsOrg` moves the
  // `seazn_org` cookie of whatever jar it is handed, and a per-test fixture's
  // jar is not the one any test gets anyway (settings-support.ts, and every
  // prior wave file's own beforeAll follows this exact shape).
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { plan: "pro", label: "W7-guards" });
    comp = await seedCompetition(ctx.request, org.orgId, {});
    // Case #20 cannot even REACH the card-fee rule without this. The card
    // payment-method radio is `disabled={cardUnavailable}` where
    // `cardUnavailable = !chargesEnabled || cardUnsupportedCurrency !== null`
    // (registration-hub-config-panel.tsx:979), and a freshly seeded org has no
    // Connect account at all — so `.check()` on it times out on actionability
    // and the test fails for a reason that has nothing to do with the guard
    // under test. Express onboarding cannot run in e2e; helpers' SQL flip is
    // the repo's standing substitute, and this file never mints a charge, so
    // the fabricated account id it writes is never dialled.
    await setOrgConnectSql(org.orgId, true);
  } finally {
    await ctx.close();
  }

  // Read the plan's entrant cap out of the live matrix, so a repricing moves
  // this test with it instead of leaving it asserting yesterday's number
  // (AGENTS.md failure class 19).
  const cap = await planCapSql("entrants.per_division.max", "pro");
  expect(
    cap,
    "entrants.per_division.max must be a FINITE cap on the plan this file seeds — a null/absent grant means unlimited, and case #23 has no over-limit capacity to send",
  ).toEqual(expect.any(Number));
  entrantLimit = cap as number;
  expect(
    entrantLimit,
    `the plan cap (${entrantLimit}) must sit below the panel's own CAPACITY_MAX (${CAPACITY_MAX}) or the CLIENT gate refuses first and case #23 tests the wrong guard`,
  ).toBeLessThan(CAPACITY_MAX);
});

test.afterAll(async ({ browser }) => {
  // Guarded independently, never `comp.id` as the first line unconditionally:
  // if `seedCompetition` throws after `seedSettingsOrg` already succeeded,
  // `comp` stays `undefined` and an unguarded read here would throw before
  // `releaseSettingsOrg` ever runs — leaking the org (one of the shared Pro
  // user's five owner slots) for the rest of the leg.
  const ctx = await browser.newContext();
  try {
    if (comp) await releaseCompetition(ctx.request, comp.id);
    if (org) await releaseSettingsOrg(ctx.request, org);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// File-local panel helpers. Same selector strategy as
// `registration-hub.spec.ts:88-119`, re-declared for the reason the header
// gives.
// ---------------------------------------------------------------------------

/**
 * Open a division's row-click config panel and wait past its own async GET
 * (the panel renders a loading placeholder until that resolves — querying a
 * field before it lands is an unawaited fetch, not a UI bug).
 *
 * Returns the DIALOG (`role="dialog"`, Modal's own root), not the inner
 * `[data-registration-hub-config-panel]` content div: Modal renders
 * `children` and `footer` as SIBLING divs, so `[data-action="save"]` is not a
 * descendant of the content div at all.
 */
async function openConfigPanel(page: Page, divisionId: string): Promise<Locator> {
  const row = page.locator(`[data-registration-hub-row][data-division-id="${divisionId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.locator("[data-registration-hub-row-configure]").click();
  const content = page.locator(
    `[data-registration-hub-config-panel][data-division-id="${divisionId}"]`,
  );
  await expect(content).toBeVisible({ timeout: 20_000 });
  await expect(content.locator('[data-field="category"]')).toBeVisible({ timeout: 20_000 });
  return page.getByRole("dialog").filter({ has: content });
}

/**
 * Expand one accordion section and wait for it to actually be open. `money`
 * and `form` ship COLLAPSED (`DEFAULT_OPEN`,
 * registration-hub-config-panel.tsx:108-114), so a `fill()` on a field inside
 * them resolves a hidden element and times out with a message that says
 * nothing about accordions. `eligibility`/`schedule`/`capacity` are open
 * already, which is why the capacity test below never calls this.
 */
async function openSection(panel: Locator, id: string): Promise<void> {
  const section = panel.locator(`[data-accordion-section="${id}"]`);
  await expect(section).toHaveCount(1, { timeout: 20_000 });
  if (await section.evaluate((el) => (el as HTMLDetailsElement).open)) return;
  await section.locator("summary").click();
  await expect
    .poll(async () => section.evaluate((el) => (el as HTMLDetailsElement).open), { timeout: 20_000 })
    .toBe(true);
}

/** Count every save-side PUT this page issues, from the moment it is armed. */
function countSettingsPuts(page: Page): () => number {
  let count = 0;
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes("/registration-settings")) count += 1;
  });
  return () => count;
}

/** The registration hub's Settings tab (its landing tab). */
function hubPath(): string {
  return routes.competitionRegistration(org.slug, comp.slug);
}

/** The row as the SERVER sees it — never the closed modal's stale local echo. */
async function readSettings(
  request: APIRequestContext,
  divisionId: string,
): Promise<{ capacity: number | null }> {
  const res = await apiJson<{ capacity: number | null }>(
    request,
    `/api/v1/divisions/${divisionId}/registration-settings`,
    "GET",
  );
  expect(res.status, `GET .../registration-settings: ${JSON.stringify(res.error)}`).toBe(200);
  expect(res.data, "registration-settings GET must carry a row").toBeDefined();
  return res.data!;
}

// ---------------------------------------------------------------------------

test.describe("registration settings — client guards and the plan-limit race", () => {
  test("case #20: a below-minimum card fee blocks the save before any network write", async ({
    page,
    request,
  }) => {
    const div = await seedDivision(request, comp.id);
    try {
      await page.goto(hubPath(), { waitUntil: "load" });
      const panel = await openConfigPanel(page, div.id);
      await openSection(panel, "money");

      const puts = countSettingsPuts(page);
      // 0.50 of the org's currency = 50 cents, under Stripe's 100-cent
      // minimum charge and so under the panel's CARD_FEE_CENTS_MIN. The fee
      // input is `type="text" inputMode="decimal"` (a number input sanitises
      // an in-progress "12." to "" mid-keystroke), so it takes the decimal
      // string an organiser actually types.
      await panel.locator('[data-field="fee_cents"]').fill("0.50");
      await panel.locator('[data-field="payment_method_stripe"]').check();
      await panel.locator('[data-action="save"]').click();

      const fieldError = panel.locator('[data-field-error="fee_cents"]');
      await expect(fieldError).toBeVisible({ timeout: 20_000 });
      // Checked BEFORE the text below, deliberately: a broken client gate
      // still renders a fee_cents error (the server refuses the same fee with
      // its own 422), so "before any network write" is the claim that
      // separates the two states and it has to be the one that fails first.
      expect(puts(), "the card-fee gate must refuse BEFORE the network write").toBe(0);
      // The CLIENT sentence, not the server's. The two are different
      // sentences, so this also fails if the message ever comes back from the
      // wire instead of the dictionary.
      await expect(fieldError).toHaveText(L.cardFeeMinimum);
      // The panel stays open on a refused save — nothing was written, so
      // closing it would read as a save that happened.
      await expect(panel).toBeVisible();
    } finally {
      await releaseDivision(request, div.id);
    }
  });

  test("case #24: a rapid second click on Save does not fire two save cycles", async ({
    page,
    request,
  }) => {
    const div = await seedDivision(request, comp.id);
    try {
      await page.goto(hubPath(), { waitUntil: "load" });
      const panel = await openConfigPanel(page, div.id);

      // Hold the PUT open long enough that the second tap lands INSIDE the
      // save, which is the only window the guard exists for. Without this the
      // save can complete against a local server before the second click is
      // even dispatched, and the test proves nothing either way — a real
      // double-tap is a slow-network phenomenon, so slowing the network is the
      // scenario, not a workaround for it.
      await page.route("**/registration-settings", async (route) => {
        if (route.request().method() !== "PUT") return route.fallback();
        await new Promise((resolve) => setTimeout(resolve, SAVE_HOLD_MS));
        await route.continue();
      });

      const puts = countSettingsPuts(page);
      await panel.locator('[data-field="category"]').selectOption("mens");
      const saveBtn = panel.locator('[data-action="save"]');
      // Two taps, back to back. `click()` resolves once the event is
      // DISPATCHED, not once the app finishes saving, so the second tap still
      // lands mid-save — and awaiting the first is required, not optional:
      // `Promise.all([click(), click({force:true})])` deadlocks, because the
      // forced click wins the race, `disabled={busy}` goes up, and the
      // un-forced click then waits out the whole test budget on an
      // actionability check that can never pass.
      //
      // `force` on the SECOND is what makes the assertion mean something:
      // Playwright's own actionability check refuses to click a `disabled`
      // button by itself, so an un-forced second click would prove only that
      // Playwright works, never that the APPLICATION guards the second tap.
      // Forced, the click is dispatched regardless, and the browser's refusal
      // to raise a click event on a disabled control is `disabled={busy}`
      // (registration-hub-config-panel.tsx:441) doing its job.
      await saveBtn.click();
      await saveBtn.click({ force: true });

      // A whole save cycle ran: both halves succeeded, so `onSaved()` closed
      // the modal. Waiting on that (rather than a bare sleep) is also what
      // gives a second, later PUT time to show up in the count below.
      await expect(panel).toBeHidden({ timeout: 20_000 });
      expect(puts(), "one tap, one save cycle").toBe(1);
    } finally {
      await releaseDivision(request, div.id);
    }
  });

  test("case #23: an over-limit capacity fails the PUT while the concurrent PATCH succeeds", async ({
    page,
    request,
  }) => {
    const div = await seedDivision(request, comp.id);
    try {
      await page.goto(hubPath(), { waitUntil: "load" });
      const panel = await openConfigPanel(page, div.id);

      // PATCH side: a valid, unrelated eligibility edit. `age_min`/`age_max`
      // live on `divisions`, written by PATCH /divisions/{id} — the OTHER
      // half of this panel's two-endpoint save.
      await panel.locator('[data-field="age_min"]').fill("8");
      await panel.locator('[data-field="age_max"]').fill("99");
      // PUT side: one above the live plan cap. `capacity` is the only control
      // in the `capacity` section (SECTION_FIELDS, registration-hub-config-
      // panel-sections.ts) and maps straight to the PUT body's `capacity`
      // (`toRegistrationSettingsPutBody`) — the panel has no separate
      // entrant-limit control.
      await panel.locator('[data-field="capacity"]').fill(String(entrantLimit + 1));
      await panel.locator('[data-action="save"]').click();

      // `put-failed` is named by what FAILED (`SaveOutcome`,
      // use-registration-hub-config.ts) — i.e. the PATCH landed and the PUT
      // did not, which is precisely the half-save this case exists for.
      await expect(
        panel.locator('[data-registration-hub-config-panel] > p[data-save-outcome="put-failed"]'),
      ).toHaveCount(1, { timeout: 20_000 });
      const fieldError = panel.locator('[data-field-error="capacity"]');
      await expect(fieldError).toBeVisible();
      await expect(fieldError).toContainText(capacityOverLimitMessage(entrantLimit));
      // A rejected save keeps the panel open — the organiser still has an
      // unsaved capacity to fix.
      await expect(panel).toBeVisible();

      // The PATCH half genuinely landed (the point of case #23): reload, and
      // the age band is there.
      await page.reload({ waitUntil: "load" });
      const reopened = await openConfigPanel(page, div.id);
      await expect(reopened.locator('[data-field="age_min"]')).toHaveValue("8");
      await expect(reopened.locator('[data-field="age_max"]')).toHaveValue("99");

      // And the PUT half did not: read the row back from the SERVER rather
      // than trusting the panel's own local state, which still holds the
      // rejected value. The refusal fires before the upsert, so a division
      // that never had a registration_settings row still has none — GET
      // answers from DEFAULT_SETTINGS, whose capacity is null.
      const read = await readSettings(request, div.id);
      expect(read.capacity, "the refused capacity must not have been stored").toBeNull();
    } finally {
      await releaseDivision(request, div.id);
    }
  });
});
