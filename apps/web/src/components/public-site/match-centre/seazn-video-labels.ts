// Seazn-hosted video (Phase 1 Task 15): the island's strings. The match page holds the `public` dictionary (the match centre takes it as a
// prop), and the island is a client component that does not need all of it: the page picks the few strings the island uses and hands them
// over, so the flight payload does not carry the dictionary a second time. Pure and client-safe: no `server-only`.
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";

export interface SeaznVideoLabels {
  /** The live chip, the live player's name and the live region's name. */
  live: string;
  /** What the player says when it cannot play (a failed load, a browser that cannot run HLS). */
  unavailable: string;
  /** The picker's tab, a template: `{n}` is the part's own number (it can skip). */
  part: string;
  /** The replay region's name (the same word as the match page's "Replay" link). */
  replay: string;
}

export function seaznVideoLabels(dict: Dict): SeaznVideoLabels {
  return {
    live: t(dict, "seaznVideo.live"),
    unavailable: t(dict, "seaznVideo.unavailable"),
    part: t(dict, "seaznVideo.part"),
    replay: t(dict, "overlay.replay"),
  };
}
