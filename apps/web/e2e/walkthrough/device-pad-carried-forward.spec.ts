// WALKTHROUGH — scorer sheets §4.5: a courtside pad whose result has already
// moved the competition on stops offering controls the server will refuse.
//
// The scorer's story: a courtside phone holds a device link (`/score/{token}`,
// the QR on a printed sheet). While the match is live a tap lands. Then the
// competition moves on underneath the phone, and nothing tells the phone. Its
// next write is refused `403 RESULT_CARRIED_FORWARD` (`usecases/scoring.ts`,
// the device-link block), and the phone must leave for the View-only screen —
// a final scoreboard, no controls — rather than sit on controls whose every
// tap can only be refused. There are two ways in, one test each:
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
// 2. THE FINAL SCOREBOARD — the chrome's own "Void my last entry", after the
//    match really ended elsewhere (a forfeit the organiser recorded) while the
//    phone's stream was stalled. View-only keeps the header as the FINAL
//    scoreboard (§4.5.3), so entering it re-reads the server; this proves that
//    read is real — through the browser's HTTP cache and `/state`'s ETag,
//    which no unit test with a mocked `apiV1` can see.
//
// WHY TEST 1 FLIPS STATUS BY SQL AND TEST 2 DOES NOT. Test 1 needs the inner
// pad still mounted when it taps. A real ending (a ledger event) makes the
// chrome re-read on that very tap (`onEvents` → `handlePadEvents`), see the
// match decided and unmount the pad before its soft-committed write is sent —
// so a SQL flip, with no event and no push, is what keeps a tappable pad in
// front of the refusal. The cost: `/state`'s ETag is the ledger seq
// (`fixtureStateEtag`), so after a SQL-only flip the browser revalidates to
// `304` and keeps the old "in play" body — test 1's header can never become
// final, for a reason no user can produce. Hence test 2, with a real event.
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

/** Per test, at most: seeding, a mount, three sent writes (the tap that lands,
 *  the ordinary refusal, the carried-forward one) and four converges (the
 *  pad's own score, the chrome's switch, the pad leaving, the header's
 *  re-read) — expressed in the constants so none can move without the budget
 *  moving too. No poll-bound wait: nothing here waits on the stream's tick.
 *  The three-width capture waits on nothing. */
const BUDGET_MS = Math.max(180_000, SEED_MS + MOUNT_MS + 3 * SEND_MS + 4 * CONVERGE_MS);

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

test("a real inner-pad tap refused RESULT_CARRIED_FORWARD moves the device to View-only", async ({
  page,
  browser,
}) => {
  test.setTimeout(BUDGET_MS);
  const { fx, stageId, deviceCtx, device, refusedWith } = await openLinkedPhone(page, browser, "Carried");
  try {
    // ---- the negative pair: an ORDINARY refusal on the inner pad -------------
    // A finalized fixture is not "carried forward" (`SETTLED_OPEN_STATUSES`);
    // its writes are refused `ALREADY_DECIDED` (append-event.ts). The pad says
    // so in its own banner, and the chrome must NOT leave: only
    // CHROME_TERMINAL_CODES end the surface. If the host forwarded every
    // refusal, the pad would be gone and the carried-forward tap below could
    // not happen at all.
    await setFixtureStatusSql(fx.fixtureId, "finalized");
    await half(device, "home").click();
    await refusedWith(422, "ALREADY_DECIDED");
    await expect(padRefusal(device), "an ordinary refusal shows on the pad's own banner").toBeVisible({
      timeout: CONVERGE_MS,
    });
    await expect(viewOnly(device), "…and does not move the chrome to View-only").toHaveCount(0);

    // ---- the competition moves on underneath the courtside pad ---------------
    // SQL, so NO ledger event and NO push: the inner pad stays mounted and
    // live, exactly the stale courtside screen the refusal exists for.
    await setFixtureStatusSql(fx.fixtureId, "decided");
    await setStageStatusSql(stageId, "complete");
    await expect(devicePad(device), "precondition: nothing told the phone — the pad is still up").toBeVisible();
    await expect(viewOnly(device), "the ordinary refusal above left the chrome where it was").toHaveCount(0);

    // ---- a REAL tap on the INNER pad ------------------------------------------
    await half(device, "home").click();

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
    // No horizontal page scroll, and the SAME control set (membership and
    // order) at 320 as at 1280 — a phone view that differs is a defect, not a
    // layout. Captured for the report; the assertions are what gate.
    const perWidth: { w: number; buttons: string[] }[] = [];
    for (const w of WIDTHS) {
      await device.setViewportSize({ width: w, height: 800 });
      await expect(viewOnly(device), `${w}: View-only stays up`).toBeVisible();
      await expectNoHorizontalScroll(device);
      const box = await viewOnly(device).boundingBox();
      expect(box, `${w}: the View-only line has a box`).not.toBeNull();
      expect(box!.width, `${w}: the View-only line fits the viewport`).toBeLessThanOrEqual(w);
      perWidth.push({ w, buttons: (await device.getByRole("button").allInnerTexts()).map((b) => b.trim()) });
      const path = testInfo.outputPath(`view-only-carried-${w}.png`);
      await device.screenshot({ path, animations: "disabled" });
      await testInfo.attach(`view-only-carried-${w}`, { path, contentType: "image/png" });
    }
    expect(perWidth[0]!.buttons, "same controls, same order at 320 and 1280").toEqual(perWidth[2]!.buttons);
  } finally {
    await deviceCtx.close();
  }
});
