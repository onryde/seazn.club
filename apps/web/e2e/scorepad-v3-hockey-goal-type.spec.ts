import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import { apiJson, expectNoHorizontalScroll, fixturePath, seedRosteredFixture, TAG } from "./helpers";

/**
 * W2d Task 18 (HK-TB-2, owner option A 2026-10-20) — a hockey goal tap is a QUESTION, not a held write.
 *
 * FIH GTR App. 3 ranks level teams on field goals, so the engine refuses an untyped `hockey.goal` on the write path
 * (`GOAL_KIND_REQUIRED`). The pad therefore asks "What kind of goal?" before anything is queued: the soft-commit
 * timer does not run until a kind is chosen, Cancel drops the goal, and the chosen kind lands on the ledger. Ice
 * hockey (IIHF ranks on no goal type) keeps the old held dock — the contrast case.
 *
 * Driven through the real pad and read back off the real ledger: a unit test of `softCommitPlan` cannot see that the
 * dock is on screen, that nothing posts while it waits, or that the chip a finger meets is the chip that records.
 */
test.describe.configure({ mode: "parallel" });

/** How long the question must sit unanswered with the ledger quiet. DERIVED from the hold (AGENTS.md class 20):
 *  past HOLD_MS, so a choice dock that secretly armed the soft-commit timer would have flushed by now. */
const UNANSWERED_MS = HOLD_MS + 1_000;

// The page clock is installed (flowing in real time) before the page opens so `freezeClock` can stop the HELD dock
// that follows a choice; the hold's `setTimeout` is armed by the choice tap, after install, so a pause can reach it.
test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

const FREEZE_JUMP_MS = 100;

/** Stop the page clock where it stands (scorepad-v3-soft-commit-inventory.spec.ts's recipe): the held dock cannot
 *  flush itself while the test reads the ledger and presses Send now. */
async function freezeClock(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + FREEZE_JUMP_MS);
      return;
    } catch (error) {
      if (attempt >= 5 || !String(error).includes("past")) throw error;
    }
  }
}

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function dock(page: Page) {
  return pad(page).locator('[data-role="v3-dock"]');
}
function choice(page: Page) {
  return pad(page).getByTestId("pad-dock-choice");
}
function tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}
const goalsIn = async (request: APIRequestContext, fixtureId: string, type: string) =>
  (await ledger(request, fixtureId)).filter((e) => e.type === type);

async function scoreOf(request: APIRequestContext, fixtureId: string): Promise<{ home: number; away: number }> {
  const res = await apiJson<{ state: { goals?: { home: number; away: number } } | null }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(res.status, `state read failed: ${JSON.stringify(res.error)}`).toBe(200);
  const goals = res.data?.state?.goals;
  expect(goals, "the fold carries a goals pair").toBeDefined();
  return goals!;
}

async function openLive(page: Page, fixtureId: string): Promise<void> {
  await page.goto(await fixturePath(page.request, fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
}

/** The chip ids the choice dock shows, in DOM order. */
const choiceIds = (page: Page) =>
  choice(page)
    .locator('[data-testid^="pad-dock-chip-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice("pad-dock-chip-".length)));

/** Every choice chip hit-tests at its centre and both vertical edges: the chip a finger meets is the chip. */
async function hitTestChoiceChips(page: Page): Promise<{ checked: number; misses: string[] }> {
  return choice(page)
    .locator('[data-testid^="pad-dock-chip-"], [data-testid="pad-dock-cancel"]')
    .evaluateAll((els) => {
      const misses: string[] = [];
      for (const el of els) {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        for (const y of [r.top + 1, r.top + r.height / 2, r.bottom - 1]) {
          const at = document.elementFromPoint(cx, y);
          if (at === null || !(at === el || el.contains(at))) {
            misses.push(`${el.getAttribute("data-testid")} at y=${Math.round(y)} hit ${at?.tagName ?? "null"}`);
          }
        }
        if (r.height < 44) misses.push(`${el.getAttribute("data-testid")} is ${r.height}px tall`);
      }
      return { checked: els.length, misses };
    });
}

test("hockey (FIH): a goal tap asks its type, nothing is written until it is chosen, Cancel drops it, and the chosen type is what lands", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `HGT Hockey ${TAG}`,
    sportKey: "hockey",
    variantKey: "fih-outdoor",
    home: [{ fullName: `HGT H Home ${TAG}` }, { fullName: `HGT H Home2 ${TAG}` }],
    away: [{ fullName: `HGT H Away ${TAG}` }],
  });

  // The kinds the choice must offer are read off the DIVISION'S OWN CONFIG (class 19), never typed here: every kind
  // the cfg records except the own goal, which keeps the existing Own goal control.
  const div = await apiJson<{ config: { goalKinds?: string[] } }>(page.request, `/api/v1/divisions/${fx.divisionId}`);
  expect(div.status, `GET division -> ${div.status}`).toBe(200);
  const kinds = div.data?.config.goalKinds ?? [];
  const expected = [...kinds.filter((k) => k !== "og").map((k) => `kind:${k}`), ...(kinds.includes("og") ? ["ownGoal"] : [])];
  // The rulebook half (FIH GTR App. 3): the ranking separates field goals from penalty corners and penalty strokes,
  // so all three must be choices — and Field goal is one of them, never the silent default.
  expect(expected, "FIH's three goal types are all offered").toEqual(expect.arrayContaining(["kind:fg", "kind:pc", "kind:stroke"]));

  await openLive(page, fx.fixtureId);

  // 1. The tap asks. No countdown, no Send now: the question has no timer to send.
  await tile(page, "goal-home").click();
  await expect(choice(page), "a hockey goal tap opens the goal-type question").toBeVisible({ timeout: 10_000 });
  expect(await choiceIds(page), "the choices, in order: the cfg's kinds, then Own goal").toEqual(expected);
  await expect(dock(page).getByTestId("pad-send-now"), "the question has no Send now").toHaveCount(0);
  const hits = await hitTestChoiceChips(page);
  expect(hits.checked, "anti-vacuity: every choice and Cancel was hit-tested").toBe(expected.length + 1);
  expect(hits.misses, "every choice chip hit-tests at its centre and both edges").toEqual([]);
  await expectNoHorizontalScroll(page);

  // 2. Unanswered past the hold: still asking, still nothing on the ledger.
  await page.waitForTimeout(UNANSWERED_MS);
  await expect(choice(page), `still asking after ${UNANSWERED_MS}ms (HOLD_MS=${HOLD_MS})`).toBeVisible();
  expect(await goalsIn(page.request, fx.fixtureId, "hockey.goal"), "nothing was written while the question waited").toEqual([]);

  // 3. Cancel drops the goal.
  await choice(page).getByTestId("pad-dock-cancel").click();
  await expect(choice(page)).toHaveCount(0, { timeout: 5_000 });
  await expect(dock(page), "Cancel leaves no held dock behind").toHaveCount(0);
  await page.waitForTimeout(UNANSWERED_MS);
  expect(await goalsIn(page.request, fx.fixtureId, "hockey.goal"), "a cancelled goal is never written").toEqual([]);

  // 4. Penalty corner: the choice hands over to the ordinary HELD dock (enrichment, Send now), with no kind chips.
  await tile(page, "goal-home").click();
  await expect(choice(page)).toBeVisible({ timeout: 10_000 });
  await choice(page).getByTestId("pad-dock-chip-kind:pc").click();
  await expect(choice(page)).toHaveCount(0, { timeout: 5_000 });
  await expect(dock(page).getByTestId("pad-send-now"), "the chosen goal is held like any goal").toBeVisible({ timeout: 5_000 });
  await freezeClock(page);
  await expect(dock(page).locator('[data-testid^="pad-dock-chip-kind:"]'), "the type is asked once").toHaveCount(0);
  expect(await goalsIn(page.request, fx.fixtureId, "hockey.goal"), "held, not yet sent").toEqual([]);
  await dock(page).getByTestId("pad-send-now").click();
  await expect.poll(async () => (await goalsIn(page.request, fx.fixtureId, "hockey.goal")).length, { timeout: 20_000 }).toBe(1);
  await page.clock.resume();
  const [pc] = await goalsIn(page.request, fx.fixtureId, "hockey.goal");
  expect(pc!.payload, "the corner goal carries its side and its type").toEqual(
    expect.objectContaining({ by: fx.homeEntrantId, kind: "pc" }),
  );
  await expect(dock(page)).toHaveCount(0, { timeout: 5_000 });

  // 5. Own goal (the existing control): struck by away, credited to home (FIH Rule 9.12).
  await tile(page, "goal-away").click();
  await expect(choice(page)).toBeVisible({ timeout: 10_000 });
  await choice(page).getByTestId("pad-dock-chip-ownGoal").click();
  await expect(dock(page).getByTestId("pad-send-now")).toBeVisible({ timeout: 5_000 });
  await freezeClock(page);
  await dock(page).getByTestId("pad-send-now").click();
  await expect.poll(async () => (await goalsIn(page.request, fx.fixtureId, "hockey.goal")).length, { timeout: 20_000 }).toBe(2);
  await page.clock.resume();
  const og = (await goalsIn(page.request, fx.fixtureId, "hockey.goal"))[1]!;
  expect(og.payload, "the own goal is a typed goal").toEqual(expect.objectContaining({ by: fx.awayEntrantId, kind: "og" }));
  await expect
    .poll(() => scoreOf(page.request, fx.fixtureId), { timeout: 20_000, message: "corner + away's own goal = 2-0 home" })
    .toEqual({ home: 2, away: 0 });
});

test("ice hockey (IIHF, the contrast): a goal tap is the ordinary held goal — no type question, and the goal lands typeless", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `HGT Icehockey ${TAG}`,
    sportKey: "icehockey",
    variantKey: "iihf",
    home: [{ fullName: `HGT I Home ${TAG}` }],
    away: [{ fullName: `HGT I Away ${TAG}` }],
  });
  await openLive(page, fx.fixtureId);

  await tile(page, "goal-home").click();
  await expect(dock(page).getByTestId("pad-send-now"), "ice hockey holds the goal at once").toBeVisible({ timeout: 10_000 });
  await freezeClock(page);
  await expect(choice(page), "ice hockey never asks a goal's type").toHaveCount(0);
  await dock(page).getByTestId("pad-send-now").click();
  await expect.poll(async () => (await goalsIn(page.request, fx.fixtureId, "icehockey.goal")).length, { timeout: 20_000 }).toBe(1);
  await page.clock.resume();
  const [goal] = await goalsIn(page.request, fx.fixtureId, "icehockey.goal");
  expect(goal!.payload.kind, "a side-only ice hockey goal stays typeless").toBeUndefined();
});
