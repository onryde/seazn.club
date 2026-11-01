import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg, seedVenueWithCourts, setDateTime } from "./helpers";
import { dayLabel } from "../src/lib/day-label";

// PROMPT-33 item 4 (v3/04 §3), re-anchored for Competition Desk W2 (Task 4):
// the division fixtures page's run sheet groups fixtures by day, renders
// times in the COMPETITION (venue) timezone (browser pinned to Tokyo to
// prove it), pins unscheduled fixtures with an auto-schedule CTA, and an
// inline "Set time" save still grows the same notice+Undo affordance. The
// OLD "Edit time"-and-Undo flow this file used to drive from an
// ALREADY-SCHEDULED row is gone with the round-grouped list it lived on
// (Task 2's ladder gives a scheduled+timed row "Assign scorer"/"Score", never
// a reschedule control) — fix round 1 re-aims the same coverage at an
// UNSCHEDULED row's "Set time" instead of leaving it deleted: the mechanism
// (`RunSheetRow` -> `onRescheduled` -> `setUndoable(true)` -> `undoLast()`)
// survived the redesign untouched, and nothing else in the suite drove it as
// an INLINE reschedule (schedule-panels.spec.ts/open-scheduling.spec.ts cover
// the BOARD's Undo; ai-architect.spec.ts covers the AI-apply path).
test.use({ timezoneId: "Asia/Tokyo" });

test("the run sheet groups fixtures by day and prints them in the competition tz", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `DivSched ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  await apiJson(
    request,
    `/api/v1/divisions/${div.data!.id}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${div.data!.id}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const { courts } = await seedVenueWithCourts(request, ["Court 1"]);
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-09-15T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [courts[0]!.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  const gen = await apiJson<{ fixtures: { id: string; round_no: number; fixture_no: number }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  // Schedule all but one — the leftover pins to the unscheduled section.
  const ids = gen.data!.fixtures.map((f) => f.id);
  const base = Date.UTC(2026, 8, 15, 9, 0, 0);
  for (let i = 0; i < ids.length - 1; i++) {
    await apiJson(request, `/api/v1/fixtures/${ids[i]!}`, "PATCH", {
      scheduled_at: new Date(base + i * 60 * 60_000).toISOString(),
      court_id: courts[0]!.id,
    });
  }
  // Derived from the seed, not typed — a constant here would drift the
  // moment the seed's own `base` changed and stop witnessing the regression
  // this assertion exists for (Competition Desk W2, Task 4 supplement C6).
  const dayKey = new Date(base).toISOString().slice(0, 10);

  const org = await activeOrg(page);
  const url = `/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}?tab=fixtures`;
  await page.goto(url);

  // Round grouping (item 1) - Match Day E1 item 1: the stage card groups its rows under a header BAR per round ("Round 1 - 0 of 2 played - Tue 15
  // Sep - 09:00-10:00"). The bar names the round and, since the day headings left the stage card, the day the round is played on.
  const bars = page.getByTestId("run-sheet-round-bar");
  await expect(bars.first()).toBeVisible();
  await expect(bars.first()).toContainText("Round 1");
  // The day the seed put the fixtures on, derived from the seed (never a typed constant, so this stays a witness if the seed ever
  // moves), is on the first round's bar.
  await expect(page.locator("[data-run-sheet-round-dates]").first()).toContainText(dayLabel(dayKey, "en"));
  await expect(page.locator("[data-run-sheet-day]"), "no day headings in a stage card").toHaveCount(0);

  // Timezone honesty (item 2): competition tz caption (moved into the run
  // sheet's own filter segment, Task 4 supplement C2 - same testid), and the
  // 09:00Z fixture renders as nine o'clock ("09:00" or "9:00 AM") - NOT
  // 18:00/6:00 PM Tokyo browser time.
  await expect(page.getByTestId("tz-caption")).toHaveText("Times shown in UTC");
  await expect(page.getByText(/\b0?9:00/).first()).toBeVisible();
  await expect(page.getByText(/18:00|6:00\s?PM/)).toHaveCount(0);

  // The unscheduled leftover (item 3). Match Day E1 item 1 removed the "To schedule in this stage N ->" footer and the "Not yet scheduled"
  // group: the count is in the card's counts line, and the leftover row is in its round saying "No time yet".
  await expect(page.getByTestId("stage-progress-counts")).toContainText("1 to schedule");
  const leftover = gen.data!.fixtures.find((f) => f.id === ids[ids.length - 1]!)!;
  await expect(page.locator(`[data-fixture-no="${leftover.fixture_no}"]`)).toContainText("No time yet");
  await expect(page.getByText("Not yet scheduled"), "the group is gone").toHaveCount(0);
  await expect(page.getByText("To schedule in this stage"), "the footer is gone").toHaveCount(0);
  await expect(page.getByTestId("stage-unscheduled-count")).toHaveCount(0);

  // Inline "Set time" (item 5, re-aimed — fix round 1) -> notice grows an
  // Undo that restores the slot. The ONLY unscheduled fixture is the one
  // deliberately left untimed above (`ids[ids.length - 1]`) — its row is
  // scoped by `data-fixture-no`, the same stable per-fixture hook every other
  // spec in this file already keys off.
  const unscheduledFixture = gen.data!.fixtures.find((f) => f.id === ids[ids.length - 1]!)!;
  const targetRow = page.locator(`[data-fixture-no="${unscheduledFixture.fixture_no}"]`);
  await targetRow.getByRole("button", { name: "Set time", exact: true }).click();
  // The inline "When" field is a native date input + time <select> now, not
  // `input[type=datetime-local]` — Chrome's clock popup ignored `step`
  // (quarter-hour-time-select design doc). Only one row is ever "editing" at
  // once, so exactly one such pair is on the page here.
  await setDateTime(page, "2026-09-16T15:00");
  await targetRow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("schedule-undo")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("schedule-undo").click();
  await expect
    .poll(
      async () =>
        (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${unscheduledFixture.id}`))
          .data!.scheduled_at,
      { timeout: 15_000 },
    )
    .toBe(null);
});

// THE STAGING CRASH (#575), as a browser sees it.
//
// A division stored with an END date and NO start date is a legal, reachable
// shape: the settings schema allows either half alone, and staging held one.
// The fixtures tab's capacity pre-check then built a window of
// `{ from: -Infinity, to: <instant> }` and handed `-Infinity` to
// `Intl.DateTimeFormat.format`, which throws `RangeError: Invalid time value`
// — inside a render-phase `useMemo`, so React unwound the whole tree. Every
// tab of the page died, not just the panel that asked.
//
// The unit regressions live in `lib/__tests__/capacity-input.test.ts`; what
// they cannot show is the blast radius, because a thrown `useMemo` is not a
// null return. Only a rendered page proves the tab renders at all — and this
// exact stored shape is the one nobody had ever loaded.
//
// Deliberately NOT asserting the boundary copy is absent by string match: a
// boundary rendering here fails every assertion below anyway, and matching on
// its copy would rot the moment that copy is translated (which
// `c/[compSlug]/error.tsx` now is).
test("a division with an END date and no start date still renders its fixtures tab", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `EndOnly ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  await apiJson(
    request,
    `/api/v1/divisions/${div.data!.id}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${div.data!.id}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  // The crashing shape: `endAt` present, `startAt` absent entirely. Fixtures
  // are generated and left unscheduled, which is what puts the capacity
  // pre-check — the throw site — on screen in the first place.
  const { courts } = await seedVenueWithCourts(request, ["Court 1"]);
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/schedule-settings`, "PUT", {
    config: {
      endAt: "2026-09-20T22:59:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [courts[0]!.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");

  const org = await activeOrg(page);
  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}?tab=fixtures`);

  // The page rendered its own content — not a boundary, not a blank shell.
  // Match Day E1 item 1: the footer is gone; the unscheduled count is in the card's counts line.
  await expect(page.getByTestId("stage-progress-counts")).toContainText(/\d+ to schedule/);
  await expect(page.getByText("To schedule in this stage")).toHaveCount(0);
});
