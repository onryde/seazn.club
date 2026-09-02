import { expect, test } from "@playwright/test";
import {
  activeOrg, apiJson, TAG, createCompetitionViaUi, createDivisionViaUi, addEntrantsViaApi,
  scoreFixture, setFixtureStatusSql, setStageStatusSql, screenshotAtWidths, expectNoHorizontalScroll,
} from "../helpers";

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
  await expect(row).not.toContainText(/nothing scheduled/i);
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
  const nextWeek = new Date(); nextWeek.setUTCDate(nextWeek.getUTCDate() + 7); nextWeek.setUTCHours(10, 0, 0, 0);
  await apiJson(request, `/api/v1/fixtures/${ids[0]}`, "PATCH", { scheduled_at: nextWeek.toISOString() });
  await page.goto(compPath);
  await expect(row).toHaveAttribute("data-phase", "scheduled");

  // 4. Reach: kick-off today (API PATCH). Read: Match day.
  const today = new Date(); today.setUTCHours(18, 0, 0, 0);
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
  await expect(page.locator('[data-phase="in_play"]').first()).toContainText("1 in play");
  await shot("05-no-scorer");
  await needs.getByRole("link", { name: "Assign scorer" }).click();
  await expect(page).toHaveURL(new RegExp(`/f/${fixtures[0]!.fixture_no}$`));

  // 6. Reach: every result in, stage complete (API + SQL). Read: Finished, nothing needs the organiser.
  await setFixtureStatusSql(ids[0]!, "scheduled");
  for (const id of ids) await scoreFixture(request, id, 2, 1);
  await setStageStatusSql(stage.data!.id, "complete");
  await page.goto(compPath);
  await expect(row).toHaveAttribute("data-phase", "finished");
  await expect(row).toContainText("complete");
  await expect(row).not.toContainText("Nothing scheduled");
  await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
  await shot("06-finished");

  // 7. The page holds at every width, in this final state.
  await screenshotAtWidths(page, testInfo, "07-final-widths");
  await expectNoHorizontalScroll(page);
});
