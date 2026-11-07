// The football console's e2e helpers, shared by `scorepad-v3-football.spec.ts`
// and `walkthrough/scorepad-v3-football-shared-clock.spec.ts` (S2-5 ruling
// 107). Moved here from the first of those, unchanged, so the second imports
// them rather than keeping a copy that could drift.
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, fixturePath, type RosteredFixture } from "./helpers";

/** The organiser console's pad. `data-testid="score-pad"` is on the pad's own
 *  wrapper (`fixture-console.tsx`), never on the page. */
export function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

export async function ledger(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]> {
  const res = await apiJson<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

/** Dispatch a real ledger event directly, reading `last_seq` fresh each call.
 *  Used for SETUP only — the one action a test is actually about always goes
 *  through the real pad. Same helper, same posture as
 *  scorepad-v3-cricket.spec.ts's own. */
export async function postEvent(
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

/** Open the console and take the fixture live through the console's own
 *  "Start match" control — the real organiser flow. */
export async function openLiveConsole(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
}
