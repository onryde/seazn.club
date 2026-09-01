// RS011 — organiser-side eligibility gates, played BY HAND: an organiser adds
// an over-age person to a restricted division through the REAL roster-add
// UI, the override dialog appears, a reason-less retry stays blocked, and a
// reason-carrying override succeeds — with the audit trail to prove it.
//
// WHY THIS EXISTS. Before this session, a division's age/gender/category
// rules were enforced ONLY on the public registration path — every
// organiser-side write (add to roster, patch, sync, import, lineup) accepted
// an ineligible person silently, while the org panel's own hint copy
// ("Checked at roster add — organisers can override with a reason") had
// already shipped, describing behaviour that did not exist yet. A DB
// integration test proves `gateRosterEligibility` throws and audits
// correctly; it cannot prove the DIALOG actually opens, that its confirm
// button is genuinely disabled with no reason typed, or that the entrants
// table re-renders with the new row once the override lands. Only tapping
// it does.
//
// Setup uses the API to REACH a division with an age rule and to create the
// PERSON rows this walkthrough adds (the walkthrough charter permits that —
// the org's Players directory has its own coverage elsewhere). Every step
// that IS the thing under test — searching the picker, tapping "Add
// entrant", reading the dialog, typing the reason, confirming — is done
// through the UI.
import { expect, test } from "@playwright/test";
import {
  apiJson,
  divisionPath,
  eligibilityOverrideAuditRows,
  expectNoHorizontalScroll,
  screenshotAtWidths,
  TAG,
} from "../helpers";

const GENERIC_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

test.describe.configure({ mode: "serial" });

test("an over-age roster add is blocked, a reason-less retry stays blocked, and an audited override succeeds", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);

  // ---------------------------------------------------------------- setup
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Elig Cup ${TAG}`,
    visibility: "private",
    ends_on: "2030-12-31",
  });
  expect(comp.status, "could not create the competition this walkthrough needs").toBeLessThan(300);

  // U15: age_min/age_max, first-class columns (V364/V380 — no jsonb rule
  // left to type, see RS011's own scope notes).
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Under 15",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      age_min: 10,
      age_max: 15,
    },
  );
  expect(div.status).toBeLessThan(300);
  const divisionId = div.data!.id;

  // A person well outside the age band (dob makes them ~36 at today's date).
  const overAgeName = `Vet Player ${TAG}`;
  const overAge = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
    full_name: overAgeName,
    dob: "1990-01-01",
  });
  expect(overAge.status).toBeLessThan(300);

  // A second person with NO dob on file — the warning-only path below.
  const noDobName = `No Dob Player ${TAG}`;
  const noDob = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
    full_name: noDobName,
  });
  expect(noDob.status).toBeLessThan(300);

  const entrantsUrl = await divisionPath(request, divisionId, "?tab=entrants");
  await page.goto(entrantsUrl, { waitUntil: "load" });

  // The shared e2e org accumulates teams from OTHER specs, and the add form
  // defaults to "Existing team" mode once any exist (AddEntrantForm's own
  // `canExisting` effect) — force "New entrant" mode so the person-picker
  // flow below is reachable regardless of what earlier specs left behind.
  const newEntrantToggle = page.getByRole("button", { name: "New entrant", exact: true });
  if (await newEntrantToggle.isVisible().catch(() => false)) {
    await newEntrantToggle.click();
  }

  // ------------------------------------------------- add the over-age person
  await page.getByPlaceholder("Search players…").fill(overAgeName);
  await page.getByRole("button", { name: overAgeName, exact: true }).click();
  await page.getByRole("button", { name: "Add entrant", exact: true }).click();

  // ---------------------------------------------- the override dialog opens
  const dialog = page.getByRole("dialog");
  await expect(dialog, "the ELIGIBILITY_VIOLATION 422 never opened the override dialog").toBeVisible({
    timeout: 10_000,
  });
  await expect(dialog.getByText(/too old/i)).toBeVisible();
  await screenshotAtWidths(page, testInfo, "01-violation-dialog");
  await expectNoHorizontalScroll(page);

  // --------------------------- retry-without-reason stays blocked (disabled)
  const confirmBtn = page.getByTestId("eligibility-override-confirm");
  await expect(confirmBtn, "confirm must start disabled with no reason typed").toBeDisabled();
  const reasonBox = page.getByTestId("eligibility-override-reason");
  await reasonBox.fill("ab"); // below the 3-char floor
  await expect(confirmBtn, "a 2-character reason must not arm the override").toBeDisabled();

  // ------------------------------------------------------------- cancel it
  await page.getByTestId("eligibility-override-cancel").click();
  await expect(dialog).toBeHidden();
  // Nothing was created — the ledger, not the UI's own optimism, is the proof.
  const afterCancel = await apiJson<{ id: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
  );
  expect(
    afterCancel.data?.some((e) => e.display_name === overAgeName),
    "the cancelled dialog must not have created an entrant",
  ).toBe(false);

  // ---------------------------------------- retry, this time with a reason
  // The form cleared its picks when the first attempt resolved (cancel) —
  // re-select the same person, a real second tap, not a re-submit of stale
  // state.
  await page.getByPlaceholder("Search players…").fill(overAgeName);
  await page.getByRole("button", { name: overAgeName, exact: true }).click();
  await page.getByRole("button", { name: "Add entrant", exact: true }).click();
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  const reason = `Wildcard entry, organiser approved ${TAG}`;
  await page.getByTestId("eligibility-override-reason").fill(reason);
  await expect(confirmBtn).toBeEnabled();
  await screenshotAtWidths(page, testInfo, "02-override-reason-filled");
  await confirmBtn.click();

  await expect(dialog, "the override submit never closed the dialog").toBeHidden({ timeout: 10_000 });
  // Scoped to the entrants TABLE, not the page as a whole — the "Search
  // players…" picker above still renders a same-named pill for re-picking,
  // and an unscoped lookup would hit both.
  const entrantsTable = page.getByRole("table");
  await expect(entrantsTable.getByRole("button", { name: overAgeName })).toBeVisible({ timeout: 10_000 });
  await screenshotAtWidths(page, testInfo, "03-entrant-added-after-override");
  await expectNoHorizontalScroll(page);

  // ------------------------------------------ the audit trail, via the API
  // (the dialog/UI proof above is the tapped half; this reads the SYSTEM's
  // own record and confirms it agrees with what was tapped — the
  // walkthrough charter's rule. No admin surface lists this ledger, so a
  // direct read is the "your call" the brief allows for this one check).
  const rows = await eligibilityOverrideAuditRows(comp.data!.id);
  expect(rows, "expected exactly one eligibility.overridden audit row for this competition").toHaveLength(1);
  expect(rows[0]!.payload.reason).toBe(reason);
  expect(rows[0]!.payload.context).toBe("roster_add");

  // --------------------------------------------- warning-only: missing dob
  // Never blocks — no dialog, straight through. Proves MISSING_DOB stays
  // advisory on the organiser side even on the SAME age-restricted division
  // that just blocked a real violation above.
  await page.getByPlaceholder("Search players…").fill(noDobName);
  await page.getByRole("button", { name: noDobName, exact: true }).click();
  await page.getByRole("button", { name: "Add entrant", exact: true }).click();
  const noDobRow = entrantsTable.getByRole("button", { name: noDobName });
  await expect(noDobRow).toBeVisible({ timeout: 10_000 });
  await expect(dialog, "a missing-dob add must never open the override dialog").toBeHidden();

  // Expand that entrant's roster row — a real tap — and read the amber
  // MISSING_DOB chip the roster editor renders against this division's own
  // age band.
  await noDobRow.click();
  await expect(page.getByText(/missing date of birth/i)).toBeVisible({ timeout: 10_000 });
  await screenshotAtWidths(page, testInfo, "04-missing-dob-warning-chip");
  await expectNoHorizontalScroll(page);
});
