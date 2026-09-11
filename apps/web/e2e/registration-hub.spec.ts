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
import {
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  loginUi,
  orgTimezoneSql,
  forceFreeAgentsTeamMismatchSql,
  seedBareRegistrationSql,
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
      // Two controls per window since the fields moved onto the shared
      // DateTimeField (the time-step sweep): a date <input> and a time
      // <select> off the quarter-hour grid. Addressed by the suffixed hooks,
      // never by a bare `opens_at` — that would be half a value.
      await panel.locator('[data-field="opens_at_date"]').fill("2026-09-01");
      await panel.locator('[data-field="opens_at_time"]').selectOption("14:00");
      await panel.locator('[data-field="closes_at_date"]').fill("2026-09-10");
      await panel.locator('[data-field="closes_at_time"]').selectOption("09:30");
      await save(panel);
      await expect(panel).toBeHidden({ timeout: 20_000 });

      await page.reload({ waitUntil: "load" });
      panel = await openConfigPanel(page, divisionId);
      // Same wall-clock string back out — a regression that swapped either
      // conversion direction to browser-local would shift this by the
      // London/Auckland offset instead of round-tripping exactly.
      await expect(panel.locator('[data-field="opens_at_date"]')).toHaveValue("2026-09-01");
      await expect(panel.locator('[data-field="opens_at_time"]')).toHaveValue("14:00");
      await expect(panel.locator('[data-field="closes_at_date"]')).toHaveValue("2026-09-10");
      await expect(panel.locator('[data-field="closes_at_time"]')).toHaveValue("09:30");
      await expect(panel).toContainText(expectZone);
    } finally {
      await apiJson(page.request, `/api/orgs/${org.id}`, "PATCH", { timezone: originalTz });
    }
  });

  // --- 5. Guard: a scorer 404s; a viewer READS ------------------------------
  //
  // RS004 made the hub owner/admin-only and this test asserted both roles 404.
  // The owner REVERSED that on 2026-08-25: a viewer gets the hub read-only,
  // because the registration list and CSV export have always been readable by
  // a viewer through the API (`READ_ROLES` = owner, admin, viewer) and the UI
  // was the only half disagreeing. So the two roles are no longer symmetric
  // and cannot share a loop: a scorer is excluded by `requireCompetitionPage`
  // itself (404), while a viewer must reach the page AND see the nav entry
  // that gets them there.
  test("guard: a scorer 404s on the hub; a viewer reads it and can navigate to it", async ({ browser }) => {
    // A FRESH, throwaway org (not the shared Pro org). The original reason was
    // seat contention: the shared org's `scorers.max` was 1 and scorer.spec.ts
    // (the SERIAL project) already claimed it, and e2e-parallel / e2e-serial
    // are independent CI jobs with no `needs:` between them. V395
    // (entitlements v18 W2 T12) deleted `scorers.max` and the seat now draws on
    // `members.max` (3 on community, 10 on Pro), so the pool is no longer a
    // single seat — but a brand-new org still shares NO resource with the
    // serial job at all, which is the property this test actually wants.
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    try {
      await loginUi(ownerPage, `delivered+e2e-reghub-owner-${suffix}@resend.dev`);
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
          await loginUi(guestPage, `delivered+e2e-reghub-${role}-${suffix}@resend.dev`);
          const accepted = await guestPage.request.post(`/api/invites/${invite.data!.token}/accept`, {
            data: {},
          });
          expect(accepted.ok(), `${role} invite accept`).toBe(true);

          const res = await guestPage.goto(hubPath(org.slug, compSlug));

          if (role === "scorer") {
            expect(res!.status(), "a scorer should 404 on the hub, not redirect or 403").toBe(404);
            expect(new URL(guestPage.url()).pathname, "a scorer should not be redirected off the hub URL").toBe(
              hubPath(org.slug, compSlug),
            );
            // RS005: the guard lives in requireCompetitionPage, before `?tab=`
            // is ever read (registration-hub-tab.ts's own header comment) —
            // so a scorer must 404 on the Registrants tab too, not just the
            // Settings tab this block already proved.
            const regRes = await guestPage.goto(`${hubPath(org.slug, compSlug)}?tab=registrants`);
            expect(regRes!.status(), "a scorer should 404 on the Registrants tab too").toBe(404);
            await guestPage.goto(overviewPath(org.slug, compSlug), { waitUntil: "load" });
            await expect(
              guestPage.locator("[data-registration-hub-entry]"),
              "a scorer should not see the Registration nav entry",
            ).toHaveCount(0);
            continue;
          }

          // Viewer: reads the hub, and gets there by CLICKING. A viewer who
          // can only reach it by typing the URL is the same product failure
          // as not being able to reach it at all.
          expect(res!.status(), "a viewer should READ the hub (owner ruling 2026-08-25)").toBe(200);
          await expect(guestPage.locator("[data-registration-hub-settings-panel], [data-registration-hub-row]").first())
            .toBeVisible();

          await guestPage.goto(overviewPath(org.slug, compSlug), { waitUntil: "load" });
          await expect(
            guestPage.locator("[data-registration-hub-entry]"),
            "a viewer SHOULD see the Registration nav entry — it is their only path in",
          ).toHaveCount(1);

          // Read-only: the Configure control that opens the config panel is
          // ABSENT, not disabled. Every save behind it 403s a viewer, so a
          // greyed button would advertise a capability they do not have.
          await guestPage.goto(hubPath(org.slug, compSlug), { waitUntil: "load" });
          await expect(
            guestPage.locator("[data-registration-hub-row-configure]"),
            "a viewer must not see Configure",
          ).toHaveCount(0);

          // RS005: the Registrants tab is read-only for a viewer too — the
          // panel's own root carries `data-can-edit` regardless of row count,
          // so this holds even for THIS competition (no registrations seeded
          // here). The CONTENT half of this claim (rows visible, no mutating
          // controls WITH real data) has its own dedicated test below —
          // this guard test stays about the boundary, not the content.
          await guestPage.goto(`${hubPath(org.slug, compSlug)}?tab=registrants`, { waitUntil: "load" });
          await expect(
            guestPage.locator("[data-registration-hub-registrants-panel]"),
            "a viewer's Registrants panel must report canEdit=false",
          ).toHaveAttribute("data-can-edit", "false");
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
          contact: { name: who, email: `delivered+${who.toLowerCase().replace(/\W+/g, "-")}@resend.dev` },
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

// =============================================================================
// RS005 — the Registrants tab: read model, row-expand detail, row actions.
// Unit/integration suites already cover the pure derivations and the wiring
// (registration-hub-registrant-*.test.ts(x), fetch-registrant-rows(-db).test.ts,
// registration-list-read.test.ts); this describe block proves the real
// routes, the real action calls and the real DOM agree with them end to end
// — the same division of labour the RS004 describe block above states for
// the Settings tab.
//
// `src/components/registration-hub-registrant-{derive,actions,detail}.tsx`
// and `ui.json` are under active edit by another agent in this session
// (RS005 R1/R2 follow-up fixes). Every selector below is a `data-*` hook, a
// role, or a URL — never button label text — so a copy change or a legality
// refinement in those files cannot silently break this file. Every fact
// asserted below (join_code stripping, CSV columns, action legality,
// promote-picks-oldest, resend-refused-on-terminal) was verified by reading
// the CURRENT server usecases (registrations.ts / registration-approval.ts /
// registration-submit.ts) and registration-hub-registrant-derive.ts on
// 2026-08-25, immediately before this file was written.
// =============================================================================

const registrantsPath = (orgSlug: string, compSlug: string, query = ""): string =>
  `/o/${orgSlug}/c/${compSlug}/registration?tab=registrants${query ? `&${query}` : ""}`;

/** Confirm-provider (ui/confirm-provider.tsx) carries no `data-*` hook and
 *  its Confirm button's label/tone vary by call site — but Cancel is always
 *  the FIRST button in DOM order and Confirm the SECOND, regardless of the
 *  `flex-col-reverse` visual-only reorder, so `.last()` is copy- and
 *  tone-independent. */
async function acceptConfirmDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button").last().click();
}

function registrantRow(page: Page, registrationId: string): Locator {
  return page.locator(`[data-registration-hub-registrant-row][data-registration-id="${registrationId}"]`);
}

/** Opens one row's disclosure (idempotent) and waits past its detail body —
 *  everything below it is already in the initial HTML (page.tsx fetches
 *  every row's detail eagerly, task 3), so this only needs to wait for the
 *  native `<details>` toggle, not a network round trip. */
async function expandRow(page: Page, registrationId: string): Promise<Locator> {
  const row = registrantRow(page, registrationId);
  await expect(row).toBeVisible({ timeout: 20_000 });
  const isOpen = await row.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isOpen) await row.locator("summary").click();
  await expect(row.locator("[data-registration-hub-registrant-detail]")).toBeVisible();
  return row;
}

/** The status pill scoped to the row's OWN summary (card+grid blocks both
 *  always exist in the DOM, CSS picks which one shows — a bare `.first()`
 *  over both would resolve to the CARD block regardless of viewport, since
 *  it comes first in DOM order, and this project's default (desktop)
 *  viewport keeps that one `sm:hidden` — a resolved-but-invisible element,
 *  which `toBeVisible()` correctly reports as failing. `:visible` picks
 *  whichever of the two actually renders at THIS width instead. Scoped to
 *  `summary`, never the whole row: an expanded row with cart siblings also
 *  renders a status pill per SIBLING inside the detail body, which a
 *  row-wide selector would also match. */
function statusLocator(row: Locator, status: string): Locator {
  return row.locator(`summary [data-registration-hub-registrant-status="${status}"]:visible`);
}

/** A fresh viewer session invited into `orgId` — the invite-accept dance
 *  the RS004 guard test above open-codes for BOTH roles in its own loop;
 *  factored out here since several RS005 tests below only ever need the
 *  viewer half of it. Caller must close the returned context. */
async function loginAsViewer(
  browser: Browser,
  ownerRequest: APIRequestContext,
  orgId: string,
  emailSuffix: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const invite = await apiJson<{ token: string }>(ownerRequest, `/api/orgs/${orgId}/invites`, "POST", {
    role: "viewer",
    max_uses: 1,
  });
  expect(invite.status, "viewer invite create").toBeLessThan(300);
  const context = await browser.newContext();
  const guestPage = await context.newPage();
  await loginUi(guestPage, `delivered+e2e-rs005-viewer-${emailSuffix}@resend.dev`);
  const accepted = await guestPage.request.post(`/api/invites/${invite.data!.token}/accept`, { data: {} });
  expect(accepted.ok(), "viewer invite accept").toBe(true);
  return { context, page: guestPage };
}

test.describe("RS005 registrants tab", () => {
  // --- 1. join_code never reaches a viewer over the API --------------------
  test("join_code never reaches a viewer over the API; an owner's list carries it", async ({
    page,
    request,
    browser,
  }) => {
    const org = await activeOrg(page);
    const { competitionId, competitionSlug, divisionId } = await seedDivision(request, {
      divisionName: "Join Code Leak",
    });
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "team",
      fee_cents: 0,
      approval: "auto",
    });
    expect(settings.status).toBeLessThan(300);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const submitted = await apiJson<{ entries: { registration_id: string; join_code: string | null }[] }>(
      request,
      `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
      "POST",
      {
        contact: { name: `Captain ${suffix}`, email: `delivered+captain-${suffix}@resend.dev` },
        privacy_consent: true,
        entries: [
          {
            division_id: divisionId,
            entrant_kind: "team",
            team_name: `Squad ${suffix}`,
            players: [{ full_name: `Captain ${suffix}`, is_captain: true }],
            answers: {},
          },
        ],
      },
    );
    expect(submitted.status, JSON.stringify(submitted.error)).toBe(201);
    const entry = submitted.data!.entries[0]!;
    expect(entry.join_code, "sanity: a non-free-agent team entry mints a join code").not.toBeNull();

    const ownerList = await apiJson<{ id: string; join_code: string | null }[]>(
      page.request,
      `/api/v1/competitions/${competitionId}/registrations`,
    );
    expect(ownerList.status).toBe(200);
    const ownerRow = ownerList.data!.find((r) => r.id === entry.registration_id);
    expect(ownerRow, "owner's list should carry this entry").toBeTruthy();
    expect(ownerRow!.join_code).toBe(entry.join_code);

    const { context: viewerCtx, page: viewerPage } = await loginAsViewer(browser, page.request, org.id, suffix);
    try {
      const viewerList = await apiJson<{ id: string; join_code: string | null }[]>(
        viewerPage.request,
        `/api/v1/competitions/${competitionId}/registrations`,
      );
      expect(viewerList.status, "a viewer should READ the list (owner ruling)").toBe(200);
      const viewerRow = viewerList.data!.find((r) => r.id === entry.registration_id);
      expect(viewerRow, "viewer's list should still carry the row").toBeTruthy();
      expect(
        viewerRow!.join_code,
        "join_code must be null for a viewer — it is a write-capable credential",
      ).toBeNull();
    } finally {
      await viewerCtx.close();
    }
  });

  // --- 2. CSV column gate ----------------------------------------------------
  test("a viewer's CSV carries no player_dob/player_gender columns; an owner's does", async ({
    page,
    request,
    browser,
  }) => {
    const org = await activeOrg(page);
    const { competitionId, competitionSlug, divisionId } = await seedDivision(request, {
      divisionName: "CSV Columns",
    });
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      approval: "auto",
    });
    expect(settings.status).toBeLessThan(300);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const submitted = await apiJson(
      request,
      `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
      "POST",
      {
        contact: { name: `Player ${suffix}`, email: `delivered+player-${suffix}@resend.dev` },
        privacy_consent: true,
        entries: [
          {
            division_id: divisionId,
            entrant_kind: "individual",
            // No registering_self here — that flag makes contact.dob
            // cart-wide-required (schemas.ts's superRefine) for no benefit
            // to this test; an explicit per-player dob/gender is accepted
            // regardless of self-registration and is all this CSV column
            // check needs.
            players: [{ full_name: `Player ${suffix}`, dob: "2000-01-01", gender: "f" }],
            answers: {},
          },
        ],
      },
    );
    expect(submitted.status, JSON.stringify(submitted.error)).toBe(201);

    const exportUrl = `/api/v1/competitions/${competitionId}/registrations/export`;
    const ownerCsv = await page.request.get(exportUrl);
    expect(ownerCsv.status()).toBe(200);
    const ownerHeader = (await ownerCsv.text()).split("\n")[0]!.split(",");
    expect(ownerHeader, "owner CSV should carry player_dob").toContain("player_dob");
    expect(ownerHeader, "owner CSV should carry player_gender").toContain("player_gender");

    const { context: viewerCtx, page: viewerPage } = await loginAsViewer(browser, page.request, org.id, suffix);
    try {
      const viewerCsv = await viewerPage.request.get(exportUrl);
      expect(viewerCsv.status(), "a viewer should still be able to export (owner ruling)").toBe(200);
      const viewerHeader = (await viewerCsv.text()).split("\n")[0]!.split(",");
      expect(viewerHeader, "viewer CSV must NOT carry player_dob").not.toContain("player_dob");
      expect(viewerHeader, "viewer CSV must NOT carry player_gender").not.toContain("player_gender");
      expect(viewerHeader, "the rest of the header is unchanged").toContain("player_name");
    } finally {
      await viewerCtx.close();
    }
  });

  // --- 3. Role boundary, with real content -----------------------------------
  test("registrants tab role boundary: a viewer sees the row with no mutating controls; an owner sees them", async ({
    page,
    request,
    browser,
  }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "Role Boundary" });
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      approval: "manual",
    });
    expect(settings.status).toBeLessThan(300);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const displayName = `Boundary ${suffix}`;
    const submitted = await apiJson<{ entries: { registration_id: string }[] }>(
      request,
      `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
      "POST",
      {
        contact: { name: displayName, email: `delivered+boundary-${suffix}@resend.dev` },
        privacy_consent: true,
        entries: [
          { division_id: divisionId, entrant_kind: "individual", players: [{ full_name: displayName }], answers: {} },
        ],
      },
    );
    expect(submitted.status, JSON.stringify(submitted.error)).toBe(201);
    const regId = submitted.data!.entries[0]!.registration_id;

    const { context: viewerCtx, page: viewerPage } = await loginAsViewer(browser, page.request, org.id, suffix);
    try {
      await viewerPage.goto(registrantsPath(org.slug, competitionSlug), { waitUntil: "load" });
      const viewerRow = await expandRow(viewerPage, regId);
      await expect(
        viewerRow.locator("[data-registration-hub-registrant-actions]"),
        "a viewer must not see the actions section at all",
      ).toHaveCount(0);
    } finally {
      await viewerCtx.close();
    }

    await page.goto(registrantsPath(org.slug, competitionSlug), { waitUntil: "load" });
    const ownerRow = await expandRow(page, regId);
    await expect(
      ownerRow.locator("[data-registration-hub-registrant-actions]"),
      "an owner must see the actions section",
    ).toBeVisible();
    await expect(
      ownerRow.locator("[data-registration-hub-registrant-action]").first(),
      "an owner must see at least one action control",
    ).toBeVisible();
  });

  // --- 4. The recovery path ----------------------------------------------------
  test("the recovery path: an unpaid pending fee entry offers no approve; marking it paid confirms it and creates the entrant", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "Recovery Path" });
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 500,
      approval: "manual",
      payment_method: "offline",
    });
    expect(settings.status).toBeLessThan(300);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const displayName = `Recovery ${suffix}`;
    const submitted = await apiJson<{ entries: { registration_id: string; status: string }[] }>(
      request,
      `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
      "POST",
      {
        contact: { name: displayName, email: `delivered+recovery-${suffix}@resend.dev` },
        privacy_consent: true,
        entries: [
          { division_id: divisionId, entrant_kind: "individual", players: [{ full_name: displayName }], answers: {} },
        ],
      },
    );
    expect(submitted.status, JSON.stringify(submitted.error)).toBe(201);
    const entry = submitted.data!.entries[0]!;
    expect(entry.status, "manual + fee + no payment on file -> pending").toBe("pending");
    const regId = entry.registration_id;

    await page.goto(registrantsPath(org.slug, competitionSlug), { waitUntil: "load" });
    const row = await expandRow(page, regId);
    await expect(
      row.locator('[data-registration-hub-registrant-action="approve"]'),
      "an unpaid manual+fee entry must NOT offer approve (the dead end RS005 R1 closed)",
    ).toHaveCount(0);
    const markPaid = row.locator('[data-registration-hub-registrant-action="mark-paid"]');
    await expect(markPaid, "it must offer mark-paid instead").toBeVisible();

    await markPaid.click();
    await acceptConfirmDialog(page);
    await expect(
      statusLocator(row, "confirmed"),
      "marking paid confirms the entry directly — materialise() sets status='confirmed' in the same transaction",
    ).toBeVisible({ timeout: 20_000 });

    const entrants = await apiJson<{ display_name: string }[]>(
      page.request,
      `/api/v1/divisions/${divisionId}/entrants`,
    );
    expect(entrants.status).toBe(200);
    expect(
      entrants.data!.some((e) => e.display_name === displayName),
      "marking paid must materialise a real entrant, not just flip the status",
    ).toBe(true);
  });

  // --- 5. Reject is terminal ----------------------------------------------------
  test("reject is terminal: after rejecting, approve is gone and the API refuses it", async ({ page, request }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "Reject Terminal" });
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      approval: "manual",
    });
    expect(settings.status).toBeLessThan(300);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const displayName = `Reject ${suffix}`;
    const submitted = await apiJson<{ entries: { registration_id: string; status: string }[] }>(
      request,
      `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
      "POST",
      {
        contact: { name: displayName, email: `delivered+reject-${suffix}@resend.dev` },
        privacy_consent: true,
        entries: [
          { division_id: divisionId, entrant_kind: "individual", players: [{ full_name: displayName }], answers: {} },
        ],
      },
    );
    expect(submitted.status, JSON.stringify(submitted.error)).toBe(201);
    const regId = submitted.data!.entries[0]!.registration_id;
    expect(submitted.data!.entries[0]!.status).toBe("pending");

    await page.goto(registrantsPath(org.slug, competitionSlug), { waitUntil: "load" });
    const row = await expandRow(page, regId);
    await row.locator('[data-registration-hub-registrant-action="reject"]').click();
    await acceptConfirmDialog(page);
    await expect(statusLocator(row, "rejected"), "reject flips the row to rejected").toBeVisible({
      timeout: 20_000,
    });
    await expect(
      row.locator('[data-registration-hub-registrant-action="approve"]'),
      "a rejected entry must never offer approve again",
    ).toHaveCount(0);

    const approveAttempt = await apiJson(page.request, `/api/v1/registrations/${regId}/approve`, "POST");
    expect(approveAttempt.status, "the API must refuse to approve a rejected entry").toBe(422);
    expect(approveAttempt.error?.message ?? "").toContain("rejected");
  });

  // --- 6. Promote picks the oldest ------------------------------------------
  test("promote from the waitlist promotes the oldest entry, and the promoted row reflects it", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "Promote Oldest" });
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      approval: "auto",
      capacity: 1,
    });
    expect(settings.status).toBeLessThan(300);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;

    async function submit(who: string): Promise<{ registration_id: string; status: string }> {
      const res = await apiJson<{ entries: { registration_id: string; status: string }[] }>(
        request,
        `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
        "POST",
        {
          contact: { name: who, email: `delivered+${who.toLowerCase().replace(/\W+/g, "-")}@resend.dev` },
          privacy_consent: true,
          entries: [
            { division_id: divisionId, entrant_kind: "individual", players: [{ full_name: who }], answers: {} },
          ],
        },
      );
      expect(res.status, JSON.stringify(res.error)).toBe(201);
      return res.data!.entries[0]!;
    }

    const first = await submit(`First ${suffix}`);
    expect(first.status, "within capacity -> confirmed immediately (auto + free)").toBe("confirmed");
    const oldestWaitlisted = await submit(`Oldest Waitlisted ${suffix}`);
    expect(oldestWaitlisted.status).toBe("waitlisted");
    const newerWaitlisted = await submit(`Newer Waitlisted ${suffix}`);
    expect(newerWaitlisted.status).toBe("waitlisted");

    // POSTed against the NEWER entry's own id, with NO registration_id
    // override in the body: promoteFromWaitlist resolves the DIVISION from
    // the URL id and then defaults to the OLDEST waitlisted row in it
    // (promoteOldestWaitlisted's own `order by created_at, id`) — a
    // response naming the OLDER entry, not the one in the URL, is the proof.
    const promoted = await apiJson<{ id: string; status: string }>(
      page.request,
      `/api/v1/registrations/${newerWaitlisted.registration_id}/promote`,
      "POST",
      {},
    );
    expect(promoted.status).toBe(200);
    expect(promoted.data!.id, "the OLDEST waitlisted entry promotes, not the one in the URL").toBe(
      oldestWaitlisted.registration_id,
    );
    // RS010: promoteWaitlistedRow confirms immediately on a FREE + AUTO
    // division (registrations.ts:1297) — the same shortcut submit-time
    // auto-confirm uses — because a pending row on an auto division can
    // never be confirmed by anything downstream (approveRegistration
    // refuses "auto", and there is no Stripe webhook for a $0 fee).
    expect(promoted.data!.status, "a free/auto promotion confirms immediately, never sits at pending").toBe(
      "confirmed",
    );

    await page.goto(registrantsPath(org.slug, competitionSlug), { waitUntil: "load" });
    const promotedRow = await expandRow(page, oldestWaitlisted.registration_id);
    await expect(statusLocator(promotedRow, "confirmed"), "the promoted row reflects its new status").toBeVisible({
      timeout: 20_000,
    });
    const untouchedRow = await expandRow(page, newerWaitlisted.registration_id);
    await expect(
      statusLocator(untouchedRow, "waitlisted"),
      "the newer entry is untouched — promote is exactly one row, not a sweep",
    ).toBeVisible({ timeout: 20_000 });
  });

  // --- 7. Resend refused on a terminal entry ------------------------------------
  test("resend is absent on a withdrawn entry, and the API refuses it 422", async ({ page, request }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "Resend Withdrawn" });
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      approval: "auto",
    });
    expect(settings.status).toBeLessThan(300);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const displayName = `Withdrawn ${suffix}`;
    const submitted = await apiJson<{ entries: { registration_id: string; status: string }[] }>(
      request,
      `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
      "POST",
      {
        contact: { name: displayName, email: `delivered+withdrawn-${suffix}@resend.dev` },
        privacy_consent: true,
        entries: [
          { division_id: divisionId, entrant_kind: "individual", players: [{ full_name: displayName }], answers: {} },
        ],
      },
    );
    expect(submitted.status, JSON.stringify(submitted.error)).toBe(201);
    const regId = submitted.data!.entries[0]!.registration_id;
    expect(submitted.data!.entries[0]!.status, "auto + free -> confirmed immediately").toBe("confirmed");

    const withdrawn = await apiJson(request, `/api/v1/registrations/${regId}/withdraw`, "POST");
    expect(withdrawn.status).toBeLessThan(300);

    await page.goto(registrantsPath(org.slug, competitionSlug), { waitUntil: "load" });
    const row = await expandRow(page, regId);
    await expect(statusLocator(row, "withdrawn")).toBeVisible();
    await expect(
      row.locator('[data-registration-hub-registrant-action="resend"]'),
      "a withdrawn entry must not offer resend — RS005 R1 second-wave finding",
    ).toHaveCount(0);

    const resendAttempt = await apiJson(page.request, `/api/v1/registrations/${regId}/resend-confirmation`, "POST");
    expect(resendAttempt.status, "the API must refuse to resend a confirmation on a withdrawn entry").toBe(422);
  });

  // --- 8. The optimistic rollback tells the truth --------------------------
  test("the optimistic rollback tells the truth: a forced 4xx reverts the row to the server's actual status", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "Rollback Truth" });
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      approval: "manual",
    });
    expect(settings.status).toBeLessThan(300);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const displayName = `Rollback ${suffix}`;
    const submitted = await apiJson<{ entries: { registration_id: string; status: string }[] }>(
      request,
      `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
      "POST",
      {
        contact: { name: displayName, email: `delivered+rollback-${suffix}@resend.dev` },
        privacy_consent: true,
        entries: [
          { division_id: divisionId, entrant_kind: "individual", players: [{ full_name: displayName }], answers: {} },
        ],
      },
    );
    expect(submitted.status, JSON.stringify(submitted.error)).toBe(201);
    const regId = submitted.data!.entries[0]!.registration_id;
    expect(submitted.data!.entries[0]!.status).toBe("pending");

    await page.goto(registrantsPath(org.slug, competitionSlug), { waitUntil: "load" });
    const row = await expandRow(page, regId);

    // Force the server to refuse THIS approve call — the row's own
    // optimistic guess ("confirmed") must not be what the organiser is left
    // looking at once the request actually fails.
    await page.route(`**/api/v1/registrations/${regId}/approve`, (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { message: "forced failure for this test" } }),
      }),
    );

    await row.locator('[data-registration-hub-registrant-action="approve"]').click();
    await expect(
      row.locator('[data-registration-hub-registrant-actions-feedback][data-tone="error"]'),
      "the failed call must surface as an error, not silently settle",
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      statusLocator(row, "pending"),
      "on a 4xx the row must show the SERVER's real status, never the optimistic guess",
    ).toBeVisible();
    await expect(statusLocator(row, "confirmed"), "the optimistic guess must not be left standing").toHaveCount(0);
    // The revert also restores the button set derived off the real status —
    // approve is legal again, since nothing actually changed server-side.
    await expect(row.locator('[data-registration-hub-registrant-action="approve"]')).toBeVisible();

    // Sanity: unroute and confirm this was THIS test's own intercept, not a
    // genuine defect — the real route is left reachable for anything after.
    await page.unroute(`**/api/v1/registrations/${regId}/approve`);
  });

  // --- 9. Filters actually filter, via the URL --------------------------------
  test("filters narrow via the URL, including a kind=individual entry on a division with no settings row", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
      name: `Filters ${suffix}`,
      ends_on: "2030-12-31",
      visibility: "public",
    });
    expect(comp.status).toBeLessThan(300);
    const competitionId = comp.data!.id;
    const competitionSlug = comp.data!.slug;

    const soloDiv = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${competitionId}/divisions`,
      "POST",
      { name: "Solo", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
    );
    expect(soloDiv.status).toBeLessThan(300);
    expect(
      (
        await apiJson(request, `/api/v1/divisions/${soloDiv.data!.id}/registration-settings`, "PUT", {
          enabled: true,
          entrant_kind: "individual",
          fee_cents: 0,
          approval: "auto",
        })
      ).status,
    ).toBeLessThan(300);

    const squadDiv = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${competitionId}/divisions`,
      "POST",
      { name: "Squad", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
    );
    expect(squadDiv.status).toBeLessThan(300);
    expect(
      (
        await apiJson(request, `/api/v1/divisions/${squadDiv.data!.id}/registration-settings`, "PUT", {
          enabled: true,
          entrant_kind: "team",
          fee_cents: 0,
          approval: "auto",
          allow_free_agents: true,
        })
      ).status,
    ).toBeLessThan(300);

    const bareDiv = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${competitionId}/divisions`,
      "POST",
      { name: "Bare", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
    );
    expect(bareDiv.status).toBeLessThan(300);
    // NEVER PUT registration-settings for this one — see
    // seedBareRegistrationSql's own doc comment ("predates configuration").

    async function submit(
      divisionId: string,
      displayName: string,
      opts: { kind: "individual" | "team"; freeAgent?: boolean; selfRegistering?: boolean },
    ): Promise<{ registration_id: string; status: string }> {
      const res = await apiJson<{ entries: { registration_id: string; status: string }[] }>(
        request,
        `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
        "POST",
        {
          contact: {
            name: displayName,
            email: `delivered+${displayName.toLowerCase().replace(/\W+/g, "-")}@resend.dev`,
            // Cart-wide required the instant ANY entry sets registering_self
            // (schemas.ts's superRefine) — harmless to include unconditionally.
            dob: "1990-01-01",
          },
          privacy_consent: true,
          entries: [
            {
              division_id: divisionId,
              entrant_kind: opts.kind,
              free_agent: opts.freeAgent ?? false,
              registering_self: opts.selfRegistering ?? false,
              // Required for every NON-free-agent team entry
              // (entryDisplayName, registration-submit.ts) — harmless to
              // include for individual entries too, where it's just ignored.
              team_name: opts.kind === "team" && !opts.freeAgent ? `${displayName} Team` : undefined,
              players: opts.freeAgent ? [] : [{ full_name: displayName, is_captain: opts.kind === "team" }],
              answers: {},
            },
          ],
        },
      );
      expect(res.status, JSON.stringify(res.error)).toBe(201);
      return res.data!.entries[0]!;
    }

    // Solo: registering_self -> its player's consent is GRANTED, so this
    // must NOT match consent_pending=1. A distinctive name for the search
    // filter, unique across every other entry seeded below.
    const solo = await submit(soloDiv.data!.id, `Filter Zephyr ${suffix}`, {
      kind: "individual",
      selfRegistering: true,
    });
    expect(solo.status).toBe("confirmed");

    // Squad: NOT registering_self -> its one (captain) player's consent
    // stays 'pending' by default — the row consent_pending=1 must find.
    const squad = await submit(squadDiv.data!.id, `Filter Squad ${suffix}`, { kind: "team" });
    expect(squad.status).toBe("confirmed");

    // Free agent: entrant_kind team + free_agent. It is CONFIRMED under
    // auto+free approval, and seats no entrant.
    //
    // This expectation changed in RS009 and the reason is recorded rather
    // than quietly flipped. The old comment here read "materialise is
    // skipped ('never for a free agent'), so this stays 'pending'" — a
    // description of the mechanism, not an independent ruling. RS009 removed
    // that exclusion because it had outlived its reason: materialise no
    // longer mints a phantom one-person entrant for a free agent, it seats
    // nobody and confirms them. Left as it was, a solo sign-up on a FREE
    // division sat at 'pending' forever and the Assign control was hidden
    // from it, so the assignment feature was dead on those divisions.
    //
    // What has NOT changed, and is still the thing this row is here for: 0
    // players submitted means no registration_players row, so it still does
    // not match consent_pending=1.
    const freeAgent = await submit(squadDiv.data!.id, `Filter FreeAgent ${suffix}`, {
      kind: "team",
      freeAgent: true,
    });
    expect(freeAgent.status).toBe("confirmed");

    // Bare: direct SQL — the API cannot express "an entry on a division
    // with no registration_settings row at all" (registration-submit.ts's
    // loadSubmitSettings returns null and submission is refused before
    // anything is written).
    const bare = await seedBareRegistrationSql(competitionId, bareDiv.data!.id, {
      displayName: `Filter Bare ${suffix}`,
      status: "pending",
    });

    async function idsAt(query: string): Promise<Set<string>> {
      await page.goto(registrantsPath(org.slug, competitionSlug, query), { waitUntil: "load" });
      const ids = await page
        .locator("[data-registration-hub-registrant-row]")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-registration-id")));
      return new Set(ids as string[]);
    }

    // Only the bare row is pending now — the free agent confirms at submit
    // (see its own comment above). Kept as a real narrowing assertion rather
    // than deleted: it still proves the filter excludes the three confirmed
    // rows.
    expect(await idsAt("status=pending"), "status=pending narrows to the bare entry").toEqual(
      new Set([bare.registrationId]),
    );
    // ...and the complement, which the old shape could not assert because
    // only two rows were confirmed. Added with the RS009 change so the
    // status filter is pinned in BOTH directions.
    expect(await idsAt("status=confirmed"), "status=confirmed finds the three auto-confirmed rows").toEqual(
      new Set([solo.registration_id, squad.registration_id, freeAgent.registration_id]),
    );
    // The previously-broken case: a division with NO settings row coalesces
    // to entrant_kind 'individual' (fetchRegistrantRows' own LEFT JOIN), and
    // the kind filter must apply the SAME coalesce — otherwise a row
    // DISPLAYED as "Individual" would vanish the moment it's filtered for.
    expect(await idsAt("kind=individual"), "kind=individual finds the bare-division row too").toEqual(
      new Set([solo.registration_id, bare.registrationId]),
    );
    expect(await idsAt("kind=team")).toEqual(new Set([squad.registration_id, freeAgent.registration_id]));
    expect(await idsAt(`division_id=${squadDiv.data!.id}`)).toEqual(
      new Set([squad.registration_id, freeAgent.registration_id]),
    );
    expect(await idsAt("free_agent=1")).toEqual(new Set([freeAgent.registration_id]));
    expect(await idsAt("consent_pending=1")).toEqual(new Set([squad.registration_id]));
    expect(await idsAt("q=Zephyr")).toEqual(new Set([solo.registration_id]));
  });

  // --- 10. Both empty states are distinct -------------------------------------
  test("both empty states are distinct: no registrations at all vs. filters matched nothing", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);

    // "No registrations at all" — a fresh division, zero registrations, no
    // filters — RS004's designed placeholder, and no filter bar/export link
    // above it (there is nothing yet to filter or export).
    const { competitionSlug: emptySlug } = await seedDivision(request, { divisionName: "Truly Empty" });
    await page.goto(registrantsPath(org.slug, emptySlug), { waitUntil: "load" });
    await expect(page.locator('[data-registration-hub-registrant-empty="empty"]')).toBeVisible();
    await expect(page.locator('[data-registration-hub-registrant-empty="filtered"]')).toHaveCount(0);
    await expect(page.locator("[data-registration-hub-registrant-filters]")).toHaveCount(0);

    // "Filters matched nothing" — a real registration exists, but THIS
    // filter combination matches none of it.
    const { competitionSlug, divisionId } = await seedDivision(request, { divisionName: "Filtered Empty" });
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      approval: "auto",
    });
    expect(settings.status).toBeLessThan(300);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const displayName = `Filtered ${suffix}`;
    const submitted = await apiJson(
      request,
      `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/register`,
      "POST",
      {
        contact: { name: displayName, email: `delivered+filtered-${suffix}@resend.dev` },
        privacy_consent: true,
        entries: [
          { division_id: divisionId, entrant_kind: "individual", players: [{ full_name: displayName }], answers: {} },
        ],
      },
    );
    expect(submitted.status, JSON.stringify(submitted.error)).toBe(201);

    await page.goto(registrantsPath(org.slug, competitionSlug, "status=rejected"), { waitUntil: "load" });
    await expect(page.locator('[data-registration-hub-registrant-empty="filtered"]')).toBeVisible();
    await expect(page.locator('[data-registration-hub-registrant-empty="empty"]')).toHaveCount(0);
    // The filter bar stays visible here — there IS something to clear,
    // unlike the truly-empty competition above.
    await expect(page.locator("[data-registration-hub-registrant-filters]")).toBeVisible();
  });

  // --- 11. The division page's pre-filtered link into the hub ------------------
  test("the division page links into the hub with its division pre-filtered", async ({ page, request }) => {
    const org = await activeOrg(page);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
      name: `Prefiltered ${suffix}`,
      ends_on: "2030-12-31",
      visibility: "public",
    });
    expect(comp.status).toBeLessThan(300);
    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
    );
    expect(div.status).toBeLessThan(300);
    const divisionId = div.data!.id;
    expect(
      (
        await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
          enabled: true,
          entrant_kind: "individual",
          fee_cents: 0,
          approval: "auto",
        })
      ).status,
    ).toBeLessThan(300);

    // A second division with its own entry — proves the link's filter
    // actually NARROWS the list, not merely that the URL carries the param.
    const otherDiv = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      { name: "Other", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
    );
    expect(otherDiv.status).toBeLessThan(300);
    expect(
      (
        await apiJson(request, `/api/v1/divisions/${otherDiv.data!.id}/registration-settings`, "PUT", {
          enabled: true,
          entrant_kind: "individual",
          fee_cents: 0,
          approval: "auto",
        })
      ).status,
    ).toBeLessThan(300);

    async function submit(divId: string, who: string): Promise<string> {
      const res = await apiJson<{ entries: { registration_id: string }[] }>(
        request,
        `/api/v1/public/orgs/${org.slug}/competitions/${comp.data!.slug}/register`,
        "POST",
        {
          contact: { name: who, email: `delivered+${who.toLowerCase().replace(/\W+/g, "-")}@resend.dev` },
          privacy_consent: true,
          entries: [{ division_id: divId, entrant_kind: "individual", players: [{ full_name: who }], answers: {} }],
        },
      );
      expect(res.status, JSON.stringify(res.error)).toBe(201);
      return res.data!.entries[0]!.registration_id;
    }

    const thisId = await submit(divisionId, `PrefilteredThis ${suffix}`);
    const otherId = await submit(otherDiv.data!.id, `PrefilteredOther ${suffix}`);

    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}`, { waitUntil: "load" });
    const expectedHref = `/o/${org.slug}/c/${comp.data!.slug}/registration?tab=registrants&division_id=${divisionId}`;
    const link = page.locator(`a[href="${expectedHref}"]`);
    await expect(link, "the division page must carry a link into the hub, this division pre-filtered").toBeVisible();
    await link.click();
    await page.waitForURL((u) => u.pathname.endsWith("/registration") && u.search.includes("division_id"));
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(expectedHref);

    await expect(registrantRow(page, thisId)).toBeVisible();
    await expect(
      registrantRow(page, otherId),
      "the OTHER division's entry must be filtered out",
    ).toHaveCount(0);
  });

  // Clearing a filter must actually clear the WIDGETS, not only the URL.
  // Every control is uncontrolled and the submit handler reads live DOM state,
  // so before this was fixed the select still read "Confirmed" after Clear, and
  // the next change to ANY other control silently pushed the cleared filter
  // back. The unit test can only prove React WOULD remount (the hook harness
  // has no DOM); this proves the browser actually shows a cleared control and
  // does not resurrect the filter.
  test("clearing filters clears the controls, and the next change does not resurrect them", async ({ page }) => {
    const org = await activeOrg(page);
    const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
      name: `Clear ${suffix}`,
      ends_on: "2030-12-31",
      visibility: "public",
    });
    expect(comp.status).toBeLessThan(300);

    // Real rows are required: with ZERO registrations the tab renders the
    // "no registrations at all" empty state, which correctly has no filter
    // bar to clear. One confirmed and one pending, so `status=confirmed`
    // genuinely narrows.
    const div = await apiJson<{ id: string }>(
      page.request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      { name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
    );
    expect(div.status).toBeLessThan(300);
    await seedBareRegistrationSql(comp.data!.id, div.data!.id, { status: "confirmed", displayName: "Cleared Confirmed" });
    await seedBareRegistrationSql(comp.data!.id, div.data!.id, { status: "pending", displayName: "Cleared Pending" });

    const hub = `/o/${org.slug}/c/${comp.data!.slug}/registration?tab=registrants`;
    await page.goto(`${hub}&status=confirmed`, { waitUntil: "load" });
    await expect(page.locator('select[name="status"]')).toHaveValue("confirmed");

    // Scoped to the FORM: the filtered-empty state renders its own "Clear
    // filters" link, so an unscoped role lookup is a strict-mode violation on
    // a competition with no matching rows.
    await page.locator("form").getByRole("link", { name: /clear filters/i }).click();
    await page.waitForURL((u) => !u.search.includes("status="));
    await expect(
      page.locator('select[name="status"]'),
      "the widget must reflect the URL the page is actually showing",
    ).toHaveValue("");

    // Change a DIFFERENT control. The submit handler reads the live form, so a
    // stale select here is what used to push `status=confirmed` back.
    await page.locator('select[name="sort"]').selectOption("oldest");
    await page.waitForURL((u) => u.search.includes("sort=oldest"));
    expect(new URL(page.url()).search).not.toContain("status=");
    // And no empty parameters: the URL is a shareable artefact.
    expect(new URL(page.url()).search).not.toMatch(/[?&][a-z_]+=(&|$)/);
  });

});
