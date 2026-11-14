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
  const soloRegId = submitted.data!.entries.find((e) => e.division_id === soloDiv.data!.id)!.registration_id;

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

  // 4) The filter bar (B6 T20 + T21, spec §8) — ONE DOM, two faces. From md the
  //    A3 pill bar: each filter is a pill with a native <select> laid over it.
  //    Below md the pill row folds away; the bar is the search box, a Filters
  //    button with a count, a removable chip per set filter, and a bottom sheet
  //    (the house Modal) whose edits are staged until "Show registrants".
  //    Whichever face this width shows is driven END TO END — one select change
  //    and one × — because a markup test cannot see that a control is
  //    reachable (AGENTS.md class 22: the phone controls sit behind a fold, so
  //    the sheet is OPENED, never assumed open; the open is retried because a
  //    tap before React has attached is lost, not queued, and never doubled).
  const vw = projectViewport()?.width ?? 0;
  const hub = `/o/${org.slug}/c/${comp.data!.slug}/registration?tab=registrants`;
  const filters = page.locator("[data-registration-hub-registrant-filters]");
  const rowOf = (id: string) => page.locator(`[data-registration-hub-registrant-row][data-registration-id="${id}"]`);
  /** What is under a point, and which clear link (if any) it belongs to. */
  const hitAt = (x: number, y: number) =>
    page.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(px!, py!);
        return {
          tag: el?.tagName ?? null,
          name: el?.getAttribute("name") ?? null,
          clearOne: el?.closest("[data-filter-clear-one]")?.getAttribute("data-filter-clear-one") ?? null,
          chipClear: el?.closest("[data-chip-clear]")?.getAttribute("data-chip-clear") ?? null,
        };
      },
      [x, y] as const,
    );
  const kindFilter = (u: URL) => u.pathname.endsWith("/registration") && u.searchParams.get("kind");

  await expect(filters).toBeVisible();
  if (vw >= 768) {
    // 4a) The pill face. The phone row (Filters button, chips) is NOT shown.
    await expect(filters.locator("[data-filter-pill-row]")).toBeVisible();
    await expect(filters.locator("[data-filter-phone-row]")).toBeHidden();
    await expect(filters.locator("[data-filters-open]")).toBeHidden();
    await page.goto(`${hub}&kind=team`, { waitUntil: "load" });
    await expect(rowOf(teamRegId)).toBeVisible({ timeout: 20_000 });
    await expect(rowOf(soloRegId), "kind=team narrows the table").toHaveCount(0);

    // 4b) Each pill is 40px (spec §8) and its native select IS the pill's box —
    //     T20 shipped an overlay whose `absolute` could be deleted with every
    //     class test green (the select then measured 139px inside a 253px pill).
    const pill = filters.locator('[data-filter-pill="kind"]');
    const select = pill.locator("select");
    const pb = (await pill.boundingBox())!;
    const sb = (await select.boundingBox())!;
    expect(pb, "the kind pill is measurable").not.toBeNull();
    expect(sb, "the kind select is measurable").not.toBeNull();
    expect(pb.height, "pills are 40px tall from md").toBeGreaterThanOrEqual(40);
    for (const k of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(sb[k] - pb[k]), `select ${k} must equal the pill's (${sb[k]} vs ${pb[k]})`).toBeLessThanOrEqual(1);
    }
    // ...and the pointer lands where it should: on the select over the face, on
    // the × link over the select.
    const left = await hitAt(pb.x + 8, pb.y + pb.height / 2);
    expect(left, "a tap on the pill's left edge hits the select").toMatchObject({ tag: "SELECT", name: "kind" });
    const xb = (await pill.locator("[data-filter-clear-one]").boundingBox())!;
    const onX = await hitAt(xb.x + xb.width / 2, xb.y + xb.height / 2);
    expect(onX.clearOne, "a tap on the × hits the × link").toBe("kind");
    await expectNoHorizontalScroll(page);

    // 4c) One select change, end to end.
    await select.selectOption("individual");
    await page.waitForURL((u) => kindFilter(u) === "individual");
    await expect(rowOf(soloRegId)).toBeVisible({ timeout: 20_000 });
    await expect(rowOf(teamRegId), "kind=individual hides the team entry").toHaveCount(0);

    // 4d) One ×, end to end: it drops kind, keeps the rest of the address.
    await filters.locator('[data-filter-clear-one="kind"]').click();
    await page.waitForURL((u) => u.pathname.endsWith("/registration") && !u.searchParams.has("kind"));
    expect(new URL(page.url()).searchParams.get("tab"), "× stays on the Registrants tab").toBe("registrants");
    await expect(rowOf(teamRegId)).toBeVisible({ timeout: 20_000 });
    await expect(rowOf(soloRegId)).toBeVisible();
  } else {
    // 4a) The phone face. The pill row is folded away; the Filters button is the
    //     way in, 44px tall.
    const open = filters.locator("[data-filters-open]");
    // Scoped to THIS dialog: the cookie banner is not a Modal, but another dialog must never make this strict.
    const sheet = page.getByRole("dialog").filter({ has: page.locator("[data-filter-sheet-form]") });
    await expect(open).toBeVisible();
    await expect(filters.locator("[data-filter-pill-row]")).toBeHidden();
    await expect(filters.locator("[data-filter-phone-row]")).toBeVisible();
    const ob = (await open.boundingBox())!;
    expect(ob, "the Filters button is measurable").not.toBeNull();
    expect(ob.height, "the Filters button must stay a 44px touch target").toBeGreaterThanOrEqual(44);
    await expect(open.locator("[data-filters-count]"), "nothing set: no count").toHaveCount(0);
    await expect(sheet).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    const openSheet = async () => {
      await expect(async () => {
        if (!(await sheet.isVisible())) await open.click();
        await expect(sheet).toBeVisible({ timeout: 1_500 });
      }).toPass({ timeout: 20_000 });
    };

    // 4b) The sheet holds every filter and Sort, fits this width, and keeps its
    //     footer inside the viewport (nothing to scroll the PAGE for).
    await openSheet();
    for (const name of ["status", "division_id", "kind", "sort"]) {
      await expect(sheet.locator(`select[name="${name}"]`), `sheet select ${name}`).toBeVisible();
    }
    for (const name of ["free_agent", "consent_pending"]) {
      await expect(sheet.locator(`input[name="${name}"]`), `sheet switch ${name}`).toBeAttached();
    }
    const show = sheet.locator("[data-filter-sheet-show]");
    await expect(show).toBeVisible();
    const showBox = (await show.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(showBox.height, "Show registrants is a 44px target").toBeGreaterThanOrEqual(44);
    expect(showBox.y + showBox.height, "Show registrants is inside the viewport").toBeLessThanOrEqual(viewport.height);
    expect(showBox.x + showBox.width).toBeLessThanOrEqual(viewport.width);
    await expectNoHorizontalScroll(page);
    // The dialog is NAMED after its visible title (aria-labelledby -> the h3: axe's aria-dialog-name), its close button carries
    // a label, and its body does not chain a swipe to the page behind it (overscroll-contain).
    await expect(sheet, "the sheet is named after its title").toHaveAccessibleName("Filters");
    await expect(sheet.getByRole("button", { name: "Close" }), "the sheet's close button is named").toBeVisible();
    expect(
      await sheet.locator("[data-filter-sheet-form]").evaluate((form) => {
        const body = form.closest(".overflow-y-auto");
        return body ? getComputedStyle(body).overscrollBehaviorY : "no scrolling body";
      }),
      "the sheet's scrolling body contains its overscroll",
    ).toBe("contain");

    // 4c) Edits are STAGED: changing a select navigates nowhere, and closing the
    //     sheet (Escape) discards them and hands focus back to the button.
    const before = page.url();
    await sheet.locator('select[name="kind"]').selectOption("individual");
    await page.waitForTimeout(400); // a negative: an auto-submit would navigate within this
    expect(page.url(), "a staged edit must not navigate").toBe(before);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(open, "closing returns focus to the trigger").toBeFocused();
    expect(page.url()).toBe(before);
    await openSheet();
    await expect(sheet.locator('select[name="kind"]'), "a discarded edit is gone on reopen").toHaveValue("");

    // 4c') Reset empties what is staged, EVERY time it is pressed. A real browser never re-applies a default to a node React
    //      keeps, so a second press that kept its nodes left the second staged edit on screen (T21 review I-1) — which is
    //      only a bug a real <select> can show.
    const resetBtn = sheet.locator("[data-filter-sheet-reset]");
    const kindSelect = sheet.locator('select[name="kind"]');
    for (const [press, pick] of [["first", "individual"], ["second", "team"]] as const) {
      await kindSelect.selectOption(pick);
      await expect(kindSelect).toHaveValue(pick);
      await resetBtn.click();
      await expect(kindSelect, `${press} Reset empties the staged kind`).toHaveValue("");
    }
    expect(page.url(), "Reset navigates nowhere").toBe(before);

    // 4d) One select change, end to end: stage it, Show registrants applies it with ONE push.
    await sheet.locator('select[name="kind"]').selectOption("individual");
    await show.click();
    await page.waitForURL((u) => kindFilter(u) === "individual");
    await expect(sheet).toHaveCount(0);
    await expect(rowOf(soloRegId)).toBeVisible({ timeout: 20_000 });
    await expect(rowOf(teamRegId), "kind=individual hides the team entry").toHaveCount(0);
    await expect(filters.locator("[data-filters-open] [data-filters-count]")).toHaveText("1");

    // 4e) One chip ×, end to end — 44px, and the pointer reaches it.
    const chipX = filters.locator('[data-chip-clear="kind"]');
    await expect(chipX).toBeVisible();
    const cb = (await chipX.boundingBox())!;
    expect(cb.width, "the chip × is a 44px-wide target").toBeGreaterThanOrEqual(44);
    expect(cb.height, "the chip × is a 44px-tall target").toBeGreaterThanOrEqual(44);
    expect((await hitAt(cb.x + cb.width / 2, cb.y + cb.height / 2)).chipClear).toBe("kind");
    await expectNoHorizontalScroll(page);
    await chipX.click();
    await page.waitForURL((u) => u.pathname.endsWith("/registration") && !u.searchParams.has("kind"));
    await expect(rowOf(teamRegId)).toBeVisible({ timeout: 20_000 });
    await expect(rowOf(soloRegId)).toBeVisible();
    await expect(filters.locator("[data-filters-open] [data-filters-count]")).toHaveCount(0);
  }
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
      // "Review", not "Review and pay": this cart is one free entry, so nothing is charged (the heading says "and pay" only when it is).
      await expect(anon.getByRole("heading", { name: "Review", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(anon.getByText("Stepper Solo")).toBeVisible();
      await expectNoHorizontalScroll(anon);

      // The org header scrolls away on a phone while the register form is up, and only then (B2 T8, spec 7.2; B2 review m9). The rule is
      // a CSS `:has()` match no unit test can see, so it is read here as the browser computes it: `static` below the `md` breakpoint
      // (768px, the spec's own number) on the register flow, `sticky` from md up, and `sticky` at EVERY width on a page that is not the
      // register flow (the competition hub, under the same layout). The header keeps its `sticky` class in both states, so the locator
      // finds it either way and the computed `position` is the thing under test.
      const headerPosition = (page: typeof anon) =>
        page.locator("header.sticky").first().evaluate((el) => getComputedStyle(el).position);
      const PHONE_BELOW = 768;
      expect(
        await headerPosition(anon),
        `the org header on the register flow at ${vw}px (static below ${PHONE_BELOW}, sticky from it)`,
      ).toBe(vw < PHONE_BELOW ? "static" : "sticky");
      await anon.goto(`/live/${org.slug}/${comp.data!.slug}`, { waitUntil: "load" });
      expect(await headerPosition(anon), `the org header on a page that is not the register flow at ${vw}px: pinned at every width`).toBe(
        "sticky",
      );
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
