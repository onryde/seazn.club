// S2-4 Task 9 (CK-BC-1, MCC Law 17.8; preflight W4) — the public match centre over a split over.
//
// A mid-over bowler change splits over 1 between two bowlers. The commentary panel's over header lists both, in the
// order they bowled, and its ball lines name the over's bowlers joined (the engine records who bowled the over, not
// which ball each bowled: the plan's recorded spec gap), never the first bowler alone. Seeded through the API, read
// as a spectator would: an anonymous page on the competition's public fixture page.
import { test, expect } from "@playwright/test";
import { activeOrg, apiJson, createStageAndGenerate, TAG } from "./helpers";
import {
  anonPage,
  closeOpenContexts,
  divisionSlug,
  makeCricketDivision,
  makeTeams,
  mustPost,
  publicFixturePath,
  startCricketMatch,
  type Team,
} from "./spectator-public-helpers";

test.afterEach(closeOpenContexts);

test("S2-4 T9: the match centre's commentary names both bowlers of a split over", async ({ page, request, browser }) => {
  test.setTimeout(120_000);
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Split Over ${TAG}`,
    ends_on: "2026-12-31",
    visibility: "public",
  });
  if (!comp.data) throw new Error(`competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
  const divId = await makeCricketDivision(request, comp.data.id, { name: `Split ${TAG}`, ballsPerInnings: 12, playersPerSide: 4 });
  const teams = await makeTeams(request, divId, [
    { name: `Batters ${TAG}`, names: [1, 2, 3, 4].map((n) => `SO Bat ${n} ${TAG}`) },
    { name: `Bowlers ${TAG}`, names: [1, 2, 3, 4].map((n) => `SO Bowl ${n} ${TAG}`) },
  ]);
  const { fixtureIds } = await createStageAndGenerate(request, divId);
  await apiJson(request, `/api/v1/divisions/${divId}/start`, "POST");
  const fixtureId = fixtureIds[0]!;
  const [batters, bowlers] = teams as [Team, Team];
  await startCricketMatch(request, fixtureId, teams, batters);

  const [s1, s2] = batters.order as [string, string];
  const [first, second] = bowlers.order as [string, string];
  // Even runs only, so the crease never turns: s1 faces every ball.
  const ball = (ballInOver: number, bowler: string, bat: number) =>
    mustPost(request, fixtureId, "cricket.ball", { over: 0, ballInOver, striker: s1, nonStriker: s2, bowler, runs: { bat } });
  await ball(1, first, 2);
  await ball(2, first, 0);
  await ball(3, first, 4);
  await mustPost(request, fixtureId, "cricket.bowler.change", { bowler: second, reason: "incapacitated" });
  await ball(4, second, 0);
  await ball(5, second, 2);
  await ball(6, second, 0);

  const anon = await anonPage(browser, { width: 1280, height: 900 });
  await anon.goto(publicFixturePath(org.slug, comp.data.slug, await divisionSlug(request, divId), fixtureId));
  await anon.getByTestId("mc-tab-commentary").click();
  const over = anon.getByTestId("mc-over-1.1");
  await expect(over).toBeVisible({ timeout: 20_000 });
  const both = `SO Bowl 1 ${TAG} / SO Bowl 2 ${TAG}`;
  await expect(over.getByRole("heading"), "the header lists both bowlers, in order").toHaveText(`Over 1 · 8 runs · 8/0 · ${both}`);
  for (let n = 1; n <= 6; n++) {
    await expect(anon.getByTestId(`mc-ball-1.1.${n}`), `ball ${n} names the over's bowlers`).toContainText(both);
  }
});
