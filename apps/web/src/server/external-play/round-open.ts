import "server-only";
// D12 (spec §3.2): a round is PAIRED automatically and OPENED by hand. The
// organiser's open stamps `stage_round_opens.opened_at`, sends the invites and
// starts the window — so the window (window.ts) hangs off this stamp, never off
// `fixtures.scheduled_at`, which is only what players are shown. A fixture
// whose round has no stamp is not playable.
//
// The ONE authority for reading that stamp: T6's camera-policy gate, T8's seat
// gate and T9's readiness read it here rather than each writing their own SQL.
// The reschedule detector in guard.ts (`scheduled_at_basis`) is a DIFFERENT
// question and stays schedule-based; do not re-anchor it.
//
// `stage_round_opens` is SEALED (V451: FORCE RLS, no app_user policy, no
// grant), so these readers must be handed the privileged `sql` client. Inside
// a `withTenant` transaction (role app_user) the read is refused outright —
// `permission denied for table stage_round_opens` (42501), verified against
// the chesslep DB 2026-10-09 — which is why patchDivision asks BEFORE it opens
// its tenant transaction, the same placement as its `requireFeature` reads.
import type postgres from "postgres";
import {
  CHECKIN_BATCH_GAP_MS,
  CHECKIN_BATCH_SIZE,
  ROUND_WINDOW_SCAN_LOOKBACK_MS,
  ROUND_WINDOW_TAIL_MS,
  boardAnchor,
  type BoardAnchor,
} from "./window";

type AnySql = postgres.TransactionSql | postgres.Sql;

export type RoundOpen = { roundOpenedAt: Date; openedBy: string | null };

/** The stamp row itself — what T19's open writes and re-reads under its lock.
 *  `id` is what `fixture_external_play.round_open_id` names. `staggered` is the flag the open STORED (V461, spec §3.2.1):
 *  whether this round's check-in runs in timed batches, decided once at the open from the camera policy of that moment. */
export type RoundOpenRow = RoundOpen & { id: string; staggered: boolean };

/** A board's place in its round's batches: its zero-based RANK among every fixture row of its (stage, round), and the
 *  anchor its window hangs off (spec §3.2.1). The anchor also carries the board's check-in extension (spec §3.2.2); `extensions`
 *  is how many presses made it (the cap is judged on the count, the deadline on the milliseconds). */
export type BoardPlacement = { rank: number; anchor: BoardAnchor };
export type BoardOpen = RoundOpenRow & BoardPlacement & { extensions: number };

/** The anchor of a board from a candidate row that carries its round's stamp, its rank, its round's `staggered` flag and the
 *  board's check-in extension. The sweep's candidate queries select exactly these four beside the board (`boardRankSql` is the
 *  rank, `boardExtraSql` the extension). */
export function anchorOfRow(r: { openedAt: Date; rank: number; staggered: boolean; extraMs: number }): BoardAnchor {
  return boardAnchor(r.openedAt, r.rank, r.staggered, r.extraMs);
}

/** THE board rank, in SQL: the zero-based position of fixture `f` among EVERY fixture row of its (stage, round), ordered
 *  `(seq_in_round, id)` (spec §3.2.1). Every row counts, a bye and a withdrawn board included, so no board's batch moves
 *  after its invite was sent. It is a fragment and not a stored column, and EVERY query that needs a board's rank
 *  interpolates this one: the sweep's no-show, retry, teardown and reconcile candidates, and `boardOpenFor` below. The
 *  caller names its fixtures table `f`. */
export function boardRankSql(db: AnySql) {
  return db`(select count(*)::int from fixtures rk
              where rk.stage_id = f.stage_id and rk.round_no = f.round_no
                and (rk.seq_in_round, rk.id) < (f.seq_in_round, f.id))`;
}

/** The lock that serialises a board's check-in EXTENSION (spec §3.2.2) against the sweep's deadline judgements. The deadline is no
 *  longer a function of the round alone: an arbiter can move it, and a sweep that read the board a moment before the move would
 *  walk the board over (the no-show) or end its rooms (the teardown) on a deadline that no longer applies. Both sides take THIS
 *  lock - a transaction-scoped advisory lock, keyed by the board - then READ the deadline under it, so whichever comes second
 *  sees the other's write. It is a lock of its own (not `fixture:<id>`, which the score-event writer holds for the length of an
 *  append, nor the fixture row) so that a sweep waiting here never waits behind, or blocks, a score. Taken FIRST in the
 *  transaction, before any row lock (preflight.ts lock-order rule), so it cannot deadlock against the fixtures/bridge-row order. */
export const CHECKIN_WINDOW_LOCK_PREFIX = "checkin-window:";
export async function lockCheckinWindow(tx: AnySql, fixtureId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${CHECKIN_WINDOW_LOCK_PREFIX + fixtureId}))`;
}

/** THE board's check-in extension, in SQL (spec §3.2.2): the milliseconds the arbiter added to its deadline, 0 for a board with
 *  no bridge row or none added. The fragment beside `boardRankSql`, and every query that builds an anchor interpolates BOTH
 *  (batch-anchor-source-guard.test.ts counts them per file): an anchor built without the extension judges the board by a
 *  deadline its players are no longer on. The caller names its bridge table `ep` (a LEFT join, so a board nobody has touched
 *  still has a row to read). */
export function boardExtraSql(db: AnySql) {
  return db`coalesce(ep.checkin_extra_ms, 0)::int`;
}

/** THE read of `stage_round_opens` (T19 folded the by-key read in here rather
 *  than add a second reader — controller addendum 3). `null` ⇒ this
 *  (stage, round) has never been opened. (`openedBy` is NOT NULL in V451; the
 *  type keeps the plan's declared `string | null`.) */
export async function roundOpenAt(db: AnySql, stageId: string, roundNo: number): Promise<RoundOpenRow | null> {
  const rows = await db<RoundOpenRow[]>`
    select id, opened_at as "roundOpenedAt", opened_by as "openedBy", staggered
      from stage_round_opens
     where stage_id = ${stageId} and round_no = ${roundNo}`;
  return rows[0] ?? null;
}

/** The key `roundOpensOfDivisions` answers by: one (stage, round). */
export function roundKey(stageId: string, roundNo: number): string {
  return `${stageId}:${roundNo}`;
}

/** T16 fix round 1, M8 + R4 — the same read for many rounds at once: every opened (stage, round) of these divisions,
 *  keyed by `roundKey`. A round absent from the answer has never been opened. One statement, for the readers that
 *  ask about a whole division (the Open-round confirmation) or a whole competition (the ledger). */
export async function roundOpensOfDivisions(db: AnySql, divisionIds: readonly string[]): Promise<Map<string, RoundOpenRow>> {
  if (divisionIds.length === 0) return new Map();
  const rows = await db<(RoundOpenRow & { stageId: string; roundNo: number })[]>`
    select o.id, o.opened_at as "roundOpenedAt", o.opened_by as "openedBy", o.staggered,
           o.stage_id as "stageId", o.round_no as "roundNo"
      from stage_round_opens o
      join stages s on s.id = o.stage_id
     where s.division_id = any(${divisionIds as string[]}::uuid[])`;
  return new Map(rows.map(({ stageId, roundNo, ...open }) => [roundKey(stageId, roundNo), open]));
}

/** `null` ⇒ this fixture's round has never been opened (or there is no such
 *  fixture). Resolves the fixture's (stage, round) and asks `roundOpenAt`. */
export async function roundOpenFor(db: AnySql, fixtureId: string): Promise<RoundOpenRow | null> {
  const [f] = await db<{ stageId: string; roundNo: number }[]>`
    select stage_id as "stageId", round_no as "roundNo" from fixtures where id = ${fixtureId}`;
  if (!f) return null;
  // The row's `id` rides along (T14): the match-room link is bound to it.
  return roundOpenAt(db, f.stageId, f.roundNo);
}

/** `null` ⇒ this fixture's round has never been opened (or there is no such fixture). Otherwise the stamp row AND the
 *  board's place in it: the rank (`boardRankSql`) and the anchor its window hangs off. THE reader every window question about
 *  a board starts from (the seat, the room, the create, the invite), so none of them can hand `roomPhase` the round's
 *  stamp instead of the board's own. */
export async function boardOpenFor(db: AnySql, fixtureId: string): Promise<BoardOpen | null> {
  const [r] = await db<(RoundOpenRow & { rank: number; extraMs: number; extensions: number })[]>`
    select o.id, o.opened_at as "roundOpenedAt", o.opened_by as "openedBy", o.staggered,
           ${boardRankSql(db)} as rank, ${boardExtraSql(db)} as "extraMs",
           coalesce(ep.checkin_extensions, 0)::int as extensions
      from fixtures f
      join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
      left join fixture_external_play ep on ep.fixture_id = f.id
     where f.id = ${fixtureId}`;
  if (!r) return null;
  const { rank, extraMs, extensions, ...open } = r;
  return { ...open, rank, extensions, anchor: boardAnchor(r.roundOpenedAt, rank, r.staggered, extraMs) };
}

/** Has ANY round of this division been opened at or before `now`? T6's
 *  downgrade-only gate asks this, not "is this fixture's round open": once ONE
 *  round has gone out, tightening the camera requirement would strand the
 *  field, whichever round the organiser is looking at. */
export async function anyRoundOpened(db: AnySql, divisionId: string, now: Date): Promise<boolean> {
  const [row] = await db<{ opened: boolean }[]>`
    select exists(
      select 1
        from stage_round_opens sro
        join stages s on s.id = sro.stage_id
       where s.division_id = ${divisionId}
         and sro.opened_at <= ${now}
    ) as opened`;
  return row?.opened === true;
}

/** THE one SQL spelling of a ROUND's window bound, for the alias `o` (a `stage_round_opens` row): its last batch's start plus
 *  `ROUND_WINDOW_TAIL_MS` (the deadline, the line's grace and the arbiter's most extension, declared in window.ts and NOT summed
 *  here: rule 3 of batch-anchor-source-guard.test.ts refuses arithmetic with DEADLINE_AFTER_MS anywhere but window.ts). The last
 *  batch's start is `opened_at + (batchCount(boards) - 1) * CHECKIN_BATCH_GAP_MS` when the round staggers (the flag its open STORED,
 *  spec §3.2.1) and `opened_at` otherwise; `boards` is EVERY fixture row of the (stage, round), a bye and a withdrawn board
 *  included, as `boardRankSql` counts them. Conservative and per round: a board's own deadline can be earlier, and no board's later.
 *  Shared with the Match Day plan's "today" rule. The caller names its `stage_round_opens` table `o`; the fragment reads the round's
 *  fixtures itself, so it needs no join. */
export function roundWindowBoundSql(db: AnySql) {
  return db`(o.opened_at
    + (case when o.staggered
            then (greatest(1, ceil((select count(*) from fixtures rb where rb.stage_id = o.stage_id and rb.round_no = o.round_no)::numeric / ${CHECKIN_BATCH_SIZE}::numeric)) - 1)
                 * ${CHECKIN_BATCH_GAP_MS}::float8
            else 0::float8 end) * interval '1 millisecond'
    + ${ROUND_WINDOW_TAIL_MS}::float8 * interval '1 millisecond')`;
}

/** Is ANY board inside a check-in window, its grace or an extension at `now` (an open round whose bound has not passed)? The question
 *  the sweep asks before it tears rooms down or reads camera evidence, and the pre-mint before it makes rooms: a window open means
 *  players are claiming seats, and a vendor call spent on housekeeping is one a player could have used. Platform-wide in production.
 *  `orgIds` is a TEST scope (the sweep's own `SweepDeps.orgIds` rule): it limits the question to those orgs' rounds so the shared
 *  test database's other suites cannot flip the answer, and an EMPTY list matches nothing, never "every org". The privileged client:
 *  `stage_round_opens` is sealed. */
export async function anyCheckinWindowOpen(
  db: AnySql,
  now: Date,
  orgIds?: readonly string[],
  lookbackMs: number = ROUND_WINDOW_SCAN_LOOKBACK_MS,
): Promise<boolean> {
  const scope = orgIds === undefined ? db`` : db`and o.org_id in ${db(orgIds as string[])}`;
  // The scan is bounded to opens recent enough to be inside a window (`ROUND_WINDOW_SCAN_LOOKBACK_MS`: the tail plus the stagger of the
  // biggest round it allows for): the table holds every round ever opened, and the bound below counts each row's fixtures. `lookbackMs`
  // is the test's seam for pinning exactly where that cut falls; production passes none.
  const since = new Date(now.getTime() - lookbackMs);
  const [row] = await db<{ open: boolean }[]>`
    select exists (
      select 1 from stage_round_opens o where o.opened_at > ${since} and ${roundWindowBoundSql(db)} > ${now} ${scope}
    ) as open`;
  return row?.open === true;
}

/** The sweep's and the pre-mint's open-window deferral is ON unless `EXTERNAL_PLAY_WINDOW_DEFER` is exactly "0" (the e2e server's
 *  setting, whose specs share one platform-wide window state, and an operator's rollback lever). Read at call time. */
export function windowDeferralOn(): boolean {
  return process.env.EXTERNAL_PLAY_WINDOW_DEFER !== "0";
}
