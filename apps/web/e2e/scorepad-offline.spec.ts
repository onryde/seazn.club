import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, seedRosteredFixture, expectNoHorizontalScroll, TAG, type RosteredFixture } from "./helpers";
import { DOUBLE_SUBMIT_WINDOW_MS } from "../src/components/v2/scorepad/use-pad-pipeline";
import { consentedAnonymousState } from "./scorepad-a11y-kit";

// S10/#419 W8 — the three acceptance criteria this file proves: the offline
// queue survives tab death, scoring continues with the network down, and it
// drains in order on reconnect with no duplicates.
//
// S13/#422 W11 cutover — re-anchored off `/score/harness` (deleted this
// session, along with its SCOREPAD_V2_HARNESS gate) onto the REAL device-link
// surface (`/score/[token]`), against a REAL seeded fixture
// (`seedRosteredFixture`, helpers.ts) with a REAL minted device link — the
// same seeding call and the same anonymous-context/cookie-consent pattern
// scorepad-v2.spec.ts's own device-link test already established. `generic`
// stays the sport for the same reason S10 chose it: `generic.score` is the
// only REPEATABLE action cheap enough to drive with no real roster. Since
// scorer sheets §4.5.1 the scan of a scheduled fixture opens on the Confirm
// card and the pad mounts only after Start match, so every scenario taps Start
// first (`openDeviceLink`) and every ledger below leads with that core.start.
//
// TWO WAYS OF GOING "OFFLINE", DELIBERATELY DIFFERENT PER SCENARIO (unchanged
// from the harness version): airplane mode uses the real `context.setOffline`
// (mandated by the brief, safe here since that scenario never navigates
// again); tab death and the 409 scenario use `page.route(...).abort()` scoped
// to the fixture's own events endpoint instead, because `setOffline(true)`
// would also block a `page.reload()`'s own document fetch, and tab death's
// whole claim depends on a real reload succeeding mid-scenario.
const uiEn = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const OFFLINE_TEXT = uiEn["scorepad.queue.offline"];
const SYNCED_TEXT = uiEn["scorepad.queue.synced"];

/** A real, undecided, 2-entrant `generic`/`score` fixture with a minted
 *  device link — the same seeding shape scorepad-v2.spec.ts's own
 *  device-link test uses, so this file's three scenarios run against an
 *  identically-real setup. */
async function setupOfflineFixture(
  request: APIRequestContext,
  label: string,
): Promise<{ fixture: RosteredFixture; secret: string }> {
  const fixture = await seedRosteredFixture(request, {
    label: `Scorepad offline e2e ${label} ${TAG}`,
    sportKey: "generic",
    variantKey: "score",
    entrantKind: "individual",
    home: [{ fullName: `Offline Home ${label} ${TAG}` }],
    away: [{ fullName: `Offline Away ${label} ${TAG}` }],
  });
  const minted = await apiJson<{ secret: string }>(
    request,
    `/api/v1/fixtures/${fixture.fixtureId}/device-links`,
    "POST",
    { label: `Offline ${label} ${TAG}` },
  );
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);
  return { fixture, secret: minted.data!.secret };
}

/** The one starter this fixture seeds on the home side — the person the v3
 *  skin stamps into every home tap. Derived from the SAME label
 *  `setupOfflineFixture` seeds with, so a rename cannot leave the two
 *  disagreeing silently. */
function homePerson(fixture: RosteredFixture): string {
  const id = Object.entries(fixture.personIds).find(([name]) => name.startsWith("Offline Home "))?.[1];
  if (id === undefined) throw new Error("scorepad-offline: no seeded home person to attribute against");
  return id;
}

/** Matches registry.tsx's own `queueDbName` literal (`scorepad-${fixtureId}`)
 *  exactly — this reads the browser's real IndexedDB by name. */
function queueDbName(fixtureId: string): string {
  return `scorepad-${fixtureId}`;
}

/** Counts rows in the pad's own durable IndexedDB queue — the source of
 *  truth for a NUMBER: pad-renderer.tsx's own queue label shows EITHER the
 *  offline message OR a "{count} queued" count, never both, so no visible
 *  text carries a reliable digit while a drain is blocked. */
async function queueRowCount(page: Page, dbName: string): Promise<number> {
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

/** The fixture's full ledger from seq 0 — the no-duplicates oracle every
 *  scenario below reads instead of the UI. */
async function ledgerOf(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ seq: number; type: string; payload: unknown }[]> {
  const res = await apiJson<{ seq: number; type: string; payload: unknown }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `GET events: ${res.error?.message ?? ""}`).toBe(200);
  return res.data!;
}

/** Anonymous device-link context: `browser.newContext()` bare can inherit an
 *  authed storageState, and the whole point of this surface is that the
 *  TOKEN is the only credential (scorepad-v2.spec.ts's own device-link test,
 *  same reasoning). Accepts the cookie-consent banner, which an anonymous
 *  context always starts without and which would otherwise intercept the
 *  pad's own taps.
 *
 *  The fixture is not yet started, so the scan opens on the Confirm card and
 *  the pad mounts only on Start (scorer sheets §4.5.1) — the product's own
 *  flow, so the device taps it. Online, before any scenario goes offline:
 *  every ledger below therefore opens with the device's `core.start`
 *  (`STARTED`), and the pad's first queued event targets seq 1, not 0. */
async function openDeviceLink(page: Page, request: APIRequestContext, fixtureId: string, secret: string): Promise<void> {
  await page.goto(`/score/${secret}`);
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  if ((await accept.count()) > 0) await accept.click();
  await expect(page.getByTestId("scan-confirm"), "a not-yet-started scan opens on Confirm").toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("score-start-match").click();
  await expect(scorebug(page), "the v3 board must render once the device starts the match").toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(async () => (await ledgerOf(request, fixtureId)).map((e) => e.type), {
      message: "the device's Start must land before a scenario goes offline",
    })
    .toEqual(["core.start"]);
}

/** The device's own Start, which every scenario's ledger opens with. */
const STARTED = { type: "core.start", payload: {} };

/** ScoringPad v3, tapModel S (R7/A1): the scoreboard HALF is the button, so
 *  there is no "Add points" form to expand. Indexed positionally, home first
 *  (scorebug.tsx's own render order) — a tappable half's accessible name is
 *  the player's name plus the hint text, which this file has no fixed string
 *  for. The device surface renders no `data-testid="score-pad"` wrapper to
 *  scope to, hence the explicit `[data-role="v3-scorebug"]` root here.
 *
 *  `[data-role="v3-scorebug-half"]` (scorebug.tsx, added in review) replaces
 *  a `.grid > * >> .app-display.font-bold` structural chain: it reached
 *  through the score figure's OWN layout classes to find the half, so it
 *  broke on any restyle of either — clicking the half is equivalent, since
 *  the figure's click bubbles to the same `onClick`. scorepad-skins.spec.ts's
 *  `scorebugHalf` and gallery.capture.ts's `v3Half` still use the old chain;
 *  out of scope here. */
function scorebug(page: Page) {
  return page.locator('[data-role="v3-scorebug"]');
}
function homeHalf(page: Page) {
  return scorebug(page).locator('[data-role="v3-scorebug-half"]').nth(0);
}

/**
 * Tap the home half — which IS the point — and then, for anything worth more
 * than one, amend the amount on that SAME held submission through the detail
 * dock's own chip. `generic.score` is one event either way: the dock rewrites
 * `points` on the queued payload (queue.ts's `mutateHeld`), it never posts a
 * second event.
 *
 * Every call site uses a DISTINCT amount so the final ledger assertion pins an
 * exact payload per slot, not merely a count. That is doubly load-bearing on
 * v3: the double-submit guard compares (type, payload) at SUBMIT time, before
 * any chip has run, so three half taps are three IDENTICAL submissions
 * (every half tap's PRE-amend payload is the same `points: 1`) and the guard
 * legitimately swallows any repeat landing inside its window
 * (`DOUBLE_SUBMIT_WINDOW_MS`, 250ms as of R7-42 — was 600ms).
 *
 * `expectDepth`'s poll does NOT space the taps by itself — this file's whole
 * scenario is offline (route-aborted or `setOffline`), so the queue write is
 * a same-tick IndexedDB op with no network round trip to force a gap, and the
 * poll can resolve well under 250ms. Confirmed live: every scenario in this
 * file failed on exactly its SECOND tap ("press worth N must reach the
 * durable queue", `Expected: 2, Received: 1`) until the explicit wait below
 * was added — the same fix `scorepad-v3-badminton.spec.ts`'s `tapRally`
 * already applies for the identical reason (R7-46).
 */
async function pressAddPoints(page: Page, points: number, dbName: string, expectDepth: number): Promise<void> {
  if (expectDepth > 1) await page.waitForTimeout(DOUBLE_SUBMIT_WINDOW_MS + 60);
  await homeHalf(page).click();
  const dock = page.locator('[data-role="v3-dock"]');
  await expect(dock, "a tally tap must open the amend dock").toBeVisible({ timeout: 20_000 });
  if (points !== 1) {
    await dock.getByRole("button", { name: `${points} points`, exact: true }).click();
  }
  await expect
    .poll(() => queueRowCount(page, dbName), {
      timeout: 20_000,
      message: `press worth ${points} must reach the durable queue`,
    })
    .toBe(expectDepth);
}

/** `person` is not decoration: the v3 skin stamps a one-person side's only
 *  member INTO the tap (`buildHalf`'s sole-player auto-set), and this fixture
 *  seeds exactly one starter per side, so every event the pad writes carries
 *  it. Asserting the payload without it would pass against a pad that had
 *  quietly stopped attributing anything. */
function scoreEvents(entrantId: string, personId: string, ...points: number[]): { type: string; payload: unknown }[] {
  return points.map((n) => ({ type: "generic.score", payload: { by: entrantId, points: n, person: personId } }));
}

test("tab death mid-queue: the durable queue survives a real reload and drains in order with no duplicates", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const { fixture, secret } = await setupOfflineFixture(request, "tabdeath");
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const page = await ctx.newPage();
    await openDeviceLink(page, request, fixture.fixtureId, secret);
    // Assert the SEED, not a downstream effect racing something else's own
    // dismissal — see task-2-report.md, Step 7: `expectNoCookieBanner` here
    // raced `openDeviceLink`'s own reactive Accept-click (and, under load,
    // the SSR-visible scorebug winning against the hydration-gated banner),
    // so it passed in both the seeded and unseeded states. The consent keys
    // are deterministic context state — read them directly instead.
    const { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } = await import("../src/lib/consent");
    const seeded = await page.evaluate(
      ([k, v]) => ({ choice: localStorage.getItem(k), version: localStorage.getItem(v) }),
      [CONSENT_KEY, CONSENT_VERSION_KEY],
    );
    expect(
      seeded,
      "the anonymous context did not carry seeded consent, so the banner will mount and race this spec",
    ).toEqual({ choice: "rejected", version: COOKIE_POLICY_VERSION });

    const eventsUrl = (url: URL): boolean => url.pathname === `/api/v1/fixtures/${fixture.fixtureId}/events`;
    await page.route(eventsUrl, (route) => route.abort());

    const dbName = queueDbName(fixture.fixtureId);
    await pressAddPoints(page, 1, dbName, 1);
    await pressAddPoints(page, 2, dbName, 2);
    await pressAddPoints(page, 3, dbName, 3);

    await expect(page.getByText(OFFLINE_TEXT)).toBeVisible();
    expect((await ledgerOf(request, fixture.fixtureId)).length, "nothing but the start reached the server yet").toBe(1);

    // Tab death: a real reload, not a soft re-render. The route persists on
    // this `page` across the navigation (Playwright routes survive reload
    // until explicitly removed), so the fresh mount's own resume-drain
    // attempt still fails and the queue stays exactly as IndexedDB left it.
    await page.reload();
    const acceptAgain = page.getByRole("button", { name: "Accept", exact: true });
    if ((await acceptAgain.count()) > 0) await acceptAgain.click();
    await expect(scorebug(page), "the v3 board must render again after the reload").toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => queueRowCount(page, dbName), {
        message: "the queue must survive a real reload — nothing in-memory did",
      })
      .toBe(3);
    expect((await ledgerOf(request, fixture.fixtureId)).length, "still nothing but the start on the server").toBe(1);

    await page.unrouteAll();
    // Nothing in the app polls "is the network back" independently — it only
    // reacts to mount, a `submit()` call, or a real `online` event. This
    // dispatches that exact signal without racing a second real reconnect.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect(page.getByText(SYNCED_TEXT)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => queueRowCount(page, dbName)).toBe(0);

    const ledger = await ledgerOf(request, fixture.fixtureId);
    expect(ledger.map((e) => ({ type: e.type, payload: e.payload }))).toEqual([
      STARTED,
      ...scoreEvents(fixture.homeEntrantId, homePerson(fixture), 1, 2, 3),
    ]);
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
});

test("airplane mode: scoring continues offline, an explicit offline state and non-zero queue show, and the queue drains to empty on reconnect", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const { fixture, secret } = await setupOfflineFixture(request, "airplane");
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const page = await ctx.newPage();
    await openDeviceLink(page, request, fixture.fixtureId, secret);

    // The real thing (brief's own requirement), not a stubbed transport —
    // this scenario never navigates again, so there is no reload for a
    // context-wide block to fight.
    await ctx.setOffline(true);

    const dbName = queueDbName(fixture.fixtureId);
    await pressAddPoints(page, 2, dbName, 1);
    await pressAddPoints(page, 3, dbName, 2);

    await expect(page.getByText(OFFLINE_TEXT)).toBeVisible();
    expect((await ledgerOf(request, fixture.fixtureId)).length, "nothing but the start reached the server while offline").toBe(1);

    await ctx.setOffline(false);

    await expect(page.getByText(SYNCED_TEXT)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => queueRowCount(page, dbName)).toBe(0);

    const ledger = await ledgerOf(request, fixture.fixtureId);
    expect(ledger.map((e) => ({ type: e.type, payload: e.payload }))).toEqual([
      STARTED,
      ...scoreEvents(fixture.homeEntrantId, homePerson(fixture), 2, 3),
    ]);
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
});

test("a 409 mid-drain resyncs against the ledger and completes with no duplicates", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { fixture, secret } = await setupOfflineFixture(request, "conflict");
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const page = await ctx.newPage();
    await openDeviceLink(page, request, fixture.fixtureId, secret);

    const eventsUrl = (url: URL): boolean => url.pathname === `/api/v1/fixtures/${fixture.fixtureId}/events`;
    await page.route(eventsUrl, (route) => route.abort());

    const dbName = queueDbName(fixture.fixtureId);
    await pressAddPoints(page, 3, dbName, 1);
    await pressAddPoints(page, 5, dbName, 2);

    // Out-of-band: the standalone `request` fixture is its own
    // APIRequestContext (never a browser request, so `page.route` above never
    // sees it) landing a genuine, server-accepted write at expected_seq=1 —
    // the slot right after the Start tap's core.start (seq 1), i.e. the EXACT
    // slot the client's first queued event still believes is free.
    // A different `by` AND a sentinel `points` value so content comparison
    // alone (pipeline.ts's resolveConflict) unambiguously reads this as
    // foreign, never "our own event replayed".
    const outOfBand = await apiJson(request, `/api/v1/fixtures/${fixture.fixtureId}/events`, "POST", {
      expected_seq: 1,
      type: "generic.score",
      payload: { by: fixture.awayEntrantId, points: 999 },
    });
    expect(outOfBand.status, `out-of-band append: ${outOfBand.error?.message ?? ""}`).toBe(201);

    await page.unrouteAll();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect(page.getByText(SYNCED_TEXT)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => queueRowCount(page, dbName)).toBe(0);

    // Every one of the three events, exactly once, out-of-band first (it
    // landed first, chronologically) then the client's own two in their
    // original submission order — each having renegotiated its expected_seq
    // exactly once around the foreign slot, per the S10 replay ruling.
    const ledger = await ledgerOf(request, fixture.fixtureId);
    expect(ledger.map((e) => ({ type: e.type, payload: e.payload }))).toEqual([
      STARTED,
      // The out-of-band write is a raw API append with no lineup context, so
      // it carries no `person` — unlike the two the PAD wrote.
      { type: "generic.score", payload: { by: fixture.awayEntrantId, points: 999 } },
      ...scoreEvents(fixture.homeEntrantId, homePerson(fixture), 3, 5),
    ]);
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
});

// Code review, this branch — the offline pill (pad-host.tsx, restored above)
// shipped with `shrink-0` on a `justify-end` flex child. `scorepad.queue.
// offline` is a 66-character sentence; at phone width that forced the pill
// to its natural single-line size and let `justify-end` push the OVERFLOW
// off the LEFT edge, taking the status dot with it. `expectNoHorizontalScroll`
// (every other test in this file) cannot see this: it measures
// `html.scrollWidth`, which only ever grows for RIGHTWARD overflow — a
// leftward one leaves it unchanged. This is the repo's own documented
// failure class (a new UI surface with zero width coverage) for a new
// element that renders unconditionally on every v3 pad; the assertion below
// is the general form of that gap for anything right-aligned, not merely
// this one pill.
test("the queue-status pill stays fully on-screen at phone width, offline text included", async ({ browser, request }) => {
  test.setTimeout(60_000);
  const { fixture, secret } = await setupOfflineFixture(request, "narrowpill");
  const ctx = await browser.newContext({
    storageState: await consentedAnonymousState(),
    viewport: { width: 320, height: 700 },
  });
  try {
    const page = await ctx.newPage();
    await openDeviceLink(page, request, fixture.fixtureId, secret);
    await ctx.setOffline(true);

    const dbName = queueDbName(fixture.fixtureId);
    await pressAddPoints(page, 1, dbName, 1);

    const pill = page.locator('[data-role="v3-queue-status"]');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(OFFLINE_TEXT);

    const pillBox = await pill.boundingBox();
    expect(pillBox, "queue-status pill has no box").not.toBeNull();
    expect(pillBox!.x, "the pill's left edge must not be pushed off-screen").toBeGreaterThanOrEqual(0);
    expect(pillBox!.x + pillBox!.width, "the pill must not overflow the 320px viewport").toBeLessThanOrEqual(320);

    const dot = pill.locator("> span[aria-hidden]");
    const dotBox = await dot.boundingBox();
    expect(dotBox, "the status dot has no box").not.toBeNull();
    expect(dotBox!.x, "the status dot itself must stay on-screen, not just the text").toBeGreaterThanOrEqual(0);

    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
});
