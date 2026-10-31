// W3 Task 5 (SW-M2 / #835, RB3-22, design §10.8; rule X-SW-28): Undo of Pair next clears the seats when no board of the
// round has a result, and refuses by name when one has; an organiser's "Add late player" and a change to the round
// count are undo barriers.
//
// The defect: a Pair next seats a Swiss round by UPDATING shells that already exist, so its `fixtures_generated` ledger
// row lists no `fixture_ids` (the Undo DELETE list) and carries the seated rows in `seated_fixture_ids`, which no undo
// path read. The engine inverts that row to a `fixtures_cleared` over nothing, so Undo "worked" and every player stayed
// seated. The app now reads the inverted row out of its own ledger (`__undo_of`) and clears those seats.
//
// Every DB case runs for badminton AND chess (boardgame) through the same body; expected values are read from the
// rulebook's own sources — the engine's resolver for the bye's frozen cfg, the plan's interface table for the barrier
// codes — never from the history code under test. Seats are the assertion, never a shell count (brief trap 2).
import { afterAll, describe, expect, it, vi } from "vitest";

// Review m3 (W3 T5 fix round 1): the Undo's post-commit table refold made to throw on demand. Off by default, so every
// other case folds for real; the same importOriginal pass-through generate-refold-best-effort.test.ts uses.
const refold = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("@/server/engine-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/engine-db")>();
  return {
    ...actual,
    recomputeStandings: async (...args: Parameters<typeof actual.recomputeStandings>) => {
      refold.calls++;
      if (refold.fail) throw new Error("test: a rank-time refusal");
      return actual.recomputeStandings(...args);
    },
  };
});
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { log } from "@/server/logger";
import { canonicalJson } from "@/lib/canonical-json";
import { SWISS_REFUSALS, type SwissRefusalCode } from "@/lib/swiss-refusals";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import type { LedgerEvent } from "@seazn/engine/history";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEventInTx } from "@/server/engine-db/append-event";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { resolveModule } from "@/server/engine-db/registry";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant } from "../entrants";
import {
  UNDO_BARRIER_TYPES,
  createCheckpoint,
  invertedStepSeq,
  redoDivision,
  restoreCheckpoint,
  undoBarrierRefusal,
  undoDivision,
} from "../history";
import { moveFixture, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { putStageRules } from "../stage-rules";
import { createStages, generateStageFixtures, unpairSwissRound } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";
import { movingFragment } from "./_stage-probe";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** The plan's interface table (Task 5 "Produces"), typed here as the oracle — never read back from history.ts. */
const PLAN_BARRIERS = {
  swiss_late_entry: "SWISS_LATE_ENTRY_NOT_UNDOABLE",
  swiss_rounds_changed: "SWISS_ROUNDS_CHANGE_NOT_UNDOABLE",
} as const;

/** The refusal a test expects, with the status the refusal table declares for it. */
const refusal = (code: SwissRefusalCode) => ({ status: SWISS_REFUSALS[code].status, code });

// ---------------------------------------------------------------------------------------------------------------------
// The barrier rule, on literal ledgers (no DB).
// ---------------------------------------------------------------------------------------------------------------------

describe("undoBarrierRefusal — the undo barriers on a literal ledger (design §10.8)", () => {
  const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): LedgerEvent => ({ seq, type, payload });
  const pair = (seq: number) => ev(seq, "fixtures_generated", { stage_id: "s", fixture_ids: [], seated_fixture_ids: ["f"] });
  const late = (seq: number, source: unknown) =>
    ev(seq, "swiss_late_entry", { stage_id: "s", entrant_id: "e", case: "c", round: 2, source });
  const rounds = (seq: number, via: string) => ev(seq, "swiss_rounds_changed", { stage_id: "s", from: 3, to: 4, via });

  it("UNDO_BARRIER_TYPES is the plan's table, code for code", () => {
    expect(UNDO_BARRIER_TYPES).toEqual(PLAN_BARRIERS);
  });

  it("an empty ledger, and a ledger of reversible edits only, has no barrier", () => {
    expect(undoBarrierRefusal([], 0)).toBeNull();
    const plain = [pair(1), ev(2, "schedule_applied", { moves: [] }), ev(3, "schedule_edited", {}), ev(4, "division_started")];
    expect(undoBarrierRefusal(plain, 1)).toBeNull();
  });

  it("an organiser's late entry after the target is a barrier; an automatic arrival is not (ruling 252 item 11)", () => {
    expect(undoBarrierRefusal([pair(1), late(2, "organiser")], 1)).toBe(PLAN_BARRIERS.swiss_late_entry);
    let checked = 0;
    for (const source of ["registration", "waitlist", "import", undefined, null, "Organiser"]) {
      expect(undoBarrierRefusal([pair(1), late(2, source)], 1), `source ${String(source)}`).toBeNull();
      checked++;
    }
    expect(checked, "anti-vacuity: every non-organiser source was judged").toBe(6);
  });

  it("every round-count change after the target is a barrier, whatever made it", () => {
    let checked = 0;
    for (const via of ["edit", "add_round", "finish"]) {
      expect(undoBarrierRefusal([pair(1), rounds(2, via)], 1), `via ${via}`).toBe(PLAN_BARRIERS.swiss_rounds_changed);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("only a barrier AFTER the target counts: one at or before it is history the step does not cross", () => {
    const ledger = [late(1, "organiser"), rounds(2, "edit"), pair(3)];
    expect(undoBarrierRefusal(ledger, 3), "both barriers precede the target").toBeNull();
    expect(undoBarrierRefusal([pair(1), late(2, "organiser")], 2), "a barrier AT the target seq").toBeNull();
    expect(undoBarrierRefusal(ledger, 1), "the target precedes the round change").toBe(PLAN_BARRIERS.swiss_rounds_changed);
  });

  it("names the NEWEST barrier past the target, in whatever order the ledger arrives", () => {
    const a = [pair(1), late(2, "organiser"), rounds(3, "finish")];
    const b = [pair(1), rounds(2, "finish"), late(3, "organiser")];
    expect(undoBarrierRefusal(a, 1)).toBe(PLAN_BARRIERS.swiss_rounds_changed);
    expect(undoBarrierRefusal([...a].reverse(), 1)).toBe(PLAN_BARRIERS.swiss_rounds_changed);
    expect(undoBarrierRefusal(b, 1)).toBe(PLAN_BARRIERS.swiss_late_entry);
    // An automatic arrival newer than an organiser's is no barrier, so the organiser's still names the refusal.
    expect(undoBarrierRefusal([pair(1), late(2, "organiser"), late(3, "registration")], 1)).toBe(
      PLAN_BARRIERS.swiss_late_entry,
    );
  });
});

describe("invertedStepSeq — the ledger row an Undo or Redo steps over", () => {
  it("reads __undo_of for an Undo and __redo_of for a Redo", () => {
    expect(invertedStepSeq("undo", { __undo_of: 7 })).toBe(7);
    expect(invertedStepSeq("redo", { __redo_of: 9 })).toBe(9);
  });

  it("refuses by name a step the engine did not stamp — never a barrier check skipped on an absence", () => {
    // The engine stamps every inverse and every redo copy (history.js `undo`/`redo`); a step without the stamp is a
    // broken contract, and checking no barrier against it would let an Undo cross one.
    expect(() => invertedStepSeq("undo", {})).toThrow(/history step names no ledger row/);
    expect(() => invertedStepSeq("redo", { __undo_of: 3 })).toThrow(/history step names no ledger row/);
    expect(() => invertedStepSeq("undo", { __undo_of: "3" })).toThrow(/history step names no ledger row/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The product path, through Postgres.
// ---------------------------------------------------------------------------------------------------------------------

/** The two sports the plan names: a set sport and chess (whose Swiss pairs colours). */
const SPORTS = [
  { sport: "badminton", variant: "bwf" },
  { sport: "boardgame", variant: "classical" },
] as const;
type Sport = (typeof SPORTS)[number];

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  /** Entrant ids by seed order, P1..Pn. */
  entrants: string[];
  name: (id: string | null) => string;
}

/** N seeded players, a Swiss of `rounds`, and the shells minted. `start` mints them through Start (the division goes
 *  active and can be scored); otherwise one Generate press mints them and the division stays in setup. */
async function swissRig(sport: Sport, n: number, rounds: number, start: boolean): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Undo pair " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.sport,
    variant_key: sport.variant,
    config: {},
  });
  const kind = mod(sport.sport).entrantModel?.defaultKind ?? "individual";
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds },
    progression: null,
  });
  if (start) await startDivision(auth, division.id);
  else await generateStageFixtures(auth, stage!.id);
  const nameOf = new Map(made.map((e) => [e.id, e.display_name]));
  return {
    sport,
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    entrants: made.map((e) => e.id),
    name: (id) => (id === null ? "-" : (nameOf.get(id) ?? "?")),
  };
}

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string; reason?: string } | null;
  config_snapshot: unknown;
  config_snapshot_at: Date | null;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, home_entrant_id, away_entrant_id, status, outcome, config_snapshot, config_snapshot_at
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const roundOf = (rows: readonly Row[], r: number) => rows.filter((f) => f.round_no === r);
const isBye = (f: Row) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");

/** Who sits where in a round, by name: "P1 v P5" per board, "P3 bye" for the bye row; sorted. */
const pairingOf = (rig: Rig, rows: readonly Row[]) =>
  rows
    .map((f) =>
      isBye(f) ? `${rig.name(f.home_entrant_id)} bye` : `${rig.name(f.home_entrant_id)} v ${rig.name(f.away_entrant_id)}`,
    )
    .sort();

/** Everything a clear would change on a row. */
const seatState = (rows: readonly Row[]) =>
  rows.map((f) => ({
    id: f.id,
    home: f.home_entrant_id,
    away: f.away_entrant_id,
    status: f.status,
    outcome: f.outcome,
    snapshot: f.config_snapshot,
  }));

function expectRoundSeated(rows: readonly Row[], what: string): void {
  expect(rows.length, `${what}: the round has rows`).toBeGreaterThan(0);
  for (const f of rows) {
    expect(f.home_entrant_id !== null && (isBye(f) || f.away_entrant_id !== null), `${what}: ${f.ext_key} is seated`).toBe(
      true,
    );
  }
}

function expectRoundCleared(rows: readonly Row[], what: string): void {
  expect(rows.length, `${what}: anti-vacuity, the round has rows`).toBeGreaterThan(0);
  for (const f of rows) {
    expect(
      { home: f.home_entrant_id, away: f.away_entrant_id, status: f.status, outcome: f.outcome, snapshot: f.config_snapshot },
      `${what}: ${f.ext_key} is back on its shell`,
    ).toEqual({ home: null, away: null, status: "scheduled", outcome: null, snapshot: null });
  }
}

/** The ledger's length and the division's own token and watermark: what a refused step must leave alone. */
async function ledgerState(divisionId: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${divisionId}`;
  const [d] = await sql<{ seq: string | number; edit_watermark: string | number | null }[]>`
    select seq, edit_watermark from divisions where id = ${divisionId}`;
  return { events: n, seq: Number(d!.seq), watermark: d!.edit_watermark === null ? null : Number(d!.edit_watermark) };
}

/** Append a ledger row by hand, as a writer that a later task owns will (T9 `swiss_late_entry`, T12/T13
 *  `swiss_rounds_changed`). The division's token moves with it; the watermark is left where it stands. */
async function appendLedgerRow(divisionId: string, type: string, payload: Record<string, unknown>): Promise<number> {
  const [{ seq }] = await sql<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int + 1 as seq from division_events where division_id = ${divisionId}`;
  await sql`insert into division_events (division_id, seq, type, payload) values (${divisionId}, ${seq}, ${type}, ${sql.json(payload as never)})`;
  await sql`update divisions set seq = ${seq} where id = ${divisionId}`;
  return seq;
}

/** The scorer's quick result: the home side wins. Real events through the scoring use-case. */
async function homeWins(rig: Rig, f: Row): Promise<void> {
  await scoreEvent(rig.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
  if (rig.sport.sport === "boardgame") {
    await scoreEvent(rig.auth, f.id, {
      expected_seq: 1,
      type: "boardgame.result",
      payload: { winner: f.home_entrant_id, method: "resign" },
    });
  } else {
    await scoreEvent(rig.auth, f.id, { expected_seq: 1, type: "badminton.game.summary", payload: { home: 21, away: 10 } });
    await scoreEvent(rig.auth, f.id, { expected_seq: 2, type: "badminton.game.summary", payload: { home: 21, away: 12 } });
  }
}

async function playRound(rig: Rig, r: number): Promise<void> {
  const boards = roundOf(await rowsOf(rig.stageId), r).filter((f) => !isBye(f));
  expect(boards.length, `rig: round ${r} has boards to play`).toBeGreaterThan(0);
  for (const f of boards) await homeWins(rig, f);
  const decided = roundOf(await rowsOf(rig.stageId), r).filter((f) => !isBye(f));
  expect(decided.map((f) => f.status), `rig: round ${r} is decided`).toEqual(decided.map(() => "decided"));
}

/** What a fixture of this stage with no snapshot and no override resolves to NOW — the cfg append-event.ts freezes at a
 *  first event, and the one the Swiss bye seat freezes at award (W3 T3). */
async function liveCfgOf(rig: Rig): Promise<unknown> {
  const [d] = await sql<{ config: unknown; sport_key: string; module_version: string }[]>`
    select config, sport_key, module_version from divisions where id = ${rig.divisionId}`;
  const [s] = await sql<{ kind: string; config: Record<string, unknown> | null }[]>`
    select kind, config from stages where id = ${rig.stageId}`;
  return resolveFixtureCfg(
    { config_snapshot: null, rules_override: null },
    d!.config,
    { kind: s!.kind, config: s!.config },
    resolveModule(d!.sport_key, d!.module_version),
  );
}

for (const s of SPORTS) {
  describe.runIf(HAS_DB)(`W3 T5 Undo of Pair next (${s.sport})`, () => {
    it(`X-SW-28 a started board refuses SWISS_UNDO_ROUND_STARTED and clears nothing (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 2, true);
      await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
      const paired = await rowsOf(rig.stageId);
      expectRoundSeated(roundOf(paired, 1), "premise");
      const board = roundOf(paired, 1).find((f) => !isBye(f))!;
      await scoreEvent(rig.auth, board.id, { expected_seq: 0, type: "core.start", payload: {} });
      const started = await rowsOf(rig.stageId);
      const before = await ledgerState(rig.divisionId);

      await expect(undoDivision(rig.auth, rig.divisionId)).rejects.toMatchObject(refusal("SWISS_UNDO_ROUND_STARTED"));

      expect(seatState(await rowsOf(rig.stageId)), "a refused Undo clears nothing").toEqual(seatState(started));
      expect(await ledgerState(rig.divisionId), "a refused Undo appends nothing and keeps the watermark").toEqual(before);
    }, 120_000);

    it(`X-SW-28 a start taken back (core.void) still refuses SWISS_UNDO_ROUND_STARTED (${s.sport})`, async () => {
      // The expected answer is `fixtureHasResultSql`'s documented meaning, not this code path: "anything recorded at
      // all (`fixtureEvidenceSql` — a start taken back leaves `scheduled` behind, and its events)". A voided start
      // walks the STATUS back to scheduled; its events stay, so the board still holds a result and the round its seats.
      const rig = await swissRig(s, 5, 2, true);
      await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
      const board = roundOf(await rowsOf(rig.stageId), 1).find((f) => !isBye(f))!;
      await scoreEvent(rig.auth, board.id, { expected_seq: 0, type: "core.start", payload: {} });
      const [start] = await sql<{ id: string }[]>`
        select id from score_events where fixture_id = ${board.id} and type = 'core.start'`;
      await scoreEvent(rig.auth, board.id, { expected_seq: 1, type: "core.void", payload: { event_id: start!.id } });
      const voided = await rowsOf(rig.stageId);
      expect(voided.find((f) => f.id === board.id)!.status, "premise: the void walked the status back").toBe("scheduled");
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${board.id}`;
      expect(n, "premise: the start and its void stay on the ledger").toBe(2);
      const before = await ledgerState(rig.divisionId);

      await expect(undoDivision(rig.auth, rig.divisionId)).rejects.toMatchObject(refusal("SWISS_UNDO_ROUND_STARTED"));
      expect(seatState(await rowsOf(rig.stageId)), "a refused Undo clears nothing").toEqual(seatState(voided));
      expect(await ledgerState(rig.divisionId)).toEqual(before);
    }, 120_000);

    it(`X-SW-28 Redo after Undo seats round 1 again (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 2, false); // pre-Start: the stage's format is still the organiser's
      await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
      const first = roundOf(await rowsOf(rig.stageId), 1);
      expectRoundSeated(first, "premise");
      const firstPairing = pairingOf(rig, first);
      const byeAtPair = first.find(isBye)!.config_snapshot;
      expect(byeAtPair, "premise: the bye froze its cfg at Pair (W3 T3)").not.toBeNull();

      await undoDivision(rig.auth, rig.divisionId);
      expectRoundCleared(roundOf(await rowsOf(rig.stageId), 1), "after Undo");

      // The stage's format moves between the Undo and the Redo, so the cfg a Redo freezes is told apart from the one
      // Pair froze — a Redo that put the old snapshot back, or none, is red.
      const pick = movingFragment(mod(s.sport), s.variant, "swiss");
      expect(pick, `premise: a ${s.sport} swiss stage has a rule it can move`).not.toBeNull();
      await putStageRules(rig.auth, rig.stageId, { rules: pick!.frag });
      const atRedo = await liveCfgOf(rig);
      expect(canonicalJson(atRedo), "witness: the save moved what a fresh award resolves").not.toBe(canonicalJson(byeAtPair));

      const redone = await redoDivision(rig.auth, rig.divisionId);
      expect(redone.applied.type).toBe("fixtures_generated");
      const again = roundOf(await rowsOf(rig.stageId), 1);
      expectRoundSeated(again, "after Redo");
      expect(pairingOf(rig, again), "Redo seats the same pairing (the draw is deterministic)").toEqual(firstPairing);
      const bye = again.find(isBye)!;
      expect(bye.config_snapshot, "the bye is frozen again at Redo").not.toBeNull();
      expect(bye.config_snapshot, "...with the stage cfg that stands at Redo, under the division lock").toEqual(atRedo);
      expect(bye.config_snapshot_at, "...and stamped when").not.toBeNull();
    }, 120_000);

    it(`X-SW-28 Undo walks back round 2, then refuses round 1 by name once it is played (${s.sport})`, async () => {
      // Premise found (brief: "Undo walks back round 2 then round 1, seats cleared each time"): round 2 can only be
      // paired once every round-1 board is decided, and a decided board holds a result — so the walk back clears round
      // 2 and then REFUSES round 1 (spec §6.2: "otherwise a named refusal"). Both steps are asserted.
      const rig = await swissRig(s, 5, 2, true);
      await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
      await playRound(rig, 1);
      await generateStageFixtures(rig.auth, rig.stageId); // Pair round 2
      const paired = await rowsOf(rig.stageId);
      expectRoundSeated(roundOf(paired, 2), "premise: round 2");
      const round1 = seatState(roundOf(paired, 1));

      const undone = await undoDivision(rig.auth, rig.divisionId);
      expect(undone.applied.type).toBe("fixtures_cleared");
      const afterFirst = await rowsOf(rig.stageId);
      expectRoundCleared(roundOf(afterFirst, 2), "the first Undo");
      expect(seatState(roundOf(afterFirst, 1)), "the first Undo leaves round 1 as played").toEqual(round1);

      const before = await ledgerState(rig.divisionId);
      await expect(undoDivision(rig.auth, rig.divisionId), "the second Undo reaches round 1's Pair").rejects.toMatchObject(
        refusal("SWISS_UNDO_ROUND_STARTED"),
      );
      const afterSecond = await rowsOf(rig.stageId);
      expect(seatState(roundOf(afterSecond, 1)), "round 1 keeps its seats and results").toEqual(round1);
      expectRoundCleared(roundOf(afterSecond, 2), "round 2 stays cleared");
      expect(await ledgerState(rig.divisionId)).toEqual(before);
    }, 120_000);

    it(`X-SW-28 Undo after a withdrawal re-pairs nobody until Pair next (${s.sport})`, async () => {
      const rig = await swissRig(s, 6, 3, true);
      await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
      await playRound(rig, 1);
      const leaver = rig.entrants[5]!;
      await withdrawEntrantCascade(rig.auth, leaver); // round 1 is decided: nothing to walk over
      await generateStageFixtures(rig.auth, rig.stageId); // Pair round 2 over the five left
      const r2 = roundOf(await rowsOf(rig.stageId), 2);
      expectRoundSeated(r2, "premise: round 2");
      const seated2 = r2.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((id): id is string => id !== null);
      expect(seated2.sort(), "premise: round 2 seats the five left, once each").toEqual(
        rig.entrants.filter((id) => id !== leaver).sort(),
      );
      const round1 = seatState(roundOf(await rowsOf(rig.stageId), 1));

      await undoDivision(rig.auth, rig.divisionId);
      const after = await rowsOf(rig.stageId);
      // Nobody is re-paired by the Undo itself: round 2 is back on its shells, the leaver nowhere, round 1 as played.
      expectRoundCleared(roundOf(after, 2), "Undo after a withdrawal");
      expect(seatState(roundOf(after, 1))).toEqual(round1);

      await generateStageFixtures(rig.auth, rig.stageId); // Pair next
      const repaired = roundOf(await rowsOf(rig.stageId), 2);
      expectRoundSeated(repaired, "Pair next");
      const seatedAgain = repaired
        .flatMap((f) => [f.home_entrant_id, f.away_entrant_id])
        .filter((id): id is string => id !== null);
      expect(seatedAgain.sort(), "Pair next seats the five left, never the leaver").toEqual(seated2.sort());
    }, 180_000);

    it(`X-SW-28 an organiser swiss_late_entry is a barrier; an automatic one is not (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 2, false);
      const lateEntry = (source: string) => ({
        stage_id: rig.stageId,
        entrant_id: rig.entrants[0],
        case: "c",
        round: 2,
        source,
      });
      // An automatic arrival (a paid registration) changes nothing about Undo (ruling 252 item 11).
      await generateStageFixtures(rig.auth, rig.stageId);
      await appendLedgerRow(rig.divisionId, "swiss_late_entry", lateEntry("registration"));
      await expect(undoDivision(rig.auth, rig.divisionId), "an automatic arrival is no barrier").resolves.toMatchObject({
        applied: { type: "fixtures_cleared" },
      });
      expectRoundCleared(roundOf(await rowsOf(rig.stageId), 1), "Undo past an automatic arrival");

      // An organiser's "Add late player" is (design §10.8, ruling 252 item 8): Undo refuses by name and clears nothing.
      await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1 again
      await appendLedgerRow(rig.divisionId, "swiss_late_entry", lateEntry("organiser"));
      const seated = await rowsOf(rig.stageId);
      expectRoundSeated(roundOf(seated, 1), "premise");
      const before = await ledgerState(rig.divisionId);
      await expect(undoDivision(rig.auth, rig.divisionId)).rejects.toMatchObject(refusal("SWISS_LATE_ENTRY_NOT_UNDOABLE"));
      expect(seatState(await rowsOf(rig.stageId))).toEqual(seatState(seated));
      expect(await ledgerState(rig.divisionId)).toEqual(before);

      // A round-count change on top: the newest barrier names the refusal.
      await appendLedgerRow(rig.divisionId, "swiss_rounds_changed", { stage_id: rig.stageId, from: 2, to: 3, via: "edit" });
      await expect(undoDivision(rig.auth, rig.divisionId)).rejects.toMatchObject(refusal("SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"));
      expect(seatState(await rowsOf(rig.stageId))).toEqual(seatState(seated));
    }, 120_000);

    it(`X-SW-28 a barrier refuses the Redo across it too, re-pairing nobody (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 2, false);
      await generateStageFixtures(rig.auth, rig.stageId);
      await undoDivision(rig.auth, rig.divisionId);
      expectRoundCleared(roundOf(await rowsOf(rig.stageId), 1), "premise: Undo cleared round 1");
      await appendLedgerRow(rig.divisionId, "swiss_late_entry", {
        stage_id: rig.stageId,
        entrant_id: rig.entrants[0],
        case: "c",
        round: 1,
        source: "organiser",
      });
      const before = await ledgerState(rig.divisionId);
      await expect(redoDivision(rig.auth, rig.divisionId)).rejects.toMatchObject(refusal("SWISS_LATE_ENTRY_NOT_UNDOABLE"));
      expectRoundCleared(roundOf(await rowsOf(rig.stageId), 1), "a refused Redo re-pairs nobody");
      expect(await ledgerState(rig.divisionId)).toEqual(before);
    }, 120_000);

    it(`X-SW-28 standings drop the cleared bye's points (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 2, false);
      await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1: the bye is awarded at once
      const holder = roundOf(await rowsOf(rig.stageId), 1).find(isBye)!.home_entrant_id!;
      const tables = () =>
        sql<{ rows: { entrantId: string; points: number }[] }[]>`
          select rows from standings_snapshots where stage_id = ${rig.stageId}`;
      const paired = await tables();
      expect(paired.length, "premise: Pair's refold stored a table").toBeGreaterThan(0);
      const credited = paired.flatMap((t) => t.rows).find((r) => r.entrantId === holder);
      expect(credited?.points ?? 0, "premise: Pair's refold stored the bye holder's points").toBeGreaterThan(0);

      await undoDivision(rig.auth, rig.divisionId);
      // Round 1 was the only seated round, so the fold has no row at all: the stored table GOES (`emptyFold: "drop"`, as
      // Unpair does) — not an empty table written over it, which the page would show as a table of no rows instead of
      // "No standings yet" — and nothing is left crediting the bye.
      expect(await tables(), "no stored table is left for a stage that seats nobody").toEqual([]);
    }, 120_000);

    it(`restore across a late entry refuses SWISS_LATE_ENTRY_NOT_UNDOABLE (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 2, false);
      const cp = await createCheckpoint(rig.auth, rig.divisionId, "Before pairing");
      // The positive pair: a save point taken before Pair restores to unpaired shells (Restore loops Undo).
      await generateStageFixtures(rig.auth, rig.stageId);
      const restored = await restoreCheckpoint(rig.auth, rig.divisionId, cp.id, true);
      expect(restored.steps, "the restore stepped back over the Pair").toBeGreaterThan(0);
      expectRoundCleared(roundOf(await rowsOf(rig.stageId), 1), "a restore to before the Pair");

      // Pair again, then an organiser adds a late player: the restore would cross it, and refuses by name.
      await generateStageFixtures(rig.auth, rig.stageId);
      await appendLedgerRow(rig.divisionId, "swiss_late_entry", {
        stage_id: rig.stageId,
        entrant_id: rig.entrants[0],
        case: "c",
        round: 2,
        source: "organiser",
      });
      const seated = await rowsOf(rig.stageId);
      expectRoundSeated(roundOf(seated, 1), "premise");
      await expect(restoreCheckpoint(rig.auth, rig.divisionId, cp.id, true)).rejects.toMatchObject(
        refusal("SWISS_LATE_ENTRY_NOT_UNDOABLE"),
      );
      expect(seatState(await rowsOf(rig.stageId)), "the refused restore cleared nothing").toEqual(seatState(seated));
    }, 120_000);

    it(`restore that commits a step and then reaches a barrier keeps that step and refuses by name (${s.sport})`, async () => {
      // Restore is a loop of Undos, each its own commit ("the steps that committed stay committed"). Pinned: a
      // reversible edit made AFTER the barrier is walked back, then the next step — the Pair, behind the barrier —
      // refuses SWISS_LATE_ENTRY_NOT_UNDOABLE. The round stays seated; exactly one inverse event lands.
      const rig = await swissRig(s, 5, 2, false);
      const cp = await createCheckpoint(rig.auth, rig.divisionId, "Before pairing");
      await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
      await appendLedgerRow(rig.divisionId, "swiss_late_entry", {
        stage_id: rig.stageId,
        entrant_id: rig.entrants[0],
        case: "c",
        round: 2,
        source: "organiser",
      });
      const board = roundOf(await rowsOf(rig.stageId), 1).find((f) => !isBye(f))!;
      const AT = "2030-06-21T10:00:00.000Z";
      await moveFixture(rig.auth, board.id, { scheduled_at: AT }); // a reversible edit after the barrier
      const timeOf = async () =>
        (await sql<{ at: Date | null }[]>`select scheduled_at as at from fixtures where id = ${board.id}`)[0]!.at?.toISOString() ?? null;
      expect(await timeOf(), "premise: the move landed").toBe(AT);
      const seated = await rowsOf(rig.stageId);
      const before = await ledgerState(rig.divisionId);

      await expect(restoreCheckpoint(rig.auth, rig.divisionId, cp.id, true)).rejects.toMatchObject(
        refusal("SWISS_LATE_ENTRY_NOT_UNDOABLE"),
      );
      expect(await timeOf(), "the step before the barrier committed: the move is undone").toBeNull();
      expect(seatState(await rowsOf(rig.stageId)), "the Pair behind the barrier is not undone").toEqual(seatState(seated));
      const after = await ledgerState(rig.divisionId);
      expect(after.events, "exactly one inverse event committed").toBe(before.events + 1);
    }, 120_000);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Review m3 (W3 T5 fix round 1): the table refold after the Undo commits is best-effort.
// Single-sport: the refold's failure handling is the usecase's (sport-agnostic).
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("W3 T5 a refold that throws after the Undo committed", () => {
  it("leaves the Undo committed and answered, the seats cleared, and logs the refusal", async () => {
    const rig = await swissRig(SPORTS[0], 5, 2, false);
    await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
    const before = await ledgerState(rig.divisionId);
    const errors = vi.spyOn(log, "error");
    refold.fail = true;
    refold.calls = 0;
    try {
      await expect(undoDivision(rig.auth, rig.divisionId), "a committed Undo never answers with a 500").resolves.toBeDefined();
      expect(refold.calls, "premise: the Undo tried its refold").toBe(1);
    } finally {
      refold.fail = false;
    }
    expectRoundCleared(roundOf(await rowsOf(rig.stageId), 1), "after the Undo whose refold threw");
    expect((await ledgerState(rig.divisionId)).events, "the inverse event committed").toBe(before.events + 1);
    expect(
      errors.mock.calls.some(([o]) => (o as { event?: string })?.event === "stage_table_refold_failed"),
      "the refusal is logged",
    ).toBe(true);
    errors.mockRestore();
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Review m1 (W3 T5 fix round 1): every Swiss clear holds each board's append lock across its "nothing recorded" read.
// Single-sport: the lock is the fixture's append lock (append-event.ts), which reads no sport field.
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("W3 T5 a Swiss clear waits for a first event in flight, then refuses it by name", () => {
  /** A scorer's first event on `boardId`, stopped INSIDE its transaction right after it took the board's append lock
   *  (`fixture:<id>`, as append-event.ts does). The clear runs meanwhile. Deterministic, never a sleep race: the
   *  scorer is released only once Postgres reports the clear blocked on the scorer's backend
   *  (`pg_blocking_pids`) — or once the clear has finished without ever waiting, which is the defect. Released, the
   *  real append core (`appendEventInTx`, re-entering the same lock) commits the start. */
  async function againstAScorerInFlight(rig: Rig, boardId: string, clear: () => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let holding!: (pid: number) => void;
    const held = new Promise<number>((r) => (holding = r));
    const scorer = withTenant(rig.auth.orgId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + boardId}))`;
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      holding(pid);
      await gate;
      await appendEventInTx(tx, rig.auth.orgId, boardId, 0, { type: "core.start", payload: {} });
    }).then(
      () => "committed" as const,
      (e: unknown) => e,
    );
    const pid = await held;
    let settled = false;
    const cleared = clear().then(
      () => "resolved" as const,
      (e: unknown) => e,
    );
    void cleared.then(() => (settled = true));
    let blocked = false;
    for (let i = 0; i < 400 && !settled && !blocked; i++) {
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`;
      blocked = n > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 25));
    }
    release();
    return { blocked, scorer: await scorer, cleared: await cleared };
  }

  it("X-SW-28 Undo of Pair next: the start commits first and the Undo refuses SWISS_UNDO_ROUND_STARTED", async () => {
    const rig = await swissRig(SPORTS[0], 5, 2, true);
    await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
    const paired = await rowsOf(rig.stageId);
    const board = roundOf(paired, 1).find((f) => !isBye(f))!;
    const out = await againstAScorerInFlight(rig, board.id, () => undoDivision(rig.auth, rig.divisionId));
    expect(out.blocked, "the Undo waited on the board's append lock").toBe(true);
    expect(out.scorer, "the first event committed").toBe("committed");
    expect(out.cleared).toMatchObject(refusal("SWISS_UNDO_ROUND_STARTED"));
    const after = roundOf(await rowsOf(rig.stageId), 1);
    expect(after.map((f) => [f.home_entrant_id, f.away_entrant_id]), "the round keeps its seats").toEqual(
      roundOf(paired, 1).map((f) => [f.home_entrant_id, f.away_entrant_id]),
    );
  }, 120_000);

  it("Unpair: the start commits first and the Unpair refuses STAGE_NOT_READY", async () => {
    const rig = await swissRig(SPORTS[0], 5, 2, true);
    await generateStageFixtures(rig.auth, rig.stageId);
    const board = roundOf(await rowsOf(rig.stageId), 1).find((f) => !isBye(f))!;
    const out = await againstAScorerInFlight(rig, board.id, () => unpairSwissRound(rig.auth, rig.stageId));
    expect(out.blocked, "the Unpair waited on the board's append lock").toBe(true);
    expect(out.scorer).toBe("committed");
    expect(out.cleared).toEqual(expect.objectContaining({ code: "STAGE_NOT_READY" }));
    expectRoundSeated(roundOf(await rowsOf(rig.stageId), 1), "after the refused Unpair");
  }, 120_000);

  it("the pre-Start entrant delete: the start commits first and the delete refuses STAGE_NOT_READY", async () => {
    const rig = await swissRig(SPORTS[0], 5, 2, false);
    await generateStageFixtures(rig.auth, rig.stageId);
    const board = roundOf(await rowsOf(rig.stageId), 1).find((f) => !isBye(f))!;
    const leaving = board.home_entrant_id!;
    const out = await againstAScorerInFlight(rig, board.id, () => deleteEntrant(rig.auth, leaving));
    expect(out.blocked, "the delete waited on the board's append lock").toBe(true);
    expect(out.scorer).toBe("committed");
    expect(out.cleared).toEqual(expect.objectContaining({ code: "STAGE_NOT_READY" }));
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where id = ${leaving}`;
    expect(n, "the entrant is still there").toBe(1);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// A replayed placement never lands on a bye shell (X-SW-29; T3 review m3's second half).
// Single-sport: the guard reads the shell's ext_key (`swissByeShellSql`), no sport field.
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("W3 T5 Undo and Redo never put a slot on a Swiss bye shell", () => {
  /** A five-player Swiss (a bye every round) with round 2 still shells: its bye shell and two board shells. */
  async function shells() {
    const rig = await swissRig(SPORTS[0], 5, 2, false);
    const rows = await rowsOf(rig.stageId);
    const bye = rows.find((f) => f.ext_key === "sw-r2-bye")!;
    const bye1 = rows.find((f) => f.ext_key === "sw-r1-bye")!;
    const [b1, b2] = roundOf(rows, 2).filter((f) => !isBye(f));
    expect([bye, bye1, b1, b2].every(Boolean), "rig: rounds 1 and 2 have bye shells, round 2 two boards").toBe(true);
    return { rig, bye: bye.id, bye1: bye1.id, b1: b1!.id, b2: b2!.id };
  }
  const slotOf = async (id: string) => {
    const [f] = await sql<{ scheduled_at: Date | null; court_id: string | null; venue_id: string | null }[]>`
      select scheduled_at, court_id, venue_id from fixtures where id = ${id}`;
    return { at: f!.scheduled_at?.toISOString() ?? null, court_id: f!.court_id, venue_id: f!.venue_id };
  };
  const AT = (h: number) => `2030-06-20T${String(h).padStart(2, "0")}:00:00.000Z`;
  const NONE = { at: null, court_id: null, venue_id: null };
  /** A placement row as a writer from before W3 T3 left it: the bye shell was placed like any board. Appended as a
   *  fresh edit (the watermark goes back to the head, as every schedule writer leaves it). */
  async function legacyRow(divisionId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await appendLedgerRow(divisionId, type, payload);
    await sql`update divisions set edit_watermark = null where id = ${divisionId}`;
  }

  /** A court a pre-uuid ledger row names by label: history writes the time and leaves `court_id` alone (the replays'
   *  second branch, `resolveCourtWrite` → `write: false`). Each case below drives BOTH branches (review m6). */
  const LEGACY_COURT = "Court 3";

  it("X-SW-29 Redo of a pre-T3 schedule_applied places the board and leaves the bye unplaced", async () => {
    const { rig, bye, bye1, b1, b2 } = await shells();
    const empty = { at: null, court: null };
    await legacyRow(rig.divisionId, "schedule_applied", {
      moves: [
        { fixture: bye, from: empty, to: { at: AT(9), court: null } },
        { fixture: b1, from: empty, to: { at: AT(10), court: null } },
        { fixture: bye1, from: empty, to: { at: AT(7), court: LEGACY_COURT } },
        { fixture: b2, from: empty, to: { at: AT(8), court: LEGACY_COURT } },
      ],
    });
    await undoDivision(rig.auth, rig.divisionId);
    await redoDivision(rig.auth, rig.divisionId);
    expect((await slotOf(b1)).at, "positive pair: the Redo replays the board's placement").toBe(AT(10));
    expect((await slotOf(b2)).at, "positive pair, legacy court: the time is replayed").toBe(AT(8));
    expect(await slotOf(bye), "the bye shell takes no slot from the replay").toEqual(NONE);
    expect(await slotOf(bye1), "nor through a legacy court").toEqual(NONE);
  }, 120_000);

  it("X-SW-29 Undo of a pre-T3 schedule_edited puts the board back and leaves the bye unplaced", async () => {
    const { rig, bye, bye1, b1, b2 } = await shells();
    const legacy = (h: number) => ({ at: AT(h), court: LEGACY_COURT });
    await legacyRow(rig.divisionId, "schedule_edited", { fixture: b1, from: { at: AT(11), court: null }, to: { at: AT(12), court: null } });
    await legacyRow(rig.divisionId, "schedule_edited", { fixture: bye, from: { at: AT(11), court: null }, to: { at: AT(12), court: null } });
    await legacyRow(rig.divisionId, "schedule_edited", { fixture: b2, from: legacy(15), to: legacy(16) });
    await legacyRow(rig.divisionId, "schedule_edited", { fixture: bye1, from: legacy(15), to: legacy(16) });
    for (let i = 0; i < 4; i++) await undoDivision(rig.auth, rig.divisionId); // newest first: bye1, b2, bye, b1
    expect((await slotOf(b1)).at, "positive pair: the Undo puts the board's time back").toBe(AT(11));
    expect((await slotOf(b2)).at, "positive pair, legacy court: the time goes back").toBe(AT(15));
    expect(await slotOf(bye), "the bye shell takes no slot from the Undo").toEqual(NONE);
    expect(await slotOf(bye1), "nor through a legacy court").toEqual(NONE);
  }, 120_000);

  it("X-SW-29 Undo of a pre-T3 schedule_cleared restores the board's slot and leaves the bye unplaced", async () => {
    const { rig, bye, bye1, b1, b2 } = await shells();
    await legacyRow(rig.divisionId, "schedule_cleared", {
      scope: { excludeLocked: true },
      cleared: [
        { id: bye, at: AT(13), court: null },
        { id: b2, at: AT(14), court: null },
        { id: bye1, at: AT(17), court: LEGACY_COURT },
        { id: b1, at: AT(18), court: LEGACY_COURT },
      ],
    });
    await undoDivision(rig.auth, rig.divisionId); // schedule_restored
    expect((await slotOf(b2)).at, "positive pair: the restore puts the board's slot back").toBe(AT(14));
    expect((await slotOf(b1)).at, "positive pair, legacy court: the time goes back").toBe(AT(18));
    expect(await slotOf(bye), "the bye shell takes no slot from the restore").toEqual(NONE);
    expect(await slotOf(bye1), "nor through a legacy court").toEqual(NONE);
  }, 120_000);
});
