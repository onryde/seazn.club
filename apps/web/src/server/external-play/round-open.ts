import "server-only";
// D12 (spec §3.2): a round is PAIRED automatically and OPENED by hand. The
// organiser's open stamps `stage_round_opens.opened_at`, sends the invites and
// starts the window — so T−10/T+20 hang off this stamp, never off
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

type AnySql = postgres.TransactionSql | postgres.Sql;

export type RoundOpen = { roundOpenedAt: Date; openedBy: string | null };

/** The stamp row itself — what T19's open writes and re-reads under its lock.
 *  `id` is what `fixture_external_play.round_open_id` names. */
export type RoundOpenRow = RoundOpen & { id: string };

/** THE read of `stage_round_opens` (T19 folded the by-key read in here rather
 *  than add a second reader — controller addendum 3). `null` ⇒ this
 *  (stage, round) has never been opened. (`openedBy` is NOT NULL in V451; the
 *  type keeps the plan's declared `string | null`.) */
export async function roundOpenAt(db: AnySql, stageId: string, roundNo: number): Promise<RoundOpenRow | null> {
  const rows = await db<RoundOpenRow[]>`
    select id, opened_at as "roundOpenedAt", opened_by as "openedBy"
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
    select o.id, o.opened_at as "roundOpenedAt", o.opened_by as "openedBy", o.stage_id as "stageId", o.round_no as "roundNo"
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
