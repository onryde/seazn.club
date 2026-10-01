import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG, apiJson, addEntrantsViaApi, divisionPath, scoreFixture } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

/**
 * A stage added with "Add stage" is an `on_complete` progression stage: it
 * gets no fixtures until the stage before it completes, and the server
 * refuses Generate until then (STAGE_NOT_READY, reason
 * "previous_stage_incomplete"). Owner-approved "Option 1, wording only":
 *
 *  - the empty card names the stage it is waiting on, instead of "generate
 *    them when entrants are registered";
 *  - an early Generate is an AMBER notice naming both stages, instead of the
 *    server's English sentence in a red banner. The Generate button itself
 *    stays clickable (Option 2 was declined) — this spec presses it.
 *
 * The unit suite (stages-panel-progression-wait.test.tsx) pins the
 * classifier and the card against fixtures; this is the seam those cannot
 * see: the REAL server refusal, through the real envelope, into the real
 * banner — then the source completing and the message going away.
 */

/** The shipped English copy, read the way competition-desk-actions.spec.ts
 *  reads it: a JSON `import` needs an import attribute Playwright's loader
 *  does not supply. Never an English literal retyped here. */
const en: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
const fill = (key: string, vars: Record<string, string>) => {
  const tpl = en[key];
  expect(tpl, `en/ui.json has no ${key}`).toBeTruthy();
  return tpl!.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
};

// The body AddStageForm POSTs (`addStageProgression(4)` in stages-panel.tsx,
// whose shape stages-panel-add-stage-progression.test.tsx pins). Copied, not
// imported: stages-panel.tsx pulls JSON dictionaries this loader refuses.
const ADD_STAGE_PROGRESSION = {
  sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
  placement: "rank_order",
  timing: "on_complete",
};

// Distinct names, neither a substring of the other, so "named the wrong
// stage" is a different sentence rather than a lucky match.
const SOURCE = "Round Robin";
const WAITING = "Cup Finals";

type Fx = { id: string; home_entrant_id: string | null; away_entrant_id: string | null };

async function leagueWithWaitingFinals(request: APIRequestContext) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `AddStage wait ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
    ends_on: "2030-12-31",
  });
  expect(comp.status, "create competition").toBe(201);
  // `generic`/`score` — one sport is enough here: the copy and the refusal are
  // sport-agnostic (the server's pre-flight reads timing + seq + status only).
  const div = await apiJson<{ id: string; slug: string }>(
    request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
    { name: "Cup", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  expect(div.status, "create division").toBe(201);
  const entrants = await addEntrantsViaApi(request, div.data!.id, ["Seed1", "Seed2", "Seed3", "Seed4"]);
  expect(entrants.ids, "four entrants").toHaveLength(4);
  const league = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST",
    { seq: 1, kind: "league", name: SOURCE });
  expect(league.status, "create league stage").toBe(201);
  const gen = await apiJson<{ fixtures: Fx[] }>(request, `/api/v1/stages/${league.data!.id}/generate`, "POST");
  expect(gen.status, "generate league fixtures").toBe(200);
  // A 4-entrant single round robin is C(4,2) = 6 matches.
  expect(gen.data?.fixtures ?? [], "a 4-entrant round robin").toHaveLength(6);
  const finals = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
    seq: 2, kind: "knockout", name: WAITING, config: {}, progression: ADD_STAGE_PROGRESSION,
  });
  expect(finals.status, "add the on_complete finals stage").toBe(201);
  return {
    divisionId: div.data!.id,
    leagueId: league.data!.id,
    finalsId: finals.data!.id,
    fixtures: gen.data!.fixtures,
    entrantIds: entrants.ids,
  };
}

/** Strictly ordered standings (earlier seed always wins) so the finals seed
 *  without a tie to resolve. Counts what it scored: a silently empty list
 *  would otherwise pass as "scored everything". */
async function scoreInSeedOrder(request: APIRequestContext, fixtures: Fx[], entrantIds: string[]) {
  const rank = new Map(entrantIds.map((id, i) => [id, i]));
  let scored = 0;
  for (const f of fixtures) {
    const h = rank.get(f.home_entrant_id ?? "");
    const a = rank.get(f.away_entrant_id ?? "");
    expect(h, "home entrant is not one of this division's").not.toBeUndefined();
    expect(a, "away entrant is not one of this division's").not.toBeUndefined();
    await scoreFixture(request, f.id, h! < a! ? 2 : 0, h! < a! ? 0 : 2);
    scored += 1;
  }
  expect(scored, "every league fixture scored").toBe(fixtures.length);
}

/** The stage card whose header reads "<seq>. <name>". */
function stageCard(page: Page, seq: number, name: string) {
  return page.locator("section.card").filter({ has: page.getByRole("heading", { name: `${seq}. ${name}`, exact: true }) });
}

test.describe("Add stage: a stage waiting on its source says so", () => {
  test("the empty card names the source; an early Generate is amber and named; completing the source draws it", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const rig = await leagueWithWaitingFinals(request);
    await page.goto(await divisionPath(request, rig.divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);

    const finals = stageCard(page, 2, WAITING);
    const league = stageCard(page, 1, SOURCE);
    await expect(finals, "the finals card").toHaveCount(1);
    await expect(league, "the league card").toHaveCount(1);

    // ---- 1. the empty card names the stage it waits on.
    const awaiting = fill("schedule.noFixtures.awaitingCan", { stage: SOURCE });
    await expect(finals.getByTestId("stage-no-fixtures")).toHaveText(awaiting);
    // The league HAS fixtures, so the waiting card is the only empty line.
    await expect(page.getByTestId("stage-no-fixtures")).toHaveCount(1);
    await expect(page.getByText(en["schedule.noFixtures.can"]!, { exact: true })).toHaveCount(0);

    // ---- 2. pressing Generate early: the REAL refusal, then an amber notice.
    const generate = finals.getByTestId("stage-generate");
    await expect(generate, "Generate stays clickable (Option 2 declined)").toBeEnabled();
    const expected = fill("schedule.error.previousStageIncomplete", { source: SOURCE, stage: WAITING });
    for (const press of [1, 2]) {
      // Second press too: a refusal must not stack banners or flip to red.
      const refusal = page.waitForResponse(
        (r) => r.url().endsWith(`/api/v1/stages/${rig.finalsId}/generate`) && r.request().method() === "POST",
      );
      await generate.click();
      const res = await refusal;
      expect(res.status(), `press ${press}: the server refuses`).toBe(422);
      const body = (await res.json()) as { error?: Record<string, unknown> };
      expect(body.error, `press ${press}: the envelope carries the reason and both ids`).toMatchObject({
        code: "STAGE_NOT_READY",
        reason: "previous_stage_incomplete",
        stageId: rig.finalsId,
        previousStageId: rig.leagueId,
      });
      const warning = page.getByTestId("schedule-warning");
      await expect(warning, `press ${press}: one amber notice`).toHaveCount(1);
      await expect(warning).toHaveText(expected);
      await expect(warning).toHaveClass(/\bbg-amber-50\b/);
      await expect(page.getByTestId("schedule-error"), `press ${press}: no red banner`).toHaveCount(0);
      await expect(page.getByText(String(body.error?.message), { exact: false })).toHaveCount(0);
    }

    // ---- 3. the source completes: the server seeds and draws the finals, and
    // the waiting copy goes away.
    expect((await apiJson(request, `/api/v1/divisions/${rig.divisionId}/start`, "POST")).status, "start").toBe(200);
    await scoreInSeedOrder(request, rig.fixtures, rig.entrantIds);
    const done = await apiJson<{ completed: boolean; next_stage_fixtures?: number }>(
      request, `/api/v1/stages/${rig.leagueId}/complete`, "POST", {},
    );
    expect(done.status, "complete the league").toBe(200);
    expect(done.data?.completed).toBe(true);
    // A 4-seed single-elimination bracket is 2 semi-finals + 1 final.
    expect(done.data?.next_stage_fixtures, "the finals were drawn on completion").toBe(3);

    await page.reload();
    // Positive pair first: the finals card now offers its fixtures…
    await expect(finals.getByTestId("stage-view-fixtures")).toBeVisible();
    // …so the absences below are about the copy, not an unrendered card.
    await expect(page.getByTestId("stage-no-fixtures")).toHaveCount(0);
    await expect(page.getByText(awaiting, { exact: true })).toHaveCount(0);
  });
});
