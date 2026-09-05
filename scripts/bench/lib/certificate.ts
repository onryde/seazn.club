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
// Three consequences follow, and all three are guards below rather than
// assumptions:
//
//   * `checkBoard` SKIPS unplaced fixtures (checker.ts, convention 2), and a
//     skipped fixture is measured by no rule at all. So a history board that
//     is absent, partly rendered, or carrying a NaN `start` comes back `clean`
//     having examined less than the whole timetable — or none of it — and the
//     certificate would report FEASIBLE on that. Every historical row carries
//     a REQUIRED `startsAt` (`pack-schema.ts:844`), so every one of those is a
//     rendering fault rather than a fact about the pack, and each throws.
//     The coverage guard below is a per-ROW comparison, not "is anything
//     placed": one of three rendered satisfies the latter, and that is the
//     false clean that needs no malformed data to happen.
//   * The board must be the one this encoding describes. `checkBoard`
//     attributes every finding to `constraints.divisionRef` whatever board
//     produced it, so a mispaired board arrives as a confident, fully-formed,
//     wrong report that nothing downstream can notice.
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
  // The board and the encoding must describe the SAME division. The rows above
  // are filtered on `constraints.divisionRef`, so checking one side and taking
  // the other on trust would read as a considered decision rather than an
  // omission — and nothing downstream can catch it: `checkBoard` attributes
  // every finding to `constraints.divisionRef` whatever board produced it, so
  // a mispairing arrives as a confident, fully-formed, wrong report.
  if (board.divisionRef !== ref) {
    throw new Error(
      `certificate: the rendered historyBoard is for division ${board.divisionRef} but the encoding is for ${ref} — certifying one division's timetable against another's constraints is a bench wiring fault, not a pack or product one`,
    );
  }
  // The THIRD wiring guard, and the only one that was closing a wrong
  // POSITIVE verdict rather than a missing one.
  //
  // Branch 4 asks `placed < total`, and that comparison is `false` when
  // EITHER side is `NaN` — so a non-finite pair fell straight through to
  // branch 5 and certified FEASIBLE: the strongest claim this harness makes,
  // asserted about counts it could not read. `Infinity` is the same hole from
  // the other side (`3 < Infinity` is true, so it reports a shortfall against
  // an unbounded total), and a negative `total` is the NaN case again.
  //
  // Reachability is live rather than theoretical: `ScheduleOutcome.metrics`
  // is optional, so a caller deriving these from a solver that never answered
  // is one coercion away from a NaN — and `Number(null)` is a finite 0 while
  // `Number(undefined)` is `NaN`, so the two obvious spellings fail
  // differently.
  //
  // THROWS rather than returning a verdict, for the same reason as the two
  // guards above: the five branches are a closed protocol about the PACK and
  // the PRODUCT, and a count the bench could not read is a fact about
  // neither. `Number.isInteger` and not `Number.isFinite`, because a
  // fractional count of fixtures is as unreadable as a NaN one; `>= 0`
  // because a negative total reaches FEASIBLE through the very same false
  // comparison. A zero-fixture division is LEGAL and passes.
  for (const [name, value] of [
    ["placed", input.placed],
    ["total", input.total],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `certificate: ${ref} was handed ${name}=${String(value)} — placed/total must both be non-negative integers, and a non-finite one silently satisfies the unplaced gate and certifies FEASIBLE. A bench wiring fault, not a pack or product one`,
      );
    }
  }

  // `checkBoard`'s OWN placed predicate, restated rather than approximated.
  //
  // The `Number.isFinite` half is NOT redundant with the `typeof`, and the
  // difference is the whole reason this is spelled out: `checker.ts:182` skips
  // a NaN `start` as well as an absent one, because a NaN compares false
  // against every bound and would make every containment rule pass vacuously
  // for that fixture. A guard here that accepted a NaN as "rendered" would
  // hand the checker a fixture it then silently drops, and the certificate
  // would report a clean history it never examined. Any drift between these
  // two predicates reopens exactly that hole, so they are kept identical on
  // purpose — the difference would look deliberate to the next reader.
  const placedKeys = new Set<string>();
  for (const f of board.fixtures) {
    if (typeof f.start !== "number" || !Number.isFinite(f.start)) continue;
    if (f.extKey !== undefined) placedKeys.add(f.extKey);
  }

  // EVERY declared row must have a placed fixture, not merely one of them.
  // A partial render needs no malformed data to produce a false clean: a board
  // carrying one of three declared rows satisfies "is anything placed?", and
  // the checker then reports clean having measured a third of the timetable.
  // `extKey` (`BoardFixture`) and `fixtureExtKey` (`PackHistoricalAssignment`)
  // are both already present, so this is a coverage comparison and not new
  // plumbing.
  const unrendered = declared
    .filter((row) => !placedKeys.has(row.fixtureExtKey))
    .map((row) => row.fixtureExtKey);
  if (unrendered.length > 0) {
    throw new Error(
      `certificate: ${ref} declares ${declared.length} historicalAssignment row(s) but ${unrendered.length} of ${declared.length} have no placed fixture on the rendered historyBoard (${unrendered.join(", ")}) — checkBoard skips unplaced fixtures, so certifying this board would report a clean history having measured only part of it`,
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
