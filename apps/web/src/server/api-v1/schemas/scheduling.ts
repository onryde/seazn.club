// /api/v1 contracts — scheduling console (doc 12): ScheduleConfig and settings, rule codes, conflicts and their detail, auto-schedule request and metrics.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
// #398: durable division rules speak the SAME vocabulary a compiled instruction
// does, so the wire schema reuses the engine's zod rather than restating it —
// a second declaration is a second thing to drift.
import { HardConstraint, type ConflictDetailKind } from "@seazn/engine/scheduling";
// m2 — the ONE Intl-backed zone validator, reused rather than restated, so
// `schedule_settings.tz` refuses exactly what `users.timezone` (lib/types.ts)
// and `organizations.timezone` (api/orgs/[id]/route.ts) already refuse.
// RELATIVE with an explicit `.ts` extension, NOT the `@/` alias, for the same
// reason as registration-rules.ts above: this module is shared with the
// standalone OpenAPI generator (scripts/openapi-gen.ts), which runs under bare
// `node --experimental-strip-types` with no tsconfig `paths` resolution.
// lib/tz.ts is deliberately import-free, so it is safe for that generator.
import { isValidIana } from "../../../lib/tz.ts";
import { CourtId, Uuid } from "./common.ts";
import { ENDS_BEFORE_STARTS } from "./competitions.ts";
import { Fixture } from "./scoring.ts";

// ---------------------------------------------------------------------------
// Scheduling console (doc 12, PROMPT-17)
// ---------------------------------------------------------------------------

/** The wire key CAPACITY_IMPOSSIBLE's 422 carries its report under
 *  (`HttpError.extra`, spread verbatim onto `error.*` by api-v1/http.ts —
 *  no rename). Lives here, not in the server-only capacity-guard.ts,
 *  because openapi.ts documents it too and openapi.ts is NOT server-only
 *  (it's imported by /api/v1/openapi.json/route.ts, a live bundled route,
 *  as well as the CI drift script) — api-v1/schemas/ is the one home both
 *  capacity-guard.ts and openapi.ts can import without crossing that
 *  boundary. A P1 review finding: the throw site, the OpenAPI doc and
 *  smoke.ts's assertion had each spelled this differently (`report` vs
 *  `capacity_report`), so the smoke check could never pass. Import this,
 *  never retype the string. */
export const CAPACITY_REPORT_KEY = "capacity_report";

export const IsoDateTime = z.iso.datetime({ offset: true });

/** Doc 12 §3 schedule_settings.config — the calendar pass inputs (05 §2.6). */
export const ScheduleConfig = z.object({
  startAt: IsoDateTime.nullish(),
  /** Last day the timetable runs — drives the week view's day span. */
  endAt: IsoDateTime.nullish(),
  matchMinutes: z.number().int().min(1).max(24 * 60).default(30),
  gapMinutes: z.number().int().min(0).max(24 * 60).default(0),
  /** V374 cutover: real court ids only, no tolerant string union — the
   *  migration IS the compatibility strategy (design doc "Stored-config
   *  migration"). The original design named `.min(1)`, dropped here: a
   *  division that has never configured courts parses `courts` as
   *  `undefined`, and zod's `.default()` substitutes WITHOUT re-running the
   *  array's own checks (verified against the installed zod@4.4.3 — an
   *  explicit `[]` DOES fail `.min(1)`, but a defaulted `[]` does not), so
   *  `.min(1)` cannot be paired with an empty-array default, and no static
   *  default can name a real per-org court id. An empty array is therefore a
   *  legitimate, parseable "no courts configured yet" state; the capacity
   *  guard already needs to treat zero usable courts as a first-class case
   *  (`capacity.no_matching_court`, design doc "Scheduler integration") —
   *  pass 3's job, not this one's. */
  courts: z.array(CourtId).max(50).default([]),
  perEntrantMinRest: z.number().int().min(0).max(24 * 60).default(0),
  /** P9 pass 4c: real court id, like `courts` above — was
   *  `z.string().max(100)` (a court NAME). `courts` moved to real ids in
   *  pass 1 while this field stayed free text, so a court-scoped blackout
   *  could no longer match the court it named (silently went global or
   *  inert depending on the reader). V374 rewrites every stored
   *  `blackouts[].court` name -> id on migration, reusing the same
   *  court_mapping `courts` itself is rewritten through. Review wave 1,
   *  finding 2: an entry that cannot be mapped is DROPPED entirely, never
   *  left in place (this field is required-shaped — `.optional()` only
   *  drops the KEY, a present-but-unmappable string still fails `CourtId`)
   *  and never widened into a venue-wide blackout by dropping just the
   *  `court` key — that would block every court during the window instead
   *  of the one the organiser could no longer be identified. Counted in the
   *  migration's dry-run report either way, so an operator can see it. */
  blackouts: z
    .array(z.object({ court: CourtId.optional(), from: IsoDateTime, to: IsoDateTime }))
    .max(200)
    .default([]),
  sessionWindows: z
    .array(z.object({ from: IsoDateTime, to: IsoDateTime }))
    .max(200)
    .default([]),
  /** Quick-start rolling times (doc 12 §1.A): round r starts at startAt + (r−1)·roundMinutes. */
  roundMinutes: z.number().int().min(1).max(24 * 60).nullish(),
  /** Constraints v2 (Jul3/04 §3; Pro `scheduling.constraints`). API times are
   *  ISO; the engine consumes epoch ms. */
  constraints: z
    .object({
      restMin: z.number().int().min(0).max(24 * 60).optional(),
      restByGroup: z.record(z.string(), z.number().int().min(0).max(24 * 60)).optional(),
      noBackToBack: z.boolean().default(false),
      startWindows: z
        .array(
          z.object({
            target: z.object({ kind: z.enum(["entrant", "pool", "division"]), id: z.string() }),
            notBefore: IsoDateTime.optional(),
            notAfter: IsoDateTime.optional(),
          }),
        )
        .max(200)
        .default([]),
      fieldFairness: z.enum(["off", "balance", "rotate"]).default("off"),
      parallelism: z.enum(["block", "mixed"]).default("mixed"),
      crossPersonClash: z.enum(["warn", "hard"]).default("warn"),
      /** Durable division rules (#398) in the SAME vocabulary a compiled
       *  instruction produces — per-day caps, weekday and date targets,
       *  earliest/latest starts, minimum rest. They merge with the compiled
       *  instruction into one stream at `verifyConfig`, so a hard rule has
       *  exactly one home and one enforcement.
       *
       *  Optional, never defaulted: this type is built as an object literal at
       *  dozens of call sites, and a defaulted field is required in the zod
       *  OUTPUT type. Read it as `constraints?.hard ?? []`. */
      hard: z.array(HardConstraint).max(200).optional(),
    })
    .optional(),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfig>;

/** A blackout or a session window, not a whole schedule — worth its own wording
 *  so a 422 points the organiser at the row they inverted rather than at the
 *  competition dates, which is what `ENDS_BEFORE_STARTS` reads as. */
export const WINDOW_ENDS_BEFORE_STARTS = "A window's end cannot be before its start.";

/** Every ordered instant pair a schedule config carries, checked on the way IN.
 *
 *  Deliberately on this wrapper and NOT on `ScheduleConfig` itself. That schema
 *  is the READ path too — `usecases/schedule/` runs `ScheduleConfig.parse` over the
 *  stored `schedule_settings.config` jsonb and `.parse` throws, and
 *  `usecases/competition-schedule-ai/` `safeParse`s the same rows. A refine there
 *  would take every division that ALREADY holds a reversed range and turn its
 *  schedule page into a 500, punishing organisers for a value the product let
 *  them save. Refusing new bad writes fixes the source without breaking the
 *  divisions the gap already produced; the stored rows stay readable and become
 *  correctable through this very endpoint.
 *
 *  `startAt` is an instant and `endAt` is the venue-local END of its day (the
 *  panel stores 23:59 in the org zone), so a same-day range is `startAt < endAt`
 *  and equality is not expected — but it is permitted rather than rejected,
 *  because a zero-length window is merely empty, not incoherent, and the
 *  organiser gets a clearer signal from an unschedulable board than from a
 *  validation error they cannot act on. Only strict inversion is refused. */
function checkInstantOrder(
  v: { config?: { startAt?: string | null; endAt?: string | null; blackouts?: { from: string; to: string }[]; sessionWindows?: { from: string; to: string }[] } },
  ctx: z.RefinementCtx,
): void {
  const c = v.config;
  if (c === undefined) return;
  // EPOCH comparison, never string order. `IsoDateTime` is
  // `z.iso.datetime({ offset: true })`, which accepts ANY offset, not just `Z`
  // — and lexicographic order is chronological only within a single offset.
  // `2026-03-01T01:00:00-05:00` (06:00 UTC) is genuinely later than
  // `2026-03-01T02:00:00+02:00` (00:00 UTC), yet sorts BEFORE it as a string,
  // so a reversed range from a mixed-offset client would sail straight through
  // and reproduce the exact empty-board-no-error bug this check exists to stop.
  // The console only ever emits `Z` (`isoFromZonedParts`), but this endpoint is
  // a documented platform API and does not get to assume its own console is the
  // only caller. The sibling `checkDateOrder` above IS safe on string order —
  // it compares date-only `YYYY-MM-DD`, which carries no offset at all; do not
  // read it as precedent for instants.
  const at = (s: string): number => Date.parse(s);
  const reversed = (from: string, to: string): boolean => {
    const [a, b] = [at(from), at(to)];
    // An unparseable value is not this check's to report — the field schema
    // already rejected it, and guessing here would add a second, confusing
    // issue on the same path.
    return Number.isFinite(a) && Number.isFinite(b) && b < a;
  };
  if (typeof c.startAt === "string" && typeof c.endAt === "string" && reversed(c.startAt, c.endAt)) {
    ctx.addIssue({ code: "custom", path: ["config", "endAt"], message: ENDS_BEFORE_STARTS });
  }
  for (const [key, rows] of [
    ["blackouts", c.blackouts],
    ["sessionWindows", c.sessionWindows],
  ] as const) {
    (rows ?? []).forEach((row, i) => {
      if (reversed(row.from, row.to)) {
        ctx.addIssue({ code: "custom", path: ["config", key, i, "to"], message: WINDOW_ENDS_BEFORE_STARTS });
      }
    });
  }
}

export const PutScheduleSettings = z.object({
  config: ScheduleConfig,
  /**
   * Venue-local timezone (doc 12 §6 — DST boundaries in sessionWindows).
   *
   * Since V305 the venue zone is set on the ORGANISATION and inherited; there
   * is no division-level timezone control in the console any more. The column
   * and this field survive for the divisions that already hold a value (and
   * for platform-API clients), so this is tri-state:
   *   omitted  → leave the division's stored value untouched (what the
   *              console now always does — a save must never move a
   *              division's venue zone)
   *   null     → clear it, inherit from the org
   *   string   → pin this division to an explicit zone
   *
   * A string is additionally checked against the runtime's Intl: the length
   * bounds alone let any 1-64 character value reach the column, and the two
   * public loaders resolve it in SQL as `coalesce(ss.tz, o.timezone, 'UTC')`,
   * which rescues NULL only — so a junk zone stored here flows straight out
   * to a spectator surface instead of degrading to the org's zone.
   */
  tz: z.string().min(1).max(64).refine(isValidIana, { message: "Unknown timezone" }).nullish(),
}).superRefine(checkInstantOrder);
export type PutScheduleSettings = z.infer<typeof PutScheduleSettings>;

export const ScheduleSettings = z.object({
  division_id: Uuid,
  config: ScheduleConfig,
  /** RESOLVED venue zone (V305): stored division tz → org timezone → 'UTC'. */
  tz: z.string(),
  updated_at: z.string(),
});

/** The rule vocabulary the scheduling prompts teach (#399). `CAP` is the
 *  capacity case: demand exceeded capacity and no single rule was broken. */
export const RuleCode = z.enum(["H2", "H3", "H4", "H5", "H6", "H8", "CAP"]);
export type RuleCode = z.infer<typeof RuleCode>;

// Structured conflict detail (C3, 2026-08-13 design amendment,
// `docs/superpowers/specs/2026-08-12-conflict-detail-names-design.md`). One
// member per family template the engine's `ConflictDetailKind` union
// enumerates.
//
// The witness below is the SAME idiom the engine's own
// `conflict-detail.ts` uses for its field-order witness: a
// `Record<ConflictDetailKind, true>` object literal requires every key of
// the engine's union and rejects any key not in it, so a kind added to (or
// renamed in) the engine's 32 and forgotten here is a TYPE ERROR at this
// file, not a wire enum that silently stops matching what the engine emits.
const CONFLICT_DETAIL_KIND_WITNESS: Record<ConflictDetailKind, true> = {
  person_double_booking: true,
  locked_slot_clash: true,
  no_slot_start_window: true,
  no_slot_person_bound: true,
  no_slot_horizon: true,
  instruction_feeder_gap: true,
  instruction_day_cap: true,
  instruction_weekday: true,
  instruction_date: true,
  instruction_time: true,
  outside_competition_window: true,
  outside_start_window: true,
  court_double_booking: true,
  court_tag_mismatch: true,
  outside_court_hours: true,
  inside_blackout: true,
  outside_session_windows: true,
  entrant_overlap: true,
  entrant_below_rest: true,
  person_overlap: true,
  person_below_rest: true,
  order_before_feeder: true,
  order_inside_feeder_rest: true,
  round_order_day: true,
  round_order_same_day: true,
  // W3 app-B T1 (X-SW-31): the engine's 29th-32nd kinds.
  round_order_end: true,
  no_slot_round_barrier: true,
  rounds_per_day: true,
  no_slot_rounds_per_day: true,
  no_slot_lattice: true,
  no_slot_budget: true,
  stranded_fixture: true,
};
const CONFLICT_DETAIL_KINDS = Object.keys(CONFLICT_DETAIL_KIND_WITNESS) as [
  ConflictDetailKind,
  ...ConflictDetailKind[],
];
/** Shared between the snake_case wire shape below and the camelCase
 *  `AiPlanConflict` one near it — the kind STRING never changes casing,
 *  only the sibling field names do. */
export const ConflictDetailKindSchema = z.enum(CONFLICT_DETAIL_KINDS);

/** Snake_case wire mirror of the engine's `ConflictDetail` (house style for
 *  this schema — see `fixture_id`/`shortfall_minutes` on `ScheduleConflict`
 *  below). Every field beyond `kind` is optional because each family
 *  template only populates the subset it needs (design doc's per-kind
 *  table); id fields are `Uuid` to match `fixture_id` on the conflict
 *  itself. */
const ScheduleConflictDetail = z.object({
  kind: ConflictDetailKindSchema,
  entrant_ids: z.array(Uuid).optional(),
  person_ids: z.array(Uuid).optional(),
  other_fixture_id: Uuid.optional(),
  court: z.string().optional(),
  /** P9 pass 3a: `court` is now a real `courts.id`; this is the DERIVED,
   *  read-only display name resolved by the usecase before this leaves the
   *  server — mirrors the engine's own `ConflictDetail.courtName` (see its
   *  doc comment). Absent exactly when `court` is, or on the rare miss a
   *  resolver could not name. */
  court_name: z.string().optional(),
  day: z.string().optional(),
  other_day: z.string().optional(),
  weekday: z.string().optional(),
  required_weekday: z.string().optional(),
  required_date: z.string().optional(),
  time: z.string().optional(),
  required_time: z.string().optional(),
  rule_type: z.string().optional(),
  round_no: z.number().int().optional(),
  other_round_no: z.number().int().optional(),
  minutes: z.number().int().optional(),
  required_minutes: z.number().int().optional(),
  count: z.number().int().optional(),
  required_count: z.number().int().optional(),
});

/** Doc 12 §2 conflict taxonomy. Since #399 `blocking` is DELTA-based: a court
 *  clash, a person double-booking, an out-of-window slot or a direct feed
 *  ordering breach blocks when THIS change introduced or worsened it. The same
 *  conflict already on the board comes back as a badge, so a dirty board stays
 *  editable. Blocked writes are rejected; warnings persist as badges. */
export const ScheduleConflict = z.object({
  fixture_id: Uuid,
  code: z.enum([
    "conflict.court",
    "conflict.start_window",
    "warn.rest",
    "warn.person_overlap",
    "warn.order",
    "warn.blackout",
    // #397: outside the competition's resolved calendar window. A warning this
    // wave — W4 (#399) makes it blocking, and delta-based so a board that was
    // already outside its window stays editable.
    "warn.window",
    // #398: breaks a rule compiled from the organiser's own instruction ("two
    // matches per day", "final on Friday"), or a durable division rule in the
    // same vocabulary. A warning this wave — W4 (#399) gives it rule code H8
    // and decides what blocks.
    "warn.instruction",
    "warn.no_slot",
    "warn.official_declined",
    "warn.official_unavailable",
  ]),
  blocking: z.boolean(),
  /** @deprecated Pre-C3 English, derived server-side (byte-for-byte) from
   *  `details` by the deprecated `legacyConflictDetail` — kept only for
   *  clients that read prose off the wire. New clients should read
   *  `details` and localize at render time (C3, 2026-08-13 design
   *  amendment). */
  detail: z.string().optional(),
  /** Structured, id-only conflict detail (C3, 2026-08-13 design amendment).
   *  Additive: absent only for a `Conflict` the engine built without a
   *  `details` entry (there should be none — every one of the 25 family
   *  templates sets it — but the field stays optional to match the
   *  engine's own `Conflict.details?`). */
  details: ScheduleConflictDetail.optional(),
  /** The rule this conflict breaks, in the vocabulary the AI prompts teach
   *  (#399) — so a refusal, a badge and a repair round all cite one token. */
  rule: RuleCode.optional(),
  /** How far a MEASURED breach falls short, in minutes (#399). Carried beside
   *  the conflict rather than inside `detail`, because `detail` is part of the
   *  conflict's identity and a number in there would move that identity every
   *  time the card moved. */
  shortfall_minutes: z.number().int().optional(),
  /** How many rounds a calendar day holds, for a `rounds_per_day` breach (X-SW-31, ruling 256). Carried beside the
   *  conflict for the same reason as `shortfall_minutes`: it is MEASURED, and a number inside `details` would move the
   *  conflict's identity every time a board moved a round across a day. The cap it exceeds is
   *  `details.required_count`. */
  measured_count: z.number().int().optional(),
});
export type ScheduleConflict = z.infer<typeof ScheduleConflict>;

/** The PATCH /fixtures/{id} response (#461).
 *
 *  The fixture as `Fixture` describes it, PLUS the conflicts the move was judged
 *  against. `moveFixture` has always computed a full report for the destination
 *  slot; it used it for the blocking gate and then discarded it, because the
 *  function returned `void`. Blocking conflicts 409 and are visible that way, so
 *  the ones this field exists for are the WARN-level ones — a rest shortfall, a
 *  stored typed rule, a slot outside the competition's days — which an API
 *  client dragging a card previously heard nothing about.
 *
 *  Always present, `[]` when the patch touched no timetable field, so a client
 *  need not distinguish "no conflicts" from "not evaluated" by key absence.
 *  Additive: no existing consumer of this endpoint reads it. */
export const PatchedFixture = Fixture.extend({
  conflicts: z.array(ScheduleConflict),
});
export type PatchedFixture = z.infer<typeof PatchedFixture>;

export const ScheduleAssignment = z.object({
  fixture_id: Uuid,
  scheduled_at: z.string(),
  ends_at: z.string(),
  court_id: CourtId,
  /** DERIVED, read-only (P9 pass 3a) — resolved from `court_id` by the
   *  usecase. Nullable rather than omitted on a miss: `court_id` itself is
   *  always present on a real assignment, so a client can always render
   *  SOMETHING (fall back to the id) without a key-absence check. */
  court_name: z.string().nullable(),
});
export type ScheduleAssignment = z.infer<typeof ScheduleAssignment>;

/** POST /stages/{id}/schedule/auto — propose only, nothing persisted (doc 12 §4).
 *
 *  `mode` has a default DERIVED from another field, which `.default()` cannot
 *  express. The obvious `.object({...}).transform(...)` is a trap here:
 *  openapi.ts converts every registered schema with `z.toJSONSchema(…, { io:
 *  "output" })`, and a trailing transform is the OUTPUT node, so the whole
 *  generator dies with "Transforms cannot be represented in JSON Schema" —
 *  the same hazard AiApplyMeta's comment above warns about.
 *
 *  `z.preprocess` pipes the other way: the transform is the INPUT node and the
 *  plain object is the output, so `io: "output"` converts cleanly and `mode`
 *  is a required, non-optional string on the inferred type (which the usecase
 *  branches on without a null check).
 *
 *  Consequence to know: `mode` is listed in the spec's `required` even though
 *  callers need not send it — exactly how the pre-existing defaulted
 *  `only_unlocked` has always rendered. Every existing caller keeps its
 *  behaviour: re-flowing is a REFLOW, a fresh pass is a BUILD. */
export const AutoScheduleRequest = z.preprocess(
  (value) => {
    // Let the object schema own the error for non-objects.
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const body = value as Record<string, unknown>;
    if (body.mode !== undefined) return body;
    // `=== false` and not `!body.only_unlocked`: an absent flag defaults to
    // true, so it must derive "reflow", not "build".
    return { ...body, mode: body.only_unlocked === false ? "build" : "reflow" };
  },
  z.object({
    /** true (default) = re-flow unlocked fixtures only, locked ones are fixed
     *  obstacles ("re-flow remaining", doc 12 §2); false = fresh full pass.
     *
     *  Steers `mode` derivation ONLY (above). It used to also gate whether a
     *  `schedule_locked` fixture was honoured, which was a bug
     *  (#pins-in-build): the primary Auto-schedule button always posts
     *  `false` here (to derive `mode: "build"`), so that gate silently
     *  dropped every lock on the one mode organisers reach for by default. A
     *  lock is honoured on every mode now, unconditionally; `ignore_locks`
     *  below is the only way to turn that off. */
    only_unlocked: z.boolean().default(true),
    /** Which solver this run is asking for. Absent is derived from
     *  `only_unlocked` by the preprocess above. */
    mode: z.enum(["build", "reflow", "polish"]),
    /** The explicit escape hatch (owner ruling, 2026-08-12): the ONLY thing
     *  that can make this run move a `schedule_locked` (or scope-locked)
     *  fixture. Every mode honours a lock by default — a lock must be
     *  ignored on purpose; there is no silent path to it. Meant for a
     *  caller who has just been told BUILD is infeasible because of its own
     *  pins and wants one explicit re-run that treats the whole board as
     *  movable.
     *
     *  `.optional()`, not `.default(false)`: `z.infer` of a `.default()`'d
     *  field is non-optional (the default only shapes what `.parse()`
     *  accepts as INPUT, via `z.input<>`), and `autoSchedule(auth, stageId,
     *  body: AutoScheduleRequest)` is called directly — bypassing this
     *  schema entirely — by dozens of usecase tests with a hand-built object
     *  literal that predates this field. A `.default()` here would make
     *  every one of them fail typechecking for a field they have no reason
     *  to know about. `.optional()` keeps those literals valid; the usecase
     *  applies the same `false` fallback where it reads the field instead
     *  (`body.ignore_locks ?? false`). */
    ignore_locks: z.boolean().optional(),
  }),
);
export type AutoScheduleRequest = z.infer<typeof AutoScheduleRequest>;

/** Board quality of a proposal. snake_case on the wire; the engine's camelCase
 *  equivalents are mapped across at the usecase seam, once. */
export const ScheduleMetrics = z.object({
  makespan_minutes: z.number(),
  worst_idle_gap_minutes: z.number(),
  court_imbalance_minutes: z.number(),
  placed: z.number().int(),
  total: z.number().int(),
});
export type ScheduleMetrics = z.infer<typeof ScheduleMetrics>;

/** How the proposal was produced — telemetry, not policy. `status` tracks the
 *  engine's BuildStatus union one-for-one. */
export const ScheduleSolverInfo = z.object({
  /** Mirrors the engine's `BuildResult["engine"]` exactly: `usecases/schedule/`
   *  assigns that field into this one one-for-one, so a member missing here is
   *  a board the API has no shape for — and that is not hypothetical, TS
   *  already refuses `engine: out.engine` when the two drift.
   *
   *  Two members since C7, which retired the z3-era `"z3"` and `"z3+lns"`.
   *  Nothing had produced either since C4 and C9 moved the last callers onto
   *  the placement service. */
  engine: z.enum(["greedy", "optimized"]),
  /** Which solver the request asked for, echoed back.
   *
   *  NOT redundant with `engine`, which names what actually produced the board:
   *  a REFLOW that timed out and a BUILD that expired before finishing its first
   *  tier both come back `engine: "greedy"`, `budget_expired: true`,
   *  `tiers_completed: 0`, `tiers_total` the ladder's size (`TIER_COUNT`) — byte
   *  for byte the same payload, describing two different events.
   *
   *  It matters because only the BUILD path has a tier ladder. `reflowExisting`
   *  keeps `tiersCompleted` at 0 deliberately (reporting a number from a ladder
   *  it never walked would make an optimality claim nothing proved) while
   *  `tiers_total` stays the build ladder's size, so a reader with only those two
   *  numbers renders "0 of N targets improved" about a run that was never on that
   *  scale. This is the field that lets it say something true instead.
   *
   *  Optional and additive: absent, a reader keeps the tier sentence, which is
   *  what it rendered before the field existed. */
  mode: z.enum(["build", "reflow", "polish"]).optional(),
  status: z.enum([
    "ok",
    "already_optimal",
    "infeasible",
    "verifier_rejected",
    "solver_busy",
    /**
     * The solver could not represent this board on its lattice, so it never
     * searched it.
     *
     * NOT a failure, and not a quality claim — the deliberate ABSENCE of one.
     * The greedy board it arrives with is valid. What it refuses to say is
     * whether a better one exists, and that refusal is the whole reason the
     * member exists: the behaviour it replaces reported `already_optimal` —
     * which is a PROOF — about a board no tier had ever been in a position to
     * ask a question about.
     *
     * Listed here rather than left off because `usecases/schedule/` assigns the
     * engine's `BuildStatus` into this object one-for-one, so a member missing
     * from this enum is a board the API has no shape for.
     */
    "not_searched",
    /**
     * The service call resolved but not into a trustworthy board — a transport
     * fault, an unmapped/unreadable status, or the RPC rejecting outright.
     *
     * Listed here rather than left off for the same reason `not_searched`
     * above is: `usecases/schedule/` assigns `BuildStatus` into this object
     * one-for-one. It shared `board.result.unavailable` with a z3-era
     * `z3_unavailable` that meant the same thing to an organiser; C7 retired
     * that older name, so this is now the only identifier for it. The copy is
     * unchanged — it was always the same string.
     *
     * Deliberately NOT what a `SOLVER_BUSY` refusal maps to — that stays
     * the existing `"solver_busy"` a few lines up, because a retry helps
     * there and this copy does not promise one will.
     */
    "solver_unavailable",
  ]),
  /**
   * WHICH of `not_searched`'s five exits produced this board — `status` alone
   * cannot say, because all five collapse onto that one member (see the engine's
   * `NotSearchedReason` doc comment, `build.ts`). Present only when
   * `status === "not_searched"`; absent on every other status, and absent from
   * a server one deploy behind this field — a reader untaught about it degrades
   * to the shared `board.result.notSearched` sentence, which is still true, just
   * less specific.
   *
   * A sixth member, `per_court_grid`, lived here until task C2 closed the gap
   * that produced it (`placement.model.build_model` now enforces each court's
   * own tick set directly, so a per-court blackout reaches the solver instead
   * of being refused) — removed, not merely undocumented, matching the
   * engine's own union.
   *
   * HAND-MIRRORED, not generated: this file has no codegen link to
   * `packages/engine`, so a member added to the engine union without a match
   * here is a value `usecases/schedule/` folder's `out.notSearchedReason` assignment cannot
   * type as this field — TS catches it at the usecase seam, the same trap
   * `status` above and `ScheduleSolverInfo`'s own doc comment already warn
   * about.
   */
  not_searched_reason: z
    .enum(["too_big", "window_empty", "lattice_unusable", "out_of_time", "no_verdict"])
    .optional(),
  tiers_completed: z.number().int(),
  /** How many improvement targets the ladder HAS — the denominator
   *  `tiers_completed` is a numerator of.
   *
   *  Sent rather than left to the client because a bare `tiers_completed` has
   *  no meaning without it: the result strip had to carry its own
   *  `IMPROVEMENT_TARGETS = 4`, which is a constant in a different package from
   *  the ladder it describes and drifts the day a tier is added or removed with
   *  nothing to notice. A denominator on the wire moves that fact to the one
   *  place that knows it.
   *
   *  Optimality is `tiers_completed === tiers_total`, NOT `!budget_expired`: a
   *  term or metric drift exits a tier without ever setting the flag. */
  tiers_total: z.number().int(),
  budget_expired: z.boolean(),
  elapsed_ms: z.number(),
  moved: z.number().int(),
  /** How many of `moved` were cards this run placed for the FIRST time.
   *
   *  `moved` counts every card the run put somewhere, and for a REFLOW over an
   *  unscheduled stage that is the entire board — cards that were never anywhere
   *  to be moved FROM. Without this the best copy available is "N matches
   *  moved", which is wrong about every one of them.
   *
   *  CARRIED, not inferred. A reader cannot recover it from `moved` and
   *  `placed`: `moved === placed` happens on plenty of ordinary boards that
   *  seeded nothing at all, so a component deriving it that way would relabel a
   *  genuine re-flow as a first-time scheduling run.
   *
   *  Present only on the REFLOW path, which is the only one that distinguishes a
   *  seed from a move. BUILD and POLISH re-place everything by definition, so
   *  the distinction does not arise and the field is absent. */
  seeded: z.number().int().optional(),
  /** How many cards that HELD a slot on the organiser's board no longer have
   *  one after this run (R21).
   *
   *  Its own field rather than folded into `moved`, because the two are
   *  different events and only one of them is a rearrangement. Folded, a single
   *  substitution — one card in, one card out — read as 2 moves on a board that
   *  had only moved one thing, and `moved` could exceed the size of the board it
   *  described. A strip printing "moved N" cannot honestly print an N larger
   *  than the board.
   *
   *  Not derivable from `total - placed`, which counts every card with no slot
   *  including ones that never had one. On a stage of 22 with 18 placed, four
   *  cards are unplaced and only the ones the organiser had already scheduled
   *  are a time somebody may have to be un-told about.
   *
   *  0 rather than absent whenever there is no baseline to lose from: the engine
   *  measures it against `BuildInput.current`, and a BUILD that supplies none
   *  reports 0 by definition. Optional on the wire only so a server one deploy
   *  behind parses. */
  lost: z.number().int().optional(),
  /** The PINNED fixtures an `infeasible` verdict is about, sorted.
   *
   *  `infeasible` has two sources and they say opposite things to an organiser.
   *  The board source means not one card can be placed legally. The PIN source
   *  means the rest of the board is fine and two locked placements cannot both
   *  be kept. Present only for the second, and its ABSENCE on an `infeasible`
   *  result is itself the signal that the proof is about the board.
   *
   *  Optional and additive: a reader that has not been taught about it degrades
   *  to `total - placed`, which is the same number in the measured case and
   *  wrong whenever an unplaced card is not a pinned one. Never synthesised
   *  here — it is forwarded only when the engine supplied it. */
  contradictory_pins: z.array(z.string()).optional(),
  /** How many of THIS stage's own fixtures were held fixed because they were
   *  locked (`schedule_locked`, or caught by a division scope lock) — the set
   *  `autoSchedule` anchored into the solve rather than left movable. A
   *  companion signal to `contradictory_pins`: that field fires only when two
   *  locked placements directly contradict each other, but a lock can also
   *  make a board `infeasible` by leaving no room for the rest — `locked_kept
   *  > 0` alongside `status: "infeasible"` is enough for a client to suggest
   *  the `ignore_locks` escape hatch even when `contradictory_pins` is absent.
   *
   *  0 whenever nothing in this stage is locked, or the caller asked to
   *  `ignore_locks` — this server always sends a real number, never `undefined`.
   *
   *  Optional on the wire only, matching `lost`/`seeded`/`contradictory_pins`
   *  right above: a reader on an older client build, or a cached/replayed
   *  response from a server one deploy behind, must still parse.
   *
   *  Counts PLACEMENTS, not the division's lock flag: a locked fixture with
   *  no `scheduled_at`/`court_id` yet has nothing to anchor to and is not
   *  counted (the same rule the anchor itself uses — see `lockedFixtureIds`
   *  in `usecases/schedule/board.ts`). */
  locked_kept: z.number().int().optional(),
});
export type ScheduleSolverInfo = z.infer<typeof ScheduleSolverInfo>;
