import "server-only";
// W5 app PR B Task 5 (FX-G5; owner Q6, ruling 281; RB5-D1..D10; preflight K22, K23): a knockout-shaped stage fed from groups
// never pairs two entrants of one pool in round one. The resolver's seats (rank, then the wave interleave - today's
// `rank_order`) are handed to the engine's `crossPoolDraw` with the destination's STORED draw seed, which (a) shuffles each run
// of seeds level across pools (`tied`, `lib/cross-pool-ties.ts`) and (b) permutes each later rank tier until no real round-one
// pair shares a pool, or refuses by name. Its `order` is the new seed order: seed i sits where the destination's TBD lines put
// seed i (`destinationSlotsBySeed`, the same `seedPositions` geometry the draw's `slotOrder` declares), so re-seating the
// qualifiers is the whole of the wiring - no line is redrawn.
//
// Served only where it means something (N6/K23): a `knockout`, `stepladder` or `page_playoff` destination, placed `rank_order`
// (an organiser's `seeded_map` or `picks` list is theirs; `snake` never reaches a bracket), from ONE source's pools with at least two distinct
// pools (`pooledSeeds`). Anything else - a league-sourced stepladder, a one-pool group, a plate - keeps today's seats and never
// calls the draw.
import { HttpError } from "@/lib/errors";
import { EngineError } from "@seazn/engine/core";
import { swissDrawSeed } from "@/lib/swiss-draw";
import { CROSS_POOL_SHAPES, pooledSeeds, type CrossPoolEntry } from "@/lib/cross-pool-ties";
import { crossPoolDraw } from "@seazn/engine/scheduling";
import type { ProgressionSpec, SourceTables } from "@seazn/engine/competition";
import type { Tx } from "./types";
import { readStageDrawSeed } from "./generators";

export { CROSS_POOL_SHAPES };

/** The destination's stored draw seed (ruling 281, W4 RB4-D4): the one its newest proposal drew with, else the one its newest
 *  Generate recorded, else minted from the stage id (`swissDrawSeed`, W4 K5) - and then stored on the proposal that uses it. */
export async function storedCrossPoolSeed(tx: Tx, stageId: string): Promise<number> {
  const [row] = await tx<{ seed: unknown }[]>`
    select computed->'crossPoolDraw'->'seed' as seed from stage_seed_proposals
     where stage_id = ${stageId} and computed ? 'crossPoolDraw'
     order by created_at desc, id desc limit 1`;
  if (typeof row?.seed === "number" && Number.isInteger(row.seed)) return row.seed;
  return (await readStageDrawSeed(tx, stageId)) ?? swissDrawSeed(stageId);
}

/** A draw the engine refused (RB5-D4, RB5-D10): stored on the draft beside the fold's seats, so the source's Standings and the
 *  draft still read, the stage card says why in a red band (R24 pick 18 A) and the confirm refuses it by name. */
export interface CrossPoolRefused {
  code: "SEEDING_POOL_SEPARATION_IMPOSSIBLE" | "SEEDING_PAGE_PLAYOFF_NEEDS_FOUR";
  vars: Record<string, string | number>;
}

/** The cross-pool draw over the resolver's qualifiers, or null when the stage is not drawn across pools. Each returned qualifier
 *  carries its NEW seed (its place in the draw's order); `seed` is the draw seed used, for the proposal to store. A refused draw
 *  (no ordering separates the pools; a page playoff not of four) keeps the fold's seats and names the refusal (`refused`). */
export async function drawAcrossPools<Q extends CrossPoolEntry & { seed: number }>(
  tx: Tx,
  stage: { id: string; kind: string },
  progression: ProgressionSpec,
  qualifiers: readonly Q[],
  tables: readonly SourceTables[],
  /** `seed`: the draw seed to use - a confirm re-drawing a draft's picked slate passes the draft's own (D-B2-1); else the stage's
   *  stored seed (`storedCrossPoolSeed`). */
  opts: { seed?: number; draw?: typeof crossPoolDraw } = {},
): Promise<{ qualifiers: Q[]; seed: number; refused?: CrossPoolRefused } | null> {
  const draw = opts.draw ?? crossPoolDraw;
  const shape = CROSS_POOL_SHAPES[stage.kind];
  if (shape === undefined || progression.placement !== "rank_order" || organiserPlaced(progression)) return null;
  const ordered = [...qualifiers].sort((a, b) => a.seed - b.seed);
  const seeded = pooledSeeds(ordered, tables);
  if (seeded === null) return null;
  const seed = opts.seed ?? (await storedCrossPoolSeed(tx, stage.id));
  let order: string[];
  try {
    order = draw(seeded, shape, seed).order;
  } catch (e) {
    const named = crossPoolRefusal(e);
    if (named?.code === "SEEDING_POOL_SEPARATION_IMPOSSIBLE" || named?.code === "SEEDING_PAGE_PLAYOFF_NEEDS_FOUR") {
      return { qualifiers: [...qualifiers], seed, refused: { code: named.code, vars: named.extra as Record<string, string | number> } };
    }
    throw named ?? e;
  }
  const seatOf = new Map(order.map((id, i) => [id, i + 1] as const));
  // The draw permutes the field it was handed: every qualifier keeps a seat, and the seats are 1..n.
  if (seatOf.size !== ordered.length || ordered.some((q) => !seatOf.has(q.entrantId))) {
    throw new Error(`cross-pool draw for stage ${stage.id} did not return the field it was handed`);
  }
  return { qualifiers: qualifiers.map((q) => ({ ...q, seed: seatOf.get(q.entrantId)! })), seed };
}

/** A `picks` take is the organiser's own list of seats in order (doc 05 §2.3's "A1 v B2" template): like a `seeded_map`, every seat
 *  is placed, so it is never drawn - the engine would refuse its listed order anyway when a tier goes down (`tiers_out_of_order`). */
function organiserPlaced(progression: ProgressionSpec): boolean {
  return progression.sources.some((s) => s.take.some((t) => t.kind === "picks"));
}

/** K22: the engine's cross-pool refusals as named 422s (copy in errors.json `seeding.*`). Null for anything else. */
export function crossPoolRefusal(e: unknown): HttpError | null {
  if (!(e instanceof EngineError) || e.code !== "CONFIG_INVALID") return null;
  const data = (e.data ?? {}) as { reason?: unknown; supplies?: unknown; entrants?: unknown; shape?: unknown; entrantId?: unknown };
  if (data.reason === "pool_separation_impossible") {
    const supplies = Object.entries((data.supplies ?? {}) as Record<string, number>).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
    const [pool, count] = supplies[0] ?? ["", 0];
    return new HttpError(422, e.message, "SEEDING_POOL_SEPARATION_IMPOSSIBLE", { pool, count, entrants: Number(data.entrants), shape: String(data.shape) });
  }
  if (data.reason === "page_playoff_needs_four") {
    return new HttpError(422, e.message, "SEEDING_PAGE_PLAYOFF_NEEDS_FOUR", { entrants: Number(data.entrants) });
  }
  if (typeof data.reason === "string" && CROSS_POOL_INPUT_REASONS.has(data.reason)) {
    return new HttpError(422, e.message, "SEEDING_CROSS_POOL_DRAW_INVALID", { reason: data.reason, ...(typeof data.entrantId === "string" ? { entrantId: data.entrantId } : {}) });
  }
  return null;
}

/** The draw's own input refusals (`crossPoolDraw`): the app builds that input, so each is a wiring fault, named rather than raw. */
const CROSS_POOL_INPUT_REASONS: ReadonlySet<string> = new Set(["tier_invalid", "duplicate_entrant", "tiers_out_of_order", "tie_link_invalid", "draw_seed_invalid", "no_qualifiers"]);

/** F11 (Review Focus 4): a draft made before engine 10 that must be re-proposed rather than confirmed - its source has UNEQUAL
 *  pools AND a best-Nth seat carries no `basis` (a 9.x draft compared unequal pools by a rule ruling 286 replaced). Any other
 *  draft - a top-two-per-pool one included, which has no best-Nth seat at all - confirms as drafted. */
export function preBumpBestNthDraft(
  progression: ProgressionSpec,
  sourceIds: readonly string[],
  tables: readonly SourceTables[],
  qualifiers: readonly { source: { stageId: string; group?: string }; pool?: string; basis?: unknown }[],
): boolean {
  return progression.sources.some((src, i) => {
    if (!src.take.some((t) => t.kind === "bestNth")) return false;
    const sizes = new Set((tables[i]?.pools ?? []).map((p) => p.rows.length));
    if (sizes.size < 2) return false;
    return qualifiers.some((q) => q.source.stageId === sourceIds[i] && q.source.group === undefined && q.pool === undefined && q.basis === undefined);
  });
}
