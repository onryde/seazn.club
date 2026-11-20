// W5 app PR B Task 1 (ST-G5, PO-1 close; X-PO-1 <- RB5-P1, X-PO-2 <- RB5-E4/P2, X-WDT-7's pooled case; ruling 279; preflight
// C10, C11, C12, K5): pools ride the engine's fold as SEATING (`TableStage.pools`, engine 10). Every seated member of a pool is a
// row of its table from the first fold, zero played; a waiting late arrival is no row and no refusal (F9); a withdrawn entrant
// stays seated (C10); a stored pooled stage the engine would refuse every fold of is held off the seating (C11); a pin waits on
// the pool's SEATED size (C12); and Generate's floor refusal is the engine's `pool_too_small`, read as C38's named reason (K5).
//
// differential: today (6fbd5a3af2) a pool's members are the entrants of its results and awards (engine stage.ts
// `entrantsOfPool`), so a pool nobody has played in has no table at all, and an expunged pooled leaver has no row.
//
// Expected values: the rulebook's seeded snake (doc 05 §1: seeds 1..N, then N..1) for who sits in which pool, RB5-W1/W2 for the
// leaver (a leaver's row stays listed, ranked last; under half played expunges every result), and the engine's own declarations
// (`isLevelTable`, `validatePoolSizes`, `FORMAT_BOUNDS.pools.min`) - never the code under test.
// Real Postgres for the DB blocks; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { isLevelTable, validatePoolSizes, type StandingsRow } from "@seazn/engine/competition";
import { EngineError } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { c38SuggestedOf, poolSizeIssue } from "@/lib/pool-size-gate";
import { locksThatFit } from "@/lib/rank-override";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { confirmRegistration } from "@/server/usecases/registrations";
import { startDivision } from "@/server/usecases/schedule";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { seededSnake } from "@/server/usecases/stages/generators";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { seedRegistration } from "@/server/usecases/__tests__/_registration-fixtures";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { recomputeStandings } from "../competition";
import { stageSeatingOf, type SeatingLine } from "../stage-seating";
import { post } from "./helpers/w2b-rig";
import { genericResult } from "./helpers/w2d-table-rig";

// No network: a registration's confirmation mails through the outbox, and nothing here pays.
vi.mock("@/lib/stripe", async (io) => ({
  ...(await io<typeof import("@/lib/stripe")>()),
  getStripe: () => {
    throw new Error("this suite makes no Stripe call");
  },
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The rulebook's seeded snake (doc 05 §1): seeds 1..N into pools 0..p-1, then back p-1..0, repeating - typed from the rule. */
function snakeBySeed(n: number, pools: number): number[][] {
  const out: number[][] = Array.from({ length: pools }, () => []);
  let pool = 0;
  let step = 1;
  for (let seed = 1; seed <= n; seed++) {
    out[pool]!.push(seed);
    if (pool + step < 0 || pool + step >= pools) step = -step;
    else pool += step;
  }
  return out;
}

const line = (pool: string | null, home: string | null, away: string | null): SeatingLine => ({ pool_id: pool, home_entrant_id: home, away_entrant_id: away });

describe("stageSeatingOf: the seating the fold is handed (X-PO-1, C10, C11)", () => {
  it("the empty case first: a group with no line, and a league, are unpooled (engine 9's membership)", () => {
    expect(stageSeatingOf("group", [])).toEqual({ kind: "unpooled" });
    expect(stageSeatingOf("league", [line(null, "a", "b")])).toEqual({ kind: "unpooled" });
    // A group drawn before W5 T3 (one pool, no pool on its lines) is one table.
    expect(stageSeatingOf("group", [line(null, "a", "b")])).toEqual({ kind: "unpooled" });
    // A fed group's TBD lines seat nobody yet.
    expect(stageSeatingOf("group", [line("A", null, null), line("B", null, null)])).toEqual({ kind: "unpooled" });
  });

  it("X-PO-1 every line seats its two sides, whatever its status (C10): a withdrawn entrant's void lines still seat her", () => {
    // The seating reads no status at all: a void line is a line.
    const seating = stageSeatingOf("group", [line("A", "a1", "a2"), line("A", "a1", "a3"), line("A", "a2", "a3"), line("B", "b1", "b2")]);
    expect(seating.kind).toBe("seated");
    const pools = (seating as { pools: ReadonlyMap<string, string> }).pools;
    expect([...pools].sort()).toEqual([["a1", "A"], ["a2", "A"], ["a3", "A"], ["b1", "B"], ["b2", "B"]]);
    // A one-sided award line (a bye) seats its holder.
    expect(stageSeatingOf("group", [line("A", "a1", null), line("A", "a1", "a2")])).toMatchObject({ kind: "seated" });
  });

  it("C11 a stored seating the engine would refuse every fold of is HELD, each by its name", () => {
    expect(stageSeatingOf("group", [line("A", "x", "a2"), line("B", "x", "b2"), line("B", "b2", "b3")])).toEqual({ kind: "held", reason: "entrant_in_two_pools", entrantId: "x", pool: "B" });
    expect(stageSeatingOf("group", [line("A", "a1", "a2"), line(null, "a1", "q")])).toEqual({ kind: "held", reason: "unpooled_line", entrantId: "a1" });
    // A pool seating one: the engine's floor (`validatePoolSizes`, min 2).
    expect(stageSeatingOf("group", [line("A", "a1", "a2"), line("B", "b1", null)])).toEqual({ kind: "held", reason: "pool_too_small", pool: "B" });
  });
});

describe("X-PO-2 the engine's floor refusal reads as C38's named reason with the same suggested count", () => {
  it("over entrants 2..24 x pools 2..8 (161 fields): PR A's poolSizeIssue and the engine's validatePoolSizes agree on the refusal and its count", () => {
    let checked = 0;
    let underKnob = 0;
    for (let n = 2; n <= 24; n++) {
      for (let p = 2; p <= 8; p++) {
        // The seating the rulebook's snake deals (doc 05 §1), as the engine reads a pool's seating.
        const seating = new Map<string, string>();
        snakeBySeed(n, p).forEach((seeds, k) => seeds.forEach((s) => seating.set(`e${s}`, `P${k}`)));
        let engine: { suggestedPools: number | null } | null = null;
        try {
          validatePoolSizes(seating);
        } catch (err) {
          expect(err, `${n}/${p}: the engine refuses by name`).toBeInstanceOf(EngineError);
          const data = (err as EngineError).data as { reason: string; suggestedPools: number | null };
          expect(data.reason).toBe("pool_too_small");
          engine = { suggestedPools: data.suggestedPools };
        }
        const app = poolSizeIssue(n, p);
        expect(app === null, `${n}/${p}: both refuse, or neither`).toBe(engine === null);
        if (engine !== null) {
          // Finding (recorded, task-1-report.md): the engine offers ONE pool (a league) where PR A says "add entrants" (null) -
          // a count under the pools knob's own minimum is no group count. C38 maps it so (`c38SuggestedOf`).
          if (engine.suggestedPools !== null && engine.suggestedPools < FORMAT_BOUNDS.pools.min) underKnob++;
          expect(app!.suggested, `${n}/${p}: the same suggested count`).toBe(c38SuggestedOf(engine.suggestedPools));
        }
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every field of the grid").toBe(23 * 7);
    // The rows where the mapping does the work: n = 2 and n = 3 (one pool of n would play), every pool count.
    expect(underKnob, "the fields the engine answers with a single pool").toBe(2 * 7);
  });

  it("the generator deals the rulebook's snake: seededSnake over seeds 1..n (reversed in) equals doc 05 §1's, every field", () => {
    let checked = 0;
    for (let n = 2; n <= 24; n++) {
      for (let p = 2; p <= 8; p++) {
        // Handed out of seed order (reversed): the sort is the generator's to do.
        const entrants = Array.from({ length: n }, (_, i) => ({ id: `e${i + 1}`, seed: i + 1 })).reverse();
        const dealt = seededSnake(entrants, p).map((pool) => pool.map((e) => Number(e.id.slice(1))));
        expect(dealt, `${n}/${p}`).toEqual(snakeBySeed(n, p));
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every field of the grid").toBe(23 * 7);
  });

  it("c38SuggestedOf: a count at or above the knob's minimum passes, under it and null are null", () => {
    expect(c38SuggestedOf(null)).toBeNull();
    expect(c38SuggestedOf(FORMAT_BOUNDS.pools.min - 1)).toBeNull();
    expect(c38SuggestedOf(FORMAT_BOUNDS.pools.min)).toBe(FORMAT_BOUNDS.pools.min);
    expect(c38SuggestedOf(5)).toBe(5);
  });
});

describe("C12 locksThatFit with a seating: a pin waits on its pool's SEATED size", () => {
  const played = (pool: string, a: string, b: string) => ({ poolId: pool, result: [{ entrantId: a }, { entrantId: b }] as const });
  const unplayed = (pool: string) => ({ poolId: pool });
  const fixtures = [played("A", "a1", "a2"), unplayed("A"), unplayed("A"), unplayed("B")];
  const seating = new Map([["a1", "A"], ["a2", "A"], ["a3", "A"], ["b1", "B"], ["b2", "B"]]);

  it("a pin at rank 3 on a pool two of three have played places with the seating, and waits without it", () => {
    // a1 holds a result in pool A, whose results name two: rank 3 is above that, so today the pin waits for a third.
    const lock = [{ entrantId: "a1", rank: 3 }];
    expect(locksThatFit(lock, fixtures), "differential: today it waits for the pool's results").toEqual([]);
    expect(locksThatFit(lock, fixtures, seating)).toEqual(lock);
  });

  it("with a seating, a pin above its pool's seated size, or on an entrant no pool seats, never reaches the engine (it refuses both)", () => {
    expect(locksThatFit([{ entrantId: "b1", rank: 3 }], fixtures, seating)).toEqual([]);
    expect(locksThatFit([{ entrantId: "gone", rank: 1 }], fixtures, seating)).toEqual([]);
    expect(locksThatFit([{ entrantId: "b2", rank: 2 }, { entrantId: "a1", rank: 1 }], fixtures, seating)).toHaveLength(2);
  });
});

// ── Real producers ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Kind = "individual" | "pair" | "team";
/** A sport by key from the engine's registry: its first declared variant, that variant's config (generic's house config), and
 *  its default entrant kind - the division `tableScene` (w2d-table-rig) makes. */
function sport(key: string): { key: string; variant: string; config: Record<string, unknown>; kind: Kind } {
  const m = builtinModules.find((x) => x.key === key)!;
  const variant = Object.keys(m.variants)[0]!;
  const config = key === "generic" ? GENERIC_CONFIG : (m.variants[variant] as Record<string, unknown>);
  return { key, variant, config, kind: (m.entrantModel?.defaultKind ?? "individual") as Kind };
}

interface Rig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
  /** Entrant ids in seed order (seed i + 1). */
  ids: string[];
  /** Pool key -> pool id. */
  poolIds: Map<string, string>;
}

/** `n` entrants seeded 1..n in a one-stage group of `pools` pools, Started (the draw's lines exist, nobody has played). */
async function groupRig(o: { n: number; pools: number; sport?: string }): Promise<Rig> {
  const s = sport(o.sport ?? "generic");
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 B T1 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: s.key, variant_key: s.variant, config: s.config });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: o.n }, (_, i) => ({ kind: s.kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: o.pools } }, progression: null });
  await startDivision(auth, division.id);
  const pools = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${stage!.id} order by key`;
  return { auth, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, ids: made.map((e) => e.id), poolIds: new Map(pools.map((p) => [p.key, p.id])) };
}

async function snapshots(stageId: string): Promise<Map<string | null, StandingsRow[]>> {
  const rows = await sql<{ pool_id: string | null; rows: StandingsRow[] }[]>`select pool_id, rows from standings_snapshots where stage_id = ${stageId}`;
  return new Map(rows.map((r) => [r.pool_id, r.rows]));
}

const linesOf = (stageId: string) =>
  sql<{ id: string; pool_id: string | null; home_entrant_id: string | null; away_entrant_id: string | null; status: string }[]>`
    select id, pool_id, home_entrant_id, away_entrant_id, status from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;

/** A generic result on the line between x and y: x wins 2-0 (the rig's own `genericResult`, which checks it decided). */
const genericWin = (auth: AuthCtx, stageId: string, x: string, y: string) => genericResult(auth, stageId, x, y, 2, 0);

/** The pools as the snake rule places the rig's seeds, by pool key ('A', 'B', ...). */
function expectedPools(r: Rig, n: number, pools: number): Map<string, string[]> {
  const keys = [...r.poolIds.keys()];
  expect(keys, "premise: one pools row per pool, keyed A..").toHaveLength(pools);
  return new Map(snakeBySeed(n, pools).map((seeds, i) => [keys[i]!, seeds.map((s) => r.ids[s - 1]!).sort()]));
}

describe.skipIf(!HAS_DB)("X-PO-1 pools ride the fold as seating (real draw, real fold, real snapshot)", () => {
  it("X-PO-1 a pool table lists every seated member from the first fold, zero played and level (registry sweep, counted)", async () => {
    // differential: today a pool with no result has no rows (engine stage.ts `entrantsOfPool`), so Start stored no pool table.
    let swept = 0;
    for (const m of builtinModules) {
      const r = await groupRig({ n: 6, pools: 2, sport: m.key });
      const stored = await snapshots(r.stageId);
      const want = expectedPools(r, 6, 2);
      expect(stored.has(null), `${m.key}: a pooled stage owns no overall table`).toBe(false);
      for (const [key, members] of want) {
        const rows = stored.get(r.poolIds.get(key)!);
        expect(rows, `${m.key}: pool ${key} has a table from the first fold`).toBeDefined();
        expect(rows!.map((x) => x.entrantId).sort(), `${m.key}: pool ${key} lists its snake seats`).toEqual(members);
        expect(rows!.every((x) => x.played === 0), `${m.key}: pool ${key} nobody has played`).toBe(true);
        expect(isLevelTable(rows!), `${m.key}: pool ${key} is level (the engine's own test)`).toBe(true);
      }
      swept++;
    }
    expect(swept, "anti-vacuity: every sport in the registry").toBe(builtinModules.length);
    expect(swept).toBeGreaterThan(0);
  }, 600_000);

  it("X-PO-1 the sequence: a second refold changes nothing; one result moves its pool and leaves the other listed and level", async () => {
    // single-sport: the sequence is the fold's membership, which no sport field reaches; the sweep above covers the registry.
    const r = await groupRig({ n: 6, pools: 2 });
    const first = await snapshots(r.stageId);
    await recomputeStandings(r.auth.orgId, r.stageId);
    expect(await snapshots(r.stageId), "a second fold stores the same tables").toEqual(first);
    const want = expectedPools(r, 6, 2);
    const [a1, a2] = want.get("A")!;
    await genericWin(r.auth, r.stageId, a1!, a2!);
    const after = await snapshots(r.stageId);
    const poolA = after.get(r.poolIds.get("A")!)!;
    expect(poolA.map((x) => x.entrantId).sort(), "pool A still lists all three").toEqual(want.get("A"));
    expect(isLevelTable(poolA), "pool A has a result: not level").toBe(false);
    expect(poolA[0]!.entrantId, "the winner leads pool A").toBe(a1);
    const poolB = after.get(r.poolIds.get("B")!)!;
    expect(poolB.map((x) => x.entrantId).sort(), "pool B, unplayed, still lists all three").toEqual(want.get("B"));
    expect(isLevelTable(poolB), "pool B is level").toBe(true);
  });

  it("X-PO-1 a waiting arrival does not break the fold: no row, no refusal, and the next score write folds (F9, pin)", async () => {
    // single-sport: the waiting marker and the seating are sport-blind.
    const r = await groupRig({ n: 6, pools: 2 });
    const want = expectedPools(r, 6, 2);
    // Round 1 started in pool A, so the stage is running and an automatic arrival waits (W5 app-A Task 6, X-CU-8).
    const startLine = (await linesOf(r.stageId)).find((l) => l.pool_id === r.poolIds.get("A") && l.home_entrant_id && l.away_entrant_id)!;
    await post(r.auth, startLine.id, "core.start");
    const { registration } = await seedRegistration(r.competitionId, r.divisionId, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: "Late" });
    const confirmed = await confirmRegistration(r.auth, registration.id);
    const late = confirmed.entrant_id!;
    const [{ w }] = await sql<{ w: string | null }[]>`select table_waiting_stage_id as w from entrants where id = ${late}`;
    expect(w, "premise: the arrival waits on the table").toBe(r.stageId);
    await expect(recomputeStandings(r.auth.orgId, r.stageId), "the fold is not refused").resolves.toBeDefined();
    const stored = await snapshots(r.stageId);
    expect([...stored.values()].flat().map((x) => x.entrantId), "the waiting arrival is no row").not.toContain(late);
    for (const [key, members] of want) expect(stored.get(r.poolIds.get(key)!)!.map((x) => x.entrantId).sort(), `pool ${key} as drawn`).toEqual(members);
    // The next score write folds the table (a refusal would fail it).
    await post(r.auth, startLine.id, "generic.result", { p1Score: 1, p2Score: 0 });
    const poolA = (await snapshots(r.stageId)).get(r.poolIds.get("A")!)!;
    expect(isLevelTable(poolA), "the result reached pool A's table").toBe(false);
  });

  it("X-WDT-7 a pooled leaver stays in her pool's table after the expunge: listed, zero played, ranked last (RB5-W1, RB5-W2)", async () => {
    // single-sport: the expunge's decision is X-WDT-4's (Task 2); this pins her ROW under seating, which no sport field reaches.
    const r = await groupRig({ n: 8, pools: 2 });
    const want = expectedPools(r, 8, 2);
    const poolA = want.get("A")!;
    // differential: on 9.x the leaver had no result left, so no row (pool-leaver-footnote-db.test.ts's old premise).
    const leaver = r.ids[0]!; // seed 1 sits in pool A (the snake's first seat)
    expect(poolA, "premise: seed 1 is in pool A").toContain(leaver);
    const rivals = poolA.filter((id) => id !== leaver);
    // She plays one of her three (1 of 3: under half, RB5-W2 expunges it), and the rest of pool A plays out.
    await genericWin(r.auth, r.stageId, leaver, rivals[0]!);
    await genericWin(r.auth, r.stageId, rivals[0]!, rivals[1]!);
    await genericWin(r.auth, r.stageId, rivals[0]!, rivals[2]!);
    await genericWin(r.auth, r.stageId, rivals[1]!, rivals[2]!);
    const out = await withdrawEntrantCascade(r.auth, leaver);
    expect(out.policy, "RB5-W2: 1 of 3 played is under half").toBe("expunge");
    const rows = (await snapshots(r.stageId)).get(r.poolIds.get("A")!)!;
    expect(rows.map((x) => x.entrantId).sort(), "pool A still lists all four").toEqual(poolA);
    const mine = rows.find((x) => x.entrantId === leaver)!;
    expect(mine.played, "her one result was expunged").toBe(0);
    expect(rows.at(-1)!.entrantId, "RB5-W1: she ranks last").toBe(leaver);
    // The rival she beat keeps no result against her: two wins remain.
    expect(rows.find((x) => x.entrantId === rivals[0])!.played, "her result left her opponent's row").toBe(2);
  });

  it("C11 a stored pooled stage whose seating the engine would refuse is held: the score write folds by engine 9's membership", async () => {
    // single-sport: the guard reads lines, not results' sport fields.
    const r = await groupRig({ n: 6, pools: 2 });
    const want = expectedPools(r, 6, 2);
    const [b1] = want.get("B")!;
    const [a1, a2] = want.get("A")!;
    // A legacy line no draw makes today: pool B's b1 also on a pool A line (an entrant across two pools; census: 0 on stg).
    const [{ id: extra }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, pool_id, round_no, seq_in_round, fixture_no, home_entrant_id, away_entrant_id)
      values (${r.stageId}, ${r.divisionId}, ${r.auth.orgId}, ${r.poolIds.get("A")!}, 9, 1,
              (select coalesce(max(fixture_no), 0) + 1 from fixtures where division_id = ${r.divisionId}), ${a1!}, ${b1!})
      returning id`;
    expect(stageSeatingOf("group", await linesOf(r.stageId)), "premise: the stored seating is held").toMatchObject({ kind: "held", reason: "entrant_in_two_pools" });
    // A result on a pool A line, then one on the cross-pool line: neither write is refused (seated, the engine would refuse the
    // second with fixture_pool_mismatch, and every later fold of the stage with it).
    await genericWin(r.auth, r.stageId, a1!, a2!);
    await post(r.auth, extra, "core.start");
    await post(r.auth, extra, "generic.result", { p1Score: 3, p2Score: 0 });
    const [{ status }] = await sql<{ status: string }[]>`select status from fixtures where id = ${extra}`;
    expect(status, "the cross-pool line was decided").toBe("decided");
    // Engine 9's membership: pool A's table is its results' entrants, b1 among them.
    const stored = await snapshots(r.stageId);
    expect(stored.get(r.poolIds.get("A")!)!.map((x) => x.entrantId).sort(), "pool A: its results' entrants").toEqual([a1!, a2!, b1!].sort());
  });

  it("C12 a stale pin on an entrant no pool seats never refuses the fold", async () => {
    // single-sport: rank locks are the fold's, sport-blind.
    const r = await groupRig({ n: 6, pools: 2 });
    const want = expectedPools(r, 6, 2);
    const [a1, a2] = want.get("A")!;
    // A pin left behind by an entrant no longer seated (a stored config no write path re-checks), beside a live pin.
    const stale = randomUUID();
    await sql`update stages set config = config || ${sql.json({ rank_overrides: [{ entrant_id: stale, rank: 1, pool_id: r.poolIds.get("A")! }, { entrant_id: a2!, rank: 1, pool_id: r.poolIds.get("A")! }] } as never)} where id = ${r.stageId}`;
    await expect(recomputeStandings(r.auth.orgId, r.stageId), "the fold is not refused (rank_lock_unknown_entrant)").resolves.toBeDefined();
    // The live pin places from the first fold: a2 first in an unplayed pool A.
    const rows = (await snapshots(r.stageId)).get(r.poolIds.get("A")!)!;
    expect(rows[0]!.entrantId, "C12: the pin on the unplayed pool is applied").toBe(a2);
    expect(rows.map((x) => x.entrantId)).toContain(a1);
  });
});

describe.skipIf(!HAS_DB)("X-PO-2 Generate's floor refusal is the engine's, read as C38's group_too_few_entrants", () => {
  /** Generate's refusal for `n` entrants into `pools` pools (no draw yet). */
  async function refusalOf(n: number, pools: number): Promise<Record<string, unknown>> {
    const s = sport("generic");
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 B T1 floor " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: s.key, variant_key: s.variant, config: s.config });
    await createEntrants(auth, division.id, Array.from({ length: n }, (_, i) => ({ kind: s.kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: pools } }, progression: null });
    const err = await generateStageFixtures(auth, stage!.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, `${n} into ${pools}: Generate refuses`).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("STAGE_NOT_READY");
    return (err as EngineError).data as Record<string, unknown>;
  }
  /** The engine's own answer for the snake's seating of n into p. */
  function engineSuggested(n: number, p: number): number | null {
    const seating = new Map<string, string>();
    snakeBySeed(n, p).forEach((seeds, k) => seeds.forEach((s) => seating.set(`s${s}`, `P${k}`)));
    try {
      validatePoolSizes(seating);
    } catch (err) {
      return ((err as EngineError).data as { suggestedPools: number | null }).suggestedPools;
    }
    throw new Error(`premise: the engine refuses ${n} into ${p}`);
  }

  it("7 into 4 (a pool of one): C38's reason, suggested = the engine's suggestedPools (3)", async () => {
    const data = await refusalOf(7, 4);
    expect(engineSuggested(7, 4), "the engine's count").toBe(3);
    expect(data).toMatchObject({ reason: "group_too_few_entrants", groups: 4, entrants: 7, suggested: 3 });
  });

  it("3 into 2: the engine offers one pool (a league); C38 says add entrants (null), the knob's minimum being 2", async () => {
    const data = await refusalOf(3, 2);
    expect(engineSuggested(3, 2), "the engine's count").toBe(1);
    expect(FORMAT_BOUNDS.pools.min).toBe(2);
    expect(data).toMatchObject({ reason: "group_too_few_entrants", groups: 2, entrants: 3, suggested: null });
  });
});
