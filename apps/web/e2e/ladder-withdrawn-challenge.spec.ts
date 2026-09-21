import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiJson, TAG, divisionPath, expectNoHorizontalScroll, screenshotAtWidths } from "./helpers";

// The ladder console, with a player who has left.
//
// Two things no vitest in `apps/web` can see (`environment: "node"`, no DOM,
// and the panel's catch block only runs against a real response):
//
//  1. the challenge PICKERS must not offer a withdrawn player. `issueChallenge`
//     refuses her with a 422 LADDER_ENTRANT_WITHDRAWN, but a refusal is the
//     backstop for a ladder that changed between render and POST — a control
//     that offers a choice the server will reject is a dead end wearing a menu;
//  2. a refusal must reach the organiser as DICTIONARY copy, not the server's
//     own English prose. That is the whole point of the LADDER_* codes, and it
//     is provable in English alone: the copy and the wire message are different
//     sentences, so seeing the copy proves the resolver is wired. A unit test
//     can prove the resolver returns the right string and still leave the panel
//     rendering `err.message` — the inert-seam shape.
//
// Her ROW stays in the table, marked: `config.ladder_order` is never pruned on
// purpose, so she keeps the rung she earned if she is reinstated.
const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface Rig {
  divisionId: string;
  order: string[];
  nameOf: Map<string, string>;
}

/** A 4-rung ladder, seated by a first real challenge so `config.ladder_order`
 *  exists the way a live ladder gets it (the array is written once, from the
 *  live field, and never pruned again — the defect's precondition). */
async function seedLadder(request: APIRequestContext, tag: string): Promise<Rig> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Ladder Withdraw ${tag}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Club ladder", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
  );
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;

  const entrants = await apiJson<{ id: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual",
      display_name: `Rung ${i + 1}`,
      seed: i + 1,
    })),
  );
  expect(entrants.status, JSON.stringify(entrants.error)).toBe(201);

  const stages = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    [{ seq: 1, kind: "ladder", name: "Club ladder", config: { challengeRange: 3 } }],
  );
  expect(stages.status, JSON.stringify(stages.error)).toBe(201);
  const stageId = stages.data![0]!.id;

  const ids = entrants.data!.map((e) => e.id);
  const seated = await apiJson<{ ladder_order: string[] }>(
    request,
    `/api/v1/stages/${stageId}/challenges`,
    "POST",
    { challenger_id: ids[1]!, opponent_id: ids[0]! },
  );
  expect(seated.status, JSON.stringify(seated.error)).toBe(201);

  return {
    divisionId,
    order: seated.data!.ladder_order,
    nameOf: new Map(entrants.data!.map((e) => [e.id, e.display_name])),
  };
}

test("the ladder console does not offer a withdrawn player, and says so in dictionary copy", async ({
  page,
  request,
}, testInfo) => {
  const rig = await seedLadder(request, `${TAG}-ladder`);
  const url = await divisionPath(request, rig.divisionId, "?tab=fixtures");

  const departing = rig.order[2]!;
  const departingName = rig.nameOf.get(departing)!;

  // BEFORE: everyone is offered. Without this half the assertion below cannot
  // tell a working filter from a picker that was always empty.
  await page.goto(url);
  const pickers = page.locator("select").filter({ hasText: departingName });
  await expect(pickers).toHaveCount(2);

  const withdrawn = await apiJson(request, `/api/v1/entrants/${departing}/withdraw`, "POST");
  expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBeLessThan(300);

  await page.goto(url);
  // AFTER: gone from both pickers…
  await expect(page.locator("select").filter({ hasText: departingName })).toHaveCount(0);
  // …but still on the ladder, marked, at the same rung.
  await expect(page.locator(`[data-ladder-withdrawn="${departing}"]`)).toBeVisible();
  const rungs = await page.locator("table tbody tr td:first-child").allTextContents();
  expect(rungs.map((t) => t.trim())).toEqual(["1", "2", "3", "4"]);
  // Everyone else IS still offered — the filter removed one player, not the
  // list.
  for (const id of rig.order.filter((x) => x !== departing)) {
    await expect(
      page.locator("select").filter({ hasText: rig.nameOf.get(id)! }).first(),
    ).toBeAttached();
  }

  // The refusal an organiser CAN still reach: a challenge aimed downward. The
  // server's own message is "you can only challenge upward"; the dictionary
  // copy is a different sentence, so this distinguishes the two.
  const selects = page.locator("select");
  await selects.nth(0).selectOption(rig.order[0]!);
  await selects.nth(1).selectOption(rig.order[3]!);
  await page.getByRole("button", { name: /issue challenge/i }).click();
  const banner = page.locator("p.text-red-600");
  await expect(banner).toHaveText("You can only challenge someone ranked above you.");
  expect(await banner.textContent()).not.toContain("challenge upward");

  await screenshotAtWidths(page, testInfo, "ladder-withdrawn", [1280, 768, 320]);
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalScroll(page);
  }
});
