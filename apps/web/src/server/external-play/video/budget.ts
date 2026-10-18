import "server-only";
// The platform-wide RealtimeKit call budget (T17B fix 2, D21; review I2).
//
// RealtimeKit's REST API allows 1,200 calls per five minutes for the WHOLE account. Past it EVERY call is refused
// for five minutes — a seat, the sweep's teardown, an arbiter's join, for every club at once. So the account's
// budget is a platform resource, and every call (realtimekit.ts `cfEnvelope`, the one place that makes one) spends
// from a token bucket first. Over budget the call is NOT made: it is deferred (`RealtimeKitDeferred`), and each
// caller decides what a deferral means — never "no camera", never an outage.
//
// WHY A BUCKET. A bucket of capacity B refilled at r per second can pass at most B + r*W calls in ANY window W (the
// burst plus the window's refill) — a sliding-window bound, which a per-minute counter does not give (it passes
// twice the limit across a minute boundary). The ceiling is 900, 75% of the vendor's limit: the margin is for the
// calls this process does not meter (none today) and the vendor's own window not being ours. It is split as a burst
// of 300 (a round of boards opening at once must not queue behind a trickle) plus 2 per second.
//
// WHY POSTGRES. Fly runs more than one web machine and the limit is the account's, so the bucket must be shared; and
// the repo's other limiter (lib/rate-limit.ts) is Redis-only and INERT wherever Redis is not configured — local dev,
// the e2e suite and the D22 load test — which would leave this guard unmeasured exactly where it is tested. One
// UPDATE takes a token (refill by elapsed time, then spend one only if there is one), so concurrent machines can
// never spend the same token; the row lock serialises them. The clock is the DATABASE's, so machine clock skew
// cannot mint tokens.
//
// What is stored is the bucket's STATE only. Its size and rate are the constants below, applied on every use, so
// retuning is a code change and needs no migration.
import type postgres from "postgres";
import { sql } from "@/lib/db";

/** The vendor's published limit: RealtimeKit REST calls per account per five minutes. */
export const RTK_VENDOR_LIMIT_PER_WINDOW = 1_200;
export const RTK_BUDGET_WINDOW_MS = 5 * 60_000;
/** What this process lets through in ANY five-minute window: 75% of the vendor's limit. */
export const RTK_CALLS_PER_WINDOW = 900;
/** The bucket's capacity. B + r*W = RTK_CALLS_PER_WINDOW, so the burst is spent out of the same ceiling. */
export const RTK_BUDGET_BURST = 300;
/** Tokens per second: what is left of the ceiling after the burst, over the window. */
export const RTK_BUDGET_REFILL_PER_S = (RTK_CALLS_PER_WINDOW - RTK_BUDGET_BURST) / (RTK_BUDGET_WINDOW_MS / 1_000);

/** A spender: true = the call may be made. realtimekit.ts takes one per request. */
export type CallBudget = (key: string) => Promise<boolean>;

/** The bucket a call spends from: the vendor HOST and the ACCOUNT. The limit is per account at one vendor, so a test's
 *  fixture vendor (another host:port) is another bucket and cannot starve the shared one, and nor can another account. */
export function budgetKey(baseUrl: string, accountId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}|${accountId}`;
}

/** The bucket's level as of `asOf`, refilled by the time since it was last stamped, capped at the burst, elapsed floored at
 *  zero. THE one formula: the spender (`takeRealtimeKitCall`) and the reader (`peekRealtimeKitCall`) both build on it, so the
 *  level the line sees is the level a take would find. The row is the alias `b`. */
function refilledTokens(asOf: postgres.PendingQuery<postgres.Row[]>) {
  return sql`least(${RTK_BUDGET_BURST}::float8,
    b.tokens + ${RTK_BUDGET_REFILL_PER_S}::float8 * greatest(0, extract(epoch from (${asOf} - b.refilled_at))::float8))`;
}

/**
 * Take one call's token from `key`'s bucket. True: spent, make the call. False: none left, do not.
 *
 * `opts.at` is a test seam - the clock of the statement; production passes nothing and the database's own clock
 * decides. `opts.clockSql` is a second one, for the property `at` cannot show: it is a SQL expression standing in for
 * the clock, so a test can hand in a VOLATILE one and count how often the statement evaluates it (budget.test.ts).
 * A bucket nobody has asked about yet has no row; the first call creates it FULL (a vendor never asked about has spent
 * nothing).
 */
export async function takeRealtimeKitCall(key: string, opts: { at?: Date; clockSql?: postgres.PendingQuery<postgres.Row[]> } = {}): Promise<boolean> {
  const clock = opts.clockSql ?? (opts.at ? sql`${opts.at}::timestamptz` : sql`clock_timestamp()`);
  // ONE statement: a bucket nobody has asked about yet is made FULL less this call's token (the insert), and an existing
  // one is refilled by the time since it last was and charged one token only if that leaves it with one to give (the
  // conflict arm's WHERE - a failed WHERE returns no row, which is the refusal). ON CONFLICT takes the row lock, so
  // concurrent callers - machines, and two first-ever callers racing to make the row - queue behind it one at a time.
  //
  // The clock is evaluated ONCE, in the VALUES row, and every other use reads it back as `excluded.refilled_at`. It
  // used to be written out in the WHERE, the SET and the stamp, three evaluations of clock_timestamp(): a backward step
  // (an NTP correction) between the WHERE and the SET refilled less in the SET than the WHERE had judged, left the
  // bucket a hair below zero, and the CHECK (tokens >= 0) then refused the UPDATE - an exception out of every
  // RealtimeKit call until the clock caught up (D21 review m4).
  //
  // The VALUES row is evaluated BEFORE ON CONFLICT takes the row lock, so two callers racing for one bucket can lock in
  // the opposite order to their clocks: the later reading first, the earlier one after. The earlier one refills nothing
  // (elapsed is floored at zero), and the STAMP only ever moves forward (`greatest`): were it set to the earlier reading
  // the stamp would go back, and the next caller would be credited that interval a second time (D21-fix N1). The cost
  // of the monotone stamp is the safe direction: a clock that stepped back refills nothing until it has caught up with
  // the stamp, never a credit for time the vendor has already counted.
  const refilled = refilledTokens(sql`excluded.refilled_at`);
  const spent = await sql`
    insert into realtimekit_call_budget as b (key, tokens, refilled_at)
    values (${key}, ${RTK_BUDGET_BURST}::float8 - 1, ${clock})
    on conflict (key) do update
       set tokens = ${refilled} - 1, refilled_at = greatest(b.refilled_at, excluded.refilled_at)
     where ${refilled} >= 1
    returning b.key`;
  return spent.length > 0;
}

/**
 * The bucket's level, as a take at the same instant would find it, WITHOUT spending (the check-in line's reader, spec §5.7.3:
 * it admits a stay only while the pool - this level less the reservations - holds the stay's reservation). Writes nothing: no
 * token is spent, the stamp does not move, and a vendor nobody has asked about (no row) reads FULL, as the first take will
 * find it. `opts.at` is the same test seam as the spender's.
 */
export async function peekRealtimeKitCall(
  key: string,
  opts: { at?: Date; db?: postgres.Sql | postgres.TransactionSql } = {},
): Promise<number> {
  const clock = opts.at ? sql`${opts.at}::timestamptz` : sql`clock_timestamp()`;
  // `opts.db`: the caller's own connection. The check-in line reads the level INSIDE its gate transaction, which holds one
  // pooled connection for the length of the advisory lock; a peek on a SECOND connection would let every waiter for the lock
  // hold the pool while the holder waited for a connection of its own.
  const [row] = await (opts.db ?? sql)<{ tokens: number }[]>`
    select ${refilledTokens(clock)} as tokens from realtimekit_call_budget b where b.key = ${key}`;
  return row ? Number(row.tokens) : RTK_BUDGET_BURST;
}
