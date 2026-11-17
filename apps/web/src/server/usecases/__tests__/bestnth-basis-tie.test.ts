// W5 Task 11c — X-PD-8 (RB5-G9 as re-worded by owner ruling 291; ruling 288's "listed (seed) order" wording is superseded):
// a tie between teams in DIFFERENT pools that survives the best-Nth basis comparison is broken by the SPORT'S OWN declared
// cross-group cascade — a `seed` step gives seed order, `lots` gives the engine's stored lots draw (a new
// `shuffle(lotSeed(rngSeed, sorted ids), sorted ids)` when none is stored, returned for storage), a cascade with neither
// gives seed then id. No engine change; inside the cross-pool draw ruling 281's stored seed decides (PR B's X-PD-3).
//
// A CONSTRUCTED enumeration (the plan's G1: the "21 harness cases" premise is withdrawn):
//   rows     — every non-retired STAGE_TEMPLATES entry whose `build()` holds a `bestNth` take over the builder's knob sweep
//              (derived, never typed), plus the gallery `group_group_ko` shape only if its second tier carries one;
//   pools    — P in {2, 3, 4};
//   classes  — seed-bearing (tennis), lots-only (football), neither (a stage-pinned metric-only order on generic);
//   shapes   — all_level, pair_level (and lots_stored on the lots-only class).
// Each case is built through the REAL setup path: real stages/fixtures, a constructed standings snapshot per pool (the cases
// need candidates LEVEL on every metric step, which no honest result set produces on three sports), the real
// computeSeedProposal (sourcesToTables -> loadCrossGroupRules -> resolveProgression -> persistCrossGroupDraws).
//
// Expected values are derived from the case's declared inputs and the engine's own declarations (`defaultCrossGroup`,
// `lotSeed`, `shuffle`), never from the resolver under test. Every case chooses its ids, seeds and rngSeed so that the right
// answer differs from the wrong ones (id order, pool order, seed order on a lots-only cascade, the stored draw's absence).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultCrossGroup, lotSeed, membersKeyOf, type StandingsRow } from "@seazn/engine/competition";
import { shuffle } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { STAGE_TEMPLATES, type StageDraft } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { computeSeedProposal, createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// ---------------------------------------------------------------------------------------------------------------------
// The row set, derived.

const POOL_COUNTS = [2, 3, 4] as const;
const hasBestNth = (drafts: readonly StageDraft[]) =>
  drafts.some((d) => d.progression?.sources.some((s) => s.take.some((t) => t.kind === "bestNth")));

/** Every non-retired template that carries a `bestNth` take anywhere in the builder's knob sweep (pools 2..4 x every qualified
 *  count with a remainder, `qualified mod pools != 0`, the remainder `format-templates.ts` pushes as a bestNth take). */
function bestNthRows(): string[] {
  return STAGE_TEMPLATES.filter((t) => t.retired !== true)
    .filter((t) =>
      POOL_COUNTS.some((poolCount) =>
        Array.from({ length: 3 * poolCount }, (_, i) => i + 2)
          .filter((qualified) => qualified % poolCount !== 0)
          .some((qualified) => hasBestNth(t.build({ qualified, poolCount, swissRounds: 3, legs: 1 }))),
      ),
    )
    .map((t) => t.key);
}

/** The gallery `group_group_ko` shape is t20-super8's catalog body (tools/matrix `TEMPLATE_ROW`); read as text, never imported. */
function galleryGroupGroupKoCarriesBestNth(): boolean {
  const body = JSON.parse(readFileSync(join(__dirname, "../../templates/catalog/t20-super8.json"), "utf8")) as {
    divisions: { stages: { kind: string; progression?: { sources: { take: { kind: string }[] }[] } }[] }[];
  };
  const stages = body.divisions[0]!.stages;
  expect(stages.map((s) => s.kind), "premise: the gallery shape is groups -> groups -> knockout").toEqual(["group", "group", "knockout"]);
  return stages[1]!.progression!.sources.some((s) => s.take.some((t) => t.kind === "bestNth"));
}

const BESTNTH_ROWS = bestNthRows();

// ---------------------------------------------------------------------------------------------------------------------
// The cascade classes, from the engine's own declarations.

type ClassName = "seed-bearing" | "lots-only" | "neither";
const classOf = (order: readonly string[]): ClassName => (order.includes("seed") ? "seed-bearing" : order.includes("lots") ? "lots-only" : "neither");

type Shape = "all_level" | "pair_level" | "lots_stored";
interface ClassSpec {
  name: ClassName;
  sport: string;
  /** A stage-pinned cross-group order (`stages.config.crossGroupTiebreakers`), for the class no shipped default ends in. */
  pin?: readonly string[];
  shapes: readonly Shape[];
}
const CLASSES: readonly ClassSpec[] = [
  // tennis ends `..., "seed", "lots"` (tennis.ts:76): seed order, lots never reached.
  { name: "seed-bearing", sport: "tennis", shapes: ["all_level", "pair_level"] },
  // football `..., "for", "lots"`: the stored draw, else a new one — NEVER seed order.
  { name: "lots-only", sport: "football", shapes: ["all_level", "pair_level", "lots_stored"] },
  // generic's own default ends in lots; the stage pins a metric-only order, which is how a "neither" cascade is reachable.
  { name: "neither", sport: "generic", pin: ["points", "diff", "for"], shapes: ["all_level", "pair_level"] },
];

const moduleOf = (sport: string) => builtinModules.find((m) => m.key === sport)!;

// ---------------------------------------------------------------------------------------------------------------------
// Deterministic ids, seeds and draws.

const permutations = <T,>(xs: readonly T[]): T[][] =>
  xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const drawOf = (rngSeed: number, ids: readonly string[]): string[] => {
  const sorted = [...ids].sort();
  return shuffle(lotSeed(rngSeed, sorted), sorted);
};

/** The candidate indices in seed order (best first). P >= 3: a permutation that is neither the identity (pool/id order) nor its
 *  reverse, so neither an id sort nor a reversed id sort reads as seed order. P = 2 has only the two orders: reversed. */
function seedOrderFor(P: number): number[] {
  if (P === 2) return [1, 0];
  if (P === 3) return [1, 2, 0];
  return [2, 0, 3, 1];
}

// ---------------------------------------------------------------------------------------------------------------------
// One case.

interface CaseResult {
  /** The pools' rank-nth finishers, in pool order. */
  cands: { id: string; pool: number; seed: number }[];
  /** The best-Nth seats the real proposal named, in seat order. */
  seats: string[];
  /** The expected seats, derived. */
  expected: string[];
  /** The whole expected candidate order (the seats are its first P - 1). */
  expectedFull: string[];
  rngSeed: number;
  /** The draw the resolver stored (`stage_lots_draws`, live rows). */
  stored: { members: string[]; drawn_order: string[] }[];
  declaredOrder: readonly string[];
  loadedOrder: readonly string[];
  second?: string[];
}

interface CaseInput {
  row: string;
  P: number;
  cls: ClassSpec;
  shape: Shape;
}

async function runCase(c: CaseInput): Promise<CaseResult> {
  const { P, cls, shape } = c;
  const mod = moduleOf(cls.sport);
  const tpl = STAGE_TEMPLATES.find((t) => t.key === c.row)!;
  // q = P + (P - 1): one winner per pool (topNPerGroup 1) and P - 1 best-Nth seats, the builder's own remainder take.
  const qualified = 2 * P - 1;
  const drafts = tpl.build({ qualified, poolCount: P, swissRounds: 3, legs: 1 });
  const take = drafts[1]!.progression!.sources[0]!.take;
  const best = take.find((t) => t.kind === "bestNth") as { kind: "bestNth"; nth: number; count: number };
  const top = take.find((t) => t.kind === "topNPerGroup") as { kind: "topNPerGroup"; n: number };
  expect(best.count, "the take asks for P - 1 best-Nth seats").toBe(P - 1);
  expect(top.n, "one pool winner each").toBe(1);
  const members = best.nth + 1; // a row above, the candidate, and a row below
  const N = members * P;

  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "BN " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
    select key, config from sport_variants where sport_key = ${cls.sport} and is_system order by key limit 1`;
  expect(variant, `${cls.sport} has a system variant`).toBeDefined();
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: cls.sport, variant_key: variant!.key, config: variant!.config } as never);
  const created = await createEntrants(auth, div.id, Array.from({ length: N }, (_, i) => ({ kind: (cls.sport === "football" ? "team" : "individual") as "team" | "individual", display_name: `E${String(i + 1).padStart(2, "0")}`, seed: i + 1, members: [] })));
  // Ascending ids in creation (= seed) order, so a pool's top seed is its smallest id and the candidates' ids ascend with the
  // pools: id order == pool order, and a seed order that is neither is a real witness. Before any fixture exists.
  const prefix = randomUUID().slice(0, 8);
  const idOf = new Map<number, string>();
  for (const e of [...created].sort((a, b) => (a.seed as number) - (b.seed as number))) {
    const id = `${prefix}-0000-4000-8000-${String(e.seed).padStart(12, "0")}`;
    await sql`update entrants set id = ${id} where id = ${e.id}`;
    idOf.set(e.seed as number, id);
  }
  const stages = await createStages(
    auth,
    div.id,
    drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression })) as never,
  );
  const src = stages.find((s) => s.seq === 1)!;
  const ko = stages.find((s) => s.seq === 2)!;
  await generateStageFixtures(auth, ko.id);
  await generateStageFixtures(auth, src.id);

  // Pools by key, members from the generated fixtures.
  const poolRows = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${src.id} order by key`;
  expect(poolRows, "P pools").toHaveLength(P);
  const fx = await sql<{ pool_id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select pool_id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${src.id}`;
  const inPool = (poolId: string) => [...new Set(fx.filter((f) => f.pool_id === poolId).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]))].sort();
  const pools = poolRows.map((p) => ({ ...p, members: inPool(p.id) }));
  for (const p of pools) expect(p.members, `pool ${p.key} holds ${members} entrants`).toHaveLength(members);
  const candIds = pools.map((p) => p.members[0]!);
  expect([...candIds].sort(), "premise: the candidates' ids ascend with the pools (id order == pool order)").toEqual(candIds);

  // Seeds: the candidates get 1..P in the case's seed order; everyone else follows.
  const seedOrder = (() => {
    const base = seedOrderFor(P);
    // The lots-only classes with a two-member group (pair_level on P=2, or any all-P draw on P=2) need seed == id order, or a
    // 2-way draw has no answer that differs from both.
    if (cls.name === "lots-only" && (P === 2 || shape === "pair_level")) {
      return shape === "pair_level" ? [0, 1, ...base.filter((i) => i > 1)] : [0, 1];
    }
    if (shape === "pair_level" && cls.name !== "lots-only") return [1, 0, ...Array.from({ length: P - 2 }, (_, i) => i + 2)];
    return base;
  })();
  const seedOf = new Map<string, number>();
  seedOrder.forEach((candIdx, pos) => seedOf.set(candIds[candIdx]!, pos + 1));
  let next = P + 1;
  for (const p of pools) for (const m of p.members) if (!seedOf.has(m)) seedOf.set(m, next++);
  for (const [id, seed] of seedOf) await sql`update entrants set seed = ${seed} where id = ${id}`;
  const cands = candIds.map((id, pool) => ({ id, pool, seed: seedOf.get(id)! }));
  const seedOrderIds = [...cands].sort((a, b) => a.seed - b.seed).map((x) => x.id);

  // Strength of each candidate on the primary metric (higher is better): all level, or the first two level at the TOP with
  // the rest apart below them, in descending order.
  const strength = (idx: number): number => (shape === "pair_level" ? (idx < 2 ? 100 : -idx) : 0);
  const pairIds = cands.slice(0, 2).map((x) => x.id);

  // The rngSeed and the stored draw.
  let rngSeed = 7;
  let storedDraw: string[] | null = null;
  const candSet = cands.map((x) => x.id);
  if (cls.name === "lots-only") {
    const group = shape === "pair_level" ? pairIds : candSet;
    const sortedGroup = [...group].sort();
    const seedOrderOfGroup = seedOrderIds.filter((id) => group.includes(id));
    if (shape === "lots_stored") {
      storedDraw = permutations(candSet).find((perm) => !sameOrder(perm, seedOrderIds) && !sameOrder(perm, sortedGroup)) ?? null;
      expect(storedDraw, "a stored order that is neither seed order nor id order exists").not.toBeNull();
      rngSeed = pickSeed((s) => !sameOrder(drawOf(s, group), storedDraw!), "a fresh draw that differs from the stored one");
    } else {
      rngSeed = pickSeed(
        (s) => !sameOrder(drawOf(s, group), seedOrderOfGroup) && !sameOrder(drawOf(s, group), sortedGroup) && !sameOrder(drawOf(s + 1, group), drawOf(s, group)),
        "a draw that differs from seed order, id order, and the next rngSeed's draw",
      );
    }
  }

  // The class's declared cascade, from the engine (never from the app's loader).
  const declaredOrder: readonly string[] = cls.pin ?? defaultCrossGroup(mod.defaultTiebreakers("group", variant!.config as never));
  expect(classOf(declaredOrder), `${cls.sport}'s declared cascade is the ${cls.name} class`).toBe(cls.name);

  // Constructed standings: per pool a row above the candidate, the candidate (level on every metric step of the cascade with
  // the other candidates, or apart by the primary measure), and a row below.
  const metricKeys = declaredOrder.filter((k) => !["points", "wins", "seed", "lots", "matches_played"].includes(k));
  const rowFor = (entrantId: string, rank: number, wins: number): StandingsRow => ({
    entrantId,
    played: 2,
    won: wins,
    drawn: 0,
    lost: 2 - Math.min(wins, 2),
    points: 3 * wins,
    metrics: Object.fromEntries(metricKeys.map((k) => [k, 1])),
    rank,
  });
  // Both `won` and `points` carry the strength (points = 3 x won), whichever measure the sport's first key reads.
  for (const [pi, p] of pools.entries()) {
    const others = p.members.slice(1);
    const rows: StandingsRow[] = [];
    rows.push(rowFor(others[0]!, 1, 1000 + pi)); // the pool winner, far above every candidate
    rows.push(rowFor(p.members[0]!, 2, 10 + strength(pi))); // the candidate
    rows.push(rowFor(others[1]!, 3, 0));
    await sql`insert into standings_snapshots (stage_id, pool_id, rows, computed_through_seq) values (${src.id}, ${p.id}, ${sql.json(rows as never)}, 0)`;
  }
  await sql`update stages set status = 'complete' where id = ${src.id}`;
  await sql`update stages set config = config || ${sql.json({ rngSeed } as never)} where id = ${src.id}`;
  // The stage's table rules were pinned when its fixtures were generated (V475; "active => pinned"), and a pin is read verbatim,
  // so a stage-pinned order is written into the pin (the stage's own order, `sources.crossGroup = "stage"`). The write API
  // would append `lots` to a metric-only order; the pin is the one place a "neither" cascade is stored as given.
  if (cls.pin) {
    await sql`
      update stages
         set table_rules_pinned = jsonb_set(jsonb_set(table_rules_pinned, '{crossGroup}', ${sql.json(cls.pin as never)}), '{sources,crossGroup}', '"stage"')
       where id = ${src.id}`;
  }
  if (storedDraw !== null) {
    await sql`
      insert into stage_lots_draws (stage_id, pool_id, members_key, members, drawn_order, seed)
      values (${src.id}, null, ${membersKeyOf(candSet)}, ${[...candSet].sort()}::uuid[], ${storedDraw}::uuid[], ${lotSeed(rngSeed, [...candSet].sort())})`;
  }

  // The expected seats: candidates ranked by strength (higher first); a level group is broken by the class's own rule.
  const levels = [...new Set(cands.map((x) => strength(x.pool)))].sort((a, b) => b - a);
  const expected: string[] = [];
  for (const lv of levels) {
    const group = cands.filter((x) => strength(x.pool) === lv).map((x) => x.id);
    if (group.length === 1) expected.push(group[0]!);
    else if (cls.name === "lots-only") expected.push(...(storedDraw !== null ? storedDraw : drawOf(rngSeed, group)));
    else expected.push(...cands.filter((x) => group.includes(x.id)).sort((a, b) => a.seed - b.seed).map((x) => x.id)); // seed order
  }

  const proposal = await computeSeedProposal(auth, ko.id);
  const seats = proposal.computed.qualifiers.map((q) => q.entrantId).filter((id) => candSet.includes(id));
  const loaded = await loadedOrderOf(auth, src.id);
  const draws = await sql<{ members: string[]; drawn_order: string[] }[]>`
    select members, drawn_order from stage_lots_draws where stage_id = ${src.id} and superseded_at is null`;
  const out: CaseResult = {
    cands,
    seats,
    expected: expected.slice(0, P - 1),
    expectedFull: expected,
    rngSeed,
    stored: draws,
    declaredOrder,
    loadedOrder: loaded,
  };
  // A second run: the store, if one was written, now answers; the seats must not move (the 2nd proposal is a recompute).
  const again = await computeSeedProposal(auth, ko.id);
  out.second = again.computed.qualifiers.map((q) => q.entrantId).filter((id) => candSet.includes(id));
  return out;
}

function pickSeed(ok: (s: number) => boolean, what: string): number {
  for (let s = 1; s <= 5000; s++) if (ok(s)) return s;
  throw new Error(`no rngSeed in 1..5000 gives ${what}`);
}

/** The cross-group order the APP hands the engine for a stage (`loadCrossGroupRules`) — read through its own door. */
async function loadedOrderOf(auth: AuthCtx, stageId: string): Promise<readonly string[]> {
  const { loadCrossGroupRules } = await import("@/server/engine-db/competition");
  const { withTenant } = await import("@/lib/db");
  const rules = await withTenant(auth.orgId, (tx) => loadCrossGroupRules(tx, stageId));
  return rules.order as readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------------

const tally = { total: 0, byClass: new Map<string, number>() };

describe("X-PD-8 the row set and the classes are derived, never typed", () => {
  it("BESTNTH_ROWS is non-empty, holds groups_ko, and is the real templates' bestNth carriers", () => {
    expect(BESTNTH_ROWS.length, "anti-vacuity: the scan found rows").toBeGreaterThan(0);
    expect(BESTNTH_ROWS).toContain("groups_ko");
    // Every row found carries the take on the knob the cases build (qualified = 2P - 1 over P pools).
    for (const key of BESTNTH_ROWS) {
      for (const P of POOL_COUNTS) {
        const drafts = STAGE_TEMPLATES.find((t) => t.key === key)!.build({ qualified: 2 * P - 1, poolCount: P, swissRounds: 3, legs: 1 });
        expect(hasBestNth(drafts), `${key} x ${P} pools carries a bestNth take at qualified = 2P - 1`).toBe(true);
      }
    }
  });

  it("the gallery group_group_ko shape joins the rows only if its second tier carries a bestNth take (read: it does not)", () => {
    // A tier-two bestNth would need its own row here; fail by name rather than silently skip it.
    expect(galleryGroupGroupKoCarriesBestNth(), "t20-super8's second tier takes topNPerGroup only").toBe(false);
  });

  it("every sport's default cross-group cascade falls in exactly one class, and each class names a real representative", () => {
    const byClass = new Map<ClassName, string[]>();
    for (const m of builtinModules) {
      const order = defaultCrossGroup(m.defaultTiebreakers("group", undefined as never));
      const k = classOf(order);
      byClass.set(k, [...(byClass.get(k) ?? []), m.key]);
    }
    const swept = [...byClass.values()].reduce((n, xs) => n + xs.length, 0);
    expect(swept, "anti-vacuity: every sport in the registry was classified").toBe(builtinModules.length);
    expect(swept).toBeGreaterThan(0);
    expect(byClass.get("seed-bearing"), "tennis is seed-bearing").toContain("tennis");
    expect(byClass.get("lots-only"), "football is lots-only").toContain("football");
    // Recorded, not assumed: which sports serve which class by default; a class nobody ships (neither) is a stage pin.
    expect(Object.fromEntries([...byClass].map(([k, v]) => [k, [...v].sort()]))).toEqual({
      "seed-bearing": ["cricket", "icehockey", "tennis"],
      "lots-only": ["badminton", "boardgame", "carrom", "football", "generic", "hockey", "tabletennis", "volleyball"],
    });
  });
});

describe.skipIf(!HAS_DB)("X-PD-8 a best-Nth basis tie across pools falls to the sport's declared cross-group cascade (constructed enumeration)", () => {
  for (const row of BESTNTH_ROWS) {
    for (const P of POOL_COUNTS) {
      for (const cls of CLASSES) {
        for (const shape of cls.shapes) {
          it(`X-PD-8 ${row} x ${P} pools, ${cls.name} cascade (${cls.sport}${cls.pin ? ", stage-pinned" : ""}), ${shape}`, async () => {
            const r = await runCase({ row, P, cls, shape });
            // The class's own declared cascade is what the app handed the engine.
            expect(r.loadedOrder, "loadCrossGroupRules carries the stage's declared cross-group order").toEqual(r.declaredOrder);
            expect(r.expected, "premise: P - 1 best-Nth seats are asserted").toHaveLength(P - 1);
            expect(r.seats, `the best-Nth seats are the ${cls.name} cascade's`).toEqual(r.expected);
            expect(r.second, "a second proposal (the store now answering) seats the same entrants in the same order").toEqual(r.expected);
            if (cls.name === "lots-only" && shape !== "lots_stored") {
              // The draw was stored for reuse: one live row whose order is exactly what was seated (X-TB-7's persist).
              const live = r.stored.filter((d) => d.members.length === (shape === "pair_level" ? 2 : P));
              expect(live, "the new draw was stored").toHaveLength(1);
              const stored = live[0]!;
              expect([...stored.members].sort()).toEqual([...(shape === "pair_level" ? r.cands.slice(0, 2).map((x) => x.id) : r.cands.map((x) => x.id))].sort());
              expect(stored.drawn_order, "the stored order is the draw the seats followed (the level group sits at the top)").toEqual(r.expectedFull.slice(0, stored.members.length));
            }
            if (cls.name !== "lots-only") expect(r.stored, `${cls.name}: no draw is made or stored`).toEqual([]);
            tally.total++;
            tally.byClass.set(cls.name, (tally.byClass.get(cls.name) ?? 0) + 1);
          }, 120_000);
        }
      }
    }
  }

  it("anti-vacuity: the enumeration ran every cell", () => {
    const perRow = POOL_COUNTS.length * CLASSES.reduce((n, c) => n + c.shapes.length, 0);
    expect(perRow, "3 pool counts x (2 + 3 + 2) cells").toBe(3 * (2 + 3 + 2));
    expect(tally.total).toBe(BESTNTH_ROWS.length * perRow);
    for (const c of CLASSES) {
      expect(tally.byClass.get(c.name), `${c.name} cells ran`).toBe(BESTNTH_ROWS.length * POOL_COUNTS.length * c.shapes.length);
      expect(tally.byClass.get(c.name)).toBeGreaterThan(0);
    }
  });
});
