import { test, expect } from "@playwright/test";
import { TAG, apiJson, competitionPath, scoreFixture, seedRosteredFixture } from "./helpers";

/**
 * Competition Desk W3, Task 7 — the live in-play band
 * (docs/superpowers/specs/2026-09-02-competition-desk-design.md §"W3 — Tasks
 * 1 and 6-10", Task 7). Two things the unit suite (node environment, no DOM)
 * cannot see at all: the band's real production trigger, and its poll.
 *
 * `in_play` is DERIVED from `has("core.start")`
 * (`fixtureStatusFromFold`, `server/engine-db/append-event.ts`), never a
 * stored flag a test can set directly — so this seeds a REAL `core.start`
 * event via `seedRosteredFixture({ emitCoreStart: true })`, never
 * `setFixtureStatusSql`, which would leave `event_count`/`started_at` at
 * their defaults with no engine event behind them and prove nothing about
 * the real path an organiser drives.
 */
test("the competition page shows a live band for a real core.start, with NO SCORE at zero events, and it clears on the next poll once the fixture is decided", async ({
  page,
  request,
}) => {
  // `generic`/`score` (not football) — `scoreFixture` posts a bare
  // `generic.result`, which only the generic sport module accepts; every
  // other caller of `scoreFixture` in this repo pairs it with this same
  // sport for exactly that reason.
  const fx = await seedRosteredFixture(request, {
    label: `Desk Band ${TAG}`,
    sportKey: "generic",
    variantKey: "score",
    entrantKind: "individual",
    home: [{ fullName: `Desk Band Home ${TAG}` }],
    away: [{ fullName: `Desk Band Away ${TAG}` }],
    emitCoreStart: true,
  });
  const compUrl = await competitionPath(request, fx.competitionId);

  // Installed BEFORE navigation, so it is in place before the band's own
  // `setInterval` is ever registered at hydration.
  await page.clock.install();
  await page.goto(compUrl, { waitUntil: "load" });

  const band = page.getByTestId("desk-in-play-band");
  await expect(band, "band did not render for a fixture with a real core.start").toBeVisible();
  await expect(band).toContainText("NO SCORE");

  // Decide it — a real `generic.result` event (scoreFixture), never a
  // status patch, so the fixture's derived status genuinely leaves in_play.
  await scoreFixture(request, fx.fixtureId, 2, 1);

  // The band still shows the (now stale) card until its next poll — proves
  // the SSR snapshot alone would never self-correct, only the poll does.
  await expect(band, "band vanished before its own poll ran — this is not proving the poll").toBeVisible();

  // The live poll fires every 20s (`LIVE_POLL_MS`, band-poll.ts) — advance
  // virtual time well past one tick, never a real sleep.
  await page.clock.fastForward("00:21");

  await expect(
    page.getByTestId("desk-in-play-band"),
    "band still shows a decided fixture after its own poll ran",
  ).toHaveCount(0);
});

/**
 * Regression: a competition with nothing live renders no band at all — the
 * far more common case than the one above, and the one the unit guard
 * mutation (in-play-band.test.tsx) pins in isolation. Paired with the
 * positive case above in the SAME file so this negative cannot pass
 * vacuously against a page that failed to load: a locator that resolves to
 * zero elements satisfies "absent" whether or not the rest of the page
 * rendered at all.
 */
test("regression: the band is absent off match day", async ({ page, request }) => {
  const fx = await seedRosteredFixture(request, {
    label: `Desk Band Quiet ${TAG}`,
    sportKey: "generic",
    variantKey: "score",
    entrantKind: "individual",
    home: [{ fullName: `Desk Band Quiet Home ${TAG}` }],
    away: [{ fullName: `Desk Band Quiet Away ${TAG}` }],
    emitCoreStart: false,
  });
  const compUrl = await competitionPath(request, fx.competitionId);
  await page.goto(compUrl, { waitUntil: "load" });

  // Prove the page actually loaded (the positive half of the pairing) before
  // trusting the zero count below.
  await expect(page.getByTestId("desk-ledger-row").first()).toBeVisible();
  await expect(page.getByTestId("desk-in-play-band")).toHaveCount(0);
});

/**
 * Competition Desk W4 — the band wakes a QUIET desk.
 *
 * W3 cleared the interval whenever nothing was in play, so a desk opened
 * before the day's first match polled nothing at all and the band appeared
 * only on a manual reload. The band renders `null` while quiet, which is
 * precisely why it cannot notice its own change: there is no card on screen
 * to update. `band-poll.ts` now keeps a slow poll running while quiet
 * (`QUIET_POLL_MS`, 90s) and speeds up once something is live.
 *
 * This is the only test that can see any of it. `apps/web` vitest is
 * `environment: "node"`, so no unit test ever runs the effect; the
 * schedule's unit tests drive `startBandPolling` directly with fake timers,
 * which proves the decisions and not the wiring. Here the real component
 * hydrates in a real browser and the tab is never reloaded.
 */
test("a quiet desk left open picks up the day's first fixture without a reload", async ({
  page,
  request,
}) => {
  const fx = await seedRosteredFixture(request, {
    label: `Desk Band Wake ${TAG}`,
    sportKey: "generic",
    variantKey: "score",
    entrantKind: "individual",
    home: [{ fullName: `Desk Band Wake Home ${TAG}` }],
    away: [{ fullName: `Desk Band Wake Away ${TAG}` }],
    emitCoreStart: false,
  });
  const compUrl = await competitionPath(request, fx.competitionId);

  await page.clock.install();
  await page.goto(compUrl, { waitUntil: "load" });

  // Quiet: no band, and the page really did render (the same pairing the
  // off-match-day regression above uses, for the same reason).
  await expect(page.getByTestId("desk-ledger-row").first()).toBeVisible();
  await expect(page.getByTestId("desk-in-play-band")).toHaveCount(0);

  // The match starts — a real `core.start` through the engine, out of band
  // from this tab, exactly as it would if a scorer opened the pad elsewhere.
  const started = await apiJson<{ seq: number }>(
    request,
    `/api/v1/fixtures/${fx.fixtureId}/events`,
    "POST",
    { expected_seq: 0, type: "core.start", payload: {} },
  );
  expect(started.status, `core.start failed: ${JSON.stringify(started.error)}`).toBeLessThan(300);

  // Nothing has told this tab. Past ONE live tick (20s) the band must still
  // be absent — if it appeared here the test would be passing on some other
  // mechanism (a router refresh, a stray fetch) rather than the quiet poll,
  // and the 90s cadence would be unproven.
  await page.clock.fastForward("00:25");
  await expect(
    page.getByTestId("desk-in-play-band"),
    "the band appeared before the quiet poll could have run — this test is not proving the quiet poll",
  ).toHaveCount(0);

  // Past the quiet period it wakes, with no reload and no interaction.
  await page.clock.fastForward("01:10");
  await expect(
    page.getByTestId("desk-in-play-band"),
    "a quiet desk never noticed the first fixture start — this is the W3 defect",
  ).toBeVisible();
});
