// W5 app PR A, Task 24 (T5-b): SURF - what the API says of a TABLE stage, read after a division played with a departure in it (design 6.7: "surfaces
// asserted after every scenario"; X-SF-1..6, ST-G23, ST-G28). Planned ONLY by `--set w1-driving --scenario W5A_SURF` on the table rows (w5a-cells.ts).
//
// The script withdraws seed 3 after round one (as R4 does) and plays on. At the end three doors are read and held to each other and to what the
// division declares, never to a table typed in:
//   standings   GET /stages/:id/standings[?pool_id]  - every row names its entrant (`name`), how they stand (`status`) and the pool key their rank is
//               within (`pool`; null on a league and on a one-pool group); a departed row is marked and ranks LAST in its table (RB5-W1);
//   pools       GET /stages/:id/pools                - a stage with several pools lists them in the product's order (keys A, B, ...); a league and a
//               one-pool group list none (X-BD-7);
//   all pools   standings with NO pool_id on a several-pool stage answers every pool, each row tagged with its pool's key (ST-G28), and holds exactly
//               the rows the per-pool reads hold;
//   public      the division's public standings carry the same rows in the same order, the departed one marked (RB5-K3: the page keeps their row).
import { DriverMisuse, type OrganiserDriver, type PublicStandingsOut, type StandingsRowWire } from "../driver/types.ts";
import { assertion, type Item } from "./assertions.ts";
import { Recorder, setUpDivision } from "./common.ts";
import { type Scenario } from "./types.ts";
import { entryPools, w5aField } from "../w5a-cells.ts";
import { finishRun, poolsOf, withdrawEntrant } from "./w5a-table.ts";
import type { WithdrawalObs } from "../observed.ts";

type Row = StandingsRowWire & { name?: string | null };
const POOL_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface SurfaceObs {
  readonly departed: string | null;
  /** entrant id -> the name the division stores for it (the entrants route, a door of its own). */
  readonly names: ReadonlyMap<string, string>;
  /** The pools the stage declares (the catalogue's body): 1 reads as a league. */
  readonly declaredPools: number;
  readonly listedPools: readonly { id: string; key: string }[];
  /** pool id (null: a league / one pool) -> that table's rows, per-pool read. */
  readonly perPool: ReadonlyMap<string | null, readonly Row[]>;
  /** The no-pool_id read of a several-pool stage; null when the stage has one table. */
  readonly allPools: readonly Row[] | null;
  /** The public document's tables for the stage, by pool id. */
  readonly publicPools: ReadonlyMap<string | null, readonly Row[]>;
}

/** The SURF items, every one counted. */
export function surfaceItems(o: SurfaceObs): Item[] {
  const several = o.declaredPools > 1;
  const keyOf = new Map(o.listedPools.map((p) => [p.id, p.key] as const));
  const items: Item[] = [
    { ok: o.perPool.size > 0 && [...o.perPool.values()].some((r) => r.length > 0), note: "no standings row was read - the surfaces proved nothing" },
    // pools route (X-BD-7)
    { ok: several ? o.listedPools.length === o.declaredPools : o.listedPools.length === 0, note: `pools route lists ${o.listedPools.length} pool(s), expected ${several ? o.declaredPools : 0} (${several ? "several pools are listed" : "a league / one pool lists none"}, X-BD-7)` },
    { ok: o.listedPools.every((p, i) => p.key === POOL_KEYS[i]), note: `pool keys ${o.listedPools.map((p) => p.key).join(",")}, expected ${POOL_KEYS.slice(0, o.listedPools.length).split("").join(",")} in the product's order` },
  ];
  for (const [pool, rows] of o.perPool) {
    const key = pool === null ? null : (keyOf.get(pool) ?? null);
    const label = pool === null ? "the table" : `pool ${key ?? pool}`;
    items.push({ ok: pool === null || key !== null, note: `${label}: a pool id the pools route does not list` });
    for (const r of rows) {
      items.push(
        { ok: typeof r.name === "string" && r.name.length > 0 && r.name === o.names.get(r.entrantId), note: `${label}: ${r.entrantId} is named ${JSON.stringify(r.name)}, the division stores ${JSON.stringify(o.names.get(r.entrantId))} (ST-G23)` },
        { ok: r.status === (r.entrantId === o.departed ? "withdrawn" : "active"), note: `${label}: ${r.entrantId} reads status ${r.status ?? "(none)"}, expected ${r.entrantId === o.departed ? "withdrawn" : "active"} (ST-G23)` },
        { ok: (r.pool ?? null) === key, note: `${label}: ${r.entrantId} reads pool ${r.pool ?? "null"}, expected ${key ?? "null"} (ST-G28)` },
      );
    }
    // RB5-W1: a departed row, when listed, is last
    const gone = rows.find((r) => r.entrantId === o.departed);
    if (gone !== undefined) items.push({ ok: gone.rank === Math.max(...rows.map((r) => r.rank ?? 0)), note: `${label}: the departed ranks ${gone.rank ?? "-"} of ${rows.length}, expected last (RB5-Wd1)` });
    // the public page: the same rows in the same order
    const pub = o.publicPools.get(pool);
    items.push({ ok: pub !== undefined, note: `${label}: the public standings carry no table for it` });
    if (pub !== undefined) {
      items.push(
        { ok: pub.map((r) => r.entrantId).join() === rows.map((r) => r.entrantId).join(), note: `${label}: the public order ${pub.map((r) => r.entrantId.slice(0, 4)).join(",")} is not the API's ${rows.map((r) => r.entrantId.slice(0, 4)).join(",")}` },
        { ok: pub.every((r) => r.status === (r.entrantId === o.departed ? "withdrawn" : "active")), note: `${label}: a public row's status disagrees with the API's (RB5-K3: the page keeps the departed row, marked)` },
      );
    }
  }
  // all-pools read (ST-G28)
  if (several) {
    const all = o.allPools;
    const expected = [...o.perPool.values()].reduce((n, r) => n + r.length, 0);
    items.push({ ok: all !== null, note: "the several-pool stage answered no all-pools table" });
    if (all !== null) {
      items.push({ ok: all.length === expected, note: `the all-pools read holds ${all.length} row(s), the per-pool reads hold ${expected}` });
      for (const [pool, rows] of o.perPool) for (const r of rows) {
        const hit = all.find((x) => x.entrantId === r.entrantId);
        items.push({ ok: hit !== undefined && hit.pool === (keyOf.get(pool ?? "") ?? null) && hit.rank === r.rank, note: `${r.entrantId}: the all-pools row ${hit === undefined ? "is absent" : `reads pool ${hit.pool ?? "null"} rank ${hit.rank ?? "-"}`}, the per-pool read pool ${keyOf.get(pool ?? "") ?? "null"} rank ${r.rank ?? "-"}` });
      }
    }
  } else items.push({ ok: o.allPools === null, note: "a stage with one table answered an all-pools read" });
  return items;
}

function drivesSurfaces(d: OrganiserDriver): d is OrganiserDriver & Required<Pick<OrganiserDriver, "stagePools">> {
  return d.stagePools !== undefined;
}

const surf: Scenario = {
  key: "W5A_SURF",
  entrantCount: 8,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, w5aField("W5A_SURF", ctx.spec.row));
    const d = ctx.driver;
    if (!drivesSurfaces(d)) throw new DriverMisuse("driver: W5A_SURF needs stagePools - the HTTP driver has it, a layer that does not drive the path says so");
    const stage = setup.stage;
    const seed3 = setup.idOfSeed(3);
    let obs: WithdrawalObs | null = null;
    let departed: string | null = null;
    return finishRun(
      ctx, rec, setup,
      async () => {
        const names = new Map((await d.listEntrants(setup.division.id)).map((e) => [e.id, e.display_name] as const));
        const listedPools = (await poolsOf(ctx, stage.id)).pools;
        const perPool = new Map<string | null, readonly Row[]>();
        for (const id of listedPools.length === 0 ? [null] : listedPools.map((p) => p.id)) perPool.set(id, (await d.standings(stage.id, id)).rows as Row[]);
        const allPools = listedPools.length > 1 ? ((await d.standings(stage.id, null)).rows as Row[]) : null;
        const pub: PublicStandingsOut = await d.publicStandings({ orgSlug: ctx.orgSlug, competitionSlug: setup.competition.slug, divisionSlug: setup.division.slug });
        const publicPools = new Map<string | null, readonly Row[]>();
        for (const t of pub.standings.filter((s) => s.stage_id === stage.id)) publicPools.set(t.pool_id, t.rows as Row[]);
        return [assertion("w5a-surf-table-surfaces", surfaceItems({ departed, names, declaredPools: entryPools(ctx.spec.row), listedPools, perPool, allPools, publicPools }))];
      },
      {
        afterRound: async (round) => {
          if (obs !== null || round !== 1) return;
          const w = await withdrawEntrant(ctx, rec, setup, seed3, round);
          obs = w.obs;
          departed = seed3;
        },
      },
      () => obs,
    );
  },
};

export const w5aSurfScenarios: Readonly<Partial<Record<"W5A_SURF", Scenario>>> = Object.freeze({ W5A_SURF: surf });
