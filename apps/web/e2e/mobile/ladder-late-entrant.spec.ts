// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 - MOBILE_SPECS in playwright.config.ts).
//
// The ladder panel on the division's fixtures tab, with a player who joined a RUNNING ladder: they must be listed on the
// bottom rung, offered by both pickers, and a challenge naming them accepted - at every phone and tablet width, with no
// page-level horizontal scroll and nothing clipped inside the ladder card (a reachable scroll is allowed; a clip is not).
// Desktop is covered by e2e/ladder-late-entrant.spec.ts; this file owns the narrow widths (AGENTS rules 21-22).
import { test, expect } from "@playwright/test";
import { TAG, apiJson, divisionPath, expectNoHorizontalScroll, overflowingIn } from "../helpers";
import { projectTag } from "./_shared";

const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
// A realistic long name, the shape that exposed the disclosure clip in the phone-composition work.
const LATE_NAME = "Late Larry Featherstonehaugh-Wetherspoon";

test("a late entrant is on the ladder's bottom rung and can be challenged, at this width", async ({ page, request }) => {
  const tag = `${TAG}-${projectTag()}`;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Ladder Late ${tag}`, visibility: "private" });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Club ladder", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  const divisionId = div.data!.id;
  const ents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", Array.from({ length: 3 }, (_, i) => ({ kind: "individual", display_name: `Rung ${i + 1}`, seed: i + 1 })));
  expect(ents.status).toBe(201);
  const stages = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", [{ seq: 1, kind: "ladder", name: "Club ladder", config: { challengeRange: 5 } }]);
  const first = await apiJson(request, `/api/v1/stages/${stages.data![0]!.id}/challenges`, "POST", { challenger_id: ents.data![1]!.id, opponent_id: ents.data![0]!.id });
  expect(first.status).toBe(201);
  const late = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [{ kind: "individual", display_name: LATE_NAME, seed: 99 }]);
  expect(late.status, JSON.stringify(late.error)).toBe(201);

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const rows = page.locator("table tbody tr").filter({ has: page.locator("td:first-child", { hasText: /^\s*\d+\s*$/ }) });
  await expect(rows, "the three seeded rungs plus the late entrant").toHaveCount(4);
  await expect(rows.nth(3)).toContainText(LATE_NAME);
  await rows.nth(3).scrollIntoViewIfNeeded();
  await expect(rows.nth(3).locator("td").nth(1), "the bottom rung's name is on screen").toBeVisible();
  await expectNoHorizontalScroll(page);
  const { clipped } = await overflowingIn(page, "div.card.scroll-x", "td,th,span", "the ladder card was not in the DOM");
  expect(clipped, "nothing in the ladder card is clipped (a reachable scroll is fine)").toEqual([]);

  await expect(page.locator("select").filter({ hasText: LATE_NAME })).toHaveCount(2);
  const selects = page.locator("select");
  await selects.nth(0).selectOption(late.data![0]!.id);
  await selects.nth(1).selectOption(ents.data![2]!.id);
  await page.getByRole("button", { name: /issue challenge/i }).click();
  await expect(page.locator("p.text-red-600")).toHaveCount(0);
  await expect
    .poll(async () => {
      const fx = await apiJson<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
      return (fx.data ?? []).some((f) => [f.home_entrant_id, f.away_entrant_id].includes(late.data![0]!.id) && [f.home_entrant_id, f.away_entrant_id].includes(ents.data![2]!.id));
    })
    .toBe(true);
  await expectNoHorizontalScroll(page);
});
