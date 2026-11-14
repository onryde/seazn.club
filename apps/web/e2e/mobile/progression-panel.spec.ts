// Split out of the former e2e/mobile.spec.ts (2026-11-13, verbatim move): the progression proposal panel (P6 task B: tie resolve + confirm, round-3 Generate refusal) and the PB1 completed-stage / finished-round toggles.
// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — MOBILE_SPECS in playwright.config.ts).

import { test, expect, type Locator } from "@playwright/test";
import {
  TAG,
  apiJson,
  expectNoHorizontalScroll,
  addEntrantsViaApi,
  divisionPath,
  loginUi,
  scoreFixture,
  seedVenueWithCourts,
  seedCompletedLeague,
  stageCardOf,
} from "../helpers";
import { projectTag } from "./_shared";

// Serial, kept from the original file: P6 task B setup fills `p6bDivisionId` / `p6bKoStageId`; the confirm, round-3 and PB1 tests read them and mutate the same division, in order.
test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// P6 (D4b task B) — the organiser-facing proposal panel: full browser flow
// (decided league -> panel -> resolve a tie -> confirm -> bracket shows real
// entrants, schedule unchanged on screen), plus the destructive-dialog path.
// Lives in mobile.spec.ts, not a new spec file, for the same reason as task
// A's block above — a new file runs desktop-only and never sees 320/360/
// 375/390/430/768/834.
//
// Tie mechanism: a 4-entrant single league where EVERY match is a DRAW
// (`allowDraws: true`) makes every entrant finish level on points/diff/for —
// the one deterministic way to reach a genuinely unresolved tie
// (server/usecases/__tests__/stage-progression.test.ts's own "cross-group
// tie is FLAGGED" test proves this exact shape; a 2-pool/1-draw shape was
// considered and is NOT what that suite uses). `rankRange(1,2)` over that
// league therefore ties BOTH destination slots against the SAME 4 candidates
// — there is no third, non-tied row in this scenario; edit-in-place on a
// NON-tied row is already proven at the component/wiring layer
// (progression-panel-wiring.test.tsx), so this flow's job is the tie path
// specifically, the one no unit test can fake (real standings, real DB,
// real confirm route).
// ---------------------------------------------------------------------------

// Per-project identity (see `projectTag` above, top of file). ALL THREE tests
// below share this account within one worker — setup creates the tied league
// + KO fixture, the confirm test MUTATES it (resolves the tie and confirms
// the seed proposal — the test that raced across width projects when TAG
// collided), and the destructive-edit test MUTATES too (generates then
// regenerates a stage's fixtures). Each width project needs its own account
// so its confirm()/regenerate() can't be raced by another project's.
const P6B_EMAIL = () => `delivered+p6b-${TAG}-${projectTag()}@resend.dev`;
let p6bDivisionId = "";
let p6bKoStageId = "";
const P6B_COURT = "Center Court E2E";
const P6B_ENTRANTS = ["Nova Q", "Orion Q", "Piper Q", "Reeve Q"];

test("P6 task B setup: a 4-way-tied league decides, KO panel has a real tie to resolve", async ({
  page,
}) => {
  await loginUi(page, P6B_EMAIL());

  const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `P6 TaskB ${TAG}`,
    visibility: "private",
  });
  expect(comp.status).toBeLessThan(300);

  const div = await apiJson<{ id: string }>(page.request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    // allowDraws is load-bearing: without it, a 1-1 result either 422s or
    // is not treated as a genuine draw, and the standings cascade resolves
    // a winner instead of leaving every entrant level.
    config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status).toBeLessThan(300);
  p6bDivisionId = div.data!.id;

  await addEntrantsViaApi(page.request, p6bDivisionId, P6B_ENTRANTS);

  const stages = await apiJson<{ id: string; kind: string }[]>(
    page.request,
    `/api/v1/divisions/${p6bDivisionId}/stages`,
    "POST",
    [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      {
        seq: 2,
        kind: "knockout",
        name: "Knockout",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  );
  expect(stages.status).toBeLessThan(300);
  const leagueId = stages.data!.find((s) => s.kind === "league")!.id;
  const koId = stages.data!.find((s) => s.kind === "knockout")!.id;
  p6bKoStageId = koId;

  // TBD KO fixture up front (owner ruling), then pinned — proving later that
  // confirm fills it without disturbing the pin (the non-destructive
  // guarantee, "on screen" this time rather than at the DB layer).
  const koGen = await apiJson<{ created: number; fixtures: { id: string }[] }>(
    page.request,
    `/api/v1/stages/${koId}/generate`,
    "POST",
  );
  expect(koGen.data!.created).toBe(1);
  const koFixtureId = koGen.data!.fixtures[0]!.id;
  const { courts: p6bCourts } = await seedVenueWithCourts(page.request, [P6B_COURT]);
  const pin = await apiJson(page.request, `/api/v1/fixtures/${koFixtureId}`, "PATCH", {
    scheduled_at: "2030-11-15T14:00:00.000Z",
    court_id: p6bCourts[0]!.id,
  });
  expect(pin.status).toBeLessThan(300);

  const leagueGen = await apiJson<{ fixtures: { id: string }[] }>(
    page.request,
    `/api/v1/stages/${leagueId}/generate`,
    "POST",
  );
  expect(leagueGen.data!.fixtures.length).toBe(6); // round robin of 4

  await apiJson(page.request, `/api/v1/divisions/${p6bDivisionId}/start`, "POST");
  for (const f of leagueGen.data!.fixtures) {
    await scoreFixture(page.request, f.id, 1, 1); // every match drawn -> all 4 level
  }

  const completed = await apiJson<{ completed: boolean; seed_proposal?: { status: string } }>(
    page.request,
    `/api/v1/stages/${leagueId}/complete`,
    "POST",
  );
  expect(completed.status).toBeLessThan(300);
  expect(completed.data!.completed).toBe(true);
  expect(completed.data!.seed_proposal?.status).toBe("draft");
});

/** The real (non-placeholder) <option>s currently rendered in a progression
 *  row's <select> — {value: entrant id, label: entrant name}. A tied row's
 *  pool correctly EXCLUDES whichever entrant is the other tied row's current
 *  pick (`optionsForSlot`, progression-panel.tsx:123-138). Before either row
 *  has an organiser edit, "the other row's current pick" is its computed
 *  default, which comes from the engine's "lots" tie-break — seeded by
 *  freshly generated entrant UUIDs (packages/engine/src/competition/
 *  tiebreakers.ts:577-611), so it is genuinely random per run. That means
 *  which entrant is missing from which row's <select> is random too: a test
 *  must read what a row actually offers rather than assume a fixed entrant
 *  lands in a fixed row (see project_p6_taskb_confirm_tiebreak_flake.md). */
async function realSelectOptions(select: Locator): Promise<{ value: string; label: string }[]> {
  const entries = await select.locator("option").evaluateAll<{ value: string; label: string }[]>((opts) =>
    opts.map((o) => ({ value: (o as HTMLOptionElement).value, label: (o.textContent ?? "").trim() })),
  );
  return entries.filter((o) => o.value !== ""); // drop the "choose an entrant" placeholder
}

test("P6 task B: panel resolves the tie, confirms, bracket shows real entrants, schedule unchanged on screen", async ({
  page,
}) => {
  test.skip(p6bDivisionId === "", "P6 task B setup did not run/complete");
  await loginUi(page, P6B_EMAIL()); // same user/org as setup — a fresh page has no session of its own

  await page.goto(await divisionPath(page.request, p6bDivisionId, "?tab=fixtures"), { waitUntil: "load" });

  const panel = page.locator('[data-progression-state="draft"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText("Knockout")).toBeVisible();
  await expect(panel.getByText("Tied", { exact: false }).first()).toBeVisible();

  const confirmBtn = panel.getByRole("button", { name: "Confirm proposal" });
  await expect(confirmBtn).toBeDisabled();

  // Both destination slots are tied against the same 4 candidates (see the
  // block comment above), but WHICH entrant is missing from WHICH row is
  // random per run (realSelectOptions above) — so resolve each row from
  // whatever it actually offers: the first real option in row 0, then
  // whatever remains distinct in row 1. This asserts the real relationship
  // (two rows, two distinct entrants, row 1's pool excluding row 0's pick)
  // rather than a coincidence of shuffle order, so it is strictly stronger
  // than picking two hardcoded names.
  const rows = panel.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  const row0Select = rows.nth(0).locator("select");
  const row1Select = rows.nth(1).locator("select");

  const row0Options = await realSelectOptions(row0Select);
  expect(row0Options.length).toBeGreaterThan(0);
  const pick0 = row0Options[0]!;
  await row0Select.selectOption({ value: pick0.value });
  await expect(row0Select).toHaveValue(pick0.value);

  // Only one of the two tied slots is resolved so far — confirm must stay
  // disabled until BOTH are (allTiesResolved, progression-panel.tsx:68-70).
  await expect(confirmBtn).toBeDisabled();

  // Row 1's own pool must now exclude whatever row 0 just picked — the
  // exact exclusion this flake was about, proven directly rather than
  // assumed, before acting on it.
  const row1Options = await realSelectOptions(row1Select);
  expect(row1Options.length).toBeGreaterThan(0);
  expect(row1Options.map((o) => o.value)).not.toContain(pick0.value);
  const pick1 = row1Options[0]!;
  await row1Select.selectOption({ value: pick1.value });
  await expect(row1Select).toHaveValue(pick1.value);
  expect(pick1.value).not.toBe(pick0.value);

  await expect(confirmBtn).toBeEnabled();
  await expectNoHorizontalScroll(page);
  await confirmBtn.click();

  // router.refresh() re-fetches the server props; the panel's OWN state
  // moves to "confirmed" once the reload lands.
  await expect(page.locator('[data-progression-state="confirmed"]')).toBeVisible({ timeout: 20_000 });

  // The bracket/fixture line now shows the CHOSEN entrants, never a raw TBD
  // or slot.* key — the panel's edit-in-place actually reached the fixture.
  // Scoped to the KNOCKOUT card's rows (PB1 review m4): the league above is COMPLETE, so its card is folded to one line (PB1, owner
  // 2026-11-02) with the same names hidden in its rows, and the tie panel's own options carry them too - a page-wide read was
  // satisfied by either. `visible=true` inside the card: a row's one-DOM twin copy (desktop / phone line) may be the hidden one.
  const koRows = stageCardOf(page, p6bKoStageId).locator("li[data-fixture-no]");
  await expect(koRows, "premise: the knockout card's one fixture row").toHaveCount(1);
  await expect(koRows.getByText(pick0.label, { exact: false }).locator("visible=true").first()).toBeVisible();
  await expect(koRows.getByText(pick1.label, { exact: false }).locator("visible=true").first()).toBeVisible();
  await expect(page.getByText(/^TBD$/)).toHaveCount(0);

  // Non-destructive guarantee, on screen: the court pinned before anyone
  // qualified is still exactly what shows now that the slot is filled.
  //
  // `p:visible`, not a bare `getByText(...).first()` (W3 Task 9 blast
  // radius): the run-sheet row now carries this SAME court/round text in
  // TWO paragraphs — one `hidden md:block` (desktop), one `md:hidden`
  // (phone, combined with the result sub-line) — "one DOM, branched", the
  // repo-wide phone-composition idiom. Below `md` the desktop copy is first
  // in DOM order but NOT visible, so a bare `.first()` resolved to it and
  // read "hidden" even though the phone copy of the same text was on
  // screen a few nodes later. Same fix `mobile.spec.ts:976`'s `nowLine`
  // already uses for the identical shape.
  await expect(page.locator("p:visible", { hasText: P6B_COURT }).first()).toBeVisible();

  await expectNoHorizontalScroll(page);
});

test("P6 task B fix round 3 (Critical 1), Match Day C3: a stage that already has fixtures offers no Generate - it is started; Complete waits for the matches and says why", async ({
  page,
}) => {
  test.skip(p6bDivisionId === "", "P6 task B setup did not run/complete");
  await loginUi(page, P6B_EMAIL());

  // A SEPARATE division/stage from the tie scenario — this path is generic
  // to any stage with existing fixtures, not specific to progression.
  const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `P6 TaskB Regen ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(page.request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Regen",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const regenDivisionId = div.data!.id;
  await addEntrantsViaApi(page.request, regenDivisionId, ["Gale R", "Hollis R", "Ivy R", "Jett R"]);
  const stage = await apiJson<{ id: string }[]>(page.request, `/api/v1/divisions/${regenDivisionId}/stages`, "POST", [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
  ]);
  const groupId = stage.data![0]!.id;
  const gen = await apiJson<{ fixtures: { id: string }[] }>(page.request, `/api/v1/stages/${groupId}/generate`, "POST");
  expect(gen.data!.fixtures.length).toBe(2);

  await page.goto(await divisionPath(page.request, regenDivisionId, "?tab=fixtures"), { waitUntil: "load" });

  const groupCard = page.locator("section.card", { hasText: "Groups" }).first();
  // Competition desk W3: below `md` the stage's edit controls fold into a bottom sheet behind `stage-rail-trigger`; at >= 768 the
  // rail is inline and the trigger itself is `md:hidden`. OPEN the fold rather than weakening the assertion below - gate the open
  // on the TOGGLE being visible, never on a width literal: clicking a hidden control throws.
  const railTrigger = groupCard.getByTestId("stage-rail-trigger");
  if (await railTrigger.isVisible()) await railTrigger.click();

  // Positive pair first: the rail IS rendering its actions (Complete is there, and disabled while the two matches are open),
  // so the absence of Generate below is about the stage, not an unrendered rail.
  const complete = groupCard.getByTestId("stage-complete");
  await expect(complete, "the rail renders its actions").toBeVisible();
  await expect(complete, "two open matches: Complete waits").toBeDisabled();
  await expect(groupCard.getByTestId("stage-complete-hint"), "and says why, with the count").toHaveText(/unlocks when all 2 matches are played/);
  // Match Day PB1 item 4 (owner 2026-11-02): the reason is a bubble on the greyed button itself - there is no ⓘ beside it. A tap (on a
  // phone, the sheet's row) shows it, does NOT complete the stage, and Escape puts it away (the sheet around it stays). Every width owes
  // this: the bubble opens IN FLOW under the button in the sheet below md and floats from md.
  await expect(groupCard.getByTestId("stage-complete-info"), "the ⓘ is retired").toHaveCount(0);
  const reason = groupCard.getByTestId("stage-complete-hint");
  await complete.click({ force: true }); // a tap on an aria-disabled button: Playwright's click() would wait for it to be enabled
  await expect(reason, "the tap shows the reason").toBeVisible();
  await expect(reason).toHaveAttribute("data-open", "true");
  await expect(complete, "the tap did not complete the stage").toBeDisabled();
  await expect(complete).toHaveAttribute("aria-describedby", await reason.getAttribute("id") ?? "missing");
  await expectNoHorizontalScroll(page);
  await page.keyboard.press("Escape");
  await expect(reason, "Escape puts the reason away").toBeHidden();
  await expect(complete, "and the greyed button is still there, still waiting").toBeVisible();
  // Owner ruling (Match Day, late entrant): once a stage has started, Generate is gone from the card. Adding to a started stage is
  // Add match (ad-hoc kinds) or the Settings rebuild - never a second Generate, so there is no "destructive edit" to warn about.
  await expect(groupCard.getByRole("button", { name: "Generate fixtures" }), "a started stage is not re-generated from the card").toHaveCount(0);
  await expect(groupCard.getByTestId("stage-generate")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

// Match Day PB1 item 3 (owner 2026-11-02): a COMPLETED stage's card is one line until its toggle opens it, and a FINISHED round inside is one bar
// until its bar opens it. Every phone width owes it: the 44px toggle and bars, the opened card and rows, no horizontal scroll in any state.
// (The desktop pass is `stage-card-c3.spec.ts`; this spec's projects are the phone widths.)
test("PB1 item 3: a completed stage is one line and a finished round is one bar - the toggles open and close them, 44px, no horizontal scroll", async ({
  page,
}) => {
  test.skip(p6bDivisionId === "", "P6 task B setup did not run/complete");
  test.setTimeout(150_000);
  await loginUi(page, P6B_EMAIL());
  const { divisionId, stageId } = await seedCompletedLeague(page.request, "phone-fold");
  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"), { waitUntil: "load" });
  const card = stageCardOf(page, stageId);
  const toggle = card.getByTestId("stage-collapse-toggle");
  const body = card.locator(`#stage-body-${stageId}`);
  const rows = card.locator("li[data-fixture-no]:visible");
  const tall = async (loc: ReturnType<typeof card.locator>, what: string) =>
    expect((await loc.boundingBox())!.height, `${what}: a 44px target`).toBeGreaterThanOrEqual(43.5);

  // Folded on arrival.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(card.getByTestId("stage-collapsed-summary")).toHaveText("3 of 3 done");
  await expect(body).toBeHidden();
  await expect(rows).toHaveCount(0);
  await tall(toggle, "the stage toggle");
  await expectNoHorizontalScroll(page);

  // Open: the card is back and every finished round is a folded bar.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
  const bars = card.getByTestId("run-sheet-round-toggle");
  await expect(bars).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(bars.nth(i), `round ${i + 1}: folded`).toHaveAttribute("aria-expanded", "false");
    await tall(bars.nth(i), `round ${i + 1}'s bar`);
  }
  await expect(rows).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // A bar opens its round's row and closes it again; the page never scrolls sideways with a row open.
  await bars.nth(0).click();
  await expect(bars.nth(0)).toHaveAttribute("aria-expanded", "true");
  await expect(rows).toHaveCount(1);
  await expectNoHorizontalScroll(page);
  await bars.nth(0).click();
  await expect(bars.nth(0)).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toHaveCount(0);

  // Fold the card again: nothing of it is on screen; open it: it is back.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(body).toBeHidden();
  await expectNoHorizontalScroll(page);
  await toggle.click();
  await expect(body).toBeVisible();
});
