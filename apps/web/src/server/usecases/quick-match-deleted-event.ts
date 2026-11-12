import "server-only";
// Quick match: `quick_match_deleted` (controller ruling 2026-11-12, for /admin/quick-matches). A hard delete
// (quick-match-delete.ts) leaves no row, so this PostHog event is the only record that a quick match a guest made is gone,
// and of how: its saver's Delete (`via: "saver"`, quick-match-owner.ts) or the sweep's expiry (`via: "expiry"`,
// quick-match-sweep.ts). The create's compensation and the sweep's orphans are no guest's match and send nothing.
//
// The event says { quick_match_id, via, sport_key, kind } and nothing else: never the match's name, an address, a user id beyond
// the distinct id `captureServer` attaches, or a token. `quick_match_id` is the `quick_matches` row's uuid, under the same name
// `quick_match_created` and `quick_match_saved` carry it, so PostHog joins a deletion to its create and save (controller
// ruling 2026-11-12); it is no credential (the home token is). The sport and the kind live on the division and its entrants, which the delete
// removes, so each caller reads them with its own candidate read (`deletedFactsSql`) BEFORE the delete, and announces only a
// delete that happened (`deleted: true`): a refused or kept one sends nothing.
import { EVENTS } from "@/lib/analytics-events";
import { sql } from "@/lib/db";
import { deferred } from "@/lib/deferred";
import { captureServer } from "@/lib/posthog-server";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";

/** What `quick_match_deleted` says of a match, read off its row before the delete (null: the match had no division). */
export interface QuickMatchDeletedFacts {
  sport_key: string | null;
  kind: string | null;
}

/** The columns `sport_key` and `kind` over a `quick_matches q` row: its division's sport and its entrants' one kind (D2). */
export function deletedFactsSql() {
  return sql`
    (select d.sport_key from divisions d where d.competition_id = q.competition_id order by d.id limit 1) as sport_key,
    (select e.kind from entrants e join divisions d on d.id = e.division_id
      where d.competition_id = q.competition_id order by e.seed nulls last, e.id limit 1) as kind`;
}

/** Send `quick_match_deleted` for the quick match `quickMatchId` (its row's uuid) whose delete committed. Never throws, never
 *  delays the caller (deferred). */
export function announceQuickMatchDeleted(
  via: "saver" | "expiry",
  quickMatchId: string,
  facts: QuickMatchDeletedFacts,
  distinctId: string,
): void {
  deferred(() =>
    captureServer({
      event: EVENTS.QUICK_MATCH_DELETED,
      distinctId,
      orgId: QUICK_MATCH_SYSTEM_ORG_ID,
      properties: { quick_match_id: quickMatchId, via, sport_key: facts.sport_key, kind: facts.kind },
    }),
  );
}
