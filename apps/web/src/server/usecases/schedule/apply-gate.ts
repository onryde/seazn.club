import "server-only";
import {
  deltaConflicts,
  isBlockingConflict,
  roundOrderConflicts,
  validateAssignments,
  type Assignment,
  type Conflict,
  type SlotConfig,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import type { FixtureLite, RoundSequenceStages } from "./types";
import { MS_PER_MIN, ms } from "./helpers";
import { peopleOf } from "./board";
import { roundFieldsOf, roundRobinSequenceKey, roundRobinSequenceSiblings } from "./rounds";
import { toAssignment, feedDependencies } from "./engine-inputs";

/**
 * What `applySchedule` judges a set of rows by: the verifier over the board as it stands (`baseline`)
 * and over the board with the rows written (`found`). One body for the write gate and for the auto pass,
 * which must not propose what the gate refuses.
 */
export interface ApplyGateInput {
  /** The rows the apply would write. Each fixture is one of `fixtures`. */
  rows: readonly { fixture_id: string; scheduled_at: string; court_id: string }[];
  /** The division's own fixtures (`divisionFixtures`). */
  fixtures: readonly FixtureLite[];
  matchMinutes: number;
  people: Map<string, string[]>;
  roundRobin: RoundSequenceStages;
  /** Sibling divisions' cards (`siblingAssignments(...).assignments`). */
  siblingBoard: readonly Assignment[];
  config: SlotConfig & VerifyConfig;
}

export function applyGate(input: ApplyGateInput): {
  baseline: Conflict[];
  found: Conflict[];
  /** The round-order siblings: judged, but no row of this apply. */
  siblingIds: Set<string>;
} {
  const { rows, fixtures: all, matchMinutes, people, roundRobin, siblingBoard, config: slotConfig } = input;
  const byId = new Map(all.map((f) => [f.id, f]));
  const proposed: Assignment[] = rows.map((a) => {
    const f = byId.get(a.fixture_id) as FixtureLite;
    const start = ms(a.scheduled_at);
    // A row written back exactly where it already is chooses nothing.
    const unmoved =
      f.scheduled_at !== null && ms(f.scheduled_at) === start && f.court_id === a.court_id;
    return {
      fixtureId: a.fixture_id,
      court: a.court_id,
      startAt: start,
      endAt: start + matchMinutes * MS_PER_MIN,
      entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
      people: peopleOf(f, people),
      // #446: the proposed card's own group identity, so a pool- or
      // division-targeted rule is applied to the placement being judged and
      // not only to the board it lands on. Same shape as `toAssignment`.
      ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
      divisionId: f.division_id,
      // C1 fix-loop (Finding 2): unconditional, same as `divisionId` just
      // above — `divisionFixtures` (below) is DIVISION-WIDE, so `all`, and
      // therefore `proposed`/`currentSlots`/`untouched`, can carry more
      // than one round-sequence stage's fixtures in ONE call. This is
      // the actual WRITE gate (the comment above `roundRobin`'s own
      // assignment explains why it has to be judged HERE), so it is the
      // one place this omission would have mattered most: without it,
      // `calendar.ts`'s grouping key falls back to `(divisionId, poolId)`
      // and two unpooled round-sequence stages compare as one sequence again.
      stageId: f.stage_id,
      // C1 (2026-08-12 round-order design). Same shape as `toAssignment`
      // again — `f.round_no` is the fixture's own round, gated on stage
      // kind exactly as `toAssignment` gates it. `movable`: a position THIS
      // apply is actively choosing, whatever lock state it ends up carrying
      // (`a.schedule_locked` is the state AFTER this write, not a fact
      // about whether this apply itself may act on it). A row that does not
      // move keeps `toAssignment`'s own answer, so two pins that already
      // contradict each other's round order read the same on both sides of
      // the delta — listing them where they are introduces nothing.
      ...roundFieldsOf(roundRobin, f),
      movable: unmoved ? !f.schedule_locked : true,
    };
  });
  const listed = new Set(rows.map((a) => a.fixture_id));
  // C1 fix-loop (G2/3rd instance, re-scoped by the round-order-widening
  // fix-loop below). This apply's own round-robin siblings — same
  // (division, stage, pool) sequence as any LISTED fixture, already placed,
  // not themselves listed. They are needed ONLY so `roundOrderConflicts`
  // (the round-order-only pass below) can pair a listed fixture against an
  // untouched one — its pairwise scan is scoped to the set it is handed,
  // by design. See `roundRobinSequenceSiblings`'s own comment for the full
  // mechanism; this generalizes it to N listed fixtures rather than
  // exactly one (`moveFixture`'s shape below).
  //
  // They deliberately do NOT move into `assignments`/out of `untouched` for
  // the CORE gate below (rest/court/person/window/feed-order) — that was
  // the original, too-blunt fix: pulling a sibling out of `existing` made
  // it FOCAL for every rule family the gate checks, not just round order,
  // silently changing what rest/court/person judged a pre-existing board
  // against. Those families see the siblings exactly as they always did —
  // as fixed CONTEXT via `board`/`existing` below — so their verdicts stay
  // byte-identical to the pre-round-order gate.
  const widenKeys = new Set(
    rows
      .map((a) => byId.get(a.fixture_id) as FixtureLite)
      .filter((f) => roundRobin.has(f.stage_id))
      .map(roundRobinSequenceKey),
  );
  const roundRobinSiblings = roundRobinSequenceSiblings(all, widenKeys, listed);
  const siblingIds = new Set(roundRobinSiblings.map((f) => f.id));
  // ORIGINAL composition — `siblingIds` stays IN here, matching every rule
  // family's pre-round-order behaviour (and origin/main's, byte for byte).
  const untouched = all
    .filter((f) => !listed.has(f.id) && f.scheduled_at !== null && f.court_id !== null)
    .map((f) => toAssignment(f, matchMinutes, people, roundRobin));
  // Round-order-only checked set: the siblings, same representation as
  // `untouched`'s rows, added to BOTH delta sides below so a pre-existing
  // round-order violation among them reads as pre-existing rather than
  // newly introduced by a move that never touched them.
  const widenedSiblings = roundRobinSiblings.map((f) =>
    toAssignment(f, matchMinutes, people, roundRobin),
  );
  const deps = feedDependencies(all);
  const board = [...untouched, ...siblingBoard];
  // The SAME fixtures where they sit right now (#399). Anything the verifier
  // already says about this board is history, not this apply's doing — an
  // organiser whose board carries a pre-existing person overlap must still be
  // able to edit it, which is the only way they can ever fix it.
  // A fixture with no slot yet contributes nothing, so every conflict its
  // placement causes reads as introduced. Correct: it is.
  const currentSlots = rows
    .map((a) => byId.get(a.fixture_id) as FixtureLite)
    .filter((f) => f.scheduled_at !== null && f.court_id !== null)
    .map((f) => toAssignment(f, matchMinutes, people, roundRobin));
  // CORE families (window/start_window/court/blackout/rest/person_overlap/
  // instruction rules/feed-order): `includeRoundOrder=false` — this call is
  // byte-identical in shape to the pre-round-order gate, so its verdict is
  // too. Round order is judged SEPARATELY, immediately below, over the
  // widened set — merging only its `"order"` conflicts back in keeps every
  // other family blind to the siblings, exactly as it always was.
  const baseline = [
    ...validateAssignments(currentSlots, slotConfig, board, deps, false),
    ...roundOrderConflicts(currentSlots.concat(widenedSiblings), slotConfig.tz),
  ];
  const found = [
    ...validateAssignments(proposed, slotConfig, board, deps, false),
    ...roundOrderConflicts(proposed.concat(widenedSiblings), slotConfig.tz),
  ];
  return { baseline, found, siblingIds };
}

/** What the write gate would refuse about `rows`: the blocking conflicts the delta says they introduce. */
export function applyRefusals(input: ApplyGateInput): Conflict[] {
  const { baseline, found } = applyGate(input);
  return deltaConflicts(baseline, found).filter(isBlockingConflict);
}
