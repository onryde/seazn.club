import "server-only";
// The pre-mint pass (check-in capacity spec 2026-11-05 §11; owner rulings R3 and 2026-11-17 (2)).
//
// A room costs one vendor call and the vendor's limit is the account's, so the cheapest place to pay for the rooms of a
// round is BEFORE its window opens, a call a second, instead of inside the window where every player's first claim pays for
// its own. This job makes those rooms, and ONLY rooms: through `ensureMeeting` with its own capped, paced budget, for every
// board of an UNOPENED round in an online, camera-on division, the round that opens next first. A board with no pairing yet
// (a placeholder: the Swiss shells, a round a void put back) gets rooms stamped for no pairing (both entrant columns null:
// "unadopted"), which the first claim on the paired board adopts. A paired board's rooms are stamped with its pairing.
//
// What it never does (ruling 2026-11-17 (2)): adopt a room (`adoptRooms` is the claim's), make a participant, or look at a
// board whose round is open or a side that has ANY room on file - current, unadopted, an earlier pairing's, or ended. A stale
// or ended row is the claim's and the sweep's to retire, so a candidate never has a row and `ensureMeeting`'s own adoption
// branch is unreachable from here. The job leaves no ended room behind: it only creates, and an unadopted room that a later
// sweep ends is that sweep's (Task 8) to delete, never this job's.
//
// A billing-FROZEN competition's rows are deferred, not made (Match Day O4, ruling MD-R16 2026-11-20): its round cannot be opened
// (`openRound` refuses it with the freeze's 402), so a room made for it is vendor spend on a round that cannot start. The pass asks
// `frozenCompetitionIds` once per org, in the pass - NOT a `frozen_at` predicate in the candidate SQL, because the mark is stored
// lazily (the first read that finds the org over its limit chooses and stores it). The rows stay candidates (the sweep's teardown
// must not end the rooms already made for them) and keep their place: the first pass after the freeze lifts makes them.
//
// The pass is OFF unless EXTERNAL_PLAY_PREMINT is exactly "1": a flag-off environment reports `disabled` (not a failure) BEFORE
// the lock is taken, so a minute with the flag off can never report `skipped` (a failure counter for the cron Worker) because
// some other pass held the lock. With the flag on it is one pass at a time (the sweep's lock shape), and it shares the cron
// Worker's 60 s budget the way the sweep does: PREMINT_PASS_BUDGET_MS stops it STARTING work, PREMINT_CALL_INTERVAL_MS paces
// the vendor calls, and `callCap` bounds them. The vendor calls are enforced in ONE place - the budget handed to the adapter -
// because that is the one place every vendor request passes through, a sibling room's retirement inside `ensureMeeting`
// included. The per-club flag asks (PostHog, a remote call that can hang to its own timeout) never pass through it, and a club
// the flag keeps off makes no vendor request at all, so the row loop checks the same wall-clock budget before every row.
import { sql } from "@/lib/db";
import { SWISS_BYE_SHELL_EXT_KEY_SQL_PATTERN } from "@/lib/swiss-shell";
import { log } from "@/server/logger";
import { anyCheckinWindowOpen, windowDeferralOn } from "@/server/external-play/round-open";
import {
  RealtimeKitDeferred,
  RealtimeKitError,
  cappedBudget,
  ensureMeeting,
  platformSpend,
  type RealtimeKitDeps,
} from "@/server/external-play/video/realtimekit";
import type { CallBudget } from "@/server/external-play/video/budget";
import { onlinePlayDivisionWhere } from "./guard";
import { frozenCompetitionIds } from "../entitlement-freeze";
import { onlineChessOffered } from "./online-chess-flag";
import { PLAYABLE_STATUSES, codeOf } from "./sweep/pass";

/** The pause between two vendor requests: a pass never bursts. The pause is ADDED to each request's own round trip, so a pass
 *  starts a request every (interval + round trip) and reaches fewer than PREMINT_CALLS_PER_PASS: with a round trip of 200 ms
 *  that is 38 in 45 s, and a hundred boards' 200 rooms take five or six one-a-minute passes on the production
 *  trigger. */
export const PREMINT_CALL_INTERVAL_MS = 1_000;
/** The pass stops STARTING work - a vendor request, or a row (so a club's flag ask) - once this much wall-clock time has gone:
 *  the cron Worker abandons a job at 60 s (apps/cron-worker/src/call.ts JOB_TIMEOUT_MS) and the sweep's own budget
 *  (SWEEP_PASS_BUDGET_MS) is the same 45 s. A request already in flight when it runs out may still run to its own timeout
 *  (the adapter's, or the flag ask's), and the scan before the loop is not bounded by it. */
export const PREMINT_PASS_BUDGET_MS = 45_000;
/** The CEILING on a pass's vendor requests, not what it reaches: the wait is added to each request's own round trip, so a 45 s
 *  pass starts a request every (interval + round trip), and fewer than this when the vendor is not instant. It is the bound that
 *  holds when something else (the clock, the platform's bucket) has not stopped the pass first. */
export const PREMINT_CALLS_PER_PASS = Math.floor(PREMINT_PASS_BUDGET_MS / PREMINT_CALL_INTERVAL_MS);
/** A vendor that fails this many rooms IN A ROW is down for the pass: the rest is deferred instead of asked, one warn and one
 *  failure per row for every candidate of every minute being what a down vendor would otherwise cost. A success resets it. */
export const PREMINT_FAILURES_BEFORE_BREAK = 3;
/** The one-pass-at-a-time advisory lock's name (`hashtext`). */
export const PREMINT_LOCK = "external-play-premint";

/** The cron Worker reads `data.failed` and `data.skipped` as its failure counters (apps/cron-worker/src/schedule.ts), and
 *  apps/cron-worker/test/drift.test.ts finds each field's numeric declaration in this module's CODE. */
export type PremintReport = {
  /** 1: another pass held the lock, so this one looked at nothing. The sweep's meaning, and a failure counter for the Worker:
   *  a pass that overlaps the next firing ran for a minute. Never anything else. */
  skipped: number;
  /** 1: EXTERNAL_PLAY_PREMINT is not "1", so the pass did nothing. Not a failure: a flag-off environment must not page every
   *  minute. */
  disabled: number;
  /** Candidate (board, side) rows examined. */
  scanned: number;
  /** Rooms the pass made (a successful `ensureMeeting`: a claim that made the same room first would be counted too). */
  roomsMade: number;
  /** Rows NOT started: the call cap, the pass budget or the platform's bucket ran out, the club is not offered online
   *  chess, or the competition is billing-frozen (MD-R16). They keep their place; the next pass reaches them. Never a failure. */
  deferred: number;
  /** `failures.length`, derived ONCE as the pass returns. */
  failed: number;
  /** 1: a check-in window was open (R3: any round of the scope opened up to ROUND_WINDOW_TAIL_MS ago), so the pass made no vendor
   *  call and counted every candidate `deferred`. Informational, not a failure. */
  windowsOpen: 0 | 1;
  /** One per row whose `ensureMeeting` threw: a code, never a message (the report is returned to the cron caller). */
  failures: { fixtureId: string; side: "home" | "away"; code: string }[];
};

export type PremintCandidate = { fixtureId: string; orgId: string; competitionId: string; side: "home" | "away" };

export type PremintDeps = {
  /** TEST SEAM - scope the pass to these orgs. Production passes none and serves every org; an EMPTY list matches nothing. */
  orgIds?: readonly string[];
  /** The RealtimeKit transport (its `budget` is the platform's bucket the pass's own cap composes with). */
  rtk?: RealtimeKitDeps;
  /** TEST SEAM - the pass's call cap. Default PREMINT_CALLS_PER_PASS. Must be a non-negative integer: `cappedBudget` refuses
   *  anything else by name rather than fail open. */
  callCap?: number;
  /** TEST SEAM - `false` runs the pass without the one-pass lock, so a test is not skipped by another file's pass. */
  serialise?: false;
  /** TEST SEAM - the wall clock the pass budget is measured on. Default Date.now. */
  wallClock?: () => number;
  /** The pacing wait (PREMINT_CALL_INTERVAL_MS between vendor requests); a test passes a no-op. */
  wait?: (ms: number) => Promise<void>;
  /** Is online chess offered to this club (the PostHog flag, online-chess-flag.ts)? Asked once per club per pass. */
  offered?: (asker: { orgId: string; userId: null }) => Promise<boolean>;
  /** TEST SEAM - is a check-in window open (owner ruling R3, "as the sweep does")? Asked ONCE per pass, after the flag and the lock.
   *  Default: `windowDeferralOn() && anyCheckinWindowOpen(sql, now, deps.orgIds)` - the REAL scoped check. Production passes none. */
  windowsOpen?: () => Promise<boolean>;
};

function emptyReport(over: Partial<Pick<PremintReport, "skipped" | "disabled">> = {}): PremintReport {
  return { skipped: 0, disabled: 0, scanned: 0, roomsMade: 0, deferred: 0, failed: 0, windowsOpen: 0, failures: [], ...over };
}

/**
 * THE board half of the candidate rule, for the aliases `f` (fixtures), `s` (stages), `d` (divisions) and `c` (competitions): a
 * board is wanted when its division is an online one (`onlinePlayDivisionWhere`: the division's half of the online-board
 * rule alone - its started-division conjunct would refuse the paired Swiss round-1 board of a division still in setup, which
 * R3 wants), the division has started OR the board is paired (the first arm is the negation of `divisionScoringClosed`,
 * lib/division-phase.ts; the second is there because Swiss shells and round-1 pairings exist before Start, and a placeholder
 * in a division still in setup is never wanted; a COMPLETED division is never wanted either: nothing of it will be opened), the camera policy is not `off` (the SQL form of camera-policy.ts
 * `effectivePolicy`: the nearest set level wins, the competition's is NOT NULL), the fixture is playable, it is not an UNSEATED
 * Swiss bye shell (a bye has nobody to meet: two creates and, once the round's first pass ends them, four more calls per bye per
 * round - `isSwissByeShellExtKey` and no seat filled, the SQL form of `isUnseatedSwissByeShell`; the `coalesce` is load-bearing: a
 * fixture with no ext_key reads NULL against the pattern, and `not (null and ...)` would drop the board), and its round has never been
 * opened.
 *
 * It is the ONE spelling of "a board the pre-mint job still wants": the sweep's teardown asks its NEGATION to decide that a
 * never-opened room belongs to a board that left the set (check-in capacity G2: the two jobs' predicates are disjoint by
 * construction, so the sweep never ends a room this job would make again, and no pass of either undoes the other).
 */
export function premintBoardWhere() {
  return sql`${onlinePlayDivisionWhere()}
         and (d.status not in ('setup', 'scheduled') or (f.home_entrant_id is not null and f.away_entrant_id is not null))
         and d.status <> 'completed'
         and coalesce(s.camera_policy, d.camera_policy, c.camera_policy) <> 'off'
         and f.status in ${sql(PLAYABLE_STATUSES as string[])}
         and not (coalesce(f.ext_key ~ ${SWISS_BYE_SHELL_EXT_KEY_SQL_PATTERN}, false) and f.home_entrant_id is null and f.away_entrant_id is null)
         and not exists (select 1 from stage_round_opens po where po.stage_id = f.stage_id and po.round_no = f.round_no)`;
}

/**
 * "A board the pre-mint job no longer wants": the TOTAL negation of `premintBoardWhere`, which the sweep's teardown asks (G2). `is not
 * true`, not `not`: a NULL rule is "not a candidate" to the candidate query (a NULL `where` drops the row), so it must read LEFT here,
 * and `not (null)` is NULL - a board that is in neither set, ended by nobody and made by nobody. Today no conjunct of the rule can be
 * NULL (every column it reads is NOT NULL or coalesced), so this is the guard that keeps the two jobs disjoint AND exhaustive if one ever
 * is. `rule` is a seam for the test that witnesses exactly that; production passes nothing.
 */
export function premintBoardLeftWhere(rule: ReturnType<typeof premintBoardWhere> = premintBoardWhere()) {
  return sql`(${rule}) is not true`;
}

/**
 * The candidate (board, side) rows, nearest round first. One statement.
 *
 * A BOARD is wanted when `premintBoardWhere` says so. A SIDE is wanted when no `fixture_video_meetings` row exists for it,
 * whatever that row is.
 *
 * The order is the point of a capped pass: the round whose earliest board is scheduled first leads, unscheduled rounds come
 * after every scheduled one, lowest round number first; inside a round the rest is a stable tie-break. The round's key is
 * taken over its BOARDS, before the side filter, so it does not move as the round's own rooms are made - a key taken after
 * the filter would let a round's earliest board leave the set and hand the lead to a round that opens later.
 */
export async function premintCandidates(orgIds?: readonly string[]): Promise<PremintCandidate[]> {
  const scope = orgIds === undefined ? sql`` : sql`and c.org_id in ${sql(orgIds as string[])}`;
  return sql<PremintCandidate[]>`
    with boards as (
      select f.id, f.stage_id, f.round_no, f.seq_in_round, c.org_id, c.id as competition_id,
             min(f.scheduled_at) over (partition by f.stage_id, f.round_no) as round_at
        from fixtures f
        join stages s on s.id = f.stage_id
        join divisions d on d.id = f.division_id
        join competitions c on c.id = d.competition_id
       where ${premintBoardWhere()}
         ${scope}
    )
    select b.id as "fixtureId", b.org_id as "orgId", b.competition_id as "competitionId", sd.side
      from boards b
     cross join (values ('home'), ('away')) as sd(side)
     where not exists (select 1 from fixture_video_meetings m where m.fixture_id = b.id and m.side = sd.side)
     order by b.round_at asc nulls last, b.round_no asc, b.org_id, b.stage_id, b.seq_in_round, sd.side`;
}

export async function premintExternalPlay(deps: PremintDeps = {}): Promise<PremintReport> {
  // The flag first, BEFORE the lock: a flag-off pass does nothing, so it must not contend for the lock (a held lock would make it
  // report `skipped`, which the Worker counts as a failure) and takes no connection. The one place the flag is read.
  if (process.env.EXTERNAL_PLAY_PREMINT !== "1") return emptyReport({ disabled: 1 });
  if (deps.serialise === false) return runPass(deps);
  // One pass at a time: a NON-BLOCKING, TRANSACTION-scoped advisory lock (the sweep's shape, sweep/run.ts): the pass runs
  // inside the transaction that holds it, so it is released however the pass ends - commit, a throw, a dropped connection.
  let report: PremintReport | null = null;
  try {
    await sql.begin(async (tx) => {
      const [lock] = await tx<{ got: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${PREMINT_LOCK})) as got`;
      if (!lock?.got) return;
      report = await runPass(deps);
    });
  } catch (err) {
    // The pass itself threw: the caller hears it. A pass that FINISHED and whose lock transaction then failed to end cleanly
    // still ran - its report stands; the lock went with the transaction either way.
    if (report === null) throw err;
    log.warn({ message: err instanceof Error ? err.message : String(err) }, "external-play premint: the pass lock's transaction ended badly");
  }
  return report ?? emptyReport({ skipped: 1 });
}

/**
 * The pass's own budget, in the one place every vendor request passes through (the adapter takes one token per request, so a
 * sibling room's retirement inside `ensureMeeting` is paced and capped too). In order: the call cap composed over `inner` -
 * the platform's bucket - which `cappedBudget` never reaches past the cap (and refuses a cap that is not a count); then the
 * pacing wait before every request after the first; then the wall-clock budget, judged AFTER the wait so no request is STARTED
 * past it. A refusal is a RealtimeKitDeferred in the adapter: nothing was made, nothing is wrong, the rest of the pass is
 * deferred. A refused request makes no call, so it does not wait. The wall-clock refusal is STICKY, as the cap's is: once the
 * budget is spent no later request is granted whatever the clock reads next (a clock that steps back must not reopen it), and
 * none takes a token from `inner`. Exported for its own tests.
 */
export function premintBudget(a: {
  cap: number;
  inner: CallBudget | null;
  wait: (ms: number) => Promise<void>;
  clock: () => number;
  startedAt: number;
}): CallBudget {
  const capped = cappedBudget(a.cap, a.inner);
  let granted = 0;
  let over = false;
  return async (key) => {
    if (over) return false;
    if (!(await capped.budget(key))) return false;
    if (granted > 0) await a.wait(PREMINT_CALL_INTERVAL_MS);
    if (a.clock() - a.startedAt >= PREMINT_PASS_BUDGET_MS) {
      over = true;
      return false;
    }
    granted += 1;
    return true;
  };
}

async function runPass(deps: PremintDeps): Promise<PremintReport> {
  const report = emptyReport();
  const clock = deps.wallClock ?? Date.now;
  const startedAt = clock();
  const rtk = deps.rtk ?? {};
  const budget = premintBudget({
    cap: deps.callCap ?? PREMINT_CALLS_PER_PASS,
    inner: rtk.budget ?? platformSpend(rtk),
    wait: deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    clock,
    startedAt,
  });
  const vendor: RealtimeKitDeps = { ...rtk, budget };

  // R3, "as the sweep does": while a check-in window is open every vendor call belongs to a player's claim, so the pass makes none
  // (not even the flag ask: nothing is started) and counts every candidate deferred. Read ONCE, after the flag and the lock.
  const windowOpen = await (deps.windowsOpen ?? (async () => windowDeferralOn() && (await anyCheckinWindowOpen(sql, new Date(), deps.orgIds))))();
  const rows = await premintCandidates(deps.orgIds);
  report.scanned = rows.length;
  if (windowOpen) {
    report.windowsOpen = 1;
    report.deferred = rows.length;
    return report;
  }
  const offered = deps.offered ?? onlineChessOffered;
  const asked = new Map<string, Promise<boolean>>();
  const offeredTo = (orgId: string): Promise<boolean> => {
    let answer = asked.get(orgId);
    if (answer === undefined) {
      answer = offered({ orgId, userId: null });
      asked.set(orgId, answer);
    }
    return answer;
  };

  // MD-R16: the org's frozen competitions, read once per org the pass reaches (`frozenCompetitionIds` may choose and store the freeze on
  // its first read, and is asked outside any `withTenant`: this pass holds none). MD-R20: a read that FAILS is that org's alone - logged
  // once (the answer is kept for the pass, so its rows share the one catch), and `null` here means "unknown": the org's rows are deferred,
  // FAIL CLOSED (a competition that might be frozen gets no vendor call), while every other org's rooms are still made. The org then
  // mints on demand at its open, as before the pre-mint, if the read keeps failing.
  const frozenByOrg = new Map<string, Promise<Set<string> | null>>();
  const frozenIn = (orgId: string): Promise<Set<string> | null> => {
    let set = frozenByOrg.get(orgId);
    if (set === undefined) {
      set = frozenCompetitionIds(orgId).catch((err: unknown) => {
        log.error({ orgId, err }, "external-play premint: an organisation's freeze could not be read; its rows are deferred");
        return null;
      });
      frozenByOrg.set(orgId, set);
    }
    return set;
  };

  let vendorErrorsInARow = 0;
  for (let i = 0; i < rows.length; i++) {
    // The pass's wall-clock budget, before the row's flag ask: that ask is a remote call outside `premintBudget`, and a club it
    // keeps off never reaches a vendor request, so nothing else would stop a slow flag service from costing one ask per club
    // past the Worker's 60 s. The rest keeps its place; the next pass starts from the top.
    if (clock() - startedAt >= PREMINT_PASS_BUDGET_MS) {
      report.deferred += rows.length - i;
      log.info({ remaining: rows.length - i }, "external-play premint: the pass budget is spent; the rest keeps its place");
      break;
    }
    const row = rows[i]!;
    // A frozen competition cannot open its round, so no room is made for it; the row keeps its place for the pass after the thaw.
    // An org whose freeze could not be read (`null`) is held the same way.
    const frozen = await frozenIn(row.orgId);
    if (frozen === null || frozen.has(row.competitionId)) {
      report.deferred += 1;
      continue;
    }
    if (!(await offeredTo(row.orgId))) {
      report.deferred += 1;
      continue;
    }
    try {
      await ensureMeeting(row.fixtureId, row.side, vendor, { unpaired: "allow" });
      report.roomsMade += 1;
      vendorErrorsInARow = 0;
    } catch (err) {
      // The cap, the pass budget or the platform's bucket refused a request: the budget is the pass's, not the row's, so every
      // later row would be refused the same way. The rest keeps its place and the next pass starts from the top.
      if (err instanceof RealtimeKitDeferred) {
        report.deferred += rows.length - i;
        log.info(
          { fixtureId: row.fixtureId, side: row.side, remaining: rows.length - i },
          "external-play premint: the call budget is spent; the rest keeps its place",
        );
        break;
      }
      const code = codeOf(err);
      report.failures.push({ fixtureId: row.fixtureId, side: row.side, code });
      // The report stays code-only; the server log carries what diagnoses it (the message, never a token: every message the
      // adapter builds is token-free by construction).
      log.warn(
        { fixtureId: row.fixtureId, side: row.side, code, message: err instanceof Error ? err.message : String(err) },
        "external-play premint: a board's room could not be made",
      );
      // RealtimeKit is not configured here: no row can be made, so the pass reports it ONCE (one failure, which pages) and
      // defers the rest, instead of one failure and one warn per candidate every minute.
      const unconfigured = err instanceof RealtimeKitError && err.code === "unconfigured";
      // A vendor that has failed PREMINT_FAILURES_BEFORE_BREAK rooms in a row is down: stop asking it. Only a vendor error
      // counts, and only a success resets: a row's own refusal (a fixture that vanished since the scan) says nothing of the
      // vendor either way.
      if (err instanceof RealtimeKitError) vendorErrorsInARow += 1;
      if (unconfigured || vendorErrorsInARow >= PREMINT_FAILURES_BEFORE_BREAK) {
        report.deferred += rows.length - i - 1;
        break;
      }
    }
  }
  report.failed = report.failures.length;
  return report;
}
