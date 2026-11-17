import "server-only";
// Mid-tournament withdrawal (spec 05 §5, wired per organiser ask 2026-07-10).
// The pure policies live in @seazn/engine/competition/stage:
//   - table stages (league/group/swiss): played < 50% of their fixtures →
//     EXPUNGE (every game they touched voids; standings read as if they never
//     entered); otherwise their remaining games walk over to the opponents.
//     Swiss NEVER expunges (owner ruling 2026-09-24): played results stand and
//     every paired board walks over — an expunged Swiss board stranded the
//     division. The per-kind rule is the engine's `withdrawTableEntrant`.
//   - brackets (knockout/double_elim/stepladder, and since W2b X-WD-2
//     page_playoff and ladder — `WITHDRAWAL_WALKOVER_KINDS`): opponents
//     advance by walkover, whatever state the line is in (W2b spec §5.4):
//     a held level result (X-WD-1), a chess tie-break (R14) and a
//     scorer-abandoned line (D-G2 corner 1, its abandon voided first) all
//     walk over with retirement credit; a TBD opponent gets a dead seat
//     (X-WD-3, plan D17); both sides gone is a double walkover (X-WD-4).
//   - americano (and mexicano): an americano's fixtures name per-round PAIR entrants minted from the individuals
//     (`pairEntrantsFor`, stages/generators.ts), so the withdrawn player is on a fixture only through the pairs that
//     hold their person (`americanoPairsHolding`). Their UNPLAYED matches void (expunged); their played results stand
//     and the personal points they earned stay on the leaderboard. The engine declares no americano policy of its
//     own; this is the controller's PO call of 2026-11-18, reported as `policy: "expunge"` (the writer is the same).
// The surgery itself rides the scoring ledger — core.forfeit{reason:
// "withdrew"} for walkovers, core.void + core.abandon{expunge: true} for
// expunges (D5) — so standings recompute, undo works and the public cache
// invalidates exactly like any other scoring write. Two writes carry no event,
// as `awardSeededByes` writes a bye: the dead seat and the double walkover
// (`writeDepartedSeat`, stages/bracket-seats.ts). Every ledger write names its writer
// (`withdrawal_cascade`): PF-2 refuses `withdrew` and `expunge` from anyone
// else. Not one transaction (ruling 101): each write commits on its own.
// W5 T8 (ST-G15, RB5-W2): a FINALIZED fixture under the expunge is removed like any other result — its finalize voided
// first (the one append a finalized ledger admits, append-event.ts `cascadeReopensFinalize`), then its results, then the
// expunge abandon, so ruling 105's auto-advance reads it as closed. A `cancelled` fixture is still left as it is, and
// reported. A league or group settled here leaves one `table_withdrawal` row in the division ledger (the footnote's count,
// RB5-W7), and Reinstate reverses the cascade's own events there (`reinstateTableEntrant`, RB5-W6).
import { EngineError, deciderPending, playRecorded } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import {
  withdrawBracketEntrant,
  withdrawTableEntrant,
  type BracketFixture,
  type FixtureUpdate,
} from "@seazn/engine/competition";
import { feedsNextMatch } from "@/lib/bracket-next-match";
import { FIELD_ENTRANT_STATUSES as FIELD_STATUSES, inTheField } from "@/lib/entrant-field";
import { randomUUID } from "node:crypto";
import { sql, withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { resolveModule } from "@/server/engine-db/registry";
import type { CascadeWriter } from "@/server/engine-db/append-event";
import { rowAwaitsSettle } from "@/server/engine-db/recorded-abandon";
import {
  WITHDRAWAL_PENDING_STATUSES,
  WITHDRAWAL_PLAYED_STATUSES,
  countsAsPlayed,
  tableWithdrawalInputs,
  type WithdrawalFixtureRow,
} from "@/lib/table-withdrawal";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { BOARD_SETTLED_REASON } from "@/server/email-outbox/cancel";
import { cancelBoardInvites } from "./external-play/cancel-invites";
import { DEPARTED_STATUSES, getEntrant, listEntrants, writeEntrantPatch } from "./entrants";
import {
  PAIR_DISSOLVE_OWED_ROW,
  TABLE_WITHDRAWAL_LINE_ROW,
  TABLE_WITHDRAWAL_LINE_VOIDED_ROW,
  TABLE_WITHDRAWAL_ROW,
  TABLE_WITHDRAWAL_VOIDED_ROW,
  WITHDRAWAL_REINSTATED_ROW,
  activeTableWithdrawals,
  type TableWithdrawalPolicy,
} from "@/lib/table-withdrawal-note";
import { getDivision } from "./divisions";
import { BRACKET_WALKOVER_KINDS, divisionHasStarted, listStages, refoldStageTable, reproposeStaleDependents, staleConfirmedProposalsOfDeparting, writeDepartedSeat } from "./stages";
import { listDivisionFixtures, listEvents, getFixtureState, type EventOut } from "./fixtures";
import { invalidatePublicCache, maybeAutoAdvance, scoreEvent } from "./scoring";
import { replaceDepartedQualifier } from "./lucky-loser";
import { afterScheduleWrite } from "./schedule";

const TABLE_KINDS = new Set(["league", "group", "swiss"]);

/** W5 T8b Part 3 (ruling 289): what a table withdrawal decides for one stage — the engine's `withdrawTableEntrant` over the ONE
 *  reading of the rows (`tableWithdrawalInputs`). */
export interface TableWithdrawalDecision {
  /** RB5-W2: under half played → `expunge` (every result removed, the rest void); RB5-W3, and every Swiss → `walkover`. */
  mode: "expunge" | "walkover";
  /** RB5-W4: lines with a recorded result. */
  played: number;
  /** played + pending: the lines the 50 percent rule is counted against (a cancelled line is neither). */
  scheduled: number;
  /** The lines still to play, each with the opponent's id ("" for a seat not yet filled). */
  pending: { id: string; opponent: string }[];
  /** The engine's settles, in its order. */
  updates: FixtureUpdate[];
}

/**
 * The table withdrawal's decision for `entrantId` in one league, group or Swiss stage, from the rows of that stage that seat
 * her. Pure. The cascade APPLIES it (`withdrawEntrantCascade`) and the Disqualify confirmation PREVIEWS it
 * (`withdrawal-preview.ts`) — one decision, two readers, so the copy's count is the count the rule then acts on.
 */
export function decideTableWithdrawal(
  stage: { id: string; kind: "league" | "group" | "swiss" },
  entrantId: string,
  mine: readonly WithdrawalFixtureRow[],
): TableWithdrawalDecision {
  const { played, pending } = tableWithdrawalInputs(entrantId, mine);
  // The policy only counts involvement: it reads the stage's id and kind alone (W2d T8 narrowed its parameter to those two).
  const result = withdrawTableEntrant(stage, entrantId, { played, pending });
  const mode = result.events[0]?.type === "entrant_withdrawn" ? result.events[0].mode : undefined;
  return {
    mode: mode === "expunge" ? "expunge" : "walkover",
    played: played.length,
    scheduled: played.length + pending.length,
    pending,
    updates: result.updates,
  };
}
/** W5 T8: the round-robin tables whose withdrawal is written to the ledger for the footnote (RB5-W7) and reversed by Reinstate
 *  (RB5-W6). A Swiss withdrawal always walks over (owner ruling 2026-09-24) and its own Reinstate is W3's, so it is not one. */
const ROUND_ROBIN_KINDS: ReadonlySet<string> = new Set(["league", "group"]);
/** W2b X-WD-2 (plan premise 19): the kinds a withdrawal walks over. `BRACKET_WALKOVER_KINDS` also gates F14's
 *  departed-qualifier draw at generation, which the spec does not change for page_playoff or ladder — so the
 *  withdrawal path has its own superset instead of widening that one. */
export const WITHDRAWAL_WALKOVER_KINDS: ReadonlySet<string> = new Set([...BRACKET_WALKOVER_KINDS, "page_playoff", "ladder"]);
// The table policy's reading of DB statuses — shared with the qualification
// builder so the two cannot disagree about who a departure would expunge.
const SETTLED = WITHDRAWAL_PLAYED_STATUSES;
const PENDING = WITHDRAWAL_PENDING_STATUSES;

/** A bracket fixture's status as the engine's withdrawal planner reads it. Every fixtures.status is named; an unknown
 *  one throws (review N4, as `engineFixtureStatus` does) rather than silently reading as "void".
 *
 *  W2b (spec §5.4, R8/R14; C-2): there are no holds any more. "scheduled" is a line the planner hands to the remaining
 *  side, and three W2a holds are now exactly that — a held level result (X-WD-1), a chess tie-break pending (R14: it
 *  is `in_play`, and the engine admits `withdrew` in every phase but "over") and a scorer-abandoned, unsettled line
 *  (D-G2 corner 1: `applyUpdate` voids its abandon first, so the pre-abandon score stands). `activeAbandon` tells that
 *  last one from the cascade's own void (abandoned, no event), which is dead already and walks nobody over. The D-R1
 *  contradiction throw went with the hold: a pending decider no longer changes the mapping. */
export function bracketWithdrawalStatus(status: string, activeAbandon: boolean): "decided" | "scheduled" | "void" {
  if (SETTLED.has(status)) return "decided";
  if (PENDING.has(status)) return "scheduled";
  switch (status) {
    case "needs_decision":
      return "scheduled";
    case "abandoned":
      return activeAbandon ? "scheduled" : "void";
    case "cancelled":
      return "void";
    default:
      throw new Error(`bracketWithdrawalStatus: unknown fixtures.status "${status}"`);
  }
}
/** The closed forfeit reason (engine `FORFEIT_REASONS`; finding 14: the English "entrant withdrew" is refused by the
 *  strict schema) — also the abandon reason of an expunge. */
const REASON = "withdrew";
const CASCADE = { writer: "withdrawal_cascade" } as const;

/** Was this line HELD when its entrant withdrew — `walked_over_held` counts what used to wait for a settle: a held
 *  level result, a tie-break still owed (the engine's own `deciderPending` over the stored fold; an `in_play` row
 *  carries no active settle, which folds to `decided`), or a scorer's abandon. */
async function deciderOwed(auth: AuthCtx, sportModule: AnySportModule, fixtureId: string): Promise<boolean> {
  const { state } = await getFixtureState(auth, fixtureId);
  return deciderPending(sportModule as never, { state: state as never, settlement: null });
}

/** Loop R M-5 — a both-gone line's ledger, read twice over:
 *  - `played`: has anything been PLAYED — the engine's own `playRecorded` (ruling 112: a bare Start is not play; ruling
 *    118: chess's Start is), the reading the fold's phase guard judges a walkover by;
 *  - `live`: does it hold any live event at all — one that is neither a void nor voided. That is `writeDepartedSeat`'s
 *    own guard: the departure's no-event write is refused over any of them, a bare Start included. */
async function lineLedger(
  auth: AuthCtx,
  sportModule: AnySportModule,
  fixtureId: string,
): Promise<{ played: boolean; live: boolean; events: EventOut[] }> {
  const events = await listEvents(auth, fixtureId, 0);
  const voided = new Set(events.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id as string));
  return {
    played: playRecorded(events.map((e) => ({ id: e.id, type: e.type, voids: e.voids_event_id })), sportModule),
    live: events.some((e) => e.type !== "core.void" && !voided.has(e.id)),
    events,
  };
}

/** X-WD-4 over a ledger with nothing played on it, written as the console's double walkover is: `core.forfeit{by:
 *  "both", reason: "walkover"}` through the ordinary write (a walkover is admitted while nothing is played, ruling
 *  112). An active scorer's abandon is voided first — a forfeit over it is refused (D4), as `applyUpdate` does for a
 *  withdrawal's walkover (D-G2 corner 1). */
async function recordDoubleWalkover(auth: AuthCtx, fixtureId: string, events: readonly EventOut[]): Promise<void> {
  for (const abandon of activeAbandons(events)) {
    const state = await getFixtureState(auth, fixtureId);
    await scoreEvent(auth, fixtureId, { expected_seq: state.last_seq, type: "core.void", payload: { event_id: abandon.id } }, CASCADE);
  }
  const state = await getFixtureState(auth, fixtureId);
  await scoreEvent(
    auth,
    fixtureId,
    { expected_seq: state.last_seq, type: "core.forfeit", payload: { by: "both", reason: "walkover" } },
    CASCADE,
  );
}

/** The ACTIVE abandons in a ledger: a `core.abandon` no `core.void` targets (voids are not voidable). */
function activeAbandons(events: readonly EventOut[]): EventOut[] {
  const voided = new Set(events.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id as string));
  return events.filter((e) => e.type === "core.abandon" && !voided.has(e.id));
}

/** The `pair` entrants of an americano division whose members include a person the withdrawn individual IS: the
 *  per-round pairs (`pairEntrantsFor`) that carry them onto a fixture. Read only for a division with an americano
 *  stage - a real doubles pair in any other stage is the entrant's own and is matched by its own id. */
async function americanoPairsHolding(auth: AuthCtx, divisionId: string, entrantId: string): Promise<Set<string>> {
  const rows = await withTenant(auth.orgId, (tx) => tx<{ id: string }[]>`
    select distinct e.id from entrants e
    join entrant_members em on em.entrant_id = e.id
    where e.division_id = ${divisionId} and e.kind = 'pair'
      and em.person_id in (select person_id from entrant_members where entrant_id = ${entrantId})`);
  return new Set(rows.map((r) => r.id));
}

export interface WithdrawCascadeOut {
  entrant_id: string;
  /** The status the cascade wrote: `withdrawn`, or `disqualified` when a disqualification routed here (W3 T15, RB3-17:
   *  "disqualification = withdrawal from that moment"). The settling is the same for both. */
  status: "withdrawn" | "disqualified";
  /** Which policy the engine picked per spec 05 §5. */
  policy: "none" | "walkover" | "expunge";
  walkovers: number;
  voided: number;
  /** W5 T8 (ST-G15): the CANCELLED fixtures of theirs, left as they are — listed so the organiser knows. A finalized one is
   *  no longer skipped: under the expunge its result is removed like any other (RB5-W2). */
  skipped_cancelled: number;
  /** W2b: of `walkovers`, the lines that were HELD (a level result, a tie-break owed, a scorer's abandon) — each was
   *  waiting for the organiser's settle under W2a, and is walked over now (merge notice N1). */
  walked_over_held: number;
  /** Loop R M-5: the fixtures both of whose sides have now gone (X-WD-4) but where play was recorded (`playRecorded`) —
   *  written nothing, never overwritten: each is the organiser's ledger to void or settle. W2c X-AB-5: and a table
   *  stage's board of theirs that was ABANDONED with no result (a Swiss board holds the next round) - left as it stands,
   *  still owed the organiser's settle (the opponent can be chosen; the departed entrant cannot, C17). */
  left_to_organiser: string[];
  /** W4 T13 (RB4-V2, X-LL-1): the lucky loser who took her main-draw round-1 seat, and that line; null when none did
   *  (no such seat, the line had started, or nobody was eligible — the line walked over as before). */
  lucky_loser: { entrant_id: string; fixture_id: string } | null;
}

interface FixtureRowLite {
  id: string;
  stage_id: string;
  pool_id?: string | null;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
  winner_to_fixture: string | null;
  loser_to_fixture: string | null;
  /** The bracket-role flags (V368), carried by `listDivisionFixtures` rows. */
  is_final?: boolean;
  third_place?: boolean;
}

/** The line's active result events, newest first — what an expunge removes: every effective (not-yet-voided) state-bearing
 *  event. Newest first, so on a finalized ledger the `core.finalize` (always its newest event: a locked ledger takes no other)
 *  is the first void — the cascade's, which is the one append the lock admits (append-event.ts `cascadeReopensFinalize`). */
function resultEventsOf(events: readonly EventOut[]): EventOut[] {
  const voidedIds = new Set(events.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id as string));
  return events
    .filter((e) => !["core.start", "core.void", "core.note", "core.award"].includes(e.type) && !voidedIds.has(e.id))
    .sort((a, b) => b.seq - a.seq);
}

/** Whose cascade is settling the line, and in which division: the owner a write-ahead row names. */
interface LineOwner {
  divisionId: string;
  entrantId: string;
}

/**
 * Task 8b re-review 2 (ruling C): the expunge of ONE line, write-ahead. Before anything on the line is touched, its
 * `table_withdrawal_line` row is committed in its own transaction: the entrant, the line, the events this expunge is about to
 * remove (`planned_void_ids` — the line's active result events at this moment, read under the per-entrant cascade lock; none
 * on a line with no result) and the line's tip (`from_seq`: the expunge abandon it writes is the first after it). Then each
 * planned event is voided, newest first, then the abandon. A resume and a Reinstate read ONLY these rows to take an expunge
 * back (`takeBackLines`), so a scorer's own Undo before the withdrawal is never taken for the cascade's.
 *
 * Between the row and the voids a scorer can still write (the lock holds cascades, not the pad). An event appended there is
 * not in the plan and stays as it is: it is not voided, the abandon lands over it (an expunged line reads no result either
 * way), and nothing re-records it. At a Reinstate it is still there, ahead of the re-recorded events; one that lands between
 * two of the cascade's voids falls after them, so `rerecordRemoved` reads the line as rescored-since and NAMES it in
 * `not_restored` rather than merge. A planned event the scorer voids in that window is still in the plan and voided, so a
 * Reinstate puts it back — the one case the row cannot tell apart (recorded, accepted: the window is one line's writes).
 */
async function expungeLine(auth: AuthCtx, owner: LineOwner, fixture: FixtureRowLite, hasResult: boolean): Promise<void> {
  const events = await listEvents(auth, fixture.id, 0);
  const planned = hasResult ? resultEventsOf(events) : [];
  await withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + owner.divisionId}))`;
    await appendTableLedgerRow(
      tx,
      owner.divisionId,
      TABLE_WITHDRAWAL_LINE_ROW,
      {
        entrant_id: owner.entrantId,
        stage_id: fixture.stage_id,
        fixture_id: fixture.id,
        planned_void_ids: planned.map((e) => e.id),
        from_seq: events.reduce((m, e) => Math.max(m, e.seq), 0),
      },
      auth.userId,
    );
  });
  for (const target of planned) {
    const state = await getFixtureState(auth, fixture.id);
    await scoreEvent(
      auth,
      fixture.id,
      { expected_seq: state.last_seq, type: "core.void", payload: { event_id: target.id } },
      CASCADE,
    );
  }
  await expungeAbandon(auth, fixture.id);
}

/** D5 / PF-4: an expunge's abandon carries `expunge: true`, so the match leaves the table entirely (`outcomeOf` reads
 *  null while it is active) — without it a sport whose abandon folds to a RESULT credits the table (cricket's no
 *  result, a football award policy). Both expunge writers come through here. */
async function expungeAbandon(auth: AuthCtx, fixtureId: string): Promise<void> {
  const state = await getFixtureState(auth, fixtureId);
  await scoreEvent(
    auth,
    fixtureId,
    { expected_seq: state.last_seq, type: "core.abandon", payload: { reason: REASON, expunge: true } },
    CASCADE,
  );
}

async function applyUpdate(
  auth: AuthCtx,
  update: FixtureUpdate & { walkoverBy?: string },
  fixture: FixtureRowLite,
  out: WithdrawCascadeOut,
  held: boolean,
  owner: LineOwner,
): Promise<void> {
  // W5 T8 (ST-G15): no status is skipped here any more. A finalized line reaches the void below like any settled result (the
  // engine hands a played fixture only a "void"); a cancelled one is never planned (neither played nor pending, and a
  // bracket reads it as "void") and is counted where the lines are read. Either, handed a walkover, meets the ledger's lock
  // (append-event.ts) and throws — loudly, never a silent skip.
  if (update.status === "walkover" && update.walkoverTo !== undefined && update.walkoverBy) {
    // D-G2 corner 1 (X-AB-4's void-then-forfeit): a forfeit over an active abandon is refused (D4,
    // ABANDONED_SETTLE_OR_VOID), so the abandon is voided first — the score recorded before it stands.
    if (fixture.status === "abandoned") {
      for (const abandon of activeAbandons(await listEvents(auth, fixture.id, 0))) {
        const state = await getFixtureState(auth, fixture.id);
        await scoreEvent(auth, fixture.id, { expected_seq: state.last_seq, type: "core.void", payload: { event_id: abandon.id } }, CASCADE);
      }
    }
    // No `core.start` first: `withdrew` is legal in every phase but "over" (R5), so an unstarted board forfeits as is.
    const state = await getFixtureState(auth, fixture.id);
    await scoreEvent(
      auth,
      fixture.id,
      { expected_seq: state.last_seq, type: "core.forfeit", payload: { by: update.walkoverBy, reason: REASON } },
      CASCADE,
    );
    out.walkovers++;
    if (held) out.walked_over_held++;
    return;
  }
  // void — pending fixtures abandon directly; resulted ones expunge first. Either way the line's write-ahead row goes first.
  // B3 I-5: an abandoned line with a result is played too (`countsAsPlayed`), so its abandon is among the events removed.
  await expungeLine(auth, owner, fixture, countsAsPlayed(fixture));
  out.voided++;
}

/** X-CH-3's scope: the deciding final of a KNOCKOUT - `is_final`, never a third-place match - which feeds no next match
 *  (the caller has asked `feedsNextMatch`). */
function isDecidingFinalOfKnockout(step: { fixture: FixtureRowLite; bracket?: { kind: string } }): boolean {
  return step.bracket?.kind === "knockout" && step.fixture.is_final === true && step.fixture.third_place !== true;
}

/** X-TP-7's scope: the third-place match of a KNOCKOUT (`third_place`), which feeds no next match. */
function isThirdPlaceOfKnockout(step: { fixture: FixtureRowLite; bracket?: { kind: string } }): boolean {
  return step.bracket?.kind === "knockout" && step.fixture.third_place === true;
}

/** X-WD-3 / X-WD-4's no-event writes (`writeDepartedSeat`), committed on their own and published like a score: the
 *  fixture and every seat the cascade then changed. A cache that could not be dropped is logged, never thrown — the
 *  write has committed (scoring's R10 M3 shape). */
async function departSeat(auth: AuthCtx, fixtureId: string, entrantId: string, mode: "tbd" | "double_walkover"): Promise<void> {
  const touched = await withTenant(auth.orgId, (tx) => writeDepartedSeat(tx, fixtureId, entrantId, mode));
  await invalidatePublicCache(auth.orgId, fixtureId, false, undefined, touched).catch((err: unknown) => {
    log.error({ err, fixture: fixtureId }, "withdrawal: public cache invalidation failed (the dead seat stands)");
  });
}

/** Phase 3 wave 1 (spec §7): the boards the cascade just settled will never be played, so the chess invites still QUEUED for them
 *  end `board_settled` (a row already sending is left to finish). Its own tenant transaction, after the settles committed (each
 *  commits on its own, ruling 101). A failure here is logged and never thrown: the walkovers stand, the entrant must still be marked
 *  withdrawn, and a stale invite is only a mail to a board nobody can play - it expires on its own. An empty list needs no guard here:
 *  `cancelBoardInvites` answers `[]` before it issues a statement. */
async function cancelSettledBoardInvites(auth: AuthCtx, fixtureIds: readonly string[]): Promise<void> {
  try {
    await withTenant(auth.orgId, (tx) => cancelBoardInvites(tx, fixtureIds, BOARD_SETTLED_REASON));
  } catch (err) {
    // The residual is accepted (T6 review m2): nothing re-drives this, so an invite still queued for one of these boards is mailed
    // until it expires (under a day) and names a board nobody will play. The log is how an operator finds it: the board ids to
    // look the rows up by (`fixtureId:white|black`), and how many boards, so at most twice as many invites. A count of the queued
    // rows themselves would be a second read on the connection that just failed.
    log.error(
      { err, fixtureIds, boards: fixtureIds.length },
      "withdrawal: the settled boards' queued invites could not be ended; they expire on their own",
    );
  }
}

/** W3 T15 (RB3-17, X-SW-23): `as: "disqualified"` is a disqualification — "withdrawal from that moment; annulment
 *  separate" (rulebook §12) — so every board is settled exactly as a withdrawal settles it (the same `withdrew` walkover;
 *  ruling 115 still decides credit) and only the final status differs. `patchEntrant` routes a `status: "disqualified"`
 *  patch of an entrant still in the field here; this function writes its status through `writeEntrantPatch`, which never
 *  routes back (controller ruling C6). Asked of an entrant already departed (either status, B3 I-2), it refuses 409: nothing is owed. */
/** W5 T8b (X-WDT-9, ruling 288): who started a withdrawal that no staff user made, written on its `table_withdrawal` rows.
 *  Server-only, like `writer`: no request field reaches it. */
export type CascadeActor = { kind: "registrant"; registration_id: string };

/**
 * W5 T8b (X-WDT-9, X-WDT-10; rulings 288, 289): the authority a server-started cascade runs under — the org's own, with the
 * organiser's privileges, because the rule (not the person) does the settling: a registrant's own withdrawal (public, token- or
 * ref-verified, `userId` null — no staff user did it) or a scorer's in-match disqualification (a device link or an official, who
 * may write only their own fixture; `userId` keeps the scorer on the events, as their own writes carry it). NOT the quick
 * match's `systemAuth()`: that is the system ORG's actor (`lib/quick-match-auth.ts`), and every read here is tenant-scoped.
 * Built only by server code after the triggering write committed; never from a request.
 */
export function cascadeAuthFor(orgId: string, userId: string | null): AuthCtx {
  return { orgId, via: "session", userId, role: "owner", keyId: null };
}

/**
 * W5 T8b re-review (m): ONE withdrawal cascade per entrant at a time. The cascade is many transactions (every settle is its
 * own `scoreEvent`), so nothing else serialises two runs: a double POST, a lost-ack resend of a disqualifying forfeit, the
 * organiser's Withdraw beside the registrant's own, or a slow first run beside its retry would each settle the same lines
 * twice. The whole run holds a per-entrant ROW lock; a second caller waits for it, then re-reads her status inside it and
 * finds nothing owed (the 409 below — the cascade writes her status last, so a run that finished is a departed entrant).
 *
 * A row, not a Postgres advisory lock — the owner's 2026-08-25 ruling for the import lock (`event-import.ts`), for the same
 * two reasons: a session lock breaks under a transaction-mode pooler (the backend can change between lock and unlock), and
 * holding a session for the whole cascade pins a slot of a five-connection pool while the cascade itself needs more. The row
 * reuses `import_locks` under a key no import shares the meaning of (`withdrawal-cascade:<entrant>`; an import's id is free
 * text, so the worst a collision does is make one of the two wait or answer `import.concurrent`). Nothing is held while
 * waiting (a poll, not a reserved connection). A crashed run's row is taken over once its TTL passes.
 */
const CASCADE_LOCK_TTL_MINUTES = 10;
const CASCADE_LOCK_WAIT_MS = 120_000;
const CASCADE_LOCK_POLL_MS = 100;
const cascadeLockKey = (entrantId: string) => `withdrawal-cascade:${entrantId}`;

async function acquireCascadeLock(orgId: string, divisionId: string, entrantId: string): Promise<string | null> {
  const holder = randomUUID();
  const [row] = await sql<{ holder: string }[]>`
    insert into import_locks (division_id, import_id, org_id, holder, expires_at)
    values (${divisionId}, ${cascadeLockKey(entrantId)}, ${orgId}, ${holder}, now() + make_interval(mins => ${CASCADE_LOCK_TTL_MINUTES}))
    on conflict (division_id, import_id) do update
      set holder = excluded.holder, org_id = excluded.org_id, acquired_at = now(), expires_at = excluded.expires_at
      where import_locks.expires_at < now()
    returning holder`;
  return row ? row.holder : null;
}

async function releaseCascadeLock(orgId: string, divisionId: string, entrantId: string, holder: string): Promise<void> {
  await sql`delete from import_locks where division_id = ${divisionId} and import_id = ${cascadeLockKey(entrantId)}
             and org_id = ${orgId} and holder = ${holder}`;
}

/**
 * B3 fix wave (I-1): the per-entrant cascade lock around `fn` — shared by the withdrawal cascade and a Reinstate's reverse, the
 * two writers that move her lines in bulk. `fn` must re-read her status itself: the status read before the wait is stale once
 * another holder (a live cascade, a Reinstate) has finished. Waits (polling, nothing held) up to `CASCADE_LOCK_WAIT_MS`, then
 * refuses 409.
 */
export async function withCascadeLock<T>(orgId: string, divisionId: string, entrantId: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + CASCADE_LOCK_WAIT_MS;
  let holder = await acquireCascadeLock(orgId, divisionId, entrantId);
  while (holder === null) {
    if (Date.now() > deadline) throw new HttpError(409, "A withdrawal of this entrant is already running - try again in a moment");
    await new Promise((r) => setTimeout(r, CASCADE_LOCK_POLL_MS));
    holder = await acquireCascadeLock(orgId, divisionId, entrantId);
  }
  try {
    return await fn();
  } finally {
    try {
      await releaseCascadeLock(orgId, divisionId, entrantId, holder);
    } catch (err) {
      log.error({ err, entrantId }, "withdrawal: releasing the cascade lock failed (it expires on its own)");
    }
  }
}

export async function withdrawEntrantCascade(
  auth: AuthCtx,
  entrantId: string,
  opts: { as?: "withdrawn" | "disqualified"; actor?: CascadeActor } = {},
): Promise<WithdrawCascadeOut> {
  const { division_id: divisionId } = await getEntrant(auth, entrantId);
  return withCascadeLock(auth.orgId, divisionId, entrantId, () => runWithdrawEntrantCascade(auth, entrantId, opts));
}

/**
 * W5 T8b re-review (I): a cascade cut off part-way (it has no catch: a throw on a later settle leaves the earlier ones written,
 * her status unwritten) is RESUMED by the next run — and the next run must decide as the first did. It would not, over the
 * half-settled lines: a line it walked over now reads as PLAYED (4 of 5 instead of 3 of 5 on the ledger row), and a line it
 * expunged reads as neither played nor pending, so an expunge at 2 of 5 resumes as a walkover at 2 of 4. So before deciding,
 * the run takes back its own unfinished work on the open table stages, on every line of hers whose other side is still in the
 * field (a line shared with an entrant who has left is that entrant's).
 *
 * Re-review 2 (ruling C): what an expunge removed is read from its write-ahead `table_withdrawal_line` rows ONLY
 * (`takeBackLines`, the same reading a Reinstate makes) — never inferred from the score ledger, where a scorer's trailing
 * Undo on a pending line looked exactly like the cascade's own voids and came back.
 *
 * Only for an entrant still in the field (the caller has checked): a departed entrant's events are her finished withdrawal.
 */
async function reversePartialCascade(auth: AuthCtx, entrantId: string, divisionId: string): Promise<void> {
  const [stages, fixtures, entrants, ledger] = await Promise.all([
    listStages(auth, divisionId),
    listDivisionFixtures(auth, divisionId),
    listEntrants(auth, divisionId),
    tableWithdrawalLedger(auth, divisionId),
  ]);
  const open = new Set(stages.filter((st) => TABLE_KINDS.has(st.kind) && st.status !== "complete").map((st) => st.id));
  const gone = new Set(entrants.filter((e) => DEPARTED_STATUSES.has(e.status)).map((e) => e.id));
  const lines = (fixtures as unknown as FixtureRowLite[]).filter((f) => open.has(f.stage_id) && sharedWithTheField(f, entrantId, gone));
  const scratch: ReinstateTableOut = { voided: 0, rerecorded: 0, not_restored: [] };
  await takeBackLines(auth, entrantId, divisionId, lines, ledger, scratch);
  for (const id of scratch.not_restored) {
    log.warn({ fixture: id, entrantId }, "withdrawal: resuming a cut-off cascade, a removed result could not be put back");
  }
}

async function runWithdrawEntrantCascade(
  auth: AuthCtx,
  entrantId: string,
  opts: { as?: "withdrawn" | "disqualified"; actor?: CascadeActor },
): Promise<WithdrawCascadeOut> {
  const as = opts.as ?? "withdrawn";
  const entrant = await getEntrant(auth, entrantId);
  // B3 fix wave (I-2; RB3-17 - a disqualification is "withdrawal from that moment", so the FIRST departure governs): an entrant
  // already out of the field (withdrawn OR disqualified) is owed nothing by any door, whatever status it asks for - no settle, no
  // `table_withdrawal` row, her status unchanged (a DQ is never downgraded to `withdrawn`). Read inside the lock, so a door that
  // waited behind a cascade meets her as that cascade left her. Every automatic door reads this 409 as "already gone"; an
  // organiser's deliberate status change between the two departed statuses is `patchEntrant`'s plain write (C6), not this door.
  if (DEPARTED_STATUSES.has(entrant.status)) {
    throw new HttpError(409, `entrant is already ${entrant.status}`);
  }
  const division = await getDivision(auth, entrant.division_id);
  const out: WithdrawCascadeOut = {
    entrant_id: entrantId,
    status: as,
    policy: "none",
    walkovers: 0,
    voided: 0,
    skipped_cancelled: 0,
    walked_over_held: 0,
    left_to_organiser: [],
    lucky_loser: null,
  };

  // W5 T8 (RB5-W4, RB5-W7): one row per league or group stage settled, with the count the policy decided on; written after the
  // settles, so a cascade that fails part-way leaves no footnote claiming a rule it did not finish applying. What an expunge
  // removed is not on this row: each line's write-ahead `table_withdrawal_line` row says it (`expungeLine`, ruling C).
  const ledgerRows: {
    entrant_id: string;
    stage_id: string;
    policy: TableWithdrawalPolicy;
    played_at_departure: number;
    scheduled: number;
    actor?: CascadeActor;
  }[] = [];
  const settledTables: { id: string; kind: string }[] = [];
  // W5 T11: the destinations whose confirmed proposal this departure staled, to re-propose once she is out of the field.
  let seedRecompute: string[] = [];

  // Before the tournament starts there is nothing to settle: fixtures (if
  // generated) are regenerated from the field anyway — plain status flip.
  // W3 T15: "started" is T9's one predicate (`divisionHasStarted`, controller ruling C17), read here rather than restated.
  if (await withTenant(auth.orgId, (tx) => divisionHasStarted(tx, division.id))) {
    // Re-review (I): a run cut off part-way left settles behind; take them back so this run decides as the first did. (She is in
    // the field here: a departed entrant was refused above.)
    await reversePartialCascade(auth, entrantId, division.id);
    // W4 T13 (RB4-V2, X-LL-1): a qualifier whose main-draw round-1 line has not started takes a lucky loser in her seat
    // FIRST, so the line below is no longer hers and walks nobody over. Its own transaction, committed before the
    // settles (ruling 101), and published like any seat write.
    const lucky = await withTenant(auth.orgId, (tx) => replaceDepartedQualifier(tx, auth, entrantId));
    if (lucky !== null) {
      out.lucky_loser = { entrant_id: lucky.replacedBy, fixture_id: lucky.fixtureId };
      afterScheduleWrite(division.id, division.competition_id, "schedule", [lucky.fixtureId]);
    }
    // W5 T11 (X-CUT-4 <- RB5-K6, FX-G16's table half): a qualifier of a COMPLETED league or group whose destination has not started
    // takes her confirmed proposal with her - it goes stale and its seats go back - BEFORE any line is settled, because the
    // walkover below over her seat would itself be a start, after which nothing could go back. This is the one place every
    // door of the cascade passes (the organiser's PATCH and Withdraw, the registrant's own, an in-match disqualification, a pair
    // that lost a partner, a released solo). It does NOT re-rank the finished table (RB5-L8): the table stays as it finished
    // (the loop below skips a complete stage) and only the PROPOSAL, the cut into the knockout, answers. After the start
    // nothing is written: the bracket stands, her seat is RB4-V3's walkover, and the desk's drift names only a moved RESULT.
    // The re-proposal runs after her status is written (below), which it must read.
    const cut = await staleConfirmedProposalsOfDeparting(auth.orgId, division.id, entrantId);
    seedRecompute = cut.recompute;
    if (cut.unfilled.length > 0) afterScheduleWrite(division.id, division.competition_id, "schedule", cut.unfilled);
    const [stages, fixtures] = await Promise.all([
      listStages(auth, division.id),
      listDivisionFixtures(auth, division.id),
    ]);
    const sportModule = resolveModule(division.sport_key, division.module_version);
    // An americano stage's fixtures name pairs, not the individual: the pairs holding their person are theirs too. Only
    // read for a division that has such a stage; and a `pair` entrant sharing a person with an individual of the same
    // division exists nowhere else (the one-team rule, `heldMemberships`, refuses it), so no other stage can match.
    const americanoPairs = stages.some((st) => st.kind === "americano")
      ? await americanoPairsHolding(auth, division.id, entrantId)
      : new Set<string>();
    const byStage = new Map<string, FixtureRowLite[]>();
    for (const f of fixtures as unknown as FixtureRowLite[]) {
      const direct = f.home_entrant_id === entrantId || f.away_entrant_id === entrantId;
      const viaPair =
        (f.home_entrant_id !== null && americanoPairs.has(f.home_entrant_id)) ||
        (f.away_entrant_id !== null && americanoPairs.has(f.away_entrant_id));
      if (!direct && !viaPair) continue;
      const list = byStage.get(f.stage_id) ?? [];
      list.push(f);
      byStage.set(f.stage_id, list);
    }

    type Step = { update: FixtureUpdate & { walkoverBy?: string }; fixture: FixtureRowLite; bracket?: { kind: string; held: boolean } };
    const plan: Step[] = [];
    for (const stage of stages) {
      const mine = byStage.get(stage.id) ?? [];
      if (mine.length === 0) continue;
      const byId = new Map(mine.map((f) => [f.id, f]));

      // W5 T8 fix round 1 (C1, RB5-L8): a FINISHED league or group takes nothing from a later departure — no result removed,
      // no walkover, no ledger row, no refold (her row there stands as earned; seeding reads that snapshot). The knockout's
      // precedent below (`stage.status === "complete"`).
      if (ROUND_ROBIN_KINDS.has(stage.kind) && stage.status === "complete") continue;
      if (TABLE_KINDS.has(stage.kind)) {
        // lib/table-withdrawal: the ONE reading of these rows into the policy's input (the qualification builder reads the same
        // verdict, ruling F1); `decideTableWithdrawal` is the one decision (the Disqualify preview calls it too, ruling 289).
        const decision = decideTableWithdrawal({ id: stage.id, kind: stage.kind as "league" | "group" | "swiss" }, entrantId, mine);
        const mode = decision.mode;
        out.policy = mode === "expunge" ? "expunge" : out.policy === "expunge" ? "expunge" : "walkover";
        // W5 T8: a cancelled line of theirs is left as it is (neither played nor pending, RB5-W4 does not count it).
        out.skipped_cancelled += mine.filter((f) => f.status === "cancelled").length;
        if (ROUND_ROBIN_KINDS.has(stage.kind)) {
          settledTables.push({ id: stage.id, kind: stage.kind });
          ledgerRows.push({
            entrant_id: entrantId,
            stage_id: stage.id,
            policy: mode,
            played_at_departure: decision.played,
            scheduled: decision.scheduled,
            ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
          });
        }
        for (const u of decision.updates) {
          const f = byId.get(u.fixtureId);
          if (f) plan.push({ update: { ...u, walkoverBy: entrantId }, fixture: f });
        }
        // W2c X-AB-5 (fix round 1): a board of theirs ABANDONED with no result is neither played nor pending, so the
        // policy above never touches it - and it holds the next round (Swiss) until the organiser settles it. Left as
        // it is (the settle may not name the departed entrant, C17: the opponent can still be chosen), and NAMED here so
        // the report says which board is still owed a decision. `rowAwaitsSettle` is the one reading of "owed a settle" -
        // its own status test is the only one (a prefilter here would be an equivalent twin no test can kill).
        for (const f of mine) {
          const active = activeAbandons(await listEvents(auth, f.id, 0));
          const owed = rowAwaitsSettle(stage.kind, {
            status: f.status,
            outcome: f.outcome,
            has_active_abandon: active.length > 0,
            expunged: active.some((e) => (e.payload as { expunge?: unknown } | null)?.expunge === true),
            no_result: active.some((e) => (e.payload as { noResult?: unknown } | null)?.noResult === true),
          });
          if (owed) out.left_to_organiser.push(f.id);
        }
      } else if (WITHDRAWAL_WALKOVER_KINDS.has(stage.kind)) {
        const bracketFixtures: BracketFixture[] = [];
        const held = new Set<string>();
        for (const f of mine) {
          const abandoned = f.status === "abandoned" && activeAbandons(await listEvents(auth, f.id, 0)).length > 0;
          const owed = f.status === "in_play" && (await deciderOwed(auth, sportModule, f.id));
          if (f.status === "needs_decision" || owed || abandoned) held.add(f.id);
          bracketFixtures.push({
            id: f.id,
            round: f.round_no,
            status: bracketWithdrawalStatus(f.status, abandoned),
            home: f.home_entrant_id ?? undefined,
            away: f.away_entrant_id ?? undefined,
          });
        }
        // The planner is kind-blind (it walks every unsettled line of the entrant over to its opponent).
        const result = withdrawBracketEntrant(
          {
            id: stage.id,
            kind: stage.kind as "knockout" | "double_elim" | "stepladder",
            // engine 5.0.0 made `entrants` required. The seated set is what this planner reads, and it stays the
            // seated set (B1 review M5 reverted a widening to the full drawn roster: the planner only walks lines
            // over, so an entrant in no fixture has nothing to plan). The DRAWN roster is declared where ranks are
            // read: `bracketRoster` (engine-db/competition.ts) adds the departed and `config.qualified` entrants.
            entrants: [...new Set(bracketFixtures.flatMap((b) => [b.home, b.away]).filter((id): id is string => id !== undefined))],
          },
          entrantId,
          bracketFixtures,
        );
        // Rulings 53 + 106 (53: the ladder; 106 extends it to every bracket kind — knockout, DE, stepladder; loop-F
        // Q-R53). The policy is what the withdrawal actually leaves — an entrant with fixtures in
        // the stage but nothing pending (an eliminated knockout entrant; a ladder entrant whose challenges are decided)
        // walks nothing over, so the policy stays `none`, as the open-format branch below reads it.
        if (out.policy === "none" && result.updates.length > 0) out.policy = "walkover";
        for (const u of result.updates) {
          const f = byId.get(u.fixtureId);
          if (f) plan.push({ update: { ...u, walkoverBy: entrantId }, fixture: f, bracket: { kind: stage.kind, held: held.has(f.id) } });
        }
        // W4 fix round 1 (RB4-C3 / RB4-T6, PO ruling 2026-11-10): the planner walks over only UNSETTLED lines, so the SECOND
        // finalist (or third-place side) to leave finds the line already walked over to her by the first. A walkover awarded
        // for a withdrawal whose winner then departs is the vacant title (or the vacant 3rd) - a departure double walkover.
        // The `withdrew` forfeit is voided and the line re-enters the plan; the branch below writes the no-event double
        // walkover. Only a line whose whole ledger is that one forfeit: a played line stays as played (ruling 271), and
        // anything else on the ledger is the organiser's.
        if (stage.kind === "knockout") {
          for (const f of mine) {
            const o = f.outcome as { kind?: string; winner?: string; reason?: string } | null;
            const scoped = f.is_final === true || f.third_place === true;
            // PO ruling 2026-11-10 (I2): once the organiser has Completed the stage the walkover champion STANDS; a later
            // departure takes the ordinary post-complete handling, never the vacant title.
            if (stage.status === "complete" || !scoped || f.status !== "forfeited" || o?.kind !== "award" || o.winner !== entrantId) continue;
            const other = f.home_entrant_id === entrantId ? f.away_entrant_id : f.home_entrant_id;
            if (!other) continue;
            const events = await listEvents(auth, f.id, 0);
            const voided = new Set(events.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id as string));
            const effective = events.filter((e) => e.type !== "core.void" && !voided.has(e.id));
            const only = effective.length > 0 && effective.every((e) => e.type === "core.forfeit" && (e.payload as { reason?: string } | null)?.reason === REASON);
            if (!only) continue;
            for (const e of effective) {
              const state = await getFixtureState(auth, f.id);
              await scoreEvent(auth, f.id, { expected_seq: state.last_seq, type: "core.void", payload: { event_id: e.id } }, CASCADE);
            }
            plan.push({
              update: { fixtureId: f.id, status: "walkover", walkoverTo: other, walkoverBy: entrantId } as FixtureUpdate & { walkoverBy?: string },
              fixture: { ...f, status: "scheduled", outcome: null },
              bracket: { kind: stage.kind, held: false },
            });
          }
        }
      } else {
        // americano: their matches not yet finished (scheduled or in play - the same PENDING set every format's withdrawal
        // reads) void (expunged, D5); played results and the standings they earned stand.
        let voids = 0;
        for (const f of mine) {
          if (PENDING.has(f.status)) {
            plan.push({ update: { fixtureId: f.id, status: "void" }, fixture: f });
            voids++;
          }
        }
        if (out.policy === "none" && voids > 0) out.policy = "expunge";
      }
    }

    // X-WD-4: who has already left (`DEPARTED_STATUSES`: withdrawn or disqualified) — an opponent on this list gets no
    // walkover (it would seat a departed entrant).
    const gone = new Set(
      (await listEntrants(auth, division.id)).filter((e) => DEPARTED_STATUSES.has(e.status)).map((e) => e.id),
    );
    // Every board the loop below settled (a walkover, a void, a double walkover): their queued invites end in `finally`, so a loop that
    // fails on a later board still ends the invites of the boards it had already settled (and never those of the board it failed
    // on - an id is added only after its settle returned).
    const settled: string[] = [];
    try {
      for (const step of plan) {
        const u = step.update;
        if (step.bracket && u.status === "walkover") {
          if (u.walkoverTo === undefined) {
            // X-WD-3 (plan D17): nobody is on the other side yet to receive a walkover. Her seat is emptied and stamped
            // dead, so whoever arrives walks over it in the same write that seats them (`resolveBracketSeats`).
            await departSeat(auth, u.fixtureId, entrantId, "tbd");
            out.walkovers++;
            continue;
          }
          if (gone.has(u.walkoverTo)) {
            // X-WD-4: both sides of the line have now withdrawn — a double walkover, no event (as a bye is written),
            // which seats nobody (X-DW-2) — unless the line feeds nothing: a final has no next match (D19, X-DW-3), so
            // it stays open for W4's vacant title, and nothing is written. A ladder challenge is exempt (D19).
            // Review M-1: and only over a line nobody has recorded play on. The other side left by a bare status write
            // (no cascade), so play may have gone on; that ledger is the organiser's to void or settle, never overwritten
            // — and named in `left_to_organiser` (Loop R M-5), a played final included.
            // A double-elimination grand final with a bracket reset feeds only its own rematch: a final too (I-5).
            const feeds = feedsNextMatch(step.fixture) || step.bracket.kind === "ladder";
            const line = await lineLedger(auth, sportModule, u.fixtureId);
            if (line.played) {
              out.left_to_organiser.push(u.fixtureId);
            } else if (feeds) {
              // Loop R M-5: "played" is the engine's reading (ruling 112), so a bare Start no longer leaves the line in
              // play forever. Nothing live at all: the departure's no-event write. A Start (or an annotation, an abandon)
              // with nothing played after it: recorded, as the console's double walkover is — the no-event write refuses
              // any live event, and the Start stands in the record.
              if (line.live) await recordDoubleWalkover(auth, u.fixtureId, line.events);
              else await departSeat(auth, u.fixtureId, entrantId, "double_walkover");
              settled.push(u.fixtureId);
              out.walkovers++;
            } else if (isDecidingFinalOfKnockout(step) && !line.live) {
              // W4 T11 (X-CH-3; WD-CASC's vacant half): both finalists are out and the final feeds nothing - the title is
              // VACANT, automatically, written as a departure double walkover (no event, as a bye is written). It is
              // reversible: a Reinstate of either finalist reads the line again (`reviveVacantFinal`). Only the DECIDING
              // final of a knockout: a third-place match is Task 9's (X-TP-7), and a double-elimination grand final feeds
              // its own reset, which a vacant grand final would leave owed for good (C32, parked).
              await departSeat(auth, u.fixtureId, entrantId, "double_walkover");
              settled.push(u.fixtureId);
              out.walkovers++;
            } else if (isThirdPlaceOfKnockout(step) && !line.live) {
              // B4 T9 (X-TP-7, superseding X-DW-3's hold for THIS match): both sides of a third-place play-off are out, so 3rd is
              // VACANT and both rank 4th - written as a departure double walkover (no event, as a bye is written), which
              // seats nobody and lets the stage complete. With ONE side out the line stays a walkover (the branch above never
              // reaches here: `walkoverTo` is the other, present, side).
              await departSeat(auth, u.fixtureId, entrantId, "double_walkover");
              settled.push(u.fixtureId);
              out.walkovers++;
            } else if (isDecidingFinalOfKnockout(step) || isThirdPlaceOfKnockout(step)) {
              // Review m-3: a Start with nothing played is a live ledger the no-event write refuses; the final stays open and is
              // NAMED, so the organiser is told it is theirs to settle or void.
              out.left_to_organiser.push(u.fixtureId);
            }
            continue;
          }
        } else if (u.status === "walkover" && !u.walkoverTo) {
          // A table stage's TBD opponent can't receive a walkover — void that slot instead.
          step.update = { fixtureId: u.fixtureId, status: "void" };
        } else if (u.status === "walkover" && gone.has(u.walkoverTo!)) {
          // Loop R M-4 (controller ruling 2026-10-13): signed X-WD-4 (ruling 90) has no bracket scope. In a league, group
          // or Swiss round the opponent who already left (a bare status write — an organiser's `PATCH {status: "withdrawn"}`,
          // which cascades nothing; a registrant's own withdrawal after Start cascades since W5 T8b, ruling 288) is still seated, and a walkover would hand her the points and the walkover score. Both
          // sides have withdrawn: a double walkover. Unlike a bracket line (which seats nothing, so it is written as a
          // bye is), a table line is RECORDED — X-DW-4 counts it P+1, L+1 for both, and the table folds only a line with
          // a match state — so it goes through the ordinary write, as the console's double walkover does. M-1's guard
          // holds here too: a line with recorded play (the engine's reading — a bare Start is not play, Loop R M-5) is the
          // organiser's to settle, and is named in `left_to_organiser`.
          const line = await lineLedger(auth, sportModule, u.fixtureId);
          if (line.played) {
            out.left_to_organiser.push(u.fixtureId);
          } else {
            await recordDoubleWalkover(auth, u.fixtureId, line.events);
            settled.push(u.fixtureId);
            out.walkovers++;
          }
          continue;
        }
        await applyUpdate(auth, step.update, step.fixture, out, step.bracket?.held === true, { divisionId: division.id, entrantId });
        settled.push(step.update.fixtureId);
      }
    } finally {
      await cancelSettledBoardInvites(auth, settled);
    }
    if (ledgerRows.length > 0) {
      await withTenant(auth.orgId, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${"division:" + division.id}))`;
        for (const row of ledgerRows) await appendTableLedgerRow(tx, division.id, TABLE_WITHDRAWAL_ROW, row, auth.userId);
      });
    }
  }

  // The internal writer, never `patchEntrant`: a `disqualified` patch routes to this cascade, so writing through it would
  // route straight back (C6).
  await writeEntrantPatch(auth, entrantId, { status: as });
  await reproposeStaleDependents(auth, seedRecompute);
  // W5 T8 (ruling 105 / M-10, Review Focus 4): an expunge ends on `core.abandon{expunge: true}`, which decides nothing, so no
  // score write asks whether the stage is now finished; when the leaver's lines were its last open ones it would sit there.
  // Asked once per table stage settled, AFTER the status write: the completion reads the departed status (the cut skips her).
  // RB5-W1: and her row now ranks last — the stored table was folded by the settles while she was still in the field.
  for (const stage of settledTables) {
    await refoldStageTable(auth.orgId, stage, "skip");
    await maybeAutoAdvance(auth, stage.id, division.id);
  }
  return out;
}

/**
 * W5 T8b Part 2 (X-WDT-10 ← RB5-W11, X-RT-1; owner ruling 289, ruling 259): a disqualification recorded DURING a match — a
 * committed `core.forfeit{by, reason: "disqualified"}`, the pad's sanction ending or the organiser's forfeit — withdraws the
 * entrant from the stage: the table withdrawal (`withdrawEntrantCascade(…, { as: "disqualified" })`), whose 50 percent rule now
 * counts the match just ended as played. Only on a table stage (league, group, Swiss); a bracket fixture's disqualification is
 * the bracket's own forfeit (W4, unchanged). Called by `scoreEvent` AFTER the forfeit committed, for a write no cascade made
 * (a cascade's own re-record of a disqualifying forfeit, on Reinstate, must not disqualify her again).
 *
 * Idempotent: an entrant already departed (withdrawn or disqualified — `patchEntrant`'s C6: a departed entrant is owed no
 * cascade) is left as she is, so a second disqualifying forfeit never runs a second cascade. It runs under the org's server
 * authority (`cascadeAuthFor`), keeping the scorer as the user on the events: a device link may write only its own fixture,
 * and the rule — not the scorer — settles the others.
 *
 * Best-effort, like the table stale call after a score: the forfeit stands whatever happens here. A cascade that throws is
 * logged; she is still in the field (the cascade writes her status last), so the organiser's Disqualify finishes it.
 */
/**
 * W5 T8b re-review (I): is the withdrawal a trigger owed (a registration withdrawn after Start, a disqualifying forfeit — both
 * at `at`) still not done? DONE is keyed on the cascade's LAST write — her departed status, written after every settle and
 * after the `table_withdrawal` rows (the refold that follows it is derived, recomputed by any later fold) — never on an
 * intermediate settle: a run cut off part-way has written walkovers and expunges but not her status, and is owed. So: owed
 * while she is still in the field, unless the organiser has REINSTATED her since the trigger — read from Reinstate's own write,
 * a `withdrawal_reinstated` row about her (on or after `at`). The ONE reading for the desk's
 * "withdrawal did not finish" row and for both retries, so a Reinstate is neither flagged nor withdrawn again by a retry.
 *
 * W5 T10b (ruling 292) closes the 8b limit: the Reinstate is read from its OWN trace, `withdrawal_reinstated` (`recordWithdrawalReinstated`,
 * written for every stage kind in the status write's transaction), never inferred from a `table_withdrawal_voided` row - a Swiss or
 * knockout cascade writes no `table_withdrawal` row, so a Reinstated pair there read as owed. One authority for the fact.
 */
export async function withdrawalOwedSince(tx: Tx, divisionId: string, entrantId: string, at: Date): Promise<boolean> {
  const [row] = await tx<{ status: string | null; reversed: boolean }[]>`
    select (select status from entrants where id = ${entrantId}) as status,
           exists (select 1 from division_events v
                    where v.division_id = ${divisionId} and v.type = ${WITHDRAWAL_REINSTATED_ROW}
                      and v.payload ->> 'entrant_id' = ${entrantId} and v.created_at >= ${at}) as reversed`;
  return row !== undefined && row.status !== null && !DEPARTED_STATUSES.has(row.status) && !row.reversed;
}

/** W5 T10b (ruling 292): the durable trace of a Reinstate, in the transaction that writes her back into the field - every stage kind,
 *  because only a league or group cascade writes a `table_withdrawal` row for a Reinstate to void. Takes the division lock
 *  (`appendTableLedgerRow`'s contract; a Reinstate already holds it). */
export async function recordWithdrawalReinstated(tx: Tx, divisionId: string, entrantId: string, actorId: string | null): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
  await appendTableLedgerRow(tx, divisionId, WITHDRAWAL_REINSTATED_ROW, { entrant_id: entrantId }, actorId);
}

/**
 * W5 T10 fix round 2 (R12; I-1) - DURABLE marker, not derived: a pair that loses a partner to a released placed solo is owed a
 * dissolve (`pairLosses`, run after the releasing transaction commits). The release deletes the solo's `registration_players` row
 * - the only link from her to the pair - so a cascade that then fails would leave nothing to find the pair by; the marker is
 * written in the SAME transaction as the release, so the two commit or roll back together. Read by `pairDissolveOwedCandidates`
 * (the desk) and `owedPairsOfRegistration` (the retries), through `withdrawalOwedSince`: owed while the pair is in the field.
 * Takes the division lock (`appendTableLedgerRow`'s contract).
 */
export async function recordPairDissolveOwed(tx: Tx, divisionId: string, entrantId: string, registrationId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
  await appendTableLedgerRow(tx, divisionId, PAIR_DISSOLVE_OWED_ROW, { entrant_id: entrantId, registration_id: registrationId }, null);
}

/** The pairs with a dissolve owed, latest marker each, for these divisions - candidates only; the desk asks `withdrawalOwedSince`
 *  of each (a departed pair is done, a Reinstated one is the organiser's last word). Entrants no longer in the field are left out. */
export async function pairDissolveOwedCandidates(
  tx: Tx,
  divisionIds: readonly string[],
): Promise<{ id: string; division_id: string; name: string; at: Date }[]> {
  if (divisionIds.length === 0) return [];
  return tx<{ id: string; division_id: string; name: string; at: Date }[]>`
    select e.id, e.division_id, e.display_name as name, max(ev.created_at) as at
      from division_events ev
      join entrants e on e.id = (ev.payload ->> 'entrant_id')::uuid and e.division_id = ev.division_id
     where ev.division_id = any(${divisionIds as string[]}) and ev.type = ${PAIR_DISSOLVE_OWED_ROW}
       and e.status not in ${tx([...DEPARTED_STATUSES])}
     group by e.id, e.division_id, e.display_name, e.created_at
     order by e.created_at, e.id`;
}

/** The pairs a registration's release left a dissolve owed on, and still owed (`withdrawalOwedSince`) - what a re-POST of that
 *  registration's withdrawal retries. */
export async function owedPairsOfRegistration(tx: Tx, registrationId: string): Promise<{ entrantId: string; divisionId: string }[]> {
  const rows = await tx<{ id: string; division_id: string; at: Date }[]>`
    select (ev.payload ->> 'entrant_id') as id, ev.division_id, max(ev.created_at) as at
      from division_events ev
     where ev.type = ${PAIR_DISSOLVE_OWED_ROW} and ev.payload ->> 'registration_id' = ${registrationId}
     group by ev.payload ->> 'entrant_id', ev.division_id`;
  const out: { entrantId: string; divisionId: string }[] = [];
  for (const r of rows) {
    if (await withdrawalOwedSince(tx, r.division_id, r.id, r.at)) out.push({ entrantId: r.id, divisionId: r.division_id });
  }
  return out;
}

/** The refusal an organiser's (or a scorer's) Undo of a disqualifying forfeit meets while the disqualification stands. */
export const UNDO_DQ_USE_REINSTATE = "UNDO_DQ_USE_REINSTATE";

/**
 * W5 T8b review I1: voiding a `core.forfeit{reason: "disqualified"}` on a table stage while its entrant is departed would
 * re-open the match and leave the withdrawal it ran in place — she stays disqualified, her other lines stay settled. So it is
 * refused (409 UNDO_DQ_USE_REINSTATE) and Reinstate is the undo: it reverses the cascade (RB5-W6), after which this void is
 * allowed again. A disqualifying forfeit whose entrant is still in the field (its cascade failed, see `disqualifyFromMatch`)
 * voids as any forfeit does; a bracket's disqualifying forfeit is W4's own and is not touched here.
 */
export async function assertDisqualificationUndoable(auth: AuthCtx, fixtureId: string, payload: unknown): Promise<void> {
  const eventId = (payload as { event_id?: unknown } | null)?.event_id;
  if (typeof eventId !== "string") return; // assertUndoTarget has already refused it
  const [target] = await withTenant(auth.orgId, (tx) =>
    tx<{ kind: string; status: string | null }[]>`
      select s.kind, (select en.status from entrants en where en.id::text = e.payload ->> 'by') as status
        from score_events e
        join fixtures f on f.id = e.fixture_id
        join stages s on s.id = f.stage_id
       where e.id = ${eventId} and e.fixture_id = ${fixtureId}
         and e.type = 'core.forfeit' and e.payload ->> 'reason' = 'disqualified'`,
  );
  if (target === undefined || !TABLE_KINDS.has(target.kind)) return;
  if (target.status !== null && DEPARTED_STATUSES.has(target.status)) {
    throw new HttpError(409, "This disqualification withdrew them from the stage - use Reinstate to undo it", UNDO_DQ_USE_REINSTATE);
  }
}

export async function disqualifyFromMatch(
  auth: AuthCtx,
  fixtureId: string,
  by: unknown,
  opts: { retry?: boolean } = {},
): Promise<WithdrawCascadeOut | null> {
  if (typeof by !== "string") return null;
  try {
    const [line] = await withTenant(auth.orgId, (tx) =>
      tx<{ kind: string; division_id: string; home: string | null; away: string | null; entrant_status: string | null; forfeit_at: Date | null }[]>`
        select s.kind, f.division_id, f.home_entrant_id as home, f.away_entrant_id as away,
               (select e.status from entrants e where e.id = ${by}) as entrant_status,
               (select max(ev.recorded_at) from score_events ev
                 where ev.fixture_id = f.id and ev.type = 'core.forfeit'
                   and ev.payload ->> 'reason' = 'disqualified' and ev.payload ->> 'by' = ${by}
                   and not exists (select 1 from score_events v where v.fixture_id = ev.fixture_id and v.voids_event_id = ev.id)) as forfeit_at
          from fixtures f join stages s on s.id = f.stage_id
         where f.id = ${fixtureId}`,
    );
    if (line === undefined || !TABLE_KINDS.has(line.kind)) return null;
    if (by !== line.home && by !== line.away) return null;
    if (line.entrant_status === null || DEPARTED_STATUSES.has(line.entrant_status)) return null;
    // Review I2: only a disqualification that stands is owed a withdrawal (a replay of one since undone is not).
    if (line.forfeit_at === null) return null;
    // Review I2 (a): a replayed write retries a cascade still owed (re-review: one at a time under the cascade's lock, so a
    // resend racing the first run waits for it and then finds her gone). A Reinstate since the forfeit stands.
    if (opts.retry === true) {
      const forfeitAt = line.forfeit_at;
      if (!(await withTenant(auth.orgId, (tx) => withdrawalOwedSince(tx, line.division_id, by, forfeitAt)))) return null;
    }
    return await withdrawEntrantCascade(cascadeAuthFor(auth.orgId, auth.userId), by, { as: "disqualified" });
  } catch (err) {
    // A run that waited behind another and found her already gone: the withdrawal is done, nothing failed.
    if (typeof by === "string" && DEPARTED_STATUSES.has((await getEntrant(auth, by).catch(() => null))?.status ?? "")) return null;
    log.error(
      { err, fixture: fixtureId, entrant: by },
      "withdrawal: an in-match disqualification stands, but the table withdrawal failed — the organiser's Disqualify finishes it",
    );
    return null;
  }
}

/** A division-ledger row that moves the division's token and never the watermark — not a history step, not an Undo barrier
 *  (`joint-winners.ts`'s pattern). Under the `division:` lock the caller holds. */
async function appendTableLedgerRow(
  tx: Tx,
  divisionId: string,
  type: string,
  payload: Record<string, unknown>,
  actorId: string | null,
): Promise<number> {
  const [{ seq: last }] = await tx<{ seq: number }[]>`select coalesce(max(seq), 0)::int as seq from division_events where division_id = ${divisionId}`;
  await tx`
    insert into division_events (division_id, seq, type, payload, actor_id)
    values (${divisionId}, ${last + 1}, ${type}, ${tx.json(payload as never)}, ${actorId})`;
  await tx`update divisions set seq = ${last + 1} where id = ${divisionId}`;
  return last + 1;
}

/** Her `withdrew` walkovers on one line, still active, newest first (cascade-only, append-event.ts PF-2, so nobody else can
 *  have written them, and each names her). */
function walkoversOf(events: readonly EventOut[], entrantId: string): EventOut[] {
  const voided = new Set(events.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id as string));
  return events
    .filter((e) => !voided.has(e.id) && e.type === "core.forfeit")
    .filter((e) => {
      const p = (e.payload ?? {}) as { reason?: unknown; by?: unknown };
      return p.reason === REASON && p.by === entrantId;
    })
    .sort((a, b) => b.seq - a.seq);
}

/** One `table_withdrawal_line` row as `expungeLine` writes it; `retired` once a `table_withdrawal_line_voided` row names its
 *  seq. */
interface WithdrawalLineRow {
  seq: number;
  entrant_id: string;
  stage_id: string;
  fixture_id: string;
  planned_void_ids: string[];
  from_seq: number;
  retired: boolean;
}

/** Every write-ahead row in the ledger, oldest first. A row this module's writer never produces (a missing field, a list that
 *  is not ids) is not read: nothing is re-recorded on its word. */
function withdrawalLineRows(ledger: readonly { seq: number; type: string; payload: unknown }[]): WithdrawalLineRow[] {
  const retired = new Set<number>();
  for (const row of ledger) {
    const of = (row.payload as { voids_seq?: unknown } | null)?.voids_seq;
    if (row.type === TABLE_WITHDRAWAL_LINE_VOIDED_ROW && typeof of === "number") retired.add(of);
  }
  const out: WithdrawalLineRow[] = [];
  for (const row of [...ledger].sort((a, b) => a.seq - b.seq)) {
    if (row.type !== TABLE_WITHDRAWAL_LINE_ROW) continue;
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (typeof p.entrant_id !== "string" || typeof p.stage_id !== "string" || typeof p.fixture_id !== "string") continue;
    if (!Array.isArray(p.planned_void_ids) || !p.planned_void_ids.every((x) => typeof x === "string")) continue;
    if (typeof p.from_seq !== "number" || !Number.isInteger(p.from_seq) || p.from_seq < 0) continue;
    out.push({
      seq: row.seq,
      entrant_id: p.entrant_id,
      stage_id: p.stage_id,
      fixture_id: p.fixture_id,
      planned_void_ids: p.planned_void_ids as string[],
      from_seq: p.from_seq,
      retired: retired.has(row.seq),
    });
  }
  return out;
}

/** A line of hers whose other side is still in the field — the only lines a resume or a Reinstate takes back (a line shared
 *  with an entrant who has left stays out until both are back). */
function sharedWithTheField(f: FixtureRowLite, entrantId: string, gone: ReadonlySet<string>): boolean {
  if (f.home_entrant_id !== entrantId && f.away_entrant_id !== entrantId) return false;
  const other = f.home_entrant_id === entrantId ? f.away_entrant_id : f.home_entrant_id;
  return other !== null && !gone.has(other);
}

/** Did the withdrawal that wrote this line row FINISH and then get Reinstated — a `table_withdrawal` row of the same entrant
 *  and stage written after it, since voided? That entrant's Reinstate skipped the line (its other side was gone) and left the
 *  row for whoever comes back second. A cascade still cut off part-way has no such row: its line rows are its own resume's. */
function finishedAndReinstated(ledger: readonly { seq: number; type: string; payload: unknown }[], line: WithdrawalLineRow): boolean {
  const voided = new Set<number>();
  for (const row of ledger) {
    const of = (row.payload as { voids_seq?: unknown } | null)?.voids_seq;
    if (row.type === TABLE_WITHDRAWAL_VOIDED_ROW && typeof of === "number") voided.add(of);
  }
  return ledger.some((row) => {
    const p = (row.payload ?? {}) as { entrant_id?: unknown; stage_id?: unknown };
    return row.type === TABLE_WITHDRAWAL_ROW && row.seq > line.seq && p.entrant_id === line.entrant_id && p.stage_id === line.stage_id && voided.has(row.seq);
  });
}

/**
 * Task 8b re-review 2 (ruling C): take back what withdrawal cascades did to her `lines` (the caller's: hers, on a stage still
 * open, the other side in the field). The ONE reading both a resume of a cut-off cascade and a Reinstate make:
 *
 * 1. Each live `table_withdrawal_line` row on the line that is hers — or the other side's, once that withdrawal finished and
 *    was Reinstated (`finishedAndReinstated`: the shared line waited for both) — is reversed: the expunge abandon written after
 *    it (`from_seq`) is voided, and of its `planned_void_ids` exactly those actually voided are recorded again
 *    (`rerecordRemoved`, its own order, type and payload). An id still active (a cut-off before its void) is not touched. The
 *    row is then retired (a `table_withdrawal_line_voided` row names its seq), so nothing is reversed twice.
 * 2. An expunge abandon NO line row precedes (a legacy withdrawal, from before the rows) is voided and nothing re-recorded:
 *    the line is owed again. One a line row of someone else precedes — an opponent's own cascade, cut off — is theirs and is
 *    never touched.
 * 3. Her `withdrew` walkovers (`walkoversOf`) are voided.
 *
 * Safe to run again: a void already written is no longer active, and a re-record already written is matched as a prefix of
 * what was removed. A line whose removed result cannot be put back is NAMED in `out.not_restored` and never blocks the rest.
 * Returns the stages it changed.
 */
async function takeBackLines(
  auth: AuthCtx,
  entrantId: string,
  divisionId: string,
  lines: readonly FixtureRowLite[],
  ledger: readonly { seq: number; type: string; payload: unknown }[],
  out: ReinstateTableOut,
): Promise<Set<string>> {
  const rows = withdrawalLineRows(ledger);
  const changed = new Set<string>();
  const voidEvent = async (fixtureId: string, eventId: string) => {
    const state = await getFixtureState(auth, fixtureId);
    await scoreEvent(auth, fixtureId, { expected_seq: state.last_seq, type: "core.void", payload: { event_id: eventId } }, CASCADE);
    out.voided++;
  };
  for (const f of lines) {
    const before = out.voided + out.rerecorded;
    const onLine = rows.filter((r) => r.fixture_id === f.id);
    for (const row of onLine) {
      if (row.retired || (row.entrant_id !== entrantId && !finishedAndReinstated(ledger, row))) continue;
      const events = await listEvents(auth, f.id, 0);
      const voided = new Set(events.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id as string));
      for (const e of activeAbandons(events).filter((a) => a.seq > row.from_seq && isExpunge(a)).sort((a, b) => b.seq - a.seq)) {
        await voidEvent(f.id, e.id);
      }
      const removed = row.planned_void_ids.filter((id) => voided.has(id));
      if (removed.length > 0 && !(await rerecordRemoved(auth, f.id, removed, out))) out.not_restored.push(f.id);
      await withTenant(auth.orgId, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
        await appendTableLedgerRow(tx, divisionId, TABLE_WITHDRAWAL_LINE_VOIDED_ROW, { voids_seq: row.seq }, auth.userId);
      });
    }
    const events = await listEvents(auth, f.id, 0);
    for (const e of activeAbandons(events).filter((a) => isExpunge(a) && !onLine.some((r) => r.from_seq < a.seq))) {
      await voidEvent(f.id, e.id);
    }
    for (const e of walkoversOf(events, entrantId)) await voidEvent(f.id, e.id);
    if (out.voided + out.rerecorded > before) changed.add(f.stage_id);
  }
  return changed;
}

const isExpunge = (e: EventOut) => (e.payload as { expunge?: unknown } | null)?.expunge === true;

const sameEvent = (a: EventOut, b: EventOut) => a.type === b.type && JSON.stringify(a.payload ?? null) === JSON.stringify(b.payload ?? null);

/** The writer an event's re-record needs. A writer-only event goes back through the writer that may record it — the
 *  organiser's No result (`core.abandon{noResult}`, rebase ruling D3) is refused from the cascade's — everything else
 *  through the cascade's (PF-2). A table line's No result is abandoned, never played, so the cascade does not remove one
 *  today; this keeps a re-record of one from blocking the Reinstate if it ever does. */
function rerecordOptions(e: EventOut): { writer: CascadeWriter } {
  const p = (e.payload ?? {}) as { noResult?: unknown };
  return e.type === "core.abandon" && p.noResult === true ? { writer: "organiser_no_result" } : CASCADE;
}

export interface ReinstateTableOut {
  voided: number;
  rerecorded: number;
  /** Fix round 2 (m3): the lines whose removed result could not be put back — rescored since the withdrawal (what follows
   *  the cascade's voids is not the start of what it removed), or a re-record the engine refused. Left as they are. */
  not_restored: string[];
}

/**
 * W5 T8 (RB5-W6, X-WDT-8; fix rounds 1-3): Reinstate REVERSES a league or group withdrawal.
 *
 * Her lines are taken back by `takeBackLines` — the ONE reading a resume of a cut-off cascade makes too. Re-review 2
 * (ruling C): what an expunge removed is read only from its write-ahead `table_withdrawal_line` rows, never from a list on
 * the `table_withdrawal` row (that field is gone: one authority) and never from the score ledger (it keeps no writer, so a
 * scorer's own Undo just before the withdrawal cannot be told from the cascade's voids after the fact). A removed result is
 * RE-RECORDED — a void is not voidable, and the engine's way to undo an undo is to record the event again
 * (events.js:354-357) — in its original order, type and payload; a signed-off line ends on its `core.finalize` again. A line
 * with no line row (a legacy withdrawal) has its expunge taken back and nothing re-recorded: the line is owed again. Her
 * walkovers return to scheduled. Last, her `table_withdrawal` rows are voided (the footnote goes) and each stage refolded.
 *
 * Safe to run again (m2): a void already written is no longer active, and a re-record already written is matched as a
 * prefix of what was removed, so a retry after a failure part-way finishes the job and writes nothing twice. A line whose
 * events after the removing voids are NOT that prefix (rescored since), or whose re-record the engine refuses, is left as
 * it is and NAMED in `not_restored` — it never blocks the rest.
 *
 * Skipped: a line whose other side is still departed (the shared line of two withdrawals stays out until both are back)
 * and a stage already complete (RB5-L8: a finished table takes no one, and its lines are not reopened). Called by
 * `patchEntrant` for a Reinstate (a departed prior status), under the cascade lock, when `tableReinstateOwed` says a reverse is owed.
 */
export async function reinstateTableEntrant(auth: AuthCtx, entrantId: string): Promise<ReinstateTableOut> {
  const entrant = await getEntrant(auth, entrantId);
  if (!inTheField(entrant)) {
    throw new Error(`reinstateTableEntrant: entrant ${entrantId} is ${entrant.status} — write the Reinstate first`);
  }
  const [stages, fixtures, entrants, ledger] = await Promise.all([
    listStages(auth, entrant.division_id),
    listDivisionFixtures(auth, entrant.division_id),
    listEntrants(auth, entrant.division_id),
    tableWithdrawalLedger(auth, entrant.division_id),
  ]);
  const open = new Map(stages.filter((st) => ROUND_ROBIN_KINDS.has(st.kind) && st.status !== "complete").map((st) => [st.id, st]));
  const gone = new Set(entrants.filter((e) => DEPARTED_STATUSES.has(e.status)).map((e) => e.id));
  const rows = activeTableWithdrawals(ledger).filter((r) => r.entrant_id === entrantId && open.has(r.stage_id));
  const out: ReinstateTableOut = { voided: 0, rerecorded: 0, not_restored: [] };
  const lines = (fixtures as unknown as FixtureRowLite[]).filter((f) => open.has(f.stage_id) && sharedWithTheField(f, entrantId, gone));
  const touched = new Map<string, { id: string; kind: string }>();
  for (const id of await takeBackLines(auth, entrantId, entrant.division_id, lines, ledger, out)) {
    touched.set(id, { id, kind: open.get(id)!.kind });
  }
  // The footnote's rows: voided for every stage she is back in (a finished table's row stands with it, RB5-L8).
  if (rows.length > 0) {
    await withTenant(auth.orgId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + entrant.division_id}))`;
      for (const record of rows) await appendTableLedgerRow(tx, entrant.division_id, TABLE_WITHDRAWAL_VOIDED_ROW, { voids_seq: record.seq }, auth.userId);
    });
    for (const record of rows) touched.set(record.stage_id, { id: record.stage_id, kind: open.get(record.stage_id)!.kind });
  }
  // RB5-W1's reverse: back in the field, she ranks by her results again.
  for (const stage of touched.values()) await refoldStageTable(auth.orgId, stage, "skip");
  return out;
}

/** Re-record one line's removed events (`ids`, from the row) that are not back yet. False when they cannot be put back:
 *  an id the line does not hold or that is not voided, events after the removing voids that are not the start of the
 *  removed run (rescored since), or a re-record the engine refuses. A SEQ_CONFLICT (another writer got ahead) is thrown —
 *  the retry is safe. */
async function rerecordRemoved(auth: AuthCtx, fixtureId: string, ids: readonly string[], out: ReinstateTableOut): Promise<boolean> {
  const events = await listEvents(auth, fixtureId, 0);
  const byId = new Map(events.map((e) => [e.id, e]));
  const voidOf = new Map(events.filter((e) => e.voids_event_id !== null).map((e) => [e.voids_event_id as string, e]));
  const targets = ids.map((id) => byId.get(id));
  if (targets.some((t) => t === undefined || !voidOf.has(t.id))) return false;
  const run = (targets as EventOut[]).sort((a, b) => a.seq - b.seq);
  const anchor = Math.max(...run.map((t) => voidOf.get(t.id)!.seq));
  const since = events.filter((e) => e.seq > anchor && e.type !== "core.void" && !voidOf.has(e.id)).sort((a, b) => a.seq - b.seq);
  if (since.length > run.length || !since.every((e, i) => sameEvent(e, run[i]!))) return false;
  for (const e of run.slice(since.length)) {
    const state = await getFixtureState(auth, fixtureId);
    try {
      await scoreEvent(auth, fixtureId, { expected_seq: state.last_seq, type: e.type, payload: (e.payload ?? {}) as Record<string, unknown> } as never, rerecordOptions(e));
    } catch (err) {
      if (err instanceof EngineError && err.code !== "SEQ_CONFLICT") {
        log.warn({ err, fixture: fixtureId, type: e.type }, "reinstate: a removed result could not be re-recorded (left as it is)");
        return false;
      }
      throw err;
    }
    out.rerecorded++;
  }
  return true;
}

async function tableWithdrawalLedger(auth: AuthCtx, divisionId: string) {
  return withTenant(auth.orgId, (tx) =>
    tx<{ seq: number; type: string; payload: unknown }[]>`
      select seq::int as seq, type, payload from division_events
       where division_id = ${divisionId} and type in (${TABLE_WITHDRAWAL_ROW}, ${TABLE_WITHDRAWAL_VOIDED_ROW}, ${TABLE_WITHDRAWAL_LINE_ROW}, ${TABLE_WITHDRAWAL_LINE_VOIDED_ROW})`,
  );
}

/**
 * Fix round 2 (m2): is a Reinstate's reverse still owed for this entrant? True while one of her lines in an unfinished league
 * or group stage still carries an active cascade event (`core.abandon{expunge}` or her `withdrew` forfeit) against a side
 * still in the field, or while her `table_withdrawal` row for such a stage is still active. `patchEntrant` asks this only for a
 * Reinstate (a status into the field over a departed prior status), under the cascade lock (B3 I-1): asked of every write it
 * ran beside a live cascade, whose own expunges made it true.
 */
export async function tableReinstateOwed(auth: AuthCtx, entrantId: string, divisionId: string): Promise<boolean> {
  const [hit] = await withTenant(auth.orgId, (tx) =>
    tx<{ one: number }[]>`
      select 1 as one
        from score_events e
        join fixtures f on f.id = e.fixture_id
        join stages s on s.id = f.stage_id
        left join entrants o on o.id = case when f.home_entrant_id = ${entrantId} then f.away_entrant_id else f.home_entrant_id end
       where s.division_id = ${divisionId}
         and s.kind in ('league', 'group') and s.status <> 'complete'
         and ${entrantId} in (f.home_entrant_id, f.away_entrant_id)
         and o.status = any(${FIELD_STATUSES as string[]})
         and not exists (select 1 from score_events v where v.voids_event_id = e.id)
         and ((e.type = 'core.abandon' and e.payload->'expunge' = 'true'::jsonb)
           or (e.type = 'core.forfeit' and e.payload->>'reason' = ${REASON} and e.payload->>'by' = ${entrantId}))
       limit 1`,
  );
  if (hit !== undefined) return true;
  const [stages, ledger] = await Promise.all([listStages(auth, divisionId), tableWithdrawalLedger(auth, divisionId)]);
  const open = new Set(stages.filter((st) => ROUND_ROBIN_KINDS.has(st.kind) && st.status !== "complete").map((st) => st.id));
  return activeTableWithdrawals(ledger).some((r) => r.entrant_id === entrantId && open.has(r.stage_id));
}
