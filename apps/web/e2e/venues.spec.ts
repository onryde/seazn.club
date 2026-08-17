import { test, expect, type APIRequestContext, type Page, type Locator } from "@playwright/test";
import { TAG, apiJson, activeOrg, failOnNativeDialog } from "./helpers";

// P8/D5a acceptance (design doc + amendment log:
// docs/superpowers/specs/bench-product-value/designs/2026-08-13-venues-courts-design.md):
// venue/court CRUD, tag a court, weekly hours + one exception day surviving a
// reload, archive/unarchive behind the "Show archived" toggle (A5), and the
// division required_court_tags picker (A5/P8) surviving a reload — the exact
// thing that caught the picker's PATCH being silently stripped by
// PatchDivision earlier the same session (fixed on this branch before this
// spec was written).
//
// venues-panel.tsx ships almost no data-testid hooks (persons-panel.tsx's own
// convention) — locators below are aria-label/placeholder/role based.
// Several accessible names REPEAT across levels by design: "Venue name" is
// both the add-venue form's field label AND every venue card's edit-name
// aria-label; "Court name" the same one level down; "Archive"/"Save" repeat
// at venue and court level. Every lookup below is therefore either (a) a
// placeholder unique to the add-forms, or (b) scoped to one venue
// card/court row found by matching an input's LIVE value, never by a bare
// `getByLabel` at page scope. TAG is per-process, not globally unique
// (helpers.ts) and this org may be shared with other specs/projects — every
// created name carries a random suffix too so two parallel runs can never
// collide on the same (org, name).

function uniqueName(label: string): string {
  return `${label} ${TAG}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The first labelled input (within `root`) whose LIVE value equals `value`,
 *  or null. Deliberately reads `.inputValue()` rather than matching a
 *  `[value="…"]` CSS attribute selector — React never reflects a controlled
 *  input's live value onto the DOM attribute, only the property, so an
 *  attribute selector would silently match nothing. */
async function findByLabelValue(
  root: Page | Locator,
  label: string,
  value: string,
): Promise<Locator | null> {
  const inputs = root.getByLabel(label);
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    if ((await inputs.nth(i).inputValue()) === value) return inputs.nth(i);
  }
  return null;
}

async function venueCardCount(page: Page, venueName: string): Promise<number> {
  return (await findByLabelValue(page, "Venue name", venueName)) ? 1 : 0;
}

async function findVenueCard(page: Page, venueName: string): Promise<Locator> {
  const input = await findByLabelValue(page, "Venue name", venueName);
  if (!input) throw new Error(`venue card not found for "${venueName}"`);
  return input.locator("xpath=ancestor::section[contains(@class,'card')][1]");
}

/** Waits (auto-retrying, so a real red is possible) for the venue card to
 *  exist, then returns it. */
async function waitForVenueCard(page: Page, venueName: string): Promise<Locator> {
  await expect
    .poll(() => venueCardCount(page, venueName), { timeout: 15_000 })
    .toBe(1);
  return findVenueCard(page, venueName);
}

async function courtRowCount(page: Page, courtName: string): Promise<number> {
  // Court names are unique per test (uniqueName), so scanning the whole page
  // (rather than one venue's subtree) is enough and also doubles as the
  // "gone after archive" check without needing to resolve the venue card.
  return (await findByLabelValue(page, "Court name", courtName)) ? 1 : 0;
}

async function findCourtRow(page: Page, venueName: string, courtName: string): Promise<Locator> {
  const venueCard = await findVenueCard(page, venueName);
  const input = await findByLabelValue(venueCard, "Court name", courtName);
  if (!input) throw new Error(`court row not found for "${courtName}" in venue "${venueName}"`);
  return input.locator("xpath=ancestor::li[1]");
}

async function waitForCourtRow(page: Page, venueName: string, courtName: string): Promise<Locator> {
  await expect.poll(() => courtRowCount(page, courtName), { timeout: 15_000 }).toBe(1);
  return findCourtRow(page, venueName, courtName);
}

async function waitForCourtRowGone(page: Page, courtName: string): Promise<void> {
  await expect.poll(() => courtRowCount(page, courtName), { timeout: 15_000 }).toBe(0);
}

test("venue + court CRUD: tags, calendar survives a reload, archive behind the toggle", async ({
  page,
}) => {
  test.setTimeout(120_000);
  failOnNativeDialog(page);
  const venueName = uniqueName("Riverside Sports Centre");
  const courtName = uniqueName("Court A");

  await page.goto("/directory?tab=venues");

  // --- create venue ---
  // "Venue name" is ALSO every venue card's edit-name aria-label — the
  // placeholder is unique to this add form, so fill by placeholder.
  await page.getByPlaceholder("e.g. Riverside Sports Centre").fill(venueName);
  await page.getByRole("button", { name: "Add venue", exact: true }).click();
  const venueCard = await waitForVenueCard(page, venueName);
  await expect(venueCard).toBeVisible();

  // --- add a court ---
  await venueCard.getByPlaceholder("e.g. Court 1").fill(courtName);
  await venueCard.getByRole("button", { name: "Add court", exact: true }).click();
  let courtRow = await waitForCourtRow(page, venueName, courtName);
  await expect(courtRow).toBeVisible();

  // --- tag the court ---
  await courtRow.getByLabel("Type a tag and press Enter").fill("indoor");
  await courtRow.getByLabel("Type a tag and press Enter").press("Enter");
  await expect(courtRow.getByRole("button", { name: "Remove indoor" })).toBeVisible();

  // --- weekly hours (Monday, index 1 of the 7 Sun..Sat rows) + one exception day ---
  await courtRow.getByRole("button", { name: "Hours", exact: true }).click();
  await courtRow.getByRole("button", { name: "Add a time range", exact: true }).nth(1).click();
  await courtRow.getByLabel("Open", { exact: true }).selectOption("10:00");

  await courtRow.getByRole("button", { name: "Add an exception date", exact: true }).click();
  await courtRow.getByLabel("Exception date", { exact: true }).fill("2026-12-25");
  // Left `closed` checked (the default for a newly added exception) — a
  // holiday closure is the simplest genuine exception and needs no
  // open/close pair.

  await courtRow.getByRole("button", { name: "Save calendar", exact: true }).click();
  await expect(page.getByText("Calendar saved.")).toBeVisible({ timeout: 15_000 });

  // --- reload: everything above must come back from the SERVER, not local state ---
  await page.reload();
  courtRow = await waitForCourtRow(page, venueName, courtName);
  await courtRow.getByRole("button", { name: "Hours", exact: true }).click();
  await expect(courtRow.getByLabel("Open", { exact: true })).toHaveValue("10:00");
  await expect(courtRow.getByLabel("Exception date", { exact: true })).toHaveValue("2026-12-25");
  await expect(courtRow.getByLabel("Closed all day", { exact: true })).toBeChecked();
  await expect(courtRow.getByRole("button", { name: "Remove indoor" })).toBeVisible();

  // --- archive the court: vanishes from the default (non-archived) view ---
  await courtRow.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive court", exact: true }).click();
  await expect(page.getByText("Court archived.")).toBeVisible({ timeout: 15_000 });
  await waitForCourtRowGone(page, courtName);

  // --- "Show archived" toggle brings it back, greyed with an Unarchive action ---
  await page.getByLabel("Show archived", { exact: true }).check();
  courtRow = await waitForCourtRow(page, venueName, courtName);
  await expect(courtRow.getByText("Archived", { exact: true })).toBeVisible();
  await expect(courtRow.getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();

  // --- unarchive: visible again even with the toggle back OFF (proves it is
  //     genuinely active again, not merely still shown because the toggle is on) ---
  await courtRow.getByRole("button", { name: "Unarchive", exact: true }).click();
  await expect(page.getByText("Court restored.")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Show archived", { exact: true }).uncheck();
  courtRow = await waitForCourtRow(page, venueName, courtName);
  await expect(courtRow).toBeVisible();
  await expect(courtRow.getByText("Archived", { exact: true })).toHaveCount(0);
});

async function seedDivision(request: APIRequestContext, name: string) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: uniqueName("Court Tags Cup"),
    visibility: "public",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  return { compSlug: comp.data!.slug, divSlug: div.data!.slug };
}

test("division required_court_tags picker persists across a reload", async ({ page, request }) => {
  test.setTimeout(90_000);
  const org = await activeOrg(page);
  const rig = await seedDivision(request, "Clay Courts");
  const base = `/o/${org.slug}/c/${rig.compSlug}/d/${rig.divSlug}`;

  await page.goto(`${base}?tab=settings`);
  await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: 20_000 });

  const tagsGroup = page.getByRole("button", { name: /Required court tags/ });
  await tagsGroup.click();
  await page.getByLabel("Type a tag and press Enter").fill("clay");
  await page.getByLabel("Type a tag and press Enter").press("Enter");
  await expect(page.getByRole("button", { name: "Remove clay" })).toBeVisible();

  await page.getByRole("button", { name: "Save requirement", exact: true }).click();
  await expect(page.getByText("Requirement saved.")).toBeVisible({ timeout: 15_000 });

  // Reload: this is the exact regression a stripped PatchDivision field
  // hides — the chip would still show pre-reload (it's local state) but
  // come back empty once the server is asked again.
  await page.reload();
  await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: 20_000 });
  // Collapsed by default; the Group's own summary is `requiredCourtTags.join(", ")`
  // when non-empty — a read of what the SERVER has stored, not local state.
  await expect(page.getByRole("button", { name: /Required court tags/ })).toContainText("clay");

  await page.getByRole("button", { name: /Required court tags/ }).click();
  await expect(page.getByRole("button", { name: "Remove clay" })).toBeVisible();
});
