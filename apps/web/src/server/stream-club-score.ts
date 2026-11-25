import "server-only";
// server/stream-club-score.ts — what the Streaming page's "Score on stream" section draws its style previews from (Seazn-hosted video,
// Phase 4, Task 38). The section is the club's default, so it has no match to preview: it draws the club's OWN sports (the sports of
// its divisions that the overlay can render), each as the overlay draws a match of that sport in play — the staff gallery's snapshot,
// folded through the real engine and projected through the real overlay model (server/overlay/gallery-snapshots.ts), never a picture
// and never a hand-typed payload. A club with no division yet (or none the overlay renders) gets ONE generic preview.
//
// A preview must never take the page down: if the sample walk of a sport fails, that sport falls back to the plain scheduled card
// (the panel's own seed) and the failure is reported; the settings above it still work.
import { sql } from "@/lib/db";
import { OVERLAY_SPORT_KEYS } from "@/components/overlay/overlay-tokens";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import type { OverlaySideInput } from "@/lib/overlay-model";
import { captureError } from "@/lib/sentry";
import { gallerySnapshots } from "@/server/overlay/gallery-snapshots";

/** The sport a club with no (renderable) division is previewed as: the overlay's own generic sample. */
export const CLUB_PREVIEW_FALLBACK_SPORT = "generic";

/** The two sides every preview shows — the gallery's ids (its snapshots are written against `home` / `away`), names short enough to read
 *  at a thumbnail's width. */
export const CLUB_PREVIEW_SIDES: [OverlaySideInput, OverlaySideInput] = [
  { id: "home", name: "Ashgrove Rovers" },
  { id: "away", name: "Northbridge Athletic" },
];

export interface ClubScorePreview {
  /** The sports the previews can switch between, by name. One entry (a club with a single sport, or the generic fallback) draws no switch. */
  sports: { key: string; name: string }[];
  /** True when `sports` is the generic fallback, not the club's own. */
  fallback: boolean;
  /** Each sport's live-play snapshot, keyed by sport. */
  snapshots: Record<string, OverlayLiveData>;
  sides: [OverlaySideInput, OverlaySideInput];
}

/** The plain scheduled card — the panel's own seed (fixture-stream-panel/panel.tsx), what a thumbnail shows with nothing played. */
const SCHEDULED: OverlayLiveData = { status: "scheduled", summary: null, outcome: null, lastSeq: null, venueTz: "UTC" };

/** The org's overlay-renderable sports, by name (the `sports` catalogue's own), in name order. */
export async function clubOverlaySports(orgId: string): Promise<{ key: string; name: string }[]> {
  const rows = await sql<{ key: string; name: string }[]>`
    select distinct s.key, s.name from divisions d join sports s on s.key = d.sport_key where d.org_id = ${orgId} order by s.name, s.key`;
  return rows.filter((r) => OVERLAY_SPORT_KEYS.includes(r.key));
}

export async function clubScorePreview(orgId: string, now: number = Date.now()): Promise<ClubScorePreview> {
  const own = await clubOverlaySports(orgId);
  let sports = own;
  let fallback = false;
  if (own.length === 0) {
    const [g] = await sql<{ name: string }[]>`select name from sports where key = ${CLUB_PREVIEW_FALLBACK_SPORT}`;
    sports = [{ key: CLUB_PREVIEW_FALLBACK_SPORT, name: g?.name ?? CLUB_PREVIEW_FALLBACK_SPORT }];
    fallback = true;
  }
  const snapshots: Record<string, OverlayLiveData> = {};
  for (const { key } of sports) {
    try {
      snapshots[key] = gallerySnapshots(now, [key])[key]!.live;
    } catch (err) {
      captureError(err, { orgId, route: "streaming.club_score_preview", extra: { sport: key } });
      snapshots[key] = SCHEDULED;
    }
  }
  return { sports, fallback, snapshots, sides: CLUB_PREVIEW_SIDES };
}
