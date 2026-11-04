// W3 app-B Task 9b: a Swiss round is scheduled only after the previous round ENDS (X-SW-31), and the rounds of an
// unpaired Swiss stage keep the player limits as round limits (owner rulings 255-256).
//
// The engine half (engine 2.0.0, T10b/T10c) lives on the scheduling `Assignment` and `SchedulableFixture`:
// `roundBarrier: "end"` (round r+1 starts no earlier than round r's LAST board ends), `roundGapMinutes` (the division's
// minimum rest, added to that end) and `roundsPerDayCap` (the rounds one calendar day may hold). All three are PER ROW,
// CONSTANT PER SEQUENCE, and a sequence whose rows disagree is CONFIG_INVALID (`roundRulesBySequence`). So the app half
// is a producer problem: every place the app builds an Assignment or a SchedulableFixture for a Swiss stage must stamp
// the same three fields, and a place that forgets either leaves the barrier off a board (a silent start floor) or, beside
// a stamped row, turns every Swiss edit into a 422.
//
// THE SWEEP. The first describe drives every producer through its REAL usecase entry and records what reaches the
// engine (the engine functions are spied and called through, never replaced), then judges every round-bearing row by the
// kind of the stage it belongs to, read from the `stages` table. A producer that stamps nothing, or stamps a league row,
// fails by name. It counts: producers driven, rows judged, and zero of either is a failure.
//
// Every pass in the first five describes runs the GREEDY fallback (a closed port), so what they prove is the app half
// and the greedy / verifier side. The last two describes cover the rest: "the wire" drives the REAL `toRequest` and
// reads the request it builds (no network); "the live solver" needs the placement service at the vendored pin
// (`PLACEMENT_SERVICE_HOST`, always set in the CI usecases job) and proves the CP-SAT side answers a Swiss build SOLVED
// - the unpaired shells accepted, the barrier, gap and cap and the pins' day all honoured - instead of refusing it.
//
// single-sport: badminton - the rules read stage kind, round_no, the slot columns and the division's settings, never a
// sport field.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EngineError } from "@seazn/engine/core";
import type { Assignment } from "@seazn/engine/scheduling";
import * as engine from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import { isSwissByeShellExtKey } from "@/lib/swiss-shell";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { formatBoardConflictDetail } from "@/components/v2/board/conflict-detail-format";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { ScheduleConflict } from "@/server/api-v1/schemas";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { applyCompetitionSchedule } from "../competition-schedule-apply";
import { buildCompetitionPack, toJointEngineAssignments, toJointSchedulableFixtures } from "../competition-schedule-ai";
import { buildSchedulePack, toEngineAssignments, toSchedulableFixtures } from "../schedule-ai";
import {
  applySchedule,
  autoSchedule,
  moveFixture,
  putScheduleSettings,
  validateSchedule,
  type AutoScheduleOut,
} from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { createCourt, createVenue } from "../venues";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const START = "2030-08-01T09:00:00.000Z";
const END_AT = "2030-08-09T23:59:00.000Z";
const MATCH_MINUTES = 30;
const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;
/** A host nothing listens on: the real placement client dials it, fails `unavailable`, and the engine ships greedy. */
const CLOSED_PORT_HOST = "127.0.0.1:1";

const boardsPerRound = (players: number) => Math.floor(players / 2);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Rig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  courts: string[];
  /** The division's settings as the organiser saved them, which the sweep derives its expected values from. */
  rest: number;
  cap: number;
}

/**
 * A badminton division of `players` individuals and `courts` courts, schedule settings saved: 09:00 UTC, 30-minute
 * matches, a window of four days, `rest` minutes of minimum rest, and - when `cap` is above 0 - the durable rule "no
 * player plays more than `cap` matches a day" (`max_fixtures_per_day`, scope `every_person`, the only per-player daily
 * cap a division can store). No stage yet.
 */
async function division(opts: { players: number; courts: number; rest?: number; cap?: number }): Promise<Rig> {
  const rest = opts.rest ?? 0;
  const cap = opts.cap ?? 0;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss barrier " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const div = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  await createEntrants(
    auth,
    div.id,
    Array.from({ length: opts.players }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const venue = await createVenue(auth, { name: "Hall", sort: 0 });
  const ids: string[] = [];
  for (let i = 0; i < opts.courts; i++) ids.push((await createCourt(auth, venue.id, { name: `Court ${i + 1}`, sort: i, tags: [] })).id);
  await putScheduleSettings(auth, div.id, {
    config: {
      startAt: START,
      endAt: END_AT,
      matchMinutes: MATCH_MINUTES,
      gapMinutes: 0,
      courts: ids,
      perEntrantMinRest: rest,
      blackouts: [],
      sessionWindows: [],
      constraints: {
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "off" as const,
        parallelism: "mixed" as const,
        crossPersonClash: "warn" as const,
        hard: [
          // An explicit whole-division cap, so the auto pass's DEFAULT day spread (ceil(fixtures / days) a day,
          // division-wide, applied only when none is set) does not stack the league's board and the Swiss stage's onto
          // the same few days and starve the second stage of slots. Loose on purpose: this rig tests round rules.
          { type: "max_fixtures_per_day" as const, count: 100, scope: { kind: "division" as const, divisionId: div.id } },
          ...(cap > 0
            ? [{ type: "max_fixtures_per_day" as const, count: cap, scope: { kind: "every_person" as const } }]
            : []),
        ],
      },
    },
    tz: "UTC",
  });
  // The premise every day-keyed assertion below rests on: the org zone is UTC, so a calendar day is the UTC date.
  const [org] = await sql<{ timezone: string | null }[]>`select timezone from organizations where id = ${auth.orgId}`;
  expect(org?.timezone ?? "UTC", "rig: the org zone is UTC").toBe("UTC");
  return { auth, competitionId: comp.id, divisionId: div.id, courts: ids, rest, cap };
}

interface Row {
  id: string;
  ext_key: string | null;
  stage_id: string;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: Date | null;
  court_id: string | null;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, stage_id, round_no, status, home_entrant_id, away_entrant_id, scheduled_at, court_id
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;

/** Mint every round's shells, then Pair round 1: round 1 seated, every later round TBD v TBD. */
async function swissStage(rig: Rig, rounds: number, seq: number): Promise<string> {
  const players = (await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${rig.divisionId}`)[0]!.n;
  const [stage] = await createStages(rig.auth, rig.divisionId, [
    { seq, kind: "swiss", name: "Swiss", config: { rounds }, progression: null },
  ]);
  await generateStageFixtures(rig.auth, stage!.id); // mint
  await generateStageFixtures(rig.auth, stage!.id); // Pair round 1
  const rows = (await rowsOf(stage!.id)).filter((r) => !isSwissByeShellExtKey(r.ext_key));
  const r1 = rows.filter((r) => r.round_no === 1 && r.home_entrant_id !== null && r.away_entrant_id !== null);
  expect(r1.length, "rig: round 1 is paired").toBe(boardsPerRound(players));
  return stage!.id;
}

async function leagueStage(rig: Rig, seq: number): Promise<string> {
  const [stage] = await createStages(rig.auth, rig.divisionId, [{ seq, kind: "league", name: "League", config: {}, progression: null }]);
  await generateStageFixtures(rig.auth, stage!.id);
  return stage!.id;
}

const assignmentsOf = (out: AutoScheduleOut) =>
  out.assignments.map((a) => ({ fixture_id: a.fixture_id, scheduled_at: a.scheduled_at, court_id: a.court_id }));

async function applyAuto(rig: Rig, stageId: string, out: AutoScheduleOut): Promise<void> {
  await applySchedule(rig.auth, stageId, { assignments: assignmentsOf(out), source: "auto" });
}

// ---------------------------------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------------------------------

type EngineRow = Pick<Assignment, "roundBarrier" | "roundGapMinutes" | "roundsPerDayCap" | "roundNo" | "stageId"> & {
  id?: string;
  fixtureId?: string;
};

interface Seen {
  site: string;
  row: EngineRow;
}

/** Every call the app makes to these engine functions, recorded and called through. */
function recordEngineCalls(sink: Seen[], label: () => string) {
  const note = (via: string, rows: readonly unknown[] | undefined) => {
    for (const row of rows ?? []) sink.push({ site: `${label()} / ${via}`, row: row as EngineRow });
  };
  vi.spyOn(engine, "validateAssignments").mockImplementation(((...args: Parameters<typeof engine.validateAssignments>) => {
    note("validateAssignments(assignments)", args[0]);
    note("validateAssignments(existing)", args[2]);
    return realValidate(...args);
  }) as typeof engine.validateAssignments);
  vi.spyOn(engine, "roundOrderConflicts").mockImplementation(((...args: Parameters<typeof engine.roundOrderConflicts>) => {
    note("roundOrderConflicts(rows)", args[0]);
    return realRoundOrder(...args);
  }) as typeof engine.roundOrderConflicts);
  vi.spyOn(engine, "slotFixtures").mockImplementation(((...args: Parameters<typeof engine.slotFixtures>) => {
    note("slotFixtures(fixtures)", args[0].fixtures);
    note("slotFixtures(existing)", args[0].existing);
    return realSlot(...args);
  }) as typeof engine.slotFixtures);
  vi.spyOn(engine, "buildSchedule").mockImplementation((async (...args: Parameters<typeof engine.buildSchedule>) => {
    note("buildSchedule(fixtures)", args[0].fixtures);
    note("buildSchedule(existing)", args[0].existing);
    note("buildSchedule(current)", args[0].current);
    return realBuild(...args);
  }) as typeof engine.buildSchedule);
}

const realValidate = engine.validateAssignments;
const realRoundOrder = engine.roundOrderConflicts;
const realBuild = engine.buildSchedule;
const realSlot = engine.slotFixtures;

describe.runIf(HAS_DB)("X-SW-31 every producer stamps the round rules of a Swiss stage and of nothing else", () => {
  it("every Assignment and SchedulableFixture producer: roundBarrier end, the division's gap and cap on Swiss rows; nothing on league rows", async () => {
    // One division holding BOTH a league and a Swiss stage, so the same producer is judged on the stamp (Swiss) and on its
    // absence (league). Six players: three boards a round. Rest 30, per-player cap 2.
    const rig = await division({ players: 6, courts: 3, rest: 30, cap: 2 });
    const league = await leagueStage(rig, 1);
    const swiss = await swissStage(rig, 3, 2);
    const kindOf = new Map((await sql<{ id: string; kind: string }[]>`select id, kind from stages where division_id = ${rig.divisionId}`).map((s) => [s.id, s.kind]));
    expect([...kindOf.values()].sort(), "rig: one league stage and one swiss stage").toEqual(["league", "swiss"]);

    const seen: Seen[] = [];
    let current = "setup";
    recordEngineCalls(seen, () => current);
    // The league first (so its rows are placed, and reach the Swiss passes as obstacles); not judged: it is the setup.
    const leagueOut = await autoSchedule(rig.auth, league, { only_unlocked: false, mode: "build" });
    await applyAuto(rig, league, leagueOut);
    seen.length = 0;
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);

    const drive = async <T,>(label: string, run: () => Promise<T>): Promise<T> => {
      current = label;
      return run();
    };

    const built = await drive("autoSchedule build", () => autoSchedule(rig.auth, swiss, { only_unlocked: false, mode: "build" }));
    expect(built.assignments.length, `rig: the build places every swiss board (conflicts: ${JSON.stringify(built.conflicts.slice(0, 3))})`).toBe(3 * boardsPerRound(6));
    await drive("applySchedule", () => applyAuto(rig, swiss, built));
    await drive("autoSchedule polish", () => autoSchedule(rig.auth, swiss, { only_unlocked: false, mode: "polish" }));
    // A reflow over a FULL board short-circuits ("nothing left to place": it verifies the untouched board and never asks
    // the placer), so one round-3 board is taken off the board first; the reflow then places it among the others.
    const onBoard = (await rowsOf(swiss)).filter((r) => r.scheduled_at !== null);
    const lifted = onBoard.filter((r) => r.round_no === 3).at(-1)!;
    await sql`update fixtures set scheduled_at = null, court_id = null, venue_id = null where id = ${lifted.id}`;
    const reflowed = await drive("autoSchedule reflow", () => autoSchedule(rig.auth, swiss, { only_unlocked: true, mode: "reflow" }));
    await drive("applySchedule (reflow)", () => applyAuto(rig, swiss, reflowed));
    await drive("validateSchedule", () => validateSchedule(rig.auth, rig.divisionId));
    // Round 1 played: from here its boards are fixed occupancy of the stage, handed to the placer as `existing` rows of
    // the SAME sequence as the boards being placed.
    await playRound(rig, (await rowsOf(swiss)).filter((r) => r.round_no === 1));
    await drive("autoSchedule build after R1 played", () => autoSchedule(rig.auth, swiss, { only_unlocked: false, mode: "build" }));

    // A move of one Swiss board and one league board: refused or not is beside the point, what reaches the verifier is not.
    const swissRows = (await rowsOf(swiss)).filter((r) => r.scheduled_at !== null && r.status !== "decided");
    const leagueRows = (await rowsOf(league)).filter((r) => r.scheduled_at !== null);
    expect(swissRows.length, "rig: the Swiss board is placed").toBeGreaterThan(0);
    expect(leagueRows.length, "rig: the league board is placed").toBeGreaterThan(0);
    const later = (r: Row) => ({ scheduled_at: new Date(r.scheduled_at!.getTime() + 5 * MIN).toISOString(), court_id: r.court_id! });
    await drive("moveFixture (swiss)", () => moveFixture(rig.auth, swissRows.at(-1)!.id, later(swissRows.at(-1)!)).catch(() => undefined));
    await drive("moveFixture (league)", () => moveFixture(rig.auth, leagueRows.at(-1)!.id, later(leagueRows.at(-1)!)).catch(() => undefined));

    // The joint apply, over the division's own placed boards (every fixture re-listed where it sits).
    const placed = [...swissRows, ...leagueRows];
    const [{ seq }] = await sql<{ seq: string | number }[]>`select seq from divisions where id = ${rig.divisionId}`;
    await drive("applyCompetitionSchedule", () =>
      applyCompetitionSchedule(rig.auth, rig.competitionId, {
        divisions: [
          {
            division_id: rig.divisionId,
            expected_seq: Number(seq),
            assignments: placed.map((r) => ({ fixture_id: r.id, scheduled_at: r.scheduled_at!.toISOString(), court_id: r.court_id! })),
          },
        ],
        source: "ai",
        ai: { instruction: "sweep", summary: "sweep", model: "none", repair_rounds: 0 },
      }).catch(() => undefined),
    );

    // The AI packs: built off the real division, the engine-facing adapters read back. (Pure functions, so their output
    // is the producer; no spy is needed.)
    const aiPlan = (rows: Row[]) => ({
      assignments: rows.map((r) => ({ fixture_id: r.id, scheduled_at: r.scheduled_at!.toISOString(), court_label: r.court_id! })),
      unschedulable: [],
      explanations: [],
      summary: "",
    });
    // The draft placer (`slotFixtures`) runs INSIDE the pack build in generate mode, so the build is a site of its own.
    current = "AI single pack draft";
    const { pack } = await buildSchedulePack(rig.auth, rig.divisionId, { now: Date.parse(START) - DAY_MS, mode: "generate", instruction: "" });
    const movable = new Set(pack.fixtures.movable.map((f) => f.id));
    const packRows = placed.filter((r) => movable.has(r.id));
    expect(packRows.length, "rig: the pack holds the division's placed fixtures as movable").toBeGreaterThan(0);
    current = "AI single pack";
    for (const row of toEngineAssignments(aiPlan(packRows), pack)) seen.push({ site: `${current} / toEngineAssignments`, row });
    for (const row of toSchedulableFixtures(pack)) seen.push({ site: `${current} / toSchedulableFixtures`, row });
    current = "AI joint pack draft";
    const joint = await buildCompetitionPack(rig.auth, rig.competitionId, [rig.divisionId], { now: Date.parse(START) - DAY_MS, mode: "generate", instruction: "" });
    current = "AI joint pack";
    for (const row of toJointEngineAssignments(aiPlan(packRows), joint.pack)) seen.push({ site: `${current} / toJointEngineAssignments`, row });
    for (const row of toJointSchedulableFixtures(joint.pack)) seen.push({ site: `${current} / toJointSchedulableFixtures`, row });

    // ---- the judgement ----
    type Tally = { swiss: number; league: number };
    const bySite = new Map<string, Tally>();
    const problemCount = new Map<string, number>();
    const problem = (msg: string) => problemCount.set(msg, (problemCount.get(msg) ?? 0) + 1);
    let judged = 0;
    for (const { site, row } of seen) {
      if (row.roundNo === undefined) continue; // a row with no round is in no sequence (a bye, a bracket, an obstacle)
      const kind = row.stageId === undefined ? undefined : kindOf.get(row.stageId);
      if (kind === undefined) {
        problem(`${site}: a round-bearing row (${row.fixtureId ?? row.id}) names no stage of this division`);
        continue;
      }
      judged++;
      const tally = bySite.get(site) ?? { swiss: 0, league: 0 };
      if (kind === "swiss") {
        tally.swiss++;
        if (row.roundBarrier !== "end") problem(`${site}: a swiss row has roundBarrier ${JSON.stringify(row.roundBarrier)}`);
        if (row.roundGapMinutes !== rig.rest) problem(`${site}: a swiss row has roundGapMinutes ${row.roundGapMinutes} (the division's rest is ${rig.rest})`);
        if (row.roundsPerDayCap !== rig.cap) problem(`${site}: a swiss row has roundsPerDayCap ${row.roundsPerDayCap} (the division's cap is ${rig.cap})`);
      } else {
        tally.league++;
        for (const key of ["roundBarrier", "roundGapMinutes", "roundsPerDayCap"] as const) {
          // Absent, not "set to undefined": the key itself must not be on the row.
          if (Object.hasOwn(row, key)) problem(`${site}: a ${kind} row carries ${key} ${JSON.stringify(row[key])}`);
        }
      }
      bySite.set(site, tally);
    }
    expect([...problemCount].map(([m, n]) => `${m} x${n}`), "no producer mis-stamps a round-bearing row").toEqual([]);

    // Each site that the rig makes round-bearing for a Swiss stage must have shown at least one such row: a producer that
    // never reached the engine (or reached it with no round) is a producer nothing judged. Pinned by name.
    const SWISS_SITES = [
      "autoSchedule build / buildSchedule(fixtures)",
      "autoSchedule build after R1 played / buildSchedule(existing)",
      "applySchedule / validateAssignments(assignments)",
      "applySchedule / roundOrderConflicts(rows)",
      "autoSchedule polish / buildSchedule(fixtures)",
      "autoSchedule reflow / buildSchedule(fixtures)",
      "autoSchedule reflow / buildSchedule(current)",
      "validateSchedule / validateAssignments(assignments)",
      "moveFixture (swiss) / validateAssignments(assignments)",
      "moveFixture (swiss) / roundOrderConflicts(rows)",
      "applyCompetitionSchedule / validateAssignments(assignments)",
      "applyCompetitionSchedule / roundOrderConflicts(rows)",
      "AI single pack draft / slotFixtures(fixtures)",
      "AI joint pack draft / slotFixtures(fixtures)",
      "AI single pack / toEngineAssignments",
      "AI single pack / toSchedulableFixtures",
      "AI joint pack / toJointEngineAssignments",
      "AI joint pack / toJointSchedulableFixtures",
    ];
    // ...and the sites that carry a league row beside it (an obstacle, a sibling, an untouched board of the division).
    const LEAGUE_SITES = [
      "autoSchedule build / buildSchedule(existing)",
      "applySchedule / validateAssignments(existing)",
      "validateSchedule / validateAssignments(assignments)",
      "moveFixture (swiss) / validateAssignments(existing)",
      "moveFixture (league) / validateAssignments(assignments)",
      "applyCompetitionSchedule / validateAssignments(assignments)",
      "AI single pack draft / slotFixtures(fixtures)",
      "AI joint pack draft / slotFixtures(fixtures)",
      "AI single pack / toSchedulableFixtures",
      "AI joint pack / toJointSchedulableFixtures",
    ];
    const missing = [
      ...SWISS_SITES.filter((s) => (bySite.get(s)?.swiss ?? 0) === 0).map((s) => `${s}: no swiss row`),
      ...LEAGUE_SITES.filter((s) => (bySite.get(s)?.league ?? 0) === 0).map((s) => `${s}: no league row`),
    ];
    expect(missing.length, `every site of the sweep judged the rows it exists to stamp; missing: ${missing.join("; ")}`).toBe(0);
    expect(SWISS_SITES.length + LEAGUE_SITES.length, "anti-vacuity: the sweep names its sites").toBeGreaterThan(0);
    expect(judged, "anti-vacuity: round-bearing rows were judged").toBeGreaterThan(SWISS_SITES.length);
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// The behaviours the stamps buy
// ---------------------------------------------------------------------------------------------------------------------

const at = (minutesFromStart: number) => new Date(Date.parse(START) + minutesFromStart * MIN).toISOString();
const msAt = (minutesFromStart: number) => Date.parse(START) + minutesFromStart * MIN;

/** A Swiss-only division: mint, Pair round 1. */
async function swissOnly(opts: { players: number; courts: number; rounds: number; rest?: number; cap?: number }) {
  const rig = await division(opts);
  const stageId = await swissStage(rig, opts.rounds, 1);
  return { rig, stageId };
}

/** Round 1's boards laid by hand: the first at 10:00 on court 1, the second at 09:00 on court 2. Its last board STARTS at
 *  10:00 and ENDS at 10:30, which is the whole differential: a start floor lets round 2 begin at 10:00, an end barrier
 *  not before 10:30. */
async function layRoundOne(rig: Rig, stageId: string): Promise<{ lastStart: number; lastEnd: number; boards: Row[] }> {
  const boards = (await rowsOf(stageId)).filter((r) => r.round_no === 1 && !isSwissByeShellExtKey(r.ext_key));
  expect(boards.length, "rig: round 1 has two boards").toBe(2);
  await applySchedule(rig.auth, stageId, {
    assignments: [
      { fixture_id: boards[0]!.id, scheduled_at: at(60), court_id: rig.courts[0]! },
      { fixture_id: boards[1]!.id, scheduled_at: at(0), court_id: rig.courts[1]! },
    ],
    source: "manual",
  });
  const lastStart = msAt(60);
  const lastEnd = lastStart + MATCH_MINUTES * MIN;
  expect(lastEnd, "premise: round 1's last board ends after it starts, so the two floors differ").toBeGreaterThan(lastStart);
  return { lastStart, lastEnd, boards };
}

/** Round `round`'s boards played: the home side wins every one (21-10, 21-12). */
async function playRound(rig: Rig, boards: readonly Row[]): Promise<void> {
  for (const f of boards) {
    await appendEvent(rig.auth.orgId, f.id, 0, { type: "core.start", payload: {}, recordedBy: null });
    await appendEvent(rig.auth.orgId, f.id, 1, { type: "badminton.game.summary", payload: { home: 21, away: 10 }, recordedBy: null });
    await appendEvent(rig.auth.orgId, f.id, 2, { type: "badminton.game.summary", payload: { home: 21, away: 12 }, recordedBy: null });
  }
}

interface Span {
  minStart: number;
  maxEnd: number;
  boards: number;
}

/** Each round's span over a set of placed boards (round read from the stage's own rows). */
function spans(placed: readonly { round: number; startMs: number; endMs: number }[]): Map<number, Span> {
  const out = new Map<number, Span>();
  for (const p of placed) {
    const cur = out.get(p.round) ?? { minStart: Infinity, maxEnd: -Infinity, boards: 0 };
    out.set(p.round, { minStart: Math.min(cur.minStart, p.startMs), maxEnd: Math.max(cur.maxEnd, p.endMs), boards: cur.boards + 1 });
  }
  return out;
}

const proposedSpans = (out: AutoScheduleOut, rows: readonly Row[]) => {
  const round = new Map(rows.map((r) => [r.id, r.round_no]));
  return spans(
    out.assignments.flatMap((a) => {
      const r = round.get(a.fixture_id);
      return r === undefined ? [] : [{ round: r, startMs: Date.parse(a.scheduled_at), endMs: Date.parse(a.ends_at) }];
    }),
  );
};

const storedSpans = (rows: readonly Row[]) =>
  spans(
    rows.flatMap((r) =>
      r.scheduled_at === null ? [] : [{ round: r.round_no, startMs: r.scheduled_at.getTime(), endMs: r.scheduled_at.getTime() + MATCH_MINUTES * MIN }],
    ),
  );

const orderCodes = (conflicts: readonly ScheduleConflict[]) => conflicts.filter((c) => c.code === "warn.order");

describe.runIf(HAS_DB)("X-SW-31 auto-schedule after Pair: the next round is proposed after the last board of the previous one ENDS", () => {
  it("round 2 (paired) and round 3 (unpaired) come after round 1's and round 2's last end, and the apply accepts the proposal", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    const { rig, stageId } = await swissOnly({ players: 4, courts: 6, rounds: 3 });
    const one = await layRoundOne(rig, stageId);
    await playRound(rig, one.boards); // round 1 decided: a fixed obstacle for the next pass
    await generateStageFixtures(rig.auth, stageId); // Pair round 2
    const rows = (await rowsOf(stageId)).filter((r) => !isSwissByeShellExtKey(r.ext_key));
    expect(rows.filter((r) => r.round_no === 2).every((r) => r.home_entrant_id !== null), "premise: round 2 is paired").toBe(true);
    expect(rows.filter((r) => r.round_no === 3).every((r) => r.home_entrant_id === null), "premise: round 3 is still TBD v TBD").toBe(true);

    const out = await autoSchedule(rig.auth, stageId, { only_unlocked: false, mode: "build" });
    const engineName = `engine=${out.solver.engine}`;
    const sp = proposedSpans(out, rows);
    expect(sp.get(2)?.boards, `round 2 is proposed (${engineName}; conflicts ${JSON.stringify(out.conflicts.map((c) => [c.code, c.details?.kind]))})`).toBe(2);
    expect(sp.get(3)?.boards, `round 3 is proposed (${engineName})`).toBe(2);
    expect(sp.has(1), "round 1 is decided: not in the proposal").toBe(false);
    // The barrier. Round 3's boards are TBD v TBD: no entrant and no rest orders them, so under a start floor they would
    // sit beside round 2 on the free courts; only the end barrier puts them after round 2's last end.
    expect(sp.get(2)!.minStart, `round 2 starts after round 1's last board ends (${engineName})`).toBeGreaterThanOrEqual(one.lastEnd);
    expect(sp.get(3)!.minStart, `round 3 starts after round 2's last board ends (${engineName})`).toBeGreaterThanOrEqual(sp.get(2)!.maxEnd);
    expect(orderCodes(out.conflicts), "the proposal carries no round-order conflict").toEqual([]);

    // Parity with the apply gate: the same rows, judged by the verifier the write goes through, are accepted.
    await applyAuto(rig, stageId, out);
    const written = storedSpans((await rowsOf(stageId)).filter((r) => !isSwissByeShellExtKey(r.ext_key)));
    expect(written.get(3)!.boards, "the apply wrote round 3").toBe(2);
    expect(written.get(3)!.minStart, "and kept the barrier").toBeGreaterThanOrEqual(written.get(2)!.maxEnd);
    expect(orderCodes((await validateSchedule(rig.auth, rig.divisionId)).conflicts), "the board report is clean").toEqual([]);
  }, 300_000);

  it("ruling 256: with rest 30 and a cap of 2, round 2 waits the rest after round 1's end and no day holds more than 2 rounds", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    const rest = 30;
    const cap = 2;
    const rounds = 3;
    const { rig, stageId } = await swissOnly({ players: 4, courts: 6, rounds, rest, cap });
    const out = await autoSchedule(rig.auth, stageId, { only_unlocked: false, mode: "build" });
    const engineName = `engine=${out.solver.engine}`;
    const rows = (await rowsOf(stageId)).filter((r) => !isSwissByeShellExtKey(r.ext_key));
    const sp = proposedSpans(out, rows);
    expect([...sp.keys()].sort(), `every round is placed (${engineName})`).toEqual([1, 2, 3]);
    // The gap: the division's rest between one round's last end and the next round's first start.
    expect(sp.get(2)!.minStart, `round 2 waits the rest (${engineName})`).toBeGreaterThanOrEqual(sp.get(1)!.maxEnd + rest * MIN);
    expect(sp.get(3)!.minStart, `round 3 waits the rest (${engineName})`).toBeGreaterThanOrEqual(sp.get(2)!.maxEnd + rest * MIN);
    // The cap: distinct rounds with a board on one calendar day (UTC: asserted by the rig).
    const roundsOnDay = new Map<string, Set<number>>();
    const round = new Map(rows.map((r) => [r.id, r.round_no]));
    for (const a of out.assignments) {
      const d = utcDay(Date.parse(a.scheduled_at));
      roundsOnDay.set(d, (roundsOnDay.get(d) ?? new Set()).add(round.get(a.fixture_id)!));
    }
    expect(roundsOnDay.size, "anti-vacuity: days were counted").toBeGreaterThan(0);
    expect(Math.max(...[...roundsOnDay.values()].map((s) => s.size)), `no day holds more than ${cap} rounds (${engineName})`).toBeLessThanOrEqual(cap);
    // Three rounds under a cap of two cannot fit one day (pigeonhole, from the settings): the cap really bound.
    expect(roundsOnDay.size, "the rounds are spread over at least ceil(rounds / cap) days").toBeGreaterThanOrEqual(Math.ceil(rounds / cap));
    await applyAuto(rig, stageId, out);
    expect(orderCodes((await validateSchedule(rig.auth, rig.divisionId)).conflicts), "the board report is clean").toEqual([]);
  }, 300_000);

  it("the empty case: a Swiss stage with one round has no later round to bar, and the pass places every board", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    const { rig, stageId } = await swissOnly({ players: 4, courts: 2, rounds: 1, rest: 30, cap: 2 });
    const out = await autoSchedule(rig.auth, stageId, { only_unlocked: false, mode: "build" });
    expect(out.assignments.length, "both boards of the only round are placed").toBe(2);
    expect(orderCodes(out.conflicts)).toEqual([]);
  }, 120_000);
});

describe.runIf(HAS_DB)("X-SW-31 the solver input carries the Swiss round rules (rulings 255-256)", () => {
  it("every Swiss fixture carries the end barrier, the division's rest and cap; exactly the unpaired slots are flagged", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    const placement = await import("@seazn/scheduler/placement-client");
    const solveBuild = vi.spyOn(placement, "solveBuild"); // called through, not replaced
    const rest = 30;
    const cap = 2;
    const { rig, stageId } = await swissOnly({ players: 4, courts: 6, rounds: 3, rest, cap });
    const rows = (await rowsOf(stageId)).filter((r) => !isSwissByeShellExtKey(r.ext_key));
    const unpairedInDb = rows.filter((r) => r.home_entrant_id === null && r.away_entrant_id === null).length;
    expect(unpairedInDb, "premise: rounds 2 and 3 are TBD v TBD").toBe(4);

    await autoSchedule(rig.auth, stageId, { only_unlocked: false, mode: "build" });
    expect(solveBuild, "the solve reached the placement client").toHaveBeenCalledTimes(1);
    const input = solveBuild.mock.calls[0]![0] as unknown as {
      fixtures: {
        entrantIds?: string[];
        people?: string[];
        roundNo?: number;
        roundBarrier?: string;
        roundGapMinutes?: number;
        roundsPerDayCap?: number;
        unpairedRoundSlot?: boolean;
      }[];
    };
    expect(input.fixtures.length, "every board of the stage went to the solver").toBe(rows.length);
    const problems: string[] = [];
    let flagged = 0;
    for (const f of input.fixtures) {
      if (f.roundNo === undefined) problems.push("a fixture lost its round");
      if (f.roundBarrier !== "end") problems.push(`a fixture has roundBarrier ${JSON.stringify(f.roundBarrier)}`);
      if (f.roundGapMinutes !== rest) problems.push(`a fixture has roundGapMinutes ${f.roundGapMinutes}`);
      if (f.roundsPerDayCap !== cap) problems.push(`a fixture has roundsPerDayCap ${f.roundsPerDayCap}`);
      const empty = (f.entrantIds ?? []).length === 0 && (f.people ?? []).length === 0;
      if (empty !== (f.unpairedRoundSlot === true)) problems.push(`unpaired flag ${f.unpairedRoundSlot} on a fixture whose seats are ${empty ? "empty" : "filled"}`);
      if (f.unpairedRoundSlot === true) flagged++;
    }
    expect(problems, "the solver input is complete").toEqual([]);
    expect(flagged, "exactly the unpaired slots are flagged").toBe(unpairedInDb);
  }, 180_000);
});

describe.runIf(HAS_DB)("X-SW-31 a manual move of a Swiss board before the previous round ends is refused with the round_order_end copy", () => {
  it("round 2 at 10:15 (after round 1's last start, before its end) is refused in every locale; at 10:30 it lands", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    const { rig, stageId } = await swissOnly({ players: 4, courts: 6, rounds: 3 });
    const one = await layRoundOne(rig, stageId);
    const r2 = (await rowsOf(stageId)).find((r) => r.round_no === 2 && !isSwissByeShellExtKey(r.ext_key))!;
    const tooEarly = 75; // minutes from 09:00: after round 1's last START (10:00), before its last END (10:30)
    expect(msAt(tooEarly), "premise: a start floor alone allows this move").toBeGreaterThanOrEqual(one.lastStart);
    expect(msAt(tooEarly), "premise: and the end barrier does not").toBeLessThan(one.lastEnd);

    const err = await moveFixture(rig.auth, r2.id, { scheduled_at: at(tooEarly), court_id: rig.courts[2]! }).catch((e: unknown) => e);
    expect(EngineError.is(err, "SCHEDULE_CONFLICT"), "the move is refused").toBe(true);
    const conflicts = (err as EngineError).data as { conflicts: ScheduleConflict[] };
    const end = conflicts.conflicts.filter((c) => c.details?.kind === "round_order_end");
    expect(end.length, "anti-vacuity: the refusal names the end barrier").toBeGreaterThan(0);
    const c = end[0]!;
    expect(c.blocking, "it blocks").toBe(true);
    expect(c.code, "as round order").toBe("warn.order");
    expect(c.fixture_id, "blamed on the later round's board").toBe(r2.id);
    expect(c.details).toMatchObject({ round_no: 2, other_round_no: 1 });
    expect(c.shortfall_minutes, "the measured shortfall: how much earlier than round 1's end the board starts").toBe((one.lastEnd - msAt(tooEarly)) / MIN);
    const [kept] = await sql<{ scheduled_at: Date | null }[]>`select scheduled_at from fixtures where id = ${r2.id}`;
    expect(kept!.scheduled_at, "nothing was written").toBeNull();

    // The copy, in every locale, rendered from the REAL refusal and compared with the dictionary's own sentence.
    const dicts: [string, Record<string, string>][] = [["en", en], ["fr", fr], ["es", es], ["nl", nl]];
    let rendered = 0;
    const seenText = new Set<string>();
    for (const [locale, raw] of dicts) {
      const template = raw["board.conflict.detail.round_order_end"];
      expect(template, `${locale}: the dictionary carries the sentence`).toBeTruthy();
      const want = template!.replace("{round}", String(2)).replace("{otherRound}", String(1));
      const got = formatBoardConflictDetail(c.details as never, {
        msg: (key, vars) => t(raw as unknown as Dict, key, vars),
        entrantNames: {},
        fixtureTitles: {},
      });
      expect(got, `${locale}: the refusal renders the dictionary sentence`).toBe(want);
      expect(got, `${locale}: no placeholder is left`).not.toMatch(/[{}]/);
      seenText.add(got);
      rendered++;
    }
    expect(rendered, "anti-vacuity: four locales rendered").toBe(4);
    expect(seenText.size, "and they are four different sentences").toBe(4);

    // The positive pair: the boundary itself is legal.
    const landed = await moveFixture(rig.auth, r2.id, { scheduled_at: at(90), court_id: rig.courts[2]! });
    expect(landed.filter((x) => x.details?.kind === "round_order_end"), "10:30 breaks no end barrier").toEqual([]);
    const [moved] = await sql<{ scheduled_at: Date }[]>`select scheduled_at from fixtures where id = ${r2.id}`;
    expect(moved!.scheduled_at.toISOString()).toBe(at(90));
  }, 240_000);

  it("the same geometry on a LEAGUE keeps the start floor: round 2 at 10:15 is legal there, and 09:45 is not", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    const rig = await division({ players: 4, courts: 6 });
    const stageId = await leagueStage(rig, 1);
    const rows = await rowsOf(stageId);
    const r1 = rows.filter((r) => r.round_no === 1);
    const r2 = rows.filter((r) => r.round_no === 2);
    expect(r1.length, "premise: two boards a round").toBe(2);
    expect(r2.length).toBe(2);
    // Round 1 as in the Swiss geometry (last start 10:00, last end 10:30), round 2 on free courts, so only the round rule is in play.
    const place = async (id: string, minutes: number, court: number) =>
      sql`update fixtures set scheduled_at = ${at(minutes)}, court_id = ${rig.courts[court]!} where id = ${id}`;
    await place(r1[0]!.id, 60, 0);
    await place(r1[1]!.id, 0, 1);
    await place(r2[0]!.id, 75, 2);
    await place(r2[1]!.id, 75, 3);
    const order = () => validateSchedule(rig.auth, rig.divisionId).then((r) => orderCodes(r.conflicts));
    expect(await order(), "10:15 is after round 1's last START: the league's start floor holds").toEqual([]);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stageId} and scheduled_at is not null`)[0]!.n, "anti-vacuity: four boards are placed").toBe(4);

    await place(r2[1]!.id, 45, 3); // 09:45: before round 1's last start
    const early = await order();
    expect(early.length, "positive pair: a start BEFORE round 1's last start is flagged on a league too").toBeGreaterThan(0);
    expect(early.some((c) => c.details?.kind === "round_order_end"), "and by the start floor, not the end barrier").toBe(false);
    expect(early.every((c) => c.shortfall_minutes === undefined), "a start-floor conflict measures no shortfall").toBe(true);
  }, 240_000);
});

describe.runIf(HAS_DB)("X-SW-31 the rounds-per-day cap reports its measured count on the wire (ruling 256)", () => {
  it("three rounds laid on one day under a cap of 2 are flagged rounds_per_day, with measured_count 3", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    const cap = 2;
    const { rig, stageId } = await swissOnly({ players: 4, courts: 6, rounds: 3, cap });
    const rows = (await rowsOf(stageId)).filter((r) => !isSwissByeShellExtKey(r.ext_key));
    // Round r on its own hour of one day (no rest, no overlap): 09:00, 10:00, 11:00. Only the cap is in play.
    for (const r of rows) {
      const k = rows.filter((x) => x.round_no === r.round_no).findIndex((x) => x.id === r.id);
      await sql`update fixtures set scheduled_at = ${at((r.round_no - 1) * 60)}, court_id = ${rig.courts[k]!} where id = ${r.id}`;
    }
    const report = await validateSchedule(rig.auth, rig.divisionId);
    const perDay = report.conflicts.filter((c) => c.details?.kind === "rounds_per_day");
    expect(perDay.length, "anti-vacuity: the cap is breached and flagged").toBeGreaterThan(0);
    expect(perDay.every((c) => c.blocking), "it blocks").toBe(true);
    expect(perDay.every((c) => c.details?.required_count === cap), "the detail carries the cap").toBe(true);
    expect(perDay.every((c) => c.measured_count === 3), "the wire carries the measured count: three rounds that day").toBe(true);
    expect(perDay.every((c) => c.shortfall_minutes === undefined), "and no shortfall, which is the end barrier's").toBe(true);
    expect(report.conflicts.filter((c) => c.details?.kind === "round_order_end"), "the rounds themselves are in order").toEqual([]);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// The wire and the live solver
// ---------------------------------------------------------------------------------------------------------------------

/** The enum value of the vendored proto's `ROUND_BARRIER_END`, read from the proto itself (the rulebook of the wire), not
 *  typed here: the generated stubs are not importable from the app. */
function protoEnum(name: string): number {
  const proto = readFileSync(resolve(process.cwd(), "../../packages/scheduler/proto/scheduler.proto"), "utf8");
  const m = new RegExp(`\\b${name}\\s*=\\s*(\\d+)\\s*;`).exec(proto);
  expect(m, `the vendored proto declares ${name}`).not.toBeNull();
  return Number(m![1]);
}

interface WireFixture {
  entrantIndices: number[];
  personIndices: number[];
  round?: number;
  roundBarrier: number;
  unpairedRoundSlot: boolean;
  roundGapMinutes: number;
  roundsPerDayCap: number;
}
interface WirePin {
  round?: number;
  roundBarrier: number;
  dayIndex?: number;
}
interface WireRequest {
  fixtures: WireFixture[];
  existing: WirePin[];
}

describe.runIf(HAS_DB)("X-SW-31 the wire: toRequest forwards the round rules to the placement service (rulings 255-256)", () => {
  it("every wire fixture carries END, the gap and the cap; exactly the unpaired slots carry the flag; every pin of the sequence carries END and its day", async () => {
    // Never dialed: the recording call answers (with a status the client reads as ERROR, so the engine ships greedy).
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    const placement = await import("@seazn/scheduler/placement-client");
    const realSolveBuild = placement.solveBuild;
    const wire: WireRequest[] = [];
    const recordingCall = {
      solveBuild: (request: unknown, _meta: unknown, _opts: unknown, cb: (e: null, r: unknown) => void) => {
        wire.push(request as WireRequest);
        cb(null, { assignments: [], status: 0, tiersCompleted: 0, objectiveValues: [], elapsedMs: 0, wallExhausted: false, error: undefined });
        return undefined;
      },
    };
    const solveBuild = vi
      .spyOn(placement, "solveBuild")
      .mockImplementation(((input: Parameters<typeof realSolveBuild>[0], opts: Parameters<typeof realSolveBuild>[1]) =>
        realSolveBuild(input, opts, recordingCall as never)) as typeof placement.solveBuild);
    const END = protoEnum("ROUND_BARRIER_END");
    expect(END, "the proto's END is not the UNSPECIFIED zero").toBeGreaterThan(0);

    const rest = 30;
    const cap = 2;
    const { rig, stageId } = await swissOnly({ players: 4, courts: 6, rounds: 3, rest, cap });
    const one = await layRoundOne(rig, stageId);
    await playRound(rig, one.boards); // round 1 decided: the pins of the next pass
    await generateStageFixtures(rig.auth, stageId); // Pair round 2; round 3 stays TBD v TBD
    const rows = (await rowsOf(stageId)).filter((r) => !isSwissByeShellExtKey(r.ext_key));
    const movableRows = rows.filter((r) => r.round_no > 1);
    const unpairedRows = movableRows.filter((r) => r.home_entrant_id === null && r.away_entrant_id === null);
    expect(unpairedRows.length, "premise: round 3 is two unpaired slots").toBe(2);

    await autoSchedule(rig.auth, stageId, { only_unlocked: false, mode: "build" });
    expect(wire.length, "the one solve went out through the real toRequest").toBe(1);
    const input = solveBuild.mock.calls[0]![0] as unknown as {
      fixtures: { roundNo?: number; roundGapMinutes?: number; roundsPerDayCap?: number }[];
      existing: { roundNo?: number; roundBarrier?: string; dayIndex?: number }[];
    };
    const req = wire[0]!;
    expect(req.fixtures.length, "every movable board crossed the wire").toBe(movableRows.length);

    const problems: string[] = [];
    let flagged = 0;
    req.fixtures.forEach((f, i) => {
      if (f.roundBarrier !== END) problems.push(`fixture ${i}: roundBarrier ${f.roundBarrier}, not END (${END})`);
      if (f.roundGapMinutes !== rest) problems.push(`fixture ${i}: roundGapMinutes ${f.roundGapMinutes}, not ${rest}`);
      if (f.roundsPerDayCap !== cap) problems.push(`fixture ${i}: roundsPerDayCap ${f.roundsPerDayCap}, not ${cap}`);
      if (f.round !== input.fixtures[i]!.roundNo) problems.push(`fixture ${i}: round ${f.round}`);
      // The contract the service enforces: a fixture with neither seat is refused unless it is flagged an unpaired slot,
      // and a flagged one must carry no seat at all.
      const seatless = f.entrantIndices.length === 0 && f.personIndices.length === 0;
      if (seatless && !f.unpairedRoundSlot) problems.push(`fixture ${i}: no entrant and no person, and not flagged (the service would refuse the request)`);
      if (f.unpairedRoundSlot && !seatless) problems.push(`fixture ${i}: flagged unpaired but seated`);
      if (f.unpairedRoundSlot) flagged++;
    });
    expect(problems, "the wire fixtures are complete").toEqual([]);
    expect(req.fixtures.length, "anti-vacuity: fixtures were checked").toBeGreaterThan(0);
    expect(flagged, "exactly the unpaired slots are flagged").toBe(unpairedRows.length);

    // The pins: the engine's own input says which carry a round, and the wire must agree on every one of them.
    expect(req.existing.length, "every pin crossed the wire").toBe(input.existing.length);
    let pinned = 0;
    req.existing.forEach((p, i) => {
      const src = input.existing[i]!;
      if (src.roundNo === undefined) return;
      pinned++;
      if (src.roundBarrier !== "end") problems.push(`pin ${i}: the engine input has roundBarrier ${JSON.stringify(src.roundBarrier)}`);
      if (p.roundBarrier !== END) problems.push(`pin ${i}: roundBarrier ${p.roundBarrier}, not END`);
      if (p.round !== src.roundNo) problems.push(`pin ${i}: round ${p.round}, not ${src.roundNo}`);
      if (typeof src.dayIndex !== "number") problems.push(`pin ${i}: the engine input has no dayIndex`);
      if (p.dayIndex !== src.dayIndex) problems.push(`pin ${i}: dayIndex ${p.dayIndex}, not ${src.dayIndex}`);
    });
    expect(problems, "the wire pins are complete").toEqual([]);
    expect(pinned, "anti-vacuity: round 1's two played boards are the pins that were checked").toBe(one.boards.length);
  }, 240_000);

  // m1 / m2 (task 9b review). `PinnedRow.day_index` is `optional` because day 0 is a real day: the proto says an ABSENT
  // day counts the pin on whatever slot range its start falls in (or on none), a SET one counts it on that calendar day.
  // So "no day" and "day 0" are different requests, and the wire must keep them apart for every format (the engine sets
  // the day on every slotted pin of every kind, `pinDayOnWire`, and leaves it off a pin whose day the grid does not
  // offer). Each case below puts two played boards on the timetable: one on a day the grid offers, one on the day before
  // the window opens, and judges the engine's input and the request built from it, board by board.

  /** Route every placement solve through the REAL `toRequest` into a recording call (never dialed; it answers with a
   *  status the client reads as an error, so the engine ships greedy). */
  async function recordWire() {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    const placement = await import("@seazn/scheduler/placement-client");
    const realSolveBuild = placement.solveBuild;
    const wire: WireRequest[] = [];
    const recordingCall = {
      solveBuild: (request: unknown, _meta: unknown, _opts: unknown, cb: (e: null, r: unknown) => void) => {
        wire.push(request as WireRequest);
        cb(null, { assignments: [], status: 0, tiersCompleted: 0, objectiveValues: [], elapsedMs: 0, wallExhausted: false, error: undefined });
        return undefined;
      },
    };
    const solveBuild = vi
      .spyOn(placement, "solveBuild")
      .mockImplementation(((input: Parameters<typeof realSolveBuild>[0], opts: Parameters<typeof realSolveBuild>[1]) =>
        realSolveBuild(input, opts, recordingCall as never)) as typeof placement.solveBuild);
    return { wire, solveBuild };
  }

  /** The index, among the days the rig's window offers, of the org-local calendar day `ms` falls on - or undefined when
   *  the day is not on the grid. From the rulebook (the window and the calendar), not from the code: the rig saves no
   *  blackout, closed day or session window and its org zone is UTC (asserted in `division`), so every calendar day from
   *  the window's first to its last is a day of slots, in date order. */
  function gridDayOf(ms: number): number | undefined {
    const first = Date.parse(utcDay(Date.parse(START)));
    const last = Date.parse(utcDay(Date.parse(END_AT)));
    const day = Date.parse(utcDay(ms));
    return day < first || day > last ? undefined : (day - first) / DAY_MS;
  }

  interface PinSource {
    fixtureId: string;
    roundNo?: number;
    dayIndex?: number;
  }

  /** A third day of the window at 10:00: a day index that is neither the first day nor zero by accident. */
  const ON_GRID_MS = msAt(2 * 24 * 60 + 60);
  /** The day before the window opens, 09:00: no slot of the grid falls on it. */
  const OFF_GRID_MS = msAt(-24 * 60);

  /** Put `onGrid` and `offGrid` where the cases need them (SQL: the organiser's own placement would refuse the second). */
  async function placePlayedPair(rig: Rig, onGrid: Row, offGrid: Row): Promise<void> {
    await sql`update fixtures set scheduled_at = ${new Date(ON_GRID_MS)}, court_id = ${rig.courts[0]!} where id = ${onGrid.id}`;
    await sql`update fixtures set scheduled_at = ${new Date(OFF_GRID_MS)}, court_id = ${rig.courts[1]!} where id = ${offGrid.id}`;
    await playRound(rig, [onGrid, offGrid]);
  }

  /** The two pins, as the engine handed them to the solver port and as the request carries them. */
  function pinsOf(solveBuild: { mock: { calls: unknown[][] } }, wire: WireRequest[], onGrid: Row, offGrid: Row) {
    expect(wire.length, "the one solve went out through the real toRequest").toBe(1);
    const input = solveBuild.mock.calls[0]![0] as { existing: PinSource[] };
    expect(wire[0]!.existing.length, "every pin crossed the wire").toBe(input.existing.length);
    const find = (row: Row) => {
      const at = input.existing.findIndex((e) => e.fixtureId === row.id);
      expect(at, `the played board ${row.id} is a pin of the solve`).toBeGreaterThanOrEqual(0);
      return { src: input.existing[at]!, wire: wire[0]!.existing[at]! };
    };
    return { on: find(onGrid), off: find(offGrid) };
  }

  it("a played Swiss round on a day the grid does not offer sends NO dayIndex (absent, never 0), beside one on the grid that sends its day", async () => {
    const { wire, solveBuild } = await recordWire();
    const { rig, stageId } = await swissOnly({ players: 4, courts: 6, rounds: 3, rest: 30, cap: 2 });
    const one = await layRoundOne(rig, stageId);
    await placePlayedPair(rig, one.boards[0]!, one.boards[1]!);
    await generateStageFixtures(rig.auth, stageId); // Pair round 2
    await autoSchedule(rig.auth, stageId, { only_unlocked: false, mode: "build" });
    const { on, off } = pinsOf(solveBuild, wire, one.boards[0]!, one.boards[1]!);
    const END = protoEnum("ROUND_BARRIER_END");

    // Premises: the two instants really are one on the grid (and not on its first day) and one off it.
    const day = gridDayOf(ON_GRID_MS);
    expect(day, "premise: the on-grid pin is on the third day of the window").toBe(2);
    expect(gridDayOf(OFF_GRID_MS), "premise: the day before the window is on no day of the grid").toBeUndefined();

    // Positive: the pin on the grid carries its day, as a number, on the engine's input and on the wire.
    expect(on.src.roundNo, "the on-grid pin is a round-bearing pin").toBe(1);
    expect(on.src.dayIndex, "engine input: the pin's day").toBe(day);
    expect(on.wire.dayIndex, "wire: the pin's day").toBe(day);
    expect(on.wire.roundBarrier, "and it is a Swiss pin: END").toBe(END);

    // Negative: the off-grid pin has NO day. The engine leaves the key off its input; the request's field is undefined
    // (the encoder writes `day_index` only when it is not undefined), and above all it is not 0.
    expect(off.src.roundNo, "the off-grid pin is a round-bearing pin too").toBe(1);
    expect(off.src, "engine input: no dayIndex key at all").not.toHaveProperty("dayIndex");
    expect(off.wire.dayIndex, "wire: absent, not 0").toBeUndefined();
    expect(off.wire.roundBarrier, "and it is a Swiss pin: END").toBe(END);
  }, 240_000);

  it("PinnedRow.day_index goes out for EVERY format: a played LEAGUE board carries its org-local calendar day, one off the grid carries none", async () => {
    const { wire, solveBuild } = await recordWire();
    const rig = await division({ players: 4, courts: 3, rest: 30, cap: 2 });
    const stageId = await leagueStage(rig, 1);
    // Two boards of round 1 that share no entrant, so no pair of pins clashes on a person whatever the days.
    const rows = await rowsOf(stageId);
    const first = rows[0]!;
    const second = rows.find(
      (r) => r.id !== first.id && r.home_entrant_id !== first.home_entrant_id && r.home_entrant_id !== first.away_entrant_id && r.away_entrant_id !== first.home_entrant_id && r.away_entrant_id !== first.away_entrant_id,
    );
    expect(second, "premise: the league has a board disjoint from the first").toBeDefined();
    await placePlayedPair(rig, first, second!);
    await autoSchedule(rig.auth, stageId, { only_unlocked: false, mode: "build" });
    const { on, off } = pinsOf(solveBuild, wire, first, second!);
    const UNSPECIFIED = protoEnum("ROUND_BARRIER_UNSPECIFIED");

    const day = gridDayOf(ON_GRID_MS);
    expect(day, "premise: the on-grid pin is on the third day of the window").toBe(2);
    expect(gridDayOf(OFF_GRID_MS), "premise: the day before the window is on no day of the grid").toBeUndefined();

    expect(on.wire.roundBarrier, "premise: a league pin carries no barrier").toBe(UNSPECIFIED);
    expect(off.wire.roundBarrier, "premise: a league pin carries no barrier").toBe(UNSPECIFIED);
    expect(on.src.dayIndex, "engine input: the league pin's day").toBe(day);
    expect(on.wire.dayIndex, "wire: the league pin's day").toBe(day);
    expect(off.src, "engine input: no dayIndex key at all").not.toHaveProperty("dayIndex");
    expect(off.wire.dayIndex, "wire: absent, not 0").toBeUndefined();
  }, 240_000);

  it("a league build sends the proto3 defaults: no barrier, no flag, no gap, no cap", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    const placement = await import("@seazn/scheduler/placement-client");
    const realSolveBuild = placement.solveBuild;
    const wire: WireRequest[] = [];
    const recordingCall = {
      solveBuild: (request: unknown, _meta: unknown, _opts: unknown, cb: (e: null, r: unknown) => void) => {
        wire.push(request as WireRequest);
        cb(null, { assignments: [], status: 0, tiersCompleted: 0, objectiveValues: [], elapsedMs: 0, wallExhausted: false, error: undefined });
        return undefined;
      },
    };
    vi.spyOn(placement, "solveBuild").mockImplementation(((input: Parameters<typeof realSolveBuild>[0], opts: Parameters<typeof realSolveBuild>[1]) =>
      realSolveBuild(input, opts, recordingCall as never)) as typeof placement.solveBuild);
    const rig = await division({ players: 4, courts: 3, rest: 30, cap: 2 });
    const stageId = await leagueStage(rig, 1);
    await autoSchedule(rig.auth, stageId, { only_unlocked: false, mode: "build" });
    expect(wire.length, "the one solve went out").toBe(1);
    const sent = wire[0]!.fixtures;
    expect(sent.length, "anti-vacuity: the league's boards crossed the wire").toBeGreaterThan(0);
    expect(sent.filter((f) => f.roundBarrier !== 0 || f.unpairedRoundSlot || f.roundGapMinutes !== 0 || f.roundsPerDayCap !== 0), "no league fixture carries a round rule").toEqual([]);
  }, 240_000);
});

// Needs the placement service at the vendored pin. `PLACEMENT_SERVICE_HOST` is set in the CI usecases job; a CI run
// without it must FAIL here rather than skip (a gate nothing asserts is how coverage disappears), so only a local run
// with no service skips.
const LIVE_SOLVER = !!process.env.PLACEMENT_SERVICE_HOST || !!process.env.CI;

describe.runIf(HAS_DB && LIVE_SOLVER)("X-SW-31 the live solver answers a Swiss build SOLVED, with the barrier, the gap and the cap honoured (rulings 255-256)", () => {
  /** The solver's own reply, read off the call-through spy: it ANSWERED (not a transport failure or a refusal). */
  async function solverReply(solveBuild: { mock: { results: { type: string; value: unknown }[] } }) {
    expect(solveBuild.mock.results.length, "the solve reached the placement client").toBe(1);
    expect(solveBuild.mock.results[0]!.type, "and the client did not throw").toBe("return");
    return (await solveBuild.mock.results[0]!.value) as { status: string; assignments: unknown[]; error?: { code: string; message: string } };
  }

  it("a fresh Swiss (round 1 paired, rounds 2 and 3 unpaired slots) is solved, not refused, and every round waits for the last", async () => {
    const placement = await import("@seazn/scheduler/placement-client");
    const solveBuild = vi.spyOn(placement, "solveBuild"); // called through, against the real service
    const rest = 30;
    const cap = 2;
    const rounds = 3;
    const { rig, stageId } = await swissOnly({ players: 4, courts: 6, rounds, rest, cap });
    const rows = (await rowsOf(stageId)).filter((r) => !isSwissByeShellExtKey(r.ext_key));
    expect(rows.filter((r) => r.home_entrant_id === null).length, "premise: four unpaired slots go to the solver").toBe(4);

    const out = await autoSchedule(rig.auth, stageId, { only_unlocked: false, mode: "build" });
    const reply = await solverReply(solveBuild);
    // Not refused: a request the service rejects (INVALID_REQUEST "neither entrant_indices nor person_indices", or a
    // contradictory sequence) rejects the client call and the engine ships greedy; a refusal after the answer is
    // `verifier_rejected`. Neither is "solved".
    expect(["OPTIMAL", "FEASIBLE"], `the service solved the request (reply ${reply.status}, error ${JSON.stringify(reply.error)})`).toContain(reply.status);
    expect(reply.assignments.length, "and placed every board, the unpaired slots included").toBe(rows.length);
    expect(["ok", "already_optimal"], `the board the organiser gets is the solver's (status ${out.solver.status}, reason ${out.solver.not_searched_reason})`).toContain(out.solver.status);

    const sp = proposedSpans(out, rows);
    expect([...sp.keys()].sort(), "every round is placed").toEqual([1, 2, 3]);
    expect(sp.get(2)!.minStart, "round 2 waits round 1's last end plus the rest").toBeGreaterThanOrEqual(sp.get(1)!.maxEnd + rest * MIN);
    expect(sp.get(3)!.minStart, "round 3 waits round 2's last end plus the rest").toBeGreaterThanOrEqual(sp.get(2)!.maxEnd + rest * MIN);
    const roundsOnDay = new Map<string, Set<number>>();
    const round = new Map(rows.map((r) => [r.id, r.round_no]));
    for (const a of out.assignments) {
      const d = utcDay(Date.parse(a.scheduled_at));
      roundsOnDay.set(d, (roundsOnDay.get(d) ?? new Set()).add(round.get(a.fixture_id)!));
    }
    expect(roundsOnDay.size, "anti-vacuity: days were counted").toBeGreaterThan(0);
    expect(Math.max(...[...roundsOnDay.values()].map((s) => s.size)), `no day holds more than ${cap} rounds`).toBeLessThanOrEqual(cap);
    expect(roundsOnDay.size, "three rounds under a cap of two take at least two days").toBeGreaterThanOrEqual(Math.ceil(rounds / cap));
    expect(orderCodes(out.conflicts), "the proposal carries no round-order conflict").toEqual([]);

    await applyAuto(rig, stageId, out);
    expect(orderCodes((await validateSchedule(rig.auth, rig.divisionId)).conflicts), "the apply accepted it and the board report is clean").toEqual([]);
  }, 300_000);

  it("after round 1 is played (its boards are pins carrying the barrier and their day) the next pass is solved and keeps both", async () => {
    const placement = await import("@seazn/scheduler/placement-client");
    const solveBuild = vi.spyOn(placement, "solveBuild");
    const rest = 30;
    const cap = 2;
    const { rig, stageId } = await swissOnly({ players: 4, courts: 6, rounds: 3, rest, cap });
    const one = await layRoundOne(rig, stageId); // round 1: 10:00 and 09:00 on day 1, last END 10:30
    await playRound(rig, one.boards);
    await generateStageFixtures(rig.auth, stageId); // Pair round 2
    const rows = (await rowsOf(stageId)).filter((r) => !isSwissByeShellExtKey(r.ext_key));
    const movable = rows.filter((r) => r.round_no > 1);
    expect(movable.length, "premise: rounds 2 and 3 are the movable boards").toBe(4);

    const out = await autoSchedule(rig.auth, stageId, { only_unlocked: false, mode: "build" });
    const reply = await solverReply(solveBuild);
    expect(["OPTIMAL", "FEASIBLE"], `the service solved the request (reply ${reply.status}, error ${JSON.stringify(reply.error)})`).toContain(reply.status);
    expect(reply.assignments.length, "and placed every movable board").toBe(movable.length);
    expect(["ok", "already_optimal"], `the board is the solver's (status ${out.solver.status}, reason ${out.solver.not_searched_reason})`).toContain(out.solver.status);

    const sp = proposedSpans(out, rows);
    expect([...sp.keys()].sort(), "rounds 2 and 3 are proposed").toEqual([2, 3]);
    expect(sp.get(2)!.minStart, "round 2 waits the pins' last end plus the rest").toBeGreaterThanOrEqual(one.lastEnd + rest * MIN);
    expect(sp.get(3)!.minStart, "round 3 waits round 2's last end plus the rest").toBeGreaterThanOrEqual(sp.get(2)!.maxEnd + rest * MIN);
    // The pins' day counts toward the cap: round 1 is on day 1, so day 1 takes at most ONE more round.
    const day1 = utcDay(one.lastStart);
    const day1Rounds = new Set(out.assignments.filter((a) => utcDay(Date.parse(a.scheduled_at)) === day1).map((a) => rows.find((r) => r.id === a.fixture_id)!.round_no));
    expect(day1Rounds.size, `day ${day1} already holds round 1 (a pin), so it takes at most ${cap - 1} more`).toBeLessThanOrEqual(cap - 1);
    expect(orderCodes(out.conflicts), "no round-order conflict").toEqual([]);

    await applyAuto(rig, stageId, out);
    expect(orderCodes((await validateSchedule(rig.auth, rig.divisionId)).conflicts), "the apply accepted it").toEqual([]);
  }, 300_000);
});
