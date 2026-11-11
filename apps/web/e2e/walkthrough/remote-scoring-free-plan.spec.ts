// WALKTHROUGH — Remote scoring (device links, the scoring QR) is free on every plan
// (V488, owner ruling 2026-11-02, "make it free", in line with "all scoring is free").
//
// The organiser's story this plays, on a COMMUNITY org (a fresh user and org nobody
// else touches; no subscription, no Event Pass): open a started match's console, open
// Remote scoring, press Create scoring link, and get the QR. A second, signed-out
// browser (the courtside volunteer's phone) opens the link, taps the match to its end
// and the organiser's own record shows the result, written through the link.
//
// ── WHAT IS A REACH AND WHAT IS THE TEST (this folder's README rule) ───────
// REACH, over the API: a started individual boardgame fixture (one half tap decides
// it, so the whole match is one tap).
// THE TEST, in the browser: the hand-over panel on a Community org offers Create, never
// an upgrade gate; Create shows the QR and the link; at 320/768/1280 the panel holds the
// same controls with no horizontal page scroll; the signed-out phone opens that link on
// the pad; one tap on a side decides the match; the ledger row carries the link's id and
// the fixture is decided with the tapped side as winner.
//
// The observable on the phone is the pad's own ribbon, and the proof of the result is
// the organiser's API read of the ledger, never the pad's optimistic fold.
import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, fixturePath, seedRosteredFixture, TAG } from "../helpers";
import { dismissConsent, freshOrg, waitForHydration } from "../directory-kit";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { holdRemoteScoringOpen } from "../helpers/console-panels";

// A fresh user: the shared storage state is the Pro org, which would prove nothing.
test.use({ storageState: { cookies: [], origins: [] } });

const WIDTHS = [320, 768, 1280] as const;
/** A page load, a seed, or a poll of the server's own record. */
const STEP_MS = 20_000;
/** A click or a local assertion: a fraction of a page load. */
const REACH_MS = 5_000;
/** The phone's tap soft-commits: it is SENT once `HOLD_MS` runs out, so the ledger cannot show it sooner. */
const SEND_MS = HOLD_MS + 15_000;
/** Derived from the journey (AGENTS.md class 20): the login and org, the seed, the console, the phone's page,
 *  the hand-over, a capture per width, and one sent tap. */
const BUDGET_MS = Math.max(
  180_000,
  8 * STEP_MS + (12 + 2 * WIDTHS.length) * REACH_MS + SEND_MS,
);

const pad = (page: Page) => page.locator('[data-role="pad-v3"]');
const scorebug = (page: Page) => pad(page).locator('[data-role="v3-scorebug"]');
/** Scoped to `button` deliberately (the boardgame walkthrough's own `half`): a half is a tappable `<button>` or a
 *  dead `<div>` at the same grid position. */
const half = (page: Page, side: "home" | "away") =>
  scorebug(page).locator(".grid > button").nth(side === "home" ? 0 : 1);
const ribbon = (page: Page) => pad(page).locator('[data-role="v3-ribbon"]');

const tokenIn = async (panel: Locator) =>
  (await panel.locator('[data-testid="device-link-url"]').innerText()).split("/score/")[1]!.trim();

/** One panel state at every width: no horizontal page scroll, nothing overflowing the panel, and the controls the
 *  panel shows, read back for the 320-vs-1280 parity check. */
async function shootPanel(page: Page, panel: Locator, testInfo: TestInfo, name: string): Promise<string[][]> {
  const perWidth: string[][] = [];
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expect(panel).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(page);
    expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth), `${name} ${w}: nothing overflows the panel`).toBeLessThanOrEqual(1);
    perWidth.push((await panel.getByRole("button").allInnerTexts()).map((b) => b.trim()));
    const path = testInfo.outputPath(`${name}-${w}.png`);
    await panel.screenshot({ path, animations: "disabled" });
    await testInfo.attach(`${name}-${w}`, { path, contentType: "image/png" });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  return perWidth;
}

type LedgerRow = { id: string; seq: number; type: string; device_link_id: string | null; payload: Record<string, unknown> };

test("a Community organiser opens Remote scoring, hands out the QR, and a signed-out phone taps the match to its end", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(BUDGET_MS);

  // ---- REACH: a fresh Community org, and a live match in it.
  const { orgId } = await freshOrg(page, "dlfree");
  await dismissConsent(page);
  // The premise this whole story stands on: a Community org, no subscription, no Event Pass. Read from the server's
  // own resolution rather than assumed from freshOrg's docblock.
  const resolved = await apiJson<{ plan_key: string }>(page.request, `/api/orgs/${orgId}/entitlements`, "GET");
  expect(resolved.status, `entitlements read: ${JSON.stringify(resolved.error)}`).toBe(200);
  expect(resolved.data?.plan_key, "premise: a fresh org is on the Community plan").toBe("community");
  const fx = await seedRosteredFixture(page.request, {
    label: `Free Remote ${TAG}`,
    sportKey: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    home: [{ fullName: `Free Home ${TAG}` }],
    away: [{ fullName: `Free Away ${TAG}` }],
    emitCoreStart: true,
  });

  // ---- THE TEST, organiser: console -> Remote scoring -> Create -> the QR.
  await page.setViewportSize({ width: 1280, height: 900 });
  await holdRemoteScoringOpen(page);
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  const anchor = page.locator('[data-testid="score-pad"]');
  await expect(anchor).toBeVisible({ timeout: STEP_MS });
  await waitForHydration(anchor);
  await page.locator('[data-role="device-handover"]').click();
  const panel = page.locator('[data-role="device-link-panel"]');
  await expect(panel).toBeVisible({ timeout: STEP_MS });

  // The Create button is there, and no upgrade gate stands in its place (the gate is an anchor with data-feature).
  const mint = panel.getByTestId("device-link-mint");
  await expect(mint, "a Community org is offered Create scoring link").toBeVisible();
  await expect(panel.locator("a[data-feature]"), "no upgrade gate in the hand-over panel").toHaveCount(0);
  await mint.click();
  await expect(panel.getByTestId("device-link-url")).toBeVisible({ timeout: STEP_MS });
  await expect(panel.locator("a[data-feature]"), "no upgrade gate after Create either").toHaveCount(0);
  const secret = await tokenIn(panel);
  expect(secret.startsWith("dl_"), `a scoring link was made: ${secret.slice(0, 6)}...`).toBe(true);

  const perWidth = await shootPanel(page, panel, testInfo, "community-qr");
  expect(perWidth[0], "the same controls in the same order at 320 and 1280").toEqual(perWidth[2]);

  const active = await apiJson<{ id: string }>(page.request, `/api/v1/fixtures/${fx.fixtureId}/device-links`);
  expect(active.status, `the organiser reads the live link: ${JSON.stringify(active.error)}`).toBe(200);
  const linkId = active.data!.id;

  // ---- THE TEST, the volunteer's phone: signed out, opens the link, taps the match to its end.
  const phoneCtx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const phone = await phoneCtx.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`${new URL(page.url()).origin}/score/${secret}`);
    await expect(pad(phone), "the link opens the pad").toBeVisible({ timeout: STEP_MS });
    await expect(half(phone, "home"), "a live match renders a tappable half").toBeVisible();
    await expectNoHorizontalScroll(phone);

    await half(phone, "home").click();
    await expect(ribbon(phone), "the tap decided the match").toContainText("Result recorded", { timeout: REACH_MS });
    await expect(ribbon(phone)).toContainText("Home");

    // ---- The organiser's own record: the result arrived through the link.
    await expect
      .poll(
        async () =>
          ((await apiJson<LedgerRow[]>(page.request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`)).data ?? []).filter(
            (e) => e.type === "boardgame.result",
          ).length,
        { timeout: SEND_MS, message: "the phone's tap never reached the organiser's ledger" },
      )
      .toBe(1);
  } finally {
    await phoneCtx.close();
  }

  const rows = (await apiJson<LedgerRow[]>(page.request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`)).data ?? [];
  const result = rows.filter((e) => e.type === "boardgame.result");
  expect(result, "exactly one result").toHaveLength(1);
  expect(result[0]!.device_link_id, "the result was written through the link, not a session").toBe(linkId);
  expect(result[0]!.payload.winner).toBe(fx.homeEntrantId);

  const state = await apiJson<{ status: string; outcome: { winner?: string } | null }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/state`,
  );
  expect(state.status).toBe(200);
  expect(state.data!.status, "the match is decided").toBe("decided");
  expect(state.data!.outcome?.winner).toBe(fx.homeEntrantId);
});
