import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md C1, §7.2; plan 1 Task 7; pre-flight B7b, D5):
// the 7-day clock. An unsaved quick match expires QUICK_MATCH_EXPIRY_DAYS after its last activity, "creation or the last
// score" (C1); every activity moves `last_activity_at` and re-arms `expires_at` from it. A saved row carries no expiry
// (§7.7, plan 3) and keeps none: its activity still moves, its `expires_at` stays null.
//
// Two doors, one rule:
//   - `touchQuickMatchActivity(id)`: the home's own actions (plan 2's Score tap);
//   - `touchQuickMatchActivityForFixture(fixtureId)`: the scoring path, after an append commits (Task 8, D5). It finds the
//     row through fixtures → divisions → quick_matches.competition_id (unique, so indexed) in ONE statement, and touches
//     nothing for a fixture outside a quick match.
//
// PRIVILEGED (the pooled `sql`, not a tenant transaction): the scoring caller holds no system-org session, and runs this
// after its own transaction has closed. Import-light on purpose — the db client and the constants only — so the scoring
// path's call adds nothing of the home read's graph.
import { sql } from "@/lib/db";
import { QUICK_MATCH_EXPIRY_DAYS } from "@/lib/quick-match-constants";

const DAY_MS = 24 * 3600 * 1000;

const expiryFrom = (now: Date): Date => new Date(now.getTime() + QUICK_MATCH_EXPIRY_DAYS * DAY_MS);

/** Mark activity on one quick match: `last_activity_at = now`, and `expires_at` re-armed QUICK_MATCH_EXPIRY_DAYS out
 *  while unsaved (a saved row's stays null). An unknown id touches nothing. */
export async function touchQuickMatchActivity(id: string, now: Date = new Date()): Promise<void> {
  await sql`
    update quick_matches
    set last_activity_at = ${now},
        expires_at = case when saved_by_user_id is null then ${expiryFrom(now)}::timestamptz else expires_at end
    where id = ${id}`;
}

/** The same touch, for the quick match whose competition holds `fixtureId`. A fixture in an ordinary competition (or
 *  none) matches no row and touches nothing. */
export async function touchQuickMatchActivityForFixture(fixtureId: string, now: Date = new Date()): Promise<void> {
  await sql`
    update quick_matches q
    set last_activity_at = ${now},
        expires_at = case when q.saved_by_user_id is null then ${expiryFrom(now)}::timestamptz else q.expires_at end
    from fixtures f
    join divisions d on d.id = f.division_id
    where f.id = ${fixtureId} and q.competition_id = d.competition_id`;
}
