import { describe, expect, it } from "vitest";
import { boardSlotOptionsFor } from "@/components/v2/stages-panel";

// Regression (quarter-hour-time-select design, "Why fixture-level fields
// differ"): the fixture "When" / add-match "When" fields used to be a bare
// `<input type="datetime-local" step={900}>`, so a 40/0 board's own grid
// (09:00, 09:40, 10:20 …) was never offered — nudging a match by hand could
// only land on a quarter hour, off the grid every other match on the board
// sits on. `boardSlotOptionsFor` is what now derives that grid from the
// division's fetched schedule settings, with the fallback rules the design
// doc pins ("no config, no matchMinutes, or fewer than 2 slots produced ->
// quarter hours" — expressed here as `undefined`, which is what tells
// `DateTimeField` to generate its own quarter-hour list).
//
// THE SECOND ARGUMENT IS THE GOVERNING CLOCK, and it is not the wire's `tz`.
// `GET /divisions/{id}/schedule-settings` serves only the resolved DISPLAY
// zone, which a division may override; `orgTz` is resolved server-side by the
// page and passed down. An earlier revision of this function anchored on
// `settings.tz` and was caught in review — the tz-override case below is what
// makes that a red rather than a comment.
const ORG_TZ = "UTC";

describe("boardSlotOptionsFor — stages-panel fixture/add-match board slots", () => {
  it("derives the 40/0 board's own grid from startAt/matchMinutes/gapMinutes", () => {
    const slots = boardSlotOptionsFor(
      {
        config: { startAt: "2026-08-16T09:00:00.000Z", matchMinutes: 40, gapMinutes: 0 },
        tz: ORG_TZ,
      },
      ORG_TZ,
    );
    expect(slots?.slice(0, 4)).toEqual(["09:00", "09:40", "10:20", "11:00"]);
    // Off the quarter-hour grid entirely — the whole reason this exists.
    expect(slots).not.toContain("09:45");
  });

  it("converts the anchor through the zone, not a literal substring of startAt", () => {
    // 09:00 UTC is 10:00 in Europe/London during BST (Aug 16 is DST) — if the
    // instant were read as a naive local string instead of zone-converted,
    // this would come back "09:00", not "10:00".
    const slots = boardSlotOptionsFor(
      {
        config: { startAt: "2026-08-16T09:00:00.000Z", matchMinutes: 30, gapMinutes: 0 },
        tz: "Europe/London",
      },
      "Europe/London",
    );
    expect(slots![0]).toBe("10:00");
  });

  // THE #448 REGRESSION. A division may carry a display-zone override, and the
  // wire serves that override as `tz`. Anchoring on it shifts the entire
  // offered grid by the offset difference, so every time the organiser picks
  // lands hours from where the rest of the board sits. Governing zone wins.
  it("anchors on orgTz, NOT on the wire's display tz, when the two disagree", () => {
    const settings = {
      config: { startAt: "2026-08-16T09:00:00.000Z", matchMinutes: 40, gapMinutes: 0 },
      // Display override: five hours behind the governing clock.
      tz: "America/New_York",
    };
    // Anchored on the display zone this would read "05:00"; on the governing
    // zone it is "09:00". Asserting both directions so a future edit that
    // silently swaps the argument back is red, not merely different.
    expect(boardSlotOptionsFor(settings, "UTC")![0]).toBe("09:00");
    expect(boardSlotOptionsFor(settings, "America/New_York")![0]).toBe("05:00");
  });

  // Play hours clip the grid — the same helper and the same answer the move
  // panel gives. Without this the walk runs to midnight and offers slots after
  // the division has stopped playing for the day.
  it("clips the grid to the division's play hours", () => {
    const slots = boardSlotOptionsFor(
      {
        config: {
          startAt: "2026-08-16T09:00:00.000Z",
          matchMinutes: 60,
          gapMinutes: 0,
          sessionWindows: [
            { from: "2026-08-16T09:00:00.000Z", to: "2026-08-16T12:00:00.000Z" },
          ],
        },
        tz: ORG_TZ,
      },
      ORG_TZ,
    );
    // 09:00, 10:00, 11:00 all finish by 12:00; 12:00 itself would end at 13:00,
    // past the window, so it is not offered.
    expect(slots).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("falls back to undefined (quarter hours) when there is no settings row yet", () => {
    expect(boardSlotOptionsFor(null, ORG_TZ)).toBeUndefined();
  });

  it("falls back to undefined when the config has no startAt (division never scheduled)", () => {
    const slots = boardSlotOptionsFor(
      { config: { matchMinutes: 40, gapMinutes: 0, startAt: null }, tz: ORG_TZ },
      ORG_TZ,
    );
    expect(slots).toBeUndefined();
  });

  it("falls back to undefined when matchMinutes is absent", () => {
    const slots = boardSlotOptionsFor(
      { config: { startAt: "2026-08-16T09:00:00.000Z" }, tz: ORG_TZ },
      ORG_TZ,
    );
    expect(slots).toBeUndefined();
  });

  it("falls back to undefined rather than a single-entry list (never an unusable picker)", () => {
    // 22:30 + 90 minutes lands exactly on midnight — one slot ("22:30") fits
    // before the day boundary and no second one does.
    const slots = boardSlotOptionsFor(
      {
        config: { startAt: "2026-08-16T22:30:00.000Z", matchMinutes: 90, gapMinutes: 0 },
        tz: ORG_TZ,
      },
      ORG_TZ,
    );
    expect(slots).toBeUndefined();
  });

  it("falls back to undefined instead of throwing on a malformed startAt", () => {
    const slots = boardSlotOptionsFor(
      { config: { startAt: "not-a-date", matchMinutes: 40, gapMinutes: 0 }, tz: ORG_TZ },
      ORG_TZ,
    );
    expect(slots).toBeUndefined();
  });

  it("treats a missing gapMinutes as 0, not NaN", () => {
    const slots = boardSlotOptionsFor(
      { config: { startAt: "2026-08-16T09:00:00.000Z", matchMinutes: 45 }, tz: ORG_TZ },
      ORG_TZ,
    );
    expect(slots?.slice(0, 4)).toEqual(["09:00", "09:45", "10:30", "11:15"]);
  });
});
