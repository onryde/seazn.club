// Spectator W2 (4/4), Task 17 — the competition hub's tabs, as a spectator
// sees them.
//
// Owner-approved inventory 2026-09-16 (HB1–HB13) "with your recs": the Teams
// squad `<details>` and Info suspensions parity cases are IN; screens at
// 320/390/768/1024/1280 are captured to the test's own output and NOT
// committed; a readable name is at least 12 visible characters.
//
// Premises the inventory had wrong, pinned here instead (AGENTS.md #5):
//   - HB2: when the last live match ends the Matches filter does NOT stay on
//     Live with an empty sentence. `matches-tab.tsx` reconciles: a chip exists
//     only while its bucket has matches, and a chosen bucket that empties falls
//     back to `defaultMatchesFilter` (live > upcoming > completed). The case
//     asserts the fallback.
//   - The Teams card's name carries an `id` (`mh-team-{e}-name`), not a testid.
//   - HB2: Overview shows NO `mh-status` sentence while a match is live — the
//     Live now rail leads instead (`overviewPlan`, case "live"), so "status =
//     landing.status.live.one" can never hold. The case asserts the rail
//     while live and the sentence's return once nothing is.
//   - Stats are not folded by a READ (the option-B stats merge, owner rulings
//     2026-09-16/17; see `spectator-w2-kit.ts`). B's result schedules the fold,
//     which reads EVERY event in the division, live match A's included. So A's
//     eight balls are bowled BEFORE B's result: every fold after that (the
//     scheduled one, or any a reconcile queues) reads the same ledger until
//     HB2 moves A again, and HB6's oracle is that whole ledger.
//
// One competition on the shared Pro org, everything seeded before the first
// public read:
//   Cricket  — Kestrels, Ospreys and a 43-character Falcons (one masked
//              member, one suspended member, a division description). Match A
//              live mid-innings, match B decided, match C upcoming. Every ball
//              is scripted, so the ledger is the oracle.
//   Generic  — one decided match (HB10), two upcoming.
//   Juniors  — entrants and no stage: a Teams card with no table (HB3's pair).
//
// Serial with the seed as test 1 (AGENTS.md #21: a red count is a floor).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { fmtPublicZoneAbbrev } from "../../src/lib/format";
import { maskDisplayName } from "../../src/lib/name-display";
import { apiJson, expectNoHorizontalScroll, overflowingIn, scoreFixture, TAG } from "../helpers";
import { HIT_TARGET_FLOOR_PX } from "../scorepad-a11y-kit";
import {
  centreHits,
  closeOpenContexts,
  controlSet,
  divisionSlug,
  makeCricketDivision,
  mustPost,
  putLineups,
  type Team,
} from "../spectator-public-helpers";
import {
  absoluteEscapes,
  activeOrgSlug,
  API_CALL_MS,
  awaitStatsFold,
  dictString,
  division,
  entrants,
  eventStream,
  FLOOR_MS,
  LAND_SLACK_MS,
  leagueFixtures,
  lineUpOnHubTransport,
  mintSpectatorOrg,
  noReloadGuard,
  person,
  primeBrowserCache,
  publicCompetition,
  publicJson,
  scheduleFixture,
  SCREEN_WIDTHS,
  expectDistinctShots,
  SHOT_STATE_MS,
  shootStates,
  spectator,
  statsFoldLandMs,
  STEP_MS,
  TAB_CHECK_MS,
  uiString,
  w2Clock,
  type FixtureRow,
  type MintedOrg,
  type ShotState,
} from "../spectator-w2-kit";

test.describe.configure({ mode: "serial" });
test.afterEach(closeOpenContexts);

// ---------------------------------------------------------------------------
// The hub document, as far as this file reads it
// (`server/public-site/competition-hub-schema.ts`)
// ---------------------------------------------------------------------------

interface HubMatch {
  fixtureId: string;
  divisionSlug: string;
  bucket: "live" | "upcoming" | "completed";
  tz: string;
  scheduledAt: string | null;
  header: { scoreLines: string[]; subLines: string[] };
  resultLine: string | null;
}
interface HubTable {
  id: string;
  divisionSlug: string;
  columns: { key: string; compact: boolean }[];
  fullHref: string;
}
interface HubDoc {
  tabs: string[];
  matches: HubMatch[];
  tables: HubTable[];
  leaders: { divisionSlug: string; key: string; rows: { person: { personId: string }; value: string }[] }[];
}

const RENDERABLE = new Set(["overview", "matches", "table", "knockout", "stats", "teams", "info"]);
const PHONE_WIDTHS = [320, 360, 375, 390, 430, 768, 834] as const;

let org: MintedOrg;
let comp = { id: "", slug: "" };
let cricketSlug = "";
let genericSlug = "";
let juniorsSlug = "";
let teams: { kestrels: Team; ospreys: Team; falcons: Team } = {} as never;
let matchA = "";
let matchB = "";
let matchC = "";
let genericDone = "";
const DESCRIPTION = `Twelve balls a side on the back field, ${TAG}.`;
/** A's batting state after the seed, carried into HB2's boundary and finish. */
let innA: Innings;
let aChase: { batting: Team; bowling: Team };
/** Falcons: the masked member and the suspended one. */
let masked = { id: "", name: "" };
let banned = { id: "", name: "" };
const FALCONS_NAME = `Northfield Falcons Cricket Club ${TAG}`.padEnd(43, "x").slice(0, 43);

// ---------------------------------------------------------------------------
// Scripted cricket: every ball's runs are written down, so the ledger is known
// ---------------------------------------------------------------------------

class Innings {
  legal = 0;
  striker: string;
  nonStriker: string;
  constructor(
    readonly batting: Team,
    readonly bowling: Team,
  ) {
    this.striker = batting.order[0]!;
    this.nonStriker = batting.order[1]!;
  }
  ball(bat: number): Record<string, unknown> {
    const over = Math.floor(this.legal / 6);
    const payload = {
      over,
      ballInOver: (this.legal % 6) + 1,
      striker: this.striker,
      nonStriker: this.nonStriker,
      bowler: this.bowling.order[over % 2],
      runs: { bat },
      ...(bat === 4 || bat === 6 ? { boundary: bat } : {}),
    };
    this.legal += 1;
    if (bat % 2 === 1) this.swap();
    if (this.legal % 6 === 0) this.swap();
    return payload;
  }
  private swap() {
    [this.striker, this.nonStriker] = [this.nonStriker, this.striker];
  }
}

async function bowl(request: APIRequestContext, fixtureId: string, inn: Innings, runs: number[]): Promise<void> {
  const s = await eventStream(request, fixtureId);
  for (const bat of runs) await s.post("cricket.ball", inn.ball(bat));
}

async function startMatch(request: APIRequestContext, fixtureId: string, first: Team, second: Team): Promise<void> {
  await putLineups(request, fixtureId, [first, second]);
  await mustPost(request, fixtureId, "cricket.toss", { wonBy: first.entrantId, elected: "bat" });
  await mustPost(request, fixtureId, "core.start", {});
}

/** Big enough that leaving live match A out would change the Stats tab's top
 *  runs row, whichever side bats first in A and B (HB6 asserts that premise). */
const A_FIRST_EIGHT = [6, 0, 4, 6, 0, 1, 2, 0];
const A_REST_OF_INNINGS_ONE = [1, 0, 2];
const A_CHASE = Array.from({ length: 12 }, () => 0);
const B_INNINGS_ONE = [6, 1, 0, 4, 2, 1, 0, 4, 1, 2, 0, 6];
const B_INNINGS_TWO = [1, 1, 0, 2, 0, 0, 1, 0, 0, 2, 0, 1];

function pair(rows: FixtureRow[], x: Team, y: Team): FixtureRow {
  const row = rows.find(
    (r) =>
      (r.home_entrant_id === x.entrantId && r.away_entrant_id === y.entrantId) ||
      (r.home_entrant_id === y.entrantId && r.away_entrant_id === x.entrantId),
  );
  if (!row) throw new Error(`no fixture ${x.name} v ${y.name}`);
  return row;
}

async function hubDoc(): Promise<HubDoc> {
  const res = await publicJson<HubDoc>(`/api/v1/public/orgs/${org.slug}/competitions/${comp.slug}/hub`);
  expect(res.status, "the hub document").toBe(200);
  return res.data!;
}

const SEED_CALLS = 120;

test("setup: a hub with a live and a decided cricket match, a generic league and a teams-only division", async ({
  request,
}) => {
  const foldMs = statsFoldLandMs() + LAND_SLACK_MS;
  test.setTimeout(Math.max(FLOOR_MS, SEED_CALLS * API_CALL_MS + foldMs));
  org = await activeOrgSlug(request);
  comp = await publicCompetition(request, { name: `Hub Walkthrough ${TAG}`, orgId: org.id });

  // --- cricket ----------------------------------------------------------------------
  const cricketId = await makeCricketDivision(request, comp.id, { name: `Cricket ${TAG}`, ballsPerInnings: 12, playersPerSide: 4 });
  cricketSlug = await divisionSlug(request, cricketId);
  const patched = await apiJson(request, `/api/v1/divisions/${cricketId}`, "PATCH", { description: DESCRIPTION });
  expect(patched.status, JSON.stringify(patched.error)).toBe(200);

  const roster = async (names: string[], consent: boolean[] = [true, true, true, true]) => {
    const ids: string[] = [];
    for (const [i, n] of names.entries()) ids.push(await person(request, n, consent[i]!));
    return ids;
  };
  const kIds = await roster(["Arjun Mehta", "Rohan Pillai", "Kabir Sethi", "Dev Anand"].map((n) => `${n} ${TAG}`));
  const oIds = await roster(["Liam Walsh", "Noah Byrne", "Owen Doyle", "Ciaran Kelly"].map((n) => `${n} ${TAG}`));
  const fNames = ["Ethan Price", "Mason Reid", "Harvey Lowe", "Tobias Wainwright"].map((n) => `${n} ${TAG}`);
  const fIds = await roster(fNames, [true, true, true, false]);
  masked = { id: fIds[3]!, name: fNames[3]! };
  banned = { id: fIds[2]!, name: fNames[2]! };
  const cricketEntrants = await entrants(request, cricketId, [
    { kind: "team", name: `Kestrels ${TAG}`, members: kIds },
    { kind: "team", name: `Ospreys ${TAG}`, members: oIds },
    { kind: "team", name: FALCONS_NAME, members: fIds },
  ]);
  teams = {
    kestrels: { name: `Kestrels ${TAG}`, entrantId: cricketEntrants[0]!, order: kIds },
    ospreys: { name: `Ospreys ${TAG}`, entrantId: cricketEntrants[1]!, order: oIds },
    falcons: { name: FALCONS_NAME, entrantId: cricketEntrants[2]!, order: fIds },
  };
  const cricketRows = await leagueFixtures(request, cricketId);
  const a = pair(cricketRows, teams.kestrels, teams.ospreys);
  const b = pair(cricketRows, teams.ospreys, teams.falcons);
  const c = pair(cricketRows, teams.kestrels, teams.falcons);
  [matchA, matchB, matchC] = [a.id, b.id, c.id];
  await scheduleFixture(request, matchB, "2030-07-25T10:00:00Z");
  await scheduleFixture(request, matchA, "2030-08-01T10:00:00Z");
  await scheduleFixture(request, matchC, "2030-08-08T10:00:00Z");

  // A: live, eight balls into the first innings, BEFORE B's result (header).
  const aHome = a.home_entrant_id === teams.kestrels.entrantId ? teams.kestrels : teams.ospreys;
  const aAway = aHome === teams.kestrels ? teams.ospreys : teams.kestrels;
  await startMatch(request, matchA, aHome, aAway);
  innA = new Innings(aHome, aAway);
  aChase = { batting: aAway, bowling: aHome };
  await bowl(request, matchA, innA, A_FIRST_EIGHT);

  // B: decided — the home side bats first and wins. Its deciding ball schedules
  // the division's stats fold after its response; a read folds nothing, so wait
  // for the rows before any hub render (the Stats tab exists only with them).
  const bHome = b.home_entrant_id === teams.ospreys.entrantId ? teams.ospreys : teams.falcons;
  const bAway = bHome === teams.ospreys ? teams.falcons : teams.ospreys;
  await startMatch(request, matchB, bHome, bAway);
  await bowl(request, matchB, new Innings(bHome, bAway), B_INNINGS_ONE);
  await bowl(request, matchB, new Innings(bAway, bHome), B_INNINGS_TWO);
  await awaitStatsFold(org.slug, comp.slug, cricketSlug, foldMs);

  // A manual ban on a Falcons player, confirmed so it is active.
  const ban = await apiJson<{ id: string }>(request, `/api/v1/divisions/${cricketId}/suspensions`, "POST", {
    person_id: banned.id,
    matches_total: 2,
    reason: `e2e ${TAG}`,
  });
  expect(ban.status, JSON.stringify(ban.error)).toBeLessThan(300);
  const confirmed = await apiJson(request, `/api/v1/suspensions/${ban.data!.id}`, "PATCH", { kind: "confirm" });
  expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);

  // --- generic -------------------------------------------------------------------------
  const generic = await division(request, comp.id, {
    name: `Generic ${TAG}`,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  genericSlug = generic.slug;
  await entrants(request, generic.id, [
    { kind: "team", name: `Harbour ${TAG}`, members: [] },
    { kind: "team", name: `Quarry ${TAG}`, members: [] },
    { kind: "team", name: `Mill Lane ${TAG}`, members: [] },
  ]);
  const genericRows = await leagueFixtures(request, generic.id);
  const when = ["2030-07-26T12:00:00Z", "2030-08-02T12:00:00Z", "2030-08-09T12:00:00Z"];
  for (const [i, row] of genericRows.entries()) await scheduleFixture(request, row.id, when[i]!);
  genericDone = genericRows[0]!.id;
  await scoreFixture(request, genericDone, 2, 1);

  // --- juniors: entrants, no stage ------------------------------------------------------
  const juniors = await division(request, comp.id, { name: `Juniors ${TAG}`, sport_key: "generic", variant_key: "score" });
  juniorsSlug = juniors.slug;
  await entrants(request, juniors.id, [
    { kind: "team", name: `Juniors Red ${TAG}`, members: [] },
    { kind: "team", name: `Juniors Blue ${TAG}`, members: [] },
  ]);

  console.log(`seeded: ${org.slug}/${comp.slug} cricket=${cricketSlug} A=${matchA} B=${matchB} C=${matchC} generic=${genericSlug}`);
});

const hubPath = (query = "") => `/shared/${org.slug}/${comp.slug}${query}`;

async function openTab(page: Page, id: string, extra = ""): Promise<void> {
  await page.goto(hubPath(`?tab=${id}${extra}`));
  await expect(page.getByTestId(`mh-tab-panel-${id}`), `?tab=${id} opened a different tab`).toBeVisible();
}

/** A card's two score spans, whitespace dropped (score line + its sub line). */
async function cardScores(card: Locator): Promise<string[]> {
  const out: string[] = [];
  for (const i of [0, 1]) {
    const text = await card.getByTestId(`mh-match-side-${i}`).locator(":scope > span.font-display").textContent();
    out.push((text ?? "").replace(/\s+/g, ""));
  }
  return out;
}

function docScores(doc: HubDoc, fixtureId: string): string[] {
  const m = doc.matches.find((x) => x.fixtureId === fixtureId)!;
  return [0, 1].map((i) => `${m.header.scoreLines[i] ?? ""}${m.header.subLines[i] ?? ""}`.replace(/\s+/g, ""));
}

// HB1 — the rail is the document's tab set, in the document's order.
test("HB1: the tab rail is the hub document's tabs, in its order, in English labels", async ({ browser }) => {
  test.setTimeout(Math.max(FLOOR_MS, 2 * STEP_MS));
  const doc = await hubDoc();
  const expected = doc.tabs.filter((id) => RENDERABLE.has(id));
  expect(expected, "this seed produces every tab but Knockout").toEqual(["overview", "matches", "table", "stats", "teams", "info"]);
  const page = await spectator(browser, { width: 320 });
  await page.goto(hubPath());
  await expect(page.getByRole("tab")).toHaveText(expected.map((id) => dictString("en", `landing.tab.${id}`)));
  console.log(`HB1 transport=${await page.getByTestId("mh-root").getAttribute("data-transport")} tabs=${expected.join(",")}`);
});

// HB6 — Stats: the top runs row is the batter the ledger says, and it links to
// a consenting player's card. What the board shows is the last fold's ledger:
// B's result folded every event in the division, live A's eight balls included
// (they were bowled first, see the header), and no fold after it can read
// anything else until HB2 bowls A again. So the oracle is every ball, A's too,
// and A's script makes that differ from the settled-only count: a board that
// left the live match's folded balls out reds here.
test("HB6: the Stats tab's top runs row is the ledger's top scorer, live match A's folded balls included, with the ledger's total", async ({
  browser,
  request,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 3 * STEP_MS));
  const live = await apiJson<{ status: string }>(request, `/api/v1/fixtures/${matchA}`);
  expect(live.data?.status, "match A is still in play").toBe("in_play");
  const all = new Map<string, number>();
  const withoutA = new Map<string, number>();
  for (const f of [matchA, matchB, matchC]) {
    const events = await apiJson<{ type: string; payload: { striker?: string; runs?: { bat?: number } } }[]>(
      request,
      `/api/v1/fixtures/${f}/events?since_seq=0`,
    );
    for (const e of events.data ?? []) {
      if (e.type !== "cricket.ball" || !e.payload.striker) continue;
      const add = (m: Map<string, number>) => m.set(e.payload.striker!, (m.get(e.payload.striker!) ?? 0) + (e.payload.runs?.bat ?? 0));
      add(all);
      if (f !== matchA) add(withoutA);
    }
  }
  const rank = (m: Map<string, number>) => [...m].sort((x, y) => y[1] - x[1]);
  const ranked = rank(all);
  const rankedWithoutA = rank(withoutA);
  console.log(`HB6 ledger runs: ${JSON.stringify(ranked.slice(0, 3))} without live A: ${JSON.stringify(rankedWithoutA.slice(0, 3))}`);
  expect(ranked[0]![1], "the ledger's top scorer is unique, or 'first row' proves nothing").toBeGreaterThan(ranked[1]![1]);
  expect(rankedWithoutA[0], "leaving live A out must change the top row, or this case cannot tell the two apart").not.toEqual(
    ranked[0],
  );
  const [topId, topRuns] = ranked[0]!;

  const page = await spectator(browser, { width: 390 });
  await openTab(page, "stats");
  const board = page.getByTestId(`mh-leaders-${cricketSlug}-runs`);
  await expect(board).toBeVisible();
  const first = board.locator('li[data-testid*="-row-"]').first();
  await expect(first).toHaveAttribute("data-testid", `mh-leaders-${cricketSlug}-runs-row-${topId}`);
  await expect(first.locator("span.font-display.tabular-nums")).toHaveText(String(topRuns));
  await expect(first.locator(`a[href="/shared/${org.slug}/${comp.slug}/players/${topId}"]`)).toHaveCount(1);
});

// HB2 — R10 on the Matches card, the Overview's Live now and the Table. A
// boundary moves the card with no reload; when the match ends, the Live chip
// goes, the filter falls back, the status line stops saying "Live" and the
// winner's played count ticks up.
test("HB2: a boundary moves the live card in place; the match ending updates Matches, Overview and Table without a reload", async ({
  browser,
  request,
}, testInfo) => {
  const clock = w2Clock();
  const lineUpMs = clock.hubPollMs + STEP_MS;
  const landMs = clock.hubPollMs + LAND_SLACK_MS;
  const finishBalls = A_REST_OF_INNINGS_ONE.length + A_CHASE.length;
  const liveStates: ShotState[] = [
    {
      name: "matches-live",
      open: async (p) => {
        await openTab(p, "matches");
        await expect(p.getByTestId("mh-filter-live"), "the Live filter is pressed").toHaveAttribute("aria-pressed", "true");
        await expect(p.getByTestId(`mh-match-${matchA}`), "match A's live card").toBeVisible();
      },
    },
    {
      name: "overview-live-now",
      open: async (p) => {
        await openTab(p, "overview");
        const rail = p.getByTestId(`mh-live-now-card-${matchA}`);
        await expect(rail, "the Live now rail leads the Overview").toBeVisible();
        await expect(p.getByTestId("mh-status"), "no status sentence while live").toHaveCount(0);
        await rail.scrollIntoViewIfNeeded();
      },
    },
  ];
  test.setTimeout(
    Math.max(
      FLOOR_MS,
      6 * STEP_MS +
        2 * (lineUpMs + landMs) +
        (finishBalls + 6) * API_CALL_MS +
        liveStates.length * SCREEN_WIDTHS.length * SHOT_STATE_MS,
    ),
  );
  const hubApi = `/api/v1/public/orgs/${org.slug}/competitions/${comp.slug}/hub`;

  // The owner's capture matrix, LIVE half: A is live until this test ends it,
  // so these states can be shot here and nowhere later (HB13 has the rest).
  const shots = testInfo.outputPath("hub-live-screens");
  await shootStates(browser, shots, liveStates);
  expectDistinctShots(shots, liveStates.map((st) => st.name));

  const page = await spectator(browser, { width: 390 });
  await openTab(page, "matches");
  await expect(page.getByTestId("mh-filter-live"), "Matches opens on Live while a match is live").toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const card = page.getByTestId(`mh-match-${matchA}`);
  const before = await cardScores(card);
  const completedBefore = (await publicJson<HubDoc>(hubApi)).data!.matches.filter((m) => m.bucket === "completed").length;
  const samePage = await noReloadGuard(page);

  const lined = await lineUpOnHubTransport(page, hubApi, lineUpMs);
  expect(lined, "neither a realtime subscription nor a poll tick").not.toBeNull();
  await primeBrowserCache(page, hubApi);
  await bowl(request, matchA, innA, [4]);

  await expect.poll(() => cardScores(card), { message: `the boundary never reached the card (lined up on ${lined})`, timeout: landMs }).not.toEqual(before);
  const moved = await cardScores(card);
  const doc = await hubDoc();
  expect(moved, "the card and the document are two readers of one score").toEqual(docScores(doc, matchA));
  console.log(`HB2 card ${JSON.stringify(before)} -> ${JSON.stringify(moved)} via ${lined}`);

  // Overview: while something is live the panel LEADS with the Live now rail
  // and carries no status sentence — the one rung without one, by design
  // (`overview-tab.tsx` `overviewPlan`, case "live").
  await page.getByTestId("mh-tab-overview").click();
  const liveNow = page.getByTestId(`mh-live-now-card-${matchA}`);
  await expect(liveNow).toBeVisible();
  expect(await cardScores(liveNow), "Overview's Live now card").toEqual(moved);
  await expect(page.getByTestId("mh-status"), "no status sentence while a match is live").toHaveCount(0);

  await page.getByTestId("mh-tab-table").click();
  const view = doc.tables.find((t) => t.divisionSlug === cricketSlug)!;
  const winnerPlayed = page
    .getByTestId(`mh-table-${view.id}-row-${innA.batting.entrantId}`)
    .locator('td[data-col="played"]');
  const played = Number(await winnerPlayed.textContent());

  // The rest of innings one, then a chase of dots: the side batting first wins.
  const lined2 = await lineUpOnHubTransport(page, hubApi, lineUpMs);
  expect(lined2).not.toBeNull();
  await primeBrowserCache(page, hubApi);
  await bowl(request, matchA, innA, A_REST_OF_INNINGS_ONE);
  await bowl(request, matchA, new Innings(aChase.batting, aChase.bowling), A_CHASE);
  const ended = await apiJson<{ status: string }>(request, `/api/v1/fixtures/${matchA}`);
  console.log(`HB2 match A stored status after the chase: ${ended.data?.status}`);

  // The live bar, not the idle poll: a result a minute late is a defect. A is
  // its division's LAST live match, the case `HUB_LIVE_LINGER_MS`
  // (use-live-competition.ts) exists for. What this line witnesses depends on
  // the transport. Over realtime (local prod builds) the race was measured
  // here: a refetch between the deciding ball's commit and its standings
  // rewrite dropped the channel before the deciding push. In CI the transport
  // is poll (dummy Supabase key) and a tick almost never lands in that ~200ms
  // window, so CI passes with or without the linger; there the linger rests on
  // `use-live-competition.test.tsx`.
  await expect(winnerPlayed, "the Table's played count never ticked up").toHaveText(String(played + 1), { timeout: landMs });
  await page.getByTestId("mh-tab-matches").click();
  await expect(page.getByTestId("mh-filter-live"), "no live chip once nothing is live").toHaveCount(0);
  await expect(page.getByTestId("mh-filter-upcoming"), "the filter falls back to Upcoming").toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("mh-filter-completed")).toHaveText(
    `${dictString("en", "matchesHub.filter.completed")} ${completedBefore + 1}`,
  );
  // Overview: the Live now rail is gone and the status sentence is back, now
  // announcing the next match (upcoming matches remain).
  await page.getByTestId("mh-tab-overview").click();
  await expect(page.getByTestId("mh-live-now-card-" + matchA)).toHaveCount(0);
  await expect(page.getByTestId("mh-status")).toHaveAttribute("data-kind", "next");
  expect((await hubDoc()).matches.find((m) => m.fixtureId === matchA)?.bucket, "the document files A as completed").toBe(
    "completed",
  );
  await samePage("after the match ended");
});

// HB3 — R11: the Table's division filter lists every division with a table,
// cricket included, and a tap narrows it in place.
test("HB3: the Table division filter lists every division with a table, cricket included, and narrows to one", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 4 * STEP_MS));
  const doc = await hubDoc();
  const withTables = [...new Set(doc.tables.map((t) => t.divisionSlug))].sort();
  expect(withTables, "cricket and generic have tables; juniors does not").toEqual([cricketSlug, genericSlug].sort());
  for (const width of [390, 1280]) {
    const page = await spectator(browser, { width });
    await openTab(page, "table");
    const chips = await page
      .locator('[data-testid^="mh-table-division-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace("mh-table-division-", "")));
    expect(chips.filter((s) => s !== "all").sort(), `@${width}: division chips`).toEqual(withTables);
    await expect(page.getByTestId(`mh-table-division-${juniorsSlug}`)).toHaveCount(0);
    await page.getByTestId(`mh-table-division-${cricketSlug}`).click();
    await expect(page.getByTestId(`mh-table-division-${cricketSlug}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId(`mh-table-heading-${cricketSlug}`)).toBeVisible();
    await expect(page.getByTestId(`mh-table-heading-${genericSlug}`)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get("division")).toBe(cricketSlug);
  }
});

/** How many characters of an element's own text are readable in its box — a
 *  truncated line loses about an em to its ellipsis. */
async function visibleChars(el: Locator): Promise<{ chars: number; width: number; truncated: boolean; textOverflow: string; whiteSpace: string }> {
  return el.evaluate((node) => {
    const cs = getComputedStyle(node);
    const text = node.firstChild as Text;
    const truncated = node.scrollWidth > node.clientWidth;
    const avail = node.clientWidth - (truncated ? parseFloat(cs.fontSize) : 0);
    const r = document.createRange();
    let chars = 0;
    for (let i = 1; i <= text.data.length; i++) {
      r.setStart(text, 0);
      r.setEnd(text, i);
      if (r.getBoundingClientRect().width <= avail + 0.5) chars = i;
      else break;
    }
    return { chars, width: node.clientWidth, truncated, textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace };
  });
}

// HB4 + HB5 — Teams opens the squad in place: consenting players link to their
// card, a masked one is initials with no link, the long name keeps a readable
// ellipsis, and the Suspended tag sits on exactly the banned player. Info shows
// the same ban and the division's description.
test("HB4/HB5: a Teams card opens the squad in place, consent-correct, readable and with the ban on the right player; Info agrees", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 6 * STEP_MS));
  const falcons = teams.falcons;
  const cardId = `mh-team-${falcons.entrantId}`;
  const name = (page: Page) => page.locator(`#${cardId}-name`);

  const page = await spectator(browser, { width: 390 });
  await openTab(page, "teams", `&division=${cricketSlug}`);
  const details = page.getByTestId(cardId);
  await expect(details).toBeAttached();
  expect(await details.evaluate((d) => (d as HTMLDetailsElement).open), "closed before the tap").toBe(false);
  const closed = await visibleChars(name(page));
  console.log(`HB4@390 closed name: ${JSON.stringify(closed)}`);
  expect(closed.chars, "@390 closed: fewer than 12 readable characters of the team name").toBeGreaterThanOrEqual(12);

  const url = page.url();
  await details.locator("summary").click();
  await expect.poll(() => details.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
  expect(page.url(), "opening a card navigates nowhere").toBe(url);
  const lines = details.locator('[data-testid^="mh-team-"][data-testid*="-member-"]:not([data-testid$="-suspended"])');
  await expect(lines).toHaveCount(falcons.order.length);

  const lineFor = async (full: string, shown: string) => {
    const count = await lines.count();
    for (let i = 0; i < count; i++) {
      if ((await lines.nth(i).locator("[title]").first().getAttribute("title")) === shown) return lines.nth(i);
    }
    throw new Error(`no squad line titled "${shown}" (for ${full})`);
  };
  const consenting = await lineFor(falcons.order[0]!, `Ethan Price ${TAG}`);
  await expect(consenting.locator("a")).toHaveAttribute("href", `/shared/${org.slug}/${comp.slug}/players/${falcons.order[0]}`);
  const maskedName = maskDisplayName(masked.name, "first_initial");
  expect(maskedName).not.toBe(masked.name);
  const maskedLine = await lineFor(masked.name, maskedName);
  await expect(maskedLine.locator("a"), "a masked player has no card link").toHaveCount(0);
  await expect(details).not.toContainText(masked.name);

  // HB5: the Suspended tag on exactly the banned player.
  const bannedLine = await lineFor(banned.name, banned.name);
  await expect(bannedLine.locator('[data-testid$="-suspended"]')).toHaveText(dictString("en", "teams.suspended"));
  await expect(details.locator('[data-testid$="-suspended"]'), "one Suspended tag in the squad").toHaveCount(1);

  // 320 open: truncated WITH an ellipsis, still readable.
  await page.setViewportSize({ width: 320, height: 844 });
  const open320 = await visibleChars(name(page));
  console.log(`HB4@320 open name: ${JSON.stringify(open320)}`);
  expect(open320.textOverflow).toBe("ellipsis");
  expect(open320.whiteSpace).toBe("nowrap");
  expect(open320.truncated, "a 43-character name is cut at 320, so the ellipsis is exercised").toBe(true);
  expect(open320.chars).toBeGreaterThanOrEqual(12);
  await expectNoHorizontalScroll(page);

  // 1280 open: the open card spans the grid.
  await page.setViewportSize({ width: 1280, height: 900 });
  const spans = await details.evaluate((d) => {
    const li = d.closest("li")!;
    return { li: li.getBoundingClientRect().width, ul: li.parentElement!.getBoundingClientRect().width };
  });
  console.log(`HB4@1280 open: ${JSON.stringify(spans)}`);
  expect(Math.abs(spans.li - spans.ul), "@1280 an open card spans the whole grid").toBeLessThanOrEqual(1);

  // HB5: Info — the description, and the same ban.
  await openTab(page, "info");
  await expect(page.getByTestId(`mh-info-division-${cricketSlug}-description`)).toHaveText(DESCRIPTION);
  const ban = page.getByTestId(`mh-info-suspension-${cricketSlug}-0`);
  await expect(ban).toContainText(banned.name);
  await expect(ban).toContainText(dictString("en", "info.toServe.other", { count: 2 }));
  await expect(page.getByTestId(`mh-info-suspension-${cricketSlug}-1`)).toHaveCount(0);
});

// HB7 — seven widths × every tab: the tab the URL names opens, nothing scrolls
// sideways, and a tap on a chip's centre lands on it.
test("HB7: at seven phone and tablet widths every tab opens from its URL, with no sideways scroll and hittable chips", async ({
  browser,
}) => {
  const doc = await hubDoc();
  const tabs = doc.tabs.filter((id) => RENDERABLE.has(id));
  test.setTimeout(Math.max(FLOOR_MS, PHONE_WIDTHS.length * tabs.length * TAB_CHECK_MS + STEP_MS));
  const page = await spectator(browser, { width: PHONE_WIDTHS[0] });
  const passed: string[] = [];
  for (const width of PHONE_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    for (const id of tabs) {
      await openTab(page, id);
      await expectNoHorizontalScroll(page);
      const chips = await page
        .locator('[data-testid^="mh-filter-"],[data-testid^="mh-division-"],[data-testid$="-more"]')
        .evaluateAll((els) =>
          els
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
            })
            .map((el) => el.getAttribute("data-testid")!),
        );
      for (const chip of chips.filter((c) => c !== "mh-filters" && c !== "mh-divisions")) {
        await page.getByTestId(chip).scrollIntoViewIfNeeded();
        expect(await centreHits(page, chip), `${id}@${width}: a tap on ${chip} misses it`).toBe(true);
      }
      passed.push(`${id}@${width}(${chips.length})`);
    }
  }
  console.log(`HB7: ${passed.join(" ")}`);
  expect(passed).toHaveLength(PHONE_WIDTHS.length * tabs.length);
});

// HB8 — the phone shows the same controls as the desktop, in the same order;
// the table's column toggle is the one phone-only control.
//
// FALSE PREMISE (inventory HB8, "the ONLY allowed difference is the table
// toggle"): the hero's Present link is `max-md:hidden` by a recorded product
// call (`[competitionSlug]/page.tsx`, the comment on `mh-hero-present`) — the
// kiosk is cast from a ground screen, not a held phone, and the Info tab's
// `mh-info-present` carries the same link at every width. So the hero link is
// the one desktop-only control, and that allowance is only granted when its
// phone twin is really there at 320 with the same href.
test("HB8: Overview, Matches, Table and Teams offer the same controls at 320 as at 1280, bar the table's column toggle and the hero's Present link", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 8 * STEP_MS));
  const doc = await hubDoc();
  const moreIds = doc.tables.map((t) => `mh-table-${t.id}-more`);
  for (const id of ["overview", "matches", "table", "teams"]) {
    const sets: Record<number, string[]> = {};
    for (const width of [320, 1280]) {
      const page = await spectator(browser, { width });
      await openTab(page, id);
      sets[width] = await controlSet(page);
    }
    const phoneOnly = sets[320]!.filter((c) => !sets[1280]!.includes(c));
    console.log(`HB8 ${id}: 320=${JSON.stringify(sets[320])}\n1280=${JSON.stringify(sets[1280])}`);
    // `controlSet` cuts each label at 64 characters, and a view id carries a
    // uuid, so the toggle is matched on its tag plus the cut testid — the
    // `-full` link shares that prefix, but it is an `a`, not a `button`.
    const isToggle = (c: string) => moreIds.some((m) => c === `button:${m.slice(0, 64)}`);
    const isHeroPresent = (c: string) => c.endsWith(":mh-hero-present");
    expect(sets[1280]!.filter(isHeroPresent), `${id}: the hero Present link is offered at 1280`).toHaveLength(1);
    expect(sets[320]!.filter(isHeroPresent), `${id}: the hero Present link folds at 320`).toHaveLength(0);
    expect(
      sets[320]!.filter((c) => !isToggle(c)),
      `${id}: control set 320 vs 1280`,
    ).toEqual(sets[1280]!.filter((c) => !isHeroPresent(c)));
    if (id === "table") {
      expect(phoneOnly.filter(isToggle).length, "the table's column toggle is offered at 320").toBeGreaterThan(0);
    }
  }
  // The allowance above is earned only if the phone can still reach the kiosk.
  const desk = await spectator(browser, { width: 1280 });
  await openTab(desk, "overview");
  const heroHref = await desk.getByTestId("mh-hero-present").getAttribute("href");
  const phone = await spectator(browser, { width: 320 });
  await openTab(phone, "info");
  const infoPresent = phone.getByTestId("mh-info-present");
  await expect(infoPresent, "the Info tab carries the Present link at 320").toBeVisible();
  expect(heroHref, "the hero Present link has an href").toBeTruthy();
  expect(await infoPresent.getAttribute("href"), "the phone's Present link goes where the desktop's does").toBe(heroHref);
  await infoPresent.scrollIntoViewIfNeeded();
  expect(await centreHits(phone, "mh-info-present"), "a tap on the Info tab's Present link hits it").toBe(true);
});

// HB9 — the Table's phone fold: long-tail columns hide at 320 behind a toggle
// that reveals them; the desktop shows them with no toggle.
test("HB9: at 320 the Table folds its long-tail columns behind a toggle that reveals them; at 1280 there is no fold", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 4 * STEP_MS));
  const doc = await hubDoc();
  const view = doc.tables.find((t) => t.divisionSlug === cricketSlug)!;
  const tail = view.columns.find((c) => !c.compact);
  expect(tail, `the cricket table has a long-tail column: ${JSON.stringify(view.columns)}`).toBeTruthy();
  const testid = `mh-table-${view.id}`;

  const phone = await spectator(browser, { width: 320 });
  await openTab(phone, "table", `&division=${cricketSlug}`);
  const header = phone.getByTestId(testid).locator(`th[data-col="${tail!.key}"]`);
  await expect(header).toBeAttached();
  await expect(header, `@320 "${tail!.key}" folded`).toBeHidden();
  await expectNoHorizontalScroll(phone);
  await expect(phone.getByTestId(`${testid}-more`)).toBeVisible();
  await phone.getByTestId(`${testid}-more`).click();
  await expect(header).toBeVisible();
  const scroll = phone.getByTestId(`${testid}-scroll`);
  await expect(scroll).toHaveAttribute("tabindex", "0");
  const overflow = await scroll.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  console.log(`HB9@320 open: ${JSON.stringify(overflow)}`);
  expect(overflow.scroll, "@320 the unfolded table scrolls inside its own region").toBeGreaterThan(overflow.client);
  await expect(phone.getByTestId(`${testid}-full`)).toHaveAttribute("href", view.fullHref);
  // The unfolded page's own no-sideways-scroll check is HB9b, below.

  const desk = await spectator(browser, { width: 1280 });
  await openTab(desk, "table", `&division=${cricketSlug}`);
  await expect(desk.getByTestId(testid).locator(`th[data-col="${tail!.key}"]`)).toBeVisible();
  await expect(desk.getByTestId(`${testid}-more`)).toBeHidden();
});

// HB9b — found by this file's first build (2026-09-17): at 320, tapping the
// Table's "more columns" toggle gave the PAGE a sideways scroll (320 → 388),
// with every visible over-wide box inside the table's own `overflow-x-auto`
// region. The unfolded header cells carry `.sr-only` labels, which are
// `position:absolute`; the region was `position:static`, so their containing
// block was `<body>`, the region's clip never applied to them, and they
// extended the document. Both halves are asserted: the page does not scroll,
// and — independent of fonts and name lengths — no absolutely-positioned box
// in the region is anchored outside it.
test("HB9b: at 320 the unfolded Table has no sideways page scroll, and no label inside it is anchored outside its scroll region", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 2 * STEP_MS));
  const doc = await hubDoc();
  const view = doc.tables.find((t) => t.divisionSlug === cricketSlug)!;
  const testid = `mh-table-${view.id}`;
  const phone = await spectator(browser, { width: 320 });
  await openTab(phone, "table", `&division=${cricketSlug}`);
  await phone.getByTestId(`${testid}-more`).click();
  await expect(phone.getByTestId(`${testid}-more`)).toHaveAttribute("aria-expanded", "true");
  await expect(phone.getByTestId(testid).locator("th.sr-only, th .sr-only").first()).toBeAttached();
  const escapes = await absoluteEscapes(phone, `[data-testid="${testid}-scroll"]`);
  console.log(`HB9b escapes: ${JSON.stringify(escapes)}`);
  expect(escapes, "labels inside the unfolded table anchored outside its scroll region").toEqual([]);
  await expectNoHorizontalScroll(phone);
});

// HB9c — the same defect's twin on the DIVISION page: its Standings table
// (`standings-table.tsx`) wraps its own `overflow-x-auto` region with `.sr-only`
// column words in the header. Measured on the t17 build at 320 on this file's
// cricket division: the page scrolled 80px sideways on the Standings tab with
// no visible culprit.
test("HB9c: at 320 the division page's Standings tab has no sideways page scroll, and no label is anchored outside its scroll region", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 2 * STEP_MS));
  const phone = await spectator(browser, { width: 320 });
  await phone.goto(`/shared/${org.slug}/${comp.slug}/${cricketSlug}?tab=standings`, { waitUntil: "load" });
  const panel = phone.locator("#panel-standings");
  await expect(panel).toBeVisible();
  const scroll = panel.locator("div.overflow-x-auto").filter({ has: phone.locator("table") }).first();
  await expect(scroll.locator(".sr-only").first()).toBeAttached();
  const escapes = await absoluteEscapes(phone, "#panel-standings div.overflow-x-auto");
  console.log(`HB9c escapes: ${JSON.stringify(escapes)}`);
  expect(escapes, "labels inside the division Standings table anchored outside its scroll region").toEqual([]);
  await expectNoHorizontalScroll(phone);
});

// HB9d — the division page with a realistic 43-character entrant name at 320.
// Found on the t17 build (2026-09-17): the Schedule tab's entrant filter
// `<select>` sized itself to its longest option (383px in a 288px column,
// page +79px), and the Entrants tab's card grew to the name instead of
// truncating it (+73px) — a grid item's automatic minimum is its content.
// Asserted two ways: the page does not scroll sideways, and every box whose
// content is wider than it is either a reachable scroll region with a tab
// stop or truncated WITH an ellipsis — never silently clipped (AGENTS.md
// class 23; `overflowingIn` makes that split). The long name is asserted to
// be really truncating, so the case cannot pass on a short name.
test("HB9d: at 320 the division page's Schedule filter and Entrants cards hold a 43-character entrant name without widening or clipping the page", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 3 * STEP_MS));
  const phone = await spectator(browser, { width: 320 });
  const base = `/shared/${org.slug}/${comp.slug}/${cricketSlug}`;
  const expectHeld = async (panel: string) => {
    const { clipped, scrollable, truncatedByDesign } = await overflowingIn(
      phone,
      panel,
      "div,ul,li,p,span,a,button,select,table",
      `${panel} was not in the DOM`,
    );
    console.log(`HB9d ${panel}: clipped=${JSON.stringify(clipped)} scrollable=${JSON.stringify(scrollable)} truncated=${JSON.stringify(truncatedByDesign)}`);
    expect(clipped, `${panel}: content clipped without a scroll region or an ellipsis`).toEqual([]);
    for (const box of scrollable) {
      expect(box, `${panel}: a scrolling box is not keyboard-reachable`).toMatch(/tabindex=0$/);
    }
    await expectNoHorizontalScroll(phone);
  };

  await phone.goto(base, { waitUntil: "load" });
  const filter = phone.locator("#panel-schedule #entrant-filter");
  await expect(filter).toBeVisible();
  await expect(filter.locator("option").filter({ hasText: FALCONS_NAME }), "the filter lists the 43-character name").toHaveCount(1);
  const vw = await phone.evaluate(() => document.documentElement.clientWidth);
  const filterBox = await filter.boundingBox();
  expect(filterBox!.x + filterBox!.width, "the entrant filter ends inside the viewport").toBeLessThanOrEqual(vw);
  await expectHeld("#panel-schedule");

  await phone.goto(`${base}?tab=entrants`, { waitUntil: "load" });
  const card = phone.locator("#panel-entrants li").filter({ hasText: FALCONS_NAME.slice(0, 20) }).first();
  await expect(card).toBeVisible();
  const cardBox = await card.boundingBox();
  expect(cardBox!.x + cardBox!.width, "the long-named entrant card ends inside the viewport").toBeLessThanOrEqual(vw);
  const name = card.locator("p > span").first();
  const naming = await name.evaluate((el) => ({
    text: el.textContent,
    overflow: getComputedStyle(el).textOverflow,
    truncating: el.scrollWidth > el.clientWidth,
  }));
  expect(naming.text, "the card's name span holds the 43-character name").toBe(FALCONS_NAME);
  expect(naming, "the long name is truncated with an ellipsis").toMatchObject({ overflow: "ellipsis", truncating: true });
  await expectHeld("#panel-entrants");
});

/** The height a finger actually gets on the control `selector` matches, walked
 *  with `elementFromPoint` up and down the box's centre line until a point
 *  stops landing on it. A painted box can be taller or shorter than what takes
 *  the tap; this is what takes it. */
async function hitHeight(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  selector: string,
): Promise<number> {
  return page.evaluate(
    ([x, y, sel]) => {
      const onLink = (yy: number) => {
        const el = document.elementFromPoint(x as number, yy);
        return !!el && !!el.closest(sel as string);
      };
      if (!onLink(y as number)) return 0;
      let top = y as number;
      while (top > 0 && onLink(top - 1)) top--;
      let bottom = y as number;
      while (bottom < window.innerHeight - 1 && onLink(bottom + 1)) bottom++;
      return bottom - top + 1;
    },
    [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2), selector] as const,
  );
}

/** The Present link's tap height, the one call shape HB14 makes. */
async function presentHitHeight(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
): Promise<number> {
  return hitHeight(page, box, 'a[href$="/present"]');
}

// HB14 — the division page's header actions ("Present ▸" and the WhatsApp
// share) in the three longer languages. Found on the t17 build (2026-09-17,
// `mobile.spec.ts` P6 at 320): in Spanish the pair was a `shrink-0` row 319px
// wide in a 288px column, 15px past the viewport and cut off by the page's
// overflow clip. Each locale gets its own org (the page speaks the ORG's
// language, set before its first render). At 320 both actions must sit
// inside the viewport and take a tap at their centre; at 768 and 1280 the
// pair keeps its one row beside the heading, which the fix must not change.
test("HB14: the division page's Present and Share actions stay on screen at 320 in es, fr and nl, and keep one row beside the heading from 768", async ({
  browser,
  request,
}) => {
  const locales = ["es", "fr", "nl"] as const;
  const widths = [320, 768, 1280] as const;
  test.setTimeout(Math.max(FLOOR_MS, locales.length * (6 * API_CALL_MS + widths.length * STEP_MS)));
  const lines: string[] = [];
  for (const locale of locales) {
    const langOrg = await mintSpectatorOrg(request, { name: `Hub Header ${locale.toUpperCase()} ${TAG}`, plan: "community", locale });
    const langComp = await publicCompetition(request, { name: `Header Cup ${locale} ${TAG}`, orgId: langOrg.id });
    const langDiv = await division(request, langComp.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const presentName = dictString(locale, "division.present");
    const shareName = uiString(locale, "share.whatsapp");
    for (const width of widths) {
      const page = await spectator(browser, { width });
      await page.goto(`/shared/${langOrg.slug}/${langComp.slug}/${langDiv.slug}`, { waitUntil: "load" });
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      const heading = page.getByRole("heading", { level: 1 });
      const present = page.getByRole("link", { name: presentName, exact: true });
      const share = page.getByRole("button", { name: shareName, exact: true });
      await expect(present, `${locale}@${width}: the Present link`).toBeVisible();
      await expect(share, `${locale}@${width}: the Share button`).toBeVisible();
      const [h, p, s] = await Promise.all([heading.boundingBox(), present.boundingBox(), share.boundingBox()]);
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      lines.push(`${locale}@${width}: h1 ${JSON.stringify(h)} present ${JSON.stringify(p)} share ${JSON.stringify(s)} vw ${vw}`);
      if (width < 768) {
        expect(p!.x + p!.width, `${locale}@${width}: the Present link ends inside the viewport`).toBeLessThanOrEqual(vw);
        expect(s!.x + s!.width, `${locale}@${width}: the Share button ends inside the viewport`).toBeLessThanOrEqual(vw);
        for (const [what, box, target] of [
          ["Present", p!, 'a[href$="/present"]'],
          ["Share", s!, `button[aria-label="${shareName}"]`],
        ] as const) {
          const hit = await page.evaluate(
            ([x, y, sel]) => {
              const el = document.elementFromPoint(x as number, y as number);
              return !!el && !!el.closest(sel as string);
            },
            [box.x + box.width / 2, box.y + box.height / 2, target] as const,
          );
          expect(hit, `${locale}@${width}: a tap on ${what} lands on it`).toBe(true);
        }
        // The Present link's TAP height, read the way a finger meets it: walk
        // `elementFromPoint` up and down its centre line until a point stops
        // landing on the link. A painted box can be taller or shorter than
        // what takes the tap; this is what takes it.
        const presentHit = await presentHitHeight(page, p!);
        lines.push(`${locale}@${width}: Present hit height ${presentHit}px`);
        expect(presentHit, `${locale}@${width}: the Present link takes a tap over ${HIT_TARGET_FLOOR_PX}px`).toBeGreaterThanOrEqual(
          HIT_TARGET_FLOOR_PX,
        );
        await expectNoHorizontalScroll(page);
      } else {
        const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
        expect(Math.abs(mid(p!) - mid(s!)), `${locale}@${width}: Present and Share share one row`).toBeLessThanOrEqual(4);
        expect(p!.y, `${locale}@${width}: the actions sit beside the heading, not under it`).toBeLessThan(h!.y + h!.height);
        expect(s!.x + s!.width, `${locale}@${width}: the actions end inside the viewport`).toBeLessThanOrEqual(vw);
        // The pointer layout keeps its compact pill: the phone's 44px floor
        // must not have leaked up to the desktop look.
        const presentHit = await presentHitHeight(page, p!);
        lines.push(`${locale}@${width}: Present hit height ${presentHit}px`);
        expect(p!.height, `${locale}@${width}: the Present pill keeps its compact desktop height`).toBeLessThan(HIT_TARGET_FLOOR_PX);
        expect(presentHit, `${locale}@${width}: the Present link still takes a tap at its centre`).toBeGreaterThan(0);
      }
    }
  }
  console.log(`HB14:\n${lines.join("\n")}`);
});

// HB15 — the two tap targets the W2 contact sheet caught under the 44px floor
// (owner approved 2026-09-17; sheet ids img-115/116 and img-135): the standings
// table's "Full division" link (`standings-table-view.tsx`) and the division
// page's results-grid toggle (`[divisionSlug]/page.tsx`). Both were plain text
// controls whose box WAS the line box — about 16px tall — so a class scan
// cannot witness the fix (AGENTS.md: a class present is not a class in effect,
// and a `min-h` on a control whose display is `inline` does nothing at all).
// Measured two ways at 320: the box `boundingBox()` paints, and the height a
// finger actually gets from `elementFromPoint`, which is what takes the tap.
test("HB15: the Full division link and the results-grid toggle each clear the 44px tap floor at 320", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 4 * STEP_MS));
  const page = await spectator(browser, { width: 320 });

  await openTab(page, "table");
  const full = page.locator('[data-testid^="mh-table-"][data-testid$="-full"]').first();
  await expect(full, "the Table tab shows a Full division link").toBeVisible();
  const fullTestid = await full.getAttribute("data-testid");
  const fullBox = (await full.boundingBox())!;
  expect(fullBox.height, `the Full division link's painted box is ${fullBox.height}px tall`).toBeGreaterThanOrEqual(
    HIT_TARGET_FLOOR_PX,
  );
  expect(
    await hitHeight(page, fullBox, `[data-testid="${fullTestid}"]`),
    "the Full division link takes a tap over the whole floor",
  ).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);

  // `?tab=standings` is part of the PREMISE, not decoration: the division page
  // opens on Schedule (`tabs.tsx` — an absent or unknown `?tab=` falls through
  // to the first panel) and the other panels render `hidden`, so the results
  // grid is in the markup and invisible. CI caught exactly that, with the
  // locator RESOLVED and "Received: hidden"; a local run that read green had
  // skipped this test behind an earlier serial failure.
  await page.goto(`/shared/${org.slug}/${comp.slug}/${genericSlug}?tab=standings`, { waitUntil: "load" });
  await expect(page.locator("#panel-standings"), "?tab=standings opens the Standings panel").toBeVisible();
  const toggle = page
    .locator("summary")
    .filter({ hasText: dictString("en", "division.resultsGrid") })
    .first();
  await expect(toggle, "the division page shows the results-grid toggle").toBeVisible();
  const toggleBox = (await toggle.boundingBox())!;
  expect(toggleBox.height, `the results-grid toggle's painted box is ${toggleBox.height}px tall`).toBeGreaterThanOrEqual(
    HIT_TARGET_FLOOR_PX,
  );
  expect(
    await hitHeight(page, toggleBox, "summary"),
    "the results-grid toggle takes a tap over the whole floor",
  ).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
  await expectNoHorizontalScroll(page);
});

// HB10 — a completed card's result sentence is the match centre's.
test("HB10: a completed card's result sentence equals the match centre's status line", async ({ browser }) => {
  test.setTimeout(Math.max(FLOOR_MS, 3 * STEP_MS));
  const page = await spectator(browser, { width: 390 });
  await openTab(page, "matches");
  await page.getByTestId("mh-filter-completed").click();
  const result = page.getByTestId(`mh-match-${genericDone}`).getByTestId("mh-match-result");
  await expect(result).toBeVisible();
  const cardText = (await result.textContent())!.trim();
  await page.goto(`/shared/${org.slug}/${comp.slug}/${genericSlug}/fixtures/${genericDone}`);
  const status = page.getByTestId("mc-status-line");
  await expect(status).toBeVisible();
  console.log(`HB10 card="${cardText}" centre="${(await status.textContent())?.trim()}"`);
  expect(cardText.length).toBeGreaterThan(0);
  await expect(status).toHaveText(cardText);
});

// HB11 — "times in …" appears only to a viewer outside the venue's zone.
test("HB11: the Matches day caption appears for a viewer in another zone and not for one in the venue's zone", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 4 * STEP_MS));
  const doc = await hubDoc();
  const upcoming = doc.matches.filter((m) => m.bucket === "upcoming" && m.scheduledAt);
  const venueZone = upcoming[0]!.tz;
  const elsewhere = venueZone === "Pacific/Auckland" ? "America/Los_Angeles" : "Pacific/Auckland";
  const caption = (page: Page) =>
    page.locator('[data-testid^="mh-day-"]').getByText(new RegExp(`^${dictString("en", "matchesHub.timesIn", { tz: "\\S.*" })}$`));

  const home = await spectator(browser, { width: 390, timezoneId: venueZone });
  await openTab(home, "matches");
  await expect(home.locator('[data-testid^="mh-day-"]').first()).toBeVisible();
  await expect(home.getByTestId("mh-root")).toBeVisible();
  await expect(caption(home), `a viewer in ${venueZone} sees no zone caption`).toHaveCount(0);

  const away = await spectator(browser, { width: 390, timezoneId: elsewhere });
  await openTab(away, "matches");
  const first = away.locator('[data-testid^="mh-day-"]').first();
  const firstKey = (await first.getAttribute("data-testid"))!;
  const firstMatch = upcoming.find((m) => firstKey.includes(m.scheduledAt!.slice(0, 10))) ?? upcoming[0]!;
  const expected = dictString("en", "matchesHub.timesIn", { tz: fmtPublicZoneAbbrev("en", venueZone, firstMatch.scheduledAt) });
  await expect(first.getByText(expected, { exact: true }), `a viewer in ${elsewhere} is told the venue's zone`).toBeVisible();
  console.log(`HB11 venue=${venueZone} elsewhere=${elsewhere} caption="${expected}" groups=${await away.locator('[data-testid^="mh-day-"]').count()}`);
});

// HB12 — axe at 320: no serious or critical violation on the hub's tabs (with
// the fold and a card open) or on a player's card.
test("HB12: axe finds no serious or critical violation at 320 on Overview, Matches, Table, Teams and a player's card", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 8 * STEP_MS));
  const page = await spectator(browser, { width: 320 });
  const doc = await hubDoc();
  const view = doc.tables.find((t) => t.divisionSlug === cricketSlug)!;
  const scan = async (label: string) => {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const bad = results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
    console.log(`HB12 ${label}: ${bad.length} serious/critical ${JSON.stringify(bad)}`);
    expect(bad, `${label}: serious/critical axe violations`).toEqual([]);
  };
  await openTab(page, "overview");
  await scan("overview");
  await openTab(page, "matches");
  await scan("matches");
  await openTab(page, "table", `&division=${cricketSlug}`);
  await page.getByTestId(`mh-table-${view.id}-more`).click();
  await scan("table, fold open");
  await openTab(page, "teams", `&division=${cricketSlug}`);
  await page.getByTestId(`mh-team-${teams.falcons.entrantId}`).locator("summary").click();
  await scan("teams, card open");
  await page.goto(`/shared/${org.slug}/${comp.slug}/players/${teams.ospreys.order[0]}`);
  await expect(page.getByTestId("mh-player-matches")).toBeVisible();
  await scan("player card");
});

// HB13 — the owner's capture matrix, to this run's output (not committed):
// each state asserted before its shot, every file present, adjacent states
// differing.
test("HB13: screens of every tab state and a player card at 320, 390, 768, 1024 and 1280", async ({ browser }, testInfo) => {
  const doc = await hubDoc();
  const view = doc.tables.find((t) => t.divisionSlug === cricketSlug)!;
  const states: { name: string; open: (page: Page) => Promise<void> }[] = [
    { name: "overview", open: (p) => openTab(p, "overview") },
    { name: "matches-upcoming", open: async (p) => {
      await openTab(p, "matches");
      await expect(p.getByTestId("mh-filter-upcoming")).toHaveAttribute("aria-pressed", "true");
    } },
    { name: "matches-completed", open: async (p) => {
      await openTab(p, "matches");
      await p.getByTestId("mh-filter-completed").click();
      await expect(p.getByTestId("mh-filter-completed")).toHaveAttribute("aria-pressed", "true");
    } },
    { name: "table-open", open: async (p) => {
      await openTab(p, "table", `&division=${cricketSlug}`);
      const more = p.getByTestId(`mh-table-${view.id}-more`);
      if (await more.isVisible()) {
        await more.click();
        await expect(more).toHaveAttribute("aria-expanded", "true");
      }
    } },
    { name: "stats", open: (p) => openTab(p, "stats") },
    { name: "teams-open", open: async (p) => {
      await openTab(p, "teams", `&division=${cricketSlug}`);
      const details = p.getByTestId(`mh-team-${teams.falcons.entrantId}`);
      await details.locator("summary").click();
      await expect.poll(() => details.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
    } },
    { name: "info", open: (p) => openTab(p, "info") },
    { name: "player", open: async (p) => {
      await p.goto(`/shared/${org.slug}/${comp.slug}/players/${teams.ospreys.order[0]}`);
      await expect(p.locator('[data-slab="true"]')).toBeVisible();
    } },
  ];
  test.setTimeout(Math.max(FLOOR_MS, states.length * SCREEN_WIDTHS.length * SHOT_STATE_MS));
  const dir = testInfo.outputPath("hub-screens");
  await shootStates(browser, dir, states);
  expectDistinctShots(dir, states.map((st) => st.name));
  // The LIVE states (Matches on Live, Overview's Live now rail) are shot in
  // HB2 before it ends match A: by this test nothing on the hub is live.
  console.log(`HB13: ${states.length * SCREEN_WIDTHS.length} screens in ${dir}`);
});
