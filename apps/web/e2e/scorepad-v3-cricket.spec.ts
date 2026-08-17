import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG, type RosteredFixture } from "./helpers";

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

/** The guided-sheet root — chassis-generic (guided-sheet.tsx), same posture
 *  `pad()` above already takes for the scorepad root itself. R2b's
 *  over-by-over sheet is the first place THIS file drives it. */
function sheetRoot(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
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
    "copy, prefills its sheet from the fold on reopen, and hides the ball tiles once the innings is coarse",
  async ({ page }) => {
    // One real held dispatch (queue.ts HOLD_MS = 6000ms) plus openLiveConsole's
    // own two 20s-ceiling polls, plus a second (cancelled, no network) sheet
    // open — the two Undo conversions elsewhere in this file budget 120_000
    // for the plain "one openLiveConsole + one submit" shape, so the same
    // ceiling covers this test's extra, network-free step with headroom.
    test.setTimeout(120_000);
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

    // Step 1/3 — "Total runs": prefilled from the fold's CURRENT total (0,
    // nothing recorded yet), never blank/undefined — R2b Q2's own ruling is
    // that the sheet PREFILLS a running total, it is not a from-zero
    // increment form.
    let field = sheet.getByRole("spinbutton", { name: "Total runs" });
    await expect(field).toBeVisible({ timeout: 10_000 });
    await expect(field, "prefill must read the fold's current total, not a hardcoded 0").toHaveValue("0");
    await field.fill("8");
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();

    // Step 2/3 — "Total wickets": prefilled 0, left unedited.
    field = sheet.getByRole("spinbutton", { name: "Total wickets" });
    await expect(field).toBeVisible({ timeout: 10_000 });
    await expect(field).toHaveValue("0");
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();

    // Step 3/3 — "Balls bowled": prefilled to a FULL over past the current
    // total (0 + t20's own 6-ball bpo, `overSummarySheet`'s own "assume a
    // full over unless told otherwise") — left unedited; confirming closes
    // the wizard and dispatches.
    field = sheet.getByRole("spinbutton", { name: "Balls bowled" });
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
    // A TOTAL, never an increment (R2b Q2): the payload is exactly what the
    // scorer saw on screen, unedited past the runs prefill.
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

    // Reopen: the wizard PREFILLS from the fold's now-UPDATED total (8, not
    // reset to 0) — the explicit "record something first, reopen, assert the
    // prefill reflects it" proof this wave's own e2e gap named.
    await overTile.click();
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    field = sheet.getByRole("spinbutton", { name: "Total runs" });
    await expect(field, "reopen must prefill from the FOLD's current total, not reset to 0").toHaveValue("8");
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sheet).not.toBeVisible({ timeout: 10_000 });

    // Cancel must not dispatch — the ledger's own summary count stays at 1.
    const afterCancel = await ledger(page.request, fx.fixtureId);
    expect(afterCancel.filter((e) => e.type === "cricket.innings.summary")).toHaveLength(1);
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
