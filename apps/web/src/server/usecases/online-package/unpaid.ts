import "server-only";
// server/usecases/online-package/unpaid.ts - which divisions of a competition still owe their Online Chess package (spec
// 2026-11-23-online-chess-credits-design.md §8.8 "Step 1b", owner-added 2026-11-24): the competition page flags them "Not paid" so an organiser sees
// what stands between a division and its first round without opening each one.
//
// "Owes" is exactly the amber pay line's own condition (§8.3): the division PLAYS online, its LIVE package row is unpaid, and no round has
// opened. Hidden, by the query itself: a paid package (nothing owed), a frozen one (a round opened: the grandfathered backfill row is frozen and
// never paid, and is not a debt), a refunded one (history), and a division that no longer plays online (a stale row is not a debt). One query,
// one competition, the org named on the package row (the money row's own org) - never a per-division read.
import { sql } from "@/lib/db";

export async function listUnpaidOnlineDivisions(a: { orgId: string; competitionId: string }): Promise<Set<string>> {
  const rows = await sql<{ division_id: string }[]>`
    select p.division_id
      from division_online_packages p
      join divisions d on d.id = p.division_id
     where p.org_id = ${a.orgId}
       and d.competition_id = ${a.competitionId}
       and d.sport_key = 'boardgame'
       and coalesce(d.config->>'onlinePlay', 'off') = 'lichess'
       and p.refunded_at is null
       and p.paid_at is null
       and p.frozen_at is null`;
  return new Set(rows.map((r) => r.division_id));
}
