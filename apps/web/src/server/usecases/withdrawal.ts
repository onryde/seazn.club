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
//   - americano: remaining games void (expunged); the standings they earned
//     stand.
// The surgery itself rides the scoring ledger — core.forfeit{reason:
// "withdrew"} for walkovers, core.void + core.abandon{expunge: true} for
// expunges (D5) — so standings recompute, undo works and the public cache
// invalidates exactly like any other scoring write. Two writes carry no event,
// as `awardSeededByes` writes a bye: the dead seat and the double walkover
// (`writeDepartedSeat`, stages.ts). Every ledger write names its writer
// (`withdrawal_cascade`): PF-2 refuses `withdrew` and `expunge` from anyone
// else. Not one transaction (ruling 101): each write commits on its own.
// Finalized fixtures are locked (spec 03) and are reported, not touched.
import { deciderPending, playRecorded } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import {
  withdrawBracketEntrant,
  withdrawTableEntrant,
  type BracketFixture,
  type FixtureUpdate,
} from "@seazn/engine/competition";
import { feedsNextMatch } from "@/lib/bracket-next-match";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { resolveModule } from "@/server/engine-db/registry";
import { rowAwaitsSettle } from "@/server/engine-db/recorded-abandon";
import {
  WITHDRAWAL_PENDING_STATUSES,
  WITHDRAWAL_PLAYED_STATUSES,
  tableWithdrawalInputs,
} from "@/lib/table-withdrawal";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { DEPARTED_STATUSES, getEntrant, listEntrants, patchEntrant } from "./entrants";
import { getDivision } from "./divisions";
import { BRACKET_WALKOVER_KINDS, listStages, writeDepartedSeat } from "./stages";
import { listDivisionFixtures, listEvents, getFixtureState, type EventOut } from "./fixtures";
import { invalidatePublicCache, scoreEvent } from "./scoring";

const TABLE_KINDS = new Set(["league", "group", "swiss"]);
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

export interface WithdrawCascadeOut {
  entrant_id: string;
  status: "withdrawn";
  /** Which policy the engine picked per spec 05 §5. */
  policy: "none" | "walkover" | "expunge";
  walkovers: number;
  voided: number;
  /** Finalized fixtures are immutable — listed so the organiser knows. */
  skipped_finalized: number;
  /** W2b: of `walkovers`, the lines that were HELD (a level result, a tie-break owed, a scorer's abandon) — each was
   *  waiting for the organiser's settle under W2a, and is walked over now (merge notice N1). */
  walked_over_held: number;
  /** Loop R M-5: the fixtures both of whose sides have now gone (X-WD-4) but where play was recorded (`playRecorded`) —
   *  written nothing, never overwritten: each is the organiser's ledger to void or settle. W2c X-AB-5: and a table
   *  stage's board of theirs that was ABANDONED with no result (a Swiss board holds the next round) - left as it stands,
   *  still owed the organiser's settle (the opponent can be chosen; the departed entrant cannot, C17). */
  left_to_organiser: string[];
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
}

/** Void every effective (not-yet-voided) state-bearing event, newest first,
 *  then abandon — the expunge path for a fixture that already has a result. */
async function voidAndAbandon(auth: AuthCtx, fixtureId: string): Promise<void> {
  const events = await listEvents(auth, fixtureId, 0);
  const voidedIds = new Set(
    events.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id as string),
  );
  const targets = events
    .filter(
      (e) =>
        !["core.start", "core.void", "core.note", "core.award"].includes(e.type) &&
        !voidedIds.has(e.id),
    )
    .sort((a, b) => b.seq - a.seq);
  for (const target of targets) {
    const state = await getFixtureState(auth, fixtureId);
    await scoreEvent(auth, fixtureId, {
      expected_seq: state.last_seq,
      type: "core.void",
      payload: { event_id: target.id },
    });
  }
  await expungeAbandon(auth, fixtureId);
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
): Promise<void> {
  if (fixture.status === "finalized" || fixture.status === "cancelled") {
    out.skipped_finalized++;
    return;
  }
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
  // void — pending fixtures abandon directly; resulted ones expunge first.
  if (SETTLED.has(fixture.status) && fixture.outcome !== null) {
    await voidAndAbandon(auth, fixture.id);
  } else {
    await expungeAbandon(auth, fixture.id);
  }
  out.voided++;
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

export async function withdrawEntrantCascade(
  auth: AuthCtx,
  entrantId: string,
): Promise<WithdrawCascadeOut> {
  const entrant = await getEntrant(auth, entrantId);
  if (entrant.status === "withdrawn") {
    throw new HttpError(409, "entrant is already withdrawn");
  }
  const division = await getDivision(auth, entrant.division_id);
  const out: WithdrawCascadeOut = {
    entrant_id: entrantId,
    status: "withdrawn",
    policy: "none",
    walkovers: 0,
    voided: 0,
    skipped_finalized: 0,
    walked_over_held: 0,
    left_to_organiser: [],
  };

  // Before the tournament starts there is nothing to settle: fixtures (if
  // generated) are regenerated from the field anyway — plain status flip.
  if (division.status === "active" || division.status === "completed") {
    const [stages, fixtures] = await Promise.all([
      listStages(auth, division.id),
      listDivisionFixtures(auth, division.id),
    ]);
    const sportModule = resolveModule(division.sport_key, division.module_version);
    const byStage = new Map<string, FixtureRowLite[]>();
    for (const f of fixtures as unknown as FixtureRowLite[]) {
      if (f.home_entrant_id !== entrantId && f.away_entrant_id !== entrantId) continue;
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

      if (TABLE_KINDS.has(stage.kind)) {
        // lib/table-withdrawal: the ONE reading of these rows into the policy's
        // input (the qualification builder reads the same verdict, ruling F1).
        const { played, pending } = tableWithdrawalInputs(entrantId, mine);
        const result = withdrawTableEntrant(
          {
            id: stage.id,
            kind: stage.kind as "league" | "group" | "swiss",
            // The policy only counts involvement — field and cascade are
            // irrelevant to it, but the type carries them for the rankers.
            entrants: [entrantId],
            cascade: [],
          },
          entrantId,
          { played, pending },
        );
        const mode = result.events[0]?.type === "entrant_withdrawn" ? result.events[0].mode : undefined;
        out.policy = mode === "expunge" ? "expunge" : out.policy === "expunge" ? "expunge" : "walkover";
        for (const u of result.updates) {
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
          { id: stage.id, kind: stage.kind as "knockout" | "double_elim" | "stepladder" },
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
      } else {
        // americano: remaining games void (expunged, D5); earned standings stand.
        for (const f of mine) {
          if (PENDING.has(f.status)) plan.push({ update: { fixtureId: f.id, status: "void" }, fixture: f });
        }
        if (out.policy === "none" && plan.length > 0) out.policy = "walkover";
      }
    }

    // X-WD-4: who has already left (`DEPARTED_STATUSES`: withdrawn or disqualified) — an opponent on this list gets no
    // walkover (it would seat a departed entrant).
    const gone = new Set(
      (await listEntrants(auth, division.id)).filter((e) => DEPARTED_STATUSES.has(e.status)).map((e) => e.id),
    );
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
            out.walkovers++;
          }
          continue;
        }
      } else if (u.status === "walkover" && !u.walkoverTo) {
        // A table stage's TBD opponent can't receive a walkover — void that slot instead.
        step.update = { fixtureId: u.fixtureId, status: "void" };
      } else if (u.status === "walkover" && gone.has(u.walkoverTo!)) {
        // Loop R M-4 (controller ruling 2026-10-13): signed X-WD-4 (ruling 90) has no bracket scope. In a league, group
        // or Swiss round the opponent who already left (a bare status write — ruling 111's self-withdrawal, which
        // cascades nothing) is still seated, and a walkover would hand her the points and the walkover score. Both
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
          out.walkovers++;
        }
        continue;
      }
      await applyUpdate(auth, step.update, step.fixture, out, step.bracket?.held === true);
    }
  }

  await patchEntrant(auth, entrantId, { status: "withdrawn" });
  return out;
}
