import { expect, test } from "@playwright/test";
import {
  activeOrg, apiJson, TAG, createCompetitionViaUi, createDivisionViaUi, addEntrantsViaApi,
  scoreFixture, setFixtureStatusSql, setStageStatusSql, screenshotAtWidths, expectNoHorizontalScroll,
  orgTimezoneSql,
} from "../helpers";
import { zoneDateKey } from "../zone-split";

test.describe.configure({ mode: "serial" });

test("an organiser watches the desk go Setting up → Scheduled → Match day → No scorer → Finished, and every button lands where it says", async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  const shot = (name: string) => page.screenshot({ path: `${testInfo.outputPath()}/${name}.png`, fullPage: true });
  const org = await activeOrg(page);

  // 1. Blank competition, made by hand.
  const compId = await createCompetitionViaUi(page, `Desk Walk ${TAG}`, "public");
  const comp = await apiJson<{ slug: string }>(request, `/api/v1/competitions/${compId}`, "GET");
  const compPath = `/o/${org.slug}/c/${comp.data!.slug}`;
  await page.goto(compPath);
  await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
  await expect(page.getByTestId("desk-ledger-row")).toHaveCount(0);
  await shot("01-blank");

  // 2. One division, made by hand: the row appears with its sport glyph and Setting up.
  // "generic" explicitly — the wizard's unset default is alphabetically
  // first ("badminton", individual/pair only, division-builder.tsx has no
  // separate entrant-kind picker) and step 3 needs a TEAM division whose
  // fixtures step 6's scoreFixture (event type "generic.result") can settle;
  // "football" satisfies the first but 422s "unknown event type
  // generic.result" on the second (confirmed by running this spec) — the
  // generic sport module is what mobile.spec.ts's own team registration
  // fixture (sport_key "generic", variant_key "score") uses for the same
  // reason.
  const divId = await createDivisionViaUi(page, compId, "Premier", "generic");
  await page.goto(compPath);
  const row = page.getByTestId("desk-ledger-row").first();
  await expect(row).toHaveAttribute("data-phase", "setting_up");
  await expect(row).toContainText("Setting up");
  await expect(row.locator("span[aria-hidden]").first()).not.toHaveText(/^[A-Z]$/); // glyph or logo, never a monogram
  await shot("02-setting-up");

  // 3. Reach: entrants + generated fixtures (API). Read: Needs you names the unscheduled round.
  const entrantsRes = await addEntrantsViaApi(request, divId, ["Riverside FC", "Valley CC", "Lakeside FC", "Harbour CC"], "team");
  if (entrantsRes.status >= 300) throw new Error(`entrants failed: ${entrantsRes.status} ids=${JSON.stringify(entrantsRes.ids)}`);
  // The wizard's own Scheduling step (createDivisionViaUi) already defines
  // the stage graph on create — a manual POST .../stages at seq 1 here 409s
  // "stage seq 1 already exists" (confirmed by running this spec). Read the
  // stage the wizard made instead of declaring a second one.
  const stages = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divId}/stages`, "GET");
  if (!stages.data?.[0]) throw new Error(`no stage on ${divId}: ${stages.status} ${JSON.stringify(stages.error)}`);
  const stage = { data: stages.data[0] };
  // No GET /api/v1/divisions/{id}/fixtures route exists (checked against
  // src/app/api/v1/divisions/[id]/* — no fixtures subroute) — the generate
  // response itself carries the created fixtures (FixtureRow[], stages.ts),
  // id + fixture_no included, so read the ids from there instead.
  const gen = await apiJson<{ fixtures: { id: string; fixture_no: number }[] }>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  if (!gen.data) throw new Error(`generate failed: ${gen.status} ${JSON.stringify(gen.error)}`);
  const startRes = await apiJson(request, `/api/v1/divisions/${divId}/start`, "POST");
  if (startRes.status >= 300) throw new Error(`start failed: ${startRes.status} ${JSON.stringify(startRes.error)}`);
  const fixtures = gen.data!.fixtures;
  const ids = fixtures.map((f) => f.id);
  await page.goto(compPath);
  // F1 fix (final review, Critical): generated fixtures with no time on
  // them read setting_up (with the unscheduled attention), never
  // "scheduled" — the old rule 5 read "scheduled" here while the row's own
  // status line said "nothing scheduled" next to it, the exact
  // contradiction the reviewer found live at this step and this spec
  // PHOTOGRAPHED without reading.
  await expect(row).toHaveAttribute("data-phase", "setting_up");
  const needs = page.getByTestId("desk-needs-you");
  await expect(needs.locator('[data-attention="unscheduled"]')).toContainText(`${ids.length} fixtures unscheduled`);
  // Toothless-guard fix: the row is actually READ here now, not just
  // photographed. It must state its played progress AND the unscheduled
  // count, and never the live defect copy ("nothing scheduled") beside
  // either.
  await expect(row).toContainText(`0 of ${ids.length} played`);
  await expect(row).toContainText(`${ids.length} unscheduled`);
  await shot("03-unscheduled");
  await needs.getByRole("link", { name: "Open schedule board" }).click();
  await expect(page).toHaveURL(/\/schedule$/);

  // 3b. Reach: one fixture given a real time next week (API PATCH). Read:
  // Scheduled. F1's fix means the walkthrough no longer passes through
  // "Scheduled" by accident (that was the bug — step 3 above used to read
  // "scheduled" with nothing actually scheduled); this step is what
  // legitimately puts a fixture in the future so the phase is genuinely
  // earned, keeping this test's own title ("Setting up → Scheduled → Match
  // day → …") true of the journey it drives.
  // Minor 2 (fix round G), same class as 3c below: derived from `now`, never
  // from a pinned UTC hour. A week out is comfortably in the future and
  // comfortably not today in every zone on earth, so this one was never
  // actually broken — but a wall-clock hour in a fixture is the shape that
  // has now cost this wave three defects, so it does not stay in the file.
  const nextWeek = new Date(Date.now() + 7 * 24 * 3600_000);
  await apiJson(request, `/api/v1/fixtures/${ids[0]}`, "PATCH", { scheduled_at: nextWeek.toISOString() });
  await page.goto(compPath);
  await expect(row).toHaveAttribute("data-phase", "scheduled");

  // 3c. Reach: the SAME fixture re-dated into the PAST, still unresulted
  // (API PATCH). Read: a past kick-off is never "Next", and Needs You
  // explains why instead. Coverage gap (fix round D): the walkthrough
  // ladder ran unscheduled -> future -> today -> in-play -> decided and
  // never "dated in the past, no result" — exactly the state G1 broke live:
  // "Next Tue 1 Sep 11:00 · 0 of 6 played · 5 unscheduled" printed directly
  // beside a Needs-you row reading "result missing … the match window has
  // passed" for the SAME fixture, on the same screen. Confirmed to FAIL
  // against the pre-fix build (fix-round-d-report.md) before the source fix
  // landed.
  // Minor 2 (fix round G), the J1 class again: this used to build YESTERDAY's
  // UTC calendar date at 11:00Z. `match_day` is bucketed in the division's own
  // venue zone (H1), and at UTC+13/+14 "yesterday 11:00Z" is TODAY locally —
  // so this step would have exercised the match_day rung rather than the
  // past-kick-off one, silently, while every assertion below it still read
  // plausibly. `now - 24h` is the same wall-clock time yesterday in EVERY
  // zone, so it is yesterday-and-past by construction, with no window.
  const yesterday = new Date(Date.now() - 24 * 3600_000);
  await apiJson(request, `/api/v1/fixtures/${ids[0]}`, "PATCH", { scheduled_at: yesterday.toISOString() });
  await page.goto(compPath);
  // The row must never claim this past kick-off as "Next" — division-
  // status-line.ts's G1 fix (a `now` floor the `scheduled` arm never had).
  await expect(row).not.toContainText("Next ");
  await expect(row).toContainText(`0 of ${ids.length} played`);
  // Needs You must explain WHY — result_missing on the exact fixture.
  await expect(needs.locator('[data-attention="result_missing"]')).toBeVisible();
  await shot("03c-past-kickoff-no-result");

  // 4. Reach: kick-off today (API PATCH). Read: Match day.
  //
  // J1 class (fix round F): this used to be `new Date()` with
  // `setUTCHours(18, 0, 0, 0)` — "today at 18:00 UTC". `match_day` is bucketed
  // in the division's OWN zone (H1: the venue zone, which with no
  // schedule_settings.tz falls back to the org's), and 18:00Z is only "today"
  // there while that zone's offset keeps it on the same date. The shared Pro
  // org's `timezone` is null (= UTC) most of the time, which is why this
  // passed — but it is the very column `competition-desk.spec.ts`'s zone tests
  // and `org-management.spec.ts` both write, and a leak leaves it on
  // Europe/London, at which point this step is dead from 23:00Z to midnight
  // (and from 18:30Z on an Asia/Kolkata org). A fixture whose construction
  // depends on the wall clock is a scheduled outage, so it is derived from
  // `now` in the org's real zone instead: an hour ahead when that is still the
  // same local day, and `now` itself otherwise — which is today in every zone
  // by definition. Total, with no window.
  const bucketTz = (await orgTimezoneSql(org.id)) ?? "UTC";
  const anHourOut = new Date(Date.now() + 3600_000);
  const today = zoneDateKey(anHourOut, bucketTz) === zoneDateKey(new Date(), bucketTz)
    ? anHourOut
    : new Date();
  await apiJson(request, `/api/v1/fixtures/${ids[0]}`, "PATCH", { scheduled_at: today.toISOString() });
  await page.goto(compPath);
  await expect(row).toHaveAttribute("data-phase", "match_day");
  await expect(page.locator('[data-phase="match_day"]').first()).toBeVisible();
  await shot("04-match-day");

  // 5. Reach: in play, nobody scoring (SQL). Read: No scorer leads, and the button lands on the fixture.
  await setFixtureStatusSql(ids[0]!, "in_play");
  await page.goto(compPath);
  await expect(needs.locator("[data-attention]").first()).toHaveAttribute("data-attention", "no_scorer");
  // Division ledger row renders its PhasePill twice (mobile card + desktop
  // row, division-ledger.tsx) — one hidden by CSS per width. `:visible`
  // picks whichever copy actually renders at this project's viewport, same
  // fix registration-hub.spec.ts's statusLocator uses for the identical
  // dual-DOM shape.
  await expect(row.locator('[data-pill="no_scorer"]:visible')).toBeVisible();
  // F4 (round J) changed what the organiser reads here, on purpose. This step
  // used to assert the masthead printed "1 in play" while the row underneath
  // it said "No scorer" — the calm summary above the alarmed row that this
  // whole wave exists to remove. The masthead now obeys the same model rule
  // the rows always have (a RED attention outranks the phase), so at this
  // moment in the journey the top of the page says "No scorer" too.
  //
  // The phase itself is unchanged and still asserted: the competition IS in
  // play, and a change to the phase ladder would still be caught here. What
  // moved is only which of the two facts gets the words.
  const masthead = page.getByTestId("desk-masthead-pill");
  await expect(masthead).toHaveAttribute("data-phase", "in_play");
  await expect(masthead).toHaveAttribute("data-pill", "no_scorer");
  await expect(masthead).not.toContainText("in play");
  await shot("05-no-scorer");
  // M2 (fix round I): the action used to read "Assign scorer" — a control
  // that exists nowhere in the product (`createAssignment` has no production
  // caller; `scorer_assignments` is written only by accepting a scoped
  // invite, which no UI creates). It now asks for the thing that IS on the
  // console it lands on: the pad.
  await needs.getByRole("link", { name: "Open scoring" }).click();
  await expect(page).toHaveURL(new RegExp(`/f/${fixtures[0]!.fixture_no}$`));
  // `toHaveURL` alone is the shape that could not see instances 9 to 12 —
  // it proves the address, never the screen. `competition-desk-actions.spec.ts`
  // sweeps all six labels to their controls; this one line keeps the
  // walkthrough honest about the step it just took.
  await expect(page.locator('[data-role="console-scoring"]')).toBeVisible();

  // 6. Reach: every result in, stage complete (API + SQL). Read: Finished, nothing needs the organiser.
  await setFixtureStatusSql(ids[0]!, "scheduled");
  for (const id of ids) await scoreFixture(request, id, 2, 1);
  await setStageStatusSql(stage.data!.id, "complete");
  await page.goto(compPath);
  await expect(row).toHaveAttribute("data-phase", "finished");
  await expect(row).toContainText("complete");
  await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
  await shot("06-finished");

  // 7. The page holds at every width, in this final state.
  await screenshotAtWidths(page, testInfo, "07-final-widths");
  await expectNoHorizontalScroll(page);
});
