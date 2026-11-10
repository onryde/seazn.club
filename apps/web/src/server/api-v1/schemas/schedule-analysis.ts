// /api/v1 contracts — capacity pre-check (D2), schedule health (D3), auto-schedule result, apply, validate and publish.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
import { HardConstraint } from "@seazn/engine/scheduling";
import { Uuid, CourtId, VenueId, DivisionStatus } from "./common.ts";
import { ScheduleAssignment, ScheduleConflict, ScheduleMetrics, ScheduleSolverInfo, IsoDateTime } from "./scheduling.ts";

// ---------------------------------------------------------------------------
// Capacity pre-check (D2, docs/superpowers/specs/bench-product-value/designs/
// 2026-08-13-capacity-precheck-design.md) — the 422 CAPACITY_IMPOSSIBLE
// report on /stages/{id}/schedule/auto and /competitions/{id}/schedule/
// ai-plan, and the shape the setup card's live client-side recompute
// produces (packages/engine/src/scheduling/capacity.ts's assessCapacity —
// an engine lib import, no fetch, for that path).
//
// camelCase, DELIBERATELY breaking this file's snake_case wire convention:
// mirrors the engine's CapacityReport field for field so the client can hand
// a 422's `report` extra straight to the SAME renderer the live card uses,
// with no mapping step — the design doc states this explicitly ("the card
// consumes the identical type client-side"), unlike ScheduleConflict, whose
// `Conflict.reason` union genuinely needs `REASON_CODE` at the boundary.
export const CapacityReport = z.object({
  verdict: z.enum(["impossible", "tight", "ok"]),
  slotSupply: z.number().int().nonnegative(),
  slotDemand: z.number().int().nonnegative(),
  perDay: z.array(
    z.object({
      date: z.string(),
      supply: z.number().int().nonnegative(),
      demandCeiling: z.number().int().nonnegative(),
    }),
  ),
  restBound: z.array(
    z.object({
      entrantId: z.string(),
      need: z.number().nonnegative(),
      available: z.number().nonnegative(),
      violated: z.boolean(),
    }),
  ),
  suggestions: z.array(
    z.object({
      kind: z.enum(["add_day", "add_court", "shorten_match", "shrink_gap", "raise_cap"]),
      amount: z.number(),
      flipsVerdict: z.boolean(),
    }),
  ),
});
export type CapacityReport = z.infer<typeof CapacityReport>;

/** POST /divisions/{id}/schedule/capacity (P10 §4) — the board's live,
 *  unsaved config/fixtures, so the server can run the SAME precheck the
 *  client used to run alone, now with real court calendars (P9 stopped
 *  shipping them to the board payload; that is unchanged — only the NUMBERS
 *  travel back over this endpoint).
 *
 *  A WIRE-side schema, deliberately separate from the usecase-side
 *  `CapacityPrecheckInput` in `capacity-guard.ts` that the route actually
 *  parses the request with — registered here only so the generated spec
 *  documents the shape (the `ReorderSponsors`/`ReorderSponsorsInput` pair
 *  above this file's sponsors section is this repo's own precedent for the
 *  two staying independent objects, not a shared source of truth).
 *
 *  `fixtures` mirrors `CapacityFixtureInput` (capacity-input.ts) field for
 *  field, not raw DB column names: both existing client call sites already
 *  map their fixture rows into this exact shape before running the
 *  precheck locally, so sending it as-is needs no second mapping step.
 *  `config` mirrors `CapacityConfigInput` minus `tz` (never client-supplied
 *  — `settings.orgTz` is the governing clock, #397, resolved server-side)
 *  and `courtCalendars` (what this endpoint exists to add). */
export const CapacityPrecheck = z.object({
  fixtures: z
    .array(
      z.object({
        id: Uuid.optional(),
        extKey: z.string().nullable().optional(),
        winnerTo: z.string().nullable().optional(),
        home: Uuid.optional(),
        away: Uuid.optional(),
        poolId: Uuid.optional(),
      }),
    )
    .max(2000),
  config: z.object({
    // These two bounds are LITERALS here on purpose, and they must equal
    // `CAPACITY_PRECHECK_MAX_FIXTURES`/`_COURTS` (lib/capacity-bounds.ts),
    // which the route's own parser (capacity-guard.ts) and the client hooks
    // both import.
    //
    // Importing them here does not work: this file is consumed by
    // `scripts/openapi-gen.ts` under plain `node --experimental-strip-types`
    // (see this file's header — "shared with the OpenAPI generator script"),
    // which does NOT resolve the `@/` tsconfig path alias. Adding that
    // import made `npm run openapi:gen` die with `ERR_MODULE_NOT_FOUND:
    // Cannot find package '@/lib'` — and, worse, the drift check that runs
    // straight afterwards still reported "no drift", because a generator
    // that never ran rewrites nothing. That is why the parity is enforced by
    // an actual test instead: `capacity-precheck-bounds.test.ts` parses
    // over-bound payloads against BOTH schemas and pins them to the shared
    // constants, so a change to one that is not mirrored in the other fails
    // loudly rather than silently widening the published contract.
    courts: z.array(CourtId).max(50),
    sessionWindows: z.array(z.object({ from: z.number(), to: z.number() })).max(200).optional(),
    blackouts: z
      .array(z.object({ court: CourtId.optional(), from: z.number(), to: z.number() }))
      .max(200)
      .optional(),
    matchMinutes: z.number().int().positive(),
    gapMinutes: z.number().int().min(0),
    perEntrantMinRest: z.number().int().min(0),
    // Review fix (finding 3, resource exhaustion): mirrors the same 365-day
    // span cap capacity-guard.ts's CapacityPrecheckInput now carries (that
    // schema — deliberately independent, see its own header — is what the
    // route actually parses the live request with; this one governs the
    // generated spec). Unbounded from/to let one authenticated POST force
    // ~200k usableWindows calls (courts.max(50) x calendarDays' own 4000-day
    // internal ceiling in capacity-input.ts). 365 days matches this repo's
    // own precedent for a schedule's default span (calendar.ts's
    // `horizonMinutes ?? 365 * 24 * 60`).
    window: z
      .object({ from: z.number(), to: z.number() })
      .refine((w) => w.to - w.from <= 365 * 24 * 60 * 60 * 1000, {
        message: "window must not span more than 365 days",
      })
      .optional(),
    constraints: z
      .object({
        restMin: z.number().int().min(0).optional(),
        // Bounded like every sibling in this schema: an unbounded record was the
        // one uncapped field on a client-supplied body (P10 Task 5 review). Value
        // range matches the other two restByGroup declarations in this file.
        restByGroup: z
          .record(z.string(), z.number().int().min(0).max(24 * 60))
          .refine((r) => Object.keys(r).length <= 200, { message: "at most 200 groups" })
          .optional(),
        noBackToBack: z.boolean().optional(),
        hard: z.array(HardConstraint).max(200).optional(),
      })
      .optional(),
    hard: z.array(HardConstraint).max(200).optional(),
  }),
});
export type CapacityPrecheck = z.infer<typeof CapacityPrecheck>;

// ---------------------------------------------------------------------------
// Schedule health score (D3, docs/superpowers/specs/bench-product-value/
// designs/2026-08-13-schedule-health-design.md) — GET /stages/{id}/schedule/
// health's 200 body. camelCase, same deliberate break from this file's
// snake_case wire convention CapacityReport takes above, and for the same
// reason: mirrors the engine's HealthMetric/HealthReport field for field
// (packages/engine/src/scheduling/health.ts's assessHealth) so the panel can
// render the wire response with the same renderer a client-side recompute
// would use, no mapping step.
export const HealthOffender = z.object({
  kind: z.enum(["entrant", "court", "courtDay"]),
  id: z.string(),
  label: z.string(),
  value: z.number(),
});

export const HealthMetric = z.object({
  key: z.enum(["restSpread", "courtBalance", "gapDispersion", "homeAwayAlternation", "primeSlotFairness"]),
  score: z.number().int().min(0).max(100),
  // Structured, never literal prose — the engine lib emits an i18n KEY, not
  // English (standing i18n rule; see health.ts's HealthExplanation doc
  // comment). The panel resolves `key` against the active locale's
  // `schedule.health.explain.*` dictionary entry, interpolating `params`.
  explanation: z.object({
    key: z.string(),
    params: z.record(z.string(), z.number()).optional(),
  }),
  offenders: z.array(HealthOffender),
});
export type HealthMetric = z.infer<typeof HealthMetric>;

/** 5 entries, or 4 when the stage is not table-shaped (league/group/swiss/
 *  americano) — homeAwayAlternation is ABSENT then, never a present entry
 *  scored 0 (design doc, verbatim; see schedule-health.ts's TABLE_KINDS). */
export const ScheduleHealthReport = z.object({
  stageId: Uuid,
  computedAt: z.iso.datetime({ offset: true }),
  metrics: z.array(HealthMetric).min(4).max(5),
});
export type ScheduleHealthReport = z.infer<typeof ScheduleHealthReport>;

/** GET /competitions/{id}/schedule/health's 200 body — the joint variant
 *  (design doc: "returns per-division arrays + a combined block"). A stage
 *  entry is EITHER a full report or a bare `{stageId, status:"empty"}` —
 *  never a thrown 409, so one unscheduled division cannot take the whole
 *  joint call down (mirrors the "aggregate every division, never
 *  short-circuit on the first" shape `aiPlanForCompetition`'s capacity
 *  guard uses). */
export const StageHealthEntry = z.discriminatedUnion("status", [
  z.object({
    stageId: Uuid,
    status: z.literal("ready"),
    computedAt: z.iso.datetime({ offset: true }),
    metrics: z.array(HealthMetric).min(4).max(5),
  }),
  z.object({ stageId: Uuid, status: z.literal("empty") }),
]);

export const DivisionHealthEntry = z.object({
  divisionId: Uuid,
  name: z.string(),
  stages: z.array(StageHealthEntry),
});

export const CompetitionScheduleHealthReport = z.object({
  competitionId: Uuid,
  computedAt: z.iso.datetime({ offset: true }),
  divisions: z.array(DivisionHealthEntry),
  // gapDispersion + primeSlotFairness ONLY (design doc: "computed over the
  // union where meaningful") — always exactly 2 entries.
  combined: z.object({ metrics: z.array(HealthMetric).length(2) }),
});
export type CompetitionScheduleHealthReport = z.infer<typeof CompetitionScheduleHealthReport>;

export const AutoScheduleResult = z.object({
  assignments: z.array(ScheduleAssignment),
  conflicts: z.array(ScheduleConflict),
  metrics: ScheduleMetrics,
  solver: ScheduleSolverInfo,
});

/** POST /stages/{id}/schedule/apply — persist an assignment set. */
/** Optional AI provenance stamped into the apply/assign ledger events (v4/03 §10).
 *  Present only when the apply originated from the AI Schedule/Officials Architect;
 *  the instruction is trimmed server-side and recalled by
 *  GET /divisions/{id}/schedule/ai-last. Shared by ApplyScheduleRequest and the
 *  officials ApplyAssignmentsInput. */
export const AiApplyMeta = z.object({
  /** Trimmed server-side at the apply seam (usecases/schedule/ / officials.ts), so it
   *  stays a plain string here — a zod transform would break openapi:gen. */
  instruction: z.string().max(500),
  summary: z.string().max(600),
  model: z.string(),
  repair_rounds: z.number().int().nonnegative(),
});
export type AiApplyMeta = z.infer<typeof AiApplyMeta>;

export const ApplyScheduleRequest = z.object({
  assignments: z
    .array(
      z
        .object({
          fixture_id: Uuid,
          scheduled_at: IsoDateTime,
          // P9 pass 3a — see PatchFixture's identical note just above, incl.
          // why `.strict()` below: a client still sending `court_label`
          // must get a loud 400, not a silently-stripped-and-then-required-
          // -field-missing error that names the wrong thing.
          court_id: CourtId,
          venue_id: VenueId.nullish(),
          schedule_locked: z.boolean().optional(),
          // ECHOED, ignored. `/schedule/auto` returns these two alongside the
          // assignment, and posting its response straight back to /apply is the
          // documented round-trip (the board does it, and so does
          // auto-schedule.spec.ts). `.strict()` below turned that into a 400 on
          // an unknown key, which is a contract break dressed as validation —
          // the strictness exists to reject a client still sending
          // `court_label`, not to reject this endpoint's own output.
          ends_at: IsoDateTime.optional(),
          court_name: z.string().nullish(),
        })
        .strict(),
    )
    .min(1)
    .max(500),
  source: z.enum(["auto", "manual", "ai"]).default("auto"),
  /** Optimistic token (v3/11 gap 10) — see PatchFixture.expected_seq. */
  expected_seq: z.number().int().nonnegative().optional(),
  /** Audit provenance when source === "ai" (v4/03 §10). */
  ai: AiApplyMeta.optional(),
});
export type ApplyScheduleRequest = z.infer<typeof ApplyScheduleRequest>;

/** GET /divisions/{id}/schedule/ai-last — the most recent AI-sourced apply
 *  (null when the division has never been AI-scheduled) plus the division's
 *  generation budget: `used` counts successful schedule generations from the
 *  run ledger, `max` is the plan's per-division cap (null = unlimited). */
export const AiLastResult = z.object({
  last: z.object({ at: z.string(), instruction: z.string(), summary: z.string() }).nullable(),
  runs: z.object({ used: z.number().int(), max: z.number().int().nullable() }),
});
export type AiLastResult = z.infer<typeof AiLastResult>;

export const ApplyScheduleResult = z.object({
  applied: z.number().int().nonnegative(),
  /** Listed fixtures left where they are because they hold a result (a start
   *  taken back leaves a match `scheduled` with its scoring). */
  skipped: z.number().int().nonnegative(),
  conflicts: z.array(ScheduleConflict),
  /** The division's seq after this call — the next write's `expected_seq`.
   *  Advanced when the apply moved something, unchanged when it moved
   *  nothing (every listed fixture skipped): adopt it, never assume +1. */
  seq: z.number().int().nonnegative(),
});

export const ValidateScheduleResult = z.object({
  conflicts: z.array(ScheduleConflict),
});

/** POST /divisions/{id}/publish-schedule (#230 item 2).
 *
 *  Publish runs the board through the same validator the conflicts panel runs.
 *  Blocking conflicts refuse outright — there is deliberately NO field here that
 *  overrides those. `acknowledge_warnings` covers only the warning level: the
 *  organiser has seen the rest shortfall or the day-cap breach and is publishing
 *  anyway, and `reason` records why, on the `schedule_published` event.
 *
 *  Every field is optional and the route parses an ABSENT body as `{}` — the
 *  console and existing API clients POST this endpoint with no body at all, and
 *  adding a gate is not a licence to 400 them. */
export const PublishScheduleRequest = z.object({
  acknowledge_warnings: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});
export type PublishScheduleRequest = z.infer<typeof PublishScheduleRequest>;

export const PublishScheduleResult = z.object({
  division_id: Uuid,
  status: DivisionStatus,
  published: z.boolean(),
});

/** POST /competitions/{id}/schedule/publish — the competition-wide twin.
 *
 *  Same two fields as the per-division request above, meaning the same things:
 *  ONE acknowledgement covers every division in the run, and `reason` is
 *  stamped on every `schedule_published` event it writes. A competition with
 *  eight unreleased divisions is otherwise eight visits to eight pages.
 *
 *  Body optional, parsed from an absent one as `{}`, exactly like the
 *  per-division route. */
export const PublishCompetitionScheduleRequest = z.object({
  acknowledge_warnings: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});
export type PublishCompetitionScheduleRequest = z.infer<typeof PublishCompetitionScheduleRequest>;

/** BEST EFFORT, so the result is a REPORT, not a count.
 *
 *  Publishing is independent per division, so one refused board must not
 *  withhold the rest: the `published` divisions are live and the refused ones
 *  come back with their reason attached. `blocking` distinguishes the two
 *  refusals an organiser acts on differently — `PUBLISH_UNACKNOWLEDGED`
 *  (false) clears by re-sending with `acknowledge_warnings`, `PUBLISH_BLOCKED`
 *  (true) never does. Only divisions still at `setup` are candidates, so a
 *  division that has already released its times appears nowhere in `results`. */
export const PublishCompetitionScheduleResult = z.object({
  published: z.number().int(),
  needs_acknowledgement: z.number().int(),
  blocked: z.number().int(),
  results: z.array(
    z.object({
      division_id: Uuid,
      name: z.string(),
      published: z.boolean(),
      refusal: z
        .object({
          code: z.string(),
          blocking: z.boolean(),
          conflicts: z.array(ScheduleConflict),
        })
        .optional(),
    }),
  ),
});
export type PublishCompetitionScheduleResult = z.infer<typeof PublishCompetitionScheduleResult>;
