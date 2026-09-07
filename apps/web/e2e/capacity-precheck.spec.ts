import { test, expect } from "@playwright/test";
import { apiJson, TAG, divisionPath, seedVenueWithCourts } from "./helpers";

// D2 capacity pre-check (design doc bench-product-value/designs/2026-08-13-
// capacity-precheck-design.md). Two things a unit/integration test cannot
// pin: the Settings-tab card actually renders in a real browser off a real
// GET, and the "Solve disabled" state a user hits lives on a DIFFERENT page
// (the fixtures/stages console) from the card that explains it — this spec
// is the one place that crosses both surfaces in one flow.
//
// AUTHORED, NOT RUN in this session (operating limit: no subagent may run
// the full e2e suite — 600s watchdog). The orchestrator runs it at the wave
// boundary; see the implementer's final report for what to verify first if
// it reds.
//
// Deliberately avoids `constraints`/`sessionWindows`/multi-court knobs, all
// of which flip `usesConstraints()` (schedule.ts) and gate the PUT behind
// Pro — this spec stays on the free tier by making 1 court + a single
// UNRESTRICTED day (no sessionWindows: "empty = unrestricted", the same
// rule the placer applies) arithmetically too small for an 8-entrant round
// robin: 28 fixtures, 1 court, 60-minute matches, one day = 24 raw slots.
// 28 > 24 is impossible without touching a single Pro-gated field.
const ENTRANTS = 8; // round robin -> C(8,2) = 28 fixtures
const DAY_ISO = "2026-09-12"; // arbitrary Saturday, no other fixture in this org touches it
const START_AT = `${DAY_ISO}T00:00:00.000Z`;
const END_AT = `${DAY_ISO}T23:59:00.000Z`; // ONE calendar day (org tz UTC by default)

async function seedTightRoundRobin(request: import("@playwright/test").APIRequestContext) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Capacity E2E ${TAG}`,
    visibility: "private",
  });
  const compId = comp.data!.id;
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Capacity",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divisionId = div.data!.id;
  await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    Array.from({ length: ENTRANTS }, (_, i) => ({
      kind: "individual",
      display_name: `E${i + 1}`,
      seed: i + 1,
    })),
  );
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  expect(gen.data!.fixtures.length).toBe(28);
  const { courts } = await seedVenueWithCourts(request, ["Court 1"]);
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    config: {
      startAt: START_AT,
      endAt: END_AT,
      matchMinutes: 60,
      gapMinutes: 0,
      courts: [courts[0]!.id],
      perEntrantMinRest: 0,
    },
  });
  expect(settings.status).toBeLessThan(300);
  return { divisionId, stageId: stage.data!.id };
}

test("capacity precheck: impossible config shows the card + disabled Solve + a reason", async ({ page, request }) => {
  const { divisionId, stageId } = await seedTightRoundRobin(request);

  // The card + verdict chip on the Settings tab.
  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=settings"));
  const card = page.locator('[data-capacity-verdict="impossible"]');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText("Won't fit")).toBeVisible();
  // At least one quantified suggestion row (design doc: "the cheapest fixes,
  // quantified" — never a bare "it's broken"). `.first()` because the card
  // emits SEVERAL suggestions sorted verdict-flippers-first; matching more
  // than one is the expected shape, and a bare locator trips strict mode.
  await expect(card.getByText(/Add 1 day|Add 1 Court|Shorten matches/).first()).toBeVisible();

  // Owner ruling (Task 2, "remove auto-schedule from the fixtures page"):
  // the Solve action no longer lives on the fixtures/stages console at all
  // — scheduling is Schedule-page-only now (ScheduleBoard/AutoScheduleMode),
  // so there is nothing left to disable here. This spec used to assert a
  // disabled `stage-auto-schedule` button + blocked-reason line on THIS
  // page; both are gone from stages-panel.tsx along with the CTA. What
  // remains true and worth pinning here: the fixtures page still surfaces
  // the unscheduled count as INFORMATION (kept per owner ruling — "the
  // fact", not "the action") and it leads to the Schedule page rather than
  // acting in place.
  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  const unscheduledLink = page.getByTestId("stage-unscheduled-count");
  await expect(unscheduledLink).toBeVisible({ timeout: 20_000 });
  await expect(unscheduledLink.locator("..")).toHaveAttribute("href", new RegExp(`/schedule$`));

  // Server is the authority, not just the UI (acceptance criteria) — the
  // SAME impossibility is refused at the API even if a client bypassed the
  // disabled button.
  const refused = await apiJson(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {
    only_unlocked: true,
  });
  expect(refused.status).toBe(422);
  expect(refused.error?.code).toBe("CAPACITY_IMPOSSIBLE");
});

test("capacity precheck: applying a suggestion clears the block", async ({ page, request }) => {
  const { divisionId } = await seedTightRoundRobin(request);

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=settings"));
  const card = page.locator('[data-capacity-verdict="impossible"]');
  await expect(card).toBeVisible({ timeout: 20_000 });

  // "Add 1 day" is a verdict-flipper for this exact fixture (28 fixtures,
  // 24 slots/day -> 2 days comfortably clears it) and its knob (`endAt`) is
  // local to this panel — apply it, then Save.
  await card.getByRole("button", { name: "Apply" }).first().click();
  // "Save settings" (boardset.save), not "Save" — verified against en/ui.json
  // rather than guessed, after an earlier draft of this spec got it wrong.
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 20_000 });

  // The card itself should no longer read impossible after the save+refresh
  // round trip (router.refresh() re-seeds this panel's draft state from the
  // new stored config).
  await expect(page.locator('[data-capacity-verdict="impossible"]')).toHaveCount(0, { timeout: 20_000 });

  // Owner ruling (Task 2): there is no more "Solve button re-enabled" to
  // check on the fixtures page — the Solve action lives on the Schedule
  // page only now, and this spec's job stops at the Settings-tab card,
  // which is the surface this test actually verifies.
});
