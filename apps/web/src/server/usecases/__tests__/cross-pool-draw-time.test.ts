// W5 app PR B D-B2-2 (live matrix): a draw the engine must REFUSE searched every ordering first - 5 pools Top 31 held one
// confirm for 196 s, and past the builder's bounds a draw it would FIND can search as long (12 pools Top 49: past 90 s). Every
// field the API accepts now answers in under 2 s: a refusal is settled from the engine's own rule before its search runs
// (`crossPoolSeparable`), and a field past the bounds the draw was measured over is refused by name. Driven through the real
// `drawAcrossPools` (the one call site of `crossPoolDraw` on the server); a `seed` is passed, so no database is read.
// "In time" is the thread's CPU time for the call (`process.threadCpuUsage`), under BUDGET_MS.
// Single-sport on purpose: the draw reads pools, tiers and a seed - no sport reaches it.
import { describe, expect, it } from "vitest";
import { crossPoolDraw, nextPowerOfTwo, seedPositions } from "@seazn/engine/scheduling";
import type { ProgressionSpec, SourceTables, StandingsRow } from "@seazn/engine/competition";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { crossPoolDrawCanRefuse } from "@/lib/cross-pool-draw-risk";
import { buildTemplateStages } from "@/lib/format-templates";
import type { CrossPoolEntry } from "@/lib/cross-pool-ties";
import { drawAcrossPools } from "../stages/cross-pool-draw";
import type { Tx } from "../stages/types";

const POOL_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BUDGET_MS = 2000;
const SEED = 7;

type Entry = CrossPoolEntry & { seed: number };

/** `pools` pools, `full` places from each (rank 1..full), then the next rank from the pools in `partial` (one best-Nth seat each).
 *  Every row has its own points, so no two seeds are level across pools: no tie reorders the fold, and the draw's tier 1 is the
 *  fold's own order (A1, B1, ...). Seeds are tier-major, pool order within a tier (the resolver's). */
function field(pools: number, full: number, partial: string): { qualifiers: Entry[]; tables: SourceTables[] } {
  const keys = [...POOL_KEYS.slice(0, pools)];
  const rows = (pool: string, p: number): StandingsRow[] =>
    Array.from({ length: full + 1 }, (_, r) => ({ entrantId: `${pool}${r + 1}`, rank: r + 1, played: full, won: 0, drawn: 0, lost: 0, points: 100_000 - 100 * r - p, metrics: {} }) as StandingsRow);
  const tables: SourceTables[] = [{ pools: keys.map((pool, p) => ({ pool, rows: rows(pool, p) })) }];
  const qualifiers: Entry[] = [];
  for (let rank = 1; rank <= full; rank++) for (const pool of keys) qualifiers.push({ entrantId: `${pool}${rank}`, sourceIndex: 0, pool, descriptor: { kind: "group_rank", rank }, seed: qualifiers.length + 1 });
  for (const pool of partial) qualifiers.push({ entrantId: `${pool}${full + 1}`, sourceIndex: 0, pool, descriptor: { kind: "best_nth", nth: full + 1 }, basis: { levelWith: [] }, seed: qualifiers.length + 1 });
  return { qualifiers, tables };
}

const progression = { placement: "rank_order", sources: [{ stageId: "src", take: [{ kind: "topNPerGroup", n: 1 }] }] } as unknown as ProgressionSpec;
const noTx = undefined as unknown as Tx;

async function timed(kind: string, f: { qualifiers: Entry[]; tables: SourceTables[] }) {
  let engineCalls = 0;
  const draw: typeof crossPoolDraw = (...args) => {
    engineCalls++;
    return crossPoolDraw(...args);
  };
  // The draw is one synchronous search on this thread, so its cost is this thread's CPU time: a wall clock read 2.1 s for a 0.5 s
  // engine call while four engine probes shared the machine, and CI runs test files side by side.
  const cpu0 = process.threadCpuUsage();
  const out = await drawAcrossPools(noTx, { id: "ko", kind }, progression, f.qualifiers, f.tables, { seed: SEED, draw });
  const cpu = process.threadCpuUsage(cpu0);
  return { out, ms: (cpu.user + cpu.system) / 1000, engineCalls };
}

/** The rulebook's reason a field cannot be drawn, read off the fold (never off the code under test): the field's last seed is the
 *  only seat of its tier, so it cannot move, and its round-one opponent (`seedPositions`) is a pool winner - tier 1 keeps its fold
 *  place - from the same pool. */
function loneSeatMeetsOwnWinner(f: { qualifiers: Entry[] }): boolean {
  const n = f.qualifiers.length;
  const pos = seedPositions(nextPowerOfTwo(n));
  const at = pos.indexOf(n);
  const opponent = pos[at % 2 === 0 ? at + 1 : at - 1]!;
  const last = f.qualifiers[n - 1]!;
  const lone = f.qualifiers.filter((q) => q.descriptor.kind === last.descriptor.kind && ("rank" in q.descriptor ? q.descriptor.rank : q.descriptor.nth) === ("rank" in last.descriptor ? last.descriptor.rank : last.descriptor.nth)).length === 1;
  const opp = f.qualifiers[opponent - 1]!;
  return lone && opp.descriptor.kind === "group_rank" && opp.descriptor.rank === 1 && opp.pool === last.pool;
}

describe("a cross-pool draw answers in time: refused before the search, or refused past the bounds it was measured over (D-B2-2)", () => {
  // Every refused field of the builder's space (pools 2-8, Top 2-32, one best-Nth seat) whose search outgrows 10^7 orderings, with
  // the engine's own measured answer where it gave one: 3 pools Top 31 refused in 20 ms, 4 pools Top 29 in 1.1 s, 5 pools Top 31 in
  // 196 s (the live matrix); 6, 7 and 8 pools had not answered after 60 s.
  const SLOW_REFUSALS: [number, number, string][] = [
    [3, 10, "B"],
    [4, 7, "D"],
    [5, 6, "B"],
    [6, 5, "B"],
    [7, 4, "D"],
    [8, 3, "H"],
  ];

  it(`every slow refused field of the builder's space is refused by name in under ${BUDGET_MS} ms, the engine is never asked, and the builder warned`, async () => {
    let checked = 0;
    for (const [pools, full, partial] of SLOW_REFUSALS) {
      const f = field(pools, full, partial);
      const name = `${pools} pools Top ${f.qualifiers.length}`;
      expect(loneSeatMeetsOwnWinner(f), `${name}: the premise - its lone last seat meets its own pool's winner`).toBe(true);
      const { out, ms, engineCalls } = await timed("knockout", f);
      expect(out?.refused, name).toEqual({ code: "SEEDING_POOL_SEPARATION_IMPOSSIBLE", vars: { pool: partial, count: full + 1, entrants: f.qualifiers.length, shape: "single_elim" } });
      expect(out?.qualifiers.map((q) => q.seed), `${name}: a refused draw keeps the fold's seats`).toEqual(f.qualifiers.map((q) => q.seed));
      expect(engineCalls, `${name}: settled before the engine's search`).toBe(0);
      expect(ms, `${name}: in time`).toBeLessThan(BUDGET_MS);
      // Review m-1: the builder warned before Start for this very field - groups_ko over `pools` pools, Top n, takes `full` places
      // per pool and one best (full+1)th, the field above.
      const stages = buildTemplateStages("groups_ko", { qualified: f.qualifiers.length, poolCount: pools, swissRounds: 3, legs: 1 });
      expect(stages[1]?.progression?.sources[0]?.take, `${name}: the premise - the builder's drafts take this field`).toEqual([
        { kind: "topNPerGroup", n: full },
        expect.objectContaining({ kind: "bestNth", nth: full + 1, count: 1 }),
      ]);
      expect(crossPoolDrawCanRefuse(stages), `${name}: the builder warns before Start`).toBe(true);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(SLOW_REFUSALS.length);
  });

  it("past the builder's bounds a field the draw WOULD find is refused by name, never searched (12 pools Top 49; the API's widest, 26 pools x 16)", async () => {
    const maxPools = FORMAT_BOUNDS.pools.max;
    const cases: [string, number, number, string][] = [
      ["12 pools Top 49 (the engine searched past 90 s)", 12, 4, "D"],
      ["26 pools x 16, the widest field the API accepts (pool keys A-Z, topNPerGroup <= 16)", 26, 16, ""],
      ["9 pools Top 18: one pool past the bound", maxPools + 1, 2, ""],
      ["4 pools Top 33: one qualifier past the bound", 4, 8, "A"],
    ];
    let checked = 0;
    for (const [name, pools, full, partial] of cases) {
      for (const kind of ["knockout", "stepladder"]) {
        const f = field(pools, full, partial);
        const { out, ms, engineCalls } = await timed(kind, f);
        expect(out?.refused, `${name} (${kind})`).toEqual({
          code: "SEEDING_CROSS_POOL_DRAW_TOO_LARGE",
          vars: { pools, entrants: f.qualifiers.length, maxPools: FORMAT_BOUNDS.pools.max, maxEntrants: FORMAT_BOUNDS.qualify.max },
        });
        expect(engineCalls, `${name} (${kind}): never searched`).toBe(0);
        expect(ms, `${name} (${kind}): in time`).toBeLessThan(BUDGET_MS);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(8);
  });

  it("at the bounds the engine still draws, as the engine draws it: 8 pools Top 32, and the slowest found field (6 pools Top 25, 0.5 s here)", async () => {
    const cases: [string, number, number, string][] = [
      ["8 pools Top 32", 8, 4, ""],
      ["6 pools Top 25, B the best fifth", 6, 4, "B"],
      ["2 pools Top 3, A the best runner-up", 2, 1, "A"],
    ];
    let checked = 0;
    for (const [name, pools, full, partial] of cases) {
      const f = field(pools, full, partial);
      const { out, ms, engineCalls } = await timed("knockout", f);
      const engine = crossPoolDraw(
        f.qualifiers.map((q) => ({ entrantId: q.entrantId, pool: q.pool!, tier: q.descriptor.kind === "group_rank" ? q.descriptor.rank! : full + 1 })),
        "single_elim",
        SEED,
      ).order;
      expect(out?.refused, name).toBeUndefined();
      expect(engineCalls, `${name}: the engine draws it`).toBe(1);
      expect([...(out?.qualifiers ?? [])].sort((a, b) => a.seed - b.seed).map((q) => q.entrantId), `${name}: the engine's own order`).toEqual(engine);
      expect(ms, `${name}: in time`).toBeLessThan(BUDGET_MS);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
  });

  it("a field past the bounds that the engine refuses on its input keeps the engine's own name (a page playoff fed 18), never TOO_LARGE", async () => {
    const f = field(9, 2, "");
    const { out, ms, engineCalls } = await timed("page_playoff", f);
    expect(out?.refused).toEqual({ code: "SEEDING_PAGE_PLAYOFF_NEEDS_FOUR", vars: { entrants: 18 } });
    expect(engineCalls, "the engine's input refusal costs no search").toBe(1);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("2 pools Top 3 with the best runner-up from the second winner's pool (RB5-D10) is refused as the engine refuses it, without asking it", async () => {
    // RB5-D10: 4-draw, seed 1 a bye, seeds 2 v 3 - B1 v B2. The engine's own answer for the same field, read directly:
    const f = field(2, 1, "B");
    let engineRefusal: unknown = null;
    try {
      crossPoolDraw(f.qualifiers.map((q) => ({ entrantId: q.entrantId, pool: q.pool!, tier: q.descriptor.kind === "group_rank" ? 1 : 2 })), "single_elim", SEED);
    } catch (e) {
      engineRefusal = (e as { data?: { reason?: unknown } }).data?.reason;
    }
    expect(engineRefusal, "the engine refuses it").toBe("pool_separation_impossible");
    const { out, engineCalls } = await timed("knockout", f);
    expect(out?.refused).toEqual({ code: "SEEDING_POOL_SEPARATION_IMPOSSIBLE", vars: { pool: "B", count: 2, entrants: 3, shape: "single_elim" } });
    expect(engineCalls).toBe(0);
  });
});
