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

/** Tap one context-strip chip and pick a candidate by NAME. `chipLabel` must
 *  match the slot's UNSET text exactly ("Bowler"/"Striker"/"Non-striker") —
 *  `exact: true` matters because Playwright's default text match is a
 *  case-insensitive substring, and "Non-striker" contains "striker". */
async function setContextPerson(page: Page, chipLabel: string, personName: string): Promise<void> {
  const strip = pad(page).locator('[data-role="context-strip"]');
  await strip.getByRole("button", { name: chipLabel, exact: true }).click();
  const candidate = strip.getByRole("button", { name: personName, exact: true });
  await expect(candidate, `${chipLabel} picker must show real names, not ids`).toBeVisible({ timeout: 10_000 });
  await candidate.click();
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
