// Task 16 sign-off D1: every time of day on the arbiter panel is read in the VENUE's zone, and when the viewer's own zone sits at a
// different UTC offset at that instant the time carries the venue's name once ("15:56 (Tokyo time)").
//
// The oracle for "different offset" is NOT the code under test and NOT `fmtGmtOffset` (which the code uses): it is computed here from
// `Intl`'s own `longOffset` parts, in minutes. The city label is the last segment of the IANA id (IANA's own naming), typed per
// zone below from the rulebook, never derived by the function being tested.
import { describe, expect, it } from "vitest";
import { venueZoneCity, zoneCity } from "../venue-time";

/** The offset of `tz` from UTC at `at`, in minutes, from Intl's `longOffset` ("GMT+09:00", "GMT-04:00", "GMT"). */
function offsetMinutes(tz: string, at: string): number {
  const part = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName")!.value;
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(part);
  if (!m) throw new Error(`unreadable offset ${part} for ${tz}`);
  return m[1] === undefined ? 0 : (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

const WINTER = "2026-01-15T12:00:00.000Z";
const SUMMER = "2026-07-15T12:00:00.000Z";

describe("zoneCity: the label comes from the IANA id, no hand table", () => {
  it("is the id's last segment, underscores read as spaces", () => {
    const cases: [string, string][] = [
      ["Asia/Tokyo", "Tokyo"],
      ["America/New_York", "New York"],
      ["America/Argentina/Buenos_Aires", "Buenos Aires"],
      // More than one underscore in the last segment: every one reads as a space, not only the first.
      ["Asia/Ho_Chi_Minh", "Ho Chi Minh"],
      ["America/Port_of_Spain", "Port of Spain"],
      ["Europe/London", "London"],
      ["UTC", "UTC"],
    ];
    for (const [id, want] of cases) expect(zoneCity(id), id).toBe(want);
    expect(cases.length, "anti-vacuity").toBe(7);
  });

  it("never returns an empty label, whatever it is given", () => {
    for (const id of ["", "/", "Asia/"]) expect(zoneCity(id).length, JSON.stringify(id)).toBeGreaterThan(0);
  });
});

describe("venueZoneCity: when the viewer's offset differs at that instant", () => {
  it("before mount (no viewer zone yet) there is no label: the server render and the first paint never carry one", () => {
    expect(venueZoneCity("Asia/Tokyo", null, SUMMER)).toBeNull();
  });

  it("the same zone, or another zone at the same offset at that instant, has no label", () => {
    expect(venueZoneCity("Asia/Tokyo", "Asia/Tokyo", SUMMER)).toBeNull();
    // Tokyo and Seoul are different zones on the same offset all year.
    expect(offsetMinutes("Asia/Tokyo", SUMMER)).toBe(offsetMinutes("Asia/Seoul", SUMMER));
    expect(venueZoneCity("Asia/Tokyo", "Asia/Seoul", SUMMER)).toBeNull();
  });

  it("a different offset names the venue", () => {
    expect(offsetMinutes("Asia/Tokyo", SUMMER)).not.toBe(offsetMinutes("America/New_York", SUMMER));
    expect(venueZoneCity("Asia/Tokyo", "America/New_York", SUMMER)).toBe("Tokyo");
    expect(venueZoneCity("America/New_York", "Asia/Tokyo", SUMMER)).toBe("New York");
  });

  it("is a question about THAT instant: London and Abidjan agree in winter and differ in summer", () => {
    expect(offsetMinutes("Europe/London", WINTER)).toBe(offsetMinutes("Africa/Abidjan", WINTER));
    expect(offsetMinutes("Europe/London", SUMMER)).not.toBe(offsetMinutes("Africa/Abidjan", SUMMER));
    expect(venueZoneCity("Europe/London", "Africa/Abidjan", WINTER)).toBeNull();
    expect(venueZoneCity("Europe/London", "Africa/Abidjan", SUMMER)).toBe("London");
  });

  it("agrees with the independent offset oracle across a sweep of zone pairs and instants", () => {
    const zones = ["Asia/Tokyo", "Asia/Kolkata", "Asia/Kathmandu", "Europe/London", "Europe/Madrid", "Africa/Abidjan", "America/New_York", "America/Los_Angeles", "Pacific/Auckland", "UTC"];
    let checked = 0;
    let differing = 0;
    let same = 0;
    for (const venue of zones) {
      for (const viewer of zones) {
        for (const at of [WINTER, SUMMER]) {
          const differs = offsetMinutes(venue, at) !== offsetMinutes(viewer, at);
          const got = venueZoneCity(venue, viewer, at);
          expect(got === null, `${venue} seen from ${viewer} at ${at}`).toBe(!differs);
          if (differs) {
            expect(got).toBe(zoneCity(venue));
            differing += 1;
          } else same += 1;
          checked += 1;
        }
      }
    }
    expect(checked, "anti-vacuity: 10 x 10 x 2").toBe(200);
    expect(differing, "the sweep reaches both answers").toBeGreaterThan(0);
    expect(same, "the sweep reaches both answers").toBeGreaterThan(0);
  });
});
