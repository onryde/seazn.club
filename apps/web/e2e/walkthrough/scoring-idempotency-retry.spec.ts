// WALKTHROUGH — W2 durable idempotency, driven by hand through the real pad.
//
// The scorer's story this plays: a rally is tapped, the request reaches the
// server and commits, and the RESPONSE is lost on a bad court Wi-Fi. The phone
// resends. Did the rally get scored twice?
//
// Why this is not covered by the API spec beside it
// (`e2e/scoring-idempotency.spec.ts`): that file mints its own keys and posts
// its own bodies, which proves the SERVER honours a key. It cannot prove the
// pad ever sends one. This file never constructs a request — it taps the
// scoreboard and REPLAYS whatever the pad itself put on the wire, key and all.
// That is the difference between proving the guarantee and proving the seam,
// and the inert-seam class in AGENTS.md is exactly a guarantee whose producer
// never reached it.
//
// The duplicate is forced at the NETWORK layer (route interception), which is
// deliberate: `use-pad-pipeline.ts`'s `DOUBLE_SUBMIT_WINDOW_MS` guard lives in
// the client, so a double TAP would be swallowed before it ever left the
// browser and would prove nothing about the server. A replayed request bypasses
// the client guard entirely — which is also what a real lost response does.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG } from "../helpers";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";

// Five taps, each of which SOFT-COMMITS: the pad holds the event for HOLD_MS
// before it ever reaches the wire, so this spec's wall clock is dominated by
// HOLD_MS x taps. Derived from the real constant, never a flat literal —
// moving HOLD_MS must move the budget with it, or this goes red in a way whose
// obvious repair is to delete the guard (AGENTS.md failure class 20).
const TAPS = 5;
const PER_TAP_MS = HOLD_MS + 8_000; // hold + the ledger round trip this polls for
const BUDGET_MS = Math.max(120_000, 45_000 + TAPS * PER_TAP_MS);

const pad = (page: Page) => page.locator('[data-testid="score-pad"]');
const scorebug = (page: Page) => pad(page).locator('[data-role="v3-scorebug"]');

/** One tappable scoreboard half. Scoped to `button` for the same load-bearing
 *  reason `scorepad-v3-badminton.spec.ts` documents: a half renders a plain
 *  `<div>` at the same grid position until the client re-render swaps it, and
 *  a wildcard locator clicks the handler-less div and dispatches nothing. */
const half = (page: Page, side: "home" | "away") =>
  scorebug(page)
    .locator(".grid > button")
    .nth(side === "home" ? 0 : 1);

async function rallies(request: APIRequestContext, fixtureId: string) {
  const res = await apiJson<{ seq: number; type: string; payload: Record<string, unknown> }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return (res.data ?? []).filter((e) => e.type === "badminton.rally");
}

/** Tap, then WAIT FOR THE LEDGER to reach `expected`. Polling the real ledger
 *  is a network round trip, which by itself exceeds `DOUBLE_SUBMIT_WINDOW_MS`
 *  — so unlike the unit-level pad specs this needs no hand-tuned clearance,
 *  and cannot go stale when that constant moves. */
async function tapRallyAndSettle(
  page: Page,
  side: "home" | "away",
  fixtureId: string,
  expected: number,
): Promise<void> {
  await half(page, side).click();
  await expect
    .poll(async () => (await rallies(page.request, fixtureId)).length, {
      timeout: PER_TAP_MS,
      message: `rally ${expected} never reached the ledger`,
    })
    .toBe(expected);
}

test("a lost response, resent by the pad itself, does not score the rally twice", async ({
  page,
}) => {
  test.setTimeout(BUDGET_MS);

  const fx = await seedRosteredFixture(page.request, {
    label: `W2 Idem Walkthrough ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: `W2 Idem Home ${TAG}` }],
    away: [{ fullName: `W2 Idem Away ${TAG}` }],
    emitCoreStart: true,
  });

  // --- the duplicating network, armed BEFORE the pad mounts ----------------
  //
  // Every event POST is sent TWICE and the first response is returned. The
  // second send is the retry a phone makes when it never sees the first
  // answer: same body, same idempotency_key, same now-stale expected_seq.
  //
  // `duplicated` counts how many taps were actually doubled, so the assertion
  // at the end cannot pass because the interception silently never fired —
  // the vacuous mode this kind of harness fails in.
  let duplicated = 0;
  const replayStatuses: number[] = [];
  await page.route("**/api/v1/fixtures/*/events", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const first = await route.fetch();
    // The REPLAY: the pad's own request, byte for byte, sent a second time.
    const second = await route.fetch();
    duplicated += 1;
    replayStatuses.push(second.status());
    await route.fulfill({ response: first });
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page), "the v3 pad must mount, or there is nothing to tap").toBeVisible({
    timeout: 20_000,
  });

  // --- score four rallies by hand ------------------------------------------
  //
  // Each tap is doubled on the wire. If the server did not hold the line, the
  // ledger would run 2, 4, 6, 8 and the poll below would overshoot its target
  // on the very first rally.
  await tapRallyAndSettle(page, "home", fx.fixtureId, 1);
  await tapRallyAndSettle(page, "home", fx.fixtureId, 2);
  await tapRallyAndSettle(page, "away", fx.fixtureId, 3);
  await tapRallyAndSettle(page, "home", fx.fixtureId, 4);

  // The harness actually ran. Without this, a route pattern that matched
  // nothing would leave every assertion above trivially satisfied and this
  // test would sign off on a duplicate that was never sent.
  expect(duplicated, "no request was ever duplicated — the interception is inert").toBe(4);
  expect(
    replayStatuses.every((s) => s < 400),
    `the pad's own replayed writes were REFUSED: ${replayStatuses.join(",")}`,
  ).toBe(true);

  // --- what the scorer sees ------------------------------------------------
  //
  // Four taps, four rallies, and the score on screen is 3-1. A duplicated
  // rally would read 6-2 here, so this is the plain question asked of the
  // screen that the failure-class list insists on.
  const rows = await rallies(page.request, fx.fixtureId);
  expect(rows.length, "four taps must be four rallies").toBe(4);
  // Gapless and in order: a duplicate that landed at a fresh seq would show
  // up here even if the count somehow matched.
  expect(rows.map((r) => r.seq)).toEqual([2, 3, 4, 5]);

  await expect(scorebug(page)).toContainText("3");
  await expect(scorebug(page)).toContainText("1");

  // --- and the pad stays usable afterwards ---------------------------------
  //
  // A server that answered the retry with a 409 would leave the pipeline
  // believing it had a conflict to resolve. The real proof that it did not is
  // that the NEXT tap still scores normally.
  await tapRallyAndSettle(page, "away", fx.fixtureId, 5);
  expect((await rallies(page.request, fx.fixtureId)).map((r) => r.seq)).toEqual([2, 3, 4, 5, 6]);
});
