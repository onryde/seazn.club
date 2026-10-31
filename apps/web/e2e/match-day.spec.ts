import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  competitionPath,
  createStageAndGenerate,
  expectNoHorizontalScroll,
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
 *   - Court 1: Ana v Ben IN PLAY (a real core.start), and Ana v Cal queued behind it;
 *   - Court 2: free, with Cal v Dee planned on it later today.
 * So Court 2's candidates are Cal v Dee first (its own next match, both players free), Ana v Cal greyed (Ana is on Court 1)
 * and the unplaced rest, every one of which has Ana or Ben in it, greyed too. Times sit inside today's UTC day whatever the
 * clock says, so the run never straddles a midnight.
 */

interface Seed {
  competitionId: string;
  court1: string;
  court2: string;
  /** Cal v Dee: Court 2's own next match, the top candidate. */
  calDee: string;
  /** Ana v Cal: queued on Court 1, blocked by Ana. */
  anaCal: string;
  names: { ana: string; ben: string; cal: string; dee: string };
}

async function seedMatchDay(request: APIRequestContext, label: string): Promise<Seed> {
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
  const ents = await addEntrantsViaApi(request, divisionId, [names.ana, names.ben, names.cal, names.dee]);
  if (ents.status >= 300 || ents.ids.length !== 4) throw new Error(`entrants → ${ents.status}`);
  const [ana, ben, cal, dee] = ents.ids as [string, string, string, string];
  await createStageAndGenerate(request, divisionId);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);

  const { courts } = await seedVenueWithCourts(request, [`MD1 ${label} ${nonce} ${TAG}`, `MD2 ${label} ${nonce} ${TAG}`]);
  const [court1, court2] = [courts[0]!, courts[1]!];
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: { matchMinutes: 30, courts: [court1.id, court2.id] },
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
    await sql`update fixtures set court_id = ${court1.id}, scheduled_at = ${within(-10)} where id = ${anaBen}`;
    await sql`update fixtures set court_id = ${court1.id}, scheduled_at = ${within(2)} where id = ${anaCal}`;
    await sql`update fixtures set court_id = ${court2.id}, scheduled_at = ${within(5)} where id = ${calDee}`;
  });
  // In play for real: a core.start through the engine, never a status patch.
  const start = await apiJson(request, `/api/v1/fixtures/${anaBen}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(start.status, `core.start: ${JSON.stringify(start.error)}`).toBeLessThan(300);

  return { competitionId, court1: court1.name, court2: court2.name, calDee, anaCal, names };
}

const row = (page: Page, courtName: string) => page.getByTestId("md-court-row").filter({ hasText: courtName });

/** Court 2 is focused and free: call its top candidate through the sheet, see "Called", undo it, see the candidate back. */
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

  await candidates.first().getByRole("button", { name: `Call to ${seed.court2}` }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText(`Call to ${seed.court2}?`);
  // The knock-on preview loads before anything can be confirmed.
  const confirm = sheet.getByTestId("md-call-confirm");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(sheet).toHaveCount(0);

  await expect(focus).toHaveAttribute("data-state", "called");
  await expect(focus).toContainText("Called: waiting for players");
  // Which side is home is the generator's choice: both names, not an order.
  await expect(focus).toContainText(seed.names.cal);
  await expect(focus).toContainText(seed.names.dee);
  // The fixture really moved: a live call row, read where the server reads it.
  const called = await withDb(
    (sql) => sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id = ${seed.calDee}`,
  );
  expect(called[0]!.n).toBe(1);

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
    await expectNoHorizontalScroll(page);

    await row(page, seed.court2).click();
    await callAndUndo(page, seed);
    await expectNoHorizontalScroll(page);

    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByTestId("md-list")).toBeVisible();
    await expect(page.getByTestId("md-focus")).toBeVisible();
    await expectNoHorizontalScroll(page);
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
});
