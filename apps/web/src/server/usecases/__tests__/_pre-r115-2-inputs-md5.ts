// FROZEN FIXTURE (R115 review M4) — the players'-stats inputs md5 exactly as the code before R115-2 computed it: the
// statement of `playerStatsInputsMd5` at 08667cea5^ (apps/web/src/server/usecases/player-stats.ts:122-154), copied
// verbatim, with that file's in-play status list (`IN_PLAY_FIXTURE_STATUSES`, :252) inlined as it stood.
//
// It is what every fold record written before `STATS_FOLD_VERSION` existed holds. Tests that age a record to "folded
// by an older build" take the md5 from HERE, never from the code under test (`playerStatsInputsMd5(tx, id, null)`),
// so a change to today's statement cannot move the expected value with it. NEVER EDIT IT to follow player-stats.ts: a
// statement change there is exactly what this fixture exists to stay behind.
import type { withTenant } from "@/lib/db";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** `IN_PLAY_FIXTURE_STATUSES` at 08667cea5^. */
const PRE_R115_2_IN_PLAY: readonly string[] = ["scheduled", "in_play", "needs_decision"];

export async function preR1152InputsMd5(tx: Tx, divisionId: string): Promise<string> {
  const [row] = await tx<{ md5: string }[]>`
    select md5(concat_ws('|',
      (select concat_ws(':', d.sport_key, d.module_version, md5(coalesce(d.config::text, '-')))
         from divisions d where d.id = ${divisionId}),
      (select string_agg(concat_ws(':', f.id, f.stage_id, coalesce(f.home_entrant_id::text, '-'),
                                   coalesce(f.away_entrant_id::text, '-'),
                                   md5(coalesce(f.config_snapshot::text, '-')), md5(coalesce(s.config::text, '-'))),
                         ',' order by f.id)
         from fixtures f join stages s on s.id = f.stage_id
        where f.division_id = ${divisionId}
          and not (f.status = any(${PRE_R115_2_IN_PLAY as string[]}))
          and exists (select 1 from score_events se where se.fixture_id = f.id)),
      (select string_agg(concat_ws(':', e.id, e.kind, coalesce(em.person_id::text, '-')), ','
                         order by e.id, em.person_id)
         from entrants e left join entrant_members em on em.entrant_id = e.id
        where e.division_id = ${divisionId}),
      (select string_agg(concat_ws(':', l.fixture_id, l.entrant_id, l.person_id, coalesce(l.slot, '-'),
                                   coalesce(l.position_key, '-'), coalesce(l.order_no::text, '-'),
                                   coalesce(l.roles::text, '-'), coalesce(l.role, '-'),
                                   coalesce(em.squad_number::text, '-')),
                         ',' order by l.fixture_id, l.entrant_id, l.person_id)
         from lineups l
         join fixtures f on f.id = l.fixture_id
         left join entrant_members em on em.entrant_id = l.entrant_id and em.person_id = l.person_id
        where f.division_id = ${divisionId}
          and not (f.status = any(${PRE_R115_2_IN_PLAY as string[]}))
          and exists (select 1 from score_events se where se.fixture_id = f.id)),
      (select string_agg(p.id::text || '>' || p.merged_into::text, ',' order by p.id)
         from persons p where p.merged_into is not null and p.org_id = current_org_id())
    )) as md5`;
  return row!.md5;
}
