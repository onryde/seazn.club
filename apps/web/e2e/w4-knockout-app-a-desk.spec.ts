import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG, addEntrantsViaApi, apiJson, competitionPath, expectNoHorizontalScroll, fixturePath, scoreFixture } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { waitForHydration } from "./directory-kit";

// W4 app PR A, lane B-desk (Tasks 18 + 21). Whole file, never a -g slice (AGENTS.md rule 21).

const uiEn: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

interface Fx {
  id: string;
  stage_id: string;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind: string; winner?: string; loser?: string | null; reason?: string } | null;
}

async function divisionFixtures(request: APIRequestContext, divisionId: string): Promise<Fx[]> {
  const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(all.status, JSON.stringify(all.error)).toBe(200);
  return all.data ?? [];
}

/** A started generic knockout of four, both semis seated and unplayed. */
async function startedKnockout(request: APIRequestContext, label: string, visibility: "private" | "public" = "private") {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: `${label} ${TAG} ${Math.random().toString(36).slice(2, 6)}`, visibility,
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG,
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const names = [1, 2, 3, 4].map((i) => `${label} S${i} ${TAG}`);
  const added = await addEntrantsViaApi(request, div.data!.id, names, "individual");
  expect(added.ids).toHaveLength(4);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup" });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  expect((await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST")).status).toBe(200);
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBe(200);
  const semis = (await divisionFixtures(request, div.data!.id)).filter((f) => f.home_entrant_id && f.away_entrant_id);
  expect(semis, "premise: two seated semis").toHaveLength(2);
  return { compId: comp.data!.id, compSlug: comp.data!.slug, divisionId: div.data!.id, stageId: stage.data!.id, ids: added.ids, names, semis };
}

/** Play a `startedKnockout` out through the scoring API — both semis, then the final they seat — leaving its stage open
 *  (auto-advance off). Returns the final. */
async function playOut(request: APIRequestContext, k: Awaited<ReturnType<typeof startedKnockout>>): Promise<Fx> {
  for (const sf of k.semis) await scoreFixture(request, sf.id, 3, 1);
  let final: Fx | undefined;
  await expect
    .poll(async () => {
      final = (await divisionFixtures(request, k.divisionId)).find((f) => !k.semis.some((s) => s.id === f.id));
      return Boolean(final?.home_entrant_id && final?.away_entrant_id);
    }, { timeout: 30_000 })
    .toBe(true);
  await scoreFixture(request, final!.id, 3, 1);
  return final!;
}


test.describe("K12 a disqualification walkover is worded as one", () => {
  // W4 T18 (K12), driven first on the base build: the organiser console's Activity row read "Withdrawal recorded" for a
  // DQ cascade's walkover as for a withdrawal's — the console keyed its disqualified set by seat while the cascade's
  // `core.forfeit.by` names the ENTRANT. C12: the stored reason stays `withdrew` (the engine credits it; `disqualified`
  // is the after-play reason), so the wording comes from the side's status, never from a new reason.
  test('K12 a DQ walkover reads "Disqualification recorded"; a withdrawal still reads "Withdrawal recorded"', async ({ page, request }) => {
    test.setTimeout(180_000);
    const DQ = uiEn["pad.ribbon.core.forfeit.disqualified"];
    const WD = uiEn["pad.ribbon.core.forfeit.withdrew"];
    expect([DQ, WD], "the catalog declares both words").toEqual(["Disqualification recorded", "Withdrawal recorded"]);
    const k = await startedKnockout(request, "K12");
    const [sfA, sfB] = k.semis;
    const dqLoser = sfA!.away_entrant_id!;
    const wdLoser = sfB!.away_entrant_id!;
    const dqRes = await apiJson(request, `/api/v1/entrants/${dqLoser}`, "PATCH", { status: "disqualified" });
    expect(dqRes.status, JSON.stringify(dqRes.error)).toBe(200);
    const wdRes = await apiJson(request, `/api/v1/entrants/${wdLoser}/withdraw`, "POST", {});
    expect(wdRes.status, JSON.stringify(wdRes.error)).toBeLessThan(300);
    const after = await divisionFixtures(request, k.divisionId);
    const cases = [
      { label: "disqualification", sf: sfA!, loser: dqLoser, says: DQ!, never: WD! },
      { label: "withdrawal", sf: sfB!, loser: wdLoser, says: WD!, never: DQ! },
    ];
    for (const c of cases) {
      const row = after.find((f) => f.id === c.sf.id);
      // The credit is the withdrawal's, byte for byte, in both cases (C12): only the words differ.
      expect(row?.status, `${c.label}: the semi is walked`).toBe("forfeited");
      expect(row?.outcome, `${c.label}: the stored award`).toEqual({
        kind: "award", loser: c.loser, reason: "withdrew", winner: c.sf.home_entrant_id,
      });
      await page.goto(await fixturePath(request, c.sf.id));
      await dismissCookieBanner(page);
      const captions = page.locator('[data-role="v3-activity-caption"]');
      await expect(captions.filter({ hasText: c.says }), `${c.label}: the Activity row says "${c.says}"`).toHaveCount(1);
      await expect(captions.filter({ hasText: c.never }), `${c.label}: and never "${c.never}"`).toHaveCount(0);
    }
  });
});

const say = (key: string, vars: Record<string, string | number> = {}) =>
  uiEn[key]!.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

async function stageStatus(request: APIRequestContext, stageId: string): Promise<string> {
  const s = await apiJson<{ status: string }>(request, `/api/v1/stages/${stageId}`);
  expect(s.status, JSON.stringify(s.error)).toBe(200);
  return s.data!.status;
}

test.describe("X-CH-8 the desk asks to complete a finished bracket", () => {
  // W4 T21 (AN-1; owner pick R24 4A). Prod held an eight-entrant knockout whose seven matches were decided while its
  // stage stayed open (auto-advance off): nothing on the desk asked for Complete stage, and Complete competition went
  // through without a word. Now: a red "Final decided" row on the desk, and an inline warning under the settings Status
  // select that lists the open stage, offers its Complete stage, and never blocks Save.
  test("X-CH-8 a decided final raises its desk row; completing the competition warns, lists the stage, and still completes", async ({ page, request }) => {
    test.setTimeout(240_000);
    const k = await startedKnockout(request, "XCH8", "public");
    const final = await playOut(request, k);
    const all = await divisionFixtures(request, k.divisionId);
    expect(all.map((f) => f.status).sort(), "premise: all three decided").toEqual(["decided", "decided", "decided"]);
    expect(await stageStatus(request, k.stageId), "premise: auto-advance off leaves the stage open").toBe("active");
    const champion = k.names[k.ids.indexOf(final.home_entrant_id!)]!;

    // The desk: ONE red row naming the stage, whose action is the fixtures tab's Complete stage.
    const compPath = await competitionPath(request, k.compId);
    await page.goto(compPath);
    await dismissCookieBanner(page);
    const row = page.locator('[data-attention="final_decided"]');
    await expect(row, "the desk raises the row").toHaveCount(1);
    await expect(row).toContainText(say("desk.needsYou.final_decided", { division: "Open", stage: "Cup" }));
    // Dual mobile/desktop DOM: `:visible` picks whichever copy this width renders.
    await expect(page.locator('[data-pill="final_decided"]:visible').first(), "the division's pill reads it, not Finished").toBeVisible();

    // A false premise of the brief, pinned: the public hub already crowns a decided bracket BEFORE its stage completes.
    const orgSlug = compPath.split("/")[2]!;
    const hub = `/live/${orgSlug}/${k.compSlug}?tab=knockout`;
    await page.goto(hub);
    await expect(page.locator('[data-testid^="mh-knockout-champion-"]').first(), "crowned before completion").toContainText(champion);

    // Settings: choosing Completed shows the warning at once (before Save) listing exactly this stage.
    await page.goto(await competitionPath(request, k.compId, "/settings"));
    await dismissCookieBanner(page);
    const warning = page.getByTestId("compset-open-stages");
    await expect(warning).toHaveCount(0);
    const status = page.locator("select").filter({ has: page.locator('option[value="completed"]') });
    await status.selectOption("completed");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(uiEn["compset.openStages.heading.one"]!.replace("{count}", "1"));
    await expect(warning.locator("[data-open-stage]"), "exactly the one open stage").toHaveCount(1);
    const stageRow = warning.locator(`[data-open-stage="${k.stageId}"]`);
    await expect(stageRow).toContainText(say("compset.openStages.row", { division: "Open", seq: 1, stage: "Cup" }));
    await expect(stageRow).toContainText(uiEn["compset.openStages.state.final_decided"]!);
    await expect(status, "the select is described by the warning").toHaveAttribute("aria-describedby", /compset-open-stages-warning/);
    for (const w of [320, 768, 1280]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expectNoHorizontalScroll(page);
    }

    // Save is never blocked: the competition completes with the stage still open.
    await page.getByRole("button", { name: uiEn["compset.save"]! }).click();
    await expect
      .poll(async () => (await apiJson<{ status: string }>(request, `/api/v1/competitions/${k.compId}`)).data?.status, { timeout: 30_000 })
      .toBe("completed");
    expect(await stageStatus(request, k.stageId), "Save completed the competition, not the stage").toBe("active");

    // Its Complete stage completes it through the existing route; the warning then has nothing left to list.
    await page.reload();
    await expect(warning, "saved as completed with a stage open: the warning shows on arrival").toBeVisible();
    // A click on server-rendered markup before React hydrates is silently dropped (directory-kit.ts).
    const completeStage = stageRow.locator(`[data-complete-stage="${k.stageId}"]`);
    await waitForHydration(completeStage);
    await completeStage.click();
    await expect.poll(() => stageStatus(request, k.stageId), { timeout: 30_000 }).toBe("complete");
    await expect(warning).toHaveCount(0);

    // The desk row is gone, and the hub still crowns the same champion.
    await page.goto(compPath);
    await expect(page.locator('[data-attention="final_decided"]')).toHaveCount(0);
    await page.goto(hub);
    await expect(page.locator('[data-testid^="mh-knockout-champion-"]').first()).toContainText(champion);
  });

  test("X-CH-8 the wrap-up door: past its end date, Mark it completed lists the open stage too, and still completes", async ({ page, request }) => {
    // B-desk review I1: the competition page's wrap-up prompt is a second, one-tap door to `completed`.
    test.setTimeout(240_000);
    const k = await startedKnockout(request, "XCH8W", "public");
    await playOut(request, k);
    // The prompt shows once the end date is past its grace; set after play, so no score meets a past end date.
    const endsOn = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const ended = await apiJson(request, `/api/v1/competitions/${k.compId}`, "PATCH", { ends_on: endsOn });
    expect(ended.status, JSON.stringify(ended.error)).toBe(200);
    await page.goto(await competitionPath(request, k.compId));
    await dismissCookieBanner(page);
    const prompt = page.locator('section[aria-labelledby="wrapup-title"]');
    const warning = prompt.getByTestId("compset-open-stages");
    await expect(warning).toContainText(uiEn["comp.wrapUp.openStagesBody"]!);
    await expect(warning.locator(`[data-open-stage="${k.stageId}"]`)).toContainText(uiEn["compset.openStages.state.final_decided"]!);
    const mark = prompt.getByRole("button", { name: uiEn["comp.wrapUp.complete"]! });
    await expect(mark, "Mark it completed is described by the warning").toHaveAttribute("aria-describedby", "wrapup-open-stages");
    for (const w of [320, 768, 1280]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expectNoHorizontalScroll(page);
    }
    await waitForHydration(mark);
    await mark.click();
    await expect
      .poll(async () => (await apiJson<{ status: string }>(request, `/api/v1/competitions/${k.compId}`)).data?.status, { timeout: 30_000 })
      .toBe("completed");
    expect(await stageStatus(request, k.stageId), "it completed the competition, not the stage").toBe("active");
    await expect(prompt, "answered: the prompt is gone").toHaveCount(0);
  });
});
