// R3.5 — WHOLE MATCHES, played by hand from the pre-match screen through the
// decider, plus undo in and after a decider.
//
// `scorepad-v3-deciders-byhand.spec.ts` taps every event that IS the decider
// but reaches the decider through the API. This file taps the match TOO: kick
// off / first ball, the goals or deliveries that level it, the period markers,
// and only then the decider. It is the only place that proves a scorer can get
// from "Start match" to a decided result without an API call, which is a
// different claim from "the decider works".
//
// It also covers the two undo questions nothing else asks: whether a
// super-over delivery can be rolled back without corrupting the decider, and
// whether the result a super over produced is still reversible once the pad
// has unmounted (it is — until Finalize).
//
// Set DEMO_PACE=<ms> and run with `--headed` to watch it happen in a real
// browser; DEMO_HOLD=<ms> keeps the window open at the end.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  apiJson,
  fixturePath,
  seedRosteredFixture,
  setDivisionConfigSql,
  TAG,
  type RosteredFixture,
} from "../helpers";

// Each test seeds its own fixture — no shared state.
test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}
function sheet(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
}

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status).toBe(200);
  return res.data ?? [];
}

async function fixtureState(request: APIRequestContext, fixtureId: string) {
  const res = await apiJson<{
    last_seq: number;
    status: string;
    outcome: { kind?: string; winner?: string; method?: string } | null;
    state: Record<string, unknown>;
  }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(res.status).toBe(200);
  return res.data!;
}

async function sendHeldNow(page: Page): Promise<void> {
  const btn = pad(page).locator('[data-role="v3-dock"]').getByRole("button", { name: "Send now", exact: true });
  if (await btn.count()) await btn.click();
}

// Headed demo pacing: DEMO_PACE=<ms> makes each tap watchable in a real
// browser window; DEMO_HOLD=<ms> keeps the window open at the end.
const PACE = Number(process.env.DEMO_PACE ?? 0);
const HOLD = Number(process.env.DEMO_HOLD ?? 0);
async function beat(page: Page): Promise<void> {
  if (PACE > 0) await page.waitForTimeout(PACE);
}

let shotNo = 0;
async function shot(page: Page, dir: string, caption: string, width = 1280): Promise<void> {
  shotNo += 1;
  await page.setViewportSize({ width, height: width === 320 ? 1100 : 1100 });
  await page.waitForTimeout(350);
  const n = String(shotNo).padStart(2, "0");
  await page.screenshot({ path: `e2e-artifacts/fullmatch/${dir}/${n}-${caption}-${width}.png`, fullPage: true });
  if (width !== 1280) await page.setViewportSize({ width: 1280, height: 1100 });
}

async function tapTile(page: Page, fx: RosteredFixture, tileId: string): Promise<LedgerEvent> {
  const before = await ledger(page.request, fx.fixtureId);
  await beat(page);
  await tile(page, tileId).click();
  await sendHeldNow(page);
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: 20_000 })
    .toBe(before.length + 1);
  const after = await ledger(page.request, fx.fixtureId);
  return after[after.length - 1]!;
}

async function tapThroughSheet(
  page: Page,
  fx: RosteredFixture,
  tileId: string,
  optionIds: string[],
): Promise<LedgerEvent> {
  const before = await ledger(page.request, fx.fixtureId);
  await beat(page);
  await tile(page, tileId).click();
  await expect(sheet(page)).toBeVisible({ timeout: 10_000 });
  for (const optionId of optionIds) {
    await beat(page);
    await sheet(page).locator(`[data-choice-option-id="${optionId}"]`).click();
  }
  await sendHeldNow(page);
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: 20_000 })
    .toBe(before.length + 1);
  const after = await ledger(page.request, fx.fixtureId);
  return after[after.length - 1]!;
}

async function startMatch(page: Page, fx: RosteredFixture): Promise<void> {
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect.poll(async () => (await fixtureState(page.request, fx.fixtureId)).status, { timeout: 20_000 })
    .toBe("in_play");
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// FOOTBALL — kick-off, two goals, half time, full time level, shoot-out.
// ---------------------------------------------------------------------------
test("R3.5 — football: play the match to 1-1 by hand, then win it on penalties", async ({ page }) => {
  test.setTimeout(300_000);
  shotNo = 0;

  const fx = await seedRosteredFixture(page.request, {
    label: `DEMO FB ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `Demo FB Home ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `Demo FB Away ${TAG}`, positionKey: "GK" }],
  });

  const div = await apiJson<{ config: Record<string, unknown> }>(page.request, `/api/v1/divisions/${fx.divisionId}`);
  expect(div.status).toBe(200);
  await setDivisionConfigSql(fx.divisionId, {
    ...div.data!.config,
    shootout: true,
    extraTime: { enabled: false, halfMinutes: 15 },
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(page.getByRole("button", { name: "Start match", exact: true })).toBeVisible({ timeout: 20_000 });
  await shot(page, "football", "before-kickoff");

  await startMatch(page, fx);
  await shot(page, "football", "kickoff-0-0");

  await tapTile(page, fx, "goal-home");
  await shot(page, "football", "home-scores-1-0");

  await tapTile(page, fx, "goal-away");
  await shot(page, "football", "away-equalises-1-1");

  await tapThroughSheet(page, fx, "period", ["HT"]);
  await shot(page, "football", "half-time");

  await tapThroughSheet(page, fx, "period", ["FT"]);
  await expect(pad(page).locator('[data-strip-tone="led"]').first()).toContainText("Shoot-out", { timeout: 20_000 });
  await shot(page, "football", "full-time-level-shootout-opens");
  await shot(page, "football", "shootout-opens", 320);

  const taps: { side: string; option: string }[] = [];
  for (let round = 0; round < 12; round += 1) {
    const state = await fixtureState(page.request, fx.fixtureId);
    if (state.outcome !== null) break;
    const homeDisabled = await tile(page, "kick-home").getAttribute("data-tile-disabled");
    const side = homeDisabled === "true" ? "away" : "home";
    const option = side === "home" ? "scored" : "missed";
    const ev = await tapThroughSheet(page, fx, `kick-${side}`, [option]);
    expect(ev.type).toBe("football.shootout.kick");
    taps.push({ side, option });
    if (round < 4) await shot(page, "football", `kick-${round + 1}-${side}-${option}`);
  }

  const final = await fixtureState(page.request, fx.fixtureId);
  expect(final.outcome?.method).toBe("shootout");
  expect(final.status).toBe("decided");

  await page.reload();
  await expect(page.getByText(/won .* on penalties/)).toBeVisible({ timeout: 20_000 });
  await shot(page, "football", "decided-on-penalties");
  await shot(page, "football", "decided-on-penalties", 320);

  console.log(`DEMO FOOTBALL kicks tapped: ${JSON.stringify(taps)}`);
  if (HOLD > 0) await page.waitForTimeout(HOLD);
});

// ---------------------------------------------------------------------------
// CRICKET — toss, a one-over-a-side match tapped to a TIE, then the super over.
// ---------------------------------------------------------------------------
test("R3.5 — cricket: tap a one-over match to a tie, then score the super over", async ({ page }) => {
  test.setTimeout(300_000);
  shotNo = 0;

  const fx = await seedRosteredFixture(page.request, {
    label: `DEMO CR ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `Demo CR Home1 ${TAG}` }, { fullName: `Demo CR Home2 ${TAG}` }],
    away: [{ fullName: `Demo CR Away1 ${TAG}` }, { fullName: `Demo CR Away2 ${TAG}` }],
  });

  const div = await apiJson<{ config: Record<string, unknown> }>(page.request, `/api/v1/divisions/${fx.divisionId}`);
  expect(div.status).toBe(200);
  await setDivisionConfigSql(fx.divisionId, {
    ...div.data!.config,
    // A one-over-a-side match. maxOversPerBowler and minOversForResult MUST
    // come down with it: CricketCfg refines both against the innings length,
    // and an unparseable cfg renders NO PAD AT ALL rather than an error.
    ballsPerInnings: 6,
    ballsPerOver: 6,
    maxOversPerBowler: 1,
    minOversForResult: 1,
    playersPerSide: 2,
    superOver: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(page.getByRole("button", { name: "Start match", exact: true })).toBeVisible({ timeout: 20_000 });
  await shot(page, "cricket", "before-first-ball");

  // The pad only mounts once the match is started, so the toss tile (phases:
  // ["pre"]) is not reachable from here — start, then bat.
  await startMatch(page, fx);
  await shot(page, "cricket", "innings-1-first-ball");

  // Six deliveries: 1,1,0,1,1,0 = 4 runs.
  const overOne = ["run1", "run1", "run0", "run1", "run1", "run0"];
  for (const [i, t] of overOne.entries()) {
    await tapTile(page, fx, t);
    if (i === 2) await shot(page, "cricket", "innings-1-mid-over");
  }
  const afterOne = await fixtureState(page.request, fx.fixtureId);
  console.log(`DEMO CRICKET after over 1: ${JSON.stringify((afterOne.state as Record<string, unknown>).innings)}`);
  if ((await tile(page, "inningsClose").count()) &&
      (await tile(page, "inningsClose").getAttribute("data-tile-disabled")) === "false") {
    await tapThroughSheet(page, fx, "inningsClose", ["other"]).catch(async () => {
      await tapTile(page, fx, "inningsClose");
    });
  }
  await shot(page, "cricket", "innings-1-closed-4-runs");

  for (const [i, t] of overOne.entries()) {
    await tapTile(page, fx, t);
    if (i === 2) await shot(page, "cricket", "innings-2-chasing");
  }
  const afterTwo = await fixtureState(page.request, fx.fixtureId);
  console.log(`DEMO CRICKET after over 2: phase=${(afterTwo.state as { phase?: string }).phase} status=${afterTwo.status}`);
  if ((afterTwo.state as { phase?: string }).phase !== "super_over" &&
      (await tile(page, "inningsClose").count()) &&
      (await tile(page, "inningsClose").getAttribute("data-tile-disabled")) === "false") {
    await tapThroughSheet(page, fx, "inningsClose", ["other"]).catch(async () => {
      await tapTile(page, fx, "inningsClose");
    });
  }

  const tied = await fixtureState(page.request, fx.fixtureId);
  console.log(`DEMO CRICKET tie check: phase=${(tied.state as { phase?: string }).phase} status=${tied.status}`);
  expect((tied.state as { phase?: string }).phase, "the tapped match did not reach a super over").toBe("super_over");
  await page.reload();
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await expect(pad(page).getByText("This innings is closed.")).toHaveCount(0);
  await shot(page, "cricket", "tie-super-over-opens");
  await shot(page, "cricket", "super-over-opens", 320);

  const first = await tapTile(page, fx, "run1");
  expect(first.type).toBe("cricket.superover.ball");
  await shot(page, "cricket", "super-over-ball-1");

  await tapTile(page, fx, "run0");
  await tapTile(page, fx, "run1");
  const after = await fixtureState(page.request, fx.fixtureId);
  const so = (after.state as { superOver?: { innings?: { runs?: number }[] } | null }).superOver;
  expect(so?.innings?.length ?? 0).toBeGreaterThan(0);
  await shot(page, "cricket", "super-over-scored");
  console.log(`DEMO CRICKET superOver: ${JSON.stringify(so)}`);
  if (HOLD > 0) await page.waitForTimeout(HOLD);
});

// ---------------------------------------------------------------------------
// UNDO, in and after a super over. Two questions, both only answerable in a
// browser: (1) does the pad's ribbon Undo roll a super-over delivery back
// without corrupting the decider, and (2) once the super over has DECIDED the
// match and the pad has unmounted, is the result still reversible — and does
// the pad come back when it is?
// ---------------------------------------------------------------------------
test("R3.5 — cricket: undo a super-over ball, then undo the result the super over decided", async ({ page }) => {
  test.setTimeout(300_000);
  shotNo = 0;

  const fx = await seedRosteredFixture(page.request, {
    label: `DEMO CRU ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `Demo CRU Home1 ${TAG}` }, { fullName: `Demo CRU Home2 ${TAG}` }],
    away: [{ fullName: `Demo CRU Away1 ${TAG}` }, { fullName: `Demo CRU Away2 ${TAG}` }],
  });

  const div = await apiJson<{ config: Record<string, unknown> }>(page.request, `/api/v1/divisions/${fx.divisionId}`);
  expect(div.status).toBe(200);
  await setDivisionConfigSql(fx.divisionId, {
    ...div.data!.config,
    ballsPerInnings: 6,
    ballsPerOver: 6,
    maxOversPerBowler: 1,
    minOversForResult: 1,
    playersPerSide: 2,
    superOver: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await startMatch(page, fx);

  // Tie the match by hand, exactly as the demo above does.
  const over = ["run1", "run1", "run0", "run1", "run1", "run0"];
  for (const t of over) await tapTile(page, fx, t);
  for (const t of over) await tapTile(page, fx, t);
  const tied = await fixtureState(page.request, fx.fixtureId);
  expect((tied.state as { phase?: string }).phase).toBe("super_over");

  // ---- (1) UNDO A SUPER-OVER DELIVERY --------------------------------------
  const scored = await tapTile(page, fx, "run1");
  expect(scored.type).toBe("cricket.superover.ball");
  const before = await fixtureState(page.request, fx.fixtureId);
  const soBefore = (before.state as { superOver?: { innings?: { runs?: number }[] } }).superOver;
  expect(soBefore!.innings![0]!.runs).toBe(1);
  await shot(page, "undo", "super-over-ball-recorded");

  await pad(page).locator('[data-role="v3-ribbon"]').getByRole("button", { name: "Take back", exact: true }).click();
  // Undoing the ONLY delivery empties `superOver.innings` rather than leaving a
  // 0-run innings behind — the innings had not started before that ball.
  await expect
    .poll(async () => {
      const st = await fixtureState(page.request, fx.fixtureId);
      const inns = (st.state as { superOver?: { innings?: { runs?: number }[] } }).superOver?.innings ?? [];
      return inns[0]?.runs ?? 0;
    }, { timeout: 20_000 })
    .toBe(0);

  const rolledBack = await fixtureState(page.request, fx.fixtureId);
  expect((rolledBack.state as { phase?: string }).phase, "undo knocked the fixture out of its super over").toBe("super_over");
  expect(rolledBack.status).toBe("in_play");
  // The board must still be scoreable — an undo that leaves every tile dead is
  // the same dead end this wave opened with.
  await expect(pad(page)).toBeVisible();
  await expect(tile(page, "run1")).toHaveAttribute("data-tile-disabled", "false");
  // The void is ADDITIVE: the ledger grows, it does not shrink.
  const led = await ledger(page.request, fx.fixtureId);
  expect(led.some((e) => e.type === "core.void"), "undo wrote no core.void row").toBe(true);
  await shot(page, "undo", "super-over-ball-undone");

  // ---- (2) DECIDE THE MATCH IN THE SUPER OVER, THEN UNDO THAT --------------
  // Away bats first in the super over (it batted second in the match). One run
  // off six, then home passes it.
  await tapTile(page, fx, "run1");
  for (let i = 0; i < 5; i += 1) await tapTile(page, fx, "run0");
  for (let i = 0; i < 6; i += 1) {
    const st = await fixtureState(page.request, fx.fixtureId);
    if (st.outcome !== null) break;
    await tapTile(page, fx, "run1");
  }

  const decided = await fixtureState(page.request, fx.fixtureId);
  console.log(`DEMO UNDO decided: status=${decided.status} outcome=${JSON.stringify(decided.outcome)}`);
  expect(decided.status, "the super over never decided the match").toBe("decided");

  await page.reload();
  // OWNER RULING 17 (2026-09-06) SUPERSEDES F15/F16 HERE. This used to assert
  // `pad(page)` had count 0 — "the pad is GONE by design once decided". The
  // ruling is that "a decided fixture keeps the pad's post-phase panel when
  // the sport module declares post-phase actions, so band-2 player lines can
  // be entered after the result", implemented as `shouldMountPad`
  // (`fixture-console.tsx`) — mount when not decided, OR when `padSpec.panels`
  // contains a `phase: "post"` panel. Cricket declares one, so the pad stays.
  //
  // This assertion was NOT updated when the ruling shipped, and nothing caught
  // it: the same branch had put a non-spec helper inside `e2e/walkthrough/`,
  // which made the whole walkthrough project fail to COLLECT, so this file had
  // not run at all. The count is therefore pinned to what the ruling requires,
  // not flipped from 0 to 1 to go green.
  await expect(pad(page), "ruling 17: cricket declares a post-phase panel, so the pad stays").toHaveCount(1);
  // …and it must be the POST-phase pad, not the live one. Without this, the
  // assertion above would pass just as happily if a decided fixture kept its
  // full scoring surface — which is the actual defect worth fearing here, and
  // the one a bare `toHaveCount(1)` cannot see.
  await expect(
    tile(page, "run1"),
    "a decided fixture is still offering live scoring tiles — the pad mounted, but not in its post phase",
  ).toHaveCount(0);
  const undoLast = page.getByRole("button", { name: /Void last entry/ });
  await expect(undoLast, "a decided super over left no way to undo the result").toBeVisible();
  // Renamed with the assertion above: the pad is no longer gone (ruling 17),
  // and a screenshot called "pad-gone" would be a second thing telling the
  // next reader the superseded story.
  await shot(page, "undo", "decided-by-super-over-post-phase-pad");

  await undoLast.click();
  await expect.poll(async () => (await fixtureState(page.request, fx.fixtureId)).status, { timeout: 20_000 })
    .toBe("in_play");

  const reopened = await fixtureState(page.request, fx.fixtureId);
  expect((reopened.state as { phase?: string }).phase, "undoing the result did not reopen the super over").toBe("super_over");
  expect(reopened.outcome, "the fixture is in_play but still carries an outcome").toBeNull();
  // The pad must COME BACK, and be scoreable again.
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await expect(tile(page, "run1")).toHaveAttribute("data-tile-disabled", "false");
  await shot(page, "undo", "result-undone-pad-back");
  console.log(`DEMO UNDO reopened: phase=${(reopened.state as { phase?: string }).phase} outcome=${JSON.stringify(reopened.outcome)}`);
  if (HOLD > 0) await page.waitForTimeout(HOLD);
});
