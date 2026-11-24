// "Is this competition over, so a new division is refused?" - ONE predicate, shared by the write (`assertCompetitionNotEnded`,
// usecases/divisions.ts -> 409 COMPETITION_ENDED) and by every surface that would otherwise offer a button the write refuses
// (the competition page's "Add division", the /d/new wizard). Expected values are the statuses the competitions table's own
// CHECK constraint declares (V207), not a list read back from the predicate.
import { describe, expect, it } from "vitest";
import { competitionIsEnded, passLockReason } from "@/lib/entitlements";

// V207__competitions.sql: check (status in ('draft','published','live','completed','archived'))
const DECLARED = ["draft", "published", "live", "completed", "archived"] as const;
const TERMINAL = ["completed", "archived"];

describe("competitionIsEnded", () => {
  it("is true for exactly the terminal statuses of the declared set", () => {
    const ended = DECLARED.filter((s) => competitionIsEnded(s));
    // Anti-vacuity: both sides of the split are non-empty and every declared status was judged.
    expect(DECLARED.length).toBe(5);
    expect(ended).toEqual(TERMINAL);
    expect(DECLARED.filter((s) => !competitionIsEnded(s)).length).toBe(3);
  });

  it("agrees with the pass lock's terminal arm for every declared status (one authority, not a copy)", () => {
    for (const s of DECLARED) expect(competitionIsEnded(s), s).toBe(passLockReason(s, null) === "terminal");
  });

  it("is a STATUS question only: a live competition long past its end date is not ended (the write must keep working)", () => {
    // passLockReason(live, '2020-01-01') is "past_ends_on" - a pass lapse, never a write refusal. The predicate takes no date.
    expect(passLockReason("live", "2020-01-01")).toBe("past_ends_on");
    expect(competitionIsEnded("live")).toBe(false);
  });

  it("an unknown status is not ended (fail open: never hide the button over an unreadable value)", () => {
    expect(competitionIsEnded("")).toBe(false);
    expect(competitionIsEnded("Completed")).toBe(false);
  });
});
