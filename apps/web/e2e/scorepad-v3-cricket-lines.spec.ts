import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG } from "./helpers";

// Task 18 — owner ruling 12 (2026-09-05, the ONLY deliberate scorepad touch
// of the spectator match-centre programme). Task 17 (engine) made
// `cricket.player.line` carry six optional band-2 fields on top of the seven
// it always had (`batting.fours`/`.sixes`/`.dismissal{kind,bowler,fielder}`,
// `bowling.maidens`/`.wides`/`.noBalls`); this wave wired the pad's generic
// "More" sheet to collect them. This is the FIRST e2e ever to drive a
// `cricket.player.line` through the pad UI (previously only reachable via
// direct API posts in scorecard.test.ts's engine-level fixtures).
//
// SCOPE SPLIT (controller ruling, task 18 dispatch): the brief's own e2e
// description also asserts the PUBLIC match centre reads the posted line
// back (`mc-bat-<personId>`). That surface is not wired yet (runs after
// Task 15) — this spec stops at the LEDGER, reading the fixture's own event
// list back through the same `/api/v1/fixtures/:id/events` endpoint the
// existing cricket walkthroughs already use. The public-page assertion is
// owed to Task 15's own e2e coverage; see this task's report.
//
// Deliberately NOT serial: this spec seeds its own fixture, so there is no
// shared-fixture race to serialise for (matches scorepad-v3-cricket.spec.ts's
// own header reasoning).
test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

async function ledger(
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

/** Post a real ledger event directly (reads `last_seq` fresh each call, the
 *  same pattern scorepad-v3-cricket.spec.ts's own `postEvent` uses) — used
 *  here only to get the fixture into "post" phase fast: `core.start` plus
 *  two FORCE-CLOSED (`partial` omitted) `cricket.innings.summary` totals,
 *  which is what `cricket.ts`'s `decideAfterClose` needs to decide a result
 *  and set `state.phase = "done"` for a default `inningsPerSide: 1` cfg —
 *  the ONE thing that puts the pad's own `resolvePhase` (v3/skins/cricket.tsx)
 *  into "post", which is where `cricket.player.line`'s own padSpec panel
 *  lives (phase: "post", the "Scorecard" panel). Nothing here is under test;
 *  the real pad interaction starts after the `page.goto` below. */
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

/** Every `send()` in pad-host.tsx (including `ActionFormList`'s own
 *  `onSubmit`) goes through `heldSubmit` — a HOLD_MS (12s default) soft-
 *  commit queue, exactly like every ball tap in scorepad-v3-cricket.spec.ts.
 *  Flushing through the dock's own "Send now" (`pad.dock.dismiss`) rather
 *  than waiting out the window keeps this spec's budget sane for TWO
 *  separate player-line submissions. */
async function sendHeldNow(page: Page): Promise<void> {
  await pad(page)
    .locator('[data-role="v3-dock"]')
    .getByRole("button", { name: "Send now", exact: true })
    .click();
}

async function playerLineEvents(request: APIRequestContext, fixtureId: string) {
  return (await ledger(request, fixtureId)).filter((e) => e.type === "cricket.player.line");
}

test(
  "cricket v3: the More sheet's Scorecard line collects 4s/6s/how-out/bowler credit, and a " +
    "legacy-only line stays byte-identical to the pre-ruling-12 7-field payload",
  async ({ page }) => {
    // Two held dispatches (one per player-line submission), each flushed via
    // "Send now" rather than waited out — see sendHeldNow's own doc — plus
    // fixture setup and two innings-summary posts.
    test.setTimeout(90_000);

    // THREE players a side, not one: `allOutWickets` (cricket.ts) is
    // `max(1, min(cfg.playersPerSide, order.length) - 1)` — a one-player
    // roster caps "all out" at 1 wicket, which the innings-1 total below
    // (deliberately > 1, to exercise a real number rather than the
    // degenerate floor) would then exceed and 422. Three gives an all-out
    // ceiling of 2, comfortably above the single wicket each summary below
    // records.
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket Player Line ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [
        { fullName: `V3 Line Batter ${TAG}` },
        { fullName: `V3 Line Home2 ${TAG}` },
        { fullName: `V3 Line Home3 ${TAG}` },
      ],
      away: [
        { fullName: `V3 Line Bowler ${TAG}` },
        { fullName: `V3 Line Away2 ${TAG}` },
        { fullName: `V3 Line Away3 ${TAG}` },
      ],
    });
    const batterName = `V3 Line Batter ${TAG}`;
    const bowlerName = `V3 Line Bowler ${TAG}`;
    const batterId = fx.personIds[batterName]!;
    const bowlerId = fx.personIds[bowlerName]!;

    await postEvent(page.request, fx.fixtureId, "core.start", {});
    // Innings 1 — home bats first (no toss posted, cricket.ts's default
    // `battingFirst: "home"`). Force-closed regardless of wickets/balls
    // (`partial` omitted -> `applySummary` calls `closeOpenInnings`
    // unconditionally) — this is a coarse SUMMARY line, not a delivery, so
    // no ball-by-ball fold is needed to reach a decided match.
    await postEvent(page.request, fx.fixtureId, "cricket.innings.summary", {
      runs: 150,
      wickets: 1,
      legalBalls: 120,
    });
    // Innings 2 — away chases target 151 (home's 150 + 1) and reaches it:
    // `decideAfterClose` (cricket.ts) decides a win once BOTH innings have
    // closed, setting `state.phase = "done"`.
    await postEvent(page.request, fx.fixtureId, "cricket.innings.summary", {
      runs: 151,
      wickets: 1,
      legalBalls: 100,
    });

    await page.goto(await fixturePath(page.request, fx.fixtureId));
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });

    // "post" phase is now live — the skin's "More" tile (phases: live/post)
    // surfaces `cricket.player.line`, the ONLY action in the "post" phase's
    // "Scorecard" panel (cricket.ts's `padSpec`).
    await pad(page).getByRole("button", { name: "More", exact: true }).click();
    await pad(page).getByRole("button", { name: "Scorecard line", exact: true }).click();

    // --- Line 1: every new field touched. ---------------------------------
    await pad(page).getByLabel("Innings", { exact: true }).fill("1");
    await pad(page).getByLabel("Batting out", { exact: true }).check();
    await pad(page).getByLabel("Batting runs", { exact: true }).fill("42");
    await pad(page).getByLabel("Batting balls", { exact: true }).fill("30");
    await pad(page).getByLabel("Batting fours", { exact: true }).fill("5");
    await pad(page).getByLabel("Batting sixes", { exact: true }).fill("2");
    // The original seven fields cover BOTH a batting and a bowling aspect on
    // one action (`checkActionValidity` requires every declared, non-
    // optional field) — this line only bats, so its bowling aspect is
    // recorded as zeroes, exactly as a scorer filing a batting-only line
    // always had to before this task.
    await pad(page).getByLabel("Bowling legal balls", { exact: true }).fill("0");
    await pad(page).getByLabel("Bowling runs", { exact: true }).fill("0");
    await pad(page).getByLabel("Bowling wickets", { exact: true }).fill("0");

    // The dismissal-kind chip row (owner ruling 12/S18 — PadFieldEnum.chips).
    await pad(page)
      .locator('[data-field-path="batting.dismissal.kind"]')
      .getByRole("button", { name: "Bowled", exact: true })
      .click();

    // Person + bowler-credit attribution chips.
    await pad(page)
      .locator('[data-attribution-path="person"]')
      .getByRole("button", { name: batterName, exact: true })
      .click();
    await pad(page)
      .locator('[data-attribution-path="batting.dismissal.bowler"]')
      .getByRole("button", { name: bowlerName, exact: true })
      .click();

    await pad(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await sendHeldNow(page);

    await expect
      .poll(async () => (await playerLineEvents(page.request, fx.fixtureId)).length, { timeout: 20_000 })
      .toBe(1);

    const enrichedLine = (await playerLineEvents(page.request, fx.fixtureId))[0]!;
    // deep-equal, not toMatchObject — no extra keys, and every tapped value
    // lands exactly where it was tapped.
    expect(enrichedLine.payload).toEqual({
      innings: 1,
      person: batterId,
      batting: {
        out: true,
        runs: 42,
        balls: 30,
        fours: 5,
        sixes: 2,
        dismissal: { kind: "bowled", bowler: bowlerId },
      },
      bowling: { legalBalls: 0, runs: 0, wickets: 0 },
    });

    // --- Line 2: negative-with-positive pair — touch NOTHING new. ---------
    // Confirm on line 1 collapses the row back (ActionFormList's own
    // `resetAction`); the "More" sheet itself stays open, so the same
    // collapsed "Scorecard line" row is tapped again with fresh values.
    await pad(page).getByRole("button", { name: "Scorecard line", exact: true }).click();
    await pad(page).getByLabel("Innings", { exact: true }).fill("1");
    await pad(page).getByLabel("Batting out", { exact: true }).check();
    await pad(page).getByLabel("Batting runs", { exact: true }).fill("10");
    await pad(page).getByLabel("Batting balls", { exact: true }).fill("8");
    await pad(page).getByLabel("Bowling legal balls", { exact: true }).fill("6");
    await pad(page).getByLabel("Bowling runs", { exact: true }).fill("4");
    await pad(page).getByLabel("Bowling wickets", { exact: true }).fill("1");
    await pad(page)
      .locator('[data-attribution-path="person"]')
      .getByRole("button", { name: batterName, exact: true })
      .click();

    await pad(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await sendHeldNow(page);

    await expect
      .poll(async () => (await playerLineEvents(page.request, fx.fixtureId)).length, { timeout: 20_000 })
      .toBe(2);

    const legacyLine = (await playerLineEvents(page.request, fx.fixtureId))[1]!;
    // The exact legacy 7-field shape (pre-ruling-12) — no fours/sixes/
    // dismissal/maidens/wides/noBalls key anywhere, proving the six new
    // optional fields never widen the payload when a scorer never touches
    // them.
    expect(legacyLine.payload).toEqual({
      innings: 1,
      person: batterId,
      batting: { out: true, runs: 10, balls: 8 },
      bowling: { legalBalls: 6, runs: 4, wickets: 1 },
    });
  },
);
