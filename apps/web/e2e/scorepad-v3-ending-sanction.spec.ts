import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { apiJson, fixturePath, seedRosteredFixture, TAG, type RosteredFixture } from "./helpers";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import { consentedAnonymousState, measureOverflowPx } from "./scorepad-a11y-kit";

// W2e Task 30 (B2-1; D3, D13; rules X-SE-1, X-SE-3) — a disqualifying sanction ends the match FROM THE PAD.
//
// WHY THIS IS A BROWSER SPEC. `w2e-ending-sanction.test.ts` (vitest) proves every DECISION against the real engine and the
// real skin: which levels ask "This ends the match", the pair's two payloads, the prompt model and its eligibility rule, and
// (server-rendered through the real `PadHostV3`) that the pad opens on the prompt. apps/web vitest is `environment: "node"`,
// so it cannot tap. What only a browser settles: that the sheet's Confirm really sends the SANCTION and then its ENDING
// (inert-seam class 1: a seam is proven by driving it through its real producer and consumer), that the hold really drains
// the pair in order, that the match really is decided for the OTHER side, and that voiding the ending really brings the
// prompt back.
//
// TWO SURFACES, BOTH WITHOUT THE ORGANISER'S SPECIAL PATH:
//   - the HANDED DEVICE (`/score/[token]`) — a scorer, `canOrganise` false. Its forfeit is admitted by the server ONLY as the
//     ending of its own side's sanction (D13), so it exercises `scorerMayForfeit` end to end. "Void my last entry" is the
//     device chrome's own control (the pad unmounts nothing here: the fixture is decided, not finalized).
//   - the ORGANISER'S CONSOLE (`/competitions/.../fixtures/..`) — the organiser's void of the ending is the activity row's
//     two-step Void.
//
// THE TIMING IS DERIVED, NEVER TYPED. The sanction goes out HELD for `HOLD_MS` (env-tunable, baked into the browser bundle at
// build time — this process's value is only right when the server under test was built with the same env), and the ending is
// queued behind it. `test.setTimeout` is derived from the constant too (AGENTS.md failure class 20: a blown budget reports
// itself as a DATA defect).
test.describe.configure({ mode: "parallel" });

const BUDGET_MS = Math.max(120_000, 60_000 + 6 * HOLD_MS);
/** Long enough for the sanction's hold to release ON ITS OWN and the pair to drain. */
const DRAIN_MS = HOLD_MS + 20_000;

const EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/**
 * The sports under test, read from the ENGINE's declaration (`sanctionEnding.endLevels`), not typed here: the level a scorer
 * taps is the first end level, and its on-screen label is the pad's own vocabulary entry for it. A sport that gains an end
 * level moves this list with the registry.
 */
const SPORTS = builtinModules
  .filter((m) => (m.sanctionEnding?.endLevels.length ?? 0) > 0)
  .map((m) => ({
    key: m.key,
    eventType: m.sanctionEnding!.eventType,
    level: m.sanctionEnding!.endLevels[0]!,
    levelLabel: EN[`sanction.${m.sanctionEnding!.endLevels[0]!}`] ?? "",
  }));

// Both are individual sports with a one-person side: no person step in the sanction sheet (the lineup-less tennis fixture has
// no candidates, the badminton singles side has one on-field player), so the sheet is level -> confirm.
const SEEDS: Record<string, { variantKey: string }> = {
  badminton: { variantKey: "bwf" },
  tennis: { variantKey: "tour" },
};

function pad(page: Page) {
  return page.locator('[data-role="pad-v3"]');
}
const sheet = (page: Page) => pad(page).locator('[data-role="v3-sheet"]');
const prompt = (page: Page) => page.getByTestId("pad-ending-pending");

interface LedgerRow {
  id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}
async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerRow[]> {
  const res = await apiJson<LedgerRow[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}
const typesOf = async (request: APIRequestContext, fixtureId: string) =>
  (await ledger(request, fixtureId)).map((e) => e.type);

async function seed(request: APIRequestContext, sportKey: string, surface: string): Promise<RosteredFixture> {
  return seedRosteredFixture(request, {
    label: `V3 Ending ${sportKey} ${surface} ${TAG}`,
    sportKey,
    variantKey: SEEDS[sportKey]!.variantKey,
    entrantKind: "individual",
    home: [{ fullName: `V3 Ending ${sportKey} ${surface} Home ${TAG}` }],
    away: [{ fullName: `V3 Ending ${sportKey} ${surface} Away ${TAG}` }],
    // No fixture lineup: nobody to ask "which player" in the sanction sheet (and the tennis skin's own rosterless fallback).
    skipLineups: sportKey === "tennis",
    emitCoreStart: true,
  });
}

/** Tap the home side's sanction tile, pick the end level, and read the confirm back. Returns the read-back sentence. */
async function sanctionHomeUpToConfirm(page: Page, sport: (typeof SPORTS)[number]): Promise<string> {
  const tile = pad(page).locator('[data-tile-id="sanction-home"]');
  await expect(tile, "the sanction tile must be offered on a live pad").toBeVisible({ timeout: 20_000 });
  await tile.click();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole("button", { name: sport.levelLabel, exact: true }).click();
  const summary = sheet(page).getByTestId("pad-sheet-summary");
  await expect(summary, `${sport.level} must ask 'This ends the match' before anything is recorded`).toBeVisible();
  // Nothing has been written yet: the read-back is a question, not a record.
  return (await summary.innerText()).trim();
}

async function confirmEnding(page: Page): Promise<void> {
  await sheet(page).getByTestId("pad-sheet-confirm").click();
}

// ---------------------------------------------------------------------------
// The handed device — a scorer
// ---------------------------------------------------------------------------

for (const sport of SPORTS) {
  test(`${sport.key} v3 device link: the ${sport.level} sanction asks, then sends the sanction and its ending for the same side; voiding the ending brings the prompt back`, async ({
    browser,
    request,
  }) => {
    test.setTimeout(BUDGET_MS);
    const fx = await seed(request, sport.key, "DL");
    const minted = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", {
      label: `V3 Ending ${sport.key} ${TAG}`,
    });
    expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);

    // The token is the ONLY credential on this surface, so the context starts with no storage state.
    const ctx = await browser.newContext({ storageState: await consentedAnonymousState(), viewport: { width: 1280, height: 900 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`/score/${minted.data!.secret}`);
      const accept = page.getByRole("button", { name: "Accept", exact: true });
      if ((await accept.count()) > 0) await accept.click();
      await expect(pad(page), "the v3 pad must render on the device link").toBeVisible({ timeout: 20_000 });

      const sentence = await sanctionHomeUpToConfirm(page, sport);
      expect(sentence).toMatch(/^This ends the match: .+ loses$/);
      // Nothing was recorded by asking.
      expect(await typesOf(request, fx.fixtureId), "asking must not write").toEqual(["core.start"]);
      await confirmEnding(page);

      // THE PAIR, in order, on the server's ledger: the sanction, then the forfeit against the SAME entrant.
      await expect
        .poll(async () => (await typesOf(request, fx.fixtureId)).length, { timeout: DRAIN_MS })
        .toBe(3);
      const rows = await ledger(request, fx.fixtureId);
      expect(rows.map((e) => e.type)).toEqual(["core.start", sport.eventType, "core.forfeit"]);
      expect(rows[1]!.payload.by, "the sanction names the home entrant").toBe(fx.homeEntrantId);
      expect(rows[1]!.payload.level).toBe(sport.level);
      expect(rows[2]!.payload, "the ending names the SAME entrant, with the disqualified reason").toEqual({
        by: fx.homeEntrantId,
        reason: "disqualified",
      });

      // The match is DECIDED for the other side.
      const state = await apiJson<{ outcome: { winner?: string; loser?: string; reason?: string } | null }>(
        request,
        `/api/v1/fixtures/${fx.fixtureId}/state`,
      );
      expect(state.status).toBe(200);
      expect(state.data?.outcome?.winner, "the OTHER side wins").toBe(fx.awayEntrantId);
      expect(state.data?.outcome?.loser, "the sanctioned side loses").toBe(fx.homeEntrantId);
      expect(state.data?.outcome?.reason).toBe("disqualified");

      // No prompt once it is decided; the device chrome's own "Void my last entry" takes the ending back.
      await expect(prompt(page)).toHaveCount(0);
      await page.getByTestId("device-void-mine").click();
      await expect
        .poll(async () => (await typesOf(request, fx.fixtureId)).at(-1), { timeout: 30_000 })
        .toBe("core.void");

      // ...and the pad is back on the ending prompt, with the scorer offered the ending again (the sanction is the last
      // live event, so the server admits it). The prompt's own "Void the sanction" is NOT offered here: a handed device's
      // `ownEventIds` does not survive the pad remounting (the fixture was decided, so it unmounted), and the pad offers a
      // void only for a row it knows is the device's own. The device chrome's "Void my last entry" (read off the server's
      // `device_link_id`) is the scorer's way out of the sanction, and it is there.
      await expect(prompt(page), "voiding the ending must bring the prompt back").toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("pad-ending-record")).toBeVisible();
      await expect(page.getByTestId("device-void-mine"), "the scorer keeps a way to take the sanction back").toBeVisible();
      // The board is not offered under the prompt.
      await expect(pad(page).locator('[data-role="v3-tiles"]')).toHaveCount(0);

      // Re-confirm from the prompt: a fresh ending against the same side, and the match is decided again.
      await page.getByTestId("pad-ending-record").click();
      await expect
        .poll(async () => (await typesOf(request, fx.fixtureId)).filter((t) => t === "core.forfeit").length, {
          timeout: 30_000,
        })
        .toBe(2);
      const last = (await ledger(request, fx.fixtureId)).at(-1)!;
      expect(last.payload).toEqual({ by: fx.homeEntrantId, reason: "disqualified" });
      await expect(prompt(page)).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
}

// ---------------------------------------------------------------------------
// The organiser's console
// ---------------------------------------------------------------------------

for (const sport of SPORTS) {
  test(`${sport.key} v3 console: taking the sanction back inside the hold writes nothing; confirming it ends the match and the ending can be voided from the activity row`, async ({
    page,
    request,
  }) => {
    test.setTimeout(BUDGET_MS);
    const fx = await seed(request, sport.key, "Console");
    await page.goto(await fixturePath(page.request, fx.fixtureId));
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });

    // 1. Ask, confirm, then TAKE BACK inside the hold: both events leave together, nothing ever reaches the ledger.
    await sanctionHomeUpToConfirm(page, sport);
    await confirmEnding(page);
    const takeBack = pad(page).locator('[data-role="v3-ribbon-undo"]');
    await expect(takeBack, "the held sanction must be takeback-able inside its hold").toBeVisible({ timeout: 10_000 });
    await takeBack.click();
    await page.waitForTimeout(HOLD_MS + 1_500);
    expect(await typesOf(request, fx.fixtureId), "a taken-back pair writes nothing, not even the ending").toEqual([
      "core.start",
    ]);
    await expect(prompt(page), "and leaves no prompt behind").toHaveCount(0);

    // 2. Confirm for real and let it drain.
    await sanctionHomeUpToConfirm(page, sport);
    await confirmEnding(page);
    await expect.poll(async () => (await typesOf(request, fx.fixtureId)).length, { timeout: DRAIN_MS }).toBe(3);
    expect((await typesOf(request, fx.fixtureId)).slice(1)).toEqual([sport.eventType, "core.forfeit"]);

    // 3. The organiser's void of the ending, from the activity row (two-step), brings the prompt back.
    const newestRow = page.locator('[data-role="v3-activity-row"]').first();
    await newestRow.locator('[data-role="v3-activity-void"]').click();
    await newestRow.locator('[data-role="v3-activity-void-confirm"]').click();
    await expect
      .poll(async () => (await typesOf(request, fx.fixtureId)).at(-1), { timeout: 30_000 })
      .toBe("core.void");
    await expect(prompt(page), "voiding the ending must bring the prompt back").toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pad-ending-record")).toBeVisible();

    // 4. "Void the sanction" instead: the match resumes (the board is back, no prompt).
    await page.getByTestId("pad-ending-void").click();
    await expect(prompt(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(pad(page).locator('[data-role="v3-tiles"]'), "play resumes on the board").toBeVisible();
  });
}

// ---------------------------------------------------------------------------
// A warning is one ordinary event
// ---------------------------------------------------------------------------

test("badminton v3 console: a warning-level sanction sends one event and no prompt", async ({ page, request }) => {
  test.setTimeout(BUDGET_MS);
  const fx = await seed(request, "badminton", "Warn");
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  const tile = pad(page).locator('[data-tile-id="sanction-home"]');
  await expect(tile).toBeVisible({ timeout: 20_000 });
  await tile.click();
  await sheet(page).getByRole("button", { name: EN["sanction.warning"]!, exact: true }).click();
  await expect(sheet(page).getByTestId("pad-sheet-summary"), "a warning asks nothing about ending the match").toHaveCount(0);
  await expect
    .poll(async () => (await typesOf(request, fx.fixtureId)).length, { timeout: DRAIN_MS })
    .toBe(2);
  expect((await typesOf(request, fx.fixtureId)).slice(1)).toEqual(["badminton.sanction"]);
  await expect(prompt(page)).toHaveCount(0);
  expect(await measureOverflowPx(page)).toBe(0);
});
