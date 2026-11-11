import "server-only";
// Bracket seat writes: filling a slot, stamping a departed seat, seeded byes,
// settled-bye advance and the cascade that resolves a bracket's seats.

// Cycle (entrants.ts imports this file): read only inside function bodies, never at module evaluation.
import { DEPARTED_STATUSES } from "../entrants";
import { feedsNextMatch } from "@/lib/bracket-next-match";
import { advancesNobody, type MatchOutcome } from "@seazn/engine/core";
import { killsLoserEdge, lockDivisionConfigShared, lockStageSeats } from "@/server/engine-db/fed-seats";
import { hasActiveAbandonSql } from "@/server/engine-db/recorded-abandon";
import { deadSeatLeaverSql } from "@/server/engine-db/system-bye-sql";
import { writeAwardedMatchState } from "@/server/engine-db/awarded-state";
import { BYE_SLOT_LABEL } from "@/lib/bye-line";
import type { Tx } from "./types";

/** Fill one side of a fixture (slot 1=home, 2=away) if still open. The ONE
 *  real mutation point for putting an entrant into a fixture slot — every
 *  cross-stage or intra-bracket advancement routes through this (D4a/P5
 *  scope item 3: "one pathway, not two"). Also clears the matching
 *  `*_slot_label` (D4a design's Fill algorithm step 4: "clear its
 *  *_slot_label params" — label text is derivable post-fill, and the
 *  proposal row keeps it for history); a no-op for the pre-existing
 *  intra-bracket callers, whose fixtures never had a label set. */
export async function fillSlot(
  tx: Tx,
  fixtureId: string,
  slot: number,
  entrantId: string,
): Promise<string | null> {
  // R10g: the id the update actually touched (null when the slot was already
  // filled), so a caller that publishes names exactly what its own write
  // filled, never a list re-read or re-derived after the fact.
  const [row] = slot === 1
    ? await tx<{ id: string }[]>`update fixtures set home_entrant_id = ${entrantId}, home_slot_label = null
             where id = ${fixtureId} and home_entrant_id is null returning id`
    : await tx<{ id: string }[]>`update fixtures set away_entrant_id = ${entrantId}, away_slot_label = null
             where id = ${fixtureId} and away_entrant_id is null returning id`;
  return row?.id ?? null;
}

/** Loop-F I-1 / R-1: the seat a DEPARTED entrant would have filled — as the winner (a void re-opened her line, and she
 *  won it again) or as the loser (X-WD-5) — is stamped dead instead (`BYE_SLOT_LABEL`, as her withdrawal stamps it,
 *  X-WD-3/D17), so the cascade walks the line's other side over it and a void of the deciding line finds the stamp
 *  (fed-seats.ts `planRelease`). A departed entrant is never seated by a decision taken after she left. Only an EMPTY
 *  seat of an undecided line; the id it stamped, or null. */
export async function stampDepartedSeat(tx: Tx, fixtureId: string, slot: number): Promise<string | null> {
  const bye = tx.json(BYE_SLOT_LABEL as never);
  const [row] = slot === 1
    ? await tx<{ id: string }[]>`update fixtures set home_slot_label = ${bye}
             where id = ${fixtureId} and home_entrant_id is null and status = 'scheduled' and outcome is null returning id`
    : await tx<{ id: string }[]>`update fixtures set away_slot_label = ${bye}
             where id = ${fixtureId} and away_entrant_id is null and status = 'scheduled' and outcome is null returning id`;
  return row?.id ?? null;
}

/** Decide every bye line in `stageId` whose real side is now occupied, and
 *  return the fixture ids this call actually changed.
 *
 *  A `timing: "setup"` progression draws its bracket before anyone has
 *  qualified, so the walkover the plain path bakes straight into its INSERT
 *  (`status: 'forfeited'` + `{kind: 'award', winner}`) cannot be written at
 *  generation time — there is nobody to award it to yet. It has to be written
 *  at the moment the seat is filled, and nothing did: the row stayed
 *  `scheduled` with a null outcome for the whole life of the competition.
 *  Two things follow from that, and they are the defect this exists to close:
 *  the line is unplayable by construction (its other side is empty forever),
 *  so the stage can never complete; and `isBye` (lib/run-sheet-groups — the
 *  ONE predicate the run sheet row and the bracket panel both gate their bye
 *  branch on) reads false, so it renders as an ordinary open match "awaiting
 *  a draw". Every progression-bearing template in the catalogue declares
 *  `timing: "setup"`, so it reached league_ko, groups_ko, group_stepladder,
 *  ko_plate, qualifying_main and both swiss composites alike.
 *
 *  A bye is identified by the `bracket.slot.bye` label its own generation
 *  stamped on the phantom side — NEVER by "one side is null", which is also
 *  every later-round slot still waiting on a feeder, and every half-filled
 *  final. Idempotent: `status = 'scheduled'` makes a second call a no-op, and
 *  a line whose real seat has not been filled yet is left alone until it is.
 *
 *  Owner ruling 116 (W2b Task 16; X-WD-3): a seat that is dead because the
 *  WINNER its feeder delivers has since WITHDRAWN (status `withdrawn`) is no
 *  bye — she won her way there and then left, so the arriving side walks over
 *  HER: the award names her as its loser, reason `withdrew`, and every surface
 *  reads "w/o" and "<her> withdrew — walkover." through the one forfeit reader
 *  (`forfeitTag`). She is still never seated: the seat stays empty and dead
 *  (X-WD-3/X-WD-5), and the ranks read an award whose loser holds no seat as
 *  the bye it was (engine-db/competition.ts `bracketWinnerLoser`). Every other
 *  dead seat — a genuine bye, a void's or a double walkover's dead feeder, a
 *  departed qualifier seated at generation with no feeder — names nobody and
 *  stays the bye it was, byte for byte. The ruling's scope, no wider: only the
 *  winner edge (a departed LOSER's dead loser-edge seat, X-WD-5, stays a bye),
 *  and only a withdrawal — a DISQUALIFIED winner (the other departed status) is
 *  no "withdrew", and stays a bye until a ruling words it.
 *
 *  R116-2: like any other walkover it shows the sport's walkover credit. No event records it (nobody played it, X-PS-1),
 *  so its score is written beside it — `writeAwardedMatchState`, the module's own summary of the award under the
 *  fixture's cfg, into the cache every surface reads. A bye credits no score and gets no row, as before. */
async function awardSeededByes(tx: Tx, stageId: string): Promise<string[]> {
  const rows = await tx<{ id: string; withdrew: boolean }[]>`
    with lines as (
      -- W4 B1b fix round 1 (Q1): who held the dead seat is deadSeatLeaverSql, the same fragment the run sheet and the desk
      -- read (awaitsWalkoverSql) to count this line before its award. Over the rows below (one seat filled, the other empty
      -- and bye-labelled) its phantom slot is exactly the empty side, as the inline case it replaces read it.
      -- NOTE: no backticks in this comment. It lives inside a JS tagged template literal, where a backtick ENDS the SQL.
      select f.id, coalesce(f.home_entrant_id, f.away_entrant_id) as winner,
             ${deadSeatLeaverSql(tx, "f")} as withdrawn
        from fixtures f
       where f.stage_id = ${stageId}
         and f.status = 'scheduled'
         and f.outcome is null
         and (
           (f.away_entrant_id is null and f.home_entrant_id is not null
              and f.away_slot_label->>'key' = ${BYE_SLOT_LABEL.key})
           or
           (f.home_entrant_id is null and f.away_entrant_id is not null
              and f.home_slot_label->>'key' = ${BYE_SLOT_LABEL.key})
         )
    )
    update fixtures set
      status = 'forfeited',
      outcome = jsonb_build_object(
        'kind', 'award', 'winner', lines.winner, 'loser', lines.withdrawn,
        'reason', case when lines.withdrawn is null then 'bye' else 'withdrew' end),
      -- W4 T3 (K2, X-SD-5): a bye is not played, so the award leaves it no court, no time and no pin (a line placed
      -- before the fix, or pinned on the board). A withdrew walkover keeps its slot: it is no bye line (isByeLine, lib/bye-line.ts).
      scheduled_at = case when lines.withdrawn is null then null else fixtures.scheduled_at end,
      court_id = case when lines.withdrawn is null then null else fixtures.court_id end,
      venue_id = case when lines.withdrawn is null then null else fixtures.venue_id end,
      schedule_locked = case when lines.withdrawn is null then false else fixtures.schedule_locked end
    from lines
    where fixtures.id = lines.id
    returning fixtures.id, lines.withdrawn is not null as withdrew`;
  for (const r of rows) if (r.withdrew) await writeAwardedMatchState(tx, r.id);
  return rows.map((r) => r.id);
}

/** A feeder that can NEVER hand a winner onward.
 *
 *  OWNER RULING 2026-09-21 (review round 5, N2/N6) — **AN ABANDONED MATCH THAT
 *  CARRIES AN OUTCOME IS NOT DEAD.** Dead means `cancelled`, or `abandoned`
 *  with NO outcome at all, which is exactly the shape the generator and this
 *  cascade write for their own voids.
 *
 *  A withdrawal is someone LEAVING THE COMPETITION; an abandonment is a match
 *  that WAS PLAYED and produced no result. Different events, different
 *  answers. The predicate used to read `!outcome?.winner`, so a quarter-final
 *  abandoned for rain silently stamped the semi-final seat as a bye and walked
 *  the other semi-finalist into the final — no organiser decision, no replay,
 *  no trace on screen. That is the system ruling on a sporting question it has
 *  no business deciding. A rained-off match now stays STUCK AND VISIBLE, which
 *  is a legitimate waiting state for a human to rule on, not a defect: the
 *  stage answers `{completed: false}` and the line keeps its `abandoned` row
 *  on the run sheet.
 *
 *  `forfeited` is deliberately NOT here. It is a "void status" on the desk
 *  (VOID_STATUSES, stages-panel.tsx) and yet it carries a real winner — that
 *  is how a bye advances.
 *
 *  `cancelled` is DEFENSIVE. Nothing in `apps/web/src` or
 *  `packages/engine/src` writes `fixtures.status = 'cancelled'`; every
 *  production reference reads it. It is a valid value in the v1 output schema,
 *  so it may arrive on an import path, and the clause is pinned by a test that
 *  inserts the row through raw SQL and says so. Do not assume coverage from a
 *  product path — there is none.
 *
 *  W2a NEW-H1 (D4, reproduced by apps/web/e2e/bracket-new-h1.spec.ts):
 *  `abandoned` with NO outcome is ALSO what a recorded abandon folds to in most
 *  sports (`dead-feeder-cascade.test.ts` sweeps the registry and counts both
 *  shapes) — a match that was played and stopped, which the ruling above says
 *  stays stuck and visible until the organiser settles it (X-ST-1). The
 *  generator and this cascade write their voids WITHOUT an event; a recorded
 *  abandon is an ACTIVE `core.abandon` in the ledger (voids are not voidable,
 *  core/events.ts `resolveVoids`, so "active" is "no row voids it"). That is
 *  the line between them (`engine-db/recorded-abandon.ts`, read by stage
 *  completion too, ruling D-G1). A withdrawal's own abandon (withdrawal.ts, the
 *  open-format branch page_playoff takes) is a recorded one too: its line
 *  waits for the settle instead of eliminating the departed entrant's opponent.
 *
 *  `needs_decision` (a held level result, X-BR-2) is not dead either: it is
 *  neither decided nor void. A future "decided, nobody advances" outcome
 *  belongs in its OWN clause beside these two, never folded into the abandon
 *  test. */
function feederIsDead(f: {
  status: string;
  outcome: { kind?: string; winner?: string } | null;
  has_active_abandon: boolean;
}): boolean {
  if (f.status === "cancelled") return true;
  // W2b X-DW-2 — the "decided, nobody advances" clause the paragraph above reserved, on its OWN line: a double
  // walkover decided the match and sent nobody on (`advancesNobody`), whatever its status (forfeited, or finalized
  // after it). Never folded into the abandon test below.
  if (advancesNobody(f.outcome as MatchOutcome | null)) return true;
  return f.status === "abandoned" && f.outcome === null && !f.has_active_abandon;
}

/** A feeder that can never hand a LOSER onward (review round 5, N1). There are
 *  TWO disjoint reasons and keeping them apart is the whole point — conflating
 *  "produced no loser" with "died" is how this bug class keeps coming back:
 *
 *  (a) THE MATCH NEVER PRODUCED A RESULT AT ALL. Identical to the winner case,
 *      so this delegates to `feederIsDead` rather than restating it — the two
 *      predicates must not drift, and a future change to what "settled and
 *      produced nobody" means then flows through both by construction.
 *
 *  (b) THE MATCH SETTLED AND PRODUCED A WINNER BUT NO LOSER — precisely an
 *      `award`, i.e. a walkover. `onDecided` takes `loser` only from
 *      `kind: "win"` (scoring.ts), while `winner` comes from `"win"` OR
 *      `"award"`. So a bye line is ALIVE as a winner feeder and DEAD as a
 *      loser feeder: the one row on which the two predicates deliberately
 *      disagree.
 *
 *  `draw`, `tie` and `no_result` produce no loser either, and are deliberately
 *  NOT dead here. Under the 2026-09-21 ruling a match that was played and
 *  produced no result waits for a human either way it feeds — a rained-off
 *  semi-final must not hand the third-place line a walkover any more than it
 *  hands the final one. The test for that is "an abandoned feeder that carries
 *  an outcome leaves BOTH of its seats alone".
 *
 *  A feeder still on its way (`scheduled`/`in_play`, outcome null) is NOT dead
 *  either; that is the "cascade late" rule, and treating it as dead would
 *  pre-stamp the whole losers bracket at generation. */
function loserFeederIsDead(f: {
  status: string;
  outcome: { kind?: string; winner?: string; method?: string } | null;
  has_active_abandon: boolean;
  loser_withdrawn: boolean;
}): boolean {
  if (feederIsDead(f)) return true;
  // W2b X-WD-5: a withdrawn entrant is never seated on a loser edge — a settle on a LEGACY held line (plan PF-8a)
  // names her as its loser; `onDecided` does not seat her, and her seat is dead here so the opponent walks over it.
  if (f.loser_withdrawn) return true;
  // W2b X-DE-1: a forfeit loser is out of the tournament — an `award` names no loser to send on, and neither does a
  // legacy chess forfeit win — fed-seats.ts `killsLoserEdge`, the one reading the un-fill releases the edge from too
  // (loop-F tidy 2), beside `advancingSides`, which fills from it.
  return killsLoserEdge(f.outcome);
}

/** Which of the two predicates applies depends on WHICH EDGE seated the feeder,
 *  not on the row — the same walkover is a live winner feeder and a dead loser
 *  feeder. A destination seat has exactly one incoming edge, so the tag is
 *  carried on the map entry rather than re-derived.
 *
 *  This is also the ONE owner of "no feeder I can see", which is the
 *  load-bearing direction: an absent entry means a CROSS-STAGE source or a
 *  seat a seeded draw fills directly, and reading it as "dead" would hand out
 *  free walkovers across the whole bracket. Neither predicate below repeats
 *  the guard — a duplicate would be unreachable, and an unreachable guard
 *  cannot be mutation-tested. */
interface FeederEdge {
  row: SeatRow;
  via: "winner" | "loser";
}

function seatFeederIsDead(e: FeederEdge | undefined): boolean {
  if (!e) return false;
  return e.via === "winner" ? feederIsDead(e.row) : loserFeederIsDead(e.row);
}

/** W2b X-WD-4 — an open seat dead THROUGH DEPARTURE, as opposed to a void: the seat its withdrawn entrant left (the
 *  cascade's dead-seat stamp, X-WD-3 / plan D17 — `bye`), or one whose winner feed is a DEPARTURE double walkover
 *  (both its sides withdrew: written with no event, by `writeDepartedSeat` or by this resolver — `departed_walkover`).
 *  A line whose two seats are both dead this way had every side withdraw, which is a double walkover (X-WD-4), not a
 *  void. Any other dead feeder — a void, a cancelled line, a forfeit loser (but a third-place line's: ruling A, below), and a RECORDED double walkover (its
 *  `core.forfeit{by:"both"}` behind it: nobody withdrew, the plan's Review Focus 1 voids that line) — keeps the void. */
function seatDeparted(bye: boolean, e: FeederEdge | undefined, thirdPlace = false): boolean {
  if (bye || (e !== undefined && e.via === "winner" && e.row.departed_walkover)) return true;
  // B4 M-1 (X-TP-7): a third-place line's seat is fed by a semi-final's LOSER. When that loser withdrew (the semi was a walkover
  // for her opponent), the seat is dead through departure too - the line is a double walkover, not a void.
  // Owner ruling A (2026-11-11): a semi-final loser by an organiser-RECORDED walkover is out for the third-place line exactly like
  // a withdrawal - the loser of an award is out of the tournament (X-DE-1), so any killed loser edge is a departure here (the
  // award's own reason no longer matters). Only the third-place line reads it: the main draw and the plate keep their meaning.
  return thirdPlace && e !== undefined && e.via === "loser" && (e.row.loser_withdrawn || killsLoserEdge(e.row.outcome));
}

interface SeatRow {
  id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key?: string } | null;
  away_slot_label: { key?: string } | null;
  status: string;
  outcome: { kind?: string; winner?: string; method?: string; reason?: string } | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
  /** W2a NEW-H1 (D4): abandoned, and the ledger holds a `core.abandon` no `core.void` targets — ONE definition,
   *  `hasActiveAbandonSql` (engine-db/recorded-abandon.ts), shared with stage completion (D-G1). See `feederIsDead`. */
  has_active_abandon: boolean;
  /** W2b X-WD-5: the loser this row's outcome names has withdrawn (`loserFeederIsDead`). */
  loser_withdrawn: boolean;
  /** W2b X-WD-4: a double walkover with no live event behind it — a departure, never a recorded one (`seatDeparted`). */
  departed_walkover: boolean;
  /** B4 M-1: the third-place line of a knockout (it feeds no next match, yet X-TP-7 settles it as a double walkover). */
  third_place: boolean;
}

/** Push the winners of the lines `awardSeededByes` just settled into the seats
 *  they feed — `winner_to_fixture` / `winner_to_slot`, via `fillSlot`, the same
 *  ONE channel `onDecided` advances a played fixture through (C1, re-review
 *  2026-09-21). `awardSeededByes` writes status and outcome and nothing else,
 *  so without this a settled walkover advances nobody. A no-op where the
 *  destination seat is already taken, which is the genuine-bye case (the
 *  seed's own expansion filled both of its slots), so both shapes go through
 *  one path rather than two. */
async function advanceSettledByes(tx: Tx, settled: string[]): Promise<string[]> {
  if (settled.length === 0) return [];
  const out: string[] = [];
  const feeds = await tx<
    {
      id: string;
      winner_to_fixture: string | null;
      winner_to_slot: number | null;
      outcome: { kind?: string; winner?: string } | null;
    }[]
  >`select id, winner_to_fixture, winner_to_slot, outcome from fixtures
    where id in ${tx(settled)}`;
  for (const feed of feeds) {
    const winner = feed.outcome?.kind === "award" ? feed.outcome.winner : undefined;
    if (!winner || !feed.winner_to_fixture) continue;
    if (feed.winner_to_slot !== 1 && feed.winner_to_slot !== 2) continue;
    const advanced = await fillSlot(tx, feed.winner_to_fixture, feed.winner_to_slot, winner);
    if (advanced !== null) out.push(advanced);
  }
  return out;
}

/**
 * W2b X-WD-3 / X-WD-4 — the withdrawal cascade's two writes that carry no event (as `awardSeededByes` writes a bye),
 * then the cascade over the stage (`resolveBracketSeats`). Returns every fixture id it changed, this one first.
 *
 * - `"tbd"` (plan D17): her opponent is not known yet, so no walkover can be recorded. Her seat is emptied and stamped
 *   `bracket.slot.bye` — dead — and whoever arrives walks over it in the same write that seats them. The F14 pattern
 *   (`walkoverDepartedQualifiers`), applied after the draw.
 * - `"double_walkover"`: both entrants of the line have withdrawn. `forfeited` + `{kind: "double_walkover"}`, both
 *   seats kept (the run sheet names who did not play), and nobody advances (X-DW-2). The caller writes it only on a
 *   line that feeds a next match (D19), and only on a line with NO live score event (review M-1): a departure double
 *   walkover is the no-event write, so recorded play is never overwritten by it.
 *
 * Each update is guarded on the row the cascade judged — under the fixture's own append lock — so a write that finds
 * nothing means that row moved under it.
 *
 * Loop R2 N-2: the cascade below judges seats by their FEEDERS' stored decisions, so it runs under the stage lock a
 * decision's cascade and a double walkover's void hold (`lockStageSeats`) — taken first, before the fixture lock (the
 * one order, Loop R2 N-1). Without it a departure double walkover on one semi and the other semi's decision could each
 * read the other's line before it committed, and leave the final holding the winner beside a dead semi, unwalked.
 *
 * @throws Error when the guarded write matches nothing: an assumption broken, never a silent no-op.
 */
export async function writeDepartedSeat(
  tx: Tx,
  fixtureId: string,
  entrantId: string,
  mode: "tbd" | "double_walkover",
): Promise<string[]> {
  // Read without a lock: a fixture never changes stage.
  const [at] = await tx<{ stage_id: string }[]>`select stage_id from fixtures where id = ${fixtureId}`;
  if (at) await lockStageSeats(tx, at.stage_id);
  await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;
  // W2c Task 15 fix round 1 (M-1): the cascade below never interleaves with a format save in flight — the format
  // freeze's lock, SHARED, after the fixture lock (`fed-seats.ts`). Defensive: the review asked for it on every no-event
  // writer, and no read of the division's LIVE config was found on this path (a voided award refolds its frozen
  // snapshot, pre-V347 rows aside; `awardSeededByes` scores only a "withdrew" award, which this cascade does not make).
  if (at) await lockDivisionConfigShared(tx, at.stage_id);
  const bye = tx.json(BYE_SLOT_LABEL as never);
  const [row] =
    mode === "tbd"
      ? await tx<{ id: string; stage_id: string }[]>`
          update fixtures set
            home_entrant_id = case when home_entrant_id = ${entrantId} then null else home_entrant_id end,
            home_slot_label = case when home_entrant_id = ${entrantId} then ${bye} else home_slot_label end,
            away_entrant_id = case when away_entrant_id = ${entrantId} then null else away_entrant_id end,
            away_slot_label = case when away_entrant_id = ${entrantId} then ${bye} else away_slot_label end
          where id = ${fixtureId} and status = 'scheduled' and outcome is null
            and ((home_entrant_id = ${entrantId} and away_entrant_id is null)
              or (away_entrant_id = ${entrantId} and home_entrant_id is null))
          returning id, stage_id`
      : await tx<{ id: string; stage_id: string }[]>`
          update fixtures set status = 'forfeited', outcome = ${tx.json({ kind: "double_walkover" } as never)}
          where id = ${fixtureId} and status in ('scheduled', 'in_play', 'needs_decision', 'abandoned')
            and home_entrant_id is not null and away_entrant_id is not null
            and (home_entrant_id = ${entrantId} or away_entrant_id = ${entrantId})
            and not exists (select 1 from score_events e
                            where e.fixture_id = fixtures.id and e.type <> 'core.void'
                              and not exists (select 1 from score_events v
                                              where v.fixture_id = e.fixture_id and v.voids_event_id = e.id))
          returning id, stage_id`;
  if (!row) {
    throw new Error(`writeDepartedSeat: fixture ${fixtureId} is no longer the undecided line entrant ${entrantId} was judged on (${mode})`);
  }
  const touched = [row.id];
  for (const id of await resolveBracketSeats(tx, row.stage_id)) if (!touched.includes(id)) touched.push(id);
  return touched;
}

/** One pass per round is the theoretical worst case (a chain of voids can walk
 *  the cascade from the first round to the final, one round at a time), and a
 *  bracket has nowhere near 32 rounds. This exists so a future bug turns into
 *  a loud error rather than a transaction that never returns. */
const MAX_CASCADE_PASSES = 32;

/**
 * OWNER RULING 2026-09-21 (the cascade) — **a seat whose feeder is permanently
 * dead is a BYE seat.**
 *
 * Re-review C2 taught the generator to VOID a bracket line with nobody left to
 * walk over to. That fixed "a withdrawn entrant is standing on a court" and
 * inherited C1 through the back door: the void's `winner_to_fixture` target
 * then waits forever on a feeder that can never produce a winner. Driven by
 * hand, the final read "Awaiting draw" permanently, `completeStage` returned
 * `{completed: false}`, and the stage could never leave `active`. There was no
 * route back for the organiser — Rebuild refuses a stage that draws from
 * `config.qualified`, and there is no seed proposal to recompute.
 *
 * The fix stamps `bracket.slot.bye` on the dead feeder's target seat and lets
 * `awardSeededByes` + `advanceSettledByes` settle it — NO second settle path.
 * Voids compound into further voids only where BOTH feeders are dead, because
 * a walkover needs a live recipient (the same ruling C2 enforces one round
 * earlier).
 *
 * ...AND IT STAMPS LATE. A seat is stamped at the moment it becomes
 * actionable — the sibling feeder has resolved and the seat is genuinely
 * "live entrant + permanently dead feeder" — never pre-stamped down the
 * forward chain at generation. A withdrawal is a STATUS FLIP and an entrant
 * can be reinstated, so every stamp written ahead of need hardens a state a
 * human could otherwise undo. Same read-time-not-write-time instinct that made
 * the F7 ladder fix safe (`ladder_order` is never pruned precisely because a
 * prune cannot be un-pruned). `dead-feeder-cascade.test.ts`'s "no seat is
 * stamped before its sibling feeder resolves" is what fails if this is ever
 * made eager.
 *
 * Idempotent and re-entrant: every write is guarded on the state it changes
 * (`<> 'bracket.slot.bye'`, `status = 'scheduled'`) and reports through
 * `returning id`, so a second call writes nothing and the loop terminates.
 *
 * THE REVERSE WALK. A seat's feeder is found by inverting the forward-only
 * feed edges. BOTH of them: `winner_to_fixture` and `loser_to_fixture`.
 * Inverting the winner edge alone was review round 5's N1 — the loser edge is
 * intra-stage in four shipped shapes (the double-elimination losers bracket,
 * the grand-final reset, a knockout's third-place playoff, and page_playoff's
 * pp-q2, all from packages/engine/src/scheduling/bracket.ts), so a
 * `double_elim` with ONE ordinary withdrawal left three lines "Awaiting draw"
 * forever and `completeStage` answering `{completed: false}`.
 *
 * Rather than query per seat (`where winner_to_fixture = $1`, which
 * V275__advisor_indexes.sql indexes partially — and it indexes
 * `loser_to_fixture` the same way, so either edge would have been backed) or
 * thread extra columns at generation, this reads the stage's fixtures ONCE per
 * pass — `fixtures_stage_idx` (stage_id, round_no, seq_in_round) — and inverts
 * both edges in memory. The fixpoint loop needs every row anyway to find the
 * seats that became actionable, a bracket stage is tens of rows, and no new
 * column or migration is owed.
 *
 * Each map entry carries WHICH edge seated it, because the two predicates
 * disagree on a walkover: it is a live winner feeder and a dead loser feeder
 * (see `loserFeederIsDead`). The one thing the walk deliberately cannot see is
 * a CROSS-STAGE feeder (wireCrossFeeds): an out-of-stage source is simply not
 * in the map, reads as "no feeder", and is never stamped — which leaves
 * today's behaviour for that shape exactly as it was rather than guessing at
 * it. `dead-feeder-cascade.test.ts`'s "a feeder in ANOTHER stage is invisible
 * to the cascade" pins that in both directions, so the `!f` fallback cannot
 * quietly flip into handing out free walkovers.
 *
 * Returns every fixture id it changed, so the caller can publish them.
 */
export async function resolveBracketSeats(tx: Tx, stageId: string): Promise<string[]> {
  const touched = new Set<string>();
  for (let pass = 0; pass < MAX_CASCADE_PASSES; pass++) {
    const rows = await tx<SeatRow[]>`
      select id, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
             status, outcome, winner_to_fixture, winner_to_slot,
             loser_to_fixture, loser_to_slot, third_place,
             ${hasActiveAbandonSql(tx, "fixtures")} as has_active_abandon,
             exists (select 1 from entrants e
                     where e.id::text = fixtures.outcome ->> 'loser' and e.status in ${tx([...DEPARTED_STATUSES])})
               as loser_withdrawn,
             (fixtures.outcome ->> 'kind' = 'double_walkover'
              and not exists (select 1 from score_events ev
                              where ev.fixture_id = fixtures.id and ev.type <> 'core.void'
                                and not exists (select 1 from score_events v
                                                where v.fixture_id = ev.fixture_id and v.voids_event_id = ev.id)))
               as departed_walkover
      from fixtures where stage_id = ${stageId}`;
    const feederOf = new Map<string, FeederEdge>();
    for (const r of rows) {
      if (r.winner_to_fixture !== null && (r.winner_to_slot === 1 || r.winner_to_slot === 2)) {
        feederOf.set(`${r.winner_to_fixture}:${r.winner_to_slot}`, { row: r, via: "winner" });
      }
      if (r.loser_to_fixture !== null && (r.loser_to_slot === 1 || r.loser_to_slot === 2)) {
        feederOf.set(`${r.loser_to_fixture}:${r.loser_to_slot}`, { row: r, via: "loser" });
      }
    }
    let wrote = 0;
    for (const f of rows) {
      if (f.status !== "scheduled" || f.outcome !== null) continue;
      const openHome = f.home_entrant_id === null;
      const openAway = f.away_entrant_id === null;
      if (!openHome && !openAway) continue;
      // W2b X-WD-3 (plan D17): a seat the withdrawal cascade stamped dead is dead whatever its feeder says — the
      // entrant who held it has left, and nobody else was ever coming to it.
      const byeHome = openHome && f.home_slot_label?.key === BYE_SLOT_LABEL.key;
      const byeAway = openAway && f.away_slot_label?.key === BYE_SLOT_LABEL.key;
      const feedHome = feederOf.get(`${f.id}:1`);
      const feedAway = feederOf.get(`${f.id}:2`);
      const deadHome = openHome && (byeHome || seatFeederIsDead(feedHome));
      const deadAway = openAway && (byeAway || seatFeederIsDead(feedAway));
      if (openHome && openAway) {
        // Nobody is here and nobody is coming: the line is void, and it becomes
        // a dead feeder itself on the next pass. A single dead feeder is NOT
        // enough — the other side is still on its way, and stamping now would
        // be exactly the premature hardening the ruling forbids.
        if (!deadHome || !deadAway) continue;
        if (seatDeparted(byeHome, feedHome, f.third_place) && seatDeparted(byeAway, feedAway, f.third_place)) {
          // W2b X-WD-4: both sides of this line have departed — a double walkover, written as a bye is (no event),
          // which seats nobody and is a dead feeder for the next pass (X-DW-2). A FINAL feeds nothing, and a double
          // walkover needs a next match (D19, X-DW-3): it stays open for W4's vacant title, and nothing is written.
          // (A grand final with a bracket reset feeds only its own rematch, so it is a final too — loop-F I-5.)
          if (!feedsNextMatch(f) && !f.third_place) continue;
          const [walked] = await tx<{ id: string }[]>`
            update fixtures set status = 'forfeited', outcome = ${tx.json({ kind: "double_walkover" } as never)}
            where id = ${f.id} and stage_id = ${stageId}
              and status = 'scheduled' and outcome is null
              and home_entrant_id is null and away_entrant_id is null
            returning id`;
          if (walked) {
            touched.add(walked.id);
            wrote++;
          }
          continue;
        }
        const [voided] = await tx<{ id: string }[]>`
          update fixtures set status = 'abandoned'
          where id = ${f.id} and stage_id = ${stageId}
            and status = 'scheduled' and outcome is null
            and home_entrant_id is null and away_entrant_id is null
          returning id`;
        if (voided) {
          touched.add(voided.id);
          wrote++;
        }
        continue;
      }
      // Exactly one seat is open and the other holds a live entrant (the
      // both-filled case returned above), so if that open seat's feeder is
      // dead there IS someone to award the walkover to. Stamp, and let
      // awardSeededByes below settle it off the label like any other bye.
      const [stamped] = openHome
        ? deadHome
          ? await tx<{ id: string }[]>`
              update fixtures set home_slot_label = ${tx.json(BYE_SLOT_LABEL as never)}
              where id = ${f.id} and stage_id = ${stageId}
                and home_entrant_id is null and status = 'scheduled' and outcome is null
                and coalesce(home_slot_label->>'key', '') <> ${BYE_SLOT_LABEL.key}
              returning id`
          : []
        : deadAway
          ? await tx<{ id: string }[]>`
              update fixtures set away_slot_label = ${tx.json(BYE_SLOT_LABEL as never)}
              where id = ${f.id} and stage_id = ${stageId}
                and away_entrant_id is null and status = 'scheduled' and outcome is null
                and coalesce(away_slot_label->>'key', '') <> ${BYE_SLOT_LABEL.key}
              returning id`
          : [];
      if (stamped) {
        touched.add(stamped.id);
        wrote++;
      }
    }
    // Settle every bye line whose real seat is occupied — the ones just
    // stamped, and any the caller's own writes made ready — then advance their
    // winners. An advance can fill the seat that makes the NEXT round
    // actionable, which is why this is a loop and not a single pass.
    const settled = await awardSeededByes(tx, stageId);
    for (const id of settled) touched.add(id);
    for (const id of await advanceSettledByes(tx, settled)) touched.add(id);
    if (wrote === 0 && settled.length === 0) return [...touched];
  }
  // Deliberately not a typed, localised refusal. This is a runaway guard for a
  // FUTURE bug — reaching it needs a bracket of more than 32 rounds, or a write
  // in the loop above that stops being idempotent — so there is no organiser
  // copy to write for a state the product cannot produce. The message says the
  // score stood because `onDecided` is a POST-COMMIT hook (see scoring.ts's
  // R10 M3 note): the event has already committed by the time the cascade
  // runs, so a throw here 500s a score that is in the database. That is the
  // documented contract for every hook on that path, not something the cascade
  // introduced, and changing it for this one caller alone would split it.
  throw new Error(
    `resolveBracketSeats: stage ${stageId} did not reach a fixed point in ` +
      `${MAX_CASCADE_PASSES} passes. Any score that triggered this HAS been saved — ` +
      `this is a post-commit hook.`,
  );
}