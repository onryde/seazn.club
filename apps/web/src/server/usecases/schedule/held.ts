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
 * `input` with the rows from before `floor` made safe to send. The service takes every `existing` row as a
 * FIXED interval, on its court (the match and the gap) and for each of its entrants (the match and the
 * longest rest of its groups), under a no-overlap constraint — so two rows that collide with EACH OTHER make
 * the whole model INFEASIBLE, and the engine reads that as contradictory pins. Held rows are history and
 * collide readily: a double booking, results typed in a rest too close, a match length raised after the day
 * was played. They collide with each other and with rows this pass did not hold.
 *
 * Nothing is placed before `floor`, so all a row from before it can still do is keep a court or a player
 * busy past `floor`, and order days and rounds. The last two survive a move: the day travels apart from the
 * start (`dayIndex`), and any start before `floor` orders the rounds the same. So a row that has to give way
 * is PARKED, at an instant of its own earlier than every row, where it can collide with nothing. What is
 * busy from `floor` on is exactly what it was:
 *   - COURT: of the rows from before `floor`, the one that started last is busy longest. It keeps its place
 *     (brought forward only so far as to end where a row not yet started begins) and any it covers are parked.
 *   - PLAYER: someone still busy past `floor` is held by ONE interval to the moment they are free, counting
 *     the rows ahead that start inside it. It is the row in place that ends then; where there is none, a row
 *     is added for it, parked, with a rest of its own long enough to reach.
 *
 * A held row with nothing owed past `floor` is parked. Rows from `floor` on keep their place, and `input` is
 * returned as it came when no held row is on it.
 */
export function spareHeldRows(input: SolveBuildInput, heldIds: ReadonlySet<string>, floor: number): SolveBuildInput {
  if (!input.existing.some((r) => heldIds.has(r.fixtureId))) return input;
  const match = input.constraints.matchMinutes * MS_PER_MIN;
  const width = match + input.constraints.gapMinutes * MS_PER_MIN;
  const roundGap = Math.max(0, ...input.fixtures.map((f) => f.roundGapMinutes ?? 0)) * MS_PER_MIN;
  const restOf = (row: WireRow): number =>
    Math.max(0, ...(row.ruleGroupIndices ?? []).map((i) => input.ruleGroups?.[i]?.minRestMinutes ?? 0)) *
    MS_PER_MIN;
  /** How long a player of this row is busy from its start, as the service counts it. */
  const freeAt = (row: WireRow): number => row.startAtMs + match + restOf(row);

  // Wide enough that two rows one pitch apart can share neither a court nor a resting entrant.
  const pitch = Math.max(width, match + Math.max(roundGap, ...input.existing.map(restOf)));
  // Below every row as it came, and below any brought forward (never further than `floor - width`).
  let parkedAt = Math.min(floor - width, ...input.existing.map((r) => r.startAtMs));
  const park = (): number => (parkedAt -= pitch);

  // Latest start first: the first row met on a court is the one that is busy on it longest.
  const past = input.existing
    .filter((r) => r.startAtMs < floor)
    .sort((a, b) => b.startAtMs - a.startAtMs || a.fixtureId.localeCompare(b.fixtureId));
  const ahead = input.existing.filter((r) => r.startAtMs >= floor).sort((a, b) => a.startAtMs - b.startAtMs);

  const startOf = new Map<WireRow, number>();
  const standing: { court: string; at: number }[] = [];
  for (const row of past) {
    const owed = Math.max(width, match + Math.max(roundGap, restOf(row)));
    if (heldIds.has(row.fixtureId) && row.startAtMs + owed <= floor) {
      startOf.set(row, park());
      continue;
    }
    const clash = (rows: readonly { court: string; at: number }[], at: number) =>
      rows.find((o) => o.court === row.court && overlaps(o.at, o.at + width, at, at + width));
    const starting = ahead.map((r) => ({ court: r.court, at: r.startAtMs }));
    let at = row.startAtMs;
    // `ahead` is in start order, so the first clash is the earliest row this one runs into.
    for (let next = clash(starting, at); next !== undefined; next = clash(starting, at)) at = next.at - width;
    if (clash(standing, at) !== undefined) {
      startOf.set(row, park());
      continue;
    }
    standing.push({ court: row.court, at });
    startOf.set(row, at);
  }

  const dropped = new Map<WireRow, Set<string>>();
  const drop = (row: WireRow, player: string) =>
    (dropped.get(row) ?? dropped.set(row, new Set()).get(row)!).add(player);
  const added: WireRow[] = [];
  const ruleGroups = [...(input.ruleGroups ?? [])];
  for (const player of new Set(past.flatMap((r) => r.entrantIds ?? []))) {
    const has = (r: WireRow) => (r.entrantIds ?? []).includes(player);
    const theirs = past.filter(has).sort((a, b) => freeAt(b) - freeAt(a));
    const inPlace = (r: WireRow) => startOf.get(r) === r.startAtMs;
    let busyUntil = freeAt(theirs[0]!);
    if (busyUntil <= floor) {
      // Nothing owed past the floor: two rows left in place may still overlap, and one of them gives way.
      const spans: WireRow[] = [];
      for (const r of theirs.filter(inPlace)) {
        if (spans.some((o) => overlaps(o.startAtMs, freeAt(o), r.startAtMs, freeAt(r)))) drop(r, player);
        else spans.push(r);
      }
      continue;
    }
    for (const r of ahead.filter(has)) {
      if (r.startAtMs >= busyUntil) break;
      busyUntil = Math.max(busyUntil, freeAt(r));
      drop(r, player);
    }
    const holder = theirs.find((r) => inPlace(r) && freeAt(r) === busyUntil);
    for (const r of theirs) if (r !== holder) drop(r, player);
    if (holder !== undefined) continue;
    const source = theirs[0]!;
    const at = park();
    // The rest group names no fixture: it only gives this one row its length.
    added.push({
      fixtureId: `${source.fixtureId}:rest:${player}`,
      court: source.court,
      startAtMs: at,
      entrantIds: [player],
      ruleGroupIndices: [ruleGroups.length],
    });
    ruleGroups.push({ fixtureIds: [], minRestMinutes: Math.ceil((busyUntil - at - match) / MS_PER_MIN) });
  }

  const existing = input.existing.map((row) => {
    const startAtMs = startOf.get(row) ?? row.startAtMs;
    const gone = dropped.get(row);
    if (startAtMs === row.startAtMs && gone === undefined) return row;
    return {
      ...row,
      startAtMs,
      ...(gone !== undefined ? { entrantIds: (row.entrantIds ?? []).filter((e) => !gone.has(e)) } : {}),
    };
  });
  return {
    ...input,
    existing: [...existing, ...added],
    ...(added.length > 0 ? { ruleGroups } : {}),
  };
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
