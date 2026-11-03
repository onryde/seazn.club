import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Locator, type Page, type Request, type Route } from "@playwright/test";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  competitionPath,
  createStageAndGenerate,
  expectNoHorizontalScroll,
  invalidateOrgEntitlements,
  scoreFixture,
  seedVenueWithCourts,
  setOrgPlanBySql,
  withDb,
} from "../helpers";
import { dismissConsent, freshOrg } from "../directory-kit";
import { uiEn, fill } from "../match-room-kit";
import { middayZoneFor, withinToday } from "../midday-zone";
import { boardRoundCodes, type RoundCodeFixture } from "../../src/components/v2/board/round-codes";

/**
 * Match Day, WALKED by an organiser (Task W, owner rule 2026-11-01: every event under test is TAPPED; the API only reaches a
 * state; the walk runs to the terminal state and reads back what a person sees). One organiser on an organisation of their own,
 * at the walkthrough project's 1280, through one day at a six-court venue pair:
 *
 *   1. The competition page's Open Match Day button opens the page.
 *   2. The court list: playing first, then the courts with something waiting, the closed court last, the two free-and-empty courts
 *      folded into one row that opens in place; the header's counts; the board's round chip on every row.
 *   3. The venue filter: Hall A off, one venue listed, the address carries it, a reload keeps it; "Show all venues" is everything.
 *   4. Remote scoring on the playing court: Hide, the one-row state, Show (create), Hide again, Show QR - one link, never two.
 *   5. A court closed for the rest of today: Call stays ON (hit-tested - the ground truth is the tap, not the attribute), the sheet
 *      asks "Call anyway", Cancel calls nothing.
 *   6. A free court: its seven candidates ranked, every one wearing the board's round code; Call to Court -> the sheet previews the
 *      knock-on and warns (the break coming, the rest too short) -> Called -> Undo puts the match back.
 *   7. PLAYER_BUSY: another desk calls a player onto a court while this tab's polls are stalled; the Call this stale tab then
 *      presses is REFUSED in the organiser's words, and the next poll greys every match of the two players.
 *   8. Both semi-finals finish; the breadcrumb goes back to the competition and the door opens Match Day again; the Final is a
 *      candidate (F), its finalists have just played so the sheet warns about their rest, and Call lands it: Called.
 *
 * Every expectation is read from the dictionaries, the database, the board's own `boardRoundCodes` (the round chips) or the
 * declarations in lib/match-day/view.ts (the group order, the fold minimum), never typed from the page. The seed plans in the
 * zone where the clock reads midday (e2e/midday-zone.ts), and the ORGANISATION's zone is set to the same one, so the courts' hours
 * (the break, the closed day) sit in the same day as the matches whatever the real hour is.
 *
 * One sport (generic), on purpose: this walks layout and flow, which is sport-agnostic (owner rule: skip rare cases).
 */

// ── budget (class 20): a derived ceiling, never one flat number ──────────────────────────────────────────────────────────────────
const SEED_MS = 90_000; // login + org + plan + ~25 API calls + SQL
const NAV_MS = 20_000; // a page load or a client navigation
const ACT_MS = 4_000; // one tap and the assertion that follows it
const POLL_MS = 30_000; // one live poll of the shell (20 s) plus slack
const budget = (navs: number, acts: number, polls: number): number => SEED_MS + navs * NAV_MS + acts * ACT_MS + polls * POLL_MS;
const NAVS = 8;
const ACTS = 70;
const POLLS = 1;

const MIN_REST = 45;

/** A brand-new user is shown onboarding and the product tour over the org home (a dialog that intercepts every tap). */
async function skipTour(page: Page): Promise<void> {
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
  const res = await page.request.post("/api/tour", { data: {} });
  expect(res.status(), "the tour is marked seen").toBeLessThan(300);
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A dictionary template as a regex, `wild` placeholders matching a number (a minute count that depends on the clock). */
function templateRegex(key: string, vars: Record<string, string | number>, wild: string[] = []): RegExp {
  const raw = uiEn[key];
  if (raw === undefined) throw new Error(`no en copy for ${key}`);
  const src = raw
    .split(/(\{\w+\})/)
    .map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (m === null) return esc(part);
      if (wild.includes(m[1]!)) return "(\\d+)";
      const v = vars[m[1]!];
      if (v === undefined) throw new Error(`${key}: no value for {${m[1]}}`);
      return esc(String(v));
    })
    .join("");
  return new RegExp(`^${src}$`);
}

/** The group order and the fold minimum, READ from the declaration the page sorts by (lib/match-day/view.ts), not retyped. */
const VIEW_SRC = readFileSync(fileURLToPath(new URL("../../src/lib/match-day/view.ts", import.meta.url)), "utf8");
const COURT_GROUPS = ((): string[] => {
  const m = /export const COURT_GROUPS = \[([^\]]+)\] as const/.exec(VIEW_SRC);
  if (m === null) throw new Error("lib/match-day/view.ts no longer declares COURT_GROUPS as a const tuple");
  return m[1]!.split(",").map((s) => s.trim().replace(/"/g, "")).filter((s) => s !== "");
})();
const MIN_FOLDED = ((): number => {
  const m = /export const MIN_FOLDED = (\d+)/.exec(VIEW_SRC);
  if (m === null) throw new Error("lib/match-day/view.ts no longer declares MIN_FOLDED");
  return Number(m[1]);
})();

const zonedParts = (instant: Date, tz: string): { weekday: number; date: string; minute: number } => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(instant)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return { weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!), date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
};

/** The page's own reads of the day: the poll of the whole view and the candidates' list (both GETs under the competition's match-day API). */
const matchDayGets = (url: URL): boolean => /\/api\/v1\/competitions\/[^/]+\/match-day(\/|$)/.test(url.pathname);

const row = (page: Page, courtName: string): Locator => page.getByTestId("md-court-row").filter({ hasText: courtName });
/** Opens the free-courts fold if the page shows one closed (a reload or a fresh visit folds it again). */
async function openFold(page: Page): Promise<void> {
  const toggle = page.getByTestId("md-court-fold-toggle");
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}
const courtIdsInList = (page: Page): Promise<string[]> =>
  page.getByTestId("md-court-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-court-id") ?? ""));

/** The points down a control that `hitTest` taps at. */
const HIT_FRACTIONS = [0.15, 0.5, 0.85];
/** Whether a tap at three points down the control lands ON it (not on whatever overlays it); returns how many points it tried. */
async function hitTest(control: Locator, what: string): Promise<number> {
  await control.scrollIntoViewIfNeeded();
  let tried = 0;
  for (const fraction of HIT_FRACTIONS) {
    const lands = await control.evaluate((el, f) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * f);
      return at !== null && (at === el || el.contains(at));
    }, fraction);
    expect(lands, `a tap ${Math.round(fraction * 100)}% down ${what} lands on it`).toBe(true);
    tried++;
  }
  return tried;
}

interface FxRow extends RoundCodeFixture {
  division_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

test.describe("Match Day - the organiser's day, walked", () => {
  test("open it from the competition, read the courts, hide and show the scorer link, meet a closed court, call and undo, be refused for a busy player, call the Final, and go back", async ({
    page,
  }) => {
    test.setTimeout(budget(NAVS, ACTS, POLLS));
    // Every read of the day this page makes, from the first request on: step 7 stalls them and must first know none is still on its way.
    const inFlight = new Set<Request>();
    page.on("request", (r) => {
      if (r.method() === "GET" && matchDayGets(new URL(r.url()))) inFlight.add(r);
    });
    page.on("requestfinished", (r) => inFlight.delete(r));
    page.on("requestfailed", (r) => inFlight.delete(r));

    // ── SEED: an organisation of their own, in the zone where the clock reads midday ───────────────────────────────────────────
    const { orgId } = await freshOrg(page, "mdwalk");
    await dismissConsent(page);
    await skipTour(page);
    await setOrgPlanBySql({ orgId }, "pro");
    await invalidateOrgEntitlements(page.request, orgId);
    const request = page.request;
    const now0 = Date.now();
    const zone = middayZoneFor(now0);
    const within = withinToday(now0, zone);
    await withDb((sql) => sql`update organizations set timezone = ${zone} where id = ${orgId}`);

    const nonce = Math.random().toString(36).slice(2, 7);
    const hallA = await seedVenueWithCourts(request, [`A1 ${nonce}`, `A2 ${nonce}`, `A3 ${nonce}`, `A4 ${nonce}`], { orgId, venueName: `Hall A ${nonce} ${TAG}` });
    const hallB = await seedVenueWithCourts(request, [`B1 ${nonce}`, `B2 ${nonce}`], { orgId, venueName: `Hall B ${nonce} ${TAG}` });
    const [a1, a2, a3, a4] = hallA.courts as [{ id: string; name: string }, { id: string; name: string }, { id: string; name: string }, { id: string; name: string }];
    const [b1, b2] = hallB.courts as [{ id: string; name: string }, { id: string; name: string }];
    const allCourts = [a1, a2, a3, a4, b1, b2];

    const comp = await apiJson<{ id: string; name: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Day ${nonce} ${TAG}`, visibility: "private" });
    expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBe(201);
    const competitionId = comp.data!.id;
    const competitionName = comp.data!.name;

    const division = async (name: string, entrants: string[], stage?: { kind: string; name: string }) => {
      const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", { name, sport_key: "generic", variant_key: "score" });
      expect(div.status, `division ${name}: ${JSON.stringify(div.error)}`).toBe(201);
      const ents = await addEntrantsViaApi(request, div.data!.id, entrants);
      expect(ents.ids, `entrants of ${name}`).toHaveLength(entrants.length);
      await createStageAndGenerate(request, div.data!.id, stage);
      const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
      expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
      const settings = await apiJson(request, `/api/v1/divisions/${div.data!.id}/schedule-settings`, "PUT", {
        tz: zone,
        config: { matchMinutes: 30, perEntrantMinRest: MIN_REST, courts: allCourts.map((c) => c.id) },
      });
      expect(settings.status, `schedule settings: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
      return { id: div.data!.id, ents: ents.ids };
    };
    const names = { ana: `Ana ${nonce}`, ben: `Ben ${nonce}`, cal: `Cal ${nonce}`, dee: `Dee ${nonce}` };
    const league = await division("League", [names.ana, names.ben, names.cal, names.dee]);
    const cup = await division("Cup", [`Wil ${nonce}`, `Xan ${nonce}`, `Yun ${nonce}`, `Zed ${nonce}`], { kind: "knockout", name: "Cup" });
    const [ana, ben, cal, dee] = league.ents as [string, string, string, string];
    // People, not just names: Match Day's rest warning and its busy judge are PERSON-level (an entrant with no roster is judged by its
    // own id and has no person to give rest to), so each of the eight individual entrants gets the person a registration would have made.
    const linked = await withDb(async (sql) => {
      const ents = await sql<{ id: string; display_name: string }[]>`select id, display_name from entrants where division_id in ${sql([league.id, cup.id])}`;
      for (const e of ents) {
        const [p] = await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${orgId}, ${e.display_name}) returning id`;
        await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${e.id}, ${p!.id}, ${orgId})`;
      }
      return ents.length;
    });
    expect(linked, "anti-vacuity: all eight entrants got a person").toBe(8);

    const fxRows = await withDb(
      (sql) => sql<FxRow[]>`
        select id, division_id, stage_id, round_no, seq_in_round, ext_key, lane, is_final, third_place, conditional, home_entrant_id, away_entrant_id
          from fixtures where division_id in ${sql([league.id, cup.id])} order by round_no, seq_in_round`,
    );
    const stageRows = await withDb((sql) => sql<{ id: string; kind: string }[]>`select id, kind from stages where division_id in ${sql([league.id, cup.id])}`);
    const pair = (x: string, y: string): string => {
      const f = fxRows.find((r) => r.division_id === league.id && ((r.home_entrant_id === x && r.away_entrant_id === y) || (r.home_entrant_id === y && r.away_entrant_id === x)));
      if (!f) throw new Error(`no league fixture between ${x} and ${y}`);
      return f.id;
    };
    const cupRows = fxRows.filter((r) => r.division_id === cup.id);
    const semis = cupRows.filter((r) => r.round_no === 1);
    const finals = cupRows.filter((r) => r.round_no === 2);
    expect(semis, "premise: a four-entrant knockout opens with two semi-finals").toHaveLength(2);
    expect(finals, "premise: ... and ends in one final").toHaveLength(1);
    const fx = {
      anaBen: pair(ana, ben), anaCal: pair(ana, cal), anaDee: pair(ana, dee), benCal: pair(ben, cal), benDee: pair(ben, dee), calDee: pair(cal, dee),
      sf1: semis[0]!.id, sf2: semis[1]!.id, final: finals[0]!.id,
    };

    // The board's own round codes for every fixture: the expected chip is `boardRoundCodes`' answer, or R{round_no} where it names none.
    const codes = boardRoundCodes(fxRows, stageRows, (key, vars) => fill(key, vars ?? {}));
    const chipOf = (id: string): string => codes.get(id)?.code ?? `R${fxRows.find((r) => r.id === id)!.round_no}`;
    const codedOf = (id: string): boolean => codes.has(id);
    expect(new Set([fx.anaBen, fx.sf1, fx.final].map(chipOf)).size, "premise: the seed shows a league round, a semi-final and a final - three different chips").toBe(3);
    expect(codedOf(fx.anaBen), "a league keeps its plain R{n}").toBe(false);
    expect(codedOf(fx.sf1) && codedOf(fx.final), "the bracket's rounds are coded").toBe(true);

    // Placing is seed, not the behaviour under test. A1: the Cup's first semi-final IN PLAY (a real core.start), Ana v Cal queued behind
    // it; A2: Ana v Ben; B1: Ben v Cal; Ben v Dee planned with no court; Cal v Dee, Ana v Dee and the second semi-final unscheduled.
    await withDb(async (sql) => {
      await sql`update fixtures set court_id = ${a1.id}, scheduled_at = ${within(-20)} where id = ${fx.sf1}`;
      await sql`update fixtures set court_id = ${a1.id}, scheduled_at = ${within(45)} where id = ${fx.anaCal}`;
      await sql`update fixtures set court_id = ${a2.id}, scheduled_at = ${within(5)} where id = ${fx.anaBen}`;
      await sql`update fixtures set court_id = ${b1.id}, scheduled_at = ${within(60)} where id = ${fx.benCal}`;
      await sql`update fixtures set court_id = null, scheduled_at = ${within(120)} where id = ${fx.benDee}`;
    });
    const start = await apiJson(request, `/api/v1/fixtures/${fx.sf1}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    expect(start.status, `core.start: ${JSON.stringify(start.error)}`).toBeLessThan(300);

    // The organisation's zone is the midday zone, so the view's clock reads 12:xx and the break below always has room to come.
    const view = await apiJson<{ tz: string; now: string }>(request, `/api/v1/competitions/${competitionId}/match-day`);
    expect(view.status).toBe(200);
    expect(view.data!.tz, "the page reads the organisation's zone").toBe(zone);
    const z = zonedParts(new Date(view.data!.now), zone);
    // The zone was picked for `now0` (clock 12:00-12:59 then); the view reads the clock a little later, after the seed's calls, so a run that
    // started in the last seconds of a local hour sees 13:00 and a fixed "12" is a coin-toss. What the walk needs is ROOM in the day: the view's
    // clock must be the seed's clock run on by no more than this test's own budget, and the break and the walk must fit before midnight.
    const budgetMin = Math.ceil(budget(NAVS, ACTS, POLLS) / 60_000);
    const ranOn = z.minute - zonedParts(new Date(now0), zone).minute;
    expect(ranOn, "premise: the view's clock is not behind the seed's").toBeGreaterThanOrEqual(0);
    expect(ranOn, "premise: ... and has run on by no more than the test's own budget").toBeLessThanOrEqual(budgetMin);
    const BREAK_IN = 25; // the break starts this many minutes from now ...
    const BREAK_LEN = 30; // ... and lasts this many
    expect(1440 - z.minute, "premise: today has room left for the break and the whole walk").toBeGreaterThan(BREAK_IN + BREAK_LEN + budgetMin);
    // A3: a break 25 to 55 minutes from now (a call now would still be on when it starts); A4: closed all of today.
    const breakFrom = z.minute + BREAK_IN;
    const breakTo = breakFrom + BREAK_LEN;
    await withDb(async (sql) => {
      await sql`insert into court_hours (court_id, org_id, weekday, open_min, close_min) values
        (${a3.id}, ${orgId}, ${z.weekday}, 0, ${breakFrom}), (${a3.id}, ${orgId}, ${z.weekday}, ${breakTo}, 1440)`;
      await sql`insert into court_exceptions (court_id, org_id, date, closed) values (${a4.id}, ${orgId}, ${z.date}, true)`;
    });
    const clock = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

    // ── 1. THE COMPETITION PAGE'S DOOR ─────────────────────────────────────────────────────────────────────────────────────────
    const compPath = await competitionPath(request, competitionId);
    await page.goto(compPath, { waitUntil: "load" });
    const door = page.getByTestId("desk-tool-match-day");
    await expect(door, "on a match day the filled Open Match Day button is the door").toBeVisible();
    await expect(door).toHaveText(uiEn["desk.tools.openMatchDay"]!);
    await expectNoHorizontalScroll(page);
    await door.click();
    await expect(page).toHaveURL(new RegExp(`${esc(compPath)}/match-day`), { timeout: 20_000 });
    await expect(page.getByTestId("md-court-row").first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(uiEn["matchDay.title"]!.split("{date}")[0]!);

    // ── 2. THE LIST: order, fold, counts, chips ────────────────────────────────────────────────────────────────────────────────
    // Each court's group is a seed fact; the order is the declared group order (stable within a group, in court order).
    const groupOf: Record<string, string> = { [a1.id]: "playing", [a2.id]: "up_next", [b1.id]: "up_next", [a3.id]: "free", [b2.id]: "free", [a4.id]: "closed" };
    const seedOrder = allCourts.map((c) => c.id);
    const sorted = [...seedOrder].sort((x, y) => COURT_GROUPS.indexOf(groupOf[x]!) - COURT_GROUPS.indexOf(groupOf[y]!));
    expect(COURT_GROUPS.length, "the declared groups were read").toBeGreaterThanOrEqual(6);
    expect(Object.values(groupOf).every((g) => COURT_GROUPS.includes(g)), "every seeded group is a declared one").toBe(true);
    const foldable = sorted.filter((id) => groupOf[id] === "free");
    expect(foldable.length, "premise: enough free-and-empty courts to fold").toBeGreaterThanOrEqual(MIN_FOLDED);
    const folded = sorted.filter((id) => !foldable.includes(id));
    expect(await courtIdsInList(page), "playing, then what is waiting, then the closed court; the two empty free courts are folded away").toEqual(folded);
    const fold = page.getByTestId("md-court-fold");
    await expect(fold).toBeVisible();
    const toggle = page.getByTestId("md-court-fold-toggle");
    await expect(toggle).toHaveText(fill("matchDay.list.freeFoldCount.court.other", { count: foldable.length }));
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    for (const id of foldable) await expect(page.locator(`[data-testid="md-court-row"][data-court-id="${id}"]`)).toHaveCount(0);
    // The header: 1 playing, and free = every court that is neither playing nor closed (4); the closed court says Closed, not Free.
    const freeCourts = allCourts.length - 1 - 1;
    await expect(page.getByTestId("md-counts")).toContainText(fill("matchDay.header.playing", { count: 1 }));
    await expect(page.getByTestId("md-counts")).toContainText(fill("matchDay.header.free", { count: freeCourts }));
    await expect(row(page, a4.name)).toContainText(uiEn["matchDay.state.closed"]!);
    await expect(row(page, a4.name)).toHaveAttribute("data-closed", "true");
    await expect(row(page, a4.name).getByTestId("md-closure")).toHaveText(uiEn["matchDay.closure.rest"]!);
    await expectNoHorizontalScroll(page);
    // The fold opens in place; the closed court stays last.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await courtIdsInList(page), "opened in place: the declared order, the closed court still last").toEqual(sorted);
    // A3's break still to come: a card on its row, in the break's own words.
    await expect(row(page, a3.name).getByTestId("md-closure")).toHaveText(fill("matchDay.closure.later", { from: clock(breakFrom), until: clock(breakTo) }));
    // The board's round chip on every row that has a match: A1 plays the semi-final, A2 and B1 are queued league matches.
    let chipsChecked = 0;
    for (const [court, id] of [[a1, fx.sf1], [a2, fx.anaBen], [b1, fx.benCal]] as const) {
      const chip = row(page, court.name).getByTestId("md-round-chip").first();
      await expect(chip, `${court.name}'s chip`).toHaveAttribute("data-round-code", chipOf(id));
      await expect(chip).toHaveAttribute("data-round-coded", String(codedOf(id)));
      chipsChecked++;
    }
    expect(chipsChecked, "anti-vacuity: three rows' chips checked").toBe(3);
    await expectNoHorizontalScroll(page);

    // ── 3. THE VENUE FILTER ────────────────────────────────────────────────────────────────────────────────────────────────────
    const trigger = page.getByTestId("md-venue-trigger");
    await expect(page.getByTestId("md-venue-summary")).toHaveText(uiEn["matchDay.venue.triggerAll"]!);
    await trigger.click();
    const venuePanel = page.getByTestId("md-venue-panel");
    await expect(venuePanel).toBeVisible();
    await expect(page.getByTestId("md-venue-all")).toBeChecked();
    await expect(page.getByTestId("md-venue-option")).toHaveCount(2);
    await venuePanel.locator(`[data-testid="md-venue-option"][data-venue-id="${hallA.venueId}"]`).uncheck();
    await expect(page.getByTestId("md-venue-summary")).toHaveText(`Hall B ${nonce} ${TAG}`);
    await page.keyboard.press("Escape");
    await expect(venuePanel).toHaveCount(0);
    await expect(trigger, "Esc hands focus back to the button").toBeFocused();
    const hallBOnly = sorted.filter((id) => id === b1.id || id === b2.id);
    expect(await courtIdsInList(page), "Hall B alone: its queued court, then its one free court (a single free court is not a fold)").toEqual(hallBOnly);
    await expect(page.getByTestId("md-court-fold")).toHaveCount(0);
    await expect(row(page, a1.name)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("venue")).toBe(hallB.venueId);
    await page.reload({ waitUntil: "load" });
    await expect(page.getByTestId("md-venue-summary")).toHaveText(`Hall B ${nonce} ${TAG}`);
    expect(await courtIdsInList(page), "a reload brings the choice back from the address").toEqual(hallBOnly);
    await page.getByTestId("md-venue-trigger").click();
    await page.getByTestId("md-venue-all").check();
    await expect(page.getByTestId("md-venue-summary")).toHaveText(uiEn["matchDay.venue.triggerAll"]!);
    await page.keyboard.press("Escape");
    expect(new URL(page.url()).searchParams.get("venue")).toBe("all");
    expect(await courtIdsInList(page), "Show all venues: everything again, folded").toEqual(folded);
    await expectNoHorizontalScroll(page);

    // ── 4. REMOTE SCORING on the playing court: Hide, Show ─────────────────────────────────────────────────────────────────────
    await row(page, a1.name).click();
    const focus = page.getByTestId("md-focus");
    await expect(focus).toHaveAttribute("data-court-id", a1.id);
    await expect(focus).toHaveAttribute("data-state", "playing");
    const scorer = focus.getByTestId("md-scorer");
    const panel = scorer.locator('[data-role="device-link-panel"]');
    const hide = scorer.getByTestId("device-link-hide");
    const qr = scorer.getByTestId("dlink-qr");
    await expect(scorer.getByRole("heading", { name: uiEn["dlink.title"]! })).toBeVisible();
    await expect(panel, "nobody scores this court, so its panel starts open").toHaveAttribute("data-hide-state", "open");
    await hide.click();
    await expect(panel).toHaveAttribute("data-hide-state", "hidden");
    await expect(scorer.getByTestId("device-link-row-state")).toContainText(uiEn["dlink.noLink"]!);
    await expect(qr, "hidden is one row: no QR in the page").toHaveCount(0);
    await expect(scorer.getByTestId("device-link-more")).toHaveCount(0);
    expect((await panel.boundingBox())!.height, "one row, not a panel").toBeLessThan(140);
    await expectNoHorizontalScroll(page);
    // Show: the row's own button opens the panel and mints the one link.
    await scorer.getByTestId("device-link-row-create").click();
    await expect(panel).toHaveAttribute("data-hide-state", "open");
    await expect(qr).toBeVisible({ timeout: 15_000 });
    await hide.click();
    await expect(panel).toHaveAttribute("data-hide-state", "hidden");
    await expect(scorer.getByTestId("device-link-row-state")).toContainText(uiEn["dlink.linkReady"]!);
    const show = scorer.getByTestId("device-link-row-show");
    await expect(show).toHaveText(uiEn["dlink.showQr"]!);
    await show.click();
    await expect(panel).toHaveAttribute("data-hide-state", "open");
    await expect(qr, "Show QR brings the same link's QR back").toBeVisible({ timeout: 15_000 });
    const links = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from device_links where fixture_id = ${fx.sf1}`);
    expect(links[0]!.n, "hide / show / hide / show never made a second link").toBe(1);
    await expectNoHorizontalScroll(page);

    // The matches that could start on a free court, from the seed: the queue head of each OTHER court (Ana v Cal behind the semi-final on A1,
    // Ana v Ben, Ben v Cal) and everything with no court (Cal v Dee, Ana v Dee, Ben v Dee, the second semi-final). The in-play semi-final is on court.
    const waiting = [fx.anaCal, fx.anaBen, fx.benCal, fx.calDee, fx.anaDee, fx.benDee, fx.sf2];

    // ── 5. A COURT CLOSED FOR THE REST OF TODAY: Call stays ON, and asks ───────────────────────────────────────────────────────
    await row(page, a4.name).click();
    await expect(focus).toHaveAttribute("data-court-id", a4.id);
    await expect(focus).toContainText(fill("matchDay.free.closedTitle", { court: a4.name }));
    await expect(focus).not.toContainText(fill("matchDay.free.title", { court: a4.name }));
    await expect(focus.getByTestId("md-closure")).toHaveAttribute("data-kind", "now");
    await expect(focus.getByTestId("md-call-paused"), "the retired 'Call paused' state is not there").toHaveCount(0);
    const closedCandidates = focus.getByTestId("md-candidate");
    // Every match that could be called here: the same waiting matches a free court is offered.
    await expect(closedCandidates).toHaveCount(waiting.length);
    const closedCalls = focus.getByRole("button", { name: fill("matchDay.candidate.call", { court: a4.name }) });
    await expect(closedCalls).toHaveCount(waiting.length);
    let tapped = 0;
    for (const b of await closedCalls.all()) {
      await expect(b, "a shut court still takes a call").toBeEnabled();
      await expect(b).not.toHaveAttribute("aria-disabled", "true");
      tapped += await hitTest(b, "Call to the closed court");
    }
    expect(tapped, "anti-vacuity: every candidate's Call button, every hit-test point").toBe(waiting.length * HIT_FRACTIONS.length);
    const onClosed = focus.locator(`[data-testid="md-candidate"][data-fixture-id="${fx.anaDee}"]`);
    await onClosed.getByRole("button", { name: fill("matchDay.candidate.call", { court: a4.name }) }).click();
    const closedSheet = page.getByRole("dialog");
    await expect(closedSheet).toContainText(fill("matchDay.sheet.title", { court: a4.name }));
    const closedWarning = closedSheet.locator('[data-testid="md-warning"][data-kind="court_closed"]');
    await expect(closedWarning).toHaveAttribute("role", "alert");
    await expect(closedWarning).toHaveText(fill("matchDay.sheet.warn.courtClosedToday", { court: a4.name }));
    await expect(closedSheet.getByTestId("md-call-confirm")).toHaveText(uiEn["matchDay.sheet.confirmAnyway"]!);
    await expect(closedSheet.getByTestId("md-call-confirm")).toBeEnabled();
    await expect(closedSheet.getByTestId("md-round-chip"), "the sheet's heading wears the match's round").toHaveAttribute("data-round-code", chipOf(fx.anaDee));
    await closedSheet.getByRole("button", { name: uiEn["matchDay.sheet.cancel"]! }).click();
    await expect(closedSheet).toHaveCount(0);
    const none = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id = ${fx.anaDee}`);
    expect(none[0]!.n, "Cancel called nothing").toBe(0);
    await expectNoHorizontalScroll(page);

    // ── 6. A FREE COURT: candidates, the round codes, Call to Court N, the warnings, Undo ──────────────────────────────────────
    await openFold(page);
    await row(page, a3.name).click();
    await expect(focus).toHaveAttribute("data-court-id", a3.id);
    await expect(focus).toHaveAttribute("data-state", "free");
    await expect(focus).toContainText(fill("matchDay.free.title", { court: a3.name }));
    const candidates = focus.getByTestId("md-candidate");
    await expect(candidates).toHaveCount(waiting.length);
    const listed = await candidates.evaluateAll((els) => els.map((e) => e.getAttribute("data-fixture-id") ?? ""));
    expect([...listed].sort(), "exactly the waiting matches").toEqual([...waiting].sort());
    await expect(page.getByTestId("md-free-panel")).toContainText(fill("matchDay.free.count.other", { count: waiting.length }));
    await expect(focus.locator('[data-md-primary="true"]'), "one primary action on the list").toHaveCount(1);
    let candidateChips = 0;
    for (const id of waiting) {
      const li = focus.locator(`[data-testid="md-candidate"][data-fixture-id="${id}"]`);
      await expect(li.getByTestId("md-round-chip"), `the chip of ${id}`).toHaveAttribute("data-round-code", chipOf(id));
      await expect(li.getByTestId("md-round-chip")).toHaveAttribute("data-round-coded", String(codedOf(id)));
      await expect(li).not.toHaveAttribute("data-blocked", /.+/);
      candidateChips++;
    }
    expect(candidateChips, "anti-vacuity: every candidate's chip checked").toBe(waiting.length);
    await expectNoHorizontalScroll(page);

    // Pick Cal v Dee (no time, no court) and Call to Court 3: the sheet previews what changes before anything does.
    const callCalDee = focus.locator(`[data-testid="md-candidate"][data-fixture-id="${fx.calDee}"]`).getByRole("button", { name: fill("matchDay.candidate.call", { court: a3.name }) });
    await callCalDee.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText(fill("matchDay.sheet.title", { court: a3.name }));
    const confirm = sheet.getByTestId("md-call-confirm");
    await expect(confirm).toBeEnabled();
    await expect(confirm, "the court is open now: the button says Call, not Call anyway").toHaveText(fill("matchDay.sheet.confirm", { court: a3.name }));
    await expect(sheet.getByTestId("md-round-chip")).toHaveAttribute("data-round-code", chipOf(fx.calDee));
    // Two warnings, and only these: the break (25 minutes away) would still be on, and Cal's next match is planned within the rest the
    // division asks for. The court is open now, so no court_closed.
    const kinds = await sheet.getByTestId("md-warning").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")).sort());
    expect(kinds, "the preview's warnings").toEqual(["crosses_closure", "rest_gap"]);
    await expect(sheet.locator('[data-testid="md-warning"][data-kind="crosses_closure"]')).toHaveText(
      fill("matchDay.sheet.warn.crossesClosure", { court: a3.name, from: clock(breakFrom), until: clock(breakTo) }),
    );
    const restText = (await sheet.locator('[data-testid="md-warning"][data-kind="rest_gap"]').textContent())!;
    const restRead = templateRegex("matchDay.sheet.warn.restGap", { person: names.cal, min: MIN_REST }, ["minutes"]).exec(restText);
    if (restRead === null) throw new Error(`the rest warning "${restText}" does not read as the dictionary's matchDay.sheet.warn.restGap (${uiEn["matchDay.sheet.warn.restGap"]}) for ${names.cal}`);
    expect(Number(restRead[1]), "Cal's rest, in the dictionary's words, is under what the division asks").toBeLessThan(MIN_REST);
    await expect(sheet.getByTestId("md-shift"), "nothing else on Court 3 moves").toHaveCount(0);
    await expect(sheet).toContainText(fill("matchDay.sheet.noShift", { court: a3.name }));
    await expect(sheet).toContainText(uiEn["matchDay.sheet.notify"]!);
    await confirm.click();
    await expect(sheet).toHaveCount(0);
    await expect(focus).toHaveAttribute("data-state", "called");
    await expect(focus).toContainText(uiEn["matchDay.called.title"]!);
    await expect(focus.getByTestId("md-called-panel").getByTestId("md-round-chip")).toHaveAttribute("data-round-code", chipOf(fx.calDee));
    await expect(focus.getByTestId("md-called-panel")).toContainText(names.cal);
    await expect(focus.getByTestId("md-called-panel")).toContainText(names.dee);
    await expect(row(page, a3.name)).toHaveAttribute("data-state", "called");
    await expectNoHorizontalScroll(page);
    // Undo the call: the court is free again and the match is back among the candidates.
    await focus.getByTestId("md-undo-call").click();
    await expect(focus).toHaveAttribute("data-state", "free");
    await expect(focus.locator(`[data-testid="md-candidate"][data-fixture-id="${fx.calDee}"]`)).toBeVisible();
    await expect(candidates).toHaveCount(waiting.length);
    await expect(row(page, a3.name)).toHaveAttribute("data-state", "free");

    // ── 7. PLAYER_BUSY: another desk puts a player on a court while this tab's page is out of date ────────────────────────────
    // This tab's polls (the page's own and the candidates') are stalled, so it keeps showing the picture it has. The stall goes in first and
    // THEN the reads already on their way are waited out, so no poll can land after the second actor (another desk, through the API) moves.
    const stall = async (route: Route): Promise<void> => {
      if (route.request().method() === "GET") await route.abort();
      else await route.continue();
    };
    await page.route(matchDayGets, stall);
    await expect.poll(() => inFlight.size, { message: "no read of the day is still on its way once the stall is in" }).toBe(0);
    await expect(focus).toHaveAttribute("data-court-id", a3.id);
    await expect(candidates, "the page still offers every waiting match").toHaveCount(waiting.length);
    const callBenCal = (): Locator =>
      focus.locator(`[data-testid="md-candidate"][data-fixture-id="${fx.benCal}"]`).getByRole("button", { name: fill("matchDay.candidate.call", { court: a3.name }) });
    const notice = focus.getByTestId("md-notice");
    const busyWords = fill("matchDay.refusal.PLAYER_BUSY", { person: names.ben, court: b2.name });
    const nothingCalled = async (why: string): Promise<void> => {
      const n = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id = ${fx.benCal}`);
      expect(n[0]!.n, why).toBe(0);
    };

    // 7a. Refused at CONFIRM: the sheet is open and its preview passed (nobody is busy yet); THEN the other desk calls Ana v Ben onto B2;
    // Confirm is the call itself, and the server refuses it there, not at the preview.
    await callBenCal().click();
    const busySheet = page.getByRole("dialog");
    await expect(busySheet).toContainText(fill("matchDay.sheet.title", { court: a3.name }));
    const busyConfirm = busySheet.getByTestId("md-call-confirm");
    await expect(busyConfirm, "the preview passed: nobody is busy yet").toBeEnabled();
    const other = await apiJson(request, `/api/v1/fixtures/${fx.anaBen}/call`, "POST", { court_id: b2.id });
    expect(other.status, `the other desk's call: ${JSON.stringify(other.error)}`).toBeLessThan(300);
    await busyConfirm.click();
    await expect(notice, "the confirm was refused").toBeVisible();
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice).toContainText(busyWords);
    await expect(page.getByRole("dialog"), "the sheet closed on the refusal").toHaveCount(0);
    await nothingCalled("the call refused at confirm called nothing");
    await expectNoHorizontalScroll(page);
    await notice.getByRole("button", { name: uiEn["matchDay.notice.dismiss"]! }).click();
    await expect(notice).toHaveCount(0);

    // 7b. Refused at PREVIEW: the stale tab still shows Ben v Cal as callable (its polls are stalled), so the tap opens a sheet that is refused
    // before it shows anything.
    const staleBenCal = focus.locator(`[data-testid="md-candidate"][data-fixture-id="${fx.benCal}"]`);
    await expect(staleBenCal, "the stale tab still offers Ben v Cal").not.toHaveAttribute("data-blocked", /.+/);
    await callBenCal().click();
    await expect(notice, "the preview was refused").toBeVisible();
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice).toContainText(busyWords);
    await expect(page.getByRole("dialog"), "the sheet closed on the refusal").toHaveCount(0);
    await nothingCalled("the call refused at preview called nothing");
    await expectNoHorizontalScroll(page);
    // Let the page hear the truth again: the next poll greys every match of the two players on court, each with its reason.
    await page.unroute(matchDayGets, stall);
    const busyPeople = new Set([ana, ben]);
    // Ana v Ben is the match the other desk called: it stays on the list as "Called to B2, not started" (calling it here would MOVE
    // the call), and its own hold does not block it. Every OTHER match of Ana or Ben is now blocked.
    const others = waiting.filter((id) => id !== fx.anaBen);
    const blockedIds = others.filter((id) => {
      const r = fxRows.find((x) => x.id === id)!;
      return busyPeople.has(r.home_entrant_id ?? "") || busyPeople.has(r.away_entrant_id ?? "");
    });
    expect(new Set(blockedIds), "premise: Ana and Ben's other matches are the blocked ones").toEqual(new Set([fx.anaCal, fx.anaDee, fx.benCal, fx.benDee]));
    await expect(focus.locator('[data-testid="md-candidate"][data-blocked="true"]')).toHaveCount(blockedIds.length, { timeout: POLL_MS });
    let reasons = 0;
    for (const id of blockedIds) {
      const li = focus.locator(`[data-testid="md-candidate"][data-fixture-id="${id}"]`);
      await expect(li).toHaveAttribute("data-blocked", "true");
      await expect(li.getByRole("button"), "a blocked match has nothing to press").toHaveCount(0);
      await expect(li).toContainText(new RegExp(`(${[names.ana, names.ben].map((person) => esc(fill("matchDay.candidate.blocked", { person, court: b2.name }))).join("|")})`));
      reasons++;
    }
    expect(reasons, "anti-vacuity: a reason read for every blocked match").toBe(blockedIds.length);
    const calledElsewhere = focus.locator(`[data-testid="md-candidate"][data-fixture-id="${fx.anaBen}"]`);
    await expect(calledElsewhere, "the called match is not blocked by its own call").not.toHaveAttribute("data-blocked", /.+/);
    await expect(calledElsewhere).toContainText(fill("matchDay.candidate.where.calledOn", { court: b2.name }));
    await expect(page.getByTestId("md-free-panel")).toContainText(fill("matchDay.free.count.other", { count: waiting.length - blockedIds.length }));
    await notice.getByRole("button", { name: uiEn["matchDay.notice.dismiss"]! }).click();
    await expect(notice).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // ── 8. THE SEMI-FINALS FINISH; BREADCRUMB BACK; THE DOOR AGAIN; THE FINAL ─────────────────────────────────────────────────
    // Both finish elsewhere (a scorer's pad): the Final's sides are then known and both finalists have just played.
    // The second semi-final is PLAYED the way a pad plays one (kicked off, then decided): a result entered on a match that never started
    // gives its players no rest to count from (task F6), and the Final's rest warning below is about two players who really played.
    const kickoff = await apiJson(request, `/api/v1/fixtures/${fx.sf2}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    expect(kickoff.status, `core.start: ${JSON.stringify(kickoff.error)}`).toBeLessThan(300);
    await scoreFixture(request, fx.sf1, 3, 1);
    await scoreFixture(request, fx.sf2, 2, 0);
    await expect
      .poll(async () => (await withDb((sql) => sql<{ h: string | null; a: string | null }[]>`select home_entrant_id as h, away_entrant_id as a from fixtures where id = ${fx.final}`))[0]!, {
        message: "the Final has both its sides",
        timeout: 20_000,
      })
      .toMatchObject({ h: expect.any(String), a: expect.any(String) });
    const finalists = await withDb((sql) => sql<{ display_name: string }[]>`
      select e.display_name from fixtures f join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id) where f.id = ${fx.final} order by e.display_name`);
    expect(finalists, "two finalists").toHaveLength(2);

    // The breadcrumb trail in the top bar: the competition, then Match Day as the page you are on (not a link). The competition crumb goes back.
    const trail = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(trail.locator('[aria-current="page"]'), "the last crumb is the current page").toHaveText(uiEn["breadcrumb.matchDay"]!);
    const crumb = trail.getByRole("link", { name: competitionName, exact: true });
    await expect(crumb).toHaveAttribute("href", compPath);
    await crumb.click();
    await expect(page).toHaveURL(new RegExp(`${esc(compPath)}$`), { timeout: 20_000 });
    await expect(page.getByTestId("desk-tool-match-day")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByTestId("desk-tool-match-day").click();
    await expect(page).toHaveURL(new RegExp(`${esc(compPath)}/match-day`), { timeout: 20_000 });

    await openFold(page);
    await row(page, a3.name).click();
    await expect(focus).toHaveAttribute("data-court-id", a3.id);
    await expect(focus).toHaveAttribute("data-state", "free");
    // What waits now: the league matches (Ana v Ben still listed as called to B2, not started) and the Final; the semi-finals are played.
    const laterWaiting = [fx.anaCal, fx.anaBen, fx.benCal, fx.calDee, fx.anaDee, fx.benDee, fx.final];
    await expect(candidates).toHaveCount(laterWaiting.length);
    const laterListed = await candidates.evaluateAll((els) => els.map((e) => e.getAttribute("data-fixture-id") ?? ""));
    expect([...laterListed].sort()).toEqual([...laterWaiting].sort());
    let laterChips = 0;
    for (const id of laterWaiting) {
      await expect(focus.locator(`[data-testid="md-candidate"][data-fixture-id="${id}"]`).getByTestId("md-round-chip")).toHaveAttribute("data-round-code", chipOf(id));
      laterChips++;
    }
    expect(laterChips, "anti-vacuity: every candidate's chip read, the Final's among them").toBe(laterWaiting.length);
    await expect(
      focus.locator(`[data-testid="md-candidate"][data-fixture-id="${fx.final}"]`).getByTestId("md-round-chip"),
      "the Final wears the board's code for it",
    ).toHaveAttribute("data-round-code", chipOf(fx.final));
    await expectNoHorizontalScroll(page);

    await focus.locator(`[data-testid="md-candidate"][data-fixture-id="${fx.final}"]`).getByRole("button", { name: fill("matchDay.candidate.call", { court: a3.name }) }).click();
    const finalSheet = page.getByRole("dialog");
    await expect(finalSheet.getByTestId("md-round-chip")).toHaveAttribute("data-round-code", chipOf(fx.final));
    await expect(finalSheet.getByTestId("md-call-confirm")).toBeEnabled();
    // Both finalists finished a match a moment ago: the rest warning names each of them, once.
    const restWarnings = finalSheet.locator('[data-testid="md-warning"][data-kind="rest_gap"]');
    await expect(restWarnings).toHaveCount(2);
    const spoken = await restWarnings.allTextContents();
    for (const { display_name } of finalists) {
      expect(spoken.filter((s) => templateRegex("matchDay.sheet.warn.restGap", { person: display_name, min: MIN_REST }, ["minutes"]).test(s)), `${display_name}'s rest warning`).toHaveLength(1);
    }
    await finalSheet.getByTestId("md-call-confirm").click();
    await expect(finalSheet).toHaveCount(0);
    await expect(focus).toHaveAttribute("data-state", "called");
    const called = focus.getByTestId("md-called-panel");
    await expect(called.getByTestId("md-round-chip")).toHaveAttribute("data-round-code", chipOf(fx.final));
    for (const { display_name } of finalists) await expect(called).toContainText(display_name);
    await expect(focus.getByTestId("md-undo-call")).toBeVisible();
    const landed = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id = ${fx.final} and court_id = ${a3.id}`);
    expect(landed[0]!.n, "the Final was called onto Court 3").toBe(1);
    await expect(row(page, a3.name)).toHaveAttribute("data-state", "called");
    // The day, read back: A3 called (the Final), B2 called (the other desk's call), A1 free of its finished semi-final.
    await expect(row(page, b2.name)).toHaveAttribute("data-state", "called");
    await expectNoHorizontalScroll(page);

    // The page's own header names the competition too, and that link goes back as well: the day ends where it began.
    const back = page.getByTestId("md-header").getByRole("link", { name: fill("matchDay.backToCompetition", { competition: competitionName }) });
    await expect(back).toHaveText(competitionName);
    await back.click();
    await expect(page).toHaveURL(new RegExp(`${esc(compPath)}$`), { timeout: 20_000 });
    await expect(page.getByTestId("desk-tool-match-day"), "still a match day: the door is there to open it again").toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
