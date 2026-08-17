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

/**
 * The first `containerSelector` element (within `root`) that owns a
 * `label`-labelled control whose LIVE value equals `value`, or null.
 *
 * Deliberately built via plain Locator chaining (`.locator(css).nth(i)`)
 * rather than "find the input, then jump to its ancestor via
 * `xpath=ancestor::…`": measured live against this exact page — a Locator
 * reached through an xpath ancestor step resolves fine for an `aria-label`
 * lookup or a role's own text (`getByRole("button", {name:…})`), but a
 * SUBSEQUENT `getByLabel` for a WRAPPING `<label><span>…</span><select>`
 * association (no `aria-label`, no `for`/`id` — e.g. the calendar editor's
 * "Open"/"Close" selects) silently resolves to zero matches even though the
 * element is plainly present in `innerHTML()` — proven with a throwaway
 * `.count()`/`.isVisible()` probe before this fix landed. Scanning
 * CONTAINERS directly and reading each candidate's OWN value avoids the
 * xpath hop entirely, so every later `getByLabel`/`getByRole` on the
 * returned Locator composes normally. Reads `.inputValue()` (never a
 * `[value="…"]` CSS attribute selector) because React never reflects a
 * controlled input's live value onto the DOM attribute, only the property.
 */
async function findContainer(
  root: Page | Locator,
  containerSelector: string,
  label: string,
  value: string,
): Promise<Locator | null> {
  const containers = root.locator(containerSelector);
  const n = await containers.count();
  for (let i = 0; i < n; i++) {
    const candidate = containers.nth(i);
    const input = candidate.getByLabel(label);
    if ((await input.count()) > 0 && (await input.inputValue()) === value) return candidate;
  }
  return null;
}

async function findVenueCard(page: Page, venueName: string): Promise<Locator | null> {
  return findContainer(page, "section.card", "Venue name", venueName);
}

async function findCourtRow(
  page: Page,
  venueName: string,
  courtName: string,
): Promise<Locator | null> {
  const venueCard = await findVenueCard(page, venueName);
  if (!venueCard) return null;
  return findContainer(venueCard, "li", "Court name", courtName);
}

/** Waits (auto-retrying, so a real red is possible) for the venue card to
 *  exist, then returns it. */
async function waitForVenueCard(page: Page, venueName: string): Promise<Locator> {
  await expect
    .poll(async () => ((await findVenueCard(page, venueName)) ? 1 : 0), { timeout: 15_000 })
    .toBe(1);
  const card = await findVenueCard(page, venueName);
  if (!card) throw new Error(`venue card vanished for "${venueName}"`);
  return card;
}

async function waitForCourtRow(page: Page, venueName: string, courtName: string): Promise<Locator> {
  await expect
    .poll(async () => ((await findCourtRow(page, venueName, courtName)) ? 1 : 0), { timeout: 15_000 })
    .toBe(1);
  const row = await findCourtRow(page, venueName, courtName);
  if (!row) throw new Error(`court row vanished for "${courtName}" in venue "${venueName}"`);
  return row;
}

async function waitForCourtRowGone(
  page: Page,
  venueName: string,
  courtName: string,
): Promise<void> {
  await expect
    .poll(async () => ((await findCourtRow(page, venueName, courtName)) ? 1 : 0), { timeout: 15_000 })
    .toBe(0);
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
  // getByRole, not getByLabel: measured live — `getByLabel` resolves zero
  // matches for these WRAPPING `<label><span>…</span><select/input></label>`
  // associations (no `aria-label`, no `for`/`id`) even though the element is
  // plainly present (confirmed via `page.ariaSnapshot()`, which correctly
  // reports e.g. `combobox "Open"`) — a real `getByLabel` gap for implicit
  // wrapping-label association in this Playwright version, not a product
  // defect. `getByRole` against the SAME accessible name works.
  await courtRow.getByRole("button", { name: "Hours", exact: true }).click();
  await courtRow.getByRole("button", { name: "Add a time range", exact: true }).nth(1).click();
  await courtRow.getByRole("combobox", { name: "Open", exact: true }).selectOption("10:00");

  await courtRow.getByRole("button", { name: "Add an exception date", exact: true }).click();
  await courtRow.getByRole("textbox", { name: "Exception date", exact: true }).fill("2026-12-25");
  // Left `closed` checked (the default for a newly added exception) — a
  // holiday closure is the simplest genuine exception and needs no
  // open/close pair.

  await courtRow.getByRole("button", { name: "Save calendar", exact: true }).click();
  await expect(page.getByText("Calendar saved.")).toBeVisible({ timeout: 15_000 });

  // --- reload: everything above must come back from the SERVER, not local state ---
  await page.reload();
  courtRow = await waitForCourtRow(page, venueName, courtName);
  await courtRow.getByRole("button", { name: "Hours", exact: true }).click();
  await expect(courtRow.getByRole("combobox", { name: "Open", exact: true })).toHaveValue("10:00");
  await expect(
    courtRow.getByRole("textbox", { name: "Exception date", exact: true }),
  ).toHaveValue("2026-12-25");
  await expect(
    courtRow.getByRole("checkbox", { name: "Closed all day", exact: true }),
  ).toBeChecked();
  await expect(courtRow.getByRole("button", { name: "Remove indoor" })).toBeVisible();

  // --- archive the court: vanishes from the default (non-archived) view ---
  await courtRow.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive court", exact: true }).click();
  await expect(page.getByText("Court archived.")).toBeVisible({ timeout: 15_000 });
  await waitForCourtRowGone(page, venueName, courtName);

  // --- "Show archived" toggle brings it back, greyed with an Unarchive action ---
  // Also a wrapping label (`<label><input type=checkbox/>text</label>`) — getByRole, same reason as above.
  const showArchived = page.getByRole("checkbox", { name: "Show archived", exact: true });
  await showArchived.check();
  courtRow = await waitForCourtRow(page, venueName, courtName);
  await expect(courtRow.getByText("Archived", { exact: true })).toBeVisible();
  await expect(courtRow.getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();

  // --- unarchive: visible again even with the toggle back OFF (proves it is
  //     genuinely active again, not merely still shown because the toggle is on) ---
  await courtRow.getByRole("button", { name: "Unarchive", exact: true }).click();
  await expect(page.getByText("Court restored.")).toBeVisible({ timeout: 15_000 });
  await showArchived.uncheck();
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
