import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import {
  activeOrg,
  apiJson,
  fixturePath,
  seedRosteredFixture,
  setDivisionConfigSql,
  TAG,
  type RosteredFixture,
} from "./helpers";
import { consentedAnonymousState, expectNoCookieBanner } from "./scorepad-a11y-kit";

// ScoringPad v3, wave R2/task F1 — NEW coverage the wave's own acceptance
// list requires beyond converting the four pre-existing cricket specs
// (scorepad-v2.spec.ts, scoring.spec.ts, scoring-vocab-labels.spec.ts,
// scorepad-skins.spec.ts): a real browser proof that the context strip's
// G5 fix actually persists a pick into a dispatched payload (rather than
// the chip silently reverting the way it did before G5), a full over that
// honours a NON-default `cfg.ballsPerOver`, a wicket via the v3 guided
// sheet, undo on BOTH sides of the soft-commit hold window (spec §2.3), and
// the device-link (`/score/[token]`) route rendering the same v3 pad the
// console does.
//
// Deliberately NOT serial (test.describe.configure below): every test seeds
// its own fixture, so there is no shared-fixture race to serialise for.
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

/** Open the console and take the fixture live through the console's own
 *  "Start match" control — the real organiser flow, same pattern
 *  scorepad-v2.spec.ts's own `openLiveConsole` already established. */
async function openLiveConsole(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
}

/** Tap one context-strip chip and pick a candidate by NAME.
 *
 *  A chip's accessible name is the COMPOUND `` `${label}: ${name}` ``
 *  (`chipLabel`, context-strip.tsx) the instant the slot already holds a
 *  person — every slot this file ever reaches one already does, via
 *  `resolvePeople`'s own fold/order defaults — so it is NEVER just the bare
 *  label. `chipLabel` is matched as a name PREFIX, anchored at both start and
 *  either end-of-string or ":" (`^…(:|$)`): a bare `exact: true` match on the
 *  label alone matches zero elements and hangs until timeout (the R2-review
 *  bug this replaces — it hung whether or not the underlying override
 *  actually worked, so it could never fail for the right reason), while an
 *  unanchored substring match would let "Striker" also match "Non-striker: …".
 *
 *  Opening pair/bowler chips are buttons BEFORE the first ball (no innings
 *  yet) and the bowler chip is a button at an over boundary. After a wicket
 *  the incoming batter's crease chip is a button until they face. Mid-over
 *  (and once a batter has faced), striker/non-striker are `readOnly` (a
 *  plain `<span>`, no `<button>`). Calling this for a locked chip hangs
 *  (zero buttons match), which is the correct, loud failure rather than a
 *  silent no-op. */
async function setContextPerson(page: Page, chipLabel: string, personName: string): Promise<void> {
  const strip = pad(page).locator('[data-role="context-strip"]');
  await strip.getByRole("button", { name: new RegExp(`^${chipLabel}(:|$)`) }).click();
  const candidate = strip.getByRole("button", { name: personName, exact: true });
  await expect(candidate, `${chipLabel} picker must show real names, not ids`).toBeVisible({ timeout: 10_000 });
  await candidate.click();
}

/** Open a context chip's picker WITHOUT picking, so the candidate list itself
 *  can be inspected. R2c gave the strip real narrowing (ContextSlot.candidates
 *  / .blocked), so "who is even offered, and which of them are refused with a
 *  reason" became a thing worth asserting rather than a list nothing checked. */
async function openContextPicker(page: Page, chipLabel: string) {
  const strip = pad(page).locator('[data-role="context-strip"]');
  await strip.getByRole("button", { name: new RegExp(`^${chipLabel}(:|$)`) }).click();
  return strip;
}

/** The guided-sheet root — chassis-generic (guided-sheet.tsx), same posture
 *  `pad()` above already takes for the scorepad root itself. R2b's
 *  over-by-over sheet is the first place THIS file drives it. */
function sheetRoot(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
}

// ---------------------------------------------------------------------------
// R2b-cricket-over, task 5 continued (2026-08-17) — dock chips, the free-hit
// indicator, the activity log's bowler-name note, the bowler-eligibility
// block, the closed-innings TERMINAL gate, the innings transition, and the
// free-hit wicket-kind gate. Three shared helpers below:
//
// `postEvent` dispatches a real ledger event directly (reading `last_seq`
// fresh each call, same pattern `scoreFixture`/helpers.ts already uses) —
// several tests below use it for SETUP that nothing here is testing (a dull
// completed over, a forced innings close), so only the one action actually
// under test goes through the real pad.
//
// `openConsoleAlreadyLive` is `openLiveConsole` minus the "Start match"
// click, for a fixture whose `core.start` was already posted via
// `postEvent`.
//
// `sendHeldNow` taps the dock's own "Send now" control (`pad.dock.dismiss`
// — detail-dock.tsx's own doc: `dismiss()` calls `releaseHeld`, an
// IMMEDIATE FLUSH, never a cancel). Every test below that needs its
// dispatch CONFIRMED on the ledger uses this instead of waiting out the
// full HOLD_MS window — none of them are testing hold-window TIMING
// itself (the two Undo tests earlier in this file already own that), so
// there is nothing to lose by flushing early, and it keeps every budget
// below well under the 120_000-180_000 the timing-sensitive tests need.
// ---------------------------------------------------------------------------

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

async function openConsoleAlreadyLive(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
}

async function sendHeldNow(page: Page): Promise<void> {
  const btn = pad(page)
    .locator('[data-role="v3-dock"]')
    .getByRole("button", { name: "Send now", exact: true });
  if (await btn.count()) await btn.click();
}

test(
  "cricket v3: a bowler change through the context strip survives into the payload, a full " +
    "over honours cfg ballsPerOver, and a wicket completes through the guided sheet",
  async ({ page }) => {
    // Six held dispatches (five balls + one wicket), each waiting out
    // queue.ts's HOLD_MS soft-commit window before the ledger
    // confirms it (spec §2.3) — comfortably exceeds Playwright's 60s default.
    test.setTimeout(150_000);

    // `hundred` (5-ball overs, cricket.ts:2811) rather than t20's default 6 —
    // "a full over" only proves cfg.ballsPerOver is genuinely READ (G1) if
    // the variant under test does not also happen to match the chassis's own
    // 6-ball fallback (ballsPerOverOf, v3/skins/cricket.tsx).
    //
    // THREE home batters, not two: the incoming-batter step after the catch
    // needs a third name (lineup[2]) or the sheet has nobody to offer.
    // Three batters also means the wicket below leaves two not-out and the
    // innings stays live (scoring-vocab-labels.spec.ts's own "a two-man
    // order would close the innings" reasoning, reused here for the same
    // structural cause). TWO away players for the mirror reason: a bowler
    // change needs a second real fielding-side candidate to change TO.
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket Full Over ${TAG}`,
      sportKey: "cricket",
      variantKey: "hundred",
      home: [
        { fullName: `V3 Striker ${TAG}` },
        { fullName: `V3 NonStriker ${TAG}` },
        { fullName: `V3 Incoming ${TAG}` },
      ],
      away: [{ fullName: `V3 Bowler ${TAG}` }, { fullName: `V3 Fielder ${TAG}` }],
    });
    const striker = fx.personIds[`V3 Striker ${TAG}`]!;
    const nonStriker = fx.personIds[`V3 NonStriker ${TAG}`]!;
    const bowler = fx.personIds[`V3 Bowler ${TAG}`]!;
    const fielder = fx.personIds[`V3 Fielder ${TAG}`]!;

    await openLiveConsole(page, fx);

    // buildContext now renders the opening strip BEFORE ball 1 so a scorer
    // can change the opening pair and opening bowler. This test still scores
    // over 1 on lineup defaults; the opening-pick proof is a dedicated test
    // below. The strip's presence here is not under test.
    let delivered = 0;
    for (const runs of ["1", "0", "2", "0", "4"]) {
      await pad(page).getByRole("button", { name: runs, exact: true }).click();
      delivered += 1;
      await expect
        .poll(
          async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
          { timeout: 20_000 },
        )
        .toBe(delivered);
    }

    // R8 (register row D2) — the MODE INDICATOR, fine half. The strip did not
    // exist at all before the first ball (see the comment above); that ball
    // both created the innings and LOCKED it to the ball-by-ball lane, and
    // the chip now says so. Its sibling assertion — the same chip reading
    // "Over-by-over" over a summary-opened innings — lives in the over-tile
    // test below, so the two together prove the chip tracks the fold rather
    // than printing a constant.
    await expect(
      pad(page).locator('[data-role="context-mode"]'),
      "a ball-opened innings must say it is ball-by-ball",
    ).toHaveText("This innings: Ball-by-ball");

    const overOneBalls = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball");
    expect(overOneBalls, "five deliveries = five cricket.ball events, no more, no fewer").toHaveLength(5);
    expect(overOneBalls[0]!.payload.striker).toBe(striker);
    expect(overOneBalls[0]!.payload.nonStriker).toBe(nonStriker);
    for (const b of overOneBalls) expect(b.payload.bowler).toBe(bowler);

    // cfg.ballsPerOver = 5 (the `hundred` variant) actually reached the pad:
    // five legal deliveries roll the scorebug over to "1.0", not "0.5" (what
    // a hardcoded 6-ball fallback would show). Runs: 1+0+2+0+4 = 7, no
    // wicket yet.
    const scorebug = pad(page).locator('[data-role="v3-scorebug"]');
    await expect(scorebug).toContainText("7/0");
    await expect(scorebug).toContainText("1.0");

    // Over 1 just closed, so `fine.currentBowler` resets to `null`
    // (cricket.ts's own per-over reset — the SAME `currentBowler === null`
    // branch that let ball 1's bowler be a free pick, re-armed) — over 2's
    // bowler is open again, gated only by "not `fine.prevOverBowler`" and
    // "a real fielding-lineup member", never a lineup-order rule. The
    // context strip's own DEFAULT for this slot (resolvePeople's
    // `fine?.currentBowler ?? bowlingOrder[0]`) reads `bowlingOrder[0]` —
    // "V3 Bowler" again, the SAME person who just bowled over 1 — which the
    // fold would REJECT outright ("bowler cannot bowl consecutive overs").
    // So this change is not merely SAFE, it is the one genuinely NECESSARY
    // context-strip pick in this whole flow: without it, over 2's first
    // ball 422s on the chassis's own naive default. G5's own regression was
    // exactly this shape one level up — before the host held pending picks,
    // a tap here would revert on the next render and every ball would
    // silently keep carrying the (here, invalid) default forever.
    await setContextPerson(page, "Bowler", `V3 Fielder ${TAG}`);

    // A caught dismissal via the guided sheet (G2's conditional steps):
    // kind -> [no "who's out" step — caught is not in VARIABLE_OUT_KINDS] ->
    // fielder [caught IS in FIELDER_ELIGIBLE_KINDS] -> completes. Credited to
    // "V3 Bowler" — now fielding rather than bowling, a real, valid
    // fielding-side credit distinct from over 2's own (changed) bowler.
    await pad(page).getByRole("button", { name: "Wicket", exact: true }).click();
    const sheet = pad(page).locator('[data-role="v3-sheet"]');
    await sheet.getByRole("button", { name: "Caught", exact: true }).click();
    await sheet.getByRole("button", { name: `V3 Bowler ${TAG}`, exact: true }).click();
    // Incoming batter is required (Law 25.1). Next-in-order is first in the
    // list — `V3 Incoming` is batting-order[2]. Confirm the default so this
    // test still ends on a completed wicket rather than stalling on the new
    // step. A non-default pick is asserted in the opening-pair test below.
    await sheet.getByRole("button", { name: `V3 Incoming ${TAG}`, exact: true }).click();

    await expect
      .poll(
        async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 20_000 },
      )
      .toBe(6);

    const withWicket = (await ledger(page.request, fx.fixtureId)).find(
      (e) => e.type === "cricket.ball" && (e.payload as { wicket?: unknown }).wicket,
    )!;
    // The changed bowler, not the stale default, reached the actual
    // dispatched payload — the acceptance test's own core claim: a scorer
    // picks a person through the context strip, scores a ball, and that
    // ball carries the newly-chosen person, not whatever it started as.
    expect(withWicket.payload.bowler, "the CHANGED bowler, not the rejected default, must reach the payload").toBe(
      fielder,
    );
    const incomingBatter = fx.personIds[`V3 Incoming ${TAG}`]!;
    const wicket = withWicket.payload.wicket as {
      kind: string;
      out: string;
      fielder?: string;
      incoming?: string;
      bowlerCredited: boolean;
    };
    expect(wicket.kind).toBe("caught");
    expect(wicket.fielder, "credited to a REAL fielding-side member").toBe(bowler);
    expect(wicket.bowlerCredited, "caught is in BOWLER_CREDITED_KINDS").toBe(true);
    expect(wicket.incoming, "the incoming step must reach the payload, not fall back to an omitted auto").toBe(
      incomingBatter,
    );
    // Whoever was on strike when the catch was taken — rotates with odd
    // runs, so membership, not identity (same relaxation scorepad-v2.spec.ts's
    // own wicket assertion uses, and for the same reason).
    expect([striker, nonStriker]).toContain(wicket.out);
  },
);

test(
  "cricket v3: opening pair and opening bowler can be picked off the lineup before ball 1, and a wicket can name a non-next incoming batter",
  async ({ page }) => {
    test.setTimeout(150_000);
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket Openers ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [
        { fullName: `V3 OP One ${TAG}` },
        { fullName: `V3 OP Two ${TAG}` },
        { fullName: `V3 OP Three ${TAG}` },
        { fullName: `V3 OP Four ${TAG}` },
      ],
      away: [{ fullName: `V3 OP BowlA ${TAG}` }, { fullName: `V3 OP BowlB ${TAG}` }],
    });
    const one = fx.personIds[`V3 OP One ${TAG}`]!;
    const two = fx.personIds[`V3 OP Two ${TAG}`]!;
    const three = fx.personIds[`V3 OP Three ${TAG}`]!;
    const four = fx.personIds[`V3 OP Four ${TAG}`]!;
    const bowlA = fx.personIds[`V3 OP BowlA ${TAG}`]!;
    const bowlB = fx.personIds[`V3 OP BowlB ${TAG}`]!;

    await openLiveConsole(page, fx);

    const strip = pad(page).locator('[data-role="context-strip"]');
    await expect(strip, "the opening strip must exist before ball 1").toBeVisible({ timeout: 10_000 });
    await expect(strip.getByRole("button", { name: /^Striker(:|$)/ })).toBeVisible();
    await expect(strip.getByRole("button", { name: /^Non-striker(:|$)/ })).toBeVisible();
    await expect(strip.getByRole("button", { name: /^Bowler(:|$)/ })).toBeVisible();

    // Defaults are lineup[0]/[1] and first eligible bowler. Override all three.
    await setContextPerson(page, "Striker", `V3 OP Three ${TAG}`);
    await setContextPerson(page, "Non-striker", `V3 OP Four ${TAG}`);
    await setContextPerson(page, "Bowler", `V3 OP BowlB ${TAG}`);

    // Dot ball — an odd run would rotate strike, and Bowled then dismisses
    // the NEW striker rather than the named opener this test is pinning.
    await pad(page).getByRole("button", { name: "0", exact: true }).click();
    await expect
      .poll(
        async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 20_000 },
      )
      .toBe(1);
    const first = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "cricket.ball")!;
    expect(first.payload.striker, "named opener, not lineup[0]").toBe(three);
    expect(first.payload.nonStriker, "named opener, not lineup[1]").toBe(four);
    expect(first.payload.bowler, "named opening bowler, not bowlingOrder[0]").toBe(bowlB);
    expect(first.payload.striker).not.toBe(one);
    expect(first.payload.nonStriker).not.toBe(two);
    expect(first.payload.bowler).not.toBe(bowlA);

    // Mid-over the crease is locked — tapping Striker must not find a button.
    await expect(strip.getByRole("button", { name: /^Striker(:|$)/ })).toHaveCount(0);

    await pad(page).getByRole("button", { name: "Wicket", exact: true }).click();
    const sheet = pad(page).locator('[data-role="v3-sheet"]');
    await sheet.getByRole("button", { name: "Bowled", exact: true }).click();
    await expect(sheet.getByText("Who walks in?")).toBeVisible({ timeout: 10_000 });
    // Next-in-order would be One (index 0 leftover). Pick Two instead.
    await sheet.getByRole("button", { name: `V3 OP Two ${TAG}`, exact: true }).click();
    await expect
      .poll(
        async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 20_000 },
      )
      .toBe(2);
    const withWicket = (await ledger(page.request, fx.fixtureId)).find(
      (e) => e.type === "cricket.ball" && (e.payload as { wicket?: unknown }).wicket,
    )!;
    const wicket = withWicket.payload.wicket as { incoming?: string; out: string };
    expect(wicket.out).toBe(three);
    expect(wicket.incoming, "captain's choice, not auto next-in-order (One)").toBe(two);
    expect(wicket.incoming).not.toBe(one);

    // After the wicket the incoming batter has not faced — that crease end
    // reopens, the same window as a new-over bowler. The surviving partner
    // stays locked. Changing the incoming name here is what the owner
    // could not do: the bowler chip would open at an over boundary, the
    // bat chip would not.
    await expect(strip.getByRole("button", { name: /^Striker(:|$)/ })).toBeVisible();
    await expect(strip.getByRole("button", { name: /^Non-striker(:|$)/ })).toHaveCount(0);
    await setContextPerson(page, "Striker", `V3 OP One ${TAG}`);
    await pad(page).getByRole("button", { name: "0", exact: true }).click();
    await expect
      .poll(
        async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 20_000 },
      )
      .toBe(3);
    const afterSwap = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball")[2]!;
    expect(afterSwap.payload.striker, "the strip pick, not the sheet's incoming").toBe(one);
    expect(afterSwap.payload.nonStriker, "surviving partner stays").toBe(four);
    expect(afterSwap.payload.striker).not.toBe(two);
  },
);

test("cricket v3: undo INSIDE the soft-commit hold window drops silently, no core.void", async ({ page }) => {
  // openLiveConsole's own two 20s-ceiling waits plus the 5s dock checks and a
  // flat 7s post-hold wait land close to the 60s default under load —
  // scoring.spec.ts's comparable undo conversion sets the same 120_000.
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Cricket UndoHeld ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `V3 UH Striker ${TAG}` }, { fullName: `V3 UH NonStriker ${TAG}` }],
    away: [{ fullName: `V3 UH Bowler ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  // Plain runs submit immediately (no enrichment chips). Use a no-ball so the
  // dock opens and the tap stays HELD — that is the only path where Take back
  // can drop without a core.void.
  await pad(page).locator('[data-tile-id="extra-noball"]').click();
  const dock = pad(page).locator('[data-role="v3-dock"]');
  await expect(dock).toBeVisible({ timeout: 5_000 });

  // decideUndo (pad-host.tsx): `heldId === eventId` -> "drop", queue.ts's
  // `dropHeld` — the event is removed from the LOCAL queue, never sent, no
  // `core.void` (there is nothing on the server to void).
  await pad(page).locator('[data-role="v3-ribbon"]').getByRole("button", { name: "Take back", exact: true }).click();
  await expect(dock, "a dropped held tap clears `held` immediately, no network round trip needed").not.toBeVisible({
    timeout: 5_000,
  });

  // Positive proof, not merely "nothing happened yet": wait PAST queue.ts's
  // HOLD_MS — the one deadline this mechanism has — then confirm the ledger
  // never saw the tap at all. A plain `waitForTimeout` is usually the wrong
  // tool here (AGENTS.md), but proving an ABSENCE past a KNOWN deadline is
  // the one shape of claim a fixed wait is the right proof for: there is no
  // earlier real signal to poll for the negative case.
  //
  // DERIVED from HOLD_MS, never a literal. This wait was `7_000` against a
  // 6000ms window; when R6 took the window to 12000 the wait stopped passing
  // the deadline and the assertion went vacuous — still green, and green for
  // a reason that had nothing to do with the behaviour. A test that cannot
  // fail is worse than one that is missing, because it is counted.
  await page.waitForTimeout(HOLD_MS + 1_000);
  const rows = await ledger(page.request, fx.fixtureId);
  expect(rows.filter((e) => e.type === "cricket.ball")).toHaveLength(0);
  expect(rows.filter((e) => e.type === "core.void")).toHaveLength(0);
});

test("cricket v3: undo AFTER send voids through core.void", async ({ page }) => {
  // openLiveConsole's own two 20s-ceiling waits, the send-confirmation poll,
  // the dock-clear check, and the core.void poll are five chained 20s
  // ceilings against a 60s default — scoring.spec.ts's comparable undo
  // conversion sets the same 120_000.
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Cricket UndoSent ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `V3 US Striker ${TAG}` }, { fullName: `V3 US NonStriker ${TAG}` }],
    away: [{ fullName: `V3 US Bowler ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  await pad(page).getByRole("button", { name: "1", exact: true }).click();
  // Plain runs have no enrichment dock — they submit immediately. Once the
  // ball is on the ledger, Take back must void (decideUndo "void" branch),
  // never drop a held tap.
  await expect
    .poll(
      async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
      { timeout: 20_000 },
    )
    .toBe(1);
  await expect(pad(page).locator('[data-role="v3-dock"]')).not.toBeVisible({ timeout: 5_000 });

  await pad(page).locator('[data-role="v3-ribbon"]').getByRole("button", { name: "Take back", exact: true }).click();
  await expect
    .poll(
      async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "core.void").length,
      { timeout: 20_000 },
    )
    .toBe(1);

  const rows = await ledger(page.request, fx.fixtureId);
  const ball = rows.find((e) => e.type === "cricket.ball")!;
  const voided = rows.find((e) => e.type === "core.void")!;
  expect(voided.payload).toMatchObject({ event_id: ball.id });
});

test("cricket v3: the device link (/score/[token]) renders the v3 pad, not the legacy one", async ({
  page,
  browser,
}) => {
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Cricket DeviceLink ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `V3 DL Striker ${TAG}` }, { fullName: `V3 DL NonStriker ${TAG}` }],
    away: [{ fullName: `V3 DL Bowler ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  const minted = await apiJson<{ id: string; secret: string }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/device-links`,
    "POST",
    { label: `V3 Cricket link ${TAG}` },
  );
  expect(minted.status, `mint failed: ${JSON.stringify(minted.error)}`).toBe(201);

  // Explicit fresh, unauthenticated context — the device route's own
  // credential is the token, never the ambient session (same posture
  // scorepad-v2.spec.ts's own device-link test takes).
  const anonCtx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const dlPage = await anonCtx.newPage();
    await dlPage.goto(`/score/${minted.data!.secret}`);
    // Assert the SEED itself, not just its downstream effect: see
    // task-2-report.md, Step 7 — `expectNoCookieBanner` alone DID red under a
    // real mutant here (this file has no pre-existing reactive dismissal
    // before it runs), but it is still a race against hydration, not a
    // deterministic check. The consent keys are context state — read them
    // directly as a companion assertion that cannot race.
    const { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } = await import("../src/lib/consent");
    const seeded = await dlPage.evaluate(
      ([k, v]) => ({ choice: localStorage.getItem(k), version: localStorage.getItem(v) }),
      [CONSENT_KEY, CONSENT_VERSION_KEY],
    );
    expect(
      seeded,
      "the anonymous context did not carry seeded consent, so the banner will mount and race this spec",
    ).toEqual({ choice: "rejected", version: COOKIE_POLICY_VERSION });
    await expectNoCookieBanner(dlPage, "anonymous scorer context");
    // DeviceScorePad (app/score/[token]/page.tsx) has no
    // `data-testid="score-pad"` — that testid is minted only by
    // fixture-console.tsx, the CONSOLE route's own wrapper (gallery.capture.ts's
    // own header documents the same fact) — but it mounts the SAME
    // `<ScorePad/>` (registry.tsx), so cricket resolving to `V3_SKINS`
    // renders `PadHostV3`'s own `[data-role="pad-v3"]` root regardless of
    // which route got there.
    const v3Root = dlPage.locator('[data-role="pad-v3"]');
    await expect(v3Root).toBeVisible({ timeout: 20_000 });
    await expect(v3Root.locator('[data-role="v3-scorebug"]')).toBeVisible();
    await expect(v3Root.locator('[data-role="v3-tiles"]')).toBeVisible();

    const before = await ledger(page.request, fx.fixtureId);
    await v3Root.getByRole("button", { name: "1", exact: true }).click();
    await expect
      .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: 20_000 })
      .toBeGreaterThan(before.length);
  } finally {
    await anonCtx.close();
  }
});

// R2 sign-off review (2026-08-17). The three capabilities the cricket flip
// dropped and this wave restored. Each assertion below FAILS against the
// pre-fix pad, which is the whole point: the previous e2e passed with all
// three missing, because it only checked that the pad worked — never that it
// still did what the legacy pad did.
test("cricket v3: the activity panel lists every recorded ball, NOT just the latest", async ({ page }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Cricket Activity ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `V3 AC Striker ${TAG}` }, { fullName: `V3 AC NonStriker ${TAG}` }],
    away: [{ fullName: `V3 AC Bowler ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  // Three balls, so "shows only the latest" (the v3 ribbon's behaviour, and
  // the regression) is distinguishable from "shows the history".
  // One tap at a time, each confirmed onto the ledger before the next. Three
  // rapid taps race the ~6s soft-commit hold (a later tap flushes the held
  // one) and land only two balls — which is how the first version of this
  // test failed, intermittently, against working code.
  let expected = 0;
  for (const runs of ["1", "2", "0"]) {
    await pad(page).getByRole("button", { name: runs, exact: true }).click();
    expected += 1;
    await expect
      .poll(
        async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 30_000 },
      )
      .toBe(expected);
  }

  // PAGE-WIDE, not pad-scoped (R7/C1, gallery.capture.ts's `padEventRows` own
  // fix, same reasoning): C1 moved the ledger OUT of the pad root on the
  // console (`ScorePad`'s `hideActivity`, honoured by `v3-activity-slot`
  // never rendering there at all — the console's own `<ActivityPanel>` mounts
  // outside `data-testid="score-pad"` in fixture-console.tsx), so a
  // `pad(page)`-scoped locator resolves to zero here. `[data-role="v3-activity"]`
  // is the panel's own root (activity.tsx), rendered exactly once regardless
  // of which lane mounts it.
  const panel = page.locator('[data-role="v3-activity"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  // Every ball has a row — three, not one. A ribbon-only pad shows one.
  await expect
    .poll(async () => panel.locator('[data-role="v3-activity-row"]').count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(3);
  // And a void control for an event the scorer recorded themselves, which is
  // the correction path the device-link surface otherwise lost entirely.
  expect(await panel.locator('[data-role="v3-activity-void"]').count()).toBeGreaterThan(0);
});

test("cricket v3: voiding an OLDER event from the activity panel writes core.void for THAT event", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Cricket OldVoid ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `V3 OV Striker ${TAG}` }, { fullName: `V3 OV NonStriker ${TAG}` }],
    away: [{ fullName: `V3 OV Bowler ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  for (const runs of ["1", "2"]) {
    await pad(page).getByRole("button", { name: runs, exact: true }).click();
  }
  await expect
    .poll(
      async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
      { timeout: 30_000 },
    )
    .toBe(2);
  // Out of the hold window, so this is a real void rather than a drop.
  await expect(pad(page).locator('[data-role="v3-dock"]')).not.toBeVisible({ timeout: 20_000 });

  const ledgerRows = await ledger(page.request, fx.fixtureId);
  const balls = ledgerRows.filter((e) => e.type === "cricket.ball");
  const oldest = balls[0]!;

  // PAGE-WIDE — see the R7/C1 note on this file's first `v3-activity` panel
  // lookup above.
  const panel = page.locator('[data-role="v3-activity"]');
  // Target the oldest BALL by its own event id, never by position. The ledger
  // also carries structural events (core.start), so "the last row" is the
  // match start, not the oldest ball — and voiding the start is refused, which
  // is exactly how the first version of this test failed against working code.
  // Rows are newest-first and the ledger also carries structural events, so
  // the order is [newer ball, OLDER ball, core.start]. Index 1 is the older
  // ball — the one the ribbon's single undo can never reach.
  //
  // Deliberately NOT located by `data-event-id`: for events this client
  // submitted, the envelope id the panel renders is the client's own
  // idempotency key, which is not guaranteed to equal the id the ledger reads
  // back. Identity is asserted below on the ledger instead, which is where it
  // is meaningful — a locator that silently matches nothing would make this
  // test vacuous, and that is the failure mode this whole wave is about.
  const rows = panel.locator('[data-role="v3-activity-row"]');
  await expect.poll(async () => rows.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
  await rows.nth(1).locator('[data-role="v3-activity-void"]').click();

  await expect
    .poll(
      async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "core.void").length,
      { timeout: 20_000 },
    )
    .toBe(1);
  const voided = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "core.void")!;
  // The OLDEST ball, not the latest: this is the assertion that separates a
  // real per-event void from the ribbon's undo-the-last-thing.
  expect(voided.payload).toMatchObject({ event_id: oldest.id });
});

// RESTORED FROM THE DEMOLITION (R7/G review, 2026-09-01). The deleted
// `scorepad-v2.spec.ts` held a football test that scored, RELOADED THE PAGE,
// and then voided a row addressed by its real `data-event-id`. R7/G retired it
// as superseded by the two cricket void tests above — but neither of those
// reloads, and the OldVoid test immediately above deliberately addresses its
// row BY POSITION, for the reason its own comment gives: for an event this
// client submitted, the id the panel renders is the client's idempotency key,
// not the id the ledger reads back. So nothing in the suite covered
// [reload] × [per-row void addressed by the SERVER's event id].
//
// That combination is not a redundant pairing of two covered things. A reload
// is what makes `data-event-id` MEANINGFUL: the panel rebuilds every row from
// the server's `initialEvents` rather than from its own queue, so the rendered
// id is the ledger's id, and the void this test clicks is the first one in the
// suite whose target identity is proven end to end through the DOM rather than
// through an array index. `v3/activity.tsx` is shared by all eleven skins and
// was untouched by R7, so this guards a live seam for every sport.
//
// It also carries the deleted test's measured regression guard: that test
// recorded a pre-hydration click race, "one red in six runs of this file, on a
// warm server as well as a deliberately cold one". Hence the explicit wait for
// the void control to be ENABLED after reload, rather than clicking the moment
// the row paints.
test("cricket v3: after a RELOAD, a per-row void addressed by the panel's own data-event-id targets that exact ledger event", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Cricket ReloadVoid ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `V3 RV Striker ${TAG}` }, { fullName: `V3 RV NonStriker ${TAG}` }],
    away: [{ fullName: `V3 RV Bowler ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  // Two balls, so the target is unambiguously ONE of them and a void that
  // silently hit "the last thing" would name the wrong id.
  for (const runs of ["1", "2"]) {
    await pad(page).getByRole("button", { name: runs, exact: true }).click();
  }
  await expect
    .poll(
      async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
      { timeout: 30_000 },
    )
    .toBe(2);
  await expect(pad(page).locator('[data-role="v3-dock"]')).not.toBeVisible({ timeout: 20_000 });

  const balls = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball");
  const target = balls[0]!;

  // THE RELOAD. Everything after this point is served from `initialEvents`,
  // which is the whole point: the panel's `data-event-id` is now the ledger's
  // id, not a client key, so it can be addressed directly.
  await page.reload();
  // NOT `openLiveConsole` again — that helper clicks "Start match", and the
  // match is already running, so the click times out (120s) and the failure
  // reads as a locator problem rather than "this test asked for a control that
  // cannot be there". Found by CI, not locally: the first version of this test
  // was verified only by `--list`, i.e. that it COLLECTS. Collecting is not
  // running.
  await expect(pad(page)).toBeVisible({ timeout: 30_000 });

  const panel = page.locator('[data-role="v3-activity"]');
  const row = panel.locator(`[data-role="v3-activity-row"][data-event-id="${target.id}"]`);
  // A locator that matches NOTHING would make the click throw rather than pass
  // silently, but assert the count anyway: a vacuous e2e is this wave's
  // recurring failure, and "the server's id reached the DOM at all" is itself
  // the half of this test that the position-addressed version cannot state.
  await expect.poll(async () => row.count(), { timeout: 30_000 }).toBe(1);

  const voidControl = row.locator('[data-role="v3-activity-void"]');
  // The hydration race the deleted test measured: the row paints from the
  // server-rendered payload before React attaches its handler, so a click on a
  // merely-VISIBLE control is dropped. Wait for enabled, then click.
  await expect(voidControl).toBeEnabled({ timeout: 30_000 });
  await voidControl.click();

  await expect
    .poll(
      async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "core.void").length,
      { timeout: 30_000 },
    )
    .toBe(1);
  const voided = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "core.void")!;
  // The id the DOM carried, end to end. `target` is the OLDER ball, so this
  // also fails if the void degraded into the ribbon's undo-the-last-thing.
  expect(voided.payload).toMatchObject({ event_id: target.id });
  expect(target.id).not.toBe(balls[1]!.id);
});

// R2b (2026-08-17) — the over-by-over tile's own e2e coverage, deferred by
// that wave's plan (`docs/superpowers/plans/2026-08-17-scorepad-v3-r2b-
// cricket-over.md`, task 5) to this session. Task 3/4 already shipped the
// tile/sheet/gate + i18n (commits 8224ca04, 80a10f72, 9cd2b3f2, c70c0e90,
// b9692a52) — nothing below adds a src line. It exists because the wave's
// OWN unit tests assert spec BUILDERS only (apps/web vitest is
// `environment:"node"`, no jsdom, this file's own header) — nothing before
// this proved the tile renders, the sheet opens PREFILLED from the fold, the
// event actually reaches the ledger and the pad, or that R2b's mutually-
// exclusive gate (Q1 owner ruling, `_INDEX.md`) really REMOVES a tile rather
// than merely disabling one that still looks tappable.
test(
  "cricket v3: the over-by-over tile posts a partial summary, updates the pad and the ribbon with real " +
    "copy, APPENDS a second over's runs/wickets onto the fold, and hides the ball tiles once the innings is coarse",
  async ({ page }) => {
    // TWO real held dispatches now (queue.ts's HOLD_MS each) — the
    // second over was added when Q2 was reversed, because an append is
    // unprovable from a single entry against an empty fold. Plus
    // openLiveConsole's own two 20s-ceiling polls, two 20s ledger polls, and
    // a third (cancelled, no network) sheet open. The 120_000 that covered
    // the single-dispatch shape no longer has headroom for that.
    test.setTimeout(180_000);
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket OverTile ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 OT Striker ${TAG}` }, { fullName: `V3 OT NonStriker ${TAG}` }],
      away: [{ fullName: `V3 OT Bowler ${TAG}` }],
    });
    await openLiveConsole(page, fx);

    // Pre-innings (`unopened`): NEITHER lane has locked in yet, so the over
    // tile and the ball-derived tiles are BOTH legal and both visible (R2b
    // Q1 owner ruling) — the tile's own sublabel names the over an entry
    // would close: "1" while unopened, nothing recorded yet.
    const overTile = pad(page).locator('[data-tile-id="overSummary"]');
    await expect(overTile, "over tile must render before any ball is scored").toBeVisible({ timeout: 10_000 });
    await expect(overTile).toContainText("1");
    await expect(pad(page).locator('[data-tile-id="run0"]')).toBeVisible();
    await expect(pad(page).locator('[data-tile-id="wicket"]')).toBeVisible();

    // R8 (register row D2) — the MODE INDICATOR, unopened half. Both lanes
    // are still legal here, so nothing has locked in and the pad must not
    // claim otherwise. Pinned BEFORE the dispatch below so the "Over-by-over"
    // assertion further down is a real transition, not a chip that reads the
    // same in every state.
    const modeLine = pad(page).locator('[data-role="context-mode"]');
    await expect(modeLine, "no innings yet: neither lane has locked in, so there is no mode to state").toHaveCount(0);

    await overTile.click();
    const sheet = sheetRoot(page);
    await expect(sheet, "tapping the tile must open the guided sheet").toBeVisible({ timeout: 10_000 });

    // Step 1/3 — "Runs this over": a PER-OVER delta, so it always opens at 0
    // regardless of the fold (Q2 REVERSED by the owner 2026-08-17, `_INDEX.md`
    // — the scorer enters this over's runs and the pad appends). Asserting 0
    // here, against an empty fold, cannot tell "delta" from "total" — the
    // second over below is what actually proves the append.
    let field = sheet.getByRole("spinbutton", { name: "Runs this over" });
    await expect(field).toBeVisible({ timeout: 10_000 });
    await expect(field).toHaveValue("0");
    await field.fill("8");
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();

    // Step 2/3 — "Wickets this over": 0, left unedited.
    field = sheet.getByRole("spinbutton", { name: "Wickets this over" });
    await expect(field).toBeVisible({ timeout: 10_000 });
    await expect(field).toHaveValue("0");
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();

    // Step 3/3 — "Balls this over": prefilled to ONE full over (t20's own
    // 6-ball bpo, never a hardcoded 6 — the Hundred's is 5), because a
    // completed over is exactly `bpo` LEGAL deliveries however many extras
    // were bowled alongside it. Left unedited; confirming closes the wizard
    // and dispatches.
    field = sheet.getByRole("spinbutton", { name: "Balls this over" });
    await expect(field).toBeVisible({ timeout: 10_000 });
    await expect(field).toHaveValue("6");
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(sheet, "the wizard's own last step closes the sheet").not.toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () =>
          (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.innings.summary").length,
        { timeout: 20_000 },
      )
      .toBe(1);
    const summary = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "cricket.innings.summary")!;
    // The EVENT still carries absolute totals — `cricket.innings.summary`
    // REPLACES the innings totals (cricket.ts:1445-1451), it was never
    // additive at the schema level. From an empty fold the delta and the
    // total coincide (0 + 8 = 8), which is exactly why this assertion alone
    // is not proof of the append; the second over below supplies that.
    expect(summary.payload).toMatchObject({ runs: 8, wickets: 0, legalBalls: 6, partial: true });

    // The pad reflects the posted totals, not a stale 0/0 — "the pad
    // reflects the new totals" from this wave's own acceptance list.
    const scorebug = pad(page).locator('[data-role="v3-scorebug"]');
    await expect(scorebug).toContainText("8/0");
    await expect(scorebug).toContainText("1.0");

    // Real per-sport ribbon copy ("Over recorded",
    // pad.cricket.ribbon.innings.summary) — never the generic
    // `pad.ribbon.fallback` ("{event} recorded") a missing PAD_LABEL_KEYS
    // entry would silently fall back to. The absence check is what actually
    // separates a real hit from the fallback: "Over recorded" and
    // "cricket.innings.summary recorded" both satisfy a bare
    // toContainText("recorded").
    const ribbon = pad(page).locator('[data-role="v3-ribbon"]');
    await expect(ribbon).toContainText("Over recorded");
    await expect(ribbon, "must never silently fall back to the raw event type").not.toContainText(
      "cricket.innings.summary",
    );

    // THE GATE (coarse half) — this innings' first event was a summary, so
    // it is now COARSE. The fold refuses a ball on a coarse innings
    // (cricket.ts:1128-1131) — the chassis must not offer one, not merely
    // disable it (R2b Q1 owner ruling).
    await expect(
      pad(page).locator('[data-tile-id="run0"]'),
      "coarse innings: ball tiles must be GONE, not disabled",
    ).not.toBeVisible();
    await expect(
      pad(page).locator('[data-tile-id="wicket"]'),
      "coarse innings: wicket tile must be GONE, not disabled",
    ).not.toBeVisible();
    // R8 (register row D2) — the MODE INDICATOR, coarse half. Until this wave
    // the ONLY on-screen expression of the lock above was the two assertions
    // right before this one: the ball tiles silently vanishing. A scorer who
    // did not already know the rule could not learn it from the pad. Now the
    // strip says so in words, read off the fold's own `inningsFidelity` — and
    // the same chip read nothing at all a few lines above, before this
    // summary locked the innings.
    await expect(modeLine, "a coarse innings must say so").toHaveCount(1);
    await expect(modeLine).toHaveText("This innings: Over-by-over");
    await expect(
      pad(page).locator('[data-role="context-slot-message"][data-slot-id="mode"]'),
      "and explains that the lock happened when the innings began",
    ).toContainText("over summary");

    // The over tile survives — coarse stays eligible for the next partial —
    // and its sublabel now names over 2.
    await expect(overTile).toBeVisible();
    await expect(overTile).toContainText("2");

    // SECOND OVER, from a NON-ZERO fold — the only assertion in this file
    // that can tell append from replace. The fold now reads 8/0 off 6; the
    // scorer enters this over's 5 runs and 1 wicket, so the pad must emit
    // 13/1 off 12. If `buildPayload` ever dropped its `+ delta` and sent the
    // raw answers (5/1 off 6), that is a DECREASE and the engine's monotone
    // guard (cricket.ts:1416-1426) would reject it — but if it dropped the
    // ANSWER instead and re-sent the base, the ledger would silently stall at
    // 8/0 with nothing failing. Both directions are covered by pinning the
    // exact sum below.
    await overTile.click();
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    field = sheet.getByRole("spinbutton", { name: "Runs this over" });
    await expect(field, "a per-over delta reopens at 0 — never carrying the fold's 8 forward").toHaveValue("0");
    await field.fill("5");
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();

    field = sheet.getByRole("spinbutton", { name: "Wickets this over" });
    await expect(field).toHaveValue("0");
    await field.fill("1");
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();

    field = sheet.getByRole("spinbutton", { name: "Balls this over" });
    await expect(field).toHaveValue("6");
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(sheet).not.toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () =>
          (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.innings.summary").length,
        { timeout: 20_000 },
      )
      .toBe(2);
    const second = (await ledger(page.request, fx.fixtureId))
      .filter((e) => e.type === "cricket.innings.summary")
      .at(-1)!;
    expect(second.payload, "8+5 runs, 0+1 wickets, 6+6 balls — the SUM, not the delta and not the base").toMatchObject(
      { runs: 13, wickets: 1, legalBalls: 12, partial: true },
    );
    await expect(pad(page).locator('[data-role="v3-scorebug"]')).toContainText("13/1");

    // Cancel must not dispatch — the ledger's own summary count stays at 2.
    await overTile.click();
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sheet).not.toBeVisible({ timeout: 10_000 });
    const afterCancel = await ledger(page.request, fx.fixtureId);
    expect(afterCancel.filter((e) => e.type === "cricket.innings.summary")).toHaveLength(2);
  },
);

test(
  "cricket v3: a ball recorded first locks the innings to ball-by-ball and hides the over-by-over tile",
  async ({ page }) => {
    // openLiveConsole's own two 20s-ceiling polls plus one held ball
    // dispatch — the same shape the two Undo conversions elsewhere in this
    // file budget 120_000 for.
    test.setTimeout(120_000);
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket OverGateFine ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 OGF Striker ${TAG}` }, { fullName: `V3 OGF NonStriker ${TAG}` }],
      away: [{ fullName: `V3 OGF Bowler ${TAG}` }],
    });
    await openLiveConsole(page, fx);

    // Both lanes are legal before any ball — the mirror starting point of
    // the coarse-lane test above.
    const overTile = pad(page).locator('[data-tile-id="overSummary"]');
    await expect(overTile).toBeVisible({ timeout: 10_000 });

    await pad(page).locator('[data-tile-id="run0"]').click();
    await expect
      .poll(
        async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 20_000 },
      )
      .toBe(1);

    // THE GATE (fine half — the mirror of the coarse assertion above): this
    // innings' first event was a ball, so it is now FINE. The fold refuses a
    // summary on a fine innings (cricket.ts:1402-1404) — the tile must be
    // GONE, not disabled, exactly like the coarse direction.
    await expect(overTile, "fine innings: over tile must be GONE, not disabled").not.toBeVisible({
      timeout: 10_000,
    });
    // The ball tiles are still there — confirms this is the OTHER lane
    // winning, not the pad losing its tiles generally.
    await expect(pad(page).locator('[data-tile-id="run1"]')).toBeVisible();
    await expect(pad(page).locator('[data-tile-id="wicket"]')).toBeVisible();
  },
);

test(
  "cricket v3: a no-ball's dock offers bat-run chips that preserve the noball extra; a wide's dock offers none",
  async ({ page }) => {
    // Two dispatches, both flushed via "Send now" rather than the 6s hold —
    // openLiveConsole's own two 20s-ceiling polls plus two fast confirms.
    test.setTimeout(90_000);
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket DockChips ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 DC Striker ${TAG}` }, { fullName: `V3 DC NonStriker ${TAG}` }],
      away: [{ fullName: `V3 DC Bowler ${TAG}` }],
    });
    await openLiveConsole(page, fx);

    // buildDock (skins/cricket.tsx): a no-ball's dock offers BAT_RUN_VALUES
    // chips (a no-ball is batted normally) — tap "extra-noball", then the
    // "+3" chip (label `pad.cricket.dock.batRun3`, en copy "3 runs") INSIDE
    // the hold window. Wait for the chip's own `aria-pressed` before
    // flushing: `tapChip` is async (it awaits `store.mutateHeld`), so
    // sending immediately after the click risks flushing the UNMUTATED
    // payload if the mutation hasn't landed in the local queue yet.
    await pad(page).locator('[data-tile-id="extra-noball"]').click();
    const dock = pad(page).locator('[data-role="v3-dock"]');
    await expect(dock).toBeVisible({ timeout: 5_000 });
    const chip3 = dock.getByRole("button", { name: "3 runs", exact: true });
    await chip3.click();
    await expect(chip3, "tapChip must resolve before Send now, or the flush races the mutation").toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await sendHeldNow(page);
    await expect
      .poll(
        async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 20_000 },
      )
      .toBe(1);
    const noball = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "cricket.ball")!;
    // The no-ball's own 1-run extra survives the chip's mutation verbatim
    // (batRunChip preserves `extras`, only ever touching `bat`).
    expect(noball.payload.runs).toEqual({ bat: 3, extras: { kind: "noball", runs: 1 } });

    // A wide is ALSO an extra, but the engine refuses bat runs off one
    // (cricket.ts:1229) — buildDock returns null, so the tap submits with no
    // hold (owner ruling 2026-09-13: nothing to enrich → immediate).
    await pad(page).locator('[data-tile-id="wide"]').click();
    await expect(dock).not.toBeVisible({ timeout: 5_000 });
    await expect
      .poll(
        async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 20_000 },
      )
      .toBe(2);
  },
);

test(
  "cricket v3: a free hit is indicated after a no-ball, survives a wide, and clears on the next legal ball",
  async ({ page }) => {
    // Three dispatches, each flushed via "Send now" — comfortably under the
    // 120_000 budget the single-real-hold tests elsewhere in this file need.
    test.setTimeout(120_000);
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket FreeHit ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 FH Striker ${TAG}` }, { fullName: `V3 FH NonStriker ${TAG}` }],
      away: [{ fullName: `V3 FH Bowler ${TAG}` }],
    });
    await openLiveConsole(page, fx);

    const freeHit = pad(page).locator('[data-strip-item-id="freeHit"]');
    const dock = pad(page).locator('[data-role="v3-dock"]');
    const ballCount = async () =>
      (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length;

    await pad(page).locator('[data-tile-id="extra-noball"]').click();
    await expect(dock).toBeVisible({ timeout: 5_000 });
    await sendHeldNow(page);
    await expect.poll(ballCount, { timeout: 20_000 }).toBe(1);
    await expect(freeHit, "a white-ball no-ball must arm the indicator").toBeVisible({ timeout: 10_000 });

    // THE case this test exists for: a wide is an extra but not a LEGAL
    // delivery (freeHitPending's own doc mirrors cricket.ts's finishDelivery
    // verbatim) — it must carry the flag forward, not consume it. Skipping
    // straight to a legal ball here could not tell this from "any next ball
    // clears it".
    await pad(page).locator('[data-tile-id="wide"]').click();
    await expect(dock).not.toBeVisible({ timeout: 5_000 });
    await expect.poll(ballCount, { timeout: 20_000 }).toBe(2);
    await expect(freeHit, "a wide must NOT clear a pending free hit").toBeVisible({ timeout: 10_000 });

    await pad(page).locator('[data-tile-id="run0"]').click();
    await expect(dock).not.toBeVisible({ timeout: 5_000 });
    await expect.poll(ballCount, { timeout: 20_000 }).toBe(3);
    await expect(freeHit, "the next LEGAL delivery must consume it").not.toBeVisible({ timeout: 10_000 });
  },
);

test(
  "cricket v3: the activity log names the bowler by real name when the bowler changes at an over boundary",
  async ({ page }) => {
    // Setup (over 1: six dot balls) goes through the API, not the pad — the
    // ONLY thing under test is the over-2 bowler change and its own activity
    // row, so openLiveConsole's own "Start match" click is skipped entirely
    // (openConsoleAlreadyLive) and this budgets like a single-dispatch test.
    test.setTimeout(60_000);
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket ActivityName ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 AN Striker ${TAG}` }, { fullName: `V3 AN NonStriker ${TAG}` }],
      away: [{ fullName: `V3 AN BowlerA ${TAG}` }, { fullName: `V3 AN BowlerB ${TAG}` }],
      emitCoreStart: true,
    });
    const striker = fx.personIds[`V3 AN Striker ${TAG}`]!;
    const nonStriker = fx.personIds[`V3 AN NonStriker ${TAG}`]!;
    const bowlerA = fx.personIds[`V3 AN BowlerA ${TAG}`]!;

    for (let ball = 1; ball <= 6; ball++) {
      await postEvent(page.request, fx.fixtureId, "cricket.ball", {
        over: 0,
        ballInOver: ball,
        striker,
        nonStriker,
        bowler: bowlerA,
        runs: { bat: 0 },
      });
    }
    await openConsoleAlreadyLive(page, fx);

    // Over 2's boundary — the ONE genuinely editable context slot (this
    // file's own `setContextPerson` doc) — pick the OTHER eligible bowler.
    await setContextPerson(page, "Bowler", `V3 AN BowlerB ${TAG}`);
    await pad(page).locator('[data-tile-id="run0"]').click();
    await expect(pad(page).locator('[data-role="v3-dock"]')).not.toBeVisible({ timeout: 5_000 });
    await expect
      .poll(
        async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 20_000 },
      )
      .toBe(7);

    // PAGE-WIDE — see the R7/C1 note on this file's first `v3-activity` panel
    // lookup above.
    const panel = page.locator('[data-role="v3-activity"]');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const rows = panel.locator('[data-role="v3-activity-row"]');
    await expect.poll(async () => rows.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(7);
    // Rows are newest-first (established elsewhere in this file) — row 0 is
    // the just-scored ball 7, the one carrying the bowler-changed note.
    const latestRowText = (await rows.nth(0).innerText()).trim();
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(latestRowText, "must name the bowler, not fall back to a raw id").toContain(`V3 AN BowlerB ${TAG}`);
    expect(latestRowText, "must never leak a raw person id into the activity log").not.toMatch(uuidPattern);
  },
);

test(
  "cricket v3: an ineligible bowler override blocks delivery tiles with a named reason, and clears once an eligible one is picked",
  async ({ page }) => {
    // No dispatch at all — a context-strip override is host-held local
    // state (PadHostView.contextOverrides), never a server round trip, so
    // this only pays for setup (six API dot balls + one page load) and two
    // instant picker taps.
    test.setTimeout(45_000);
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket BowlerBlock ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 BB Striker ${TAG}` }, { fullName: `V3 BB NonStriker ${TAG}` }],
      away: [{ fullName: `V3 BB BowlerA ${TAG}` }, { fullName: `V3 BB BowlerB ${TAG}` }],
      emitCoreStart: true,
    });
    const striker = fx.personIds[`V3 BB Striker ${TAG}`]!;
    const nonStriker = fx.personIds[`V3 BB NonStriker ${TAG}`]!;
    const bowlerA = fx.personIds[`V3 BB BowlerA ${TAG}`]!;

    for (let ball = 1; ball <= 6; ball++) {
      await postEvent(page.request, fx.fixtureId, "cricket.ball", {
        over: 0,
        ballInOver: ball,
        striker,
        nonStriker,
        bowler: bowlerA,
        runs: { bat: 0 },
      });
    }
    await openConsoleAlreadyLive(page, fx);

    // Over 2's boundary. R2c (C1) changed what this picker even OFFERS, so
    // this is now the primary assertion rather than a documented gap: the
    // list is the FIELDING side only, and BowlerA — who just bowled over 1 —
    // is still SHOWN, but refused in place with the reason naming him. That
    // is R2b's "visible, blocked, and REASONED — not removed" ruling applied
    // to a candidate list. Before C1 he was an ordinary tappable button and
    // the block was only caught after the tap, on the tiles.
    const strip = await openContextPicker(page, "Bowler");

    const blockedCandidate = strip.locator(`[data-candidate-id="${bowlerA}"]`);
    await expect(blockedCandidate).toBeVisible({ timeout: 10_000 });
    await expect(blockedCandidate, "the previous over's bowler must be marked blocked").toHaveAttribute(
      "data-blocked",
      "true",
    );
    await expect(blockedCandidate, "blocked must mean genuinely unclickable, not merely dimmed").toBeDisabled();
    await expect(
      blockedCandidate,
      "the blocked chip still shows WHO it is — the name is its own label",
    ).toContainText(`V3 BB BowlerA ${TAG}`);
    await expect(
      blockedCandidate,
      "and the reason is visible text beside it — never a title/tooltip, invisible on touch",
    ).toContainText("Bowled the last over");

    // SCOPE: no batting-side player is offered at all. Before C1 the picker
    // drew from combinedPool(squads) and listed both squads, so a scorer
    // could pick a batter as bowler and be refused by the server.
    await expect(
      strip.locator(`[data-candidate-id="${striker}"]`),
      "a batting-side player must not be offered as a bowler at all",
    ).toHaveCount(0);
    await expect(strip.locator(`[data-candidate-id="${nonStriker}"]`)).toHaveCount(0);

    // The genuinely eligible bowler is offered normally, and picking him
    // leaves every delivery tile tappable.
    const eligible = strip.locator(`[data-candidate-id="${fx.personIds[`V3 BB BowlerB ${TAG}`]!}"]`);
    await expect(eligible).not.toHaveAttribute("data-blocked", "true");
    await eligible.click();
    for (const tileId of ["run0", "run1", "wicket"]) {
      const tile = pad(page).locator(`[data-tile-id="${tileId}"]`);
      await expect(tile, `${tileId} must carry data-tile-disabled="false" once eligible`).toHaveAttribute(
        "data-tile-disabled",
        "false",
      );
      await expect(tile).toBeEnabled();
    }
    // The slot-level message is the TILE explanation (ContextSlot.message,
    // R2b) — distinct from the per-candidate reasons asserted above, and it
    // must be absent entirely once an eligible bowler is in the slot.
    await expect(
      pad(page).locator('[data-role="context-strip"] [data-role="context-slot-message"][data-slot-id="bowler"]'),
      "the block message must clear once the bowler is eligible",
    ).not.toBeVisible({ timeout: 10_000 });
  },
);

test(
  "cricket v3: a genuinely terminal tie (no super over) decides the match outright — the pad keeps only its POST phase, superOver's own live state is the contrast",
  async ({ page }) => {
    // Entirely API-driven setup (a config flip + five events), then a page
    // load — no held dispatch at all.
    //
    // R3.5 Task C — this test used to force `superOver: true` to reach this
    // fixture, and asserted the pad's tiles were PRESENT-but-disabled. That
    // was never actually testing "a terminal closed innings": for a default
    // inningsPerSide:1 cfg, `dueBattingSide` returning null and the engine
    // deciding the match outright (decideAfterClose -> decideWin/decideTie,
    // phase "done") are the SAME transition — the only way to keep the pad
    // LOOKING live while nothing further was due was `cfg.superOver`, whose
    // whole point is that the match is NOT actually over yet. So the old
    // fixture WAS a live super over in disguise, and asserting "disabled,
    // with a closure message" against it was asserting the bug this task
    // fixes.
    //
    // Genuinely terminal (superOver: false) reaches fixture status
    // "decided" — confirmed empirically against this build: the v3 score
    // pad (`data-testid="score-pad"`) does not mount AT ALL once a fixture
    // is decided (gallery.capture.ts's own comment: "score-pad section is
    // gated on !decided") — the route renders a decided-match summary
    // instead. So there is no "tiles disabled" state to observe here; the
    // whole scoring surface is gone, by a mechanism this task does not
    // touch. The super-over case right below is the actual contrast this
    // task exists to prove: tied AND superOver:true keeps status "live" and
    // the SAME pad mounted, fully enabled.
    test.setTimeout(60_000);
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket ClosedGate ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 CG Home1 ${TAG}` }, { fullName: `V3 CG Home2 ${TAG}` }],
      away: [{ fullName: `V3 CG Away1 ${TAG}` }, { fullName: `V3 CG Away2 ${TAG}` }],
    });
    const home1 = fx.personIds[`V3 CG Home1 ${TAG}`]!;
    const home2 = fx.personIds[`V3 CG Home2 ${TAG}`]!;
    const away1 = fx.personIds[`V3 CG Away1 ${TAG}`]!;
    const away2 = fx.personIds[`V3 CG Away2 ${TAG}`]!;

    const div = await apiJson<{ config: Record<string, unknown> }>(
      page.request,
      `/api/v1/divisions/${fx.divisionId}`,
    );
    expect(div.status, `GET division -> ${div.status}`).toBe(200);
    await setDivisionConfigSql(fx.divisionId, { ...div.data!.config, superOver: false });

    await postEvent(page.request, fx.fixtureId, "core.start", {});
    // Innings 1 (home): a single ball, then a manual close — home totals 1.
    await postEvent(page.request, fx.fixtureId, "cricket.ball", {
      over: 0,
      ballInOver: 1,
      striker: home1,
      nonStriker: home2,
      bowler: away1,
      runs: { bat: 1 },
    });
    await postEvent(page.request, fx.fixtureId, "cricket.innings.close", { reason: "other" });
    // Innings 2 (away): target is home.runs + 1 = 2 — away scores EXACTLY
    // target - 1 (a single ball, bat:1), tying the match. Without a super
    // over this TIE is the match's own final result (phase "done"), not an
    // innings break.
    await postEvent(page.request, fx.fixtureId, "cricket.ball", {
      over: 0,
      ballInOver: 1,
      striker: away1,
      nonStriker: away2,
      bowler: home1,
      runs: { bat: 1 },
    });
    await postEvent(page.request, fx.fixtureId, "cricket.innings.close", { reason: "other" });

    const decided = await apiJson<{ status: string }>(page.request, `/api/v1/fixtures/${fx.fixtureId}`);
    expect(decided.status, `GET fixture -> ${decided.status}`).toBe(200);
    expect(decided.data!.status, "a tie without a super over is genuinely terminal").toBe("decided");

    await page.goto(await fixturePath(page.request, fx.fixtureId));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
    // OWNER RULING 17 (2026-09-06) SUPERSEDES THE ORIGINAL ASSERTION HERE.
    // This used to require `pad(page)` count 0 — "the pad itself never mounts
    // on a decided fixture". The ruling is that a decided fixture KEEPS the
    // pad's post-phase panel when the sport module declares post-phase
    // actions, so band-2 player lines can still be entered after the result;
    // `shouldMountPad` (`fixture-console.tsx`) mounts when not decided, OR
    // when `padSpec.panels` carries a `phase: "post"` panel. Cricket declares
    // one, so the pad stays.
    //
    // The same stale assertion was already corrected once, in
    // `scorepad-v3-deciders-fullmatch.spec.ts`; THIS copy survived because it
    // lives in the `parallel` project, which no local gate runs, and e2e only
    // fires on pushes to main. CI caught it on the first dispatch.
    //
    // Pinned to what the ruling REQUIRES, in both halves — not flipped 0 -> 1
    // to go green. A bare count of 1 would pass just as happily if a decided
    // fixture kept its full live scoring surface, which is the defect actually
    // worth fearing.
    await expect(pad(page), "ruling 17: cricket declares a post-phase panel, so the pad stays").toHaveCount(1);
    await expect(
      pad(page).locator('[data-tile-id="run1"]'),
      "a decided fixture is still offering live scoring tiles — the pad mounted, but not in its post phase",
    ).toHaveCount(0);
  },
);

test(
  "cricket v3: a super-over decision names the winner and the method, on the public page (R3.5/Task G, C23)",
  async ({ page }) => {
    test.setTimeout(60_000);
    // Same tie-reaching recipe as the "genuinely terminal tie" test above,
    // with superOver:true instead of false — the fork in behaviour Task C
    // exists to prove — continued PAST the tie into an actual decision.
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket SODecided ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 SOD Home1 ${TAG}` }, { fullName: `V3 SOD Home2 ${TAG}` }],
      away: [{ fullName: `V3 SOD Away1 ${TAG}` }, { fullName: `V3 SOD Away2 ${TAG}` }],
    });
    const home1 = fx.personIds[`V3 SOD Home1 ${TAG}`]!;
    const home2 = fx.personIds[`V3 SOD Home2 ${TAG}`]!;
    const away1 = fx.personIds[`V3 SOD Away1 ${TAG}`]!;
    const away2 = fx.personIds[`V3 SOD Away2 ${TAG}`]!;

    const div = await apiJson<{ config: Record<string, unknown> }>(
      page.request,
      `/api/v1/divisions/${fx.divisionId}`,
    );
    expect(div.status, `GET division -> ${div.status}`).toBe(200);
    await setDivisionConfigSql(fx.divisionId, { ...div.data!.config, superOver: true });

    await postEvent(page.request, fx.fixtureId, "core.start", {});
    // Innings 1 (home): one ball, then a manual close — home totals 1.
    await postEvent(page.request, fx.fixtureId, "cricket.ball", {
      over: 0,
      ballInOver: 1,
      striker: home1,
      nonStriker: home2,
      bowler: away1,
      runs: { bat: 1 },
    });
    await postEvent(page.request, fx.fixtureId, "cricket.innings.close", { reason: "other" });
    // Innings 2 (away): target is home.runs + 1 = 2 — away scores EXACTLY
    // target - 1, tying the match. With superOver:true this opens the super
    // over instead of ending the fixture outright.
    await postEvent(page.request, fx.fixtureId, "cricket.ball", {
      over: 0,
      ballInOver: 1,
      striker: away1,
      nonStriker: away2,
      bowler: home1,
      runs: { bat: 1 },
    });
    await postEvent(page.request, fx.fixtureId, "cricket.innings.close", { reason: "other" });

    const tied = await apiJson<{ status: string }>(page.request, `/api/v1/fixtures/${fx.fixtureId}`);
    expect(tied.status, `GET fixture -> ${tied.status}`).toBe(200);
    expect(tied.data!.status, "a tie WITH a super over stays live, not decided").toBe("in_play");

    // Super over, innings 1: away bats (they batted second in the main
    // innings), home bowls with a bowler who did NOT bowl the main innings'
    // second over. Six dot balls closes it on the over — no wicket needed,
    // so no third batter has to exist. Away totals 0.
    for (let ball = 1; ball <= 6; ball++) {
      await postEvent(page.request, fx.fixtureId, "cricket.superover.ball", {
        over: 0,
        ballInOver: ball,
        striker: away1,
        nonStriker: away2,
        bowler: home2,
        runs: { bat: 0 },
      });
    }
    // Super over, innings 2: home bats, away bowls with a fresh bowler.
    // Target is SO1's runs + 1 = 1 — the very first ball reaches it, deciding
    // the match by super over on the spot (applySuperOverBall's own close
    // condition: `target !== null && updated.runs >= target`).
    await postEvent(page.request, fx.fixtureId, "cricket.superover.ball", {
      over: 0,
      ballInOver: 1,
      striker: home1,
      nonStriker: home2,
      bowler: away2,
      runs: { bat: 1 },
    });

    const decided = await apiJson<{
      status: string;
      outcome: { kind: string; winner: string; method?: string };
    }>(page.request, `/api/v1/fixtures/${fx.fixtureId}`);
    expect(decided.status, `GET fixture -> ${decided.status}`).toBe(200);
    expect(decided.data!.status).toBe("decided");
    expect(decided.data!.outcome).toMatchObject({
      kind: "win",
      winner: fx.homeEntrantId,
      method: "super_over",
    });

    const org = await activeOrg(page);
    const comp = await apiJson<{ slug: string }>(page.request, `/api/v1/competitions/${fx.competitionId}`);
    const division = await apiJson<{ slug: string }>(page.request, `/api/v1/divisions/${fx.divisionId}`);
    const publicPath = `/shared/${org.slug}/${comp.data!.slug}/${division.data!.slug}/fixtures/${fx.fixtureId}`;
    await page.goto(publicPath);
    // The winner is named AND the method — never the raw "super_over" token.
    await expect(page.getByText(/won on the super over/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("super_over")).toHaveCount(0);
  },
);

test(
  "cricket v3: a LIVE super over enables every delivery tile, drops the closure message, and the scorebug follows the super over's own score",
  async ({ page }) => {
    // Same tie as the test above, but with `superOver: true` — the case this
    // whole task exists to fix. Before Task C, `currentInnings` read
    // `state.innings` alone, so the pad answered every one of these
    // questions off the two CLOSED main innings: fifteen delivery tiles
    // disabled, "This innings is closed." printed over a live decider, and
    // the scorebug frozen on away's closed 1/0 forever. This test drives one
    // super-over ball past the tie and asserts the opposite of all three.
    test.setTimeout(60_000);
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket SuperOverLive ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 SOL Home1 ${TAG}` }, { fullName: `V3 SOL Home2 ${TAG}` }],
      away: [{ fullName: `V3 SOL Away1 ${TAG}` }, { fullName: `V3 SOL Away2 ${TAG}` }],
    });
    const home1 = fx.personIds[`V3 SOL Home1 ${TAG}`]!;
    const home2 = fx.personIds[`V3 SOL Home2 ${TAG}`]!;
    const away1 = fx.personIds[`V3 SOL Away1 ${TAG}`]!;
    const away2 = fx.personIds[`V3 SOL Away2 ${TAG}`]!;

    const div = await apiJson<{ config: Record<string, unknown> }>(
      page.request,
      `/api/v1/divisions/${fx.divisionId}`,
    );
    expect(div.status, `GET division -> ${div.status}`).toBe(200);
    await setDivisionConfigSql(fx.divisionId, { ...div.data!.config, superOver: true });

    await postEvent(page.request, fx.fixtureId, "core.start", {});
    await postEvent(page.request, fx.fixtureId, "cricket.ball", {
      over: 0,
      ballInOver: 1,
      striker: home1,
      nonStriker: home2,
      bowler: away1,
      runs: { bat: 1 },
    });
    await postEvent(page.request, fx.fixtureId, "cricket.innings.close", { reason: "other" });
    await postEvent(page.request, fx.fixtureId, "cricket.ball", {
      over: 0,
      ballInOver: 1,
      striker: away1,
      nonStriker: away2,
      bowler: home1,
      runs: { bat: 1 },
    });
    await postEvent(page.request, fx.fixtureId, "cricket.innings.close", { reason: "other" });
    // Tied 1-1; superOver:true sends the fold to phase "super_over". Away
    // batted second in the match, so — per the ICC rule the engine's own
    // `soBattingSideAt` encodes — away bats FIRST in the super over. One
    // ball, a boundary, bowled by home1 again: a super-over innings starts
    // with a fresh ledger, so no consecutive-over restriction carries over
    // from the main innings.
    await postEvent(page.request, fx.fixtureId, "cricket.superover.ball", {
      over: 0,
      ballInOver: 1,
      striker: away1,
      nonStriker: away2,
      bowler: home1,
      runs: { bat: 4 },
      boundary: 4,
    });

    await openConsoleAlreadyLive(page, fx);

    for (const tileId of ["run0", "run1", "wicket"]) {
      const tile = pad(page).locator(`[data-tile-id="${tileId}"]`);
      await expect(tile, `${tileId} must carry data-tile-disabled="false" during a live super over`).toHaveAttribute(
        "data-tile-disabled",
        "false",
      );
      await expect(tile).toBeEnabled();
    }
    const closureMessage = pad(page).locator(
      '[data-role="context-strip"] [data-role="context-slot-message"][data-slot-id="bowler"]',
    );
    await expect(closureMessage).not.toBeVisible();

    // The scorebug follows the super over's own 4/0 — never away's closed
    // main-innings 1/0, which is what the pre-fix pad showed forever.
    await expect(pad(page).locator('[data-role="v3-scorebug"]')).toContainText("4/0");
    await expect(pad(page).locator('[data-role="v3-scorebug"]')).not.toContainText("1/0");
  },
);

test(
  "cricket v3: tapping a delivery tile on a due innings opens the next one with the other side batting",
  async ({ page }) => {
    // One held dispatch (the tap under test), flushed via "Send now" — the
    // rest of the setup (innings 1's single ball + its close) is API-driven.
    test.setTimeout(60_000);
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket InningsTransition ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 IT Home1 ${TAG}` }, { fullName: `V3 IT Home2 ${TAG}` }],
      away: [{ fullName: `V3 IT Away1 ${TAG}` }, { fullName: `V3 IT Away2 ${TAG}` }],
      emitCoreStart: true,
    });
    const home1 = fx.personIds[`V3 IT Home1 ${TAG}`]!;
    const home2 = fx.personIds[`V3 IT Home2 ${TAG}`]!;
    const away1 = fx.personIds[`V3 IT Away1 ${TAG}`]!;
    const away2 = fx.personIds[`V3 IT Away2 ${TAG}`]!;

    await postEvent(page.request, fx.fixtureId, "cricket.ball", {
      over: 0,
      ballInOver: 1,
      striker: home1,
      nonStriker: home2,
      bowler: away1,
      runs: { bat: 1 },
    });
    await postEvent(page.request, fx.fixtureId, "cricket.innings.close", { reason: "other" });

    await openConsoleAlreadyLive(page, fx);
    // Due, not terminal (only 1 of 2 required innings closed) — the opening
    // strip is shown so the scorer can name innings 2's pair/bowler before
    // the first ball. Ball tiles stay enabled; tapping one is still what
    // the engine's implicit-open (`createInnings` from `cricket.ball`) is for.
    const strip = pad(page).locator('[data-role="context-strip"]');
    await expect(strip, "innings 2's opening strip must exist before its first ball").toBeVisible();
    await expect(strip.getByRole("button", { name: /^Striker(:|$)/ })).toBeVisible();
    await expect(strip.getByRole("button", { name: /^Bowler(:|$)/ })).toBeVisible();
    const run1 = pad(page).locator('[data-tile-id="run1"]');
    await expect(run1).toBeEnabled();
    await run1.click();
    // Plain run — immediate submit, no enrichment dock.
    await expect(pad(page).locator('[data-role="v3-dock"]')).not.toBeVisible({ timeout: 5_000 });
    await expect
      .poll(
        async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 20_000 },
      )
      .toBe(2);

    const balls = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball");
    const opener = balls.at(-1)!;
    expect([away1, away2], "the OTHER side must be batting").toContain(opener.payload.striker);
    expect([away1, away2]).toContain(opener.payload.nonStriker);
    expect(opener.payload.striker).not.toBe(opener.payload.nonStriker);
    expect([home1, home2], "the OTHER side's opponents must be bowling").toContain(opener.payload.bowler);

    const scorebug = pad(page).locator('[data-role="v3-scorebug"]');
    // A fresh innings 2, not innings 1's total carried forward — 1 run, not 2.
    await expect(scorebug).toContainText("1/0");
  },
);

test(
  "cricket v3: a pending free hit limits the wicket sheet to run out and obstructing the field, with a hint",
  async ({ page }) => {
    // No held dispatch — the wizard is opened but never completed, only its
    // first step is asserted. EXPECTED TO FAIL against a bundle that
    // predates the free-hit wicket-kind gate (commit 2f20e2dce) — see this
    // task's own report.
    test.setTimeout(45_000);
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket FreeHitWicket ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 FW Striker ${TAG}` }, { fullName: `V3 FW NonStriker ${TAG}` }],
      away: [{ fullName: `V3 FW Bowler ${TAG}` }],
      emitCoreStart: true,
    });
    const striker = fx.personIds[`V3 FW Striker ${TAG}`]!;
    const nonStriker = fx.personIds[`V3 FW NonStriker ${TAG}`]!;
    const bowler = fx.personIds[`V3 FW Bowler ${TAG}`]!;

    // A white-ball no-ball arms the free hit (freeHitPending's own doc) —
    // the very next ball.
    await postEvent(page.request, fx.fixtureId, "cricket.ball", {
      over: 0,
      ballInOver: 1,
      striker,
      nonStriker,
      bowler,
      runs: { bat: 0, extras: { kind: "noball", runs: 1 } },
    });

    await openConsoleAlreadyLive(page, fx);
    await pad(page).locator('[data-tile-id="wicket"]').click();
    const sheet = sheetRoot(page);
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    await expect(sheet.getByRole("button", { name: "Run out", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Obstructing the field", exact: true })).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "Bowled", exact: true }),
      "FREE_HIT_WICKET_KINDS must actually narrow the list, not just add a hint on top of all ten",
    ).not.toBeVisible();
    await expect(sheet.getByRole("button", { name: "Caught", exact: true })).not.toBeVisible();
    await expect(sheet.getByText("Free hit — only Run out or Obstructing the field apply.")).toBeVisible();
  },
);

// ---------------------------------------------------------------------------
// R2c (2026-08-18) — the other two candidate-narrowing surfaces, end to end.
// Both are the same defect class the whole wave targets: the pad must never
// offer what the engine will refuse. Unit tests assert the built specs; only
// a browser proves the scorer cannot actually tap the thing.
// ---------------------------------------------------------------------------

test("cricket v3 (R2c/C2): Retire is one flow, offering only the two batters at the crease", async ({ page }) => {
  test.setTimeout(Math.max(60_000, 30_000 + HOLD_MS + 8_000));
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Cricket Retire ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [
      { fullName: `V3 RT Striker ${TAG}` },
      { fullName: `V3 RT NonStriker ${TAG}` },
      { fullName: `V3 RT Bench ${TAG}` },
    ],
    away: [{ fullName: `V3 RT Bowler ${TAG}` }],
    emitCoreStart: true,
  });
  const striker = fx.personIds[`V3 RT Striker ${TAG}`]!;
  const nonStriker = fx.personIds[`V3 RT NonStriker ${TAG}`]!;

  await postEvent(page.request, fx.fixtureId, "cricket.ball", {
    over: 0,
    ballInOver: 1,
    striker,
    nonStriker,
    bowler: fx.personIds[`V3 RT Bowler ${TAG}`]!,
    runs: { bat: 0 },
  });
  await openConsoleAlreadyLive(page, fx);

  // The tile is back (R2c amendment to defect 4's ruling) and opens the
  // skin's own guided sheet rather than the generic More-sheet form.
  const retireTile = pad(page).locator('[data-tile-id="retire"]');
  await expect(retireTile).toBeVisible({ timeout: 10_000 });
  await retireTile.click();

  const sheet = sheetRoot(page);
  await expect(sheet).toBeVisible({ timeout: 10_000 });

  // Exactly the crease. The generic flow offered all 22 from BOTH sides; the
  // dropped SwapSheet tile offered the whole batting side. Neither could
  // express "these two".
  await expect(sheet.locator(`[data-candidate-id="${striker}"]`)).toBeVisible();
  await expect(sheet.locator(`[data-candidate-id="${nonStriker}"]`)).toBeVisible();
  await expect(
    sheet.locator(`[data-candidate-id="${fx.personIds[`V3 RT Bench ${TAG}`]!}"]`),
    "a batting-side player who is not at the crease must not be offered",
  ).toHaveCount(0);
  await expect(
    sheet.locator(`[data-candidate-id="${fx.personIds[`V3 RT Bowler ${TAG}`]!}"]`),
    "a FIELDING-side player must not be offered — the generic flow's worst failure",
  ).toHaveCount(0);

  // …and the real reason enum, which is why the generic flow was kept in the
  // first place. Both halves, one flow.
  await sheet.locator(`[data-candidate-id="${striker}"]`).click();
  await expect(sheet.getByRole("button", { name: "Hurt", exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(sheet.getByRole("button", { name: "Out", exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Other", exact: true })).toBeVisible();

  // Incoming batter is required (Law 25.1), same step as a wicket. Bench is
  // the only eligible name — the crease pair must not be offered again.
  const bench = fx.personIds[`V3 RT Bench ${TAG}`]!;
  await sheet.getByRole("button", { name: "Hurt", exact: true }).click();
  await expect(sheet.getByText("Who walks in?")).toBeVisible({ timeout: 10_000 });
  await expect(sheet.locator(`[data-candidate-id="${bench}"]`)).toBeVisible();
  await expect(sheet.locator(`[data-candidate-id="${striker}"]`)).toHaveCount(0);
  await expect(sheet.locator(`[data-candidate-id="${nonStriker}"]`)).toHaveCount(0);
  await sheet.locator(`[data-candidate-id="${bench}"]`).click();
  await sendHeldNow(page);
  await expect
    .poll(
      async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.retire").length,
      { timeout: 20_000 },
    )
    .toBe(1);
  const retire = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "cricket.retire")!;
  expect(retire.payload.person).toBe(striker);
  expect(retire.payload.reason).toBe("hurt");
  expect(retire.payload.incoming, "the incoming step must reach cricket.retire, not fall back to omitted auto").toBe(
    bench,
  );
});

test("cricket v3 (R2c/C3): a side with no reviews left cannot be picked, but an umpire review is never capped", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Cricket Reviews ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `V3 RV Striker ${TAG}` }, { fullName: `V3 RV NonStriker ${TAG}` }],
    away: [{ fullName: `V3 RV Bowler ${TAG}` }],
  });
  // One review each innings, so a single unsuccessful one exhausts a side.
  const div = await apiJson<{ config: Record<string, unknown> }>(
    page.request,
    `/api/v1/divisions/${fx.divisionId}`,
  );
  expect(div.status).toBe(200);
  await setDivisionConfigSql(fx.divisionId, { ...div.data!.config, reviews: { perInnings: 1 } });

  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await postEvent(page.request, fx.fixtureId, "cricket.ball", {
    over: 0,
    ballInOver: 1,
    striker: fx.personIds[`V3 RV Striker ${TAG}`]!,
    nonStriker: fx.personIds[`V3 RV NonStriker ${TAG}`]!,
    bowler: fx.personIds[`V3 RV Bowler ${TAG}`]!,
    runs: { bat: 0 },
  });
  // The HOME side spends its only review — `lost`, which is the counter that
  // actually depletes an allowance (an upheld review does not).
  await postEvent(page.request, fx.fixtureId, "cricket.review", {
    by: fx.homeEntrantId,
    kind: "player",
    outcome: "struck_down",
  });

  await openConsoleAlreadyLive(page, fx);
  await pad(page).locator('[data-tile-id="review"]').click();
  const sheet = sheetRoot(page);
  await expect(sheet).toBeVisible({ timeout: 10_000 });

  // kind = player -> the exhausted side is shown, refused, and explained.
  await sheet.locator('[data-choice-option-id="player"]').click();
  await sheet.getByRole("button", { name: "Upheld", exact: true }).click();
  const homeOption = sheet.locator(`[data-choice-option-id="${fx.homeEntrantId}"]`);
  await expect(homeOption).toBeVisible({ timeout: 10_000 });
  await expect(homeOption).toHaveAttribute("data-blocked", "true");
  await expect(homeOption).toBeDisabled();
  await expect(homeOption, "the reason must be visible text, not a tooltip").toContainText("No reviews left");
  await expect(
    sheet.locator(`[data-choice-option-id="${fx.awayEntrantId}"]`),
    "the side that still holds a review stays selectable",
  ).not.toHaveAttribute("data-blocked", "true");
});

// R3/F review round 2 — 8a66c00f6 ("put the soft-commit dock on screen when it
// opens") shipped with NO automated coverage of the wiring that fires it. The
// pure `revealDock(node)` helper is unit-tested against a fake node, but the
// `ref` + `useEffect` that call it in production are not: `dock.test.ts` runs
// environment:"node" with the island harness, where effects never run, and
// `apps/web` has no jsdom anywhere — adding one for a single assertion is a new
// test environment, not a minor fix. e2e is the only layer that can see this.
//
// `toBeVisible` CANNOT catch it: Playwright counts a rendered element below the
// fold as visible, which is exactly the state the fix removes. The assertion has
// to be about the VIEWPORT.
//
// The condition is constructed deliberately: the dock renders immediately after
// `[data-role="v3-tiles"]` (pad-host.tsx), so scrolling the tile grid's top to
// the top of a short viewport puts the grid's bottom — and therefore the dock —
// below the fold. Without the reveal effect the dock opens off-screen and this
// test fails; that was verified by reverting the effect, not assumed.
test("cricket v3: the soft-commit dock is revealed on screen when it opens", async ({ page }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Cricket DockReveal ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `V3 DR Striker ${TAG}` }, { fullName: `V3 DR NonStriker ${TAG}` }],
    away: [{ fullName: `V3 DR Bowler ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  // Short viewport: the cricket tile grid is taller than this on its own, so
  // whatever follows it starts below the fold.
  await page.setViewportSize({ width: 390, height: 560 });
  await pad(page)
    .locator('[data-role="v3-tiles"]')
    .evaluate((node) => node.scrollIntoView({ block: "start" }));

  // No-ball opens an enrichment dock (plain runs submit immediately with no
  // dock). The reveal-into-view effect is what this test measures.
  const tile = pad(page).locator('[data-tile-id="extra-noball"]');
  // `scrollIntoViewIfNeeded` on the tile itself would undo the setup; keep the
  // grid where we scrolled it and tap without recentering.
  await tile.click();

  const dock = pad(page).locator('[data-role="v3-dock"]');
  await expect(dock).toBeVisible({ timeout: 5_000 });

  const box = await dock.boundingBox();
  expect(box, "the dock has no layout box at all").not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport, "the viewport size was not set").not.toBeNull();
  // Intersects the viewport in BOTH directions — "below the fold" and "scrolled
  // past above" are both failures of the same fix.
  expect(
    box!.y,
    "the dock opened BELOW the fold — the reveal effect did not run",
  ).toBeLessThan(viewport!.height);
  expect(
    box!.y + box!.height,
    "the dock opened above the viewport — the reveal effect scrolled the wrong way",
  ).toBeGreaterThan(0);
});
