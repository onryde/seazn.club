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
//    four. A checker that quietly skipped the other two and then said "clean"
//    would be stating something it never checked — design §1.4. So the
//    unmodelled ones travel in `unmodelled[]`, `CheckerReport.unchecked` is
//    that list forwarded (one authority, never a second composition), and the
//    report renders it beside the verdict.
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

/** The four `HardConstraint` members this bench build can model.
 *
 *  A discriminated union rather than an open record, so a checker rule that
 *  forgets a member fails to compile instead of silently never firing.
 *
 *  `restScope` is camelCase where the engine's own field is `rest_scope`
 *  (`constraints.ts:88`): every other field in this file is camelCase, and
 *  the rename happens exactly once, here, where the wire shape is read.
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
  | {
      type: "min_rest_minutes";
      minutes: number;
      restScope: "per_person" | "feeder_to_dependent" | "both";
      scope: ConstraintScope;
    }
  | { type: "max_fixtures_per_day"; count: number; scope: ConstraintScope }
  | { type: "not_before"; minutesIntoDay: number; scope: ConstraintScope }
  | { type: "not_after"; minutesIntoDay: number; scope: ConstraintScope };

/** What the pack declared for one division, normalised to epoch ms — the
 *  checker's oracle, and the certificate's. */
export interface EncodedConstraints {
  divisionRef: string;
  matchMinutes: number;
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
  /** `HardConstraint` members this bench build cannot model, carried so the
   *  checker can report them as UNCHECKED rather than imply it checked them.
   *  `CheckerReport.unchecked` is this list, forwarded — one authority, and
   *  the checker never composes a second one.
   *
   *  One entry per RULE, not per type: two `fixture_on_date` rules are two
   *  unchecked rules, and collapsing them would under-report. */
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
  | "duration_disagreement";

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
 *  was verified" when it was not (design §1.4/§3.3). */
export interface CheckerReport {
  findings: readonly CheckerFinding[];
  unchecked: readonly { type: string; reason: string }[];
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

function recordField(
  cfg: Record<string, unknown>,
  key: string,
  where: string,
): Record<string, unknown> | undefined {
  const raw = cfg[key];
  if (isAbsent(raw)) return undefined;
  const rec = asRecord(raw);
  if (rec === undefined) throw new Error(`board: ${where} must be an object, got ${show(raw)}`);
  return rec;
}

function arrayField(cfg: Record<string, unknown>, key: string, where: string): readonly unknown[] {
  const raw = cfg[key];
  if (isAbsent(raw)) return [];
  if (!Array.isArray(raw)) throw new Error(`board: ${where} must be an array, got ${show(raw)}`);
  return raw;
}

/** Present-but-unreadable THROWS; only an absent key takes the default. A
 *  fallback that also caught `"45"` would silently schedule 30-minute
 *  matches for a pack that declared 45. */
function intField(
  cfg: Record<string, unknown>,
  key: string,
  min: number,
  fallback: number,
): number {
  const raw = cfg[key];
  if (isAbsent(raw)) return fallback;
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

/** The scope gate every modellable member passes through, checked BEFORE its
 *  own operand so the two guards are killable one at a time: a rule with a good
 *  operand and a bad scope witnesses this one, a rule with a good scope and a
 *  bad operand witnesses the other. Two guards covering for each other are each
 *  untested. */
function scopeOr(
  type: string,
  rule: Record<string, unknown>,
  unmodelled: { type: string; reason: string }[],
): ConstraintScope | undefined {
  const scope = readScope(rule.scope);
  if (scope !== undefined) return scope;
  unmodelled.push({
    type,
    reason: `${NOT_MODELLED} — ${type} carries no readable ConstraintScope (constraints.ts:30), and there is no safe default: applying it universally would red fixtures the rule never covers`,
  });
  return undefined;
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
      const scope = scopeOr(type, rule, unmodelled);
      if (scope === undefined) return;
      const minutes = positiveInt(rule.minutes);
      const restScope = rule.rest_scope;
      if (minutes === undefined || !isRestScope(restScope)) {
        unmodelled.push({
          type,
          reason: `${NOT_MODELLED} — min_rest_minutes needs a positive integer "minutes" and a "rest_scope" of ${REST_SCOPES.join("/")}`,
        });
        return;
      }
      hard.push({ type: "min_rest_minutes", minutes, restScope, scope });
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
 *  literals. */
export function encodeConstraints(input: {
  divisionRef: string;
  scheduleConfig: Record<string, unknown> | undefined;
  courtIdByRef: ReadonlyMap<string, string>;
  isRoundRobin: boolean;
  pins: readonly { fixtureId: string; start: number; courtId: string }[];
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
    unmodelled,
  };
}
