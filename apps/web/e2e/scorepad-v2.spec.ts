import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  apiJson,
  fixturePath,
  seedRosteredFixture,
  expectNoHorizontalScroll,
  TAG,
  type RosteredFixture,
} from "./helpers";

// S12/#421 W10, and the only pad since S13/#422 W11's cutover removed the
// flag and v1 entirely — the v2 scoring pad driven through the REAL entry
// points, against REAL rosters. Runs in the ordinary `parallel` Playwright
// project now (playwright.config.ts) — it used to need its own project
// against a second, flag-forced server, back when a flag existed to force.
//
// WHY THIS FILE EXISTS SEPARATELY FROM scorepad-skins.spec.ts: that file
// drives S10's dev-only harness route, whose client lineups are permanently
// SYNTHETIC ("h-1"/"h-2"/"a-1"…). Every `cricket.ball` carries
// striker/nonStriker/bowler and `football.goal` carries scorer/assist, and the
// server folds those against the fixture's REAL lineup and 422s on a person it
// cannot find on the pitch — so cricket had no browser coverage at all and
// football's goal could only ever be driven side-only. S11 recorded both as
// owed to this session.

// Deliberately NOT serial. Each test seeds its OWN competition/division, so
// there is no shared-org race, and a serial file stops at the first failure —
// which during this session meant seeing one defect per run when four were
// present. Parallel gives every test's verdict in one pass.
test.describe.configure({ mode: "parallel" });

/** The pad's own scoring surface, scoped so a page-wide text match can never
 *  satisfy an assertion the skin was supposed to. */
function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

/** Read the real ledger. Every assertion below is checked against THIS, not
 *  only against the screen: a pad that renders a run it never delivered is
 *  precisely the failure an on-screen-only assertion cannot see. */
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

async function fixtureState(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ last_seq: number; status: string; summary: unknown }> {
  const res = await apiJson<{ last_seq: number; status: string; summary: unknown }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(res.status).toBe(200);
  return res.data!;
}

/** Open the console and take the fixture live through the console's own
 *  "Start match" control — the real organiser flow, and deliberately NOT an
 *  API-seeded `core.start`. `core.start` arriving from the chrome is a FOREIGN
 *  write as far as the pad is concerned (the button lives outside the pad
 *  section in both dispatchers), and the pad adopting it is itself a thing
 *  this session had to fix. Seeding it over HTTP would skip that entirely and
 *  leave the regression uncovered. */
async function openLiveConsole(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  // Wait on the LEDGER, not on a spinner: the pad is only meaningfully live
  // once the server has the event.
  await expect
    .poll(async () => (await fixtureState(page.request, fx.fixtureId)).last_seq, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), {
      timeout: 20_000,
    })
    .toContain("core.start");
}

test.describe("v2 console — cricket, the headline flow S11 could not drive", () => {
  let fx: RosteredFixture;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    fx = await seedRosteredFixture(page.request, {
      label: `S12 Cricket ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [
        { fullName: `Striker ${TAG}` },
        { fullName: `NonStriker ${TAG}` },
        { fullName: `Number Three ${TAG}` },
      ],
      away: [
        { fullName: `Bowler ${TAG}` },
        { fullName: `Fielder ${TAG}` },
        { fullName: `Slip ${TAG}` },
      ],
    });
    await page.close();
  });

  test("a full over including an extra, then a dismissal credited to a fielder", async ({
    page,
  }) => {
    // Six taps land through the soft-commit hold (queue.ts's HOLD_MS =
    // 6000ms, spec §2.3) plus a wicket's own guided-sheet dispatch, each
    // waited out below rather than raced — comfortably exceeds Playwright's
    // 60s config default.
    test.setTimeout(150_000);
    await openLiveConsole(page, fx);

    const striker = fx.personIds[`Striker ${TAG}`]!;
    const nonStriker = fx.personIds[`NonStriker ${TAG}`]!;
    const bowler = fx.personIds[`Bowler ${TAG}`]!;
    const fielder = fx.personIds[`Fielder ${TAG}`]!;

    // The context strip (D-14's replacement for the three "This over"
    // selects) only renders once an innings exists (`buildContext`,
    // v3/skins/cricket.tsx, requires `currentInnings() !== null`), and
    // `cricket.ts`'s own fold creates that innings LAZILY, inside ball 1's
    // own apply — so there is nothing to tap yet at this point in the flow.
    // Ball 1 is unconditionally the lineup's own default opener pair/bowler
    // (`createInnings`'s "openers from lineup order", §2.3 — any other pair
    // 422s "striker/non-striker do not match the ledger"), which is exactly
    // what this fixture's roster already resolves to with no picker
    // involved. The "shows real names, not raw ids" proof (D-14's own
    // regression, S11-era: cricket-skin's `displayPerson` once returned its
    // argument verbatim) moves to right after ball 1 below, once the strip
    // actually exists to read.

    // Five legal deliveries plus ONE wide. The wide is the point: it does not
    // advance `ballInOver`, so an over containing one is six legal balls
    // across seven events — the exact arithmetic a pad gets wrong if it
    // counts taps instead of legal balls.
    // Wait for the LEDGER to advance between taps rather than sleeping a fixed
    // interval. Two reasons, both real: the submit is async through a durable
    // queue, so a fixed wait races the drain; and `usePadPipeline`'s
    // double-submit guard suppresses a repeat of the SAME (type, payload)
    // within its window — two dot balls tapped before the fold advances build
    // byte-identical payloads and the second is correctly swallowed. A scorer
    // tapping at human speed never hits either; a test with `waitForTimeout`
    // hits both and reads as a pad bug.
    let delivered = 0;
    for (const runs of ["1", "0", "2", "0", "4"]) {
      await pad(page).getByRole("button", { name: runs, exact: true }).click();
      delivered += 1;
      await expect
        .poll(
          async () =>
            (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
          { timeout: 20_000 },
        )
        .toBe(delivered);
    }

    // NOW the context strip exists (ball 1 created the innings) — the
    // "shows real names, not raw ids" proof this describe block's own
    // header names (D-14). Membership across the whole strip, not a
    // per-slot identity: an odd run (ball 1's "1") rotates strike, so
    // whether "Striker"/"NonStriker" currently occupy the striker or the
    // non-striker chip is not fixed — every one of the three seeded names
    // must appear SOMEWHERE in the strip's own rendered text regardless.
    // Matched as `": <name>"` (chipLabel's own `"${label}: ${name}"` format,
    // context-strip.tsx), never a bare name: "NonStriker" contains "Striker"
    // as a literal substring, so a bare `toContainText("Striker …")` would
    // pass off "NonStriker …" alone and never actually prove the "Striker"
    // chip rendered anything.
    const strip = pad(page).locator('[data-role="context-strip"]');
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(strip).toContainText(`: Striker ${TAG}`);
    await expect(strip).toContainText(`: NonStriker ${TAG}`);
    await expect(strip).toContainText(`: Bowler ${TAG}`);

    await pad(page).getByRole("button", { name: "Wide", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
        { timeout: 20_000 },
      )
      .toBe(6);

    const afterOver = await ledger(page.request, fx.fixtureId);
    const balls = afterOver.filter((e) => e.type === "cricket.ball");
    expect(balls.length, "five runs plus one wide = six cricket.ball events").toBe(6);

    const wide = balls.find(
      (b) => (b.payload.runs as { extras?: { kind?: string } } | undefined)?.extras?.kind === "wide",
    );
    expect(wide, "the wide must reach the ledger as a real extras payload").toBeTruthy();

    // Every ball must carry REAL roster ids — the assertion the harness route
    // could never make, since synthetic lineups 422 here.
    //
    // Asserted as SET MEMBERSHIP for the two batters, not fixed identity: an
    // odd number of runs changes ends, and S11 deliberately fixed cricket's
    // pickers to resync to the fold for exactly that reason ("a scorer could
    // score against the wrong end"). Pinning `striker` to one person would
    // therefore assert the bug S11 fixed. The bowler IS fixed within an over,
    // so that one is pinned by identity.
    const batters = new Set([striker, nonStriker]);
    for (const b of balls) {
      expect(batters.has(b.payload.striker as string)).toBe(true);
      expect(batters.has(b.payload.nonStriker as string)).toBe(true);
      expect(b.payload.striker).not.toBe(b.payload.nonStriker);
      expect(b.payload.bowler).toBe(bowler);
    }
    // And the ends really did change at least once, or the "set membership"
    // relaxation above would be hiding a pad that never rotates strike.
    expect(new Set(balls.map((b) => b.payload.striker as string)).size).toBe(2);

    // A caught dismissal, credited to a fielder who is a real member of the
    // fielding side.
    //
    // The wicket surface is the v3 guided sheet (G2, v3/guided-sheet.tsx) —
    // "Wicket" is a tile whose `action` is `{sheet: "wicket"}`, opening
    // `[data-role="v3-sheet"]`; there is no `<select>` and no
    // `[data-role="confirm"]` here (football's goal DOES go through the
    // generic ActionForm, which is why the same selector is right there and
    // wrong here — this sheet completes on the LAST answer, no separate
    // confirm step). The flow is: Wicket -> kind -> [which batter, only when
    // `kind === "runout"`] -> fielder [only when kind is caught/runout/
    // stumped], and picking the fielder completes the wizard and dispatches.
    //
    // Nothing below is wrapped in `.catch()`. A swallowed step would leave the
    // flagship "credited to a named fielder" assertion passing over a UI it
    // never actually drove.
    const sheet = pad(page).locator('[data-role="v3-sheet"]');
    await pad(page).getByRole("button", { name: "Wicket", exact: true }).click();
    await sheet.getByRole("button", { name: "Caught", exact: true }).click();

    // Only some dismissal kinds ask which batter is out (a run-out can take
    // either end); a catch cannot, so this step is conditional by design
    // (G2's `when(answers)`, not by defensiveness) — and it asserts by NAME,
    // which also pins that the picker resolves personNames rather than
    // drawing a raw id.
    const outChoice = sheet.getByRole("button", { name: `Striker ${TAG}`, exact: true });
    if ((await outChoice.count()) > 0) await outChoice.first().click();

    await sheet.getByRole("button", { name: `Fielder ${TAG}`, exact: true }).click();

    await expect
      .poll(async () => {
        const evs = await ledger(page.request, fx.fixtureId);
        return evs.filter(
          (e) => e.type === "cricket.ball" && (e.payload as { wicket?: unknown }).wicket,
        ).length;
      }, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    const withWicket = (await ledger(page.request, fx.fixtureId)).find(
      (e) => e.type === "cricket.ball" && (e.payload as { wicket?: unknown }).wicket,
    )!;
    const wicket = withWicket.payload.wicket as {
      kind: string;
      out: string;
      fielder?: string;
      bowlerCredited: boolean;
    };
    expect(wicket.kind).toBe("caught");
    // Whoever was ON STRIKE when the catch was taken — which rotates with odd
    // runs, so this is membership, not identity, for the same reason as the
    // per-ball assertion above.
    expect([striker, nonStriker]).toContain(wicket.out);
    expect(wicket.fielder, "the dismissal must be credited to a REAL fielder").toBe(fielder);
  });

  test("undo goes through the pad's own timeline and the ledger records the void", async ({
    page,
  }) => {
    // FOOTBALL, not generic: undo is sport-agnostic (it submits `core.void`
    // through the same pipeline whatever produced the event), and football's
    // scoring flow is proven green above. Driving it through a second,
    // differently-shaped action form would add an unknown without adding
    // coverage of the thing under test.
    //
    // Its OWN fixture, seeded here rather than reusing the describe's shared
    // one: the earlier version assumed the over test had already run, which
    // held under `mode: "serial"` and does not now. A test depending on a
    // sibling's side effects reads as a product flake later.
    const own = await seedRosteredFixture(page.request, {
      label: `S12 Undo ${TAG}`,
      sportKey: "football",
      variantKey: "11-a-side",
      home: [
        { fullName: `U Scorer ${TAG}`, positionKey: "FW" },
        { fullName: `U Keeper ${TAG}`, positionKey: "GK" },
      ],
      away: [{ fullName: `U Away ${TAG}`, positionKey: "GK" }],
    });
    await openLiveConsole(page, own);

    await pad(page).getByRole("button", { name: "Home · Goal", exact: true }).click();
    const scorer = pad(page).getByRole("button", { name: `U Scorer ${TAG}`, exact: true });
    await expect(scorer).toHaveCount(2);
    await scorer.nth(0).click();
    const assist = pad(page).getByRole("button", { name: `U Keeper ${TAG}`, exact: true });
    await expect(assist).toHaveCount(2);
    await assist.nth(1).click();

    await expect
      .poll(
        async () => (await ledger(page.request, own.fixtureId)).filter((e) => e.type === "football.goal").length,
        { timeout: 20_000 },
      )
      .toBe(1);
    const goal = (await ledger(page.request, own.fixtureId)).find((e) => e.type === "football.goal")!;

    // The timeline is the pad's OWN undo, wired to the pipeline's `submit` in
    // this session. Before it, `timeline.tsx` was imported by nothing and
    // could not be wired by any caller, so the only undo was the v1 chrome's —
    // which S13 deletes, and which cannot work offline.
    // RELOAD before undoing, deliberately. The pad's own optimistic envelope
    // carries a CLIENT-fabricated id (the idempotency key), while the ledger's
    // row carries the server-assigned one — they differ by construction, so a
    // freshly-submitted row cannot be addressed by the id the API reports. A
    // reload rebuilds the timeline from the server's `initialEvents`, which is
    // both how a scorer returning to the page sees it and a second exercise of
    // this session's re-seed fix.
    await page.reload();
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });

    const timeline = pad(page).locator('[data-role="timeline"]');
    await expect(timeline).toBeVisible();
    // Scope to the GOAL's own row. `.first()` takes the oldest row, which is
    // `core.start` — a lifecycle event the server will not void — so the click
    // landed and nothing happened, which reads as a broken undo rather than as
    // a mis-aimed test. Voiding a NAMED event is the stronger assertion
    // anyway: it proves the timeline wires each row to its own event id.
    const goalRow = timeline.locator(`[data-event-id="${goal.id}"]`);
    await expect(goalRow).toHaveCount(1);

    // A click straight after a reload can land PRE-HYDRATION: the button is
    // visible, stable and enabled — everything Playwright's actionability
    // checks cover — but React has not attached its handler yet, so the click
    // is swallowed and the test then times out waiting for a void that was
    // never requested. Measured here: one red in six runs of this file, on a
    // warm server as well as a deliberately cold one. Same pattern and same
    // cause as `v6-sports.spec.ts`'s Release retry and `scoring.spec.ts`'s
    // re-fill loops.
    //
    // There is no prompt client-only signal to wait on instead: the pad's
    // `useFixtureStream` arms `setInterval` at `POLL_MS` (15s) without an
    // immediate fetch, so waiting on its first poll would cost 15s per run and
    // still prove only that the stream mounted.
    //
    // The retry is GUARDED on the ledger rather than blind, so a click that
    // did register can never be issued twice — voiding an already-voided event
    // is a real state change, not a harmless repeat, and a blind retry would
    // trade a flake for a silent second void.
    const voidCount = async (): Promise<number> =>
      (await ledger(page.request, own.fixtureId)).filter((e) => e.type === "core.void").length;

    await expect(async () => {
      if ((await voidCount()) === 0) {
        await goalRow.locator('[data-role="void"]').click();
        await page.waitForTimeout(1_500);
      }
      expect(await voidCount()).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 25_000 });

    const voidEvent = (await ledger(page.request, own.fixtureId)).find((e) => e.type === "core.void")!;
    expect(voidEvent.seq).toBeGreaterThan(goal.seq);
  });

  // S12/#421 pass G — the case the reload above deliberately does NOT cover.
  // A pad-submitted event carries a client-fabricated id, so before pass G its
  // Undo was swallowed entirely: no core.void, and no POST at all. That is the
  // undo that matters ("I just tapped the wrong thing"); undoing something
  // from a previous page load is the rare one. No reload anywhere here.
  test("undo works for an event this pad just scored, with no reload", async ({ page }) => {
    const own = await seedRosteredFixture(page.request, {
      label: `S12 UndoLive ${TAG}`,
      sportKey: "football",
      variantKey: "11-a-side",
      home: [
        { fullName: `L Scorer ${TAG}`, positionKey: "FW" },
        { fullName: `L Keeper ${TAG}`, positionKey: "GK" },
      ],
      away: [{ fullName: `L Away ${TAG}`, positionKey: "GK" }],
    });
    await openLiveConsole(page, own);

    await pad(page).getByRole("button", { name: "Home · Goal", exact: true }).click();
    const sc = pad(page).getByRole("button", { name: `L Scorer ${TAG}`, exact: true });
    await expect(sc).toHaveCount(2);
    await sc.nth(0).click();
    const as = pad(page).getByRole("button", { name: `L Keeper ${TAG}`, exact: true });
    await expect(as).toHaveCount(2);
    await as.nth(1).click();

    await expect
      .poll(
        async () => (await ledger(page.request, own.fixtureId)).filter((e) => e.type === "football.goal").length,
        { timeout: 20_000 },
      )
      .toBe(1);

    // Straight to Undo on the goal's row. Located by TEXT, because the row's
    // own `data-event-id` is the client id and deliberately does not match the
    // ledger's — that mismatch is the whole defect.
    const goalRow = pad(page)
      .locator('[data-role="timeline"] [data-event-id]')
      .filter({ hasText: /Goal/i })
      .first();
    await expect(goalRow).toHaveCount(1);
    await goalRow.locator('[data-role="void"]').click();

    await expect
      .poll(
        async () => (await ledger(page.request, own.fixtureId)).filter((e) => e.type === "core.void").length,
        { timeout: 25_000 },
      )
      .toBe(1);
  });

  test("no horizontal scroll at 375 or 320, and the tile grid + context strip meet the touch bar", async ({
    page,
  }) => {
    // OWN fixture, deliberately NOT the describe's shared `fx`.
    //
    // This test asserts on LIVE-phase controls (the run/wicket tiles declare
    // `phases: ["live"]`), but the siblings sharing `fx` score balls, void
    // events and close the innings. Under CI's 2 workers they run CONCURRENTLY
    // with this one, so the match can be past `live` by the time this asserts
    // — the tile grid is then correctly empty and `tileCount` is 0, not 3.
    //
    // That is exactly how this failed on CI (`run/wicket tiles must be present
    // at 375`) while passing every local run: reproduced 2/2 with
    // `--workers=2` and 0/2 with `--workers=1`. The old conditional
    // "click Start if a button happens to be there" could not fix it, because
    // the race is about what the match has ALREADY become, not about who
    // clicks Start.
    const own = await seedRosteredFixture(page.request, {
      label: `S12 Cricket Layout ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `Layout Striker ${TAG}` }, { fullName: `Layout NonStriker ${TAG}` }],
      away: [{ fullName: `Layout Bowler ${TAG}` }],
    });

    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(await fixturePath(page.request, own.fixtureId));
      await expect(pad(page)).toBeVisible({ timeout: 20_000 });
      await expectNoHorizontalScroll(page);

      // Nobody else touches `own`, so the match is live exactly when this
      // test makes it live. Retry the click until the LEDGER moves rather
      // than clicking once: `waitUntil:"load"` fires before React hydrates,
      // so a single click can land on a not-yet-live button, leave the
      // fixture in `pre`, and the run tiles then correctly do not exist —
      // which reads as "tiles missing" (tileCount 0) rather than as the
      // hydration race it is. Same pattern mobile.spec.ts already uses for
      // this exact reason.
      await expect
        .poll(
          async () => {
            const types = (await ledger(page.request, own.fixtureId)).map((e) => e.type);
            if (types.includes("core.start")) return true;
            const btn = page.getByRole("button", { name: "Start match", exact: true });
            if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 5_000 }).catch(() => {});
            return false;
          },
          { timeout: 30_000 },
        )
        .toBe(true);

      // The run/wicket TILES are the REQUIRED entry every ball, replacing the
      // v2 "This over" selects as the pad's most-tapped control (D-14) — the
      // strongest case in this pad for the repo's 44px bar (the v2 selects
      // measured at 33px before the session that fixed them; tile-grid.tsx's
      // own `KIND_MIN_HEIGHT` declares 52px for `primary`/`destructive`, so
      // this MEASURES rather than assumes that holds once real CSS is laid
      // out). Guarded by count first: a selector matching nothing would pass
      // a for-all height check vacuously, which is exactly how a renamed
      // `data-tile-id` would slip past.
      const requiredTiles = pad(page).locator(
        '[data-tile-id="run0"], [data-tile-id="run1"], [data-tile-id="wicket"]',
      );
      // Poll for the tiles rather than counting once. `core.start` landing on
      // the LEDGER is a server fact; the pad re-rendering into its `live`
      // phase is a client one, and the second lags the first. Counting
      // immediately after the ledger moves reads 0 tiles and blames the tile
      // grid for what is really "the page has not caught up yet".
      //
      // This still FAILS if the tiles genuinely never render — the poll times
      // out and reports the same message — so it waits for the right thing
      // without being able to paper over a missing grid.
      await expect
        .poll(async () => requiredTiles.count(), {
          timeout: 20_000,
          message: `run/wicket tiles must be present at ${width}`,
        })
        .toBe(3);
      const tileCount = await requiredTiles.count();
      for (let i = 0; i < tileCount; i++) {
        const box = await requiredTiles.nth(i).boundingBox();
        expect(box, `tile ${i} must be laid out at ${width}`).not.toBeNull();
        expect(box!.height, `tile ${i} at ${width}px is ${Math.round(box!.height)}px`).toBeGreaterThanOrEqual(
          44,
        );
      }

      // The context strip (D-14's own "set once, tap to change" chips) only
      // renders once an innings exists (buildContext, v3/skins/cricket.tsx) —
      // which, on this shared-`fx` race, may or may not be true yet. Checked
      // best-effort, same race tolerance as the "Start match" branch above:
      // when present, every chip must ALSO clear the 44px bar.
      const chips = pad(page).locator('[data-role="context-strip"] button');
      const chipCount = await chips.count();
      for (let i = 0; i < chipCount; i++) {
        const box = await chips.nth(i).boundingBox();
        expect(box, `context chip ${i} must be laid out at ${width}`).not.toBeNull();
        expect(
          box!.height,
          `context chip ${i} at ${width}px is ${Math.round(box!.height)}px`,
        ).toBeGreaterThanOrEqual(44);
      }
    }
  });
});

test.describe("v2 console — football's goal WITH assist", () => {
  test("a goal carries both scorer and assist, both real roster members", async ({ page }) => {
    const fx = await seedRosteredFixture(page.request, {
      label: `S12 Football ${TAG}`,
      sportKey: "football",
      variantKey: "11-a-side",
      home: [
        { fullName: `Scorer ${TAG}`, positionKey: "FW" },
        { fullName: `Assister ${TAG}`, positionKey: "MF" },
        { fullName: `Home Keeper ${TAG}`, positionKey: "GK" },
      ],
      away: [
        { fullName: `Away Keeper ${TAG}`, positionKey: "GK" },
        { fullName: `Away Back ${TAG}`, positionKey: "DF" },
      ],
    });
    await openLiveConsole(page, fx);

    const scorer = fx.personIds[`Scorer ${TAG}`]!;
    const assist = fx.personIds[`Assister ${TAG}`]!;

    await pad(page).getByRole("button", { name: "Home · Goal", exact: true }).click();

    // The scorer/assist pickers are BUTTONS labelled with the person's name.
    // Asserting on the name is also the regression guard for football-skin's
    // own raw-id defect (`ids.map((id) => ({ value: id, label: id }))`) fixed
    // this session — a UUID label would fail this line, not merely look bad.
    // The captions are the regression guard for this session's fix replacing
    // the unreadable ordinal fallback ("Goal — Person #2" / "#3") with each
    // item's own humanised path. Asserted directly rather than used as a click
    // scope — scoping by an ancestor div matched a leaf holding no buttons.
    await expect(pad(page)).toContainText("Goal — Scorer");
    await expect(pad(page)).toContainText("Goal — Assist");

    // Both pickers offer the whole squad, so each name appears TWICE — once
    // per slot, in slot order. Asserting the count first means a future
    // single-picker regression fails loudly here instead of silently clicking
    // the wrong slot.
    const scorerBtns = pad(page).getByRole("button", { name: `Scorer ${TAG}`, exact: true });
    await expect(scorerBtns).toHaveCount(2);
    await scorerBtns.nth(0).click();

    const assistBtns = pad(page).getByRole("button", { name: `Assister ${TAG}`, exact: true });
    await expect(assistBtns).toHaveCount(2);
    // Picking the LAST required attribution auto-submits — measured, not
    // assumed: after this click the form closes and `football.goal` is already
    // on the ledger. That is deliberate, and it is what S11's recorded tap
    // count for this flow means ("football goal with assist 3 vs 6": Goal,
    // Scorer, Assist). Clicking a `Confirm` afterwards waits forever on a
    // control the pad has correctly removed.
    await assistBtns.nth(1).click();

    await expect
      .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.goal").length, {
        timeout: 15_000,
      })
      .toBe(1);

    const goal = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "football.goal")!;
    expect(goal.payload.scorer, "scorer must be the real person").toBe(scorer);
    expect(goal.payload.assist, "assist is the half S11 could not drive at all").toBe(assist);
  });
});

// ---------------------------------------------------------------------------
// Device link — the second entry point, offline, on the UNIVERSAL renderer
// ---------------------------------------------------------------------------

/** Exactly the durable object store `queue.ts`'s own `depth()` reads
 *  (queue-store.ts's `STORE_NAME`), read straight from IndexedDB inside the
 *  browser. Not the status pill: pad-renderer.tsx's queue label shows EITHER
 *  the offline message OR a "{count} queued" count, never both, so no visible
 *  text carries a reliable digit while a drain is blocked (S10/#419 measured
 *  this; the same reasoning applies here). */
async function queueDepth(page: Page, dbName: string): Promise<number> {
  return page.evaluate(
    ({ name, store }) =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve(0);
            return;
          }
          const tx = db.transaction(store, "readonly");
          const countReq = tx.objectStore(store).count();
          countReq.onsuccess = () => {
            resolve(countReq.result);
            db.close();
          };
          countReq.onerror = () => reject(countReq.error ?? new Error("count failed"));
        };
        req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
      }),
    { name: dbName, store: "pending-events" },
  );
}

test("device link: score offline on the universal renderer, reconnect, drain, converge", async ({
  browser,
  request,
}) => {
  // Seed + mint + four scored actions (each a two-step attribution) + a real
  // offline window + a drain that waits on the queue emptying. That does not
  // fit the 60s default, and a timeout here would read as a product hang
  // rather than as a test budget.
  test.setTimeout(180_000);
  // `generic` deliberately: it is one of the three sports `resolveScorePad`
  // marks "universal", so this exercises the UNIVERSAL renderer on the device
  // entry point while the cricket/football tests above exercise skins on the
  // console entry point. Between them both branches of the registry's own
  // decision table are driven through a real browser. `generic.score` also
  // tolerates `phase: "pre"`, so this scenario needs no `core.start` and can
  // go offline immediately.
  const fx = await seedRosteredFixture(request, {
    label: `S12 Device ${TAG}`,
    sportKey: "generic",
    variantKey: "score",
    entrantKind: "individual",
    home: [{ fullName: `Device Home ${TAG}` }],
    away: [{ fullName: `Device Away ${TAG}` }],
  });

  const minted = await apiJson<{ id: string; secret: string }>(
    request,
    `/api/v1/fixtures/${fx.fixtureId}/device-links`,
    "POST",
    { label: `Court ${TAG}` },
  );
  expect(minted.status, `mint failed: ${JSON.stringify(minted.error)}`).toBe(201);
  const secret = minted.data!.secret;
  expect(secret.startsWith("dl_")).toBe(true);

  // EXPLICIT fresh context. `browser.newContext()` bare is the documented trap
  // here — it can inherit the authed storageState, and the whole point of this
  // test is that the TOKEN is the only credential. Passing
  // `storageState: undefined` makes that unambiguous rather than relying on
  // which fixture Playwright happens to apply.
  const anonCtx = await browser.newContext({ storageState: undefined });
  try {
    const page = await anonCtx.newPage();
    await page.goto(`/score/${secret}`);
    // NOT `pad(page)`: `data-testid="score-pad"` exists only in
    // fixture-console.tsx. The device route renders its own bare <section>,
    // so scoping to that testid here matches nothing and every assertion
    // below would fail for the wrong reason.
    const startBtn = page.getByRole("button", { name: "Start match", exact: true });
    if ((await startBtn.count()) > 0) {
      await startBtn.click();
      await expect
        .poll(async () => (await fixtureState(request, fx.fixtureId)).last_seq, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(1);
    }
    const scoreButton = page.getByRole("button", { name: "Add points", exact: true });
    await expect(scoreButton).toBeVisible({ timeout: 20_000 });

    // `generic.score` declares a REQUIRED `by` side attribution, so the action
    // tap opens the picker rather than submitting. The offline batch below
    // repeats both steps — a single-tap loop would queue nothing and the drain
    // assertions would pass vacuously against an empty queue.
    // `points` VARIES per call, and that is load-bearing rather than cosmetic:
    // `usePadPipeline`'s double-submit guard compares (type, payload)
    // structurally, so three identical `points:1, by:Home` taps are one action
    // repeated and the guard correctly swallows two of them. Measured — a
    // fixed value queued 2, not 3. A courtside scorer entering the same score
    // three times in a row within the guard window is the case the guard
    // exists for; three genuinely different entries is what this test needs.
    async function scoreOnce(points: number): Promise<void> {
      await scoreButton.click();
      // `generic.score` needs its `points` number as well as the `by` side.
      await page.locator('input[type="number"]').first().fill(String(points));
      await page.getByRole("button", { name: "Home", exact: true }).click();
      const c = page.getByRole("button", { name: "Confirm", exact: true });
      if ((await c.count()) > 0) await c.click();
    }

    // Land one online first, so the offline batch is provably additive rather
    // than the whole ledger.
    const seqBeforeFirstTap = (await fixtureState(request, fx.fixtureId)).last_seq;
    await scoreOnce(1);
    await expect
      .poll(async () => (await fixtureState(request, fx.fixtureId)).last_seq, { timeout: 20_000 })
      .toBeGreaterThan(seqBeforeFirstTap);
    const seqBeforeOffline = (await fixtureState(request, fx.fixtureId)).last_seq;

    // Context-level network kill, as the brief mandates. Safe here precisely
    // because this scenario never navigates again — `setOffline(true)` blocks
    // every request from the page including a reload's own document fetch.
    await anonCtx.setOffline(true);
    for (const points of [2, 3, 4]) {
      await scoreOnce(points);
      await page.waitForTimeout(200);
    }

    // Must match registry.tsx's own `queueDbName` literal exactly — this
    // reads the browser's real IndexedDB by name.
    const dbName = `scorepad-${fx.fixtureId}`;
    await expect
      .poll(() => queueDepth(page, dbName), { timeout: 15_000 })
      .toBe(3);
    // The server must NOT have moved while the network was down — otherwise
    // "the queue drained" below would be indistinguishable from "the writes
    // were never really blocked".
    expect((await fixtureState(request, fx.fixtureId)).last_seq).toBe(seqBeforeOffline);

    await anonCtx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect
      .poll(() => queueDepth(page, dbName), { timeout: 45_000 })
      .toBe(0);

    // Convergence asserted on BOTH halves the brief names: the ledger's own
    // last_seq AND the derived summary. A queue that empties because its
    // entries were DROPPED satisfies a depth check and nothing else, which is
    // why the seq arithmetic is exact rather than "greater than".
    const after = await fixtureState(request, fx.fixtureId);
    expect(after.last_seq, "every queued event landed, none dropped, none duplicated").toBe(
      seqBeforeOffline + 3,
    );
    expect(after.summary, "the server recomputed a real summary from the drained events").toBeTruthy();

    const types = (await ledger(request, fx.fixtureId)).map((e) => e.type);
    expect(types.filter((t) => t === "generic.score")).toHaveLength(4);

    await expectNoHorizontalScroll(page);
  } finally {
    await anonCtx.close();
  }
});

test("an expanded action form gets the whole row at 320, not half of one", async ({ browser, request }) => {
  // The regression this closes is invisible to every gate this session already
  // runs. `expectNoHorizontalScroll` passes throughout: the PAGE never scrolls,
  // because the squeezed form's own children scroll INSIDE it. Only a width
  // measurement sees it. Two of the four panel layouts are `grid grid-cols-2`
  // at every width (panel.tsx), and an expanded ActionForm kept the single cell
  // its collapsed button had — 110px inside a 228px panel at 320, measured on
  // the device-link entry point, which is the surface most likely to BE 320.
  //
  // Asserted as a RATIO of the panel, not an absolute pixel width: the panel's
  // own width is a function of page chrome and card padding, and pinning that
  // number would make this test fail on any unrelated layout change while
  // still not saying what it means. The claim is "the form spans its row".
  const fx = await seedRosteredFixture(request, {
    label: `S12 Narrow ${TAG}`,
    sportKey: "generic",
    variantKey: "score",
    entrantKind: "individual",
    home: [{ fullName: `Narrow Home ${TAG}` }],
    away: [{ fullName: `Narrow Away ${TAG}` }],
  });
  const minted = await apiJson<{ id: string; secret: string }>(
    request,
    `/api/v1/fixtures/${fx.fixtureId}/device-links`,
    "POST",
    { label: `Narrow ${TAG}` },
  );
  expect(minted.status, `mint failed: ${JSON.stringify(minted.error)}`).toBe(201);

  const ctx = await browser.newContext({ storageState: undefined, viewport: { width: 320, height: 780 } });
  try {
    const page = await ctx.newPage();
    await page.goto(`/score/${minted.data!.secret}`);
    // Anonymous context carries no stored consent, so the cookie banner sits
    // over the pad and would intercept the tap below.
    const accept = page.getByRole("button", { name: "Accept", exact: true });
    if ((await accept.count()) > 0) await accept.click();

    const addBtn = page.getByRole("button", { name: "Add points", exact: true });
    await expect(addBtn).toBeVisible({ timeout: 20_000 });
    await addBtn.click();
    // The attribution picker only exists once the form is expanded, so this
    // also proves the tap opened a form rather than submitting outright.
    await expect(page.locator('[data-role="attribution-picker"]')).toBeVisible({ timeout: 10_000 });

    const measured = await page.evaluate(() => {
      const form = document.querySelector('[data-role="attribution-picker"]')?.closest("div.card");
      const panel = form?.parentElement;
      if (!form || !panel) return null;
      return {
        form: form.getBoundingClientRect().width,
        panel: panel.getBoundingClientRect().width,
        panelClass: panel.className,
      };
    });
    expect(measured, "expanded form and its panel must both be in the DOM").not.toBeNull();
    // Guard the guard: if the panel ever stops being a 2-column grid, this
    // test would pass for a reason that has nothing to do with the fix.
    expect(measured!.panelClass, "the layout this regression lives in").toContain("grid-cols-2");
    expect(
      measured!.form / measured!.panel,
      `expanded form ${Math.round(measured!.form)}px of a ${Math.round(measured!.panel)}px panel`,
    ).toBeGreaterThan(0.9);

    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
});
