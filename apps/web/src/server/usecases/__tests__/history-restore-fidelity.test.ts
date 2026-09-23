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
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import { boardRoundCodes } from "@/components/v2/board/round-codes";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, listStages } from "../stages";
import { listDivisionFixturesForBoard, patchFixture } from "../fixtures";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createCourt, createVenue } from "../venues";
import { clearPoolEntrants, createCheckpoint, restoreCheckpoint, undoDivision } from "../history";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const en = (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars);

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
  ])("$name", async ({ n, kind, config, witnesses }) => {
    const { auth, divisionId, mainId, laterId } = await seedGeneratedStage(n, kind, config);
    const generated = await wholeRows("stage_id", mainId);
    expect(generated.length).toBeGreaterThan(0);
    expectWitnesses(generated, witnesses);

    await undoThenRestore(auth, divisionId, mainId, laterId);

    expect(await wholeRows("stage_id", mainId)).toEqual(generated);
  });

  it("the schedule board names the restored knockout exactly as it named the generated one (QF, SF, F, 3rd — never R{n})", async () => {
    const { auth, divisionId, mainId, laterId } = await seedGeneratedStage(8, "knockout", { thirdPlace: true });
    const codesOf = async () => {
      const [board, stages] = await Promise.all([
        listDivisionFixturesForBoard(auth, divisionId),
        listStages(auth, divisionId),
      ]);
      const codes = boardRoundCodes(board.filter((f) => f.stage_id === mainId), stages, en);
      return new Map([...codes].map(([id, c]) => [id, c.code]));
    };
    const generated = await codesOf();
    expect([...generated.values()].sort()).toEqual(["3rd", "F", "QF", "QF", "QF", "QF", "SF", "SF"]);

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

  it("a regeneration after the restore recognises every restored row by ext_key and creates nothing", async () => {
    const { auth, divisionId, mainId, laterId } = await seedGeneratedStage(8, "knockout", { thirdPlace: true });
    const generated = await wholeRows("stage_id", mainId);
    await undoThenRestore(auth, divisionId, mainId, laterId);

    const again = await generateStageFixtures(auth, mainId);
    expect(again).toMatchObject({ created: 0, existing: generated.length });
    expect(await wholeRows("stage_id", mainId)).toEqual(generated);
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
});
