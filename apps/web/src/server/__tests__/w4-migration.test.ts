// W4 app-A Task 3 (gap K2; engine row X-SD-5) — the delta that takes the slot off every bracket bye line placed before
// the deploy. Read by GLOB, never by number (it is renumbered at merge), and its OWN statement runs here, inside a
// rolled-back transaction on a dedicated client: it acts on the whole shared test DB, and a committed run would rewrite
// sibling suites' rows. Every assertion reads this test's own rows, so a sibling suite's rows cannot answer it.
//
// "Holds a slot" is the ONE predicate (`holdsSlot`, lib/rebuild-slots.ts): time, court, venue or pin. Which rows are bye
// lines is the shared shape table (lib/__tests__/bye-line-shapes.ts) — the same answers `isByeLine` and `byeLineSql`
// are held to, so the delta cannot drift from the predicate it spells out.
//
// single-sport: badminton — the delta reads seats, status, outcome, slot labels, ext_key and the slot columns; no
// sport field.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { connectionOptions, sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import { holdsSlot } from "@/lib/rebuild-slots";
import { BYE_LINE_SHAPES, rowOf } from "@/lib/__tests__/bye-line-shapes";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { createCourt, createVenue } from "@/server/usecases/venues";
import { seedOrg } from "@/server/usecases/__tests__/_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../db/migration/deltas");
const NAME = /^V\d+__w4_bracket_bye_lines_off_court\.sql$/;
const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
const text = files.length === 1 ? readFileSync(resolve(DELTAS, files[0]!), "utf8") : "";
/** The statements, comments removed: a `--` line naming a literal must not satisfy a check meant for the SQL. */
const code = text.replace(/--.*$/gm, "").trim();

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Tx = postgres.TransactionSql;
const ROLLBACK = new Error("rollback");

/** `body` on its own one-connection client inside a transaction that is always rolled back. */
async function rolledBack<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL!;
  const client = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: connectionOptions(url).schema } });
  let value: T | undefined;
  try {
    await expect(
      client.begin(async (tx) => {
        value = await body(tx);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  } finally {
    await client.end();
  }
  return value as T;
}

interface Slot {
  id: string;
  scheduled_at: Date | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
}

const slotOf = (r: Slot) => ({ at: r.scheduled_at, court: r.court_id, venue: r.venue_id, pin: r.schedule_locked });
const NONE = { at: null, court: null, venue: null, pin: false };

describe("W4 delta: the file", () => {
  it("exactly one delta carries the name, it is LOUD, quotes Task 0's count, and it is one UPDATE of fixtures", () => {
    expect(files, "one delta named *__w4_bracket_bye_lines_off_court.sql").toHaveLength(1);
    expect(text, "the header announces the data change").toMatch(/DATA CHANGE \(LOUD\)/);
    expect(text, "the header quotes the pre-flight count").toMatch(/stg 0 rows,\s*(--\s*)?prod 0 rows/);
    expect(code.split(";").filter((s) => s.trim() !== "").length, "one statement").toBe(1);
    expect(code).toMatch(/^update fixtures\b/);
  });
});

interface Rig {
  auth: AuthCtx;
  venueId: string;
  courtId: string;
  /** league_ko's day-one bracket: the pre-award bye line, and its real first-round line. */
  preAward: string;
  realLine: string;
  /** A plain knockout of three: the bye baked at generation, and its final (seed 1 seated, the other side TBD). */
  systemBye: string;
  final: string;
  entrants: [string, string];
}

/** Real producers for every row the delta is asked about: a `league_ko` Top 3 drawn day-one (its bye line pre-award)
 *  and a plain knockout of three (its bye a SYSTEM bye). */
async function rig(): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 delta " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = async (name: string, n: number) => {
    const d = await createDivision(auth, comp.id, { name, slug: "d-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
    const es = await createEntrants(
      auth,
      d.id,
      Array.from({ length: n }, (_, i) => ({ kind: "individual" as const, display_name: `${name} ${i + 1}`, seed: i + 1, members: [] })),
    );
    return { id: d.id, entrants: es.map((e) => e.id) };
  };
  const lk = await division("League KO", 4);
  const ids: string[] = [];
  for (const [i, d] of buildTemplateStages("league_ko", { swissRounds: 5, poolCount: 2, legs: 1, qualified: 3 }).entries()) {
    const [s] = await createStages(auth, lk.id, CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }));
    ids.push(s!.id);
  }
  await startDivision(auth, lk.id);
  await generateStageFixtures(auth, ids[1]!);
  const ko = await division("Cup", 3);
  const [cup] = await createStages(auth, ko.id, [{ seq: 1, kind: "knockout", name: "Cup", config: {} }]);
  await generateStageFixtures(auth, cup!.id);

  type R = { id: string; round_no: number; status: string; home_entrant_id: string | null; away_entrant_id: string | null; away_slot_label: unknown; home_slot_label: unknown };
  const read = (stageId: string) =>
    sql<R[]>`select id, round_no, status, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label
             from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
  const isBye = (l: unknown) => (l as { key?: unknown } | null)?.key === "bracket.slot.bye";
  const day1 = await read(ids[1]!);
  const preAward = day1.filter((r) => isBye(r.home_slot_label) || isBye(r.away_slot_label));
  expect(preAward.length, "rig: the day-one bracket has one bye line").toBe(1);
  const realLine = day1.find((r) => r.round_no === preAward[0]!.round_no && r.id !== preAward[0]!.id);
  const plain = await read(cup!.id);
  const systemBye = plain.filter((r) => r.status === "forfeited");
  expect(systemBye.length, "rig: the plain bracket baked one bye").toBe(1);
  const final = plain.find((r) => r.round_no > systemBye[0]!.round_no);
  expect([realLine, final].every(Boolean), "rig: a real first-round line and a final").toBe(true);

  const venue = await createVenue(auth, { name: "Hall", sort: 0 });
  const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
  return {
    auth,
    venueId: venue.id,
    courtId: court.id,
    preAward: preAward[0]!.id,
    realLine: realLine!.id,
    systemBye: systemBye[0]!.id,
    final: final!.id,
    entrants: [ko.entrants[0]!, ko.entrants[1]!],
  };
}

describe.runIf(HAS_DB)("W4 delta: bracket bye lines come off the court", () => {
  it("a placed pre-award bye line and a placed system bye lose every slot field; a real line and a withdrew walkover keep theirs; a second run changes nothing", async () => {
    const r = await rig();
    const mine = [r.preAward, r.systemBye, r.realLine, r.final];
    const verdict = await rolledBack(async (tx) => {
      // The pre-deploy state: the bye lines placed the two ways a writer did it (a full auto placement, and a pin alone),
      // the real line placed like them, and the final turned into a ruling-116 walkover (its winner's feeder withdrew:
      // her seat stays empty and dead, the award names her) holding a slot.
      await tx`
        update fixtures set scheduled_at = '2030-08-01T09:00:00Z', court_id = ${r.courtId}, venue_id = ${r.venueId}, schedule_locked = true
        where id in ${tx([r.preAward, r.realLine, r.final])}`;
      await tx`update fixtures set schedule_locked = true where id = ${r.systemBye}`;
      const [f] = await tx<{ home_entrant_id: string | null }[]>`select home_entrant_id from fixtures where id = ${r.final}`;
      const winner = f!.home_entrant_id ?? r.entrants[0];
      const loser = r.entrants.find((e) => e !== winner)!;
      await tx`
        update fixtures set status = 'forfeited', home_entrant_id = ${winner}, away_entrant_id = null,
          away_slot_label = ${tx.json({ key: "bracket.slot.bye", params: {} } as never)},
          outcome = ${tx.json({ kind: "award", winner, loser, reason: "withdrew" } as never)}
        where id = ${r.final}`;
      const read = () => tx<Slot[]>`select id, scheduled_at, court_id, venue_id, schedule_locked from fixtures where id in ${tx(mine)}`;
      const before = await read();
      const first = await tx.unsafe<{ id: string }[]>(code);
      const after = await read();
      const second = await tx.unsafe(code);
      const again = await read();
      return { before, firstCount: first.count, after, secondCount: second.count, again };
    });
    const by = (list: Slot[], id: string) => list.find((x) => x.id === id)!;

    expect(mine.map((id) => holdsSlot(by(verdict.before, id))), "premise: all four rows hold a slot before").toEqual([true, true, true, true]);
    expect(verdict.firstCount, "the first run changed at least this test's two bye lines").toBeGreaterThanOrEqual(2);
    expect(slotOf(by(verdict.after, r.preAward)), "the pre-award bye line is slotless").toEqual(NONE);
    expect(slotOf(by(verdict.after, r.systemBye)), "the system bye's pin is gone").toEqual(NONE);
    expect(by(verdict.after, r.realLine), "the real line is untouched").toEqual(by(verdict.before, r.realLine));
    expect(by(verdict.after, r.final), "the withdrew walkover keeps its slot (no bye line)").toEqual(by(verdict.before, r.final));
    expect(verdict.secondCount, "a second run changes 0 rows").toBe(0);
    expect(verdict.again, "… and moves nothing").toEqual(verdict.after);
  }, 120_000);

  it("clears a slot exactly on the rows the bye-line shape table calls bye lines, both ways", async () => {
    const r = await rig();
    const ids = { H: r.entrants[0], A: r.entrants[1] };
    const verdict = await rolledBack(async (tx) => {
      const out: { name: string; expected: boolean; cleared: boolean }[] = [];
      for (const shape of BYE_LINE_SHAPES) {
        const row = rowOf(shape, ids);
        await tx`
          update fixtures set ext_key = ${row.ext_key}, status = ${row.status},
            outcome = ${row.outcome === null ? null : tx.json(row.outcome as never)},
            home_entrant_id = ${row.home_entrant_id}, away_entrant_id = ${row.away_entrant_id},
            home_slot_label = ${row.home_slot_label === null ? null : tx.json(row.home_slot_label as never)},
            away_slot_label = ${row.away_slot_label === null ? null : tx.json(row.away_slot_label as never)},
            scheduled_at = '2030-08-01T09:00:00Z', court_id = ${r.courtId}, venue_id = ${r.venueId}, schedule_locked = true
          where id = ${r.final}`;
        await tx.unsafe(code);
        const [after] = await tx<Slot[]>`select id, scheduled_at, court_id, venue_id, schedule_locked from fixtures where id = ${r.final}`;
        out.push({ name: shape.name, expected: shape.expected, cleared: !holdsSlot(after!) });
      }
      return out;
    });
    let checked = 0;
    for (const v of verdict) {
      expect(v.cleared, v.name).toBe(v.expected);
      checked++;
    }
    // Anti-vacuity: the whole table, both answers represented.
    expect(checked, "shapes checked").toBe(BYE_LINE_SHAPES.length);
    expect(verdict.filter((v) => v.expected).length, "bye-line shapes").toBeGreaterThan(0);
    expect(verdict.filter((v) => !v.expected).length, "non-bye shapes").toBeGreaterThan(0);
  }, 120_000);
});
