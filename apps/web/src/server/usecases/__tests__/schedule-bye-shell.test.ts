// W3 Task 3 (SW-M13; X-SW-29 is RB3-23): "A bye shell is never on a court and never printed." A Swiss stage mints its
// round's bye row as a shell before Pair (`sw-r{N}-bye`, status `scheduled`, no seats), so to every placement writer it
// looked like one more movable fixture: the auto pass gave it a court and a time, the board let a drag drop it on one,
// and a quick Start's rolling times stamped it. A bye is not played; it takes no court and no time.
//
// "Holds a slot" is ONE predicate in this branch (`holdsSlot`, lib/rebuild-slots.ts — time, court, venue or pin), so
// every assertion below reads it rather than a column of its own choosing.
//
// single-sport: badminton — every predicate under test reads `ext_key` and the slot columns, no sport field.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { holdsSlot } from "@/lib/rebuild-slots";
import { isSwissByeShellExtKey } from "@/lib/swiss-shell";
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { playedFixtureIds } from "../fixture-results-sql";
import { applySchedule, autoSchedule, isMovable, movableFixtureSql, moveFixture, putScheduleSettings, startDivision } from "../schedule";
import { listDivisionFixtures, listDivisionFixturesForBoard } from "../fixtures";
import { buildRunSheet } from "@/lib/run-sheet-groups";
import { getCompetitionDesk } from "../competition-desk";
import { createStages, generateStageFixtures } from "../stages";
import { boardMovable, inBoardTray } from "@/components/v2/board/types";
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

interface Rig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
  courts: string[];
}

/** Five players (odd: every round has a bye) in a 2-round badminton Swiss, two courts, schedule settings saved. */
async function oddSwiss(settings: { roundMinutes?: number } = {}): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Bye court " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 5 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null });
  const venue = await createVenue(auth, { name: "Hall", sort: 0 });
  const c1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
  const c2 = await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: "2030-08-01T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [c1.id, c2.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
      ...settings,
    },
    tz: "UTC",
  });
  return { auth, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, courts: [c1.id, c2.id] };
}

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  scheduled_at: Date | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, status, home_entrant_id, scheduled_at, court_id, venue_id, schedule_locked
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

/** The stage's rows split by the one bye-shell predicate, each half non-empty (anti-vacuity). */
async function split(stageId: string): Promise<{ byes: Row[]; boards: Row[] }> {
  const rows = await rowsOf(stageId);
  const byes = rows.filter((r) => isSwissByeShellExtKey(r.ext_key));
  const boards = rows.filter((r) => !isSwissByeShellExtKey(r.ext_key));
  expect(byes.length, "rig: an odd field mints a bye shell per round").toBe(2);
  expect(boards.length, "rig: … and two boards per round").toBe(4);
  return { byes, boards };
}

/** A pre-Start Swiss with its shells minted (Generate's first press) and nothing paired. */
async function shells(settings: { roundMinutes?: number } = {}): Promise<Rig> {
  const rig = await oddSwiss(settings);
  await generateStageFixtures(rig.auth, rig.stageId);
  const { byes } = await split(rig.stageId);
  expect(byes.every((b) => b.status === "scheduled" && b.home_entrant_id === null), "premise: unseated shells").toBe(true);
  return rig;
}

describe.runIf(HAS_DB)("W3 T3 X-SW-29 a Swiss bye shell never takes a court", () => {
  it("X-SW-29 the auto pass never places a Swiss bye shell", async () => {
    const rig = await shells();
    const { byes } = await split(rig.stageId);
    const byeIds = new Set(byes.map((b) => b.id));

    const build = await autoSchedule(rig.auth, rig.stageId, { only_unlocked: false, mode: "build" });
    expect(build.assignments.filter((a) => byeIds.has(a.fixture_id)), "the proposal names no bye shell").toEqual([]);
    expect(build.assignments.length, "anti-vacuity: the pass placed the boards").toBe(4);
    await applySchedule(rig.auth, rig.stageId, {
      assignments: build.assignments.map((a) => ({ fixture_id: a.fixture_id, scheduled_at: a.scheduled_at, court_id: a.court_id })),
      source: "auto",
    });

    const after = await split(rig.stageId);
    expect(after.byes.filter(holdsSlot), "zero bye shells hold a slot").toEqual([]);
    expect(after.boards.filter(holdsSlot).length, "anti-vacuity: every board was placed").toBe(4);

    // An apply handed a bye shell anyway (a stale client, a hand-built body) skips it, the way it skips a row that holds
    // a result: nothing is written to the bye, and the rest of the apply lands.
    const board = after.boards[0]!;
    const stale = await applySchedule(rig.auth, rig.stageId, {
      assignments: [
        { fixture_id: byes[0]!.id, scheduled_at: "2030-08-01T15:00:00.000Z", court_id: rig.courts[0]! },
        { fixture_id: board.id, scheduled_at: "2030-08-01T16:00:00.000Z", court_id: rig.courts[1]! },
      ],
      source: "manual",
    });
    expect(stale, "the apply reports the bye it skipped").toMatchObject({ skipped: 1 });
    const again = await split(rig.stageId);
    expect(again.byes.filter(holdsSlot), "the stale bye assignment wrote nothing").toEqual([]);
    expect(again.boards.find((b) => b.id === board.id)!.court_id, "positive pair: the board in the same apply moved").toBe(rig.courts[1]);
  }, 120_000);

  it("X-SW-29 the AI counts (movableFixtureSql) agree with isMovable: a bye shell is not movable, seated or not", async () => {
    // `movableFixtureSql` is `isMovable` as SQL — the counts that price, drop and size an AI run
    // (schedule-ai-preview.ts, competition-schedule-ai.ts). They must count exactly what a builder moves.
    const rig = await shells();
    await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1: one seated bye, one unseated
    const { byes } = await split(rig.stageId);
    expect(byes.map((b) => b.status).sort(), "premise: one bye seated, one still a shell").toEqual(["forfeited", "scheduled"]);
    const { sqlIds, jsIds } = await sql.begin(async (tx) => {
      const played = await playedFixtureIds(tx, rig.divisionId);
      const all = await tx<{ id: string; status: string; ext_key: string | null }[]>`
        select id, status, ext_key from fixtures where stage_id = ${rig.stageId}`;
      const viaSql = await tx<{ id: string }[]>`select f.id from fixtures f where f.stage_id = ${rig.stageId} and ${movableFixtureSql(tx)}`;
      return { sqlIds: viaSql.map((r) => r.id).sort(), jsIds: all.filter((f) => isMovable(f, played)).map((f) => f.id).sort() };
    });
    expect(sqlIds, "the SQL twin moves what the builder moves").toEqual(jsIds);
    expect(sqlIds.filter((id) => byes.some((b) => b.id === id)), "no bye shell is movable").toEqual([]);
    expect(sqlIds.length, "anti-vacuity: the four boards are movable").toBe(4);
  }, 120_000);

  it("X-SW-29 the board read marks every Swiss bye row, and the board offers it no drag and no tray place", async () => {
    // The real producer of the board's rows (`listDivisionFixturesForBoard`) into the board's own predicates.
    const rig = await shells();
    await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1: one seated bye, one unseated shell
    const { byes, boards } = await split(rig.stageId);
    const rows = await listDivisionFixturesForBoard(rig.auth, rig.divisionId);
    expect(rows.length, "anti-vacuity: the board read every row").toBe(6);
    const marked = rows.filter((r) => r.bye_shell === true).map((r) => r.id).sort();
    expect(marked, "both bye rows are marked, seated or not").toEqual(byes.map((b) => b.id).sort());
    for (const r of rows.filter((x) => x.bye_shell !== true)) {
      expect(Object.prototype.hasOwnProperty.call(r, "bye_shell"), `${r.id}: sent only when true`).toBe(false);
    }
    const unseated = rows.find((r) => r.id === byes.find((b) => b.status === "scheduled")!.id)!;
    expect([boardMovable(unseated), inBoardTray(unseated)], "the unseated shell: no drag, no tray").toEqual([false, false]);
    const boardShells = rows.filter((r) => boards.some((b) => b.id === r.id) && r.status === "scheduled");
    expect(boardShells.length, "anti-vacuity: the board shells").toBe(4);
    expect(boardShells.every((r) => boardMovable(r) && inBoardTray(r)), "positive pair: every board shell is offered").toBe(true);
  }, 120_000);

  it("X-SW-29 the desk counts no Swiss bye shell as unscheduled work: once the boards are placed, nothing is owed", async () => {
    // A bye shell can never be given a time (SWISS_BYE_NOT_PLACEABLE), so counting it would leave a red "N unscheduled"
    // on the division that no organiser action clears. Sequence: minted (boards owed), boards placed (nothing owed),
    // round 1 paired (its bye seated and settled; still nothing owed).
    const rig = await shells();
    const at = new Date("2030-07-01T10:00:00Z");
    const owed = async () => {
      const d = (await getCompetitionDesk(rig.auth, rig.competitionId, at)).divisions.get(rig.divisionId)!;
      return { field: d.unscheduled, attention: d.attention.find((a) => a.kind === "unscheduled") ?? null };
    };
    expect(await owed(), "minted: the four board shells are owed a slot, the two bye shells are not").toEqual({
      field: 4,
      attention: { kind: "unscheduled", count: 4 },
    });
    const build = await autoSchedule(rig.auth, rig.stageId, { only_unlocked: false, mode: "build" });
    await applySchedule(rig.auth, rig.stageId, {
      assignments: build.assignments.map((a) => ({ fixture_id: a.fixture_id, scheduled_at: a.scheduled_at, court_id: a.court_id })),
      source: "auto",
    });
    const { byes } = await split(rig.stageId);
    expect(byes.filter((b) => b.status === "scheduled" && b.scheduled_at === null).length, "premise: two untimed bye shells remain").toBe(2);
    expect(await owed(), "every board placed: nothing is owed").toEqual({ field: 0, attention: null });
    await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
    expect(await owed(), "round 1 paired: still nothing owed").toEqual({ field: 0, attention: null });
  }, 120_000);

  it("X-SW-29 the run sheet, fed the division page's own rows: no unseated bye shell; the seated bye is a settled row", async () => {
    // The real producer (`listDivisionFixtures`, the division page's read) into the real builder, adapted the way
    // stages-panel.tsx's `toRunSheetFixture` does (the optional feed columns defaulted, the row otherwise spread).
    const rig = await shells();
    const sheet = async () => {
      const rows = await listDivisionFixtures(rig.auth, rig.divisionId);
      const blocks = buildRunSheet({
        fixtures: rows.map((f) => ({
          ...f,
          home_slot_label: f.home_slot_label ?? null,
          away_slot_label: f.away_slot_label ?? null,
          venue_name: f.venue_name ?? null,
          officials: f.officials ?? [],
        })),
        stages: [{ id: rig.stageId, seq: 1, kind: "swiss" }],
        tz: "UTC",
        nowMs: Date.parse("2030-07-01T10:00:00Z"),
      });
      return new Map(blocks.flatMap((b) => ("fixtures" in b ? b.fixtures.map((f) => [f.id, b.kind] as const) : [])));
    };
    const { byes, boards } = await split(rig.stageId);
    const minted = await sheet();
    expect(byes.filter((b) => minted.has(b.id)), "minted: neither bye shell is on the sheet").toEqual([]);
    expect(boards.every((b) => minted.get(b.id) === "unscheduled"), "positive pair: every board shell is owed a slot").toBe(true);

    await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
    const paired = await sheet();
    const [r1, r2] = [byes.find((b) => b.round_no === 1)!, byes.find((b) => b.round_no === 2)!];
    expect([paired.get(r1.id), paired.has(r2.id)], "round 1's seated bye is a settled row; round 2's shell is still nowhere").toEqual([
      "settled",
      false,
    ]);
  }, 120_000);

  it("X-SW-29 moveFixture onto a bye shell refuses SWISS_BYE_NOT_PLACEABLE", async () => {
    const rig = await shells();
    const { byes, boards } = await split(rig.stageId);
    const refusal = { status: SWISS_REFUSALS.SWISS_BYE_NOT_PLACEABLE.status, code: "SWISS_BYE_NOT_PLACEABLE" };
    const at = "2030-08-01T10:00:00.000Z";

    // An unseated shell: a time, a court, both, or a pin — each is a slot (`holdsSlot`).
    for (const patch of [{ scheduled_at: at }, { court_id: rig.courts[0]! }, { scheduled_at: at, court_id: rig.courts[0]! }, { schedule_locked: true }]) {
      await expect(moveFixture(rig.auth, byes[0]!.id, patch), `unseated bye shell, ${JSON.stringify(patch)}`).rejects.toMatchObject(refusal);
    }
    // A seated bye (Pair round 1: the bye is `forfeited`) gets the same named refusal, not the generic status one.
    await generateStageFixtures(rig.auth, rig.stageId);
    const seated = (await split(rig.stageId)).byes.find((b) => b.round_no === 1)!;
    expect([seated.status, seated.home_entrant_id !== null], "premise: round 1's bye is seated").toEqual(["forfeited", true]);
    await expect(moveFixture(rig.auth, seated.id, { scheduled_at: at, court_id: rig.courts[0]! }), "seated bye").rejects.toMatchObject(refusal);
    expect((await split(rig.stageId)).byes.filter(holdsSlot), "nothing written by a refused move").toEqual([]);

    // Taking a slot AWAY is not placing one: a legacy bye holding a time (pre-V483) can be cleared by hand.
    const unseated = (await split(rig.stageId)).byes.find((b) => b.round_no === 2)!;
    await sql`update fixtures set scheduled_at = ${at}, court_id = ${rig.courts[0]!} where id = ${unseated.id}`;
    await expect(moveFixture(rig.auth, unseated.id, { scheduled_at: null, court_id: null }), "clearing a bye's legacy slot").resolves.toBeDefined();
    expect(holdsSlot((await split(rig.stageId)).byes.find((b) => b.id === unseated.id)!), "the legacy slot is cleared").toBe(false);

    // Positive pair: a board shell of the same stage moves.
    const board = boards.find((b) => b.round_no === 2)!;
    await expect(moveFixture(rig.auth, board.id, { scheduled_at: at, court_id: rig.courts[1]! }), "a board shell moves").resolves.toBeDefined();
    expect((await split(rig.stageId)).boards.find((b) => b.id === board.id)!.court_id).toBe(rig.courts[1]);
  }, 120_000);

  it("X-SW-29 seating a bye clears a slot the shell held", async () => {
    // A legacy shell (placed before this fix, or by a writer this branch does not know): every slot field set.
    const rig = await shells();
    const { byes, boards } = await split(rig.stageId);
    const r1 = byes.find((b) => b.round_no === 1)!;
    const [venue] = await sql<{ venue_id: string }[]>`select venue_id from courts where id = ${rig.courts[0]!}`;
    await sql`
      update fixtures set scheduled_at = '2030-08-01T11:00:00Z', court_id = ${rig.courts[0]!}, venue_id = ${venue!.venue_id},
        schedule_locked = true
      where id = ${r1.id}`;
    // A board's slot is the control: Pair carries it.
    const board = boards.find((b) => b.round_no === 1)!;
    await sql`update fixtures set scheduled_at = '2030-08-01T12:00:00Z', court_id = ${rig.courts[1]!} where id = ${board.id}`;
    expect(holdsSlot((await split(rig.stageId)).byes.find((b) => b.id === r1.id)!), "premise: the shell holds a slot").toBe(true);

    await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
    const after = await split(rig.stageId);
    const seated = after.byes.find((b) => b.id === r1.id)!;
    expect([seated.status, seated.home_entrant_id !== null], "premise: the bye was seated").toEqual(["forfeited", true]);
    expect(
      { scheduled_at: seated.scheduled_at, court_id: seated.court_id, venue_id: seated.venue_id, schedule_locked: seated.schedule_locked },
      "the seated bye holds no slot",
    ).toEqual({ scheduled_at: null, court_id: null, venue_id: null, schedule_locked: false });
    const placedBoards = after.boards.filter((b) => b.round_no === 1 && holdsSlot(b));
    expect(placedBoards.length, "positive pair: the round's board slot survives Pair").toBe(1);
  }, 120_000);

  it("X-SW-29 a quick Start's rolling times skip the bye shells", async () => {
    // `startDivision` mints the first stage and writes round r's time across it (doc 12 §1.A `roundMinutes`).
    const rig = await oddSwiss({ roundMinutes: 45 });
    await startDivision(rig.auth, rig.divisionId);
    const { byes, boards } = await split(rig.stageId);
    expect(byes.filter(holdsSlot), "no rolling time on a bye shell").toEqual([]);
    expect(boards.filter((b) => b.scheduled_at !== null).length, "anti-vacuity: every board got its round's time").toBe(4);
  }, 120_000);
});
