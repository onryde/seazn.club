import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loginUi,
  seedRosteredFixture,
  setOrgPlanBySql,
  fixturePath,
  apiJson,
  expectNoHorizontalScroll,
  TAG,
  type RosterSlotSpec,
  type RosteredFixture,
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

const STATES = ["01-pre", "02-live", "03-scored", "04-dock", "05-devicelink"] as const;
type GalleryState = (typeof STATES)[number];

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
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

interface Measurement320 {
  state: GalleryState;
  scrollWidth: number;
  clientWidth: number;
  overflowPx: number;
}

/**
 * Screenshots one state at all three widths into `dir`. At 320px this ALSO
 * records the real scrollWidth/clientWidth pair (measurement debt Tasks 6
 * and 8 deferred here — see docs/runbooks/pad-gallery.md) and asserts no
 * horizontal page overflow; a genuine overflow fails the test here rather
 * than silently shipping a screenshot of a broken layout.
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
  state: GalleryState,
  slug: string,
  measurements: Measurement320[],
): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: HEIGHTS[width] });
    if (width === 320) {
      const { scrollWidth, clientWidth } = await measureScroll(page);
      const overflowPx = Math.max(0, scrollWidth - clientWidth);
      measurements.push({ state, scrollWidth, clientWidth, overflowPx });
      // Deliberate console.log: the raw numbers are the whole point of this
      // measurement, and the wave gate reads them straight from the run's
      // own stdout as well as manifest.json.
      console.log(
        `[gallery] ${slug} ${state} @320: scrollWidth=${scrollWidth} clientWidth=${clientWidth} overflowPx=${overflowPx}`,
      );
      await expectNoHorizontalScroll(page);
    }
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
}

const SPORTS: GallerySport[] = [
  {
    slug: "cricket",
    label: "Cricket (T20)",
    sportKey: "cricket",
    variantKey: "t20",
    roster: (tag) => ({
      home: [
        { fullName: `Gallery Cricket Striker ${tag}` },
        { fullName: `Gallery Cricket NonStriker ${tag}` },
      ],
      away: [{ fullName: `Gallery Cricket Bowler ${tag}` }],
    }),
    // Verified live: scorepad-skins.spec.ts "cricket skin: real roster, a
    // couple of balls scored". Deliberately stops at a plain run tap — a
    // wicket-completion attempt wedged the page during the session that
    // captured the baseline gallery (dispatch's own capture traps), so this
    // harness never drives that flow.
    scoreOne: async (page, fx, tag) => {
      const striker = fx.personIds[`Gallery Cricket Striker ${tag}`]!;
      const nonStriker = fx.personIds[`Gallery Cricket NonStriker ${tag}`]!;
      const bowler = fx.personIds[`Gallery Cricket Bowler ${tag}`]!;
      const selects = pad(page).locator('[data-role="cricket-this-over"] select');
      await expect(selects).toHaveCount(3);
      await selects.nth(0).selectOption(striker);
      await selects.nth(1).selectOption(nonStriker);
      await selects.nth(2).selectOption(bowler);
      await pad(page).getByRole("button", { name: "4", exact: true }).click();
    },
    // No panel precedent for cricket in the e2e suite, and no wicket flow is
    // driven here (see scoreOne) — "04-dock" intentionally reuses "03-scored".
    openDock: async () => false,
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
    // Verified live: scorepad-skins.spec.ts "football skin: a side-only goal".
    scoreOne: async (page) => {
      await pad(page).getByRole("button", { name: "Home · Goal", exact: true }).click();
      await pad(page).getByRole("button", { name: "Confirm", exact: true }).click();
    },
    // Verified live: scorepad-skins.spec.ts "football skin: a penalty with
    // an offence selected" — a genuinely separate, richer panel to the
    // plain goal tile above. Filled but deliberately NOT confirmed.
    openDock: async (page) => {
      const penalties = pad(page).getByText("Penalties", { exact: true });
      if (!(await penalties.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await penalties.click();
      await pad(page).getByRole("button", { name: "Penalty", exact: true }).click();
      const outcome = pad(page).getByLabel("Outcome");
      if (!(await outcome.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
      await outcome.selectOption("saved");
      await pad(page).getByLabel("Offence").selectOption("handball");
      await pad(page).getByLabel("At period").selectOption("H1");
      await pad(page).getByLabel("At elapsed", { exact: true }).fill("300");
      return true;
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
    // Verified live: scorepad-skins.spec.ts "tennis skin: play points to
    // deuce" — one tap of the same Home/Away pair is enough for "scored".
    scoreOne: async (page) => {
      await pad(page).getByRole("button", { name: "Home", exact: true }).click();
    },
    openDock: async () => false,
  },
  {
    slug: "tennis-doubles",
    label: "Tennis (doubles)",
    sportKey: "tennis",
    variantKey: "doubles-noad-mtb10",
    entrantKind: "pair",
    roster: (tag) => ({
      home: [
        { fullName: `Gallery Tennis Doubles Home1 ${tag}` },
        { fullName: `Gallery Tennis Doubles Home2 ${tag}` },
      ],
      away: [
        { fullName: `Gallery Tennis Doubles Away1 ${tag}` },
        { fullName: `Gallery Tennis Doubles Away2 ${tag}` },
      ],
    }),
    // Same tap-only chassis as singles tennis; the ITF doubles variant +
    // paired entrants are what make this its own gallery entry (two names
    // per WhoLine instead of one), not a different action.
    scoreOne: async (page) => {
      await pad(page).getByRole("button", { name: "Home", exact: true }).click();
    },
    openDock: async () => false,
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
}

const manifest: SportManifestEntry[] = [];

function buildIndexHtml(sports: SportManifestEntry[]): string {
  const sections = sports
    .map((s) => {
      const stateBlocks = STATES.map((st) => {
        const dockNote =
          st === "04-dock" && !s.dockPanelOpened
            ? ' <em>(no distinct panel today — same view as 03-scored)</em>'
            : "";
        const figures = WIDTHS.map(
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
<h1>ScoringPad v3 R1 — capture gallery</h1>
<p class="note">R1 converts no sport — every screen here should look like today's legacy pad
(the v3 chassis primitives exist but render nowhere yet, <code>V3_SKINS = {}</code>). A
full-page screenshot can paint the sticky nav a second time mid-image — that is a capture
artifact of <code>fullPage</code> screenshots against a <code>position:sticky</code> header,
not a product defect. States marked "no distinct panel today" reuse the 03-scored image
because that sport's legacy pad has no separate detail-entry surface to show today — not a
missing capture. See <code>docs/runbooks/pad-gallery.md</code> for the sign-off gate this
gallery feeds and <code>manifest.json</code> beside this file for the 320px scrollWidth/
clientWidth measurements per state.</p>
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
    await captureState(page, dir, "01-pre", sport.slug, measurements);

    const beforeStart = await ledgerCount(page.request, fx.fixtureId);
    await page.getByRole("button", { name: "Start match", exact: true }).click();
    await waitForLedgerGrowth(page.request, fx.fixtureId, beforeStart);
    await captureState(page, dir, "02-live", sport.slug, measurements);

    const beforeScore = await ledgerCount(page.request, fx.fixtureId);
    await sport.scoreOne(page, fx, tag);
    await waitForLedgerGrowth(page.request, fx.fixtureId, beforeScore);
    await captureState(page, dir, "03-scored", sport.slug, measurements);

    const dockOpened = await sport.openDock(page, fx, tag);
    await captureState(page, dir, "04-dock", sport.slug, measurements);

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
      await captureState(dlPage, dir, "05-devicelink", sport.slug, measurements);
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
    });
  });
}
