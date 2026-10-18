import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant, type Tx } from "@/lib/db";
import {
  advancesNobody,
  EngineError,
  foldMatchWithStoppage,
  forbidsLevelResult,
  isLevelOutcome,
  outcomeOf,
  resolveVoids,
  settleApplies,
  settleOffered,
  summaryOf,
  type EventEnvelope,
  type MatchOutcome,
  type ScoreSummary,
  type StageKind,
} from "@seazn/engine/core";
import { LOCKED_FIXTURE_STATUSES } from "@/lib/fixture-status";
import { LEVEL_RESULT_REASON } from "@/lib/level-result-reason";
import { SETTLE_REFUSAL_REASON } from "@/lib/settle-refusal-reason";
import { resolveModule } from "./registry";
import { loadLineupPair } from "./lineups";
import { hasFrozenCfg, resolveFixtureCfg, stageForfeitAward } from "./fixture-cfg";
import { lockStageSeatsForVoid, releaseFedSeats } from "./fed-seats";
import { feedsNextMatch } from "@/lib/bracket-next-match";
import { doubleWalkoverRefused } from "@/lib/double-walkover-next-match";
import { isCascadeOnlyForfeitReason } from "@/lib/forfeit-phase-refusal";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { HttpError } from "@/lib/errors";
import { getDictionary } from "@/lib/i18n";
import { RULE_ERROR_STATUS, ruleErrorMessage } from "@/lib/rule-errors";
import { formatLineOf } from "./rules-version";
import { log } from "@/server/logger";

// What a caller supplies; persistence stamps id/seq/recordedAt (spec 03 §2 —
// ids/time are injected). `id`/`recordedAt` are accepted for test determinism.
export interface AppendInput {
  type: string;
  payload: unknown;
  recordedBy?: string | null;
  /** Device-link attribution (doc 13 §7): set when the event arrived via a
   *  dl_ token. Rides OUTSIDE the hash-chain canonical. */
  deviceLinkId?: string | null;
  /** W2 — durable idempotency (design §6). The client's retry key, written so
   *  the unique index on (fixture_id, idempotency_key) can REFUSE a second
   *  write of the same tap. Rides OUTSIDE the hash-chain canonical, exactly
   *  like `deviceLinkId`: V226's trigger names its columns explicitly. Null
   *  for the importer, the rebuild paths, and any caller that never retries. */
  idempotencyKey?: string | null;
  voids?: string;
  id?: string;
  recordedAt?: string;
  /** W2c Task 15 (X-SR-7, D14, P-1) — the rules version the SENDER folds under: the two scoring pads send it with
   *  every append (`scorepad/pipeline.ts`'s body builder, the device chrome). A sent value that is not the fixture's
   *  `rules_version` is refused FIXTURE_RULES_CHANGED before anything is written. Absent is never checked: the console
   *  chrome, the americano panel, the withdrawal cascade, finalize, the settle and the importer never send it. */
  rulesVersion?: number;
  /** W2b PF-2 — which server writer is appending. Set ONLY by the withdrawal cascade (`withdrawal.ts`, through
   *  `scoreEvent`'s internal options, never a request field): `reason: "withdrew"` and `core.abandon{expunge:true}`
   *  are cascade-only events, refused from every other writer — the console, a device link, the API, the importer. */
  writer?: CascadeWriter;
}

/** The one writer that may record the cascade-only events (PF-2). */
export type CascadeWriter = "withdrawal_cascade";

export interface AppendResult {
  seq: number;
  event: EventEnvelope;
  state: unknown;
  summary: ScoreSummary;
  outcome: MatchOutcome | null;
  status: string;
  /** The fixtures whose seat this write EMPTIED because it took back a
   *  knockout decision — erased it, or flipped it — (`releaseFedSeats`, owner
   *  ruling 2026-09-23), including any cascade walkover it reset — from the
   *  update's own `returning id`. Empty for every write that moved nobody. Their
   *  public documents changed (a name became a "Winner of …" seat), so
   *  `scoreEvent` publishes them with the fixtures a decision advanced into. */
  released: string[];
  /** W2c Task 15 (X-SR-7) — the fixture's `rules_version` this write was checked against and folded under: every
   *  accepted answer carries it, so an open pad learns of a correction from its next ack. */
  rulesVersion: number;
  /** F9 (R3.5 review) — carried through so `appendEvent` can log an accepted
   *  event AFTER `withTenant` has committed, instead of `appendEventInTx`
   *  logging it itself before the fixtures update, the pg_notify, and the
   *  commit (see that function for why: a throw in any of those, or a
   *  caller retrying a serialization/deadlock error, used to leave a log
   *  line describing a write that never reached the ledger, or describing
   *  it twice for the same seq). The P11 batch importer
   *  (`event-import.ts`) gets this field too on its own `AppendResult`s and
   *  does not use it — it has its own, separate per-fixture logging. */
  sportKey: string;
}

interface FixtureRow {
  id: string;
  division_id: string;
  stage_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: unknown;
  /** V347 — the resolved cfg this fixture was SCORED under; null until its
   *  first event. See `fixture-cfg.ts` for why it exists. */
  config_snapshot: unknown;
  /** W2c (V463) — this match's own format override; resolved last, frozen with the rest at the first event. */
  rules_override: unknown;
  /** W2c (V463) — how many times a correction re-froze this match's format (Task 15: a pad sends the one it loaded). */
  rules_version: number;
  /** W2b D19 — the feed graph: a double walkover needs a next match to send nobody to. */
  winner_to_fixture: string | null;
  loser_to_fixture: string | null;
}
interface StageRow {
  kind: string;
  config: Record<string, unknown> | null;
}
interface DivisionRow {
  config: unknown;
  sport_key: string;
  module_version: string;
}
interface EventRow {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: Date;
  recorded_by: string | null;
  voids_event_id: string | null;
}

// Terminal DB statuses that lock the ledger against further appends. Re-exported
// because the V347 config-snapshot escape hatch must refuse on exactly this
// set — rewriting the cfg a FINALIZED result was computed under is the very
// thing the snapshot exists to prevent, so the two guards may not drift apart.
// The set itself lives in client-safe `lib/fixture-status.ts`, so the public
// live-fixture transport reads the same lock instead of a copy of it.
export { LOCKED_FIXTURE_STATUSES };
const LOCKED = LOCKED_FIXTURE_STATUSES;
/** The shape of `entrants.id` (a Postgres uuid) — the C17/D-R7 winner lookup runs only on it (review N2). */
const ENTRANT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Map the folded ledger onto the fixtures.status enum. Derived from the
// ACTIVE (void-resolved) events, not from event-type transitions: a void can
// erase core.start / core.forfeit / core.abandon / the deciding event, and the
// status must follow the fold or the console dead-ends (v3/09 §2 — the cricket
// "undo made scoring disappear" regression was status=in_play with the fold
// back in the pre phase, so neither the Start button nor the pad rendered).
/** Exported for W2's replay reconstruction (`replay.ts`). A replay must report
 *  the status the ORIGINAL write reported, and deriving that from a second,
 *  hand-written rule is exactly how a read path and a write path drift apart —
 *  the disagreement `fixture-cfg.ts` exists to prevent. One rule, two callers.
 *  Note `fixtureStatusFromFold` alone can never answer "finalized": only this
 *  can, and only because it is told the candidate's TYPE. */
export function nextStatus(
  candidateType: string,
  outcome: MatchOutcome | null,
  active: readonly EventEnvelope[],
  stageKind: string | null,
): string {
  if (candidateType === "core.finalize") return "finalized";
  return fixtureStatusFromFold(outcome, active, stageKind);
}

/**
 * The same rule for a fold with no candidate event — a fixture whose cached
 * status has to be re-derived from a stream that did not change (the V347
 * re-snapshot hatch). Exported so the two can never drift: a hatch that wrote
 * its own status rule would reintroduce exactly the read/write disagreement
 * `fixture-cfg.ts` exists to prevent.
 *
 * `finalized` is deliberately NOT reachable here even when the ledger holds an
 * active `core.finalize`: every caller of this overload has already refused a
 * fixture in `LOCKED_FIXTURE_STATUSES`, so the only way to arrive with a
 * finalize in the stream is that staff reopened the fixture on purpose, and
 * re-deriving it back to `finalized` would silently undo that.
 */
export function fixtureStatusFromFold(
  outcome: MatchOutcome | null,
  active: readonly EventEnvelope[],
  stageKind: string | null,
): string {
  const has = (type: string) => active.some((event) => event.type === type);
  const levelInBracket = outcome !== null && forbidsLevelResult(stageKind) && isLevelOutcome(outcome);
  // W2b D7 (spec §5.4, plan finding 5), in this order; the first rule that matches decides.
  // 1: the organiser's settle decides, even an abandoned match (X-ST-1).
  if (has("core.settle")) return "decided";
  // 2: an abandon that decided nobody stays "abandoned" — the 2026-09-21 "stuck and visible" ruling, and what W2a's
  // recorded-abandon readers, the desk's awaits-settle path and `needs-decision.tsx` key on: no outcome at all, or a
  // level one where a level result is forbidden (a bracket). An abandon WITH a result — a DLS win, a football
  // award-policy leader, or any result in a draw kind (a cricket no-result is 1 point each, CK-AB-2) — falls through
  // and is decided like any other result (ST-G1).
  if (has("core.abandon") && (outcome === null || levelInBracket)) return "abandoned";
  // 3: a level result in a bracket is HELD (ruling 79, X-BR-2): not decided, nobody seated, closed by a settle.
  if (levelInBracket) return "needs_decision";
  // 4: keyed on the EVENT, as before (an award-policy abandon is no forfeit), plus a double walkover, whose legacy
  // chess shape (`boardgame.result{double_forfeit}`) carries no core.forfeit (finding 5).
  if (has("core.forfeit") || advancesNobody(outcome)) return "forfeited";
  // 5: any other result.
  if (outcome !== null) return "decided";
  return has("core.start") ? "in_play" : "scheduled";
}

/** W2b D15 (spec §5.2, finding 15) — sport events whose payload value is RETIRED ON WRITE: a chess forfeit is recorded
 *  through `core.forfeit` now, so `boardgame.result{method: forfeit | double_forfeit}` is refused for every writer. A
 *  stream that already holds one still replays (the engine folds it, BG-DW-1); only a NEW append is judged. Exported so
 *  the organiser-only derivation (organiser-only-events.test.ts, D-O1) subtracts exactly this set and no other. */
export const RETIRED_ON_WRITE_SPORT_EVENTS: Readonly<Record<string, { field: string; values: readonly string[] }>> = {
  "boardgame.result": { field: "method", values: ["forfeit", "double_forfeit"] },
};

/**
 * W2b append guards, ahead of the fold (each refusal aborts the transaction before anything is written):
 *
 * - D15: a retired sport-event value (`RETIRED_ON_WRITE_SPORT_EVENTS`) — INVALID_EVENT, `chess_forfeit_method_retired`.
 * - PF-2: `core.forfeit{reason:"withdrew"}` and `core.abandon{expunge:true}` from any writer but the withdrawal
 *   cascade — INVALID_EVENT, `cascade_only`.
 * - PF-1 (server half): the cascade's `withdrew` over a stored result is admitted only on a HELD row
 *   (`needs_decision`); the engine's admission is stage-blind, and a league draw is a result standings credit —
 *   ALREADY_DECIDED, `withdrew_over_result`.
 * - D19: `core.forfeit{by:"both"}` in a bracket kind on a fixture that feeds no seat (no `winner_to_fixture`, no
 *   `loser_to_fixture` — the feed graph, never a round name) — DOUBLE_WALKOVER_NO_NEXT_MATCH. A final, a stepladder's
 *   last rung, a page playoff final, a third-place match — and (loop-F I-5) a double-elimination grand final with a
 *   bracket reset, whose two edges both feed its own rematch (`feedsNextMatch`). The rule is ONE reading
 *   (`doubleWalkoverRefused`, lib/double-walkover-next-match.ts) that the fixture page also reads, so the console's
 *   forfeit dialog never offers "Neither" where this refuses it (Task 11).
 */
function assertW2bWriteGuards(
  fixture: Pick<FixtureRow, "id" | "status" | "outcome" | "winner_to_fixture" | "loser_to_fixture">,
  stageKind: string | null,
  candidate: Pick<EventEnvelope, "type" | "payload">,
  writer: CascadeWriter | undefined,
): void {
  const payload = (candidate.payload ?? {}) as Record<string, unknown>;
  const retired = RETIRED_ON_WRITE_SPORT_EVENTS[candidate.type];
  if (retired !== undefined && retired.values.includes(payload[retired.field] as string)) {
    throw new EngineError("INVALID_EVENT", "a chess forfeit is recorded as a forfeit, not as a game result", {
      fixtureId: fixture.id,
      reason: "chess_forfeit_method_retired",
      method: payload[retired.field],
    });
  }
  // The cascade-only reasons are ONE list (lib/forfeit-phase-refusal.ts), which the WRONG_PHASE copy also subtracts so
  // it never offers a writer a reason refused here (loop-F R-3).
  const cascadeOnlyForfeit = candidate.type === "core.forfeit" && isCascadeOnlyForfeitReason(payload.reason);
  const withdrew = candidate.type === "core.forfeit" && payload.reason === "withdrew";
  const expunge = candidate.type === "core.abandon" && payload.expunge === true;
  if ((cascadeOnlyForfeit || expunge) && writer !== "withdrawal_cascade") {
    throw new EngineError("INVALID_EVENT", "only a withdrawal records this — withdraw the entrant instead", {
      fixtureId: fixture.id,
      reason: "cascade_only",
    });
  }
  if (withdrew && fixture.outcome !== null && fixture.status !== "needs_decision") {
    throw new EngineError("ALREADY_DECIDED", "this match already has a result", {
      fixtureId: fixture.id,
      reason: "withdrew_over_result",
      status: fixture.status,
    });
  }
  if (candidate.type === "core.forfeit" && payload.by === "both" && doubleWalkoverRefused(stageKind, feedsNextMatch(fixture))) {
    throw new EngineError("DOUBLE_WALKOVER_NO_NEXT_MATCH", "a match with no next match can't be a double walkover", {
      fixtureId: fixture.id,
      stage: stageKind,
    });
  }
}

/** Which door the DECIDING append came through (`result_entered.source`, fix
 *  batch 6b): a device link stamps `deviceLinkId` on its appends (scoring.ts,
 *  from the dl_ bearer door); everything else is the organiser side. */
export type ResultSource = "device_link" | "organiser";

export type FirstResult = { distinctId: string; sportKey: string; status: string; source: ResultSource };

/** The transactional body of an append (spec 03 §5), callable inside a caller's
 *  transaction. `appendEvent` wraps it in `withTenant`; the P11 importer calls
 *  it in a loop so a whole fixture's stream commits or rolls back together.
 *  There is exactly one append path — do not add a second. */
export async function appendEventInTx(
  tx: Tx,
  orgId: string,
  fixtureId: string,
  expectedSeq: number,
  input: AppendInput,
): Promise<{ appended: AppendResult; firstResult: FirstResult | null }> {
  // Loop R2 N-1: a void that may revive what a stored double walkover killed takes the stage lock FIRST — the one lock
  // order is stage, then fixtures (fed-seats.ts `lockStageSeats`). A no-op, and no query, for every other event.
  if (input.type === "core.void") await lockStageSeatsForVoid(tx, fixtureId);
  // Serialise all appends to this fixture (spec 02 §8 — fixture is the write
  // aggregate). The lock is held to commit, so a concurrent appender blocks,
  // then re-reads the committed max seq and 409s.
  await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;

  const [fixture] = await tx<FixtureRow[]>`
    select id, division_id, stage_id, home_entrant_id, away_entrant_id, status, outcome,
           config_snapshot, rules_override, rules_version, winner_to_fixture, loser_to_fixture
    from fixtures where id = ${fixtureId}
  `;
  if (!fixture) {
    throw new EngineError("INVALID_EVENT", `fixture ${fixtureId} not found`, { fixtureId });
  }
  if (LOCKED.has(fixture.status)) {
    throw new EngineError("ALREADY_DECIDED", `fixture ${fixtureId} is ${fixture.status}`, {
      fixtureId,
      status: fixture.status,
    });
  }
  if (!fixture.home_entrant_id || !fixture.away_entrant_id) {
    throw new EngineError("WRONG_PHASE", "fixture has an unassigned entrant (bye/TBD)", {
      fixtureId,
    });
  }

  // W2c Task 15 (Task 2 I-1, orchestrator ruling): the FIRST event of a match freezes the division's LIVE config (the
  // snapshot below). A division or stage format save holds `division-config:<division>` EXCLUSIVE from before its
  // refusal read to its commit (`divisions.ts` patchDivision, `stage-rules.ts` putStageRules); the first freeze takes it
  // SHARED here — after this fixture's lock, before the division read — so the two serialise: the event waits for the
  // save and freezes what it committed, or the save waits for the event and its refusal read sees the stage started.
  // Without it one stage could play two formats. Only a match with nothing frozen asks: a started one reads its own
  // snapshot and never waits on a save. Lock order: division: → stage-seats → fixture: → division-config: (an exclusive
  // holder takes no stage-seats or fixture lock after it; a shared holder takes no division lock after it).
  if (!hasFrozenCfg(fixture.config_snapshot)) {
    await tx`select pg_advisory_xact_lock_shared(hashtext(${"division-config:" + fixture.division_id}))`;
    // Fix round 2 (re-review N-1): the row above was read BEFORE this wait, and a save that held the lock bumped the
    // version of every match whose format it moved (`rules-version.ts` bumpMovedRules) — so the version is re-read
    // now, as the division below is, and the check and the answer use the one that stands. Only the version: the
    // match's own override cannot move meanwhile (its writer needs the `fixture:` lock this append holds).
    const [now] = await tx<{ rules_version: number }[]>`select rules_version from fixtures where id = ${fixtureId}`;
    fixture.rules_version = now!.rules_version;
  }

  const [division] = await tx<DivisionRow[]>`
    select config, sport_key, module_version from divisions where id = ${fixture.division_id}
  `;
  if (!division) {
    throw new EngineError("CONFIG_INVALID", "division not found for fixture", { fixtureId });
  }
  const sportModule = resolveModule(division.sport_key, division.module_version);
  // The fixture's stage kind gates draw finalization (PROMPT-61); its config
  // may carry stage-scoped decider overrides.
  const [stage] = await tx<StageRow[]>`
    select kind, config from stages where id = ${fixture.stage_id}
  `;

  // W2c Task 15 (X-SR-7, D14, P-1): a tap sent under rules this match no longer plays is never applied under the new
  // ones. Asked only when the sender sent a version (the scoring pads; every server writer sends none), and `!==`, not
  // `<`: a version from anywhere else is as wrong as an old one. BEFORE the seq check on purpose — a stale queued tap
  // behind a stale seq would otherwise be a SEQ_CONFLICT, which the pad renegotiates and RESENDS under the new rules.
  // The answer names the rules that stand (the version, and the format line in the server's English: the pad says it
  // in the reader's language off GET /rules).
  if (input.rulesVersion !== undefined && input.rulesVersion !== fixture.rules_version) {
    const format = formatLineOf(
      division.sport_key,
      sportModule,
      resolveFixtureCfg(fixture, division.config, stage, sportModule),
      stage?.kind,
      division.config,
      await getDictionary("en", "public"),
    );
    throw new HttpError(
      RULE_ERROR_STATUS.FIXTURE_RULES_CHANGED,
      ruleErrorMessage("FIXTURE_RULES_CHANGED", { format: format ?? undefined }),
      "FIXTURE_RULES_CHANGED",
      { rules_version: fixture.rules_version, format },
    );
  }

  // Optimistic concurrency: the client's expectedSeq must equal the current
  // ledger tip. Gapless seq is assigned here, under the lock (doc 07 note 3).
  const [{ seq: lastSeq }] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from score_events where fixture_id = ${fixtureId}
  `;
  if (lastSeq !== expectedSeq) {
    throw new EngineError(
      "SEQ_CONFLICT",
      `expected seq ${expectedSeq} but ledger is at ${lastSeq}`,
      { fixtureId, expectedSeq, actualSeq: lastSeq },
    );
  }

  const priorRows = await tx<EventRow[]>`
    select id, seq, type, payload, recorded_at, recorded_by, voids_event_id
    from score_events where fixture_id = ${fixtureId} order by seq
  `;
  const prior: EventEnvelope[] = priorRows.map((r) => ({
    id: r.id,
    fixtureId,
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    recordedAt: r.recorded_at.toISOString(),
    recordedBy: r.recorded_by,
    ...(r.voids_event_id ? { voids: r.voids_event_id } : {}),
  }));

  const candidate: EventEnvelope = {
    id: input.id ?? randomUUID(),
    fixtureId,
    seq: expectedSeq + 1,
    type: input.type,
    payload: input.payload,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    recordedBy: input.recordedBy ?? null,
    ...(input.voids ? { voids: input.voids } : {}),
  };

  const lineups = await loadLineupPair(
    tx,
    fixtureId,
    fixture.home_entrant_id,
    fixture.away_entrant_id,
  );

  // Fold-validate the full stream INCLUDING the candidate. A throwing module
  // (invalid event, already-decided, …) aborts the tx before any insert, so
  // the ledger only ever holds valid events (spec 03 §2 guarantee 2).
  const stream = [...prior, candidate];
  // V347 — the cfg this fixture is SCORED under, frozen the moment it has
  // history worth protecting. Before this, `cfg` was rebuilt LIVE from
  // `division.config` on every call while every READ replayed the whole
  // stream from `init`, so editing a division's config changed the input to
  // every past fold at once: finished fixtures silently rescored, and any
  // cfg-derived refusal started firing on events already in the ledger, with
  // no event to void and no scorer action that recovers it.
  //
  // A fixture with ZERO events deliberately reads LIVE cfg — `lastSeq === 0`
  // below is exactly "nothing recorded yet", and an organiser still setting
  // the division up must have the format they choose apply. See
  // `fixture-cfg.ts` for the full rationale; it is the single reader of the
  // column, shared with `fold.ts` so the two folds cannot drift apart.
  const cfg = resolveFixtureCfg(fixture, division.config, stage, sportModule);
  // Take it on the FIRST event only. The advisory lock above is held to
  // commit, so no concurrent appender can interleave between this decision
  // and the write below — the snapshot is taken exactly once.
  //
  // `cfg != null` is not paranoia: `tx.json(null)` writes a SQL NULL, so a
  // division whose config is a JSON null would stamp `config_snapshot_at`
  // while `config_snapshot` still read as "never frozen" — a row claiming a
  // freeze that did not happen, and a fixture that quietly keeps following
  // live config. Better to leave both columns honestly null.
  const freezeSnapshot = !hasFrozenCfg(fixture.config_snapshot) && lastSeq === 0 && cfg != null;
  // W4a (#425) §3.3 — the strict-on-write seam. A refusal computed from cfg
  // cannot tell "the scorer just typed a period this sport does not have"
  // from "an organiser lowered bestOf after the match was scored". The first
  // is fixable; the second has no event to void. `strictFromSeq` names the
  // ONE event that is not yet in the ledger, so the candidate is validated in
  // full and `prior` — which the ledger already accepted, under the cfg now
  // frozen above — is replayed. `fold.ts` and every other read path pass no
  // options at all.
  // R3.5 Task K — this funnel was entirely silent: every super-over ball,
  // every shoot-out kick and every refusal on both was invisible in
  // production. Wrap ONLY the fold: everything from here to the insert below
  // runs inside `tx`, where a throw aborts the transaction before any write
  // (PROMPT-61, above) — that must keep happening exactly as it does today,
  // so the catch below re-throws unchanged and never touches SQL itself.
  const stageKind = stage?.kind ?? null;
  // W2b — the append guards that need what only the server knows: who is writing, the stored status, the feed graph.
  assertW2bWriteGuards(fixture, stageKind, candidate, input.writer);
  // W2a (spec §5.4.3). The settle and finalize guards read the ledger BEFORE the candidate, so they run ahead of
  // the fold: a sport module refuses a finalize of an undecided fixture itself (WRONG_PHASE) inside the fold, which
  // would otherwise answer first for an abandon with no outcome and for a pending chess tie-break.
  if (candidate.type === "core.settle") {
    // Loop-F addendum 3: the engine's settle precondition is not stage-aware (spec §5.1), and a league, group,
    // swiss or americano draw is a RESULT that standings credit — a settle there would turn it into a win.
    //
    // W2c P-7 / X-AB-5 is the one exception: an ABANDONED match that decided nobody has no result to turn into a win -
    // it stays out of the table and, in a Swiss stage, holds the next round - so the organiser's settle is how it is
    // decided. The offer is `settleOffered` (@seazn/engine/core), the SAME predicate the console's needs-decision block
    // reads, fed from the ledger and the fold (an active core.abandon, no effective outcome, not a withdrawal's expunge),
    // never from the status column or a source: an abandon written by any path qualifies, one that recorded a result
    // (shared points, a leader's win) does not.
    if (!forbidsLevelResult(stageKind)) {
      const before = foldMatchWithStoppage(sportModule, cfg, lineups, prior, { strictFromSeq: candidate.seq });
      const offered = settleOffered(sportModule, stageKind, {
        outcome: outcomeOf(sportModule, before),
        abandoned: resolveVoids(prior).some((e) => e.type === "core.abandon"),
        expunged: before.expunged === true,
        state: before.state,
      });
      if (!offered) {
        throw new EngineError("SETTLE_NOT_APPLICABLE", "only a knockout match is settled — a draw here is a result", {
          fixtureId,
          reason: "not_bracket",
          stage: stageKind,
        });
      }
    }
  }
  // Controller ruling C17, widened by D-R7: no event that names a DECIDER WINNER may advance an entrant who has
  // withdrawn — the organiser's core.settle, and every decider event the sport declares (`deciderTypes`: chess's
  // boardgame.tiebreak), which a scorer may record on a held tie-break. The settle or the decider goes to the remaining
  // entrant; the auto-walkover of a held fixture is W2b's (spec §2.3).
  if (candidate.type === "core.settle" || (sportModule.deciderTypes ?? []).includes(candidate.type)) {
    // W2c D7: who a decider event ADVANCES is the sport's to say — chess's Armageddon records Black and the result, so
    // its payload names no winner and the engine derives one (BG-KO-2). Read the payload's `winner` only for a settle,
    // or for a sport that declares no `deciderWinner`; otherwise this guard would see nobody and wave the withdrawn
    // entrant through.
    const winner =
      candidate.type !== "core.settle" && sportModule.deciderWinner !== undefined
        ? sportModule.deciderWinner(candidate.payload, { home: fixture.home_entrant_id, away: fixture.away_entrant_id })
        : (candidate.payload as { winner?: unknown } | null)?.winner;
    // Review N2: `entrants.id` is a uuid, so a malformed winner never reaches the lookup (Postgres 22P02 → a 500). It
    // names no entrant either way; the fold refuses it below with its own 4xx, as before D-R7.
    if (typeof winner === "string" && ENTRANT_ID_SHAPE.test(winner)) {
      const [w] = await tx<{ status: string }[]>`select status from entrants where id = ${winner}`;
      // Loop-F tidy: the server's ONE departed vocabulary (withdrawn or disqualified), never a restated 'withdrawn' — a
      // disqualified entrant is out of the field as surely. Imported lazily: `usecases/entrants` sits above this file
      // (entrants → stages → … → append-event), and a static edge back up reorders the cycle (fed-seats.ts, M-2).
      const { DEPARTED_STATUSES } = await import("@/server/usecases/entrants");
      if (w !== undefined && DEPARTED_STATUSES.has(w.status)) {
        throw new EngineError("SETTLE_NOT_APPLICABLE", "that entrant has left the field — settle for the remaining entrant", {
          fixtureId,
          reason: SETTLE_REFUSAL_REASON.withdrawn,
          winner,
        });
      }
    }
  }
  // Finding 27 + controller ruling P2-7: finalizing a bracket fixture that still needs a decision would store
  // `finalized` + a level outcome (the shape LEVEL_RESULT_SEATED exists to catch, behind a lock no settle could then
  // open). Refused whenever `settleApplies` holds — a level outcome, an abandon with no outcome, a pending chess
  // tie-break — the same predicate as the console's block (§5.5). A finalize changes no module state, so the ledger
  // without the candidate is exactly the fixture the finalize would lock. Settled ⇒ outcomeOf is a win ⇒ false.
  if (candidate.type === "core.finalize" && forbidsLevelResult(stageKind)) {
    const before = foldMatchWithStoppage(sportModule, cfg, lineups, prior, { strictFromSeq: candidate.seq });
    const facts = {
      outcome: outcomeOf(sportModule, before),
      abandoned: resolveVoids(prior).some((e) => e.type === "core.abandon"),
      state: before.state,
    };
    if (settleApplies(sportModule, facts)) {
      throw new EngineError("LEVEL_RESULT_IN_BRACKET", "settle the match before finalizing — a knockout match can't end level", {
        fixtureId,
        stage: stageKind,
        reason: LEVEL_RESULT_REASON.finalizeUnsettled, // review M-1: its own copy (settle, or record the decider)
      });
    }
  }

  const folded = (() => {
    try {
      // W2c Task 16b: the stage rule's walkover award is offered to the write fold too, so the summary stored below is the
      // one every read of this ledger folds (`fold.ts` offers the same value): a forfeit with nothing played reads the
      // rule's number, one after play the sport's own credit.
      const forfeitAward = stageForfeitAward(stage, sportModule);
      return foldMatchWithStoppage(sportModule, cfg, lineups, stream, {
        strictFromSeq: candidate.seq,
        ...(forfeitAward === undefined ? {} : { forfeitAward }),
      });
    } catch (error) {
      // IDs, types and codes only. The payload carries striker/nonStriker/
      // bowler/person ids and, for some events, free text; persons in this
      // product carry consent flags, so a payload is never a log-safe value
      // (case K5).
      if (EngineError.is(error)) {
        log.warn(
          { fixtureId, eventType: input.type, code: error.code },
          "scoring event refused",
        );
      } else {
        // F10 (R3.5 review) — this catch only instrumented the EngineError
        // (422) case above. A TypeError/RangeError thrown from inside a
        // sport module, or a Zod issue surfacing as a plain Error, used to
        // re-throw with NOTHING written to the log: production saw a bare
        // 500 with no fixtureId, no event type, no seq to chase — strictly
        // worse than the refusal case, which at least names the fixture and
        // the code. Same ID-only-fields posture as the branch above (no
        // `code` — a non-engine error has none); the error itself is
        // untouched, re-thrown exactly as before, just below.
        log.error(
          { fixtureId, eventType: input.type, seq: candidate.seq },
          "scoring event fold crashed",
        );
      }
      throw error;
    }
  })();
  const state = folded.state;
  // W2b PF-1: the headline agrees with the table when a withdrawal was admitted over a held level result.
  const summary = summaryOf(sportModule, folded);
  // W2a finding 1: a settle lives beside module state (outcomeOf).
  const outcome = outcomeOf(sportModule, folded);
  const active = resolveVoids(stream);

  // W2a (spec §5.4.3, ruling 79). In a bracket: a GENERIC draw is refused — generic has no decider, so the scorer
  // enters the winner (GN-KO-1); every other level result is ACCEPTED and held as needs_decision (X-BR-2), closed
  // by the organiser's core.settle. Outside a bracket: a draw the sport refuses is DRAW_NOT_ALLOWED, as before
  // (PROMPT-61) — the throw aborts the tx before insert.
  if (outcome !== null && (outcome as { kind?: string }).kind === "draw") {
    if (forbidsLevelResult(stageKind)) {
      // Controller ruling D-F1: a core.void is exempt, on every generic row. Two ways a void leaves a draw in the
      // fold: it uncovers one stored before W2a (V432 holds that row; voiding its settle returns it to needs_decision),
      // or it MAKES a new one in score mode — a result card with no scores settles from the running tally, so voiding
      // a point under it (H, A, H, card = 2–1; void the second H) re-folds the stored card level. Either way the void
      // is accepted and the row is held (needs_decision), for the organiser to settle or to void again; refusing it
      // would leave a wrong point unremovable.
      if (division.sport_key === "generic" && candidate.type !== "core.void") {
        throw new EngineError("LEVEL_RESULT_IN_BRACKET", "a knockout match can't end level — enter the winner", {
          fixtureId,
          stage: stageKind,
          reason: LEVEL_RESULT_REASON.genericDraw,
        });
      }
    } else if (stage !== undefined && !sportModule.supportsDraws(cfg as never, stage.kind as StageKind)) {
      throw new EngineError(
        "DRAW_NOT_ALLOWED",
        "this stage cannot end level — decide it by extra time or a shootout",
        { fixtureId, stage: stage.kind },
      );
    }
  }

  // Owner ruling 2026-09-23: a write that takes back a decision (a void,
  // whatever it voided) takes back the names that decision advanced into the
  // next fixture — or is refused, 409 NEXT_MATCH_STARTED, when that fixture has
  // already started. Here, after the fold and BEFORE the first write, so a
  // refusal leaves nothing behind. Keyed on who the stored outcome advanced
  // against who the new fold advances — never on the event type — so it covers
  // a decision erased AND one flipped without passing through undecided (fix
  // round 1), and every path that appends goes through this one function, so
  // none can move a decision around it. A no-op unless that changed. See
  // fed-seats.ts for the rules.
  const released = await releaseFedSeats(tx, fixtureId, fixture.outcome, outcome);

  // Same transaction as the event that made it necessary: a crash between the
  // two can never leave a fixture with history and no frozen cfg.
  if (freezeSnapshot) {
    await tx`
      update fixtures
      set config_snapshot = ${tx.json(cfg as never)}, config_snapshot_at = now()
      where id = ${fixtureId}
    `;
  }

  await tx`
    insert into score_events (id, fixture_id, seq, type, payload, recorded_by, recorded_at, voids_event_id, device_link_id, idempotency_key)
    values (${candidate.id}, ${fixtureId}, ${candidate.seq}, ${candidate.type},
            ${tx.json(candidate.payload as never)}, ${candidate.recordedBy},
            ${candidate.recordedAt}, ${candidate.voids ?? null}, ${input.deviceLinkId ?? null},
            ${input.idempotencyKey ?? null})
  `;

  await tx`
    insert into match_states (fixture_id, last_seq, state, summary)
    values (${fixtureId}, ${candidate.seq}, ${tx.json(state as never)}, ${tx.json(summary as never)})
    on conflict (fixture_id) do update set
      last_seq = excluded.last_seq, state = excluded.state,
      summary = excluded.summary, updated_at = now()
  `;

  const status = nextStatus(candidate.type, outcome, active, stageKind);
  // Fire once, on the transition from no-result to a decided result. F9
  // (R3.5 review) — this used to be the trigger for a "fixture decided"
  // `log.info` call right here, before the fixtures update, the pg_notify,
  // and the commit below. Logging now happens in `appendEvent`, AFTER
  // `withTenant` resolves — see there for why. `firstResult` itself stays
  // here: `appendEvent`'s PostHog capture and `event-import.ts`'s own
  // per-fixture handling both still need it from this same computation, so
  // the two can never disagree about when a fixture was decided.
  // W2a (spec §5.4.4): a HELD fixture is not yet a result, and its settle is — so a fixture leaving
  // needs_decision with an outcome fires once more, and entering it fires nothing.
  const firstResult: FirstResult | null =
    (fixture.outcome === null || fixture.status === "needs_decision") && outcome !== null && status !== "needs_decision"
      ? {
          distinctId: candidate.recordedBy ?? `org:${orgId}`,
          sportKey: division.sport_key,
          status,
          source: input.deviceLinkId ? "device_link" : "organiser",
        }
      : null;
  // Also rewrite when a void erased a previously-stored outcome — otherwise
  // fixtures.outcome would go stale against the fold (doc 08 §4 undo).
  if (status !== fixture.status || outcome !== null || fixture.outcome !== null) {
    await tx`
      update fixtures set
        status = ${status},
        outcome = ${outcome === null ? null : tx.json(outcome as never)}
      where id = ${fixtureId}
    `;
  }

  // Delivered to LISTEN'ers on commit (Postgres queues NOTIFY until commit) —
  // the "publish after commit" of spec 03 §5, dependency-free.
  await tx`select pg_notify('fixture_events', ${JSON.stringify({
    fixtureId,
    seq: candidate.seq,
    status,
  })})`;

  return {
    appended: {
      seq: candidate.seq,
      event: candidate,
      state,
      summary,
      outcome,
      status,
      released,
      rulesVersion: fixture.rules_version,
      sportKey: division.sport_key,
    },
    firstResult,
  };
}

/**
 * Append one event to a fixture's ledger (spec 03 §5). Within a tenant tx:
 * advisory-lock the fixture → optimistic seq check (409 on mismatch) → load
 * state + tail events → fold-validate through the pinned module (invalid event
 * never enters the ledger) → insert event (org_id + hash chain filled by
 * triggers) → upsert match_state → write fixtures.outcome+status on decision →
 * NOTIFY after commit.
 *
 * @throws EngineError('SEQ_CONFLICT') on a stale expectedSeq (→ HTTP 409).
 * @throws EngineError(...) from the module on an invalid event (→ 422).
 */
export async function appendEvent(
  orgId: string,
  fixtureId: string,
  expectedSeq: number,
  input: AppendInput,
): Promise<AppendResult> {
  // Activation funnel (feature 1): the first time a fixture yields a result is
  // the "aha" moment. The tx returns whether this append crossed that line;
  // capture happens OUTSIDE the tx (below) so a PostHog flush never touches the
  // write path.
  const { appended, firstResult } = await withTenant(orgId, (tx) =>
    appendEventInTx(tx, orgId, fixtureId, expectedSeq, input),
  );

  // F9 (R3.5 review) — this used to log from INSIDE appendEventInTx, before
  // the fixtures update, the pg_notify, and the commit: a throw in any of
  // those, or a caller retrying a serialization/deadlock error, meant the
  // line described an append that never reached the ledger, or described it
  // twice for the same seq — exactly wrong for the question this logging
  // exists to answer ("was this super over actually recorded?"). `withTenant`
  // (postgres.js `sql.begin`) only resolves once COMMIT has gone through, so
  // everything below can only ever describe a write that is actually in the
  // ledger. IDs, types and counts only (case K5: never a payload value).
  // `phase` is the fold's OWN phase, which is what makes a decider visible:
  // the first accepted line whose phase is "super_over"/"SHOOTOUT" IS the
  // decider entry, deliberately with no separate line.
  log.info(
    {
      fixtureId,
      sportKey: appended.sportKey,
      eventType: appended.event.type,
      seq: appended.seq,
      phase: (appended.state as { phase?: unknown }).phase ?? null,
      status: appended.status,
    },
    "scoring event appended",
  );
  if (firstResult !== null) {
    // `method` is what a support question about a knockout result actually
    // needs: shootout / super_over / boundary_count / extra_time — the
    // difference between "they won" and "they won on penalties". Reuses the
    // SAME `firstResult` the fold computed rather than re-testing outcomes a
    // second time out here, so the two can never disagree about when a
    // fixture was decided.
    log.info(
      {
        fixtureId,
        sportKey: firstResult.sportKey,
        kind: (appended.outcome as { kind?: unknown }).kind ?? null,
        method: (appended.outcome as { method?: unknown }).method ?? null,
      },
      "fixture decided",
    );
  }

  if (firstResult) {
    await captureServer({
      event: EVENTS.RESULT_ENTERED,
      distinctId: firstResult.distinctId,
      orgId,
      properties: {
        sport_key: firstResult.sportKey,
        status: firstResult.status,
        fixture_id: fixtureId,
        source: firstResult.source,
      },
    });
  }
  return appended;
}
