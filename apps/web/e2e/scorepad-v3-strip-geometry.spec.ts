import { test, expect, type Page } from "@playwright/test";
import { fixturePath, seedRosteredFixture, TAG } from "./helpers";
import { DOUBLE_SUBMIT_WINDOW_MS } from "../src/components/v2/scorepad/use-pad-pipeline";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";

// ScoringPad v3, R8 / #676 — THE SCOREBUG STRIP MUST NOT RE-FLOW.
//
// WHY THIS FILE EXISTS, AND WHY IT IS AN E2E. The strip is a centred flex row
// (`v3/scorebug.tsx`), so the position of every item depends on the width of
// every other item. `apps/web` vitest is `environment: "node"` — no DOM, no
// layout — so a builder test can assert that a slot RESERVES a width and can
// never assert that reserving it actually stopped anything from moving. That
// is this file's whole job, and it is the one claim in the fix that only a
// browser can settle.
//
// WHAT #676 TURNED OUT TO BE. The register entry blamed the soft-commit hold:
// "`PadHostView.state` is the OPTIMISTIC fold while `PadHostView.events` is
// the CONFIRMED ledger, so they disagree for the whole hold". That was untrue
// when it was filed — `view.events` is `pipeline.events`, which IS
// `[...ledgerEvents, ...pendingEnvelopes.values()]`, the same list the fold
// consumes, so a held tap is in both and the hold cannot desynchronise them.
// The REAL residue is this: whenever the serve reader legitimately declines to
// name a server, badminton's row loses `server` AND `court` together (they die
// on the same predicate) and the whole band silently re-centres.
//
// WHAT THIS FILE DRIVES. Forcing a genuine ledger/state divergence in a
// browser needs a second writer, so this exercises the SAME geometry along the
// axis a scorer actually hits every rally: the server's NAME changes on every
// side-out, and the two names here are deliberately of wildly different
// length. Before the fix the `server` slot was as wide as whichever name was
// currently in it, so the entire row shifted on every side-out. After it, the
// slot reserves both names' width and nothing moves. Same mechanism, same
// assertion, and reachable without a second device.
//
// MOBILE FIRST (owner ruling, R8): 320 is checked FIRST and is the width the
// reservation is most likely to break, because a reservation implemented as a
// hard `min-width` would trade this re-flow for a horizontal scroll. The
// no-h-scroll assertion below is not a formality — it is the specific
// regression the fix could introduce.

const SHORT = "Al";
// Long, and deliberately made of several SHORT words: an unbreakable 30-char
// token would be a width floor for the plain (unreserved) render too, which
// would make this test pass for the wrong reason.
const LONG = "Bartholomew Quartermaine Fitzwilliam";

function pad(page: Page) {
  return page.locator('[data-role="v3-pad"]');
}
function scorebug(page: Page) {
  return pad(page).locator('[data-role="v3-scorebug"]');
}
function half(page: Page, side: "home" | "away") {
  return scorebug(page).locator(".grid > button").nth(side === "home" ? 0 : 1);
}
function strip(page: Page, id: string) {
  return scorebug(page).locator(`[data-strip-item-id="${id}"]`);
}

/** A rally tap that clears the double-submit guard.
 *
 *  DERIVED from `DOUBLE_SUBMIT_WINDOW_MS`, never a flat literal — the same
 *  treatment `scorepad-v3-badminton.spec.ts`'s own `tapRally` has carried
 *  since R7-46 and that #699 applied to the offline specs. Two taps closer
 *  together than the window with an identical payload are one tap as far as
 *  the pipeline is concerned, and the SECOND is silently dropped. */
async function tapRally(page: Page, side: "home" | "away"): Promise<void> {
  await half(page, side).click();
  await page.waitForTimeout(DOUBLE_SUBMIT_WINDOW_MS + 60);
}

/** The x-centre of a strip item, in page coordinates. */
async function centreX(page: Page, id: string): Promise<number> {
  const box = await strip(page, id).boundingBox();
  expect(box, `strip item ${id} has no box — it is not rendered`).not.toBeNull();
  return box!.x + box!.width / 2;
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

// Budget DERIVED from the constants, per this repo's own rule that a flat
// timeout beside a derived cost is a latent red: every tap soft-commits and
// the guard clearance is paid per tap. `HOLD_MS` is env-tunable (CI runs it
// at 3000), so a hard-coded budget would fail in exactly the process where the
// short value is correct.
const TAPS = 4;
test.setTimeout(Math.max(120_000, 60_000 + TAPS * (HOLD_MS + DOUBLE_SUBMIT_WINDOW_MS + 2_000)));

for (const width of [320, 768, 1280] as const) {
  test(`R8/#676 — the scorebug strip does not re-flow when the server's name changes (${width}px)`, async ({
    page,
  }) => {
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Strip Geometry ${width} ${TAG}`,
      sportKey: "badminton",
      variantKey: "bwf",
      entrantKind: "individual",
      home: [{ fullName: SHORT }],
      away: [{ fullName: LONG }],
      emitCoreStart: true,
    });

    await page.setViewportSize({ width, height: 900 });
    await page.goto(await fixturePath(page.request, fx.fixtureId));
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });

    // Home wins the rally, so BWF Law 10.1 makes home the next server: the
    // SHORT name lands in the slot.
    await tapRally(page, "home");
    await expect(strip(page, "server")).toContainText(SHORT, { timeout: 20_000 });
    const gamesWithShortServer = await centreX(page, "games");
    expect(await hasHorizontalScroll(page), `no horizontal scroll at ${width}px`).toBe(false);

    // Away wins the next rally and takes service: the LONG name lands in the
    // same slot. Without the reservation the slot grows by ~30 characters and
    // the centred row shifts everything else along with it.
    await tapRally(page, "away");
    await expect(strip(page, "server")).toContainText("Bartholomew", { timeout: 20_000 });
    const gamesWithLongServer = await centreX(page, "games");

    expect(
      Math.abs(gamesWithLongServer - gamesWithShortServer),
      "the games item must not move when the SERVER item's value changes length",
    ).toBeLessThanOrEqual(1);

    // The reservation must not have bought stability with an overflow — the
    // specific regression a hard min-width would introduce, and the reason
    // 320 is in this matrix at all.
    expect(await hasHorizontalScroll(page), `no horizontal scroll at ${width}px after the side-out`).toBe(
      false,
    );

    // And the band must still be doing its job, not merely holding still.
    await expect(strip(page, "games")).toBeVisible();
    await expect(strip(page, "court")).toBeVisible();
  });
}
