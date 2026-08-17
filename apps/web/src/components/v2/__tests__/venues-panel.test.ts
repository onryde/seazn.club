import { describe, expect, it } from "vitest";
import {
  copyHoursToAllDays,
  filterVenuesByArchived,
  hasHoursOverlap,
  hasInvalidRange,
  rankTagsByCount,
  type Court,
  type CourtHours,
  type Venue,
} from "../venues-panel";

function court(overrides: Partial<Court> = {}): Court {
  return {
    id: "court-1",
    venue_id: "venue-1",
    name: "Court 1",
    sort: 0,
    tags: [],
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    hours: [],
    exceptions: [],
    ...overrides,
  };
}

function venue(overrides: Partial<Venue> = {}): Venue {
  return {
    id: "venue-1",
    name: "Riverside Sports Centre",
    address: null,
    sort: 0,
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    courts: [],
    ...overrides,
  };
}

describe("filterVenuesByArchived — the 'Show archived' toggle's filter", () => {
  const active = venue({ id: "v-active", archived_at: null });
  const archived = venue({ id: "v-archived", archived_at: "2026-08-01T00:00:00.000Z" });

  it("off (default): hides archived venues", () => {
    expect(filterVenuesByArchived([active, archived], false).map((v) => v.id)).toEqual(["v-active"]);
  });

  it("on: shows every venue, archived included", () => {
    expect(filterVenuesByArchived([active, archived], true).map((v) => v.id)).toEqual(["v-active", "v-archived"]);
  });

  it("an all-active list is unaffected by the toggle either way", () => {
    expect(filterVenuesByArchived([active], false)).toEqual([active]);
    expect(filterVenuesByArchived([active], true)).toEqual([active]);
  });

  it("empty input yields empty output", () => {
    expect(filterVenuesByArchived([], false)).toEqual([]);
  });
});

describe("copyHoursToAllDays — 'copy this day to all days'", () => {
  it("replaces every weekday with a copy of the source day's ranges", () => {
    const hours: CourtHours[] = [
      { weekday: 1, open_min: 540, close_min: 720 }, // Mon 09:00-12:00
      { weekday: 1, open_min: 780, close_min: 1020 }, // Mon 13:00-17:00
      { weekday: 3, open_min: 0, close_min: 60 }, // Wed — unrelated, gets overwritten too
    ];
    const result = copyHoursToAllDays(hours, 1);
    for (let weekday = 0; weekday < 7; weekday++) {
      expect(result.filter((h) => h.weekday === weekday)).toEqual([
        { weekday, open_min: 540, close_min: 720 },
        { weekday, open_min: 780, close_min: 1020 },
      ]);
    }
    expect(result).toHaveLength(14);
  });

  it("copying a day with zero ranges closes every day", () => {
    const hours: CourtHours[] = [{ weekday: 2, open_min: 540, close_min: 720 }];
    expect(copyHoursToAllDays(hours, 5)).toEqual([]);
  });

  it("produces fresh objects, not shared references, per day", () => {
    const hours: CourtHours[] = [{ weekday: 0, open_min: 540, close_min: 720 }];
    const result = copyHoursToAllDays(hours, 0);
    const sun = result.find((h) => h.weekday === 0)!;
    const mon = result.find((h) => h.weekday === 1)!;
    expect(sun).not.toBe(mon);
    mon.open_min = 0;
    expect(sun.open_min).toBe(540);
  });
});

describe("hasHoursOverlap — client-side immediate feedback", () => {
  it("false for non-overlapping ranges on the same day", () => {
    expect(
      hasHoursOverlap([
        { weekday: 1, open_min: 540, close_min: 720 },
        { weekday: 1, open_min: 780, close_min: 1020 },
      ]),
    ).toBe(false);
  });

  it("false for identical ranges repeated on different days", () => {
    expect(
      hasHoursOverlap([
        { weekday: 1, open_min: 540, close_min: 720 },
        { weekday: 2, open_min: 540, close_min: 720 },
      ]),
    ).toBe(false);
  });

  it("true when one range starts before the previous one closes", () => {
    expect(
      hasHoursOverlap([
        { weekday: 1, open_min: 540, close_min: 720 },
        { weekday: 1, open_min: 700, close_min: 900 },
      ]),
    ).toBe(true);
  });

  it("true for two ranges sharing the same start time", () => {
    expect(
      hasHoursOverlap([
        { weekday: 4, open_min: 540, close_min: 600 },
        { weekday: 4, open_min: 540, close_min: 700 },
      ]),
    ).toBe(true);
  });

  it("back-to-back ranges (close == next open) do not overlap", () => {
    expect(
      hasHoursOverlap([
        { weekday: 3, open_min: 540, close_min: 720 },
        { weekday: 3, open_min: 720, close_min: 900 },
      ]),
    ).toBe(false);
  });

  it("empty input is not an overlap", () => {
    expect(hasHoursOverlap([])).toBe(false);
  });
});

describe("hasInvalidRange — a lone range with open at/after close", () => {
  it("false for a normal range", () => {
    expect(hasInvalidRange([{ weekday: 1, open_min: 540, close_min: 720 }])).toBe(false);
  });

  it("true when open equals close", () => {
    expect(hasInvalidRange([{ weekday: 1, open_min: 600, close_min: 600 }])).toBe(true);
  });

  it("true when open is after close", () => {
    expect(hasInvalidRange([{ weekday: 1, open_min: 1020, close_min: 540 }])).toBe(true);
  });

  it("empty input is not invalid", () => {
    expect(hasInvalidRange([])).toBe(false);
  });
});

describe("rankTagsByCount — tag suggestions ranked by org-wide usage", () => {
  it("orders by usage count, most-used first", () => {
    const venues: Venue[] = [
      venue({
        id: "v1",
        courts: [court({ id: "c1", tags: ["clay", "lit"] }), court({ id: "c2", tags: ["clay"] })],
      }),
      venue({ id: "v2", courts: [court({ id: "c3", tags: ["indoor", "clay"] })] }),
    ];
    expect(rankTagsByCount(venues)).toEqual(["clay", "indoor", "lit"]);
  });

  it("breaks ties alphabetically", () => {
    const venues: Venue[] = [venue({ courts: [court({ tags: ["zebra", "alpha"] })] })];
    expect(rankTagsByCount(venues)).toEqual(["alpha", "zebra"]);
  });

  it("no venues/courts yields no suggestions", () => {
    expect(rankTagsByCount([])).toEqual([]);
    expect(rankTagsByCount([venue()])).toEqual([]);
  });
});
