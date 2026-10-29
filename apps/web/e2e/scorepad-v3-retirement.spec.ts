import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, fixturePath, seedRosteredFixture, TAG } from "./helpers";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";

// W2e Task 32 (B2-3; D3 (3) as amended by D15; checklist M12b) -- "player injured, no replacement: the team plays short".
//
// `core.lineup.retirement` existed in the engine and behind the HTTP door; no pad control sent it. Football, volleyball,
// hockey and ice hockey now carry one (`retirement-slot.ts`): a tile per side ("Injured, no sub") that opens the swap
// sheet's OFF picker and STOPS there -- nobody comes on. `w2e-retirement.test.ts` (vitest) proves the decisions against the
// real engine and the picker through the real `SwapSheet`; apps/web vitest is `environment: "node"`, so it cannot tap. What
// only a browser settles, and this file asserts: that the tile is on the live board, that one tap on a person completes the
// retirement (inert-seam class 1: the REAL producer, the REAL consumer), that the event really reaches the server's ledger
// with the payload the engine takes, that the person is gone from the picker afterwards (the second call), and that the
// control is not offered where it must not be.
//
// Football and hockey: football reads its OWN folded `onPitch` (view.squads is its frozen kickoff sheet, so a wrong source
// would re-offer the person who just left); hockey is the kernel adopters' shape (state.squads). Volleyball and ice hockey
// share those two code paths and are swept at every width in mobile.spec.ts.
//
// THE TIMING IS DERIVED, NEVER TYPED: the retirement goes out HELD for `HOLD_MS` (env-tunable, baked into the browser bundle
// at build time), so the ledger is polled for HOLD_MS plus slack, and `test.setTimeout` is derived from the constant too
// (AGENTS.md failure class 20).
test.describe.configure({ mode: "parallel" });

const BUDGET_MS = Math.max(120_000, 60_000 + 6 * HOLD_MS);
const DRAIN_MS = HOLD_MS + 20_000;

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
const v3Tile = (page: Page, id: string) => pad(page).locator(`[data-tile-id="${id}"]`);
const picker = (page: Page, slot: string) => pad(page).locator(`[data-role="v3-swap"][data-swap-slot-id="${slot}"]`);

interface LedgerRow {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}
async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerRow[]> {
  const res = await apiJson<LedgerRow[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}
const retirements = async (request: APIRequestContext, fixtureId: string) =>
  (await ledger(request, fixtureId)).filter((e) => e.type === "core.lineup.retirement");

/** Start the match through the API: the action under test is the CONTROL, and a hand-tapped "Start match" would only add a
 *  way for this file to fail for a reason it is not about (same posture as scorepad-v3-swap-candidate-badges.spec.ts). */
async function postEvent(request: APIRequestContext, fixtureId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  if (state.status !== 200 || !state.data) throw new Error(`postEvent(${type}): GET state -> ${state.status} ${JSON.stringify(state.error)}`);
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data.last_seq,
    type,
    payload,
  });
  if (res.status >= 300) throw new Error(`postEvent(${type}) -> ${res.status} ${JSON.stringify(res.error)}`);
}

async function openLiveConsole(page: Page, fixtureId: string): Promise<void> {
  await page.goto(await fixturePath(page.request, fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
}

test("football v3: the Injured tile opens a picker of the people on the pitch, one tap retires that person and nobody is asked to replace them, and they are not offered again", async ({
  page,
}) => {
  test.setTimeout(BUDGET_MS);
  const names = [`V3 Ret FW ${TAG}`, `V3 Ret MF ${TAG}`, `V3 Ret DF ${TAG}`];
  const bench = `V3 Ret Bench ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Retire FB ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: names[0]!, positionKey: "FW" },
      { fullName: names[1]!, positionKey: "MF" },
      { fullName: names[2]!, positionKey: "DF" },
      { fullName: bench, slot: "bench" },
    ],
    away: [{ fullName: `V3 Ret Away ${TAG}`, positionKey: "GK" }],
  });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await openLiveConsole(page, fx.fixtureId);

  // The tile is on the live board for BOTH sides (the board's two vertical lanes), next to Sub.
  await expect(v3Tile(page, "retire-home"), "the Injured tile is offered to the home side").toBeVisible({ timeout: 20_000 });
  await expect(v3Tile(page, "retire-away")).toBeVisible();
  await expect(v3Tile(page, "sub-home"), "and Sub is still there beside it").toBeVisible();

  await v3Tile(page, "retire-home").click();
  const sheet = picker(page, "retire-home");
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  // WHO is on the pitch: the three starters, not the bench player (an injured player must be one who is playing).
  for (const n of names) {
    await expect(sheet.locator(`[data-candidate-id="${fx.personIds[n]!}"]`), `${n} is on the pitch and so offered`).toBeVisible();
  }
  await expect(sheet.locator(`[data-candidate-id="${fx.personIds[bench]!}"]`), "a bench player cannot be retired").toHaveCount(0);

  // ONE TAP completes it: the sheet closes at once. There is no "who comes on" step.
  const leaving = fx.personIds[names[1]!]!;
  await sheet.locator(`[data-candidate-id="${leaving}"]`).click();
  await expect(sheet, "the picker closes on the first tap: nobody is asked to replace the player").toHaveCount(0);

  // The real server round-trip lands the retirement, with the payload the engine takes (a strict object: side, personId, reason).
  await expect.poll(async () => (await retirements(page.request, fx.fixtureId)).length, { timeout: DRAIN_MS }).toBe(1);
  const [row] = await retirements(page.request, fx.fixtureId);
  expect(row!.payload).toMatchObject({ side: fx.homeEntrantId, personId: leaving, reason: "injured" });
  // Nothing else was written by the control: start, then the one retirement.
  expect((await ledger(page.request, fx.fixtureId)).map((e) => e.type)).toEqual(["core.start", "core.lineup.retirement"]);

  // THE SECOND CALL: the person who left is not offered again (football's source is its live pitch, not the kickoff sheet).
  await v3Tile(page, "retire-home").click();
  const again = picker(page, "retire-home");
  await expect(again).toBeVisible({ timeout: 10_000 });
  await expect(again.locator(`[data-candidate-id="${leaving}"]`), "the retired player is off the pitch").toHaveCount(0);
  await expect(again.locator(`[data-candidate-id="${fx.personIds[names[0]!]!}"]`)).toBeVisible();
  await expect(again.locator(`[data-candidate-id="${fx.personIds[names[2]!]!}"]`)).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("hockey v3: the Injured tile retires a player on the field for good, from the kernel's squad, and the ledger carries the engine's payload", async ({
  page,
}) => {
  test.setTimeout(BUDGET_MS);
  const skaters = [
    { name: `V3 Ret Hk GK ${TAG}`, positionKey: "GK" },
    { name: `V3 Ret Hk DF ${TAG}`, positionKey: "DF" },
    { name: `V3 Ret Hk FW ${TAG}`, positionKey: "FW" },
  ];
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Retire HK ${TAG}`,
    sportKey: "hockey",
    variantKey: "fih-outdoor",
    home: [...skaters.map((s) => ({ fullName: s.name, positionKey: s.positionKey })), { fullName: `V3 Ret Hk Bench ${TAG}`, slot: "bench" as const }],
    away: [{ fullName: `V3 Ret Hk Away ${TAG}`, positionKey: "GK" }],
  });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await openLiveConsole(page, fx.fixtureId);

  await expect(v3Tile(page, "retire-away"), "both sides have the control").toBeVisible({ timeout: 20_000 });
  await v3Tile(page, "retire-home").click();
  const sheet = picker(page, "retire-home");
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  const leaving = fx.personIds[skaters[1]!.name]!;
  await sheet.locator(`[data-candidate-id="${leaving}"]`).click();
  await expect(sheet).toHaveCount(0);

  await expect.poll(async () => (await retirements(page.request, fx.fixtureId)).length, { timeout: DRAIN_MS }).toBe(1);
  const [row] = await retirements(page.request, fx.fixtureId);
  expect(row!.payload).toMatchObject({ side: fx.homeEntrantId, personId: leaving, reason: "injured" });

  // The squad is one short on the SERVER's fold too (read through the state door, not the pad).
  // `GET /state` serves the stored fold under `state` (getFixtureState); hockey adopts the kernel's `state.squads`.
  const state = await apiJson<{ state?: { squads?: { home?: { members?: { personId: string; onField: boolean }[] } } } }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/state`,
  );
  expect(state.status).toBe(200);
  const members = state.data?.state?.squads?.home?.members ?? [];
  expect(members.length, "the server's fold lists the home squad (a missing squad would make the check below vacuous)").toBeGreaterThan(0);
  const me = members.find((m) => m.personId === leaving);
  expect(me?.onField, "the retired player is no longer on the field in the server's fold").toBe(false);

  await v3Tile(page, "retire-home").click();
  await expect(picker(page, "retire-home").locator(`[data-candidate-id="${leaving}"]`)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test("football v3: no Injured tile before the match starts (the control is a live-play control)", async ({ page }) => {
  test.setTimeout(BUDGET_MS);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Retire Pre ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `V3 Ret Pre H ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `V3 Ret Pre A ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx.fixtureId);
  await expect(
    page.getByRole("button", { name: "Start match", exact: true }),
    "the match has not started, so the console still offers Start match",
  ).toBeVisible({ timeout: 20_000 });
  await expect(v3Tile(page, "retire-home")).toHaveCount(0);
  await expect(v3Tile(page, "retire-away")).toHaveCount(0);
});
