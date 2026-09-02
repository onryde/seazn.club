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

/** The smallest OPERABLE target by AREA, or null when nothing operable is
 *  rendered. Disabled controls are excluded deliberately: a disabled button is
 *  not a tap a scorer can miss.
 *
 *  THIS IS A HEADLINE, NOT A GATE — see `hitTargetFloorReport` below for why
 *  the floor must never be asserted against this value alone. */
export function smallestOperable(targets: readonly HitTarget[]): HitTarget | null {
  return targets
    .filter((t) => !t.disabled)
    .reduce<HitTarget | null>((min, t) => (!min || t.width * t.height < min.width * min.height ? t : min), null);
}

/** One target that fails the floor, with the axis (or axes) that failed. */
export interface FloorViolation {
  target: HitTarget;
  /** "44x32" style, so the assertion message says WHAT was wrong. */
  failed: string;
}

export interface FloorReport {
  /** Every operable target measured — the denominator. */
  operable: HitTarget[];
  /** Every operable target failing the floor on either axis. */
  under: FloorViolation[];
  /** Smallest by area, for the headline message only. */
  smallest: HitTarget | null;
}

/**
 * THE 44px GATE, over EVERY operable target — never over the min-area one.
 *
 * R8 review, Important 1. The first cut of this sweep asserted the floor
 * against `smallestOperable` alone, and MIN-AREA IS NOT MIN-DIMENSION. With
 * the binding control at 92.11 x 44 (area 4053), any target WIDER than ~92px
 * and SHORTER than 44px has a LARGER area, is therefore never selected as
 * "smallest", and is never asserted at all — a 200 x 30 button would have
 * sailed through a gate whose whole purpose is to catch it.
 *
 * Nothing escapes today (`tile-grid.tsx`'s `KIND_MIN_HEIGHT` is 52/52/52/44
 * and the chassis controls carry an explicit `minHeight: 44`), so that was
 * latent rather than live — but the gate read far stronger than it was, which
 * is the more dangerous of the two states. Every caller now asserts over the
 * whole array; the per-skin JSON records already carried it, so this costs
 * nothing but the loop.
 */
export function hitTargetFloorReport(
  targets: readonly HitTarget[],
  floor: number = HIT_TARGET_FLOOR_PX,
): FloorReport {
  const operable = targets.filter((t) => !t.disabled);
  const under = operable
    .filter((t) => t.width < floor || t.height < floor)
    .map((t) => ({
      target: t,
      failed: `"${t.name}" (${t.role}) is ${t.width}x${t.height}px${
        t.width < floor && t.height < floor ? " — both axes" : t.width < floor ? " — width" : " — height"
      }`,
    }));
  return { operable, under, smallest: smallestOperable(targets) };
}

/** The `under` list rendered for an assertion message, newest-reader-first:
 *  the count and denominator, then each offender. Returned as a string[] so
 *  `toEqual([])` prints the offenders themselves rather than a bare count. */
export function floorViolationLines(report: FloorReport): string[] {
  return report.under.map((v) => v.failed);
}

/**
 * How far the page overflows its viewport horizontally, in px (0 when it does
 * not). Measured with the SAME clip-lifting technique `expectNoHorizontalScroll`
 * (helpers.ts) uses, not a naive `documentElement.scrollWidth` vs
 * `clientWidth` comparison: globals.css sets `overflow-x: clip` on html/body,
 * which pins `scrollWidth` to the viewport width no matter how far a child
 * overflows — the exact reason the pre-#325 version of that gate could never
 * fail.
 *
 * This MEASURES and does not assert, so a caller can record the real number
 * whether its own assertion passed or failed. Moved here from
 * `scorepad-a11y-evidence.spec.ts` (where it was `measureScrollOverflow`)
 * unchanged, so the sweep and the evidence recorder report one number
 * computed one way.
 */
export async function measureOverflow(
  page: Page,
): Promise<{ scrollWidth: number; viewportWidth: number; overflowPx: number }> {
  return page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const vw = html.clientWidth;
    const htmlPrev = html.style.overflowX;
    const bodyPrev = body.style.overflowX;
    html.style.overflowX = "visible";
    body.style.overflowX = "visible";
    const scrollWidth = html.scrollWidth;
    html.style.overflowX = htmlPrev;
    body.style.overflowX = bodyPrev;
    return { scrollWidth, viewportWidth: vw, overflowPx: Math.max(0, scrollWidth - vw) };
  });
}

/** Just the overflow number, for a record that only keeps the one field. */
export async function measureOverflowPx(page: Page): Promise<number> {
  return (await measureOverflow(page)).overflowPx;
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

/** Locates the cookie-consent banner. See `dismissCookieBanner` for why this
 *  shape, and `consentedAnonymousState` for why the preferred defence is to
 *  stop the banner mounting rather than to find it. */
function cookieBanner(page: Page): Locator {
  return page
    .locator("div")
    .filter({ has: page.locator('a[href="/legal/cookie-policy"]') })
    .last();
}

/** An anonymous `storageState` that has ALREADY answered the cookie banner —
 *  the same two localStorage keys `auth.setup.ts` bakes into the authed state,
 *  for a context that carries no session at all.
 *
 *  WHY PREVENTION AND NOT DISMISSAL. `dismissCookieBanner` can only react to a
 *  banner that has already mounted, and the banner mounts from a `useEffect`
 *  (`cookie-consent.tsx` — `visible` starts false, so it is not in the SSR
 *  HTML), which means it appears at HYDRATION. `page.goto` resolves before
 *  that. Measured 2026-09-03 against this branch's own prod bundle, on
 *  `/score/…`: at 1x and 6x CPU the banner was already up when `goto`
 *  returned, but under a 20x CPU throttle — a stand-in for four Playwright
 *  workers on a loaded machine — `goto` returned with the banner NOT yet
 *  mounted and it appeared 575ms later. So `dismissCookieBanner`'s
 *  `count() === 0` early return is a silent no-op in exactly the conditions
 *  that produce the failure, and the banner then lands on top of the pad,
 *  where axe scans it and `boundingBox()` measures it. That is the recorded
 *  flake in `scorepad-a11y-evidence.spec.ts` — twice — reported as
 *  "Cookie policy 173x38, Accept 67x34, Reject 66x34" instead of pad targets.
 *
 *  Seeding the choice removes the race rather than widening a wait: the
 *  effect's own `needsConsentPrompt()` reads these two keys and never sets
 *  `visible`. Values come from `src/lib/consent` rather than being typed here,
 *  so a key rename or a `COOKIE_POLICY_VERSION` bump moves this with it — the
 *  version stamp is load-bearing, since a mismatch re-prompts.
 *
 *  Cookies stay explicitly empty. `browser.newContext()` inherits
 *  `use.storageState` from `playwright.config.ts`, so an anonymous surface has
 *  to say so rather than rely on an option being absent. */
export async function consentedAnonymousState(): Promise<{
  cookies: [];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}> {
  const { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } = await import(
    "../src/lib/consent"
  );
  return {
    cookies: [],
    origins: [
      {
        origin: new URL(process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000").origin,
        localStorage: [
          { name: CONSENT_KEY, value: "rejected" },
          { name: CONSENT_VERSION_KEY, value: COOKIE_POLICY_VERSION },
        ],
      },
    ],
  };
}

/** Assert no cookie banner is over the surface about to be measured. The
 *  failure this closes was SILENT-BY-DISTORTION: the banner was measured and
 *  the numbers were reported as the pad's. This turns a recurrence into a
 *  named failure at the point of arrival instead of a puzzling geometry
 *  result three assertions later. Auto-retrying by design — a banner that is
 *  still hydrating in has to have somewhere to appear before we accept 0. */
export async function expectNoCookieBanner(page: Page, where: string): Promise<void> {
  await expect(
    cookieBanner(page),
    `${where}: the cookie-consent banner is on screen, so every measurement below ` +
      `it is taken against an obscured page (seed consent into the context's ` +
      `storageState — see consentedAnonymousState)`,
  ).toHaveCount(0, { timeout: 10_000 });
}

/** The cookie-consent banner renders app-wide from the root layout and its
 *  fixed overlay intercepts pointer events. `auth.setup.ts` pre-dismisses it
 *  into the shared storageState, so an authed spec never sees one — but an
 *  anonymous context (the device-link pad) does, and a banner sitting over the
 *  pad both blocks taps and distorts every geometry measurement below it.
 *  Idempotent: a no-op when no banner is on screen.
 *
 *  REACTIVE, AND THEREFORE SECOND-BEST. It cannot dismiss a banner that has
 *  not mounted yet, and under load it runs before the banner arrives — see
 *  `consentedAnonymousState`, which is the defence to reach for when you own
 *  the context. Keep this for callers that only hold a `Page` (the authed
 *  `page` fixture, where consent is already in the storage state and this is a
 *  cheap no-op).
 *
 *  R8 review, Minor 4 — SCOPED TO THE BANNER, not page-wide. A bare
 *  `page.getByRole("button", {name: "Accept"})` is a page-wide match, so the
 *  day any pad, sheet or dialog ships its own "Accept" control this helper
 *  starts clicking it — silently dispatching a real scoring action in a
 *  routine that is supposed to be a no-op.
 *
 *  The banner (`src/components/cookie-consent.tsx`) carries no testid or
 *  landmark role, so it is identified by the one thing only it has: it is the
 *  innermost `<div>` containing a link to the cookie policy. `.last()` on the
 *  ancestor chain is the innermost such div — the link sits inside a `<p>`, so
 *  the deepest DIV that contains it IS the banner's own container. Structural
 *  rather than class-based on purpose: the container's classes are pure
 *  layout (`fixed bottom-4 left-4 …`) and would break on any restyle. */
export async function dismissCookieBanner(page: Page): Promise<void> {
  const banner = cookieBanner(page);
  if ((await banner.count()) === 0) return;
  const accept = banner.getByRole("button", { name: "Accept", exact: true });
  if ((await accept.count()) > 0) {
    await accept.first().click();
    await expect(accept).toHaveCount(0, { timeout: 10_000 });
  }
}
