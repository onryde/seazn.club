// The venue's zone on screens an organiser reads from anywhere (Task 16 sign-off D1). The arbiter panel prints every time of day in
// the VENUE's zone, so one deadline reads the same in the round column and in the decision area. An organiser whose own zone sits at
// a different UTC offset at that instant is told whose clock it is, once per time: "15:56 (Tokyo time)".
//
// Pure and client-safe. The viewer's zone is an INPUT (`null` until the browser is mounted): the server cannot know it, and a server
// render that guessed would hydrate to something else. The caller adds the label only when this says there is one.
import { fmtGmtOffset } from "./format.ts";

/** "Tokyo" for `Asia/Tokyo`, "Buenos Aires" for `America/Argentina/Buenos_Aires`: the id's last segment, underscores read as spaces. IANA
 *  already names the city, so there is no table to keep. A zone with no usable id (it cannot be told apart from the UTC the formatters
 *  fall back to) is "UTC". */
export function zoneCity(tz: string): string {
  const label = (tz.split("/").filter(Boolean).at(-1) ?? "").replaceAll("_", " ").trim();
  return label.length > 0 ? label : "UTC";
}

/** The venue's city when the viewer should be told, else `null`: the viewer's zone is unknown (before mount), or it sits at the same UTC
 *  offset as the venue's AT THAT INSTANT. It is the offset that decides and not the zone's name: Tokyo and Seoul share a clock, and
 *  London shares Abidjan's in winter only. */
export function venueZoneCity(venueTz: string, viewerTz: string | null, at: string | number | Date): string | null {
  if (viewerTz === null) return null;
  return fmtGmtOffset(venueTz, at) === fmtGmtOffset(viewerTz, at) ? null : zoneCity(venueTz);
}
