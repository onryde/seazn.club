/**
 * HELD cards: the ones an auto pass has to leave where they are because they start before its start
 * floor (`autoStartFloor`) — a pin, and in POLISH any placed card. `autoSchedule` takes them out of the
 * fixtures it hands the engine and puts them on the obstacle board. This module is what that leaves to do
 * around the engine: keep the solver's request solvable, hold the round order the engine does not hold
 * against an obstacle, and answer for a board that is held entirely.
 */
import {
  isBlockingConflict,
  roundOrderConflicts,
  RULE_BY_REASON,
  type Assignment,
  type Conflict,
  type PlacementSolver,
  type SolveBuildInput,
} from "@seazn/engine/scheduling";

const MS_PER_MIN = 60_000;

type WireRow = SolveBuildInput["existing"][number];

const overlaps = (a: number, aEnd: number, b: number, bEnd: number): boolean => a < bEnd && b < aEnd;

/**
 * `input` with the held rows made safe to send. The service takes every `existing` row as a FIXED
 * interval, on its court and for each of its entrants, under a no-overlap constraint — so two rows that
 * collide with EACH OTHER make the whole model INFEASIBLE, and the engine reads that as contradictory
 * pins. Held rows are history and collide readily: a double booking, results typed in a rest too close,
 * a match length raised after the day was played.
 *
 * Nothing is placed before `floor`, so what a held row can still do to a placement is limited:
 *   - SPENT (its match, plus the longest it can make anything wait, is over by `floor`): only its day
 *     and its round still count. The day travels apart from the start (`dayIndex`), and any start before
 *     `floor` orders the rounds the same. So it is moved to an instant of its own, earlier than every
 *     row, where it can collide with nothing.
 *   - STILL RUNNING: every one of them started before `floor`, so on one court the one that ends last
 *     covers all the others from `floor` on. It keeps its place and the others move; an entrant is kept
 *     on the one row that holds them longest.
 *
 * Rows that are not held are returned as they came, and so is `input` when nothing is held.
 */
export function spareHeldRows(input: SolveBuildInput, heldIds: ReadonlySet<string>, floor: number): SolveBuildInput {
  const held = input.existing.filter((r) => heldIds.has(r.fixtureId));
  if (held.length === 0) return input;
  const match = input.constraints.matchMinutes * MS_PER_MIN;
  const gap = input.constraints.gapMinutes * MS_PER_MIN;
  const roundGap = Math.max(0, ...input.fixtures.map((f) => f.roundGapMinutes ?? 0)) * MS_PER_MIN;
  const restOf = (row: WireRow): number =>
    Math.max(0, ...(row.ruleGroupIndices ?? []).map((i) => input.ruleGroups?.[i]?.minRestMinutes ?? 0)) *
    MS_PER_MIN;
  /** When the row stops holding anything back: the court, a player's rest, or the next round. */
  const over = (row: WireRow): number => row.startAtMs + match + Math.max(gap, roundGap, restOf(row));

  // Wide enough that two rows one pitch apart can share neither a court nor a resting entrant.
  const pitch = match + Math.max(gap, roundGap, ...held.map(restOf));
  let parked = Math.min(floor, ...input.existing.map((r) => r.startAtMs));
  const kept: WireRow[] = [];
  const rewritten = new Map<WireRow, WireRow>();
  const others = input.existing.filter((r) => !heldIds.has(r.fixtureId));
  // Longest-reaching first, so the row that stays is the one that covers the rest.
  for (const row of [...held].sort((a, b) => over(b) - over(a) || a.fixtureId.localeCompare(b.fixtureId))) {
    const courtCovered = kept.some(
      (k) => k.court === row.court && overlaps(k.startAtMs, k.startAtMs + match + gap, row.startAtMs, row.startAtMs + match + gap),
    );
    if (over(row) <= floor || courtCovered) {
      parked -= pitch;
      rewritten.set(row, { ...row, startAtMs: parked });
      continue;
    }
    const resting = new Set(
      [...kept, ...others]
        .filter((k) =>
          overlaps(k.startAtMs, k.startAtMs + match + restOf(k), row.startAtMs, row.startAtMs + match + restOf(row)),
        )
        .flatMap((k) => k.entrantIds ?? []),
    );
    const trimmed = { ...row, entrantIds: (row.entrantIds ?? []).filter((e) => !resting.has(e)) };
    kept.push(trimmed);
    rewritten.set(row, trimmed);
  }
  return { ...input, existing: input.existing.map((r) => rewritten.get(r) ?? r) };
}

/** {@link spareHeldRows} as a solver port. Nothing is awaited ahead of the call (R17). */
export function sparingHeldRows(solve: PlacementSolver, heldIds: ReadonlySet<string>, floor: number): PlacementSolver {
  return (input, ctx) => solve(spareHeldRows(input, heldIds, floor), ctx);
}

/**
 * The refusal for a card that would put its round out of order with a held card, or `undefined`. The
 * engine bounds a placement by a later round among the obstacles only for Swiss (the end barrier), so a
 * league's or a group's order against a held card is unknown to it.
 *
 * Asked of the engine's own round-order rule, one held card at a time (so a breach between two held cards
 * is never laid on this one), with the held card as the pin it is. The rounds-per-day cap is not an order
 * between two cards, and the engine already counts held rounds into it.
 */
export function roundOrderRefusal(
  card: Assignment,
  held: readonly Assignment[],
  tz: string | undefined,
): Conflict | undefined {
  const other = held.find((h) =>
    roundOrderConflicts(
      [
        { ...h, movable: false },
        { ...card, movable: true },
      ],
      tz,
    ).some((c) => isBlockingConflict(c) && c.details?.kind !== "rounds_per_day"),
  );
  if (other === undefined) return undefined;
  return {
    fixtureId: card.fixtureId,
    reason: "no_slot",
    rule: RULE_BY_REASON.no_slot,
    details: {
      kind: "no_slot_round_barrier",
      roundNo: card.roundNo,
      otherRoundNo: other.roundNo,
      otherFixtureId: other.fixtureId,
    },
  };
}
