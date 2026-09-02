import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, fixturePath, seedRosteredFixture, TAG } from "./helpers";

// R8 sweep, task WS-L — THE SUBSTITUTION SHEET'S ROWS SAY WHO.
//
// `period-shared.ts`'s `buildSwap` now populates `SwapSlot.candidateMeta` for
// both period skins, so `renderCandidateRow` (context-strip.tsx) draws a
// position badge and a captain chip on each row. `period-pair.test.ts` proves
// the BUILDER over a real fold — but `apps/web` vitest is `environment:
// "node"` with no DOM, so it cannot see whether the badge survives the adapter
// (`adaptSwapSlot` copies `candidateMeta` BY HAND), whether the chassis renders
// it, or whether six rows carrying it still fit a 320px phone. That is this
// file's whole job.
//
// ICE HOCKEY on purpose. Its OFF pool is the SIX players on the ice
// (`icehockey.ts` `positions.lineup.size`), which is the case the owner ruling
// of 2026-08-30 described word for word: "a picker of six teammates is six
// visually identical rows". Hockey's eleven share one builder and one code
// path; ice hockey is where a scorer meets it.
//
// The default `storageState` org, deliberately — the swap tile is band-gated
// (`SWAP_BAND = 2`) and this is the same shared Pro account every
// `sub-home` tap in `scorepad-v3-football.spec.ts` already runs against. No
// entitlement is granted or flipped here, so nothing this file does is visible
// to another spec sharing that org.
test.describe.configure({ mode: "parallel" });

/** The seeded ICE lineup — the source of truth for what this fixture DECLARED,
 *  and therefore for what each row must show. `G`/`D`/`F` are the only keys
 *  `icehockey.ts`'s own `positions.groups` declares (a lineup naming anything
 *  else is an `unknown_position` issue), so three distinct codes over six
 *  skaters is the REAL best case — the badge groups the six, and the captain
 *  chip separates one more. Anything less is the six-identical-rows bug. */
const ON_ICE: readonly { readonly name: string; readonly positionKey: string; readonly captain?: true }[] = [
  { name: `V3 Ice G ${TAG}`, positionKey: "G" },
  { name: `V3 Ice D1 ${TAG}`, positionKey: "D", captain: true },
  { name: `V3 Ice D2 ${TAG}`, positionKey: "D" },
  { name: `V3 Ice F1 ${TAG}`, positionKey: "F" },
  { name: `V3 Ice F2 ${TAG}`, positionKey: "F" },
  { name: `V3 Ice F3 ${TAG}`, positionKey: "F" },
];

const BENCH = `V3 Ice Bench ${TAG}`;

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

function v3Tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}

/** Dispatch the one setup event directly — the action under test is the SHEET,
 *  and a hand-tapped "Start match" would only add a way for this file to fail
 *  for a reason it is not about. Same posture as
 *  `scorepad-v3-swap-off-step-enforcement.spec.ts`'s own `postEvent`. */
async function postEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  if (state.status !== 200 || !state.data) {
    throw new Error(`postEvent(${type}): GET state -> ${state.status} ${JSON.stringify(state.error)}`);
  }
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data.last_seq,
    type,
    payload,
  });
  if (res.status >= 300) {
    throw new Error(`postEvent(${type}) -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

test("ice hockey v3: the OFF step's six on-ice rows carry their own position badge and the captain's chip, at 768 and 320", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Ice Swap ${TAG}`,
    sportKey: "icehockey",
    variantKey: "iihf",
    home: [
      ...ON_ICE.map((p) => ({
        fullName: p.name,
        positionKey: p.positionKey,
        ...(p.captain === true ? { roles: ["captain"] as const } : {}),
      })),
      { fullName: BENCH, slot: "bench" as const },
    ],
    away: [{ fullName: `V3 Ice Away ${TAG}`, positionKey: "G" }],
  });

  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });

  await v3Tile(page, "sub-home").click();
  const swap = pad(page).locator('[data-role="v3-swap"]');
  await expect(swap).toBeVisible({ timeout: 10_000 });

  // Every skater on the ice is offered, and every one of them is BADGED.
  // Asserted per person id off the seed above, never off the row order — the
  // OFF pool comes out of the fold's squad state and owes this file no
  // ordering promise.
  for (const player of ON_ICE) {
    const row = swap.locator(`[data-candidate-id="${fx.personIds[player.name]!}"]`);
    await expect(row, `${player.name} is not offered on the OFF step`).toBeVisible();
    await expect(
      row.locator("[data-candidate-lead]"),
      `${player.name}'s row carries no position badge`,
    ).toHaveAttribute("data-candidate-lead", player.positionKey);
    // …and the badge is VISIBLE TEXT, not just an attribute a CSS rule could
    // be hiding: `renderCandidateRow` prints `meta.lead` inside the span it
    // stamps the attribute on.
    await expect(row.locator("[data-candidate-lead]")).toHaveText(player.positionKey);
  }

  // The whole point: the rows are NOT all the same. Read back off the rendered
  // DOM rather than argued from the seed — a builder stamping one meta on
  // every row, or a chassis dropping the field on the way through
  // `adaptSwapSlot`, collapses this to a single value (or to zero).
  const leads = await swap.locator("[data-candidate-lead]").evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-candidate-lead")),
  );
  expect(new Set(ON_ICE.map((p) => p.positionKey)).size, "the fixture declares one position for the whole line").toBe(
    3,
  );
  expect(new Set(leads.filter((l) => l !== null)), "six rows still render as one badge").toEqual(
    new Set(["G", "D", "F"]),
  );

  // The captain — the one thing a position code cannot say, and the only
  // separator between the two defenders.
  const captain = ON_ICE.find((p) => p.captain === true)!;
  const otherD = ON_ICE.find((p) => p.positionKey === "D" && p.captain !== true)!;
  await expect(
    swap.locator(`[data-candidate-id="${fx.personIds[captain.name]!}"]`).locator("[data-candidate-tag]"),
    "the captain's row carries no role chip",
  ).toBeVisible();
  await expect(
    swap.locator(`[data-candidate-id="${fx.personIds[otherD.name]!}"]`).locator("[data-candidate-tag]"),
    "a non-captain row carries a role chip it should not",
  ).toHaveCount(0);

  // …and six badged rows still fit the two widths the project rule names.
  // Captured on the OFF STEP, the step this task is about, with the badge
  // re-asserted AT each width: a picture is only evidence if the thing it is
  // meant to show is still on screen when the shutter fires, and a shrink-0
  // badge beside a wrapping name is exactly the shape that stops being true
  // at 320.
  const keeperLead = swap
    .locator(`[data-candidate-id="${fx.personIds[ON_ICE[0]!.name]!}"]`)
    .locator("[data-candidate-lead]");
  for (const width of [768, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await expect(swap, `the swap sheet closed at ${width}px`).toBeVisible();
    await expect(keeperLead, `the position badge is not rendered at ${width}px`).toBeVisible();
    await expect(keeperLead).toHaveText("G");
    await expectNoHorizontalScroll(page);
    await page.screenshot({
      path: `e2e-artifacts/swap-candidate-badges/icehockey-off-step-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 1100 });

  // A bench player the sheet declared with neither a position nor a squad
  // number is UNDECORATED — the documented empty default (`CandidateMeta`'s
  // own doc), and the proof this change did not put a badge on every picker
  // in the app. The bench only appears once an OFF pick is made, so pick one.
  await swap.locator(`[data-candidate-id="${fx.personIds[ON_ICE[0]!.name]!}"]`).click();
  const benchRow = swap.locator(`[data-candidate-id="${fx.personIds[BENCH]!}"]`);
  await expect(benchRow, "the bench candidate is not offered on the ON step").toBeVisible();
  await expect(benchRow.locator("[data-candidate-lead]")).toHaveCount(0);
});
