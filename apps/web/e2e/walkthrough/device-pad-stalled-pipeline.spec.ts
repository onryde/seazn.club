// WALKTHROUGH — G1: the device-link pad must not depend on its own pipeline
// for its chrome's freshness. The same floor W3 gave the console
// (`console-stalled-pipeline.spec.ts`), on the surface that belongs to the
// person actually SCORING.
//
// The scorer's story this plays: a courtside phone holds a device link
// (`/score/{token}`). Its inner pad's stream is DEAD — the realtime token door
// refused it, or a websocket joined and died, or the drain wedged — and a
// score lands from somewhere else (the organiser's console, a second official,
// the API). Before G1, every refresh `device-score-pad.tsx` performed was its
// own `send()` or its inner pad's ledger change (`handlePadEvents`), both
// downstream of the pipeline that stalled, so the scorer's header stayed on
// the old score with no upper bound. The scorer looks away, looks back, and it
// is still wrong.
//
// The stall is induced at the NETWORK layer rather than by unmounting the
// pad: in production the pad is still mounted and rendered, its stream is
// simply not delivering.
//
// ---------------------------------------------------------------------------
// Why the pad's POLL is aborted for the whole test, and never un-routed
// ---------------------------------------------------------------------------
// Aborting the realtime token door does not silence the pad — it promotes it
// to `use-fixture-stream.ts`'s 15s poll fallback. That poll reaches the pad,
// the pad fires `onEvents`, and `handlePadEvents` refreshes the chrome. So a
// naive version of this test — block the door, wait for the header to move —
// is satisfied by the poll and passes with NO fix at all.
//
// This spec closes that by discriminating on the CURSOR, the technique
// `console-stalled-pipeline.spec.ts` established. The two consumers of
// `/events` on this page have different signatures:
//
//   the chrome's `resync()`  -> GET /events?since_seq=0   (always 0 — it
//                               re-reads the WHOLE ledger; device-score-pad
//                               .tsx's `resync`)
//   the inner pad's poll     -> GET /events?since_seq=N   (N = the COUNT of
//                               what it holds, use-pad-pipeline.ts's
//                               `sinceSeq`; 2 here — `core.start` and this
//                               link's own rally)
//
// `since_seq=0` is let through for the entire test and every other value is
// aborted forever, so the pad's pipeline can NEVER deliver and the poll is
// removed as an explanation for anything observed below. Nothing is un-routed,
// and no assertion depends on beating a timer. If the pad ever DID poll with
// `since_seq=0`, it would learn the foreign rally and move the header before
// the visibility flip — which the precondition asserts does not happen — so
// the discriminator is self-guarding rather than assumed.
import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, seedRosteredFixture, TAG } from "../helpers";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { padPollMs } from "../realtime-propagation-kit";

const BASE = process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000";

/** The pad's stream tick, read from `use-fixture-stream.ts`'s own declaration. */
const POLL_MS = padPollMs();

/** A wait that is BOUND to that tick: it waits for the next observed pad poll,
 *  so its worst case is one full cycle (two, if the first lands just before
 *  the wait starts) plus slack for a loaded machine. Derived, so moving
 *  `POLL_MS` moves every such wait with it. */
const POLL_WAIT_MS = POLL_MS * 2 + 15_000;

/** A listener's SYNCHRONOUS answer to an event dispatched on the line before —
 *  one `resync()` round trip, ~100-300ms locally. A flat window is correct for
 *  THAT and only that; nothing slower is ever proven absent with it. */
const SETTLE_MS = 2_500;

/** The refresh's own abort budget, read from the declaration the device pad
 *  imports (`fixture-console.tsx`) — the `padPollMs()` idiom. Not an import:
 *  that module drags JSON-backed src into the e2e loader. Not a typed copy:
 *  the hold below is only valid relative to this number, and a copy would go
 *  on assuming yesterday's. */
function opportunisticResyncMs(): number {
  const url = new URL("../../src/components/v2/fixture-console.tsx", import.meta.url);
  const m = readFileSync(url, "utf8").match(/^export const OPPORTUNISTIC_RESYNC_MS\s*=\s*([0-9_]+)\s*;/m);
  if (!m) {
    throw new Error(
      "OPPORTUNISTIC_RESYNC_MS's declaration shape changed in components/v2/fixture-console.tsx — " +
        "update this reader. Do NOT replace it with a literal: the hold below is derived from it.",
    );
  }
  const ms = Number(m[1]!.replace(/_/g, ""));
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`OPPORTUNISTIC_RESYNC_MS read from fixture-console.tsx is not a usable budget: "${m[1]}"`);
  }
  return ms;
}
const RESYNC_BUDGET_MS = opportunisticResyncMs();

/** Headroom the HELD refresh still needs inside that budget once released —
 *  the route's `continue()`, the server round trip and a render, ~100-300ms
 *  locally; 4s is an order of magnitude over on a loaded machine. A hold that
 *  ate into it would have the bound abort the very refresh under test, and
 *  the header would never move: a red that reads as "no refresh at all". */
const HOLD_HEADROOM_MS = 4_000;

/** How long the chrome's refresh is held open so the `padSyncing` window is
 *  observable at all (without it the window closes in one round trip).
 *  DERIVED from the budget (review round 1 — it was a flat 6s beside a 10s
 *  budget, so lowering the budget to 5s would have aborted every held
 *  refresh). */
const HOLD_MS = RESYNC_BUDGET_MS - HOLD_HEADROOM_MS;
// The gate check waits `HOLD_MS - 2_000`; under ~1s of that, the window is too
// short to observe honestly. Refused here, by name, rather than as a flaky
// `toBeDisabled` three minutes in. The unit floor in
// `device-score-pad-freshness-floor.test.tsx` (>= 8s) keeps this unreachable.
if (HOLD_MS < 3_000) {
  throw new Error(
    `OPPORTUNISTIC_RESYNC_MS (${RESYNC_BUDGET_MS}ms) leaves only ${HOLD_MS}ms to hold the padSyncing ` +
      `window open after ${HOLD_HEADROOM_MS}ms of headroom — too short to observe the gate.`,
  );
}

/** One page-level wait for a value to converge, and the pad's mount. */
const CONVERGE_MS = 20_000;
const MOUNT_MS = 20_000;
const SEED_MS = 60_000;

/** Two poll-bound waits, three settle windows, one hold, four converges
 *  (mount headline, refresh, gate reopening, focus refresh), seeding and a
 *  mount. Expressed in the constants so that none of them can move without
 *  the budget moving too (AGENTS.md failure class 20). */
const BUDGET_MS = Math.max(
  180_000,
  SEED_MS + MOUNT_MS + 2 * POLL_WAIT_MS + 3 * SETTLE_MS + HOLD_MS + 4 * CONVERGE_MS,
);

/** The device chrome's OWN running score: the `<p class="font-mono …">` in
 *  `device-score-pad.tsx`'s LED header, driven by `live`, which only
 *  `resync()` sets. Asserted to resolve to exactly one element before anything
 *  is read from it — a locator that matched nothing would make every
 *  assertion below vacuous. */
const headline = (page: Page) => page.locator("header p.font-mono");

/** The inner v3 pad's chassis. `/score/[token]` renders no `score-pad`
 *  wrapper, so the chassis root is the scope (`console-device-live-sync
 *  .spec.ts` records the same fact). */
const devicePad = (page: Page) => page.locator('[data-role="pad-v3"]');

/** "Void my last entry" — the device link's own control, gated by
 *  `busy || padSyncing`. It renders only while this LINK has a voidable event
 *  of its own, which is why the seed below writes one rally through the link.
 *  `busy` is false throughout (no send of this pad is in flight), so
 *  `padSyncing` is the only thing that can disable it: a clean probe for the
 *  flag. */
const voidMine = (page: Page) => page.locator('[data-testid="device-void-mine"]');

/** The header renders `summary.headline` split on " · " with a separator span
 *  between groups, so its text content drops the spaces around each "·".
 *  Folded the same way here, so the comparison holds even once a headline
 *  grows a closed set. */
const asRendered = (h: string) => h.split(" · ").join("·");

async function serverHeadline(request: APIRequestContext, fixtureId: string): Promise<string> {
  const res = await apiJson<{ summary: { headline?: string } | null }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(res.status, `state read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return String(res.data?.summary?.headline ?? "");
}

async function lastSeq(request: APIRequestContext, fixtureId: string): Promise<number> {
  const res = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(res.status, `state read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data!.last_seq;
}

/** A score that arrives from SOMEWHERE ELSE — the organiser's own session,
 *  standing in for the console, a second official or the API. `wonBy` is an
 *  entrant ID: setbased/kernel.ts's `sideOf` refuses anything else. */
async function foreignRally(request: APIRequestContext, fixtureId: string, wonBy: string): Promise<void> {
  const post = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: await lastSeq(request, fixtureId),
    type: "badminton.rally",
    payload: { wonBy },
  });
  expect(post.status, `the foreign rally was refused: ${JSON.stringify(post.error)}`).toBeLessThan(300);
}

test("a device-link pad whose stream is dead still refreshes when the scorer returns", async ({
  page,
  browser,
  playwright,
}) => {
  test.setTimeout(BUDGET_MS);

  const fx = await seedRosteredFixture(page.request, {
    label: `G1 Device Stall ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: `G1 Stall Home ${TAG}` }],
    away: [{ fullName: `G1 Stall Away ${TAG}` }],
    emitCoreStart: true,
  });

  const minted = await apiJson<{ secret: string }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/device-links`,
    "POST",
    { label: `G1 Court ${TAG}` },
  );
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);
  const secret = minted.data!.secret;

  // ---- one rally written THROUGH the link ---------------------------------
  //
  // So "Void my last entry" renders: it lists only events THIS link recorded.
  // A request context with no cookies at all — `playwright.request
  // .newContext()` inherits `use.storageState`, so an organiser cookie would
  // otherwise ride along and the event could be attributed to the session.
  const dlApi = await playwright.request.newContext({
    baseURL: BASE,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
  });
  try {
    const own = await dlApi.post(`/api/v1/fixtures/${fx.fixtureId}/events`, {
      data: {
        expected_seq: await lastSeq(page.request, fx.fixtureId),
        type: "badminton.rally",
        payload: { wonBy: fx.homeEntrantId },
      },
    });
    expect(own.status(), `the link's own rally was refused: ${await own.text()}`).toBe(201);
  } finally {
    await dlApi.dispose();
  }

  // `consentedAnonymousState()`, not a bare `newContext()`: the latter inherits
  // the e2e organiser's cookie, so the "courtside device" would be signed in
  // and the device link would be irrelevant. The seeded consent also keeps the
  // cookie banner from mounting over the pad mid-test.
  const deviceCtx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const device = await deviceCtx.newPage();

    // ---- kill the pad's pipeline, BOTH transports, before it mounts --------
    //
    // `abort` and not a stub response: a stalled pipeline is silence, and a
    // 500 would exercise an error path this test is not about.

    // 1. The realtime door. With it dead the pad falls back to its poll...
    let tokenDoorAborts = 0;
    await device.route("**/api/v1/public/fixtures/*/realtime-token", (route) => {
      tokenDoorAborts += 1;
      return route.abort();
    });

    // 2. ...which is blocked here, discriminated by cursor. A URL PREDICATE,
    //    not a glob: Playwright's glob treats `?` as a single-character
    //    wildcard, so reading `searchParams` is the unambiguous form.
    const padPollsBlocked: string[] = [];
    let chromeResyncs = 0;
    let phase = "mount";
    const resyncPhases: string[] = [];
    let resyncHoldMs = 0;
    await device.route(
      (url) => url.pathname.endsWith("/events") && url.searchParams.has("since_seq"),
      async (route, request) => {
        const since = new URL(request.url()).searchParams.get("since_seq");
        if (since === "0") {
          // The device chrome's own `resync()`. Reachable for the whole test.
          chromeResyncs += 1;
          resyncPhases.push(phase);
          if (resyncHoldMs > 0) await new Promise((r) => setTimeout(r, resyncHoldMs));
          return route.continue();
        }
        // The inner pad's stream poll. Dead for the whole test.
        padPollsBlocked.push(String(since));
        return route.abort();
      },
    );

    await device.goto(`/score/${secret}`);
    await expect(devicePad(device), "the v3 pad must render on the device link").toBeVisible({
      timeout: MOUNT_MS,
    });

    await expect(headline(device), "the device headline locator must match exactly one element").toHaveCount(1);
    await expect(voidMine(device), "the link's own rally must offer 'Void my last entry'").toHaveCount(1);

    const before = await serverHeadline(page.request, fx.fixtureId);
    await expect(headline(device), "the device should open on the engine's current headline").toHaveText(
      asRendered(before),
      { timeout: CONVERGE_MS },
    );

    // ---- let the pad settle, and prove its pipeline really is stalled -----
    //
    // Before the foreign rally, deliberately. The pad fires `onEvents` once at
    // mount as it adopts its bootstrap, and `handlePadEvents` answers with a
    // PRE-rally resync. Waiting for the pad's first blocked poll puts a whole
    // poll cycle between that churn and the window measured below. It also
    // pins that the pad TRIED to poll and was refused — without it, "the pad
    // never delivered" could equally mean it was never polling.
    await expect
      .poll(() => padPollsBlocked.length, {
        timeout: POLL_WAIT_MS,
        message: "the pad's stream poll never fired, so this test never simulated a stalled pipeline",
      })
      .toBeGreaterThan(0);
    expect(tokenDoorAborts, "the pad never asked the realtime door, so the stall is not the production shape").toBeGreaterThan(0);

    // At rest: whatever mount did, it is finished. A flat window is right here
    // — it drains mount-time churn (a round trip), and a full poll cycle has
    // already elapsed above.
    const resyncsAtRest = chromeResyncs;
    await device.waitForTimeout(SETTLE_MS);
    expect(chromeResyncs, `the device chrome is still churning at rest (resyncs: ${resyncPhases.join(",")})`).toBe(
      resyncsAtRest,
    );
    await expect(headline(device)).toHaveText(asRendered(before));

    // ---- a score arrives from somewhere else ------------------------------
    await foreignRally(page.request, fx.fixtureId, fx.homeEntrantId);
    // Label and baseline move HERE, after the write has landed, so a poll that
    // fires during the POST cannot satisfy "a poll fired after the rally".
    phase = "after-rally";
    const pollsAtRally = padPollsBlocked.length;

    const after = await serverHeadline(page.request, fx.fixtureId);
    // The differential this test exists to witness: if the rally did not move
    // the engine's headline, every assertion below passes in both states.
    expect(after, "one rally must move the engine's headline, or this test cannot witness a refresh").not.toBe(
      before,
    );

    // ---- PRECONDITION: the device has NOT learned the score ---------------
    //
    // Waits for an OBSERVED pad poll, not a flat window: this negative claims
    // "no independent path refreshes this chrome", and the slowest such path
    // is the pad's tick. A 2.5s sleep would never have given it a chance.
    await expect
      .poll(() => padPollsBlocked.length, {
        timeout: POLL_WAIT_MS,
        message: "no pad poll fired after the rally, so the stale window was never actually spanned",
      })
      .toBeGreaterThan(pollsAtRally);
    expect(
      chromeResyncs,
      `nothing should have resynced the device chrome after the rally (resyncs: ${resyncPhases.join(",")})`,
    ).toBe(resyncsAtRest);
    await expect(headline(device), "the device must still be stale — its pad stream is dead").toHaveText(
      asRendered(before),
    );

    // ---- the scorer looks away --------------------------------------------
    phase = "hidden";
    await device.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // A HIDDEN tab must not fetch — `visibilitychange` fires on the hide too.
    // Counted, and bracketed by the positive control below: if the listener
    // were simply dead, the `visible` assertions would fail, so this cannot
    // pass by the listener never working at all.
    await device.waitForTimeout(SETTLE_MS);
    expect(chromeResyncs, `a hidden tab must not fetch (resyncs: ${resyncPhases.join(",")})`).toBe(resyncsAtRest);
    await expect(headline(device), "a hidden tab must not refresh the chrome").toHaveText(asRendered(before));

    // ---- ...and looks back. This is the seam under test. ------------------
    //
    // Through `handlePadEvents`, never `resync()` directly: only the former
    // raises `padSyncing`, which greys "Void my last entry" while the ledger
    // is half-refreshed. Acting inside that window sends a stale
    // `expected_seq` and earns a 409 SEQ_CONFLICT on what should have been a
    // clean void — and this listener fires exactly when the scorer is back at
    // the pad. The refresh is held open so the window is observable at all.
    resyncHoldMs = HOLD_MS;

    // The positive pair: live BEFORE the return, so a build that disabled it
    // permanently cannot satisfy the disabled-check below.
    await expect(voidMine(device), "'Void my last entry' should be live before the scorer returns").toBeEnabled();

    phase = "visible";
    await device.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Tripped by TWO distinct regressions, so the message names both: no
    // listener at all (the header below never moves either), or a listener
    // that calls `resync()` directly (the header below DOES move). The next
    // assertion is the triage.
    await expect(
      voidMine(device),
      "the controls stayed live through the return: either no listener fired at all, or it called `resync()` directly and bypassed the `padSyncing` gate",
    ).toBeDisabled({ timeout: HOLD_MS - 2_000 });

    await expect(
      headline(device),
      `the device chrome never refreshed on its own (pad polls blocked: [${padPollsBlocked.join(",")}])`,
    ).toHaveText(asRendered(after), { timeout: CONVERGE_MS });
    expect(chromeResyncs, "the refresh must have come from the chrome's own resync").toBeGreaterThan(resyncsAtRest);

    // ...and the gate REOPENS: `handlePadEvents` clears `padSyncing` in a
    // `finally`, so the scorer is never left on permanently dead controls.
    await expect(voidMine(device), "the controls never came back after the resync settled").toBeEnabled({
      timeout: CONVERGE_MS,
    });

    // NOT asserted: that the inner pad's own scorebug stayed dark. It did —
    // the chrome's resync reaches `live`/`events`, not the inner pad, which is
    // fed its server bootstrap — but that split is the device-side twin of
    // G2 (the console's floor refreshes its header, not its EMBEDDED pad), an
    // open owner decision. Pinning it here as the expected value would freeze
    // a known gap. Attribution does not need it: the pad's only two
    // transports were aborted for the whole run (counted above), and the
    // refresh is counted on the chrome's own `since_seq=0` read.

    // ---- the SECOND listener: window focus --------------------------------
    //
    // Dispatched rather than driven from the OS, on purpose: the handler only
    // refreshes a VISIBLE tab, so a focus that arrives with a visibility
    // transition cannot be told apart from the transition itself. Only the
    // TRIGGER is simulated — `focus` is a real event the browser fires on
    // `window`, dispatched through the browser's own event system, and the
    // consumer is the untouched production listener. What this cannot prove
    // is that a real OS-level focus reaches the page.
    phase = "focus";
    const resyncsBeforeFocus = chromeResyncs;
    resyncHoldMs = 0;

    await foreignRally(page.request, fx.fixtureId, fx.homeEntrantId);
    const after2 = await serverHeadline(page.request, fx.fixtureId);
    expect(after2, "the second foreign rally must move the headline again").not.toBe(after);

    // Still stale, nothing refreshed it. A flat window is right here: the
    // pad's poll has been aborted throughout and proven so twice, so the only
    // live refresh paths are the two listeners, each answering in a round trip.
    await device.waitForTimeout(SETTLE_MS);
    expect(
      chromeResyncs,
      `nothing should have resynced the device chrome before the focus (resyncs: ${resyncPhases.join(",")})`,
    ).toBe(resyncsBeforeFocus);
    await expect(headline(device), "the device must still be stale before the window is focused").toHaveText(
      asRendered(after),
    );

    // The scorer taps back into the window. No visibility transition — the
    // tab was never hidden this time.
    await device.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await expect(
      headline(device),
      'the focus listener never refreshed the device chrome — `window.addEventListener("focus")` is inert',
    ).toHaveText(asRendered(after2), { timeout: CONVERGE_MS });
    expect(
      chromeResyncs,
      `the focus refresh must have come from the chrome's own resync (resyncs: ${resyncPhases.join(",")})`,
    ).toBeGreaterThan(resyncsBeforeFocus);
  } finally {
    await deviceCtx.close();
  }
});
