// Split out of the former e2e/mobile.spec.ts (2026-11-13, verbatim move): W2e pad prompts: the ending prompt (organiser, scorer, void-only), the retirement tile and the field-six question.
// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — MOBILE_SPECS in playwright.config.ts).

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  TAG,
  apiJson,
  expectNoHorizontalScroll,
  fixturePath,
  seedRosteredFixture,
  overflowingIn,
} from "../helpers";
import { uiEn } from "../match-room-kit";
import { builtinModules } from "@seazn/engine/sports";
import { consentedAnonymousState, dismissCookieBanner } from "../scorepad-a11y-kit";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { withDb } from "../rs007-money-kit";
import { openConsolePanel } from "../helpers/console-panels";
import { projectTag, assertTapFloor, projectViewport, assertV3PadHoldsAtThisWidth, padTile, v3Sheet } from "./_shared";

// Not serial: no test here reads state another test writes (no module-level `let` is shared), so one red does not skip the rest (AGENTS.md class 21).

// ---------------------------------------------------------------------------
// W2e Task 30 (D3, D13; rule X-SE-1) — the ending prompt, at every phone width
// ---------------------------------------------------------------------------
//
// A sanction that ends the match and has no ending recorded opens the pad on a blocking prompt ("A sanction against <side> ends
// the match" / Record the ending / Void the sanction). `w2e-ending-sanction.test.ts` proves the prompt is in the pad's markup
// and who is offered what; only a browser settles that it is REACHABLE on a phone: above the fold, both answers hit-testable
// at 44px, no horizontal scroll, and nothing in it clipped.
//
// The pending state is seeded the way a real one arises on a reload: the sanction is appended to the ledger through the API
// (an organiser may append it; the write path accepts the sanction itself and refuses what comes AFTER it), and the console is
// then opened on that ledger. Both sports are swept from the engine's own `sanctionEnding` declaration, with the count
// asserted. The prompt is not inside a folded disclosure (AGENTS.md failure class 22), so no fold has to be opened; it is
// waited on with `toBeVisible`, which is the claim being made.
const ENDING_SEEDS: Record<string, { variantKey: string }> = {
  badminton: { variantKey: "bwf" },
  tennis: { variantKey: "tour" },
};
const ENDING_SPORTS = builtinModules
  .filter((m) => (m.sanctionEnding?.endLevels.length ?? 0) > 0)
  .map((m) => ({ key: m.key, eventType: m.sanctionEnding!.eventType, level: m.sanctionEnding!.endLevels[0]! }));

test("ending prompt (W2e T30) covers every sport that declares an ending level", () => {
  expect(ENDING_SPORTS.map((s) => s.key).sort(), "the engine's declaring sports must all be seeded below").toEqual(
    Object.keys(ENDING_SEEDS).sort(),
  );
});

/** A rostered fixture whose ledger is [core.start, <end-level sanction against home>] — an ending PENDING, the way a reload finds one.
 *  The sanction is appended through the API (an organiser may append it; the write path refuses what comes AFTER it). Names carry
 *  `projectTag()`: two width projects share one process and `seedRosteredFixture` get-or-creates a person by name. */
async function seedPendingEnding(request: APIRequestContext, sport: (typeof ENDING_SPORTS)[number], who: string) {
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Ending ${who} ${sport.key} ${TAG}-${projectTag()}`,
    sportKey: sport.key,
    variantKey: ENDING_SEEDS[sport.key]!.variantKey,
    entrantKind: "individual",
    home: [{ fullName: `Mobile End ${who} ${sport.key} Home ${TAG}-${projectTag()}` }],
    away: [{ fullName: `Mobile End ${who} ${sport.key} Away ${TAG}-${projectTag()}` }],
    emitCoreStart: true,
  });
  const before = await apiJson<{ seq: number }[]>(request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
  const tip = Math.max(0, ...(before.data ?? []).map((e) => e.seq));
  const sanction = await apiJson(request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
    expected_seq: tip,
    type: sport.eventType,
    payload: { by: fx.homeEntrantId, level: sport.level },
  });
  expect(sanction.status, `seeding the pending sanction: ${JSON.stringify(sanction.error)}`).toBeLessThan(300);
  return fx;
}

for (const sport of ENDING_SPORTS) {
  test(`${sport.key} v3 pad: a pending ending sanction opens the pad on the ending prompt — both answers reachable at 44px, no horizontal scroll`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const fx = await seedPendingEnding(request, sport, "Organiser");

    await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
    const pad = page.getByTestId("score-pad");
    await expect(pad).toBeVisible({ timeout: 20_000 });
    const prompt = pad.getByTestId("pad-ending-pending");
    await expect(prompt, "the pad must open on the ending prompt for a ledger that is pending").toBeVisible({ timeout: 20_000 });

    // Both answers, hit-tested at their top and bottom edges and 44px tall (the organiser console is offered both).
    await assertTapFloor(prompt.getByTestId("pad-ending-record"), "Record the ending");
    await assertTapFloor(prompt.getByTestId("pad-ending-void"), "Void the sanction");

    // Phone composition: the prompt is in the host's unordered band, so it sits ABOVE the ordered rows (ribbon, recording
    // chip, activity) on a phone and in source order at md+. The pad's one open question is the first thing under the score.
    const promptBox = await prompt.boundingBox();
    expect(promptBox, "the prompt has no box").not.toBeNull();
    const ribbonBox = await pad.locator('[data-role="v3-ribbon"]').boundingBox();
    expect(ribbonBox, "the ribbon (the sanction just recorded) has no box").not.toBeNull();
    expect(promptBox!.y, "the prompt must come before the ribbon and the rest of the ordered rows").toBeLessThan(ribbonBox!.y);

    // The board is not offered under the prompt (every tap on it would be refused by the write path).
    await expect(pad.locator('[data-role="v3-tiles"]')).toHaveCount(0);

    await expectNoHorizontalScroll(page);
    const { clipped } = await overflowingIn(page, '[data-role="v3-ending"]', "*", "the ending prompt was not in the DOM");
    expect(clipped, "the ending prompt must not clip its own content at this width").toEqual([]);
  });
}

// The SCORER's prompt (M-6). A device link is offered less than the organiser, and the copy changes with it, so the card has
// FOUR layouts, not one (`endingBodyKey`): both answers (the organiser test above), "Record the ending" alone (a fresh device: the
// sanction is the last live event so the server admits its ending, but the row is not the device's own to void), NEITHER (a
// pre-W2e ledger, where something was recorded after the card and the device did not write the sanction: only the organiser can
// resolve it), and VOID ONLY (below).
//
// Two of them are SEEDED here: the two a fresh device can reach. The third, `voidOnly`, is the card with the LONGEST copy in
// every locale and one button, and it cannot be seeded: it needs a device that wrote the sanction ITSELF in this mount
// (`ownEventIds` is in-memory only and is empty on a fresh page, so a seeded device never owns the row) AND a row recorded after
// it. It is driven in the mount instead, below the loop (W2e T33b, N2): the handed device sends the sanction through the pad,
// a row lands behind it while its ending is still on the wire, and the server refuses the ending. `neither` has no button to
// anchor the layout.
//
// The `neither` ledger cannot be written through the API (the write path refuses everything after an ending sanction), so the
// event after the card is written by raw SQL: the one way such a row exists, the shape an earlier build left behind. A stoppage is
// the sport-blind event for it (the T29 route test uses the same `[sanction, suspend]` shape).
const ENDING_SCORER_VARIANTS = [
  { name: "record-only", between: false, bodyKey: "pad.ending.body.recordOnly", record: true },
  { name: "neither", between: true, bodyKey: "pad.ending.body.neither", record: false },
] as const;

for (const sport of ENDING_SPORTS) {
  for (const variant of ENDING_SCORER_VARIANTS) {
    test(`${sport.key} v3 pad (handed device, ${variant.name}): the prompt's own copy and buttons fit — reachable at 44px, nothing clipped, no horizontal scroll`, async ({
      browser,
      request,
    }) => {
      test.setTimeout(90_000);
      const fx = await seedPendingEnding(request, sport, `Scorer ${variant.name}`);
      if (variant.between) {
        await withDb(async (sql) => {
          const [t] = await sql<{ tip: number }[]>`select coalesce(max(seq), 0)::int as tip from score_events where fixture_id = ${fx.fixtureId}`;
          await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
                    values (${randomUUID()}, ${fx.fixtureId}, ${t!.tip + 1}, 'core.suspend', ${sql.json({ reason: "rain" })}, now())`;
        });
      }
      const link = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", {
        label: `mobile ending ${variant.name} ${projectTag()}`,
      });
      expect(link.status, JSON.stringify(link.error)).toBe(201);

      // The token is the ONLY credential on this surface: no session, the project's own viewport.
      const ctx = await browser.newContext({ viewport: projectViewport() ?? undefined, storageState: await consentedAnonymousState() });
      try {
        const page = await ctx.newPage();
        await page.goto(`/score/${link.data!.secret}`, { waitUntil: "load" });
        await dismissCookieBanner(page);
        // The handed device has no console wrapper: the pad is addressed by its own `data-role`, not the console's `score-pad`.
        const pad = page.locator('[data-role="pad-v3"]');
        await expect(pad).toBeVisible({ timeout: 20_000 });
        const prompt = pad.getByTestId("pad-ending-pending");
        await expect(prompt, "a handed device opens on the ending prompt for a pending ledger").toBeVisible({ timeout: 20_000 });
        await expect(prompt, `the ${variant.name} copy is what is on the card`).toContainText(uiEn[variant.bodyKey]!);

        // What this scorer is offered, and only that: never the void (not the device's own row), the record only where admitted.
        await expect(prompt.getByTestId("pad-ending-void"), "a handed device is not offered a void of a row it did not write").toHaveCount(0);
        if (variant.record) await assertTapFloor(prompt.getByTestId("pad-ending-record"), "Record the ending");
        else await expect(prompt.getByTestId("pad-ending-record"), "where the server would answer 403, the card offers no button").toHaveCount(0);
        await expect(pad.locator('[data-role="v3-tiles"]')).toHaveCount(0);

        await expectNoHorizontalScroll(page);
        const { clipped } = await overflowingIn(page, '[data-role="v3-ending"]', "*", "the ending prompt was not in the DOM");
        expect(clipped, "the ending prompt must not clip its own content at this width").toEqual([]);
        // The whole card is reachable: its bottom edge is inside the document, so scrolling brings all of it on screen.
        const box = await prompt.boundingBox();
        expect(box, "the prompt has no box").not.toBeNull();
        expect(box!.width, "the card fits the viewport width").toBeLessThanOrEqual((projectViewport()?.width ?? 1280) + 0.5);
      } finally {
        await ctx.close();
      }
    });
  }
}

// VOID ONLY (W2e T33b, N2) - the one card layout the seeded cases above cannot reach, driven through the pad itself.
//
// The pad sends an ending sanction as TWO appends: the sanction (held for `HOLD_MS`), then its ending behind it. The device
// owns the sanction it sent in this mount, so the prompt may offer it a void. What makes the card "void only" is a row recorded
// after the sanction, which the server's D13 rule reads as "the sanction is no longer the last live event, so a scorer may not
// record its ending". The only writer of such a row is raw SQL (the write path refuses everything after an ending sanction), so
// the test holds the ENDING at the wire (a route handler that waits), writes a `core.suspend` behind the sanction (the same row
// the `neither` case writes), and lets the ending go. The server then answers it for real: the request is stale (SEQ_CONFLICT,
// the pad resyncs and merges the suspend) and, asked again against the new tip, it is a 403 - a permanent refusal, so the
// ending is dropped and the sanction stays. Nothing in the answer is faked; only WHEN the ending is sent is controlled.
//
// What it proves at this width: the card shows the voidOnly copy and exactly one button (the void, hit-testable at 44px), the
// record button is absent, nothing in the card is clipped, the page does not scroll sideways, the card fits the viewport, and
// below `md` the lone button spans its row (the row's content box, read live) rather than shrinking to its label.
for (const sport of ENDING_SPORTS) {
  test(`${sport.key} v3 pad (handed device, voidOnly): the device's own sanction with a row behind it - the prompt's longest copy and its one button fit, reachable at 44px, nothing clipped, no horizontal scroll`, async ({
    browser,
    request,
  }) => {
    // Derived from the hold, never typed (AGENTS.md failure class 20): the sanction waits out HOLD_MS before anything is sent,
    // and the merge may wait for the pad's 15s poll if the conflict resync does not get there first.
    test.setTimeout(Math.max(150_000, 90_000 + 6 * HOLD_MS));
    const fx = await seedRosteredFixture(request, {
      label: `Mobile Ending Scorer voidOnly ${sport.key} ${TAG}-${projectTag()}`,
      sportKey: sport.key,
      variantKey: ENDING_SEEDS[sport.key]!.variantKey,
      entrantKind: "individual",
      home: [{ fullName: `Mobile End VO ${sport.key} Home ${TAG}-${projectTag()}` }],
      away: [{ fullName: `Mobile End VO ${sport.key} Away ${TAG}-${projectTag()}` }],
      // No fixture lineup for tennis: nobody to ask "which player" in the sanction sheet, as scorepad-v3-ending-sanction.spec.ts
      // seeds it. Badminton singles has one on-field player, so its sheet is level -> confirm as well.
      skipLineups: sport.key === "tennis",
      emitCoreStart: true,
    });
    const link = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", {
      label: `mobile ending voidOnly ${projectTag()}`,
    });
    expect(link.status, JSON.stringify(link.error)).toBe(201);
    const voidOnlyCopy = uiEn["pad.ending.body.voidOnly"];
    expect(voidOnlyCopy, "the dictionary carries the voidOnly copy (an empty string would match any card)").toBeTruthy();
    const levelLabel = uiEn[`sanction.${sport.level}`];
    expect(levelLabel, `the dictionary names the ${sport.level} level`).toBeTruthy();

    let releaseEnding!: () => void;
    const endingMayGo = new Promise<void>((resolve) => {
      releaseEnding = resolve;
    });
    let endingsOnTheWire = 0;

    const ctx = await browser.newContext({ viewport: projectViewport() ?? undefined, storageState: await consentedAnonymousState() });
    try {
      const page = await ctx.newPage();
      // Hold the ENDING (a core.forfeit POST) at the wire until the test says go. Every other request, including the
      // sanction's own POST and every ledger read, passes straight through to the real server.
      await page.route(`**/api/v1/fixtures/${fx.fixtureId}/events`, async (route) => {
        const req = route.request();
        const body = req.method() === "POST" ? (req.postDataJSON() as { type?: string } | null) : null;
        if (body?.type !== "core.forfeit") return route.continue();
        endingsOnTheWire++;
        await endingMayGo;
        return route.continue();
      });

      await page.goto(`/score/${link.data!.secret}`, { waitUntil: "load" });
      await dismissCookieBanner(page);
      const pad = page.locator('[data-role="pad-v3"]');
      await expect(pad).toBeVisible({ timeout: 20_000 });

      // The device records the end-level sanction through the pad: tile -> level -> read-back -> Confirm.
      const tile = pad.locator('[data-tile-id="sanction-home"]');
      await expect(tile, "the sanction tile is on a live pad").toBeVisible({ timeout: 20_000 });
      await tile.click();
      const sheet = pad.locator('[data-role="v3-sheet"]');
      await expect(sheet, "the sanction sheet opens").toBeVisible({ timeout: 20_000 });
      await sheet.getByRole("button", { name: levelLabel!, exact: true }).click();
      await expect(sheet.getByTestId("pad-sheet-summary"), `${sport.level} asks 'This ends the match' before anything is sent`).toBeVisible();
      await sheet.getByTestId("pad-sheet-confirm").click();

      // The sanction drains first (after its hold), the ending right behind it - and waits at the wire.
      await expect
        .poll(() => endingsOnTheWire, { timeout: HOLD_MS + 30_000, message: "the pad sent the ending behind the sanction" })
        .toBeGreaterThan(0);
      const sent = await apiJson<{ seq: number; type: string }[]>(request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
      expect(
        (sent.data ?? []).map((e) => e.type),
        "premise: the sanction is on the ledger and the ending is not (it is held at the wire)",
      ).toEqual(["core.start", sport.eventType]);

      // A row behind the sanction: the one way such a ledger exists (an earlier build left them), as in the `neither` case.
      await withDb(async (sql) => {
        const [t] = await sql<{ tip: number }[]>`select coalesce(max(seq), 0)::int as tip from score_events where fixture_id = ${fx.fixtureId}`;
        await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
                  values (${randomUUID()}, ${fx.fixtureId}, ${t!.tip + 1}, 'core.suspend', ${sql.json({ reason: "rain" })}, now())`;
      });
      releaseEnding();

      // The server refuses the ending and the pad lands on the voidOnly card: the copy is the proof the device owns the
      // sanction (a pad that did not would say `neither`) and that it may no longer record the ending.
      const prompt = pad.getByTestId("pad-ending-pending");
      await expect(prompt, "the card says only the void is left").toContainText(voidOnlyCopy!, { timeout: 60_000 });
      const after = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
      expect((after.data ?? []).map((e) => e.type), "the refused ending wrote nothing").toEqual(["core.start", sport.eventType, "core.suspend"]);

      await expect(prompt.getByTestId("pad-ending-record"), "where the server answers 403, the card offers no record button").toHaveCount(0);
      const voidButton = prompt.getByTestId("pad-ending-void");
      await expect(voidButton, "the device's own sanction can be voided").toHaveCount(1);
      await assertTapFloor(voidButton, "Void the sanction");
      await expect(pad.locator('[data-role="v3-tiles"]')).toHaveCount(0);

      await expectNoHorizontalScroll(page);
      const { clipped } = await overflowingIn(page, '[data-role="v3-ending"]', "*", "the ending prompt was not in the DOM");
      expect(clipped, "the ending prompt must not clip its own content at this width").toEqual([]);

      const width = projectViewport()?.width ?? 1280;
      const [cardBox, buttonBox] = [await prompt.boundingBox(), await voidButton.boundingBox()];
      expect(cardBox, "the prompt has no box").not.toBeNull();
      expect(buttonBox, "the void button has no box").not.toBeNull();
      expect(cardBox!.width, "the card fits the viewport width").toBeLessThanOrEqual(width + 0.5);
      expect(buttonBox!.width, "the button stays inside the card").toBeLessThanOrEqual(cardBox!.width + 0.5);
      // Below `md` (768) the buttons stack full width (`flex-col`, so they stretch): the lone button spans its row's CONTENT box.
      // That box is read live (the row's clientWidth less its computed horizontal padding), never typed as a gutter: the card has
      // its own 1px border and the row its own `px-4`, so a literal "card minus 32" is off by the border and moves with any class.
      const row = await voidButton.evaluate((el) => {
        const parent = el.parentElement!;
        const cs = getComputedStyle(parent);
        return { button: el.getBoundingClientRect().width, content: parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
      });
      expect(row.content, "the button row has a content box").toBeGreaterThan(0);
      expect(row.button, "the button stays inside its row").toBeLessThanOrEqual(row.content + 0.5);
      if (width < 768) {
        expect(row.button, "below md the lone button spans its row's content box").toBeGreaterThanOrEqual(row.content - 0.5);
      }
    } finally {
      releaseEnding();
      await ctx.close();
    }
  });
}

// ---------------------------------------------------------------------------
// W2e Task 32 (B2-3, M12b) -- THE "INJURED, NO SUB" CONTROL, AT EVERY WIDTH.
//
// Football, volleyball, hockey and ice hockey each gained a per-side tile (`retire-<side>`, `retirement-slot.ts`) that opens
// the swap sheet's OFF picker and stops there. `scorepad-v3-retirement.spec.ts` drives the control end to end at one
// width; THIS block is the width gate: the tile clears the 44px floor the way a finger meets it (`assertTapFloor`
// hit-tests both edges), the picker's rows clear it, and the page does not scroll sideways, at all seven phone widths.
//
// THE FOLDS (AGENTS.md failure class 22). The tile lives on the board, not behind a disclosure -- but the console around it
// folds the lineup and (on a phone) the device hand-over / Stream, so the claim "the control does not need a fold opened to
// be reached" is itself worth proving, and "opening the folds does not push it off the board or break the floor" with it.
// So: assert the tile with every fold as the console left it, then open EVERY fold instance (`openEveryPhoneFold` waits on
// `toBeAttached`, never `toBeVisible` -- visibility is what a fold denies -- and gates each open on that toggle being
// visible, never on a width literal) and assert it again. The picker is opened and NOT answered: answering commits an event
// and starts the soft-commit hold, which a width gate has no reason to pay for.
//
// One test per sport, each with its own roster of STARTERS: the control is offered only to a side with someone on the field,
// and a lineup-less or all-bench side legitimately has no tile. The rosters are positioned with each sport's own
// position keys (`packages/engine/src/sports/*`), the names carry `projectTag()` (two width projects share one CI process).
// ---------------------------------------------------------------------------

/**
 * Open everything the console folds: the header bar's Lineup panel (the heavy block the old Lineup disclosure held; the
 * bar is one control per panel at every width, so it is opened by its own button) and every phone-disclosure instance
 * whose toggle is visible at this width. Returns how many things were opened (panel + disclosures), so a caller can
 * still prove it was not vacuous.
 */
async function openEveryPhoneFold(page: Page): Promise<number> {
  expect(await openConsolePanel(page, "lineup"), "the console offers the Lineup panel (a football/volleyball/hockey fixture)").toBe(true);
  let opened = 1;
  const toggles = page.locator('[data-role="phone-disclosure-toggle"]');
  const n = await toggles.count();
  for (let i = 0; i < n; i++) {
    const toggle = toggles.nth(i);
    if (!(await toggle.isVisible())) continue;
    if ((await toggle.getAttribute("aria-expanded")) === "true") continue;
    await toggle.click();
    await expect(toggle, `fold ${i + 1} of ${n} opens`).toHaveAttribute("aria-expanded", "true");
    opened++;
  }
  return opened;
}

const VB_COURT = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;
const RETIREMENT_SPORTS: readonly {
  readonly sportKey: string;
  readonly variantKey: string;
  readonly short: string;
  readonly home: readonly string[];
  readonly away: readonly string[];
}[] = [
  { sportKey: "football", variantKey: "11-a-side", short: "RFB", home: ["FW", "GK", "DF"], away: ["GK"] },
  { sportKey: "volleyball", variantKey: "indoor", short: "RVB", home: [...VB_COURT], away: [...VB_COURT] },
  { sportKey: "hockey", variantKey: "fih-outdoor", short: "RHK", home: ["GK", "DF", "FW"], away: ["GK"] },
  { sportKey: "icehockey", variantKey: "iihf", short: "RIH", home: ["G", "D", "F"], away: ["G"] },
];

for (const sport of RETIREMENT_SPORTS) {
  test(`${sport.sportKey} v3 pad: the Injured (no sub) tile and its picker hold the 44px floor with the folds closed and open, no horizontal scroll`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const roster = (side: string, positions: readonly string[]) =>
      positions.map((positionKey, i) => ({ fullName: `Mobile ${sport.short} ${side}${i + 1} ${TAG}-${projectTag()}`, positionKey }));
    const home = roster("H", sport.home);
    const fx = await seedRosteredFixture(request, {
      label: `Mobile ${sport.short} Retire ${TAG}-${projectTag()}`,
      sportKey: sport.sportKey,
      variantKey: sport.variantKey,
      entrantKind: "team",
      home,
      away: roster("A", sport.away),
      emitCoreStart: true,
    });

    await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
    await dismissCookieBanner(page);
    await assertV3PadHoldsAtThisWidth(page, `${sport.sportKey} pad at rest`, 4);

    // 1. Folds as the console left them: the tile is on the board and tappable.
    await assertTapFloor(padTile(page, "retire-home"), `${sport.sportKey}: home Injured tile, folds as left`);
    await assertTapFloor(padTile(page, "retire-away"), `${sport.sportKey}: away Injured tile, folds as left`);

    // 2. Every fold opened (EVERY instance): still on the board, still over the floor, page still not scrolling sideways.
    // Non-vacuous by construction: openEveryPhoneFold hard-expects the Lineup panel to open (a count >0 would be a tautology).
    await openEveryPhoneFold(page);
    await assertTapFloor(padTile(page, "retire-home"), `${sport.sportKey}: home Injured tile, every fold open`);
    await expectNoHorizontalScroll(page);

    // 3. The picker: one row per starter, each over the floor, none for the bench / away side, and the sheet stays inside the page.
    await padTile(page, "retire-home").click();
    const swap = page.getByTestId("score-pad").locator('[data-role="v3-swap"][data-swap-slot-id="retire-home"]');
    await expect(swap, `${sport.sportKey}: the retirement picker must open`).toBeVisible({ timeout: 20_000 });
    await expect(swap.locator("[data-candidate-id]"), "one row per starter on the field").toHaveCount(home.length, { timeout: 20_000 });
    for (const p of home) {
      // Hit-tested at both edges, not box-measured (review M2): a row is a tap target, and a painted 44 that a finger cannot
      // land on is exactly what `assertTapFloor` exists to catch.
      await assertTapFloor(swap.locator(`[data-candidate-id="${fx.personIds[p.fullName]!}"]`), `${sport.sportKey}: picker row ${p.positionKey}`);
    }
    await expectNoHorizontalScroll(page);
  });
}

// W2e Task 31 (D12, VB-SE-1) -- THE FIELD-SIX QUESTION, AT EVERY WIDTH (review M3).
//
// An expulsion or a disqualification asks "Can <team> still field six players?" BEFORE anything is written
// (`scorepad-v3-ending-sanction.spec.ts` drives both answers end to end at one width). This is its width gate: the question is
// on screen, both answers clear the 44px floor the way a finger meets them (`assertTapFloor`), nothing in the sheet is
// clipped, and the page does not scroll sideways. The sanction tile is on the board, not in a fold, but the console around it
// folds (AGENTS.md failure class 22), so EVERY fold instance is opened first (`openEveryPhoneFold`: attached, never visible;
// gated on the toggle being visible, never on a width). Not answered: an answer commits and starts the hold.
// The level is the engine's own first prompt level (`sanctionEnding.promptLevels`), its label the pad's word for it.
const FIELD_SIX_LEVEL = builtinModules.find((m) => m.key === "volleyball")!.sanctionEnding!.promptLevels[0]!;

test("volleyball v3 pad: the field-six question and both answers hold the 44px floor with every fold open, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const roster = (side: string) =>
    VB_COURT.map((positionKey, i) => ({ fullName: `Mobile F6 ${side}${i + 1} ${TAG}-${projectTag()}`, positionKey }));
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Field-six ${TAG}-${projectTag()}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    entrantKind: "team",
    home: roster("H"),
    away: roster("A"),
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await assertV3PadHoldsAtThisWidth(page, "volleyball pad at rest", 4);
  // Non-vacuous by construction: openEveryPhoneFold hard-expects the Lineup panel to open (a count >0 would be a tautology).
  await openEveryPhoneFold(page);

  await assertTapFloor(padTile(page, "sanction-home"), "volleyball: home sanction tile, every fold open");
  await padTile(page, "sanction-home").click();
  const sheet = v3Sheet(page);
  await expect(sheet, "the sanction sheet must open").toBeVisible({ timeout: 20_000 });
  const levelLabel = uiEn[`sanction.${FIELD_SIX_LEVEL}`];
  expect(levelLabel, `the dictionary names the ${FIELD_SIX_LEVEL} level`).toBeTruthy();
  await sheet.getByRole("button", { name: levelLabel!, exact: true }).click();
  // WHO: the first on-field player (a team sheet is declared, so the person step is asked before the question).
  await sheet.locator("[data-candidate-id]").first().click();

  await expect(sheet, "the question is asked").toContainText(/still field six players\?/i);
  await assertTapFloor(sheet.locator('[data-choice-option-id="yes"]'), "field-six: Yes");
  await assertTapFloor(sheet.locator('[data-choice-option-id="no"]'), "field-six: No");
  const o = await overflowingIn(page, '[data-role="v3-sheet"]', "*", "the field-six sheet is missing");
  expect(o.clipped, `nothing in the field-six sheet is clipped at ${page.viewportSize()!.width}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  // Asking wrote nothing.
  const rows = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
  expect((rows.data ?? []).map((e) => e.type), "the question is asked before anything is written").toEqual(["core.start"]);
});
