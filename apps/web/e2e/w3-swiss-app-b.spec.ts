import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, apiJson, competitionPath, divisionPath, openBracket, seedVenueWithCourts, withDb } from "./helpers";
import { fill, uiEn } from "./match-room-kit";
import { closeOpenContexts } from "./spectator-public-helpers";
import { API_CALL_MS, FLOOR_MS, STEP_MS, spectator } from "./spectator-w2-kit";
import {
  BADMINTON_GAME,
  LATE_SPORTS,
  addLatePlayer,
  isByeRow,
  noticeLines,
  scoreAt,
  showAllFixtures,
  stageFixtures,
  startedSwiss,
  type Seated,
} from "./support/swiss-app-a-kit";
import {
  buchholz,
  buchholzCut1,
  display,
  drawPointsOf,
  levelGroups,
  oppDiff,
  rankByChain,
  ratio,
  sonnebornBerger,
  tablePoints,
  type ChainRow,
  type DeclaredPointsRule,
  type LedgerOpts,
  type OracleFixture,
} from "./support/swiss-oracle";

// W3 Swiss app-B (plan 2026-10-31-w3-swiss-app-b.md). One describe per rule, each driven through the real desk, run only by
// the CI dispatch (`e2e.yml`) and judged as a WHOLE file, never with `-g`. Task 1 creates the scaffold; each later task
// adds its own describe beside this one. The Swiss helpers the app-A spec drives its desk with live in
// `./support/swiss-app-a-kit.ts` (moved there in Task 1, plan R20) and are imported from there. A task may instead give its
// describe a file of its own, `w3-swiss-tN.spec.ts` (Task 9 does: `w3-swiss-t9.spec.ts`), which keeps this file's shard small.
//
// Serial mode is set PER describe (`test.describe.configure({ mode: "serial" })` inside it), never file-wide: in a serial
// file the first red hides every later describe (AGENTS.md class 21), so a file-wide setting would hide the tasks that
// follow a red one.
//
// Task 10 (SW-L10) adds the whole-flow describes below. What they deliberately do NOT re-prove, because a sibling file owns it:
//   - `w3-swiss-t4.spec.ts`  - X-SW-3 / X-SW-26: an unpairable round is refused by name, and Finish after the last full round;
//   - `w3-swiss-t9.spec.ts`  - ST-G21: the organiser's TV board folds the ladders below 2xl (1536px), and the public table's
//                              tie-break headers; here the ladders are read at 1920 only, for their VALUES;
//   - `w3-swiss-t9b.spec.ts` - X-SW-31: Auto-schedule keeps round 2 after round 1 ends;
//   - `w3-swiss-app-a.spec.ts` X-SW-12 - each late-entry case alone, its full notice and the New player / doubles paths; here
//                              the three cases run in ONE stage, so each notice is read for its headline line only.
//
// Every expected table value comes from `./support/swiss-oracle.ts` - the test's own rulebook oracle (FIDE C.07 2026 art. 16,
// rulebook-W3-swiss.md §4-§6), which imports nothing from the product and is fed the stage's DECLARED points rule and chain,
// read over the API, plus the results this file recorded. Its own unit test pins it to the engine plan's hand-derived numbers
// (`src/lib/__tests__/swiss-oracle.test.ts`).

test.describe("W3 Swiss app-B scaffold", () => {
  // Intentionally empty: Task 1 owns the file and the smoke suite beside it, not a flow. Later tasks add their describes.
});

const BADMINTON = LATE_SPORTS.find((s) => s.key === "badminton")!;
const CHESS = LATE_SPORTS.find((s) => s.key === "boardgame")!;

/** One board played through the scorer's events: start + each result event, each a state read and a POST. `BADMINTON_GAME` is
 *  the kit's own payload (`LATE_SPORTS` sends it), so the sets and rally points the oracle's ratio keys read move with it. */
const CALLS_PER_BADMINTON_BOARD = 2 * (1 + BADMINTON_GAME.games);
const CALLS_PER_CHESS_BOARD = 2 * 2;

/** A table cell as a number: a typographic minus and a "½" read the way a person reads them. */
const MINUS = String.fromCharCode(0x2212);
const num = (text: string | undefined) => Number((text ?? "NaN").replace(MINUS, "-").replace("½", ".5").trim());

type TableRules = { tiebreakers: { keys: string[] }; points: { rule: DeclaredPointsRule }; reachableOutcomes: string[] };
/** The stage's DECLARED points rule and tie-break chain, read over the API (never computed here), and the draw value the dummy
 *  cap scales by (rulebook §4 "Non-chess scaling"). */
async function declared(request: APIRequestContext, stageId: string) {
  const one = await apiJson<{ tableRules: TableRules }>(request, `/api/v1/stages/${stageId}`);
  expect(one.status, JSON.stringify(one.error)).toBe(200);
  const t = one.data!.tableRules;
  return { rule: t.points.rule, chain: t.tiebreakers.keys, drawPoints: drawPointsOf(t.points.rule, t.reachableOutcomes.includes("draw")) };
}

type SwissRow = Seated & { status: string; outcome: { kind?: string } | null };
const seated = (rows: readonly SwissRow[]) =>
  rows.filter((f) => !isByeRow(f) && f.home_entrant_id !== null && f.away_entrant_id !== null).sort((a, b) => a.seq_in_round - b.seq_in_round);
const standingBye = (rows: readonly SwissRow[]) => rows.filter((f) => isByeRow(f) && f.home_entrant_id !== null);
const seatsOf = (rows: readonly SwissRow[]) =>
  rows.map((f) => [f.id, f.home_entrant_id, f.away_entrant_id] as const).sort((a, b) => a[0].localeCompare(b[0]));

/** The public twin of an organiser path: `/o/{org}/c/{comp}` -> `/shared/{org}/{comp}`. */
async function sharedPath(request: APIRequestContext, competitionId: string) {
  const path = (await competitionPath(request, competitionId)).replace(/^\/o\/([^/]+)\/c\//, "/shared/$1/");
  expect(path, "premise: the organiser path became the public one").toMatch(/^\/shared\/[^/]+\/[^/?]+$/);
  return path;
}

/** Pair next round on the desk - the Swiss rail's own button - answered off the wire. */
async function pairOnDesk(page: Page, request: APIRequestContext, divisionId: string, stageId: string, round: number) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const answered = page.waitForResponse((r) => r.url().endsWith(`/api/v1/stages/${stageId}/generate`) && r.request().method() === "POST");
  await page.getByTestId("stage-generate").filter({ hasText: uiEn["schedule.pairNext"]! }).click({ timeout: 20_000 });
  const res = await answered;
  const body = (await res.json()) as { data?: { created?: number; swiss_next_round?: string; swiss_paired_round?: number }; error?: unknown };
  expect(res.status(), `Pair round ${round} on the desk: ${JSON.stringify(body.error)}`).toBe(200);
  return body.data!;
}

type HubRow = { th: string; cells: Record<string, string> };
/** The anonymous hub's Table tab for one division (the section scoped through its division's heading), rows in the order the
 *  page prints them - rank order - read in one evaluate. */
async function hubRows(page: Page, hubUrl: string, divisionSlug: string): Promise<HubRow[] | string> {
  await page.goto(hubUrl, { waitUntil: "load" });
  try {
    await page.getByTestId("mh-tab-panel-table").waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    return "no Table tab";
  }
  const sections = page.locator(`section:has([data-testid="mh-table-heading-${divisionSlug}"]) section[data-testid^="mh-table-"]`);
  const n = await sections.count();
  if (n !== 1) return `${n} tables under ${divisionSlug}`;
  return sections.first().evaluate((section) =>
    [...section.querySelectorAll("tbody tr")]
      .map((tr) => ({
        th: (tr.querySelector("th")?.textContent ?? "").trim(),
        cells: Object.fromEntries([...tr.querySelectorAll("td[data-col]")].map((td) => [td.getAttribute("data-col")!, (td.textContent ?? "").trim()])),
      }))
      .filter((r) => Object.keys(r.cells).length > 0),
  );
}

/** The hub table's header over each column: `data-col` key -> its visible abbreviation and the long form it carries. */
async function hubHeaders(page: Page, divisionSlug: string): Promise<Record<string, { abbr: string; title: string | null }>> {
  return page
    .locator(`section:has([data-testid="mh-table-heading-${divisionSlug}"]) section[data-testid^="mh-table-"]`)
    .first()
    .evaluate((section) =>
      Object.fromEntries(
        [...section.querySelectorAll("thead th[data-col]")].map((th) => [
          th.getAttribute("data-col")!,
          { abbr: (th.querySelector("[aria-hidden]")?.textContent ?? "").trim(), title: th.getAttribute("title") },
        ]),
      ),
    );
}

/** The entrant a row is about: the one name its text carries (a hub row leads with the avatar's initials and may carry a
 *  "From R3" chip). Exactly one, or the row is unreadable. */
function whoIs(text: string, names: ReadonlyMap<string, string>): string {
  const hits = [...names].filter(([, n]) => text.includes(n));
  if (hits.length !== 1) throw new Error(`row "${text}" names ${hits.length} entrants`);
  return hits[0]![0];
}

interface PresentSlide {
  header: string[];
  rows: { name: string; cells: string[] }[];
}
/** The anonymous division board's standings slide captioned `caption` (the stage's name), read in ONE evaluate: the board
 *  rotates, so nothing is asserted across slides (t9's reader). */
async function readPresent(page: Page, caption: string): Promise<PresentSlide> {
  let slide: PresentSlide | null = null;
  await expect
    .poll(
      async () => {
        slide = await page.evaluate((wanted) => {
          if (document.querySelector("main h2")?.textContent?.trim() !== wanted) return null;
          const grids = [...document.querySelectorAll("main div.grid")];
          const cells = (g: Element) => [...g.children].filter((c) => !c.hasAttribute("aria-hidden")).map((c) => (c.textContent ?? "").trim());
          const header = grids.find((g) => !g.classList.contains("relative"));
          if (!header) return null;
          return { header: cells(header), rows: grids.filter((g) => g.classList.contains("relative")).map((g) => ({ name: cells(g)[1] ?? "", cells: cells(g) })) };
        }, caption);
        if (slide === null) await page.keyboard.press("ArrowRight");
        return slide !== null;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true);
  return slide!;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// SW-L10: an odd Swiss with three late players and a Buchholz cut into the knockout (badminton, swiss_knockout, Top 4).
//
// X-SW-5 (a bye pays the declared win), X-SW-29 (a bye takes no time and no court), ruling 250's three late-entry cases in ONE
// stage - (a) before any board starts, (c) a started round with no bye, (b) a started round with a bye - X-SW-9 + BD-TB-2 (a
// points tie across the cut is split by the set-sport chain's Buchholz ladders, never by head-to-head: the two never met),
// ST-G21 (the same ladders on /present at a TV width), X-SW-24 (the seed proposal is the chain's top four, no tie flagged).
//
// FALSE PREMISE (recorded; plan step 5): three rounds of a ten-player no-draw Swiss cannot leave 4th and 5th level on points -
// the scores fall 1-3-4-2 after round 3 whatever the pairings - so the builder's Rounds knob is pinned at what it OPENS AT (3,
// class 19) and then set to 4. Pairings are lots-driven between runs, so rounds 1-3 follow a fixed policy (the stronger side
// wins: seeds 1-7, then the latecomers in arrival order) and round 4's results are CHOSEN with the oracle: the first of the
// 2^boards outcomes, fewest upsets first, that leaves 4th and 5th level on points, never met, split by a Buchholz key, and the
// top four strictly ordered. The search's count is asserted (anti-vacuity: no tie, no test). The "unsplit cut -> flagged" branch
// of X-SW-24 is therefore unreachable here; `swiss-signed-rules-pin.test.ts` owns it, and this flow pins its negative.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("SW-L10 an odd Swiss with three late players and a Buchholz cut into the knockout", () => {
  test.describe.configure({ mode: "serial" });
  test.afterEach(async () => {
    // Never `finally`: a Playwright timeout skips it.
    await closeOpenContexts();
  });

  const FIELD = 7;
  const LATE = 3;
  const TOP = 4;
  /** Rulebook §3.2: the recommended rounds for a field up to 8 - what the builder's knob must OPEN AT. */
  const RECOMMENDED_ROUNDS = 3;
  const ROUNDS = 4;
  const BOARDS_PLAYED = 4 + 4 + 5 + 5;
  /** Setup (competition, stage reads, entrants, the knockout's day one, Start, a venue and three courts, three pins), the
   *  boards played, and the reads between steps (rounds, standings, the proposal and its confirm). */
  const API_CALLS = 16 + BOARDS_PLAYED * CALLS_PER_BADMINTON_BOARD + 40;
  /** The builder (6), four Pairs on the desk, three Add late player paths (4 each), three run-sheet reads, the hub (2),
   *  /present (2) and the bracket (2). */
  const UI_STEPS = 6 + 4 + LATE * 4 + 3 + 2 + 2 + 2;

  test("seven seeded, three late, four rounds: the public table and /present print the oracle's ladders, and the knockout takes its top four", async ({ page, request, browser }) => {
    test.setTimeout(Math.max(FLOOR_MS, API_CALLS * API_CALL_MS + UI_STEPS * STEP_MS));

    // (1) The division through the builder, as an organiser creates it; seven seeded entrants; the knockout's day one; Start.
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `SW-L10 ${TAG}`,
      visibility: "public",
    });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const competitionId = comp.data!.id;
    await page.goto(await competitionPath(request, competitionId, "/d/new"));
    await page.getByRole("textbox").first().fill(`SW-L10 Open ${TAG}`);
    await page.locator("label", { hasText: "Sport" }).locator("select").selectOption({ label: "Badminton" });
    // The builder opens badminton on its 3x15 variant; the kit's results are 21-point games.
    await page.locator("label", { hasText: "Variant" }).locator("select").selectOption({ value: BADMINTON.variant });
    await page.getByRole("button", { name: "Format", exact: true }).click();
    await page.getByText("Swiss Knockout", { exact: true }).click();
    await expect(page.locator("label", { hasText: "Qualify to finals" }).getByRole("spinbutton")).toHaveValue(String(TOP));
    const roundsKnob = page.getByLabel("Rounds", { exact: true });
    await expect(roundsKnob, "the Rounds knob opens at the recommended rounds for a field up to 8 (rulebook §3.2)").toHaveValue(String(RECOMMENDED_ROUNDS));
    await roundsKnob.fill(String(ROUNDS));
    await page.getByRole("button", { name: "Scheduling", exact: true }).click();
    await page.getByRole("button", { name: /create division/i }).click();
    await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+/, { timeout: 30_000 });
    const divisionSlug = page.url().match(/\/d\/([^/?]+)/)![1]!;
    const divisions = await apiJson<{ id: string; slug: string }[]>(request, `/api/v1/competitions/${competitionId}/divisions`);
    const divisionId = divisions.data!.find((d) => d.slug === divisionSlug)!.id;
    type Stage = { id: string; seq: number; kind: string; name: string; config: Record<string, unknown>; progression: unknown };
    const stages = (await apiJson<Stage[]>(request, `/api/v1/divisions/${divisionId}/stages`)).data!;
    expect(stages.map((s) => s.kind)).toEqual(["swiss", "knockout"]);
    const swiss = stages.find((s) => s.seq === 1)!;
    const ko = stages.find((s) => s.seq === 2)!;
    expect(swiss.config, "the builder sent rank-adjacent pairing and the knob's rounds").toMatchObject({ pairing: "rank_adjacent", rounds: ROUNDS });
    expect(ko.progression).toMatchObject({ sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: TOP }] }], placement: "rank_order", timing: "setup" });
    const { rule, chain, drawPoints } = await declared(request, swiss.id);

    const seedName = (i: number) => `SW-L10 Seed${i} ${TAG}`;
    const lateName = (i: number) => `SW-L10 Late${i} ${TAG}`;
    const added = await apiJson<{ id: string; seed: number; display_name: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: FIELD }, (_, i) => ({ kind: "individual", display_name: seedName(i + 1), seed: i + 1, members: [] })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const names = new Map(added.data!.map((e) => [e.id, e.display_name]));
    /** The fixed result policy's strength: seeds 1-7, then the latecomers in arrival order. */
    const strength = new Map(added.data!.map((e) => [e.id, e.seed]));
    const stronger = (f: Seated) => (strength.get(f.home_entrant_id!)! < strength.get(f.away_entrant_id!)! ? f.home_entrant_id! : f.away_entrant_id!);
    const weaker = (f: Seated) => (stronger(f) === f.home_entrant_id ? f.away_entrant_id! : f.home_entrant_id!);
    const dayOne = await apiJson(request, `/api/v1/stages/${ko.id}/generate`, "POST");
    expect(dayOne.status, `the knockout's day one: ${JSON.stringify(dayOne.error)}`).toBe(200);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);

    const rows = async () => (await stageFixtures(request, divisionId, swiss.id)) as SwissRow[];
    const round = async (r: number) => (await rows()).filter((f) => f.round_no === r).sort((a, b) => a.seq_in_round - b.seq_in_round);
    /** A board as the oracle reads it: who sat where, who won, and the games' scores the kit sends. */
    const asOracle = (f: Seated, winner: string): OracleFixture => {
      const homeWon = winner === f.home_entrant_id;
      const { won, lost, games } = BADMINTON_GAME;
      return {
        round: f.round_no,
        home: f.home_entrant_id!,
        away: f.away_entrant_id!,
        winner,
        sets: homeWon ? [games, 0] : [0, games],
        points: homeWon ? [won * games, lost * games] : [lost * games, won * games],
      };
    };
    const played: OracleFixture[] = [];
    const play = async (f: Seated, winner: string, alreadyStarted = false) => {
      if (alreadyStarted) await BADMINTON.result(request, f, winner);
      else await BADMINTON.win(request, f, winner);
      played.push(asOracle(f, winner));
    };
    const late = async (i: number) => {
      const { status, body } = await addLatePlayer(page, request, divisionId, lateName(i));
      expect(status, JSON.stringify(body.error)).toBe(201);
      names.set(body.data!.id, lateName(i));
      strength.set(body.data!.id, FIELD + i);
      return { id: body.data!.id, le: body.data!.late_entry! };
    };

    // (2) Round 1 on an odd field: three boards and a bye. X-SW-5: the bye holder's table points are the declared win, as
    // the oracle reads a bye off the declared rule. X-SW-29: a time and court pinned on every board; the bye takes neither.
    await pairOnDesk(page, request, divisionId, swiss.id, 1);
    const r1 = await round(1);
    const bye1 = standingBye(r1);
    expect(bye1, "seven entrants leave one bye").toHaveLength(1);
    const boards1 = seated(r1);
    expect(boards1, "and three boards").toHaveLength(3);
    const holder1 = bye1[0]!.home_entrant_id!;
    const byeWin = tablePoints([{ round: 1, home: holder1, away: null, winner: holder1 }], rule).get(holder1);
    await expect
      .poll(
        async () =>
          (await apiJson<{ rows: { entrantId: string; points: number }[] }>(request, `/api/v1/stages/${swiss.id}/standings`)).data?.rows.find((r) => r.entrantId === holder1)
            ?.points,
        { timeout: 20_000, message: "X-SW-5: the bye holder scores the declared win" },
      )
      .toBe(byeWin);
    const venue = await seedVenueWithCourts(request, [1, 2, 3].map((i) => `SW-L10 Court ${i} ${TAG}`));
    for (const [i, f] of boards1.entries()) {
      const pinned = await apiJson(request, `/api/v1/fixtures/${f.id}`, "PATCH", {
        scheduled_at: `2030-06-15T${String(9 + i).padStart(2, "0")}:00:00.000Z`,
        venue_id: venue.venueId,
        court_id: venue.courts[i]!.id,
      });
      expect(pinned.status, JSON.stringify(pinned.error)).toBe(200);
    }
    const afterPins = await round(1);
    const pins = new Map(boards1.map((b) => afterPins.find((f) => f.id === b.id)!).map((f) => [f.id, { at: f.scheduled_at, court: f.court_id }]));
    expect([...pins.values()].every((p) => p.at !== null && p.court !== null), "premise: three boards pinned").toBe(true);
    const byeRow = standingBye(afterPins)[0]!;
    expect([byeRow.scheduled_at, byeRow.court_id], "X-SW-29: the bye has no time and no court").toEqual([null, null]);
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const byeLine = page.getByTestId("run-sheet-bye");
    await expect(byeLine).toContainText(names.get(holder1)!, { timeout: 20_000 });
    for (const c of venue.courts) await expect(byeLine, "X-SW-29: no court on the bye line").not.toContainText(c.name);
    const timeOf = async (fixtureNo: number) => {
      const cell = page.locator(`li[data-fixture-no="${fixtureNo}"]`).getByTestId("run-sheet-edit-time");
      await expect.poll(async () => ((await cell.textContent()) ?? "").trim(), { timeout: 20_000, message: "the pinned time hydrates" }).not.toBe("");
      return ((await cell.textContent()) ?? "").trim();
    };
    const sheetBefore = new Map<string, { time: string; court: string }>();
    for (const [i, f] of boards1.entries()) {
      await expect(page.locator(`li[data-fixture-no="${f.fixture_no}"]`)).toContainText(venue.courts[i]!.name);
      sheetBefore.set(f.id, { time: await timeOf(f.fixture_no), court: venue.courts[i]!.name });
    }

    // (3) Case (a): nothing started, so round 1 is re-paired with the newcomer. The boards keep their ids, times and courts;
    // the newcomer's board is new and unscheduled; the bye is gone. Then round 1 is played.
    const L1 = await late(1);
    expect([L1.le.case, L1.le.round], "ruling 250 (a)").toEqual(["a", 1]);
    const changed = L1.le.repaired!.changed_entrant_ids.length;
    expect((await noticeLines(page))[0], "the notice leads with the re-pair").toEqual({
      tone: "done",
      text: fill(changed === 1 ? "swiss.lateEntry.repaired.one" : "swiss.lateEntry.repaired.other", { round: 1, name: lateName(1), count: changed }),
    });
    const r1a = await round(1);
    expect(seated(r1a), "eight entrants: four boards").toHaveLength(4);
    expect(standingBye(r1a), "and no bye").toHaveLength(0);
    for (const [id, pin] of pins) {
      const now = r1a.find((f) => f.id === id);
      expect(now, "a re-pair keeps the board").toBeDefined();
      expect({ at: now!.scheduled_at, court: now!.court_id }, "and its time and court").toEqual(pin);
    }
    const newBoard = r1a.find((f) => f.id === L1.le.new_board?.fixture_id);
    expect([newBoard?.scheduled_at, newBoard?.court_id, L1.le.new_board?.scheduled], "the newcomer's board is new and unscheduled").toEqual([null, null, false]);
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    for (const [id, was] of sheetBefore) {
      const no = r1a.find((f) => f.id === id)!.fixture_no;
      await expect(page.locator(`li[data-fixture-no="${no}"]`), "the run sheet keeps the court").toContainText(was.court, { timeout: 20_000 });
      expect(await timeOf(no), "and the time").toBe(was.time);
    }
    await expect(page.getByTestId("run-sheet-bye")).toHaveCount(0);
    for (const f of seated(r1a)) await play(f, stronger(f));

    // (4) Round 2 (even), one board started, then case (c): the newcomer joins from round 3 and round 2 is untouched.
    await pairOnDesk(page, request, divisionId, swiss.id, 2);
    const r2 = seated(await round(2));
    expect(r2, "eight entrants: four boards").toHaveLength(4);
    await scoreAt(request, r2[0]!.id, "core.start");
    const L2 = await late(2);
    expect([L2.le.case, L2.le.round], "ruling 250 (c)").toEqual(["c", 3]);
    expect((await noticeLines(page))[0]).toEqual({ tone: "done", text: fill("swiss.lateEntry.nextRound", { name: lateName(2), round: 3 }) });
    expect(seatsOf(seated(await round(2))), "round 2 stands").toEqual(seatsOf(r2));
    for (const [i, f] of r2.entries()) await play(f, stronger(f), i === 0);

    // (5) Round 3 (nine: a bye), one board started, then case (b): the newcomer plays the bye holder on a new board and
    // nothing else moves. Then round 3 is played.
    await pairOnDesk(page, request, divisionId, swiss.id, 3);
    const r3 = await round(3);
    const bye3 = standingBye(r3);
    expect(bye3, "nine entrants leave one bye").toHaveLength(1);
    const holder3 = bye3[0]!.home_entrant_id!;
    const r3boards = seated(r3);
    expect(r3boards, "and four boards").toHaveLength(4);
    await scoreAt(request, r3boards[0]!.id, "core.start");
    const L3 = await late(3);
    expect([L3.le.case, L3.le.round, L3.le.bye_holder_id], "ruling 250 (b)").toEqual(["b", 3, holder3]);
    expect((await noticeLines(page))[0]).toEqual({ tone: "done", text: fill("swiss.lateEntry.tookBye", { name: lateName(3), holder: names.get(holder3)!, round: 3 }) });
    const r3b = await round(3);
    const board3 = r3b.find((f) => f.id === L3.le.new_board?.fixture_id);
    expect([board3?.home_entrant_id, board3?.away_entrant_id].sort(), "the new board seats the newcomer and the holder").toEqual([L3.id, holder3].sort());
    expect(seatsOf(seated(r3b).filter((f) => f.id !== board3!.id)), "nothing else moved").toEqual(seatsOf(r3boards));
    expect(standingBye(r3b), "no bye left in round 3").toHaveLength(0);
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    const row3 = page.locator(`li[data-fixture-no="${board3!.fixture_no}"]`);
    await expect(row3).toContainText(lateName(3), { timeout: 20_000 });
    await expect(row3).toContainText(names.get(holder3)!);
    for (const f of seated(r3b)) await play(f, stronger(f), f.id === r3boards[0]!.id);

    // (6) Round 4: the results the oracle chooses. Absences, each followed by play (C.07 16.2.3): L2 rounds 1-2 (added while
    // round 2 was under way, so it joined round 3), L3 rounds 1-2 (added in round 3, which it played). L1 missed nothing.
    await pairOnDesk(page, request, divisionId, swiss.id, 4);
    const r4 = seated(await round(4));
    expect(r4, "ten entrants: five boards").toHaveLength(5);
    const opts: LedgerOpts = { rule, rounds: ROUNDS, drawPoints, absent: new Map([[L2.id, [1, 2]], [L3.id, [1, 2]]]) };
    const sum = (fx: readonly OracleFixture[], id: string, k: "sets" | "points", mine: boolean) =>
      fx.filter((f) => f.away !== null && (f.home === id || f.away === id)).reduce((s, f) => s + f[k]![(f.home === id) === mine ? 0 : 1], 0);
    const judge = (fx: readonly OracleFixture[]) => {
      const pts = tablePoints(fx, rule);
      const chainRows: ChainRow[] = [...pts.keys()].map((id) => ({
        entrant: id,
        values: {
          points: pts.get(id)!,
          buchholz: buchholz(fx, id, opts),
          buchholz_cut1: buchholzCut1(fx, id, opts),
          set_ratio: ratio(sum(fx, id, "sets", true), sum(fx, id, "sets", false)),
          point_ratio: ratio(sum(fx, id, "points", true), sum(fx, id, "points", false)),
        },
      }));
      return { rank: rankByChain(chainRows, chain, fx), chainRows, pts };
    };
    const met = (fx: readonly OracleFixture[], a: string, b: string) => fx.some((f) => f.away !== null && [f.home, f.away].includes(a) && [f.home, f.away].includes(b));
    /** Round 4 under `mask`: bit i set = board i's weaker side wins. */
    const outcome = (mask: number) => r4.map((f, i) => asOracle(f, (mask >> i) & 1 ? weaker(f) : stronger(f)));
    const upsets = (m: number) => m.toString(2).replace(/0/g, "").length;
    const masks = Array.from({ length: 1 << r4.length }, (_, m) => m).sort((x, y) => upsets(x) - upsets(y) || x - y);
    // Measured on the w3b10 probe server (4 runs of rounds 1-3, each with its own lots): 13-14 of the 32 round-4 outcomes
    // fit, so the search has wide margin. It is not a guarantee - rounds 1-3 follow the pairing's lots. If this ever reds
    // with "0 of 32", the fix is to widen the search into round 3's results (search rounds 3 and 4 together), not to
    // loosen what a fit is.
    const fits = masks.filter((m) => {
      const fx = [...played, ...outcome(m)];
      const { rank, pts } = judge(fx);
      const [a, b] = [rank.order[TOP - 1]!, rank.order[TOP]!];
      return (
        pts.get(a) === pts.get(b) &&
        !met(fx, a, b) &&
        ["buchholz_cut1", "buchholz"].includes(rank.cut[TOP - 1] ?? "") &&
        rank.cut.slice(0, TOP - 1).every((c) => c !== null)
      );
    });
    expect(fits.length, `round 4 outcomes that tie 4th and 5th across the cut and split them by Buchholz (of ${masks.length})`).toBeGreaterThan(0);
    for (const f of outcome(fits[0]!)) await play(r4.find((b) => b.home_entrant_id === f.home)!, f.winner!);
    expect(standingBye(await rows()), "no bye stands: (a) and (b) took rounds 1 and 3's, rounds 2 and 4 were even").toHaveLength(0);
    expect(played, "every board recorded").toHaveLength(BOARDS_PLAYED);
    const { rank, chainRows, pts } = judge(played);
    expect(rank.order, "the oracle ranks the whole field").toHaveLength(FIELD + LATE);
    const cutPair = [rank.order[TOP - 1]!, rank.order[TOP]!] as const;
    expect([pts.get(cutPair[0]) === pts.get(cutPair[1]), met(played, ...cutPair)], "X-SW-9: 4th and 5th level on points, never met").toEqual([true, false]);
    const ladderOf = (id: string) => {
      const v = chainRows.find((r) => r.entrant === id)!.values;
      return { points: display(v.points!, rule.unit), buchholz_cut1: display(v.buchholz_cut1!, rule.unit), buchholz: display(v.buchholz!, rule.unit) };
    };

    // (7) The public table, read by an anonymous visitor: every row's points and both ladders are the oracle's, the order is
    // the chain's (the members of a level group in any order), and the cut pair is split by a Buchholz ladder.
    const shared = await sharedPath(request, competitionId);
    const hubUrl = `${shared}?tab=table`;
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    const want = Object.fromEntries(rank.order.map((id) => [names.get(id)!, ladderOf(id)]));
    let hub: HubRow[] = [];
    await expect
      .poll(
        async () => {
          const got = await hubRows(visitor, hubUrl, divisionSlug);
          if (typeof got === "string") return got;
          hub = got;
          return Object.fromEntries(
            got.map((r) => [names.get(whoIs(r.th, names))!, { points: num(r.cells.points), buchholz_cut1: num(r.cells.buchholz_cut1), buchholz: num(r.cells.buchholz) }]),
          );
        },
        { timeout: 60_000, intervals: [2_000], message: "the public table prints the oracle's points and ladders on every row" },
      )
      .toEqual(want);
    const hubOrder = hub.map((r) => whoIs(r.th, names));
    let at = 0;
    for (const group of levelGroups(rank)) {
      expect([...hubOrder.slice(at, at + group.length)].sort(), `rows ${at + 1}-${at + group.length}: the chain's level group`).toEqual([...group].sort());
      at += group.length;
    }
    expect(at, "anti-vacuity: every row placed").toBe(FIELD + LATE);
    const [fourth, fifth] = [hub[TOP - 1]!.cells, hub[TOP]!.cells];
    expect(num(fourth.points), "BD-TB-2: level on points across the cut").toBe(num(fifth.points));
    const splitBy = rank.cut[TOP - 1]!;
    expect(num(fourth[splitBy]), `BD-TB-2: split by ${splitBy}, the higher ladder above`).toBeGreaterThan(num(fifth[splitBy]));

    // (8) ST-G21: the anonymous division board at a TV width prints the same two ladders for the cut pair (t9 owns the fold).
    const tv = await spectator(browser, { width: 1920, height: 1080 });
    await tv.goto(`${shared}/${divisionSlug}/present`);
    await expect
      .poll(
        async () => {
          const slide = await readPresent(tv, swiss.name);
          const cut = cutPair.map((id) => slide.rows.find((r) => r.name.includes(names.get(id)!))?.cells.slice(-2).map(num) ?? null);
          if (cut.some((c) => c === null)) await tv.reload();
          return { header: slide.header.slice(-2), cut };
        },
        { timeout: 60_000, intervals: [2_000], message: "/present prints the cut pair's Buchholz Cut-1 and Buchholz" },
      )
      .toEqual({ header: ["Buchholz Cut-1", "Buchholz"], cut: cutPair.map((id) => [ladderOf(id).buchholz_cut1, ladderOf(id).buchholz]) });

    // (9) X-SW-24: complete; the proposal is the chain's top four with no tie flagged. Confirm; the bracket seats 1v4, 2v3.
    const done = await apiJson<{ completed: boolean }>(request, `/api/v1/stages/${swiss.id}/complete`, "POST");
    expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
    const proposal = await apiJson<{ id: string; computed: { qualifiers: { entrantId: string }[]; ties: unknown[] } }>(request, `/api/v1/stages/${ko.id}/seed-proposal`, "POST");
    expect(proposal.status, JSON.stringify(proposal.error)).toBeLessThan(300);
    expect(proposal.data!.computed.qualifiers.map((q) => names.get(q.entrantId)), "the seed proposal is the chain's top four").toEqual(
      rank.order.slice(0, TOP).map((id) => names.get(id)),
    );
    expect(proposal.data!.computed.ties, "no tie flagged across the cut").toEqual([]);
    const confirmed = await apiJson(request, `/api/v1/stages/${ko.id}/seed-proposal/confirm`, "POST", { proposalId: proposal.data!.id });
    expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);
    const semis = ((await stageFixtures(request, divisionId, ko.id)) as Seated[]).filter((f) => f.round_no === 1);
    const [s1, s2, s3, s4] = rank.order;
    expect(semis.map((f) => [f.home_entrant_id, f.away_entrant_id].sort()).sort(), "seeds 1v4 and 2v3").toEqual([[s1, s4].sort(), [s2, s3].sort()].sort());
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const bracket = await openBracket(page, ko.id);
    for (const id of rank.order.slice(0, TOP)) await expect(bracket.getByText(names.get(id)!, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(bracket.getByText(names.get(cutPair[1])!, { exact: true }), "5th is out").toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// X-SW-12 on a chess Swiss: five seeded and three late players (one per case) over four rounds. Round 1's bye is left STANDING:
// L1 arrives in round 2, after round 1 is played, so nothing takes it. That puts a boardgame bye on the table (plan Task 2 step
// 6; the sport whose `byeScore` left): it pays the declared win (X-SW-5), and the ladders read it - Buchholz scores it against a
// dummy, Sonneborn-Berger as a win over that dummy. P-A5 (colours never three times running; home is White, BG-SW-1) with
// X-SW-11's final-round topscorer exemption, and every row's Buchholz, Cut-1 and SB - the absences' and the bye's included - are
// the oracle's in the stage's half-point display, on the API and on the public table. Strict alternation is a pairing
// PREFERENCE (P-Q5), so it is not asserted. Rounds 2-4 are Paired over the API: the desk's Pair is the flow above's.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("X-SW-12 chess: the three late-entry cases on one boardgame Swiss", () => {
  test.describe.configure({ mode: "serial" });
  test.afterEach(async () => {
    await closeOpenContexts();
  });

  const SEEDED = 5;
  const LATE = 3;
  const ROUNDS = 4;
  /** Round 1 seats five (two boards, the bye); L1 takes round 2's bye (a); round 3 seats six; round 4 seven, L3 taking its bye (b). */
  const BOARDS_PLAYED = 2 + 3 + 3 + 4;
  const API_CALLS = 14 + BOARDS_PLAYED * CALLS_PER_CHESS_BOARD + 30;
  /** Three Add late player paths (4 each) and the hub (2). */
  const UI_STEPS = LATE * 4 + 2;

  test("5 + 3 late over four rounds with round 1's bye standing: colours within the limits, and every ladder is the oracle's in half-points", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(Math.max(FLOOR_MS, API_CALLS * API_CALL_MS + UI_STEPS * STEP_MS));
    const r = await startedSwiss(request, CHESS, SEEDED, ROUNDS, "SW-L10C");
    const { rule, chain, drawPoints } = await declared(request, r.stageId);
    expect(rule.unit, "premise: chess is shown in half-points").toBe("half");
    expect(chain, "premise: the chess chain carries Sonneborn-Berger, so the table prints it").toContain("sberger");
    const names = new Map(r.nameOf);
    const strength = new Map([...r.nameOf].map(([id, n]) => [id, r.names.indexOf(n) + 1]));
    const stronger = (f: Seated) => (strength.get(f.home_entrant_id!)! < strength.get(f.away_entrant_id!)! ? f.home_entrant_id! : f.away_entrant_id!);
    const rows = async () => (await stageFixtures(request, r.divisionId, r.stageId)) as SwissRow[];
    const boards = async (n: number) => seated((await rows()).filter((f) => f.round_no === n));
    const played: OracleFixture[] = [];
    const play = async (f: Seated, alreadyStarted = false) => {
      const w = stronger(f);
      if (alreadyStarted) await CHESS.result(request, f, w);
      else await CHESS.win(request, f, w);
      played.push({ round: f.round_no, home: f.home_entrant_id!, away: f.away_entrant_id!, winner: w });
    };
    const late = async (i: number) => {
      const name = `SW-L10C Late${i} ${TAG}`;
      const { status, body } = await addLatePlayer(page, request, r.divisionId, name);
      expect(status, JSON.stringify(body.error)).toBe(201);
      names.set(body.data!.id, name);
      strength.set(body.data!.id, SEEDED + i);
      return { id: body.data!.id, le: body.data!.late_entry! };
    };
    const pair = async (n: number) => {
      const res = await apiJson(request, `/api/v1/stages/${r.stageId}/generate`, "POST");
      expect(res.status, `pair round ${n}: ${JSON.stringify(res.error)}`).toBe(200);
    };
    type StandingsRow = { entrantId: string; points: number; metrics: Record<string, number> };
    const standings = async () => {
      const got = await apiJson<{ rows: StandingsRow[] }>(request, `/api/v1/stages/${r.stageId}/standings`);
      expect(got.status, JSON.stringify(got.error)).toBe(200);
      return got.data!.rows;
    };

    // Round 1 (paired by `startedSwiss`) seats five: one bye, which pays the declared win at once (X-SW-5).
    const byes1 = standingBye((await rows()).filter((f) => f.round_no === 1));
    expect(byes1, "round 1's five seat one bye").toHaveLength(1);
    const holder = byes1[0]!.home_entrant_id!;
    const byeFx: OracleFixture = { round: 1, home: holder, away: null, winner: holder };
    await expect
      .poll(async () => (await standings()).find((row) => row.entrantId === holder)?.points, {
        timeout: 20_000,
        message: "the boardgame bye pays the declared win",
      })
      .toBe(tablePoints([byeFx], rule).get(holder));
    for (const f of await boards(1)) await play(f);
    await pair(2);
    const L1 = await late(1);
    expect([L1.le.case, L1.le.round], "(a) before any board of round 2 starts: L1 takes round 2's bye").toEqual(["a", 2]);
    for (const f of await boards(2)) await play(f);
    await pair(3);
    const b3 = await boards(3);
    await scoreAt(request, b3[0]!.id, "core.start");
    const L2 = await late(2);
    expect([L2.le.case, L2.le.round], "(c) a started round with no bye: L2 joins round 4").toEqual(["c", 4]);
    for (const f of b3) await play(f, f.id === b3[0]!.id);
    await pair(4);
    const b4 = await boards(4);
    await scoreAt(request, b4[0]!.id, "core.start");
    const L3 = await late(3);
    expect([L3.le.case, L3.le.round], "(b) a started round with a bye: L3 takes round 4's").toEqual(["b", 4]);
    for (const f of await boards(4)) await play(f, f.id === b4[0]!.id);
    expect(played, "every board recorded").toHaveLength(BOARDS_PLAYED);
    expect(
      standingBye(await rows()).map((f) => [f.round_no, f.home_entrant_id]),
      "only round 1's bye stands: (a) and (b) took rounds 2 and 4's",
    ).toEqual([[1, holder]]);
    const all = [...played, byeFx];

    // P-A5 over the played boards, home = White, per entrant (a bye carries no colour). X-SW-11 (FIDE C.04.3 Art. 1.8; the app
    // pairs the stage's last round with `finalRoundMaxScore` = (rounds - 1) x a win): in the FINAL round a board with a
    // topscorer - over half that maximum going into it - is exempt from the limits on BOTH sides, so those two entrants' final
    // games are not judged. The win is the declared rule's, through the oracle, never the product's maximum.
    // At four games or fewer, a colour difference over 2 needs three in a row, so the run check carries P-A5's difference
    // clause too (review m7). Its third clause - two non-topscorers with the same absolute preference never meet - is the
    // limits read a round later: such a board leaves one of them three in a row, which the run check reads.
    const winPts = tablePoints([{ round: 1, home: "w", away: "l", winner: "w" }], rule).get("w")!;
    const before = tablePoints(
      all.filter((f) => f.round < ROUNDS),
      rule,
    );
    const topscorers = new Set([...before].filter(([, p]) => p > ((ROUNDS - 1) * winPts) / 2).map(([id]) => id));
    const exempt = new Set(
      played.filter((f) => f.round === ROUNDS && (topscorers.has(f.home) || topscorers.has(f.away!))).flatMap((f) => [f.home, f.away!]),
    );
    expect(exempt.size, "premise: the final round seats a topscorer (seed 1 wins every game), so X-SW-11 is reached").toBeGreaterThan(0);
    const colours = new Map<string, ("W" | "B")[]>();
    for (const f of [...played].sort((a, b) => a.round - b.round)) {
      colours.set(f.home, [...(colours.get(f.home) ?? []), "W"]);
      colours.set(f.away!, [...(colours.get(f.away!) ?? []), "B"]);
    }
    const table = await standings();
    let judged = 0;
    for (const [id, seq] of colours) {
      const read = exempt.has(id) ? seq.slice(0, -1) : seq;
      judged += read.length;
      expect(read.join(""), `${names.get(id)}: no colour three times running${exempt.has(id) ? " before its exempt final board" : ""} (P-A5)`).not.toMatch(/WWW|BBB/);
      const whites = seq.filter((c) => c === "W").length;
      const m = table.find((row) => row.entrantId === id)!.metrics;
      expect([m.white, m.black], `${names.get(id)}: the table's colour count is the seats'`).toEqual([whites, seq.length - whites]);
    }
    expect(colours.size, "anti-vacuity: every entrant's colours checked").toBe(SEEDED + LATE);
    expect(judged, "anti-vacuity: every game judged but each exempt entrant's final one").toBe(2 * BOARDS_PLAYED - exempt.size);

    // The absences: L1 missed round 1 (added in round 2, which it played); L2 and L3 rounds 1-3 (added in rounds 3 and 4, both
    // play round 4).
    const opts: LedgerOpts = { rule, rounds: ROUNDS, drawPoints, absent: new Map([[L1.id, [1]], [L2.id, [1, 2, 3]], [L3.id, [1, 2, 3]]]) };
    const ladders = (fx: readonly OracleFixture[], id: string) => ({
      buchholz: display(buchholz(fx, id, opts), rule.unit),
      buchholz_cut1: display(buchholzCut1(fx, id, opts), rule.unit),
      sberger: display(sonnebornBerger(fx, id, opts), rule.unit),
    });
    const want = Object.fromEntries([...names.keys()].map((id) => [names.get(id)!, ladders(all, id)]));
    expect(Object.keys(want), "anti-vacuity: every entrant judged").toHaveLength(SEEDED + LATE);
    // The bye is in the numbers: read without it, the oracle's own ladders for its holder fall, so a table that dropped the bye
    // (or scored it as a loss) could not match.
    const blind = ladders(played, holder);
    const seen = want[names.get(holder)!]!;
    expect(blind.buchholz, "the standing bye adds to its holder's Buchholz").toBeLessThan(seen.buchholz);
    expect(blind.sberger, "the standing bye adds to its holder's SB, as a win").toBeLessThan(seen.sberger);
    expect(
      Object.fromEntries(
        table.map((row) => [names.get(row.entrantId)!, { buchholz: row.metrics.buchholz, buchholz_cut1: row.metrics.buchholz_cut1, sberger: row.metrics.sberger }]),
      ),
      "the standings carry the oracle's Buchholz, Cut-1 and SB, in display points",
    ).toEqual(want);
    // And on the public table a visitor reads.
    const div = await apiJson<{ competition_id: string; slug: string }>(request, `/api/v1/divisions/${r.divisionId}`);
    expect(div.status, JSON.stringify(div.error)).toBe(200);
    const made = await apiJson<{ visibility: string }>(request, `/api/v1/competitions/${div.data!.competition_id}`, "PATCH", { visibility: "public" });
    expect([made.status, made.data?.visibility], JSON.stringify(made.error)).toEqual([200, "public"]);
    const visitor = await spectator(browser, { width: 1280, height: 900 });
    const hubUrl = `${await sharedPath(request, div.data!.competition_id)}?tab=table`;
    await expect
      .poll(
        async () => {
          const got = await hubRows(visitor, hubUrl, div.data!.slug);
          if (typeof got === "string") return got;
          return Object.fromEntries(
            got.map((row) => [
              names.get(whoIs(row.th, names))!,
              { buchholz: num(row.cells.buchholz), buchholz_cut1: num(row.cells.buchholz_cut1), sberger: num(row.cells.sberger) },
            ]),
          );
        },
        { timeout: 60_000, intervals: [2_000], message: "the public table prints the oracle's ladders" },
      )
      .toEqual(want);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// X-SW-10 on the desk: the look-ahead's amber line. Positive: the brute-force chess history UNPAIRABLE_NEXT_N8 (seed 8078287,
// eight players, six rounds; proved by the oracle in swiss-look-ahead.test.ts and over the wire by smoke check 8) written onto
// the stage's own shells, every board then PLAYED, and Pair next pressed on the desk for round 5: the line names rounds 5 and 6.
// Negatives: the same stage's round 1 (look-ahead asked, next round pairable), and the plan's 6 x 5 Swiss pairing round 3.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("X-SW-10 the desk warns when the next round cannot be paired", () => {
  // Not serial (review m8): the two tests build their own stages, so a red positive must not skip the negative (class 21).

  /** [home index, away index, result] per board, p0..p7 = seeds 1..8, `h`/`a` the side that wins, `d` a draw. */
  const HISTORY: readonly (readonly (readonly [number, number, "h" | "a" | "d"])[])[] = [
    [[6, 3, "a"], [4, 1, "h"], [0, 5, "a"], [7, 2, "d"]],
    [[5, 3, "a"], [7, 4, "a"], [2, 1, "h"], [0, 6, "a"]],
    [[3, 4, "a"], [5, 2, "d"], [6, 7, "a"], [1, 0, "d"]],
    [[4, 2, "a"], [7, 5, "h"], [1, 6, "a"], [3, 0, "h"]],
  ];
  const BOARDS = HISTORY.flat().length;
  const warning = (page: Page) => page.getByTestId("swiss-next-round-warning");

  test("round 5 of the seed-8078287 chess history: the amber line names rounds 5 and 6; round 1 of the same stage shows none", async ({ page, request }) => {
    test.setTimeout(Math.max(FLOOR_MS, (12 + BOARDS * CALLS_PER_CHESS_BOARD + 10) * API_CALL_MS + 4 * STEP_MS));
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `X-SW-10 ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Look-ahead",
      sport_key: "boardgame",
      variant_key: "classical",
      config: {},
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const made = await apiJson<{ id: string; seed: number }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `X-SW-10 P${i + 1} ${TAG}`, seed: i + 1, members: [] })),
    );
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const ids = [...made.data!].sort((a, b) => a.seed - b.seed).map((e) => e.id);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 6, chess: true } });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);
    const rows = async () => (await stageFixtures(request, divisionId, stageId)) as SwissRow[];

    // The negative on this stage: round 1, six rounds declared (above the safe maximum 4, not the last), so the Pair asks the
    // engine to look ahead - and round 2 is pairable, so the answer carries no verdict and the desk says nothing.
    const first = await pairOnDesk(page, request, divisionId, stageId, 1);
    expect(first, "a pairable next round leaks no field").not.toHaveProperty("swiss_next_round");
    const r1 = seated((await rows()).filter((f) => f.round_no === 1));
    expect(r1, "round 1 seated").toHaveLength(4);
    await expect(page.locator(`li[data-fixture-no="${r1[0]!.fixture_no}"]`), "the Pair landed on the desk").toContainText(`X-SW-10 P`, { timeout: 20_000 });
    await expect(warning(page)).toHaveCount(0);

    // The history over rounds 1-4 (no route seats a board by hand), then every board PLAYED through the scorer's events.
    const written = await withDb(async (sql) => {
      let n = 0;
      for (const [i, round] of HISTORY.entries()) {
        for (const [b, [home, away]] of round.entries()) {
          n += (
            await sql`update fixtures set home_entrant_id = ${ids[home]!}, away_entrant_id = ${ids[away]!}, status = 'scheduled', outcome = null
                      where stage_id = ${stageId} and ext_key = ${`sw-r${i + 1}-b${b + 1}`}`
          ).count;
        }
      }
      return n;
    });
    expect(written, "the history lands on the minted shells").toBe(BOARDS);
    const shells = await rows();
    for (const [i, round] of HISTORY.entries()) {
      const bs = seated(shells.filter((f) => f.round_no === i + 1));
      for (const [b, [home, away, res]] of round.entries()) {
        const f = bs[b]!;
        expect([f.home_entrant_id, f.away_entrant_id], `round ${i + 1} board ${b + 1} as written`).toEqual([ids[home], ids[away]]);
        await scoreAt(request, f.id, "core.start");
        await scoreAt(request, f.id, "boardgame.result", res === "d" ? { winner: null, method: "agreement" } : { winner: res === "h" ? ids[home] : ids[away], method: "resign" });
      }
    }

    const fifth = await pairOnDesk(page, request, divisionId, stageId, 5);
    expect([fifth.swiss_next_round, fifth.swiss_paired_round], "the engine's verdict rides on the answer").toEqual(["unpairable", 5]);
    await expect(warning(page)).toHaveText(fill("swiss.warning.nextRoundUnpairable", { round: 5, next: 6 }), { timeout: 20_000 });
    expect(seated((await rows()).filter((f) => f.round_no === 5)), "and round 5 is seated all the same").toHaveLength(4);
  });

  test("a 6 x 5 Swiss pairs round 3 with no next-round warning (badminton)", async ({ page, request }) => {
    test.setTimeout(Math.max(FLOOR_MS, (12 + 6 * CALLS_PER_BADMINTON_BOARD + 10) * API_CALL_MS + 3 * STEP_MS));
    // Five rounds for six players: above the safe maximum 3, so round 3 (not the last) asks the engine to look ahead.
    const r = await startedSwiss(request, BADMINTON, 6, 5, "X-SW-10N");
    for (const f of await r.boards(1)) await BADMINTON.win(request, f, f.home_entrant_id!);
    const second = await apiJson(request, `/api/v1/stages/${r.stageId}/generate`, "POST");
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    for (const f of await r.boards(2)) await BADMINTON.win(request, f, f.home_entrant_id!);
    const third = await pairOnDesk(page, request, r.divisionId, r.stageId, 3);
    expect(third, "a pairable next round leaks no field").not.toHaveProperty("swiss_next_round");
    const r3 = await r.boards(3);
    expect(r3, "round 3 seated").toHaveLength(3);
    await showAllFixtures(page);
    await expect(page.locator(`li[data-fixture-no="${r3[0]!.fixture_no}"]`), "the Pair landed on the desk").toContainText(r.nameOf.get(r3[0]!.home_entrant_id!)!, {
      timeout: 20_000,
    });
    await expect(warning(page)).toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The goals family on the public table (Task 3, ST-G21): a football Swiss prints Buchholz and "Opp diff" (the opponents'
// collective goal difference, rulebook §5), each the oracle's on every row. Six teams, two rounds, every board played to full
// time through the scorer's events; no draws and no byes (the rulebook gives opp_diff no unplayed-round value).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("football Swiss: Opp diff and Buchholz on the public table", () => {
  test.describe.configure({ mode: "serial" });
  test.afterEach(async () => {
    await closeOpenContexts();
  });

  /** Goals per board, by round and board order: no draw, and margins that differ so the opponents' sums differ. */
  const GOALS: readonly (readonly (readonly [number, number])[])[] = [
    [[3, 0], [1, 2], [2, 1]],
    [[0, 2], [4, 1], [1, 0]],
  ];
  /** Start, every goal, half and full time: each a state read and a POST. */
  const CALLS = GOALS.flat().reduce((s, [h, a]) => s + 2 * (1 + h + a + 2), 0);

  test("six teams, two rounds: every row's Buchholz and Opp diff are the oracle's, under the owner's words", async ({ request, browser }) => {
    test.setTimeout(Math.max(FLOOR_MS, (12 + CALLS + 10) * API_CALL_MS + 2 * STEP_MS));
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `SW-L10 FC ${TAG}`, visibility: "public" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Football",
      sport_key: "football",
      variant_key: "11-a-side",
      config: {},
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const made = await apiJson<{ id: string; display_name: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      ["A", "B", "C", "D", "E", "F"].map((n, i) => ({ kind: "team", display_name: `SW-L10 ${n} FC ${TAG}`, seed: i + 1 })),
    );
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const names = new Map(made.data!.map((e) => [e.id, e.display_name]));
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: GOALS.length } });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    const { rule, drawPoints } = await declared(request, stageId);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);

    const played: OracleFixture[] = [];
    for (const [i, round] of GOALS.entries()) {
      const paired = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
      expect(paired.status, JSON.stringify(paired.error)).toBe(200);
      const boards = seated(((await stageFixtures(request, divisionId, stageId)) as SwissRow[]).filter((f) => f.round_no === i + 1));
      expect(boards, `round ${i + 1}: three boards`).toHaveLength(round.length);
      for (const [b, [h, a]] of round.entries()) {
        const f = boards[b]!;
        await scoreAt(request, f.id, "core.start");
        for (let g = 0; g < h; g++) await scoreAt(request, f.id, "football.goal", { by: f.home_entrant_id });
        for (let g = 0; g < a; g++) await scoreAt(request, f.id, "football.goal", { by: f.away_entrant_id });
        await scoreAt(request, f.id, "football.period", { phase: "HT" });
        await scoreAt(request, f.id, "football.period", { phase: "FT" });
        played.push({ round: i + 1, home: f.home_entrant_id!, away: f.away_entrant_id!, winner: h > a ? f.home_entrant_id! : f.away_entrant_id!, goals: [h, a] });
      }
    }
    const opts: LedgerOpts = { rule, rounds: GOALS.length, drawPoints };
    const want = Object.fromEntries([...names].map(([id, n]) => [n, { buchholz: display(buchholz(played, id, opts), rule.unit), opp_diff: oppDiff(played, id) }]));
    // Anti-vacuity: a table of equal sums would pass a column that printed a constant.
    expect(new Set(Object.values(want).map((w) => w.opp_diff)).size, "premise: the opponents' sums differ").toBeGreaterThan(1);
    expect(new Set(Object.values(want).map((w) => w.buchholz)).size, "premise: the Buchholz values differ").toBeGreaterThan(1);

    const visitor = await spectator(browser, { width: 1280, height: 900 });
    const hubUrl = `${await sharedPath(request, comp.data!.id)}?tab=table`;
    await expect
      .poll(
        async () => {
          const got = await hubRows(visitor, hubUrl, div.data!.slug);
          if (typeof got === "string") return got;
          return Object.fromEntries(got.map((row) => [names.get(whoIs(row.th, names))!, { buchholz: num(row.cells.buchholz), opp_diff: num(row.cells.opp_diff) }]));
        },
        { timeout: 60_000, intervals: [2_000], message: "the public table prints the oracle's Buchholz and Opp diff" },
      )
      .toEqual(want);
    // The owner's words (Q2, sport-neutral: a football table does not say "goal"), typed here, not read from the dictionary.
    const headers = await hubHeaders(visitor, div.data!.slug);
    expect(headers.opp_diff, "the Opp diff column under its words").toEqual({ abbr: "Opp diff", title: "Opponents' score difference" });
    expect(headers.buchholz?.abbr).toBe("Buchholz");
  });
});
