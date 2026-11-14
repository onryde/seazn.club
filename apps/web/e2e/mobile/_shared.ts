// Helpers shared by the files in this directory, moved verbatim out of the former e2e/mobile.spec.ts (split 2026-11-13).
// Not a spec (no `.spec.ts` suffix), so no project selects it; the spec files import from here.
//
// v3/02 §4 viewport gate — the former mobile.spec.ts header, kept here because every file in this directory inherits it:
// runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — see MOBILE_SPECS in playwright.config.ts).
// Every audited route must render with zero page-level horizontal scroll; key surfaces must pass axe
// (serious/critical) and the public dashboard + registration page must LCP under 2.5 s on Fast-3G
// (v3/11 gaps 11, 12, 15).

import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expectNoHorizontalScroll, overflowingIn } from "../helpers";
import {
  HIT_TARGET_FLOOR_PX,
  floorViolationLines,
  hitTargetFloorReport,
  measureHitTargets,
} from "../scorepad-a11y-kit";


/** The viewport this PROJECT declares. Raw `browser.newContext()` does not
 *  inherit project `use` options, so every anon context must thread this
 *  through explicitly or it silently runs at Playwright's 1280×720 default. */
export const projectViewport = (): { width: number; height: number } | null =>
  (test.info().project.use as { viewport?: { width: number; height: number } })
    .viewport ?? null;

/** The scorebug's own clipping gate. Nothing inside it may be silently
 *  clipped. Two things are allowed to overflow, each held to its own
 *  invariant: the phone meta rail must be keyboard-reachable, which is the
 *  same `tabindex` axe's `scrollable-region-focusable` demanded of it (CI
 *  e2e run 33735186301, `parallel 2/2`); a `max-md:truncate` hint or a
 *  `max-md:line-clamp-2` name must carry `text-overflow: ellipsis` or a real
 *  `-webkit-line-clamp` — not merely `overflow: hidden` — as its own signal
 *  that content was shortened on purpose. Asserting both exemptions pays for
 *  itself: a rail that lost its tab stop, a hint or name that lost its
 *  truncation signal, or a NEW `overflow-x-auto`/`truncate`/`line-clamp` box
 *  appearing in the scorebug without the property that earns its exemption,
 *  reddens here instead of quietly widening either one. */
export async function expectScorebugNotClipped(page: Page, label: string): Promise<void> {
  const { clipped, scrollable } = await overflowingIn(
    page,
    '[data-role="v3-scorebug"]',
    "button,div,span",
    "the scorebug was not in the DOM",
  );
  expect(clipped, `${label} is clipped at this width`).toEqual([]);
  for (const box of scrollable) {
    expect(box, `${label}: a scrolling box inside the scorebug is not keyboard-reachable`).toMatch(/tabindex=0$/);
  }
}

/** The project (viewport) this test is running under, e.g. "mobile-430".
 *  helpers.ts's `TAG` is `Date.now().toString(36)`, evaluated once per
 *  worker process — and a single `npx playwright test` invocation starts
 *  all seven width projects as separate worker processes nearly
 *  simultaneously, so two of them can land in the same millisecond and
 *  resolve the SAME TAG (measured: the collision moved from mobile-430 to
 *  tablet-834 between two otherwise-identical runs). Any P6 test that
 *  MUTATES shared state folds this into its identity (email), because
 *  mintLoginPathBySql's `insert ... on conflict (email) do nothing` makes a
 *  colliding email log both workers into the literal same user — and from
 *  there the same org, division and seed proposal, which is what produced
 *  the `selectOption` timeout: one worker's confirm() flips the proposal
 *  out from under the other, whose rows are then correctly no longer
 *  editable. Read-only P6 tests that must see a mutating sibling's data
 *  (same block, same worker) reuse that sibling's tagged identity instead
 *  of computing their own — see the P6 setup/org-surface/public-surface and
 *  P6 task B blocks below. */
export const projectTag = (): string => test.info().project.name;

// "load" + a short settle instead of networkidle — the dev server's HMR
// socket keeps the network permanently busy and cold compiles already eat
// the budget.
export async function auditRoute(
  page: Page,
  path: string,
  opts: { allowancePx?: number; requireScorePad?: boolean; requireTestId?: string } = {},
) {
  const response = await page.goto(path, { waitUntil: "load" });
  expect(response, `${path}: navigation produced no response`).not.toBeNull();
  expect(response!.status(), `${path} returned ${response!.status()}`).toBeLessThan(400);
  await page.waitForTimeout(300);
  if (opts.requireScorePad) {
    // R3.5 review round 1 (finding 3) — a 2xx status and no overflow both
    // pass on a console that rendered its shell with NO pad at all (a
    // division config that fails z.object parsing on the way in does
    // exactly this — see the decider seeding below). Same class as the
    // #349 404 vacuity this file already records above: a route that
    // "passed" without ever rendering the surface it was meant to audit.
    // Opt-in, not the default — most routes here legitimately have no pad.
    await expect(
      page.getByTestId("score-pad"),
      `${path}: expected the score pad to be visible, not just a ${response!.status()} response`,
    ).toBeVisible();
  }
  if (opts.requireTestId !== undefined) {
    // The same vacuity, for a route a QUERY STRING picks: the sponsor's page and the deal's page are `?sponsor=` / `?deal=` on the
    // hub, and an id it does not know renders the list - a 200 with no overflow. So the page must show what the route is FOR, once.
    const wanted = page.getByTestId(opts.requireTestId);
    await expect(wanted, `${path}: expected exactly one ${opts.requireTestId}, not just a ${response!.status()} response`).toHaveCount(1);
    await expect(wanted, `${path}: expected ${opts.requireTestId} to be visible`).toBeVisible();
  }
  await expectNoHorizontalScroll(page, opts);
}

/** The SHIPPED copy for both legs of the draw-list test below, so a
 *  dictionary edit moves the assertions with it instead of freezing today's
 *  sentence (the idiom `progression-bye.spec.ts` and four other specs use).
 *  Asserting a hand-typed "Winner of R1·1" is how an EN leg ends up able to
 *  pass on the wrong copy — and how the es leg stops proving it is a lookup
 *  at all. `slot.match_ref` is identical in every locale by design, so only
 *  the sentence around it changes. */
export const dlDict = (locale: "en" | "es"): Record<string, string> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"),
  ) as Record<string, string>;

export function padTile(page: Page, id: string): Locator {
  return page.getByTestId("score-pad").locator(`[data-tile-id="${id}"]`);
}

/**
 * The floor asserted the way a finger meets it: hit-test the extremes of the
 * control's own box and require both to land on the control.
 *
 * `boundingBox()` alone cannot see whether a control is genuinely tappable
 * across its painted height — this is how tile-grid.tsx's `minor` kind stayed
 * wrong for four waves. It painted 40px and claimed 44 via a `::before` bleed
 * of 2px top and bottom; a click dispatched into that bleed in a real browser
 * lands on the GRID CONTAINER and never opens the tile's sheet. A box
 * assertion cannot tell a real 44 from a claimed one, in either direction.
 *
 * `scrollIntoViewIfNeeded` first, and deliberately: `elementFromPoint` is
 * viewport-relative and answers `null` for everything below the fold, so
 * without it this probe reports "not tappable" for any control that merely
 * happens to be off-screen — the first version of this helper did exactly
 * that, and read as a product defect.
 */
export async function assertTapFloor(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} not visible`).toBeVisible({ timeout: 20_000 });
  // CENTRE it, don't merely bring it on-screen. `scrollIntoViewIfNeeded()`
  // scrolls the minimum distance, which parks the element FLUSH with the
  // viewport top — directly beneath the app's sticky nav — and the top-edge
  // hit test below then lands on the nav and reports a control as untappable
  // when nothing is wrong with it. That is scroll position, not geometry: it
  // fired only at 320px, where the taller page happens to produce that exact
  // resting place. Centring removes the artifact while leaving what this
  // probe is actually for — occlusion by the element's own neighbours —
  // fully intact.
  await locator.evaluate((el) => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
  });
  const probe = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const hit = (y: number): boolean => {
      const at = document.elementFromPoint(cx, y);
      return at !== null && (at === el || el.contains(at));
    };
    // 1px inside each edge — a fractional layout must not put the probe on
    // the boundary pixel itself and read as a miss.
    return { height: r.height, top: hit(r.top + 1), bottom: hit(r.bottom - 1) };
  });
  expect(probe.height, `${label} touch target is ${probe.height}px`).toBeGreaterThanOrEqual(44);
  expect(probe.top, `${label} is not tappable at its TOP edge`).toBe(true);
  expect(probe.bottom, `${label} is not tappable at its BOTTOM edge`).toBe(true);
}

/**
 * The gate every one of these four pads owes at every one of the seven widths.
 *
 * `minOperable` is a VACUITY GUARD, not a census. `report.under` is `[]` both
 * for a pad whose every control clears the floor and for a pad that rendered
 * no controls at all — a sheet that silently failed to open, a fixture that
 * came back decided (`reference_decided_fixture_hides_pad_both_routes`) — and
 * those two states are indistinguishable in the passing output. Each caller
 * additionally names the specific tiles that must be on screen, which is where
 * the per-skin specificity actually lives; the per-skin OPERABLE CENSUS is the
 * a11y sweep's job, not this file's.
 */
export async function assertV3PadHoldsAtThisWidth(
  page: Page,
  label: string,
  minOperable: number,
): Promise<void> {
  const pad = page.getByTestId("score-pad");
  await expect(pad, `${label}: the v3 pad did not render`).toBeVisible({ timeout: 20_000 });
  const report = hitTargetFloorReport(await measureHitTargets(pad));
  expect(
    report.operable.length,
    `${label}: only ${report.operable.length} operable controls inside the pad ` +
      `(expected at least ${minOperable}) — an empty measurement makes the floor ` +
      `assertion below vacuous, so this is a failure, not a clean`,
  ).toBeGreaterThanOrEqual(minOperable);
  expect(
    floorViolationLines(report),
    `${label}: ${report.under.length} of ${report.operable.length} operable targets are ` +
      `under ${HIT_TARGET_FLOOR_PX}px at ${projectTag()} (smallest by area, for reference: ` +
      `"${report.smallest?.name ?? "-"}" ${report.smallest?.width ?? 0}x${report.smallest?.height ?? 0})`,
  ).toEqual([]);
  await expectNoHorizontalScroll(page);
}

/** The guided sheet the chassis renders for a tile whose action is a sheet. */
export function v3Sheet(page: Page): Locator {
  return page.getByTestId("score-pad").locator('[data-role="v3-sheet"]');
}

/** A tap target hit-tested at both edges, with its floor: 44 where `floor` says so, otherwise only that the centre column reaches it. */
export async function hitFloor(locator: Locator, label: string, floor: number): Promise<void> {
  await expect(locator, `${label} is not visible`).toBeVisible({ timeout: 20_000 });
  await locator.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  const probe = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const hit = (y: number): boolean => {
      const at = document.elementFromPoint(cx, y);
      return at !== null && (at === el || el.contains(at));
    };
    return { height: r.height, width: r.width, top: hit(r.top + 1), bottom: hit(r.bottom - 1), centre: hit(r.top + r.height / 2) };
  });
  expect(probe.height, `${label} is ${probe.height}px tall (floor ${floor})`).toBeGreaterThanOrEqual(floor);
  expect(probe.top, `${label}: a tap at its top edge does not reach it`).toBe(true);
  expect(probe.bottom, `${label}: a tap at its bottom edge does not reach it`).toBe(true);
  expect(probe.centre, `${label}: a tap at its centre does not reach it`).toBe(true);
}
/** Nothing in `locator` is painted past the viewport (a box that overflows its parent would show here even where the page itself clips). */
export async function paintedInsideViewport(locator: Locator, label: string): Promise<number> {
  await expect(locator, `${label} is not visible`).toBeVisible({ timeout: 20_000 });
  const probe = await locator.evaluate((root) => {
    const boxes = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))].filter((e) => e.getClientRects().length > 0);
    const out = boxes.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.right > window.innerWidth + 0.5 || r.left < -0.5;
    });
    return { n: boxes.length, out: out.map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute("data-testid") ?? ""}]`) };
  });
  expect(probe.out, `${label} is painted outside the viewport`).toEqual([]);
  return probe.n;
}
