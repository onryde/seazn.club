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
  | { kind: "assign_scorer" }
  | { kind: "score" }
  | { kind: "result" }
  | { kind: "set_time" }
  | { kind: "view" };

export type RowActionInput = {
  status: FixtureRow["status"];
  scheduledAt: FixtureRow["scheduled_at"];
  /** Any officials recorded on the fixture — the "no scorer" signal. Callers
   *  derive this as `fixture.officials.length > 0` (`FixtureRow.officials` is
   *  `unknown[]` in `@/server/usecases/stages`); this function takes the
   *  boolean as an input and does not derive it itself. */
  hasOfficials: boolean;
  canEdit: boolean;
  /** The VENUE zone (`scheduleSettings.tz`), for both bucketing and printing.
   *  Never the org zone: one zone per fixture (_RULES.md). */
  tz: string;
  nowMs: number;
};

export function fixtureRowAction(input: RowActionInput): RowAction {
  const { status, scheduledAt, hasOfficials, canEdit, tz, nowMs } = input;

  // 1. Live beats everything. A match in play is the one thing an organiser
  //    standing at the venue is looking for, whatever its time says.
  if (status === "in_play") return { kind: "open_pad" };

  // 2. Settled. Checked before the scheduling rules below so a cancelled match
  //    never invites an organiser to score a match that will not be played.
  if (SETTLED.has(status)) return { kind: "result" };

  // 3. Anything not "scheduled" by now is a status this table does not know.
  //    Read-only rather than a guess — an invented action on an unknown state
  //    is how a wrong write path gets offered.
  if (status !== "scheduled") return { kind: "view" };

  // 4. Scheduled with no time: the missing fact IS the action.
  if (scheduledAt === null) return canEdit ? { kind: "set_time" } : { kind: "view" };

  // 5. Scheduled TODAY in the venue zone with nobody to score it. Not "any day
  //    with no scorer" — a fixture three weeks out with no scorer is not yet a
  //    problem, and printing it as one on every row is the noise this wave
  //    exists to remove ("an empty cell is not information").
  const today = dayKeyInTz(nowMs, tz);
  const day = dayKeyInTz(Date.parse(scheduledAt), tz);
  if (day === today && !hasOfficials) return { kind: "assign_scorer" };

  // 6. Otherwise: score it.
  return { kind: "score" };
}
