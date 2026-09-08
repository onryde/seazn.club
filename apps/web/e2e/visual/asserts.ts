// The owner checklist's VERIFY-AS-CUSTOMER rows, each as one reusable
// assertion the capture spec runs per manifest row. Every function returns
// offenders BY NAME so a red names a thing, not a count.
import { expect, type Page } from "@playwright/test";
import { overflowingIn } from "../helpers";
import {
  HIT_TARGET_FLOOR_PX,
  INTERACTIVE_SELECTOR,
  floorViolationLines,
  hitTargetFloorReport,
  measureHitTargets,
} from "../scorepad-a11y-kit";

export const BACKDROPS = {
  light: "linear-gradient(180deg, #e8f0e2 0%, #3d7a3a 55%, #2e6a2d 100%)",
  dark: "linear-gradient(180deg, #0a0d14 0%, #1c2230 100%)",
} as const;

/** What a check INSPECTED, returned on PASS as well as fail so the log and
 *  report.json carry the element list, not a boolean (_RULES.md
 *  §Verification: "print what you saw beside every pass/fail"). A green
 *  `no-clip` over a `controlRoot` that was not in the DOM shows
 *  `inspected: 0`, which the reader can see. */
export interface Seen {
  inspected: number;
  sample: string[];
}

/** Paint the backdrop UNDER the page. A transparent segment (the overlay)
 *  composites over it the way OBS composites over a camera; an opaque page
 *  is unaffected. `!important` so the root layout's own ground cannot win. */
export async function applyBackdrop(page: Page, backdrop: keyof typeof BACKDROPS): Promise<void> {
  await page.addStyleTag({
    content: `html { background: ${BACKDROPS[backdrop]} fixed !important; min-height: 100vh; }`,
  });
}

/** The visible interactive controls under `root`, in DOM order, named by
 *  data-testid, then aria-label, then text. Membership, ORDER and REPEATS —
 *  the thing to diff between 320 and 1280, never box size. */
export async function controlSet(page: Page, root: string): Promise<string[]> {
  return page.evaluate((rootSel) => {
    const rootEl = document.querySelector<HTMLElement>(rootSel);
    if (!rootEl) return [`<${rootSel} not in DOM>`];
    return Array.from(
      rootEl.querySelectorAll<HTMLElement>(
        'button, a[href], select, input, textarea, [role="button"], [role="tab"], [role="radio"]',
      ),
    )
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      })
      .map(
        (el) =>
          el.dataset.testid ??
          el.getAttribute("aria-label") ??
          (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
      );
  }, root);
}

/** The CSS selector every clip scan walks under its root. One constant so the
 *  two measurements below (`overflowingIn` and the bleed split) can never
 *  disagree about which boxes were in scope. */
const CLIP_CHILD_SELECTOR = "button,div,span,p,a,li,td,th,h1,h2,h3";

/** No REAL clip under `root`: content wider than a box that cannot scroll and
 *  is not truncated on purpose. Reachable rails are allowed here and held to
 *  their own invariant by `expectRailsA11y`.
 *
 *  `overflowingIn` — this suite's one authority for the three-way split — was
 *  written against the scorebug, whose root is a single card, and it calls
 *  BOTH `overflow-x: hidden|clip` and `overflow-x: visible` a clip. Over a
 *  whole PAGE root that is too blunt in one specific, designed case, measured
 *  here on 2026-09-08: the public fixture page's tab strip is a rail that
 *  BLEEDS through the page gutter on phones (`flex gap-2 overflow-x-auto
 *  max-md:-mx-4 max-md:px-4`), so at 320 it is 320 px wide inside a 288 px
 *  content box and every `visible` ANCESTOR of it reports `304px content in
 *  288px`. Those ancestors are bystanders — the content is fully reachable
 *  inside the rail, and nothing escapes the viewport (the row's
 *  `no-horizontal-scroll` check proves that separately). The culprit is the
 *  rail, and it is a feature.
 *
 *  So the `clipped` list is split once more, and each half is held to its own
 *  invariant rather than one half being waved through:
 *
 *   - a box that really clips (`overflow-x: hidden|clip`) is a DEFECT, always;
 *   - a `visible` box is a DEFECT TOO, unless it contains a rail that is both
 *     reachable (`auto|scroll`) and actually overflowing — i.e. the exemption
 *     has to be earned by a rail that exists in the DOM at measure time, and
 *     that rail is then reported BY NAME in `Seen.sample` and held to
 *     `expectRailsA11y`'s keyboard invariant on any row that lists it.
 *
 *  The split is reconciled against `overflowingIn`'s own count before either
 *  half is asserted, so if that function's classification ever moves, this
 *  reds with the disagreement instead of silently exempting more. */
export async function expectNoClip(page: Page, root: string, label: string): Promise<Seen> {
  const childSel = CLIP_CHILD_SELECTOR;
  const { clipped, scrollable, truncatedByDesign } = await overflowingIn(
    page,
    root,
    childSel,
    `${root} was not in the DOM`,
  );
  const inspected = await page.locator(`${root}, ${root} :is(${childSel})`).count();
  expect(inspected, `${label}: ${root} inspected nothing — is the root in the DOM?`).toBeGreaterThan(
    0,
  );

  const { realClips, bleeds } = await page.evaluate(
    ({ rootSel, childSel: cs }) => {
      const rootEl = document.querySelector<HTMLElement>(rootSel);
      if (!rootEl) return { realClips: [`<${rootSel} not in DOM>`], bleeds: [] as string[] };
      const reachable = (el: Element) =>
        /^(auto|scroll)$/.test(getComputedStyle(el).overflowX);
      const truncatedByDesign = (el: Element) => {
        const s = getComputedStyle(el);
        if (s.textOverflow === "ellipsis") return true;
        const clamp = s.webkitLineClamp;
        return clamp !== "" && clamp !== "none";
      };
      const describe = (el: HTMLElement) =>
        `${el.tagName.toLowerCase()}` +
        `${el.dataset.testid ? `[data-testid=${el.dataset.testid}]` : ""}` +
        `${typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 4).join(".")}` : ""}` +
        ` ${el.scrollWidth}px content in ${el.clientWidth}px (overflow-x: ${getComputedStyle(el).overflowX})`;
      const realClips: string[] = [];
      const bleeds: string[] = [];
      const suspects: HTMLElement[] = [
        rootEl,
        ...Array.from(rootEl.querySelectorAll<HTMLElement>(cs)),
      ];
      for (const el of suspects) {
        if (el.scrollWidth - el.clientWidth <= 1) continue;
        if (reachable(el) || truncatedByDesign(el)) continue; // already split out
        const rail = Array.from(el.querySelectorAll<HTMLElement>("*")).find(
          (d) => reachable(d) && d.scrollWidth - d.clientWidth > 1,
        );
        if (getComputedStyle(el).overflowX === "visible" && rail) {
          bleeds.push(`${describe(el)} ← bleed of ${describe(rail)}`);
        } else {
          realClips.push(describe(el));
        }
      }
      return { realClips, bleeds };
    },
    { rootSel: root, childSel },
  );

  expect(
    realClips.length + bleeds.length,
    `${label}: the bleed split (${realClips.length} clip + ${bleeds.length} bleed) disagrees with overflowingIn (${clipped.length} clipped) — the two measurements have drifted`,
  ).toBe(clipped.length);
  expect(realClips, `${label}: clipped content under ${root}`).toEqual([]);

  return {
    inspected,
    sample: [
      ...bleeds.slice(0, 3).map((s) => `bleed: ${s}`),
      ...scrollable.slice(0, 3).map((s) => `rail: ${s}`),
      ...truncatedByDesign.slice(0, 3).map((s) => `truncated: ${s}`),
    ],
  };
}

/** Every operable control under `root` is ≥ 44 × 44 by its real box AND is
 *  the thing a tap at its centre reaches (`elementFromPoint`, recurring
 *  class 2: boundingBox() measures paint, not hit area).
 *
 *  ONE exemption, and it is WCAG's own, not an excuse invented to pass a
 *  page: 2.5.8 Target Size (Minimum) exempts a target that "is in a sentence
 *  or its size is otherwise constrained by the line-height of non-target
 *  text". `scorepad-a11y-kit`'s `INTERACTIVE_SELECTOR` includes `a[href]` and
 *  was written for the PAD, where every control is a tile; pointed at a whole
 *  public page root it also picks up running-text links — measured here on
 *  2026-09-08, where the public fixture page's breadcrumb (`nav.text-xs`)
 *  reported `116.66x16px — height` at 320 and 768. The exemption is drawn at
 *  computed `display: inline` and nowhere else: a link Tailwind lays out as
 *  `flex`, `inline-flex`, `inline-block` or `block` is a CONTROL and stays
 *  held to the full 44 px, so the exemption cannot be widened by styling.
 *  Exempt elements are returned by name in `Seen.sample`, never dropped.
 *
 *  The kit stays the authority for WHAT was measured: its under-floor count
 *  is reconciled against this scan's before either is asserted, so if
 *  `measureHitTargets` or `hitTargetFloorReport` ever changes what it
 *  collects, this reds with the disagreement instead of quietly measuring
 *  something else. */
export async function expectHitTargetsByPoint(
  page: Page,
  root: string,
  label: string,
): Promise<Seen> {
  const scope = page.locator(root);
  const targets = await measureHitTargets(scope);
  const report = hitTargetFloorReport(targets);

  const floorScan = await page.evaluate(
    ({ rootSel, sel, floor }) => {
      const rootEl = document.querySelector<HTMLElement>(rootSel);
      if (!rootEl) return { under: [`<${rootSel} not in DOM>`], inlineExempt: [] as string[] };
      const under: string[] = [];
      const inlineExempt: string[] = [];
      for (const el of Array.from(rootEl.querySelectorAll<HTMLElement>(sel))) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if ((el as HTMLButtonElement).disabled) continue;
        if (r.width >= floor && r.height >= floor) continue;
        const name =
          el.getAttribute("aria-label") ??
          (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
        const line = `"${name}" (${el.tagName.toLowerCase()}) is ${Math.round(r.width)}x${Math.round(r.height)}px, display:${getComputedStyle(el).display}`;
        if (getComputedStyle(el).display === "inline") inlineExempt.push(line);
        else under.push(line);
      }
      return { under, inlineExempt };
    },
    { rootSel: root, sel: INTERACTIVE_SELECTOR, floor: HIT_TARGET_FLOOR_PX },
  );

  expect(
    floorScan.under.length + floorScan.inlineExempt.length,
    `${label}: the hit-target scan (${floorScan.under.length} under + ${floorScan.inlineExempt.length} inline-exempt) disagrees with the a11y kit (${report.under.length} under) — the two measurements have drifted`,
  ).toBe(report.under.length);
  expect(
    floorScan.under,
    `${label}: controls under ${HIT_TARGET_FLOOR_PX}px (kit: ${floorViolationLines(report).join("; ")})`,
  ).toEqual([]);

  // `document.elementFromPoint` is VIEWPORT-relative and answers `null` for
  // any coordinate outside it, so a control parked off-screen inside a rail
  // reports "hits nothing" — measured 2026-09-08 as
  // `mc-tab-info @ (333,509) hits nothing` at a 320 px viewport, where that
  // tab simply sits further along the match-centre tab strip. The hit test
  // cannot answer for those, so they are split off rather than counted as a
  // miss: a control whose centre is off-viewport is fine IF an ancestor is a
  // reachable rail (the reader swipes to it) and a DEFECT otherwise — parked
  // somewhere with no way to bring it into view. Both halves are named.
  const { missed, offscreen } = await page.evaluate((rootSel) => {
    const rootEl = document.querySelector<HTMLElement>(rootSel);
    if (!rootEl) return { missed: [`<${rootSel} not in DOM>`], offscreen: [] as string[] };
    const missed: string[] = [];
    const offscreen: string[] = [];
    const name = (el: HTMLElement) =>
      el.dataset.testid ?? el.getAttribute("aria-label") ?? el.tagName.toLowerCase();
    const inReachableRail = (el: HTMLElement) => {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (/^(auto|scroll)$/.test(cs.overflowX) && a.scrollWidth - a.clientWidth > 1) return true;
      }
      return false;
    };
    for (const el of Array.from(
      rootEl.querySelectorAll<HTMLElement>('button, a[href], select, [role="button"], [role="tab"]'),
    )) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const at = `${name(el)} @ (${Math.round(x)},${Math.round(y)})`;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        if (inReachableRail(el)) offscreen.push(`${at} is off-viewport inside a reachable rail`);
        else missed.push(`${at} is off-viewport and is NOT inside a scrollable rail`);
        continue;
      }
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(el === hit || el.contains(hit))) {
        missed.push(`${at} hits ${hit ? hit.tagName.toLowerCase() : "nothing"}`);
      }
    }
    return { missed, offscreen };
  }, root);
  expect(missed, `${label}: a tap at the centre reaches something else`).toEqual([]);
  return {
    inspected: report.operable.length,
    sample: [
      ...floorScan.inlineExempt.slice(0, 3).map((s) => `inline (WCAG 2.5.8 exception): ${s}`),
      ...offscreen.slice(0, 3).map((s) => `off-viewport in rail: ${s}`),
      ...report.operable.slice(0, 5).map((t) => `${t.name} ${t.width}x${t.height}`),
    ],
  };
}

/** Every `truncate` (ellipsis + nowrap + hidden) can actually ENGAGE: no
 *  ancestor between it and the first thing that bounds its width is a
 *  non-shrinkable flex/grid item. The missing `min-width: 0` is what put
 *  106px of overflow on the console at 320 with a 43-character name.
 *
 *  Two qualifications, both from the CSS spec rather than from a page that
 *  wanted to pass, and both measured on the public fixture page 2026-09-08
 *  where a naive "every flex ancestor needs min-width:0" walk raised five
 *  offenders and all but one were noise:
 *
 *  1. **Only a ROW flex parent bites.** `min-width: auto` resolves to the
 *     automatic minimum size on the MAIN axis only (css-flexbox-1 §4.5), so
 *     in a `flex-col` container — which is what the root layout wraps
 *     `<header>` and `<main>` in — a child's `min-width` is already 0 for
 *     layout purposes and demanding `min-w-0` on it is demanding a no-op.
 *     Grid items are still checked: there the automatic minimum applies in
 *     the inline axis regardless of flow.
 *  2. **The walk stops at the first ancestor that BOUNDS the width** — one
 *     that scrolls or clips horizontally, or that carries an explicit
 *     `max-width`. Above such a box nothing can widen the truncate's line,
 *     so a missing `min-w-0` up there cannot break it: the standings `th`
 *     (`max-w-40`, inside `overflow-x-auto`) reported `main` as its offender
 *     purely by climbing past both. */
export async function expectTruncateChain(page: Page, label: string): Promise<Seen> {
  const { offenders, truncates } = await page.evaluate(() => {
    const out: string[] = [];
    const truncates: string[] = [];
    const isTruncate = (cs: CSSStyleDeclaration) =>
      cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap" && /hidden|clip/.test(cs.overflowX);
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${(el as HTMLElement).dataset?.testid ? `[data-testid=${(el as HTMLElement).dataset.testid}]` : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : ""}`;
    /** The automatic minimum size only bites along the container's MAIN axis
     *  for flex; for grid it bites in the inline axis whatever the flow. */
    const shrinkBlocking = (parent: HTMLElement) => {
      const ps = getComputedStyle(parent);
      if (/grid/.test(ps.display)) return true;
      return /flex/.test(ps.display) && /^row/.test(ps.flexDirection);
    };
    /** Nothing above a box that scrolls, clips or caps its width can widen
     *  the truncate's containing block. */
    const boundsWidth = (parent: HTMLElement) => {
      const ps = getComputedStyle(parent);
      return /^(auto|scroll|hidden|clip)$/.test(ps.overflowX) || ps.maxWidth !== "none";
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (!isTruncate(cs)) continue;
      truncates.push(describe(el));
      if (cs.maxWidth !== "none") continue; // capped on itself — always engages
      let node: HTMLElement = el;
      while (node !== document.body) {
        const parent: HTMLElement | null = node.parentElement;
        if (!parent) break;
        if (shrinkBlocking(parent) && getComputedStyle(node).minWidth !== "0px") {
          const where = node === el ? "itself" : `ancestor ${describe(node)}`;
          out.push(
            `${describe(el)} → ${where} is a ${getComputedStyle(parent).display} item without min-width:0`,
          );
          break;
        }
        if (boundsWidth(parent)) break;
        node = parent;
      }
    }
    return { offenders: out, truncates };
  });
  expect(offenders, `${label}: truncate without min-w-0 on the whole chain`).toEqual([]);
  return { inspected: truncates.length, sample: truncates.slice(0, 5) };
}

/** Every scrolling rail (overflow-x auto|scroll AND actually overflowing) is
 *  keyboard-reachable — `tabindex="0"` on the rail, or a focusable child
 *  inside it (axe accepts either) — and a rail that carries tabindex="0"
 *  also carries a role and an accessible name. The exemption list is
 *  asserted, not assumed: every reachable rail is returned by name. */
export async function expectRailsA11y(
  page: Page,
  label: string,
  opts: { assert: boolean } = { assert: true },
): Promise<{ rails: string[]; offenders: string[] }> {
  const { offenders, rails } = await page.evaluate(() => {
    const offenders: string[] = [];
    const rails: string[] = [];
    const focusable =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (!/^(auto|scroll)$/.test(cs.overflowX) || el.scrollWidth - el.clientWidth <= 1) continue;
      const name = `${el.tagName.toLowerCase()}${el.dataset.testid ? `[data-testid=${el.dataset.testid}]` : ""} ${el.scrollWidth}px in ${el.clientWidth}px`;
      rails.push(name);
      const ownTab = el.getAttribute("tabindex") === "0";
      const childFocusable = el.querySelector(focusable) !== null;
      if (!ownTab && !childFocusable)
        offenders.push(`${name}: not keyboard-reachable (no tabindex=0, no focusable child)`);
      if (ownTab) {
        if (!el.getAttribute("role")) offenders.push(`${name}: tabindex=0 without a role`);
        if (!el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")) {
          offenders.push(`${name}: tabindex=0 without an accessible name`);
        }
      }
    }
    return { offenders, rails };
  });
  // Inspected on every row for the report; ASSERTED only when the row lists
  // the check (review finding 20) — so `rails: []` in report.json means "no
  // overflowing rail", never "the check was not run".
  if (opts.assert) expect(offenders, `${label}: scrolling rails`).toEqual([]);
  return { rails, offenders };
}
