import { test, expect } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG } from "./helpers";

// A scorer who taps "Start match" the moment the console's pad is live must
// get a started match.
//
// CI run 35969236588 ("walkthrough 1/3", `scorepad-v3-soft-commit-visual`)
// clicked Start match and the ledger stayed `[]` for 20s. The trace's DOM
// snapshot at the instant of the click shows the button carrying `disabled`:
// the pad had just hydrated, its mount effect reported its SEED ledger through
// `onEvents`, and `fixture-console.tsx`'s `handlePadEvents` greyed every
// scoring control (`padSyncing`) for a `/state` + `/events` round trip that
// only re-read what the server had already rendered. A click on a disabled
// button is dropped, so nothing was sent. In CI the window was ~80ms and the
// test lost the race once; on a courtside connection the same round trip is
// seconds, on every load.
//
// This test makes that window as wide as a slow network would, instead of
// hoping to land in it: the console's `/state` read is HELD until the tap has
// been dispatched. With a mount-time refresh the button is still grey when
// the tap arrives and the ledger stays empty — deterministically, not one run
// in thirty. Without one there is nothing to hold, and the tap starts the
// match.
//
// `force: true` is the point, not a shortcut. A finger does not wait for an
// actionability check; Playwright's does, and that wait is exactly what hid
// this from every other spec that clicks Start match. The tap is made only
// once the pad's own mount effects have run (its realtime-token request is on
// the wire — see `openAndStart` in the soft-commit walkthrough) AND its
// stream's catch-up read has come back, so neither a tap on the still-inert
// server markup nor a tap that beats the catch-up is what is being measured.
test("console: a tap on Start match the moment the pad is live starts the match", async ({ page }) => {
  test.setTimeout(90_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `Start Tap ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `ST Home ${TAG}` }],
    away: [{ fullName: `ST Away ${TAG}` }],
  });

  let tapped = false;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldReads = 0;
  await page.route(
    (url) => url.pathname === `/api/v1/fixtures/${fx.fixtureId}/state`,
    async (route) => {
      if (!tapped) {
        heldReads += 1;
        await gate;
      }
      await route.continue();
    },
  );

  const padMounted = page.waitForRequest(
    (req) => req.url().includes(`/api/v1/public/fixtures/${fx.fixtureId}/realtime-token`),
    { timeout: 20_000 },
  );
  // The stream's catch-up on subscribe (`use-fixture-stream.ts`): one ledger
  // read once the token door has answered. On a fresh page it finds nothing
  // new, and must leave Start match alone — so the tap waits for it to have
  // landed and been handled, rather than beating it to the button.
  const catchUpRead = page.waitForResponse(
    (res) => {
      const url = new URL(res.url());
      return url.pathname === `/api/v1/fixtures/${fx.fixtureId}/events` && url.searchParams.get("since_seq") === "0";
    },
    { timeout: 20_000 },
  );
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await padMounted;
  await catchUpRead;
  // One frame and a task: React has committed whatever that read changed and
  // run its effects, so a report it triggered has already greyed the button.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));

  await page.getByRole("button", { name: "Start match", exact: true }).click({ force: true });
  tapped = true;
  release();

  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string }[]>(page.request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
        expect(res.status).toBe(200);
        return (res.data ?? []).map((e) => e.type);
      },
      {
        timeout: 20_000,
        message: `the tap on Start match was dropped — ${heldReads} console /state read(s) were in flight at mount, greying the button under it`,
      },
    )
    .toContain("core.start");
});
