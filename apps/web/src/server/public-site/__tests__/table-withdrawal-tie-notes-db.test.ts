// W5 final fix wave (G1; whole-PR review I1): a leaver ranked last takes her tie notes with her - on the STORED snapshot every
// table surface reads, and on the hub's rendered rows.
//
// The engine writes `tieBreak` on the PRE-move table: P1 level on points with P4 and split on head-to-head reads "Tied with P4"
// on P1's row and "Tied with P1" on P4's. Once P1 is ranked last (`departedRankedLast`, RB5-W1) that note is false on both rows.
// Through the REAL producers: a real two-pool group, Started, scored through `scoreEvent` (forfeits), the real cascade
// (`withdrawEntrantCascade`), then the stored `standings_snapshots` rows and the hub's own document (`loadCompetitionHub`).
//
// Premise (read BEFORE the withdrawal, so a vacuous setup fails): the leaver is named by a competing row's tie note.
// Control (the positive pair of every negative): the two rows who stay tied keep their note, naming each other and nobody else.
// Single-sport (badminton): the strip is sport-blind (one shared re-rank); X-WDT-7's ruling-290 tests carry the other sports.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import { CreateStage } from "@/server/api-v1/schemas";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { createStages } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { loadCompetitionHub } from "../competition-hub";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Line = { id: string; pool_id: string | null; home_entrant_id: string; away_entrant_id: string };
type SnapRow = { entrantId: string; rank: number | null; tieUnbroken?: boolean; tieBreak?: { key: string; with: string[] } };

async function twoPools() {
  const { auth } = await seedOrg("pro");
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "G1 tie notes " + randomUUID().slice(0, 6), visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Groups", slug: "groups-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
  const created = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 8 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `P${i + 1}`,
      seed: i + 1,
      members: [{ new_person: { full_name: `P${i + 1} ${randomUUID().slice(0, 6)}` }, is_captain: false, roles: [] }],
    })),
  );
  const [d] = buildTemplateStages("group_only", { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 });
  const [stage] = await createStages(auth, division.id, CreateStage.parse({ seq: 1, kind: d!.kind, name: d!.name, config: d!.config, progression: d!.progression }));
  await startDivision(auth, division.id);
  const [{ slug: compSlug }] = await sql<{ slug: string }[]>`select slug from competitions where id = ${comp.id}`;
  const lines = await sql<Line[]>`select id, pool_id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round, id`;
  return { auth, orgSlug, compSlug, divisionId: division.id, stageId: stage!.id, ids: created.map((e) => e.id), lines };
}

const snapshotRows = async (stageId: string, poolId: string): Promise<SnapRow[]> => {
  const [snap] = await sql<{ rows: SnapRow[] }[]>`select rows from standings_snapshots where stage_id = ${stageId} and pool_id = ${poolId}`;
  return snap!.rows;
};

describe.runIf(HAS_DB)("a leaver ranked last takes her tie notes with her (I1)", () => {
  it("a leaver level on points with a competitor: the snapshot and the hub name nobody across the departed boundary; the two who stay tied keep their note", async () => {
    const r = await twoPools();
    const poolId = r.lines[0]!.pool_id!;
    const poolLines = r.lines.filter((l) => l.pool_id === poolId);
    const members = [...new Set(poolLines.flatMap((l) => [l.home_entrant_id, l.away_entrant_id]))];
    expect(members, "premise: a pool of four, one leg: six lines").toHaveLength(4);
    expect(poolLines).toHaveLength(6);
    const [a, b, c, d] = members as [string, string, string, string];
    // Winner of each pairing, by hand. a: W c, W d, L b (2 wins); b: W a, W c, L d (2 wins); c: W d (1); d: W b (1).
    // So a and b are level on wins and split on head-to-head (b beat a); c and d likewise (c beat d).
    const winner = new Map<string, string>([
      [[a, b].sort().join("|"), b],
      [[a, c].sort().join("|"), a],
      [[a, d].sort().join("|"), a],
      [[b, c].sort().join("|"), b],
      [[b, d].sort().join("|"), d],
      [[c, d].sort().join("|"), c],
    ]);
    for (const l of poolLines) {
      const win = winner.get([l.home_entrant_id, l.away_entrant_id].sort().join("|"))!;
      await post(r.auth, l.id, "core.forfeit", { by: win === l.home_entrant_id ? l.away_entrant_id : l.home_entrant_id, reason: "walkover" });
    }
    // The pool B lines stay unplayed: only pool A is under test.

    const before = await snapshotRows(r.stageId, poolId);
    expect(before, "premise: the pool's four rows are ranked").toHaveLength(4);
    const namingA = before.filter((x) => x.entrantId !== a && x.tieBreak?.with.includes(a));
    expect(namingA.length, "premise: before she leaves, a competing row's tie note names her (a is level with b)").toBeGreaterThan(0);

    const out = await withdrawEntrantCascade(r.auth, a);
    expect(out.policy, "RB5-W2: three of three played is at least half: she stays, her results count (the engine names that policy walkover)").toBe("walkover");

    const after = await snapshotRows(r.stageId, poolId);
    expect(after.map((x) => x.entrantId).sort(), "her row stays in the table").toEqual([...members].sort());
    const rowOf = (rows: SnapRow[], id: string) => rows.find((x) => x.entrantId === id)!;
    expect(rowOf(after, a).rank, "RB5-W1: ranked last").toBe(4);
    expect(rowOf(after, a).tieBreak, "a leaver carries no tie note").toBeUndefined();
    expect(rowOf(after, a).tieUnbroken).toBeUndefined();
    let checked = 0;
    for (const row of after.filter((x) => x.entrantId !== a)) {
      checked += 1;
      expect(row.tieBreak?.with ?? [], `${row.entrantId} must not name the leaver`).not.toContain(a);
    }
    expect(checked, "anti-vacuity: every competing row was read").toBe(3);
    // Control: c and d are still level on wins, split on head-to-head, and still say so, naming each other only.
    expect(rowOf(after, c).tieBreak?.with, "control: c still names d").toEqual([d]);
    expect(rowOf(after, d).tieBreak?.with, "control: d still names c").toEqual([c]);
    expect(rowOf(after, b).tieBreak, "b was tied only with the leaver: no note left").toBeUndefined();

    // The hub's rendered rows (the public surface the review reproduced it on).
    const doc = CompetitionHubDoc.parse(await loadCompetitionHub(r.orgSlug, r.compSlug, new Date(), { uncached: true }));
    const table = doc.tables.filter((t) => t.divisionId === r.divisionId).find((t) => t.rows.some((x) => x.entrantId === a))!;
    expect(table, "the hub shows her pool").toBeDefined();
    const hubA = table.rows.find((x) => x.entrantId === a)!;
    const hubB = table.rows.find((x) => x.entrantId === b)!;
    const hubC = table.rows.find((x) => x.entrantId === c)!;
    expect(hubA.tieBreakText, "the hub: she reads no 'Tied with'").toBeNull();
    expect(hubB.tieBreakText, "the hub: b reads no 'Tied with'").toBeNull();
    expect(hubC.tieBreakText, "control: the hub still explains c's split from d").not.toBeNull();
  }, 240_000);
});
