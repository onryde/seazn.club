// Spectator W2 (4/4), Task 17 — the player card, as a spectator sees it.
//
// Owner-approved inventory 2026-09-16 (PP1–PP5), with the rulings made after it:
//   - A REFUSED card is its own not-found page, "This player page isn't
//     available", in the ORG's language. Never consented, player pages not in
//     the plan, and no such person are indistinguishable. Driven here as the
//     page Next actually serves (status 404), at es and en, for all three.
//   - A card link follows `playerLinkId` alone. On a FREE plan (player stats
//     granted, player pages not) the hub's Stats leaders, the hub's Teams and
//     the division page's Entrants show plain names — and the Pro pair links.
//   - An organiser's consent revoke clears for a FRESH visitor within the
//     player-toggle bar (15s). A page already open keeps the old lines until
//     reload (accepted), so every probe here is a new navigation. Never an
//     instant change: each probe polls, bounded by the bar.
//   - The slab-move case (PP2) waits out the idle cadence (accepted).
//   - Entitlements may be served stale for five minutes: every plan is set
//     before the first public read, never flipped mid-file.
//   - PP4b (SHOULD: a division youth / `player_name_display` change masks the
//     same surfaces) is not in this file. Both tennis divisions seat the same
//     Priya and Quinn and PP4 revokes Quinn, so after PP4 the case proves
//     nothing, and before it the case would have to restore the policy and
//     re-prove full names inside PP4's own before-state — a second PP4, not a
//     cheap sibling. The retire it would witness is unit-pinned
//     (`division-writes-player-matches-cache.test.ts`).
//
// Seeded on the shared Pro org (player pages are Pro-gated), one competition:
//   cricket   PP1 — a batter's live slab moves on a real API write
//   generic   PP2 — the slab moves to a match that goes live; also the Pro
//             half of the link pair, and a never-consented member (en 404)
//   tennis A  PP3/PP4 — P home v Q, the same point script by P's side …
//   tennis B  … as tennis A with P away: the mirror is the oracle
//   badminton PP5 — a long set-based line at 320
// and three dedicated orgs: EN Community (free-plan links, en entitlement
// 404), ES Pro (es never-consented and unknown 404) and ES Community (es
// entitlement 404).
//
// Serial with the seed as test 1 (AGENTS.md #21: a red count is a floor).
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { maskDisplayName } from "../../src/lib/name-display";
import { apiJson, expectNoHorizontalScroll, TAG } from "../helpers";
import {
  closeOpenContexts,
  makeCricketDivision,
  makeTeams,
  mustPost,
  startCricketMatch,
  type Team,
} from "../spectator-public-helpers";
import {
  anonymousRequest,
  API_CALL_MS,
  activeOrgSlug,
  awaitStatsFold,
  CONSENT_CLEAR_BAR_MS,
  dictString,
  division,
  entrants,
  eventStream,
  expectDistinctShots,
  FLOOR_MS,
  LAND_SLACK_MS,
  leagueFixtures,
  lineUpOnPoll,
  mintSpectatorOrg,
  noReloadGuard,
  person,
  primeBrowserCache,
  publicCompetition,
  publicJson,
  scheduleFixture,
  SCREEN_WIDTHS,
  SHOT_STATE_MS,
  shootInPlace,
  spectator,
  statsFoldLandMs,
  STEP_MS,
  w2Clock,
  type FixtureRow,
  type MintedOrg,
} from "../spectator-w2-kit";

test.describe.configure({ mode: "serial" });
test.afterEach(closeOpenContexts);

/** One scripted event write (a tennis point, a badminton rally) — a single
 *  POST with no state read, far cheaper than a seeding call. */
const EVENT_POST_MS = 400;

const GENERIC = { sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } };

interface PlayerLine {
  fixtureId: string;
  line: string;
  tz: string;
  scheduledAt: string | null;
  result: string | null;
}

let pro: MintedOrg;
let comp = { id: "", slug: "" };

// PP1 — cricket
let cricketFixture = "";
let batter = "";
let cricketPair = { nonStriker: "", bowler: "" };

// PP2 — generic; also the Pro link pair and the en never-consented person
let genericDiv = { id: "", slug: "" };
let xavier = { id: "", name: "" };
let xavierTeam = "";
let f1 = "";
let f2 = "";
let neverConsented = "";

// PP3/PP4 — tennis
let priya = { id: "", name: "" };
let quinn = { id: "", name: "" };
let tennisA = { fixtureId: "", divSlug: "", quinnEntrant: "" };
let tennisB = { fixtureId: "", divSlug: "" };

// PP5 — badminton
let nadia = { id: "", name: "" };
let longRow = { fixtureId: "", opponent: "" };
let longSlab = { fixtureId: "", opponent: "" };

// Dedicated orgs
let free: MintedOrg;
let freeComp = { id: "", slug: "" };
let freeDiv = { id: "", slug: "" };
let freeTeams: { entrantId: string; members: { id: string; name: string }[] }[] = [];
let esPro: MintedOrg;
let esProComp = { id: "", slug: "" };
let esConsenting = "";
let esNeverConsented = "";
let esFree: MintedOrg;
let esFreeComp = { id: "", slug: "" };
let esFreeConsenting = "";

const TENNIS_POINTS = 2 * 115;
const BADMINTON_RALLIES = 96 + 116;
const SEED_CALLS = 180;

const P = "P";
const Q = "Q";
const point = (by: string) => [by];
const game = (by: string) => [by, by, by, by];
const games = (...winners: string[]) => winners.flatMap(game);
/** Set 1 6–4 to P; set 2 to 6–6, then Q takes the tiebreak 7–5; P leads the
 *  third 2–1 at 30–15. The shape of `public-player-matches.test.ts`'s
 *  `tennisTwoSets`: asymmetric, so a side-blind line cannot pass PP3. */
const TENNIS_SCRIPT = [
  ...games(P, Q, P, Q, P, Q, P, Q, P, P),
  ...games(P, Q, P, Q, P, Q, P, Q, P, Q, P, Q),
  ...[P, Q, P, Q, P, Q, P, Q, P, Q, Q, Q].flatMap(point),
  ...games(P, Q, P),
  ...[P, P, Q].flatMap(point),
];

const repeat = (n: number, by: string) => Array.from({ length: n }, () => by);
const N = "N";
const O = "O";
/** Badminton by Nadia's side: 21–15 and 19–21 closed, 11–9 open. */
const BADMINTON_LIVE = [...repeat(15, O), ...repeat(21, N), ...repeat(19, N), ...repeat(21, O), ...repeat(11, N), ...repeat(9, O)];
/** 21–15, 19–21, 21–19: decided to Nadia. */
const BADMINTON_DONE = [...repeat(15, O), ...repeat(21, N), ...repeat(19, N), ...repeat(21, O), ...repeat(19, O), ...repeat(21, N)];

function sidesOf(row: FixtureRow): [string, string] {
  return [row.home_entrant_id!, row.away_entrant_id!];
}

function involving(rows: FixtureRow[], entrantId: string): FixtureRow[] {
  return rows.filter((r) => r.home_entrant_id === entrantId || r.away_entrant_id === entrantId);
}

function opponentOf(row: FixtureRow, entrantId: string): string {
  return row.home_entrant_id === entrantId ? row.away_entrant_id! : row.home_entrant_id!;
}

test("setup: a Pro competition with cricket, generic, two tennis and badminton divisions, plus three dedicated orgs", async ({
  request,
}) => {
  // A read folds nothing: two scheduled stats folds are waited for below
  // (`awaitStatsFold`), each before any hub render so the Stats tab exists.
  const foldMs = statsFoldLandMs() + LAND_SLACK_MS;
  test.setTimeout(
    Math.max(FLOOR_MS, SEED_CALLS * API_CALL_MS + (TENNIS_POINTS + BADMINTON_RALLIES) * EVENT_POST_MS + 2 * foldMs),
  );
  pro = await activeOrgSlug(request);
  comp = await publicCompetition(request, { name: `Player Cards ${TAG}`, orgId: pro.id });

  // --- cricket (PP1) -----------------------------------------------------------
  const cricketDivId = await makeCricketDivision(request, comp.id, {
    name: `Cricket ${TAG}`,
    ballsPerInnings: 12,
    playersPerSide: 4,
  });
  const [kestrels, ospreys] = (await makeTeams(request, cricketDivId, [
    { name: `Kestrels ${TAG}`, names: ["Arjun Mehta", "Rohan Pillai", "Kabir Sethi", "Dev Anand"].map((n) => `${n} ${TAG}`) },
    { name: `Ospreys ${TAG}`, names: ["Liam Walsh", "Noah Byrne", "Owen Doyle", "Ciaran Kelly"].map((n) => `${n} ${TAG}`) },
  ])) as [Team, Team];
  const [cricketRow] = await leagueFixtures(request, cricketDivId);
  cricketFixture = cricketRow!.id;
  await scheduleFixture(request, cricketFixture, "2030-06-01T14:00:00Z");
  const batting = cricketRow!.home_entrant_id === kestrels.entrantId ? kestrels : ospreys;
  const bowling = batting === kestrels ? ospreys : kestrels;
  await startCricketMatch(request, cricketFixture, [kestrels, ospreys], batting);
  // Two even-run balls: the striker never changes ends, so the batter under
  // test is still on strike when PP1 hits the boundary.
  batter = batting.order[0]!;
  cricketPair = { nonStriker: batting.order[1]!, bowler: bowling.order[0]! };
  for (const [ballInOver, bat] of [
    [1, 0],
    [2, 2],
  ] as const) {
    await mustPost(request, cricketFixture, "cricket.ball", {
      over: 0,
      ballInOver,
      striker: batter,
      nonStriker: cricketPair.nonStriker,
      bowler: cricketPair.bowler,
      runs: { bat },
    });
  }

  // --- generic (PP2, the Pro link pair, the en never-consented person) --------
  genericDiv = await division(request, comp.id, { name: `League ${TAG}`, ...GENERIC });
  const xName = `Xavier Okafor ${TAG}`;
  const xId = await person(request, xName, true);
  xavier = { id: xId, name: xName };
  const yId = await person(request, `Yusuf Adeyemi ${TAG}`, true);
  const t1 = [await person(request, `Mateo Rossi ${TAG}`, true), await person(request, `Luca Bianchi ${TAG}`, true)];
  neverConsented = await person(request, `Hidden Hartley ${TAG}`, false);
  const t2 = [await person(request, `Emil Larsen ${TAG}`, true), neverConsented];
  const genericEntrants = await entrants(request, genericDiv.id, [
    { kind: "team", name: `Harbour Rovers ${TAG}`, members: [xId, yId] },
    { kind: "team", name: `Quarry Athletic ${TAG}`, members: t1 },
    { kind: "team", name: `Mill Lane United ${TAG}`, members: t2 },
  ]);
  xavierTeam = genericEntrants[0]!;
  const genericRows = await leagueFixtures(request, genericDiv.id);
  const xRows = involving(genericRows, xavierTeam);
  expect(xRows, "Xavier's team plays two league matches").toHaveLength(2);
  [f1, f2] = [xRows[0]!.id, xRows[1]!.id];
  await scheduleFixture(request, f1, "2030-05-01T10:00:00Z");
  await scheduleFixture(request, f2, "2030-05-08T10:00:00Z");
  {
    const s = await eventStream(request, f1);
    const opp = opponentOf(xRows[0]!, xavierTeam);
    await s.post("core.start", {});
    await s.post("generic.score", { by: xavierTeam, points: 3, person: xId });
    await s.post("generic.score", { by: opp, points: 1 });
    await s.post("generic.result", {});
  }

  // --- tennis A and B (PP3, PP4) ------------------------------------------------
  priya = { id: "", name: `Priya Natarajan ${TAG}` };
  quinn = { id: "", name: `Quinn Montgomery ${TAG}` };
  priya.id = await person(request, priya.name, true);
  quinn.id = await person(request, quinn.name, true);
  for (const which of ["A", "B"] as const) {
    const div = await division(request, comp.id, { name: `Tennis ${which} ${TAG}`, sport_key: "tennis", variant_key: "tour" });
    const rows = [
      { kind: "individual" as const, name: priya.name, members: [priya.id] },
      { kind: "individual" as const, name: quinn.name, members: [quinn.id] },
    ];
    const [pEntrant, qEntrant] = await entrants(request, div.id, which === "A" ? rows : [rows[1]!, rows[0]!]).then((ids) =>
      which === "A" ? ids : [ids[1]!, ids[0]!],
    );
    const [row] = await leagueFixtures(request, div.id);
    const [home, away] = sidesOf(row!);
    // The premise PP3 rests on: Priya is HOME in A and AWAY in B. If the
    // generator ever stops seating seed 1 at home, this says so here rather
    // than letting PP3 compare two home lines and pass on nothing.
    if (which === "A") expect([home, away], "tennis A: Priya home").toEqual([pEntrant, qEntrant]);
    else expect([home, away], "tennis B: Priya away").toEqual([qEntrant, pEntrant]);
    await scheduleFixture(request, row!.id, which === "A" ? "2030-06-10T09:00:00Z" : "2030-06-11T09:00:00Z");
    const s = await eventStream(request, row!.id);
    await s.post("core.start", {});
    for (const by of TENNIS_SCRIPT) await s.post("tennis.point", { by: by === P ? pEntrant : qEntrant });
    if (which === "A") tennisA = { fixtureId: row!.id, divSlug: div.slug, quinnEntrant: qEntrant! };
    else tennisB = { fixtureId: row!.id, divSlug: div.slug };
  }

  // --- badminton (PP5) ----------------------------------------------------------
  const long = (base: string) => `${base} ${TAG}`.padEnd(43, "x").slice(0, 43);
  nadia = { id: "", name: `Nadia Kowalczyk ${TAG}` };
  nadia.id = await person(request, nadia.name, true);
  const o1 = long("Aleksandra Wisniewska-Konstantynowicz");
  const o2 = long("Bartholomew Featherstonehaugh-Smythe");
  expect([o1.length, o2.length]).toEqual([43, 43]);
  const badDiv = await division(request, comp.id, { name: `Badminton ${TAG}`, sport_key: "badminton", variant_key: "bwf" });
  const [nEntrant, o1Entrant, o2Entrant] = await entrants(request, badDiv.id, [
    { kind: "individual", name: nadia.name, members: [nadia.id] },
    { kind: "individual", name: o1, members: [await person(request, o1, true)] },
    { kind: "individual", name: o2, members: [await person(request, o2, true)] },
  ]);
  const badRows = involving(await leagueFixtures(request, badDiv.id), nEntrant!);
  const vsO1 = badRows.find((r) => opponentOf(r, nEntrant!) === o1Entrant)!;
  const vsO2 = badRows.find((r) => opponentOf(r, nEntrant!) === o2Entrant)!;
  await scheduleFixture(request, vsO2.id, "2030-07-01T18:00:00Z");
  await scheduleFixture(request, vsO1.id, "2030-07-08T18:00:00Z");
  for (const [row, script, opp] of [
    [vsO2, BADMINTON_DONE, o2Entrant],
    [vsO1, BADMINTON_LIVE, o1Entrant],
  ] as const) {
    const s = await eventStream(request, row.id);
    await s.post("core.start", {});
    for (const by of script) await s.post("badminton.rally", { wonBy: by === N ? nEntrant : opp });
  }
  longRow = { fixtureId: vsO2.id, opponent: o2 };
  longSlab = { fixtureId: vsO1.id, opponent: o1 };

  await awaitStatsFold(pro.slug, comp.slug, genericDiv.slug, foldMs);

  // --- EN Community: free-plan links, en entitlement refusal --------------------
  free = await mintSpectatorOrg(request, { name: `Spectator Free EN ${TAG}`, plan: "community" });
  freeComp = await publicCompetition(request, { name: `Free Cup ${TAG}`, orgId: free.id });
  freeDiv = await division(request, freeComp.id, { name: `Free League ${TAG}`, ...GENERIC });
  const freeRoster = [
    [`Grace Mbeki ${TAG}`, `Hana Sato ${TAG}`],
    [`Ines Duarte ${TAG}`, `Julia Novak ${TAG}`],
  ];
  const freeIds: string[][] = [];
  for (const names of freeRoster) freeIds.push([await person(request, names[0]!, true), await person(request, names[1]!, true)]);
  const freeEntrants = await entrants(request, freeDiv.id, [
    { kind: "team", name: `Free North ${TAG}`, members: freeIds[0]! },
    { kind: "team", name: `Free South ${TAG}`, members: freeIds[1]! },
  ]);
  freeTeams = freeEntrants.map((entrantId, i) => ({
    entrantId,
    members: freeRoster[i]!.map((name, j) => ({ id: freeIds[i]![j]!, name })),
  }));
  const [freeRow] = await leagueFixtures(request, freeDiv.id);
  {
    const s = await eventStream(request, freeRow!.id);
    await s.post("core.start", {});
    await s.post("generic.score", { by: freeEntrants[0], points: 2, person: freeIds[0]![0] });
    await s.post("generic.score", { by: freeEntrants[1], points: 1, person: freeIds[1]![0] });
    await s.post("generic.result", {});
  }
  await awaitStatsFold(free.slug, freeComp.slug, freeDiv.slug, foldMs);

  // --- ES Pro: es never-consented and unknown ------------------------------------
  esPro = await mintSpectatorOrg(request, { name: `Spectator Jugadores ${TAG}`, plan: "pro", locale: "es" });
  esProComp = await publicCompetition(request, { name: `Copa Jugadores ${TAG}`, orgId: esPro.id });
  const esDiv = await division(request, esProComp.id, { name: `Liga ${TAG}`, ...GENERIC });
  esConsenting = await person(request, `Carmen Ortega ${TAG}`, true);
  esNeverConsented = await person(request, `Diego Navarro ${TAG}`, false);
  await entrants(request, esDiv.id, [
    { kind: "individual", name: `Carmen Ortega ${TAG}`, members: [esConsenting] },
    { kind: "individual", name: `Diego Navarro ${TAG}`, members: [esNeverConsented] },
  ]);

  // --- ES Community: es entitlement refusal ---------------------------------------
  esFree = await mintSpectatorOrg(request, { name: `Spectator Gratis ${TAG}`, plan: "community", locale: "es" });
  esFreeComp = await publicCompetition(request, { name: `Copa Gratis ${TAG}`, orgId: esFree.id });
  const esFreeDiv = await division(request, esFreeComp.id, { name: `Liga Gratis ${TAG}`, ...GENERIC });
  esFreeConsenting = await person(request, `Elena Vidal ${TAG}`, true);
  await entrants(request, esFreeDiv.id, [
    { kind: "individual", name: `Elena Vidal ${TAG}`, members: [esFreeConsenting] },
    { kind: "individual", name: `Farah Haddad ${TAG}`, members: [await person(request, `Farah Haddad ${TAG}`, true)] },
  ]);

  console.log(
    `seeded: pro=${pro.slug}/${comp.slug} batter=${batter} xavier=${xavier.id} priya=${priya.id} quinn=${quinn.id} nadia=${nadia.id} free=${free.slug} esPro=${esPro.slug} esFree=${esFree.slug}`,
  );
});

// Restore the organiser's revoke (PP4) whatever happened — idempotent, errors
// swallowed, never a `finally` (a timeout skips it).
test.afterAll(async ({ request }) => {
  if (!quinn.id) return;
  await apiJson(request, `/api/v1/persons/${quinn.id}`, "PATCH", { consent: { public_name: true } }).catch(() => null);
});

const cardPath = (orgSlug: string, compSlug: string, personId: string) =>
  `/shared/${orgSlug}/${compSlug}/players/${personId}`;
const matchesApi = (orgSlug: string, compSlug: string, personId: string) =>
  `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/players/${personId}/matches`;

async function endpointLines(orgSlug: string, compSlug: string, personId: string): Promise<PlayerLine[]> {
  const res = await publicJson<{ matches: PlayerLine[] }>(matchesApi(orgSlug, compSlug, personId));
  expect(res.status, `player matches endpoint for ${personId}`).toBe(200);
  return res.data!.matches;
}

function figures(page: Page, fixtureId: string) {
  return page.getByTestId(`mh-player-match-${fixtureId}`).locator('[data-testid$="-figures"]');
}

async function figureText(page: Page, fixtureId: string): Promise<string> {
  return ((await figures(page, fixtureId).textContent()) ?? "").replace(/\s+/g, " ").trim();
}

const BATTING = /^(\d+) \((\d+)\)/;

// PP1 — R10 through a REAL API write: a batter's page is open mid-match; they
// hit a four and the big number on the dark card moves without a refresh.
test("PP1: a boundary posted through the API moves the batter's live slab figure in place", async ({ browser, request }, testInfo) => {
  const clock = w2Clock();
  const lineUpMs = clock.hubPollMs + STEP_MS;
  const landMs = clock.hubPollMs + LAND_SLACK_MS;
  test.setTimeout(
    Math.max(FLOOR_MS, 2 * STEP_MS + lineUpMs + 3 * API_CALL_MS + landMs + 2 * SCREEN_WIDTHS.length * SHOT_STATE_MS),
  );

  const page = await spectator(browser, { width: 390 });
  await page.goto(cardPath(pro.slug, comp.slug, batter));
  const slab = page.locator('[data-slab="true"]');
  await expect(slab).toHaveAttribute("data-testid", `mh-player-match-${cricketFixture}`);
  await expect(slab.getByTestId("mh-player-slab-live")).toBeVisible();
  await expect(slab.getByTestId("mh-player-updated-at")).toBeVisible();

  const before = await figureText(page, cricketFixture);
  const m0 = BATTING.exec(before);
  expect(m0, `the batter's slab reads runs (balls): "${before}"`).not.toBeNull();
  const [runs0, balls0] = [Number(m0![1]), Number(m0![2])];
  const samePage = await noReloadGuard(page);

  // The owner's capture matrix: the player's LIVE slab, on this page, before and
  // after the boundary (HB13 shoots a finished card).
  const shots = testInfo.outputPath("player-live-screens");
  await shootInPlace(page, shots, {
    name: "player-live-slab",
    open: async () => {
      await expect(slab.getByTestId("mh-player-slab-live")).toBeVisible();
      expect(await figureText(page, cricketFixture)).toBe(before);
      await slab.scrollIntoViewIfNeeded();
    },
  });

  // English dates are day-month, in the fixture's own zone (owner ruling).
  const [line0] = (await endpointLines(pro.slug, comp.slug, batter)).filter((l) => l.fixtureId === cricketFixture);
  expect(line0?.scheduledAt, "the cricket fixture is scheduled").toBeTruthy();
  const dateOpts: Intl.DateTimeFormatOptions = { timeZone: line0!.tz, weekday: "short", day: "numeric", month: "short" };
  const gb = new Intl.DateTimeFormat("en-GB", dateOpts).format(new Date(line0!.scheduledAt!));
  const us = new Intl.DateTimeFormat("en-US", dateOpts).format(new Date(line0!.scheduledAt!));
  expect(gb, "the en-GB and en-US shapes must differ, or the date check proves nothing").not.toBe(us);
  await expect(slab.locator("span.shrink-0.text-xs")).toHaveText(gb);

  const api = matchesApi(pro.slug, comp.slug, batter);
  expect(await lineUpOnPoll(page, api, lineUpMs), "the open card never polled its matches").toBe(true);
  await primeBrowserCache(page, api);

  await mustPost(request, cricketFixture, "cricket.ball", {
    over: 0,
    ballInOver: 3,
    striker: batter,
    nonStriker: cricketPair.nonStriker,
    bowler: cricketPair.bowler,
    runs: { bat: 4 },
    boundary: 4,
  });

  await expect
    .poll(async () => BATTING.exec(await figureText(page, cricketFixture))?.slice(1, 3).map(Number), {
      message: "the boundary never reached the open card",
      timeout: landMs,
    })
    .toEqual([runs0 + 4, balls0 + 1]);
  const after = await figureText(page, cricketFixture);
  const [line1] = (await endpointLines(pro.slug, comp.slug, batter)).filter((l) => l.fixtureId === cricketFixture);
  console.log(`PP1: "${before}" -> "${after}"; endpoint "${line1?.line}"`);
  expect(after, "the card and the endpoint are two readers of one line").toBe(line1!.line);
  await samePage("after the boundary");

  await shootInPlace(page, shots, {
    name: "player-live-slab-after-boundary",
    open: async () => {
      await expect(slab.getByTestId("mh-player-slab-live")).toBeVisible();
      expect(await figureText(page, cricketFixture)).toBe(after);
      await slab.scrollIntoViewIfNeeded();
    },
  });
  expectDistinctShots(shots, ["player-live-slab", "player-live-slab-after-boundary"]);
  await samePage("after the screens");
});

// PP2 — the slab MOVES: a player's card shows last week's win on the dark card;
// their next match starts and the card becomes that match, last week's win
// drops into the list; when it ends, the result lands inside one live interval.
test("PP2: the slab moves to a match that goes live, the old one drops to a row, and the live cadence re-arms", async ({
  browser,
  request,
}) => {
  const clock = w2Clock();
  // No mount fetch and no overlap guard on the card's interval, so the first
  // change cannot be lined up: two idle intervals plus slack (owner-accepted).
  const toLiveMs = 2 * clock.hubIdlePollMs + LAND_SLACK_MS;
  const toResultMs = clock.hubPollMs + LAND_SLACK_MS;
  test.setTimeout(Math.max(FLOOR_MS, 2 * STEP_MS + 6 * API_CALL_MS + toLiveMs + toResultMs));

  const page = await spectator(browser, { width: 390 });
  await page.goto(cardPath(pro.slug, comp.slug, xavier.id));
  const slab = page.locator('[data-slab="true"]');
  const order = () =>
    page.locator('[data-testid^="mh-player-match-"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));

  await expect(slab).toHaveAttribute("data-testid", `mh-player-match-${f1}`);
  await expect(slab.getByTestId("mh-player-slab-result-won")).toBeVisible();
  await expect(page.getByTestId(`mh-player-match-${f2}`)).toHaveCount(0);
  await expect(slab.getByTestId("mh-player-updated-at"), "no 'Updated' line on a finished slab").toHaveCount(0);
  const beforeOrder = await order();
  expect(beforeOrder).toEqual([`mh-player-match-${f1}`]);
  const samePage = await noReloadGuard(page);

  const s = await eventStream(request, f2);
  await s.post("core.start", {});
  await expect(slab, "the slab never moved to the match that went live").toHaveAttribute(
    "data-testid",
    `mh-player-match-${f2}`,
    { timeout: toLiveMs },
  );
  await expect(slab.getByTestId("mh-player-slab-live")).toBeVisible();
  const row = page.getByTestId(`mh-player-match-${f1}`);
  await expect(row).not.toHaveAttribute("data-slab", "true");
  await expect(row.getByTestId("mh-player-result-won")).toBeVisible();
  const liveOrder = await order();
  expect(liveOrder, "live: the new match leads, last week's win follows").toEqual([
    `mh-player-match-${f2}`,
    `mh-player-match-${f1}`,
  ]);
  await samePage("after the match went live");

  const opp = (await apiJson<{ home_entrant_id: string; away_entrant_id: string }>(request, `/api/v1/fixtures/${f2}`))
    .data!;
  const oppEntrant = opp.home_entrant_id === xavierTeam ? opp.away_entrant_id : opp.home_entrant_id;
  await s.post("generic.score", { by: xavierTeam, points: 1, person: xavier.id });
  await s.post("generic.score", { by: oppEntrant, points: 2 });
  await s.post("generic.result", {});
  await expect(
    slab.getByTestId("mh-player-slab-result-lost"),
    "the result took longer than one live interval — the cadence did not re-arm",
  ).toBeVisible({ timeout: toResultMs });
  await expect(slab.getByTestId("mh-player-slab-live")).toHaveCount(0);
  await expect(slab).toHaveAttribute("data-testid", `mh-player-match-${f2}`);
  console.log(`PP2 order: before ${JSON.stringify(beforeOrder)} live ${JSON.stringify(liveOrder)} after ${JSON.stringify(await order())}`);
  await samePage("after the result");
});

// PP3 — Priya's card lists two matches against Quinn, one at home and one
// away, played point for point the same from her side: both lines read
// identically, tiebreak included. The mirror is the oracle — no score typed.
test("PP3: the away player's set-based line equals the home reading of the mirrored match, tiebreak included", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 4 * STEP_MS));
  const page = await spectator(browser, { width: 390 });
  const read = async (who: { id: string; name: string }) => {
    await page.goto(cardPath(pro.slug, comp.slug, who.id));
    await expect(page.getByTestId(`mh-player-match-${tennisA.fixtureId}`)).toBeVisible();
    await expect(page.getByTestId(`mh-player-match-${tennisB.fixtureId}`)).toBeVisible();
    return { a: await figureText(page, tennisA.fixtureId), b: await figureText(page, tennisB.fixtureId) };
  };
  const p = await read(priya);
  const q = await read(quinn);
  const pLines = await endpointLines(pro.slug, comp.slug, priya.id);
  const pApiA = pLines.find((l) => l.fixtureId === tennisA.fixtureId)?.line;
  console.log(`PP3: Priya A="${p.a}" B="${p.b}" | Quinn A="${q.a}" B="${q.b}" | endpoint Priya A="${pApiA}"`);

  expect(p.a, "the line carries a tiebreak count — the shape this case is about").toMatch(/\(\d+\)/);
  expect(p.b, "Priya: home line === away line").toBe(p.a);
  expect(q.b, "Quinn: home line === away line").toBe(q.a);
  expect(p.a, "Priya's and Quinn's lines differ — a side-blind line would read the same for both").not.toBe(q.a);
  expect(p.a, "the card and the endpoint are two readers of one line").toBe(pApiA);
});

// PP4 — an organiser hides a player's name. A FRESH visitor, within the
// player-toggle bar: no longer loads Quinn's card or matches, reads Priya's
// matches against a masked Quinn, and finds Quinn unlinked and masked on the
// hub's Teams tab.
test("PP4: an organiser's consent revoke clears Quinn's card, endpoint, name on Priya's card and hub Teams link for a fresh visitor within the bar", async ({
  browser,
  request,
}) => {
  const polls = 4;
  test.setTimeout(Math.max(FLOOR_MS, 4 * STEP_MS + CONSENT_CLEAR_BAR_MS * polls));
  const masked = maskDisplayName(quinn.name, "first_initial");
  expect(masked, "the mask must differ from the full name").not.toBe(quinn.name);
  const full = dictString("en", "player.opponent", { opponent: quinn.name });
  const hidden = dictString("en", "player.opponent", { opponent: masked });
  const hubTeams = `/shared/${pro.slug}/${comp.slug}?tab=teams&division=${tennisA.divSlug}`;
  const quinnLink = `a[href="${cardPath(pro.slug, comp.slug, quinn.id)}"]`;
  // Quinn is an `individual` entrant, and a singles entrant's hub card no
  // longer opens onto a squad (2026-09-17): one person is not a team of zero,
  // so the card is a flat row and its NAME carries both the player-page link
  // and the `title` that prints the name in full. Same two claims as the
  // squad line this used to read (`mh-team-{e}-member-0`), read off the card
  // itself — a team or pair card is unchanged and still discloses its squad.
  const quinnCard = (page: Page) => page.getByTestId(`mh-team-${tennisA.quinnEntrant}`);

  const opponentLines = async (page: Page) => {
    await page.goto(cardPath(pro.slug, comp.slug, priya.id));
    const out: string[] = [];
    for (const f of [tennisA.fixtureId, tennisB.fixtureId]) {
      const card = page.getByTestId(`mh-player-match-${f}`);
      await expect(card).toBeVisible();
      out.push((await card.locator("p.truncate, span.truncate").first().textContent())?.trim() ?? "");
    }
    return out;
  };
  const anon = await anonymousRequest();
  try {
    // Before.
    expect((await anon.get(cardPath(pro.slug, comp.slug, quinn.id))).status(), "Quinn's card before").toBe(200);
    expect((await anon.get(matchesApi(pro.slug, comp.slug, quinn.id))).status(), "Quinn's endpoint before").toBe(200);
    const before = await spectator(browser, { width: 390 });
    expect(await opponentLines(before), "Priya's card names Quinn in full before").toEqual([full, full]);
    await before.goto(hubTeams);
    await expect(quinnCard(before)).toBeAttached();
    await expect(quinnCard(before).locator(quinnLink)).toHaveCount(1);
    await expect(quinnCard(before).locator("[title]").first()).toHaveAttribute("title", quinn.name);
    await before.context().close();

    const revoked = await apiJson(request, `/api/v1/persons/${quinn.id}`, "PATCH", { consent: { public_name: false } });
    expect(revoked.status, JSON.stringify(revoked.error)).toBe(200);
    const t0 = Date.now();
    const left = () => Math.max(1_000, CONSENT_CLEAR_BAR_MS - (Date.now() - t0));
    const cleared: Record<string, number> = {};

    await expect
      .poll(async () => (await anon.get(cardPath(pro.slug, comp.slug, quinn.id))).status(), {
        message: "Quinn's card still loads for a fresh visitor",
        timeout: left(),
      })
      .toBe(404);
    cleared.card = Date.now() - t0;
    await expect
      .poll(async () => (await anon.get(matchesApi(pro.slug, comp.slug, quinn.id))).status(), {
        message: "Quinn's matches endpoint still answers",
        timeout: left(),
      })
      .toBe(404);
    cleared.endpoint = Date.now() - t0;
    await expect
      .poll(
        async () => {
          const page = await spectator(browser, { width: 390 });
          const lines = await opponentLines(page);
          await page.context().close();
          return lines;
        },
        { message: "Priya's card still names Quinn in full", timeout: left() },
      )
      .toEqual([hidden, hidden]);
    cleared.opponent = Date.now() - t0;
    await expect
      .poll(
        async () => {
          const page = await spectator(browser, { width: 390 });
          await page.goto(hubTeams);
          await expect(quinnCard(page)).toBeAttached();
          const state = {
            links: await quinnCard(page).locator(quinnLink).count(),
            title: await quinnCard(page).locator("[title]").first().getAttribute("title"),
          };
          await page.context().close();
          return state;
        },
        { message: "the hub's Teams tab still links or names Quinn", timeout: left() },
      )
      .toEqual({ links: 0, title: masked });
    cleared.teams = Date.now() - t0;
    console.log(`PP4 cleared after (ms): ${JSON.stringify(cleared)} — bar ${CONSENT_CLEAR_BAR_MS}`);
  } finally {
    await anon.dispose();
  }
});

// PP5 — R11 at 320: a badminton player's card on a small phone. The big figure
// keeps "(11–9)" together, and the list row still shows enough of a 43-character
// opponent name to read.
test("PP5: a long badminton line keeps each parenthesis on one line and leaves the row's opponent readable at 320, 390 and 1280", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 4 * STEP_MS));
  const prefix = dictString("en", "player.opponent", { opponent: "" });
  for (const width of [320, 390, 1280]) {
    const page = await spectator(browser, { width });
    await page.goto(cardPath(pro.slug, comp.slug, nadia.id));
    const slab = page.locator('[data-slab="true"]');
    await expect(slab).toHaveAttribute("data-testid", `mh-player-match-${longSlab.fixtureId}`);
    const slabFigures = slab.getByTestId("mh-player-slab-figures");
    await expect(slabFigures).toBeVisible();

    const tokens = await slabFigures.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
      const full = nodes.map((n) => n.data).join("");
      const at = (offset: number): [Text, number] => {
        let seen = 0;
        for (const n of nodes) {
          if (offset <= seen + n.data.length) return [n, offset - seen];
          seen += n.data.length;
        }
        return [nodes[nodes.length - 1]!, nodes[nodes.length - 1]!.data.length];
      };
      const lines = (start: number, end: number) => {
        const r = document.createRange();
        r.setStart(...at(start));
        r.setEnd(...at(end));
        return new Set([...r.getClientRects()].filter((b) => b.width > 0).map((b) => Math.round(b.top))).size;
      };
      return {
        text: full,
        figureLines: lines(0, full.length),
        parens: [...full.matchAll(/\([^)]*\)/g)].map((m) => ({ token: m[0], lines: lines(m.index!, m.index! + m[0].length) })),
      };
    });

    const row = page.getByTestId(`mh-player-match-${longRow.fixtureId}`);
    await expect(row).toBeVisible();
    const g = await row.evaluate((link, prefixLength) => {
      const name = link.querySelector<HTMLElement>(":scope > span.min-w-0 > span.truncate")!;
      const cs = getComputedStyle(name);
      const text = name.firstChild as Text;
      const avail = name.clientWidth - (name.scrollWidth > name.clientWidth ? parseFloat(cs.fontSize) : 0);
      const r = document.createRange();
      let fits = 0;
      for (let i = 1; i <= text.data.length; i++) {
        r.setStart(text, 0);
        r.setEnd(text, i);
        if (r.getBoundingClientRect().width <= avail + 0.5) fits = i;
        else break;
      }
      const figuresBox = link.querySelector('[data-testid="mh-player-row-figures"]')!.getBoundingClientRect();
      return {
        nameWidth: name.clientWidth,
        truncated: name.scrollWidth > name.clientWidth,
        textOverflow: cs.textOverflow,
        whiteSpace: cs.whiteSpace,
        visibleNameChars: Math.max(0, fits - prefixLength),
        figuresRight: figuresBox.right,
        rowRight: link.getBoundingClientRect().right,
      };
    }, prefix.length);
    console.log(`PP5@${width}: slab ${JSON.stringify(tokens)} row ${JSON.stringify(g)}`);

    expect(tokens.parens.length, `@${width}: the live line has a parenthesised open game`).toBeGreaterThan(0);
    for (const p of tokens.parens) expect(p.lines, `@${width}: "${p.token}" split across lines`).toBe(1);
    if (width === 320) {
      expect(tokens.figureLines, "@320 the figure wraps, so where it breaks matters").toBeGreaterThan(1);
    }
    expect(g.textOverflow, `@${width}: the opponent name ellipsis is not in effect`).toBe("ellipsis");
    expect(g.whiteSpace, `@${width}: the opponent name wraps`).toBe("nowrap");
    expect(g.visibleNameChars, `@${width}: fewer than 12 characters of the opponent's name are readable`).toBeGreaterThanOrEqual(12);
    expect(g.figuresRight, `@${width}: the row's figures overflow the row`).toBeLessThanOrEqual(g.rowRight + 0.5);
    if (width === 320) expect(g.truncated, "@320 a 43-character name is cut, so the ellipsis is exercised").toBe(true);
    await expectNoHorizontalScroll(page);
  }
});

// The refused card, as Next serves it: one page, in the org's language, for
// three different reasons nobody outside can tell apart.
test("refused card: never-consented, not in the plan and unknown each get the org-language 404 page, identical, at en and es", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 10 * STEP_MS));
  const page = await spectator(browser, { width: 390 });

  const cases = {
    en: {
      allowed: cardPath(pro.slug, comp.slug, xavier.id),
      org: pro.slug,
      refused: {
        neverConsented: cardPath(pro.slug, comp.slug, neverConsented),
        notInPlan: cardPath(free.slug, freeComp.slug, freeTeams[0]!.members[0]!.id),
        unknown: cardPath(pro.slug, comp.slug, randomUUID()),
      },
    },
    es: {
      allowed: cardPath(esPro.slug, esProComp.slug, esConsenting),
      org: esPro.slug,
      refused: {
        neverConsented: cardPath(esPro.slug, esProComp.slug, esNeverConsented),
        notInPlan: cardPath(esFree.slug, esFreeComp.slug, esFreeConsenting),
        unknown: cardPath(esPro.slug, esProComp.slug, randomUUID()),
      },
    },
  } as const;

  for (const locale of ["en", "es"] as const) {
    const c = cases[locale];
    // The pair: a consenting player on a Pro org is a card, not the refusal.
    const ok = await page.goto(c.allowed);
    expect(ok?.status(), `${locale}: the allowed card`).toBe(200);
    await expect(page.getByTestId("mh-player-matches")).toBeAttached();
    await expect(page.getByTestId("player-not-found")).toHaveCount(0);

    const seen: Record<string, { html: string; title: string }> = {};
    const whole: Record<string, { main: string; head: string[] }> = {};
    for (const [cause, path] of Object.entries(c.refused)) {
      const res = await page.goto(path);
      expect(res?.status(), `${locale} ${cause}: status`).toBe(404);
      const box = page.getByTestId("player-not-found");
      await expect(box, `${locale} ${cause}: the player not-found page`).toBeVisible();
      await expect(box.getByRole("heading", { level: 1 })).toHaveText(dictString(locale, "player.notFound.heading"));
      await expect(box.locator("p")).toHaveText(dictString(locale, "player.notFound.body"));
      const cta = box.getByRole("link");
      await expect(cta).toHaveText(dictString(locale, "player.notFound.cta"));
      const orgSlug = path.split("/")[2]!;
      await expect(cta).toHaveAttribute("href", `/shared/${orgSlug}`);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.lang), { message: `${locale} ${cause}: <html lang>` })
        .toBe(locale);
      seen[cause] = { html: (await box.innerHTML()).replaceAll(orgSlug, "{org}"), title: await page.title() };
      // The whole page, not only the box: `main` and the head's meta set.
      const personId = path.split("/").at(-1)!;
      const norm = (x: string) => x.replaceAll(orgSlug, "{org}").replaceAll(personId, "{id}");
      whole[cause] = {
        main: norm(await page.evaluate(() => document.body.querySelector("main")?.innerHTML ?? "(no main)")),
        head: (
          await page.evaluate(() =>
            [...document.head.querySelectorAll("meta[name], meta[property], link[rel='canonical']")].map(
              (el) =>
                `${el.getAttribute("name") ?? el.getAttribute("property") ?? "canonical"}=${
                  el.getAttribute("content") ?? el.getAttribute("href")
                }`,
            ),
          )
        )
          .map(norm)
          .sort(),
      };
    }
    const [first, ...rest] = Object.values(seen);
    for (const [cause, v] of Object.entries(seen)) {
      expect(v, `${locale} ${cause}: the refusal must read exactly like the others`).toEqual(first);
    }
    expect(rest.length).toBe(2);
    // The two SAME-org causes share every other byte of the page too: a
    // robots or OG tag that differed would still tell a never-consented player
    // from an unknown id. (Not in the plan is another org, so its chrome
    // legitimately differs.)
    expect(whole.neverConsented!.head.length, `${locale}: the head has no meta at all`).toBeGreaterThan(0);
    expect(whole.neverConsented, `${locale}: never-consented and unknown differ outside the box`).toEqual(whole.unknown);
    if (locale === "es") {
      const box = page.getByTestId("player-not-found");
      await expect(box.getByText(dictString("en", "player.notFound.heading"))).toHaveCount(0);
    }
  }
});

async function expectCardLinks(
  scope: Locator,
  names: string[],
  where: string,
  expectLinks: boolean,
  orgSlug: string,
  compSlug: string,
  ids: string[],
): Promise<void> {
  for (const [i, name] of names.entries()) {
    await expect(scope.getByText(name, { exact: true }).first(), `${where}: "${name}" is shown`).toBeAttached();
    const link = scope.locator(`a[href="${cardPath(orgSlug, compSlug, ids[i]!)}"]`);
    if (expectLinks) await expect(link, `${where}: "${name}" links to the card`).not.toHaveCount(0);
    else await expect(link, `${where}: "${name}" must not link to a card`).toHaveCount(0);
  }
  if (!expectLinks) await expect(scope.locator('a[href*="/players/"]'), `${where}: any card link`).toHaveCount(0);
}

// Free plan: player stats granted, player pages not. Every roster surface a
// spectator reaches shows plain names — and the same surfaces on the Pro org
// link, so a page that never links cannot pass.
test("free plan: hub Stats leaders, hub Teams and division Entrants show plain names; the Pro competition links them", async ({
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 10 * STEP_MS));
  const page = await spectator(browser, { width: 390 });

  const surfaces = async (org: string, compSlug: string, div: string, people: { id: string; name: string }[], teamIds: string[], links: boolean) => {
    const label = links ? "Pro" : "free";
    const names = people.map((p) => p.name);
    const ids = people.map((p) => p.id);

    await page.goto(`/shared/${org}/${compSlug}?tab=stats`);
    const board = page.getByTestId(`mh-leaders-${div}-points`);
    await expect(board, `${label}: the Stats tab's points board`).toBeVisible();
    const scorer = people[0]!;
    if (links) {
      const row = page.getByTestId(`mh-leaders-${div}-points-row-${scorer.id}`);
      await expect(row).toContainText(scorer.name);
      await expect(row.locator(`a[href="${cardPath(org, compSlug, scorer.id)}"]`)).toHaveCount(1);
    } else {
      // Final review A m3: only a LINKED row keeps the person id; an unlinked
      // one gets a stand-in, so the hub carries no id the public views withheld.
      const row = board.locator(`li[data-testid^="mh-leaders-${div}-points-row-"]`).filter({ hasText: scorer.name });
      await expect(row, `${label}: the top scorer row`).toHaveCount(1);
      expect(await row.getAttribute("data-testid"), `${label}: an unlinked row carries the person id`).not.toContain(scorer.id);
      await expect(board.locator("a"), `${label}: a leader row links`).toHaveCount(0);
      expect(await page.content(), `${label}: the Stats tab carries a withheld person id`).not.toContain(scorer.id);
    }

    await page.goto(`/shared/${org}/${compSlug}?tab=teams&division=${div}`);
    for (const teamId of teamIds) await expect(page.getByTestId(`mh-team-${teamId}`)).toBeAttached();
    await expectCardLinks(page.getByTestId("mh-teams"), names, `${label} hub Teams`, links, org, compSlug, ids);

    await page.goto(`/shared/${org}/${compSlug}/${div}?tab=entrants`);
    const panel = page.locator("#panel-entrants");
    await expect(panel).toBeVisible();
    await expectCardLinks(panel, names, `${label} division Entrants`, links, org, compSlug, ids);
  };

  await surfaces(
    free.slug,
    freeComp.slug,
    freeDiv.slug,
    freeTeams.flatMap((t) => t.members),
    freeTeams.map((t) => t.entrantId),
    false,
  );
  await surfaces(pro.slug, comp.slug, genericDiv.slug, [xavier], [xavierTeam], true);
});

