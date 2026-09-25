import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG } from "./helpers";

/** The console's own status badge copy, read from the dictionary the page
 *  renders from rather than typed here, so a copy change moves this test with
 *  it. */
const UI = JSON.parse(
  readFileSync(new URL("../src/dictionaries/en/ui.json", import.meta.url), "utf8"),
) as Record<string, string>;
const SCHEDULED = UI["score.status.scheduled"]!;
const IN_PLAY = UI["score.status.in_play"]!;

// A scorer who leaves the console and comes back with the browser's Back button
// must see the match as it is NOW, not as it was when they left.
//
// Back/Forward does not re-render the page on the server: Next re-uses the
// router's cached RSC payload, so the console remounts on the ledger it held
// when the scorer navigated away. The pad used to be rescued from that by its
// own mount-time report to the chrome, which forced a full re-read — the same
// report that greyed Start match under a scorer's tap at every load
// (`useReportLedgerChanges`, v3/pad-host.tsx). With that report gone, the
// only thing that can learn what was written in between is the pad's stream,
// and a realtime channel signals only FUTURE writes while the first poll tick
// is 15s away. So `use-fixture-stream.ts` reads once as it subscribes.
//
// This test takes the poll out of the picture instead of racing it: the page
// clock is paused before Back, so the 15s interval never fires. Only a read
// that is NOT on a timer — the catch-up on subscribe — can move the console
// off its stale "scheduled" state. Without it the Start button stays up
// forever and this test reds deterministically, not on one run in thirty.
test("console: Back to a console left before kick-off shows the match started elsewhere", async ({ page }) => {
  test.setTimeout(90_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `Back Nav ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `BN Home ${TAG}` }],
    away: [{ fullName: `BN Away ${TAG}` }],
  });
  const consolePath = await fixturePath(page.request, fx.fixtureId);
  const start = page.locator('[data-testid="score-start-match"]');
  // The console header's status badge (`fixture-console.tsx`, beside the
  // title), driven by the same `live.status` that decides whether Start match
  // renders. The POSITIVE half of "started": a console that failed to render
  // at all cannot pass on Start's absence alone.
  const status = page.locator("main h1 + span.badge");
  const padTokenRequest = () =>
    page.waitForRequest((req) => req.url().includes(`/api/v1/public/fixtures/${fx.fixtureId}/realtime-token`), {
      timeout: 20_000,
    });

  // Installed before the first page so every timer the pad arms is a fake one
  // the pause below can hold. Time flows normally until then.
  await page.clock.install();

  const firstMount = padTokenRequest();
  await page.goto(consolePath);
  await firstMount;
  await expect(start, "a scheduled fixture's console offers Start match").toBeVisible({ timeout: 20_000 });
  await expect(status, "the status badge locator must match exactly one element").toHaveCount(1);
  await expect(status).toHaveText(SCHEDULED);

  // The match starts somewhere else — a second official's device, the API.
  const started = await apiJson(page.request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  expect(started.status, `core.start → ${JSON.stringify(started.error)}`).toBeLessThan(300);

  // Leave in-app — a client-side navigation, so the console's payload stays in
  // the router cache for Back to re-use.
  const crumbs = page.locator('nav[aria-label="Breadcrumb"] a');
  await expect(crumbs.last(), "the console's breadcrumb must link somewhere to leave to").toBeVisible();
  await crumbs.last().click();
  await expect(page).not.toHaveURL((url) => url.pathname === consolePath, { timeout: 20_000 });
  await expect(start).toHaveCount(0);

  // Freeze every timer from here: no poll tick can deliver the start.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);

  // Back. The router serves the console from its cache — no server render —
  // which is the stale seed this test is about.
  //
  // A prefetch of the console (a link to it coming into view, or the router
  // warming its cache) is also an `rsc: 1` request for this path, but it
  // renders nothing into the page, so it cannot freshen the seed. Next marks
  // those with `next-router-prefetch` (and, for a per-segment prefetch,
  // `next-router-segment-prefetch` — app-router-headers.js); only the rest
  // count as a render.
  const consoleRenders: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    const headers = req.headers();
    const prefetch = headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined;
    if (url.pathname === consolePath && headers["rsc"] === "1" && !prefetch) consoleRenders.push(req.url());
  });
  const remount = padTokenRequest();
  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === consolePath, { timeout: 20_000 });
  await remount;

  await expect(status, "the console must show the match the server already started").toHaveText(IN_PLAY);
  await expect(start, "a stale Start match is still on offer after Back").toHaveCount(0);
  // The precondition, asserted: Back really did re-use the cached page. Were
  // it re-rendered on the server, the seed would be fresh and this test would
  // pass with no catch-up at all.
  expect(consoleRenders, "Back re-rendered the console on the server, so its seed was never stale").toEqual([]);
});
