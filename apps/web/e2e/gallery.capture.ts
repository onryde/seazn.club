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

function tennisHalf(page: Page, side: "home" | "away") {
  return pad(page).locator('[data-role="v3-scorebug"] .grid > button').nth(side === "home" ? 0 : 1);
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

      return [...EXTRA_STATES];
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

      return ["11-doublesserve", "12-pointdock", "14-serveafterbreaker"];
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
    // badminton/tabletennis/volleyball share ONE component, racquet-skin.tsx
    // — the plain rally tap verified for volleyball above is the same
    // control here.
    scoreOne: async (page) => {
      await pad(page).getByRole("button", { name: "Home", exact: true }).click();
    },
    // Verified live: scoring.spec.ts's badminton flow uses this same
    // "Set score" summary panel (shared racquet-skin.tsx), wrapped in a
    // retry because a same-tick fill can land before React hydrates —
    // mirrored here even though this harness does not confirm the panel.
    openDock: async (page) => {
      const setScore = pad(page).getByRole("button", { name: "Set score", exact: true });
      if (!(await setScore.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await setScore.click();
      const homeField = pad(page).getByLabel("Home", { exact: true });
      if (!(await homeField.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await expect(async () => {
        await homeField.fill("21");
        await expect(homeField).toHaveValue("21");
      }).toPass({ timeout: 10_000 });
      return true;
    },
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
    // No e2e precedent exists anywhere in this repo for table tennis
    // specifically (confirmed by search) — this mirrors badminton/volleyball
    // by construction: all three share racquet-skin.tsx
    // (`racquetSkin.sports = ["volleyball","badminton","tabletennis"]`),
    // verified live against the running server before this harness shipped.
    scoreOne: async (page) => {
      await pad(page).getByRole("button", { name: "Home", exact: true }).click();
    },
    openDock: async (page) => {
      const setScore = pad(page).getByRole("button", { name: "Set score", exact: true });
      if (!(await setScore.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await setScore.click();
      const homeField = pad(page).getByLabel("Home", { exact: true });
      if (!(await homeField.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await homeField.fill("11");
      return true;
    },
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
