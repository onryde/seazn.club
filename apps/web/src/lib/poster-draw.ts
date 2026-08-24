// Pure "round-by-round list" model builder for the public poster's draw
// pages (Group D, 2026-08-24 — poster.pdf/route.ts page 2 onward). Isomorphic
// — no pdfkit, no `server-only` — same "pure helpers, unit-testable without a
// DB" convention as schedule-board.ts: the route calls this once per division
// to get a fully resolved, print-ready structure, then owns ONLY the pdfkit
// layout (pagination, fonts, coordinates).
//
// Groups fixtures by (stage, pool, round). A pooled group stage runs N
// INDEPENDENT round-robins, one per pool — Pool A's "Round 1" and Pool B's
// "Round 1" are different matches on paper, so pools are never merged into
// one round bucket even when their round_no's coincide. A double-elim
// stage's WB/LB rounds share the same round_no numbering space too; `lane`
// keeps them from interleaving (the WB block prints whole, then LB's, then
// GF) WITHOUT attempting to derive the harder "Quarterfinal/Semifinal"-style
// round ROLE naming — that scheme is easy to get subtly wrong per k-value
// (see the F1 bracket round-role review) and the owner ruling for this
// poster only ever asked for a round-by-round LIST, not bracket geometry.
// This prints the same generic "Round {n}" label schedule-board's own round
// view already uses elsewhere in the product, qualified with a Winners/
// Losers/Grand final prefix reused from the public bracket display
// (bracket.winners/bracket.losers/bracket.grandFinal, bracket.tsx) so the
// wording never drifts from what that surface already calls the same lanes.
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import type { PublicFixture } from "@/server/public-site/data";

export interface DrawFixtureRow {
  id: string;
  home: string;
  away: string;
}

export interface DrawRoundGroup {
  /** Fully resolved, print-ready heading — e.g. "Round 1",
   *  "Winners bracket · Round 2", "Grand final". */
  label: string;
  fixtures: DrawFixtureRow[];
}

export interface DrawPoolGroup {
  /** null for a stage with no pools — every fixture shares one group. */
  poolName: string | null;
  rounds: DrawRoundGroup[];
}

export interface DrawStageGroup {
  stageName: string;
  pools: DrawPoolGroup[];
}

export interface BuildDrawModelInput {
  stages: { id: string; seq: number; name: string }[];
  pools: { id: string; stage_id: string; name: string }[];
  fixtures: PublicFixture[];
  /** entrant id -> display name. A fixture whose entrant id has no entry
   *  here (data-integrity edge case — same gap calendar.ics's own entrant
   *  fallback guards) resolves to the localized "unknown entrant" string,
   *  never a raw id or hardcoded English. */
  entrantNames: Record<string, string>;
}

type Lane = PublicFixture["lane"];

const laneRank = (lane: Lane | null): number =>
  lane === "WB" ? 0 : lane === "LB" ? 1 : lane === "GF" ? 2 : 0;

/** One side's display text: the roster name when the slot is filled, else
 *  the fixture's own slot label resolved through the SAME resolver (and the
 *  same fallback key) every other public surface uses — so this can never
 *  drift from what the board/calendar feed already show for the identical
 *  fixture. */
function sideText(
  id: string | null,
  label: PublicFixture["home_slot_label"],
  entrantNames: Record<string, string>,
  lookup: SlotLabelLookup,
): string {
  return id
    ? (entrantNames[id] ?? lookup("calendar.unknownEntrant"))
    : resolveSlotLabel(label, lookup, "schedule.tbd");
}

interface RoundBucket {
  roundNo: number;
  lane: Lane | null;
  rows: DrawFixtureRow[];
}

export function buildDrawModel(input: BuildDrawModelInput, lookup: SlotLabelLookup): DrawStageGroup[] {
  const { stages, pools, fixtures, entrantNames } = input;
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const poolById = new Map(pools.map((p) => [p.id, p]));
  const poolRank = new Map(pools.map((p, i) => [p.id, i]));

  const stageOrder: string[] = [];
  const byStage = new Map<string, { poolOrder: string[]; byPool: Map<string, RoundBucket[]> }>();

  // Defensive sort — a pure function should not trust the caller's array
  // order, even though the route's own fetch is already `order by round_no,
  // seq_in_round`.
  const sorted = [...fixtures].sort(
    (a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round,
  );

  for (const f of sorted) {
    if (!byStage.has(f.stage_id)) {
      byStage.set(f.stage_id, { poolOrder: [], byPool: new Map() });
      stageOrder.push(f.stage_id);
    }
    const stageBucket = byStage.get(f.stage_id)!;
    const poolKey = f.pool_id ?? "";
    if (!stageBucket.byPool.has(poolKey)) {
      stageBucket.byPool.set(poolKey, []);
      stageBucket.poolOrder.push(poolKey);
    }
    const buckets = stageBucket.byPool.get(poolKey)!;
    const lane = f.lane ?? null;
    let bucket = buckets.find((b) => b.roundNo === f.round_no && b.lane === lane);
    if (!bucket) {
      bucket = { roundNo: f.round_no, lane, rows: [] };
      buckets.push(bucket);
    }
    bucket.rows.push({
      id: f.id,
      home: sideText(f.home_entrant_id, f.home_slot_label, entrantNames, lookup),
      away: sideText(f.away_entrant_id, f.away_slot_label, entrantNames, lookup),
    });
  }

  // Stage order follows the division's own stage sequence, not fixture
  // arrival order — a stage absent from `stages` (should not happen) sorts
  // last rather than throwing.
  stageOrder.sort((a, b) => (stageById.get(a)?.seq ?? Infinity) - (stageById.get(b)?.seq ?? Infinity));

  return stageOrder.map((stageId) => {
    const stageBucket = byStage.get(stageId)!;
    // No-pool group ("") always first; real pools follow the division's own
    // pool order (already key-sorted upstream by the fetch query).
    const orderedPoolKeys = [...stageBucket.poolOrder].sort((a, b) => {
      if (a === "") return -1;
      if (b === "") return 1;
      return (poolRank.get(a) ?? 0) - (poolRank.get(b) ?? 0);
    });

    const poolGroups: DrawPoolGroup[] = orderedPoolKeys.map((poolKey) => {
      // Lane groups its whole block together (every WB round, then every LB
      // round, then GF) BEFORE round_no breaks the tie within a lane — a
      // double-elim's WB/LB round_no numbering can coincide, and sorting by
      // round_no first would interleave the two lanes' fixtures on the page.
      const buckets = [...stageBucket.byPool.get(poolKey)!].sort(
        (a, b) => laneRank(a.lane) - laneRank(b.lane) || a.roundNo - b.roundNo,
      );
      let gfSeen = false;
      const rounds: DrawRoundGroup[] = buckets.map((b) => {
        let label: string;
        if (b.lane === "WB") {
          label = `${lookup("bracket.winners")} · ${lookup("schedule.round", { n: b.roundNo })}`;
        } else if (b.lane === "LB") {
          label = `${lookup("bracket.losers")} · ${lookup("schedule.round", { n: b.roundNo })}`;
        } else if (b.lane === "GF") {
          // Order-based, not derived from the round_no's value: the first GF
          // round encountered (already round_no-ascending from the sort
          // above) is the grand final; any further one is the reset match.
          label = gfSeen ? lookup("bracket.round.grandFinalReset") : lookup("bracket.grandFinal");
          gfSeen = true;
        } else {
          label = lookup("schedule.round", { n: b.roundNo });
        }
        return { label, fixtures: b.rows };
      });
      return { poolName: poolKey ? (poolById.get(poolKey)?.name ?? null) : null, rounds };
    });

    return { stageName: stageById.get(stageId)?.name ?? "", pools: poolGroups };
  });
}
