// run-sheet-groups.ts — the division-wide run sheet's grouping builder.
// Pure, client-safe, no DB, no DOM.
//
// Owner rulings, 2026-09-03 (docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md):
//   A2 — "bracket stages keep their round sections. Every other stage kind is
//         day-grouped."
//   Skeleton — "day groups are MERGED across all non-bracket stages into one
//         division-wide day spine, each bracket stage is its own
//         round-sectioned block, and ONE division-wide 'Not yet scheduled'
//         group closes the sheet."
//   R7 — byes are structural, never schedulable: (a) never enter the
//         unscheduled COUNT, never carry an action, never offered "Set time";
//         (b) a bracket stage keeps its byes as ghost rows inside their round
//         section; (c) a Swiss sit-out is a ghost row in the settled-untimed
//         block (after Pair next it is a real award the organiser must see —
//         "who got the bye?").
//   #850 (owner rulings 2026-09-23, second round) RETIRED the old (c) for
//         league/group — "a plain league/group untimed bye does not appear on
//         the sheet (accepted information loss on a time spine)". A
//         round-robin stage now persists a real rest-bye row per round
//         (`isRestBye`, lib/fixture-bye.ts), and it is the Swiss ghost row
//         "Round N · X has a bye" sitting INSIDE ITS ROUND (and pool): right
//         after the last of that round's matches (same stage, pool and round)
//         in sheet order, in whichever block that match landed — a day block
//         once the round is timed, "Not yet scheduled" while it is not, the
//         settled tail when it was played untimed. Rejected: a pile of byes in
//         the settled block (the first build — "Played, not scheduled" is
//         false for a bye, nothing was played) and a round-header "sits out"
//         note (a second convention for one thing). The ghost row is still
//         never counted and never actionable, so (a) holds wherever it sits.
//         Whether the row carries an outcome suffix is the ROW's question
//         (`isScoringBye`, run-sheet-row.tsx), not this builder's.
//         Review round 2 (R2-5): while its round still has an OPEN match, the
//         bye sits in that match's block, never under "Played, not scheduled".
//   Owner ruling 2026-09-24 (fourth round): only a MARKED rest bye (the
//         generator's key, `isRestBye`) left (c). A fed league's walkover —
//         the same one-sided award shape, `awardSeededByes` — keeps the old
//         (c) and stays off the sheet, exactly as before #850.
//
// The governing clock is the VENUE zone (`scheduleSettings.tz`) for BOTH
// bucketing and printing — amendment 4. Never the org zone: two zones in one
// row is the bug, wherever the seam is drawn (_RULES.md, "One zone per
// fixture").
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import type { FixtureRow } from "@/server/usecases/stages";
import { isRestBye, placeRestByesInRounds } from "@/lib/fixture-bye";

/** The fixture fields this builder (and Task 4's rendering of its rows) reads,
 *  derived from the wire row rather than retyped — a hand-written twin is how
 *  DEFAULT_MATCH_MINUTES drifted. Widened past the grouping-only fields to
 *  cover the entrant-name / result-text / bracket-round-label inputs
 *  (`FixtureLine`'s own derivation, `bracketRoundLabel` in stages-panel.tsx),
 *  so the sheet never needs a second representation of the same rows just to
 *  render a header. Still a `Pick`, so it cannot drift from the wire row. */
export type RunSheetFixture = Pick<
  FixtureRow,
  | "id"
  | "stage_id"
  | "fixture_no"
  | "round_no"
  | "seq_in_round"
  | "scheduled_at"
  | "status"
  | "court_name"
  // `court_id`, added by max-effort review finding 10 / ruling R35. It was
  // ALREADY being read at runtime — `courtDisplayName(fixture, courtNames)`'s
  // venue-qualifying branch keys off it, and only worked because
  // `toRunSheetFixture` spreads the whole wire row, which `tsc` cannot see. Any
  // caller that constructed a `RunSheetFixture` explicitly (the grouping tests
  // already do) silently dropped to the bare, possibly-colliding court name.
  // R35's per-fixture court picker also seeds its selection from it.
  | "court_id"
  | "venue_name"
  | "officials"
  | "outcome"
  | "home_entrant_id"
  | "away_entrant_id"
  | "home_slot_label"
  | "away_slot_label"
  | "lane"
  | "is_final"
  | "third_place"
  | "conditional"
  | "ext_key"
> &
  // #850: the POOL a round-robin rest bye belongs to — a group stage's pools
  // share round numbers, so "inside its round" means inside its pool's round.
  // Optional for the same reason `ext_key` is on the wire row: hand-built test
  // literals predate it. Production rows carry it (`toRunSheetFixture` spreads
  // the whole `FixtureRow`); a missing one reads as "no pool", which is
  // exactly what a league row is.
  Partial<Pick<FixtureRow, "pool_id">>;

export type RunSheetStage = { id: string; seq: number; kind: string };

export type RunSheetInput = {
  fixtures: RunSheetFixture[];
  stages: RunSheetStage[];
  /** The VENUE zone. Amendment 4. */
  tz: string;
  nowMs: number;
};

export type RunSheetDayBlock = {
  kind: "day";
  /** "YYYY-MM-DD" in `tz` — the block's identity and its `data-run-sheet-day`. */
  dayKey: string;
  fixtures: RunSheetFixture[];
  /** Index of the first row after `nowMs`; the NOW rule renders before it.
   *  `fixtures.length` means "after every row". `null` means this day is not
   *  today and carries no rule at all. */
  nowIndex: number | null;
};

export type RunSheetBracketBlock = {
  kind: "bracket";
  stageId: string;
  stageSeq: number;
  rounds: { round: number; fixtures: RunSheetFixture[] }[];
};

export type RunSheetUnscheduledBlock = { kind: "unscheduled"; fixtures: RunSheetFixture[] };

/** A settled (decided/finalized/voided) NON-bracket fixture with no recorded
 *  `scheduled_at`. Fix round 1 (controller ruling): the original finding-3
 *  fix dropped these rows entirely — W1's round list kept them
 *  (`f.status !== "scheduled"` was the third clause of its filter) — which
 *  is a real regression, not a scoped omission: an organiser who scores a
 *  whole league without ever timing it loses every result from the tab.
 *  Kept in its OWN terminal block, after "unscheduled", so a played match
 *  never reads as work still to schedule. */
export type RunSheetSettledBlock = { kind: "settled"; fixtures: RunSheetFixture[] };

export type RunSheetBlock =
  | RunSheetDayBlock
  | RunSheetBracketBlock
  | RunSheetUnscheduledBlock
  | RunSheetSettledBlock;

/** Stage kinds that render as a bracket. Single authority — copied verbatim
 *  from `stages-panel.tsx`'s own `BRACKET_KINDS` (Task 4 deletes that copy and
 *  imports this instead), so the sheet and the panel can never disagree about
 *  which stage is a bracket. */
export const BRACKET_STAGE_KINDS = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);

/** A bye: one side empty with an auto-advance award outcome (v3/04 §3 item 6).
 *  Copied verbatim from `stages-panel.tsx`'s module-private `isBye`, typed
 *  against `RunSheetFixture` instead of `FixtureRow` — a lib must not import
 *  from a component. Task 4 deletes that copy and imports this instead. */
export function isBye(f: RunSheetFixture): boolean {
  const o = f.outcome as { kind?: string } | null;
  return o?.kind === "award" && (f.home_entrant_id === null || f.away_entrant_id === null);
}

/** A settled fixture with no time is a RESULT, not open scheduling work —
 *  finding 3 ("'Unscheduled' on a decided match is noise"). */
const OPEN = new Set(["scheduled", "in_play"]);

export function buildRunSheet(input: RunSheetInput): RunSheetBlock[] {
  const { fixtures, stages, tz, nowMs } = input;

  // THE EMPTY CASE, FIRST — but unlike a "does the set contain X" ladder
  // (_RULES.md's vacuous-truth rule), this is NOT a correctness backstop.
  // `buildRunSheet` is a PARTITION: the loop below buckets every row into a
  // pile, and everything after it is a map/filter/sort over those piles —
  // empty-safe by construction, so an empty `fixtures` array would already
  // fall through to `blocks = []` with this line deleted. It stays as a fast
  // exit that also skips building `seqOf`/`bracketStageIds` for zero rows,
  // and keeps the page's own empty state simple (spec, "Error and empty
  // states": the stage rail alone, no run sheet header at all).
  if (fixtures.length === 0) return [];

  const seqOf = new Map(stages.map((s) => [s.id, s.seq]));
  const kindOf = new Map(stages.map((s) => [s.id, s.kind]));
  const bracketStageIds = new Set(
    stages.filter((s) => BRACKET_STAGE_KINDS.has(s.kind)).map((s) => s.id),
  );
  // Swiss sit-outs must stay visible after Pair (shell programme). Not a
  // bracket — day-grouping unchanged — only bye *visibility* differs from
  // R7(c), which still governs every other non-bracket one-sided award.
  const swissStageIds = new Set(stages.filter((s) => s.kind === "swiss").map((s) => s.id));
  const rank = (f: RunSheetFixture) =>
    [seqOf.get(f.stage_id) ?? Number.MAX_SAFE_INTEGER, f.round_no, f.seq_in_round] as const;
  const byRank = (a: RunSheetFixture, b: RunSheetFixture) => {
    const [as, ar, aq] = rank(a);
    const [bs, br, bq] = rank(b);
    return as - bs || ar - br || aq - bq;
  };

  const unscheduled: RunSheetFixture[] = [];
  const settledUntimed: RunSheetFixture[] = [];
  const dayed: RunSheetFixture[] = [];
  const bracketed = new Map<string, RunSheetFixture[]>();
  // #850: round-robin rest byes, held back until every MATCH has found its
  // block — a rest bye has no place of its own, it goes where its round is.
  const restByes: RunSheetFixture[] = [];

  for (const f of fixtures) {
    // R7: byes are structural — never schedulable, never actionable. Checked
    // FIRST, before the scheduled_at test, or an untimed bye reaches the
    // unscheduled pile and is offered a "Set time" for a match nobody plays.
    if (isBye(f)) {
      // (b) a bracket stage keeps its byes as ghost rows in their round.
      // #850: a round-robin rest bye waits for its round (placed below).
      // (c) a Swiss sit-out is a ghost row in settled-untimed, round-ordered
      // by the shared `byRank` sort below.
      // Any other one-sided award leaves the sheet, exactly as before #850 —
      // notably a fed league's WALKOVER (`awardSeededByes`: a qualifier left
      // before the draw), which has a rest bye's shape but not its marker
      // and keeps its pre-#850 display (owner ruling 2026-09-24, fourth round).
      if (bracketStageIds.has(f.stage_id)) {
        const list = bracketed.get(f.stage_id) ?? [];
        list.push(f);
        bracketed.set(f.stage_id, list);
      } else if (isRestBye(f, kindOf.get(f.stage_id) ?? "")) {
        restByes.push(f);
      } else if (swissStageIds.has(f.stage_id)) {
        settledUntimed.push(f);
      }
      continue;
    }
    if (f.scheduled_at === null) {
      // F2 (W2 walkthrough gate 1): bracket membership is decided BEFORE the
      // OPEN-status routing below. An untimed round is entirely normal for a
      // bracket stage — nothing in this product requires slotting a knockout
      // round onto a court before it can be played — whether that round is
      // still OPEN (scheduled/in_play, not yet timed) or already decided
      // without ever being timed. Checking `OPEN.has(f.status)` first sent an
      // untimed-but-open bracket fixture to the unscheduled pile like any
      // other stage's row, which truncated the round's own fixture list and
      // shifted every downstream round header (`bracketRoundLabel`'s
      // `lastRoundInLane`) up by one.
      if (bracketStageIds.has(f.stage_id)) {
        const list = bracketed.get(f.stage_id) ?? [];
        list.push(f);
        bracketed.set(f.stage_id, list);
      } else if (OPEN.has(f.status)) {
        // Only OPEN work belongs in the unscheduled pile. A decided match with
        // no recorded time is a result, not open scheduling work — finding 3.
        unscheduled.push(f);
      } else {
        // Fix round 1 (controller ruling): a NON-bracket stage has no day to
        // bucket an untimed row into, but dropping it OUTRIGHT is the
        // regression finding-3 itself was meant to fix, one level up — W1's
        // round list kept these rows (its filter's third clause was
        // `f.status !== "scheduled"`), so a fully-played, never-timed league
        // used to show every result and W2 showed nothing at all. Kept here
        // in its own terminal pile instead, rendered as a block AFTER
        // "unscheduled" so a played match never reads as work still to do.
        settledUntimed.push(f);
      }
      continue;
    }
    if (bracketStageIds.has(f.stage_id)) {
      const list = bracketed.get(f.stage_id) ?? [];
      list.push(f);
      bracketed.set(f.stage_id, list);
      continue;
    }
    dayed.push(f);
  }

  const today = dayKeyInTz(nowMs, tz);
  const blocks: { at: number; seq: number; block: RunSheetBlock }[] = [];

  // Day blocks — merged across every non-bracket stage (owner ruling 3).
  const byDay = new Map<string, RunSheetFixture[]>();
  for (const f of dayed) {
    const key = dayKeyInTz(Date.parse(f.scheduled_at as string), tz);
    const list = byDay.get(key) ?? [];
    list.push(f);
    byDay.set(key, list);
  }
  for (const [dayKey, rows] of byDay) {
    rows.sort((a, b) => {
      const at = Date.parse(a.scheduled_at as string) - Date.parse(b.scheduled_at as string);
      return at !== 0 ? at : byRank(a, b);
    });
    // `nowIndex` is filled in once the rest byes have joined their rounds
    // (below) — an inserted row moves every index after it.
    blocks.push({
      at: Date.parse(rows[0].scheduled_at as string),
      seq: Number.MAX_SAFE_INTEGER,
      block: { kind: "day", dayKey, fixtures: rows, nowIndex: null },
    });
  }

  // Bracket blocks — one per stage, rounds in round order (owner ruling A2).
  for (const [stageId, rows] of bracketed) {
    rows.sort(byRank);
    const rounds: RunSheetBracketBlock["rounds"] = [];
    for (const f of rows) {
      const last = rounds[rounds.length - 1];
      if (last && last.round === f.round_no) last.fixtures.push(f);
      else rounds.push({ round: f.round_no, fixtures: [f] });
    }
    rounds.sort((a, b) => a.round - b.round);
    // A bracket block can now hold untimed byes, so `Math.min` over every row
    // would be NaN and poison the block sort. Take the earliest of the TIMED
    // rows only; a block with no timed row at all sorts last among blocks (but
    // still above the unscheduled group, which is appended after the sort).
    const times = rows
      .filter((f) => f.scheduled_at !== null)
      .map((f) => Date.parse(f.scheduled_at as string));
    const earliest = times.length > 0 ? Math.min(...times) : Number.MAX_SAFE_INTEGER;
    blocks.push({
      at: earliest,
      seq: seqOf.get(stageId) ?? Number.MAX_SAFE_INTEGER,
      block: { kind: "bracket", stageId, stageSeq: seqOf.get(stageId) ?? 0, rounds },
    });
  }

  // Chronological, with stage seq as the tie-break so two bracket blocks that
  // start at the same instant still read in stage order. This plan's decision,
  // not an owner ruling — see the plan's "Decisions taken by this plan".
  blocks.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const out: RunSheetBlock[] = blocks.map((b) => b.block);

  // The unscheduled group is ALWAYS last, whatever its stage seq — and the
  // settled-untimed tail is last of all, so a played match never sits above
  // (and never reads as) work still to schedule.
  if (unscheduled.length > 0) {
    unscheduled.sort(byRank);
    out.push({ kind: "unscheduled", fixtures: unscheduled });
  }
  settledUntimed.sort(byRank);
  const settledBlock: RunSheetSettledBlock = { kind: "settled", fixtures: settledUntimed };
  out.push(settledBlock);

  // #850 — every rest bye joins ITS ROUND: right after the last of its round's
  // matches (same stage, pool and round) in SHEET order, in whichever block
  // that match landed. "Last", not first, so a round split across two days
  // closes with its bye on the day the round finishes. Review round 2, R2-5:
  // but never in a different block from a match of its round that is still
  // OPEN — while one is, the bye goes to the block of the round's last open
  // match (so a partly played untimed round keeps its bye under "Not yet
  // scheduled" with the match still waiting, not under "Played, not
  // scheduled"). A bye with no round-mate on the sheet at all (every match of
  // the round deleted by hand) has nowhere to sit inside, and falls back to
  // the settled tail — never the unscheduled pile on its own, and never
  // dropped.
  const flat = out.flatMap((b) => (b.kind === "bracket" ? [] : [b.fixtures]));
  const orphans = placeRestByesInRounds(flat, [...restByes].sort(byRank), (f) => !isBye(f), {
    open: (f) => OPEN.has(f.status),
  });
  if (orphans.length > 0) {
    settledUntimed.push(...orphans);
    settledUntimed.sort(byRank);
  }

  // The NOW rule exists ONLY on today's block. `findIndex` returning -1 means
  // every row is at or before now, so the rule goes after the last one. An
  // untimed row (a rest bye) is never "after now" — it rides with its round.
  for (const b of out) {
    if (b.kind !== "day" || b.dayKey !== today) continue;
    const first = b.fixtures.findIndex((f) => f.scheduled_at !== null && Date.parse(f.scheduled_at) > nowMs);
    b.nowIndex = first === -1 ? b.fixtures.length : first;
  }
  return settledUntimed.length > 0 ? out : out.filter((b) => b !== settledBlock);
}
