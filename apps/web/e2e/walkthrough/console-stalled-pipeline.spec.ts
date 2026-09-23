// WALKTHROUGH — W3: the console must not depend on the pad's pipeline for its
// own freshness. Its chrome refresh is the floor under every stall.
//
// The organiser's story this plays: a match is being scored somewhere else (a
// second official's device, the API, a co-organiser's tab). The organiser's
// console has the fixture open, but its embedded pad's stream is DEAD — the
// token door 403s on a Community plan, or a websocket joined and died. Today
// the chrome serves stale state with no upper bound: `fixture-console.tsx` has
// no interval and no focus/visibility listener, so every refresh it performs is
// downstream of the pad (`handlePadEvents`) or of an action the organiser took
// here (`send()` / `resync()`). The organiser switches tabs, comes back, and
// the score is still yesterday's.
//
// The stall is induced at the NETWORK layer rather than by unmounting the pad,
// because that is the shape the defect takes in production: the pad is still
// mounted and still rendered, its stream is simply not delivering.
//
// ---------------------------------------------------------------------------
// Why the pad's POLL is aborted for the whole test, and never un-routed
// ---------------------------------------------------------------------------
// Aborting the realtime token door does not silence the pad — `use-fixture-
// stream.ts` catches that failure and falls back to `setInterval(fetchOnce,
// POLL_MS)` at 15s (its own `startPolling()`). That poll reaches the pad, the
// pad fires `onEvents`, and the console's `handlePadEvents` calls `resync()`.
// So a test that blocks the transports, restores them, and then waits 20s for
// the headline to move is satisfied by the 15-second poll and passes with NO
// production fix at all. `WALKTHROUGH_SPECS`' own note beside
// `console-device-live-sync.spec.ts` records this exact class: "without that
// clause every such test is satisfied by the 15-second poll".
//
// This spec closes it by discriminating rather than by racing the clock. The
// two consumers of `/events` have different signatures:
//
//   the console's `resync()`  -> GET /events?since_seq=0   (always 0; it
//                                re-reads the WHOLE ledger — fixture-console
//                                .tsx's `resync`)
//   the pad's stream poll     -> GET /events?since_seq=N   (N = `ledgerTipSeq`
//                                of what it already holds — use-pad-pipeline
//                                .ts's `sinceSeq`; 1 here, because the fixture
//                                is seeded with `core.start`)
//
// So `since_seq=0` is let through for the entire test and every other value is
// aborted forever. The pad's pipeline can therefore NEVER deliver, at any
// point, which removes the poll as an explanation for anything observed below.
// Nothing is un-routed, and no assertion depends on beating a timer.
//
// That the console's endpoint is reachable the whole time is what makes the
// precondition sharp: the console is not blocked from refreshing, it simply
// never chooses to — until the operator returns to the tab.
//
// And if the pad ever DID poll with `since_seq=0`, it would learn the rally,
// fire `handlePadEvents`, and move the headline before the visibility flip —
// which the precondition below asserts does not happen. The discriminator is
// therefore self-guarding rather than assumed.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG } from "../helpers";

/** The console's OWN running score. `header p.font-mono` is this repo's
 *  established locator for it (`scorepad-v3-period-pair.spec.ts`,
 *  `gallery.capture.ts`) — the `<p>` that renders `summary.headline` in
 *  `fixture-console.tsx`'s scoreline header. It is driven by `live`, which
 *  ONLY `resync()` sets, and it is asserted to resolve to exactly one element
 *  before anything is read from it: a headline locator that matched nothing
 *  would make every assertion below vacuous. */
const headline = (page: Page) => page.locator("header p.font-mono");

/** The PAD's scorebug — a different surface with a different source of truth
 *  (the pad's own pipeline, not the console's `live`). Read only to prove the
 *  pad stayed dark while the console refreshed. */
const padScorebug = (page: Page) =>
  page.locator('[data-testid="score-pad"] [data-role="v3-scorebug"]').first();

async function padScoreText(page: Page): Promise<string> {
  const text = await padScorebug(page).innerText().catch(() => "");
  return text.replace(/\s+/g, " ").trim();
}

/** The engine's OWN headline for the fixture right now. Derived from the source
 *  of truth on every read rather than typed into this file as a table: badminton's
 *  `summary.headline` is `setsWon.home — setsWon.away` plus a parenthesised live
 *  set score, so one rally moves it from "0 — 0" to "0 — 0 (1–0)" and a literal
 *  "1" would never have matched it (AGENTS.md failure class 19). */
async function serverHeadline(request: APIRequestContext, fixtureId: string): Promise<string> {
  const res = await apiJson<{ last_seq: number; summary: { headline?: string } | null }>(
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

test("a console whose pad stream is dead still refreshes when the operator returns", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const fx = await seedRosteredFixture(page.request, {
    label: `W3 Console Stall ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: `W3 Stall Home ${TAG}` }],
    away: [{ fullName: `W3 Stall Away ${TAG}` }],
    emitCoreStart: true,
  });

  // ---- kill the pad's pipeline, BOTH transports, before it mounts ----------
  //
  // `abort` and not a stub response: a stalled pipeline is silence, and a 500
  // would exercise an error path this test is not about.

  // 1. The realtime door. With this dead, `use-fixture-stream.ts` falls back to
  //    its 15s poll — which (2) then blocks.
  await page.route("**/api/v1/public/fixtures/*/realtime-token", (route) => route.abort());

  // 2. The events endpoint, discriminated by cursor (see the header comment).
  //    A URL PREDICATE, not a glob: Playwright's glob treats `?` as a
  //    single-character wildcard, so `events?since_seq=*` is ambiguous about
  //    the one character that separates a path from its query. Reading
  //    `searchParams` cannot be ambiguous.
  const padPollsBlocked: string[] = [];
  let consoleResyncs = 0;
  let phase = "mount";
  const resyncPhases: string[] = [];
  await page.route(
    (url) => url.pathname.endsWith("/events") && url.searchParams.has("since_seq"),
    (route, request) => {
      const since = new URL(request.url()).searchParams.get("since_seq");
      if (since === "0") {
        // The console's own `resync()`. Reachable for the whole test.
        consoleResyncs += 1;
        resyncPhases.push(phase);
        return route.continue();
      }
      // The pad's stream poll. Dead for the whole test.
      padPollsBlocked.push(String(since));
      return route.abort();
    },
  );

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(page.locator('[data-testid="score-pad"]')).toBeVisible({ timeout: 20_000 });

  // The headline locator must resolve to exactly one element. Asserted, not
  // assumed: this is the anti-vacuity check for every `toHaveText` below.
  await expect(headline(page), "the console headline locator must match exactly one element").toHaveCount(1);

  const before = await serverHeadline(page.request, fx.fixtureId);
  await expect(headline(page), "the console should open on the engine's current headline").toHaveText(
    before,
    { timeout: 20_000 },
  );
  // ---- let the pad settle, and prove its pipeline really is stalled -------
  //
  // Done BEFORE the rally is posted, deliberately. The pad fires `onEvents`
  // once at mount as it adopts its server bootstrap, and the console's
  // `handlePadEvents` answers that with a `resync()` — a real, expected refresh
  // that carries the PRE-rally ledger. Waiting for the pad's first (blocked)
  // poll puts a full 15s `POLL_MS` cycle between that mount churn and the
  // window this test measures, so a late bootstrap resync cannot drift into it
  // and be mistaken for the seam under test.
  //
  // The wait is not decoration either: it pins that the pad TRIED to poll and
  // was refused, which is the production shape. Without it, "the pad never
  // delivered" could equally mean the pad was never polling in the first place.
  await expect
    .poll(() => padPollsBlocked.length, {
      timeout: 45_000,
      message: "the pad's stream poll never fired, so this test never simulated a stalled pipeline",
    })
    .toBeGreaterThan(0);

  // The console is now at rest: whatever it did at mount, it is finished.
  // Everything counted from here is attributable to this test's own actions.
  const resyncsAtRest = consoleResyncs;
  await page.waitForTimeout(2_500);
  expect(consoleResyncs, `the console is still churning at rest (resyncs: ${resyncPhases.join(",")})`).toBe(
    resyncsAtRest,
  );
  await expect(headline(page), "the console should still show the pre-rally headline").toHaveText(before);

  phase = "after-rally";
  const padBefore = await padScoreText(page);

  // ---- a score arrives from somewhere else entirely -----------------------
  //
  // A second official's device / the API. `wonBy` is an ENTRANT ID, not the
  // literal "home": setbased/kernel.ts's `sideOf` resolves the payload against
  // `state.entrants` and refuses anything else with `unknown entrant`.
  const post = await apiJson(page.request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
    expected_seq: await lastSeq(page.request, fx.fixtureId),
    type: "badminton.rally",
    payload: { wonBy: fx.homeEntrantId },
  });
  expect(post.status, `the foreign rally was refused: ${JSON.stringify(post.error)}`).toBeLessThan(300);

  const after = await serverHeadline(page.request, fx.fixtureId);
  // The differential this test exists to witness. If one rally did not move the
  // engine's own headline there is nothing here to observe and every assertion
  // below would pass in both states.
  expect(after, "one rally must move the engine's headline, or this test cannot witness a refresh").not.toBe(
    before,
  );

  // ---- PRECONDITION: the console has NOT learned the score ----------------
  //
  // This is what makes everything after it non-vacuous. The console's own
  // endpoint has been reachable this entire time, yet nothing here calls
  // `resync()` — so the chrome is stale with no upper bound. If this ever
  // fails, some OTHER path is refreshing the console and the seam below is not
  // what is being measured.
  await page.waitForTimeout(2_500);
  expect(
    consoleResyncs,
    `nothing should have resynced the console after the rally (resyncs: ${resyncPhases.join(",")})`,
  ).toBe(resyncsAtRest);
  await expect(headline(page), "the console must still be stale — its pad stream is dead").toHaveText(before);

  // ---- the operator switches away -----------------------------------------
  phase = "hidden";
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  // A HIDDEN tab must not fetch. This is the case that kills the mutant which
  // drops the `visibilityState !== "visible"` early return: with that guard
  // gone the listener resyncs on the hide too, and `consoleResyncs` is 1 here.
  // Counted rather than timed — an observed request, not a slept-through window.
  await page.waitForTimeout(2_500);
  expect(consoleResyncs, `a hidden tab must not fetch (resyncs: ${resyncPhases.join(",")})`).toBe(resyncsAtRest);
  await expect(headline(page), "a hidden tab must not refresh the chrome").toHaveText(before);

  // ---- ...and comes back. This is the seam under test. --------------------
  phase = "visible";
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect(
    headline(page),
    `the console never refreshed on its own (pad polls blocked: [${padPollsBlocked.join(",")}])`,
  ).toHaveText(after, { timeout: 20_000 });
  expect(consoleResyncs, "the refresh must have come from the console's own resync").toBeGreaterThan(
    resyncsAtRest,
  );

  // ---- and it got there WITHOUT the pad ------------------------------------
  //
  // The pad is still mounted, still rendered, and still knows nothing: its
  // pipeline never delivered. That is the whole point — the console's freshness
  // is now independent of it, which is the floor this task adds.
  expect(await padScoreText(page), "the pad must still be dark — the refresh did not come through it").toBe(
    padBefore,
  );
});
