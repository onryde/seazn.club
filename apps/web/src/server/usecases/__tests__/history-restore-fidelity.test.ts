// History restore fidelity (2026-09-23): a row that undo takes away and a later
// undo puts back must come back as the row that was taken.
//
// Two history paths DELETE fixtures and snapshot them first, and two re-insert
// those snapshots raw (history.ts `restoreFixtures`):
//
//   - undoing a generation deletes the stage's fixtures (`fixtures_cleared`,
//     snapshot taken in `stepWrite`). Once a later edit makes that undo part of
//     history, walking back past it — Undo twice, or restoring a save point,
//     which is a loop of the same undo — re-inserts the snapshot. NOTE: a plain
//     Generate → Undo → Redo never reaches the raw insert: Redo re-runs the
//     generator (`regenerate_stage_id`), which writes every column itself but
//     mints new fixture ids. That path is not what this file tests.
//   - clearing a pool's entrants deletes its fixtures (`pool_entrants_cleared`,
//     snapshot taken in `clearPoolEntrants`); Undo re-inserts them.
//
// The snapshot used to carry nine columns, so a restored bracket lost its
// ext_key, its V368 round role (is_final / third_place / lane / conditional),
// its TBD placeholders, its feed edges (winners stopped advancing), its byes'
// awards, its fixture numbers and the schedule pin — the schedule board fell
// back to R{n} and a regeneration no longer recognised a single row.
//
// Every assertion here compares the WHOLE row (`select *`), never a typed list
// of expected values: a column the restore drops shows up as a diff, including
// one added to the table after this file was written. `created_at` is the one
// column excluded — the row really is inserted again.
//
// Real Postgres required; skipped without DATABASE_URL.
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { log } from "@/server/logger";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import { boardRoundCodes } from "@/components/v2/board/round-codes";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant } from "../entrants";
import {
  addFixture,
  completeStage,
  computeSeedProposal,
  confirmSeedProposal,
  createStages,
  deleteStage,
  generateStageFixtures,
  listStages,
} from "../stages";
import { listDivisionFixturesForBoard, patchFixture } from "../fixtures";
import { applySchedule, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { shiftDivisionSchedule } from "../schedule-plus";
import { createCourt, createVenue, deleteCourt } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import {
  clearPoolEntrants,
  clearScheduleScoped,
  createCheckpoint,
  redoDivision,
  restoreCheckpoint,
  undoDivision,
} from "../history";
import { EngineError } from "@seazn/engine/core";
import { v1 } from "@/server/api-v1/http";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { PLAYED_REFUSAL_CODE } from "@/lib/played-fixture-statuses";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

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
});

const en =(key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars);

type Row = Record<string, unknown>;

/** Every column of every fixture in `stage_id`/`pool_id` = `id`, by fixture
 *  id, minus `created_at`. */
async function wholeRows(column: "stage_id" | "pool_id", id: string): Promise<Row[]> {
  const rows = await sql<Row[]>`select * from fixtures where ${sql(column)} = ${id} order by id`;
  return rows.map((r) => {
    const row: Row = { ...r };
    delete row.created_at;
    return row;
  });
}

/** What each restored column holds when a restore does NOT write it: its
 *  insert default. A scene only witnesses a column if some row differs. */
const DROPPED_VALUE: Record<string, unknown> = {
  ext_key: null,
  lane: null,
  is_final: false,
  third_place: false,
  conditional: false,
  home_slot_label: null,
  away_slot_label: null,
  winner_to_fixture: null,
  winner_to_slot: null,
  loser_to_fixture: null,
  loser_to_slot: null,
  status: "scheduled",
  outcome: null,
  scheduled_at: null,
  court_id: null,
  venue_id: null,
  schedule_locked: false,
  schedule_source: "none",
};

/** The scene is not vacuous for `cols`: each has a value a drop would lose. */
function expectWitnesses(rows: Row[], cols: string[]): void {
  for (const col of cols) {
    expect(
      rows.some((r) => !isDeepStrictEqual(r[col], DROPPED_VALUE[col])),
      `no row carries a non-default ${col}, so this scene cannot see it dropped`,
    ).toBe(true);
  }
}

async function seedDivision(n: number) {
  const { auth } = await seedOrg("pro"); // double elimination + page playoff are Pro-gated
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Restore Fidelity",
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({
      kind: "individual" as const,
      display_name: `Entrant ${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  return { auth, divisionId: division.id };
}

/** The stage under test at seq 1, generated by the REAL generator, plus a
 *  league at seq 2 whose generation is the "later edit". */
async function seedGeneratedStage(
  n: number,
  kind: "knockout" | "double_elim" | "page_playoff" | "league",
  config: Record<string, unknown>,
) {
  const { auth, divisionId } = await seedDivision(n);
  const [main] = await createStages(auth, divisionId, { seq: 1, kind, name: kind, config });
  const [later] = await createStages(auth, divisionId, { seq: 2, kind: "league", name: "Later", config: {} });
  await generateStageFixtures(auth, main!.id);
  return { auth, divisionId, mainId: main!.id, laterId: later!.id };
}

/** Append a ledger event as-is (a snapshot shape the code under test would not
 *  build itself), at the head, so the next Undo inverts it. */
async function appendRawEvent(divisionId: string, type: string, payload: Record<string, unknown>) {
  const [{ seq }] = await sql<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int + 1 as seq from division_events where division_id = ${divisionId}`;
  await sql`
    insert into division_events (division_id, seq, type, payload, actor_id)
    values (${divisionId}, ${seq}, ${type}, ${sql.json(payload as never)}, null)`;
}

/** Undo the generation, make a later edit so that undo becomes history, then
 *  restore a save point taken before the undo: two undo steps, the second of
 *  which re-inserts the snapshot (the raw path, never the generator). */
async function undoThenRestore(auth: AuthCtx, divisionId: string, mainId: string, laterId: string) {
  const checkpoint = await createCheckpoint(auth, divisionId, "generated");
  expect((await undoDivision(auth, divisionId)).applied.type).toBe("fixtures_cleared");
  expect(await wholeRows("stage_id", mainId)).toEqual([]);
  await generateStageFixtures(auth, laterId);
  expect(await restoreCheckpoint(auth, divisionId, checkpoint.id, true)).toMatchObject({ steps: 2 });
  // The restore really went through the raw re-insert: the last event appended
  // is the snapshot-carrying `fixtures_generated`, and no generator re-run
  // wrote a `fixtures_generated` of its own after it.
  const [last] = await sql<{ type: string; has_snapshot: boolean }[]>`
    select type, payload ? 'fixtures' as has_snapshot from division_events
    where division_id = ${divisionId} order by seq desc limit 1`;
  expect(last).toEqual({ type: "fixtures_generated", has_snapshot: true });
}

describe.skipIf(!HAS_DB)("restoring an undone generation re-inserts every row exactly as generated", () => {
  it.each([
    {
      name: "knockout of 8 with a bronze match",
      n: 8,
      kind: "knockout" as const,
      config: { thirdPlace: true },
      witnesses: ["ext_key", "is_final", "third_place", "home_slot_label", "away_slot_label",
        "winner_to_fixture", "winner_to_slot", "loser_to_fixture", "loser_to_slot"],
    },
    {
      name: "page playoff of 4",
      n: 4,
      kind: "page_playoff" as const,
      config: {},
      witnesses: ["ext_key", "is_final", "home_slot_label", "away_slot_label",
        "winner_to_fixture", "winner_to_slot", "loser_to_fixture", "loser_to_slot"],
    },
    {
      name: "double elimination of 8 with a reset",
      n: 8,
      kind: "double_elim" as const,
      config: { bracketReset: true },
      witnesses: ["ext_key", "lane", "is_final", "conditional", "winner_to_fixture", "loser_to_fixture"],
    },
    {
      name: "knockout of 6 with a bronze match — two byes, decided at generation",
      n: 6,
      kind: "knockout" as const,
      config: { thirdPlace: true },
      witnesses: ["ext_key", "status", "outcome", "third_place", "away_slot_label"],
    },
  ])("$name — and a regeneration after it recognises every row and changes nothing", async ({ n, kind, config, witnesses }) => {
    const { auth, divisionId, mainId, laterId } = await seedGeneratedStage(n, kind, config);
    const generated = await wholeRows("stage_id", mainId);
    expect(generated.length).toBeGreaterThan(0);
    expectWitnesses(generated, witnesses);

    await undoThenRestore(auth, divisionId, mainId, laterId);

    expect(await wholeRows("stage_id", mainId)).toEqual(generated);

    // Regeneration is idempotent by ext_key, and its bye pass only fills an
    // EMPTY seat: over a faithful restore it creates nothing and advances no
    // bye winner a second time — every row, byes and their fed slots
    // included, stays exactly as generated.
    const again = await generateStageFixtures(auth, mainId);
    expect(again).toMatchObject({ created: 0, existing: generated.length });
    expect(await wholeRows("stage_id", mainId)).toEqual(generated);
  });

  it.each([
    {
      name: "knockout of 8 with a bronze match: QF, SF, F, 3rd",
      n: 8,
      kind: "knockout" as const,
      config: { thirdPlace: true },
      codes: () => ["3rd", "F", "QF", "QF", "QF", "QF", "SF", "SF"],
    },
    {
      // Named from ext_key `pp-*` alone (#854) — the column the restore used to drop.
      name: "page playoff of 4: Q1, E, Q2, F",
      n: 4,
      kind: "page_playoff" as const,
      config: {},
      codes: () => [
        en("bracket.roundShort.qualifier1"),
        en("bracket.roundShort.eliminator"),
        en("bracket.roundShort.qualifier2"),
        en("bracket.roundShort.final"),
      ].sort(),
    },
  ])("the schedule board names the restored stage exactly as it named the generated one — $name, never R{n}", async ({ n, kind, config, codes }) => {
    const { auth, divisionId, mainId, laterId } = await seedGeneratedStage(n, kind, config);
    const codesOf = async () => {
      const [board, stages] = await Promise.all([
        listDivisionFixturesForBoard(auth, divisionId),
        listStages(auth, divisionId),
      ]);
      const named = boardRoundCodes(board.filter((f) => f.stage_id === mainId), stages, en);
      return new Map([...named].map(([id, c]) => [id, c.code]));
    };
    const generated = await codesOf();
    expect([...generated.values()].sort()).toEqual(codes());

    await undoThenRestore(auth, divisionId, mainId, laterId);

    expect(await codesOf()).toEqual(generated);
  });

  // The other side of the knockout-of-6 case: a verdict recorded by PLAY is not
  // the generator's. Its score events went with the undo's delete, so the row
  // returns unplayed — status, outcome and the config frozen at match start —
  // while every other row comes back whole.
  it("a walkover recorded by play is not restored: its score events went with the undo, so that row returns unplayed", async () => {
    const { auth, divisionId, mainId, laterId } = await seedGeneratedStage(4, "league", {});
    await startDivision(auth, divisionId);
    const [played] = await sql<{ id: string; away_entrant_id: string }[]>`
      select id, away_entrant_id from fixtures where stage_id = ${mainId} order by fixture_no limit 1`;
    await scoreEvent(auth, played!.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, played!.id, {
      expected_seq: 1,
      type: "core.forfeit",
      payload: { by: played!.away_entrant_id, reason: "no-show" },
    });
    const generated = await wholeRows("stage_id", mainId);
    const walkover = generated.find((r) => r.id === played!.id)!;
    expect(walkover.status).toBe("forfeited");
    expect(walkover.outcome).not.toBeNull();

    await undoThenRestore(auth, divisionId, mainId, laterId);

    expect(await wholeRows("stage_id", mainId)).toEqual(
      generated.map((r) =>
        r.id === played!.id
          ? { ...r, status: "scheduled", outcome: null, config_snapshot: null, config_snapshot_at: null }
          : r,
      ),
    );
  });

  // Minor 1 (review of #857). A row minted OUTSIDE the ledger can take a key
  // back while the stage sits undone — the Swiss shell top-up
  // (reconcileSwissRoundShells) inserts `sw-rN-bK` shells with no ledger
  // entry, so no undo ever removes them. Inserted directly here: the same
  // state, a live row of the stage holding one snapshot row's ext_key. The
  // raw restore used to raise 23505 on `(stage_id, ext_key)`, and every retry
  // replays the same snapshot — Undo stuck for good.
  it("a key a live row took since the undo: the restored row comes back WITHOUT it, everything else whole, and Undo completes", async () => {
    const { auth, divisionId, mainId, laterId } = await seedGeneratedStage(8, "knockout", { thirdPlace: true });
    const generated = await wholeRows("stage_id", mainId);
    const bronze = generated.find((r) => r.third_place === true)!;
    const checkpoint = await createCheckpoint(auth, divisionId, "generated");
    await undoDivision(auth, divisionId);

    const liveId = randomUUID();
    await sql`
      insert into fixtures (id, stage_id, division_id, round_no, seq_in_round, ext_key, fixture_no)
      values (${liveId}, ${mainId}, ${divisionId}, 9, 1, ${bronze.ext_key as string}, 999)`;
    await generateStageFixtures(auth, laterId);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);

    await expect(restoreCheckpoint(auth, divisionId, checkpoint.id, true)).resolves.toMatchObject({ steps: 2 });

    const after = await wholeRows("stage_id", mainId);
    expect(after.find((r) => r.id === liveId)).toMatchObject({ ext_key: bronze.ext_key });
    expect(after.filter((r) => r.id !== liveId)).toEqual(
      generated.map((r) => (r.id === bronze.id ? { ...r, ext_key: null } : r)),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ fixtureId: bronze.id, extKey: bronze.ext_key });
  });

  // Minor 2. A declared cross-stage feed A→B lives on A's row. Undo B then A:
  // B's delete SET NULLs A→B, so A's snapshot is taken without it, and a
  // restore brings A back first. Only re-deriving the declared feed once B is
  // back can re-wire it.
  it("a declared cross-stage feed is re-wired when a save point restores its source stage BEFORE its target", async () => {
    const { auth, divisionId } = await seedDivision(4);
    const feed = { from_ext_key: "se-r0-i0", side: "loser", to_stage_seq: 2, to_ext_key: "se-r0-i0", slot: 2 };
    const [a] = await createStages(auth, divisionId, { seq: 1, kind: "knockout", name: "A", config: { cross_feeds: [feed] } });
    const [b] = await createStages(auth, divisionId, { seq: 2, kind: "knockout", name: "B", config: {} });
    const [later] = await createStages(auth, divisionId, { seq: 3, kind: "league", name: "Later", config: {} });
    await generateStageFixtures(auth, a!.id);
    await generateStageFixtures(auth, b!.id);
    const beforeA = await wholeRows("stage_id", a!.id);
    const beforeB = await wholeRows("stage_id", b!.id);
    const source = beforeA.find((r) => r.ext_key === feed.from_ext_key)!;
    const target = beforeB.find((r) => r.ext_key === feed.to_ext_key)!;
    expect(source).toMatchObject({ loser_to_fixture: target.id, loser_to_slot: 2 });

    const checkpoint = await createCheckpoint(auth, divisionId, "both generated");
    await undoDivision(auth, divisionId); // B goes; A→B is SET NULL
    await undoDivision(auth, divisionId); // A goes, snapshotted without A→B
    await generateStageFixtures(auth, later!.id);
    // later undone, then A restored, then B.
    expect(await restoreCheckpoint(auth, divisionId, checkpoint.id, true)).toMatchObject({ steps: 3 });

    expect(await wholeRows("stage_id", a!.id)).toEqual(beforeA);
    expect(await wholeRows("stage_id", b!.id)).toEqual(beforeB);
  });
});

describe.skipIf(!HAS_DB)("undoing a pool clear re-inserts every row exactly as it stood", () => {
  it("round-robin pool with a placed, pinned schedule: ext_key, fixture numbers and the whole placement come back", async () => {
    const { auth, divisionId } = await seedDivision(8);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "group",
      name: "Groups",
      config: { pools: { count: 2 } },
    });
    await generateStageFixtures(auth, stage!.id);
    const venue = await createVenue(auth, { name: "Hall", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "C1", sort: 0, tags: [] });

    // The pool that does NOT hold the division's highest fixture number: a
    // restore that let the trigger renumber would hand it max+1 onwards —
    // different numbers — where the top pool would get its own back by luck.
    const pools = await sql<{ id: string; top: number }[]>`
      select p.id, max(f.fixture_no)::int as top from pools p join fixtures f on f.pool_id = p.id
      where p.stage_id = ${stage!.id} group by p.id order by top`;
    const poolId = pools[0]!.id;
    const inPool = await sql<{ id: string }[]>`select id from fixtures where pool_id = ${poolId} order by fixture_no`;
    for (let i = 0; i < inPool.length; i++) {
      await patchFixture(auth, inPool[i]!.id, {
        scheduled_at: new Date(Date.UTC(2026, 6, 12, 9 + i)).toISOString(),
        court_id: court.id,
      });
    }
    await patchFixture(auth, inPool[0]!.id, { schedule_locked: true });

    const before = await wholeRows("pool_id", poolId);
    expectWitnesses(before, ["ext_key", "scheduled_at", "court_id", "venue_id", "schedule_locked", "schedule_source"]);

    await clearPoolEntrants(auth, poolId, true);
    expect(await wholeRows("pool_id", poolId)).toEqual([]);
    expect((await undoDivision(auth, divisionId)).applied.type).toBe("pool_entrants_restored");

    expect(await wholeRows("pool_id", poolId)).toEqual(before);
  });
});

describe.skipIf(!HAS_DB)("snapshots the ledger already holds, and snapshots that no longer fit", () => {
  // A snapshot appended before these fields existed carries nine columns. Its
  // undo must still re-insert the row, with every newer column at its default
  // — exactly what the restore wrote before — and never throw.
  it.each(["fixtures_cleared", "pool_entrants_cleared"] as const)(
    "a legacy %s snapshot (no round-role, feed or placement fields) restores with column defaults",
    async (type) => {
      const { auth, divisionId } = await seedDivision(2);
      const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "L", config: {} });
      const fxId = randomUUID();
      const legacy = {
        id: fxId, stage_id: stage!.id, pool_id: null, round_no: 3, seq_in_round: 2,
        home_entrant_id: null, away_entrant_id: null, at: null, court: null,
      };
      const [{ seq }] = await sql<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int + 1 as seq from division_events where division_id = ${divisionId}`;
      const payload = type === "fixtures_cleared"
        ? { stage_id: stage!.id, fixture_ids: [fxId], fixtures: [legacy] }
        : { pool_id: null, fixtures: [legacy] };
      await sql`
        insert into division_events (division_id, seq, type, payload, actor_id)
        values (${divisionId}, ${seq}, ${type}, ${sql.json(payload)}, null)`;

      await expect(undoDivision(auth, divisionId)).resolves.toBeDefined();

      const [row] = await wholeRows("stage_id", stage!.id);
      expect(row).toMatchObject({
        id: fxId, round_no: 3, seq_in_round: 2,
        ...DROPPED_VALUE,
        fixture_no: expect.any(Number),
      });
    },
  );

  it("a snapshot whose fixture number was taken since, and whose feed target is gone, still restores — renumbered, edge dropped", async () => {
    const { auth, divisionId } = await seedDivision(2);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "L", config: {} });
    await generateStageFixtures(auth, stage!.id);
    const [taken] = await sql<{ fixture_no: number }[]>`
      select fixture_no from fixtures where division_id = ${divisionId} limit 1`;
    const fxId = randomUUID();
    const snapshot = {
      id: fxId, stage_id: stage!.id, pool_id: null, round_no: 9, seq_in_round: 1,
      home_entrant_id: null, away_entrant_id: null, at: null, court: null,
      fixture_no: taken!.fixture_no, ext_key: "restored-key", is_final: true,
      winner_to_fixture: randomUUID(), winner_to_slot: 1,
      status: "scheduled", outcome: null, scored: false,
    };
    const [{ seq }] = await sql<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int + 1 as seq from division_events where division_id = ${divisionId}`;
    await sql`
      insert into division_events (division_id, seq, type, payload, actor_id)
      values (${divisionId}, ${seq}, 'fixtures_cleared',
              ${sql.json({ stage_id: stage!.id, fixture_ids: [fxId], fixtures: [snapshot] })}, null)`;

    await expect(undoDivision(auth, divisionId)).resolves.toBeDefined();

    const [row] = await sql<Row[]>`select * from fixtures where id = ${fxId}`;
    expect(row).toMatchObject({ ext_key: "restored-key", is_final: true, winner_to_fixture: null, winner_to_slot: null });
    expect(row!.fixture_no).not.toBe(taken!.fixture_no);
  });

  // Minor 3 (review of #857): the two guards no other scene reaches.
  it("a snapshot row that still exists is left exactly as it stands — its snapshotted edges never overwrite the live row's", async () => {
    const { auth, divisionId } = await seedDivision(4);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "L", config: {} });
    await generateStageFixtures(auth, stage!.id);
    const before = await wholeRows("stage_id", stage!.id);
    const live = before[0]!;
    const other = before[1]!;
    expect(live.winner_to_fixture).toBeNull();
    await appendRawEvent(divisionId, "fixtures_cleared", {
      stage_id: stage!.id,
      fixture_ids: [live.id],
      fixtures: [{
        id: live.id, stage_id: stage!.id, pool_id: null, round_no: live.round_no, seq_in_round: live.seq_in_round,
        home_entrant_id: live.home_entrant_id, away_entrant_id: live.away_entrant_id, at: null, court: null,
        fixture_no: live.fixture_no, ext_key: live.ext_key,
        winner_to_fixture: other.id, winner_to_slot: 1, status: "scheduled", outcome: null, scored: false,
      }],
    });

    await expect(undoDivision(auth, divisionId)).resolves.toBeDefined();

    expect(await wholeRows("stage_id", stage!.id)).toEqual(before);
  });

  it("two restored rows whose numbers were both taken since are renumbered in their original order", async () => {
    const { auth, divisionId } = await seedDivision(4);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "L", config: {} });
    await generateStageFixtures(auth, stage!.id);
    const [{ top }] = await sql<{ top: number }[]>`
      select max(fixture_no)::int as top from fixtures where division_id = ${divisionId}`;
    const snap = (fixtureNo: number, roundNo: number) => ({
      id: randomUUID(), stage_id: stage!.id, pool_id: null, round_no: roundNo, seq_in_round: 1,
      home_entrant_id: null, away_entrant_id: null, at: null, court: null,
      fixture_no: fixtureNo, ext_key: null, status: "scheduled", outcome: null, scored: false,
    });
    // Listed LATER number first — the order a snapshot read does not promise.
    const later = snap(top - 1, 20);
    const earlier = snap(top - 3, 21);
    await appendRawEvent(divisionId, "fixtures_cleared", {
      stage_id: stage!.id,
      fixture_ids: [later.id, earlier.id],
      fixtures: [later, earlier],
    });

    await expect(undoDivision(auth, divisionId)).resolves.toBeDefined();

    const numbers = await sql<{ id: string; fixture_no: number }[]>`
      select id, fixture_no from fixtures where id in ${sql([later.id, earlier.id])}`;
    const noOf = new Map(numbers.map((r) => [r.id, r.fixture_no]));
    expect([noOf.get(earlier.id), noOf.get(later.id)]).toEqual([top + 1, top + 2]);
  });
});

// G1 (gap hunt, #857). History treated only `decided` as played, so undoing a
// generation — or making or redoing a pool clear — deleted an `in_play` or
// `finalized` fixture outright and its score events cascaded away with it. The
// played set is now `deleteStage`'s: in_play, decided, finalized. One status per
// case, so dropping either from the set reds its own case.
type Played = "in_play" | "finalized";

/** Drive a fixture to `to` through the real scoring path (the same events a
 *  scorer's pad appends), after `startDivision`. */
async function play(auth: AuthCtx, fixtureId: string, to: Played): Promise<void> {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  if (to === "in_play") return;
  await scoreEvent(auth, fixtureId, { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
  await scoreEvent(auth, fixtureId, { expected_seq: 2, type: "core.finalize", payload: {} });
}

/** Every score event of every fixture in `column` = `id`, whole. */
async function scoreEventsIn(column: "stage_id" | "pool_id", id: string): Promise<Row[]> {
  return sql<Row[]>`
    select se.* from score_events se join fixtures f on f.id = se.fixture_id
    where f.${sql(column)} = ${id} order by se.fixture_id, se.seq`;
}

const refusedAsPlayed = (err: unknown) => EngineError.is(err, "ALREADY_DECIDED");

describe.skipIf(!HAS_DB)("a fixture in play or finalized is never taken away by history", () => {
  it.each(["in_play", "finalized"] as const)(
    "undoing a generation is refused while one of its fixtures is %s — every row and every score event survives",
    async (status) => {
      const { auth, divisionId, mainId } = await seedGeneratedStage(4, "league", {});
      await startDivision(auth, divisionId);
      const [target] = await sql<{ id: string }[]>`
        select id from fixtures where stage_id = ${mainId} order by fixture_no limit 1`;
      await play(auth, target!.id, status);
      const rows = await wholeRows("stage_id", mainId);
      expect(rows.find((r) => r.id === target!.id)?.status).toBe(status);
      const events = await scoreEventsIn("stage_id", mainId);
      expect(events.length).toBeGreaterThan(0);

      await expect(undoDivision(auth, divisionId)).rejects.toSatisfy(refusedAsPlayed);

      expect(await wholeRows("stage_id", mainId)).toEqual(rows);
      expect(await scoreEventsIn("stage_id", mainId)).toEqual(events);
    },
  );

  // Review 2 of #857, I2: what an organiser is told. The refusal crosses the
  // real /api/v1 envelope (`v1`) into the real client parser (`apiV1`) — the
  // panels' `ApiV1Error.code` branch reads exactly this. The sentence behind it
  // is the engine's, English, and used to name a fixture UUID and a
  // "force-clear" control that does not exist.
  it("the played refusal reaches the client as its CODE, in a sentence with no fixture id and no control that does not exist", async () => {
    const { auth, divisionId, mainId } = await seedGeneratedStage(4, "league", {});
    await startDivision(auth, divisionId);
    const [target] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${mainId} order by fixture_no limit 1`;
    await play(auth, target!.id, "in_play");

    const res = await v1(() => undoDivision(auth, divisionId));
    vi.stubGlobal("fetch", vi.fn(async () => res));
    try {
      const err = await apiV1(`/api/v1/divisions/${divisionId}/undo`, { method: "POST", json: {} }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ApiV1Error);
      expect(err).toMatchObject({ status: 422, code: PLAYED_REFUSAL_CODE });
      const message = (err as Error).message;
      expect(message).not.toContain(target!.id);
      expect(message).not.toMatch(/force-clear/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["in_play", "finalized"] as const)(
    "a pool clear — redone, or made — is refused while one of the pool's fixtures is %s — every row and every score event survives",
    async (status) => {
      const { auth, divisionId } = await seedDivision(8);
      const [stage] = await createStages(auth, divisionId, {
        seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } },
      });
      await generateStageFixtures(auth, stage!.id);
      await startDivision(auth, divisionId);
      const [pool] = await sql<{ id: string }[]>`
        select id from pools where stage_id = ${stage!.id} order by id limit 1`;
      const poolId = pool!.id;

      // Cleared, then put back — so the next Redo re-applies the clear.
      await clearPoolEntrants(auth, poolId, true);
      expect((await undoDivision(auth, divisionId)).applied.type).toBe("pool_entrants_restored");
      const [target] = await sql<{ id: string }[]>`
        select id from fixtures where pool_id = ${poolId} order by fixture_no limit 1`;
      await play(auth, target!.id, status);
      const rows = await wholeRows("pool_id", poolId);
      expect(rows.find((r) => r.id === target!.id)?.status).toBe(status);
      const events = await scoreEventsIn("pool_id", poolId);
      expect(events.length).toBeGreaterThan(0);

      await expect(redoDivision(auth, divisionId)).rejects.toSatisfy(refusedAsPlayed);
      await expect(clearPoolEntrants(auth, poolId, true)).rejects.toSatisfy(refusedAsPlayed);

      expect(await wholeRows("pool_id", poolId)).toEqual(rows);
      expect(await scoreEventsIn("pool_id", poolId)).toEqual(events);
    },
  );

  it("clearing the schedule skips an in-play and a finalized fixture, as it skips a decided one — both keep their slot", async () => {
    const { auth, divisionId, mainId } = await seedGeneratedStage(4, "league", {});
    const venue = await createVenue(auth, { name: "Hall", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "C1", sort: 0, tags: [] });
    const fixtures = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${mainId} order by fixture_no`;
    for (let i = 0; i < fixtures.length; i++) {
      await patchFixture(auth, fixtures[i]!.id, {
        scheduled_at: new Date(Date.UTC(2026, 6, 12, 9 + i)).toISOString(),
        court_id: court.id,
      });
    }
    await startDivision(auth, divisionId);
    const [inPlay, finalized] = [fixtures[0]!.id, fixtures[1]!.id];
    await play(auth, inPlay, "in_play");
    await play(auth, finalized, "finalized");
    const before = await wholeRows("stage_id", mainId);

    const result = await clearScheduleScoped(auth, {
      division_id: divisionId, scope: { excludeLocked: true }, confirm: true,
    });

    expect(result).toMatchObject({ cleared: fixtures.length - 2, skipped: { decided: 2 } });
    const after = await wholeRows("stage_id", mainId);
    for (const id of [inPlay, finalized]) {
      expect(after.find((r) => r.id === id)).toEqual(before.find((r) => r.id === id));
    }
  });

  // The row filter behind the engine's refusal: a fixture that starts playing
  // AFTER the undo read the played set — the scorer's first tap racing the
  // organiser's Undo. Parked on the row's own lock, so the order is forced.
  it("a fixture that starts playing while an Undo is deleting its generation is skipped by the delete, not taken", async () => {
    const { auth, divisionId, mainId } = await seedGeneratedStage(4, "league", {});
    const [racer] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${mainId} order by fixture_no limit 1`;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let announce!: (pid: number) => void;
    const held = new Promise<number>((resolve) => (announce = resolve));
    const holder = sql.begin(async (tx) => {
      const [me] = await tx<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
      await tx`select id from fixtures where id = ${racer!.id} for update`;
      announce(me!.pid);
      await gate;
      await tx`update fixtures set status = 'in_play' where id = ${racer!.id}`;
    });
    const holderPid = await held;

    const undo = undoDivision(auth, divisionId).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    // Positive evidence the Undo is parked on the racer's row before it moves.
    let parked = false;
    for (let i = 0; i < 200 && !parked; i++) {
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))`;
      parked = n > 0;
      if (!parked) await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await holder;
    expect(parked, "the Undo never waited on the racer's row lock").toBe(true);

    const settled = await undo;
    expect(settled.error).toBeUndefined();
    expect(settled.value?.applied.type).toBe("fixtures_cleared");
    const left = await sql<{ id: string; status: string }[]>`
      select id, status from fixtures where stage_id = ${mainId}`;
    expect(left).toEqual([{ id: racer!.id, status: "in_play" }]);
  });
});

// G2 (gap hunt, #857). A fixture's venue is its court's — every forward writer
// derives `venue_id` from `court_id` in the same statement. History's schedule
// replays wrote the court alone, so undoing a move across venues put the
// fixture back on its old court while every player-facing venue string (ICS
// LOCATION, /my-matches, the public fixture page) still named the new venue,
// and a schedule clear left a venue behind on a fixture with no court.
describe.skipIf(!HAS_DB)("every history write keeps a fixture's venue its court's", () => {
  async function twoVenues() {
    const { auth, divisionId, mainId } = await seedGeneratedStage(4, "league", {});
    const north = await createVenue(auth, { name: "North Hall", sort: 0 });
    const south = await createVenue(auth, { name: "South Hall", sort: 1 });
    const c1 = await createCourt(auth, north.id, { name: "N1", sort: 0, tags: [] });
    const c2 = await createCourt(auth, south.id, { name: "S1", sort: 0, tags: [] });
    const [f] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${mainId} order by fixture_no limit 1`;
    const at = new Date(Date.UTC(2026, 6, 12, 9)).toISOString();
    await patchFixture(auth, f!.id, { scheduled_at: at, court_id: c1.id });
    const placement = async () => {
      const [row] = await sql<{ court_id: string | null; venue_id: string | null }[]>`
        select court_id, venue_id from fixtures where id = ${f!.id}`;
      return row;
    };
    const onNorth = { court_id: c1.id, venue_id: north.id };
    const onSouth = { court_id: c2.id, venue_id: south.id };
    expect(await placement()).toEqual(onNorth);
    return { auth, divisionId, mainId, fixtureId: f!.id, c2: c2.id, at, placement, onNorth, onSouth };
  }

  it.each([
    { how: "a single move (schedule_edited)", event: "schedule_edited" },
    { how: "a board apply (schedule_applied)", event: "schedule_applied" },
  ])("undoing a move to another venue's court puts the venue back with the court — $how; redo moves both again", async ({ event }) => {
    const { auth, divisionId, mainId, fixtureId, c2, at, placement, onNorth, onSouth } = await twoVenues();
    if (event === "schedule_edited") {
      await patchFixture(auth, fixtureId, { court_id: c2 });
    } else {
      await applySchedule(auth, mainId, {
        assignments: [{ fixture_id: fixtureId, scheduled_at: at, court_id: c2 }],
        source: "manual",
      });
    }
    expect(await placement()).toEqual(onSouth);

    expect((await undoDivision(auth, divisionId)).applied.type).toBe(event);
    expect(await placement()).toEqual(onNorth);

    await redoDivision(auth, divisionId);
    expect(await placement()).toEqual(onSouth);
  });

  it("clearing the schedule takes the venue with the court, and undoing the clear puts both back", async () => {
    const { auth, divisionId, placement, onNorth } = await twoVenues();

    await clearScheduleScoped(auth, { division_id: divisionId, scope: { excludeLocked: true }, confirm: true });
    expect(await placement()).toEqual({ court_id: null, venue_id: null });

    expect((await undoDivision(auth, divisionId)).applied.type).toBe("schedule_restored");
    expect(await placement()).toEqual(onNorth);
  });

  // Review 2 of #857, M1. A fixture can hold a venue with NO court: `addFixture`
  // takes a venue alone, and `moveFixture` leaves the venue as it is whenever
  // the court is. The replays derived the venue from the payload's court every
  // time, so undoing a time-only move, a pin or a rain-delay shift wiped such a
  // fixture's venue, and a clear dropped it with nothing to bring it back.
  // One fresh division per edit: each is the head edit its Undo inverts.
  it.each([
    { how: "a time-only move", edit: "move", event: "schedule_edited", after: 10 },
    { how: "a pin", edit: "pin", event: "schedule_edited", after: 9 },
    { how: "a rain-delay shift", edit: "shift", event: "schedule_shifted", after: 10 },
    { how: "a schedule clear", edit: "clear", event: "schedule_restored", after: null },
  ] as const)("a fixture with a venue and no court keeps its venue through $how, and through its Undo", async ({ edit, event, after }) => {
    const { auth, divisionId, mainId } = await seedGeneratedStage(4, "league", {});
    const hall = await createVenue(auth, { name: "Hall", sort: 0 });
    const [a, b] = await sql<{ id: string }[]>`
      select id from entrants where division_id = ${divisionId} order by seed limit 2`;
    const t = (h: number) => new Date(Date.UTC(2026, 6, 12, h)).toISOString();
    const { fixture_id: id } = await addFixture(auth, mainId, {
      home_entrant_id: a!.id,
      away_entrant_id: b!.id,
      scheduled_at: t(9),
      venue_id: hall.id,
    });
    const placement = async () => {
      const [row] = await sql<Row[]>`select scheduled_at, court_id, venue_id from fixtures where id = ${id}`;
      return row;
    };
    const inHall = (h: number | null) => ({ scheduled_at: h === null ? null : new Date(t(h)), court_id: null, venue_id: hall.id });
    expect(await placement()).toEqual(inHall(9));

    if (edit === "move") await patchFixture(auth, id, { scheduled_at: t(10) });
    if (edit === "pin") await patchFixture(auth, id, { schedule_locked: true });
    if (edit === "shift") {
      await shiftDivisionSchedule(auth, { division_id: divisionId, scope: { excludeLocked: true }, delta_minutes: 60 });
    }
    if (edit === "clear") {
      await clearScheduleScoped(auth, { division_id: divisionId, scope: { excludeLocked: true }, confirm: true });
    }
    expect(await placement()).toEqual(inHall(after));

    expect((await undoDivision(auth, divisionId)).applied.type).toBe(event);
    expect(await placement()).toEqual(inHall(9));
  });
});

// G3 (gap hunt, #857). A restore wrote the snapshot back as it was, whatever the
// roster had done since: a withdrawn entrant re-seated in a line to be played
// (what F14 exists to prevent), and a deleted entrant, court, pool or stage
// written back as a dangling id — a foreign-key failure that refused the whole
// Undo, on every retry, because every retry replays the same snapshot.
describe.skipIf(!HAS_DB)("a restore respects what the roster lost since the snapshot", () => {
  it("an entrant WITHDRAWN since: her seat on a line still to play restores EMPTY, its feed and labels kept; the bye the draw already awarded her keeps her (F14)", async () => {
    const { auth, divisionId, mainId, laterId } = await seedGeneratedStage(6, "knockout", { thirdPlace: true });
    const generated = await wholeRows("stage_id", mainId);
    const seats = (r: Row, id: unknown) => r.home_entrant_id === id || r.away_entrant_id === id;
    // A bye holder: settled at generation, and advanced into a line to play.
    const bye = generated.find((r) => r.status !== "scheduled" && (r.home_entrant_id === null) !== (r.away_entrant_id === null))!;
    const holder = (bye.home_entrant_id ?? bye.away_entrant_id) as string;
    const fed = generated.find((r) => r.status === "scheduled" && seats(r, holder))!;
    expect(fed).toBeDefined();
    const side = fed.home_entrant_id === holder ? "home" : "away";
    // The emptied seat's placeholder: a filled seat stores no label, so the
    // board names it from the feed edge ("Winner of R1·n") — kept below, with
    // every stored label, by the whole-row equality.
    expect(bye).toMatchObject({ winner_to_fixture: fed.id, winner_to_slot: side === "home" ? 1 : 2 });

    await withdrawEntrantCascade(auth, holder); // before Start: a status flip, the rows keep her
    expect((await wholeRows("stage_id", mainId)).filter((r) => seats(r, holder))).toHaveLength(2);

    await undoThenRestore(auth, divisionId, mainId, laterId);

    expect(await wholeRows("stage_id", mainId)).toEqual(
      generated.map((r) => (r.id === fed.id ? { ...r, [`${side}_entrant_id`]: null } : r)),
    );
  });

  it("an entrant DELETED since: every seat she held restores empty, and Undo completes", async () => {
    const { auth, divisionId, mainId, laterId } = await seedGeneratedStage(4, "league", {});
    const generated = await wholeRows("stage_id", mainId);
    const [gone] = await sql<{ id: string }[]>`
      select id from entrants where division_id = ${divisionId} and seed = 4`;
    expect(generated.filter((r) => r.home_entrant_id === gone!.id || r.away_entrant_id === gone!.id)).toHaveLength(3);
    const checkpoint = await createCheckpoint(auth, divisionId, "generated");
    await undoDivision(auth, divisionId);
    await deleteEntrant(auth, gone!.id);
    await generateStageFixtures(auth, laterId);

    await expect(restoreCheckpoint(auth, divisionId, checkpoint.id, true)).resolves.toMatchObject({ steps: 2 });

    const empty = (id: unknown) => (id === gone!.id ? null : id);
    expect(await wholeRows("stage_id", mainId)).toEqual(
      generated.map((r) => ({ ...r, home_entrant_id: empty(r.home_entrant_id), away_entrant_id: empty(r.away_entrant_id) })),
    );
  });

  // Through a pool clear: its snapshot is taken with the placement ON (an
  // undone generation's is not — the move after it is undone first).
  it("a court DELETED since: the restored row keeps its time but comes back with no court and no venue, and Undo completes", async () => {
    const { auth, divisionId } = await seedDivision(8);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } },
    });
    await generateStageFixtures(auth, stage!.id);
    const venue = await createVenue(auth, { name: "Hall", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "C1", sort: 0, tags: [] });
    const [pool] = await sql<{ id: string }[]>`select id from pools where stage_id = ${stage!.id} order by id limit 1`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where pool_id = ${pool!.id} order by fixture_no limit 1`;
    await patchFixture(auth, f!.id, { scheduled_at: new Date(Date.UTC(2026, 6, 12, 9)).toISOString(), court_id: court.id });
    const before = await wholeRows("pool_id", pool!.id);
    expect(before.find((r) => r.id === f!.id)).toMatchObject({ court_id: court.id, venue_id: venue.id });
    await clearPoolEntrants(auth, pool!.id, true); // snapshot holds the court; the rows leave it
    await deleteCourt(auth, court.id);

    expect((await undoDivision(auth, divisionId)).applied.type).toBe("pool_entrants_restored");

    expect(await wholeRows("pool_id", pool!.id)).toEqual(
      before.map((r) => (r.id === f!.id ? { ...r, court_id: null, venue_id: null } : r)),
    );
  });

  it.each([
    { how: "a single move", event: "schedule_edited" },
    { how: "a board apply", event: "schedule_applied" },
    { how: "a schedule clear", event: "schedule_restored" },
  ])("a court DELETED since the fixture left it by $how: Undo puts the fixture on no court, not a dangling one", async ({ event }) => {
    const { auth, divisionId, mainId } = await seedGeneratedStage(4, "league", {});
    const venue = await createVenue(auth, { name: "Hall", sort: 0 });
    const c1 = await createCourt(auth, venue.id, { name: "C1", sort: 0, tags: [] });
    const c2 = await createCourt(auth, venue.id, { name: "C2", sort: 1, tags: [] });
    const [f] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${mainId} order by fixture_no limit 1`;
    const at = new Date(Date.UTC(2026, 6, 12, 9)).toISOString();
    await patchFixture(auth, f!.id, { scheduled_at: at, court_id: c1.id });
    if (event === "schedule_edited") await patchFixture(auth, f!.id, { court_id: c2.id });
    if (event === "schedule_applied") {
      await applySchedule(auth, mainId, {
        assignments: [{ fixture_id: f!.id, scheduled_at: at, court_id: c2.id }],
        source: "manual",
      });
    }
    if (event === "schedule_restored") {
      await clearScheduleScoped(auth, { division_id: divisionId, scope: { excludeLocked: true }, confirm: true });
    }
    await deleteCourt(auth, c1.id); // nothing is on it any more

    expect((await undoDivision(auth, divisionId)).applied.type).toBe(event);

    const [row] = await sql<Row[]>`select scheduled_at, court_id, venue_id from fixtures where id = ${f!.id}`;
    expect(row).toEqual({ scheduled_at: new Date(at), court_id: null, venue_id: null });
  });

  it("a stage DELETED since: its snapshot rows are skipped, and Undo completes", async () => {
    const { auth, divisionId } = await seedDivision(4);
    const [first] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "First", config: {} });
    const [last] = await createStages(auth, divisionId, { seq: 2, kind: "league", name: "Last", config: {} });
    await generateStageFixtures(auth, last!.id);
    expect((await undoDivision(auth, divisionId)).applied.type).toBe("fixtures_cleared"); // snapshot of Last
    await generateStageFixtures(auth, first!.id); // the later edit
    await deleteStage(auth, last!.id); // appends a NON-reversible stage_deleted
    expect((await undoDivision(auth, divisionId)).applied.type).toBe("fixtures_cleared"); // First's generation
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);

    await expect(undoDivision(auth, divisionId)).resolves.toMatchObject({ applied: { type: "fixtures_generated" } });

    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${last!.id}`;
    expect(n).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ stageIds: [last!.id] }), expect.any(String));
  });

  it("a pool DELETED since: the row restores with no pool", async () => {
    const { auth, divisionId } = await seedDivision(2);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "L", config: {} });
    const fxId = randomUUID();
    await appendRawEvent(divisionId, "fixtures_cleared", {
      stage_id: stage!.id,
      fixture_ids: [fxId],
      fixtures: [{
        id: fxId, stage_id: stage!.id, pool_id: randomUUID(), round_no: 1, seq_in_round: 1,
        home_entrant_id: null, away_entrant_id: null, at: null, court: null,
        status: "scheduled", outcome: null, scored: false,
      }],
    });

    await expect(undoDivision(auth, divisionId)).resolves.toBeDefined();

    expect(await sql`select pool_id from fixtures where id = ${fxId}`).toEqual([{ pool_id: null }]);
  });
});

// G4 (gap hunt, #857). An undo of a restore, and a redo of a clear, hand back
// the payload of the event they invert or copy — whose snapshot predates the
// restore. The delete-side event kept it whenever one was there, so a change
// made outside the ledger after the restore was deleted and the next restore
// quietly put the OLD row back. Now every delete-side event re-reads the rows.
describe.skipIf(!HAS_DB)("a change made outside the ledger after a restore survives the next round trip", () => {
  it("a seed fill made after a knockout was restored: undoing that restore and restoring it again brings back the FILLED seats", async () => {
    const { auth, divisionId } = await seedDivision(4);
    const created = await createStages(auth, divisionId, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      {
        seq: 2, kind: "knockout", name: "KO", config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
      { seq: 3, kind: "league", name: "Later", config: {} },
    ]);
    const [group, ko, later] = [1, 2, 3].map((seq) => created.find((st) => st.seq === seq)!);
    await generateStageFixtures(auth, group.id);
    await generateStageFixtures(auth, ko.id); // TBD; completing the group needs it
    const groupFixtures = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${group.id}`;
    for (const f of groupFixtures) {
      await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
      await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
    }
    await completeStage(auth, group.id);
    const undoes = async (...types: string[]) => {
      for (const type of types) expect((await undoDivision(auth, divisionId)).applied.type).toBe(type);
    };

    // KO undone, a later edit, then walked back: the KO restored raw, TBD.
    await undoes("fixtures_cleared");
    await generateStageFixtures(auth, later.id);
    await undoes("fixtures_cleared", "fixtures_generated");
    expect((await wholeRows("stage_id", ko.id)).every((r) => r.home_entrant_id === null)).toBe(true);

    // The seed fill — it appends no reversible event.
    const proposal = await computeSeedProposal(auth, ko.id);
    expect(await confirmSeedProposal(auth, ko.id, { proposalId: proposal.id })).toMatchObject({ filled: 2 });
    const filled = await wholeRows("stage_id", ko.id);
    expect(filled.every((r) => r.home_entrant_id !== null && r.away_entrant_id !== null)).toBe(true);

    // Make that restore history; undo it (the KO goes again), then restore it.
    await generateStageFixtures(auth, later.id);
    await undoes("fixtures_cleared", "fixtures_cleared");
    expect(await wholeRows("stage_id", ko.id)).toEqual([]);
    await generateStageFixtures(auth, later.id);
    await undoes("fixtures_cleared", "fixtures_generated");

    expect(await wholeRows("stage_id", ko.id)).toEqual(filled);
  });

  // Any writer that appends no division event stands in here (the seed fill
  // above is the real one): a direct UPDATE to a row the Undo put back.
  it("a pool row changed outside the ledger after an Undo put it back: Redo clears it as it now stands, and the next Undo restores THAT", async () => {
    const { auth, divisionId } = await seedDivision(8);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } },
    });
    await generateStageFixtures(auth, stage!.id);
    const [pool] = await sql<{ id: string }[]>`select id from pools where stage_id = ${stage!.id} order by id limit 1`;
    await clearPoolEntrants(auth, pool!.id, true);
    expect((await undoDivision(auth, divisionId)).applied.type).toBe("pool_entrants_restored");
    const [f] = await sql<{ id: string }[]>`select id from fixtures where pool_id = ${pool!.id} order by fixture_no limit 1`;
    await sql`update fixtures set home_entrant_id = away_entrant_id, away_entrant_id = home_entrant_id where id = ${f!.id}`;
    const changed = await wholeRows("pool_id", pool!.id);

    expect((await redoDivision(auth, divisionId)).applied.type).toBe("pool_entrants_cleared");
    expect(await wholeRows("pool_id", pool!.id)).toEqual([]);
    expect((await undoDivision(auth, divisionId)).applied.type).toBe("pool_entrants_restored");

    expect(await wholeRows("pool_id", pool!.id)).toEqual(changed);
  });
});
