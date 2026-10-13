// W2b Loop R M-4 (controller ruling 2026-10-13): signed X-WD-4 (ruling 90) reads "When both sides of a fixture have
// withdrawn, the fixture is a double walkover" — with no bracket scope. The cascade applied it to bracket lines only
// (withdrawal.ts): in a league or a group, an entrant who had already left by a bare status write (a self-withdrawal,
// ruling 111's no-cascade path) was handed the walkover — `forfeit{by: A, withdrew}` — when the organiser then withdrew
// her opponent: the points and the walkover score to a side that had left. Now the line is a double walkover, which
// the table counts as X-DW-4 says: P+1, L+1, 0 points for both, no score credited.
//
// Through the product: a division the usecases seed, play through `scoreEvent`, the withdrawal through
// `withdrawEntrantCascade`, the table read as the public reads it (`getStandings`: the snapshot the write left, never a
// recompute of our own). The table policy walks pending games over only once the withdrawer has played at least half
// of them (engine `withdrawTableEntrant`, EXPUNGES_EARLY_WITHDRAWAL), so every scene first plays her other games.
// single-sport: badminton; the both-gone check reads entrant statuses, never the sport.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, playBadminton, post, rowsOf, type FixtureRow } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { getStandings } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Kind = "league" | "group";
interface Tally { played: number; won: number; drawn: number; lost: number; points: number }
interface Row extends Tally { entrantId: string; metrics: Record<string, number> }

/** A table of four (a league; a group of two pools of four — a single pool generates no pool row), the line between
 *  `cascaded` and `other`, and the cascaded entrant's two other games played (each won by its home side) so the table
 *  policy walks her pending game over. */
async function scene(kind: Kind, cascadedSeat: "home" | "away") {
  const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: kind, ...(kind === "group" ? { entrants: 8, stageConfig: { pools: { count: 2 } } } : { entrants: 4 }) });
  const rows = await rowsOf(s.stageId);
  const line = rows.find((r) => r.home_entrant_id !== null && r.away_entrant_id !== null)!;
  const cascaded = cascadedSeat === "home" ? line.home_entrant_id! : line.away_entrant_id!;
  const other = cascadedSeat === "home" ? line.away_entrant_id! : line.home_entrant_id!;
  const hers = rows.filter((r) => r.id !== line.id && (r.home_entrant_id === cascaded || r.away_entrant_id === cascaded));
  expect(hers, "rig: the withdrawer has two other games").toHaveLength(2);
  for (const r of hers) await playBadminton(s.auth, r.id, true);
  const [{ pool_id: poolId }] = await sql<{ pool_id: string | null }[]>`select pool_id from fixtures where id = ${line.id}`;
  return { s, line, cascaded, other, poolId: poolId ?? undefined };
}

/** The table as `getStandings` serves it (a pool's own table in a group). A side with no folded result has no row:
 *  it reads as all zeros, which is what it is credited. */
async function table(auth: AuthCtx, stageId: string, poolId: string | undefined, ids: readonly string[]) {
  const rows = (await getStandings(auth, stageId, poolId)).rows as unknown as Row[];
  return ids.map((id) => {
    const r = rows.find((x) => x.entrantId === id);
    const tally: Tally = { played: r?.played ?? 0, won: r?.won ?? 0, drawn: r?.drawn ?? 0, lost: r?.lost ?? 0, points: r?.points ?? 0 };
    return { tally, metrics: r?.metrics ?? {} };
  });
}

/** X-DW-4 (cross-sport.md, signed 85): "P+1, L+1, 0 points for both, no score credited". The expected tally is the
 *  tally before the double walkover moved by exactly that — never a number read off the code under test. */
const xdw4 = (before: Tally): Tally => ({ ...before, played: before.played + 1, lost: before.lost + 1 });
/** The metrics a result moved. A zero-valued key is no credit: a side with no row before reads `{}`, and after reads
 *  its sport's metric keys at 0. */
const creditedScore = (before: Record<string, number>, after: Record<string, number>) =>
  Object.keys({ ...before, ...after }).filter((k) => (after[k] ?? 0) !== (before[k] ?? 0));

async function expectDoubleWalkover(line: FixtureRow, name: string) {
  const after = await fixtureRow(line.id);
  expect([after.status, after.outcome], `${name}: a double walkover, not ${JSON.stringify(after.outcome)}`).toEqual(["forfeited", { kind: "double_walkover" }]);
  const ledger = await sql<{ type: string; payload: unknown }[]>`
    select type, payload from score_events where fixture_id = ${line.id} order by seq`;
  expect(ledger, `${name}: recorded as the console's double walkover is, by the cascade`).toEqual([
    { type: "core.forfeit", payload: { by: "both", reason: "walkover" } },
  ]);
  expect([after.home_entrant_id, after.away_entrant_id], `${name}: both seats kept (the table names who did not play)`).toEqual([line.home_entrant_id, line.away_entrant_id]);
}

describe.skipIf(!HAS_DB)("Loop R M-4: X-WD-4 in a table stage — both sides gone is a double walkover, never a walkover to the side that left", () => {
  const cases: { name: string; kind: Kind; cascadedSeat: "home" | "away" }[] = [
    { name: "X-WD-4 in a league", kind: "league", cascadedSeat: "home" },
    { name: "X-WD-4 in a group stage", kind: "group", cascadedSeat: "home" },
    // The reverse order: the entrant the organiser withdraws sits AWAY, the one who left first sits home.
    { name: "X-WD-4, the reverse order", kind: "league", cascadedSeat: "away" },
  ];
  for (const c of cases) {
    it(`${c.name}: she self-withdrew, then the organiser withdraws her opponent — a double walkover, counted as X-DW-4 counts it for both`, async () => {
      const { s, line, cascaded, other, poolId } = await scene(c.kind, c.cascadedSeat);
      if (c.kind === "group") expect(poolId, "rig: a group line sits in a pool").toBeDefined();
      if (c.cascadedSeat === "away") expect(other, "rig: the side that left first is the home seat").toBe(line.home_entrant_id);
      await sql`update entrants set status = 'withdrawn' where id = ${other}`; // the no-cascade path: a bare status write
      const before = await table(s.auth, s.stageId, poolId, [cascaded, other]);
      expect(before[0]!.tally.played, "anti-vacuity: the table is read — her two games are in it").toBe(2);
      const out = await withdrawEntrantCascade(s.auth, cascaded);
      expect(out, "the table policy walked her pending game over").toMatchObject({ policy: "walkover", walkovers: 1, voided: 0 });
      await expectDoubleWalkover(line, c.name);
      const after = await table(s.auth, s.stageId, poolId, [cascaded, other]);
      let checked = 0;
      for (const [i, who] of (["the withdrawer", "the side that left first"] as const).entries()) {
        expect(after[i]!.tally, `${who}: P+1, L+1, 0 points (X-DW-4)`).toEqual(xdw4(before[i]!.tally));
        expect(creditedScore(before[i]!.metrics, after[i]!.metrics), `${who}: no score credited`).toEqual([]);
        checked++;
      }
      expect(checked).toBe(2);
    }, 120_000);
  }

  it("the positive pair: only one side gone — the opponent still in the field takes the walkover, its points and its score", async () => {
    const { s, line, cascaded, other, poolId } = await scene("league", "home");
    const [before] = await table(s.auth, s.stageId, poolId, [other]);
    expect(await withdrawEntrantCascade(s.auth, cascaded)).toMatchObject({ policy: "walkover", walkovers: 1 });
    const after = await fixtureRow(line.id);
    expect([after.status, after.outcome]).toEqual(["forfeited", { kind: "award", winner: other, loser: cascaded, reason: "withdrew" }]);
    const [field] = await table(s.auth, s.stageId, poolId, [other]);
    expect([field!.tally.played - before!.tally.played, field!.tally.won - before!.tally.won], "the walkover counts as a won match").toEqual([1, 1]);
    expect(field!.tally.points, "with its points").toBeGreaterThan(before!.tally.points);
    expect(creditedScore(before!.metrics, field!.metrics), "and its walkover score (BD-WO-1)").not.toEqual([]);
  }, 120_000);

  it("M-1 holds in a table too: a both-gone line with recorded play is left to the organiser, never overwritten", async () => {
    const { s, line, cascaded, other } = await scene("league", "home");
    await sql`update entrants set status = 'withdrawn' where id = ${other}`;
    await post(s.auth, line.id, "core.start");
    await post(s.auth, line.id, "badminton.game.summary", { home: 21, away: 10 });
    const held = await fixtureRow(line.id);
    expect(held.status, "rig: in play").toBe("in_play");
    const out = await withdrawEntrantCascade(s.auth, cascaded);
    expect(out, "nothing was written on the played line").toMatchObject({ walkovers: 0, voided: 0 });
    // Loop R M-5: and the cascade names it, as left to the organiser.
    expect(out.left_to_organiser, "the played line is reported").toEqual([line.id]);
    const after = await fixtureRow(line.id);
    expect([after.status, after.outcome]).toEqual([held.status, held.outcome]);
  }, 120_000);

  it("M-5: a bare Start is not play (ruling 112) — the both-gone line is still a double walkover, recorded over the Start, counted as X-DW-4 counts it", async () => {
    // single-sport: badminton; the per-sport reading (chess's Start is play, ruling 118) is swept in withdrawal-w2b.
    const { s, line, cascaded, other, poolId } = await scene("league", "home");
    await sql`update entrants set status = 'withdrawn' where id = ${other}`;
    await post(s.auth, line.id, "core.start");
    expect((await fixtureRow(line.id)).status, "rig: in play, nothing played").toBe("in_play");
    const before = await table(s.auth, s.stageId, poolId, [cascaded, other]);
    const out = await withdrawEntrantCascade(s.auth, cascaded);
    expect(out, "the line was walked over, nothing left").toMatchObject({ walkovers: 1, voided: 0, left_to_organiser: [] });
    const after = await fixtureRow(line.id);
    expect([after.status, after.outcome]).toEqual(["forfeited", { kind: "double_walkover" }]);
    const ledger = await sql<{ type: string; payload: unknown }[]>`
      select type, payload from score_events where fixture_id = ${line.id} order by seq`;
    expect(ledger).toEqual([
      { type: "core.start", payload: {} },
      { type: "core.forfeit", payload: { by: "both", reason: "walkover" } },
    ]);
    const tables = await table(s.auth, s.stageId, poolId, [cascaded, other]);
    let checked = 0;
    for (const i of [0, 1]) {
      expect(tables[i]!.tally, "P+1, L+1, 0 points (X-DW-4)").toEqual(xdw4(before[i]!.tally));
      checked++;
    }
    expect(checked).toBe(2);
  }, 120_000);
});
