import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg, setDateTime, seedVenueWithCourts } from "./helpers";

// PROMPT-33 item 4 (v3/04 §3): the division fixtures page groups rounds with
// date ranges, renders times in the COMPETITION timezone (browser pinned to
// Tokyo to prove it), pins unscheduled fixtures with an auto-schedule CTA,
// and inline reschedule is undoable.
test.use({ timezoneId: "Asia/Tokyo" });

test("rounds group with dates, times honour the competition tz, reschedule undoes", async ({
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
  // C1: the inline-reschedule bait below moves a scheduled fixture to a LATER
  // day than every sibling still sitting at its original position. That is
  // only safe for the LAST round (see roundrobin-board-zero-slack memory) —
  // moving an EARLY round forward past untouched later-round siblings still
  // on day one is a genuine H6 round-order violation, which `ids[0]` (an
  // arbitrary, round-agnostic pick) risked tripping. Pick the highest
  // round_no among the SCHEDULED subset (excludes the one deliberately left
  // unscheduled above) instead.
  const latestScheduled = gen.data!.fixtures
    .filter((f) => f.id !== ids[ids.length - 1])
    .reduce((max, f) => (f.round_no > max.round_no ? f : max));

  const org = await activeOrg(page);
  const url = `/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}?tab=fixtures`;
  await page.goto(url);

  // Round grouping with the round's date range (item 1). The range text is
  // locale-formatted, so assert presence + the day-of-month rather than an
  // exact "15 Sep"/"Sep 15" ordering.
  await expect(page.getByText("Round 1", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("round-dates").first()).toContainText("15");

  // Timezone honesty (item 2): competition tz caption, and the 09:00Z fixture
  // renders as nine o'clock ("09:00" or "9:00 AM") — NOT 18:00/6:00 PM Tokyo
  // browser time.
  await expect(page.getByTestId("tz-caption")).toHaveText("Times shown in UTC");
  await expect(page.getByText(/\b0?9:00/).first()).toBeVisible();
  await expect(page.getByText(/18:00|6:00\s?PM/)).toHaveCount(0);

  // Unscheduled section pinned with count + CTA (item 3).
  await expect(page.getByText("Not scheduled yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Auto-schedule remaining" })).toBeVisible();

  // Inline reschedule (item 5) → notice grows an Undo that restores the slot.
  // `latestScheduled` (not `ids[0]`, see its own comment above) — scoped by
  // its public `/f/{no}` URL (`routes.fixture`), the one stable per-fixture
  // hook this row carries; there is no `data-fixture-id` on it.
  const before = (
    await apiJson<{ scheduled_at: string }>(request, `/api/v1/fixtures/${latestScheduled.id}`)
  ).data!.scheduled_at;
  const targetRow = page.locator("li").filter({
    has: page.locator(`a[href$="/f/${latestScheduled.fixture_no}"]`),
  });
  await targetRow.getByRole("button", { name: "Edit time" }).click();
  // The inline "When" field is a native date input + time <select> now, not
  // `input[type=datetime-local]` — Chrome's clock popup ignored `step`
  // (quarter-hour-time-select design doc). Only one row is ever "editing" at
  // once, so exactly one such pair is on the page here.
  await setDateTime(page, "2026-09-16T15:00");
  await targetRow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(
      async () =>
        (await apiJson<{ scheduled_at: string }>(request, `/api/v1/fixtures/${latestScheduled.id}`))
          .data!.scheduled_at,
      { timeout: 15_000 },
    )
    .toBe(before);
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
  await expect(page.getByText("Not scheduled yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Auto-schedule remaining" })).toBeVisible();
});
