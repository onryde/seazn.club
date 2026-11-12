// Sponsor x live-stream matrix, L1 (docs/superpowers/specs/2026-11-12-sponsor-stream-matrix-design.md, "The matrix"): the cell
// generator. TEST-ONLY and PURE - no database, no usecase, no clock. It decides WHICH combinations the DB-backed suite
// (stream-matrix.test.ts) drives; the answer for each is the oracle's (stream-matrix-oracle.ts), never this file's.
//
// Axes (the spec's, plus two this suite adds and says so):
//   plan     free | pass | pro                      the org's plan; `pass` is an Event Pass on THE competition the stream is in
//   tier     title | gold | silver | partner        SPONSOR_TIERS (the tier authority), the deal's package tier
//   state    none | waiting | live | scheduled | ended | written_off | archived
//              none       no deal: a sponsor the club made by hand and ticked on (manual control)
//              waiting    ADDED here: a deal that has not gone live (awaiting payment, or paid and awaiting approval). The spec's
//                         "awaiting payment" is a payment value; without this state it would only ever be met on a deal that
//                         already airs, and "paid but not live yet" would never be reached at all.
//              live       a deal that is live
//              scheduled  a deal queued behind the sponsor's live one (spec §8a)
//              ended      a deal that has ended (End now)
//              written_off an unpaid offline invoice the club waived after its deal ran out
//              archived   the sponsor is archived
//   payment  online_paid | offline_paid | complimentary | awaiting     ("n/a" when state is none: no deal, so no payment)
//   scope    org | this | other                    the whole org / the competition the stream is in / another competition
//   stream   on | off                              ADDED here: whether the deal (or the hand tick) puts the sponsor on the stream
//              at all. Off is the one value that separates "airs" from "is on the public page"; without it the two answers
//              could never differ.
// Stream MODE (composed vs passthrough) is L2's, not here.
//
// SELECTION (spec: "pairwise over the axes plus every single-axis edge"):
//   1. every PAIR of values of two different axes that some reachable cell holds is held by at least one generated cell
//      (greedy cover over the whole cartesian product, deterministic);
//   2. one-factor-at-a-time from a BASELINE cell: every non-baseline value of every axis appears in a cell that differs from the
//      baseline in that axis only (the single-axis edges);
//   3. THREE FULL INTERACTION FAMILIES, added because pairwise alone left a whole arm unreached (the first run of the closing test:
//      no cell wrote an unpaid offline invoice off - every cell that held the pair written_off x awaiting was one the plan refuses,
//      so the pair was "covered" and the behaviour never ran). A pair is not an arm; where the script or the gate differs per
//      combination of more than two axes, the combinations are enumerated:
//        STATE x PAYMENT   on the accepting baseline (a Pro org, partner, whole org, on the stream): the scripts differ per pair, so
//                          each pair runs where the plan does not refuse it;
//        PLAN x TIER x SCOPE for the two payments whose gates differ (offline: the placement gate only; online: the placement gate,
//                          then `sponsors.monetize`), at the baseline state: the whole plan-gate table. NOT the flattening table: a
//                          cell makes its sponsor AFTER the plan is set, and a plan without `sponsors.tiers` refuses every placement
//                          that is not already partner on the whole org, so no cell ever shows a tier flattened. The flattening (ruling
//                          R13) is decided by the downgrade sequences in the test file (a plan change under a live stream; a frozen
//                          break unticked after a downgrade), never by a cell;
//        the same PLAN x TIER x SCOPE x PAYMENT with the STREAM flag OFF (review round 1, I1): the flag is the one value that separates
//                          "airs" from "is on the public page", and a deal writes it from its package alone, so the off arm is met for
//                          every placement and payment a deal can be made with. One witness cell left the mutants that ignore the flag
//                          for a scoped, a gold or an online deal alive (`on_stream: live.includes_on_stream || ...`).
// A combination is never dropped as "unreachable": a plan that cannot buy a tier REFUSES the deal, and the refusal is the cell's
// checked answer (a refused cell is a checked cell).
import { SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";

export const PLANS = ["free", "pass", "pro"] as const;
export const STATES = ["none", "waiting", "live", "scheduled", "ended", "written_off", "archived"] as const;
export const PAYMENTS = ["online_paid", "offline_paid", "complimentary", "awaiting"] as const;
export const SCOPES = ["org", "this", "other"] as const;
export const STREAMS = ["on", "off"] as const;

export type Plan = (typeof PLANS)[number];
export type DealState = (typeof STATES)[number];
export type Payment = (typeof PAYMENTS)[number];
export type Scope = (typeof SCOPES)[number];
export type StreamFlag = (typeof STREAMS)[number];

/** The payment of a cell with no deal. A marker, never a value a pair is demanded of. */
export const NO_PAYMENT = "n/a" as const;

export interface Cell {
  plan: Plan;
  tier: SponsorTier;
  state: DealState;
  payment: Payment | typeof NO_PAYMENT;
  scope: Scope;
  stream: StreamFlag;
}

/** The axes in a fixed order, as [name, values]. */
export const AXES = [
  ["plan", PLANS],
  ["tier", SPONSOR_TIERS],
  ["state", STATES],
  ["payment", PAYMENTS],
  ["scope", SCOPES],
  ["stream", STREAMS],
] as const satisfies readonly (readonly [keyof Cell, readonly string[]])[];

/** The OFAT baseline: the commonest happy cell (a Pro org, a partner on the whole org, live, paid by hand, on the stream). */
export const BASELINE: Cell = {
  plan: "pro",
  tier: "partner",
  state: "live",
  payment: "offline_paid",
  scope: "org",
  stream: "on",
};

/** A cell with no deal has no payment: canonicalise, so two spellings of "no deal" are one cell. */
function canonical(c: Cell): Cell {
  return c.state === "none" ? { ...c, payment: NO_PAYMENT } : c;
}

export const cellId = (c: Cell): string =>
  `plan=${c.plan} tier=${c.tier} state=${c.state} pay=${c.payment} scope=${c.scope} stream=${c.stream}`;

/** The whole product, canonicalised and de-duplicated, in axis order. */
export function fullProduct(): Cell[] {
  const seen = new Set<string>();
  const out: Cell[] = [];
  for (const plan of PLANS)
    for (const tier of SPONSOR_TIERS)
      for (const state of STATES)
        for (const payment of PAYMENTS)
          for (const scope of SCOPES)
            for (const stream of STREAMS) {
              const c = canonical({ plan, tier, state, payment, scope, stream });
              const id = cellId(c);
              if (seen.has(id)) continue;
              seen.add(id);
              out.push(c);
            }
  return out;
}

/** The pair keys of one cell: every two axes' values, the "n/a" payment excluded (it is not a value anything is demanded of). */
export function pairsOf(c: Cell): string[] {
  const vals = AXES.map(([name]) => [name, c[name]] as const).filter(([, v]) => v !== NO_PAYMENT);
  const out: string[] = [];
  for (let i = 0; i < vals.length; i++)
    for (let j = i + 1; j < vals.length; j++) out.push(`${vals[i]![0]}=${vals[i]![1]}|${vals[j]![0]}=${vals[j]![1]}`);
  return out;
}

export interface Generated {
  /** Every cell to drive, de-duplicated, pairwise first then the single-axis edges, in a stable order. */
  cells: Cell[];
  /** The pairs the whole product holds (what pairwise coverage must reach). */
  pairsRequired: number;
  /** How many cells the pairwise cover needed / the single-axis edges added beyond it / the interaction families added beyond both. */
  pairwiseCells: number;
  edgeCellsAdded: number;
  familyCellsAdded: number;
}

/** Greedy pairwise cover over `candidates`: repeatedly take the candidate that covers the most pairs not yet covered; ties go to
 *  the earliest in axis order, so the same input always yields the same cells. */
function greedyCover(candidates: readonly Cell[]): { chosen: Cell[]; required: Set<string> } {
  const required = new Set(candidates.flatMap(pairsOf));
  const covered = new Set<string>();
  const chosen: Cell[] = [];
  const pairs = candidates.map(pairsOf);
  while (covered.size < required.size) {
    let best = -1;
    let bestGain = 0;
    for (let i = 0; i < candidates.length; i++) {
      let gain = 0;
      for (const p of pairs[i]!) if (!covered.has(p)) gain++;
      if (gain > bestGain) {
        bestGain = gain;
        best = i;
      }
    }
    if (best < 0) throw new Error("pairwise cover stalled with pairs left: the product is not closed under its own pairs");
    chosen.push(candidates[best]!);
    for (const p of pairs[best]!) covered.add(p);
  }
  return { chosen, required };
}

export function generateCells(): Generated {
  const product = fullProduct();
  const { chosen, required } = greedyCover(product);
  const byId = new Map(chosen.map((c) => [cellId(c), c]));
  const pairwiseCells = byId.size;
  // One factor at a time from the baseline: each non-baseline value of each axis, everything else as the baseline.
  for (const [name, values] of AXES) {
    for (const v of values) {
      if (BASELINE[name] === v) continue;
      const c = canonical({ ...BASELINE, [name]: v });
      byId.set(cellId(c), c);
    }
  }
  byId.set(cellId(BASELINE), BASELINE);
  const withEdges = byId.size;
  for (const c of interactionFamilies()) byId.set(cellId(c), c);
  const cells = [...byId.values()].sort((a, b) => cellId(a).localeCompare(cellId(b)));
  return {
    cells, pairsRequired: required.size, pairwiseCells, edgeCellsAdded: withEdges - pairwiseCells, familyCellsAdded: byId.size - withEdges,
  };
}

/** Item 3 of the selection (header): the STATE x PAYMENT family on the accepting baseline, and the PLAN x TIER x SCOPE family for
 *  the offline and online payment paths at the baseline state, with the stream flag on AND off. */
export function interactionFamilies(): Cell[] {
  const out: Cell[] = [];
  for (const state of STATES) for (const payment of PAYMENTS) out.push(canonical({ ...BASELINE, state, payment }));
  for (const plan of PLANS)
    for (const tier of SPONSOR_TIERS)
      for (const scope of SCOPES)
        for (const payment of ["offline_paid", "online_paid"] as const)
          for (const stream of STREAMS) out.push(canonical({ ...BASELINE, plan, tier, scope, payment, stream }));
  return out;
}
