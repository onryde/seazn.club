import { test, expect, type Page } from "@playwright/test";
import { expectNoHorizontalScroll, fixturePath, seedRosteredFixture, TAG } from "./helpers";
import { DOUBLE_SUBMIT_WINDOW_MS } from "../src/components/v2/scorepad/use-pad-pipeline";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";

// ScoringPad v3, R8 / #676 — THE SCOREBUG STRIP MUST NOT RE-FLOW.
//
// WHY THIS IS AN E2E. The strip is a centred flex row (`v3/scorebug.tsx`), so
// every item's position depends on every other item's width. `apps/web` vitest
// is `environment: "node"` — no DOM, no layout — so a builder test can assert
// that a slot RESERVES a width and can never assert that reserving it stopped
// anything moving. That is this file's whole job.
//
// WHAT #676 TURNED OUT TO BE. The register blamed the soft-commit hold:
// "`PadHostView.state` is the OPTIMISTIC fold while `PadHostView.events` is the
// CONFIRMED ledger". Untrue when filed — `view.events` IS
// `[...ledgerEvents, ...pendingEnvelopes.values()]`, the same list the fold
// consumes, so a held tap is in both. The real residue is that whenever the
// serve reader declines to name a server, badminton loses `server` AND `court`
// together and the band re-centres.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
//   PROVES: the geometry along the axis a scorer hits every rally — the
//   server's NAME changes on every side-out, and before the fix the slot was
//   only ever as wide as the name currently in it, so the whole row shifted.
//   Two names of wildly different length make that shift ~30 characters wide.
//   Also that the reservation did not buy stability with an overflow.
//   DOES NOT PROVE: the `reserved` (drift) state itself. Reaching it needs
//   `state` and `events` to genuinely disagree, which in a healthy system means
//   a `serverOverride` from a second writer — and the poll merges and
//   reconciles in the same step, so the window is a race rather than a state a
//   spec can sit in. Deliberately NOT faked with a conditional assertion, which
//   would pass whether or not it ever saw the state. The reserved state is
//   covered at builder and rendered-markup level
//   (`v3/__tests__/scorebug.test.ts`, `v3/skins/__tests__/*.test.ts`); its
//   browser coverage is an OWED check, not a claimed one.
//
// MOBILE FIRST (owner standing ruling: design for mobile, never shrink). 320 is
// first in the matrix and gets the hard case of its own below, because a
// reservation is exactly the kind of change that trades a re-flow for a
// horizontal scroll.

const SHORT = "Al";
// Long, and made of several SHORT words on purpose: one unbreakable 30-char
// token would be a width floor for the UNRESERVED render too, so the test
// would pass without the fix and prove nothing.
const LONG = "Bartholomew Quartermaine Fitzwilliam";
/** Derived, never a second copy: hardcoding a substring of LONG lets a rename
 *  quietly vacate the negative assertions that use it. */
const LONG_FIRST_WORD = LONG.split(" ")[0]!;
// The 320px hard case: a long SINGLE WORD cannot wrap, so it is the value most
// likely to make a reserved slot overflow its band.
const LONG_UNBREAKABLE = "Featherstonehaughsmythe";

function pad(page: Page) {
  return page.locator('[data-role="v3-pad"]');
}
function scorebug(page: Page) {
  return pad(page).locator('[data-role="v3-scorebug"]');
}
function half(page: Page, side: "home" | "away") {
  return scorebug(page).locator(".grid > button").nth(side === "home" ? 0 : 1);
}
/** One strip item. Resolves the VISIBLE layer: `data-strip-item-id` sits on the
 *  inner span, never on the reserving grid wrapper, precisely so that
 *  `toHaveText`/`toContainText` — which read `textContent`, not `innerText`,
 *  and so include `visibility:hidden` subtrees — cannot see the sizers. */
function strip(page: Page, id: string) {
  return scorebug(page).locator(`[data-strip-item-id="${id}"]`);
}

/** A rally tap that clears the double-submit guard. DERIVED from
 *  `DOUBLE_SUBMIT_WINDOW_MS`, never a flat literal — the treatment
 *  `scorepad-v3-badminton.spec.ts`'s `tapRally` has carried since R7-46 and
 *  that #699 applied to the offline specs. Two identical taps closer together
 *  than the window are one tap, and the second is silently dropped. */
async function tapRally(page: Page, side: "home" | "away"): Promise<void> {
  await half(page, side).click();
  await page.waitForTimeout(DOUBLE_SUBMIT_WINDOW_MS + 60);
}

async function boxOf(page: Page, id: string) {
  const box = await strip(page, id).boundingBox();
  expect(box, `strip item ${id} has no box — it is not rendered`).not.toBeNull();
  return box!;
}

/** The strip band's own rect — its height is the wrap-point witness: a row that
 *  re-wraps between states gets taller or shorter. */
async function bandBox(page: Page) {
  const box = await scorebug(page).locator('[data-role="v3-scorebug"] > div').last().boundingBox();
  expect(box, "the strip band has no box").not.toBeNull();
  return box!;
}

// Budget DERIVED from the constants — a flat timeout beside a derived cost is a
// latent red here, and `HOLD_MS` is env-tunable (CI runs it at 3000), so a
// hard-coded budget fails in exactly the process where the short value is right.
const TAPS = 4;
test.setTimeout(Math.max(120_000, 60_000 + TAPS * (HOLD_MS + DOUBLE_SUBMIT_WINDOW_MS + 2_000)));

async function openPad(page: Page, width: number, homeName: string, awayName: string) {
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Strip Geometry ${width} ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  return fx;
}

for (const width of [320, 768, 1280] as const) {
  test(`R8/#676 — the strip does not re-flow when the server's name changes (${width}px)`, async ({
    page,
  }) => {
    await openPad(page, width, SHORT, LONG);

    // Home wins, so BWF Law 10.1 makes home the next server: the SHORT name
    // lands in the slot.
    await tapRally(page, "home");
    await expect(strip(page, "server")).toHaveText(new RegExp(`\\b${SHORT}\\b`), { timeout: 20_000 });
    // The locator must see the VISIBLE layer only. If `data-strip-item-id` ever
    // moves back onto the reserving wrapper, textContent picks up every sizer
    // and this assertion goes vacuous — so pin the negative directly.
    await expect(
      strip(page, "server"),
      "the located element must not expose the reserve sizers' text",
    ).not.toContainText(LONG_FIRST_WORD);

    const gamesShort = await boxOf(page, "games");
    const bandShort = await bandBox(page);
    await expectNoHorizontalScroll(page);

    // Away wins and takes service: the LONG name lands in the same slot.
    await tapRally(page, "away");
    await expect(strip(page, "server")).toContainText("Bartholomew", { timeout: 20_000 });
    await expect(strip(page, "server")).not.toContainText(new RegExp(`\\b${SHORT}\\b`));

    const gamesLong = await boxOf(page, "games");
    const bandLong = await bandBox(page);

    expect(
      Math.abs(gamesLong.x - gamesShort.x),
      "the games item must not move when the SERVER item's value changes length",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(bandLong.height - bandShort.height),
      "the band must not re-wrap between the two states — same wrap points, same height",
    ).toBeLessThanOrEqual(1);

    await expectNoHorizontalScroll(page);
    await expect(strip(page, "games")).toBeVisible();
    await expect(strip(page, "court")).toBeVisible();
  });
}

test("R8/#676 — a long UNBREAKABLE surname does not overflow the band at 320px", async ({ page }) => {
  // The specific regression a reservation can introduce, and the reason the
  // owner's mobile ruling makes this non-optional: the slot now reserves the
  // width of the OPPONENT's name at every width, so the widest candidate is
  // load-bearing even when the short name is the one on screen. A single
  // unbreakable token cannot wrap, so this is the worst case there is.
  await openPad(page, 320, SHORT, LONG_UNBREAKABLE);

  await expectNoHorizontalScroll(page);

  await tapRally(page, "home"); // SHORT name shown, LONG one reserved
  await expect(strip(page, "server")).toHaveText(new RegExp(`\\b${SHORT}\\b`), { timeout: 20_000 });
  await expectNoHorizontalScroll(page);

  await tapRally(page, "away"); // the unbreakable name itself now on screen
  await expect(strip(page, "server")).toContainText(LONG_UNBREAKABLE, { timeout: 20_000 });
  await expectNoHorizontalScroll(page);
});
