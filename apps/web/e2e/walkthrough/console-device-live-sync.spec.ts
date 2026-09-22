// A console and a handed courtside device, both open on the same match, must
// stay in step — in BOTH directions, and fast enough that a scorer and an
// organiser never disagree about the score while looking at each other.
//
// Read `README.md` in this folder first.
//
// WHAT THIS DRIVES, AND WHY IT HAD NO COVERAGE.
// `docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md` §6b
// surveyed the four realtime propagation flows in the product and found three
// with nothing at all behind them. This file owns two of them:
//
//   (a) the device-link pad writes -> the ORGANISER'S SCREEN reflects it.
//       Two existing specs hold a console page open while a device writes
//       (`scorepad-v3-r7-console-chrome.spec.ts`, `scorepad-v3-cricket.spec.ts`)
//       and then poll the ledger over the API. The API always agrees; that is
//       not the question. Neither ever re-reads the console's DOM, so the one
//       thing a person in the room would notice is the one thing nothing
//       asserted.
//
//   (b) the console writes -> the DEVICE-LINK PAD reflects it. No spec
//       anywhere had written from the console with a device pad already
//       mounted. In r7 the console's `core.start` is recorded BEFORE the link
//       is minted and the device opened, so what the device displays arrived
//       on its initial page load — a fact about SSR, not about the stream.
//
// BOTH DIRECTIONS IN ONE TEST, deliberately. The premise of (b) is "a device
// pad that is already mounted when the console writes"; the premise of (a) is
// the mirror. Splitting them would mean seeding and booting two pads twice to
// prove one thing each, and neither half would be able to observe the other
// end already being live. One test, two clearly separated measurements, each
// with its own clause.
//
// THE CLAUSE, which is the whole point. Each direction asserts the watching
// screen moved AND that it moved in LESS than the pad's own poll interval.
// Without that second half a propagation test is satisfied by the 15-second
// polling fallback, and would have gone on passing straight through the
// defect this wave exists to fix — a device-link pad that asked for its
// realtime token anonymously, was refused, and silently downgraded to poll
// with no error anywhere. `POLL_MS` is re-derived from
// `scorepad/use-fixture-stream.ts` rather than typed, so re-timing the poll
// moves this file with it.
//
// WHICH AUTHORISATION BRANCH EACH END USES (`realtime-token/route.ts:23-25`,
// `eligible = fixtureRealtimeEligible || isFixtureOfficial || <device link>`):
//   - the CONSOLE is the organiser, so `isFixtureOfficial` grants it,
//     regardless of plan or visibility;
//   - the DEVICE holds no cookie, so its grant is `fixtureRealtimeEligible`
//     (this fixture's competition is public and its org is the shared Pro
//     org) OR its `Bearer dl_`. This file does NOT isolate which — the header
//     it presents is asserted, and `device-links.spec.ts`'s own private-
//     competition tests are what pin the device-link branch in isolation.
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG } from "../helpers";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import {
  assertPropagatedUnderPoll,
  expectObservableIdle,
  measurePropagation,
  padPollMs,
  watchFixtureRealtime,
} from "../realtime-propagation-kit";

const POLL_MS = padPollMs();

// THE BUDGET IS DERIVED, never a flat literal beside costs that can move.
// A blown Playwright budget reports itself as a DATA defect: the runner
// prints whichever `expect.poll` happened to be in flight above the timeout
// line, so an over-tight number here would surface as "the console never saw
// the goal" — a claim about the product that is really a claim about the
// clock. `HOLD_MS` is env-tunable (`NEXT_PUBLIC_SCOREPAD_HOLD_MS`, pinned
// short in CI) and BAKED INTO THE BROWSER BUNDLE at build time, so it is
// imported rather than guessed.
const SEED_MS = 60_000; // persons, competition, division, lineups, generate, start
const MOUNT_MS = 25_000; // one pad boot — paid twice, console then device
const TAPS = 3; // Start match, the device's goal, the console's goal
const TAP_SLACK_MS = 4_000; // open the dock, press Send now, and the POST itself
/** The "did it arrive AT ALL" bound for one direction, deliberately wider
 *  than a single tick: two poll intervals plus slack, so a write landing just
 *  after a tick still converges and the failure we get is the honest one
 *  ("it took a poll") rather than a timeout wearing a data defect's clothes. */
const CONVERGE_MS = 2 * POLL_MS + 5_000;
const BUDGET_MS = Math.max(
  180_000,
  SEED_MS + 2 * MOUNT_MS + TAPS * (HOLD_MS + TAP_SLACK_MS) + 2 * CONVERGE_MS,
);

/** The organiser console's pad. `data-testid="score-pad"` is on the pad's own
 *  wrapper (`fixture-console.tsx`), never on the page. */
const consolePad = (page: Page) => page.locator('[data-testid="score-pad"]');

/** The handed device's pad. `/score/[token]` renders no `score-pad` wrapper —
 *  `scorepad-v3-partial-amend.spec.ts` and `scorepad-offline.spec.ts` both
 *  record the same fact — so the chassis root is the scope. */
const devicePad = (page: Page) => page.locator('[data-role="pad-v3"]');

/**
 * The SCORE, as a person reads it.
 *
 * The scorebug and not the activity list, on purpose: the console passes
 * `hideActivity` to its pad and renders the ledger one level out, so the two
 * ends have no activity panel in common — and the score is the thing an
 * organiser and a courtside scorer would actually notice disagreeing.
 *
 * The clock is NOT in here. `PadClockBar` is a SIBLING of `v3-scorebug`
 * (`pad-host.tsx`, "the clock, between the scorebug and the ribbon"), which
 * matters because a ticking reading would satisfy "it changed" in every
 * state. `expectObservableIdle` re-proves that against the live DOM before
 * each measurement rather than trusting this paragraph.
 *
 * Never throws: a locator briefly absent across a re-render reports "", so a
 * poll retries through it instead of dying inside it.
 */
async function scoreline(pad: ReturnType<typeof devicePad>): Promise<string> {
  const text = await pad
    .locator('[data-role="v3-scorebug"]')
    .first()
    .innerText()
    .catch(() => "");
  return text.replace(/\s+/g, " ").trim();
}

/** The console's OWN ledger panel — the one `fixture-console.tsx` renders
 *  itself, one level outside the pad (the pad is handed `hideActivity`, so
 *  these rows come from the console's `events` state, not from the pad's). */
async function consoleLedgerRows(page: Page): Promise<number> {
  return page
    .locator('[data-role="v3-activity-row"]')
    .count()
    .catch(() => 0);
}

async function ledgerTypes(request: APIRequestContext, fixtureId: string): Promise<string[]> {
  const res = await apiJson<{ type: string }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return (res.data ?? []).map((e) => e.type);
}

/** Record a goal the way a scorer does: tap the tile, then answer the dock
 *  with "Send now" rather than letting it drain. The whole sequence is the
 *  WRITE — timing it from the first tap keeps every measurement conservative
 *  (it charges the UI interaction to the propagation budget) rather than
 *  flattering. */
async function recordGoal(pad: ReturnType<typeof devicePad>, tile: string): Promise<void> {
  await pad.locator(`[data-tile-id="${tile}"]`).click();
  // Scoped to the pad, the way r7 scopes it: two pads are open in this test,
  // in two browser contexts, and a page-wide role query is one refactor away
  // from answering for the wrong surface.
  const sendNow = pad.getByRole("button", { name: "Send now", exact: true });
  await expect(
    sendNow,
    "tapping a goal tile must open the scorer dock — without it this write never leaves the pad",
  ).toBeVisible({ timeout: 20_000 });
  await sendNow.click();
}

test("a console and a handed device keep each other's screens in step, both ways, faster than the poll", async ({
  page,
  browser,
}) => {
  test.setTimeout(BUDGET_MS);

  const fx = await seedRosteredFixture(page.request, {
    label: `Live Sync ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `Sync Home FW ${TAG}`, positionKey: "FW" },
      { fullName: `Sync Home MF ${TAG}`, positionKey: "MF" },
    ],
    away: [
      { fullName: `Sync Away FW ${TAG}`, positionKey: "FW" },
      { fullName: `Sync Away GK ${TAG}`, positionKey: "GK" },
    ],
  });

  // Arm the console's observers BEFORE navigating: the pad asks for its
  // realtime token from a mount effect, so a listener attached after `goto`
  // resolves is a race that reads as "the console never asked".
  const consoleWatch = await watchFixtureRealtime(page, fx.fixtureId);
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(consolePad(page), "the console pad must mount").toBeVisible({ timeout: MOUNT_MS });

  // Kick off from the console, so both pads are on a LIVE match before either
  // measurement. This write is not itself measured — at this point there is no
  // device mounted to receive it, which is precisely the gap §6b (b) records
  // in the existing r7 walkthrough.
  await page.locator('[data-testid="score-start-match"]').click();
  await expect
    .poll(() => ledgerTypes(page.request, fx.fixtureId), { timeout: 20_000 })
    .toContain("core.start");

  const minted = await apiJson<{ secret: string }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/device-links`,
    "POST",
    { label: `Live Sync ${TAG}` },
  );
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);
  const secret = minted.data!.secret;

  // `consentedAnonymousState()` and NOT a bare `newContext()`. A bare context
  // inherits `use.storageState` from playwright.config.ts, so the "courtside
  // device" would be signed in as the e2e organiser — `isFixtureOfficial`
  // would grant its realtime token and the device link would be irrelevant to
  // everything below. Measured directly in `api-keys.spec.ts:13-18`. The
  // seeded consent choice additionally keeps the cookie banner from mounting
  // over the pad mid-measurement.
  const deviceCtx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const device = await deviceCtx.newPage();
    const deviceWatch = await watchFixtureRealtime(device, fx.fixtureId);
    await device.goto(`/score/${secret}`);
    await expect(devicePad(device), "the v3 pad must render on the device link").toBeVisible({
      timeout: MOUNT_MS,
    });
    await expect
      .poll(() => deviceWatch.tokenStatuses.length, {
        timeout: MOUNT_MS,
        message: "the device pad never asked for a realtime token, or the door never answered",
      })
      .toBeGreaterThan(0);
    // Shape AND value. `/^Bearer dl_/` alone would pass on some OTHER live
    // link, and a reachability-only check ("is there a header") would pass on
    // the empty string a session pad sends. This is the assertion that fails
    // if the `auth` chain — device-score-pad -> registry -> PadHostV3 ->
    // usePadPipeline -> useFixtureStream — drops the credential again.
    expect(
      deviceWatch.authHeaders[0],
      "the device pad must present its OWN device-link token at the realtime-token door",
    ).toBe(`Bearer ${secret}`);

    // -----------------------------------------------------------------
    // FLOW (a) — the device scores, and the ORGANISER'S SCREEN moves.
    // -----------------------------------------------------------------
    const consoleBefore = await expectObservableIdle({
      read: () => scoreline(consolePad(page)),
      what: "flow (a): the console's scoreline before the device scores",
    });
    expect(consoleBefore.length, "the console must be painting a score to move OFF").toBeGreaterThan(
      0,
    );
    const consoleRowsBefore = await consoleLedgerRows(page);

    const toConsole = await measurePropagation({
      what: "flow (a): the device's goal reaching the console's screen",
      read: () => scoreline(consolePad(page)),
      write: () => recordGoal(devicePad(device), "goal-home"),
      timeoutMs: CONVERGE_MS,
    });
    assertPropagatedUnderPoll({
      where: "flow (a) device-link pad -> organiser console screen",
      result: toConsole,
      watch: consoleWatch,
      pollMs: POLL_MS,
    });

    // The positive pair for "it changed": it changed because THE GOAL landed.
    // `measurePropagation` is satisfied by any movement at all, so on its own
    // it cannot tell a propagated goal from an unrelated re-render. Counted
    // rather than matched against a whole expected ledger: the claim is "one
    // goal, from the device", and an engine that one day appends a derived
    // row beside it would red a whole-ledger equality for a reason that has
    // nothing to do with propagation.
    await expect
      .poll(async () => (await ledgerTypes(page.request, fx.fixtureId)).filter((t) => t === "football.goal").length, {
        timeout: 20_000,
      })
      .toBe(1);
    expect(
      await ledgerTypes(page.request, fx.fixtureId),
      "nothing was retracted — a void would move the scoreline for the wrong reason",
    ).not.toContain("core.void");

    // The organiser's page-level ledger is a SECOND surface on the same
    // screen, one hop further out: the pad's stream merges the foreign write,
    // `PadHostV3` fires `onEvents`, and `fixture-console.tsx`'s
    // `handlePadEvents` resyncs. Asserted for arrival only, without the
    // realtime clause — it is downstream of an extra network round trip that
    // is not part of the propagation claim. Measured as GROWTH from the count
    // taken before the write, never against a hardcoded floor, which would be
    // vacuously true if `core.start` ever rendered more than one row.
    await expect
      .poll(() => consoleLedgerRows(page), {
        timeout: CONVERGE_MS,
        message:
          "the console's own ledger panel never picked up the device's goal (fixture-console handlePadEvents -> resync)",
      })
      .toBeGreaterThan(consoleRowsBefore);

    // -----------------------------------------------------------------
    // FLOW (b) — the console scores with the device ALREADY MOUNTED, and
    // the courtside screen moves. This is the half r7 cannot have: there
    // the console's only write happens before the device exists.
    // -----------------------------------------------------------------
    // A LONGER settle here than the default, and for a named reason rather
    // than superstition. `device-score-pad.tsx` renders its pad with an inline
    // `auth={{ kind: "device_link", token }}` — a FRESH OBJECT on every
    // render — and `useFixtureStream`'s effect depends on `auth` BY IDENTITY.
    // The device just wrote, which means its chrome resynced and re-rendered,
    // which means its realtime subscription was torn down and re-established.
    // Measuring flow (b) across that churn would be measuring the churn.
    // Recorded as a finding for the wave rather than worked around silently:
    // the churn itself is a real exposure for flow (c), where the writer and
    // the watcher are the same component tree and there is no settling time
    // at all.
    const deviceBefore = await expectObservableIdle({
      read: () => scoreline(devicePad(device)),
      settleMs: 3_000,
      what: "flow (b): the device's scoreline before the console scores",
    });
    expect(
      deviceBefore,
      "the device must already be showing the goal it just recorded, or flow (a) did not really land here either",
    ).not.toBe("");

    const toDevice = await measurePropagation({
      what: "flow (b): the console's goal reaching the courtside device",
      read: () => scoreline(devicePad(device)),
      write: () => recordGoal(consolePad(page), "goal-away"),
      timeoutMs: CONVERGE_MS,
    });
    assertPropagatedUnderPoll({
      where: "flow (b) organiser console -> device-link pad screen",
      result: toDevice,
      watch: deviceWatch,
      pollMs: POLL_MS,
    });

    expect(
      (await ledgerTypes(page.request, fx.fixtureId)).filter((t) => t === "football.goal").length,
      "the console's goal is the SECOND goal on the ledger — one from each end",
    ).toBe(2);

    // Both screens, one match, one score — the statement a person in the room
    // would actually check. Compared on the NUMBERS the two scorebugs paint
    // rather than on their whole text: it is the same component at both ends,
    // but a name that truncates differently in a different viewport would
    // make a full-string comparison fail for a reason that has nothing to do
    // with the score, and the score is the claim.
    const digits = (s: string) => (s.match(/\d+/g) ?? []).join("-");
    const consoleFinal = digits(await scoreline(consolePad(page)));
    expect(
      consoleFinal,
      "the console must be painting numbers at all, or the comparison below is two empty strings agreeing",
    ).not.toBe("");
    await expect
      .poll(async () => digits(await scoreline(devicePad(device))), {
        timeout: CONVERGE_MS,
        message: "the two screens disagree about the score after two goals, one from each end",
      })
      .toBe(consoleFinal);
  } finally {
    await deviceCtx.close();
  }
});
