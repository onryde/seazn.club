// W5 app PR B, Task 7 (C5; X-ADJ-1..5; RB5-T5..T9, RB5-T15, RB5-E8; Review Focus 2; preflight C5, C7, C8): "Adjust points" through
// the real producer (`adjustPoints` / `undoPointsAdjustment`, the routes' usecases) and the real consumers - the stored table every
// surface reads (`recomputeStandings` → `standings_snapshots`), the footnote's ledger read (`loadPointsAdjustments`), the stored lots
// draws, and the Swiss pairing's score (`stageTablePoints`, what `swissGen` groups by). Expected values come from the engine's own
// declarations (`adjustmentUnitOf` over the sport's `defaultTiebreakers`) and from the table BEFORE the adjustment (the fold the
// adjustment did not touch), never from the code under test. Sports: football (points-led) and badminton (wins-led), the
// registry's two units; the stage gates sweep every table kind and the bracket kinds.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

// B3 fix round (m-5): the stage's refold, passed through to the real one unless a test arms one throw - the refold that fails AFTER
// the ledger row committed (a lock timeout, a fold the engine refuses).
const refold = vi.hoisted(() => ({ failNext: false }));
vi.mock("@/server/engine-db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/engine-db")>();
  return {
    ...real,
    recomputeStandings: async (...args: Parameters<typeof real.recomputeStandings>) => {
      if (refold.failNext) {
        refold.failNext = false;
        throw new Error("refold down");
      }
      return real.recomputeStandings(...args);
    },
  };
});

import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { adjustmentUnitOf, type StandingsRow } from "@seazn/engine/competition";
import { sql, withTenant } from "@/lib/db";
import { POINTS_ADJUSTMENT_ROW } from "@/lib/points-adjustment-note";
import { recomputeStandings } from "@/server/engine-db";
import { stageTablePoints } from "@/server/engine-db/competition";
import { loadPointsAdjustments } from "@/server/public-site/points-adjustments";
import { adjustPoints, listPointsAdjustments, undoPointsAdjustment } from "../points-adjustments";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { completeStage, createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";
import { BADMINTON, FOOTBALL, refusal, rig, rowsOf, lineBetween, type Rig, type SportPick } from "./_w5-t3-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const REASON = "Fielded an ineligible player";

async function post(r: Pick<Rig, "auth">, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(r.auth, fixtureId, { expected_seq: n, type, payload });
}

/** A PLAYED win for `winner` through the scorer's own events: football 1-0, badminton two games. */
async function win(r: Rig, fixtureId: string, homeId: string | null, winner: string): Promise<void> {
  await post(r, fixtureId, "core.start");
  if (r.sport.key === "badminton") {
    const home = winner === homeId;
    for (let g = 0; g < 2; g++) await post(r, fixtureId, "badminton.game.summary", home ? { home: 21, away: 10 } : { home: 10, away: 21 });
    return;
  }
  await post(r, fixtureId, "football.goal", { by: winner });
  await post(r, fixtureId, "football.period", { phase: "HT" });
  await post(r, fixtureId, "football.period", { phase: "FT" });
}

/** A started four-entrant league where P1 beats P3 and P2 beats P4 by the same score: P1 and P2 level on everything the
 *  sport counts, so only the cascade's last step (lots) splits them; P3 and P4 level below. */
async function levelPair(sport: SportPick): Promise<Rig> {
  const r = await rig({ n: 4, sport });
  await startDivision(r.auth, r.divisionId);
  const lines = await rowsOf(r.stageId);
  const [p1, p2, p3, p4] = r.ids as [string, string, string, string];
  const a = lineBetween(lines, p1, p3);
  const b = lineBetween(lines, p2, p4);
  await win(r, a.id, a.home_entrant_id, p1);
  await win(r, b.id, b.home_entrant_id, p2);
  return r;
}

async function table(stageId: string): Promise<StandingsRow[]> {
  const [snap] = await sql<{ rows: StandingsRow[] }[]>`select rows from standings_snapshots where stage_id = ${stageId} and pool_id is null`;
  if (snap === undefined) throw new Error("premise: the stage has a stored table");
  return [...snap.rows].sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99));
}
const rowOf = (rows: readonly StandingsRow[], id: string): StandingsRow => {
  const row = rows.find((x) => x.entrantId === id);
  if (row === undefined) throw new Error(`premise: ${id} has a row`);
  return row;
};
const order = (rows: readonly StandingsRow[]) => rows.map((x) => x.entrantId);

async function lotsRows(stageId: string) {
  return sql<{ id: string; members: string[]; drawn_at: Date }[]>`
    select id, members::text[] as members, drawn_at from stage_lots_draws where stage_id = ${stageId} order by drawn_at, id`;
}

/** The unit the engine says an adjustment moves on `sport`'s default cascade (RB5-T15) - the expected value, from the engine. */
function declaredUnit(sport: SportPick): "points" | "wins" {
  const m = builtinModules.find((x) => x.key === sport.key)!;
  const cfg = m.configSchema.parse(m.variants[sport.variant]);
  return adjustmentUnitOf((m.defaultTiebreakers as (k: "league", c: unknown) => readonly string[])("league", cfg) as never);
}

describe.skipIf(!HAS_DB)("Adjust points (W5 app PR B Task 7, C5)", () => {
  it("X-ADJ-1 the adjustment folds before the cascade and the footnote shows its reason and date", async () => {
    const r = await levelPair(FOOTBALL);
    const before = await table(r.stageId);
    const [p1, p2] = r.ids as [string, string];
    // premise: the two winners are level and lots split them - the cascade's last step
    expect(rowOf(before, p1).points).toBe(rowOf(before, p2).points);
    const top = order(before)[0]!;
    const rival = top === p1 ? p2 : p1;
    expect([p1, p2]).toContain(top);

    const { adjustment } = await adjustPoints(r.auth, r.stageId, { entrant_id: top, delta: -3, reason: REASON });
    const after = await table(r.stageId);
    expect(rowOf(after, top).points, "folded: points move by the delta").toBe(rowOf(before, top).points - 3);
    expect(rowOf(after, top).played, "an adjustment plays nothing").toBe(rowOf(before, top).played);
    expect(order(after).indexOf(top), "re-ranked below the rival it was level with").toBeGreaterThan(order(after).indexOf(rival));

    // the footnote's source: the ledger row's reason and date (the row's created_at), and the unit the engine declares
    const [{ at }] = await sql<{ at: string }[]>`select to_json(created_at) #>> '{}' as at from division_events where division_id = ${r.divisionId} and seq = ${adjustment.seq}`;
    const notes = await loadPointsAdjustments(r.divisionId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ stage_id: r.stageId, entrant_id: top, delta: -3, reason: REASON, at, unit: declaredUnit(FOOTBALL) });
    expect(adjustment.held).toBe(false);
  });

  it("X-ADJ-4 −3 with a reason re-ranks the table and the footnote names it (and a second adjustment stacks)", async () => {
    // differential: today no path - before Task 7 no write moved a started table's points (C5 was 🚫, carry_deltas FORMAT_LOCKED)
    const r = await levelPair(FOOTBALL);
    const before = await table(r.stageId);
    const p2 = r.ids[1]!;
    await adjustPoints(r.auth, r.stageId, { entrant_id: p2, delta: -3, reason: REASON });
    await adjustPoints(r.auth, r.stageId, { entrant_id: p2, delta: -1, reason: "Late kick-off" });
    const after = await table(r.stageId);
    expect(rowOf(after, p2).points, "X-ADJ-4 a second adjustment stacks").toBe(rowOf(before, p2).points - 4);
    const listed = await listPointsAdjustments(r.auth, r.stageId);
    expect(listed.adjustments.map((a) => [a.delta, a.reason]), "both, in ledger order").toEqual([
      [-3, REASON],
      [-1, "Late kick-off"],
    ]);
  });

  it("X-ADJ-4 a reason is required, X-ADJ-3 zero is refused, a stranger is refused - each by the engine's reason name", async () => {
    const r = await levelPair(FOOTBALL);
    const p1 = r.ids[0]!;
    const cases: [Parameters<typeof adjustPoints>[2], string, number][] = [
      [{ entrant_id: p1, delta: -3, reason: "   " }, "RR_ADJUST_REASON_MISSING", 422],
      [{ entrant_id: p1, delta: 0, reason: REASON }, "RR_ADJUST_ZERO", 422],
      [{ entrant_id: p1, delta: Number.POSITIVE_INFINITY, reason: REASON }, "RR_ADJUST_NOT_FINITE", 422],
      [{ entrant_id: randomUUID(), delta: -3, reason: REASON }, "RR_ADJUST_UNKNOWN_ENTRANT", 422],
    ];
    for (const [input, code, status] of cases) {
      const err = await refusal(adjustPoints(r.auth, r.stageId, input));
      expect([err.status, err.code], code).toEqual([status, code]);
    }
    expect(cases).toHaveLength(4);
    expect(await loadPointsAdjustments(r.divisionId), "nothing written").toEqual([]);
  });

  it("C5: refused before Start and on a complete table; hidden and refused on a bracket stage", async () => {
    const unstarted = await rig({ n: 4, sport: FOOTBALL });
    const before = await refusal(adjustPoints(unstarted.auth, unstarted.stageId, { entrant_id: unstarted.ids[0]!, delta: -3, reason: REASON }));
    expect([before.status, before.code]).toEqual([422, "RR_ADJUST_NOT_STARTED"]);

    const r = await rig({ n: 3, sport: FOOTBALL });
    await startDivision(r.auth, r.divisionId);
    const lines = await rowsOf(r.stageId);
    for (const l of lines) await win(r, l.id, l.home_entrant_id, l.home_entrant_id!);
    // B3 m-1: an adjustment made while the table was live, then the table finishes
    const { adjustment: live } = await adjustPoints(r.auth, r.stageId, { entrant_id: r.ids[0]!, delta: -3, reason: REASON });
    await completeStage(r.auth, r.stageId);
    const done = await refusal(adjustPoints(r.auth, r.stageId, { entrant_id: r.ids[0]!, delta: -3, reason: REASON }));
    expect([done.status, done.code]).toEqual([422, "RR_ADJUST_STAGE_COMPLETE"]);
    // ...and its Undo is refused by the same name: a finished table is not re-ranked by an Undo either; the ledger does not move
    const ledger = async () => sql<{ seq: number }[]>`select seq::int as seq from division_events where division_id = ${r.divisionId} order by seq`;
    const was = await ledger();
    const undone = await refusal(undoPointsAdjustment(r.auth, r.stageId, live.seq));
    expect([undone.status, undone.code], "Undo on a complete table").toEqual([422, "RR_ADJUST_STAGE_COMPLETE"]);
    expect(await ledger(), "nothing written").toEqual(was);
    expect((await loadPointsAdjustments(r.divisionId)).map((a) => a.seq), "the adjustment stands").toEqual([live.seq]);

    // a knockout stage: refused by name whatever its state
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "ADJ KO " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const div = await createDivision(auth, comp.id, { name: "Open", slug: "ko-" + randomUUID().slice(0, 6), sport_key: "football", variant_key: FOOTBALL.variant, config: {} });
    const ents = await createEntrants(auth, div.id, ["A", "B", "C", "D"].map((n, i) => ({ kind: FOOTBALL.kind, display_name: n, seed: i + 1, members: [] })));
    const [ko] = await createStages(auth, div.id, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null });
    await generateStageFixtures(auth, ko!.id);
    await startDivision(auth, div.id);
    const bracket = await refusal(adjustPoints(auth, ko!.id, { entrant_id: ents[0]!.id, delta: -3, reason: REASON }));
    expect([bracket.status, bracket.code]).toEqual([422, "RR_ADJUST_NOT_TABLE"]);
    const read = await refusal(listPointsAdjustments(auth, ko!.id));
    expect([read.status, read.code], "the dialog's read too").toEqual([422, "RR_ADJUST_NOT_TABLE"]);
  });

  it("X-ADJ-4 Undo voids the adjustment and the table returns; a second Undo is refused by name", async () => {
    const r = await levelPair(FOOTBALL);
    const before = await table(r.stageId);
    const top = order(before)[0]!;
    const { adjustment } = await adjustPoints(r.auth, r.stageId, { entrant_id: top, delta: -3, reason: REASON });
    expect(order(await table(r.stageId)), "premise: the adjustment moved the table").not.toEqual(order(before));
    const undone = await undoPointsAdjustment(r.auth, r.stageId, adjustment.seq);
    expect(undone.undone).toBe(adjustment.seq);
    const back = await table(r.stageId);
    expect(order(back), "the table returns").toEqual(order(before));
    expect(back.map((x) => x.points)).toEqual(before.map((x) => x.points));
    expect(await loadPointsAdjustments(r.divisionId), "the footnote goes with it").toEqual([]);
    const again = await refusal(undoPointsAdjustment(r.auth, r.stageId, adjustment.seq));
    expect([again.status, again.code]).toEqual([409, "RR_ADJUST_ALREADY_UNDONE"]);
    // neither row is a division Undo step: the history lists both, neither undoable
    const rows = await sql<{ type: string }[]>`select type from division_events where division_id = ${r.divisionId} and type like 'points_adjustment%' order by seq`;
    expect(rows.map((x) => x.type)).toEqual(["points_adjustment", "points_adjustment_voided"]);
  });

  it("B3 m-2 an Undo names its own stage: another stage's adjustment is not found there, and nothing is written", async () => {
    const r = await levelPair(FOOTBALL);
    const [second] = await createStages(r.auth, r.divisionId, { seq: 2, kind: "league", name: "Second", config: {}, progression: null });
    const { adjustment } = await adjustPoints(r.auth, r.stageId, { entrant_id: r.ids[0]!, delta: -3, reason: REASON });
    const ledger = async () => sql<{ seq: number }[]>`select seq::int as seq from division_events where division_id = ${r.divisionId} order by seq`;
    const was = await ledger();
    const err = await refusal(undoPointsAdjustment(r.auth, second!.id, adjustment.seq));
    expect(err.status, "the seq is not an adjustment of THIS stage").toBe(404);
    expect(await ledger(), "nothing written").toEqual(was);
    expect((await loadPointsAdjustments(r.divisionId)).map((a) => [a.seq, a.stage_id]), "it still stands on its own stage").toEqual([[adjustment.seq, r.stageId]]);
  });

  it("B3 m-5 a refold that fails after the row is written does not fail the request: one row, so no retry doubles it", async () => {
    const r = await levelPair(FOOTBALL);
    const before = await table(r.stageId);
    const p2 = r.ids[1]!;
    refold.failNext = true;
    const { adjustment } = await adjustPoints(r.auth, r.stageId, { entrant_id: p2, delta: -3, reason: REASON });
    expect(refold.failNext, "premise: the refold was reached and threw").toBe(false);
    expect((await loadPointsAdjustments(r.divisionId)).map((a) => a.seq), "exactly one row").toEqual([adjustment.seq]);
    // the next refold (any score write) takes the −3, once
    await recomputeStandings(r.auth.orgId, r.stageId);
    expect(rowOf(await table(r.stageId), p2).points).toBe(rowOf(before, p2).points - 3);
    // the Undo the same way: its void row stands and the next refold returns the table
    refold.failNext = true;
    await undoPointsAdjustment(r.auth, r.stageId, adjustment.seq);
    expect(refold.failNext, "premise: the Undo's refold threw").toBe(false);
    expect(await loadPointsAdjustments(r.divisionId), "voided").toEqual([]);
    await recomputeStandings(r.auth.orgId, r.stageId);
    expect(rowOf(await table(r.stageId), p2).points).toBe(rowOf(before, p2).points);
  });

  it("B3 m-6 an amount is whole and at most 999 either way (ruling 4), refused by name; 999 itself is taken", async () => {
    const r = await levelPair(FOOTBALL);
    const p1 = r.ids[0]!;
    const cases = [1.5, -0.5, 1000, -1000, 1e9];
    for (const delta of cases) {
      const err = await refusal(adjustPoints(r.auth, r.stageId, { entrant_id: p1, delta, reason: REASON }));
      expect([err.status, err.code], String(delta)).toEqual([422, "RR_ADJUST_OUT_OF_RANGE"]);
    }
    expect(cases).toHaveLength(5);
    expect(await loadPointsAdjustments(r.divisionId), "nothing written").toEqual([]);
    for (const delta of [999, -999]) await adjustPoints(r.auth, r.stageId, { entrant_id: p1, delta, reason: REASON });
    expect((await loadPointsAdjustments(r.divisionId)).map((a) => a.delta), "the bounds themselves").toEqual([999, -999]);
  });

  // B3 ruling 2 (m-9): an adjustment is not a result. On a started table where nothing has been played, it moves its entrant but
  // the rest stay level - and a level table with nothing played draws no lots (W2d §5.8 step 1, anti-goal 3): its residual classes
  // take seed then id. The engine counts an adjustment as "holding something", so without the app's hold it drew lots for an unplayed
  // pool and stored them. Both units of the registry (points-led football, wins-led badminton); a sport whose cascade lists `seed`
  // before the lot (tennis, ice hockey) splits these classes by seed and never reaches the lot either way.
  it("B3 ruling 2 an adjustment on a table with nothing played draws no lots; the first level result draws as before", async () => {
    let swept = 0;
    for (const sport of [FOOTBALL, BADMINTON]) {
      const r = await rig({ n: 4, sport });
      await startDivision(r.auth, r.divisionId);
      const [p1, p2, p3, p4] = r.ids as [string, string, string, string];
      await adjustPoints(r.auth, r.stageId, { entrant_id: p4, delta: -1, reason: REASON });
      expect(await lotsRows(r.stageId), `${sport.key}: nothing played, nothing drawn`).toEqual([]);
      expect(order(await table(r.stageId)), `${sport.key}: the level three by seed (seed = position), the adjusted last`).toEqual([p1, p2, p3, p4]);
      // the positive pair: P1 beats P3 and P2 beats P4 by the same score - P1 and P2 level on everything, so the lot splits them
      const lines = await rowsOf(r.stageId);
      const a = lineBetween(lines, p1, p3);
      const b = lineBetween(lines, p2, p4);
      await win(r, a.id, a.home_entrant_id, p1);
      await win(r, b.id, b.home_entrant_id, p2);
      const drawn = await lotsRows(r.stageId);
      expect(drawn.map((d) => [...d.members].sort()), `${sport.key}: played now, the level pair is drawn`).toContainEqual([p1, p2].sort());
      swept++;
    }
    expect(swept).toBe(2);
  });

  it("X-ADJ-4 an adjustment that breaks a lots-split tie re-ranks without the stale draw (Review Focus 2)", async () => {
    const r = await levelPair(FOOTBALL);
    const [p1, p2, p3, p4] = r.ids as [string, string, string, string];
    const draws = await lotsRows(r.stageId);
    const topPair = draws.find((d) => d.members.includes(p1) && d.members.includes(p2));
    const bottomPair = draws.find((d) => d.members.includes(p3) && d.members.includes(p4));
    expect(topPair, "premise: lots split the level winners").toBeDefined();
    expect(bottomPair, "premise: lots split the level losers").toBeDefined();
    const before = await table(r.stageId);
    const top = order(before)[0]!;

    const { adjustment } = await adjustPoints(r.auth, r.stageId, { entrant_id: top, delta: -3, reason: REASON });
    const afterDraws = await lotsRows(r.stageId);
    expect(afterDraws.filter((d) => d.members.includes(top)), "no stored draw names the adjusted entrant").toEqual([]);
    expect(afterDraws.map((d) => d.id), "a tie the adjustment did not touch keeps its draw").toContain(bottomPair!.id);

    // the tie forms again (Undo): it draws FRESH - a new row, never the stale one
    await undoPointsAdjustment(r.auth, r.stageId, adjustment.seq);
    const fresh = (await lotsRows(r.stageId)).filter((d) => d.members.includes(p1) && d.members.includes(p2));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.id, "a new draw").not.toBe(topPair!.id);
    expect(fresh[0]!.drawn_at.getTime()).toBeGreaterThanOrEqual(topPair!.drawn_at.getTime());
  });

  it("X-ADJ-2 badminton −1 is one match's worth (the unit is the engine's: wins)", async () => {
    expect(declaredUnit(BADMINTON), "premise from the engine: badminton ranks by wins").toBe("wins");
    const r = await levelPair(BADMINTON);
    const before = await table(r.stageId);
    const top = order(before)[0]!;
    const { adjustment } = await adjustPoints(r.auth, r.stageId, { entrant_id: top, delta: -1, reason: REASON });
    expect(adjustment.unit).toBe("wins");
    const after = await table(r.stageId);
    expect(rowOf(after, top).won, "one match's worth").toBe(rowOf(before, top).won - 1);
    expect(rowOf(after, top).points, "points are not the unit here").toBe(rowOf(before, top).points);
  });

  it("C8 + X-ADJ-4 a deleted or unseated entrant's adjustment never reaches the fold: held, listed, and a score write still lands", async () => {
    const r = await levelPair(FOOTBALL);
    const before = await table(r.stageId);
    // the writer's shape for an entrant the table no longer holds (deleted before Start, or unseated by a Rebuild)
    const ghost = randomUUID();
    await withTenant(r.auth.orgId, async (tx) => {
      const [{ seq }] = await tx<{ seq: number }[]>`select coalesce(max(seq), 0)::int as seq from division_events where division_id = ${r.divisionId}`;
      await tx`insert into division_events (division_id, seq, type, payload) values (${r.divisionId}, ${seq + 1}, ${POINTS_ADJUSTMENT_ROW},
        ${tx.json({ stage_id: r.stageId, entrant_id: ghost, delta: -3, reason: REASON, unit: "points", points_unit: "whole" })})`;
    });
    await recomputeStandings(r.auth.orgId, r.stageId);
    expect(order(await table(r.stageId)), "held: the fold is not refused and does not move").toEqual(order(before));
    const listed = await listPointsAdjustments(r.auth, r.stageId);
    expect(listed.adjustments.map((a) => [a.entrant_id, a.held])).toEqual([[ghost, true]]);
    // a score write after it: the next line plays and the table takes it
    const [p1, , , p4] = r.ids as [string, string, string, string];
    const next = lineBetween(await rowsOf(r.stageId), p1, p4);
    await win(r, next.id, next.home_entrant_id, p1);
    expect(rowOf(await table(r.stageId), p1).played).toBe(rowOf(before, p1).played + 1);
  });

  it("the dialog's read: the engine's unit, the members by pool (a group stage), and a bracket refused by name", async () => {
    const r = await rig({ n: 6, kind: "group", pools: 2, sport: BADMINTON });
    await startDivision(r.auth, r.divisionId);
    const read = await listPointsAdjustments(r.auth, r.stageId);
    expect([read.unit, read.points_unit], "the engine's unit for badminton").toEqual([declaredUnit(BADMINTON), "whole"]);
    expect(read.adjustments).toEqual([]);
    const pools = await sql<{ key: string }[]>`select key from pools where stage_id = ${r.stageId} order by key`;
    expect(pools.map((p) => p.key), "premise: two pools").toEqual(["A", "B"]);
    expect(read.members.map((m) => m.entrant_id).sort(), "every seated entrant, once").toEqual([...r.ids].sort());
    expect(read.members.map((m) => m.pool), "in pool order, three each").toEqual(["A", "A", "A", "B", "B", "B"]);
    // a pool's member adjusted lists `held: false`
    await adjustPoints(r.auth, r.stageId, { entrant_id: read.members[0]!.entrant_id, delta: -1, reason: REASON });
    expect((await listPointsAdjustments(r.auth, r.stageId)).adjustments.map((a) => a.held)).toEqual([false]);
  });

  it("X-ADJ-5 Swiss: the next Pair uses the adjusted score", async () => {
    // differential: today no adjustment exists to read - without it the loser meets the other loser in round 2
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "ADJ SW " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const div = await createDivision(auth, comp.id, { name: "Open", slug: "sw-" + randomUUID().slice(0, 6), sport_key: "football", variant_key: FOOTBALL.variant, config: {} });
    const ents = await createEntrants(auth, div.id, ["A", "B", "C", "D"].map((n, i) => ({ kind: FOOTBALL.kind, display_name: n, seed: i + 1, members: [] })));
    const [stage] = await createStages(auth, div.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null });
    await startDivision(auth, div.id);
    await generateStageFixtures(auth, stage!.id);
    const r: Rig = { auth, divisionId: div.id, stageId: stage!.id, sport: FOOTBALL, ids: ents.map((e) => e.id) };
    const round = async (n: number) =>
      sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
        select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} and round_no = ${n}
           and home_entrant_id is not null and away_entrant_id is not null order by seq_in_round`;
    const r1 = await round(1);
    expect(r1, "premise: round 1 paired every player").toHaveLength(2);
    for (const b of r1) await win(r, b.id, b.home_entrant_id, b.home_entrant_id);
    const winners = new Set(r1.map((b) => b.home_entrant_id));
    const loser = r1[0]!.away_entrant_id;
    const otherLoser = r1[1]!.away_entrant_id;
    const score = async () => withTenant(auth.orgId, (tx) => stageTablePoints(tx, r.stageId));
    const was = (await score()).points.get(loser) ?? 0;
    // +6 puts the loser ALONE above the winners: the smallest float meets a winner, never the other loser
    await adjustPoints(auth, r.stageId, { entrant_id: loser, delta: 6, reason: "Restored after appeal" });
    expect((await score()).points.get(loser), "the score Pair next groups by is the adjusted one").toBe(was + 6);
    await generateStageFixtures(auth, r.stageId);
    const r2 = await round(2);
    const board = r2.find((b) => b.home_entrant_id === loser || b.away_entrant_id === loser);
    expect(board, "the adjusted player is paired in round 2").toBeDefined();
    const opponent = board!.home_entrant_id === loser ? board!.away_entrant_id : board!.home_entrant_id;
    expect(winners.has(opponent), "paired inside the adjusted score's reach: a round-1 winner").toBe(true);
    expect(opponent).not.toBe(otherLoser);
  });
});
