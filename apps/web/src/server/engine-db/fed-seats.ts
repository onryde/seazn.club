import "server-only";
import { advancesNobody, type MatchOutcome } from "@seazn/engine/core";
import type { Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { msg } from "@/lib/messages";
import {
  NEXT_MATCH_STARTED_CODE,
  nextMatchLabel,
  nextMatchStartedMessage,
  type NextMatchRef,
  type RoundCodeRef,
} from "@/lib/next-match-started";
import { boardRoundCodes, type RoundCodeFixture } from "@/components/v2/board/round-codes";
import { clearAwardedMatchState } from "./awarded-state";

// OWNER RULING 2026-09-23 — a write that takes back a knockout decision takes
// back the names that decision advanced.
//
// A decided fixture seats its winner (and, on a `loser_to` edge, its loser) in
// the fixture it feeds, through `fillSlot` (usecases/stages.ts), which only
// ever writes a NULL seat. Nothing emptied one: a void that erased the result
// left the old winner standing in the next round, and re-scoring the match the
// other way ran a fill that touched no row. This is the missing inverse. The
// forward half needs no new code — once the seat is empty again, the ordinary
// fill on the next decision seats whoever wins.
//
// Called INSIDE the append's own transaction (append-event.ts), after the fold
// and BEFORE anything is written, so a refusal here rolls the whole write back:
// the void is never recorded. The staff re-snapshot hatch
// (usecases/admin-fixture-config.ts) is the one other writer that can change a
// stored outcome, and calls it the same way.
//
// The rules, each a clause of the ruling:
//
//  - ONLY WHEN WHO ADVANCES CHANGED. The stored decision's winner (for the
//    winner edge) or loser (for the loser edge) differs from the new fold's —
//    by `advancingSides`, the same reading `onDecided` fills from. That covers
//    a void that erases the decision (the new fold advances nobody) AND, since
//    fix round 1 (controller ruling 2026-09-23), a void that FLIPS the winner
//    without the fold ever passing through undecided (a cricket chase re-scored
//    by voiding a no-ball ends on the same ball with the other side ahead).
//  - SAME STAGE ONLY. A cross-stage edge (`wireCrossFeeds`) is out of scope and
//    keeps exactly its old behaviour: not refused, not emptied.
//  - ONLY A NAME THIS FIXTURE PUT THERE. The seat must hold one of this
//    fixture's two entrants; anyone else is left alone.
//  - NOT STARTED, or REFUSED. The next fixture must be `scheduled`, carry no
//    outcome and hold no live (non-voided) score event. Otherwise the write is
//    refused with 409 NEXT_MATCH_STARTED, naming that match, and the organiser
//    unwinds from the latest match backwards.
//  - EXCEPT A WALKOVER THE CASCADE AWARDED (fix round 1). A next fixture that
//    `resolveBracketSeats` settled on its own — `forfeited`, `{kind: "award"}`,
//    and no live score event, because nobody ever recorded anything on it —
//    has not started in any sense a person would recognise, and there is
//    nothing on it for the organiser to void. It is RESET instead: back to
//    `scheduled` with no outcome, the seat emptied and its label restored,
//    the bye on its dead side left exactly where it is. Re-deciding this line
//    then seats the new winner and the cascade awards the walkover again.
//    Because that walkover itself advanced its winner (`advanceSettledByes`),
//    the reset follows it one more edge, under the same rules — this is the
//    ONE place the un-fill reaches past the fixture one edge away. An award
//    WITH a live event behind it (a withdrawal's `core.forfeit`) is a recorded
//    decision and refuses like any other.
//
// Every seat is planned — and every refusal raised — before any is written, so
// a refusal deep in the chain cannot leave an earlier seat half-undone, though
// the enclosing transaction would roll that back anyway.

interface Node {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
  timing: string | null;
  status: string;
  outcome: unknown;
  live_events: number;
  /** The seats' slot-label keys — a dead seat carries the cascade's bye key (Review Focus 1's revive reads it). */
  home_key: string | null;
  away_key: string | null;
}

type Side = "winner" | "loser";

interface Step {
  target: string;
  slot: 1 | 2;
  /** The name the plan takes back — or null for a seat its departed entrant left DEAD (loop-F I-1): nobody to take
   *  back, only the bye stamp to lift. */
  occupant: string | null;
  /** For an empty seat (`occupant` null): it carries the dead-seat stamp. False only for a seat a dead loser edge fed
   *  into a line the cascade VOIDED — a void stamps nothing (loop-F tidy 2). */
  stamped?: boolean;
  label: { key: string; params: { round: number; seq: number } } | null;
  /** The target is a cascade walkover (or, for a dead seat, a cascade void / departure double walkover) being put back
   *  to `scheduled`. */
  reset: boolean;
}

/** A LEGACY forfeit: a `win` whose method is a forfeit — chess's pre-W2b `boardgame.result{method:"forfeit"}` still
 *  folds to `win{method:"forfeit"}` (the method is retired on write, D15, but a stored stream replays). The same
 *  reading as the engine's own points rule (competition/points.ts `isForfeit`: a win by walkover or forfeit). Its
 *  loser forfeited, exactly like an `award`'s (X-DE-1). */
export function isLegacyForfeitWin(o: { kind?: string; method?: string } | null | undefined): boolean {
  return o?.kind === "win" && (o.method === "forfeit" || o.method === "walkover");
}

/** W2b X-DE-1: a decision that KILLS its loser edge — it names a loser, but that loser forfeited and is out of the
 *  tournament: an `award` (a walkover, retirement, disqualification or withdrawal; a bye names no loser at all), or a
 *  legacy forfeit win. `advancingSides` sends nobody down that edge, and the cascade reads the edge as a dead feeder
 *  (usecases/stages.ts `loserFeederIsDead`, which reads this). */
export function killsLoserEdge(outcome: unknown): boolean {
  const o = outcome as { kind?: string; method?: string } | null | undefined;
  return o?.kind === "award" || isLegacyForfeitWin(o);
}

/** What a stored decision being TAKEN BACK had done down its two edges: who it sent (`advancingSides`), and whether
 *  it left the loser edge dead (`killsLoserEdge`). */
interface TakenBack {
  winner: string | undefined;
  loser: string | undefined;
  loserKilled: boolean;
}
function takenBack(outcome: unknown): TakenBack {
  return { ...advancingSides(outcome), loserKilled: killsLoserEdge(outcome) };
}

/** Who a decision sends onward, per outcome kind (exhaustive over the engine's `OUTCOME_KINDS`; a kind added there
 *  fails this switch's typecheck until it is classified here):
 *  - `win` — the winner, and the loser on a loser edge, unless the loser FORFEITED (a legacy forfeit win);
 *  - `award` — the winner only: a walkover, retirement, disqualification or withdrawal loser is out of the
 *    tournament and never drops to a losers'-bracket or third-place seat (X-DE-1), and a bye has no loser;
 *  - `draw`, `tie`, `no_result` — nobody (held, X-BR-2; a level result never seats, X-BR-1);
 *  - `double_walkover` — nobody (`advancesNobody`, X-DW-2): both sides are out.
 *  `onDecided` (usecases/scoring.ts) fills from exactly this, so the un-fill can never disagree with the fill about
 *  who advanced. No outcome, nobody. */
export function advancingSides(outcome: unknown): { winner: string | undefined; loser: string | undefined } {
  if (outcome === null || outcome === undefined) return { winner: undefined, loser: undefined };
  const o = outcome as MatchOutcome;
  switch (o.kind) {
    case "win":
      return { winner: o.winner, loser: isLegacyForfeitWin(o) ? undefined : o.loser };
    case "award":
      return { winner: o.winner, loser: undefined };
    case "draw":
    case "tie":
    case "no_result":
    case "double_walkover":
      return { winner: undefined, loser: undefined };
    default: {
      // Assumptions are guards: a stored outcome of a kind the engine does not declare is a corrupt row, never "nobody".
      const unknown: never = o;
      throw new Error(`advancingSides: outcome kind ${JSON.stringify((unknown as { kind?: unknown }).kind)} is not an engine OUTCOME_KINDS member`);
    }
  }
}

/** Has the next match started, in the ruling's own three terms. Each is
 *  checked on its own because each can hold alone: a `core.note` leaves a
 *  fixture `scheduled` with a live event; a recorded walkover carries an
 *  outcome with a single `core.forfeit` behind it. */
function hasStarted(t: Node): boolean {
  return t.status !== "scheduled" || t.outcome !== null || t.live_events > 0;
}

/** A walkover the SYSTEM awarded, which nobody played: `awardSeededByes`
 *  writes exactly `forfeited` + `{kind: "award", reason: "bye"}` and no event (W2b C-5; a row stored before W2b
 *  carries no reason) — or, where the dead seat's feeder delivered a winner who has since withdrawn, the same award
 *  naming her as its loser, reason "withdrew" (owner ruling 116), and still no event. A recorded walkover has its `core.forfeit` behind it, which `live_events` sees — so the
 *  award's reason is not read here: it would be a second guard covering for this one, and nothing could kill it. */
function isCascadeWalkover(t: Node): boolean {
  return t.status === "forfeited" && (t.outcome as { kind?: string } | null)?.kind === "award" && t.live_events === 0;
}

/** The bye label the cascade stamps on a dead seat (usecases/stages.ts BYE_SLOT_LABEL — one string, read here). */
const BYE_KEY = "bracket.slot.bye";

/** A line the cascade VOIDED because both its feeders died: `abandoned`, no outcome, no seat, no event. */
function isCascadeVoid(t: Node): boolean {
  return t.status === "abandoned" && t.outcome === null && t.home_entrant_id === null && t.away_entrant_id === null && t.live_events === 0;
}

/** W2b X-WD-4: a DEPARTURE double walkover — written with no event (`writeDepartedSeat`, `resolveBracketSeats`). */
function isDepartureDoubleWalkover(t: Node): boolean {
  return t.status === "forfeited" && (t.outcome as { kind?: string } | null)?.kind === "double_walkover" && t.live_events === 0;
}

/** The seat an edge feeds is EMPTY and stamped dead (`bracket.slot.bye`). */
function seatIsStamped(t: Node, slot: 1 | 2): boolean {
  const occupant = slot === 1 ? t.home_entrant_id : t.away_entrant_id;
  return occupant === null && (slot === 1 ? t.home_key : t.away_key) === BYE_KEY;
}

/** Of `ids`, the entrants who have left the field (`DEPARTED_STATUSES`). */
async function departedOf(tx: Tx, ids: readonly (string | undefined)[]): Promise<Set<string>> {
  const want = ids.filter((id): id is string => id !== undefined);
  if (want.length === 0) return new Set();
  // Imported lazily, as player-stats imports its refresh module: `usecases/entrants` sits ABOVE this file
  // (entrants → stages → … → append-event → here), and a static edge back up made the cycle evaluate in a different
  // order — a module mocked by a test (`@/server/engine-db`) was bound before its factory finished.
  const { DEPARTED_STATUSES } = await import("@/server/usecases/entrants");
  const rows = await tx<{ id: string }[]>`
    select id from entrants where id in ${tx(want)} and status in ${tx([...DEPARTED_STATUSES])}`;
  return new Set(rows.map((r) => r.id));
}

/** The label a fed seat carried BEFORE anything filled it — the same value
 *  the generator wrote, never a new shape.
 *
 *  The plain generator (`generateStageFixtures`' `matchSlotLabel`) stamps
 *  `slot.winner_match` / `slot.loser_match` with the FEEDER's `{round, seq}`.
 *  A `timing: "setup"` progression (`generateProgressionSetupFixtures`) leaves
 *  a sibling-fed seat NULL on purpose, because `fixtureAwaitsSeedDraw`
 *  (lib/division-phase.ts) reads a label beside an empty seat as "this seat
 *  still owes the draw" — stamping one there would put a drawn bracket back
 *  on the desk as "Needs draw". Every renderer names a NULL seat from the feed
 *  edges instead (`feedLabels`), so both read "Winner of R1·2" again. */
function drawnLabel(src: Node, side: Side): Step["label"] {
  if (src.timing === "setup") return null;
  return {
    key: side === "loser" ? "slot.loser_match" : "slot.winner_match",
    params: { round: src.round_no, seq: src.seq_in_round },
  };
}

async function readNode(tx: Tx, id: string): Promise<Node | undefined> {
  const [n] = await tx<Node[]>`
    select f.id, f.stage_id, f.round_no, f.seq_in_round, f.home_entrant_id, f.away_entrant_id,
           f.winner_to_fixture, f.winner_to_slot, f.loser_to_fixture, f.loser_to_slot,
           s.progression ->> 'timing' as timing, f.status, f.outcome,
           f.home_slot_label ->> 'key' as home_key, f.away_slot_label ->> 'key' as away_key,
           (select count(*)::int from score_events e
            where e.fixture_id = f.id and e.type <> 'core.void'
              and not exists (select 1 from score_events v
                              where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)) as live_events
    from fixtures f join stages s on s.id = f.stage_id
    where f.id = ${id}`;
  return n;
}

interface Edge {
  side: Side;
  target: string;
  slot: 1 | 2;
}

/** The feed edges a change to `src` can reach: its winner edge when the winner
 *  moved, its loser edge when the loser did, each only when it is wired. */
function movedEdges(src: Node, moved: Record<Side, boolean>): Edge[] {
  const edges: Edge[] = [];
  const wired = (side: Side, target: string | null, slot: number | null) => {
    if (moved[side] && target !== null && (slot === 1 || slot === 2)) edges.push({ side, target, slot });
  };
  wired("winner", src.winner_to_fixture, src.winner_to_slot);
  wired("loser", src.loser_to_fixture, src.loser_to_slot);
  return edges;
}

/** Every SAME-STAGE fixture the plan below could reach from `src`, read
 *  WITHOUT a lock, into `out` — so the locks can all be taken in one global
 *  order before any of them is judged. A cross-stage target is dropped here,
 *  before it is ever locked (review M3): it is never un-filled, so its lock
 *  would only make this void wait on, or deadlock with, a match in another
 *  stage. `stage_id` never changes on a fixture, so this unlocked read of it is
 *  final. The walk follows a cascade walkover the way the plan does. */
async function reachable(tx: Tx, src: Node, moved: Record<Side, boolean>, out: Map<string, Node>): Promise<void> {
  for (const edge of movedEdges(src, moved)) {
    const t = await readNode(tx, edge.target);
    if (!t || t.stage_id !== src.stage_id || out.has(t.id)) continue;
    out.set(t.id, t);
    if (isCascadeWalkover(t)) {
      const was = advancingSides(t.outcome);
      await reachable(tx, t, { winner: was.winner !== undefined, loser: was.loser !== undefined }, out);
    } else if ((seatIsStamped(t, edge.slot) || edge.side === "loser") && (isCascadeVoid(t) || isDepartureDoubleWalkover(t))) {
      // I-1: a dead line a departed entrant's stamp helped kill revives what IT killed (`planRevive`) — and so does
      // one a dead LOSER edge helped kill (loop-F tidy 2), stamped or not: this walk only over-approximates the plan.
      await reachableRevive(tx, t, out);
    }
  }
}

/** The next match as the SCHEDULE BOARD names it (fix round 2, controller
 *  ruling 2026-09-23): the board's own `boardRoundCodes` over the rows of its
 *  stage — the columns the board reads — with a lookup that RECORDS the
 *  dictionary key it chose instead of rendering it. The code goes out as that
 *  key, with the board's `refSeq` — the number it prints after the code —
 *  so each reader renders it in their own language
 *  (lib/next-match-started.ts); a round the board does not code carries none,
 *  and reads "R2·1" there and here alike. Read only on the way to a refusal. */
async function boardRef(tx: Tx, t: Node): Promise<NextMatchRef> {
  const [stage] = await tx<{ id: string; kind: string }[]>`select id, kind from stages where id = ${t.stage_id}`;
  const rows = await tx<RoundCodeFixture[]>`
    select id, stage_id, round_no, seq_in_round, ext_key, lane, is_final, third_place, conditional
    from fixtures where stage_id = ${t.stage_id}`;
  const recordKey = (key: string, vars?: Record<string, string | number>) => JSON.stringify({ key, params: vars ?? {} });
  const rc = boardRoundCodes(rows, stage ? [stage] : [], recordKey).get(t.id);
  const ref: NextMatchRef = { fixture_id: t.id, round: t.round_no, seq: t.seq_in_round };
  if (rc === undefined) return ref;
  const { key, params } = JSON.parse(rc.code) as Pick<RoundCodeRef, "key" | "params">;
  return { ...ref, code: { key, params, ref_seq: rc.refSeq } };
}

/** W2b D11 (STAGE_SEAT_DEPARTED): a fixture named the way the schedule board names it, for a refusal that must say
 *  WHICH match the organiser records (`boardRef`); null when there is no such fixture. */
export async function fixtureBoardRef(tx: Tx, fixtureId: string): Promise<NextMatchRef | null> {
  const node = await readNode(tx, fixtureId);
  return node ? boardRef(tx, node) : null;
}

/** The SAME lock every append to that fixture takes (append-event.ts), held
 *  to commit. Without it the next match's first event could commit between
 *  the "not started" check and the write after it, and a match in play would
 *  lose a player; with it, that event waits for this transaction and then
 *  finds the seat empty. */
async function lockFixture(tx: Tx, id: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + id}))`;
}

/**
 * W2b Loop R I-2 — the lock every bracket writer that judges a seat by ANOTHER line's stored decision takes, held to
 * commit: the void of a double walkover (`reviveDeadSeats`: what did that double walkover kill?), a decision's cascade
 * (`onDecided` → `fillSlot`, `resolveBracketSeats`: is this seat's feeder dead?) and, since Loop R2 N-2, a
 * withdrawal's no-event seat write (`writeDepartedSeat` → `resolveBracketSeats`). Each held only its own fixture's
 * lock, so the decision could read the double walkover still standing while its void, parked between its read and its
 * commit, had planned nothing — and both committed: the semi live again, the final a no-event walkover.
 *
 * LOCK ORDER (Loop R2 N-1): this lock comes BEFORE any `fixture:` lock, in every writer that takes both — the stage id
 * is read first without a lock (a fixture never changes stage), then this, then the writer's own fixture, then (the
 * void) its targets in bracket order (`releaseFedSeats`' ascending (round_no, id)). The void of a stored double
 * walkover takes it ahead of the append's own fixture lock (`lockStageSeatsForVoid`, append-event.ts); `onDecided`
 * and `writeDepartedSeat` ahead of their own. I-2 first took it AFTER the own fixture lock, and the void then locked its targets
 * after it — so the void of a first-round double walkover held this and asked for a semi's fixture lock while that
 * semi's decision held its fixture lock and asked for this: 40P01, and a decision chosen as the victim seated nobody.
 * Nothing takes this lock while holding a `fixture:` lock, so no cycle runs through it; `reviveDeadSeats` refuses to
 * run without it (`holdsStageSeats`). The two-key form keeps it out of the single-key space every `fixture:` and
 * `division:` lock lives in, so a hash collision can never make it one of those. Not taken by the plain un-fill
 * (`releaseFedSeats`' release path), which holds fixture locks only.
 */
export async function lockStageSeats(tx: Tx, stageId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext('stage-seats'), hashtext(${stageId}))`;
}

/**
 * W2c Task 15 fix round 1 (review M-1) — the format freeze's lock, SHARED (`append-event.ts` takes it so for a first
 * event, `onDecided` for a decision that feeds a seat): taken by a bracket writer that rewrites seats a format save can
 * reshape — a withdrawal's no-event seat write (`writeDepartedSeat`, whose cascade may award a walkover scored under the
 * division's live config) and a take-back that releases or revives what it fed (below; a reset walkover's take-back
 * ledger is refolded, `clearAwardedMatchState`). A format save holding it EXCLUSIVE (`patchDivision`, `putStageRules`)
 * then commits first and these read what it committed, or waits for them and its refusal and award reads see them.
 *
 * LOCK ORDER: after every `fixture:` lock the writer takes (global order `division:` → stage seats → `fixture:` →
 * `division-config:` → rows). An exclusive holder takes no stage-seat or fixture lock after its own, and a shared holder
 * takes no division lock after this one, so no cycle runs through it; two shared holders never wait on each other.
 */
export async function lockDivisionConfigShared(tx: Tx, stageId: string): Promise<void> {
  const [s] = await tx<{ division_id: string }[]>`select division_id from stages where id = ${stageId}`;
  if (s) await tx`select pg_advisory_xact_lock_shared(hashtext(${"division-config:" + s.division_id}))`;
}

/** Loop R2 N-1 — the void's half of the one lock order: a `core.void` of a line whose STORED outcome is a double
 *  walkover feeding a next match may revive what it killed (`reviveDeadSeats`), so it takes the stage lock before the
 *  append's own fixture lock. Read without a lock: a fixture never changes stage, and an outcome that turns into a
 *  double walkover between this read and the append's locked one was written by another append, which the append's
 *  seq check refuses (SEQ_CONFLICT) before anything is revived. Only a void can take back a double walkover — the
 *  engine refuses every other event on a decided match (guarantee 4, `foldMatch`) — so every other append pays no
 *  query here. Returns whether it locked. */
export async function lockStageSeatsForVoid(tx: Tx, fixtureId: string): Promise<boolean> {
  const [f] = await tx<{ stage_id: string; outcome: MatchOutcome | null; feeds: boolean }[]>`
    select stage_id, outcome, (winner_to_fixture is not null or loser_to_fixture is not null) as feeds
      from fixtures where id = ${fixtureId}`;
  if (!f || !f.feeds || !advancesNobody(f.outcome)) return false;
  await lockStageSeats(tx, f.stage_id);
  return true;
}

/** Does THIS transaction hold `lockStageSeats(stageId)`? `pg_locks` shows a two-key advisory lock as classid/objid —
 *  the two int4 keys as unsigned oids — with objsubid 2. */
async function holdsStageSeats(tx: Tx, stageId: string): Promise<boolean> {
  const [{ held }] = await tx<{ held: boolean }[]>`
    select exists (
      select 1 from pg_locks
       where locktype = 'advisory' and pid = pg_backend_pid() and granted and objsubid = 2
         and classid = (hashtext('stage-seats')::bigint & 4294967295)::oid
         and objid = (hashtext(${stageId})::bigint & 4294967295)::oid) as held`;
  return held;
}

/** Plan the seats `src` must give back when its winner and/or loser `moved`,
 *  appending to `plan`; throws the refusal the moment one seat cannot be.
 *  Every node is read here UNDER its lock — `locked` holds the ids already
 *  locked in bracket order by `releaseFedSeats`. */
async function planRelease(
  tx: Tx,
  src: Node,
  moved: Record<Side, boolean>,
  plan: Step[],
  locked: Set<string>,
  revives: Revive[],
  /** What `src`'s TAKEN-BACK decision did down each edge (`takenBack` of the stored outcome). */
  was: TakenBack,
): Promise<void> {
  const mine = new Set([src.home_entrant_id, src.away_entrant_id].filter((id): id is string => id !== null));
  const departed = await departedOf(tx, [was.winner, was.loser]);
  for (const edge of movedEdges(src, moved)) {
    if (!locked.has(edge.target)) {
      // Not reached by the unlocked walk: a cross-stage target (never locked,
      // never touched), or a walkover the cascade awarded in the moment
      // between that walk and the locks. Only the second is locked, late and
      // so out of order — a window a concurrent cascade must hit exactly.
      const peek = await readNode(tx, edge.target);
      if (!peek || peek.stage_id !== src.stage_id) continue;
      await lockFixture(tx, edge.target);
      locked.add(edge.target);
    }
    const t = await readNode(tx, edge.target);
    if (!t) continue;
    const occupant = edge.slot === 1 ? t.home_entrant_id : t.away_entrant_id;
    if (occupant === null) {
      // Loop-F I-1 / R-1: the entrant this decision sent down the edge LEFT, and the seat is stamped dead — by her
      // withdrawal after she was seated (X-WD-3/D17's `writeDepartedSeat`), or by the decision itself when she had
      // already left (`onDecided`'s `stampDepartedSeat`, winner or X-WD-5 loser), or by the cascade walking her
      // opponent over the empty seat — so the seat holds nobody to take back, and the line beyond it may have been
      // settled on her absence. Taking the decision back makes the seat wait for this line again: the stamp is lifted
      // to the drawn label, and the line it fed is revived on the Review Focus 1 path (a cascade walkover reset and what it advanced released; a cascade void or a departure double walkover
      // reset and what IT killed revived) — or, when that next match was recorded, refused NEXT_MATCH_STARTED.
      //
      // Loop-F tidy 2: the same when the taken-back decision ITSELF left this LOSER edge dead — an award or a legacy
      // forfeit win (X-DE-1, `killsLoserEdge`), or a departed loser (X-WD-5) — whoever lost. What sits on the seat was
      // settled on that death: a cascade walkover over the stamped seat, or a cascade VOID when the line's other feed
      // was dead too (a void stamps nothing, so this seat may carry no stamp). Left alone, the replayed line's loser is
      // seated into that settled row — the abandoned void, or the bye award with both seats filled.
      const leaver = edge.side === "winner" ? was.winner : was.loser;
      const stamped = seatIsStamped(t, edge.slot);
      const leaverDeparted = leaver !== undefined && departed.has(leaver);
      const deadLoserEdge = edge.side === "loser" && (was.loserKilled || leaverDeparted);
      if (!(leaverDeparted && stamped) && !deadLoserEdge) continue;
      const lifted = { target: t.id, slot: edge.slot, occupant: null, stamped, label: drawnLabel(src, edge.side) };
      if (isCascadeWalkover(t)) {
        plan.push({ ...lifted, reset: true });
        const gave = takenBack(t.outcome);
        await planRelease(tx, t, { winner: gave.winner !== undefined, loser: gave.loser !== undefined }, plan, locked, revives, gave);
      } else if (isCascadeVoid(t) || isDepartureDoubleWalkover(t)) {
        plan.push({ ...lifted, reset: true });
        await planRevive(tx, t, revives, plan, locked);
      } else if (hasStarted(t)) {
        const ref = await boardRef(tx, t);
        throw new HttpError(409, nextMatchStartedMessage(nextMatchLabel(ref, msg)), NEXT_MATCH_STARTED_CODE, { next_match: ref });
      } else if (stamped) {
        plan.push({ ...lifted, reset: false });
      }
      // (Unstamped, waiting and unstarted: the line is still waiting for this feeder — nothing was settled on it.)
      continue;
    }
    if (!mine.has(occupant)) continue;
    const reset = isCascadeWalkover(t);
    if (!reset && hasStarted(t)) {
      const ref = await boardRef(tx, t);
      throw new HttpError(409, nextMatchStartedMessage(nextMatchLabel(ref, msg)), NEXT_MATCH_STARTED_CODE, { next_match: ref });
    }
    plan.push({ target: t.id, slot: edge.slot, occupant, label: drawnLabel(src, edge.side), reset });
    if (reset) {
      // The walkover goes back to undecided, so whatever IT advanced moves too. (Its dead side stays dead, so it is
      // awarded again and its loser edge stays dead — that edge has nothing to give back.)
      const gave = takenBack(t.outcome);
      await planRelease(tx, t, { winner: gave.winner !== undefined, loser: gave.loser !== undefined }, plan, locked, revives, gave);
    }
  }
}

/** Review Focus 1 (W2b): what a feeder that STOPS advancing nobody gives back. A double walkover killed the seats it
 *  feeds — `resolveBracketSeats` stamped each one a bye beside a seated opponent and walked that opponent over, or
 *  voided the line when its other feeder was dead too. Voiding the double walkover makes the feeder live again, so
 *  each of those is put back to waiting, under the un-fill's own rules:
 *  - a cascade WALKOVER on the seat goes back to `scheduled` with no outcome and the seat's drawn label, and what
 *    the walkover advanced is released in turn (`planRelease`: refused NEXT_MATCH_STARTED if that next match started);
 *  - a cascade VOID line goes back to `scheduled`, and the seats IT killed revive the same way.
 *  A seat this feeder never killed (still waiting, label drawn) is left alone — and the cascade never stamps a bye
 *  without its walkover (`resolveBracketSeats` stamps only beside a seated entrant, then `awardSeededByes` settles
 *  it in the same pass), so a stamped seat a revive reaches is always the walkover case. The one stamp at rest is a
 *  withdrawal's (X-WD-3, `writeDepartedSeat`): her own seat, which no feeder killed and no revive reaches.
 *  W2b X-WD-4's DEPARTURE double walkover (`resolveBracketSeats`' `seatDeparted`) is never revived: every feed it is
 *  written from — a withdrawal's stamp, another departure double walkover — carries no event a void could target,
 *  and a RECORDED double walkover beside a dead seat makes a cascade void (above), not one. */
interface Revive {
  target: string;
  slot: 1 | 2;
  label: Step["label"];
  kind: "walkover" | "void";
}

async function reachableRevive(tx: Tx, src: Node, out: Map<string, Node>): Promise<void> {
  for (const edge of movedEdges(src, { winner: true, loser: true })) {
    const t = await readNode(tx, edge.target);
    if (!t || t.stage_id !== src.stage_id || out.has(t.id)) continue;
    out.set(t.id, t);
    if (isCascadeWalkover(t)) await reachable(tx, t, { winner: true, loser: false }, out);
    else if (isCascadeVoid(t)) await reachableRevive(tx, t, out);
  }
}

async function planRevive(tx: Tx, src: Node, revives: Revive[], plan: Step[], locked: Set<string>): Promise<void> {
  for (const edge of movedEdges(src, { winner: true, loser: true })) {
    if (!locked.has(edge.target)) continue; // cross-stage (never reached, never touched)
    const t = await readNode(tx, edge.target);
    if (!t) continue;
    const occupant = edge.slot === 1 ? t.home_entrant_id : t.away_entrant_id;
    const label = edge.slot === 1 ? t.home_key : t.away_key;
    if (occupant !== null) continue; // a feeder that advanced nobody seated nobody (D20 asserts it)
    if (isCascadeVoid(t)) {
      // The seat the reviving feeder fed goes back to its drawn label; a seat the line's OTHER side left dead (a
      // withdrawal's stamp, X-WD-3) keeps its stamp, so the line waits for this side only.
      revives.push({ target: t.id, slot: edge.slot, label: drawnLabel(src, edge.side), kind: "void" });
      await planRevive(tx, t, revives, plan, locked);
      continue;
    }
    if (label === BYE_KEY && isCascadeWalkover(t)) {
      revives.push({ target: t.id, slot: edge.slot, label: drawnLabel(src, edge.side), kind: "walkover" });
      await planRelease(tx, t, { winner: true, loser: false }, plan, locked, revives, takenBack(t.outcome));
    }
  }
}

/** THE one fixture-lock order across a bracket (review M1, below): ascending (round_no, id). Every writer that locks
 *  more than one fixture of a stage takes them in this order — the fed-seat release and revive here, and the batch
 *  override writer (`fixture-rules.ts`, W2c Task 14) — so no two of them can each hold a lock the other asks for. */
export const bracketOrder = (a: { round_no: number; id: string }, b: { round_no: number; id: string }): number =>
  a.round_no - b.round_no || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Give back the seats `fixtureId`'s stored decision (`before`) had filled and
 * its new fold (`after`) no longer fills, or refuse.
 *
 * A no-op — not one query — unless there WAS a stored decision and who it
 * advances changed, so the hot append path pays nothing for an ordinary event.
 * One more case since W2b (Review Focus 1): a stored double walkover the new
 * fold no longer holds revives the seats it killed (`reviveDeadSeats`).
 *
 * Returns the ids of the fixtures it actually changed — from each update's own
 * `returning id`, never re-derived — so a caller can publish exactly what
 * changed (the same contract `fillSlot`'s callers rely on).
 *
 * @throws HttpError 409 NEXT_MATCH_STARTED when a seat it would empty belongs
 *   to a match that has already started.
 */
export async function releaseFedSeats(
  tx: Tx,
  fixtureId: string,
  before: unknown,
  after: unknown,
): Promise<string[]> {
  if (before === null || before === undefined) return [];
  // Review Focus 1: a double walkover taken back (voided) revives the seats it killed.
  if (advancesNobody(before as MatchOutcome) && !advancesNobody(after as MatchOutcome | null)) return reviveDeadSeats(tx, fixtureId);
  const was = takenBack(before);
  const now = takenBack(after);
  // Loop-F tidy 2: the loser edge MOVED when the decision that left it dead (an award, a legacy forfeit win) is taken
  // back — `advancingSides` reads "nobody" down it both before and after, but the cascade settled its target on that
  // death, and the release must give that back (`planRelease`).
  const moved = { winner: was.winner !== now.winner, loser: was.loser !== now.loser || was.loserKilled !== now.loserKilled };
  if (!moved.winner && !moved.loser) return [];
  const src = await readNode(tx, fixtureId);
  if (!src) return [];

  // LOCK ORDER (review M1). This transaction already holds `src`'s own lock —
  // the append took it first. Taking the targets edge by edge (winner, then
  // loser) deadlocked a page playoff: pp-q1's void took the final, then queued
  // on pp-q2, while pp-q2's void held pp-q2 and queued on the final; a double
  // elimination's winners' final and losers' final do the same over the grand
  // final. So every target is found first without a lock, then locked in ONE
  // global order — ascending (round_no, id). Every generator numbers rounds so
  // a feed edge always points to a LATER round (bracket.ts: a double
  // elimination's losers' lane is numbered after the winners' lane), so that
  // order is also bracket order: a transaction never holds a later match's
  // lock while it asks for an earlier one's, including the source lock it
  // started with. That is what rules the cycle out.
  const reach = new Map<string, Node>();
  await reachable(tx, src, moved, reach);
  const order = [...reach.values()].sort(bracketOrder);
  for (const t of order) await lockFixture(tx, t.id);
  // Fix round 1 (M-1): a take-back that reaches a seat it fed waits for a format save in flight, after every fixture lock.
  if (order.length > 0) await lockDivisionConfigShared(tx, src.stage_id);

  const plan: Step[] = [];
  const revives: Revive[] = [];
  await planRelease(tx, src, moved, plan, new Set(reach.keys()), revives, was);
  const changed = await writePlan(tx, plan);
  for (const id of await writeRevives(tx, revives)) if (!changed.includes(id)) changed.push(id);
  return changed;
}

/** Write a planned release, each update guarded on the occupant the plan saw; the ids it changed. */
async function writePlan(tx: Tx, plan: readonly Step[]): Promise<string[]> {
  const released: string[] = [];
  for (const p of plan) {
    const json = p.label === null ? null : tx.json(p.label as never);
    const seatCol = p.slot === 1 ? tx`home_entrant_id` : tx`away_entrant_id`;
    const labelCol = p.slot === 1 ? tx`home_slot_label` : tx`away_slot_label`;
    // Guarded on the occupant the plan saw, so the write can only ever take
    // back the name it was judged on — or, for a dead seat (I-1), on the seat still being empty and stamped.
    const seated =
      p.occupant !== null
        ? tx`${seatCol} = ${p.occupant}`
        : p.stamped === false
          ? tx`${seatCol} is null`
          : tx`${seatCol} is null and ${labelCol} ->> 'key' = ${BYE_KEY}`;
    const [row] = p.reset
      ? await tx<{ id: string }[]>`
          update fixtures set ${seatCol} = null, ${labelCol} = ${json}, status = 'scheduled', outcome = null
          where id = ${p.target} and ${seated} returning id`
      : await tx<{ id: string }[]>`
          update fixtures set ${seatCol} = null, ${labelCol} = ${json}
          where id = ${p.target} and ${seated} returning id`;
    // R116-2: a reset award takes the score written beside it (ruling 116's walkover).
    if (row && p.reset) await clearAwardedMatchState(tx, row.id);
    if (row && !released.includes(row.id)) released.push(row.id);
  }
  return released;
}

/** Review Focus 1's write path: plan every revive (and every release a reset walkover owes) under the locks, in the
 *  un-fill's one global order, then write. Same refusal contract as `releaseFedSeats`: a started next match refuses
 *  the whole write (409 NEXT_MATCH_STARTED) before anything is written. */
async function reviveDeadSeats(tx: Tx, fixtureId: string): Promise<string[]> {
  const src = await readNode(tx, fixtureId);
  if (!src) return [];
  // Nothing in this stage to revive: a line that feeds no next match (a league's, a group's — X-DW-4 records and counts
  // it) or only another stage's (never reached, never touched). Read before the guard: a feed edge and its target's
  // stage are structure, not a seat — and `lockStageSeatsForVoid` took no lock for a line that feeds nothing.
  const [{ own }] = await tx<{ own: number }[]>`
    select count(*)::int as own from fixtures
     where id in (${src.winner_to_fixture ?? src.id}, ${src.loser_to_fixture ?? src.id}) and id <> ${src.id}
       and stage_id = ${src.stage_id}`;
  if (own === 0) return [];
  // I-2: before the first read of a seat this double walkover killed — a sibling's decision must not judge it dead
  // while this void is in flight, nor this void judge it before that decision's cascade has committed. N-1: taken by
  // the caller BEFORE its own fixture lock (`lockStageSeatsForVoid`), never here — taking it now, behind a fixture
  // lock, is the order that deadlocks against a decision.
  if (!(await holdsStageSeats(tx, src.stage_id))) {
    throw new Error(
      `reviveDeadSeats: fixture ${fixtureId} revives without the stage lock — take lockStageSeats before the fixture lock (Loop R2 N-1)`,
    );
  }
  const reach = new Map<string, Node>();
  await reachableRevive(tx, src, reach);
  const order = [...reach.values()].sort(bracketOrder);
  for (const t of order) await lockFixture(tx, t.id);
  // Fix round 1 (M-1): as the release above — a revive waits for a format save in flight, after every fixture lock.
  if (order.length > 0) await lockDivisionConfigShared(tx, src.stage_id);
  const revives: Revive[] = [];
  const plan: Step[] = [];
  await planRevive(tx, src, revives, plan, new Set(reach.keys()));
  const changed = await writeRevives(tx, revives);
  for (const id of await writePlan(tx, plan)) if (!changed.includes(id)) changed.push(id);
  return changed;
}

/** Write planned revives (Review Focus 1), each guarded on the dead shape the plan judged; the ids it changed.
 *  A walkover revive also matches a row already back at `scheduled`: the release's own `writePlan` (which runs first,
 *  in `releaseFedSeats`) may have just reset that same walkover through its OTHER seat — page_playoff's final, reset
 *  through q1's winner edge while q2's void, revived through q1's dead loser edge, lifts the final's stamp (loop-F
 *  tidy 2). Nothing else writes it under these locks, so `scheduled` here is this transaction's own reset. */
async function writeRevives(tx: Tx, revives: readonly Revive[]): Promise<string[]> {
  const changed: string[] = [];
  for (const r of revives) {
    const json = r.label === null ? null : tx.json(r.label as never);
    const seatCol = r.slot === 1 ? tx`home_entrant_id` : tx`away_entrant_id`;
    const labelCol = r.slot === 1 ? tx`home_slot_label` : tx`away_slot_label`;
    const [row] =
      r.kind === "walkover"
        ? await tx<{ id: string }[]>`
            update fixtures set ${labelCol} = ${json}, status = 'scheduled', outcome = null
            where id = ${r.target} and ${seatCol} is null and ${labelCol} ->> 'key' = ${BYE_KEY}
              and status in ('forfeited', 'scheduled') returning id`
        : await tx<{ id: string }[]>`
            update fixtures set ${labelCol} = ${json}, status = 'scheduled'
            where id = ${r.target} and ${seatCol} is null and status = 'abandoned' and outcome is null returning id`;
    if (row && !changed.includes(row.id)) changed.push(row.id);
  }
  return changed;
}
