import { describe, it, expect } from "vitest";
import { chipLabelKey, competitionChip } from "@/lib/public-site";

describe("chipLabelKey", () => {
  it("maps competition status to the public-namespace dict key", () => {
    expect(chipLabelKey("live")).toBe("chip.onNow");
    expect(chipLabelKey("completed")).toBe("chip.finished");
    expect(chipLabelKey("archived")).toBe("chip.finished");
    expect(chipLabelKey("draft")).toBe("chip.upcoming");
    expect(chipLabelKey("whatever")).toBe("chip.upcoming");
  });
});

// Spectator W2, Task 15 — the org home's chip read "UPCOMING" on a competition
// with a match being played (W0 block II, `_INDEX.md`). A competition's STATUS
// is an organiser's setting and nobody flips it to `live` when the first ball
// is bowled; whether a match is in play is a fact the fixtures carry. So the
// in-play count is the FIRST rung, ahead of every status.
describe("the chip with an in-play count", () => {
  // Every status the column admits (V207's check constraint), plus a value it
  // does not, because the ladder's default arm is a rung too.
  const STATUSES = ["draft", "published", "live", "completed", "archived", "whatever"] as const;

  it("EMPTY first: with nothing in play the ladder is exactly the one-argument ladder, for every status", () => {
    for (const status of STATUSES) {
      expect(competitionChip(status, 0), status).toBe(competitionChip(status));
      expect(chipLabelKey(status, 0), status).toBe(chipLabelKey(status));
    }
    // …and that one-argument ladder is still the shipped one, so the equality
    // above is not two copies of a changed answer agreeing with each other.
    expect(STATUSES.map((s) => competitionChip(s))).toEqual([
      "upcoming",
      "upcoming",
      "on-now",
      "finished",
      "finished",
      "upcoming",
    ]);
  });

  it("a match in play is ON NOW whatever the status says — including the statuses that would otherwise say upcoming or finished", () => {
    for (const status of STATUSES) {
      expect(competitionChip(status, 1), status).toBe("on-now");
      expect(chipLabelKey(status, 2), status).toBe("chip.onNow");
    }
  });

  it("ORDER-differential: the in-play rung beats a status that has its own answer (published → upcoming, completed → finished)", () => {
    // These two are the cases where the in-play rung placed AFTER the status
    // rungs would give a different chip, which is what makes it first.
    expect(competitionChip("published", 0)).toBe("upcoming");
    expect(competitionChip("published", 1)).toBe("on-now");
    expect(competitionChip("completed", 0)).toBe("finished");
    expect(competitionChip("completed", 3)).toBe("on-now");
  });
});
