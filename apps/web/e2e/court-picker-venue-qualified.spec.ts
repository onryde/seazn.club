import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { TAG, apiJson, divisionPath, seedVenueWithCourts, activeOrgIdFromRequest } from "./helpers";

// P9 review wave 2, findings 6 + 13 — the court multi-picker on
// `/schedule?tab=settings`.
//
// A court name is unique only WITHIN its venue (V367's
// `courts_venue_name_active_idx` is scoped per venue), so two venues may each
// legally name one "Court 1". Before this pass the picker rendered the bare
// `court.name` in the selected-order strip, which made those two courts
// indistinguishable at the exact moment the organiser is choosing between
// them — and `resolveCourtNames` built its map from the non-archived venue
// list, so an archived court that still holds a placed fixture rendered as a
// raw uuid instead of a name.
//
// The unit tests cover both rules directly. What they cannot cover is the
// thing the repo's UI bar is actually about: that the longer, qualified label
// still fits. Qualification makes every one of these strings longer ("Court 1"
// -> "Court 1 (Riverside Centre)"), and the narrowest supported width is where
// a longer label stops fitting — so this runs the same surface at 1280, 768
// and 320 and requires no horizontal page scroll at any of them.
//
// Screenshots are written for a human to look at, but they are NOT the
// assertion: a shot nobody opens proves nothing, so the no-scroll check and
// the distinct-label check are what fail the run.
const SHOTS = process.env.COURT_PICKER_SHOTS_DIR ?? null;

/** The three widths the project mandates for any user-facing surface. */
const WIDTHS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "tablet-768", width: 768, height: 1000 },
  { name: "mobile-320", width: 320, height: 800 },
] as const;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === null) return;
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
}

test("court picker: two venues sharing a court name stay distinguishable at every width", async ({
  page,
  request,
}) => {
  const orgId = await activeOrgIdFromRequest(request);

  // The premise. Both venues get a court called exactly "Court 1"; the second
  // venue also gets a uniquely-named one, so the run still proves that an
  // UNAMBIGUOUS name is left bare rather than qualified for everybody.
  // Deliberately PREFIX-SHARING. Two venues whose names diverge early would
  // pass even with a single truncating label, because the clip happens to
  // fall after the difference — the assertion would then be luck, not
  // coverage. These two differ only at the very end.
  const venueA = `Riverside Centre ${TAG}`;
  const venueB = `Riverside Hall ${TAG}`;
  // TAG-unique court names. The ambiguity under test is the SAME name in two
  // different venues — not the literal string "Court 1", which CI's shared Pro
  // org already carries several of from other specs (`seedVenueWithCourts`
  // defaults to it). Without this the option locator matched four checkboxes
  // and picked two courts this test never created.
  const shared = `Shared Court ${TAG}`;
  const solo = `Solo Court ${TAG}`;
  await seedVenueWithCourts(request, [shared], { orgId, venueName: venueA });
  await seedVenueWithCourts(request, [shared, solo], { orgId, venueName: venueB });

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Court Picker Widths ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Widths Division",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );

  await page.goto(await divisionPath(page.request, div.data!.id, "/schedule?tab=settings"));

  // The OPTION list is grouped by venue, with a venue heading above each
  // group and the bare court name on each checkbox — so the two "Court 1"s
  // are told apart there by their heading. That is unchanged by this pass and
  // is asserted here only as the premise: there really are two of them.
  const options = page.getByRole("checkbox", { name: shared, exact: true });
  await expect(options).toHaveCount(2);
  // `.first()`: each venue name now appears TWICE on this surface — as the
  // option list's group heading and, once selected, as the strip's own venue
  // line. Without it this is a strict-mode violation rather than an assertion.
  await expect(page.getByText(venueA, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(venueB, { exact: true }).first()).toBeVisible();

  // Select both. The SELECTED-ORDER STRIP is the surface finding 13 is about:
  // it is flat and UNHEADED, so a bare `court.name` there renders the two
  // courts as identical text at the exact moment the organiser is ordering
  // them. It must carry the venue-qualified label instead.
  await options.nth(0).check();
  await options.nth(1).check();

  // Scoped by the reorder control, which ONLY the selected-order strip has —
  // the option rows are list items carrying the same court text, so a bare
  // `getByRole("listitem")` matches both lists (it resolved to 4, not 2).
  const strip = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: "Move up" }) });
  // Scoped to the seeded name: a bare list-item count is hostage to anything
  // else on the page that happens to be reorderable.
  await expect(strip.filter({ hasText: shared })).toHaveCount(2);
  await expect(strip.filter({ hasText: venueA })).toHaveCount(1);
  await expect(strip.filter({ hasText: venueB })).toHaveCount(1);

  // The unambiguous court keeps its BARE name — qualification is applied where
  // it is needed, not sprayed across every court. Without this the assertions
  // above would also pass a blanket "always append the venue" implementation.
  await page.getByRole("checkbox", { name: solo, exact: true }).check();
  const showCourt = strip.filter({ hasText: solo });
  await expect(showCourt).toHaveCount(1);
  // The unambiguous court carries NO venue line at all.
  await expect(showCourt).not.toContainText("Riverside");

  for (const v of WIDTHS) {
    await page.setViewportSize({ width: v.width, height: v.height });
    // Let the layout settle before measuring it.
    await page.waitForTimeout(200);

    // Still distinguishable after the reflow — a strip that truncated both
    // labels back to "Court 1…" would defeat the fix at exactly the width
    // where it matters most.
    await expect(strip.filter({ hasText: venueA })).toHaveCount(1);
    await expect(strip.filter({ hasText: venueB })).toHaveCount(1);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow, `horizontal page scroll at ${v.width}px`).toBe(false);

    await shot(page, `court-picker-${v.name}`);
  }
});
