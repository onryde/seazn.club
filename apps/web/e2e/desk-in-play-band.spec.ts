import { test, expect } from "@playwright/test";
import { TAG, competitionPath, scoreFixture, seedRosteredFixture } from "./helpers";

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

  // The poll fires every 20s (in-play-band.tsx's POLL_MS) — advance virtual
  // time well past one tick, never a real sleep.
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
