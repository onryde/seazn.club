import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { fixturePath, seedRosteredFixture, expectNoHorizontalScroll, TAG } from "./helpers";
import {
  HIT_TARGET_FLOOR_PX,
  dismissCookieBanner,
  measureHitTargets,
  scanPadContrast,
  smallestOperable,
  type HitTarget,
} from "./scorepad-a11y-kit";
import { V3_SKIN_CASES, type V3SkinCase } from "./v3-skin-catalog";

/*
 * ScoringPad v3, R8/WS-H — the WCAG AA colour-contrast scan and the 44px
 * hit-target floor, over EVERY v3 pad skin, at every width this repo holds
 * itself to.
 *
 * WHAT THE COVERAGE WAS BEFORE THIS FILE, counted rather than assumed:
 *
 *   - 44px hit targets: ONE sport. `scorepad-a11y-evidence.spec.ts` measures
 *     them for `generic` and nothing else — 1 skin of 11.
 *   - Colour contrast: SIX sports. `scorepad-skins.spec.ts` scans cricket,
 *     tennis, volleyball, football and icehockey (one width each, 375);
 *     `scorepad-a11y-evidence.spec.ts` scans generic.
 *   - badminton, boardgame, carrom, hockey and tabletennis had NEITHER. Five
 *     shipped skins with zero accessibility coverage of any kind.
 *
 * That gap was not an oversight anyone made once: every a11y assertion in the
 * suite named its sport BY HAND, so each conversion wave (R4 tennis, R5
 * badminton/table tennis/volleyball, R6 the period pair, R7 generic/boardgame/
 * carrom) shipped a skin that no accessibility gate had a reason to know
 * existed. This file is parametrised over `e2e/v3-skin-catalog.ts` precisely
 * so a TWELFTH sport is covered by adding one array entry — and
 * `v3/__tests__/a11y-sweep-totality.test.ts` reds if someone adds it to
 * `V3_SKINS` and forgets, so the "one array entry" is enforced rather than
 * hoped for.
 *
 * WHAT STATE IS MEASURED, and the honest limit of it. Each sport is measured
 * with its pad LIVE AND AT REST: scorebug (both halves, the strip, the who
 * lines), the recording chip, the context strip where the skin declares one,
 * the clock bar where the skin declares one, and the whole tile grid. That is
 * the one state all eleven skins share — the v3 chassis has three different
 * tap models across these sports (halves-are-buttons, tile-opens-a-dock,
 * tile-opens-a-guided-sheet) and one of them, boardgame, COMMITS A TERMINAL
 * RESULT on a half tap and unmounts the pad, so there is no uniform "tap
 * something and measure what opens" that is not eleven special cases wearing a
 * loop.
 *
 * It is therefore deliberately NOT a replacement for the deeper single-sport
 * passes, and both survive: `scorepad-a11y-evidence.spec.ts` keeps generic's
 * post-tap Detail Dock measurement (plus focus order, tab traps and a
 * screenshot record) on the console AND the device-link pad, and
 * `scorepad-skins.spec.ts` keeps its five post-interaction scans. What this
 * file adds is BREADTH the others cannot give: eleven skins, three widths,
 * both gates, one array.
 *
 * WIDTHS: 1280 / 768 / 320 — the three AGENTS.md names for every UI change
 * ("desktop (1280), 320px, and 768px, with no horizontal page scroll at any of
 * them"). 375 is left to the two files above (`scorepad-skins.spec.ts` runs
 * its whole file there, and the evidence spec measures generic at 1280/375/320)
 * rather than paid for again eleven times here. All three are measured inside
 * ONE test per sport: seeding a rostered fixture is the expensive part by an
 * order of magnitude, and `setViewportSize` is nearly free, so three tests per
 * sport would triple the fixture cost to re-measure the same pad.
 *
 * TWO FALSE-CLEAN TRAPS, both closed in `scorepad-a11y-kit.ts` rather than
 * here — see that file's header for the incidents. In short: axe's
 * `.include()` will happily scan the page chrome or the cookie banner and
 * report zero violations, so `scanPadContrast` refuses to answer until it has
 * proved the scope is visible, contains the v3 scorebug, and had at least one
 * `color-contrast` node actually evaluated inside it; and `measureHitTargets`
 * is the suite's ONE implementation of the 44px measurement, imported, never
 * re-derived from a class name.
 *
 * `expect.soft` throughout, for the same reason the evidence spec uses it: a
 * skin that fails at 320 must still be measured at 768 and 1280, and the JSON
 * record must be written either way — a run that stops at the first failure
 * tells you one number and hides ten.
 */
test.describe.configure({ mode: "parallel" });

const OUT_DIR = fileURLToPath(new URL("../test-results/r8-a11y-sweep/", import.meta.url));

/** AGENTS.md's own three. Height is generous enough that nothing folds. */
const SWEEP_WIDTHS = [
  { width: 1280, height: 900 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;

/** Per-width cost: an axe run plus one boundingBox+evaluate round trip per
 *  interactive element in the pad. Expressed against the width count rather
 *  than typed as a flat number, so adding a fourth width moves the budget with
 *  it instead of leaving a latent red (AGENTS.md, failure class 20). */
const SWEEP_TIMEOUT_MS = Math.max(120_000, 45_000 + SWEEP_WIDTHS.length * 25_000);

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

interface WidthRecord {
  width: number;
  /** The pad's OWN painted width at this viewport. Recorded, and asserted
   *  across the sweep, because "measured at three widths" is a claim that goes
   *  vacuous silently: if the resize never reached the layout, all three
   *  passes measure the 1280 render and the 320 column — the one where a tile
   *  actually gets squeezed under the floor — is never tested at all. The
   *  first run of this file returned a byte-identical smallest target at
   *  1280/768/320, which is what prompted this field; it turned out to be
   *  genuine (the smallest control is intrinsically sized) but nothing in the
   *  record could tell the two explanations apart. Now it can. */
  padWidthPx: number | null;
  overflowPx: number | null;
  operableCount: number;
  smallest: HitTarget | null;
  contrastNodes: number;
  violations: { id: string; impact: string | null; nodes: number }[];
  seriousCount: number;
}

/** Seed a live fixture for one skin and open its console pad. `emitCoreStart`
 *  rather than driving the console's own "Start match" control: this file
 *  measures the LIVE pad, and how the fixture got live is not its subject —
 *  the sports whose own specs prove the real organiser flow already do that.
 *  The wait afterwards is on the CLIENT's live render (`v3-scorebug`), not on
 *  the server's ledger, because a scorebug that has not repainted yet is
 *  exactly the pre-fold `<div>` state whose geometry would be measured
 *  instead of the real one. */
async function openLivePad(page: Page, skin: V3SkinCase) {
  const label = `A11y ${skin.key} ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label,
    sportKey: skin.key,
    variantKey: skin.variantKey,
    entrantKind: skin.entrantKind,
    home: skin.home.map((slot, i) => ({
      fullName: `A11y ${skin.key} Home ${i + 1} ${TAG}`,
      ...(slot.positionKey ? { positionKey: slot.positionKey } : {}),
    })),
    away: skin.away.map((slot, i) => ({
      fullName: `A11y ${skin.key} Away ${i + 1} ${TAG}`,
      ...(slot.positionKey ? { positionKey: slot.positionKey } : {}),
    })),
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  // Before anything is measured: the consent banner is a fixed overlay that
  // intercepts pointer events and sits over the page. `auth.setup.ts`
  // pre-dismisses it into this project's storageState so it should never be
  // here — this is the assertion that the pre-dismissal still works, not a
  // workaround for it failing.
  await dismissCookieBanner(page);
  await expect(pad(page), `${skin.key}: the console must render a pad`).toBeVisible({ timeout: 20_000 });
  await expect(
    pad(page).locator('[data-role="v3-scorebug"]'),
    `${skin.key}: ${skin.note} — the v3 chassis must have taken the fixture live`,
  ).toBeVisible({ timeout: 20_000 });
  return fx;
}

/** Resize and WAIT for the resize to have landed before measuring. A
 *  `setViewportSize` resolves when the viewport is set, not when the document
 *  has relaid out against it — measuring on the same tick reads the previous
 *  width's geometry, which at 320 would silently record the 768 layout as
 *  passing. */
async function settleAtWidth(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.waitForFunction((w) => document.documentElement.clientWidth === w, width, { timeout: 10_000 });
  // One frame, so a layout scheduled by the resize has actually painted.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

for (const skin of V3_SKIN_CASES) {
  test(`v3 a11y sweep — ${skin.key}: WCAG AA contrast + ${HIT_TARGET_FLOOR_PX}px hit targets at ${SWEEP_WIDTHS.map((w) => w.width).join("/")}px`, async ({
    page,
  }) => {
    test.setTimeout(SWEEP_TIMEOUT_MS);
    await mkdir(OUT_DIR, { recursive: true });

    await openLivePad(page, skin);

    const records: WidthRecord[] = [];
    for (const { width, height } of SWEEP_WIDTHS) {
      await settleAtWidth(page, width, height);
      const where = `${skin.key} @ ${width}px`;
      const padBox = await pad(page).boundingBox();

      // --- no horizontal page scroll ---------------------------------------
      // Soft, via try/catch, for the same reason the evidence spec does it:
      // the helper throws, and a throw here would abandon the two gates this
      // file actually exists for.
      let overflowPx: number | null = null;
      try {
        await expectNoHorizontalScroll(page);
        overflowPx = 0;
      } catch (err) {
        overflowPx = -1;
        expect.soft(false, `${where}: ${err instanceof Error ? err.message : String(err)}`).toBe(true);
      }

      // --- the 44px floor ---------------------------------------------------
      const targets = await measureHitTargets(pad(page));
      const operable = targets.filter((t) => !t.disabled);
      const smallest = smallestOperable(targets);
      expect
        .soft(smallest, `${where}: no operable hit target rendered inside the pad — nothing was measured`)
        .not.toBeNull();
      if (smallest) {
        const detail = `${where}: smallest operable target "${smallest.name}" (${smallest.role}) is ${smallest.width}x${smallest.height}px`;
        expect.soft(smallest.width, detail).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
        expect.soft(smallest.height, detail).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
      }

      // --- WCAG A/AA, serious+critical --------------------------------------
      // The scope is the pad's own wrapper, never the page: pre-existing
      // contrast debt on the wider fixture-console chrome is a different
      // owner's, and letting it fail here would train the next session to
      // widen the tolerance rather than fix a skin.
      const scan = await scanPadContrast(page, '[data-testid="score-pad"]');
      expect
        .soft(scan.serious, `${where}: ${JSON.stringify(scan.serious, null, 2)}`)
        .toEqual([]);

      records.push({
        width,
        padWidthPx: padBox ? Math.round(padBox.width * 100) / 100 : null,
        overflowPx,
        operableCount: operable.length,
        smallest,
        contrastNodes: scan.contrastNodes,
        violations: scan.violations,
        seriousCount: scan.serious.length,
      });
    }

    // THE ANTI-VACUITY GUARD FOR THE SWEEP ITSELF. Everything above is
    // measured three times; this is the only thing that proves the three
    // measurements were of three different layouts. A `setViewportSize` that
    // resolved but never reached the document — or a pad inside a fixed-width
    // container — would give three passes over the 1280 render, and the 320
    // column, which is the one where a control actually gets squeezed under
    // the floor, would never have been tested while reporting that it was.
    // Sorted by width so this holds whatever order SWEEP_WIDTHS is written in.
    const byWidth = [...records].sort((a, b) => a.width - b.width);
    const narrowest = byWidth[0]!;
    const widest = byWidth[byWidth.length - 1]!;
    expect
      .soft(
        narrowest.padWidthPx,
        `${skin.key}: the pad measured ${narrowest.padWidthPx}px wide at a ${narrowest.width}px viewport and ${widest.padWidthPx}px at ${widest.width}px — it did not re-lay out, so all ${records.length} passes measured the same render`,
      )
      .toBeLessThan(widest.padWidthPx ?? 0);

    await writeFile(
      join(OUT_DIR, `${skin.key}.json`),
      JSON.stringify({ sport: skin.key, variant: skin.variantKey, note: skin.note, widths: records }, null, 2),
    );
  });
}
