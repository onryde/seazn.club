// ST-G26 (W4 app A Task 23) — a division's standings are read in stage order, then pool order.
//
// `readPublicDivisionDetail` read `public_standings_v` with no ORDER BY, so its snapshots came back in whatever order
// the plan produced (heap order: the order they were written). Two readers take that order as the division's:
// the share card drew `standings[0]`, and /present draws one slide per snapshot in list order. A knockout's placement
// snapshot is written when the knockout COMPLETES — after its group's tables — and a pool's snapshot whenever that
// pool's results last moved, so "Pool B, then the knockout, then Pool A" is an ordinary write order.
//
// The order owed is the product's: stages by their seq (the order the organiser built them), and inside a stage the
// pools in display order (`lib/pool-order.ts` — key, natural; the stage-wide table first). Written here in the WORST
// order (the knockout first, then Pool B, then Pool A) and asserted across the pools AND the knockout, never one sample.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

// The plan is the trap: on a small table Postgres walks `stages (division_id, seq)` and the snapshot key
// `(stage_id, pool_scope)`, which happens to read stage order, and pools in random-UUID order. Production's plan is
// not this one. When `plan.heap` is on, the standings read runs with index and bitmap scans off, so an unordered read
// comes back in PHYSICAL order — the order the snapshots were written — exactly as a sequential scan would hand it over.
const plan = vi.hoisted(() => ({ heap: false, forced: 0 }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const sql = new Proxy(actual.sql, {
    apply(target, thisArg, args: unknown[]) {
      const head = args[0];
      const statement = Array.isArray(head) && "raw" in head ? (head as readonly string[]).join("?") : "";
      if (!plan.heap || !statement.includes("from public_standings_v")) return Reflect.apply(target, thisArg, args);
      plan.forced += 1;
      return target.begin(async (tx) => {
        await tx`set local enable_indexscan = off`;
        await tx`set local enable_indexonlyscan = off`;
        await tx`set local enable_bitmapscan = off`;
        return (tx as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
      });
    },
  });
  return { ...actual, sql };
});

import { sql } from "@/lib/db";
import { placementTable } from "@seazn/engine/competition";
import type { AuthCtx } from "@/server/api-v1/auth";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { getPublicDivision } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;

interface Scene {
  auth: AuthCtx;
  orgSlug: string;
  compSlug: string;
  groupId: string;
  koId: string;
  pools: { id: string; key: string }[];
}
let scene: Scene;

async function division(auth: AuthCtx, compId: string, slug: string) {
  return createDivision(auth, compId, { name: slug, slug, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
}

type Snap = [stageId: string, poolId: string | null, order: string[]];
/** The snapshots, written in the order given, by ONE backend: a pooled statement each could land on two connections,
 *  whose different target pages would make the physical order something other than the write order. */
async function writeInOrder(snaps: Snap[]) {
  await sql.begin(async (tx) => {
    for (const [stageId, poolId, order] of snaps) {
      await tx`
        insert into standings_snapshots (stage_id, pool_id, rows, computed_through_seq)
        values (${stageId}, ${poolId}, ${tx.json(placementTable(order).rows as never)}, 0)`;
    }
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const { auth } = await seedOrg();
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${auth.orgId}, 'competitions.max_active', null, 'test')
    on conflict do nothing`;
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Order Cup", visibility: "public", branding: {} });
  const div = await division(auth, comp.id, "open");
  await division(auth, comp.id, "empty");
  const entrants = await createEntrants(
    auth,
    div.id,
    ["Ash", "Birch", "Cedar", "Damson", "Elm", "Fir"].map((name, i) => ({ kind: "team" as const, display_name: name, seed: i + 1, members: [] })),
  );
  // The knockout (stage 2) is created BEFORE the group (stage 1), so even the stages read in the wrong physical order.
  const [ko] = await createStages(auth, div.id, { seq: 2, kind: "knockout", name: "Finals", config: {} });
  const [group] = await createStages(auth, div.id, { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } });
  await generateStageFixtures(auth, group!.id);
  const pools = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${group!.id} order by key`;
  const ids = entrants.map((e) => e.id);

  // The worst write order: the knockout's placement snapshot, then Pool B, then Pool A.
  await writeInOrder([
    [ko!.id, null, ids.slice(0, 4)],
    [group!.id, pools.find((p) => p.key === "B")!.id, [ids[1]!, ids[3]!, ids[5]!]],
    [group!.id, pools.find((p) => p.key === "A")!.id, [ids[0]!, ids[2]!, ids[4]!]],
  ]);

  scene = { auth, orgSlug, compSlug: comp.slug, groupId: group!.id, koId: ko!.id, pools: [...pools] };
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("ST-G26 standings are read in stage then pool order", () => {
  it("premise: the generator made pools A and B, and the snapshots are stored knockout-first", async () => {
    expect(scene.pools.map((p) => p.key)).toEqual(["A", "B"]);
    // Physical order: what an unordered read hands back first.
    const stored = await sql<{ stage_id: string; pool_id: string | null }[]>`
      select stage_id, pool_id from standings_snapshots where stage_id in (${scene.groupId}, ${scene.koId}) order by ctid`;
    expect(stored.map((s) => s.stage_id === scene.koId ? "KO" : scene.pools.find((p) => p.id === s.pool_id)!.key)).toEqual(["KO", "B", "A"]);
  });

  const keyOf = (s: { stage_id: string; pool_id: string | null }) =>
    s.stage_id === scene.koId ? "KO" : `group/${scene.pools.find((p) => p.id === s.pool_id)?.key ?? "?"}`;

  it("precondition: under a heap-order plan the same read WITHOUT an order comes back out of order", async () => {
    plan.heap = true;
    try {
      const before = plan.forced;
      const [{ id: divisionId }] = await sql<{ id: string }[]>`select division_id as id from stages where id = ${scene.koId}`;
      const raw = await sql<{ stage_id: string; pool_id: string | null }[]>`
        select stage_id, pool_id from public_standings_v where division_id = ${divisionId}`;
      expect(plan.forced - before, "the forced plan ran").toBe(1);
      // Out of the product's order (the knockout first, or B above A): without that, the case below proves nothing.
      expect(raw.length, "anti-vacuity: three snapshots read").toBe(3);
      expect(raw.map(keyOf)).not.toEqual(["group/A", "group/B", "KO"]);
    } finally {
      plan.heap = false;
    }
  });

  for (const heap of [true, false]) {
    it(`the division read: Pool A, then Pool B (stage 1), then the knockout (stage 2) — ${heap ? "heap-order plan" : "the planner's own plan"}`, async () => {
      plan.heap = heap;
      try {
        const before = plan.forced;
        const data = await getPublicDivision(scene.orgSlug, scene.compSlug, "open");
        expect(data, "the public division").not.toBeNull();
        expect(plan.forced - before, "the standings read went through the plan under test").toBe(heap ? 1 : 0);
        const read = data!.standings.map(keyOf);
        expect(read.length, "anti-vacuity: three snapshots read").toBe(3);
        expect(read).toEqual(["group/A", "group/B", "KO"]);
      } finally {
        plan.heap = false;
      }
    });
  }

  it("the empty case: a division with no snapshots reads none", async () => {
    const data = await getPublicDivision(scene.orgSlug, scene.compSlug, "empty");
    expect(data, "the public division").not.toBeNull();
    expect(data!.standings).toEqual([]);
  });
});
