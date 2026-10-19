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
import { boardAnchor, type BoardAnchor } from "./window";

type AnySql = postgres.TransactionSql | postgres.Sql;

export type RoundOpen = { roundOpenedAt: Date; openedBy: string | null };

/** The stamp row itself — what T19's open writes and re-reads under its lock.
 *  `id` is what `fixture_external_play.round_open_id` names. `staggered` is the flag the open STORED (V461, spec §3.2.1):
 *  whether this round's check-in runs in timed batches, decided once at the open from the camera policy of that moment. */
export type RoundOpenRow = RoundOpen & { id: string; staggered: boolean };

/** A board's place in its round's batches: its zero-based RANK among every fixture row of its (stage, round), and the
 *  anchor its window hangs off (spec §3.2.1). */
export type BoardPlacement = { rank: number; anchor: BoardAnchor };
export type BoardOpen = RoundOpenRow & BoardPlacement;

/** The anchor of a board from a candidate row that carries its round's stamp, its rank and its round's `staggered` flag.
 *  The sweep's four candidate queries select exactly these three beside the board (`boardRankSql` is the rank). */
export function anchorOfRow(r: { openedAt: Date; rank: number; staggered: boolean }): BoardAnchor {
  return boardAnchor(r.openedAt, r.rank, r.staggered);
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
  const [r] = await db<(RoundOpenRow & { rank: number })[]>`
    select o.id, o.opened_at as "roundOpenedAt", o.opened_by as "openedBy", o.staggered,
           ${boardRankSql(db)} as rank
      from fixtures f
      join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
     where f.id = ${fixtureId}`;
  if (!r) return null;
  return { ...r, anchor: boardAnchor(r.roundOpenedAt, r.rank, r.staggered) };
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
