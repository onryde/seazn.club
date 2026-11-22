// B5 (T7 M1 leftover): the page learns a freeze from a press answered 402 (MD-R30) and keeps it (`freezeSeen`). Reload was the only way back; now a
// LATER poll that says the competition is not frozen takes it back. The rule is pure, so the cells are typed here from the sentence it answers:
// "a poll asked after the 402 and answering `frozen: false` lifts it; nothing else does".
//   - no 402 seen: there is nothing to lift (stays null, whatever the poll says);
//   - a poll that still says frozen (true) keeps it;
//   - an older server's poll (no `frozen` at all) is no evidence either way: keeps it;
//   - a poll whose freeze read FAILED (`frozen: null`, fix round 1 I1) is no evidence either way: keeps it, even when it was asked after the 402;
//   - a poll ASKED BEFORE the 402 landed and answered after it describes the competition as it was: keeps it (the in-flight race);
//   - a poll asked after the 402 and answering false lifts it.
import { describe, expect, it } from "vitest";
import { freezeSeenAfterPoll } from "../view";

const SEEN = 1_000;

describe("freezeSeenAfterPoll: only a poll asked after the 402 that says 'not frozen' lifts what the 402 taught", () => {
  const cells: { name: string; seen: number | null; frozen: boolean | null | undefined; startedAt: number; expected: number | null }[] = [
    { name: "nothing seen, a poll says not frozen: nothing to lift", seen: null, frozen: false, startedAt: SEEN + 5, expected: null },
    { name: "nothing seen, a poll says frozen: the page learns nothing here (a 402 is what it learns from)", seen: null, frozen: true, startedAt: SEEN + 5, expected: null },
    { name: "seen, a later poll still says frozen: kept", seen: SEEN, frozen: true, startedAt: SEEN + 5, expected: SEEN },
    { name: "seen, a later poll from an older server (no flag): kept", seen: SEEN, frozen: undefined, startedAt: SEEN + 5, expected: SEEN },
    { name: "seen, a later poll whose freeze read failed (null): kept (an unread freeze is not a thaw)", seen: SEEN, frozen: null, startedAt: SEEN + 5, expected: SEEN },
    { name: "seen, a poll asked BEFORE the 402 says not frozen: kept (it describes the competition as it was)", seen: SEEN, frozen: false, startedAt: SEEN - 5, expected: SEEN },
    { name: "seen, a poll asked in the SAME millisecond: kept (cannot be told apart; the next press says 402 again, the next poll lifts it)", seen: SEEN, frozen: false, startedAt: SEEN, expected: SEEN },
    { name: "seen, a poll asked after it says not frozen: lifted", seen: SEEN, frozen: false, startedAt: SEEN + 1, expected: null },
  ];
  it("every cell", () => {
    let checked = 0;
    let lifted = 0;
    for (const c of cells) {
      const out = freezeSeenAfterPoll(c.seen, c.frozen, c.startedAt);
      expect(out, c.name).toBe(c.expected);
      if (c.seen !== null && out === null) lifted += 1;
      checked += 1;
    }
    expect(checked, "anti-vacuity: every cell ran").toBe(cells.length);
    expect(lifted, "and exactly one cell lifts (a rule that lifts everywhere would pass the other seven by luck of their inputs)").toBe(1);
  });
});
