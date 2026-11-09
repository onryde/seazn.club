import "server-only";
import type { RoundFields } from "../schedule";
import type {
  PackAssignment,
  PackDraftAssignment,
  PackEntrant,
  PackFixture,
  PackObstacle,
  PackPerson,
  PackSettings,
} from "../schedule-ai";
import type { RepairReport } from "../schedule-ai-solver";
import type { AiSchedulePlan } from "../schedule-ai-prompt";
import type { HardConstraint, RuleCode } from "@seazn/engine/scheduling";
import type { RunMeterStamp, Rung } from "@/lib/ai-rung";
import type { QuoteMismatch } from "../ai-quote-mismatch";
import type { Clock, Conflict } from "@seazn/engine/scheduling";

// ---------------------------------------------------------------------------
// Pack shape. Every per-division `Pack*` type is reused verbatim and widened
// with the division it belongs to; later tasks depend on these exact names.
// ---------------------------------------------------------------------------

export interface CompetitionPackDivision {
  id: string;
  name: string;
  sport: string;
  tz: string;
  /** That division's own settings, verbatim — never merged with a sibling's.
   *  matchMinutes/gapMinutes/sessionWindows/blackouts legitimately differ.
   *
   *  ONE exception, and it is not a merge: `constraints.hard[].scope.personKey`
   *  is re-resolved through the run-wide identity (#450), because that scope is
   *  the only field on here whose namespace is decided by the RUN rather than by
   *  the division. See `withResolvedPersonScopes`. */
  settings: PackSettings;
  /** This division's movable fixture ids, in the pack's movable order. */
  movableIds: string[];
  /** How many of `movableIds` this division contributed to `draft`. Less than
   *  `movableIds.length` means the draft is PARTIAL — without this count a
   *  truncated draft is indistinguishable from a complete one.
   *
   *  WHY it is short depends on the mode, so do not render one explanation:
   *    generate — the board did not fit. The greedy pass returns the overflow
   *               as `no_slot` conflicts, which the per-division builder
   *               discards. Divisions are drafted in order, so the later ones
   *               starve first. This is the only mode where "did not fit" is
   *               the right reading.
   *    repair   — `draft` is the movable set filtered to fixtures that already
   *               have a slot, so a short count just means some are unplaced.
   *    refine   — `draft` is the prior proposal intersected with the movable
   *               set, so a short count means the prior did not cover them. */
  draftPlaced: number;
}

export interface CompetitionPackFixture extends PackFixture {
  division_id: string;
}

export interface CompetitionPackObstacle extends PackObstacle {
  /** null when the obstacle comes from a division NOT in this run. */
  division_id: string | null;
}

export interface CompetitionPackAssignment extends PackAssignment {
  division_id: string;
}

/** The joint draft's row shape (#397) — the joint twin of
 *  `PackDraftAssignment`. `scheduled_at` is nullable here and nowhere else: a
 *  fixture whose persisted time is an epoch sentinel reaches the model as
 *  UNPLACED rather than as 1970-01-01. `prior` keeps the placed shape. */
export interface CompetitionPackDraftAssignment extends PackDraftAssignment {
  division_id: string;
}

export interface CompetitionPack {
  mode: "generate" | "refine" | "repair";
  competition: { id: string; name: string };
  /** The ORGANISATION zone (#397, design §2.1). ONE zone governs every temporal
   *  decision in this pack — day boundaries, weekday targets, session hours and
   *  the offset every timestamp is written in, INCLUDING foreign obstacles. A
   *  division's own `tz` below is display metadata and drives nothing. */
  tz: string;
  /** The calendar anchor, from an instant the caller injected. One per RUN, so
   *  two divisions cannot disagree about what "today" is. */
  clock: Clock;
  /** The days this competition runs: the union of every selected division's
   *  window, so no division is asked to fit inside another's day. `end` is
   *  inclusive. */
  window: { start: string; end: string };
  /** The daily fallback for a division with no `sessionWindows`, as "HH:MM" in
   *  `tz`. */
  sessionHours: { start: string; end: string };
  /** Sorted by name, then slug. */
  divisions: CompetitionPackDivision[];
  /** Union of every selected division's court ids (real `courts.id` values,
   *  P9), sorted. */
  courts: string[];
  /** Court ids that do NOT appear in every selected division — the board
   *  warns on these, so an organiser sees the run does not offer every
   *  division the same physical courts. */
  divergentCourts: string[];
  entrants: (PackEntrant & { division_id: string })[];
  people: PackPerson[];
  /** Every person who COULD stand in each movable fixture, including the
   *  advancers behind a null slot (#396), resolved against the WHOLE run's
   *  person set. Keyed for every movable fixture, in `fixtures.movable` order;
   *  the source of `Assignment.people` for both the joint placer's feed-forward
   *  and {@link toJointEngineAssignments}, so a draft cannot be legal under a
   *  rule the joint referee applies differently. */
  participants: Record<string, string[]>;
  /** Movable fixture id → its pool's UUID (#449), unioned from the source packs.
   *  The joint twin of {@link SchedulePack.poolIds}, server-side only for the
   *  same reason: `CompetitionPackFixture.pool` stays the display KEY the model
   *  reads, while the engine, the DB and every stored rule speak the uuid.
   *
   *  Keys inserted in `fixtures.movable` order, so the object serialises in a
   *  domain order rather than a per-seed one. */
  poolIds: Record<string, string>;
  /** C1 gap B — the joint twin of {@link SchedulePack.stageIds}, unioned from
   *  the source packs, server-side only for the same reason: `stageId` feeds
   *  {@link toJointEngineAssignments}'s `Assignment.stageId`, which
   *  `validateAssignments`'s round-order pair scan groups on. Total over
   *  `fixtures.movable` — `fixtures.stage_id` is NOT NULL. Keys inserted in
   *  `fixtures.movable` order, like `poolIds`. */
  stageIds: Record<string, string>;
  /** C1 gap B — the joint twin of {@link SchedulePack.roundNos}. ONLY the
   *  fixtures whose stage is a round sequence (league, group, swiss — W3
   *  T3b), unioned from the source packs' own gated maps (each built against
   *  ITS OWN division's `roundRobinStageIds`) — never re-derived here from
   *  `f.round` (the ungated, model-facing display value), or a bracket or
   *  stepladder stage's display round would be forwarded as round order. Keys
   *  inserted in `fixtures.movable` order, like `poolIds`. */
  roundNos: Record<string, number>;
  /** X-SW-31 (rulings 255-256) - the joint twin of {@link SchedulePack.roundRules}: each source pack's own map (built
   *  against ITS OWN division's settings, so the divisions of one run never read each other's rest or cap), unioned.
   *  Absent, not empty, when no source pack has one. SERVER-SIDE ONLY, like `roundNos`. */
  roundRules?: Record<string, RoundFields>;
  /** Deterministic preprocessing choices worth telling the organiser about:
   *  stripped bye feeders (from each source pack) and the run-wide same-name
   *  person grouping. Rendered at W5 (#400). */
  assumptions: string[];
  /** The organiser's instruction, compiled (#398). Resolved ONCE at this level,
   *  not per division: a joint run is one set of days and one reading, and the
   *  feasibility bump needs the whole run's fixture count to be right. PROMPT
   *  MATERIAL — the model is verified against exactly these rules. */
  parsed: {
    hard: HardConstraint[];
    soft: { note: string; weight: 1 | 2 | 3 }[];
    unparsed: string[];
  };
  fixtures: { movable: CompetitionPackFixture[]; obstacles: CompetitionPackObstacle[] };
  draft: CompetitionPackDraftAssignment[];
  instruction: string;
  prior: { instruction: string; assignments: CompetitionPackAssignment[] } | null;
}

export interface CompetitionPlanResult {
  /** Each entry carries the division the server resolved it to — the model is
   *  told NOT to emit a division field (JOINT_RULES OUTPUT), so this is derived
   *  from the pack, never echoed. */
  proposal: {
    fixture_id: string;
    scheduled_at: string;
    court_label: string;
    division_id: string;
    schedule_locked?: boolean;
  }[];
  unschedulable: { fixture_id: string; reason: string; rule: RuleCode }[];
  warnings: Conflict[];
  blocking: Conflict[];
  diff: { moved: string[]; placed: string[]; unscheduled: string[]; unchanged: string[] };
  explanations: { fixture_id: string; note: string }[];
  constraint_suggestions?: AiSchedulePlan["constraint_suggestions"];
  summary: string;
  /** W5 (#400): the ARCHITECT's own assumptions, exactly as
   *  {@link AiPlanResult.assumptions} carries them — never the resolver's.
   *  Always an array, never undefined. */
  assumptions: string[];
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number; cost_usd: number | null };
  /** W6 (#401): how this board reached its final state, exactly as
   *  {@link AiPlanResult.repair} carries it. The joint solve runs ONCE over the
   *  whole board — see {@link jointSolverConfig}. */
  repair: RepairReport;
}

export interface AiCompetitionPlanRequest {
  /** At least two, de-duplicated by the orchestrator. */
  division_ids: string[];
  instruction: string;
  mode: "generate" | "refine" | "repair";
  /** Per-division rung override keyed by division id (the confirm card's
   *  segmented control). Advisory: the server always recomputes the quote, and
   *  a value that is not 1|2|3 — or names a division not in the run — is
   *  ignored by `quoteRun` rather than being an error. */
  rung_overrides?: Record<string, number>;
  prior?: { instruction: string; assignments: CompetitionPackAssignment[] };
  /** W5 (#400): a confirmed compile from the joint preview endpoint. Optional —
   *  a run without one compiles inline exactly as before, which is what smoke,
   *  e2e and every external consumer do. */
  preview_id?: string;
  /** #387: the credits the joint confirm card SHOWED. Optional, and an absent
   *  value is silence rather than zero — server-side callers send none. */
  quoted_credits?: number;
}

/**
 * `constraint_suggestions` is deliberately NOT part of the joint response.
 *
 * The model emits them in the ENGINE shape — `startWindows[].notBefore/notAfter`
 * are epoch ms — and the single-division endpoint renders them to
 * ISO-with-offset in that division's timezone before answering
 * (`isoConstraintSuggestions`, schedule-ai.ts:1275). A joint run has no single
 * timezone to render in (ruling R8), and a suggestion is a durable rule for ONE
 * division's settings. So there is no correct joint answer here — only a choice
 * between shipping raw epoch numbers into a field clients parse as ISO, and
 * silently attributing one division's zone to another division's rule. Dropping
 * the field is the honest third option; a per-division suggestion channel is its
 * own design, not a side effect of this endpoint.
 */
export interface AiCompetitionPlanResponse
  extends Omit<CompetitionPlanResult, "usage" | "constraint_suggestions">,
    Omit<RunMeterStamp, "divisions"> {
  /** Court ids (real `courts.id` values, P9) not shared by every solved
   *  division, so the board can warn on them. NOT display-ready — a
   *  consumer must resolve each id to a court name before rendering it;
   *  never render a bare uuid. */
  divergent_courts: string[];
  /**
   * One row per SOLVED division, in pack order: what it is AND what it cost.
   *
   * Deliberately ONE array. `RunMeterStamp.divisions` (lib/ai-rung.ts, mirrored
   * by `AiRunPriceFields` in api-v1/schemas.ts) already keys a per-division
   * price breakdown by division id, and the board needs the division's name and
   * movable count against the same ids — two sibling arrays over one key is a
   * join the client would have to do on every render, and the plan's own
   * response sketch collided on this exact name. So the price fields are merged
   * in here, and the LEDGER event keeps meterStamp's narrow shape verbatim.
   */
  divisions: {
    id: string;
    name: string;
    movable: number;
    rung: Rung;
    predicted_rung: Rung;
    underfunded: boolean;
  }[];
  /** Requested divisions dropped from the run before quoting (ruling R6), so
   *  the organiser is told why a division they selected is missing from the
   *  proposal rather than silently getting a smaller board back. */
  skipped_divisions: { id: string; name: string; reason: "no_movable_fixtures" }[];
  /** Public shape only — `cost_usd` stays on the ledger event. */
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number };
  /**
   * #387: present ONLY when the confirm card's quote and the charge disagreed.
   *
   * Declared here rather than on `RunMeterStamp`, which every ledger event
   * spreads: `meterStamp` never produces this field, and putting it on that
   * shape would advertise a key those rows can never carry.
   */
  quote_mismatch?: QuoteMismatch;
}
