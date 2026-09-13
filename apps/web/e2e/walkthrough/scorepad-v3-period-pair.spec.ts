// R6 — hockey & ice hockey, WHOLE MATCHES: tapped from a live pad through a
// suspension whose minutes/servedBy are actually chosen in the sheet, the
// game clock started, paused, corrected and run out to a genuine expiry, a
// full period ladder, to a decided result — and, for ice hockey, through a
// tied regulation into the shoot-out.
//
// scorepad-skins.spec.ts and v6-sports.spec.ts prove one goal and one
// card/penalty flow each, against a synthetic fold — never a whole match,
// never the clock, never a suspension sheet answered past `class`, never a
// shoot-out. This file is what `scorepad-v3-volleyball-match.spec.ts` (this
// folder's own sibling) is for every other sport this programme has
// shipped: tap a real match to a decided result through the transition that
// has broken every sport that skipped this proof, then undo the deciding
// event.
//
// THE DEFECT CLASS THIS MUST BE ABLE TO SEE (R6 fix pass 2 gap 1,
// docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/_INDEX.md): a
// decided ice-hockey shoot-out once displayed "2 — 2" on the pad while the
// engine's own `summary.headline` held "3 — 2 (GWS 3–0)" — the pad was
// reading `state.goals` instead of the credited official score. An
// assertion that reads the pad's own held state object cannot see that; it
// has to read RENDERED TEXT off the page the way a scorer actually would.
// Every assertion below anchors on `="` for any `data-*` probe — React
// serialises an omitted prop as the literal string `"$undefined"`, so a
// bare `data-foo` probe passes in both states (AGENTS.md's own standing
// trap).
//
// Both sports share `period-shared.ts` — one engine kernel
// (`sports/period/kernel.ts`) under two presets — so this file shares its
// whole rig between them and only the class ladder, the vocabulary and (ice
// hockey alone) the shoot-out differ.
//
// THE CLOCK IS CORRECTED FORWARD, NEVER WAITED OUT. A real two-minute
// penalty run down in real time would make this file the most expensive leg
// in the suite for no extra proof: `PadClockBar`'s correction control moves
// the SAME local clock a scorer would nudge for a genuine misread, so
// tapping "+1:00" is the honest, by-hand way to make time pass, not a
// shortcut around the UI. The suspension used for this is a genuinely
// scorer-CHOSEN 1-minute award (the sheet's own `minutes` step, typed to
// "1" rather than left at the class default) so a single correction clears
// it with margin.
//
// Set DEMO_PACE=<ms> and run with `--headed` to watch it happen in a real
// browser; DEMO_HOLD=<ms> keeps the window open at the end.
import { test, expect, type Locator, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, fixturePath, seedRosteredFixture, TAG } from "../helpers";

test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function scorebug(page: Page) {
  return pad(page).locator('[data-role="v3-scorebug"]');
}
function halfScore(page: Page, side: "home" | "away") {
  return scorebug(page)
    .locator(".grid > *")
    .nth(side === "home" ? 0 : 1)
    .locator(".app-display.font-bold");
}
function strip(page: Page, id: string) {
  return scorebug(page).locator(`[data-strip-item-id="${id}"]`);
}
function v3Tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}
function v3Sheet(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
}
function choiceOption(sheet: Locator, optionId: string) {
  return sheet.locator(`[data-choice-option-id="${optionId}"]`);
}
function candidateOption(sheet: Locator, personId: string) {
  return sheet.locator(`[data-candidate-id="${personId}"]`);
}
function clockBar(page: Page) {
  return pad(page).locator('[data-role="v3-clock"]');
}
function clockValue(page: Page) {
  return pad(page).locator('[data-role="v3-clock-value"]');
}
function clockToggle(page: Page) {
  return pad(page).locator('[data-role="v3-clock-toggle"]');
}
function clockAdjust(page: Page) {
  return pad(page).locator('[data-role="v3-clock-adjust"]');
}
function clockPlus(page: Page) {
  return pad(page).locator('[data-role="v3-clock-plus"]');
}

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

interface PeriodPairFixtureState {
  status: string;
  outcome: { winner?: string; method?: string } | null;
  state: { phase?: string; goals?: { home?: number; away?: number } };
  summary: {
    headline?: string;
    detail?: { nextAdvance?: string | null; shootoutNext?: string | null };
  };
}

/** The SAME `/state` endpoint the pad and the organiser console both read —
 *  used here only to decide WHICH tile this file is about to tap (the next
 *  period label, whose shoot-out turn it is) or to read back the engine's
 *  own ground truth AFTER a UI action, never to perform the action itself. */
async function fixtureState(request: APIRequestContext, fixtureId: string): Promise<PeriodPairFixtureState> {
  const res = await apiJson<PeriodPairFixtureState>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(res.status, `state read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data!;
}

const PACE = Number(process.env.DEMO_PACE ?? 0);
const HOLD = Number(process.env.DEMO_HOLD ?? 0);

let shotNo = 0;
async function shot(page: Page, sportSlug: string, caption: string): Promise<void> {
  shotNo += 1;
  const n = String(shotNo).padStart(2, "0");
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await expectNoHorizontalScroll(page);
    await page.screenshot({
      path: `e2e-artifacts/period-pair-${sportSlug}/${n}-${caption}-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 1100 });
}

async function pace(page: Page): Promise<void> {
  if (PACE > 0) await page.waitForTimeout(PACE);
}

/** ONE goal, tapped — the v3 tile commits on the tap itself (no sheet, no
 *  Confirm; period-shared.ts's own `buildTiles`). Leaves whatever Detail
 *  Dock opens alone: `queue.ts`'s `HOLD_MS` window auto-flushes it, and
 *  the dock is an inline panel, not a blocking overlay, so the next tap
 *  reaches its own tile regardless. */
async function tapGoal(page: Page, request: APIRequestContext, fixtureId: string, side: "home" | "away"): Promise<void> {
  const before = (await ledger(request, fixtureId)).length;
  await pace(page);
  await v3Tile(page, `goal-${side}`).click();
  await expect
    .poll(async () => (await ledger(request, fixtureId)).length, { timeout: 20_000 })
    .toBe(before + 1);
}

/** The "Advance period" tile — one tap, no sheet: `expectedAdvance` leaves
 *  nothing to choose (period-shared.ts's own `buildTiles` comment, "the
 *  tile says which marker it is about to record"). `expectedLabel`, when
 *  given, is read straight off the SCOREBUG after the tap — the rendered
 *  proof the transition actually landed, not merely that a tap happened. */
async function tapAdvance(
  page: Page,
  request: APIRequestContext,
  fixtureId: string,
  expectedLabel?: string,
): Promise<void> {
  const before = (await ledger(request, fixtureId)).length;
  await pace(page);
  await v3Tile(page, "advance").click();
  await expect
    .poll(async () => (await ledger(request, fixtureId)).length, { timeout: 20_000 })
    .toBe(before + 1);
  if (expectedLabel !== undefined) {
    await expect(
      strip(page, "period"),
      `the board must repoint onto the period it just advanced to ("${expectedLabel}")`,
    ).toContainText(expectedLabel, { timeout: 20_000 });
  }
}

interface SuspensionChoice {
  side: "home" | "away";
  classKey: string;
  reasonId: string;
  /** Typed into the sheet's own `minutes` step — a genuine scorer CHOICE,
   *  never the class default (R6 dispatch: "minutes … actually chosen"). */
  minutes: string;
  servedByPersonId: string;
}

/** The suspension tile through its FULL guided sheet — class, reason,
 *  minutes (typed, not left at the class default), servedBy (a specific
 *  candidate, not merely "whichever renders first"). This is the exact
 *  sequence R6 fix pass 4 finding 4 fixed: before it, the sheet claimed
 *  this event but asked only class/reason, silently dropping both fields
 *  this function drives by hand. */
async function tapSuspensionWithFields(
  page: Page,
  request: APIRequestContext,
  fixtureId: string,
  choice: SuspensionChoice,
): Promise<void> {
  const before = (await ledger(request, fixtureId)).length;
  await pace(page);
  await v3Tile(page, `suspension-${choice.side}`).click();
  const sheet = v3Sheet(page);
  await expect(sheet, "the suspension tile must open the guided sheet").toBeVisible({ timeout: 20_000 });
  await choiceOption(sheet, choice.classKey).click();
  await expect(choiceOption(sheet, choice.reasonId), "the reason step must follow the class step").toBeVisible({
    timeout: 10_000,
  });
  await choiceOption(sheet, choice.reasonId).click();

  const minutesField = sheet.getByLabel("Minutes", { exact: true });
  await expect(minutesField, "the minutes step must follow the reason step").toBeVisible({ timeout: 10_000 });
  await minutesField.fill(choice.minutes);
  await expect(minutesField, "the typed minutes must actually take").toHaveValue(choice.minutes);
  await sheet.getByRole("button", { name: "Confirm", exact: true }).click();

  const candidate = candidateOption(sheet, choice.servedByPersonId);
  await expect(candidate, "the servedBy step must follow minutes, and offer the chosen candidate").toBeVisible({
    timeout: 10_000,
  });
  await candidate.click();
  await expect(sheet, "the sheet must close once servedBy is answered").toHaveCount(0, { timeout: 20_000 });

  await expect
    .poll(async () => (await ledger(request, fixtureId)).length, { timeout: 20_000 })
    .toBe(before + 1);
}

/** A real shoot-out attempt, driven by the SAME tile + one-step sheet the
 *  scorer taps. `side` must be whichever `summary.detail.shootoutNext`
 *  names — the OTHER side's tile is `disabled` (period-shared.ts's own
 *  `buildTiles`), so tapping the wrong one would leave this function
 *  waiting on a click that can never land. */
async function tapShootoutAttempt(
  page: Page,
  request: APIRequestContext,
  fixtureId: string,
  side: "home" | "away",
  scored: boolean,
): Promise<void> {
  const before = (await ledger(request, fixtureId)).length;
  await pace(page);
  await v3Tile(page, `attempt-${side}`).click();
  const sheet = v3Sheet(page);
  await expect(sheet, "the attempt tile must open the outcome sheet").toBeVisible({ timeout: 20_000 });
  await choiceOption(sheet, scored ? "scored" : "missed").click();
  await expect
    .poll(async () => (await ledger(request, fixtureId)).length, { timeout: 20_000 })
    .toBe(before + 1);
}

/** Start/pause is the SAME control, toggled — `data-running` is the
 *  rendered proof, not an inference from which label was tapped.
 *  2026-09-13: also waits for `*.clock` on the ledger (overlay publish). */
async function toggleClock(
  page: Page,
  request: APIRequestContext,
  fixtureId: string,
  clockType: string,
  expectRunning: boolean,
): Promise<void> {
  const before = (await ledger(request, fixtureId)).filter((e) => e.type === clockType).length;
  await pace(page);
  await clockToggle(page).click();
  await expect(clockBar(page), `the clock must read data-running="${expectRunning ? "yes" : "no"}"`).toHaveAttribute(
    "data-running",
    expectRunning ? "yes" : "no",
  );
  await expect
    .poll(
      async () => {
        const events = (await ledger(request, fixtureId)).filter((e) => e.type === clockType);
        if (events.length < before + 1) return null;
        return events[events.length - 1]!.payload.running === expectRunning;
      },
      { timeout: 20_000, message: `${clockType} must land with running=${expectRunning}` },
    )
    .toBe(true);
}

/** Opens the correction panel, taps "+1:00" `times` times, closes it again.
 *  Proof is the READOUT moving AND one `*.clock` per nudge on the ledger
 *  (2026-09-13 — Correct re-anchors the overlay immediately). */
async function correctClockForward(
  page: Page,
  request: APIRequestContext,
  fixtureId: string,
  clockType: string,
  times: number,
): Promise<{ before: string; after: string }> {
  const beforeCount = (await ledger(request, fixtureId)).filter((e) => e.type === clockType).length;
  await pace(page);
  await clockValue(page).click();
  await expect(clockAdjust(page), "the correction panel must open").toBeVisible({ timeout: 10_000 });
  const before = (await clockValue(page).textContent()) ?? "";
  for (let i = 0; i < times; i += 1) {
    await clockPlus(page).click();
  }
  const after = (await clockValue(page).textContent()) ?? "";
  await clockValue(page).click(); // close it again
  await expect(clockAdjust(page), "the correction panel must close").toHaveCount(0);
  await expect
    .poll(async () => (await ledger(request, fixtureId)).filter((e) => e.type === clockType).length, {
      timeout: 20_000,
      message: `${clockType} must publish once per Correct nudge`,
    })
    .toBe(beforeCount + times);
  return { before, after };
}

/** `M:SS` -> whole seconds, so a correction can be asserted numerically
 *  rather than by string diffing two clock faces. */
function parseClock(text: string): number {
  const m = /^(\d+):(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`not a M:SS clock reading: "${text}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function personName(label: string, tag: string, n: 1 | 2): string {
  return `${label} P${n} ${tag}`;
}

/** Two players per side — enough for a `servedBy` candidate that is a
 *  distinct roster member from whoever the scoreline is about, and for the
 *  goal dock's own scorer chips (left untouched here; the event already
 *  committed on the tap, and attribution is not this file's concern). */
function periodPairRoster(label: string, tag: string) {
  return {
    home: [
      { fullName: personName(`${label} Home`, tag, 1) },
      { fullName: personName(`${label} Home`, tag, 2) },
    ],
    away: [
      { fullName: personName(`${label} Away`, tag, 1) },
      { fullName: personName(`${label} Away`, tag, 2) },
    ],
  };
}

/** Walks "Advance period" until the fold itself reaches `target` — reading
 *  `summary.detail.nextAdvance` off the SAME `/state` the tile's own
 *  sublabel is built from (period-shared.ts's `nextAdvanceOf`), purely to
 *  know how many more times to tap and what to expect; the tap is the
 *  action under test each time. */
async function tapAdvanceUntil(
  page: Page,
  request: APIRequestContext,
  fixtureId: string,
  target: string,
  maxSteps = 8,
): Promise<void> {
  for (let i = 0; i < maxSteps; i += 1) {
    const { state, summary } = await fixtureState(request, fixtureId);
    if (state.phase === target) return;
    const next = summary.detail?.nextAdvance;
    if (!next) throw new Error(`ran out of advances before reaching "${target}" (stuck at "${state.phase}")`);
    // NO expectedLabel here, deliberately: `next` is the kernel's own name
    // for the NEXT CHECKPOINT, not a promise about the phase the fold lands
    // on once it is applied — a tied match ticks straight through "FT" into
    // "OT" inside the SAME advance (found running this spec: the assertion
    // read "OT" where "FT" was expected), and the LAST tap of a decided
    // ladder can unmount the pad entirely before any strip text could be
    // read. The loop's own `state.phase === target` check above, re-read
    // after every tap, is the real correctness proof; `tapAdvance`'s own
    // ledger-growth wait is what proves THIS tap dispatched something.
    await tapAdvance(page, request, fixtureId);
  }
  throw new Error(`never reached "${target}" in ${maxSteps} taps`);
}

// ===========================================================================
// HOCKEY (FIH outdoor) — a full match, decided outright in regulation.
// ===========================================================================

test("R6 — hockey: a suspension with its own minutes/servedBy, the clock started/paused/corrected to a genuine expiry, and a full match to a decided result", async ({
  page,
}) => {
  test.setTimeout(240_000);
  shotNo = 0;

  const tag = `${TAG}h`;
  const roster = periodPairRoster("Hockey", tag);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Hockey Match ${tag}`,
    sportKey: "hockey",
    variantKey: "fih-outdoor",
    home: roster.home,
    away: roster.away,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
  await expect(strip(page, "period"), "hockey opens on its first quarter").toContainText("Q1", { timeout: 20_000 });
  await expect(halfScore(page, "home")).toHaveText("0");
  await shot(page, "hockey", "match-open");

  // ---- Q1: HOME opens the scoring ------------------------------------------
  await tapGoal(page, page.request, fx.fixtureId, "home");
  await expect(halfScore(page, "home")).toHaveText("1", { timeout: 20_000 });
  await shot(page, "hockey", "q1-home-goal");

  await tapAdvance(page, page.request, fx.fixtureId, "Q2");

  // ---- Q2: AWAY levels it, then the clock is driven by hand ---------------
  await tapGoal(page, page.request, fx.fixtureId, "away");
  await expect(halfScore(page, "away")).toHaveText("1", { timeout: 20_000 });

  await expect(clockBar(page), "clock() is declared — the bar must be on screen").toBeVisible({ timeout: 20_000 });
  await toggleClock(page, page.request, fx.fixtureId, "hockey.clock", true);
  await expect(clockValue(page), "a running clock must read a real M:SS face").toHaveText(/^\d+:\d{2}$/);
  await shot(page, "hockey", "clock-running");

  // A suspension with its OWN minutes/servedBy, chosen in the sheet — not
  // the class default (2') and not "whichever candidate happened to be
  // first". The AWAY side's second player serves a card recorded against
  // the offence, independent of who is being tracked for the goal above.
  const servedByAway2 = fx.personIds[personName("Hockey Away", tag, 2)]!;
  await tapSuspensionWithFields(page, page.request, fx.fixtureId, {
    side: "away",
    classKey: "green",
    reasonId: "tripping",
    minutes: "1",
    servedByPersonId: servedByAway2,
  });
  await expect(strip(page, "box"), "the box must show the fresh card").toBeVisible({ timeout: 20_000 });
  await shot(page, "hockey", "suspension-fields-chosen");

  // ---- Pause, then correct forward past the 1-minute award -----------------
  await toggleClock(page, page.request, fx.fixtureId, "hockey.clock", false);
  await shot(page, "hockey", "clock-paused");

  const { before, after } = await correctClockForward(page, page.request, fx.fixtureId, "hockey.clock", 1); // +1:00
  expect(parseClock(after), `clock correction never moved the readout off "${before}"`).toBeGreaterThan(
    parseClock(before),
  );
  expect(parseClock(after) - parseClock(before), "a single +1:00 tap must move the clock by exactly 60s").toBe(60);
  await shot(page, "hockey", "clock-corrected");

  // The 1-minute card is now expired by the CORRECTED reading — proof the
  // countdown is measured against the live clock, not the fold's last
  // stamp (R6 fix pass 2 gap 2's own defect).
  await expect(
    strip(page, "box"),
    "the box must read the suspension as expired once the clock has run past its own award",
  ).toContainText("0:00", { timeout: 20_000 });
  await shot(page, "hockey", "countdown-expired");

  // Resume and score again — a real stamped event, which SWEEPS the expired
  // card server-side (kernel.ts sweeps before applying). The proof it is
  // genuinely gone, not merely displaying zero: the Release tile vanishes.
  await toggleClock(page, page.request, fx.fixtureId, "hockey.clock", true);
  await tapGoal(page, page.request, fx.fixtureId, "home");
  await expect(halfScore(page, "home")).toHaveText("2", { timeout: 20_000 });
  await expect(
    v3Tile(page, "release"),
    "an expired-and-swept card must leave nothing left to release",
  ).toHaveCount(0, { timeout: 20_000 });
  await shot(page, "hockey", "suspension-swept");

  // ---- Run out the rest of the ladder — home stays ahead, 2-1 -------------
  await tapAdvanceUntil(page, page.request, fx.fixtureId, "done");

  const decided = await fixtureState(page.request, fx.fixtureId);
  expect(decided.status, "a 2-1 result after a full ladder did not decide the match").toBe("decided");
  expect(decided.outcome, "a decided hockey match carries no outcome").not.toBeNull();
  expect(decided.outcome!.winner).toBe(fx.homeEntrantId);
  await expect(pad(page), "a decided fixture must unmount the pad").toHaveCount(0, { timeout: 20_000 });
  const headline = page.locator("header p.font-mono");
  await expect(headline, `the console must show the engine's own headline, "${decided.summary.headline}"`).toHaveText(
    decided.summary.headline as string,
    { timeout: 20_000 },
  );
  await shot(page, "hockey", "decided");

  // ---- UNDO THE DECIDING EVENT, then prove the board is still usable -------
  // The deciding event here is the LAST "Advance period" tap, not a goal —
  // home's own second goal already put the match beyond doubt earlier;
  // reaching the final period with that lead intact is what actually
  // decided it (found running this spec: undoing expecting a goal-shaped
  // rollback left the score exactly where it was, which is correct — an
  // advance event carries no goal payload to roll back). So the undo must
  // roll back the PHASE, not the score, and re-finishing means tapping
  // "Advance period" again, not "Goal" again.
  // R7/C2 (`c0509d5fd`) RENAMED this control: the dictionary key is
  // `score.voidLast` and it now reads "⟲ Void last entry". "Undo last" no
  // longer exists anywhere in the four locales. R6 wrote this spec in a
  // concurrent worktree and could not see the rename, and e2e runs only on
  // a push to `main` — so this asserted a button that does not exist and
  // nothing said so until the two waves met. Matched on a substring rather
  // than the whole string because the label carries a leading ⟲ glyph.
  const undoLast = page.getByRole("button", { name: /Void last entry/ });
  await expect(undoLast, "a match decided by a tapped period advance left no way to undo it").toBeVisible();
  await undoLast.click();
  await expect
    .poll(async () => (await fixtureState(page.request, fx.fixtureId)).status, { timeout: 20_000 })
    .toBe("in_play");
  await expect(pad(page), "the pad must come back after undoing the deciding advance").toBeVisible({
    timeout: 20_000,
  });
  await expect(
    halfScore(page, "home"),
    "undoing an ADVANCE event carries no goal payload — the score home actually earned must survive it untouched",
  ).toHaveText("2", { timeout: 20_000 });
  await expect(
    v3Tile(page, "advance"),
    "the board must still offer the SAME transition it was just undone off of",
  ).toBeVisible({ timeout: 20_000 });
  await shot(page, "hockey", "undone-pad-back");

  await tapAdvance(page, page.request, fx.fixtureId);
  const refinished = await fixtureState(page.request, fx.fixtureId);
  expect(refinished.status, "the match could not be finished again after an undo").toBe("decided");
  expect(refinished.outcome!.winner, "the re-finished match named the wrong winner").toBe(fx.homeEntrantId);
  await shot(page, "hockey", "refinished");

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});

// ===========================================================================
// ICE HOCKEY (IIHF) — a suspension, the clock, a tied regulation, and a
// shoot-out decided on the pad's own official score.
// ===========================================================================

test("R6 — ice hockey: a suspension with its own minutes/servedBy, the clock run to a genuine expiry, and a tied match through to a shoot-out decided on the engine's own GWS-credited score", async ({
  page,
}) => {
  test.setTimeout(300_000);
  shotNo = 0;

  const tag = `${TAG}i`;
  const roster = periodPairRoster("Icehockey", tag);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Icehockey Match ${tag}`,
    sportKey: "icehockey",
    variantKey: "iihf",
    home: roster.home,
    away: roster.away,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
  await expect(strip(page, "period"), "ice hockey opens on its first period").toContainText("P1", {
    timeout: 20_000,
  });
  await shot(page, "icehockey", "match-open");

  // ---- P1: HOME opens it, and the clock is driven by hand from the start --
  await tapGoal(page, page.request, fx.fixtureId, "home");
  await expect(halfScore(page, "home")).toHaveText("1", { timeout: 20_000 });

  await expect(clockBar(page), "clock() is declared — the bar must be on screen").toBeVisible({ timeout: 20_000 });
  await toggleClock(page, page.request, fx.fixtureId, "icehockey.clock", true);
  await shot(page, "icehockey", "clock-running");

  // A suspension with its OWN minutes/servedBy — the SHORT side (2' minor is
  // ice hockey's shortest class), typed down to 1' so a single correction
  // clears it with margin. The home side's second player serves it.
  const servedByHome2 = fx.personIds[personName("Icehockey Home", tag, 2)]!;
  await tapSuspensionWithFields(page, page.request, fx.fixtureId, {
    side: "home",
    classKey: "minor",
    reasonId: "tripping",
    minutes: "1",
    servedByPersonId: servedByHome2,
  });
  await expect(strip(page, "box"), "the box must show the fresh penalty").toBeVisible({ timeout: 20_000 });
  await shot(page, "icehockey", "suspension-fields-chosen");

  // ---- Pause, correct forward past the 1-minute award, prove the expiry ---
  await toggleClock(page, page.request, fx.fixtureId, "icehockey.clock", false);
  const { before, after } = await correctClockForward(page, page.request, fx.fixtureId, "icehockey.clock", 1);
  expect(parseClock(after) - parseClock(before), "a single +1:00 tap must move the clock by exactly 60s").toBe(60);
  await expect(
    strip(page, "box"),
    "the box must read the penalty as expired once the clock has run past its own award",
  ).toContainText("0:00", { timeout: 20_000 });
  await shot(page, "icehockey", "countdown-expired");

  await toggleClock(page, page.request, fx.fixtureId, "icehockey.clock", true);
  await tapGoal(page, page.request, fx.fixtureId, "away"); // levels it, and sweeps the expired penalty
  await expect(halfScore(page, "away")).toHaveText("1", { timeout: 20_000 });
  await expect(
    v3Tile(page, "release"),
    "an expired-and-swept penalty must leave nothing left to release",
  ).toHaveCount(0, { timeout: 20_000 });
  await shot(page, "icehockey", "suspension-swept-levelled");

  // ---- LEVEL THROUGH THE WHOLE LADDER — the shoot-out is the only thing
  // left that can decide it. No more goals from here. ------------------------
  await tapAdvanceUntil(page, page.request, fx.fixtureId, "SHOOTOUT");
  // "Game-winning shots" — pad.icehockey.phase.SHOOTOUT (icehockey.tsx's own
  // header: "The shoot-out is a GWS", reaching the pad as COPY, not a code
  // branch).
  await expect(strip(page, "period"), "the board must name the shoot-out phase").toContainText(
    "Game-winning shots",
    { timeout: 20_000 },
  );
  await expect(clockBar(page), "a shoot-out is not on the game clock (SkinDefV3.clock's own doc)").toHaveCount(0);
  await shot(page, "icehockey", "shootout-opens");

  // ---- THE SHOOT-OUT: home scores every attempt, away misses every one ----
  // — the same deterministic, best-of-N-clinches-early pattern
  // `_period-fold.ts`'s own `decidedShootout` uses. The FIRST attempt is
  // taken on its own (a single attempt can never itself decide a shoot-out
  // — both sides must have taken at least one), so the "still live, GWS
  // label" proof below has a guaranteed-undecided moment to check: the
  // deterministic pattern can otherwise clinch inside two or three total
  // attempts (found running this spec — checking AFTER the whole loop
  // raced the pad's own unmount and found nothing).
  const opener = await fixtureState(page.request, fx.fixtureId);
  const openerSide = opener.summary.detail?.shootoutNext === "away" ? "away" : "home";
  await tapShootoutAttempt(page, page.request, fx.fixtureId, openerSide, openerSide === "home");

  const shootoutStrip = strip(page, "shootout");
  await expect(
    pad(page),
    "one shoot-out attempt alone can never decide it — the pad must still be live",
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    shootoutStrip,
    'the strip must carry the "GWS" label live, before any decision unmounts the pad',
  ).toContainText("GWS", { timeout: 20_000 });
  await shot(page, "icehockey", "shootout-inflight");

  let attempts = 1;
  while (attempts < 10) {
    const { state, summary } = await fixtureState(page.request, fx.fixtureId);
    if (state.phase !== "SHOOTOUT") break;
    const side = summary.detail?.shootoutNext === "away" ? "away" : "home";
    await tapShootoutAttempt(page, page.request, fx.fixtureId, side, side === "home");
    attempts += 1;
  }
  expect(attempts, "the shoot-out never decided within 10 attempts").toBeLessThan(10);

  // ---- DECIDED — read the engine's own headline, GWS credit and all -------
  const decided = await fixtureState(page.request, fx.fixtureId);
  expect(decided.status, "the shoot-out ladder finished but the fixture never decided").toBe("decided");
  expect(decided.outcome, "a decided shoot-out carries no outcome").not.toBeNull();
  expect(decided.outcome!.method, "this must be a shoot-out decision, not something else").toBe("shootout");
  expect(decided.outcome!.winner, "home scored every attempt and away missed every one").toBe(fx.homeEntrantId);
  const expectedHeadline = decided.summary.headline;
  expect(
    typeof expectedHeadline === "string" && expectedHeadline.includes("GWS"),
    `a decided ice-hockey shoot-out's own headline must carry its GWS credit -> "${String(expectedHeadline)}"`,
  ).toBe(true);

  // THE DEFECT ITSELF: `data-testid="score-pad"` unmounts the instant a
  // fixture decides (fixture-console.tsx's own `scoring && !decided` gate),
  // so the credited score can ONLY be read off the organiser console's own
  // headline paragraph — never off a `pad()`-scoped locator, which is
  // exactly why an assertion against the pad's own held state object could
  // never have caught "2 — 2" shipping in place of "3 — 2 (GWS 3–0)".
  await expect(pad(page), "a decided fixture must unmount the pad").toHaveCount(0, { timeout: 20_000 });
  const headline = page.locator("header p.font-mono");
  await expect(
    headline,
    `the console must show the engine's own GWS-credited headline, "${expectedHeadline}"`,
  ).toHaveText(expectedHeadline as string, { timeout: 20_000 });
  await shot(page, "icehockey", "shootout-decided");

  // ---- UNDO THE DECIDING ATTEMPT, then prove the board is still usable -----
  // R7/C2 (`c0509d5fd`) RENAMED this control: the dictionary key is
  // `score.voidLast` and it now reads "⟲ Void last entry". "Undo last" no
  // longer exists anywhere in the four locales. R6 wrote this spec in a
  // concurrent worktree and could not see the rename, and e2e runs only on
  // a push to `main` — so this asserted a button that does not exist and
  // nothing said so until the two waves met. Matched on a substring rather
  // than the whole string because the label carries a leading ⟲ glyph.
  const undoLast = page.getByRole("button", { name: /Void last entry/ });
  await expect(undoLast, "a match decided by a tapped shoot-out attempt left no way to undo it").toBeVisible();
  await undoLast.click();
  await expect
    .poll(async () => (await fixtureState(page.request, fx.fixtureId)).status, { timeout: 20_000 })
    .toBe("in_play");
  const reopened = await fixtureState(page.request, fx.fixtureId);
  expect(reopened.state.phase, "undoing the deciding attempt must leave the fixture back in its shoot-out").toBe(
    "SHOOTOUT",
  );
  await expect(pad(page), "the pad must come back after undoing the deciding attempt").toBeVisible({
    timeout: 20_000,
  });
  await shot(page, "icehockey", "undone-pad-back");

  // Finish it again — the same side's tile must still be tappable and still
  // decide the match, proving the undo left a genuinely live board rather
  // than a frozen replay of the state before it.
  const { summary: reopenedSummary } = await fixtureState(page.request, fx.fixtureId);
  const retrySide = reopenedSummary.detail?.shootoutNext === "away" ? "away" : "home";
  await tapShootoutAttempt(page, page.request, fx.fixtureId, retrySide, retrySide === "home");
  const refinished = await fixtureState(page.request, fx.fixtureId);
  expect(refinished.status, "the match could not be finished again after an undo").toBe("decided");
  await shot(page, "icehockey", "refinished");

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});
