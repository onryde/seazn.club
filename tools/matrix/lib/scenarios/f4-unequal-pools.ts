// W5 app PR B (K21; Task 4, ST-G3, ruling 286): F4 - unequal pools. Activated here: the app PR A script waited for the engine major that makes
// a short pool's table honest (pool membership as seating, `TableStage.pools`, `PoolTable.expunged`, the best-Nth at k = size - min).
// Planned ONLY by `--set w1-driving --scenario W5A_F4` on the pooled rows (w5a-cells.ts).
//
// The script seeds a field that does NOT divide by the root stage's pool count (w5aField: pools x 3 + 1), and posts the row with the take the root
// stage feeds turned into a cross-pool comparison: `topNPerGroup n` becomes `topNPerGroup n-1` plus `bestNth nth n` over EVERY pool (the same seat
// count, so the destination keeps its shape and no cross-pool draw is refused - RB5-D10; a snake placement becomes rank_order, the product's rule). It plays the row out and, before the destination's draft
// is confirmed, re-proposes it (the organiser's Recompute) to read the slots' stored basis. Expected values are the rulebook's, read against the
// stage's OWN final tables, never against the basis the product answered:
//   the fold        every pool's table lists exactly its seated members, each with (size - 1) x legs played (X-PO-1; a short pool is no defect);
//   RB5-U8          the proposal is answered, never refused for the size difference (SEEDING_BESTNTH_UNEQUAL_POOLS is gone);
//   RB5-U1/U7       min = the smallest pool that supplies an nth; every slot is compared on (min - 1) x legs matches; each larger supplier drops
//                   its bottom (size - min), and a pool at the minimum drops nothing;
//   RB5-U4          the dropped entrants are the bottom of that pool's OWN final table (its cascade, stored lots included);
//   RB5-U3          every best-Nth slot carries the basis, one comparison for all of them, and the seat is its pool's nth row.
// A row whose root stage feeds nothing (group_only) is judged on the fold alone, and says so in a counted item.
import { RefusedCall, type ComparisonBasisWire, type OrganiserDriver, type SeedQualifierWire, type StandingsRowWire } from "../driver/types.ts";
import type { StagePostBody } from "../catalogue.ts";
import { assertion, type Item } from "./assertions.ts";
import { Recorder, setUpDivision } from "./common.ts";
import { type Scenario } from "./types.ts";
import { w5aField } from "../w5a-cells.ts";
import { finishRun, poolsOf, stageLines } from "./w5a-table.ts";

/** The refusal ruling 286 removed: answered for this case, it is RB5-U8's red by name. */
export const UNEQUAL_POOLS_REFUSAL = "SEEDING_BESTNTH_UNEQUAL_POOLS";

type Take = Readonly<Record<string, unknown>>;

/** The row's bodies with the take its ROOT pooled stage feeds turned into a cross-pool comparison: `topNPerGroup n` -> `topNPerGroup n-1` (none at
 *  n = 1) + `bestNth nth n count <pools>`. Every other body is posted as the row has it. A row whose root stage feeds nothing is returned unchanged;
 *  a fed take of another kind is refused by name (a row that gained one is a script to extend, never a silent no-op). */
export function f4Bodies(bodies: readonly StagePostBody[]): StagePostBody[] {
  const root = bodies[0];
  const pools = (root?.config.pools as { count?: unknown } | undefined)?.count;
  if (root?.kind !== "group" || typeof pools !== "number" || pools < 2) throw new Error(`F4: the row's root stage is no pooled group (${root?.kind ?? "none"})`);
  return bodies.map((b) => {
    if (b.seq !== root.seq + 1 || b.progression === null || b.progression === undefined) return b;
    const sources = (b.progression.sources ?? []).map((src) => ({
      ...src,
      take: (src.take as readonly Take[]).flatMap((t): Take[] => {
        if (t.kind !== "topNPerGroup") throw new Error(`F4: the fed take '${String(t.kind)}' is not one the W5A pooled rows use (topNPerGroup)`);
        const n = Number(t.n);
        return [...(n > 1 ? [{ kind: "topNPerGroup", n: n - 1 }] : []), { kind: "bestNth", nth: n, count: pools }];
      }),
    }));
    // The product refuses a snake placement over a bestNth-sourced pot by name (CONFIG_INVALID: snakeMerge would seed the weakest wildcard into the
    // strongest slot), so a snake destination is posted rank_order - the placement the product names.
    const placement = b.progression.placement === "snake" ? "rank_order" : b.progression.placement;
    return { ...b, progression: { ...b.progression, sources, placement } } as StagePostBody;
  });
}

/** The fed stage's best-Nth take, as `f4Bodies` posted it (null: the root stage feeds nothing). */
export function bestNthTakeOf(bodies: readonly StagePostBody[]): { nth: number; count: number } | null {
  const fed = bodies.find((b) => b.seq === (bodies[0]?.seq ?? 0) + 1);
  for (const src of fed?.progression?.sources ?? []) {
    for (const t of src.take as readonly Take[]) if (t.kind === "bestNth") return { nth: Number(t.nth), count: Number(t.count) };
  }
  return null;
}

export interface F4Pool {
  readonly key: string;
  /** The pool's seated members, read off its lines. */
  readonly members: ReadonlySet<string>;
  /** The pool's final table, as GET /stages/:id/standings?pool_id answered it. */
  readonly rows: readonly StandingsRowWire[];
}
export interface F4Obs {
  /** The root stage's pools, in the product's order. */
  readonly pools: readonly F4Pool[];
  readonly legs: number;
  /** The fed stage's best-Nth take (null: the row feeds nothing). */
  readonly take: { readonly nth: number; readonly count: number } | null;
  /** The re-proposed draft (or its refusal); null when the run never reached the destination. */
  readonly proposal: { readonly qualifiers: readonly SeedQualifierWire[] } | RefusedCall | null;
}

/** A pool's rows in its own final order: by rank, the listed order inside a shared rank. */
const ordered = (rows: readonly StandingsRowWire[]): StandingsRowWire[] =>
  rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.rank ?? Infinity) - (b.r.rank ?? Infinity) || a.i - b.i).map((x) => x.r);

/** RB5-U4: the bottom `k` of a pool's own table. A shared rank straddling the edge allows any of its members (`allowed`); `sure` are below it. */
function bottomOf(rows: readonly StandingsRowWire[], k: number): { sure: Set<string>; allowed: Set<string> } {
  const o = ordered(rows);
  if (k <= 0) return { sure: new Set(), allowed: new Set() };
  const edge = o[o.length - k]?.rank ?? null;
  const allowed = new Set(o.slice(o.length - k).map((r) => r.entrantId));
  if (edge !== null) for (const r of o) if (r.rank === edge) allowed.add(r.entrantId);
  const sure = new Set(o.slice(o.length - k).filter((r) => r.rank !== edge || edge === null).map((r) => r.entrantId));
  return { sure, allowed };
}

/** The F4 items, every one counted. */
export function unequalPoolItems(o: F4Obs): Item[] {
  const items: Item[] = [];
  const sizes = o.pools.map((p) => p.members.size);
  items.push({ ok: o.pools.length >= 2, note: `the root stage holds ${o.pools.length} pool(s) - F4 needs two or more` });
  items.push({ ok: new Set(sizes).size > 1, note: `pool sizes ${sizes.join("/")} - the field divided evenly, F4 has nothing to act on` });
  // the fold: a short pool's table is honest (X-PO-1: every seated member is a row; RB5-U1's premise: each played her own pool's matches)
  for (const p of o.pools) {
    const rowIds = new Set(p.rows.map((r) => r.entrantId));
    items.push({ ok: rowIds.size === p.members.size && [...p.members].every((m) => rowIds.has(m)), note: `pool ${p.key}: the table lists ${rowIds.size} row(s), ${p.members.size} seated - expected exactly its members` });
    const owed = (p.members.size - 1) * o.legs;
    for (const r of p.rows) items.push({ ok: r.played === owed, note: `pool ${p.key}: ${r.entrantId} played ${r.played ?? "(none)"}, expected ${owed} (her own pool's matches)` });
  }
  if (o.take === null) {
    items.push({ ok: true, note: "the root stage feeds no stage: the fold alone is judged" });
    return items;
  }
  const take = o.take;
  if (o.proposal === null) {
    items.push({ ok: false, note: "the destination was never proposed - the best-Nth comparison was not reached" });
    return items;
  }
  if (o.proposal instanceof RefusedCall) {
    items.push({ ok: false, note: `the proposal was refused ${o.proposal.status} ${o.proposal.code ?? "(no code)"}${o.proposal.code === UNEQUAL_POOLS_REFUSAL ? " - RB5-U8: never refused for the size difference" : ""}` });
    return items;
  }
  items.push({ ok: true, note: "RB5-U8: the proposal over unequal pools was answered" });
  const slots = o.proposal.qualifiers.filter((q) => q.basis !== undefined);
  items.push({ ok: slots.length === take.count, note: `${slots.length} slot(s) carry a comparison basis, the take seats ${take.count} best of place ${take.nth} - RB5-U3: the basis is stored on every one` });
  const suppliers = o.pools.filter((p) => p.members.size >= take.nth);
  const min = Math.min(...suppliers.map((p) => p.members.size));
  items.push({ ok: suppliers.length > 0, note: `${suppliers.length} pool(s) supply a place ${take.nth}` });
  const first = slots[0]?.basis;
  for (const s of slots) {
    const b = s.basis as ComparisonBasisWire;
    items.push({ ok: b.nth === take.nth, note: `${s.entrantId}: compared at place ${b.nth}, the take names place ${take.nth}` });
    items.push({ ok: b.matchesCounted === (min - 1) * o.legs, note: `${s.entrantId}: compared on ${b.matchesCounted} match(es), expected ${(min - 1) * o.legs} (the smallest supplier, ${min}, RB5-U1/U7)` });
    // one comparison seats them all: its place, matches and drops are shared; `levelWith` is the slot's own (who she is level with)
    const shared = (x: ComparisonBasisWire | undefined) => JSON.stringify(x === undefined ? null : [x.nth, x.matchesCounted, x.dropped]);
    items.push({ ok: shared(b) === shared(first), note: `${s.entrantId}: a comparison unlike the first slot's (place, matches, drops) - one comparison seats every best of place ${take.nth}` });
    for (const other of b.levelWith) {
      const twin = slots.find((x) => x.entrantId === other);
      const candidate = suppliers.some((p) => ordered(p.rows)[take.nth - 1]?.entrantId === other);
      items.push({ ok: other !== s.entrantId && candidate && (twin === undefined || (twin.basis?.levelWith ?? []).includes(s.entrantId)), note: `${s.entrantId}: level with ${other}, who is ${candidate ? "" : "no candidate at place " + take.nth + ", "}${twin !== undefined && !(twin.basis?.levelWith ?? []).includes(s.entrantId) ? "not level with her in return" : "named"} (levelWith is symmetric among candidates)` });
    }
    const home = o.pools.find((p) => p.members.has(s.entrantId));
    items.push({ ok: home !== undefined && s.pool === home.key, note: `${s.entrantId}: the slot names pool ${s.pool ?? "(none)"}, she sits in ${home?.key ?? "no pool"}` });
    items.push({ ok: home !== undefined && ordered(home.rows)[take.nth - 1]?.entrantId === s.entrantId, note: `${s.entrantId}: not place ${take.nth} of pool ${home?.key ?? "(none)"} - RB5-U1's candidates are each pool's place ${take.nth}` });
  }
  if (first !== undefined) {
    for (const p of suppliers) {
      const k = p.members.size - min;
      const named = first.dropped.filter((d) => d.pool === p.key);
      if (k === 0) {
        items.push({ ok: named.length === 0, note: `pool ${p.key} (size ${p.members.size}, the minimum): drops ${named.flatMap((d) => d.against).join(",") || "nothing"}, expected nothing (RB5-U1)` });
        continue;
      }
      const against = named.flatMap((d) => d.against);
      const { sure, allowed } = bottomOf(p.rows, k);
      items.push({ ok: named.length === 1 && against.length === k, note: `pool ${p.key} (size ${p.members.size}): drops ${against.length} entrant(s)' results, expected k = ${p.members.size} - ${min} = ${k} (RB5-U7)` });
      items.push({ ok: [...sure].every((e) => against.includes(e)) && against.every((e) => allowed.has(e)), note: `pool ${p.key}: drops ${against.join(",")}, its own table's bottom ${k} is ${[...allowed].join(",")} (RB5-U4)` });
    }
    const known = new Set(o.pools.map((p) => p.key));
    for (const d of first.dropped) items.push({ ok: known.has(d.pool) && suppliers.some((p) => p.key === d.pool), note: `the basis drops from pool ${d.pool}, which is no supplying pool of the stage` });
  }
  return items;
}

function drivesF4(d: OrganiserDriver): d is OrganiserDriver & Required<Pick<OrganiserDriver, "stagePools">> {
  return d.stagePools !== undefined;
}

export const f4UnequalPools: Scenario = {
  key: "W5A_F4",
  entrantCount: 7,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, w5aField("W5A_F4", ctx.spec.row), { bodies: f4Bodies });
    const d = ctx.driver;
    if (!drivesF4(d)) throw new Error("driver: W5A_F4 needs stagePools - the HTTP driver has it, a layer that does not drive the path says so");
    const root = setup.stage;
    const take = bestNthTakeOf(setup.built.posted.stages);
    const legs = Number((setup.built.posted.stages[0]?.config as { legs?: unknown }).legs ?? 1);
    let proposal: F4Obs["proposal"] = null;
    return finishRun(
      ctx, rec, setup,
      async () => {
        const lines = await stageLines(ctx, setup, root.id);
        const pools: F4Pool[] = [];
        for (const p of (await poolsOf(ctx, root.id)).pools) {
          const members = new Set(lines.filter((l) => l.poolId === p.id).flatMap((l) => [l.home, l.away]).filter((e): e is string => e !== null));
          pools.push({ key: p.key, members, rows: (await d.standings(root.id, p.id)).rows });
        }
        return [assertion("w5a-f4-unequal-pools", unequalPoolItems({ pools, legs, take, proposal }))];
      },
      {
        beforeConfirm: async (stage, drafted) => {
          // the stage the root feeds only (a later stage's draft is not this comparison)
          if (stage.seq !== root.seq + 1 || take === null) return drafted;
          try {
            const fresh = await d.recomputeSeedProposal(stage.id);
            proposal = { qualifiers: fresh.qualifiers };
            return { id: fresh.id, status: fresh.status };
          } catch (e) {
            if (!(e instanceof RefusedCall)) throw e;
            rec.notes.push(`stage ${stage.seq}: the re-proposal was refused ${e.status} ${e.code ?? "(no code)"}`);
            proposal = e;
            return drafted;
          }
        },
      },
    );
  },
};

export const w5aF4Scenarios: Readonly<Partial<Record<"W5A_F4", Scenario>>> = Object.freeze({ W5A_F4: f4UnequalPools });
