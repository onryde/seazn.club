import { test, expect } from "@playwright/test";
import { apiJson, TAG, divisionPath, expectNoHorizontalScroll } from "./helpers";

// A player added to a RUNNING ladder joins its bottom rung, and can play.
//
// Before this fix `config.ladder_order` was written once, by the first challenge, and a later arrival sat in no rung:
// the ladder panel (which lists the order) never showed them and every challenge naming them was refused
// LADDER_ENTRANT_FOREIGN. The vitest (`ladder-late-entrant.test.ts`) drives the doors; this drives the console, which
// is what an organiser sees: the new name appears at the bottom, is offered by the pickers, and a challenge they are in
// goes through. Desktop only (a spec outside e2e/mobile/); e2e/mobile/ladder-late-entrant.spec.ts runs the same flow at the seven phone/tablet widths.
const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

test("a late entrant appears at the bottom of the ladder panel and can be challenged", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Ladder Late ${TAG}`, visibility: "private" });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Club ladder", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  const divisionId = div.data!.id;
  const ents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", Array.from({ length: 3 }, (_, i) => ({ kind: "individual", display_name: `Rung ${i + 1}`, seed: i + 1 })));
  expect(ents.status).toBe(201);
  const stages = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", [{ seq: 1, kind: "ladder", name: "Club ladder", config: { challengeRange: 5 } }]);
  const stageId = stages.data![0]!.id;
  const first = await apiJson<{ ladder_order: string[] }>(request, `/api/v1/stages/${stageId}/challenges`, "POST", { challenger_id: ents.data![1]!.id, opponent_id: ents.data![0]!.id });
  expect(first.status).toBe(201);
  expect(first.data!.ladder_order).toHaveLength(3);

  // The late arrival: added after the ladder is running.
  const late = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [{ kind: "individual", display_name: "Late Larry", seed: 99 }]);
  expect(late.status, JSON.stringify(late.error)).toBe(201);

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const rows = page.locator("table tbody tr").filter({ has: page.locator("td:first-child", { hasText: /^\s*\d+\s*$/ }) });
  await expect(rows).toHaveCount(4);
  expect((await rows.locator("td:first-child").allTextContents()).map((t) => t.trim())).toEqual(["1", "2", "3", "4"]);
  await expect(rows.nth(3), "the late entrant holds the bottom rung").toContainText("Late Larry");
  for (const i of [0, 1, 2]) await expect(rows.nth(i), "nobody else moved").not.toContainText("Late Larry");

  // Offered by the pickers, and a challenge naming them is accepted (it was refused before).
  await expect(page.locator("select").filter({ hasText: "Late Larry" })).toHaveCount(2);
  const selects = page.locator("select");
  await selects.nth(0).selectOption(late.data![0]!.id);
  await selects.nth(1).selectOption(ents.data![2]!.id);
  await page.getByRole("button", { name: /issue challenge/i }).click();
  await expect(page.locator("p.text-red-600")).toHaveCount(0);
  // POSITIVE: the challenge exists - a fixture between the late entrant and the rung above appears in the division's
  // fixtures (a refusal and a silent no-op would both leave the red banner absent, so the absence proves nothing alone).
  await expect
    .poll(async () => {
      const fx = await apiJson<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
      return (fx.data ?? []).some((f) => [f.home_entrant_id, f.away_entrant_id].includes(late.data![0]!.id) && [f.home_entrant_id, f.away_entrant_id].includes(ents.data![2]!.id));
    })
    .toBe(true);
  await expectNoHorizontalScroll(page);
});
