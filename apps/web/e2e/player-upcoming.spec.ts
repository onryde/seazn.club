// Player profile — upcoming matches across the org, as a spectator sees it
// (spec docs/superpowers/specs/2026-09-23-player-profile-upcoming-matches-design.md,
//  plan …/plans/2026-09-23-player-profile-upcoming-matches.md Task 4, with the
//  owner decisions of 2026-09-23 that superseded parts of it: the "Show N more"
//  reveal is a client toggle in ONE list, and a row from another competition is
//  marked by an accented where-line, not an "Other event" chip).
//
// One Pro org (player pages are Pro-gated), one player, three competitions:
//   CUR (public)   — the card; 7 of Ada's fixtures: 1 PLAYED (Matches), 5 dated
//                    (the first on a real court at a real venue), 1 left
//                    undated (Time TBD, behind the toggle)
//   SIB (public)   — 1 fixture, dated between CUR's first and second: the list
//                    is one sort, and this row's where-line is accented. Its
//                    competition and division names are deliberately long.
//   UNL (unlisted) — 1 fixture, dated EARLIEST: if R2 leaked it would lead.
// Every plan is set before the first public read (entitlements may be served
// stale for five minutes). Serial with the seed as test 1 (AGENTS.md #21: a
// red count is a floor). Expected copy is read from the dictionaries, never
// typed here.
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, seedVenueWithCourts } from "./helpers";
import { closeOpenContexts } from "./spectator-public-helpers";
import {
  API_CALL_MS,
  dictString,
  division,
  entrants,
  eventStream,
  expectDistinctShots,
  FLOOR_MS,
  leagueFixtures,
  mintSpectatorOrg,
  PAINT_SETTLE_MS,
  person,
  publicCompetition,
  publishCompetition,
  scheduleFixture,
  spectator,
  STEP_MS,
  type FixtureRow,
  type MintedOrg,
} from "./spectator-w2-kit";

test.describe.configure({ mode: "serial" });
test.afterEach(closeOpenContexts);

const GENERIC = { sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } };
const WIDTHS = [320, 768, 1280] as const;
/** The component's own cut (`UPCOMING_VISIBLE` in player-upcoming.tsx). */
const VISIBLE = 5;
/** A realistically long name — the length that exposed a missing min-w-0 before (AGENTS.md, phone composition). */
const LONG = "Bartholomew Fitzgerald-Montgomery";
const COURT = "Court 3";
const VENUE = "Riverside Hall";
/** The where-line's accent class, as a whole class token (not `hover:…`). */
const ACCENT = /(^|\s)text-accent-strong(\s|$)/;

/**
 * The setup's API round trips, counted from the code below so its clock is
 * derived rather than typed (AGENTS.md #20): the org (create, locale-less plan
 * SQL, two overrides, activate ≈ 4), 11 persons, 3 competitions, 3 divisions
 * (create + read each), 3 entrant batches, 3 league stand-ups (stage,
 * generate, start, list each), 1 fixture listing, 3 event-stream calls (state
 * + 2 events), 7 schedules, 1 venue + 1 court, 1 court PATCH, 2 publishes.
 */
const SETUP_API_CALLS = 4 + 11 + 3 + 3 * 2 + 3 + 3 * 4 + 1 + 3 + 7 + 2 + 1 + 2;

let org: MintedOrg;
let cur = { id: "", slug: "" };
let sib = { id: "", slug: "" };
let unl = { id: "", slug: "" };
let sibDiv = { id: "", slug: "" };
let tag = "";
let ada = "";
let played = "";
let courted = "";
let sibFixture = "";
let unlFixture = "";
let undated = "";
/** CUR's card, soonest first: CUR day 1, SIB day 2, CUR days 3–6, then the undated one. */
let expected: string[] = [];

const curName = () => `Current Cup ${tag}`;
const sibCompName = () => `${LONG} Invitational ${tag}`;
const sibDivName = `${LONG} Premier Division`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const card = (compSlug: string) => `/shared/${org.slug}/${compSlug}/players/${ada}`;
const adaRows = (rows: FixtureRow[], entrantId: string) =>
  rows.filter((f) => f.home_entrant_id === entrantId || f.away_entrant_id === entrantId);
const rowsIn = (page: Page) => page.getByTestId("mh-player-upcoming").locator('[data-testid^="mh-player-upcoming-row-"]');
const rowIds = (page: Page) =>
  rowsIn(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace("mh-player-upcoming-row-", "")));
const row = (page: Page, fixtureId: string) => page.getByTestId(`mh-player-upcoming-row-${fixtureId}`);
const where = (page: Page, fixtureId: string) => row(page, fixtureId).getByTestId("mh-player-upcoming-where");

/**
 * Put the toggle in `want` state. The page is server-rendered, so a click that
 * lands before hydration does nothing: retry until the island answers. The
 * current state is read FIRST on every attempt, so a click React replays late
 * is never undone by the next one.
 */
async function setOpen(page: Page, want: boolean): Promise<Locator> {
  const button = page.getByTestId("mh-player-upcoming-more");
  const target = want ? "true" : "false";
  await expect(async () => {
    if ((await button.getAttribute("aria-expanded")) !== target) await button.click();
    await expect(button).toHaveAttribute("aria-expanded", target, { timeout: 2_000 });
  }).toPass({ timeout: STEP_MS });
  return button;
}

test("setup: one player, three competitions, seven upcoming fixtures and one played", async ({ request }) => {
  test.setTimeout(Math.max(FLOOR_MS, SETUP_API_CALLS * API_CALL_MS));
  tag = randomUUID().slice(0, 6);
  org = await mintSpectatorOrg(request, { name: `Upcoming ${tag}`, plan: "pro" });
  const adaName = `Ada ${tag}`;
  ada = await person(request, adaName, true);

  cur = await publicCompetition(request, { name: curName(), orgId: org.id });
  sib = await publicCompetition(request, { name: sibCompName(), orgId: org.id });
  const created = await apiJson<{ id: string; slug: string; org_id: string; visibility: string }>(
    request,
    "/api/v1/competitions",
    "POST",
    { name: `Unlisted Open ${tag}`, visibility: "unlisted", ends_on: "2030-12-31" },
  );
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  expect(created.data!.org_id, "the unlisted competition landed in the wrong org").toBe(org.id);
  expect(created.data!.visibility, "the unlisted competition degraded").toBe("unlisted");
  unl = { id: created.data!.id, slug: created.data!.slug };

  // ---- CUR: Ada v seven opponents, the first with a long name ------------------
  const curDiv = await division(request, cur.id, { name: "Singles", ...GENERIC });
  const opponents: string[] = [];
  for (let i = 0; i < 7; i++) opponents.push(await person(request, `Opp${i} ${tag}`, true));
  const curEntrants = await entrants(request, curDiv.id, [
    { kind: "individual", name: adaName, members: [ada] },
    ...opponents.map((id, i) => ({ kind: "individual" as const, name: i === 0 ? `${LONG} ${tag}` : `Opp${i} ${tag}`, members: [id] })),
  ]);
  const generated = adaRows(await leagueFixtures(request, curDiv.id), curEntrants[0]!);
  // Published AFTER the start (which would promote it to `live`): another
  // competition's rows reach this card only when it is LISTED — public and
  // past draft (owner decision 2026-09-27) — so both public ones publish.
  await publishCompetition(request, cur.id);
  expect(generated, "Ada meets seven opponents once each").toHaveLength(7);
  // The long-named opponent's fixture becomes the FIRST dated row — the one on
  // a court at a venue too — so the longest line on the card is on screen
  // collapsed, at every width.
  const isLong = (f: FixtureRow) => f.home_entrant_id === curEntrants[1] || f.away_entrant_id === curEntrants[1];
  const others = generated.filter((f) => !isLong(f));
  const mine = [others[0]!, generated.find(isLong)!, ...others.slice(1)];
  played = mine[0]!.id;
  const stream = await eventStream(request, played);
  await stream.post("core.start", {});
  await stream.post("generic.result", { p1Score: 2, p2Score: 1 });
  const dated = mine.slice(1, 6).map((f) => f.id);
  undated = mine[6]!.id;
  const days = [1, 3, 4, 5, 6];
  for (const [i, id] of dated.entries()) await scheduleFixture(request, id, `2030-07-0${days[i]}T10:00:00Z`);

  // The first dated row goes on a real court, the organiser's way (P9): a
  // venue and court through the API, then the fixture PATCHed by court id —
  // which also stamps the court's venue.
  courted = dated[0]!;
  const { courts } = await seedVenueWithCourts(request, [COURT], { orgId: org.id, venueName: VENUE });
  const placed = await apiJson(request, `/api/v1/fixtures/${courted}`, "PATCH", { court_id: courts[0]!.id });
  expect(placed.status, `court PATCH: ${JSON.stringify(placed.error)}`).toBeLessThan(300);

  // Premises: the one left alone really is undated, and the placed one carries its court.
  const listed = await apiJson<{ id: string; scheduled_at: string | null; court_id: string | null }[]>(
    request,
    `/api/v1/divisions/${curDiv.id}/fixtures`,
  );
  expect(listed.data?.find((f) => f.id === undated)?.scheduled_at ?? null, "the undated fixture has a time").toBeNull();
  expect(listed.data?.find((f) => f.id === courted)?.court_id, "the court PATCH did not land").toBe(courts[0]!.id);

  // ---- SIB: one fixture on day 2 -------------------------------------------------
  sibDiv = await division(request, sib.id, { name: sibDivName, ...GENERIC });
  const sibOpp = await person(request, `Sib Opp ${tag}`, true);
  const sibEntrants = await entrants(request, sibDiv.id, [
    { kind: "individual", name: adaName, members: [ada] },
    { kind: "individual", name: `Sib Opp ${tag}`, members: [sibOpp] },
  ]);
  sibFixture = adaRows(await leagueFixtures(request, sibDiv.id), sibEntrants[0]!)[0]!.id;
  await publishCompetition(request, sib.id);
  await scheduleFixture(request, sibFixture, "2030-07-02T10:00:00Z");

  // ---- UNL: one fixture, the EARLIEST of all --------------------------------------
  const unlDiv = await division(request, unl.id, { name: "Open", ...GENERIC });
  const unlOpp = await person(request, `Unl Opp ${tag}`, true);
  const unlEntrants = await entrants(request, unlDiv.id, [
    { kind: "individual", name: adaName, members: [ada] },
    { kind: "individual", name: `Unl Opp ${tag}`, members: [unlOpp] },
  ]);
  unlFixture = adaRows(await leagueFixtures(request, unlDiv.id), unlEntrants[0]!)[0]!.id;
  await scheduleFixture(request, unlFixture, "2030-06-30T10:00:00Z");

  expected = [dated[0]!, sibFixture, ...dated.slice(1), undated];
});

test("collapsed: the next five across the org in time order, the unlisted and the played ones absent", async ({ browser }) => {
  const page = await spectator(browser, { width: 1280, height: 900 });
  const res = await page.goto(card(cur.slug), { waitUntil: "load" });
  expect(res?.status()).toBe(200);
  const section = page.getByTestId("mh-player-upcoming");
  await expect(section.getByRole("heading", { name: dictString("en", "player.upcoming") })).toBeVisible();
  // As served: exactly the first five, in ONE list; rows six and seven are not
  // in the document at all until asked for.
  expect(await rowIds(page)).toEqual(expected.slice(0, VISIBLE));
  await expect(section.locator("ul")).toHaveCount(1);
  await expect(row(page, expected[VISIBLE]!)).toHaveCount(0);
  await expect(row(page, undated)).toHaveCount(0);
  const button = section.getByTestId("mh-player-upcoming-more");
  await expect(button).toHaveText(dictString("en", "player.upcoming.showMore", { count: expected.length - VISIBLE }));
  await expect(button).toHaveAttribute("aria-expanded", "false");
  // R2: the unlisted competition's fixture never reaches this card (positive pair: next test).
  await expect(page.locator(`[data-testid="mh-player-upcoming-row-${unlFixture}"]`)).toHaveCount(0);
  // Regression: the played fixture is Matches', not Upcoming's.
  await expect(section.locator(`[data-testid="mh-player-upcoming-row-${played}"]`)).toHaveCount(0);
  await expect(page.getByTestId("mh-player-matches").getByTestId(`mh-player-match-${played}`)).toBeVisible();
});

test("the other competition's row is the accented one; its link opens under the SIBLING's slug", async ({ browser }) => {
  const page = await spectator(browser, { width: 1280, height: 900 });
  await page.goto(card(cur.slug), { waitUntil: "load" });
  // The accent: on the sibling's where-line, and on no row of this competition.
  await expect(where(page, sibFixture)).toHaveClass(ACCENT);
  await expect(where(page, sibFixture)).toHaveText(new RegExp(`${esc(sibCompName())}\\s*›\\s*${esc(sibDivName)}`));
  for (const id of expected.slice(0, VISIBLE).filter((f) => f !== sibFixture)) {
    await expect(where(page, id), `row ${id} is this competition's, yet accented`).not.toHaveClass(ACCENT);
  }
  // The class is not decoration: the two lines really paint differently.
  const colour = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);
  expect(await colour(where(page, sibFixture))).not.toBe(await colour(where(page, expected[0]!)));

  // A screen reader hears competition and division as two words, not one run-on
  // (the "›" is aria-hidden, so the spaces around it carry the separation).
  await expect(row(page, expected[0]!)).toHaveAccessibleName(new RegExp(`${esc(curName())}\\W+Singles`));
  await expect(row(page, sibFixture)).toHaveAccessibleName(new RegExp(`Invitational ${esc(tag)}\\W+${esc(LONG)} Premier`));

  const href = `/shared/${org.slug}/${sib.slug}/${sibDiv.slug}/fixtures/${sibFixture}`;
  await expect(row(page, sibFixture)).toHaveAttribute("href", href);
  await Promise.all([page.waitForURL(`**${href}`), row(page, sibFixture).click()]);
  expect((await page.request.get(href)).status()).toBe(200);
});

test("R2 positive pair: the unlisted competition's OWN card lists its fixture first, unaccented, and accents the others", async ({ browser }) => {
  const page = await spectator(browser, { width: 1280, height: 900 });
  expect((await page.goto(card(unl.slug), { waitUntil: "load" }))?.status()).toBe(200);
  const ids = await rowIds(page);
  expect(ids[0]).toBe(unlFixture);
  await expect(where(page, unlFixture)).not.toHaveClass(ACCENT);
  await expect(where(page, sibFixture)).toHaveClass(ACCENT);
  await expect(where(page, expected[0]!)).toHaveClass(ACCENT);
});

test("court and venue: the placed row names both, the undated row neither", async ({ browser }) => {
  const page = await spectator(browser, { width: 390, height: 844 });
  await page.goto(card(cur.slug), { waitUntil: "load" });
  await expect(row(page, courted).getByTestId("mh-player-upcoming-court")).toHaveText(COURT);
  await expect(row(page, courted).getByTestId("mh-player-upcoming-venue")).toHaveText(VENUE);
  await expect(row(page, courted).getByTestId("mh-player-upcoming-time")).toHaveCount(1);
  // Only the placed row carries them: the sibling's and the rest are unplaced.
  await expect(page.getByTestId("mh-player-upcoming").getByTestId("mh-player-upcoming-court")).toHaveCount(1);
  await expect(page.getByTestId("mh-player-upcoming").getByTestId("mh-player-upcoming-venue")).toHaveCount(1);

  await setOpen(page, true);
  const tbd = row(page, undated);
  await expect(tbd.getByTestId("mh-player-upcoming-tbc")).toHaveText(dictString("en", "player.upcoming.timeTbd"));
  await expect(tbd.getByTestId("mh-player-upcoming-time")).toHaveCount(0);
  await expect(tbd.getByTestId("mh-player-upcoming-court")).toHaveCount(0);
  await expect(tbd.getByTestId("mh-player-upcoming-venue")).toHaveCount(0);
});

test("the toggle: rows six and seven join the SAME list under row five, the button below them reads Show less and keeps focus, and a second click collapses", async ({ browser }) => {
  const page = await spectator(browser, { width: 390, height: 844 });
  await page.goto(card(cur.slug), { waitUntil: "load" });
  const section = page.getByTestId("mh-player-upcoming");

  const button = await setOpen(page, true);
  expect(await rowIds(page)).toEqual(expected);
  await expect(section.locator("ul")).toHaveCount(1);
  // Rows six and seven are children of the list rows one to five sit in.
  const listOf = (l: Locator) => l.evaluate((el) => el.closest("ul")?.id ?? null);
  const listId = await listOf(row(page, expected[0]!));
  expect(listId).not.toBeNull();
  expect(await listOf(row(page, undated))).toBe(listId);
  await expect(button).toHaveText(dictString("en", "player.upcoming.showLess"));
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(button).toBeFocused();
  // The button sits BELOW the last row, not above the revealed ones.
  const last = await row(page, undated).boundingBox();
  const at = await button.boundingBox();
  expect(last && at, "the last row or the button has no box").toBeTruthy();
  expect(at!.y).toBeGreaterThanOrEqual(last!.y + last!.height);

  await setOpen(page, false);
  expect(await rowIds(page)).toEqual(expected.slice(0, VISIBLE));
  await expect(row(page, undated)).toHaveCount(0);
  await expect(button).toHaveText(dictString("en", "player.upcoming.showMore", { count: expected.length - VISIBLE }));
  await expect(button).toBeFocused();
});

test("1280 layout (D4): Upcoming and Matches share one left column, left of the right-hand sections", async ({ browser }) => {
  const page = await spectator(browser, { width: 1280, height: 900 });
  await page.goto(card(cur.slug), { waitUntil: "load" });
  const box = async (testid: string) => {
    const b = await page.getByTestId(testid).boundingBox();
    expect(b, `${testid} has no box`).not.toBeNull();
    return b!;
  };
  const upcoming = await box("mh-player-upcoming");
  const matches = await box("mh-player-matches");
  expect(Math.abs(upcoming.x - matches.x), "Upcoming and Matches start at different x").toBeLessThanOrEqual(0.5);
  expect(Math.abs(upcoming.width - matches.width), "Upcoming and Matches differ in width").toBeLessThanOrEqual(0.5);
  expect(upcoming.y + upcoming.height, "Upcoming is not above Matches").toBeLessThanOrEqual(matches.y);
  // The right column: the squad section always renders; stats when there are any.
  const right = ["player-squad", ...((await page.getByTestId("player-stats").count()) > 0 ? ["player-stats"] : [])];
  for (const testid of right) {
    const r = await box(testid);
    expect(upcoming.x + upcoming.width, `Upcoming overlaps ${testid}`).toBeLessThanOrEqual(r.x);
    expect(matches.x + matches.width, `Matches overlaps ${testid}`).toBeLessThanOrEqual(r.x);
  }
});

test("320 / 768 / 1280: collapsed and open, no horizontal scroll, and the cropped pictures differ", async ({ browser }) => {
  const states = ["upcoming-collapsed", "upcoming-open"] as const;
  test.setTimeout(Math.max(FLOOR_MS, WIDTHS.length * states.length * STEP_MS));
  const dir = test.info().outputPath("upcoming-shots");
  mkdirSync(dir, { recursive: true });
  for (const width of WIDTHS) {
    const page = await spectator(browser, { width, height: 900 });
    await page.goto(card(cur.slug), { waitUntil: "load" });
    const section = page.getByTestId("mh-player-upcoming");
    await expect(page.getByTestId("mh-player-upcoming-more")).toHaveAttribute("aria-expanded", "false");
    await expect(rowsIn(page)).toHaveCount(VISIBLE);
    await expectNoHorizontalScroll(page);
    await page.waitForTimeout(PAINT_SETTLE_MS);
    await section.screenshot({ path: `${dir}/${states[0]}-${width}.png` });

    await setOpen(page, true);
    await expect(rowsIn(page)).toHaveCount(expected.length);
    await expectNoHorizontalScroll(page);
    // The click leaves the pointer over row six once the list grows under it:
    // park it, so the picture shows rows as served, not a hover tint.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(PAINT_SETTLE_MS);
    await section.screenshot({ path: `${dir}/${states[1]}-${width}.png` });
  }
  expectDistinctShots(dir, states, WIDTHS);
});
