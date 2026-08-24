// The legal slot lattice a BUILD searches over (design §Architecture).
//
// This is the whole reason the build solver reaches 200 fixtures where the
// repair solver stalls at 80: the repair encoding gives every fixture an
// integer start and pays O(n²) arithmetic to keep them apart, while this one
// pre-computes the finite set of legal (court, start) pairs and lets the SAT
// core do cardinality reasoning over booleans.
//
// Everything removed here is a constraint the encoder then never has to state.
import {
  intervalsOverlap,
  type Assignment,
  type Blackout,
  type SlotConfig,
} from "./calendar.ts";
import { usableWindows, type Window } from "./court-windows.ts";
import { gridStepMinutes } from "./grid-step.ts";
import { calendarDaysCovering, repairCourts, repairUniverse } from "./repair-domain.ts";
import { dayKeyInTz } from "./tz.ts";

const MS_PER_MIN = 60_000;

/** The lattice size past which the boolean model stops being the right tool.
 *  A season-length window over four courts at a five-minute step is >100k
 *  slots; the encoder would spend the whole budget building clauses it never
 *  gets to solve. Over the cap, `build.ts` goes straight to LNS. */
export const MAX_SLOTS = 20_000;

export interface BuildSlot {
  court: string;
  startAt: number;
}

export interface BuildGrid {
  /** Sorted by (court, startAt) — the order is part of the determinism
   *  contract, because slot INDEX is what the encoder names its variables by. */
  slots: readonly BuildSlot[];
  byCourt: ReadonlyMap<string, readonly number[]>;
  stepMinutes: number;
  /** True when the lattice would exceed `MAX_SLOTS`. `slots` is then empty:
   *  a truncated lattice is worse than none, because the encoder cannot tell a
   *  missing slot from an illegal one and would report a spurious infeasible. */
  overCap: boolean;
}

export interface BuildGridInput {
  config: SlotConfig & { courts: string[] };
  existing?: readonly Assignment[];
  /** Locked cards' exact placements. Admitted even when off-grid, so `k = 0`
   *  is representable and a pinned card never forces an infeasible. */
  pinned?: readonly BuildSlot[];
  /**
   * THE INCUMBENT'S OWN PLACEMENTS — the board the caller already holds and is
   * asking the solver to beat.
   *
   * Greedy chains a participant's next start on `lastEnd + rest`, so a rest that
   * is not a multiple of the step parks the seed BETWEEN two slots and the
   * solver cannot express the very board it was handed (`build.ts` §2). Adding
   * those placements to the lattice fixes that at O(n) extra slots. Refining the
   * STEP until it divides every rest fixes it too and costs ~8x the lattice
   * EVERYWHERE — measured, a 4x product regression plus an uncatchable WASM OOM
   * above ~160 fixtures. See `build.ts`'s `seedPinsOf`.
   *
   * Unlike `pinned` these are admitted only where `admits` passes. A seed pin
   * bypasses ALIGNMENT, never LEGALITY: a locked card the organiser dropped into
   * a blackout has to stay representable, but handing the solver an inadmissible
   * slot merely because greedy touched it would let some OTHER fixture be placed
   * there.
   */
  seedPins?: readonly BuildSlot[];
}

// The lattice step lives in `./grid-step.ts` — it is imported here, never
// recomputed, because the board's time axis has to be the SAME function and a
// second copy is how the two drifted apart in the first place. Its doc comment
// carries the "why the gcd, and why it does not fold rest" reasoning.

export function buildGrid(input: BuildGridInput): BuildGrid {
  const { config } = input;
  const existing = input.existing ?? [];
  const pinned = input.pinned ?? [];
  const seedPins = input.seedPins ?? [];
  const stepMinutes = gridStepMinutes(config.matchMinutes, config.gapMinutes);
  const stepMs = stepMinutes * MS_PER_MIN;
  const durMs = config.matchMinutes * MS_PER_MIN;
  const gapMs = config.gapMinutes * MS_PER_MIN;

  const courts = repairCourts({ proposal: [], existing, config });
  const universe = repairUniverse({ proposal: [], existing, config });

  // Day anchors. Stepping from `universe.from` alone stays aligned in UTC and
  // DRIFTS in wall clock across a DST boundary — a 10:00 lattice becomes an
  // 09:00 one. Anchoring each day at its own local midnight is what keeps a
  // start on a whole local hour on both sides of the transition.
  //
  // With no `tz` there is no local midnight to anchor to, so the whole universe
  // is one bucket. That matches the verifier, which SKIPS day-shaped rules
  // rather than bucketing them in UTC.
  const buckets =
    config.tz !== undefined
      ? calendarDaysCovering(universe, config.tz)
      : [{ ymd: "", from: universe.from, to: universe.to }];

  const sessions = config.sessionWindows ?? [];
  const blackouts: readonly Blackout[] = config.blackouts ?? [];

  // Per-court availability from P8's calendar editor (V367), resolved ONCE for
  // the whole universe through the shared `usableWindows` — the same function
  // `validateAssignments` calls, so the lattice and the verifier cannot answer
  // this question differently. A court with no calendar is absent from this map
  // and stays unrestricted; calendars strictly SUBTRACT.
  //
  // Skipped entirely without `tz`, exactly as the typed rules are: court hours
  // are day-shaped and there is no local midnight to resolve a weekday against.
  const courtWindows = new Map<string, readonly Window[]>();
  if (config.tz !== undefined && (config.courtCalendars ?? []).length > 0) {
    const range = {
      from: dayKeyInTz(universe.from, config.tz),
      to: dayKeyInTz(universe.to, config.tz),
    };
    for (const calendar of config.courtCalendars ?? []) {
      courtWindows.set(
        calendar.courtId,
        // No blackouts passed: `admits` below already rejects any slot
        // overlapping one, so subtracting them here too is duplicated work for
        // an identical decision — and on the VERIFIER side the same
        // pass-through produced a second, wrongly-blamed conflict. One cause,
        // one place, on all three sides.
        usableWindows(calendar, range, { tz: config.tz }),
      );
    }
  }

  const slots: BuildSlot[] = [];
  const seen = new Set<string>();
  let overCap = false;

  const admits = (court: string, start: number): boolean => {
    const end = start + durMs;
    const open = courtWindows.get(court);
    // A court WITH a calendar must have the whole match fit inside one of its
    // usable windows — the "fits the window" test, not "starts in it" (edge
    // matrix row 7). An empty array means the court is closed for every day in
    // range, which correctly removes it from the lattice (row 2).
    if (open !== undefined && !open.some((w) => start >= w.from && end <= w.to)) return false;
    if (sessions.length > 0 && !sessions.some((w) => start >= w.from && end <= w.to)) return false;
    for (const b of blackouts) {
      if (b.court !== undefined && b.court !== court) continue;
      if (intervalsOverlap(start, end, b.from, b.to)) return false;
    }
    for (const a of existing) {
      if (a.court !== court) continue;
      // The same half-open, gap-padded test `slotFixtures` uses, so the
      // lattice and the placer agree about what "free court time" is.
      if (intervalsOverlap(start, end + gapMs, a.startAt, a.endAt + gapMs)) return false;
    }
    return true;
  };

  outer: for (const court of courts) {
    for (const bucket of buckets) {
      const lo = Math.max(bucket.from, universe.from);
      // A bucket bounds the START, never the OCCUPANCY.
      //
      // Anchoring the step at each bucket's own local midnight is what keeps
      // the lattice on the wall clock across a DST boundary, so the day must
      // gate which starts belong to it. But a match that starts before midnight
      // and runs past it is perfectly legal, and ending the loop at `bucket.to`
      // deletes it from the lattice outright — the next bucket cannot recover
      // it, because that bucket opens AT midnight. Occupancy is therefore bound
      // by the universe, the only real limit on where a match may end.
      //
      // `buildDomains` in repair-domain.ts draws the same line: its position
      // domain is continuous across the whole universe, and day buckets there
      // restrict day-SCOPED rules only, never raw start admissibility.
      for (let start = lo; start < bucket.to && start + durMs <= universe.to; start += stepMs) {
        if (!admits(court, start)) continue;
        if (slots.length >= MAX_SLOTS) {
          overCap = true;
          break outer;
        }
        slots.push({ court, startAt: start });
        seen.add(`${court}|${start}`);
      }
    }
  }

  if (overCap) {
    return { slots: [], byCourt: new Map(), stepMinutes, overCap: true };
  }

  // Pinned placements are admitted UNCONDITIONALLY — a locked card's own slot
  // must exist even when it is off-grid, outside the session windows, or inside
  // a blackout the organiser added afterwards. Refusing it would report the
  // board infeasible for a card nobody asked to move.
  for (const p of pinned) {
    const key = `${p.court}|${p.startAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ court: p.court, startAt: p.startAt });
  }

  // The incumbent's own placements, admitted THROUGH `admits`. That one word is
  // the whole difference from the loop above: a seed pin exists so the solver
  // can express the board it was handed, and a placement the lattice would
  // refuse anyway — inside a blackout, outside every session window, on top of
  // an existing booking — is not a board anybody wants expressed. Greedy
  // respects all three, so on an ordinary run this filter drops nothing; what it
  // stops is a seed row that survived legalisation for a NON-blocking reason
  // buying some other fixture an illegal slot.
  for (const p of seedPins) {
    const key = `${p.court}|${p.startAt}`;
    if (seen.has(key)) continue;
    if (!admits(p.court, p.startAt)) continue;
    seen.add(key);
    slots.push({ court: p.court, startAt: p.startAt });
  }

  slots.sort((a, b) => (a.court === b.court ? a.startAt - b.startAt : a.court < b.court ? -1 : 1));

  const byCourt = new Map<string, number[]>();
  slots.forEach((s, i) => {
    const rows = byCourt.get(s.court);
    if (rows === undefined) byCourt.set(s.court, [i]);
    else rows.push(i);
  });

  return { slots, byCourt, stepMinutes, overCap: false };
}
