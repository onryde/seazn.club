// certificate.ts — the feasibility certificate (design §3.4, parent spec §6.3).
//
// Pure. No I/O, no clock, no logging, no HTTP, no randomness — a function of
// its one argument and nothing else. Every import is `import type` except
// `checkBoard`, and that one is the point of the module.
//
// -------------------------------------------------------------------------
// The order IS the protocol
// -------------------------------------------------------------------------
//
// This module answers one question: when the solver says `infeasible`, whose
// defect is it? Reading that status as a product defect BEFORE checking our
// own encoding is how a pack-authoring bug gets filed against the solver —
// the single worst output a harness whose only product is "the product is
// wrong here" can produce. So the branches are evaluated in this order and
// the order is load-bearing, not incidental:
//
//   1. no `historicalAssignment` for this division  -> SKIPPED_NO_HISTORY
//   2. history breaches our own encoding            -> PACK_AUTHORING_BUG
//   3. history clean AND solver `infeasible`        -> PRODUCT_DEFECT
//   4. `placed < total`                             -> UNPLACED
//   5. otherwise                                    -> FEASIBLE
//
// Branches 2 and 3 are the pair the protocol exists for. Branch 4 sits BELOW
// branch 3 — design §3.4's table order, and ruling R27 — because once the
// solver has declared `infeasible`, `placed < total` is a CONSEQUENCE of that
// infeasibility. Reporting UNPLACED there names the SYMPTOM while
// PRODUCT_DEFECT names the CAUSE, and naming the cause is the entire purpose
// of this certificate.
//
// Read the other way, that ordering is what leaves branch 4 the job parent
// spec §6.3 actually describes for it: "UNKNOWN/timeout leaving fixtures
// unplaced" — a board the product failed to fill WITHOUT declaring the
// problem infeasible. Ranking branch 4 above branch 3 would swallow that
// distinction in precisely the case where the certificate has the most to
// say.
//
//   An earlier build of this file evaluated the unplaced gate third,
//   following the task brief's Step 3 prose. The plan was wrong and the
//   design right; ruling R27 corrected the plan. Exactly ONE test can tell
//   the two orders apart — `infeasible` AND `placed < total` must land on
//   PRODUCT_DEFECT — so that test is load-bearing rather than illustrative,
//   and it is the one thing standing between two shippable behaviours.
//
// -------------------------------------------------------------------------
// Why `checkBoard` verbatim, and never a second implementation
// -------------------------------------------------------------------------
//
// The claim the certificate makes is precisely "the same rules that judged
// the product's board also judged the real tournament's timetable". Two
// implementations cannot make that claim — they can only make the weaker one
// that two pieces of code agreed today — and the moment one grows a rule the
// other has not, the certificate starts attributing the DIFFERENCE BETWEEN
// THE TWO CHECKERS to either the pack or the product. So `checkBoard` is
// imported as a value and called with the same `EncodedConstraints` the
// product's own board was judged against.
//
// Two consequences follow, and both are guards below rather than assumptions:
//
//   * `checkBoard` SKIPS unplaced fixtures (checker.ts, convention 2). A
//     history board whose fixtures carry no `start` therefore comes back
//     `clean` having measured nothing, and the certificate would report
//     FEASIBLE on no evidence — the false-clean class design §1.4 exists to
//     prevent. Every historical row carries a REQUIRED `startsAt`
//     (`pack-schema.ts:844`), so such a board is a rendering fault, and it
//     throws.
//   * `CheckerReport.clean` is the checker's OWN verdict and the single
//     authority on it (board.ts). This module reads that field and never
//     re-derives it from `findings.length`, exactly as `judgeDivision` does.
//     `unchecked` never makes history dirty: it is the list of constraints
//     this build does not model, and treating it as a breach would file a
//     pack-authoring bug against every pack that declared one.

import { checkBoard } from "./checker.ts";
import type {
  Board,
  CertificateBranch,
  CertificateVerdict,
  CheckerFinding,
  EncodedConstraints,
} from "./board.ts";
import type { PackHistoricalAssignment } from "./pack-schema.ts";

/** Which branches red, stated ONCE.
 *
 *  A total `Record` over the union rather than a boolean computed beside each
 *  return: a sixth branch cannot be added without a redness ruling (tsc
 *  refuses the incomplete record, and `certificate.ts` is inside
 *  `tsconfig.scripts.json`'s `include`), and a verdict whose `red` disagrees
 *  with its `branch` is unrepresentable. Same discipline as `judgeDivision`
 *  deriving `red` from `reasons.length`. */
const RED_BY_BRANCH: Readonly<Record<CertificateBranch, boolean>> = {
  SKIPPED_NO_HISTORY: false,
  PACK_AUTHORING_BUG: true,
  PRODUCT_DEFECT: true,
  UNPLACED: true,
  FEASIBLE: false,
};

/** Shared empty list, so four branches cannot each allocate a subtly
 *  different "nothing". */
const NO_VIOLATIONS: readonly CheckerFinding[] = [];

/** The solver status that means the product could not place this board.
 *  `ScheduleSolverInfo.status` is a lowercase zod enum
 *  (`apps/web/src/server/api-v1/schemas.ts:1731`), so this is an exact
 *  comparison and not a case-folded one — a case-folded match here would
 *  quietly accept a status the product never emits. */
const INFEASIBLE = "infeasible";

function verdict(
  branch: CertificateBranch,
  reason: string,
  violations: readonly CheckerFinding[],
): CertificateVerdict {
  return { branch, reason, violations, red: RED_BY_BRANCH[branch] };
}

/** `judgeDivision` prints `certificate <BRANCH> — <reason>`, so every reason
 *  is written as a sentence FRAGMENT that reads on from an em dash. */
export function certify(input: {
  historical: readonly PackHistoricalAssignment[] | undefined;
  /** History rendered into a `Board` by the caller — required whenever this
   *  division declares any historical row. */
  historyBoard: Board | undefined;
  constraints: EncodedConstraints;
  /** `ScheduleSolverInfo.status`, forwarded verbatim. */
  solverStatus: string | undefined;
  /** `metrics.placed` / `metrics.total` — the solver's PROPOSAL, which is what
   *  parent spec §6.3's gate names. Deliberately not `ScheduleOutcome`'s
   *  `unplacedCount`, which counts the FETCHED board and is
   *  `judgeDivision`'s own fourth trigger; the two answer different
   *  questions and merging them would lose one of them. */
  placed: number;
  total: number;
}): CertificateVerdict {
  const ref = input.constraints.divisionRef;

  // -------------------------------------------------------------------
  // Branch 1 — no history for THIS division
  // -------------------------------------------------------------------
  //
  // Filtered on `divisionRef` rather than taken on trust, because both sides
  // carry one (`PackHistoricalAssignment.divisionRef`, `EncodedConstraints.
  // divisionRef`) and a caller holding the whole pack has no obligation to
  // pre-split the list. Without the filter, a division with no history of its
  // own would be certified against ANOTHER division's timetable and the
  // resulting breach filed as this pack's authoring bug.
  //
  // An EMPTY list is a declaration of nothing, and lands here rather than
  // running an empty board through `checkBoard`: an empty set satisfies every
  // rule, so that path would report a clean history having measured no rows.
  const declared = (input.historical ?? []).filter((row) => row.divisionRef === ref);
  if (declared.length === 0) {
    return verdict(
      "SKIPPED_NO_HISTORY",
      `the pack declares no historicalAssignment for ${ref}, so there is no real timetable to check our encoding against`,
      NO_VIOLATIONS,
    );
  }

  // The two wiring guards. Both throw rather than returning a verdict: the
  // five branches are a closed protocol about the PACK and the PRODUCT, and
  // neither of these is a fact about either. Returning SKIPPED_NO_HISTORY
  // instead would turn a caller that forgot to render history into a
  // permanently green certificate — an absent symptom that means suppressed,
  // not safe. Throwing follows `encodeConstraints`, which refuses an
  // unresolvable court ref rather than silently widening it.
  const board = input.historyBoard;
  if (board === undefined) {
    throw new Error(
      `certificate: ${ref} declares ${declared.length} historicalAssignment row(s) but no historyBoard was rendered — a bench wiring fault, not a pack or product one`,
    );
  }
  if (!board.fixtures.some((f) => typeof f.start === "number")) {
    throw new Error(
      `certificate: ${ref} declares ${declared.length} historicalAssignment row(s) but the rendered historyBoard carries no placed fixture — checkBoard skips unplaced fixtures, so certifying it would report a clean history having measured nothing`,
    );
  }

  // -------------------------------------------------------------------
  // Branch 2 — our own encoding, judged against reality
  // -------------------------------------------------------------------
  //
  // BEFORE the solver's verdict is read, and before the counts. `clean` is
  // the checker's own answer and is never re-derived here.
  const history = checkBoard(board, input.constraints);
  if (!history.clean) {
    // Deduped and ordered by first appearance, matching `judgeDivision`'s
    // summary line: eleven repeats of one kind bury the other ten.
    const kinds = [...new Set(history.findings.map((f) => f.kind))];
    const named = kinds.length > 0 ? kinds.join(", ") : "none named";
    return verdict(
      "PACK_AUTHORING_BUG",
      `the real timetable breaches our own encoding (${history.findings.length} findings: ${named}) — the pack encoded constraints stricter than reality, so fix the pack, not the solver`,
      history.findings,
    );
  }

  // -------------------------------------------------------------------
  // Branch 3 — history is clean, so an infeasible solve is the product's
  // -------------------------------------------------------------------
  //
  // ABOVE the unplaced gate, deliberately: an `infeasible` solve that also
  // stranded fixtures is ONE event, and this is the branch that names its
  // cause. See the ordering note in this module's header.
  if (input.solverStatus === INFEASIBLE) {
    return verdict(
      "PRODUCT_DEFECT",
      `the real timetable satisfies the very encoding we handed the solver, so a status of "${INFEASIBLE}" is the product's defect and not the pack's`,
      NO_VIOLATIONS,
    );
  }

  // -------------------------------------------------------------------
  // Branch 4 — parent spec §6.3's unplaced-fixture gate
  // -------------------------------------------------------------------
  //
  // Reached only when the solver did NOT declare the problem infeasible, so
  // this is §6.3's "UNKNOWN/timeout leaving fixtures unplaced" — the product
  // failed to fill the board without saying it could not.
  //
  // `<` and never `!==`: a board carrying MORE placed rows than the proposal
  // counted is not an unplaced-fixture defect, and reporting one would send a
  // reader hunting for a fixture that is on the board.
  if (input.placed < input.total) {
    return verdict(
      "UNPLACED",
      `the real timetable satisfies our encoding, but the product placed ${input.placed} of ${input.total} fixtures (solver status ${input.solverStatus ?? "absent"})`,
      NO_VIOLATIONS,
    );
  }

  // -------------------------------------------------------------------
  // Branch 5 — history is clean and a full board came back
  // -------------------------------------------------------------------
  //
  // NOT a claim that the board is good: hard violations on the PRODUCT's
  // board are `checkBoard`'s verdict on that board, a separate layer, and
  // aesthetics are report-only believability metrics. This says only that the
  // encoding admits a real timetable and every fixture found a slot.
  return verdict(
    "FEASIBLE",
    `the real timetable satisfies our encoding and the product placed all ${input.total} fixtures (solver status ${input.solverStatus ?? "absent"})`,
    NO_VIOLATIONS,
  );
}
