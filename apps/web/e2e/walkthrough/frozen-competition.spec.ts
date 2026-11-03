import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  competitionPath,
  createStageAndGenerate,
  expectNoHorizontalScroll,
  invalidateOrgEntitlements,
  loginUi,
  seedVenueWithCourts,
  setEntitlementOverrideSql,
  setOrgPlanBySql,
  withDb,
} from "../helpers";
import { dismissConsent, freshOrg } from "../directory-kit";
import { middayZoneFor, withinToday } from "../midday-zone";

/**
 * Walkthrough — a BILLING-FROZEN competition on its match day (Match Day PB2, owner rulings 2026-11-02: "apply rec" — a
 * frozen competition still scores — and "hide" — it connects no new stream). The organisation is over its plan's
 * `competitions.max_active`, so the day can no longer be RUN from Match Day (no Call, no Undo call, no "+ Connect a stream"),
 * but the matches already on court must still be scoreable, by the organiser's own pad and by a scorer's QR.
 *
 * One person per step, by hand:
 *   1. SETUP (the API, as the organiser's own session): a Pro organisation of its own — the freeze is organisation-wide and
 *      the shared e2e organisation must never freeze — with three courts: Court 1 PLAYING (a real core.start), Court 2 CALLED
 *      (called before the freeze, so an Undo call would be offered if the freeze did not take it away), Court 3 FREE (its
 *      candidates list, so a Call would be offered), and one match whose window closed hours ago with no result (a
 *      Needs-you row, so the viewer's empty list in step 5 is a strip and not an empty day). Then a second, newer competition
 *      and the freeze: a limit of one.
 *   2. The organiser opens Match Day by TAPPING the competition page's door: the frozen notice; Needs you; Court 2 called
 *      with no Undo; Court 3's candidates with no Call; Court 1's scoreboard with no "+ Connect a stream", "Open pad", and a
 *      scorer QR that mints and shows.
 *   3. The organiser taps Open pad and scores a point by tapping the pad; the point is in the ledger, on Match Day (Court 1's
 *      row and scoreboard) and on the fixture page opened again from Match Day.
 *   4. The TERMINAL state (fix round 1, I2): on that same pad the organiser taps "Finish from tally" (the result is the 1–0 on
 *      the board), then "Finalize result". The match is finalized in the record; the fixture page says so (status, the 1 — 0
 *      headline, no pad left to tap); and Match Day, opened again by tapping its door, has let Court 1 go — free, nothing
 *      playing, and the finished match is no longer one of the court's candidates.
 *   5. A view-only member signs in, opens Match Day by tapping the same door, and sees the board — Court 1 free after the
 *      finish — but no Needs you.
 * At 1280 and at 320, with no sideways scroll at any step.
 *
 * The freeze is a REAL limit the competition can rotate under (review C1, fixed: the frozen set is chosen once and stored,
 * the competition_frozen_at migration): the organisation keeps Pro (the scorer QR is Pro's — on Community it is the plan's paywall) with its
 * `competitions.max_active` set to 1, and a second, newer competition holds the one running place. Before C1's fix the pad's
 * first point made this competition the most recently active, thawed it and froze the other; so after every point and after
 * the finish, Match Day still says frozen and the stored set is still this competition alone.
 */

const UI_EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

const WIDTHS = [
  { width: 1280, height: 900 },
  { width: 320, height: 640 },
] as const;

interface FrozenSeed {
  orgId: string;
  competitionId: string;
  courts: { playing: string; called: string; free: string };
  /** Ana v Ben, in play on the playing court. */
  playingFixture: string;
  /** Ana's and Ben's names, as seeded. */
  playingNames: [string, string];
}

/** Steps 1's seed, through the organiser's own session (so every row is the organisation's). Not frozen yet: the caller
 *  freezes after the call, which the freeze would refuse. */
async function seedFrozenDay(request: APIRequestContext, orgId: string, label: string): Promise<FrozenSeed> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Frozen ${label} ${TAG}`,
    visibility: "public",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBe(201);
  const competitionId = comp.data!.id;
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
    name: "Open singles",
    sport_key: "generic",
    variant_key: "score",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBe(201);
  const divisionId = div.data!.id;
  const nonce = Math.random().toString(36).slice(2, 7);
  const names = ["Ana", "Ben", "Cal", "Dee", "Eve", "Fay"].map((n) => `${n} ${label} ${nonce}`);
  const ents = await addEntrantsViaApi(request, divisionId, names);
  expect(ents.ids.length, `entrants -> ${ents.status}`).toBe(6);
  const [ana, ben, cal, dee, eve, fay] = ents.ids as [string, string, string, string, string, string];
  await createStageAndGenerate(request, divisionId);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);

  const { courts } = await seedVenueWithCourts(
    request,
    [`FZ1 ${label} ${nonce}`, `FZ2 ${label} ${nonce}`, `FZ3 ${label} ${nonce}`],
    { orgId },
  );
  const [c1, c2, c3] = [courts[0]!, courts[1]!, courts[2]!];
  // The division plans in the zone where the real clock reads midday, so the board's "today" holds every seeded instant at every hour of
  // the run; `within` refuses an offset that would leave that day rather than clamping it (e2e/midday-zone.ts, PB3 review m2).
  const now = Date.now();
  const zone = middayZoneFor(now);
  const within = withinToday(now, zone);
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: zone,
    config: { matchMinutes: 30, courts: [c1.id, c2.id, c3.id] },
  });
  expect(settings.status, `schedule settings: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
  const pair = await withDb(async (sql) => {
    const rows = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where division_id = ${divisionId}`;
    return (a: string, b: string): string => {
      const f = rows.find((r) => (r.home_entrant_id === a && r.away_entrant_id === b) || (r.home_entrant_id === b && r.away_entrant_id === a));
      if (!f) throw new Error(`no fixture between ${a} and ${b}`);
      return f.id;
    };
  });
  const anaBen = pair(ana, ben);
  const calDee = pair(cal, dee);
  const eveFay = pair(eve, fay);
  // Placement is the seed, not the behaviour: straight to the rows, as the board would have left them.
  await withDb(async (sql) => {
    await sql`update fixtures set court_id = ${c1.id}, scheduled_at = ${within(-20)} where id = ${anaBen}`;
    await sql`update fixtures set court_id = ${c2.id}, scheduled_at = ${within(30)} where id = ${calDee}`;
    // A window that closed three hours ago, on no court, no result: the organiser's Needs-you row (the desk's result_missing).
    await sql`update fixtures set court_id = null, scheduled_at = ${new Date(now - 3 * 3_600_000).toISOString()} where id = ${eveFay}`;
  });
  // Court 1 in play for real: a core.start through the engine, the way a scorer's pad starts a match.
  const start = await apiJson(request, `/api/v1/fixtures/${anaBen}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(start.status, `core.start: ${JSON.stringify(start.error)}`).toBeLessThan(300);
  // Court 2 called while the competition can still be run: the state an Undo call would undo.
  const call = await apiJson(request, `/api/v1/fixtures/${calDee}/call`, "POST", { court_id: c2.id });
  expect(call.status, `call (before the freeze): ${JSON.stringify(call.error)}`).toBeLessThan(300);

  return {
    orgId,
    competitionId,
    courts: { playing: c1.name, called: c2.name, free: c3.name },
    playingFixture: anaBen,
    playingNames: [names[0]!, names[1]!],
  };
}

const courtRow = (page: Page, name: string): Locator => page.getByTestId("md-court-row").filter({ hasText: name });

/** Tap a court in the list. On a phone the focused court REPLACES the list, so the person taps Back to the list first. */
async function openCourt(page: Page, name: string, state: "playing" | "called" | "free"): Promise<Locator> {
  const back = page.getByTestId("md-back");
  if (await back.isVisible()) await back.click();
  await courtRow(page, name).click();
  const focus = page.getByTestId("md-focus");
  await expect(focus).toHaveAttribute("data-state", state);
  await expect(focus).toBeVisible();
  return focus;
}

/** Once the finish leaves two courts free beside a busy one, the list folds them under one row: tap it open (it must be there). */
async function openFreeFold(page: Page): Promise<void> {
  const toggle = page.getByTestId("md-court-fold-toggle");
  await expect(toggle, "the free courts sit under the fold row").toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/** The competition page's Match Day door, TAPPED — the way the organiser (and the viewer) arrive. */
async function openMatchDayByTapping(page: Page, compPath: string): Promise<void> {
  await page.goto(compPath, { waitUntil: "load" });
  await page.getByTestId("desk-tool-match-day").click();
  await expect(page).toHaveURL(/\/match-day$/);
  await expect(page.getByTestId("md-header")).toBeVisible({ timeout: 30_000 });
}

/** The pad's big figure on one half: the tabular-nums display under the side's label (scorebug.tsx `HalfContent`). */
const halfFigure = (half: Locator): Locator => half.locator('div[style*="tabular-nums"]').first();

/** A view-only member of the organisation, signed in on a page of their own (match-day.spec.ts's `viewerPage`). */
async function viewerPage(browser: Browser, orgId: string, viewport: { width: number; height: number }) {
  const tag = Math.random().toString(36).slice(2, 8);
  const email = `delivered+fz-viewer-${TAG}-${tag}@resend.dev`;
  let userId = "";
  await withDb(async (sql) => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${"Frozen Viewer " + tag}, true) returning id`;
    userId = u!.id;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'viewer')`;
  });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport });
  const page = await context.newPage();
  await loginUi(page, email);
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
  await dismissConsent(page);
  return {
    page,
    close: async () => {
      try {
        await context.close();
      } finally {
        await withDb((sql) => sql`delete from org_members where org_id = ${orgId} and user_id = ${userId}`);
      }
    },
  };
}

for (const vp of WIDTHS) {
  test(`a frozen competition at ${vp.width}: the organiser taps into Match Day (no Call, no Undo, no new stream; Open pad and the scorer QR), scores a point on the pad that lands on Match Day and the fixture page, finishes and finalizes the match on the pad (finalized on the fixture page, Court 1 freed on Match Day); a viewer sees no Needs you`, async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: vp });
    try {
      const page = await context.newPage();

      // 1. SETUP — an organisation of its own, Pro (so the scorer QR is a QR, not the plan's paywall), seeded, then frozen.
      const { orgId } = await freshOrg(page, `fz${vp.width}`);
      await dismissConsent(page);
      await setOrgPlanBySql({ orgId }, "pro");
      await invalidateOrgEntitlements(page.request, orgId);
      const seed = await seedFrozenDay(page.request, orgId, `W${vp.width}`);
      // The other competition, created after the seed's core.start: the more recently active of the two, so a limit of one
      // keeps it running and freezes this one.
      const other = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
        ends_on: "2030-12-31",
        name: `Running ${vp.width} ${TAG}`,
        visibility: "private",
      });
      expect(other.status, `the running competition: ${JSON.stringify(other.error)}`).toBe(201);
      await setEntitlementOverrideSql(orgId, "competitions.max_active", 1);
      await invalidateOrgEntitlements(page.request, orgId);
      const storedFrozen = () =>
        withDb(async (sql) =>
          (await sql<{ id: string }[]>`select id from competitions where org_id = ${orgId} and frozen_at is not null`).map((r) => r.id),
        );
      const compPath = await competitionPath(page.request, seed.competitionId);
      const ledgerPoints = () =>
        withDb(async (sql) => (await sql<{ n: number }[]>`
          select count(*)::int as n from score_events where fixture_id = ${seed.playingFixture} and type = 'generic.score'`)[0]!.n);
      expect(await ledgerPoints(), "premise: nothing scored before the pad").toBe(0);

      // 2. The organiser opens Match Day by tapping its door, and reads what a frozen competition leaves them.
      await openMatchDayByTapping(page, compPath);
      await expect(page.getByTestId("md-frozen"), "the frozen notice says what still works").toHaveText(UI_EN["matchDay.frozen"]!);
      expect(await storedFrozen(), "the freeze chose this competition, and stored it").toEqual([seed.competitionId]);
      await expect(page.getByTestId("md-needs-you-toggle"), "the organiser has a Needs-you list (step 5's positive pair)").toBeVisible();
      await expect(page.getByTestId("md-court-row")).toHaveCount(3);
      await expectNoHorizontalScroll(page);

      // Court 2 — called before the freeze: still called, and no Undo call.
      const called = await openCourt(page, seed.courts.called, "called");
      await expect(called.getByTestId("md-called-panel")).toBeVisible();
      await expect(called.getByTestId("md-undo-call"), "no Undo call on a frozen competition").toHaveCount(0);
      await expect(called).not.toContainText(UI_EN["matchDay.called.undo"]!);
      await expectNoHorizontalScroll(page);

      // Court 3 — free: its candidates are listed, and none can be called.
      const free = await openCourt(page, seed.courts.free, "free");
      const candidates = free.getByTestId("md-candidate");
      await expect(candidates.first()).toBeVisible();
      expect(await candidates.count(), "candidates checked for a Call button").toBeGreaterThan(0);
      await expect(free.getByRole("button", { name: /^Call to / }), "no Call on a frozen competition").toHaveCount(0);
      await expectNoHorizontalScroll(page);

      // Court 1 — playing: the scoreboard, no "+ Connect a stream", Open pad, and a scorer QR that mints and shows.
      let playing = await openCourt(page, seed.courts.playing, "playing");
      await expect(playing.getByTestId("md-scoreboard")).toBeVisible();
      await expect(playing.getByTestId("md-stream-connect"), "no new stream on a frozen competition").toHaveCount(0);
      await expect(playing).not.toContainText(UI_EN["matchDay.stream.connect"]!);
      await expect(playing.getByTestId("md-open-pad")).toHaveText(UI_EN["matchDay.focus.openPad"]!);
      const scorer = playing.getByTestId("md-scorer");
      await expect(scorer).toBeVisible();
      const mint = scorer.getByTestId("device-link-mint").or(scorer.getByTestId("device-link-row-create")).first();
      await mint.click();
      const qr = scorer.getByTestId("dlink-qr");
      const showQr = scorer.getByTestId("device-link-show");
      await expect(qr.or(showQr).first()).toBeVisible({ timeout: 15_000 });
      if (!(await qr.isVisible())) await showQr.click();
      await expect(qr, "the scorer's QR shows").toBeVisible({ timeout: 15_000 });
      await expectNoHorizontalScroll(page);

      // 3. Open pad → the fixture page's pad; one tap on the home half, and the point lands.
      await playing.getByTestId("md-open-pad").click();
      await expect(page).toHaveURL(/\/f\/\d+$/);
      const home = page.locator('[data-role="v3-scorebug"] [data-role="v3-scorebug-half"]').nth(0);
      await expect(home).toBeVisible({ timeout: 30_000 });
      await expect(home, "the pad can be tapped on a frozen competition").not.toHaveAttribute("aria-disabled", "true");
      await expectNoHorizontalScroll(page);
      await home.click();
      await expect(halfFigure(home), "the tap shows on the pad").toHaveText("1");
      await expect.poll(ledgerPoints, { timeout: 30_000, message: "the tapped point reaches the ledger" }).toBe(1);

      // ...on Match Day: Court 1's row and its scoreboard read the point (a fresh read of the board) — and the competition is
      // still frozen: the point made it the most recently active, and the freeze did not move (C1).
      await openMatchDayByTapping(page, compPath);
      await expect(page.getByTestId("md-frozen"), "a point scored does not thaw it (C1)").toBeVisible();
      expect(await storedFrozen(), "nor freeze the other competition in its place").toEqual([seed.competitionId]);
      await expect(courtRow(page, seed.courts.playing).locator("[data-md-row-score]"), "Court 1's row reads the point").toHaveText(/^1\D+0$/);
      playing = await openCourt(page, seed.courts.playing, "playing");
      // Anchored on the scoreboard's own headline figure (fix round 1, m1): a bare "1" is in the court's name and the clock.
      await expect(playing.getByTestId("md-scoreboard").getByTestId("ls-score-large"), "Court 1's scoreboard reads the point").toHaveText(
        /^1\D+0$/,
      );
      await expectNoHorizontalScroll(page);

      // ...and on the fixture page, opened again from Match Day: the pad loads with the point already on it.
      await playing.getByTestId("md-open-pad").click();
      const homeAgain = page.locator('[data-role="v3-scorebug"] [data-role="v3-scorebug-half"]').nth(0);
      await expect(homeAgain).toBeVisible({ timeout: 30_000 });
      await expect(halfFigure(homeAgain), "the fixture page reloads the point from the record").toHaveText("1");
      expect(await ledgerPoints(), "one tap, one point").toBe(1);

      // 4. The terminal state, by tapping: "Finish from tally" records the 1–0 on the board as the result, then "Finalize result".
      const fixtureStatus = () =>
        withDb(async (sql) => (await sql<{ status: string }[]>`select status from fixtures where id = ${seed.playingFixture}`)[0]!.status);
      expect(await fixtureStatus(), "premise: still in play before the finish").toBe("in_play");
      const settle = page.locator('[data-tile-id="settle"]');
      await expect(settle, "the pad offers the tally's own finish").toBeVisible();
      await expect(settle, "the finish names the score it records").toContainText(/1\D+0/);
      await expectNoHorizontalScroll(page);
      await settle.click();
      await expect.poll(fixtureStatus, { timeout: 30_000, message: "Finish from tally decides the frozen match" }).toBe("decided");
      const finalize = page.getByTestId("score-finalize");
      await expect(finalize).toHaveText(UI_EN["score.finalize"]!);
      await expectNoHorizontalScroll(page);
      await finalize.click();
      await expect.poll(fixtureStatus, { timeout: 30_000, message: "Finalize result finalizes the frozen match" }).toBe("finalized");
      expect(
        await withDb(async (sql) =>
          (await sql<{ type: string }[]>`
            select type from score_events where fixture_id = ${seed.playingFixture} and type in ('generic.result', 'core.finalize') order by seq`).map(
            (r) => r.type,
          ),
        ),
        "the finish and the finalize are in the record, once each",
      ).toEqual(["generic.result", "core.finalize"]);
      // ...on the fixture page: finalized, the 1 — 0 headline, and no pad left to tap.
      await expect(page.locator("main h1 + span.badge"), "the fixture page says finalized").toHaveText(UI_EN["score.status.finalized"]!);
      await expect(page.locator("main p.font-mono").first(), "the fixture page's headline is the result").toHaveText(/^1\D+0$/);
      await expect(page.locator('[data-role="v3-scorebug"]'), "a finalized match has no pad").toHaveCount(0);
      await expect(page.getByTestId("score-finalize")).toHaveCount(0);
      await expectNoHorizontalScroll(page);

      // ...and on Match Day, opened again by tapping its door: Court 1 is let go — free, nothing playing, and the finished match
      // is no longer among the court's candidates. With Court 2 the only court busy, the two free ones now sit under the list's
      // one "more courts free" row (`foldFreeCourts`), which the organiser taps open.
      await openMatchDayByTapping(page, compPath);
      await expect(page.getByTestId("md-frozen"), "finished and finalized, still frozen (C1)").toBeVisible();
      expect(await storedFrozen()).toEqual([seed.competitionId]);
      await expect(page.getByTestId("md-counts")).toContainText(UI_EN["matchDay.header.playing"]!.replace("{count}", "0"));
      await openFreeFold(page);
      const court1Row = courtRow(page, seed.courts.playing);
      await expect(court1Row, "the finished match freed Court 1").toHaveAttribute("data-state", "free");
      await expect(court1Row.locator("[data-md-row-score]"), "a free court carries no score").toHaveCount(0);
      const freed = await openCourt(page, seed.courts.playing, "free");
      await expect(freed.getByTestId("md-candidate").first(), "Court 1 lists what could go on next").toBeVisible();
      // The PAIR, not either name: Ana and Ben each still have other matches in this league to offer.
      const [ana, ben] = seed.playingNames;
      await expect(
        freed.getByTestId("md-candidate").filter({ hasText: ana }).filter({ hasText: ben }),
        "the finished Ana v Ben is not offered again",
      ).toHaveCount(0);
      await expectNoHorizontalScroll(page);

      // 5. A view-only member opens Match Day by tapping the same door: the board (Court 1 free after the finish), and no Needs you.
      const viewer = await viewerPage(browser, orgId, vp);
      try {
        const v = viewer.page;
        await openMatchDayByTapping(v, compPath);
        await expect(v.getByTestId("md-read-only")).toBeVisible();
        await openFreeFold(v);
        await expect(v.getByTestId("md-court-row"), "the viewer reads the same board").toHaveCount(3);
        await expect(courtRow(v, seed.courts.playing), "the viewer sees Court 1 freed too").toHaveAttribute("data-state", "free");
        await expect(v.getByTestId("md-needs-you-toggle"), "no Needs-you list for a viewer").toHaveCount(0);
        await expect(v.getByTestId("md-needs-you")).toHaveCount(0);
        await expectNoHorizontalScroll(v);
      } finally {
        await viewer.close();
      }
    } finally {
      await context.close();
    }
  });
}
