import "server-only";
// server/arbiter-panel-offered.ts - THE statement of when the Arbiter Panel answers (spec 2026-10-24-arbiter-round-column-design.md
// §7, §8; pre-flight C18). Two pages read it, and neither may keep its own copy of the predicate:
//   - the arbiter page (`/arbiter`) 404s unless it holds - the panel's own door;
//   - the division page's Fixtures tab offers the panel (its entry card and every link into it) only where it holds, so the tab
//     never links to a page that would 404 - the tab adds its own "has fixtures" on top.
//
// The predicate, cheapest part first: the viewer can edit the page (`canEdit`, never the billing-frozen `editable`: a frozen
// organiser keeps a working panel), the division plays online (`divisionPlaysOnline`: a sport that can, set to Lichess - the
// repo's one statement of it), then the caller's own cheap conditions, then the online-chess flag. The flag is a REMOTE call
// (PostHog, kept 60 s per org in `onlineChessOffered`), so it is asked LAST and only when every part before it said yes: a viewer,
// a division over the board, another sport, or a tab with nothing to offer never reach PostHog.
//
// The helper is imported through the usecases barrel, as both pages did, so a page test that doubles the barrel doubles the flag
// for this function too.
import type { AuthCtx } from "@/server/api-v1/auth";
import { divisionPlaysOnline } from "@/server/external-play/online-play";
import { onlineChessOffered } from "@/server/usecases/external-play";

/** What the predicate reads of a page: whether the viewer may edit it, and the division's sport and config. */
export type ArbiterPanelSubject = { canEdit: boolean; sport_key: string; config: unknown };

/** `beforeFlag` is the caller's own cheap condition(s), checked after the static parts and BEFORE the flag is asked (the tab's
 *  "this division has fixtures, or has not started so the start hint is wanted"). It is never a way to skip a static part.
 *
 *  `flag` is how the club's answer is read. It defaults to asking the helper for `auth`; a caller whose render has OTHER readers of
 *  the same answer (the division page's Division rules strip) passes ONE memoised reader so the whole render asks once - the 60 s
 *  PostHog cache inside the helper would hide a second ask, but the second ask is still a second ask. */
export async function arbiterPanelOffered(
  auth: AuthCtx,
  d: ArbiterPanelSubject,
  beforeFlag: () => boolean = () => true,
  flag: () => Promise<boolean> = () => onlineChessOffered(auth),
): Promise<boolean> {
  if (!d.canEdit) return false;
  if (!divisionPlaysOnline(d)) return false;
  if (!beforeFlag()) return false;
  return flag();
}
