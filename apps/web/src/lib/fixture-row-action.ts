// fixture-row-action.ts — the ONE authority for the single action a run-sheet
// row offers. Pure and client-safe: `import type` from @/server is erased, so
// this never drags server-only code into the client bundle.
//
// This is a LADDER: the first matching branch wins, so a rule's POSITION is
// part of its meaning and no grep can see it (_RULES.md, "the phase ladder is
// ORDER, not a set of predicates"). Do not reorder without reading
// fixture-row-action.test.ts's ORDER describe block, which exists to kill a
// reordering mutant.
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import type { FixtureRow } from "@/server/usecases/stages";

/** Statuses that mean "this match has an outcome" — not open work. Derived from
 *  the API status set (design §W1 `PhaseInput`), never retyped per call site.
 *  The three beyond decided/finalized (cancelled, abandoned, forfeited) are
 *  deliberately the same list as `VOID_STATUSES` in stages-panel.tsx — not
 *  imported from there (that set is module-private in a component, and a lib
 *  must not import from a component), but the two are meant to move together. */
const SETTLED = new Set(["decided", "finalized", "abandoned", "forfeited", "cancelled"]);

export type RowAction =
  | { kind: "open_pad" }
  | { kind: "decide" }
  | { kind: "assign_scorer" }
  | { kind: "score" }
  | { kind: "result" }
  | { kind: "set_time" }
  | { kind: "view" };

export type RowActionInput = {
  status: FixtureRow["status"];
  scheduledAt: FixtureRow["scheduled_at"];
  /** Somebody is actually coming to score this fixture — the "no scorer"
   *  signal. Callers derive it with `hasAssignedScorer(fixture.officials)`
   *  below, never `officials.length > 0`; this function takes the boolean as
   *  an input and does not derive it itself. */
  hasOfficials: boolean;
  canEdit: boolean;
  /** The VENUE zone (`scheduleSettings.tz`), for both bucketing and printing.
   *  Never the org zone: one zone per fixture (_RULES.md). */
  tz: string;
  nowMs: number;
  /** F5 (W2 walkthrough gate 1): true when either side is still a TBD slot
   *  (`home_entrant_id`/`away_entrant_id` null — a bracket round drawn from
   *  "Winner of R1·N" placeholders, pre-draw). `RunSheetRow` already computes
   *  this identically for its own sub-line ("Awaiting draw") — this is the
   *  SAME fact, threaded in rather than re-derived, so the label and the
   *  action can never disagree about which fixtures are undrawn. */
  awaitingDraw: boolean;
};

/**
 * The ONE fixture status the server will accept a timetable move for.
 *
 * `moveFixture` (server/usecases/schedule.ts) refuses any other outright —
 * `if (movesTimetable && fixture.status !== MOVABLE_STATUS) throw new
 * HttpError(422, "fixture is X — decided fixtures are immutable")`. This is a
 * deliberate hand-copy of that server constant, for the same reason `SETTLED`
 * above is one: a client component cannot import from `@/server` (it breaks
 * the build), and this is the client's half of the same fact. The two are
 * PINNED TOGETHER by `fixture-row-action.test.ts`, which imports the server
 * module (vitest is node-env) and asserts they are equal — the
 * `bracket-kinds-sync.test.ts` pattern this repo already uses for its other
 * three hand-copied lists.
 *
 * Getting this wrong is not cosmetic: offering an edit control on a decided
 * row produces a control that 422s on save, which is the dead-end class this
 * whole wave exists to remove.
 */
export const TIMETABLE_MOVABLE_STATUS = "scheduled";

/**
 * The ONE reader of the `fixtures.officials` cache's `response` field, and the
 * only correct derivation of `RowActionInput.hasOfficials`.
 *
 * Max-effort review, finding 8. The cache is rebuilt by `refreshOfficialsCache`
 * (server/usecases/officials.ts) with NO response filter, so a DECLINED
 * appointment stays in the aggregate. `officials.length > 0` therefore answers
 * "somebody was asked", not "somebody is coming" — and it reads TRUE precisely
 * when the invited scorer has said no, which is the one morning the row most
 * needs to keep nudging. The server already draws this distinction where it
 * matters (`officials.ts:170`: `and fo.response <> 'declined'`); this is the
 * client's half of the same fact.
 *
 * Deliberately NOT fixed by adding the filter to `refreshOfficialsCache`: that
 * column has other readers (the fixture console's officials list, which must
 * still show a decline and its reason), so narrowing the cache would hide data
 * those surfaces need. The narrowing belongs at the question, not the store.
 *
 * A missing or null `response` is an invitation nobody has answered yet — that
 * still means somebody has been asked, so it counts. Only an explicit
 * "declined" is a refusal. Total by construction: the wire type is `unknown[]`
 * and a malformed element must never throw a match-day render.
 */
export function hasAssignedScorer(officials: readonly unknown[]): boolean {
  return officials.some((o) => {
    if (typeof o !== "object" || o === null) return false;
    return (o as { response?: unknown }).response !== "declined";
  });
}

/**
 * Is this row's DISPLAYED TIME an affordance — does clicking it open the
 * inline editor?
 *
 * Owner ruling, fix round 5: "correct a time already set" is a regression
 * that must be restored, and the shape is the TIME CELL ITSELF rather than a
 * second row-level control — the action column keeps exactly one control
 * (which is the row's design premise), the organiser clicks the fact they
 * want to change, and this ladder needs no new branch, so its order-pinned
 * tests stay valid.
 *
 * Three conditions, each load-bearing:
 *  - `canEdit` — a viewer without write rights gets a plain label.
 *  - status is `TIMETABLE_MOVABLE_STATUS` — anything else 422s on save.
 *  - a time actually exists — an unscheduled row shows an em-dash and
 *    already reaches this same editor through its `set_time` action; making
 *    the dash a second door would be a poor target for no new capability.
 */
export function canEditFixtureTime(input: {
  status: RowActionInput["status"];
  scheduledAt: RowActionInput["scheduledAt"];
  canEdit: boolean;
}): boolean {
  return input.canEdit && input.status === TIMETABLE_MOVABLE_STATUS && input.scheduledAt !== null;
}

export function fixtureRowAction(input: RowActionInput): RowAction {
  const { status, scheduledAt, hasOfficials, canEdit, tz, nowMs, awaitingDraw } = input;

  // 1. Live beats everything. A match in play is the one thing an organiser
  //    standing at the venue is looking for, whatever its time says.
  if (status === "in_play") return { kind: "open_pad" };

  // 1b. W2a (finding 25): HELD — a bracket match that ended level is owed the organiser's settle, and nothing else
  //     moves until it gets one. Neither a result (nobody advanced) nor open scoring (the match is over). The settle
  //     is organiser-only on the server, so a viewer who cannot edit only views it.
  if (status === "needs_decision") return canEdit ? { kind: "decide" } : { kind: "view" };

  // 2. Settled. Checked before the scheduling rules below so a cancelled match
  //    never invites an organiser to score a match that will not be played —
  //    and before the awaiting-draw check below, since a decided match with a
  //    TBD-labelled loser (a walkover recorded before the OTHER semi finished)
  //    is still a result, not a match still waiting on its draw.
  if (SETTLED.has(status)) return { kind: "result" };

  // 3. Anything not "scheduled" by now is a status this table does not know.
  //    Read-only rather than a guess — an invented action on an unknown state
  //    is how a wrong write path gets offered.
  if (status !== "scheduled") return { kind: "view" };

  // 4. Scheduled with no time: the missing fact IS the action. Offered even
  //    when the entrants are still undrawn — pre-scheduling a bracket round's
  //    slot (court/time) ahead of the draw that fills it is an ordinary
  //    organiser action, and nothing below this line criticises it.
  if (scheduledAt === null) return canEdit ? { kind: "set_time" } : { kind: "view" };

  // 5. F5 (W2 walkthrough gate 1): a TIMED fixture whose entrants are still
  //    undrawn ("Winner of R1·3" vs "Winner of R1·4") cannot be scored and has
  //    nobody to assign a scorer FOR — both of the branches below presuppose
  //    entrants that exist. Checked after step 4 (an untimed, undrawn fixture
  //    still offers `set_time`) and before assign_scorer/score, which is the
  //    dead-end this finding names: "Awaiting draw" beside a "Score" button.
  if (awaitingDraw) return { kind: "view" };

  // 6. Scheduled TODAY in the venue zone with nobody to score it. Not "any day
  //    with no scorer" — a fixture three weeks out with no scorer is not yet a
  //    problem, and printing it as one on every row is the noise this wave
  //    exists to remove ("an empty cell is not information").
  const today = dayKeyInTz(nowMs, tz);
  const day = dayKeyInTz(Date.parse(scheduledAt), tz);
  if (day === today && !hasOfficials) return { kind: "assign_scorer" };

  // 7. Otherwise: score it.
  return { kind: "score" };
}
