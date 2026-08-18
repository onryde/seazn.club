// #350 Task 6 — applyCompetitionSchedule acceptance: ONE transaction writes
// every selected division's assignments, or none of them.
//
// Everything in this product's apply path is single-division today (one
// advisory lock, one seq assertion, one seq bump), and the board orchestrates a
// multi-division apply by calling the per-stage endpoint in a loop — so a
// failure halfway through leaves half the board written. Spec §8 requires the
// opposite, and "a stale expected_seq on the SECOND division rolls back the
// FIRST" is the test that can tell the two apart.
//
// THE SEED IS DELIBERATELY ASYMMETRIC (Alpha 6 fixtures, Bravo 3): two
// identically-sized divisions cannot distinguish per-division data from
// first-division-wins.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { EngineError } from "@seazn/engine/core";
import type { Conflict } from "@seazn/engine/scheduling";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { schedulingAiModel } from "../schedule-ai";
import {
  COMPETITION_MOVABLE_CAP,
  JOINT_APPLY_EVENT,
  lastCompetitionAiApply,
} from "../competition-schedule-ai";
import {
  ApplyCompetitionScheduleRequest,
  ApplyCompetitionScheduleResult,
} from "@/server/api-v1/schemas";
import {
  applyCompetitionSchedule,
  lockDivisions,
  lockOrder,
  sortConflicts,
  type CompetitionApplyDivision,
  type CompetitionApplyOut,
} from "../competition-schedule-apply";
import { seedCourts, seedOrg } from "./_seed";

/**
 * Every `afterScheduleWrite` this module fires, in order.
 *
 * A RECORDING passthrough, not a stub: the real invalidation still runs, so the
 * 21 tests that were green before this spy existed stay green for the same
 * reasons. Firing it once per WRITTEN division is the whole point of an
 * N-division apply — a division whose board changed but whose cache was never
 * busted serves the pre-apply timetable to the public site until something else
 * happens to invalidate it — and `for (const id of out.divisionIds)` narrowed to
 * `.slice(0, 1)` left this suite at 21/0.
 */
const sched = vi.hoisted(() => ({ afterWrite: [] as [string, string, string][] }));
vi.mock("../schedule", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../schedule")>();
  return {
    ...actual,
    afterScheduleWrite: (divisionId: string, competitionId: string, reason: "schedule") => {
      sched.afterWrite.push([divisionId, competitionId, reason]);
      return actual.afterScheduleWrite(divisionId, competitionId, reason);
    },
  };
});

/**
 * COMPILE-TIME half of the wire contract (the runtime half is the
 * `ApplyCompetitionScheduleResult.parse` in the blackout test below).
 *
 * `tsc` is the only thing that can catch the usecase's return type drifting away
 * from the schema the route publishes. Zod cannot: it STRIPS keys the schema
 * does not declare, so a drift shows up as fields silently missing from a 200,
 * never as an exception. Substituting `ScheduleConflict[]` for `Conflict[]` on
 * either side must fail here.
 */
const _wireBridge: ApplyCompetitionScheduleResult = null as unknown as CompetitionApplyOut;
void _wireBridge;

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const T0 = Date.parse("2026-08-01T09:00:00.000Z");
const MIN = 60_000;
const TZ = "Europe/London";
const at = (offsetMin: number): string => new Date(T0 + offsetMin * MIN).toISOString();

/** Wide session window, no constraints: a well-spaced board verifies clean, so
 *  any conflict a test sees is the one that test seeded. */
function settingsConfig(courts: string[]) {
  return {
    startAt: at(0),
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [{ from: at(0), to: at(720) }],
  };
}

interface SeededDivision {
  id: string;
  name: string;
  /** Fixture ids in (round_no, seq_in_round) order. */
  fixtureIds: string[];
}

interface Board {
  competitionId: string;
  alpha: SeededDivision;
  bravo: SeededDivision;
  /** P9 pass 3b: the real courts.id values this board's two divisions were
   *  configured with — court1 shared by both (what makes a cross-division
   *  clash expressible), court2 Alpha's own, court3 Bravo's own. */
  courts: { court1: string; court2: string; court3: string };
}

async function seedDivision(
  auth: AuthCtx,
  competitionId: string,
  name: string,
  entrants: number,
  courts: string[],
): Promise<SeededDivision> {
  const slug = name.toLowerCase();
  const division = await createDivision(auth, competitionId, {
    name,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrants }, (_, i) => ({
      kind: "individual" as const,
      display_name: `${slug}-E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(courts))}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const ordered = [...fixtures].sort(
    (a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round,
  );
  return { id: division.id, name, fixtureIds: ordered.map((f) => f.id) };
}

/** Alpha: 4 entrants -> 6 round-robin fixtures. Bravo: 3 -> 3. Both own the
 *  SAME first court (a real courts.id, P9) — what makes a cross-division
 *  clash expressible at all: cross-division court identity is now a real,
 *  org-wide-unique entity, never a organiser-typed label two physically
 *  different courts could collide on by accident. */
async function seedBoard(auth: AuthCtx): Promise<Board> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Joint Apply Cup ${Date.now()}`,
    visibility: "public",
    branding: {},
  });
  const [court1, court2, court3] = await seedCourts(auth.orgId, 3);
  const alpha = await seedDivision(auth, comp.id, "Alpha", 4, [court1!, court2!]);
  const bravo = await seedDivision(auth, comp.id, "Bravo", 3, [court1!, court3!]);
  return { competitionId: comp.id, alpha, bravo, courts: { court1: court1!, court2: court2!, court3: court3! } };
}

/** Patch a division's stored `constraints` — the family the joint verifier reads
 *  through `verifyConfigFor`. Written straight to the row: `putScheduleSettings`
 *  would drag in the `scheduling.constraints` entitlement, which is not what
 *  these tests are about. */
async function setConstraints(
  divisionId: string,
  courts: string[],
  constraints: object,
): Promise<void> {
  await sql`
    update schedule_settings
    set config = ${sql.json({ ...settingsConfig(courts), constraints } as never)}
    where division_id = ${divisionId}`;
}

/** One person rostered into one entrant of each named fixture — the only way to
 *  make a `person_overlap` conflict, within a division or across two. */
async function sharePerson(orgId: string, fixtureIds: string[]): Promise<string> {
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name)
    values (${orgId}, ${"Shared Player " + randomUUID().slice(0, 6)}) returning id`;
  for (const fixtureId of fixtureIds) {
    const [row] = await sql<{ home_entrant_id: string }[]>`
      select home_entrant_id from fixtures where id = ${fixtureId}`;
    await sql`
      insert into entrant_members (entrant_id, person_id, org_id)
      values (${row!.home_entrant_id}, ${person!.id}, ${orgId})`;
  }
  return person!.id;
}

async function divisionSeq(divisionId: string): Promise<number> {
  const [row] = await sql<{ seq: string | number }[]>`
    select seq from divisions where id = ${divisionId}`;
  return Number(row?.seq ?? 0);
}

async function eventCount(divisionId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from division_events where division_id = ${divisionId}`;
  return row!.n;
}

async function maxEventSeq(divisionId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select coalesce(max(seq), 0)::int as n from division_events where division_id = ${divisionId}`;
  return row!.n;
}

async function slots(
  divisionId: string,
): Promise<{ id: string; at: string | null; court: string | null; source: string | null }[]> {
  const rows = await sql<
    { id: string; scheduled_at: Date | null; court_id: string | null; schedule_source: string | null }[]
  >`
    select id, scheduled_at, court_id, schedule_source from fixtures
    where division_id = ${divisionId}
    order by round_no, seq_in_round, id`;
  return rows.map((r) => ({
    id: r.id,
    at: r.scheduled_at === null ? null : new Date(r.scheduled_at).toISOString(),
    court: r.court_id,
    source: r.schedule_source,
  }));
}

/** Every fixture still unplaced — "nothing was written". */
const unplaced = (rows: Awaited<ReturnType<typeof slots>>): boolean =>
  rows.every((r) => r.at === null && r.court === null);

/** Sequential slots on one court, starting at `startMin`. */
function lineUp(
  division: SeededDivision,
  expectedSeq: number,
  court: string,
  startMin: number,
): CompetitionApplyDivision {
  return {
    division_id: division.id,
    expected_seq: expectedSeq,
    assignments: division.fixtureIds.map((fixture_id, i) => ({
      fixture_id,
      scheduled_at: at(startMin + i * 30),
      court_id: court,
    })),
  };
}

/** A neutral constraints row. Tests vary ONE field off this so the arms of an
 *  A/B differ by that field and nothing else — in particular never by
 *  "constraints row absent vs present", which is a different code path. */
const BASE_CONSTRAINTS = {
  restMin: 0,
  noBackToBack: false,
  startWindows: [] as unknown[],
  fieldFairness: "off",
  parallelism: "mixed",
  crossPersonClash: "warn",
};

const AI = {
  instruction: "  Fit both divisions into the morning.  ",
  summary: "Alpha on Court 1, Bravo on Court 3.",
  model: "not-the-model-that-ran",
  repair_rounds: 1,
};

// ---------------------------------------------------------------------------
// No database needed. Kept out of the suite below so these do not pay its
// per-test seeding — the house pattern for a pure helper (shouldFireMadePublic,
// competitionLifecycleEvent).
// ---------------------------------------------------------------------------
describe("joint apply — pure contracts", () => {
  it("locks are taken in sorted division-id order", async () => {
    // Sorting is the DEADLOCK GUARD: two concurrent joint applies over
    // overlapping division sets that lock in different orders deadlock.
    const ids = [
      "ffffffff-0000-4000-8000-000000000003",
      "11111111-0000-4000-8000-000000000001",
      "88888888-0000-4000-8000-000000000002",
    ];
    const sorted = [...ids].sort();
    expect(lockOrder(ids)).toEqual(sorted);
    // Duplicates collapse — a repeated division must not be locked twice.
    expect(lockOrder([...ids, ids[0]!])).toEqual(sorted);
    // The input is never mutated in place.
    const copy = [...ids];
    lockOrder(copy);
    expect(copy).toEqual(ids);

    // …and the statement the transaction actually emits follows that order.
    const seen: unknown[] = [];
    const fakeTx = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      seen.push(values[0]);
      return Promise.resolve([]);
    }) as unknown as postgres.TransactionSql;
    await lockDivisions(fakeTx, ids);
    expect(seen).toEqual(sorted.map((id) => `division:${id}`));
  });

  it("an assignment carrying schedule_locked is a 400, not a stripped 200", async () => {
    // The plan's own `proposal` entries carry an optional `schedule_locked`, and
    // zod strips unknown keys — so without `.strict()` a plan asking to pin a
    // fixture applies cleanly and silently loses the pin. Loud beats silent.
    const base = {
      division_id: "11111111-0000-4000-8000-000000000001",
      expected_seq: 0,
      assignments: [
        {
          fixture_id: "22222222-0000-4000-8000-000000000002",
          scheduled_at: "2026-08-01T09:00:00.000Z",
          // Pure schema test, no DB — any uuid-shaped string satisfies
          // CourtId here (P9 pass 3b: court_id, not the legacy court_label
          // this schema no longer accepts at all).
          court_id: randomUUID(),
        },
      ],
    };
    // The same body without the extra key parses, so the rejection below is the
    // extra key and nothing else.
    expect(() =>
      ApplyCompetitionScheduleRequest.parse({ divisions: [base], source: "ai" }),
    ).not.toThrow();
    expect(() =>
      ApplyCompetitionScheduleRequest.parse({
        divisions: [
          { ...base, assignments: [{ ...base.assignments[0]!, schedule_locked: true }] },
        ],
        source: "ai",
      }),
    ).toThrow();
  });

  it("orders equal-rank, same-reason conflicts by their canonical detail, not by fixtureId (C3 review finding 6)", () => {
    // An empty `order` sends every conflict through the identical UNRANKED
    // fallback, so the comparator falls straight through rank and reason to
    // the detail-suffix compare this test targets — no fixture/division
    // scaffolding needed for a comparator this pure.
    const FIXTURE_LOW = "11111111-0000-4000-8000-000000000001";
    const FIXTURE_HIGH = "99999999-0000-4000-8000-000000000009";
    const conflictFor = (fixtureId: string, otherFixtureId: string): Conflict => ({
      fixtureId,
      reason: "court",
      details: { kind: "court_double_booking", otherFixtureId, court: "Court 1" },
    });
    // otherFixtureId order is the OPPOSITE of fixtureId order — the only
    // way to tell "sorted by canonical detail" apart from "sorted by
    // fixtureId" (which is what comparing the whole `conflictKey` — LED by
    // `fixtureId` — silently regresses to).
    const low = conflictFor(FIXTURE_LOW, "zzzzzzzz-0000-4000-8000-000000000009");
    const high = conflictFor(FIXTURE_HIGH, "00000000-0000-4000-8000-000000000000");

    expect(sortConflicts([low, high], [])).toEqual([high, low]);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("applyCompetitionSchedule (#350)", () => {
  let auth: AuthCtx;
  let board: Board;

  beforeEach(async () => {
    if (!HAS_DB) return;
    ({ auth } = await seedOrg("pro"));
    board = await seedBoard(auth);
  }, 90_000);

  const clean = async (): Promise<{ alpha: CompetitionApplyDivision; bravo: CompetitionApplyDivision }> => ({
    alpha: lineUp(board.alpha, await divisionSeq(board.alpha.id), board.courts.court1, 0),
    bravo: lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 0),
  });

  it("writes every division's assignments in one go", async () => {
    const { alpha, bravo } = await clean();
    const out = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    // 6 + 3 — asymmetric on purpose: a symmetric board cannot tell a real
    // per-division write from the first division's write repeated.
    expect(out.applied).toBe(9);

    const alphaRows = await slots(board.alpha.id);
    expect(alphaRows.map((r) => r.at)).toEqual(alpha.assignments.map((a) => a.scheduled_at));
    expect(alphaRows.map((r) => r.court)).toEqual(alpha.assignments.map(() => board.courts.court1));
    expect(alphaRows.map((r) => r.source)).toEqual(alpha.assignments.map(() => "ai"));

    const bravoRows = await slots(board.bravo.id);
    expect(bravoRows).toHaveLength(3);
    expect(bravoRows.map((r) => r.at)).toEqual(bravo.assignments.map((a) => a.scheduled_at));
    expect(bravoRows.map((r) => r.court)).toEqual(bravo.assignments.map(() => board.courts.court3));
    expect(bravoRows.map((r) => r.source)).toEqual(bravo.assignments.map(() => "ai"));

    // A clean, well-spaced board: no conflict is invented.
    expect(out.conflicts).toEqual([]);
  }, 60_000);

  it("a stale expected_seq on the SECOND division rolls back the FIRST", async () => {
    // Run BOTH directions. Whichever division the implementation happens to
    // write first, one of these two cases is a genuine rollback assertion — a
    // one-directional version passes vacuously the day the write order flips.
    for (const stale of ["alpha", "bravo"] as const) {
      ({ auth } = await seedOrg("pro"));
      board = await seedBoard(auth);
      const { alpha, bravo } = await clean();
      const poison = (d: CompetitionApplyDivision): CompetitionApplyDivision => ({
        ...d,
        expected_seq: d.expected_seq + 7,
      });
      await expect(
        applyCompetitionSchedule(auth, board.competitionId, {
          divisions: [stale === "alpha" ? poison(alpha) : alpha, stale === "bravo" ? poison(bravo) : bravo],
          source: "ai",
          ai: AI,
        }),
      ).rejects.toMatchObject({ code: "SEQ_CONFLICT" });

      // NOTHING is written — including the division whose seq was fine.
      expect(unplaced(await slots(board.alpha.id))).toBe(true);
      expect(unplaced(await slots(board.bravo.id))).toBe(true);
      // …and no ledger row survives either.
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from division_events
        where division_id in (${board.alpha.id}, ${board.bravo.id})
          and type = 'schedule_applied'`;
      expect(row!.n).toBe(0);
    }
  }, 120_000);

  it("a cross-division court clash is a 409 and writes nothing", async () => {
    const { alpha } = await clean();
    // Bravo lands on Court 1 at exactly Alpha's first three slots.
    const bravo = lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court1, 0);
    let caught: unknown;
    try {
      await applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      });
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught)).toBe(true);
    // SCHEDULE_CONFLICT is 409 in the /api/v1 engine-code map.
    expect((caught as EngineError).code).toBe("SCHEDULE_CONFLICT");
    const conflicts = (caught as EngineError).data as { conflicts: { fixtureId: string; reason: string }[] };
    expect(conflicts.conflicts.some((c) => c.reason === "court")).toBe(true);
    // Both SIDES of the clash are named — the report must not collapse a
    // cross-division clash onto whichever division verified first.
    const clashing = new Set(
      conflicts.conflicts.filter((c) => c.reason === "court").map((c) => c.fixtureId),
    );
    expect([...clashing].some((id) => board.alpha.fixtureIds.includes(id))).toBe(true);
    expect([...clashing].some((id) => board.bravo.fixtureIds.includes(id))).toBe(true);

    expect(unplaced(await slots(board.alpha.id))).toBe(true);
    expect(unplaced(await slots(board.bravo.id))).toBe(true);
  }, 60_000);

  it("a locked division aborts the whole apply", async () => {
    const { alpha, bravo } = await clean();
    await sql`update divisions set schedule_locked = true where id = ${board.bravo.id}`;
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      }),
      // The code pins WHICH 422 — a bare status would be satisfied by any of
      // the four other refusals in this path.
    ).rejects.toMatchObject({ status: 422, code: "SCHEDULE_LOCKED" });
    expect(unplaced(await slots(board.alpha.id))).toBe(true);
    expect(unplaced(await slots(board.bravo.id))).toBe(true);
  }, 60_000);

  it("a court held by a division OUTSIDE the run still blocks the apply", async () => {
    // The run's own divisions are re-planned together; every OTHER division of
    // the competition is fixed occupancy nobody in this apply can move. Drop it
    // from the board and a joint apply cheerfully double-books a real, already
    // scheduled fixture — and reports success.
    const charlie = await seedDivision(auth, board.competitionId, "Charlie", 3, [board.courts.court1]);
    await sql`
      update fixtures set scheduled_at = ${at(0)}, court_id = ${board.courts.court1}
      where id = ${charlie.fixtureIds[0]!}`;
    const { alpha, bravo } = await clean();
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
    expect(unplaced(await slots(board.alpha.id))).toBe(true);
  }, 60_000);

  it("a fixture the apply does not list is still fixed occupancy in its own division", async () => {
    // Alpha's last fixture keeps its existing slot and is left out of the
    // request. It is movable, so it is not an obstacle by status — it is one
    // because this apply is not moving it.
    const held = board.alpha.fixtureIds[5]!;
    await sql`
      update fixtures set scheduled_at = ${at(0)}, court_id = ${board.courts.court2}
      where id = ${held}`;
    const bravo = lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 0);
    const alpha: CompetitionApplyDivision = {
      division_id: board.alpha.id,
      expected_seq: await divisionSeq(board.alpha.id),
      // The first listed fixture is aimed straight at the held slot.
      assignments: board.alpha.fixtureIds
        .filter((id) => id !== held)
        .map((fixture_id, i) => ({
          fixture_id,
          scheduled_at: at(i * 30),
          court_id: board.courts.court2,
        })),
    };
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
    // …and the held fixture is exactly where it was.
    const rows = await slots(board.alpha.id);
    expect(rows.find((r) => r.id === held)!.at).toBe(at(0));
  }, 60_000);

  it("every division's seq is bumped exactly once on success", async () => {
    const { alpha, bravo } = await clean();
    const before = {
      alpha: { seq: await divisionSeq(board.alpha.id), events: await eventCount(board.alpha.id) },
      bravo: { seq: await divisionSeq(board.bravo.id), events: await eventCount(board.bravo.id) },
    };
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    for (const [key, division] of [
      ["alpha", board.alpha],
      ["bravo", board.bravo],
    ] as const) {
      // exactly one new ledger row…
      expect(await eventCount(division.id)).toBe(before[key].events + 1);
      // …the division's seq moved…
      const after = await divisionSeq(division.id);
      expect(after).toBeGreaterThan(before[key].seq);
      // …and it moved TO the new row's seq, not past it.
      expect(after).toBe(await maxEventSeq(division.id));
    }
  }, 60_000);

  it("a schedule_applied event is appended per division carrying the shared ai audit", async () => {
    const { alpha, bravo } = await clean();
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    for (const [division, moves] of [
      [board.alpha, 6],
      [board.bravo, 3],
    ] as const) {
      const rows = await sql<
        {
          payload: {
            source?: string;
            moves?: unknown[];
            ai?: { instruction?: string; summary?: string; model?: string; repair_rounds?: number };
          };
        }[]
      >`
        select payload from division_events
        where division_id = ${division.id} and type = 'schedule_applied'`;
      expect(rows).toHaveLength(1);
      const p = rows[0]!.payload;
      expect(p.source).toBe("ai");
      // Asymmetric: 6 moves for Alpha, 3 for Bravo.
      expect(p.moves).toHaveLength(moves);
      expect(p.ai?.summary).toBe(AI.summary);
      // Trimmed at the seam, exactly as applySchedule trims it.
      expect(p.ai?.instruction).toBe("Fit both divisions into the morning.");
      expect(p.ai?.repair_rounds).toBe(1);
      // The RUNTIME model, never the client's — SCHEDULING_AI_MODEL can override
      // what actually ran, so trusting the request would misrecord the audit.
      expect(p.ai?.model).toBe(schedulingAiModel());
      expect(p.ai?.model).not.toBe(AI.model);
    }
  }, 60_000);

  it("each division is judged by its OWN settings, and warnings come back in full", async () => {
    // `validateAssignments` takes ONE scalar config, and a joint run's divisions
    // legitimately differ on every field of it. Merging them is wrong in both
    // directions and silently so — a merged blackout blacks out a division that
    // never had one. Bravo gets an 11:00-12:00 blackout; Alpha does not.
    await sql`
      update schedule_settings
      set config = ${sql.json({
        ...settingsConfig([board.courts.court1, board.courts.court3]),
        blackouts: [{ from: at(120), to: at(180) }],
      })}
      where division_id = ${board.bravo.id}`;
    const alpha = lineUp(board.alpha, await divisionSeq(board.alpha.id), board.courts.court2, 120);
    const bravo = lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 120);
    const out = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    // R13: a blackout is a WARNING. It does not block, and it is returned in
    // full rather than filtered away — downstream is the last line of defence.
    expect(out.applied).toBe(9);
    const blackouts = out.conflicts.filter((c) => c.reason === "blackout");
    expect(blackouts.length).toBeGreaterThan(0);
    for (const c of blackouts) expect(board.bravo.fixtureIds).toContain(c.fixtureId);
    // …and Alpha, sitting at the very same instants, is NOT charged Bravo's
    // blackout. That is the half a merged config would get wrong.
    for (const id of board.alpha.fixtureIds) {
      expect(blackouts.some((c) => c.fixtureId === id)).toBe(false);
    }

    // RUNTIME half of the wire contract (the compile-time half is `_wireBridge`
    // at the top of this file). This is the only test that produces a non-empty
    // `conflicts`, so it is the only place a schema/usecase mismatch is visible
    // at all: zod STRIPS undeclared keys, so declaring the wrong conflict shape
    // would empty every warning into `{}` with no exception anywhere.
    const parsed = ApplyCompetitionScheduleResult.parse(out);
    expect(parsed.conflicts).toEqual(out.conflicts);
    expect(parsed.conflicts.every((c) => typeof c.fixtureId === "string" && c.reason !== undefined))
      .toBe(true);
  }, 60_000);

  it("a direct feed conflict keeps its `direct` flag through the wire schema", async () => {
    // The round-trip parse above only ever sees BLACKOUT conflicts, which carry
    // no `direct` — so a dropped `direct` in the published conflict shape would
    // survive it. `direct` is the field that decides whether an order violation
    // blocks, so it is the one that must not go missing.
    //
    // It can only be observed on the 409: a direct order conflict IS blocking,
    // so it never appears in a successful return.
    const feeder = board.alpha.fixtureIds[0]!;
    const target = board.alpha.fixtureIds[5]!;
    await sql`
      update fixtures set winner_to_fixture = ${target} where id = ${feeder}`;
    const bravo = lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 0);
    const alpha: CompetitionApplyDivision = {
      division_id: board.alpha.id,
      expected_seq: await divisionSeq(board.alpha.id),
      assignments: board.alpha.fixtureIds.map((fixture_id, i) => ({
        fixture_id,
        // The target starts while its feeder is still playing.
        scheduled_at: fixture_id === target ? at(0) : at((i + 1) * 30),
        court_id: fixture_id === target ? board.courts.court2 : board.courts.court1,
      })),
    };
    let caught: unknown;
    try {
      await applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      });
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught)).toBe(true);
    const blocking = (caught as EngineError).data as { conflicts: Conflict[] };
    const order = blocking.conflicts.filter((c) => c.reason === "order");
    expect(order.length).toBeGreaterThan(0);
    expect(order.every((c) => c.direct === true)).toBe(true);

    // Real engine conflicts, carrying `direct`, through the published shape.
    const parsed = ApplyCompetitionScheduleResult.parse({
      applied: 0,
      conflicts: blocking.conflicts,
    });
    expect(parsed.conflicts.some((c) => c.direct === true)).toBe(true);
    expect(parsed.conflicts).toEqual(blocking.conflicts);
  }, 60_000);

  it("an org without scheduling.multi_division is refused, and nothing is written", async () => {
    // The request carries client-supplied assignments, so this endpoint needs no
    // prior plan run and no AI: it is a multi-division bulk write in its own
    // right, reachable with a bare `manage` key. `scheduling.multi_division` is
    // the paywall for exactly that capability. Community holds `scheduling.ai`
    // and lacks this one, which is what makes it the right seed.
    const { auth: community } = await seedOrg("community");
    const free = await seedBoard(community);
    const divisions = [
      lineUp(free.alpha, await divisionSeq(free.alpha.id), free.courts.court1, 0),
      lineUp(free.bravo, await divisionSeq(free.bravo.id), free.courts.court3, 0),
    ];
    await expect(
      applyCompetitionSchedule(community, free.competitionId, {
        divisions,
        source: "ai",
        ai: AI,
      }),
      // The FEATURE KEY, not the 402 — a bare status is what every paywall on
      // this path answers with, including the frozen-competition one.
    ).rejects.toMatchObject({ featureKey: "scheduling.multi_division" });
    expect(unplaced(await slots(free.alpha.id))).toBe(true);
    expect(unplaced(await slots(free.bravo.id))).toBe(true);
  }, 90_000);

  it("refuses an INTRODUCED person double-booking whatever crossPersonClash says", async () => {
    // #399 retired the opt-in as the switch. A human on two courts at once is
    // impossible whoever put them there, so both arms are refused now — the
    // "hard" org loses nothing and the "warn" org gains the refusal. What
    // decides is the DELTA, pinned by the test below, not the setting.
    //
    // Alpha's round 1 is two fixtures over four disjoint entrants: put one
    // person in both, place them at the same instant on Alpha's two courts, and
    // the only conflict on the board is a person overlap — no court clash.
    const overlapping = (expectedSeq: number): CompetitionApplyDivision => ({
      division_id: board.alpha.id,
      expected_seq: expectedSeq,
      assignments: board.alpha.fixtureIds.map((fixture_id, i) => ({
        fixture_id,
        scheduled_at: i < 2 ? at(0) : at(i * 30),
        court_id: i === 1 ? board.courts.court2 : board.courts.court1,
      })),
    });
    const bravoOf = async (): Promise<CompetitionApplyDivision> =>
      lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 0);

    // A CLEAN A/B: both arms carry a constraints row and differ on
    // `crossPersonClash` alone. Bravo is pinned to "warn" in both arms so it can
    // never be what decides.
    const arm = async (clash: "warn" | "hard"): Promise<void> => {
      ({ auth } = await seedOrg("pro"));
      board = await seedBoard(auth);
      await sharePerson(auth.orgId, [board.alpha.fixtureIds[0]!, board.alpha.fixtureIds[1]!]);
      await setConstraints(board.alpha.id, [board.courts.court1, board.courts.court2], {
        ...BASE_CONSTRAINTS,
        crossPersonClash: clash,
      });
      await setConstraints(board.bravo.id, [board.courts.court1, board.courts.court3], {
        ...BASE_CONSTRAINTS,
        crossPersonClash: "warn",
      });
    };

    for (const clash of ["warn", "hard"] as const) {
      await arm(clash);
      await expect(
        applyCompetitionSchedule(auth, board.competitionId, {
          divisions: [overlapping(await divisionSeq(board.alpha.id)), await bravoOf()],
          source: "ai",
          ai: AI,
        }),
      ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
      // Atomic: neither division was written.
      expect(unplaced(await slots(board.alpha.id))).toBe(true);
      expect(unplaced(await slots(board.bravo.id))).toBe(true);
    }
  }, 180_000);

  it("still applies over a board that ALREADY holds that overlap", async () => {
    // THE CASE THE DELTA EXISTS FOR (#399). Competitions published before this
    // wave may carry person overlaps, because they were warnings all along.
    // Under an absolute rule the organiser's next joint apply would 409 with
    // nothing they could do about it — the board is already dirty, and every
    // edit is refused for the dirt.
    await sharePerson(auth.orgId, [board.alpha.fixtureIds[0]!, board.alpha.fixtureIds[1]!]);
    await setConstraints(board.alpha.id, [board.courts.court1, board.courts.court2], {
      ...BASE_CONSTRAINTS,
      crossPersonClash: "warn",
    });
    await setConstraints(board.bravo.id, [board.courts.court1, board.courts.court3], {
      ...BASE_CONSTRAINTS,
      crossPersonClash: "hard",
    });
    const alphaAssignments = board.alpha.fixtureIds.map((fixture_id, i) => ({
      fixture_id,
      scheduled_at: i < 2 ? at(0) : at(i * 30),
      court_id: i === 1 ? board.courts.court2 : board.courts.court1,
    }));
    // Write the overlap straight to the rows, bypassing every gate — the only
    // way to manufacture the board a pre-#399 organiser could be sitting on.
    for (const a of alphaAssignments) {
      await sql`
        update fixtures set scheduled_at = ${a.scheduled_at}, court_id = ${a.court_id}
        where id = ${a.fixture_id}`;
    }
    const out = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [
        {
          division_id: board.alpha.id,
          expected_seq: await divisionSeq(board.alpha.id),
          assignments: alphaAssignments,
        },
        lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 0),
      ],
      source: "ai",
      ai: AI,
    });
    expect(out.applied).toBe(9);
    // Reported in full — a badge, never a wall.
    const overlaps = out.conflicts.filter((c) => c.reason === "person_overlap");
    expect(overlaps.length).toBeGreaterThan(0);
    for (const c of overlaps) expect(board.alpha.fixtureIds).toContain(c.fixtureId);
    expect(unplaced(await slots(board.alpha.id))).toBe(false);
  }, 60_000);

  it("REFUSES a joint apply that puts a fixture outside the competition's dates", async () => {
    // #399 wires `applyWindow` into both joint passes. The bound is the
    // division's OWN configured dates — deliberately not the AI pack's resolved
    // window, which widens onto whatever is already scheduled and could
    // therefore never be broken.
    await sql`
      update schedule_settings
      set config = ${sql.json({ ...settingsConfig([board.courts.court1, board.courts.court2]), endAt: at(600) } as never)}
      where division_id = ${board.alpha.id}`;
    const strayDay = new Date(T0 + 9 * 24 * 60 * MIN).toISOString();
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [
          {
            division_id: board.alpha.id,
            expected_seq: await divisionSeq(board.alpha.id),
            assignments: board.alpha.fixtureIds.map((fixture_id, i) => ({
              fixture_id,
              scheduled_at: i === 0 ? strayDay : at(i * 30),
              court_id: board.courts.court1,
            })),
          },
          lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 0),
        ],
        source: "ai",
        ai: AI,
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
    expect(unplaced(await slots(board.alpha.id))).toBe(true);
  }, 60_000);

  it("a cross-division person clash blocks when EITHER division opted in", async () => {
    // Person in Alpha and in Bravo; only Alpha is "hard". Alpha's own pass sees
    // Bravo's proposed slot on the merged board and blocks. `Conflict` carries
    // no division, so the pass that emitted it is the only possible attribution
    // — and "hard if any involved division opted in" is the safe direction for
    // an org that explicitly asked not to double-book its people.
    await sharePerson(auth.orgId, [board.alpha.fixtureIds[0]!, board.bravo.fixtureIds[0]!]);
    await setConstraints(board.alpha.id, [board.courts.court1, board.courts.court2], {
      ...BASE_CONSTRAINTS,
      crossPersonClash: "hard",
    });
    // Bravo is EXPLICITLY "warn" — its own pass would let this through, so the
    // 409 can only come from Alpha's pass seeing Bravo's slot on the merged
    // board. Spelled out rather than left as an absent row, so the two arms
    // differ by the setting alone.
    await setConstraints(board.bravo.id, [board.courts.court1, board.courts.court3], {
      ...BASE_CONSTRAINTS,
      crossPersonClash: "warn",
    });
    const { alpha, bravo } = await clean();
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
    expect(unplaced(await slots(board.alpha.id))).toBe(true);
    expect(unplaced(await slots(board.bravo.id))).toBe(true);
  }, 60_000);

  it("a start-window violation is reported as a warning and still applies", async () => {
    // `verifyConfigFor` used to hardcode startWindows: [], so `start_window` was
    // a conflict class the whole joint product was blind to while the per-stage
    // apply reported it. Warnings only: `isBlocking` does not cover it.
    await setConstraints(board.bravo.id, [board.courts.court1, board.courts.court3], {
      ...BASE_CONSTRAINTS,
      // Division-targeted, which only works because the joint path stamps
      // `divisionId` on every proposed assignment.
      startWindows: [{ target: { kind: "division", id: board.bravo.id }, notBefore: at(240) }],
    });
    const { alpha, bravo } = await clean();
    const out = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    // Applied, not refused.
    expect(out.applied).toBe(9);
    const windows = out.conflicts.filter((c) => c.reason === "start_window");
    expect(windows.length).toBeGreaterThan(0);
    // Bravo's window; Alpha, at the same instants, has none.
    for (const c of windows) expect(board.bravo.fixtureIds).toContain(c.fixtureId);
    expect((await slots(board.bravo.id)).every((r) => r.at !== null)).toBe(true);
  }, 60_000);

  it("more than 500 assignments in one call is refused before anything is read", async () => {
    // The PLAN path caps a whole run at 500 movable fixtures. Without the same
    // cap here the schema's 500-per-division x 20 divisions would admit 10 000
    // single-row updates in one transaction holding 20 advisory locks.
    const bulk = (n: number): CompetitionApplyDivision["assignments"] =>
      Array.from({ length: n }, () => ({
        fixture_id: randomUUID(),
        scheduled_at: at(0),
        court_id: board.courts.court1,
      }));
    const over = {
      divisions: [
        { division_id: board.alpha.id, expected_seq: 0, assignments: bulk(300) },
        { division_id: board.bravo.id, expected_seq: 0, assignments: bulk(201) },
      ],
      source: "ai" as const,
    };
    expect(over.divisions.reduce((n, d) => n + d.assignments.length, 0)).toBe(
      COMPETITION_MOVABLE_CAP + 1,
    );
    // The ids are fabricated, so every later guard would also refuse this —
    // the CODE is what pins that the cap is the one that fired, and that it
    // fired before any of them.
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, over),
    ).rejects.toMatchObject({ status: 409, code: "SCHEDULE_APPLY_TOO_LARGE" });

    // One under the cap gets past it and is refused by the NEXT guard instead,
    // which proves the boundary is 500 and not "any bulk request".
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        ...over,
        divisions: [over.divisions[0]!, { ...over.divisions[1]!, assignments: bulk(200) }],
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_APPLY_UNKNOWN_FIXTURE" });
  }, 60_000);

  it("exactly one schedule.applied_multi competition event is written", async () => {
    // Rename so the (name, slug) DOMAIN order is provably the REVERSE of the
    // UUID order. Without this the ids are random, so a UUID sort would match
    // the domain order about half the time and the assertion below would only
    // catch the defect on a coin flip.
    const byUuid = [board.alpha, board.bravo].sort((a, b) => (a.id < b.id ? -1 : 1));
    await sql`update divisions set name = 'Zulu', slug = 'zulu' where id = ${byUuid[0]!.id}`;
    await sql`update divisions set name = 'Alfa', slug = 'alfa' where id = ${byUuid[1]!.id}`;
    const domainOrder = [byUuid[1]!.id, byUuid[0]!.id];

    const { alpha, bravo } = await clean();
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    const rows = await sql<{ payload: { source?: string; division_ids?: string[] } }[]>`
      select payload from competition_events
      where competition_id = ${board.competitionId} and type = ${JOINT_APPLY_EVENT}`;
    // ONE row per transaction, not one per division: competition_events.id is a
    // random uuid and now() is transaction-start time, so two rows written in
    // one transaction tie on (created_at, id) and ai-last's "latest" becomes a
    // coin flip.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.source).toBe("ai");
    // DOMAIN order, asserted as emitted. Re-sorting a copy here — which this
    // test used to do — makes it blind to the UUID sort the module header
    // forbids for anything that is not lock acquisition.
    expect(rows[0]!.payload.division_ids).toEqual(domainOrder);
    expect(rows[0]!.payload.division_ids).not.toEqual([...domainOrder].sort());
    // …and the per-division rows carry the same list in the same order.
    const [division] = await sql<{ payload: { joint?: { division_ids?: string[] } } }[]>`
      select payload from division_events
      where division_id = ${board.alpha.id} and type = 'schedule_applied'`;
    expect(division!.payload.joint?.division_ids).toEqual(domainOrder);
  }, 60_000);

  it("ai-last returns the applied plan after a joint apply", async () => {
    expect((await lastCompetitionAiApply(auth, board.competitionId)).last).toBeNull();
    const { alpha, bravo } = await clean();
    const before = Date.now();
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    const out = await lastCompetitionAiApply(auth, board.competitionId);
    expect(out.last).not.toBeNull();
    expect(out.last!.instruction).toBe("Fit both divisions into the morning.");
    expect(out.last!.summary).toBe(AI.summary);
    expect(Date.parse(out.last!.at)).toBeGreaterThanOrEqual(before - 60_000);
  }, 60_000);

  it("a fixture id outside the pack is a 4xx, not a 500", async () => {
    // Two ways to be outside the pack: a fixture that belongs to a DIFFERENT
    // division of the run, and one that does not exist at all. The runner path
    // 500s AI_PLAN_INVALID_ASSIGNMENT on both, because only a server bug can
    // reach it there; at apply time the ids come off the wire, so it is a
    // request defect (R14).
    for (const foreignId of [board.bravo.fixtureIds[0]!, randomUUID()]) {
      const { alpha, bravo } = await clean();
      const withForeign: CompetitionApplyDivision = {
        ...alpha,
        assignments: [
          ...alpha.assignments,
          { fixture_id: foreignId, scheduled_at: at(600), court_id: board.courts.court2 },
        ],
      };
      // Bravo must NOT also list it. Leaving it in both places trips the
      // "appears more than once" guard first, which is a different 422 — and a
      // test satisfiable by two constraints proves neither.
      const rest: CompetitionApplyDivision = {
        ...bravo,
        assignments: bravo.assignments.filter((a) => a.fixture_id !== foreignId),
      };
      let caught: unknown;
      try {
        await applyCompetitionSchedule(auth, board.competitionId, {
          divisions: [withForeign, rest],
          source: "ai",
          ai: AI,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpError);
      // The code pins WHICH refusal this is, so the duplicate-fixture guard
      // cannot stand in for the unknown-fixture one.
      expect((caught as HttpError).code).toBe("SCHEDULE_APPLY_UNKNOWN_FIXTURE");
      const status = (caught as HttpError).status;
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      expect(unplaced(await slots(board.alpha.id))).toBe(true);
      expect(unplaced(await slots(board.bravo.id))).toBe(true);
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // The three request-level guards that could not fail (I-2).
  //
  // All three passed 21/0 under a mutation that removed them: `if (false)` for
  // the duplicate-fixture loop, and `.slice(0, 1)` for the per-division
  // invalidation. `SCHEDULE_APPLY_NO_DIVISIONS` and
  // `SCHEDULE_APPLY_DUPLICATE_DIVISION` were unasserted anywhere in the repo —
  // the only "appears more than once" assertions belong to
  // `jointStructuralCheck` on the PLAN side, which is a different function.
  // -------------------------------------------------------------------------

  it("a fixture listed twice is refused by NAME, and nothing is written", async () => {
    // Both shapes, because they are two different mistakes a client can make:
    // the same fixture twice inside one division's list, and the same fixture
    // claimed by two divisions of the run. One `seenFixture` set spans the whole
    // request, so one guard has to catch both.
    for (const shape of ["twice in one division", "claimed by two divisions"] as const) {
      ({ auth } = await seedOrg("pro"));
      board = await seedBoard(auth);
      const dupId = board.alpha.fixtureIds[2]!;
      const { alpha, bravo } = await clean();
      // The extra entry sits on a court and slot nothing else uses, so a court
      // clash cannot stand in for the guard under test.
      const again = { fixture_id: dupId, scheduled_at: at(600), court_id: board.courts.court2 };
      const divisions: CompetitionApplyDivision[] =
        shape === "twice in one division"
          ? [{ ...alpha, assignments: [...alpha.assignments, again] }, bravo]
          : [alpha, { ...bravo, assignments: [...bravo.assignments, again] }];

      let caught: unknown;
      try {
        await applyCompetitionSchedule(auth, board.competitionId, {
          divisions,
          source: "ai",
          ai: AI,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught, shape).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status, shape).toBe(422);
      // The MESSAGE names the offending fixture. Anchoring on the status alone
      // would be satisfied by every other 422 on this path — a frozen division,
      // a decided fixture, a fixture outside its division — and prove none of
      // them. This guard has no error code, so the id is the discriminator.
      expect((caught as HttpError).message, shape).toBe(
        `fixture ${dupId} appears more than once`,
      );

      expect(unplaced(await slots(board.alpha.id)), shape).toBe(true);
      expect(unplaced(await slots(board.bravo.id)), shape).toBe(true);
    }
  }, 120_000);

  it("an empty or repeated division list is a 400 before anything is read", async () => {
    // Both guards sit ahead of every read, lock and write, and both carry a code
    // the route maps straight through. The usecase is called directly here on
    // purpose: zod's `.min(1)` covers the wire, and a defence-in-depth check
    // nothing exercises is a check that can be deleted unnoticed.
    const { alpha } = await clean();

    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [],
        source: "ai",
        ai: AI,
      }),
    ).rejects.toMatchObject({ status: 400, code: "SCHEDULE_APPLY_NO_DIVISIONS" });

    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, { ...alpha, assignments: [alpha.assignments[0]!] }],
        source: "ai",
        ai: AI,
      }),
    ).rejects.toMatchObject({ status: 400, code: "SCHEDULE_APPLY_DUPLICATE_DIVISION" });

    // A repeated division must be refused as a repeated DIVISION, not as a
    // repeated fixture — the two guards are adjacent and the second list above
    // shares fixture ids with the first, so without the code assertion the
    // duplicate-fixture 422 would satisfy this test just as well.
    expect(unplaced(await slots(board.alpha.id))).toBe(true);
    expect(unplaced(await slots(board.bravo.id))).toBe(true);
  }, 60_000);

  it("invalidates every WRITTEN division exactly once, in domain order", async () => {
    // Rename so the (name, slug) DOMAIN order is provably the REVERSE of the
    // UUID order — the same trick the competition-event test uses. Without it a
    // loop over `lockOrder` (which sorts by UUID, correctly, for deadlock
    // avoidance) would match domain order on a coin flip.
    const byUuid = [board.alpha, board.bravo].sort((a, b) => (a.id < b.id ? -1 : 1));
    await sql`update divisions set name = 'Zulu', slug = 'zulu' where id = ${byUuid[0]!.id}`;
    await sql`update divisions set name = 'Alfa', slug = 'alfa' where id = ${byUuid[1]!.id}`;
    const domainOrder = [byUuid[1]!.id, byUuid[0]!.id];

    const { alpha, bravo } = await clean();
    sched.afterWrite.length = 0;
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });

    // ONE call per division, no more and no fewer, each naming its OWN division
    // and the competition it was applied under.
    expect(sched.afterWrite).toEqual(
      domainOrder.map((id) => [id, board.competitionId, "schedule"]),
    );
    expect(sched.afterWrite).not.toEqual(
      [...domainOrder].sort().map((id) => [id, board.competitionId, "schedule"]),
    );
  }, 60_000);

  it("invalidates nothing when the transaction rolls back", async () => {
    // The other half of "once per WRITTEN division": the fire-and-forget loop
    // runs AFTER the commit, so a refused apply must bust no cache at all.
    // Hoisting it inside the transaction would publish a board update for a
    // write that never landed.
    const { alpha, bravo } = await clean();
    sched.afterWrite.length = 0;
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, { ...bravo, expected_seq: bravo.expected_seq + 7 }],
        source: "ai",
        ai: AI,
      }),
    ).rejects.toMatchObject({ code: "SEQ_CONFLICT" });
    expect(sched.afterWrite).toEqual([]);
  }, 60_000);

  // C1 follow-up (2026-08-12, task 2 item 1). `roundRobinStageIds` is now
  // resolved ONCE PER DIVISION (`roundRobinByDivision`), not once for the
  // whole run — a single call over one division id would silently answer
  // "is this stage round-robin" for every OTHER division in the run too,
  // which is exactly the "compared as one sequence" defect C1 exists to
  // prevent, just at the DIVISION granularity. Both Alpha and Bravo are
  // `kind: "league"` (round-robin), so every Assignment `validateAssignments`
  // sees should carry a `roundNo` matching its OWN fixture's `round_no` and a
  // `stageId` matching its OWN division's league stage — never the OTHER
  // division's.
  //
  // Round order itself was STRUCTURALLY INERT on this path at the time this
  // test was written (`verifyConfigFor` only set `tz` when its optional
  // `rules` argument was passed, and the joint apply's own calls never
  // passed one — ruling #399, "apply-time blocking is W4"). C1 gap A closed
  // that: `verifyConfigFor` now also accepts a bare `tz`, independent of
  // `rules`, and these two call sites supply the run's org zone. This test
  // stays a DATA-level proof (the Assignment objects carry the right
  // fields, per division) rather than a conflict-level one on purpose —
  // that half now has its own dedicated tests below ("C1 gap A").
  it("threads roundNo/stageId per division, not once for the whole run", async () => {
    const { alpha, bravo } = await clean();
    const [alphaStageRow] = await sql<{ stage_id: string }[]>`
      select stage_id from fixtures where id = ${alpha.assignments[0]!.fixture_id}`;
    const [bravoStageRow] = await sql<{ stage_id: string }[]>`
      select stage_id from fixtures where id = ${bravo.assignments[0]!.fixture_id}`;
    const roundByFixture = new Map<string, number>();
    for (const row of await sql<{ id: string; round_no: number }[]>`
      select id, round_no from fixtures where division_id in ${sql([board.alpha.id, board.bravo.id])}`) {
      roundByFixture.set(row.id, row.round_no);
    }

    const engineModule = await import("@seazn/engine/scheduling");
    const spy = vi.spyOn(engineModule, "validateAssignments");
    let seen: { fixtureId: string; roundNo?: number; stageId?: string; divisionId?: string }[];
    try {
      await applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      });
      seen = spy.mock.calls.flatMap((call) => call[0]);
    } finally {
      spy.mockRestore();
    }
    expect(seen.length).toBeGreaterThan(0);

    const alphaSeen = seen.filter((a) => a.divisionId === board.alpha.id);
    const bravoSeen = seen.filter((a) => a.divisionId === board.bravo.id);
    expect(alphaSeen.length, "no Alpha assignment was ever validated").toBeGreaterThan(0);
    expect(bravoSeen.length, "no Bravo assignment was ever validated").toBeGreaterThan(0);
    for (const a of alphaSeen) {
      expect(a.stageId, `Alpha fixture ${a.fixtureId} carries the wrong stageId`).toBe(alphaStageRow!.stage_id);
      expect(a.roundNo, `Alpha fixture ${a.fixtureId} lost its roundNo`).toBe(roundByFixture.get(a.fixtureId));
    }
    for (const a of bravoSeen) {
      expect(a.stageId, `Bravo fixture ${a.fixtureId} carries the wrong stageId`).toBe(bravoStageRow!.stage_id);
      expect(a.roundNo, `Bravo fixture ${a.fixtureId} lost its roundNo`).toBe(roundByFixture.get(a.fixtureId));
    }
    // The two stages are genuinely different — otherwise every assertion
    // above would pass vacuously even with `roundRobinByDivision` collapsed
    // to a single shared set.
    expect(alphaStageRow!.stage_id).not.toBe(bravoStageRow!.stage_id);
  }, 60_000);

  // ---------------------------------------------------------------------
  // C1 gap A — round order was DATA-complete (roundNo/stageId threaded, see
  // the test above) but STRUCTURALLY INERT: `verifyConfigFor` only sets
  // `tz` when its `rules` argument is passed, and these two call sites
  // never passed one (ruling #399 — apply-time blocking must not extend
  // to the typed-rule families). `verifyConfigFor` now also accepts a
  // bare `tz`, independent of `rules`, and these call sites supply the
  // competition's own org zone. See competition-schedule-ai.ts's
  // `verifyConfigFor` for the full argument.
  // ---------------------------------------------------------------------

  it("a round-robin sequence violation the apply introduces is a 409, blocking (C1 gap A)", async () => {
    // Alpha's round 3 fixture (the LAST id, by seedDivision's own round_no/
    // seq_in_round sort) takes round 1's slot and vice versa — a straight
    // swap of two already-occupied times, the same construction the smoke
    // suite and the e2e fixture-server sentinel both use, so no court/rest
    // conflict rides along to confound the assertion (perEntrantMinRest is
    // 0 on the seed board, and every slot is reused, just reassigned).
    const alphaIds = board.alpha.fixtureIds;
    const last = alphaIds.length - 1;
    const alphaAssignments = alphaIds.map((fixture_id, i) => ({
      fixture_id,
      scheduled_at: i === 0 ? at(last * 30) : i === last ? at(0) : at(i * 30),
      court_id: board.courts.court1,
    }));
    const alpha: CompetitionApplyDivision = {
      division_id: board.alpha.id,
      expected_seq: await divisionSeq(board.alpha.id),
      assignments: alphaAssignments,
    };
    const bravo = lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 0);
    let caught: unknown;
    try {
      await applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      });
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught)).toBe(true);
    expect((caught as EngineError).code).toBe("SCHEDULE_CONFLICT");
    const conflicts = (caught as EngineError).data as { conflicts: Conflict[] };
    const orderConflicts = conflicts.conflicts.filter((c) => c.reason === "order");
    expect(orderConflicts.length).toBeGreaterThan(0);
    expect(orderConflicts.every((c) => alphaIds.includes(c.fixtureId))).toBe(true);
    // Atomic: NEITHER division was written, including the untouched Bravo.
    expect(unplaced(await slots(board.alpha.id))).toBe(true);
    expect(unplaced(await slots(board.bravo.id))).toBe(true);
  }, 60_000);

  it("still applies over a board that ALREADY holds a round-order violation — the delta property (C1 gap A)", async () => {
    // THE CASE THE DELTA EXISTS FOR (#399), same shape as the person-overlap
    // version of this test above. A board can already be sitting on a
    // round-order violation (planted here straight into the rows, bypassing
    // every gate — the only way to construct it now that the gate is live);
    // the next joint apply must not become permanently unfixable for the
    // dirt it did not introduce.
    const alphaIds = board.alpha.fixtureIds;
    const last = alphaIds.length - 1;
    const alphaAssignments = alphaIds.map((fixture_id, i) => ({
      fixture_id,
      scheduled_at: i === 0 ? at(last * 30) : i === last ? at(0) : at(i * 30),
      court_id: board.courts.court1,
    }));
    for (const a of alphaAssignments) {
      await sql`
        update fixtures set scheduled_at = ${a.scheduled_at}, court_id = ${a.court_id}
        where id = ${a.fixture_id}`;
    }
    const out = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [
        {
          division_id: board.alpha.id,
          expected_seq: await divisionSeq(board.alpha.id),
          // Re-asserts the SAME (already-violating) positions — a no-op for
          // Alpha, exactly like the fixtures already sitting there.
          assignments: alphaAssignments,
        },
        // Bravo gets a REAL apply in the same call — the joint write must
        // not be refused for Alpha's pre-existing dirt.
        lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 0),
      ],
      source: "ai",
      ai: AI,
    });
    expect(out.applied).toBe(9);
    // Reported in full — a badge, never a wall.
    const orderConflicts = out.conflicts.filter((c) => c.reason === "order");
    expect(orderConflicts.length).toBeGreaterThan(0);
    expect(unplaced(await slots(board.alpha.id))).toBe(false);
    expect(unplaced(await slots(board.bravo.id))).toBe(false);
  }, 60_000);

  it("two divisions' round-robin sequences are not compared against each other (C1 gap A)", async () => {
    // Alpha entirely AFTER Bravo, chronologically, same day: if the sequence
    // key ever collapsed across divisions (e.g. (stageId, poolId) without
    // divisionId), Alpha's round 1 landing after Bravo's round 3 would read
    // exactly like a same-sequence violation. Different courts throughout,
    // so the only thing this apply could possibly report is round order.
    const alpha = lineUp(board.alpha, await divisionSeq(board.alpha.id), board.courts.court1, 400);
    const bravo = lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 0);
    const out = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    expect(out.applied).toBe(9);
    expect(out.conflicts.filter((c) => c.reason === "order")).toEqual([]);
  }, 60_000);

  it("restByDivision stays unset at apply time — a cross-division rest gap under only the STRICTER division's own floor is not raised to it (C1 gap A, #399)", async () => {
    // #398's restByDivision is what would make a cross-division pair rest at
    // the MAX of both divisions' floors rather than at whichever pass's OWN
    // config happens to be checking it — exactly the field `rules` carries,
    // and the one #399 requires the apply path never populate. Alpha's own
    // floor is raised to 45 minutes; Bravo's stays the seed's default 0. A
    // 20-minute gap between one fixture in each, sharing one person, breaches
    // ONLY Alpha's own floor. If restByDivision ever reached this call site,
    // Bravo's OWN pass would also see 45 (raised from its own 0) and report a
    // SECOND conflict, naming the Bravo fixture — this is `hard`/
    // `ruleFixtures`'s sibling field, and the one of the three #399 withholds
    // that a real apply call can dynamically exercise (`hard`/`ruleFixtures`
    // are proven unreachable at this call site structurally, in the pure
    // `verifyConfigFor` tests — there is no live source for them here to
    // dynamically switch on even if this fix were wrong).
    await sql`
      update schedule_settings
      set config = jsonb_set(config, '{perEntrantMinRest}', '45')
      where division_id = ${board.alpha.id}`;
    await sharePerson(auth.orgId, [board.alpha.fixtureIds[0]!, board.bravo.fixtureIds[0]!]);
    const alphaAssignments = board.alpha.fixtureIds.map((fixture_id, i) => ({
      fixture_id,
      // fixture[0]: 0-30. Every other pair >=70 min clear, well past
      // Alpha's own 45-min floor, so no INTERNAL rest conflict rides along.
      scheduled_at: at(i * 100),
      court_id: board.courts.court1,
    }));
    const bravoAssignments = board.bravo.fixtureIds.map((fixture_id, i) => ({
      fixture_id,
      // fixture[0]: 50-80 — a 20-minute gap after Alpha's fixture[0] ends
      // at 30. Below Alpha's 45-min floor; comfortably above Bravo's own 0.
      scheduled_at: i === 0 ? at(50) : at(300 + i * 180),
      court_id: board.courts.court3,
    }));
    const out = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [
        {
          division_id: board.alpha.id,
          expected_seq: await divisionSeq(board.alpha.id),
          assignments: alphaAssignments,
        },
        {
          division_id: board.bravo.id,
          expected_seq: await divisionSeq(board.bravo.id),
          assignments: bravoAssignments,
        },
      ],
      source: "ai",
      ai: AI,
    });
    // "rest" is warn-only (not in isBlockingConflict) either way, so this
    // must succeed regardless of which behaviour is live — the difference
    // under test is WHICH fixtures the rest conflict names, not whether the
    // call itself succeeds.
    expect(out.applied).toBe(9);
    const restConflicts = out.conflicts.filter((c) => c.reason === "rest");
    expect(restConflicts.some((c) => c.fixtureId === board.alpha.fixtureIds[0])).toBe(true);
    // THE ASSERTION. The Bravo fixture must never itself be named by a "rest"
    // conflict — that only happens if Bravo's OWN pass also saw a 45-minute
    // floor for this pair, i.e. restByDivision reached this call.
    expect(restConflicts.some((c) => c.fixtureId === board.bravo.fixtureIds[0])).toBe(false);
  }, 60_000);

  // ---------------------------------------------------------------------
  // Final-review fix (4th instance of the same bug class G2/moveFixture and
  // G2/applySchedule already fixed — see schedule.ts's
  // `roundRobinSequenceSiblings`). Every test above submits the FULL
  // per-division fixture list, so `mine` (the checked side of the delta)
  // always already contains every round-robin sibling and the pairwise scan
  // (calendar.ts, scoped to its `assignments` param by design) always had
  // both halves of any pair in front of it. These three exercise a PARTIAL
  // per-division listing — `d.input.assignments` naming fewer fixtures than
  // the division has — against an UNLISTED same-sequence sibling sitting in
  // `untouched`, which is a real, shipped, documented shape
  // (`excludedFixtureIds`, this file's own header §58-66).
  // ---------------------------------------------------------------------

  it("REFUSES a partial per-division apply that breaks round order against an unlisted same-sequence sibling (C1 final-review)", async () => {
    const { alpha, bravo } = await clean();
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    const alphaIds = board.alpha.fixtureIds;
    // Alpha's round-1 fixture ALONE, pushed past round 3 (still sitting,
    // UNLISTED, at the position `clean()` gave it above). Court 2 — Alpha's
    // other court, otherwise empty — so the only possible conflict is round
    // order, never a court clash.
    const partialAlpha: CompetitionApplyDivision = {
      division_id: board.alpha.id,
      expected_seq: await divisionSeq(board.alpha.id),
      assignments: [{ fixture_id: alphaIds[0]!, scheduled_at: at(999), court_id: board.courts.court2 }],
    };
    const freshBravo = lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 0);
    let caught: unknown;
    try {
      await applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [partialAlpha, freshBravo],
        source: "ai",
        ai: AI,
      });
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught)).toBe(true);
    expect((caught as EngineError).code).toBe("SCHEDULE_CONFLICT");
    const conflicts = (caught as EngineError).data as { conflicts: Conflict[] };
    const orderConflicts = conflicts.conflicts.filter((c) => c.reason === "order");
    expect(orderConflicts.length).toBeGreaterThan(0);
    // `calendar.ts` blames the LATER round — here that is round 3's
    // (unlisted) fixture, not the one this apply actually named. Either way
    // it must be an ALPHA fixture; Bravo must never be dragged in.
    expect(orderConflicts.every((c) => alphaIds.includes(c.fixtureId))).toBe(true);
    // Atomic: the attempted move never landed — fixture[0] is still exactly
    // where the first (valid) apply above left it.
    const alphaSlots = await slots(board.alpha.id);
    expect(alphaSlots.find((s) => s.id === alphaIds[0])).toMatchObject({ at: at(0), court: board.courts.court1 });
  }, 60_000);

  it("a partial apply stays editable over a PRE-EXISTING round-order violation among its own unlisted siblings — the symmetry regression (C1 final-review)", async () => {
    const { alpha, bravo } = await clean();
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    const alphaIds = board.alpha.fixtureIds;
    // Corrupt round 1 (fixtureIds[1]) and round 2 (fixtureIds[2]) AGAINST
    // EACH OTHER, straight into the rows — bypassing the gate, the only way
    // to construct this now it is live (same technique as "still applies
    // over a board that ALREADY holds a round-order violation" above).
    // NEITHER fixture is listed in the apply below.
    await sql`update fixtures set scheduled_at = ${at(60)} where id = ${alphaIds[1]}`;
    await sql`update fixtures set scheduled_at = ${at(30)} where id = ${alphaIds[2]}`;

    const partialAlpha: CompetitionApplyDivision = {
      division_id: board.alpha.id,
      expected_seq: await divisionSeq(board.alpha.id),
      // Round 3's fixtureIds[4], moved a full day past everything —
      // unambiguously after both the healthy AND the corrupted fixtures
      // above, so THIS move introduces no violation of its own. Only
      // whether the PRE-EXISTING one wrongly blocks it is in play.
      assignments: [{ fixture_id: alphaIds[4]!, scheduled_at: at(999), court_id: board.courts.court2 }],
    };
    const freshBravo = lineUp(board.bravo, await divisionSeq(board.bravo.id), board.courts.court3, 0);
    const out = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [partialAlpha, freshBravo],
      source: "ai",
      ai: AI,
    });
    expect(out.applied).toBe(4); // 1 (Alpha, partial) + 3 (Bravo, full)
    const alphaSlots = await slots(board.alpha.id);
    // The corrupted pair is untouched by this apply — neither fixed nor
    // worsened, exactly #399's "a dirty board stays editable" contract.
    expect(alphaSlots.find((s) => s.id === alphaIds[1])).toMatchObject({ at: at(60), court: board.courts.court1 });
    expect(alphaSlots.find((s) => s.id === alphaIds[2])).toMatchObject({ at: at(30), court: board.courts.court1 });
    // The actually-listed fixture DID move.
    expect(alphaSlots.find((s) => s.id === alphaIds[4])).toMatchObject({ at: at(999), court: board.courts.court2 });
  }, 60_000);

  it("cross-division independence: each division's own widened-sibling check never leaks into the other's (C1 final-review)", async () => {
    const { alpha, bravo } = await clean();
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    const alphaIds = board.alpha.fixtureIds;
    const bravoIds = board.bravo.fixtureIds;
    // BOTH divisions get a partial apply that breaks round order against an
    // unlisted sibling of THEIR OWN, independently, in the SAME call.
    const partialAlpha: CompetitionApplyDivision = {
      division_id: board.alpha.id,
      expected_seq: await divisionSeq(board.alpha.id),
      assignments: [{ fixture_id: alphaIds[0]!, scheduled_at: at(999), court_id: board.courts.court2 }],
    };
    const partialBravo: CompetitionApplyDivision = {
      division_id: board.bravo.id,
      expected_seq: await divisionSeq(board.bravo.id),
      assignments: [{ fixture_id: bravoIds[0]!, scheduled_at: at(999), court_id: board.courts.court3 }],
    };
    let caught: unknown;
    try {
      await applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [partialAlpha, partialBravo],
        source: "ai",
        ai: AI,
      });
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught)).toBe(true);
    expect((caught as EngineError).code).toBe("SCHEDULE_CONFLICT");
    const conflicts = (caught as EngineError).data as { conflicts: Conflict[] };
    const orderConflicts = conflicts.conflicts.filter((c) => c.reason === "order");
    const alphaOrder = orderConflicts.filter((c) => alphaIds.includes(c.fixtureId));
    const bravoOrder = orderConflicts.filter((c) => bravoIds.includes(c.fixtureId));
    expect(alphaOrder.length, "Alpha's own violation was not detected").toBeGreaterThan(0);
    expect(bravoOrder.length, "Bravo's own violation was not detected").toBeGreaterThan(0);
    // No cross-contamination: every order conflict belongs to exactly one
    // division's own fixture set — never a third, unaccounted-for one.
    expect(alphaOrder.length + bravoOrder.length).toBe(orderConflicts.length);
    // Atomic — neither division's board moved from the clean baseline.
    const alphaSlots = await slots(board.alpha.id);
    const bravoSlots = await slots(board.bravo.id);
    expect(alphaSlots.find((s) => s.id === alphaIds[0])).toMatchObject({ at: at(0), court: board.courts.court1 });
    expect(bravoSlots.find((s) => s.id === bravoIds[0])).toMatchObject({ at: at(0), court: board.courts.court3 });
  }, 60_000);
});
