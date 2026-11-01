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
  loginUi,
  scoreFixture,
  seedVenueWithCourts,
  withDb,
} from "./helpers";

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
 *  no_scorer row first). Court 3 is unscored: marked on its row and on its folded "Remote scoring" heading. Opening the
 *  fold and creating the link mints the QR — and a live link IS a scorer (the desk, fix round 1 I1), so the mark goes from
 *  the heading and the row at once. A second visit (`minted`) finds no mark, and Show QR rather than a second Create. */
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
  // A playing court's QR is FOLDED (V5): the heading shows, closed, after the scoreboard; the mark sits on the heading.
  const scorer = focus.getByTestId("md-scorer");
  // The fold's OWN heading: the panel inside has a "More" fold of its own.
  const heading = scorer.locator(":scope > summary");
  await expect(heading).toBeVisible();
  await expect(heading).toContainText("Remote scoring");
  await expect(scorer).not.toHaveAttribute("open", /.*/);
  const mark = heading.locator('[data-md-scorer="no_scorer"]');
  if (minted) await expect(mark).toHaveCount(0);
  else await expect(mark).toBeVisible();
  // AGENTS 22: what the fold hides is ATTACHED before it opens; open it, then it is visible.
  const action = scorer.getByTestId(minted ? "device-link-show" : "device-link-mint");
  await expect(action).toBeAttached();
  await expect(action).toBeHidden();
  await heading.click();
  await expect(scorer).toHaveAttribute("open", "");
  await expect(action).toBeVisible();
  // A4 n1 (task B4): the fold and the panel's own "More" fold are separate NAMED groups — opening this one turns its own
  // chevron and leaves More's, still closed, unturned (an unnamed `group` turned both).
  // Tailwind v4's `rotate-90` writes the `rotate` property, not `transform` (which stays "none" either way).
  await expect(scorer.locator(":scope > summary svg")).toHaveCSS("rotate", "90deg");
  await expect(scorer.getByTestId("device-link-more")).not.toHaveAttribute("open", /.*/);
  await expect(scorer.getByTestId("device-link-more").locator(":scope > summary svg")).toHaveCSS("rotate", "none");
  if (minted) await expect(scorer.getByTestId("device-link-mint")).toHaveCount(0);
  await action.click();
  await expect(scorer.getByTestId("dlink-qr")).toBeVisible({ timeout: 15_000 });
  // Compact: Copy beside the QR; the raw link behind More, closed.
  await expect(scorer.getByTestId("device-link-copy")).toBeVisible();
  await expect(scorer.getByTestId("device-link-url")).toBeAttached();
  await expect(scorer.getByTestId("device-link-url")).toBeHidden();
  if (!minted) {
    // The link is a scorer: the panel re-reads the board, and the mark goes from the heading AND the row — well inside the
    // 20 s live poll, so it is the re-read that moved it, not the next tick.
    await expect(mark).toHaveCount(0, { timeout: 5_000 });
    await expect(r3).not.toHaveAttribute("data-scorer", /.+/, { timeout: 5_000 });
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
    // A4 n2 (task B4): the fold's open state is its MATCH's — Court 3's, opened above, does not carry over to Court 1's
    // (an unkeyed <details> kept its DOM `open` when the focus moved to another playing court).
    await expect(page.getByTestId("md-focus").getByTestId("md-scorer")).toHaveAttribute("open", "");
    await row(page, seed.court1).click();
    await expect(page.getByTestId("md-focus")).toContainText(seed.names.ana);
    await expect(page.getByTestId("md-focus").getByTestId("md-scorer")).toBeAttached();
    await expect(page.getByTestId("md-focus").getByTestId("md-scorer")).not.toHaveAttribute("open", /.*/);

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
      // A division with matches today opens on "Today"; the unscheduled ones live under their own chip.
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
    // Match Day C2: the format it plays, read-only - the one Match format component, with the line the read model serves
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
    await expect(focus.getByTestId("md-scorer").locator(":scope > summary")).toContainText("Remote scoring");
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
    await expect(name).toHaveText(`${nc.home} v ${nc.away}`);
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
