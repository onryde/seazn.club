// board.ts — the B04 scheduling layer's TRANSPORT-FREE seam.
//
// Everything the checker, the certificate and the report speak is declared
// here, and nothing here does I/O: no `fetch`, no `postgres`, no
// `process.env`, no `Date.now()`, no logging. The only import is `import
// type` from `@seazn/engine/scheduling` — two row shapes, so the bench cannot
// drift from the product's own definition of a court calendar.
//
// -------------------------------------------------------------------------
// Why a file of types earns its place
// -------------------------------------------------------------------------
//
// B04's acceptance criteria require each checker rule proved on a HAND-BUILT
// violating board, and require the certificate to run the real historical
// timetable through the SAME encoded constraints as the product's board. Both
// need a `Board` that no HTTP call produced. Making that struct the checker's
// only input is what makes the checker unit-testable at all — and it is also
// what keeps `checker.ts` free of any temptation to call back into the
// product to answer a question it is supposed to answer independently.
//
// So the dependency arrow runs one way and only one way:
//
//   schedule.ts  ──builds──▶  Board            ──▶ checker.ts
//   pack config  ──builds──▶  EncodedConstraints ─▶ checker.ts, certificate.ts
//                                                        │
//                             judgeDivision  ◀───────────┘
//
// `judgeDivision` lives HERE rather than in `checker.ts` or `certificate.ts`
// because it composes both of them plus the driver's own counts, and it is
// pure. Putting it in either consumer would make this file depend on its own
// consumers, and would give the wave two candidate homes for one rule.
//
// -------------------------------------------------------------------------
// The two conventions this module refuses to bend
// -------------------------------------------------------------------------
//
// 1. TIMES ARE EPOCH MS, EXCEPT WALL CLOCKS, WHICH ARE MINUTES INTO A DAY.
//    The product's `ScheduleConfig` speaks ISO-with-offset
//    (`apps/web/src/server/api-v1/schemas.ts:1283`), the engine speaks epoch
//    ms, and a `HardConstraint`'s `not_before`/`not_after` speak `HH:mm` in
//    the ORG zone — an instant and a wall clock are different units and a
//    field that accepted "either" is the silently-compare-the-wrong-unit trap
//    `verifyConfig` already refuses (`packages/engine/src/scheduling/
//    constraints.ts:80-84`). `EncodedConstraints` therefore names the unit in
//    the field: `from`/`to`/`startAt`/`endAt` are instants,
//    `minutesIntoDay` is not.
//
// 2. WHAT THE ENCODER CANNOT MODEL, IT REPORTS. `HardConstraint` is a
//    SIX-member union (`constraints.ts:86`) and `EncodedHardRule` models
//    THREE — `max_fixtures_per_day`, `not_before`, `not_after`. A checker that
//    quietly skipped the other three and then said "clean" would be stating
//    something it never checked — design §1.4. So the unmodelled ones travel
//    in `unmodelled[]`, `CheckerReport.unchecked` is that list forwarded (one
//    authority, never a second composition), and the report renders it beside
//    the verdict.
//
//    The three that are reported rather than modelled, and why — none of them
//    is a gap that more code here would close, and each was verified against
//    the product rather than assumed:
//      - `fixture_on_weekday` / `fixture_on_date` target fixtures through a
//        `FixtureSelector` and a calendar the checker does not resolve.
//      - `min_rest_minutes` is unmeasurable in ALL THREE of its `rest_scope`
//        readings, because the product's `Fixture` carries no person ids and no
//        feeds edges (ruling R23). Its case below says so in full.
//
// -------------------------------------------------------------------------
// Refuse vs report — where the line is, and why it is not arbitrary
// -------------------------------------------------------------------------
//
// `PackDivision.scheduleConfig` is an OPAQUE `Record<string, PackJsonValue>`
// (`scripts/bench/lib/pack-schema.ts:503`) — deliberately, because the
// product's own schema is ~20 knobs deep with its own migration history — so
// nothing type-checks its contents before this function reads them. Two
// different failure modes follow, and they get two different answers:
//
//   - THROW when continuing would produce a WRONG ORACLE that still looks
//     complete: an `@`-ref that resolves to nothing, an ISO field that is not
//     an instant, a `matchMinutes` that is present but unreadable. Every
//     overlap rule in `checker.ts` measures against `matchMinutes`; silently
//     substituting the 30-minute default for a pack that said `"45"` would
//     make the checker agree with a board it should have reddened, and
//     nothing would say so.
//   - REPORT (as `unmodelled`) when ONE rule is unusable but the rest of the
//     encoding is still sound: an unknown `type`, or a modellable `type`
//     whose own operand is missing. That keeps the other rules checked and
//     makes the report say exactly which rule was not.
//
// Both are "never drop it silently". The split is about blast radius, not
// about severity.
import type {
  ConstraintScope,
  CourtExceptionRow,
  CourtHoursRow,
} from "@seazn/engine/scheduling";
import type { PackHistoricalAssignment } from "./pack-schema.ts";

/**
 * Statuses a fixture can be BORN in. A bracket generates a bye already
 * decided — `stages.ts:1351` stamps `forfeited` on any generated game carrying
 * an `award` — and such a fixture is never scheduled and never scored.
 *
 * ONE authority, because two consumers need the same fact and a second copy is
 * how they drift: `seed.ts` exempts these from "every generated fixture owes a
 * stream", and `schedule.ts` exempts them from the unplaced count. Suite 11
 * has 49 of them and both guards redded on it.
 */
export const SETTLED_AT_GENERATION: ReadonlySet<string> = new Set([
  "forfeited",
  "decided",
  "finalized",
  "cancelled",
  "abandoned",
]);

// ---------------------------------------------------------------------------
// The board — one division as the PRODUCT reports it, after apply
// ---------------------------------------------------------------------------

/** One fixture as the product reports it after apply.
 *
 *  Built from step 7's `GET /api/v1/divisions/{id}/fixtures`, never from the
 *  `assignments` array the bench itself POSTed — design §4.1. Reading back our
 *  own request body would prove the bench can echo itself. */
export interface BoardFixture {
  fixtureId: string;
  extKey?: string;
  divisionId: string;
  divisionRef: string;
  roundNo?: number;
  poolId?: string;
  /** epoch ms; `undefined` means UNPLACED. */
  start?: number;
  /** epoch ms. DERIVED as `start + matchMinutes` — `Fixture` carries
   *  `scheduled_at` and no `ends_at`, so there is nothing else to read. Where
   *  `auto` supplied its own `ends_at`, `schedule.ts` cross-checks the
   *  derivation and records a `duration_disagreement` finding rather than
   *  preferring either side (design §4.2): every overlap rule depends on this
   *  number, so a silent preference would let the checker measure against a
   *  duration the product does not agree with. */
  end?: number;
  courtId?: string;
  courtName?: string;
  venueId?: string;
  entrantIds: readonly string[];
  personIds: readonly string[];
  officialIds: readonly string[];
  locked: boolean;
}

/** One court, with the calendar rows the window rule recomputes from. */
export interface BoardCourt {
  courtId: string;
  name: string;
  venueId: string;
  /** Raw rows AS FETCHED — deliberately NOT folded through `usableWindows`.
   *  The checker's whole claim is that it recomputes independently, and
   *  folding through the product's own lib first would make it agree with the
   *  product by construction. The two row TYPES are imported `import type` so
   *  the shapes cannot drift (`packages/engine/src/scheduling/
   *  court-windows.ts:59` and `:68`); design §2.3's ban is on the FUNCTION,
   *  not on the shape. */
  hours: readonly CourtHoursRow[];
  exceptions: readonly CourtExceptionRow[];
}

/** One division's placed timetable plus the courts it could have used. */
export interface Board {
  divisionId: string;
  divisionRef: string;
  tz: string;
  fixtures: readonly BoardFixture[];
  courts: readonly BoardCourt[];
}

// ---------------------------------------------------------------------------
// The oracle — what the PACK declared, normalised
// ---------------------------------------------------------------------------

/** The three `HardConstraint` members this bench build can model.
 *
 *  A discriminated union rather than an open record, so a checker rule that
 *  forgets a member fails to compile instead of silently never firing — and,
 *  read the other way, so a member the bench CANNOT measure has no place here.
 *  That is why `min_rest_minutes` is absent (ruling R23): every one of its
 *  three `rest_scope` readings is structurally unmeasurable from a `Board`,
 *  so it is reported in `unmodelled[]` and never encoded. Leaving it in this
 *  union would have obliged `checker.ts` to carry a branch nothing can reach —
 *  a dead guard with tests implying it fires, which is the class this wave has
 *  already paid for once.
 *
 *  `scope` IS NOT OPTIONAL, and it is the engine's own `ConstraintScope`
 *  (`import type`, `constraints.ts:30`) rather than a bench restatement, so the
 *  seven kinds cannot drift. Every `HardConstraint` member carries a required
 *  `scope` (`constraints.ts:86-113`), and an encoding that dropped it would
 *  leave the checker no choice but to apply every rule universally. That is not
 *  under-checking, it is OVER-checking: a day cap scoped
 *  `{ kind: "entrant", entrantId: X }` or a rest rule scoped `{ kind: "pool" }`
 *  would red fixtures the rule never covered, and the bench would file a FALSE
 *  product defect — the worst possible output for a harness whose only product
 *  is "the product is wrong here".
 *
 *  `constraints.ts:36-50` documents this in the other direction and is worth
 *  reading before writing a rule against this field: the universal kinds
 *  (`every_entrant` / `every_person`) are NOT competition-scoped rules with a
 *  wider net, `scopeCoversFixture` answers `true` for both and cannot tell them
 *  apart, and the distinction lives in the TALLY KEY. A checker that treats
 *  that `true` as sufficient writes the same bug the engine's own comment was
 *  written to prevent. */
export type EncodedHardRule =
  | { type: "max_fixtures_per_day"; count: number; scope: ConstraintScope }
  | { type: "not_before"; minutesIntoDay: number; scope: ConstraintScope }
  | { type: "not_after"; minutesIntoDay: number; scope: ConstraintScope };

/** What the pack declared for one division, normalised to epoch ms — the
 *  checker's oracle, and the certificate's. */
export interface EncodedConstraints {
  divisionRef: string;
  /** The occupancy unit. A court is busy for `[start, start + matchMinutes)`
   *  and every overlap rule measures against that half-open interval. */
  matchMinutes: number;
  /** GAP IS NOT PART OF COURT OCCUPANCY. Court double-booking is judged on
   *  `[start, start + matchMinutes)` — never `+ gapMinutes` — because the gap
   *  is a SPACING PREFERENCE, not an occupancy claim, and design §3.3's rule
   *  list carries no gap rule. The two readings differ on every back-to-back
   *  pair, so leaving the choice to the checker would have T2 guess a rule the
   *  design never states.
   *
   *  Carried here so the report can print what the pack declared, and listed in
   *  `unmodelled[]` so "checker clean" cannot be read as "the gap was
   *  honoured". */
  gapMinutes: number;
  /** epoch ms. */
  startAt?: number;
  /** epoch ms. */
  endAt?: number;
  /** Real court ids: every `@`-sigilled pack ref is already resolved. */
  courtIds: readonly string[];
  perEntrantMinRest: number;
  /** An absent `courtId` means GLOBAL — every court — which is the semantics
   *  all three product implementations already agree on (`court-windows.ts`'s
   *  own `Blackout`). Widening a court-scoped blackout into a global one by
   *  dropping the key would block every court instead of one, so an
   *  unresolvable court ref throws instead. */
  blackouts: readonly { courtId?: string; from: number; to: number }[];
  sessionWindows: readonly { from: number; to: number }[];
  /** Mapped from `constraints.hard[]` (`schemas.ts:1357`). */
  hard: readonly EncodedHardRule[];
  /** Fixtures locked BEFORE `auto` ran, snapshotted from the product's own
   *  state rather than from the bench's intention — design §3.2 step 3. */
  pins: readonly { fixtureId: string; start: number; courtId: string }[];
  isRoundRobin: boolean;
  /** Did the PACK declare officials for this division?
   *
   *  Carried here because `checkBoard`'s only oracle is this record, and
   *  design §4.3's officials rule is otherwise vacuous: `Fixture.officials` is
   *  `z.array(z.unknown())` on the wire, so a division that fetched none at all
   *  arrives as an empty array and every "no official is double-booked" check
   *  passes forever. Nothing else on `Board` or `EncodedConstraints` can tell
   *  "this division has no officials" from "this division's officials did not
   *  come back", and those are the two answers the rule exists to separate.
   *
   *  REQUIRED, not optional, and that is the point: an optional flag defaulting
   *  to `false` would let a caller ship the rule inert without writing a line,
   *  which is the failure class the rule was written against. `encodeConstraints`
   *  takes it from its caller, who holds the pack. */
  declaresOfficials: boolean;
  /** EVERY declared constraint this bench build does not model — not only
   *  `HardConstraint` members (ruling R9). Carried so the checker can report
   *  them as UNCHECKED rather than imply it checked them;
   *  `CheckerReport.unchecked` is this list, forwarded — one authority, and the
   *  checker never composes a second one.
   *
   *  Two populations, and the widening is the point of the second:
   *
   *   - One entry per `constraints.hard[]` RULE the encoder could not model,
   *     keyed by its `HardConstraint` type. Per RULE, never per type: two
   *     `fixture_on_date` rules are two unchecked rules, and collapsing them
   *     would under-report.
   *   - One entry per DECLARED KNOB with no rule behind it, keyed by its config
   *     path (`gapMinutes`, `roundMinutes`, `constraints.restMin`, …). Before
   *     R9 those were dropped in silence, so a pack setting
   *     `constraints.restMin: 60` got a clean report on a rest floor nothing
   *     checked — the same false-clean design §1.4 exists to prevent, one level
   *     up from `hard[]`.
   *
   *  Keyed on PRESENCE, not on value. The encoder does not decide which
   *  declared value is inert, because deciding that is exactly the judgement it
   *  is reporting it did not make. An absent or null knob is not declared and
   *  produces no entry. */
  unmodelled: readonly { type: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// The checker's own vocabulary
// ---------------------------------------------------------------------------

/** Every way a board can breach the encoding, named once.
 *
 *  A closed union so a report cannot invent a kind the renderer has never
 *  seen, and so the mutation sweep can enumerate what it must kill. */
export type CheckerFindingKind =
  | "court_double_booking"
  | "inside_blackout"
  | "outside_session_windows"
  | "outside_court_hours"
  | "entrant_below_rest"
  | "day_cap_exceeded"
  | "pin_moved"
  | "official_double_booking"
  | "round_order_day"
  | "round_order_same_day"
  | "officials_unreadable"
  | "duration_disagreement"
  // The two wall-clock bounds. TWO members where the product has one:
  // `calendar.ts:1531` emits a single `instruction_time` conflict and
  // discriminates with a `ruleType` FIELD, so these are deliberately bench
  // NATIVE names rather than members of the shared vocabulary — a reader of a
  // bench report should not have to open the detail to learn which bound a
  // fixture broke.
  | "not_before_breached"
  | "not_after_breached"
  // Bench NATIVE, and it has no product counterpart by construction: the
  // product owns both sides of this reference, so it can never emit a
  // conflict saying one of its own fixtures names a court it does not have.
  // The bench can, because it fetched the fixtures and the courts as two
  // separate answers and they must agree. Reported as a FINDING rather than
  // an `unchecked` line: `CheckerReport.unchecked` is
  // `EncodedConstraints.unmodelled` FORWARDED and never a second list, so it
  // is a per-CONSTRAINT fact resolved at encode time and has nowhere to put a
  // per-FIXTURE one discovered at check time.
  | "court_not_declared";

/** One breach. `measured`/`required` are optional because not every kind has
 *  a scalar to compare — a double-booking has two fixtures and no number,
 *  while a rest breach has both and the report prints the shortfall. */
export interface CheckerFinding {
  kind: CheckerFindingKind;
  divisionRef: string;
  /** BOTH sides of a pairwise breach, always — a round-order or overlap
   *  finding naming only one fixture cannot be acted on. */
  fixtureIds: readonly string[];
  detail: string;
  measured?: number;
  required?: number;
}

/** `checkBoard`'s whole answer.
 *
 *  `clean` is the checker's OWN verdict and the single authority on it —
 *  `judgeDivision` reads this field and never re-derives it from
 *  `findings.length`, so there is exactly one place that decides what clean
 *  means. `unchecked` never makes a report dirty: it is rendered beside the
 *  verdict so "checker clean" can never be read as "every declared constraint
 *  was verified" when it was not (design §1.4/§3.3).
 *
 *  `unexercised` is the OPPOSITE direction from `unchecked`, and the two are
 *  not interchangeable (task T7b):
 *
 *    - `unchecked` (= `EncodedConstraints.unmodelled`, forwarded) is a
 *      DECLARED-BUT-UNMODELLED fact, resolved once at ENCODE time: the pack
 *      named a knob (`gapMinutes`) that no rule in `checker.ts` implements at
 *      all.
 *    - `unexercised` is a MODELLED-BUT-HAD-NOTHING-TO-JUDGE fact, resolved at
 *      CHECK time, per `checkBoard` call: the rule is fully implemented and
 *      ran, but the board it was handed gave it zero candidates to compare —
 *      an empty blackout list, a rest floor of zero, a court with no hours.
 *      Such a rule contributes no findings, `clean` stays `true`, and without
 *      this field nothing would say the rule was inert rather than satisfied.
 *
 *  Each entry names the rule in the same form as `checker.ts`'s own section
 *  headers ("Rule 1" .. "Rule 8", `Rule 2a`/`2b`/`2c` for the three
 *  independently-vacuous operands `Rule 2` judges), so a reader can jump
 *  straight from this list to the code that produced it.
 *
 *  A rule with ZERO CANDIDATES is not the same as a rule with candidates and
 *  no violations — both produce zero findings for that rule, and only the
 *  first belongs here. `checker.ts` derives every entry from the rule's OWN
 *  iteration (did its loop actually run a candidate comparison?), never from
 *  a restated precondition kept beside the rule: a second copy of "is this
 *  input non-empty" is exactly the kind of fact that drifts from what the
 *  rule actually iterates once either one changes. Like `unchecked`, this
 *  list is rendered BESIDE the verdict and never makes a clean report dirty. */
export interface CheckerReport {
  findings: readonly CheckerFinding[];
  unchecked: readonly { type: string; reason: string }[];
  unexercised: readonly { rule: string; reason: string }[];
  clean: boolean;
}

/** The §6.3 protocol's branches, in the order the certificate evaluates them.
 *
 *  A string union, never a TS `enum`: the bench runs under
 *  `node --experimental-strip-types`, which cannot execute one. */
export type CertificateBranch =
  | "SKIPPED_NO_HISTORY"
  | "PACK_AUTHORING_BUG"
  | "PRODUCT_DEFECT"
  | "UNPLACED"
  | "FEASIBLE";

/** History first, attribution second — reading a solver `infeasible` as a
 *  product defect before checking our OWN encoding is how a pack-authoring
 *  bug gets filed against the solver. */
export interface CertificateVerdict {
  branch: CertificateBranch;
  reason: string;
  violations: readonly CheckerFinding[];
  red: boolean;
}

// ---------------------------------------------------------------------------
// judgeDivision — the three layers, composed
// ---------------------------------------------------------------------------

/** Composes the three verification layers into one division verdict. Pure.
 *
 *  Five independent triggers, each of which reds on its own:
 *  the product's own `/validate` blocking conflicts, the independent
 *  checker's verdict, the certificate's, unplaced fixtures (parent spec
 *  §6.3's gate), and any error the driver hit walking the division through
 *  its seven steps.
 *
 *  `reasons` names EVERY trigger that fired, not just the first, because a
 *  run that reds for four reasons and reports one sends the reader back for
 *  three more rounds. And `red` is derived from `reasons.length` rather than
 *  computed alongside it, so the boolean and the explanation can never
 *  disagree — a verdict that reds with no reason, or explains itself while
 *  claiming to be clean, is unrepresentable here. */
export function judgeDivision(input: {
  divisionRef: string;
  blockingCount: number;
  checker: CheckerReport;
  certificate: CertificateVerdict;
  unplacedCount: number;
  scheduleErrors: readonly string[];
}): { red: boolean; reasons: readonly string[] } {
  const reasons: string[] = [];
  // Every reason locates itself, so a multi-division report can print them
  // flat without re-attributing them to a division afterwards.
  const at = (text: string): string => `${input.divisionRef}: ${text}`;

  if (input.blockingCount > 0) {
    reasons.push(at(`blocking conflicts = ${input.blockingCount}`));
  }
  if (!input.checker.clean) {
    // Deduped and ordered by first appearance: the kinds are a summary line,
    // and repeating `court_double_booking` eleven times buries the other ten.
    const kinds = [...new Set(input.checker.findings.map((f) => f.kind))];
    const named = kinds.length > 0 ? kinds.join(", ") : "none named";
    reasons.push(at(`checker findings = ${input.checker.findings.length} (${named})`));
  }
  if (input.certificate.red) {
    reasons.push(at(`certificate ${input.certificate.branch} — ${input.certificate.reason}`));
  }
  if (input.unplacedCount > 0) {
    reasons.push(at(`unplaced fixtures = ${input.unplacedCount}`));
  }
  if (input.scheduleErrors.length > 0) {
    reasons.push(
      at(`schedule errors = ${input.scheduleErrors.length} (${input.scheduleErrors.join("; ")})`),
    );
  }

  return { red: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// encodeConstraints — the pack's opaque scheduleConfig, normalised
// ---------------------------------------------------------------------------

/** `ScheduleConfig`'s own defaults, restated here because this function reads
 *  an OPAQUE record and therefore never runs that zod schema. Pinned to
 *  `apps/web/src/server/api-v1/schemas.ts:1287` (matchMinutes), `:1288`
 *  (gapMinutes) and `:1303` (perEntrantMinRest); a drift here would make the
 *  checker judge a board against a duration the product never used. */
const DEFAULT_MATCH_MINUTES = 30;
const DEFAULT_GAP_MINUTES = 0;
const DEFAULT_PER_ENTRANT_MIN_REST = 0;

/** Every `unmodelled` reason starts with this, and
 *  `CheckerReport.unchecked` forwards it verbatim to the report. */
const NOT_MODELLED = "not modelled by the bench checker";

/** The engine's own wall-clock regex (`constraints.ts:84`), restated for the
 *  same reason the defaults above are. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The product's `IsoDateTime` is `z.iso.datetime({ offset: true })`
 *  (`apps/web/src/server/api-v1/schemas.ts:1280`) — the offset is REQUIRED, and
 *  this is that requirement restated as a suffix check for the same reason the
 *  defaults above are restated: this function reads an opaque record and never
 *  runs that zod schema.
 *
 *  A suffix check rather than a full ISO grammar, deliberately: `Date.parse`
 *  below still has to reject a well-suffixed non-date (`"2027-06-31T25:00:00Z"`),
 *  and folding both jobs into one regex would leave that guard unreachable and
 *  therefore untested. */
const ISO_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;

const REST_SCOPES = ["per_person", "feeder_to_dependent", "both"] as const;
type RestScope = (typeof REST_SCOPES)[number];

function isRestScope(value: unknown): value is RestScope {
  return typeof value === "string" && (REST_SCOPES as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads the engine's `ConstraintScope` (`constraints.ts:30`) out of an opaque
 *  record, structurally — this module never runs that zod schema, for the same
 *  reason it never runs `ScheduleConfig`'s.
 *
 *  Returns `undefined` on anything the product's own discriminated union would
 *  reject, so the caller can report the rule as unmodelled. There is
 *  deliberately no tolerant fallback: a scope that cannot be read has no safe
 *  default, because the universal reading is the one that over-applies the
 *  rule and files a false defect.
 *
 *  Rebuilds the object from the fields it recognises rather than passing the
 *  input through, mirroring zod's strip: a `{ kind: "competition", entrantId }`
 *  parses to a bare competition scope at the product, and the bench must agree
 *  with what the product STORED, not with what the pack typed. */
function readScope(raw: unknown): ConstraintScope | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  switch (rec.kind) {
    case "competition":
      return { kind: "competition" };
    case "every_entrant":
      return { kind: "every_entrant" };
    case "every_person":
      return { kind: "every_person" };
    case "division": {
      const divisionId = nonEmptyString(rec.divisionId);
      return divisionId === undefined ? undefined : { kind: "division", divisionId };
    }
    case "entrant": {
      const entrantId = nonEmptyString(rec.entrantId);
      return entrantId === undefined ? undefined : { kind: "entrant", entrantId };
    }
    case "person": {
      const personKey = nonEmptyString(rec.personKey);
      return personKey === undefined ? undefined : { kind: "person", personKey };
    }
    case "pool": {
      const divisionId = nonEmptyString(rec.divisionId);
      const pool = nonEmptyString(rec.pool);
      return divisionId === undefined || pool === undefined
        ? undefined
        : { kind: "pool", divisionId, pool };
    }
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** For a `.nullish()` product field, an absent key and an explicit `null` mean
 *  the same thing: `startAt`/`endAt` are `.nullish()` (`schemas.ts:1284`,
 *  `:1286`), so a stored config round-trips nulls and refusing one would red
 *  every division that simply never set a window.
 *
 *  NOT for `.optional()` fields — see `isMissing`. The two are a matched pair
 *  and picking the wrong one is a correctness bug, not a style choice. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/** For an `.optional()` product field, where only the KEY may be absent and an
 *  explicit `null` is a present-but-unreadable value that the product's own
 *  parse rejects — so the refuse-vs-report rule at the top of this file makes
 *  it a THROW.
 *
 *  `blackouts[].court` is the field this exists for, and the distinction is not
 *  academic. Reading its `null` as "no court" widens a ONE-COURT blackout into
 *  a global one that blocks every court for the window — the exact widening
 *  `schemas.ts`'s `blackouts` doc comment forbids ("an entry that cannot be
 *  mapped is DROPPED entirely ... never widened into a venue-wide blackout by
 *  dropping just the `court` key"), and the opposite of a missed check: the
 *  checker would red fixtures on courts the organiser never blacked out.
 *
 *  A JSON pack cannot express `undefined`, so `null` is the only present-but-
 *  empty value that can actually arrive here. */
function isMissing(value: unknown): boolean {
  return value === undefined;
}

/** `isMissing`, not `isAbsent`. The only field this serves is `constraints`,
 *  which is `.optional()` (`schemas.ts:1330`) and therefore NOT nullish — a
 *  `null` is a present-but-invalid value.
 *
 *  Reading it as an absence was the worst-failing instance of this bug class:
 *  a `{"constraints": null}` pack came back with an empty `hard[]` AND an empty
 *  `unmodelled[]`, so the entire rule set vanished while the report said
 *  nothing had been left unchecked. Every other null-laundering here yields a
 *  wrong answer; this one yields a wrong answer that claims to be clean, which
 *  is the single outcome design §1.4 exists to prevent. `PackJsonValue` admits
 *  `null` explicitly (`pack-schema.ts:154-171`), so a pack can reach it. */
function recordField(
  cfg: Record<string, unknown>,
  key: string,
  where: string,
): Record<string, unknown> | undefined {
  const raw = cfg[key];
  if (isMissing(raw)) return undefined;
  const rec = asRecord(raw);
  if (rec === undefined) throw new Error(`board: ${where} must be an object, got ${show(raw)}`);
  return rec;
}

/** `isMissing`, not `isAbsent`, for the same reason as `recordField` — and it
 *  is uniform across all four fields this serves, because not one of them is
 *  `.nullish()`: `courts`, `blackouts` and `sessionWindows` are `.default([])`
 *  (`schemas.ts:1302`, `:1318`, `:1322`) and `constraints.hard` is
 *  `.optional()` (`:1357`).
 *
 *  `constraints.hard: null` is the §1.4 false-clean one level down — the rule
 *  list emptied while `unmodelled[]` stayed empty, because a null never reaches
 *  a per-rule reader that could report it. The other three drop a window or a
 *  court list silently, which makes every containment rule that depended on it
 *  pass vacuously. */
function arrayField(cfg: Record<string, unknown>, key: string, where: string): readonly unknown[] {
  const raw = cfg[key];
  if (isMissing(raw)) return [];
  if (!Array.isArray(raw)) throw new Error(`board: ${where} must be an array, got ${show(raw)}`);
  return raw;
}

/** Present-but-unreadable THROWS; only an ABSENT key takes the default. A
 *  fallback that also caught `"45"` would silently schedule 30-minute matches
 *  for a pack that declared 45.
 *
 *  `isMissing`, deliberately not `isAbsent` (ruling R14). None of the three
 *  knobs this serves is `.nullish()` in the product — `matchMinutes`
 *  (`schemas.ts:1287`), `gapMinutes` (`:1288`) and `perEntrantMinRest`
 *  (`:1303`) are all `z.number().int()...default(n)` — so an explicit `null`
 *  is invalid product-side and laundering it into a valid default is the same
 *  defect as reading a null blackout `court` as "no court".
 *
 *  It is in fact the more dangerous half of that pair, and the direction is
 *  worth stating: an ABSENT knob falls through to the correct default, while a
 *  PRESENT-but-wrong one OVERRIDES it — so making the field readable is worse
 *  than leaving it out, and every overlap rule in `checker.ts` would then
 *  measure against a duration the pack never declared. Which default an absent
 *  key takes is settled by `ScheduleConfig` and pinned by the drift guard in
 *  `board.test.ts`, not here. */
function intField(
  cfg: Record<string, unknown>,
  key: string,
  min: number,
  fallback: number,
): number {
  const raw = cfg[key];
  if (isMissing(raw)) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min) {
    throw new Error(`board: scheduleConfig.${key} must be an integer >= ${min}, got ${show(raw)}`);
  }
  return raw;
}

/** ISO-with-offset -> epoch ms. `Date.parse` honours the offset, which is the
 *  whole point: a config that says `14:30+05:30` means 09:00Z, and a reader
 *  that dropped the offset would be five and a half hours out with nothing
 *  red.
 *
 *  The OFFSET IS REQUIRED, and its absence is a refusal rather than a
 *  best-effort read. `Date.parse` resolves an offsetless ISO date-time against
 *  the HOST's timezone, so `"2027-06-01T08:00:00"` measures 1811836800000 under
 *  `TZ=UTC`, 1811833200000 under `Europe/London` and 1811817000000 under
 *  `Asia/Kolkata` — a 5.5-hour spread. Accepting one would put the machine's
 *  clock inside the oracle every containment rule in `checker.ts` measures
 *  against, so the same pack would yield different `inside_blackout` /
 *  `outside_session_windows` findings on a BST dev box and a UTC CI runner,
 *  with nothing red. That is convention #1 at the top of this file — an instant
 *  and a wall clock are different units — one layer down, and it is the only
 *  place the module's "no clock" claim could stop being true.
 *
 *  The product never emits this shape (`IsoDateTime` refuses it on the way in),
 *  so reaching here means a pack-authoring slip, which is what the message
 *  names. */
function epochMs(raw: unknown, where: string): number {
  if (typeof raw !== "string") {
    throw new Error(`board: ${where} must be an ISO instant string, got ${show(raw)}`);
  }
  if (!ISO_OFFSET.test(raw)) {
    throw new Error(
      `board: ${where} must carry an explicit UTC offset — a trailing "Z" or "±HH:MM" — got ${show(raw)}; an offsetless ISO date-time is read against the HOST timezone and would make this oracle machine-dependent`,
    );
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`board: ${where} is not a parseable ISO instant: ${show(raw)}`);
  }
  return ms;
}

/** `@c-one` -> the seeded court id; a bare id passes through untouched.
 *
 *  Throws on a miss rather than emitting the sigil, because a literal
 *  `"@c-one"` reaching the checker matches no fixture's `courtId` and every
 *  court-scoped rule then passes vacuously — the sigil convention's own
 *  failure mode (`pack-schema.ts:1682` refuses the same thing at stage 0, but
 *  only against the pack's DECLARED courts, not against what was seeded). */
function resolveCourt(
  raw: unknown,
  courtIdByRef: ReadonlyMap<string, string>,
  where: string,
): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(
      `board: ${where} must be a court id or an @-sigilled pack ref, got ${show(raw)}`,
    );
  }
  if (!raw.startsWith("@")) return raw;
  const ref = raw.slice(1);
  const id = courtIdByRef.get(ref);
  if (id === undefined) {
    throw new Error(
      `board: ${where} names unknown court ref "${ref}" (${show(raw)}) — no seeded court answers to it`,
    );
  }
  return id;
}

/** `"09:30"` -> 570. Returns `undefined` on anything else so the caller can
 *  report the rule as unmodelled; `parseInt("0930")` would answer 930 and
 *  look like a number. */
function minutesIntoDay(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !HHMM.test(raw)) return undefined;
  const [h, m] = raw.split(":");
  return Number(h) * 60 + Number(m);
}

function positiveInt(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

/** Bounded, quote-preserving rendering for an error message — a raw
 *  `String(value)` turns `"45"` and `45` into the same text, which is exactly
 *  the distinction these errors exist to report. */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Circular, or a BigInt `JSON.stringify` refuses — fall through to the
    // type tag rather than letting a diagnostic throw over the real error.
  }
  return Object.prototype.toString.call(value);
}

/** Every knob `ScheduleConfig` declares that this build models with no rule,
 *  in the schema's own declaration order so the report reads like the config.
 *
 *  A TABLE rather than nine `if`s: adding a knob to `ScheduleConfig` and
 *  forgetting it here is the failure this list exists to prevent, and a table
 *  is the shape a reader can diff against `schemas.ts:1283-1359` in one pass.
 *  Only `hard` is absent from it, because `encodeHardRule` reports that one
 *  rule by rule. */
const UNMODELLED_TOP_LEVEL: readonly { key: string; why: string }[] = [
  {
    key: "gapMinutes",
    why: "gapMinutes is a spacing preference and not an occupancy claim — court occupancy is judged on [start, start + matchMinutes) and design §3.3's rule list has no gap rule, so the value is carried for the report and never checked",
  },
  {
    key: "roundMinutes",
    why: "roundMinutes sets where round r starts (startAt + (r-1)·roundMinutes, schemas.ts:1327) and the checker's round-order rules do not read it",
  },
];

const UNMODELLED_CONSTRAINTS: readonly { key: string; why: string }[] = [
  {
    key: "restMin",
    why: "constraints.restMin is a division-wide rest floor and is NOT the top-level perEntrantMinRest (schemas.ts:1332 vs :1303) — the two are separate knobs and neither covers for the other",
  },
  {
    key: "restByGroup",
    why: "constraints.restByGroup keys a rest floor by group (schemas.ts:1333) and the checker resolves no group membership",
  },
  {
    key: "noBackToBack",
    why: "constraints.noBackToBack (schemas.ts:1334) has no rule in design §3.3's list",
  },
  {
    key: "startWindows",
    why: "constraints.startWindows[] is the SCOPED twin of the not_before/not_after hard rules — per-target ISO instants (schemas.ts:1335-1344), not wall clocks — so modelling those rules does not cover these windows",
  },
  {
    key: "fieldFairness",
    why: "constraints.fieldFairness (schemas.ts:1345) is a court-allocation preference the checker does not score",
  },
  {
    key: "parallelism",
    why: "constraints.parallelism (schemas.ts:1346) is a placement preference the checker does not score",
  },
  {
    key: "crossPersonClash",
    why: 'constraints.crossPersonClash is unmodelled here AND inert product-side — "@deprecated Accepted and stored, read by nothing" (constraints.ts:138-145): the write gate lists person_overlap unconditionally and the placer avoids one regardless, so neither side consults the setting',
  },
];

/** Reports every declared-but-unmodelled knob, keyed on PRESENCE. Runs AFTER
 *  the `hard[]` scan so per-rule entries keep their own order ahead of the
 *  knobs.
 *
 *  KEEPS `isAbsent` — the two call sites below are the considered exception to
 *  the `isMissing` sweep, not an oversight:
 *
 *   - This is a REPORTING pass, not a reader. It never converts a value into
 *     the oracle, so the failure mode `isMissing` guards against — laundering a
 *     null into a usable number or an empty container — cannot arise here. The
 *     worst it can do is stay silent about a key.
 *   - `roundMinutes` IS `.nullish()` (`schemas.ts:1327`), so a null there
 *     genuinely means "not set", and reporting it as a declared-but-unmodelled
 *     knob would be a FALSE claim about what the pack asked for — the opposite
 *     error, and one this sweep exists to avoid making.
 *   - `gapMinutes`, the only other top-level key swept, has its own reader:
 *     `intField` refuses a null a few lines later (R14), so the refusal is not
 *     lost by skipping it here.
 *
 *  The residue is a null in one of the seven `constraints.*` knobs, which
 *  nothing reads: it is neither reported nor refused. That is a pack-authoring
 *  bug the product's own `PUT /schedule-settings` 422s on, and it cannot reach
 *  the oracle. Recorded rather than fixed, because widening this call to a
 *  refusal would also have to decide the default-valued-knob question that is
 *  still open. */
function reportUnmodelledKnobs(
  cfg: Record<string, unknown>,
  constraints: Record<string, unknown> | undefined,
  unmodelled: { type: string; reason: string }[],
): void {
  for (const { key, why } of UNMODELLED_TOP_LEVEL) {
    if (!isAbsent(cfg[key])) unmodelled.push({ type: key, reason: `${NOT_MODELLED} — ${why}` });
  }
  if (constraints === undefined) return;
  for (const { key, why } of UNMODELLED_CONSTRAINTS) {
    if (!isAbsent(constraints[key])) {
      unmodelled.push({ type: `constraints.${key}`, reason: `${NOT_MODELLED} — ${why}` });
    }
  }
}

/** A PERSON scope cannot be measured by this bench, whatever rule wears it.
 *
 *  Called from `scopeOr`, i.e. from the ONE place a scope is read, so it
 *  applies to every scope-bearing rule type there is and to every one added
 *  later. It was first written as a per-arm call, which is the same defect it
 *  exists to fix one level up: correct for the three arms that remembered to
 *  call it, and silently absent for the fourth.
 *
 *  The generalisation of ruling R23, which was made for `min_rest_minutes` and
 *  then not carried to its siblings — so a `max_fixtures_per_day`,
 *  `not_before` or `not_after` scoped `person`/`every_person` encoded fine,
 *  matched zero fixtures, emitted nothing, appeared in no `unmodelled[]`, and
 *  reported CLEAN. That is design §1.4's false-clean reached by a different
 *  road, and it is worse than the `min_rest_minutes` case it was cloned from,
 *  because here the rule LOOKS modelled all the way through.
 *
 *  The cause is structural, not a gap more code would close: the product's
 *  `Fixture` carries `home_entrant_id` / `away_entrant_id` and NO persons at
 *  all (`apps/web/src/server/api-v1/schemas.ts`, the `Fixture` object), so
 *  `BoardFixture.personIds` is always `[]` and `tallyKeys` yields no key for a
 *  person scope on any real board.
 *
 *  ENTRANT is NOT a substitute and is never swapped in: a doubles pair is one
 *  entrant and two people, and a player entered in singles and mixed is two
 *  entrants and one person, so only the person reading stops that human
 *  playing four times in a day (`constraints.ts:30`'s own note). Answering a
 *  person-scoped rule with entrant tallies would report on a constraint nobody
 *  declared. */
function personScopeUnmeasurable(
  type: string,
  scope: ConstraintScope,
  unmodelled: { type: string; reason: string }[],
): boolean {
  if (scope.kind !== "person" && scope.kind !== "every_person") return false;
  unmodelled.push({
    type,
    reason: `${NOT_MODELLED} — ${type} is scoped ${scope.kind}, and no person scope can be measured from a Board: the product's Fixture carries no person ids, so personIds is always empty and the rule matches nothing rather than passing; the entrant tally is a DIFFERENT constraint and is not substituted`,
  });
  return true;
}

/** The scope gate every modellable member passes through, checked BEFORE its
 *  own operand so the two guards are killable one at a time: a rule with a good
 *  operand and a bad scope witnesses this one, a rule with a good scope and a
 *  bad operand witnesses the other. Two guards covering for each other are each
 *  untested — and this claim is only true while BOTH tests exist and each cites
 *  its OWN message, so `board.test.ts` asserts `/scope/i` on one and `/count/i`
 *  on the other. It stopped being true once already, when the operand test was
 *  deleted as collateral and nothing killed either guard. */
function scopeOr(
  type: string,
  rule: Record<string, unknown>,
  unmodelled: { type: string; reason: string }[],
): ConstraintScope | undefined {
  const scope = readScope(rule.scope);
  if (scope === undefined) {
    unmodelled.push({
      type,
      reason: `${NOT_MODELLED} — ${type} carries no readable ConstraintScope (constraints.ts:30), and there is no safe default: applying it universally would red fixtures the rule never covers`,
    });
    return undefined;
  }
  // Refused HERE rather than in each rule-type arm, so a rule type added later
  // inherits it by construction instead of by somebody remembering. That is
  // the whole point: this refusal is a property of the SCOPE, and every
  // scope-bearing member already funnels through this one function.
  if (personScopeUnmeasurable(type, scope, unmodelled)) return undefined;
  return scope;
}

/** Maps ONE `constraints.hard[]` entry onto `hard` or onto `unmodelled`.
 *
 *  Never onto neither: an entry that reaches here and lands nowhere is a
 *  constraint the checker silently ignored, which is the one outcome design
 *  §1.4 forbids. */
function encodeHardRule(
  raw: unknown,
  index: number,
  hard: EncodedHardRule[],
  unmodelled: { type: string; reason: string }[],
): void {
  const rule = asRecord(raw);
  const type = rule?.type;
  if (rule === undefined || typeof type !== "string") {
    unmodelled.push({
      type: "(unreadable)",
      reason: `${NOT_MODELLED} — constraints.hard[${index}] carries no string "type"`,
    });
    return;
  }

  switch (type) {
    case "min_rest_minutes": {
      // NEVER modelled — every reading of `rest_scope` is unmeasurable from a
      // `Board`, so this rule is REPORTED in full rather than half-checked.
      //
      //   * `per_person` (and the per-person half of `both`) needs person ids,
      //     and the product's `Fixture` carries NONE — no `person_ids`, no
      //     lineup, only `home_entrant_id` / `away_entrant_id`
      //     (`apps/web/src/server/api-v1/schemas.ts`, the `Fixture` object). So
      //     `BoardFixture.personIds` is always `[]` and a person series can
      //     never have two members to measure between.
      //   * `feeder_to_dependent` (and the feeder half of `both`) needs the
      //     bracket's `feeds` edges — no `winner_to`/`loser_to` reaches a
      //     `Board` either.
      //
      // Substituting the ENTRANT series for the person one would measure a
      // different constraint than the one declared: in doubles a pair is one
      // entrant and two people, and a player entered in singles and mixed is
      // two entrants and one person, so only the person reading stops that
      // human playing four times in a day (`constraints.ts:30`'s own note).
      // The top-level `perEntrantMinRest` knob is a SEPARATE rule, keyed on
      // `entrantIds`, which ARE present — it still works and neither stands in
      // for the other.
      const restScope = rule.rest_scope;
      const why = isRestScope(restScope)
        ? `rest_scope "${restScope}"`
        : "an unreadable rest_scope";
      unmodelled.push({
        type,
        reason: `${NOT_MODELLED} — min_rest_minutes with ${why} cannot be measured from a Board: the product's Fixture carries no person ids (so personIds is always empty) and no feeds edges, and the entrant series is a DIFFERENT constraint that is not substituted; the separate top-level perEntrantMinRest knob is unaffected`,
      });
      return;
    }
    case "max_fixtures_per_day": {
      const scope = scopeOr(type, rule, unmodelled);
      if (scope === undefined) return;
      const count = positiveInt(rule.count);
      if (count === undefined) {
        unmodelled.push({
          type,
          reason: `${NOT_MODELLED} — max_fixtures_per_day carries no positive integer "count"`,
        });
        return;
      }
      hard.push({ type: "max_fixtures_per_day", count, scope });
      return;
    }
    case "not_before":
    case "not_after": {
      const scope = scopeOr(type, rule, unmodelled);
      if (scope === undefined) return;
      const mins = minutesIntoDay(rule.time);
      if (mins === undefined) {
        unmodelled.push({
          type,
          reason: `${NOT_MODELLED} — ${type} carries no HH:mm "time"`,
        });
        return;
      }
      hard.push({ type, minutesIntoDay: mins, scope });
      return;
    }
    case "fixture_on_weekday":
    case "fixture_on_date": {
      // The two selector-bearing members. Modelling either needs the
      // division's own calendar resolved in the org zone AND a
      // `FixtureSelector` resolver, neither of which the checker has — so it
      // says so rather than passing over them.
      unmodelled.push({
        type,
        reason: `${NOT_MODELLED} — ${type} targets fixtures through a FixtureSelector and a calendar the checker does not resolve`,
      });
      return;
    }
    default: {
      unmodelled.push({
        type,
        reason: `${NOT_MODELLED} — unknown HardConstraint type "${type}"`,
      });
    }
  }
}

/** Normalises one division's opaque `scheduleConfig` into the checker's
 *  oracle: `@`-refs resolved, ISO instants converted to epoch ms, wall clocks
 *  converted to minutes into the day, and every hard rule either modelled or
 *  reported.
 *
 *  Pure, and deliberately NOT `async`: the caller resolves `courtIdByRef`,
 *  `pins` and `isRoundRobin` from the seeded org before calling, so this
 *  function needs no network and can be driven from a unit test with three
 *  literals.
 *
 *  THROWS, AND THE CALLER OWNS THE VERDICT. The refusals above (an
 *  unresolvable `@`-ref, an ISO field that is not an offset-bearing instant, a
 *  present-but-unreadable numeric knob or court) are pack-authoring bugs, and a
 *  thrown encode never reaches `judgeDivision` — so on its own it has no path
 *  to a verdict at all, only to a stack trace. Callers MUST catch and route the
 *  message into `ScheduleOutcome.scheduleErrors`, the same list `judgeDivision`
 *  already reds on (its fifth trigger), so a pack-authoring bug is reported as
 *  that division's red rather than killing the run.
 *
 *  There is deliberately NO non-throwing mode. A second, tolerant entry point
 *  would give the wave two encoders whose answers differ exactly where it
 *  matters, and the tolerant one would be the one that silently produced a
 *  wrong oracle. */
export function encodeConstraints(input: {
  divisionRef: string;
  scheduleConfig: Record<string, unknown> | undefined;
  courtIdByRef: ReadonlyMap<string, string>;
  isRoundRobin: boolean;
  pins: readonly { fixtureId: string; start: number; courtId: string }[];
  /** Whether the pack declared any official for this division — resolved by
   *  the caller, who holds the pack, and forwarded verbatim. Required for the
   *  reason the field's own note gives: an optional one ships design §4.3's
   *  rule inert. Coerced with `=== true` rather than read raw, because this
   *  function is reached from JavaScript call sites tsc does not see. */
  declaresOfficials: boolean;
}): EncodedConstraints {
  const cfg = input.scheduleConfig ?? {};

  const courtIds = arrayField(cfg, "courts", "scheduleConfig.courts").map((raw, i) =>
    resolveCourt(raw, input.courtIdByRef, `scheduleConfig.courts[${i}]`),
  );

  const blackouts = arrayField(cfg, "blackouts", "scheduleConfig.blackouts").map((raw, i) => {
    const at = `scheduleConfig.blackouts[${i}]`;
    const row = asRecord(raw);
    if (row === undefined) throw new Error(`board: ${at} must be an object, got ${show(raw)}`);
    const from = epochMs(row.from, `${at}.from`);
    const to = epochMs(row.to, `${at}.to`);
    // An ABSENT `court` is a GLOBAL blackout and stays one — see the field's
    // own note on EncodedConstraints. `isMissing`, deliberately not `isAbsent`:
    // a present-but-null `court` falls through to `resolveCourt`, which refuses
    // it as present-but-unreadable rather than silently widening the blackout
    // to every court.
    return isMissing(row.court)
      ? { from, to }
      : { courtId: resolveCourt(row.court, input.courtIdByRef, `${at}.court`), from, to };
  });

  const sessionWindows = arrayField(
    cfg,
    "sessionWindows",
    "scheduleConfig.sessionWindows",
  ).map((raw, i) => {
    const at = `scheduleConfig.sessionWindows[${i}]`;
    const row = asRecord(raw);
    if (row === undefined) throw new Error(`board: ${at} must be an object, got ${show(raw)}`);
    return { from: epochMs(row.from, `${at}.from`), to: epochMs(row.to, `${at}.to`) };
  });

  const hard: EncodedHardRule[] = [];
  const unmodelled: { type: string; reason: string }[] = [];
  const constraints = recordField(cfg, "constraints", "scheduleConfig.constraints");
  if (constraints !== undefined) {
    const rules = arrayField(constraints, "hard", "scheduleConfig.constraints.hard");
    rules.forEach((raw, i) => encodeHardRule(raw, i, hard, unmodelled));
  }
  reportUnmodelledKnobs(cfg, constraints, unmodelled);

  const startAt = isAbsent(cfg.startAt) ? undefined : epochMs(cfg.startAt, "scheduleConfig.startAt");
  const endAt = isAbsent(cfg.endAt) ? undefined : epochMs(cfg.endAt, "scheduleConfig.endAt");

  return {
    divisionRef: input.divisionRef,
    matchMinutes: intField(cfg, "matchMinutes", 1, DEFAULT_MATCH_MINUTES),
    gapMinutes: intField(cfg, "gapMinutes", 0, DEFAULT_GAP_MINUTES),
    ...(startAt === undefined ? {} : { startAt }),
    ...(endAt === undefined ? {} : { endAt }),
    courtIds,
    perEntrantMinRest: intField(cfg, "perEntrantMinRest", 0, DEFAULT_PER_ENTRANT_MIN_REST),
    blackouts,
    sessionWindows,
    hard,
    pins: input.pins,
    isRoundRobin: input.isRoundRobin,
    declaresOfficials: input.declaresOfficials === true,
    unmodelled,
  };
}

// ---------------------------------------------------------------------------
// B06b — the history board the feasibility certificate needs
// ---------------------------------------------------------------------------
/**
 * Render a pack's `historicalAssignment` into a `Board`, so §6.3's check can
 * run the REAL timetable through the same constraint code the solver's
 * proposal goes through. Without it `certify` throws, which is what B04 left
 * deliberately: "rendering history into a `Board` is a real piece of work, and
 * a fallback that let the run continue would certify a timetable against
 * nothing and report FEASIBLE" (`run-suite.ts`'s own note). Suite 11 is the
 * first pack to declare history, so this is that work.
 *
 * The COURTS come from the live board unchanged — hours and exceptions are
 * what the pack declared and what the product stored, and the history has to
 * be judged against the same calendar as the proposal. Only the placement
 * moves.
 *
 * A fixture with no historical row stays UNPLACED rather than inheriting the
 * solver's placement. That is the honest rendering — a bye is never
 * scheduled in reality — and it matters: silently leaving the proposal's start
 * on an unmatched fixture would judge the SOLVER's choice and report it as
 * history.
 */
export function renderHistoryBoard(input: {
  readonly board: Board;
  readonly historical: readonly PackHistoricalAssignment[];
  readonly divisionRef: string;
  /** Used only when a row omits `endsAt`. A published session timetable often
   *  gives starts alone; a duration is then the division's own match length,
   *  never a guess made here. */
  readonly matchMinutes: number;
}): { board: Board; placed: number; unmatched: readonly string[] } {
  const rows = new Map(
    input.historical.filter((h) => h.divisionRef === input.divisionRef).map((h) => [h.fixtureExtKey, h] as const),
  );
  // Courts resolve by NAME: `PackHistoricalAssignment.court` is the court's
  // printed name (it describes a real venue, not the pack's ref space), and
  // the board carries both. A name the board does not know leaves `courtId`
  // undefined, which the court rules then cannot judge — reported as
  // unmatched rather than dropped.
  const courtIdByName = new Map(input.board.courts.map((c) => [c.name, c.courtId] as const));
  const unmatched: string[] = [];
  let placed = 0;
  const fixtures = input.board.fixtures.map((f) => {
    const row = f.extKey === undefined ? undefined : rows.get(f.extKey);
    if (row === undefined) {
      return { ...f, start: undefined, end: undefined, courtId: undefined, courtName: undefined };
    }
    const start = Date.parse(row.startsAt);
    if (Number.isNaN(start)) {
      unmatched.push(`${f.extKey ?? f.fixtureId}: unparseable startsAt "${row.startsAt}"`);
      return { ...f, start: undefined, end: undefined, courtId: undefined, courtName: undefined };
    }
    const end = row.endsAt === undefined ? start + input.matchMinutes * 60_000 : Date.parse(row.endsAt);
    const courtId = row.court === undefined ? undefined : courtIdByName.get(row.court);
    if (row.court !== undefined && courtId === undefined) {
      unmatched.push(`${f.extKey ?? f.fixtureId}: court "${row.court}" is not on this division's board`);
    }
    placed++;
    return {
      ...f,
      start,
      end: Number.isNaN(end) ? start + input.matchMinutes * 60_000 : end,
      ...(courtId === undefined ? { courtId: undefined } : { courtId }),
      ...(row.court === undefined ? { courtName: undefined } : { courtName: row.court }),
    };
  });
  // A declared row naming a fixture the board does not carry at all is the
  // other direction, and just as silent if unreported.
  const boardKeys = new Set(input.board.fixtures.map((f) => f.extKey).filter((k): k is string => k !== undefined));
  for (const key of rows.keys()) if (!boardKeys.has(key)) unmatched.push(`${key}: declared in history but not on the board`);
  return { board: { ...input.board, fixtures }, placed, unmatched };
}
