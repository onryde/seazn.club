import { test, expect } from "@playwright/test";
import { apiJson, failOnNativeDialog, seedRosteredFixture } from "../helpers";
import {
  dismissConsent,
  freshOrg,
  stamp,
  uniqueName,
  waitForCourtRow,
  waitForHydration,
  waitForVenueCard,
} from "../directory-kit";

/**
 * A venue with THREE courts (venues.spec.ts has only ever made one), a
 * restricted per-court calendar typed into the panel, and the proof that the
 * restriction reached the SCHEDULER.
 *
 * ## What makes this more than a round trip
 *
 * The proof is the SAVE RESPONSE's `newlyStrandedFixtureCount`. That number is
 * computed server-side by `putCourtCalendar` (usecases/venues.ts) from the
 * engine's own `usableWindows` over the court's stored fixtures, as a SET
 * DIFFERENCE between the calendar as it stood before this write and the one
 * this write installed. Nothing the form typed can satisfy it: the form knows
 * about hours, and this is an answer about FIXTURES. A reload-and-compare —
 * which is all venues.spec.ts's calendar case does — would only prove the
 * hours survived the round trip.
 *
 * Three courts, and the calendar goes on the MIDDLE one, so a write that
 * reached the wrong court (or every court) reports 0 rather than 1.
 *
 * ## The advisory half is asserted through the API, not the board
 *
 * `outside_court_hours` is advisory BY DESIGN: `isBlockingConflict`
 * (packages/engine/src/scheduling/calendar.ts) carves it out explicitly, so an
 * organiser who narrows a court's hours under already-placed fixtures is never
 * hard-refused at publish. Asserting that the placer AVOIDS the closed window
 * would therefore fail against correct behaviour.
 *
 * So the claim is made where it can be stated directly: `ScheduleConflict`
 * carries `blocking`, and POST /divisions/{id}/schedule/validate returns it.
 * The board's copy for this conflict is already pinned by
 * court-tags-scheduling.spec.ts ("court clash", never the raw code); repeating
 * it here would duplicate that coverage while proving strictly less — the board
 * cannot say whether a conflict blocks.
 *
 * ## Time zones: why Wednesday 10:00 and why the org tz is WRITTEN, not assumed
 *
 * `strandedFixtureIdsFor` resolves the zone as `resolveVenueTz(null,
 * organizations.timezone)` — the ORG's zone, not the division's. A fresh org
 * has `timezone` NULL (createOrgForUser's insert names no zone; V305 added the
 * column with no default) and therefore falls back to UTC, but that is a
 * default this spec would be silently depending on: under a UTC+8 org, an
 * instant of Wednesday 10:00Z is Wednesday 18:00 LOCAL, i.e. INSIDE the window
 * typed in below, and the whole assertion would invert. So the zone is written
 * as part of setup rather than assumed, and every instant here is UTC.
 *
 * The weekday index is DERIVED from the fixed instant rather than typed beside
 * it (court-tags-scheduling.spec.ts's own idiom) — a hand-typed date and a
 * hand-typed weekday are two independent places to be wrong.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** 2026-11-04 is a Wednesday. 10:00 with the default `matchMinutes: 30`
 *  (ScheduleConfig) puts the fixture at 10:00-10:30, comfortably outside the
 *  18:00-20:00 window typed in below — the narrowing is what strands it, not
 *  merely the existence of a row. */
const FIXTURE_AT = new Date(Date.UTC(2026, 10, 4, 10, 0));
/** Sun = 0, matching the panel's own `[0,1,2,3,4,5,6].map(...)` weekday rows
 *  (venues-panel.tsx) and `court_hours.weekday`. */
const WEEKDAY = FIXTURE_AT.getUTCDay();

const OPEN_AT = "18:00";
const CLOSE_AT = "20:00";

test("three courts, restricted hours on the middle one, and the count the scheduler sends back", async ({
  page,
}) => {
  failOnNativeDialog(page);
  const s = stamp();
  const { orgId } = await freshOrg(page, "venues");
  // After freshOrg the page is on the app origin, so localStorage is writable.
  // The consent banner is a fixed z-40 overlay that intercepts clicks over the
  // LAST card on a page — and the add-court form of the last venue card is
  // exactly that.
  await dismissConsent(page);

  // Setup, deliberately through the API: see the docblock. This is the one
  // premise of the arithmetic below that a default could move underneath us.
  const tz = await apiJson(page.request, `/api/orgs/${orgId}`, "PATCH", { timezone: "UTC" });
  expect(tz.status, "could not pin the org's scheduling timezone").toBe(200);

  const venueName = uniqueName("Riverside Sports Centre");
  const courtNames = [uniqueName("Court A"), uniqueName("Court B"), uniqueName("Court C")];
  const restricted = courtNames[1]!;

  // --- A. a venue and THREE courts, all typed in ---------------------------
  await page.goto("/directory?tab=venues");
  const addVenue = page.getByRole("button", { name: "Add venue", exact: true });
  // Gate on hydration before the first interaction. A `fill` that lands on
  // server markup is undone the moment React takes the input over, and the
  // failure then reads as a slow page rather than a dropped keystroke.
  await waitForHydration(addVenue);

  await page.getByPlaceholder("e.g. Riverside Sports Centre").fill(venueName);
  await addVenue.click();
  const venueCard = await waitForVenueCard(page, venueName);

  for (const courtName of courtNames) {
    // Scoped to the venue card: there is one AddCourtForm per venue, and this
    // org will have exactly one card — but a page-scope lookup would be a
    // strict-mode violation the day a second venue joins the fixture.
    await venueCard.getByPlaceholder("e.g. Court 1").fill(courtName);
    await venueCard.getByRole("button", { name: "Add court", exact: true }).click();
    await waitForCourtRow(page, venueName, courtName);
  }

  // --- B. a fixture, placed on the MIDDLE court, inside the day the calendar
  //        below will close --------------------------------------------------
  //
  // Setup again: the fixture is the state this journey needs to REACH, not the
  // thing under test. `skipLineups` because nothing here scores — the two
  // lineup PUTs would be two round trips bought for nothing, and this test has
  // a 60s budget it must fit inside without `test.setTimeout`.
  const seeded = await seedRosteredFixture(page.request, {
    label: `Riverside ${s}`,
    sportKey: "badminton",
    variantKey: "bwf",
    home: [{ fullName: `Home ${s}` }],
    away: [{ fullName: `Away ${s}` }],
    entrantKind: "individual",
    skipLineups: true,
  });

  // The venues read NESTS its courts (`listVenues` returns `courts` per venue),
  // so this is one call, and asserting the count is what makes "three courts"
  // a claim about the UI rather than about this array's length.
  const venues = await apiJson<{ id: string; name: string; courts: { id: string; name: string }[] }[]>(
    page.request,
    `/api/v1/orgs/${orgId}/venues`,
    "GET",
  );
  const venue = (venues.data ?? []).find((v) => v.name === venueName);
  expect(venue, `the venue the panel just created is missing from GET /orgs/${orgId}/venues`).toBeDefined();
  expect(venue!.courts.map((c) => c.name)).toEqual(courtNames);
  const restrictedCourtId = venue!.courts.find((c) => c.name === restricted)!.id;

  // `PatchFixture` is `.strict()` — court_id and scheduled_at, nothing else.
  // A generated fixture is already `status = 'scheduled'` (V214's column
  // default), which is `MOVABLE_STATUS`, so this needs no auto/apply round
  // first; see the report for why the briefed premise said otherwise.
  const placed = await apiJson(page.request, `/api/v1/fixtures/${seeded.fixtureId}`, "PATCH", {
    court_id: restrictedCourtId,
    scheduled_at: FIXTURE_AT.toISOString(),
  });
  expect(placed.status, "could not place the fixture on the court under test").toBe(200);

  // --- C. restrict that court, in the panel --------------------------------
  const courtRow = await waitForCourtRow(page, venueName, restricted);
  await courtRow.getByRole("button", { name: "Hours", exact: true }).click();

  // One weekday row per day, in weekday order, so `.nth(WEEKDAY)` is Wednesday.
  await courtRow.getByRole("button", { name: "Add a time range", exact: true }).nth(WEEKDAY).click();

  // A new range opens at 09:00-17:00 (venues-panel.tsx's `onAddRange`), and the
  // two fields are `<select>`s whose options are "HH:MM" strings. Their labels
  // are a wrapping `<label>` + an `sr-only` span, NOT `htmlFor` — `getByLabel`
  // resolves ZERO matches for them (venues.spec.ts records the same finding);
  // `getByRole` against the same accessible name works.
  //
  // Counted before being driven rather than reached for with `.last()`: exactly
  // one range exists at this point, so a count of one is a statement that the
  // click above added a row to Wednesday and to nowhere else.
  const openField = courtRow.getByRole("combobox", { name: "Open", exact: true });
  const closeField = courtRow.getByRole("combobox", { name: "Close", exact: true });
  await expect(openField).toHaveCount(1);
  await expect(closeField).toHaveCount(1);
  await openField.selectOption(OPEN_AT);
  await closeField.selectOption(CLOSE_AT);

  // Registered BEFORE the click that fires it.
  const savePromise = page.waitForResponse(
    (r) => /\/courts\/[^/]+\/calendar$/.test(r.url()) && r.request().method() === "PUT",
  );
  await courtRow.getByRole("button", { name: "Save calendar", exact: true }).click();
  const saved = await savePromise;
  expect(saved.status()).toBe(200);
  const body = (await saved.json()) as {
    data?: { newlyStrandedFixtureCount: number; strandedFixtureCount: number };
  };

  // THE assertion. Pinned to 1, not `> 0`: this org owns exactly one fixture,
  // so 1 is the only right answer, and a reachability test satisfied by any
  // value would pass just as happily against a count that had started
  // reporting the whole org's board.
  expect(
    body.data?.newlyStrandedFixtureCount,
    "the calendar write stranded no fixture — the hours never reached the engine's window rule",
  ).toBe(1);
  expect(
    body.data?.strandedFixtureCount,
    "the court's own total disagrees with what this write caused, on a court whose only fixture this write stranded",
  ).toBe(1);

  // And the organiser is told. This is the same number rendered
  // (`venues.calendar.stranded`), so a response that carried it while the panel
  // swallowed it is a red here rather than a silent gap.
  await expect(
    courtRow.getByText(/1 scheduled fixture on this court now falls outside these hours/),
  ).toBeVisible();

  // --- D. the restriction came back from the SERVER ------------------------
  await page.reload();
  const reopened = await waitForCourtRow(page, venueName, restricted);
  await waitForHydration(reopened.getByRole("button", { name: "Hours", exact: true }));
  await reopened.getByRole("button", { name: "Hours", exact: true }).click();
  await expect(reopened.getByRole("combobox", { name: "Open", exact: true })).toHaveValue(OPEN_AT);
  await expect(reopened.getByRole("combobox", { name: "Close", exact: true })).toHaveValue(CLOSE_AT);

  // ONE weekday range closes the whole REST of the week, and the panel says so:
  // `baseFor` (engine court-windows.ts) reads an EMPTY calendar as the full
  // civil day, but once any row exists every weekday without one is closed. Six
  // days, because Wednesday now has a row.
  //
  // `exact: true` is load-bearing: the weekday copy is "Closed all day." WITH a
  // full stop and the exception checkbox is "Closed all day" WITHOUT one, so a
  // substring match cross-hits between two unrelated controls.
  await expect(reopened.getByText("Closed all day.", { exact: true })).toHaveCount(6);

  // --- E. the conflict is raised, and it is ADVISORY -----------------------
  const validated = await apiJson<{
    conflicts: { fixture_id: string; code: string; blocking: boolean; details?: { kind: string } }[];
  }>(page.request, `/api/v1/divisions/${seeded.divisionId}/schedule/validate`, "POST", {});
  expect(validated.status).toBe(200);
  const forFixture = (validated.data?.conflicts ?? []).filter((c) => c.fixture_id === seeded.fixtureId);
  const outsideHours = forFixture.filter((c) => c.details?.kind === "outside_court_hours");
  expect(
    outsideHours.length,
    `no outside_court_hours conflict was raised for the stranded fixture (got ${JSON.stringify(forFixture)})`,
  ).toBe(1);
  expect(
    outsideHours[0]!.blocking,
    "outside_court_hours is advisory by design (isBlockingConflict carves it out) — a blocking one is a behaviour change, not a stricter test",
  ).toBe(false);
  expect(
    forFixture.every((c) => c.blocking === false),
    "narrowing a court's hours under an already-placed fixture must never produce a BLOCKING conflict — that is the publish deadlock the carve-out exists to prevent",
  ).toBe(true);

  // ...and the fixture is still standing where it was put. "Not blocking" is a
  // claim about the report; this is the claim about the board.
  const after = await apiJson<{ court_id: string | null; status: string; scheduled_at: string }>(
    page.request,
    `/api/v1/fixtures/${seeded.fixtureId}`,
    "GET",
  );
  expect(after.data?.court_id).toBe(restrictedCourtId);
  expect(after.data?.status).toBe("scheduled");
});
