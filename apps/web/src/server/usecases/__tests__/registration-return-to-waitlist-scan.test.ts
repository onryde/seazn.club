// B4 fix round 2 (controller ruling on the B4 fix round's open item 3): an entry goes back to the BACK of its division's waitlist two
// ways — the hourly sweep's lapse of an unpaid promotion (sweep.ts) and the organiser's "Move to waitlist" (organiser-actions.ts
// `waitlistRegistration`). B4 review m6 found the organiser's copy missing half the write (the promotion clear). Both now call ONE
// helper, `returnToWaitlist` (waitlist.ts), and this scan refuses a second hand-written copy of the move in the registrations module.
// The DB tests prove what the move writes: registration-waitlist-position.test.ts (the organiser's move) and registrations.test.ts
// (the lapse).
//
// Sport: not applicable — the waitlist is the division's, not the sport's.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("../registrations/", import.meta.url);
const MODULES = readdirSync(DIR).filter((n) => n.endsWith(".ts"));
const src = (name: string) => readFileSync(new URL(name, DIR), "utf8");
/** The move itself: an UPDATE that sets an entry's status to waitlisted (a read that filters on it says `r.status = 'waitlisted'`). */
const MOVE = /\bset\s+status\s*=\s*'waitlisted'/;

describe("one way back to the waitlist (B4 fix round 2)", () => {
  it("only waitlist.ts writes the move; every other registrations module leaves it to returnToWaitlist (counted)", () => {
    const writers = MODULES.filter((n) => MOVE.test(src(n)));
    expect(MODULES.length, "anti-vacuity: the module folder was read").toBeGreaterThan(20);
    expect(writers).toEqual(["waitlist.ts"]);
  });

  it("the sweep's lapse and the organiser's move both call returnToWaitlist", () => {
    const callers = ["sweep.ts", "organiser-actions.ts"];
    for (const name of callers) expect(src(name), name).toMatch(/\bawait returnToWaitlist\(tx, /);
    expect(callers.length).toBe(2);
  });
});
