"use client";
// Every time of day on the arbiter panel is read in the VENUE's zone (Task 16 sign-off D1), so one deadline reads the same in the round
// column, the decision area and the confirmation. When the viewer's own zone sits at another UTC offset at that instant the time says
// whose clock it is, once: "15:56 (Tokyo time)".
import { useMsg } from "@/components/i18n/dict-provider";
import { fmtTime } from "@/lib/format";
import { useBrowserZone } from "@/lib/use-client-snapshot";
import { venueZoneCity } from "@/lib/venue-time";

/** `time` (already read in the venue's zone) with the venue's name added when the viewer's offset differs at `iso`; `time` untouched
 *  otherwise. `say` words the pair: the caller's own translator, so this file owns no copy. */
export function withVenueName(time: string, iso: string, venueTz: string, viewerTz: string | null, say: (vars: { time: string; city: string }) => string): string {
  const city = venueZoneCity(venueTz, viewerTz, iso);
  return city === null ? time : say({ time, city });
}

/** The column's clock: an ISO instant in the venue's zone, labelled when the viewer is elsewhere. Same-offset and pre-mount viewers get
 *  the bare time, which is also all the server ever renders. */
export function useVenueClock(venueTz: string): (iso: string) => string {
  const msg = useMsg();
  const viewerTz = useBrowserZone();
  return (iso) => withVenueName(fmtTime(venueTz, iso), iso, venueTz, viewerTz, (v) => msg("arbiter.venueTime", v));
}
