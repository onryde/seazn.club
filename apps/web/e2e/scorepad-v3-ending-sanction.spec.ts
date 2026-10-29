import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { apiJson, fixturePath, loginUi, seedRosteredFixture, TAG, withDb, type RosteredFixture } from "./helpers";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import { consentedAnonymousState, dismissCookieBanner, measureOverflowPx } from "./scorepad-a11y-kit";

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
// THREE SURFACES, TWO OF THEM WITHOUT THE ORGANISER'S SPECIAL PATH:
//   - the HANDED DEVICE (`/score/[token]`) — a scorer, `canOrganise` false. Its forfeit is admitted by the server ONLY as the
//     ending of its own side's sanction (D13), so it exercises `scorerMayForfeit` end to end. "Void my last entry" is the
//     device chrome's own control (the pad unmounts nothing here: the fixture is decided, not finalized).
//   - the OFFICIAL SCORER (session auth on the console page: an org VIEWER whose person is the accepted scorer the fixture
//     names — not an organiser, not a device link). D13's headline path: the same `scorerMayForfeit` predicate, reached
//     through the session door, and the official's own void-any-event power (the activity row).
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
const scorebug = (page: Page) => pad(page).locator('[data-role="v3-scorebug"]');
const scorebugHalves = (page: Page) => pad(page).locator('[data-role="v3-scorebug-half"]');

/** The sport's own scorebug invitation to tap ("Tap to award the rally"), from the dictionary's declared `…scorebug.*.hint` keys. */
function scorebugHintsOf(sportKey: string): string[] {
  const re = new RegExp(`^pad\\.${sportKey}\\.scorebug\\..*hint$`);
  const hints = Object.entries(EN).filter(([key]) => re.test(key)).map(([, text]) => text);
  expect(hints.length, `${sportKey}: the dictionary declares a scorebug hint to look for`).toBeGreaterThan(0);
  return hints;
}

/**
 * An ACCEPTED official scorer for one fixture, minted as bracket-finish.spec.ts:187 and forfeit-dialog.spec.ts:154 mint one (the
 * suite has no official storage state): an org VIEWER whose person is the official the fixture names, signed in by session.
 * The viewer row is a team SEAT in the shared org (Pro `members.max`), so it lives exactly as long as the page: `close()` frees it.
 */
async function officialScorerPage(browser: Browser, fixtureId: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const tag = Math.random().toString(36).slice(2, 8);
  const email = `delivered+w2e-official-${TAG}-${tag}@resend.dev`;
  let orgId = "";
  let userId = "";
  await withDb(async (sql) => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${"W2e Official " + tag}, true) returning id`;
    const [o] = await sql<{ org_id: string }[]>`
      select c.org_id from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
       where f.id = ${fixtureId}`;
    orgId = o!.org_id;
    userId = u!.id;
    await sql`insert into org_members (org_id, user_id, role) values (${o!.org_id}, ${u!.id}, 'viewer')`;
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id, lane) values (${o!.org_id}, ${"W2e Official " + tag}, ${u!.id}, 'official') returning id`;
    const [off] = await sql<{ id: string }[]>`
      insert into officials (org_id, display_name, role_keys, person_id)
      values (${o!.org_id}, ${"W2e Official " + tag}, ${sql.json(["scorer"])}, ${p!.id}) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${o!.org_id}, ${fixtureId}, ${off!.id}, 'scorer', 'accepted')`;
  });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await loginUi(page, email);
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
  return {
    page,
    close: async () => {
      try {
        await context.close();
      } finally {
        await withDb(async (sql) => {
          await sql`delete from org_members where org_id = ${orgId} and user_id = ${userId}`;
        });
      }
    },
  };
}

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

      // The positive pair for I-1 below: a quiet pad's scorebug DOES invite the tap, and is not inert.
      const hints = scorebugHintsOf(sport.key);
      await expect(scorebug(page), "a live scorebug shows its tap hint").toContainText(hints[0]!);
      await expect(pad(page).locator('[data-scorebug-inert="true"]')).toHaveCount(0);

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

      // I-1 — the SCOREBUG under the prompt. It stops inviting taps (no hint, both halves inert), and a tap on it is refused,
      // said so in the scorer's words, and writes nothing — not even after the soft-commit hold a recorded tap would sit in.
      await expect(scorebugHalves(page), "both halves are on the pad").toHaveCount(2);
      for (const half of await scorebugHalves(page).all()) {
        await expect(half).toHaveAttribute("data-scorebug-inert", "true");
        await expect(half).toHaveAttribute("aria-disabled", "true");
      }
      for (const hint of hints) await expect(scorebug(page), `"${hint}" must be gone under the prompt`).not.toContainText(hint);
      const before = await ledger(request, fx.fixtureId);
      // `force`: the half is aria-disabled ON PURPOSE (Playwright would otherwise wait for it to become enabled); a scorer's
      // habitual tap on the score is exactly what this proves is answered.
      await scorebugHalves(page).first().click({ force: true });
      await expect(page.locator('[data-role="v3-rejection"]'), "the tap is answered, in the scorer's words").toHaveText(
        EN["pad.ending.blocked"]!,
      );
      await page.waitForTimeout(HOLD_MS + 1_500);
      expect(await ledger(request, fx.fixtureId), "a refused scorebug tap writes nothing").toEqual(before);
      await expect(prompt(page), "and the prompt stays in front").toBeVisible();

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
      // N1: answering the prompt resolves the red "record the ending or void the sanction first" the refused scorebug tap
      // left behind - the sentence must not outlive the answer that resolved it.
      await expect(page.locator('[data-role="v3-rejection"]'), "the stale refusal is gone once the ending is recorded").toHaveCount(0);
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
// The ribbon's Take back clears the stale refusal (W2e T29 carry M1; T32 fix round 1, review M1)
// ---------------------------------------------------------------------------

test("badminton v3 console: on a ledger that ends on the sanction, a refused scorebug tap's banner is cleared by the ribbon's Take back, which voids the sanction", async ({
  page,
  request,
}) => {
  test.setTimeout(BUDGET_MS);
  // single-sport: the refusal banner and the ribbon's Take back are the chassis's own and sport-blind; badminton is the
  // declaring sport the console tests above already seed.
  const sport = SPORTS.find((s) => s.key === "badminton")!;
  expect(sport, "badminton must declare an end level").toBeDefined();
  const fx = await seed(request, sport.key, "TakeBack");
  // The sanction alone, appended through the API (an organiser may append it; the write path refuses what comes after it):
  // the ending is pending, as a reload after a failed second append finds it.
  const tip = Math.max(0, ...(await ledger(request, fx.fixtureId)).map((e) => e.seq));
  const sanction = await apiJson<{ seq: number; event_id: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
    expected_seq: tip,
    type: sport.eventType,
    payload: { by: fx.homeEntrantId, level: sport.level },
  });
  expect(sanction.status, `seeding the pending sanction: ${JSON.stringify(sanction.error)}`).toBe(201);

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(prompt(page), "the pad opens on the ending prompt").toBeVisible({ timeout: 20_000 });

  // A habitual tap on the score is refused, in the scorer's words: the banner is up.
  const banner = page.locator('[data-role="v3-rejection"]');
  await scorebugHalves(page).first().click({ force: true });
  await expect(banner, "the refused tap says why").toHaveText(EN["pad.ending.blocked"]!);

  // The ribbon's Take back targets the newest voidable row, the sanction, and voids it (handleUndo, the pad's one void path).
  const takeBack = pad(page).locator('[data-role="v3-ribbon-undo"]');
  await expect(takeBack, "Take back is offered under the prompt").toBeVisible();
  await takeBack.click();
  await expect.poll(async () => (await typesOf(request, fx.fixtureId)).at(-1), { timeout: 30_000 }).toBe("core.void");
  expect((await ledger(request, fx.fixtureId)).at(-1)!.payload, "the void names the sanction").toMatchObject({
    event_id: sanction.data!.event_id,
  });

  // The ending is no longer pending, play resumes, and the stale sentence went with the void that resolved it.
  await expect(prompt(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(banner, "Take back clears the stale refusal").toHaveCount(0);
  await expect(pad(page).locator('[data-role="v3-tiles"]'), "the board is back").toBeVisible();
});

// ---------------------------------------------------------------------------
// The official scorer — session auth, not an organiser and not a device link (D13's headline path)
// ---------------------------------------------------------------------------

test("badminton v3 official scorer: the disqualification asks, sends the pair, and the official's void of the ending from the activity row brings the prompt back", async ({
  browser,
  request,
}) => {
  test.setTimeout(BUDGET_MS);
  // single-sport: the scorer's door (session vs device link) is sport-blind, and the per-sport pair is already swept above
  // for the device link and the console; badminton is the sport the owner's D13 table names first.
  const sport = SPORTS.find((s) => s.key === "badminton")!;
  expect(sport, "badminton must declare an end level").toBeDefined();
  const fx = await seed(request, sport.key, "Official");
  const official = await officialScorerPage(browser, fx.fixtureId);
  try {
    const page = official.page;
    await page.goto(await fixturePath(request, fx.fixtureId));
    await dismissCookieBanner(page);
    await expect(page.getByRole("link", { name: /My matches/ }), "a scorer here, not a bare viewer").toBeVisible();
    await expect(pad(page), "an accepted official scorer is given the pad").toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("score-forfeit"), "and, as a scorer, not the organiser's Forfeit").toHaveCount(0);

    // Ask, confirm: the sanction and its ending, against the same entrant, written by the OFFICIAL's session.
    expect(await sanctionHomeUpToConfirm(page, sport)).toMatch(/^This ends the match: .+ loses$/);
    await confirmEnding(page);
    await expect.poll(async () => (await typesOf(request, fx.fixtureId)).length, { timeout: DRAIN_MS }).toBe(3);
    const rows = await ledger(request, fx.fixtureId);
    expect(rows.map((e) => e.type)).toEqual(["core.start", sport.eventType, "core.forfeit"]);
    expect(rows[1]!.payload.by).toBe(fx.homeEntrantId);
    expect(rows[2]!.payload, "the ending names the same entrant, disqualified").toEqual({
      by: fx.homeEntrantId,
      reason: "disqualified",
    });
    const state = await apiJson<{ outcome: { winner?: string } | null }>(request, `/api/v1/fixtures/${fx.fixtureId}/state`);
    expect(state.data?.outcome?.winner, "the other side wins").toBe(fx.awayEntrantId);
    await expect(prompt(page)).toHaveCount(0);

    // The official voids the ending from the activity row (two-step), and the prompt is back.
    const newestRow = page.locator('[data-role="v3-activity-row"]').first();
    await newestRow.locator('[data-role="v3-activity-void"]').click();
    await newestRow.locator('[data-role="v3-activity-void-confirm"]').click();
    await expect
      .poll(async () => (await typesOf(request, fx.fixtureId)).at(-1), { timeout: 30_000 })
      .toBe("core.void");
    await expect(prompt(page), "voiding the ending must bring the prompt back").toBeVisible({ timeout: 30_000 });
    // D13: the sanction is the last live event again, so the official may record the ending once more.
    await expect(page.getByTestId("pad-ending-record")).toBeVisible();
    await expect(pad(page).locator('[data-role="v3-tiles"]')).toHaveCount(0);
  } finally {
    await official.close();
  }
});

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

// ---------------------------------------------------------------------------
// Volleyball — "Can <team> still field six players?" (W2e Task 31; D12, D13; rule VB-SE-1)
// ---------------------------------------------------------------------------
//
// An expulsion or a disqualification never ends a volleyball match by itself. The sanction sheet ASKS before it writes
// (`promptLevels`, the engine's declaration, read here); "No" sends the sanction and then `core.forfeit{retired}` as the same
// bound pair as above, "Yes" sends the sanction alone and play continues. The ledger is read back through
// `GET /fixtures/{id}/events` in every case: the question being on screen proves nothing about what was written.

const VB = builtinModules.find((m) => m.key === "volleyball")!;
const VB_DECL = VB.sanctionEnding!;
/** The first level the engine declares as a prompt level, and the pad's own word for it. */
const VB_LEVEL = VB_DECL.promptLevels[0]!;
const VB_LEVEL_LABEL = EN[`sanction.${VB_LEVEL}`] ?? "";
/** A level BELOW the prompt: the sheet must ask nothing for it (a warning is the ladder's first rung; asserted below, not assumed). */
const VB_QUIET_LEVEL = "warning";

/** A full indoor starting six (FIVB's catalog shape), so the sanction sheet asks WHO before it asks the question. */
const COURT = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;
const indoorRoster = (label: string) => COURT.map((positionKey, i) => ({ fullName: `${label} P${i + 1} ${TAG}`, positionKey }));

async function seedVolleyball(request: APIRequestContext, surface: string): Promise<RosteredFixture> {
  return seedRosteredFixture(request, {
    label: `V3 Field-six ${surface} ${TAG}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    home: indoorRoster(`V3 VB ${surface} Home`),
    away: indoorRoster(`V3 VB ${surface} Away`),
    emitCoreStart: true,
  });
}

/** Tap the home side's sanction tile, the prompt level and the first player, and land on the question. Returns its title. */
async function sanctionHomeUpToQuestion(page: Page): Promise<string> {
  const tile = pad(page).locator('[data-tile-id="sanction-home"]');
  await expect(tile, "the sanction tile must be offered on a live pad").toBeVisible({ timeout: 20_000 });
  await tile.click();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole("button", { name: VB_LEVEL_LABEL, exact: true }).click();
  // WHO: the first on-field player (a team sheet is declared, so the person step is asked).
  await sheet(page).locator("[data-candidate-id]").first().click();
  const yes = sheet(page).locator('[data-choice-option-id="yes"]');
  await expect(yes, `${VB_LEVEL} must ask the question before anything is recorded`).toBeVisible();
  return (await sheet(page).locator(".mk-eyebrow").first().innerText()).trim();
}

const QUESTION = /still field six players\?/i;

test("volleyball v3 console: answering No to 'Can <team> still field six players?' sends the sanction then the retired ending, and the other side wins", async ({
  page,
  request,
}) => {
  test.setTimeout(BUDGET_MS);
  const fx = await seedVolleyball(request, "No");
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });

  expect(await sanctionHomeUpToQuestion(page)).toMatch(QUESTION);
  expect(await typesOf(request, fx.fixtureId), "asking must not write").toEqual(["core.start"]);
  await sheet(page).locator('[data-choice-option-id="no"]').click();

  // THE PAIR, in order, on the server's ledger: the sanction, then the retirement against the SAME entrant.
  await expect.poll(async () => (await typesOf(request, fx.fixtureId)).length, { timeout: DRAIN_MS }).toBe(3);
  const rows = await ledger(request, fx.fixtureId);
  expect(rows.map((e) => e.type)).toEqual(["core.start", VB_DECL.eventType, "core.forfeit"]);
  expect(rows[1]!.payload.by, "the sanction names the home entrant").toBe(fx.homeEntrantId);
  expect(rows[1]!.payload.level).toBe(VB_LEVEL);
  expect(rows[2]!.payload, "the ending is the incomplete-team retirement (VB-RT-1) against the SAME entrant").toEqual({
    by: fx.homeEntrantId,
    reason: "retired",
  });

  const state = await apiJson<{ outcome: { winner?: string; loser?: string; reason?: string } | null }>(
    request,
    `/api/v1/fixtures/${fx.fixtureId}/state`,
  );
  expect(state.status).toBe(200);
  expect(state.data?.outcome?.winner, "the OTHER side wins").toBe(fx.awayEntrantId);
  expect(state.data?.outcome?.loser).toBe(fx.homeEntrantId);
  expect(state.data?.outcome?.reason).toBe("retired");
  // Nothing was left pending: this is a retirement, not an unended card.
  await expect(prompt(page)).toHaveCount(0);
});

test("volleyball v3 console: answering Yes sends the sanction alone and play continues", async ({ page, request }) => {
  test.setTimeout(BUDGET_MS);
  const fx = await seedVolleyball(request, "Yes");
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });

  expect(await sanctionHomeUpToQuestion(page)).toMatch(QUESTION);
  await sheet(page).locator('[data-choice-option-id="yes"]').click();

  await expect.poll(async () => (await typesOf(request, fx.fixtureId)).length, { timeout: DRAIN_MS }).toBe(2);
  const rows = await ledger(request, fx.fixtureId);
  expect(rows.map((e) => e.type), "one ordinary event, no ending").toEqual(["core.start", VB_DECL.eventType]);
  expect(rows[1]!.payload.level).toBe(VB_LEVEL);
  await expect(prompt(page), "volleyball never pends on an expulsion").toHaveCount(0);
  await expect(pad(page).locator('[data-role="v3-tiles"]'), "the board is still there").toBeVisible();

  // Play continues: the other side's rally is taken by the strict write path and the match is not decided. At 0-0 nobody has
  // served yet, so the tap first asks who served (both halves carry the serve-opener sheet) and writes nothing until it is
  // answered: answer it as a scorer would (scorepad-v3-soft-commit-inventory.spec.ts's volleyball pattern).
  await scorebugHalves(page).nth(1).click();
  const opener = sheet(page).locator('[data-choice-option-id="home"]');
  await expect(opener, "the first rally asks who served").toBeVisible({ timeout: 10_000 });
  await opener.click();
  await expect
    .poll(async () => (await typesOf(request, fx.fixtureId)).includes("volleyball.rally"), { timeout: DRAIN_MS })
    .toBe(true);
  const state = await apiJson<{ outcome: unknown }>(request, `/api/v1/fixtures/${fx.fixtureId}/state`);
  expect(state.data?.outcome, "no outcome: play goes on").toBeNull();
  expect(await measureOverflowPx(page)).toBe(0);
});

test("volleyball v3 console: a level below the prompt (a warning) asks nothing and sends one event", async ({ page, request }) => {
  test.setTimeout(BUDGET_MS);
  expect(VB_DECL.promptLevels, "the engine does not prompt on a warning").not.toContain(VB_QUIET_LEVEL);
  const fx = await seedVolleyball(request, "Warn");
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  const tile = pad(page).locator('[data-tile-id="sanction-home"]');
  await expect(tile).toBeVisible({ timeout: 20_000 });
  await tile.click();
  await sheet(page).getByRole("button", { name: EN[`sanction.${VB_QUIET_LEVEL}`]!, exact: true }).click();
  await sheet(page).locator("[data-candidate-id]").first().click();
  // No question follows the person: the sheet is done and the event goes out alone.
  await expect(sheet(page).locator('[data-choice-option-id="no"]'), "a warning asks nothing about six players").toHaveCount(0);
  await expect.poll(async () => (await typesOf(request, fx.fixtureId)).length, { timeout: DRAIN_MS }).toBe(2);
  expect((await typesOf(request, fx.fixtureId)).slice(1)).toEqual([VB_DECL.eventType]);
});

test("volleyball v3 device link: a scorer's No sends the retired ending (D13 admits it right after the sanction, and nowhere else)", async ({
  browser,
  request,
}) => {
  test.setTimeout(BUDGET_MS);
  const fx = await seedVolleyball(request, "DL");
  const minted = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", {
    label: `V3 Field-six volleyball ${TAG}`,
  });
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState(), viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.goto(`/score/${minted.data!.secret}`);
    const accept = page.getByRole("button", { name: "Accept", exact: true });
    if ((await accept.count()) > 0) await accept.click();
    await expect(pad(page), "the v3 pad must render on the device link").toBeVisible({ timeout: 20_000 });

    expect(await sanctionHomeUpToQuestion(page)).toMatch(QUESTION);
    await sheet(page).locator('[data-choice-option-id="no"]').click();

    // The scorer's own session writes both: the server's `scorerMayForfeit` admits `retired` after a prompt-level sanction.
    await expect.poll(async () => (await typesOf(request, fx.fixtureId)).length, { timeout: DRAIN_MS }).toBe(3);
    const rows = await ledger(request, fx.fixtureId);
    expect(rows.map((e) => e.type)).toEqual(["core.start", VB_DECL.eventType, "core.forfeit"]);
    expect(rows[2]!.payload).toEqual({ by: fx.homeEntrantId, reason: "retired" });
    const state = await apiJson<{ outcome: { winner?: string; reason?: string } | null }>(request, `/api/v1/fixtures/${fx.fixtureId}/state`);
    expect(state.data?.outcome?.winner).toBe(fx.awayEntrantId);
    expect(state.data?.outcome?.reason).toBe("retired");
  } finally {
    await ctx.close();
  }
});
