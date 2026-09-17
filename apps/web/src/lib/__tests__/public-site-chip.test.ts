import { describe, it, expect } from "vitest";
import { chipLabelKey, chipShowsCount, competitionChip, orgHomeTier, sortOrgHomeCompetitions } from "@/lib/public-site";

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

// Owner ruling 2026-09-17 — the org home lists competitions in THREE tiers, each
// read off the chip a spectator sees on the card:
//   0. a match in play — the chip COUNTS them ("2 live now");
//   1. marked `live` with nothing in play — the chip says "On now";
//   2. everything else ("Upcoming", "Finished").
// Within a tier the incoming (date) order stands. The server sorts with this
// and so does the island, so neither can put a card above one whose chip is
// livelier.
describe("orgHomeTier — the org home's order, read off the chip", () => {
  const STATUSES = ["draft", "published", "live", "completed", "archived", "whatever"] as const;

  it("EMPTY first: with nothing in play only `live` is tier 1 (\"On now\"), every other status is tier 2", () => {
    expect(STATUSES.map((s) => orgHomeTier(s, 0))).toEqual([2, 2, 1, 2, 2, 2]);
    // The one-argument call is the zero-count call.
    for (const status of STATUSES) expect(orgHomeTier(status), status).toBe(orgHomeTier(status, 0));
  });

  it("a match in play is tier 0 whatever the status — `live` included, which would otherwise be tier 1", () => {
    for (const status of STATUSES) {
      expect(orgHomeTier(status, 1), status).toBe(0);
      expect(orgHomeTier(status, 3), status).toBe(0);
    }
  });

  it("the tier agrees with what the chip shows (a count → 0, 'On now' with no count → 1, else 2) — chip, count and tier pinned as a LITERAL table over every status × in-play count", () => {
    // Typed out, not derived from the functions under test: a change to any
    // one of the three that the others do not follow reds here.
    type Row = [status: string, inPlay: number, chip: string, counts: boolean, tier: number];
    const TABLE: Row[] = [
      ["draft", 0, "upcoming", false, 2],
      ["published", 0, "upcoming", false, 2],
      ["live", 0, "on-now", false, 1],
      ["completed", 0, "finished", false, 2],
      ["archived", 0, "finished", false, 2],
      ["whatever", 0, "upcoming", false, 2],
      ...STATUSES.flatMap((status) => [1, 2].map((inPlay): Row => [status, inPlay, "on-now", true, 0])),
    ];
    expect(TABLE).toHaveLength(STATUSES.length * 3);
    for (const [status, inPlay, chip, counts, tier] of TABLE) {
      expect(
        [competitionChip(status, inPlay), chipShowsCount(inPlay), orgHomeTier(status, inPlay)],
        `${status}/${inPlay}`,
      ).toEqual([chip, counts, tier]);
    }
  });
});

describe("sortOrgHomeCompetitions — three tiers over the date order", () => {
  const r = (id: string, status: string, in_play: number) => ({ id, status, in_play });
  const ids = (rows: { id: string }[]) => rows.map((x) => x.id);

  it("EMPTY first: no rows, no rows; one tier only, the incoming order untouched", () => {
    expect(sortOrgHomeCompetitions([])).toEqual([]);
    const calm = [r("oct", "published", 0), r("sept", "draft", 0), r("done", "completed", 0)];
    expect(ids(sortOrgHomeCompetitions(calm))).toEqual(["oct", "sept", "done"]);
  });

  it("ORDER-differential at each tier boundary: an older 'On now' above a newer idle one, an older in-play one above a newer 'On now'", () => {
    // Incoming = date order, newest first.
    const byDate = [
      r("newIdle", "published", 0),
      r("onNow", "live", 0),
      r("oldLive", "published", 1),
      r("olderLive", "draft", 2),
      r("finished", "completed", 0),
    ];
    expect(ids(sortOrgHomeCompetitions(byDate))).toEqual(["oldLive", "olderLive", "onNow", "newIdle", "finished"]);
  });

  it("keeps the incoming order within a tier — by date, never by how many matches are in play", () => {
    const byDate = [r("a", "live", 0), r("b", "published", 1), r("c", "live", 0), r("d", "published", 4)];
    expect(ids(sortOrgHomeCompetitions(byDate))).toEqual(["b", "d", "a", "c"]);
  });

  it("returns a new array and leaves the caller's untouched", () => {
    const byDate = [r("idle", "published", 0), r("live", "published", 1)];
    const out = sortOrgHomeCompetitions(byDate);
    expect(ids(byDate)).toEqual(["idle", "live"]);
    expect(out).not.toBe(byDate);
    expect(out[0]).toBe(byDate[1]);
  });
});
