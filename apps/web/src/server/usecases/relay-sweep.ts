import "server-only";
// server/usecases/relay-sweep.ts — the DAILY sweep behind POST /api/cron/relay-sweep (design §6.3 row; owner ruling
// 2026-09-14: "just run every day is fine"). Because it runs once a day it owns NOTHING time-critical: every timeout,
// the retry and the wall clock fire lazily on reads (stream-sessions.ts, recommendation B). Here, in this order:
//   1. BACKSTOP — the same reconcileSession (expiry PLUS one Machine observation) over every non-terminal session AND
//      every terminal one whose runner is still alive (C27), for the session nobody reads; per-session
//      pg_try_advisory_xact_lock, so a concurrent sweep skips what the other holds. NOT applyExpiry: expiry alone cannot
//      see a Machine that died WITHOUT our stop, or one already auto-destroyed. A TERMINAL row still `lost` after the
//      reconcile gets its force_destroy re-issued (2C-post m1). One visit that throws is counted and reported; the pass
//      goes on.
//   2. ORPHANS — every Machine the runner lists that its session does not own is destroyed through stream-sessions.ts's
//      shared forceDestroy (A22(b)): no session, a TERMINAL session (A22(a), on every pass), or a live session whose row
//      names another Machine — and ONLY a Machine stamped with this environment's identity (I1): an untagged or foreign
//      one is counted and reported, never destroyed. Then MARK every terminal composed session whose Machine is absent
//      from TWO listings a settle window apart (V422, A22(c), m1) so admission can skip the provider for it.
//   3. HEADROOM — C3's number from the fitted storage reading (G7), warned when below one retained match.
//   4. RETENTION — retentionPlan (domain/retention.ts) over the port's ONE video listing, restricted to recordings whose
//      input this database owns (I1(c)), and the terminal inputs; videos
//      BEFORE inputs (C2), inputs re-planned over what the pass actually deleted; a 409 is reported and retried tomorrow;
//      a FULL page is flagged, never read as the whole set (A13).
//   5. VIDEO FACTS (ruling 13 item 5, Dd), 6. SUMMARIES, 7. SAMPLE RETENTION, 8. ONE storage snapshot.
import { sql, type Tx } from "@/lib/db";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { EST_COST_CURRENCY, MAX_DURATION_MINUTES, SAMPLE_RETENTION_DAYS, relayEnvironment } from "@/server/relay/config";
import { retentionPlan, type RetainedInput, type RetainedVideo } from "@/server/relay/domain/retention";
import { machineNameFor, type RunnerState } from "@/server/relay/domain/runner";
import { isTerminal, type FailReason, type SessionState } from "@/server/relay/domain/session";
import { LIST_VIDEOS_PAGE_LIMIT } from "@/server/relay/ingest-cf";
import type { IngestVideo, RunnerListing } from "@/server/relay/ports";
import { recordEvent, recordStorageSnapshot } from "@/server/relay/telemetry";
import {
  ACTIVE_STATES, TERMINAL_STATES, type SessionDeps,
  apply, destroyListedMachine, estimateCostMinor, reconcileSession, storageHeadroomMinutes, storageUsageForColumns,
} from "./stream-sessions";

export interface SweepResult {
  // One bucket per OUTCOME, not per cause: F18/F19 gave every non-terminal state a timed exit, and an outcome with no
  // bucket makes a sweep that fixed something report zeros. `candidates` = visited + skippedLocked + errored.
  backstop: {
    candidates: number; visited: number; skippedLocked: number; errored: number;
    warmingTimedOut: number;        // no_inbound_timeout | machine_boot_timeout
    provisionTimedOut: number;      // F18 — a failure
    admissionTimedOut: number;      // F18/F23 — a failure
    endingTimedOut: number;         // F22 — a COMPLETION: the session ended as asked, by its ending deadline
    graceForced: number;            // 2C-post m2 — a COMPLETION whose Machine never auto-destroyed: F-A forced it
    completedObserved: number;      // a COMPLETION the observation saw land normally (the Machine auto-destroyed)
    retried: number;                // G3: a create call made during the visit
    crashed: number;                // machine_* failures
    wallClockEnded: number;
    terminalRunnersSettled: number; // C27: a terminal session's runner advanced (the session state did not)
    otherFailures: number;          // a failure the backstop's own rules do not produce — a visit that raced another request
  };
  runnerListing: "listed" | "not_needed" | "failed";
  machinesListed: number;
  orphansDestroyed: number; orphanDestroysFailed: number;
  foreignRunnersSkipped: number;   // I1: orphan-shaped Machines this environment cannot PROVE it created — never destroyed
  runnerGoneConfirmed: number;     // V422 marks written THIS pass
  runnerGoneDeferred: number;      // m1: gone from the first listing, but not yet from a confirming second one
  videosListed: number; listingTruncated: boolean;
  videosDeleted: number; videosDeferred: number; inputsDeleted: number; inputsDeferred: number; retentionFailed: number;
  foreignVideosSkipped: number;    // I1(c): past retention, but traceable to no input this database owns — never deleted
  headroomMinutes: number;
  videosSeen: number; recordingsFinalised: number; summariesWritten: number; samplesDeleted: number;   // ruling 13 + Dd
}

export type BackstopBucket = Exclude<keyof SweepResult["backstop"], "candidates" | "visited" | "skippedLocked" | "errored">;

/** A test-only scope that was handed an EMPTY list. `org_id in ()` is not a query, and an empty list silently read as
 *  "no filter" would sweep the whole database from a caller that meant to sweep nothing. */
export class SweepScopeEmpty extends Error {
  constructor() {
    super("relay sweep: orgIds is empty — omit it to sweep every organisation, or name at least one");
    this.name = "SweepScopeEmpty";
  }
}

/** The per-session advisory key two concurrent sweeps contend on. Namespaced so it can never collide with the org money
 *  lock (`stream-credits-org:<id>`, stream-credits.ts lockOrg). Exported for the lock test. */
export const sweepSessionLockKey = (sessionId: string) => `relay-sweep-session:${sessionId}`;

const failureBucket = (reason: FailReason | null): BackstopBucket => {
  switch (reason) {
    case "no_inbound_timeout": case "machine_boot_timeout": return "warmingTimedOut";
    case "provision_timeout": return "provisionTimedOut";
    case "admission_timeout": return "admissionTimedOut";
    case "machine_create_failed": case "machine_exit_nonzero": case "machine_oom": case "machine_crash": return "crashed";
    // Produced by the organiser's poll (target_rejected) and the go-live consume (no_credits), never by the backstop's
    // expiry + observation — so a visit that reads one raced another request. Counted apart, never folded into a timeout.
    case "target_rejected": case "no_credits": return "otherFailures";
    // A failed session always carries its reason (session.ts `fail`); a null one is not something the report can name.
    case null: return "otherFailures";
  }
};

/** The backstop's outcome for one visit, from the row BEFORE it and the session AFTER it. Pure; exported for its table
 *  test. `completingExpiry` is the expiry kind on the session's own transition row into `completed` (eventRowsOf), read
 *  only for an ending → completed visit — the authority for "how did it complete", never inferred from the runner. */
export function backstopOutcome(
  before: { state: SessionState; runnerState: RunnerState; runnerAttempts: number },
  after: { state: SessionState; failReason: FailReason | null; runner: { state: RunnerState; attempt: number } },
  completingExpiry: string | null,
): BackstopBucket | null {
  // C27: a terminal row cannot fail, retry or complete again — only its runner can move.
  if (isTerminal(before.state)) return after.runner.state !== before.runnerState ? "terminalRunnersSettled" : null;
  if (after.state === "failed") return failureBucket(after.failReason);
  // G3 (Task 2C re-review 1): a RETRY is a create call made during this visit — the attempt moved. `runnerRetries` does not
  // move when a `destroyed × stale_beat` re-signal finally runs the retry a dead process owed, and can move on a decision
  // whose `retry_runner` then no-ops (M1).
  if (after.runner.attempt > before.runnerAttempts) return "retried";
  if (after.state === "completed" && before.state === "ending") {
    // 2C-post m2: F-A completes an ending composed session whose Machine never auto-destroyed by the expiry's
    // grace_expired — "Fly never destroyed the Machine" is its own number. An ending_timeout is F22's completion. Anything
    // else (a runner observation, no expiry at all) is the ordinary completion the organiser's poll would have seen.
    if (completingExpiry === "grace_expired") return "graceForced";
    if (completingExpiry === "ending_timeout") return "endingTimedOut";
    return "completedObserved";
  }
  if ((after.state === "ending" || after.state === "completed") && (before.state === "live" || before.state === "warming")) return "wallClockEnded";
  return null;
}

/** The ownership rule for one LISTED Machine (Task 12's orphan rule; the lazy admission twin is tearDownPriorMachines).
 *  Pure; exported for its table. */
export function isOrphan(
  m: Pick<RunnerListing, "runnerId" | "name">,
  row: { id: string; state: SessionState; runner_state: RunnerState; runner_attempts: number; runner_name: string | null; machine_id: string | null } | null,
): boolean {
  if (!row) return true;                            // no session owns it
  if (isTerminal(row.state)) return true;           // A22(a): an ended session owns no Machine — on EVERY pass
  // C6/A35: invariant 4 persists `creating` + the attempt before the create call, and machine_id only after it returns,
  // so while creating the row cannot name its Machine by id. m4: nor by `runner_name`, which can be null — and a rule
  // keyed on it read EVERY Machine of such a row as an orphan, the in-flight create's included. The Machine's OWN name
  // carries its session and attempt (T5-a, `machineNameFor`), and `runner_attempts` was bumped when `creating` was
  // persisted, so it IS the current attempt. An orphan is proven only by a name from an EARLIER attempt of this session;
  // the current attempt's Machine, an unnamed one or any other name proves nothing — kept (fail closed: this destroys).
  if (row.runner_state === "creating") {
    for (let k = 1; k < row.runner_attempts; k++) if (m.name === machineNameFor(row.id, k)) return true;
    return false;
  }
  // Otherwise the row names its Machine by id; a listed Machine it does not name — a stale create's, or one whose forced
  // destroy failed — has no other retry owner on a live session (A22(b)). A row with no machine_id owns none.
  return row.machine_id === null || m.runnerId !== row.machine_id;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read on the visit's own transaction (m2): a pooled read here would take a THIRD connection beside the advisory tx and
 *  reconcileSession's row-lock tx. */
async function completingExpiry(tx: Tx, sessionId: string): Promise<string | null> {
  const [row] = await tx<{ expiry: string | null }[]>`
    select payload->>'expiry' as expiry from fixture_stream_events
     where session_id = ${sessionId} and kind = 'transition' and to_state = 'completed'
     order by seq desc limit 1`;
  return row?.expiry ?? null;
}

async function destroySessionless(m: RunnerListing, deps: SessionDeps): Promise<boolean> {
  try {
    await deps.drivers.runner.destroy(m.runnerId);
    return true;
  } catch (err) {
    captureError(err, { route: "relay.sweep.orphan", extra: { machineId: m.runnerId, machineName: m.name } });
    log.error({ machineId: m.runnerId, machineName: m.name, err: String(err) }, "relay sweep: a sessionless Machine's destroy failed — reported; the next pass retries it");
    return false;
  }
}

export async function sweepStreamSessions(
  deps: SessionDeps,
  opts: { sampleRetentionDays?: number | null; orgIds?: readonly string[] } = {},
): Promise<SweepResult> {
  const now = deps.now();
  const sampleRetentionDays = opts.sampleRetentionDays === undefined ? SAMPLE_RETENTION_DAYS : opts.sampleRetentionDays;
  // TEST-ONLY scope. The cron route passes no options (route.test.ts pins it). Every selection of SESSIONS is scoped;
  // the storage headroom is not — recording storage is one account-wide pool.
  const orgIds = opts.orgIds === undefined ? undefined : [...opts.orgIds];
  if (orgIds !== undefined && orgIds.length === 0) throw new SweepScopeEmpty();
  // The pass judges the database AS OF ITS OWN CLOCK: a session created after `now` is not yet this pass's business
  // (m3). In production `now` is the wall clock, so this admits every row but one created in the last instant of clock
  // skew, which the next daily pass takes; a test that runs the UNSCOPED path sets the clock before every other file's
  // rows and sweeps only its own.
  const inScope = () => sql`and created_at <= ${now} ${orgIds ? sql`and org_id in ${sql(orgIds)}` : sql``}`;
  const inScopeS = () => sql`and s.created_at <= ${now} ${orgIds ? sql`and s.org_id in ${sql(orgIds)}` : sql``}`;

  const out: SweepResult = {
    backstop: {
      candidates: 0, visited: 0, skippedLocked: 0, errored: 0,
      warmingTimedOut: 0, provisionTimedOut: 0, admissionTimedOut: 0, endingTimedOut: 0, graceForced: 0, completedObserved: 0,
      retried: 0, crashed: 0, wallClockEnded: 0, terminalRunnersSettled: 0, otherFailures: 0,
    },
    runnerListing: "not_needed", machinesListed: 0, orphansDestroyed: 0, orphanDestroysFailed: 0, foreignRunnersSkipped: 0,
    runnerGoneConfirmed: 0, runnerGoneDeferred: 0,
    videosListed: 0, listingTruncated: false,
    videosDeleted: 0, videosDeferred: 0, inputsDeleted: 0, inputsDeferred: 0, retentionFailed: 0, foreignVideosSkipped: 0,
    headroomMinutes: 0, videosSeen: 0, recordingsFinalised: 0, summariesWritten: 0, samplesDeleted: 0,
  };

  // 1. BACKSTOP — every non-terminal session, PLUS (C27) every session whose runner has not finished dying: `reconcileSession`
  //    advances the runner sub-machine and leaves a terminal session's own state untouched, so visiting one is safe.
  const candidates = await sql<{ id: string; org_id: string }[]>`
    select id, org_id from fixture_stream_sessions
     where (state in ${sql([...ACTIVE_STATES])} or runner_state not in ('none', 'destroyed')) ${inScope()}
     order by created_at`;
  out.backstop.candidates = candidates.length;
  for (const c of candidates) {
    try {
      // The advisory lock lives in this transaction, so the visit pins ONE pooled connection while reconcileSession works
      // on others (at most two at once for the whole sweep — it is sequential and daily).
      const visit = (await sql.begin(async (tx) => {
        const [{ ok }] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${sweepSessionLockKey(c.id)})) as ok`;
        if (!ok) return "locked" as const;
        const [cur] = await tx<{ state: SessionState; runner_state: RunnerState; runner_attempts: number }[]>`
          select state, runner_state, runner_attempts from fixture_stream_sessions where id = ${c.id}`;
        if (!cur) return null;
        let after = await reconcileSession(c.id, deps);   // expiry + ONE Machine observation, row-locked on the pooled client
        if (!after) return null;
        // 2C-post m1: a TERMINAL session holding a `lost` runner has no lazy re-issue — the organiser's poll skips terminal
        // rows, `lost × observed running` has no effect and `evaluate` answers `none` — so its Machine would reach only the
        // orphan pass, which destroys it but leaves this row `lost` (and visited here) forever. Re-issue the teardown the one
        // way C27 accepts on a terminal row: `expire grace_expired` → `lost × grace_expired` → force_destroy, whose
        // `destroy_ok` settles the row. Gated under the row lock: another request may have settled it since
        // (`destroyed × grace_expired` is ✗).
        if (after.mode === "composed" && isTerminal(after.state) && after.runner.state === "lost") {
          after = (await apply(c.id, (s) => (isTerminal(s.state) && s.runner.state === "lost" ? { type: "expire", expiry: { kind: "grace_expired" } } : null), deps)) ?? after;
        }
        const before = { state: cur.state, runnerState: cur.runner_state, runnerAttempts: cur.runner_attempts };
        const expiry = before.state === "ending" && after.state === "completed" ? await completingExpiry(tx, c.id) : null;
        return { bucket: backstopOutcome(before, after, expiry), failReason: after.failReason };
      })) as "locked" | null | { bucket: BackstopBucket | null; failReason: FailReason | null };
      if (visit === "locked") { out.backstop.skippedLocked++; continue; }
      out.backstop.visited++;
      if (visit?.bucket) out.backstop[visit.bucket]++;
      if (visit?.bucket === "otherFailures") log.warn({ sid: c.id, failReason: visit.failReason }, "relay sweep: a visit ended in a failure the backstop does not produce — another request raced it");
    } catch (err) {
      out.backstop.errored++;
      captureError(err, { orgId: c.org_id, route: "relay.sweep.backstop", extra: { sessionId: c.id } });
      log.error({ sid: c.id, err: String(err) }, "relay sweep: a backstop visit failed — counted and reported; the pass goes on");
    }
  }

  // 2. ORPHANS. The provider is asked only once a composed session in scope has EVER held a runner: composed is disabled
  //    this wave and a live server may have no FLY_API_TOKEN (drivers.ts lazyRunner), so a passthrough-only account never
  //    calls Fly. A listing that fails is reported and the pass goes on — retention must not wait on Fly.
  const [{ needed }] = await sql<{ needed: boolean }[]>`
    select exists (select 1 from fixture_stream_sessions where mode = 'composed' and runner_state <> 'none' ${inScope()}) as needed`;
  let listed: RunnerListing[] = [];
  if (needed) {
    try {
      listed = await deps.drivers.runner.list();
      out.runnerListing = "listed";
    } catch (err) {
      out.runnerListing = "failed";
      captureError(err, { route: "relay.sweep.runner_list" });
      log.error({ err: String(err) }, "relay sweep: the runner listing failed — no Machine judged or marked this pass");
    }
  }
  out.machinesListed = listed.length;
  const survivors = new Set<string>();   // sessions whose listed Machine is still there after this pass
  if (listed.length > 0) {
    // I1: one Fly app can be listed by more than one database (a staging clone of production, a shared default app), and
    // "no row here owns it" is exactly what ANOTHER environment's live Machine looks like from this one. Absence is never
    // a licence to destroy: only a Machine stamped with THIS environment's identity at create (RunnerSpec.environment) is
    // ours to judge. Live mode without ENV_NAME never gets here: the runner refuses to construct, so the listing above
    // failed and nothing is judged; `relayEnvironment` refuses the same case again rather than guess an identity.
    const ownEnv = relayEnvironment();
    // A listing's session id comes from the Machine's metadata. One that is not a uuid names no session — and would 22P02
    // the whole `id in (…)` — so it is judged as sessionless instead.
    const ids = [...new Set(listed.map((m) => m.sessionId).filter((x): x is string => x !== null && UUID.test(x)))];
    const rows = ids.length
      ? await sql<{ id: string; org_id: string; state: SessionState; runner_state: RunnerState; runner_attempts: number; runner_name: string | null; machine_id: string | null }[]>`
          select id, org_id, state, runner_state, runner_attempts, runner_name, machine_id from fixture_stream_sessions where id in ${sql(ids)}`
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const foreign: { machineId: string; machineName: string | null; environment: string | null }[] = [];
    for (const m of listed) {
      const row = m.sessionId ? (byId.get(m.sessionId) ?? null) : null;
      if (row && orgIds && !orgIds.includes(row.org_id)) continue;   // another org's session: not this scoped run's to judge
      // T12-a: this pass DESTROYS; it never feeds `orphan_listed` to `decide` (`playing × orphan_listed` is ✗).
      if (!isOrphan(m, row)) { if (row) survivors.add(row.id); continue; }
      if (m.environment !== ownEnv) {
        // Untagged or another environment's: counted and reported, never touched. It also still EXISTS, so a row it
        // names is not confirmed gone below.
        foreign.push({ machineId: m.runnerId, machineName: m.name, environment: m.environment });
        if (row) survivors.add(row.id);
        continue;
      }
      let ok: boolean;
      try {
        ok = row ? ((await destroyListedMachine(row.id, m, deps)) ?? (await destroySessionless(m, deps))) : await destroySessionless(m, deps);
      } catch (err) {
        // forceDestroy rethrows a LEDGER fault (its provider failures are already `false`): the DELETE may or may not
        // have happened, so the Machine is not called gone.
        ok = false;
        captureError(err, { orgId: row?.org_id, route: "relay.sweep.orphan", extra: { sessionId: row?.id ?? null, machineId: m.runnerId } });
      }
      if (ok) {
        out.orphansDestroyed++;
        log.warn({ machineId: m.runnerId, sid: m.sessionId, reason: row ? `session ${row.state}` : "no session" }, "relay sweep: orphan Machine destroyed");
      } else {
        out.orphanDestroysFailed++;
        if (row) survivors.add(row.id);
      }
    }
    out.foreignRunnersSkipped = foreign.length;
    if (foreign.length > 0) {
      // ONCE per pass, however many: a shared app lists the other environment's whole fleet every day.
      captureError(new Error(`relay sweep: ${foreign.length} orphan-shaped Machine(s) not stamped with this environment were left untouched`), {
        route: "relay.sweep.foreign_runners", extra: { count: foreign.length, environment: ownEnv, sample: foreign.slice(0, 10) },
      });
      log.warn({ count: foreign.length, environment: ownEnv, sample: foreign.slice(0, 10) }, "relay sweep: Machines this environment cannot prove it created were skipped — never destroyed");
    }
  }
  // A22(c): a terminal composed session whose runner is `destroyed` and whose Machine the listing no longer carries (or
  //    carried and this pass destroyed) is confirmed gone — marked once, so admission skips the provider for it. Only from
  //    a listing that arrived. m1: ONE listing is not proof of absence — Fly's list is eventually consistent and the window
  //    is undocumented (runner-fly.ts `adoptNamed`: the refusal id is "the only handle that works inside Fly's
  //    undocumented list-consistency window"). So absence must hold across TWO listings separated by the provider's own
  //    settle (`listSettleMs`, the house's number for that window). A confirmed destroy alone could not prove it either:
  //    the Machine the first listing missed has an id nobody here knows, so no destroy was ever issued for it — and most
  //    rows reach `destroyed` by Fly's auto-destroy, which no destroy call confirms. A row the second listing still names,
  //    or any row when the second listing fails, is deferred to tomorrow's pass. A create that returns after both for such
  //    a row is either adopted (destroyed → lost, which unskips the row) or destroyed as stale by forceDestroy, whose
  //    failure clears the mark.
  if (out.runnerListing === "listed") {
    const keep = [...survivors];
    const due = (await sql<{ id: string }[]>`
      select id from fixture_stream_sessions
       where mode = 'composed' and runner_state = 'destroyed' and state in ${sql([...TERMINAL_STATES])}
         and runner_gone_confirmed_at is null ${inScope()} ${keep.length ? sql`and id not in ${sql(keep)}` : sql``}`).map((r) => r.id);
    if (due.length > 0) {
      let gone: string[] = [];
      try {
        if (deps.drivers.runner.listSettleMs > 0) await new Promise((res) => setTimeout(res, deps.drivers.runner.listSettleMs));
        const still = new Set((await deps.drivers.runner.list()).map((m) => m.sessionId).filter((x): x is string => x !== null));
        gone = due.filter((id) => !still.has(id));
      } catch (err) {
        captureError(err, { route: "relay.sweep.runner_list_confirm" });
        log.error({ err: String(err), due: due.length }, "relay sweep: the confirming runner listing failed — no session marked gone this pass");
      }
      out.runnerGoneDeferred = due.length - gone.length;
      if (gone.length > 0) {
        // The conditions again, under the UPDATE: a row adopted (destroyed → lost) between the two reads is not marked.
        const marked = await sql<{ id: string }[]>`
          update fixture_stream_sessions set runner_gone_confirmed_at = ${now}
           where id in ${sql(gone)} and mode = 'composed' and runner_state = 'destroyed' and state in ${sql([...TERMINAL_STATES])}
             and runner_gone_confirmed_at is null
          returning id`;
        out.runnerGoneConfirmed = marked.length;
      }
    }
  }

  // 3. HEADROOM — reservations included, expired-but-unread excluded: the same function admission uses, on the reading
  //    fitted to the integer columns (G7).
  const usage = storageUsageForColumns(await deps.drivers.ingest.storageUsage());
  out.headroomMinutes = await storageHeadroomMinutes(sql, usage, now);
  if (out.headroomMinutes < MAX_DURATION_MINUTES) {
    log.warn({ headroomMinutes: out.headroomMinutes, ...usage, reservedForOneMatch: MAX_DURATION_MINUTES }, "relay sweep: recording storage headroom below one retained match");
  }

  // 4. RETENTION — the domain plans, the sweep executes, videos before inputs (C2). ONE listing per run feeds retention
  //    AND the video facts (step 5): a second list doubles a paid call every day.
  const listedVideos: IngestVideo[] = await deps.drivers.ingest.listVideos({ createdBefore: now });
  out.videosListed = listedVideos.length;
  // A13 (owner-confirmed 2026-09-28): the adapter sends `limit = LIST_VIDEOS_PAGE_LIMIT` and paging is UNMEASURED, so a
  // FULL page means "there may be more", never "that is all". Flagged and warned — never read as the whole set.
  out.listingTruncated = listedVideos.length >= LIST_VIDEOS_PAGE_LIMIT;
  if (out.listingTruncated) {
    log.warn({ videosListed: listedVideos.length, pageLimit: LIST_VIDEOS_PAGE_LIMIT }, "relay sweep: the video listing came back a full page — the tail may be missing; no input is deleted on it");
  }
  const videos: RetainedVideo[] = listedVideos.map((v) => ({ videoId: v.videoId, inputId: v.inputId, createdAt: new Date(v.createdAt), inProgress: v.inProgress }));
  // I1(c): the Stream account is shared the same way the Fly app can be, so a recording is deleted ONLY when it traces to a
  // live input THIS database owns — an inputs row that still holds the uid, or a session's slot-0 uid (kept after the
  // input itself is deleted). Unscoped on purpose: ownership is the database's, not a test scope's. A recording with no
  // input, or another environment's, is counted and left to Cloudflare's own 30-day deleteRecordingAfterDays floor.
  const namedInputs = [...new Set(videos.map((v) => v.inputId).filter((x): x is string => x !== null))];
  const owned = new Set(namedInputs.length === 0 ? [] : (await sql<{ uid: string }[]>`
    select ingest_input_id as uid from fixture_stream_inputs where ingest_input_id in ${sql(namedInputs)}
    union
    select ingest_input_uid as uid from fixture_stream_sessions where ingest_input_uid in ${sql(namedInputs)}`).map((r) => r.uid));
  const isOwned = (v: RetainedVideo) => v.inputId !== null && owned.has(v.inputId);
  const ownedVideos = videos.filter(isOwned);
  out.foreignVideosSkipped = retentionPlan(videos.filter((v) => !isOwned(v)), [], now).deleteVideos.length;
  if (out.foreignVideosSkipped > 0) {
    log.warn({ count: out.foreignVideosSkipped }, "relay sweep: recordings past retention that trace to no input this database owns were left untouched");
  }
  const inputs: RetainedInput[] = (await sql<{ id: string; ingest_input_id: string; state: SessionState; ended_at: string | null }[]>`
    select i.id, i.ingest_input_id, s.state, s.ended_at from fixture_stream_inputs i
      join fixture_stream_sessions s on s.id = i.session_id
     where i.ingest_input_id is not null ${inScopeS()}`).map((r) => ({
    inputRowId: r.id, ingestInputId: r.ingest_input_id, sessionTerminal: isTerminal(r.state), sessionEndedAt: r.ended_at ? new Date(r.ended_at) : null,
  }));
  const gone = new Set<string>();
  for (const videoId of retentionPlan(ownedVideos, inputs, now).deleteVideos) {
    try {
      const res = await deps.drivers.ingest.deleteVideo(videoId);
      if (res === "deleted") { out.videosDeleted++; gone.add(videoId); }
      else if (res === "absent") gone.add(videoId);
      else { out.videosDeferred++; log.info({ videoId }, "relay sweep: recording still finalising, retry tomorrow"); }
    } catch (err) {
      out.retentionFailed++;
      captureError(err, { route: "relay.sweep.retention", extra: { videoId } });
      log.error({ videoId, err: String(err) }, "relay sweep: a recording's delete failed — the next pass retries it");
    }
  }
  // C2: an input goes only once NO listed video names it. Planned over what REMAINS after this pass's deletes — one plan
  // from the pre-delete listing would still see the deleted recording naming the input and defer it another day. On a
  // truncated listing nothing proves an input unnamed, and deleteInput leaks every recording it still has: all deferred.
  const inputPlan = retentionPlan(videos.filter((v) => !gone.has(v.videoId)), inputs, now);
  if (out.listingTruncated) {
    out.inputsDeferred = inputPlan.deleteInputs.length + inputPlan.deferInputs.length;
  } else {
    out.inputsDeferred = inputPlan.deferInputs.length;
    for (const i of inputPlan.deleteInputs) {
      try {
        await deps.drivers.ingest.deleteInput(i.ingestInputId);
        await sql`update fixture_stream_inputs set ingest_input_id = null where id = ${i.inputRowId}`;
        out.inputsDeleted++;
      } catch (err) {
        out.retentionFailed++;
        captureError(err, { route: "relay.sweep.retention", extra: { inputRowId: i.inputRowId } });
        log.error({ inputRowId: i.inputRowId, err: String(err) }, "relay sweep: an input's delete failed — its id is kept; the next pass retries it");
      }
    }
  }

  // 5. VIDEO FACTS (ruling 13 item 5 + Dd): which recordings each session produced, how long and how big, and ONE
  //    `recording_finalised` event per finalised video — from the listing taken BEFORE this pass's deletes.
  const byInput = new Map<string, IngestVideo[]>();
  for (const v of listedVideos) if (v.inputId) byInput.set(v.inputId, [...(byInput.get(v.inputId) ?? []), v]);
  for (const [inputId, group] of byInput) {
    const [owner] = await sql<{ id: string; org_id: string }[]>`
      select id, org_id from fixture_stream_sessions where ingest_input_uid = ${inputId} ${inScope()}`;
    if (!owner) continue;
    // Cloudflare reports -1/0 while `live-inprogress` (the adapter maps them to null); clamping at 0 makes an in-flight
    // recording contribute nothing instead of SUBTRACTING.
    const seconds = group.reduce((a, v) => a + Math.max(0, Math.round(v.durationSeconds ?? 0)), 0);
    const bytes = group.reduce((a, v) => a + Math.max(0, Math.round(v.sizeBytes ?? 0)), 0);
    const written = (await sql.begin(async (tx) => {
      await tx`select id from fixture_stream_sessions where id = ${owner.id} for update`;
      // `greatest`, never a plain SET: retention deletes a session's recordings one listing at a time, so after the older
      // one goes the listing's sum is SMALLER than what the session recorded. The facts are monotone — a recording that
      // existed does not un-exist — and the uids are a union for the same reason.
      const [f] = await tx<{ ended_at: string | null; recording_seconds: number; machine_seconds: number; guest_cpus: number | null; guest_memory_mb: number | null; guest_cpu_class: string | null }[]>`
        update fixture_stream_sessions
           set video_uids = (select coalesce(array_agg(distinct u order by u), '{}') from unnest(video_uids || ${sql.array(group.map((v) => v.videoId))}::text[]) u),
               recording_seconds = greatest(recording_seconds, ${seconds}),
               recording_bytes = greatest(recording_bytes, ${bytes})
         where id = ${owner.id}
        returning ended_at, recording_seconds, machine_seconds, guest_cpus, guest_memory_mb, guest_cpu_class`;
      // Df, the second half: the terminal transition wrote the estimate while recording_seconds was still 0 — the sweep is
      // what LEARNS it. The same pure function (one authority), and only for a session that has ended.
      if (f!.ended_at) {
        const minor = estimateCostMinor({ recordingSeconds: f!.recording_seconds, machineSeconds: f!.machine_seconds, guestCpus: f!.guest_cpus, guestMemoryMb: f!.guest_memory_mb, guestCpuClass: f!.guest_cpu_class });
        if (minor !== null) await tx`update fixture_stream_sessions set est_cost_minor = ${minor}, est_cost_currency = ${EST_COST_CURRENCY} where id = ${owner.id}`;
      }
      // Dd: one event per FINALISED video, idempotent per uid — keyed on the uids already recorded, read under the row
      // lock, so a video that finalises later still gets its row and yesterday's get no second one.
      const seen = new Set((await tx<{ uid: string | null }[]>`
        select payload->>'videoUid' as uid from fixture_stream_events where session_id = ${owner.id} and type = 'recording_finalised'`).map((r) => r.uid));
      let n = 0;
      for (const v of group) {
        if (v.inProgress || seen.has(v.videoId)) continue;
        await recordEvent(tx, {   // A10: inside the transaction, under the row lock that orders its seq
          sessionId: owner.id, orgId: owner.org_id, source: "ingest", kind: "observed", type: "recording_finalised", result: "ok", occurredAt: now,
          payload: { videoUid: v.videoId, sizeBytes: v.sizeBytes, durationSeconds: v.durationSeconds, width: v.width, height: v.height, videoState: v.state, errorReasonCode: v.errorReasonCode },
        });
        n++;
      }
      return n;
    })) as number;
    out.videosSeen += group.length;
    out.recordingsFinalised += written;
  }

  // 6. per-session sample SUMMARIES — once per ended session (they survive sample retention).
  const summarised = await sql<{ id: string }[]>`
    update fixture_stream_sessions s
       set sample_summary = agg.summary
      from (select session_id,
                   jsonb_build_object('count', count(*), 'fpsMin', min(fps), 'fpsAvg', avg(fps), 'fpsMax', max(fps),
                                      'bitrateMin', min(bitrate_kbps), 'bitrateAvg', avg(bitrate_kbps), 'bitrateMax', max(bitrate_kbps),
                                      'stalls', count(*) filter (where ingest_state is not null and ingest_state not in ('connected','playing'))) as summary
              from fixture_stream_samples group by session_id) agg
     where agg.session_id = s.id and s.sample_summary is null and s.ended_at is not null and s.state in ${sql([...TERMINAL_STATES])} ${inScopeS()}
     returning s.id`;
  out.summariesWritten = summarised.length;

  // 7. raw-sample RETENTION — behind the constant (owner ruling: 90 days); deletes ONLY where the summary already exists (C15).
  if (sampleRetentionDays !== null) {
    const cutoff = new Date(now.getTime() - sampleRetentionDays * 86_400_000);
    const deleted = await sql<{ id: number }[]>`
      delete from fixture_stream_samples p using fixture_stream_sessions s
       where s.id = p.session_id and s.sample_summary is not null and s.ended_at < ${cutoff} ${inScopeS()}
       returning p.id`;
    out.samplesDeleted = deleted.length;
  }

  // 8. ONE storage snapshot per run, on the fitted reading (its CHECK: headroom = limit − used − reserved, in integers).
  await recordStorageSnapshot(sql, {
    source: "sweep", takenAt: now, usedMinutes: usage.totalStorageMinutes, limitMinutes: usage.totalStorageMinutesLimit,
    reservedMinutes: usage.totalStorageMinutesLimit - usage.totalStorageMinutes - out.headroomMinutes, headroomMinutes: out.headroomMinutes,
    videosDeleted: out.videosDeleted, inputsDeleted: out.inputsDeleted, deferred: out.videosDeferred + out.inputsDeferred,
  });

  log.info({ ...out, scoped: orgIds !== undefined }, "relay sweep");
  return out;
}
