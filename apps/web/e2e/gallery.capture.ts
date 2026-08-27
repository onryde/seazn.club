import { test, expect, type Locator, type Page, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loginUi,
  seedRosteredFixture,
  setOrgPlanBySql,
  fixturePath,
  apiJson,
  expectNoHorizontalScroll,
  activeOrg,
  TAG,
  type RosterSlotSpec,
  type RosteredFixture,
  setDivisionConfigSql,
} from "./helpers";
import { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } from "../src/lib/consent";

// ScoringPad v3 R1 Task 10 — the productized gallery capture harness.
//
// Ported from the ad hoc session that produced the programme's baseline
// gallery (docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/_INDEX.md
// — "Evidence: baseline gallery <artifact link>"); the recipe and traps it
// paid for are recorded at `_RULES.md` §2 and restated inline below. R1
// itself converts NO sport (`V3_SKINS = {}` — see v3/registry.ts), so every
// screen this harness captures is today's LEGACY pad, unchanged — that is
// the expected result of running this against the R1 build, not a bug.
// Later waves (R2 cricket, R3 football, …) run the SAME harness again and
// diff the new sport's screens against what shipped here.
//
// Guard #1 (belt): this file is deliberately named `.capture.ts`, not
// `.spec.ts`, so it falls outside every OTHER Playwright project's default
// testMatch and a plain `npm run test:e2e` sweep never selects it. Guard #2
// (braces) is the skip below — even the dedicated `gallery` project
// (playwright.config.ts) no-ops without GALLERY_DIR set. See
// docs/runbooks/pad-gallery.md for the full command line and the sign-off
// gate this harness feeds.
test.skip(
  !process.env.GALLERY_DIR,
  "gallery capture only runs with GALLERY_DIR set — see docs/runbooks/pad-gallery.md " +
    "(npx playwright test e2e/gallery.capture.ts --project=gallery)",
);

const GALLERY_DIR = process.env.GALLERY_DIR ?? "";

// v3/02 §4 + AGENTS.md's standing bar: 320/768/1280 (mobile / tablet /
// desktop reference widths). Heights match mobile.spec.ts's own 320×568 and
// tablet-768's 768×1024; 1280 is the owner's named desktop reference width
// (AGENTS.md), given no exact desktop HEIGHT is pinned anywhere else.
const WIDTHS = [320, 768, 1280] as const;
const HEIGHTS: Record<(typeof WIDTHS)[number], number> = { 320: 568, 768: 1024, 1280: 800 };

/**
 * Owner scope change (R2b sign-off, 2026-08-17): this wave's sign-off SHEET
 * only needs 768/1280 — `GALLERY_WIDTHS` (comma-separated, e.g. "768,1280")
 * overrides which widths get a screenshot FILE for THIS run only. `WIDTHS`
 * above stays the compile-time default, unedited on purpose: every other
 * wave and the runbook (docs/runbooks/pad-gallery.md §2) documents "three
 * widths" as the no-env-var behaviour, and a later wave running this
 * harness with `GALLERY_WIDTHS` unset must still get 320/768/1280 exactly
 * as today. `captureState`'s 320px overflow MEASUREMENT is deliberately
 * NOT gated by this override (see captureState below) — dropping the 320
 * PNG must never also silently drop the measurement, which would read
 * later in manifest.json as "0 == no overflow" for a width nothing
 * actually measured, a false green rather than an honest omission.
 */
function parseActiveWidths(): readonly (typeof WIDTHS)[number][] {
  const raw = process.env.GALLERY_WIDTHS;
  if (!raw) return WIDTHS;
  const known = WIDTHS as readonly number[];
  const parsed = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n): n is (typeof WIDTHS)[number] => known.includes(n));
  if (parsed.length === 0) {
    throw new Error(`GALLERY_WIDTHS="${raw}" matched none of the supported widths (${WIDTHS.join(", ")})`);
  }
  return parsed;
}
const ACTIVE_WIDTHS = parseActiveWidths();

const STATES = ["01-pre", "02-live", "03-scored", "04-dock", "05-devicelink"] as const;
type GalleryState = (typeof STATES)[number];

/**
 * R2b+ — wave-specific captures beyond the fixed five states above, kept in
 * a SEPARATE tuple rather than joined into `STATES` (see `GallerySport.
 * captureExtra` below for why): `STATES` drives every sport's identical
 * five-state loop in the shared test body, and appending to it would demand
 * these two states from all twelve sports, not just the one whose wave
 * added them.
 */
// Only ever read as a TYPE now (`ExtraGalleryState`, below) — cricket's hook
// used to spread it as a value, and stopped when the review found it was
// over-claiming states it never captured. It stays because the union it
// produces is what makes a typo in any `captureExtra` return a COMPILE error
// (it types captureState's `state`, the hook return, and buildIndexHtml's
// `extraStates`), which is exactly the class of bug that over-claim was.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- type source; see above
const EXTRA_STATES = [
  "06-overtile",
  "07-oversheet",
  // R2c (2026-08-18) — the three candidate-narrowing surfaces. None of the
  // five shared STATES opens a picker or a sheet, so without these the
  // sign-off gate is structurally blind to this whole wave: every R2c change
  // is a change to what a picker OFFERS, and a closed picker looks identical
  // before and after. The owner has to see a blocked candidate to rule on it.
  "08-bowlerpicker",
  "09-retiresheet",
  "10-reviewblocked",
  // R4 (2026-08-25) — tennis's tap model S. Same reasoning as R2c's three
  // above, restated because it keeps recurring: none of the five shared
  // STATES opens a sheet or a dock, and tennis's own headline feature (the
  // per-player point dock, R4-1/R4-5) and its named sign-off pain (the
  // doubles serve pip, `_INDEX.md`'s "the doubles serve pip is UNTESTABLE
  // until…") are BOTH invisible without a dedicated capture.
  "11-doublesserve",
  "12-pointdock",
  "13-sanctionsheet",
  // R4 review follow-up (2026-08-26) — `11-doublesserve` photographs service
  // turn 0 only, and turn 0 names the right partner under every derivation
  // anyone has shipped, correct or not. The rotation's real failure point is
  // the game AFTER a closed tie-break, where a derivation that has lost the
  // breaker's own ITF turn count crosses a floor(_/2) boundary and names the
  // OTHER partner for the rest of the match. That is a wrong human name on
  // the scorer's screen, so it is a screen the owner has to be able to see.
  "14-serveafterbreaker",
  // R4 final review (2026-08-26) — two more states no existing capture can
  // reach, both INSIDE a tie-break, which no other tennis screen enters.
  //   15 — the detail dock on a fixture with NO declared lineup, after an
  //        ODD tie-break point. `state.serving` has already handed over
  //        mid-breaker at that instant, so the pad used to offer the scorer
  //        "Double fault" where "Ace" is correct. A wrong serving statistic,
  //        recorded against a person, with nothing on screen to say so — the
  //        owner has to see which chip is offered.
  //   16 — the More sheet during a tie-break. The Award-game TILE was
  //        already correctly withheld there, but withholding a tile is what
  //        pushed the action into the generic More form, where tapping it
  //        threw. The screen that proves it is gone is the sheet itself.
  "15-breakerdock",
  "16-breakermore",
  // Cloud review (2026-08-26). The pad used to refuse to name a server for
  // the REST of a match once ANY set had been entered as a summary — which
  // also stopped stamping `server` on the tap, so no ace or double fault
  // could be attributed to anyone again. Backfilling the sets already played
  // is the most ordinary thing a late-arriving scorer does, so that was the
  // wave's headline capability going dark in its most likely workflow. An
  // EVEN-game summary leaves the rotation derivable and the engine says so;
  // this is the screen where the pip has to still be there.
  "17-serveaftersummary",
  // R3.5 Task A (2026-08-26) — the gallery ran 01-pre..10-reviewblocked (plus
  // tennis's 11-17 above) and had NO tie-break state at all, which is why
  // R2's and R3's own visual sign-offs both passed over a cricket super over
  // that cannot be scored and a football shoot-out that shows the wrong
  // score. These four are captured BEFORE either defect is fixed — proving
  // the gap existed is the point, not a clean "after" picture (see Task C
  // and Task D). Cricket's own 11/12 and football's own 11/12 are
  // deliberately independent per-sport sequences sharing this one flat
  // string union, the same way tennis's 11-doublesserve/12-pointdock above
  // coexist with these unambiguously: a capture's real address is
  // `${sport.slug}/${state}-${width}.png`, never `state` alone.
  "11-superover",
  "12-superover-decided",
  "11-shootout",
  "12-shootout-decided",
  // R5 (2026-08-27) — the racquet family (badminton / table tennis /
  // volleyball, one shared component: racquet-skin.tsx), captured BEFORE the
  // conversion on purpose. See the block comment above `SPORTS` for the three
  // defects each one photographs and which assertion the conversion FLIPS.
  "11-servingplaceholder",
  "12-bandlimited",
] as const;
type ExtraGalleryState = (typeof EXTRA_STATES)[number];

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

/**
 * R4 — v3 tapModel S: tennis's scoreboard halves ARE the point buttons
 * (v3/skins/tennis.tsx), so unlike every other sport in `SPORTS` below,
 * `scoreOne` cannot address a `data-tile-id` or an accessible "Home"/"Away"
 * button — a tappable half's accessible name is the PLAYER'S NAME plus the
 * hint text (`scorebug.tsx`'s own `whoNames`), which this harness has no
 * fixed string for. Indexes the halves grid positionally, home first
 * (scorebug.tsx's own render order) — the same locator shape
 * scorepad-skins.spec.ts's `scorebugHalf` and v6-sports.spec.ts's
 * `tennisHalf` already use for the identical reason.
 */
/**
 * Dispatch a real ledger event, reading `last_seq` fresh each call — the
 * same shape `scorepad-v3-cricket.spec.ts`'s own `postEvent` uses, and for
 * the same reason: driving a whole tie-break through the pad's own taps
 * would be ~60 UI round trips of SETUP for one screenshot, and none of that
 * setup is what the capture is proving.
 */
async function postEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  if (state.status !== 200 || !state.data) {
    throw new Error(`gallery postEvent(${type}): GET state -> ${state.status}`);
  }
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data.last_seq,
    type,
    payload,
  });
  if (res.status >= 300) {
    throw new Error(`gallery postEvent(${type}) -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

/**
 * R3.5 Task A — MERGE a few cfg keys into the division's existing config,
 * never replace it. `setDivisionConfigSql` writes the column verbatim, so a
 * bare object would drop every default the division was created with — the
 * same read-then-write shape this file's own cricket hook already uses for
 * `reviews.perInnings` a few states up, and scorepad-v3-football.spec.ts's
 * own `mergeDivisionConfig`. Called BEFORE the first event so no fold has
 * read the old shape.
 */
async function mergeDivisionConfig(
  request: APIRequestContext,
  divisionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const div = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${divisionId}`);
  if (div.status !== 200 || !div.data) {
    throw new Error(`gallery mergeDivisionConfig: GET division -> ${div.status} ${JSON.stringify(div.error)}`);
  }
  await setDivisionConfigSql(divisionId, { ...div.data.config, ...patch });
}

/**
 * One TAPPABLE v3 scoreboard half. Scoped to `button` deliberately: a half
 * renders EITHER a `<button>` (tappable — live, at the action's band) OR a
 * plain `<div>` at the same grid position, so a wildcard locator happily
 * resolves the still-present pre-fold `<div>`, clicks it, and dispatches
 * nothing. Narrowing to `button` restores Playwright's own auto-wait as the
 * race fix (scorepad-v3-tennis.spec.ts's own `tennisHalf` carries the full
 * reasoning).
 *
 * R5 — generalised out of `tennisHalf` below, unchanged in behaviour: tap
 * model S is no longer tennis-only now that badminton has converted, and
 * two copies of this locator would be two things to keep in step.
 */
function v3Half(page: Page, side: "home" | "away") {
  return pad(page).locator('[data-role="v3-scorebug"] .grid > button').nth(side === "home" ? 0 : 1);
}

/**
 * One v3 half's SCORE readout specifically, as opposed to the half's whole
 * text. `ScorebugHalf.big` carries no data attribute of its own, so it is
 * addressed by the two classes only it wears — `app-display` plus `font-bold`
 * (the optional `sub` figure beside it is `font-semibold`, scorebug.tsx).
 * Needed rather than a `toContainText` on the half, because these scores are
 * bare small integers and every fixture label in this harness ends in a
 * numeric TAG: `toContainText("2")` would match the player's own name.
 */
function v3HalfScore(page: Page, side: "home" | "away") {
  return pad(page)
    .locator('[data-role="v3-scorebug"] .grid > *')
    .nth(side === "home" ? 0 : 1)
    .locator(".app-display.font-bold");
}

function tennisHalf(page: Page, side: "home" | "away") {
  return v3Half(page, side);
}

/**
 * `page.addInitScript` (not a post-navigation `page.evaluate`, unlike
 * auth.setup.ts's own `capture()` helper) — this harness screenshots the
 * VERY FIRST page load ("01-pre"), so the consent flag must already be in
 * localStorage before the banner's own mount-time read runs, not after.
 * Same two keys/values auth.setup.ts captures into storageState with,
 * restated here because the device-link capture opens a brand-new,
 * unauthenticated browser context that shares nothing with the main page.
 */
async function armCookieBypass(page: Page): Promise<void> {
  await page.addInitScript(
    (args: { k: string; vk: string; v: string }) => {
      try {
        window.localStorage.setItem(args.k, "rejected");
        window.localStorage.setItem(args.vk, args.v);
      } catch {
        // Storage disabled (private mode etc.) — banner may render; not fatal.
      }
    },
    { k: CONSENT_KEY, vk: CONSENT_VERSION_KEY, v: COOKIE_POLICY_VERSION },
  );
}

async function ledgerCount(request: APIRequestContext, fixtureId: string): Promise<number> {
  const res = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  return (res.data ?? []).length;
}

/** Generic "the tap landed" proof — a ledger count strictly greater than a
 *  BEFORE snapshot, rather than filtering on a specific event type. Every
 *  sport's events have a different type name; count growth is the one
 *  invariant true for all twelve, so the driver never needs to know them. */
async function waitForLedgerGrowth(request: APIRequestContext, fixtureId: string, before: number): Promise<void> {
  await expect
    .poll(async () => ledgerCount(request, fixtureId), { timeout: 20_000 })
    .toBeGreaterThan(before);
}

/**
 * Reads `document.documentElement.scrollWidth`/`clientWidth` — the exact
 * pair the dispatch asks for — but with the SAME clip-lift
 * `expectNoHorizontalScroll` (helpers.ts) already uses: `globals.css`'s
 * `overflow-x: clip` on `html, body` pins `scrollWidth` to the viewport no
 * matter how far a child overflows, so a naive read without lifting it
 * always reports zero overflow (repo's own documented #325 false-green).
 * This measures the same way the real gate does; `expectNoHorizontalScroll`
 * right after it is the actual pass/fail assertion.
 */
async function measureScroll(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const htmlPrev = html.style.overflowX;
    const bodyPrev = body.style.overflowX;
    html.style.overflowX = "visible";
    body.style.overflowX = "visible";
    const result = { scrollWidth: html.scrollWidth, clientWidth: html.clientWidth };
    html.style.overflowX = htmlPrev;
    body.style.overflowX = bodyPrev;
    return result;
  });
}

/**
 * A PROOF that the declared state is actually on screen — R3's fix for the
 * per-width fold race (`_INDEX.md`, "the gallery's per-width captures can
 * RACE the fold", 2026-08-24).
 *
 * The defect it closes: `02-live` for football came back showing THREE
 * DIFFERENT BOARDS at three widths from one declared state — 320 rendered the
 * pre-kickoff pad with zero tiles while 768/1280 rendered the live board,
 * because the 320 shot was taken before `core.start` had folded CLIENT-side.
 * Every wait in this harness up to that point polled the SERVER's ledger
 * (`waitForLedgerGrowth`), which says nothing about what the browser has
 * rendered. Nothing failed and nothing in `manifest.json` recorded the
 * disagreement.
 *
 * Why that is worse than one bad PNG: the 320 overflow measurement below runs
 * ALWAYS, even when `GALLERY_WIDTHS` narrows the PNG set, so a 320 capture of
 * an empty board measures an empty board and records a clean `0` — a false
 * green in a merge gate. And a reviewer reading only 768/1280 signs off a
 * board the same sheet contradicts.
 *
 * NEVER A SLEEP: a probe is an assertion, so a capture whose board does not
 * match the declared state FAILS the test — loudly, naming sport and state —
 * rather than writing a misleading PNG. It runs before the 320 measurement AND
 * again before every width's screenshot, which is what makes a cross-width
 * disagreement structurally impossible to write silently.
 */
type StateProbe = () => Promise<void>;

/**
 * Every event row the PAD itself has rendered — the client-side fold, which is
 * the thing that lags. Deliberately spans both lanes: `[data-role=
 * "v3-activity-row"]` (v3 ActivityPanel) and `[data-role="timeline"]
 * [data-event-id]` (the legacy `Timeline` pad-renderer.tsx mounts for the nine
 * unconverted sports), so ONE probe is honest for all twelve captures.
 *
 * Scoped to the pad root, never the page: the fixture console mounts its OWN
 * `<Timeline>` outside the pad as well, and a page-wide count would double
 * every row. `[data-role="pad-v3"]` is the second anchor because the
 * device-link route carries no `data-testid="score-pad"` (that testid is
 * minted only by fixture-console.tsx — this file's own 05-devicelink note).
 * `.first()` takes the console's outer `score-pad` when both match, since a
 * locator resolves in DOM order and that element wraps the v3 root.
 */
function padEventRows(page: Page) {
  return page
    .locator('[data-testid="score-pad"], [data-role="pad-v3"]')
    .first()
    .locator('[data-role="v3-activity-row"], [data-role="timeline"] [data-event-id]');
}

/** The pad has caught up with the server: it renders at least `minEvents`
 *  rows. `minEvents` is the ledger count the harness itself read after the
 *  transition, so this is a real client-vs-server comparison rather than a
 *  "some rows exist" check that `02-live` would already satisfy at `01-pre`.
 *  `>=`, not `===`: a soft-committed tap is rendered optimistically before it
 *  is sent, so the pad legitimately runs AHEAD of the ledger inside a hold
 *  window (football's `04-dock` is exactly that case). */
function foldedProbe(page: Page, minEvents: number, what: string): StateProbe {
  return async () => {
    await expect
      .poll(async () => padEventRows(page).count(), { timeout: 20_000, message: what })
      .toBeGreaterThanOrEqual(minEvents);
  };
}

/** A declared state whose proof is "this element is on screen" — the shape
 *  every `captureExtra` state and the device-link capture take. */
function visibleProbe(locator: Locator, what: string): StateProbe {
  return async () => {
    await expect(locator, what).toBeVisible({ timeout: 20_000 });
  };
}

interface Measurement320 {
  state: GalleryState | ExtraGalleryState;
  scrollWidth: number;
  clientWidth: number;
  overflowPx: number;
  /**
   * Rendered pad-event rows per captured width — the machine-readable record
   * the fold-race finding says was missing. The probe above already fails a
   * disagreement, so these numbers should always agree; recording them is what
   * lets a later reader PROVE the widths agreed for a sheet already published,
   * instead of taking the run's word for it.
   */
  padRowsByWidth: Record<string, number>;
}

/**
 * Screenshots one state at each of `ACTIVE_WIDTHS` into `dir` (768/1280
 * this wave, per the `GALLERY_WIDTHS` override above; 320/768/1280 by
 * default). The 320px scrollWidth/clientWidth overflow measurement (debt
 * Tasks 6 and 8 deferred here — see docs/runbooks/pad-gallery.md) runs
 * UNCONDITIONALLY, before and independent of the `ACTIVE_WIDTHS` loop — it
 * is a correctness gate (a genuine overflow fails the test here rather
 * than silently shipping a screenshot of a broken layout), not a capture,
 * and de-scoping the 320 PNG from the sign-off sheet must never also
 * de-scope this assertion.
 *
 * `fullPage: true` is deliberate (matches the design spec's own capture
 * recipe) even though it paints the sticky nav a second time mid-image on
 * a tall page — a known Chromium fullPage quirk with `position: sticky`
 * headers, not a product defect; noted once here and in the runbook so
 * nobody re-discovers it as a bug against a converted sport later.
 */
async function captureState(
  page: Page,
  dir: string,
  state: GalleryState | ExtraGalleryState,
  slug: string,
  measurements: Measurement320[],
  probe: StateProbe,
): Promise<void> {
  await page.setViewportSize({ width: 320, height: HEIGHTS[320] });
  // BEFORE the measurement, not after: 320 is the width the overflow gate
  // always runs on, so measuring a board that has not folded yet records a
  // meaningless `0` and calls it clean (see `StateProbe`).
  await probe();
  const { scrollWidth, clientWidth } = await measureScroll(page);
  const overflowPx = Math.max(0, scrollWidth - clientWidth);
  const padRowsByWidth: Record<string, number> = {};
  measurements.push({ state, scrollWidth, clientWidth, overflowPx, padRowsByWidth });
  // Deliberate console.log: the raw numbers are the whole point of this
  // measurement, and the wave gate reads them straight from the run's own
  // stdout as well as manifest.json.
  console.log(
    `[gallery] ${slug} ${state} @320: scrollWidth=${scrollWidth} clientWidth=${clientWidth} overflowPx=${overflowPx}`,
  );
  await expectNoHorizontalScroll(page);

  for (const width of ACTIVE_WIDTHS) {
    await page.setViewportSize({ width, height: HEIGHTS[width] });
    // A resize re-renders; the probe runs again so no width can write a PNG
    // of a board that is not the declared state. This is the whole fix for
    // the three-boards-from-one-state defect — assert per width, never sleep.
    await probe();
    padRowsByWidth[String(width)] = await padEventRows(page).count();
    await page.screenshot({
      path: join(dir, `${state}-${width}.png`),
      fullPage: true,
      animations: "disabled",
      timeout: 20_000,
    });
  }
}

interface GallerySport {
  slug: string;
  label: string;
  sportKey: string;
  variantKey: string;
  entrantKind?: "individual" | "team" | "pair";
  roster: (tag: string) => { home: RosterSlotSpec[]; away: RosterSlotSpec[] };
  /** ONE real UI tap sequence that records exactly one event. The driver
   *  polls for ledger growth after calling this — it does not need to. */
  scoreOne: (page: Page, fx: RosteredFixture, tag: string) => Promise<void>;
  /**
   * Opens a genuine multi-field entry panel and stops BEFORE confirming —
   * the legacy analogue of the v3 Detail Dock's pre-commit moment (design
   * spec §2.3: tap → durable queue immediately, enrichment is a separate,
   * non-blocking step). Returns false when today's pad has no distinct
   * detail-entry surface for this sport (a plain one-tap action, no
   * secondary panel) — the driver then reuses the "03-scored" capture for
   * "04-dock" too, which is the honest picture of today's UI, not a gap in
   * the harness.
   */
  openDock: (page: Page, fx: RosteredFixture, tag: string) => Promise<boolean>;
  /**
   * R3 — proof that `openDock`'s panel is STILL on screen, re-asserted before
   * every width of the `04-dock` capture (see `StateProbe`).
   *
   * Optional because eight of the nine legacy docks are a persistent expanded
   * form: once opened they cannot close on their own, so their `04-dock`
   * capture has nothing to race and the shared fold probe is the honest
   * assertion for them. FOOTBALL is the first sport whose dock is a TIMED
   * surface — the v3 Detail Dock closes itself `HOLD_MS` (6s) after the tap
   * that opened it — so a slow capture could otherwise photograph three
   * different things and record none of the difference. A sport declaring this
   * is saying "my dock can vanish; fail the capture rather than keep it".
   */
  dockProbe?: (page: Page) => Promise<void>;
  /**
   * R2b+ — optional wave-specific captures beyond the fixed five states
   * above, run on the SAME page immediately after 04-dock. Absent for
   * every sport untouched by such a wave, which leaves that sport's five-
   * state capture set byte-identical to before this hook existed (the
   * shared body only calls it when present, and never touches `EXTRA_
   * STATES`/`ACTIVE_WIDTHS` on its behalf). A hook drives whatever UI/API
   * sequence its wave's new surface needs — including seeding an entirely
   * separate fixture, when the PRIMARY fixture's state by this point in
   * the flow cannot also reach the new surface. R2b's cricket hook does
   * exactly this: by 04-dock, `scoreOne`'s six dot balls have already
   * locked the primary fixture's innings to "fine" (first-event-wins,
   * cricket.ts:661-678), and a coarse-innings tile is only reachable from
   * an innings that has never taken a ball. Returns the extra state names
   * it actually captured, in capture order, so manifest.json/index.html
   * stay honest if a future hook aborts partway (`openDock`'s own
   * boolean-return convention, generalised to a list).
   */
  captureExtra?: (
    page: Page,
    dir: string,
    tag: string,
    measurements: Measurement320[],
  ) => Promise<ExtraGalleryState[]>;
}

// ---------------------------------------------------------------------------
// R5 (2026-08-27) — the racquet family's BEFORE captures.
//
// Badminton, table tennis and volleyball share ONE component today
// (`racquetSkin.sports = ["volleyball","badminton","tabletennis"]`,
// v2/scorepad/skins/racquet-skin.tsx). These states are captured BEFORE R5
// converts them, deliberately: R3.5's reusable lesson is that the gallery is
// blind by omission of a STATE, not of a sport — R2 and R3 both signed off
// legitimately against a harness that could not render the screen carrying
// the defect — and R2c's standing instruction for R3-R7 is to ask, before
// publishing a sign-off sheet, which of the wave's changes is visible in the
// five shared states. None of these three is.
//
// Three defects, and each probe below is written so the conversion INVERTS
// its expectation rather than deleting it (R3.5: "deleting it stops the
// capture failing and does nothing to stop the defect returning"). Each one
// names its own flipping assertion inline.
//
//  * D-17 — WHO IS SERVING IS A PLACEHOLDER. racquet-skin.tsx's header
//    declares its `serving` field a deliberate placeholder ("—") because the
//    set-based kernel folded no serving fact (`SetBasedRally`'s own doc,
//    setbased/kernel.ts: "the set-based kernel holds no serving state ... so
//    the engine cannot name the receiver from what it stores"). Photographed
//    by `11-servingplaceholder`, on all three sports.
//
//  * D-7 — BELOW BAND 3 THE PAD SAYS NOTHING. The kernel keys only band 3
//    (`fidelityEntitlements: { 3: preset.rallyEntitlement }`, i.e.
//    "scoring.rally_by_rally"), and `view-model.ts` DROPS an action above the
//    org's band rather than locking it (`if (band === undefined || band >
//    ctx.band) return null`) — so an org without that entitlement gets a live
//    scoring pad with no rally control and no reason on screen. The
//    register's own BAD-03 evidence line, never photographed. `12-bandlimited`,
//    badminton only (BAD-03's own sport; the kernel is shared, so the same
//    screen is reachable on the other two).
//
//    NAMED `bandlimited`, NOT `bandzero`, and the difference is a real
//    finding: the defect register calls this "a free / band-0 org", but a
//    community org actually resolves to band TWO here. `resolveFidelityBand`
//    walks 0..3 and only breaks on a band that NAMES an entitlement the org
//    lacks; this kernel keys band 3 alone, so bands 0, 1 and 2 are all free.
//    What the free org therefore loses is the rally action only — the band-1
//    interruptions (sanctions, and on the other two sports timeouts/subs)
//    survive, so the screen is a Set score panel AND a Sanctions drawer, not
//    the "lone Set score button" the register describes.
//
//  * D-13 — TABLE TENNIS HAS NEVER BEEN DRIVEN IN A BROWSER beyond this
//    harness's single `scoreOne` tap (see this file's own tabletennis note:
//    "No e2e precedent exists anywhere in this repo for table tennis
//    specifically"). Its `11-servingplaceholder` taps real rallies in a real
//    browser past a 2-serve rotation boundary (`turnLength: 2`,
//    setbased/tabletennis.ts) — new coverage in itself.
//
// NOT TURN 0, EVER. R4's D-21 shipped a wrong human name live because
// `11-doublesserve` photographed service turn 0, and turn 0 names the right
// player under every derivation anyone has shipped, correct or not. Every
// serving capture below banks a whole game/set FIRST and then plays into the
// next one, so both the set-transition rule and (for table tennis) the
// within-game rotation have already had to fire.
// ---------------------------------------------------------------------------

/** racquet-skin.tsx's own placeholder glyph for the serving field — an EM
 *  dash (U+2014), deliberately NOT the EN dash (U+2013) `scoreline()` joins a
 *  score with. The two are one code point apart and look almost identical in
 *  a diff, so they are named here once rather than typed inline three times. */
const RACQUET_SERVING_PLACEHOLDER = "—";

/** The EN dash `scoreline()` (racquet-skin.tsx) joins a header score with —
 *  spelled as an escape so a reviewer can tell it apart from the EM dash
 *  placeholder above without reaching for a hex editor. */
function racquetScoreline(home: number, away: number): string {
  return `${home}\u2013${away}`;
}

/**
 * One field of racquet-skin.tsx's score header, addressed by its CAPTION
 * ("Sets" / "Points" / "Serving") rather than by index. `buildHeader` keys
 * each field div with `field.id`, but a React `key` is not a DOM attribute —
 * there is nothing else to hold on to — and a positional `.nth(2)` would go
 * on silently photographing the WRONG field the day a fourth field is added
 * or the order changes, which is the class of quiet mis-capture this whole
 * harness exists to make impossible.
 */
function racquetHeaderValue(page: Page, caption: string): Locator {
  return pad(page)
    .locator('[data-role="racquet-header"] > div > div')
    .filter({ hasText: caption })
    .locator("p")
    .first();
}

interface RacquetServingRecipe {
  slug: string;
  label: string;
  sportKey: string;
  variantKey: string;
  entrantKind?: "individual" | "team" | "pair";
  /**
   * WHICH PAD LANE this sport renders on today. R5/C1 converted badminton;
   * R5/C2 converts table tennis. Volleyball still renders `racquet-skin.tsx`
   * (v2) and its own entry below is byte-identical to the BEFORE run because
   * this field DEFAULTS to "v2" — a converting wave adds `lane: "v3"` to its
   * own sport and touches nothing else.
   *
   * The two lanes disagree about every locator in this recipe (v2 has a
   * `[data-role="racquet-header"]` with three captioned fields; v3 has a
   * scorebug with two halves and a strip) AND about the D-17 assertion, which
   * is the whole point: on v2 the serving field is still the em-dash
   * placeholder, and on v3 it must name the real server.
   */
  lane?: "v2" | "v3";
  /**
   * v3 lane only — the exact name the serving field must read after the three
   * rallies below. REQUIRED for a converted sport (asserted at run time, not
   * left optional-and-forgotten), because "not the placeholder" alone is a
   * far weaker statement than "this person": a pad that named the WRONG
   * player would satisfy the negative and is precisely R4's D-21.
   */
  expectedServer?: string;
  /**
   * R5/C2 — table tennis's own requirement, badminton never needed this.
   * `serve.within: "fixed-turns"` (ITTF 2.13.3) is a pure function of the
   * SCORE once the set's first server is known, and — unlike badminton's
   * side-out rotation — is NEVER updated by an individual rally's own
   * winner: `setBasedServeContext` answers `serveOrderKnown: false` FOREVER
   * on this sport until something declares who served one rally
   * (`packages/engine/src/sports/setbased/kernel.ts`'s own
   * `believedServer`). The FIRST of the three rallies below is therefore
   * routed through the skin's own `serveAnchor` tile + guided sheet (two
   * choice steps: who served, who won) instead of a plain tappable-half
   * click, naming the side that served it; the remaining two rallies tap the
   * scoreboard half exactly as every other recipe does. Absent (the default)
   * for every sport whose rotation self-heals from an ordinary tap.
   */
  declareServingAnchor?: "home" | "away";
  /** The kernel's FULLY QUALIFIED coarse event type, `${sportKey}.${preset.
   *  coarseEventType}` (setbased/kernel.ts:1560) — "badminton.game.summary",
   *  "tabletennis.game.summary", "volleyball.set.summary". The bare
   *  `coarseEventType` half is NOT an event type: the API answers a bare
   *  "game.summary" with 422 INVALID_EVENT, which is how this was found. */
  coarseType: string;
  /** A COMPLETED first game/set, posted as ONE summary before any rally
   *  touches it. It must be the set's first event: `applySummary`'s strict
   *  branch refuses a summary for a set that already has points ("this set is
   *  being scored rally-by-rally"). Between sets the two fidelities mix
   *  freely — which is exactly what this recipe needs and why the PRIMARY
   *  fixture cannot be reused (by the time `captureExtra` runs, `scoreOne`
   *  has already put a rally into set 1). */
  summary: { home: number; away: number };
  /** The scoreline the header must read afterwards. Asserted exactly, not
   *  merely "not 0-0": an exact expectation cannot pass vacuously against a
   *  locator that resolved to nothing, and it fails LOUDLY with the real
   *  value when a fold surprises us. */
  expectedSets: string;
  expectedPoints: string;
}

/**
 * `11-servingplaceholder` — the board mid-game with the serving field empty.
 *
 * Its own fixture, seeded live (`emitCoreStart: true`), because the primary
 * one is the wrong vehicle: `scoreOne` has already scored a rally into set 1
 * (so no summary can close it) and `openDock` has left the Set score panel
 * open on top of the board. Same reasoning, and the same fix, as R2b's
 * cricket over-tile hook.
 *
 * Three rallies are TAPPED in the browser rather than posted: for table
 * tennis those taps are D-13's whole point, and for all three they prove the
 * rally control is genuinely live at band 3 — which is what makes
 * `12-bandlimited` below a comparison and not just a different picture.
 */
async function captureRacquetServing(
  page: Page,
  dir: string,
  tag: string,
  measurements: Measurement320[],
  recipe: RacquetServingRecipe,
): Promise<ExtraGalleryState> {
  const svTag = `${tag}sv`;
  const fx = await seedRosteredFixture(page.request, {
    label: `Gallery ${recipe.label} Serving ${svTag}`,
    sportKey: recipe.sportKey,
    variantKey: recipe.variantKey,
    entrantKind: recipe.entrantKind,
    home: [{ fullName: `Gallery ${recipe.slug} SV Home ${svTag}` }],
    away: [{ fullName: `Gallery ${recipe.slug} SV Away ${svTag}` }],
    emitCoreStart: true,
  });
  // Bank game/set 1 by summary — one event, and the set-transition rule the
  // serving derivation has to get right has now fired at least once.
  await postEvent(page.request, fx.fixtureId, recipe.coarseType, recipe.summary);

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page), `gallery(${recipe.slug}): the serving fixture must render a pad`).toBeVisible({
    timeout: 20_000,
  });
  // Home, away, home — 3 points into the SECOND game. Three, not one: table
  // tennis rotates the serve every 2 points (`turnLength: 2`), so a third
  // point is what puts the capture on the far side of a rotation boundary
  // instead of on it. The same three taps leave badminton and volleyball
  // (serve follows the rally winner) equally past their own first handover.
  const lane = recipe.lane ?? "v2";
  for (const [index, side] of (["home", "away", "home"] as const).entries()) {
    const before = await ledgerCount(page.request, fx.fixtureId);
    if (index === 0 && recipe.declareServingAnchor !== undefined) {
      // Table tennis's own requirement (`RacquetServingRecipe.
      // declareServingAnchor`'s own doc) — the FIRST rally is routed through
      // the `serveAnchor` tile + its two-step guided sheet instead of a
      // plain tap, because this sport's rotation cannot resolve at all
      // without a declaration.
      await pad(page).locator('[data-tile-id="serveAnchor"]').click();
      const sheet = pad(page).locator('[data-role="v3-sheet"]');
      await expect(sheet, `gallery(${recipe.slug}): the serve anchor sheet must open`).toBeVisible({ timeout: 20_000 });
      await sheet.locator(`[data-choice-option-id="${recipe.declareServingAnchor}"]`).click();
      await sheet.locator(`[data-choice-option-id="${side}"]`).click();
    } else if (lane === "v3") {
      // v3: tap model S — the scoreboard HALF is the rally button, and its
      // accessible name is the player's own name plus hint text, so it can
      // only be addressed positionally.
      await v3Half(page, side).click();
    } else {
      // v2: SideTapAction's own Home/Away buttons (racquet-skin.tsx), which
      // only exist at band 3.
      await pad(page)
        .getByRole("button", { name: side === "home" ? "Home" : "Away", exact: true })
        .click();
    }
    await waitForLedgerGrowth(page.request, fx.fixtureId, before);
  }

  // The same three facts, addressed per lane. v2 reads three captioned fields
  // off `[data-role="racquet-header"]`; v3 reads the strip's games item, the
  // two halves' own score readouts, and the strip's server item.
  const [expectedHomePoints, expectedAwayPoints] = recipe.expectedPoints.split("\u2013");
  const sets =
    lane === "v3" ? pad(page).locator('[data-strip-item-id="games"]') : racquetHeaderValue(page, "Sets");
  const serving =
    lane === "v3" ? pad(page).locator('[data-strip-item-id="server"]') : racquetHeaderValue(page, "Serving");
  const probe: StateProbe = async () => {
    // PRECONDITION, not the defect — this pair does NOT flip at conversion.
    // It is what stops this capture degenerating into R4's D-21: a banked
    // game/set AND a current game away from 0-0, so no derivation can be
    // right here by accident of being asked at turn 0.
    await expect(
      sets,
      `gallery(${recipe.slug}): 11-servingplaceholder needs a BANKED game/set (${recipe.expectedSets})`,
    ).toContainText(recipe.expectedSets, { timeout: 20_000 });
    if (lane === "v3") {
      await expect(
        v3HalfScore(page, "home"),
        `gallery(${recipe.slug}): 11-servingplaceholder must be MID-game, never turn 0`,
      ).toHaveText(expectedHomePoints!, { timeout: 20_000 });
      await expect(v3HalfScore(page, "away")).toHaveText(expectedAwayPoints!, { timeout: 20_000 });
      // ===== D-11, ASSERTED RATHER THAN ASSUMED. The v2 lane stated the score
      // THREE times above the fold — the fixture header, the LCD panel, and
      // the SETS/POINTS board — and the single v3 scorebug retires two of
      // them. Left unasserted, that retirement would be something a reviewer
      // has to notice in a screenshot; here it fails the run instead.
      //
      // Structural first: the v2 board is gone outright, and exactly one
      // scorebug replaces it.
      const scorebug = pad(page).locator('[data-role="v3-scorebug"]');
      await expect(
        pad(page).locator('[data-role="racquet-header"]'),
        `gallery(${recipe.slug}): D-11 — the v2 SETS/POINTS board must be gone, not rendered beside the scorebug`,
      ).toHaveCount(0, { timeout: 20_000 });
      await expect(
        scorebug,
        `gallery(${recipe.slug}): D-11 — exactly one scorebug states the score`,
      ).toHaveCount(1, { timeout: 20_000 });
      // Then textually, which is the half a structural check cannot see: each
      // side's current points appear ONCE inside it. The strip beside them
      // carries GAMES (a different fact, `1\u20130`), never a second copy of
      // the points — so a skin that put the points back on the strip reds here.
      for (const value of [expectedHomePoints!, expectedAwayPoints!]) {
        await expect(
          scorebug.getByText(value, { exact: true }),
          `gallery(${recipe.slug}): D-11 — "${value}" must be stated once above the fold, not twice`,
        ).toHaveCount(1, { timeout: 20_000 });
      }
    } else {
      await expect(
        racquetHeaderValue(page, "Points"),
        `gallery(${recipe.slug}): 11-servingplaceholder must be MID-game (${recipe.expectedPoints}), never turn 0`,
      ).toHaveText(recipe.expectedPoints, { timeout: 20_000 });
    }
    // ===== D-17. THIS IS THE ASSERTION A CONVERSION INVERTS — never deletes.
    //
    // v2 (table tennis, volleyball — still unconverted): the header prints an
    // em dash where the server belongs. That is the defect, photographed. When
    // those two waves land, add `lane: "v3"` + `expectedServer` to their own
    // recipes and this branch stops applying to them, exactly as it just
    // stopped applying to badminton. Do not delete the branch: a deleted probe
    // stops the capture failing and does nothing to stop the placeholder
    // coming back on the sport that still has it.
    //
    // v3 (badminton, R5): INVERTED. The field must not be the placeholder AND
    // must name the real server. Both halves matter — "not an em dash" alone
    // is satisfied by a confidently WRONG name, which is R4's D-21 exactly.
    if (lane === "v3") {
      const expectedServer = recipe.expectedServer;
      if (expectedServer === undefined) {
        throw new Error(`gallery(${recipe.slug}): a v3-lane serving recipe must declare expectedServer`);
      }
      await expect(
        serving,
        `gallery(${recipe.slug}): D-17 — the serving field must no longer be the placeholder`,
      ).not.toHaveText(RACQUET_SERVING_PLACEHOLDER, { timeout: 20_000 });
      await expect(
        serving,
        `gallery(${recipe.slug}): D-17 — and it must name the real server, not merely something`,
      ).toContainText(expectedServer, { timeout: 20_000 });
    } else {
      await expect(
        serving,
        `gallery(${recipe.slug}): D-17 — the serving field must still be the placeholder here`,
      ).toHaveText(RACQUET_SERVING_PLACEHOLDER, { timeout: 20_000 });
    }
  };

  await captureState(page, dir, "11-servingplaceholder", recipe.slug, measurements, probe);
  return "11-servingplaceholder";
}

/**
 * `12-bandlimited` (D-7) — the same live badminton pad, for an org that does not
 * hold `scoring.rally_by_rally`.
 *
 * The lever is the org's PLAN, flipped to community and restored in a
 * `finally`: that is literally the org the defect is about, and it exercises
 * the real plan matrix rather than a staff-deny override. It is restored
 * before this hook returns because the shared body mints a device link
 * afterwards and device links are Pro-only.
 *
 * NO cache invalidation on purpose. `invalidateOrgEntitlements` exists for
 * Redis-backed targets, and it works by flipping the org OWNER to superadmin
 * and back — a side effect on the very account the next four captures are
 * taken as. Local and CI have no Redis (`cache.ts`'s `client()` returns null,
 * so `cacheGet` is inert), which is where the runbook already says to run
 * this harness; against a Redis-backed target this state's probe FAILS,
 * loudly and by name, rather than photographing a band-3 board and calling it
 * band-limited. A loud wrong-environment failure is the honest outcome here.
 */
async function captureRacquetBandLimited(
  page: Page,
  dir: string,
  tag: string,
  measurements: Measurement320[],
): Promise<ExtraGalleryState> {
  const bzTag = `${tag}bz`;
  // Seeded (and started) while the org is still Pro: a community org has
  // lower creation caps, and none of that is what this state is about.
  const fx = await seedRosteredFixture(page.request, {
    label: `Gallery Badminton BandLimited ${bzTag}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: `Gallery Badminton BZ Home ${bzTag}` }],
    away: [{ fullName: `Gallery Badminton BZ Away ${bzTag}` }],
    emitCoreStart: true,
  });
  const org = await activeOrg(page);
  try {
    await setOrgPlanBySql({ orgId: org.id }, "community");
    await page.goto(await fixturePath(page.request, fx.fixtureId));
    await expect(pad(page), "gallery(badminton): 12-bandlimited must render a pad").toBeVisible({
      timeout: 20_000,
    });

    // R5 — RE-POINTED AT THE v3 DOM, and INVERTED. Badminton renders
    // `v3/skins/badminton.tsx` now, so every locator below moved: the v2 lane's
    // panel HEADINGS became tiles carrying `data-tile-id`, and the amber
    // `renderLockedTile` path (skins/shared.tsx) does not exist in v3 at all —
    // `filterTilesByBand` DROPS an above-band tile rather than locking it, so
    // the skin itself has to author the notice. What each assertion means is
    // unchanged; only where it looks, and which way round it reads.
    //
    // The rally affordance, band-limited: the skin's own disabled tile
    // (`RALLY_LOCKED_TILE_ID`). At band 3 this tile does not exist and the two
    // scoreboard halves are real buttons instead.
    const rallyGroup = pad(page).locator('[data-tile-id="rallyLocked"]');
    const setScoreGroup = pad(page).locator('[data-tile-id="setScore"]');
    // THE ENTITLEMENT PRECONDITION, RE-POINTED (R5). The v2 lane proved this
    // with the FidelitySwitcher's own `[data-band="3"]` chip being disabled —
    // but `RecordingChip` REPLACES that four-button picker the moment a sport
    // converts (recording-chip.tsx's own doc), so on a v3 pad `[data-band]`
    // does not exist at all and the old locator silently found nothing.
    //
    // The chip's equivalent, and it is a tighter statement rather than a
    // looser one: the collapsed pill states the ACTIVE band in words ("Full
    // timeline" — band 2, which is what a community org actually resolves to
    // on this kernel, NOT band 0: `resolveFidelityBand` breaks only on a band
    // that NAMES a missing entitlement and this kernel keys band 3 alone), and
    // it carries `aria-expanded` ONLY when a next tier exists AND is genuinely
    // locked. So the attribute's mere presence IS "this org lacks
    // scoring.rally_by_rally", read off the control the scorer can actually
    // see. Deliberately not clicked open: `probe()` re-runs once per captured
    // width, and a toggle would close what the previous width opened.
    const recordingChip = pad(page).getByRole("button", { name: "Full timeline", exact: true });
    // The skin's own worded reason, on the context strip
    // (`ContextSlot.message`, rendered verbatim by context-strip.tsx with a
    // stable `data-role`). This REPLACES the v2 lane's `scorepad.locked.reason`
    // string, which was never reachable for a band gap in the first place.
    const lockedReason = pad(page).locator('[data-role="context-slot-message"][data-slot-id="recording"]');
    const probe: StateProbe = async () => {
      // PRECONDITIONS, not the defect. Neither flips.
      //  (a) The band-0 summary action survives, so this is a real, rendered,
      //      LIVE pad and not a blank or failed page.
      //  (b) The band-3 chip is locked — which is what makes the rally
      //      affordance below attributable to the ENTITLEMENT. Without it this
      //      probe would pass just as happily against a pad that rendered its
      //      rally control for some entirely unrelated reason, and would
      //      photograph that instead while claiming D-7.
      await expect(
        setScoreGroup,
        "gallery(badminton): 12-bandlimited must still be a live pad — the band-0 summary survives",
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        recordingChip,
        "gallery(badminton): 12-bandlimited needs the org to actually LACK scoring.rally_by_rally",
      ).toHaveAttribute("aria-expanded", "false", { timeout: 20_000 });
      // ===== D-7, INVERTED (R5). The BEFORE run pinned this screen as
      // SILENCE: `toHaveCount(0)` on both — no rally affordance anywhere, and
      // no sentence explaining why, with the only signal a hover-only `title`
      // on a DIFFERENT control (the fidelity chip's
      // `scorepad.fidelity.locked`, unreachable on the phone this pad is built
      // for). Both lines are inverted here rather than deleted: a deleted
      // probe stops the capture failing and does nothing to stop the silence
      // coming back.
      //
      // The rally tile is present AND still genuinely untappable — asserting
      // presence alone would pass against a pad that had simply been handed
      // the entitlement, which is not the fix.
      await expect(
        rallyGroup,
        "gallery(badminton): D-7 — below band 3 the rally affordance must be VISIBLE, not silently absent",
      ).toHaveCount(1, { timeout: 20_000 });
      await expect(
        rallyGroup,
        "gallery(badminton): D-7 — visible, but never tappable: the org still lacks the entitlement",
      ).toBeDisabled({ timeout: 20_000 });
      await expect(
        lockedReason,
        "gallery(badminton): D-7 — and a VISIBLE sentence must now explain why",
      ).toBeVisible({ timeout: 20_000 });
      // Worded in badminton's own vocabulary and naming a real plan — not a
      // padlock glyph, and not a band number a scorer has no use for.
      await expect(
        lockedReason,
        "gallery(badminton): D-7 — the sentence must name the plan that unlocks it",
      ).toContainText("Pro", { timeout: 20_000 });
    };

    await captureState(page, dir, "12-bandlimited", "badminton", measurements, probe);
    return "12-bandlimited";
  } finally {
    // Device links (05-devicelink, minted by the shared body right after this
    // hook returns) are Pro-only.
    await setOrgPlanBySql({ orgId: org.id }, "pro");
  }
}

const SPORTS: GallerySport[] = [
  {
    slug: "cricket",
    label: "Cricket (T20)",
    sportKey: "cricket",
    variantKey: "t20",
    // THREE home batters, not two: a caught dismissal one wicket short of
    // the batting order's OWN length auto-closes the innings
    // (scoring-vocab-labels.spec.ts's own "a two-man order would close the
    // innings" reasoning) — this harness needs it to STAY open through
    // `openDock` below. TWO away players: the context-strip proof (see
    // `scoreOne`) needs a real second bowler to change TO.
    roster: (tag) => ({
      home: [
        { fullName: `Gallery Cricket Striker ${tag}` },
        { fullName: `Gallery Cricket NonStriker ${tag}` },
        { fullName: `Gallery Cricket Incoming ${tag}` },
      ],
      away: [{ fullName: `Gallery Cricket Bowler ${tag}` }, { fullName: `Gallery Cricket Fielder ${tag}` }],
    }),
    // R2/task F1 — moved onto the v3 surface (V3_SKINS.cricket) and
    // re-verified live: scorepad-skins.spec.ts "cricket skin: real roster, a
    // couple of balls scored" (defaults resolve without any context-strip
    // tap) and scorepad-v3-cricket.spec.ts (the context-change + full-over +
    // wicket flow this harness now mirrors). §2.4's context strip and
    // §2.5's wicket sheet are this wave's two product claims for cricket —
    // a gallery showing neither is not a sign-off, so this drives both
    // rather than stopping at a plain run tap the way the R1 baseline did.
    //
    // The context strip only renders once an innings exists (`buildContext`,
    // v3/skins/cricket.tsx, requires `currentInnings() !== null`, which
    // `cricket.ts` creates lazily inside ball 1's own fold) AND the bowler
    // can only legally CHANGE at an over boundary (`applyDelivery`'s
    // "over in progress belongs to X" check, mid-over) — so this taps out a
    // full over on defaults first (six dot balls, T20's own `ballsPerOver`),
    // THEN changes the bowler (valid AND necessary there: the naive default
    // would repeat over 1's own bowler, which the engine rejects outright as
    // "cannot bowl consecutive overs" — full reasoning in
    // scorepad-v3-cricket.spec.ts's own comment on the identical shape).
    //
    // R1's own wicket wedge: this harness previously stopped at a plain run
    // tap because "a wicket-completion attempt wedged the page during the
    // session that captured the baseline gallery" — that was against the
    // LEGACY pad's hand-rolled `ThisOverGroup` (skins/cricket-skin.tsx), a
    // structurally different code path from the v3 guided sheet driven here
    // (v3/guided-sheet.tsx, a generic chassis primitive shared with every
    // other sheet-shaped flow in this wave, already exercised live by
    // scorepad-v2.spec.ts's own wicket test). NOT independently re-verified
    // live in this session (no server available — static implementation
    // only); if the wedge recurs here, it is a NEW finding against the v3
    // renderer, not a repeat of the R1-era one, and should be diagnosed as
    // such rather than assumed to be the same bug.
    scoreOne: async (page, fx, tag) => {
      let before = await ledgerCount(page.request, fx.fixtureId);
      for (let i = 0; i < 6; i++) {
        await pad(page).getByRole("button", { name: "0", exact: true }).click();
        await waitForLedgerGrowth(page.request, fx.fixtureId, before);
        before += 1;
      }
      const strip = pad(page).locator('[data-role="context-strip"]');
      // Chip accessible name is compound (`"Bowler: <name>"`, chipLabel in
      // context-strip.tsx) the instant a bowler is resolved — which it always
      // is here (resolvePeople's own bowlingOrder[0] default). A bare
      // `exact: true` match on the label alone matches nothing and hangs for
      // this test's whole `test.setTimeout(180_000)` budget (R2 review
      // finding — the identical bug scorepad-v3-cricket.spec.ts's own
      // `setContextPerson` had) — matched as a name PREFIX instead, anchored
      // so it can never also satisfy a differently-labelled chip.
      //
      // Left unguarded by a `.catch(() => false)`, unlike every `openDock`
      // step below: `openDock` is genuinely optional per sport (a sport with
      // no distinct detail panel just returns false), but changing the
      // bowler here is the one context-strip pick this flow cannot skip —
      // the naive default for over 2 is over 1's own bowler, which the
      // engine rejects outright as "cannot bowl consecutive overs" (this
      // sport's own `scoreOne` header comment). A failure here means the
      // capture genuinely did not reach a valid "03-scored" state and should
      // fail loudly, the same posture every OTHER sport's unguarded
      // `scoreOne` already takes.
      await strip.getByRole("button", { name: /^Bowler(:|$)/ }).click();
      await strip.getByRole("button", { name: `Gallery Cricket Fielder ${tag}`, exact: true }).click();

      await pad(page).getByRole("button", { name: "Wicket", exact: true }).click();
      const sheet = pad(page).locator('[data-role="v3-sheet"]');
      await sheet.getByRole("button", { name: "Caught", exact: true }).click();
      await sheet.getByRole("button", { name: `Gallery Cricket Bowler ${tag}`, exact: true }).click();
      // Waited out explicitly (not left to the driver's own post-`scoreOne`
      // poll): that poll only checks ledger count > beforeScore, which the
      // six over-1 balls above already satisfy — leaving it unwaited would
      // make "03-scored" a race between this dismissal's own ~6s soft-commit
      // hold (queue.ts's HOLD_MS) and whenever the driver happens to
      // screenshot, instead of the settled post-wicket state every other
      // sport's single-dispatch `scoreOne` gets for free.
      await waitForLedgerGrowth(page.request, fx.fixtureId, before);
    },
    // The wicket sheet again, on a DIFFERENT step than `scoreOne` completed
    // (kind -> "Run out", which asks "who's out" before it would ask
    // "fielder" — VARIABLE_OUT_KINDS, v3/skins/cricket.tsx) — stopped before
    // picking a batter, so nothing submits. Two of the three home batters
    // remain not-out after `scoreOne`'s own dismissal (see the roster
    // comment above), so this sheet has real candidates to show.
    openDock: async (page) => {
      const wicket = pad(page).getByRole("button", { name: "Wicket", exact: true });
      if (!(await wicket.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await wicket.click();
      const sheet = pad(page).locator('[data-role="v3-sheet"]');
      const runOut = sheet.getByRole("button", { name: "Run out", exact: true });
      if (!(await runOut.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await runOut.click();
      return true;
    },
    // R2b (task 10, this wave's own two new sign-off screens): 06-overtile
    // and 07-oversheet. The gate this proves is BIDIRECTIONAL and can only
    // be shown from an innings whose FIRST-EVER event is a
    // `cricket.innings.summary` (R2b plan doc, "What the scout re-pinned"
    // §1-2; apps/web/e2e/scoring.spec.ts:226-240 is the existing API-post
    // precedent) — the primary fixture above is unusable for this by now,
    // since `scoreOne`'s six dot balls already locked ITS innings to
    // "fine" (ball-scored), which correctly hides the over tile entirely
    // (scorepad-v3-cricket.spec.ts:562-569's own assertion of that same
    // gate, the mirror image of what this capture needs to show). A
    // second, dedicated fixture is the only way to reach "coarse" at all.
    captureExtra: async (page, dir, tag, measurements) => {
      const otTag = `${tag}ot`;
      const fx2 = await seedRosteredFixture(page.request, {
        label: `Gallery Cricket OverTile ${otTag}`,
        sportKey: "cricket",
        variantKey: "t20",
        // FOUR home batters, not the two a striker/non-striker pair
        // suggests, and the reason is a live trap rather than a style
        // preference: all-out is derived from the SQUAD, not from
        // cfg.playersPerSide alone — `Math.min(cfg.playersPerSide,
        // order.length) - 1` (allOutWickets, cricket.ts:538-542). A
        // two-name home squad therefore makes all-out ONE wicket, so the
        // `wickets: 1` summary below is an all-out innings: `autoClose`
        // closes it, innings 2 falls due, and the pad correctly renders the
        // fresh-innings state where the over tile AND the ball tiles are
        // both legal — failing this hook's own "ball tiles must be gone"
        // assertion for a reason that has nothing to do with the gate it is
        // capturing. Four names put all-out at 3, clear of the 1 wicket the
        // capture posts. (Found 2026-08-17 by running this harness; the
        // e2e spec never saw it because it enters `wickets: 0` via the UI.)
        home: [
          { fullName: `Gallery Cricket OT Striker ${otTag}` },
          { fullName: `Gallery Cricket OT NonStriker ${otTag}` },
          { fullName: `Gallery Cricket OT Bat3 ${otTag}` },
          { fullName: `Gallery Cricket OT Bat4 ${otTag}` },
        ],
        away: [{ fullName: `Gallery Cricket OT Bowler ${otTag}` }],
        // API-driven start (no UI tap needed) — this hook is not
        // re-demonstrating "Start match", the primary fixture's 02-live
        // capture already does that for cricket.
        emitCoreStart: true,
      });

      // core.start took seq 0 above (seedRosteredFixture's own
      // emitCoreStart) — this summary is seq 1, and being the innings'
      // FIRST innings-scoped event, it is what locks the innings "coarse"
      // (`createInnings(...,"coarse")`, cricket.ts:1406) rather than
      // "fine" (only reachable via a `cricket.ball`, cricket.ts:2940).
      const summary = await apiJson<{ seq: number }>(
        page.request,
        `/api/v1/fixtures/${fx2.fixtureId}/events`,
        "POST",
        { expected_seq: 1, type: "cricket.innings.summary", payload: { runs: 7, wickets: 1, legalBalls: 6, partial: true } },
      );
      if (summary.status >= 300 || !summary.data) {
        throw new Error(
          `gallery(cricket): seed coarse summary -> ${summary.status} ${JSON.stringify(summary.error)}`,
        );
      }

      await page.goto(await fixturePath(page.request, fx2.fixtureId));
      const overTile = pad(page).locator('[data-tile-id="overSummary"]');
      await expect(overTile, "gallery(cricket): over tile must render on a coarse innings").toBeVisible({
        timeout: 20_000,
      });
      // The gate's other half, made visible in the SAME capture: a coarse
      // innings must not ALSO offer a ball tile (R2b Q1 owner ruling) — a
      // real absence check, `data-tile-id` is missing from the DOM
      // entirely when a skin's `tiles()` simply does not push it, not
      // merely CSS-hidden (see this repo's own e2e DOM-contract notes).
      await expect(
        pad(page).locator('[data-tile-id="run0"]'),
        "gallery(cricket): ball tiles must be gone on a coarse innings",
      ).not.toBeVisible();
      await captureState(
        page,
        dir,
        "06-overtile",
        "cricket",
        measurements,
        visibleProbe(overTile, "gallery(cricket): 06-overtile must still show the over tile"),
      );

      await overTile.click();
      const sheet = pad(page).locator('[data-role="v3-sheet"]');
      await expect(sheet, "gallery(cricket): tapping the tile must open the guided sheet").toBeVisible({
        timeout: 10_000,
      });
      // Left on step 1/3 ("Runs this over") and NOT confirmed — same
      // stop-before-commit posture every other sport's `openDock` takes
      // above. The field is a PER-OVER delta and opens at 0 (Q2 REVERSED
      // 2026-08-17, `_INDEX.md`), so what this capture has to show is the
      // "before" anchor: the fold's own 7/1, rendered verbatim above the
      // control (`SheetNumberStep.hint`, guided-sheet.tsx:374). That anchor
      // is the ONLY thing on screen telling the scorer what their delta is
      // being added to — if it ever stops rendering, the sheet still works
      // and still looks right, which is precisely why the gallery pins it.
      await expect(
        sheet.getByRole("spinbutton", { name: "Runs this over" }),
        "gallery(cricket): a per-over delta opens at 0, never carrying the fold forward",
      ).toHaveValue("0");
      await expect(sheet, "gallery(cricket): the before-anchor must render, or the delta has no context").toContainText(
        "7/1",
      );
      await captureState(
        page,
        dir,
        "07-oversheet",
        "cricket",
        measurements,
        visibleProbe(sheet, "gallery(cricket): 07-oversheet must still show the guided sheet"),
      );

      // --- R2c: a FINE innings with one complete over bowled, so the pad
      // sits at an over boundary with a genuinely ineligible bowler present.
      const fx3 = await seedRosteredFixture(page.request, {
        label: `Gallery cricket R2c ${TAG}`,
        sportKey: "cricket",
        variantKey: "t20",
        home: [{ fullName: `G R2c Striker ${TAG}` }, { fullName: `G R2c NonStriker ${TAG}` }],
        away: [{ fullName: `G R2c BowlerA ${TAG}` }, { fullName: `G R2c BowlerB ${TAG}` }],
        emitCoreStart: true,
      });
      for (let ball = 1; ball <= 6; ball++) {
        const res = await apiJson(page.request, `/api/v1/fixtures/${fx3.fixtureId}/events`, "POST", {
          expected_seq: ball,
          type: "cricket.ball",
          payload: {
            over: 0,
            ballInOver: ball,
            striker: fx3.personIds[`G R2c Striker ${TAG}`]!,
            nonStriker: fx3.personIds[`G R2c NonStriker ${TAG}`]!,
            bowler: fx3.personIds[`G R2c BowlerA ${TAG}`]!,
            runs: { bat: 0 },
          },
        });
        if (res.status >= 300) {
          throw new Error(`gallery(cricket): R2c seed ball ${ball} -> ${res.status} ${JSON.stringify(res.error)}`);
        }
      }
      await page.goto(await fixturePath(page.request, fx3.fixtureId));
      await expect(pad(page)).toBeVisible({ timeout: 20_000 });

      // 08 — the bowler picker OPEN. What the owner rules on: the list is the
      // fielding side only, and the bowler who just bowled is SHOWN with his
      // reason rather than silently missing.
      const strip = pad(page).locator('[data-role="context-strip"]');
      await strip.getByRole("button", { name: /^Bowler(:|$)/ }).click();
      await expect(
        strip.locator(`[data-candidate-id="${fx3.personIds[`G R2c BowlerA ${TAG}`]!}"]`),
        "gallery(cricket): the previous over's bowler must render blocked, not vanish",
      ).toHaveAttribute("data-blocked", "true");
      await captureState(page, dir, "08-bowlerpicker", "cricket", measurements, async () => {
        await expect(
          strip.locator(`[data-candidate-id="${fx3.personIds[`G R2c BowlerA ${TAG}`]!}"]`),
          "gallery(cricket): 08-bowlerpicker must still show the blocked bowler",
        ).toHaveAttribute("data-blocked", "true");
      });

      // 09 — the Retire sheet, a tile again (R2c amendment to defect 4).
      await page.goto(await fixturePath(page.request, fx3.fixtureId));
      await pad(page).locator('[data-tile-id="retire"]').click();
      await expect(
        pad(page).locator('[data-role="v3-sheet"]'),
        "gallery(cricket): the retire tile must open the skin's own sheet",
      ).toBeVisible({ timeout: 10_000 });
      await captureState(
        page,
        dir,
        "09-retiresheet",
        "cricket",
        measurements,
        visibleProbe(
          pad(page).locator('[data-role="v3-sheet"]'),
          "gallery(cricket): 09-retiresheet must still show the retire sheet",
        ),
      );

      // 10 — a review the engine would refuse, refused in the pad instead.
      const fx4 = await seedRosteredFixture(page.request, {
        label: `Gallery cricket R2c reviews ${TAG}`,
        sportKey: "cricket",
        variantKey: "t20",
        home: [{ fullName: `G RV Striker ${TAG}` }, { fullName: `G RV NonStriker ${TAG}` }],
        away: [{ fullName: `G RV Bowler ${TAG}` }],
      });
      const divRes = await apiJson<{ config: Record<string, unknown> }>(
        page.request,
        `/api/v1/divisions/${fx4.divisionId}`,
      );
      if (divRes.status !== 200 || !divRes.data) {
        throw new Error(`gallery(cricket): GET division -> ${divRes.status}`);
      }
      await setDivisionConfigSql(fx4.divisionId, { ...divRes.data.config, reviews: { perInnings: 1 } });
      const seeds: [string, Record<string, unknown>][] = [
        ["core.start", {}],
        [
          "cricket.ball",
          {
            over: 0,
            ballInOver: 1,
            striker: fx4.personIds[`G RV Striker ${TAG}`]!,
            nonStriker: fx4.personIds[`G RV NonStriker ${TAG}`]!,
            bowler: fx4.personIds[`G RV Bowler ${TAG}`]!,
            runs: { bat: 0 },
          },
        ],
        ["cricket.review", { by: fx4.homeEntrantId, kind: "player", outcome: "struck_down" }],
      ];
      for (let i = 0; i < seeds.length; i++) {
        const [type, payload] = seeds[i]!;
        const res = await apiJson(page.request, `/api/v1/fixtures/${fx4.fixtureId}/events`, "POST", {
          expected_seq: i,
          type,
          payload,
        });
        if (res.status >= 300) {
          throw new Error(`gallery(cricket): R2c review seed ${type} -> ${res.status} ${JSON.stringify(res.error)}`);
        }
      }
      await page.goto(await fixturePath(page.request, fx4.fixtureId));
      await pad(page).locator('[data-tile-id="review"]').click();
      const rvSheet = pad(page).locator('[data-role="v3-sheet"]');
      await expect(rvSheet).toBeVisible({ timeout: 10_000 });
      await rvSheet.locator('[data-choice-option-id="player"]').click();
      await rvSheet.getByRole("button", { name: "Upheld", exact: true }).click();
      await expect(
        rvSheet.locator(`[data-choice-option-id="${fx4.homeEntrantId}"]`),
        "gallery(cricket): the exhausted side must render blocked with its reason",
      ).toHaveAttribute("data-blocked", "true");
      await captureState(page, dir, "10-reviewblocked", "cricket", measurements, async () => {
        await expect(
          rvSheet.locator(`[data-choice-option-id="${fx4.homeEntrantId}"]`),
          "gallery(cricket): 10-reviewblocked must still show the exhausted side blocked",
        ).toHaveAttribute("data-blocked", "true");
      });

      // 11/12 (R3.5 Task A, 2026-08-26) — the super over the pad cannot yet
      // score, captured BEFORE Task C's fix (_RULES.md "capture the broken
      // state first"). `currentInnings` today reads `state.innings` alone,
      // so once both main innings are closed the skin cannot tell a LIVE
      // super over from a finished match — it disables every delivery tile
      // and shows the terminal-closure message over a super over that
      // already has real deliveries on the ledger. A fresh fixture: the
      // primary fixture and fx2-fx4 above are all on ordinary (non-super-
      // over) configs by now.
      const soTag = `${tag}so`;
      const fx5 = await seedRosteredFixture(page.request, {
        label: `Gallery Cricket SuperOver ${soTag}`,
        sportKey: "cricket",
        variantKey: "t20",
        home: [
          { fullName: `Gallery Cricket SO Home1 ${soTag}` },
          { fullName: `Gallery Cricket SO Home2 ${soTag}` },
        ],
        away: [
          { fullName: `Gallery Cricket SO Away1 ${soTag}` },
          { fullName: `Gallery Cricket SO Away2 ${soTag}` },
        ],
      });
      const so_h1 = fx5.personIds[`Gallery Cricket SO Home1 ${soTag}`]!;
      const so_h2 = fx5.personIds[`Gallery Cricket SO Home2 ${soTag}`]!;
      const so_a1 = fx5.personIds[`Gallery Cricket SO Away1 ${soTag}`]!;
      const so_a2 = fx5.personIds[`Gallery Cricket SO Away2 ${soTag}`]!;

      // Plan doc 2026-08-26 (Task A step 2), used verbatim: two one-run-a-
      // ball innings force-closed at two balls each ties the match 2-2
      // (target 3; away stops at EXACTLY target-1), then two live
      // super-over balls. `superOver` merged onto the division's EXISTING
      // config, never a bare object, or setDivisionConfigSql's verbatim
      // write drops every default the division was created with.
      await mergeDivisionConfig(page.request, fx5.divisionId, { superOver: true });
      await postEvent(page.request, fx5.fixtureId, "core.start", {});
      await postEvent(page.request, fx5.fixtureId, "cricket.ball", {
        over: 0, ballInOver: 1, striker: so_h1, nonStriker: so_h2, bowler: so_a1, runs: { bat: 1 },
      });
      await postEvent(page.request, fx5.fixtureId, "cricket.ball", {
        over: 0, ballInOver: 2, striker: so_h2, nonStriker: so_h1, bowler: so_a1, runs: { bat: 1 },
      });
      await postEvent(page.request, fx5.fixtureId, "cricket.innings.close", { reason: "other" });
      // target = 3; away scores exactly 2 => TIE => phase super_over.
      await postEvent(page.request, fx5.fixtureId, "cricket.ball", {
        over: 0, ballInOver: 1, striker: so_a1, nonStriker: so_a2, bowler: so_h1, runs: { bat: 1 },
      });
      await postEvent(page.request, fx5.fixtureId, "cricket.ball", {
        over: 0, ballInOver: 2, striker: so_a2, nonStriker: so_a1, bowler: so_h1, runs: { bat: 1 },
      });
      await postEvent(page.request, fx5.fixtureId, "cricket.innings.close", { reason: "other" });
      // Away bats first in the super over (they batted second); home bowls
      // with h2 — an arbitrary pick, not a forced one. `applySuperOverBall`
      // (cricket.ts:1536-1561) always opens a super-over innings on a FRESH
      // `fine` object (`freshFine()`, cricket.ts:683-698: `prevOverBowler:
      // null`, `bowlerBalls: {}`), so nothing carries over from the second
      // main innings h1 just bowled, and it passes `maxOversPerBowler:
      // undefined` too — neither the "cannot bowl consecutive overs" gate
      // nor the per-bowler quota (applyDelivery, cricket.ts:1201-1212) can
      // fire on this ball. h1 would have been accepted exactly as legally.
      await postEvent(page.request, fx5.fixtureId, "cricket.superover.ball", {
        over: 0, ballInOver: 1, striker: so_a1, nonStriker: so_a2, bowler: so_h2, runs: { bat: 4 }, boundary: 4,
      });
      await postEvent(page.request, fx5.fixtureId, "cricket.superover.ball", {
        over: 0, ballInOver: 2, striker: so_a1, nonStriker: so_a2, bowler: so_h2, runs: { bat: 2 },
      });

      await page.goto(await fixturePath(page.request, fx5.fixtureId));
      await expect(pad(page)).toBeVisible({ timeout: 20_000 });
      const soRunTile = pad(page).locator('[data-tile-id="run0"]');
      const soClosureMessage = pad(page).locator(
        '[data-role="context-strip"] [data-role="context-slot-message"][data-slot-id="bowler"]',
      );
      // Task A captured this state with the DEFECT still in it, and pinned
      // the defect deliberately: `data-tile-disabled="true"` plus the closure
      // message, over a live super over with two real deliveries already on
      // the ledger. Those captures are the BEFORE half of this wave's
      // sign-off and are preserved in the published sheet.
      //
      // Task C fixed it (`activeInnings`, cricket.ts — the skin now reads the
      // super over's own innings instead of `state.innings`), so these probes
      // are now inverted to pin the CORRECTED behaviour. That inversion is
      // the point: had the probes merely been deleted, nothing would stop the
      // defect returning. Read together with the before-captures, this state
      // is the pair the merge gate is judged on.
      await captureState(page, dir, "11-superover", "cricket", measurements, async () => {
        await expect(
          soRunTile,
          "gallery(cricket): 11-superover delivery tiles must be ENABLED — a super over is live play",
        ).toHaveAttribute("data-tile-disabled", "false");
        await expect(
          soClosureMessage,
          "gallery(cricket): 11-superover must NOT claim the innings is closed while a super over is being bowled",
        ).toHaveCount(0);
        await expect(
          pad(page).locator('[data-role="v3-scorebug"]'),
          "gallery(cricket): 11-superover scorebug must read the SUPER OVER (6/0 off 0.2), not the closed innings",
        ).toContainText("6/0");
      });

      // 12 — continue the SAME fixture to a decision: four more away balls
      // close super-over innings 1 at 6/0 (target 7 for the reply), then
      // home falls three runs short at 3/0 — an ordinary finish on the
      // sixth ball, not a wicket (`allOut: 2` for a super over is not
      // exercised here). Striker/non-striker are spelled out per ball to
      // match how a real scorer would file the card (odd runs flip strike),
      // though the fold trusts the named pair per ball rather than
      // re-deriving rotation itself (applyDelivery's non-strict-order
      // branch for a super over).
      for (const ballInOver of [3, 4, 5, 6]) {
        await postEvent(page.request, fx5.fixtureId, "cricket.superover.ball", {
          over: 0, ballInOver, striker: so_a1, nonStriker: so_a2, bowler: so_h2, runs: { bat: 0 },
        });
      }
      await postEvent(page.request, fx5.fixtureId, "cricket.superover.ball", {
        over: 0, ballInOver: 1, striker: so_h1, nonStriker: so_h2, bowler: so_a1, runs: { bat: 1 },
      });
      await postEvent(page.request, fx5.fixtureId, "cricket.superover.ball", {
        over: 0, ballInOver: 2, striker: so_h2, nonStriker: so_h1, bowler: so_a1, runs: { bat: 1 },
      });
      await postEvent(page.request, fx5.fixtureId, "cricket.superover.ball", {
        over: 0, ballInOver: 3, striker: so_h1, nonStriker: so_h2, bowler: so_a1, runs: { bat: 1 },
      });
      await postEvent(page.request, fx5.fixtureId, "cricket.superover.ball", {
        over: 0, ballInOver: 4, striker: so_h2, nonStriker: so_h1, bowler: so_a1, runs: { bat: 0 },
      });
      await postEvent(page.request, fx5.fixtureId, "cricket.superover.ball", {
        over: 0, ballInOver: 5, striker: so_h2, nonStriker: so_h1, bowler: so_a1, runs: { bat: 0 },
      });
      await postEvent(page.request, fx5.fixtureId, "cricket.superover.ball", {
        over: 0, ballInOver: 6, striker: so_h2, nonStriker: so_h1, bowler: so_a1, runs: { bat: 0 },
      });

      // Re-navigate (not merely re-polled) before reading the decided
      // state — every other fresh-state read in this file does the same
      // after a burst of page.request-driven setup, rather than trusting a
      // still-open page to pick up a decider that landed entirely outside
      // any UI tap.
      await page.goto(await fixturePath(page.request, fx5.fixtureId));
      // NOT `pad(page).locator('[data-role="v3-headline"]')` — the whole
      // `data-testid="score-pad"` section (v3-headline included) is gated
      // on `!decided` (fixture-console.tsx: `scorePadV2 && scoring &&
      // !decided && home && away`) and unmounts entirely once a match is
      // done. The SAME headline text moves to the console's own header
      // paragraph instead; the "Finalize (lock ledger)" button is gated
      // directly on `decided`, which is what this state is actually
      // proving, so it is the more precise anchor of the two.
      const soFinalize = page.getByRole("button", { name: "Finalize (lock ledger)", exact: true });
      await captureState(
        page,
        dir,
        "12-superover-decided",
        "cricket",
        measurements,
        visibleProbe(soFinalize, "gallery(cricket): 12-superover-decided must show the decided-match Finalize control"),
      );

      return [
        "06-overtile",
        "07-oversheet",
        "08-bowlerpicker",
        "09-retiresheet",
        "10-reviewblocked",
        "11-superover",
        "12-superover-decided",
      ];
    },
  },
  {
    slug: "football",
    label: "Football (11-a-side)",
    sportKey: "football",
    variantKey: "11-a-side",
    roster: (tag) => ({
      home: [
        { fullName: `Gallery Football Home ${tag}`, positionKey: "FW" },
        { fullName: `Gallery Football Home Keeper ${tag}`, positionKey: "GK" },
      ],
      away: [{ fullName: `Gallery Football Away Keeper ${tag}`, positionKey: "GK" }],
    }),
    // R3/task D — the v3 board. The tile ids are the skin's own
    // (`buildTiles`, v3/skins/football.tsx): `goal-<side>` / `card-<side>` /
    // `sub-<side>` / `period` / `penalty` / `more`. Addressed by
    // `data-tile-id` rather than by accessible name deliberately — a tile's
    // name is the concatenation of two LOCALISED strings ("Goal" + "Home"),
    // and this harness is a visual gate, not a copy gate.
    //
    // ONE TAP IS THE WHOLE ACTION: a v3 goal commits side-level on the tap
    // (`scorer`/`assist` are both optional on `FootballGoal`) and the dock
    // offers the attribution afterwards. There is no Confirm — the v2 control
    // this recipe used to click does not exist on the v3 pad, which is what
    // made every football capture past `02-live` time out.
    scoreOne: async (page) => {
      await pad(page).locator('[data-tile-id="goal-home"]').click();
    },
    // The Detail Dock IS football's `04-dock` state (design of record §2.3):
    // the ~6s enrichment window a scorer sees after a goal, with the own-goal/
    // penalty toggles and the scoring side's own scorer/assist chips. It is
    // reached by a second, AWAY goal rather than by reopening the first — the
    // dock is a property of a held tap and there is no way to reopen one that
    // has already flushed, which is exactly why `dockProbe` below exists.
    openDock: async (page) => {
      await pad(page).locator('[data-tile-id="goal-away"]').click();
      await expect(
        pad(page).locator('[data-role="v3-dock"]'),
        "gallery(football): a goal tap must open the detail dock",
      ).toBeVisible({ timeout: 10_000 });
      return true;
    },
    dockProbe: async (page) => {
      await expect(
        pad(page).locator('[data-role="v3-dock"]'),
        "gallery(football): the dock closed before this width was captured — the 6s hold " +
          "window elapsed mid-capture, so this PNG would have shown a different state to its siblings",
      ).toBeVisible({ timeout: 5_000 });
    },
    // R3.5 Task A (2026-08-26) captured this BEFORE Task D's fix (_RULES.md
    // "capture the broken state first"): `ScorebugHalf` had no `sub` field,
    // so the board kept rendering the frozen regulation score (`state.goals`)
    // while the headline above it already read the pens tally correctly —
    // one screen, two disagreeing readouts, exactly what design note D-11
    // exists to prevent.
    //
    // Task D FIXED it — `sub` now carries the pens tally beside `big`
    // (skins/football.tsx's `buildScorebug`, `shootoutTally`). The probe
    // below is INVERTED, never deleted (R3.5 false-premise #2, `_INDEX.md`):
    // deleting it would stop THIS capture failing but do nothing to stop the
    // defect returning, so it now pins the CORRECTED `1 (2)` / `1 (1)`
    // reading instead of the disagreement. A fresh, minimal fixture: every
    // event here is side-level (`by: entrantId`), the same one-outfield-
    // player-per-side shape scorepad-v3-football.spec.ts's own proven
    // shoot-out test uses.
    captureExtra: async (page, dir, tag, measurements) => {
      const shTag = `${tag}sh`;
      const fx = await seedRosteredFixture(page.request, {
        label: `Gallery Football Shootout ${shTag}`,
        sportKey: "football",
        variantKey: "11-a-side",
        home: [{ fullName: `Gallery Football SO Home ${shTag}`, positionKey: "FW" }],
        away: [{ fullName: `Gallery Football SO Away ${shTag}`, positionKey: "GK" }],
      });
      // `extraTime` is a plain z.object whose two fields are BOTH required,
      // defaulted only as a whole object — `{ enabled: false }` alone fails
      // the cfg parse, and because the division config is written by SQL
      // nothing validates it on the way in: the failure surfaces as the
      // console rendering no pad at all, which reads as a pad defect.
      await mergeDivisionConfig(page.request, fx.divisionId, {
        shootout: true,
        extraTime: { enabled: false, halfMinutes: 15 },
      });
      await postEvent(page.request, fx.fixtureId, "core.start", {});
      await postEvent(page.request, fx.fixtureId, "football.goal", { by: fx.homeEntrantId });
      await postEvent(page.request, fx.fixtureId, "football.goal", { by: fx.awayEntrantId });
      await postEvent(page.request, fx.fixtureId, "football.period", { phase: "HT" });
      await postEvent(page.request, fx.fixtureId, "football.period", { phase: "FT" });
      await postEvent(page.request, fx.fixtureId, "football.shootout.kick", { by: fx.homeEntrantId, scored: true });
      await postEvent(page.request, fx.fixtureId, "football.shootout.kick", { by: fx.awayEntrantId, scored: false });
      await postEvent(page.request, fx.fixtureId, "football.shootout.kick", { by: fx.homeEntrantId, scored: true });
      await postEvent(page.request, fx.fixtureId, "football.shootout.kick", { by: fx.awayEntrantId, scored: true });

      await page.goto(await fixturePath(page.request, fx.fixtureId));
      // NOT `[data-strip-tone="led"]`.first() — the "period" item carries
      // that tone in EVERY phase (buildScorebug, v3/skins/football.tsx:538-
      // 545 pushes it unconditionally, first, as the fourth official's
      // board), so a bare tone-selector probe stays visible at kickoff and
      // at half-time too and proves nothing about which board is on screen.
      // Anchor on the item's stable id instead and check its actual text —
      // `phaseLabel` renders the SHOOTOUT phase as "Shoot-out"
      // (dictionaries/en/ui.json's `pad.football.phase.SHOOTOUT`).
      const periodStrip = pad(page).locator('[data-strip-item-id="period"]');
      // Home leads 2-1 on kicks (four taken): kick(H,true), kick(A,false),
      // kick(H,true), kick(A,true) -> home scored twice, away once.
      // `data-half-sub` is the same stable hook __tests__/scorebug.test.ts's
      // B6/B7 cases and the e2e drive-through use — home's half reads `1 (2)`,
      // away's `1 (1)`, agreeing with the headline instead of repeating the
      // frozen 1-1 regulation score a second time.
      const homeSub = pad(page).locator("[data-half-sub]").first();
      const awaySub = pad(page).locator("[data-half-sub]").nth(1);
      await captureState(page, dir, "11-shootout", "football", measurements, async () => {
        await expect(
          periodStrip,
          'gallery(football): 11-shootout must show the "Shoot-out" strip',
        ).toContainText("Shoot-out", { timeout: 20_000 });
        await expect(
          homeSub,
          "gallery(football): 11-shootout must show home's pens tally beside the regulation score, not repeat it",
        ).toHaveText("(2)");
        await expect(
          awaySub,
          "gallery(football): 11-shootout must show away's pens tally beside the regulation score, not repeat it",
        ).toHaveText("(1)");
      });

      // 12 — three more kicks (home, away, home) decide it early: home's
      // 4th kick makes it 4 scored vs away's 1, a lead away's two remaining
      // kicks cannot close (shootoutDecision, packages/engine/src/sports/
      // period/shootout.ts) — an ordinary early finish, not sudden death.
      await postEvent(page.request, fx.fixtureId, "football.shootout.kick", { by: fx.homeEntrantId, scored: true });
      await postEvent(page.request, fx.fixtureId, "football.shootout.kick", { by: fx.awayEntrantId, scored: false });
      await postEvent(page.request, fx.fixtureId, "football.shootout.kick", { by: fx.homeEntrantId, scored: true });

      // Re-navigate before reading the decided state — every kick above was
      // posted via page.request, never a UI tap, so nothing on the still-
      // open page has a reason to have refetched on its own.
      await page.goto(await fixturePath(page.request, fx.fixtureId));
      // NOT `pad(page).locator('[data-role="v3-headline"]')` — the whole
      // `data-testid="score-pad"` section is gated on `!decided`
      // (fixture-console.tsx) and unmounts entirely once a match is done;
      // the headline text moves to the console's own header paragraph
      // instead. "Finalize (lock ledger)" is gated directly on `decided`,
      // which is what this state is actually proving.
      const decidedFinalize = page.getByRole("button", { name: "Finalize (lock ledger)", exact: true });
      await captureState(
        page,
        dir,
        "12-shootout-decided",
        "football",
        measurements,
        visibleProbe(decidedFinalize, "gallery(football): 12-shootout-decided must show the decided-match Finalize control"),
      );

      return ["11-shootout", "12-shootout-decided"];
    },
  },
  {
    slug: "tennis",
    label: "Tennis (tour)",
    sportKey: "tennis",
    variantKey: "tour",
    entrantKind: "individual",
    roster: (tag) => ({
      home: [{ fullName: `Gallery Tennis Home ${tag}` }],
      away: [{ fullName: `Gallery Tennis Away ${tag}` }],
    }),
    // R4 cutover — v3 tapModel S: the scoreboard half itself is the point
    // button (`tennisHalf` above), never a "Home"/"Away" tile.
    scoreOne: async (page) => {
      await tennisHalf(page, "home").click();
    },
    // Reached by a SECOND, away point rather than by reopening the first —
    // same reasoning as football's own `openDock` above: the Detail Dock is
    // a property of a held tap, and there is no way to reopen one that has
    // already flushed.
    openDock: async (page) => {
      await tennisHalf(page, "away").click();
      await expect(
        pad(page).locator('[data-role="v3-dock"]'),
        "gallery(tennis): a point tap must open the detail dock",
      ).toBeVisible({ timeout: 10_000 });
      return true;
    },
    // v3's Detail Dock is a TIMED surface (closes itself HOLD_MS=6s after
    // the tap that opened it) — same risk football's own dock carries, and
    // the same fix: fail the capture rather than silently keep a `04-dock`
    // photograph of a dock that already closed under a slow run.
    dockProbe: async (page) => {
      await expect(
        pad(page).locator('[data-role="v3-dock"]'),
        "gallery(tennis): the dock closed before this width was captured — the 6s hold " +
          "window elapsed mid-capture, so this PNG would have shown a different state to its siblings",
      ).toBeVisible({ timeout: 5_000 });
    },
    // R4 — 13-sanctionsheet. A fresh fixture (this entry's primary one is
    // already two points into a live match by now): the Code violation
    // sheet's own ladder — R4-4's tone treatment, `warning`/`default` toned,
    // the two middle steps plain — is what the owner rules on here, stopped
    // on its OPENING step (before picking a level), the same "stop before
    // commit" posture every other sport's `openDock` above takes.
    captureExtra: async (page, dir, tag, measurements) => {
      const shTag = `${tag}sh`;
      const fx = await seedRosteredFixture(page.request, {
        label: `Gallery Tennis Sanction ${shTag}`,
        sportKey: "tennis",
        variantKey: "tour",
        entrantKind: "individual",
        home: [{ fullName: `Gallery Tennis Sanction Home ${shTag}` }],
        away: [{ fullName: `Gallery Tennis Sanction Away ${shTag}` }],
        emitCoreStart: true,
      });
      await page.goto(await fixturePath(page.request, fx.fixtureId));
      await pad(page).locator('[data-tile-id="sanction-home"]').click();
      const sheet = pad(page).locator('[data-role="v3-sheet"]');
      await expect(sheet, "gallery(tennis): the sanction tile must open the skin's own sheet").toBeVisible({
        timeout: 10_000,
      });
      await expect(
        sheet.locator('[data-choice-option-id="warning"]'),
        "gallery(tennis): the four-rung ladder must be on screen, not just the sheet shell",
      ).toBeVisible();
      await captureState(
        page,
        dir,
        "13-sanctionsheet",
        "tennis",
        measurements,
        visibleProbe(sheet, "gallery(tennis): 13-sanctionsheet must still show the code-violation sheet"),
      );
      // 15-breakerdock — the tie-break's per-point serve handoff, on a
      // fixture with NO declared lineup. Both halves of that sentence are
      // load-bearing: the side-only ace/double-fault fallback runs ONLY when
      // there is no on-field roster to name a server person from, and
      // `state.serving` rotates mid-"game" ONLY inside a breaker. No other
      // tennis capture is in either state, let alone both.
      const tbTag = `${tag}tb`;
      const tb = await seedRosteredFixture(page.request, {
        label: `Gallery Tennis Breaker Dock ${tbTag}`,
        sportKey: "tennis",
        variantKey: "tour",
        entrantKind: "individual",
        home: [{ fullName: `Gallery Tennis TB Home ${tbTag}` }],
        away: [{ fullName: `Gallery Tennis TB Away ${tbTag}` }],
        emitCoreStart: true,
        skipLineups: true,
      });
      const tbRally = async (entrantId: string, points: number): Promise<void> => {
        for (let i = 0; i < points; i += 1) {
          await postEvent(page.request, tb.fixtureId, "tennis.point", { by: entrantId });
        }
      };
      // 6 games each, ALTERNATING, to reach 6-6 in ONE set — 24 straight
      // points to one side wins the whole set 6-0 instead, which is how the
      // first draft of this capture ended up photographing set 3 at 0-0.
      // At 6-6 the breaker opens; its first server is the set's own opener
      // (home, after an even 12 games), so home serves point 1 and away
      // serves points 2 AND 3. Two points are posted here, which makes the
      // point the CAPTURE itself taps the breaker's THIRD — the odd point,
      // the one at which `applyTbPoint` has already handed serve back to
      // home by the time this dock renders.
      for (let g = 0; g < 6; g += 1) {
        await tbRally(tb.homeEntrantId, 4);
        await tbRally(tb.awayEntrantId, 4);
      }
      await tbRally(tb.homeEntrantId, 1);
      await tbRally(tb.awayEntrantId, 1);
      await page.goto(await fixturePath(page.request, tb.fixtureId));
      // Away served point 3 and away wins it -> ACE is the only legal offer.
      await tennisHalf(page, "away").click();
      const tbDock = pad(page).locator('[data-role="v3-dock"]');
      await expect(tbDock, "gallery(tennis): a tie-break point tap must open the detail dock").toBeVisible({
        timeout: 10_000,
      });
      await expect(
        tbDock.getByRole("button", { name: "Ace", exact: true }),
        "gallery(tennis): away served AND won this tie-break point, so Ace must be offered",
      ).toBeVisible({ timeout: 4_000 }); // under HOLD_MS, so a miss is diagnosed with the dock still up
      await expect(
        tbDock.getByRole("button", { name: "Double fault", exact: true }),
        "gallery(tennis): offering Double fault here is the inverted-serve defect itself",
      ).toHaveCount(0);
      await captureState(page, dir, "15-breakerdock", "tennis", measurements, async () => {
        await expect(
          tbDock,
          "gallery(tennis): the dock closed before this width was captured",
        ).toBeVisible({ timeout: 5_000 });
        await expect(
          tbDock.getByRole("button", { name: "Ace", exact: true }),
          "gallery(tennis): 15-breakerdock must still show Ace, not Double fault",
        ).toBeVisible();
      });

      // 16-breakermore — same fixture, still inside the breaker. The
      // Award-game tile is withheld here (correctly), and this sheet is
      // where that withholding used to REAPPEAR as a generic form that
      // threw `GAME_AWARD_DURING_TIEBREAK` on tap.
      await pad(page).locator('[data-tile-id="more"]').click();
      const tbSheet = pad(page).locator('[data-role="v3-sheet"]');
      await expect(tbSheet, "gallery(tennis): the More tile must open the action sheet").toBeVisible({
        timeout: 10_000,
      });
      // Positive anchor FIRST. During a breaker every remaining tennis action
      // already has its own tile, so the correct More sheet lists nothing —
      // and a sheet that failed to render for some unrelated reason would
      // satisfy the negative below just as well. Pinning the empty-state copy
      // is what separates "rendered, and correctly has nothing to offer" from
      // "did not render".
      await expect(
        tbSheet,
        "gallery(tennis): the More sheet must have rendered its own empty state, not merely be absent",
      ).toContainText("Nothing else to record here yet");
      await expect(
        tbSheet,
        "gallery(tennis): a game cannot be awarded during a breaker, so no form for it may appear here",
      ).not.toContainText(/Award game|Game award/);
      await captureState(
        page,
        dir,
        "16-breakermore",
        "tennis",
        measurements,
        visibleProbe(tbSheet, "gallery(tennis): 16-breakermore must still show the More sheet"),
      );

      return ["13-sanctionsheet", "15-breakerdock", "16-breakermore"];
    },
  },
  {
    slug: "tennis-doubles",
    label: "Tennis (doubles)",
    sportKey: "tennis",
    variantKey: "doubles-noad-mtb10",
    entrantKind: "pair",
    // `pairOrder` is what makes the serve pip renderable at all: without a
    // DECLARED order `expectedDoublesServer` answers null for the side and the
    // pad has no player to mark, so these screens would picture the wave's
    // headline feature as absent (R4, `_INDEX.md`).
    roster: (tag) => ({
      home: [
        { fullName: `Gallery Tennis Doubles Home1 ${tag}`, pairOrder: 1 },
        { fullName: `Gallery Tennis Doubles Home2 ${tag}`, pairOrder: 2 },
      ],
      away: [
        { fullName: `Gallery Tennis Doubles Away1 ${tag}`, pairOrder: 1 },
        { fullName: `Gallery Tennis Doubles Away2 ${tag}`, pairOrder: 2 },
      ],
    }),
    // Same tap-only chassis as singles tennis; the ITF doubles variant +
    // paired entrants are what make this its own gallery entry (two names
    // per WhoLine instead of one), not a different action.
    scoreOne: async (page) => {
      await tennisHalf(page, "home").click();
    },
    openDock: async (page) => {
      await tennisHalf(page, "away").click();
      await expect(
        pad(page).locator('[data-role="v3-dock"]'),
        "gallery(tennis-doubles): a point tap must open the detail dock",
      ).toBeVisible({ timeout: 10_000 });
      return true;
    },
    dockProbe: async (page) => {
      await expect(
        pad(page).locator('[data-role="v3-dock"]'),
        "gallery(tennis-doubles): the dock closed before this width was captured — the 6s hold " +
          "window elapsed mid-capture, so this PNG would have shown a different state to its siblings",
      ).toBeVisible({ timeout: 5_000 });
    },
    // R4 — the wave's two named sign-off screens for the sport's own headline
    // pain (`_INDEX.md`, "the owner must verdict the DOUBLES screen
    // specifically"): the serve pip on a KNOWN, declared player, and the
    // dock's own SECOND question — which pair member won the point — which
    // exists only in doubles (R4-5; singles auto-stamps `scorer` at tap
    // time and never reaches this step, `buildDock`'s own doc). A fresh
    // fixture, not the primary one: by this point the primary has already
    // committed and dismissed its own dock via `openDock`/`dockProbe`
    // above, and a held tap's dock cannot be reopened.
    captureExtra: async (page, dir, tag, measurements) => {
      const dsTag = `${tag}ds`;
      const fx = await seedRosteredFixture(page.request, {
        label: `Gallery Tennis Doubles Serve ${dsTag}`,
        sportKey: "tennis",
        variantKey: "doubles-noad-mtb10",
        entrantKind: "pair",
        home: [
          { fullName: `Gallery Tennis DS Home1 ${dsTag}`, pairOrder: 1 },
          { fullName: `Gallery Tennis DS Home2 ${dsTag}`, pairOrder: 2 },
        ],
        away: [
          { fullName: `Gallery Tennis DS Away1 ${dsTag}`, pairOrder: 1 },
          { fullName: `Gallery Tennis DS Away2 ${dsTag}`, pairOrder: 2 },
        ],
        emitCoreStart: true,
      });
      await page.goto(await fixturePath(page.request, fx.fixtureId));
      // Home serves first by default (`kernel.ts`'s own init convention),
      // and at serviceTurn 0 the due server is the pairOrder:1 partner
      // (`expectedPairServer`, squad-state.ts) — a KNOWN person, never
      // "whichever name got marked" (R4, `_INDEX.md`).
      const server = pad(page).locator('[data-strip-item-id="server"]');
      await expect(server, "gallery(tennis-doubles): the strip must name the due server").toBeVisible({
        timeout: 20_000,
      });
      await expect(server).toContainText(`Gallery Tennis DS Home1 ${dsTag}`);
      await captureState(
        page,
        dir,
        "11-doublesserve",
        "tennis-doubles",
        measurements,
        visibleProbe(server, "gallery(tennis-doubles): 11-doublesserve must still name the due server"),
      );

      // 12-pointdock — the dock's SECOND question. `by` names the WINNING
      // side, so tapping home's half (home is on serve, but tapModel S
      // scores for whichever half is tapped) then "Winner" advances past
      // legality-by-side straight to "which partner won it", offering BOTH
      // home players by name.
      await tennisHalf(page, "home").click();
      const dock = pad(page).locator('[data-role="v3-dock"]');
      await expect(dock, "gallery(tennis-doubles): a point tap must open the detail dock").toBeVisible({
        timeout: 10_000,
      });
      await dock.getByRole("button", { name: "Winner", exact: true }).click();
      await expect(
        dock.getByRole("button", { name: `Gallery Tennis DS Home2 ${dsTag}`, exact: true }),
        "gallery(tennis-doubles): the dock's second question must name the winning pair",
      ).toBeVisible({ timeout: 10_000 });
      await captureState(page, dir, "12-pointdock", "tennis-doubles", measurements, async () => {
        await expect(
          dock,
          "gallery(tennis-doubles): the dock closed before this width was captured",
        ).toBeVisible({ timeout: 5_000 });
        await expect(
          dock.getByRole("button", { name: `Gallery Tennis DS Home2 ${dsTag}`, exact: true }),
          "gallery(tennis-doubles): 12-pointdock must still show the scorer step",
        ).toBeVisible();
      });

      // 14-serveafterbreaker — the rotation's real failure point. A fresh
      // fixture again: the one above has an open dock and a scored point.
      const brTag = `${tag}br`;
      const br = await seedRosteredFixture(page.request, {
        label: `Gallery Tennis Breaker Serve ${brTag}`,
        sportKey: "tennis",
        variantKey: "doubles-noad-mtb10",
        entrantKind: "pair",
        home: [
          { fullName: `Gallery Tennis BR Home1 ${brTag}`, pairOrder: 1 },
          { fullName: `Gallery Tennis BR Home2 ${brTag}`, pairOrder: 2 },
        ],
        away: [
          { fullName: `Gallery Tennis BR Away1 ${brTag}`, pairOrder: 1 },
          { fullName: `Gallery Tennis BR Away2 ${brTag}`, pairOrder: 2 },
        ],
        emitCoreStart: true,
      });
      const rally = async (entrantId: string, points: number): Promise<void> => {
        for (let i = 0; i < points; i += 1) {
          await postEvent(page.request, br.fixtureId, "tennis.point", { by: entrantId });
        }
      };
      // 12 games to 6-6 (4 straight points never reaches a contested deuce,
      // so each block of 4 closes exactly one game), a 7-0 breaker to close
      // the set 7-6, then ONE game of set 2 — the game the old derivation
      // got wrong. Serve is home's again here, at that side's 9th turn
      // (index 8): even, so the pairOrder-1 partner is due, exactly as at
      // turn 0. The lost-breaker-turns derivation answers index 7 and names
      // the pairOrder-2 partner instead.
      await rally(br.homeEntrantId, 5 * 4);
      await rally(br.awayEntrantId, 5 * 4);
      await rally(br.homeEntrantId, 4);
      await rally(br.awayEntrantId, 4);
      await rally(br.homeEntrantId, 7); // the breaker
      await rally(br.awayEntrantId, 4); // set 2, game 1 — away opens
      await page.goto(await fixturePath(page.request, br.fixtureId));
      const brServer = pad(page).locator('[data-strip-item-id="server"]');
      await expect(brServer, "gallery(tennis-doubles): the strip must name the due server").toBeVisible({
        timeout: 20_000,
      });
      await expect(
        brServer,
        "gallery(tennis-doubles): after a closed tie-break the due server is the pairOrder-1 partner",
      ).toContainText(`Gallery Tennis BR Home1 ${brTag}`);
      await expect(
        brServer,
        "gallery(tennis-doubles): naming the pairOrder-2 partner here is the desync defect itself",
      ).not.toContainText(`Gallery Tennis BR Home2 ${brTag}`);
      await captureState(
        page,
        dir,
        "14-serveafterbreaker",
        "tennis-doubles",
        measurements,
        visibleProbe(brServer, "gallery(tennis-doubles): 14-serveafterbreaker must still name the due server"),
      );

      // 17-serveaftersummary — the serve pip surviving a backfilled set.
      const suTag = `${tag}su`;
      const su = await seedRosteredFixture(page.request, {
        label: `Gallery Tennis Summary Serve ${suTag}`,
        sportKey: "tennis",
        variantKey: "doubles-noad-mtb10",
        entrantKind: "pair",
        home: [
          { fullName: `Gallery Tennis SU Home1 ${suTag}`, pairOrder: 1 },
          { fullName: `Gallery Tennis SU Home2 ${suTag}`, pairOrder: 2 },
        ],
        away: [
          { fullName: `Gallery Tennis SU Away1 ${suTag}`, pairOrder: 1 },
          { fullName: `Gallery Tennis SU Away2 ${suTag}`, pairOrder: 2 },
        ],
        emitCoreStart: true,
      });
      // One coarse-scored set, 6-4. TEN games — even — so the fold's own
      // `serving` and the ITF turn walk stay in step and the rotation is
      // genuinely derivable. Home has had 5 service turns, so turn index 5 is
      // due: odd, which is the pairOrder-2 partner.
      await postEvent(page.request, su.fixtureId, "tennis.set_summary", { home: 6, away: 4 });
      await page.goto(await fixturePath(page.request, su.fixtureId));
      const suServer = pad(page).locator('[data-strip-item-id="server"]');
      await expect(
        suServer,
        "gallery(tennis-doubles): a backfilled EVEN-game set must not cost the serve pip",
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        suServer,
        "gallery(tennis-doubles): home's 6th service turn (index 5, odd) is the pairOrder-2 partner",
      ).toContainText(`Gallery Tennis SU Home2 ${suTag}`);
      await captureState(
        page,
        dir,
        "17-serveaftersummary",
        "tennis-doubles",
        measurements,
        visibleProbe(suServer, "gallery(tennis-doubles): 17-serveaftersummary must still name the due server"),
      );

      return ["11-doublesserve", "12-pointdock", "14-serveafterbreaker", "17-serveaftersummary"];
    },
  },
  {
    slug: "volleyball",
    label: "Volleyball (indoor)",
    sportKey: "volleyball",
    variantKey: "indoor",
    roster: (tag) => ({
      home: [{ fullName: `Gallery Volleyball Home ${tag}` }],
      away: [{ fullName: `Gallery Volleyball Away ${tag}` }],
    }),
    // Verified live: scorepad-skins.spec.ts "racquet skin (volleyball): a
    // set summary then a rally" — this harness only needs ONE representative
    // event, so it drives the plain rally tap. (That test's "close set 1 by
    // summary FIRST" ordering is about driving BOTH mechanisms for the same
    // set in one test, not a precondition for either alone.)
    scoreOne: async (page) => {
      await pad(page).getByRole("button", { name: "Home", exact: true }).click();
    },
    // "Set score" is a genuine multi-field panel (Home/Away number fields),
    // opened after the rally above and left unconfirmed.
    openDock: async (page) => {
      const setScore = pad(page).getByRole("button", { name: "Set score", exact: true });
      if (!(await setScore.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await setScore.click();
      const homeField = pad(page).getByLabel("Home", { exact: true });
      if (!(await homeField.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await homeField.fill("25");
      await pad(page).getByLabel("Away", { exact: true }).fill("20");
      return true;
    },
    // R5 — D-17. Indoor volleyball's serve follows the rally winner (FIVB
    // 12.2.2), so the ledger alone answers "who serves next" from the second
    // rally onward; the pad prints "—" anyway. See `captureRacquetServing`.
    captureExtra: async (page, dir, tag, measurements) => [
      await captureRacquetServing(page, dir, tag, measurements, {
        slug: "volleyball",
        label: "Volleyball",
        sportKey: "volleyball",
        variantKey: "indoor",
        coarseType: "volleyball.set.summary",
        // Indoor set 1 is to 25 (setbased/volleyball.ts).
        summary: { home: 25, away: 20 },
        expectedSets: racquetScoreline(1, 0),
        expectedPoints: racquetScoreline(2, 1),
      }),
    ],
  },
  {
    slug: "badminton",
    label: "Badminton (BWF)",
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    roster: (tag) => ({
      home: [{ fullName: `Gallery Badminton Home ${tag}` }],
      away: [{ fullName: `Gallery Badminton Away ${tag}` }],
    }),
    // R5 — BADMINTON HAS CONVERTED. It no longer shares racquet-skin.tsx with
    // volleyball and table tennis (which still do, and whose two entries above
    // and below are unchanged): tap model S makes the scoreboard HALF the
    // rally button, and its accessible name is the player's own name plus hint
    // text, so it can only be addressed positionally. The old
    // `getByRole("button", {name: "Home"})` does not merely mis-target here —
    // it throws before a single screenshot is written, which is how R4 nearly
    // asked for a sign-off on a wave with zero pictures.
    scoreOne: async (page) => {
      await v3Half(page, "home").click();
    },
    // The v3 lane's genuine multi-field entry surface, opened and left
    // unconfirmed. NOT the Set score sheet: `scoreOne` above has just put a
    // rally into game 1, and D-16's fix withholds the Set score tile for a
    // game already being scored rally-by-rally — so reaching for it here would
    // find nothing. The sanction sheet is the honest picture of what a badminton
    // scorer can still open at this moment.
    openDock: async (page) => {
      const sanction = pad(page).locator('[data-tile-id="sanction-home"]');
      if (!(await sanction.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await sanction.click();
      const sheet = pad(page).locator('[data-role="v3-sheet"]');
      if (!(await sheet.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      return true;
    },
    // R5 — D-17 and D-7. Badminton is the sport BAD-03 names, so it carries
    // the band-limited capture as well as the serving one. Order matters:
    // 11 runs at Pro (its three rally taps only exist at band 3), 12 flips
    // the plan and restores it before this hook returns.
    captureExtra: async (page, dir, tag, measurements) => [
      await captureRacquetServing(page, dir, tag, measurements, {
        slug: "badminton",
        label: "Badminton",
        sportKey: "badminton",
        variantKey: "bwf",
        entrantKind: "individual",
        lane: "v3",
        coarseType: "badminton.game.summary",
        // BWF game 1 is to 21 (setbased/badminton.ts).
        summary: { home: 21, away: 15 },
        expectedSets: racquetScoreline(1, 0),
        expectedPoints: racquetScoreline(2, 1),
        // Three rallies, home/away/home, and BWF Law 10.1 gives the serve to
        // the rally winner — so the third rally's winner is due to serve next,
        // and that is HOME. Named in full, not merely "not the placeholder":
        // see `expectedServer`'s own doc.
        expectedServer: `Gallery badminton SV Home ${tag}sv`,
      }),
      await captureRacquetBandLimited(page, dir, tag, measurements),
    ],
  },
  {
    slug: "tabletennis",
    label: "Table Tennis (BO5)",
    sportKey: "tabletennis",
    variantKey: "bo5",
    entrantKind: "individual",
    roster: (tag) => ({
      home: [{ fullName: `Gallery Tabletennis Home ${tag}` }],
      away: [{ fullName: `Gallery Tabletennis Away ${tag}` }],
    }),
    // R5/C2 — TABLE TENNIS HAS CONVERTED. It no longer shares
    // racquet-skin.tsx with volleyball (which still does, and whose own
    // entry is unchanged): tap model S makes the scoreboard HALF the rally
    // button, addressed positionally exactly as badminton's own entry above
    // documents.
    scoreOne: async (page) => {
      await v3Half(page, "home").click();
    },
    // The v3 lane's genuine multi-field entry surface, opened and left
    // unconfirmed — badminton's own choice of tile and the same reason:
    // `scoreOne` above has just put a rally into game 1, and D-16's fix
    // withholds the Set score tile for a game already being scored
    // rally-by-rally, so reaching for it here would find nothing.
    openDock: async (page) => {
      const sanction = pad(page).locator('[data-tile-id="sanction-home"]');
      if (!(await sanction.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await sanction.click();
      const sheet = pad(page).locator('[data-role="v3-sheet"]');
      if (!(await sheet.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      return true;
    },
    // R5/C2 — D-17 and D-13. Table tennis's OWN rotation cannot resolve at
    // all without a declaration (`declareServingAnchor`'s own doc), so the
    // first of the three rally taps here is routed through the `serveAnchor`
    // tile + sheet — away serves it, home wins it — and the remaining two are
    // TAPPED on the scoreboard halves, past the `turnLength: 2` rotation
    // boundary this sport alone among the three R5 racquet sports has to
    // walk. The first time table tennis has been driven in a browser at all.
    captureExtra: async (page, dir, tag, measurements) => [
      await captureRacquetServing(page, dir, tag, measurements, {
        slug: "tabletennis",
        label: "Table Tennis",
        sportKey: "tabletennis",
        variantKey: "bo5",
        entrantKind: "individual",
        lane: "v3",
        coarseType: "tabletennis.game.summary",
        // ITTF game 1 is to 11 (setbased/tabletennis.ts).
        summary: { home: 11, away: 7 },
        expectedSets: racquetScoreline(1, 0),
        expectedPoints: racquetScoreline(2, 1),
        declareServingAnchor: "away",
        // Anchor (rally 1): away served, home won. Before rally 2 away is
        // still due to serve (turnLength: 2 — the SAME turn's second serve),
        // and away is the side tapped, so away also wins it. That completes
        // away's turn: before rally 3 home is due to serve (their FIRST serve
        // of the next turn), and home is the side tapped, so home wins it
        // too. After all three, home is due to serve next — their SECOND
        // serve of that same turn. The identical side/turn-index walk
        // `__tests__/tabletennis.test.ts`'s own "resolves once the anchor
        // declares it" test proves against the real fold, tapped here in a
        // real browser instead.
        expectedServer: `Gallery tabletennis SV Home ${tag}sv`,
      }),
    ],
  },
  {
    slug: "icehockey",
    label: "Ice Hockey (IIHF)",
    sportKey: "icehockey",
    variantKey: "iihf",
    roster: (tag) => ({
      home: [{ fullName: `Gallery Icehockey Home ${tag}` }],
      away: [{ fullName: `Gallery Icehockey Away ${tag}` }],
    }),
    // Verified live: scorepad-skins.spec.ts "period skin (icehockey): a
    // goal and a period advance".
    scoreOne: async (page, fx) => {
      await pad(page).getByRole("button", { name: "Goal", exact: true }).click();
      await pad(page).getByLabel("Kind").selectOption({ label: "Fg" });
      await pad(page).locator(`[data-value="${fx.homeEntrantId}"]`).click();
      await pad(page).locator('[data-role="confirm"]').click();
    },
    // Same "Goal" panel, opened a second time and left unconfirmed.
    openDock: async (page) => {
      await pad(page).getByRole("button", { name: "Goal", exact: true }).click();
      const kind = pad(page).getByLabel("Kind");
      if (!(await kind.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await kind.selectOption({ label: "Fg" });
      return true;
    },
  },
  {
    slug: "hockey",
    label: "Hockey (FIH outdoor)",
    sportKey: "hockey",
    variantKey: "fih-outdoor",
    roster: (tag) => ({
      home: [{ fullName: `Gallery Hockey Home ${tag}` }],
      away: [{ fullName: `Gallery Hockey Away ${tag}` }],
    }),
    // Verified live: v6-sports.spec.ts's card/suspension flow — hockey
    // shares period-skin.tsx with icehockey, but no UI-tapped "Goal"
    // precedent exists for hockey specifically in this repo, so this uses
    // the flow that IS proven. "Card" collides with the fidelity band's own
    // "Card" label (band 1 is literally named "card"); `:not([data-band])`
    // is the same disambiguator that file uses.
    scoreOne: async (page, fx, tag) => {
      await pad(page)
        .getByRole("button", { name: "Card", exact: true })
        .and(pad(page).locator("button:not([data-band])"))
        .click();
      await pad(page).getByLabel("Class").selectOption("green");
      await pad(page).getByLabel("Reason").selectOption({ index: 1 });
      await pad(page).getByLabel("Minutes", { exact: true }).fill("2");
      await pad(page).locator(`[data-value="${fx.homeEntrantId}"]`).click();
      await pad(page)
        .getByRole("button", { name: `Gallery Hockey Home ${tag}`, exact: true })
        .first()
        .click();
      await pad(page).locator('[data-role="confirm"]').click();
    },
    openDock: async (page) => {
      await pad(page)
        .getByRole("button", { name: "Card", exact: true })
        .and(pad(page).locator("button:not([data-band])"))
        .click();
      const cls = pad(page).getByLabel("Class");
      if (!(await cls.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await cls.selectOption("green");
      await pad(page).getByLabel("Reason").selectOption({ index: 1 });
      await pad(page).getByLabel("Minutes", { exact: true }).fill("2");
      return true;
    },
  },
  {
    slug: "carrom",
    label: "Carrom (ICF)",
    sportKey: "carrom",
    variantKey: "icf",
    // Verified live: the default `entrantKind` ("team") 422s here —
    // `ENTRANT_KIND_NOT_ALLOWED, this division doesn't take 'team'
    // entrants` — matching carrom-pad.spec.ts's own convention
    // (`addEntrantsViaApi`'s default is "individual", which is what that
    // file relies on implicitly).
    entrantKind: "individual",
    roster: (tag) => ({
      home: [{ fullName: `Gallery Carrom Home ${tag}` }],
      away: [{ fullName: `Gallery Carrom Away ${tag}` }],
    }),
    // Verified live: carrom-pad.spec.ts. That file's own route needed a
    // page.reload() after "Start match" before scoring (a same-tick tap on
    // a stale pre-phase fold 422s there); this harness drives the console
    // and polls the ledger for growth after Start match instead — the same
    // mechanism scorepad-skins.spec.ts's openLiveConsole already proved
    // avoids that exact staleness for five other sports — so the reload is
    // omitted here (confirmed live before this harness shipped).
    scoreOne: async (page) => {
      await pad(page).getByRole("button", { name: "Board (queen covered)", exact: true }).click();
      await pad(page).getByLabel("Opponent coins left", { exact: true }).fill("4");
      await pad(page)
        .locator('[data-attribution-path="winner"]')
        .getByRole("button", { name: "Home", exact: true })
        .click();
      await pad(page)
        .locator('[data-attribution-path="queenTo"]')
        .getByRole("button", { name: "Home", exact: true })
        .click();
      await pad(page).locator('[data-role="confirm"]').click();
    },
    openDock: async (page) => {
      const board = pad(page).getByRole("button", { name: "Board (queen covered)", exact: true });
      if (!(await board.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await board.click();
      const coins = pad(page).getByLabel("Opponent coins left", { exact: true });
      if (!(await coins.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await coins.fill("4");
      return true;
    },
  },
  {
    slug: "generic",
    label: "Generic (score)",
    sportKey: "generic",
    variantKey: "score",
    entrantKind: "individual",
    roster: (tag) => ({
      home: [{ fullName: `Gallery Generic Home ${tag}` }],
      away: [{ fullName: `Gallery Generic Away ${tag}` }],
    }),
    // Verified live: scorepad-a11y-evidence.spec.ts (open the panel, fill
    // Points) carried to a submit the way scorepad-v2.spec.ts's device route
    // does. Confirm/attribution are clicked only if the panel actually gates
    // them — generic's plain path may not need either.
    scoreOne: async (page) => {
      await pad(page).getByRole("button", { name: "Add points", exact: true }).click();
      await pad(page).getByLabel("Points", { exact: true }).fill("3");
      const home = pad(page).getByRole("button", { name: "Home", exact: true });
      if (await home.isVisible({ timeout: 3_000 }).catch(() => false)) await home.click();
      const confirm = pad(page).locator('[data-role="confirm"]');
      if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.click();
    },
    // Verified live precedent, verbatim: open the panel, fill Points, STOP.
    openDock: async (page) => {
      const addPoints = pad(page).getByRole("button", { name: "Add points", exact: true });
      if (!(await addPoints.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await addPoints.click();
      const points = pad(page).getByLabel("Points", { exact: true });
      if (!(await points.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await points.fill("3");
      return true;
    },
  },
  {
    slug: "boardgame",
    label: "Boardgame (classical)",
    sportKey: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    roster: (tag) => ({
      home: [{ fullName: `Gallery Boardgame Home ${tag}` }],
      away: [{ fullName: `Gallery Boardgame Away ${tag}` }],
    }),
    // No e2e precedent exists anywhere in this repo for boardgame (confirmed
    // by search) — this recipe was built entirely from two live capture
    // attempts. The pad's own "Scoring" card has exactly two real actions,
    // "Result" and "Draw / no result" (read off the captured "02-live"
    // screenshot); BOTH open a panel (Method select + Moves text input,
    // gated by `[data-role="confirm"]`, which stays disabled with "Fill in
    // the required fields to continue" until both are set) rather than
    // firing immediately — the first two live attempts (a blind generic
    // prober, then an un-filled "Draw / no result" tap) both timed out on
    // `waitForLedgerGrowth` for exactly that reason, confirmed by reading
    // the failure screenshot each time rather than guessing again blind.
    scoreOne: async (page) => {
      await pad(page).getByRole("button", { name: "Draw / no result", exact: true }).click();
      await pad(page).getByLabel("Method").selectOption({ index: 1 });
      // "Moves" is a plain move-COUNT (`input[type=number] min=0 max=400`),
      // not a move-list string — verified live after a first attempt filled
      // "1. e4 e5" into it and Playwright refused ("Cannot type text into
      // input[type=number]").
      await pad(page).getByLabel("Moves", { exact: true }).fill("40");
      await pad(page).locator('[data-role="confirm"]').click();
    },
    // Same panel shape, "Result" instead — filled with Method only and left
    // unconfirmed (mirrors every other sport's dock: some fields set, the
    // rest visibly incomplete, never submitted).
    openDock: async (page) => {
      const result = pad(page).getByRole("button", { name: "Result", exact: true });
      if (!(await result.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await result.click();
      const method = pad(page).getByLabel("Method");
      if (!(await method.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await method.selectOption({ index: 1 });
      return true;
    },
  },
];

interface SportManifestEntry {
  slug: string;
  label: string;
  sportKey: string;
  variantKey: string;
  dockPanelOpened: boolean;
  measurements320: Measurement320[];
  /** State names `GallerySport.captureExtra` actually captured, in order —
   *  empty for every sport with no such hook. */
  extraStates: ExtraGalleryState[];
}

const manifest: SportManifestEntry[] = [];

function buildIndexHtml(sports: SportManifestEntry[]): string {
  const sections = sports
    .map((s) => {
      // s.extraStates: wave-specific captures beyond the fixed five (e.g.
      // R2b's cricket 06-overtile/07-oversheet) — appended per-sport here,
      // never joined into the shared STATES tuple itself (see EXTRA_STATES'
      // own comment for why).
      const stateBlocks = [...STATES, ...s.extraStates].map((st) => {
        const dockNote =
          st === "04-dock" && !s.dockPanelOpened
            ? ' <em>(no distinct panel today — same view as 03-scored)</em>'
            : "";
        // ACTIVE_WIDTHS, not WIDTHS: index.html must only link the widths
        // this run actually wrote a file for (GALLERY_WIDTHS override).
        const figures = ACTIVE_WIDTHS.map(
          (w) =>
            `<figure><figcaption>${w}px</figcaption><img loading="lazy" src="${s.slug}/${st}-${w}.png" alt="${s.label} ${st} ${w}px"></figure>`,
        ).join("");
        return `<div class="state"><h3>${st}${dockNote}</h3><div class="widths">${figures}</div></div>`;
      }).join("\n");
      return `<section><h2>${s.label} <small>(${s.sportKey}/${s.variantKey})</small></h2>${stateBlocks}</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ScoringPad v3 R1 — gallery</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b12;color:#eee;margin:0;padding:24px;}
  h1{margin-top:0}
  section{border-top:1px solid #333;padding:24px 0;}
  h2 small{color:#999;font-weight:normal;}
  .state{margin-bottom:20px;}
  .state h3{margin-bottom:8px;font-size:14px;color:#ddd;}
  .state h3 em{color:#f0ad4e;font-style:normal;font-size:12px;}
  .widths{display:flex;gap:16px;flex-wrap:wrap;}
  figure{margin:0;}
  figcaption{font-size:12px;color:#999;margin-bottom:4px;}
  img{max-width:280px;border:1px solid #333;display:block;background:#fff;}
  .note{background:#221;border:1px solid #542;padding:12px;border-radius:8px;margin-bottom:24px;font-size:14px;}
  code{background:#1a1a24;padding:1px 5px;border-radius:3px;}
</style>
</head>
<body>
<h1>ScoringPad v3 — capture gallery</h1>
<p class="note">Which pad a sport renders is <code>v3/registry.ts</code>'s
<code>V3_SKINS</code>, one sport per wave — cricket (R2) and football (R3) are on the v3
chassis; every other sport here is still the legacy pad, and that sameness is the evidence a
wave changed only what it converted. A full-page screenshot can paint the sticky nav a second
time mid-image — that is a capture artifact of <code>fullPage</code> screenshots against a
<code>position:sticky</code> header, not a product defect. States marked "no distinct panel
today" reuse the 03-scored image because that sport's legacy pad has no separate detail-entry
surface to show today — not a missing capture. See <code>docs/runbooks/pad-gallery.md</code>
for the sign-off gate this gallery feeds and <code>manifest.json</code> beside this file for
the 320px scrollWidth/clientWidth measurements per state (recorded for every state regardless
of which widths below actually have a screenshot file — see <code>GALLERY_WIDTHS</code> in
<code>gallery.capture.ts</code>), plus <code>padRowsByWidth</code>: the rendered pad-event
count at each captured width, which is what proves the widths below are three views of ONE
state rather than three states.</p>
<p class="note">This run captured widths: ${ACTIVE_WIDTHS.join(", ")}px.</p>
${sections}
</body>
</html>`;
}

test.afterAll(() => {
  writeFileSync(join(GALLERY_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(GALLERY_DIR, "index.html"), buildIndexHtml(manifest));
});

for (const sport of SPORTS) {
  test(`gallery: ${sport.label}`, async ({ page, browser }) => {
    test.setTimeout(180_000);
    const tag = `${TAG}${Math.random().toString(36).slice(2, 6)}`;
    const dir = join(GALLERY_DIR, sport.slug);
    mkdirSync(dir, { recursive: true });
    const email = `gallery-${sport.slug}-${tag}@example.com`;
    const measurements: Measurement320[] = [];

    await armCookieBypass(page);
    // loginUi mints a DB login row directly under E2E_PROD_TARGET=1 (never
    // the rate-limited /api/auth/magic-link route) — safe to call once per
    // sport, twelve times in one run.
    await loginUi(page, email);
    // Device links (05-devicelink below) are Pro-only.
    await setOrgPlanBySql({ email }, "pro");

    const { home, away } = sport.roster(tag);
    const fx = await seedRosteredFixture(page.request, {
      label: `Gallery ${sport.label} ${tag}`,
      sportKey: sport.sportKey,
      variantKey: sport.variantKey,
      entrantKind: sport.entrantKind,
      home,
      away,
      // Leave the fixture in "pre" so this harness drives Start match
      // itself and can capture the true pre-match screen.
      emitCoreStart: false,
    });

    await page.goto(await fixturePath(page.request, fx.fixtureId));
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });
    // 01-pre has no pending fold to lose (nothing has been dispatched yet), so
    // its proof is the pre-match console itself: the pad rendered, and the
    // "Start match" control this flow is about to press still present.
    await captureState(page, dir, "01-pre", sport.slug, measurements, async () => {
      await expect(pad(page), `gallery(${sport.slug}): 01-pre must render the pad`).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        page.getByRole("button", { name: "Start match", exact: true }),
        `gallery(${sport.slug}): 01-pre must be a pre-match console`,
      ).toBeVisible({ timeout: 20_000 });
    });

    const beforeStart = await ledgerCount(page.request, fx.fixtureId);
    await page.getByRole("button", { name: "Start match", exact: true }).click();
    await waitForLedgerGrowth(page.request, fx.fixtureId, beforeStart);
    // THE RACE THIS PROBE EXISTS FOR: `waitForLedgerGrowth` proves the SERVER
    // took `core.start`; the pad renders from its own client fold, which
    // arrives later. Capturing here without the probe photographed a
    // pre-kickoff board at 320 and a live one at 768/1280 — one declared
    // state, three boards, nothing red.
    const afterStart = await ledgerCount(page.request, fx.fixtureId);
    await captureState(
      page,
      dir,
      "02-live",
      sport.slug,
      measurements,
      foldedProbe(page, afterStart, `gallery(${sport.slug}): 02-live must render the STARTED board`),
    );

    const beforeScore = await ledgerCount(page.request, fx.fixtureId);
    await sport.scoreOne(page, fx, tag);
    await waitForLedgerGrowth(page.request, fx.fixtureId, beforeScore);
    const afterScore = await ledgerCount(page.request, fx.fixtureId);
    const scoredProbe = foldedProbe(
      page,
      afterScore,
      `gallery(${sport.slug}): the scored event must have folded into the pad`,
    );
    await captureState(page, dir, "03-scored", sport.slug, measurements, scoredProbe);

    const dockOpened = await sport.openDock(page, fx, tag);
    // A sport whose dock can close on its own declares `dockProbe` and is held
    // to it; the rest keep the scored-state proof, which is what they were
    // (implicitly) capturing before this parameter existed.
    await captureState(
      page,
      dir,
      "04-dock",
      sport.slug,
      measurements,
      dockOpened && sport.dockProbe ? () => sport.dockProbe!(page) : scoredProbe,
    );

    // Wave-specific extras (R2b: cricket only) — absent for every other
    // sport, which makes this a no-op that leaves their run byte-identical
    // to before this hook existed.
    const extraStates = sport.captureExtra ? await sport.captureExtra(page, dir, tag, measurements) : [];

    const dl = await apiJson<{ id: string; secret: string }>(
      page.request,
      `/api/v1/fixtures/${fx.fixtureId}/device-links`,
      "POST",
      { label: "Gallery capture" },
    );
    if (dl.status !== 201 || !dl.data) {
      throw new Error(
        `gallery(${sport.slug}): device-link mint failed -> ${dl.status} ${JSON.stringify(dl.error)}`,
      );
    }
    // device-links.spec.ts's own pattern — a brand-new, unauthenticated
    // context; the secret alone opens the pad.
    const dlContext = await browser.newContext();
    try {
      const dlPage = await dlContext.newPage();
      await armCookieBypass(dlPage);
      await dlPage.goto(`/score/${dl.data.secret}`);
      // The device-link route (app/score/[token]/page.tsx → DeviceScorePad)
      // has no `data-testid="score-pad"` — that testid is minted only by
      // fixture-console.tsx, the CONSOLE route's own wrapper (confirmed by
      // reading both files live; the first cricket run against this harness
      // timed out on `pad()` here for exactly that reason). DeviceScorePad's
      // own chrome instead carries a fixed, sport-agnostic dictionary
      // string — `device.courtsideFooter`, "Courtside {scorer} pad · link
      // active today only" — whose `{scorer}` half varies per sport
      // (officialLabel.scorer: "Umpire", "Referee", …) but whose tail does
      // not, so this matches on the constant half only.
      await expect(dlPage.getByText(/link active today only/)).toBeVisible({ timeout: 20_000 });
      await captureState(
        dlPage,
        dir,
        "05-devicelink",
        sport.slug,
        measurements,
        visibleProbe(
          dlPage.getByText(/link active today only/),
          `gallery(${sport.slug}): 05-devicelink must render the courtside pad, not the console`,
        ),
      );
    } finally {
      await dlContext.close();
    }

    manifest.push({
      slug: sport.slug,
      label: sport.label,
      sportKey: sport.sportKey,
      variantKey: sport.variantKey,
      dockPanelOpened: dockOpened,
      measurements320: measurements,
      extraStates,
    });
  });
}

// D5/P8 venues & courts (Directory > Venues, not a sport skin — no fixture,
// no `data-testid="score-pad"`) — a wholly separate capture, added to this
// same file only because it already owns WIDTHS/HEIGHTS/GALLERY_DIR/
// expectNoHorizontalScroll and the `gallery` Playwright project's testMatch
// (playwright.config.ts) is scoped to this one file. Not folded into the
// SPORTS loop/manifest: `GallerySport`/`SportManifestEntry` are shaped
// around a fixture's pre/live/scored/dock lifecycle, which a venue has none
// of. Screenshots land in `${GALLERY_DIR}/venues/`, outside the per-sport
// manifest.json/index.html this file also writes.
async function captureVenuesState(page: Page, dir: string, state: string): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: HEIGHTS[width] });
    if (width === 320) await expectNoHorizontalScroll(page);
    await page.screenshot({
      path: join(dir, `${state}-${width}.png`),
      fullPage: true,
      animations: "disabled",
      timeout: 20_000,
    });
  }
}

test("gallery: venues (P8)", async ({ page }) => {
  test.setTimeout(120_000);
  const tag = `${TAG}${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(GALLERY_DIR, "venues");
  mkdirSync(dir, { recursive: true });
  const email = `gallery-venues-${tag}@example.com`;

  await armCookieBypass(page);
  await loginUi(page, email);
  // requirePageAuth (any server page) is what auto-provisions "My
  // organization" for a member of none — activeOrg needs that to have
  // already happened (mobile.spec.ts's dual-role test hits the same trap).
  await page.goto("/dashboard", { waitUntil: "load" });
  const org = await activeOrg(page);

  const venue = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/orgs/${org.id}/venues`,
    "POST",
    { name: `Riverside Sports Centre ${tag}`, address: "12 River Road" },
  );
  const court1 = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/orgs/${org.id}/venues/${venue.data!.id}/courts`,
    "POST",
    { name: "Court 1", tags: ["indoor", "hardwood"] },
  );
  // A realistic week: open Mon-Sat, longer on Fri, closed Sun (no row at
  // all — the calendar editor shows "Closed all day." for it), plus one
  // holiday exception — so 02-calendar is a genuinely populated editor
  // rather than every day showing "Add a time range" and nothing else.
  await apiJson(page.request, `/api/v1/orgs/${org.id}/courts/${court1.data!.id}/calendar`, "PUT", {
    hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      open_min: 9 * 60,
      close_min: weekday === 5 ? 22 * 60 : weekday === 6 ? 17 * 60 : 21 * 60,
    })),
    exceptions: [{ date: "2026-12-25", closed: true, open_min: null, close_min: null }],
  });
  await apiJson(page.request, `/api/v1/orgs/${org.id}/venues/${venue.data!.id}/courts`, "POST", {
    name: "Court 2",
    tags: ["outdoor"],
  });

  await page.goto("/directory?tab=venues", { waitUntil: "load" });
  // Two "Venue name"-labelled fields exist once a venue card renders: the
  // always-present Add form's (empty) field, and this new card's (filled)
  // one — count, not text, since the name is an input VALUE, never static
  // text, anywhere in this component.
  await expect(page.getByLabel("Venue name")).toHaveCount(2, { timeout: 20_000 });
  await captureVenuesState(page, dir, "01-list");

  // Court 1 sorts first (alphabetical tiebreak on equal `sort`) and is the
  // one with tags + a populated calendar — open ITS editor, not Court 2's.
  await page.getByRole("button", { name: "Hours", exact: true }).first().click();
  // exact: true — the page's own eyebrow copy ends "...with each court's
  // own weekly hours.", a case-insensitive substring match for the bare
  // query and a strict-mode violation without it.
  await expect(page.getByText("Weekly hours", { exact: true })).toBeVisible();
  await captureVenuesState(page, dir, "02-calendar");
});
