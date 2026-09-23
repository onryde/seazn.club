// WALKTHROUGH — "Void my last entry" must reach the pad the scorer is looking
// at, not just the header above it. Owner-reported on the device-link pad.
//
// The scorer's story this plays: a courtside phone holds a device link
// (`/score/{token}`). The scorer taps a rally on the pad, realises it was the
// wrong side, and presses the chrome's own "Void my last entry"
// (`device-void-mine`, `device-score-pad.tsx`). The LED header above the pad
// goes back to the old score — it re-reads the whole ledger — while the pad
// underneath, the thing the scorer taps, went on showing the rally that was
// just undone, behind a refusal banner.
//
// The mechanism, for the record (the unit twin in `use-pad-pipeline.test.tsx`,
// "a foreign void naming the SERVER id of a pad-scored event", pins each step):
//
//   1. the pad's own tap is acked WITHOUT an `event_id` (every ack did, before
//      Fix A), so the pad keeps the rally under the idempotency key it
//      minted;
//   2. the chrome's void names the rally by the SERVER's row id — the only id
//      the chrome has ever seen;
//   3. the pad's stream asks `?since_seq=<count>`, which is strict, so the
//      rally's own row is never re-read — only the void arrives, naming an id
//      the pad does not hold, and the engine refuses every fold from there on.
//
// The observable is the pad's OWN scoreboard, read out of the chassis
// (`[data-role="pad-v3"]`), never the chrome's header: the header was right
// all along, and a test that read it would pass on the defect.
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, seedRosteredFixture, TAG } from "../helpers";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { padPollMs } from "../realtime-propagation-kit";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";

/** The pad's stream tick, read from `use-fixture-stream.ts`'s own declaration. */
const POLL_MS = padPollMs();

/** Waits for the NEXT observed pad read, so its worst case is one full cycle
 *  (two, if the first lands just before the wait starts) plus slack for a
 *  loaded machine. Derived, so moving `POLL_MS` moves it too. */
const POLL_WAIT_MS = POLL_MS * 2 + 15_000;

/** A tap soft-commits: it is SENT only once `HOLD_MS` has run out. The ledger
 *  cannot show it before then, so this wait is the window plus the drain's own
 *  round trip on a loaded machine. Derived, never flat (AGENTS.md class 20). */
const SEND_MS = HOLD_MS + 15_000;

/** One page-level wait for a value to converge, and the pad's mount. */
const CONVERGE_MS = 20_000;
const MOUNT_MS = 20_000;
const SEED_MS = 60_000;

/** Seeding, a mount, one sent tap, four converges (the optimistic score, the
 *  chrome's void button, the void reaching the ledger, the pad reverting) and
 *  one poll-bound wait — expressed in the constants so none can move without
 *  the budget moving too. */
const BUDGET_MS = Math.max(180_000, SEED_MS + MOUNT_MS + SEND_MS + 4 * CONVERGE_MS + POLL_WAIT_MS);

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

/** The device CHROME's LED header — the positive pair, never the observable. */
const headline = (page: Page) => page.locator("header p.font-mono");

/** "Void my last entry" — the chrome's own control. */
const voidMine = (page: Page) => page.locator('[data-testid="device-void-mine"]');

/** The header joins " · " groups without the surrounding spaces. */
const asRendered = (h: string) => h.split(" · ").join("·");

type LedgerRow = { id: string; seq: number; type: string; device_link_id: string | null; voids_event_id: string | null };

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerRow[]> {
  const res = await apiJson<LedgerRow[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

async function serverHeadline(request: APIRequestContext, fixtureId: string): Promise<string> {
  const res = await apiJson<{ summary: { headline?: string } | null }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(res.status, `state read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return String(res.data?.summary?.headline ?? "");
}

test("'Void my last entry' on a device link reverts the pad the scorer taps, not only the header above it", async ({
  page,
  browser,
}) => {
  test.setTimeout(BUDGET_MS);

  const fx = await seedRosteredFixture(page.request, {
    label: `Foreign Void ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: `FV Home ${TAG}` }],
    away: [{ fullName: `FV Away ${TAG}` }],
    emitCoreStart: true,
  });

  const minted = await apiJson<{ secret: string }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/device-links`,
    "POST",
    { label: `FV Court ${TAG}` },
  );
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);
  const secret = minted.data!.secret;

  // `consentedAnonymousState()`, not a bare `newContext()`: the latter inherits
  // the e2e organiser's cookie, so the "courtside device" would be signed in
  // and the device link irrelevant. The seeded consent also keeps the cookie
  // banner from mounting over the pad.
  const deviceCtx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const device = await deviceCtx.newPage();

    // Every read the INNER PAD's stream makes: `?since_seq=N` with N > 0 once
    // it holds anything. The chrome's `resync()` always asks `since_seq=0`, so
    // the two consumers are told apart by cursor (the stalled-pipeline
    // walkthrough's discriminator). Timestamped, so "a read happened AFTER the
    // void landed" can be asserted rather than slept for.
    const padReads: { since: string; at: number }[] = [];
    device.on("request", (req) => {
      if (req.method() !== "GET") return;
      const url = new URL(req.url());
      if (!url.pathname.endsWith(`/fixtures/${fx.fixtureId}/events`)) return;
      const since = url.searchParams.get("since_seq");
      if (since !== null && since !== "0") padReads.push({ since, at: Date.now() });
    });

    await device.goto(`/score/${secret}`);
    await expect(devicePad(device), "the v3 pad must render on the device link").toBeVisible({ timeout: MOUNT_MS });
    await expect(halfScore(device, "home"), "the home half must open at nil").toHaveText("0", { timeout: MOUNT_MS });

    // ---- the scorer taps a rally on the PAD --------------------------------
    await half(device, "home").click();
    // The differential this test exists for: the observable must be able to
    // move, or its "reverted to 0" below passes in both states.
    await expect(halfScore(device, "home"), "the tap must move the pad's own score").toHaveText("1", {
      timeout: CONVERGE_MS,
    });
    await expect
      .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "badminton.rally").length, {
        timeout: SEND_MS,
        message: "the pad's rally never reached the ledger",
      })
      .toBe(1);
    const rally = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "badminton.rally")!;
    expect(rally.device_link_id, "the rally must have been written THROUGH the link").not.toBeNull();
    const rallyHeadline = await serverHeadline(page.request, fx.fixtureId);

    // ---- ...and presses the chrome's own undo -------------------------------
    await expect(voidMine(device), "the link's own rally must offer 'Void my last entry'").toBeEnabled({
      timeout: CONVERGE_MS,
    });
    await voidMine(device).click();

    await expect
      .poll(
        async () =>
          (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "core.void")?.voids_event_id ?? null,
        { timeout: CONVERGE_MS, message: "the chrome's void never reached the ledger" },
      )
      .toBe(rally.id);
    const voidLandedAt = Date.now();

    // The positive pair: the CHROME was always right. If this fails, the void
    // itself went wrong and nothing below is about the pad.
    const afterVoid = await serverHeadline(page.request, fx.fixtureId);
    expect(afterVoid, "the void must move the engine's headline off the rally's").not.toBe(rallyHeadline);
    await expect(headline(device), "the chrome's header must show the post-void score").toHaveText(
      asRendered(afterVoid),
      { timeout: CONVERGE_MS },
    );

    // ---- the pad must follow ------------------------------------------------
    //
    // Waits for an OBSERVED pad read after the void, not a flat window: the
    // pad can only learn of a void it did not write through its stream, so
    // until one read has happened "still 1" is not yet a defect.
    await expect
      .poll(() => padReads.filter((r) => r.at > voidLandedAt).length, {
        timeout: POLL_WAIT_MS,
        message: "the pad's stream never read after the void, so this run cannot judge the pad",
      })
      .toBeGreaterThan(0);

    await expect(
      halfScore(device, "home"),
      `the pad still shows the undone rally after reading past the void (pad reads: [${padReads
        .map((r) => r.since)
        .join(",")}])`,
    ).toHaveText("0", { timeout: CONVERGE_MS });
    await expect(padRefusal(device), "an undo that took must not leave a refusal on the pad").toHaveCount(0);
  } finally {
    await deviceCtx.close();
  }
});
