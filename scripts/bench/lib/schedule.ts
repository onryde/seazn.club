// schedule.ts — B04's ONLY HTTP driver.
//
// One pass per division, in design §3.2's order: resolve the pack's `@`-court
// refs, PUT the schedule settings, apply the declared locks and SNAPSHOT what
// the product reports as locked, `auto`, `apply`, `validate`, then FETCH the
// board back. Everything downstream — `checker.ts`, `certificate.ts`, the
// report — reads the `Board` and `EncodedConstraints` this file produces and
// never talks to the server itself.
//
// -------------------------------------------------------------------------
// The three claims this file exists to make, and how each is kept honest
// -------------------------------------------------------------------------
//
// 1. THE BOARD IS FETCHED, NEVER ECHOED (design §4.1). Step 7 re-reads
//    `GET /api/v1/divisions/{id}/fixtures`; the `assignments` array POSTed at
//    step 5 is used for exactly one thing — the duration cross-check below —
//    and never for a court, a start or a lock. Assembling the board from our
//    own request body would prove the bench can echo itself, which is the
//    kickoff's own "a fixture that pre-seeds the end state cannot witness the
//    code that should have produced it", pointed at B04's core claim.
//
// 2. `--engine` IS AN ASSERTION, NOT A SELECTOR (design §1.1/§2.1).
//    `AutoScheduleRequest` (`apps/web/src/server/api-v1/schemas.ts:1643-1688`
//    — RE-PINNED: `tiny.ts` cites `:1496-1542` and the B04 design's own F5
//    correction cites `:1653-1687`; both are stale, which is exactly why these
//    pins are worth re-reading rather than copying) carries no engine field, and no env var, flag or setting selects one:
//    `build.ts:1165-1204` attempts the solver every time and falls back to
//    greedy on `MAX_SOLVER_QUEUE`, `!canSolveWithin`, or an unreachable
//    placement service. But `AutoScheduleResult.solver.engine`
//    (`schemas.ts:1713`) says which one RAN, forwarded verbatim from
//    `BuildResult.engine`. So the bench cannot choose and can identify — and
//    identifying is worth a gate, because `_RULES.md` §2 names the exact false
//    green it catches: set the placement vars on the test process instead of
//    the server and "every board quietly comes back greedy while your suite
//    reports on it. That is the false green, and it looks exactly like a pass."
//    `both` relaxes ONLY that assertion; every other gate is unchanged, so a
//    run is never made greener by asking for the comparison.
//
// 3. NOTHING IS DROPPED IN SILENCE. Every refusal this driver meets — a pack
//    that cannot be encoded (ruling R13), a locked fixture with no slot, an
//    `officials` element that is not readable, an `ends_at` that contradicts
//    `matchMinutes` — lands in `ScheduleOutcome.errors`, which is
//    `judgeDivision`'s FIFTH red trigger (`board.ts`). A finding with no path
//    to a verdict is inert, and inert is how a checker rule ends up
//    permanently green (failure class 3).
//
// -------------------------------------------------------------------------
// Two conventions worth stating before reading any function
// -------------------------------------------------------------------------
//
// RULING R12 — OCCUPANCY IS `[start, start + matchMinutes)`. `gapMinutes` is a
// spacing preference, never part of a court's occupancy, and design §3.3's
// rule list carries no gap rule. `BoardFixture.end` is therefore derived from
// `matchMinutes` ALONE. The two readings differ on every back-to-back pair, so
// this is not a detail: folding the gap in would make the checker measure
// overlaps against a duration the product never used.
//
// `errors` AND `findings` ARE ONE EVENT IN TWO REPRESENTATIONS, NEVER TWO
// EVENTS. Where this driver produces a structured `CheckerFinding` it also
// pushes one line into `errors`. The string is what reds the division through
// `judgeDivision`'s existing trigger; the struct is what lets the report name
// both fixtures and both numbers. Consumers must NOT merge `findings` into
// `CheckerReport.findings` as well, or one disagreement is reported twice.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeConstraints, type Board, type BoardCourt, type BoardFixture, type CheckerFinding, type EncodedConstraints } from "./board.ts";
import type { Session } from "./http.ts";
import { defaultTransport, type SeedTransport } from "./seed.ts";

const MINUTE_MS = 60_000;

/** The key a warn row with no structured `details` is tallied under.
 *
 *  `ScheduleConflict.details` is `.optional()` on the wire (`schemas.ts:1582`)
 *  — "there should be none, but the field stays optional to match the engine's
 *  own `Conflict.details?`". A row without it is still a warn row that
 *  happened, and dropping it would make the tally quietly under-report. */
const NO_DETAIL_KIND = "(no details.kind)";

/** `engine-<engine>.json` — the engine name becomes a FILENAME, so it is
 *  constrained to a plain identifier before it reaches `path.join`. */
const ENGINE_FILE_NAME = /^[a-z][a-z0-9_-]*$/;

// ---------------------------------------------------------------------------
// The wire shapes this driver reads — F4's hand-copy, WIDENED
// ---------------------------------------------------------------------------

/** `AutoScheduleResult` as far as B04 reads it (`schemas.ts:2097-2102`).
 *
 *  F4: `tiny.ts:717-726` declares THREE fields of a much larger wire schema, so
 *  a field added or renamed server-side is invisible to `tsc` here. This widens
 *  the copy to everything the report prints; it stays hand-maintained, same
 *  class as the known pad-shim trap, and every field is optional because a
 *  server one deploy behind may not send it — reading a missing field as a
 *  silent default is exactly what the assertions below refuse to do. */
export interface AutoScheduleOut {
  assignments?: readonly {
    fixture_id: string;
    scheduled_at: string;
    ends_at?: string | null;
    court_id: string;
    court_name?: string | null;
  }[];
  conflicts?: readonly WireConflict[];
  metrics?: {
    makespan_minutes: number;
    worst_idle_gap_minutes: number;
    court_imbalance_minutes: number;
    placed: number;
    total: number;
  };
  /** `ScheduleSolverInfo` (`schemas.ts:1704`). NON-optional on the wire —
   *  declared optional here only so a response that omits it is reportable
   *  rather than a TypeError. */
  solver?: {
    engine?: ActualEngine;
    status?: string;
    mode?: "build" | "reflow" | "polish";
    not_searched_reason?: string;
    tiers_completed?: number;
    tiers_total?: number;
    budget_expired?: boolean;
  };
}

/** `ScheduleConflict` (`schemas.ts:1548`), read through `details.kind`
 *  ONLY. Never `code` — a code is a family, `details.kind` is the rule — and
 *  never `detail`, which is deprecated pre-C3 English. */
interface WireConflict {
  fixture_id?: string;
  code?: string;
  blocking?: boolean;
  details?: { kind?: string };
}

interface ValidateOut {
  conflicts?: readonly WireConflict[];
}

/** `ScheduleSettings` (`schemas.ts:1446-1452`) — what `PUT
 *  /divisions/{id}/schedule-settings` RETURNS: the persisted config, not an
 *  echo of the request. `putScheduleSettings` returns it from the usecase and
 *  the route forwards it unmapped, which is what makes the round-trip check in
 *  `crossCheckSettings` possible at all. */
interface PutSettingsOut {
  config?: unknown;
  tz?: string;
}

/** `S.Fixture` (`schemas.ts:1000-1055`) minus the frozen `venue`/`court_label`
 *  the route strips. NOTE `scheduled_at` and NO `ends_at` — design §4.2's
 *  whole reason for deriving the end. */
interface WireFixture {
  id: string;
  division_id?: string;
  round_no?: number | null;
  pool_id?: string | null;
  ext_key?: string | null;
  home_entrant_id?: string | null;
  away_entrant_id?: string | null;
  scheduled_at?: string | null;
  court_id?: string | null;
  court_name?: string | null;
  venue_id?: string | null;
  officials?: readonly unknown[];
  schedule_locked?: boolean;
}

/** `S.VenueWithCourts` (`schemas.ts:4531`) — snake_case on the wire, camelCase
 *  on the engine's `CourtHoursRow`/`CourtExceptionRow`. That rename happens
 *  exactly once, in `toBoardCourt` below. */
interface WireVenue {
  id: string;
  courts?: readonly {
    id: string;
    name?: string;
    venue_id?: string;
    hours?: readonly { weekday: number; open_min: number; close_min: number }[];
    exceptions?: readonly {
      date: string;
      closed: boolean;
      open_min?: number | null;
      close_min?: number | null;
    }[];
  }[];
}

// ---------------------------------------------------------------------------
// This module's own vocabulary
// ---------------------------------------------------------------------------

/** What the operator ASKED for on `--engine` (`bench.ts:66,78-81`). */
export type RequestedEngine = "optimized" | "greedy" | "both";

/** What actually produced the board — `AutoScheduleResult.solver.engine`
 *  (`schemas.ts:1713`), forwarded verbatim from `BuildResult.engine`. */
export type ActualEngine = "greedy" | "optimized";

/** `ScheduleMetrics` (`schemas.ts:1693-1699`), camelCased once, here. */
export interface ScheduleMetricsOut {
  makespanMinutes: number;
  worstIdleGapMinutes: number;
  courtImbalanceMinutes: number;
  placed: number;
  total: number;
}

/** One fixture the pack wants pinned before `auto` runs (design §4.4).
 *
 *  `scheduledAt`/`courtId` are optional because a lock is meaningful in two
 *  situations: pinning a fixture the product has ALREADY placed, and declaring
 *  a slot and pinning it in one PATCH. `PatchFixture` (`schemas.ts:964-979`)
 *  accepts all three fields together, so both are one call.
 *
 *  `expected_seq` is deliberately absent from this type and never sent: the
 *  schema is `.partial()`, so omitting it is legal, and a stale value 409s
 *  `SEQ_CONFLICT`. */
export interface ScheduleLock {
  fixtureId: string;
  scheduledAt?: string;
  courtId?: string;
}

/** One division to schedule. The caller has already resolved every ref to a
 *  real id EXCEPT the `@`-sigils inside `scheduleConfig`, which this module
 *  resolves (through `encodeConstraints`, the single resolver) so that the
 *  product and the checker's oracle are handed the same courts. */
export interface ScheduleDivision {
  divisionRef: string;
  divisionId: string;
  stageId: string;
  /** The pack's OPAQUE `scheduleConfig` (`pack-schema.ts:503`), `@`-refs
   *  unresolved. Absent for a division whose pack declares none: nothing is
   *  PUT, and the encoding falls through to the product's own defaults. */
  scheduleConfig?: Record<string, unknown>;
  /** The IANA zone the config's wall clocks are read in; sent alongside
   *  `config` and carried onto the `Board`. */
  tz: string;
  isRoundRobin: boolean;
  locks?: readonly ScheduleLock[];
  /** Did the PACK declare officials for this division? Resolved by the caller,
   *  who holds the pack, and forwarded verbatim onto `EncodedConstraints` at
   *  both `encodeConstraints` call sites — this module never derives it from
   *  the board it fetched, which would compare the fetch against itself.
   *
   *  REQUIRED, not optional, and that is the point: a caller that could omit
   *  this would default it to `false` and ship design §4.3's rule inert —
   *  failure class 3, wearing a type annotation.
   *
   *  `Board` carries no officials signal, and `EncodedConstraints` carries
   *  exactly one — this field, put there by this driver. So the checker's red
   *  is only as live as this forwarding is: nothing else in the run can tell
   *  an officials rule that found nothing from one that had nothing to find. */
  declaresOfficials: boolean;
}

export interface ScheduleLayerInput {
  base: string;
  /** An ALREADY AUTHENTICATED session. This driver never signs in — B03's
   *  seeder owns identity, and a second sign-in here would be a second
   *  authority on which org the run is talking to. */
  session: Session;
  orgId: string;
  divisions: readonly ScheduleDivision[];
  /** `SeededSuite.courtIdByRef` (`seed.ts:166`). */
  courtIdByRef: ReadonlyMap<string, string>;
  engine: RequestedEngine;
  transport?: SeedTransport;
  /** Injected so `wallMs` is deterministic under test. Defaults to
   *  `performance.now`, the same clock `runTinySuite` already times with. */
  now?: () => number;
}

/** One division's walk through the seven steps. */
export interface ScheduleOutcome {
  divisionRef: string;
  divisionId: string;
  stageId: string;
  requestedEngine: RequestedEngine;
  /** Absent when `auto` never answered, or answered without telemetry. */
  actualEngine?: ActualEngine;
  solverStatus?: string;
  notSearchedReason?: string;
  mode?: "build" | "reflow" | "polish";
  budgetExpired?: boolean;
  tiersCompleted?: number;
  tiersTotal?: number;
  metrics?: ScheduleMetricsOut;
  /** `/validate` rows with `blocking: true` — layer 1, asserted at zero and
   *  NOT widened to warn level (design §2.2). */
  blockingCount: number;
  /** Warn-level rows per `details.kind`. Report-only. */
  warnKindTally: Readonly<Record<string, number>>;
  /** Fixtures with no slot on the FETCHED board — never `metrics.total -
   *  metrics.placed`, which describes the PROPOSAL. */
  unplacedCount: number;
  wallMs: number;
  errors: readonly string[];
  /** The structured half of whatever is already named in `errors`. See this
   *  module's header: one event, two representations — never merged into
   *  `CheckerReport.findings`. */
  findings: readonly CheckerFinding[];
}

export interface ScheduleLayerResult {
  outcomes: readonly ScheduleOutcome[];
  /** KEYED BY `divisionRef`, NEVER BY INDEX. A division that failed before its
   *  board was fetched contributes an outcome and no board, so the three arrays
   *  are not index-aligned. */
  boards: readonly Board[];
  /** Keyed by `divisionRef`, for the same reason. */
  constraints: readonly EncodedConstraints[];
}

/** What one leg writes into `engine-<engine>.json` (ruling R3).
 *
 *  Declared by the WRITER rather than the reader: this is the shape T5's delta
 *  reads back, and a shape owned by its consumer drifts from what is actually
 *  on disk. `verdict` is filled by the caller, because the checker and the
 *  certificate run after this layer returns — `runScheduleLayer` has no
 *  verdict to state. */
export interface EngineSnapshotDivision {
  divisionRef: string;
  metrics?: ScheduleMetricsOut;
  solverStatus?: string;
  notSearchedReason?: string;
  mode?: "build" | "reflow" | "polish";
  budgetExpired?: boolean;
  tiersCompleted?: number;
  tiersTotal?: number;
  blockingCount: number;
  unplacedCount: number;
  wallMs: number;
  verdict?: { red: boolean; reasons: readonly string[] };
}

export interface EngineSnapshot {
  /** `resolveRunId(cliArg, gitSha)` (`report.ts:180`), resolved by the CALLER.
   *  Deliberately not re-resolved here: two resolution points for one identity
   *  is how a leg lands in a directory its sibling never looks in. */
  runId: string;
  requestedEngine: RequestedEngine;
  engine: ActualEngine;
  divisions: readonly EngineSnapshotDivision[];
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Diagnostic formatting only. Deliberately the same body as `board.ts`'s own
 *  private `show` — it is a message formatter rather than a fact, and this
 *  module cannot import a non-exported helper. */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Circular, or a BigInt `JSON.stringify` refuses — fall through to the type
    // tag rather than letting a diagnostic throw over the real error.
  }
  return Object.prototype.toString.call(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Epoch ms, or `undefined` for an absent or unparseable instant. Absence is
 *  UNPLACED and is a legitimate board state; unreadability is reported by the
 *  caller, which is the only side that knows which fixture it belongs to. */
function instant(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `scheduleConfig` the PRODUCT is sent: the pack's own record with every
 *  `@`-sigilled court ref replaced by the id `encodeConstraints` resolved.
 *
 *  Built FROM the encoding rather than by a second resolver on purpose. Two
 *  resolvers would be two authorities on which court a ref names, and they
 *  would disagree exactly where it matters — the product would place on one
 *  court while the checker judged another. `encodeConstraints` maps
 *  `courts[]` and `blackouts[]` positionally, so the indices line up.
 *
 *  Only keys the pack ACTUALLY declared are replaced: adding `courts: []` to a
 *  config that never mentioned courts would tell the product the division has
 *  none, which is a different setting, not a no-op. */
function resolvedConfig(
  cfg: Record<string, unknown>,
  enc: EncodedConstraints,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  if (Array.isArray(cfg.courts)) out.courts = [...enc.courtIds];
  if (Array.isArray(cfg.blackouts)) {
    // `Array.isArray` narrows an `unknown` to `any[]`, which would let every
    // row below through unchecked. Re-widened to `unknown[]` so `isRecord` is
    // the only thing that can open one.
    const rows: unknown[] = cfg.blackouts;
    out.blackouts = rows.map((raw, i) => {
      const row = isRecord(raw) ? { ...raw } : raw;
      const resolved = enc.blackouts[i];
      // A GLOBAL blackout (no `court` key) stays global — widening it by
      // writing a court in would block one court instead of every one.
      if (isRecord(row) && "court" in row && resolved?.courtId !== undefined) {
        row.court = resolved.courtId;
      }
      return row;
    });
  }
  return out;
}

function tallyWarnKinds(conflicts: readonly WireConflict[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const c of conflicts) {
    // Blocking rows are layer 1's gate, counted separately. The tally is the
    // warn-level population the product does NOT gate (design §1.2/§2.2).
    if (c.blocking === true) continue;
    const kind = typeof c.details?.kind === "string" ? c.details.kind : NO_DETAIL_KIND;
    tally[kind] = (tally[kind] ?? 0) + 1;
  }
  return tally;
}

/** One court, wire rows renamed to the engine's own shapes and NOTHING else —
 *  deliberately not folded through `usableWindows` (design §2.3): the checker's
 *  claim is that it recomputes containment independently, and folding through
 *  the product's own lib first would make it agree by construction. */
function toBoardCourt(venueId: string, court: NonNullable<WireVenue["courts"]>[number]): BoardCourt {
  return {
    courtId: court.id,
    name: court.name ?? court.id,
    venueId: court.venue_id ?? venueId,
    hours: (court.hours ?? []).map((h) => ({
      weekday: h.weekday,
      openMin: h.open_min,
      closeMin: h.close_min,
    })),
    exceptions: (court.exceptions ?? []).map((e) => ({
      date: e.date,
      closed: e.closed,
      // NULL ON THE WIRE BECOMES ABSENT, NEVER 0. `CourtExceptionRow`'s range
      // is optional and `usableWindows` reads a 0 as midnight, so laundering a
      // null into a number would invent an open window on a closed day.
      ...(typeof e.open_min === "number" ? { openMin: e.open_min } : {}),
      ...(typeof e.close_min === "number" ? { closeMin: e.close_min } : {}),
    })),
  };
}

/** Compares what the product KEPT against what the pack DECLARED.
 *
 *  `ScheduleConfig` (`schemas.ts:1283`) is a plain `z.object`, NOT `.strict()`
 *  — unlike `PatchFixture` and `ApplyScheduleRequest`, which both are. A zod
 *  object STRIPS an unknown key rather than refusing it, so a pack that
 *  declares a knob this product build does not have gets a 200, a config
 *  without it, and no indication whatsoever. The checker then judges the board
 *  against the declared value while the scheduler never received it: a
 *  false-clean of the same family as the validated-but-unsent defect this
 *  programme has already paid for, and the reason a 200 is not evidence that
 *  anything was stored.
 *
 *  Two checks, deliberately separated because they carry different
 *  false-positive risk:
 *
 *   - A DECLARED KEY THAT DID NOT COME BACK was stripped. Unambiguous.
 *   - A KEY THAT CAME BACK CHANGED. Compared through `sameConfigValue`, which
 *     treats two parseable instants as equal when they name the same moment —
 *     the product re-serialises `IsoDateTime`, and `...Z` against `...+00:00`
 *     is a formatting difference, not a divergence. Comparing those as strings
 *     would red every run and the check would be deleted within a day.
 *
 *  Extra keys in the RESPONSE are not reported: `ScheduleConfig` applies
 *  `.default()`s, and a product filling in a knob the pack left out is the
 *  documented behaviour rather than a disagreement. */
function crossCheckSettings(sent: Record<string, unknown>, persisted: unknown, sink: Sink): void {
  if (!isRecord(persisted)) {
    sink.error(
      `schedule-settings returned no readable config (${show(persisted)}), so what the product kept ` +
        "of the pack's declaration is unknown and every rule below is judged against an unverified oracle",
    );
    return;
  }
  for (const [key, value] of Object.entries(sent)) {
    if (!(key in persisted)) {
      sink.error(
        `schedule-settings DROPPED "${key}" — the pack declared it and the product did not keep it. ` +
          "ScheduleConfig is not .strict(), so an unknown key is stripped rather than refused, and the " +
          "200 above means nothing; the checker would judge this board against a value the scheduler never had",
      );
      continue;
    }
    if (!sameConfigValue(value, persisted[key])) {
      sink.error(
        `schedule-settings CHANGED "${key}": the pack declared ${show(value)} and the product kept ` +
          `${show(persisted[key])}`,
      );
    }
  }
}

/** Structural equality, with two instants that name the same moment treated as
 *  equal. Records compare only the keys the PACK declared — see
 *  `crossCheckSettings` on why an added default is not a divergence. */
function sameConfigValue(sent: unknown, kept: unknown): boolean {
  if (typeof sent === "string" && typeof kept === "string") {
    const a = instant(sent);
    const b = instant(kept);
    return a !== undefined && b !== undefined ? a === b : sent === kept;
  }
  if (Array.isArray(sent) && Array.isArray(kept)) {
    const keptArr: readonly unknown[] = kept;
    return (
      sent.length === keptArr.length &&
      (sent as readonly unknown[]).every((v, i) => sameConfigValue(v, keptArr[i]))
    );
  }
  if (isRecord(sent) && isRecord(kept)) {
    return Object.keys(sent).every((k) => k in kept && sameConfigValue(sent[k], kept[k]));
  }
  return sent === kept;
}

/** A sink both representations of one event go through, so the string and the
 *  struct can never disagree about what happened. */
class Sink {
  readonly errors: string[] = [];
  readonly findings: CheckerFinding[] = [];

  constructor(private readonly divisionRef: string) {}

  /** Reportable, but with no member of the closed `CheckerFindingKind` union
   *  to carry it — a driver-level refusal rather than a board breach. */
  error(text: string): void {
    this.errors.push(`${this.divisionRef}: ${text}`);
  }

  /** A board breach the driver (not the checker) is the only side able to see.
   *  Also lands in `errors`, because a finding with no path to a verdict never
   *  reds anything (ruling R13's reasoning, applied to the driver's own). */
  finding(finding: Omit<CheckerFinding, "divisionRef">): void {
    this.findings.push({ ...finding, divisionRef: this.divisionRef });
    this.errors.push(`${this.divisionRef}: ${finding.kind} — ${finding.detail}`);
  }
}

/** `Fixture.officials` is `z.array(z.unknown())` on the wire
 *  (`schemas.ts:1033`), so nothing guarantees the element shape. Each one is
 *  shape-guarded here and an unreadable element is REPORTED, never dropped —
 *  design §4.3: a silently-shrinking array makes every officials rule
 *  vacuously green. */
function readOfficialIds(fixture: WireFixture, sink: Sink): string[] {
  const ids: string[] = [];
  for (const raw of fixture.officials ?? []) {
    const id = isRecord(raw) ? raw.official_id : undefined;
    if (typeof id === "string" && id.length > 0) {
      ids.push(id);
      continue;
    }
    sink.finding({
      kind: "officials_unreadable",
      fixtureIds: [fixture.id],
      detail: `fixture ${fixture.id} carries an officials entry with no readable official_id: ${show(raw)}`,
    });
  }
  return ids;
}

function toBoardFixture(
  fixture: WireFixture,
  division: ScheduleDivision,
  matchMinutes: number,
  sink: Sink,
): BoardFixture {
  const start = instant(fixture.scheduled_at);
  if (fixture.scheduled_at != null && start === undefined) {
    sink.error(`fixture ${fixture.id} has an unreadable scheduled_at (${show(fixture.scheduled_at)})`);
  }
  const entrantIds = [fixture.home_entrant_id, fixture.away_entrant_id].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  return {
    fixtureId: fixture.id,
    ...(typeof fixture.ext_key === "string" ? { extKey: fixture.ext_key } : {}),
    divisionId: division.divisionId,
    divisionRef: division.divisionRef,
    ...(typeof fixture.round_no === "number" ? { roundNo: fixture.round_no } : {}),
    ...(typeof fixture.pool_id === "string" ? { poolId: fixture.pool_id } : {}),
    ...(start === undefined ? {} : { start, end: start + matchMinutes * MINUTE_MS }),
    ...(typeof fixture.court_id === "string" ? { courtId: fixture.court_id } : {}),
    ...(typeof fixture.court_name === "string" ? { courtName: fixture.court_name } : {}),
    ...(typeof fixture.venue_id === "string" ? { venueId: fixture.venue_id } : {}),
    entrantIds,
    // NO SOURCE ON THE WIRE. `S.Fixture` carries entrants and officials and no
    // persons, and `GET /divisions/{id}/fixtures` is the only fixture read path
    // the design's step 7 makes. Left empty rather than guessed; recorded as a
    // finding in the task report, because it makes any `rest_scope:
    // "per_person"` rule unable to fire.
    personIds: [],
    officialIds: readOfficialIds(fixture, sink),
    locked: fixture.schedule_locked === true,
  };
}

/** Design §4.2 — where `auto` supplied its own `ends_at`, COMPARE it against
 *  the derivation and report a disagreement rather than preferring either.
 *
 *  A silent preference here would let the checker measure overlaps against a
 *  duration the product does not agree with, and every overlap rule depends on
 *  that number. The derivation still wins on the board (`matchMinutes` is the
 *  pack's declared occupancy, R12); what changes is that the division reds and
 *  says so. */
function crossCheckDurations(auto: AutoScheduleOut, matchMinutes: number, sink: Sink): void {
  for (const a of auto.assignments ?? []) {
    if (a.ends_at == null) continue;
    const from = instant(a.scheduled_at);
    const to = instant(a.ends_at);
    if (from === undefined || to === undefined) {
      sink.error(
        `assignment for fixture ${a.fixture_id} has an unreadable scheduled_at/ends_at pair ` +
          `(${show(a.scheduled_at)} .. ${show(a.ends_at)})`,
      );
      continue;
    }
    const declaredMinutes = (to - from) / MINUTE_MS;
    if (declaredMinutes === matchMinutes) continue;
    sink.finding({
      kind: "duration_disagreement",
      fixtureIds: [a.fixture_id],
      detail:
        `auto proposed a ${declaredMinutes}-minute slot for fixture ${a.fixture_id} while the pack ` +
        `declares matchMinutes ${matchMinutes} — the board is measured on matchMinutes, so every ` +
        `overlap rule and the product disagree about this fixture's duration`,
      measured: declaredMinutes,
      required: matchMinutes,
    });
  }
}

// ---------------------------------------------------------------------------
// runScheduleLayer — the seven-step walk, once per division
// ---------------------------------------------------------------------------

/** Drives every division through design §3.2's seven steps and returns what
 *  the three verification layers need: one `ScheduleOutcome` per division, the
 *  FETCHED `Board`s, and the `EncodedConstraints` the checker judges against.
 *
 *  Never throws for a division: an HTTP refusal, a pack that cannot be encoded
 *  and a locked fixture with no slot all become that division's `errors`, and
 *  the walk continues to the next one. A run that abandoned five divisions
 *  because the first was mis-authored would report on none of them. */
export async function runScheduleLayer(input: ScheduleLayerInput): Promise<ScheduleLayerResult> {
  const t = input.transport ?? defaultTransport;
  const now = input.now ?? (() => performance.now());
  const outcomes: ScheduleOutcome[] = [];
  const boards: Board[] = [];
  const constraints: EncodedConstraints[] = [];

  for (const division of input.divisions) {
    const walked = await runDivision(input, division, t, now);
    outcomes.push(walked.outcome);
    if (walked.constraints !== undefined) constraints.push(walked.constraints);
    if (walked.board !== undefined) boards.push(walked.board);
  }

  return { outcomes, boards, constraints };
}

async function runDivision(
  input: ScheduleLayerInput,
  division: ScheduleDivision,
  t: SeedTransport,
  now: () => number,
): Promise<{ outcome: ScheduleOutcome; board?: Board; constraints?: EncodedConstraints }> {
  const started = now();
  const sink = new Sink(division.divisionRef);
  const { base, session: s } = input;
  const outcome: {
    -readonly [K in keyof ScheduleOutcome]: ScheduleOutcome[K];
  } = {
    divisionRef: division.divisionRef,
    divisionId: division.divisionId,
    stageId: division.stageId,
    requestedEngine: input.engine,
    blockingCount: 0,
    warnKindTally: {},
    unplacedCount: 0,
    wallMs: 0,
    errors: sink.errors,
    findings: sink.findings,
  };
  let board: Board | undefined;
  let encoded: EncodedConstraints | undefined;

  try {
    // --- Step 1: resolve the pack's `@`-court refs -------------------------
    // BEFORE any HTTP, deliberately: a pack that cannot be encoded is an
    // authoring bug, and `runTinySuite`'s own "stage 0 FIRST, and nothing is
    // created if it refuses" applies here for the same reason. `pins: []`
    // because the real pins are not known until step 3; the second call below
    // differs in nothing else.
    //
    // RULING R13 — this THROWS, and catching it is this module's job. A thrown
    // encode has no path to a verdict at all, only to a stack trace, so it is
    // routed into `errors` and reds the division through `judgeDivision`'s
    // fifth trigger. There is no non-throwing mode, and asking for one would
    // give the wave two encoders that differ exactly where it matters.
    const resolution = encodeConstraints({
      divisionRef: division.divisionRef,
      scheduleConfig: division.scheduleConfig,
      courtIdByRef: input.courtIdByRef,
      isRoundRobin: division.isRoundRobin,
      pins: [],
      // FROM THE PACK, never from the board. This is the whole point of the
      // field: `checkBoard`'s officials rule has to tell "this division has no
      // officials" from "this division's officials did not come back", and an
      // empty `officialIds` array is both. Deriving it from the fetch would
      // compare the board against itself and leave design §4.3's rule as
      // vacuous as it was before the field existed.
      declaresOfficials: division.declaresOfficials,
    });

    // --- Step 2: PUT the resolved schedule settings ------------------------
    if (division.scheduleConfig !== undefined) {
      const sent = resolvedConfig(division.scheduleConfig, resolution);
      const settings = await t.request<PutSettingsOut>(
        base,
        s,
        `/api/v1/divisions/${division.divisionId}/schedule-settings`,
        { method: "PUT", body: { config: sent, tz: division.tz } },
      );
      // THE RESPONSE IS EVIDENCE, NOT AN ACKNOWLEDGEMENT — see
      // `crossCheckSettings`.
      crossCheckSettings(sent, settings?.config, sink);
    }

    // --- Step 3: lock, then SNAPSHOT what the product reports as locked ----
    for (const lock of division.locks ?? []) {
      await t.request(base, s, `/api/v1/fixtures/${lock.fixtureId}`, {
        method: "PATCH",
        body: {
          schedule_locked: true,
          ...(lock.scheduledAt === undefined ? {} : { scheduled_at: lock.scheduledAt }),
          ...(lock.courtId === undefined ? {} : { court_id: lock.courtId }),
        },
      });
    }
    const before = await t.request<readonly WireFixture[]>(
      base,
      s,
      `/api/v1/divisions/${division.divisionId}/fixtures`,
    );
    const pins = snapshotPins(before, sink);
    encoded = encodeConstraints({
      divisionRef: division.divisionRef,
      scheduleConfig: division.scheduleConfig,
      courtIdByRef: input.courtIdByRef,
      isRoundRobin: division.isRoundRobin,
      pins,
      declaresOfficials: division.declaresOfficials,
    });

    // --- Step 4: propose ----------------------------------------------------
    // `only_unlocked: false` IS THE BUILD, and an empty body cannot be one.
    // `AutoScheduleRequest` is a `z.preprocess` that DERIVES `mode` from this
    // flag (`schemas.ts:1643-1651`): `body.only_unlocked === false ? "build" :
    // "reflow"`, with the strict `=== false` there precisely because an ABSENT
    // flag defaults to `true` and must derive a reflow. So `body: {}` — the
    // obvious call, and what `tiny.ts` sends today — silently asks for a
    // REFLOW of a stage that has never been scheduled, and the bench would
    // report a first-time build it never requested.
    //
    // The product's own primary Auto-schedule button posts `false` here for
    // exactly this reason (`only_unlocked`'s doc comment), so this is the
    // organiser path, not a bench-only trick. Pins are unaffected: since
    // #pins-in-build "a lock is honoured on every mode now, unconditionally",
    // and `ignore_locks` — which this driver never sends — is the only way off
    // that. B04 issues only this one mode; design §4.5 defers the reflow/repair
    // probe to B17, and if that arrives, the empty-proposal refusal below has
    // to become conditional on the mode.
    const auto = await t.request<AutoScheduleOut>(
      base,
      s,
      `/api/v1/stages/${division.stageId}/schedule/auto`,
      { method: "POST", body: { only_unlocked: false } },
    );
    readSolver(auto, outcome, input.engine, sink);

    // --- Step 5: persist ----------------------------------------------------
    // AN EMPTY PROPOSAL IS NOT AN EMPTY APPLY. `ApplyScheduleRequest`'s
    // `assignments` is `.min(1).max(500)` (`schemas.ts:2146-2147`) while
    // `AutoScheduleResult`'s has NO minimum (`:2098`), so the one response the
    // solver returns on a capacity refusal is a body this endpoint rejects.
    // Posting it anyway 400s, and the throw would abort this division BEFORE
    // `/validate` and before the board fetch — destroying the exact evidence
    // design §3.4's `UNPLACED` branch exists to report. A board the solver
    // could not place is a finding, not a crash.
    const proposed = auto.assignments ?? [];
    if (proposed.length === 0) {
      // Loud, because this driver only ever issues a BUILD (step 4): on a
      // freshly generated stage an empty proposal is always a refusal, never a
      // legitimate no-op. A future reflow leg (B17) would need this gated on
      // the mode, since a reflow of an already-optimal board proposes nothing
      // and is correct to.
      sink.error(
        `auto proposed 0 assignments, so nothing was applied — the board fetched below is the ` +
          `PRE-AUTO state, not a scheduled one (solver.status=${outcome.solverStatus ?? "absent"}, ` +
          `metrics.placed=${outcome.metrics?.placed ?? "absent"}/${outcome.metrics?.total ?? "absent"})`,
      );
    } else {
      await t.request(base, s, `/api/v1/stages/${division.stageId}/schedule/apply`, {
        method: "POST",
        body: {
          assignments: proposed.map((a) => ({
            fixture_id: a.fixture_id,
            scheduled_at: a.scheduled_at,
            court_id: a.court_id,
          })),
        },
      });
    }
    crossCheckDurations(auto, encoded.matchMinutes, sink);

    // --- Step 6: layer 1 ----------------------------------------------------
    const validated = await t.request<ValidateOut>(
      base,
      s,
      `/api/v1/divisions/${division.divisionId}/schedule/validate`,
      { method: "POST" },
    );
    const conflicts = validated.conflicts ?? [];
    outcome.blockingCount = conflicts.filter((c) => c.blocking === true).length;
    outcome.warnKindTally = tallyWarnKinds(conflicts);

    // --- Step 7: FETCH the board -------------------------------------------
    const after = await t.request<readonly WireFixture[]>(
      base,
      s,
      `/api/v1/divisions/${division.divisionId}/fixtures`,
    );
    const venues = await t.request<readonly WireVenue[]>(base, s, `/api/v1/orgs/${input.orgId}/venues`);
    board = {
      divisionId: division.divisionId,
      divisionRef: division.divisionRef,
      tz: division.tz,
      fixtures: after.map((f) => toBoardFixture(f, division, encoded!.matchMinutes, sink)),
      courts: venues.flatMap((v) => (v.courts ?? []).map((c) => toBoardCourt(v.id, c))),
    };
    outcome.unplacedCount = board.fixtures.filter((f) => f.start === undefined).length;

    // NO DECLARED-BUT-NONE RED HERE, deliberately (ruling R21). This driver
    // carried one, and so does `checker.ts`'s officials rule; two reds for one
    // fact is one authority too many, and the checker's is the better of the
    // pair — it is gated on the same `placed` set every other officials rule
    // judges, so it cannot disagree with its own neighbours about which
    // fixtures counted. What this module owes that rule is the FACT, not a
    // second opinion: `declaresOfficials` goes onto `EncodedConstraints` at
    // both `encodeConstraints` call sites above, and `checkBoard` reds on it.
    //
    // The per-element WIRE guard in `readOfficialIds` stays. That one sits
    // where `z.array(z.unknown())` actually is and can fire on a real board;
    // by the time a `BoardFixture` reaches the checker the field is
    // `readonly string[]` and there is nothing left to shape-guard.
  } catch (err) {
    sink.error(messageOf(err));
  }

  outcome.wallMs = Math.round(now() - started);
  return {
    outcome,
    ...(board === undefined ? {} : { board }),
    ...(encoded === undefined ? {} : { constraints: encoded }),
  };
}

/** Pins are what the PRODUCT reports as locked at step 3, never the locks the
 *  bench asked for — design §3.2. Snapshotting our own intention would make
 *  the pin rule assert that we sent a PATCH, which is not a claim about the
 *  scheduler at all. */
function snapshotPins(
  fixtures: readonly WireFixture[],
  sink: Sink,
): { fixtureId: string; start: number; courtId: string }[] {
  const pins: { fixtureId: string; start: number; courtId: string }[] = [];
  for (const f of fixtures) {
    if (f.schedule_locked !== true) continue;
    const start = instant(f.scheduled_at);
    const courtId = typeof f.court_id === "string" && f.court_id.length > 0 ? f.court_id : undefined;
    if (start === undefined || courtId === undefined) {
      // A lock on a fixture with no slot pins nothing, so pin integrity can
      // never fail for it. Dropping it in silence is how the rule ends up
      // decoration on a pack that thought it had declared a pin.
      sink.error(
        `fixture ${f.id} is schedule_locked but has no ${start === undefined ? "scheduled_at" : "court_id"}, ` +
          "so it cannot be carried as a pin and pin integrity is unchecked for it",
      );
      continue;
    }
    pins.push({ fixtureId: f.id, start, courtId });
  }
  return pins;
}

/** Records the solver telemetry and ASSERTS the engine (design §2.1). */
function readSolver(
  auto: AutoScheduleOut,
  outcome: { -readonly [K in keyof ScheduleOutcome]: ScheduleOutcome[K] },
  requested: RequestedEngine,
  sink: Sink,
): void {
  if (auto.metrics !== undefined) {
    outcome.metrics = {
      makespanMinutes: auto.metrics.makespan_minutes,
      worstIdleGapMinutes: auto.metrics.worst_idle_gap_minutes,
      courtImbalanceMinutes: auto.metrics.court_imbalance_minutes,
      placed: auto.metrics.placed,
      total: auto.metrics.total,
    };
  }

  const solver = auto.solver;
  if (solver === undefined || solver.engine === undefined) {
    // `AutoScheduleResult.solver` is NON-optional on the wire
    // (`schemas.ts:2101`) and `engine` is a required enum inside it, so this is
    // a contract break, not a shrug. Recording `actualEngine: undefined` and
    // moving on would put `engine-undefined.json` on disk and assert nothing.
    sink.error(
      `auto returned no solver.engine, so the ${requested} engine assertion could not be made ` +
        "(AutoScheduleResult.solver is required on the wire)",
    );
    return;
  }

  outcome.actualEngine = solver.engine;
  if (solver.status !== undefined) outcome.solverStatus = solver.status;
  if (solver.not_searched_reason !== undefined) outcome.notSearchedReason = solver.not_searched_reason;
  if (solver.mode !== undefined) outcome.mode = solver.mode;
  if (solver.budget_expired !== undefined) outcome.budgetExpired = solver.budget_expired;
  if (solver.tiers_completed !== undefined) outcome.tiersCompleted = solver.tiers_completed;
  if (solver.tiers_total !== undefined) outcome.tiersTotal = solver.tiers_total;

  // `both` asserts NOTHING about the engine — and nothing else is relaxed.
  if (requested === "both" || requested === solver.engine) return;
  sink.error(
    `expected ${requested} engine, got ${solver.engine} ` +
      `(solver.status=${solver.status ?? "absent"}, not_searched_reason=${solver.not_searched_reason ?? "absent"}) — ` +
      "nothing in the product selects an engine, so this is the placement service's availability, " +
      "the board's size, or the solver queue, and the status above says which",
  );
}

// ---------------------------------------------------------------------------
// The engine artifact — one file per LEG, both legs in one run directory
// ---------------------------------------------------------------------------

/** `<reportDir>/<runId>/engine-<engine>.json`.
 *
 *  `runId` is the git SHA (`resolveRunId`, `report.ts:180-182`), so the two
 *  legs of one commit land in the SAME directory — which is exactly why the
 *  engine goes in the FILENAME rather than the directory. Putting it in the
 *  directory would give the two legs different run ids for one commit, and
 *  leaving it out entirely would have the second leg overwrite the first while
 *  reporting a delta of a file against itself.
 *
 *  `payload` is `unknown` because the caller composes it AFTER the checker and
 *  the certificate have run — `runScheduleLayer` has no verdict to state. The
 *  shape it should carry is `EngineSnapshot`, declared in this module (ruling
 *  R3) because the writer owns the shape it writes. */
export async function writeEngineArtifact(
  reportDir: string,
  runId: string,
  engine: string,
  payload: unknown,
): Promise<string> {
  if (!ENGINE_FILE_NAME.test(engine)) {
    // The engine name becomes a path segment. A caller that passed a traversal
    // or an empty string would write outside the run directory, and the read
    // side would never find it again.
    throw new Error(
      `schedule: engine "${engine}" is not a plain identifier, so it cannot name an artifact file`,
    );
  }
  const dir = path.join(reportDir, runId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `engine-${engine}.json`);
  await writeFile(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return file;
}

/** Every `engine-*.json` in one run directory, keyed by the engine in its
 *  name — this leg's own file included, so a caller comparing legs sees both
 *  through one read.
 *
 *  An ABSENT directory is `{}`: the first leg of a two-leg run has no sibling
 *  yet, and "no delta to emit" is a legitimate state. A MALFORMED artifact
 *  throws, naming the file. Those two are deliberately different — skipping a
 *  truncated file would render "greedy only" for a run that has two legs, and
 *  a missing delta looks exactly like a single-leg run. This function's return
 *  type has no error channel, so throwing is the only way it can be loud. */
export async function readEngineArtifacts(
  reportDir: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const dir = path.join(reportDir, runId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const name of [...names].sort()) {
    const match = /^engine-(.+)\.json$/.exec(name);
    if (match === null) continue;
    const file = path.join(dir, name);
    const text = await readFile(file, "utf8");
    try {
      out[match[1]] = JSON.parse(text);
    } catch (err) {
      throw new Error(`schedule: ${name} is not readable JSON (${messageOf(err)}) — ${file}`);
    }
  }
  return out;
}
