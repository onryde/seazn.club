import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  apiJson,
  fixturePath,
  seedRosteredFixture,
  expectNoHorizontalScroll,
  TAG,
  type RosteredFixture,
} from "./helpers";

// S12/#421 W10 — the v2 scoring pad driven through the REAL entry points,
// with the `scorepad-v2` flag on, against REAL rosters.
//
// WHY THIS FILE EXISTS SEPARATELY FROM scorepad-skins.spec.ts: that file
// drives S10's dev-only harness route, whose client lineups are permanently
// SYNTHETIC ("h-1"/"h-2"/"a-1"…). Every `cricket.ball` carries
// striker/nonStriker/bowler and `football.goal` carries scorer/assist, and the
// server folds those against the fixture's REAL lineup and 422s on a person it
// cannot find on the pitch — so cricket had no browser coverage at all and
// football's goal could only ever be driven side-only. S11 recorded both as
// owed to this session. S13 deletes the harness, so this is the last session
// in which the two can be compared at all.
//
// HOW THE FLAG IS ON: the server under test is started with
// `SCOREPAD_V2_FORCE=1` (lib/scorepad-flag.ts). PostHog is unconfigured in
// every local and CI browser run, so `isServerFeatureEnabled` returns its
// `fallback` — which must be `false` — and without the override the v2 pad is
// unreachable from any e2e. The flag-OFF half of the byte-identity bar runs
// the v1 specs against a SECOND server on another port with
// `SCOREPAD_V2_FORCE=0`; see the session's PR body for both invocations.

test.describe.configure({ mode: "serial" });

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
): Promise<{ seq: number; type: string; payload: Record<string, unknown> }[]> {
  const res = await apiJson<{ seq: number; type: string; payload: Record<string, unknown> }[]>(
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

/** Set this over's striker / non-striker / bowler. The three selects are in
 *  the skin's own "This over" panel, in that order. */
async function setOverPeople(
  page: Page,
  people: { striker: string; nonStriker: string; bowler: string },
): Promise<void> {
  const selects = pad(page).locator('[data-role="cricket-this-over"] select');
  await expect(selects).toHaveCount(3);
  await selects.nth(0).selectOption(people.striker);
  await selects.nth(1).selectOption(people.nonStriker);
  await selects.nth(2).selectOption(people.bowler);
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
    await openLiveConsole(page, fx);

    const striker = fx.personIds[`Striker ${TAG}`]!;
    const nonStriker = fx.personIds[`NonStriker ${TAG}`]!;
    const bowler = fx.personIds[`Bowler ${TAG}`]!;
    const fielder = fx.personIds[`Fielder ${TAG}`]!;

    // The person pickers must show NAMES. Before this session they rendered
    // raw UUIDs (cricket-skin's `displayPerson` returned its argument), which
    // is unusable courtside and is asserted here so it cannot regress
    // silently — the coverage sweep cannot see option TEXT, only layout data.
    const strikerSelect = pad(page).locator('[data-role="cricket-this-over"] select').first();
    await expect(strikerSelect.locator(`option[value="${striker}"]`)).toHaveText(
      `Striker ${TAG}`,
    );

    await setOverPeople(page, { striker, nonStriker, bowler });

    // Five legal deliveries plus ONE wide. The wide is the point: it does not
    // advance `ballInOver`, so an over containing one is six legal balls
    // across seven events — the exact arithmetic a pad gets wrong if it
    // counts taps instead of legal balls.
    for (const runs of ["1", "0", "2", "0", "4"]) {
      await pad(page).getByRole("button", { name: runs, exact: true }).click();
      await page.waitForTimeout(250);
    }
    await pad(page).getByRole("button", { name: "Wide", exact: true }).click();
    await page.waitForTimeout(250);

    const afterOver = await ledger(page.request, fx.fixtureId);
    const balls = afterOver.filter((e) => e.type === "cricket.ball");
    expect(balls.length, "five runs plus one wide = six cricket.ball events").toBe(6);

    const wide = balls.find(
      (b) => (b.payload.runs as { extras?: { kind?: string } } | undefined)?.extras?.kind === "wide",
    );
    expect(wide, "the wide must reach the ledger as a real extras payload").toBeTruthy();

    // Every ball must carry the REAL roster ids. This is the assertion the
    // harness route could never make: synthetic lineups 422 here.
    for (const b of balls) {
      expect(b.payload.striker).toBe(striker);
      expect(b.payload.nonStriker).toBe(nonStriker);
      expect(b.payload.bowler).toBe(bowler);
    }

    // A caught dismissal, credited to a fielder who is a real member of the
    // fielding side.
    await pad(page).getByRole("button", { name: "Wicket", exact: true }).click();
    await page.waitForTimeout(500);
    const wicketForm = pad(page).locator('[data-role="cricket-skin"]');
    await wicketForm.getByRole("combobox").filter({ hasText: /caught|bowled/i }).first()
      .selectOption("caught")
      .catch(() => undefined);
    await page.waitForTimeout(250);
    await pad(page).locator('[data-role="confirm"]').click();

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
    expect(wicket.out).toBe(striker);
    expect(wicket.fielder, "the dismissal must be credited to a REAL fielder").toBe(fielder);
  });

  test("undo goes through the pad's own timeline and the ledger records the void", async ({
    page,
  }) => {
    await page.goto(await fixturePath(page.request, fx.fixtureId));
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });

    const before = await ledger(page.request, fx.fixtureId);
    const lastScoring = [...before].reverse().find((e) => e.type === "cricket.ball")!;

    // The timeline is the pad's OWN undo, wired to the pipeline's `submit` in
    // this session. Before it, `timeline.tsx` was imported by nothing and
    // could not be wired by any caller, so the only undo was the v1 chrome's
    // — which S13 deletes, and which cannot work offline.
    const timeline = pad(page).locator('[data-role="timeline"]');
    await expect(timeline).toBeVisible();
    await timeline.locator('[data-role="void"]').first().click();

    await expect
      .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "core.void").length, {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(1);

    const voidEvent = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "core.void")!;
    expect(voidEvent.seq).toBeGreaterThan(lastScoring.seq);
  });

  test("no horizontal scroll at 375 or 320", async ({ page }) => {
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(await fixturePath(page.request, fx.fixtureId));
      await expect(pad(page)).toBeVisible({ timeout: 20_000 });
      await expectNoHorizontalScroll(page);
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

    await pad(page).getByRole("button", { name: /Goal/, exact: false }).first().click();
    await page.waitForTimeout(500);

    // Names, not ids — football-skin labelled its scorer/assist options with
    // the raw person id before this session.
    const attribution = pad(page).locator('[data-role="football-attribution"], [data-role="skin-attribution"]').first();
    await expect(attribution).toBeVisible();
    await expect(attribution).toContainText(`Scorer ${TAG}`);

    await attribution.locator(`[data-value="${scorer}"]`).first().click().catch(async () => {
      await attribution.getByRole("combobox").first().selectOption(scorer);
    });
    await attribution.locator(`[data-value="${assist}"]`).first().click().catch(async () => {
      await attribution.getByRole("combobox").nth(1).selectOption(assist);
    });
    await pad(page).locator('[data-role="confirm"]').click();

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
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });

    const scoreButton = page.getByRole("button", { name: /Add|Point|Score/i }).first();
    await expect(scoreButton).toBeVisible();

    // Land one online first, so the offline batch is provably additive rather
    // than the whole ledger.
    await scoreButton.click();
    await expect
      .poll(async () => (await fixtureState(request, fx.fixtureId)).last_seq, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);
    const seqBeforeOffline = (await fixtureState(request, fx.fixtureId)).last_seq;

    // Context-level network kill, as the brief mandates. Safe here precisely
    // because this scenario never navigates again — `setOffline(true)` blocks
    // every request from the page including a reload's own document fetch.
    await anonCtx.setOffline(true);
    for (let i = 0; i < 3; i += 1) {
      await scoreButton.click();
      await page.waitForTimeout(200);
    }

    const dbName = `scorepad-v2-${fx.fixtureId}`;
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
