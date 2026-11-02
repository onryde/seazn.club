// W3 Task 3 (SW-M7; X-SW-5 is RB3-7(a)'s app half) — a Swiss bye's value is frozen at AWARD: the bye seat writes
// `config_snapshot` like any fixture's first event does (append-event.ts), so a stage format saved later does not move
// what the bye was awarded under.
//
// The premise the plan found (Review Focus 5): `config_snapshot is not null` is PLAYED to `fixtureEvidenceSql`
// (fixture-results-sql.ts) and to `playedSql` (format-standing.ts). A frozen bye read through them as it stood would lock
// the stage's rules (rule-locks.ts) and make Unpair, Rebuild and Undo refuse every round that has a bye — on any odd
// field, before Start. Both readers exempt a SYSTEM bye (`systemByeSql`: one seat, `reason: "bye"`), and only on the
// snapshot clause: a real walkover over a dead seat (ruling 116) is still evidence, which is this file's positive pair.
//
// Every case runs for badminton AND chess (boardgame) through the same body. The expected cfg is the resolver's answer
// over the division and stage as read BEFORE Pair — the cfg append-event.ts would freeze at a first event — and one case
// proves that claim against append-event itself (a board's real first event).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { canonicalJson } from "@/lib/canonical-json";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { playedSql } from "@/server/engine-db/format-standing";
import { resolveModule } from "@/server/engine-db/registry";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { fixtureEvidenceSql } from "../fixture-results-sql";
import { undoDivision } from "../history";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { putStageRules } from "../stage-rules";
import { createStages, generateStageFixtures, rebuildStageFixtures, unpairSwissRound } from "../stages";
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
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  entrants: string[];
}

/** Five players (an odd field: every round has a bye), a 2-round Swiss, nothing generated, the division in setup. */
async function oddSwiss({ sport, variant }: Sport): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Bye freeze " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport,
    variant_key: variant,
    config: {},
  });
  const kind = mod(sport).entrantModel?.defaultKind ?? "individual";
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 5 }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 2 },
    progression: null,
  });
  return { auth, divisionId: division.id, stageId: stage!.id, entrants: entrants.map((e) => e.id) };
}

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string; winner?: string; reason?: string } | null;
  config_snapshot: unknown;
  config_snapshot_at: Date | null;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, status, home_entrant_id, away_entrant_id, outcome, config_snapshot, config_snapshot_at
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

async function byeOf(stageId: string, round: number): Promise<Row> {
  const bye = (await rowsOf(stageId)).filter((r) => r.ext_key === `sw-r${round}-bye`);
  expect(bye, `rig: round ${round} has exactly one bye shell`).toHaveLength(1);
  return bye[0]!;
}

/** What a fixture of this stage with no snapshot and no override resolves to NOW: the resolver over the division and
 *  the stage as stored (fixture-cfg.ts) — the cfg append-event.ts freezes at a first event. */
async function liveCfgOf(divisionId: string, stageId: string): Promise<unknown> {
  const [d] = await sql<{ config: unknown; sport_key: string; module_version: string }[]>`
    select config, sport_key, module_version from divisions where id = ${divisionId}`;
  const [s] = await sql<{ kind: string; config: Record<string, unknown> | null }[]>`
    select kind, config from stages where id = ${stageId}`;
  return resolveFixtureCfg(
    { config_snapshot: null, rules_override: null },
    d!.config,
    { kind: s!.kind, config: s!.config },
    resolveModule(d!.sport_key, d!.module_version),
  );
}

/** Mint the shells, then Pair round 1 (two Generate presses). */
async function pairRoundOne(rig: Rig): Promise<void> {
  await generateStageFixtures(rig.auth, rig.stageId);
  await generateStageFixtures(rig.auth, rig.stageId);
}

/** The premise every case below rests on: round 1's bye is seated, a system bye, and frozen. */
function expectSeatedFrozenBye(bye: Row): void {
  expect(bye.status, "premise: the bye is settled at seat time").toBe("forfeited");
  expect(bye.outcome?.reason, "premise: a SYSTEM bye (`byeAward`)").toBe("bye");
  expect([bye.home_entrant_id !== null, bye.away_entrant_id], "premise: one seat, the away one empty").toEqual([true, null]);
  expect(bye.config_snapshot, "premise: the bye froze its cfg at award").not.toBeNull();
  expect(bye.config_snapshot_at, "premise: … and stamped when").not.toBeNull();
}

for (const s of SPORTS) {
  describe.runIf(HAS_DB)(`W3 T3 a Swiss bye freezes at award (${s.sport})`, () => {
    it(`X-SW-5 a seated bye carries config_snapshot equal to the stage cfg at award (${s.sport})`, async () => {
      const rig = await oddSwiss(s);
      // Read BEFORE Pair: the format the bye is awarded under.
      const atAward = await liveCfgOf(rig.divisionId, rig.stageId);
      expect(atAward, "premise: the stage resolves a cfg").not.toBeNull();
      await pairRoundOne(rig);

      const bye = await byeOf(rig.stageId, 1);
      expectSeatedFrozenBye(bye);
      expect(bye.config_snapshot, "the bye's snapshot is the stage's cfg at award").toEqual(atAward);
      // Only the bye is frozen: the boards of the round hold nothing until their first event.
      const boards = (await rowsOf(rig.stageId)).filter((r) => r.round_no === 1 && r.ext_key !== "sw-r1-bye");
      expect(boards.length, "rig: round 1 seats two boards").toBe(2);
      expect(boards.map((b) => b.config_snapshot), "a board is frozen by its first event, not by Pair").toEqual([null, null]);

      // The stage's format moves before Start (and its points with it). The bye keeps the format it was awarded under.
      const m = mod(s.sport);
      const pick = movingFragment(m, s.variant, "swiss");
      expect(pick, `premise: a ${s.sport} swiss stage has a rule it can move`).not.toBeNull();
      await putStageRules(rig.auth, rig.stageId, { rules: pick!.frag });
      await putStageRules(rig.auth, rig.stageId, {
        points: { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole" },
      });
      const moved = await liveCfgOf(rig.divisionId, rig.stageId);
      expect(canonicalJson(moved), "witness: the save moved what an unfrozen fixture resolves").not.toBe(canonicalJson(atAward));
      const after = await byeOf(rig.stageId, 1);
      expect(after.config_snapshot, "the bye's snapshot is unchanged by a later format save").toEqual(atAward);
      expect(after.config_snapshot_at).toEqual(bye.config_snapshot_at);
    }, 120_000);

    it(`X-SW-5 the bye freezes exactly what a board's first event freezes (${s.sport})`, async () => {
      // The differential against the real producer: append-event.ts's own freeze, on a board of the same round, with
      // nothing saved in between.
      const rig = await oddSwiss(s);
      await startDivision(rig.auth, rig.divisionId); // mints the shells
      await generateStageFixtures(rig.auth, rig.stageId); // Pair round 1
      const bye = await byeOf(rig.stageId, 1);
      expectSeatedFrozenBye(bye);
      const board = (await rowsOf(rig.stageId)).find((r) => r.round_no === 1 && r.away_entrant_id !== null)!;
      expect(board.config_snapshot, "premise: the board is unfrozen").toBeNull();
      await scoreEvent(rig.auth, board.id, { expected_seq: 0, type: "core.start", payload: {} });
      const [frozen] = await sql<{ config_snapshot: unknown }[]>`select config_snapshot from fixtures where id = ${board.id}`;
      expect(frozen!.config_snapshot, "premise: the board's first event froze its cfg").not.toBeNull();
      expect(bye.config_snapshot).toEqual(frozen!.config_snapshot);
    }, 120_000);

    it(`a frozen bye is not PLAYED: stage rules stay editable, Unpair clears it (${s.sport})`, async () => {
      const rig = await oddSwiss(s);
      await pairRoundOne(rig); // pre-Start: the division is still in setup
      expectSeatedFrozenBye(await byeOf(rig.stageId, 1));

      // The rule lock (rule-locks.ts, `playedSql`): a bye is not play, so the stage's format is still the organiser's.
      const pick = movingFragment(mod(s.sport), s.variant, "swiss")!;
      await expect(
        putStageRules(rig.auth, rig.stageId, { rules: pick.frag }),
        "stage rules stay editable over a frozen bye (playedSql exempts a system bye)",
      ).resolves.toBeDefined();

      // Unpair (`fixtureEvidenceSql`): a bye is no recorded match data, so the round goes back onto its shells.
      await expect(
        unpairSwissRound(rig.auth, rig.stageId),
        "Unpair clears a round with a frozen bye (fixtureEvidenceSql exempts a system bye)",
      ).resolves.toMatchObject({ round: 1 });
      const bye = await byeOf(rig.stageId, 1);
      expect(
        {
          home: bye.home_entrant_id,
          away: bye.away_entrant_id,
          outcome: bye.outcome,
          snapshot: bye.config_snapshot,
          at: bye.config_snapshot_at,
          status: bye.status,
        },
        "Unpair clears the bye's seats, its outcome AND its snapshot",
      ).toEqual({ home: null, away: null, outcome: null, snapshot: null, at: null, status: "scheduled" });

      // The sequence: Pair again freezes afresh, under the format the stage now plays.
      const now = await liveCfgOf(rig.divisionId, rig.stageId);
      await generateStageFixtures(rig.auth, rig.stageId);
      const again = await byeOf(rig.stageId, 1);
      expectSeatedFrozenBye(again);
      expect(again.config_snapshot, "a re-Pair freezes the cfg that stands at the new award").toEqual(now);
    }, 120_000);

    it(`a frozen bye does not block Rebuild or Undo (${s.sport})`, async () => {
      // Rebuild: its refusal set is `fixtureHasResultSql` over the stage (a frozen bye would be STAGE_HAS_RESULTS).
      const rig = await oddSwiss(s);
      await pairRoundOne(rig);
      expectSeatedFrozenBye(await byeOf(rig.stageId, 1));
      // Roster drift makes the Rebuild a real one: the last seed leaves before Start (five → four, no bye).
      await patchEntrant(rig.auth, rig.entrants[4]!, { status: "withdrawn" });
      await expect(rebuildStageFixtures(rig.auth, rig.stageId), "Rebuild over a frozen bye").resolves.toBeDefined();
      const rebuilt = await rowsOf(rig.stageId);
      expect(rebuilt.length, "rig: the rebuild regenerated the stage").toBeGreaterThan(0);
      expect(rebuilt.filter((r) => r.config_snapshot !== null), "nothing frozen survives a rebuild").toEqual([]);

      // Undo: history's results-guard is the played set (`playedFixtureIds` = `fixtureHasResultSql`). Walk the ledger
      // back past the Pair AND the mint (whose undo deletes the bye shell itself).
      const rig2 = await oddSwiss(s);
      await pairRoundOne(rig2);
      expectSeatedFrozenBye(await byeOf(rig2.stageId, 1));
      let undone = 0;
      while ((await rowsOf(rig2.stageId)).length > 0) {
        await expect(undoDivision(rig2.auth, rig2.divisionId), `Undo step ${undone + 1} over a frozen bye`).resolves.toBeDefined();
        undone++;
        expect(undone, "the walk back ends within the two steps it took (mint, Pair)").toBeLessThanOrEqual(2);
      }
      expect(undone, "anti-vacuity: at least the mint was undone").toBeGreaterThan(0);
    }, 120_000);
  });
}

// The guard's positive pair, and the three-valued trap. The predicate reads seats, the outcome and the snapshot only —
// no sport field — so one sport's rows carry it (single-sport: the SQL under test is sport-agnostic).
describe.runIf(HAS_DB)("W3 T3 the system-bye exemption is the snapshot's alone", () => {
  it("a real walkover over a dead seat (ruling 116) is still evidence; a system bye is not; a board is", async () => {
    const rig = await oddSwiss(SPORTS[0]);
    await pairRoundOne(rig);
    const rows = await rowsOf(rig.stageId);
    const bye = rows.find((r) => r.ext_key === "sw-r1-bye")!;
    const [board, other] = rows.filter((r) => r.round_no === 1 && r.away_entrant_id !== null);
    const shell = rows.find((r) => r.round_no === 2)!;
    expectSeatedFrozenBye(bye);
    const cfg = bye.config_snapshot;
    // An `awardSeededByes`-shaped walkover over a dead seat (ruling 116, stages.ts): one seat, the absent side the
    // LOSER, `reason: "withdrew"` — frozen, with no event (the snapshot is its only mark).
    const winner = board!.home_entrant_id!;
    const loser = board!.away_entrant_id!;
    await sql`
      update fixtures set away_entrant_id = null, status = 'forfeited',
        outcome = ${sql.json({ kind: "award", winner, loser, reason: "withdrew" } as never)},
        config_snapshot = ${sql.json(cfg as never)}, config_snapshot_at = now()
      where id = ${board!.id}`;
    // A board frozen with no event (not a shape the product writes; it isolates the snapshot clause).
    await sql`update fixtures set config_snapshot = ${sql.json(cfg as never)}, config_snapshot_at = now() where id = ${other!.id}`;
    // A one-seat row with a snapshot and NO outcome: `systemByeSql` must read false, never null (a null would turn
    // `not exempt` null and drop the row from the evidence set).
    await sql`
      update fixtures set home_entrant_id = ${winner}, config_snapshot = ${sql.json(cfg as never)}, config_snapshot_at = now()
      where id = ${shell.id}`;

    const verdicts = await sql.begin(async (tx) =>
      tx<{ id: string; evidence: boolean | null; not_evidence: boolean | null; played: boolean | null }[]>`
        select f.id, (${fixtureEvidenceSql(tx, "f")}) as evidence, not (${fixtureEvidenceSql(tx, "f")}) as not_evidence,
               ${playedSql(tx, "f")} as played
        from fixtures f where f.id in ${tx([bye.id, board!.id, other!.id, shell.id])}`,
    );
    const by = new Map(verdicts.map((v) => [v.id, v]));
    expect(verdicts.length, "anti-vacuity: four rows judged").toBe(4);
    expect(by.get(bye.id), "a system bye: frozen, but not evidence and not played").toEqual({
      id: bye.id,
      evidence: false,
      not_evidence: true,
      played: false,
    });
    expect(by.get(board!.id), "ruling 116's walkover over a dead seat stays evidence and played").toEqual({
      id: board!.id,
      evidence: true,
      not_evidence: false,
      played: true,
    });
    expect(by.get(other!.id), "a frozen board is evidence and played").toEqual({ id: other!.id, evidence: true, not_evidence: false, played: true });
    expect(by.get(shell.id), "one seat and a snapshot with no outcome: evidence (never null)").toEqual({
      id: shell.id,
      evidence: true,
      not_evidence: false,
      played: true,
    });
  }, 120_000);

  it("a bye's award is a bye on an orphaned row too; an award naming another winner, or two seats, is not", async () => {
    // A bye whose holder was deleted before the swiss guard existed keeps its award with BOTH seats empty
    // (swiss-delete-entrant.test.ts's orphan) — Unpair is how that round is cleared, so its frozen cfg is no evidence.
    // Three shapes that are not one: `reason: "bye"` where the seated side is not the winner, or over two seats; and a
    // one-seat award with no loser under another reason. Each pins one clause of `systemByeSql`.
    const rig = await oddSwiss(SPORTS[0]);
    await pairRoundOne(rig);
    const rows = await rowsOf(rig.stageId);
    const bye = rows.find((r) => r.ext_key === "sw-r1-bye")!;
    expectSeatedFrozenBye(bye);
    const cfg = bye.config_snapshot;
    const holder = bye.home_entrant_id!;
    const [b1, b2] = rows.filter((r) => r.round_no === 1 && r.away_entrant_id !== null);
    const award = sql.json({ kind: "award", winner: holder, loser: null, reason: "bye" } as never);
    // The orphan: the round-1 bye with its holder's seat emptied, award and snapshot kept.
    await sql`update fixtures set home_entrant_id = null where id = ${bye.id}`;
    // Seated side is not the winner: board 1's home seat stays, its away seat goes, the award names the bye holder.
    await sql`
      update fixtures set away_entrant_id = null, status = 'forfeited', outcome = ${award},
        config_snapshot = ${sql.json(cfg as never)}, config_snapshot_at = now()
      where id = ${b1!.id}`;
    // Both seats filled under a bye award its home side won (so only the seat count tells it from a bye).
    await sql`
      update fixtures set status = 'forfeited',
        outcome = ${sql.json({ kind: "award", winner: b2!.home_entrant_id, loser: null, reason: "bye" } as never)},
        config_snapshot = ${sql.json(cfg as never)}, config_snapshot_at = now()
      where id = ${b2!.id}`;
    // One seat, its side the winner, no loser — but not a bye's reason (a forfeit award a scorer's console posts names
    // its reason): only `reason` tells it from a bye.
    const r2 = rows.find((r) => r.ext_key === "sw-r2-b1")!;
    await sql`
      update fixtures set home_entrant_id = ${holder}, status = 'forfeited',
        outcome = ${sql.json({ kind: "award", winner: holder, loser: null, reason: "withdrew" } as never)},
        config_snapshot = ${sql.json(cfg as never)}, config_snapshot_at = now()
      where id = ${r2.id}`;
    const verdicts = await sql.begin(async (tx) =>
      tx<{ id: string; evidence: boolean | null; played: boolean | null }[]>`
        select f.id, (${fixtureEvidenceSql(tx, "f")}) as evidence, ${playedSql(tx, "f")} as played
        from fixtures f where f.id in ${tx([bye.id, b1!.id, b2!.id, r2.id])}`,
    );
    const by = new Map(verdicts.map((v) => [v.id, { evidence: v.evidence, played: v.played }]));
    expect(verdicts.length, "anti-vacuity: four rows judged").toBe(4);
    expect(by.get(bye.id), "the orphaned bye: no evidence, not played").toEqual({ evidence: false, played: false });
    expect(by.get(b1!.id), "a bye award the seated side did not win: evidence").toEqual({ evidence: true, played: true });
    expect(by.get(b2!.id), "a bye award over two seats: evidence").toEqual({ evidence: true, played: true });
    expect(by.get(r2.id), "an award with no loser and another reason: evidence").toEqual({ evidence: true, played: true });
  }, 120_000);
});
