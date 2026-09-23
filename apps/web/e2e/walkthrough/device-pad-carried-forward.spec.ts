// WALKTHROUGH — scorer sheets §4.5: a courtside pad whose result has already
// moved the competition on stops offering controls the server will refuse.
//
// The scorer's story: a courtside phone holds a device link (`/score/{token}`,
// the QR on a printed sheet). While the match is live a tap lands. Then the
// competition moves on underneath the phone, and nothing tells the phone. Its
// next write is refused `403 RESULT_CARRIED_FORWARD` (`usecases/scoring.ts`,
// the device-link block), and the phone must leave for the View-only screen —
// a final scoreboard, no controls — rather than sit on controls whose every
// tap can only be refused. Two ways in, and the negative pair, one phone each:
//
// 1. THE SEAM — a REAL tap on the INNER pad (not the chrome's own button, not
//    a stubbed callback). This file is the ONLY proof of it (AGENTS.md class
//    1, the inert seam):
//
//      transport.ts   classifies the 403 as `rejected` carrying its code
//      use-pad-pipeline.ts   drops the write and sets `lastRejection`
//      v3/pad-host.tsx   sees a CHROME_TERMINAL_CODES member → `onTerminalRefusal`
//      registry.tsx   forwards the callback from `<ScorePad>` to the host
//      device-score-pad.tsx   switches to View-only and unmounts the pad
//
//    Each hop has a unit witness on its own side; none can see the hops meet.
//
// 2. THE NEGATIVE PAIR — an ORDINARY refusal (422 ALREADY_DECIDED) on the
//    inner pad of a phone of its own must NOT move the chrome: only
//    CHROME_TERMINAL_CODES end the surface. A host that forwarded every
//    refusal passes test 1 and fails this one.
//
// 3. THE FINAL SCOREBOARD — the chrome's own "Void my last entry", after the
//    match really ended elsewhere (a forfeit the organiser recorded) while the
//    phone's stream was stalled. View-only keeps the header as the FINAL
//    scoreboard (§4.5.3), so entering it re-reads the server; this proves that
//    read is real — through the browser's HTTP cache and `/state`'s ETag,
//    which no unit test with a mocked `apiV1` can see.
//
// HOW AN INNER-PAD TAP CAN MEET THE REFUSAL AT ALL (tests 1 and 2). Every tap
// makes the chrome re-read before the tap is even sent: the tap's PENDING
// envelope changes `pipeline.events`, `onEvents` fires, and `handlePadEvents`
// GETs `/state` — while the write itself waits out its soft-commit hold
// (`HOLD_MS`). A re-read that SUCCEEDS and sees the match over takes the pad
// away (`scoring` is false once finalized; `shouldMountPad` drops it once
// there is an outcome). The held write may still go out — its hold tick
// outlives the pad (queue.ts) — but its refusal comes back to a host that no
// longer exists, and nothing forwards it: the chrome is already on its settled
// screen, which is the product working. So a courtside tap meets the server's
// refusal only on a pad that stays mounted past its result — cricket's
// post-phase panel (`shouldMountPad` keeps a pad with a `phase: "post"`
// panel) — or when that re-read FAILS: venue Wi-Fi that drops the GET and
// lets the POST through. Tests 1 and 2 take the failed re-read on purpose:
// `stallStateReads` aborts the phone's `GET …/state` from the moment the
// match is flipped, and each test proves the tap's own re-read was TRIED (the
// premise) before it waits on the refusal.
//
// Without the stall these tests would stand on two accidents instead.
// `/state`'s ETag is the ledger seq alone (`fixtureStateEtag`), so after a
// status-only change a successful re-read revalidates to `304` and keeps the
// stale "in play" body — an earlier version of this file passed on exactly
// that. Measured against a status-aware ETag (review fix round 1): the
// negative pair's pad is then gone before its refusal arrives, so "View-only
// never appears" would hold for a host that forwards EVERY refusal; and test
// 1 survives only because of the accident below.
//
// THE SQL FLIPS ARE A SEAM PROOF, NOT A PRODUCT STATE. `decided` with the
// stage `complete` meets `carried-forward.ts`'s `stageComplete` rule, and
// `finalized` meets append-event's LOCKED statuses — but a flip appends no
// event and leaves `outcome` NULL: a decided match with no result, which no
// organiser action produces (and which the chrome's `decided`, "there is an
// outcome", does not even read as over). They steer the SERVER's verdict and
// nothing else; what the scorer is shown afterwards is test 3's job, whose
// forfeit is real (an event, an outcome, a seq that moves).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import {
  apiJson,
  expectNoHorizontalScroll,
  seedRosteredFixture,
  setFixtureStatusSql,
  setStageStatusSql,
  TAG,
} from "../helpers";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";

/** The copy the screen must say, read from the shipped dictionary (same idiom
 *  as `run-sheet.spec.ts`): a JSON-backed `src` import would stop this file
 *  collecting. */
const UI_EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const copy = (key: string): string => {
  const text = UI_EN[key];
  if (typeof text !== "string") throw new Error(`no "${key}" in en/ui.json`);
  return text;
};

/** A tap soft-commits: it is SENT only once `HOLD_MS` has run out. The ledger
 *  cannot show it before then, so this wait is the window plus the drain's own
 *  round trip on a loaded machine. Derived, never flat (AGENTS.md class 20). */
const SEND_MS = HOLD_MS + 15_000;

/** One page-level wait for a value to converge, and the pad's mount. */
const CONVERGE_MS = 20_000;
const MOUNT_MS = 20_000;
const SEED_MS = 60_000;

/** Per test, at most: seeding, the pad's mount and its first paint, two sent
 *  writes (the tap that lands, then the one refused) and six converges (the
 *  worst case is test 3: the pad's own score, the chrome's undo going live
 *  twice over — after the tap, and again once the stall is proven — the stall
 *  itself, the chrome's switch, the Live pill leaving) — expressed in the
 *  constants so none can move without the budget moving too. No poll-bound
 *  wait: nothing here waits on the stream's tick. The three-width capture
 *  waits on nothing. */
const BUDGET_MS = Math.max(180_000, SEED_MS + 2 * MOUNT_MS + 2 * SEND_MS + 6 * CONVERGE_MS);

/** The plan's UI bar: phone floor, tablet, desktop. */
const WIDTHS = [320, 768, 1280] as const;

/** The inner v3 pad's chassis. `/score/[token]` renders no `score-pad`
 *  wrapper, so the chassis root is the scope. */
const devicePad = (page: Page) => page.locator('[data-role="pad-v3"]');
const scorebug = (page: Page) => devicePad(page).locator('[data-role="v3-scorebug"]');

/** Scoped to `button` deliberately: a half renders EITHER a tappable `<button>`
 *  OR a plain `<div>` at the same grid position until the client re-renders
 *  from the fold (the badminton walkthrough's `half`, same shape). */
const half = (page: Page, side: "home" | "away") =>
  scorebug(page).locator(".grid > button").nth(side === "home" ? 0 : 1);

/** The pad's OWN running score for one side, as the scorer reads it. */
const halfScore = (page: Page, side: "home" | "away") =>
  scorebug(page)
    .locator(".grid > *")
    .nth(side === "home" ? 0 : 1)
    .locator(".app-display.font-bold");

/** The pad's refusal banner (`pad-host.tsx`, `pipeline.lastRejection`). */
const padRefusal = (page: Page) => devicePad(page).locator('[data-role="v3-rejection"]');

/** The chrome (`device-score-pad.tsx`): View-only, its LED header, its undo. */
const viewOnly = (page: Page) => page.getByTestId("scan-view-only");
const header = (page: Page) => page.locator("header");
const livePill = (page: Page) => header(page).getByText(copy("device.live"), { exact: true });
const voidMine = (page: Page) => page.getByTestId("device-void-mine");

async function ledgerTypes(request: APIRequestContext, fixtureId: string): Promise<string[]> {
  const res = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return (res.data ?? []).map((e) => e.type);
}

const countOf = async (request: APIRequestContext, fixtureId: string, type: string) =>
  (await ledgerTypes(request, fixtureId)).filter((t) => t === type).length;

/** One live badminton match with a device link, opened on an anonymous phone
 *  whose every write to this fixture is recorded with the server's answer —
 *  so a red can tell "the server never refused" from "it refused and the
 *  refusal went nowhere". `beforeMount` installs routes before the pad exists. */
async function openLinkedPhone(
  page: Page,
  browser: Browser,
  label: string,
  beforeMount: (device: Page) => Promise<void> = async () => undefined,
) {
  const fx = await seedRosteredFixture(page.request, {
    label: `${label} ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: `${label} Home ${TAG}` }],
    away: [{ fullName: `${label} Away ${TAG}` }],
    emitCoreStart: true,
  });
  const fixture = await apiJson<{ stage_id: string }>(page.request, `/api/v1/fixtures/${fx.fixtureId}`);
  expect(fixture.status, `fixture read: ${JSON.stringify(fixture.error)}`).toBe(200);
  const minted = await apiJson<{ secret: string }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/device-links`,
    "POST",
    {},
  );
  expect([200, 201], `mint device link: ${JSON.stringify(minted.error)}`).toContain(minted.status);

  // `consentedAnonymousState()`, not a bare `newContext()`: the latter inherits
  // the e2e organiser's cookie, so the "courtside device" would be signed in
  // and the device link irrelevant. The seeded consent also keeps the cookie
  // banner from mounting over the pad.
  const deviceCtx = await browser.newContext({ storageState: await consentedAnonymousState() });
  const device = await deviceCtx.newPage();
  const posts: { status: number; code: string | null }[] = [];
  let postsSent = 0;
  device.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname.endsWith(`/fixtures/${fx.fixtureId}/events`)) {
      postsSent += 1;
    }
  });
  device.on("response", async (res) => {
    if (res.request().method() !== "POST") return;
    if (!new URL(res.url()).pathname.endsWith(`/fixtures/${fx.fixtureId}/events`)) return;
    let code: string | null = null;
    try {
      code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? null;
    } catch {
      code = null;
    }
    posts.push({ status: res.status(), code });
  });
  await beforeMount(device);

  await device.goto(`/score/${minted.data!.secret}`);
  await expect(devicePad(device), "the v3 pad must render on the device link").toBeVisible({ timeout: MOUNT_MS });
  // Empty case first: a live link opens on its pad, never on View-only.
  await expect(viewOnly(device), "a live match must not open View-only").toHaveCount(0);
  await expect(halfScore(device, "home"), "the home half must open at nil").toHaveText("0", { timeout: MOUNT_MS });

  // The positive pair FIRST: while the match is live a tap lands.
  await half(device, "home").click();
  await expect(halfScore(device, "home"), "the tap must move the pad's own score").toHaveText("1", {
    timeout: CONVERGE_MS,
  });
  await expect
    .poll(() => countOf(page.request, fx.fixtureId, "badminton.rally"), {
      timeout: SEND_MS,
      message: "the positive pair: an in-play tap must land",
    })
    .toBe(1);
  await expect(viewOnly(device), "a tap that LANDED must not switch screens").toHaveCount(0);
  // The chrome has re-read the landed tap (its undo needs the row's real id,
  // and is greyed while a re-read is in flight): no re-read of the live match
  // is still on the wire to answer AFTER a test flips it underneath.
  await expect(voidMine(device), "the chrome must have re-read the landed tap").toBeEnabled({
    timeout: CONVERGE_MS,
  });

  /** Waits for the server to have answered one of this phone's writes with
   *  exactly `status`/`code`. Polled: the listener parses each body
   *  asynchronously. `SEND_MS`, because an inner-pad tap is only sent once its
   *  soft-commit hold runs out. */
  const refusedWith = async (status: number, code: string) => {
    const since = Date.now();
    try {
      await expect
        .poll(() => posts.some((p) => p.status === status && p.code === code), { timeout: SEND_MS })
        .toBe(true);
    } catch {
      // Say what DID happen: every answer this phone got, and what its pad
      // is showing — "no POST at all" and "a POST answered otherwise" are
      // different defects.
      const banner = (await padRefusal(device).allInnerTexts()).join(" | ") || "(none)";
      throw new Error(
        `the server must have refused a write ${status} ${code} within ${Date.now() - since}ms; ` +
          `device POSTs sent ${postsSent}, answered: ${JSON.stringify(posts)}; pad banner: ${banner}; ` +
          `pad mounted: ${await devicePad(device).count()}`,
      );
    }
  };

  return { fx, stageId: fixture.data!.stage_id, deviceCtx, device, refusedWith };
}

/** The failed re-read (see the header): every `GET /api/v1/fixtures/{id}/state`
 *  this phone makes from now on is dropped on the wire — the chrome's
 *  `resync()` and the pad's own reconciliation both swallow that, as they must
 *  on venue Wi-Fi. Returns how many were dropped, so a test can prove the
 *  tap's re-read was really TRIED: if a future chrome stops re-reading on a
 *  pending tap, the premise of the refusal tests is gone and they must say so
 *  rather than pass on something else. */
async function stallStateReads(device: Page): Promise<() => number> {
  let dropped = 0;
  await device.route(
    (url) => url.pathname.startsWith("/api/v1/fixtures/") && url.pathname.endsWith("/state"),
    (route) => {
      dropped += 1;
      return route.abort();
    },
  );
  return () => dropped;
}

/** A tap's own re-read was attempted, and failed. */
async function expectReReadDropped(stateReadsDropped: () => number, before: number) {
  await expect
    .poll(stateReadsDropped, {
      timeout: CONVERGE_MS,
      message: "the tap must make the chrome re-read (onEvents → handlePadEvents → GET /state)",
    })
    .toBeGreaterThan(before);
}

test("a real inner-pad tap refused RESULT_CARRIED_FORWARD moves the device to View-only", async ({
  page,
  browser,
}) => {
  test.setTimeout(BUDGET_MS);
  const { fx, stageId, deviceCtx, device, refusedWith } = await openLinkedPhone(page, browser, "Carried");
  try {
    // ---- the competition moves on underneath the courtside pad ---------------
    // By SQL (a seam proof — see the header): no ledger event and no push, so
    // nothing tells the phone. The phone's re-reads fail from here on, so the
    // tap below re-reads nothing either — the stale courtside screen the
    // refusal exists for. This pad has never seen any other refusal.
    const stateReadsDropped = await stallStateReads(device);
    await setFixtureStatusSql(fx.fixtureId, "decided");
    await setStageStatusSql(stageId, "complete");
    await expect(devicePad(device), "precondition: nothing told the phone — the pad is still up").toBeVisible();

    // ---- a REAL tap on the INNER pad ------------------------------------------
    const droppedBefore = stateReadsDropped();
    await half(device, "home").click();
    await expectReReadDropped(stateReadsDropped, droppedBefore);

    // The server's answer first, so a broken hop reads as itself: "refused
    // RESULT_CARRIED_FORWARD, and the chrome never moved" is the inert-seam
    // signature (the pad's own banner is all that would show).
    await refusedWith(403, "RESULT_CARRIED_FORWARD");
    await expect(
      viewOnly(device),
      "the refusal must reach the chrome: pipeline → registry → onTerminalRefusal → View-only",
    ).toBeVisible({ timeout: CONVERGE_MS });
    await expect(viewOnly(device), "View-only says why, in the scorer's words").toHaveText(
      copy("device.scan.viewOnly.carried"),
    );
    await expect(devicePad(device), "View-only leaves no pad to tap").toHaveCount(0, { timeout: CONVERGE_MS });
    await expect(voidMine(device), "…and no chrome undo, which the server would refuse the same way").toHaveCount(0);
    await expect(header(device).locator("p.font-mono"), "the scoreboard stays on screen").toBeVisible();

    expect(await countOf(page.request, fx.fixtureId, "badminton.rally"), "and nothing was written").toBe(1);
  } finally {
    await deviceCtx.close();
  }
});

test("an ordinary inner-pad refusal (422 ALREADY_DECIDED) never moves the device to View-only", async ({
  page,
  browser,
}) => {
  test.setTimeout(BUDGET_MS);
  const { fx, deviceCtx, device, refusedWith } = await openLinkedPhone(page, browser, "Ordinary");
  try {
    // A finalized fixture is not "carried forward" (`SETTLED_OPEN_STATUSES`);
    // its writes are refused `ALREADY_DECIDED` (append-event.ts's LOCKED
    // statuses). Same failed re-read as test 1, so the refusal comes back to
    // a pad that is still THERE: without it a working re-read takes the pad
    // away first (`scoring` is false once finalized), the refusal lands on no
    // host at all, and this test would pass for a host that forwards EVERY
    // refusal (measured — see the header).
    const stateReadsDropped = await stallStateReads(device);
    await setFixtureStatusSql(fx.fixtureId, "finalized");
    const droppedBefore = stateReadsDropped();
    await half(device, "home").click();
    await expectReReadDropped(stateReadsDropped, droppedBefore);
    await refusedWith(422, "ALREADY_DECIDED");

    // The sync point, neutral on purpose: the refusal has been TAKEN — shown
    // on the pad's own banner, or (the defect) turned into View-only. Neither
    // showing means it reached no one, and the negative below would be
    // vacuous, so that fails here instead. Two frames later the host's effect
    // has run on it, and only then is "no View-only" a real answer: only
    // CHROME_TERMINAL_CODES end the surface.
    await expect(
      padRefusal(device).or(viewOnly(device)).first(),
      "the refusal must have been taken — on the pad's banner, or by the chrome",
    ).toBeVisible({ timeout: CONVERGE_MS });
    await device.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
    );
    await expect(viewOnly(device), "an ordinary refusal must not move the chrome to View-only").toHaveCount(0);
    expect(await countOf(page.request, fx.fixtureId, "badminton.rally"), "and nothing was written").toBe(1);
  } finally {
    await deviceCtx.close();
  }
});

test("the chrome's own undo, refused after the match ended elsewhere, lands on View-only under the FINAL scoreboard", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(BUDGET_MS);
  // Stall the INNER pad's stream, both transports, before it mounts: the
  // forfeit below must not reach this phone. Same two stubs as
  // `device-pad-stalled-pipeline.spec.ts` — the realtime door, and the pad's
  // poll told apart from the chrome's own `resync()` by cursor (the chrome
  // always asks `since_seq=0`, and stays reachable throughout).
  let padPollsBlocked = 0;
  const { fx, stageId, deviceCtx, device, refusedWith } = await openLinkedPhone(
    page,
    browser,
    "Final",
    async (d) => {
      await d.route("**/api/v1/public/fixtures/*/realtime-token", (route) => route.abort());
      await d.route(
        (url) => url.pathname.endsWith("/events") && url.searchParams.has("since_seq"),
        (route, request) => {
          if (new URL(request.url()).searchParams.get("since_seq") === "0") return route.continue();
          padPollsBlocked += 1;
          return route.abort();
        },
      );
    },
  );
  try {
    // ---- the match ends somewhere else, and the competition moves on --------
    // A real ledger event (the seq moves), recorded by the organiser.
    const state = await apiJson<{ last_seq: number }>(page.request, `/api/v1/fixtures/${fx.fixtureId}/state`);
    expect(state.status, `state read: ${JSON.stringify(state.error)}`).toBe(200);
    const forfeit = await apiJson(page.request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type: "core.forfeit",
      payload: { by: fx.homeEntrantId, reason: "no-show" },
      idempotency_key: crypto.randomUUID(),
    });
    expect(forfeit.status, `the organiser's forfeit: ${JSON.stringify(forfeit.error)}`).toBe(201);
    // The carried-forward rule this fixture now meets (`carried-forward.ts`'s
    // `stageComplete`). A settled one-match stage may already have completed
    // itself; setting it again is harmless.
    await setStageStatusSql(stageId, "complete");

    await expect
      .poll(() => padPollsBlocked, {
        timeout: CONVERGE_MS,
        message: "the pad never tried to poll, so its stall is unproven",
      })
      .toBeGreaterThan(0);
    await expect(livePill(device), "precondition: nothing reached the phone — its header still says Live").toBeVisible();
    await expect(voidMine(device), "precondition: the link's own rally still offers its undo").toBeEnabled({
      timeout: CONVERGE_MS,
    });

    // ---- the scorer presses the chrome's own undo ---------------------------
    await voidMine(device).click();
    await refusedWith(403, "RESULT_CARRIED_FORWARD");
    await expect(viewOnly(device), "the chrome's own refused write must move it to View-only").toBeVisible({
      timeout: CONVERGE_MS,
    });
    await expect(viewOnly(device)).toHaveText(copy("device.scan.viewOnly.carried"));
    await expect(voidMine(device), "View-only offers no undo").toHaveCount(0);
    await expect(devicePad(device), "…and no pad").toHaveCount(0);

    // The final scoreboard (§4.5.3): the header is the one thing left, and it
    // is FINAL — nothing reached this phone, so until View-only re-read the
    // server it said "Live" over a match that had ended.
    await expect(livePill(device), "no Live pill above 'Match over'").toHaveCount(0, { timeout: CONVERGE_MS });
    await expect(header(device), "the header carries the server's settled status").toContainText(
      copy("score.status.forfeited"),
    );
    expect(await countOf(page.request, fx.fixtureId, "core.void"), "and nothing was written").toBe(0);

    // ---- the View-only screen at the three UI widths (RULES) -----------------
    // No horizontal page scroll, and the control set at every width is the
    // one View-only promises: NONE. Pinned as the empty list at each width,
    // not as "320 equals 1280" — two empty lists are equal, and so are two
    // identical wrong ones. Captured for the report; the assertions gate.
    for (const w of WIDTHS) {
      await device.setViewportSize({ width: w, height: 800 });
      await expect(viewOnly(device), `${w}: View-only stays up`).toBeVisible();
      await expectNoHorizontalScroll(device);
      const box = await viewOnly(device).boundingBox();
      expect(box, `${w}: the View-only line has a box`).not.toBeNull();
      expect(box!.width, `${w}: the View-only line fits the viewport`).toBeLessThanOrEqual(w);
      const buttons = (await device.getByRole("button").allInnerTexts()).map((b) => b.trim());
      expect(buttons, `${w}: View-only offers no controls at all`).toEqual([]);
      const path = testInfo.outputPath(`view-only-carried-${w}.png`);
      await device.screenshot({ path, animations: "disabled" });
      await testInfo.attach(`view-only-carried-${w}`, { path, contentType: "image/png" });
    }
  } finally {
    await deviceCtx.close();
  }
});
