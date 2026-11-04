// YouTube Connect T16 - WHAT the public match page shows of a fixture's replay: which parts the player lists, and whether the
// club's own stream link still shows beside it. A module of its own, beside `stream-link.ts` (whose void rule it reuses) and for
// the same reason: the decision is a function of the whole fixture-status vocabulary, and the async server component that renders
// it can only be enumerated by rendering the page once per status. This can be swept directly (replay-plan.test.ts); the page's
// own tests prove it is mounted.
import { isYoutubeUrl, linkIsOneOfParts, type PublicReplayPart } from "@/lib/youtube";
import { streamLinkLabelKey } from "./stream-link";

export interface ReplayPlan {
  /** The parts the player lists, in the order given. Empty means no player at all. */
  parts: PublicReplayPart[];
  /** Does the club's own stream link (the existing "Watch live" / "Replay" pill) still render? */
  showOwnLink: boolean;
}

/** The rules (owner rulings O1/O3):
 *   - A void fixture (`streamLinkLabelKey` is null: cancelled, abandoned, forfeited) shows nothing, whatever is stored. The check
 *     is the label key's own, so the player and the pill can never disagree about what is void.
 *   - Only a YouTube address is ever offered a player (https, youtube.com or youtu.be). The parts come from our own table, so this
 *     is a second, independent guard on the read side, as `rel="noopener"` is on the pill.
 *   - Each part keeps its `madeForKids` EXACTLY as given (true, false or null): the plan decides WHICH parts are listed, never HOW a
 *     part is shown - the player decides that, failing closed (`mayEmbedReplay`). A plan that normalised a missing flag to false would
 *     turn "not known" into "may embed".
 *   - The club's own link shows unless it IS one of the parts (then the player carries it - never shown twice). A different link
 *     (another site, or another YouTube video the club chose) still shows beside the player. With no parts the pill is exactly
 *     what it was before parts existed. */
export function replayPlan(input: { status: string; streamUrl: string | null; parts: readonly PublicReplayPart[] }): ReplayPlan {
  if (streamLinkLabelKey(input.status) === null) return { parts: [], showOwnLink: false };
  const parts = input.parts.filter((p) => isYoutubeUrl(p.url));
  const own = input.streamUrl;
  return { parts, showOwnLink: own !== null && own !== "" && !linkIsOneOfParts(own, parts) };
}
