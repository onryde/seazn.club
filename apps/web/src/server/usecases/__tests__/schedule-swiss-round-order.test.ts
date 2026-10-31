// W3 Task 3b: auto-schedule keeps a Swiss stage's rounds in order.
//
// The C1 round-order rule (docs/superpowers/specs/2026-08-12-round-order-hard-lexicographic-design.md) is: for every
// pair on ONE round sequence — `(division, stage, pool)` — with round a < round b and at least one movable side, b's day
// is not before a's, and on the same day b does not start before a. With one time zone that is `start_a <= start_b`:
// every round-(r+1) board starts no earlier than the LATEST round-r board STARTS. It is a start floor, not an end floor
// (ties are legal, "R1 and R2 simultaneously on two courts is fine"); the end floor a Swiss round really needs is a
// recorded gap (task-3b report), not something these tests claim.
//
// Before this task the rule's stage gate (`roundRobinStageIds`, schedule.ts) answered `kind in ('league', 'group')`, so
// a Swiss row never carried its round to the placer, the solver or the verifier. A Swiss stage mints every round as a
// TBD-v-TBD shell at Generate, so nothing else (no entrant, no rest) orders round 2 after round 1 either: the auto pass
// laid boards down in fixture-ID order.
//
// THE DIFFERENTIAL SHAPE. Each rig re-keys the stage's board rows so the ids sort LAST ROUND FIRST (round R's lowest,
// round 1's highest), before anything references them. A placer that walks the rows by id — `slotFixtures` with no
// round, every row sorting as round 0 — then puts round 3 on the first slots and round 1 on the last. Only round order
// can put round 1 first. Asserted as a premise in every rig, so a change to the re-key cannot quietly make the shape
// easy. Run without PLACEMENT_SERVICE_HOST this file drives the greedy fallback; with it, the CP-SAT service. The rule
// is a hard constraint for the solver and a processing order plus a legalisation drop for greedy, so the floor holds
// on both — `solver.engine` rides on every failure message.
//
// single-sport: badminton — the rule reads stage kind, round_no, ext_key and the slot columns, never a sport field.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql, withTenant } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import { holdsSlot } from "@/lib/rebuild-slots";
import { isSwissByeShellExtKey } from "@/lib/swiss-shell";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStages, ScheduleConflict } from "@/server/api-v1/schemas";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import {
  applySchedule,
  autoSchedule,
  moveFixture,
  putScheduleSettings,
  roundRobinStageIds,
  validateSchedule,
  type AutoScheduleOut,
} from "../schedule";
import { createStages, generateStageFixtures, unpairSwissRound } from "../stages";
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

const START = "2030-08-01T09:00:00.000Z";
const MATCH_MINUTES = 30;
const MIN = 60_000;
const at = (minutesFromStart: number) => new Date(Date.parse(START) + minutesFromStart * MIN).toISOString();

/** A Swiss round seats every player once: floor(n/2) boards, the odd player out on the bye (the Swiss rule, not the
 *  generator's output). */
const boardsPerRound = (players: number) => Math.floor(players / 2);
/** Cross-round pairs on one Swiss stage: every unordered pair of rounds, every board of one against every board of the
 *  other. The count the order sweep must have checked. */
const crossRoundPairs = (players: number, rounds: number) =>
  ((rounds * (rounds - 1)) / 2) * boardsPerRound(players) ** 2;

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  courts: string[];
}

/** A badminton division of `players` individuals and `courts` courts, schedule settings saved (09:00 UTC, 30-minute
 *  matches, no gap, no rest), and no stage yet. */
async function division(players: number, courts: number): Promise<Omit<Rig, "stageId">> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss order " + randomUUID().slice(0, 6),
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
    Array.from({ length: players }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const venue = await createVenue(auth, { name: "Hall", sort: 0 });
  const ids: string[] = [];
  for (let i = 0; i < courts; i++) ids.push((await createCourt(auth, venue.id, { name: `Court ${i + 1}`, sort: i, tags: [] })).id);
  await putScheduleSettings(auth, div.id, {
    config: {
      startAt: START,
      matchMinutes: MATCH_MINUTES,
      gapMinutes: 0,
      courts: ids,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  return { auth, divisionId: div.id, courts: ids };
}

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: Date | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, status, home_entrant_id, away_entrant_id, scheduled_at, court_id, venue_id, schedule_locked
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

/** The stage's rows split by the one bye-shell predicate, with the shape pinned (anti-vacuity). */
async function split(stageId: string, players: number, rounds: number): Promise<{ boards: Row[]; byes: Row[] }> {
  const rows = await rowsOf(stageId);
  const byes = rows.filter((r) => isSwissByeShellExtKey(r.ext_key));
  const boards = rows.filter((r) => !isSwissByeShellExtKey(r.ext_key));
  expect(boards.length, "rig: every round minted its boards").toBe(rounds * boardsPerRound(players));
  expect(byes.length, "rig: an odd field mints one bye shell per round, an even field none").toBe(players % 2 === 1 ? rounds : 0);
  return { boards, byes };
}

/**
 * Re-keys the stage's BOARD rows so the ids sort by DESCENDING round: round R's ids start `0`, round 1's start
 * `R-1` (hex). Done on freshly minted shells, before Pair, so no row anywhere references them yet; byes keep their ids.
 * The premise every differential below rests on is asserted here, not assumed.
 */
async function idsSortLastRoundFirst(stageId: string, rounds: number): Promise<void> {
  expect(rounds, "rig: one hex digit per round").toBeLessThanOrEqual(16);
  const rows = (await rowsOf(stageId)).filter((r) => !isSwissByeShellExtKey(r.ext_key));
  for (const r of rows) {
    const id = `${(rounds - r.round_no).toString(16)}${randomUUID().slice(1)}`;
    await sql`update fixtures set id = ${id} where id = ${r.id}`;
  }
  const after = (await rowsOf(stageId)).filter((r) => !isSwissByeShellExtKey(r.ext_key));
  let compared = 0;
  for (const a of after) {
    for (const b of after) {
      if (a.round_no >= b.round_no) continue;
      compared++;
      expect(b.id < a.id, `premise: round ${b.round_no}'s ${b.id} sorts before round ${a.round_no}'s ${a.id}`).toBe(true);
    }
  }
  expect(compared, "premise: the id order was checked across rounds").toBeGreaterThan(0);
}

/** Mint, re-key so the ids sort last round first, Pair round 1: round 1 seated, every later round TBD v TBD. */
async function swissRig(players: number, rounds: number, courts: number): Promise<Rig> {
  const base = await division(players, courts);
  const [stage] = await createStages(base.auth, base.divisionId, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds },
    progression: null,
  });
  const rig = { ...base, stageId: stage!.id };
  await generateStageFixtures(rig.auth, rig.stageId); // mint every round's shells
  await idsSortLastRoundFirst(rig.stageId, rounds);
  await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
  const { boards } = await split(rig.stageId, players, rounds);
  const seated = (r: Row) => r.home_entrant_id !== null && r.away_entrant_id !== null;
  expect(boards.filter((b) => b.round_no === 1).every(seated), "premise: round 1 is paired").toBe(true);
  expect(
    boards.filter((b) => b.round_no > 1).every((b) => b.home_entrant_id === null && b.away_entrant_id === null),
    "premise: every later round is TBD v TBD, so no entrant or rest constraint orders it",
  ).toBe(true);
  return rig;
}

interface Placed {
  id: string;
  round: number;
  startMs: number;
}

/**
 * The C1 rule over one stage's placed boards (see the header): for every pair with round a < round b, b starts no
 * earlier than a. Returns how many cross-round pairs it compared and every inversion it found.
 */
function roundOrder(placed: readonly Placed[]): { pairs: number; inverted: string[] } {
  let pairs = 0;
  const inverted: string[] = [];
  for (const a of placed) {
    for (const b of placed) {
      if (a.round >= b.round) continue;
      pairs++;
      if (b.startMs < a.startMs) {
        inverted.push(`round ${b.round} at ${new Date(b.startMs).toISOString()} before round ${a.round} at ${new Date(a.startMs).toISOString()}`);
      }
    }
  }
  return { pairs, inverted };
}

/** A proposal's boards, with each one's round read from the stage's own rows. */
function proposed(out: AutoScheduleOut, boards: readonly Row[]): Placed[] {
  const round = new Map(boards.map((b) => [b.id, b.round_no]));
  return out.assignments.flatMap((a) => {
    const r = round.get(a.fixture_id);
    return r === undefined ? [] : [{ id: a.fixture_id, round: r, startMs: Date.parse(a.scheduled_at) }];
  });
}

/** The stage's placed boards as stored. */
const stored = (boards: readonly Row[]): Placed[] =>
  boards.flatMap((b) => (b.scheduled_at === null ? [] : [{ id: b.id, round: b.round_no, startMs: b.scheduled_at.getTime() }]));

const orderConflicts = (conflicts: readonly ScheduleConflict[]) => conflicts.filter((c) => c.code === "warn.order");

async function applyAuto(rig: Rig, out: AutoScheduleOut): Promise<void> {
  await applySchedule(rig.auth, rig.stageId, {
    assignments: out.assignments.map((a) => ({ fixture_id: a.fixture_id, scheduled_at: a.scheduled_at, court_id: a.court_id })),
    source: "auto",
  });
}

describe.runIf(HAS_DB)("W3 T3b the auto pass keeps a Swiss stage's rounds in order", () => {
  it("BUILD lays round 1, 2, 3 down in order though the ids sort round 3 first; the bye takes no slot", async () => {
    const [players, rounds] = [5, 3];
    const rig = await swissRig(players, rounds, 2);
    const { boards, byes } = await split(rig.stageId, players, rounds);
    const byeIds = new Set(byes.map((b) => b.id));

    const out = await autoSchedule(rig.auth, rig.stageId, { only_unlocked: false, mode: "build" });
    const engine = `engine=${out.solver.engine}`;
    expect(out.assignments.filter((a) => byeIds.has(a.fixture_id)), "the proposal names no bye").toEqual([]);
    expect(out.assignments.length, `every board is placed (${engine})`).toBe(rounds * boardsPerRound(players));
    const order = roundOrder(proposed(out, boards));
    expect(order.inverted, `no later round starts first (${engine})`).toEqual([]);
    expect(order.pairs, "anti-vacuity: every cross-round pair was compared").toBe(crossRoundPairs(players, rounds));
    expect(orderConflicts(out.conflicts), "the proposal carries no round-order conflict").toEqual([]);

    await applyAuto(rig, out);
    const after = await split(rig.stageId, players, rounds);
    expect(after.byes.filter(holdsSlot), "the odd field's bye shells hold no slot").toEqual([]);
    const written = roundOrder(stored(after.boards));
    expect(written.inverted, "the written board keeps the order").toEqual([]);
    expect(written.pairs, "anti-vacuity: the written board").toBe(crossRoundPairs(players, rounds));
    expect(orderConflicts((await validateSchedule(rig.auth, rig.divisionId)).conflicts), "the board report is clean").toEqual([]);
  }, 180_000);

  it("a second pass over the applied board keeps the order, in every mode (build, polish, reflow)", async () => {
    const [players, rounds] = [5, 3];
    const rig = await swissRig(players, rounds, 2);
    await applyAuto(rig, await autoSchedule(rig.auth, rig.stageId, { only_unlocked: false, mode: "build" }));
    const { boards } = await split(rig.stageId, players, rounds);
    expect(stored(boards).length, "premise: the first pass placed every board").toBe(boards.length);

    let modes = 0;
    for (const mode of ["build", "polish", "reflow"] as const) {
      const out = await autoSchedule(rig.auth, rig.stageId, { only_unlocked: mode === "reflow", mode });
      const engine = `${mode}, engine=${out.solver.engine}`;
      expect(out.assignments.length, `every board is placed (${engine})`).toBe(boards.length);
      const order = roundOrder(proposed(out, boards));
      expect(order.inverted, `no later round starts first (${engine})`).toEqual([]);
      expect(order.pairs, `anti-vacuity (${mode})`).toBe(crossRoundPairs(players, rounds));
      expect(orderConflicts(out.conflicts), `no round-order conflict (${engine})`).toEqual([]);
      modes++;
    }
    expect(modes, "anti-vacuity: all three modes ran").toBe(3);
  }, 240_000);

  it("after round 2 is paired and then unpaired, the next pass still lays rounds 2 and 3 after round 1", async () => {
    const [players, rounds] = [5, 3];
    const rig = await swissRig(players, rounds, 2);
    await applyAuto(rig, await autoSchedule(rig.auth, rig.stageId, { only_unlocked: false, mode: "build" }));

    // Round 1 played (home wins on every seated board), round 2 paired, then Unpair takes round 2 back to its shells.
    const r1 = (await split(rig.stageId, players, rounds)).boards.filter((b) => b.round_no === 1);
    for (const f of r1) {
      await appendEvent(rig.auth.orgId, f.id, 0, { type: "core.start", payload: {}, recordedBy: null });
      await appendEvent(rig.auth.orgId, f.id, 1, { type: "badminton.game.summary", payload: { home: 21, away: 10 }, recordedBy: null });
      await appendEvent(rig.auth.orgId, f.id, 2, { type: "badminton.game.summary", payload: { home: 21, away: 12 }, recordedBy: null });
    }
    await generateStageFixtures(rig.auth, rig.stageId); // Pair round 2
    expect(await unpairSwissRound(rig.auth, rig.stageId), "Unpair clears round 2").toMatchObject({ round: 2 });
    const { boards } = await split(rig.stageId, players, rounds);
    expect(
      boards.filter((b) => b.round_no === 2).every((b) => b.home_entrant_id === null && b.away_entrant_id === null),
      "premise: round 2 is back on its shells",
    ).toBe(true);
    expect(boards.filter((b) => b.round_no === 1).every((b) => b.status === "decided"), "premise: round 1 is decided").toBe(true);

    const out = await autoSchedule(rig.auth, rig.stageId, { only_unlocked: false, mode: "build" });
    const engine = `engine=${out.solver.engine}`;
    // Round 1 is decided, so it is a fixed obstacle and not in the proposal; the order is checked over the stored
    // round 1 and the proposed rounds 2 and 3 together.
    const moved = proposed(out, boards);
    expect(moved.length, `rounds 2 and 3 are placed (${engine})`).toBe((rounds - 1) * boardsPerRound(players));
    const order = roundOrder([...stored(boards.filter((b) => b.round_no === 1)), ...moved]);
    expect(order.inverted, `no later round starts first (${engine})`).toEqual([]);
    expect(order.pairs, "anti-vacuity").toBe(crossRoundPairs(players, rounds));

    await applyAuto(rig, out);
    expect(orderConflicts((await validateSchedule(rig.auth, rig.divisionId)).conflicts), "the board report is clean").toEqual([]);
  }, 240_000);

  it("the empty case: a one-round Swiss has no cross-round pair, and the pass places every board", async () => {
    const [players, rounds] = [4, 1];
    const base = await division(players, 2);
    const [stage] = await createStages(base.auth, base.divisionId, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds }, progression: null });
    await generateStageFixtures(base.auth, stage!.id);
    const { boards } = await split(stage!.id, players, rounds);
    const out = await autoSchedule(base.auth, stage!.id, { only_unlocked: false, mode: "build" });
    expect(out.assignments.length, `every board is placed (engine=${out.solver.engine})`).toBe(boardsPerRound(players));
    expect(roundOrder(proposed(out, boards)), "one round: nothing to order, by construction").toEqual({ pairs: 0, inverted: [] });
    expect(orderConflicts(out.conflicts)).toEqual([]);
  }, 120_000);
});

describe.runIf(HAS_DB)("W3 T3b the board's own gates hold a Swiss stage to round order", () => {
  it("a drag of a round-3 board ahead of round 1 is refused for round order; the same drag of a round-1 board is not", async () => {
    const [players, rounds] = [5, 3];
    const rig = await swissRig(players, rounds, 2);
    await applyAuto(rig, await autoSchedule(rig.auth, rig.stageId, { only_unlocked: false, mode: "build" }));
    const { boards } = await split(rig.stageId, players, rounds);
    const first = Math.min(...stored(boards).map((p) => p.startMs));
    // An hour before the first board, on court 1: nothing else is there, so round order is the only rule this can trip.
    const early = { scheduled_at: new Date(first - 60 * MIN).toISOString(), court_id: rig.courts[0]! };

    const r3 = boards.find((b) => b.round_no === 3)!;
    const err = await moveFixture(rig.auth, r3.id, early).catch((e: unknown) => e);
    expect(EngineError.is(err, "SCHEDULE_CONFLICT"), "the drag is refused").toBe(true);
    const conflicts = ((err as EngineError).data as { conflicts: ScheduleConflict[] }).conflicts;
    const order = orderConflicts(conflicts);
    expect(order.length, "anti-vacuity: the refusal names round order").toBeGreaterThan(0);
    expect(order.every((c) => c.blocking && c.rule === "H6"), "round order blocks, as rule H6").toBe(true);
    expect(order.some((c) => c.fixture_id === r3.id), "blamed on the later round (calendar.ts's convention)").toBe(true);
    const [kept] = await sql<{ scheduled_at: Date }[]>`select scheduled_at from fixtures where id = ${r3.id}`;
    expect(kept!.scheduled_at.toISOString(), "nothing was written").toBe(r3.scheduled_at!.toISOString());

    // Positive pair: round 1 has no earlier round, so the identical drag breaks no order and lands.
    const r1 = boards.find((b) => b.round_no === 1)!;
    const landed = await moveFixture(rig.auth, r1.id, early);
    expect(orderConflicts(landed), "round 1 moved earlier breaks no order").toEqual([]);
    const [moved] = await sql<{ scheduled_at: Date }[]>`select scheduled_at from fixtures where id = ${r1.id}`;
    expect(moved!.scheduled_at.toISOString()).toBe(early.scheduled_at);
  }, 180_000);

  it("the board report flags a Swiss board ahead of an earlier round, and never a bye that holds a slot", async () => {
    // A bye takes no slot since T3 (SWISS_BYE_NOT_PLACEABLE, V483), but a legacy row — or a history Undo of a
    // pre-deploy step — can still carry one. Round order is about boards: a bye is not play, so it is no round's
    // board, and it must not surface as "round 2 starts before round 1".
    const [players, rounds] = [5, 2];
    const base = await division(players, 2);
    const [stage] = await createStages(base.auth, base.divisionId, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds }, progression: null });
    const rig = { ...base, stageId: stage!.id };
    await generateStageFixtures(rig.auth, rig.stageId); // mint
    await applyAuto(rig, await autoSchedule(rig.auth, rig.stageId, { only_unlocked: false, mode: "build" }));
    const { boards, byes } = await split(rig.stageId, players, rounds);
    const first = Math.min(...stored(boards).map((p) => p.startMs));
    const before = (m: number) => new Date(first - m * MIN).toISOString();

    const bye2 = byes.find((b) => b.round_no === 2)!;
    await sql`update fixtures set scheduled_at = ${before(120)}, court_id = ${rig.courts[0]!} where id = ${bye2.id}`;
    const withBye = orderConflicts((await validateSchedule(rig.auth, rig.divisionId)).conflicts);
    expect(withBye.filter((c) => c.fixture_id === bye2.id), "a round-2 bye ahead of round 1 is no round-order conflict").toEqual([]);

    // Positive pair: a round-2 BOARD in the same position is one.
    const board2 = boards.find((b) => b.round_no === 2)!;
    await sql`update fixtures set scheduled_at = ${before(60)}, court_id = ${rig.courts[1]!} where id = ${board2.id}`;
    const withBoard = orderConflicts((await validateSchedule(rig.auth, rig.divisionId)).conflicts);
    expect(withBoard.some((c) => c.fixture_id === board2.id), "a round-2 board ahead of round 1 is flagged").toBe(true);
    expect(withBoard.filter((c) => c.fixture_id === bye2.id), "and the bye still is not").toEqual([]);
  }, 180_000);
});

describe.runIf(HAS_DB)("W3 T3b each stage orders on its own: a league and a Swiss stage in one division", () => {
  it("the Swiss stage's round 1 after the league's round 3 is no conflict; each stage's own rounds stay in order", async () => {
    const players = 4;
    const base = await division(players, 2);
    const [league, swiss] = await createStages(base.auth, base.divisionId, [
      { seq: 1, kind: "league", name: "League", config: {}, progression: null },
      { seq: 2, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null },
    ]);
    await generateStageFixtures(base.auth, league!.id);
    await generateStageFixtures(base.auth, swiss!.id); // mint

    // The league laid down by hand, round by round from 09:00 on both courts, so the Swiss boards can only go after it.
    const leagueRows = await rowsOf(league!.id);
    const leagueRounds = [...new Set(leagueRows.map((r) => r.round_no))].sort((a, b) => a - b);
    expect(leagueRounds.length, "premise: a 4-player single round robin plays 3 rounds").toBe(players - 1);
    await applySchedule(base.auth, league!.id, {
      assignments: leagueRounds.flatMap((round, i) =>
        leagueRows
          .filter((r) => r.round_no === round)
          .map((r, k) => ({ fixture_id: r.id, scheduled_at: at(i * MATCH_MINUTES), court_id: base.courts[k % base.courts.length]! })),
      ),
      source: "manual",
    });

    const rig = { ...base, stageId: swiss!.id };
    const swissBoards = (await split(swiss!.id, players, 2)).boards;
    const out = await autoSchedule(rig.auth, rig.stageId, { only_unlocked: false, mode: "build" });
    const engine = `engine=${out.solver.engine}`;
    // Were the league's rounds read as the Swiss stage's own, the solver would owe Swiss round 1 a start before league
    // round 2 — on courts the league fills — and could not place it.
    expect(out.assignments.length, `every Swiss board is placed (${engine})`).toBe(2 * boardsPerRound(players));
    const order = roundOrder(proposed(out, swissBoards));
    expect(order.inverted, `the Swiss rounds keep their order (${engine})`).toEqual([]);
    expect(order.pairs, "anti-vacuity: Swiss pairs").toBe(crossRoundPairs(players, 2));
    expect(orderConflicts(out.conflicts), "no round-order conflict").toEqual([]);
    await applyAuto(rig, out);

    const leagueStored = stored(await rowsOf(league!.id));
    const swissStored = stored(await rowsOf(swiss!.id));
    const leagueOrder = roundOrder(leagueStored);
    expect(leagueOrder.inverted, "the league keeps its order").toEqual([]);
    expect(leagueOrder.pairs, "anti-vacuity: league pairs").toBe(((3 * 2) / 2) * 2 * 2);
    // The witness: pairs that WOULD be inversions if the two stages were one sequence (a lower round number starting
    // after a higher one). Without any, "no cross-stage comparison" would be untested.
    const crossStage = roundOrder([...leagueStored, ...swissStored]).inverted.length;
    expect(crossStage, "witness: the board holds cross-stage pairs that one sequence would call inverted").toBeGreaterThan(0);
    expect(orderConflicts((await validateSchedule(base.auth, base.divisionId)).conflicts), "the board report compares no stage with another").toEqual([]);
  }, 240_000);
});

describe.runIf(HAS_DB)("W3 T3b the round-sequence gate: Swiss in, its playoff and knockout tails out", () => {
  // The swiss_playoff and swiss_knockout templates are a Swiss stage then a bracket-shaped tail; a bracket is ordered
  // by its feed edges, never by round number (C1 design, "Round namespace"). Kinds read from the templates themselves.
  for (const template of ["swiss_playoff", "swiss_knockout"]) {
    it(`${template}: the Swiss stage is a round sequence, its tail is not`, async () => {
      const base = await division(8, 1);
      const drafts = buildTemplateStages(template, { qualified: 4, swissRounds: 3, poolCount: 1, legs: 1 });
      expect(drafts.map((d) => d.kind)[0], "premise: the template opens with a Swiss stage").toBe("swiss");
      // The template's drafts as the API takes them (the same cast table-rules-pin.test.ts makes): `kind` is a string.
      const created = await createStages(base.auth, base.divisionId, drafts.map((d, i) => ({ seq: i + 1, ...d })) as CreateStages);
      const ids = await withTenant(base.auth.orgId, (tx) => roundRobinStageIds(tx, base.divisionId));
      const verdict = created.map((s) => [s!.kind, ids.has(s!.id)]);
      expect(verdict.length, "anti-vacuity: both stages").toBe(2);
      expect(verdict).toEqual(drafts.map((d) => [d.kind, d.kind === "swiss"]));
    }, 60_000);
  }
});
