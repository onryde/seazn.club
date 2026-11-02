import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import {
  TAG,
  activeOrg,
  addEntrantsViaApi,
  apiJson,
  competitionPath,
  createStageAndGenerate,
  expectNoHorizontalScroll,
  invalidateOrgEntitlements,
  loginUi,
  scoreFixture,
  seedVenueWithCourts,
  setEntitlementOverrideSql,
  setOrgPlanBySql,
  withDb,
} from "./helpers";
import { dismissConsent, freshOrg } from "./directory-kit";

/**
 * Match Day, task A3 (spec docs/superpowers/specs/2026-10-31-match-day-design.md §6, §7): the court list and the focused
 * court, driven in a real browser — what the node-environment SSR suite cannot see: the free court FETCHING its candidates,
 * the call sheet's preview → confirm round trip, the court turning "Called" from the shell's own refresh, and Undo call
 * putting the match back where it was.
 *
 * The seed is two courts of one competition (a generic/score league of four players, the division's schedule settings naming
 * exactly those two courts and planning in UTC):
 *   - Court 1: Ana v Ben IN PLAY (planned 40 minutes ago, a real core.start), and Ana v Cal queued behind it, planned 10
 *     minutes ago — a late-running court, as a real day looks;
 *   - Court 2: free, with Cal v Dee planned on it later today.
 * So Court 2's candidates are Cal v Dee first (its own next match, both players free), Ana v Cal greyed (Ana is on Court 1)
 * and the unplaced rest, every one of which has Ana or Ben in it, greyed too. Times sit inside today's UTC day whatever the
 * clock says, so the run never straddles a midnight.
 *
 * Task A4 adds the `needsYou` seed: two more players (Eve, Fay) and a third court, so that
 *   - Court 3: Eve v Fay IN PLAY with nothing recorded and no scorer named — the desk's red `no_scorer`, which marks the
 *     court's row;
 *   - Ben v Dee: planned three hours ago, on no court, no result — the desk's `result_missing`, which the header's
 *     Needs-you list puts FIRST even though the red row outranks it on the desk.
 * Eve and Fay play nobody else on the board, so Court 2's own candidates are what the A3 tests already pin.
 *
 * Task B1 adds the `quiet` seed: the same board with Ana v Ben NOT started — nothing playing, so the shell polls on its quiet
 * cadence — for the two tests that moved here from the retired desk-in-play-band.spec.ts (the board's own polls).
 */

interface Seed {
  competitionId: string;
  court1: string;
  court2: string;
  /** The `needsYou` seed's third court (Eve v Fay in play, unscored); null otherwise. */
  court3: string | null;
  /** The courts' ids, for a write sent straight to a route (B4's read-only refusals). */
  court1Id: string;
  court2Id: string;
  divisionId: string;
  /** Ana v Ben: on Court 1, in play (a real core.start) unless the seed is `quiet`. */
  anaBen: string;
  /** Cal v Dee: Court 2's own next match, the top candidate. */
  calDee: string;
  /** Ana v Cal: queued on Court 1, blocked by Ana. */
  anaCal: string;
  names: { ana: string; ben: string; cal: string; dee: string };
}

async function seedMatchDay(
  request: APIRequestContext,
  label: string,
  opts: { needsYou?: boolean; quiet?: boolean } = {},
): Promise<Seed> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Match Day ${label} ${TAG}`,
    visibility: "public",
  });
  if (comp.status >= 300 || !comp.data) throw new Error(`competition → ${comp.status} ${JSON.stringify(comp.error)}`);
  const competitionId = comp.data.id;
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
    name: "Open singles",
    sport_key: "generic",
    variant_key: "score",
  });
  if (div.status >= 300 || !div.data) throw new Error(`division → ${div.status} ${JSON.stringify(div.error)}`);
  const divisionId = div.data.id;
  // A nonce per seed: a retry in the same run (same TAG) must not meet the first attempt's players — a busy judge reads the
  // whole organisation's held matches, and persons are the organisation's.
  const nonce = Math.random().toString(36).slice(2, 7);
  const names = { ana: `Ana ${label} ${nonce}`, ben: `Ben ${label} ${nonce}`, cal: `Cal ${label} ${nonce}`, dee: `Dee ${label} ${nonce}` };
  const extra = opts.needsYou ? [`Eve ${label} ${nonce}`, `Fay ${label} ${nonce}`] : [];
  const ents = await addEntrantsViaApi(request, divisionId, [names.ana, names.ben, names.cal, names.dee, ...extra]);
  if (ents.status >= 300 || ents.ids.length !== 4 + extra.length) throw new Error(`entrants → ${ents.status}`);
  const [ana, ben, cal, dee, eve, fay] = ents.ids as [string, string, string, string, string?, string?];
  await createStageAndGenerate(request, divisionId);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);

  const { courts } = await seedVenueWithCourts(request, [
    `MD1 ${label} ${nonce} ${TAG}`,
    `MD2 ${label} ${nonce} ${TAG}`,
    ...(opts.needsYou ? [`MD3 ${label} ${nonce} ${TAG}`] : []),
  ]);
  const [court1, court2] = [courts[0]!, courts[1]!];
  const court3 = opts.needsYou ? courts[2]! : null;
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: { matchMinutes: 30, courts: [court1.id, court2.id, ...(court3 ? [court3.id] : [])] },
  });
  expect(settings.status, `schedule settings: ${JSON.stringify(settings.error)}`).toBeLessThan(300);

  // Today's UTC day, and an instant inside it near now (clamped a minute inside either end).
  const now = Date.now();
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const within = (offsetMin: number) =>
    new Date(Math.min(dayStart + 86_400_000 - 60_000, Math.max(dayStart + 60_000, now + offsetMin * 60_000))).toISOString();

  const fixtureOf = await withDb(async (sql) => {
    const rows = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where division_id = ${divisionId}`;
    return (a: string, b: string): string => {
      const f = rows.find((r) => (r.home_entrant_id === a && r.away_entrant_id === b) || (r.home_entrant_id === b && r.away_entrant_id === a));
      if (!f) throw new Error(`no fixture between ${a} and ${b}`);
      return f.id;
    };
  });
  const anaBen = fixtureOf(ana, ben);
  const anaCal = fixtureOf(ana, cal);
  const calDee = fixtureOf(cal, dee);
  // Placing is seed, not the behaviour under test: straight to the rows, as the board would have left them.
  await withDb(async (sql) => {
    await sql`update fixtures set court_id = ${court1.id}, scheduled_at = ${within(-40)} where id = ${anaBen}`;
    await sql`update fixtures set court_id = ${court1.id}, scheduled_at = ${within(-10)} where id = ${anaCal}`;
    await sql`update fixtures set court_id = ${court2.id}, scheduled_at = ${within(5)} where id = ${calDee}`;
  });
  // In play for real: a core.start through the engine, never a status patch. A quiet board leaves it to the test.
  if (!opts.quiet) await startFixture(request, anaBen);

  if (court3 !== null) {
    const eveFay = fixtureOf(eve!, fay!);
    const benDee = fixtureOf(ben, dee);
    await withDb(async (sql) => {
      // Court 3: in play with NOTHING recorded and no scorer — the state a phone that never opened the pad leaves. A status
      // patch on purpose: a core.start would be a recorded event, and the desk's no_scorer asks for none. Kicked off 5
      // minutes ago — INSIDE the desk's not_recording grace (15), on purpose: no_scorer has no clock, so the mark shows the
      // same, and once a link is made the match has a scorer and is not yet late, so the court carries NO mark at all.
      // Past the grace it would turn amber not_recording instead (pinned in competition-desk.test.ts, I1).
      await sql`update fixtures set court_id = ${court3.id}, scheduled_at = ${within(-5)}, status = 'in_play' where id = ${eveFay}`;
      // Ben v Dee: its window closed hours ago, on no court, no result. Not clamped to today: the desk owes a result whatever
      // day the window closed on.
      await sql`update fixtures set court_id = null, scheduled_at = ${new Date(now - 3 * 3_600_000).toISOString()} where id = ${benDee}`;
    });
  }

  return {
    competitionId,
    court1: court1.name,
    court2: court2.name,
    court3: court3?.name ?? null,
    court1Id: court1.id,
    court2Id: court2.id,
    divisionId,
    anaBen,
    calDee,
    anaCal,
    names,
  };
}

/** A real core.start through the engine — the way a scorer's pad starts a match, never a status patch. */
async function startFixture(request: APIRequestContext, fixtureId: string): Promise<void> {
  const start = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(start.status, `core.start: ${JSON.stringify(start.error)}`).toBeLessThan(300);
}

const row = (page: Page, courtName: string) => page.getByTestId("md-court-row").filter({ hasText: courtName });

/** A middle-dot line (`DotLine`, match-day-shell.tsx) never shows a dot at the start of a line: every dot still on screen
 *  follows a part on its own line, and the dot of a part that starts a line is clipped by the box. Returns how many parts it
 *  checked (anti-vacuity: the caller asserts it). */
async function expectNoDanglingDot(box: Locator): Promise<number> {
  const r = await box.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const parts = [...el.querySelectorAll<HTMLElement>(":scope > [data-dot-part]")];
    const dangling: string[] = [];
    let clipped = 0;
    parts.forEach((p, i) => {
      const dot = p.querySelector<HTMLElement>("[data-dot]")!.getBoundingClientRect();
      if (dot.right <= b.left + 0.5) {
        clipped++;
        return;
      }
      const prev = i === 0 ? null : parts[i - 1]!.getBoundingClientRect();
      if (prev === null || Math.abs(prev.top - p.getBoundingClientRect().top) > 2) dangling.push(p.textContent ?? "");
    });
    return { parts: parts.length, clipped, dangling };
  });
  expect(r.dangling, "a dot opens a line").toEqual([]);
  // The first part's dot is always clipped: the line starts with words, not a separator.
  expect(r.clipped).toBeGreaterThanOrEqual(1);
  return r.parts;
}

/** The header's Needs-you button opens the desk's own list with the owed result FIRST (the desk itself puts the red
 *  no_scorer row first). Court 3 is unscored: marked on its row and on its "Remote scoring" heading, and its panel starts open.
 *  Creating the link mints the QR - and a live link IS a scorer (the desk, fix round 1 I1), so the mark goes from the heading
 *  and the row at once. A second visit (`minted`) finds no mark, and the panel hidden to its row (Show QR, not a second Create). */
async function needsYouAndScorer(page: Page, seed: Seed, minted = false): Promise<void> {
  const toggle = page.getByTestId("md-needs-you-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText(/\d+ needs? you/);
  await expect(toggle).toContainText("1 result owed");
  await expect(toggle).toHaveAttribute("data-severity", "red");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
  const checked =
    (await expectNoDanglingDot(page.getByTestId("md-counts"))) +
    (await expectNoDanglingDot(toggle.locator("span:has(> [data-dot-part])")));
  expect(checked, "dot parts checked").toBeGreaterThanOrEqual(5);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const list = page.getByTestId("md-needs-you");
  await expect(list).toBeVisible();
  const rows = list.locator("[data-attention]");
  await expect(rows.first()).toHaveAttribute("data-attention", "result_missing");
  await expect(rows.first()).toContainText("Enter result");
  await expect(rows.first()).toContainText(seed.names.ben);
  await expect(list.locator('[data-attention="no_scorer"]')).toHaveCount(1);
  await expectNoHorizontalScroll(page);
  await toggle.click();
  await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);

  // Court 2 is free: nothing in play, nothing to mark.
  const r3 = row(page, seed.court3!);
  await expect(row(page, seed.court2)).toHaveAttribute("data-state", "free");
  await expect(row(page, seed.court2)).not.toHaveAttribute("data-scorer", /.+/);
  if (minted) {
    // Its link is live from the first visit: a scorer, so no mark.
    await expect(r3).not.toHaveAttribute("data-scorer", /.+/);
  } else {
    await expect(r3).toHaveAttribute("data-scorer", "no_scorer");
    await expect(r3).toContainText("No scorer");
  }

  await r3.click();
  const focus = page.getByTestId("md-focus");
  await expect(focus).toHaveAttribute("data-state", "playing");
  // E2 item 6: a playing court's Remote scoring is HIDEABLE. The desk says nobody scores Court 3, so its panel starts OPEN with
  // Hide beside the heading and the mark on it; with a live link (a second visit) nothing is flagged and it starts HIDDEN, as one row.
  const scorer = focus.getByTestId("md-scorer");
  const panel = scorer.locator('[data-role="device-link-panel"]');
  await expect(scorer.getByRole("heading", { name: "Remote scoring" })).toBeVisible();
  const mark = scorer.locator('[data-md-scorer="no_scorer"]');
  if (minted) {
    await expect(panel).toHaveAttribute("data-hide-state", "hidden");
    await expect(mark).toHaveCount(0);
    await expect(scorer.getByTestId("device-link-row-state")).toContainText("Scorer link ready");
    await expect(scorer.getByTestId("device-link-row-copy")).toBeVisible();
    // The body is not there to see: no QR, no create button, no More fold.
    await expect(scorer.getByTestId("dlink-qr")).toHaveCount(0);
    await expect(scorer.getByTestId("device-link-more")).toHaveCount(0);
    await scorer.getByTestId("device-link-row-show").click();
    await expect(panel).toHaveAttribute("data-hide-state", "open");
  } else {
    await expect(panel).toHaveAttribute("data-hide-state", "open");
    await expect(mark).toBeVisible();
    await expect(scorer.getByTestId("device-link-hide")).toBeVisible();
    // A4 n1 (task B4): the panel's own "More" fold is a NAMED group - its chevron turns on More's own open only.
    await expect(scorer.getByTestId("device-link-more")).not.toHaveAttribute("open", /.*/);
    await expect(scorer.getByTestId("device-link-more").locator(":scope > summary svg")).toHaveCSS("rotate", "none");
    await expect(scorer.getByTestId("device-link-mint")).toBeVisible();
    await scorer.getByTestId("device-link-mint").click();
  }
  await expect(scorer.getByTestId("dlink-qr")).toBeVisible({ timeout: 15_000 });
  // Compact: Copy beside the QR; the raw link behind More, closed.
  await expect(scorer.getByTestId("device-link-copy")).toBeVisible();
  await expect(scorer.getByTestId("device-link-url")).toBeAttached();
  await expect(scorer.getByTestId("device-link-url")).toBeHidden();
  if (!minted) {
    // The link is a scorer: the panel re-reads the board, and the mark goes from the heading AND the row - well inside the
    // 20 s live poll, so it is the re-read that moved it, not the next tick. The panel the organiser is using stays open.
    await expect(mark).toHaveCount(0, { timeout: 5_000 });
    await expect(r3).not.toHaveAttribute("data-scorer", /.+/, { timeout: 5_000 });
    await expect(panel).toHaveAttribute("data-hide-state", "open");
    await expect(scorer.getByTestId("dlink-qr")).toBeVisible();
  }
  await expectNoHorizontalScroll(page);
}

/** Calls Court 2's top candidate through the sheet (its knock-on preview first) and waits for the court to read "Called". */
async function callTop(page: Page, seed: Seed): Promise<void> {
  const focus = page.getByTestId("md-focus");
  const top = focus.locator(`[data-testid="md-candidate"][data-fixture-id="${seed.calDee}"]`);
  // The one primary action on the list (review V2).
  await expect(focus.locator('[data-md-primary="true"]')).toHaveCount(1);
  await top.getByRole("button", { name: `Call to ${seed.court2}` }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText(`Call to ${seed.court2}?`);
  // The knock-on preview loads before anything can be confirmed.
  const confirm = sheet.getByTestId("md-call-confirm");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(sheet).toHaveCount(0);
  await expect(focus).toHaveAttribute("data-state", "called");
  await expect(focus).toContainText("Called: waiting for players");
}

/** Court 2 is focused and free: call its top candidate, see "Called", undo it, see the candidate back — then call it AGAIN
 *  from the same screen (spec §10: a call after an undo is an ordinary call), and undo that too. */
async function callAndUndo(page: Page, seed: Seed): Promise<void> {
  const focus = page.getByTestId("md-focus");
  await expect(focus).toHaveAttribute("data-state", "free");
  await expect(focus).toContainText(`${seed.court2} is free`);

  const candidates = focus.getByTestId("md-candidate");
  // Ranked: Court 2's own next match first, with its call button.
  await expect(candidates.first()).toHaveAttribute("data-fixture-id", seed.calDee);
  // The blocked one is greyed, says why, and has nothing to press.
  const blocked = focus.locator(`[data-testid="md-candidate"][data-fixture-id="${seed.anaCal}"]`);
  await expect(blocked).toHaveAttribute("data-blocked", "true");
  await expect(blocked).toContainText(`${seed.names.ana} is on ${seed.court1}`);
  await expect(blocked.getByRole("button")).toHaveCount(0);

  // Only one match can start here now: the blocked ones are listed, not counted (review I2).
  await expect(page.getByTestId("md-free-panel")).toContainText("1 match could start here now");

  await callTop(page, seed);
  // Which side is home is the generator's choice: both names, not an order.
  await expect(focus).toContainText(seed.names.cal);
  await expect(focus).toContainText(seed.names.dee);
  // A4: a called court shows its scorer's QR panel (the console's Remote scoring, embedded), ready to create.
  await expect(focus.getByTestId("md-scorer")).toBeVisible();
  await expect(focus.getByTestId("md-scorer").getByTestId("device-link-mint")).toBeVisible();
  // The fixture really moved: a live call row, read where the server reads it.
  const called = await withDb(
    (sql) => sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id = ${seed.calDee}`,
  );
  expect(called[0]!.n).toBe(1);

  await focus.getByTestId("md-undo-call").click();
  await expect(focus).toHaveAttribute("data-state", "free");
  await expect(focus.locator(`[data-testid="md-candidate"][data-fixture-id="${seed.calDee}"]`)).toBeVisible();

  // Again, through the UI: the undone match is callable like any other.
  await callTop(page, seed);
  await focus.getByTestId("md-undo-call").click();
  await expect(focus).toHaveAttribute("data-state", "free");
  await expect(focus.locator(`[data-testid="md-candidate"][data-fixture-id="${seed.calDee}"]`)).toBeVisible();
}

test.describe("Match Day — desktop", () => {
  test("a free court lists its candidates; calling the top one shows Called, Undo puts it back; no sideways scroll at 1280 or 768", async ({
    page,
    request,
  }) => {
    const seed = await seedMatchDay(request, "Desk");
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });

    await expect(page.getByTestId("md-header").getByRole("heading", { level: 1 })).toContainText("Match Day");
    await expect(page.getByTestId("md-counts")).toContainText("2 courts");
    await expect(page.getByTestId("md-counts")).toContainText("1 playing");
    await expect(page.getByTestId("md-counts")).toContainText("1 free");
    await expect(page.getByTestId("md-court-row")).toHaveCount(2);
    await expect(row(page, seed.court1)).toHaveAttribute("data-state", "playing");
    await expect(row(page, seed.court2)).toHaveAttribute("data-state", "free");
    // The playing court is focused first: the scoreboard, and "+ Connect a stream" — nothing is streaming here.
    await expect(page.getByTestId("md-scoreboard")).toBeVisible();
    await expect(page.getByTestId("md-scoreboard")).toContainText("+ Connect a stream");
    // A4: and the scorer's QR panel under it. Ana v Ben has kicked off and nothing more: the desk does not count the
    // kick-off as recording (competition-desk.ts, review 7), and nobody is named to score it — so its row says No scorer,
    // in the desk's own words, while the free court says nothing.
    await expect(page.getByTestId("md-focus").getByTestId("md-scorer")).toBeVisible();
    await expect(row(page, seed.court1)).toHaveAttribute("data-scorer", "no_scorer");
    await expect(row(page, seed.court2)).not.toHaveAttribute("data-scorer", /.+/);
    await expectNoHorizontalScroll(page);

    await row(page, seed.court2).click();
    await callAndUndo(page, seed);
    await expectNoHorizontalScroll(page);

    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByTestId("md-list")).toBeVisible();
    await expect(page.getByTestId("md-focus")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("A4: Needs you opens with the owed result first; the unscored court is marked; its scorer QR mints; at 1280 and 768", async ({
    page,
    request,
  }) => {
    const seed = await seedMatchDay(request, "NeedsDesk", { needsYou: true });
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    await expect(page.getByTestId("md-court-row")).toHaveCount(3);
    await expect(page.getByTestId("md-counts")).toContainText("2 playing");
    await needsYouAndScorer(page, seed);
    // A4 n2 (task B4): the panel's state is its MATCH's - Court 3's, open above with its QR, does not carry over to Court 1's.
    const panelOf = () => page.getByTestId("md-focus").getByTestId("md-scorer").locator('[data-role="device-link-panel"]');
    await expect(panelOf()).toHaveAttribute("data-hide-state", "open");
    await row(page, seed.court1).click();
    await expect(page.getByTestId("md-focus")).toContainText(seed.names.ana);
    await expect(page.getByTestId("md-focus").getByTestId("md-scorer")).toBeAttached();
    await expect(page.getByTestId("md-focus").getByTestId("dlink-qr")).toHaveCount(0);

    await page.setViewportSize({ width: 768, height: 1024 });
    await page.reload({ waitUntil: "load" });
    await needsYouAndScorer(page, seed, true);
  });
});

test.describe("Match Day — phone (320)", () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test("the list is home; a court opens full-screen with '‹ All courts'; call and undo work there; no sideways scroll", async ({
    page,
    request,
  }) => {
    const seed = await seedMatchDay(request, "Phone");
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });

    const list = page.getByTestId("md-list");
    const focus = page.getByTestId("md-focus");
    await expect(list).toBeVisible();
    await expect(focus).toBeHidden();
    await expectNoHorizontalScroll(page);

    await row(page, seed.court2).click();
    await expect(focus).toBeVisible();
    await expect(list).toBeHidden();
    const back = page.getByTestId("md-back");
    await expect(back).toBeVisible();
    await expect(back).toContainText("All courts");
    await expectNoHorizontalScroll(page);

    await callAndUndo(page, seed);
    await expectNoHorizontalScroll(page);

    await back.click();
    await expect(list).toBeVisible();
    await expect(focus).toBeHidden();
  });

  test("A4: the Needs-you button opens its list at 320 with no dot opening a line; the unscored court's QR mints full-screen", async ({
    page,
    request,
  }) => {
    const seed = await seedMatchDay(request, "NeedsPhone", { needsYou: true });
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    await expect(page.getByTestId("md-list")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await needsYouAndScorer(page, seed);
    await expect(page.getByTestId("md-list")).toBeHidden();
    await expect(page.getByTestId("md-back")).toBeVisible();
  });
});

/**
 * Match Day E2 item 6 (owner 2026-11-01): the Remote scoring panel can be put away. In a real browser, because what matters is
 * what the node suite cannot see: that Hide is reachable and operable from the keyboard, that focus lands somewhere sensible when
 * the control that was pressed disappears, that the choice outlives a reload (sessionStorage) and is the COURT's, not the page's,
 * and that the enlarged QR can be left three ways (the ✕, Esc, and a tap anywhere else - the overlay is the whole screen).
 *
 * Court 1 (Ana v Ben, in play, nothing recorded) is the desk's red no_scorer, so its panel starts OPEN; Court 2 is free.
 */
async function hideFlow(page: Page, request: APIRequestContext, label: string): Promise<void> {
  const seed = await seedMatchDay(request, label);
  await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
  // The phone opens a court full-screen from the list; wider screens already have Court 1 focused.
  if (await page.getByTestId("md-focus").isHidden()) await row(page, seed.court1).click();
  const focus = page.getByTestId("md-focus");
  await expect(focus).toHaveAttribute("data-court-id", seed.court1Id);
  const scorer = focus.getByTestId("md-scorer");
  const panel = scorer.locator('[data-role="device-link-panel"]');
  const hideButton = scorer.getByTestId("device-link-hide");
  const key = `seazn.matchDay.scorer.${seed.court1Id}`;
  const remembered = () => page.evaluate((k) => window.sessionStorage.getItem(k), key);
  // The panel's own heading is where Hide sits: the pad ships a real <h3>, not a styled span.
  await expect(panel).toHaveAttribute("data-hide-state", "open");
  await expect(hideButton).toBeVisible();
  expect(await remembered(), "nothing remembered until the organiser chooses").toBeNull();

  // 44px, and reachable from the keyboard: focus it and press Enter, no pointer.
  const box = (await hideButton.boundingBox())!;
  expect(box.height, "Hide is a 44px target").toBeGreaterThanOrEqual(43.5);
  expect(box.width, "Hide is a 44px target").toBeGreaterThanOrEqual(43.5);
  await hideButton.focus();
  await expect(hideButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveAttribute("data-hide-state", "hidden");
  expect(await remembered()).toBe("hidden");
  // The control that was pressed is gone; focus must not fall to the page: it lands on the row's button.
  const create = scorer.getByTestId("device-link-row-create");
  await expect(create).toBeVisible();
  await expect(create).toBeFocused();
  await expect(scorer.getByTestId("device-link-row-state")).toContainText("No scorer link yet");
  await expect(scorer.getByRole("heading", { name: "Remote scoring" })).toBeVisible();
  // Hidden is ONE row: the panel is short, the QR and the More fold are not in the page at all.
  await expect(scorer.getByTestId("dlink-qr")).toHaveCount(0);
  await expect(scorer.getByTestId("device-link-more")).toHaveCount(0);
  expect((await panel.boundingBox())!.height, "one row, not a panel").toBeLessThan(140);
  await expectNoHorizontalScroll(page);

  // Remembered across a reload, and it is this COURT's: the free court next door has no panel to carry it.
  await page.reload({ waitUntil: "load" });
  if (await page.getByTestId("md-focus").isHidden()) await row(page, seed.court1).click();
  await expect(page.getByTestId("md-focus").locator('[data-role="device-link-panel"]')).toHaveAttribute("data-hide-state", "hidden");

  // Create from the row: the panel opens (and the choice flips to open), the QR is on screen, and focus is on Hide.
  await page.getByTestId("md-focus").getByTestId("device-link-row-create").click();
  await expect(panel).toHaveAttribute("data-hide-state", "open");
  expect(await remembered()).toBe("open");
  const qr = scorer.getByTestId("dlink-qr");
  await expect(qr).toBeVisible({ timeout: 15_000 });
  await expect(hideButton).toBeFocused();

  // The enlarged QR (shared with the fixture console): a ✕ that is a 44px target, and Esc, and a tap anywhere else.
  const enlarge = scorer.getByTestId("dlink-qr-enlarge");
  const overlay = page.getByTestId("qr-enlarged");
  await enlarge.click();
  await expect(overlay).toBeVisible();
  const close = page.getByTestId("qr-enlarged-close");
  await expect(close).toBeVisible();
  const cbox = (await close.boundingBox())!;
  expect(cbox.width, "the overlay's ✕ is a 44px target").toBeGreaterThanOrEqual(43.5);
  expect(cbox.height).toBeGreaterThanOrEqual(43.5);
  await close.click();
  await expect(overlay).toHaveCount(0);
  await enlarge.click();
  await expect(overlay).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await enlarge.click();
  await expect(overlay).toBeVisible();
  const vp = page.viewportSize()!;
  await page.mouse.click(vp.width - 8, vp.height - 8); // a corner: nowhere near the QR or the ✕
  await expect(overlay).toHaveCount(0);
  await expect(enlarge, "focus returns to the QR").toBeFocused();

  // A link is live now: hiding shows "Scorer link ready" with Show QR and Copy link; Copy link copies the ONE sealed link.
  await hideButton.click();
  await expect(panel).toHaveAttribute("data-hide-state", "hidden");
  await expect(scorer.getByTestId("device-link-row-state")).toContainText("Scorer link ready");
  const show = scorer.getByTestId("device-link-row-show");
  const copy = scorer.getByTestId("device-link-row-copy");
  await expect(show).toBeVisible();
  await expect(copy).toBeVisible();
  for (const [name, control] of [["Show QR", show], ["Copy link", copy]] as const) {
    expect((await control.boundingBox())!.height, `${name} is a 44px target`).toBeGreaterThanOrEqual(43.5);
  }
  const origin = new URL(page.url()).origin;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await copy.click();
  await expect(copy).toHaveText("Link copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.startsWith(`${origin}/score/`), `the clipboard holds the pad link, got ${copied.slice(0, 60)}`).toBe(true);
  expect(copied.length, "and a secret follows it").toBeGreaterThan(`${origin}/score/`.length + 8);
  await expect(panel, "copying does not open the panel").toHaveAttribute("data-hide-state", "hidden");
  await expectNoHorizontalScroll(page);

  // The SEQUENCE: Show QR brings the SAME link's QR back (a second look never makes a second link).
  await show.click();
  await expect(panel).toHaveAttribute("data-hide-state", "open");
  await expect(scorer.getByTestId("dlink-qr")).toBeVisible({ timeout: 15_000 });
  const links = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from device_links where fixture_id = ${seed.anaBen}`);
  expect(links[0]!.n, "hide / copy / show never made a second link").toBe(1);
  await expectNoHorizontalScroll(page);
}

test.describe("Match Day — E2 item 6: Remote scoring can be hidden", () => {
  test("desktop: Hide by keyboard, one row when hidden, remembered across a reload, enlarged QR leaves three ways; at 1280 then 768", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await hideFlow(page, request, "HideDesk");
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByTestId("md-focus")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test.describe("phone (320)", () => {
    test.use({ viewport: { width: 320, height: 568 } });
    test("the same at 320: Hide, the row, the reload, the enlarged QR - no sideways scroll", async ({ page, request }) => {
      test.setTimeout(180_000);
      await hideFlow(page, request, "HidePhone");
    });
  });
});

/**
 * Task B1 (spec §9): the competition page's live strip is gone, and the two things its spec (desk-in-play-band.spec.ts,
 * retired) proved in a real browser move here, to the board that now shows what is being played. Both are about the shell's
 * OWN polls (`startBandPolling`: 20 s while a court is playing or called, 90 s while quiet) — the node-environment suite never
 * runs an effect, so this is the only place they are seen. The clock is installed before navigation, so the interval the
 * shell registers at hydration is the fake one, and no tab is ever reloaded.
 */
test.describe("Match Day — the board keeps itself current (B1, moved from desk-in-play-band.spec.ts)", () => {
  test("a match decided elsewhere leaves its court on the next live poll, not before", async ({ page, request }) => {
    const seed = await seedMatchDay(request, "Poll");
    await page.clock.install();
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    await expect(row(page, seed.court1)).toHaveAttribute("data-state", "playing");

    // Decided out of band — a real generic.result, never a status patch — so the match genuinely leaves in_play.
    await scoreFixture(request, seed.anaBen, 2, 1);
    // Nothing has told this tab: the server-rendered board still shows it playing, so the poll is what moves it.
    await expect(row(page, seed.court1), "the court changed before any poll ran: this is not proving the poll").toHaveAttribute(
      "data-state",
      "playing",
    );
    await page.clock.fastForward("00:21");
    await expect(row(page, seed.court1), "a decided match still holds its court after the live poll ran").not.toHaveAttribute(
      "data-state",
      "playing",
    );
    await expect(page.getByTestId("md-counts")).toContainText("0 playing");
  });

  test("a quiet board left open picks up the day's first match starting, on the quiet poll, without a reload", async ({
    page,
    request,
  }) => {
    const seed = await seedMatchDay(request, "Wake", { quiet: true });
    await page.clock.install();
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    // Quiet, and the board really rendered (the positive half: two courts, neither playing).
    await expect(page.getByTestId("md-court-row")).toHaveCount(2);
    await expect(row(page, seed.court1)).not.toHaveAttribute("data-state", "playing");

    // The match starts elsewhere, as it does when a scorer opens the pad on a phone.
    await startFixture(request, seed.anaBen);
    // Past one LIVE tick (20 s) it must still read quiet — if it changed here, something other than the quiet poll moved it.
    await page.clock.fastForward("00:25");
    await expect(row(page, seed.court1), "the board changed before the quiet poll could have run").not.toHaveAttribute(
      "data-state",
      "playing",
    );
    // Past the quiet period (90 s) it wakes.
    await page.clock.fastForward("01:10");
    await expect(row(page, seed.court1), "a quiet board never noticed the first match start").toHaveAttribute("data-state", "playing");
  });
});

/** The en ui dictionary: the link's words are read from it, never typed. */
const UI_EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

test.describe("Match Day — Find a court on the division's run sheet (B2)", () => {
  // Spec §9: "Unscheduled fixtures link to the free-court candidate list". Since B4 fix round 1 (R2) the link is Match Day's own
  // Find a court: `?court=` the first free court the division plays on (the page itself when none is free). The seed is a match day (three
  // matches dated today, one in play) in a league of four whose other three matches have no time and no court: those are the rows
  // that offer it. The NOT-a-match-day half is in competition-desk.spec.ts, which owns the rig with nothing dated today.
  test("on a match day each unscheduled match links to Match Day's free court for it; the dated ones do not; at 1280, 768 and 320", async ({ page, request }) => {
    const seed = await seedMatchDay(request, "FindCourt");
    const compPath = await competitionPath(request, seed.competitionId);
    const slug = await withDb(async (sql) => {
      const [d] = await sql<{ slug: string }[]>`select slug from divisions where competition_id = ${seed.competitionId}`;
      return d!.slug;
    });
    // Which matches have no time and no court: read where the server reads it, never counted off the seed's own arithmetic.
    const unscheduled = await withDb(async (sql) => {
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from fixtures f join divisions d on d.id = f.division_id
         where d.competition_id = ${seed.competitionId} and f.scheduled_at is null and f.court_id is null and f.status = 'scheduled'`;
      return rows[0]!.n;
    });
    expect(unscheduled, "the seed leaves matches with no time and no court").toBeGreaterThanOrEqual(1);
    // B4 fix round 1 (R2): the link is Match Day's own "Find a court" for the division — the first court on the list it plays
    // on with nothing on it. Court 1 has Ana v Ben in play; Court 2 has only a later match planned, so it is free.
    const findCourtHref = `${compPath}/match-day?court=${seed.court2Id}`;
    // Shared, not parallel: Match Day's Needs you says the same thing for this division's unscheduled row.
    const md = await apiJson<{ needs_you: { kind: string; key: string; alt?: { href: string; court_id: string | null } }[] }>(
      request,
      `/api/v1/competitions/${seed.competitionId}/match-day`,
    );
    expect(md.status, JSON.stringify(md.error)).toBe(200);
    const row = md.data!.needs_you.find((i) => i.kind === "unscheduled" && i.key.startsWith(`${seed.divisionId}:`));
    expect(row?.alt, "Match Day's own row offers it").toEqual({ label: UI_EN["matchDay.needsYou.findCourt.court"], href: findCourtHref, court_id: seed.court2Id });

    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${compPath}/d/${slug}?tab=fixtures`, { waitUntil: "load" });
      const sheet = page.getByTestId("run-sheet");
      await expect(sheet).toBeVisible();
      // The sheet opens on "All" whatever the day (Match Day PB1, owner 2026-11-02); the unscheduled ones live under their own chip.
      await sheet.locator('[data-filter="unscheduled"]').click();
      const setTime = sheet.locator('[data-row-action="set_time"]');
      await expect(setTime).toHaveCount(unscheduled);
      const findCourt = sheet.getByTestId("run-sheet-find-court");
      await expect(findCourt, `width ${width}`).toHaveCount(unscheduled);
      for (const link of await findCourt.all()) {
        await expect(link).toHaveAttribute("href", findCourtHref);
        // generic/score plays on a court (the default noun); football's pitch and chess's board are the unit suites' (the seed is one sport).
        await expect(link).toHaveText(UI_EN["runsheet.action.findCourt.court"]!);
        await expect(link).toBeVisible();
        const box = await link.boundingBox();
        expect(box, "the link has a box").not.toBeNull();
        expect(box!.x + box!.width, `inside the ${width}px viewport`).toBeLessThanOrEqual(width);
        if (width === 320) expect(box!.height, "tap height at 320").toBeGreaterThanOrEqual(44);
        // B4 fix round 1b: where it sits beside its row's Set time (read from the live DOM). Below md: a line of its own UNDER
        // Set time, right edges aligned, so it never widens Set time's line (a stream chip shares that line: stream-relay A12).
        // From md: the desktop row, on Set time's line and to its right.
        const st = await link.locator("xpath=ancestor::li[1]").locator('[data-row-action="set_time"]').boundingBox();
        expect(st, "its row's Set time has a box").not.toBeNull();
        const mid = box!.y + box!.height / 2;
        if (width < 768) {
          expect(box!.y, `@${width}: below Set time`).toBeGreaterThanOrEqual(st!.y + st!.height - 1);
          expect(Math.abs(box!.x + box!.width - (st!.x + st!.width)), `@${width}: right edge under Set time's`).toBeLessThanOrEqual(1);
        } else {
          expect(mid >= st!.y && mid <= st!.y + st!.height, `@${width}: on Set time's line`).toBe(true);
          expect(box!.x, `@${width}: right of Set time`).toBeGreaterThanOrEqual(st!.x + st!.width - 1);
        }
      }
      await expectNoHorizontalScroll(page);
    }

    // The dated matches (today's) carry Set time's cousin, not this: nothing is asked of a match that already has its court and time.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${compPath}/d/${slug}?tab=fixtures`, { waitUntil: "load" });
    await page.getByTestId("run-sheet").locator('[data-filter="today"]').click();
    await expect(page.getByTestId("run-sheet").locator("li[data-fixture-no]").first()).toBeVisible();
    await expect(page.getByTestId("run-sheet-find-court")).toHaveCount(0);

    // Following it lands on Match Day with that court open, its candidates listing the division's unscheduled matches.
    await page.getByTestId("run-sheet").locator('[data-filter="unscheduled"]').click();
    await page.getByTestId("run-sheet-find-court").first().click();
    await expect(page).toHaveURL(new RegExp(`/match-day\\?court=${seed.court2Id}$`));
    await expect(page.getByTestId("md-header").getByRole("heading", { level: 1 })).toContainText("Match Day");
    await expect(page.getByTestId("md-focus")).toContainText(seed.court2);
    const ids = await withDb(async (sql) =>
      (
        await sql<{ id: string }[]>`
          select id from fixtures where division_id = ${seed.divisionId} and status = 'scheduled' and court_id is null and scheduled_at is null`
      ).map((r) => r.id),
    );
    expect(ids).toHaveLength(unscheduled);
    for (const id of ids) {
      await expect(page.getByTestId("md-focus").locator(`[data-testid="md-candidate"][data-fixture-id="${id}"]`), id).toHaveCount(1);
    }
  });
});

/**
 * Task B3 (spec §6.2): a set sport's score on Match Day is its LEVELS, read off the engine's structured summary — the sets won in
 * large type, then tennis's games in the set in play, then the game's points ("1 – 0   3–2   40–30"; the row "1–0 · 3–2 · 40–30"),
 * never a finished set's score. The node-environment suite folds the engine's recorded streams for every sport; this plays a real
 * tennis match and a real badminton match through the events API, onto two courts of one competition, and reads what a browser
 * shows.
 *
 *   - Tennis (tour): home takes set 1 6–0, then leads set 2 3–2 in games and 40–30 in the game: levels 1–0 · 3–2 · 40–30.
 *   - Badminton (bwf): home takes game 1 21–15, then leads game 2 12–10: levels 1–0 · 12–10 (no games level).
 */
interface LevelsSeed {
  competitionId: string;
  tennisCourt: string;
  badmintonCourt: string;
  tennisFixture: string;
  badmintonFixture: string;
}

/** Realistic long entrant names — a doubles pair named in full runs past 40 characters, and 320 is where it shows. */
const LONG_NAMES = ["Alexandra Montgomery-Fitzwilliam & Partner", "Bartholomew Featherstonehaugh-Smythe & Partner"] as const;

async function seedLevels(request: APIRequestContext, label: string, opts: { longNames?: boolean } = {}): Promise<LevelsSeed> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Match Day levels ${label} ${TAG}`,
    visibility: "public",
  });
  if (comp.status >= 300 || !comp.data) throw new Error(`competition → ${comp.status} ${JSON.stringify(comp.error)}`);
  const competitionId = comp.data.id;
  const nonce = Math.random().toString(36).slice(2, 7);
  const { courts } = await seedVenueWithCourts(request, [`LV1 ${label} ${nonce} ${TAG}`, `LV2 ${label} ${nonce} ${TAG}`]);
  const [tennisCourt, badmintonCourt] = [courts[0]!, courts[1]!];

  /** A one-fixture division of `sport`, started, on `court`, its match kicked off by a real core.start. */
  const division = async (name: string, sport: string, variant: string, court: { id: string }): Promise<{ fixtureId: string; home: string; away: string }> => {
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
      name,
      sport_key: sport,
      variant_key: variant,
    });
    if (div.status >= 300 || !div.data) throw new Error(`division ${sport} → ${div.status} ${JSON.stringify(div.error)}`);
    const divisionId = div.data.id;
    const names = opts.longNames === true ? [...LONG_NAMES] : [`Ana ${nonce}`, `Ben ${nonce}`];
    const ents = await addEntrantsViaApi(request, divisionId, names);
    if (ents.status >= 300 || ents.ids.length !== 2) throw new Error(`entrants → ${ents.status}`);
    const { fixtureIds } = await createStageAndGenerate(request, divisionId);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: { matchMinutes: 30, courts: [tennisCourt.id, badmintonCourt.id] },
    });
    expect(settings.status, `schedule settings: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
    const fixtureId = fixtureIds[0]!;
    // Today's UTC day, a minute inside either end, as the board's own seed does.
    const now = Date.now();
    const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    const at = new Date(Math.min(dayStart + 86_400_000 - 60_000, Math.max(dayStart + 60_000, now - 20 * 60_000))).toISOString();
    await withDb((sql) => sql`update fixtures set court_id = ${court.id}, scheduled_at = ${at} where id = ${fixtureId}`);
    return { fixtureId, home: ents.ids[0]!, away: ents.ids[1]! };
  };

  /** Events through the API, each on the last one's seq. */
  const play = async (fixtureId: string, events: { type: string; payload: unknown }[]): Promise<void> => {
    let seq = 0;
    for (const e of events) {
      const res = await apiJson<{ seq: number }>(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: seq, ...e });
      expect(res.status, `${e.type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
      seq = res.data!.seq;
    }
  };

  const tennis = await division("Open singles", "tennis", "tour", tennisCourt);
  const point = (by: string) => ({ type: "tennis.point", payload: { by } });
  const game = (by: string) => [point(by), point(by), point(by), point(by)];
  await play(tennis.fixtureId, [
    { type: "core.start", payload: {} },
    // Set 1: six games to love for home.
    ...[1, 2, 3, 4, 5, 6].flatMap(() => game(tennis.home)),
    // Set 2: home, away, home, away, home -> 3-2 in games; then 40-30 in the game (H A H A H).
    ...[tennis.home, tennis.away, tennis.home, tennis.away, tennis.home].flatMap(game),
    ...[tennis.home, tennis.away, tennis.home, tennis.away, tennis.home].map(point),
  ]);

  const badminton = await division("Open badminton", "badminton", "bwf", badmintonCourt);
  const rally = (wonBy: string) => ({ type: "badminton.rally", payload: { wonBy } });
  const times = (n: number, wonBy: string) => Array.from({ length: n }, () => rally(wonBy));
  await play(badminton.fixtureId, [
    { type: "core.start", payload: {} },
    // Game 1: 15 to away first, then 21 to home -> 21-15, home takes it.
    ...times(15, badminton.away),
    ...times(21, badminton.home),
    // Game 2 in play: 12 to home, 10 to away.
    ...times(12, badminton.home),
    ...times(10, badminton.away),
  ]);

  return { competitionId, tennisCourt: tennisCourt.name, badmintonCourt: badmintonCourt.name, tennisFixture: tennis.fixtureId, badmintonFixture: badminton.fixtureId };
}

/** The engine's own folded summary of a fixture, as the app stored it — the oracle the browser's figures are checked against. */
async function storedSummary(fixtureId: string): Promise<{ perSide: { line: string }[]; detail: Record<string, unknown> }> {
  const rows = await withDb((sql) => sql<{ summary: { perSide: { line: string }[]; detail: Record<string, unknown> } }[]>`select summary from match_states where fixture_id = ${fixtureId}`);
  expect(rows, "the match has a folded state").toHaveLength(1);
  return rows[0]!.summary;
}

const levelsOf = (page: Page) => page.getByTestId("md-score-large");

/** The public match page of a fixture of the signed-in org: `/shared/{org}/{competition}/{division}/fixtures/{id}`. */
async function publicFixturePath(request: APIRequestContext, page: Page, fixtureId: string): Promise<string> {
  const fx = await apiJson<{ division_id: string }>(request, `/api/v1/fixtures/${fixtureId}`);
  const div = await apiJson<{ slug: string; competition_id: string }>(request, `/api/v1/divisions/${fx.data!.division_id}`);
  const comp = await apiJson<{ slug: string }>(request, `/api/v1/competitions/${div.data!.competition_id}`);
  return `/shared/${(await activeOrg(page)).slug}/${comp.data!.slug}/${div.data!.slug}/fixtures/${fixtureId}`;
}

/** What the public court card sets beside a side's big score (`mc-score-{i}`): the span that follows it. */
const cardSub = (page: Page, i: 0 | 1) => page.locator(`[data-testid="mc-score-${i}"] + span`);

test.describe("Match Day — a set sport's score is its levels (B3)", () => {
  test("desktop: tennis reads sets · games · points, badminton sets · points — the rows and the panel; no finished set's score; no sideways scroll", async ({
    page,
    request,
  }) => {
    const seed = await seedLevels(request, "Desk");
    // The engine's own fields say what the script produced (so the literals below are the rulebook's, not the page's).
    const tennis = await storedSummary(seed.tennisFixture);
    expect(tennis.perSide.map((p) => p.line)).toEqual(["1", "0"]);
    expect(tennis.detail.games).toEqual({ home: 3, away: 2 });
    expect(tennis.detail.game).toBe("40–30");
    const badminton = await storedSummary(seed.badmintonFixture);
    expect(badminton.perSide.map((p) => p.line)).toEqual(["1", "0"]);
    expect(badminton.detail.points).toEqual({ home: 21 + 12, away: 15 + 10 });

    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    await expect(row(page, seed.tennisCourt)).toHaveAttribute("data-state", "playing");
    await expect(row(page, seed.badmintonCourt)).toHaveAttribute("data-state", "playing");
    await expect(row(page, seed.tennisCourt).locator("[data-md-row-score]")).toHaveText("1–0 · 3–2 · 40–30");
    await expect(row(page, seed.badmintonCourt).locator("[data-md-row-score]")).toHaveText("1–0 · 12–10");

    // The panel: tennis, three levels in order.
    await row(page, seed.tennisCourt).click();
    const big = levelsOf(page);
    await expect(big).toContainText("1 – 0");
    await expect(big.locator("[data-md-score-mid]")).toHaveText("3–2");
    await expect(big.locator("[data-md-score-live]")).toHaveText("40–30");
    // Set 1 closed 6-0 and its score is nowhere in the large type.
    await expect(big).not.toContainText("6–0");
    await expect(big).not.toContainText("(");
    await expectNoHorizontalScroll(page);

    // Badminton: the games won and the open game's points; no games-in-a-set level at all.
    await row(page, seed.badmintonCourt).click();
    await expect(big).toContainText("1 – 0");
    await expect(big.locator("[data-md-score-live]")).toHaveText("12–10");
    await expect(big.locator("[data-md-score-mid]")).toHaveCount(0);
    await expect(big).not.toContainText("21–15");
    await expectNoHorizontalScroll(page);

    // The public match page's court card — what a spectator reads in large type — carries the same levels per side: tennis the
    // sets won big, then the set's games in parentheses and the game's points; badminton the games won and the open game's points.
    // The figures are the script's own (home won 3 games to 2 and leads the game 40–30; the engine's summary was read above).
    await page.goto(await publicFixturePath(request, page, seed.tennisFixture), { waitUntil: "load" });
    await expect(page.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("mc-score-0")).toHaveText("1");
    await expect(page.getByTestId("mc-score-1")).toHaveText("0");
    await expect(cardSub(page, 0)).toHaveText("(3) 40");
    await expect(cardSub(page, 1)).toHaveText("(2) 30");
    await expectNoHorizontalScroll(page);
    await page.goto(await publicFixturePath(request, page, seed.badmintonFixture), { waitUntil: "load" });
    await expect(page.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("mc-score-0")).toHaveText("1");
    await expect(cardSub(page, 0)).toHaveText("(12)");
    await expect(cardSub(page, 1)).toHaveText("(10)");
    await expectNoHorizontalScroll(page);
  });

  test("phone (320): the same levels fit the panel's width with 40-character entrant names — nothing clipped, no sideways scroll, on the list and on both panels", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    const seed = await seedLevels(request, "Phone", { longNames: true });
    for (const name of LONG_NAMES) expect(name.length, `"${name}" is a realistic long name`).toBeGreaterThanOrEqual(40);
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    await expect(row(page, seed.tennisCourt).locator("[data-md-row-score]")).toHaveText("1–0 · 3–2 · 40–30");
    await expectNoHorizontalScroll(page);

    await row(page, seed.tennisCourt).click();
    const big = levelsOf(page);
    await expect(big.locator("[data-md-score-live]")).toHaveText("40–30");
    // The long names are really on the panel (the premise), and every figure sits inside the 320 column, wrapped if it must be.
    await expect(page.getByTestId("md-focus")).toContainText(LONG_NAMES[0]);
    const boxes = await big.locator("span").evaluateAll((els) => els.map((e) => ({ left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right, text: e.textContent })));
    expect(boxes.length, "won, mid and live").toBe(3);
    for (const b of boxes) {
      expect(b.left, `${b.text} starts on screen`).toBeGreaterThanOrEqual(0);
      expect(b.right, `${b.text} ends on screen`).toBeLessThanOrEqual(320);
    }
    await expectNoHorizontalScroll(page);
    // The whole scoreboard sits inside the viewport: no box of the panel reaches past it — except inside a region that SCROLLS,
    // whose extra content is reachable (AGENTS.md #23). The exemption is checked, not trusted (B3 review minor, task B4): every
    // region the scoreboard holds must compute overflow-x auto or scroll, so a clipping box can never hide behind the excuse.
    const scan = await page.getByTestId("md-scoreboard").evaluate((el) => {
      const edge = document.documentElement.clientWidth + 1;
      const over = [...el.querySelectorAll<HTMLElement>("*")].filter((e) => e.getBoundingClientRect().right > edge && getComputedStyle(e).display !== "none");
      return {
        past: over.filter((e) => !e.closest("[role=region]")).map((e) => e.tagName.toLowerCase() + "." + String(e.className).slice(0, 40)),
        excused: over.filter((e) => e.closest("[role=region]")).length,
        regions: [...el.querySelectorAll<HTMLElement>("[role=region]")].map((r) => ({
          name: r.getAttribute("aria-label") ?? "",
          overflowX: getComputedStyle(r).overflowX,
        })),
      };
    });
    expect(scan.past, "a box of the scoreboard reaches past the 320 viewport").toEqual([]);
    console.info(`[B3 scan] scoreboard regions: ${scan.regions.length}; boxes past the edge inside one: ${scan.excused}`);
    if (scan.excused > 0) expect(scan.regions.length, "boxes were excused, so a region holds them").toBeGreaterThan(0);
    for (const r of scan.regions) expect(["auto", "scroll"], `region "${r.name}" scrolls rather than clips`).toContain(r.overflowX);

    // Badminton too (the other kind of levels, the same long names).
    await page.getByTestId("md-back").click();
    await row(page, seed.badmintonCourt).click();
    await expect(levelsOf(page).locator("[data-md-score-live]")).toHaveText("12–10");
    await expectNoHorizontalScroll(page);

    // The public court card at 320 with the same long names: the figures stay on screen and the page does not scroll sideways.
    await page.goto(await publicFixturePath(request, page, seed.tennisFixture), { waitUntil: "load" });
    await expect(page.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
    await expect(cardSub(page, 0)).toHaveText("(3) 40");
    const sub = await cardSub(page, 0).boundingBox();
    expect(sub, "the small figure is painted").not.toBeNull();
    expect(sub!.x + sub!.width, "the small figure ends inside the 320 viewport").toBeLessThanOrEqual(320);
    await expectNoHorizontalScroll(page);
  });
});

/**
 * Task B4 (owner rulings Q1, 2026-10-31). What the node-environment suite cannot see: the "Playing, no court" group and its
 * panel in a real browser at every width, a competition with no courts at all, a view-only member's page and the server's
 * refusals of their writes through the real routes, and Needs you's "Find a court" opening a court in place.
 */

/** B4: a division of this competition whose one match kicks off for real (a core.start through the engine) and is never
 *  placed — in play on NO court, as an untimed bracket match or an online board is. `noCourts`: the division asks for a court
 *  tag no court has, so it can use none of the organisation's courts (an empty court list means EVERY court). */
async function seedNoCourtMatch(
  request: APIRequestContext,
  competitionId: string,
  label: string,
  opts: { start?: boolean; noCourts?: boolean; courts?: string[] } = {},
): Promise<{ fixtureId: string; home: string; away: string; divisionName: string; divisionId: string }> {
  const nonce = Math.random().toString(36).slice(2, 7);
  const divisionName = `Cup ${label} ${nonce}`;
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
    name: divisionName,
    sport_key: "generic",
    variant_key: "score",
  });
  if (div.status >= 300 || !div.data) throw new Error(`division → ${div.status} ${JSON.stringify(div.error)}`);
  const divisionId = div.data.id;
  const [home, away] = [`Gus ${label} ${nonce}`, `Hal ${label} ${nonce}`];
  const ents = await addEntrantsViaApi(request, divisionId, [home, away]);
  if (ents.status >= 300 || ents.ids.length !== 2) throw new Error(`entrants → ${ents.status}`);
  await createStageAndGenerate(request, divisionId);
  if (opts.courts) {
    // The division plays on these courts, as the seed's does: with none configured its candidates are EVERY court of the
    // shared organisation, and the header's count would be the whole run's.
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: { matchMinutes: 30, courts: opts.courts },
    });
    expect(settings.status, `schedule settings: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
  }
  if (opts.noCourts) {
    await withDb((sql) => sql`update divisions set required_court_tags = ${`{b4-none-${nonce}}`}::text[] where id = ${divisionId}`);
  }
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const [f] = await withDb((sql) => sql<{ id: string; court_id: string | null }[]>`select id, court_id from fixtures where division_id = ${divisionId}`);
  expect(f!.court_id, "premise: the match has no court").toBeNull();
  if (opts.start) await startFixture(request, f!.id);
  return { fixtureId: f!.id, home, away, divisionName, divisionId };
}

/** A competition of its own whose only division can use no court (`seedNoCourtMatch`'s `noCourts`). */
async function seedNoCourtCompetition(request: APIRequestContext, label: string) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Match Day ${label} ${TAG}`,
    visibility: "public",
  });
  if (comp.status >= 300 || !comp.data) throw new Error(`competition → ${comp.status} ${JSON.stringify(comp.error)}`);
  return { competitionId: comp.data.id, ...(await seedNoCourtMatch(request, comp.data.id, label, { noCourts: true })) };
}

/** A view-only member of the competition's organisation, signed in on a page of their own. The seat is a TEAM SEAT in the
 *  shared org (forfeit-dialog.spec.ts's `officialScorerPage`): it lives exactly as long as the page, and `close()` frees it. */
async function viewerPage(browser: Browser, competitionId: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const tag = Math.random().toString(36).slice(2, 8);
  const email = `delivered+b4-viewer-${TAG}-${tag}@resend.dev`;
  let orgId = "";
  let userId = "";
  await withDb(async (sql) => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${"B4 Viewer " + tag}, true) returning id`;
    const [c] = await sql<{ org_id: string }[]>`select org_id from competitions where id = ${competitionId}`;
    orgId = c!.org_id;
    userId = u!.id;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'viewer')`;
  });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await loginUi(page, email);
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
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

test.describe("Match Day — B4: playing with no court, no courts at all, a view-only member, Find a court", () => {
  test("a match in play on no court lists under the courts, marked as a court would be, and opens its own panel — scoreboard, scorer QR, no queue, nothing to call — at 1280, 768 and 320", async ({
    page,
    request,
  }) => {
    const seed = await seedMatchDay(request, "NoCourt");
    const nc = await seedNoCourtMatch(request, seed.competitionId, "NoCourt", { start: true, courts: [seed.court1Id, seed.court2Id] });
    const path = await competitionPath(request, seed.competitionId, "/match-day");
    await page.goto(path, { waitUntil: "load" });

    const group = page.getByTestId("md-no-court");
    await expect(group).toBeVisible();
    // A generic sport's word is "court" (lib/venue.ts's default): the court form of the per-noun title (fix round 1, R3).
    await expect(group.getByRole("heading")).toHaveText(UI_EN["matchDay.noCourt.title.court"]!);
    await expect(page.getByTestId("md-counts")).toContainText("2 courts");
    await expect(page.getByTestId("md-counts")).toContainText("1 match with no court");
    const ncRow = page.locator(`[data-testid="md-no-court-row"][data-fixture-id="${nc.fixtureId}"]`);
    await expect(page.getByTestId("md-no-court-row")).toHaveCount(1);
    await expect(ncRow).toContainText(nc.home);
    await expect(ncRow).toContainText(nc.away);
    await expect(ncRow).toContainText(nc.divisionName);
    // A real kick-off and nothing more, nobody named: the desk's no_scorer — the same mark a court's row carries.
    await expect(ncRow).toHaveAttribute("data-scorer", "no_scorer");
    // Under the courts, never among them.
    const lastCourt = await page.getByTestId("md-court-row").last().boundingBox();
    const groupBox = await group.boundingBox();
    expect(groupBox!.y, "the group sits under the court list").toBeGreaterThan(lastCourt!.y + lastCourt!.height - 1);
    await expect(group.getByTestId("md-no-court-open")).toHaveAttribute("href", /\/f\/\d+$/);
    await expect(group.getByTestId("md-no-court-open")).toHaveText("Open pad");
    await expectNoHorizontalScroll(page);

    await ncRow.click();
    const focus = page.getByTestId("md-focus");
    await expect(focus).toHaveAttribute("data-no-court", "true");
    await expect(focus).toHaveAttribute("data-fixture-id", nc.fixtureId);
    await expect(ncRow).toHaveAttribute("aria-current", "true");
    await expect(focus.getByTestId("md-scoreboard")).toBeVisible();
    // Match Day C2: the format it plays, read-only - the one Match rules component, with the line the read model serves
    // (the fixture page's own `effectiveLine`; `match-day.test.ts` holds the two equal), and no control.
    const view = await apiJson<{ playing_no_court: { id: string; format_line: string | null }[] }>(
      request,
      `/api/v1/competitions/${seed.competitionId}/match-day`,
    );
    const formatLine = view.data?.playing_no_court.find((f) => f.id === nc.fixtureId)?.format_line ?? null;
    expect(formatLine, "premise: the read model says the match's format").not.toBeNull();
    const format = focus.getByTestId("md-match-format");
    await expect(format).toBeVisible();
    await expect(format.getByTestId("match-format-chips")).toHaveText(formatLine!);
    await expect(format.locator("input, select, textarea, button"), "read-only: no control").toHaveCount(0);
    await expect(focus.getByTestId("md-scorer").getByRole("heading", { name: "Remote scoring" })).toBeVisible();
    await expect(focus).not.toContainText(UI_EN["matchDay.queue.title"]!);
    await expect(focus.getByTestId("md-undo-call")).toHaveCount(0);
    await expect(focus.getByRole("button", { name: /^Call to / })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    await page.setViewportSize({ width: 768, height: 1024 });
    await page.reload({ waitUntil: "load" });
    await page.locator(`[data-testid="md-no-court-row"][data-fixture-id="${nc.fixtureId}"]`).click();
    await expect(page.getByTestId("md-focus")).toHaveAttribute("data-no-court", "true");
    await expect(page.getByTestId("md-list")).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.setViewportSize({ width: 320, height: 568 });
    await page.reload({ waitUntil: "load" });
    const list = page.getByTestId("md-list");
    await expect(list).toBeVisible();
    await expect(page.getByTestId("md-focus")).toBeHidden();
    await expectNoHorizontalScroll(page);
    // Fix round 1, R4: the row's match is its whole name, so at 320 it wraps — the away side is never cut to an ellipsis.
    const name = page.locator(`[data-testid="md-no-court-row"][data-fixture-id="${nc.fixtureId}"] [data-md-match]`);
    // E2 item 7: the round's chip leads the names inside this span (its code, and its full name for a screen reader), so the span
    // holds the chip THEN the match - the match still reads whole, and wraps with the chip as one word.
    await expect(name.getByTestId("md-round-chip")).toHaveAttribute("data-round-code", /^R\d+$/);
    await expect(name).toContainText(`${nc.home} v ${nc.away}`);
    await expect(name).toHaveText(new RegExp(`${nc.home} v ${nc.away}$`));
    const fit = await name.evaluate((e) => ({
      sw: e.scrollWidth,
      cw: e.clientWidth,
      overflow: getComputedStyle(e).textOverflow,
      lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)),
    }));
    expect(fit.overflow, "no ellipsis").not.toBe("ellipsis");
    expect(fit.sw, `the name fits its box (${fit.sw} in ${fit.cw})`).toBeLessThanOrEqual(fit.cw);
    expect(fit.lines, "a 30-odd character match wraps at 320 rather than running on one cut line").toBeGreaterThan(1);
    await page.locator(`[data-testid="md-no-court-row"][data-fixture-id="${nc.fixtureId}"]`).click();
    await expect(page.getByTestId("md-focus")).toBeVisible();
    await expect(list).toBeHidden();
    await expect(page.getByTestId("md-back")).toContainText("All courts");
    await expectNoHorizontalScroll(page);
    await page.getByTestId("md-back").click();
    await expect(list).toBeVisible();
  });

  test("a competition with no courts: with nothing playing the page says what to do; a match kicked off makes the group the page — at 1280, 768 and 320", async ({
    page,
    request,
  }) => {
    const z = await seedNoCourtCompetition(request, "Zero");
    const path = await competitionPath(request, z.competitionId, "/match-day");
    await page.goto(path, { waitUntil: "load" });
    // EMPTY CASE FIRST: no courts and nothing playing.
    const empty = page.getByTestId("md-empty");
    await expect(empty).toContainText(UI_EN["matchDay.empty.title"]!);
    await expect(empty).toContainText(UI_EN["matchDay.empty.body"]!);
    await expect(empty.getByRole("link", { name: UI_EN["matchDay.empty.schedule"]! })).toBeVisible();
    await expect(page.getByTestId("md-court-row")).toHaveCount(0);
    await expect(page.getByTestId("md-no-court")).toHaveCount(0);
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 1024 });
      await expectNoHorizontalScroll(page);
    }

    await startFixture(request, z.fixtureId);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload({ waitUntil: "load" });
    await expect(page.getByTestId("md-empty")).toHaveCount(0);
    await expect(page.getByTestId("md-court-row")).toHaveCount(0);
    await expect(page.getByTestId("md-no-court")).toBeVisible();
    await expect(page.getByTestId("md-counts")).toHaveText(/^\W*1 match with no court\W*$/);
    // Desktop opens the one match beside the list, as it opens the first court on a day with courts.
    await expect(page.getByTestId("md-focus")).toHaveAttribute("data-fixture-id", z.fixtureId);
    await expect(page.getByTestId("md-focus").getByTestId("md-scoreboard")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 768, height: 1024 });
    await expectNoHorizontalScroll(page);

    await page.setViewportSize({ width: 320, height: 568 });
    await page.reload({ waitUntil: "load" });
    await expect(page.getByTestId("md-focus")).toBeHidden();
    await page.locator(`[data-testid="md-no-court-row"][data-fixture-id="${z.fixtureId}"]`).click();
    await expect(page.getByTestId("md-focus")).toBeVisible();
    await expect(page.getByTestId("md-back")).toContainText(UI_EN["matchDay.back.list"]!);
    await expectNoHorizontalScroll(page);
  });

  test("a view-only member opens Match Day from the competition page's secondary door, read-only — and the server refuses their call, undo and scorer link", async ({
    page,
    request,
    browser,
  }) => {
    const seed = await seedMatchDay(request, "Viewer");
    const viewer = await viewerPage(browser, seed.competitionId);
    try {
      const vp = viewer.page;
      const compPath = await competitionPath(request, seed.competitionId);
      await vp.goto(compPath, { waitUntil: "load" });
      const door = vp.getByTestId("desk-tool-match-day");
      await expect(door).toBeVisible();
      await expect(door).not.toHaveClass(/(^|\s)btn-primary(\s|$)/);
      await door.click();
      await expect(vp).toHaveURL(/\/match-day$/);
      await expect(vp.getByTestId("md-read-only")).toHaveText(UI_EN["matchDay.readOnly"]!);
      await expect(vp.getByTestId("md-needs-you-toggle")).toHaveCount(0);

      // Court 1, playing, focused first: the score — and no scorer QR, no "+ Connect a stream"; the pad link reads Open match.
      const focus = vp.getByTestId("md-focus");
      await expect(focus.getByTestId("md-scoreboard")).toBeVisible();
      await expect(focus.getByTestId("md-scorer")).toHaveCount(0);
      await expect(focus).not.toContainText("+ Connect a stream");
      await expect(focus.getByTestId("md-open-pad")).toHaveText(UI_EN["matchDay.focus.openMatch"]!);
      // Court 2, free: its candidates, and no button to call one.
      await row(vp, seed.court2).click();
      await expect(focus).toHaveAttribute("data-state", "free");
      await expect(focus.locator(`[data-testid="md-candidate"][data-fixture-id="${seed.calDee}"]`)).toBeVisible();
      await expect(focus.getByRole("button", { name: /^Call to / })).toHaveCount(0);
      await expectNoHorizontalScroll(vp);

      // The organiser calls Cal v Dee onto Court 2; the viewer's board shows it Called, with no Undo.
      const called = await apiJson(request, `/api/v1/fixtures/${seed.calDee}/call`, "POST", { court_id: seed.court2Id });
      expect(called.status, JSON.stringify(called.error)).toBeLessThan(300);
      await vp.reload({ waitUntil: "load" });
      await row(vp, seed.court2).click();
      await expect(focus).toHaveAttribute("data-state", "called");
      await expect(focus.getByTestId("md-undo-call")).toHaveCount(0);

      // The server refuses each write on its own, through the real routes — hiding a button is never the only guard.
      const before = await withDb(async (sql) => ({
        calls: (await sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id in ${sql([seed.calDee, seed.anaCal])}`)[0]!.n,
        links: (await sql<{ n: number }[]>`select count(*)::int as n from device_links where fixture_id = ${seed.anaBen}`)[0]!.n,
      }));
      const refusals = [
        ["call", await apiJson(vp.request, `/api/v1/fixtures/${seed.anaCal}/call`, "POST", { court_id: seed.court2Id })],
        ["undo", await apiJson(vp.request, `/api/v1/fixtures/${seed.calDee}/call`, "DELETE")],
        ["scorer link", await apiJson(vp.request, `/api/v1/fixtures/${seed.anaBen}/device-links`, "POST", {})],
      ] as const;
      for (const [label, r] of refusals) expect(r.status, `${label}: ${JSON.stringify(r.error)}`).toBe(403);
      // Which doors refused, read off the RESPONSES (their status and the door's own sentence), not the list typed above.
      const refusedBy = refusals.filter(([, r]) => r.status === 403 && r.error?.message === "Insufficient permissions").map(([label]) => label);
      expect(refusedBy).toEqual(["call", "undo", "scorer link"]);
      const after = await withDb(async (sql) => ({
        calls: (await sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id in ${sql([seed.calDee, seed.anaCal])}`)[0]!.n,
        links: (await sql<{ n: number }[]>`select count(*)::int as n from device_links where fixture_id = ${seed.anaBen}`)[0]!.n,
      }));
      expect(after, "a viewer wrote nothing").toEqual(before);
      expect(before.calls, "premise: the organiser's call is the one row").toBe(1);

      await vp.setViewportSize({ width: 320, height: 568 });
      await vp.reload({ waitUntil: "load" });
      await expect(vp.getByTestId("md-read-only")).toBeVisible();
      await expectNoHorizontalScroll(vp);
    } finally {
      await viewer.close();
    }
    // The organiser's own page is unchanged: the toggle-free header was the role, not the board.
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    await expect(page.getByTestId("md-read-only")).toHaveCount(0);
  });

  test("Needs you's unscheduled row: Find a court opens the free court's candidates in place and closes the list; its link opens the same court from a fresh load at 320", async ({
    page,
    request,
  }) => {
    const seed = await seedMatchDay(request, "FindCourt", { needsYou: true });
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    const toggle = page.getByTestId("md-needs-you-toggle");
    await toggle.click();
    const unscheduled = page.getByTestId("md-needs-you").locator('[data-attention="unscheduled"]');
    await expect(unscheduled).toHaveCount(1);
    // The board stays the row's action; Find a court is the second, quieter way in.
    await expect(unscheduled.getByRole("link", { name: UI_EN["desk.needsYou.unscheduled.action"]! }).locator("visible=true")).toBeVisible();
    const find = unscheduled.locator("[data-needs-you-alt]").locator("visible=true");
    await expect(find).toHaveText(UI_EN["matchDay.needsYou.findCourt.court"]!);
    const href = await find.getAttribute("href");
    expect(href, "Find a court names a court").toMatch(new RegExp(`/match-day\\?court=${seed.court2Id}$`));
    const url = page.url();
    await find.click();
    await expect(page.getByTestId("md-focus")).toContainText(`${seed.court2} is free`);
    await expect(page.getByTestId("md-focus").getByTestId("md-candidate").first()).toBeVisible();
    // The link's promise (fix round 1, R5): the court it opened lists the division's unscheduled matches themselves — every
    // ready one with no court and no time, read from the rows, not from the page.
    const unscheduledIds = await withDb(async (sql) =>
      (
        await sql<{ id: string }[]>`
          select id from fixtures
           where division_id = ${seed.divisionId} and status = 'scheduled' and court_id is null and scheduled_at is null
             and home_entrant_id is not null and away_entrant_id is not null`
      ).map((r) => r.id),
    );
    expect(unscheduledIds.length, "premise: the division has unscheduled matches").toBeGreaterThan(0);
    for (const id of unscheduledIds) {
      await expect(page.getByTestId("md-focus").locator(`[data-testid="md-candidate"][data-fixture-id="${id}"]`), id).toHaveCount(1);
    }
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
    expect(page.url(), "opened in place, no navigation").toBe(url);
    await expectNoHorizontalScroll(page);

    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(href!, { waitUntil: "load" });
    await expect(page.getByTestId("md-focus")).toBeVisible();
    await expect(page.getByTestId("md-focus")).toContainText(`${seed.court2} is free`);
    await expect(page.getByTestId("md-list")).toBeHidden();
    await expectNoHorizontalScroll(page);
  });
});

/**
 * Match Day E2 (owner 2026-11-01): items 1, 2, 3, 4, 5 and 7, in a real browser. What the node suite cannot see: that the fold
 * opens in place and keeps the list's order, that the venue filter's popover / bottom sheet is operable and its choice survives a
 * reload through the address, that a closure shows on a card and a court closed now is "Closed" (not free, counted out of "N free",
 * after the free ones) whose Call stays ON and asks "Call anyway?" in the sheet (fix round 1, R0/m2), while a break still to come
 * is only a warning in the call sheet, that the candidate rows print the planned time, and that every match wears the schedule
 * board's round chip.
 *
 * The seed is one competition on SIX courts in TWO venues (Hall A: A1-A4, Hall B: B1-B2) with a league of four and a
 * knockout cup of four (two semi-finals and a final):
 *   - A1: Ana v Ben IN PLAY (a real core.start), Ana v Cal and the cup's semi-final 2 queued behind it;
 *   - A2: Ben v Cal queued;   B1: the cup's semi-final 1 queued;   A3, A4, B2: free with nothing queued - the fold;
 *   - Ben v Dee: planned later today, NO court;   Cal v Dee and Ana v Dee: no time, no court;
 *   - A3 has a break coming (hours either side of it); A4 is closed all of today (an exception).
 * Every expectation is read from the rows or from the dictionary, never typed from the page: the planned times from
 * `scheduled_at` in the view's own zone, the rounds from `fixtures.round_no` (a league's R{n}) and the design's words (a semi-final).
 */
interface E2Seed {
  competitionId: string;
  tz: string;
  courts: Record<"a1" | "a2" | "a3" | "a4" | "b1" | "b2", { id: string; name: string }>;
  venues: { a: { id: string; name: string }; b: { id: string; name: string } };
  fx: { anaBen: string; anaCal: string; benCal: string; benDee: string; calDee: string; sf1: string; sf2: string };
  /** Minutes (in the view's zone) of the break on A3: it closes at `breakFrom` and reopens at `breakTo`; null when too late in the
   *  day for a break still to come (the last 50 minutes). */
  breakWindow: { from: number; to: number } | null;
}

const hhmm = (instant: Date | string, tz: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
const minToClock = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** The weekday (0 = Sunday, as court_hours), the date and the minute of the day of an instant in a zone. */
function zonedParts(instant: Date, tz: string): { weekday: number; date: string; minute: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return { weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!), date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

async function seedE2(request: APIRequestContext, label: string): Promise<E2Seed> {
  const nonce = Math.random().toString(36).slice(2, 7);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Match Day E2 ${label} ${TAG}`,
    visibility: "public",
  });
  if (comp.status >= 300 || !comp.data) throw new Error(`competition → ${comp.status} ${JSON.stringify(comp.error)}`);
  const competitionId = comp.data.id;
  const hallA = await seedVenueWithCourts(request, [`E2A1 ${nonce}`, `E2A2 ${nonce}`, `E2A3 ${nonce}`, `E2A4 ${nonce}`], { venueName: `Hall A ${nonce} ${TAG}` });
  const hallB = await seedVenueWithCourts(request, [`E2B1 ${nonce}`, `E2B2 ${nonce}`], { venueName: `Hall B ${nonce} ${TAG}` });
  const [a1, a2, a3, a4] = hallA.courts as [E2Seed["courts"]["a1"], E2Seed["courts"]["a2"], E2Seed["courts"]["a3"], E2Seed["courts"]["a4"]];
  const [b1, b2] = hallB.courts as [E2Seed["courts"]["b1"], E2Seed["courts"]["b2"]];
  const allCourts = [a1, a2, a3, a4, b1, b2].map((c) => c.id);

  const division = async (name: string, entrants: string[], stage?: { kind: string; name: string; config?: Record<string, unknown> }) => {
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", { name, sport_key: "generic", variant_key: "score" });
    if (div.status >= 300 || !div.data) throw new Error(`division → ${div.status} ${JSON.stringify(div.error)}`);
    const ents = await addEntrantsViaApi(request, div.data.id, entrants);
    if (ents.status >= 300 || ents.ids.length !== entrants.length) throw new Error(`entrants → ${ents.status}`);
    await createStageAndGenerate(request, div.data.id, stage);
    const started = await apiJson(request, `/api/v1/divisions/${div.data.id}/start`, "POST");
    expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
    const settings = await apiJson(request, `/api/v1/divisions/${div.data.id}/schedule-settings`, "PUT", { tz: "UTC", config: { matchMinutes: 30, courts: allCourts } });
    expect(settings.status, `schedule settings: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
    return { id: div.data.id, ents: ents.ids };
  };
  const names = { ana: `Ana ${nonce}`, ben: `Ben ${nonce}`, cal: `Cal ${nonce}`, dee: `Dee ${nonce}` };
  const league = await division("E2 League", [names.ana, names.ben, names.cal, names.dee]);
  const cup = await division("E2 Cup", [`Wil ${nonce}`, `Xan ${nonce}`, `Yun ${nonce}`, `Zed ${nonce}`], { kind: "knockout", name: "Cup", config: {} });

  const now = Date.now();
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const within = (offsetMin: number) =>
    new Date(Math.min(dayStart + 86_400_000 - 60_000, Math.max(dayStart + 60_000, now + offsetMin * 60_000))).toISOString();
  const [ana, ben, cal, dee] = league.ents as [string, string, string, string];
  const rows = await withDb((sql) => sql<{ id: string; division_id: string; home_entrant_id: string | null; away_entrant_id: string | null; round_no: number }[]>`
    select id, division_id, home_entrant_id, away_entrant_id, round_no from fixtures where division_id in ${sql([league.id, cup.id])} order by round_no, seq_in_round`);
  const pair = (x: string, y: string) => {
    const f = rows.find((r) => r.division_id === league.id && ((r.home_entrant_id === x && r.away_entrant_id === y) || (r.home_entrant_id === y && r.away_entrant_id === x)));
    if (!f) throw new Error(`no league fixture between ${x} and ${y}`);
    return f.id;
  };
  const semis = rows.filter((r) => r.division_id === cup.id && r.round_no === 1);
  expect(semis, "premise: a four-entrant knockout opens with two semi-finals").toHaveLength(2);
  const fx = { anaBen: pair(ana, ben), anaCal: pair(ana, cal), benCal: pair(ben, cal), benDee: pair(ben, dee), calDee: pair(cal, dee), sf1: semis[0]!.id, sf2: semis[1]!.id };
  await withDb(async (sql) => {
    await sql`update fixtures set court_id = ${a1.id}, scheduled_at = ${within(-20)} where id = ${fx.anaBen}`;
    await sql`update fixtures set court_id = ${a1.id}, scheduled_at = ${within(60)} where id = ${fx.anaCal}`;
    await sql`update fixtures set court_id = ${a1.id}, scheduled_at = ${within(75)} where id = ${fx.sf2}`;
    await sql`update fixtures set court_id = ${a2.id}, scheduled_at = ${within(50)} where id = ${fx.benCal}`;
    await sql`update fixtures set court_id = null, scheduled_at = ${within(120)} where id = ${fx.benDee}`;
    await sql`update fixtures set court_id = ${b1.id}, scheduled_at = ${within(45)} where id = ${fx.sf1}`;
  });
  await startFixture(request, fx.anaBen);

  // The view's own zone and clock, then A3's break and A4's closed day, in that zone.
  const view = await apiJson<{ tz: string; now: string }>(request, `/api/v1/competitions/${competitionId}/match-day`);
  expect(view.status).toBe(200);
  const tz = view.data!.tz;
  const z = zonedParts(new Date(view.data!.now), tz);
  const from = z.minute + 15;
  const to = from + 30;
  const breakWindow = to <= 1439 ? { from, to } : null;
  await withDb(async (sql) => {
    const [c] = await sql<{ org_id: string }[]>`select org_id from courts where id = ${a3.id}`;
    const org = c!.org_id;
    if (breakWindow !== null) {
      await sql`insert into court_hours (court_id, org_id, weekday, open_min, close_min) values
        (${a3.id}, ${org}, ${z.weekday}, 0, ${breakWindow.from}), (${a3.id}, ${org}, ${z.weekday}, ${breakWindow.to}, 1440)`;
    }
    await sql`insert into court_exceptions (court_id, org_id, date, closed) values (${a4.id}, ${org}, ${z.date}, true)`;
  });
  return { competitionId, tz, courts: { a1, a2, a3, a4, b1, b2 }, venues: { a: { id: hallA.venueId, name: `Hall A ${nonce} ${TAG}` }, b: { id: hallB.venueId, name: `Hall B ${nonce} ${TAG}` } }, fx, breakWindow };
}

const courtIdsInList = (page: Page): Promise<string[]> =>
  page.getByTestId("md-court-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-court-id") ?? ""));
/** The en template with its placeholders filled. */
const fill = (template: string, vars: Record<string, string | number>): string =>
  Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), template);

/** Round-trips the desk list: what the E2 list/fold/closure/venue/chip items look like at a width. */
async function e2ListChecks(page: Page, request: APIRequestContext, seed: E2Seed): Promise<void> {
  const { courts } = seed;
  await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
  await expect(page.getByTestId("md-court-row").first()).toBeVisible();

  // ITEM 2: playing -> up next (courts with a match queued, in list order); the three free, empty courts are one fold row.
  // Fix round 1, m2: A4 (closed for the day) is not "free": it is the list's LAST row, after the fold, never inside it.
  expect(await courtIdsInList(page), "playing first, then the courts with something waiting, in list order, then the closed one").toEqual([courts.a1.id, courts.a2.id, courts.b1.id, courts.a4.id]);
  const fold = page.getByTestId("md-court-fold");
  await expect(fold).toBeVisible();
  // m5: the two folded courts (A3 in Hall A, B2 in Hall B) do not make one range of names, and sit in different venues, so the
  // label is the count alone.
  const foldText = fill(UI_EN["matchDay.list.freeFoldCount.court.other"]!, { count: 2 });
  await expect(page.getByTestId("md-court-fold-toggle")).toHaveText(foldText);
  await expect(page.getByTestId("md-court-fold-toggle")).toHaveAttribute("aria-expanded", "false");
  for (const c of [courts.a3, courts.b2]) await expect(row(page, c.name), `${c.name} is folded away`).toHaveCount(0);
  // m2: the closed court says Closed, not Free, and leaves the header's free count: 6 courts, 1 playing, 4 free (A2, B1, A3, B2).
  await expect(row(page, courts.a4.name)).toContainText(UI_EN["matchDay.state.closed"]!);
  await expect(row(page, courts.a4.name)).not.toContainText(new RegExp(`\\b${UI_EN["matchDay.state.free"]}\\b`));
  await expect(row(page, courts.a4.name)).toHaveAttribute("data-closed", "true");
  await expect(page.getByTestId("md-counts")).toContainText(fill(UI_EN["matchDay.header.free"]!, { count: 4 }));
  await expectNoHorizontalScroll(page);

  // It opens in place - the live rows stay where they were, and the two courts appear after them, in list order; the closed court stays last.
  await page.getByTestId("md-court-fold-toggle").click();
  await expect(page.getByTestId("md-court-fold-toggle")).toHaveAttribute("aria-expanded", "true");
  expect(await courtIdsInList(page)).toEqual([courts.a1.id, courts.a2.id, courts.b1.id, courts.a3.id, courts.b2.id, courts.a4.id]);

  // ITEM 3: a break still to come on A3 (a card, not a stop), the whole day closed on A4, nothing on B2.
  if (seed.breakWindow !== null) {
    const later = row(page, courts.a3.name).getByTestId("md-closure");
    await expect(later).toHaveAttribute("data-kind", "later");
    await expect(later).toHaveText(fill(UI_EN["matchDay.closure.later"]!, { from: minToClock(seed.breakWindow.from), until: minToClock(seed.breakWindow.to) }));
  }
  const now = row(page, courts.a4.name).getByTestId("md-closure");
  await expect(now).toHaveAttribute("data-kind", "now");
  await expect(now).toHaveText(UI_EN["matchDay.closure.rest"]!);
  await expect(row(page, courts.b2.name).getByTestId("md-closure")).toHaveCount(0);
  await expect(row(page, courts.a1.name).getByTestId("md-closure")).toHaveCount(0);

  // ITEM 7: the board's chip in front of the names - a league round is R{n} (its row's round_no), a semi-final is SF.
  const anaBenRound = await withDb((sql) => sql<{ round_no: number }[]>`select round_no from fixtures where id = ${seed.fx.anaBen}`);
  const a1Chip = row(page, courts.a1.name).getByTestId("md-round-chip");
  await expect(a1Chip).toHaveAttribute("data-round-code", `R${anaBenRound[0]!.round_no}`);
  await expect(a1Chip).toHaveAttribute("data-round-coded", "false");
  const b1Chip = row(page, courts.b1.name).getByTestId("md-round-chip");
  await expect(b1Chip).toHaveAttribute("data-round-code", "SF");
  await expect(b1Chip).toHaveAttribute("data-round-coded", "true");
  await expect(b1Chip).toHaveAttribute("title", UI_EN["bracket.round.semi"]!);
  await expect(b1Chip.locator(".sr-only")).toHaveText(UI_EN["bracket.round.semi"]!);
  await expect(b1Chip.locator('[aria-hidden="true"]')).toHaveText("SF");
  await expectNoHorizontalScroll(page);
}

test.describe("Match Day — E2 items 1, 2, 3, 5, 7 (desktop)", () => {
  test("the list: order and fold, closures on cards, the board's round chips, the venue filter and its address; then A4 pauses Call, A3 warns, and the candidates print their planned time", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const seed = await seedE2(request, "Desk");
    const { courts, fx } = seed;
    await e2ListChecks(page, request, seed);

    // ITEM 3 (R0): A4 is closed for the rest of today. It is a court the organiser may still call a match onto - a venue running late is
    // real - so Call stays ON, the panel says it is closed (not "free", no "could start here now"), and the sheet asks.
    await row(page, courts.a4.name).click();
    const focus = page.getByTestId("md-focus");
    await expect(focus).toContainText(fill(UI_EN["matchDay.free.closedTitle"]!, { court: courts.a4.name }));
    await expect(focus).not.toContainText(`${courts.a4.name} is free`);
    await expect(focus.getByTestId("md-closure")).toHaveAttribute("data-kind", "now");
    await expect(focus.getByTestId("md-call-paused")).toHaveCount(0);
    await expect(focus.getByTestId("md-free-panel")).not.toContainText("could start here now");
    await expect(focus.getByTestId("md-free-panel")).toContainText(UI_EN["matchDay.closure.rest"]!);
    const calls = focus.getByRole("button", { name: /^Call to / });
    await expect.poll(() => calls.count(), { message: "premise: there is a match that could be called" }).toBeGreaterThanOrEqual(1);
    for (const b of await calls.all()) await expect(b).toBeEnabled();
    // Pressing Call opens the preview; its loud, announced question is the court's closure, and its button says what it does.
    const closedCall = focus.locator(`[data-testid="md-candidate"][data-fixture-id="${fx.sf1}"]`).getByRole("button", { name: `Call to ${courts.a4.name}` });
    await closedCall.click();
    const closedSheet = page.getByRole("dialog");
    const closedWarning = closedSheet.locator('[data-testid="md-warning"][data-kind="court_closed"]');
    await expect(closedWarning).toBeVisible();
    await expect(closedWarning).toHaveAttribute("role", "alert");
    await expect(closedWarning).toHaveText(fill(UI_EN["matchDay.sheet.warn.courtClosedToday"]!, { court: courts.a4.name }));
    await expect(closedSheet.getByTestId("md-call-confirm")).toHaveText(UI_EN["matchDay.sheet.confirmAnyway"]!);
    await expect(closedSheet.getByTestId("md-call-confirm")).toBeEnabled();
    await closedSheet.getByRole("button", { name: UI_EN["matchDay.sheet.cancel"]! }).click();
    await expect(closedSheet).toHaveCount(0);
    const closedCalls = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id = ${fx.sf1}`);
    expect(closedCalls[0]!.n, "cancelling the preview called nothing").toBe(0);

    // ITEM 1 + 7 on A3 (free, a break coming): each candidate prints its planned time, then where it waits.
    await row(page, courts.a3.name).click();
    await expect(focus).toContainText(`${courts.a3.name} is free`);
    const planned = await withDb((sql) => sql<{ id: string; scheduled_at: Date | null; round_no: number }[]>`
      select id, scheduled_at, round_no from fixtures where id in ${sql([fx.anaCal, fx.benCal, fx.benDee, fx.calDee, fx.sf1, fx.sf2])}`);
    const of = (id: string) => planned.find((p) => p.id === id)!;
    const cand = (id: string) => focus.locator(`[data-testid="md-candidate"][data-fixture-id="${id}"]`);
    // The NEXT match of each other court (its queue's head), with the plan that court holds it to.
    await expect(cand(fx.anaCal)).toContainText(`${hhmm(of(fx.anaCal).scheduled_at!, seed.tz)} · ${fill(UI_EN["matchDay.candidate.where.nextOn"]!, { court: courts.a1.name })}`);
    await expect(cand(fx.benCal)).toContainText(`${hhmm(of(fx.benCal).scheduled_at!, seed.tz)} · ${fill(UI_EN["matchDay.candidate.where.nextOn"]!, { court: courts.a2.name })}`);
    await expect(cand(fx.sf1)).toContainText(`${hhmm(of(fx.sf1).scheduled_at!, seed.tz)} · ${fill(UI_EN["matchDay.candidate.where.nextOn"]!, { court: courts.b1.name })}`);
    // Behind another match on its court, a match is not "next" anywhere: it is not offered.
    await expect(cand(fx.sf2)).toHaveCount(0);
    // Planned, no court: the plan leads, then "no court".
    await expect(cand(fx.benDee)).toContainText(`${hhmm(of(fx.benDee).scheduled_at!, seed.tz)} · ${UI_EN["matchDay.candidate.where.noCourt"]}`);
    // No time at all is the only "Not scheduled".
    await expect(cand(fx.calDee)).toContainText(UI_EN["matchDay.candidate.where.unscheduled"]!);
    await expect(cand(fx.calDee)).not.toContainText(/\d\d:\d\d/);
    // Every candidate wears its round: R{n} for the league (the row's round_no), SF for the cup's semi-finals.
    await expect(cand(fx.calDee).getByTestId("md-round-chip")).toHaveAttribute("data-round-code", `R${of(fx.calDee).round_no}`);
    await expect(cand(fx.anaCal).getByTestId("md-round-chip")).toHaveAttribute("data-round-code", `R${of(fx.anaCal).round_no}`);
    await expect(cand(fx.sf1).getByTestId("md-round-chip")).toHaveAttribute("data-round-code", "SF");
    await expectNoHorizontalScroll(page);

    // ITEM 3, the warning: calling Cal v Dee to A3 would still be on when the break starts - warned, never refused.
    if (seed.breakWindow !== null) {
      await expect(focus.getByTestId("md-closure")).toHaveAttribute("data-kind", "later");
      await expect(focus.getByTestId("md-call-paused")).toHaveCount(0);
      await cand(fx.calDee).getByRole("button", { name: `Call to ${courts.a3.name}` }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByTestId("md-call-confirm")).toBeEnabled();
      const warning = sheet.locator('[data-testid="md-warning"][data-kind="crosses_closure"]');
      await expect(warning).toHaveText(fill(UI_EN["matchDay.sheet.warn.crossesClosure"]!, { court: courts.a3.name, from: minToClock(seed.breakWindow.from), until: minToClock(seed.breakWindow.to) }));
      // The sheet's heading carries the match's chip.
      await expect(sheet.getByTestId("md-round-chip")).toHaveAttribute("data-round-code", `R${of(fx.calDee).round_no}`);
      await sheet.getByRole("button", { name: UI_EN["matchDay.sheet.cancel"]! }).click();
      await expect(sheet).toHaveCount(0);
      const calledRows = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id = ${fx.calDee}`);
      expect(calledRows[0]!.n, "cancelling the preview called nothing").toBe(0);
    }

    // The focus panel names the rounds too: the match on court (A1) and, under it, "Up next here" - a league match and the cup's
    // semi-final, each with its own chip, in planned order.
    await row(page, courts.a1.name).click();
    await expect(focus.getByTestId("md-scoreboard")).toBeVisible();
    const anaBenRound = await withDb((sql) => sql<{ round_no: number }[]>`select round_no from fixtures where id = ${fx.anaBen}`);
    await expect(focus.getByTestId("md-round-chip").first()).toHaveAttribute("data-round-code", `R${anaBenRound[0]!.round_no}`);
    const queue = focus.getByTestId("md-queue-row");
    await expect(queue).toHaveCount(2);
    await expect(queue.nth(0).getByTestId("md-round-chip")).toHaveAttribute("data-round-code", `R${of(fx.anaCal).round_no}`);
    await expect(queue.nth(1).getByTestId("md-round-chip")).toHaveAttribute("data-round-code", "SF");
    // A free court's own next match is a candidate "Next here", with its chip.
    await row(page, courts.b1.name).click();
    await expect(cand(fx.sf1)).toContainText(UI_EN["matchDay.candidate.where.here"]!);
    await expect(cand(fx.sf1).getByTestId("md-round-chip")).toHaveAttribute("data-round-code", "SF");
    await expectNoHorizontalScroll(page);

    // ITEM 5: the venue filter. Both venues have a match today, so it opens on all of them.
    const trigger = page.getByTestId("md-venue-trigger");
    await expect(trigger).toBeVisible();
    await expect(page.getByTestId("md-venue-summary")).toHaveText(UI_EN["matchDay.venue.triggerAll"]!);
    await trigger.click();
    const panel = page.getByTestId("md-venue-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("md-venue-all")).toBeChecked();
    await expect(page.getByTestId("md-venue-option")).toHaveCount(2);
    // Hall A off: only Hall B's courts are listed, the summary names the one venue, and the address carries the choice.
    await panel.locator(`[data-testid="md-venue-option"][data-venue-id="${seed.venues.a.id}"]`).uncheck();
    await expect(page.getByTestId("md-venue-summary")).toHaveText(seed.venues.b.name);
    await expect(page.getByTestId("md-venue-all")).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(trigger, "Esc hands focus back to the button").toBeFocused();
    // Hall B alone: its queued court, then its one free court - a single free court is a row of its own, not a fold (a fold hides two).
    expect(await courtIdsInList(page)).toEqual([courts.b1.id, courts.b2.id]);
    await expect(page.getByTestId("md-court-fold")).toHaveCount(0);
    await expect(row(page, courts.a1.name)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("venue")).toBe(seed.venues.b.id);
    // It is DISPLAY ONLY: a court of the hidden venue is still named in the guard's words (A1 holds Ana, so Ana's other matches say so).
    await expect(page.getByTestId("md-counts")).toBeVisible();
    // A reload brings the same selection back from the address.
    await page.reload({ waitUntil: "load" });
    await expect(page.getByTestId("md-venue-summary")).toHaveText(seed.venues.b.name);
    expect(await courtIdsInList(page)).toEqual([courts.b1.id, courts.b2.id]);
    // "Show all venues" is back to everything, and the address says so.
    await page.getByTestId("md-venue-trigger").click();
    await page.getByTestId("md-venue-all").check();
    await expect(page.getByTestId("md-venue-summary")).toHaveText(UI_EN["matchDay.venue.triggerAll"]!);
    await page.keyboard.press("Escape");
    expect(new URL(page.url()).searchParams.get("venue")).toBe("all");
    // The closed court is still the list's last row, after the (collapsed) fold of A3 and B2.
    expect(await courtIdsInList(page)).toEqual([courts.a1.id, courts.a2.id, courts.b1.id, courts.a4.id]);
    await expectNoHorizontalScroll(page);

    // R0, the call itself: the closed court takes it as a confirmed "Call anyway" - the API only ever warned.
    await row(page, courts.a4.name).click();
    await focus.locator(`[data-testid="md-candidate"][data-fixture-id="${fx.sf1}"]`).getByRole("button", { name: `Call to ${courts.a4.name}` }).click();
    const anywaySheet = page.getByRole("dialog");
    await expect(anywaySheet.getByTestId("md-call-confirm")).toHaveText(UI_EN["matchDay.sheet.confirmAnyway"]!);
    await anywaySheet.getByTestId("md-call-confirm").click();
    await expect(anywaySheet).toHaveCount(0);
    await expect(focus).toHaveAttribute("data-state", "called");
    const landed = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id = ${fx.sf1} and court_id = ${courts.a4.id}`);
    expect(landed[0]!.n, "the match was called onto the closed court").toBe(1);
    // It is no longer a closed EMPTY court: it has a match called to it, so it leaves the closed group for the called one, and its
    // card keeps the closure line.
    await expect(row(page, courts.a4.name)).toHaveAttribute("data-state", "called");
    await expect(row(page, courts.a4.name)).not.toHaveAttribute("data-closed", /.+/);
    await expect(row(page, courts.a4.name).getByTestId("md-closure")).toHaveAttribute("data-kind", "now");

    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByTestId("md-list")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe("Match Day — fix round 1, I3 (the venue filter and Back)", () => {
  test("a venue chosen on the page is still chosen after a client-side trip to a match page or the competition and the browser's Back - the selection AND the address", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const seed = await seedE2(request, "Back");
    const { courts, venues } = seed;
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    await expect(page.getByTestId("md-court-row").first()).toBeVisible();
    // Both venues have a match today: the page opens on all of them and the address carries no choice yet - which is exactly
    // what Next keeps as the page's props, and hands back on Back.
    expect(new URL(page.url()).searchParams.get("venue")).toBeNull();
    await expect(page.getByTestId("md-venue-summary")).toHaveText(UI_EN["matchDay.venue.triggerAll"]!);

    await page.getByTestId("md-venue-trigger").click();
    await page.getByTestId("md-venue-panel").locator(`[data-testid="md-venue-option"][data-venue-id="${venues.b.id}"]`).uncheck();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("md-venue-summary")).toHaveText(venues.a.name);
    const chosenUrl = new URL(page.url());
    expect(chosenUrl.searchParams.get("venue")).toBe(venues.a.id);
    const hallA = await courtIdsInList(page);
    expect(hallA, "premise: Hall A's courts are listed, none of Hall B's").toEqual(expect.arrayContaining([courts.a1.id, courts.a2.id]));
    expect(hallA).not.toContain(courts.b1.id);

    // A mark on this document: it survives a client-side navigation and dies with a full page load, so the trip below is proven to
    // be the router's (the case that rebuilds the page from its cache) and not a reload that would read the address afresh.
    await page.evaluate(() => ((window as unknown as { __mdTrip: number }).__mdTrip = 1));
    const stillSameDocument = () => page.evaluate(() => (window as unknown as { __mdTrip?: number }).__mdTrip === 1);
    const backOnTheList = async (label: string) => {
      await expect(page.getByTestId("md-court-row").first(), label).toBeVisible();
      expect(await stillSameDocument(), `${label}: the trip never reloaded the document`).toBe(true);
      expect(new URL(page.url()).searchParams.get("venue"), `${label}: the address still carries the choice`).toBe(venues.a.id);
      await expect(page.getByTestId("md-venue-summary"), `${label}: the filter still names Hall A`).toHaveText(venues.a.name);
      expect(await courtIdsInList(page), `${label}: the same courts are listed`).toEqual(hallA);
      await expect(row(page, courts.b1.name), `${label}: Hall B stays off the list`).toHaveCount(0);
    };

    // Trip 1: the playing court's match page, by the app's own link.
    await row(page, courts.a1.name).click();
    await page.getByTestId("md-focus").getByTestId("md-open-pad").click();
    await page.waitForURL((u) => u.pathname !== chosenUrl.pathname, { timeout: 30_000 });
    expect(await stillSameDocument(), "the link navigated client-side").toBe(true);
    await page.goBack();
    await page.waitForURL((u) => u.pathname === chosenUrl.pathname);
    await backOnTheList("after the match page");

    // Trip 2: the competition, by the page header's own link (the site bar carries a second "Back to" chevron: not that one).
    await page.getByTestId("md-header").getByRole("link", { name: /^Back to / }).click();
    await page.waitForURL((u) => u.pathname !== chosenUrl.pathname, { timeout: 30_000 });
    expect(await stillSameDocument(), "the link navigated client-side").toBe(true);
    await page.goBack();
    await page.waitForURL((u) => u.pathname === chosenUrl.pathname);
    await backOnTheList("after the competition");

    // And the choice is still live: Hall B back on, the address says all.
    await page.getByTestId("md-venue-trigger").click();
    await page.getByTestId("md-venue-all").check();
    await page.keyboard.press("Escape");
    expect(new URL(page.url()).searchParams.get("venue")).toBe("all");
    await expect(page.getByTestId("md-venue-summary")).toHaveText(UI_EN["matchDay.venue.triggerAll"]!);
    await expectNoHorizontalScroll(page);
  });
});

test.describe("Match Day — E2 items 2, 3, 5, 7 (phone 320)", () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test("the same list at 320: fold opens in place, closures and chips fit, the venue filter is a bottom sheet of 44px rows with a Done button; no sideways scroll", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const seed = await seedE2(request, "Phone");
    const { courts } = seed;
    await e2ListChecks(page, request, seed);

    // The venue filter on a phone: a sheet from the bottom edge, a real checklist, every row a 44px target, Done to leave.
    const trigger = page.getByTestId("md-venue-trigger");
    await expect(trigger).toBeVisible();
    const tBox = await trigger.boundingBox();
    expect(tBox!.height, "the trigger is a 44px target on a phone").toBeGreaterThanOrEqual(44);
    await trigger.click();
    const panel = page.getByTestId("md-venue-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("md-venue-backdrop")).toBeVisible();
    const box = await panel.boundingBox();
    expect(box!.y + box!.height, "the sheet sits on the bottom edge").toBeGreaterThanOrEqual(568 - 1);
    expect(box!.x, "full width").toBeLessThanOrEqual(1);
    for (const input of await panel.locator("input[type=checkbox]").all()) {
      const rowBox = await input.locator("xpath=ancestor::label[1]").boundingBox();
      expect(rowBox!.height, "each venue row is a 44px target").toBeGreaterThanOrEqual(44);
    }
    // Fix round 1, m6: the button says what it opens (expanded + controls, no haspopup), opening moves focus INTO the sheet, and
    // Esc, a tap on the backdrop and Done each close it and hand focus back to the button.
    await expect(trigger).not.toHaveAttribute("aria-haspopup");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await trigger.getAttribute("aria-controls"), "the button controls the sheet it opened").toBe(await panel.getAttribute("id"));
    await expect(panel.locator(":focus"), "opening moved focus into the sheet").toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(trigger, "Esc hands focus back to the button").toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect(panel.locator(":focus")).toHaveCount(1);
    // The backdrop is the part of the page the sheet does not cover: a tap near the top edge.
    await page.getByTestId("md-venue-backdrop").click({ position: { x: 160, y: 20 } });
    await expect(panel).toHaveCount(0);
    await expect(trigger, "the backdrop tap hands focus back to the button").toBeFocused();
    await trigger.click();
    await expect(panel).toBeVisible();
    await panel.locator(`[data-testid="md-venue-option"][data-venue-id="${seed.venues.b.id}"]`).uncheck();
    await expect(page.getByTestId("md-venue-summary")).toHaveText(seed.venues.a.name);
    await panel.getByRole("button", { name: UI_EN["matchDay.venue.done"]! }).click();
    await expect(panel).toHaveCount(0);
    await expect(trigger, "Done hands focus back to the button").toBeFocused();
    expect(await courtIdsInList(page)).toEqual([courts.a1.id, courts.a2.id, courts.a3.id, courts.a4.id]);
    await expectNoHorizontalScroll(page);

    // A court opens full-screen with its chip; back to the list.
    await row(page, courts.a1.name).click();
    await expect(page.getByTestId("md-focus").getByTestId("md-round-chip").first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByTestId("md-back").click();
    await expect(page.getByTestId("md-list")).toBeVisible();
  });
});

/** A competition of one division and two courts in one venue: `n` players in a league, the first two playing on Court 1 (a real
 *  core.start), the rest unplaced. Court 2 is free. */
async function seedTiny(request: APIRequestContext, label: string, n: number): Promise<{ competitionId: string; court2: string }> {
  const nonce = Math.random().toString(36).slice(2, 7);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Match Day E2 ${label} ${TAG}`, visibility: "public" });
  if (comp.status >= 300 || !comp.data) throw new Error(`competition → ${comp.status} ${JSON.stringify(comp.error)}`);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data.id}/divisions`, "POST", { name: "E2 Tiny", sport_key: "generic", variant_key: "score" });
  const ents = await addEntrantsViaApi(request, div.data!.id, Array.from({ length: n }, (_, i) => `P${i + 1} ${label} ${nonce}`));
  if (ents.status >= 300 || ents.ids.length !== n) throw new Error(`entrants → ${ents.status}`);
  await createStageAndGenerate(request, div.data!.id);
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const { courts } = await seedVenueWithCourts(request, [`E2T1 ${nonce}`, `E2T2 ${nonce}`]);
  const settings = await apiJson(request, `/api/v1/divisions/${div.data!.id}/schedule-settings`, "PUT", { tz: "UTC", config: { matchMinutes: 30, courts: courts.map((c) => c.id) } });
  expect(settings.status, `schedule settings: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
  const [p1, p2] = ents.ids as [string, string];
  const first = await withDb((sql) => sql<{ id: string }[]>`
    select id from fixtures where division_id = ${div.data!.id}
       and ((home_entrant_id = ${p1} and away_entrant_id = ${p2}) or (home_entrant_id = ${p2} and away_entrant_id = ${p1}))`);
  const now = Date.now();
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const at = new Date(Math.min(dayStart + 86_400_000 - 60_000, Math.max(dayStart + 60_000, now - 10 * 60_000))).toISOString();
  await withDb((sql) => sql`update fixtures set court_id = ${courts[0]!.id}, scheduled_at = ${at} where id = ${first[0]!.id}`);
  await startFixture(request, first[0]!.id);
  return { competitionId: comp.data.id, court2: courts[1]!.name };
}

test.describe("Match Day — E2 item 4: two different 'no match' messages", () => {
  test("nothing waiting says so; matches waiting but all blocked say that, with the count and each reason - at 1280 and 320", async ({ page, request }) => {
    test.setTimeout(120_000);
    // Two players, one match, in play: Court 2 has nothing to offer at all.
    const none = await seedTiny(request, "None", 2);
    await page.goto(await competitionPath(request, none.competitionId, "/match-day"), { waitUntil: "load" });
    await row(page, none.court2).click();
    const panel = page.getByTestId("md-free-panel");
    await expect(panel).toContainText(UI_EN["matchDay.free.nothingWaiting"]!);
    await expect(panel).not.toContainText("can't start yet");
    await expect(page.getByTestId("md-focus").getByTestId("md-candidate")).toHaveCount(0);

    // Three players, the first two playing: the other two matches are waiting, and both involve a player on court.
    const blocked = await seedTiny(request, "Blocked", 3);
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
      await page.goto(await competitionPath(request, blocked.competitionId, "/match-day"), { waitUntil: "load" });
      await row(page, blocked.court2).click();
      const focus = page.getByTestId("md-focus");
      const rows = focus.getByTestId("md-candidate");
      await expect(rows).toHaveCount(2);
      for (const r of await rows.all()) await expect(r).toHaveAttribute("data-blocked", "true");
      const free = page.getByTestId("md-free-panel");
      await expect(free).toContainText(fill(UI_EN["matchDay.free.allBlocked.other"]!, { count: 2 }));
      await expect(free).not.toContainText(UI_EN["matchDay.free.nothingWaiting"]!);
      await expect(free).not.toContainText(/could start here now/);
      await expectNoHorizontalScroll(page);
    }
  });
});

/**
 * Match Day PB2 (owner 2026-11-02): a billing-frozen competition — its organisation over `competitions.max_active` — still
 * SCORES ("apply rec", option A) and starts no new stream ("hide"); Call and Undo stay refused. Driven on an organisation of its
 * OWN: the freeze is organisation-wide (the override pins the ceiling at 0), and the shared e2e organisation must never freeze.
 * Pro, so the scorer QR is a real QR rather than the plan's paywall. Seeded through the owner's own session, then frozen, and the
 * board read before the freeze first, so each absence below is the freeze and not the seed.
 */
test.describe("Match Day — PB2: a billing-frozen competition scores, calls nothing, connects no new stream", () => {
  test("frozen: the pad link and scorer QR stay, no Call and no '+ Connect a stream' (both refused 402 on the server too); a point tapped on the pad lands", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      const { orgId } = await freshOrg(page, "mdfrozen");
      await dismissConsent(page);
      await setOrgPlanBySql({ orgId }, "pro");
      await invalidateOrgEntitlements(page.request, orgId);
      const seed = await seedMatchDay(page.request, "Frozen");
      const path = await competitionPath(page.request, seed.competitionId, "/match-day");

      // Before the freeze (the empty case): no banner, and the playing court offers "+ Connect a stream".
      await page.goto(path, { waitUntil: "load" });
      const focus = page.getByTestId("md-focus");
      await expect(focus).toHaveAttribute("data-state", "playing");
      await expect(page.getByTestId("md-frozen")).toHaveCount(0);
      await expect(focus.getByTestId("md-stream-connect")).toHaveText(UI_EN["matchDay.stream.connect"]!);

      await setEntitlementOverrideSql(orgId, "competitions.max_active", 0);
      await invalidateOrgEntitlements(page.request, orgId);
      await page.reload({ waitUntil: "load" });
      await expect(page.getByTestId("md-frozen")).toHaveText(UI_EN["matchDay.frozen"]!);

      // Court 1, playing: the pad link reads Open pad, the scorer QR mints and shows, and no new stream is offered.
      await expect(focus).toHaveAttribute("data-state", "playing");
      await expect(focus.getByTestId("md-open-pad")).toHaveText(UI_EN["matchDay.focus.openPad"]!);
      await expect(focus.getByTestId("md-stream-connect")).toHaveCount(0);
      await expect(focus).not.toContainText(UI_EN["matchDay.stream.connect"]!);
      const scorer = focus.getByTestId("md-scorer");
      await expect(scorer).toBeVisible();
      await scorer.getByTestId("device-link-mint").click();
      await expect(scorer.getByTestId("dlink-qr")).toBeVisible({ timeout: 15_000 });
      await expectNoHorizontalScroll(page);

      // Court 2, free: its candidates list, with no button to call one.
      await row(page, seed.court2).click();
      await expect(focus).toHaveAttribute("data-state", "free");
      await expect(focus.locator(`[data-testid="md-candidate"][data-fixture-id="${seed.calDee}"]`)).toBeVisible();
      await expect(focus.getByRole("button", { name: /^Call to / })).toHaveCount(0);

      // The server refuses the call and a new stream with the freeze's own 402, through the real routes.
      const call = await apiJson(page.request, `/api/v1/fixtures/${seed.calDee}/call`, "POST", { court_id: seed.court2Id });
      expect(call.status, JSON.stringify(call.error)).toBe(402);
      expect(call.error).toMatchObject({ code: "PAYMENT_REQUIRED", feature_key: "competitions.max_active" });
      const stream = await apiJson(page.request, `/api/v1/fixtures/${seed.anaBen}/stream-sessions`, "POST", {
        mode: "passthrough",
        targetId: "00000000-0000-4000-8000-000000000000",
      });
      expect(stream.status, JSON.stringify(stream.error)).toBe(402);
      expect(stream.error).toMatchObject({ code: "PAYMENT_REQUIRED", feature_key: "competitions.max_active" });

      // Scoring: Open pad from Court 1, tap the home half once, and the point is in the ledger.
      const scored = () =>
        withDb(async (sql) => (await sql<{ n: number }[]>`
          select count(*)::int as n from score_events where fixture_id = ${seed.anaBen} and type = 'generic.score'`)[0]!.n);
      expect(await scored(), "premise: nothing scored yet").toBe(0);
      await row(page, seed.court1).click();
      await expect(focus).toHaveAttribute("data-state", "playing");
      await focus.getByTestId("md-open-pad").click();
      const half = page.locator('[data-role="v3-scorebug"] [data-role="v3-scorebug-half"]').nth(0);
      await expect(half).toBeVisible({ timeout: 30_000 });
      await half.click();
      await expect.poll(scored, { timeout: 30_000, message: "the tapped point reaches score_events" }).toBe(1);
    } finally {
      await context.close();
    }
  });
});

/**
 * Match Day PB2 item 3: the board's POLL (GET …/match-day, what the shell re-reads) carries no Needs-you rows to a view-only
 * member. The organiser's read of the same board is asked first: rows there, none for the viewer — the strip, not an empty day.
 */
test.describe("Match Day — PB2 item 3: a viewer's poll carries no Needs-you rows", () => {
  test("the organiser's read has Needs-you rows; the viewer's read of the same board has none and no owed count", async ({ request, browser }) => {
    const seed = await seedMatchDay(request, "ViewerPoll", { needsYou: true });
    const organiser = await apiJson<{ needs_you: { kind: string }[]; results_owed: number }>(
      request,
      `/api/v1/competitions/${seed.competitionId}/match-day`,
    );
    expect(organiser.status).toBe(200);
    expect(organiser.data!.needs_you.length, "premise: the organiser has Needs-you rows").toBeGreaterThan(0);
    const viewer = await viewerPage(browser, seed.competitionId);
    try {
      const read = await apiJson<{ needs_you: unknown[]; results_owed: number; courts: unknown[] }>(
        viewer.page.request,
        `/api/v1/competitions/${seed.competitionId}/match-day`,
      );
      expect(read.status).toBe(200);
      expect(read.data!.needs_you).toEqual([]);
      expect(read.data!.results_owed).toBe(0);
      expect(read.data!.courts.length, "the board itself is the viewer's to read").toBeGreaterThan(0);
    } finally {
      await viewer.close();
    }
  });
});
