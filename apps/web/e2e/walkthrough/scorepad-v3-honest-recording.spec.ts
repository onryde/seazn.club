// R7 — the pad's own honesty: what it shows on screen must match what it put
// in the ledger, for three shapes of "what actually happened" that no
// existing walkthrough covers.
//
// Every event under test here is a TAPPED event, never a seeded one — this
// folder's own rule ("setup may use the API to REACH a state; every event
// that IS the thing under test must be TAPPED") and the owner's own words,
// twice: "make sure that test by hand, not the API" / "I meant that test
// hands in walkthrough". An API-driven version of any of the three tests
// below would pass with the defect it exists to catch fully present — that
// is exactly how the double-submit guard's silent swallow survived for
// months (see TEST 1's own header).
//
// Sibling of scorepad-v3-badminton-match.spec.ts: same fixture helper, same
// locator shapes (`half`/`halfScore`/`ledger`), same reasoning for scoping
// `half` to `button` rather than a wildcard. Deliberately NOT that file's
// whole-match shape — each test here isolates ONE tap-time behaviour rather
// than playing a match to a decided result.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG, type RosteredFixture } from "../helpers";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { HUMAN_FASTEST_REPEAT_MS } from "../../src/components/v2/scorepad/use-pad-pipeline";

test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function scorebug(page: Page) {
  return pad(page).locator('[data-role="v3-scorebug"]');
}
/** Scoped to `button` deliberately: a half renders EITHER a `<button>`
 *  (tappable) OR a plain `<div>` at the same grid position until the client
 *  re-renders from the fold, and a wildcard locator happily clicks the dead
 *  `<div>`. Same reasoning, same locator shape as every sibling walkthrough's
 *  own `half`. */
function half(page: Page, side: "home" | "away") {
  return scorebug(page).locator(".grid > button").nth(side === "home" ? 0 : 1);
}
function halfScore(page: Page, side: "home" | "away") {
  return scorebug(page)
    .locator(".grid > *")
    .nth(side === "home" ? 0 : 1)
    .locator(".app-display.font-bold");
}
function v3Dock(page: Page) {
  return pad(page).locator('[data-role="v3-dock"]');
}
/** PAGE-WIDE, not pad-scoped (R7/C1): the console moves the ledger panel
 *  OUT of the pad root (`ScorePad`'s `hideActivity`, honoured by
 *  `v3-activity-slot` never rendering there), so `[data-role="v3-activity"]`
 *  is the panel's own root and is addressed off `page`, exactly as
 *  scorepad-v3-cricket.spec.ts / scorepad-v3-football.spec.ts already do. */
function activityPanel(page: Page) {
  return page.locator('[data-role="v3-activity"]');
}
/** The server's own 422-class refusal AND a client dispatch fault share this
 *  one banner (`pad-host.tsx`, `data-role="v3-rejection"`, `role="alert"`) —
 *  it lives inside the pad root, not the activity panel. */
function rejectionBanner(page: Page) {
  return pad(page).locator('[data-role="v3-rejection"]');
}

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}
async function ralliesOf(request: APIRequestContext, fixtureId: string) {
  return (await ledger(request, fixtureId)).filter((e) => e.type === "badminton.rally");
}

/** The dock's own dismiss control (`pad.dock.dismiss` — "Send now"):
 *  detail-dock.tsx's `dismiss()` calls `releaseHeld`, an IMMEDIATE FLUSH of
 *  the soft-commit hold, never a cancel. Same helper, same reasoning as
 *  scorepad-v3-badminton.spec.ts's own. */
async function sendHeldNow(page: Page): Promise<void> {
  await v3Dock(page).getByRole("button", { name: "Send now", exact: true }).click();
}

async function openPad(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// TEST 1 — a RUN at speed: the positive proof of R7-43's just-shipped fix.
//
// `DOUBLE_SUBMIT_WINDOW_MS` used to swallow a byte-identical repeat within
// 600ms, so a scorer tapping the same side repeatedly lost points SILENTLY —
// the badminton walkthrough's own comment names the real case: "a side that
// wins a WHOLE game unanswered is nothing but same-side repeats", i.e. a
// player on a run. The window is now 250ms, and seven e2e files had a
// `waitForTimeout(750)` guard-clearance deleted and stayed green — but that
// is only NEGATIVE proof (nothing broke). Nothing until now asserts
// POSITIVELY that a fast run all lands.
//
// So: tap the SAME side six times in a row, AS FAST AS PLAYWRIGHT WILL
// CLICK — no `waitForTimeout`, no ledger poll between taps (a poll is a real
// network round trip and would itself force spacing, silently doing the
// clearance's old job). If this needs an artificial wait to go green, that
// is a FINDING about the just-shipped fix, not something to paper over.
//
// MEASURED AGAINST THIS BUILD (2026-09-01, local `r7`, warm server): the
// assertion below is the CORRECT, intended behaviour and is left exactly as
// specified — it currently FAILS. Six sequential `.click()` calls with
// nothing between them land ~45-90ms apart on this hardware, comfortably
// inside `DOUBLE_SUBMIT_WINDOW_MS` (250ms) for a same-side run (Law 10.1: the
// server never changes while one side keeps winning, so every repeat's
// payload is byte-identical). Only the FIRST tap is accepted; taps 2-6 are
// all refused. This is NOT the silent regression R7-43 fixed — the refusal
// banner (`[data-role="v3-rejection"]`) correctly appears from the second
// refused tap onward, confirmed live — but it does mean "a fast run all
// lands" does not hold for Playwright's own un-paced click speed, only for a
// scorer's real (slower) cadence. See this file's final report for the
// finding this is meant to surface; do not narrow this assertion to make it
// pass without that being a deliberate, reported decision.
// R7-46 — THE PACE IS DERIVED, AND IT IS NOT THE WORKAROUND R7-43 DELETED.
//
// The first draft of this test tapped at Playwright's own `click()` speed —
// ~45-90ms apart on this machine — and asserted all six land. It failed, and
// that failure is NOT a product defect: 45ms is not a human tapping twice, it
// is indistinguishable from one physical press read twice, which is precisely
// what the guard exists to catch. A window that lets a 45ms repeat through
// would let every double-fire through too. Asserting otherwise asks the pad to
// abandon double-submit protection, not to fix it.
//
// What R7-43 actually ruled is narrower and is what this asserts: a scorer on
// a RUN — one side winning point after point, every payload byte-identical —
// must have every tap recorded. The old 600ms window failed that at any human
// cadence, which is why seven spec files and two walkthroughs carried a 750ms
// `waitForTimeout` clearance as a load-bearing workaround.
//
// So the pace is `HUMAN_FASTEST_REPEAT_MS` (use-pad-pipeline.ts) — the fastest
// a scorer can deliberately repeat a tap and mean both. It is DELIBERATELY not
// derived from `DOUBLE_SUBMIT_WINDOW_MS`: the first draft paced at
// `DOUBLE_SUBMIT_WINDOW_MS + 100`, which looks like the careful thing (R7-19:
// take the expected value from the source of truth) and is actually a
// tautology — raise the window to 600 and the pace follows to 700, so the test
// passes at every possible value of the constant it exists to guard.
//
// Pinned against the HUMAN floor instead, this test has a side it can fail on:
// restore the 600ms window and a 350ms-paced run loses five of its six taps.
// The window's own relationship to that floor is asserted directly, and far
// more cheaply, by `use-pad-pipeline`'s unit suite — a raised constant reds
// there in milliseconds rather than waiting for a browser.
const RUN_TAP_PACE_MS = HUMAN_FASTEST_REPEAT_MS;

test("badminton v3: six same-side taps at a real scorer's cadence — a player on a run — all land", async ({
  page,
}) => {
  test.setTimeout(Math.max(60_000, HOLD_MS + 30_000 + 6 * RUN_TAP_PACE_MS));
  const homeName = `V3 Honest Run Home ${TAG}`;
  const awayName = `V3 Honest Run Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Honest Run ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });
  await openPad(page, fx);
  await expect(half(page, "home"), "a live fixture must render a real, tappable half").toBeVisible();

  // Captured BEFORE the run — this is what stops the test passing vacuously
  // if every tap were silently refused: without it, "+6" and "+0" would both
  // read as "the ledger has SOME rallies in it".
  const before = (await ledger(page.request, fx.fixtureId)).length;

  const RUN = 6;
  for (let i = 0; i < RUN; i += 1) {
    // Paced at a human's fastest realistic repeat, never at the machine's.
    // No ledger poll between taps and no per-tap clearance of HOLD_MS: the
    // point of the run is that six taps go in back to back and the pad keeps
    // all six, which is exactly what it did not do at 600ms.
    if (i > 0) await page.waitForTimeout(RUN_TAP_PACE_MS);
    await half(page, "home").click();
  }
  // Nothing was refused along the way. This is the assertion that would still
  // catch a regression if the poll below were ever loosened: a run that lost
  // taps AND showed a refusal is a different failure from one that lost them
  // silently, and R7-30 was the silent kind.
  await expect(rejectionBanner(page), "no tap in a normally-paced run may be refused").toHaveCount(0);

  // The wait belongs HERE, once, not between taps: every tap soft-commits and
  // is not SENT for a full `HOLD_MS`, so the ledger cannot show the run's
  // effect until that window has passed for the LAST tap too.
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: HOLD_MS + 20_000 })
    .toBe(before + RUN);

  // The scorebug must read the matching score, not just the ledger count —
  // the pad's own claim is that the SCREEN is honest, not only the API.
  await expect(halfScore(page, "home"), "the board must show every point of the run, not a truncated count").toHaveText(
    String(RUN),
  );
  await expect(halfScore(page, "away")).toHaveText("0");

  const rallies = await ralliesOf(page.request, fx.fixtureId);
  expect(rallies.length, "every tapped rally in the run must reach the ledger").toBe(RUN);
});

// ---------------------------------------------------------------------------
// TEST 2 — the partial row.
//
// R7-42/F (owner ruling, `_INDEX.md`): a doubles rally opens the scorer dock;
// if nobody answers within `HOLD_MS` the hold drains anyway and the rally
// submits with `wonBy` only. The resulting Activity row must be labelled
// PARTIAL — visibly, in words (`pad-host.tsx`'s `isPartialDockAnswer`,
// `activity.tsx`'s `data-role="v3-activity-partial"` badge). Zero coverage
// before this file: R5-2's own doubles proof (scorepad-v3-badminton.spec.ts)
// always ANSWERS the dock via "Send now", so it never exercises the drain.
//
// FOUND BY THIS TEST, FIXED IN THE SAME PASS (R7-46). When first written this
// FAILED, and not because the predicate was wrong: `isPartialDockAnswer` was
// correctly implemented and correctly wired — but only to `PadHostV3`'s own
// inline `<ActivityPanel>`, which `fixture-console.tsx` SUPPRESSES via
// `hideActivity` on the exact page this walkthrough navigates to. The console
// mounts its own panel (R7/C1's ledger consolidation) and that one received no
// `isPartial` at all, so the badge shipped working on `/score/[token]` and
// missing on the organiser's screen — the one surface whose job is reporting
// what the courtside scorer left incomplete.
//
// The pad now publishes its predicate upward (`onPartialResolver`) rather than
// the console rebuilding a `PadHostView` of its own, and
// `v3/__tests__/legacy-parity.test.ts` holds EVERY `<ActivityPanel>` mount to
// passing `isPartial`, with the set of mounting files pinned so a third mount
// cannot appear unguarded.
test("badminton v3 doubles: an unanswered dock drains PARTIAL, an answered one does not", async ({ page }) => {
  test.setTimeout(Math.max(60_000, HOLD_MS + 40_000));
  const homeFirst = `V3 Honest Pair HomeA ${TAG}`;
  const homeSecond = `V3 Honest Pair HomeB ${TAG}`;
  const awayFirst = `V3 Honest Pair AwayA ${TAG}`;
  const awaySecond = `V3 Honest Pair AwayB ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Honest Pair ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "pair",
    home: [
      { fullName: homeFirst, pairOrder: 1 },
      { fullName: homeSecond, pairOrder: 2 },
    ],
    away: [
      { fullName: awayFirst, pairOrder: 1 },
      { fullName: awaySecond, pairOrder: 2 },
    ],
    emitCoreStart: true,
  });
  await openPad(page, fx);

  // ---- RALLY ONE, tapped and LEFT UNANSWERED ------------------------------
  await half(page, "home").click();
  await expect(v3Dock(page), "a pair's rally must ask who scored it").toBeVisible({ timeout: 20_000 });
  await expect(v3Dock(page)).toContainText("Which player won it?");
  // Nobody answers. Wait the hold out, derived from HOLD_MS — never a flat
  // literal (#688 moved this 6s->12s once already, and e2e runs it at
  // NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000).
  await page.waitForTimeout(HOLD_MS + 3_000);
  await expect(v3Dock(page), "the drained hold must close its own dock").not.toBeVisible();
  await expect
    .poll(async () => (await ralliesOf(page.request, fx.fixtureId)).length, { timeout: 20_000 })
    .toBe(1);
  const unanswered = (await ralliesOf(page.request, fx.fixtureId))[0]!;
  expect(unanswered.payload.scorer, "an unanswered dock must drain with no scorer attribution").toBeUndefined();

  const unansweredRow = activityPanel(page).locator(`[data-event-id="${unanswered.id}"]`);
  await expect(unansweredRow, "the drained rally's own row must be present").toBeVisible({ timeout: 20_000 });
  await expect(
    unansweredRow.locator('[data-role="v3-activity-partial"]'),
    "an unanswered dock's row must be labelled partial",
  ).toBeVisible();

  // ---- RALLY TWO, tapped and ANSWERED -------------------------------------
  // The other direction: a row whose dock WAS answered must NOT carry the
  // badge. One direction alone would pass if every row were wrongly labelled
  // partial.
  await half(page, "home").click();
  await expect(v3Dock(page), "the second rally must open its own dock too").toBeVisible({ timeout: 20_000 });
  await v3Dock(page).getByRole("button", { name: homeFirst, exact: true }).click();
  await sendHeldNow(page);
  await expect
    .poll(async () => (await ralliesOf(page.request, fx.fixtureId)).length, { timeout: 20_000 })
    .toBe(2);
  const rallies = await ralliesOf(page.request, fx.fixtureId);
  const answered = rallies.find((r) => r.id !== unanswered.id)!;
  expect(answered.payload.scorer, "the answered rally must carry the chosen scorer").toBe(
    fx.personIds[homeFirst],
  );

  const answeredRow = activityPanel(page).locator(`[data-event-id="${answered.id}"]`);
  await expect(answeredRow).toBeVisible({ timeout: 20_000 });
  await expect(
    answeredRow.locator('[data-role="v3-activity-partial"]'),
    "an answered dock's row must NOT be labelled partial",
  ).toHaveCount(0);

  // And the FIRST row must still read partial — the badge is per-row, not a
  // stale flag that bleeds onto whatever is newest.
  await expect(unansweredRow.locator('[data-role="v3-activity-partial"]')).toBeVisible();
});

// ---------------------------------------------------------------------------
// TEST 3 — the visible refusal.
//
// The guard still fires inside 250ms, and that is intended: it catches one
// physical tap read twice. What changed (R7-43) is that it must no longer be
// SILENT — the refusal now surfaces through `lastRejection`
// (use-pad-pipeline.ts) / `rejectionText` (pad-host.tsx), rendered as
// `data-role="v3-rejection"`, `role="alert"`.
//
// MEASURED AGAINST THIS BUILD (2026-09-01): the assertion below is the
// correct, intended behaviour and is left exactly as specified — it
// currently FAILS for the two un-awaited `click()` calls below. There are
// TWO separate guards in `use-pad-pipeline.ts`'s `submitHeld`: the WINDOW
// guard (a repeat within `DOUBLE_SUBMIT_WINDOW_MS` of the last ACCEPTED
// submit, after it has fully resolved) is the one R7-43 made visible — its
// own unit test title says so explicitly ("the refusal is now VISIBLE, not
// silent"). But `submitHeld` also has an IN-FLIGHT guard (a synchronous
// second submit of the identical action while the first is still inside its
// own async chain) — its own unit test is titled "an in-flight guard drops a
// SYNCHRONOUS second submit" and asserts only the transport call count,
// never `lastRejection`. Confirmed live: two `click()` calls with a real
// 10ms gap between them correctly show the banner (the WINDOW guard); two
// with NO gap at all (this test, and `Promise.all` in general) hit the
// IN-FLIGHT guard instead and record nothing on screen. A genuinely
// simultaneous double-fire (the literal "one physical tap read twice" this
// whole feature exists for) is arguably closer to the in-flight case than
// the window case, so the higher-value half of R7-43 may still be silent.
// See this file's final report.
test("badminton v3: a genuine sub-250ms double records ONE rally and tells the scorer the repeat was refused", async ({
  page,
}) => {
  test.setTimeout(Math.max(60_000, HOLD_MS + 30_000));
  const homeName = `V3 Honest Double Home ${TAG}`;
  const awayName = `V3 Honest Double Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Honest Double ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });
  await openPad(page, fx);
  await expect(half(page, "home")).toBeVisible();
  await expect(rejectionBanner(page), "no refusal before any tap has happened").toHaveCount(0);

  // SETUP: one real, confirmed rally. Not the thing under test — it exists
  // only to put the pad into a genuinely LIVE, already-serving state before
  // the double is driven, and the ledger poll it waits on is a real network
  // round trip, which is what puts it well outside DOUBLE_SUBMIT_WINDOW_MS
  // on its own (no explicit wait needed here either).
  await half(page, "home").click();
  await expect
    .poll(async () => (await ralliesOf(page.request, fx.fixtureId)).length, { timeout: HOLD_MS + 15_000 })
    .toBe(1);

  // THE DOUBLE UNDER TEST: two taps on the same half, dispatched with no
  // await between them — a genuine sub-250ms repeat, the case the guard
  // exists for (one physical tap read twice), not a paced pair of separate
  // taps.
  const first = half(page, "home").click();
  const second = half(page, "home").click();
  await Promise.all([first, second]);

  // The refusal must be VISIBLE — this is the whole point of R7-43's second
  // half. If it is not, that is a product defect to report, not an
  // assertion to weaken.
  await expect(rejectionBanner(page), "a refused repeat must tell the scorer, not fail silently").toBeVisible({
    timeout: 5_000,
  });
  await expect(rejectionBanner(page)).toHaveAttribute("role", "alert");

  // Exactly ONE new rally reached the ledger: the accepted half of the
  // double, never both.
  await expect
    .poll(async () => (await ralliesOf(page.request, fx.fixtureId)).length, { timeout: HOLD_MS + 20_000 })
    .toBe(2);
  await expect(halfScore(page, "home"), "the refused repeat must not have moved the score a second time").toHaveText(
    "2",
  );
});
