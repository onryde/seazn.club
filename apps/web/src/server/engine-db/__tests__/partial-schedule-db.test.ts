// W2d Task 12 (spec §5.6 "ST-G12", X-TB-8, IH-TB-2) — the web fold hands the ranker the stage's schedule
// (`scheduledPairsOf`) and the sport's partial-schedule order, so a half-played round robin is ranked by the guard, not
// by the meetings so far. Driven through the REAL write path (`scoreEvent` via `post`) and the REAL fold
// (`recomputeStandings` → `toTableStage` → `completeTableStage`): the seam a unit test cannot see (AGENTS.md class 1).
// Each expected order is typed from the rule text and the matches played, and differs from what the fold gives without
// the wiring (the h2h block on a partial mini-table puts B first in both cases).
import { afterAll, describe, expect, it } from "vitest";
import type { AuthCtx } from "@/server/api-v1/auth";
import { sql } from "@/lib/db";
import { generateStageFixtures } from "@/server/usecases/stages";
import { startDivision } from "@/server/usecases/schedule";
import { recomputeStandings } from "../competition";
import { seedBracket } from "./helpers/seed-bracket";
import { between, genericResult, tableScene } from "./helpers/w2d-table-rig";
import { post } from "./helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Row {
  entrantId: string;
  played: number;
  points: number;
  metrics: Record<string, number>;
  tieBreak?: { key: string; with: string[]; note?: string };
}

/** An ice hockey regulation result through the scorer's events: goals, then the three periods to full time. */
async function hockey(auth: AuthCtx, stageId: string, x: string, y: string, xGoals: number, yGoals: number): Promise<void> {
  const f = await between(stageId, x, y);
  await post(auth, f.id, "core.start");
  for (let i = 0; i < xGoals; i++) await post(auth, f.id, "icehockey.goal", { by: x });
  for (let i = 0; i < yGoals; i++) await post(auth, f.id, "icehockey.goal", { by: y });
  for (const to of ["P2", "P3", "FT"]) await post(auth, f.id, "icehockey.period.advance", { to });
  const [row] = await sql<{ status: string }[]>`select status from fixtures where id = ${f.id}`;
  if (row?.status !== "decided") throw new Error(`rig: ${x} v ${y} did not decide (${row?.status})`);
}

const byId = (rows: readonly Row[], id: string): Row => {
  const row = rows.find((r) => r.entrantId === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};

describe.skipIf(!HAS_DB)("W2d T12: the web fold ranks a half-played round robin by the ST-G12 guard", () => {
  it("X-TB-8 IH-TB-2 ice hockey: a 3-way tie on a half-played league is ordered fewest played → GD (RBG:349-350), not by the one meeting so far", async () => {
    // single-sport: ice hockey is the one sport that declares a partial-schedule order (the engine's sweep counts it);
    // the generic case below is the sport-agnostic skip.
    const s = await seedBracket({ sport: "icehockey", variant: "iihf", stageKind: "league", entrants: 4 });
    const seeded = await sql<{ id: string }[]>`select id from entrants where division_id = ${s.divisionId} order by seed`;
    const [A, B, C, D] = seeded.map((e) => e.id) as [string, string, string, string];
    // A beat D 3-0; B beat C 2-1; C beat D 4-0. A–B, A–C, B–D still to play. A, B, C on 3 points (IIHF W 3).
    await hockey(s.auth, s.stageId, A, D, 3, 0);
    await hockey(s.auth, s.stageId, B, C, 2, 1);
    await hockey(s.auth, s.stageId, C, D, 4, 0);
    const rows = (await recomputeStandings(s.auth.orgId, s.stageId)) as readonly Row[];
    expect(rows.map((r) => [r.points, r.played])).toEqual([[3, 1], [3, 1], [3, 2], [0, 2]]);
    // Fewest played: A and B (1) above C (2); then GD: A (+3) above B (+1).
    expect(rows.map((r) => r.entrantId)).toEqual([A, B, C, D]);
    // T17 fix 1 (spec anti-goal 2, spec:113-115; §5.6, spec:480): the class has not all met, and a later step split it —
    // the stored row says head-to-head is not complete (T12 pinned these note-free; that was the spec's anti-goal).
    expect(byId(rows, C).tieBreak).toEqual({ key: "fewest_played", with: [A, B], note: "h2h_incomplete" });
    expect(byId(rows, A).tieBreak).toEqual({ key: "diff", with: [B], note: "h2h_incomplete" });
    // Played out: A beat B 1-0, C beat A 2-0, B beat D 5-0 — the mini-schedule among A, B and C is complete,
    // all three on 6, and the IIHF block decides: H2H GD C +1, B 0, A −1.
    await hockey(s.auth, s.stageId, A, B, 1, 0);
    await hockey(s.auth, s.stageId, C, A, 2, 0);
    await hockey(s.auth, s.stageId, B, D, 5, 0);
    const done = (await recomputeStandings(s.auth.orgId, s.stageId)) as readonly Row[];
    expect(done.slice(0, 3).map((r) => r.points)).toEqual([6, 6, 6]);
    expect(done.map((r) => r.entrantId)).toEqual([C, B, A, D]);
    expect(byId(done, C).tieBreak?.key).toBe("h2h_diff");
    // The block ran on a complete mini-schedule and answered: no row keeps the note.
    expect(done.filter((r) => r.tieBreak?.note === "h2h_incomplete")).toEqual([]);
  }, 240_000);

  it("X-TB-8 generic: the block is skipped for a class whose meetings are still to play, and the stored row says why ('h2h_incomplete')", async () => {
    // generic ranks points, diff, for, h2h_points, lots. A beat D 1-0, B beat C 1-0, C beat D 1-0: A and B on 3 points,
    // GD +1, GF 1 each; C on 3, GD 0. A–B is still to play, so h2h_points does not split them: lots, noted.
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    const [A, B, C, D] = s.entrants as [string, string, string, string];
    await generateStageFixtures(s.auth, stageId);
    await startDivision(s.auth, s.divisionId);
    await genericResult(s.auth, stageId, A, D, 1, 0);
    await genericResult(s.auth, stageId, B, C, 1, 0);
    await genericResult(s.auth, stageId, C, D, 1, 0);
    const rows = (await recomputeStandings(s.auth.orgId, stageId)) as readonly Row[];
    expect(rows.slice(2).map((r) => r.entrantId)).toEqual([C, D]);
    for (const id of [A, B]) {
      expect(byId(rows, id).tieBreak, id).toMatchObject({ key: "lots", with: [A, B].filter((x) => x !== id), note: "h2h_incomplete" });
    }
    // The snapshot the public table reads holds the note too.
    const [snap] = await sql<{ rows: Row[] }[]>`select rows from standings_snapshots where stage_id = ${stageId} and pool_id is null`;
    expect(snap!.rows.filter((r) => r.tieBreak?.note === "h2h_incomplete").map((r) => r.entrantId).sort()).toEqual([A, B].sort());
    // Played: B beat A 2-0 — the meeting is decided and B moves clear on points; no row carries the note any more.
    await genericResult(s.auth, stageId, B, A, 2, 0);
    const after = (await recomputeStandings(s.auth.orgId, stageId)) as readonly Row[];
    expect(after.filter((r) => r.tieBreak?.note === "h2h_incomplete")).toEqual([]);
  }, 240_000);
});
