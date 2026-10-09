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
// `stage_round_opens` is SEALED (V432: FORCE RLS, no app_user policy, no
// grant), so these readers must be handed the privileged `sql` client. Inside
// a `withTenant` transaction (role app_user) the read is refused outright —
// `permission denied for table stage_round_opens` (42501), verified against
// the chesslep DB 2026-10-09 — which is why patchDivision asks BEFORE it opens
// its tenant transaction, the same placement as its `requireFeature` reads.
import type postgres from "postgres";

type AnySql = postgres.TransactionSql | postgres.Sql;

export type RoundOpen = { roundOpenedAt: Date; openedBy: string | null };

/** `null` ⇒ this fixture's round has never been opened. (`openedBy` is NOT
 *  NULL in V432; the type keeps the plan's declared `string | null`.) */
export async function roundOpenFor(db: AnySql, fixtureId: string): Promise<RoundOpen | null> {
  const rows = await db<{ roundOpenedAt: Date; openedBy: string | null }[]>`
    select sro.opened_at as "roundOpenedAt", sro.opened_by as "openedBy"
      from fixtures f
      join stage_round_opens sro
        on sro.stage_id = f.stage_id and sro.round_no = f.round_no
     where f.id = ${fixtureId}`;
  return rows[0] ?? null;
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
