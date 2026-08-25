// RS004 — the Registration hub (org-side Settings tab + its row-click config
// panel), driven over a real browser against a real prod build. The PUBLIC
// register page is still in its RS001 closed state until RS006 ships it, so
// this file never asserts on THAT page's content — only on the org-side hub
// itself, and on the VALUE the hub hands a visitor (item 6 below).
//
// Every test seeds its own competition/division through the real API (the
// same fast-setup convention every other spec in this directory uses) and
// then drives the ACTUAL hub UI for the behaviour under test — component/
// integration suites already cover this at the unit level
// (src/components/__tests__/registration-hub-*.test.tsx); this file exists
// to prove the real routes, the real two-endpoint save, and the real DOM
// agree with them end to end.
//
// Selectors used throughout (registration-hub-{division-row,config-panel}.tsx):
//   [data-registration-hub-row][data-division-id]     one Settings-tab row
//   [data-registration-hub-row-configure]              opens that row's panel
//   [data-registration-hub-config-panel][data-division-id]
//   [data-field="<name>"]                              an editable panel input
//   [data-field-error="<name>"]                         that field's own error
//   [data-action="save" | "cancel"]                     panel footer buttons
//   [data-registration-hub-entry]                       the overview nav pill
//   [data-registration-hub-awaiting]                    its amber dot
//   [data-registration-hub-tooltip]                     the hover/focus breakdown
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  loginUi,
  orgTimezoneSql,
  forceFreeAgentsTeamMismatchSql,
} from "./helpers";

const GENERIC_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

const hubPath = (orgSlug: string, compSlug: string) => `/o/${orgSlug}/c/${compSlug}/registration`;
const overviewPath = (orgSlug: string, compSlug: string) => `/o/${orgSlug}/c/${compSlug}`;

/** One competition + one division, through the real API — the same shape
 *  officials-directory.spec.ts / registration-public-api.spec.ts already
 *  seed with. Public/unlisted by default: the public register endpoint
 *  (item 6/7) 404s a private competition, and most tests here don't care
 *  either way, so the permissive default keeps every call site short. */
async function seedDivision(
  request: APIRequestContext,
  opts: { divisionName?: string; visibility?: "public" | "private" | "unlisted" } = {},
): Promise<{ competitionId: string; competitionSlug: string; divisionId: string }> {
  const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Reg Hub ${suffix}`,
    ends_on: "2030-12-31",
    visibility: opts.visibility ?? "public",
  });
  if (comp.status >= 300) throw new Error(`seedDivision: competition create ${comp.status}`);
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: opts.divisionName ?? "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    },
  );
  if (div.status >= 300) throw new Error(`seedDivision: division create ${div.status}`);
  return { competitionId: comp.data!.id, competitionSlug: comp.data!.slug, divisionId: div.data!.id };
}

/** Open a division's row-click config panel and wait past its own async GET
 *  (the panel renders a loading placeholder until that resolves — querying
 *  a field before it lands is an unawaited fetch, not a UI bug, and reads
 *  like one if this isn't done explicitly here).
 *
 *  Returns the DIALOG (`role="dialog"`, Modal's own root), not the inner
 *  `[data-registration-hub-config-panel]` content div — Modal renders
 *  `children` and `footer` as SIBLING divs inside the dialog, so the
 *  Save/Cancel buttons (`data-action`, in `footer`) are not descendants of
 *  the content div at all. Field/field-error queries still resolve fine
 *  from the dialog (they're descendants either way); only the "is this a
 *  banner, not a field error" check below needs the narrower selector. */
async function openConfigPanel(page: Page, divisionId: string): Promise<Locator> {
  const row = page.locator(`[data-registration-hub-row][data-division-id="${divisionId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.locator("[data-registration-hub-row-configure]").click();
  const content = page.locator(`[data-registration-hub-config-panel][data-division-id="${divisionId}"]`);
  await expect(content).toBeVisible({ timeout: 20_000 });
  await expect(content.locator('[data-field="category"]')).toBeVisible({ timeout: 20_000 });
  return page.getByRole("dialog").filter({ has: content });
}

async function save(panel: Locator): Promise<void> {
  await panel.locator('[data-action="save"]').click();
}

/** Expand one accordion section and wait for it to actually be open.
 *
 *  The picked treatment ships Money and Form COLLAPSED, so a `fill()` on a
 *  field inside them resolves a hidden element and times out after 60s with a
 *  message that says nothing about accordions. Clicking the summary is what an
 *  organiser does; doing it here keeps the failure mode legible. */
async function openSection(panel: Locator, id: string): Promise<void> {
  const section = panel.locator(`[data-accordion-section="${id}"]`);
  await expect(section).toHaveCount(1, { timeout: 20_000 });
  if (await section.evaluate((el) => (el as HTMLDetailsElement).open)) return;
  await section.locator("summary").click();
  await expect
    .poll(async () => section.evaluate((el) => (el as HTMLDetailsElement).open), { timeout: 20_000 })
    .toBe(true);
}

/** A banner that is NOT the partial-save notice.
 *
 *  A rejected save legitimately renders one direct-child alert: the
 *  partial-save banner naming which half of the two-endpoint write landed
 *  (it carries `data-save-outcome`). What must never appear is a bannered
 *  copy of a FIELD error — that is the context-free toast these tests exist
 *  to forbid. */
function contextFreeBanner(panel: Locator): Locator {
  return panel.locator(
    '[data-registration-hub-config-panel] > p[role="alert"]:not([data-save-outcome])',
  );
}

test.describe("RS004 registration hub", () => {
  // --- 1. Configure-persist round trip (headline acceptance criterion) -----
  test("configure-persist round trip: category, age band, approval and free agents survive a reload", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "Round Trip" });

    await page.goto(hubPath(org.slug, competitionSlug), { waitUntil: "load" });
    const panel = await openConfigPanel(page, divisionId);

    await panel.locator('[data-field="category"]').selectOption("mixed");
    await panel.locator('[data-field="age_min"]').fill("18");
    await panel.locator('[data-field="age_max"]').fill("35");
    await panel.locator('[data-field="approval"]').selectOption("manual");
    // Free agents is team-only (RS004 decision 1) — switch entrant_kind
    // FIRST, which is what makes the checkbox exist in the DOM at all.
    await panel.locator('[data-field="entrant_kind"]').selectOption("team");
    await panel.locator('[data-field="allow_free_agents"]').check();
    await save(panel);
    await expect(panel).toBeHidden({ timeout: 20_000 });

    await page.reload({ waitUntil: "load" });
    const reopened = await openConfigPanel(page, divisionId);
    await expect(reopened.locator('[data-field="category"]')).toHaveValue("mixed");
    await expect(reopened.locator('[data-field="age_min"]')).toHaveValue("18");
    await expect(reopened.locator('[data-field="age_max"]')).toHaveValue("35");
    await expect(reopened.locator('[data-field="approval"]')).toHaveValue("manual");
    await expect(reopened.locator('[data-field="entrant_kind"]')).toHaveValue("team");
    await expect(reopened.locator('[data-field="allow_free_agents"]')).toBeChecked();
  });

  // --- 2a. 422: inverted age band renders on the field ----------------------
  test("422: an inverted age band renders on the age_max field, not a toast", async ({ page, request }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "Age Band" });

    await page.goto(hubPath(org.slug, competitionSlug), { waitUntil: "load" });
    let panel = await openConfigPanel(page, divisionId);
    await panel.locator('[data-field="age_max"]').fill("18");
    await save(panel);
    await expect(panel).toBeHidden({ timeout: 20_000 });

    // Reopen so the STORED age_max=18 is what the next save patches against
    // — a real organiser session, not a same-request coincidence.
    await page.reload({ waitUntil: "load" });
    panel = await openConfigPanel(page, divisionId);
    await expect(panel.locator('[data-field="age_max"]')).toHaveValue("18");

    // One-sided edit: only age_min is touched. age_max rides along in the
    // wire body unchanged (the panel always sends both — see the full-
    // replace test below) but the ORGANISER only edited the one field.
    await panel.locator('[data-field="age_min"]').fill("25");
    await save(panel);

    const fieldError = panel.locator('[data-field-error="age_max"]');
    await expect(fieldError).toBeVisible({ timeout: 20_000 });
    await expect(fieldError).toContainText("age_max must be greater than or equal to age_min");
    // The banner (`formError`) is a DIRECT child of `[data-registration-hub-
    // config-panel]`; a field error is nested inside a <section><label> —
    // this is what tells "landed on the field" apart from "context-free
    // toast".
    await expect(contextFreeBanner(panel)).toHaveCount(0);
    // The PATCH carrying the age band failed while the settings PUT committed,
    // so the panel must say so rather than implying nothing saved.
    await expect(
      panel.locator('[data-registration-hub-config-panel] > p[data-save-outcome="patch-failed"]'),
    ).toHaveCount(1);
    await expect(panel).toBeVisible(); // rejected save — panel stays open
  });

  // --- 2b. 422: allow_free_agents on a non-team division ---------------------
  test("422: allow_free_agents on a non-team division renders on the field, not a toast", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, {
      divisionName: "Free Agents Guard",
    });

    // A valid combo first, through the real API (team + allow_free_agents) —
    // the same shape the panel itself would PUT — so registration_settings
    // has a row before the desync below (updating zero rows would be a rig
    // bug, not the scenario under test).
    const seeded = await apiJson(
      request,
      `/api/v1/divisions/${divisionId}/registration-settings`,
      "PUT",
      { enabled: true, entrant_kind: "team", allow_free_agents: true, fee_cents: 0, approval: "auto" },
    );
    expect(seeded.status).toBeLessThan(300);
    // The UI can never PRODUCE this combo itself — the entrant_kind
    // <select>'s onChange clears allow_free_agents the instant it leaves
    // "team" — so this is the only way to LOAD the panel already
    // inconsistent and prove the re-save 422s against the field.
    await forceFreeAgentsTeamMismatchSql(divisionId);

    await page.goto(hubPath(org.slug, competitionSlug), { waitUntil: "load" });
    const panel = await openConfigPanel(page, divisionId);
    await expect(panel.locator('[data-field="entrant_kind"]')).toHaveValue("individual");
    // isTeam is false, so the checkbox itself is gone — only the hint text
    // stands in its place; the loaded `true` is still in local state.
    await expect(panel.locator('[data-field="allow_free_agents"]')).toHaveCount(0);

    await save(panel);

    const fieldError = panel.locator('[data-field-error="allow_free_agents"]');
    await expect(fieldError).toBeVisible({ timeout: 20_000 });
    await expect(fieldError).toContainText("allow_free_agents requires entrant_kind");
    await expect(contextFreeBanner(panel)).toHaveCount(0);
    // Mirror image of the age-band case: here the settings PUT is the half
    // that failed.
    await expect(
      panel.locator('[data-registration-hub-config-panel] > p[data-save-outcome="put-failed"]'),
    ).toHaveCount(1);
  });

  // --- 3. Full-replace hazard -------------------------------------------------
  test("full-replace hazard: editing one field leaves the others intact after reload", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "Full Replace" });

    await page.goto(hubPath(org.slug, competitionSlug), { waitUntil: "load" });
    let panel = await openConfigPanel(page, divisionId);
    await panel.locator('[data-field="category"]').selectOption("mens");
    await panel.locator('[data-field="capacity"]').fill("40");
    await panel.locator('[data-field="approval"]').selectOption("manual");
    await openSection(panel, "money");
    await panel.locator('[data-field="fee_cents"]').fill("5");
    await panel.locator('[data-field="payment_method_offline"]').check();
    await panel.locator('[data-field="payment_instructions"]').fill("Pay the club treasurer in cash.");
    await save(panel);
    await expect(panel).toBeHidden({ timeout: 20_000 });
    await page.reload({ waitUntil: "load" });

    // PUT /registration-settings replaces the whole row every time — edit
    // ONLY capacity from here. If the panel ever regresses to a partial/diff
    // payload, this is the assertion that would still pass; the reload below
    // proves it stayed a full replace.
    panel = await openConfigPanel(page, divisionId);
    await expect(panel.locator('[data-field="capacity"]')).toHaveValue("40");
    await panel.locator('[data-field="capacity"]').fill("75");
    await save(panel);
    await expect(panel).toBeHidden({ timeout: 20_000 });
    await page.reload({ waitUntil: "load" });

    panel = await openConfigPanel(page, divisionId);
    await expect(panel.locator('[data-field="capacity"]')).toHaveValue("75");
    await expect(panel.locator('[data-field="category"]')).toHaveValue("mens");
    await expect(panel.locator('[data-field="approval"]')).toHaveValue("manual");
    // "5.00", not "5": the fee field is a text input with a decimal draft and
    // an onBlur normalise (the number-input version could not accept "12.50" —
    // at the intermediate "12." a number input reports value === "", which
    // clobbered the keystroke). Normalising to 2dp is the visible half of that
    // fix, so this assertion pins it rather than tolerating either form.
    await expect(panel.locator('[data-field="fee_cents"]')).toHaveValue("5.00");
    await expect(panel.locator('[data-field="payment_method_offline"]')).toBeChecked();
    await expect(panel.locator('[data-field="payment_instructions"]')).toHaveValue(
      "Pay the club treasurer in cash.",
    );
  });

  // --- 4. Windows are org-timezone -------------------------------------------
  test("registration windows round-trip in the ORG timezone, with the zone labelled", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const originalTz = await orgTimezoneSql(org.id);
    // Pacific/Auckland: a large, unambiguous offset from this runner's own
    // zone (Europe/London) in either direction — the assertion this test
    // exists for (a browser-local regression) would otherwise land on a
    // coincidentally-correct value if the two zones were ever close.
    const TZ = "Pacific/Auckland";
    const expectZone = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, timeZoneName: "short" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")!.value;

    try {
      const patched = await apiJson(page.request, `/api/orgs/${org.id}`, "PATCH", { timezone: TZ });
      expect(patched.status).toBeLessThan(300);

      const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "TZ Window" });
      await page.goto(hubPath(org.slug, competitionSlug), { waitUntil: "load" });
      let panel = await openConfigPanel(page, divisionId);

      await expect(panel).toContainText(expectZone);
      await panel.locator('[data-field="opens_at"]').fill("2026-09-01T14:00");
      await panel.locator('[data-field="closes_at"]').fill("2026-09-10T09:30");
      await save(panel);
      await expect(panel).toBeHidden({ timeout: 20_000 });

      await page.reload({ waitUntil: "load" });
      panel = await openConfigPanel(page, divisionId);
      // Same wall-clock string back out — a regression that swapped either
      // conversion direction to browser-local would shift this by the
      // London/Auckland offset instead of round-tripping exactly.
      await expect(panel.locator('[data-field="opens_at"]')).toHaveValue("2026-09-01T14:00");
      await expect(panel.locator('[data-field="closes_at"]')).toHaveValue("2026-09-10T09:30");
      await expect(panel).toContainText(expectZone);
    } finally {
      await apiJson(page.request, `/api/orgs/${org.id}`, "PATCH", { timezone: originalTz });
    }
  });

  // --- 5. Guard: viewer and scorer both 404, nav entry absent -----------------
  test("guard: a viewer and a scorer both 404 on the hub, and see no nav entry", async ({ browser }) => {
    // A FRESH, throwaway org (not the shared Pro org) — scorer.spec.ts's own
    // comment records that the shared org's scorers.max entitlement is 1 and
    // that spec (the SERIAL project) already claims that one seat; e2e-
    // parallel and e2e-serial are independent CI jobs with no `needs:`
    // between them, so a second scorer-consuming test in this (parallel)
    // spec racing it there is a real, repeatable way to break both. A
    // brand-new org has zero pre-existing scorer members, so its own
    // scorers.max pool (1 on every plan, including community —
    // scorers.test.ts) has full headroom for the one this test needs, with
    // no shared resource at all.
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    try {
      await loginUi(ownerPage, `e2e-reghub-owner-${suffix}@example.com`);
      const org = await activeOrg(ownerPage);
      const comp = await apiJson<{ id: string; slug: string }>(
        ownerPage.request,
        "/api/v1/competitions",
        "POST",
        { name: `Reg Hub Guard ${suffix}`, ends_on: "2030-12-31", visibility: "private" },
      );
      expect(comp.status).toBeLessThan(300);
      const compSlug = comp.data!.slug;

      for (const role of ["viewer", "scorer"] as const) {
        const invite = await apiJson<{ token: string }>(
          ownerPage.request,
          `/api/orgs/${org.id}/invites`,
          "POST",
          { role, max_uses: 1 },
        );
        expect(invite.status, `${role} invite create`).toBeLessThan(300);

        const guestCtx = await browser.newContext();
        const guestPage = await guestCtx.newPage();
        try {
          await loginUi(guestPage, `e2e-reghub-${role}-${suffix}@example.com`);
          const accepted = await guestPage.request.post(`/api/invites/${invite.data!.token}/accept`, {
            data: {},
          });
          expect(accepted.ok(), `${role} invite accept`).toBe(true);

          const res = await guestPage.goto(hubPath(org.slug, compSlug));
          expect(res!.status(), `${role} should 404 on the hub, not redirect or 403`).toBe(404);
          expect(new URL(guestPage.url()).pathname, `${role} should not be redirected off the hub URL`).toBe(
            hubPath(org.slug, compSlug),
          );

          await guestPage.goto(overviewPath(org.slug, compSlug), { waitUntil: "load" });
          await expect(
            guestPage.locator("[data-registration-hub-entry]"),
            `${role} should not see the Registration nav entry`,
          ).toHaveCount(0);
        } finally {
          await guestCtx.close();
        }
      }
    } finally {
      await ownerCtx.close();
    }
  });

  // --- 6. The register link ----------------------------------------------------
  test("register link: the copy control holds the public register URL value", async ({ page, request }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, {
      divisionName: "Register Link",
      visibility: "public",
    });
    // RS004 promotion review finding 3: a closed division no longer renders
    // the register-link controls at all (a closed window would only refuse
    // the visitor). seedDivision alone leaves NO registration_settings row,
    // which coalesces to enabled:false -> status "closed" -- this control
    // only exists to prove the URL VALUE the hub hands out, so it needs a
    // genuinely open division to have anything to assert on.
    const settings = await apiJson(
      request,
      `/api/v1/divisions/${divisionId}/registration-settings`,
      "PUT",
      { enabled: true, entrant_kind: "individual", fee_cents: 0, approval: "auto" },
    );
    expect(settings.status).toBeLessThan(300);

    await page.goto(hubPath(org.slug, competitionSlug), { waitUntil: "load" });
    const row = page.locator(`[data-registration-hub-row][data-division-id="${divisionId}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });

    const origin = new URL(page.url()).origin;
    const expectedUrl = `${origin}/shared/${org.slug}/${competitionSlug}/register`;

    // The readonly input carries the same `url` CopyLink's own copy()
    // writes to the clipboard — assert the FULL origin+path, not a suffix
    // (a bare path would also satisfy a suffix check and silently stop
    // proving the origin ever populated).
    await expect(row.locator("input[readonly]")).toHaveValue(expectedUrl);

    // Exercise the actual button, not just the value it would copy:
    // CopyLink's copy() calls navigator.clipboard.writeText inside a
    // try/catch that silently no-ops on a denied permission (no toast, no
    // thrown error — the button just never flips to "Copied ✓"), so the
    // grant below is load-bearing, not decoration.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    // NOT getByRole(..., { name: "Copy" }): that locator re-resolves by the
    // button's CURRENT accessible name on every poll, so the instant the
    // click flips the label to "Copied ✓" the query can no longer find the
    // element at all — confirmed with a MutationObserver on a captured DOM
    // reference that the label genuinely does flip; a name-bound locator
    // just can never observe it happening. `hasText: "Cop"` matches the
    // shared prefix of both "Copy" and "Copied ✓", so the same element
    // stays resolvable across the transition.
    const copyButton = row.locator("button", { hasText: "Cop" });
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toHaveText("Copy");
    await copyButton.click();
    await expect(copyButton).toHaveText("Copied ✓");
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(expectedUrl);
  });

  // --- 7. Nav pill counts, including the amber awaiting badge -----------------
  test("nav pill: registered and awaiting-confirmation counts are separated", async ({ page, request }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "Nav Pill" });
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;

    async function submit(who: string) {
      const res = await apiJson<{ entries: { status: string }[] }>(
        request,
        `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
        "POST",
        {
          contact: { name: who, email: `${who.toLowerCase().replace(/\W+/g, "-")}@example.com` },
          privacy_consent: true,
          entries: [
            { division_id: divisionId, entrant_kind: "individual", players: [{ full_name: who }], answers: {} },
          ],
        },
      );
      expect(res.status, JSON.stringify(res.error)).toBe(201);
      return res.data!;
    }

    // Entry 1: approval "auto" + free -> materialises INLINE at submit
    // (registration-submit.ts) -> status "confirmed" immediately.
    let settings = await apiJson(
      request,
      `/api/v1/divisions/${divisionId}/registration-settings`,
      "PUT",
      { enabled: true, entrant_kind: "individual", fee_cents: 0, approval: "auto" },
    );
    expect(settings.status).toBeLessThan(300);
    const confirmed = await submit(`Auto Confirmed ${suffix}`);
    expect(confirmed.entries[0]!.status).toBe("confirmed");

    // Entry 2: flip to manual approval — this one stays "pending".
    settings = await apiJson(
      request,
      `/api/v1/divisions/${divisionId}/registration-settings`,
      "PUT",
      { enabled: true, entrant_kind: "individual", fee_cents: 0, approval: "manual" },
    );
    expect(settings.status).toBeLessThan(300);
    const pending = await submit(`Awaiting Approval ${suffix}`);
    expect(pending.entries[0]!.status).toBe("pending");

    await page.goto(overviewPath(org.slug, competitionSlug), { waitUntil: "load" });
    const entry = page.locator("[data-registration-hub-entry]");
    await expect(entry).toBeVisible({ timeout: 20_000 });
    // The ONE number on the button counts BOTH: card-stats.ts's `registered`
    // is pending|paid|confirmed|waitlisted.
    await expect(entry.locator(".bg-purple-600")).toHaveText(/^2\b/);
    // The amber dot says only THAT something needs the organiser — it carries
    // no number since 2026-08-25, so assert it is there rather than its text.
    await expect(entry.locator("[data-registration-hub-awaiting]")).toBeVisible();
    // The breakdown moved into a hover/focus tooltip. Assert the whole round
    // trip — hidden at rest, revealed on hover — because a panel that renders
    // its lines but never becomes visible would satisfy a text-only check.
    const tooltip = page.locator("[data-registration-hub-tooltip]");
    await expect(tooltip).toBeHidden();
    await entry.hover();
    await expect(tooltip).toBeVisible();
    // 2 registered - 1 awaiting = 1 confirmed, and the strict subset still
    // needing the organiser is the pending one.
    await expect(tooltip).toContainText("1 confirmed");
    await expect(tooltip).toContainText("1 awaiting confirmation");
    // The tooltip is aria-hidden, so the link's own accessible name is the
    // only path a screen reader has to the same breakdown.
    // Leads with the VISIBLE number (WCAG 2.5.3, Label in Name) and then the
    // breakdown — 2 on the button, 1 confirmed + 1 awaiting behind it.
    await expect(entry).toHaveAttribute(
      "aria-label",
      /2 registrants.*1 confirmed.*1 awaiting confirmation/,
    );
  });
});
