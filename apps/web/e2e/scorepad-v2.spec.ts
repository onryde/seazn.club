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
    // The wicket surface is hand-rolled BUTTONS — `ThisOverGroup` builds it
    // itself and never routes through `action-form.tsx`, so there is no
    // `<select>` and no `[data-role="confirm"]` here (football's goal DOES go
    // through ActionForm, which is why the same selector is right there and
    // wrong here). The flow is: Wicket -> kind -> [which batter, only when the
    // kind is ambiguous] -> fielder, and picking the fielder submits.
    //
    // Nothing below is wrapped in `.catch()`. A swallowed step would leave the
    // flagship "credited to a named fielder" assertion passing over a UI it
    // never actually drove.
    await pad(page).getByRole("button", { name: "Wicket", exact: true }).click();
    await pad(page).getByRole("button", { name: "Caught", exact: true }).click();

    // Only some dismissal kinds ask which batter is out (a run-out can take
    // either end); a catch cannot, so this step is conditional by design
    // rather than by defensiveness — and it asserts by NAME, which also pins
    // that the picker resolves personNames rather than drawing a raw id.
    const outChoice = pad(page).getByRole("button", { name: `Striker ${TAG}`, exact: true });
    if ((await outChoice.count()) > 0) await outChoice.first().click();

    await pad(page).getByRole("button", { name: `Fielder ${TAG}`, exact: true }).click();

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
    await goalRow.locator('[data-role="void"]').click();

    await expect
      .poll(
        async () => (await ledger(page.request, own.fixtureId)).filter((e) => e.type === "core.void").length,
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(1);

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
