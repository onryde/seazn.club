import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG, apiJson, addEntrantsViaApi, divisionPath, scoreFixture } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

/**
 * Add stage after a stage of SEVERAL groups (owner Option C, 2026-11-24): the form's Top N select gives way to ONE count,
 * "Qualify to the knockout", with a live line saying the split and the round it makes. This drives it the way an organiser does -
 * the real form, on a real division of 4 groups - then completes the groups and reads the knockout the draw made.
 *
 * Desktop only (a spec outside e2e/mobile/ runs at the desktop width). The unit suites pin the pure pieces (the split, the
 * predicate, the form's posted body); this is the seam they cannot see: the form's own POST through the real save door, the
 * real Complete, the real draw.
 *
 * 18 entrants snaked into 4 groups (5, 5, 4, 4), "qualify 10": Top 2 per group + the 2 best 3rd-placed, a bracket of 16 with 6 byes.
 * Expected values come from the rule (10 qualifiers; 16 - 10 = 6 byes; 10 - 8 = 2 real round-one lines), not from a run.
 */

const en: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
const fill = (key: string, vars: Record<string, string | number>) => {
  const tpl = en[key];
  expect(tpl, `en/ui.json has no ${key}`).toBeTruthy();
  return tpl!.replace(/\{(\w+)\}/g, (m, k: string) => String(vars[k] ?? m));
};

const QUALIFIED = 10;
const POOLS = 4;
const FIELD = 18;

type Fx = { id: string; home_entrant_id: string | null; away_entrant_id: string | null; round_no: number };

async function openAddStage(page: Page) {
  await page.getByRole("button", { name: en["schedule.addStage"]!, exact: true }).click();
}

test.describe("Add stage after groups: one count, a live line, a draw that works", () => {
  test("4 groups of 4-5: pick 10 in the form, see the split and the byes, save; Complete seats exactly 10", async ({ page, request }) => {
    test.setTimeout(240_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      name: `AddStage groups ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
      visibility: "public",
      ends_on: "2030-12-31",
    });
    expect(comp.status, "create competition").toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Cup",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    expect(div.status, "create division").toBe(201);
    const entrants = await addEntrantsViaApi(request, div.data!.id, Array.from({ length: FIELD }, (_, i) => `Seed${i + 1}`));
    expect(entrants.ids, "the field").toHaveLength(FIELD);
    const groups = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
      seq: 1,
      kind: "group",
      name: "Groups",
      config: { pools: { count: POOLS } },
    });
    expect(groups.status, "create the group stage").toBe(201);
    const gen = await apiJson<{ fixtures: Fx[] }>(request, `/api/v1/stages/${groups.data!.id}/generate`, "POST");
    expect(gen.status, "generate the groups").toBe(200);
    // Pools of 5, 5, 4, 4: C(5,2) * 2 + C(4,2) * 2 = 32 matches.
    expect(gen.data!.fixtures, "5,5,4,4 round robins").toHaveLength(32);

    await page.goto(await divisionPath(request, div.data!.id, "?tab=fixtures"));
    await dismissCookieBanner(page);
    await openAddStage(page);

    // ---- 1. the form after groups: ONE count, no Top N.
    const count = page.getByTestId("add-stage-group-count");
    await expect(count, "the group count control").toBeVisible();
    await expect(page.locator('select[data-format-bound="qualify"]'), "only the group count carries the qualify bound").toHaveCount(1);
    await expect(page.getByText(en["schedule.field.qualifyFrom"]!, { exact: true }), "no Top N label").toHaveCount(0);
    await expect(page.getByText(en["schedule.groupTake.label"]!, { exact: true })).toBeVisible();

    // ---- 2. it opens on twice the groups (top 2 of every group = 8: a whole quarter-final round).
    await expect(count).toHaveValue(String(POOLS * 2));
    await expect(page.getByTestId("add-stage-group-take")).toHaveText(
      fill("schedule.groupTake.derived", { count: 8, take: fill("templates.detail.take.topNPerGroup", { n: 2 }) }),
    );
    await expect(page.getByTestId("add-stage-group-round")).toHaveText(
      fill("schedule.groupTake.whole", { round: en["bracket.round.quarter"]! }),
    );

    // ---- 3. pick 10: the split gains the best thirds, and the line names the byes (16 - 10 = 6).
    await count.selectOption(String(QUALIFIED));
    await expect(page.getByTestId("add-stage-group-take")).toHaveText(
      fill("schedule.groupTake.derived", {
        count: QUALIFIED,
        take: fill("templates.detail.take.and", {
          a: fill("templates.detail.take.topNPerGroup", { n: 2 }),
          b: fill("templates.detail.take.bestNth", { count: 2, nth: 3 }),
        }),
      }),
    );
    await expect(page.getByTestId("add-stage-group-round")).toHaveText(fill("schedule.groupTake.byes", { size: 16, byes: 6 }));
    // A count that would pair two of one group in round one is not on offer: 5 from 4 groups cannot be separated.
    await expect(count.locator('option[value="5"]'), "a refused count is not listed").toHaveCount(0);
    await expect(page.getByTestId("add-stage-group-omitted")).toBeVisible();

    // ---- 4. save through the form's own POST; the stage appears (waiting on the groups).
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/v1/divisions/${div.data!.id}/stages`) && r.request().method() === "POST");
    await page.getByRole("button", { name: en["schedule.addStageBtn"]!, exact: true }).click();
    const res = await saved;
    expect(res.status(), "the save door accepts the shape").toBe(201);
    const posted = res.request().postDataJSON() as { progression: { sources: { take: { kind: string; n?: number; nth?: number; count?: number }[] }[]; timing: string } };
    expect(posted.progression.timing).toBe("on_complete");
    expect(posted.progression.sources[0]!.take.map((t) => t.kind)).toEqual(["topNPerGroup", "bestNth"]);
    expect(posted.progression.sources[0]!.take[0]).toMatchObject({ n: 2 });
    expect(posted.progression.sources[0]!.take[1]).toMatchObject({ nth: 3, count: 2 });

    // ---- 5. the groups finish; Complete draws the knockout from the form's own take. Home always wins.
    expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status, "start").toBe(200);
    for (const f of gen.data!.fixtures) await scoreFixture(request, f.id, 2, 0);
    const done = await apiJson<{ completed: boolean; next_stage_fixtures?: number }>(request, `/api/v1/stages/${groups.data!.id}/complete`, "POST", {});
    expect(done.status, "complete the groups").toBe(200);
    expect(done.data?.completed).toBe(true);
    expect(done.data?.next_stage_fixtures, "the knockout was drawn on completion").toBeGreaterThan(0);

    const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${div.data!.id}/fixtures`);
    const groupIds = new Set(gen.data!.fixtures.map((f) => f.id));
    const knockout = (all.data ?? []).filter((f) => !groupIds.has(f.id));
    expect(knockout.length, "anti-vacuity: the knockout has fixtures").toBeGreaterThan(0);
    const first = Math.min(...knockout.map((f) => f.round_no));
    const pairs = knockout.filter((f) => f.round_no === first && f.home_entrant_id !== null && f.away_entrant_id !== null);
    expect(pairs.length, "10 qualifiers into a bracket of 16: 10 - 8 = 2 real round-one lines (the rest are byes)").toBe(QUALIFIED - 8);
    const seated = new Set(knockout.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((id): id is string => id !== null));
    expect(seated.size, "exactly the qualifiers are seated").toBe(QUALIFIED);
  });
});
