import "server-only";
import { restFloor, type HardConstraint } from "@seazn/engine/scheduling";
import type { ScheduleConfig } from "@/server/api-v1/schemas";
import type {
  Tx,
  ScheduleSettingsOut,
  FixtureLite,
  RoundFields,
  RoundSequenceStages,
} from "./types";
import { loadSettings } from "./settings";

/** The stage kinds `stages/generators.ts` generates as a ROUND ROBIN (`generate()`'s
 *  league/group branch): 1-based rounds, one sequence per stage or per pool.
 *  Read as text by the format matrix's model (tools/matrix product-text.ts,
 *  #879's positional reconcile), so keep it one array literal. */
export const ROUND_ROBIN_STAGE_KINDS: readonly string[] = ["league", "group"];

/** The stage kinds whose `round_no` is a real ROUND SEQUENCE, so scheduling
 *  orders by it (`roundRobinStageIds`, below): the round robins, and swiss
 *  (W3 T3b). */
export const ROUND_SEQUENCE_STAGE_KINDS: readonly string[] = [...ROUND_ROBIN_STAGE_KINDS, "swiss"];

/**
 * Which of a division's stages play a real ROUND SEQUENCE, so their
 * `round_no` is an ordering input to scheduling: `ROUND_SEQUENCE_STAGE_KINDS`
 * (league, group, swiss). The name predates `swiss` joining (W3 T3b,
 * 2026-10-31) and was kept because every placement path imports it; read it
 * as "round-sequence stage ids".
 *
 * `league`/`group` are `stages/generators.ts`'s own round-robin `generate()` branch
 * (a pooled group is one sequence per pool — the order key carries the pool).
 * `swiss` is round-sequenced the same way: a Swiss stage mints every round as
 * a TBD-v-TBD shell at Generate, and round r+1 cannot be paired until round r
 * is complete, so a round-2 board ahead of round 1 is a schedule nobody can
 * play — and with no entrants on the shells, nothing BUT round order keeps
 * the auto pass from laying them down in fixture-ID order (it did, before
 * T3b). The tails of `swiss_playoff`/`swiss_knockout` are separate
 * `page_playoff`/`knockout` stages and stay OUT, as every bracket does: a
 * bracket is ordered by its winner/loser feed edges (`feedDependencies`),
 * not by round number. Everything else (double_elim, stepladder, americano,
 * ladder) stays out too.
 *
 * C1 (2026-08-12 round-order design): `fixtures.round_no` is one shared
 * column populated for EVERY stage kind (a bracket's own round, a swiss
 * round, a stepladder leg — F1 (2026-08-17) names every one of them by
 * position via roundRole()/roundRoleLabel(), never derived from this column
 * alone), so which stages may forward it as a scheduling ORDERING input is
 * not derivable from a `FixtureLite` row alone; this is the one query that
 * resolves it, so `toAssignment` and the schedulable builder can both ask
 * it the SAME question rather than guessing from the row itself. Without
 * this gate, a division that mixes a league stage with a stepladder — the
 * design doc's own motivating symptom — would compare the two stages'
 * independent 1-based round sequences as if they were one. Two stages in
 * this set are still never compared with each other: the order key is
 * `(division, stage, pool)` (`roundRobinSequenceKey`, calendar.ts).
 *
 * WHAT IT ENFORCES is C1's rule, and for a Swiss stage (X-SW-31) one rule more:
 * a later round starts no earlier than an earlier round STARTS (ties legal) -
 * and a SWISS round starts no earlier than the previous round ENDS, plus the
 * division's minimum rest, with at most the per-player daily match cap in
 * rounds on one day (owner rulings 255-256). The second half rides the SAME
 * rows as the first: the value for each stage is its {@link RoundFields}, and
 * every producer that stamps `roundNo` spreads them from this map in the same
 * breath ({@link roundFieldsOf}), so no producer can carry the round and forget
 * the barrier. That matters beyond the rule itself: the engine reads the three
 * fields per row but requires them CONSTANT PER SEQUENCE and refuses a mixed
 * sequence with CONFIG_INVALID (`roundRulesBySequence`), so one producer that
 * forgot would turn every Swiss edit into a 422.
 *
 * Returns a Map (stage id -> fields, `{}` for league/group) rather than the Set
 * it used to: `.has` and `.size` answer as before, and the value is what
 * the Swiss stage's rows carry. `settings` is the division's schedule settings
 * when the caller already holds them; read here when omitted and a Swiss stage
 * needs them (the gap and the cap are division settings).
 */
export async function roundRobinStageIds(
  tx: Tx,
  divisionId: string,
  settings?: Pick<ScheduleSettingsOut, "config">,
): Promise<Map<string, RoundFields>> {
  const rows = await tx<{ id: string; kind: string }[]>`
    select id, kind from stages where division_id = ${divisionId} and kind in ${tx(ROUND_SEQUENCE_STAGE_KINDS)}`;
  // Read only when a stage needs it: a division with no Swiss stage never pays the second query.
  const config =
    rows.some((r) => roundBarrierFor(r.kind) !== undefined) ? (settings ?? (await loadSettings(tx, divisionId))).config : undefined;
  return new Map(rows.map((r) => [r.id, roundFieldsFor(r.kind, config, divisionId)] as const));
}

/**
 * X-SW-31, THE one helper: how a stage kind's round sequence is ordered. A Swiss
 * stage's rounds are separated by an END barrier (round r+1 starts after round
 * r's last board ends: each round seats every player once, so a later round
 * cannot be paired, let alone played, before the earlier one is over); a
 * league's or a group's rounds keep the C1 start floor (absent = "start"),
 * because a round-robin's later boards are drawn up front and may overlap.
 * Read by {@link roundFieldsFor} and nowhere else; a producer never branches on
 * a stage kind itself.
 */
export function roundBarrierFor(stageKind: string): "end" | undefined {
  return stageKind === "swiss" ? "end" : undefined;
}

/**
 * The per-player daily match cap, from the division's DURABLE hard rules: the
 * `max_fixtures_per_day` rules that count each player (or each person)
 * separately (`every_entrant` / `every_person`, which the engine's
 * `entityKeysFor` tallies one counter per entity), the smallest of them; 0 when
 * there is none. The "Max matches per day" box on the division's constraints
 * panel writes a DIVISION-scoped rule, one counter for the whole division (the
 * count of matches that day across everybody), which is a different quantity and
 * is deliberately not read here. A Swiss round seats each player once, so rounds
 * per day IS matches per player per day.
 */
export function perPlayerDailyCap(hard: readonly HardConstraint[] | undefined): number {
  const caps = (hard ?? []).flatMap((h) =>
    h.type === "max_fixtures_per_day" && (h.scope.kind === "every_entrant" || h.scope.kind === "every_person") ? [h.count] : [],
  );
  return caps.length === 0 ? 0 : Math.min(...caps);
}

/**
 * Ruling 256: the fields a round sequence of kind `stageKind` carries in
 * division `divisionId` whose settings are `config`. `{}` for a start-floor kind
 * (the sweep test pins that a league row carries NO key at all, not a zero). For
 * an end-barrier kind: the barrier, the gap (the division's minimum rest, the
 * strictest of the four sources the placer and verifier already take, via the
 * engine's own `restFloor`) and the cap - both 0 when unset, which the engine
 * reads as none. Stamped as numbers on EVERY row of the sequence, 0 included, so
 * the rows agree.
 */
export function roundFieldsFor(
  stageKind: string,
  config: Pick<ScheduleConfig, "perEntrantMinRest" | "gapMinutes" | "matchMinutes" | "constraints"> | undefined,
  divisionId: string,
): RoundFields {
  const barrier = roundBarrierFor(stageKind);
  if (barrier === undefined) return {};
  const c = config?.constraints;
  const rest =
    config === undefined
      ? 0
      : restFloor(
          {
            perEntrantMinRest: config.perEntrantMinRest,
            gapMinutes: config.gapMinutes,
            matchMinutes: config.matchMinutes,
            ...(c !== undefined
              ? {
                  constraints: {
                    ...(c.restMin !== undefined ? { restMin: c.restMin } : {}),
                    ...(c.restByGroup !== undefined ? { restByGroup: c.restByGroup } : {}),
                    noBackToBack: c.noBackToBack,
                  },
                }
              : {}),
          },
          { divisionId },
        ).minutes;
  return { roundBarrier: barrier, roundGapMinutes: rest, roundsPerDayCap: perPlayerDailyCap(c?.hard) };
}

/** A round-sequence stage's rules alone (`{}` for a stage outside every sequence or a start-floor kind): what a packed
 *  (serialised) producer stores per fixture, since it cannot hold the Map. */
export function roundRulesOf(stages: RoundSequenceStages | undefined, stageId: string): RoundFields {
  return stages instanceof Map ? (stages.get(stageId) ?? {}) : {};
}

/**
 * THE seam every producer of a scheduling row reads: `{ roundNo, ...barrier fields }` for a row of a round-sequence
 * stage, `{}` for a row of any other (a bracket's `round_no` is display only), and `{}` when no stages were passed
 * (round order inert, as before). A producer spreads this and nothing else, so the round and its rules travel
 * together; the sweep test (schedule-swiss-round-barrier.test.ts) judges what each producer actually emitted.
 */
export function roundFieldsOf(
  stages: RoundSequenceStages | undefined,
  row: { stage_id: string; round_no: number },
): { roundNo?: number } & RoundFields {
  if (stages === undefined || !stages.has(row.stage_id)) return {};
  return { roundNo: row.round_no, ...roundRulesOf(stages, row.stage_id) };
}

/** C1 fix-loop (G2/3rd instance). The same "sequence" identity `calendar.ts`'s
 *  round-order pair scan groups by — `(divisionId, stageId, poolId)`, `??
 *  ""`-normalized — mirrored HERE rather than imported, because this is a
 *  caller-side SELECTION question (which rows belong with the moved
 *  fixture(s) for THIS gate call), not a comparison rule; `calendar.ts`'s own
 *  logic is untouched. Every caller of `roundRobinSequenceSiblings` below
 *  must build its `keys` set with this same function, or the two silently
 *  drift the way `poolId`-only once did.
 *
 *  EXPORTED (C1 final-review, 4th instance of this exact bug class):
 *  `competition-schedule-apply.ts`'s joint per-division loop is a THIRD
 *  caller with the identical shape (a caller-scoped `mine`/`proposed` subset
 *  checked pairwise, an `untouched` sibling pool outside it) — reusing this
 *  function rather than re-deriving the key locally is deliberate, because a
 *  forked key is this codebase's own recurring bug (see the drift warning
 *  above, now three call sites strong). */
export function roundRobinSequenceKey(f: Pick<FixtureLite, "division_id" | "stage_id" | "pool_id">): string {
  return `${f.division_id}|${f.stage_id}|${f.pool_id ?? ""}`;
}

/** Already-placed fixtures sharing one of `keys`' round-robin sequence
 *  identity, excluding `exclude` (the fixture(s) a caller already lists
 *  explicitly in its own `assignments`/`proposed`).
 *
 *  This is the fix for `moveFixture`, `applySchedule`'s partial-apply gate,
 *  and (C1 final-review) `applyCompetitionSchedule`'s own per-division loop:
 *  all three compare their checked set PAIRWISE for round order
 *  (`validateAssignments`, scoped to its `assignments` parameter alone by
 *  design — see its own comment on the grouping key), and the checked side
 *  used to be only the fixture(s) a caller explicitly named. A fixture
 *  sitting only in `existing`/`untouched` can never be paired against
 *  anything, so a one- or few-fixture write could never detect a
 *  round-order violation against an untouched, already-placed round-robin
 *  sibling.
 *
 *  Every call site must pull this SAME result into its checked set on BOTH
 *  sides of its delta comparison (the current-position side and the
 *  proposed side) — the set composition has to be identical on both sides or
 *  the write gate reads every pre-existing violation among the siblings as
 *  newly introduced and blocks a move that never touched them (see each call
 *  site's own comment). `keys` empty (a move in no round sequence) short-circuits
 *  to no widening at all, matching prior behaviour exactly. */
export function roundRobinSequenceSiblings(
  all: readonly FixtureLite[],
  keys: ReadonlySet<string>,
  exclude: ReadonlySet<string>,
): FixtureLite[] {
  if (keys.size === 0) return [];
  return all.filter(
    (f) =>
      !exclude.has(f.id) &&
      f.scheduled_at !== null &&
      f.court_id !== null &&
      keys.has(roundRobinSequenceKey(f)),
  );
}
