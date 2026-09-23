import "server-only";
// Schedule undo/versioning use-cases (Jul3/03 §6): undo/redo/history,
// checkpoints + restore, scoped clear, remove-teams-in-pool. The pure
// mechanics live in @seazn/engine/history — this module appends the returned
// event under the division aggregate lock and syncs the fixture tables.
import type postgres from "postgres";
import { z } from "zod";
import {
  ClearScope,
  HistoryError,
  clearSchedule as engineClearSchedule,
  fold,
  isReversible,
  redo as engineRedo,
  removeEntrantsFromPool as engineRemovePool,
  undo as engineUndo,
  type ClearableFixture,
  type FixtureSnapshot,
  type LedgerEvent,
} from "@seazn/engine/history";
import { EngineError } from "@seazn/engine/core";
import { sql, withTenant } from "@/lib/db";
// Since #382 a manual save AT THE CAP rolls the window instead of refusing, so
// PaymentRequiredError survives here for one case only: a quota that resolves
// below 1, where there is no window to roll (see `createCheckpoint`).
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { getLimit, requireFeature } from "@/lib/entitlements";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CourtId, VenueId } from "@/server/api-v1/schemas";
import { generateStageFixtures } from "./stages";
import { afterScheduleWrite, divisionLockState } from "./schedule";
import { schedulePlayerStatsRefresh } from "./player-stats-refresh";

type Tx = postgres.TransactionSql;

// EngineError codes for the doc 08 §1 map: 409 for stale clients, 422 rest.
function toEngineError(err: unknown): never {
  if (err instanceof HistoryError) {
    if (err.code === "UNDO_BLOCKED_HAS_RESULTS") {
      throw new EngineError("ALREADY_DECIDED", err.message, { code: err.code });
    }
    throw new HttpError(422, err.message);
  }
  throw err;
}

async function loadLedger(tx: Tx, divisionId: string): Promise<LedgerEvent[]> {
  const rows = await tx<{ seq: string | number; type: string; payload: Record<string, unknown> }[]>`
    select seq, type, payload from division_events
    where division_id = ${divisionId} order by seq`;
  return rows.map((r) => ({ seq: Number(r.seq), type: r.type, payload: r.payload }));
}

async function decidedFixtureIds(tx: Tx, divisionId: string): Promise<Set<string>> {
  const rows = await tx<{ id: string }[]>`
    select id from fixtures where division_id = ${divisionId} and status = 'decided'`;
  return new Set(rows.map((r) => r.id));
}

interface DivisionMeta {
  seq: number;
  edit_watermark: number | null;
  competition_id: string;
}

async function divisionMeta(tx: Tx, divisionId: string): Promise<DivisionMeta> {
  const [row] = await tx<{ seq: number; edit_watermark: string | number | null; competition_id: string }[]>`
    select seq, edit_watermark, competition_id from divisions where id = ${divisionId}`;
  if (!row) throw new HttpError(404, "division not found");
  return {
    seq: Number(row.seq),
    edit_watermark: row.edit_watermark === null ? null : Number(row.edit_watermark),
    competition_id: row.competition_id,
  };
}

async function appendEvent(
  tx: Tx,
  divisionId: string,
  event: { type: string; payload: Record<string, unknown> },
  actorId: string | null,
): Promise<number> {
  const [{ seq: last }] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from division_events
    where division_id = ${divisionId}`;
  await tx`
    insert into division_events (division_id, seq, type, payload, actor_id)
    values (${divisionId}, ${last + 1}, ${event.type},
            ${tx.json(event.payload as never)}, ${actorId})`;
  return last + 1;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Review wave 1, finding 1 (scope cut 2026-08-18, owner-authorized: no prod
// backfill — there is no pre-cutover prod data — so this is a defensive
// guard for a dev/staging DB or a restored backup, not a live-data fix).
// `division_events` predates V374 for any division touched before the
// cutover, so a stored payload can still hold a free-text court label.
// `fixtures.court_id` is a real uuid column (V367); binding a non-uuid
// string as its query parameter raises Postgres 22P02 and aborts the WHOLE
// undo/redo transaction, not just the one fixture it names. Validate before
// the value ever reaches a query rather than let Postgres be the guard, so a
// single stale ledger row cannot break an unrelated transaction.
//
// `null`/`undefined` is a legitimate "no court" value and writes straight
// through. Anything else that isn't a real uuid is logged and the write is
// SKIPPED — `court_id` is left exactly as it already is, never overwritten
// with a guess (a null-write would itself destroy a possibly-valid current
// assignment the stale event knows nothing about).
type CourtWrite = { write: true; value: string | null } | { write: false };

function resolveCourtWrite(value: unknown, context: Record<string, unknown>): CourtWrite {
  if (value === null || value === undefined) return { write: true, value: null };
  if (typeof value === "string" && UUID_RE.test(value)) return { write: true, value };
  log.warn(
    { ...context, court: value },
    "history: skipping non-uuid court in ledger event payload — court_id left untouched",
  );
  return { write: false };
}

// ---------------------------------------------------------------------------
// Fixture snapshots (restore fidelity, 2026-09-23)
//
// Two history writes DELETE fixtures — undoing a generation (`fixtures_cleared`,
// snapshotted in `stepWrite`) and clearing a pool's entrants
// (`pool_entrants_cleared`, snapshotted in `clearPoolEntrants`) — and their
// inverses re-insert the snapshot raw. The snapshot used to carry nine
// columns, so a restored bracket came back without its ext_key, its V368
// round role, its placeholders, its feed edges (winners stopped advancing),
// its byes' awards and its fixture numbers: the schedule board fell back to
// R{n}, and a regeneration no longer recognised a single row.
//
// `snapshotFixtures` is the ONE read both destructive paths record and
// `restoreFixtures` the ONE writer both inverses use. Every column of
// `fixtures` is decided here:
//
//   KEPT
//   - The generator's structure: ext_key (regeneration is idempotent by it;
//     page-playoff round names read it), lane / is_final / third_place /
//     conditional (V368 round role), home/away_slot_label (TBD placeholders),
//     winner_to/loser_to fixture+slot (the feed edges), fixture_no (the
//     number printed on sheets — renumbered only when taken since).
//   - status / outcome of a row that carried no score events — on such a row
//     they can only be the generator's own verdicts (a bye's award, a
//     departed qualifier's walkover or void) or 'scheduled' (see
//     `restoredVerdict`).
//   - The schedule placement: scheduled_at, court_id (both kept before this),
//     schedule_locked, schedule_source — and venue_id, re-derived from the
//     restored court rather than stored (its writer's own rule).
//   - Identity: id, stage_id, division_id, pool_id, round_no, seq_in_round,
//     home/away_entrant_id (kept before this). org_id is re-derived by the
//     insert trigger from the stage — the same value.
//
//   NOT KEPT
//   - Play state whose evidence the delete cascaded away: the status/outcome
//     of a scored row (it returns 'scheduled', as it always did — a DECIDED
//     row never gets here, the results-guard blocks the undo) and
//     config_snapshot / config_snapshot_at (frozen at match start).
//   - Match-day setup, which history has never restored: `officials` is a
//     mirror of `fixture_officials` (officials.ts), whose rows the delete
//     cascaded — restoring the mirror would contradict the table — and
//     `stream_url` sits with lineups and device links, which cascade too.
//   - created_at (the row really is inserted again); venue / court_label
//     (legacy free text, superseded by venue_id / court_id); parent_fixture_id
//     (nothing in apps/web writes it).
//
// Known residual: a feed edge INTO a restored row from a row that is not in
// the snapshot (a cross-stage `cross_feeds` edge, stages.ts wireCrossFeeds)
// was SET NULL by the delete and is not re-wired here.
// ---------------------------------------------------------------------------

/** What `snapshotFixtures` returns: every field present (the SQL selects them
 *  all), which a snapshot read back from an older ledger row cannot promise. */
interface SnapshotRow extends FixtureSnapshot {
  stage_id: string;
  pool_id: string | null;
  round_no: number;
  at: string | null;
  court: string | null;
  locked: boolean;
  status: string;
}

/** The one snapshot read. Ordered by fixture number, so a restore that must
 *  renumber a taken number still hands them out in the original order. */
async function snapshotFixtures(
  tx: Tx,
  by: { ids: readonly string[] } | { poolId: string },
): Promise<SnapshotRow[]> {
  if ("ids" in by && by.ids.length === 0) return [];
  const where = "ids" in by ? tx`f.id in ${tx(by.ids as string[])}` : tx`f.pool_id = ${by.poolId}`;
  // `court` is a courts.id (P9 pass 3a — aliased off court_id, never the
  // legacy court_label): the restore writes it straight back into an id
  // column, so a label here would be a display string in a uuid.
  return tx<SnapshotRow[]>`
    select f.id, f.stage_id, f.pool_id, f.round_no, f.seq_in_round,
           f.home_entrant_id, f.away_entrant_id,
           f.scheduled_at::text as at, f.court_id as court,
           f.schedule_locked as locked, f.schedule_source, f.fixture_no,
           f.ext_key, f.lane, f.is_final, f.third_place, f.conditional,
           f.home_slot_label, f.away_slot_label,
           f.winner_to_fixture, f.winner_to_slot, f.loser_to_fixture, f.loser_to_slot,
           f.status, f.outcome,
           exists (select 1 from score_events se where se.fixture_id = f.id) as scored
    from fixtures f where ${where}
    order by f.fixture_no, f.id`;
}

/** A row that carried no score events comes back with the status and outcome
 *  it had. Every play-driven status is a fold of score events
 *  (engine-db/append-event.ts), so on an unscored row they can only be the
 *  generator's own — a bye's award, a departed qualifier's walkover or void
 *  (stages.ts first pass) — or plain 'scheduled'. A scored row's evidence went
 *  with the delete's cascade, so it returns unplayed, as it always has.
 *  `scored` must be literally false: a snapshot from before it existed
 *  restores 'scheduled', as it always did. */
function restoredVerdict(s: FixtureSnapshot): { status: string; outcome: Record<string, unknown> | null } {
  if (s.scored === false) return { status: s.status ?? "scheduled", outcome: s.outcome ?? null };
  return { status: "scheduled", outcome: null };
}

/** The one raw re-insert (`pool_entrants_restored` in execute(), and a
 *  snapshot-carrying `fixtures_generated` in stepWrite). Returns the ids it
 *  inserted — a row that already exists is left alone (`on conflict`).
 *
 *  P9 dispatch #9: the court goes through `resolveCourtWrite` — a stale
 *  pre-cutover snapshot's non-uuid court raised 22P02 and aborted the whole
 *  undo. There is no existing row to "leave untouched" the way an UPDATE can,
 *  so an unresolvable court inserts as null (logged). */
async function restoreFixtures(
  tx: Tx,
  divisionId: string,
  snapshots: readonly FixtureSnapshot[],
  eventType: string,
): Promise<string[]> {
  const jsonb = (value: Record<string, unknown> | null | undefined) =>
    value === null || value === undefined ? null : tx.json(value as never);
  const restored: FixtureSnapshot[] = [];
  for (const s of snapshots) {
    const court = resolveCourtWrite(s.court, { divisionId, fixtureId: s.id, eventType });
    const verdict = restoredVerdict(s);
    // venue_id: derived from the court being restored, the one rule its only
    // writer uses (schedule.ts moveFixture, "#5 fix") — never stored apart
    // from the court it must agree with. No court, no venue.
    // fixture_no: its own number unless something took it since, in which
    // case null lets the insert trigger hand out the next free one.
    // Feed edges are written after every row is in (below): an edge may
    // point at a row later in this same list.
    const inserted = await tx<{ id: string }[]>`
      insert into fixtures (id, stage_id, division_id, pool_id, round_no, seq_in_round,
                            home_entrant_id, away_entrant_id, scheduled_at, court_id,
                            venue_id, schedule_locked, schedule_source, fixture_no,
                            ext_key, lane, is_final, third_place, conditional,
                            home_slot_label, away_slot_label, status, outcome)
      values (${s.id}, ${s.stage_id!}, ${divisionId}, ${s.pool_id ?? null},
              ${s.round_no ?? 1}, ${s.seq_in_round ?? 1}, ${s.home_entrant_id ?? null},
              ${s.away_entrant_id ?? null}, ${s.at ?? null}, ${court.write ? court.value : null},
              (select c.venue_id from courts c where c.id = ${court.write ? court.value : null}),
              ${s.locked === true}, ${s.schedule_source ?? "none"},
              (select n.no from (select ${s.fixture_no ?? null}::int as no) n
                where not exists (select 1 from fixtures t
                                  where t.division_id = ${divisionId} and t.fixture_no = n.no)),
              ${s.ext_key ?? null}, ${s.lane ?? null}, ${s.is_final === true},
              ${s.third_place === true}, ${s.conditional === true},
              ${jsonb(s.home_slot_label)}, ${jsonb(s.away_slot_label)},
              ${verdict.status}, ${jsonb(verdict.outcome)})
      on conflict (id) do nothing returning id`;
    if (inserted.length > 0) restored.push(s);
  }
  // An edge whose target no longer exists is dropped with its slot, never
  // written as a dangling id (the FK would refuse it).
  for (const s of restored) {
    if (!s.winner_to_fixture && !s.loser_to_fixture) continue;
    await tx`
      update fixtures set
        winner_to_fixture = (select t.id from fixtures t where t.id = ${s.winner_to_fixture ?? null}),
        winner_to_slot = (select ${s.winner_to_slot ?? null}::int from fixtures t
                          where t.id = ${s.winner_to_fixture ?? null}),
        loser_to_fixture = (select t.id from fixtures t where t.id = ${s.loser_to_fixture ?? null}),
        loser_to_slot = (select ${s.loser_to_slot ?? null}::int from fixtures t
                         where t.id = ${s.loser_to_fixture ?? null})
      where id = ${s.id}`;
  }
  return restored.map((s) => s.id);
}

// Execute one history event against the fixture tables. Undo/redo of a
// fixtures_generated with no snapshots re-runs the deterministic generator.
//
// R10e: returns the ids of the fixtures its own statements wrote (each one
// `returning id`), so a caller publishes exactly those, never the payload's
// list — a row the `status <> 'decided'` filter skipped was not changed.
async function execute(
  tx: Tx,
  divisionId: string,
  event: { type: string; payload: Record<string, unknown> },
  /** Filled in: did a delete remove a fixture that carried score events? */
  effects: { scoredFixtureRemoved: boolean } = { scoredFixtureRemoved: false },
): Promise<string[]> {
  const p = event.payload;
  const written: string[] = [];
  const wrote = (rows: readonly { id: string }[]) => {
    for (const row of rows) written.push(row.id);
  };
  switch (event.type) {
    // P9 pass 3a: `court`/`.court` on every payload below is a `courts.id`
    // now (schedule.ts's `moveFixture`/`applySchedule` write it that way —
    // see their own comments on `schedule_edited`/`schedule_applied`), so
    // every replay here writes `court_id`, never the legacy `court_label`.
    // This is the fix the dispatch's regression targets: undo/redo used to
    // write a STALE FREE-TEXT LABEL back into `court_label` while `court_id`
    // sat untouched — a real defect (the two columns silently disagreeing
    // after a restore), not merely a rename.
    case "schedule_applied":
    case "schedule_shifted": {
      const moves = (p.moves as { fixture: string; to: { at: string | null; court: string | null } }[]) ?? [];
      for (const m of moves) {
        const court = resolveCourtWrite(m.to.court, { divisionId, fixtureId: m.fixture, eventType: event.type });
        if (court.write) {
          wrote(await tx<{ id: string }[]>`update fixtures set scheduled_at = ${m.to.at}, court_id = ${court.value}
                   where id = ${m.fixture} and status <> 'decided' returning id`);
        } else {
          wrote(await tx<{ id: string }[]>`update fixtures set scheduled_at = ${m.to.at}
                   where id = ${m.fixture} and status <> 'decided' returning id`);
        }
      }
      break;
    }
    case "schedule_edited": {
      const to = p.to as { at: string | null; court: string | null; locked?: boolean };
      const court = resolveCourtWrite(to.court, { divisionId, fixtureId: p.fixture, eventType: event.type });
      if (court.write) {
        wrote(await tx<{ id: string }[]>`
          update fixtures set scheduled_at = ${to.at}, court_id = ${court.value},
                              schedule_locked = coalesce(${to.locked ?? null}, schedule_locked)
          where id = ${p.fixture as string} and status <> 'decided' returning id`);
      } else {
        wrote(await tx<{ id: string }[]>`
          update fixtures set scheduled_at = ${to.at},
                              schedule_locked = coalesce(${to.locked ?? null}, schedule_locked)
          where id = ${p.fixture as string} and status <> 'decided' returning id`);
      }
      break;
    }
    case "schedule_cleared": {
      for (const s of (p.cleared as FixtureSnapshot[]) ?? []) {
        wrote(await tx<{ id: string }[]>`update fixtures set scheduled_at = null, court_id = null
                 where id = ${s.id} and status <> 'decided' returning id`);
      }
      break;
    }
    case "schedule_restored": {
      for (const s of (p.restored as FixtureSnapshot[]) ?? []) {
        const court = resolveCourtWrite(s.court, { divisionId, fixtureId: s.id, eventType: event.type });
        if (court.write) {
          wrote(await tx<{ id: string }[]>`update fixtures set scheduled_at = ${s.at ?? null}, court_id = ${court.value}
                   where id = ${s.id} and status <> 'decided' returning id`);
        } else {
          wrote(await tx<{ id: string }[]>`update fixtures set scheduled_at = ${s.at ?? null}
                   where id = ${s.id} and status <> 'decided' returning id`);
        }
      }
      break;
    }
    case "fixtures_cleared":
    case "pool_entrants_cleared": {
      const ids =
        event.type === "fixtures_cleared"
          ? ((p.fixture_ids as string[]) ?? [])
          : ((p.fixtures as FixtureSnapshot[]) ?? []).map((s) => s.id);
      if (ids.length > 0) {
        // `scored`: whether the fixture carried score events, which cascade away
        // with it. Every part of a data-modifying WITH reads the same snapshot,
        // so the outer select still sees the rows its delete removes. The
        // caller refreshes the division's player stats when one did.
        const removed = await tx<{ id: string; scored: boolean }[]>`
          with gone as (
            delete from fixtures where id in ${tx(ids)} and status <> 'decided' returning id
          )
          select gone.id, exists (select 1 from score_events se where se.fixture_id = gone.id) as scored
          from gone`;
        wrote(removed);
        if (removed.some((row) => row.scored)) effects.scoredFixtureRemoved = true;
      }
      break;
    }
    case "pool_entrants_restored": {
      // The raw re-insert of `clearPoolEntrants`'s snapshot — see
      // `restoreFixtures` for what comes back and the court guard.
      written.push(...(await restoreFixtures(tx, divisionId, (p.fixtures as FixtureSnapshot[]) ?? [], event.type)));
      break;
    }
    case "fixtures_generated": {
      // Deterministic generator re-run (idempotent by ext_key) — marker set
      // by the caller; actual regeneration happens outside this tx.
      break;
    }
    default:
      throw new HttpError(500, `no executor for history event '${event.type}'`);
  }
  return written;
}

export interface HistoryStepOut {
  watermark: number;
  seq: number;
  applied: { type: string };
  regenerate_stage_id?: string;
}

const StepInput = z.object({ expected_seq: z.number().int().optional() });
export { StepInput as HistoryStepInput };

/** One undo/redo step's committed write (R10e): what it returns, its
 *  competition, and the fixtures its own statements changed. */
interface StepWrite {
  out: HistoryStepOut;
  competitionId: string;
  fixtureIds: string[];
  scoredFixtureRemoved: boolean;
}

async function stepWrite(
  auth: AuthCtx,
  divisionId: string,
  direction: "undo" | "redo",
  expectedSeq: number | undefined,
): Promise<StepWrite> {
  const write = await withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const meta = await divisionMeta(tx, divisionId);
    // optimistic token (Jul3/03 §8): a stale client gets 409 + refetch
    if (expectedSeq !== undefined && expectedSeq !== meta.seq) {
      throw new EngineError("SEQ_CONFLICT", "division changed since you loaded it", {
        actualSeq: meta.seq,
      });
    }
    // A freeze binds the REWIND as well as every forward edit, and
    // `restoreCheckpoint` is a LOOP OF THIS FUNCTION — so a freeze that stopped
    // the restore left the primitive it is built out of live, on two buttons a
    // few hundred pixels above the Restore it had just disabled. Same blast
    // radius, one layer down.
    //
    // Guarding it strands nobody, which is the objection this was exempted for.
    // `divisions.schedule_locked` has exactly ONE writer — `setDivisionLocks`,
    // which appends no ledger event — so there is no replay of the division
    // freeze and no rewind could ever have handed it back. The `schedule_locked`
    // undo DOES replay is `fixtures.schedule_locked`, the per-fixture pin: a
    // different column on a different table with the same name, and the whole
    // of the original exemption's reasoning.
    //
    // WHICH OTHER PATHS REFUSE: do not read a list here, and do not trust a
    // count — the sentence that used to sit in this comment named four
    // siblings, called the enumeration finished, and was false at three sites
    // (`clearPoolEntrants` and `deleteCheckpoint` below, `shiftDivisionSchedule`
    // in schedule-plus.ts) on the day it was written. The enumeration is now
    // the IMPORT GRAPH of `@/lib/schedule-lock`: every board-write refusal
    // throws `SCHEDULE_LOCKED_MESSAGE` with `SCHEDULE_LOCKED_CODE` at 422, so
    // `grep -rn SCHEDULE_LOCKED_MESSAGE apps/web/src` is the live answer and a
    // freeze refusal that does NOT import the constant is the bug. (The joint
    // apply, competition-schedule-apply.ts, shares the CODE but formats its own
    // sentence through `scheduleLockedMessageFor` because it must name which
    // division of a competition stopped the run. The AI-plan gates answer 409
    // with the same code.)
    //
    // AFTER the existence check in `divisionMeta` (a missing division still
    // 404s) and after the optimistic token, matching `applySchedule`, which
    // runs `assertFreshSeq` ahead of its own freeze check. BEFORE the ledger
    // read, so a frozen division refuses without engine work and without a
    // chance of appending.
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    const ledger = await loadLedger(tx, divisionId);
    const decided = await decidedFixtureIds(tx, divisionId);
    let result;
    try {
      result =
        direction === "undo"
          ? engineUndo(ledger, meta.edit_watermark, decided)
          : engineRedo(ledger, meta.edit_watermark, decided);
    } catch (err) {
      toEngineError(err);
    }
    // Undoing a generation needs the row snapshots for redo — enrich before
    // the delete so the appended event is self-contained. (A plain Redo right
    // after never reads them: it re-runs the generator. They are re-inserted
    // when a later undo walks back past this one — below.)
    if (result.event.type === "fixtures_cleared" && result.event.payload.fixtures === undefined) {
      const ids = (result.event.payload.fixture_ids as string[]) ?? [];
      if (ids.length > 0) result.event.payload.fixtures = await snapshotFixtures(tx, { ids });
    }
    const effects = { scoredFixtureRemoved: false };
    const fixtureIds = await execute(tx, divisionId, result.event, effects);
    const seq = await appendEvent(tx, divisionId, result.event, auth.userId);
    await tx`update divisions set seq = ${seq}, edit_watermark = ${result.newWatermark}
             where id = ${divisionId}`;
    const regen =
      result.event.type === "fixtures_generated" && result.event.payload.fixtures === undefined
        ? ((result.event.payload.stage_id as string) ?? undefined)
        : undefined;
    // A fixtures_generated with snapshots re-inserts directly — the undo of
    // an undone generation (Undo past a later edit, or a save-point restore).
    // It never routes through execute(); `restoreFixtures` is shared with
    // pool_entrants_restored there, so both inverses restore the same row.
    if (result.event.type === "fixtures_generated" && result.event.payload.fixtures !== undefined) {
      const snapshots = (result.event.payload.fixtures as FixtureSnapshot[]) ?? [];
      fixtureIds.push(...(await restoreFixtures(tx, divisionId, snapshots, result.event.type)));
    }
    return {
      out: {
        watermark: result.newWatermark,
        seq,
        applied: { type: result.event.type },
        ...(regen !== undefined ? { regenerate_stage_id: regen } : {}),
      },
      competitionId: meta.competition_id,
      fixtureIds,
      scoredFixtureRemoved: effects.scoredFixtureRemoved,
    };
  });
  // generator re-run outside the history tx (it takes its own division lock).
  // It publishes its own write; this step's transaction changed no fixture in
  // that case (`fixtures_generated` has no executor statement).
  if (write.out.regenerate_stage_id !== undefined) {
    await generateStageFixtures(auth, write.out.regenerate_stage_id);
  }
  return write;
}

/** R10e (review-r10d m1): a history write that changed fixtures drops the hub
 *  key and exactly those fixtures' public documents in one DEL, after its
 *  commit, then pushes (`afterScheduleWrite`, 50-fixture push cap). An undo is
 *  the move it reverses, so the hub and an open match centre must follow it
 *  at once, not at the next poll. A write that changed nothing sends nothing. */
function publishHistoryWrite(
  auth: AuthCtx,
  divisionId: string,
  competitionId: string,
  fixtureIds: readonly string[],
  scoredFixtureRemoved: boolean,
): void {
  if (fixtureIds.length > 0) afterScheduleWrite(divisionId, competitionId, "schedule", fixtureIds);
  // A removed fixture's score events went with it, so the division's player
  // stats still count them until they are refolded (review m3).
  if (scoredFixtureRemoved) schedulePlayerStatsRefresh(auth.orgId, { divisionId });
}

async function step(
  auth: AuthCtx,
  divisionId: string,
  direction: "undo" | "redo",
  expectedSeq: number | undefined,
): Promise<HistoryStepOut> {
  const write = await stepWrite(auth, divisionId, direction, expectedSeq);
  publishHistoryWrite(auth, divisionId, write.competitionId, write.fixtureIds, write.scoredFixtureRemoved);
  return write.out;
}

export const undoDivision = (auth: AuthCtx, id: string, expectedSeq?: number) =>
  step(auth, id, "undo", expectedSeq);
export const redoDivision = (auth: AuthCtx, id: string, expectedSeq?: number) =>
  step(auth, id, "redo", expectedSeq);

export interface HistoryRow {
  seq: number;
  type: string;
  undoable: boolean;
  actor_id: string | null;
  created_at: string;
  undone: boolean;
}

/** GET /divisions/{id}/history — ledger slice, newest first. */
export async function divisionHistory(
  auth: AuthCtx,
  divisionId: string,
): Promise<{ watermark: number | null; seq: number; events: HistoryRow[] }> {
  return withTenant(auth.orgId, async (tx) => {
    const meta = await divisionMeta(tx, divisionId);
    const rows = await tx<{ seq: number; type: string; actor_id: string | null; created_at: string }[]>`
      select seq, type, actor_id, created_at from division_events
      where division_id = ${divisionId} order by seq desc limit 100`;
    const wm = meta.edit_watermark;
    return {
      watermark: wm,
      seq: meta.seq,
      events: rows.map((r) => ({
        seq: Number(r.seq),
        type: r.type,
        undoable: isReversible(r.type),
        actor_id: r.actor_id,
        created_at: r.created_at,
        undone: wm !== null && isReversible(r.type) && Number(r.seq) > wm,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Checkpoints (Jul3/03 §2) — named save points; restore = undo to watermark.
// ---------------------------------------------------------------------------

/** `manual` = an organiser's own save point, counted against
 *  schedule.checkpoints.max. `ai` = an undo anchor the AI accept flow creates on
 *  their behalf (V303) — exempt, because it is the feature's bookkeeping, not
 *  something the organiser chose to spend a slot on. */
export type CheckpointKind = "manual" | "ai";

export interface CheckpointRow {
  id: string;
  seq: number;
  label: string;
  kind: CheckpointKind;
  created_at: string;
  /** True for every AI anchor except the newest — the panel strikes these
   *  through. They stay restorable: the ledger can rewind to any watermark, and
   *  jumping back two AI runs is a real capability worth keeping. */
  superseded?: boolean;
  /** #382 — set on the row RETURNED BY A CREATE, never by a list: the save
   *  point this one pushed out of the plan's rolling window. The panel names it
   *  in a non-blocking notice, so the organiser learns which label they lost
   *  rather than discovering it missing later.
   *
   *  Present only when something was actually dropped. One name, even when a
   *  downgrade drops several — see `createCheckpoint`. */
  evicted?: { id: string; label: string };
}

export async function listCheckpoints(auth: AuthCtx, divisionId: string): Promise<CheckpointRow[]> {
  const rows = await withTenant(auth.orgId, (tx) => tx<CheckpointRow[]>`
    select id, seq, label, kind, created_at from division_checkpoints
    where division_id = ${divisionId} order by created_at desc`);
  // Newest first, so the first `ai` row is the live anchor and the rest are
  // superseded. Derived on read rather than stored — a stored flag would need
  // updating on every AI apply and could drift.
  let seenLiveAi = false;
  return rows.map((r) => {
    if (r.kind !== "ai") return r;
    if (!seenLiveAi) {
      seenLiveAi = true;
      return r;
    }
    return { ...r, superseded: true };
  });
}

/** The competition an Event-Pass-lifted gate must be resolved against.
 *
 *  lib/entitlements.ts only consults `competition_passes` when a competition is
 *  in scope, so a gate on a key V393 lifts (`schedule.checkpoints.max`) that omits it makes the
 *  pass INVISIBLE — the org pays $29 and is refused on the competition it
 *  bought. Same shape as usecases/officials.ts's `competitionForDivision` (T6).
 *
 *  Pooled `sql`, and deliberately OUTSIDE the `withTenant` callback below:
 *  `resolve` queries the pooled proxy, and issuing that from inside a pinned
 *  tenant transaction asks the pool for a second connection while the first is
 *  still held — the self-deadlock lib/db.ts guards against.
 *
 *  A missing row yields `undefined`, which resolves the gate org-wide (the
 *  pre-V393 behaviour) and the 404 is raised inside the transaction as before. */
async function competitionForDivision(divisionId: string): Promise<string | undefined> {
  const [row] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  return row?.competition_id;
}

export async function createCheckpoint(
  auth: AuthCtx,
  divisionId: string,
  label: string,
  kind: CheckpointKind = "manual",
): Promise<CheckpointRow> {
  // The plan LOOKUP is resolved out here; the COUNT stays inside the
  // transaction with the insert (doc 10 §2 rule 1). `getLimit` queries the
  // pooled `sql` proxy, and `withTenant` pins a pooled connection for its whole
  // callback — see `assertWithinLimit` in lib/entitlements.ts.
  // V393 lifts this cap on an Event Pass (community 2 -> event_pass 5), so the
  // read is scoped to this division's competition.
  const checkpointLimit = await getLimit(
    auth.orgId,
    "schedule.checkpoints.max",
    await competitionForDivision(divisionId),
  );
  return withTenant(auth.orgId, async (tx) => {
    // #382 review, finding 3: the roll below is count → delete → insert, and
    // without this lock those three steps are not serialised. Two saves landing
    // together (the realistic shape is one owner double-clicking Save, not two
    // admins) both read the same count, both compute the same `drop`, and both
    // target the SAME oldest row — one DELETE takes it, the other takes nothing
    // and so reports no `evicted` — while both INSERTs land. The division ends
    // at limit + 1 and one organiser is never told a bookmark went. It
    // self-corrects on the next save, which is exactly why it went unnoticed.
    //
    // The key is `division:<id>`, byte-identical to `lockDivisions`
    // (competition-schedule-apply.ts) and to `step`/`restoreCheckpoint` below:
    // the checkpoint window is a fact ABOUT a division, so it must serialise
    // against every other writer of that division's plan, not just against
    // other checkpoint saves. A private key would leave an apply free to move
    // the watermark this insert is about to read.
    //
    // Safe to take here because `createCheckpoint` is a LEAF — the checkpoints
    // route is its only caller — so this transaction never holds
    // `division:<id>` while some nested call waits for the same key on another
    // connection. `pg_advisory_xact_lock` releases at commit or rollback, so
    // nothing survives the transaction either.
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const meta = await divisionMeta(tx, divisionId);
    // Jul3/03 §7 → V290: save points are a per-plan quota (community 1,
    // pro 5, pro_plus unlimited). schedule.versioning still gates scope locks.
    //
    // V303: the count is MANUAL rows only. Charging the organiser for the AI
    // flow's own undo anchor is what previously blocked a community org that
    // already held one save point from applying an AI schedule at all — the
    // create 402'd, the apply aborted, and the AI generation was already spent.
    //
    // #382: at the cap this used to throw PaymentRequiredError. It now ROLLS.
    // A checkpoint is a named bookmark, not the history — the ledger keeps
    // every event and restore is "undo until the watermark reaches this seq",
    // so dropping a save point costs the LABEL, not the ability to rewind that
    // far. Refusing the save cost the organiser the thing they were doing, in
    // the middle of doing it, which is a far worse trade than losing the oldest
    // bookmark. The quota still means something: it is the width of the window.
    let evicted: { id: string; label: string } | undefined;
    if (kind === "manual") {
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from division_checkpoints
        where division_id = ${divisionId} and kind = 'manual'`;
      const limit = checkpointLimit;
      // #382 review, finding 2: a quota below 1 has NO window to roll, so the
      // rolling branch cannot express it. `drop = n - limit + 1` at n=0/limit=0
      // asks to delete one row from an empty table — the delete removes nothing
      // and the insert lands anyway, leaving an org entitled to zero save points
      // permanently holding one, with the "post-insert count is exactly the
      // limit" invariant broken on the one input where it mattered.
      //
      // Refusing is a quota refusal, so it is `PaymentRequiredError` with the
      // feature key, the shape every other quota gate in usecases/ uses
      // (clubs.ts, divisions.ts, entrants.ts, competitions.ts).
      //
      // Zero is reachable two ways and this deliberately does not distinguish
      // them: a staff override with `int_value = 0`, and a MISSING
      // `plan_entitlements` row, which `getLimit` also resolves to 0. The
      // override is a deliberate grant of nothing and must be honoured. The
      // missing row is a mis-seeded database — and there, refusing is still the
      // better answer than the old behaviour, which silently held one save point
      // and lied about the count. All three real plan keys (community 2, pro 5,
      // pro_plus unlimited) carry a row, so a correctly migrated database cannot
      // reach this by accident; `event_pass`/`event_pass_l` have no row, but
      // they are pass keys, never an org's plan key, and this read passes no
      // competition so no pass overlay applies.
      if (limit !== null && limit < 1) throw new PaymentRequiredError("schedule.checkpoints.max");
      // A null limit is unlimited (pro_plus) — never evict.
      if (limit !== null && n >= limit) {
        // Delete n - limit + 1, so the POST-INSERT count is exactly the limit.
        // Do not assume n === limit: a plan downgrade can leave a division above
        // the cap, and one save must bring it back to the limit, not to n.
        //
        // Order: created_at asc, seq asc, id asc. The `id` tie-break is a UUID,
        // which the determinism rule normally forbids — acceptable here because
        // this is SELECTION INPUT, not output ordering, the same exemption
        // advisory-lock ordering gets. Do not "fix" it.
        const drop = n - limit + 1;
        const gone = await tx<
          { id: string; label: string; created_at: Date | string; seq: string | number }[]
        >`
          delete from division_checkpoints
           where id in (
             select id from division_checkpoints
              where division_id = ${divisionId} and kind = 'manual'
              order by created_at asc, seq asc, id asc
              limit ${drop}
           )
           returning id, label, created_at, seq`;
        // RETURNING does NOT preserve the subquery's ORDER BY — Postgres hands
        // back deleted rows in whatever order it removed them. Re-apply the
        // same ordering here rather than trusting the array's shape.
        //
        // The notice names ONE save point; when several go (a downgrade), name
        // the newest of them — it is the one the organiser is likeliest to miss.
        const newest = gone
          .slice()
          .sort(
            (a, b) =>
              new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
              Number(a.seq) - Number(b.seq) ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          )
          .at(-1);
        if (newest) evicted = { id: newest.id, label: newest.label };
      }
    }
    const ledger = await loadLedger(tx, divisionId);
    const wm = meta.edit_watermark ?? (ledger[ledger.length - 1]?.seq ?? 0);
    const [row] = await tx<CheckpointRow[]>`
      insert into division_checkpoints (division_id, seq, label, kind, created_by)
      values (${divisionId}, ${wm}, ${label}, ${kind}, ${auth.userId})
      returning id, seq, label, kind, created_at`;
    // #382: AI anchors are exempt from the manual quota and nothing ever deleted
    // them, so they accumulated one per AI apply, for ever — `superseded` is
    // derived on read, not stored, and the only other DELETE is the organiser's
    // own. Keep the newest 3.
    //
    // Three, not one: `CheckpointRow.superseded` exists because jumping back
    // two AI runs is a capability worth keeping, and two runs back plus the
    // newest is exactly 3. No notice for these — the organiser did not name
    // them and the panel already strikes the superseded ones through.
    //
    // AFTER the insert, so the row just created is always among the survivors.
    // Same ordering exemption as the manual eviction above: selection input.
    // The V303 index (division_id, kind, created_at desc) already serves it.
    if (kind === "ai") {
      await tx`
        delete from division_checkpoints
         where id in (
           select id from division_checkpoints
            where division_id = ${divisionId} and kind = 'ai'
            order by created_at desc, seq desc, id desc
            offset 3
         )`;
    }
    return { ...row!, ...(evicted ? { evicted } : {}) };
  });
}

/** DELETE /divisions/{id}/checkpoints/{checkpointId} — drop a save point.
 *
 *  Deleting a MANUAL save point frees a quota slot, which is the point: the
 *  quota is per-division and nothing could reclaim one, so an organiser who
 *  made a save point they no longer wanted was stuck with it — on community,
 *  that meant permanently holding their only slot.
 *
 *  AI anchors are deletable too. They cost no quota so there is no need to
 *  remove one, but they are rows in the organiser's own division and hiding the
 *  affordance would be stranger than allowing it. The next AI apply creates a
 *  fresh anchor regardless. */
export async function deleteCheckpoint(
  auth: AuthCtx,
  divisionId: string,
  checkpointId: string,
): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    // Scoped by division as well as id, so a checkpoint id belonging to another
    // division cannot be deleted by guessing it.
    //
    // The lookup used to BE the delete (`delete … returning id`, 404 on no
    // row). It is split in two now so the freeze guard has somewhere to stand
    // that keeps 404 ahead of 422: a checkpoint that does not exist must still
    // answer "checkpoint not found" on a frozen division, which a guard placed
    // before a combined delete-and-check could not do. Both halves run in the
    // same transaction, so nothing can delete the row between them.
    const [row] = await tx<{ id: string }[]>`
      select id from division_checkpoints
      where id = ${checkpointId} and division_id = ${divisionId}`;
    if (!row) throw new HttpError(404, "checkpoint not found");
    // Deleting a save point is destroying a REWIND, which is precisely what the
    // freeze exists to protect — and it is irreversible, unlike every other
    // refusal in this file. The panel had already reached this conclusion for
    // the safer half of the same row: Restore got `disabled={busy ||
    // scheduleLocked}` while Delete beside it kept `disabled={busy}`, so a
    // frozen division's only save point could be destroyed from a console that
    // had visibly greyed out the button that would merely have USED it.
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    await tx`
      delete from division_checkpoints
      where id = ${checkpointId} and division_id = ${divisionId}`;
  });
}

/** POST /divisions/{id}/restore — undo repeatedly to the checkpoint's
 *  watermark (guarded by the same results-guard as single undo). */
export async function restoreCheckpoint(
  auth: AuthCtx,
  divisionId: string,
  checkpointId: string,
  confirm: boolean,
): Promise<{ watermark: number; steps: number }> {
  if (!confirm) throw new HttpError(422, "restore requires confirm: true");
  const target = await withTenant(auth.orgId, async (tx) => {
    const [cp] = await tx<{ seq: string | number }[]>`
      select seq from division_checkpoints
      where id = ${checkpointId} and division_id = ${divisionId}`;
    if (!cp) throw new HttpError(404, "checkpoint not found");
    // A freeze has to stop the REWIND as well as the clear. Restore is the
    // wider of the two: `clearScheduleScoped` empties unlocked slots, this
    // rewrites every fixture's time and court back to the save point — and the
    // two controls sit in the same console a few hundred pixels apart, so a
    // freeze that only bound one of them refused the smaller edit and allowed
    // the larger.
    //
    // Same 422, same code, same sentence as every other board-write refusal:
    // all of them now throw `SCHEDULE_LOCKED_MESSAGE`/`SCHEDULE_LOCKED_CODE`
    // out of `@/lib/schedule-lock`, so a reword is one edit and the set of
    // refusing paths is that constant's import graph rather than a list typed
    // into a comment. See `step` above for why a typed list is not kept here.
    //
    // `step` (undo/redo) now carries the same guard, and this one is still
    // load-bearing rather than redundant: a restore whose watermark has already
    // reached the checkpoint short-circuits to `{ steps: 0 }` in the loop below
    // WITHOUT ever calling undo, so only this guard can refuse that call. The
    // two are pinned by separate cases in history.test.ts for exactly that
    // reason. It also has to be ahead of the loop regardless: inside it, the
    // first undo would already have landed.
    //
    // After the checkpoint lookup, so a checkpoint that does not exist (or
    // belongs to another division) still answers 404 rather than 422 — the
    // ordering `clearScheduleScoped` uses for its own existence check.
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    return Number(cp.seq);
  });
  let steps = 0;
  // R10e: every fixture any step changed, published ONCE when the rewind ends
  // (or stops part-way: the steps that committed stay committed), not once
  // per step — a restore is one organiser write.
  const changed = new Set<string>();
  let scoredFixtureRemoved = false;
  let competitionId = "";
  try {
    // Each undo is its own single-writer append (concurrency-safe); stop once
    // the watermark reaches the checkpoint.
    for (let i = 0; i < 500; i++) {
      const meta = await withTenant(auth.orgId, (tx) => divisionMeta(tx, divisionId));
      competitionId = meta.competition_id;
      const ledger = await withTenant(auth.orgId, (tx) => loadLedger(tx, divisionId));
      const wm = meta.edit_watermark ?? (ledger[ledger.length - 1]?.seq ?? 0);
      if (wm <= target) return { watermark: wm, steps };
      const write = await stepWrite(auth, divisionId, "undo", undefined);
      for (const id of write.fixtureIds) changed.add(id);
      if (write.scoredFixtureRemoved) scoredFixtureRemoved = true;
      steps++;
    }
    throw new HttpError(500, "restore did not converge");
  } finally {
    publishHistoryWrite(auth, divisionId, competitionId, [...changed], scoredFixtureRemoved);
  }
}

// ---------------------------------------------------------------------------
// Scoped clear + remove-teams-in-pool (Jul3/03 §5)
// ---------------------------------------------------------------------------

export const ClearScheduleInput = z.object({
  division_id: z.string().uuid(),
  scope: ClearScope.default({ excludeLocked: true }),
  confirm: z.literal(true), // double-submit guard (Jul3/03 §6)
});
export type ClearScheduleInput = z.infer<typeof ClearScheduleInput>;

// P9 pass 3a: `court` on `ClearableFixture`/its `FixtureSnapshot` is a
// courts.id now, not a free-text label — `@seazn/engine/history`'s own
// `court: string | null` field has always been opaque (no engine logic
// inspects its content, only equality — the same "pure representation
// swap" the scheduling engine's `Assignment.court` already was), so this is
// a value-only change: `clearableFixtures`/`clearPoolEntrants` below both
// read `court_id`, and every downstream `schedule_cleared`/
// `schedule_restored`/`pool_entrants_restored` replay in `execute()` above
// already expects an id.
async function clearableFixtures(tx: Tx, divisionId: string): Promise<ClearableFixture[]> {
  const rows = await tx<{
    id: string; stage_id: string; pool_id: string | null; round_no: number | null;
    court_id: string | null; scheduled_at: string | null; schedule_locked: boolean; status: string;
  }[]>`
    select id, stage_id, pool_id, round_no, court_id, scheduled_at::text as scheduled_at,
           schedule_locked, status
    from fixtures where division_id = ${divisionId}`;
  return rows.map((f) => ({
    id: f.id,
    stageId: f.stage_id,
    poolId: f.pool_id,
    roundNo: f.round_no,
    court: f.court_id,
    at: f.scheduled_at,
    locked: f.schedule_locked,
    decided: f.status === "decided",
  }));
}

export async function clearScheduleScoped(
  auth: AuthCtx,
  input: ClearScheduleInput,
): Promise<{ cleared: number; skipped: { locked: number; decided: number }; seq: number }> {
  const divisionId = input.division_id;
  const write = await withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // Clear is the control whose whole point is that it is destructive, so a
    // frozen board refusing it is the least surprising guard in the file.
    //
    // Same 422, code and sentence as every other board-write refusal — see
    // `step` above for why the list of sibling sites is NOT restated here (it
    // was restated three times in this file, and every copy was wrong). One
    // note that IS worth keeping because it is a trap rather than a list:
    // `moveFixture` (schedule.ts) refuses unconditionally, ahead of its own
    // `movesTimetable` test, so a freeze refuses every patch and not just a
    // reslot — while `patchFixture` (fixtures.ts) is a DIFFERENT function that
    // carries no freeze guard at all.
    //
    // The AI-plan refusals are the same code at a different status: 409, not
    // 422, and `schedule-ai.ts` reads `divisions.schedule_locked` directly
    // rather than through `divisionLockState` (its `divisionLockState` call
    // destructures `scopes` only and never consults `frozen`).
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    const fixtures = await clearableFixtures(tx, divisionId);
    const { event, cleared, skipped } = engineClearSchedule(fixtures, input.scope);
    if (cleared.length === 0) {
      const meta = await divisionMeta(tx, divisionId);
      return {
        out: { cleared: 0, skipped, seq: meta.seq },
        competitionId: division.competition_id,
        fixtureIds: [],
        scoredFixtureRemoved: false,
      };
    }
    const effects = { scoredFixtureRemoved: false };
    const fixtureIds = await execute(tx, divisionId, event, effects);
    const seq = await appendEvent(tx, divisionId, event, auth.userId);
    await tx`update divisions set seq = ${seq}, edit_watermark = null
             where id = ${divisionId}`;
    return {
      out: { cleared: cleared.length, skipped, seq },
      competitionId: division.competition_id,
      fixtureIds,
      scoredFixtureRemoved: effects.scoredFixtureRemoved,
    };
  });
  publishHistoryWrite(auth, divisionId, write.competitionId, write.fixtureIds, write.scoredFixtureRemoved);
  return write.out;
}

export async function clearPoolEntrants(
  auth: AuthCtx,
  poolId: string,
  confirm: boolean,
): Promise<{ removed: number; seq: number }> {
  if (!confirm) throw new HttpError(422, "clear-entrants requires confirm: true");
  const write = await withTenant(auth.orgId, async (tx) => {
    const [pool] = await tx<{ stage_id: string; division_id: string; competition_id: string }[]>`
      select p.stage_id, s.division_id, d.competition_id
      from pools p join stages s on s.id = p.stage_id join divisions d on d.id = s.division_id
      where p.id = ${poolId}`;
    if (!pool) throw new HttpError(404, "pool not found");
    const divisionId = pool.division_id;
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    // Removing a pool's entrants deletes that pool's fixtures — a board edit
    // as destructive as `clearScheduleScoped` a few lines up, which a freeze
    // has always refused. This one never did: it was the widest hole in the
    // freeze, reachable live from POST /api/v1/pools/{id}/clear-entrants.
    //
    // AFTER the pool lookup, so a pool that does not exist (or belongs to
    // another org) still answers 404 rather than 422 — the ordering every
    // sibling in this file uses. BEFORE the fixture read and the engine call,
    // so a frozen division refuses without doing the work.
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    // The snapshot IS the read: the same row `pool_entrants_restored` puts
    // back on Undo (`snapshotFixtures` / `restoreFixtures` above).
    const rows = await snapshotFixtures(tx, { poolId });
    let result;
    try {
      result = engineRemovePool(
        rows.map((f) => ({
          id: f.id,
          stageId: f.stage_id,
          poolId: f.pool_id,
          roundNo: f.round_no,
          court: f.court,
          at: f.at,
          locked: f.locked,
          decided: f.status === "decided",
          snapshot: f,
        })),
        poolId,
      );
    } catch (err) {
      toEngineError(err);
    }
    const effects = { scoredFixtureRemoved: false };
    const fixtureIds = await execute(tx, divisionId, result.event, effects);
    const seq = await appendEvent(tx, divisionId, result.event, auth.userId);
    await tx`update divisions set seq = ${seq}, edit_watermark = null
             where id = ${divisionId}`;
    return {
      out: { removed: result.removed.length, seq },
      divisionId,
      competitionId: pool.competition_id,
      fixtureIds,
      scoredFixtureRemoved: effects.scoredFixtureRemoved,
    };
  });
  // R10e (found beside m1): removing a pool's entrants DELETES its fixtures, so
  // the hub and their match centres drop them the same way.
  publishHistoryWrite(auth, write.divisionId, write.competitionId, write.fixtureIds, write.scoredFixtureRemoved);
  return write.out;
}

// ---------------------------------------------------------------------------
// Division schedule lock + scope locks (Jul3/03 §4)
// ---------------------------------------------------------------------------

export const LockInput = z.object({
  schedule_locked: z.boolean().optional(),
  // P9 pass-3a-FIX: courts/venues are real ids (V374's locked_scopes
  // migration) — `scopeLocked` (schedule.ts) matches on court_id/venue_id,
  // not organiser-typed names. Kept identical by hand to api-v1/schemas.ts's
  // `DivisionLocks` (the OpenAPI doc schema for this same route) — that file
  // is not the runtime validator here, this one is (see the route handler),
  // but the two must not drift.
  locked_scopes: z
    .array(
      z.object({
        courts: z.array(CourtId).optional(),
        venues: z.array(VenueId).optional(),
        pool_ids: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
export type LockInput = z.infer<typeof LockInput>;

export async function setDivisionLocks(
  auth: AuthCtx,
  divisionId: string,
  input: LockInput,
): Promise<{ schedule_locked: boolean; locked_scopes: unknown }> {
  if (input.locked_scopes !== undefined && input.locked_scopes.length > 0) {
    // multi-site scope locking is the Pro layer (Jul3/03 §7)
    await requireFeature(auth.orgId, "schedule.versioning");
  }
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ schedule_locked: boolean; locked_scopes: unknown }[]>`
      update divisions set
        schedule_locked = coalesce(${input.schedule_locked ?? null}, schedule_locked),
        locked_scopes = coalesce(${input.locked_scopes ? tx.json(input.locked_scopes as never) : null}, locked_scopes)
      where id = ${divisionId}
      returning schedule_locked, locked_scopes`;
    if (!row) throw new HttpError(404, "division not found");
    return row;
  });
}

/** State the console renders after undo/redo: the fold at the watermark.
 *
 *  `court` (P9 pass 3a) is a courts.id now, purely by construction — `fold`
 *  is a pure engine replay over whatever the ledger's own `court` fields
 *  hold, and every writer of those (`execute()` above) writes an id since
 *  this pass. Field NAME unchanged (`court`, not `court_id`) — this is
 *  outside pass 3a's file scope (a console/UI concern, pass 4) and a rename
 *  here with no consumer updated to match would be a pointless wire break;
 *  a caller wanting a display name resolves `court` the same way any other
 *  P9 caller does (`courtNamesById` in schedule.ts). */
export async function scheduleStateAt(
  auth: AuthCtx,
  divisionId: string,
): Promise<Record<string, { at: string | null; court: string | null }>> {
  return withTenant(auth.orgId, async (tx) => {
    const meta = await divisionMeta(tx, divisionId);
    const ledger = await loadLedger(tx, divisionId);
    const state = fold(ledger, meta.edit_watermark);
    const out: Record<string, { at: string | null; court: string | null }> = {};
    for (const [id, f] of Object.entries(state.fixtures)) {
      if (f.exists) out[id] = { at: f.at, court: f.court };
    }
    return out;
  });
}
