// AI apply orchestration (v4 Task 15, design/v4/02 §6 / 03 §10). Pure and
// React-free so ai-apply.test.ts can mock the fetch seam and assert the exact
// chain: a "before-ai" checkpoint (so the apply is one Undo away), the schedule
// apply(s), the officials apply, then the ticked constraint-suggestion PUT — in
// that order, nothing skipped mid-flight. The console owns the UI; this module
// owns the sequence and the outcome branches it returns.
//
// The API seam is injected (defaults to apiV1) so the test can record call
// order + payloads and simulate a stale-seq 409 without a real server. apiV1
// already unwraps the v1 envelope and throws ApiV1Error with the typed code, so
// SEQ_CONFLICT (another organiser edited the board) is distinguishable from a
// blocking SCHEDULE_CONFLICT — only the former offers "re-run as refine".
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import type { z } from "zod";
import type { AiApplyMeta, AiPlanResponse, PutScheduleSettings, ScheduleConfig , ApplyScheduleRequest } from "@/server/api-v1/schemas";

/** The audit-block model string. The plan response carries no model name (the
 *  server picks it from SCHEDULING_AI_MODEL), so the apply stamps the documented
 *  default for provenance; the server trims + records whatever it receives. */
export const AI_APPLY_MODEL = "claude-sonnet-5";

/** Prefix for the AI accept flow's undo anchor. Each apply gets its own,
 *  stamped with the local date and time — an unlabelled "before-ai" could not
 *  say WHICH run it preceded, which is the whole point of a restore target. */
export const AI_CHECKPOINT_PREFIX = "Before AI";

/** e.g. "Before AI · 20 Jul 2026, 13:05". Local time on purpose: the organiser
 *  reads this next to a wall clock, not a server log. */
export function aiCheckpointLabel(at: Date = new Date()): string {
  const stamp = at.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${AI_CHECKPOINT_PREFIX} · ${stamp}`;
}

/** One proposed placement, tagged with its stage (the apply route is
 *  stage-scoped and rejects cross-stage fixtures).
 *
 *  P9 pass 3b: `court_id` — the apply route's own `ApplyScheduleRequest`
 *  item is `.strict()` and requires `court_id` (schemas.ts), so a payload
 *  still keyed `court_label` 400s outright rather than silently applying. */
export type ScheduleAssignmentInput = z.infer<typeof ApplyScheduleRequest>["assignments"][number] & {
  /** Not part of the apply payload — the caller groups by stage before POSTing
   *  (the route is per-stage), so this rides alongside and is stripped at the
   *  boundary. Everything the SERVER validates is inferred above, so a new
   *  required field becomes a type error here instead of a runtime 400. */
  stage_id: string;
};

/** One officials assignment in the apply route's snake_case shape. */
export interface OfficialsAssignmentInput {
  fixture_id: string;
  official_id: string;
  role_key: string;
  locked: boolean;
}

export interface ApplyAiInput {
  divisionId: string;
  /** The division seq the console rendered at — the optimistic-concurrency token
   *  each schedule apply carries (409 SEQ_CONFLICT on stale). */
  expectedSeq: number;
  /** The full proposal (stage-tagged); excluded ids are filtered here, not by
   *  the caller, so the pure function owns the "leave this one out" rule. */
  scheduleAssignments: ScheduleAssignmentInput[];
  scheduleAudit: AiApplyMeta;
  /** null → skip officials entirely ("Apply schedule only", or no officials
   *  draft). Otherwise the whole proposed set (excluded ids filtered here). */
  officials: { assignments: OfficialsAssignmentInput[]; audit: AiApplyMeta } | null;
  /** Blocking fixtures the organiser unticked — dropped from BOTH the schedule
   *  and officials payloads so they stay at their current slot (02 §6). */
  excludedFixtureIds: string[];
  /** The full merged config + tz to persist the ticked rule changes, or null
   *  when nothing is ticked. */
  suggestions: PutScheduleSettings | null;
  checkpointLabel?: string;
}

export interface ApplyOutcome {
  schedule: "applied" | "seq_conflict" | "error";
  officials: "applied" | "skipped" | "error";
  /** The before-ai checkpoint id — powers the success toast's Undo (restore).
   *  null when the checkpoint step itself failed (nothing was applied). */
  checkpointId: string | null;
  /** The raw server code when schedule/officials errored, for the caller to map
   *  to a localized line (never rendered raw). */
  errorCode?: string;
  /** The HTTP status paired with errorCode — the caller resolves the exact copy
   *  via aiErrorKey(errorStatus, errorCode) (a checkpoint 402 save-point cap, a
   *  422 frozen/too-large, …). Set alongside errorCode; absent on a clean apply. */
  errorStatus?: number;
  /** The fixtures a blocking `SCHEDULE_CONFLICT` (409) named. The server puts
   *  them in the error envelope so a client can point at the matches the plan
   *  would have double-booked; "this would clash with the board" is not an
   *  actionable sentence on its own. Blocking rows only — the same envelope
   *  carries warnings, which are not why the apply was refused. Absent on every
   *  other failure. */
  errorConflicts?: { fixtureId: string; code: string }[];
  /** How many per-stage schedule applies were PERSISTED before this outcome.
   *
   *  A refusal is not a rollback: the proposal is grouped by stage and each
   *  stage is its own transaction with its own `expected_seq`, so a plan
   *  spanning a league and its finals can write the first and be refused on the
   *  second. The board then really has changed, and any copy that says
   *  otherwise is wrong — this is the discriminator, and it is also what makes
   *  offering Undo on a failure correct rather than confusing (the before-AI
   *  checkpoint exists either way). 0 on a clean refusal, the stage count on a
   *  success.
   *
   *  OPTIONAL because "unknown" is a real third answer: the console builds an
   *  outcome of its own if `applyAiPlans` throws unexpectedly, and at that point
   *  nobody knows how far the chain got. Undefined must therefore render NEITHER
   *  "nothing changed" nor "part of it applied" — an honest silence over a
   *  guess. Every return inside this function sets it. */
  stagesApplied?: number;
}

/** The injected fetch seam — matches apiV1's shape (envelope-unwrapped). */
export type ApplyApi = <T>(url: string, options?: { method?: string; json?: unknown }) => Promise<T>;

const codeOf = (err: unknown): string => (err instanceof ApiV1Error ? err.code : "UNKNOWN");
const statusOf = (err: unknown): number => (err instanceof ApiV1Error ? err.status : 0);
/** The paywall feature key rides in the 402 envelope's extra (feature_key). A
 *  checkpoint POST that trips the save-point quota answers PAYMENT_REQUIRED with
 *  feature_key = "schedule.checkpoints.max"; surface that so the console shows the
 *  save-point-specific line, not the misleading "upgrade to use AI". */
const featureKeyOf = (err: unknown): string | undefined =>
  err instanceof ApiV1Error && typeof err.extra.feature_key === "string" ? err.extra.feature_key : undefined;
/** The blocking conflicts a 409 SCHEDULE_CONFLICT rides with (http.ts forwards
 *  `err.data.conflicts` into the envelope's extra). Read defensively: the shape
 *  is a wire payload, and a malformed one must degrade to "no list" rather than
 *  take down the apply's own error reporting. */
const blockingConflictsOf = (err: unknown): { fixtureId: string; code: string }[] | undefined => {
  if (!(err instanceof ApiV1Error) || !Array.isArray(err.extra.conflicts)) return undefined;
  const rows = (err.extra.conflicts as unknown[])
    .filter((c): c is { fixture_id: string; code: string; blocking?: boolean } => {
      if (typeof c !== "object" || c === null) return false;
      const r = c as { fixture_id?: unknown; code?: unknown; blocking?: unknown };
      return typeof r.fixture_id === "string" && typeof r.code === "string" && r.blocking !== false;
    })
    .map((c) => ({ fixtureId: c.fixture_id, code: c.code }));
  return rows.length > 0 ? rows : undefined;
};

// -------------------------------------------------------- constraint suggestions
/** The architect's inferred durable rule changes (a delta over config.constraints). */
export type ConstraintSuggestions = NonNullable<AiPlanResponse["constraint_suggestions"]>;
export type SuggestionKey = keyof ConstraintSuggestions;

/** Stable order for the checklist rows. */
export const SUGGESTION_KEYS: SuggestionKey[] = [
  "restMin",
  "restByGroup",
  "noBackToBack",
  "startWindows",
  "fieldFairness",
  "parallelism",
  "crossPersonClash",
];

/** The suggestion fields actually present in a plan — one checklist row each. */
export function suggestionKeysOf(cs: ConstraintSuggestions | null | undefined): SuggestionKey[] {
  if (!cs) return [];
  return SUGGESTION_KEYS.filter((k) => cs[k] !== undefined);
}

/** config.constraints defaults, so merging a single suggestion over a division
 *  with no constraints yet still yields a complete, valid constraints block. */
const DEFAULT_CONSTRAINTS: NonNullable<ScheduleConfig["constraints"]> = {
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "off",
  parallelism: "mixed",
  crossPersonClash: "warn",
};

/** Merge the ticked suggestion fields into the current config's constraints. The
 *  schedule-settings PUT replaces the whole config, so the caller sends the full
 *  current config with only the ticked constraint fields overlaid. */
export function mergeConstraintSuggestions(
  base: ScheduleConfig,
  cs: ConstraintSuggestions,
  ticked: SuggestionKey[],
): ScheduleConfig {
  if (ticked.length === 0) return base;
  const pick: Partial<ConstraintSuggestions> = {};
  for (const k of ticked) if (cs[k] !== undefined) pick[k] = cs[k] as never;
  return {
    ...base,
    constraints: { ...DEFAULT_CONSTRAINTS, ...(base.constraints ?? {}), ...pick },
  };
}

// -------------------------------------------------------------------- orchestrate
/**
 * Chain the existing apply rails behind the AI console's Apply step. The order is
 * load-bearing and asserted in the test: checkpoint → schedule apply(s) →
 * officials apply → suggestion PUT. A stale-seq 409 on the schedule apply stops
 * the chain and returns `seq_conflict` (officials skipped) so the console can
 * offer "re-run as refine"; an officials failure leaves the schedule applied.
 * The suggestion PUT is best-effort — the schedule is already live, so a failed
 * rule save never unwinds it.
 */
export async function applyAiPlans(input: ApplyAiInput, api: ApplyApi = apiV1): Promise<ApplyOutcome> {
  const excluded = new Set(input.excludedFixtureIds);
  const label = input.checkpointLabel ?? aiCheckpointLabel();

  // 1. Checkpoint first — the anchor the success toast's Undo restores to.
  //
  //    Every apply gets its OWN anchor, timestamped, created with kind:"ai"
  //    (V303) so it is exempt from the organiser's save-point quota. Restore
  //    therefore rewinds the LAST AI run, not the first.
  //
  //    This replaces a reuse-by-label hack that existed because the quota
  //    counted these. That had two failures: restore rolled back to the first
  //    AI apply however many had happened since, and a community org already
  //    holding one ordinary save point could not apply an AI schedule at all —
  //    the create 402'd, this function aborted, and the AI generation had
  //    already been spent producing the plan.
  //
  //    If the anchor fails nothing has changed yet, so surface it and stop.
  let checkpointId: string | null = null;
  try {
    const cp = await api<{ id: string }>(`/api/v1/divisions/${input.divisionId}/checkpoints`, {
      method: "POST",
      json: { label, kind: "ai" },
    });
    checkpointId = cp.id;
  } catch (err) {
    return {
      schedule: "error",
      officials: "skipped",
      checkpointId: null,
      stagesApplied: 0,
      errorCode: featureKeyOf(err) ?? codeOf(err),
      errorStatus: statusOf(err),
    };
  }

  // 2. Schedule apply, grouped by stage (the route rejects cross-stage sets).
  //    Each apply answers the division's seq after it, and the next stage's
  //    expected_seq is that answer: an apply that moved something advanced it
  //    by one ledger step, and one that moved nothing (every fixture held a
  //    result) left it where it was (review 4 of #857, Minor 1).
  const wanted = input.scheduleAssignments.filter((a) => !excluded.has(a.fixture_id));
  const byStage = new Map<string, ScheduleAssignmentInput[]>();
  for (const a of wanted) {
    const g = byStage.get(a.stage_id);
    if (g) g.push(a);
    else byStage.set(a.stage_id, [a]);
  }
  let seq = input.expectedSeq;
  // Counted, not inferred from `seq`: the caller's own expectedSeq is the base,
  // and a reader working the difference back out would have to know that.
  let stagesApplied = 0;
  for (const [stageId, group] of byStage) {
    try {
      const res = await api<{ seq: number }>(`/api/v1/stages/${stageId}/schedule/apply`, {
        method: "POST",
        json: {
          assignments: group.map((a) => ({
            fixture_id: a.fixture_id,
            scheduled_at: a.scheduled_at,
            court_id: a.court_id,
          })),
          source: "ai",
          expected_seq: seq,
          ai: input.scheduleAudit,
        },
      });
      seq = res.seq;
      stagesApplied += 1;
    } catch (err) {
      const code = codeOf(err);
      const conflicts = blockingConflictsOf(err);
      return {
        schedule: code === "SEQ_CONFLICT" ? "seq_conflict" : "error",
        officials: "skipped",
        checkpointId,
        stagesApplied,
        errorCode: code,
        errorStatus: statusOf(err),
        ...(conflicts ? { errorConflicts: conflicts } : {}),
      };
    }
  }

  // 3. Officials apply — the whole proposed set minus excluded fixtures. The
  //    route replaces the division's unlocked assignments, so an empty set would
  //    wipe rather than no-op: skip the call when nothing survives filtering.
  let officials: ApplyOutcome["officials"] = "skipped";
  let officialsError: { code: string; status: number } | null = null;
  if (input.officials) {
    const rows = input.officials.assignments.filter((a) => !excluded.has(a.fixture_id));
    if (rows.length > 0) {
      try {
        await api(`/api/v1/divisions/${input.divisionId}/officials/apply`, {
          method: "POST",
          json: { assignments: rows, ai: input.officials.audit },
        });
        officials = "applied";
      } catch (err) {
        officials = "error";
        officialsError = { code: codeOf(err), status: statusOf(err) };
      }
    }
  }

  // 4. Ticked rule changes — best-effort; the schedule is already live.
  if (input.suggestions) {
    try {
      await api(`/api/v1/divisions/${input.divisionId}/schedule-settings`, {
        method: "PUT",
        json: input.suggestions,
      });
    } catch {
      /* the applied schedule stands even if the durable rule save fails */
    }
  }

  // The schedule is live; officials may still have failed — carry its code+status
  // so the caller can sharpen the note. errorCode/errorStatus stay absent on a
  // clean apply, so a success `toEqual` over the outcome keeps holding.
  return officialsError
    ? {
        schedule: "applied",
        officials,
        checkpointId,
        stagesApplied,
        errorCode: officialsError.code,
        errorStatus: officialsError.status,
      }
    : { schedule: "applied", officials, checkpointId, stagesApplied };
}
