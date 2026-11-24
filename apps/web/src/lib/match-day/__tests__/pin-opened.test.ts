// P1 (Task 35 parked, folded into Task 37): while a court's QR sheet is open the focus must not move. The default focus is the first
// court of the list, and the list re-orders on every poll, so `pinOpened` stands the sheet's court in for "opened" — only while
// nothing is opened and the court is still listed. The rules are typed here from the brief; the list order is the page's own
// (`orderCourts`, by group: playing first), never re-derived.
import { describe, expect, it } from "vitest";
import type { MatchDayCourt } from "../types";
import { orderCourts, pinOpened, resolveDayFocus, type Opened } from "../view";

const court = (id: string, o: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
  court_id: id,
  court_name: `Court ${id}`,
  venue_id: "venue-1",
  venue_name: "Main Hall",
  sport_noun: "court",
  state: "free",
  current: null,
  in_use_by: null,
  free_since: null,
  queue: [],
  closure: null,
  stream_link: null,
  ...o,
});
const focusedId = (courts: MatchDayCourt[], opened: Opened | null): string | null => {
  const f = resolveDayFocus(orderCourts(courts), [], [], opened);
  return f.kind === "court" ? f.court.court_id : null;
};

describe("pinOpened", () => {
  const before = [court("1"), court("2")];
  // A poll later: court 2 started a match, so it sorts above court 1.
  const after = [court("1"), court("2", { state: "playing" })];

  it("PREMISE: the poll really does re-order the default focus (else the pin is tested against nothing)", () => {
    expect(focusedId(before, null)).toBe("1");
    expect(focusedId(after, null)).toBe("2");
  });

  it("the sequence: sheet open on court 1, the poll re-orders — the focus stays on court 1; the sheet closes — the normal ordering resumes", () => {
    expect(focusedId(before, pinOpened(null, "1", before)), "sheet open, before the poll").toBe("1");
    expect(focusedId(after, pinOpened(null, "1", after)), "sheet open, poll re-ordered").toBe("1");
    expect(focusedId(after, pinOpened(null, null, after)), "sheet closed: court 2 leads again").toBe("2");
  });

  it("nothing pinned: the answer is `opened`, untouched (null stays null — the empty case)", () => {
    expect(pinOpened(null, null, [])).toBeNull();
    expect(pinOpened(null, null, after)).toBeNull();
    const chosen: Opened = { kind: "court", id: "2", name: "Court 2" };
    expect(pinOpened(chosen, null, after)).toBe(chosen);
  });

  it("an organiser's own choice wins over a pin", () => {
    const chosen: Opened = { kind: "court", id: "2", name: "Court 2" };
    expect(pinOpened(chosen, "1", after)).toBe(chosen);
    const round: Opened = { kind: "round", id: "s:1", name: "Round 1" };
    expect(pinOpened(round, "1", after)).toBe(round);
  });

  it("a pin whose court left the list falls back to the default, never to a court that is gone", () => {
    expect(pinOpened(null, "9", after)).toBeNull();
    expect(pinOpened(null, "1", [])).toBeNull();
    expect(focusedId(after, pinOpened(null, "9", after))).toBe("2");
  });

  it("names the court it pins (the shell's 'left the list' notice needs the name)", () => {
    expect(pinOpened(null, "2", after)).toEqual({ kind: "court", id: "2", name: "Court 2" });
  });
});
