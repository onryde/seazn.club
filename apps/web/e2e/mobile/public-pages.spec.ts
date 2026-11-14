// Split out of the former e2e/mobile.spec.ts (2026-11-13, verbatim move): anonymous pages: the Title sponsor showcase, the public IIHF standings, and the 2048 game.
// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — MOBILE_SPECS in playwright.config.ts).

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  TAG,
  apiJson,
  activeOrg,
  expectNoHorizontalScroll,
  addEntrantsViaApi,
  loginUi,
  overflowingIn,
  setOrgPlanBySql,
} from "../helpers";
import { HIT_TARGET_FLOOR_PX, consentedAnonymousState, dismissCookieBanner } from "../scorepad-a11y-kit";
import { FLOOR_MS, ROUTE_CHECK_MS } from "../spectator-w2-kit";
import {
  STORAGE_KEY as GAME_2048_STORAGE_KEY,
  type GameState as Game2048State,
} from "../../src/games/2048/state";
import { posterSvg, routePosterArt, storagePublicUrl } from "../helpers/poster-art";
import { projectViewport, projectTag } from "./_shared";

// Not serial: no test here reads state another test writes (no module-level `let` is shared), so one red does not skip the rest (AGENTS.md class 21).

// Title sponsor hero poster (spec 2026-11-11, T7): the public competition page's Title sponsor, at every width project. Below 768 a band
// under the hero carries it and the hero's own sentence steps aside; from 768 a 4:5 panel sits in the hero's right column and the band
// steps aside. Both are in the server's markup (CSS picks one), so each assertion below is made on the one that is VISIBLE at this width,
// and the other is asserted hidden. What it pins, each of which a unit suite on the markup cannot see (AGENTS.md classes 2 and 22):
//   - the dots are 44px each (a bounding box measures paint, so the centre is also HIT-TESTED: `elementFromPoint` must land on the dot,
//     not on the poster or the capsule) and the capsule is one row;
//   - a realistic 43-character sponsor name never clips: it wraps to at most two lines, then ends in a line-clamp, with its full text in
//     `title` and in the DOM (class 23: a clamp is a signalled truncation, a clipped box is a defect, and `overflowingIn` tells them apart);
//   - an unlinked sponsor's slide has no anchor and no Visit, and a linked one has exactly one (the positive pair of each negative);
//   - the page does not scroll sideways and axe finds nothing serious.
// Reduced motion is on, so nothing rotates under the measuring; the dots still work (the visitor is then the one moving it).
// The org is the test's OWN (a fresh user, as the P6 blocks above): a Title sponsor that some other spec left on the shared Pro org would
// add a slide to this page (and change the dot count asserted below), and orgs are capped per person, so seven width projects cannot each
// seed one from the shared account.
// THREE Title sponsors, not two: the dots' capsule is `w-fit` and centred inside the panel (220px wide at md, `max-w-[calc(100%-1rem)]`), and
// two 44px dots (88px) fit one row whatever the capsule's width rule is, so "one row" could not fail. Three (132px) is the count that does
// not fit if the capsule is ever pinned to `left-1/2` again (a box pinned there may only be as wide as the half that remains: 110px in a
// 220px panel, so the third dot wraps). Four is the most a competition's hero is meant to carry.
const THIRD_TITLE_SPONSOR = "Fenwick Print";
const TITLE_SPONSOR_COUNT = 3;
const LONG_TITLE_SPONSOR = "Harbourside Building Supplies and Timber Co";
test("title sponsor showcase: band below 768, panel from 768, no scroll, 44px dots, a 43-character name in two lines", async ({
  page,
  browser,
}) => {
  const vp = projectViewport();
  expect(vp, "this project declares a viewport").not.toBeNull();
  const phone = vp!.width < 768;
  expect(LONG_TITLE_SPONSOR.length, "premise: the realistic 43 characters").toBe(43);
  // Login, the plan flip, a competition, three sponsors, one navigation and the scans; never below the file's floor (AGENTS.md class 20).
  const LOGIN_MS = 30_000;
  const API_MS = 5_000;
  test.setTimeout(Math.max(FLOOR_MS, LOGIN_MS + 9 * API_MS + 12 * ROUTE_CHECK_MS));

  await loginUi(page, `delivered+tp-showcase-${TAG}-${projectTag()}@resend.dev`);
  const org = await activeOrg(page);
  // A fresh org is on the community plan, which has no Title tier: Pro first, so the competition's public visibility is not degraded
  // either (`createCompetition` quietly turns a public request private over the plan's cap).
  await setOrgPlanBySql({ orgId: org.id }, "pro");
  const comp = await apiJson<{ id: string; slug: string; visibility: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Showcase ${TAG}`,
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  expect(comp.data!.visibility, "premise: the public-dashboard cap did not degrade the competition").toBe("public");
  const published = await apiJson<{ status: string }>(page.request, `/api/v1/competitions/${comp.data!.id}`, "PATCH", { status: "published" });
  expect(published.data?.status, JSON.stringify(published.error)).toBe("published");

  const POSTER = storagePublicUrl(`assets/orgs/${org.id}/content/poster-${TAG}.png`);
  const sponsorIds: string[] = [];
  const anonCtx = await browser.newContext({
    viewport: vp ?? undefined,
    storageState: await consentedAnonymousState(),
    reducedMotion: "reduce",
  });
  try {
    const made = async (body: Record<string, unknown>): Promise<string> => {
      const res = await apiJson<{ id: string }>(page.request, `/api/v1/orgs/${org.id}/sponsors`, "POST", {
        tier: "title",
        competition_id: comp.data!.id,
        ...body,
      });
      expect(res.status, `${String(body.name)}: ${JSON.stringify(res.error)}`).toBe(201);
      sponsorIds.push(res.data!.id);
      return res.data!.id;
    };
    // A: linked, with a poster. B: the long name, no link, no logo (its card is a monogram) - the slide that must never clip. C: a third,
    // plain one, so the capsule has three dots to lay out (see THIRD_TITLE_SPONSOR above).
    const aId = await made({ name: "Pandyas", url: "https://pandyas.example/", poster_path: POSTER });
    const bId = await made({ name: LONG_TITLE_SPONSOR });
    const cId = await made({ name: THIRD_TITLE_SPONSOR });
    expect(new Set([aId, bId, cId]).size, "premise: three distinct Title sponsors").toBe(TITLE_SPONSOR_COUNT);
    await routePosterArt(anonCtx, POSTER, { svg: posterSvg("Pandyas", "#0f766e") });

    const anon = await anonCtx.newPage();
    await anon.goto(`/live/${org.slug}/${comp.data!.slug}`, { waitUntil: "load" });
    // The premise of every assertion below: this org is tiered, so the hero carries the Title sponsor's sentence (hidden below 768, but
    // in the markup). Without it the page has no showcase and "hidden on a phone" would pass for the wrong reason.
    await expect(anon.getByTestId("mh-hero-sponsor"), "premise: the org is tiered and the page has a Title sponsor").toBeAttached();

    const band = anon.getByTestId("mh-title-band");
    const panel = anon.getByTestId("mh-hero-poster");
    const sentence = anon.getByTestId("mh-hero-sponsor");
    if (phone) {
      await expect(band, "below 768 the band carries the sponsor").toBeVisible();
      await expect(panel, "and the panel is not drawn").toBeHidden();
      await expect(sentence, "and the hero's own sentence steps aside").toBeHidden();
    } else {
      await expect(panel, "from 768 the panel carries the sponsor").toBeVisible();
      await expect(band, "and the band is not drawn").toBeHidden();
      await expect(sentence, "and the hero keeps its sentence").toBeVisible();
    }

    // The dots: three sponsors, three dots in the VISIBLE showcase (the hidden twin has its own three), each a 44px target that a tap would
    // reach, side by side on one row.
    const showcase = phone ? band : panel;
    const dots = showcase.getByTestId("title-showcase-dot");
    await expect(dots, "one dot per Title sponsor in the visible showcase").toHaveCount(TITLE_SPONSOR_COUNT);
    await dots.first().scrollIntoViewIfNeeded();
    const probes = await dots.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { width: r.width, height: r.height, top: r.top, hit: at !== null && (at === el || el.contains(at)) };
      }),
    );
    expect(probes.length, "dots measured").toBe(TITLE_SPONSOR_COUNT);
    for (const [i, p] of probes.entries()) {
      expect(p.width, `dot ${i} is ${HIT_TARGET_FLOOR_PX}px wide at ${vp!.width}px`).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
      expect(p.height, `dot ${i} is ${HIT_TARGET_FLOOR_PX}px tall at ${vp!.width}px`).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
    }
    expect(probes.filter((p) => p.hit).length, "a tap at each dot's centre lands on that dot, not on what is drawn over it").toBe(TITLE_SPONSOR_COUNT);
    for (const [i, p] of probes.entries()) expect(Math.abs(p.top - probes[0]!.top), `dot ${i} is on the first dot's row: the capsule is one row`).toBeLessThanOrEqual(1);

    // Tap B's dot (retried until React has attached: a tap before hydration is lost, not queued).
    const slideB = showcase.locator(`[data-testid="title-slide"][data-sponsor-id="${bId}"]`);
    const slideA = showcase.locator(`[data-testid="title-slide"][data-sponsor-id="${aId}"]`);
    await expect(async () => {
      await dots.nth(1).click({ timeout: 2_000 });
      await expect(slideB, "B's dot shows B").toHaveAttribute("data-current", "true", { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(slideA, "and A is no longer the current one").toHaveAttribute("data-current", "false");

    // The name on show: the band's sentence, or the panel's caption. At most two lines, ended by a clamp and never cut, with its whole
    // text in `title` and in the DOM.
    const nameEl = phone ? slideB.getByTestId("title-band-sentence") : showcase.getByTestId("title-slide-caption");
    await expect(nameEl).toBeVisible();
    const name = await nameEl.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        height: el.getBoundingClientRect().height,
        lineHeight: parseFloat(cs.lineHeight),
        clamp: cs.webkitLineClamp,
        title: el.getAttribute("title"),
        text: (el.textContent ?? "").trim(),
      };
    });
    expect(Number.isFinite(name.lineHeight), "the name has a computed line height in px").toBe(true);
    // `scrollWidth` and `clientWidth` are integers, the helper's own tolerance is a pixel (`overflowingIn`).
    expect(name.scrollWidth, "no part of the name is cut sideways").toBeLessThanOrEqual(name.clientWidth + 1);
    const lines = Math.round(name.height / name.lineHeight);
    expect(lines, `the 43-character name is drawn in ${lines} line(s)`).toBeGreaterThanOrEqual(1);
    expect(lines, "at most two lines").toBeLessThanOrEqual(2);
    expect(name.clamp, "ended by a two-line clamp, the signalled kind of truncation").toBe("2");
    expect(name.title, "the full text is in its title").toContain(LONG_TITLE_SPONSOR);
    expect(name.text, "and in the DOM").toBe(name.title);

    // Links: B (no url) has no anchor and no Visit; A (a url) has exactly one anchor, and the band's one Visit is A's.
    await expect(slideB.locator("a"), "an unlinked sponsor's slide has no anchor").toHaveCount(0);
    await expect(slideB.getByTestId("title-band-visit"), "and no Visit").toHaveCount(0);
    await expect(slideA.locator("a"), "a linked sponsor's slide has exactly one anchor").toHaveCount(1);
    await expect(band.getByTestId("title-band-visit"), "the band's only Visit is the linked sponsor's").toHaveCount(1);

    await expectNoHorizontalScroll(anon);
    // Hero and band: every scrolling box is a reachable rail (the showcase has none), and nothing is clipped. A scan that found nothing
    // to scan would pass anything, so it must have had boxes.
    for (const root of ['[data-testid="mh-hero"]', '[data-testid="mh-title-band"]']) {
      expect(await anon.locator(root).locator("div,span,p,a,h1,button").count(), `${root}: the scan had boxes to scan`).toBeGreaterThan(0);
      const { clipped, scrollable } = await overflowingIn(anon, root, "div,span,p,a,h1,button", `${root} was not in the DOM`);
      expect(clipped, `${root} is clipped at ${vp!.width}px`).toEqual([]);
      for (const box of scrollable) expect(box, `${root}: a scrolling box is not keyboard-reachable`).toMatch(/tabindex=0$/);
    }

    const axe = await new AxeBuilder({ page: anon }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(
      axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} - ${v.nodes[0]?.html}`),
      "axe serious/critical on the public competition page with a showcase",
    ).toEqual([]);
  } finally {
    await anonCtx.close();
    for (const id of sponsorIds) await apiJson(page.request, `/api/v1/orgs/${org.id}/sponsors/${id}`, "DELETE").catch(() => undefined);
    await apiJson(page.request, `/api/v1/competitions/${comp.data!.id}`, "DELETE").catch(() => undefined);
  }
});

// 2048 mobile swipe: on a real touchscreen the browser decides whether a
// gesture is page-scroll/pan or app-handled AT touchstart, using whatever
// `touch-action` value is ALREADY in effect at that instant -- not a value a
// React re-render commits a few ms later. index.tsx used to flip
// `touchAction` from "auto" to "none" reactively (a `swiping` useState set
// inside onPointerDown), which is always too late: the browser has already
// claimed the gesture as a scroll by the time the state update lands, so
// every swipe on a phone was eaten by the page instead of moving a tile.
// Self-contained: /games/2048 is a static registry page, no auth/org state,
// so this needs none of this file's setup-test fixtures.
//
// ONE gesture on a SEEDED board -- never a retry loop over newGame()'s random
// one. The old version tried up to four directions in turn, and it hung (not
// slow: `page.mouse.move` never returned, so 60s and then #817's 120s budget
// were both exhausted -- CI run 35924224847, mobile-430, trace stuck in the
// SECOND gesture's move for 118s) whenever the first direction was a legal
// no-op, e.g. both opening tiles already flush right (~5% of boards). The
// chain, reproduced locally:
//   1. a `page.mouse` drag is a text-selection drag, so the no-op first
//      gesture left a non-collapsed Selection on the board (empty cells
//      2-2 -> 2-3, reads "\n");
//   2. the second gesture pressed at the SAME start point, inside that
//      selection, so its move began a native selection drag -- at once on
//      Linux (Blink's text-drag delay is 0 there; 150ms on macOS, which is why
//      it never reproduced on a Mac until the button was held 200ms first);
//   3. `dragstart` fired un-prevented and `dragend` in the same millisecond
//      (nothing to drag), and Playwright's drag interception, having seen that
//      dragstart, awaits `Input.dragIntercepted` with no timeout -- an event a
//      drag that never reached the system never sends.
// Not a product defect: the same two gestures sent as raw CDP input (no
// Playwright drag interception) still move the tile. A single gesture on a
// fresh page has no selection to drag, on any platform, so it cannot hang.
test("2048 (mobile swipe bug): touch-action is disabled at rest, and a swipe moves a tile", async ({
  page,
}) => {
  // Two 4s side by side in the top row. A swipe RIGHT merges them into an 8 on
  // the row's far edge (0-3) and scores 8. Nothing else can put an 8 there:
  // left merges at 0-0, down slides both to row 3 unmerged, up is a no-op, and
  // applyMove's spawn only ever writes a 2 or a 4 -- so this also pins the
  // right-swipe mapping, and does not depend on the RNG at all.
  // useGameStore reads storage on mount (the game is client-only), so an init
  // script is early enough.
  const seeded: Game2048State = {
    board: [
      [4, 4, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    score: 0,
    best: 0,
    keepPlaying: false,
  };
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [GAME_2048_STORAGE_KEY, JSON.stringify(seeded)] as const,
  );
  await page.goto("/games/2048", { waitUntil: "load" });
  await dismissCookieBanner(page);
  const area = page.getByTestId("2048-swipe-area");
  await expect(area).toBeVisible();
  const cell = (pos: string) => page.locator(`[data-testid="2048-board"] [data-cell="${pos}"]`);
  const score = page.getByText(/^Score: \d+/);
  // "load" resolves before React mounts the client-only game -- a swipe fired
  // before then lands on markup with no pointer handler attached yet and is
  // silently a no-op. The SEEDED board rendering is the mount witness.
  await expect(cell("0-0")).toHaveAttribute("data-value", "4");
  await expect(cell("0-1")).toHaveAttribute("data-value", "4");
  await expect(score).toHaveText(/^Score: 0 /);

  // The actual regression check: touch-action must already be "none" BEFORE
  // any pointer/touch interaction happens, since that is the only moment the
  // browser consults it for a real touch gesture. Under the old code this is
  // "auto" at rest (swiping starts false) and only becomes "none" once a
  // gesture is already in progress -- too late for the browser's decision.
  await expect(area).toHaveCSS("touch-action", "none");

  // Drive an actual swipe, proving the gesture itself now works end-to-end --
  // not just that the CSS property reads correctly in isolation. onPointerDown/
  // onPointerUp are React pointer handlers (see index.tsx), which Chromium
  // fires from plain mouse-style input same as games.spec.ts's chess-quest
  // drag test already relies on for Board.tsx's pointer handlers.
  const box = await area.boundingBox();
  expect(box, "swipe area has no layout box").not.toBeNull();
  const startX = box!.x + box!.width * 0.5;
  const startY = box!.y + box!.height * 0.5;
  // A real touch's subsequent move/up events keep targeting the element the
  // finger went down on, however far it travels (implicit touch capture --
  // spec-guaranteed). A Playwright `page.mouse` drag has no such capture: it
  // is plain hit-testing, so moving the pointer PAST the wrapper's edge
  // delivers pointerup to whatever element is now underneath instead of this
  // div, and onPointerUp never fires -- a test-only gap, not the app bug.
  // 2048.css fixes the board at exactly 288x288; stay inside it with margin.
  const amp = Math.max(30, Math.min(box!.width, box!.height) / 2 - 20);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Well past swipeTransition's 24px threshold (state.ts).
  await page.mouse.move(startX + amp, startY, { steps: 5 });
  await page.mouse.up();

  await expect(cell("0-3"), "a swipe right did not merge the two 4s on the row's far edge").toHaveAttribute(
    "data-value",
    "8",
  );
  await expect(score).toHaveText(/^Score: 8 /);
});

// 2048 first visit: with nothing stored, useGameStore hands back
// INITIAL_STATE's EMPTY board (it skips `migrate` when the key is unset), and
// only index.tsx's mount effect turns that into a playable game by dealing
// newGame()'s two opening tiles. The swipe test above seeds its own board, so
// it never reaches that path. The effect runs only in a browser -- the
// server-only index.test.tsx can't see it -- so this test is its only
// coverage. No pointer input at all, so it cannot hit the swipe test's old
// mouse-drag hang.
test("2048 (first visit): empty storage deals the opening two tiles", async ({ page }) => {
  // Explicitly empty, whatever the project's storageState carries.
  await page.addInitScript((key) => window.localStorage.removeItem(key), GAME_2048_STORAGE_KEY);
  await page.goto("/games/2048", { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(page.getByTestId("2048-board")).toBeVisible();
  await expect(
    page.locator('[data-testid="2048-board"] [data-value]:not([data-value="0"])'),
    "an empty store never got its opening deal -- the board stays empty and unplayable",
  ).toHaveCount(2);
  await expect(page.getByText(/^Score: \d+/)).toHaveText(/^Score: 0 /);
});

// ── W2d Task 17: the public table's new columns at every width ─────────────────────────────────────────────────────────
//
// SPEC §5.7 (IIHF OTW/OTL, RBG:343-344; chess half-points, D10(b)). One ice hockey league of three under IIHF rules, seeded
// through the real event route: Ash beats Birch in overtime (an OTW for Ash, an OTL for Birch) and Birch beats Cedar in
// regulation. Both public tables — the division page and the hub's Table tab — print OTW and OTL at this width, and the
// OT result is in its own column, not in W. Nothing scrolls the page sideways; the division table's own sideways scroll
// is a reachable rail (a tab stop with a name, AGENTS class 23), never clipped content. This block seeds its own league
// and reads nothing an earlier test left (the file is serial: a red here is a floor for the count, class 21). Its helpers
// are imported inside the test, so the file's import block is untouched.
test("W2d T17 public standings: IIHF OTW/OTL columns on both public tables, no horizontal page scroll", async ({ page, request }) => {
  test.setTimeout(180_000);
  const vp = projectViewport();
  expect(vp, "a width project declares its viewport").not.toBeNull();
  const width = vp!.width;
  const kit = await import("../spectator-w2-kit");
  const org = await kit.activeOrgSlug(request);
  const competition = await kit.publicCompetition(request, { name: `T17 OTW ${TAG} ${width}`, orgId: org.id });
  const div = await kit.division(request, competition.id, { name: "IIHF", sport_key: "icehockey", variant_key: "iihf" });
  const names = [`Ash Otw ${TAG}`, `Birch Otw ${TAG}`, `Cedar Otw ${TAG}`];
  const created = await addEntrantsViaApi(request, div.id, names, "team");
  expect(created.status, "the field was created").toBe(201);
  const [ash, birch, cedar] = created.ids as [string, string, string];
  const fixtures = await kit.leagueFixtures(request, div.id);
  const fx = (x: string, y: string) => {
    const f = fixtures.find((r) => [r.home_entrant_id, r.away_entrant_id].sort().join() === [x, y].sort().join());
    expect(f, "a fixture pairs them").toBeDefined();
    return f!.id;
  };
  const game = async (fixtureId: string, regulation: string[], overtime: string | null) => {
    const s = await kit.eventStream(request, fixtureId);
    await s.post("core.start", {});
    await s.post("icehockey.period.advance", { to: "P2" });
    for (const by of regulation) await s.post("icehockey.goal", { by });
    await s.post("icehockey.period.advance", { to: "P3" });
    await s.post("icehockey.period.advance", { to: "FT" });
    if (overtime !== null) await s.post("icehockey.goal", { by: overtime });
  };
  await game(fx(ash, birch), [ash, birch], ash); // 2-1 in overtime
  await game(fx(birch, cedar), [birch, birch, cedar], null); // 2-1 in regulation
  const otw = kit.dictString("en", "table.abbr.otw");
  const otl = kit.dictString("en", "table.abbr.otl");

  // ── the division page ──
  await page.goto(`/live/${org.slug}/${competition.slug}/${div.slug}?tab=standings`, { waitUntil: "load" });
  const panel = page.locator("#panel-standings");
  await expect(panel).toBeVisible();
  const headers = await panel.locator('thead th span[aria-hidden="true"]').allInnerTexts();
  expect(headers, `the division table's header letters at ${width}px`).toEqual(expect.arrayContaining([otw, otl]));
  const cellsOf = async (name: string) =>
    panel.locator("tbody tr", { hasText: name }).first().locator("td").allInnerTexts();
  const col = (key: string) => headers.indexOf(key);
  // the header letters are the data columns only (# and Team carry none); a body row is td(rank), th(name), then a td per
  // data column — so data column i is td i + 1
  expect(col(otw), "premise: OTW is a column").toBeGreaterThanOrEqual(0);
  const ashCells = await cellsOf(names[0]!);
  expect(ashCells[col(otw) + 1]?.trim(), "Ash's overtime win is in OTW").toBe("1");
  expect(ashCells[col("W") + 1]?.trim(), "…and not in W").toBe("0");
  const birchCells = await cellsOf(names[1]!);
  expect(birchCells[col(otl) + 1]?.trim(), "Birch's overtime loss is in OTL").toBe("1");
  expect(birchCells[col("W") + 1]?.trim(), "Birch's regulation win is in W").toBe("1");
  await expectNoHorizontalScroll(page);
  const { clipped, scrollable } = await overflowingIn(page, "#panel-standings", "table,div,span,th,td", "the standings panel was not in the DOM");
  expect(clipped, `the division table clips content at ${width}px`).toEqual([]);
  for (const box of scrollable) expect(box, "a scrolling box that is not keyboard-reachable").toMatch(/tabindex=0$/);
  // Anti-vacuity (T17 fix 1, m6): at 320 the division table's nine columns do not fit, so the loop above checked a rail.
  if (width <= 320) expect(scrollable.length, "anti-vacuity: the 320 division table scrolls in a rail the loop checked").toBeGreaterThanOrEqual(1);

  // ── the hub's Table tab ──
  await page.goto(`/live/${org.slug}/${competition.slug}?tab=table`, { waitUntil: "load" });
  const hub = page.getByTestId("mh-tab-panel-table");
  await expect(hub).toBeVisible();
  // T17 fix 1 (m2): on a phone the split table shows GP and Pts and folds W · OTW · OTL · L behind "Show all columns";
  // from md up nothing folds. Points stays on screen, inside the table's box, without a swipe (AGENTS #22: open the fold
  // only when its toggle is visible — at 768/834 it is md:hidden).
  const pts = hub.locator('th[data-col="points"]').first();
  await expect(pts).toBeVisible();
  const box = await hub.getByTestId(/-scroll$/).first().boundingBox();
  const ptsBox = await pts.boundingBox();
  expect(box && ptsBox, "the hub table and its Points header have boxes").toBeTruthy();
  expect(ptsBox!.x + ptsBox!.width, `Points ends inside the table's box at ${width}px`).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
  const more = hub.locator('[data-testid$="-more"]').first();
  if (await more.isVisible()) {
    await expect(hub.locator('th[data-col="otw"]').first(), "folded on a phone until asked").toBeHidden();
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
  }
  await expect(hub.locator('th[data-col="otw"]').first()).toBeVisible();
  await expect(hub.locator('th[data-col="otl"]').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  console.log(`[t17-otw ${width}px] division headers ${headers.join(" ")}; Ash ${ashCells.join(" ")}; scrollable ${scrollable.length}`);
});
