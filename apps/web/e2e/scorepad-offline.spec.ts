import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, seedRosteredFixture, expectNoHorizontalScroll, TAG, type RosteredFixture } from "./helpers";

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
// only REPEATABLE action cheap enough to drive with no real roster, and it
// tolerates `state.phase === "pre"`, so no `core.start` is needed before
// going offline.
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
 *  pad's own taps. */
async function openDeviceLink(page: Page, secret: string): Promise<void> {
  await page.goto(`/score/${secret}`);
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  if ((await accept.count()) > 0) await accept.click();
  await expect(page.getByRole("button", { name: "Add points", exact: true })).toBeVisible({ timeout: 20_000 });
}

/** Expand "Add points", fill the Points field, pick the Home chip, Confirm.
 *  Every call site below uses a DISTINCT points value so the final ledger
 *  assertion pins an exact payload per slot, not merely a count —
 *  `usePadPipeline`'s own double-submit guard would otherwise correctly
 *  swallow a repeat of the identical (type, payload) pair. */
async function pressAddPoints(page: Page, points: number): Promise<void> {
  await page.getByRole("button", { name: "Add points", exact: true }).click();
  await page.getByLabel("Points", { exact: true }).fill(String(points));
  await page.getByRole("button", { name: "Home", exact: true }).click();
  const confirm = page.locator('[data-role="confirm"]');
  if ((await confirm.count()) > 0) await confirm.click();
}

function scoreEvents(entrantId: string, ...points: number[]): { type: string; payload: unknown }[] {
  return points.map((n) => ({ type: "generic.score", payload: { by: entrantId, points: n } }));
}

test("tab death mid-queue: the durable queue survives a real reload and drains in order with no duplicates", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const { fixture, secret } = await setupOfflineFixture(request, "tabdeath");
  const ctx = await browser.newContext({ storageState: undefined });
  try {
    const page = await ctx.newPage();
    await openDeviceLink(page, secret);

    const eventsUrl = (url: URL): boolean => url.pathname === `/api/v1/fixtures/${fixture.fixtureId}/events`;
    await page.route(eventsUrl, (route) => route.abort());

    await pressAddPoints(page, 1);
    await pressAddPoints(page, 2);
    await pressAddPoints(page, 3);

    const dbName = queueDbName(fixture.fixtureId);
    await expect.poll(() => queueRowCount(page, dbName)).toBe(3);
    await expect(page.getByText(OFFLINE_TEXT)).toBeVisible();
    expect((await ledgerOf(request, fixture.fixtureId)).length, "nothing reached the server yet").toBe(0);

    // Tab death: a real reload, not a soft re-render. The route persists on
    // this `page` across the navigation (Playwright routes survive reload
    // until explicitly removed), so the fresh mount's own resume-drain
    // attempt still fails and the queue stays exactly as IndexedDB left it.
    await page.reload();
    const acceptAgain = page.getByRole("button", { name: "Accept", exact: true });
    if ((await acceptAgain.count()) > 0) await acceptAgain.click();
    await expect(page.getByRole("button", { name: "Add points", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => queueRowCount(page, dbName), {
        message: "the queue must survive a real reload — nothing in-memory did",
      })
      .toBe(3);
    expect((await ledgerOf(request, fixture.fixtureId)).length, "still nothing on the server").toBe(0);

    await page.unrouteAll();
    // Nothing in the app polls "is the network back" independently — it only
    // reacts to mount, a `submit()` call, or a real `online` event. This
    // dispatches that exact signal without racing a second real reconnect.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect(page.getByText(SYNCED_TEXT)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => queueRowCount(page, dbName)).toBe(0);

    const ledger = await ledgerOf(request, fixture.fixtureId);
    expect(ledger.map((e) => ({ type: e.type, payload: e.payload }))).toEqual(
      scoreEvents(fixture.homeEntrantId, 1, 2, 3),
    );
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
  const ctx = await browser.newContext({ storageState: undefined });
  try {
    const page = await ctx.newPage();
    await openDeviceLink(page, secret);

    // The real thing (brief's own requirement), not a stubbed transport —
    // this scenario never navigates again, so there is no reload for a
    // context-wide block to fight.
    await ctx.setOffline(true);

    await pressAddPoints(page, 10);
    await pressAddPoints(page, 20);

    await expect(page.getByText(OFFLINE_TEXT)).toBeVisible();
    const dbName = queueDbName(fixture.fixtureId);
    await expect.poll(() => queueRowCount(page, dbName)).toBe(2);
    expect((await ledgerOf(request, fixture.fixtureId)).length, "nothing reached the server while offline").toBe(0);

    await ctx.setOffline(false);

    await expect(page.getByText(SYNCED_TEXT)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => queueRowCount(page, dbName)).toBe(0);

    const ledger = await ledgerOf(request, fixture.fixtureId);
    expect(ledger.map((e) => ({ type: e.type, payload: e.payload }))).toEqual(
      scoreEvents(fixture.homeEntrantId, 10, 20),
    );
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
});

test("a 409 mid-drain resyncs against the ledger and completes with no duplicates", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { fixture, secret } = await setupOfflineFixture(request, "conflict");
  const ctx = await browser.newContext({ storageState: undefined });
  try {
    const page = await ctx.newPage();
    await openDeviceLink(page, secret);

    const eventsUrl = (url: URL): boolean => url.pathname === `/api/v1/fixtures/${fixture.fixtureId}/events`;
    await page.route(eventsUrl, (route) => route.abort());

    await pressAddPoints(page, 5);
    await pressAddPoints(page, 15);
    const dbName = queueDbName(fixture.fixtureId);
    await expect.poll(() => queueRowCount(page, dbName)).toBe(2);

    // Out-of-band: the standalone `request` fixture is its own
    // APIRequestContext (never a browser request, so `page.route` above never
    // sees it) landing a genuine, server-accepted write at expected_seq=0 —
    // the EXACT slot the client's first queued event still believes is free.
    // A different `by` AND a sentinel `points` value so content comparison
    // alone (pipeline.ts's resolveConflict) unambiguously reads this as
    // foreign, never "our own event replayed".
    const outOfBand = await apiJson(request, `/api/v1/fixtures/${fixture.fixtureId}/events`, "POST", {
      expected_seq: 0,
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
      ...scoreEvents(fixture.awayEntrantId, 999),
      ...scoreEvents(fixture.homeEntrantId, 5, 15),
    ]);
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
});
