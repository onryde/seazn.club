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
import { padPollMs } from "../realtime-propagation-kit";

/** The pad's stream tick, read from `use-fixture-stream.ts`'s own declaration.
 *  Every "the console stayed stale" window below is measured against it. */
const POLL_MS = padPollMs();

/** This spec waits out TWO full poll cycles (one to prove the pad is polling
 *  and blocked, one to span a stale window after the rally), plus seeding, a
 *  page load and a handful of round trips. Derived so that moving `POLL_MS`
 *  moves the budget with it instead of leaving a flat literal that reds in a
 *  way whose obvious repair is to delete it (AGENTS.md failure class 20). */
const BUDGET_MS = Math.max(180_000, 90_000 + 2 * POLL_MS);

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

/** Forfeit — one of the controls `padSyncing` gates (`fixture-console.tsx`
 *  passes `busy || padSyncing` into `ForfeitButton`'s `disabled`). Chosen over
 *  a ledger row's Void because it renders unconditionally on a live fixture,
 *  where Void is gated on `canVoid`. `busy` is false throughout the window
 *  below — no send of ours is in flight — so `padSyncing` is the only thing
 *  that can disable it, which is what makes it a clean probe for the flag. */
const forfeit = (page: Page) => page.locator('[data-testid="score-forfeit"]');

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
  test.setTimeout(BUDGET_MS);

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
  // Held open for the `padSyncing` check near the end — 0 for the rest of the
  // run, so nothing before it pays the cost.
  let resyncHoldMs = 0;
  await page.route(
    (url) => url.pathname.endsWith("/events") && url.searchParams.has("since_seq"),
    async (route, request) => {
      const since = new URL(request.url()).searchParams.get("since_seq");
      if (since === "0") {
        // The console's own `resync()`. Reachable for the whole test.
        consoleResyncs += 1;
        resyncPhases.push(phase);
        if (resyncHoldMs > 0) await new Promise((r) => setTimeout(r, resyncHoldMs));
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
      // Poll-bound: it waits for the FIRST tick of `POLL_MS`, so the budget is
      // that interval plus slack for a loaded machine — never a flat literal.
      timeout: POLL_MS * 2 + 15_000,
      message: "the pad's stream poll never fired, so this test never simulated a stalled pipeline",
    })
    .toBeGreaterThan(0);

  // The console is now at rest: whatever it did at mount, it is finished.
  // Everything counted from here is attributable to this test's own actions.
  // Flat window for the same reason as the hidden case below: this drains
  // mount-time churn, whose cost is a round trip, and a full `POLL_MS` cycle
  // has ALREADY elapsed above (that is what the blocked poll we just waited on
  // means), so the slow path is spanned before this line is reached.
  const resyncsAtRest = consoleResyncs;
  await page.waitForTimeout(2_500);
  expect(consoleResyncs, `the console is still churning at rest (resyncs: ${resyncPhases.join(",")})`).toBe(
    resyncsAtRest,
  );
  await expect(headline(page), "the console should still show the pre-rally headline").toHaveText(before);

  // The pad scorebug must RESOLVE before its text is used as a baseline.
  // `padScoreText` swallows a locator miss to "", so without this a moved
  // `[data-role="v3-scorebug"]` would make `padBefore === "" === after` and the
  // "the pad must still be dark" assertion at the end would pass vacuously —
  // the same anti-vacuity guard the headline locator gets above.
  await expect(padScorebug(page), "the pad scorebug locator must match exactly one element").toHaveCount(1);
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
  // Label and baseline both move HERE, after the write has actually landed.
  // Captured any earlier and a poll arriving during the `lastSeq` GET or the
  // POST itself (~100-200ms) would satisfy the "a poll fired after the rally"
  // wait below without a single cycle having elapsed — and the phase label,
  // which is what makes M7's kill attributable, would name the wrong step.
  phase = "after-rally";
  const pollsAtRally = padPollsBlocked.length;

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
  //
  // WAITS FOR AN OBSERVED POLL, NOT A FLAT WINDOW. This negative assertion
  // claims "no independent path refreshes this console", and the slowest such
  // path in the file is the pad's stream tick, `POLL_MS` (15s). A flat 2.5s
  // window would not span it, so it would report "nothing refreshed" having
  // never given the thing it is proving absent a chance to fire (AGENTS.md
  // failure class 20: a flat budget beside a derived cost).
  //
  // Blocking on the OBSERVED poll rather than sleeping `POLL_MS` is deliberate
  // even though the constant is readable (`padPollMs()`, above): a sleep
  // assumes the pad is ticking, while waiting for the request PROVES it, and
  // the two differ exactly when the pad is broken — which is the state this
  // spec induces on purpose. Measured at 12 894ms in practice: one cycle less
  // the settle window already spent above.
  await expect
    .poll(() => padPollsBlocked.length, {
      // Poll-bound, same derivation as the first wait.
      timeout: POLL_MS * 2 + 15_000,
      message: "no pad poll fired after the rally, so the stale window was never actually spanned",
    })
    .toBeGreaterThan(pollsAtRally);
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
  //
  // A FLAT window is correct HERE, unlike the precondition above. What this
  // proves absent is a listener's SYNCHRONOUS answer to an event dispatched on
  // the line before — its cost is one `resync()` round trip (~100-300ms against
  // a local server), not a poll interval, so 2.5s is an order of magnitude of
  // headroom over the thing being excluded. Stretching it to `POLL_MS` would
  // not make it stricter, it would just misdescribe the mechanism. And it is
  // bracketed by a positive control: if the listener were simply dead, the
  // `visible` assertion that follows would fail, so this cannot pass by the
  // listener never working at all.
  await page.waitForTimeout(2_500);
  expect(consoleResyncs, `a hidden tab must not fetch (resyncs: ${resyncPhases.join(",")})`).toBe(resyncsAtRest);
  await expect(headline(page), "a hidden tab must not refresh the chrome").toHaveText(before);

  // ---- ...and comes back. This is the seam under test. --------------------
  //
  // The refresh must go through `handlePadEvents`, not `resync()` directly:
  // only the former raises `padSyncing`, which gates Undo/Void/Forfeit and
  // every ledger row while the ledger is half-refreshed. Acting inside that
  // window sends a stale `expected_seq` and earns a 409 SEQ_CONFLICT on what
  // should have been a clean undo (`padSyncing`'s own doc in
  // fixture-console.tsx records the incident). This listener fires exactly
  // when the operator is back at the keyboard, so it is the MOST reachable
  // moment for that window, not the least.
  //
  // The resync is held open so the window is observable at all; without the
  // hold it closes in one round trip and no assertion could catch it.
  const HOLD_MS = 6_000;
  resyncHoldMs = HOLD_MS;

  // The positive pair: Forfeit is live BEFORE the return. Without this, a
  // build that disabled Forfeit permanently would satisfy the disabled-check
  // below while proving nothing (AGENTS.md: a negative assertion needs its
  // positive).
  await expect(forfeit(page), "Forfeit should be live before the operator returns").toBeEnabled();

  phase = "visible";
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  // `setPadSyncing(true)` runs synchronously in the handler, before the fetch,
  // so this lands well inside the hold. A build that calls `resync()` directly
  // never raises the flag and leaves Forfeit enabled — which is exactly the
  // mutant this assertion exists to kill.
  // This assertion is tripped by TWO distinct regressions, so its message names
  // both: the listener may be gone entirely (no refresh at all — mutant M6), or
  // present but calling `resync()` directly and so raising no flag. Observed
  // failure text is identical in both cases, which is why the next line of
  // triage is the headline assertion below: it still moves under the second and
  // does not under the first.
  await expect(
    forfeit(page),
    "the controls stayed live through the return: either no listener fired at all, or it called `resync()` directly and bypassed the `padSyncing` gate",
  ).toBeDisabled({ timeout: HOLD_MS - 2_000 });

  await expect(
    headline(page),
    `the console never refreshed on its own (pad polls blocked: [${padPollsBlocked.join(",")}])`,
  ).toHaveText(after, { timeout: 20_000 });
  expect(consoleResyncs, "the refresh must have come from the console's own resync").toBeGreaterThan(
    resyncsAtRest,
  );

  // ...and the gate REOPENS. `handlePadEvents` clears `padSyncing` in a
  // `finally`, so a refresh that failed or never settled cannot leave the
  // operator staring at permanently dead controls — which would be a worse
  // defect than the staleness this task set out to fix.
  await expect(forfeit(page), "the controls never came back after the resync settled").toBeEnabled({
    timeout: 20_000,
  });

  // ---- and it got there WITHOUT the pad ------------------------------------
  //
  // The pad is still mounted, still rendered, and still knows nothing: its
  // pipeline never delivered. That is the whole point — the console's freshness
  // is now independent of it, which is the floor this task adds.
  expect(await padScoreText(page), "the pad must still be dark — the refresh did not come through it").toBe(
    padBefore,
  );

  // ---- the SECOND listener: window focus ----------------------------------
  //
  // Appended rather than folded into the flips above, which are untouched: they
  // are what kill M6, M7 and the `resync()`-direct bypass, and reshaping them to
  // carry a second trigger would put all three verdicts back in question.
  //
  // WHY THE EVENT IS DISPATCHED RATHER THAN DRIVEN FROM THE OS, and why that is
  // not a fixture proving a fixture. `focus` here is isolated ON PURPOSE: the
  // production guard only refreshes when the tab reads visible, so a `focus`
  // that arrives alongside a visibility transition cannot be told apart from
  // the transition itself. A genuine tab return via `bringToFront()` fires
  // `visibilitychange` AND `focus` together, so it would prove "a real return
  // refreshes" — already proven above — while leaving the `focus` registration
  // untested, which is exactly the gap this case exists to close. There is no
  // way to make the browser fire a bare window focus with the tab already
  // visible from inside this harness.
  //
  // What makes it honest anyway: only the TRIGGER is simulated. `focus` is a
  // real event type the browser genuinely fires on `window`, the dispatch runs
  // through the browser's own event system, and the CONSUMER is the untouched
  // production `window.addEventListener("focus", ...)` in fixture-console.tsx.
  // Neither end is a stand-in — which is the same standing this file's
  // `visibilitychange` dispatch already has, and that one killed two mutants.
  //
  // What it does NOT prove, stated rather than implied: that a real OS-level
  // window focus reaches the page. Nothing here can prove that, and M8's status
  // should be read with that caveat.
  phase = "focus";
  const resyncsBeforeFocus = consoleResyncs;
  resyncHoldMs = 0; // no gate window needed here; that seam is proven above

  // A third score arrives while the operator is away from the window.
  const post2 = await apiJson(page.request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
    expected_seq: await lastSeq(page.request, fx.fixtureId),
    type: "badminton.rally",
    payload: { wonBy: fx.homeEntrantId },
  });
  expect(post2.status, `the second rally was refused: ${JSON.stringify(post2.error)}`).toBeLessThan(300);

  const after2 = await serverHeadline(page.request, fx.fixtureId);
  expect(after2, "the second rally must move the headline again").not.toBe(after);

  // Precondition, same shape as the first: still stale, nothing refreshed it.
  // A flat window is right here — the pad's poll has been aborted for the whole
  // run and proven so twice above, so the only live refresh paths are the two
  // listeners, and both answer within a round trip.
  await page.waitForTimeout(2_500);
  expect(
    consoleResyncs,
    `nothing should have resynced the console before the focus (resyncs: ${resyncPhases.join(",")})`,
  ).toBe(resyncsBeforeFocus);
  await expect(headline(page), "the console must still be stale before the window is focused").toHaveText(
    after,
  );

  // The operator clicks back into the window. No visibility transition — the
  // tab was never hidden this time.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
  });

  await expect(
    headline(page),
    "the focus listener never refreshed the console — `window.addEventListener(\"focus\")` is inert",
  ).toHaveText(after2, { timeout: 20_000 });
  expect(
    consoleResyncs,
    `the focus refresh must have come from the console's own resync (resyncs: ${resyncPhases.join(",")})`,
  ).toBeGreaterThan(resyncsBeforeFocus);
});
