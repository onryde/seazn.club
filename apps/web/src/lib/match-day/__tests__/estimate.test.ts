// Match Day A2 — the pure read-time estimate and the candidate order (spec 2026-10-31-match-day-design.md §7, §7.1).
//
// The rules under test, from the spec, not from the code:
//  - §7.1: "On the day, queue order is the truth; times are estimates. Each court's queue is its matches in scheduled order.
//    Estimated start = max(planned time, estimated end of the match before it)." A match is never estimated earlier than its
//    planned time ("a pair is never pulled earlier than their slot unless the organiser calls them"). The first match's
//    "match before" is whatever holds the court now (`busyUntil`). A match runs its own length (a shared court mixes
//    divisions with different match lengths), else the queue's.
//  - §7 candidate order: 1. this court's own next match, if its players are free; 2. matches waiting in other courts' queues,
//    most-behind / longest-waiting first; 3. "no court yet"; and (task A2 brief) a blocked candidate goes last, in the same
//    order.
//
// Every expected time below is worked by hand from the rule, in minutes after 10:00Z.
import { describe, expect, it } from "vitest";
import { estimateQueue, rankCandidates } from "../estimate";
import type { MatchDayCandidate, MatchDayCandidateSource } from "../types";

const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const at = (m: number): Date => new Date(T0 + m * 60_000);
/** The estimate map as minutes after T0, in the map's own (insertion) order. */
const minutes = (m: Map<string, Date>): [string, number][] => [...m].map(([id, d]) => [id, (d.getTime() - T0) / 60_000]);

describe("estimateQueue", () => {
  it("an empty queue estimates nothing, whatever holds the court", () => {
    expect(estimateQueue([], at(0), 30).size).toBe(0);
    expect(estimateQueue([], at(500), 45).size).toBe(0);
  });

  it("never estimates a match earlier than its planned time: a court free from 10:00 leaves 10:30 and 11:30 where they are", () => {
    const est = estimateQueue(
      [
        { id: "a", planned_at: at(30) },
        { id: "b", planned_at: at(90) },
      ],
      at(0),
      30,
    );
    // max(30, 0) = 30; a ends 60; max(90, 60) = 90.
    expect(minutes(est)).toEqual([
      ["a", 30],
      ["b", 90],
    ]);
  });

  it("chains when running late: each match starts at the later of its plan and the end of the match before it", () => {
    // The court is held until 11:10 (+70). 30-minute matches planned +30, +60, +90, +180.
    const est = estimateQueue(
      [
        { id: "a", planned_at: at(30) },
        { id: "b", planned_at: at(60) },
        { id: "c", planned_at: at(90) },
        { id: "d", planned_at: at(180) },
      ],
      at(70),
      30,
    );
    // a: max(30, 70) = 70, ends 100; b: max(60, 100) = 100, ends 130; c: max(90, 130) = 130, ends 160;
    // d: max(180, 160) = 180 — the delay is absorbed by the gap before it.
    expect(minutes(est)).toEqual([
      ["a", 70],
      ["b", 100],
      ["c", 130],
      ["d", 180],
    ]);
  });

  it("each match runs its own length when it carries one (a 45-minute division in a 30-minute queue), else the queue's", () => {
    const est = estimateQueue(
      [
        { id: "long", planned_at: at(0), match_minutes: 45 },
        { id: "next", planned_at: at(30) },
        { id: "last", planned_at: at(60) },
      ],
      at(0),
      30,
    );
    // long: 0, ends 45; next: max(30, 45) = 45, ends 75 (the queue's 30); last: max(60, 75) = 75.
    expect(minutes(est)).toEqual([
      ["long", 0],
      ["next", 45],
      ["last", 75],
    ]);
  });

  it("queue order is planned order, whatever order the matches arrive in; a tie keeps the order given", () => {
    const est = estimateQueue(
      [
        { id: "late", planned_at: at(60) },
        { id: "tie1", planned_at: at(0) },
        { id: "tie2", planned_at: at(0) },
      ],
      at(0),
      30,
    );
    // tie1: 0, ends 30; tie2: max(0, 30) = 30, ends 60; late: max(60, 60) = 60.
    expect(minutes(est)).toEqual([
      ["tie1", 0],
      ["tie2", 30],
      ["late", 60],
    ]);
  });

  it("refuses what cannot be a queue: a repeated match, a length that is not a positive number, an instant that is not one", () => {
    const refusals: [string, () => unknown][] = [
      ["repeated id", () => estimateQueue([{ id: "a", planned_at: at(0) }, { id: "a", planned_at: at(30) }], at(0), 30)],
      ["zero minutes", () => estimateQueue([{ id: "a", planned_at: at(0) }], at(0), 0)],
      ["NaN minutes", () => estimateQueue([{ id: "a", planned_at: at(0) }], at(0), Number.NaN)],
      ["a match's own zero minutes", () => estimateQueue([{ id: "a", planned_at: at(0), match_minutes: 0 }], at(0), 30)],
      ["invalid planned time", () => estimateQueue([{ id: "a", planned_at: new Date(Number.NaN) }], at(0), 30)],
      ["invalid busyUntil", () => estimateQueue([{ id: "a", planned_at: at(0) }], new Date(Number.NaN), 30)],
    ];
    let checked = 0;
    for (const [name, run] of refusals) {
      expect(run, name).toThrow(/estimateQueue/);
      checked++;
    }
    expect(checked).toBe(6);
  });
});

const fixture = (id: string) => ({
  id,
  division_id: "d",
  division_name: "Doubles",
  sport_key: "badminton",
  stage_label: "League",
  home: "H",
  away: "A",
  headline: null,
  started_at: null,
  called_at: null,
  stream: null,
});
const cand = (
  id: string,
  source: MatchDayCandidateSource,
  o: { behind?: number; waiting?: number; blocked?: boolean } = {},
): MatchDayCandidate => ({
  fixture: fixture(id),
  source,
  from_court_name: source === "other_court" ? "Court 2" : null,
  waiting_minutes: o.waiting ?? 0,
  behind_minutes: o.behind ?? 0,
  blocked: o.blocked ? { kind: "player_busy", person_name: "Zara Khan", court_name: "Court 3" } : null,
});
const ids = (c: MatchDayCandidate[]) => c.map((x) => x.fixture.id);

describe("rankCandidates", () => {
  it("an empty list ranks to an empty list", () => {
    expect(rankCandidates([])).toEqual([]);
  });

  it("rule 1: this court's own next match comes first when its players are free, however far behind the others are", () => {
    const ranked = rankCandidates([
      cand("other", "other_court", { behind: 60, waiting: 60 }),
      cand("none", "no_court"),
      cand("mine", "this_court"),
    ]);
    expect(ids(ranked)).toEqual(["mine", "other", "none"]);
  });

  it("rule 2: other courts' matches, most behind first", () => {
    const ranked = rankCandidates([
      cand("b5", "other_court", { behind: 5, waiting: 40 }),
      cand("b25", "other_court", { behind: 25, waiting: 0 }),
      cand("b10", "other_court", { behind: 10, waiting: 10 }),
    ]);
    expect(ids(ranked)).toEqual(["b25", "b10", "b5"]);
  });

  it("rule 2: equally behind, the one that would wait longest where it is comes first", () => {
    const ranked = rankCandidates([
      cand("w5", "other_court", { behind: 10, waiting: 5 }),
      cand("w30", "other_court", { behind: 10, waiting: 30 }),
      cand("w15", "other_court", { behind: 10, waiting: 15 }),
    ]);
    expect(ids(ranked)).toEqual(["w30", "w15", "w5"]);
  });

  it("rule 3: a match with no court yet comes after every free match waiting on a court", () => {
    const ranked = rankCandidates([cand("none", "no_court"), cand("other", "other_court")]);
    expect(ids(ranked)).toEqual(["other", "none"]);
  });

  it("rule 4: a blocked candidate goes last, the blocked ones in the same order among themselves", () => {
    const ranked = rankCandidates([
      cand("none-x", "no_court", { blocked: true }),
      cand("other-b5-x", "other_court", { behind: 5, blocked: true }),
      cand("mine-x", "this_court", { blocked: true }),
      cand("none", "no_court"),
      cand("other-b30-x", "other_court", { behind: 30, blocked: true }),
    ]);
    expect(ids(ranked)).toEqual(["none", "mine-x", "other-b30-x", "other-b5-x", "none-x"]);
  });

  it("the right order differs from the order given, from source order alone, and from waiting-first: a full board", () => {
    const given = [
      cand("none", "no_court"),
      cand("b5w30", "other_court", { behind: 5, waiting: 30 }),
      cand("b25w0", "other_court", { behind: 25, waiting: 0 }),
      cand("mine-x", "this_court", { blocked: true }),
      cand("mine", "this_court"),
    ];
    const right = ["mine", "b25w0", "b5w30", "none", "mine-x"];
    // The wrong orders a plausible bug produces, each of which differs from the right one.
    const asGiven = ids(given);
    const waitingFirst = ["mine", "b5w30", "b25w0", "none", "mine-x"];
    const blockedIgnored = ["mine-x", "mine", "b25w0", "b5w30", "none"];
    for (const wrong of [asGiven, waitingFirst, blockedIgnored]) expect(wrong).not.toEqual(right);
    expect(ids(rankCandidates(given))).toEqual(right);
  });

  it("keeps this court's own matches, and the no-court ones, in the order given; never mutates the input", () => {
    const given = [cand("n2", "no_court"), cand("m2", "this_court"), cand("n1", "no_court"), cand("m1", "this_court")];
    const before = ids(given);
    expect(ids(rankCandidates(given))).toEqual(["m2", "m1", "n2", "n1"]);
    expect(ids(given)).toEqual(before);
  });
});
