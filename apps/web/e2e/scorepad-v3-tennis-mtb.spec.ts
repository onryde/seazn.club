// R4 follow-up — the tennis DECIDER, tapped.
//
// scorepad-v3-tennis.spec.ts is five tests of mid-match mechanics: deuce and
// advantage, serve legality in the dock, the doubles serve pip, the Set-score
// tile's dead-end fix. Not one of them drives tennis to a DECIDED result, and
// none of them touches a match tie-break — the file contains no reference to
// "decided", "tiebreak" or a deciding set at all.
//
// That is precisely the condition under which cricket and football each
// shipped a broken decider through two signed-off waves (R3.5): every surface
// asserted on code, and nothing ever tapped the thing. Tennis carries the same
// structural risk in the same shape — `finalSet: { matchTiebreakTo: 10 }` puts
// the match into `points.kind: "matchTiebreak"`, a distinct sub-state the pad
// must repoint scoring onto, which is exactly what `currentInnings` got wrong
// for the super over.
//
// So this file taps a whole tennis match to a decided result through the match
// tie-break, and then undoes the match-winning point.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  apiJson,
  expectNoHorizontalScroll,
  fixturePath,
  seedRosteredFixture,
  setDivisionConfigSql,
  TAG,
  type RosteredFixture,
} from "./helpers";

test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

/** tapModel S: the scoreboard halves ARE the point buttons. Scoped to
 *  `button` deliberately — a half renders a plain `<div>` at the same grid
 *  position until the client has re-rendered from the fold, and a wildcard
 *  locator clicks that dead `<div>` happily. See scorepad-v3-tennis.spec.ts's
 *  own header for the full reasoning; this is the same locator. */
function tennisHalf(page: Page, side: "home" | "away") {
  return pad(page).locator('[data-role="v3-scorebug"] .grid > button').nth(side === "home" ? 0 : 1);
}

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

interface TennisPoints { kind?: string; home?: number; away?: number }
interface TennisState {
  phase?: string;
  points?: TennisPoints;
  sets?: unknown[];
  setsWon?: { home?: number; away?: number };
}

async function fixtureState(request: APIRequestContext, fixtureId: string) {
  const res = await apiJson<{
    last_seq: number;
    status: string;
    outcome: { kind?: string; winner?: string; method?: string } | null;
    state: TennisState;
  }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(res.status, `state read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data!;
}

const PACE = Number(process.env.DEMO_PACE ?? 0);
const HOLD = Number(process.env.DEMO_HOLD ?? 0);

let shotNo = 0;
async function shot(page: Page, caption: string): Promise<void> {
  shotNo += 1;
  const n = String(shotNo).padStart(2, "0");
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `e2e-artifacts/tennis-mtb/${n}-${caption}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1100 });
}

/** Tap a point on one half and wait for it to REACH the ledger.
 *
 *  `usePadPipeline`'s double-submit guard swallows an identical payload
 *  inside its window, and two points to the SAME side in a row are exactly
 *  that — so a same-side repeat gets its own clearance first. Alternating
 *  taps never need it, which is why the existing tennis spec only pays the
 *  cost once; a tie-break run of consecutive points pays it every time. */
let lastSide: "home" | "away" | null = null;
async function tapPoint(page: Page, fx: RosteredFixture, side: "home" | "away"): Promise<void> {
  const before = (await ledger(page.request, fx.fixtureId)).length;
  if (side === lastSide) await page.waitForTimeout(750);
  if (PACE > 0) await page.waitForTimeout(PACE);
  await tennisHalf(page, side).click();
  lastSide = side;
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: 20_000 })
    .toBe(before + 1);
}

/** A no-ad game is four points; with `gamesTo: 1` that is also a whole set. */
async function winGame(page: Page, fx: RosteredFixture, side: "home" | "away"): Promise<void> {
  for (let i = 0; i < 4; i += 1) await tapPoint(page, fx, side);
}

test("R4 — tennis: tap a match through the deciding-set MATCH TIE-BREAK to a decided result, then undo the match point", async ({
  page,
}) => {
  test.setTimeout(300_000);
  shotNo = 0;
  lastSide = null;

  // `doubles-noad-mtb10` is a SHIPPED variant, not a config invented for this
  // test: no-ad games plus `finalSet: { matchTiebreakTo: 10 }` (ITF App VI —
  // the MTB replaces the deciding set at one set all). The module never
  // inspects entrant kind, so an individual entrant plays it as singles and
  // the scorer is auto-stamped at tap time (R4-5) — one tap per point.
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Tennis MTB ${TAG}`,
    sportKey: "tennis",
    variantKey: "doubles-noad-mtb10",
    entrantKind: "individual",
    home: [{ fullName: `V3 Tennis MTB Home ${TAG}` }],
    away: [{ fullName: `V3 Tennis MTB Away ${TAG}` }],
  });

  const div = await apiJson<{ config: Record<string, unknown> }>(page.request, `/api/v1/divisions/${fx.divisionId}`);
  expect(div.status, `GET division -> ${div.status}`).toBe(200);
  const cfg = div.data!.config;
  // The decider under test must come from the VARIANT, not from anything this
  // test set — otherwise it proves only that the test can write a config.
  expect(cfg.finalSet, "the shipped variant no longer carries the MTB decider").toEqual({ matchTiebreakTo: 10 });

  // One-game sets, so reaching "one set all" costs eight taps instead of
  // ~48. `gamesTo`/`winBy` are positive ints and `tiebreakAt` is nullable
  // (nested/kernel.ts:164-166), so this is a legal config, not a hack — and
  // it leaves `finalSet` untouched, which is the part under test.
  //
  // Written by SQL because a division that already owns fixtures is
  // FORMAT_LOCKED and answers 409 to any non-entrants config change
  // (usecases/divisions.ts). It must also land BEFORE the first event: V347
  // freezes `config_snapshot` at first score.
  await setDivisionConfigSql(fx.divisionId, {
    ...cfg,
    set: { gamesTo: 1, winBy: 1, tiebreakAt: null, tiebreakTo: 7 },
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
  await expect(tennisHalf(page, "home")).toBeVisible();
  await shot(page, "first-point");

  // ---- SET ONE to home, SET TWO to away — every point a tap ---------------
  await winGame(page, fx, "home");
  await expect
    .poll(async () => (await fixtureState(page.request, fx.fixtureId)).state.setsWon?.home ?? 0, { timeout: 20_000 })
    .toBe(1);
  await shot(page, "set-one-to-home");

  await winGame(page, fx, "away");
  const levelled = await fixtureState(page.request, fx.fixtureId);
  expect(levelled.state.setsWon, "one set all is what arms the match tie-break").toEqual({ home: 1, away: 1 });

  // ---- THE DECIDER OPENS BY ITSELF ---------------------------------------
  // The whole point of the file: at one set all the pad must repoint onto a
  // sub-state it was not scoring a moment ago. If it does not, the halves go
  // dead here and the match cannot be finished — the super over's defect,
  // transposed.
  expect(levelled.state.points?.kind, "at one set all the deciding set is a MATCH TIE-BREAK").toBe("matchTiebreak");
  expect(levelled.status).toBe("in_play");
  await expect(tennisHalf(page, "home"), "the match tie-break opened with a dead board").toBeVisible();
  await expect(tennisHalf(page, "away")).toBeVisible();
  await shot(page, "match-tiebreak-opens");

  // ---- SCORE THE MATCH TIE-BREAK -----------------------------------------
  // Five each, then home takes five straight to 10-5. Deliberately NOT 10-0:
  // the engine has no ITF 5b handoff, so a 10-0 tie-break is correct only by
  // accident (parity), and a test that only ever plays 10-0 cannot tell the
  // difference between a real implementation and that accident.
  for (let i = 0; i < 5; i += 1) {
    await tapPoint(page, fx, "home");
    await tapPoint(page, fx, "away");
  }
  const midway = await fixtureState(page.request, fx.fixtureId);
  expect(midway.state.points, "ten tapped tie-break points did not land 5-5").toMatchObject({
    kind: "matchTiebreak",
    home: 5,
    away: 5,
  });
  await shot(page, "match-tiebreak-five-all");

  for (let i = 0; i < 5; i += 1) {
    const st = await fixtureState(page.request, fx.fixtureId);
    if (st.outcome !== null) break;
    await tapPoint(page, fx, "home");
  }

  const decided = await fixtureState(page.request, fx.fixtureId);
  expect(decided.status, "the match tie-break never decided the match").toBe("decided");
  expect(decided.outcome, "a decided tennis match carries no outcome").not.toBeNull();
  expect(decided.outcome!.winner).toBe(fx.homeEntrantId);

  // Every point in the ledger came from a tap — 8 for the two sets, 15 for
  // the tie-break — and nothing invented events on the way.
  const points = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "tennis.point");
  expect(points.length, "the ledger holds a different number of points than were tapped").toBe(23);

  // The pad UNMOUNTS once decided (the wave's own F15/F16), so anchor the
  // capture on the console's decided line instead.
  await page.reload();
  await expect(pad(page)).toHaveCount(0);
  await shot(page, "decided-on-match-tiebreak");

  // ---- UNDO THE MATCH-WINNING POINT --------------------------------------
  // A match decided by a tie-break must stay reversible until Finalize, and
  // the pad must come BACK scoreable — otherwise a mis-tap on match point
  // ends the match with no way out.
  const undoLast = page.getByRole("button", { name: /Undo last/ });
  await expect(undoLast, "a match decided on a tie-break left no way to undo it").toBeVisible();
  await undoLast.click();
  await expect
    .poll(async () => (await fixtureState(page.request, fx.fixtureId)).status, { timeout: 20_000 })
    .toBe("in_play");

  const reopened = await fixtureState(page.request, fx.fixtureId);
  expect(reopened.outcome, "the fixture is in_play but still carries an outcome").toBeNull();
  expect(reopened.state.points?.kind, "undoing the match point did not reopen the tie-break").toBe("matchTiebreak");
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await expect(tennisHalf(page, "home"), "the board came back dead after undoing the match point").toBeVisible();
  await shot(page, "match-point-undone-pad-back");

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});
