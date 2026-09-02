import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

/** Derived from the installed builder rather than imported from `axe-core`:
 *  pnpm's strict layout gives `apps/web` no direct dependency on `axe-core`
 *  (only `@axe-core/playwright`), so a bare `import type … from "axe-core"`
 *  resolves in the editor and fails `tsc --noEmit`. */
type AxeViolation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

/*
 * R8/WS-H — the ONE implementation of the two accessibility measurements the
 * v3 scoring pad is gated on: the 44px hit-target floor and the WCAG AA
 * colour-contrast scan.
 *
 * WHY A KIT AND NOT A COPY. Both measurements already existed, in exactly one
 * place each and for exactly one sport: `measureHitTargets` lived inside
 * `scorepad-a11y-evidence.spec.ts` (generic only) and the axe invocation was
 * repeated inline in `scorepad-skins.spec.ts` (five sports, contrast only).
 * R8 extends both to all eleven v3 skins, and a second hand-written copy of a
 * measurement is how two gates drift into disagreeing about the same pixel.
 * Playwright refuses to let one spec import another ("test file X should not
 * import test file Y"), so the shared code has to live in a non-spec module —
 * the same `*-kit.ts` shape `rs007-money-kit.ts` and `stripe-checkout-kit.ts`
 * already use, and which no project's `testMatch` selects.
 *
 * TWO TRAPS THIS FILE EXISTS TO CLOSE, both of which have produced a FALSE
 * CLEAN in this repo before:
 *
 *  1. `boundingBox()` MEASURES PAINT, NOT HIT AREA. It is still the right
 *     primitive for the 44px floor (the floor is about the rendered target a
 *     thumb aims at), but a bespoke re-derivation of it — "the button has
 *     min-h-11, therefore 44" — reads a class, not a rectangle, and cannot see
 *     a parent that clips it. `measureHitTargets` below is the trusted
 *     implementation, moved here byte-for-byte from the evidence spec rather
 *     than rewritten, and both callers now share it.
 *
 *  2. A MIS-SCOPED axe `.include()` REPORTS CLEAN BECAUSE IT SCANNED NOTHING
 *     THAT MATTERS. The device-pad scan in `scorepad-a11y-evidence.spec.ts`
 *     spent a whole session reporting zero violations while scoped to `main`,
 *     with four real slate-500/600-on-slate-900 failures sitting in a
 *     `<header>` outside it; a sibling scan elsewhere in this suite once
 *     measured the cookie-consent banner. `scanPadContrast` therefore refuses
 *     to return a verdict until it has proved three things about the scan it
 *     just ran: the scope resolved to a VISIBLE element, that element really
 *     is the v3 pad (it contains the chassis's own scorebug), and axe's
 *     `color-contrast` rule actually evaluated at least one node inside it.
 *     A scan that evaluated nothing is a FAILURE here, never a pass.
 */

/** Every element the reports treat as an "interactive element inside the pad"
 *  — native form controls plus the ARIA roles/tabindex a hand-rolled control
 *  would use if the pad ever draws one that is not a native tag. */
export const INTERACTIVE_SELECTOR =
  'button, select, input, textarea, a[href], [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], [tabindex]:not([tabindex="-1"])';

/** The repo-wide touch-target floor (AGENTS.md, "Standing project rules"). */
export const HIT_TARGET_FLOOR_PX = 44;

export interface HitTarget {
  name: string;
  role: string;
  disabled: boolean;
  width: number;
  height: number;
}

/** Real getBoundingClientRect() geometry (Playwright's own boundingBox() is
 *  exactly that) for every interactive element currently rendered inside
 *  `scope`, paired with a best-effort accessible name. Elements with a
 *  zero-size box (display:none, not currently mounted) are skipped — they
 *  are not a tappable target in this state, not a false pass.
 *
 *  Accessible names are computed with a hand-rolled aria-label /
 *  aria-labelledby / associated-<label> / title / text-content heuristic, not
 *  a formal accessible-name-and-description computation: this Playwright
 *  version (1.61) has no `page.accessibility.snapshot()` (no CDP AX-tree
 *  bridge left), and `locator.ariaSnapshot()`'s YAML is meant for human/AI
 *  reading, not stable per-element parsing. The heuristic covers every control
 *  this pad actually renders (native button/select/input, all labelled one of
 *  those ways) and is adequate for naming a failing target in an assertion
 *  message — it is not a substitute for a real automated accessible-name
 *  audit. */
export async function measureHitTargets(scope: Locator): Promise<HitTarget[]> {
  const els = scope.locator(INTERACTIVE_SELECTOR);
  const count = await els.count();
  const out: HitTarget[] = [];
  for (let i = 0; i < count; i++) {
    const el = els.nth(i);
    const box = await el.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) continue;
    const meta = await el.evaluate((node) => {
      const e = node as HTMLElement & {
        labels?: NodeListOf<HTMLLabelElement>;
        placeholder?: string;
        value?: string;
        disabled?: boolean;
      };
      let name = "";
      const aria = e.getAttribute("aria-label");
      if (aria && aria.trim()) name = aria.trim();
      if (!name) {
        const labelledby = e.getAttribute("aria-labelledby");
        if (labelledby) {
          name = labelledby
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
            .filter(Boolean)
            .join(" ");
        }
      }
      if (!name && e.labels && e.labels.length) {
        name = Array.from(e.labels)
          .map((l) => l.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
      }
      if (!name) {
        const title = e.getAttribute("title");
        if (title && title.trim()) name = title.trim();
      }
      if (!name) {
        const text = (e.innerText ?? e.textContent ?? "").trim();
        if (text) name = text.replace(/\s+/g, " ").slice(0, 60);
      }
      if (!name && e.placeholder) name = `[placeholder] ${e.placeholder}`;
      if (!name && e.value) name = `[value] ${e.value}`;
      if (!name) name = `<${e.tagName.toLowerCase()}>`;
      return {
        name,
        role: e.getAttribute("role") ?? e.tagName.toLowerCase(),
        disabled: e.disabled === true || e.getAttribute("aria-disabled") === "true",
      };
    });
    out.push({
      name: meta.name,
      role: meta.role,
      disabled: meta.disabled,
      width: Math.round(box.width * 100) / 100,
      height: Math.round(box.height * 100) / 100,
    });
  }
  return out;
}

/** The smallest OPERABLE target by area, or null when nothing operable is
 *  rendered. Disabled controls are excluded deliberately: a disabled button is
 *  not a tap a scorer can miss. */
export function smallestOperable(targets: readonly HitTarget[]): HitTarget | null {
  return targets
    .filter((t) => !t.disabled)
    .reduce<HitTarget | null>((min, t) => (!min || t.width * t.height < min.width * min.height ? t : min), null);
}

export interface ContrastScan {
  /** Every `wcag2a`/`wcag2aa` violation, flattened for the JSON record. */
  violations: { id: string; impact: string | null; nodes: number }[];
  /** The subset that actually gates: serious + critical. */
  serious: AxeViolation[];
  /** How many nodes axe's `color-contrast` rule evaluated — across passes,
   *  violations AND incomplete. Zero means the scan proved nothing. */
  contrastNodes: number;
}

/**
 * Run axe over `scopeSelector`, after PROVING the scope is the pad.
 *
 * The three preconditions are asserted, not assumed, and each one has a real
 * false clean behind it (see this file's header). They are hard `expect`s
 * rather than soft ones on purpose: a caller that records evidence softly
 * still must not be allowed to write "0 violations" for a scan that never
 * looked at the pad.
 *
 * `padMarker` is what makes the scope self-identifying. It defaults to the v3
 * chassis's own scorebug, which every one of the eleven skins renders
 * (`pad-host.tsx`'s `<div data-role="v3-scorebug">`) — point the scope at the
 * cookie banner, the page header or an empty div and this throws instead of
 * reporting clean. Pass `null` only for a scope that genuinely is not a pad.
 */
export async function scanPadContrast(
  page: Page,
  scopeSelector: string,
  opts: { padMarker?: string | null } = {},
): Promise<ContrastScan> {
  const marker = opts.padMarker === undefined ? '[data-role="v3-scorebug"]' : opts.padMarker;
  const scope = page.locator(scopeSelector);
  await expect(scope, `axe scope "${scopeSelector}" must resolve to exactly one element`).toHaveCount(1);
  await expect(scope, `axe scope "${scopeSelector}" must be visible before it is scanned`).toBeVisible();
  if (marker) {
    await expect(
      scope.locator(marker),
      `axe scope "${scopeSelector}" must actually contain the v3 pad ("${marker}") — a scope that resolves to the page chrome or the cookie banner reports a clean it did not earn`,
    ).toHaveCount(1);
  }

  const axe = await new AxeBuilder({ page }).include(scopeSelector).withTags(["wcag2a", "wcag2aa"]).analyze();
  const contrastNodes = [...axe.passes, ...axe.violations, ...axe.incomplete]
    .filter((r) => r.id === "color-contrast")
    .reduce((n, r) => n + r.nodes.length, 0);
  expect(
    contrastNodes,
    `axe evaluated ZERO color-contrast nodes inside "${scopeSelector}" — the scan is vacuous, not clean`,
  ).toBeGreaterThan(0);

  return {
    violations: axe.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length })),
    serious: axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
    contrastNodes,
  };
}

/** The cookie-consent banner renders app-wide from the root layout and its
 *  fixed overlay intercepts pointer events. `auth.setup.ts` pre-dismisses it
 *  into the shared storageState, so an authed spec never sees one — but an
 *  anonymous context (the device-link pad) does, and a banner sitting over the
 *  pad both blocks taps and distorts every geometry measurement below it.
 *  Idempotent: a no-op when no banner is on screen. */
export async function dismissCookieBanner(page: Page): Promise<void> {
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  if ((await accept.count()) > 0) {
    await accept.first().click();
    await expect(accept).toHaveCount(0, { timeout: 10_000 });
  }
}
