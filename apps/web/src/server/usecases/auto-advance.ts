import "server-only";
// Swiss auto-advance (spec docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md), plan Task 4: the two per-stage
// switches and the division's read of its auto actions.
//
//   `setStageAutoAdvance`      `PUT /stages/{id}/auto-advance` `{ autoPair?, autoConfirmHandoff? }` (§4.1). `autoPair` lives
//                              on a Swiss stage; `autoConfirmHandoff` on the TARGET stage, the one whose
//                              `progression.timing` is "setup". An ON where the switch can never act is refused by name
//                              (`autoAdvanceSwitchesFor`, the one rule); an OFF never is. Its own door, not PATCH /stages:
//                              the switches flip mid-event, after the stage has started (plan P1).
//   `listDivisionAutoActions`  `GET /divisions/{id}/auto-advance` (§4.6): every live row of the division, and each done row
//                              for AUTO_ADVANCE_DONE_VISIBLE_MS after it was done, newest first.
//
// A switch that MOVES appends `stage_auto_advance_switched { stage_id, key, on }` naming the person (actor_id). It is a
// history marker, not a change to the board: divisions.seq is not bumped (plan D7). The write merges server-side
// (`config || jsonb`, a literal-key merge the table-writers source scan can read), never a spread of a read: a key another
// writer committed while this one waited on the row survives.
//
// Plan Task 5 adds the arming (§4.2-§4.4):
//   `rearmAutoActions`         re-derives a stage's live rows from the facts in the DB, inside the caller's transaction.
//   `rearmAfterCommit`         the same in its own transaction, after the change that triggered it committed; never throws.
//   `rearmFixtureStageAfterCommit`  the same for the stage of a fixture (an abandon, which reaches no `onDecided`).
// Every fact-changing path calls one of them: a decide, void or correction (scoring.ts `onDecided`), an abandon
// (`scoreEvent`), a draft (stages.ts `computeSeedProposal`), a switch (`setStageAutoAdvance`) and an unfreeze (history.ts
// `setDivisionLocks`).
//
// Plan Task 6 adds a person's hand on the clock (§4.2, §4.6, §5.4, §5.13, D22):
//   `retireReachedAutoActions` a manual Pair (stages.ts `generateStageFixturesTx`), Complete (`completeStage`, inside the
//                              completion's transaction) or Confirm (`confirmSeedProposal`) retires the row whose target it
//                              reached, in its own transaction; each then calls `rearmAfterCommit` for the NEXT target (a
//                              Pair through `afterGenerateCommit`; Add a round too, swiss-rounds-admin.ts).
//   `recordAutoSkip`           the sticky skip of one target, `cancelled {reason: "skip", by}`.
//   `recordPullBackSkip`       an Unpair (stages.ts `unpairSwissRound`) or an Undo of a Pair (history.ts `stepWrite`) of an
//                              auto-pair stage records that skip, so the clock never re-pairs a round pulled back on purpose.
//   `skipAutoAction`           `POST /stages/{id}/auto-advance/skip` `{ kind }`; confirm is never skippable.
import type postgres from "postgres";
import {
  AUTO_ADVANCE_DONE_VISIBLE_MS,
  LIVE_AUTO_ACTION_STATES,
  autoAdvanceSwitchesFor,
  deriveConfirmAction,
  deriveSourceAction,
  skipKey,
  type AutoActionKind,
  type CancelReason,
  type LiveAutoActionState,
  type SourceActionKind,
  type SourceFixtureFact,
} from "@/lib/auto-advance";
import { isSwissBoardSeated } from "@/lib/swiss-shell";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AutoActionView, StageAutoAdvanceOut, StageAutoAdvancePatch } from "@/server/api-v1/schemas";
import { resolveSettleMs } from "@/server/auto-advance/settle";
import { appendDivisionEvent } from "@/server/engine-db/competition";
import { log } from "@/server/logger";
import { DECIDED } from "./stages";

type Tx = postgres.TransactionSql;

export const STAGE_AUTO_ADVANCE_SWITCHED = "stage_auto_advance_switched";

const SWITCH_KEYS = ["autoPair", "autoConfirmHandoff"] as const;
type SwitchKey = (typeof SWITCH_KEYS)[number];

const REFUSAL: Record<SwitchKey, { code: string; message: string }> = {
  autoPair: { code: "AUTO_PAIR_NOT_SWISS", message: "Automatic pairing is only for a Swiss stage." },
  autoConfirmHandoff: {
    code: "AUTO_CONFIRM_NO_HANDOFF",
    message: "Automatic confirmation is only for a stage seeded from the stage before it (a seed proposal).",
  },
};

interface StageRow {
  id: string;
  division_id: string;
  kind: string;
  progression: unknown;
  config: Record<string, unknown> | null;
}

/** A stage_auto_actions row as `ACTION_COLUMNS` selects it. */
export interface AutoActionRow {
  id: string;
  stage_id: string;
  kind: AutoActionView["kind"];
  state: AutoActionView["state"];
  target_round: number | null;
  target_proposal_id: string | null;
  due_at: Date | null;
  done_at: Date | null;
  blocked_code: string | null;
  detail: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  updated_at: Date;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The API's view of one row: camel-cased, the proposal named `proposalId`, timestamps as ISO strings. */
export function toAutoActionView(row: AutoActionRow): AutoActionView {
  return {
    id: row.id,
    stageId: row.stage_id,
    kind: row.kind,
    state: row.state,
    targetRound: row.target_round,
    proposalId: row.target_proposal_id,
    dueAt: iso(row.due_at),
    doneAt: iso(row.done_at),
    blockedCode: row.blocked_code,
    detail: row.detail,
    result: row.result,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The rows a person is shown: live, or done within the window. `scope` narrows to a division or one stage. */
async function visibleActions(tx: Tx, scope: { divisionId: string } | { stageId: string }): Promise<AutoActionView[]> {
  const where = "divisionId" in scope ? tx`division_id = ${scope.divisionId}` : tx`stage_id = ${scope.stageId}`;
  const rows = await tx<AutoActionRow[]>`
    select id, stage_id, kind, state, target_round, target_proposal_id, due_at, done_at, blocked_code, detail, result, updated_at
      from stage_auto_actions
     where ${where}
       and (state in ${tx([...LIVE_AUTO_ACTION_STATES])}
            or (state = 'done' and done_at > now() - make_interval(secs => ${AUTO_ADVANCE_DONE_VISIBLE_MS / 1000}::float8)))
     order by updated_at desc, id`;
  return rows.map(toAutoActionView);
}

const switchesOf = (config: Record<string, unknown> | null): Record<SwitchKey, boolean> => ({
  autoPair: config?.autoPair === true,
  autoConfirmHandoff: config?.autoConfirmHandoff === true,
});

export async function setStageAutoAdvance(auth: AuthCtx, stageId: string, patch: StageAutoAdvancePatch): Promise<StageAutoAdvanceOut> {
  const { out, alarms } = await withTenant(auth.orgId, async (tx) => {
    const read = async () => {
      const [row] = await tx<StageRow[]>`select id, division_id, kind, progression, config from stages where id = ${stageId}`;
      return row;
    };
    const first = await read();
    if (!first) throw new HttpError(404, "stage not found");
    // The division lock orders this write against the Format tool's Save (which recreates the stage graph) and the
    // arming that reads the switch. The re-read is what the refusal and the "did it move" answer are judged on.
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + first.division_id}))`;
    const stage = await read();
    if (!stage) throw new HttpError(404, "stage not found");

    // An ON where the switch can never act is refused whole, before anything is written. An OFF never is.
    const can = autoAdvanceSwitchesFor(stage);
    for (const key of SWITCH_KEYS) {
      if (patch[key] === true && !can[key]) throw new HttpError(422, REFUSAL[key].message, REFUSAL[key].code);
    }

    const before = switchesOf(stage.config);
    const moved = SWITCH_KEYS.filter((key) => patch[key] !== undefined && patch[key] !== before[key]);
    const after: Record<SwitchKey, boolean> = { ...before };
    for (const key of moved) after[key] = patch[key]!;
    if (moved.length > 0) {
      // A literal-key merge: an undefined key is dropped by the JSON serialiser, so only the keys that moved reach it.
      const autoPair = moved.includes("autoPair") ? after.autoPair : undefined;
      const autoConfirmHandoff = moved.includes("autoConfirmHandoff") ? after.autoConfirmHandoff : undefined;
      await tx`update stages set config = config || ${tx.json({ autoPair, autoConfirmHandoff } as never)} where id = ${stageId}`;
      for (const key of moved) {
        await appendDivisionEvent(tx, stage.division_id, STAGE_AUTO_ADVANCE_SWITCHED, { stage_id: stageId, key, on: after[key] }, auth.userId);
      }
    }
    // Arm in the same transaction (§4.2: "when either switch is turned on, so an already-complete round arms
    // immediately"): an ON commits with the row it arms, an OFF with the rows it cancels, and the answer shows them. No
    // restart: a switch is not a change to the facts, so a pending clock keeps its due time (a same-value call is idle).
    const alarms = await rearmAutoActions(tx, stageId, { restartPending: false });
    return { out: { ...after, actions: await visibleActions(tx, { stageId }) }, alarms };
  });
  await publishAutoActionAlarms(alarms);
  return out;
}

export async function listDivisionAutoActions(auth: AuthCtx, divisionId: string): Promise<AutoActionView[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ id: string }[]>`select id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return visibleActions(tx, { divisionId });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Arming (plan Task 5; spec §4.2-§4.4)
// ---------------------------------------------------------------------------------------------------------------------

/** A row this call armed (wrote a fresh `due_at` on): the firer is to be woken for it at `dueAt`. */
export interface ArmedAlarm {
  rowId: string;
  stageId: string;
  dueAt: Date;
}

/** The transport that wakes the firer. A no-op until plan Task 10 makes server/auto-advance/qstash.ts's publish the
 *  default; until then the sweep (Task 9) is the only waker, so an armed row is late, never lost. */
export type AlarmPublisher = (alarms: readonly ArmedAlarm[]) => Promise<void>;
const noAlarmTransport: AlarmPublisher = async () => {};

/**
 * Wakes the firer for armed rows. Called AFTER the arming transaction committed (a draft, a switch, a result), so an
 * alarm never names a row that rolled back. NEVER THROWS: the change it follows already stands, and a failed publish
 * costs only latency (the sweep re-wakes the row), so it must never turn a committed draft or switch into a 500. A
 * failure is logged as `auto_advance_alarm_publish_failed` and swallowed. Nothing armed, nothing sent.
 */
export async function publishAutoActionAlarms(alarms: readonly ArmedAlarm[], publish: AlarmPublisher = noAlarmTransport): Promise<void> {
  if (alarms.length === 0) return;
  try {
    await publish(alarms);
  } catch (err) {
    log.error({ err, rowIds: alarms.map((a) => a.rowId), event: "auto_advance_alarm_publish_failed" }, "auto_advance_alarm_publish_failed");
  }
}

interface ArmStage {
  id: string;
  org_id: string;
  division_id: string;
  kind: string;
  status: string;
  config: Record<string, unknown> | null;
  progression: unknown;
  at: Date;
  has_live: boolean;
}

interface LiveRow {
  id: string;
  kind: AutoActionKind;
  state: LiveAutoActionState;
  target_round: number | null;
  target_proposal_id: string | null;
  blocked_code: string | null;
  detail: Record<string, unknown> | null;
  leased: boolean;
}

/** What one kind wants, after the derivation: nothing live, or one row in one state on one target. */
type Want =
  | { state: "none" }
  | { state: "waiting" | "pending" | "paused" | "blocked"; round: number | null; proposalId: string | null; code: string | null; detail: Record<string, unknown> | null };

interface ArmCtx {
  tx: Tx;
  stage: ArmStage;
  settleMs: number;
  restartPending: boolean;
  /** D1: a retiring row whose target a person already reached (round seated, stage complete, proposal confirmed). */
  observablyDone: (row: LiveRow) => Promise<boolean>;
}

/** A block the derivation wrote carries `detail.derived: true`; a block the FIRER writes (Task 8: SCHEDULE_LOCKED,
 *  AUTO_ADVANCE_FAILED, a refusal) never does. Only a derived block is re-derived on every call: a fire's block is the
 *  firer's verdict, and moves only on a change that restarts the clock (a result, a draft, an unfreeze). */
const isDerivedBlock = (row: LiveRow) => row.state === "blocked" && row.detail?.derived === true;

/** The one sticky cancel reason (§4.2): a `cancelled` row whose `result.reason` is this is never re-armed for its target. */
const SKIP_REASON = "skip" satisfies CancelReason;

/** D1: the row's target was reached by a person (or a path that is not the clock): `done {by: "person"}`. */
async function markDoneByPerson(tx: Tx, rowId: string, at: Date): Promise<void> {
  await tx`update stage_auto_actions set state = 'done', done_at = ${at}, result = ${tx.json({ by: "person" })}, updated_at = ${at}
            where id = ${rowId}`;
}

/**
 * D1: whether a live row's target is already reached — its round has a seated board (`pair_round`), its stage is complete
 * (`complete_stage`), its proposal is confirmed (`confirm_handoff`). The one predicate both the arming's retirement and a
 * manual action's (`retireReachedAutoActions`) read.
 */
function targetReached(
  tx: Tx,
  stageStatus: string,
  readFixtures: () => Promise<readonly Pick<SourceFixtureFact, "round_no" | "home_entrant_id" | "away_entrant_id" | "outcome">[]>,
) {
  return async (row: Pick<LiveRow, "kind" | "target_round" | "target_proposal_id">): Promise<boolean> => {
    if (row.kind === "pair_round") return (await readFixtures()).some((f) => f.round_no === row.target_round && isSwissBoardSeated(f));
    if (row.kind === "complete_stage") return stageStatus === "complete";
    const [p] = await tx<{ status: string }[]>`select status from stage_seed_proposals where id = ${row.target_proposal_id}`;
    return p?.status === "confirmed";
  };
}

async function retire(c: ArmCtx, row: LiveRow, reason: Exclude<CancelReason, "skip">): Promise<void> {
  const at = c.stage.at;
  if (reason === "superseded" && (await c.observablyDone(row))) {
    await markDoneByPerson(c.tx, row.id, at);
    return;
  }
  await c.tx`update stage_auto_actions set state = 'cancelled', result = ${c.tx.json({ reason })}, updated_at = ${at} where id = ${row.id}`;
}

/** Brings one kind's live row to `want`. Answers the alarm when this call wrote a fresh `due_at`. */
async function settleKind(c: ArmCtx, kind: AutoActionKind, live: LiveRow | undefined, want: Want): Promise<ArmedAlarm | null> {
  const { tx, stage } = c;
  const at = stage.at;
  // D2: a firer holds the row. Its fire decides what happens next; a re-derive under it would race the fire.
  if (live?.leased) return null;
  if (want.state === "none") {
    if (live) await retire(c, live, "superseded");
    return null;
  }
  if (live && (live.target_round !== want.round || live.target_proposal_id !== want.proposalId)) {
    // A person's hold follows the proposal across a re-draft (plan Task 11): the hold is on the hand-off, not on one row
    // of the proposals table, so it keeps its own release time (D9) rather than a fresh settle.
    if (want.state === "paused" && live.state === "paused") {
      await tx`update stage_auto_actions set target_proposal_id = ${want.proposalId}, updated_at = ${at} where id = ${live.id}`;
      return null;
    }
    await retire(c, live, "superseded");
    live = undefined;
  }
  const dueAt = new Date(at.getTime() + c.settleMs);
  if (!live) {
    // `paused` is derived only off a live paused row (deriveConfirmAction's livePaused), so a hold with no row to keep
    // cannot be asked for. A guard rather than a silent insert: a paused row needs a hold's release time, not a settle.
    if (want.state === "paused") throw new Error(`rearmAutoActions: a paused ${kind} row was derived for stage ${stage.id} with no live row to keep`);
    const [row] = await tx<{ id: string }[]>`
      insert into stage_auto_actions
        (org_id, division_id, stage_id, kind, target_round, target_proposal_id, state, due_at, blocked_code, detail, created_at, updated_at)
      values (${stage.org_id}, ${stage.division_id}, ${stage.id}, ${kind}, ${want.round}, ${want.proposalId}, ${want.state},
              ${want.state === "pending" ? dueAt : null}, ${want.code}, ${want.detail === null ? null : tx.json(want.detail as never)}, ${at}, ${at})
      returning id`;
    return want.state === "pending" ? { rowId: row!.id, stageId: stage.id, dueAt } : null;
  }
  // Same target. A fire's block stands unless this change restarts the clock.
  if (live.state === "blocked" && !isDerivedBlock(live) && !c.restartPending) return null;
  switch (want.state) {
    case "paused":
      return null;
    case "pending":
      // A change to the facts restarts the window (§5.2); a call that changed nothing (a switch, the sweep) keeps it.
      if (live.state === "pending" && !c.restartPending) return null;
      await tx`update stage_auto_actions
                  set state = 'pending', due_at = ${dueAt}, attempts = 0, lease_until = null, blocked_code = null, detail = null,
                      updated_at = ${at}
                where id = ${live.id}`;
      return { rowId: live.id, stageId: stage.id, dueAt };
    case "waiting":
    case "blocked": {
      // Written only when it moves, so `updated_at` (the banner's order) is the time the row last changed.
      const detail = want.detail === null ? null : tx.json(want.detail as never);
      await tx`update stage_auto_actions
                  set state = ${want.state}, due_at = null, attempts = 0, lease_until = null, blocked_code = ${want.code},
                      detail = ${detail}, updated_at = ${at}
                where id = ${live.id}
                  and (state, blocked_code, detail) is distinct from (${want.state}::text, ${want.code}::text, ${detail}::jsonb)`;
      return null;
    }
  }
}

/**
 * Re-derives a stage's live auto rows from the facts in the DB (§4.2-§4.4), inside the caller's transaction. Answers
 * the alarms for the rows it armed; the caller publishes them after its commit (`publishAutoActionAlarms`).
 *
 * Arms only where a switch is ON (the stored flag) AND can act there (`autoAdvanceSwitchesFor`): the create door and
 * the Format tool's Save take StageConfig whole, so a flag can be stored on a stage the PUT would refuse it for. A stage
 * with neither pays one read. A switch that is off cancels its kind's live rows (`switch_off`, not sticky).
 *
 * `restartPending` (default true): a change to the facts restarts a pending row's clock and re-derives a fire's block.
 * A call that changed no fact (the switch itself, the sweep) passes false and keeps both.
 *
 * Lock order: `auto-advance:<stageId>` only. A caller holding the division lock takes it first (the switch, a draft);
 * nothing here takes the division lock.
 */
export async function rearmAutoActions(tx: Tx, stageId: string, opts: { restartPending?: boolean } = {}): Promise<ArmedAlarm[]> {
  // Serialises two arms of one stage (a result and a draft, two results): without it the second reads no row, inserts
  // its own, waits on the first's uncommitted row in the one-live-row index, and fails 23505 once that commits.
  await tx`select pg_advisory_xact_lock(hashtext(${"auto-advance:" + stageId}))`;
  // `clock_timestamp()`, read once after the lock: `now()` is the transaction's start, stale by however long the lock
  // and the caller's own work took. Every write of this call stamps it, so `due_at - updated_at` is exactly the settle,
  // and a lease is judged against it too.
  const [stage] = await tx<ArmStage[]>`
    select s.id, s.org_id, s.division_id, s.kind, s.status, s.config, s.progression, clock_timestamp() as at,
           exists (select 1 from stage_auto_actions a where a.stage_id = s.id and a.state in ${tx([...LIVE_AUTO_ACTION_STATES])}) as has_live
      from stages s where s.id = ${stageId}`;
  if (!stage) return [];
  const can = autoAdvanceSwitchesFor(stage);
  const sourceOn = stage.config?.autoPair === true && can.autoPair;
  const confirmOn = stage.config?.autoConfirmHandoff === true && can.autoConfirmHandoff;
  if (!sourceOn && !confirmOn && !stage.has_live) return [];

  const liveRows = await tx<LiveRow[]>`
    select id, kind, state, target_round, target_proposal_id, blocked_code, detail, coalesce(lease_until > ${stage.at}, false) as leased
      from stage_auto_actions where stage_id = ${stageId} and state in ${tx([...LIVE_AUTO_ACTION_STATES])}`;
  const liveOf = (kind: AutoActionKind) => liveRows.find((r) => r.kind === kind);

  let fixtures: SourceFixtureFact[] | null = null;
  const readFixtures = async (): Promise<SourceFixtureFact[]> => {
    if (fixtures !== null) return fixtures;
    const rows = await tx<Omit<SourceFixtureFact, "decided">[]>`
      select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, outcome, ext_key, status
        from fixtures where stage_id = ${stageId}`;
    fixtures = rows.map((f) => ({ ...f, decided: DECIDED.has(f.status) }));
    return fixtures;
  };
  const c: ArmCtx = {
    tx,
    stage,
    settleMs: resolveSettleMs(),
    restartPending: opts.restartPending ?? true,
    observablyDone: targetReached(tx, stage.status, readFixtures),
  };
  const alarms: ArmedAlarm[] = [];
  const keep = (a: ArmedAlarm | null) => {
    if (a) alarms.push(a);
  };

  // The source half: pair the next round, or complete the stage after the last one.
  const sourceKinds: readonly SourceActionKind[] = ["pair_round", "complete_stage"];
  if (!sourceOn) {
    for (const kind of sourceKinds) {
      const live = liveOf(kind);
      if (live && !live.leased) await retire(c, live, "switch_off");
    }
  } else {
    // Only a skip is sticky (§4.2): a switch-off or a superseded row of the same target never stops it re-arming.
    const skips = await tx<{ kind: SourceActionKind; target_round: number }[]>`
      select kind, target_round from stage_auto_actions
       where stage_id = ${stageId} and kind in ${tx([...sourceKinds])} and state = 'cancelled' and result ->> 'reason' = ${SKIP_REASON}`;
    const derived = deriveSourceAction({
      stageStatus: stage.status,
      fixtures: await readFixtures(),
      skipped: new Set(skips.map((s) => skipKey(s.kind, s.target_round))),
    });
    for (const kind of sourceKinds) {
      const want: Want =
        derived.state === "none" || derived.kind !== kind
          ? { state: "none" }
          : derived.state === "waiting"
            ? { state: "waiting", round: derived.round, proposalId: null, code: null, detail: { openBoards: derived.openBoards } }
            : derived.state === "blocked"
              ? { state: "blocked", round: derived.round, proposalId: null, code: derived.code, detail: { derived: true, boards: derived.boards } }
              : { state: "pending", round: derived.round, proposalId: null, code: null, detail: null };
      keep(await settleKind(c, kind, liveOf(kind), want));
    }
  }

  // The confirm half, on the TARGET stage: confirm the hand-off proposal.
  const confirmLive = liveOf("confirm_handoff");
  if (!confirmOn) {
    if (confirmLive && !confirmLive.leased) await retire(c, confirmLive, "switch_off");
  } else {
    const [latest] = await tx<{ id: string; status: "draft" | "confirmed" | "stale"; computed: { ties?: unknown } | null }[]>`
      select id, status, computed from stage_seed_proposals where stage_id = ${stageId} order by created_at desc, id desc limit 1`;
    const ties = latest?.computed?.ties;
    if (latest && !Array.isArray(ties)) {
      // computeSeedProposal always writes `ties` (an array, maybe empty). A proposal without one cannot be judged for a
      // tie, and arming it would confirm what may be an unresolved tie: refuse by name instead.
      throw new Error(`rearmAutoActions: seed proposal ${latest.id} has no computed.ties array`);
    }
    const derived = deriveConfirmAction({
      latest: latest ? { id: latest.id, status: latest.status, tieCount: (ties as unknown[]).length } : null,
      livePaused: confirmLive?.state === "paused",
    });
    const want: Want =
      derived.state === "none"
        ? { state: "none" }
        : derived.state === "blocked"
          ? { state: "blocked", round: null, proposalId: derived.proposalId, code: derived.code, detail: { derived: true } }
          : { state: derived.state, round: null, proposalId: derived.proposalId, code: null, detail: null };
    keep(await settleKind(c, "confirm_handoff", confirmLive, want));
  }
  return alarms;
}

/**
 * `rearmAutoActions` in its own transaction, AFTER the change that triggered it committed (a result, an unfreeze).
 * Never throws: the change it follows already stands, and a failed arming is the sweep's to repair (Task 9), so a
 * failure is logged as `auto_advance_rearm_failed` and swallowed. Publishes the alarms once its transaction commits.
 */
export async function rearmAfterCommit(orgId: string, stageId: string, opts: { restartPending?: boolean } = {}): Promise<void> {
  try {
    const alarms = await withTenant(orgId, (tx) => rearmAutoActions(tx, stageId, opts));
    await publishAutoActionAlarms(alarms);
  } catch (err) {
    log.error({ err, orgId, stageId, event: "auto_advance_rearm_failed" }, "auto_advance_rearm_failed");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// A person's hand on the clock (plan Task 6; spec §4.2, §4.6, §5.4, §5.13, D22)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A manual Pair, Complete or Confirm retires, IN ITS OWN TRANSACTION, every live row of the stage whose target it reached
 * (`targetReached`, D1): `done {by: "person"}`. So no countdown for a round a person has already paired stays up for even
 * the moment between the action's commit and the next arming, and a fire that wakes in that moment finds nothing pending.
 * It arms nothing: the NEXT target is the caller's `rearmAfterCommit`, after its commit, which never throws — so a manual
 * action is never refused for the clock's sake (the arming can throw by name; this cannot, past the DB itself).
 *
 * A leased row is the firer's (D2): the clock's own call through the same usecase (Task 8) must not retire the row it is
 * firing, and a person racing a fire leaves the row to the fire's re-derive. Answers how many rows it retired.
 *
 * Lock order: the caller's `division:` lock, then `auto-advance:<stageId>` (as `rearmAutoActions`).
 */
export async function retireReachedAutoActions(tx: Tx, stageId: string): Promise<number> {
  await tx`select pg_advisory_xact_lock(hashtext(${"auto-advance:" + stageId}))`;
  const live = await tx<(LiveRow & { stage_status: string; at: Date })[]>`
    select a.id, a.kind, a.state, a.target_round, a.target_proposal_id, a.blocked_code, a.detail, false as leased,
           s.status as stage_status, clock_timestamp() as at
      from stage_auto_actions a join stages s on s.id = a.stage_id
     where a.stage_id = ${stageId} and a.state in ${tx([...LIVE_AUTO_ACTION_STATES])}
       and not coalesce(a.lease_until > clock_timestamp(), false)`;
  if (live.length === 0) return 0;
  const reached = targetReached(tx, live[0]!.stage_status, () =>
    tx<Pick<SourceFixtureFact, "round_no" | "home_entrant_id" | "away_entrant_id" | "outcome">[]>`
      select round_no, home_entrant_id, away_entrant_id, outcome from fixtures where stage_id = ${stageId}`);
  let retired = 0;
  for (const row of live) {
    if (!(await reached(row))) continue;
    await markDoneByPerson(tx, row.id, row.at);
    retired++;
  }
  return retired;
}

/** Who skipped a round: a person's Skip, an Unpair of the round, or an Undo of its Pair from History. */
export type AutoSkipBy = "person" | "unpair" | "undo";

/**
 * Records a sticky skip of one target (§4.2: "a `cancelled` row keeps its target; rearm never re-arms it"): the live row of
 * that kind AND target becomes `cancelled {reason: "skip", by}`, or, when none is live, a `cancelled` row is inserted for
 * the target. Idempotent: a target already skipped writes nothing more. A live row of the same kind on ANOTHER target is
 * left to the caller's `rearmAfterCommit` (the derivation retires it once the skip stands).
 *
 * A leased row is closed too, its lease cleared: a skip is a person's word on the target, and a fire that still holds the
 * row must find it no longer pending (Task 8 writes its outcome only onto the row it still holds).
 *
 * Lock order: the caller's `division:` lock (if any), then `auto-advance:<stageId>`.
 */
export async function recordAutoSkip(tx: Tx, stageId: string, kind: SourceActionKind, round: number, by: AutoSkipBy): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${"auto-advance:" + stageId}))`;
  const result = tx.json({ reason: SKIP_REASON, by });
  const closed = await tx`
    update stage_auto_actions set state = 'cancelled', result = ${result}, lease_until = null, updated_at = clock_timestamp()
     where stage_id = ${stageId} and kind = ${kind} and target_round = ${round} and state in ${tx([...LIVE_AUTO_ACTION_STATES])}
    returning id`;
  if (closed.length > 0) return;
  // Only a SKIP counts as already skipped: a switch-off or superseded cancel of the same target is not sticky, so it must
  // not stand in for one.
  const [already] = await tx`
    select 1 from stage_auto_actions
     where stage_id = ${stageId} and kind = ${kind} and target_round = ${round} and state = 'cancelled'
       and result ->> 'reason' = ${SKIP_REASON}
     limit 1`;
  if (already) return;
  await tx`
    insert into stage_auto_actions (org_id, division_id, stage_id, kind, target_round, state, result, created_at, updated_at)
    select org_id, division_id, id, ${kind}, ${round}, 'cancelled', ${result}, clock_timestamp(), clock_timestamp()
      from stages where id = ${stageId}`;
}

/**
 * An Unpair of round N, or an Undo of its Pair from History (Review Focus 1): the organiser pulled the round back on
 * purpose, so the clock must not pair it again 60 s later — a sticky skip of `pair_round` N, `by` the path that did it.
 * Only where auto-pair is ON and can act (the arming's own gate): a stage that never used the clock gets no rows, and a
 * switch turned on later arms what is ready then (§5.8). Answers whether it recorded one. The caller rearms after its
 * commit.
 */
export async function recordPullBackSkip(tx: Tx, stageId: string, round: number, by: Exclude<AutoSkipBy, "person">): Promise<boolean> {
  const [stage] = await tx<{ kind: string; progression: unknown; config: Record<string, unknown> | null }[]>`
    select kind, progression, config from stages where id = ${stageId}`;
  if (!stage || stage.config?.autoPair !== true || !autoAdvanceSwitchesFor(stage).autoPair) return false;
  await recordAutoSkip(tx, stageId, "pair_round", round, by);
  return true;
}

/**
 * `POST /stages/{id}/auto-advance/skip` `{ kind }` (§4.6 "Skip this time"): the stage's live `pair_round` or
 * `complete_stage` row is cancelled as a skip for its target only — the next target arms normally, and no correction ever
 * re-arms this one (§5.13). Answers the row as it now stands.
 *
 * Refused, nothing written: 404 for an unknown stage; 422 AUTO_ADVANCE_CONFIRM_NOT_SKIPPABLE for `confirm_handoff` (D22:
 * confirm is stopped by pausing or the switch, never skipped); 409 AUTO_ADVANCE_NOTHING_TO_SKIP when no row of that kind
 * is live (the switch is off, nothing is armed, or it was skipped already).
 */
export async function skipAutoAction(auth: AuthCtx, stageId: string, kind: AutoActionKind): Promise<AutoActionView> {
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ id: string }[]>`select id from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (kind === "confirm_handoff") {
      throw new HttpError(
        422,
        "Confirming who moves on cannot be skipped. Pause it by reviewing the proposal, or turn automatic confirmation off.",
        "AUTO_ADVANCE_CONFIRM_NOT_SKIPPABLE",
      );
    }
    await tx`select pg_advisory_xact_lock(hashtext(${"auto-advance:" + stageId}))`;
    const [live] = await tx<{ id: string; target_round: number }[]>`
      select id, target_round from stage_auto_actions
       where stage_id = ${stageId} and kind = ${kind} and state in ${tx([...LIVE_AUTO_ACTION_STATES])}`;
    if (!live) throw new HttpError(409, "There is nothing of that kind waiting to happen on this stage.", "AUTO_ADVANCE_NOTHING_TO_SKIP");
    await recordAutoSkip(tx, stageId, kind, live.target_round, "person");
    const [row] = await tx<AutoActionRow[]>`
      select id, stage_id, kind, state, target_round, target_proposal_id, due_at, done_at, blocked_code, detail, result, updated_at
        from stage_auto_actions where id = ${live.id}`;
    return toAutoActionView(row!);
  });
}

/** `rearmAfterCommit` for the stage of a fixture: an abandon decides nothing, so it never reaches `onDecided`, yet it
 *  moves the stage's row (to blocked STAGE_NOT_READY, §5.6). Never throws, for the same reason. */
export async function rearmFixtureStageAfterCommit(orgId: string, fixtureId: string): Promise<void> {
  try {
    const alarms = await withTenant(orgId, async (tx) => {
      const [f] = await tx<{ stage_id: string | null }[]>`select stage_id from fixtures where id = ${fixtureId}`;
      return f?.stage_id ? rearmAutoActions(tx, f.stage_id) : [];
    });
    await publishAutoActionAlarms(alarms);
  } catch (err) {
    log.error({ err, orgId, fixtureId, event: "auto_advance_rearm_failed" }, "auto_advance_rearm_failed");
  }
}
