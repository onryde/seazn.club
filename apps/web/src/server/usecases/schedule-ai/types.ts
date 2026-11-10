// The shapes the schedule-ai modules share: the context pack the builder
// assembles, its parts, and the result a run of the architect produces.
// Types only — nothing here is evaluated at runtime.
import type {
  Clock,
  Conflict,
  CourtCalendar,
  HardConstraint,
  RuleCode,
  SchedulingConstraints,
} from "@seazn/engine/scheduling";
import type { RoundFields } from "../schedule";
import type { RepairReport } from "../schedule-ai-solver";

// ---------------------------------------------------------------------------
// Pack shape (design/v4/01 §2 + officials per design/v4/03 §2). JSON-serialisable.
// ---------------------------------------------------------------------------

export interface PackStartWindow {
  target: { kind: string; id: string };
  notBefore?: string;
  notAfter?: string;
}

export interface PackConstraints {
  restMin?: number;
  restByGroup?: Record<string, number>;
  noBackToBack: boolean;
  startWindows: PackStartWindow[];
  fieldFairness: string;
  parallelism: string;
  crossPersonClash: string;
  /** Durable division rules (#398), in the same vocabulary a compiled
   *  instruction produces. Merged with `pack.parsed.hard` by `verifyConfig`, so
   *  hard rules have exactly one home. Optional for the same reason the engine's
   *  field is: this type is built as an object literal at many call sites. */
  hard?: HardConstraint[];
}

export interface PackSettings {
  matchMinutes: number;
  gapMinutes: number;
  /** The Settings-tab rest. Absent from the pack until now, which is how the
   *  referee came to enforce only `constraints.restMin` — a division whose rest
   *  was set in Settings had it silently ignored by AI Schedule while
   *  Auto-schedule honoured it. Both the model and the referee need it. */
  perEntrantMinRest: number;
  courts: string[];
  sessionWindows: { from: string; to: string }[];
  blackouts: { court?: string; from: string; to: string }[];
  constraints: PackConstraints | null;
}

export interface PackFixture {
  id: string;
  ext_key: string | null;
  round: number;
  seq: number;
  pool: string | null;
  home: string | null;
  away: string | null;
  feeds: { winner_to: string | null; after: string[] };
  current: { at: string | null; court: string | null };
  pinned: boolean;
  /** P9 (stage court tags) / #622 (round-scoped court tags): present only when
   *  THIS FIXTURE genuinely narrows the division-wide candidate set — its own
   *  `division ∪ stage ∪ round role` tags resolve to a STRICT SUBSET of
   *  `settings.courts` (see buildSchedulePack's `fixtureCandidateCourts`/
   *  `narrowedCourtsByFixture`). Per fixture rather than per stage since #622:
   *  a knockout stage's quarter-finals, semi-finals and final share one
   *  `stages` row, so "only the final needs the championship court" is not
   *  expressible at stage granularity.
   *  Raw court ids, in `resolveCandidateCourts`'s own order (ruling 1,
   *  candidate-courts.ts) — relabelled to names by `toModelPayload`, exactly
   *  like `settings.courts` and every other court-shaped field.
   *
   *  Omitted, not `[]`, whenever the stage's own tags add nothing beyond the
   *  division's (the common case: most stages have no `required_court_tags`
   *  of their own). Both the model and `structuralCheck` fall back to
   *  `settings.courts` when this key is absent, so most fixtures pay no cost
   *  and `schedule-ai-pack.test.ts`'s golden snapshot (no stage in that
   *  fixture data has its own required tags) stays byte-identical. */
  courts?: string[];
}

export interface PackObstacle {
  court: string;
  from: string;
  to: string;
  label: string;
}

export interface PackEntrant {
  id: string;
  name: string;
  pool: string | null;
  seed: number | null;
}

export interface PackPerson {
  person_id: string;
  entrant_ids: string[];
}

export interface PackOfficial {
  id: string;
  name: string;
  role_keys: string[];
  max_per_day: number | null;
  blackout_dates: string[];
  busy_elsewhere: string[];
  entrant_ids: string[];
}

export interface PackAssignment {
  fixture_id: string;
  scheduled_at: string;
  court_label: string;
}

/** The draft's own row shape (#397). `scheduled_at` is nullable here and nowhere
 *  else: a fixture whose persisted time is an epoch sentinel reaches the model
 *  as UNPLACED rather than as 1970-01-01, which the model would anchor on.
 *  `prior` keeps `PackAssignment` — a prior proposal is by definition placed. */
export interface PackDraftAssignment {
  fixture_id: string;
  scheduled_at: string | null;
  court_label: string;
}

export interface SchedulePack {
  mode: "generate" | "refine" | "repair";
  /**
   * P9.5 — the candidate courts' own opening hours (V367), so the AI draft is
   * CHECKED against them by `verifyConfig` below and the corrective-retry loop
   * can react, instead of proposing a board on a closed court that only the
   * later /validate notices.
   *
   * OMITTED when the org has declared no calendars, which keeps every existing
   * pack byte-identical — the same rule `PackFixture.courts` follows for its
   * per-stage narrowing.
   *
   * The deterministic DRAFT PLACER still does not read these: it builds its
   * config through `toSlotConfig`, which sets no `tz`, and court hours are
   * day-shaped. Giving that call a `tz` would also switch on the whole typed
   * rule block inside `slotFixtures` (`calendar.ts`: day caps, weekday and
   * wall-clock rules), which this path has never honoured — a much wider
   * change than court hours and its own decision. Recorded, not taken.
   */
  courtCalendars?: readonly CourtCalendar[];
  division: { id: string; name: string; sport: string; tz: string };
  /** The ORGANISATION zone (#397, design §2.1). ONE zone governs every temporal
   *  decision in this pack — day boundaries, weekday targets, session hours and
   *  the offset every timestamp below is written in. `division.tz` above is
   *  display metadata and drives nothing. */
  tz: string;
  /** The calendar anchor, built from an instant the caller injected. Without it
   *  "from tomorrow till Friday" has two readings a week apart and nothing
   *  downstream can tell which one happened. */
  clock: Clock;
  /** The days this competition runs, resolved and never absent. `end` is
   *  inclusive — the last instant a fixture may still be occupying. */
  window: { start: string; end: string };
  /** The daily fallback for a division with no `sessionWindows`, as "HH:MM" in
   *  `tz`. */
  sessionHours: { start: string; end: string };
  settings: PackSettings;
  entrants: PackEntrant[];
  people: PackPerson[];
  /** Every person who COULD stand in each movable fixture, including the
   *  advancers behind a null slot (#396). Keyed for every movable fixture, in
   *  `fixtures.movable` order; the source of `Assignment.people` for both the
   *  greedy placer and the verifier, so a draft cannot be legal under a rule
   *  the referee applies differently. */
  participants: Record<string, string[]>;
  /** Movable fixture id → its pool's UUID, for the fixtures that sit in a pool
   *  (#449).
   *
   *  SERVER-SIDE ONLY, like `participants`: `toModelPayload` omits it. The
   *  model schedules by pool LABEL and `PackFixture.pool` stays that label —
   *  the prompts read it, it is a wire shape, and it is what an organiser sees.
   *
   *  It exists because a pool KEY is display metadata ('A', 'B') that is not
   *  unique across divisions, while `Assignment.poolId` and `RuleFixture.poolId`
   *  are what `scopeCoversFixture` and `effectiveRestMinutes` match a stored
   *  rule against — and a stored rule names the UUID, which is what the DB holds
   *  and what the board path has always stamped. Carrying the key across the
   *  engine boundary put the AI path in a second namespace, so whichever one the
   *  organiser authored in, at most ONE path could ever bind the rule.
   *
   *  Keyed for the fixtures in `fixtures.movable` that have a pool, in that
   *  array's order, so a build is byte-identical on a reseed for the same reason
   *  `participants` is. */
  poolIds: Record<string, string>;
  /** C1 gap B — the AI-plan verification twin of `poolIds` just above (#449).
   *  Movable fixture id → its own stage's UUID, for EVERY movable fixture:
   *  unlike `poolIds`, `fixtures.stage_id` is NOT NULL, so this map is total
   *  over `fixtures.movable`.
   *
   *  SERVER-SIDE ONLY, like `poolIds`: `toModelPayload` omits it — the model
   *  has no use for a stage uuid. Exists so `toEngineAssignments` can stamp
   *  `Assignment.stageId` unconditionally, the same way `schedulable` below
   *  and the board path's `toAssignment` already do. See `calendar.ts`'s
   *  round-order pair scan, which groups by `(divisionId, stageId, poolId)`
   *  — omitting `stageId` from that key would let two round-sequence
   *  stages in one division collide (Finding 2 of the round-order design). */
  stageIds: Record<string, string>;
  /** C1 gap B. Movable fixture id → `fixtures.round_no`, ONLY for fixtures
   *  whose stage is a round sequence (league, group, swiss — W3 T3b;
   *  `roundRobinStageIds`) — the SAME `roundRobin` set that gates
   *  `schedulable`'s own `roundNo` below. `fixtures.round_no` is shared
   *  display numbering for EVERY stage kind (bracket rounds, stepladder legs
   *  and swiss rounds all reuse the column — F1's roundRole()/
   *  roundRoleLabel() names every one of them by position, never derived
   *  from this column alone), so forwarding a bracket's or a stepladder's
   *  ungated would recreate the cross-sequence collision the whole
   *  round-order feature exists to prevent (the design doc's own motivating
   *  symptom). Absent key means "not a round sequence, or not movable" —
   *  never round 0.
   *
   *  SERVER-SIDE ONLY, like `poolIds`/`stageIds`: `toModelPayload` omits it.
   *  `PackFixture.round` stays the UNGATED display value the model reads;
   *  this is the gated, verification-only twin `toEngineAssignments` reads
   *  to stamp `Assignment.roundNo`. */
  roundNos: Record<string, number>;
  /** X-SW-31 (rulings 255-256). Movable fixture id -> the round rules of its stage (`roundBarrier`, `roundGapMinutes`,
   *  `roundsPerDayCap`; `roundRobinStageIds`' value), ONLY for a fixture of a stage that has any: a Swiss stage today.
   *  The engine needs these on EVERY row of a sequence and refuses a sequence whose rows disagree (CONFIG_INVALID), so
   *  `toEngineAssignments` and `toSchedulableFixtures` stamp them from here beside `roundNos`. Absent (not `{}`) on a
   *  pack with no such fixture, so the pack of a league or a bracket division is byte-identical to before. A pack
   *  that predates the field simply stamps nothing, which is the start floor it always had.
   *
   *  SERVER-SIDE ONLY, like `roundNos`: `toModelPayload` omits it. */
  roundRules?: Record<string, RoundFields>;
  /** Deterministic preprocessing choices worth telling the organiser about:
   *  stripped bye feeders, same-name person grouping. Rendered at W5 (#400). */
  assumptions: string[];
  /** The organiser's instruction, compiled (#398).
   *
   *  PROMPT MATERIAL, unlike `participants` and `assumptions`: the model must
   *  satisfy the same rules it will be verified against, or a repair round can
   *  never converge on what was actually asked for.
   *
   *  The window a `window` instruction resolved to is deliberately NOT here — it
   *  is `pack.window` above, which the verifier already checks. That is what
   *  keeps every member of this union unit-free (minutes, counts, weekdays,
   *  YYYY-MM-DD, HH:mm) and lets the engine and the pack share one type. */
  parsed: {
    hard: HardConstraint[];
    soft: { note: string; weight: 1 | 2 | 3 }[];
    unparsed: string[];
  };
  fixtures: { movable: PackFixture[]; obstacles: PackObstacle[] };
  draft: PackDraftAssignment[];
  instruction: string;
  prior: { instruction: string; assignments: PackAssignment[] } | null;
  officials: PackOfficial[];
}

export interface AiPlanResult {
  proposal: { fixture_id: string; scheduled_at: string; court_label: string; schedule_locked?: boolean }[];
  unschedulable: { fixture_id: string; reason: string; rule: RuleCode }[];
  warnings: Conflict[]; // non-blocking verifier conflicts
  blocking: Conflict[]; // residual after ≤2 repairs
  diff: { moved: string[]; placed: string[]; unscheduled: string[]; unchanged: string[] };
  explanations: { fixture_id: string; note: string }[];
  constraint_suggestions?: Partial<SchedulingConstraints>;
  summary: string;
  /** W5 (#400): the ARCHITECT's own assumptions — what it assumed while placing.
   *  Produced on every run since v4 and dropped at the response build until now,
   *  so the organiser reviewed a proposal without seeing the reading it was
   *  built on. NOT the resolver's assumptions (stage 1, shown at the preview);
   *  the two arrays are never merged. Always an array, never undefined. */
  assumptions: string[];
  // cost_usd is the provider-reported cost when available, falling back to a
  // derived estimate per round; null only when neither is computable.
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number; cost_usd: number | null };
  /** W6 (#401): how this board reached its final state. `engine: "none"` means
   *  no repair changed it — it verified clean, or repair was attempted and
   *  nothing was adopted. Everything else the solver observed rides alongside,
   *  including the paths where it never ran, because #401 requires the LLM
   *  fallback to be TELEMETRY-VISIBLE rather than merely correct. */
  repair: RepairReport;
}
