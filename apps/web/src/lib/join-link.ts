// A team's join link, written in ONE place (polish wave P6).
//
// The link is `<join page>?join_code=<code>[&player_id=<slot>]`: the code is the capability (whoever holds it can join the entry,
// so every surface that shows it is a `ph-no-capture` painter and the telemetry scrubber removes it from any URL, by NAME:
// scrub-score-url.ts `JOIN_CODE_PARAMS`), and `player_id` names the captain-entered slot a teammate claims. It is NOT a `routes.*`
// builder on purpose: the secret-route scan (`scrub-secret-painters.test.ts`) lists the `routes` builders whose output the scrubber
// changes, and a join link is scrubbed by parameter name, not by route.
//
// Not server-only: the captain's status page (a server component), the confirmation mail (a usecase), the organiser's panel and
// the public "Have a join code?" field (client components) all build it.
import { normalizeRefCode } from "@/lib/ref-code";
import { routes } from "@/lib/routes";

/** The join page's site-relative URL for one entry: the generic link when no `playerId` is given (a team's "anyone joining" link;
 *  a pair's picker of its unclaimed slots), else the link that opens with that slot already chosen. */
export function joinLinkPath(orgSlug: string, competitionSlug: string, joinCode: string, playerId?: string): string {
  const qs = new URLSearchParams({ join_code: joinCode });
  if (playerId) qs.set("player_id", playerId);
  return `${routes.publicRegisterJoin(orgSlug, competitionSlug)}?${qs.toString()}`;
}

/** Where the public "Have a join code?" field sends a typed code, or null for a blank entry. The code is read the way a person
 *  writes one down (`normalizeRefCode`: any case, with or without the `SZ` and the dashes, spaces anywhere); anything else goes to
 *  the join page as typed, so the page's own throttle and its one "not valid" answer decide, never this field (no second oracle). */
export function joinLinkFromTyped(orgSlug: string, competitionSlug: string, typed: string): string | null {
  const trimmed = typed.trim();
  if (trimmed === "") return null;
  return joinLinkPath(orgSlug, competitionSlug, normalizeRefCode(trimmed));
}
