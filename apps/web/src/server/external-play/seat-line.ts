import "server-only";
// The check-in line (spec §5.7; owner decision C4, 2026-10-15). When the platform's RealtimeKit call budget (video/budget.ts) is
// dry, a Required seat claim is deferred; the line makes WHO gets the next token an order - first come, first served, one place
// per player - instead of luck. It orders who is ADMITTED to spend, and funds them in advance (windowed admission); it grants
// no seat: the camera proof of §5.2 is unchanged.
//
// ONE LEDGER, FOUR FRAGMENTS. `fixture_seat_line` (V461) holds a STAY per (fixture, person). The five columns that say where a
// stay stands - `queued_at`, `last_seen_at`, `last_gate`, `admitted_at`, `completing` - are read ONLY by the four SQL fragments
// below and by `upsertStay` (the stay's arrival and liveness). `seat-line-one-reader.test.ts` forbids every other reader, and
// forbids re-spelling the open-stay test (`served_at is null and ended_at is null`) anywhere but `stayOpenSql`. Everything
// outside this file asks the question through one of the named functions, so every place that asks "is this player in line?"
// gets the same answer for the same stay by construction (the consumers are listed in §5.7.2 and pinned by that guard).
//
// Every fragment names the ledger's rows `l` and takes `now` as a SQL expression, so the caller chooses ONE clock for the whole
// decision (the database's, or the `opts.at` test seam).
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { peekRealtimeKitCall, RTK_BUDGET_REFILL_PER_S } from "@/server/external-play/video/budget";
import {
  CAMERA_EVIDENCE_BACKOFF_MS,
  CAMERA_EVIDENCE_DEADLINE_MS,
  CAMERA_EVIDENCE_MAX_POLLS,
  LINE_NEAR_POSITIONS,
  LINE_ABANDON_AFTER_MS,
  LINE_POLL_MIN_MS,
  LINE_POLL_MS,
  LINE_POLL_SLOW_MS,
  LINE_SERVE_TAIL_S,
  MINT_TO_READ_MS,
  type LineWire,
} from "@/components/public-site/match-room/room-snapshot";
import { boardCap, roomPhase, windowFor, type BoardAnchor, type RoomPhase } from "./window";

type Db = postgres.Sql | postgres.TransactionSql;
type Now = postgres.PendingQuery<postgres.Row[]>;

// ─── Constants (spec §5.7.10): each declared once ─────────────────────────────────────────────────────────────────────────

/** A stay whose last gate event was a HOLD and whose client has not claimed for this long is not in line: four missed slow polls.
 *  Declared in room-snapshot.ts (the card tells the player this number) and re-exported here. */
export { LINE_ABANDON_AFTER_MS };
/** A stay whose last gate event was a PASS stays for this long after it: at least the longest honest gap between a pass and the
 *  next claim, `max(max(CAMERA_EVIDENCE_BACKOFF_MS), MINT_TO_READ_MS) + LINE_POLL_MS` = 34.5 s (a test derives the floor). */
export const LINE_RELEASE_GRACE_MS = 35_000;
/** The calls of a player's minting claim the line funds (the meeting create and the participant add), of one read of a starting
 *  camera (the live session, its participants, the peer report), and of the token handed with a seat. Each is asserted equal to
 *  the fixture server's own count (external-play-line-cost.test.ts). */
export const LINE_MINT_CALLS = 2;
export const LINE_READ_CALLS = 3;
export const LINE_TOKEN_CALLS = 1;
/** What a stay can spend inside ADMIT_HOLD_MS, on the room's own schedule (§5.6.8): the mint, CAMERA_EVIDENCE_MAX_POLLS reads of
 *  a camera still starting, and the seating read with the token handed with the seat. DERIVED, never typed. */
export const LINE_RESERVATION =
  LINE_MINT_CALLS + LINE_READ_CALLS * CAMERA_EVIDENCE_MAX_POLLS + (LINE_READ_CALLS + LINE_TOKEN_CALLS);
/* UNCOVERED OVERSPEND (the capacity build's P1; measured by external-play-line-cost.test.ts, "P1"): the reservation above covers the
 * stay's own schedule, not the room's CLIENT re-claims. After a dead camera's verdict (`camera_required`) the check-in screen, with its
 * camera live, claims the seat again SEAT_RETRIES (3) times, SEAT_RETRY_MS (1.5 s) apart (room-shell.tsx). The stay is admitted and live,
 * so the gate lets each one through with no level check, and each costs a read (LINE_READ_CALLS) and a fresh token (LINE_TOKEN_CALLS)
 * = 4 calls: up to 12 calls a dead-camera stay spends beyond LINE_RESERVATION (a verdict at the fifth read costs 18, then 12 more).
 * Reserving them would raise the reservation from 21 to 33 and move every figure the spec derives from it (the drain, the ETA, the
 * B-slow bound), so it is left out on purpose. The bucket still caps what leaves for the vendor: the overspend borrows from the pool the
 * NEXT admission would have used, so the line's ETAs run optimistic by at most 6 s a dead-camera stay in flight. All of it falls inside
 * LINE_RELEASE_GRACE_MS (the re-claims take 4.5 s), after which the silent stay lapses and its reservation is returned. */
/** The opponent's re-verify (T9's three reads), held beside the reservation of a stay whose seat could complete its board. */
export const LINE_RECHECK_COST = 3;
/** What an idle line's COMPLETING claim must find in the bucket before it goes (spec §5.7.3, the idle bullet): the reads of the seating
 *  claim itself and the token handed with the seat, THEN the opponent's re-verify that the seat's create makes. A level of
 *  `LINE_RECHECK_COST` alone is spent by the claim's own reads before the re-verify runs (measured: spec B, instant cameras, still created
 *  one board 268.7 s late with the check at `LINE_RECHECK_COST`). DERIVED, never typed. */
export const LINE_COMPLETING_LEVEL = LINE_READ_CALLS + LINE_TOKEN_CALLS + LINE_RECHECK_COST;
/** The most ONE claim spends (a re-paired board's minting claim: two stale meetings ended, its own created, the participant
 *  added). Not a threshold; a declared maximum the reservation must cover (asserted). */
export const LINE_CLAIM_COST = 6;
/** The dead-camera bound on an ADMITTED stay, from admission: a camera that never comes on would hold its reservation, and its
 *  protection, to the cap otherwise. The mint-to-read gap, the server's wait for a camera it has seen join, and one back-off step
 *  for the verdict read that follows the deadline. */
export const ADMIT_HOLD_MS = MINT_TO_READ_MS + CAMERA_EVIDENCE_DEADLINE_MS + Math.max(...CAMERA_EVIDENCE_BACKOFF_MS);
/** The gate lock's `lock_timeout`: 1,000 times the few milliseconds the lock is held, and under LINE_POLL_MIN_MS so a busy
 *  claim answers before the client's next poll. */
export const LINE_LOCK_TIMEOUT_MS = 1_000;

const ms = (n: number) => sql`(${n}::float8 * interval '1 millisecond')`;

// ─── The four fragments ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The lapse clause, TIME ONLY: a stay is over when it has been silent for its grace (LINE_ABANDON_AFTER_MS after a hold,
 *  LINE_RELEASE_GRACE_MS after a pass), or - an admitted stay - has held its admission for ADMIT_HOLD_MS. It reads no
 *  `queued_at`, so it answers the same for a stay the budget never held. `cause` splits the two disjuncts for `left` (the
 *  upsert); every other caller takes the whole. */
export function stayLapsedSql(now: Now, cause: "any" | "silent" | "hold" = "any") {
  const silent = sql`${now} - l.last_seen_at >= (case l.last_gate when 'held' then ${ms(LINE_ABANDON_AFTER_MS)} else ${ms(LINE_RELEASE_GRACE_MS)} end)`;
  const hold = sql`(l.admitted_at is not null and ${now} - l.admitted_at >= ${ms(ADMIT_HOLD_MS)})`;
  if (cause === "silent") return sql`(${silent})`;
  if (cause === "hold") return hold;
  return sql`(${hold} or ${silent})`;
}

/** An OPEN stay: not served, not ended, not lapsed. It reads no `queued_at` either, so a stay the budget never held is open
 *  while it is checking in - what "the opponent has a live stay" means for `completing`. The one spelling of the open test. */
export function stayOpenSql(now: Now) {
  return sql`(l.served_at is null and l.ended_at is null and not ${stayLapsedSql(now)})`;
}

/** THE one predicate, `inLine`: the budget has held this stay (`queued_at`) and it is open. With `waiting`, only a stay that is
 *  not yet admitted: a place that is counted in positions. */
export function lineLiveSql(now: Now, opts: { waiting?: boolean } = {}) {
  return sql`(l.queued_at is not null ${opts.waiting ? sql`and l.admitted_at is null` : sql``} and ${stayOpenSql(now)})`;
}

/** The reservation a live ADMITTED stay holds (LINE_RESERVATION, plus LINE_RECHECK_COST while it could complete its board), and
 *  null for every other row: sum it for the pool, test `is not null` for "admitted and live". */
export function reservedSql(now: Now) {
  return sql`(case when l.admitted_at is not null and ${stayOpenSql(now)}
                   then ${LINE_RESERVATION}::int + (case when l.completing then ${LINE_RECHECK_COST}::int else 0 end) end)`;
}

const at = (d: Date): Now => sql`${d}::timestamptz`;

async function dbNow(): Promise<Date> {
  const [row] = await sql<{ now: Date }[]>`select clock_timestamp() as now`;
  return row!.now;
}

/** The arrival a NEW stay is dated at: the instant the claim's window was judged, never later than the gate's own clock `now`.
 *  The window is judged on the application's clock at the top of the claim and the gate reads the database's clock after the room's
 *  whole preamble, so `first_claim_at` on the database's clock alone could fall after a deadline the claim was judged inside - and
 *  protection (`first_claim_at < deadline`, §5.7.8) would then refuse a player who came in time. `least` keeps the ledger's own
 *  invariant (`queued_at >= first_claim_at`, V461) when the application's clock runs AHEAD of the database's. Liveness
 *  (`last_seen_at`, the lapse clauses) stays on the gate's clock: every stay is compared on one clock. */
function arrivalOf(a: Pick<GateAsk, "arrival">, now: Date): Date {
  return a.arrival !== undefined && a.arrival.getTime() < now.getTime() ? a.arrival : now;
}

// ─── The stay's arrival and liveness: the ONE other reader ────────────────────────────────────────────────────────────────

export type Stay = {
  firstClaimAt: Date;
  queuedAt: Date | null;
  admittedAt: Date | null;
  completing: boolean;
  /** This call started a NEW stay (the old one was served, ended or lapsed). */
  restarted: boolean;
  /** Why the OLD stay left the line, when it had been in line and this call replaced it: set once, on the claim that starts the
   *  replacement. `silent` outranks `camera`: a player who stopped asking left, whatever the hold says. */
  left: "silent" | "camera" | null;
};

/** Stamp the stay's arrival (first call, `arrival`) and its liveness (every call, `now`), in ONE statement. A stay is restarted on
 *  `served_at is not null or ended_at is not null or stayLapsedSql` and on nothing else - never on `queued_at`: a stay the
 *  budget has never held keeps its `first_claim_at` across its claims, which is its order key whenever the budget first holds it
 *  (spec §5.7.2, the re-review's N2). The old row is read in the same statement for `left`. */
export async function upsertStay(
  db: Db,
  a: { fixtureId: string; personId: string; budgetKey: string; now: Date; arrival: Date },
): Promise<Stay> {
  const now = at(a.now);
  const restart = sql`(l.served_at is not null or l.ended_at is not null or ${stayLapsedSql(now)})`;
  const [row] = await db<
    {
      first_claim_at: Date;
      queued_at: Date | null;
      admitted_at: Date | null;
      completing: boolean;
      restarted: boolean | null;
      left: "silent" | "camera" | null;
    }[]
  >`
    with old as (
      select (l.queued_at is not null) as was_in_line,
             ${restart} as restart,
             ${stayLapsedSql(now, "silent")} as silent,
             ${stayLapsedSql(now, "hold")} as hold
        from fixture_seat_line l
       where l.fixture_id = ${a.fixtureId} and l.person_id = ${a.personId}
    ), up as (
      insert into fixture_seat_line as l (fixture_id, person_id, budget_key, first_claim_at, last_seen_at, last_gate)
      values (${a.fixtureId}, ${a.personId}, ${a.budgetKey}, ${a.arrival}, ${a.now}, 'passed')
      on conflict (fixture_id, person_id) do update set
        budget_key     = excluded.budget_key,
        first_claim_at = case when ${restart} then excluded.first_claim_at else l.first_claim_at end,
        last_seen_at   = excluded.last_seen_at,
        last_gate      = case when ${restart} then 'passed' else l.last_gate end,
        queued_at      = case when ${restart} then null else l.queued_at end,
        released_at    = case when ${restart} then null else l.released_at end,
        admitted_at    = case when ${restart} then null else l.admitted_at end,
        completing     = case when ${restart} then false else l.completing end,
        served_at      = case when ${restart} then null else l.served_at end,
        ended_at       = case when ${restart} then null else l.ended_at end
      returning l.first_claim_at, l.queued_at, l.admitted_at, l.completing
    )
    select up.first_claim_at, up.queued_at, up.admitted_at, up.completing,
           coalesce(old.restart, false) as restarted,
           case when old.restart and old.was_in_line
                then (case when old.silent then 'silent' when old.hold then 'camera' end) end as left
      from up left join old on true`;
  const r = row!;
  return {
    firstClaimAt: r.first_claim_at,
    queuedAt: r.queued_at,
    admittedAt: r.admitted_at,
    completing: r.completing,
    restarted: r.restarted === true,
    left: r.left,
  };
}

// ─── The gate (spec §5.7.3) ───────────────────────────────────────────────────────────────────────────────────────────────

/** The gate could not take the budget key's lock within LINE_LOCK_TIMEOUT_MS (SQLSTATE 55P03): its ONE named refusal. */
export class SeatLineBusy extends Error {
  /** `left` of the claim that was refused the lock: set once, on the claim that starts a replacement stay, so a busy answer
   *  carries it and the claim after it (which finds the stay already restarted) does not have to. */
  constructor(readonly left: LineWire["left"] = null) {
    super("the check-in line's gate lock was busy");
    this.name = "SeatLineBusy";
  }
}

let busyCount = 0;
/** How many claims the busy refusal has answered in this process (the load test expects 0; the server log carries the same count). */
export function seatLineBusyCount(): number {
  return busyCount;
}

export type GateAsk = {
  fixtureId: string;
  personId: string;
  /** The board's other side, if it has a person. */
  otherPersonId: string | null;
  /** The OTHER side holds a counted check-in (the board's seat could complete it). */
  otherCounted: boolean;
  budgetKey: string;
  anchor: BoardAnchor;
  /** The test seam: the clock of the whole decision. Production passes nothing and the database's clock decides. */
  at?: Date;
  /** The instant the claim's window was JUDGED (`seatPlayer`'s `now`, the application's clock). A NEW stay is dated there (see
   *  `arrivalOf`), so a claim judged inside the window never opens a stay dated after the deadline (final review M-1). */
  arrival?: Date;
  /** The test seam of the concurrent-admission test: called inside the gate's transaction between its read and its decision. */
  afterRead?: () => void | Promise<void>;
};

export type GateAnswer =
  /** The claim may spend. */
  | { kind: "go"; decision: "idle" | "admitted" | "admit" }
  /** Held: nothing is spent; the answer is `queued`. */
  | { kind: "queued"; line: LineWire }
  /** A stay already ADMITTED, under a busy gate: it keeps its admission and the room asks again. */
  | { kind: "camera_starting" };

type Standing = { tokens: number; reserved: number; waiting: number; ahead: number; admittedLive: number; mineAdmitted: boolean; otherOpen: boolean };

/** Everything the decision reads, in one statement under the lock (or, for the busy and deferral answers, without it). */
async function readStanding(db: Db, a: GateAsk, now: Date, mine: Stay): Promise<Standing> {
  const nowSql = at(now);
  const tokens = await peekRealtimeKitCall(a.budgetKey, { at: a.at, db });
  const [s] = await db<
    { reserved: number; waiting: number; ahead: number; admitted_live: number; mine_admitted: boolean; other_open: boolean }[]
  >`
    select
      (select coalesce(sum(${reservedSql(nowSql)}), 0)::int from fixture_seat_line l where l.budget_key = ${a.budgetKey}) as reserved,
      (select count(*)::int from fixture_seat_line l
        where l.budget_key = ${a.budgetKey} and ${lineLiveSql(nowSql, { waiting: true })}) as waiting,
      (select count(*)::int from fixture_seat_line l
        where l.budget_key = ${a.budgetKey} and ${lineLiveSql(nowSql, { waiting: true })}
          and (l.first_claim_at, l.fixture_id, l.person_id)
              < (${mine.firstClaimAt}::timestamptz, ${a.fixtureId}::uuid, ${a.personId}::uuid)) as ahead,
      (select count(*)::int from fixture_seat_line l
        where l.budget_key = ${a.budgetKey} and ${reservedSql(nowSql)} is not null) as admitted_live,
      coalesce((select ${reservedSql(nowSql)} is not null from fixture_seat_line l
                 where l.fixture_id = ${a.fixtureId} and l.person_id = ${a.personId}), false) as mine_admitted,
      ${
        a.otherPersonId === null
          ? sql`false`
          : sql`exists (select 1 from fixture_seat_line l
                         where l.fixture_id = ${a.fixtureId} and l.person_id = ${a.otherPersonId} and ${stayOpenSql(nowSql)})`
      } as other_open`;
  return {
    tokens,
    reserved: s!.reserved,
    waiting: s!.waiting,
    ahead: s!.ahead,
    admittedLive: s!.admitted_live,
    mineAdmitted: s!.mine_admitted,
    otherOpen: s!.other_open,
  };
}

/** What the board's seat would hold if admitted: the reservation, plus the opponent's re-verify while it could complete the board. */
function reservationIf(completing: boolean): number {
  return LINE_RESERVATION + (completing ? LINE_RECHECK_COST : 0);
}

/** The `line` object of a `queued` answer: position among WAITING stays, the estimate to ADMISSION (a conservative upper bound,
 *  below), the poll cadence and the board's cap.
 *
 *  THE ESTIMATE (spec §5.7.9; final review M-2). The stay at `position` is admitted once the pool has grown to what every place
 *  ahead is promised plus its own `need`. The most a place ahead can be promised is `LINE_RESERVATION + LINE_RECHECK_COST` (a
 *  COMPLETING stay: its seat triggers the opponent's re-verify), and the stay's own place is priced at its own `need` (which is that
 *  larger price when IT is completing). The pool refills at `RTK_BUDGET_REFILL_PER_S`, and admission happens at the stay's next
 *  POLL after the pool allows it (§5.7.3), so one `pollMs` of trail is added. Every term is derived from a declared constant. The
 *  old pricing - every place, the stay's own included, at plain `LINE_RESERVATION`, and no trail - told a completing stay at the
 *  front with a pool of 22 that it would wait 0 s while it was held until 24, so the `mayTimeOut` warning (which adds
 *  `LINE_SERVE_TAIL_S` to this number) fired late. It is an upper bound for a wait that the POOL sets, which is what forms a line;
 *  a place ahead that spends less releases the rest, so the true wait is usually shorter. */
export function lineWire(a: {
  position: number;
  pool: number;
  need: number;
  now: Date;
  anchor: BoardAnchor;
  left: LineWire["left"];
  busy?: boolean;
}): LineWire {
  const closesAt = boardCap(a.anchor);
  const secondsToCap = (closesAt.getTime() - a.now.getTime()) / 1_000;
  let pollMs: number;
  if (a.busy) pollMs = LINE_POLL_MIN_MS;
  else if (a.position === 1) {
    // The first waiting stay: when the pool will hold what it would hold, clamped to [the floor, the near cadence].
    const untilMs = (Math.max(0, a.need - a.pool) / RTK_BUDGET_REFILL_PER_S) * 1_000;
    pollMs = Math.min(LINE_POLL_MS, Math.max(LINE_POLL_MIN_MS, Math.ceil(untilMs)));
  } else pollMs = a.position <= LINE_NEAR_POSITIONS ? LINE_POLL_MS : LINE_POLL_SLOW_MS;
  const tokensToAdmit = (a.position - 1) * (LINE_RESERVATION + LINE_RECHECK_COST) + a.need;
  const etaS = Math.ceil(Math.max(0, tokensToAdmit - a.pool) / RTK_BUDGET_REFILL_PER_S + pollMs / 1_000);
  return {
    position: a.position,
    etaS,
    pollMs,
    closesAt: closesAt.toISOString(),
    mayTimeOut: etaS + LINE_SERVE_TAIL_S > secondsToCap,
    left: a.left,
  };
}

/** Pure writes on the stay the gate's own transaction just read (the upsert returned its columns under the lock), so no raw
 *  column is read here. */
async function writeStay(
  db: Db,
  a: { fixtureId: string; personId: string },
  patch: { gate: "held" | "passed"; queuedAt?: Date; admittedAt?: Date; completing?: boolean; releasedAt?: Date },
): Promise<void> {
  await db`
    update fixture_seat_line set
      last_gate = ${patch.gate}
      ${patch.queuedAt ? sql`, queued_at = ${patch.queuedAt}` : sql``}
      ${patch.admittedAt ? sql`, admitted_at = ${patch.admittedAt}` : sql``}
      ${patch.completing === undefined ? sql`` : sql`, completing = ${patch.completing}`}
      ${patch.releasedAt ? sql`, released_at = ${patch.releasedAt}` : sql``}
     where fixture_id = ${a.fixtureId} and person_id = ${a.personId}`;
}

/** The gate for one gated claim: upsert the stay, then - under the budget key's two-key advisory lock - read the bucket's
 *  picture and decide (spec §5.7.3). Throws `SeatLineBusy` when the lock cannot be had in LINE_LOCK_TIMEOUT_MS, and nothing else
 *  it understands; every other error is a defect and propagates as itself. */
export async function gateClaim(a: GateAsk): Promise<GateAnswer> {
  const now = a.at ?? (await dbNow());
  const ids = { fixtureId: a.fixtureId, personId: a.personId };
  // Step 1: arrival and liveness, one statement, OUTSIDE the lock - so a stay's place is its first claim and not the moment it won
  // the lock. `left` is read here: it is set once, on the claim that starts the replacement stay.
  const arrival = arrivalOf(a, now);
  const first = await upsertStay(sql, { ...ids, budgetKey: a.budgetKey, now, arrival });
  const lockStarted = performance.now();
  try {
    return await sql.begin(async (tx) => {
      await tx`select set_config('lock_timeout', ${`${LINE_LOCK_TIMEOUT_MS}ms`}, true)`;
      await tx`select pg_advisory_xact_lock(hashtext('rtk-line'), hashtext(${a.budgetKey}))`;
      const lockWaitMs = Math.round(performance.now() - lockStarted);
      // The state under the lock: a second claim of this very stay (another tab) may have admitted it since step 1.
      const mine = await upsertStay(tx, { ...ids, budgetKey: a.budgetKey, now, arrival });
      // Step 2. The opponent's arrival is applied FIRST (the re-review 2's I-A): the stay on the board's other side now has an
      // opponent who could be seated, so ITS seat could complete the board - and if it is admitted its reservation rises by
      // LINE_RECHECK_COST and the pool falls by it from this instant. A PURE write: it reads none of the guarded columns, and
      // on a stay that is not admitted `completing` is dead data (reservedSql counts it only for an admitted one, and the
      // gate re-evaluates and rewrites it at that stay's admission and at each of its claims after).
      if (a.otherPersonId !== null) {
        await tx`update fixture_seat_line set completing = true where fixture_id = ${a.fixtureId} and person_id = ${a.otherPersonId}`;
      }
      const st = await readStanding(tx, a, now, mine);
      await a.afterRead?.();
      const pool = st.tokens - st.reserved;
      const position = st.ahead + 1;
      const trace = (decision: string) =>
        log.info({ fixtureId: a.fixtureId, decision, position, lockWaitMs, tokens: Math.round(st.tokens * 10) / 10 }, "seat-line: gate decision");

      // Step 3. An ADMITTED, live stay is entitled to its reservation: no level check.
      if (st.mineAdmitted) {
        await writeStay(tx, ids, { gate: "passed", releasedAt: now, completing: st.otherOpen || a.otherCounted });
        trace("go_admitted");
        return { kind: "go", decision: "admitted" } as GateAnswer;
      }
      const hold = async (need: number, why: string): Promise<GateAnswer> => {
        await writeStay(tx, ids, { gate: "held", queuedAt: mine.queuedAt ?? now });
        trace(why);
        return { kind: "queued", line: lineWire({ position, pool, need, now, anchor: a.anchor, left: first.left }) };
      };
      // Could this claim's seat complete its board? (The other side has an open stay or a counted check-in.) Such a seat triggers the
      // create and its T9 re-verify of the opponent, LINE_RECHECK_COST reads that are exempt from the line but not from the bucket.
      const completing = st.otherOpen || a.otherCounted;
      // A new arrival joins the tail without spending: a stay is never admitted ahead of an earlier stay that is waiting.
      if (st.ahead > 0) return hold(reservationIf(completing), "hold_blocked");
      // Idle - this stay is not waiting, nobody is, and no admitted stay is live: today's path, nothing written but the upsert.
      // EXCEPT a COMPLETING claim, which goes only while the bucket holds its own seating reads and token AND the opponent's re-verify
      // (`tokens >= LINE_COMPLETING_LEVEL`): on an idle line nothing is reserved for it, so a bucket that cannot pay the re-verify after
      // the claim's own spend would defer it INSIDE the create, and the board would wait for the sweep (spec §5.7.3, test 37 (e)). Below
      // it the claim is held like any stay that meets a dry bucket (step 4): it becomes a waiting stay, and its next claim pays the pool
      // test with the reservation it would hold.
      if (st.waiting === 0 && st.admittedLive === 0) {
        if (!completing || st.tokens >= LINE_COMPLETING_LEVEL) {
          trace("go_idle");
          return { kind: "go", decision: "idle" } as GateAnswer;
        }
        return hold(reservationIf(completing), "hold_recheck");
      }
      // Next in order: a candidate. It is admitted only while the pool holds the reservation it WOULD hold.
      const need = reservationIf(completing);
      if (pool >= need) {
        await writeStay(tx, ids, { gate: "passed", admittedAt: now, completing, releasedAt: now });
        trace("admit");
        return { kind: "go", decision: "admit" } as GateAnswer;
      }
      return hold(need, "hold_pool");
    });
  } catch (err) {
    if (isLockTimeout(err)) throw new SeatLineBusy(first.left);
    throw err;
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "55P03";
}

/** The answer to a claim whose gate was busy (spec §5.7.3): spends nothing, admits nobody, answers as if the pool were short. A
 *  stay not yet admitted is marked held (so it keeps its place) and answered `queued` at a position read WITHOUT the lock, with
 *  the floor cadence; an ADMITTED stay keeps its admission and is answered `camera_starting`. */
export async function answerBusy(a: GateAsk, left: LineWire["left"] = null): Promise<GateAnswer> {
  busyCount += 1;
  log.warn({ fixtureId: a.fixtureId, busy: busyCount }, "seat-line: gate lock busy; the claim answered as if the pool were short");
  const now = a.at ?? (await dbNow());
  const ids = { fixtureId: a.fixtureId, personId: a.personId };
  const mine = await upsertStay(sql, { ...ids, budgetKey: a.budgetKey, now, arrival: arrivalOf(a, now) });
  const st = await readStanding(sql, a, now, mine);
  if (st.mineAdmitted) {
    await writeStay(sql, ids, { gate: "passed", queuedAt: mine.queuedAt ?? now });
    return { kind: "camera_starting" };
  }
  await writeStay(sql, ids, { gate: "held", queuedAt: mine.queuedAt ?? now });
  const need = reservationIf(st.otherOpen || a.otherCounted);
  return { kind: "queued", line: lineWire({ position: st.ahead + 1, pool: st.tokens - st.reserved, need, now, anchor: a.anchor, left: mine.left ?? left, busy: true }) };
}

/** A deferral MID-CLAIM (exempt traffic took the tokens an admitted stay was funded with, or an idle-line claim met a dry
 *  bucket), spec §5.7.3 step 4. A stay never admitted becomes a waiting stay and is answered `queued`; an ADMITTED stay KEEPS its
 *  admission and reservation, is now in line (the budget has held it), and is answered `camera_starting` with no number. */
export async function settleDeferral(a: GateAsk): Promise<GateAnswer> {
  const now = a.at ?? (await dbNow());
  const ids = { fixtureId: a.fixtureId, personId: a.personId };
  const mine = await upsertStay(sql, { ...ids, budgetKey: a.budgetKey, now, arrival: arrivalOf(a, now) });
  const st = await readStanding(sql, a, now, mine);
  if (st.mineAdmitted) {
    await writeStay(sql, ids, { gate: "passed", queuedAt: mine.queuedAt ?? now });
    return { kind: "camera_starting" };
  }
  await writeStay(sql, ids, { gate: "held", queuedAt: mine.queuedAt ?? now });
  const need = reservationIf(st.otherOpen || a.otherCounted);
  return { kind: "queued", line: lineWire({ position: st.ahead + 1, pool: st.tokens - st.reserved, need, now, anchor: a.anchor, left: mine.left }) };
}

// ─── The end of service (spec §5.7.3 step 5) ──────────────────────────────────────────────────────────────────────────────

/** Service ends after the WHOLE claim, create included: `served_at` on a seat; `ended_at` on `camera_blocked` and
 *  `video_unavailable`, the two answers no wait can fix. A stay has at most one of the two (a table check), so each stamp
 *  refuses a stay the other already closed, and neither overwrites its own: the first word stands. These are PURE writes on
 *  the stay's key - they read none of the five guarded columns and do not re-spell the open test; a claim that was never
 *  gated has no row to stamp, and a stay the gate has restarted this claim is a fresh one. */
export async function endStay(
  a: { fixtureId: string; personId: string; how: "served" | "ended"; at?: Date },
): Promise<void> {
  const now = at(a.at ?? (await dbNow()));
  if (a.how === "served") {
    await sql`
      update fixture_seat_line l set served_at = coalesce(l.served_at, greatest(${now}, l.first_claim_at))
       where l.fixture_id = ${a.fixtureId} and l.person_id = ${a.personId} and l.ended_at is null`;
  } else {
    await sql`
      update fixture_seat_line l set ended_at = coalesce(l.ended_at, greatest(${now}, l.first_claim_at))
       where l.fixture_id = ${a.fixtureId} and l.person_id = ${a.personId} and l.served_at is null`;
  }
}

// ─── Readers of the line, for the places that ask "is this player in line?" ───────────────────────────────────────────────

/** Consumer 3 (§5.7.2): is the caller's OWN stay in line? It picks the door the claim counts under. */
export async function ownStayInLine(a: { fixtureId: string; personId: string; at?: Date }): Promise<boolean> {
  const now = at(a.at ?? (await dbNow()));
  const [row] = await sql<{ in_line: boolean }[]>`
    select exists (select 1 from fixture_seat_line l
                    where l.fixture_id = ${a.fixtureId} and l.person_id = ${a.personId} and ${lineLiveSql(now)}) as in_line`;
  return row!.in_line;
}

/** Consumer 9 (§5.7.2): is the line ACTIVE in this bucket - a live in-line stay or a live admitted stay? An optional claim and the
 *  camera-token ask make no vendor call while it is. */
export async function lineActive(a: { budgetKey: string; at?: Date }): Promise<boolean> {
  const now = at(a.at ?? (await dbNow()));
  const [row] = await sql<{ active: boolean }[]>`
    select (exists (select 1 from fixture_seat_line l where l.budget_key = ${a.budgetKey} and ${lineLiveSql(now)})
         or exists (select 1 from fixture_seat_line l where l.budget_key = ${a.budgetKey} and ${reservedSql(now)} is not null)) as active`;
  return row!.active;
}

/** The arrival (`first_claim_at`) of the caller's stay, for dating a check-in seated under the deadline protection (§5.7.8). */
export async function ownStayArrival(a: { fixtureId: string; personId: string }): Promise<Date | null> {
  const [row] = await sql<{ first_claim_at: Date }[]>`
    select l.first_claim_at from fixture_seat_line l where l.fixture_id = ${a.fixtureId} and l.person_id = ${a.personId}`;
  return row?.first_claim_at ?? null;
}

// ─── The deadline and the line (spec §5.7.8) ──────────────────────────────────────────────────────────────────────────────

export type Board = { fixtureId: string; anchor: BoardAnchor };
export type CountedFacts = { own: boolean; both: boolean };
/** Who is asking: a player (`personId`) or the board itself (`null`: the sweep, the create, the teardown). `facts` are the
 *  counted check-ins the asker already holds, or a reader for them; asked only when the question reaches the grace. */
export type PhaseViewer = {
  personId: string | null;
  facts: CountedFacts | (() => Promise<CountedFacts>);
  /** The question is "is the board's CREATE still owed?" (T9's allowance, §5.7.8): it rests on BOTH players' check-ins counting,
   *  and a protected player on one side alone owes it nothing. The line is then not asked at all. */
  bothOnly?: boolean;
};

/** The line's part of the deadline protection, ONE query: is there a PROTECTED player on the board? Protected = in line (the one
 *  predicate), arrived in time (`first_claim_at` before the deadline: a claim AT the deadline is `window_closed`, so no stay
 *  exists from it) - and the cap, which the caller has already applied. `own` is the viewer's own stay. */
export async function lineHoldsBoard(a: { board: Board; now: Date; personId: string | null }): Promise<{ own: boolean; any: boolean }> {
  const nowSql = at(a.now);
  const deadline = windowFor(a.board.anchor).deadline;
  const [row] = await sql<{ own: boolean; any: boolean }[]>`
    select coalesce(bool_or(l.person_id = ${a.personId}::uuid), false) as own, count(*) > 0 as any
      from fixture_seat_line l
     where l.fixture_id = ${a.board.fixtureId} and l.first_claim_at < ${deadline}::timestamptz and ${lineLiveSql(nowSql)}`;
  return { own: row!.own, any: row!.any };
}

/** THE phase reader for every place the deadline matters (§5.7.8): the seat's admission, the room's phase per viewer, the create
 *  allowance, the no-show skip and the teardown all call this, and the pure window arithmetic in window.ts stays pure.
 *
 *  Inside the window, and before it, the answer is the window's. PAST the deadline and before the cap, a board is held `open` for
 *  - a viewer whose OWN stay is protected, or who holds a counted check-in while the board's create is owed (the other side is
 *    protected, or both sides are counted);
 *  - the board itself (`personId` null) while any side is protected or both are counted.
 *  At and past the cap it is `closed` for everyone. */
export async function boardPhase(now: Date, board: Board, viewer: PhaseViewer): Promise<RoomPhase> {
  const base = roomPhase(now, board.anchor);
  if (base !== "closed") return base;
  if (now.getTime() >= boardCap(board.anchor).getTime()) return "closed";
  const facts = typeof viewer.facts === "function" ? await viewer.facts() : viewer.facts;
  if (viewer.bothOnly) return facts.both ? "open" : "closed";
  const held = await lineHoldsBoard({ board, now, personId: viewer.personId });
  if (viewer.personId === null) return held.any || facts.both ? "open" : "closed";
  return held.own || (facts.own && (held.any || facts.both)) ? "open" : "closed";
}
