// /api/v1 contracts — scheduling constraints v2 and AI: ScheduleShift, plan/repair, officials plan, joint multi-division (#350), parse preview (W5), OverrideStandings.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
import { HardConstraint } from "@seazn/engine/scheduling";
import { Uuid, CourtId, VenueId } from "./common.ts";
import { IsoDateTime, ConflictDetailKindSchema, RuleCode } from "./scheduling.ts";
import { AiApplyMeta } from "./schedule-analysis.ts";
import { AssignPolicyBody } from "./officiating.ts";

// Scheduling constraints v2 & AI (Jul3/04, PROMPT-24) -------------------------

export const ScheduleShift = z.object({
  division_id: Uuid,
  scope: z
    .object({
      stageId: z.string().optional(),
      poolIds: z.array(z.string()).optional(),
      courts: z.array(z.string()).optional(),
      excludeLocked: z.boolean().default(true),
    })
    .default({ excludeLocked: true }),
  delta_minutes: z.number().int().min(-1440).max(1440),
});

// Token-weighted AI credit rung (lib/ai-rung.ts, issue #348).
const RungLiteral = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/**
 * What an AI run cost and what that bought, spread into every AI response so
 * the confirm card reads one shape whatever endpoint answered it. Mirrors
 * `RunMeterStamp` in lib/ai-rung.ts — the single builder both phases (and #350's
 * joint solve) stamp their ledger event and response with.
 *
 * Optional so fixtures and clients written before this field set still satisfy
 * the type; every real response sends `credits`, `budget`, `spent_tokens`,
 * `underfunded`, `stopped_on_budget` and `est_tokens`. `rung`/`predicted_rung`
 * are the single-division flat form; `divisions`/`discount` the joint form.
 */
const AiRunPriceFields = {
  /** Credits actually charged (after any joint batch discount). */
  credits: z.number().int().optional(),
  /** Hard generation-token budget those credits bought. */
  budget: z.number().int().optional(),
  /** Generation tokens the run actually spent. */
  spent_tokens: z.number().int().optional(),
  /** Advisory pre-run estimate the confirm card showed. */
  est_tokens: z.number().int().optional(),
  /** A rung below the prediction was chosen. */
  underfunded: z.boolean().optional(),
  /** The run ended because the budget ran out, not because it was done. */
  stopped_on_budget: z.boolean().optional(),
  /** Single-division form. */
  rung: RungLiteral.optional(),
  predicted_rung: RungLiteral.optional(),
  /**
   * Set ONLY when the client's confirm card quoted a different number than the
   * server charged (#387).
   *
   * The card computes its quote by calling the same pure function the server
   * calls — deliberately, so there is one arithmetic implementation and no
   * per-keystroke fetch. That rests on one premise: same function, same inputs,
   * same environment. PR #359 found three ways it breaks and #385 closed the
   * largest; this field makes any residual divergence VISIBLE instead of
   * silent.
   *
   * Both directions are reported. An over-quote is a bad surprise on screen; an
   * under-quote is a billing complaint. Absent means they agreed — or that the
   * caller sent no quote at all, which is not the same as quoting zero.
   */
  quote_mismatch: z.object({ quoted: z.number().int(), charged: z.number().int() }).optional(),
  /** Joint (multi-division) form — issue #350. */
  discount: z.number().int().optional(),
  divisions: z
    .array(
      z.object({
        id: z.string(),
        rung: RungLiteral,
        predicted_rung: RungLiteral,
        underfunded: z.boolean(),
      }),
    )
    .optional(),
};

// v4 AI Schedule Architect (design/v4/00-03) — Phase A propose-only endpoint.
// The model proposes times+courts; the engine verifier is authoritative. This
// contract carries the request instruction, an optional repair scope, an
// optional prior proposal (refine), and an optional officials policy for a dry
// coverage preview (no LLM). `officials_policy` reuses the officials-auto body.
export const AiPlanRequest = z.object({
  instruction: z.string().min(3).max(4000),
  mode: z.enum(["generate", "refine", "repair"]).default("generate"),
  scope: z
    .object({
      from: IsoDateTime.optional(),
      // P9 pass 3b: real `courts.id` values — `buildSchedulePack`'s own
      // `inScope()` matches this against a fixture's `court_id`, and its
      // scope-validation check compares it against `ScheduleConfig.courts`
      // (`CourtId[]` since pass 1), so a bare `z.string()` here let a
      // free-text label through the parse only to silently never match
      // anything downstream.
      courts: z.array(CourtId).optional(),
      pool_ids: z.array(Uuid).optional(),
    })
    .optional(),
  prior: z
    .object({
      instruction: z.string(),
      assignments: z.array(
        z.object({ fixture_id: Uuid, scheduled_at: z.string(), court_label: z.string() }),
      ),
    })
    .optional(),
  officials_policy: AssignPolicyBody.optional(),
  // Token-weighted AI credit rung (lib/ai-rung.ts): defaults to the server
  // prediction when omitted. A caller may pick below the prediction — the run
  // still executes, capped to the chosen rung's token budget, and the ledger
  // stamps `underfunded: true`.
  rung: RungLiteral.optional(),
  /**
   * W5 (#400): the confirmed compile from `POST .../schedule/ai-preview`. When
   * present the run reuses that stored parse instead of compiling a second
   * time, so the rules the organiser approved are the rules the architect
   * executes under — and a `preview_id` whose stored instruction no longer
   * matches this request's is a 409 `preview_stale` rather than a silent
   * recompile.
   *
   * OPTIONAL, and it must stay that way: smoke, the e2e API paths and every
   * external consumer post a run without one, and compile inline exactly as
   * they always have.
   */
  preview_id: Uuid.optional(),
  /**
   * What the confirm card showed (#387). The server compares it against what it
   * actually charged, reports the divergence on `quote_mismatch` and records a
   * `schedule.ai_quote_mismatch` competition_event.
   *
   * OPTIONAL, and it must stay that way: server-side callers, smoke and every
   * external consumer send none. `.positive()` rather than `.nonnegative()`
   * because there is no such thing as a zero-credit quote — an absent value must
   * never be read as "quoted nothing", and a client that means "I showed no
   * price" says so by omitting the field.
   */
  quoted_credits: z.number().int().positive().optional(),
});
export type AiPlanRequest = z.infer<typeof AiPlanRequest>;

const AiPlanAssignment = z.object({
  fixture_id: Uuid,
  scheduled_at: z.string(),
  court_label: z.string(),
  schedule_locked: z.boolean().optional(),
});

/** CamelCase mirror of `ScheduleConflictDetail` above — same fields, same
 *  `ConflictDetailKindSchema`, matching the engine's own `ConflictDetail`
 *  casing 1:1 (this schema's whole point is to carry the engine's verbatim
 *  shape, per `AiPlanConflict`'s own comment below).
 *
 *  Id fields are plain `z.string()`, NOT `Uuid`, unlike `ScheduleConflictDetail`
 *  — deliberately looser, matching `AiPlanConflict.fixtureId` right below.
 *  The joint pack collapses two `persons` rows that share a display name onto
 *  a synthetic `name:<lowercased name>` key (usecases/competition-schedule-ai/) and
 *  that key can be exactly what rides in `personIds` here; a strict UUID
 *  format would reject a real, correctly-computed conflict. */
const AiPlanConflictDetail = z.object({
  kind: ConflictDetailKindSchema,
  /** Review wave 3: the DERIVED, venue-qualified court name beside the raw
   *  `court` id. Without it declared, zod strips whatever a caller attaches
   *  and `formatConflictDetail` degrades every court conflict to "Unknown
   *  court" — the field has to exist here as well as be resolved server-side. */
  courtName: z.string().optional(),
  entrantIds: z.array(z.string()).optional(),
  personIds: z.array(z.string()).optional(),
  otherFixtureId: z.string().optional(),
  court: z.string().optional(),
  day: z.string().optional(),
  otherDay: z.string().optional(),
  weekday: z.string().optional(),
  requiredWeekday: z.string().optional(),
  requiredDate: z.string().optional(),
  time: z.string().optional(),
  requiredTime: z.string().optional(),
  ruleType: z.string().optional(),
  roundNo: z.number().int().optional(),
  otherRoundNo: z.number().int().optional(),
  minutes: z.number().int().optional(),
  requiredMinutes: z.number().int().optional(),
  count: z.number().int().optional(),
  requiredCount: z.number().int().optional(),
});

// Engine verifier conflict (camelCase, @seazn/engine/scheduling Conflict).
export const AiPlanConflict = z.object({
  fixtureId: z.string(),
  reason: z.string(),
  /** @deprecated Pre-C3 English, derived server-side (byte-for-byte) from
   *  `details` by the deprecated `legacyConflictDetail` — kept only for
   *  clients that read prose off the wire (the C3 design doc's ruling: the
   *  MODEL's own copy of a conflict, on the repair-round conversation, is a
   *  separate JSON.stringify that never reaches this schema and stays
   *  byte-identical to pre-C3 on its own — see usecases/schedule-ai/ and
   *  usecases/competition-schedule-ai/). New clients should read `details` and
   *  localize at render time. */
  detail: z.string().optional(),
  /** Structured, id-only conflict detail (C3, 2026-08-13 design amendment).
   *  Declared here or zod strips it on any call site that actually
   *  `.parse()`s this shape, the same trap the `rule` comment above already
   *  names for this object. */
  details: AiPlanConflictDetail.optional(),
  direct: z.boolean().optional(),
  /** The rule the prompt taught for this reason (#399), so a repair round is
   *  handed the token it knows instead of a word we invented. Declared here or
   *  zod strips it and the model goes back to interpreting prose. */
  rule: RuleCode.optional(),
  /** How short a measured breach falls, in minutes — the number a repair round
   *  needs to know how far to move the card (#399). */
  shortfallMinutes: z.number().int().optional(),
  /** The rounds one day holds, for a `rounds_per_day` breach (X-SW-31, ruling 256) - `ScheduleConflict.measured_count`'s
   *  twin on the engine-verbatim shape. Declared here or zod strips it. */
  measuredCount: z.number().int().optional(),
});

// A durable constraints delta the architect inferred from the instruction —
// the ENGINE constraints family, but with startWindow bounds converted from
// epoch ms to ISO-with-offset in the division timezone (the shape clients + the
// schedule-settings PUT speak). Mirrors ScheduleConfig.constraints, all fields
// optional (it is a suggestion delta).
const AiConstraintSuggestions = z.object({
  restMin: z.number().int().min(0).max(24 * 60).optional(),
  restByGroup: z.record(z.string(), z.number().int().min(0).max(24 * 60)).optional(),
  noBackToBack: z.boolean().optional(),
  startWindows: z
    .array(
      z.object({
        target: z.object({ kind: z.enum(["entrant", "pool", "division"]), id: z.string() }),
        notBefore: IsoDateTime.optional(),
        notAfter: IsoDateTime.optional(),
      }),
    )
    .optional(),
  fieldFairness: z.enum(["off", "balance", "rotate"]).optional(),
  parallelism: z.enum(["block", "mixed"]).optional(),
  crossPersonClash: z.enum(["warn", "hard"]).optional(),
});

/**
 * W6 (#401): how a schedule reached its final state.
 *
 * `engine` is the headline and the rest is why. `"none"` means no repair changed
 * the board — it verified clean, or repair was attempted and nothing was
 * adopted. `"optimized"` means the placement CP-SAT service fixed it, for no
 * credits and no model call (z3 retirement design, stage B, shipped by C9 —
 * the repair round's own solver call is `buildSchedule` via
 * `repairDecomposedCpsat`). `"llm"` means the assistant was asked to repair it.
 *
 * A z3-era `"z3"` member sat here until C7 (stage D) removed it. It was never
 * persisted — this schema is response-only telemetry, verified across the DDL,
 * the live schema and every read path — so retiring it needed no data
 * migration.
 *
 * The rest of the object exists because #401 requires the FALLBACK to be
 * visible, not merely correct: a run where the solver timed out, was queued
 * behind another run, or came back with families it could not satisfy must say
 * which, or "we tried and gave up" is indistinguishable from "we never tried".
 *
 * Every field but `engine` and `solver_ran` is optional, because most of them
 * are facts only a completed solve produces. Kept OPEN (a plain object rather
 * than a closed union) so a new diagnostic is an additive change — the same
 * reason `usage` is shaped this way.
 */
export const AiRepairReport = z.object({
  engine: z.enum(["none", "optimized", "llm"]),
  /** Did the solver actually run? False on the clean path, and on both paths
   *  where the attempt was declined before it started. */
  solver_ran: z.boolean(),
  status: z.enum(["clean", "repaired", "partial", "unrepaired"]).optional(),
  /** `k` — the number of fixtures moved. */
  moved: z.number().int().nonnegative().optional(),
  /** Wall-clock the request paid, queue wait included. */
  ms: z.number().int().nonnegative().optional(),
  checks: z.number().int().nonnegative().optional(),
  /** `upper_bound` means `moved` is the fewest this decomposition found, not the
   *  fewest that exist. Never rendered as "minimal" unless this says `proved`. */
  minimality: z.enum(["proved", "upper_bound"]).optional(),
  components_solved: z.number().int().nonnegative().optional(),
  components_skipped: z.number().int().nonnegative().optional(),
  /** Fixtures the solver left for the assistant. */
  unresolved: z.number().int().nonnegative().optional(),
  /** Conflicts the board still carries, blocking or not. */
  residual: z.number().int().nonnegative().optional(),
  /** Constraint families a component dropped to find any answer at all. */
  relaxed: z.array(z.string()).optional(),
  /** Families that cannot hold together — "no schedule can satisfy all of
   *  these at once". */
  families: z.array(z.string()).optional(),
  timed_out: z.boolean().optional(),
  fallback: z
    .enum([
      "disabled",
      "queue_wait",
      "budget",
      "partial",
      "unrepaired",
      "error",
      "not_adopted",
      "court_split",
    ])
    .optional(),
});
export type AiRepairReport = z.infer<typeof AiRepairReport>;

export const AiPlanResponse = z.object({
  proposal: z.array(AiPlanAssignment),
  unschedulable: z.array(z.object({ fixture_id: Uuid, reason: z.string(), rule: RuleCode })),
  warnings: z.array(AiPlanConflict),
  blocking: z.array(AiPlanConflict),
  diff: z.object({
    moved: z.array(z.string()),
    placed: z.array(z.string()),
    unscheduled: z.array(z.string()),
    unchanged: z.array(z.string()),
  }),
  explanations: z.array(z.object({ fixture_id: Uuid, note: z.string() })),
  constraint_suggestions: AiConstraintSuggestions.optional(),
  summary: z.string(),
  /**
   * The ARCHITECT's own assumptions (stage 2, model-authored): what it assumed
   * while placing. NOT the resolver's — those are stage 1, deterministic, and
   * ride on `AiParsePreviewResponse.compiled.assumptions`, shown before a credit
   * is spent. Two different arrays in two different responses; merging them
   * would tell the organiser the machine assumed something it did not.
   *
   * `.default([])` rather than `.optional()`: the prompt schema makes the field
   * optional and the model omits it routinely, while the review panel maps over
   * it. `undefined` here is a client crash, not a cosmetic gap.
   */
  assumptions: z.array(z.string()).default([]),
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    repair_rounds: z.number().int(),
  }),
  /** W6 (#401): which engine repaired this board, and what the automatic one
   *  did or could not do. */
  repair: AiRepairReport,
  /** Dry officials coverage preview (present only when officials_policy sent). */
  officials_coverage: z
    .object({
      fillable: z.number().int(),
      total: z.number().int(),
      unfilled: z.array(z.object({ fixture_id: z.string(), role_key: z.string() })),
    })
    .nullable(),
  ...AiRunPriceFields,
});
export type AiPlanResponse = z.infer<typeof AiPlanResponse>;

// v4 AI Schedule Architect — Phase B (officials architect, design/v4/03 §2). The
// model assigns officials to a dry-run (or the current) schedule; the engine
// referee is authoritative and nothing is written. `instruction` may be empty —
// then the deterministic solver draft is returned with no LLM call. `policy`
// reuses the officials-auto body; `prior.assignments` mirror the response
// `assignments` (engine FixtureOfficial, camelCase) so a refine turn round-trips.
export const AiOfficialsPlanRequest = z.object({
  instruction: z.string().max(2000).default(""),
  schedule: z
    .array(z.object({ fixture_id: Uuid, scheduled_at: IsoDateTime, court_label: z.string() }))
    .optional(),
  policy: AssignPolicyBody,
  prior: z
    .object({
      instruction: z.string(),
      assignments: z.array(
        z.object({
          fixtureId: Uuid,
          officialId: Uuid,
          roleKey: z.string().min(1),
          locked: z.boolean().optional(),
        }),
      ),
    })
    .optional(),
  // Token-weighted AI credit rung (lib/ai-rung.ts): defaults to the server
  // prediction when omitted; see AiPlanRequest.rung for the full contract.
  // Ignored on the empty-instruction path, which makes no model call and is
  // always priced at 1 credit.
  rung: RungLiteral.optional(),
  /**
   * What the confirm card showed (#387). The server compares it against what it
   * actually charged, reports the divergence on `quote_mismatch` and records a
   * `schedule.ai_quote_mismatch` competition_event.
   *
   * OPTIONAL, and it must stay that way: server-side callers, smoke and every
   * external consumer send none. `.positive()` rather than `.nonnegative()`
   * because there is no such thing as a zero-credit quote — an absent value must
   * never be read as "quoted nothing", and a client that means "I showed no
   * price" says so by omitting the field.
   */
  quoted_credits: z.number().int().positive().optional(),
});
export type AiOfficialsPlanRequest = z.infer<typeof AiOfficialsPlanRequest>;

// Engine-taxonomy conflict (camelCase, @seazn/engine/officials OfficialConflict)
// plus the server-side "ineligible" verdict; `severity` flags the blocking ones.
const AiOfficialsConflict = z.object({
  kind: z.string(),
  severity: z.enum(["block", "warn"]),
  fixtureId: z.string().optional(),
  officialId: z.string().optional(),
  roleKey: z.string().optional(),
  detail: z.string().optional(),
});

export const AiOfficialsPlanResponse = z.object({
  // Proposed assignments (engine FixtureOfficial). Locked rows are echoed with
  // locked:true; the empty-instruction path returns the solver draft verbatim.
  assignments: z.array(
    z.object({
      fixtureId: z.string(),
      officialId: z.string(),
      roleKey: z.string(),
      locked: z.boolean().optional(),
    }),
  ),
  conflicts: z.array(AiOfficialsConflict),
  diff: z.object({
    // Fixture ids whose assignment set differs from / matches the baseline
    // (the prior proposal when given, else the locked assignments).
    changed: z.array(z.string()),
    unchanged: z.array(z.string()),
    // Slots the plan could not fill, each with the model's short reason.
    unfilled: z.array(z.object({ fixture_id: z.string(), role_key: z.string(), reason: z.string() })),
  }),
  // Declared-unfilled slots the referee's solver CAN fill, with a candidate — a
  // suggestion the organiser may accept (design/v4/03 §7 decision 8).
  lazy_unfilled: z.array(
    z.object({ fixture_id: z.string(), role_key: z.string(), candidate_official_id: z.string() }),
  ),
  explanations: z.array(z.object({ fixture_id: z.string(), note: z.string() })),
  summary: z.string(),
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    repair_rounds: z.number().int(),
  }),
  ...AiRunPriceFields,
});
export type AiOfficialsPlanResponse = z.infer<typeof AiOfficialsPlanResponse>;

// ---------------------------------------------------------------------------
// #350 Multi-division JOINT AI scheduling — POST /competitions/{id}/schedule/
// ai-plan. One model call over several divisions of one competition, priced as
// a batch. The orchestrator is `aiPlanForCompetition`
// (server/usecases/competition-schedule-ai/); these are the wire contracts.
// ---------------------------------------------------------------------------

export const AiCompetitionPlanRequest = z.object({
  /**
   * The divisions to solve together. The **>= 2 rule is deliberately NOT a
   * `.min(2)` here** — it is the orchestrator's, which answers 400
   * `AI_PLAN_SINGLE_DIVISION`.
   *
   * Zod cannot be the authority for it in either direction. It is not
   * sufficient: `[d, d]` is two array entries and one division, and a division
   * with nothing movable is DROPPED before the quote (ruling R6), so a
   * three-id request can legitimately arrive at one solvable division. And it
   * is not necessary: the orchestrator already de-duplicates and re-checks
   * after the drop. Two mechanisms for one rule would also give the client two
   * different 400s for the same mistake — a `VALIDATION` blob of zod issues,
   * or the code the board renders "use the division schedule page" from.
   *
   * The ceiling stays here: 20 is a shape limit, and nothing downstream needs
   * to have loaded a competition to enforce it.
   */
  division_ids: z.array(Uuid).min(1).max(20),
  instruction: z.string().min(1).max(2000),
  mode: z.enum(["generate", "refine", "repair"]).default("generate"),
  /** Per-division rung override from the confirm card's segmented control.
   *  Advisory — the server always recomputes the quote, and an entry naming a
   *  division outside the run is ignored rather than rejected. */
  rung_overrides: z.record(Uuid, RungLiteral).optional(),
  prior: z
    .object({
      instruction: z.string(),
      assignments: z.array(
        z.object({
          fixture_id: Uuid,
          scheduled_at: IsoDateTime,
          court_label: z.string(),
          division_id: Uuid,
        }),
      ),
    })
    .optional(),
  /** W5 (#400): the confirmed compile from `POST .../schedule/ai-preview`. The
   *  joint twin of {@link AiPlanRequest.preview_id}, and scoped the same way —
   *  a preview taken against ONE division is refused here, because its window
   *  was resolved from a different fixture count than this run's. */
  preview_id: Uuid.optional(),
  /**
   * What the confirm card showed (#387). The server compares it against what it
   * actually charged, reports the divergence on `quote_mismatch` and records a
   * `schedule.ai_quote_mismatch` competition_event.
   *
   * OPTIONAL, and it must stay that way: server-side callers, smoke and every
   * external consumer send none. `.positive()` rather than `.nonnegative()`
   * because there is no such thing as a zero-credit quote — an absent value must
   * never be read as "quoted nothing", and a client that means "I showed no
   * price" says so by omitting the field.
   */
  quoted_credits: z.number().int().positive().optional(),
});
export type AiCompetitionPlanRequest = z.infer<typeof AiCompetitionPlanRequest>;

export const AiCompetitionPlanResponse = z.object({
  /** Every slot names the division the SERVER resolved it to — JOINT_RULES
   *  tells the model not to emit one, so this is never an echo. */
  proposal: z.array(
    z.object({
      fixture_id: z.string(),
      scheduled_at: z.string(),
      court_label: z.string(),
      division_id: z.string(),
      schedule_locked: z.boolean().optional(),
    }),
  ),
  unschedulable: z.array(z.object({ fixture_id: z.string(), reason: z.string(), rule: RuleCode })),
  // The ENGINE verifier's camelCase Conflict, exactly as the single-division
  // AiPlanResponse carries it — NOT the snake_case ScheduleConflict of the
  // apply/validate endpoints. The orchestrator returns `Conflict[]` verbatim,
  // so declaring the other shape here would strip every field of every warning
  // and publish a contract the route does not honour.
  warnings: z.array(AiPlanConflict),
  blocking: z.array(AiPlanConflict),
  diff: z.object({
    moved: z.array(z.string()),
    placed: z.array(z.string()),
    unscheduled: z.array(z.string()),
    unchanged: z.array(z.string()),
  }),
  explanations: z.array(z.object({ fixture_id: z.string(), note: z.string() })),
  summary: z.string(),
  /** The ARCHITECT's own assumptions (stage 2), exactly as
   *  {@link AiPlanResponse.assumptions} carries them — never the resolver's,
   *  which are stage 1 and ride on the preview response. `.default([])` because
   *  the model omits the key routinely and the review panel maps over it. */
  assumptions: z.array(z.string()).default([]),
  /** Court labels not shared by every solved division. Cross-division court
   *  identity is a string match and nothing else, so the board warns. */
  divergent_courts: z.array(z.string()),
  /** Requested divisions dropped before quoting (ruling R6) — the organiser is
   *  told why a division they picked is missing rather than silently getting a
   *  smaller board back. */
  skipped_divisions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      reason: z.literal("no_movable_fixtures"),
    }),
  ),
  /** Public shape only — `cost_usd` stays on the ledger event. */
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    repair_rounds: z.number().int(),
  }),
  /** W6 (#401): the joint solve runs ONCE over the whole board, so this is one
   *  report for the competition, never one per division. */
  repair: AiRepairReport,
  // ---------------------------------------------------------------------
  // ORDER IS LOAD-BEARING. `AiRunPriceFields` declares its own `divisions`
  // key — the meter stamp's per-division PRICE rows — and the override below
  // MUST come after it. A joint response carries ONE `divisions` array
  // holding both those price rows and the board's picker data (the division's
  // name and movable count), exactly as `aiPlanForCompetition` builds it:
  // two sibling arrays over one key would be a join every client redoes on
  // every render.
  //
  // The two directions are NOT symmetric — measured, not assumed:
  //
  //   * Swapping this order (spread AFTER the override) does NOT compile:
  //     1 x TS2783 "'divisions' is specified more than once", plus 4 x TS2339
  //     and 7 x TS18048 knock-on. The wrong order cannot ship, and `tsc` is a
  //     real net for THAT mistake specifically.
  //   * The order as written is the SILENT one. Any later edit that keeps the
  //     shapes structurally compatible — dropping a key from the merged row,
  //     letting the two arrays drift apart — passes `tsc` clean, and Zod does
  //     not error either: it STRIPS the keys the winning schema does not
  //     declare, so `name`/`movable` (or `rung`/`predicted_rung`) simply
  //     vanish from a 200 response with no exception and no warning.
  //
  // Neither this comment nor an assertion on `divisions.length` catches the
  // silent case. The guard is competition-schedule-ai-http.test.ts, which
  // asserts BOTH sets of fields survive one parse of a real orchestrator
  // result.
  // ---------------------------------------------------------------------
  ...AiRunPriceFields,
  divisions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      movable: z.number().int(),
      rung: RungLiteral,
      predicted_rung: RungLiteral,
      underfunded: z.boolean(),
    }),
  ),
});
export type AiCompetitionPlanResponse = z.infer<typeof AiCompetitionPlanResponse>;

// ---------------------------------------------------------------------------
// W5 (#400) — the parse-only preview that precedes either run
// ---------------------------------------------------------------------------

/**
 * POST /divisions/{id}/schedule/ai-preview and
 * POST /competitions/{id}/schedule/ai-preview.
 *
 * One request body for both routes. It runs stage 1 ONLY — the instruction
 * compile — and returns what was compiled without spending a credit or calling
 * the architect, so the organiser can see the rules before paying for a run
 * against them. Declining is a client no-op.
 */
export const AiParsePreviewRequest = z.object({
  instruction: z.string().min(1).max(2000),
  /** Joint route only: the divisions in scope, so the resolver reads the same
   *  window the run will. Omitted on the single-division route, where the
   *  division is the path parameter. */
  division_ids: z.array(Uuid).optional(),
  /** Single-division route only. Advisory, exactly as on {@link AiPlanRequest} —
   *  it is here so the affordability refusal below prices the SAME run the
   *  confirm will start. Without it a rung-3 run would be previewed against a
   *  rung-1 floor and an org that cannot pay would be compiled for anyway. */
  rung: RungLiteral.optional(),
  /** Joint route only. The twin of `rung`, per {@link AiCompetitionPlanRequest}. */
  rung_overrides: z.record(Uuid, RungLiteral).optional(),
});
export type AiParsePreviewRequest = z.infer<typeof AiParsePreviewRequest>;

export const AiParsePreviewResponse = z.object({
  /** Reuse token for the run. ABSENT when the compile failed schema twice —
   *  there is nothing to confirm then, only a fallback to choose. */
  preview_id: Uuid.optional(),
  /** True when stage 1 failed schema twice. The client must offer the explicit
   *  preference fallback and must NEVER fall back on its own: presenting a rule
   *  as enforced while nothing enforces it is the failure this wave closes. */
  failed: z.boolean(),
  compiled: z.object({
    /** Engine constraints, already resolved against the org clock — the rules
     *  the referee will actually check. */
    hard: z.array(HardConstraint),
    soft: z.array(
      z.object({ note: z.string(), weight: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
    ),
    /** Verbatim. Never converted into a rule. Carries the whole instruction back
     *  when `failed` is true, so the card always has something honest to show. */
    unparsed: z.array(z.string()),
    /** RESOLVER assumptions (stage 1, deterministic, pre-credit) — how we read
     *  the window and the weekdays. NOT the architect's own assumptions, which
     *  are stage 2 and ride on the plan response. The two are different arrays
     *  and must never be merged. */
    assumptions: z.array(z.string()),
  }),
  /** The calendar window the INSTRUCTION stated, in the org timezone, as
   *  YYYY-MM-DD — null when it stated none.
   *
   *  Null rather than the run's default window on purpose: the default is
   *  computed by the pack builder from settings, already-scheduled instants and
   *  session windows, and there is exactly one writer of it
   *  (`buildSchedulePack`). Recomputing a second copy here to fill this field
   *  would be a renderer that can drift from the one the run uses. */
  window: z.object({ start: z.string(), end: z.string(), tz: z.string() }).nullable(),
  /** When this preview stops being reusable. A stale preview is stale by
   *  wall-clock as well as by content: the org's clock may have crossed a day
   *  boundary, and "tomorrow" with it. */
  expires_at: IsoDateTime,
});
export type AiParsePreviewResponse = z.infer<typeof AiParsePreviewResponse>;

/**
 * GET /competitions/{id}/schedule/ai-last — the joint mirror of
 * {@link AiLastResult}, field for field.
 *
 * A recall of the last APPLIED plan, not of the last proposal. An AI plan is
 * propose-only and nothing about it is written down unless the organiser
 * applies it — that has been true of the single-division board since v4, and it
 * is why this is the twin's shape rather than a partial plan response. `last`
 * stays null until a joint apply exists (#350 Task 6); `runs.used` counts joint
 * runs on the competition, and `max` is null because joint runs are metered by
 * the credit wallet rather than by a run quota. See `lastCompetitionAiApply`.
 *
 * Declared separately from `AiLastResult` rather than reusing it: the two
 * endpoints count different events and are free to diverge, and `at` is pinned
 * to an ISO instant here where the older schema left it a bare string.
 */
export const AiCompetitionLastResult = z.object({
  last: z.object({ at: IsoDateTime, instruction: z.string(), summary: z.string() }).nullable(),
  runs: z.object({ used: z.number().int(), max: z.number().int().nullable() }),
});
export type AiCompetitionLastResult = z.infer<typeof AiCompetitionLastResult>;

/**
 * POST /competitions/{id}/schedule/apply — persist a joint plan across several
 * divisions ATOMICALLY (#350 Task 6, spec §8). One transaction writes every
 * division's board or none of it; the per-stage endpoint cannot do this, and
 * calling it in a loop leaves half a board written on any mid-flight failure.
 */
export const ApplyCompetitionScheduleRequest = z.object({
  divisions: z
    .array(
      z.object({
        division_id: Uuid,
        /** REQUIRED here, unlike the per-stage apply's optional token: a joint
         *  write that skipped the check on one division would let a stale board
         *  silently overwrite a concurrent edit there while every other
         *  division was guarded. */
        expected_seq: z.number().int().nonnegative(),
        assignments: z
          .array(
            z
              .object({
                fixture_id: Uuid,
                scheduled_at: IsoDateTime,
                // P9 pass 3b: a real `courts.id`, not the legacy free-text
                // label — mirrors `ApplyScheduleRequest`'s identical field
                // (the per-stage apply's own `.strict()` reasoning above
                // applies verbatim here: a client still sending `court_label`
                // must get a loud 400). `venue_id` is optional, same
                // coalesce-over-unchanged semantics `applySchedule`
                // (usecases/schedule/) already gives it.
                court_id: CourtId,
                venue_id: VenueId.nullish(),
              })
              /**
               * `.strict()`, because the plan's own output is WIDER than this.
               * `AiCompetitionPlanResponse.proposal` carries an optional
               * `schedule_locked` (see above), and zod STRIPS unknown keys — so
               * a plan asking to pin a fixture would apply 200 with no pin, and
               * two schemas of one feature would disagree in silence. Strict
               * makes that a loud 400.
               *
               * Deliberately not "support pinning": accepting the field would
               * need the `scheduling.board` gate the per-stage apply puts on pin
               * changes (usecases/schedule/). Nothing sends it today, so this
               * costs no capability and leaves Task 7 free to add pinning as a
               * decision rather than inherit it as an accident.
               */
              .strict(),
          )
          .min(1)
          .max(500),
      }),
    )
    /**
     * `.min(1)`, NOT `.min(2)` — and that is not an oversight.
     *
     * The >= 2 rule on the PLAN endpoint exists to stop discount arbitrage: a
     * joint run is priced at max(1, sum of rungs - 1), so a one-division "joint"
     * run would buy a single-division solve at a discount. Applying costs
     * nothing. Refusing a one-division apply would only mean the board had to
     * decide, per outcome, which of two endpoints to post an already-paid-for
     * plan to — and ruling R6 lets a run legitimately end up with fewer solved
     * divisions than were requested.
     *
     * The ceiling matches the plan request's, since one apply can never span
     * more divisions than one run planned.
     */
    .min(1)
    .max(20),
  /** "ai" only. Manual board edits stay on the per-stage endpoint: a hand edit
   *  is one division by construction. */
  source: z.literal("ai"),
  /** Audit provenance (v4/03 §10) — stamped into every division's
   *  `schedule_applied` row AND the one `schedule.applied_multi` row that
   *  GET /competitions/{id}/schedule/ai-last recalls. `model` is overwritten
   *  server-side with the model that actually ran. */
  ai: AiApplyMeta.optional(),
});
export type ApplyCompetitionScheduleRequest = z.infer<typeof ApplyCompetitionScheduleRequest>;

export const ApplyCompetitionScheduleResult = z.object({
  applied: z.number().int().nonnegative(),
  /** Listed fixtures left where they are because they hold a result, across
   *  every division. */
  skipped: z.number().int().nonnegative(),
  /** Each listed division's seq after this call, in domain order: advanced
   *  when something of it moved, unchanged when nothing did. */
  divisions: z.array(z.object({ division_id: Uuid, seq: z.number().int().nonnegative() })),
  /** The ENGINE verifier's camelCase `Conflict`, exactly as the joint ai-plan
   *  response carries it — NOT the snake_case `ScheduleConflict` of the
   *  per-stage apply. `applyCompetitionSchedule` returns `Conflict[]` verbatim,
   *  so declaring the other shape here would strip every field of every warning
   *  down to `{}` and publish a contract the route does not honour. */
  conflicts: z.array(AiPlanConflict),
});
export type ApplyCompetitionScheduleResult = z.infer<typeof ApplyCompetitionScheduleResult>;

/**
 * POST /competitions/{id}/schedule/restore — undo one joint apply (#386).
 *
 * The anchors come from the CLIENT because only the client holds them: the
 * `schedule.applied_multi` event carries `division_ids` and nothing else. The
 * usecase checks the division set against that event, so a body naming fewer
 * (or other) divisions is a 422 rather than a partial restore.
 */
export const RestoreCompetitionScheduleRequest = z.object({
  checkpoints: z.array(z.object({ division_id: Uuid, checkpoint_id: Uuid })).min(1).max(20),
  /** Double-submit guard, same literal as the per-division restore. */
  confirm: z.literal(true),
});
export type RestoreCompetitionScheduleRequest = z.infer<typeof RestoreCompetitionScheduleRequest>;

/**
 * The joint restore's result — the usecase's `CompetitionRestoreOut`, verbatim.
 *
 * BOTH arrays are contract. The restore is deliberately not one transaction, so
 * a division that refuses is REPORTED in `failed` while the rest still rewind;
 * a caller that reads only `ok` cannot tell WHICH divisions still carry the AI
 * board, which is the reason this endpoint exists at all.
 */
export const RestoreCompetitionScheduleResult = z.object({
  restored: z.array(
    z.object({
      division_id: Uuid,
      /** The division's edit watermark after the rewind. */
      watermark: z.number().int(),
      /** Inverse events appended; 0 means it was already at the anchor. */
      steps: z.number().int(),
    }),
  ),
  /** `reason` is the refusal's message (a missing checkpoint, a stale seq, …).
   *  `code` is `HttpError.code` where the refusal carried one — present for a
   *  frozen division (SCHEDULE_LOCKED), absent for a bare `HttpError` or a
   *  plain `Error`. It is what lets the console say a refusal it recognises in
   *  the reader's own language instead of painting the server's English prose
   *  into a translated card; a client that does not recognise it falls back to
   *  `reason`. Optional, so every existing consumer keeps working. */
  failed: z.array(z.object({ division_id: Uuid, reason: z.string(), code: z.string().optional() })),
  ok: z.boolean(),
});
export type RestoreCompetitionScheduleResult = z.infer<typeof RestoreCompetitionScheduleResult>;

// Custom points & rank control (Jul3/05, PROMPT-25) ---------------------------

export const OverrideStandings = z.object({
  rows: z
    .array(
      z.object({
        entrant_id: Uuid,
        rank: z.number().int().min(1),
        reason: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(64),
});
export type OverrideStandings = z.infer<typeof OverrideStandings>;
