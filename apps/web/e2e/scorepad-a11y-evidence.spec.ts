import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import { apiJson, fixturePath, seedRosteredFixture, expectNoHorizontalScroll, TAG } from "./helpers";
import {
  HIT_TARGET_FLOOR_PX,
  consentedAnonymousState,
  dismissCookieBanner,
  expectNoCookieBanner,
  floorViolationLines,
  hitTargetFloorReport,
  measureHitTargets,
  measureOverflow,
  scanPadContrast,
  type HitTarget,
} from "./scorepad-a11y-kit";

/*
 * S13/#422 W11 cutover — recorded accessibility evidence for the two REAL v2
 * scoring-pad surfaces, at desktop (1280), 375 and 320. The session's own
 * acceptance requires "final screenshots (console + device pad, desktop AND
 * 375px) attached" and "a11y pass recorded: focus order, hit-target sizes,
 * contrast ratios" — nothing else in the suite records that with numbers.
 * v6-sports.spec.ts's icehockey test and scorepad-skins.spec.ts's five skin
 * scans prove color-contrast only, at one width each, and neither measures
 * hit-target geometry or tab order at all. Each of the six tests below
 * writes a PNG (test-results/s13-a11y/<combo>.png) and a JSON measurement
 * record (test-results/s13-a11y/<combo>.json, both gitignored — see
 * .gitignore's `test-results/`) with real numbers, plus repo-standard
 * assertions (no page-level horizontal scroll, the 44px hit-target floor, no
 * serious/critical WCAG2A/AA contrast violation on the pad, no keyboard
 * trap, tab order follows visual order) so a regression here goes red, not
 * just unrecorded. Uses `expect.soft` throughout: the point of this file is
 * the RECORD, so a failing check must never stop the rest of a combination
 * from being measured and written.
 *
 * Fixture setup and surface-opening reuse the exact flows the rest of this
 * suite already proved rather than inventing parallel ones:
 * `seedRosteredFixture` (helpers.ts), `openLiveConsole` (byte-for-byte
 * scorepad-skins.spec.ts's own helper of the same name — poll the real
 * ledger for core.start rather than a fixed sleep), and the anonymous
 * device-link context (an anonymous `browser.newContext` + a minted secret,
 * scorepad-offline.spec.ts's own pattern — here with the cookie banner
 * answered in the seeded state, see `consentedAnonymousState`). `generic`/
 * `score`, individual entrants, is the sport both of those files
 * independently chose for the same reason: it is the one action cheap
 * enough to drive with no real roster, and it tolerates
 * `state.phase === "pre"`, so the device-link surface needs no `core.start`
 * at all.
 *
 * Each test drives exactly one interaction — tap the home half of the
 * scoreboard (ScoringPad v3, tapModel S: the half IS the button; repeated
 * for the Tab walk, see the race below) and measure
 * with the detail dock open, BEFORE any chip is chosen. R7/A1 moved `generic`
 * onto the v3 lane, so the "Add points" form this file used to expand no
 * longer exists; the dock is its direct successor as the one state that is
 * both richer than idle and stable enough to measure — the tap has already
 * been soft-committed, so nothing is mid-submit, and the dock's own amount
 * chips, the board, the tile row and the recording chip are all on screen
 * together. It is also the denser measurement of the two: the dock adds a
 * countdown and a flush control the old form never had.
 *
 * ONE RACE THIS FILE MUST RESPECT: the dock closes itself after queue.ts's
 * HOLD_MS — 10s shipped, but CI bakes NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000 into
 * the build it tests. Every measurement below therefore runs against a dock
 * the caller has just opened, and `openAmendDock` asserts it is visible rather
 * than assuming it. The Tab walk comes last and CHANGES ANSWER when the dock
 * has closed, so it gets a dock of its own (`openFreshAmendDock`), must find
 * that dock open on both sides of the walk, and is redone in a new hold a
 * bounded number of times when it does not; see `recordEvidence` for what
 * closes the dock, and which of those can land during a walk.
 *
 * The horizontal-scroll number is measured with the SAME clip-lifting
 * technique `expectNoHorizontalScroll` (helpers.ts) uses, not a naive
 * `documentElement.scrollWidth` vs `clientWidth` comparison: globals.css
 * sets `overflow-x: clip` on html/body, which pins scrollWidth to the
 * viewport width no matter how far a child overflows — the exact reason the
 * pre-#325 version of this gate could never fail. The real helper is still
 * what asserts (try/catch'd to a soft failure, so it can never abort a
 * combination before the rest of it is recorded).
 *
 * Accessible names are computed with a hand-rolled aria-label /
 * aria-labelledby / associated-<label> / title / text-content heuristic,
 * not a formal accessible-name-and-description computation: this
 * Playwright version (1.61) has no `page.accessibility.snapshot()` (no CDP
 * AX-tree bridge left), and `locator.ariaSnapshot()`'s YAML is meant for
 * human/AI reading, not stable per-element parsing. The heuristic covers
 * every control this pad actually renders (native button/select/input, all
 * labelled one of those ways) and is adequate for a recorded-evidence pass
 * — it is not a substitute for a real automated accessible-name audit.
 */

const OUT_DIR = fileURLToPath(new URL("../test-results/s13-a11y/", import.meta.url));
const WIDTHS = [1280, 375, 320] as const;
const HEIGHT: Record<(typeof WIDTHS)[number], number> = { 1280: 900, 375: 800, 320: 700 };

// R8/WS-H — `INTERACTIVE_SELECTOR`, `HitTarget` and `measureHitTargets` MOVED
// to `./scorepad-a11y-kit.ts` and are imported above, unchanged. R8 extends
// the 44px sweep from this file's one sport (`generic`) to all eleven v3
// skins, and Playwright refuses to let one spec import another — so the
// measurement had to live in a non-spec module or be written a second time,
// and two hand-written copies of one measurement is how two gates drift into
// disagreeing about the same pixel. Nothing about the geometry changed; see
// the kit's own header for the traps it now also guards.

function pad(page: Page): Locator {
  return page.locator('[data-testid="score-pad"]');
}

async function ledger(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ id: string; seq: number; type: string }[]> {
  const res = await apiJson<{ id: string; seq: number; type: string }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

/** Mirrors scorepad-skins.spec.ts's own `openLiveConsole` exactly: drive the
 *  console's REAL "Start match" control and poll the real ledger for
 *  core.start rather than a fixed sleep. */
async function openLiveConsole(page: Page, fx: { fixtureId: string }): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
}

/** Mirrors scorepad-offline.spec.ts's own `openDeviceLink` exactly: the
 *  TOKEN is the only credential on this surface, so the context must never
 *  inherit an authed storageState (callers pass a fresh anonymous context). */
async function openDeviceLink(page: Page, secret: string): Promise<void> {
  await page.goto(`/score/${secret}`);
  // R8/WS-H — was an inline `if (count) click()`. `dismissCookieBanner` (the
  // kit) is the same two lines plus the half this one was missing: it WAITS
  // for the banner to actually go away. An Accept click that has not settled
  // leaves a fixed overlay over the pad for the next few frames, and every
  // geometry measurement below it is then taken against an obscured page.
  //
  // W1/Task 7 — and it is still not enough on its own, which is why this file
  // has now flaked on this banner twice. The context is seeded with a consent
  // choice (`consentedAnonymousState`) so the banner never mounts; this call
  // stays as the fallback for a banner raised some other way, and the
  // assertion below is what stops a recurrence being measured in silence.
  await dismissCookieBanner(page);
  await expectNoCookieBanner(page, "device-link pad");
  // Scorer sheets §4.5.1 — a scan of a not-yet-started fixture opens on the
  // Confirm card; the pad mounts only once the device taps Start match. That
  // is the product's own flow, so the evidence is taken on the started pad.
  await expect(page.getByTestId("scan-confirm"), "a not-yet-started scan opens on Confirm").toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("score-start-match").click();
  await expect(page.locator('[data-role="v3-scorebug"]'), "the v3 board must render").toBeVisible({
    timeout: 20_000,
  });
}

/** Tap the home half — the point is recorded on the way in — and STOP with
 *  the amend dock open; see the file header for why this state, not a
 *  completed score, is what gets measured. Takes an explicit scope rather
 *  than assuming `[data-testid="score-pad"]`: that testid exists only on
 *  fixture-console.tsx (grepped — the console surface). device-score-pad.tsx
 *  never renders it, so a scope hardcoded to it resolves to nothing there and
 *  every locator action below would retry silently until the whole test timed
 *  out (confirmed: exactly what happened before this was parameterised —
 *  three device-pad tests each ran the full 90s with no error until the
 *  deadline).
 *
 *  `[data-role="v3-scorebug-half"]` (scorebug.tsx, added in review) replaces
 *  a `.grid > * >> .app-display.font-bold` structural chain: it reached
 *  through the score figure's OWN layout classes to find the half, so it
 *  broke on any restyle of either. `.nth(0)` is home, by the chassis's own
 *  render order (scorebug.tsx: `spec.halves.map`) — every half tap site in
 *  this suite relies on the same order. */
async function openAmendDock(scope: Locator): Promise<void> {
  await scope.locator('[data-role="v3-scorebug-half"]').nth(0).click({ timeout: DOCK_OPEN_WAIT_MS });
  await expect(scope.locator('[data-role="v3-dock"]'), "a tally tap must open the amend dock").toBeVisible({
    timeout: DOCK_OPEN_WAIT_MS,
  });
}

/** How long `openAmendDock` gives the half's tap, and then the dock, to
 *  happen. The tap needs a bound of its own: playwright.config.ts sets no
 *  `actionTimeout`, so an unbounded click would wait out the whole test
 *  instead of failing inside the walk's budget (`TAB_WALK_ATTEMPT_MS`). */
const DOCK_OPEN_WAIT_MS = 20_000;

/** How many complete Tab walks `recordEvidence` tries before it reports
 *  every attempt as a failure. Each attempt runs in a fresh hold of its own,
 *  so a walk that lost to the hold tick is redone in a whole new window
 *  rather than resumed in what is left of the old one. */
const TAB_WALK_ATTEMPTS = 3;

/** `openAmendDock`, but guaranteed to open a NEW dock — one whose hold
 *  window starts now — rather than to find the old one still on screen.
 *
 *  `openAmendDock` alone cannot promise that while a dock is already up. A
 *  second tap does not re-arm the dock in place: queue.ts's `enqueueHeld`
 *  first flushes the tap already held (`flushHeldBefore` → its `onDue` →
 *  pad-host's `setHeld(null)`: dock unmounted), then stores the new one, and
 *  only then does pad-host set `held` again (dock mounted). The click
 *  returns before any of that, so `toBeVisible` passes at once on the OLD
 *  dock, and whatever samples the dock next can land in the gap between the
 *  two — main's run 36358901720 (device @320 on both attempts, console
 *  @1280/375 once each): `dockOpenBeforeWalk: false`, followed by a walk that
 *  began at the NEW dock's "Send now".
 *
 *  So the held tap is sent first with the dock's own "Send now" (the
 *  user-reachable way to end a hold early — `releaseHeld`, the same `onDue`
 *  as the natural tick), the dock is waited on until it is GONE, and only
 *  then is the half tapped; a dock that shows after that can only be the new
 *  tap's. The click may miss — the hold can lapse on its own between the
 *  check and the click — because the `toBeHidden` after it is the actual
 *  guard, budgeted from `HOLD_MS` (AGENTS.md rule 20), so a missed click
 *  still ends in the natural close. */
async function openFreshAmendDock(scope: Locator): Promise<void> {
  const dock = scope.locator('[data-role="v3-dock"]');
  if (await dock.isVisible()) {
    await dock
      .getByTestId("pad-send-now")
      .click({ timeout: SEND_NOW_CLICK_MS })
      .catch(() => {});
  }
  await expect(dock, "the previous hold must end before a fresh dock can be told apart from it").toBeHidden({
    timeout: DOCK_CLOSE_WAIT_MS,
  });
  await openAmendDock(scope);
}

const SEND_NOW_CLICK_MS = 2_000;
const DOCK_CLOSE_WAIT_MS = HOLD_MS + 5_000;

/** One walk attempt at its worst, summed from the waits it is made of: the
 *  "Send now" click, the old dock's close, `openAmendDock`'s tap and then its
 *  dock, and an allowance for the walk itself (0.1–1.4s measured, even under
 *  a 4× CPU throttle). */
const TAB_WALK_ATTEMPT_MS = SEND_NOW_CLICK_MS + DOCK_CLOSE_WAIT_MS + 2 * DOCK_OPEN_WAIT_MS + 10_000;

/** Each evidence test's clock. 90s is the budget these tests had before the
 *  walk could be redone, and it still covers everything outside the walk
 *  loop. The loop gets its own worst case on top, derived from `HOLD_MS`
 *  through `TAB_WALK_ATTEMPT_MS`, so every attempt can run out and the
 *  per-attempt report still prints before the test's own timeout. A flat
 *  number would let a blown budget report whatever was in flight instead
 *  (AGENTS.md rule 20). */
const EVIDENCE_TEST_TIMEOUT_MS = 90_000 + TAB_WALK_ATTEMPTS * TAB_WALK_ATTEMPT_MS;

interface FocusStep {
  name: string;
  tag: string;
  x: number;
  y: number;
}

/** Tabs forward from a blurred (no active element) start, recording every
 *  step that lands inside the pad, in visit order. Stops on the first Tab
 *  that leaves the pad after having entered it (a clean exit), on Tab
 *  leaving the document entirely, or after `maxSteps` (60 — generous
 *  headroom over anything this pad plausibly renders). A DOM stamp
 *  attribute (not a derived coordinate/text key) is the identity check for
 *  "have we already visited this exact node" — the only reliable way to
 *  detect a genuine focus trap without a false positive from two
 *  similarly-labelled controls. The stamps are cleared first: a walk redone
 *  on the same page (`recordEvidence`'s retry) would otherwise read every
 *  node the previous walk visited as a trap. */
async function tabThroughPad(
  page: Page,
  scopeSelector: string,
  maxSteps = 60,
): Promise<{ order: FocusStep[]; trapped: boolean; exitedCleanly: boolean }> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-a11y-tab-seen]")) el.removeAttribute("data-a11y-tab-seen");
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const order: FocusStep[] = [];
  let enteredPad = false;
  let exitedCleanly = false;
  let trapped = false;

  for (let i = 0; i < maxSteps; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate((padSelector) => {
      const el = document.activeElement as
        | (HTMLElement & { labels?: NodeListOf<HTMLLabelElement>; placeholder?: string; value?: string })
        | null;
      if (!el || el === document.body) return null;
      const padEl = document.querySelector(padSelector);
      const inPad = !!padEl && padEl.contains(el);
      const STAMP = "data-a11y-tab-seen";
      const already = el.hasAttribute(STAMP);
      if (!already) el.setAttribute(STAMP, "1");

      let name = "";
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) name = aria.trim();
      if (!name) {
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          name = labelledby
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
            .filter(Boolean)
            .join(" ");
        }
      }
      if (!name && el.labels && el.labels.length) {
        name = Array.from(el.labels)
          .map((l) => l.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
      }
      if (!name) {
        const title = el.getAttribute("title");
        if (title && title.trim()) name = title.trim();
      }
      if (!name) {
        const text = (el.innerText ?? el.textContent ?? "").trim();
        if (text) name = text.replace(/\s+/g, " ").slice(0, 60);
      }
      if (!name && el.placeholder) name = `[placeholder] ${el.placeholder}`;
      if (!name && el.value) name = `[value] ${el.value}`;
      if (!name) name = `<${el.tagName.toLowerCase()}>`;

      const rect = el.getBoundingClientRect();
      return { inPad, already, name, tag: el.tagName.toLowerCase(), x: Math.round(rect.x), y: Math.round(rect.y) };
    }, scopeSelector);

    if (!info) break;
    if (info.inPad) {
      enteredPad = true;
      if (info.already) {
        trapped = true;
        break;
      }
      order.push({ name: info.name, tag: info.tag, x: info.x, y: info.y });
    } else if (enteredPad) {
      exitedCleanly = true;
      break;
    }
  }
  return { order, trapped, exitedCleanly };
}

/** Counts steps that jump UP the page beyond a same-row tolerance — the
 *  falsifiable form of "tab order follows visual order" the brief asks for.
 *  8px tolerance absorbs sub-pixel/same-row differences without masking a
 *  real reorder (a genuinely mis-ordered control lands a full row away). */
function backwardJumps(order: FocusStep[], rowTolerance = 8): number {
  let jumps = 0;
  for (let i = 1; i < order.length; i++) {
    if (order[i]!.y < order[i - 1]!.y - rowTolerance) jumps++;
  }
  return jumps;
}

// R8/WS-H fix round 1 — `measureScrollOverflow` MOVED to the kit as
// `measureOverflow`, unchanged, so the eleven-skin sweep and this recorder
// report one number computed one way (the clip-lifting technique; a naive
// scrollWidth/clientWidth comparison can never fail under globals.css's
// `overflow-x: clip`).

/** Measures everything, writes the PNG + JSON record, THEN asserts —
 *  entirely with `expect.soft` (plus a try/catch around the one throwing
 *  helper) so a failing check never stops the rest of this combination from
 *  being recorded. */
async function recordEvidence(page: Page, comboName: string, scopeSelector: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const scope = page.locator(scopeSelector);

  const scroll = await measureOverflow(page);
  try {
    await expectNoHorizontalScroll(page);
  } catch (err) {
    expect.soft(false, `expectNoHorizontalScroll: ${err instanceof Error ? err.message : String(err)}`).toBe(true);
  }

  await page.screenshot({ path: join(OUT_DIR, `${comboName}.png`), fullPage: true });

  // R8 review, Important 1 — the floor is asserted over EVERY operable target
  // now, not against the min-AREA one. Min-area is not min-dimension: a
  // control wider than the binding 92.11x44 but shorter than 44px has a
  // LARGER area, so it was never the "smallest" and was never checked. See
  // `hitTargetFloorReport` (the kit) for the full reasoning.
  const hitTargets: HitTarget[] = await measureHitTargets(scope);
  const floor = hitTargetFloorReport(hitTargets);
  const { operable, smallest } = floor;
  expect.soft(smallest, "no operable hit target found inside the pad to measure").not.toBeNull();
  expect
    .soft(
      floorViolationLines(floor),
      `${floor.under.length} of ${operable.length} operable targets are under the ${HIT_TARGET_FLOOR_PX}px floor (smallest by area: "${smallest?.name}" ${smallest?.width}x${smallest?.height})`,
    )
    .toEqual([]);

  // S13/#422 W11 cutover — the `device-*` combinations are LEFT RED here,
  // reported rather than fixed (out of scope: this pass records evidence,
  // it does not touch apps/web/src). First real axe scan this surface has
  // ever had — v6-sports.spec.ts's icehockey scan and scorepad-skins.spec.ts's
  // five skin scans only ever open the CONSOLE (`openLiveConsole`), never
  // `/score/[token]`, so device-score-pad.tsx's OWN `<header>` (a component
  // separate from pad-renderer.tsx's, which this session's contrast fixes —
  // dac2b6bb/4776862d/71ae0c5f — already covered) was never in scope for any
  // of them. Confirmed deterministic across all three widths, not a flake:
  // text-slate-500/600 on bg-slate-900 (~3.74:1 / ~2.35:1 against the 4.5:1
  // floor) on four elements — device-score-pad.tsx:200 (division/round
  // label), :216 ("scheduled"/status badge), :224 ("vs" separator), :239
  // (the "Courtside scorer pad…" caption); :234's per-name "·" separator is
  // the same class on a line this fixture's 2-entrant case never renders.
  // Same underlying color-token mistake already fixed on pad-renderer.tsx
  // and period-skin.tsx this session, just not here yet. Not weakened or
  // re-scoped to dodge it — that would hide exactly the class of defect this
  // scan exists to catch.
  //
  // R8/WS-H — the invocation itself moved to `scanPadContrast` (the kit),
  // shared with the eleven-skin sweep. Same tags, same serious/critical gate,
  // same scope; what it ADDS is the anti-vacuity proof this call never had —
  // that the scope resolved, is visible, contains the v3 scorebug, and had at
  // least one `color-contrast` node actually evaluated inside it. That is
  // exactly the check whose absence let the `main`-scoped version of this very
  // call report zero for a whole session, four real violations sitting one
  // element outside its scope.
  const scan = await scanPadContrast(page, scopeSelector);
  const axeViolations = scan.violations;
  expect.soft(scan.serious, JSON.stringify(scan.serious, null, 2)).toEqual([]);

  // A FRESH DOCK FOR THE WALK, AND A NEW ONE IF IT DID NOT HOLD. Everything
  // above takes four to six seconds on a 2-vCPU CI runner, against a dock CI
  // holds for three, and the walk's answer CHANGES rather than merely ages
  // once the dock is gone: with it open, Tab from the tapped half lands on the
  // dock's own controls (Send now, then the amount chips); after it closes,
  // Tab from that same point lands on the Activity list's first Void button,
  // BELOW the pad, and the walk records zero pad controls (PR #888's
  // dispatched run 36337877584).
  //
  // What closes the dock: the hold tick (one plain `setTimeout` of `HOLD_MS`,
  // armed in queue.ts's `enqueueHeld` and never pushed back); "Send now"
  // (`releaseHeld`); the NEXT tap, which flushes the held one before holding
  // its own; and Take back (pad-host's `handleUndo` → `dropHeldSubmission` →
  // `setHeld(null)`). Focus and blur are not on the list — nothing in
  // pad-host.tsx or detail-dock.tsx listens for either — and no interaction
  // extends a hold. Only the tick can land DURING a walk: Tab moves focus and
  // presses nothing, so there is no Send now, tap or Take back mid-walk. The
  // tick is what the walk races. The tap is what the re-arm raced — see
  // `openFreshAmendDock` for why a bare re-tap here sampled the gap between
  // the two docks on CI (run 36358901720).
  //
  // So every attempt starts from a dock that is provably new and must find it
  // open on BOTH sides of the walk. Nothing during a walk can open a dock —
  // only a tap holds one, and Tab taps nothing — so open before and open
  // after is open throughout, and the recorded ORDER is that state's order. A
  // walk the hold tick cut short is thrown away and redone in a whole new
  // window, up to `TAB_WALK_ATTEMPTS` times. When every attempt loses, the
  // assertion fails with each attempt's timings — the signal that a walk has
  // become slower than `HOLD_MS` itself, not a flake to retry past. A re-arm
  // that FAILS is a separate red, even when a later attempt holds: the retry
  // is for walks the tick cut short, not for a dock that outlived its hold or
  // a tap that opened none.
  //
  // Not "walk first": that pushes the hit-target sweep into the dock's
  // closing, where `measureHitTargets`' `nth(i)` outlives the element it
  // counted and `boundingBox()` waits out the whole test timeout (seen
  // locally, device @1280, 90s). Walking last leaves every measurement above
  // exactly where it was, against the caller's tap.
  const dock = scope.locator('[data-role="v3-dock"]');
  const attempts: Array<Record<string, unknown>> = [];
  let focus: Awaited<ReturnType<typeof tabThroughPad>> = { order: [], trapped: false, exitedCleanly: false };
  let dockOpenBeforeWalk = false;
  let dockOpenAfterWalk = false;
  for (let attempt = 1; attempt <= TAB_WALK_ATTEMPTS; attempt++) {
    try {
      await openFreshAmendDock(scope);
    } catch (err) {
      attempts.push({ attempt, rearmFailed: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      continue;
    }
    const walkStart = Date.now();
    dockOpenBeforeWalk = await dock.isVisible();
    focus = await tabThroughPad(page, scopeSelector);
    dockOpenAfterWalk = await dock.isVisible();
    attempts.push({ attempt, dockOpenBeforeWalk, dockOpenAfterWalk, steps: focus.order.length, walkMs: Date.now() - walkStart });
    if (dockOpenBeforeWalk && dockOpenAfterWalk) break;
  }
  // Printed only when a walk was redone; the JSON record below keeps every
  // run's attempts either way.
  if (attempts.length > 1) console.log(`[a11y-walk ${comboName}] HOLD_MS=${HOLD_MS} ${JSON.stringify(attempts)}`);
  expect
    .soft(
      attempts.filter((a) => "rearmFailed" in a),
      `a fresh amend dock could not be opened for the Tab walk — ${attempts.length} attempt(s) at HOLD_MS ${HOLD_MS}: ${JSON.stringify(attempts)}`,
    )
    .toEqual([]);
  const jumps = backwardJumps(focus.order);
  expect
    .soft(
      { dockOpenBeforeWalk, dockOpenAfterWalk },
      `the amend dock must be open for the whole Tab walk, or the order below is not the dock-open state's — ${attempts.length} attempt(s) at HOLD_MS ${HOLD_MS}: ${JSON.stringify(attempts)}; last order: ${JSON.stringify(focus.order)}`,
    )
    .toEqual({ dockOpenBeforeWalk: true, dockOpenAfterWalk: true });
  expect.soft(focus.order.length, "no interactive control in the pad was reachable by Tab").toBeGreaterThan(0);
  expect
    .soft(focus.trapped, `focus got stuck cycling inside the pad without ever leaving it: ${JSON.stringify(focus.order)}`)
    .toBe(false);
  // S13 W11 follow-up — FIXED, and now asserted rather than merely recorded.
  // Root cause (unchanged from the original diagnosis): the "Tally" panel's
  // action group renders through panel.tsx's `grid` layout
  // (ACTIONS_CLASS.grid = "grid grid-cols-2 gap-2") — two actions sharing
  // one visual row, where an expanded ActionForm's controls extend far down
  // column 1 while its row-mate's button stays near the row's top, so DOM/
  // tab order used to land BACKWARD up the page once that row grew tall
  // (deterministic, not a flake: console 2 jumps @1280, 1 @375, 1 @320;
  // device 1 @1280, 1 @375, 0 @320 — the last measurement taken before the
  // fix).
  //
  // The fix is a DOM-order-only change, not a restyle: panel.tsx's
  // `orderForTabSequence` now reorders each `grid`/`perSide` row so a
  // still-collapsed action always precedes an expanded row-mate in the DOM,
  // while an explicit CSS `order` pins every action to its ORIGINAL
  // on-screen position regardless of that reorder — no positive `tabindex`,
  // and pixel-identical at every width (see panel.tsx's own header and
  // `orderForTabSequence`'s docstring for the mechanism; pad-renderer.
  // test.tsx has the unit coverage, including the exact two-actions-share-
  // one-`type` shape generic's real Tally panel uses).
  //
  // ASSERTED AT <= 1, NOT 0, AND THAT IS A MEASURED CEILING RATHER THAN A
  // ROUNDED-DOWN AMBITION. The row-pairing fix above is real and unit-proved,
  // but CI showed it does not take the console to zero: one jump survives at
  // 1280 and 375, and its recorded coordinates place it somewhere else
  // entirely — the Cancel/Confirm row sits at y=428 while the attribution
  // controls it belongs to sit at y=805/856, i.e. the confirm row paints
  // ABOVE the block it confirms. That is a second, differently-caused
  // ordering problem in the expanded form's own layout, it pre-dates this
  // branch, and closing it means moving where the attribution picker renders
  // — a visual change that needs its own sign-off rather than being smuggled
  // in behind an accessibility fix.
  //
  // So: this pins the improvement (the row-pairing class of jump cannot come
  // back) without claiming a zero the product has not earned. The exact count
  // and the full focus order are written into the JSON record every run, so
  // the remaining jump stays visible and measurable rather than absorbed into
  // a tolerance. Tighten to 0 in the same commit that fixes the attribution
  // placement.
  expect
    .soft(jumps, `${jumps} backward tab jump(s) recorded: ${JSON.stringify(focus.order)}`)
    .toBeLessThanOrEqual(1);

  await writeFile(
    join(OUT_DIR, `${comboName}.json`),
    JSON.stringify(
      {
        combo: comboName,
        viewport: page.viewportSize(),
        scroll,
        hitTargets: { all: hitTargets, operableCount: operable.length, smallest },
        axeViolations,
        focus: {
          order: focus.order,
          trapped: focus.trapped,
          exitedCleanly: focus.exitedCleanly,
          backwardJumps: jumps,
          dockOpenBeforeWalk,
          dockOpenAfterWalk,
          walkAttempts: attempts,
        },
      },
      null,
      2,
    ),
  );
}

for (const width of WIDTHS) {
  test(`console pad @ ${width}px — screenshot, scroll, hit-targets, focus order, contrast`, async ({
    page,
    request,
  }) => {
    test.setTimeout(EVIDENCE_TEST_TIMEOUT_MS);
    const fx = await seedRosteredFixture(request, {
      label: `A11y Console ${width} ${TAG}`,
      sportKey: "generic",
      variantKey: "score",
      entrantKind: "individual",
      home: [{ fullName: `A11y Console Home ${width} ${TAG}` }],
      away: [{ fullName: `A11y Console Away ${width} ${TAG}` }],
    });
    await page.setViewportSize({ width, height: HEIGHT[width] });
    await openLiveConsole(page, fx);
    await openAmendDock(pad(page));
    await recordEvidence(page, `console-${width}`, '[data-testid="score-pad"]');
  });
}

for (const width of WIDTHS) {
  test(`device pad @ ${width}px — screenshot, scroll, hit-targets, focus order, contrast`, async ({
    browser,
    request,
  }) => {
    test.setTimeout(EVIDENCE_TEST_TIMEOUT_MS);
    const fx = await seedRosteredFixture(request, {
      label: `A11y Device ${width} ${TAG}`,
      sportKey: "generic",
      variantKey: "score",
      entrantKind: "individual",
      home: [{ fullName: `A11y Device Home ${width} ${TAG}` }],
      away: [{ fullName: `A11y Device Away ${width} ${TAG}` }],
    });
    const minted = await apiJson<{ secret: string }>(
      request,
      `/api/v1/fixtures/${fx.fixtureId}/device-links`,
      "POST",
      { label: `A11y Device ${width} ${TAG}` },
    );
    expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);

    // Anonymous — the token is the only credential on this surface — but with
    // the cookie banner already answered. `storageState: undefined` said the
    // first half only, and the banner it let through has flaked this file
    // twice; see `consentedAnonymousState` for the measurement.
    const ctx = await browser.newContext({
      storageState: await consentedAnonymousState(),
      viewport: { width, height: HEIGHT[width] },
    });
    try {
      const dpage = await ctx.newPage();
      await openDeviceLink(dpage, minted.data!.secret);
      // device-score-pad.tsx has no `data-testid="score-pad"` wrapper (that
      // testid is fixture-console.tsx's alone — grepped). This surface has
      // almost no chrome beyond the pad itself (no org nav/breadcrumb, per
      // the proven `openDeviceLink` flow above), so the page's own `<main>`
      // landmark is the faithful equivalent scope: everything a scorer sees
      // here, nothing from a toast/alert region outside it.
      await openAmendDock(dpage.locator("main"));
      // `body`, not `main`: the device page's own header (org strip, status,
      // team line, courtside footer) renders OUTSIDE `<main>`, so a `main`
      // scope silently excluded it — and that is not hypothetical, it hid four
      // real colour-contrast violations in `device-score-pad.tsx` (slate-500
      // and slate-600 on bg-slate-900) through an entire session of scans that
      // reported zero. This page is a single-purpose scoring surface, so the
      // whole document is the right bar.
      await recordEvidence(dpage, `device-${width}`, "body");
    } finally {
      await ctx.close();
    }
  });
}
