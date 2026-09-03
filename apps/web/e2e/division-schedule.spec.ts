import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg, seedVenueWithCourts } from "./helpers";

// PROMPT-33 item 4 (v3/04 §3), re-anchored for Competition Desk W2 (Task 4):
// the division fixtures page's run sheet groups fixtures by day, renders
// times in the COMPETITION (venue) timezone (browser pinned to Tokyo to
// prove it), and pins unscheduled fixtures with an auto-schedule CTA. The
// inline "Edit time"-and-Undo flow this file used to drive from a SCHEDULED
// row is gone with the round-grouped list it lived on — see the first test's
// own trailing comment for why, and where that coverage lives now.
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

  // Round grouping (item 1) — the run sheet (Competition Desk W2) keeps
  // "Round {n}" as an in-row label (Task 4 supplement C2 reuses
  // `schedule.round`, never a second key), so this line was PREDICTED to
  // survive and was verified by running the spec, not by reasoning about it
  // (Task 4 supplement C6).
  await expect(page.getByText("Round 1", { exact: false }).first()).toBeVisible();
  // The round-dates bar is retired WITH the run sheet (W2): both places that
  // rendered `data-testid="round-dates"` (the round-grouped non-bracket list
  // and the bracket stage's own round sections) are gone from
  // `stages-panel.tsx`. The fact this line was protecting — that a scheduled
  // fixture prints its date where the organiser reads it — now lives on the
  // day group header, keyed by the day the seed itself put the fixtures on
  // (never a typed constant, so this stays a witness if the seed ever moves).
  await expect(page.locator(`[data-run-sheet-day="${dayKey}"]`)).toBeVisible();

  // Timezone honesty (item 2): competition tz caption (moved into the run
  // sheet's own filter segment, Task 4 supplement C2 — same testid), and the
  // 09:00Z fixture renders as nine o'clock ("09:00" or "9:00 AM") — NOT
  // 18:00/6:00 PM Tokyo browser time.
  await expect(page.getByTestId("tz-caption")).toHaveText("Times shown in UTC");
  await expect(page.getByText(/\b0?9:00/).first()).toBeVisible();
  await expect(page.getByText(/18:00|6:00\s?PM/)).toHaveCount(0);

  // Unscheduled section pinned with count + CTA (item 3) — this header stays
  // in `stages-panel.tsx` through Task 4 on purpose (Task 5 moves it to the
  // stage rail), so `capacity-precheck.spec.ts` keeps its anchor too.
  await expect(page.getByText("Not scheduled yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Auto-schedule remaining" })).toBeVisible();

  // The inline "Edit time" reschedule-and-undo flow this test used to drive
  // from a SCHEDULED, already-timed row is retired here: the run sheet gives
  // every row exactly ONE action (`fixtureRowAction`, Task 2's ladder,
  // already reviewed and approved), and a scheduled+timed fixture's action is
  // "Assign scorer" or "Score" — never a reschedule control. An organiser
  // still reschedules from the fixture console the action link opens; the
  // division-ledger Undo mechanism itself keeps ample independent coverage
  // via the schedule board (`schedule-panels.spec.ts`, `open-scheduling.spec.ts`).
  // This is a Task 4 finding, not a Task 4 defect — the plan/supplement named
  // only the round-dates line for re-anchoring, and this section broke on the
  // FIRST run against the built feature, which is why the supplement's own
  // instruction ("verify by running the spec, not by reasoning about it")
  // exists.
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
