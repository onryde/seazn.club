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
//         unscheduled group and never carry an action; (b) a bracket stage
//         keeps its byes as ghost rows inside their round section; (c) a
//         plain league/group untimed bye does not appear on the sheet
//         (accepted information loss on a time spine). Swiss is the
//         exception to (c): after Pair next the sit-out is a real award the
//         organiser must see ("who got the bye?"), so awarded Swiss byes
//         land in the settled-untimed block as ghost rows — still never
//         schedulable, never actionable.
//
// The governing clock is the VENUE zone (`scheduleSettings.tz`) for BOTH
// bucketing and printing — amendment 4. Never the org zone: two zones in one
// row is the bug, wherever the seam is drawn (_RULES.md, "One zone per
// fixture").
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { zonedTimeInput } from "@/lib/zoned-datetime";
import type { FixtureRow } from "@/server/usecases/stages";
import { unseatedForfeitLoser } from "@/lib/forfeit-tag";
import { isUnseatedSwissByeShell } from "@/lib/swiss-shell";
import type { CameraPolicy } from "@/lib/camera-policy";
import type { NeedsReason } from "@/server/external-play/types";
import { stageCounts } from "@/lib/stage-card/summaries";

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
  // W2b Task 13: the active abandon's reason, the run sheet's abandon tag read (`outcomeText`'s ledger).
  | "abandon_reason"
  // W2c Task 19 (S4): the match plays a format of its own - the "Format changed" chip (`desk/run-sheet-tags.ts`).
  | "format_changed"
> &
  // Match Day E1 fix rounds 1 and 3: a group stage's row says which pool it is (the row's pool chip) and ties in time read by pool
  // (`stageRoundSections`). OPTIONAL on purpose: the wire row always carries it (`toRunSheetFixture` spreads the whole row), but a hand-built
  // fixture that predates it is a row with no pool, which is what absent means - the same posture `ext_key`/`lane` take on `FixtureRow` itself.
  Partial<Pick<FixtureRow, "pool_id">>;

export type RunSheetStage = { id: string; seq: number; kind: string };

/** T16 — an online chess board as the run sheet reads it (canvas
 *  RunSheetDesktop): its camera policy, its OPEN flags, and whether it is held
 *  for the organiser. Keyed by fixture id beside the fixtures — the same
 *  posture as the stream chips (`streamStates`) — never a field of the wire
 *  row, so `buildRunSheet`'s grouping cannot see it. */
export type RunSheetOnlinePlay = {
  cameraPolicy: CameraPolicy;
  /** Open `camera_lost` flags: a player's camera evidence (amber; takes "Camera ok" away). */
  cameraFlagCount: number;
  /** T16 fix round 1, I3 — open `camera_connection_problems` flags: OUR safeguard's connection, never the player's.
   *  A quiet fact of its own (carry progress.md:1006): never counted with `cameraFlagCount`, never an accusation. */
  connectionProblemCount: number;
  /** Open `out_of_band_play` flags: moves made off Seazn. */
  offSeaznFlagCount: number;
  /** Held for the organiser (needs_organiser) while still to be played. */
  held: NeedsReason | null;
  /** A game is running at Lichess now (bridge `live`). */
  live: boolean;
  /** D12: still to be played in an online round nobody has opened — nobody is
   *  invited and nobody can take a seat, so it owes no result yet, whatever
   *  its scheduled time says. */
  unopened: boolean;
};

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

/** Stage kinds whose fixtures run in numbered ROUNDS a person reads in turn - the kinds a stage card draws a bar per round for
 *  (Match Day E1). Every other kind is a bracket (named rounds, `BRACKET_STAGE_KINDS`) or the ladder, which stores each
 *  challenge as a round of its own (`stages.ts`, `issueChallenge`): a bar per challenge says nothing, so a ladder is one flat list.
 *
 *  A literal beside `BRACKET_STAGE_KINDS` because no client-safe set answers this question: the engine's `DRAW_KINDS` is the
 *  kinds a level result may occur in (the same four today, a different fact), and the `TABLE_KINDS` copies are server-private and
 *  not one membership. `run-sheet-groups.test.ts` holds the three homes (rounds, bracket, ladder) to a partition of the engine's
 *  `StageKind`, so a kind the engine adds fails there until someone decides which it is. */
export const ROUND_SEQUENCE_STAGE_KINDS: ReadonlySet<string> = new Set(["league", "group", "swiss", "americano"]);

/** A bye: one side empty with an auto-advance award outcome (v3/04 §3 item 6).
 *  Copied verbatim from `stages-panel.tsx`'s module-private `isBye`, typed
 *  against `RunSheetFixture` instead of `FixtureRow` — a lib must not import
 *  from a component. Task 4 deletes that copy and imports this instead.
 *
 *  R116-3 (owner ruling 116): an empty seat the award names a LOSER in — a withdrawn winner's, walked over by the side
 *  that arrived — is HER seat, so the line is a walkover like any other, not a bye. `unseatedForfeitLoser` is the one
 *  reader of that shape; an award with no loser (a bye, a dead feeder's seat, a DQ'd winner's) still answers yes.
 *
 *  W3 T3 (X-SW-29, RB3-23): a Swiss stage's bye row is a bye before Pair seats it, too — an unseated `sw-r{N}-bye`
 *  shell has no seat and no award yet, but it is never a match, takes no court or time (the server refuses one,
 *  SWISS_BYE_NOT_PLACEABLE) and is never actionable. `isUnseatedSwissByeShell` (lib/swiss-shell.ts) is the shell alone. */
export function isBye(f: RunSheetFixture): boolean {
  if (isUnseatedSwissByeShell(f)) return true;
  const o = f.outcome as { kind?: string } | null;
  if (o?.kind !== "award") return false;
  const empty = f.home_entrant_id === null ? "home" : f.away_entrant_id === null ? "away" : null;
  return empty !== null && unseatedForfeitLoser(f, empty) === null;
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
  const bracketStageIds = new Set(
    stages.filter((s) => BRACKET_STAGE_KINDS.has(s.kind)).map((s) => s.id),
  );
  // Swiss sit-outs must stay visible after Pair (shell programme). Not a
  // bracket — day-grouping unchanged — only bye *visibility* differs from
  // league/group R7(c).
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

  for (const f of fixtures) {
    // R7: byes are structural — never schedulable, never actionable. Checked
    // FIRST, before the scheduled_at test, or an untimed bye reaches the
    // unscheduled pile and is offered a "Set time" for a match nobody plays.
    if (isBye(f)) {
      // W3 T3 (X-SW-29): a Swiss bye shell nobody is seated in yet is no row at all — there is no one to name.
      if (isUnseatedSwissByeShell(f)) continue;
      // (b) a bracket stage keeps its byes as ghost rows in their round.
      // Swiss: show the award in settled-untimed (never unscheduled — R7a).
      // Other non-bracket kinds: leave the sheet (R7c).
      if (bracketStageIds.has(f.stage_id)) {
        const list = bracketed.get(f.stage_id) ?? [];
        list.push(f);
        bracketed.set(f.stage_id, list);
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
    // The NOW rule exists ONLY on today's block. `findIndex` returning -1 means
    // every row is at or before now, so the rule goes after the last one.
    let nowIndex: number | null = null;
    if (dayKey === today) {
      const first = rows.findIndex((f) => Date.parse(f.scheduled_at as string) > nowMs);
      nowIndex = first === -1 ? rows.length : first;
    }
    blocks.push({
      at: Date.parse(rows[0].scheduled_at as string),
      seq: Number.MAX_SAFE_INTEGER,
      block: { kind: "day", dayKey, fixtures: rows, nowIndex },
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
  if (settledUntimed.length > 0) {
    settledUntimed.sort(byRank);
    out.push({ kind: "settled", fixtures: settledUntimed });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Match Day E1 item 1 (owner 2026-11-01): a stage card groups its rows under a header bar PER ROUND, not per day. The division-wide
// `buildRunSheet` above is unchanged (its day / unscheduled / settled blocks still feed the filter counts and the bracket blocks);
// these pure functions regroup ONE non-bracket stage's rows from those same blocks.
// ---------------------------------------------------------------------------

/** One round of a non-bracket stage as the card shows it: its rows in the order they are read. A group stage's round holds EVERY pool's
 *  matches of that round (Match Day E1 fix round 3): the rows say which pool they are (`pool_id`), the section does not. */
export type StageRoundSection = { round: number; fixtures: RunSheetFixture[] };

/**
 * One NON-BRACKET stage's rows from the division's blocks, as round sections: ONE per round, whatever the stage's pools - a group stage's
 * Round 1 holds Group A's and Group B's first matches together (E1 fix round 3: pools on separate courts play at the same time, so
 * no order of per-pool sections is also time order). The sections read in the order they are PLAYED: earliest kickoff first, the ones with
 * nothing timed last, the round number to break a tie. Within a round the rows run in time order and the ones with no time sit last: a
 * tie goes to the pool `poolOrder` (the display order the page owns, pool id -> position) lists first - rows of no pool before a listed
 * pool, a pool `poolOrder` does not list after every listed one - and then to the order the draw gave them. The rows a person plays first
 * are read first, and "No time yet" never interrupts a timed run. Bracket blocks are skipped (a knockout keeps its own named rounds); a
 * bye the grouping kept (a Swiss sit-out) rides in its round as an untimed row.
 *
 * Reads the blocks, never the raw fixture list, so a row `buildRunSheet` leaves off (an untimed league bye, R7c) is absent here too.
 */
export function stageRoundSections(
  blocks: readonly RunSheetBlock[],
  stageId: string,
  poolOrder: ReadonlyMap<string, number> = NO_POOL_ORDER,
): StageRoundSection[] {
  const byRound = new Map<number, RunSheetFixture[]>();
  for (const f of stageRowsOutsideBrackets(blocks, stageId)) {
    const list = byRound.get(f.round_no) ?? [];
    list.push(f);
    byRound.set(f.round_no, list);
  }
  const inOrder = inReadingOrder(poolOrder);
  const sorted = [...byRound.entries()].map(([round, fixtures]) => ({ round, fixtures: [...fixtures].sort(inOrder) }));
  // Rounds read in the order they are PLAYED (design/fix-ui/03: a Tour 3 that kicked off a day before Tour 1 is not "last"): by the
  // earliest kickoff in the round, the rounds with no time at all after them, and round number to break every tie - which is
  // also the whole order while nothing is timed yet. Sorted rows put the earliest timed one first, so that is `fixtures[0]`.
  const earliest = (r: StageRoundSection): number => (r.fixtures[0]?.scheduled_at != null ? Date.parse(r.fixtures[0].scheduled_at) : Number.POSITIVE_INFINITY);
  return sorted.sort((a, b) => {
    const ea = earliest(a);
    const eb = earliest(b);
    if (ea !== eb) return ea < eb ? -1 : 1;
    return a.round - b.round;
  });
}

const NO_POOL_ORDER: ReadonlyMap<string, number> = new Map();

/**
 * One NON-BRACKET stage's rows as a single list - for a kind whose rounds are not worth a bar (the ladder, which stores each challenge
 * as a round of its own). The same reading order as inside a round: time order, the rows with no time last in the order the draw gave
 * them. A one-element list (round 0, the stage as a whole) so the caller draws it with the code that draws a round, minus the bar;
 * an empty list when the stage has no rows here.
 */
export function stageFlatSection(blocks: readonly RunSheetBlock[], stageId: string): StageRoundSection[] {
  const fixtures = [...stageRowsOutsideBrackets(blocks, stageId)].sort(inReadingOrder(NO_POOL_ORDER));
  return fixtures.length === 0 ? [] : [{ round: 0, fixtures }];
}

/** A stage's rows out of the division's non-bracket blocks, in no particular order. */
function stageRowsOutsideBrackets(blocks: readonly RunSheetBlock[], stageId: string): RunSheetFixture[] {
  const rows: RunSheetFixture[] = [];
  for (const block of blocks) {
    if (block.kind === "bracket") continue;
    for (const f of block.fixtures) if (f.stage_id === stageId) rows.push(f);
  }
  return rows;
}

const drawRank = (a: RunSheetFixture, b: RunSheetFixture) => a.seq_in_round - b.seq_in_round || a.fixture_no - b.fixture_no;
/**
 * Time order, the rows with no time last. Rows that tie - the same minute, or no time at all - read by the pool `poolOrder` lists first
 * (rows of no pool before a listed pool, an unlisted pool after every listed one, two unlisted pools by id so the order is stable) and then
 * in the order the draw gave them. A stage with no pools has one pool (none), so for a league, a Swiss event or an americano the tie goes
 * straight to the draw, as it always did.
 */
function inReadingOrder(poolOrder: ReadonlyMap<string, number>): (a: RunSheetFixture, b: RunSheetFixture) => number {
  const poolRank = (f: RunSheetFixture): number => (f.pool_id == null ? -1 : (poolOrder.get(f.pool_id) ?? Number.POSITIVE_INFINITY));
  const at = (f: RunSheetFixture): number => (f.scheduled_at === null ? Number.POSITIVE_INFINITY : Date.parse(f.scheduled_at));
  return (a, b) => {
    const ta = at(a);
    const tb = at(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    const pa = poolRank(a);
    const pb = poolRank(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    if ((a.pool_id ?? "") !== (b.pool_id ?? "")) return (a.pool_id ?? "") < (b.pool_id ?? "") ? -1 : 1;
    return drawRank(a, b);
  };
}

/**
 * "N of M done" for one round: M is every real match in it (byes are no match), N what the stage card itself counts as finished -
 * `stageCounts`' `played` bucket, the number the Complete button waits on. A walkover, an abandonment and a cancellation are
 * done (nothing is left to play); a match held for its settle is not (`held` is the ids the page lists as awaiting it). The
 * bars of a stage's rounds therefore add up to the stage's own counts line: a bar can never read "1 of 2" on a stage Complete
 * is already enabled for.
 */
export function roundDone(fixtures: readonly RunSheetFixture[], held: ReadonlySet<string>): { done: number; total: number } {
  const real = fixtures.filter((f) => !isBye(f));
  return { done: stageCounts(real, held).played, total: real.length };
}

/**
 * Does a round's bar start collapsed (Match Day PB1, owner 2026-11-02)? Only a round with real matches, every one of them settled
 * (`roundDone`: `done === total`, a held settle still open): a finished round is one line, the current and the upcoming ones are
 * open. A round with no real match at all (only byes) is NOT finished - the empty set is not "everything done", and a bar that
 * folded away nothing would be a toggle over no rows.
 */
export function roundStartsCollapsed(fixtures: readonly RunSheetFixture[], held: ReadonlySet<string>): boolean {
  const { done, total } = roundDone(fixtures, held);
  return total > 0 && done === total;
}

/**
 * The fold default a round bar or a stage card keeps for the page visit (Match Day PB1, controller ruling 2, 2026-11-02). It is
 * decided the FIRST time the thing is seen (`latched` absent: today's default), and from then on it only ever moves toward OPEN:
 * a round or a stage that finishes while the person is looking stays open until a reload or their own tap, so rows never vanish
 * from under a refresh. The one move it does make is the safe one - something that comes back to want a person (a void re-opens a
 * match, a warning arrives) opens it. A person's own tap is not this; callers apply it over the value returned here.
 */
export function latchedOpen(latched: boolean | undefined, startsOpenNow: boolean): boolean {
  return latched === undefined ? startsOpenNow : latched || startsOpenNow;
}

/**
 * When a round is played, from the rows it is asked of: the first and last calendar day in the VENUE zone and, when they are one
 * day, the clock span of its timed rows ("21:10" to "21:50", equal when only one row has a time). `null` when no row has a time:
 * a bar with nothing to say about time says nothing (an empty cell is not information).
 */
export function roundWhen(
  fixtures: readonly RunSheetFixture[],
  tz: string,
): { firstDay: string; lastDay: string; from: string; to: string } | null {
  const instants = fixtures.filter((f) => f.scheduled_at !== null).map((f) => Date.parse(f.scheduled_at as string));
  if (instants.length === 0) return null;
  const first = Math.min(...instants);
  const last = Math.max(...instants);
  return { firstDay: dayKeyInTz(first, tz), lastDay: dayKeyInTz(last, tz), from: zonedTimeInput(first, tz), to: zonedTimeInput(last, tz) };
}
