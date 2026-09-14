// The owner checklist's VERIFY-AS-CUSTOMER rows, each as one reusable
// assertion the capture spec runs per manifest row. Every function returns
// offenders BY NAME so a red names a thing, not a count — and every box a
// check EXCUSES is returned too, in FULL, so `capture.spec.ts` can hold the
// exemption list to the one the manifest row declares (AGENTS.md class 23:
// "assert that every box you excused is the reachable kind, or the next
// overflow hides behind it").
import { expect, type Page } from "@playwright/test";
import { overflowingIn } from "../helpers";
import {
  HIT_TARGET_FLOOR_PX,
  INTERACTIVE_SELECTOR,
  floorViolationLines,
  hitTargetFloorReport,
  measureHitTargets,
} from "../scorepad-a11y-kit";
import { notInDomSentinel } from "./manifest";

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
  /** Every box this check EXCUSED, by STABLE identity (tag + data-testid),
   *  complete and never sliced — `capture.spec.ts` asserts this against the
   *  row's declared `exempt` list. Sizes deliberately excluded so the declared
   *  list does not churn when content changes width. */
  exempt?: Record<string, string[]>;
}

// A box's STABLE identity — `main`, `div[data-testid=mc-root]`, `a` — is tag
// plus `data-testid` and nothing else: no pixel sizes, so a declared list in
// `manifest.json` does not churn when content changes width. Defined inline in
// each page.evaluate below rather than passed as source: this app serves a
// strict CSP and `eval` inside an evaluated function would be refused by it.

/** Paint the backdrop UNDER the page. A transparent segment (the overlay)
 *  composites over it the way OBS composites over a camera; an opaque page
 *  is unaffected. `!important` so the root layout's own ground cannot win.
 *
 *  The computed result is ASSERTED rather than assumed: `addStyleTag` can be
 *  refused by CSP, and a backdrop that silently failed to paint would make
 *  every future overlay row photograph the wrong thing while still passing
 *  (fix round 1, Important 6 — this whole path was inert). */
export async function applyBackdrop(page: Page, backdrop: keyof typeof BACKDROPS): Promise<void> {
  await page.addStyleTag({
    content: `html { background: ${BACKDROPS[backdrop]} fixed !important; min-height: 100vh; }`,
  });
  const painted = await page.evaluate(
    () => getComputedStyle(document.documentElement).backgroundImage,
  );
  expect(
    painted,
    `backdrop "${backdrop}" did not reach the computed style of <html> (got ${painted}) — addStyleTag was dropped, or the page's own ground won`,
  ).toContain("gradient");
}

/** The visible interactive controls under `root`, in DOM order, named by
 *  data-testid, then aria-label, then text. Membership, ORDER and REPEATS —
 *  the thing to diff between 320 and 1280, never box size. */
export async function controlSet(page: Page, root: string): Promise<string[]> {
  return page.evaluate(
    ({ rootSel, sentinel }) => {
      const rootEl = document.querySelector<HTMLElement>(rootSel);
      if (!rootEl) return [sentinel];
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
    },
    { rootSel: root, sentinel: notInDomSentinel(root) },
  );
}

/** Every element under the clip root, not just the scorebug's card tags. This
 *  used to be a hand-listed set carried over from `mobile.spec.ts`, which
 *  omitted `table`, `section`, `nav`, `ul`, `header`, `img` and `svg` — so
 *  `standings-768` ran `no-clip` over a page whose entire subject is a
 *  `<table>` the scan could not see (fix round 1, Important 9). */
const CLIP_CHILD_SELECTOR = "*";

/** No REAL clip under `root`: content wider than a box that cannot scroll and
 *  is not truncated on purpose. Reachable rails are allowed here and held to
 *  their own invariant by `expectRailsA11y`.
 *
 *  `overflowingIn` — this suite's one authority for the three-way split — was
 *  written against the scorebug, whose root is a single card, and it calls
 *  BOTH `overflow-x: hidden|clip` and `overflow-x: visible` a clip. Over a
 *  whole PAGE root that is too blunt in one specific, designed case: the
 *  public fixture page's tab strip is a rail that BLEEDS through the page
 *  gutter on phones (`flex gap-2 overflow-x-auto max-md:-mx-4 max-md:px-4`,
 *  `match-centre/tab-rail.tsx`), so at 320 it is 320 px wide inside a 288 px
 *  content box and every `visible` ANCESTOR of it reports `304px content in
 *  288px`. Those ancestors are bystanders; the culprit is the rail, and it is
 *  a feature.
 *
 *  The exemption is ACCOUNTED FOR, not merely explained. A first pass said
 *  "this box contains some overflowing rail" — which `main` satisfies on every
 *  fixture row forever, because the tab rail is always a descendant of it, so
 *  a genuinely too-wide fixed child would have been waved through on the one
 *  box that could have reported it (fix round 1, Important 2; a too-wide fixed
 *  child never enters `suspects` itself, since its own `scrollWidth` equals
 *  its `clientWidth`). Now the rail's box must reach far enough past the
 *  parent's content edge to ACCOUNT for the parent's whole overhang; anything
 *  the rails cannot explain is a clip. On top of that, `capture.spec.ts`
 *  asserts the resulting bleed list against the row's declared `exempt.bleeds`,
 *  so a NEW bleed ancestor fails until someone writes it down.
 *
 *  The split is reconciled against `overflowingIn`'s own count before either
 *  half is asserted, so if that function's classification ever moves, this reds
 *  with the disagreement instead of silently exempting more. */
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

  const { realClips, bleeds, bleedIds } = await page.evaluate(
    ({ rootSel, childSel: cs }) => {
      const rootEl = document.querySelector<HTMLElement>(rootSel);
      if (!rootEl) {
        return { realClips: [`<${rootSel} not in DOM>`], bleeds: [] as string[], bleedIds: [] as string[] };
      }
      const identity = (el: HTMLElement) =>
        el.tagName.toLowerCase() + (el.dataset.testid ? `[data-testid=${el.dataset.testid}]` : "");
      const reachable = (el: Element) => /^(auto|scroll)$/.test(getComputedStyle(el).overflowX);
      const truncatedByDesign = (el: Element) => {
        const s = getComputedStyle(el);
        if (s.textOverflow === "ellipsis") return true;
        const clamp = s.webkitLineClamp;
        return clamp !== "" && clamp !== "none";
      };
      const describe = (el: HTMLElement) =>
        `${identity(el)}` +
        `${typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 4).join(".")}` : ""}` +
        ` ${el.scrollWidth}px content in ${el.clientWidth}px (overflow-x: ${getComputedStyle(el).overflowX})`;
      const realClips: string[] = [];
      const bleeds: string[] = [];
      const bleedIds: string[] = [];
      const suspects: HTMLElement[] = [
        rootEl,
        ...Array.from(rootEl.querySelectorAll<HTMLElement>(cs)),
      ];
      const visibleOverhang = (el: HTMLElement) => {
        const hidden = Array.from(el.querySelectorAll<HTMLElement>("*")).filter(
          (c) => getComputedStyle(c).visibility === "hidden",
        );
        const prev = hidden.map((c) => c.style.display);
        for (const c of hidden) c.style.display = "none";
        const overhang = el.scrollWidth - el.clientWidth;
        hidden.forEach((c, i) => {
          c.style.display = prev[i]!;
        });
        return overhang;
      };
      for (const el of suspects) {
        const overhang = visibleOverhang(el);
        if (overhang <= 1) continue;
        if (reachable(el) || truncatedByDesign(el)) continue; // already split out
        // How far past this box's own content edge do the reachable rails
        // inside it actually reach? That is the ONLY overhang a bleed can
        // account for; anything beyond it is something else overflowing.
        const box = el.getBoundingClientRect();
        const contentRight = box.left + el.clientLeft + el.clientWidth;
        let attributable = 0;
        let culprit = "";
        for (const d of Array.from(el.querySelectorAll<HTMLElement>("*"))) {
          if (!reachable(d) || d.scrollWidth - d.clientWidth <= 1) continue;
          const reach = d.getBoundingClientRect().right - contentRight;
          if (reach > attributable) {
            attributable = reach;
            culprit = describe(d);
          }
        }
        if (getComputedStyle(el).overflowX === "visible" && overhang <= attributable + 1) {
          bleeds.push(`${describe(el)} ← bleed of ${culprit}`);
          bleedIds.push(identity(el));
        } else {
          realClips.push(
            `${describe(el)}${attributable > 0 ? ` (rails inside reach only ${Math.round(attributable)}px of the ${overhang}px overhang)` : ""}`,
          );
        }
      }
      return { realClips, bleeds, bleedIds };
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
      ...bleeds.map((s) => `bleed: ${s}`),
      ...scrollable.slice(0, 3).map((s) => `rail: ${s}`),
      ...truncatedByDesign.slice(0, 3).map((s) => `truncated: ${s}`),
    ],
    exempt: { bleeds: bleedIds },
  };
}

/** Every operable control under `root` is ≥ 44 × 44 by its real box AND is
 *  the thing a tap at its centre reaches (`elementFromPoint`, recurring
 *  class 2: boundingBox() measures paint, not hit area).
 *
 *  TWO exemptions, both returned in full for the row to declare:
 *
 *  1. WCAG 2.5.8 Target Size (Minimum) exempts a target that "is in a sentence
 *     or its size is otherwise constrained by the line-height of non-target
 *     text". `scorepad-a11y-kit`'s `INTERACTIVE_SELECTOR` includes `a[href]`
 *     and was written for the PAD, where every control is a tile; pointed at a
 *     whole public page root it also picks up running-text links — the fixture
 *     page's breadcrumb reported `116.66x16px` at 320 and 768. Drawn at
 *     computed `display: inline` and nowhere else, so a link Tailwind lays out
 *     as `flex`, `inline-flex`, `inline-block` or `block` is a CONTROL and
 *     stays held to the full 44 px.
 *  2. `document.elementFromPoint` is VIEWPORT-relative and answers `null` for
 *     any coordinate outside it, so a control parked off-screen reports "hits
 *     nothing" — measured as `mc-tab-info @ (333,509)` at a 320 px viewport,
 *     where that tab simply sits further along the tab strip. The hit test
 *     cannot answer for those, so they are split off rather than counted as a
 *     miss — but PER AXIS, and each axis needs its own reachability. A control
 *     off to the RIGHT needs a horizontally scrollable ancestor; one BELOW the
 *     fold needs a vertically scrollable ancestor or a scrollable document.
 *     The first version tested only `overflow-x`, so the first below-the-fold
 *     button any wave added would have reddened as "hits nothing" — a false
 *     red whose obvious repair is to loosen the check, which is how a gate
 *     dies (fix round 1, Important 5). A control off-viewport with no way to
 *     bring it into view on that axis is still a defect.
 *
 *  The kit stays the authority for WHAT was measured: its under-floor count is
 *  reconciled against this scan's before either is asserted. */
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
      if (!rootEl) return { under: [`<${rootSel} not in DOM>`], inlineExempt: [] as string[], inlineIds: [] as string[] };
      const identity = (el: HTMLElement) =>
        el.tagName.toLowerCase() + (el.dataset.testid ? `[data-testid=${el.dataset.testid}]` : "");
      const under: string[] = [];
      const inlineExempt: string[] = [];
      const inlineIds: string[] = [];
      for (const el of Array.from(rootEl.querySelectorAll<HTMLElement>(sel))) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if ((el as HTMLButtonElement).disabled) continue;
        if (r.width >= floor && r.height >= floor) continue;
        const name =
          el.getAttribute("aria-label") ??
          (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
        const line = `"${name}" (${el.tagName.toLowerCase()}) is ${Math.round(r.width)}x${Math.round(r.height)}px, display:${getComputedStyle(el).display}`;
        if (getComputedStyle(el).display === "inline") {
          inlineExempt.push(line);
          inlineIds.push(identity(el));
        } else under.push(line);
      }
      return { under, inlineExempt, inlineIds };
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

  const { missed, offscreen, offscreenIds } = await page.evaluate(
    ({ rootSel }) => {
      const rootEl = document.querySelector<HTMLElement>(rootSel);
      if (!rootEl) {
        return { missed: [`<${rootSel} not in DOM>`], offscreen: [] as string[], offscreenIds: [] as string[] };
      }
      const identity = (el: HTMLElement) =>
        el.tagName.toLowerCase() + (el.dataset.testid ? `[data-testid=${el.dataset.testid}]` : "");
      const missed: string[] = [];
      const offscreen: string[] = [];
      const offscreenIds: string[] = [];
      const name = (el: HTMLElement) =>
        el.dataset.testid ?? el.getAttribute("aria-label") ?? el.tagName.toLowerCase();
      /** An ancestor that scrolls on `axis` and actually overflows on it. */
      const inReachableRail = (el: HTMLElement, axis: "x" | "y") => {
        for (let a: HTMLElement | null = el.parentElement; a; a = a.parentElement) {
          const cs = getComputedStyle(a);
          const scrolls = /^(auto|scroll)$/.test(axis === "x" ? cs.overflowX : cs.overflowY);
          const over = axis === "x" ? a.scrollWidth - a.clientWidth : a.scrollHeight - a.clientHeight;
          if (scrolls && over > 1) return true;
        }
        return false;
      };
      const doc = document.documentElement;
      const docScrollsY = doc.scrollHeight - doc.clientHeight > 1;
      const docScrollsX = doc.scrollWidth - doc.clientWidth > 1;
      for (const el of Array.from(
        rootEl.querySelectorAll<HTMLElement>('button, a[href], select, [role="button"], [role="tab"]'),
      )) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if ((el as HTMLButtonElement).disabled) continue;
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const at = `${name(el)} @ (${Math.round(x)},${Math.round(y)})`;
        const offX = x < 0 || x > window.innerWidth;
        const offY = y < 0 || y > window.innerHeight;
        if (offX || offY) {
          const xOk = !offX || inReachableRail(el, "x") || docScrollsX;
          const yOk = !offY || inReachableRail(el, "y") || docScrollsY;
          if (xOk && yOk) {
            offscreen.push(
              `${at} is off-viewport but reachable (${[offX ? "x" : "", offY ? "y" : ""].filter(Boolean).join("+")})`,
            );
            offscreenIds.push(identity(el));
          } else {
            missed.push(
              `${at} is off-viewport with nothing to scroll on ${!xOk ? "x" : "y"} — it cannot be brought into view`,
            );
          }
          continue;
        }
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(el === hit || el.contains(hit))) {
          missed.push(`${at} hits ${hit ? hit.tagName.toLowerCase() : "nothing"}`);
        }
      }
      return { missed, offscreen, offscreenIds };
    },
    { rootSel: root },
  );
  expect(missed, `${label}: a tap at the centre reaches something else`).toEqual([]);
  return {
    inspected: report.operable.length,
    sample: [
      ...floorScan.inlineExempt.map((s) => `inline (WCAG 2.5.8 exception): ${s}`),
      ...offscreen.map((s) => `off-viewport: ${s}`),
      ...report.operable.slice(0, 5).map((t) => `${t.name} ${t.width}x${t.height}`),
    ],
    exempt: { inline: floorScan.inlineIds, offscreen: offscreenIds },
  };
}

/** Every `truncate` (ellipsis + nowrap + hidden) can actually ENGAGE: no
 *  ancestor between it and the first thing that bounds its width is a
 *  non-shrinkable flex/grid item. The missing `min-width: 0` is what put
 *  106px of overflow on the console at 320 with a 43-character name.
 *
 *  Scans the WHOLE document, not `controlRoot` — deliberately wider than the
 *  row's other checks, since a broken chain outside `main` breaks the page
 *  just as thoroughly.
 *
 *  Two qualifications, both from the CSS spec rather than from a page that
 *  wanted to pass, and both measured on the public fixture page 2026-09-08
 *  where a naive "every flex ancestor needs min-width:0" walk raised five
 *  offenders and four were noise:
 *
 *  1. **Only a ROW flex parent bites.** `min-width: auto` resolves to the
 *     automatic minimum size on the MAIN axis only (css-flexbox-1 §4.5), so
 *     in a `flex-col` container — which is what the root layout wraps
 *     `<header>` and `<main>` in — a child's `min-width` is already 0 for
 *     layout purposes and demanding `min-w-0` on it is demanding a no-op.
 *     Grid items are still checked: there the automatic minimum applies in
 *     the inline axis regardless of flow.
 *  2. **The walk stops at the first ancestor that BOUNDS the width** — one
 *     that scrolls or clips horizontally, or that carries a max-width in
 *     LENGTH units. Above such a box nothing can widen the truncate's line,
 *     so a missing `min-w-0` up there cannot break it: the standings `th`
 *     (`max-w-40` → a computed `160px`, inside `overflow-x-auto`) reported
 *     `main` as its offender purely by climbing past both.
 *
 *     A PERCENTAGE max-width is not such a bound and must not stop the walk.
 *     `max-w-full` resolves against the containing block, so an ancestor that
 *     fails to shrink widens it too; and `min-width` overrides `max-width`
 *     (CSS 2.1 §10.4), so a `max-w-full truncate` span in a row flex with no
 *     `min-w-0` does NOT engage — which is the exact defect fixed in
 *     `court-card.tsx`, and the first version of this walk skipped it before
 *     the walk even started. `max-w-full` is live in this repo
 *     (`components/public-site/tabs.tsx`) and is a repair people reach for
 *     (fix round 1, Important 4). */
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
    /** A LENGTH max-width caps the box whatever its ancestors do. A percentage
     *  one does not — it resolves against a containing block an unshrinkable
     *  ancestor can widen — so it must not stop the walk. `getComputedStyle`
     *  leaves a percentage max-width as "100%" and resolves a rem/px one to
     *  "…px", which is exactly the distinction needed. */
    const isLengthCap = (v: string) => v !== "none" && v.endsWith("px");
    const boundsWidth = (parent: HTMLElement) => {
      const ps = getComputedStyle(parent);
      return /^(auto|scroll|hidden|clip)$/.test(ps.overflowX) || isLengthCap(ps.maxWidth);
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (!isTruncate(cs)) continue;
      truncates.push(describe(el));
      if (isLengthCap(cs.maxWidth)) continue; // capped on itself — always engages
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
 *  also carries a role and an accessible name.
 *
 *  Scans the WHOLE document rather than `controlRoot`, deliberately: an
 *  unreachable rail in the header is as unreachable as one in `main`.
 *
 *  Returns `rails` in full so `capture.spec.ts` can record every reachable
 *  rail by name in `report.json` — the exemption list is data a reviewer can
 *  read, not a count. The `tabindex="0"` branch has no natural killer on the
 *  routes photographed today (nothing on the seeded football fixture carries
 *  one — `tab-rail.tsx` deliberately does not, per its roving-tabindex note),
 *  so `capture.spec.ts` drives it against a synthetic rail instead.
 *
 *  `offenderIds` is the DISTINCT set of offending element identities (tag +
 *  `data-testid`), one entry per element however many rules it broke. It is
 *  what a row's `knownDefects` declares, so a recorded defect is compared as a
 *  SET rather than merely "non-empty" — otherwise a SECOND unreachable rail on
 *  the same page hides behind the recorded one (fix round 2). */
export async function expectRailsA11y(
  page: Page,
  label: string,
  opts: { assert: boolean } = { assert: true },
): Promise<{ rails: string[]; offenders: string[]; offenderIds: string[] }> {
  const { offenders, rails, offenderIds } = await page.evaluate(() => {
    const offenders: string[] = [];
    const rails: string[] = [];
    const offenderIds: string[] = [];
    const focusable =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (!/^(auto|scroll)$/.test(cs.overflowX) || el.scrollWidth - el.clientWidth <= 1) continue;
      const identity =
        el.tagName.toLowerCase() + (el.dataset.testid ? `[data-testid=${el.dataset.testid}]` : "");
      const name = `${identity} ${el.scrollWidth}px in ${el.clientWidth}px`;
      rails.push(name);
      const own: string[] = [];
      const ownTab = el.getAttribute("tabindex") === "0";
      const childFocusable = el.querySelector(focusable) !== null;
      if (!ownTab && !childFocusable)
        own.push(`${name}: not keyboard-reachable (no tabindex=0, no focusable child)`);
      if (ownTab) {
        if (!el.getAttribute("role")) own.push(`${name}: tabindex=0 without a role`);
        if (!el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")) {
          own.push(`${name}: tabindex=0 without an accessible name`);
        }
      }
      // One id per offending ELEMENT, not per rule it broke: the declared
      // `knownDefects.offenders` names elements, and a rail missing both a
      // role and a name is still one rail.
      if (own.length > 0) offenderIds.push(identity);
      offenders.push(...own);
    }
    return { offenders, rails, offenderIds };
  });
  // Inspected on every row for the report; ASSERTED only when the row lists
  // the check (review finding 20) — so `rails: []` in report.json means "no
  // overflowing rail", never "the check was not run".
  if (opts.assert) expect(offenders, `${label}: scrolling rails`).toEqual([]);
  return { rails, offenders, offenderIds };
}
