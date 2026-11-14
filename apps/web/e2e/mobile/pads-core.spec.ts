// Split out of the former e2e/mobile.spec.ts (2026-11-13, verbatim move): ScoringPad v3 pads: cricket, tennis (singles + doubles), badminton, table tennis, volleyball, the clock-sport loop, carrom, boardgame and the hockey goal-type question.
// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — MOBILE_SPECS in playwright.config.ts).

import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  TAG,
  apiJson,
  expectNoHorizontalScroll,
  fixturePath,
  pickCricketPeople,
  seedRosteredFixture,
  overflowingIn,
} from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { V3_SKIN_CASES, type V3SkinRosterSlot } from "../v3-skin-catalog";
import { WIDTH_MATRIX_CLOCK_SPORTS } from "../v3-width-matrix-coverage";
import { consolePanel, openConsolePanel } from "../helpers/console-panels";
import { projectViewport, projectTag, expectScorebugNotClipped, padTile, assertTapFloor, assertV3PadHoldsAtThisWidth, v3Sheet } from "./_shared";

// Not serial: no test here reads state another test writes (no module-level `let` is shared), so one red does not skip the rest (AGENTS.md class 21).

/** Phone composition (spec 2026-09-02-scorepad-v3-phone-composition-design.md §6.2).
 *  Prints the visible control list so a reviewer can diff phone vs desktop by
 *  eye, then asserts the composition — not the box sizes — at this project's
 *  width. `model` "S": the scorebug halves are the rally buttons; "T": the
 *  first tile is the primary tap. */
async function expectPhoneComposition(page: Page, model: "S" | "T"): Promise<void> {
  const vp = projectViewport();
  if (!vp) return;
  const phone = vp.width < 768;
  await page.evaluate(() => window.scrollTo(0, 0));
  const controls = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('button, a[href], select, [role="button"]'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden";
      })
      .map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)),
  );
  console.log(`[phone-composition ${vp.width}x${vp.height}] ${controls.length} visible controls:\n  ${controls.join("\n  ")}`);

  // Header panel bar (owner 2026-11-11): Remote scoring and Stream are ONE button each at every width — the old phone icon
  // twins are gone (one DOM; a 2-column grid of equal buttons below md, Stream on its own full row).
  const handoverButton = page.locator('[data-role="device-handover"]');
  const handoverOffered = (await handoverButton.count()) > 0;
  const streamButton = page.locator('[data-role="fixture-stream"]');
  const streamOffered = (await streamButton.count()) > 0;
  expect(
    await page.locator('[data-role="device-handover-phone"], [data-role="fixture-stream-phone"]').count(),
    "no phone twin of the bar's buttons exists any more",
  ).toBe(0);
  // Anti-vacuity: both callers are an organiser's fixture page on the shared Pro org (AUTH_STATE), where streaming is
  // entitled since V426 — so the checks below must have something to check.
  expect(streamOffered, "an organiser's fixture page on an entitled org offers Stream").toBe(true);
  const detailsToggle = page.locator('[data-role="match-details-toggle"]');
  const scoringHeading = page.locator('[data-role="console-scoring"] h2');
  const activityToggle = page.locator('[data-role="v3-activity-toggle"]');
  const rows = page.locator('[data-role="v3-activity-row"]');
  const rowCount = await rows.count();

  if (phone) {
    if (handoverOffered) await expect(handoverButton).toBeVisible();
    if (streamOffered) await expect(streamButton).toBeVisible();
    // The bar below md: Stream owns a full row, every other button is the same width (a 2-column grid of equals).
    const bar = page.locator('[data-role="console-panel-bar"]');
    const barBox = await bar.boundingBox();
    expect(barBox, "the panel bar renders").not.toBeNull();
    const streamBox = await streamButton.boundingBox();
    expect(streamBox!.width, "Stream is a full-width row on a phone").toBeGreaterThanOrEqual(barBox!.width - 1);
    const others = await bar.locator("button:not([data-role='fixture-stream'])").evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().width)),
    );
    expect(others.length, "anti-vacuity: the bar offers buttons besides Stream").toBeGreaterThan(1);
    expect(new Set(others).size, `the bar's other buttons are equal widths, got ${others.join(",")}`).toBe(1);
    await expect(detailsToggle).toBeVisible();
    await expect(scoringHeading).toBeHidden();
    await expect(page.locator('[data-role="v3-headline"]')).toBeHidden();

    // The primary tap sits inside the first screen, with the page at the top.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const target =
      model === "S"
        ? page.locator('button[data-role="v3-scorebug-half"]').first()
        : page.locator('[data-role="v3-tiles"] button[data-tile-id]').first();
    const box = await target.boundingBox();
    expect(box, "primary tap target must render").not.toBeNull();
    // Claim 3 evidence: printed regardless of pass/fail, since Playwright
    // only echoes the assertion message on FAILURE and this task's report
    // needs the real measured numbers even from a passing run.
    console.log(
      `[phone-composition ${vp.width}x${vp.height}] primary tap target ("${model}"): y=${Math.round(box!.y)} height=${Math.round(box!.height)} bottom=${Math.round(box!.y + box!.height)} (first screen is ${vp.height}px)`,
    );
    expect(
      box!.y + box!.height,
      `primary tap target bottom edge (${Math.round(box!.y + box!.height)}px) must sit inside the ${vp.height}px first screen`,
    ).toBeLessThanOrEqual(vp.height);
    // Chrome down (design 2026-09-02): the panel bar sits BELOW the pad on a phone, so it never pushes the pad off the first screen.
    if ((await bar.count()) > 0) {
      const barTop = (await bar.boundingBox())!.y;
      expect(barTop, `the panel bar (top ${Math.round(barTop)}px) sits below the pad's primary tap (bottom ${Math.round(box!.y + box!.height)}px)`).toBeGreaterThanOrEqual(box!.y + box!.height);
    }
    // Nothing overlays it at its centre — a 44px box under a sheet is still a miss.
    expect(
      await target.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return at !== null && (at === el || el.contains(at));
      }),
    ).toBe(true);

    // Claim 1 (2026-09-02-scorepad-v3-phone-composition Task 6 — never
    // measured before this): scorebug.tsx line ~424 reasons that
    // `max-md:shrink-0` alone, with deliberately NO `whitespace-nowrap`
    // (its own comment: nowrap would reintroduce the min-content floor
    // `min-w-0` exists to remove), holds a RESERVED strip item at its full
    // natural width on the phone rail instead of letting flex-shrink squeeze
    // the cell until an unbroken token (a candidate name) overflows it.
    // Only badminton's flow (model "S") ever produces a reserved item here —
    // the "server" slot, skins/badminton.tsx:851 — cricket's strip carries no
    // `reserve` at all. Measured directly: the wrapper's rendered width
    // against its own scrollWidth; if shrink-0 were not holding, an unbroken
    // token would push scrollWidth past rect.width.
    if (model === "S") {
      const reservedServer = page.locator('[data-strip-reserve="true"]:has([data-strip-item-id="server"])');
      if ((await reservedServer.count()) > 0) {
        const [rectWidth, scrollW] = await reservedServer.first().evaluate((el) => [
          el.getBoundingClientRect().width,
          el.scrollWidth,
        ]);
        console.log(
          `[phone-composition ${vp.width}x${vp.height}] reserved "server" strip item: rect.width=${rectWidth} scrollWidth=${scrollW}`,
        );
        expect(
          scrollW,
          `reserved strip item content (scrollWidth ${scrollW}px) must not exceed its box (rect.width ${rectWidth}px) — max-md:shrink-0 must hold the width without whitespace-nowrap`,
        ).toBeLessThanOrEqual(Math.ceil(rectWidth));
      }
    }

    // Ledger: latest only until the toggle is tapped; every row after.
    if (rowCount > 1) {
      await expect(activityToggle).toBeVisible();
      expect(await rows.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetHeight > 0).length)).toBe(1);
      await activityToggle.click();
      // Re-count after expand: a tap's ledger row can land between the initial
      // `rowCount` snapshot and this click (badminton's two half-taps are
      // back-to-back with no poll), and `max-md:hidden` only toggles on the
      // rows that exist at render time — stale `rowCount` then reads "expected
      // 2, got 3 visible" even though the product is correct.
      const expandedCount = await rows.count();
      expect(await rows.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetHeight > 0).length)).toBe(
        expandedCount,
      );
      await activityToggle.click();
    }
    // Phone-only disclosures left on the console (the availability roster of a one-player sport): every toggle is visible.
    // The lineup cards are no longer disclosures — they live in the Lineup panel of the bar (2026-11-11), checked below.
    const disclosures = page.locator('[data-role="phone-disclosure-toggle"]');
    const disclosureCount = await disclosures.count();
    for (let i = 0; i < disclosureCount; i++) await expect(disclosures.nth(i)).toBeVisible();
    // The Lineup panel (offered for every team/pair sport): closed on arrival; opened, it shows ONE team behind the Home/Away
    // switch while the switch is visible (it is `md:hidden` — gate on it, never on a width literal), both cards otherwise.
    if (await openConsolePanel(page, "lineup", { optional: true })) {
      const cards = [page.getByTestId("lineup-team-home"), page.getByTestId("lineup-team-away")];
      let shown = 0;
      for (const card of cards) if (await card.isVisible()) shown++;
      const phoneSwitch = await page.getByTestId("lineup-team-switch").first().isVisible();
      expect(shown, phoneSwitch ? "exactly one lineup card shows with the Home/Away switch" : "both lineup cards show without the switch").toBe(
        phoneSwitch ? 1 : 2,
      );
      await expectNoHorizontalScroll(page);
      await consolePanel(page, "lineup").getByTestId("console-panel-close").click();
      await expect(consolePanel(page, "lineup"), "the close X closes the Lineup panel").toBeHidden();
    }
    // Review fix (Important 3, final review) — nothing here ever OPENED a
    // disclosure: every prior assertion ran with the body CLOSED, so
    // `phone-disclosure.tsx`'s open branch (`aria-expanded="true"`,
    // `hideLabel`, the body becoming visible) was unproven, and so was
    // `expectNoHorizontalScroll` in the one state that actually shipped a
    // 106px overflow at 320px. One disclosure is enough to witness it —
    // opening every row on every route would be expensive for no more
    // coverage, since they all share the same component.
    if (disclosureCount > 0) {
      const wrapper = page.locator('[data-role="phone-disclosure"]').first();
      const first = wrapper.locator('[data-role="phone-disclosure-toggle"]');
      const body = wrapper.locator("> div");
      await first.click();
      await expect(first).toHaveAttribute("aria-expanded", "true");
      await expect(body).toBeVisible();
      await expectNoHorizontalScroll(page);
      await first.click();
      await expect(first).toHaveAttribute("aria-expanded", "false");
    }
  } else {
    if (handoverOffered) await expect(handoverButton).toBeVisible();
    if (streamOffered) await expect(streamButton).toBeVisible();
    await expect(detailsToggle).toBeHidden();
    await expect(scoringHeading).toBeVisible();
    await expect(activityToggle).toBeHidden();
    // Phone-only disclosures stay `md:hidden` (spec §3.10). Lineup/roster
    // opted into `desktopCollapsible` (PR #782) so their toggle is visible
    // at tablet too — asserting every toggle hidden reddened cricket v3 pad
    // at 768/834 (run 34834966169). `/(^|\s)md:hidden(\s|$)/` so this does
    // not match inside `max-md:hidden`.
    for (const el of await page.locator('[data-role="phone-disclosure-toggle"]').all()) {
      const phoneOnly = await el.evaluate((node) =>
        /(^|\s)md:hidden(\s|$)/.test((node as HTMLElement).className),
      );
      if (phoneOnly) await expect(el).toBeHidden();
      else await expect(el).toBeVisible();
    }
  }
  await expectNoHorizontalScroll(page);
}

/**
 * T16 — the ScoringPad v3 cricket pad (R2/task F1) at all SEVEN width
 * projects (320/360/375/390/430/768/834), same "add it above the z3 test"
 * placement T15's own comment asks for.
 *
 * Cricket is the first sport this repo flips onto `V3_SKINS`
 * (v3/registry.ts) — a brand-new render tree (tile-grid.tsx/context-
 * strip.tsx/scorebug.tsx) with ZERO width coverage until it lands inside
 * THIS file (reference_new_ui_surface_uncovered_until_in_mobile_spec — this
 * file's own SEVEN projects are the only place a new surface gets narrower
 * than 375/768 coverage at all). Self-contained fixture, no shared org.
 *
 * The context strip (D-14) only renders once an innings exists
 * (`buildContext`, v3/skins/cricket.tsx requires `currentInnings() !==
 * null`), and `cricket.ts` creates that innings lazily inside the FIRST
 * ball's own fold — so one run tile is tapped first, both to prove the
 * tile itself clears the touch floor and to bring the context strip on
 * screen for its own floor check right after.
 */
test("cricket v3 pad: tiles + over-summary sheet + context strip hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  // core.start poll + a held ball dispatch (queue.ts's HOLD_MS)
  // each budget up to 20s below; generous headroom over their sum.
  test.setTimeout(90_000);
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Cricket V3 ${TAG}-${projectTag()}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `Mobile V3 Striker ${TAG}` }, { fullName: `Mobile V3 NonStriker ${TAG}` }],
    away: [{ fullName: `Mobile V3 Bowler ${TAG}` }],
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  const pad = page.getByTestId("score-pad");
  await expect(pad).toBeVisible({ timeout: 20_000 });
  // Click until the ledger actually moves. `waitUntil: "load"` resolves
  // before React has hydrated, so on a loaded machine the first click lands
  // on server-rendered markup with no handler attached and is silently a
  // no-op: the fixture stays "Scheduled", core.start never lands, and the
  // failure surfaces 20s later at the poll below as an empty event list
  // rather than anywhere near the click. Observed at all seven widths while
  // the same flow passed under the `parallel` project on a quieter machine.
  const startBtn = page.getByRole("button", { name: "Start match", exact: true });
  await expect(startBtn).toBeEnabled({ timeout: 20_000 });
  await expect
    .poll(
      async () => {
        if (await startBtn.isVisible().catch(() => false)) {
          await startBtn.click({ timeout: 5_000 }).catch(() => {});
        }
        const res = await apiJson<{ type: string }[]>(
          page.request,
          `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).some((e) => e.type === "core.start");
      },
      { timeout: 30_000, message: "Start match must reach the ledger once the pad has hydrated" },
    )
    .toBe(true);
  // Wait on the real LEDGER, not the click alone — the pad's own
  // `useFixtureStream` polls at a 15s interval (scorepad-v2.spec.ts's own
  // `openLiveConsole` comment), so a tile-visibility check racing the click
  // itself could stall past this test's budget waiting on that poll cycle.
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string }[]>(
          page.request,
          `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).map((e) => e.type);
      },
      { timeout: 20_000 },
    )
    .toContain("core.start");

  const assertFloor = async (locator: Locator, label: string) => {
    await expect(locator, `${label} not visible`).toBeVisible({ timeout: 20_000 });
    const box = await locator.boundingBox();
    expect(box, `${label} has no box`).not.toBeNull();
    expect(box!.height, `${label} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  };

  // The run tiles are the pad's most-tapped control (D-14's replacement for
  // the old "This over" selects) — assert the floor BEFORE tapping one,
  // since the tap itself is what this same assertion is proving is safe.
  await assertFloor(pad.locator('[data-tile-id="run1"]'), "run tile \"1\"");
  await assertFloor(pad.locator('[data-tile-id="wicket"]'), "wicket tile");

  // R2b: the over-by-over guided sheet (SheetNumberStep, guided-sheet.tsx) is
  // a brand-new surface with zero width coverage until it lands here — same
  // "new v3 surface, only covered inside this file" reasoning this test's
  // own header gives for the tile grid itself. Checked BEFORE the run tap
  // below: recording a ball first locks this innings to ball-by-ball
  // fidelity and the tile disappears entirely (R2b's own mutually-exclusive
  // gate), so this is the only point in the flow where the sheet is still
  // reachable.
  await assertFloor(pad.locator('[data-tile-id="overSummary"]'), "over-summary tile");
  await pad.locator('[data-tile-id="overSummary"]').click();
  const sheet = pad.locator('[data-role="v3-sheet"]');
  await expect(sheet, "guided sheet must open").toBeVisible({ timeout: 10_000 });
  // Fix 1f7403c0 (review finding 2): the stepper buttons' accessible names
  // now come from dedicated pad.sheet.decrease/.increase dictionary keys
  // ("Decrease {title}"/"Increase {title}", en/ui.json) rather than the
  // step title plus a bare glyph — "Decrease Runs this over"/"Increase Runs
  // this over", not "Runs this over −"/"Runs this over +". The title itself
  // changed from "Total runs" when Q2 was reversed (per-over delta, not a
  // running total, `_INDEX.md` 2026-08-17); these names are derived from it,
  // so they move with it.
  await assertFloor(
    sheet.getByRole("button", { name: "Decrease Runs this over", exact: true }),
    "over-sheet stepper minus",
  );
  await assertFloor(sheet.getByRole("spinbutton", { name: "Runs this over" }), "over-sheet numeric field");
  await assertFloor(
    sheet.getByRole("button", { name: "Increase Runs this over", exact: true }),
    "over-sheet stepper plus",
  );
  await assertFloor(sheet.getByRole("button", { name: "Confirm", exact: true }), "over-sheet confirm");
  await expectNoHorizontalScroll(page);
  // Cancel, not confirm: a real submission here would open this innings at
  // COARSE fidelity and remove the run tiles the rest of this test still
  // needs to exercise below.
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet, "cancel must close the sheet without dispatching").not.toBeVisible({ timeout: 10_000 });

  // S2-4 Task 3: the openers and the opening bowler are the scorer's picks before ball 1 (the tiles wait for them).
  await pickCricketPeople(page, {
    striker: `Mobile V3 Striker ${TAG}`,
    nonStriker: `Mobile V3 NonStriker ${TAG}`,
    bowler: `Mobile V3 Bowler ${TAG}`,
  });
  await pad.getByRole("button", { name: "1", exact: true }).click();
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string }[]>(
          page.request,
          `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).filter((e) => e.type === "cricket.ball").length;
      },
      { timeout: 20_000 },
    )
    .toBe(1);

  // Every chip, interactive or not. After the first ball the strip is
  // read-only but for the striker's swap (asserted below): the non-striker is
  // read-only because the engine refuses any other pair under a strict
  // fold, and bowler is read-only until an over boundary (`currentBowler
  // === null`) because mid-over the same fold refuses it. Selecting on
  // `button` would skip the read-only chips, and the 44px floor applies to
  // every chip's footprint, which is what a thumb meets, not to whether it
  // happens to be a control.
  const chips = pad.locator('[data-role="context-chip"]');
  await expect(chips.first(), "context strip must render once an innings exists").toBeVisible({ timeout: 20_000 });
  const chipCount = await chips.count();
  expect(chipCount, "cricket declares striker, non-striker and bowler").toBe(3);
  // R8 / WS-M round 2 — the mode statement is deliberately NOT among them: it
  // renders as plain text with a lock glyph, not a pill, so the 44px floor
  // loop below must not measure it — nothing can tap it, and a hit-target
  // sweep that grades a statement is measuring the wrong thing. It must still
  // READ correctly at every width: this innings was opened by the ball tapped
  // above, so it is locked to the fine lane, and an indicator that ignored the
  // fold would say "Over-by-over" over a pad that has just recorded a ball.
  const modeLine = pad.locator('[data-role="context-mode"]');
  await expect(modeLine, "the pad must state which scoring mode this innings locked into").toHaveCount(1);
  await expect(modeLine).toHaveText("This innings: Ball-by-ball");
  await expect(
    pad.locator('[data-role="context-chip"][data-slot-kind="mode"]'),
    "the mode statement must never render as a chip",
  ).toHaveCount(0);
  for (let i = 0; i < chipCount; i++) {
    await assertFloor(chips.nth(i), `context chip ${i}`);
  }
  // Mid-over no chip may open a picker the engine will refuse — the defect
  // this wave fixed twice (G5, then the bowler's own mid-over case). Since
  // S2-4 Task 7 (rulings 76, 84) the ONE control left is the striker's chip,
  // whose picker offers only the swap of ends with the non-striker (the pair
  // reversed, which the engine takes); the non-striker and the bowler stay
  // read-only.
  const liveChips = pad.locator('[data-role="context-chip"][data-readonly="false"]');
  await expect(liveChips, "mid-over only the striker's chip is a control").toHaveCount(1);
  await expect(liveChips).toHaveAccessibleName(/^Striker: /);

  await expectNoHorizontalScroll(page);
  await expectPhoneComposition(page, "T");
});

/**
 * T17 — the ScoringPad v3 tennis pad (R4/tennis) at all SEVEN width
 * projects (320/360/375/390/430/768/834), same "add it above the z3 test"
 * placement T16's own comment describes, and the same reason: a new v3
 * render surface gets no width coverage anywhere else — this file's seven
 * projects are the only place anything narrower than 375/768 ever runs.
 *
 * Tennis is the first tapModel-S sport (v3/skins/tennis.tsx): the
 * scoreboard HALF itself is the point button (`ScorebugHalf.tappable`/
 * `tapEvent`), not a tile — so the control this file must prove fits and
 * is safe to tap is the scorebug half, not a `data-tile-id`.
 * `scorepad-v3-tennis.spec.ts` already proves the pad's full functional
 * surface (deuce/advantage, dock legality by serve side, the doubles
 * serve pip, D-16) at desktop; this file's job is narrower and different —
 * does that SAME control still render, fit, and clear the 44px
 * tap-target floor once the viewport drops to 320px, which nothing
 * anywhere else checks.
 *
 * A half renders EITHER a real `<button>` (tappable — live, band>=3) or a
 * plain, click-inert `<div>` at the identical grid position (`buildHalf`,
 * v3/skins/tennis.tsx). The fixture below is seeded already-started
 * (`emitCoreStart: true`), so the only fold race left is the server's
 * response against the client's first render — and the locator is scoped
 * to `button` specifically (the fix in commit 8a50b48d7, the same
 * `tennisHalf` shape `scorepad-v3-tennis.spec.ts` uses), so Playwright's
 * ordinary actionability wait closes that race instead of resolving to the
 * still-present pre-fold `<div>` and reading a stale, empty box.
 *
 * The floor is measured from `boundingBox()`, never inferred from the
 * `minHeight: 44` inline style scorebug.tsx declares on the button — the
 * Scorebug's own root card is `overflow-hidden`, the exact shape that has
 * silently clipped a declared floor back down elsewhere in this chassis
 * (tile-grid's 2px `::before` bleed). Checked BEFORE either half is
 * tapped, since the tap itself is what the floor is proving is safe.
 *
 * "Live and populated" is asserted on the SEEDED players' own names, not
 * merely "a button exists" — a board that rendered but is still showing
 * stale or placeholder content would pass a presence-only check for the
 * wrong reason. The card's own `overflow-hidden` also means a name could
 * be silently clipped without ever producing page-level horizontal
 * scroll, so this checks the card's own content width too, not just the
 * page's.
 *
 * Doubles (second test below) is layout-only, deliberately: TWO names per
 * half (`buildHalf`'s `who` — one WhoLine per on-field player) is the
 * shape most likely to overflow or clip at 320px, so it gets its own
 * floor/populated/no-scroll pass, but not a repeat of the full score/dock
 * flow — `scorepad-v3-tennis.spec.ts` already proves that functionally,
 * and repeating it here would roughly double this test's per-width
 * runtime for no additional WIDTH signal. Left uncovered by that scope
 * choice: a doubles-specific dock render defect (the pair-narrowing
 * second question) at a narrow viewport — real, but a different and
 * larger test than a coverage-gap fix belongs doing in one pass.
 */
test("tennis v3 pad (singles): the scoreboard half holds the 44px floor, live and populated, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  // R8 close-out — the `-${projectTag()}` suffix is DROPPED here, the same
  // trim the DOUBLES test below already carries and for the same measured
  // reason (its comment has the full account). WS-I root-caused this file's
  // intermittent 320px scorebug clip to the FIXTURE NAME, not the scorebug:
  // an entrant name has no uniqueness requirement — it is scoped to one
  // fixture, which `label` already isolates — and the decoration pushed the
  // who-block past its clamp only once the webfont swapped, because
  // `globals.css`'s `.app-display` resolves `--font-barlow` (condensed) over
  // `--font-geist-sans` (not), so the identical string measures wider until
  // Barlow lands. That is what made it INTERMITTENT rather than reproducible.
  // The box is already correct (scorebug.tsx: `line-clamp-6`, `min-w-0`,
  // wrap-anywhere) — do NOT restyle it to chase this.
  const homeName = `Mobile V3 Tennis Home ${TAG}`;
  const awayName = `Mobile V3 Tennis Away ${TAG}`;
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Tennis V3 ${TAG}-${projectTag()}`,
    sportKey: "tennis",
    variantKey: "tour",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  const pad = page.getByTestId("score-pad");
  await expect(pad).toBeVisible({ timeout: 20_000 });

  // Positional, home first (scorebug.tsx's render order) — a tappable
  // half's accessible name is the PLAYER'S OWN name plus hint text, not a
  // fixed string this file could match on (same reasoning
  // scorepad-v3-tennis.spec.ts's own `tennisHalf` gives).
  const halves = pad.locator('[data-role="v3-scorebug"] .grid > button');
  const homeHalf = halves.nth(0);
  const awayHalf = halves.nth(1);

  const assertFloor = async (locator: Locator, label: string) => {
    await expect(locator, `${label} not visible — board never reached live/band-3`).toBeVisible({
      timeout: 20_000,
    });
    const box = await locator.boundingBox();
    expect(box, `${label} has no box`).not.toBeNull();
    expect(box!.height, `${label} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  };

  // The floor, BEFORE tapping either half — the tap itself is what this
  // assertion is proving is safe (same ordering T16's cricket test uses).
  await assertFloor(homeHalf, "home scoreboard half");
  await assertFloor(awayHalf, "away scoreboard half");

  // LIVE AND POPULATED: the real seeded names, not a pre-phase board with
  // nothing on it.
  await expect(homeHalf, "home half must show the real seeded player").toContainText(homeName);
  await expect(awayHalf, "away half must show the real seeded player").toContainText(awayName);

  // The scorebug card is `overflow-hidden`, so a clipped name would not
  // necessarily show up as page-level horizontal scroll — checked here as
  // its own signal, not folded into `expectNoHorizontalScroll` below.
  await expectScorebugNotClipped(page, "scorebug content (before tap)");
  await expectNoHorizontalScroll(page);

  // Prove the target is not just big enough but a REAL, wired control:
  // tap it, resolve the point dock (singles still asks "how was the point
  // won" — R4-5's auto-stamp only skips the SECOND, scorer question), and
  // confirm the point actually reaches the ledger. "Winner" is legal
  // regardless of which side is serving (scorepad-v3-tennis.spec.ts's own
  // dock test), so it holds whichever half a thumb lands on first.
  await homeHalf.click();
  const dock = pad.locator('[data-role="v3-dock"]');
  await expect(dock, "tapping the half must open the point dock").toBeVisible({ timeout: 10_000 });
  await expect(dock).toContainText("How was the point won?");
  await dock.getByRole("button", { name: "Winner", exact: true }).click();
  // One-way collapse (build spec §4): the alternatives must leave once a
  // kind lands — same proof T16 and the sibling functional spec both give
  // that this dock re-render is real, not merely unit-tested.
  await expect(
    dock.getByRole("button", { name: "Ace", exact: true }),
    "once a kind lands, the dock must show ONLY that chip",
  ).toHaveCount(0);
  await dock.getByRole("button", { name: "Send now", exact: true }).click();
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string }[]>(
          page.request,
          `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).filter((e) => e.type === "tennis.point").length;
      },
      { timeout: 20_000, message: "a tap on the scoreboard half must reach the ledger as a tennis.point" },
    )
    .toBe(1);

  await expectNoHorizontalScroll(page);
});

/**
 * T17b — tennis doubles: TWO names per half, the layout most likely to
 * overflow or clip at 320px. See T17's own header above for the shared
 * reasoning (fold race, `boundingBox()` over the inline style, why this is
 * layout-only rather than a repeat of the full dock flow).
 */
test("tennis v3 pad (doubles): both partners' names hold the 44px floor and fit inside the half, no horizontal scroll", async ({
  page,
  request,
}) => {
  // `${TAG}` only, not `${TAG}-${projectTag()}` — unlike the competition
  // `label` below (a real cross-project collision risk this file's own
  // header documents), an entrant's name has no uniqueness requirement at
  // all: it's scoped to this one fixture, which the label already isolates.
  // The extra suffix was pure decoration copied from the label's own
  // pattern, and at this box's narrowest column (320, ~98px) two real long
  // names plus that decoration needed more vertical room than any
  // reasonable clamp could give without chasing a moving CI-renderer
  // target — see scorebug.tsx's own comment on the who-block's clamp.
  const home1 = `Mobile V3 Tennis D Home1 ${TAG}`;
  const home2 = `Mobile V3 Tennis D Home2 ${TAG}`;
  const away1 = `Mobile V3 Tennis D Away1 ${TAG}`;
  const away2 = `Mobile V3 Tennis D Away2 ${TAG}`;
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Tennis V3 Doubles ${TAG}-${projectTag()}`,
    sportKey: "tennis",
    variantKey: "doubles-noad-mtb10",
    entrantKind: "pair",
    home: [
      { fullName: home1, pairOrder: 1 },
      { fullName: home2, pairOrder: 2 },
    ],
    away: [
      { fullName: away1, pairOrder: 1 },
      { fullName: away2, pairOrder: 2 },
    ],
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  const pad = page.getByTestId("score-pad");
  await expect(pad).toBeVisible({ timeout: 20_000 });

  const halves = pad.locator('[data-role="v3-scorebug"] .grid > button');
  const homeHalf = halves.nth(0);
  const awayHalf = halves.nth(1);

  const assertFloor = async (locator: Locator, label: string) => {
    await expect(locator, `${label} not visible — board never reached live/band-3`).toBeVisible({
      timeout: 20_000,
    });
    const box = await locator.boundingBox();
    expect(box, `${label} has no box`).not.toBeNull();
    expect(box!.height, `${label} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  };
  await assertFloor(homeHalf, "home scoreboard half (doubles)");
  await assertFloor(awayHalf, "away scoreboard half (doubles)");

  // Both partners, not just the first — a half that silently dropped or
  // clipped its second name would still pass a single-name check.
  await expect(homeHalf, "home half must show BOTH partners").toContainText(home1);
  await expect(homeHalf, "home half must show BOTH partners").toContainText(home2);
  await expect(awayHalf, "away half must show BOTH partners").toContainText(away1);
  await expect(awayHalf, "away half must show BOTH partners").toContainText(away2);

  await expectScorebugNotClipped(page, "doubles scoreboard content");

  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// T17 — the ScoringPad v3 RACQUET pads (R5/tasks C1-C3: badminton, table
// tennis, volleyball) at all SEVEN width projects.
//
// Same reasoning T16 gives for cricket, and it applies three more times over:
// R5 split these sports off a SHARED v2 skin (`racquet-skin.tsx`) onto three
// separate v3 skins, each a new render tree, and this file's own seven
// projects are the ONLY place any new surface gets width coverage narrower
// than 375/768 at all (reference_new_ui_surface_uncovered_until_in_mobile_
// spec). Before this block, `git grep -a` for badminton/tabletennis/
// volleyball across mobile.spec.ts returned ZERO matches — three brand-new
// pads with no width bar whatsoever.
//
// One test per sport rather than one walking all three: a 320px failure that
// reads "badminton pad" is a different alarm from one that reads "the R5
// pads", and the extra fixture seeding is cheap next to losing that.
//
// Every fixture here seeds with `emitCoreStart: true`, so none of these pay
// T16's Start-match hydration dance — the pad is live on first paint.
// ---------------------------------------------------------------------------

/** Both scoreboard halves, scoped to `button` deliberately: a half renders
 *  EITHER a `<button>` (tappable — live, band 3) or a plain `<div>` at the
 *  same grid position, and a wildcard locator happily resolves the untappable
 *  div. Tap model S — the halves ARE the scoring control on all three of
 *  these sports, so they are the touch target that matters most here. */
function padHalf(page: Page, side: "home" | "away"): Locator {
  return page
    .getByTestId("score-pad")
    .locator('[data-role="v3-scorebug"]')
    .locator(".grid > button")
    .nth(side === "home" ? 0 : 1);
}

async function assertTouchFloor(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} not visible`).toBeVisible({ timeout: 20_000 });
  const box = await locator.boundingBox();
  expect(box, `${label} has no box`).not.toBeNull();
  expect(box!.height, `${label} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
}

/** A control must stay INSIDE the box that paints it. Measured against the
 *  element's own container, never the page: `swap-sheet.tsx`'s "who came off"
 *  chip once carried `shrink-0` with no max-width and took its full content
 *  width (375px) inside a 314px row, spilling 77px past a wrapper whose
 *  `overflow-hidden rounded-2xl` then CLIPPED the player's name mid-string.
 *
 *  `expectNoHorizontalScroll` is blind to that by construction, which is why
 *  it survived: the clip means `documentElement.scrollWidth` never grows, so
 *  the page gate reports clean while the name is unreadable (verified:
 *  `pageHScroll: 0` while the element spilled 77px). An `overflowsX` check on
 *  the element is blind too — its own `scrollWidth` is not greater than its
 *  own box, because the BOX is what grew past the parent. */
async function assertNoContainerSpill(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} not visible`).toBeVisible({ timeout: 20_000 });
  await locator.scrollIntoViewIfNeeded();
  const probe = await locator.evaluate((el) => {
    const parent = el.parentElement;
    if (parent === null) return null;
    const r = el.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    return {
      spillRight: Math.round(r.right - pr.right),
      spillLeft: Math.round(pr.left - r.left),
      width: Math.round(r.width),
      parentWidth: Math.round(pr.width),
    };
  });
  expect(probe, `${label} has no parent element to measure against`).not.toBeNull();
  expect(
    probe!.spillRight,
    `${label} spills ${probe!.spillRight}px past its container's RIGHT edge ` +
      `(${probe!.width}px inside ${probe!.parentWidth}px) — it is being clipped, ` +
      `and the page-level scroll gate cannot see it`,
  ).toBeLessThanOrEqual(0);
  expect(
    probe!.spillLeft,
    `${label} spills ${probe!.spillLeft}px past its container's LEFT edge`,
  ).toBeLessThanOrEqual(0);
}

/** The three checks every racquet pad owes at every width, before any
 *  sport-specific surface: the pad rendered at all (not just a 2xx shell),
 *  both scoring halves clear the 44px floor, and the page does not scroll
 *  sideways. */
async function assertRacquetPadFloor(page: Page): Promise<void> {
  const pad = page.getByTestId("score-pad");
  await expect(pad).toBeVisible({ timeout: 20_000 });
  await assertTouchFloor(padHalf(page, "home"), "home scoreboard half");
  await assertTouchFloor(padHalf(page, "away"), "away scoreboard half");
  await expectNoHorizontalScroll(page);
}

test("badminton v3 pad: both scoring halves and the Set-score tile hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Badminton V3 ${TAG}-${projectTag()}`,
    sportKey: "badminton",
    // The variant is `bwf`, not "singles" — and a badminton division refuses
    // `team` entrants, which is `seedRosteredFixture`'s default, so
    // `entrantKind` is required rather than optional here.
    variantKey: "bwf",
    entrantKind: "individual",
    // PERSON NAMES CARRY `projectTag()`, not just the fixture label — review
    // finding 5's rule (this file's own header, line ~303), and the reason is
    // structural rather than stylistic: `e2e.yml`'s `phones-large` leg runs
    // `--project=mobile-14 --project=mobile-430` in ONE process, and `TAG` is
    // per PROCESS. Two width projects therefore seed the SAME person name, and
    // `seedRosteredFixture` get-or-creates a person by name — so the second
    // fixture rosters the first one's person. The fixture label alone does not
    // save it: the collision is on the PERSON row, not the fixture.
    home: [{ fullName: `Mobile BD Home ${TAG}-${projectTag()}` }],
    away: [{ fullName: `Mobile BD Away ${TAG}-${projectTag()}` }],
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await assertRacquetPadFloor(page);

  // The Set-score tile is the band-0 action that survives at every fidelity
  // band, so it is the one tile guaranteed present on a fresh live pad.
  await assertTouchFloor(padTile(page, "setScore"), "Set-score tile");

  // A real rally tap, then the context strip it brings on screen — the strip
  // is a new v3 surface and only renders once the reader can name a server,
  // which for badminton takes the SECOND rally (the first has no prior rally
  // to derive the serve from). R7-42/R7-30/R7-43 (owner ruling, `_INDEX.md`):
  // the pipeline's double-submit guard (compares the whole payload) is now
  // 250ms (was 600ms) and a refused repeat is VISIBLE rather than silent, so
  // the clearance the two same-payload taps used to pay is gone.
  await padHalf(page, "home").click();
  await padHalf(page, "home").click();
  // The SERVER item specifically, never `.first()`. `buildStrip` pushes an
  // unconditional "games" item ahead of everything else, so a `.first()` probe
  // resolves whether or not a single rally was ever tapped — proven by
  // commenting out both taps above and watching this test still pass. The
  // server item is gated on the reader being able to NAME a server, which for
  // badminton takes the second rally, so it fails if the taps stop landing.
  const serverItem = page
    .getByTestId("score-pad")
    .locator('[data-role="v3-scorebug"] [data-strip-item-id="server"]');
  await expect(serverItem, "two tapped rallies must bring the server onto the strip").toBeVisible({
    timeout: 20_000,
  });
  // Same poll the cricket v3 test pays before `expectPhoneComposition`: the
  // ledger assertion snapshots row count once, and both taps can outrun the
  // fold before that snapshot if we only wait on UI chrome (the server strip).
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string }[]>(
          page.request,
          `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).filter((e) => e.type === "badminton.rally").length;
      },
      { timeout: 20_000 },
    )
    .toBe(2);
  await expectNoHorizontalScroll(page);
  await expectPhoneComposition(page, "S");
});

test("table tennis v3 pad: the serve-anchor tile and its sheet hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const fx = await seedRosteredFixture(request, {
    label: `Mobile TT V3 ${TAG}-${projectTag()}`,
    sportKey: "tabletennis",
    variantKey: "bo5",
    entrantKind: "individual",
    // `projectTag()` for the same reason the badminton test above states: the
    // two projects that share a CI process are exactly the two that failed
    // without it (mobile-14 and mobile-430).
    home: [{ fullName: `Mobile TT Home ${TAG}-${projectTag()}` }],
    away: [{ fullName: `Mobile TT Away ${TAG}-${projectTag()}` }],
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await assertRacquetPadFloor(page);
  await assertTouchFloor(padTile(page, "setScore"), "Set-score tile");

  // D-17's serve anchor: table tennis's `within: "fixed-turns"` NEVER
  // self-heals, so the tile is on screen from the first paint of a fresh
  // fixture and its two-step sheet is a brand-new surface at every width.
  await assertTapFloor(padTile(page, "serveAnchor"), "serve-anchor tile");
  await padTile(page, "serveAnchor").click();
  const sheet = page.getByTestId("score-pad").locator('[data-role="v3-sheet"]');
  await expect(sheet, "the anchor sheet must open").toBeVisible({ timeout: 20_000 });
  await assertTouchFloor(sheet.locator('[data-choice-option-id="home"]'), "anchor sheet: home option");
  await assertTouchFloor(sheet.locator('[data-choice-option-id="away"]'), "anchor sheet: away option");
  await expectNoHorizontalScroll(page);
});

test("volleyball v3 pad: the anchor sheet and the libero Swap-sheet hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // A full indoor starting six, S/OH/MB/OPP/OH/MB — FIVB's own catalog shape.
  // Six a side is what makes volleyball the widest of the three scorebugs, so
  // it is the one most likely to overflow a 320px viewport.
  const court = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;
  // Six on court plus a BENCH libero. The seventh is not decoration: a libero
  // exchange brings someone ON, so the player it names has to be off the
  // court to start with — seeding all seven as starters made the exchange
  // below 422 with the engine's own words, "P6 … is already on the field".
  const roster = (label: string) => [
    ...court.map((positionKey, i) => ({ fullName: `${label} P${i + 1} ${TAG}`, positionKey })),
    // `roles: ["libero"]` is the tile's own gate, not decoration: the skin
    // shows the Swap tile only for a side whose squad NAMES a libero
    // (`sideHasLibero` → `hasLiberoRole`), and a bare position_key of "L"
    // does not set that role.
    { fullName: `${label} P7 ${TAG}`, positionKey: "L", slot: "bench" as const, roles: ["libero"] as const },
  ];
  const fx = await seedRosteredFixture(request, {
    label: `Mobile VB V3 ${TAG}-${projectTag()}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    home: roster(`Mobile VB Home ${TAG}-${projectTag()}`),
    away: roster(`Mobile VB Away ${TAG}-${projectTag()}`),
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await assertRacquetPadFloor(page);

  await assertTapFloor(padTile(page, "serveAnchor"), "serve-anchor tile");
  await padTile(page, "serveAnchor").click();
  const sheet = page.getByTestId("score-pad").locator('[data-role="v3-sheet"]');
  await expect(sheet, "the anchor sheet must open").toBeVisible({ timeout: 20_000 });
  await assertTouchFloor(sheet.locator('[data-choice-option-id="away"]'), "anchor sheet: away option");
  await expectNoHorizontalScroll(page);
  await sheet.locator('[data-choice-option-id="away"]').click();
  await page.waitForTimeout(400);
  await sheet.locator('[data-choice-option-id="home"]').click();
  await expect(sheet, "the anchor sheet closes once both steps are answered").toHaveCount(0, {
    timeout: 20_000,
  });
  await expectNoHorizontalScroll(page);

  // The libero Swap-sheet (`[data-role="v3-swap"]`) is the one surface
  // NEITHER sibling has at all, and its candidate rows are the densest thing
  // any of these three pads renders — twelve names in one scrolling list, at
  // 320px. The tile only appears once a side has ACTUALLY used a libero, so
  // the first exchange is established directly; the SHEET is what this test
  // is measuring, not the act of bringing the libero on.
  const middleBlocker = `Mobile VB Home ${TAG}-${projectTag()} P3 ${TAG}`;
  const libero = `Mobile VB Home ${TAG}-${projectTag()} P7 ${TAG}`;
  const state = await apiJson<{ last_seq: number }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/state`,
  );
  expect(state.status, "state read before the libero exchange").toBe(200);
  const posted = await apiJson(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/events`,
    "POST",
    {
      expected_seq: state.data!.last_seq,
      type: "core.lineup.replacement",
      payload: {
        side: fx.homeEntrantId,
        off: fx.personIds[middleBlocker]!,
        on: {
          personId: fx.personIds[libero]!,
          positionKey: "MB",
          slot: "starting",
          orderNo: 7,
          roles: ["libero"],
        },
        exemption: "libero",
      },
    },
  );
  expect(posted.status, `libero exchange POST: ${JSON.stringify(posted.error)}`).toBeLessThan(300);

  await page.reload({ waitUntil: "load" });
  await expect(page.getByTestId("score-pad")).toBeVisible({ timeout: 20_000 });
  await assertTapFloor(padTile(page, "libero-home"), "libero tile");
  await padTile(page, "libero-home").click();
  const swap = page.getByTestId("score-pad").locator('[data-role="v3-swap"]');
  await expect(swap, "the libero Swap-sheet must open").toBeVisible({ timeout: 20_000 });
  await assertTouchFloor(
    swap.locator(`[data-candidate-id="${fx.personIds[libero]!}"]`),
    "swap sheet: the libero's own candidate row",
  );
  await expectNoHorizontalScroll(page);

  // Step 2 of the sheet — the half NO earlier gate reached. Answering "who
  // comes off" replaces that step with a chip naming the player chosen, and
  // the chip is the ONLY place a referee re-reads who is leaving the court
  // before committing the exchange. Its content is a PERSON NAME, so it is
  // the one control on this sheet whose width is unbounded by the dictionary
  // — which is exactly why it is the one that spilled its card and got
  // clipped. Assert it against its container, not the page: see
  // `assertNoContainerSpill`.
  await swap.locator("[data-candidate-id]").first().click();
  // Strict-unique on purpose: the chip carries the ONLY `aria-label` in
  // swap-sheet.tsx, so a second labelled button appearing here should fail
  // this locator loudly rather than be silently skipped by a `.first()`.
  const offChip = swap.locator("button[aria-label]");
  await assertNoContainerSpill(offChip, "swap sheet: the who-came-off chip");
  await assertTapFloor(offChip, "swap sheet: the who-came-off chip");
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// R8/WS-I — THE FOUR v3 PADS THAT HAD NO WIDTH COVERAGE AT ALL.
//
// `V3_SKINS` owns eleven engine sports (R7/A3 closed the conversion). Before
// this block, `git grep -a` for each of them across this file returned SEVEN:
// cricket, football, generic, tennis, badminton, tabletennis, volleyball. The
// other four — HOCKEY, ICE HOCKEY, CARROM and BOARDGAME — appeared nowhere,
// and this file's seven width projects are the only place in the suite any
// surface is driven at 320/360/375/390/430/768/834 at all. Four shipped pads
// therefore had ZERO responsive enforcement (reference_new_ui_surface_
// uncovered_until_in_mobile_spec): the R8 a11y sweep covers all eleven but
// runs in the `parallel` project at a 1280 desktop viewport that it resizes
// itself, which is a different measurement from a real 320x568 phone whose
// FOLD and page height differ too.
//
// WHAT THIS BLOCK ASSERTS, AND WHAT IT DOES NOT.
// `expectNoHorizontalScroll` catches PAGE OVERFLOW. It is not, and cannot be,
// a claim that a layout looks right — a spill that gets CLIPPED never grows
// `documentElement.scrollWidth` (see `assertNoContainerSpill` above, which
// exists precisely because the page gate could not see a 77px spill). Layout
// correctness at these widths is the gallery's and the walkthroughs' job. What
// is proved here is narrower and worth having on its own: the pad RENDERS at
// this width, every operable control inside it clears the 44px floor on both
// axes, and the page does not scroll sideways.
//
// THE FLOOR IS ASSERTED OVER EVERY OPERABLE TARGET, never the smallest one.
// `hitTargetFloorReport` (scorepad-a11y-kit.ts) is reused rather than
// re-measured here, and its own doc records why: MIN-AREA IS NOT MIN-DIMENSION,
// so a 200x30 control has a LARGER area than the 92.11x44 binding target and
// would never be selected as "smallest". Sharing the kit also means this gate
// and the a11y sweep compute one pixel one way — two hand-written copies of a
// geometry measurement is how two gates drift into disagreeing.
//
// One test per sport, matching the T16/T17 blocks above: a 320px failure that
// reads "carrom pad" is a different alarm from one that reads "the R7 pads".
// ---------------------------------------------------------------------------

/**
 * A seed spec built from `V3_SKIN_CASES` — the catalog `a11y-sweep-totality
 * .test.ts` already pins against `V3_SKINS` itself — rather than a second
 * hand-rolled table of sport keys, variants and rosters. A twelfth sport, or a
 * variant rename, then moves this block with the registry instead of leaving
 * it seeding yesterday's fixture.
 *
 * The catalog deliberately carries no NAMES, and they have to be minted here
 * per width project: `TAG` is per PROCESS and `e2e.yml`'s `phones-large` leg
 * runs two width projects in ONE process, while `seedRosteredFixture`
 * get-or-creates a person BY NAME — so two widths sharing a name roster the
 * same person row. Same reasoning the badminton test above spells out in full.
 */
function v3SkinSeed(
  sportKey: string,
  short: string,
): {
  label: string;
  sportKey: string;
  variantKey: string;
  entrantKind: "individual" | "team" | "pair";
  home: { fullName: string; positionKey?: string }[];
  away: { fullName: string; positionKey?: string }[];
} {
  const skin = V3_SKIN_CASES.find((c) => c.key === sportKey);
  if (skin === undefined) {
    throw new Error(
      `v3SkinSeed: "${sportKey}" is not in V3_SKIN_CASES — the catalog is the ` +
        `source of truth for which skins exist and what each one's fold needs`,
    );
  }
  const roster = (sideCode: string, slots: readonly V3SkinRosterSlot[]) =>
    slots.map((slot, i) => ({
      fullName: `Mobile ${short} ${sideCode}${i + 1} ${TAG}-${projectTag()}`,
      ...(slot.positionKey === undefined ? {} : { positionKey: slot.positionKey }),
    }));
  return {
    label: `Mobile ${short} V3 ${TAG}-${projectTag()}`,
    sportKey: skin.key,
    variantKey: skin.variantKey,
    entrantKind: skin.entrantKind,
    home: roster("H", skin.home),
    away: roster("A", skin.away),
  };
}

// HOCKEY + ICE HOCKEY share one skin builder (`v3/skins/period-shared.ts`) and
// one engine kernel under two presets, so they are driven by one parametrised
// test rather than two hand-copied ones — but they get a test EACH (the loop
// mints two `test()` calls), so a failure names the sport a scorer would be
// holding. Football also declares `SkinDefV3.clock()` (pad-host inventory) but
// is not in this width loop. The clock's start/pause toggle is the SMALLEST
// operable target either period pad has — 58.17 x 44 at rest, i.e. exactly on
// the floor with zero headroom (reference_v3_pad_44px_floor_has_zero_headroom).
// It is therefore the one control here most likely to go red on a restyle,
// and the one no other project measures at 320px.
// WS-M fix round 1, item 3: the pair comes from `v3-width-matrix-coverage.ts`,
// not a literal here — that module is what `width-matrix-totality.test.ts` pins
// against the skin registry, and reading it back is what stops the declaration
// there from drifting away from this loop.
for (const [sportKey, short] of WIDTH_MATRIX_CLOCK_SPORTS) {
  test(`${sportKey} v3 pad: the clock bar, goal tiles and the suspension sheet's class ladder hold the 44px floor, no horizontal scroll`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const fx = await seedRosteredFixture(request, {
      ...v3SkinSeed(sportKey, short),
      emitCoreStart: true,
    });

    // The class ladder's expected size is read off the DIVISION'S OWN CONFIG,
    // never a ladder typed into this test: hockey declares three cards
    // (green/yellow/red) and ice hockey seven, and the `youth` variants change
    // the durations — deriving it means a preset change moves this assertion
    // with it instead of leaving it pinned to yesterday's ladder (AGENTS.md,
    // recurring failure class 19).
    const div = await apiJson<{ config: { suspensions?: { classes?: Record<string, unknown> } } }>(
      request,
      `/api/v1/divisions/${fx.divisionId}`,
    );
    expect(div.status, `GET division -> ${div.status}`).toBe(200);
    const classKeys = Object.keys(div.data?.config.suspensions?.classes ?? {});
    expect(
      classKeys.length,
      `${sportKey}'s division config declares no suspension classes, so the option ` +
        `count asserted below would be pinned to nothing`,
    ).toBeGreaterThan(0);

    await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
    await dismissCookieBanner(page);
    await assertV3PadHoldsAtThisWidth(page, `${sportKey} pad at rest`, 4);

    // THE CLOCK BAR — the surface only these two skins have at all.
    const clock = page.getByTestId("score-pad").locator('[data-role="v3-clock"]');
    await expect(clock, `${sportKey} declares clock(), so the clock bar must render`).toBeVisible({
      timeout: 20_000,
    });
    await assertTouchFloor(
      clock.locator('[data-role="v3-clock-toggle"]'),
      `${sportKey}: the clock start/pause toggle`,
    );
    await assertTouchFloor(
      clock.locator('[data-role="v3-clock-value"]'),
      `${sportKey}: the clock correction control`,
    );

    // The two primaries. `goal-<side>` is band 0 and phase "live", so both are
    // unconditionally on a fresh started fixture — a missing one is a real
    // failure here, never a legitimately absent tile.
    await assertTouchFloor(padTile(page, "goal-home"), `${sportKey}: home goal tile`);
    await assertTouchFloor(padTile(page, "goal-away"), `${sportKey}: away goal tile`);

    // THE SUSPENSION SHEET — the densest surface either pad opens, and the one
    // whose height scales with a preset this file does not control. Opening a
    // sheet commits nothing (`action: {sheet}`), so this drives a real surface
    // without posting an event or racing the pad's soft-commit hold.
    await padTile(page, "suspension-home").click();
    await expect(v3Sheet(page), `${sportKey}: the suspension sheet must open`).toBeVisible({
      timeout: 20_000,
    });
    const classOptions = v3Sheet(page).locator("[data-choice-option-id]");
    await expect(
      classOptions,
      `the class step must offer exactly the classes the division declares (${classKeys.join(", ")})`,
    ).toHaveCount(classKeys.length, { timeout: 20_000 });
    await assertV3PadHoldsAtThisWidth(page, `${sportKey} suspension sheet, class step`, 4);
  });
}

test("carrom v3 pad: the two board tiles and the board sheet's winner/coins steps hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(request, {
    ...v3SkinSeed("carrom", "CR"),
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await assertV3PadHoldsAtThisWidth(page, "carrom pad at rest", 4);

  // Carrom's tap model is T: the halves are NOT buttons (unlike the R5 racquet
  // pads above), so the board tiles ARE the whole scoring surface. Both are
  // band 0 and live-phase, i.e. unconditional on a started fixture.
  await assertTapFloor(padTile(page, "board"), "carrom: Board tile");
  await assertTapFloor(padTile(page, "boardQueen"), "carrom: Board (queen) tile");

  // The board sheet, both of its steps. Step 1 is a two-option side choice;
  // answering it advances to the COINS step, which is a `number` — a stepper,
  // a different control shape from anything the choice steps render, and the
  // narrowest column in the pad at 320px. Stopping at that step deliberately:
  // answering it would commit `carrom.board.summary` and start the soft-commit
  // hold, which this width gate has no reason to pay for.
  await padTile(page, "board").click();
  await expect(v3Sheet(page), "the board sheet must open").toBeVisible({ timeout: 20_000 });
  await expect(
    v3Sheet(page).locator("[data-choice-option-id]"),
    "the winner step must offer both sides",
  ).toHaveCount(2, { timeout: 20_000 });
  await assertV3PadHoldsAtThisWidth(page, "carrom board sheet, winner step", 4);

  await v3Sheet(page).locator('[data-choice-option-id="home"]').click();
  await expect(
    v3Sheet(page).locator("[data-choice-option-id]"),
    "answering the winner step must advance off it, onto the coins stepper",
  ).toHaveCount(0, { timeout: 20_000 });
  await assertV3PadHoldsAtThisWidth(page, "carrom board sheet, coins number step", 4);
});

test("boardgame v3 pad: the pairing card (pre) and the halves + Draw tile (live) hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // Seeded WITHOUT `emitCoreStart`, unlike every other pad test in this file,
  // and for a reason specific to this skin: boardgame's tiles are split across
  // the two phases — `pairing` is "pre" only and `draw` is "live" only — so a
  // started fixture can never show the pairing card at all. Both phases are
  // driven here off ONE fixture, the pre half first.
  const fx = await seedRosteredFixture(request, v3SkinSeed("boardgame", "BG"));

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await dismissCookieBanner(page);
  // TWO, not the 4 its siblings carry, and measured rather than guessed: a
  // boardgame pad in "pre" is the sparsest state any v3 skin reaches — the
  // fidelity control and the pairing card, and nothing else. The halves render
  // as plain `<div>`s until the match is live and the ribbon has no Take back
  // until something is recorded, while Start match / Hand over device are
  // console chrome OUTSIDE the pad. The floor is a vacuity guard, so it is set
  // at what this state actually holds; the pairing tile asserted below is
  // where this test's real specificity lives.
  await assertV3PadHoldsAtThisWidth(page, "boardgame pad, pre phase", 2);

  // The pairing card's first step is a `number` (the board number), the same
  // stepper shape carrom's coins step uses and the only one this pad has.
  await assertTapFloor(padTile(page, "pairing"), "boardgame: pairing-card tile");
  await padTile(page, "pairing").click();
  await expect(v3Sheet(page), "the pairing card must open").toBeVisible({ timeout: 20_000 });
  await assertV3PadHoldsAtThisWidth(page, "boardgame pairing card, board step", 2);

  // ---- LIVE. `core.start` posted directly rather than tapped: the Start
  // control is console chrome OUTSIDE the pad, and this test is about the pad.
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fx.fixtureId}/state`);
  expect(state.status, "state read before core.start").toBe(200);
  const started = await apiJson(request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type: "core.start",
    payload: {},
  });
  expect(started.status, `core.start POST: ${JSON.stringify(started.error)}`).toBeLessThan(300);

  await page.reload({ waitUntil: "load" });
  await assertV3PadHoldsAtThisWidth(page, "boardgame pad, live phase", 3);

  // Tap model S: the halves ARE the result buttons (R7-2, "tap decides, dock
  // enriches"), so `padHalf`'s `button`-scoped locator resolves here exactly as
  // it does for the R5 racquet pads — and it is scoped to `button` deliberately,
  // because a half renders a plain `<div>` at the same grid position when it is
  // not tappable. Measured, never tapped: a tap commits `boardgame.result` and
  // DECIDES the match, which unmounts the pad.
  await assertTouchFloor(padHalf(page, "home"), "boardgame: home result half");
  await assertTouchFloor(padHalf(page, "away"), "boardgame: away result half");
  await assertTapFloor(padTile(page, "draw"), "boardgame: Draw / no result tile");
  await expectNoHorizontalScroll(page);
});

// --- W2d T18 (HK-TB-2): the hockey goal-type question at every width ------------------------------------------------
// A hockey goal tap opens "What kind of goal?" before anything is queued (the engine refuses an untyped FIH goal,
// GOAL_KIND_REQUIRED). The question is a new surface in the dock slot, so it owes the pad's own width bar here: every
// choice and Cancel at the 44px floor and hit-testable by a finger, nothing clipped, no page scroll, and the same
// choices in the same order as 1280. Not folded behind a phone disclosure (class 22 does not apply): it is the dock.
test("hockey v3 pad (W2d T18): the goal-type question holds the 44px floor, hit-tests, clips nothing, does not scroll, and offers the 1280 choices in order", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(request, { ...v3SkinSeed("hockey", "HKT"), emitCoreStart: true });
  const projectWidth = page.viewportSize()!.width;
  const question = page.getByTestId("score-pad").getByTestId("pad-dock-choice");
  const controls = () =>
    question
      .locator('[data-testid^="pad-dock-chip-"], [data-testid="pad-dock-cancel"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!));
  const ask = async () => {
    await padTile(page, "goal-home").click();
    await expect(question, "a hockey goal tap opens the goal-type question").toBeVisible({ timeout: 20_000 });
  };

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await ask();
  const here = await controls();
  expect(here.length, "anti-vacuity: three goal types, Own goal and Cancel were read").toBeGreaterThanOrEqual(5);
  for (const id of here) await assertTapFloor(question.getByTestId(id), `goal-type question ${id} at ${projectWidth}`);
  const clip = await overflowingIn(page, '[data-testid="pad-dock-choice"]', "*", "the goal-type question is missing");
  expect(clip.clipped, `nothing in the question is clipped at ${projectWidth}`).toEqual([]);
  expect(clip.scrollable, `the question has no scroll rail at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll, `${projectWidth}: scrollWidth ${widths.scroll} within clientWidth ${widths.client}`).toBeLessThanOrEqual(widths.client);
  await question.getByTestId("pad-dock-cancel").click();
  await expect(question).toHaveCount(0, { timeout: 5_000 });

  await page.setViewportSize({ width: 1280, height: 900 });
  await ask();
  expect(here, `the question's controls at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await controls());
  await question.getByTestId("pad-dock-cancel").click();
  await expect(question).toHaveCount(0, { timeout: 5_000 });
  // Asking twice and cancelling twice wrote nothing.
  const events = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
  expect(events.data!.filter((e) => e.type === "hockey.goal"), "a cancelled question writes no goal").toEqual([]);
  console.log(`[hockey goal-type ${projectWidth}px] ${here.length} controls hit-tested; scrollWidth ${widths.scroll}/${widths.client}`);
});
