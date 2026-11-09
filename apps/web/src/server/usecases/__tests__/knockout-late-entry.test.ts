// W4 app-A Task 10 (X-LE-3…X-LE-9, X-LE-12, X-LE-13; spec 2026-11-04 §4.1, ruling 263) — "Add late player" on a drawn
// root knockout, driven through the real organiser door (`createEntrants`) on a real database, asserting SEATS. Main
// refused every such add with the bare Start lock; Task 9 opened the list, and this places the player: case (1) the
// lowest-seeded holder's bye, case (2) a withdrawn entrant's seat with the walkover reversed, else (3) a named refusal.
//
// Expected values: the bye a newcomer takes is RB4-L4 over the STORED byes (`rb4L4ExpectedLine`, the one oracle —
// pre-flight C3/D8); every other expectation is the rulebook's case, its English (typed here, task-10-brief.md) or the
// rows as they stood before the add — never the code under test. Each placed line is then PLAYED through the real scorer,
// so the seam is proven through its consumer: the newcomer's win carries them into the next line.
//
// Sports: the case (1) and case (2) rows sweep badminton (a points sport) and chess (the boardgame module, individual
// only), each picked from the engine registry by key; the refusal, schedule, barrier and sequence rows run on badminton —
// they read seats, statuses and the ledger, which no sport field reaches.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { rb4L4ExpectedLine, type StoredByeLine } from "@/lib/__tests__/rb4-l4-oracle";
import type { AuthCtx } from "@/server/api-v1/auth";
import { ByeLineSurgeryError, reverseWithdrawnWalkover } from "../bracket-lines";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { listKnockoutWaiting } from "../knockout-desk";
import { placeWaitingKnockoutEntrant } from "../knockout-late-entry";
import { undoDivision } from "../history";
import { callFixtureToCourt } from "../match-day-call";
import { moveFixture, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, rebuildStageFixtures } from "../stages";
import { createCourt, createVenue } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The plan's sentences (task-10-brief.md), typed here: the refusal table is the code under test. */
const NO_SLOT = "Round 1 complete; no slot left.";
const NOT_UNDOABLE = "Adding a late player can't be undone. Withdraw the player instead.";

interface SportPick {
  key: string;
  variant: string;
}
/** A sport by key from the engine's registry, its first declared variant. */
function sport(key: string): SportPick {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no engine module ${key}`);
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error(`${key} declares no variant`);
  return { key, variant };
}
const BADMINTON = sport("badminton");
const CHESS = sport("boardgame");
const SPORTS = [BADMINTON, CHESS];

/** A played win for `winner` on `f`, through the scorer's own events (each sport's vocabulary). */
const PLAYED_WIN: Record<string, (auth: AuthCtx, f: Row, winner: string) => Promise<void>> = {
  boardgame: async (auth, f, winner) => post(auth, f.id, "boardgame.result", { winner, method: "resign" }),
  badminton: async (auth, f, winner) => {
    const home = winner === f.home_entrant_id;
    for (let g = 0; g < 2; g++) await post(auth, f.id, "badminton.game.summary", home ? { home: 21, away: 10 } : { home: 10, away: 21 });
  },
};

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

interface Row {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key?: string; params?: Record<string, unknown> } | null;
  away_slot_label: { key?: string; params?: Record<string, unknown> } | null;
  status: string;
  outcome: { kind?: string; reason?: string; winner?: string; loser?: string | null } | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  scheduled_at: Date | null;
  court_id: string | null;
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  sport: SportPick;
  ids: string[];
}

function player(name: string, seed: number | null) {
  return {
    kind: "individual" as const,
    display_name: name,
    seed,
    members: [{ new_person: { full_name: `${name} ${randomUUID().slice(0, 6)}` }, is_captain: false, roles: [] }],
  };
}

/** `n` players seeded 1..n (or `seeds`), one root knockout (`kind`), started. */
async function rig(opts: { n: number; sport?: SportPick; seeds?: (number | null)[]; kind?: "knockout" | "stepladder"; start?: boolean }): Promise<Rig> {
  const s = opts.sport ?? BADMINTON;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 T10 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: s.key,
    variant_key: s.variant,
    config: {},
  });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.n }, (_, i) => player(`P${i + 1}`, opts.seeds ? opts.seeds[i]! : i + 1)),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: opts.kind ?? "knockout", name: "KO", config: {}, progression: null });
  if (opts.start !== false) await startDivision(auth, division.id);
  return { auth, divisionId: division.id, stageId: stage!.id, sport: s, ids: made.map((e) => e.id) };
}

async function rowsOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, status, outcome,
           winner_to_fixture, winner_to_slot, scheduled_at, court_id
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

function storedByeLines(rows: readonly Row[]): StoredByeLine[] {
  return rows
    .filter((r) => r.round_no === 1 && r.outcome?.kind === "award" && r.outcome.reason === "bye" && r.outcome.winner)
    .map((r) => ({ lineId: r.id, holderId: r.outcome!.winner!, seq: r.seq_in_round }));
}

async function seedsOf(divisionId: string): Promise<Map<string, number | null>> {
  const rows = await sql<{ id: string; seed: number | null }[]>`select id, seed from entrants where division_id = ${divisionId}`;
  return new Map(rows.map((r) => [r.id, r.seed]));
}

async function entrantCount(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId}`;
  return n;
}

const shapeOf = (r: Row) =>
  JSON.stringify([r.home_entrant_id, r.away_entrant_id, r.status, r.outcome, r.home_slot_label, r.away_slot_label, r.scheduled_at, r.court_id]);

async function addLate(r: Rig, name = "Late") {
  const [late] = await createEntrants(r.auth, r.divisionId, [player(name, null)]);
  return late!;
}

/** The stage `entrantId` waits on (`entrants.knockout_waiting_stage_id`, the marker every automatic door writes), else null. */
async function waitingOn(entrantId: string): Promise<string | null> {
  const [e] = await sql<{ w: string | null }[]>`select knockout_waiting_stage_id as w from entrants where id = ${entrantId}`;
  return e!.w;
}

/** The stages any fixture seats `entrantId` in. */
async function seatedIn(entrantId: string): Promise<string[]> {
  const rows = await sql<{ stage_id: string }[]>`
    select distinct stage_id from fixtures where ${entrantId} in (home_entrant_id, away_entrant_id)`;
  return rows.map((x) => x.stage_id);
}

/** The division's `knockout_late_entry` ledger rows (an undo barrier each): a placement writes one, an offer writes none. */
async function barrierRows(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from division_events where division_id = ${divisionId} and type = 'knockout_late_entry'`;
  return n;
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the add is refused").toBeInstanceOf(HttpError);
  return err as HttpError;
}

/** X-LE-7: every seat the late entrant holds in the stage is a round-1 seat. Returns how many seats it holds. */
async function roundOneOnly(stageId: string, entrantId: string): Promise<number> {
  const seats = await sql<{ round_no: number }[]>`
    select round_no from fixtures where stage_id = ${stageId} and ${entrantId} in (home_entrant_id, away_entrant_id)`;
  for (const s of seats) expect(s.round_no, "X-LE-7: a late entrant is never seated beyond round 1").toBe(1);
  return seats.length;
}

/** Play `f` to a win for `winner`, from a start. */
async function win(r: Rig, f: Row, winner: string): Promise<void> {
  await post(r.auth, f.id, "core.start");
  await PLAYED_WIN[r.sport.key]!(r.auth, f, winner);
}

async function rowById(id: string): Promise<Row> {
  const [row] = await sql<Row[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, status, outcome,
           winner_to_fixture, winner_to_slot, scheduled_at, court_id
      from fixtures where id = ${id}`;
  return row!;
}

/** A seat of `next` holds `who`. */
const seatHolds = (next: Row, who: string) => next.home_entrant_id === who || next.away_entrant_id === who;

/** Courts for the division's schedule settings (`settingsCourts` of `courtCount`), and round 1's matches put at `at`. */
async function placeRoundOne(
  r: Rig,
  courtCount: number,
  settingsCourts: number,
  at = "2030-06-01T10:00:00.000Z",
): Promise<{ courts: string[]; at: string }> {
  const venue = await createVenue(r.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
  const courts: string[] = [];
  for (let i = 0; i < courtCount; i++) courts.push((await createCourt(r.auth, venue.id, { name: `Court ${i + 1}`, sort: i, tags: [] })).id);
  await sql`
    insert into schedule_settings (division_id, org_id, config)
    values (${r.divisionId}, ${r.auth.orgId}, ${sql.json({ courts: courts.slice(0, settingsCourts) } as never)})
    on conflict (division_id) do update set config = excluded.config`;
  const matches = (await rowsOf(r.stageId)).filter((f) => f.round_no === 1 && f.home_entrant_id && f.away_entrant_id && f.status === "scheduled");
  for (const [i, f] of matches.entries()) {
    await sql`update fixtures set scheduled_at = ${at}, court_id = ${courts[i]!}, venue_id = ${venue.id} where id = ${f.id}`;
  }
  return { courts, at };
}

describe.skipIf(!HAS_DB)("W4 T10: Add late player on a drawn knockout", () => {
  for (const s of SPORTS) {
    it(`X-LE-3/X-LE-4 case (1) [${s.key}]: the newcomer plays the lowest-seeded holder's bye; nothing else moves`, async () => {
      // Six seeded in a bracket of eight: seeds 1 and 2 hold byes. RB4-L4 names seed 2's (the lower seed) — and the
      // first bye in draw order is seed 1's, so the case tells "lowest-seeded" from "first".
      const r = await rig({ n: 6, sport: s });
      const before = await rowsOf(r.stageId);
      const stored = storedByeLines(before);
      expect(stored.length, "premise: six in eight hold two stored byes").toBe(2);
      const want = rb4L4ExpectedLine(stored, await seedsOf(r.divisionId), before.filter((x) => x.round_no === 1).length);
      const firstBye = [...stored].sort((a, b) => a.seq - b.seq)[0]!.lineId;
      expect(want, "premise: a differential case — the oracle is not the first bye").not.toBe(firstBye);
      const holder = stored.find((l) => l.lineId === want)!.holderId;
      const line0 = before.find((x) => x.id === want)!;

      const late = await addLate(r);
      expect(late.late_entry).toMatchObject({ format: "knockout", case: "bye", fixture_id: want, opponent_id: holder, stage_id: r.stageId });

      const after = await rowsOf(r.stageId);
      const line = after.find((x) => x.id === want)!;
      expect(new Set([line.home_entrant_id, line.away_entrant_id]), "the newcomer plays the holder").toEqual(new Set([holder, late.id]));
      expect({ status: line.status, outcome: line.outcome }).toEqual({ status: "scheduled", outcome: null });
      const next = after.find((x) => x.id === line0.winner_to_fixture)!;
      expect(seatHolds(next, holder), "the holder is taken back out of round 2").toBe(false);
      const waiting = line0.winner_to_slot === 1 ? next.home_slot_label : next.away_slot_label;
      expect(waiting, "the seat waits on the line's winner").toMatchObject({ key: "slot.winner_match" });
      let others = 0;
      for (const b of before) {
        if (b.id === want || b.id === next.id) continue;
        expect(shapeOf(after.find((x) => x.id === b.id)!), `line ${b.round_no}.${b.seq_in_round} unchanged`).toBe(shapeOf(b));
        others++;
      }
      expect(others, "every other line compared").toBe(before.length - 2);
      expect(await roundOneOnly(r.stageId, late.id)).toBe(1);

      // The seam through its consumer: the newcomer wins the line and the scorer carries them into the next one.
      await win(r, line, late.id);
      expect(seatHolds(await rowById(next.id), late.id), "the late winner advances").toBe(true);
    });

    it(`X-LE-5 case (2) [${s.key}]: after the withdrawal walked the line over, the walkover is reversed`, async () => {
      const r = await rig({ n: 8, sport: s });
      const before = await rowsOf(r.stageId);
      const line0 = before.find((x) => x.round_no === 1 && x.seq_in_round === 2)!;
      const gone = line0.home_entrant_id!;
      const opp = line0.away_entrant_id!;
      await withdrawEntrantCascade(r.auth, gone);
      const walked = await rowById(line0.id);
      expect(walked.outcome, "premise: the cascade walked the line over").toMatchObject({ kind: "award", reason: "withdrew", winner: opp });
      expect(seatHolds(await rowById(line0.winner_to_fixture!), opp), "premise: the walkover winner sits in round 2").toBe(true);

      const late = await addLate(r);
      expect(late.late_entry).toMatchObject({ format: "knockout", case: "withdrawn_slot", fixture_id: line0.id, opponent_id: opp });
      const line = await rowById(line0.id);
      expect({ home: line.home_entrant_id, away: line.away_entrant_id, status: line.status, outcome: line.outcome }).toEqual({
        home: late.id,
        away: opp,
        status: "scheduled",
        outcome: null,
      });
      const next = await rowById(line0.winner_to_fixture!);
      expect(seatHolds(next, opp), "the walkover winner is taken back out of round 2").toBe(false);
      const [{ live }] = await sql<{ live: number }[]>`
        select count(*)::int as live from score_events e
         where e.fixture_id = ${line0.id} and e.type <> 'core.void'
           and not exists (select 1 from score_events v where v.voids_event_id = e.id)`;
      expect(live, "the withdrawal's walkover is voided: nothing live on the line").toBe(0);
      expect(await roundOneOnly(r.stageId, late.id)).toBe(1);

      await win(r, line, late.id);
      expect(seatHolds(await rowById(next.id), late.id), "the late winner advances").toBe(true);
    });
  }

  it("X-LE-5 … the case closes once the walkover winner starts round 2", async () => {
    const r = await rig({ n: 8 });
    const before = await rowsOf(r.stageId);
    const l1 = before.find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
    const l2 = before.find((x) => x.round_no === 1 && x.seq_in_round === 2)!;
    expect(l1.winner_to_fixture, "premise: lines 1 and 2 feed one round-2 line").toBe(l2.winner_to_fixture);
    await withdrawEntrantCascade(r.auth, l1.home_entrant_id!);
    await win(r, l2, l2.home_entrant_id!);
    const r2 = await rowById(l1.winner_to_fixture!);
    expect(r2.home_entrant_id !== null && r2.away_entrant_id !== null, "premise: round 2 is seated").toBe(true);
    await post(r.auth, r2.id, "core.start");
    const count = await entrantCount(r.divisionId);
    const err = await refusal(addLate(r));
    expect(err).toMatchObject({ status: 409, code: "KO_LATE_ENTRY_NO_SLOT", message: NO_SLOT });
    expect(err.extra).toMatchObject({ can_rebuild: false });
    expect(await entrantCount(r.divisionId), "the refused add wrote nothing").toBe(count);
  });

  it("X-LE-6 / RB4-L6 round 1 complete, nothing started: the entrant is KEPT and waits; the answer is 201 rebuild_offered, nothing moves", async () => {
    // B6a fix round 1 (review #2): the organiser's own add was the one door that dropped the player (409, rolled back) while
    // every automatic door kept them. RB4-L6: "the refusal offers Rebuild" - the player stays, flagged exactly as an automatic
    // arrival, and Rebuild fixtures is the way in.
    const r = await rig({ n: 8 });
    const before = (await rowsOf(r.stageId)).map(shapeOf);
    const count = await entrantCount(r.divisionId);
    const barriers = await barrierRows(r.divisionId);
    const late = await addLate(r);
    expect(late.late_entry).toEqual({
      format: "knockout",
      entrant_id: late.id,
      stage_id: r.stageId,
      case: "rebuild_offered",
      reason: "KO_LATE_ENTRY_NO_SLOT",
    });
    expect(await entrantCount(r.divisionId), "the player is kept").toBe(count + 1);
    expect(await waitingOn(late.id), "flagged as every automatic door flags").toBe(r.stageId);
    expect((await rowsOf(r.stageId)).map(shapeOf), "no line moved").toEqual(before);
    expect(await seatedIn(late.id), "seated nowhere").toEqual([]);
    expect(await barrierRows(r.divisionId), "an offer places nobody: no undo barrier").toBe(barriers);
    expect((await listKnockoutWaiting(r.auth, r.divisionId)).map((w) => w.entrantId), "the desk's strip lists them").toEqual([late.id]);

    // The way in the offer names, through its real consumer: the tap offers it again, and Rebuild fixtures seats them.
    expect(await placeWaitingKnockoutEntrant(r.auth, r.stageId, late.id)).toMatchObject({ case: "rebuild_offered", reason: "KO_LATE_ENTRY_NO_SLOT" });
    await rebuildStageFixtures(r.auth, r.stageId);
    expect(await seatedIn(late.id), "Rebuild fixtures drew the field again with them in it").toEqual([r.stageId]);
    expect(await waitingOn(late.id), "the marker clears").toBeNull();
  });

  it("RB4-L6 the offer is made once per newcomer: a second add into the same full bracket is offered too, and both wait in arrival order", async () => {
    const r = await rig({ n: 8 });
    const a = await addLate(r, "Late A");
    const b = await addLate(r, "Late B");
    expect([a.late_entry, b.late_entry].map((x) => x?.format === "knockout" && x.case)).toEqual(["rebuild_offered", "rebuild_offered"]);
    expect((await listKnockoutWaiting(r.auth, r.divisionId)).map((w) => w.entrantId)).toEqual([a.id, b.id]);
  });

  it("X-LE-6/X-LE-9 with only a called match, the refusal offers no Rebuild", async () => {
    const r = await rig({ n: 8 });
    const { courts } = await placeRoundOne(r, 4, 4);
    const l1 = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
    await callFixtureToCourt(r.auth, l1.id, courts[0]!);
    const count = await entrantCount(r.divisionId);
    const err = await refusal(addLate(r));
    expect(err).toMatchObject({ status: 409, code: "KO_LATE_ENTRY_NO_SLOT" });
    expect(err.extra).toMatchObject({ can_rebuild: false });
    expect(await entrantCount(r.divisionId), "once a match has started the add is still refused and rolled back").toBe(count);
  });

  it("X-LE-7 a withdrawn bye holder's line is never case (2): nobody is seated (nothing started, so the offer is Rebuild)", async () => {
    // Seven in eight: seed 1 holds the one bye, and is carried into round 2. Seed 1 withdraws.
    const r = await rig({ n: 7 });
    const stored = storedByeLines(await rowsOf(r.stageId));
    expect(stored.length, "premise: one bye").toBe(1);
    await withdrawEntrantCascade(r.auth, stored[0]!.holderId);
    const lines = (await rowsOf(r.stageId)).map(shapeOf);
    const late = await addLate(r);
    expect(late.late_entry).toMatchObject({ case: "rebuild_offered", reason: "KO_LATE_ENTRY_NO_SLOT" });
    expect(await seatedIn(late.id), "never seated on the dead bye").toEqual([]);
    expect((await rowsOf(r.stageId)).map(shapeOf), "no line moved").toEqual(lines);
  });

  it("X-LE-9 a called round-2 match closes its bye to case (1)", async () => {
    // Six in eight: byes for seeds 1 and 2; RB4-L4 names seed 2's. Seed 2's round-2 match is seated (its other line
    // played) and called — so that bye is closed, and the newcomer takes the only open one: the oracle over it alone.
    const r = await rig({ n: 6 });
    const { courts } = await placeRoundOne(r, 4, 4);
    const rows = await rowsOf(r.stageId);
    const stored = storedByeLines(rows);
    const seeds = await seedsOf(r.divisionId);
    const round1 = rows.filter((x) => x.round_no === 1).length;
    const closed = rb4L4ExpectedLine(stored, seeds, round1)!;
    const closedLine = rows.find((x) => x.id === closed)!;
    const feeder = rows.find((x) => x.round_no === 1 && x.id !== closed && x.winner_to_fixture === closedLine.winner_to_fixture)!;
    await win(r, feeder, feeder.home_entrant_id!);
    const r2 = await rowById(closedLine.winner_to_fixture!);
    expect(r2.home_entrant_id !== null && r2.away_entrant_id !== null, "premise: the round-2 match is seated").toBe(true);
    await callFixtureToCourt(r.auth, r2.id, courts[3]!);
    const open = stored.filter((l) => l.lineId !== closed);
    const want = rb4L4ExpectedLine(open, seeds, round1);
    const late = await addLate(r);
    expect(late.late_entry).toMatchObject({ case: "bye", fixture_id: want });
    expect(want).not.toBe(closed);
  });

  it("X-LE-8 a legacy standalone stepladder takes case (2) only", async () => {
    // A standalone stepladder (no qualifying stage) is what the API made before X-SP-6's refusal (Task 16); created
    // here through the same createStages the API used. Its first rung is the two lowest seeds; the top seeds wait on
    // later rungs — never a bye a late player could take.
    const r = await rig({ n: 4, kind: "stepladder" });
    const rows = await rowsOf(r.stageId);
    const first = rows.filter((x) => x.round_no === 1);
    expect(first.length, "premise: one first rung").toBe(1);
    const none = await addLate(r, "Late 1");
    expect(none.late_entry, "no bye to take (X-LE-8): the offer is Rebuild").toMatchObject({ case: "rebuild_offered", reason: "KO_LATE_ENTRY_NO_SLOT" });
    expect(await seatedIn(none.id)).toEqual([]);
    await withdrawEntrantCascade(r.auth, first[0]!.home_entrant_id!);
    const late = await addLate(r, "Late 2");
    expect(late.late_entry).toMatchObject({ format: "knockout", case: "withdrawn_slot", fixture_id: first[0]!.id });
    expect(await roundOneOnly(r.stageId, late.id)).toBe(1);
    expect(await waitingOn(none.id), "the earlier newcomer still waits").toBe(r.stageId);
  });

  it("X-LE-12 the placed match takes round 1's next free slot", async () => {
    const r = await rig({ n: 6 });
    const { courts, at } = await placeRoundOne(r, 3, 3);
    const late = await addLate(r);
    expect(late.late_entry).toMatchObject({ case: "bye", scheduled: true });
    const line = await rowById(late.late_entry!.format === "knockout" ? late.late_entry!.fixture_id! : "");
    // Round 1's two matches hold courts 1 and 2 at `at`; the first free pair is court 3 at the same time.
    expect({ at: line.scheduled_at?.toISOString(), court: line.court_id }).toEqual({ at, court: courts[2] });
  });

  it("X-LE-12 no free slot: the new match is unscheduled (the desk's unscheduled flag)", async () => {
    const r = await rig({ n: 6 });
    await placeRoundOne(r, 2, 2);
    const late = await addLate(r);
    expect(late.late_entry).toMatchObject({ case: "bye", scheduled: false });
    const line = await rowById(late.late_entry!.format === "knockout" ? late.late_entry!.fixture_id! : "");
    expect({ at: line.scheduled_at, court: line.court_id, status: line.status }).toEqual({ at: null, court: null, status: "scheduled" });
  });

  it("X-LE-12 round 1's time has gone: the new match is left unscheduled, never put in the past", async () => {
    const r = await rig({ n: 6 });
    // Round 1 was set for a time already gone (it is under way); a free court remains at that time.
    await placeRoundOne(r, 3, 3, "2020-06-01T10:00:00.000Z");
    const late = await addLate(r);
    expect(late.late_entry).toMatchObject({ case: "bye", scheduled: false });
    const line = await rowById(late.late_entry!.format === "knockout" ? late.late_entry!.fixture_id! : "");
    expect({ at: line.scheduled_at, court: line.court_id }).toEqual({ at: null, court: null });
  });

  it("X-LE-12 case (2) keeps the withdrawn match's own slot while its time is still ahead; a gone time is cleared", async () => {
    let checked = 0;
    for (const [at, keeps] of [
      ["2030-06-01T10:00:00.000Z", true],
      ["2020-06-01T10:00:00.000Z", false],
    ] as const) {
      const r = await rig({ n: 8 });
      await placeRoundOne(r, 4, 4, at);
      const m = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.seq_in_round === 3)!;
      expect(m.court_id, "premise: the match holds a court").not.toBeNull();
      await withdrawEntrantCascade(r.auth, m.away_entrant_id!);
      const late = await addLate(r);
      expect(late.late_entry, at).toMatchObject({ case: "withdrawn_slot", fixture_id: m.id, scheduled: keeps });
      const line = await rowById(m.id);
      expect({ at: line.scheduled_at?.toISOString() ?? null, court: line.court_id }, at).toEqual(
        keeps ? { at, court: m.court_id } : { at: null, court: null },
      );
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the reversal surgery refuses by name: a round-2 line, a bye, a seat not departed, a line played before the withdrawal", async () => {
    // The decision never hands these over (its own table proves it); the surgery is the last guard on the write, so each
    // refusal is driven here directly, under the tenant, as the door's transaction would.
    const r = await rig({ n: 7 });
    const rows = await rowsOf(r.stageId);
    const r2 = rows.find((x) => x.round_no === 2)!;
    const [byeLine] = storedByeLines(rows);
    const matches = rows.filter((x) => x.round_no === 1 && x.home_entrant_id && x.away_entrant_id && x.status === "scheduled");
    const [m1, m2] = matches;
    // m2 was started, then its home player left (status only: no cascade wrote over it).
    await post(r.auth, m2!.id, "core.start");
    await sql`update entrants set status = 'withdrawn' where id = ${m2!.home_entrant_id}`;
    const [late] = await sql<{ id: string }[]>`
      insert into entrants (division_id, kind, display_name) values (${r.divisionId}, 'individual', 'Probe') returning id`;
    const cases: [string, string, "home" | "away", RegExp][] = [
      ["round 2", r2.id, "home", /round 2/],
      ["bye", byeLine!.lineId, "away", /bye/],
      ["not departed", m1!.id, "home", /holds no departed entrant/],
      ["played", m2!.id, "home", /was played/],
    ];
    let checked = 0;
    for (const [name, lineId, seat, why] of cases) {
      const err = await withTenant(r.auth.orgId, (tx) => reverseWithdrawnWalkover(tx, r.auth.orgId, lineId, late!.id, seat, r.auth.userId)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, name).toBeInstanceOf(ByeLineSurgeryError);
      expect((err as Error).message, name).toMatch(why);
      checked++;
    }
    expect(checked).toBe(4);
    expect(await rowById(m2!.id), "the refused surgery wrote nothing").toMatchObject({ home_entrant_id: m2!.home_entrant_id, status: "in_play" });
  });

  it("X-LE-13 Undo after Add late player refuses and points to Withdraw", async () => {
    const r = await rig({ n: 6 });
    await addLate(r);
    const err = await refusal(undoDivision(r.auth, r.divisionId));
    expect(err).toMatchObject({ status: 409, code: "KO_LATE_ENTRY_NOT_UNDOABLE", message: NOT_UNDOABLE });
    const [row] = await sql<{ type: string; payload: Record<string, unknown> }[]>`
      select type, payload from division_events where division_id = ${r.divisionId} order by seq desc limit 1`;
    expect(row).toMatchObject({ type: "knockout_late_entry", payload: { case: "bye", source: "organiser" } });
  });

  it("X-LE-3 sequence: the late entrant withdraws — the line walks over to the former holder, back in round 2", async () => {
    const r = await rig({ n: 7 });
    const [bye] = storedByeLines(await rowsOf(r.stageId));
    const late = await addLate(r);
    expect(late.late_entry).toMatchObject({ case: "bye", fixture_id: bye!.lineId });
    await withdrawEntrantCascade(r.auth, late.id);
    const line = await rowById(bye!.lineId);
    expect(line.outcome).toMatchObject({ kind: "award", reason: "withdrew", winner: bye!.holderId });
    expect(seatHolds(await rowById(line.winner_to_fixture!), bye!.holderId), "the holder is back in round 2").toBe(true);
  });

  it("sequence: a second late player after the first took the only bye - offered Rebuild (nothing started), kept waiting", async () => {
    const r = await rig({ n: 7 });
    const first = await addLate(r, "Late 1");
    expect(first.late_entry).toMatchObject({ case: "bye" });
    const second = await addLate(r, "Late 2");
    expect(second.late_entry).toMatchObject({ case: "rebuild_offered", reason: "KO_LATE_ENTRY_NO_SLOT" });
    expect(await waitingOn(second.id)).toBe(r.stageId);
    expect(await waitingOn(first.id), "the one who was seated waits for nothing").toBeNull();
  });

  it("sequence: the offered newcomer's seat opens (a withdrawal) - the organiser's one tap seats them and the marker clears", async () => {
    const r = await rig({ n: 8 });
    const late = await addLate(r);
    expect(late.late_entry).toMatchObject({ case: "rebuild_offered" });
    const line = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.seq_in_round === 2)!;
    await withdrawEntrantCascade(r.auth, line.home_entrant_id!);
    const placed = await placeWaitingKnockoutEntrant(r.auth, r.stageId, late.id);
    expect(placed).toMatchObject({ case: "withdrawn_slot", fixture_id: line.id, entrant_id: late.id });
    expect(await seatedIn(late.id)).toEqual([r.stageId]);
    expect(await waitingOn(late.id)).toBeNull();
  });

  it("sequence: a second late player after a withdrawal takes the withdrawn slot once the bye is gone", async () => {
    const r = await rig({ n: 7 });
    const rows = await rowsOf(r.stageId);
    const first = await addLate(r, "Late 1");
    expect(first.late_entry).toMatchObject({ case: "bye" });
    const match = rows.find((x) => x.round_no === 1 && x.home_entrant_id && x.away_entrant_id && x.status === "scheduled")!;
    await withdrawEntrantCascade(r.auth, match.away_entrant_id!);
    const second = await addLate(r, "Late 2");
    expect(second.late_entry).toMatchObject({ case: "withdrawn_slot", fixture_id: match.id, opponent_id: match.home_entrant_id });
  });

  it("sequence: a late player after an Undo of an unrelated schedule edit is placed", async () => {
    const r = await rig({ n: 6 });
    const { courts } = await placeRoundOne(r, 3, 3);
    const match = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.court_id !== null)!;
    await moveFixture(r.auth, match.id, { scheduled_at: "2030-06-01T12:00:00.000Z", court_id: courts[2]! });
    await undoDivision(r.auth, r.divisionId);
    expect((await rowById(match.id)).scheduled_at?.toISOString(), "premise: the move was undone").toBe("2030-06-01T10:00:00.000Z");
    const late = await addLate(r);
    expect(late.late_entry).toMatchObject({ case: "bye" });
  });
});
