// Split out of the former e2e/mobile.spec.ts (2026-11-13, verbatim move): registration: the hub config panel, the Registrants tab, and the public register stepper.
// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — MOBILE_SPECS in playwright.config.ts).

import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg, expectNoHorizontalScroll, loginUi } from "../helpers";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { projectTag, projectViewport } from "./_shared";

// Not serial: no test here reads state another test writes (no module-level `let` is shared), so one red does not skip the rest (AGENTS.md class 21).

// ---------------------------------------------------------------------------
// RS004 registration hub — the row-click config panel, open, at every width
// (v3/02 §4 viewport gate). Lives here rather than in the new
// registration-hub.spec.ts for the same reason every other mobile-matrix
// case in this file does: a spec file outside this one runs desktop-only and
// never sees 320/360/375/390/430/768/834 — exactly the shape this check
// exists to catch (a modal sized in `vh` or pinned `inset-0` passes at
// desktop and breaks at 320). `projectTag()` (top of file) is folded into
// this test's own account because it MUTATES registration settings (opening
// the panel triggers its GET; this test doesn't save, but the account still
// needs to be per-project) — seven width projects start near-simultaneously
// and share helpers.ts's per-PROCESS `TAG`, so an un-tagged email can log two
// of them into the same user/org/division (see the P6 comment above).
// ---------------------------------------------------------------------------
const REG_HUB_MOBILE_EMAIL = () => `delivered+reghub-${TAG}-${projectTag()}@resend.dev`;

test("registration hub: the config panel has no horizontal scroll, open", async ({ page }) => {
  await loginUi(page, REG_HUB_MOBILE_EMAIL());
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Reg Hub Mobile ${TAG}-${projectTag()}`,
    visibility: "private",
  });
  expect(comp.status).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.status).toBeLessThan(300);
  const divisionIdReg = div.data!.id;

  const org = await activeOrg(page);
  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/registration`, { waitUntil: "load" });
  const row = page.locator(`[data-registration-hub-row][data-division-id="${divisionIdReg}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.locator("[data-registration-hub-row-configure]").click();

  const panel = page.locator(`[data-registration-hub-config-panel][data-division-id="${divisionIdReg}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  // Past the panel's own async GET/loading placeholder — a known field is
  // the signal its state actually landed.
  await expect(panel.locator('[data-field="category"]')).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// RS005 — Registrants tab, the whole width matrix (v3/02 §4 viewport gate).
// One test covers everything the dispatch called out for this file
// (no-scroll+rows, the grid/card switch, an expanded row's worst-case
// content, the filter bar) off ONE seeded fixture — the same economy the
// "registration hub" test just above uses; a login+seed per check would
// multiply setup cost across all seven width projects for no extra
// coverage. `projectTag()` is folded into this test's own account for the
// SAME reason that test's own comment gives: it MUTATES (via the public
// register API) and TAG is per-PROCESS, not per-project.
// ---------------------------------------------------------------------------
const REGISTRANTS_MOBILE_EMAIL = () => `delivered+regtab-${TAG}-${projectTag()}@resend.dev`;

test("registrants tab: no-scroll, grid/card switch, expanded-row and filter-bar overflow, at this width", async ({
  page,
}) => {
  await loginUi(page, REGISTRANTS_MOBILE_EMAIL());
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Registrants Mobile ${TAG}-${projectTag()}`,
    visibility: "public",
  });
  expect(comp.status).toBeLessThan(300);

  const teamDiv = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Mobile Team",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(teamDiv.status).toBeLessThan(300);
  const soloDiv = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Mobile Solo",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(soloDiv.status).toBeLessThan(300);
  for (const [divId, kind] of [
    [teamDiv.data!.id, "team"],
    [soloDiv.data!.id, "individual"],
  ] as const) {
    const settings = await apiJson(page.request, `/api/v1/divisions/${divId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: kind,
      fee_cents: 0,
      approval: "auto",
    });
    expect(settings.status).toBeLessThan(300);
  }

  const org = await activeOrg(page);
  // ONE cart, two entries sharing a group — gives the team entry a cart
  // SIBLING to render on top of its own join code + roster: the detail
  // body's worst case for width (join code, warning copy, roster, cart
  // siblings, per the dispatch) all at once. A deliberately long captain
  // name stress-tests the narrowest project (320px).
  const captainName = `Captain With An Unusually Long Name For Overflow Testing ${TAG}`;
  const submitted = await apiJson<{ entries: { registration_id: string; division_id: string }[] }>(
    page.request,
    `/api/v1/public/orgs/${org.slug}/competitions/${comp.data!.slug}/register`,
    "POST",
    {
      contact: { name: captainName, email: `delivered+mobile-captain-${TAG}-${projectTag()}@resend.dev` },
      privacy_consent: true,
      entries: [
        {
          division_id: teamDiv.data!.id,
          entrant_kind: "team",
          // A deliberately long team name too — the same 320px stress case
          // as the captain's name; a non-free-agent team entry requires one
          // (entryDisplayName, registration-submit.ts).
          team_name: `Team With An Equally Long Name For Overflow ${TAG}`,
          players: [{ full_name: captainName, is_captain: true }],
          answers: {},
        },
        {
          division_id: soloDiv.data!.id,
          entrant_kind: "individual",
          players: [{ full_name: `Solo Sibling ${TAG}` }],
          answers: {},
        },
      ],
    },
  );
  expect(submitted.status, JSON.stringify(submitted)).toBe(201);
  const teamRegId = submitted.data!.entries.find((e) => e.division_id === teamDiv.data!.id)!.registration_id;

  // 1) The tab itself: no horizontal scroll, rows present.
  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/registration?tab=registrants`, { waitUntil: "load" });
  const row = page.locator(`[data-registration-hub-registrant-row][data-registration-id="${teamRegId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);

  // 2) The grid/card switch: below the `sm` (640px) breakpoint the phone
  //    CARD block is what's visible; at/above it, the aligned-columns GRID
  //    block is — both always exist in the DOM (CSS picks which shows), so
  //    this is a real visibility assertion, not a class-name probe.
  const isPhoneWidth = (projectViewport()?.width ?? 0) < 640;
  const card = row.locator("[data-registration-hub-registrant-card]");
  const grid = row.locator("[data-registration-hub-registrant-grid]");
  if (isPhoneWidth) {
    await expect(card).toBeVisible();
    await expect(grid).not.toBeVisible();
  } else {
    await expect(grid).toBeVisible();
    await expect(card).not.toBeVisible();
  }

  // 3) Expanded row: join code (+ its warning copy), roster, AND a cart
  //    sibling link all render at once — the detail body's densest case.
  await row.locator("summary").click();
  await expect(row.locator("[data-registration-hub-registrant-detail]")).toBeVisible();
  await expect(row.locator("[data-registration-hub-registrant-join-code]")).toBeVisible();
  await expect(row.locator("[data-registration-hub-registrant-roster-player]").first()).toBeVisible();
  await expect(row.locator("[data-registration-hub-registrant-sibling-link]")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // 4) The filter bar: present, no overflow, and its controls stay
  //    touch-sized (min-h-11 = 44px, the same bar every other v3 control in
  //    this file is held to). R4 (task 1, auto-submit) removed the filter
  //    bar's own submit button entirely — every control now submits itself
  //    on change (registration-hub-registrant-filters.tsx's own header
  //    comment) — so the status <select> (still present, still min-h-11) is
  //    the stand-in; it is not interacted with here (a change would
  //    navigate away via requestSubmit()), only measured.
  const filters = page.locator("[data-registration-hub-registrant-filters]");
  await expect(filters).toBeVisible();
  const statusSelect = filters.locator('select[name="status"]');
  const box = await statusSelect.boundingBox();
  expect(box, "filter status select must have a measurable box").not.toBeNull();
  expect(box!.height, "filter controls must stay >=44px tall (touch target)").toBeGreaterThanOrEqual(44);
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// RS006 gap — the public registration STEPPER's steps 2-5 had ZERO width
// coverage. `mobile.spec.ts` only ever loaded the stepper's WHO (step 1)
// landing frame ("public surfaces: no horizontal scroll" above `goto`s
// `/register` once and stops; the LCP test further up only measures load
// time, never layout). ENTRIES, DETAILS, CONSENT and REVIEW never rendered
// at ANY width in CI. DETAILS is the real risk: roster-table.tsx renders an
// `input[type="date"]` per roster row once a division `requires_dob`
// (age_min/age_max set — @/lib/registration-rules' requiresDob) — the
// widest control the whole flow produces, and exactly the shape that
// overflows a 320px page.
//
// Self-contained: its own competition + two divisions, read back by id/slug
// from each API response, never by re-querying on name or TAG — TAG is
// per-PROCESS, not per-project (this file's own header comment), so a name
// collision across two width workers is possible and this test must not
// care. It reads the org's slug via `activeOrg`, the same way every other
// self-contained test in this file does (T15/T16/T17 above) — but it is NOT
// read-only: it DOES mutate the shared org, minting one competition and two
// divisions under it. Left alone that accumulates forever (all seven width
// projects run this test, every CI run), so the whole flow below runs
// inside a `try` whose `finally` deletes the competition by the exact id
// captured right after creation — never a name/prefix search, so cleanup
// can never catch a concurrent width project's own row. The delete cascades
// both divisions and their registration_settings rows (competition_id /
// division_id are ON DELETE CASCADE), fires even when an assertion above
// throws, and is best-effort/unasserted so a cleanup hiccup can never mask
// a real test failure.
//
// "Stepper Solo" is `entrant_kind: "individual"`, PATCHED with `age_min: 0`
// right after creation — the cheapest way to flip `requires_dob` true with
// no real restriction (requiresDob only checks `age_min != null`; "0 or
// older" is true for any dob a person could type). It is the ONE division
// added to the cart on step 2 — ADD_ENTRY seeds an individual entry with
// exactly one blank roster row (cart.ts's `blankPlayers`), the minimal
// shape that still reaches the date input. "Stepper Team" carries no age
// rule and is never added to the cart — it exists only so
// `openDivisions.length` is 2: steps.ts collapses the whole ENTRIES step
// to nothing when there is exactly ONE open division
// (`shouldCollapseEntries`), which would make step 2 unreachable. Neither
// division is self-linked ("I'm playing" stays off) — `guardianRequired`
// (step 4) keys off the CART's own self-link, not that toggle, so this
// keeps the guardian block off without needing a dob that also satisfies a
// real eligibility band for the contact. Both divisions are free
// (fee_cents: 0) — no Stripe/Connect fixture needed, and no `checkout_url`
// redirect risk (this test stops at the REVIEW frame; it never taps
// Submit).
// ---------------------------------------------------------------------------
test("register stepper: ENTRIES/DETAILS/CONSENT/REVIEW hold at this width, no horizontal scroll", async ({
  page,
  browser,
  request,
}) => {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Stepper ${TAG}-${projectTag()}`,
    visibility: "public",
  });
  expect(comp.status).toBeLessThan(300);

  // Everything below mutates the shared org (this competition + its two
  // divisions — see this test's header comment) and must be torn down even
  // when an assertion throws, so it all runs inside this `try`; the
  // `finally` deletes by `comp.data!.id`, captured above, never by name.
  try {
    const soloDiv = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Stepper Solo",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    expect(soloDiv.status).toBeLessThan(300);
    const soloDivisionId = soloDiv.data!.id;
    // Flips requires_dob true (requiresDob, @/lib/registration-rules) with no
    // real age restriction — see this test's header comment.
    const agePatch = await apiJson(request, `/api/v1/divisions/${soloDivisionId}`, "PATCH", { age_min: 0 });
    expect(agePatch.status).toBeLessThan(300);
    const soloSettings = await apiJson(
      request,
      `/api/v1/divisions/${soloDivisionId}/registration-settings`,
      "PUT",
      { enabled: true, entrant_kind: "individual", capacity: 10, fee_cents: 0, form_fields: [] },
    );
    expect(soloSettings.status).toBeLessThan(300);

    const teamDiv = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Stepper Team",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    expect(teamDiv.status).toBeLessThan(300);
    const teamSettings = await apiJson(
      request,
      `/api/v1/divisions/${teamDiv.data!.id}/registration-settings`,
      "PUT",
      { enabled: true, entrant_kind: "team", capacity: 10, fee_cents: 0, form_fields: [] },
    );
    expect(teamSettings.status).toBeLessThan(300);

    const org = await activeOrg(page);

    // Consent answered up front, as a person's first tap would: below `md` the register form's action bar is pinned to the same edge the
    // cookie banner sits on, with the banner ABOVE it (register-stepper.tsx), so an unanswered banner covers the bar's Back/Next.
    const anonCtx = await browser.newContext({
      viewport: projectViewport() ?? undefined,
      storageState: await consentedAnonymousState(),
    });
    try {
      const anon = await anonCtx.newPage();
      await anon.goto(`/live/${org.slug}/${comp.data!.slug}/register`, { waitUntil: "load" });
      await anon.waitForTimeout(300);

      // Step 1 — WHO. Two open divisions, one `requires_dob`, means
      // "I'm playing" is left off deliberately (see this test's header
      // comment), and `whoFieldRequirements` now gates the contact's OWN dob
      // on that toggle: a secretary entering a team is never a player, so the
      // server never asks for their dob (`PublicRegisterGroupRequest`'s
      // superRefine requires `contact.dob` only when some entry is
      // `registering_self`). Collecting it anyway was compulsory collection of
      // personal data the system never uses, on the step immediately before the
      // privacy-consent checkbox.
      //
      // This assertion is INVERTED rather than deleted: it used to demand the
      // field be visible, and it is the probe that catches the requirement
      // silently coming back. A `requires_dob` division still asks for every
      // PLAYER's dob at step 3 — that is what this test exercises below, and it
      // is unaffected.
      await expect(anon.locator("#reg-who-name")).toBeVisible({ timeout: 20_000 });
      await anon.locator("#reg-who-name").fill(`Mobile Stepper Contact ${TAG}`);
      await anon.locator("#reg-who-email").fill(`delivered+stepper-${TAG}-${projectTag()}@resend.dev`);
      await expect(
        anon.locator("#reg-who-dob"),
        "a contact who is not playing must NOT be asked for their own date of birth",
      ).toHaveCount(0);
      await anon.getByTestId("reg-next").click();

      // Step 2 — ENTRIES.
      await expect(anon.getByRole("heading", { name: "Choose your divisions", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await anon.getByRole("button", { name: "Add an entry", exact: true }).click();
      await expect(
        anon.getByRole("button", { name: "Remove", exact: true }),
        "adding the individual division must land one line in the cart",
      ).toBeVisible();
      await expectNoHorizontalScroll(anon);
      await anon.getByTestId("reg-next").click();

      // Step 3 — DETAILS. The point of this test: a requires_dob division's
      // roster row renders `input[type="date"]`, the widest control in the
      // whole flow, and it must fit at every width.
      await expect(anon.getByRole("heading", { name: "Player details", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      const rosterName = anon.getByPlaceholder("Full name");
      await expect(rosterName).toBeVisible();
      await rosterName.fill("Alex Roster");
      const rosterDob = anon.locator('input[type="date"]');
      await expect(
        rosterDob,
        "roster table must render a date input for a requires_dob division",
      ).toBeVisible();
      await rosterDob.fill("1990-05-15");
      const dobBox = await rosterDob.boundingBox();
      expect(dobBox, "roster date-of-birth input has no layout box").not.toBeNull();
      const vw = anon.viewportSize()?.width ?? 0;
      expect(
        dobBox!.x + dobBox!.width,
        "roster date-of-birth input right edge must stay within the viewport",
      ).toBeLessThanOrEqual(vw);
      await expectNoHorizontalScroll(anon);
      await anon.getByTestId("reg-next").click();

      // Step 4 — CONSENT. No self-link anywhere in the cart, so the guardian
      // block must be absent (guardianRequired keys off the cart's self-link,
      // not the WHO step's "I'm playing" toggle) — only privacy consent gates
      // "Next" here.
      await expect(anon.getByRole("heading", { name: "Consent", exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(anon.locator("#reg-guardian-name")).toHaveCount(0);
      await anon.locator("#reg-consent-privacy").check();
      await expectNoHorizontalScroll(anon);
      await anon.getByTestId("reg-next").click();

      // Step 5 — REVIEW. Final frame; deliberately never taps Submit (that
      // would POST the real registration and navigate away — out of scope for
      // a width-coverage test).
      await expect(anon.getByRole("heading", { name: "Review & pay", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(anon.getByText("Stepper Solo")).toBeVisible();
      await expectNoHorizontalScroll(anon);
    } finally {
      await anonCtx.close();
    }
  } finally {
    // Best-effort, unasserted cleanup: deletes by the exact id captured
    // above, never a name/prefix search, so this can never race or catch a
    // concurrent width project's own competition. Cascades both divisions
    // and their registration_settings rows (competition_id/division_id are
    // ON DELETE CASCADE), and is swallowed rather than asserted so a cleanup
    // hiccup can never mask a real failure from the try block above it.
    await apiJson(request, `/api/v1/competitions/${comp.data!.id}`, "DELETE").catch(() => undefined);
  }
});
