// #399 W4 acceptance — blocking is DELTA-based on the board and the apply path.
//
// The rule this file exists to prove, in both directions:
//
//   REJECT   a change that INTRODUCES a person overlap, or puts a fixture
//            outside the competition's own dates, is refused (409).
//   ACCEPT   a board that ALREADY carries one stays editable. Boards published
//            before this wave may hold person overlaps — they were warnings all
//            along — and under an absolute rule the organiser's next edit would
//            409, leaving them unable to fix the very thing that is wrong.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { applySchedule, moveFixture, putScheduleSettings, validateSchedule } from "../schedule";
import { createVenue, createCourt } from "../venues";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const T0 = "2026-08-03T09:00:00.000Z";
const MIN = 60_000;
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * MIN).toISOString();

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Board {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  /** Round-robin over A/B/C/D, one fixture per 60 minutes on courts[0]. */
  fixtures: { id: string; home: string; away: string; at: string; court: string }[];
  /** P9 pass 3a: the 3 real courts.id values `["Court 1","Court 2","Court 3"]`
   *  used to be — `court`/`court_label` everywhere below is one of these. */
  courts: [string, string, string];
}

/**
 * Four entrants, a round robin (6 fixtures), every fixture on its own hour so
 * the starting board verifies CLEAN. `perEntrantMinRest` is 0 on purpose: this
 * file is about person overlap and the window, and a rest warning in the middle
 * of it would only make the assertions ambiguous.
 */
async function seedBoard(endAt?: string): Promise<Board> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Delta ${randomUUID().slice(0, 6)}`,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((display_name, i) => ({
      kind: "individual" as const,
      display_name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  // P9 pass 3a: 3 real courts — `ScheduleConfig.courts` has been `CourtId[]`
  // (real uuids) since pass 1, and `fixtures.court_id` carries a composite
  // FK to `courts(id, org_id)` since V367/368, so a free-text "Court 1"
  // string is no longer legal on either the config or a write.
  const venue = await createVenue(auth, { name: "Main", sort: 0 });
  const court1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
  const court2 = await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
  const court3 = await createCourt(auth, venue.id, { name: "Court 3", sort: 2, tags: [] });
  const courts: [string, string, string] = [court1.id, court2.id, court3.id];
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      ...(endAt !== undefined ? { endAt } : {}),
      matchMinutes: 30,
      gapMinutes: 0,
      courts,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const rows = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures
    where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  const placed = rows.map((r, i) => ({
    id: r.id,
    home: r.home_entrant_id,
    away: r.away_entrant_id,
    at: at(i * 60),
    court: court1.id,
  }));
  const applied = await applySchedule(auth, stage!.id, {
    assignments: placed.map((p) => ({ fixture_id: p.id, scheduled_at: p.at, court_id: p.court })),
    source: "manual",
  });
  expect(applied.applied).toBe(fixtures.length);
  expect(applied.conflicts.filter((c) => c.blocking)).toHaveLength(0);
  return { auth, divisionId: division.id, stageId: stage!.id, fixtures: placed, courts };
}

/** Write a slot straight to the row, bypassing every gate — the only way to
 *  manufacture the board a pre-W4 organiser could legitimately be sitting on.
 *  `court` is a real `courts.id` (P9 pass 3a) — see `Board.courts`. */
async function forceSlot(fixtureId: string, scheduledAt: string, court: string): Promise<void> {
  await sql`
    update fixtures set scheduled_at = ${scheduledAt}, court_id = ${court}
    where id = ${fixtureId}`;
}

/** Two fixtures that share an entrant — the pair a person overlap needs. */
function sharingPair(board: Board): [Board["fixtures"][number], Board["fixtures"][number]] {
  const first = board.fixtures[0]!;
  const other = board.fixtures.find(
    (f) => f.id !== first.id && (f.home === first.home || f.away === first.home),
  )!;
  return [first, other];
}

describe.skipIf(!HAS_DB)("delta-based blocking (#399)", () => {
  it("REFUSES a drag that introduces a person overlap", async () => {
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    await expect(
      moveFixture(board.auth, sharer.id, { scheduled_at: anchor.at, court_id: board.courts[1] }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
    const [after] = await sql<{ scheduled_at: Date }[]>`
      select scheduled_at from fixtures where id = ${sharer.id}`;
    expect(after!.scheduled_at.toISOString()).toBe(sharer.at);
  });

  it("names the rule on the refusal, so the organiser and a repair round agree", async () => {
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    const err = await moveFixture(board.auth, sharer.id, {
      scheduled_at: anchor.at,
      court_id: board.courts[1],
    }).catch((e: unknown) => e);
    expect(EngineError.is(err, "SCHEDULE_CONFLICT")).toBe(true);
    const conflicts = ((err as EngineError).data as {
      conflicts: { code: string; rule?: string; blocking: boolean }[];
    }).conflicts;
    expect(conflicts.every((c) => c.blocking)).toBe(true);
    expect(conflicts.some((c) => c.code === "warn.person_overlap" && c.rule === "H4")).toBe(true);
  });

  it("keeps a board that ALREADY holds a person overlap editable", async () => {
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    // The board a pre-W4 organiser is sitting on: the overlap is already there.
    await forceSlot(sharer.id, anchor.at, board.courts[1]);

    // An unrelated card still moves.
    //
    // C1 fix-loop (G2/3rd instance): moved EARLIER than the board (`at(-60)`),
    // not later (the original `at(600)`). `unrelated` is round 1 here (the
    // round robin's OTHER round-1 fixture, `sharingPair`'s `first` being the
    // one this file always draws `anchor` from) — pushing it ten hours PAST
    // rounds 2/3's untouched, still-original-position siblings was a genuine
    // round-order violation this test was unknowingly creating; the delta
    // gate's own round-robin blind spot (this task's fix) simply couldn't see
    // it before. Round 1 moving earlier can never breach round order,
    // however far — see `roundRobinSequenceSiblings`'s own comment.
    const unrelated = board.fixtures.find((f) => f.id !== anchor.id && f.id !== sharer.id)!;
    await moveFixture(board.auth, unrelated.id, {
      scheduled_at: at(-60),
      court_id: board.courts[1],
    });
    const [moved] = await sql<{ scheduled_at: Date }[]>`
      select scheduled_at from fixtures where id = ${unrelated.id}`;
    expect(moved!.scheduled_at.toISOString()).toBe(at(-60));

    // And the pre-existing overlap is still REPORTED. `blocking` on a report
    // means IMPOSSIBLE, not "refused" (#399): the board paints that card red,
    // which is honest — and the edit above proves red does not mean frozen.
    const report = await validateSchedule(board.auth, board.divisionId);
    const overlaps = report.conflicts.filter((c) => c.code === "warn.person_overlap");
    expect(overlaps.length).toBeGreaterThan(0);
    expect(overlaps.every((c) => c.blocking)).toBe(true);
    expect(overlaps.every((c) => c.rule === "H4")).toBe(true);
  });

  it("re-applies a dirty board unchanged rather than 409ing on its own history", async () => {
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    await forceSlot(sharer.id, anchor.at, board.courts[1]);

    const out = await applySchedule(board.auth, board.stageId, {
      assignments: board.fixtures.map((f) => ({
        fixture_id: f.id,
        scheduled_at: f.id === sharer.id ? anchor.at : f.at,
        court_id: f.id === sharer.id ? board.courts[1] : f.court,
      })),
      source: "manual",
    });
    expect(out.applied).toBe(board.fixtures.length);
    expect(out.conflicts.some((c) => c.code === "warn.person_overlap")).toBe(true);
  });

  it("REFUSES a change that WORSENS an existing overlap", async () => {
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    await forceSlot(sharer.id, anchor.at, board.courts[1]);
    // A third fixture with the same entrant dragged onto the same instant: the
    // person was already double-booked, and this makes it three at once.
    const third = board.fixtures.find(
      (f) =>
        f.id !== anchor.id &&
        f.id !== sharer.id &&
        (f.home === anchor.home || f.away === anchor.home),
    );
    // The round robin gives entrant A three opponents, so this always exists.
    expect(third).toBeDefined();
    // courts[2] ("Court 3"), so the refusal can only be the person — a third
    // card on courts[1] would be a court clash and would block for a reason
    // this test is not about.
    await expect(
      moveFixture(board.auth, third!.id, { scheduled_at: anchor.at, court_id: board.courts[2] }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
  });

  it("REFUSES a drag outside the competition's own dates", async () => {
    const board = await seedBoard(at(60 * 24)); // one day long
    const target = board.fixtures[0]!;
    await expect(
      moveFixture(board.auth, target.id, {
        scheduled_at: at(60 * 24 * 5),
        court_id: board.courts[1],
      }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
  });

  it("keeps a board already outside its window editable", async () => {
    const board = await seedBoard(at(60 * 24));
    const stray = board.fixtures[0]!;
    await forceSlot(stray.id, at(60 * 24 * 5), board.courts[1]);
    // Moving the stray card WITHIN the same out-of-window day is not a new
    // conflict — the same key was already there.
    await moveFixture(board.auth, stray.id, {
      scheduled_at: at(60 * 24 * 5 + 90),
      court_id: board.courts[1],
    });
    const [moved] = await sql<{ scheduled_at: Date }[]>`
      select scheduled_at from fixtures where id = ${stray.id}`;
    expect(moved!.scheduled_at.toISOString()).toBe(at(60 * 24 * 5 + 90));
  });

  it("REFUSES a SWAP that double-books a different fixture on the same court", async () => {
    // The subtle leak: a fixture already clashing on Court 1 with B, dragged to
    // a slot where it clashes with C instead. Both are "court double-booked" on
    // the same card and the same court — so a conflict identity that named only
    // the court would key them the same and write a BRAND-NEW double-booking
    // through as pre-existing, on the one reason that blocked absolutely before
    // this wave.
    const board = await seedBoard();
    const [first, second, third] = [board.fixtures[0]!, board.fixtures[1]!, board.fixtures[2]!];
    // Pre-existing: `second` sits on top of `first`.
    await forceSlot(second.id, first.at, first.court);
    // Now drag it onto `third` instead — same court, different victim.
    await expect(
      moveFixture(board.auth, second.id, { scheduled_at: third.at, court_id: third.court }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
  });

  it("REFUSES a SWAP that double-books a different person", async () => {
    // Same leak, the person lane: entrant A already overlapping with one
    // fixture, moved to overlap with another. Different clash, same card.
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    await forceSlot(sharer.id, anchor.at, board.courts[1]);
    const otherSharer = board.fixtures.find(
      (f) =>
        f.id !== anchor.id &&
        f.id !== sharer.id &&
        (f.home === sharer.home || f.away === sharer.home || f.home === sharer.away || f.away === sharer.away),
    )!;
    await expect(
      moveFixture(board.auth, sharer.id, {
        scheduled_at: otherSharer.at,
        court_id: board.courts[2],
      }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
  });

  it("still refuses a court double-booking, delta or not", async () => {
    // The one reason that blocked before this wave must keep blocking.
    const board = await seedBoard();
    const [a, b] = [board.fixtures[0]!, board.fixtures[1]!];
    await expect(
      moveFixture(board.auth, b.id, { scheduled_at: a.at, court_id: a.court }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
  });

  // P9 pass 3a — the dispatch's own regressions, placed here because this
  // describe block already has the exact machinery they need (a real
  // multi-court board, forceSlot for "already on the row", the
  // EngineError.data.conflicts extraction pattern).
  it("resolves a court double-booking by court_id even when the victim's LEGACY court_label is stale/wrong — readers no longer trust that column", async () => {
    const board = await seedBoard();
    const [a, b] = [board.fixtures[0]!, board.fixtures[1]!];
    // `a` already sits on `board.courts[0]`. Poison its free-text
    // court_label to a value that names NEITHER real court — nothing
    // production-side has written this column since P9 pass 3a, so this
    // simulates exactly the "stale, never-updated label" the dispatch
    // describes. If any reader still consulted court_label instead of
    // court_id, this fixture would no longer appear to occupy
    // `board.courts[0]` at all, and the double-booking below would go
    // undetected.
    await sql`update fixtures set court_label = 'a court that does not exist' where id = ${a.id}`;
    await expect(
      moveFixture(board.auth, b.id, { scheduled_at: a.at, court_id: a.court }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
  });

  it("a court double-booking conflict carries the court id AND renders a human name, never a bare uuid", async () => {
    const board = await seedBoard();
    const [a, b] = [board.fixtures[0]!, board.fixtures[1]!];
    const err = await moveFixture(board.auth, b.id, {
      scheduled_at: a.at,
      court_id: a.court,
    }).catch((e: unknown) => e);
    expect(EngineError.is(err, "SCHEDULE_CONFLICT")).toBe(true);
    const conflicts = ((err as EngineError).data as {
      conflicts: {
        code: string;
        blocking: boolean;
        detail?: string;
        details?: { kind: string; court?: string; court_name?: string };
      }[];
    }).conflicts;
    const courtConflicts = conflicts.filter((c) => c.code === "conflict.court");
    expect(courtConflicts.length).toBeGreaterThan(0);
    for (const c of courtConflicts) {
      // The id — real, and the actual court_id both fixtures now share.
      expect(c.details?.court).toBe(a.court);
      // The DERIVED name (P9 pass 3a) — "Court 1", not the uuid.
      expect(c.details?.court_name).toBe("Court 1");
      // The deprecated legacy prose (conflict-detail-legacy.ts) must also
      // read the name, never the bare id — this is the actual user-facing
      // text some existing clients still render.
      expect(c.detail).toContain("Court 1");
      expect(c.detail).not.toContain(a.court);
    }
  });
});

// C1 fix-loop, G2/3rd instance. `moveFixture` and `applySchedule`'s partial
// (not-all-fixtures) apply share one structural blind spot: the round-order
// pair scan (calendar.ts, scoped to `assignments` alone by design) can only
// ever compare fixtures that are BOTH in `assignments`. Before this fix, the
// checked side here is always the one moved fixture — a one-element array can
// never contain a same-sequence PAIR — so a drag/partial-apply that put a
// fixture in round-order violation against an untouched, already-placed
// sibling succeeded silently. The fix pulls that fixture's round-robin
// sequence siblings out of `existing` and into `assignments`, symmetrically
// on BOTH the baseline (current position) and proposed (new position) side of
// the delta comparison.
//
// `seedBoard`'s round robin (4 entrants, `kind: "league"`) is round-robin by
// `roundRobinStageIds`'s own definition, applied round-ascending at hourly
// slots — `board.fixtures[i]`'s round is monotonic in `i` by construction
// (`generateStageFixtures` orders `round_no, seq_in_round`), confirmed via a
// direct `round_no` read rather than assumed, so a change to the generator's
// shape reds this loudly instead of silently testing the wrong pair.
describe.skipIf(!HAS_DB)("round order is part of the delta gate too (C1 fix-loop, G2/3rd instance)", () => {
  async function roundsOf(board: Board): Promise<Map<string, number>> {
    const rows = await sql<{ id: string; round_no: number }[]>`
      select id, round_no from fixtures where id in ${sql(board.fixtures.map((f) => f.id))}`;
    return new Map(rows.map((r) => [r.id, r.round_no]));
  }

  it("REFUSES a moveFixture drag of an already-placed fixture into a round-order violation against an untouched sibling", async () => {
    const board = await seedBoard();
    const rounds = await roundsOf(board);
    const laterRound = board.fixtures.find((f) => (rounds.get(f.id) ?? 0) > 1)!;
    expect(laterRound, "no round > 1 in this board — the round-robin shape assumption broke").toBeDefined();

    // An hour before round 1 (`at(0)`), on a court nobody else uses — no
    // overlap in time or court with anything already on the board, so the
    // ONLY thing this drag can trip is round order.
    await expect(
      moveFixture(board.auth, laterRound.id, { scheduled_at: at(-60), court_id: board.courts[2] }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
    const [after] = await sql<{ scheduled_at: Date }[]>`
      select scheduled_at from fixtures where id = ${laterRound.id}`;
    expect(after!.scheduled_at.toISOString()).toBe(laterRound.at);
  });

  it("names round order on the refusal, blamed on the later round (calendar.ts's own convention)", async () => {
    const board = await seedBoard();
    const rounds = await roundsOf(board);
    const laterRound = board.fixtures.find((f) => (rounds.get(f.id) ?? 0) > 1)!;

    const err = await moveFixture(board.auth, laterRound.id, {
      scheduled_at: at(-60),
      court_id: board.courts[2],
    }).catch((e: unknown) => e);
    expect(EngineError.is(err, "SCHEDULE_CONFLICT")).toBe(true);
    const conflicts = ((err as EngineError).data as {
      conflicts: { code: string; rule?: string; blocking: boolean; fixture_id: string }[];
    }).conflicts;
    const order = conflicts.filter((c) => c.code === "warn.order");
    expect(order.length).toBeGreaterThan(0);
    expect(order.every((c) => c.blocking && c.rule === "H6")).toBe(true);
    expect(order.some((c) => c.fixture_id === laterRound.id)).toBe(true);
  });

  it("REFUSES moveFixture placing a never-scheduled fixture directly into a round-order violation (currentSlot=[] branch)", async () => {
    const board = await seedBoard();
    const rounds = await roundsOf(board);
    const laterRound = board.fixtures.find((f) => (rounds.get(f.id) ?? 0) > 1)!;
    // Manufacture a fixture with NO current slot, so `moveFixture`'s
    // `currentSlot` ternary (schedule.ts:2232-2235) takes its `[]` branch —
    // baseline gets nothing from the moved fixture itself, only from the
    // widened siblings. The other unit tests above/below all move an
    // already-placed fixture, which takes the ternary's other branch.
    await sql`update fixtures set scheduled_at = null, court_id = null where id = ${laterRound.id}`;

    await expect(
      moveFixture(board.auth, laterRound.id, { scheduled_at: at(-60), court_id: board.courts[2] }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
    const [after] = await sql<{ scheduled_at: Date | null }[]>`
      select scheduled_at from fixtures where id = ${laterRound.id}`;
    expect(after!.scheduled_at).toBeNull();
  });

  it("ALLOWS a legal moveFixture drag on a board that already has a round-order violation among untouched siblings", async () => {
    const board = await seedBoard();
    const rounds = await roundsOf(board);
    const round1 = board.fixtures.find((f) => rounds.get(f.id) === 1)!;
    // A SECOND round-1 fixture — round robin over 4 entrants pairs two
    // fixtures per round, so this always exists — is the "unrelated" mover.
    // Round 1 has no earlier round to violate H6 against, so moving it
    // BACKWARD (never forward — see the zero-slack note below) is
    // unconditionally safe regardless of where the rest of the board sits.
    const otherRound1 = board.fixtures.find((f) => f.id !== round1.id && rounds.get(f.id) === 1)!;
    const laterRound = board.fixtures.find((f) => (rounds.get(f.id) ?? 0) > 1)!;
    expect(otherRound1, "expected two round-1 fixtures — the round-robin shape assumption broke").toBeDefined();
    // Bypass every gate — the only way to manufacture the board a pre-fix
    // organiser could legitimately already be sitting on (same idiom as the
    // person-overlap tests above, `forceSlot`).
    await forceSlot(laterRound.id, at(-60), board.courts[2]);

    // The false-block regression this file exists to catch: if the sibling
    // widening were asymmetric (assignments side only, not the baseline
    // side too), the pre-existing violation forced above would read as "new"
    // against ANY move touching this round-robin sequence and wrongly 409
    // here, even though this move touches neither `round1` nor `laterRound`.
    //
    // Moved BACKWARD (`at(-120)`, earlier than laterRound's forced `at(-60)`)
    // — moving a round-1 fixture forward instead risks leapfrogging past an
    // untouched later-round sibling still sitting at its original (much
    // earlier) position, which would be a SECOND, genuine violation this
    // test does not intend to create.
    await moveFixture(board.auth, otherRound1.id, { scheduled_at: at(-120), court_id: board.courts[1] });
    const [moved] = await sql<{ scheduled_at: Date }[]>`
      select scheduled_at from fixtures where id = ${otherRound1.id}`;
    expect(moved!.scheduled_at.toISOString()).toBe(at(-120));

    // And the pre-existing violation is still REPORTED on the full board —
    // proving the move above was accepted DESPITE the violation still being
    // true, not because it silently vanished.
    const report = await validateSchedule(board.auth, board.divisionId);
    const order = report.conflicts.filter((c) => c.code === "warn.order");
    expect(order.length).toBeGreaterThan(0);
  });

  it("REFUSES an applySchedule partial move that creates a round-order violation against an untouched sibling", async () => {
    const board = await seedBoard();
    const rounds = await roundsOf(board);
    const laterRound = board.fixtures.find((f) => (rounds.get(f.id) ?? 0) > 1)!;

    await expect(
      applySchedule(board.auth, board.stageId, {
        assignments: [{ fixture_id: laterRound.id, scheduled_at: at(-60), court_id: board.courts[2] }],
        source: "manual",
      }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
    const [after] = await sql<{ scheduled_at: Date }[]>`
      select scheduled_at from fixtures where id = ${laterRound.id}`;
    expect(after!.scheduled_at.toISOString()).toBe(laterRound.at);
  });

  it("ALLOWS a legal applySchedule partial move on a board that already has a round-order violation among untouched siblings", async () => {
    const board = await seedBoard();
    const rounds = await roundsOf(board);
    const round1 = board.fixtures.find((f) => rounds.get(f.id) === 1)!;
    const otherRound1 = board.fixtures.find((f) => f.id !== round1.id && rounds.get(f.id) === 1)!;
    const laterRound = board.fixtures.find((f) => (rounds.get(f.id) ?? 0) > 1)!;
    await forceSlot(laterRound.id, at(-60), board.courts[2]);

    const out = await applySchedule(board.auth, board.stageId, {
      assignments: [{ fixture_id: otherRound1.id, scheduled_at: at(-120), court_id: board.courts[1] }],
      source: "manual",
    });
    expect(out.applied).toBe(1);
    expect(out.conflicts.filter((c) => c.blocking)).toHaveLength(0);
    const report = await validateSchedule(board.auth, board.divisionId);
    expect(report.conflicts.filter((c) => c.code === "warn.order").length).toBeGreaterThan(0);
  });
});

// P9 pass 3a — a live bug found and fixed in the same pass: putScheduleSettings'
// court-removal guard has compared `court_label = any(removedCourts)` since pass
// 1 changed ScheduleConfig.courts to real court ids. A uuid can never equal a
// free-text label, so the guard has been silently inert for a whole pass — a
// court could be dropped from a division's config out from under a pinned or
// in-play fixture with nothing refusing it. No test named this guard at all
// before this pass (grep-verified: "cannot remove a court" appears nowhere in
// __tests__/), so it was untested as well as broken.
describe.skipIf(!HAS_DB)("putScheduleSettings refuses to remove a court still holding fixtures the schedule cannot move", () => {
  it("refuses removal of a court holding a PINNED fixture, and writes nothing", async () => {
    const board = await seedBoard();
    const pinned = board.fixtures[0]!; // sits on board.courts[0] ("Court 1")
    await moveFixture(board.auth, pinned.id, { schedule_locked: true });

    await expect(
      putScheduleSettings(board.auth, board.divisionId, {
        config: {
          startAt: T0,
          matchMinutes: 30,
          gapMinutes: 0,
          courts: [board.courts[1], board.courts[2]], // drops courts[0]
          perEntrantMinRest: 0,
          blackouts: [],
          sessionWindows: [],
        },
        tz: "UTC",
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Atomicity: the refused write must not have landed.
    const [row] = await sql<{ config: { courts: string[] } }[]>`
      select config from schedule_settings where division_id = ${board.divisionId}`;
    expect(row!.config.courts).toContain(board.courts[0]);
  });

  it("names the blocked court by its real NAME in the refusal, never a bare uuid", async () => {
    const board = await seedBoard();
    const pinned = board.fixtures[0]!;
    await moveFixture(board.auth, pinned.id, { schedule_locked: true });

    const err: unknown = await putScheduleSettings(board.auth, board.divisionId, {
      config: {
        startAt: T0,
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [board.courts[1], board.courts[2]],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    }).catch((e: unknown) => e);
    const message = (err as { message: string }).message;
    expect(message).toContain("Court 1");
    expect(message).not.toContain(board.courts[0]);
  });

  it("allows removing a court nothing currently occupies", async () => {
    const board = await seedBoard();
    // courts[2] ("Court 3") is configured but seedBoard never places anything
    // on it — nothing should block dropping it.
    const out = await putScheduleSettings(board.auth, board.divisionId, {
      config: {
        startAt: T0,
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [board.courts[0], board.courts[1]],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    expect(out.config.courts).toEqual([board.courts[0], board.courts[1]]);
  });

  // Fix 3: the 409's message used to hard-code "unpin or reschedule them
  // first" regardless of WHY the block fired — a court blocked purely by a
  // completed fixture has nothing to unpin and nothing to reschedule (a
  // decided match is history). The throw now carries a `code` plus two
  // booleans so the client can pick the remedy that actually applies:
  // `anyPinned` (something to unpin) and `anyFixed` (something to archive
  // instead, via the venue Directory — `venues.ts`'s `archiveCourt`).
  it("carries SCHEDULE_COURT_STILL_IN_USE with anyPinned true / anyFixed false when the block is a PIN only", async () => {
    const board = await seedBoard();
    const pinned = board.fixtures[0]!; // sits on board.courts[0] ("Court 1")
    await moveFixture(board.auth, pinned.id, { schedule_locked: true });

    await expect(
      putScheduleSettings(board.auth, board.divisionId, {
        config: {
          startAt: T0,
          matchMinutes: 30,
          gapMinutes: 0,
          courts: [board.courts[1], board.courts[2]], // drops courts[0]
          perEntrantMinRest: 0,
          blackouts: [],
          sessionWindows: [],
        },
        tz: "UTC",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "SCHEDULE_COURT_STILL_IN_USE",
      extra: { anyPinned: true, anyFixed: false },
    });
  });

  it("carries SCHEDULE_COURT_STILL_IN_USE with anyPinned false / anyFixed true when the block is a completed fixture only", async () => {
    const board = await seedBoard();
    const finished = board.fixtures[0]!; // sits on board.courts[0] ("Court 1")
    // No usecase marks a fixture decided directly; the repo's own test
    // convention is a raw status write (e.g. admin-fixture-config.test.ts,
    // officials.test.ts) — `finalized` is one of `FIXED_OCCUPYING`'s statuses.
    await sql`update fixtures set status = 'finalized' where id = ${finished.id}`;

    await expect(
      putScheduleSettings(board.auth, board.divisionId, {
        config: {
          startAt: T0,
          matchMinutes: 30,
          gapMinutes: 0,
          courts: [board.courts[1], board.courts[2]], // drops courts[0]
          perEntrantMinRest: 0,
          blackouts: [],
          sessionWindows: [],
        },
        tz: "UTC",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "SCHEDULE_COURT_STILL_IN_USE",
      extra: { anyPinned: false, anyFixed: true },
    });
  });

  it("carries anyPinned true AND anyFixed true when the same save is blocked by both a pin and a completed fixture", async () => {
    const board = await seedBoard();
    // Both sit on board.courts[0] — seedBoard places every fixture there —
    // so removing courts[0] alone trips both reasons in the same refusal.
    const pinned = board.fixtures[0]!;
    const finished = board.fixtures[1]!;
    await moveFixture(board.auth, pinned.id, { schedule_locked: true });
    await sql`update fixtures set status = 'finalized' where id = ${finished.id}`;

    await expect(
      putScheduleSettings(board.auth, board.divisionId, {
        config: {
          startAt: T0,
          matchMinutes: 30,
          gapMinutes: 0,
          courts: [board.courts[1], board.courts[2]], // drops courts[0]
          perEntrantMinRest: 0,
          blackouts: [],
          sessionWindows: [],
        },
        tz: "UTC",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "SCHEDULE_COURT_STILL_IN_USE",
      extra: { anyPinned: true, anyFixed: true },
    });
  });
});
