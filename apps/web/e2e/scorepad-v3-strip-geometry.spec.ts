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
// anything moving, nor whether the ink fits the box it reserved.
//
// THE LOCATOR THAT COST A ROUND. The first version of this file located the pad
// as `[data-role="v3-pad"]`. No such attribute exists anywhere in the product —
// `grep -ran v3-pad` matched this file and nothing else — so all four cases
// failed in setup, having passed `playwright test --list` every time. `--list`
// proves a spec COLLECTS; it says nothing about whether a selector resolves.
// The pad's real wrapper is `[data-testid="score-pad"]`
// (`components/v2/fixture-console.tsx`), which is what every other scorepad
// spec has always used.
//
// WHERE THE RECTS COME FROM. `data-strip-reserve="true"` marks the reserving
// WRAPPER, in BOTH the answered and the reserved state — that element's box IS
// the reserved cell. `data-strip-item-id` sits on the inner `place-items-center`
// span, whose box is its own text and NOT the reservation, so a rect read there
// answers a different question.

const SHORT = "Al";
// Long, and made of several SHORT words on purpose: one unbreakable 30-char
// token would be a width floor for the UNRESERVED render too, so the test would
// pass without the fix and prove nothing.
const LONG = "Bartholomew Quartermaine Fitzwilliam";
/** Derived, never a second copy: hardcoding a substring of LONG lets a rename
 *  quietly vacate the negative assertions that use it. */
const LONG_FIRST_WORD = LONG.split(" ")[0]!;
// The 320px hard case: a long SINGLE WORD has no break opportunity, so it is
// the value most likely to overflow — and, under the tile root's
// `overflow-hidden`, to be CLIPPED without the page ever scrolling.
const LONG_UNBREAKABLE = "Featherstonehaughsmythe";
// EXTREME: long enough that the reserved cell cannot fit 320 at all, which is
// the only regime where a min-content FLOOR can bind. Used solely to find out
// whether the min-w-0 guard has any visible consequence.
const EXTREME_UNBREAKABLE = "Featherstonehaughsmythewolddemortimerbrightwell";

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function scorebug(page: Page) {
  return pad(page).locator('[data-role="v3-scorebug"]');
}
function half(page: Page, side: "home" | "away") {
  return scorebug(page).locator(".grid > button").nth(side === "home" ? 0 : 1);
}
/** One strip item's VISIBLE layer. */
function strip(page: Page, id: string) {
  return scorebug(page).locator(`[data-strip-item-id="${id}"]`);
}
/** The reserving WRAPPER around one strip item — the element whose width is
 *  actually being held. Present in both states; in the reserved state the item
 *  has no id, so that case is located by `data-strip-reserved` instead. */
function reserveWrapper(page: Page, id: string) {
  return scorebug(page)
    .locator('[data-strip-reserve="true"]')
    .filter({ has: page.locator(`[data-strip-item-id="${id}"]`) });
}

async function tapRally(page: Page, side: "home" | "away"): Promise<void> {
  await half(page, side).click();
  await page.waitForTimeout(DOUBLE_SUBMIT_WINDOW_MS + 60);
}

async function boxOf(loc: ReturnType<typeof strip>) {
  const box = await loc.boundingBox();
  expect(box, "element has no box — it is not rendered").not.toBeNull();
  return box!;
}

/** The strip band itself — the `flex-wrap` row. Its height is the wrap-point
 *  witness: a row that re-wraps between states gets taller or shorter. */
function band(page: Page) {
  return scorebug(page).locator("div.flex-wrap").last();
}

/** Does this element's ink exceed its own box? `scrollWidth > clientWidth` is
 *  the clip test the no-horizontal-scroll gate cannot see: under the tile
 *  root's `overflow-hidden` the page never scrolls, the box yields, and the
 *  text is simply cut off at both ends by the centring. */
async function inkOverflow(page: Page, selector: string): Promise<{ scrollW: number; clientW: number }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { scrollW: -1, clientW: -1 };
    return { scrollW: el.scrollWidth, clientW: el.clientWidth };
  }, selector);
}

const TAPS = 4;
test.setTimeout(Math.max(120_000, 60_000 + TAPS * (HOLD_MS + DOUBLE_SUBMIT_WINDOW_MS + 2_000)));

async function openPad(page: Page, width: number, slug: string, homeName: string, awayName: string) {
  const fx = await seedRosteredFixture(page.request, {
    // `slug` distinguishes fixtures that share a width — two tests both at 320
    // previously collided on one label.
    label: `V3 Strip Geom ${slug} ${width} ${TAG}`,
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
    await openPad(page, width, "reflow", SHORT, LONG);

    // Home wins, so BWF Law 10.1 makes home the next server: the SHORT name.
    await tapRally(page, "home");
    await expect(strip(page, "server")).toContainText(SHORT, { timeout: 20_000 });
    await expect(
      strip(page, "server"),
      "the located element must not expose the reserve sizers' text",
    ).not.toContainText(LONG_FIRST_WORD);

    const gamesShort = await boxOf(strip(page, "games"));
    const wrapShort = await boxOf(reserveWrapper(page, "server"));
    const bandShort = await boxOf(band(page));
    await expectNoHorizontalScroll(page);

    // Away wins and takes service: the LONG name lands in the same slot.
    await tapRally(page, "away");
    await expect(strip(page, "server")).toContainText(LONG_FIRST_WORD, { timeout: 20_000 });

    const gamesLong = await boxOf(strip(page, "games"));
    const wrapLong = await boxOf(reserveWrapper(page, "server"));
    const bandLong = await boxOf(band(page));

    console.log(
      `[${width}] games.x ${gamesShort.x}->${gamesLong.x} | wrapper.w ${wrapShort.width}->${wrapLong.width}` +
        ` | band.h ${bandShort.height}->${bandLong.height}`,
    );

    expect(
      Math.abs(wrapLong.width - wrapShort.width),
      "the RESERVED CELL must be the same width whichever name is in it",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(gamesLong.x - gamesShort.x),
      "the games item must not move when the server item's value changes length",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(bandLong.height - bandShort.height),
      "the band must not re-wrap between the two states — same wrap points, same height",
    ).toBeLessThanOrEqual(1);

    await expectNoHorizontalScroll(page);
    await expect(strip(page, "court")).toBeVisible();
  });
}

test("R8/#676 — a long UNBREAKABLE surname at 320px: does the band overflow or clip?", async ({
  page,
}) => {
  // THE DELIVERABLE. The reservation makes the OPPONENT's name load-bearing at
  // every width, so the widest candidate sizes the cell even while the short
  // name is on screen. A single unbreakable token has no break opportunity, so
  // this is the worst case there is — and the failure mode is invisible to the
  // no-horizontal-scroll gate, because the tile root is `overflow-hidden`: the
  // page never scrolls, the box yields, and the ink is clipped instead.
  await openPad(page, 320, "clip", SHORT, LONG_UNBREAKABLE);
  await expectNoHorizontalScroll(page);

  await tapRally(page, "home"); // SHORT shown, the unbreakable name RESERVED
  await expect(strip(page, "server")).toContainText(SHORT, { timeout: 20_000 });
  const reservedCell = await boxOf(reserveWrapper(page, "server"));
  const bandShort = await boxOf(band(page));
  const inkShort = await inkOverflow(page, '[data-strip-item-id="server"]');
  await expectNoHorizontalScroll(page);

  await tapRally(page, "away"); // the unbreakable name itself now on screen
  await expect(strip(page, "server")).toContainText(LONG_UNBREAKABLE, { timeout: 20_000 });
  const shownCell = await boxOf(reserveWrapper(page, "server"));
  const bandLong = await boxOf(band(page));
  const inkLong = await inkOverflow(page, '[data-strip-item-id="server"]');
  const shownSpan = await boxOf(strip(page, "server"));

  console.log(
    `[320 clip] reservedCell.w ${reservedCell.width} shownCell.w ${shownCell.width}` +
      ` | band.h ${bandShort.height}->${bandLong.height} band.w ${bandLong.width}` +
      ` | span.w ${shownSpan.width} ink ${inkShort.scrollW}/${inkShort.clientW} -> ${inkLong.scrollW}/${inkLong.clientW}`,
  );

  await expectNoHorizontalScroll(page);
  // The cell must not change width between the two states — that is the claim.
  expect(
    Math.abs(shownCell.width - reservedCell.width),
    "the reserved cell and the shown cell must be one width",
  ).toBeLessThanOrEqual(1);
  // And the ink must fit the box it reserved: scrollWidth > clientWidth here
  // means the surname is CLIPPED, which the page-scroll gate cannot see.
  expect(
    inkLong.scrollW,
    `the shown surname is clipped: scrollWidth ${inkLong.scrollW} > clientWidth ${inkLong.clientW}`,
  ).toBeLessThanOrEqual(inkLong.clientW + 1);
  // The band must stay inside the viewport.
  expect(bandLong.width, "the band must fit 320px").toBeLessThanOrEqual(320);
});

test("R8/#676 — MEASUREMENT: do M10/M11 (the min-w-0 mutants) have a visible consequence at 320?", async ({
  page,
}) => {
  // Two mutants were found surviving a branch review and are now killed in unit
  // tests, but a class-level guard only says the class is THERE. This measures
  // what removing it actually does to the rendered box at 320, by stripping the
  // class in the live DOM — the same render the mutant would produce, with no
  // rebuild of a server other workstreams are sharing.
  //
  //   M10 — `min-w-0` off the reserving WRAPPER (a flex item of the band)
  //   M11 — `min-w-0` off the SIZERS (grid items whose min-content sets the
  //         track's automatic minimum)
  await openPad(page, 320, "mutant", SHORT, EXTREME_UNBREAKABLE);
  await tapRally(page, "home"); // SHORT shown, the unbreakable name RESERVED
  await expect(strip(page, "server")).toContainText(SHORT, { timeout: 20_000 });

  const measure = async (tag: string) => {
    const b = await boxOf(band(page));
    const cell = await boxOf(reserveWrapper(page, "server"));
    const doc = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    console.log(
      `[320 ${tag}] band.w ${b.width} band.h ${b.height} cell.w ${cell.width}` +
        ` doc ${doc.scrollW}/${doc.clientW}${doc.scrollW > doc.clientW + 1 ? "  <-- PAGE OVERFLOWS" : ""}`,
    );
    return { band: b, cell, doc };
  };

  const base = await measure("baseline");

  // M10 — drop min-w-0 from the wrapper. VERIFIED APPLIED: a runtime mutation
  // that silently did nothing reads exactly like a surviving mutant.
  const m10Removed = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-strip-reserve="true"]')];
    els.forEach((el) => el.classList.remove("min-w-0"));
    return {
      touched: els.length,
      leftover: els.filter((el) => el.classList.contains("min-w-0")).length,
    };
  });
  expect(m10Removed.touched, "M10 must actually find wrappers to mutate").toBeGreaterThan(0);
  expect(m10Removed.leftover, "M10 must actually remove the class").toBe(0);
  const m10 = await measure("M10 wrapper");

  await page.reload();
  await expect(strip(page, "server")).toContainText(SHORT, { timeout: 20_000 });

  // M11 — drop min-w-0 from the sizers only. Same verification.
  const m11Removed = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-strip-reserve="true"] .invisible')];
    els.forEach((el) => el.classList.remove("min-w-0"));
    return {
      touched: els.length,
      leftover: els.filter((el) => el.classList.contains("min-w-0")).length,
    };
  });
  expect(m11Removed.touched, "M11 must actually find sizers to mutate").toBeGreaterThan(0);
  expect(m11Removed.leftover, "M11 must actually remove the class").toBe(0);
  const m11 = await measure("M11 sizers");

  // POSITIVE CONTROL. If neither mutant moves a pixel, the honest question is
  // whether this harness can move ANY pixel. `whitespace-nowrap` on the sizers
  // removes every break opportunity, which must widen the reserved cell — if
  // even THIS does nothing, the measurement is vacuous and the M10/M11 result
  // means nothing.
  await page.evaluate(() => {
    document
      .querySelectorAll('[data-strip-reserve="true"] .invisible')
      .forEach((el) => el.classList.add("whitespace-nowrap"));
  });
  const control = await measure("CONTROL nowrap");
  // Asserted on HEIGHT, not width, and the reason is itself the finding: at 320
  // the reserved cell is already capped by the space the band has to give
  // (band 246 wide, cell 222), so NOTHING can widen it — the invisible sizers
  // simply overflow their own cell unseen. Height is the metric that still
  // responds, and it does (84 -> 68), which is what proves this harness can
  // move pixels at all and that the M10/M11 result below is a real measurement
  // rather than a mutation that quietly failed to apply.
  expect(
    Math.abs(control.band.height - base.band.height),
    "positive control: forcing nowrap on the sizers MUST change the band geometry",
  ).toBeGreaterThan(1);

  // The BASELINE is what this asserts; the mutant numbers are the deliverable
  // and are reported rather than asserted — a mutant that turns out harmless at
  // one fixture width is a fact to record, not a test failure.
  expect(base.doc.scrollW, "baseline: the page must not overflow at 320").toBeLessThanOrEqual(
    base.doc.clientW + 1,
  );
  expect(m10.band.width).toBeGreaterThan(0);
  expect(m11.band.width).toBeGreaterThan(0);
});
