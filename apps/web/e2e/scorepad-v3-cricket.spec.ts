import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  apiJson,
  fixturePath,
  seedRosteredFixture,
  setDivisionConfigSql,
  TAG,
  type RosteredFixture,
} from "./helpers";

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
 *  Only `bowler`, and only at an over boundary, is ever safe to pass here —
 *  striker/non-striker are `readOnly` (a plain `<span>`, no `<button>` at
 *  all, `ContextSlot.readOnly`) because the engine's strict fold refuses any
 *  override for them on the live submit path. Calling this for either still
 *  hangs (zero buttons match), which is the correct, loud failure rather
 *  than a silent no-op. */
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
// full HOLD_MS=6000ms window — none of them are testing hold-window TIMING
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
  await pad(page)
    .locator('[data-role="v3-dock"]')
    .getByRole("button", { name: "Send now", exact: true })
    .click();
}

test(
  "cricket v3: a bowler change through the context strip survives into the payload, a full " +
    "over honours cfg ballsPerOver, and a wicket completes through the guided sheet",
  async ({ page }) => {
    // Six held dispatches (five balls + one wicket), each waiting out
    // queue.ts's HOLD_MS = 6000ms soft-commit window before the ledger
    // confirms it (spec §2.3) — comfortably exceeds Playwright's 60s default.
    test.setTimeout(150_000);

    // `hundred` (5-ball overs, cricket.ts:2811) rather than t20's default 6 —
    // "a full over" only proves cfg.ballsPerOver is genuinely READ (G1) if
    // the variant under test does not also happen to match the chassis's own
    // 6-ball fallback (ballsPerOverOf, v3/skins/cricket.tsx).
    //
    // THREE home batters, not two: cricket.ts's `createInnings` forces ball
    // 1's opening pair to be lineup order[0]/order[1] EXACTLY (§2.3,
    // "openers from lineup order") — any other pair 422s ("striker/
    // non-striker do not match the ledger"), so this test's own context-strip
    // proof cannot safely target striker/non-striker at all; it targets the
    // BOWLER instead (see the comment at the over-boundary change below for
    // why that slot, specifically, is where the engine leaves room for one).
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

    // buildContext (v3/skins/cricket.tsx) requires `currentInnings() !==
    // null` — and `cricket.ts`'s `case "cricket.ball"` only creates that
    // innings lazily, INSIDE the fold of the FIRST ball itself. So the
    // context strip does not exist yet at this point: ball 1 is
    // unconditionally the lineup's own default opener pair/bowler, with no
    // UI able to override it even in principle (consistent with — and
    // arguably why nobody hit — the "openers from lineup order" rule above).
    // Score the whole first over on defaults; the context-strip proof lands
    // at the over-2 boundary below, once a strip actually exists to tap.
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
    const wicket = withWicket.payload.wicket as {
      kind: string;
      out: string;
      fielder?: string;
      bowlerCredited: boolean;
    };
    expect(wicket.kind).toBe("caught");
    expect(wicket.fielder, "credited to a REAL fielding-side member").toBe(bowler);
    expect(wicket.bowlerCredited, "caught is in BOWLER_CREDITED_KINDS").toBe(true);
    // Whoever was on strike when the catch was taken — rotates with odd
    // runs, so membership, not identity (same relaxation scorepad-v2.spec.ts's
    // own wicket assertion uses, and for the same reason).
    expect([striker, nonStriker]).toContain(wicket.out);
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

  await pad(page).getByRole("button", { name: "1", exact: true }).click();
  // The dock (v3/detail-dock.tsx) renders only while `held` is non-null
  // (pad-host.tsx) — its presence right after the tap is itself proof the
  // tap is still sitting in the hold window, before any network round trip.
  const dock = pad(page).locator('[data-role="v3-dock"]');
  await expect(dock).toBeVisible({ timeout: 5_000 });

  // decideUndo (pad-host.tsx): `heldId === eventId` -> "drop", queue.ts's
  // `dropHeld` — the event is removed from the LOCAL queue, never sent, no
  // `core.void` (there is nothing on the server to void).
  await pad(page).locator('[data-role="v3-ribbon"]').getByRole("button", { name: "Undo", exact: true }).click();
  await expect(dock, "a dropped held tap clears `held` immediately, no network round trip needed").not.toBeVisible({
    timeout: 5_000,
  });

  // Positive proof, not merely "nothing happened yet": wait PAST
  // queue.ts's HOLD_MS (6000ms) — the one deadline this mechanism has — then
  // confirm the ledger never saw the tap at all. A plain `waitForTimeout` is
  // usually the wrong tool here (AGENTS.md), but proving an ABSENCE past a
  // KNOWN deadline is the one shape of claim a fixed wait is the right proof
  // for: there is no earlier real signal to poll for the negative case.
  await page.waitForTimeout(7_000);
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
  // Wait OUT the ~6s hold for real, off the ledger — once this resolves, the
  // dock has already cleared (`onDue`) and `held` is null, so the NEXT undo
  // tap must take the "void" branch (decideUndo, pad-host.tsx), never "drop".
  await expect
    .poll(
      async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
      { timeout: 20_000 },
    )
    .toBe(1);
  await expect(pad(page).locator('[data-role="v3-dock"]')).not.toBeVisible({ timeout: 20_000 });

  await pad(page).locator('[data-role="v3-ribbon"]').getByRole("button", { name: "Undo", exact: true }).click();
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
  const anonCtx = await browser.newContext({ storageState: undefined });
  try {
    const dlPage = await anonCtx.newPage();
    await dlPage.goto(`/score/${minted.data!.secret}`);
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

  const panel = pad(page).locator('[data-role="v3-activity-slot"]');
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

  const panel = pad(page).locator('[data-role="v3-activity-slot"]');
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
    // TWO real held dispatches now (queue.ts HOLD_MS = 6000ms each) — the
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
    // (cricket.ts:1229) — buildDock's own `extraKind === "noball"` check
    // (never a bare "is this an extra") is what keeps this dock empty.
    await pad(page).locator('[data-tile-id="wide"]').click();
    await expect(dock).toBeVisible({ timeout: 5_000 });
    // Only "Send now" — zero chips. A real, non-vacuous check: buildDock
    // returns `chips: []` for a wide, so the chip row has nothing to map.
    await expect(dock.getByRole("button")).toHaveCount(1);
    await sendHeldNow(page);
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
    await expect(dock).toBeVisible({ timeout: 5_000 });
    await sendHeldNow(page);
    await expect.poll(ballCount, { timeout: 20_000 }).toBe(2);
    await expect(freeHit, "a wide must NOT clear a pending free hit").toBeVisible({ timeout: 10_000 });

    await pad(page).locator('[data-tile-id="run0"]').click();
    await expect(dock).toBeVisible({ timeout: 5_000 });
    await sendHeldNow(page);
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
    await expect(pad(page).locator('[data-role="v3-dock"]')).toBeVisible({ timeout: 5_000 });
    await sendHeldNow(page);
    await expect
      .poll(
        async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 20_000 },
      )
      .toBe(7);

    const panel = pad(page).locator('[data-role="v3-activity-slot"]');
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
  "cricket v3: a terminal closed innings disables delivery tiles with a closure message and keeps the final score on the scorebug",
  async ({ page }) => {
    // Entirely API-driven setup (a config flip + five events) plus one page
    // load — no held dispatch at all.
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

    // `dueBattingSide`/`blockedByClosure` (skins/cricket.tsx, R2b-next) go
    // null/true ONLY once NOTHING further is due — for a default
    // inningsPerSide:1 cfg that is the SAME moment the engine decides the
    // match outright (decideAfterClose -> decideWin/decideTie, phase
    // "done"), and a "done"/"final" phase hides these tiles entirely
    // (tile-grid.tsx filters by phase before `disabled` ever applies) rather
    // than disabling them. A TIE with superOver:true is the one config where
    // the match stays phase "super_over" instead (resolvePhase maps that to
    // "live", same as an ordinary live match) — forced deliberately, before
    // the first event, not an incidental config choice.
    const div = await apiJson<{ config: Record<string, unknown> }>(
      page.request,
      `/api/v1/divisions/${fx.divisionId}`,
    );
    expect(div.status, `GET division -> ${div.status}`).toBe(200);
    await setDivisionConfigSql(fx.divisionId, { ...div.data!.config, superOver: true });

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
    // target - 1 (a single ball, bat:1) so the second close TIES the match
    // rather than deciding it outright.
    await postEvent(page.request, fx.fixtureId, "cricket.ball", {
      over: 0,
      ballInOver: 1,
      striker: away1,
      nonStriker: away2,
      bowler: home1,
      runs: { bat: 1 },
    });
    await postEvent(page.request, fx.fixtureId, "cricket.innings.close", { reason: "other" });

    await openConsoleAlreadyLive(page, fx);

    for (const tileId of ["run0", "run1", "wicket"]) {
      const tile = pad(page).locator(`[data-tile-id="${tileId}"]`);
      await expect(tile, `${tileId} must be present, carrying data-tile-disabled="true"`).toHaveAttribute(
        "data-tile-disabled",
        "true",
      );
      await expect(tile).toBeDisabled();
    }
    const closureMessage = pad(page).locator(
      '[data-role="context-strip"] [data-role="context-slot-message"][data-slot-id="bowler"]',
    );
    await expect(closureMessage).toContainText("This innings is closed.");

    // currentInnings' own "falls back to the last innings once every innings
    // is closed" rule — the scorebug must keep showing away's final 1/0, not
    // blank out or revert to home's.
    await expect(pad(page).locator('[data-role="v3-scorebug"]')).toContainText("1/0");
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
    // Due, not terminal (only 1 of 2 required innings closed) — buildContext
    // returns null (no strip for an innings that does not exist yet) and the
    // ball tiles stay fully enabled; tapping one is what the engine's own
    // implicit-open (`createInnings` from `cricket.ball`) is for.
    await expect(pad(page).locator('[data-role="context-strip"]')).not.toBeVisible();
    const run1 = pad(page).locator('[data-tile-id="run1"]');
    await expect(run1).toBeEnabled();
    await run1.click();
    await expect(pad(page).locator('[data-role="v3-dock"]')).toBeVisible({ timeout: 5_000 });
    await sendHeldNow(page);
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
  test.setTimeout(45_000);
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

  const tile = pad(page).getByRole("button", { name: "1", exact: true });
  // `scrollIntoViewIfNeeded` on the tile itself would undo the setup; the tile
  // is already at the top of the grid, so a plain click never scrolls.
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
