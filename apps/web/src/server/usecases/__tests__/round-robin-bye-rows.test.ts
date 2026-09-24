// #850 — a round-robin stage persists the engine's per-round bye as a REAL row.
//
// OWNER RULING (2026-09-23, _INDEX.md "Issue 850"): league/group byes become a
// persisted row per round, the same shape as the Swiss bye (one seat filled,
// `forfeited`, `{kind:"award", winner}`), awarding NO points.
//
// Every expectation here is read back from the REAL rows the REAL generator
// (`generateStageFixtures` → `generate` → `roundRobinGen`) wrote, and the
// expected holder of each round's bye is the ENGINE's own
// `generateRoundRobin(...).rounds[i].bye` — never a hand-typed table. The W2
// bye suite hand-built `outcome` objects and was green for a shape the product
// never produced (_INDEX.md "Standing warning"); this file is the opposite.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import { isOneSidedAwardBye, isRestBye } from "@/lib/fixture-bye";
import { msg } from "@/lib/messages";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant } from "../entrants";
import {
  createStages,
  generateStageFixtures,
  previewDivisionFixtures,
  rebuildStageFixtures,
} from "../stages";
import { redoDivision, undoDivision } from "../history";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Row {
  id: string;
  ext_key: string | null;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  fixture_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key?: string } | null;
  away_slot_label: { key?: string } | null;
  status: string;
  outcome: unknown;
  scheduled_at: unknown;
  court_id: string | null;
}

async function rowsOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, ext_key, pool_id, round_no, seq_in_round, fixture_no, home_entrant_id, away_entrant_id,
           home_slot_label, away_slot_label, status, outcome, scheduled_at, court_id
    from fixtures where stage_id = ${stageId} order by fixture_no`;
}

async function seedStage(
  auth: AuthCtx,
  n: number,
  stage: { kind: "league" | "group"; config?: Record<string, unknown> },
): Promise<{ divisionId: string; stageId: string; entrants: { id: string; seed: number }[] }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "RR bye " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const created = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [st] = await createStages(auth, division.id, {
    seq: 1,
    kind: stage.kind,
    name: stage.kind === "league" ? "League" : "Groups",
    config: stage.config ?? {},
    progression: null,
  });
  return {
    divisionId: division.id,
    stageId: st!.id,
    entrants: created.map((e, i) => ({ id: e.id, seed: i + 1 })),
  };
}

/** The engine's own answer for one round robin over these entrants — the same
 *  call `roundRobinGen` makes (ids + seed map), so the expectation is the
 *  source of truth rather than a copy of it. */
function engineByes(entrants: { id: string; seed: number }[], legs = 1): Map<number, string> {
  const schedule = generateRoundRobin({
    entrants: entrants.map((e) => e.id),
    seeds: new Map(entrants.map((e) => [e.id, e.seed])),
    config: { legs },
  });
  const out = new Map<number, string>();
  for (const r of schedule.rounds) if (r.bye !== undefined) out.set(r.roundNo, r.bye);
  return out;
}

const isByeRow = (r: Row) => isOneSidedAwardBye(r);

describe.skipIf(!HAS_DB)("#850 round-robin bye rows — the real generator, read back", () => {
  it("a 5-entrant league writes exactly one bye row per round, held by the engine's round.bye", async () => {
    const { auth } = await seedOrg();
    const { stageId, entrants } = await seedStage(auth, 5, { kind: "league" });
    const out = await generateStageFixtures(auth, stageId);
    const rows = await rowsOf(stageId);

    const expected = engineByes(entrants);
    expect(expected.size).toBe(5); // premise: 5 rounds, every one with a sit-out
    const byes = rows.filter(isByeRow);
    expect(byes).toHaveLength(expected.size);
    for (const [round, holder] of expected) {
      const inRound = byes.filter((b) => b.round_no === round);
      expect(inRound, `round ${round}`).toHaveLength(1);
      const b = inRound[0]!;
      expect(b.home_entrant_id).toBe(holder);
      expect(b.away_entrant_id).toBeNull();
      expect(b.status).toBe("forfeited");
      expect(b.outcome).toEqual({ kind: "award", winner: holder });
      expect(b.away_slot_label?.key).toBe("bracket.slot.bye");
      expect(b.home_slot_label).toBeNull();
      expect(b.ext_key).toBe(`rr-r${round}-bye`);
      // Never placed: no time, no court.
      expect(b.scheduled_at).toBeNull();
      expect(b.court_id).toBeNull();
      // Seated after the round's two boards.
      expect(b.seq_in_round).toBe(3);
      expect(isRestBye(b, "league")).toBe(true);
    }
    // The bye holder of a round plays nobody that round.
    for (const b of byes) {
      const busy = rows.filter(
        (r) => r.round_no === b.round_no && !isByeRow(r) && (r.home_entrant_id === b.home_entrant_id || r.away_entrant_id === b.home_entrant_id),
      );
      expect(busy).toEqual([]);
    }
    // The ten matches are untouched: both seats, scheduled.
    const matches = rows.filter((r) => !isByeRow(r));
    expect(matches).toHaveLength(10);
    expect(matches.every((m) => m.home_entrant_id !== null && m.away_entrant_id !== null && m.status === "scheduled")).toBe(true);
    // Organiser-facing counts are MATCHES (the notice reads "Generated 10").
    expect(out.created).toBe(10);
    expect(out.existing).toBe(0);
    // ...while the row listing is every row of the stage.
    expect(out.fixtures).toHaveLength(15);
  });

  it("real matches keep fixture numbers 1..M; bye rows are numbered after them", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedStage(auth, 5, { kind: "league" });
    await generateStageFixtures(auth, stageId);
    const rows = await rowsOf(stageId);
    const matchNos = rows.filter((r) => !isByeRow(r)).map((r) => r.fixture_no).sort((a, b) => a - b);
    expect(matchNos).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(rows.filter(isByeRow).every((b) => b.fixture_no > 10)).toBe(true);
  });

  it("a double round robin writes a bye per round of EACH leg, the same holder a leg later", async () => {
    const { auth } = await seedOrg();
    const { stageId, entrants } = await seedStage(auth, 5, { kind: "league", config: { legs: 2 } });
    await generateStageFixtures(auth, stageId);
    const byes = (await rowsOf(stageId)).filter(isByeRow);
    const expected = engineByes(entrants, 2);
    expect(expected.size).toBe(10);
    expect(byes).toHaveLength(10);
    for (const [round, holder] of expected) {
      expect(byes.find((b) => b.round_no === round)?.home_entrant_id, `round ${round}`).toBe(holder);
    }
    // Leg 2 mirrors leg 1: round r+5 rests the same entrant as round r.
    for (let r = 1; r <= 5; r++) expect(expected.get(r + 5)).toBe(expected.get(r));
  });

  it("a group stage writes byes per POOL: the odd pool gets one a round, the even pool none", async () => {
    const { auth } = await seedOrg();
    // 7 seeds snake into two pools of 3 and 4.
    const { stageId, entrants } = await seedStage(auth, 7, { kind: "group", config: { pools: { count: 2 } } });
    await generateStageFixtures(auth, stageId);
    const rows = await rowsOf(stageId);
    const pools = [...new Set(rows.map((r) => r.pool_id))];
    expect(pools).toHaveLength(2);
    const seedOf = new Map(entrants.map((e) => [e.id, e]));
    let oddPools = 0;
    for (const pool of pools) {
      const inPool = rows.filter((r) => r.pool_id === pool);
      const members = [...new Set(inPool.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]))]
        .filter((id): id is string => id !== null)
        .map((id) => seedOf.get(id)!)
        .sort((a, b) => a.seed - b.seed);
      const expected = engineByes(members);
      const byes = inPool.filter(isByeRow);
      expect(byes).toHaveLength(expected.size);
      for (const [round, holder] of expected) {
        const b = byes.find((x) => x.round_no === round);
        expect(b?.home_entrant_id).toBe(holder);
        expect(b?.ext_key).toMatch(/^p[A-Z]-rr-r\d+-bye$/);
        expect(isRestBye(b!, "group")).toBe(true);
      }
      if (members.length % 2 === 1) oddPools++;
      else expect(byes).toEqual([]);
    }
    expect(oddPools).toBe(1); // premise: exactly one odd pool
    // Every pool's matches are numbered before any pool's bye: the real
    // matches keep 1..M, exactly as before bye rows existed.
    const matchNos = rows.filter((r) => !isByeRow(r)).map((r) => r.fixture_no).sort((a, b) => a - b);
    expect(matchNos).toEqual(Array.from({ length: matchNos.length }, (_, i) => i + 1));
  });

  it("an EVEN field writes no bye row at all", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedStage(auth, 4, { kind: "league" });
    const out = await generateStageFixtures(auth, stageId);
    const rows = await rowsOf(stageId);
    expect(rows).toHaveLength(6);
    expect(rows.filter(isByeRow)).toEqual([]);
    expect(out.created).toBe(6);
  });

  it("the smallest odd field (3) rests one entrant each of its 3 rounds", async () => {
    const { auth } = await seedOrg();
    const { stageId, entrants } = await seedStage(auth, 3, { kind: "league" });
    await generateStageFixtures(auth, stageId);
    const byes = (await rowsOf(stageId)).filter(isByeRow);
    expect(byes.map((b) => [b.round_no, b.home_entrant_id])).toEqual(
      [...engineByes(entrants)].sort((a, b) => a[0] - b[0]),
    );
    // Each entrant rests exactly once.
    expect(new Set(byes.map((b) => b.home_entrant_id)).size).toBe(3);
  });

  it("re-Generate is idempotent: no duplicate bye rows, nothing new counted", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedStage(auth, 5, { kind: "league" });
    await generateStageFixtures(auth, stageId);
    const before = await rowsOf(stageId);
    const again = await generateStageFixtures(auth, stageId);
    const after = await rowsOf(stageId);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(again.created).toBe(0);
    expect(again.existing).toBe(10);
  });

  it("Rebuild is not blocked by bye rows, deletes them and writes them again", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedStage(auth, 5, { kind: "league" });
    await generateStageFixtures(auth, stageId);
    const before = (await rowsOf(stageId)).filter(isByeRow);
    const out = await rebuildStageFixtures(auth, stageId);
    const after = (await rowsOf(stageId)).filter(isByeRow);
    expect(after).toHaveLength(5);
    // Fresh rows (the rebuild deleted the old ones), same holders per round.
    expect(after.some((b) => before.some((x) => x.id === b.id))).toBe(false);
    expect(after.map((b) => [b.round_no, b.home_entrant_id]).sort()).toEqual(
      before.map((b) => [b.round_no, b.home_entrant_id]).sort(),
    );
    // "Rebuilt — N fixture(s) replaced" counts the matches, like `created`.
    expect(out.removed).toBe(10);
    expect(out.created).toBe(10);
  });

  it("Undo of the generation removes the bye rows with the matches; Redo writes them back settled", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 5, { kind: "league" });
    await generateStageFixtures(auth, stageId);
    const before = (await rowsOf(stageId)).filter(isByeRow);
    expect(before).toHaveLength(5);
    await undoDivision(auth, divisionId);
    expect(await rowsOf(stageId)).toEqual([]);
    await redoDivision(auth, divisionId);
    const after = (await rowsOf(stageId)).filter(isByeRow);
    expect(after.map((b) => [b.round_no, b.home_entrant_id, b.status, b.ext_key])).toEqual(
      before.map((b) => [b.round_no, b.home_entrant_id, b.status, b.ext_key]),
    );
  });

  it("deleting a bye holder before Start takes its rest-bye rows with it — no seatless award is left behind", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedStage(auth, 5, { kind: "league" });
    await generateStageFixtures(auth, stageId);
    const before = await rowsOf(stageId);
    const victimBye = before.find(isByeRow)!;
    const victim = victimBye.home_entrant_id!;
    await deleteEntrant(auth, victim);
    const after = await rowsOf(stageId);
    // The victim's own bye row is gone...
    expect(after.some((r) => r.id === victimBye.id)).toBe(false);
    // ...and nothing is left carrying an award with neither seat filled.
    expect(
      after.filter((r) => r.home_entrant_id === null && r.away_entrant_id === null && (r.outcome as { kind?: string } | null)?.kind === "award"),
    ).toEqual([]);
    // Every OTHER entrant's bye row survives untouched (positive pair).
    expect(after.filter(isByeRow)).toHaveLength(4);
    // The victim's real matches keep issue #837's half-filled shape — not this
    // change's to alter.
    const victimMatches = before.filter((r) => !isByeRow(r) && (r.home_entrant_id === victim || r.away_entrant_id === victim));
    expect(victimMatches).toHaveLength(4);
    for (const m of victimMatches) {
      const now = after.find((r) => r.id === m.id)!;
      expect((now.home_entrant_id === null) !== (now.away_entrant_id === null)).toBe(true);
    }
  });

  it("the Show-example preview still lists MATCHES only — no rest bye shows as 'vs Bye'", () => {
    const [phase] = previewDivisionFixtures([{ kind: "league", name: "League", config: { legs: 1 }, progression: null }], 5);
    const matches = phase!.sections.flatMap((s) => s.matches);
    expect(matches).toHaveLength(10);
    const bye = msg("bracket.slot.bye");
    expect(matches.some((m) => m.away === bye || m.home === bye)).toBe(false);
  });
});
